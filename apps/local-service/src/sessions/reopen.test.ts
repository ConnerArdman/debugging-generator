/**
 * Tests for the progress replay of `./reopen.ts`: the bounded read of a
 * session's progress history that a reopen replays, and the recipients each
 * replayed frame is addressed to.
 *
 * The reopener reads the history through `SessionsRepo.listProgressTail`, so
 * the replay bound — {@link MAX_REPLAYED_PROGRESS_ROWS}, the most recent rows —
 * is applied when the rows are read rather than after every row was loaded.
 * The suite proves the three things that bound must not change: the rows
 * replayed are the newest ones, in the order they were stored; the number left
 * out is reported as `truncatedProgress` and logged by count; and a row older
 * than the bound is never read at all, which it demonstrates with an
 * unreadable row that would otherwise have failed the history.
 *
 * It then proves the routing: a reopen that names no kinds (the editor's
 * `GET /sessions/:id`) sends the record, the analysis and the panel to every
 * client through `broadcast` and the progress rows to
 * {@link UNTARGETED_PROGRESS_REPLAY_KINDS} alone through `broadcastToKinds`,
 * so a bound DevTools panel that already holds the history is not sent it
 * again; a reopen that names kinds (the bind path) sends every frame to exactly
 * those kinds; each row keeps its stored timestamp on either route; the fixed
 * order and the stop-at-the-first-refused-frame rule hold across the two port
 * methods; and the replay log states the recipients of each frame class.
 *
 * The session store is the real one over an `mkdtemp` sandbox; the panel store
 * and the broadcaster are recording doubles. No environment variable is read,
 * no socket is opened and nothing under `$DEBUGGEN_HOME` is touched.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clientKindSchema,
  createAnalysisResult,
  parseAnalysisResult,
  parseSessionRecord,
} from '@debuggen/protocol';
import type {
  AnalysisResult,
  ClientKind,
  MessageType,
  PanelSpec,
  ProtocolMessage,
  SessionRecord,
} from '@debuggen/protocol';
import {
  DebuggenError,
  newCaptureId,
  newPanelId,
  newSessionId,
  ok,
  unwrap,
} from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, SessionId } from '@debuggen/shared';

import { openStore } from '../store/db.js';
import type { Store } from '../store/db.js';
import { createSessionsRepo } from '../store/sessions-repo.js';
import type { SessionsRepo } from '../store/sessions-repo.js';
import type { SessionBroadcaster } from './manager.js';
import {
  MAX_REPLAYED_PROGRESS_ROWS,
  UNTARGETED_PROGRESS_REPLAY_KINDS,
  createSessionReopener,
} from './reopen.js';
import type { SessionReopener } from './reopen.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** A fixed epoch-millisecond base every stamp below is offset from. */
const BASE_TIME = 1_760_000_000_000;

/** One captured log record. */
interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * A logger that records every call.
 *
 * @param sink Where records go.
 * @param bindings Fields every record carries.
 * @returns The logger.
 */
function createCapturingLogger(sink: CapturedLog[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      sink.push({ level, message, fields: { ...bindings, ...(fields ?? {}) } });
    };

  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (childBindings: LogFields): Logger =>
      createCapturingLogger(sink, { ...bindings, ...childBindings }),
  };
}

/**
 * A valid session record, built through protocol's own parser.
 *
 * @param id The session's id.
 * @returns The record.
 */
function makeSession(id: SessionId): SessionRecord {
  return unwrap(
    parseSessionRecord({
      id,
      projectRoot: '/w/a',
      projectName: 'a',
      devServerUrl: 'http://127.0.0.1:3100/',
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
      status: 'ready',
      question: 'Why is handlerAlpha slow?',
      followUps: [],
      relevantFiles: [],
      plans: [],
      modifications: [],
      captures: [],
      panelIds: [],
      analyses: [],
      cleanup: { status: 'pending', conflicts: [] },
      promptVersions: {},
      provider: { id: 'deterministic' },
    }),
  );
}

/**
 * A minimal analysis of the session, assembled by protocol's constructor and
 * validated by its parser.
 *
 * @param id The session's id.
 * @returns The analysis.
 */
function makeAnalysis(id: SessionId): AnalysisResult {
  return unwrap(
    parseAnalysisResult(
      createAnalysisResult(
        { observed: [], likelyCauses: [] },
        {
          sessionId: id,
          captureId: newCaptureId(),
          analysisVersion: 1,
          createdAt: BASE_TIME,
          metrics: [],
        },
      ),
    ),
  );
}

/**
 * A minimal panel of the session.
 *
 * @param id The session's id.
 * @returns The panel specification.
 */
function makePanel(id: SessionId): PanelSpec {
  return {
    version: 1,
    id: newPanelId(),
    sessionId: id,
    panelVersion: 1,
    title: 'Panel alpha',
    summary: { observed: [], likelyCauses: [] },
    layout: [{ type: 'eventLog', id: 'layout[0]', query: { source: 'events' } }],
  };
}

/** One call the recording broadcaster received: the port method, its kinds, and the frame. */
interface BroadcastCall {
  readonly method: 'broadcast' | 'broadcastToKinds';
  /** The kinds named — `undefined` for `broadcast`, which addresses every client. */
  readonly kinds: readonly ClientKind[] | undefined;
  readonly message: ProtocolMessage;
}

/** A call reduced to what the routing assertions compare: method, kinds and frame type. */
interface Route {
  readonly method: BroadcastCall['method'];
  readonly kinds: readonly ClientKind[] | undefined;
  readonly type: MessageType;
}

/** The two client kinds the routing assertions name, read from protocol's vocabulary. */
const { vscode: EDITOR_KIND, devtools: DEVTOOLS_KIND } = clientKindSchema.enum;

let directory: string;
let store: Store;
let sessions: SessionsRepo;
let logs: CapturedLog[];
let calls: BroadcastCall[];
let sent: ProtocolMessage[];
let latestAnalysis: AnalysisResult | undefined;
let latestPanel: PanelSpec | undefined;
let reopener: SessionReopener;
let sessionId: SessionId;

/**
 * A broadcaster that records every call on both port methods, in call order,
 * into {@link calls} and — the frames alone — into {@link sent}.
 *
 * @returns The recording broadcaster.
 */
function createRecordingBroadcaster(): SessionBroadcaster {
  return {
    broadcast: (_session: string, message: ProtocolMessage) => {
      calls.push({ method: 'broadcast', kinds: undefined, message });
      sent.push(message);
    },
    broadcastToKinds: (_session: string, kinds: readonly ClientKind[], message) => {
      calls.push({ method: 'broadcastToKinds', kinds: [...kinds], message });
      sent.push(message);
    },
  };
}

/**
 * A reopener over the real session store, the panel double (which answers
 * {@link latestAnalysis} and {@link latestPanel}) and `broadcaster`.
 *
 * @param broadcaster Where replayed frames go.
 * @returns The reopener.
 */
function createReopener(broadcaster: SessionBroadcaster): SessionReopener {
  return createSessionReopener({
    sessions,
    panels: {
      getLatestPanel: () => ok(latestPanel),
      getLatestAnalysis: () => ok(latestAnalysis),
    },
    broadcaster,
    logger: createCapturingLogger(logs),
    now: () => BASE_TIME,
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'debuggen-reopen-'));
  store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite') }));
  sessions = createSessionsRepo({ store, now: () => BASE_TIME });
  logs = [];
  calls = [];
  sent = [];
  latestAnalysis = undefined;
  latestPanel = undefined;
  reopener = createReopener(createRecordingBroadcaster());
  sessionId = unwrap(sessions.insert(makeSession(newSessionId()))).id;
});

afterEach(() => {
  if (!store.isClosed) {
    store.close();
  }

  rmSync(directory, { recursive: true, force: true });
  expect(existsSync(directory)).toBe(false);
});

/**
 * Appends `count` progress lines, numbered from 1, inside one transaction.
 *
 * @param count How many lines to append.
 */
function appendLines(count: number): void {
  store.transaction(() => {
    for (let index = 1; index <= count; index += 1) {
      unwrap(
        sessions.appendProgress({
          sessionId,
          stage: 'investigate',
          status: 'running',
          message: `line ${String(index)}`,
          ts: BASE_TIME + index,
        }),
      );
    }
  });
}

/** The messages of the `session.progress` frames sent, in order. */
function sentProgress(): string[] {
  return sent.flatMap((message) =>
    message.type === 'session.progress' ? [message.payload.message] : [],
  );
}

/** Every broadcaster call so far, as method, kinds and frame type, in call order. */
function routes(): Route[] {
  return calls.map(({ method, kinds, message }) => ({ method, kinds, type: message.type }));
}

/** The one `session replayed from stored data` record the last reopen logged. */
function replayLog(): CapturedLog {
  const records = logs.filter((entry) => entry.message === 'session replayed from stored data');
  expect(records).toHaveLength(1);
  return records[0]!;
}

/* -------------------------------------------------------------------------------------------------
 * The bounded progress replay
 * ---------------------------------------------------------------------------------------------- */

describe('the reopen replays a bounded progress tail', () => {
  it('replays every row, in stored order, when the history is within the bound', async () => {
    appendLines(3);

    const reopened = unwrap(await reopener.reopen(sessionId));

    expect(reopened.truncatedProgress).toBe(0);
    expect(reopened.skipped).toEqual([]);
    expect(reopened.progress.map((row) => row.message)).toEqual(['line 1', 'line 2', 'line 3']);
    expect(reopened.replayed).toEqual([
      'session.updated',
      'session.progress',
      'session.progress',
      'session.progress',
    ]);
    expect(sentProgress()).toEqual(['line 1', 'line 2', 'line 3']);
    expect(sent.filter((message) => message.type === 'session.progress').map((m) => m.ts)).toEqual([
      BASE_TIME + 1,
      BASE_TIME + 2,
      BASE_TIME + 3,
    ]);
  });

  it('keeps the most recent rows past the bound and reports how many were left out', async () => {
    const extra = 7;
    appendLines(MAX_REPLAYED_PROGRESS_ROWS + extra);

    const reopened = unwrap(await reopener.reopen(sessionId));

    expect(reopened.truncatedProgress).toBe(extra);
    expect(reopened.progress).toHaveLength(MAX_REPLAYED_PROGRESS_ROWS);
    expect(reopened.progress[0]?.message).toBe(`line ${String(extra + 1)}`);
    expect(reopened.progress.at(-1)?.message).toBe(
      `line ${String(MAX_REPLAYED_PROGRESS_ROWS + extra)}`,
    );
    expect(sentProgress()).toEqual(reopened.progress.map((row) => row.message));

    const bound = logs.filter((entry) => entry.message.includes('exceeds the replay bound'));
    expect(bound).toHaveLength(1);
    expect(bound[0]?.fields).toMatchObject({
      stored: MAX_REPLAYED_PROGRESS_ROWS + extra,
      retained: MAX_REPLAYED_PROGRESS_ROWS,
      truncated: extra,
    });
  });

  it('never reads a row older than the bound', async () => {
    appendLines(MAX_REPLAYED_PROGRESS_ROWS + 1);
    const [oldest] = unwrap(sessions.listProgress(sessionId, { limit: 1 }));
    // Unreadable, and outside the tail: the whole history would be skipped if it were read.
    store.db
      .prepare('UPDATE session_progress SET status = ? WHERE id = ?')
      .run('bogus', oldest?.id ?? -1);

    const reopened = unwrap(await reopener.load(sessionId));

    expect(reopened.skipped).toEqual([]);
    expect(reopened.truncatedProgress).toBe(1);
    expect(reopened.progress).toHaveLength(MAX_REPLAYED_PROGRESS_ROWS);
    expect(sent).toEqual([]);
  });

  it('skips an unreadable tail as a whole and still replays the record', async () => {
    appendLines(2);
    const [, newest] = unwrap(sessions.listProgress(sessionId));
    store.db
      .prepare('UPDATE session_progress SET status = ? WHERE id = ?')
      .run('bogus', newest?.id ?? -1);

    const reopened = unwrap(await reopener.reopen(sessionId));

    expect(reopened.skipped).toEqual(['progress']);
    expect(reopened.progress).toEqual([]);
    expect(reopened.truncatedProgress).toBe(0);
    expect(reopened.replayed).toEqual(['session.updated']);
    expect(JSON.stringify(logs)).not.toContain('line 1');
  });
});

/* -------------------------------------------------------------------------------------------------
 * The recipients of each replayed frame
 * ---------------------------------------------------------------------------------------------- */

describe('the reopen addresses each frame class to its recipients', () => {
  it('names the editor kind, and only it, as the untargeted progress recipient', () => {
    expect(UNTARGETED_PROGRESS_REPLAY_KINDS).toEqual([EDITOR_KIND]);
    expect(Object.isFrozen(UNTARGETED_PROGRESS_REPLAY_KINDS)).toBe(true);
  });

  it('sends the rows to the editor kind only, and the record, analysis and panel to every client, when no kinds are named', async () => {
    appendLines(2);
    latestAnalysis = makeAnalysis(sessionId);
    latestPanel = makePanel(sessionId);
    const progressBefore = unwrap(sessions.listProgress(sessionId));

    const reopened = unwrap(await reopener.reopen(sessionId));

    expect(reopened.skipped).toEqual([]);
    expect(reopened.replayInterrupted).toBe(false);
    expect(reopened.replayed).toEqual([
      'session.updated',
      'session.progress',
      'session.progress',
      'analysis.completed',
      'panel.generated',
    ]);
    expect(routes()).toEqual([
      { method: 'broadcast', kinds: undefined, type: 'session.updated' },
      { method: 'broadcastToKinds', kinds: [EDITOR_KIND], type: 'session.progress' },
      { method: 'broadcastToKinds', kinds: [EDITOR_KIND], type: 'session.progress' },
      { method: 'broadcast', kinds: undefined, type: 'analysis.completed' },
      { method: 'broadcast', kinds: undefined, type: 'panel.generated' },
    ]);
    // No progress row is ever addressed to a DevTools panel by an untargeted reopen.
    expect(
      calls.filter(
        ({ method, kinds, message }) =>
          message.type === 'session.progress' &&
          (method === 'broadcast' || kinds?.includes(DEVTOOLS_KIND) === true),
      ),
    ).toEqual([]);
    expect(sentProgress()).toEqual(['line 1', 'line 2']);

    // The log states the recipients of each frame class, and no stored content.
    expect(replayLog().fields).toMatchObject({
      frames: 5,
      progressRows: 2,
      analysis: true,
      panel: true,
      recipients: 'all',
      progressRecipients: [EDITOR_KIND],
      interrupted: false,
    });
    expect(JSON.stringify(logs)).not.toContain('line 1');
    expect(JSON.stringify(logs)).not.toContain('Panel alpha');

    // Reopening wrote nothing.
    expect(unwrap(sessions.listProgress(sessionId))).toEqual(progressBefore);
  });

  it('sends every frame, the rows included, to the named kinds only', async () => {
    appendLines(2);
    latestAnalysis = makeAnalysis(sessionId);
    latestPanel = makePanel(sessionId);

    const reopened = unwrap(await reopener.reopen(sessionId, { kinds: [DEVTOOLS_KIND] }));

    expect(reopened.replayed).toEqual([
      'session.updated',
      'session.progress',
      'session.progress',
      'analysis.completed',
      'panel.generated',
    ]);
    expect(routes()).toEqual([
      { method: 'broadcastToKinds', kinds: [DEVTOOLS_KIND], type: 'session.updated' },
      { method: 'broadcastToKinds', kinds: [DEVTOOLS_KIND], type: 'session.progress' },
      { method: 'broadcastToKinds', kinds: [DEVTOOLS_KIND], type: 'session.progress' },
      { method: 'broadcastToKinds', kinds: [DEVTOOLS_KIND], type: 'analysis.completed' },
      { method: 'broadcastToKinds', kinds: [DEVTOOLS_KIND], type: 'panel.generated' },
    ]);
    expect(replayLog().fields).toMatchObject({
      frames: 5,
      recipients: [DEVTOOLS_KIND],
      progressRecipients: [DEVTOOLS_KIND],
    });
  });

  it('sends nothing for an empty kinds list and for a read without replay', async () => {
    appendLines(1);
    latestPanel = makePanel(sessionId);

    expect(unwrap(await reopener.reopen(sessionId, { kinds: [] })).replayed).toEqual([]);
    expect(unwrap(await reopener.reopen(sessionId, { replay: false })).replayed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('keeps each row’s stored timestamp on the editor route and on a named-kinds route', async () => {
    appendLines(3);
    const storedTs = [BASE_TIME + 1, BASE_TIME + 2, BASE_TIME + 3];

    unwrap(await reopener.reopen(sessionId));
    const untargeted = calls.filter(({ message }) => message.type === 'session.progress');
    expect(untargeted.map(({ kinds }) => kinds)).toEqual(storedTs.map(() => [EDITOR_KIND]));
    expect(untargeted.map(({ message }) => message.ts)).toEqual(storedTs);

    calls = [];
    sent = [];
    unwrap(await reopener.reopen(sessionId, { kinds: [DEVTOOLS_KIND] }));
    const targeted = calls.filter(({ message }) => message.type === 'session.progress');
    expect(targeted.map(({ kinds }) => kinds)).toEqual(storedTs.map(() => [DEVTOOLS_KIND]));
    expect(targeted.map(({ message }) => message.ts)).toEqual(storedTs);

    // A replayed row is a new envelope around the stored row: fresh id, stored stamp.
    expect(new Set([...untargeted, ...targeted].map(({ message }) => message.id)).size).toBe(6);
  });

  it('stops at the first row the editor route refuses and sends nothing after it', async () => {
    appendLines(3);
    latestAnalysis = makeAnalysis(sessionId);
    latestPanel = makePanel(sessionId);
    let rowsAccepted = 0;
    const refusing = createReopener({
      broadcast: (_session: string, message: ProtocolMessage) => {
        calls.push({ method: 'broadcast', kinds: undefined, message });
      },
      broadcastToKinds: (_session: string, kinds: readonly ClientKind[], message) => {
        if (rowsAccepted === 1) {
          throw new DebuggenError('TRANSPORT_DISCONNECTED', 'The socket closed mid-replay.');
        }
        rowsAccepted += 1;
        calls.push({ method: 'broadcastToKinds', kinds: [...kinds], message });
      },
    });

    const reopened = unwrap(await refusing.reopen(sessionId));

    expect(reopened.replayInterrupted).toBe(true);
    expect(reopened.replayed).toEqual(['session.updated', 'session.progress']);
    expect(routes()).toEqual([
      { method: 'broadcast', kinds: undefined, type: 'session.updated' },
      { method: 'broadcastToKinds', kinds: [EDITOR_KIND], type: 'session.progress' },
    ]);
    const stopped = logs.filter((entry) => entry.message.startsWith('the replay stopped'));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.fields).toMatchObject({
      type: 'session.progress',
      delivered: 2,
      code: 'TRANSPORT_DISCONNECTED',
    });
    expect(replayLog().fields).toMatchObject({
      frames: 2,
      recipients: 'all',
      progressRecipients: [EDITOR_KIND],
      interrupted: true,
    });
  });
});
