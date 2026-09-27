/**
 * Tests for `./manager.ts`'s follow-up ladder: {@link SessionManager.appendFollowUp},
 * {@link placeFollowUpAttempt} and {@link SessionManager.recordFollowUpOutcome};
 * for how {@link SessionManager.end} stores `ended` with the tab binding's
 * removal; and for how {@link SessionManager.confirmProjectRoot} holds the
 * pipeline's sinks to the identity a session's root was admitted under.
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
 * 7. **One store unit per ask and per outcome**: the `followups` row and the
 *    ladder entry that mirrors it are written together, so a record write the
 *    store refuses leaves both views as they were, broadcasts nothing, and
 *    asking or stamping again then succeeds. An outcome reaches the row as
 *    well as the ladder — found by its attempt id, or, for an entry stored
 *    without one, as the session's newest row only when it is provably the
 *    same entry — and a row the log lost or disagrees on refuses the stamp.
 * 8. **`end` and the tab binding**: `ended` is stored together with the
 *    removal of the session's `bindings` row, so a refused removal leaves the
 *    session open and bound and ending again ends it unbound; ending an ended
 *    session removes a row an earlier build left behind, and answers the
 *    store's error when it cannot.
 * 9. **Privacy**: no log record carries the question.
 * 10. **The project root's identity**: a session created with an admission
 *    proof is stored with its canonical path and confirmed as that proof while
 *    its root resolves to it, and refused once a link on the root is
 *    retargeted, even inside the same tree; a proof for another root, or one
 *    the store cannot record, refuses the create with nothing stored; a
 *    session with no recorded identity is refused at every sink and never
 *    identified. Across a restart — the store closed and reopened on the same
 *    file, a new manager over it — a session is held to the identity stored
 *    with it: confirmed while its root is unmoved, refused when the link was
 *    retargeted while the service was down, refused (fail closed) when the
 *    store holds no identity for it, and refused with the store's error when
 *    that identity cannot be read. An unknown id, an unreadable record and an
 *    ended session are refused, the ended one's identity released. These cases
 *    stage real symbolic links in the case's sandbox, and no log record names
 *    a path.
 *
 * The store is the real one — `openStore` against a file in a private `mkdtemp`
 * sandbox, never `:memory:` — and so are the sessions repository and the
 * progress emitter over it, so the record each case reads back is the one the
 * service would replay. Only the broadcaster is substituted, by a recorder, and
 * no cleanup runner is injected; a store failure is a real one, raised by a
 * temporary trigger on the case's own connection
 * ({@link withRefusedWrites}). Statuses are driven through the manager's own
 * API along legal edges of `./state-machine.ts`; the clock is injected and
 * advanced explicitly, so every `askedAt` is predictable — distinct unless a
 * case holds it still on purpose. No environment variable is read, no socket
 * is opened and no case depends on another having run.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
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
import {
  isErr,
  newAnalysisId,
  newCaptureId,
  newId,
  newPanelId,
  newSessionId,
  unwrap,
} from '@debuggen/shared';
import type {
  DebuggenError,
  LogFields,
  LogLevel,
  Logger,
  Result,
  SessionId,
} from '@debuggen/shared';
import { SECURE_DIR_MODE } from '@debuggen/shared/node';

import { identifyProjectRoot } from '../server/auth.js';
import type { AdmittedProjectRoot } from '../server/auth.js';
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

/**
 * Asserts that the two durable views of the session's follow-ups — the
 * `followups` log `listFollowUps` reads and the record's ladder — hold one
 * history, and answers it.
 */
function oneHistory(sessionId: SessionId): readonly FollowUpRecord[] {
  const ladder = stored(sessionId).followUps;
  expect(unwrap(h.sessions.listFollowUps(sessionId))).toEqual(ladder);
  return ladder;
}

/** The writes {@link withRefusedWrites} can make the store refuse for one session. */
type RefusedWrite = 'record' | 'binding';

/** The trigger event and the row guard of each {@link RefusedWrite}. */
const REFUSED_WRITE_TRIGGERS: Readonly<
  Record<RefusedWrite, { readonly event: string; readonly column: string }>
> = Object.freeze({
  record: { event: 'UPDATE ON sessions', column: 'id' },
  binding: { event: 'DELETE ON bindings', column: 'session_id' },
});

/** The shape of every session id the manager mints, checked before one is spelled into DDL. */
const INJECTABLE_ID = /^[A-Za-z0-9_-]+$/u;

/** How many faults this file has injected, so every trigger name is unique. */
let injectedFaults = 0;

/**
 * Runs `body` while a temporary trigger on the case's own store connection
 * refuses one kind of write for one session — a real failure of the store's
 * statement, not a stub: `record` aborts every update of the session's
 * `sessions` row (the write behind every record change), `binding` every
 * delete of its `bindings` row. The trigger is dropped whatever `body` does,
 * so the retry after it meets a writable store.
 */
async function withRefusedWrites<T>(
  sessionId: SessionId,
  write: RefusedWrite,
  body: () => Promise<T>,
): Promise<T> {
  if (!INJECTABLE_ID.test(sessionId)) {
    throw new Error('A session id with unexpected characters cannot be named in a trigger.');
  }
  injectedFaults += 1;
  const trigger = `manager_suite_refuse_${write}_${String(injectedFaults)}`;
  const { event, column } = REFUSED_WRITE_TRIGGERS[write];
  h.store.db.exec(
    `CREATE TEMP TRIGGER ${trigger} BEFORE ${event} WHEN OLD.${column} = '${sessionId}'
     BEGIN SELECT RAISE(ABORT, 'injected ${write} write failure'); END`,
  );
  try {
    return await body();
  } finally {
    h.store.db.exec(`DROP TRIGGER IF EXISTS temp.${trigger}`);
  }
}

/** The manager's `error` record for an ask neither of whose writes was stored. */
const FOLLOW_UP_NOT_RECORDED_LOG =
  'a follow-up could not be recorded; neither its follow-up row nor the session record was stored';

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

describe('appendFollowUp stores the followups row and the record as one unit', () => {
  it('rolls a new follow-up row back when the record cannot mirror it; the same ask then records it once', async () => {
    const session = await generatedSession();
    const id = attemptId();
    const before = stored(session.id);
    const framesBefore = h.frames.length;

    const refusal = await withRefusedWrites(session.id, 'record', () =>
      refusedAsk(session.id, FOLLOW_UP, id),
    );

    expect(refusal.code).toBe('STORE_ERROR');
    expect(stored(session.id)).toEqual(before);
    expect(oneHistory(session.id)).toEqual([]);
    expect(h.frames.length).toBe(framesBefore);
    expect(
      h.logs.filter((log) => log.level === 'error' && log.message === FOLLOW_UP_NOT_RECORDED_LOG),
    ).toHaveLength(1);

    // Nothing of the refused ask survived, so asking again is a first ask.
    const asked = await ask(session.id, FOLLOW_UP, id);

    expect(asked.session.followUps).toEqual([
      { question: FOLLOW_UP, askedAt: asked.askedAt, attemptId: id, attempt: 1 },
    ]);
    expect(oneHistory(session.id)).toEqual(asked.session.followUps);
    expect(lastUpdated(session.id)).toEqual(asked.session);
  });

  it('keeps the failed attempt’s row as it was when the record cannot mirror its retry; the retry then records attempt 2', async () => {
    const session = await generatedSession();
    const id = attemptId();
    const failed = await failedFollowUp(session.id, FOLLOW_UP, id);
    const before = stored(session.id);
    const framesBefore = h.frames.length;

    const refusal = await withRefusedWrites(session.id, 'record', () =>
      refusedAsk(session.id, REWORDED_FOLLOW_UP, id),
    );

    expect(refusal.code).toBe('STORE_ERROR');
    expect(stored(session.id)).toEqual(before);
    // The row the retry rewrote inside the unit is back to attempt 1.
    expect(oneHistory(session.id)).toEqual([
      { question: FOLLOW_UP, askedAt: failed.askedAt, attemptId: id, attempt: 1 },
    ]);
    expect(h.frames.length).toBe(framesBefore);

    const retried = await ask(session.id, REWORDED_FOLLOW_UP, id);

    expect(retried.session.followUps).toEqual([
      { question: REWORDED_FOLLOW_UP, askedAt: retried.askedAt, attemptId: id, attempt: 2 },
    ]);
    expect(oneHistory(session.id)).toEqual(retried.session.followUps);
    expect(lastUpdated(session.id)).toEqual(retried.session);
  });
});

describe('recordFollowUpOutcome stamps the followups row and the record as one unit', () => {
  /** Every outcome link at once, each freshly minted. */
  const allLinks = (): FollowUpOutcome => ({
    needsNewCapture: true,
    planVersion: 2,
    captureId: newCaptureId(),
    analysisId: newAnalysisId(),
    panelId: newPanelId(),
  });

  /**
   * Gives the session's ladder one entry without an attempt id, as a build
   * before attempts carried an identity stored it, and logs `row` — the same
   * entry, a disagreeing one, or none — beside it.
   */
  function withLegacyEntry(
    sessionId: SessionId,
    entry: FollowUpRecord,
    row: FollowUpRecord | undefined,
  ): void {
    if (row !== undefined) {
      unwrap(h.sessions.appendFollowUp(sessionId, row));
    }
    unwrap(h.sessions.update({ ...stored(sessionId), followUps: [entry], updatedAt: h.tick() }));
  }

  it('writes every outcome link to the followups row as well as the ladder', async () => {
    const session = await generatedSession();
    const id = attemptId();
    const asked = await ask(session.id, FOLLOW_UP, id);
    const links = allLinks();

    const answered = await answer(session.id, links);

    const expected: FollowUpRecord[] = [
      { question: FOLLOW_UP, askedAt: asked.askedAt, attemptId: id, attempt: 1, ...links },
    ];
    expect(answered.followUps).toEqual(expected);
    expect(oneHistory(session.id)).toEqual(expected);
    expect(lastUpdated(session.id)).toEqual(answered);
  });

  it('changes neither view when the record cannot take the outcome; stamping again then writes both', async () => {
    const session = await generatedSession();
    const asked = await ask(session.id, FOLLOW_UP, attemptId());
    const before = stored(session.id);
    const framesBefore = h.frames.length;
    const links = allLinks();

    const refused = await withRefusedWrites(session.id, 'record', () => {
      h.tick();
      return h.manager.recordFollowUpOutcome(session.id, links);
    });

    expect(isErr(refused) && refused.error.code).toBe('STORE_ERROR');
    expect(stored(session.id)).toEqual(before);
    // The row the unit stamped first is back to the unanswered ask.
    expect(oneHistory(session.id)).toEqual(asked.session.followUps);
    expect(h.frames.length).toBe(framesBefore);

    const answered = await answer(session.id, links);

    expect(answered.followUps).toEqual(
      asked.session.followUps.map((entry) => ({ ...entry, ...links })),
    );
    expect(oneHistory(session.id)).toEqual(answered.followUps);
  });

  it('refuses to stamp an identified entry whose row the log lost, changing nothing', async () => {
    const session = await generatedSession();
    await ask(session.id, FOLLOW_UP, attemptId());
    h.store.statement('DELETE FROM followups WHERE session_id = ?').run(session.id);
    const before = stored(session.id);
    const framesBefore = h.frames.length;

    h.tick();
    const refused = await h.manager.recordFollowUpOutcome(session.id, allLinks());

    expect(isErr(refused) && refused.error.code).toBe('STORE_ERROR');
    expect(isErr(refused) && refused.error.details?.['reason']).toBe('follow-up-attempt-not-found');
    expect(stored(session.id)).toEqual(before);
    expect(unwrap(h.sessions.listFollowUps(session.id))).toEqual([]);
    expect(h.frames.length).toBe(framesBefore);
  });

  it('stamps a legacy entry without an attempt id in both views', async () => {
    const session = await generatedSession();
    const legacy: FollowUpRecord = { question: FOLLOW_UP, askedAt: h.tick() };
    withLegacyEntry(session.id, legacy, legacy);
    const links = allLinks();

    const answered = await answer(session.id, links);

    expect(answered.followUps).toEqual([{ ...legacy, ...links }]);
    expect(oneHistory(session.id)).toEqual(answered.followUps);
  });

  it.each([
    {
      log: 'a newest row asked at another instant',
      row: (entry: FollowUpRecord): FollowUpRecord | undefined => ({
        ...entry,
        askedAt: entry.askedAt + 1,
      }),
      reason: 'follow-up-log-disagrees',
    },
    {
      log: 'a newest row that carries an attempt id',
      row: (entry: FollowUpRecord): FollowUpRecord | undefined => ({
        ...entry,
        attemptId: attemptId(),
        attempt: 1,
      }),
      reason: 'follow-up-log-disagrees',
    },
    {
      log: 'no row',
      row: (): FollowUpRecord | undefined => undefined,
      reason: 'follow-up-not-found',
    },
  ])('refuses a legacy entry against $log, changing neither view', async ({ row, reason }) => {
    const session = await generatedSession();
    const legacy: FollowUpRecord = { question: FOLLOW_UP, askedAt: h.tick() };
    withLegacyEntry(session.id, legacy, row(legacy));
    const before = stored(session.id);
    const rowsBefore = unwrap(h.sessions.listFollowUps(session.id));
    const framesBefore = h.frames.length;

    h.tick();
    const refused = await h.manager.recordFollowUpOutcome(session.id, allLinks());

    expect(isErr(refused) && refused.error.code).toBe('STORE_ERROR');
    expect(isErr(refused) && refused.error.details?.['reason']).toBe(reason);
    expect(stored(session.id)).toEqual(before);
    expect(unwrap(h.sessions.listFollowUps(session.id))).toEqual(rowsBefore);
    expect(h.frames.length).toBe(framesBefore);
  });
});

describe('end removes the tab binding in the transaction that stores `ended`', () => {
  /** The inspected tab every case binds. */
  const TAB = Object.freeze({ tabId: 7, url: `${DEV_SERVER_URL}/` });

  /** Binds the tab to the session in both durable views, as the binding route does. */
  async function bindTab(sessionId: SessionId): Promise<void> {
    unwrap(h.sessions.upsertBinding({ tabId: TAB.tabId, sessionId, url: TAB.url }));
    h.tick();
    unwrap(await h.manager.setBoundTab(sessionId, TAB));
  }

  /** The tab the store's `bindings` table binds to the session, if any. */
  function boundInStore(sessionId: SessionId): unknown {
    return unwrap(h.sessions.getBindingBySession(sessionId))?.tab;
  }

  /** Ends a session whose end must succeed. */
  async function endNow(sessionId: SessionId): Promise<SessionRecord> {
    h.tick();
    return unwrap(await h.manager.end(sessionId)).session;
  }

  it('keeps the session open and bound when the binding cannot be removed; ending again ends it unbound', async () => {
    const session = await generatedSession();
    await bindTab(session.id);
    const framesBefore = h.frames.length;

    const refused = await withRefusedWrites(session.id, 'binding', () => {
      h.tick();
      return h.manager.end(session.id);
    });

    expect(isErr(refused) && refused.error.code).toBe('STORE_ERROR');
    const open = stored(session.id);
    expect(open.status).toBe('generated');
    expect(open.boundTab).toEqual(TAB);
    expect(boundInStore(session.id)).toEqual(TAB);
    // The rolled-back move was never announced.
    expect(
      h.frames
        .slice(framesBefore)
        .filter(
          (frame) =>
            frame.message.type === 'session.updated' &&
            frame.message.payload.session.status === 'ended',
        ),
    ).toEqual([]);

    const ended = await endNow(session.id);

    expect(ended.status).toBe('ended');
    expect(ended.boundTab).toBeUndefined();
    expect(stored(session.id)).toEqual(ended);
    expect(boundInStore(session.id)).toBeUndefined();
    expect(lastUpdated(session.id)).toEqual(ended);
  });

  it('removes a binding row an earlier build left on an ended session, re-running nothing else', async () => {
    const session = await generatedSession();
    const ended = await endNow(session.id);
    // What an earlier build could leave behind: `ended` stored, the row not removed.
    unwrap(h.sessions.upsertBinding({ tabId: TAB.tabId, sessionId: session.id, url: TAB.url }));
    const framesBefore = h.frames.length;

    const again = unwrap(await h.manager.end(session.id));

    expect(again.session).toEqual(ended);
    expect(stored(session.id)).toEqual(ended);
    expect(boundInStore(session.id)).toBeUndefined();
    expect(h.frames.length).toBe(framesBefore);
  });

  it('answers the store’s error when that residual row cannot be removed; ending again removes it', async () => {
    const session = await generatedSession();
    const ended = await endNow(session.id);
    unwrap(h.sessions.upsertBinding({ tabId: TAB.tabId, sessionId: session.id, url: TAB.url }));

    const refused = await withRefusedWrites(session.id, 'binding', () => h.manager.end(session.id));

    expect(isErr(refused) && refused.error.code).toBe('STORE_ERROR');
    expect(stored(session.id)).toEqual(ended);
    expect(boundInStore(session.id)).toEqual(TAB);

    expect(unwrap(await h.manager.end(session.id)).session).toEqual(ended);
    expect(boundInStore(session.id)).toBeUndefined();
  });
});

describe('confirmProjectRoot holds every sink to the identity the root was admitted under', () => {
  /** The refusal the access boundary answers a root that now resolves elsewhere with. */
  const MOVED_MESSAGE = 'The project root no longer resolves to the directory it was admitted as.';
  const MOVED_HINT =
    'The project folder, or a link on its path, was moved or relinked after it was admitted. Start a new session, or launch the dev server again, from the folder in VS Code.';

  /** The refusal a sink is answered for a session with no recorded identity (fail closed). */
  const UNRECORDED_MESSAGE = "No admitted identity is recorded for this session's project root.";
  const UNRECORDED_HINT =
    'This session was stored without a record of the directory its project root was admitted as, so it can no longer be indexed or instrumented. Start a new session from the folder in VS Code.';

  /** The `warn` record of every refused confirmation. */
  const REFUSED_LOG = 'the project root could not be confirmed for a sink';

  /** The `debug` record of an identity released with its session. */
  const RELEASED_LOG = 'the project root identity of the session was released';

  /**
   * A real tree in the case's canonical sandbox: the session's root is `web`,
   * a symbolic link to `packages/web`; `packages/api` is another directory
   * inside the same tree for the link to be retargeted to.
   */
  function linkedRoot(): {
    readonly root: string;
    readonly target: string;
    readonly elsewhere: string;
  } {
    const tree = join(h.root, 'shop');
    const target = join(tree, 'packages', 'web');
    const elsewhere = join(tree, 'packages', 'api');
    mkdirSync(target, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const root = join(tree, 'web');
    symlinkSync(target, root, 'dir');
    return { root, target, elsewhere };
  }

  /** Points the link at `to`, as a process that can write inside the workspace could. */
  function retarget(link: string, to: string): void {
    unlinkSync(link);
    symlinkSync(to, link, 'dir');
  }

  /** Creates a session on `projectRoot`, handed `admittedRoot` when one is given. */
  async function createOn(
    projectRoot: string,
    admittedRoot?: AdmittedProjectRoot,
  ): Promise<Result<SessionRecord, DebuggenError>> {
    h.tick();
    return h.manager.create({
      projectRoot,
      question: SESSION_QUESTION,
      devServerUrl: DEV_SERVER_URL,
      provider: { id: 'deterministic' },
      ...(admittedRoot === undefined ? {} : { admittedRoot }),
    });
  }

  /** Asserts `result` is a refusal with `code`, and answers it. */
  function refusal<T>(
    result: Result<T, DebuggenError>,
    code: DebuggenError['code'],
  ): DebuggenError {
    if (!isErr(result)) {
      throw new Error(`expected a ${code} refusal, got Ok`);
    }
    expect(result.error.code).toBe(code);
    return result.error;
  }

  /** The records the manager logged with `message` for `sessionId`. */
  function logged(message: string, sessionId: SessionId): readonly CapturedLog[] {
    return h.logs.filter((log) => log.message === message && log.fields['sessionId'] === sessionId);
  }

  /**
   * Asserts that no log record names the project tree {@link linkedRoot}
   * builds. (The store logs its own database path, which sits in the same
   * sandbox, so the sandbox itself is not the needle.)
   */
  function expectNoPathLogged(): void {
    expect(JSON.stringify(h.logs)).not.toContain(join(h.root, 'shop'));
  }

  /** Every identity row the case's store holds, by session id. */
  function storedIdentities(): readonly Record<string, unknown>[] {
    return h.store.db
      .prepare('SELECT session_id, canonical_root FROM session_root_identities ORDER BY session_id')
      .all();
  }

  it('answers the admitted identity synchronously while the root resolves to it, and refuses a retargeted root', async () => {
    const { root, target, elsewhere } = linkedRoot();
    const admitted = unwrap(identifyProjectRoot(root));
    const session = unwrap(await createOn(root, admitted));

    const answer = h.manager.confirmProjectRoot(session.id);
    // A plain Result, not a promise: the sink acts in the turn it was proven in.
    expect(answer).not.toBeInstanceOf(Promise);
    const confirmed = unwrap(answer);
    expect(confirmed).toBe(admitted);
    expect(confirmed.canonicalRoot).toBe(target);
    // Stored with the session at create, not established at the first sink.
    expect(unwrap(h.sessions.getRootIdentity(session.id))).toBe(target);

    // Retargeted to another directory inside the same tree after the session
    // was admitted: a scope check would still pass, the identity does not.
    retarget(root, elsewhere);
    const moved = refusal(h.manager.confirmProjectRoot(session.id), 'PATH_OUTSIDE_PROJECT');
    expect(moved.message).toBe(MOVED_MESSAGE);
    expect(moved.hint).toBe(MOVED_HINT);
    expect(moved.details).toEqual({ reason: 'project-out-of-scope' });
    expect(
      logged(REFUSED_LOG, session.id).map((log) => [log.level, log.fields['code']] as const),
    ).toEqual([['warn', 'PATH_OUTSIDE_PROJECT']]);

    // Pointed back where it was admitted, it is the same directory again.
    retarget(root, target);
    expect(unwrap(h.manager.confirmProjectRoot(session.id))).toBe(admitted);
    expectNoPathLogged();
  });

  it('refuses a create handed a proof for another root, storing and announcing nothing', async () => {
    const { root, elsewhere } = linkedRoot();
    const foreign = unwrap(identifyProjectRoot(elsewhere));

    const mismatch = refusal(await createOn(root, foreign), 'INTERNAL');

    expect(mismatch.details).toEqual({ reason: 'admitted-root-mismatch' });
    expect(unwrap(h.manager.list())).toEqual([]);
    expect(storedIdentities()).toEqual([]);
    expect(h.frames).toEqual([]);
    expectNoPathLogged();

    // A proof for the same root in another spelling names it, and is accepted.
    const admitted = unwrap(identifyProjectRoot(root));
    const session = unwrap(await createOn(`${root}/./`, admitted));
    expect(session.projectRoot).toBe(root);
    expect(unwrap(h.manager.confirmProjectRoot(session.id))).toBe(admitted);

    // A proof the caller could still change is recorded as a frozen copy, so
    // mutating it after the create moves nothing the sinks are held to.
    const mutable: { projectRoot: string; canonicalRoot: string } = { ...admitted };
    const held = unwrap(await createOn(root, mutable));
    mutable.canonicalRoot = elsewhere;
    const recorded = unwrap(h.manager.confirmProjectRoot(held.id));
    expect(recorded).toStrictEqual(admitted);
    expect(Object.isFrozen(recorded)).toBe(true);
    // The stored identity is that same, unmutated copy.
    expect(unwrap(h.sessions.getRootIdentity(held.id))).toBe(admitted.canonicalRoot);
  });

  it('refuses a create whose identity the store cannot record, storing, caching and announcing nothing', async () => {
    const { root } = linkedRoot();
    const trigger = 'manager_suite_refuse_root_identity';
    h.store.db.exec(
      `CREATE TEMP TRIGGER ${trigger} BEFORE INSERT ON session_root_identities
       BEGIN SELECT RAISE(ABORT, 'injected identity write failure'); END`,
    );

    let refused: DebuggenError;
    try {
      refused = refusal(await createOn(root, unwrap(identifyProjectRoot(root))), 'STORE_ERROR');
    } finally {
      h.store.db.exec(`DROP TRIGGER IF EXISTS temp.${trigger}`);
    }

    // The session went with its identity: neither is stored, nothing announced.
    expect(refused.details).toMatchObject({ reason: 'store-failed' });
    expect(unwrap(h.manager.list())).toEqual([]);
    expect(storedIdentities()).toEqual([]);
    expect(h.frames).toEqual([]);
    expectNoPathLogged();
  });

  it('refuses every sink of a session created without a proof, and never identifies its root', async () => {
    const { root } = linkedRoot();
    const session = unwrap(await createOn(root));

    // The root resolves exactly where it did at create; with no identity
    // recorded for it, that is still no proof.
    for (let sink = 0; sink < 2; sink += 1) {
      const refused = refusal(h.manager.confirmProjectRoot(session.id), 'PATH_OUTSIDE_PROJECT');
      expect(refused.message).toBe(UNRECORDED_MESSAGE);
      expect(refused.hint).toBe(UNRECORDED_HINT);
      expect(refused.details).toEqual({ reason: 'project-out-of-scope' });
    }

    // Nothing was stored or cached in its place: each sink asked again, and
    // each refusal was logged by its code only.
    expect(unwrap(h.sessions.getRootIdentity(session.id))).toBeUndefined();
    expect(
      logged(REFUSED_LOG, session.id).map((log) => [log.level, log.fields['code']] as const),
    ).toEqual([
      ['warn', 'PATH_OUTSIDE_PROJECT'],
      ['warn', 'PATH_OUTSIDE_PROJECT'],
    ]);
    expectNoPathLogged();
  });

  describe('across a restart, over the same store file', () => {
    /** One restarted process: its own store handle on the case's file, and the repository and manager over it. */
    interface Restarted {
      readonly store: Store;
      readonly sessions: SessionsRepo;
      readonly manager: SessionManager;
    }

    /** The store handles the restarts opened, closed after each case. */
    const reopened: Store[] = [];

    afterEach(() => {
      for (const store of reopened.splice(0)) {
        if (!store.isClosed) {
          store.close();
        }
      }
    });

    /**
     * Restarts the service over the case's store, as a process restart does:
     * the first handle is closed, the same database file is opened again, and
     * a new repository, progress emitter and manager are built over it and
     * hydrated. Nothing held in memory crosses over — only the file does.
     */
    async function restart(): Promise<Restarted> {
      const databasePath = h.store.path;
      h.store.close();

      const logger = createCapturingLogger(h.logs);
      const store = unwrap(openStore({ databasePath, logger }));
      reopened.push(store);
      const now = (): number => h.now();
      const sessions = createSessionsRepo({ store, logger, now });
      const broadcaster = createRecordingBroadcaster([]);
      const progress = createSessionProgress({ sessions, broadcaster, logger, now });
      const manager = createSessionManager({ sessions, broadcaster, progress, logger, now });
      unwrap(await manager.hydrate());

      return { store, sessions, manager };
    }

    /** Creates a session on the linked root, handed the proof the create route hands over. */
    async function admittedSession(root: string): Promise<SessionRecord> {
      return unwrap(await createOn(root, unwrap(identifyProjectRoot(root))));
    }

    it('confirms an unmoved root as the canonical path stored with the session', async () => {
      const { root, target } = linkedRoot();
      const session = await admittedSession(root);

      const restarted = await restart();
      const confirmed = unwrap(restarted.manager.confirmProjectRoot(session.id));

      expect(confirmed).toStrictEqual({ projectRoot: root, canonicalRoot: target });
      expect(Object.isFrozen(confirmed)).toBe(true);
      expect(unwrap(restarted.sessions.getRootIdentity(session.id))).toBe(target);
      // Cached from the store: the next sink is answered with the same object.
      expect(unwrap(restarted.manager.confirmProjectRoot(session.id))).toBe(confirmed);
      expect(logged(REFUSED_LOG, session.id)).toEqual([]);
      expectNoPathLogged();
    });

    it('refuses a root whose link was retargeted while the service was down', async () => {
      const { root, target, elsewhere } = linkedRoot();
      const session = await admittedSession(root);

      // Retargeted inside the same tree before the next process starts: no
      // process was running to see it, and a scope check would still pass.
      retarget(root, elsewhere);
      const restarted = await restart();

      const moved = refusal(
        restarted.manager.confirmProjectRoot(session.id),
        'PATH_OUTSIDE_PROJECT',
      );
      expect(moved.message).toBe(MOVED_MESSAGE);
      expect(moved.hint).toBe(MOVED_HINT);
      expect(moved.details).toEqual({ reason: 'project-out-of-scope' });
      // Held to the stored identity, never to where the link leads now.
      expect(unwrap(restarted.sessions.getRootIdentity(session.id))).toBe(target);
      refusal(restarted.manager.confirmProjectRoot(session.id), 'PATH_OUTSIDE_PROJECT');

      // Pointed back where it was admitted, it is the same directory again.
      retarget(root, target);
      expect(unwrap(restarted.manager.confirmProjectRoot(session.id)).canonicalRoot).toBe(target);
      expect(
        logged(REFUSED_LOG, session.id).map((log) => [log.level, log.fields['code']] as const),
      ).toEqual([
        ['warn', 'PATH_OUTSIDE_PROJECT'],
        ['warn', 'PATH_OUTSIDE_PROJECT'],
      ]);
      expectNoPathLogged();
    });

    it('fails closed for a session the store holds no identity for, as a store written before identities were recorded holds it', async () => {
      const { root } = linkedRoot();
      const session = await admittedSession(root);
      // What a build before schema version 6 left behind: the session, admitted
      // by a process that kept its proof in memory, and no identity row.
      h.store.db
        .prepare('DELETE FROM session_root_identities WHERE session_id = ?')
        .run(session.id);

      const restarted = await restart();

      // The root is unmoved, and still refused: nothing proves it is.
      for (let sink = 0; sink < 2; sink += 1) {
        const refused = refusal(
          restarted.manager.confirmProjectRoot(session.id),
          'PATH_OUTSIDE_PROJECT',
        );
        expect(refused.message).toBe(UNRECORDED_MESSAGE);
        expect(refused.hint).toBe(UNRECORDED_HINT);
        expect(refused.details).toEqual({ reason: 'project-out-of-scope' });
      }
      expect(unwrap(restarted.sessions.getRootIdentity(session.id))).toBeUndefined();
      expect(
        logged(REFUSED_LOG, session.id).map((log) => [log.level, log.fields['code']] as const),
      ).toEqual([
        ['warn', 'PATH_OUTSIDE_PROJECT'],
        ['warn', 'PATH_OUTSIDE_PROJECT'],
      ]);
      expectNoPathLogged();
    });

    it('refuses with the store’s error when the stored identity cannot be read, and caches nothing', async () => {
      const { root, target } = linkedRoot();
      const session = await admittedSession(root);
      const restarted = await restart();

      // A real read failure on the restarted connection: the table the
      // repository reads is renamed away for the duration of the sink.
      restarted.store.db.exec('ALTER TABLE session_root_identities RENAME TO identities_away');
      let failed: DebuggenError;
      try {
        failed = refusal(restarted.manager.confirmProjectRoot(session.id), 'STORE_ERROR');
      } finally {
        restarted.store.db.exec('ALTER TABLE identities_away RENAME TO session_root_identities');
      }

      expect(failed.details).toMatchObject({ reason: 'store-failed' });
      expect(
        logged(REFUSED_LOG, session.id).map((log) => [log.level, log.fields['code']] as const),
      ).toEqual([['warn', 'STORE_ERROR']]);

      // Nothing was cached in the refusal's place: once readable, the stored
      // identity holds the sink again.
      expect(unwrap(restarted.manager.confirmProjectRoot(session.id)).canonicalRoot).toBe(target);
      expectNoPathLogged();
    });
  });

  it('answers SESSION_NOT_FOUND for an unknown id, and passes a store failure through', async () => {
    const unknown = newSessionId();
    refusal(h.manager.confirmProjectRoot(unknown), 'SESSION_NOT_FOUND');
    expect(
      logged('the project root could not be confirmed for a sink', unknown).map(
        (log) => log.fields['code'],
      ),
    ).toEqual(['SESSION_NOT_FOUND']);

    const { root } = linkedRoot();
    const session = unwrap(await createOn(root, unwrap(identifyProjectRoot(root))));
    // A stored document the repository can no longer read back.
    h.store.db.prepare('UPDATE sessions SET record = ? WHERE id = ?').run('{', session.id);
    refusal(h.manager.confirmProjectRoot(session.id), 'STORE_ERROR');
    expectNoPathLogged();
  });

  it('refuses an ended session with SESSION_INVALID_STATE, its identity released at the end', async () => {
    const { root } = linkedRoot();
    const admitted = unwrap(identifyProjectRoot(root));
    const session = unwrap(await createOn(root, admitted));
    expect(unwrap(h.manager.confirmProjectRoot(session.id))).toBe(admitted);

    h.tick();
    expect(unwrap(await h.manager.end(session.id)).session.status).toBe('ended');

    expect(
      logged(RELEASED_LOG, session.id).map((log) => [log.level, log.fields['operation']] as const),
    ).toEqual([['debug', 'end']]);
    const ended = refusal(h.manager.confirmProjectRoot(session.id), 'SESSION_INVALID_STATE');
    expect(ended.details).toMatchObject({ reason: 'session-ended' });
    // Nothing was left to release: the entry went with the end.
    expect(unwrap(await h.manager.end(session.id)).session.status).toBe('ended');
    expect(logged(RELEASED_LOG, session.id)).toHaveLength(1);
    expectNoPathLogged();
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
