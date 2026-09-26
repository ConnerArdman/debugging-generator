/**
 * The failure paths of the integration harness's own teardown (AAP §0.8.3).
 *
 * Every integration suite boots through `startHarness` and relies on its
 * teardown leaving no listener, socket, handle or directory behind — the
 * project runs one file at a time in a forked worker, so anything that
 * survives stalls or poisons the files after it. The paths exercised here are
 * the ones a green run never takes:
 *
 * - `releaseHarnessResources` with a close that rejects (or throws), a socket
 *   left open, and a directory that must be refused — every other step still
 *   runs, and every failure is one line of the result — and with a service
 *   close that rejects or is still pending while a real listener stays bound:
 *   the directories are retained (never removed under a service that may
 *   still use them) and, for a pending close, removed only once it resolves;
 * - `settleLateStart` with a `startService` that resolves, refuses or rejects
 *   after its boot timeout, or whose handle fails to close — only a refusal or
 *   a close that resolved counts as a confirmed shutdown, the handle is closed
 *   before any directory is removed, and no rejection goes unhandled;
 * - `releaseAfterLateStart` for a start that has not settled within its grace
 *   (or whose close overruns) — the directories are retained until its
 *   shutdown is confirmed and removed after, or kept for good when it ends
 *   without one;
 * - one real `startHarness` round trip whose client close is forced to reject,
 *   and one start refused at configuration.
 *
 * Failures are injected through the functions' parameters — fakes for the
 * clients, sockets and service — never by patching a module.
 */

import { realpathSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { connect as connectTcp, createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';

import { DebuggenError, err, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import {
  HARNESS_TIMEOUTS,
  releaseAfterLateStart,
  releaseHarnessResources,
  settleLateStart,
  startHarness,
} from './harness.js';
import type {
  LateStartOptions,
  ReleasableRawSocket,
  ReleasableService,
  ReleasableWsClient,
} from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Fakes and helpers
 * ---------------------------------------------------------------------------------------------- */

/** The prefix of the directories this suite creates, distinct from the harness's own. */
const SCRATCH_PREFIX = 'debuggen-it-harness-test-';

/** Short bounds for the fakes: they settle in microtasks unless a test holds them back. */
const FAST: LateStartOptions = Object.freeze({ graceMs: 200, closeTimeoutMs: 200 });

/** Long enough for a held-back fake to be observed as still pending, short enough to stay fast. */
const OBSERVE_PENDING_MS = 50;

/** Every directory this suite created; removed after each test whatever it asserted. */
const created: string[] = [];

/** Every listener this suite bound; closed after each test whatever it asserted. */
const listeners: Server[] = [];

afterEach(async () => {
  const leftovers = created.splice(0);
  const bound = listeners.splice(0);
  await Promise.all(bound.map((server) => closeServer(server)));
  await Promise.all(leftovers.map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Closes `server` if it is still listening; resolves either way. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => {
      resolveClose();
    });
  });
}

/**
 * A real TCP listener on an ephemeral loopback port — the stand-in for the
 * listener a service whose shutdown is unconfirmed may still hold.
 */
interface LiveListener {
  readonly host: string;
  readonly port: number;
  /** Stops listening; what a close that really shut the service down does. */
  close(): Promise<void>;
}

async function liveListener(): Promise<LiveListener> {
  const server = createServer((socket) => {
    socket.destroy();
  });
  listeners.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test listener reported no TCP address.');
  }
  return { host: address.address, port: address.port, close: () => closeServer(server) };
}

/** A fresh directory inside the temporary root — the only place teardown removes from. */
async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), SCRATCH_PREFIX));
  created.push(directory);
  return directory;
}

/** Whether something exists at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

/** A promise settled from outside: the stand-in for a `startService` or a `close()` still running. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolveDeferred: (value: T) => void = () => undefined;
  let rejectDeferred: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveDeferred = resolvePromise;
    rejectDeferred = rejectPromise;
  });
  return {
    promise,
    resolve: (value) => {
      resolveDeferred(value);
    },
    reject: (reason) => {
      rejectDeferred(reason);
    },
  };
}

/** A fake service handle recording each close and what existed at that moment. */
interface FakeService extends ReleasableService {
  /** How many times `close()` was called. */
  readonly closeCalls: number;
  /** For each call, whether every watched directory still existed when it began. */
  readonly watchedExistedAtClose: readonly boolean[];
}

/**
 * Builds a {@link FakeService}. `settle` is what each close does after it has
 * recorded itself — resolve by default; a rejection or a held-back promise
 * injects the failure under test.
 */
function fakeService(
  options: {
    readonly watch?: readonly string[];
    readonly settle?: () => Promise<void>;
    readonly log?: string[];
  } = {},
): FakeService {
  let closeCalls = 0;
  const watchedExistedAtClose: boolean[] = [];
  return {
    get closeCalls(): number {
      return closeCalls;
    },
    watchedExistedAtClose,
    close: async () => {
      closeCalls += 1;
      options.log?.push('service');
      const present = await Promise.all((options.watch ?? []).map((path) => exists(path)));
      watchedExistedAtClose.push(present.every(Boolean));
      await (options.settle?.() ?? Promise.resolve());
    },
  };
}

/** A fake protocol client whose close logs itself and then does `settle`. */
function fakeClient(
  identity: ReleasableWsClient['identity'],
  log: string[],
  settle: () => Promise<void>,
  readyState: number = NodeWebSocket.CLOSED,
): ReleasableWsClient {
  return {
    identity,
    sockets: [{ readyState }],
    close: () => {
      log.push(`client:${identity.client}`);
      return settle();
    },
  };
}

/** A fake bare socket whose close logs itself and then does `settle`. */
function fakeRawSocket(
  log: string[],
  settle: () => Promise<void>,
  readyState: number = NodeWebSocket.CLOSED,
): ReleasableRawSocket {
  return {
    socket: { readyState },
    close: () => {
      log.push('raw');
      return settle();
    },
  };
}

/** A late start's result: the fake handle it produced. */
function started(service: ReleasableService): Result<ReleasableService, DebuggenError> {
  return ok(service);
}

/**
 * Runs `scenario` with a process-level `unhandledRejection` listener installed,
 * then lets two macrotask turns pass — Node reports an unhandled rejection only
 * once the microtask queue has drained — and returns every reason it saw.
 */
async function unhandledRejectionsDuring(scenario: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    await scenario();
    await new Promise<void>((resolveImmediate) => {
      setImmediate(resolveImmediate);
    });
    await delay(20);
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

/** Whether a TCP connection to `host:port` is refused — the listener's absence. */
function connectionRefused(host: string, port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connectTcp({ host, port });
    const finish = (refused: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(refused);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, HARNESS_TIMEOUTS.socketClose);
    socket.once('connect', () => {
      finish(false);
    });
    socket.once('error', () => {
      finish(true);
    });
  });
}

/* -------------------------------------------------------------------------------------------------
 * releaseHarnessResources
 * ---------------------------------------------------------------------------------------------- */

describe('releaseHarnessResources', () => {
  it('keeps releasing after a client close rejects and a raw close throws, naming each, then closes the service and removes every directory', async () => {
    const home = await scratchDirectory();
    const project = await scratchDirectory();
    const log: string[] = [];
    const editor = fakeClient({ client: 'vscode' }, log, () =>
      Promise.reject(new Error('injected client close failure')),
    );
    const devtools = fakeClient({ client: 'devtools', tabId: 7 }, log, () => Promise.resolve());
    const raw = fakeRawSocket(log, () => {
      throw new Error('injected raw close failure');
    });
    const service = fakeService({ watch: [home, project], log });

    const release = await releaseHarnessResources({
      clients: [editor, devtools],
      rawSockets: [raw],
      handle: service,
      directories: [project, home],
    });

    expect(release.problems).toEqual([
      'closing WebSocket client #1 (vscode) failed: injected client close failure',
      'closing raw socket #1 failed: injected raw close failure',
    ]);
    // The service's close resolved, so its shutdown is confirmed: nothing retained or deferred.
    expect(release.retained).toEqual([]);
    expect(release.deferred).toBeUndefined();
    // Every close was attempted, sockets before the service.
    expect(log).toEqual(['client:vscode', 'client:devtools', 'raw', 'service']);
    // The service was closed exactly once, while the directories still existed…
    expect(service.closeCalls).toBe(1);
    expect(service.watchedExistedAtClose).toEqual([true]);
    // …and both were removed after it.
    expect(await exists(project)).toBe(false);
    expect(await exists(home)).toBe(false);
  });

  it('reports a socket a close left open and a refused directory, and still removes the rest', async () => {
    const home = await scratchDirectory();
    const outsideTemporaryRoot = resolve(sep, 'debuggen-harness-test-outside-the-temporary-root');
    const log: string[] = [];
    const devtools = fakeClient(
      { client: 'devtools', tabId: 7 },
      log,
      () => Promise.resolve(),
      NodeWebSocket.OPEN,
    );
    const raw = fakeRawSocket(log, () => Promise.resolve(), NodeWebSocket.CLOSING);
    const service = fakeService({ log });

    const release = await releaseHarnessResources({
      clients: [devtools],
      rawSockets: [raw],
      handle: service,
      directories: [outsideTemporaryRoot, home],
    });

    expect(release.problems).toHaveLength(3);
    expect(release.problems[0]).toBe(
      `WebSocket client #1 (devtools, tab 7) still has a socket in readyState ${String(NodeWebSocket.OPEN)}`,
    );
    expect(release.problems[1]).toBe(
      `raw socket #1 is still in readyState ${String(NodeWebSocket.CLOSING)}`,
    );
    expect(release.problems[2]).toMatch(
      /^refused to remove \/debuggen-harness-test-outside-the-temporary-root: /u,
    );
    expect(release.retained).toEqual([]);
    expect(log).toEqual(['client:devtools', 'raw', 'service']);
    expect(await exists(home)).toBe(false);
  });

  it('retains every directory, and reports it, when the service close rejects while its listener is still bound', async () => {
    const home = await scratchDirectory();
    const project = await scratchDirectory();
    const listener = await liveListener();
    // A close that fails without shutting anything down: the listener stays bound.
    const service = fakeService({
      settle: () => Promise.reject(new Error('injected service close failure')),
    });

    const release = await releaseHarnessResources({
      clients: [],
      rawSockets: [],
      handle: service,
      directories: [project, home],
    });

    expect(release.problems).toEqual([
      'ServiceHandle.close() rejected: injected service close failure',
      `retained ${project}: the service close rejected, so its shutdown is unconfirmed; remove it by hand once the process has exited`,
      `retained ${home}: the service close rejected, so its shutdown is unconfirmed; remove it by hand once the process has exited`,
    ]);
    expect(release.retained).toEqual([project, home]);
    // Nothing will remove them later: an unconfirmed shutdown never becomes a confirmed one.
    expect(release.deferred).toBeUndefined();
    expect(service.closeCalls).toBe(1);
    // The sandbox is still there for the service that may still be using it.
    expect(await connectionRefused(listener.host, listener.port)).toBe(false);
    expect(await exists(project)).toBe(true);
    expect(await exists(home)).toBe(true);
  });

  it('retains the directories while the service close is pending with its listener bound, and removes them only once that close resolves', async () => {
    const home = await scratchDirectory();
    const listener = await liveListener();
    const closing = deferred<undefined>();
    const service = fakeService({ settle: () => closing.promise });

    const release = await releaseHarnessResources({
      clients: [],
      rawSockets: [],
      handle: service,
      directories: [home],
      handleCloseTimeoutMs: OBSERVE_PENDING_MS,
    });

    expect(release.problems).toEqual([
      `ServiceHandle.close() did not resolve within ${String(OBSERVE_PENDING_MS)} ms`,
      `retained ${home}: the service close is still pending; it is removed once that close resolves`,
    ]);
    expect(release.retained).toEqual([home]);
    expect(service.closeCalls).toBe(1);
    expect(release.deferred).toBeDefined();

    // Still shutting down: the listener is bound and the sandbox is untouched.
    await delay(OBSERVE_PENDING_MS);
    expect(await connectionRefused(listener.host, listener.port)).toBe(false);
    expect(await exists(home)).toBe(true);

    // The close really shuts the listener down, and only then resolves.
    await listener.close();
    expect(await exists(home)).toBe(true);
    closing.resolve(undefined);

    expect(await release.deferred).toEqual({ clean: true, problems: [] });
    expect(await connectionRefused(listener.host, listener.port)).toBe(true);
    expect(await exists(home)).toBe(false);
  });

  it('keeps the directories for good when a close that overran its bound finally rejects', async () => {
    const home = await scratchDirectory();
    const listener = await liveListener();
    const closing = deferred<undefined>();
    const service = fakeService({ settle: () => closing.promise });

    const unhandled = await unhandledRejectionsDuring(async () => {
      const release = await releaseHarnessResources({
        clients: [],
        rawSockets: [],
        handle: service,
        directories: [home],
        handleCloseTimeoutMs: OBSERVE_PENDING_MS,
      });
      closing.reject(new Error('injected late close failure'));

      expect(await release.deferred).toEqual({
        clean: false,
        problems: [
          'ServiceHandle.close() rejected after its bound: injected late close failure',
          `retained ${home}: the service close rejected, so its shutdown is unconfirmed; remove it by hand once the process has exited`,
        ],
      });
    });

    expect(unhandled).toEqual([]);
    expect(await connectionRefused(listener.host, listener.port)).toBe(false);
    expect(await exists(home)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * settleLateStart and releaseAfterLateStart
 * ---------------------------------------------------------------------------------------------- */

describe('settleLateStart', () => {
  it('closes a start that resolves after its boot timeout before the directories are removed', async () => {
    const home = await scratchDirectory();
    const service = fakeService({ watch: [home] });
    const starting = deferred<Result<ReleasableService, DebuggenError>>();
    setTimeout(() => {
      starting.resolve(started(service));
    }, 10);

    const late = await settleLateStart(starting.promise, FAST);

    expect(late).toMatchObject({ stopped: true, problems: [] });
    expect(service.closeCalls).toBe(1);
    expect(service.watchedExistedAtClose).toEqual([true]);
    // Settling removes nothing: the caller releases the sandbox only after it.
    expect(await exists(home)).toBe(true);
    expect(await late.finished).toEqual({ stopped: true, problems: [] });
  });

  it('records a start that rejects after its boot timeout as unconfirmed, retains its directories, and leaves no unhandled rejection', async () => {
    const home = await scratchDirectory();
    const starting = deferred<Result<ReleasableService, DebuggenError>>();
    let late: Awaited<ReturnType<typeof settleLateStart>> | undefined;

    const unhandled = await unhandledRejectionsDuring(async () => {
      setTimeout(() => {
        starting.reject(new Error('injected late start failure'));
      }, 10);
      late = await settleLateStart(starting.promise, FAST);
    });

    expect(unhandled).toEqual([]);
    // `startService` returns `Err` after releasing what it acquired; a rejection
    // breaks that contract, so nothing proves the service is gone.
    expect(late?.stopped).toBe(false);
    expect(late?.problems).toEqual([
      'startService rejected after its boot timeout: injected late start failure',
    ]);
    if (late === undefined) {
      throw new Error('settleLateStart did not resolve');
    }
    expect(await releaseAfterLateStart(late, [home])).toEqual({
      clean: false,
      problems: [
        'startService rejected after its boot timeout: injected late start failure',
        `retained ${home}: the late service start ended without a confirmed shutdown; remove it by hand once the process has exited`,
      ],
    });
    expect(await exists(home)).toBe(true);
  });

  it('confirms a late refusal as stopped, but not a late handle whose close rejects while its listener is still bound', async () => {
    const refusal = new DebuggenError('CONFIG_INVALID', 'injected late refusal');
    const refused = await settleLateStart(Promise.resolve(err(refusal)), FAST);
    expect(refused).toMatchObject({
      stopped: true,
      problems: [
        'startService refused to start after its boot timeout (CONFIG_INVALID): injected late refusal',
      ],
    });

    const home = await scratchDirectory();
    const listener = await liveListener();
    const service = fakeService({
      settle: () => Promise.reject(new Error('injected late close failure')),
    });
    const unhandled = await unhandledRejectionsDuring(async () => {
      const closedBadly = await settleLateStart(Promise.resolve(started(service)), FAST);
      expect(closedBadly).toMatchObject({
        stopped: false,
        problems: [
          'the service that started after its boot timeout did not close: injected late close failure',
        ],
      });
      expect(await releaseAfterLateStart(closedBadly, [home])).toEqual({
        clean: false,
        problems: [
          'the service that started after its boot timeout did not close: injected late close failure',
          `retained ${home}: the late service start ended without a confirmed shutdown; remove it by hand once the process has exited`,
        ],
      });
    });
    expect(unhandled).toEqual([]);
    expect(service.closeCalls).toBe(1);
    // The listener the failed close left behind still has its sandbox.
    expect(await connectionRefused(listener.host, listener.port)).toBe(false);
    expect(await exists(home)).toBe(true);
  });

  it('retains the directories of a start that has not settled within its grace; the continuation closes it, then removes them', async () => {
    const home = await scratchDirectory();
    const project = await scratchDirectory();
    const service = fakeService({ watch: [home, project] });
    const starting = deferred<Result<ReleasableService, DebuggenError>>();

    const late = await settleLateStart(starting.promise, {
      graceMs: OBSERVE_PENDING_MS,
      closeTimeoutMs: FAST.closeTimeoutMs,
    });
    expect(late).toMatchObject({
      stopped: false,
      problems: [
        `startService had still not settled ${String(OBSERVE_PENDING_MS)} ms after its boot timeout`,
      ],
    });

    const release = releaseAfterLateStart(late, [project, home]);
    await delay(OBSERVE_PENDING_MS);
    // Still running: nothing is closed, nothing is removed.
    expect(service.closeCalls).toBe(0);
    expect(await exists(home)).toBe(true);
    expect(await exists(project)).toBe(true);

    starting.resolve(started(service));
    const report = await release;

    expect(report).toEqual({ clean: true, problems: [] });
    expect(service.closeCalls).toBe(1);
    expect(service.watchedExistedAtClose).toEqual([true]);
    expect(await exists(home)).toBe(false);
    expect(await exists(project)).toBe(false);
  });

  it('retains the directories while a late handle overruns its close bound, and removes them once it has closed', async () => {
    const home = await scratchDirectory();
    const closing = deferred<undefined>();
    const service = fakeService({ watch: [home], settle: () => closing.promise });

    const late = await settleLateStart(Promise.resolve(started(service)), {
      graceMs: FAST.graceMs,
      closeTimeoutMs: OBSERVE_PENDING_MS,
    });
    expect(late).toMatchObject({
      stopped: false,
      problems: [
        `the service that started after its boot timeout did not close within ${String(OBSERVE_PENDING_MS)} ms`,
      ],
    });
    expect(service.closeCalls).toBe(1);

    const release = releaseAfterLateStart(late, [home]);
    await delay(OBSERVE_PENDING_MS);
    expect(await exists(home)).toBe(true);

    closing.resolve(undefined);
    expect(await release).toEqual({ clean: true, problems: [] });
    expect(await exists(home)).toBe(false);
  });

  it('handles a start that rejects after its grace: the continuation reports it and keeps the directories, its shutdown unconfirmed', async () => {
    const home = await scratchDirectory();
    const starting = deferred<Result<ReleasableService, DebuggenError>>();
    let report: Awaited<ReturnType<typeof releaseAfterLateStart>> | undefined;

    const unhandled = await unhandledRejectionsDuring(async () => {
      const late = await settleLateStart(starting.promise, {
        graceMs: OBSERVE_PENDING_MS,
        closeTimeoutMs: FAST.closeTimeoutMs,
      });
      expect(late.stopped).toBe(false);
      const release = releaseAfterLateStart(late, [home]);
      starting.reject(new Error('injected very late start failure'));
      report = await release;
    });

    expect(unhandled).toEqual([]);
    expect(report).toEqual({
      clean: false,
      problems: [
        'startService rejected after its boot timeout: injected very late start failure',
        `retained ${home}: the late service start ended without a confirmed shutdown; remove it by hand once the process has exited`,
      ],
    });
    expect(await exists(home)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * startHarness, for real
 * ---------------------------------------------------------------------------------------------- */

describe('startHarness', () => {
  it('reports a client whose close rejects, and still closes the service and removes its directories', async () => {
    const harness = await startHarness();
    try {
      const project = harness.requireProject();
      const editor = await harness.editor(project.root);
      // The real close still runs first, so the client cannot keep reconnecting
      // behind the suite; only its outcome is replaced by a failure.
      const closeForReal = editor.close.bind(editor);
      editor.close = async () => {
        await closeForReal();
        throw new Error('injected client close failure');
      };

      const report = await harness.stop();

      expect(report).toEqual({
        clean: false,
        problems: ['closing WebSocket client #1 (vscode) failed: injected client close failure'],
      });
      expect(await connectionRefused(harness.service.host, harness.service.port)).toBe(true);
      expect(await exists(harness.home)).toBe(false);
      expect(await exists(project.container)).toBe(false);
      // Idempotent: the same report, without a second teardown.
      expect(await harness.stop()).toBe(report);
    } finally {
      await harness.stop();
    }
  });

  it('rethrows a refused configuration unchanged when releasing the partial start is clean', async () => {
    const outcome: unknown = await startHarness({
      fixtureProject: false,
      env: { DEBUGGEN_PORT: 'not-a-port' },
    }).then(
      async (unexpected) => {
        await unexpected.stop();
        return undefined;
      },
      (cause: unknown) => cause,
    );

    expect(outcome).toBeInstanceOf(Error);
    const message = outcome instanceof Error ? outcome.message : '';
    expect(message).toMatch(/^The harness configuration was refused \(CONFIG_INVALID\): /u);
    expect(message).not.toContain('Releasing what the failed start had acquired reported');
  });
});
