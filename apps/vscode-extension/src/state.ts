/**
 * The extension host's single in-memory store of server state (AAP §0.7.1
 * Group 3, §0.7.3).
 *
 * The host holds exactly one connection to the local service. Every message it
 * receives on that connection — and every authoritative answer it gets over
 * HTTP — is folded into one {@link ExtensionState} instance, and both editor
 * surfaces read from it: the `debuggen.session` webview view posts the
 * {@link WebviewState} snapshot this store emits straight through, and the
 * `debuggen.sessions` tree refreshes itself from {@link ExtensionState.sessionList}.
 * This is the **only** place the host caches server state, so the two views can
 * never disagree about what the service said.
 *
 * ```text
 * service ──WS/HTTP──▶ src/extension.ts ──apply*()/set*()──▶ ExtensionState
 *                                                              │ onDidChange (coalesced)
 *                                    ┌─────────────────────────┴───────────────┐
 *                                    ▼                                         ▼
 *                     session-view-provider (postMessage)          sessions-tree (refresh)
 * ```
 *
 * ## What the store is — and what it refuses to be
 *
 * - **A pure projection.** Every mutator is named after the protocol message
 *   (or HTTP answer) that caused it and takes that message's payload type from
 *   `@debuggen/protocol`. A mutator performs no I/O, shows no UI and logs
 *   nothing: the store never pulls, it is fed. That is what makes it directly
 *   unit-testable and what keeps a bug in a view from reaching the service.
 * - **In memory only.** Nothing is written to `workspaceState`, `globalState`,
 *   the workspace folder or any file. Session data lives under
 *   `$DEBUGGEN_HOME`, owned by the service (AAP §0.4.2, §0.5.2), which is what
 *   keeps a debugging session out of the developer's git status.
 * - **Never a holder of secrets.** The pairing code is a short-lived,
 *   single-use capability shown to the developer; no bearer token, no
 *   `auth.json` content and no service credential ever enters this store
 *   (AAP §0.5.6). {@link ExtensionState.setPairing} copies only the two
 *   displayable fields, so an object that happens to carry more cannot smuggle
 *   anything else in.
 * - **Never an author of results.** Progress rows are exactly what the service
 *   sent, in the order it sent it; no step list is synthesised, reordered or
 *   filled in, and the capture counter is never estimated (AAP §0.5.4). A
 *   failure is held in its own field and is never representable as a
 *   successful analysis (AAP §0.5.5). The store never inspects the session
 *   question's content.
 *
 * ## Reopen and live paths are the same path
 *
 * The service pushes `session.updated` after essentially every pipeline step,
 * so {@link ExtensionState.applySessionRecord} is the hottest mutator, and it
 * derives every member the record can supply — relevant files, modifications,
 * cleanup status, target, the latest analysis, the capture window — from the
 * record itself. Reopening a stored session (`GET /sessions/:id`) therefore
 * repopulates the whole view from one call, exactly as the live path does. The
 * one member a record cannot supply is the latest panel's summary (the record
 * carries panel ids only); on reopen the service replays the latest
 * `panel.generated` (AAP §0.4.2), which {@link ExtensionState.applyPanelGenerated}
 * turns back into that summary. Progress rows live in the service's
 * `session_progress` table rather than on the record, so a reopened session
 * shows exactly the rows the service chooses to send — none are invented.
 *
 * ## One whole record, and list rows for everything else
 *
 * Only the session in view is held as a whole record. The Sessions tree's list
 * is the `SessionListItem` rows the tree gathered by walking `GET /sessions`
 * page by page — seven scalars and a diff-free cleanup summary per session —
 * together with the listing's `total`, so the tree can say how many stored
 * sessions a load it had to stop short left out.
 * A `session.updated` for a session that is listed but not in view refreshes
 * its row through the protocol's `toSessionListItem` projection and is then
 * dropped: the store never retains the plans, modification diffs or analyses
 * of a session the developer is not looking at, however often the service
 * re-broadcasts it, and it never clones such a record just to discard it.
 *
 * Because the record and the finer-grained pushes (`instrumentation.ready`,
 * `analysis.completed`, `capture.*`, `cleanup.completed`) can reach the host in
 * either order, applying a record never regresses a fact a push already
 * established: the modification journal is append-only, analyses are ordered
 * by `analysisVersion`, a stopped capture does not restart, and a finished
 * cleanup does not return to `pending`. Above all, `ended` is terminal: once
 * the store has acknowledged a session as ended — the HTTP answer to
 * `session.end`, or any `ended` record — no later record of it that is not
 * `ended`, whatever its `updatedAt`, and no delayed live frame of it, makes it
 * look live again ({@link ExtensionState.hasAcknowledgedEnd}). The journal
 * fetched over HTTP (`GET /sessions/:id/modifications`) is folded in through
 * {@link ExtensionState.applyModificationJournal} under the same append-only
 * rule, and never moves a record's status back; the journal's `total` it
 * reports is kept beside the list ({@link ExtensionState.modificationsTotal}),
 * so the view can say when records are missing. Each merge rule is documented
 * where it is applied.
 *
 * ## Which session is active is decided by the editor, never by a push
 *
 * The editor tracks at most one live session, and `deactivate()` ends that one
 * and whatever its creates in flight produce (AAP §0.5.1), so a session must
 * never leave the store while its
 * instrumentation may still be installed. Every VS Code window whose workspace
 * covers the project receives every session's frames, so a frame for a session
 * the store does not hold may well belong to another window. The rules:
 *
 * - **A record never becomes active on its own.** {@link ExtensionState.applySessionRecord}
 *   merges into the active session or refreshes that session's entry in
 *   {@link ExtensionState.sessionList}; nothing else.
 * - **Adoption is explicit.** {@link ExtensionState.adoptSession} replaces the
 *   active session with a record, in one batch. The commands call it only after
 *   the service has answered `session.end` for the session being replaced with
 *   a settled verdict (`src/commands/end-session.ts`), and
 *   {@link ExtensionState.applySessionEnded} records that answer here.
 * - **A session being created or reopened loses no frame.** `POST /sessions`
 *   starts the pipeline before it answers, so `session.created` and the first
 *   `session.progress` rows of the new session can arrive before the HTTP
 *   answer that names it. {@link ExtensionState.beginSessionCreation} opens a
 *   window that holds every frame for a session other than the active one, in
 *   arrival order and bounded; adopting the answered record replays exactly the
 *   held frames of that session and discards the rest.
 * - **The active session remembers the service that owns it.** Adoption takes
 *   the base URL the answering request was sent to — captured before it was
 *   sent — and {@link ExtensionState.activeSessionEndpoint} keeps it for as
 *   long as the session is active. `debuggen.serviceUrl` may change while a
 *   session is live; the session still lives in the service that created it,
 *   so every end (`src/commands/end-session.ts`) is sent there, never to
 *   whatever the setting names now.
 * - **Shutdown closes the gate, and no create is lost to it.**
 *   `deactivate()` first calls {@link ExtensionState.beginShutdown}, after
 *   which nothing is adopted and the commands create and reopen nothing.
 *   Every `POST /sessions` is registered, right before it is sent, with
 *   {@link ExtensionState.trackSessionCreate}; a create answered after the gate
 *   closed hands its session to the shutdown routine, which waits for the
 *   creates in flight and ends what they produced. That ledger survives
 *   {@link ExtensionState.dispose}, because VS Code disposes the store before
 *   `deactivate()`'s promise settles.
 *
 * ## Coalescing
 *
 * `session.progress` arrives in bursts and every notification becomes a
 * `postMessage` to the webview, so mutators never fire {@link
 * ExtensionState.onDidChange} synchronously. A mutation marks the store dirty
 * and schedules one flush on the microtask queue; further mutations before it
 * runs join the same flush. {@link ExtensionState.batch} additionally holds the
 * flush back for the duration of a callback. Listeners therefore always receive
 * one whole, consistent snapshot per burst, never a half-applied one.
 *
 * ## Immutability
 *
 * Incoming records are cloned and deep-frozen on ingest, so the store owns its
 * data independently of the caller's objects and every accessor can hand out
 * its internals without copying: an accidental write from a command throws
 * instead of silently corrupting the store. {@link ExtensionState.toWebviewState}
 * returns a fresh structured clone, so a consumer may freely mutate the
 * snapshot it receives without affecting the store, and the snapshot is
 * guaranteed to be JSON-serializable.
 *
 * @example
 * ```ts
 * const state = new ExtensionState({ serviceUrl, provider });
 * context.subscriptions.push(state);
 * state.onDidChange((snapshot) => view.postState(snapshot));
 * client.on('session.updated', (payload) => state.applySessionRecord(payload.session));
 * client.on('session.progress', (payload) => state.applyProgress(payload));
 *
 * // Starting a session: frames of the new session that beat the HTTP answer
 * // are held, then replayed once the answered record is adopted.
 * const creation = state.beginSessionCreation();
 * try {
 *   const endpoint = client.baseUrl; // captured before the request is sent
 *   const created = await client.createSession(request);
 *   if (isOk(created) && endpoint !== undefined) creation.adopt(created.value, endpoint);
 * } finally {
 *   creation.abandon(); // a no-op once adopted
 * }
 * ```
 */

import * as vscode from 'vscode';

import { toSessionListItem } from '@debuggen/protocol';
import type {
  AnalysisResult,
  CaptureRecord,
  CaptureStartedPayload,
  CaptureStoppedPayload,
  CleanupCompletedPayload,
  CleanupStatus,
  ConnectionState,
  InstrumentationFailedPayload,
  InstrumentationPlan,
  InstrumentationPlanPayload,
  InstrumentationReadyPayload,
  ModificationRecord,
  ModificationStatus,
  PanelGeneratedPayload,
  ProgressStage,
  RelevantFile,
  SelectedTarget,
  SessionEndResponse,
  SessionListItem,
  SessionProgressPayload,
  SessionRecord,
  UnavailableSignalPayload,
} from '@debuggen/protocol';

import type {
  PairingState,
  PanelSummary,
  ProgressEntry,
  SessionCleanupState,
  StageFailure,
  WebviewState,
} from './webview-messages';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * What the store needs to render an honest status bar before the first health
 * probe returns.
 */
export interface ExtensionStateOptions {
  /** The configured service base URL (`debuggen.serviceUrl`). */
  readonly serviceUrl: string;
  /**
   * The configured model provider (`debuggen.provider`). Replaced by the
   * service's own answer via {@link ExtensionState.setProvider} once `GET /health`
   * reports it, because the running service is the authority on which provider
   * it actually uses.
   */
  readonly provider: string;
  /**
   * The clock, in Unix epoch milliseconds. Defaults to `Date.now`; injectable so
   * progress receipt times and pairing expiry are deterministic under test.
   */
  readonly now?: () => number;
}

/** The capture window as the host knows it; the snapshot's `capture` member. */
export type CaptureState = Readonly<WebviewState['capture']>;

/**
 * What {@link ExtensionState.setSessionList} stores: the rows of `GET /sessions`
 * and the listing's `total`.
 *
 * The Sessions tree passes the rows it gathered across every page of one load,
 * de-duplicated by id, with the `total` the last page reported. The protocol's
 * `SessionListResponse` satisfies the shape too, so a single validated page can
 * be handed over unchanged. The store keeps only these two members, because
 * the echoed window (`limit`, `offset`, `nextOffset`) describes a request
 * rather than the sessions.
 */
export interface SessionListPage {
  /** The rows, as the service ordered them (most recently updated first). */
  readonly sessions: readonly SessionListItem[];
  /** How many sessions the listing holds before paging; at least `sessions.length`. */
  readonly total: number;
}

/**
 * The window over the creation — or reopening — of the session about to become
 * active, opened by {@link ExtensionState.beginSessionCreation}.
 *
 * While it is open, every frame for a session other than the active one is
 * held (bounded by {@link MAX_HELD_FRAMES}) instead of being dropped, because
 * the session the command is about to adopt is, by definition, not active yet.
 * Exactly one of {@link adopt} and {@link abandon} closes it; both are
 * idempotent, and whichever runs first wins.
 *
 * @example
 * ```ts
 * const creation = state.beginSessionCreation();
 * try {
 *   const endpoint = client.baseUrl;
 *   const created = await client.createSession(request);
 *   if (isOk(created) && endpoint !== undefined) creation.adopt(created.value, endpoint);
 * } finally {
 *   creation.abandon();
 * }
 * ```
 */
export interface SessionCreationWindow {
  /** Whether the window still holds frames: not yet adopted, abandoned, shut down or disposed. */
  readonly isOpen: boolean;
  /**
   * How many frames arrived after the window already held
   * {@link MAX_HELD_FRAMES} and were therefore dropped. Diagnostic only.
   */
  readonly droppedFrames: number;
  /**
   * Makes `record` the active session ({@link ExtensionState.adoptSession}),
   * owned by `endpoint`, and then, in the same batch and in arrival order,
   * replays the held frames of that session only; frames held for any other
   * session are discarded. Closes the window. A no-op once the window is
   * closed.
   *
   * @param record The service's answer naming the session.
   * @param endpoint The service base URL the answering request was sent to,
   *   captured before it was sent; see {@link ExtensionState.activeSessionEndpoint}.
   */
  adopt(record: SessionRecord, endpoint: string): void;
  /** Discards every held frame and closes the window. A no-op once closed. */
  abandon(): void;
}

/** A session a tracked `POST /sessions` created, and the service that created it. */
export interface CreatedSession {
  /** The created session's id, from the service's answer. */
  readonly sessionId: string;
  /** The base URL the request was sent to — the session's owning endpoint. */
  readonly endpoint: string;
}

/**
 * One `POST /sessions` in flight, registered with
 * {@link ExtensionState.trackSessionCreate} right before the request is sent.
 *
 * The ticket is how a create reaches the shutdown routine
 * (`endSessionsForShutdown` in `src/commands/end-session.ts`) when
 * `deactivate()` runs while the request is still unanswered: the routine waits
 * for {@link settled} and ends whatever the request created that nobody
 * adopted. Exactly one of {@link adopted}, {@link orphaned} and {@link none}
 * settles it; the first call wins and every later one changes nothing.
 *
 * @example
 * ```ts
 * const ticket = state.trackSessionCreate(endpoint);
 * try {
 *   const created = await client.createSession(request);
 *   if (isErr(created)) return ticket.none();
 *   if (creation.isOpen) {
 *     creation.adopt(created.value, endpoint);
 *     ticket.adopted(created.value.id);
 *   } else if (!ticket.orphaned(created.value.id)) {
 *     await client.endSession(created.value.id, { endpoint }); // nobody else will
 *   }
 * } finally {
 *   ticket.none(); // a no-op once settled
 * }
 * ```
 */
export interface SessionCreateTicket {
  /** The base URL the request is sent to, captured before it was sent. */
  readonly endpoint: string;
  /**
   * Resolves once the ticket settles: with the session the request created, or
   * `undefined` when it created none. Never rejects.
   */
  readonly settled: Promise<CreatedSession | undefined>;
  /**
   * The service created `sessionId` and the store adopted it as the active
   * session, which from now on is the session `deactivate()` ends.
   */
  adopted(sessionId: string): void;
  /**
   * The service created `sessionId` but the store did not adopt it, because the
   * extension began shutting down (or the store was disposed) while the request
   * was in flight.
   *
   * @returns `true` when the shutdown routine has taken the session over and
   *   will end it at {@link endpoint}; `false` when no routine will — no
   *   shutdown began, or its routine has already stopped waiting — so the
   *   caller must end the session itself.
   */
  orphaned(sessionId: string): boolean;
  /** The request created nothing: it was refused, failed, or was never sent. */
  none(): void;
}

// ---------------------------------------------------------------------------
// Module constants (immutable; no module-level mutable state exists)
// ---------------------------------------------------------------------------

/**
 * The stage an `instrumentation.failed` frame reports on.
 *
 * That payload carries an error and no stage name, because its message type
 * already says which stage failed. The literal is checked against the
 * protocol's own `ProgressStage` vocabulary, so a rename there fails to compile
 * here rather than drifting silently.
 */
const INSTRUMENTATION_STAGE = 'instrument' satisfies ProgressStage;

/**
 * How far along its lifecycle a modification record's status is, for
 * {@link ExtensionState.applyModificationJournal}: a record is journaled
 * `pending`, becomes `applied` once written, ends `failed` or `conflict` when
 * it could not be written or restored, and `reverted` once restored — which
 * is closed for good. An answer is never allowed to move a held record back.
 * Typed as a total record over the protocol's `ModificationStatus`, so a new
 * status fails to compile here until it is ranked.
 */
const MODIFICATION_STATUS_RANK: Readonly<Record<ModificationStatus, number>> = Object.freeze({
  pending: 0,
  applied: 1,
  failed: 2,
  conflict: 2,
  reverted: 3,
});

/** The capture window before any capture has run. */
const IDLE_CAPTURE: CaptureState = Object.freeze({ active: false, eventCount: 0 });

/** The cleanup state before any session has run cleanup. */
const PENDING_CLEANUP: SessionCleanupState = deepFreeze<SessionCleanupState>({
  status: 'pending',
  conflicts: [],
});

/** The longest delay a Node.js timer honours (2^31 − 1 ms); longer delays fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The most progress rows the store holds for the active session; past it
 * {@link boundProgress} compacts the oldest episodes.
 *
 * The service stores every row but replays at most the 500 most recent on
 * reopen (`MAX_REPLAYED_PROGRESS_ROWS` in `apps/local-service/src/sessions/reopen.ts`),
 * so the editor holds twice that: a first run produces a few dozen rows and
 * each follow-up a few dozen more, so tens of follow-ups fit before anything is
 * compacted, and every episode's summary fits for the protocol's maximum of 50
 * follow-ups (a few hundred episodes). It still bounds the array every row
 * copies and every snapshot structured-clones; what the webview *mounts* is
 * bounded separately by `ProgressSteps`' live window, which renders older
 * sections as their summaries and mounts their rows only on demand.
 */
const MAX_PROGRESS_ENTRIES = 1_000;

/**
 * Bounds a progress list to {@link MAX_PROGRESS_ENTRIES} without losing any
 * episode's summary.
 *
 * An **episode** is a contiguous run of rows of one stage — how
 * {@link ExtensionState.applyProgress} matches rows and how `ProgressSteps`
 * draws sections. Oldest first, each episode except the newest (the live tail)
 * is compacted to its **summary**: its first row, which is the stage's own
 * header row carrying the stage title and its settled status, plus every
 * `failed` row it holds, because a failure is never hidden (AAP §0.5.5). Only
 * the episode's other rows — its `done` and `running` detail rows — are
 * dropped. Compaction stops as soon as the list fits, so the newest history
 * keeps every row. Only when every older episode is already a summary and the
 * list still does not fit — hundreds of episodes, more than the protocol's
 * 50 follow-ups produce — do whole episodes leave from the front; a single
 * episode longer than the bound keeps its first row, its failed rows and its
 * newest rows.
 *
 * Episode boundaries survive compaction (an episode is never removed in part
 * from the middle of the list), and the rows kept are exactly rows the service
 * sent, in arrival order: nothing is reordered, rewritten or synthesised
 * (AAP §0.5.4). Each kept row keeps its receipt time, which is what identifies
 * it to the view, so a compaction never changes the identity of a surviving
 * row or section.
 *
 * @param rows The list, at most one row over the bound; not mutated.
 * @returns `rows` itself when it fits, otherwise a new, bounded list.
 */
function boundProgress(rows: readonly ProgressEntry[]): readonly ProgressEntry[] {
  if (rows.length <= MAX_PROGRESS_ENTRIES) {
    return rows;
  }

  /** The episodes as `[first, end)` index ranges over `list`, in arrival order. */
  const episodesOf = (
    list: readonly ProgressEntry[],
  ): { readonly first: number; readonly end: number }[] => {
    const ranges: { readonly first: number; readonly end: number }[] = [];
    let first = 0;
    while (first < list.length) {
      const stage = list[first]?.stage;
      let end = first + 1;
      while (end < list.length && list[end]?.stage === stage) {
        end += 1;
      }
      ranges.push({ first, end });
      first = end;
    }
    return ranges;
  };

  // Pass 1 — compact the oldest episodes to their summaries until the list fits.
  const episodes = episodesOf(rows);
  let excess = rows.length - MAX_PROGRESS_ENTRIES;
  const compacted: ProgressEntry[] = [];
  episodes.forEach(({ first, end }, index) => {
    const episode = rows.slice(first, end);
    const live = index === episodes.length - 1;
    if (excess <= 0 || live) {
      compacted.push(...episode);
      return;
    }
    const summary = episode.filter((row, position) => position === 0 || row.status === 'failed');
    excess -= episode.length - summary.length;
    compacted.push(...summary);
  });
  if (compacted.length <= MAX_PROGRESS_ENTRIES) {
    return compacted;
  }

  // Pass 2 — every older episode is a summary already: whole episodes leave from the front.
  const remaining = episodesOf(compacted);
  let start = 0;
  for (const { end } of remaining.slice(0, -1)) {
    if (compacted.length - start <= MAX_PROGRESS_ENTRIES) {
      break;
    }
    start = end;
  }
  const kept = compacted.slice(start);
  if (kept.length <= MAX_PROGRESS_ENTRIES) {
    return kept;
  }

  // One episode longer than the bound: its header row, its failed rows (the
  // newest, should even they not fit), then as many of its newest rows as fit.
  const [header, ...rest] = kept;
  if (header === undefined) {
    return [];
  }
  const budget = MAX_PROGRESS_ENTRIES - 1;
  const failed = rest.flatMap((row, index) => (row.status === 'failed' ? [index] : []));
  const keep = new Set(failed.slice(-budget));
  for (let index = rest.length - 1; index >= 0 && keep.size < budget; index -= 1) {
    keep.add(index);
  }
  return [header, ...rest.filter((_, index) => keep.has(index))];
}

/**
 * The most frames one {@link SessionCreationWindow} holds for replay.
 *
 * `POST /sessions` answers right after storing the record, so the frames that
 * can beat the answer are the first handful of the new pipeline — far below
 * this bound. It exists so that a window left open while unrelated sessions
 * stream frames cannot grow without limit; frames past it are dropped and
 * counted in {@link SessionCreationWindow.droppedFrames}.
 */
export const MAX_HELD_FRAMES = 512;

/**
 * The most sessions whose end the store remembers beyond the active session
 * and {@link ExtensionState.sessionList}; see
 * {@link ExtensionState.hasAcknowledgedEnd}.
 *
 * A window ends a handful of sessions in its lifetime, so the bound is never
 * reached in practice. It exists so that the memory stays bounded however long
 * the window lives; past it the oldest acknowledged end is forgotten, and its
 * session is still protected wherever the Sessions tree lists it as ended.
 */
export const MAX_ACKNOWLEDGED_ENDS = 128;

/** One frame a creation window holds: the session it names and how to apply it later. */
interface HeldFrame {
  readonly sessionId: string;
  readonly replay: () => void;
}

/** The mutable interior of one open {@link SessionCreationWindow}. */
interface CreationBuffer {
  readonly frames: HeldFrame[];
  dropped: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Freezes a value and everything reachable from it, in place, and returns it.
 *
 * Applied only to values the store has just cloned, so the caller's objects
 * are never frozen. The frozen check makes shared or already-frozen subtrees
 * cost nothing and keeps the walk finite.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object) as unknown[]) {
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * Takes ownership of an incoming value: a structured clone, deep-frozen.
 *
 * Every payload the store keeps passes through here, so the store never aliases
 * an object a caller might later mutate, and no accessor can be used to mutate
 * the store.
 */
function own<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/**
 * Whether two objects hold the same own enumerable keys with `Object.is`-equal
 * values. A nested object compares by identity, so an unexpected nested member
 * reads as a difference — the safe direction for a change check.
 */
function sameMembers(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]))
  );
}

/**
 * Whether two session list rows render identically. A row is flat scalars plus
 * its cleanup summary, which is flat itself, so comparing the two levels member
 * by member covers every field of the protocol's `SessionListItem` — including
 * one the protocol adds later — without a generic deep-equality walk.
 */
function sameListRow(a: SessionListItem, b: SessionListItem): boolean {
  const { cleanup: aCleanup, ...aScalars } = a;
  const { cleanup: bCleanup, ...bScalars } = b;
  return sameMembers(aScalars, bScalars) && sameMembers(aCleanup, bCleanup);
}

/**
 * Whether the captures a record lists include the one with the given id.
 */
function recordHasCapture(captures: readonly CaptureRecord[], captureId: string): boolean {
  return captures.some((capture) => capture.id === captureId);
}

/**
 * The capture window a stored capture record describes.
 *
 * A capture without `stoppedAt` is in flight. Its count is the service's own
 * ingest counter (`CaptureRecord.eventCount`) when the service has reported one
 * on the record, and `0` otherwise — the host never counts or estimates events
 * itself (see {@link ExtensionState.applyCaptureStarted}). A stopped capture
 * reports its summary's total, falling back to the record's counter.
 */
function captureFromRecord(capture: CaptureRecord): CaptureState {
  const inFlight = capture.stoppedAt === undefined;
  const eventCount = inFlight
    ? (capture.eventCount ?? 0)
    : (capture.summary?.eventCount ?? capture.eventCount ?? 0);
  return Object.freeze({ active: inFlight, captureId: capture.id, eventCount });
}

/**
 * Whether `incoming` may replace `held`, two records of one session.
 *
 * `ended` is terminal in the service's state machine
 * (`apps/local-service/src/sessions/state-machine.ts`: `ended` has no
 * outgoing edge), so the order of two records is decided by status before it
 * is decided by time: a record that is not `ended` never replaces an `ended`
 * one, whatever its `updatedAt` — it can only be an intermediate record the
 * service sent before the end, delivered late — and an `ended` record always
 * replaces one that is not. Between two records on the same side of that
 * line, the one at least as recent (`updatedAt`) wins, so of two records with
 * equal timestamps the later arrival decides.
 */
function supersedes(
  incoming: Pick<SessionRecord, 'status' | 'updatedAt'>,
  held: Pick<SessionRecord, 'status' | 'updatedAt'>,
): boolean {
  const incomingEnded = incoming.status === 'ended';
  const heldEnded = held.status === 'ended';
  if (incomingEnded !== heldEnded) {
    return incomingEnded;
  }
  return incoming.updatedAt >= held.updatedAt;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * The host's single in-memory store of server state; see the module
 * documentation for its contract.
 *
 * Instantiable any number of times — all state is held in instance fields — and
 * disposable: after {@link dispose} every mutator is inert and no further
 * {@link onDidChange} event fires.
 */
export class ExtensionState implements vscode.Disposable {
  /** The one change event; fired at most once per coalesced burst. */
  private readonly emitter = new vscode.EventEmitter<WebviewState>();

  /**
   * Fires with a fresh {@link WebviewState} snapshot after a burst of mutations
   * settles. Both views subscribe: the webview provider posts the payload
   * through, the Sessions tree refreshes from {@link sessionList}.
   */
  readonly onDidChange: vscode.Event<WebviewState> = this.emitter.event;

  private readonly now: () => number;

  // Connection and service -------------------------------------------------
  private connectionStatusValue: ConnectionState = 'closed';
  private serviceUrlValue: string;
  private serviceReachableValue = false;
  private providerValue: string;

  // The Sessions tree's list: rows only, never whole records ---------------
  private sessionListValue: readonly SessionListItem[] = Object.freeze([]);
  private sessionListTotalValue = 0;

  // Session-scoped (cleared by resetSession) -------------------------------
  private sessionValue: SessionRecord | undefined;
  private sessionEndpointValue: string | undefined;
  private progressValue: readonly ProgressEntry[] = Object.freeze([]);
  private relevantFilesValue: readonly RelevantFile[] = Object.freeze([]);
  private modificationsValue: readonly ModificationRecord[] = Object.freeze([]);
  private modificationsTotalValue: number | undefined;
  private runtimeHooksValue: readonly string[] = Object.freeze([]);
  private unavailableSignalsValue: readonly UnavailableSignalPayload[] = Object.freeze([]);
  private analysisValue: AnalysisResult | undefined;
  private latestPanelValue: PanelSummary | undefined;
  private captureValue: CaptureState = IDLE_CAPTURE;
  private failureValue: StageFailure | undefined;
  /** The active session's record `target`; see {@link applyRecordTarget}. */
  private targetValue: SelectedTarget | undefined;
  /** The `updatedAt` of the record {@link targetValue} was taken from. */
  private targetRecordUpdatedAt: number | undefined;

  // Cleanup (survives resetSession until the next session's record) --------
  private cleanupValue: SessionCleanupState = PENDING_CLEANUP;
  private cleanupSessionId: string | undefined;

  // Pairing (survives resetSession; expires on its own) ---------------------
  private pairingValue: PairingState | undefined;
  private pairingTimer: ReturnType<typeof setTimeout> | undefined;

  // Open creation windows (see beginSessionCreation) ------------------------
  private readonly creationBuffers = new Set<CreationBuffer>();

  // Acknowledged ends (survive resetSession; see hasAcknowledgedEnd) ---------
  /** The latest `ended` record of each session seen to end, oldest first; bounded. */
  private readonly acknowledgedEnds = new Map<string, SessionRecord>();

  // Shutdown gate and create ledger (survive dispose; see beginShutdown) ----
  private shutdownBegun = false;
  /** The `settled` promise of every create ticket not yet settled. */
  private readonly createsInFlight = new Set<Promise<CreatedSession | undefined>>();
  /** Sessions creates produced during shutdown that nobody adopted, for the routine. */
  private orphanedSessions: CreatedSession[] = [];
  /** Set once the shutdown routine has claimed the orphans; later orphans go back to their creator. */
  private orphansClaimed = false;

  // Notification bookkeeping -----------------------------------------------
  private dirty = false;
  private flushScheduled = false;
  private batchDepth = 0;
  private isDisposed = false;

  /**
   * @param options The configured service URL and provider, shown until the
   *   service answers for itself, and an optional clock.
   */
  constructor(options: ExtensionStateOptions) {
    this.serviceUrlValue = options.serviceUrl;
    this.providerValue = options.provider;
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Read accessors — frozen values, never the live mutable internals
  // -------------------------------------------------------------------------

  /** The active session's record, deep-frozen; `undefined` before a question is asked. */
  get activeSession(): SessionRecord | undefined {
    return this.sessionValue;
  }

  /** The active session's id; `undefined` when no session is active. */
  get activeSessionId(): string | undefined {
    return this.sessionValue?.id;
  }

  /**
   * The base URL of the service that created or answered the active session —
   * the canonical origin `ServiceClient.baseUrl` reported when the adopting
   * request was sent — or `undefined` when no session is active.
   *
   * The session lives in that service's store, together with its modification
   * journal and runtime hooks, so ending it anywhere else ends nothing: a
   * changed `debuggen.serviceUrl` re-points new requests, never the session in
   * view. Set by {@link adoptSession} when a different session becomes active,
   * kept by a merge of the same session, cleared by {@link resetSession}.
   */
  get activeSessionEndpoint(): string | undefined {
    return this.sessionValue === undefined ? undefined : this.sessionEndpointValue;
  }

  /**
   * The Sessions tree's rows: those its last load of `GET /sessions` gathered,
   * each row refreshed in place by later records of its session. List rows,
   * never whole records — {@link activeSession} is the one whole record the
   * store holds.
   */
  get sessionList(): readonly SessionListItem[] {
    return this.sessionListValue;
  }

  /**
   * How many stored sessions `GET /sessions` counted before paging, as the last
   * page of that load reported: never less than {@link sessionList}'s length,
   * and more when the load stopped short of the listing. `0` until the list has
   * loaded.
   */
  get sessionListTotal(): number {
    return this.sessionListTotalValue;
  }

  /** The reconnecting WebSocket client's state, in the protocol's vocabulary. */
  get connectionStatus(): ConnectionState {
    return this.connectionStatusValue;
  }

  /** Whether the service's `GET /health` answered on the last probe. */
  get serviceReachable(): boolean {
    return this.serviceReachableValue;
  }

  /** The service base URL the host is configured to use. */
  get serviceUrl(): string {
    return this.serviceUrlValue;
  }

  /** The model provider: the service's own answer when known, else the configured one. */
  get provider(): string {
    return this.providerValue;
  }

  /** Progress rows of the active session, in arrival order. */
  get progress(): readonly ProgressEntry[] {
    return this.progressValue;
  }

  /** The files the investigation judged relevant, most relevant first. */
  get relevantFiles(): readonly RelevantFile[] {
    return this.relevantFilesValue;
  }

  /** Every file modification the active session made, in the order applied. */
  get modifications(): readonly ModificationRecord[] {
    return this.modificationsValue;
  }

  /**
   * How many records the active session's modification journal holds, as the
   * service counted it: the largest `total` a journal read recorded through
   * {@link applyModificationJournal} reported for the session. The journal is
   * append-only, so no read can count fewer records than an earlier one did; a
   * read answered late with an older, smaller count therefore never lowers it.
   * `undefined` until a read reported one, and again once another session
   * becomes active.
   *
   * Pushes (`session.updated`, `instrumentation.ready`, `cleanup.completed`)
   * extend {@link modifications} without touching it, so a reader compares the
   * two: a total above the list's length means records the editor has not
   * received, and a later push or read that delivers them ends the difference.
   */
  get modificationsTotal(): number | undefined {
    return this.modificationsTotalValue;
  }

  /** The runtime hooks the latest `instrumentation.ready` reported as up. */
  get runtimeHooks(): readonly string[] {
    return this.runtimeHooksValue;
  }

  /**
   * The signals the latest `instrumentation.ready` could not enable, each with
   * its reason and hint, for the "Could not enable ‹signal›…" notice
   * (AAP §0.5.5). Kept rather than discarded so a partially enabled capture is
   * always visible as such.
   */
  get unavailableSignals(): readonly UnavailableSignalPayload[] {
    return this.unavailableSignalsValue;
  }

  /** The latest validated analysis of the active session, when one exists. */
  get latestAnalysis(): AnalysisResult | undefined {
    return this.analysisValue;
  }

  /** The latest generated panel's identity and fallback flag, when one exists. */
  get latestPanel(): PanelSummary | undefined {
    return this.latestPanelValue;
  }

  /**
   * The element selected in DevTools for the active session, when its record
   * names one. The service records the selection on the session bound to the
   * DevTools tab and broadcasts the record, so this is always the held
   * record's `target`, and `undefined` while no session is active.
   */
  get target(): SelectedTarget | undefined {
    return this.targetValue;
  }

  /**
   * Whether a {@link SessionCreationWindow} is open, i.e. a session is being
   * created or reopened. The commands that replace the active session refuse
   * to start a second replacement while one is in flight.
   */
  get sessionCreationPending(): boolean {
    return this.creationBuffers.size > 0;
  }

  /**
   * Whether the store has acknowledged `sessionId` as ended: it received the
   * service's answer to `session.end` for it ({@link applySessionEnded}) or any
   * `ended` record of it — pushed, re-read, adopted or listed.
   *
   * `ended` is terminal, so from then on nothing that arrives late can reopen
   * the session here: no record of it that is not `ended` replaces the ended
   * one — in the active view, in {@link sessionList}, or when a creation window
   * replays what it held — and its delayed live frames (`capture.started`,
   * `instrumentation.plan` / `.ready` / `.failed`, a `running` progress row)
   * are not applied. Its final record, and its `cleanup.completed`, still are.
   *
   * @param sessionId The session to ask about.
   */
  hasAcknowledgedEnd(sessionId: string): boolean {
    return this.isAcknowledgedEnded(sessionId);
  }

  /**
   * Whether the extension is shutting down: {@link beginShutdown} ran, or the
   * store was disposed. From then on no session is created, reopened or
   * adopted; the commands check this before they send anything.
   */
  get isShuttingDown(): boolean {
    return this.shutdownBegun || this.isDisposed;
  }

  /**
   * The `settled` promise of every tracked `POST /sessions` still unanswered
   * ({@link trackSessionCreate}), in the order the requests were sent. Keeps
   * answering after {@link dispose}: the shutdown routine reads it after the
   * editor has disposed the store.
   */
  get sessionCreatesInFlight(): readonly Promise<CreatedSession | undefined>[] {
    return Object.freeze([...this.createsInFlight]);
  }

  /** The capture window. */
  get captureState(): CaptureState {
    return this.captureValue;
  }

  /** The cleanup state of the active (or most recently ended) session. */
  get cleanup(): SessionCleanupState {
    return this.cleanupValue;
  }

  /** The pairing code on display, or `undefined` once it has expired. */
  get pairing(): PairingState | undefined {
    const pairing = this.pairingValue;
    return pairing !== undefined && pairing.expiresAt > this.now() ? pairing : undefined;
  }

  /** The failed stage, when one failed; never part of the analysis. */
  get failure(): StageFailure | undefined {
    return this.failureValue;
  }

  // -------------------------------------------------------------------------
  // Lifecycle and notification
  // -------------------------------------------------------------------------

  /**
   * Runs `fn` with notifications held back, then flushes once.
   *
   * Every mutation `fn` makes joins a single {@link onDidChange} event, which is
   * delivered on the microtask queue like any other flush. Nested batches are
   * allowed; only the outermost one releases the flush. An exception from `fn`
   * propagates to the caller after the hold is released, and whatever `fn`
   * managed to apply before throwing is still notified.
   *
   * @example
   * ```ts
   * state.batch(() => {
   *   state.applySessionRecord(record);
   *   state.applyProgress(progress);
   * });
   * ```
   */
  batch(fn: () => void): void {
    this.batchDepth += 1;
    try {
      fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.dirty) {
        this.scheduleFlush();
      }
    }
  }

  /**
   * Releases the change event, the pairing-expiry timer and every open
   * creation window.
   *
   * Idempotent. Afterwards every mutator is a no-op, a flush already queued on
   * the microtask queue does nothing, and {@link onDidChange} never fires again.
   * Read accessors and {@link toWebviewState} keep answering with the last
   * state, so a consumer disposed out of order still reads something coherent.
   * An open {@link SessionCreationWindow} is closed with its frames discarded,
   * so a later `adopt` on it does nothing.
   *
   * The create ledger and the shutdown gate are deliberately left intact: VS
   * Code disposes `context.subscriptions` — this store among them — right after
   * `deactivate()` returns its promise, while that promise is still waiting for
   * the creates in flight. A ticket settled after disposal therefore still
   * reaches the shutdown routine, and {@link isShuttingDown} answers `true`.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.dirty = false;
    this.cancelPairingTimer();
    for (const buffer of this.creationBuffers) {
      buffer.frames.length = 0;
    }
    this.creationBuffers.clear();
    this.emitter.dispose();
  }

  // -------------------------------------------------------------------------
  // Shutdown gate and create ledger
  // -------------------------------------------------------------------------

  /**
   * Closes the gate for shutdown — the first thing `deactivate()` does.
   *
   * Afterwards no session becomes active: every open
   * {@link SessionCreationWindow} is closed with its frames discarded, a new
   * window is born closed, and {@link adoptSession} does nothing. A create
   * already in flight therefore cannot be adopted when it is answered; its
   * ticket hands the created session to the shutdown routine instead
   * ({@link SessionCreateTicket.orphaned}). Frames of the active session still
   * apply until the store is disposed. Idempotent, and effective on a disposed
   * store too.
   */
  beginShutdown(): void {
    if (this.shutdownBegun) {
      return;
    }
    this.shutdownBegun = true;
    for (const buffer of this.creationBuffers) {
      buffer.frames.length = 0;
    }
    this.creationBuffers.clear();
  }

  /**
   * Registers a `POST /sessions` about to be sent to `endpoint`, so the
   * session it creates is ended even when `deactivate()` runs before the
   * answer arrives. Call it synchronously right before sending, and settle the
   * returned ticket on every path.
   *
   * The ledger is not session state and survives both {@link resetSession} and
   * {@link dispose}.
   *
   * @param endpoint The base URL the request is sent to.
   * @returns The ticket; see {@link SessionCreateTicket}.
   */
  trackSessionCreate(endpoint: string): SessionCreateTicket {
    const inFlight = this.createsInFlight;
    let resolveSettled: (outcome: CreatedSession | undefined) => void = () => undefined;
    const settled = new Promise<CreatedSession | undefined>((resolve) => {
      resolveSettled = resolve;
    });
    inFlight.add(settled);

    let open = true;
    let handedOver = false;
    /** Settles the ticket once; `false` when it had already settled. */
    const settle = (outcome: CreatedSession | undefined): boolean => {
      if (!open) {
        return false;
      }
      open = false;
      inFlight.delete(settled);
      resolveSettled(outcome === undefined ? undefined : Object.freeze(outcome));
      return true;
    };

    return Object.freeze({
      endpoint,
      settled,
      adopted: (sessionId: string): void => {
        settle({ sessionId, endpoint });
      },
      orphaned: (sessionId: string): boolean => {
        if (!open) {
          return handedOver;
        }
        // Recorded before the ticket resolves, so a routine waiting on it finds
        // the session when it resumes.
        handedOver = this.shutdownBegun && !this.orphansClaimed;
        if (handedOver) {
          this.orphanedSessions.push(Object.freeze({ sessionId, endpoint }));
        }
        settle({ sessionId, endpoint });
        return handedOver;
      },
      none: (): void => {
        settle(undefined);
      },
    });
  }

  /**
   * Hands the shutdown routine every session a create produced after shutdown
   * began that nobody adopted, oldest first, and closes the hand-over: a ticket
   * orphaned later answers `false`, so its creator ends the session itself.
   * Call it once, after waiting for {@link sessionCreatesInFlight}.
   *
   * @returns The claimed sessions with their owning endpoints.
   */
  claimOrphanedSessions(): readonly CreatedSession[] {
    this.orphansClaimed = true;
    const claimed = Object.freeze(this.orphanedSessions);
    this.orphanedSessions = [];
    return claimed;
  }

  // -------------------------------------------------------------------------
  // Connection and service
  // -------------------------------------------------------------------------

  /**
   * Records the WebSocket client's state (`onStateChange` of the protocol's
   * `ReconnectingWsClient`), so the status bar and the DevTools
   * `ConnectionStatus` pill use one vocabulary.
   */
  setConnectionStatus(status: ConnectionState): void {
    if (this.isDisposed || status === this.connectionStatusValue) {
      return;
    }
    this.connectionStatusValue = status;
    this.markChanged();
  }

  /**
   * Records whether the service's `GET /health` answered. "Service not running"
   * is a renderable state — `false` here together with a `closed` connection —
   * never an exception.
   */
  setServiceReachable(reachable: boolean): void {
    if (this.isDisposed || reachable === this.serviceReachableValue) {
      return;
    }
    this.serviceReachableValue = reachable;
    this.markChanged();
  }

  /**
   * Records a changed `debuggen.serviceUrl` setting. A blank value is ignored so
   * the status bar keeps naming the URL the host is actually using.
   */
  setServiceUrl(url: string): void {
    const trimmed = url.trim();
    if (this.isDisposed || !trimmed || trimmed === this.serviceUrlValue) {
      return;
    }
    this.serviceUrlValue = trimmed;
    this.markChanged();
  }

  /**
   * Records the model provider: the service's `GET /health` answer when
   * available, otherwise the configured `debuggen.provider`. A blank value is
   * ignored so the status bar never goes empty.
   */
  setProvider(provider: string): void {
    const trimmed = provider.trim();
    if (this.isDisposed || !trimmed || trimmed === this.providerValue) {
      return;
    }
    this.providerValue = trimmed;
    this.markChanged();
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Applies a whole session record — from `session.created`, `session.updated`,
   * or `GET /sessions/:id` when the active session is re-read after a reconnect.
   *
   * A record of the active session is merged into it; for that session, a
   * record older than the one held (`updatedAt`) is a stale answer that crossed
   * a newer push and is ignored. `ended` is terminal, so status decides before
   * time: a record that is not `ended` of a session the store has acknowledged
   * as ended ({@link hasAcknowledgedEnd}) is ignored everywhere, whatever its
   * `updatedAt`, and an `ended` record replaces a record that is not, whatever
   * the held one's. A record of any other session only refreshes
   * that session's entry in {@link sessionList}, so the tree shows its latest
   * status without the view switching away from the session the developer is
   * looking at. Such a record never becomes the active session on its own —
   * not even while no session is active, because it may belong to another
   * window: only {@link adoptSession} decides which session this editor tracks.
   * While a {@link SessionCreationWindow} is open, the record is also held for
   * replay, so the session being created loses no update that beat the HTTP
   * answer naming it.
   *
   * Every member the record can supply is re-derived from it, which is what
   * makes the reopen path and the live path identical; see the module
   * documentation for the merge rules that keep a push-established fact from
   * regressing when a record arrives out of order.
   *
   * Only a record that becomes the active session is cloned and kept. Any
   * other record contributes its list row alone — a fresh projection that
   * shares nothing with `session` — so a frequently re-broadcast session the
   * developer is not viewing costs one small row, never a copy of its plans,
   * diffs and analyses.
   */
  applySessionRecord(session: SessionRecord): void {
    if (this.isDisposed) {
      return;
    }
    const record = own(session);
    if (this.isAcknowledgedEnded(record.id) && record.status !== 'ended') {
      // A record the service sent before the end, delivered late: it may no
      // longer replace anything, and is not held for replay either.
      return;
    }
    this.acknowledgeEnd(record);
    const listChanged = this.refreshListedSession(record);

    const active = this.sessionValue;
    const admitted = this.admitsFrame(record.id, record, (held) => {
      this.applySessionRecord(held);
    });
    if (!admitted || active === undefined || !supersedes(record, active)) {
      if (listChanged) {
        this.markChanged();
      }
      return;
    }

    this.deriveFromRecord(record);
  }

  /**
   * Makes `session` the active session — the only way a session becomes active.
   *
   * A record of the session already active is merged exactly as
   * {@link applySessionRecord} merges it, so reopening the session in view
   * resets nothing. A record of any other session replaces the active one in a
   * single batch: session-scoped state is reset ({@link resetSession}) and every
   * member is re-derived from the record, so nothing of the previous session
   * lingers and listeners never observe the gap between the two. Once
   * {@link beginShutdown} ran, nothing is adopted.
   *
   * The store performs no I/O, so it cannot end the session it replaces. The
   * commands that call this first have the service answer `session.end` for a
   * live active session with a settled cleanup (`endBeforeReplacing` in
   * `src/commands/end-session.ts`), which is what keeps the single-session end
   * of `deactivate()` sufficient (AAP §0.5.1).
   *
   * @param session The record to adopt, typically the service's answer to
   *   `POST /sessions` or `GET /sessions/:id`.
   * @param endpoint The service base URL that request was sent to, captured
   *   before it was sent. It becomes {@link activeSessionEndpoint} when a
   *   different session becomes active; a merge of the active session keeps the
   *   endpoint already held, because the session has not moved.
   */
  adoptSession(session: SessionRecord, endpoint: string): void {
    if (this.isDisposed || this.shutdownBegun) {
      return;
    }
    if (this.isActiveSession(session.id)) {
      this.applySessionRecord(session);
      return;
    }
    const incoming = own(session);
    // A session acknowledged as ended is adopted as ended: an answer that is
    // not `ended` can only predate its end (see `supersedes`).
    const record =
      incoming.status === 'ended' ? incoming : (this.acknowledgedEndOf(incoming.id) ?? incoming);
    this.acknowledgeEnd(record);
    this.batch(() => {
      this.resetSession();
      this.sessionEndpointValue = endpoint;
      this.refreshListedSession(record);
      this.deriveFromRecord(record);
    });
  }

  /**
   * Opens a {@link SessionCreationWindow} for a session about to be created
   * (`POST /sessions`) or reopened (`GET /sessions/:id`).
   *
   * Until the window closes, every session-scoped frame for a session other
   * than the active one — records, progress rows, instrumentation, capture,
   * analysis, panel and cleanup frames — is held in arrival order, at most
   * {@link MAX_HELD_FRAMES} of them. Holding is in addition to what the store
   * already does with such a frame: a record still refreshes
   * {@link sessionList}. Frames of the active session apply immediately, as
   * always. Several windows may be open at once; each holds its own list, so
   * closing one never disturbs another. On a disposed store, or once
   * {@link beginShutdown} ran, the window is born closed.
   *
   * @returns The window; close it with `adopt` or `abandon` on every path.
   */
  beginSessionCreation(): SessionCreationWindow {
    const buffers = this.creationBuffers;
    const buffer: CreationBuffer = { frames: [], dropped: 0 };
    if (!this.isDisposed && !this.shutdownBegun) {
      buffers.add(buffer);
    }
    /** Closes the window; its held frames when it was open, else `undefined`. */
    const close = (): readonly HeldFrame[] | undefined =>
      buffers.delete(buffer) ? buffer.frames.splice(0) : undefined;

    return Object.freeze({
      get isOpen(): boolean {
        return buffers.has(buffer);
      },
      get droppedFrames(): number {
        return buffer.dropped;
      },
      adopt: (record: SessionRecord, endpoint: string): void => {
        const frames = close();
        if (frames !== undefined) {
          this.adoptWithHeldFrames(record, endpoint, frames);
        }
      },
      abandon: (): void => {
        close();
      },
    });
  }

  /**
   * Records the service's answer to `session.end` (`POST /sessions/:id/end`)
   * for the active session, so the view shows it ended even when no socket
   * delivers the `session.updated` and `cleanup.completed` that follow.
   *
   * A new frozen record is derived from the held one: status `ended`, the tab
   * binding removed (an ended session is unbound), and `updatedAt` unchanged so
   * that the service's own final `ended` record, which is at least as recent,
   * replaces it. From here on the session is acknowledged as ended
   * ({@link hasAcknowledgedEnd}): the records the service broadcast before its
   * end — cleanup recorded on a session not yet `ended` — may arrive later and
   * with a newer `updatedAt`, and none of them replaces this one. The
   * capture window is closed. The cleanup state takes the answered status,
   * keeping the conflicts already reported for this session and stamping
   * `completedAt` with the host clock unless the answer is `pending`; a
   * finished cleanup `cleanup.completed` already reported is never regressed to
   * `pending`. An answer about any other session changes nothing.
   *
   * @param sessionId The session `session.end` was sent for.
   * @param response The service's answer.
   */
  applySessionEnded(sessionId: string, response: SessionEndResponse): void {
    const session = this.sessionValue;
    if (this.isDisposed || session === undefined || session.id !== sessionId) {
      return;
    }
    const cleanup = this.endedCleanup(sessionId, response.cleanup);
    const ended: SessionRecord = { ...session, status: 'ended', cleanup };
    delete ended.boundTab;
    const record = deepFreeze(ended);
    this.sessionValue = record;
    this.acknowledgeEnd(record);
    this.refreshListedSession(record);
    const capture = this.captureValue;
    if (capture.active) {
      this.captureValue = Object.freeze({ ...capture, active: false });
    }
    this.cleanupValue = cleanup;
    this.cleanupSessionId = sessionId;
    this.markChanged();
  }

  /**
   * Records the active session's modification journal as
   * `GET /sessions/:id/modifications` answered it — how the view learns each
   * record's final status, diff and backup path when no `session.updated` can
   * reach this window (the socket is closed or reconnecting).
   *
   * The journal is append-only and every status only moves forward, so the
   * answer is merged rather than swapped in: records are taken in the
   * journal's order, a held record the answer does not list yet is kept after
   * them (the answer predates the push that reported it), and a held record
   * whose status is further along than the answer's
   * (`pending` → `applied` → `failed` | `conflict` → `reverted`) is kept, so an
   * answer computed before a push never regresses it. Unlike the live
   * instrumentation frames, the journal is applied to a session acknowledged
   * as ended: it is the post-cleanup journal, and it only completes what the
   * session did. An answer about any session other than the active one
   * changes nothing.
   *
   * `total` is the journal's length as the service counted it. It raises
   * {@link modificationsTotal} and never lowers it: two reads can overlap and
   * finish in either order, and the journal only grows, so the larger count is
   * the newer one. A value that is not a non-negative safe integer is ignored,
   * and an omitted one keeps the total already held. Because the merge puts the
   * answer's records first, a caller that reads the journal in several pages
   * gathers every page and applies them in one call.
   *
   * @param sessionId The session the journal was requested for.
   * @param journal The service's answer, in applied order.
   * @param total The journal's `total`, when the read reported one.
   * @returns Whether the journal was recorded for the active session.
   *
   * @example
   * ```ts
   * const read = await readModificationJournal(client, id, { endpoint: state.activeSessionEndpoint });
   * if (isOk(read)) state.applyModificationJournal(id, read.value.modifications, read.value.total);
   * ```
   */
  applyModificationJournal(
    sessionId: string,
    journal: readonly ModificationRecord[],
    total?: number,
  ): boolean {
    if (this.isDisposed || this.sessionValue?.id !== sessionId) {
      return false;
    }
    if (total !== undefined && Number.isSafeInteger(total) && total >= 0) {
      const known = this.modificationsTotalValue;
      this.modificationsTotalValue = known === undefined ? total : Math.max(known, total);
    }
    const held = new Map(this.modificationsValue.map((record) => [record.id, record]));
    const listed = new Set<string>();
    const merged: ModificationRecord[] = [];
    for (const incoming of own([...journal])) {
      if (incoming.sessionId !== sessionId || listed.has(incoming.id)) {
        continue;
      }
      listed.add(incoming.id);
      const kept = held.get(incoming.id);
      merged.push(
        kept !== undefined &&
          MODIFICATION_STATUS_RANK[kept.status] > MODIFICATION_STATUS_RANK[incoming.status]
          ? kept
          : incoming,
      );
    }
    for (const kept of this.modificationsValue) {
      if (!listed.has(kept.id)) {
        merged.push(kept);
      }
    }
    this.modificationsValue = Object.freeze(merged);
    this.markChanged();
    return true;
  }

  /**
   * Replaces the Sessions tree's list with the answer of one load of
   * `GET /sessions`: the rows gathered and the listing's `total`.
   *
   * The tree reads from here and keeps no copy of its own; it calls this once
   * per load, after its last page, so a view never renders a partly gathered
   * list. The active session's view is not touched: pushes are authoritative
   * for the session in view.
   *
   * An answer computed before a session ended can arrive after the store saw
   * it end; for a session the store has acknowledged as ended
   * ({@link hasAcknowledgedEnd}), a listed row that is not `ended` is
   * therefore replaced by the projection of the acknowledged `ended` record,
   * so the tree never shows an ended session live again.
   *
   * `total` is stored as the service counted it. The one value it cannot
   * truthfully hold — fewer sessions than the rows themselves — is raised to
   * the row count, so `sessionListTotal - sessionList.length` is never negative
   * for a reader.
   *
   * @example
   * ```ts
   * // After walking every page into `gathered`, with the last page's `total`:
   * state.setSessionList({ sessions: gathered, total });
   * ```
   */
  setSessionList(page: SessionListPage): void {
    if (this.isDisposed) {
      return;
    }
    const sessions = Object.freeze(
      own([...page.sessions]).map((row) => {
        if (row.status === 'ended') {
          return row;
        }
        const ended = this.acknowledgedEndOf(row.id);
        return ended === undefined ? row : deepFreeze(toSessionListItem(ended));
      }),
    );
    this.sessionListValue = sessions;
    this.sessionListTotalValue =
      Number.isSafeInteger(page.total) && page.total > sessions.length
        ? page.total
        : sessions.length;
    this.markChanged();
  }

  /**
   * Clears session-scoped state ahead of adopting a different session;
   * {@link adoptSession} calls it inside the same batch as the adoption, so
   * listeners never see the empty state in between.
   *
   * Clears the session and its owning endpoint, its progress rows, relevant
   * files, modifications and their counted total, instrumentation report,
   * analysis, panel summary, target, capture window and failure; a new
   * session never inherits the previous session's target.
   * Keeps the connection, provider, service URL and {@link sessionList};
   * keeps the pairing code, which belongs to the Chrome extension rather than
   * to any session; and keeps the previous session's cleanup status visible
   * until the next session's record replaces it, so "files restored" does not
   * vanish the moment the developer starts typing a new question.
   */
  resetSession(): void {
    if (this.isDisposed) {
      return;
    }
    this.sessionValue = undefined;
    this.sessionEndpointValue = undefined;
    this.progressValue = Object.freeze([]);
    this.relevantFilesValue = Object.freeze([]);
    this.modificationsValue = Object.freeze([]);
    this.modificationsTotalValue = undefined;
    this.runtimeHooksValue = Object.freeze([]);
    this.unavailableSignalsValue = Object.freeze([]);
    this.analysisValue = undefined;
    this.latestPanelValue = undefined;
    this.captureValue = IDLE_CAPTURE;
    this.failureValue = undefined;
    this.targetValue = undefined;
    this.targetRecordUpdatedAt = undefined;
    this.markChanged();
  }

  /**
   * Upserts one `session.progress` row into the active session's list.
   *
   * A stage can report more than once in a session — a follow-up that needs a
   * new capture runs `plan`, `instrument` and `capture` again after `followup`
   * (AAP §0.4.2) — so a row is matched only within its stage's **latest
   * episode**: the last contiguous run of rows of that stage, found by
   * scanning back from the end of the list.
   *
   * - **No run of the stage yet:** the row is appended.
   * - **A new episode:** when that run is not the tail of the list and the row
   *   is `running` — a stage header opening again after other stages reported —
   *   the row is appended, so the second episode lands after the stages that
   *   preceded it and the first episode's rows are left exactly as they were.
   * - **Otherwise** the row with the same `message` inside that run is
   *   replaced in place: `running` becoming `done` or `failed` keeps its
   *   position, and a `done` row the service re-announces for a run that is no
   *   longer the tail is replaced, never duplicated. A replaced row keeps the
   *   receipt time it first arrived with (`ts`), which is its identity in the
   *   view. A row with no such match is appended.
   *
   * Receipt times are unique and increase along the list: a frame received in
   * the same millisecond as the newest row (or after the clock stepped back)
   * is stamped one millisecond after it. Together with the in-place
   * replacement keeping `ts`, every row keeps one identity for as long as it
   * is held, whatever is appended after it or compacted before it.
   *
   * The list is exactly what the service sent, in the order it sent it:
   * nothing is synthesised, reordered into a template or filled in
   * (AAP §0.5.4). Past {@link MAX_PROGRESS_ENTRIES} the oldest episodes are
   * compacted to their header and failed rows by {@link boundProgress}, so
   * every episode stays summarised and no failure is lost. Each call copies
   * the held list once (and compacts only past the bound).
   *
   * Progress of any session other than the active one is not applied (it is
   * held while a {@link SessionCreationWindow} is open, and stamped when
   * replayed). A `running` row of a session acknowledged as ended
   * ({@link hasAcknowledgedEnd}) is a delayed frame that would show the
   * session working again, and is ignored; its `done` and `failed` rows still
   * apply.
   *
   * @example
   * ```ts
   * // … generate-panel ✓ · followup ✓ · then a second plan episode:
   * state.applyProgress({ sessionId, stage: 'plan', status: 'running', message });
   * // → appended after the follow-up row; the first plan row is untouched.
   * ```
   */
  applyProgress(payload: SessionProgressPayload): void {
    if (
      this.isDisposed ||
      !this.admitsFrame(payload.sessionId, payload, (held) => {
        this.applyProgress(held);
      }) ||
      (payload.status === 'running' && this.isLiveFrameOfEndedSession(payload.sessionId))
    ) {
      return;
    }
    const held = this.progressValue;
    // Receipt times strictly increase along the list (the newest row is always
    // last), so no two held rows share one even when frames arrive within the
    // same millisecond or the wall clock steps back.
    const newest = held.at(-1);
    const receivedAt = newest === undefined ? this.now() : Math.max(this.now(), newest.ts + 1);
    const entry: ProgressEntry = Object.freeze({
      stage: payload.stage,
      status: payload.status,
      message: payload.message,
      ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
      ts: receivedAt,
    });

    // The stage's latest episode: the last contiguous run of its rows.
    let episodeLast = held.length - 1;
    while (episodeLast >= 0 && held[episodeLast]?.stage !== entry.stage) {
      episodeLast -= 1;
    }
    let replaceAt = -1;
    if (episodeLast >= 0) {
      let episodeFirst = episodeLast;
      while (episodeFirst > 0 && held[episodeFirst - 1]?.stage === entry.stage) {
        episodeFirst -= 1;
      }
      const opensNewEpisode = episodeLast !== held.length - 1 && entry.status === 'running';
      if (!opensNewEpisode) {
        for (let index = episodeFirst; index <= episodeLast; index += 1) {
          if (held[index]?.message === entry.message) {
            replaceAt = index;
            break;
          }
        }
      }
    }

    let rows: ProgressEntry[];
    const replaced = replaceAt === -1 ? undefined : held[replaceAt];
    if (replaced === undefined) {
      rows = [...held, entry];
    } else {
      rows = held.slice();
      // The row keeps the time it first arrived: that time is its identity in the
      // view, so a row moving from running to done is updated, never remounted.
      rows[replaceAt] = Object.freeze({ ...entry, ts: replaced.ts });
    }
    this.progressValue = Object.freeze(boundProgress(rows));
    this.markChanged();
  }

  // -------------------------------------------------------------------------
  // Instrumentation
  // -------------------------------------------------------------------------

  /**
   * Records an `instrumentation.plan` on the active session's record.
   *
   * Plans are kept by `planVersion` in ascending order, the last being the one
   * installed — the record's own convention — so a plan pushed before the next
   * `session.updated` is visible to `ProgressSteps` and `RelevantFiles` at
   * once. A plan re-sent under a version already held replaces it. The held
   * record is never mutated; a new frozen record is derived from it. A plan of
   * a session acknowledged as ended is a delayed frame and is ignored.
   */
  applyInstrumentationPlan(payload: InstrumentationPlanPayload): void {
    const session = this.sessionValue;
    if (
      this.isDisposed ||
      !this.admitsFrame(payload.sessionId, payload, (held) => {
        this.applyInstrumentationPlan(held);
      }) ||
      session === undefined ||
      this.isLiveFrameOfEndedSession(payload.sessionId)
    ) {
      return;
    }
    const plan: InstrumentationPlan = own(payload.plan);
    const plans = session.plans.filter((held) => held.planVersion !== plan.planVersion);
    plans.push(plan);
    plans.sort((left, right) => left.planVersion - right.planVersion);
    this.sessionValue = deepFreeze<SessionRecord>({ ...session, plans });
    this.markChanged();
  }

  /**
   * Records an `instrumentation.ready` report.
   *
   * `applied` lists the modification records *this* install produced — for a
   * follow-up plan version, only the delta — so the records are upserted by id
   * into the session's journal, in applied order, rather than replacing it.
   * The runtime hooks and, crucially, the `unavailable` signals are kept whole:
   * a partially enabled capture must stay visible as such (AAP §0.5.5). A
   * failure previously reported for the instrumentation stage is superseded by
   * this success and cleared; a failure of any other stage is left alone. A
   * report of a session acknowledged as ended is a delayed frame — its
   * `applied` records would regress the journal cleanup has since reverted,
   * and its hooks are disabled — and is ignored.
   */
  applyInstrumentationReady(payload: InstrumentationReadyPayload): void {
    if (
      this.isDisposed ||
      !this.admitsFrame(payload.sessionId, payload, (held) => {
        this.applyInstrumentationReady(held);
      }) ||
      this.isLiveFrameOfEndedSession(payload.sessionId)
    ) {
      return;
    }
    const report = own({
      applied: payload.applied,
      runtimeHooks: payload.runtimeHooks,
      unavailable: payload.unavailable,
    });
    this.modificationsValue = this.upsertModifications(this.modificationsValue, report.applied);
    this.runtimeHooksValue = report.runtimeHooks;
    this.unavailableSignalsValue = report.unavailable;
    if (this.failureValue?.stage === INSTRUMENTATION_STAGE) {
      this.failureValue = undefined;
    }
    this.markChanged();
  }

  /**
   * Records an `instrumentation.failed` as the instrumentation stage's failure,
   * with the service's code, message and hint. The analysis is never touched:
   * a failure is its own field and cannot be mistaken for a result. A failure
   * of a session acknowledged as ended is a delayed frame — it would offer a
   * retry on a session that can no longer change — and is ignored.
   */
  applyInstrumentationFailed(payload: InstrumentationFailedPayload): void {
    if (
      this.isDisposed ||
      !this.admitsFrame(payload.sessionId, payload, (held) => {
        this.applyInstrumentationFailed(held);
      }) ||
      this.isLiveFrameOfEndedSession(payload.sessionId)
    ) {
      return;
    }
    this.setStageFailure({
      stage: INSTRUMENTATION_STAGE,
      code: payload.error.code,
      message: payload.error.message,
      hint: payload.error.hint,
    });
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  /**
   * Records `capture.started`: the capture window is open.
   *
   * The counter starts at `0` and the host does not advance it. While a capture
   * runs the extension host receives no telemetry at all — `telemetry.tail`
   * goes to the DevTools panel only (AAP §0.4.2) — so the host has nothing to
   * count, and inventing a number would be exactly the faked result
   * AAP §0.5.4 forbids. The view renders a capturing indicator instead. The
   * only number that may replace the `0` mid-capture is the service's own
   * ingest counter, when a later `session.updated` carries it on the in-flight
   * capture record (see {@link applySessionRecord}). A capture of a session
   * acknowledged as ended cannot be running, so such a frame is a delayed one
   * and is ignored.
   */
  applyCaptureStarted(payload: CaptureStartedPayload): void {
    if (
      this.isDisposed ||
      !this.admitsFrame(payload.sessionId, payload, (held) => {
        this.applyCaptureStarted(held);
      }) ||
      this.isLiveFrameOfEndedSession(payload.sessionId)
    ) {
      return;
    }
    this.captureValue = Object.freeze({
      active: true,
      captureId: payload.captureId,
      eventCount: 0,
    });
    this.markChanged();
  }

  /**
   * Records `capture.stopped`: the window is closed and its event count is the
   * total the service's `CaptureSummary` reports. A capture that yielded
   * nothing legitimately reports `0`.
   */
  applyCaptureStopped(payload: CaptureStoppedPayload): void {
    if (
      this.isDisposed ||
      !this.admitsFrame(payload.sessionId, payload, (held) => {
        this.applyCaptureStopped(held);
      })
    ) {
      return;
    }
    this.captureValue = Object.freeze({
      active: false,
      captureId: payload.captureId,
      eventCount: payload.summary.eventCount,
    });
    this.markChanged();
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  /**
   * Records `analysis.completed`'s validated analysis and clears the failure it
   * supersedes. An analysis older (by `analysisVersion`) than the one held is
   * ignored entirely — it neither replaces a follow-up's newer result nor
   * clears a failure reported after it.
   */
  applyAnalysis(analysis: AnalysisResult): void {
    if (
      this.isDisposed ||
      !this.admitsFrame(analysis.sessionId, analysis, (held) => {
        this.applyAnalysis(held);
      })
    ) {
      return;
    }
    const incoming = own(analysis);
    const newest = this.newerAnalysis(incoming, this.analysisValue);
    if (newest !== incoming) {
      return;
    }
    this.analysisValue = incoming;
    this.failureValue = undefined;
    this.markChanged();
  }

  /**
   * Records `panel.generated` as a {@link PanelSummary}: id, title, version and
   * the fallback flag. The full specification is the DevTools panel's to
   * render; the editor only links to it. The fallback flag is kept so the view
   * labels a deterministic fallback panel as such rather than presenting it as
   * an answer (AAP §0.5.5).
   */
  applyPanelGenerated(payload: PanelGeneratedPayload): void {
    if (
      this.isDisposed ||
      !this.admitsFrame(payload.sessionId, payload, (held) => {
        this.applyPanelGenerated(held);
      })
    ) {
      return;
    }
    const { panel } = payload;
    this.latestPanelValue = Object.freeze({
      id: payload.panelId,
      title: panel.title,
      panelVersion: panel.panelVersion,
      fallback: panel.meta?.fallback === true,
    });
    this.markChanged();
  }

  /**
   * Records `cleanup.completed`. The payload has no timestamp — its arrival is
   * the time — so `completedAt` is stamped with the host clock here, and the
   * service's own stamp replaces it with the next record. The status stays
   * visible after the session ends and across {@link resetSession}, until the
   * next session's record brings that session's own cleanup state.
   */
  applyCleanupCompleted(payload: CleanupCompletedPayload): void {
    if (
      this.isDisposed ||
      !this.admitsFrame(payload.sessionId, payload, (held) => {
        this.applyCleanupCompleted(held);
      })
    ) {
      return;
    }
    this.cleanupValue = own<SessionCleanupState>({
      status: payload.status,
      completedAt: this.now(),
      conflicts: payload.conflicts,
    });
    this.cleanupSessionId = payload.sessionId;
    this.markChanged();
  }

  // -------------------------------------------------------------------------
  // Pairing and failures
  // -------------------------------------------------------------------------

  /**
   * Shows the one-time pairing code from `POST /pair/start` until it expires.
   *
   * Only `code` and `expiresAt` are copied, so nothing else an object may carry
   * can enter the store; the code is a short-lived capability, never a
   * credential (AAP §0.5.6). A value that cannot be shown — a blank code, a
   * non-finite or already-passed expiry — clears any code on display instead.
   * A timer notifies the views the moment the code expires, and the snapshot
   * omits an expired code regardless of that timer.
   */
  setPairing(pairing: PairingState): void {
    if (this.isDisposed) {
      return;
    }
    const code = pairing.code;
    const expiresAt = pairing.expiresAt;
    if (!code || !Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      this.clearPairing();
      return;
    }
    this.pairingValue = Object.freeze({ code, expiresAt });
    this.schedulePairingExpiry();
    this.markChanged();
  }

  /** Removes the pairing code from display (paired, dismissed or replaced). */
  clearPairing(): void {
    if (this.isDisposed) {
      return;
    }
    this.cancelPairingTimer();
    if (this.pairingValue === undefined) {
      return;
    }
    this.pairingValue = undefined;
    this.markChanged();
  }

  /**
   * Records a failed stage, rendered by the view with its message, hint and a
   * retry action (AAP §0.5.5). Held apart from the analysis and the panel, so
   * no code path can present a failure as a result. Only the four fields of
   * {@link StageFailure} are copied.
   */
  setStageFailure(failure: StageFailure): void {
    if (this.isDisposed) {
      return;
    }
    this.failureValue = Object.freeze({
      stage: failure.stage,
      code: failure.code,
      message: failure.message,
      ...(failure.hint !== undefined ? { hint: failure.hint } : {}),
    });
    this.markChanged();
  }

  /** Clears the failed stage, e.g. when the developer retries it. */
  clearStageFailure(): void {
    if (this.isDisposed || this.failureValue === undefined) {
      return;
    }
    this.failureValue = undefined;
    this.markChanged();
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  /**
   * The whole {@link WebviewState} the webview renders, as an independent,
   * JSON-serializable structured clone: every array and object in it is a copy,
   * so a consumer mutating what it received cannot affect the store. An
   * expired pairing code is omitted.
   */
  toWebviewState(): WebviewState {
    const session = this.sessionValue;
    const analysis = this.analysisValue;
    const latestPanel = this.latestPanelValue;
    const target = this.targetValue;
    const pairing = this.pairing;
    const failure = this.failureValue;
    const modificationsTotal = this.modificationsTotalValue;
    const snapshot: WebviewState = {
      connection: {
        status: this.connectionStatusValue,
        serviceUrl: this.serviceUrlValue,
        serviceReachable: this.serviceReachableValue,
        provider: this.providerValue,
      },
      ...(session !== undefined ? { session } : {}),
      progress: this.progressValue,
      relevantFiles: this.relevantFilesValue,
      modifications: this.modificationsValue,
      ...(modificationsTotal !== undefined ? { modificationsTotal } : {}),
      ...(analysis !== undefined ? { analysis } : {}),
      ...(latestPanel !== undefined ? { latestPanel } : {}),
      ...(target !== undefined ? { target } : {}),
      capture: this.captureValue,
      cleanup: this.cleanupValue,
      ...(pairing !== undefined ? { pairing } : {}),
      ...(failure !== undefined ? { failure } : {}),
    };
    return structuredClone(snapshot);
  }

  // -------------------------------------------------------------------------
  // Private: notification
  // -------------------------------------------------------------------------

  /** Marks the store changed and, outside a batch, queues the one flush. */
  private markChanged(): void {
    if (this.isDisposed) {
      return;
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  /** Queues a flush on the microtask queue unless one is queued or held back. */
  private scheduleFlush(): void {
    if (this.flushScheduled || this.batchDepth > 0 || this.isDisposed) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  /** Fires one snapshot when something changed and nothing holds the flush back. */
  private flush(): void {
    if (this.isDisposed || !this.dirty || this.batchDepth > 0) {
      return;
    }
    this.dirty = false;
    this.emitter.fire(this.toWebviewState());
  }

  // -------------------------------------------------------------------------
  // Private: session-record merges
  // -------------------------------------------------------------------------

  /** Whether `sessionId` names the active session. */
  private isActiveSession(sessionId: string): boolean {
    return this.sessionValue !== undefined && this.sessionValue.id === sessionId;
  }

  /**
   * Whether a frame for `sessionId` applies now — exactly when it names the
   * active session.
   *
   * A frame for any other session is not applied. While at least one
   * {@link SessionCreationWindow} is open it is held by every open window: an
   * owned copy of `payload` is taken once (so a caller mutating its object
   * later cannot change what is replayed), and `apply` re-runs the mutator
   * with it on adoption. A window already holding {@link MAX_HELD_FRAMES}
   * counts the frame as dropped instead.
   */
  private admitsFrame<T>(sessionId: string, payload: T, apply: (held: T) => void): boolean {
    if (this.isActiveSession(sessionId)) {
      return true;
    }
    if (this.creationBuffers.size > 0) {
      const held = own(payload);
      const frame: HeldFrame = Object.freeze({
        sessionId,
        replay: () => {
          apply(held);
        },
      });
      for (const buffer of this.creationBuffers) {
        if (buffer.frames.length < MAX_HELD_FRAMES) {
          buffer.frames.push(frame);
        } else {
          buffer.dropped += 1;
        }
      }
    }
    return false;
  }

  /**
   * Adopts `session` and replays, in arrival order and inside the same batch,
   * the held frames that name it; frames of any other session are discarded.
   * Each replayed frame goes through its public mutator, which now finds its
   * session active and applies it under the usual merge rules.
   */
  private adoptWithHeldFrames(
    session: SessionRecord,
    endpoint: string,
    frames: readonly HeldFrame[],
  ): void {
    if (this.isDisposed) {
      return;
    }
    this.batch(() => {
      this.adoptSession(session, endpoint);
      for (const frame of frames) {
        if (frame.sessionId === session.id) {
          frame.replay();
        }
      }
    });
  }

  /**
   * Makes `record` — owned, of the active session or of the session being
   * adopted — the held record and re-derives every member it can supply, under
   * the merge rules of the module documentation.
   */
  private deriveFromRecord(record: SessionRecord): void {
    this.sessionValue = record;
    this.relevantFilesValue = record.relevantFiles;
    this.modificationsValue = this.mergeModifications(record.modifications);
    this.analysisValue = this.newerAnalysis(record.analyses.at(-1), this.analysisValue);
    this.latestPanelValue = this.panelStillCurrent(record.panelIds);
    this.captureValue = this.mergeCapture(record.captures);
    this.cleanupValue = this.mergeCleanup(record);
    this.cleanupSessionId = record.id;
    this.applyRecordTarget(record);
    this.markChanged();
  }

  /**
   * The `ended` record by which the store acknowledged `sessionId` as ended,
   * or `undefined` when it holds none: the remembered end, else the active
   * session's own record when it is ended. The Sessions tree's rows are list
   * projections, not records, so an ended row is asked about separately
   * ({@link isAcknowledgedEnded}).
   */
  private acknowledgedEndOf(sessionId: string): SessionRecord | undefined {
    const remembered = this.acknowledgedEnds.get(sessionId);
    if (remembered !== undefined) {
      return remembered;
    }
    const active = this.sessionValue;
    return active !== undefined && active.id === sessionId && active.status === 'ended'
      ? active
      : undefined;
  }

  /**
   * Whether the store has acknowledged `sessionId` as ended: by a remembered
   * or active `ended` record ({@link acknowledgedEndOf}), or by an `ended` row
   * of the Sessions tree.
   */
  private isAcknowledgedEnded(sessionId: string): boolean {
    return (
      this.acknowledgedEndOf(sessionId) !== undefined ||
      this.sessionListValue.some((listed) => listed.id === sessionId && listed.status === 'ended')
    );
  }

  /**
   * Remembers `record` — owned — as its session's acknowledged end when it is
   * `ended` and at least as recent as the end already remembered. The most
   * recently acknowledged ends are kept, at most {@link MAX_ACKNOWLEDGED_ENDS}.
   */
  private acknowledgeEnd(record: SessionRecord): void {
    if (record.status !== 'ended') {
      return;
    }
    const remembered = this.acknowledgedEnds.get(record.id);
    if (remembered !== undefined && record.updatedAt < remembered.updatedAt) {
      return;
    }
    // Re-inserted, so the map's iteration order is acknowledgement order.
    this.acknowledgedEnds.delete(record.id);
    this.acknowledgedEnds.set(record.id, record);
    for (const oldest of this.acknowledgedEnds.keys()) {
      if (this.acknowledgedEnds.size <= MAX_ACKNOWLEDGED_ENDS) {
        break;
      }
      this.acknowledgedEnds.delete(oldest);
    }
  }

  /**
   * Whether a live frame of `sessionId` — one that would show the session
   * capturing, instrumenting or failing again — must be ignored
   * because the store has acknowledged the session as ended. Frames that only
   * complete what the session did before it ended (`capture.stopped`,
   * `analysis.completed`, `panel.generated`, `cleanup.completed`) are not
   * asked about.
   */
  private isLiveFrameOfEndedSession(sessionId: string): boolean {
    return this.isAcknowledgedEnded(sessionId);
  }

  /**
   * Replaces the {@link sessionList} row for `record`'s session with the
   * record's projection (`toSessionListItem`) when `record` supersedes the
   * listed row (see `supersedes`: an `ended` row is never replaced by a record
   * that is not). Sessions are never added here: the list is `GET /sessions`'s
   * answer, and the tree refreshes it for new sessions. `total` is unchanged —
   * a row is refreshed, not added.
   *
   * The row is built from `record` without cloning it — the projection copies
   * scalars into fresh objects — and only the row is kept, so the list never
   * retains a whole record. A record whose row equals the listed one (a replay
   * of a stored session, say) leaves the list as it is and reports no change.
   *
   * @param record A session record, possibly the caller's own object.
   * @returns Whether the list changed.
   */
  private refreshListedSession(record: SessionRecord): boolean {
    const index = this.sessionListValue.findIndex((listed) => listed.id === record.id);
    const listed = this.sessionListValue[index];
    if (listed === undefined || !supersedes(record, listed)) {
      return false;
    }
    const row = toSessionListItem(record);
    if (sameListRow(listed, row)) {
      return false;
    }
    const sessions = [...this.sessionListValue];
    sessions[index] = deepFreeze(row);
    this.sessionListValue = Object.freeze(sessions);
    return true;
  }

  /**
   * The record's modification journal, followed by any record the store holds
   * that the journal does not list yet.
   *
   * The journal is append-only — a modification changes status but is never
   * removed — so a held record missing from an incoming journal means the
   * incoming record predates the `instrumentation.ready` that reported it. For
   * a current record the result is exactly `record.modifications`.
   */
  private mergeModifications(
    journal: readonly ModificationRecord[],
  ): readonly ModificationRecord[] {
    const listed = new Set(journal.map((modification) => modification.id));
    const unlisted = this.modificationsValue.filter((held) => !listed.has(held.id));
    return unlisted.length === 0 ? journal : Object.freeze([...journal, ...unlisted]);
  }

  /**
   * `held` with every record of `incoming` upserted by id: an existing record
   * is replaced in place, a new one appended, preserving applied order.
   */
  private upsertModifications(
    held: readonly ModificationRecord[],
    incoming: readonly ModificationRecord[],
  ): readonly ModificationRecord[] {
    const merged = [...held];
    for (const modification of incoming) {
      const index = merged.findIndex((existing) => existing.id === modification.id);
      if (index === -1) {
        merged.push(modification);
      } else {
        merged[index] = modification;
      }
    }
    return Object.freeze(merged);
  }

  /**
   * The newer of two analyses of the active session by `analysisVersion`; on a
   * tie the first (the authoritative source at the call site) wins.
   */
  private newerAnalysis(
    candidate: AnalysisResult | undefined,
    held: AnalysisResult | undefined,
  ): AnalysisResult | undefined {
    if (candidate === undefined) {
      return held;
    }
    if (held === undefined) {
      return candidate;
    }
    return held.analysisVersion > candidate.analysisVersion ? held : candidate;
  }

  /**
   * The held panel summary, unless the record shows it has been superseded.
   *
   * A record carries panel ids only, so it can retire a summary but never build
   * one. A summary whose id the record lists but not as the newest is
   * superseded, and is dropped until the newer `panel.generated` arrives; a
   * summary the record does not list yet is newer than the record and is kept.
   */
  private panelStillCurrent(panelIds: readonly string[]): PanelSummary | undefined {
    const held = this.latestPanelValue;
    if (held === undefined) {
      return undefined;
    }
    const superseded = panelIds.includes(held.id) && panelIds.at(-1) !== held.id;
    return superseded ? undefined : held;
  }

  /**
   * The capture window the record describes, unless a push already knows more.
   *
   * A capture the host saw start or stop that the record does not list yet
   * means the record is older than that push, so the pushed window is kept. A
   * capture the host saw stop is never reopened by a record that still shows it
   * in flight. Otherwise the record's newest capture decides.
   */
  private mergeCapture(captures: readonly CaptureRecord[]): CaptureState {
    const held = this.captureValue;
    const heldId = held.captureId;
    const newest = captures.at(-1);
    if (heldId !== undefined && !recordHasCapture(captures, heldId)) {
      return held;
    }
    if (newest === undefined) {
      return IDLE_CAPTURE;
    }
    const fromRecord = captureFromRecord(newest);
    if (newest.id === heldId && !held.active && fromRecord.active) {
      return held;
    }
    return fromRecord;
  }

  /**
   * The record's cleanup state, unless the host already received this
   * session's `cleanup.completed` and the record still says `pending` — a
   * record older than that push. A finished cleanup never returns to pending.
   */
  private mergeCleanup(record: SessionRecord): SessionCleanupState {
    const held = this.cleanupValue;
    const staleRecord =
      this.cleanupSessionId === record.id &&
      held.status !== 'pending' &&
      record.cleanup.status === 'pending';
    return staleRecord ? held : record.cleanup;
  }

  /**
   * The cleanup state after `session.end` answered `status` for `sessionId`;
   * see {@link applySessionEnded}. A finished cleanup already held for this
   * session stands when the answer is `pending` or agrees with it; otherwise
   * the answered status is taken with this session's held conflicts, and a
   * finished status carries the held `completedAt` or, failing that, now.
   */
  private endedCleanup(sessionId: string, status: CleanupStatus): SessionCleanupState {
    const held = this.cleanupSessionId === sessionId ? this.cleanupValue : undefined;
    if (
      held !== undefined &&
      held.status !== 'pending' &&
      (status === 'pending' || status === held.status)
    ) {
      return held;
    }
    return deepFreeze<SessionCleanupState>({
      status,
      ...(status === 'pending' ? {} : { completedAt: held?.completedAt ?? this.now() }),
      conflicts: held?.conflicts ?? [],
    });
  }

  /**
   * Takes the record's `target` as the target, and clears the target only when
   * a provably newer record names none.
   *
   * The record is the only source: the service stores the element picked in
   * the DevTools panel bound to the session, then broadcasts the stored
   * record, and `target.selected` itself travels DevTools → service only, so no
   * selection exists here that the record does not carry.
   *
   * Only a record that supersedes the one held reaches this point (see
   * `supersedes`), and `supersedes` admits a record stamped at the same
   * `updatedAt` as the held one. The service's `updatedAt` is whole
   * milliseconds and never decreases, but two consecutive records of one
   * session can share it, so a targetless snapshot the service produced just
   * before it recorded the selection — the answer to a `GET /sessions/:id`
   * still in flight, say — can arrive after the record carrying the target and
   * tie with it. Such a record, stamped no later than the record the held
   * target came from, keeps the target; a targetless record stamped strictly
   * later clears it. After {@link resetSession} (adoption of another session
   * included) no target is held, so the adopted record's own `target`, or its
   * absence, is taken as it is.
   */
  private applyRecordTarget(record: SessionRecord): void {
    if (record.target !== undefined) {
      this.targetValue = record.target;
      this.targetRecordUpdatedAt = record.updatedAt;
      return;
    }
    const heldStamp = this.targetRecordUpdatedAt;
    if (
      this.targetValue !== undefined &&
      heldStamp !== undefined &&
      record.updatedAt <= heldStamp
    ) {
      return;
    }
    this.targetValue = undefined;
    this.targetRecordUpdatedAt = undefined;
  }

  // -------------------------------------------------------------------------
  // Private: pairing expiry
  // -------------------------------------------------------------------------

  /**
   * Arms a timer that notifies the views when the displayed code expires. The
   * timer is unreferenced so it never keeps the host process alive, and it
   * re-arms itself when the delay was clamped to the timer ceiling or the clock
   * has not yet reached the expiry.
   */
  private schedulePairingExpiry(): void {
    this.cancelPairingTimer();
    const pairing = this.pairingValue;
    if (pairing === undefined || this.isDisposed) {
      return;
    }
    const delay = Math.min(Math.max(pairing.expiresAt - this.now(), 0), MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this.pairingTimer = undefined;
      if (this.isDisposed || this.pairingValue !== pairing) {
        return;
      }
      if (pairing.expiresAt > this.now()) {
        this.schedulePairingExpiry();
        return;
      }
      this.pairingValue = undefined;
      this.markChanged();
    }, delay);
    timer.unref();
    this.pairingTimer = timer;
  }

  /** Cancels the pairing-expiry timer, if one is armed. */
  private cancelPairingTimer(): void {
    if (this.pairingTimer !== undefined) {
      clearTimeout(this.pairingTimer);
      this.pairingTimer = undefined;
    }
  }
}
