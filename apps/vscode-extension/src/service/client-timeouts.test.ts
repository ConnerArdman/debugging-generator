/**
 * Tests for `./client.ts`: the deadline every HTTP call of the editor's
 * service client is given.
 *
 * The editor must not leave a command, a view or a background refresh pending
 * on a service that accepts connections but never answers. Each call's
 * deadline is resolved in one order — the call's own `timeoutMs`, else the
 * operation's entry in `operationTimeoutsMs`, else `defaultTimeoutMs` — and
 * handed to the protocol's `HttpClient`, which bounds credential resolution,
 * the send and the body read with it and answers a `TRANSPORT_DISCONNECTED`
 * failure (`details.cancelled: 'timeout'`) when it passes. Omitting both
 * options means no deadline at all, which callers that bound every call
 * themselves rely on.
 *
 * ## The substitutes
 *
 * - **`vscode`** — the editor supplies the module at runtime and no
 *   installable package provides it, so `vi.mock` registers a factory for the
 *   bare specifier, as `../uri-handler.test.ts` does. The client reads the
 *   service URL through an injected configuration source here, so the
 *   substitute's `workspace` members exist only to satisfy the import.
 * - **The transport** — an injected `fetch` that answers from a per-case
 *   script and otherwise never settles, rejecting only when the call's abort
 *   signal fires: a stalled service, as a compliant `fetch` experiences it.
 * - **The credential** — a three-method fake of `./auth`'s store whose
 *   `refresh()` can hand out a rotated token, for the `UNAUTHORIZED` repeat.
 * - **The clock** — Vitest's fake timers, which the protocol client's
 *   per-call timer reads off `globalThis` when each call is made.
 *
 * No case connects the socket, so the `ws` constructor is never invoked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTHORIZATION_HEADER, formatBearer } from '@debuggen/protocol';
import type { FetchLike, HttpFetchInit, HttpResponseLike } from '@debuggen/protocol';
import { isErr, isOk, ok } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';

import {
  DEFAULT_EDITOR_REQUEST_TIMEOUT_MS,
  EDITOR_OPERATION_TIMEOUTS_MS,
  createServiceClient,
} from './client';
import type {
  ServiceClient,
  ServiceClientConfiguration,
  ServiceClientOptions,
  ServiceCredential,
} from './client';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (): undefined => undefined }),
    onDidChangeConfiguration: () => ({ dispose: (): undefined => undefined }),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The loopback origin every case's client is configured with. */
const SERVICE_URL = 'http://127.0.0.1:43117';

/** A session id in the product's `ses_<sixteen alphanumerics>` shape. */
const SESSION_ID = 'ses_0123456789abcdef';

/** The project root a created session names. */
const PROJECT_ROOT = '/workspace/storefront';

/** The editor credential every case starts with. */
const INITIAL_TOKEN = 'editor-token-initial';

/** The credential `auth.json` holds after a rotation. */
const ROTATED_TOKEN = 'editor-token-rotated';

/** Far beyond every deadline these cases configure: "forever" on the fake clock. */
const LONG_ADVANCE_MS = 10 * 60 * 1000;

/** One `fetch` the client made. */
interface RecordedCall {
  readonly url: string;
  readonly init: HttpFetchInit | undefined;
  /** Whether the call's abort signal had fired by the time it was read. */
  readonly aborted: () => boolean;
}

/** How one scripted `fetch` answers. */
type Responder = (init: HttpFetchInit | undefined) => Promise<HttpResponseLike>;

/** The injected transport and what it observed. */
interface Transport {
  readonly fetch: FetchLike;
  readonly calls: RecordedCall[];
  /** Queues the answer of the next `fetch`; an unscripted call stalls. */
  answerNext(responder: Responder): void;
}

/** The credential fake, with a count of the rotation re-reads it served. */
interface FakeCredential extends ServiceCredential {
  readonly refreshes: () => number;
}

/** A call under observation: whether it has settled yet, and its outcome. */
interface Observed<T> {
  readonly settled: () => boolean;
  readonly result: Promise<T>;
}

/**
 * A `fetch` that never answers, as a service that accepted the connection and
 * stalled. It rejects when the call's abort signal fires, as a compliant
 * `fetch` does, and never otherwise.
 */
const stall: Responder = (init) =>
  new Promise<HttpResponseLike>((_resolve, reject) => {
    const signal = init?.signal ?? undefined;
    if (signal === undefined) {
      return;
    }
    const abort = (): void => {
      reject(new Error('The request was aborted'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });

/** A `fetch` that answers at once with `status` and `body` serialised as JSON. */
function reply(status: number, body: unknown): Responder {
  return () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
}

/** The scripted transport of one case. */
function createTransport(): Transport {
  const calls: RecordedCall[] = [];
  const script: Responder[] = [];
  return {
    calls,
    answerNext(responder) {
      script.push(responder);
    },
    fetch: (url, init) => {
      const signal = init?.signal ?? undefined;
      calls.push({ url, init, aborted: () => signal?.aborted === true });
      return (script.shift() ?? stall)(init);
    },
  };
}

/**
 * The credential store fake: `token()` answers the current token, and
 * `refresh()` — the rotation re-read — switches to `afterRefresh` when given.
 */
function createCredential(afterRefresh?: string): FakeCredential {
  let current = INITIAL_TOKEN;
  let refreshes = 0;
  return {
    refreshes: () => refreshes,
    token: () => current,
    read: () => Promise.resolve(ok(current)),
    refresh: () => {
      refreshes += 1;
      current = afterRefresh ?? current;
      return Promise.resolve(ok(current));
    },
  };
}

/** The injected configuration source: a fixed URL that never changes. */
const configuration: ServiceClientConfiguration = {
  readServiceUrl: () => SERVICE_URL,
  onDidChangeServiceUrl: () => ({ dispose: (): undefined => undefined }),
};

/** Clients built by the current case, disposed after it. */
const clients: ServiceClient[] = [];

/** A client over the case's transport and credential, with the given deadlines. */
function createClient(
  transport: Transport,
  credential: ServiceCredential,
  deadlines: Pick<ServiceClientOptions, 'defaultTimeoutMs' | 'operationTimeoutsMs'>,
): ServiceClient {
  const client = createServiceClient({
    credential,
    configuration,
    fetch: transport.fetch,
    ...deadlines,
  });
  clients.push(client);
  return client;
}

/** The production deadlines `src/extension.ts` passes. */
const PRODUCTION_DEADLINES = {
  defaultTimeoutMs: DEFAULT_EDITOR_REQUEST_TIMEOUT_MS,
  operationTimeoutsMs: EDITOR_OPERATION_TIMEOUTS_MS,
} as const satisfies Pick<ServiceClientOptions, 'defaultTimeoutMs' | 'operationTimeoutsMs'>;

/** Starts observing a call's settlement. */
function observe<T>(promise: Promise<T>): Observed<T> {
  let settled = false;
  const result = promise.finally(() => {
    settled = true;
  });
  return { settled: () => settled, result };
}

/**
 * Advances the fake clock to one millisecond before `deadlineMs` and asserts
 * the call is still pending, then across the deadline and asserts it settled.
 *
 * @returns The call's outcome.
 */
async function expectSettlesAt<T>(observed: Observed<T>, deadlineMs: number): Promise<T> {
  await vi.advanceTimersByTimeAsync(deadlineMs - 1);
  expect(observed.settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(observed.settled()).toBe(true);
  return observed.result;
}

/** Asserts `result` is the protocol client's timeout failure for `operation` after `timeoutMs`. */
function expectTimedOut(
  result: Result<unknown, DebuggenError>,
  operation: string,
  timeoutMs: number,
): void {
  expect(isErr(result)).toBe(true);
  if (!isErr(result)) {
    return;
  }
  expect(result.error.code).toBe('TRANSPORT_DISCONNECTED');
  expect(result.error.details).toMatchObject({ operation, cancelled: 'timeout', timeoutMs });
  expect(result.error.message).toContain(`${String(timeoutMs)} ms`);
  expect(result.error.hint).toEqual(expect.any(String));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.dispose();
  }
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('the production deadline tables', () => {
  it('bound every call by default and lengthen only the operations that legitimately run long', () => {
    expect(DEFAULT_EDITOR_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(EDITOR_OPERATION_TIMEOUTS_MS).toEqual({
      'session.end': 90_000,
      'capture.start': 90_000,
      'devServer.launch': 120_000,
      'devServer.stop': 30_000,
      'panel.data': 30_000,
    });
    expect(Object.isFrozen(EDITOR_OPERATION_TIMEOUTS_MS)).toBe(true);
  });
});

describe('ServiceClient HTTP deadlines', () => {
  it('ends a call that states no timeout with the timeout failure after defaultTimeoutMs', async () => {
    const transport = createTransport();
    const client = createClient(transport, createCredential(), PRODUCTION_DEADLINES);

    const call = observe(
      client.createSession({ projectRoot: PROJECT_ROOT, question: 'Why is the page slow?' }),
    );
    const result = await expectSettlesAt(call, DEFAULT_EDITOR_REQUEST_TIMEOUT_MS);

    expectTimedOut(result, 'session.create', DEFAULT_EDITOR_REQUEST_TIMEOUT_MS);
    expect(transport.calls).toHaveLength(1);
    // The transport was told to stop, not merely abandoned.
    expect(transport.calls[0]?.aborted()).toBe(true);
  });

  it('bounds health() by the default, through the protocol client’s own method', async () => {
    const transport = createTransport();
    const client = createClient(transport, createCredential(), PRODUCTION_DEADLINES);

    const result = await expectSettlesAt(
      observe(client.health()),
      DEFAULT_EDITOR_REQUEST_TIMEOUT_MS,
    );

    expectTimedOut(result, 'health', DEFAULT_EDITOR_REQUEST_TIMEOUT_MS);
  });

  it('bounds startCapture() by its per-operation entry, not by the default', async () => {
    const transport = createTransport();
    const client = createClient(transport, createCredential(), PRODUCTION_DEADLINES);
    const bound = EDITOR_OPERATION_TIMEOUTS_MS['capture.start'] ?? Number.NaN;

    const result = await expectSettlesAt(observe(client.startCapture(SESSION_ID)), bound);

    expectTimedOut(result, 'capture.start', bound);
  });

  it('lets a per-operation entry override the default (session.end)', async () => {
    const transport = createTransport();
    const client = createClient(transport, createCredential(), PRODUCTION_DEADLINES);
    const bound = EDITOR_OPERATION_TIMEOUTS_MS['session.end'] ?? Number.NaN;
    expect(bound).toBeGreaterThan(DEFAULT_EDITOR_REQUEST_TIMEOUT_MS);

    const result = await expectSettlesAt(observe(client.endSession(SESSION_ID)), bound);

    expectTimedOut(result, 'session.end', bound);
  });

  it('lets a per-call timeoutMs override both the per-operation entry and the default', async () => {
    const transport = createTransport();
    const client = createClient(transport, createCredential(), PRODUCTION_DEADLINES);

    // Tighter than session.end's entry: the bound deactivate() passes.
    const ended = await expectSettlesAt(
      observe(client.endSession(SESSION_ID, { timeoutMs: 4_000 })),
      4_000,
    );
    expectTimedOut(ended, 'session.end', 4_000);

    // Looser than the default, through the generic passthrough.
    const listed = await expectSettlesAt(
      observe(client.request('session.list', { timeoutMs: 20_000 })),
      20_000,
    );
    expectTimedOut(listed, 'session.list', 20_000);
  });

  it('falls back to the default for a per-operation entry that is not a finite positive number', async () => {
    const transport = createTransport();
    const client = createClient(transport, createCredential(), {
      defaultTimeoutMs: DEFAULT_EDITOR_REQUEST_TIMEOUT_MS,
      operationTimeoutsMs: { 'session.end': 0, 'capture.stop': Number.POSITIVE_INFINITY },
    });

    const ended = await expectSettlesAt(
      observe(client.endSession(SESSION_ID)),
      DEFAULT_EDITOR_REQUEST_TIMEOUT_MS,
    );
    expectTimedOut(ended, 'session.end', DEFAULT_EDITOR_REQUEST_TIMEOUT_MS);

    const stopped = await expectSettlesAt(
      observe(client.stopCapture(SESSION_ID)),
      DEFAULT_EDITOR_REQUEST_TIMEOUT_MS,
    );
    expectTimedOut(stopped, 'capture.stop', DEFAULT_EDITOR_REQUEST_TIMEOUT_MS);
  });

  it('keeps the deadlines it was built with when the caller mutates its table afterwards', async () => {
    const transport = createTransport();
    const table: Partial<Record<'session.end', number>> = { 'session.end': 30_000 };
    const client = createClient(transport, createCredential(), {
      defaultTimeoutMs: DEFAULT_EDITOR_REQUEST_TIMEOUT_MS,
      operationTimeoutsMs: table,
    });
    table['session.end'] = 1;

    const result = await expectSettlesAt(observe(client.endSession(SESSION_ID)), 30_000);

    expectTimedOut(result, 'session.end', 30_000);
  });

  it('leaves a call pending when neither a default nor a per-operation deadline is configured', async () => {
    const transport = createTransport();
    const client = createClient(transport, createCredential(), {});

    const call = observe(client.endSession(SESSION_ID));
    await vi.advanceTimersByTimeAsync(LONG_ADVANCE_MS);

    expect(call.settled()).toBe(false);
    expect(transport.calls).toHaveLength(1);
    // No deadline and no caller signal: the transport receives no signal at all.
    expect(transport.calls[0]?.init?.signal).toBeUndefined();
  });

  describe('the UNAUTHORIZED repeat', () => {
    /** The service's refusal of a credential that is no longer current. */
    const refusal = reply(401, { code: 'UNAUTHORIZED', message: 'The credential was refused' });

    it('repeats a refused call once with the rotated credential, under a deadline', async () => {
      const transport = createTransport();
      const credential = createCredential(ROTATED_TOKEN);
      const client = createClient(transport, credential, PRODUCTION_DEADLINES);
      transport.answerNext(refusal);
      transport.answerNext(reply(200, { cleanup: 'clean' }));

      const result = await client.endSession(SESSION_ID);

      expect(isOk(result)).toBe(true);
      expect(isOk(result) ? result.value : undefined).toEqual({ cleanup: 'clean' });
      expect(credential.refreshes()).toBe(1);
      expect(transport.calls).toHaveLength(2);
      expect(transport.calls[0]?.init?.headers?.[AUTHORIZATION_HEADER]).toBe(
        formatBearer(INITIAL_TOKEN),
      );
      expect(transport.calls[1]?.init?.headers?.[AUTHORIZATION_HEADER]).toBe(
        formatBearer(ROTATED_TOKEN),
      );
      // Both sends were bounded: each received the call's abort signal.
      expect(transport.calls[0]?.init?.signal).toBeDefined();
      expect(transport.calls[1]?.init?.signal).toBeDefined();
    });

    it('bounds the repeat exactly like the refused call', async () => {
      const transport = createTransport();
      const client = createClient(transport, createCredential(ROTATED_TOKEN), PRODUCTION_DEADLINES);
      const bound = EDITOR_OPERATION_TIMEOUTS_MS['session.end'] ?? Number.NaN;
      transport.answerNext(refusal);

      const call = observe(client.endSession(SESSION_ID));
      // Let the refusal, the re-read and the repeat's send happen at t = 0.
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.calls).toHaveLength(2);

      const result = await expectSettlesAt(call, bound);

      expectTimedOut(result, 'session.end', bound);
      expect(transport.calls[1]?.aborted()).toBe(true);
    });

    it('does not repeat when the credential on disk is unchanged', async () => {
      const transport = createTransport();
      const credential = createCredential();
      const client = createClient(transport, credential, PRODUCTION_DEADLINES);
      transport.answerNext(refusal);

      const result = await client.endSession(SESSION_ID);

      expect(isErr(result) ? result.error.code : undefined).toBe('UNAUTHORIZED');
      expect(credential.refreshes()).toBe(1);
      expect(transport.calls).toHaveLength(1);
    });
  });
});
