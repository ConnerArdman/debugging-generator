/**
 * Tests for `./purge-sessions.ts`: `debuggen.purgeSessions`.
 *
 * The command is driven through a fake {@link CommandContext}: the service
 * client answers `purgeSessions()` with whatever report a case scripts, the
 * Sessions tree's `refresh` is a spy, and every UI call is a spy. The command
 * module itself needs no `vscode` module — it imports types only from
 * `./index` and reaches the editor solely through the injected `CommandUi`.
 *
 * The last block drives `ServiceClient.purgeSessions` of `../service/client`
 * over a fake `fetch`, so the operation id, the route table row, the body and
 * the report's validation are exercised as shipped, and then runs the command
 * against that real client. `client.ts` imports `vscode` at load for its
 * default configuration source, which these cases replace, so `vi.mock`
 * registers an empty substitute for the bare specifier, as
 * `../uri-handler.test.ts` does.
 *
 * What is pinned:
 *
 * - the confirmation comes first, states the policy, and dismissing it sends
 *   nothing;
 * - a confirmed run sends exactly one request;
 * - success shows exactly one notice built only from the report's counts —
 *   nothing purged, deletions, conflict-retained sessions (named up to a
 *   handful, with the remainder counted) and skipped items — and "nothing to
 *   purge" only when every count and the issue count are zero;
 * - failure shows exactly one error with the command's prefix and the
 *   service's own message;
 * - the Sessions tree is refreshed after every outcome, and a refresh that
 *   throws is logged rather than reported twice;
 * - no retained session id, and no credential, reaches a log record.
 */

import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi, type Mock } from 'vitest';

import { SESSION_PURGE_MAX_REPORTED_SESSIONS } from '@debuggen/protocol';
import type { FetchLike, HttpResponseLike, SessionPurgeResponse } from '@debuggen/protocol';
import { DebuggenError, err, isErr, ok } from '@debuggen/shared';
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
  MAX_LISTED_RETAINED_SESSIONS,
  PURGE_FAILURE_PREFIX,
  PURGE_SESSIONS_CONFIRMATION,
  purgeSessions,
} from './purge-sessions';

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

/** A report in which the sweep removed nothing and kept nothing. */
const EMPTY_REPORT: SessionPurgeResponse = Object.freeze({
  cutoff: Date.UTC(2026, 7, 26),
  sessionsDeleted: 0,
  telemetryEventsDeleted: 0,
  panelsDeleted: 0,
  analysesDeleted: 0,
  modificationsDeleted: 0,
  backupDirsDeleted: 0,
  orphanBackupsDeleted: 0,
  indexCachesDeleted: 0,
  sessionsRetainedForConflicts: [],
  sessionsRetainedForConflictsTotal: 0,
  issueCount: 0,
  durationMs: 12.5,
});

/** {@link EMPTY_REPORT} with `changes` applied. */
function report(changes: Partial<SessionPurgeResponse>): SessionPurgeResponse {
  return { ...EMPTY_REPORT, ...changes };
}

/** `count` distinct session ids, `retained-01` onwards. */
function sessionIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `retained-${String(index + 1).padStart(2, '0')}`,
  );
}

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
  /** The service's reply. Default: {@link EMPTY_REPORT}. */
  readonly reply?: Result<SessionPurgeResponse, DebuggenError>;
  /** A real service client to use instead of the scripted `purgeSessions` spy. */
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
  readonly purge: Mock<() => Promise<Result<SessionPurgeResponse, DebuggenError>>>;
  readonly refreshTree: Mock<() => Promise<void>>;
  readonly resetSession: Mock<() => void>;
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

  const confirmDestructive = vi.fn((confirmation: DestructiveConfirmation) => {
    void confirmation;
    events.push('confirm');
    return Promise.resolve(options.confirm ?? true);
  });
  const notify = vi.fn((notice: CommandNotice) => {
    void notice;
    events.push('notify');
    return Promise.resolve<string | undefined>(undefined);
  });
  const notifyFailure = vi.fn((error: DebuggenError, failureOptions?: FailureNoticeOptions) => {
    void error;
    void failureOptions;
    events.push('notifyFailure');
    return Promise.resolve<string | undefined>(undefined);
  });
  const purge = vi.fn(() => {
    events.push('purge');
    return Promise.resolve(options.reply ?? ok(EMPTY_REPORT));
  });
  const refreshTree = vi.fn(() => {
    events.push('refreshTree');
    return Promise.resolve();
  });
  const resetSession = vi.fn(() => {
    events.push('resetSession');
  });

  const ctx = {
    state: { resetSession, activeSessionId: 'active-session' },
    client: options.client ?? { purgeSessions: purge },
    credentials: { token: () => FAKE_TOKEN },
    sessionView: {},
    sessionsTree: { refresh: refreshTree },
    serviceProcess: {},
    logger: recordingLogger(logs),
    ui: { confirmDestructive, notify, notifyFailure },
    guards: {},
    discovery: {},
    openSource: {},
  } as unknown as CommandContext;

  return {
    ctx,
    events,
    logs,
    confirmDestructive,
    notify,
    notifyFailure,
    purge,
    refreshTree,
    resetSession,
  };
}

/** Runs the command once and returns the one notice it showed. */
async function noticeFor(reply: SessionPurgeResponse): Promise<CommandNotice> {
  const harness = createHarness({ reply: ok(reply) });
  await purgeSessions(harness.ctx);
  expect(harness.notify).toHaveBeenCalledTimes(1);
  expect(harness.notifyFailure).not.toHaveBeenCalled();
  return harness.notify.mock.calls[0]![0];
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

describe('purgeSessions — confirmation', () => {
  it('asks once, before any request, with a detail stating the retention policy', async () => {
    const harness = createHarness();

    await purgeSessions(harness.ctx);

    expect(harness.confirmDestructive).toHaveBeenCalledTimes(1);
    expect(harness.confirmDestructive).toHaveBeenCalledWith(PURGE_SESSIONS_CONFIRMATION);
    expect(harness.events[0]).toBe('confirm');

    expect(PURGE_SESSIONS_CONFIRMATION.message).toBe('Purge stored Debug Generator sessions?');
    expect(PURGE_SESSIONS_CONFIRMATION.confirmLabel).toBe('Purge sessions');
    const detail = PURGE_SESSIONS_CONFIRMATION.detail;
    expect(detail).toContain('DEBUGGEN_RETENTION_DAYS, 30 days by default');
    expect(detail).toContain('telemetry, panels, analyses and backups');
    expect(detail).toContain('Stale code-index caches and orphan backups older than 7 days');
    expect(detail).toContain('unresolved conflict backup are kept');
    expect(detail).toContain('under $DEBUGGEN_HOME, never in your project');
  });

  it('sends no request, shows nothing and refreshes nothing when the modal is dismissed', async () => {
    const harness = createHarness({ confirm: false });

    await purgeSessions(harness.ctx, { kind: 'session', sessionId: 'from-a-tree-menu' });

    expect(harness.purge).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.notifyFailure).not.toHaveBeenCalled();
    expect(harness.refreshTree).not.toHaveBeenCalled();
    expect(harness.logs.filter((record) => record.level !== 'debug')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe('purgeSessions — a successful sweep', () => {
  it('sends exactly one request, shows one notice, then refreshes the Sessions tree', async () => {
    const harness = createHarness({ reply: ok(report({ sessionsDeleted: 1 })) });

    await purgeSessions(harness.ctx);

    expect(harness.purge).toHaveBeenCalledTimes(1);
    expect(harness.purge).toHaveBeenCalledWith();
    expect(harness.notify).toHaveBeenCalledTimes(1);
    expect(harness.refreshTree).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual(['confirm', 'purge', 'notify', 'refreshTree']);
  });

  it('never resets the active session', async () => {
    const harness = createHarness({ reply: ok(report({ sessionsDeleted: 4 })) });

    await purgeSessions(harness.ctx);

    expect(harness.resetSession).not.toHaveBeenCalled();
  });

  it('says there was nothing to purge when the report is empty', async () => {
    const notice = await noticeFor(EMPTY_REPORT);

    expect(notice).toEqual({
      level: 'info',
      message: 'Nothing to purge: no session is older than the retention window.',
      detail: undefined,
    });
  });

  it('lists what the deleted sessions held and what housekeeping removed', async () => {
    const notice = await noticeFor(
      report({
        sessionsDeleted: 3,
        telemetryEventsDeleted: 1204,
        panelsDeleted: 5,
        analysesDeleted: 1,
        modificationsDeleted: 7,
        backupDirsDeleted: 3,
        indexCachesDeleted: 2,
        orphanBackupsDeleted: 1,
      }),
    );

    expect(notice.level).toBe('info');
    expect(notice.message).toBe(
      'Purged 3 sessions (1,204 telemetry events, 5 panels, 1 analysis, 7 modification records, 3 backup directories); removed 2 index caches and 1 orphan backup.',
    );
    expect(notice.detail).toBeUndefined();
  });

  it('omits zero tallies and words a single session in the singular', async () => {
    const notice = await noticeFor(report({ sessionsDeleted: 1, panelsDeleted: 2 }));

    expect(notice.message).toBe('Purged 1 session (2 panels).');
  });

  it('reports housekeeping alone when no session was old enough', async () => {
    const notice = await noticeFor(
      report({ indexCachesDeleted: 1, orphanBackupsDeleted: 3, backupDirsDeleted: 2 }),
    );

    expect(notice.message).toBe(
      'No session is older than the retention window; removed 1 index cache, 3 orphan backups and 2 backup directories.',
    );
  });

  it('names every session a conflict kept when there are only a few', async () => {
    const ids = sessionIds(2);
    const notice = await noticeFor(
      report({
        sessionsDeleted: 1,
        sessionsRetainedForConflicts: ids,
        sessionsRetainedForConflictsTotal: 2,
      }),
    );

    expect(notice.message).toBe('Purged 1 session.');
    expect(notice.detail).toBe(
      '2 sessions were kept because a file conflict is unresolved: retained-01, retained-02. Their backups stay until the conflict is resolved.',
    );
  });

  it('words one kept session in the singular, and does not claim no session is aged', async () => {
    const notice = await noticeFor(
      report({
        sessionsRetainedForConflicts: ['retained-01'],
        sessionsRetainedForConflictsTotal: 1,
      }),
    );

    expect(notice.message).toBe('Nothing was purged.');
    expect(notice.detail).toBe(
      '1 session was kept because a file conflict is unresolved: retained-01. Their backups stay until the conflict is resolved.',
    );
  });

  it('names a handful of kept sessions and counts the rest', async () => {
    const ids = sessionIds(12);
    const notice = await noticeFor(
      report({ sessionsRetainedForConflicts: ids, sessionsRetainedForConflictsTotal: 12 }),
    );

    const listed = ids.slice(0, MAX_LISTED_RETAINED_SESSIONS).join(', ');
    expect(notice.detail).toBe(
      `12 sessions were kept because a file conflict is unresolved: ${listed}, and 7 more. Their backups stay until the conflict is resolved.`,
    );
    expect(notice.detail).not.toContain(ids[MAX_LISTED_RETAINED_SESSIONS]!);
  });

  it('counts kept sessions beyond the list the service truncated', async () => {
    const ids = sessionIds(SESSION_PURGE_MAX_REPORTED_SESSIONS);
    const notice = await noticeFor(
      report({
        sessionsRetainedForConflicts: ids,
        sessionsRetainedForConflictsTotal: 1500,
        indexCachesDeleted: 1,
      }),
    );

    expect(notice.message).toBe('No session was purged; removed 1 index cache.');
    expect(notice.detail).toContain('1,500 sessions were kept');
    expect(notice.detail).toContain(', and 1,495 more.');
  });

  it('raises the notice to a warning and counts the items the sweep skipped', async () => {
    const one = await noticeFor(report({ sessionsDeleted: 2, issueCount: 1 }));
    expect(one.level).toBe('warning');
    expect(one.detail).toBe(
      '1 item could not be purged and was skipped; the service log names it.',
    );

    const many = await noticeFor(
      report({
        issueCount: 3,
        sessionsRetainedForConflicts: ['retained-01'],
        sessionsRetainedForConflictsTotal: 1,
      }),
    );
    expect(many.level).toBe('warning');
    expect(many.detail).toBe(
      '1 session was kept because a file conflict is unresolved: retained-01. Their backups stay until the conflict is resolved. ' +
        '3 items could not be purged and were skipped; the service log names them.',
    );
  });

  it('says the sweep skipped items, never that nothing is aged, when skipped items are its only outcome', async () => {
    const many = await noticeFor(report({ issueCount: 3 }));
    expect(many).toEqual({
      level: 'warning',
      message:
        'No sessions were purged: the sweep skipped 3 items it could not examine; the Debug Generator service log lists them.',
      detail: undefined,
    });

    const one = await noticeFor(report({ issueCount: 1 }));
    expect(one).toEqual({
      level: 'warning',
      message:
        'No sessions were purged: the sweep skipped 1 item it could not examine; the Debug Generator service log lists it.',
      detail: undefined,
    });

    const large = await noticeFor(report({ issueCount: 1204 }));
    expect(large.message).toContain('the sweep skipped 1,204 items');
    for (const notice of [many, one, large]) {
      expect(notice.message).not.toContain('Nothing to purge');
      expect(notice.message).not.toContain('older than the retention window');
    }
  });

  it('does not claim no session is aged when housekeeping ran but items were skipped', async () => {
    const notice = await noticeFor(report({ indexCachesDeleted: 1, issueCount: 2 }));

    expect(notice).toEqual({
      level: 'warning',
      message: 'No session was purged; removed 1 index cache.',
      detail: '2 items could not be purged and were skipped; the service log names them.',
    });
  });

  it('counts rows removed without a session row instead of saying there was nothing to purge', async () => {
    const notice = await noticeFor(report({ telemetryEventsDeleted: 4, panelsDeleted: 1 }));

    expect(notice.level).toBe('info');
    expect(notice.message).toBe(
      'No session is older than the retention window; removed 4 telemetry events and 1 panel.',
    );
  });

  it('logs the counts once, never a retained session id or a credential', async () => {
    const ids = sessionIds(3);
    const harness = createHarness({
      reply: ok(
        report({
          sessionsDeleted: 2,
          telemetryEventsDeleted: 40,
          sessionsRetainedForConflicts: ids,
          sessionsRetainedForConflictsTotal: 3,
        }),
      ),
    });

    await purgeSessions(harness.ctx);

    const completed = harness.logs.filter(
      (record) => record.message === 'Retention purge completed',
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual({
      level: 'warn',
      message: 'Retention purge completed',
      fields: {
        command: 'debuggen.purgeSessions',
        cutoff: EMPTY_REPORT.cutoff,
        sessionsDeleted: 2,
        telemetryEventsDeleted: 40,
        panelsDeleted: 0,
        analysesDeleted: 0,
        modificationsDeleted: 0,
        backupDirsDeleted: 0,
        orphanBackupsDeleted: 0,
        indexCachesDeleted: 0,
        sessionsRetainedForConflictsTotal: 3,
        issueCount: 0,
        durationMs: EMPTY_REPORT.durationMs,
      },
    });
    const logged = JSON.stringify(harness.logs);
    for (const id of ids) {
      expect(logged).not.toContain(id);
    }
    expect(logged).not.toContain(FAKE_TOKEN);
  });

  it('logs a Sessions tree refresh that throws, without a second notice', async () => {
    const harness = createHarness({ reply: ok(report({ sessionsDeleted: 1 })) });
    harness.refreshTree.mockImplementation(() => Promise.reject(new Error('tree disposed')));

    await purgeSessions(harness.ctx);

    expect(harness.notify).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).not.toHaveBeenCalled();
    expect(harness.logs).toContainEqual({
      level: 'warn',
      message: 'The Sessions tree could not be refreshed after a purge',
      fields: { command: 'debuggen.purgeSessions', code: 'INTERNAL' },
    });
  });
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

describe('purgeSessions — a failed sweep', () => {
  const failure = new DebuggenError(
    'INTERNAL',
    'The session.purge request failed (status 500): The retention sweep could not run',
    {
      hint: 'The local service failed while handling this request; its log names the stage that failed.',
    },
  );

  it("shows exactly one failure with the prefix and the service's own message", async () => {
    const harness = createHarness({ reply: err(failure) });

    await purgeSessions(harness.ctx);

    expect(harness.purge).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).toHaveBeenCalledWith(failure, { prefix: PURGE_FAILURE_PREFIX });
    expect(PURGE_FAILURE_PREFIX).toBe('Could not purge stored sessions');
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.logs).toContainEqual({
      level: 'warn',
      message: 'Retention purge failed',
      fields: { command: 'debuggen.purgeSessions', code: 'INTERNAL' },
    });
  });

  it('still refreshes the Sessions tree, after the failure is shown', async () => {
    const harness = createHarness({ reply: err(failure) });

    await purgeSessions(harness.ctx);

    expect(harness.events).toEqual(['confirm', 'purge', 'notifyFailure', 'refreshTree']);
    expect(harness.resetSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ServiceClient.purgeSessions over a fake transport
// ---------------------------------------------------------------------------

/** The loopback origin the client under test is configured with. */
const SERVICE_ORIGIN = 'http://127.0.0.1:43117';

/** One HTTP reply, shaped as the protocol's `HttpResponseLike`. */
function reply(status: number, body: unknown): HttpResponseLike {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) };
}

/** A credential store that always holds {@link FAKE_TOKEN}. */
const STEADY_CREDENTIAL: ServiceCredential = {
  token: () => FAKE_TOKEN,
  read: () => Promise.resolve(ok(FAKE_TOKEN)),
  refresh: () => Promise.resolve(ok(FAKE_TOKEN)),
};

/** A client over `fetch`, with a fixed configuration source and no socket activity. */
function clientOver(fetch: FetchLike): ServiceClient {
  return createServiceClient({
    credential: STEADY_CREDENTIAL,
    fetch,
    configuration: {
      readServiceUrl: () => SERVICE_ORIGIN,
      onDidChangeServiceUrl: () => ({ dispose: () => undefined }),
    },
  });
}

describe('ServiceClient.purgeSessions', () => {
  it('sends POST /sessions/purge with an empty body and the bearer credential', async () => {
    const sent = report({ sessionsDeleted: 2, indexCachesDeleted: 1 });
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(reply(200, sent)));
    const client = clientOver(fetch);

    const purged = await client.purgeSessions();
    client.dispose();

    expect(purged).toEqual(ok(sent));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${SERVICE_ORIGIN}/sessions/purge`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(init?.headers?.['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('refuses a report whose retained list disagrees with its total', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(
        reply(
          200,
          report({ sessionsRetainedForConflicts: ['a'], sessionsRetainedForConflictsTotal: 2 }),
        ),
      ),
    );
    const client = clientOver(fetch);

    const purged = await client.purgeSessions();
    client.dispose();

    expect(isErr(purged) && purged.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
  });

  it('resolves a refused sweep as a typed failure carrying the service message', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(
        reply(500, { code: 'INTERNAL', message: 'The retention sweep could not run' }),
      ),
    );
    const client = clientOver(fetch);

    const purged = await client.purgeSessions();
    client.dispose();

    expect(isErr(purged)).toBe(true);
    const error = isErr(purged) ? purged.error : undefined;
    expect(error?.code).toBe('INTERNAL');
    expect(error?.message).toContain('The retention sweep could not run');
  });
});

describe('purgeSessions — against the real service client', () => {
  it('renders the notice from a real report and refreshes the tree', async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(
        reply(
          200,
          report({
            sessionsDeleted: 3,
            telemetryEventsDeleted: 1204,
            panelsDeleted: 5,
            sessionsRetainedForConflicts: ['retained-01', 'retained-02'],
            sessionsRetainedForConflictsTotal: 2,
          }),
        ),
      ),
    );
    const client = clientOver(fetch);
    const harness = createHarness({ client });

    await purgeSessions(harness.ctx);
    client.dispose();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(harness.notify).toHaveBeenCalledTimes(1);
    const notice = harness.notify.mock.calls[0]![0];
    expect(notice.message).toBe('Purged 3 sessions (1,204 telemetry events, 5 panels).');
    expect(notice.detail).toContain('retained-01, retained-02');
    expect(harness.refreshTree).toHaveBeenCalledTimes(1);
  });

  it("renders a real refusal once, with the service's message in it", async () => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(
        reply(500, { code: 'INTERNAL', message: 'The retention sweep could not run' }),
      ),
    );
    const client = clientOver(fetch);
    const harness = createHarness({ client });

    await purgeSessions(harness.ctx);
    client.dispose();

    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    const [error, failureOptions] = harness.notifyFailure.mock.calls[0]!;
    expect(error.message).toContain('The retention sweep could not run');
    expect(failureOptions).toEqual({ prefix: PURGE_FAILURE_PREFIX });
    expect(harness.refreshTree).toHaveBeenCalledTimes(1);
  });
});
