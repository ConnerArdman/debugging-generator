/**
 * Tests for `./rotate-service-token.ts`: `debuggen.rotateServiceToken`.
 *
 * The command is driven through a fake {@link CommandContext}: the service
 * client answers `rotateCredentials()` with whatever a case scripts, the
 * credential store holds a recognisable fake token, and every UI call is a
 * spy. The command module itself needs no `vscode` module — it imports types
 * only from `./index` and reaches the editor solely through the injected
 * `CommandUi`.
 *
 * The last block drives `ServiceClient.rotateCredentials` of
 * `../service/client` over a fake `fetch`, so the operation id, the route
 * table row, the body and the reply validation are exercised as shipped, and
 * then runs the command against that real client. `client.ts` imports
 * `vscode` at load for its default configuration source, which these cases
 * replace, so `vi.mock` registers an empty substitute for the bare specifier,
 * as `../uri-handler.test.ts` does.
 *
 * What is pinned:
 *
 * - the confirmation comes first, names every consequence, and dismissing it
 *   sends nothing;
 * - a confirmed run sends exactly one request, then drops and re-reads the
 *   editor credential on every outcome;
 * - success clears the pairing code, shows exactly one warning built from the
 *   service's tally, and runs the chosen follow-up command;
 * - "Relaunch Dev Server" re-resolves the project and stops the dev server
 *   the service launched before `debuggen.launchDevServer` runs; a project
 *   the service launched none for gets one manual-restart notice, and a stop
 *   or resolution failure gets one failure and no launch;
 * - failure shows exactly one error with the command's prefix and the
 *   service's own message — never a claim of its own about what changed;
 * - a failure that may follow the service's commit (any HTTP reply, a
 *   timeout, a dropped connection) clears the pairing code and offers "Pair
 *   Chrome", which runs `debuggen.pairChrome`; one that provably never reached
 *   the service (a refused connection, a refusal raised before sending) keeps
 *   the code and offers nothing;
 * - no credential, and no digest of one, reaches a log record or a notice;
 * - the client method sends `POST /credentials/rotate` with `{}` and the
 *   bearer credential, validates the tally, and resolves every failure.
 */

import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it, vi, type Mock } from 'vitest';

import type {
  CredentialsRotateResponse,
  DevServerStopRequest,
  DevServerStopResponse,
  FetchLike,
  HttpCallOptions,
  HttpResponseLike,
} from '@debuggen/protocol';
import { DebuggenError, err, isErr, isOk, ok } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';

import { createServiceClient } from '../service/client';
import type { ServiceClient, ServiceCredential } from '../service/client';

import type {
  CommandContext,
  CommandNotice,
  DestructiveConfirmation,
  FailureNoticeOptions,
} from './index';
import {
  LAUNCH_DEV_SERVER_ACTION,
  PAIR_CHROME_ACTION,
  RELAUNCH_DEV_SERVER_ACTION,
  RELAUNCH_PROJECT_FAILURE_PREFIX,
  ROTATE_SERVICE_TOKEN_CONFIRMATION,
  ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
  STOP_DEV_SERVER_FAILURE_PREFIX,
  rotateServiceToken,
} from './rotate-service-token';

// `../service/client` reads `vscode` only in its default configuration source,
// which every case below replaces; the module still has to resolve at load.
vi.mock('vscode', () => ({ workspace: {} }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A token no sentence of the command could contain by accident. Generated per
 * run rather than written out, so the committed suite holds no credential-shaped
 * literal for `scripts/check-secrets.mjs` to flag.
 */
const FAKE_TOKEN = `dgtok_FAKE_editor_${randomBytes(16).toString('hex')}`;

/** The SHA-256 hex digest the service would store for {@link FAKE_TOKEN}. */
const FAKE_DIGEST = createHash('sha256').update(FAKE_TOKEN).digest('hex');

/** The service's pre-commit refusal, as `auth.ts` words it. */
const NOT_ROTATED = new DebuggenError(
  'INTERNAL',
  'Credentials were not rotated; every existing credential is still valid.',
  { hint: 'Check that $DEBUGGEN_HOME is a private directory owned by this account.' },
);

/** The service's post-commit failure, as `auth.ts` words it. */
const ROTATED_BUT_FILE_FAILED = new DebuggenError(
  'INTERNAL',
  'Credentials were rotated, but auth.json could not be updated with the new editor credential.',
  {
    hint: 'Restart the Debug Generator service: it finishes the rotation as it starts, and the editor then reconnects with the new credential.',
  },
);

/** One log record the fake logger captured. */
interface LogRecord {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** What a case scripts. Every member has a default. */
interface HarnessOptions {
  /** The developer's answer to the modal. Default `true`. */
  readonly confirm?: boolean;
  /** The service's reply. Default: 3 credentials, 2 sockets. */
  readonly reply?: Result<CredentialsRotateResponse, DebuggenError>;
  /** The credential re-read's result. Default: the fake token. */
  readonly refresh?: Result<string, DebuggenError>;
  /** The button the developer chooses on every notice. Default: none. */
  readonly choice?: string;
  /**
   * The buttons chosen on successive notices, in order, taking precedence over
   * {@link choice}; a notice past the end of the list is dismissed.
   */
  readonly choices?: readonly (string | undefined)[];
  /** The button the developer chooses on a failure notice. Default: none. */
  readonly failureChoice?: string;
  /** Whether the window holds a project. Default `true`. */
  readonly project?: boolean;
  /** Makes `executeCommand` reject with this error. */
  readonly executeFailure?: Error;
  /** The service's reply to `devServer.stop`. Default: `{ stopped: true }`. */
  readonly stop?: Result<DevServerStopResponse, DebuggenError>;
  /** A real service client to use instead of the scripted spies. */
  readonly client?: ServiceClient;
}

/** The fake context and every spy a case asserts on. */
interface Harness {
  readonly ctx: CommandContext;
  /** Every notable call, in order, for sequencing assertions. */
  readonly events: string[];
  readonly logs: LogRecord[];
  readonly confirmDestructive: Mock<(options: DestructiveConfirmation) => Promise<boolean>>;
  readonly notify: Mock<(notice: CommandNotice) => Promise<string | undefined>>;
  readonly notifyFailure: Mock<
    (error: DebuggenError, options?: FailureNoticeOptions) => Promise<string | undefined>
  >;
  readonly executeCommand: Mock<(command: string, ...args: readonly unknown[]) => Promise<unknown>>;
  readonly rotateCredentials: Mock<() => Promise<Result<CredentialsRotateResponse, DebuggenError>>>;
  readonly stopDevServer: Mock<
    (
      request: DevServerStopRequest,
      options?: HttpCallOptions,
    ) => Promise<Result<DevServerStopResponse, DebuggenError>>
  >;
  readonly invalidate: Mock<() => void>;
  readonly refresh: Mock<() => Promise<Result<string, DebuggenError>>>;
  readonly clearPairing: Mock<() => void>;
  readonly postPairing: Mock<(...args: readonly unknown[]) => void>;
  readonly resolveProjectRoot: Mock<(options?: unknown) => Result<unknown, DebuggenError>>;
}

/** A logger that records every call. */
function recordingLogger(logs: LogRecord[]): Logger {
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      logs.push({ level, message, fields });
    };
  const logger: Logger = {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => logger,
  };
  return logger;
}

/** Builds the fake context for one case. */
function createHarness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const logs: LogRecord[] = [];
  let cachedToken: string | undefined = FAKE_TOKEN;
  let noticesShown = 0;

  const confirmDestructive = vi.fn((confirmation: DestructiveConfirmation) => {
    void confirmation;
    events.push('confirm');
    return Promise.resolve(options.confirm ?? true);
  });
  const notify = vi.fn((notice: CommandNotice) => {
    void notice;
    events.push('notify');
    const shown = noticesShown;
    noticesShown += 1;
    return Promise.resolve(options.choices === undefined ? options.choice : options.choices[shown]);
  });
  const notifyFailure = vi.fn((error: DebuggenError, failureOptions?: FailureNoticeOptions) => {
    void error;
    void failureOptions;
    events.push('notifyFailure');
    return Promise.resolve<string | undefined>(options.failureChoice);
  });
  const executeCommand = vi.fn((command: string, ...args: readonly unknown[]) => {
    void args;
    events.push(`execute:${command}`);
    return options.executeFailure === undefined
      ? Promise.resolve<unknown>(undefined)
      : Promise.reject(options.executeFailure);
  });
  const rotateCredentials = vi.fn(() => {
    events.push('rotate');
    return Promise.resolve(
      options.reply ?? ok<CredentialsRotateResponse>({ credentialsDeleted: 3, socketsClosed: 2 }),
    );
  });
  const stopDevServer = vi.fn((request: DevServerStopRequest, stopOptions?: HttpCallOptions) => {
    void request;
    void stopOptions;
    events.push('stop');
    return Promise.resolve(options.stop ?? ok<DevServerStopResponse>({ stopped: true }));
  });
  const invalidate = vi.fn(() => {
    events.push('invalidate');
    cachedToken = undefined;
  });
  const refresh = vi.fn(() => {
    events.push('refresh');
    const result = options.refresh ?? ok(FAKE_TOKEN);
    cachedToken = result.ok ? result.value : undefined;
    return Promise.resolve(result);
  });
  const clearPairing = vi.fn(() => {
    events.push('clearPairing');
  });
  const postPairing = vi.fn((...args: readonly unknown[]) => {
    void args;
    events.push('postPairing');
  });
  const resolveProjectRoot = vi.fn((resolveOptions?: unknown): Result<unknown, DebuggenError> => {
    void resolveOptions;
    return options.project === false
      ? err(new DebuggenError('PROJECT_NOT_FOUND', 'No folder is open in this VS Code window.'))
      : ok({ projectRoot: '/work/shop', name: 'shop', folderIndex: 0 });
  });

  const ctx = {
    state: { clearPairing },
    client: options.client ?? { rotateCredentials, stopDevServer },
    credentials: {
      invalidate,
      refresh,
      token: () => cachedToken,
    },
    sessionView: { postPairing },
    sessionsTree: {},
    serviceProcess: {},
    logger: recordingLogger(logs),
    ui: { confirmDestructive, notify, notifyFailure, executeCommand },
    guards: {},
    discovery: { resolveProjectRoot },
    openSource: {},
  } as unknown as CommandContext;

  return {
    ctx,
    events,
    logs,
    confirmDestructive,
    notify,
    notifyFailure,
    executeCommand,
    rotateCredentials,
    stopDevServer,
    invalidate,
    refresh,
    clearPairing,
    postPairing,
    resolveProjectRoot,
  };
}

/** The one notice a case showed; fails the case when there was not exactly one. */
function onlyNotice(harness: Harness): CommandNotice {
  expect(harness.notify).toHaveBeenCalledTimes(1);
  const notice = harness.notify.mock.calls[0]?.[0];
  expect(notice).toBeDefined();
  return notice!;
}

/** Everything the command wrote or showed, as one string, for leak checks. */
function everythingEmitted(harness: Harness): string {
  return JSON.stringify({
    logs: harness.logs,
    confirmations: harness.confirmDestructive.mock.calls,
    notices: harness.notify.mock.calls,
    failures: harness.notifyFailure.mock.calls.map(([error, failureOptions]) => ({
      message: error.message,
      hint: error.hint,
      details: error.details,
      failureOptions,
    })),
    commands: harness.executeCommand.mock.calls,
  });
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

describe('rotateServiceToken — confirmation', () => {
  it('asks once, before any request, with a detail naming every consequence', async () => {
    const harness = createHarness();

    await rotateServiceToken(harness.ctx);

    expect(harness.confirmDestructive).toHaveBeenCalledTimes(1);
    expect(harness.confirmDestructive).toHaveBeenCalledWith(ROTATE_SERVICE_TOKEN_CONFIRMATION);
    expect(harness.events[0]).toBe('confirm');
    expect(harness.events.indexOf('confirm')).toBeLessThan(harness.events.indexOf('rotate'));

    expect(ROTATE_SERVICE_TOKEN_CONFIRMATION.message).toBe(
      'Rotate the Debug Generator service token?',
    );
    expect(ROTATE_SERVICE_TOKEN_CONFIRMATION.confirmLabel).toBe('Rotate token');
    const detail = ROTATE_SERVICE_TOKEN_CONFIRMATION.detail;
    expect(detail).toContain('Every stored credential is deleted');
    expect(detail).toContain('auth.json is regenerated');
    expect(detail).toContain('code 4401');
    expect(detail).toContain('dev servers it launched stop working');
    expect(detail).toContain('Chrome must be paired again');
    expect(detail).toContain('launched dev servers must be relaunched');
  });

  it('sends no request and shows nothing when the modal is dismissed', async () => {
    const harness = createHarness({ confirm: false });

    await rotateServiceToken(harness.ctx);

    expect(harness.confirmDestructive).toHaveBeenCalledTimes(1);
    expect(harness.rotateCredentials).not.toHaveBeenCalled();
    expect(harness.invalidate).not.toHaveBeenCalled();
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.clearPairing).not.toHaveBeenCalled();
    expect(harness.postPairing).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.notifyFailure).not.toHaveBeenCalled();
    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.logs.filter((record) => record.level !== 'debug')).toEqual([]);
  });

  it('ignores invocation arguments', async () => {
    const harness = createHarness({ confirm: false });

    await rotateServiceToken(harness.ctx, { token: FAKE_TOKEN }, 'extra');

    expect(harness.rotateCredentials).not.toHaveBeenCalled();
    expect(everythingEmitted(harness)).not.toContain(FAKE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe('rotateServiceToken — a successful rotation', () => {
  it('sends exactly one request, then drops and re-reads the editor credential', async () => {
    const harness = createHarness();

    await rotateServiceToken(harness.ctx);

    expect(harness.rotateCredentials).toHaveBeenCalledTimes(1);
    expect(harness.rotateCredentials).toHaveBeenCalledWith();
    expect(harness.invalidate).toHaveBeenCalledTimes(1);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    const { events } = harness;
    expect(events.indexOf('rotate')).toBeLessThan(events.indexOf('invalidate'));
    expect(events.indexOf('invalidate')).toBeLessThan(events.indexOf('refresh'));
    expect(events.indexOf('refresh')).toBeLessThan(events.indexOf('notify'));
  });

  it('clears the pairing code in the store and in the view', async () => {
    const harness = createHarness();

    await rotateServiceToken(harness.ctx);

    expect(harness.clearPairing).toHaveBeenCalledTimes(1);
    expect(harness.postPairing).toHaveBeenCalledTimes(1);
    expect(harness.postPairing).toHaveBeenCalledWith();
    expect(harness.events.indexOf('postPairing')).toBeLessThan(harness.events.indexOf('notify'));
  });

  it('shows exactly one warning built from the tally, offering both follow-ups', async () => {
    const harness = createHarness();

    await rotateServiceToken(harness.ctx);

    const notice = onlyNotice(harness);
    expect(harness.notifyFailure).not.toHaveBeenCalled();
    expect(notice.level).toBe('warning');
    expect(notice.message).toBe(
      'Service token rotated: 3 credentials revoked, 2 connections closed.',
    );
    expect(notice.detail).toContain('Pair Chrome again');
    expect(notice.detail).toContain('relaunch any dev server');
    expect(notice.actions).toEqual([PAIR_CHROME_ACTION, RELAUNCH_DEV_SERVER_ACTION]);
    expect(harness.executeCommand).not.toHaveBeenCalled();
  });

  it('words singular and large tallies correctly', async () => {
    const single = createHarness({ reply: ok({ credentialsDeleted: 1, socketsClosed: 1 }) });
    await rotateServiceToken(single.ctx);
    expect(onlyNotice(single).message).toBe(
      'Service token rotated: 1 credential revoked, 1 connection closed.',
    );

    const many = createHarness({ reply: ok({ credentialsDeleted: 1204, socketsClosed: 0 }) });
    await rotateServiceToken(many.ctx);
    expect(onlyNotice(many).message).toBe(
      'Service token rotated: 1,204 credentials revoked, 0 connections closed.',
    );
  });

  it('logs the tally once, as a warning with counts only', async () => {
    const harness = createHarness();

    await rotateServiceToken(harness.ctx);

    const rotatedRecords = harness.logs.filter(
      (record) => record.message === 'Service credentials rotated',
    );
    expect(rotatedRecords).toEqual([
      {
        level: 'warn',
        message: 'Service credentials rotated',
        fields: { command: 'debuggen.rotateServiceToken', credentialsDeleted: 3, socketsClosed: 2 },
      },
    ]);
  });

  it('runs debuggen.pairChrome when "Pair Chrome" is chosen', async () => {
    const harness = createHarness({ choice: PAIR_CHROME_ACTION });

    await rotateServiceToken(harness.ctx);

    expect(harness.executeCommand).toHaveBeenCalledTimes(1);
    expect(harness.executeCommand).toHaveBeenCalledWith('debuggen.pairChrome');
    expect(harness.notifyFailure).not.toHaveBeenCalled();
  });

  it('stops the launched dev server, then runs debuggen.launchDevServer, when "Relaunch Dev Server" is chosen', async () => {
    const harness = createHarness({ choice: RELAUNCH_DEV_SERVER_ACTION });

    await rotateServiceToken(harness.ctx);

    expect(harness.stopDevServer).toHaveBeenCalledTimes(1);
    expect(harness.executeCommand).toHaveBeenCalledTimes(1);
    expect(harness.executeCommand).toHaveBeenCalledWith('debuggen.launchDevServer');
    expect(harness.events.indexOf('stop')).toBeLessThan(
      harness.events.indexOf('execute:debuggen.launchDevServer'),
    );
  });

  it('offers only "Pair Chrome" when the window holds no project to launch a dev server for', async () => {
    const harness = createHarness({ project: false, choice: RELAUNCH_DEV_SERVER_ACTION });

    await rotateServiceToken(harness.ctx);

    expect(onlyNotice(harness).actions).toEqual([PAIR_CHROME_ACTION]);
    expect(harness.stopDevServer).not.toHaveBeenCalled();
    expect(harness.executeCommand).not.toHaveBeenCalled();
  });

  it('offers only "Pair Chrome" when resolving the project throws', async () => {
    const harness = createHarness();
    harness.resolveProjectRoot.mockImplementation(() => {
      throw new Error('workspace API unavailable');
    });

    await rotateServiceToken(harness.ctx);

    expect(onlyNotice(harness).actions).toEqual([PAIR_CHROME_ACTION]);
    expect(harness.notifyFailure).not.toHaveBeenCalled();
  });

  it('reports a follow-up that cannot be dispatched once, with its own prefix', async () => {
    const harness = createHarness({
      choice: PAIR_CHROME_ACTION,
      executeFailure: new Error('command not found'),
    });

    await rotateServiceToken(harness.ctx);

    expect(harness.notify).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure.mock.calls[0]?.[1]).toEqual({
      prefix: 'Could not run the requested action',
    });
  });

  it('names a failed re-read of the new credential in the one notice, without a second popup', async () => {
    const unreadable = new DebuggenError('INTERNAL', 'The credential file is not readable', {
      details: { reason: 'unreadable' },
    });
    const harness = createHarness({ refresh: err(unreadable) });

    await rotateServiceToken(harness.ctx);

    const notice = onlyNotice(harness);
    expect(harness.notifyFailure).not.toHaveBeenCalled();
    expect(notice.detail).toContain(
      'The editor could not read its new credential yet (The credential file is not readable)',
    );
    expect(harness.logs).toContainEqual({
      level: 'warn',
      message: 'The editor credential could not be read again after rotation',
      fields: { command: 'debuggen.rotateServiceToken', rotated: true, code: 'INTERNAL' },
    });
  });

  it('treats a credential store that throws on refresh like a failed re-read', async () => {
    const harness = createHarness();
    harness.refresh.mockImplementation(() => Promise.reject(new Error('store broke its contract')));

    await rotateServiceToken(harness.ctx);

    expect(onlyNotice(harness).detail).toContain('could not read its new credential yet');
    expect(harness.notifyFailure).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Relaunching the launched dev server
// ---------------------------------------------------------------------------

/** A second project the window can resolve to once the notice is showing. */
const OTHER_PROJECT = { projectRoot: '/work/other', name: 'other', folderIndex: 1 } as const;

describe('rotateServiceToken — "Relaunch Dev Server"', () => {
  it('stops the dev server of the resolved project and waits for it before launching', async () => {
    const harness = createHarness({ choice: RELAUNCH_DEV_SERVER_ACTION });

    await rotateServiceToken(harness.ctx);

    expect(harness.resolveProjectRoot).toHaveBeenCalledTimes(2);
    expect(harness.resolveProjectRoot).toHaveBeenLastCalledWith({ logger: harness.ctx.logger });
    expect(harness.stopDevServer).toHaveBeenCalledTimes(1);
    const [request, stopOptions] = harness.stopDevServer.mock.calls[0]!;
    expect(request).toEqual({ projectRoot: '/work/shop' });
    // Above the service's own stop bound (5 s grace, then SIGKILL).
    expect(stopOptions?.timeoutMs).toBeGreaterThanOrEqual(10_000);
    expect(harness.events.slice(harness.events.indexOf('notify'))).toEqual([
      'notify',
      'stop',
      'execute:debuggen.launchDevServer',
    ]);
    expect(harness.notify).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).not.toHaveBeenCalled();
  });

  it('resolves the project again when the button is chosen and stops that one', async () => {
    const harness = createHarness({ choice: RELAUNCH_DEV_SERVER_ACTION });
    harness.resolveProjectRoot
      .mockReturnValueOnce(ok({ projectRoot: '/work/shop', name: 'shop', folderIndex: 0 }))
      .mockReturnValueOnce(ok(OTHER_PROJECT));

    await rotateServiceToken(harness.ctx);

    expect(harness.stopDevServer).toHaveBeenCalledTimes(1);
    expect(harness.stopDevServer.mock.calls[0]?.[0]).toEqual({ projectRoot: '/work/other' });
    expect(harness.executeCommand).toHaveBeenCalledWith('debuggen.launchDevServer');
  });

  it('tells the developer to restart a dev server Debug Generator did not launch, and launches nothing unasked', async () => {
    const harness = createHarness({
      choices: [RELAUNCH_DEV_SERVER_ACTION, undefined],
      stop: ok({ stopped: false }),
    });

    await rotateServiceToken(harness.ctx);

    expect(harness.stopDevServer).toHaveBeenCalledTimes(1);
    expect(harness.notify).toHaveBeenCalledTimes(2);
    const notice = harness.notify.mock.calls[1]![0];
    expect(notice.level).toBe('info');
    expect(notice.message).toBe('Debug Generator did not launch the dev server for shop.');
    expect(notice.detail).toContain(
      'restart it the way it was started so it receives a new credential',
    );
    expect(notice.detail).toContain(`choose "${LAUNCH_DEV_SERVER_ACTION}"`);
    // No command line: the product knows none for a server it did not start.
    expect(notice.detail).not.toMatch(/\b(?:pnpm|npm|yarn|bun|node|next)\b|dev-instrumented/);
    expect(notice.actions).toEqual([LAUNCH_DEV_SERVER_ACTION]);
    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.notifyFailure).not.toHaveBeenCalled();
  });

  it('launches the dev server from that notice only when "Launch Dev Server" is chosen', async () => {
    const harness = createHarness({
      choices: [RELAUNCH_DEV_SERVER_ACTION, LAUNCH_DEV_SERVER_ACTION],
      stop: ok({ stopped: false }),
    });

    await rotateServiceToken(harness.ctx);

    expect(harness.notify).toHaveBeenCalledTimes(2);
    expect(harness.executeCommand).toHaveBeenCalledTimes(1);
    expect(harness.executeCommand).toHaveBeenCalledWith('debuggen.launchDevServer');
    expect(harness.events.slice(-3)).toEqual([
      'stop',
      'notify',
      'execute:debuggen.launchDevServer',
    ]);
  });

  it('reports a failed stop once and never launches', async () => {
    const refusal = new DebuggenError('INTERNAL', 'The launched dev server did not exit.', {
      hint: 'Check the Debug Generator service log.',
    });
    const harness = createHarness({ choice: RELAUNCH_DEV_SERVER_ACTION, stop: err(refusal) });

    await rotateServiceToken(harness.ctx);

    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).toHaveBeenCalledWith(refusal, {
      prefix: STOP_DEV_SERVER_FAILURE_PREFIX,
    });
    expect(STOP_DEV_SERVER_FAILURE_PREFIX).toBe('Could not stop the launched dev server');
    expect(harness.notify).toHaveBeenCalledTimes(1);
    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.logs).toContainEqual({
      level: 'warn',
      message: 'The launched dev server could not be stopped for a relaunch',
      fields: { command: 'debuggen.rotateServiceToken', code: 'INTERNAL' },
    });
  });

  it('treats a stop that rejects like a failed stop', async () => {
    const harness = createHarness({ choice: RELAUNCH_DEV_SERVER_ACTION });
    harness.stopDevServer.mockImplementation(() =>
      Promise.reject(new Error('client broke its contract')),
    );

    await rotateServiceToken(harness.ctx);

    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure.mock.calls[0]?.[1]).toEqual({
      prefix: STOP_DEV_SERVER_FAILURE_PREFIX,
    });
    expect(harness.executeCommand).not.toHaveBeenCalled();
  });

  it('reports a project that no longer resolves once, and sends no stop', async () => {
    const unresolved = new DebuggenError(
      'PROJECT_NOT_FOUND',
      'No folder is open in this VS Code window.',
    );
    const harness = createHarness({ choice: RELAUNCH_DEV_SERVER_ACTION });
    harness.resolveProjectRoot
      .mockReturnValueOnce(ok({ projectRoot: '/work/shop', name: 'shop', folderIndex: 0 }))
      .mockReturnValueOnce(err(unresolved));

    await rotateServiceToken(harness.ctx);

    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).toHaveBeenCalledWith(unresolved, {
      prefix: RELAUNCH_PROJECT_FAILURE_PREFIX,
    });
    expect(harness.stopDevServer).not.toHaveBeenCalled();
    expect(harness.executeCommand).not.toHaveBeenCalled();
  });

  it('treats a resolver that throws when the button is chosen like one that fails', async () => {
    const harness = createHarness({ choice: RELAUNCH_DEV_SERVER_ACTION });
    harness.resolveProjectRoot
      .mockReturnValueOnce(ok({ projectRoot: '/work/shop', name: 'shop', folderIndex: 0 }))
      .mockImplementationOnce(() => {
        throw new Error('workspace API unavailable');
      });

    await rotateServiceToken(harness.ctx);

    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure.mock.calls[0]?.[1]).toEqual({
      prefix: RELAUNCH_PROJECT_FAILURE_PREFIX,
    });
    expect(harness.stopDevServer).not.toHaveBeenCalled();
    expect(harness.executeCommand).not.toHaveBeenCalled();
  });

  it('keeps the project root out of every log record', async () => {
    const outcomes: readonly Result<DevServerStopResponse, DebuggenError>[] = [
      ok({ stopped: true }),
      ok({ stopped: false }),
      err(new DebuggenError('INTERNAL', 'The launched dev server did not exit.')),
    ];
    for (const stop of outcomes) {
      const harness = createHarness({ choice: RELAUNCH_DEV_SERVER_ACTION, stop });

      await rotateServiceToken(harness.ctx);

      expect(harness.stopDevServer).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(harness.logs)).not.toContain('/work/shop');
    }
  });
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

describe('rotateServiceToken — a failed rotation', () => {
  it("shows exactly one failure with the prefix, the service's own message and Pair Chrome", async () => {
    const harness = createHarness({ reply: err(NOT_ROTATED) });

    await rotateServiceToken(harness.ctx);

    expect(harness.rotateCredentials).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).toHaveBeenCalledWith(NOT_ROTATED, {
      prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
      actions: [PAIR_CHROME_ACTION],
    });
    expect(ROTATE_SERVICE_TOKEN_FAILURE_PREFIX).toBe('Could not rotate the service token');
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.executeCommand).not.toHaveBeenCalled();
  });

  it('still drops and re-reads the editor credential, before reporting', async () => {
    const harness = createHarness({ reply: err(ROTATED_BUT_FILE_FAILED) });

    await rotateServiceToken(harness.ctx);

    expect(harness.invalidate).toHaveBeenCalledTimes(1);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    const { events } = harness;
    expect(events.indexOf('rotate')).toBeLessThan(events.indexOf('invalidate'));
    expect(events.indexOf('refresh')).toBeLessThan(events.indexOf('notifyFailure'));
  });

  it('passes a post-commit failure through unchanged, so its "were rotated" message and restart hint reach the developer', async () => {
    const harness = createHarness({ reply: err(ROTATED_BUT_FILE_FAILED) });

    await rotateServiceToken(harness.ctx);

    const [error, failureOptions] = harness.notifyFailure.mock.calls[0]!;
    expect(error).toBe(ROTATED_BUT_FILE_FAILED);
    expect(error.message).toMatch(/^Credentials were rotated, but /);
    expect(error.hint).toContain('Restart the Debug Generator service');
    expect(failureOptions).toEqual({
      prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
      actions: [PAIR_CHROME_ACTION],
    });
  });

  it('logs a failed re-read after a failed rotation, but shows only the rotation failure', async () => {
    const harness = createHarness({
      reply: err(ROTATED_BUT_FILE_FAILED),
      refresh: err(new DebuggenError('UNAUTHORIZED', 'The editor credential file is missing')),
    });

    await rotateServiceToken(harness.ctx);

    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.logs).toContainEqual({
      level: 'warn',
      message: 'The editor credential could not be read again after rotation',
      fields: { command: 'debuggen.rotateServiceToken', rotated: false, code: 'UNAUTHORIZED' },
    });
    expect(harness.logs).toContainEqual({
      level: 'warn',
      message: 'Service token rotation failed',
      fields: { command: 'debuggen.rotateServiceToken', code: 'INTERNAL', pairingCleared: true },
    });
  });
});

// ---------------------------------------------------------------------------
// Credential hygiene
// ---------------------------------------------------------------------------

describe('rotateServiceToken — credential hygiene', () => {
  const scenarios: readonly (readonly [string, HarnessOptions])[] = [
    ['success', {}],
    ['success with a follow-up', { choice: PAIR_CHROME_ACTION }],
    ['success with a relaunch', { choice: RELAUNCH_DEV_SERVER_ACTION }],
    [
      'success with a failed re-read',
      { refresh: err(new DebuggenError('INTERNAL', 'unreadable')) },
    ],
    ['pre-commit failure', { reply: err(NOT_ROTATED) }],
    ['post-commit failure', { reply: err(ROTATED_BUT_FILE_FAILED) }],
    ['dismissal', { confirm: false }],
  ];

  it.each(scenarios)(
    'never puts the token or its digest in a log or a notice (%s)',
    async (_, options) => {
      const harness = createHarness(options);

      await rotateServiceToken(harness.ctx);

      // The token really flowed through the store the command used, so its
      // absence below is a property of the command, not of the fixture.
      if (options.confirm !== false && options.refresh === undefined) {
        expect(harness.refresh).toHaveBeenCalledTimes(1);
        expect(harness.ctx.credentials.token()).toBe(FAKE_TOKEN);
      }
      const emitted = everythingEmitted(harness);
      expect(emitted).not.toContain(FAKE_TOKEN);
      expect(emitted).not.toContain(FAKE_DIGEST);
    },
  );
});

// ---------------------------------------------------------------------------
// ServiceClient.rotateCredentials over a fake transport
// ---------------------------------------------------------------------------

/** The loopback origin the client under test is configured with. */
const SERVICE_ORIGIN = 'http://127.0.0.1:43117';

/** The token `auth.json` holds after the rotation, in the re-read cases; generated like {@link FAKE_TOKEN}. */
const ROTATED_TOKEN = `dgtok_FAKE_rotated_${randomBytes(16).toString('hex')}`;

/** One HTTP reply, shaped as the protocol's `HttpResponseLike`. */
function reply(status: number, body: unknown): HttpResponseLike {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) };
}

/**
 * A credential store holding `initial`, whose re-read answers `onDisk` — the
 * token `auth.json` holds by the time the client reads it again.
 */
function fakeCredential(initial: string, onDisk: string): ServiceCredential {
  let cached: string | undefined = initial;
  const readDisk = (): Promise<Result<string, DebuggenError>> => {
    cached = onDisk;
    return Promise.resolve(ok(onDisk));
  };
  return {
    token: () => cached,
    read: readDisk,
    refresh: () => {
      cached = undefined;
      return readDisk();
    },
  };
}

/** A client over `fetch`, with a fixed configuration source and no socket activity. */
function clientOver(fetch: FetchLike, credential: ServiceCredential): ServiceClient {
  return createServiceClient({
    credential,
    fetch,
    configuration: {
      readServiceUrl: () => SERVICE_ORIGIN,
      onDidChangeServiceUrl: () => ({ dispose: () => undefined }),
    },
  });
}

describe('ServiceClient.rotateCredentials', () => {
  it('sends POST /credentials/rotate with an empty body and the bearer credential', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(reply(200, { credentialsDeleted: 4, socketsClosed: 3 })),
    );
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, FAKE_TOKEN));

    const rotated = await client.rotateCredentials();
    client.dispose();

    expect(rotated).toEqual(ok({ credentialsDeleted: 4, socketsClosed: 3 }));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${SERVICE_ORIGIN}/credentials/rotate`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(init?.headers?.['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('resolves a reply that breaks the response schema as a typed failure', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(reply(200, { credentialsDeleted: -1, socketsClosed: 0, token: 'x' })),
    );
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, FAKE_TOKEN));

    const rotated = await client.rotateCredentials();
    client.dispose();

    expect(isErr(rotated)).toBe(true);
    expect(isErr(rotated) && rotated.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
  });

  it('carries the service message of a failed rotation, and never rejects', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(reply(500, { code: 'INTERNAL', message: ROTATED_BUT_FILE_FAILED.message })),
    );
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, FAKE_TOKEN));

    const rotated = await client.rotateCredentials();
    client.dispose();

    expect(isErr(rotated)).toBe(true);
    const error = isErr(rotated) ? rotated.error : undefined;
    expect(error?.code).toBe('INTERNAL');
    expect(error?.message).toContain(ROTATED_BUT_FILE_FAILED.message);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a refused rotation while auth.json holds the refused token', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(reply(401, { code: 'UNAUTHORIZED', message: 'Unknown credential' })),
    );
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, FAKE_TOKEN));

    const rotated = await client.rotateCredentials();
    client.dispose();

    expect(isErr(rotated) && rotated.error.code).toBe('UNAUTHORIZED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('repeats a refused rotation exactly once when auth.json already holds another token', async () => {
    const fetch = vi.fn<FetchLike>((_url, init) =>
      Promise.resolve(
        init?.headers?.['authorization'] === `Bearer ${ROTATED_TOKEN}`
          ? reply(200, { credentialsDeleted: 1, socketsClosed: 1 })
          : reply(401, { code: 'UNAUTHORIZED', message: 'Unknown credential' }),
      ),
    );
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, ROTATED_TOKEN));

    const rotated = await client.rotateCredentials();
    client.dispose();

    expect(isOk(rotated)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('rotateServiceToken — against the real service client', () => {
  it('reports the service tally from a real reply and re-reads the credential', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(reply(200, { credentialsDeleted: 2, socketsClosed: 5 })),
    );
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, ROTATED_TOKEN));
    const harness = createHarness({ client });

    await rotateServiceToken(harness.ctx);
    client.dispose();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(onlyNotice(harness).message).toBe(
      'Service token rotated: 2 credentials revoked, 5 connections closed.',
    );
    expect(everythingEmitted(harness)).not.toContain(FAKE_TOKEN);
  });

  it('relaunches through devServer.stop on the real client before the launch command runs', async () => {
    const fetch = vi.fn<FetchLike>((url) =>
      Promise.resolve(
        url === `${SERVICE_ORIGIN}/dev-server/stop`
          ? reply(200, { stopped: true })
          : reply(200, { credentialsDeleted: 2, socketsClosed: 1 }),
      ),
    );
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, FAKE_TOKEN));
    const harness = createHarness({ client, choice: RELAUNCH_DEV_SERVER_ACTION });

    await rotateServiceToken(harness.ctx);
    client.dispose();

    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe(`${SERVICE_ORIGIN}/dev-server/stop`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ projectRoot: '/work/shop' }));
    expect(harness.executeCommand).toHaveBeenCalledTimes(1);
    expect(harness.executeCommand).toHaveBeenCalledWith('debuggen.launchDevServer');
    expect(harness.notifyFailure).not.toHaveBeenCalled();
  });

  it("renders a real post-commit failure once, with the service's message in it", async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(reply(500, { code: 'INTERNAL', message: ROTATED_BUT_FILE_FAILED.message })),
    );
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, FAKE_TOKEN));
    const harness = createHarness({ client });

    await rotateServiceToken(harness.ctx);
    client.dispose();

    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    const [error, failureOptions] = harness.notifyFailure.mock.calls[0]!;
    expect(error.message).toContain('Credentials were rotated, but auth.json could not be updated');
    expect(failureOptions).toEqual({
      prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
      actions: [PAIR_CHROME_ACTION],
    });
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The pairing code after a failed rotation, against the real service client
// ---------------------------------------------------------------------------

/**
 * The rejection Node's `fetch` produces when nothing listens on the port: a
 * `TypeError` whose `cause` is the socket's system error — the shape undici
 * gives a refused loopback connection.
 */
function fetchRejection(errno: string): TypeError {
  const socketError = Object.assign(new Error(`connect ${errno}`), {
    code: errno,
    syscall: 'connect',
  });
  return new TypeError('fetch failed', { cause: socketError });
}

/** A credential store with no token cached and none on disk. */
function missingCredential(): ServiceCredential {
  const missing = (): Promise<Result<string, DebuggenError>> =>
    Promise.resolve(
      err(new DebuggenError('UNAUTHORIZED', 'The editor credential file is missing')),
    );
  return { token: () => undefined, read: missing, refresh: missing };
}

describe('rotateServiceToken — the pairing code after a failed rotation', () => {
  it('clears the pairing code after a 500 reply and offers Pair Chrome in the one failure notice', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(reply(500, { code: 'INTERNAL', message: ROTATED_BUT_FILE_FAILED.message })),
    );
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, FAKE_TOKEN));
    const harness = createHarness({ client });

    await rotateServiceToken(harness.ctx);
    client.dispose();

    expect(harness.clearPairing).toHaveBeenCalledTimes(1);
    expect(harness.postPairing).toHaveBeenCalledTimes(1);
    expect(harness.postPairing).toHaveBeenCalledWith();
    expect(harness.events.indexOf('postPairing')).toBeLessThan(
      harness.events.indexOf('notifyFailure'),
    );
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    const [error, failureOptions] = harness.notifyFailure.mock.calls[0]!;
    expect(error.details?.['status']).toBe(500);
    expect(error.message).toContain(ROTATED_BUT_FILE_FAILED.message);
    expect(failureOptions).toEqual({
      prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
      actions: [PAIR_CHROME_ACTION],
    });
    expect(harness.executeCommand).not.toHaveBeenCalled();
  });

  it('runs debuggen.pairChrome when Pair Chrome is chosen on the failure notice, without a second notice', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(reply(500, { code: 'INTERNAL', message: ROTATED_BUT_FILE_FAILED.message })),
    );
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, FAKE_TOKEN));
    const harness = createHarness({ client, failureChoice: PAIR_CHROME_ACTION });

    await rotateServiceToken(harness.ctx);
    client.dispose();

    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.executeCommand).toHaveBeenCalledTimes(1);
    expect(harness.executeCommand).toHaveBeenCalledWith('debuggen.pairChrome');
    expect(harness.events.indexOf('notifyFailure')).toBeLessThan(
      harness.events.indexOf('execute:debuggen.pairChrome'),
    );
  });

  it('keeps the pairing code when the connection was refused, so no request reached the service', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.reject(fetchRejection('ECONNREFUSED')));
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, FAKE_TOKEN));
    const harness = createHarness({ client, failureChoice: PAIR_CHROME_ACTION });

    await rotateServiceToken(harness.ctx);
    client.dispose();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(harness.clearPairing).not.toHaveBeenCalled();
    expect(harness.postPairing).not.toHaveBeenCalled();
    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    const [error, failureOptions] = harness.notifyFailure.mock.calls[0]!;
    expect(error.code).toBe('TRANSPORT_DISCONNECTED');
    expect(failureOptions).toStrictEqual({ prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX });
    expect(harness.executeCommand).not.toHaveBeenCalled();
    expect(harness.logs).toContainEqual({
      level: 'warn',
      message: 'Service token rotation failed',
      fields: {
        command: 'debuggen.rotateServiceToken',
        code: 'TRANSPORT_DISCONNECTED',
        pairingCleared: false,
      },
    });
  });

  it('keeps the pairing code when no editor credential was available to send', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(reply(200, { credentialsDeleted: 1, socketsClosed: 1 })),
    );
    const client = clientOver(fetch, missingCredential());
    const harness = createHarness({ client });

    await rotateServiceToken(harness.ctx);
    client.dispose();

    expect(fetch).not.toHaveBeenCalled();
    expect(harness.clearPairing).not.toHaveBeenCalled();
    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    const [error, failureOptions] = harness.notifyFailure.mock.calls[0]!;
    expect(error.code).toBe('UNAUTHORIZED');
    expect(failureOptions).toStrictEqual({ prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX });
  });

  it('keeps the pairing code when the configured service URL was refused before sending', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(reply(200, { credentialsDeleted: 1, socketsClosed: 1 })),
    );
    const client = createServiceClient({
      credential: fakeCredential(FAKE_TOKEN, FAKE_TOKEN),
      fetch,
      configuration: {
        readServiceUrl: () => 'http://debuggen.example:43117',
        onDidChangeServiceUrl: () => ({ dispose: () => undefined }),
      },
    });
    const harness = createHarness({ client });

    await rotateServiceToken(harness.ctx);
    client.dispose();

    expect(fetch).not.toHaveBeenCalled();
    expect(harness.clearPairing).not.toHaveBeenCalled();
    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure.mock.calls[0]?.[0].code).toBe('CONFIG_INVALID');
    expect(harness.notifyFailure.mock.calls[0]?.[1]).toStrictEqual({
      prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
    });
  });

  it('clears the pairing code after a 401 reply, because the service answered it', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(reply(401, { code: 'UNAUTHORIZED', message: 'Unknown credential' })),
    );
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, FAKE_TOKEN));
    const harness = createHarness({ client });

    await rotateServiceToken(harness.ctx);
    client.dispose();

    const [error, failureOptions] = harness.notifyFailure.mock.calls[0]!;
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.details?.['status']).toBe(401);
    expect(harness.clearPairing).toHaveBeenCalledTimes(1);
    expect(failureOptions).toEqual({
      prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
      actions: [PAIR_CHROME_ACTION],
    });
  });

  it('clears the pairing code when the connection dropped after it was accepted', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.reject(fetchRejection('ECONNRESET')));
    const client = clientOver(fetch, fakeCredential(FAKE_TOKEN, FAKE_TOKEN));
    const harness = createHarness({ client });

    await rotateServiceToken(harness.ctx);
    client.dispose();

    expect(harness.notifyFailure.mock.calls[0]?.[0].code).toBe('TRANSPORT_DISCONNECTED');
    expect(harness.clearPairing).toHaveBeenCalledTimes(1);
    expect(harness.postPairing).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure.mock.calls[0]?.[1]).toEqual({
      prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
      actions: [PAIR_CHROME_ACTION],
    });
  });

  it('does not trust a refused-connection cause on a failure a timeout or abort ended', async () => {
    const cancelled = new DebuggenError(
      'TRANSPORT_DISCONNECTED',
      'The credentials.rotate request timed out after 25 ms',
      {
        details: { operation: 'credentials.rotate', cancelled: 'timeout' },
        cause: fetchRejection('ECONNREFUSED'),
      },
    );
    const harness = createHarness({ reply: err(cancelled) });

    await rotateServiceToken(harness.ctx);

    expect(harness.clearPairing).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).toHaveBeenCalledWith(cancelled, {
      prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
      actions: [PAIR_CHROME_ACTION],
    });
  });

  it('clears the pairing code when the request timed out, since the service may have applied it', async () => {
    const fetch = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise<HttpResponseLike>((_resolve, rejectFetch) => {
          init?.signal?.addEventListener('abort', () => {
            rejectFetch(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );
    const client = createServiceClient({
      credential: fakeCredential(FAKE_TOKEN, FAKE_TOKEN),
      fetch,
      defaultTimeoutMs: 25,
      configuration: {
        readServiceUrl: () => SERVICE_ORIGIN,
        onDidChangeServiceUrl: () => ({ dispose: () => undefined }),
      },
    });
    const harness = createHarness({ client });

    await rotateServiceToken(harness.ctx);
    client.dispose();

    const [error, failureOptions] = harness.notifyFailure.mock.calls[0]!;
    expect(error.code).toBe('TRANSPORT_DISCONNECTED');
    expect(error.details?.['cancelled']).toBe('timeout');
    expect(harness.clearPairing).toHaveBeenCalledTimes(1);
    expect(failureOptions).toEqual({
      prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX,
      actions: [PAIR_CHROME_ACTION],
    });
  });
});
