/**
 * Reopening a stored session: the path that brings a past debugging session
 * back to life in both user interfaces **from stored data only**.
 *
 * AAP §0.4.2: reopening a session is `GET /sessions/:id` from the editor's
 * Sessions tree, and the service replays `session.updated` and the latest
 * `panel.generated` to connected clients so the panel re-renders from stored
 * data. This module is that replay, and nothing more.
 *
 * ## Invariants (binding on every change to this file)
 *
 * 1. **Reopening writes nothing.** No status transition — neither the
 *    manager's appliers nor the state machine's `transition` is called — no
 *    progress row appended, no record mutated, no capture opened, no plan
 *    stored, no project file touched. The dependencies are typed as `Pick`s of
 *    the repositories' read methods, so a write is not even expressible here.
 *    `isTerminalSessionStatus` is consulted only to *annotate* the result and
 *    the log (an `ended` session is reopened read-only); reopening never
 *    resurrects a session.
 * 2. **Reopening recomputes nothing.** No pipeline stage runs, no model
 *    provider is called, no telemetry is correlated or aggregated, no panel is
 *    re-validated against its capture and no code is re-indexed. The panel's
 *    node data is fetched lazily by the panel itself through
 *    `POST /sessions/:id/panel-data`, and a fallback panel (`meta.fallback`)
 *    replays as the legitimate success it was when it was generated. That is
 *    why this module imports nothing from `../pipeline/**`, `../panels/**`,
 *    `../telemetry/**`, `../server/**`, `@debuggen/model-provider`,
 *    `@debuggen/code-analysis`, `hono`, `ws` or `node:*`.
 * 3. **A stored artifact that fails validation is skipped — never repaired and
 *    never faked.** The repositories validate on read, and every artifact is
 *    validated once more here against the exact payload schema of the frame
 *    that will carry it, so a frame this module sends is one every receiver
 *    accepts. A rejection means corrupt storage: it is logged at `warn` with
 *    the artifact kind, its id and the error code only — never the rejected
 *    value (AAP §0.5.2) — its kind is added to
 *    {@link ReopenedSession.skipped}, and **the rest still replays**, because
 *    the record and the progress history must reach the user interface. A
 *    corrupt panel is not broadcast, and its absence is what makes the panel
 *    surface show its empty state rather than an answer nobody produced.
 * 4. **Only what a client already saw is sent.** The session record never
 *    carries a credential, and the per-session request-key secret
 *    (`SessionsRepo.getOrCreateRequestKeySecret`, the `session_keys` table) is
 *    never read, replayed or logged: the dependency type does not admit it.
 * 5. **Stored artifacts are opaque.** Nothing here branches on the developer's
 *    question, a component name, a route or a panel title (AAP §0.5.4).
 *
 * ## The replay, in its fixed order
 *
 * Each frame is built with protocol's `createEnvelope` and delivered through
 * the {@link SessionBroadcaster} port the manager declares — `broadcast` to
 * every client of the session, or `broadcastToKinds` when the caller named
 * kinds:
 *
 * | # | Frame | When | Why here |
 * | - | ----- | ---- | -------- |
 * | 1 | `session.updated { session }` | always | a client holds the session before anything referring to it arrives |
 * | 2 | `session.progress`, one per stored row, in stored order | when rows exist | the same rows the live session showed — a `failed` row is the **only** carrier of the failing stage, since protocol's `SessionRecord` has no failure field (AAP §0.5.5) |
 * | 3 | `analysis.completed { sessionId, analysis }` | when a latest analysis exists | the observed facts and likely causes |
 * | 4 | `panel.generated { sessionId, panelId, panel }` | when a latest panel exists | the panel re-renders from stored data |
 *
 * A session with no analysis and no panel (status `created` … `ready`)
 * replays steps 1–2 only; that is correct, not an error. Panels and analyses
 * are append-only version ladders in `../store/panels-repo.ts` — nothing is
 * ever mutated in place — so the latest of each is exactly what the developer
 * was last shown, and panel versioning travels inside the specification's own
 * `panelVersion` / `supersedes` fields.
 *
 * A progress row keeps the timestamp it was stored with, which is the
 * timestamp its live frame carried (`./progress.ts` shares one stamp between
 * the stored row and the broadcast), so a reopened progress view shows the
 * same times the live one did. The other three frames are stamped when they
 * are sent.
 *
 * The replay is bounded: at most {@link MAX_REPLAYED_PROGRESS_ROWS} progress
 * rows, the most recent ones, because broadcasting tens of thousands of frames
 * into a freshly connected panel would stall it. The truncation is logged and
 * reported as {@link ReopenedSession.truncatedProgress}.
 *
 * Delivery is synchronous and in call order (`../server/clients.ts`), so each
 * recipient sees the frames in the table's order. A broadcaster that throws is
 * a transport fault: the replay stops at that frame instead of sending later
 * frames ahead of an earlier one that never arrived, the fault is logged, and
 * the result still answers `Ok` with {@link ReopenedSession.replayInterrupted}
 * set — the data was read, and a client recovers by reopening again.
 *
 * ## Callers
 *
 * - `../server/routes/sessions.ts` serves `GET /sessions/:id` by calling
 *   {@link SessionReopener.reopen} and answering with `session` in the body
 *   shape protocol's `HTTP_ROUTES` fixes for `session.get`. A missing session
 *   is an `Err` with `SESSION_NOT_FOUND`, which that route answers `404`; a
 *   session purged by retention is simply absent and is never reconstructed.
 *   `GET /sessions` reads the repository's `list()` projection through the
 *   manager, not this module.
 * - `../server/routes/binding.ts` calls
 *   `reopen(sessionId, { kinds: ['devtools'] })` after a `session.bind`
 *   succeeds, so a DevTools panel that attaches to an existing session
 *   immediately receives the record, the progress history and the current
 *   panel — and the editor, which already holds them, receives nothing twice.
 * - The editor's Sessions tree (`apps/vscode-extension/src/views/sessions-tree.ts`)
 *   drives the reopen over HTTP; nothing in this module talks to the editor
 *   directly.
 *
 * @example
 * ```ts
 * const reopener = createSessionReopener({ sessions, panels, broadcaster: clients, logger });
 *
 * const reopened = await reopener.reopen(sessionId);
 * if (!reopened.ok) {
 *   return reopened.error.code === 'SESSION_NOT_FOUND' ? notFound() : failure(reopened.error);
 * }
 * // reopened.value.replayed →
 * //   ['session.updated', 'session.progress', …, 'analysis.completed', 'panel.generated']
 * return json({ session: reopened.value.session });
 * ```
 *
 * @module
 */

import {
  createEnvelope,
  parseAnalysisCompletedPayload,
  parsePanelGeneratedPayload,
  parseSessionProgressPayload,
  parseSessionUpdatedPayload,
  type AnalysisCompletedPayload,
  type AnalysisResult,
  type ClientKind,
  type PanelGeneratedPayload,
  type PanelSpec,
  type ProtocolMessage,
  type SessionProgressPayload,
  type SessionRecord,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isErr,
  noopLogger,
  nowEpochMs,
  ok,
  type Logger,
  type LogFields,
  type Result,
  type SessionId,
} from '@debuggen/shared';

import { sessionLogger, subsystemLogger } from '../logging.js';
import type { PanelsRepo } from '../store/panels-repo.js';
import type { ProgressEntry, SessionsRepo } from '../store/sessions-repo.js';
import type { SessionBroadcaster } from './manager.js';
import { isTerminalSessionStatus } from './state-machine.js';

// `PanelSpec` is taken from `@debuggen/protocol`'s type-only re-export of
// `@debuggen/panel-schema` rather than from `@debuggen/panel-schema` directly:
// it is the same declaration, and it keeps this module's edge list to the one
// package that already owns every frame it sends.

// ---------------------------------------------------------------------------
// Section A — constants and vocabularies
// ---------------------------------------------------------------------------

/**
 * The most progress rows one reopen replays. A session's progress history is
 * normally a few dozen rows — every stage's `running`, findings and `done`
 * lines, times the follow-ups asked — so this bound is reached only by an
 * unusually long session, and then the **most recent** rows are kept: they
 * carry the current stage and, for a failed session, the failing one.
 */
export const MAX_REPLAYED_PROGRESS_ROWS = 500;

/**
 * The stored artifacts a reopen may skip because they failed validation, as
 * they appear in {@link ReopenedSession.skipped}. The session record itself is
 * not among them: without a valid record there is nothing to reopen, so a
 * corrupt record is an `Err` rather than a skip.
 */
export const REOPEN_ARTIFACT_KINDS = Object.freeze(['progress', 'analysis', 'panel'] as const);

/** One of {@link REOPEN_ARTIFACT_KINDS}. */
export type ReopenArtifactKind = (typeof REOPEN_ARTIFACT_KINDS)[number];

/**
 * The message types a replay sends, in the order it sends them. Every entry of
 * {@link ReopenedSession.replayed} is one of these, and the entries appear in
 * this order (with `session.progress` repeated once per replayed row).
 */
export const REPLAY_MESSAGE_ORDER = Object.freeze([
  'session.updated',
  'session.progress',
  'analysis.completed',
  'panel.generated',
] as const);

/** One of {@link REPLAY_MESSAGE_ORDER}. */
export type ReplayedMessageType = (typeof REPLAY_MESSAGE_ORDER)[number];

/** The log binding every record of this module carries, shared with its siblings. */
const LOG_SUBSYSTEM = 'sessions';

/** The hint of a reopen refused because the session no longer exists. */
const SESSION_NOT_FOUND_HINT =
  'Reopen the session from the Sessions view or start a new one; a session older than the retention window is purged.';

/** The hint of a reopen refused because the stored session record is unreadable. */
const SESSION_UNREADABLE_HINT =
  'The stored session can no longer be read by this version of Debug Generator. Start a new session; the unreadable one will be purged by retention.';

// ---------------------------------------------------------------------------
// Section B — the public surface
// ---------------------------------------------------------------------------

/**
 * Everything {@link createSessionReopener} is given; all of it is injected.
 *
 * The two repositories are narrowed to their read methods, which is the
 * mechanical half of the no-write invariant: a `SessionsRepo` or `PanelsRepo`
 * satisfies these types, and nothing here can call `update`, `setStatus`,
 * `appendProgress`, an insert, or the request-key secret accessor.
 */
export interface SessionReopenerDeps {
  /** The session record and its persisted progress history. */
  readonly sessions: Pick<SessionsRepo, 'get' | 'listProgress'>;
  /** The latest panel and the latest analysis of the session. */
  readonly panels: Pick<PanelsRepo, 'getLatestPanel' | 'getLatestAnalysis'>;
  /** Where replayed frames go; the client registry in production. */
  readonly broadcaster: SessionBroadcaster;
  /** The service logger; defaults to `noopLogger`. Bound to `subsystem: "sessions"`. */
  readonly logger?: Logger | undefined;
  /** The clock non-progress frames are stamped with; defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
}

/** How one reopen behaves. Every member is optional. */
export interface ReopenOptions {
  /**
   * Whether to broadcast the replay. Defaults to `true`; `false` performs the
   * same pure read as {@link SessionReopener.load} and sends nothing.
   */
  readonly replay?: boolean | undefined;
  /**
   * Restricts the replay to these client kinds — for example only the
   * DevTools panel that just bound (`['devtools']`). Absent means every client
   * of the session; an **empty** list names no recipient and sends nothing.
   */
  readonly kinds?: readonly ClientKind[] | undefined;
}

/** The latest stored panel of a session, as `panel.generated` carries it. */
export interface ReopenedPanel {
  /** The panel's id: the frame's routing and caching key, equal to `panel.id`. */
  readonly panelId: string;
  /** The panel specification exactly as it was stored. */
  readonly panel: PanelSpec;
}

/** What one reopen read, and what it sent. */
export interface ReopenedSession {
  /** The session record as stored. */
  readonly session: SessionRecord;
  /**
   * The progress rows that passed validation, in stored order, bounded by
   * {@link MAX_REPLAYED_PROGRESS_ROWS} (the most recent rows are kept).
   */
  readonly progress: readonly SessionProgressPayload[];
  /** The latest analysis, when one is stored and passed validation. */
  readonly analysis?: AnalysisResult;
  /** The latest panel, when one is stored and passed validation. */
  readonly panel?: ReopenedPanel;
  /**
   * The message types actually sent, in order — empty for a pure read. The
   * caller and the integration suites assert the replay sequence from this.
   */
  readonly replayed: readonly ReplayedMessageType[];
  /**
   * The artifacts skipped because their stored form failed validation, each
   * kind at most once. A skipped artifact is never replayed, repaired or faked.
   */
  readonly skipped: readonly ReopenArtifactKind[];
  /** How many of the oldest progress rows were left out by the replay bound. */
  readonly truncatedProgress: number;
  /**
   * Whether the session is terminal (`ended`). Such a session is reopened
   * read-only: its history is shown, and nothing about it changes.
   */
  readonly readOnly: boolean;
  /**
   * Whether the broadcaster failed part-way, so {@link replayed} ends at the
   * last frame that was delivered. Always `false` for a pure read.
   */
  readonly replayInterrupted: boolean;
}

/**
 * Rehydrates a stored session and replays it to connected clients.
 *
 * Both methods answer with a `Result` and never throw for an expected
 * condition: a missing session is `SESSION_NOT_FOUND`, an unreadable record is
 * `STORE_ERROR`, and everything else — a corrupt progress row, analysis or
 * panel, a broadcaster fault — is reported inside an `Ok`.
 */
export interface SessionReopener {
  /**
   * The pure read: the record, its progress history, the latest analysis and
   * the latest panel, each validated against the payload of the frame that
   * would carry it. Broadcasts nothing and writes nothing.
   *
   * @param sessionId The session to read.
   * @returns The rehydrated session with an empty `replayed`, or
   * `SESSION_NOT_FOUND` / `STORE_ERROR`.
   */
  load(sessionId: SessionId): Promise<Result<ReopenedSession, DebuggenError>>;

  /**
   * {@link load}, followed by the replay in its fixed order unless
   * `options.replay` is `false`.
   *
   * `routes/binding.ts` calls `reopen(sessionId, { kinds: ['devtools'] })`
   * after a successful `session.bind`, so the attaching panel alone receives
   * the record, the progress history and the current panel.
   *
   * @param sessionId The session to reopen.
   * @param options Whether to replay, and to which client kinds.
   * @returns The rehydrated session with the frames sent, or
   * `SESSION_NOT_FOUND` / `STORE_ERROR`.
   */
  reopen(
    sessionId: SessionId,
    options?: ReopenOptions,
  ): Promise<Result<ReopenedSession, DebuggenError>>;
}

// ---------------------------------------------------------------------------
// Section C — the read side: pure helpers over stored artifacts
// ---------------------------------------------------------------------------

/** One validated progress row, with the timestamp its live frame carried. */
interface StoredProgressFrame {
  readonly payload: SessionProgressPayload;
  /** The stored timestamp, or `undefined` when it is not a usable epoch-ms value. */
  readonly ts: number | undefined;
}

/**
 * Everything one read established, before anything is sent. The analysis and
 * the panel are held as the **validated payloads** of the frames that carry
 * them, so the replay sends exactly what was checked.
 */
interface Snapshot {
  readonly session: SessionRecord;
  readonly progress: readonly StoredProgressFrame[];
  readonly analysis: AnalysisCompletedPayload | undefined;
  readonly panel: PanelGeneratedPayload | undefined;
  readonly skipped: readonly ReopenArtifactKind[];
  readonly truncatedProgress: number;
}

/** The outcome of reading one optional artifact: its payload, or a skip. */
interface ArtifactRead<T> {
  readonly payload: T | undefined;
  readonly skipped: boolean;
}

/** The outcome of reading the progress history. */
interface ProgressRead {
  readonly frames: readonly StoredProgressFrame[];
  readonly truncated: number;
  readonly skipped: boolean;
}

/** Whether a stored timestamp is a positive, finite epoch-millisecond value. */
function isEpochMs(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The log fields that describe an error without describing its data: the code
 * and, when the repository attached one, its enumerated `details.reason`.
 * Never the message, the cause or any other detail, which may quote content.
 */
function errorFields(error: DebuggenError): LogFields {
  const reason = error.details?.['reason'];

  return typeof reason === 'string' ? { code: error.code, reason } : { code: error.code };
}

/**
 * Runs one repository read. The repositories answer with a `Result` and are
 * documented never to throw; a throw is nonetheless turned into a
 * `STORE_ERROR` here, so a store fault costs one artifact rather than the
 * whole reopen.
 */
function guardedRead<T>(read: () => Result<T, DebuggenError>): Result<T, DebuggenError> {
  try {
    return read();
  } catch (thrown) {
    return err(DebuggenError.from(thrown, 'STORE_ERROR'));
  }
}

/** The refusal for an id that names no stored session. */
function sessionNotFound(sessionId: SessionId): DebuggenError {
  return new DebuggenError('SESSION_NOT_FOUND', 'No debugging session with this id exists.', {
    hint: SESSION_NOT_FOUND_HINT,
    details: { sessionId },
  });
}

/**
 * The refusal for a stored record that cannot be replayed: it no longer
 * matches the `session.updated` payload, or it names another session. The
 * schema error, when there is one, travels as `cause` — protocol's parse
 * errors carry field paths and issue codes with every rejected value stripped.
 */
function sessionUnreadable(
  sessionId: SessionId,
  corruption: 'schema-mismatch' | 'id-mismatch',
  cause?: DebuggenError,
): DebuggenError {
  return new DebuggenError('STORE_ERROR', 'The stored session could not be reopened.', {
    hint: SESSION_UNREADABLE_HINT,
    details: { sessionId, artifact: 'session', reason: 'corrupt-row', corruption },
    cause,
  });
}

/**
 * The `session.progress` payload candidate of a stored row. `detail` is
 * present only when one was stored, which is how protocol spells "no detail";
 * a stored detail that is not a string is handed to the validator as it is,
 * and refused there rather than coerced.
 */
function progressCandidate(row: ProgressEntry): Readonly<Record<string, unknown>> {
  const base = {
    sessionId: row.sessionId,
    stage: row.stage,
    status: row.status,
    message: row.message,
  };

  return row.detail === undefined ? base : { ...base, detail: row.detail };
}

/**
 * The public view of a snapshot and of what was sent. Optional members are
 * added only when present (`exactOptionalPropertyTypes`), and every array and
 * object handed out is frozen.
 */
function describe(
  snapshot: Snapshot,
  replayed: readonly ReplayedMessageType[],
  interrupted: boolean,
): ReopenedSession {
  const base = {
    session: snapshot.session,
    progress: Object.freeze(snapshot.progress.map((frame) => frame.payload)),
    replayed: Object.freeze([...replayed]),
    skipped: snapshot.skipped,
    truncatedProgress: snapshot.truncatedProgress,
    readOnly: isTerminalSessionStatus(snapshot.session.status),
    replayInterrupted: interrupted,
  };
  const withAnalysis =
    snapshot.analysis === undefined ? base : { ...base, analysis: snapshot.analysis.analysis };
  const described: ReopenedSession =
    snapshot.panel === undefined
      ? withAnalysis
      : {
          ...withAnalysis,
          panel: Object.freeze({ panelId: snapshot.panel.panelId, panel: snapshot.panel.panel }),
        };

  return Object.freeze(described);
}

// ---------------------------------------------------------------------------
// Section D — the reopener
// ---------------------------------------------------------------------------

/**
 * Creates the session reopener.
 *
 * @param deps The two repositories' read methods, the broadcaster port and,
 * optionally, the logger and the clock.
 * @returns A stateless reopener: every call reads the store afresh, so a
 * reopen after a service restart replays exactly what a reopen before it
 * would have.
 */
export function createSessionReopener(deps: SessionReopenerDeps): SessionReopener {
  const { sessions, panels, broadcaster } = deps;
  const clock = deps.now ?? nowEpochMs;
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);

  /**
   * The injected clock's reading, for the frames that are stamped when sent.
   * A clock that throws or answers something other than a positive finite
   * number is replaced by the wall clock rather than allowed to fail a replay.
   */
  function stamp(): number {
    try {
      const value = clock();

      if (isEpochMs(value)) {
        return value;
      }
    } catch {
      // Fall through: an injected clock is a test seam, and its failure must
      // not cost the developer the reopened session.
    }

    return nowEpochMs();
  }

  /**
   * Reads and validates the session record — the one artifact a reopen cannot
   * do without. Missing is `SESSION_NOT_FOUND`; unreadable is `STORE_ERROR`.
   */
  function readSession(sessionId: SessionId, scoped: Logger): Result<SessionRecord, DebuggenError> {
    const read = guardedRead(() => sessions.get(sessionId));

    if (isErr(read)) {
      scoped.warn('the stored session could not be read; it cannot be reopened', {
        artifact: 'session',
        ...errorFields(read.error),
      });
      return read;
    }

    if (read.value === undefined) {
      scoped.debug('no stored session has this id; nothing to reopen');
      return err(sessionNotFound(sessionId));
    }

    const parsed = parseSessionUpdatedPayload({ session: read.value });

    if (isErr(parsed)) {
      scoped.warn('the stored session failed validation; it cannot be reopened', {
        artifact: 'session',
        code: parsed.error.code,
      });
      return err(sessionUnreadable(sessionId, 'schema-mismatch', parsed.error));
    }

    if (parsed.value.session.id !== sessionId) {
      scoped.warn('the stored session names another id; it cannot be reopened', {
        artifact: 'session',
      });
      return err(sessionUnreadable(sessionId, 'id-mismatch'));
    }

    return ok(parsed.value.session);
  }

  /**
   * Reads the progress history in stored order, keeps the most recent
   * {@link MAX_REPLAYED_PROGRESS_ROWS} rows, and validates each one as a
   * `session.progress` payload. A row that fails is skipped on its own; a
   * history that cannot be read at all is skipped as a whole.
   */
  function readProgress(sessionId: SessionId, scoped: Logger): ProgressRead {
    const listed = guardedRead(() => sessions.listProgress(sessionId));

    if (isErr(listed)) {
      scoped.warn('the stored progress history could not be read and is not replayed', {
        artifact: 'progress',
        ...errorFields(listed.error),
      });
      return { frames: [], truncated: 0, skipped: true };
    }

    const rows = listed.value;
    const truncated = Math.max(0, rows.length - MAX_REPLAYED_PROGRESS_ROWS);
    const retained = truncated === 0 ? rows : rows.slice(truncated);

    if (truncated > 0) {
      scoped.info('the progress history exceeds the replay bound; the most recent rows replay', {
        artifact: 'progress',
        stored: rows.length,
        retained: retained.length,
        truncated,
      });
    }

    const frames: StoredProgressFrame[] = [];
    let rejected = 0;

    for (const row of retained) {
      if (row.sessionId !== sessionId) {
        rejected += 1;
        scoped.warn('a stored progress row names another session and was skipped', {
          artifact: 'progress',
          progressId: row.id,
        });
        continue;
      }

      const parsed = parseSessionProgressPayload(progressCandidate(row));

      if (isErr(parsed)) {
        rejected += 1;
        scoped.warn('a stored progress row failed validation and was skipped', {
          artifact: 'progress',
          progressId: row.id,
          code: parsed.error.code,
        });
        continue;
      }

      frames.push({ payload: parsed.value, ts: isEpochMs(row.ts) ? row.ts : undefined });
    }

    return { frames: Object.freeze(frames), truncated, skipped: rejected > 0 };
  }

  /**
   * Reads the latest analysis and validates it as an `analysis.completed`
   * payload for this session. Absent is not a skip; unreadable or invalid is.
   */
  function readAnalysis(
    sessionId: SessionId,
    scoped: Logger,
  ): ArtifactRead<AnalysisCompletedPayload> {
    const read = guardedRead(() => panels.getLatestAnalysis(sessionId));

    if (isErr(read)) {
      scoped.warn('the latest stored analysis could not be read and is not replayed', {
        artifact: 'analysis',
        ...errorFields(read.error),
      });
      return { payload: undefined, skipped: true };
    }

    const analysis = read.value;

    if (analysis === undefined) {
      return { payload: undefined, skipped: false };
    }

    if (analysis.sessionId !== sessionId) {
      scoped.warn('the latest stored analysis names another session and is not replayed', {
        artifact: 'analysis',
        analysisId: analysis.id,
      });
      return { payload: undefined, skipped: true };
    }

    const parsed = parseAnalysisCompletedPayload({ sessionId, analysis });

    if (isErr(parsed)) {
      scoped.warn('the latest stored analysis failed validation and is not replayed', {
        artifact: 'analysis',
        analysisId: analysis.id,
        code: parsed.error.code,
      });
      return { payload: undefined, skipped: true };
    }

    return { payload: parsed.value, skipped: false };
  }

  /**
   * Reads the latest panel and validates it as a `panel.generated` payload
   * for this session, with `panelId` equal to the stored `panel.id` — the
   * sender's invariant protocol leaves to the service. A fallback panel is a
   * panel like any other here. Absent is not a skip; unreadable or invalid is,
   * and an earlier version is never substituted for a corrupt latest one.
   */
  function readPanel(sessionId: SessionId, scoped: Logger): ArtifactRead<PanelGeneratedPayload> {
    const read = guardedRead(() => panels.getLatestPanel(sessionId));

    if (isErr(read)) {
      scoped.warn('the latest stored panel could not be read and is not replayed', {
        artifact: 'panel',
        ...errorFields(read.error),
      });
      return { payload: undefined, skipped: true };
    }

    const panel = read.value;

    if (panel === undefined) {
      return { payload: undefined, skipped: false };
    }

    if (panel.sessionId !== sessionId) {
      scoped.warn('the latest stored panel names another session and is not replayed', {
        artifact: 'panel',
        panelId: panel.id,
      });
      return { payload: undefined, skipped: true };
    }

    const parsed = parsePanelGeneratedPayload({ sessionId, panelId: panel.id, panel });

    if (isErr(parsed)) {
      scoped.warn('the latest stored panel failed validation and is not replayed', {
        artifact: 'panel',
        panelId: panel.id,
        code: parsed.error.code,
      });
      return { payload: undefined, skipped: true };
    }

    return { payload: parsed.value, skipped: false };
  }

  /**
   * The whole read: the record first (without it there is nothing to
   * reopen), then the progress history, the latest analysis and the latest
   * panel, each of which may be skipped without failing the others.
   */
  function read(sessionId: SessionId): Result<Snapshot, DebuggenError> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      log.debug('a reopen named no session id; nothing to reopen');
      return err(sessionNotFound(String(sessionId)));
    }

    const scoped = sessionLogger(log, sessionId);
    const session = readSession(sessionId, scoped);

    if (isErr(session)) {
      return session;
    }

    if (isTerminalSessionStatus(session.value.status)) {
      scoped.info('a terminal session is reopened read-only; its status is unchanged', {
        status: session.value.status,
      });
    }

    const progress = readProgress(sessionId, scoped);
    const analysis = readAnalysis(sessionId, scoped);
    const panel = readPanel(sessionId, scoped);

    const skipped: ReopenArtifactKind[] = [];

    if (progress.skipped) {
      skipped.push('progress');
    }

    if (analysis.skipped) {
      skipped.push('analysis');
    }

    if (panel.skipped) {
      skipped.push('panel');
    }

    return ok({
      session: session.value,
      progress: progress.frames,
      analysis: analysis.payload,
      panel: panel.payload,
      skipped: Object.freeze(skipped),
      truncatedProgress: progress.truncated,
    });
  }

  /**
   * Sends the snapshot in the fixed order, stopping at the first frame the
   * broadcaster refuses so no later frame ever overtakes an earlier one.
   * Frames are built lazily, one at a time, so a fault costs nothing that was
   * not already sent.
   */
  function replay(
    snapshot: Snapshot,
    kinds: readonly ClientKind[] | undefined,
    scoped: Logger,
  ): { readonly replayed: readonly ReplayedMessageType[]; readonly interrupted: boolean } {
    const sessionId = snapshot.session.id;
    const replayed: ReplayedMessageType[] = [];

    const deliver = (type: ReplayedMessageType, build: () => ProtocolMessage): boolean => {
      try {
        const message = build();

        if (kinds === undefined) {
          broadcaster.broadcast(sessionId, message);
        } else {
          broadcaster.broadcastToKinds(sessionId, kinds, message);
        }

        replayed.push(type);
        return true;
      } catch (thrown) {
        scoped.warn(
          'the replay stopped at a frame that could not be sent; reopening again resends it',
          {
            type,
            delivered: replayed.length,
            code: DebuggenError.from(thrown, 'TRANSPORT_DISCONNECTED').code,
          },
        );
        return false;
      }
    };

    // 1. The record, routed by its own id: `session.updated` carries no
    //    top-level `sessionId`, so the routing key is supplied explicitly.
    let delivered = deliver('session.updated', () =>
      createEnvelope('session.updated', { session: snapshot.session }, { sessionId, ts: stamp() }),
    );

    // 2. Every retained progress row, in stored order, with its stored stamp.
    for (const frame of snapshot.progress) {
      if (!delivered) {
        break;
      }

      delivered = deliver('session.progress', () =>
        createEnvelope('session.progress', frame.payload, { ts: frame.ts ?? stamp() }),
      );
    }

    // 3. The latest analysis.
    const { analysis, panel } = snapshot;

    if (delivered && analysis !== undefined) {
      delivered = deliver('analysis.completed', () =>
        createEnvelope('analysis.completed', analysis, { ts: stamp() }),
      );
    }

    // 4. The latest panel.
    if (delivered && panel !== undefined) {
      delivered = deliver('panel.generated', () =>
        createEnvelope('panel.generated', panel, { ts: stamp() }),
      );
    }

    return { replayed, interrupted: !delivered };
  }

  /**
   * Runs one operation at the method boundary, so a fault nobody anticipated —
   * a logger that throws, say — becomes an `Err` rather than a rejected
   * promise in the route that awaited it.
   */
  function settle(
    operation: () => Result<ReopenedSession, DebuggenError>,
  ): Promise<Result<ReopenedSession, DebuggenError>> {
    try {
      return Promise.resolve(operation());
    } catch (thrown) {
      return Promise.resolve(err(DebuggenError.from(thrown, 'INTERNAL')));
    }
  }

  function loadNow(sessionId: SessionId): Result<ReopenedSession, DebuggenError> {
    const snapshot = read(sessionId);

    if (isErr(snapshot)) {
      return snapshot;
    }

    return ok(describe(snapshot.value, [], false));
  }

  function reopenNow(
    sessionId: SessionId,
    options: ReopenOptions | undefined,
  ): Result<ReopenedSession, DebuggenError> {
    const snapshot = read(sessionId);

    if (isErr(snapshot)) {
      return snapshot;
    }

    const scoped = sessionLogger(log, sessionId);

    if (options?.replay === false) {
      scoped.debug('session read without replay');
      return ok(describe(snapshot.value, [], false));
    }

    const kinds = options?.kinds === undefined ? undefined : Object.freeze([...options.kinds]);

    if (kinds?.length === 0) {
      scoped.debug('the reopen named no recipient kind; nothing was replayed');
      return ok(describe(snapshot.value, [], false));
    }

    const { replayed, interrupted } = replay(snapshot.value, kinds, scoped);

    scoped.info('session replayed from stored data', {
      frames: replayed.length,
      progressRows: snapshot.value.progress.length,
      analysis: snapshot.value.analysis !== undefined,
      panel: snapshot.value.panel !== undefined,
      skipped: snapshot.value.skipped,
      truncatedProgress: snapshot.value.truncatedProgress,
      recipients: kinds ?? 'all',
      interrupted,
    });

    return ok(describe(snapshot.value, replayed, interrupted));
  }

  return Object.freeze({
    load(sessionId: SessionId): Promise<Result<ReopenedSession, DebuggenError>> {
      return settle(() => loadNow(sessionId));
    },

    reopen(
      sessionId: SessionId,
      options?: ReopenOptions,
    ): Promise<Result<ReopenedSession, DebuggenError>> {
      return settle(() => reopenNow(sessionId, options));
    },
  });
}
