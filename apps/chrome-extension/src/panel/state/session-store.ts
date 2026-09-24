/**
 * The DevTools panel's one and only state container.
 *
 * ## What this module is
 *
 * Every component of the "Debug Generator" panel — `Header`, `ConnectionStatus`,
 * `PairDialog`, `SessionSummary`, `CaptureControls`, `TargetPicker`, `LiveTail`,
 * `PanelView`, `EventDetails` and `EmptyPanel` (AAP §0.7.1 Group 4) — renders
 * from the immutable {@link PanelSnapshot} held here. There is no Redux, no
 * Zustand and no React context store: one module-private snapshot, a reducer per
 * input, and `useSyncExternalStore` from React to subscribe to it.
 *
 * ## Who writes it
 *
 * - `./connection.ts`, the panel's only owner of `chrome.runtime.connect`, is the
 *   **only** writer of protocol-derived state: {@link applyRelayedMessage} for
 *   every frame of `RELAYED_MESSAGE_TYPES`, {@link applySessionSnapshot} for the
 *   `session.snapshot` answer it requests on connect and on every reconnect, and
 *   {@link setConnectionStatus} / {@link setBindingState} for the pill and the
 *   binding line.
 * - Three local dispatches that carry no protocol traffic: {@link selectEvent}
 *   (`../actions.ts`, from `PanelActions.onSelectEvent`), {@link setPendingTarget}
 *   (the optimistic element pick) and {@link setLastError} (a non-blocking
 *   failure the panel chrome surfaces, such as a click-to-source request that
 *   could not be delivered).
 * - {@link resetPanelStore}, on unbind or session end and in unit suites.
 *
 * ## What it deliberately does not do
 *
 * - **No transport.** No port, no WebSocket, no `fetch`, no HTTP client: the port
 *   belongs to `./connection.ts` and the socket to the service worker.
 * - **No validation of panel specifications.** A `panel.generated` push was
 *   validated by the service and by the worker's protocol client; `PanelHost`
 *   renders validated specs only. A spec whose `meta.fallback` is `true` is a
 *   legitimate success and is stored exactly like any other.
 * - **No duplication of `SessionRecord`.** `session.updated` delivers the whole
 *   record — status, question, follow-ups, confirmed target, plans,
 *   modifications, captures, panel ids, analyses and cleanup — so none of those
 *   fields is mirrored into a sibling slice. The slices beside `session` hold
 *   only what arrives out of band or must be maintained incrementally: progress
 *   rows, the current panel specification (the record holds only `panelIds`),
 *   the analysis as pushed, capture counters, the live tail, the selection and
 *   the optimistic pending target.
 * - **No wording.** Status labels and the "Tab left ‹origin›" sentence belong to
 *   the components, which render `PANEL_CONNECTION_LABELS` and
 *   `formatTabLeftMessage` from `../../shared/messages`. This module stores the
 *   imported vocabulary values and never a label.
 * - **No design tokens, no UI, no credential.** The devtools credential lives in
 *   `chrome.storage.local`, owned by the service worker; no field here holds it.
 *
 * ## The three guarantees every reducer keeps
 *
 * 1. **Stable snapshot identity.** {@link getPanelSnapshot} returns the same
 *    object until something changes, which is what `useSyncExternalStore`
 *    requires to avoid an infinite render loop.
 * 2. **No-op means no notification.** An input that changes nothing — a repeated
 *    status, an empty tail batch, a replayed panel — leaves the snapshot
 *    reference untouched and wakes no listener.
 * 3. **Structural sharing.** An input that touches one slice rebuilds the root
 *    and that slice only; every other slice keeps its previous reference, so a
 *    live-tail append never changes the identity of `panel`, `session` or
 *    `instrumentation`, and memoized renderer components do not re-render.
 *
 * ## Session identity
 *
 * The inspected tab's binding is the authoritative answer to "which session is
 * this panel showing" (AAP §0.2.3: one tab binds to at most one session). A
 * session record for another session is ignored while the tab is bound, a
 * session-scoped frame naming another session is ignored, and a change of
 * session identity resets every session-scoped slice before the new session's
 * data lands — so one session's evidence is never rendered under another's
 * question (AAP §0.5.5: a failure, or foreign data, is never presented as this
 * session's result).
 *
 * @example Reading a slice from a component (a `.tsx` file of this panel):
 * ```tsx
 * import { type PanelSnapshot, usePanelStoreSelector } from '../state/session-store';
 *
 * const selectCapture = (snapshot: PanelSnapshot) => snapshot.capture;
 *
 * function CaptureCounter() {
 *   const capture = usePanelStoreSelector(selectCapture);
 *   return <Text numeric>{capture.eventCount}</Text>;
 * }
 * ```
 *
 * @module apps/chrome-extension/src/panel/state/session-store
 */

import { useMemo, useSyncExternalStore } from 'react';

import type { EventRef, PanelSpec } from '@debuggen/panel-schema';
import type {
  AnalysisResult,
  CaptureStoppedPayload,
  CleanupCompletedPayload,
  ErrorPayload,
  InstrumentationFailedPayload,
  InstrumentationPlanPayload,
  InstrumentationReadyPayload,
  ProgressStage,
  ProgressStatus,
  SelectedTarget,
  SessionBoundPayload,
  SessionProgressPayload,
  SessionRecord,
  TelemetryEvent,
} from '@debuggen/protocol';
import { assertNever, nowEpochMs } from '@debuggen/shared';
import type { CaptureId, PanelId, SessionId } from '@debuggen/shared';

import type {
  PanelBindingState,
  PanelConnectionState,
  PanelConnectionStatus,
  PanelSessionSnapshot,
  PortProtocolPush,
  RelayedProtocolMessage,
} from '../../shared/messages';

/*
 * ===========================================================================
 * Section A — bounds
 * ===========================================================================
 */

/**
 * The most redacted events the live tail keeps; older events are dropped first.
 *
 * The `LiveTail` view is virtualized and collapsible, so a four-figure buffer is
 * generous while keeping the panel's memory bounded for a capture of any length.
 * This is a UI bound and deliberately smaller than the protocol's per-batch
 * limit, which bounds the *agent's* buffer. `LiveTail` imports this constant to
 * word its truncation notice; {@link PanelSnapshot.liveTailDropped} counts what
 * was dropped.
 */
export const LIVE_TAIL_MAX_EVENTS = 1000;

/**
 * The most progress rows kept for one session; the oldest are dropped first.
 *
 * Rows are deduplicated by stage and message, so a session produces a few dozen
 * at most — this cap is a safety net for a long session with many follow-ups,
 * never a limit an ordinary run approaches.
 */
export const PANEL_PROGRESS_MAX_ENTRIES = 200;

/*
 * ===========================================================================
 * Section B — types reached through the protocol payloads
 *
 * The capture summary is owned by `@debuggen/telemetry`, and the plan, the
 * modification records, the runtime hooks, the unavailable signals and the
 * cleanup conflicts by `@debuggen/instrumentation` — neither of which this
 * workspace may import at run time. Each is reached by indexed access off the
 * protocol payload that carries it, so the panel names exactly the type that
 * arrives on the wire and no shape is restated here (AAP §0.2.3).
 * ===========================================================================
 */

/** The aggregate a stopped capture produced, as `capture.stopped` carries it. */
export type PanelCaptureSummary = CaptureStoppedPayload['summary'];

/** The normalised instrumentation plan, as `instrumentation.plan` carries it. */
export type PanelInstrumentationPlan = InstrumentationPlanPayload['plan'];

/** One applied file modification, as `instrumentation.ready` carries it. */
export type PanelModificationRecord = InstrumentationReadyPayload['applied'][number];

/** One runtime hook that came up, as `instrumentation.ready` carries it. */
export type PanelRuntimeHook = InstrumentationReadyPayload['runtimeHooks'][number];

/** One signal that could not be enabled, with its reason and recovery hint. */
export type PanelUnavailableSignal = InstrumentationReadyPayload['unavailable'][number];

/** Why instrumentation could not be installed, as `instrumentation.failed` carries it. */
export type PanelInstrumentationFailure = InstrumentationFailedPayload['error'];

/** The end-of-session cleanup outcome, as `cleanup.completed` carries it. */
export type PanelCleanupStatus = CleanupCompletedPayload['status'];

/** One file cleanup refused to overwrite, as `cleanup.completed` carries it. */
export type PanelModificationConflict = CleanupCompletedPayload['conflicts'][number];

/*
 * ===========================================================================
 * Section C — the snapshot and its slices
 * ===========================================================================
 */

/**
 * The connection pill and the binding line (AAP §0.7.3, §0.2.3).
 *
 * `status`, `retryInMs` and `serviceUrl` are the fields of the worker's
 * `PanelConnectionState`; `binding` is the imported `PanelBindingState`. Neither
 * carries a label: `ConnectionStatus` renders `PANEL_CONNECTION_LABELS[status]`
 * and, for a `tab-left` binding, `formatTabLeftMessage(binding.origin)`.
 */
export interface PanelConnectionSlice {
  /** The pill's state, one of `PANEL_CONNECTION_STATUSES`. */
  readonly status: PanelConnectionStatus;
  /** On `'reconnecting'`, how long until the worker's next attempt, when it said. */
  readonly retryInMs: number | undefined;
  /** The service base URL the worker is trying, for the panel's hint text. */
  readonly serviceUrl: string | undefined;
  /** The inspected tab's relationship to a session. */
  readonly binding: PanelBindingState;
  /**
   * When `status`, `retryInMs`, `serviceUrl` or `binding` last changed, in epoch
   * milliseconds; `0` until the first change is observed.
   */
  readonly lastChangeAt: number;
}

/**
 * One row of the progress view — the ✓/spinner/✗ list of AAP §0.7.3, built from
 * real pipeline events whose wording the service composed.
 */
export interface PanelProgressEntry {
  /** The pipeline stage that reported. */
  readonly stage: ProgressStage;
  /** Whether that stage is working, finished or failed. */
  readonly status: ProgressStatus;
  /** The service-composed line. Together with `stage`, the row's identity. */
  readonly message: string;
  /** The optional second line; absent when the stage said nothing further. */
  readonly detail?: string;
  /** When the service stamped the frame, in epoch milliseconds. */
  readonly ts: number;
}

/** The session's current generated panel — only the current one is kept. */
export interface PanelCurrentPanel {
  /** The id the `panel.generated` frame announced. */
  readonly panelId: PanelId;
  /** The validated specification `PanelHost` renders. */
  readonly spec: PanelSpec;
}

/** The capture window's counters, maintained incrementally from pushes. */
export interface PanelCaptureSlice {
  /** Whether a capture is running right now. */
  readonly active: boolean;
  /** The running or most recent capture; kept after it stops. */
  readonly captureId: CaptureId | undefined;
  /** Events counted for this capture: the live counter beside Stop capture. */
  readonly eventCount: number;
  /** When the capture started, in epoch milliseconds, when known. */
  readonly startedAt: number | undefined;
  /** What the capture added up to; present once it has stopped. */
  readonly summary: PanelCaptureSummary | undefined;
}

/**
 * The element-picking state that precedes the service's confirmation.
 *
 * Not a duplicate of `SessionRecord.target`, which is the confirmed target:
 * `pending` is the optimistic pick the panel shows immediately, cleared once a
 * session record confirms a target; `pickRequested` is the service asking the
 * bound panel to enter picker mode (`target.request`), cleared when a target is
 * set or the session ends.
 */
export interface PanelTargetSlice {
  /** The element the developer picked, not yet confirmed by the service. */
  readonly pending: SelectedTarget | undefined;
  /** Whether the service asked this panel to enter picker mode. */
  readonly pickRequested: boolean;
}

/**
 * The instrumentation outcome, so `SessionSummary` can show what was applied,
 * what came up and what could not (AAP §0.5.1, §0.5.5).
 *
 * The session record's `plans` and `modifications` remain the complete,
 * versioned history; this slice holds what the latest `instrumentation.*`
 * pushes said, including a failure the record does not carry.
 */
export interface PanelInstrumentationSlice {
  /** The latest normalised plan pushed. */
  readonly plan: PanelInstrumentationPlan | undefined;
  /** The modifications the latest `instrumentation.ready` reported applied. */
  readonly applied: readonly PanelModificationRecord[];
  /** The runtime hooks the latest `instrumentation.ready` reported enabled. */
  readonly runtimeHooks: readonly PanelRuntimeHook[];
  /** The signals the latest `instrumentation.ready` could not enable. */
  readonly unavailable: readonly PanelUnavailableSignal[];
  /**
   * Why the latest installation failed. Rendered as the failing stage beside —
   * never instead of — a previous panel or analysis.
   */
  readonly failure: PanelInstrumentationFailure | undefined;
}

/** The end-of-session cleanup outcome from `cleanup.completed`. */
export interface PanelCleanupSlice {
  /** `pending`, `clean`, `partial` or `conflict`. */
  readonly status: PanelCleanupStatus;
  /** Files left untouched because they changed after instrumentation. */
  readonly conflicts: readonly PanelModificationConflict[];
}

/**
 * Everything the panel renders, as one immutable value.
 *
 * Every field is always present; an absent datum is `undefined` or an empty
 * array, never a missing key, so the initial snapshot renders the no-session
 * state of every component — including `panel.html` opened directly as an
 * extension page with no session and no DevTools.
 */
export interface PanelSnapshot {
  /** The connection pill and the binding line. */
  readonly connection: PanelConnectionSlice;
  /** The bound session's record, exactly as the service last broadcast it. */
  readonly session: SessionRecord | undefined;
  /** The progress rows, in first-arrival order, deduplicated by stage and message. */
  readonly progress: readonly PanelProgressEntry[];
  /** The session's current generated panel. */
  readonly panel: PanelCurrentPanel | undefined;
  /** The latest validated analysis, as pushed. */
  readonly analysis: AnalysisResult | undefined;
  /** The capture window's counters. */
  readonly capture: PanelCaptureSlice;
  /** The newest redacted events of the capture, oldest first, bounded by {@link LIVE_TAIL_MAX_EVENTS}. */
  readonly liveTail: readonly TelemetryEvent[];
  /** How many events the live tail dropped to stay within its bound. */
  readonly liveTailDropped: number;
  /** The event the `EventDetails` drawer shows; `undefined` closes it. */
  readonly selectedEvent: EventRef | undefined;
  /** The element-picking state that precedes the service's confirmation. */
  readonly target: PanelTargetSlice;
  /** What the latest instrumentation pushes reported. */
  readonly instrumentation: PanelInstrumentationSlice;
  /** The end-of-session cleanup outcome, once it arrived. */
  readonly cleanup: PanelCleanupSlice | undefined;
  /**
   * The last failure to surface: a relayed `error` frame, or a local failure
   * reported through {@link setLastError}. Rendered as an error state, never as
   * analysis.
   */
  readonly lastError: ErrorPayload | undefined;
}

/** Options of {@link resetPanelStore}. */
export interface ResetPanelStoreOptions {
  /**
   * Also restore the connection slice — the pill's status and the tab's binding
   * — to its initial value, yielding the pristine initial snapshot. Defaults to
   * `false`, because the connection slice describes the port and the inspected
   * tab rather than a session: a reset on unbind or session end must neither
   * show a false "Reconnecting…" pill nor drop the "Tab left ‹origin›" binding
   * that caused it. Unit suites pass `true` between cases.
   */
  readonly includeConnection?: boolean | undefined;
}

/*
 * ===========================================================================
 * Section D — the snapshot keys, and the change primitive built on them
 * ===========================================================================
 */

/**
 * Every key of {@link PanelSnapshot}, iterable. {@link SnapshotKey} fails to
 * resolve (and every patch literal below stops compiling) if the snapshot gains
 * a slice this tuple lacks; `satisfies` rejects a name the snapshot does not
 * have.
 */
const SNAPSHOT_KEYS = [
  'connection',
  'session',
  'progress',
  'panel',
  'analysis',
  'capture',
  'liveTail',
  'liveTailDropped',
  'selectedEvent',
  'target',
  'instrumentation',
  'cleanup',
  'lastError',
] as const satisfies readonly (keyof PanelSnapshot)[];

/** A snapshot key, or `never` when {@link SNAPSHOT_KEYS} is incomplete. */
type SnapshotKey = [Exclude<keyof PanelSnapshot, (typeof SNAPSHOT_KEYS)[number]>] extends [never]
  ? (typeof SNAPSHOT_KEYS)[number]
  : never;

/**
 * A set of slices to replace. A key that is present replaces its slice, even
 * with `undefined`; an absent key leaves its slice alone.
 */
type SnapshotPatch = { readonly [Key in SnapshotKey]?: PanelSnapshot[Key] };

/**
 * Apply a patch with structural sharing and no-op detection.
 *
 * @param snapshot The snapshot to derive from.
 * @param patch The slices to replace.
 * @returns `snapshot` itself when every patched slice is already the same
 * reference (so nothing is committed and nobody is notified); otherwise a new
 * frozen root sharing every unpatched slice with `snapshot`.
 */
function withChanges(snapshot: PanelSnapshot, patch: SnapshotPatch): PanelSnapshot {
  for (const key of SNAPSHOT_KEYS) {
    if (Object.hasOwn(patch, key) && !Object.is(patch[key], snapshot[key])) {
      return Object.freeze({ ...snapshot, ...patch });
    }
  }
  return snapshot;
}

/*
 * ===========================================================================
 * Section E — initial values
 * ===========================================================================
 */

/** The shared empty progress list. */
const EMPTY_PROGRESS: readonly PanelProgressEntry[] = Object.freeze([]);

/** The shared empty live tail. */
const EMPTY_TAIL: readonly TelemetryEvent[] = Object.freeze([]);

/** No session holds the inspected tab. */
const UNBOUND: PanelBindingState = Object.freeze({ kind: 'unbound' });

/**
 * The connection slice before the port has reported anything.
 *
 * `'reconnecting'` is the pill's in-progress state: it is what the protocol's
 * `connecting` transport state maps to through `panelConnectionStatus()`, and a
 * port that has not connected yet must never be reported as a service that is
 * not running (AAP §0.5.5).
 */
const INITIAL_CONNECTION: PanelConnectionSlice = Object.freeze({
  status: 'reconnecting',
  retryInMs: undefined,
  serviceUrl: undefined,
  binding: UNBOUND,
  lastChangeAt: 0,
});

/** No capture has run. */
const INITIAL_CAPTURE: PanelCaptureSlice = Object.freeze({
  active: false,
  captureId: undefined,
  eventCount: 0,
  startedAt: undefined,
  summary: undefined,
});

/** Nothing picked, nothing requested. */
const INITIAL_TARGET: PanelTargetSlice = Object.freeze({
  pending: undefined,
  pickRequested: false,
});

/** No instrumentation reported. */
const INITIAL_INSTRUMENTATION: PanelInstrumentationSlice = Object.freeze({
  plan: undefined,
  applied: Object.freeze([]),
  runtimeHooks: Object.freeze([]),
  unavailable: Object.freeze([]),
  failure: undefined,
});

/**
 * Every session-scoped slice at its initial value: the whole snapshot except
 * the connection slice. Applied when session identity changes and by the
 * default {@link resetPanelStore}.
 */
const SESSION_SCOPED_INITIAL = Object.freeze({
  session: undefined,
  progress: EMPTY_PROGRESS,
  panel: undefined,
  analysis: undefined,
  capture: INITIAL_CAPTURE,
  liveTail: EMPTY_TAIL,
  liveTailDropped: 0,
  selectedEvent: undefined,
  target: INITIAL_TARGET,
  instrumentation: INITIAL_INSTRUMENTATION,
  cleanup: undefined,
  lastError: undefined,
} satisfies SnapshotPatch);

/** The pristine snapshot: nothing connected, nothing bound, no session. */
const INITIAL_SNAPSHOT: PanelSnapshot = Object.freeze({
  connection: INITIAL_CONNECTION,
  ...SESSION_SCOPED_INITIAL,
});

/*
 * ===========================================================================
 * Section F — the store: private state, subscription and React hooks
 * ===========================================================================
 */

/** The current snapshot — the module's only mutable binding. */
let state: PanelSnapshot = INITIAL_SNAPSHOT;

/** Everyone subscribed through {@link subscribePanelStore}. */
const listeners = new Set<() => void>();

/**
 * Make `next` current and notify every listener, unless it is the current
 * snapshot already.
 *
 * Every listener is called even if an earlier one throws; the first failure is
 * rethrown afterwards (or an `AggregateError` when several failed), so one
 * faulty subscriber can neither starve the others nor fail silently.
 */
function commit(next: PanelSnapshot): void {
  if (next === state) {
    return;
  }
  state = next;
  const failures: unknown[] = [];
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Panel store listeners failed');
  }
}

/**
 * The current snapshot.
 *
 * Returns the same reference on every call until an input changes something —
 * the contract `useSyncExternalStore` relies on.
 */
export function getPanelSnapshot(): PanelSnapshot {
  return state;
}

/**
 * Subscribe to snapshot changes.
 *
 * A stable module-level function, so `useSyncExternalStore` never resubscribes
 * between renders.
 *
 * @param listener Called, with no arguments, after every committed change.
 * @returns A function that removes `listener`; calling it again is harmless.
 */
export function subscribePanelStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The whole snapshot, re-rendering the caller on every committed change. */
export function usePanelSnapshot(): PanelSnapshot {
  return useSyncExternalStore(subscribePanelStore, getPanelSnapshot);
}

/**
 * A derived value of the snapshot, re-rendering the caller only when that value
 * changes by `Object.is`.
 *
 * Select a slice (`(snapshot) => snapshot.capture`) or a primitive
 * (`(snapshot) => snapshot.liveTail.length`): structural sharing keeps a
 * slice's reference stable across unrelated updates, so such a selector
 * re-renders only when its own slice changed. A selector that builds a fresh
 * object on every call (`(snapshot) => ({ a: snapshot.a })`) re-renders on
 * every store change — the caller's mistake, never an infinite loop, because
 * the selection is memoized per snapshot. Declare the selector at module scope
 * or wrap it in `useCallback` so its identity is stable too.
 *
 * @param selector A pure function of the snapshot.
 */
export function usePanelStoreSelector<T>(selector: (snapshot: PanelSnapshot) => T): T {
  const getSelection = useMemo(() => {
    let memo: { readonly snapshot: PanelSnapshot; readonly value: T } | undefined;
    return (): T => {
      const snapshot = getPanelSnapshot();
      if (memo !== undefined && memo.snapshot === snapshot) {
        return memo.value;
      }
      const selected = selector(snapshot);
      const value = memo !== undefined && Object.is(memo.value, selected) ? memo.value : selected;
      memo = { snapshot, value };
      return value;
    };
  }, [selector]);
  return useSyncExternalStore(subscribePanelStore, getSelection);
}

/**
 * The session this panel is showing, or `undefined` when there is none.
 *
 * The bound session when the inspected tab is bound (the tab's authoritative
 * identity); otherwise the id of the session record on screen, or the session a
 * `tab-left` binding names. `../data-provider.ts` injects exactly this function.
 */
export function getSessionId(): SessionId | undefined {
  return currentSessionId(state);
}

/**
 * Return the store to its initial state.
 *
 * By default every session-scoped slice is reset and the connection slice is
 * kept — see {@link ResetPanelStoreOptions.includeConnection} for why, and for
 * the pristine reset unit suites use. Resetting a store that is already in that
 * state notifies nobody.
 *
 * @param options What to reset.
 */
export function resetPanelStore(options: ResetPanelStoreOptions = {}): void {
  commit(
    options.includeConnection === true
      ? withChanges(state, INITIAL_SNAPSHOT)
      : withChanges(state, SESSION_SCOPED_INITIAL),
  );
}

/*
 * ===========================================================================
 * Section G — session identity
 * ===========================================================================
 */

/** The session a snapshot is showing; see {@link getSessionId}. */
function currentSessionId(snapshot: PanelSnapshot): SessionId | undefined {
  const binding = snapshot.connection.binding;
  if (binding.kind === 'bound') {
    return binding.sessionId;
  }
  return snapshot.session?.id ?? (binding.kind === 'tab-left' ? binding.sessionId : undefined);
}

/**
 * Whether moving to `nextSessionId` changes which session the panel shows.
 * Nothing changes when either side is unknown: an unknown next session proves
 * nothing, and with no current session there is nothing to discard.
 */
function isSessionSwitch(snapshot: PanelSnapshot, nextSessionId: SessionId | undefined): boolean {
  const current = currentSessionId(snapshot);
  return nextSessionId !== undefined && current !== undefined && nextSessionId !== current;
}

/**
 * Whether a session-scoped frame names a session other than the one on screen.
 * Such a frame is dropped rather than applied: its evidence belongs to another
 * session's question.
 */
function belongsToOtherSession(snapshot: PanelSnapshot, sessionId: SessionId | undefined): boolean {
  const current = currentSessionId(snapshot);
  return sessionId !== undefined && current !== undefined && sessionId !== current;
}

/** `snapshot` with every session-scoped slice reset; the connection slice kept. */
function resetSessionScope(snapshot: PanelSnapshot): PanelSnapshot {
  return withChanges(snapshot, SESSION_SCOPED_INITIAL);
}

/*
 * ===========================================================================
 * Section H — value comparisons
 *
 * Structural equality for the few values that arrive as fresh objects over the
 * port although nothing about them changed. Used only to preserve a reference
 * (guarantee 2 and 3 of the module header), never to validate.
 * ===========================================================================
 */

/** Whether two binding states describe the same relationship. */
function sameBinding(left: PanelBindingState, right: PanelBindingState): boolean {
  switch (left.kind) {
    case 'unbound':
      return right.kind === 'unbound';
    case 'bound':
      return (
        right.kind === 'bound' &&
        left.sessionId === right.sessionId &&
        left.tabId === right.tabId &&
        left.url === right.url
      );
    case 'tab-left':
      return (
        right.kind === 'tab-left' &&
        left.origin === right.origin &&
        left.sessionId === right.sessionId &&
        left.reason === right.reason
      );
    default:
      return assertNever(left, 'Unhandled panel binding state');
  }
}

/** Whether two target descriptors name the same element on the same page. */
function sameTarget(left: SelectedTarget | undefined, right: SelectedTarget | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  return (
    left.selector === right.selector &&
    left.tagName === right.tagName &&
    left.text === right.text &&
    left.url === right.url &&
    left.componentChain.length === right.componentChain.length &&
    left.componentChain.every((name, index) => name === right.componentChain[index])
  );
}

/** Whether two event references point at the same event with the same hints. */
function sameEventRef(left: EventRef | undefined, right: EventRef | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  return (
    left.eventId === right.eventId &&
    left.traceId === right.traceId &&
    left.spanId === right.spanId &&
    left.kind === right.kind &&
    left.label === right.label
  );
}

/** Whether two error payloads report the same failure. */
function sameError(left: ErrorPayload | undefined, right: ErrorPayload | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  return left.code === right.code && left.message === right.message && left.ref === right.ref;
}

/** Whether two capture slices hold the same values. */
function sameCapture(left: PanelCaptureSlice, right: PanelCaptureSlice): boolean {
  return (
    left.active === right.active &&
    left.captureId === right.captureId &&
    left.eventCount === right.eventCount &&
    left.startedAt === right.startedAt &&
    left.summary === right.summary
  );
}

/** Whether two progress rows hold the same values. */
function sameProgressEntry(left: PanelProgressEntry, right: PanelProgressEntry): boolean {
  return (
    left.stage === right.stage &&
    left.status === right.status &&
    left.message === right.message &&
    left.detail === right.detail &&
    left.ts === right.ts
  );
}

/*
 * ===========================================================================
 * Section I — slice builders
 *
 * Each returns its input slice unchanged when nothing about it changed, so the
 * patch it feeds to `withChanges` is a no-op in that case.
 * ===========================================================================
 */

/**
 * The connection slice with the given values, stamped with `lastChangeAt` when
 * any of them changed.
 */
function nextConnection(
  current: PanelConnectionSlice,
  status: PanelConnectionStatus,
  retryInMs: number | undefined,
  serviceUrl: string | undefined,
  binding: PanelBindingState,
): PanelConnectionSlice {
  const bindingUnchanged = sameBinding(current.binding, binding);
  if (
    bindingUnchanged &&
    current.status === status &&
    current.retryInMs === retryInMs &&
    current.serviceUrl === serviceUrl
  ) {
    return current;
  }
  return Object.freeze({
    status,
    retryInMs,
    serviceUrl,
    binding: bindingUnchanged ? current.binding : binding,
    lastChangeAt: nowEpochMs(),
  });
}

/**
 * Move to a new binding. A binding to a different session is a change of
 * session identity, so the session-scoped slices are reset first.
 */
function applyBinding(snapshot: PanelSnapshot, binding: PanelBindingState): PanelSnapshot {
  const nextSessionId = binding.kind === 'bound' ? binding.sessionId : undefined;
  const base = isSessionSwitch(snapshot, nextSessionId) ? resetSessionScope(snapshot) : snapshot;
  const connection = base.connection;
  return withChanges(base, {
    connection: nextConnection(
      connection,
      connection.status,
      connection.retryInMs,
      connection.serviceUrl,
      binding,
    ),
  });
}

/** The serialized origin of a URL, or the URL itself when it cannot be parsed. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * The binding a relayed `session.bound` announces, from this panel's point of
 * view, or `undefined` when the announcement is not about this panel's tab.
 *
 * - establishment (no `reason`, or `'bound'`) — bound to the frame's session,
 *   tab and document;
 * - a kept same-origin navigation (`'navigated'`) — bound to the new document,
 *   unless this panel is bound to a different tab;
 * - `'replaced'` — bound, unless this panel is bound to a *different* tab, in
 *   which case this panel's tab is the one whose binding was taken;
 * - `'origin-changed'` — the tab left the session's origin. The origin stored is
 *   the one the tab *left*, read from this panel's binding or the session's
 *   dev-server URL; the frame's `url` is the new document's and is not used;
 * - `'unbound'` — the binding ended.
 *
 * A drop is ignored when this panel is bound to another session or tab: a late
 * frame about an old binding must not unbind the current one.
 */
function bindingFromBound(
  snapshot: PanelSnapshot,
  payload: SessionBoundPayload,
): PanelBindingState | undefined {
  const current = snapshot.connection.binding;
  const bound: PanelBindingState = {
    kind: 'bound',
    sessionId: payload.sessionId,
    tabId: payload.tabId,
    url: payload.url,
  };
  const aboutAnotherBinding =
    current.kind === 'bound' &&
    (current.sessionId !== payload.sessionId || current.tabId !== payload.tabId);
  const reason = payload.reason;
  switch (reason) {
    case undefined:
    case 'bound':
      return bound;
    case 'navigated':
      return current.kind === 'bound' && current.tabId !== payload.tabId ? undefined : bound;
    case 'replaced':
      return current.kind === 'bound' && current.tabId !== payload.tabId ? UNBOUND : bound;
    case 'origin-changed': {
      if (aboutAnotherBinding) {
        return undefined;
      }
      const leftUrl =
        current.kind === 'bound'
          ? current.url
          : snapshot.session?.id === payload.sessionId
            ? snapshot.session.devServerUrl
            : undefined;
      if (leftUrl === undefined) {
        return undefined;
      }
      return { kind: 'tab-left', origin: originOf(leftUrl), sessionId: payload.sessionId, reason };
    }
    case 'unbound':
      return aboutAnotherBinding ? undefined : UNBOUND;
    default:
      return assertNever(reason, 'Unhandled binding reason');
  }
}

/**
 * The progress rows with `entry` merged in.
 *
 * Rows are identified by `(stage, message)`: a row reported again keeps its
 * first-arrival position and takes the newer `status`, `detail` and `ts`, so a
 * line moves from running to done in place instead of repeating. A report older
 * than the row it would replace is stale and ignored. Past
 * {@link PANEL_PROGRESS_MAX_ENTRIES} the oldest rows are dropped.
 */
function mergeProgress(
  entries: readonly PanelProgressEntry[],
  entry: PanelProgressEntry,
): readonly PanelProgressEntry[] {
  const index = entries.findIndex(
    (candidate) => candidate.stage === entry.stage && candidate.message === entry.message,
  );
  if (index === -1) {
    const appended = [...entries, entry];
    const overflow = appended.length - PANEL_PROGRESS_MAX_ENTRIES;
    return Object.freeze(overflow > 0 ? appended.slice(overflow) : appended);
  }
  const existing = entries[index];
  if (existing === undefined || entry.ts < existing.ts || sameProgressEntry(existing, entry)) {
    return entries;
  }
  const replaced = entries.slice();
  replaced[index] = entry;
  return Object.freeze(replaced);
}

/** A progress row from a `session.progress` payload and its envelope timestamp. */
function progressEntry(payload: SessionProgressPayload, ts: number): PanelProgressEntry {
  return Object.freeze({
    stage: payload.stage,
    status: payload.status,
    message: payload.message,
    ...(payload.detail === undefined ? {} : { detail: payload.detail }),
    ts,
  });
}

/**
 * The target slice after a session record arrived.
 *
 * The optimistic pick is cleared once the record confirms a target — one equal
 * to the pick, or one that differs from the previously confirmed target (the
 * service's normalised echo of the pick) — or once the session has ended. A
 * picker request is cleared by the same confirmation or by the session ending.
 */
function reconcileTarget(
  target: PanelTargetSlice,
  record: SessionRecord,
  previous: SessionRecord | undefined,
): PanelTargetSlice {
  const ended = record.status === 'ended';
  const confirmedChanged =
    record.target !== undefined && !sameTarget(record.target, previous?.target);
  const confirmedPending =
    target.pending !== undefined &&
    record.target !== undefined &&
    (sameTarget(record.target, target.pending) || confirmedChanged);
  const pending = ended || confirmedPending ? undefined : target.pending;
  const pickRequested = target.pickRequested && !ended && !confirmedChanged;
  if (pending === target.pending && pickRequested === target.pickRequested) {
    return target;
  }
  return Object.freeze({ pending, pickRequested });
}

/**
 * The capture slice a session record implies: its latest capture, in flight
 * while it has no `stoppedAt`.
 *
 * For the capture already on screen the local counter is kept when it is ahead
 * of the record's (the tail may have counted events the record has not caught
 * up with), and an immutable stopped-capture summary keeps its reference.
 */
function captureFromRecord(
  current: PanelCaptureSlice,
  record: SessionRecord | undefined,
): PanelCaptureSlice {
  const captures = record?.captures ?? [];
  const latest = captures[captures.length - 1];
  if (latest === undefined) {
    return sameCapture(current, INITIAL_CAPTURE) ? current : INITIAL_CAPTURE;
  }
  const sameId = current.captureId === latest.id;
  const recordCount = latest.eventCount ?? latest.summary?.eventCount ?? 0;
  const stopped = latest.stoppedAt !== undefined;
  const summary = !stopped
    ? undefined
    : sameId && current.summary !== undefined
      ? current.summary
      : latest.summary;
  const next: PanelCaptureSlice = {
    active: !stopped,
    captureId: latest.id,
    eventCount: sameId ? Math.max(current.eventCount, recordCount) : recordCount,
    startedAt: latest.startedAt,
    summary,
  };
  return sameCapture(current, next) ? current : Object.freeze(next);
}

/**
 * The current-panel slice for a specification, preserving the current slice's
 * reference when it is the same document. Panels are immutable versioned
 * documents — a new version is a new id — so the same id at the same version is
 * the same content, and keeping the reference spares `PanelHost` a re-render and
 * every node a re-query.
 */
function currentPanelFor(
  current: PanelCurrentPanel | undefined,
  panelId: PanelId,
  spec: PanelSpec,
): PanelCurrentPanel {
  if (
    current !== undefined &&
    current.panelId === panelId &&
    current.spec.panelVersion === spec.panelVersion
  ) {
    return current;
  }
  return Object.freeze({ panelId, spec });
}

/*
 * ===========================================================================
 * Section J — the relayed-message reducer
 * ===========================================================================
 */

/**
 * Apply a session record from `session.created` or `session.updated`.
 *
 * Ignored while the tab is bound to another session — it is not this tab's
 * session. A record for a different session than the one on screen (with the
 * tab unbound) is a change of session identity and resets the session-scoped
 * slices first.
 */
function reduceSessionRecord(snapshot: PanelSnapshot, record: SessionRecord): PanelSnapshot {
  const binding = snapshot.connection.binding;
  if (binding.kind === 'bound' && binding.sessionId !== record.id) {
    return snapshot;
  }
  const base = isSessionSwitch(snapshot, record.id) ? resetSessionScope(snapshot) : snapshot;
  return withChanges(base, {
    session: record,
    target: reconcileTarget(base.target, record, base.session),
  });
}

/**
 * Apply `telemetry.tail`: append the batch, count it, and keep only the newest
 * {@link LIVE_TAIL_MAX_EVENTS} events, adding the number dropped to
 * `liveTailDropped`. An empty batch changes nothing.
 */
function reduceTelemetryTail(
  snapshot: PanelSnapshot,
  events: readonly TelemetryEvent[],
): PanelSnapshot {
  if (events.length === 0) {
    return snapshot;
  }
  const combined = [...snapshot.liveTail, ...events];
  const overflow = Math.max(0, combined.length - LIVE_TAIL_MAX_EVENTS);
  return withChanges(snapshot, {
    liveTail: Object.freeze(overflow > 0 ? combined.slice(overflow) : combined),
    liveTailDropped: snapshot.liveTailDropped + overflow,
    capture: Object.freeze({
      ...snapshot.capture,
      eventCount: snapshot.capture.eventCount + events.length,
    }),
  });
}

/**
 * The snapshot after one relayed protocol frame.
 *
 * Exhaustive over `RELAYED_MESSAGE_TYPES`: a relayed type added to
 * `../../shared/messages` without an arm here is a compile error at the
 * `assertNever` below, never a frame silently dropped.
 */
function reduceRelayedMessage(
  snapshot: PanelSnapshot,
  message: RelayedProtocolMessage,
): PanelSnapshot {
  switch (message.type) {
    case 'session.created':
    case 'session.updated':
      return reduceSessionRecord(snapshot, message.payload.session);

    case 'session.progress': {
      const payload = message.payload;
      if (belongsToOtherSession(snapshot, payload.sessionId)) {
        return snapshot;
      }
      return withChanges(snapshot, {
        progress: mergeProgress(snapshot.progress, progressEntry(payload, message.ts)),
      });
    }

    case 'session.bound': {
      const binding = bindingFromBound(snapshot, message.payload);
      return binding === undefined ? snapshot : applyBinding(snapshot, binding);
    }

    case 'capture.started': {
      const payload = message.payload;
      const capture = snapshot.capture;
      if (
        belongsToOtherSession(snapshot, payload.sessionId) ||
        (capture.active && capture.captureId === payload.captureId)
      ) {
        return snapshot;
      }
      // A new capture starts from a clean log and a zero counter.
      return withChanges(snapshot, {
        capture: Object.freeze({
          active: true,
          captureId: payload.captureId,
          eventCount: 0,
          startedAt: message.ts,
          summary: undefined,
        }),
        liveTail: EMPTY_TAIL,
        liveTailDropped: 0,
      });
    }

    case 'capture.stopped': {
      const payload = message.payload;
      const capture = snapshot.capture;
      if (belongsToOtherSession(snapshot, payload.sessionId)) {
        return snapshot;
      }
      const sameId = capture.captureId === payload.captureId;
      // A stop older than the start of a different, running capture is stale.
      const staleStop =
        !sameId &&
        capture.active &&
        capture.startedAt !== undefined &&
        message.ts < capture.startedAt;
      if (staleStop) {
        return snapshot;
      }
      const summaryCount = payload.summary.eventCount;
      return withChanges(snapshot, {
        capture: Object.freeze({
          active: false,
          captureId: payload.captureId,
          eventCount: sameId ? Math.max(capture.eventCount, summaryCount) : summaryCount,
          startedAt: sameId ? capture.startedAt : undefined,
          summary: payload.summary,
        }),
      });
    }

    case 'instrumentation.plan': {
      const payload = message.payload;
      if (belongsToOtherSession(snapshot, payload.sessionId)) {
        return snapshot;
      }
      // A new plan supersedes an earlier installation failure; the lists of the
      // last `instrumentation.ready` stay until the next one replaces them,
      // because a follow-up plan only ever adds to what is installed.
      return withChanges(snapshot, {
        instrumentation: Object.freeze({
          ...snapshot.instrumentation,
          plan: payload.plan,
          failure: undefined,
        }),
      });
    }

    case 'instrumentation.ready': {
      const payload = message.payload;
      if (belongsToOtherSession(snapshot, payload.sessionId)) {
        return snapshot;
      }
      return withChanges(snapshot, {
        instrumentation: Object.freeze({
          ...snapshot.instrumentation,
          applied: Object.freeze([...payload.applied]),
          runtimeHooks: Object.freeze([...payload.runtimeHooks]),
          unavailable: Object.freeze([...payload.unavailable]),
          failure: undefined,
        }),
      });
    }

    case 'instrumentation.failed': {
      const payload = message.payload;
      if (belongsToOtherSession(snapshot, payload.sessionId)) {
        return snapshot;
      }
      // Only the failure is recorded: a previous panel and analysis stay on
      // screen, and the failure renders beside them as the failing stage.
      return withChanges(snapshot, {
        instrumentation: Object.freeze({ ...snapshot.instrumentation, failure: payload.error }),
      });
    }

    case 'telemetry.tail': {
      const payload = message.payload;
      if (belongsToOtherSession(snapshot, payload.sessionId)) {
        return snapshot;
      }
      return reduceTelemetryTail(snapshot, payload.events);
    }

    case 'analysis.completed': {
      const payload = message.payload;
      if (belongsToOtherSession(snapshot, payload.sessionId)) {
        return snapshot;
      }
      const incoming = payload.analysis;
      const current = snapshot.analysis;
      const sameDocument = current !== undefined && current.id === incoming.id;
      const stale =
        current !== undefined &&
        current.sessionId === incoming.sessionId &&
        incoming.analysisVersion < current.analysisVersion;
      return sameDocument || stale ? snapshot : withChanges(snapshot, { analysis: incoming });
    }

    case 'panel.generated': {
      const payload = message.payload;
      if (belongsToOtherSession(snapshot, payload.sessionId)) {
        return snapshot;
      }
      const spec = payload.panel;
      const current = snapshot.panel;
      // A newer version, or one that supersedes the current panel, replaces
      // it; an older version of the same session's panel is a stale replay.
      const stale =
        current !== undefined &&
        current.spec.sessionId === spec.sessionId &&
        spec.panelVersion < current.spec.panelVersion &&
        spec.supersedes !== current.panelId;
      return stale
        ? snapshot
        : withChanges(snapshot, { panel: currentPanelFor(current, payload.panelId, spec) });
    }

    case 'cleanup.completed': {
      const payload = message.payload;
      if (belongsToOtherSession(snapshot, payload.sessionId)) {
        return snapshot;
      }
      return withChanges(snapshot, {
        cleanup: Object.freeze({
          status: payload.status,
          conflicts: Object.freeze([...payload.conflicts]),
        }),
      });
    }

    case 'target.request': {
      const payload = message.payload;
      if (belongsToOtherSession(snapshot, payload.sessionId) || snapshot.target.pickRequested) {
        return snapshot;
      }
      return withChanges(snapshot, {
        target: Object.freeze({ ...snapshot.target, pickRequested: true }),
      });
    }

    case 'error': {
      // Recorded as the last failure only — never folded into the analysis or
      // the panel, so a failure can never read as a result.
      if (
        belongsToOtherSession(snapshot, message.sessionId) ||
        sameError(snapshot.lastError, message.payload)
      ) {
        return snapshot;
      }
      return withChanges(snapshot, { lastError: message.payload });
    }

    default:
      return assertNever(message, 'Unhandled relayed message type');
  }
}

/*
 * ===========================================================================
 * Section K — hydration from the `session.snapshot` answer
 * ===========================================================================
 */

/**
 * The snapshot after hydrating from a `session.snapshot` answer.
 *
 * Replaced wholesale: the connection pill, the binding, the session record, the
 * current panel, the analysis and the capture counters (derived from the
 * record's latest capture, since the answer carries no counters of its own).
 * Preserved, because a reconnect after an MV3 worker suspension is not
 * something the developer did: the selected event, the pending target, the
 * accumulated live tail, the progress rows, the instrumentation outcome, the
 * cleanup outcome and the last error — unless the answer names a different
 * session, which resets them, or a different capture, which clears the tail.
 *
 * A record that is not the bound session's, and a panel or an analysis that is
 * not the shown session's, is dropped rather than rendered.
 */
function reduceSessionSnapshot(
  snapshot: PanelSnapshot,
  answer: PanelSessionSnapshot,
): PanelSnapshot {
  const binding = answer.binding;
  const boundSessionId = binding.kind === 'bound' ? binding.sessionId : undefined;
  const record =
    answer.session !== undefined &&
    boundSessionId !== undefined &&
    answer.session.id !== boundSessionId
      ? undefined
      : answer.session;
  const sessionId = boundSessionId ?? record?.id;
  const base = isSessionSwitch(snapshot, sessionId) ? resetSessionScope(snapshot) : snapshot;

  const spec = answer.panel;
  const panel =
    spec === undefined || (sessionId !== undefined && spec.sessionId !== sessionId)
      ? undefined
      : currentPanelFor(base.panel, spec.id, spec);

  const incomingAnalysis = answer.analysis;
  const analysis =
    incomingAnalysis === undefined ||
    (sessionId !== undefined && incomingAnalysis.sessionId !== sessionId)
      ? undefined
      : base.analysis !== undefined && base.analysis.id === incomingAnalysis.id
        ? base.analysis
        : incomingAnalysis;

  const capture = captureFromRecord(base.capture, record);
  const captureChanged =
    base.capture.captureId !== undefined &&
    capture.captureId !== undefined &&
    capture.captureId !== base.capture.captureId;

  const connectionState = answer.connection;
  return withChanges(base, {
    connection: nextConnection(
      base.connection,
      connectionState.status,
      connectionState.retryInMs,
      connectionState.serviceUrl,
      binding,
    ),
    session: record,
    panel,
    analysis,
    capture,
    target: record === undefined ? base.target : reconcileTarget(base.target, record, base.session),
    ...(captureChanged ? { liveTail: EMPTY_TAIL, liveTailDropped: 0 } : {}),
  });
}

/*
 * ===========================================================================
 * Section L — the write surface
 * ===========================================================================
 */

/**
 * Apply one relayed protocol frame — the only protocol-driven entry point,
 * called by `./connection.ts` for every push of `RELAYED_MESSAGE_TYPES`.
 *
 * Accepts the envelope or the whole `PortProtocolPush` that carries it, both
 * already narrowed by `isPortPush` from `../../shared/messages`; nothing is
 * re-validated here. A frame that changes nothing notifies nobody.
 *
 * @param input The relayed envelope, or the push frame carrying it.
 */
export function applyRelayedMessage(input: RelayedProtocolMessage | PortProtocolPush): void {
  const message = 'direction' in input ? input.message : input;
  commit(reduceRelayedMessage(state, message));
}

/**
 * Hydrate from the `session.snapshot` port answer `./connection.ts` requests on
 * connect and on every reconnect. See {@link reduceSessionSnapshot} for what is
 * replaced and what survives; absent optional fields are absent data, never an
 * error.
 *
 * @param snapshot The worker's answer.
 */
export function applySessionSnapshot(snapshot: PanelSessionSnapshot): void {
  commit(reduceSessionSnapshot(state, snapshot));
}

/**
 * Set the connection pill's state. Reserved for `./connection.ts`.
 *
 * Takes the imported vocabulary only — a `PanelConnectionStatus` (for instance
 * the result of `panelConnectionStatus()`, or `'reconnecting'` on a port
 * disconnect) or the worker's whole `PanelConnectionState` — and never a label:
 * rendering `PANEL_CONNECTION_LABELS[status]` is the components' business. A
 * bare status carries no retry delay and keeps the known service URL. A
 * repeated state changes nothing and notifies nobody.
 *
 * @param input The new status, or the worker's pushed connection state.
 */
export function setConnectionStatus(input: PanelConnectionStatus | PanelConnectionState): void {
  const connection = state.connection;
  const next =
    typeof input === 'string'
      ? nextConnection(connection, input, undefined, connection.serviceUrl, connection.binding)
      : nextConnection(
          connection,
          input.status,
          input.retryInMs,
          input.serviceUrl,
          connection.binding,
        );
  commit(withChanges(state, { connection: next }));
}

/**
 * Set the inspected tab's binding. Reserved for `./connection.ts`.
 *
 * Takes the imported `PanelBindingState` structurally; composing the
 * "Tab left ‹origin›" sentence with `formatTabLeftMessage` is the components'
 * business. A binding to a different session resets the session-scoped slices
 * first; a repeated binding changes nothing and notifies nobody.
 *
 * @param binding The new binding state.
 */
export function setBindingState(binding: PanelBindingState): void {
  commit(applyBinding(state, binding));
}

/**
 * Select the event the `EventDetails` drawer shows, or close it with
 * `undefined`. Called by `../actions.ts` from `PanelActions.onSelectEvent`.
 *
 * Local only: no port traffic and no side effect beyond the state change.
 * Selecting the event already selected — even through a fresh reference object
 * — changes nothing and notifies nobody. Only the reference's own fields are
 * kept, so a caller's object is never retained.
 *
 * @param ref The event to show, or `undefined` to close the drawer.
 */
export function selectEvent(ref: EventRef | undefined): void {
  if (sameEventRef(state.selectedEvent, ref)) {
    return;
  }
  const selected: EventRef | undefined =
    ref === undefined
      ? undefined
      : Object.freeze({
          eventId: ref.eventId,
          ...(ref.traceId === undefined ? {} : { traceId: ref.traceId }),
          ...(ref.spanId === undefined ? {} : { spanId: ref.spanId }),
          ...(ref.kind === undefined ? {} : { kind: ref.kind }),
          ...(ref.label === undefined ? {} : { label: ref.label }),
        });
  commit(withChanges(state, { selectedEvent: selected }));
}

/**
 * Set the optimistic target — the element the developer just picked, shown by
 * the target controls until a session record confirms it — or clear it with
 * `undefined`. Setting a target also clears a pending picker request.
 *
 * @param target The picked element's descriptor, or `undefined`.
 */
export function setPendingTarget(target: SelectedTarget | undefined): void {
  const current = state.target;
  const pending = sameTarget(current.pending, target) ? current.pending : target;
  const pickRequested = target === undefined ? current.pickRequested : false;
  if (pending === current.pending && pickRequested === current.pickRequested) {
    return;
  }
  commit(withChanges(state, { target: Object.freeze({ pending, pickRequested }) }));
}

/**
 * Surface a non-blocking failure the panel detected locally — a request the
 * worker refused or could not deliver — or dismiss the current one with
 * `undefined`.
 *
 * Shares {@link PanelSnapshot.lastError} with relayed `error` frames and is
 * rendered the same way: as an error state, never as analysis. The payload must
 * carry no request body, token or URL query value (AAP §0.5.2); a
 * `DebuggenError`'s `toPayload()` is the intended source.
 *
 * @param error The failure to surface, or `undefined` to dismiss.
 */
export function setLastError(error: ErrorPayload | undefined): void {
  if (sameError(state.lastError, error)) {
    return;
  }
  commit(withChanges(state, { lastError: error }));
}
