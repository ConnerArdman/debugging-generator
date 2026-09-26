/**
 * Tests for `./manager.ts`'s follow-up ladder: {@link SessionManager.appendFollowUp},
 * {@link placeFollowUpAttempt} and {@link SessionManager.recordFollowUpOutcome}.
 *
 * The promise under test is that a Retry of a failed follow-up never leaves a
 * duplicate behind — on the record's ladder **or** in the store's `followups`
 * table — and that nothing but the attempt's identity decides what a Retry is.
 * An ask names its attempt with protocol's `attemptId`; the question's text
 * (AAP §0.5.4), its time, the session's status and the entry's position are
 * never consulted. Each block pins one rule:
 *
 * 1. **A new attempt id → append**: one ladder entry with `attempt: 1` and one
 *    `followups` row, on any status — a reworded question on a failed session
 *    included, because it is a new question with a new id.
 * 2. **The latest unanswered attempt's id → retry in place**: the same ladder
 *    entry and the same `followups` row, rewritten with `attempt + 1`, the
 *    retry's question and time; answered entries before it are untouched;
 *    `session.updated` carries the result; consecutive retries keep counting.
 * 3. **Identical timestamps** change nothing: two asks in one millisecond are
 *    two entries, and a retry in the millisecond of its failed attempt is still
 *    recognisable by its counter.
 * 4. **Refusals**: an answered attempt (each outcome link on its own,
 *    `needsNewCapture: false` included), an attempt a later follow-up followed,
 *    and a malformed id are refused with nothing written.
 * 5. **The store's own guard**: the repository refuses to log one attempt
 *    twice, and a retry whose row is missing is an error, never an insert.
 * 6. **Outcome after a retry** stamps the retried entry.
 * 7. **Privacy**: no log record carries the question.
 *
 * The store is the real one — `openStore` against a file in a private `mkdtemp`
 * sandbox, never `:memory:` — and so are the sessions repository and the
 * progress emitter over it, so the record each case reads back is the one the
 * service would replay. Only the broadcaster is substituted, by a recorder, and
 * no cleanup runner is injected. Statuses are driven through the manager's own
 * API along legal edges of `./state-machine.ts`; the clock is injected and
 * advanced explicitly, so every `askedAt` is predictable — distinct unless a
 * case holds it still on purpose. No environment variable is read, no socket
 * is opened and no case depends on another having run.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FOLLOW_UP_ATTEMPT_ID_PREFIX,
  createAnalysisResult,
  parseAnalysisResult,
} from '@debuggen/protocol';
import type {
  AnalysisResult,
  FollowUpRecord,
  PanelSpec,
  ProgressStage,
  ProtocolMessage,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import { isErr, newAnalysisId, newCaptureId, newId, newPanelId, unwrap } from '@debuggen/shared';
import type {
  DebuggenError,
  LogFields,
  LogLevel,
  Logger,
  Result,
  SessionId,
} from '@debuggen/shared';
import { SECURE_DIR_MODE } from '@debuggen/shared/node';

import { openStore } from '../store/db.js';
import type { Store } from '../store/db.js';
import { createSessionsRepo } from '../store/sessions-repo.js';
import type { SessionsRepo } from '../store/sessions-repo.js';
import {
  FOLLOW_UP_ATTEMPT_REFUSALS,
  createSessionManager,
  placeFollowUpAttempt,
} from './manager.js';
import type { FollowUpOutcome, SessionBroadcaster, SessionManager } from './manager.js';
import { createSessionProgress } from './progress.js';

/* -------------------------------------------------------------------------------------------------
 * Fixture vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** The instant the sandbox clock starts at: 2026-01-01T00:00:00Z. */
const START_AT = 1_767_225_600_000;

/** How far the clock moves between two steps of a case, so no two stamps coincide. */
const STEP_MS = 1_000;

/** The project every session debugs; absolute POSIX, never read from disk by the manager. */
const PROJECT_ROOT = '/workspace/project-a';

/** The dev-server URL a created session is required to carry. */
const DEV_SERVER_URL = 'http://127.0.0.1:4173';

/** The session's own question. */
const SESSION_QUESTION = 'Why does the alpha view take long to appear?';

/** A follow-up question, resent verbatim by a Retry. */
const FOLLOW_UP = 'Which request does the alpha view wait on?';

/** A second, reworded follow-up. */
const REWORDED_FOLLOW_UP = 'What does the alpha view wait for before it renders?';

/** A fresh attempt id, minted exactly as the editor view and the route mint one. */
function attemptId(): string {
  return newId(FOLLOW_UP_ATTEMPT_ID_PREFIX);
}

/**
 * The string the privacy case plants in a question. Shaped like something that
 * must never be logged and unlikely to occur by accident, so a match is
 * unambiguous.
 */
const SENTINEL = 'MANAGER-FOLLOW-UP-SENTINEL-7c41e0b2-never-log-me';

/* -------------------------------------------------------------------------------------------------
 * A capturing logger and a recording broadcaster
 * ---------------------------------------------------------------------------------------------- */

/** One call on the capturing logger. */
interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * A {@link Logger} that records every call as `{ level, message, fields }`,
 * bindings merged the way a child applies them, so the privacy case sees
 * exactly what the manager handed to the logging interface.
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

/** One frame the manager or the progress emitter handed to the broadcaster. */
interface SentFrame {
  readonly sessionId: string;
  readonly message: ProtocolMessage;
}

/** A {@link SessionBroadcaster} that records every frame in the order it was sent. */
function createRecordingBroadcaster(sink: SentFrame[]): SessionBroadcaster {
  return {
    broadcast: (sessionId, message): void => {
      sink.push({ sessionId, message });
    },
    broadcastToKinds: (sessionId, _kinds, message): void => {
      sink.push({ sessionId, message });
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------------------------------- */

/** One case's sandbox: the real store, repository and manager over it, and what they emitted. */
interface Harness {
  /** The `mkdtemp` directory holding `$DEBUGGEN_HOME`; removed after the case. */
  readonly root: string;
  readonly store: Store;
  readonly sessions: SessionsRepo;
  readonly manager: SessionManager;
  readonly frames: SentFrame[];
  readonly logs: CapturedLog[];
  /** Moves the shared clock one step forward and answers the new reading. */
  tick(): number;
  /** The shared clock's current reading, without moving it. */
  now(): number;
}

/** The sandbox of the current case. */
let h: Harness;

/**
 * Creates a sandbox: a canonical `mkdtemp` root, a private (`0700`) home in it,
 * the store opened on a file there, and the sessions repository, the progress
 * emitter and the manager over it — all reading one injected clock.
 */
function createHarness(): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-manager-')));
  const home = join(root, 'home');
  mkdirSync(home, { mode: SECURE_DIR_MODE });

  const logs: CapturedLog[] = [];
  const frames: SentFrame[] = [];
  const logger = createCapturingLogger(logs);
  const store = unwrap(openStore({ databasePath: join(home, 'sessions.sqlite'), logger }));
  let clock = START_AT;
  const now = (): number => clock;
  const sessions = createSessionsRepo({ store, logger, now });
  const broadcaster = createRecordingBroadcaster(frames);
  const progress = createSessionProgress({ sessions, broadcaster, logger, now });
  const manager = createSessionManager({ sessions, broadcaster, progress, logger, now });

  return {
    root,
    store,
    sessions,
    manager,
    frames,
    logs,
    tick: (): number => {
      clock += STEP_MS;
      return clock;
    },
    now,
  };
}

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  if (!h.store.isClosed) {
    h.store.close();
  }
  rmSync(h.root, { recursive: true, force: true });
  expect(existsSync(h.root)).toBe(false);
});

/* -------------------------------------------------------------------------------------------------
 * Fixture builders and status drivers
 * ---------------------------------------------------------------------------------------------- */

/** A minimal analysis, assembled by the protocol's constructor and validated by its parser. */
function makeAnalysis(sessionId: SessionId): AnalysisResult {
  return unwrap(
    parseAnalysisResult(
      createAnalysisResult(
        { observed: [], likelyCauses: [] },
        {
          sessionId,
          captureId: newCaptureId(),
          analysisVersion: 1,
          createdAt: START_AT,
          metrics: [],
        },
      ),
    ),
  );
}

/** A minimal panel of the session. */
function makePanel(sessionId: SessionId): PanelSpec {
  return {
    version: 1,
    id: newPanelId(),
    sessionId,
    panelVersion: 1,
    title: 'Panel alpha',
    summary: { observed: [], likelyCauses: [] },
    layout: [{ type: 'eventLog', id: 'layout[0]', query: { source: 'events' } }],
  };
}

/** Creates a session in `created`. */
async function createSession(): Promise<SessionRecord> {
  h.tick();
  return unwrap(
    await h.manager.create({
      projectRoot: PROJECT_ROOT,
      question: SESSION_QUESTION,
      devServerUrl: DEV_SERVER_URL,
      provider: { id: 'deterministic' },
    }),
  );
}

/** Files the session `failed` at `stage`, as the orchestrator does for a failing stage. */
async function failAt(sessionId: SessionId, stage: ProgressStage): Promise<SessionRecord> {
  h.tick();
  return unwrap(
    await h.manager.fail(sessionId, {
      stage,
      code: 'MODEL_UNAVAILABLE',
      message: 'The model provider did not answer.',
      hint: 'Check the provider configuration, then retry.',
    }),
  );
}

/** Moves the session to `status` along one legal, unguarded edge. */
async function moveTo(sessionId: SessionId, status: SessionStatus): Promise<SessionRecord> {
  h.tick();
  return unwrap(await h.manager.transitionTo(sessionId, status));
}

/**
 * A session in `generated`, where follow-ups are normally asked: the shortest
 * legal walk is `created → failed → analyzing → generated`, the last edge with
 * the analysis and panel guard A requires.
 */
async function generatedSession(): Promise<SessionRecord> {
  const created = await createSession();
  await failAt(created.id, 'understand');
  await moveTo(created.id, 'analyzing');
  h.tick();
  const generated = unwrap(
    await h.manager.transitionTo(created.id, 'generated', {
      analysis: makeAnalysis(created.id),
      panel: makePanel(created.id),
    }),
  );
  expect(generated.status).toBe('generated');
  return generated;
}

/** What one recorded ask answered: the record, and the `askedAt` it was stamped with. */
interface Asked {
  readonly session: SessionRecord;
  readonly askedAt: number;
}

/**
 * Asks a follow-up under `id` — at the next clock step, or, with
 * `{ tick: false }`, in the same millisecond as the previous stamp.
 */
async function ask(
  sessionId: SessionId,
  question: string,
  id: string,
  options: { readonly tick?: boolean } = {},
): Promise<Asked> {
  const askedAt = options.tick === false ? h.now() : h.tick();
  const session = unwrap(await h.manager.appendFollowUp(sessionId, question, id));
  return { session, askedAt };
}

/** Asks a follow-up that the manager must refuse; answers the refusal. */
async function refusedAsk(
  sessionId: SessionId,
  question: string,
  id: string,
): Promise<DebuggenError> {
  h.tick();
  const outcome: Result<SessionRecord, DebuggenError> = await h.manager.appendFollowUp(
    sessionId,
    question,
    id,
  );
  if (!isErr(outcome)) {
    throw new Error('the ask was recorded, but a refusal was expected');
  }
  return outcome.error;
}

/**
 * A follow-up that the stage recorded and then failed on: asked from
 * `generated` under `id`, the existing-evidence path entered (`→ analyzing`),
 * and the session filed `failed` at the `followup` stage.
 */
async function failedFollowUp(sessionId: SessionId, question: string, id: string): Promise<Asked> {
  const asked = await ask(sessionId, question, id);
  await moveTo(sessionId, 'analyzing');
  const failed = await failAt(sessionId, 'followup');
  expect(failed.status).toBe('failed');
  return { session: failed, askedAt: asked.askedAt };
}

/** Stamps outcome links on the latest follow-up, as the follow-up stage does once it has answered. */
async function answer(sessionId: SessionId, links: FollowUpOutcome): Promise<SessionRecord> {
  h.tick();
  return unwrap(await h.manager.recordFollowUpOutcome(sessionId, links));
}

/** The session as the store holds it now. */
function stored(sessionId: SessionId): SessionRecord {
  const read = unwrap(h.sessions.get(sessionId));
  if (read === undefined) {
    throw new Error(`session ${sessionId} is not stored`);
  }
  return read;
}

/** The record the latest `session.updated` frame for the session carried. */
function lastUpdated(sessionId: SessionId): SessionRecord {
  for (let index = h.frames.length - 1; index >= 0; index -= 1) {
    const frame = h.frames[index];
    if (frame?.sessionId === sessionId && frame.message.type === 'session.updated') {
      return frame.message.payload.session;
    }
  }
  throw new Error(`no session.updated frame was sent for ${sessionId}`);
}

/** One outcome link on its own: its label and a builder minting a fresh value. */
interface SingleLinkCase {
  readonly link: string;
  readonly outcome: () => FollowUpOutcome;
}

/** The five outcome links, one per case. */
const SINGLE_LINK_CASES: SingleLinkCase[] = [
  { link: 'needsNewCapture: false', outcome: () => ({ needsNewCapture: false }) },
  { link: 'planVersion', outcome: () => ({ planVersion: 1 }) },
  { link: 'captureId', outcome: () => ({ captureId: newCaptureId() }) },
  { link: 'analysisId', outcome: () => ({ analysisId: newAnalysisId() }) },
  { link: 'panelId', outcome: () => ({ panelId: newPanelId() }) },
];

/* -------------------------------------------------------------------------------------------------
 * The cases
 * ---------------------------------------------------------------------------------------------- */

describe('appendFollowUp with a new attempt id', () => {
  it('appends the first follow-up of a generated session as attempt 1, with one logged row', async () => {
    const session = await generatedSession();
    const id = attemptId();

    const { session: asked, askedAt } = await ask(session.id, FOLLOW_UP, id);

    expect(asked.status).toBe('generated');
    expect(asked.followUps).toEqual([{ question: FOLLOW_UP, askedAt, attemptId: id, attempt: 1 }]);
    expect(stored(session.id)).toEqual(asked);
    expect(lastUpdated(session.id)).toEqual(asked);
    expect(unwrap(h.sessions.listFollowUps(session.id))).toEqual(asked.followUps);
  });

  it('appends a reworded question on a failed session instead of merging it over the failed attempt', async () => {
    const session = await generatedSession();
    const failedId = attemptId();
    const failed = await failedFollowUp(session.id, FOLLOW_UP, failedId);
    const newQuestionId = attemptId();

    const next = await ask(session.id, REWORDED_FOLLOW_UP, newQuestionId);

    const expected: FollowUpRecord[] = [
      { question: FOLLOW_UP, askedAt: failed.askedAt, attemptId: failedId, attempt: 1 },
      { question: REWORDED_FOLLOW_UP, askedAt: next.askedAt, attemptId: newQuestionId, attempt: 1 },
    ];
    expect(next.session.followUps).toEqual(expected);
    expect(next.session.status).toBe('failed');
    expect(stored(session.id).followUps).toEqual(expected);
    expect(unwrap(h.sessions.listFollowUps(session.id))).toEqual(expected);
  });

  it('appends the same wording asked again under a new id: the text never identifies an attempt', async () => {
    const session = await generatedSession();
    const first = await ask(session.id, FOLLOW_UP, attemptId());

    const second = await ask(session.id, FOLLOW_UP, attemptId());

    expect(second.session.followUps).toHaveLength(2);
    expect(second.session.followUps.map((entry) => entry.askedAt)).toEqual([
      first.askedAt,
      second.askedAt,
    ]);
    expect(unwrap(h.sessions.listFollowUps(session.id))).toHaveLength(2);
  });

  it('appends the first follow-up of a failed session that has none', async () => {
    const session = await createSession();
    await failAt(session.id, 'understand');
    const id = attemptId();

    const { session: asked, askedAt } = await ask(session.id, FOLLOW_UP, id);

    expect(asked.followUps).toEqual([{ question: FOLLOW_UP, askedAt, attemptId: id, attempt: 1 }]);
    expect(stored(session.id)).toEqual(asked);
  });
});

describe('appendFollowUp retrying the latest unanswered attempt by its id', () => {
  it('rewrites the one ladder entry and the one logged row in place, as attempt 2', async () => {
    const session = await generatedSession();
    const id = attemptId();
    await failedFollowUp(session.id, FOLLOW_UP, id);
    const rowsBefore = unwrap(h.sessions.listFollowUps(session.id));
    expect(rowsBefore).toHaveLength(1);

    const retried = await ask(session.id, FOLLOW_UP, id);

    const entry: FollowUpRecord = {
      question: FOLLOW_UP,
      askedAt: retried.askedAt,
      attemptId: id,
      attempt: 2,
    };
    expect(retried.session.followUps).toEqual([entry]);
    expect(retried.session.status).toBe('failed');
    expect(stored(session.id)).toEqual(retried.session);
    expect(lastUpdated(session.id)).toEqual(retried.session);
    // The log holds one row per attempt: the same row, rewritten — never a second one.
    expect(unwrap(h.sessions.listFollowUps(session.id))).toEqual([entry]);

    const recorded = h.logs.filter((log) => log.message === 'follow-up attempt retried in place');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.fields).toMatchObject({ followUps: 1, attempt: 2 });
  });

  it('keeps every answered follow-up before the retried attempt exactly where it was', async () => {
    const session = await generatedSession();
    const answeredId = attemptId();
    const answered = await ask(session.id, REWORDED_FOLLOW_UP, answeredId);
    const links: FollowUpOutcome = {
      needsNewCapture: false,
      captureId: newCaptureId(),
      analysisId: newAnalysisId(),
      panelId: newPanelId(),
    };
    await answer(session.id, links);
    await moveTo(session.id, 'analyzing');
    h.tick();
    unwrap(
      await h.manager.transitionTo(session.id, 'generated', {
        analysis: makeAnalysis(session.id),
        panel: makePanel(session.id),
      }),
    );
    const failedId = attemptId();
    await failedFollowUp(session.id, FOLLOW_UP, failedId);

    const retried = await ask(session.id, FOLLOW_UP, failedId);

    const expected: FollowUpRecord[] = [
      {
        question: REWORDED_FOLLOW_UP,
        askedAt: answered.askedAt,
        attemptId: answeredId,
        attempt: 1,
        ...links,
      },
      { question: FOLLOW_UP, askedAt: retried.askedAt, attemptId: failedId, attempt: 2 },
    ];
    expect(retried.session.followUps).toEqual(expected);
    expect(stored(session.id)).toEqual(retried.session);
    // The log's rows keep their order; only the retried one changed.
    expect(unwrap(h.sessions.listFollowUps(session.id)).map((row) => row.attemptId)).toEqual([
      answeredId,
      failedId,
    ]);
  });

  it('keeps counting across consecutive failed retries of one attempt', async () => {
    const session = await generatedSession();
    const id = attemptId();
    await failedFollowUp(session.id, FOLLOW_UP, id);

    // The retry is recorded, its path entered, and it fails again.
    await ask(session.id, FOLLOW_UP, id);
    await moveTo(session.id, 'analyzing');
    await failAt(session.id, 'followup');
    const third = await ask(session.id, FOLLOW_UP, id);

    expect(third.session.followUps).toEqual([
      { question: FOLLOW_UP, askedAt: third.askedAt, attemptId: id, attempt: 3 },
    ]);
    expect(stored(session.id).followUps).toEqual(third.session.followUps);
    expect(unwrap(h.sessions.listFollowUps(session.id))).toEqual(third.session.followUps);
  });

  it("records the retry's own wording in place, never comparing it with the failed attempt's", async () => {
    const session = await generatedSession();
    const id = attemptId();
    await failedFollowUp(session.id, FOLLOW_UP, id);

    const retried = await ask(session.id, REWORDED_FOLLOW_UP, id);

    expect(retried.session.followUps).toEqual([
      { question: REWORDED_FOLLOW_UP, askedAt: retried.askedAt, attemptId: id, attempt: 2 },
    ]);
    expect(unwrap(h.sessions.listFollowUps(session.id))).toEqual(retried.session.followUps);
  });

  it('retries in place whatever the status: the id, not the status, marks a retry', async () => {
    const session = await generatedSession();
    const id = attemptId();
    await ask(session.id, FOLLOW_UP, id);

    const retried = await ask(session.id, FOLLOW_UP, id);

    expect(retried.session.status).toBe('generated');
    expect(retried.session.followUps).toEqual([
      { question: FOLLOW_UP, askedAt: retried.askedAt, attemptId: id, attempt: 2 },
    ]);
  });
});

describe('appendFollowUp when two asks share a millisecond', () => {
  it('records two new questions asked in the same millisecond as two distinct entries', async () => {
    const session = await generatedSession();
    const firstId = attemptId();
    const secondId = attemptId();

    const first = await ask(session.id, FOLLOW_UP, firstId);
    const second = await ask(session.id, REWORDED_FOLLOW_UP, secondId, { tick: false });

    expect(second.askedAt).toBe(first.askedAt);
    const expected: FollowUpRecord[] = [
      { question: FOLLOW_UP, askedAt: first.askedAt, attemptId: firstId, attempt: 1 },
      { question: REWORDED_FOLLOW_UP, askedAt: first.askedAt, attemptId: secondId, attempt: 1 },
    ];
    expect(second.session.followUps).toEqual(expected);
    expect(unwrap(h.sessions.listFollowUps(session.id))).toEqual(expected);
  });

  it('tells a retry stamped in its failed attempt’s millisecond apart by the attempt counter', async () => {
    const session = await generatedSession();
    const id = attemptId();
    const first = await ask(session.id, FOLLOW_UP, id);

    const retried = await ask(session.id, FOLLOW_UP, id, { tick: false });

    const [entry] = retried.session.followUps;
    expect(entry?.askedAt).toBe(first.askedAt);
    expect(entry?.attempt).toBe(2);
    expect(retried.session.followUps).toHaveLength(1);
    expect(unwrap(h.sessions.listFollowUps(session.id))).toEqual(retried.session.followUps);
  });
});

describe('appendFollowUp refusals', () => {
  it.each(SINGLE_LINK_CASES)(
    'refuses to ask again an attempt answered with only $link, writing nothing',
    async ({ outcome }) => {
      const session = await generatedSession();
      const id = attemptId();
      await ask(session.id, FOLLOW_UP, id);
      await answer(session.id, outcome());
      // A later stage fails the session; the answered follow-up is not the failure.
      await moveTo(session.id, 'analyzing');
      await failAt(session.id, 'analyze');
      const before = stored(session.id);
      const framesBefore = h.frames.length;

      const refusal = await refusedAsk(session.id, FOLLOW_UP, id);

      expect(refusal.code).toBe('SESSION_INVALID_STATE');
      expect(refusal.details?.['reason']).toBe(FOLLOW_UP_ATTEMPT_REFUSALS.answered);
      expect(stored(session.id)).toEqual(before);
      expect(unwrap(h.sessions.listFollowUps(session.id))).toHaveLength(1);
      expect(h.frames.length).toBe(framesBefore);
    },
  );

  it('refuses to retry an unanswered attempt that a later follow-up followed', async () => {
    const session = await generatedSession();
    const earlierId = attemptId();
    await failedFollowUp(session.id, FOLLOW_UP, earlierId);
    await ask(session.id, REWORDED_FOLLOW_UP, attemptId());
    const before = stored(session.id);

    const refusal = await refusedAsk(session.id, FOLLOW_UP, earlierId);

    expect(refusal.code).toBe('SESSION_INVALID_STATE');
    expect(refusal.details?.['reason']).toBe(FOLLOW_UP_ATTEMPT_REFUSALS.superseded);
    expect(stored(session.id)).toEqual(before);
    expect(unwrap(h.sessions.listFollowUps(session.id))).toHaveLength(2);
  });

  it('refuses a malformed attempt id, writing nothing', async () => {
    const session = await generatedSession();

    for (const id of ['', ' ', 'fua_\u0000', 'x'.repeat(65)]) {
      const refusal = await refusedAsk(session.id, FOLLOW_UP, id);
      expect(refusal.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(refusal.details?.['reason']).toBe(FOLLOW_UP_ATTEMPT_REFUSALS.invalid);
    }
    expect(stored(session.id).followUps).toEqual([]);
    expect(unwrap(h.sessions.listFollowUps(session.id))).toEqual([]);
  });

  it('refuses any ask on an ended session', async () => {
    const session = await generatedSession();
    h.tick();
    unwrap(await h.manager.end(session.id));

    const refusal = await refusedAsk(session.id, FOLLOW_UP, attemptId());

    expect(refusal.code).toBe('SESSION_INVALID_STATE');
    expect(refusal.details?.['reason']).toBe('session-ended');
  });
});

describe('placeFollowUpAttempt — the rule itself, over a ladder', () => {
  const unanswered = (id: string): FollowUpRecord => ({
    question: FOLLOW_UP,
    askedAt: START_AT,
    attemptId: id,
    attempt: 1,
  });

  it('places an unknown id as new, a legacy entry without an id included', () => {
    const legacy: FollowUpRecord = { question: FOLLOW_UP, askedAt: START_AT };

    expect(unwrap(placeFollowUpAttempt('ses_x', [], attemptId()))).toEqual({ kind: 'new' });
    expect(unwrap(placeFollowUpAttempt('ses_x', [legacy], attemptId()))).toEqual({ kind: 'new' });
  });

  it('places the latest unanswered id as a retry of that entry', () => {
    const id = attemptId();
    const answeredEntry: FollowUpRecord = { ...unanswered(attemptId()), needsNewCapture: true };
    const latest = unanswered(id);

    expect(unwrap(placeFollowUpAttempt('ses_x', [answeredEntry, latest], id))).toEqual({
      kind: 'retry',
      index: 1,
      previous: latest,
    });
  });
});

describe('the store keeps one followups row per attempt', () => {
  it('refuses to log an attempt it already holds', async () => {
    const session = await generatedSession();
    const id = attemptId();
    await ask(session.id, FOLLOW_UP, id);

    const duplicate = h.sessions.appendFollowUp(session.id, {
      question: FOLLOW_UP,
      askedAt: h.tick(),
      attemptId: id,
      attempt: 1,
    });

    expect(isErr(duplicate) && duplicate.error.code).toBe('SESSION_INVALID_STATE');
    expect(isErr(duplicate) && duplicate.error.details?.['reason']).toBe(
      'follow-up-attempt-exists',
    );
    expect(unwrap(h.sessions.listFollowUps(session.id))).toHaveLength(1);
  });

  it('fails a retry whose row is missing rather than inserting one', async () => {
    const session = await generatedSession();

    const replaced = h.sessions.replaceFollowUpAttempt(session.id, {
      question: FOLLOW_UP,
      askedAt: h.tick(),
      attemptId: attemptId(),
      attempt: 2,
    });

    expect(isErr(replaced) && replaced.error.code).toBe('STORE_ERROR');
    expect(isErr(replaced) && replaced.error.details?.['reason']).toBe(
      'follow-up-attempt-not-found',
    );
    expect(unwrap(h.sessions.listFollowUps(session.id))).toEqual([]);
  });

  it('refuses to rewrite a row for a record that names no attempt', async () => {
    const session = await generatedSession();

    const replaced = h.sessions.replaceFollowUpAttempt(session.id, {
      question: FOLLOW_UP,
      askedAt: h.tick(),
    });

    expect(isErr(replaced) && replaced.error.details?.['reason']).toBe('invalid-follow-up');
  });
});

describe('recordFollowUpOutcome after a retry', () => {
  it('stamps the retried entry, which is then answered and refused if asked again', async () => {
    const session = await generatedSession();
    const id = attemptId();
    await failedFollowUp(session.id, FOLLOW_UP, id);
    const retried = await ask(session.id, FOLLOW_UP, id);
    const links: FollowUpOutcome = { needsNewCapture: true, planVersion: 2 };

    const answered = await answer(session.id, links);

    expect(answered.followUps).toEqual([
      { question: FOLLOW_UP, askedAt: retried.askedAt, attemptId: id, attempt: 2, ...links },
    ]);
    expect(stored(session.id)).toEqual(answered);

    // Answered now: a later failure and a new question append after it, and
    // the answered attempt itself is never asked again.
    await moveTo(session.id, 'analyzing');
    await failAt(session.id, 'analyze');
    const refusal = await refusedAsk(session.id, FOLLOW_UP, id);
    expect(refusal.details?.['reason']).toBe(FOLLOW_UP_ATTEMPT_REFUSALS.answered);
    const nextId = attemptId();
    const next = await ask(session.id, REWORDED_FOLLOW_UP, nextId);
    expect(next.session.followUps).toEqual([
      { question: FOLLOW_UP, askedAt: retried.askedAt, attemptId: id, attempt: 2, ...links },
      { question: REWORDED_FOLLOW_UP, askedAt: next.askedAt, attemptId: nextId, attempt: 1 },
    ]);
  });
});

describe('privacy', () => {
  it('logs counts, attempt counters and refusal reasons, never the question', async () => {
    const question = `${FOLLOW_UP} ${SENTINEL}`;
    const session = await generatedSession();
    const id = attemptId();
    await failedFollowUp(session.id, question, id);

    await ask(session.id, question, id);
    await answer(session.id, { needsNewCapture: false });
    await refusedAsk(session.id, question, id);

    expect(h.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);
  });
});
