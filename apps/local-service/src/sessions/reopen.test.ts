/**
 * Tests for the progress replay of `./reopen.ts`: the bounded read of a
 * session's progress history that a reopen replays.
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
 * The session store is the real one over an `mkdtemp` sandbox; the panel store
 * and the broadcaster are recording doubles. No environment variable is read,
 * no socket is opened and nothing under `$DEBUGGEN_HOME` is touched.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseSessionRecord } from '@debuggen/protocol';
import type { ClientKind, ProtocolMessage, SessionRecord } from '@debuggen/protocol';
import { newSessionId, ok, unwrap } from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, SessionId } from '@debuggen/shared';

import { openStore } from '../store/db.js';
import type { Store } from '../store/db.js';
import { createSessionsRepo } from '../store/sessions-repo.js';
import type { SessionsRepo } from '../store/sessions-repo.js';
import { MAX_REPLAYED_PROGRESS_ROWS, createSessionReopener } from './reopen.js';
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

let directory: string;
let store: Store;
let sessions: SessionsRepo;
let logs: CapturedLog[];
let sent: ProtocolMessage[];
let reopener: SessionReopener;
let sessionId: SessionId;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'debuggen-reopen-'));
  store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite') }));
  sessions = createSessionsRepo({ store, now: () => BASE_TIME });
  logs = [];
  sent = [];
  reopener = createSessionReopener({
    sessions,
    panels: {
      getLatestPanel: () => ok(undefined),
      getLatestAnalysis: () => ok(undefined),
    },
    broadcaster: {
      broadcast: (_session: string, message: ProtocolMessage) => {
        sent.push(message);
      },
      broadcastToKinds: (_session: string, _kinds: readonly ClientKind[], message) => {
        sent.push(message);
      },
    },
    logger: createCapturingLogger(logs),
    now: () => BASE_TIME,
  });
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
