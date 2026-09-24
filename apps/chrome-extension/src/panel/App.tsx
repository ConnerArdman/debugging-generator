/**
 * `App` — the composition root of the "Debug Generator" DevTools panel.
 *
 * ## What this module owns, and what it deliberately does not
 *
 * The panel is split into single-owner modules, and this file is the one place
 * they meet:
 *
 * | Concern                                                  | Owner                      |
 * | -------------------------------------------------------- | -------------------------- |
 * | `createRoot`, the renderer stylesheet, the theme         | `./main.tsx`               |
 * | the runtime port, reconnects, the hydration request      | `./state/connection.ts`    |
 * | every piece of session, panel and capture state          | `./state/session-store.ts` |
 * | resolving a node's `DataQuery` over the port             | `./data-provider.ts`       |
 * | selecting an event and opening a source location         | `./actions.ts`             |
 * | the wording, states and inner focus of each region       | `./components/*`           |
 * | the connection's lifetime, the provider and the actions  | this file                  |
 * | built once, the commands, the layout, the drawer's focus | this file                  |
 *
 * So this file starts the connection on mount and releases it on unmount
 * (`startPanelConnection` is reference-counted, so React StrictMode's double
 * effect leaves exactly one port), builds the data provider and the actions
 * once with `useMemo` — their identities must stay stable, because `PanelHost`
 * keys every query effect and memo on them — reads the store's snapshot, and
 * composes the ten panel components. It holds no copy of any session, panel,
 * analysis, capture, live-tail, selection or target state: the store is the only
 * state container. The two `useState` hooks below are presentation-only and
 * duplicate nothing — whether the developer dismissed the pairing dialog, and
 * whether the live tail is collapsed.
 *
 * ## Layout (AAP 0.7.3)
 *
 * ```text
 * Stack (vertical)                           the one top-level arrangement
 * ├── Header → <header>                      wordmark · ConnectionStatus · session title
 * │                                          and status badge · TargetPicker · CaptureControls
 * ├── PairDialog                             while the connection says "Not paired"
 * ├── Split                                  the body and the right drawer
 * │   ├── <main>                             lastError notice · EmptyPanel, or
 * │   │                                      SessionSummary + PanelView (PanelHost)
 * │   └── <aside> → Section (card)           EventDetails — only while an event is selected
 * └── <section> "Live event tail"            LiveTail, with its own collapse Button
 * ```
 *
 * There is **no second `PanelShell`**. `PanelHost` renders the generated panel's
 * shell — its theme root and its one scroll region — and wrapping the whole
 * application in another would create two competing scroll viewports. The panel
 * chrome around it resolves the `--dg-*` tokens because `./theme` applied the
 * theme attribute to the document root before first paint; the same theme is
 * forwarded to `PanelHost` so both roots always render one token set.
 *
 * ## States (AAP 0.7.3, 0.5.5)
 *
 * - **No session** — `EmptyPanel`, which owns the "No session yet" copy.
 * - **Session, panel being generated** (`analyzing`) — `PanelView`'s
 *   `LoadingState`, or, while a follow-up regenerates a panel already on screen,
 *   a one-row `LoadingState` beside it.
 * - **Failed** — `PanelView`'s `ErrorState` naming the failing stage, with a retry
 *   that re-hydrates the panel from the service; beside the panel instead of it
 *   when a panel from an earlier run is on screen. Never a successful analysis.
 * - **Panel present** — `PanelView` → `PanelHost`, with the layout exactly as it
 *   was generated. `meta.fallback` is a legitimate success: `PanelHost` renders
 *   its own fallback banner, and nothing here reads the flag.
 * - **Unbound, or the tab navigated away** — `ConnectionStatus` renders the
 *   binding line through `formatTabLeftMessage`; nothing here words it.
 * - **Not paired / service not running / reconnecting** — the pill's own
 *   recovery affordances, plus `PairDialog` for pairing.
 *
 * Every state renders with `chrome.devtools` undefined, which is how the browser
 * suite opens the panel page directly as an extension page: the element-target
 * controls then render unavailable with an explanatory tooltip (`TargetPicker`),
 * and nothing throws.
 *
 * ## Commands never reject
 *
 * `CaptureControls` and `TargetPicker` hold their control busy while a returned
 * promise is pending and re-raise a rejection, which in an extension page is an
 * unhandled rejection. So every command below catches its own failure, surfaces
 * it through the store's non-blocking `lastError` — rendered as an error state,
 * never as analysis — and resolves. Each is a module-level function that reads
 * the store and the session at call time, so its identity is stable for the
 * life of the document and no dependency array is involved.
 *
 * ## Boundaries
 *
 * - No `WebSocket`, no `fetch`, no HTTP client: the port owned by
 *   `./state/connection` is the panel's only channel, and every request here is
 *   one of its typed port requests. Protocol usage is types only.
 * - No validation, normalisation or repair of panel specifications: the service
 *   validated what it pushed, and `PanelHost` renders validated specs only.
 * - No node filtering and no branching on a panel's title or the session's
 *   question (AAP 0.5.4, 0.6.5): the two demonstrated questions produce panels
 *   with different component sets, and this file passes either through intact.
 * - No visual value: every gap is a `SpaceStep`, the drawer's width is a unitless
 *   `Split` pane weight, and every element with an appearance is a renderer
 *   primitive. The raw elements are the landmarks no primitive renders:
 *   `<main>`, `<aside>` and the live tail's `<section>`.
 *
 * @module apps/chrome-extension/src/panel/App
 */

import {
  Button,
  DataProviderContext,
  ErrorState,
  LoadingState,
  PanelSessionContext,
  Section,
  Split,
  Stack,
  useQuery,
} from '@debuggen/panel-renderer';
import { DATA_QUERY_MAX_LIMIT } from '@debuggen/panel-schema';
import type { DataQuery, EventRef } from '@debuggen/panel-schema';
import type {
  ErrorPayload,
  ProgressStage,
  SelectedTarget,
  SessionStatus,
  TelemetryEvent,
} from '@debuggen/protocol';
import { DebuggenError, assertNever } from '@debuggen/shared';
import type { DebuggenErrorCode, SessionId } from '@debuggen/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import type { PanelConnectionStatus, PortRequestPayloads } from '../shared/messages';

import { createPanelActions } from './actions';
import type { DevtoolsPanelActions } from './actions';
import { CaptureControls } from './components/CaptureControls';
import { ConnectionStatus } from './components/ConnectionStatus';
import { EmptyPanel } from './components/EmptyPanel';
import { EventDetails } from './components/EventDetails';
import type { EventDetailsError, EventDetailsStatus } from './components/EventDetails';
import { Header } from './components/Header';
import { LiveTail } from './components/LiveTail';
import { PairDialog } from './components/PairDialog';
import { PanelView } from './components/PanelView';
import type { PanelViewError, PanelViewStatus } from './components/PanelView';
import { SessionSummary } from './components/SessionSummary';
import { TargetPicker } from './components/TargetPicker';
import { createPanelDataProvider } from './data-provider';
import {
  getPanelConnection,
  onPortDisconnect,
  panelRequest,
  readInspectedTabId,
  startPanelConnection,
} from './state/connection';
import {
  getPanelSnapshot,
  getSessionId,
  selectEvent,
  setLastError,
  setPendingTarget,
  setPickerActive,
  usePanelSnapshot,
} from './state/session-store';
import type { PanelInstrumentationFailure, PanelProgressEntry } from './state/session-store';
import type { PanelTheme } from './theme';

/*
 * ===========================================================================
 * Section A — public surface
 * ===========================================================================
 */

/** Props of {@link App}. */
export interface AppProps {
  /**
   * The theme `./main.tsx` resolved from DevTools and applied to the document
   * root before first paint. Forwarded to `PanelHost` unchanged, so the
   * generated panel and the chrome around it render from one token set.
   */
  theme: PanelTheme;
}

/*
 * ===========================================================================
 * Section B — copy and layout constants
 *
 * Generic product vocabulary only: everything a developer's project
 * contributes arrives as captured data at render time (AAP 0.5.4).
 * ===========================================================================
 */

/** The accessible name of the live tail's region landmark. */
const LIVE_TAIL_REGION_LABEL = 'Live event tail';

/** The accessible name of the right drawer's complementary landmark. */
const DRAWER_LABEL = 'Selected event';

/**
 * The body and the drawer as unitless `Split` pane weights: the drawer grows at
 * six tenths of the body's rate, so beside it the drawer takes three eighths of
 * the width. A pane's weight also scales the width it asks for before sharing a
 * line, so these small weights keep the drawer beside the body in an ordinary
 * DevTools window, and a docked panel too narrow for both collapses them into
 * one column (the `Split` default for a horizontal division). Neither pane
 * states a width.
 */
const DRAWER_PANE_WEIGHTS: readonly number[] = Object.freeze([1, 0.6]);

/** Why capture is unavailable while the worker is not connected to the service. */
const CAPTURE_NEEDS_CONNECTION =
  'Capture is unavailable until this panel is connected to the local Debug Generator service.';

/** Announced while a follow-up regenerates a panel that is already on screen. */
const REGENERATING_LABEL = 'Regenerating the debugging panel';

/** The first line of the notice shown beside a panel from an earlier run when the session failed. */
const SESSION_FAILED_TITLE = 'The debugging session failed';

/** The message used when a failed session carries no failing stage the panel can name. */
const SESSION_FAILED_FALLBACK =
  'The session stopped before the failing stage was reported to this panel.';

/** The first line of the non-blocking failure notice. */
const LAST_ERROR_TITLE = 'A Debug Generator request did not complete';

/** The label of the control that dismisses the non-blocking failure notice. */
const DISMISS_LABEL = 'Dismiss';

/** The retry control's label on the session-failure notice: it re-reads the session. */
const RELOAD_SESSION_LABEL = 'Reload session state';

/** The lead of each command's failure message; the cause follows a colon. */
const FAILURE_LEADS = Object.freeze({
  captureStart: 'Could not start the capture',
  captureStop: 'Could not stop the capture',
  pick: 'Could not change picker mode',
  useSelected: 'Could not use the selected element',
} as const);

/** Why a command that needs a session could not run: the panel shows none. */
const NO_SESSION_REASON =
  'this panel is not bound to a Debug Generator session. Start one from the Debug Generator view in VS Code, then try again.';

/** The drawer's error when the selected event is not in the stored capture. */
const EVENT_NOT_FOUND: EventDetailsError = Object.freeze({
  message: 'The selected event is not in the stored capture of this session.',
  hint: 'Select the event again from the panel, or retry once the capture has been stored.',
});

/** Why "Use selected element" could not describe the Elements panel's selection. */
const SELECTION_NOT_DESCRIBED =
  'the element selected in the Elements panel could not be described. Select an element on a page the Debug Generator agent is running on (reload the page if it was open before the extension), then try again.';

/** Why "Use selected element" cannot run at all outside Chrome DevTools. */
const DEVTOOLS_UNAVAILABLE = 'Chrome DevTools is not available to this panel.';

/**
 * The expression "Use selected element" evaluates in the inspected page with
 * `chrome.devtools.inspectedWindow.eval`.
 *
 * `$0` is DevTools' handle on the Elements panel's current selection, and
 * `describeTarget` is the function the MAIN-world telemetry agent publishes on
 * its helper global exactly so that this evaluation can reach it: it returns
 * the five-field, already-redacted `SelectedTarget` descriptor, or nothing when
 * the selection is not an element or the agent is not attached. The expression
 * answers `null` in every case where there is no descriptor, because
 * `inspectedWindow.eval` transports JSON-compliant values only and `undefined`
 * is not one.
 */
const DESCRIBE_SELECTION_EXPRESSION = [
  '(function () {',
  '  var helper = window.__DEBUGGEN__;',
  "  if (!helper || typeof helper.describeTarget !== 'function') { return null; }",
  '  var described = helper.describeTarget($0);',
  '  return described === undefined ? null : described;',
  '})()',
].join('\n');

/*
 * ===========================================================================
 * Section C — pure helpers
 * ===========================================================================
 */

/** Whether a value is a non-null, non-array object whose members can be read. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is a string with at least one non-whitespace character. */
function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The `chrome.devtools` namespace when this document runs inside DevTools, read
 * without assuming it exists: the panel page opened directly as an extension
 * page has `chrome` but no `chrome.devtools`, and a unit document may have no
 * `chrome` at all. Read structurally by `readInspectedTabId`, which never throws.
 */
function readDevtools(): unknown {
  return typeof chrome === 'undefined' ? undefined : chrome.devtools;
}

/**
 * Whether this document is hosted by Chrome DevTools, decided by the same
 * never-throwing read `./state/connection` and `TargetPicker` use: a numeric
 * `chrome.devtools.inspectedWindow.tabId`.
 */
function isDevtoolsAvailable(): boolean {
  return readInspectedTabId(readDevtools) !== undefined;
}

/**
 * The store record of a failed command: the command's lead, then the cause as
 * the layer that observed it stated it, with its hint when it had one.
 *
 * A rejection from the panel connection is already a `DebuggenError` and keeps
 * its code, message, hint and correlation `ref`; anything else is classified by
 * `fallbackCode`. Nothing private reaches the record: the connection's errors
 * carry no payload, token or URL query value (AAP 0.5.2).
 *
 * @param lead What the command was trying to do, as a sentence fragment.
 * @param cause What the command's request rejected with, or threw.
 * @param fallbackCode The code for a cause that carries none of its own.
 * @returns A frozen `ErrorPayload` for `setLastError`.
 */
function failurePayload(
  lead: string,
  cause: unknown,
  fallbackCode: DebuggenErrorCode,
): ErrorPayload {
  const error = DebuggenError.from(cause, fallbackCode);
  const hint = error.hint;
  const message =
    hint === undefined || hint.trim() === ''
      ? `${lead}: ${error.message}`
      : `${lead}: ${error.message} ${hint}`;
  const ref = error.details?.ref;
  return Object.freeze(
    typeof ref === 'string' && ref !== ''
      ? { code: error.code, message, ref }
      : { code: error.code, message },
  );
}

/** Surface a failed command through the store's non-blocking `lastError`. */
function reportFailure(lead: string, cause: unknown, fallbackCode: DebuggenErrorCode): void {
  setLastError(failurePayload(lead, cause, fallbackCode));
}

/**
 * The session a command addresses, or `undefined` — after surfacing why — when
 * the panel shows none. Read at call time, so a binding that changed after the
 * command was wired is honoured.
 *
 * @param lead The command's failure lead, used when there is no session.
 */
function requireSession(lead: string): SessionId | undefined {
  const sessionId = getSessionId();
  if (sessionId === undefined) {
    setLastError(
      Object.freeze({ code: 'TAB_NOT_BOUND', message: `${lead}: ${NO_SESSION_REASON}` }),
    );
  }
  return sessionId;
}

/**
 * The developer-facing name of a pipeline stage, for the failure notice that
 * names the failing stage (AAP 0.5.5). Exhaustive over `PROGRESS_STAGES`, so a
 * stage added to the protocol is a compile error here rather than a blank name.
 *
 * @param stage The stage that reported the failure.
 * @returns The stage's name, capitalised to open a sentence.
 */
function stageLabel(stage: ProgressStage): string {
  switch (stage) {
    case 'understand':
      return 'Problem understanding';
    case 'investigate':
      return 'Code investigation';
    case 'plan':
      return 'Instrumentation planning';
    case 'instrument':
      return 'Instrumentation';
    case 'capture':
      return 'Runtime capture';
    case 'analyze':
      return 'Analysis';
    case 'generate-panel':
      return 'Panel generation';
    case 'followup':
      return 'Follow-up';
    case 'cleanup':
      return 'Cleanup';
    default:
      return assertNever(stage, 'Unhandled progress stage in the panel');
  }
}

/**
 * What a failed session reports, naming the failing stage: the latest progress
 * row the service marked failed, otherwise the latest instrumentation failure,
 * otherwise nothing — in which case the caller's generic wording applies. Every
 * sentence here was composed by the service; this only prefixes the stage.
 *
 * @param progress The session's progress rows, in first-arrival order.
 * @param failure The latest `instrumentation.failed` report, if any.
 * @returns The failure to show, or `undefined` when none was reported.
 */
function describeSessionFailure(
  progress: readonly PanelProgressEntry[],
  failure: PanelInstrumentationFailure | undefined,
): PanelViewError | undefined {
  for (let index = progress.length - 1; index >= 0; index -= 1) {
    const entry = progress[index];
    if (entry !== undefined && entry.status === 'failed') {
      const detail =
        entry.detail === undefined || entry.detail.trim() === '' ? '' : ` ${entry.detail}`;
      return { message: `${stageLabel(entry.stage)} failed: ${entry.message}${detail}` };
    }
  }
  if (failure !== undefined) {
    return { message: `${stageLabel('instrument')} failed: ${failure.message} ${failure.hint}` };
  }
  return undefined;
}

/**
 * What the generated-panel region knows about generation from the session's
 * status: `analyzing` is analysis and panel generation in flight, `failed` is a
 * stop without a result, and every other status leaves the region idle.
 *
 * @param status The session's status, or `undefined` without a session.
 */
function generationStatus(status: SessionStatus | undefined): PanelViewStatus {
  if (status === 'analyzing') {
    return 'generating';
  }
  if (status === 'failed') {
    return 'error';
  }
  return 'idle';
}

/**
 * The `SelectedTarget` an evaluation of {@link DESCRIBE_SELECTION_EXPRESSION}
 * answered, or `undefined` when it answered anything else.
 *
 * The value crossed from the inspected page, which this extension does not
 * control, so it is checked field by field and rebuilt with exactly the five
 * keys of the descriptor: `selector`, `tagName`, the optional `text`,
 * `componentChain` (nearest first, possibly empty) and `url`. Bounds and
 * character rules are the service's schema's to enforce; a descriptor it
 * refuses comes back as a typed failure.
 *
 * @param value What the evaluation returned.
 */
function toSelectedTarget(value: unknown): SelectedTarget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { selector, tagName, text, componentChain, url } = value;
  if (!isFilledString(selector) || !isFilledString(tagName) || !isFilledString(url)) {
    return undefined;
  }
  if (!Array.isArray(componentChain)) {
    return undefined;
  }
  const entries: readonly unknown[] = componentChain;
  const chain: string[] = [];
  for (const name of entries) {
    if (!isFilledString(name)) {
      return undefined;
    }
    chain.push(name);
  }
  if (text !== undefined && !isFilledString(text)) {
    return undefined;
  }
  return text === undefined
    ? { selector, tagName, componentChain: chain, url }
    : { selector, tagName, text, componentChain: chain, url };
}

/** Whether two descriptors name the same element on the same document. */
function sameTargetIdentity(left: SelectedTarget, right: SelectedTarget): boolean {
  return (
    left.selector === right.selector && left.url === right.url && left.tagName === right.tagName
  );
}

/**
 * Evaluate {@link DESCRIBE_SELECTION_EXPRESSION} in the inspected page.
 *
 * Resolves with the descriptor, or `undefined` when the selection could not be
 * described; rejects with a typed failure when DevTools is not available or the
 * evaluation itself failed. Never throws synchronously.
 */
function describeSelectedElement(): Promise<SelectedTarget | undefined> {
  return new Promise((resolve, reject) => {
    if (!isDevtoolsAvailable()) {
      reject(new DebuggenError('AGENT_NOT_READY', DEVTOOLS_UNAVAILABLE));
      return;
    }
    try {
      chrome.devtools.inspectedWindow.eval<unknown>(
        DESCRIBE_SELECTION_EXPRESSION,
        (
          result: unknown,
          exceptionInfo?: chrome.devtools.inspectedWindow.EvaluationExceptionInfo,
        ) => {
          if (exceptionInfo !== undefined) {
            reject(new DebuggenError('AGENT_NOT_READY', SELECTION_NOT_DESCRIBED));
            return;
          }
          resolve(toSelectedTarget(result));
        },
      );
    } catch (cause: unknown) {
      reject(DebuggenError.from(cause, 'AGENT_NOT_READY'));
    }
  });
}

/**
 * The query that resolves the drawer's selected event: every stored event of
 * the selection's trace when its trace is known — one query yields the event
 * and its whole ancestry — and otherwise the first page of the capture's
 * events. The page is the largest the protocol permits, so a trace fits in one.
 *
 * @param traceId The selection's trace, when known.
 */
function eventResolutionQuery(traceId: string | undefined): DataQuery & { source: 'events' } {
  return traceId === undefined
    ? { source: 'events', limit: DATA_QUERY_MAX_LIMIT }
    : { source: 'events', filter: { traceId }, limit: DATA_QUERY_MAX_LIMIT };
}

/** The event with `eventId` in `events`, or `undefined`. */
function findEvent(
  events: readonly TelemetryEvent[] | undefined,
  eventId: string,
): TelemetryEvent | undefined {
  return events?.find((candidate) => candidate.id === eventId);
}

/**
 * The selected event's ancestors, from the trace root to its immediate parent,
 * built only from stored events — never synthesised from `parentSpanId` alone.
 *
 * A root event answers an empty chain. When an ancestor is missing from
 * `pool` (a partial page, or a parent that never arrived), the chain cannot be
 * stated from the root and `undefined` is answered, so the drawer omits the
 * section rather than presenting a fragment as the whole lineage.
 *
 * @param event The selected event.
 * @param pool Stored events to look ancestors up in.
 */
function buildParentChain(
  event: TelemetryEvent,
  pool: readonly TelemetryEvent[],
): readonly TelemetryEvent[] | undefined {
  const bySpan = new Map<string, TelemetryEvent>();
  for (const candidate of pool) {
    if (candidate.traceId === event.traceId && !bySpan.has(candidate.spanId)) {
      bySpan.set(candidate.spanId, candidate);
    }
  }
  const chain: TelemetryEvent[] = [];
  const visited = new Set<string>([event.spanId]);
  let parentSpanId = event.parentSpanId;
  while (parentSpanId !== undefined) {
    const parent = bySpan.get(parentSpanId);
    if (parent === undefined || visited.has(parentSpanId)) {
      return undefined;
    }
    visited.add(parentSpanId);
    chain.push(parent);
    parentSpanId = parent.parentSpanId;
  }
  return chain.reverse();
}

/*
 * ===========================================================================
 * Section D — commands
 *
 * Module-level, so each identity is stable for the life of the document; each
 * reads the store and the session when it runs, never when it was wired. Every
 * one catches its own failure, surfaces it through `lastError` and resolves —
 * see "Commands never reject" in the module header.
 * ===========================================================================
 */

/** "Start capture": the worker calls the service's capture-start route for the session. */
async function startCapture(): Promise<void> {
  const sessionId = requireSession(FAILURE_LEADS.captureStart);
  if (sessionId === undefined) {
    return;
  }
  try {
    // The answer's capture id also arrives as the relayed `capture.started`
    // push, which is what the store records; the answer itself adds nothing.
    await panelRequest('capture.start', { sessionId });
  } catch (cause: unknown) {
    reportFailure(FAILURE_LEADS.captureStart, cause, 'TRANSPORT_DISCONNECTED');
  }
}

/** "Stop capture": the worker calls the service's capture-stop route for the session. */
async function stopCapture(): Promise<void> {
  const sessionId = requireSession(FAILURE_LEADS.captureStop);
  if (sessionId === undefined) {
    return;
  }
  try {
    // The summary also arrives as the relayed `capture.stopped` push.
    await panelRequest('capture.stop', { sessionId });
  } catch (cause: unknown) {
    reportFailure(FAILURE_LEADS.captureStop, cause, 'TRANSPORT_DISCONNECTED');
  }
}

/**
 * "Pick element": toggle picker mode. The new state is shown at once through
 * the store, relayed as the worker's `target.pick` request, and corrected to
 * the worker's answer — or restored — while nothing else has changed it since.
 */
async function togglePicker(): Promise<void> {
  const sessionId = requireSession(FAILURE_LEADS.pick);
  if (sessionId === undefined) {
    return;
  }
  const wasActive = getPanelSnapshot().target.pickRequested;
  const enabled = !wasActive;
  setPickerActive(enabled);

  // Whether the optimistic state is still the one on screen for this session:
  // a confirmed target, the session ending or a rebind may have moved it on.
  const stillOptimistic = (): boolean =>
    getSessionId() === sessionId && getPanelSnapshot().target.pickRequested === enabled;

  try {
    const { active } = await panelRequest('target.pick', { sessionId, enabled });
    if (active !== enabled && stillOptimistic()) {
      setPickerActive(active);
    }
  } catch (cause: unknown) {
    if (stillOptimistic()) {
      setPickerActive(wasActive);
    }
    reportFailure(FAILURE_LEADS.pick, cause, 'TRANSPORT_DISCONNECTED');
  }
}

/**
 * "Use selected element": describe the Elements panel's `$0` through the page
 * agent, show it at once as the optimistic target, and forward it as the
 * worker's `target.selected` request. A refusal clears the optimistic target
 * again, while it is still the one on screen.
 */
async function adoptSelectedElement(): Promise<void> {
  const sessionId = requireSession(FAILURE_LEADS.useSelected);
  if (sessionId === undefined) {
    return;
  }

  let target: SelectedTarget | undefined;
  try {
    target = await describeSelectedElement();
  } catch (cause: unknown) {
    reportFailure(FAILURE_LEADS.useSelected, cause, 'AGENT_NOT_READY');
    return;
  }
  if (target === undefined) {
    setLastError(
      Object.freeze({
        code: 'AGENT_NOT_READY',
        message: `${FAILURE_LEADS.useSelected}: ${SELECTION_NOT_DESCRIBED}`,
      }),
    );
    return;
  }

  const picked = target;
  setPendingTarget(picked);
  const withdraw = (): void => {
    const pending = getPanelSnapshot().target.pending;
    if (
      getSessionId() === sessionId &&
      pending !== undefined &&
      sameTargetIdentity(pending, picked)
    ) {
      setPendingTarget(undefined);
    }
  };

  try {
    const { accepted } = await panelRequest('target.selected', { sessionId, target: picked });
    if (!accepted) {
      withdraw();
      reportFailure(
        FAILURE_LEADS.useSelected,
        new DebuggenError('TRANSPORT_DISCONNECTED', 'the service did not accept the element.'),
        'TRANSPORT_DISCONNECTED',
      );
    }
  } catch (cause: unknown) {
    withdraw();
    reportFailure(FAILURE_LEADS.useSelected, cause, 'TRANSPORT_DISCONNECTED');
  }
}

/**
 * `PairDialog`'s submit: redeem the one-time code through the worker, which
 * keeps the credential it receives. Rejects with the worker's typed failure so
 * the dialog shows it in place — the dialog owns that promise and never lets
 * it escape — and resolves on `{ paired: true }`.
 *
 * @param code The trimmed, non-empty code the developer typed.
 */
async function submitPairingCode(
  code: PortRequestPayloads['pair.complete']['code'],
): Promise<void> {
  await panelRequest('pair.complete', { code });
}

/** Re-read the session from the service: the failure notice's retry. */
function reloadSessionState(): void {
  getPanelConnection().resync();
}

/** Dismiss the non-blocking failure notice. */
function dismissLastError(): void {
  setLastError(undefined);
}

/*
 * ===========================================================================
 * Section E — the drawer's event resolution
 * ===========================================================================
 */

/** Props of {@link EventDrawer}. */
interface EventDrawerProps {
  /** The store's selection: the event the drawer explains. */
  readonly selected: EventRef;
  /** The store's bounded live tail, consulted before the stored capture answers. */
  readonly liveTail: readonly TelemetryEvent[];
  /** The panel's actions, passed explicitly: the drawer renders outside `PanelHost`. */
  readonly actions: DevtoolsPanelActions;
}

/**
 * Resolves the store's selected `EventRef` to a stored event and renders
 * `EventDetails` for it.
 *
 * The selection is only a pointer — an event id with the trace and span it
 * belongs to — so the event itself is looked up in two places: the live tail,
 * which answers at once for an event that just streamed in, and the session's
 * stored capture, queried through the renderer's own `useQuery` against the
 * provider and session contexts this component is mounted under. The stored
 * trace also supplies the parent chain. The drawer is loading only while
 * neither source has the event, and an error only when the stored capture
 * answered without it or could not be reached — never an empty drawer
 * presented as if nothing were selected (AAP 0.5.5).
 */
function EventDrawer(props: EventDrawerProps): ReactElement {
  const { selected, liveTail, actions } = props;
  const { eventId } = selected;

  const fromTail = useMemo(() => findEvent(liveTail, eventId), [liveTail, eventId]);
  const traceId = selected.traceId ?? fromTail?.traceId;
  const query = useMemo(() => eventResolutionQuery(traceId), [traceId]);
  const stored = useQuery(query);

  const storedEvents = stored.status === 'success' ? stored.data : undefined;
  const event = findEvent(storedEvents, eventId) ?? fromTail;
  const parentChain = useMemo(
    () => (event === undefined ? undefined : buildParentChain(event, storedEvents ?? liveTail)),
    [event, storedEvents, liveTail],
  );

  let status: EventDetailsStatus = 'idle';
  let error: EventDetailsError | undefined;
  if (event === undefined) {
    if (stored.status === 'loading') {
      status = 'loading';
    } else {
      status = 'error';
      error =
        stored.status === 'error' && stored.error !== undefined ? stored.error : EVENT_NOT_FOUND;
    }
  }

  return (
    <EventDetails
      event={event}
      parentChain={parentChain}
      status={status}
      error={error}
      onRetry={status === 'error' ? stored.retry : undefined}
      onOpenSource={actions.onOpenSource}
      onSelectEvent={actions.onSelectEvent}
      onClose={actions.clearSelectedEvent}
    />
  );
}

/*
 * ===========================================================================
 * Section F — the composition root
 * ===========================================================================
 */

/** Reads the store's current non-blocking failure, for the actions' dismissal rule. */
function readLastError(): ErrorPayload | undefined {
  return getPanelSnapshot().lastError;
}

/**
 * Return focus after a transient region — the drawer or the pairing dialog —
 * closed, unless the developer already moved it somewhere that still exists:
 * to `opener` while it is still in the document, otherwise to `fallback`.
 *
 * @param opener What held focus when the region opened, if anything.
 * @param fallback The panel body, focusable programmatically.
 */
function restoreFocus(opener: Element | null, fallback: HTMLElement | null): void {
  const active = document.activeElement;
  if (active !== null && active !== document.body && active.isConnected) {
    return;
  }
  if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
    opener.focus();
    return;
  }
  fallback?.focus();
}

/** Why capture cannot be used right now, or `undefined` when it can. */
function captureDisabledReason(status: PanelConnectionStatus): string | undefined {
  return status === 'connected' ? undefined : CAPTURE_NEEDS_CONNECTION;
}

/**
 * The "Debug Generator" DevTools panel.
 *
 * @param props See {@link AppProps}.
 * @returns The panel: header, body, drawer, live tail and pairing dialog.
 *
 * @example
 * // `./main.tsx`, after resolving and applying the theme before first paint:
 * createRoot(container).render(<App theme={theme} />);
 */
export function App(props: AppProps): ReactElement {
  const { theme } = props;

  // The connection's lifetime is the panel's. `startPanelConnection` counts
  // references and defers its teardown to the end of the microtask, so
  // StrictMode's mount-unmount-mount leaves one port and one hydration.
  useEffect(() => {
    const connection = startPanelConnection();
    return () => {
      connection.stop();
    };
  }, []);

  // Built once. Both are pure factories over module-stable functions that read
  // the live port and the live session at call time, so one instance serves the
  // document across every reconnect and rebind — and their stable identities
  // are what keep `PanelHost`'s query effects and memoized views from re-running.
  const dataProvider = useMemo(
    () => createPanelDataProvider({ request: panelRequest, getSessionId, onPortDisconnect }),
    [],
  );
  const actions = useMemo(
    () =>
      createPanelActions({
        request: panelRequest,
        getSessionId,
        selectEvent,
        reportError: setLastError,
        getLastError: readLastError,
      }),
    [],
  );

  // Whether DevTools hosts this document cannot change while it is loaded.
  const devtoolsAvailable = useMemo(() => isDevtoolsAvailable(), []);

  const snapshot = usePanelSnapshot();
  const {
    connection,
    session,
    progress,
    panel,
    capture,
    liveTail,
    liveTailDropped,
    selectedEvent,
    target,
    instrumentation,
    cleanup,
    lastError,
  } = snapshot;

  // Presentation-only state, duplicating nothing in the store: the pairing
  // dialog dismissed for the current connection episode, and the tail's
  // disclosure. `lastChangeAt` moves on every connection change, so a
  // dismissal holds only until the connection changes again.
  const [pairDismissedAt, setPairDismissedAt] = useState<number | undefined>(undefined);
  const [tailCollapsed, setTailCollapsed] = useState(false);

  const pairDialogOpen =
    connection.status === 'not-paired' && pairDismissedAt !== connection.lastChangeAt;
  const openPairDialog = useCallback(() => {
    setPairDismissedAt(undefined);
  }, []);
  const closePairDialog = useCallback(() => {
    setPairDismissedAt(getPanelSnapshot().connection.lastChangeAt);
  }, []);
  const toggleTail = useCallback(() => {
    setTailCollapsed((collapsed) => !collapsed);
  }, []);

  // The drawer's focus: moved into the drawer when it opens, and returned to
  // whatever opened it — or to the body — when it closes, unless the developer
  // already moved focus somewhere that still exists. "Close", and Escape from
  // anywhere inside the details, are `EventDetails`' own; both close through
  // `actions.clearSelectedEvent`.
  const drawerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const drawerOpen = selectedEvent !== undefined;
  useEffect(() => {
    if (!drawerOpen) {
      return undefined;
    }
    const opener = document.activeElement;
    const main = mainRef.current;
    drawerRef.current?.focus();
    return () => {
      restoreFocus(opener, main);
    };
  }, [drawerOpen]);

  // Escape while focus sits on the drawer landmark itself — where opening the
  // drawer puts it — closes the drawer too. A key aimed at anything inside is
  // left to `EventDetails`, whose own handler (and the grid's own use of
  // Escape) must win, which is why only the landmark's own key closes here.
  const { clearSelectedEvent } = actions;
  const handleDrawerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (
        event.key !== 'Escape' ||
        event.target !== event.currentTarget ||
        event.defaultPrevented
      ) {
        return;
      }
      event.preventDefault();
      clearSelectedEvent();
    },
    [clearSelectedEvent],
  );

  // The pairing dialog restores focus to whatever held it before it opened; an
  // automatically opened dialog had no opener, so focus that would otherwise
  // fall to the document body lands on the panel body instead.
  useEffect(() => {
    if (!pairDialogOpen) {
      return undefined;
    }
    const main = mainRef.current;
    return () => {
      restoreFocus(null, main);
    };
  }, [pairDialogOpen]);

  const spec = panel?.spec;
  const sessionStatus = session?.status;
  const viewStatus = generationStatus(sessionStatus);
  const sessionFailure =
    viewStatus === 'error' ? describeSessionFailure(progress, instrumentation.failure) : undefined;
  const querySessionId: string | undefined = spec?.sessionId ?? session?.id;
  const hasSession = session !== undefined || spec !== undefined;

  // design-system gap: the drawer pane has no scroll region of its own. The
  // renderer sanctions exactly one `overflow` container (`PanelShell`, which
  // `PanelHost` already renders for the body), so a drawer taller than the
  // viewport scrolls with the document rather than inside its pane.
  // The drawer's surface is the renderer's card `Section`: the elevated
  // surface the token table assigns to cards, tables and the drawer.
  const drawer =
    selectedEvent === undefined ? null : (
      <aside
        ref={drawerRef}
        tabIndex={-1}
        aria-label={DRAWER_LABEL}
        onKeyDown={handleDrawerKeyDown}
      >
        <Section variant="card">
          <DataProviderContext.Provider value={dataProvider}>
            <PanelSessionContext.Provider value={querySessionId}>
              <EventDrawer selected={selectedEvent} liveTail={liveTail} actions={actions} />
            </PanelSessionContext.Provider>
          </DataProviderContext.Provider>
        </Section>
      </aside>
    );

  return (
    <Stack direction="vertical" gap={3}>
      <Header
        connectionStatus={
          <ConnectionStatus
            status={connection.status}
            binding={connection.binding}
            serviceUrl={connection.serviceUrl}
            pairingDialogOpen={pairDialogOpen}
            onRequestPairing={openPairDialog}
          />
        }
        targetPicker={
          <TargetPicker
            target={target.pending ?? session?.target}
            pickerActive={target.pickRequested}
            onPick={togglePicker}
            onUseSelected={adoptSelectedElement}
            devtoolsAvailable={devtoolsAvailable}
          />
        }
        captureControls={
          <CaptureControls
            sessionStatus={sessionStatus}
            captureId={capture.captureId}
            eventCount={capture.eventCount}
            onStartCapture={startCapture}
            onStopCapture={stopCapture}
            disabledReason={captureDisabledReason(connection.status)}
          />
        }
        sessionTitle={session?.question}
        sessionStatus={sessionStatus}
      />

      {/* Directly under the header, so the dialog is in view the moment the
          connection reports "Not paired", whatever the body holds below it. */}
      <PairDialog
        open={pairDialogOpen}
        onClose={closePairDialog}
        submitCode={submitPairingCode}
        onPaired={reloadSessionState}
      />

      <Split weights={drawerOpen ? DRAWER_PANE_WEIGHTS : undefined} align="start">
        <main ref={mainRef} tabIndex={-1}>
          <Stack direction="vertical" gap={3}>
            {lastError === undefined ? null : (
              <Stack direction="vertical" gap={2} align="start">
                <ErrorState
                  title={LAST_ERROR_TITLE}
                  message={lastError.message}
                  code={lastError.code}
                  announce="polite"
                />
                <Button variant="secondary" size="sm" onClick={dismissLastError}>
                  {DISMISS_LABEL}
                </Button>
              </Stack>
            )}

            {hasSession ? (
              <>
                <SessionSummary
                  session={session}
                  progress={progress}
                  modifications={session?.modifications ?? []}
                  runtimeHooks={instrumentation.runtimeHooks}
                  unavailable={instrumentation.unavailable}
                  instrumentationFailure={instrumentation.failure}
                  cleanup={cleanup}
                  onOpenSource={actions.onOpenSource}
                />

                {spec !== undefined && viewStatus === 'generating' ? (
                  <LoadingState variant="rows" rows={1} label={REGENERATING_LABEL} />
                ) : null}
                {spec !== undefined && viewStatus === 'error' ? (
                  <ErrorState
                    title={SESSION_FAILED_TITLE}
                    message={sessionFailure?.message ?? SESSION_FAILED_FALLBACK}
                    onRetry={reloadSessionState}
                    retryLabel={RELOAD_SESSION_LABEL}
                  />
                ) : null}

                <PanelView
                  spec={spec}
                  dataProvider={dataProvider}
                  actions={actions}
                  theme={theme}
                  status={viewStatus}
                  error={sessionFailure}
                  onRetry={reloadSessionState}
                  selectedEventId={selectedEvent?.eventId ?? null}
                />
              </>
            ) : (
              <EmptyPanel />
            )}
          </Stack>
        </main>
        {drawer}
      </Split>

      {hasSession ? (
        <section aria-label={LIVE_TAIL_REGION_LABEL}>
          <LiveTail
            events={liveTail}
            droppedCount={liveTailDropped}
            capturing={capture.active}
            collapsed={tailCollapsed}
            onToggleCollapsed={toggleTail}
            actions={actions}
            selected={selectedEvent}
          />
        </section>
      ) : null}
    </Stack>
  );
}
