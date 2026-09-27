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
 * state container; the worker's reload offer is read from `./state/connection`,
 * which holds it. The `useState` hooks below are presentation-only and
 * duplicate nothing — whether the developer dismissed the pairing dialog,
 * whether they asked for the service-address dialog, the service-address
 * accessor resolved once for the document, whether the live tail is
 * collapsed, whether the reload notice's own consent is in flight, and where
 * the selection on screen was raised (the store keeps the selection, not its
 * origin; see {@link SelectionProvenance}).
 *
 * ## Layout (AAP 0.7.3)
 *
 * ```text
 * Stack (vertical)                           the one top-level arrangement
 * ├── Header → <header>                      wordmark · ConnectionStatus · session title
 * │                                          and status badge · TargetPicker · CaptureControls
 * ├── PairDialog                             while the connection says "Not paired", or
 * │                                          in address mode on the developer's request
 * ├── Split                                  the body and the right drawer
 * │   ├── <main>                             lastError notice · EmptyPanel, or
 * │   │                                      the reload notice (while offered) +
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
 * ## The pairing dialog is modal
 *
 * `PairDialog` declares `aria-modal="true"`, and this file makes that true: while
 * the dialog is open, every other region — the `<header>` (through `Header`'s
 * `inert` prop), `<main>`, the drawer's `<aside>` and the live tail's
 * `<section>` — carries the native `inert` attribute, so nothing behind the
 * dialog can be focused, clicked or reached by assistive technology. `Split`
 * renders only non-interactive pane wrappers around `<main>` and `<aside>`, and
 * no title here, so those two cover it. The dialog itself is a direct child of
 * the top-level `Stack`, outside every inert subtree; its own focus containment
 * catches focus that is moved programmatically. The renderer ships no overlay
 * primitive, so the dialog stays an in-flow card directly under the header —
 * modality comes from the inert background, not from a scrim. All of this
 * holds for both of the dialog's modes: one `modalOpen` flag drives every
 * `inert` and the focus restoration below.
 *
 * The dialog opens in pairing mode by itself while the connection says "Not
 * paired", and in address mode when the developer chooses the pill's "Change
 * service address…" control — offered beside "Reconnecting…" and "Service not
 * running", and only where this document has the extension storage the
 * address is kept in — so a paired developer whose service moved to another
 * port points the extension at it without pairing again. Not paired, the
 * pairing mode takes precedence and the address request is withdrawn, so the
 * address dialog never reopens on its own after a pairing episode.
 *
 * Focus on close lands on what opened the dialog — the connection pill's
 * "Pair…" or "Change service address…" control, whose `<header>` stops being
 * inert in the same commit that removes the dialog — or on `<main>` when the
 * dialog opened by itself or its opener has left the header.
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
 * - **Page not observable** — the worker offers the one-click reload because
 *   the inspected page's agent is missing or its hook arrived after React: a
 *   notice above the summary states why and offers "Reload page", whose
 *   activation is the developer's consent; while the worker reloads and waits
 *   for the new document's agent, the action is unavailable and busy.
 * - **Capture held by another session** — the start failure names the owning
 *   session and says how to release it.
 * - **Unbound, or the tab navigated away** — `ConnectionStatus` renders the
 *   binding line through `formatTabLeftMessage`; nothing here words it.
 * - **Not paired / service not running / reconnecting** — the pill's own
 *   recovery affordances, plus `PairDialog` for pairing and, once paired, for
 *   changing the service address.
 * - **A command failed** — the non-blocking `lastError` notice above the body,
 *   with "Retry", which re-reads the session from the service (a renewed
 *   failure sets the notice again), and "Dismiss". Either removes the notice
 *   and moves focus to `<main>`, so focus is never dropped to the document.
 *
 * Every state renders with `chrome.devtools` undefined, which is how the browser
 * suite opens the panel page directly as an extension page: the element-target
 * controls then render unavailable with an explanatory tooltip (`TargetPicker`),
 * and nothing throws. This file is the one that detects the host: it tells
 * `TargetPicker` whether DevTools is present and whether a session is bound to
 * the inspected tab, and the picker reads no `chrome` global of its own.
 *
 * ## Commands never reject
 *
 * `CaptureControls` and the reload notice hold their control busy while a
 * returned promise is pending. Every command below catches its own failure,
 * surfaces it through the store's non-blocking `lastError` — rendered as an
 * error state, never as analysis — and resolves. Each is a module-level
 * function that reads the store and the session at call time, so its identity
 * is stable for the life of the document and no dependency array is involved.
 * Anything a `CaptureControls` callback throws or rejects with anyway reaches
 * its required `onActionError` reporter, and `TargetPicker` hands a failure to
 * its `onActionError` sink; both route it into the same `lastError` notice, so
 * even an unexpected failure is presented — in fixed copy, never in its own
 * words (see {@link failurePayload}) — rather than escaping as an unhandled
 * rejection.
 *
 * ## "Use selected element" is bounded end to end
 *
 * The inspected page answers the `$0` evaluation, and the page is untrusted:
 * any script on it can replace the agent's `describeTarget`. So the answer
 * passes the shared bounded parser of `../shared/messages` — the one the
 * devtools page applies to the same answer — **before** anything is shown or
 * sent, and a refused answer is reported, never displayed. The evaluation
 * itself settles exactly once: with an answer, with a failure, after
 * {@link SELECTION_DESCRIBE_TIMEOUT_MS}, when the inspected tab loads a new
 * document (a reload or a navigation, even to the same URL), when its binding
 * changes (another origin, the tab closed, the session ended) or when the panel
 * unmounts — so the control can never stay busy forever and a late answer from
 * an old document is never adopted. What the header shows of a target is a
 * display copy with credential shapes redacted from every page-controlled
 * field and URL query values masked (AAP 0.5.2); the store keeps, and the
 * worker receives, the bounded descriptor itself.
 *
 * ## Service not running (AAP 0.7.3)
 *
 * `ConnectionStatus` always names the VS Code "Debug Generator: Start Local
 * Service" action beside the "Service not running" pill; this file supplies the
 * shell alternative, {@link SERVICE_START_COMMAND}, which is how the README
 * starts the service by hand from the repository root.
 *
 * ## The drawer's parent chain
 *
 * The drawer states the selected event's lineage explicitly — a trace root, a
 * complete chain, a parent that is not part of the capture, a search that
 * stopped at its page budget, a loop, or a failed lookup — never an omitted
 * section. Ancestors come from stored or streamed events only: the live tail,
 * then the event's stored trace, which the data provider's `resolveEvent`
 * pages within a budget per pass that the drawer can continue (see
 * {@link EventDrawer}). Whose evidence a selection is follows from where it was
 * raised: a selection raised by the rendered panel is read from the capture
 * that panel was generated from, one raised by the live tail from the live
 * capture ({@link drawerEvidencePanel}), and a chain is built only from events
 * of the selected event's own capture.
 *
 * ## Boundaries
 *
 * - No `WebSocket`, no `fetch`, no HTTP client: the port owned by
 *   `./state/connection` is the panel's only channel, and every request here is
 *   one of its typed port requests. Protocol usage is types only. The one
 *   other thing the panel writes is the non-secret service-address setting in
 *   `chrome.storage.local`, through the accessor `PairDialog` resolves; the
 *   worker follows that setting from storage and moves its socket and every
 *   HTTP call to the new address itself.
 * - No validation, normalisation or repair of panel specifications: the service
 *   validated what it pushed, and `PanelHost` renders validated specs only.
 * - No node filtering and no branching on a panel's title or the session's
 *   question (AAP 0.5.4, 0.6.5): the two demonstrated questions produce panels
 *   with different component sets, and this file passes either through intact.
 * - No visual value: every gap is a `SpaceStep`, the drawer's width is a unitless
 *   `Split` pane weight, and every element with an appearance is a renderer
 *   primitive. The raw elements are the landmarks no primitive renders:
 *   `<main>`, `<aside>` and the live tail's `<section>`; their only attributes
 *   beyond landmark semantics and focus management are `inert` while the
 *   dialog is open, in either mode.
 *
 * @module apps/chrome-extension/src/panel/App
 */

import {
  Button,
  ErrorState,
  LoadingState,
  Section,
  Split,
  Stack,
  Text,
} from '@debuggen/panel-renderer';
import type { EventRef } from '@debuggen/panel-schema';
import type {
  ErrorPayload,
  ProgressStage,
  SelectedTarget,
  SessionStatus,
  TelemetryEvent,
} from '@debuggen/protocol';
import { DebuggenError, assertNever, createConsoleLogger } from '@debuggen/shared';
import type { CaptureId, DebuggenErrorCode, SessionId } from '@debuggen/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import { PAGE_RELOAD_ACTION_LABEL, parseSelectedTargetDescriptor } from '../shared/messages';
import type {
  PanelBindingState,
  PanelConnectionStatus,
  PanelReloadReason,
  PanelReloadState,
  PortRequestPayloads,
} from '../shared/messages';

import { createPanelActions } from './actions';
import type { DevtoolsPanelActions } from './actions';
import { CaptureControls } from './components/CaptureControls';
import type { CaptureAction } from './components/CaptureControls';
import { ConnectionStatus } from './components/ConnectionStatus';
import { EmptyPanel } from './components/EmptyPanel';
import { EventDetails } from './components/EventDetails';
import type {
  EventAncestry,
  EventDetailsError,
  EventDetailsStatus,
} from './components/EventDetails';
import { Header } from './components/Header';
import { LiveTail } from './components/LiveTail';
import { PairDialog, resolveServiceEndpointAccessor } from './components/PairDialog';
import type { PairDialogMode } from './components/PairDialog';
import { PanelView } from './components/PanelView';
import type { PanelViewError, PanelViewStatus } from './components/PanelView';
import { SessionSummary } from './components/SessionSummary';
import { TargetPicker } from './components/TargetPicker';
import type { TargetPickerAction } from './components/TargetPicker';
import {
  buildEventParentChain,
  createPanelDataProvider,
  EVENT_RESOLUTION_MAX_EVENTS,
} from './data-provider';
import type {
  PanelDataProvider,
  PanelEventResolution,
  PanelEventResolveOptions,
} from './data-provider';
import {
  getPanelConnection,
  getPanelReloadState,
  onPortDisconnect,
  panelRequest,
  panelRequestOwningSessionId,
  readInspectedTabId,
  startPanelConnection,
  usePanelReloadState,
} from './state/connection';
import {
  getPanelSnapshot,
  getSessionId,
  selectEvent,
  setLastError,
  setPendingTarget,
  setPickerActive,
  subscribePanelStore,
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

/** The label of the non-blocking failure notice's retry control. */
const LAST_ERROR_RETRY_LABEL = 'Retry';

/**
 * What the non-blocking failure notice's retry does, stated beneath its message: it re-reads the
 * session rather than repeating the failed request, which only its own control can do.
 */
const LAST_ERROR_RETRY_HINT = 'Retry reloads this panel’s session state from the local service.';

/** The retry control's label on the session-failure notice: it re-reads the session. */
const RELOAD_SESSION_LABEL = 'Reload session state';

/** The lead of each command's failure message; the cause follows a colon. */
const FAILURE_LEADS = Object.freeze({
  captureStart: 'Could not start the capture',
  captureStop: 'Could not stop the capture',
  pick: 'Could not change picker mode',
  useSelected: 'Could not use the selected element',
  reloadPage: 'Could not reload the page',
} as const);

/**
 * What follows a command's lead when its cause is not a typed product error
 * (see {@link failurePayload}): an unexpected exception's own text can carry a
 * file path, a query or a credential, so it is never shown, and this fixed
 * reason and hint stand in for it.
 */
const UNEXPECTED_FAILURE = Object.freeze({
  reason: 'an unexpected error stopped the request in the Debug Generator panel.',
  hint: 'Try again; if it keeps failing, reopen Chrome DevTools.',
} as const);

/**
 * The drawer's failure for a lookup that rejected with anything but a typed
 * product error — fixed copy, for the reason {@link UNEXPECTED_FAILURE} gives.
 */
const EVENT_LOOKUP_UNEXPECTED = Object.freeze({
  message:
    'The selected event could not be looked up: an unexpected error stopped the lookup in the Debug Generator panel.',
  hint: 'Retry; if it keeps failing, reopen Chrome DevTools.',
} as const);

/**
 * The reload notice's sentence for each reason the worker offers the reload
 * (AAP §0.7.1 Group 2: readiness "asks for a one-click reload"). Keyed by the
 * reason union, so a reason added to the contract is a compile error here
 * rather than a notice with nothing to say.
 */
const PAGE_RELOAD_NOTICES: Readonly<Record<PanelReloadReason, string>> = Object.freeze({
  'agent-missing':
    'This page was opened before the Debug Generator extension was enabled, so its agent is not running in it. Reload it to continue.',
  'hook-after-react':
    'React loaded on this page before the Debug Generator hook, so its renders cannot be observed. Reload it to continue.',
});

/** The reload notice's sentence while the consented reload runs. */
const PAGE_RELOADING_NOTICE =
  'Reloading the page. The panel continues once the Debug Generator agent reports from it.';

/** The reload control's label while the consented reload runs — the visible busy cue. */
const PAGE_RELOADING_LABEL = 'Reloading page…';

/**
 * What follows the service's message when another session holds the project's
 * capture (AAP §0.4.2: `capture.start` "answers `409 { owningSessionId }`"):
 * the owner named, and the way out. {@link captureOwnerSentence} places the
 * owner's id, in parentheses, between `lead` and `rest`.
 */
const CAPTURE_HELD_BY_OTHER_SESSION = Object.freeze({
  lead: 'Another Debug Generator session',
  rest: "holds this project's capture. Stop or end that session's capture, then start again.",
} as const);

/** The same sentence when the session named as the owner is this panel's own. */
const CAPTURE_HELD_BY_THIS_SESSION =
  "This session already holds this project's capture. Stop it before starting another.";

/** Why the page reload could not be requested: this document inspects no page. */
const NO_INSPECTED_PAGE_REASON =
  'this panel is not inspecting a page. Open DevTools on the application tab, then reload from the Debug Generator panel.';

/** Why a command that needs a session could not run: the panel shows none. */
const NO_SESSION_REASON =
  'this panel is not bound to a Debug Generator session. Start one from the Debug Generator view in VS Code, then try again.';

/** The drawer's error when the selected event is not in the stored capture. */
const EVENT_NOT_FOUND: EventDetailsError = Object.freeze({
  message: 'The selected event is not in the stored capture of this session.',
  hint: 'Select the event again from the panel, or retry once the capture has been stored.',
});

/**
 * The shell command that starts the local Debug Generator service, shown by
 * `ConnectionStatus` beside the "Service not running" pill as the alternative
 * to the VS Code "Debug Generator: Start Local Service" action. It is the
 * README's manual start (run from the repository root, so the service reads
 * the root `.env`), and it names the product's own build output — nothing from
 * any inspected application (AAP 0.5.4).
 */
const SERVICE_START_COMMAND = 'node apps/local-service/dist/main.js';

/** Why "Use selected element" could not describe the Elements panel's selection. */
const SELECTION_NOT_DESCRIBED =
  'the element selected in the Elements panel could not be described. Select an element on a page the Debug Generator agent is running on (reload the page if it was open before the extension), then try again.';

/** Why "Use selected element" cannot run at all outside Chrome DevTools. */
const DEVTOOLS_UNAVAILABLE = 'Chrome DevTools is not available to this panel.';

/**
 * The longest "Use selected element" waits for the inspected page to answer
 * the `$0` evaluation, in milliseconds. A page that is navigating, compiling a
 * Fast Refresh update or blocked by a long task can hold the answer; past this
 * bound the control settles with {@link SELECTION_TIMED_OUT} instead of
 * staying busy. The devtools page bounds its own background evaluation of the
 * same expression more tightly, because nobody is waiting on that one; this
 * one answers a press, so it allows a slow page a little longer.
 */
const SELECTION_DESCRIBE_TIMEOUT_MS = 5_000;

/** Why "Use selected element" gave up on an evaluation that never answered. */
const SELECTION_TIMED_OUT = `the inspected page did not describe its selected element within ${String(SELECTION_DESCRIBE_TIMEOUT_MS / 1_000)} seconds.`;

/** What to do after an evaluation timed out. */
const SELECTION_TIMED_OUT_HINT =
  'Wait for the page to finish loading, select the element in the Elements panel again, then try again.';

/** Why "Use selected element" stopped: the inspected tab's binding changed while it ran. */
const SELECTION_PAGE_CHANGED =
  'the inspected page changed while its selected element was being described. Select the element again in the Elements panel, then try again.';

/** Why "Use selected element" discarded a description: the panel now shows another session. */
const SELECTION_SESSION_CHANGED =
  'the panel switched to another session while the element was being described. Try again for the session on screen.';

/**
 * The mask a displayed URL's query values and fragment take — AAP 0.5.2: URL
 * query parameter values are "replaced with `?` per key for display and
 * storage", keys and path retained. The same convention the telemetry
 * redaction layer and the service worker apply to the URLs they handle.
 */
const DISPLAY_URL_MASK = '?';

/** What a credential in a displayed field is replaced with; the product's redaction marker. */
const DISPLAY_REDACTION_MARKER = '[redacted]';

/** Base64url and opaque token body characters. */
const DISPLAY_TOKEN_CHARS = '[A-Za-z0-9_-]';

/**
 * A credential prefix must start a token: the `sk-` inside a hyphenated class
 * name or word (`desk-…`, `task-…`) is not a key prefix, and a selector must
 * not be rewritten for one.
 */
const DISPLAY_TOKEN_START = '(?<![A-Za-z0-9_-])';

/** One credential shape the header masks, and what replaces it. */
interface DisplayRedactionRule {
  /** A global pattern with only bounded or single-class quantifiers, so matching stays linear. */
  readonly pattern: RegExp;
  /** The replacement; `$1` keeps a captured scheme word or URL scheme. */
  readonly replacement: string;
}

/**
 * The credential shapes of the product's deny list (AAP 0.5.2, the rules of
 * `packages/telemetry/src/redaction/rules.ts`) — private-key delimiters,
 * connection-string userinfo, bearer credentials, JWT-shaped tokens and the
 * `sk-`/`sk-ant-`/`ghp_`/`github_pat_`/`AKIA` provider prefixes — restated for
 * display, because this workspace does not load the telemetry runtime
 * (AAP 0.2.2 limits that edge to the agent bundle). Every prefix is assembled
 * from pieces, as the repository's own secret gate assembles its patterns, so
 * this file carries no contiguous credential prefix for that gate to report.
 */
const DISPLAY_CREDENTIAL_RULES: readonly DisplayRedactionRule[] = Object.freeze([
  {
    pattern: new RegExp('-{5}BEGIN [A-Z0-9 ]{0,40}' + 'PRIVATE' + ' KEY' + '(?: BLOCK)?-{5}', 'g'),
    replacement: DISPLAY_REDACTION_MARKER,
  },
  {
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi,
    replacement: `$1${DISPLAY_REDACTION_MARKER}@`,
  },
  {
    pattern: /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1 ${DISPLAY_REDACTION_MARKER}`,
  },
  {
    pattern: new RegExp(
      DISPLAY_TOKEN_START +
        'ey' +
        'J' +
        DISPLAY_TOKEN_CHARS +
        '{8,}\\.' +
        DISPLAY_TOKEN_CHARS +
        '{4,}(?:\\.' +
        DISPLAY_TOKEN_CHARS +
        '*)?',
      'g',
    ),
    replacement: DISPLAY_REDACTION_MARKER,
  },
  {
    pattern: new RegExp(
      DISPLAY_TOKEN_START +
        '(?:' +
        ['s' + 'k-(?:ant-)?' + DISPLAY_TOKEN_CHARS + '{16,}', 'gh' + 'p_[A-Za-z0-9_]{16,}'].join(
          '|',
        ) +
        '|' +
        ['git' + 'hub_pat_[A-Za-z0-9_]{16,}', 'AK' + 'IA[0-9A-Z]{12,}'].join('|') +
        ')',
      'g',
    ),
    replacement: DISPLAY_REDACTION_MARKER,
  },
]);

/**
 * A dense run of 16 or more token characters in free text: the shape of an
 * opaque secret no prefix identifies. A single character class with only a
 * lower bound, so matching is linear on any input.
 */
const DENSE_RUN_PATTERN = /[A-Za-z0-9_+/=.~-]{16,}/g;

/** A decimal digit: a dense run carrying one is treated as a secret, not as a long word. */
const DIGIT_PATTERN = /[0-9]/;

/**
 * The expression "Use selected element" evaluates in the inspected page with
 * `chrome.devtools.inspectedWindow.eval`.
 *
 * `$0` is DevTools' handle on the Elements panel's current selection, and
 * `describeTarget` is the function the MAIN-world telemetry agent publishes on
 * its helper global exactly so that this evaluation can reach it: it returns
 * the five-field `SelectedTarget` descriptor, or nothing when the selection is
 * not an element or the agent is not attached. The expression answers `null` in
 * every case where there is no descriptor, because `inspectedWindow.eval`
 * transports JSON-compliant values only and `undefined` is not one. Whatever
 * it answers is untrusted — the page can replace the helper — and is parsed by
 * `parseSelectedTargetDescriptor` before use.
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

/**
 * The panel's diagnostics, at `warn` and above. It records that an unexpected
 * failure was presented as fixed copy, by the closed code that failure was
 * given and nothing else: never the cause's message, name or stack, which are
 * as private in the console as on screen.
 */
const panelLogger = createConsoleLogger({ name: 'panel', level: 'warn' });

/** Whether a value is a non-null, non-array object whose members can be read. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * presentable copy.
 *
 * Only a **typed product error** — a value `DebuggenError.is` accepts — is
 * presented in its own words: its code, message, hint and correlation `ref`
 * are kept. Those are the panel connection's rejections (whose `refused` form
 * carries the worker's schema-validated protocol error, worded by the service
 * without payloads, tokens or URL query values) and the panel's own
 * fixed-copy errors. Anything else — a plain `Error`, a thrown string, or a
 * value that only claims the error brand — is an unexpected exception whose
 * text could carry a file path, a SQL statement or a credential, so none of it
 * is copied: the record states {@link UNEXPECTED_FAILURE} under
 * `fallbackCode`, and the panel's log records that code alone.
 *
 * @param lead What the command was trying to do, as a sentence fragment.
 * @param cause What the command's request rejected with, or threw.
 * @param fallbackCode The code for a cause that is not a typed product error.
 * @returns A frozen `ErrorPayload` for `setLastError`.
 */
function failurePayload(
  lead: string,
  cause: unknown,
  fallbackCode: DebuggenErrorCode,
): ErrorPayload {
  if (!DebuggenError.is(cause)) {
    panelLogger.warn('A panel command failed unexpectedly; its failure is shown as fixed copy.', {
      code: fallbackCode,
    });
    return Object.freeze({
      code: fallbackCode,
      message: `${lead}: ${UNEXPECTED_FAILURE.reason} ${UNEXPECTED_FAILURE.hint}`,
    });
  }
  const hint = cause.hint;
  const message =
    hint === undefined || hint.trim() === ''
      ? `${lead}: ${cause.message}`
      : `${lead}: ${cause.message} ${hint}`;
  const ref = cause.details?.ref;
  return Object.freeze(
    typeof ref === 'string' && ref !== ''
      ? { code: cause.code, message, ref }
      : { code: cause.code, message },
  );
}

/** Surface a failed command through the store's non-blocking `lastError`. */
function reportFailure(lead: string, cause: unknown, fallbackCode: DebuggenErrorCode): void {
  setLastError(failurePayload(lead, cause, fallbackCode));
}

/**
 * The sentence that names the session holding the project's capture.
 *
 * @param owningSessionId The owner the service's conflict named.
 * @param sessionId The session this panel asked to capture for.
 */
function captureOwnerSentence(owningSessionId: SessionId, sessionId: SessionId): string {
  return owningSessionId === sessionId
    ? CAPTURE_HELD_BY_THIS_SESSION
    : `${CAPTURE_HELD_BY_OTHER_SESSION.lead} (${owningSessionId}) ${CAPTURE_HELD_BY_OTHER_SESSION.rest}`;
}

/**
 * The store record of a "Start capture" that failed: the generic record of
 * {@link failurePayload}, or — when the service refused because a session
 * already holds the project's capture — that record with the owner named and
 * `ref` set to the owner's id, since the owning session is what this error is
 * about and `ref` is the payload's correlation field.
 *
 * @param sessionId The session the start was requested for.
 * @param cause What the `capture.start` request rejected with.
 */
function captureStartFailurePayload(sessionId: SessionId, cause: unknown): ErrorPayload {
  const failure = failurePayload(FAILURE_LEADS.captureStart, cause, 'TRANSPORT_DISCONNECTED');
  const owningSessionId = panelRequestOwningSessionId(cause);
  if (owningSessionId === undefined) {
    return failure;
  }
  return Object.freeze({
    code: failure.code,
    message: `${failure.message} ${captureOwnerSentence(owningSessionId, sessionId)}`,
    ref: owningSessionId,
  });
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
 * A page-controlled display field with every credential shape of
 * {@link DISPLAY_CREDENTIAL_RULES} replaced, everything else kept byte for
 * byte — which is what keeps a selector naming the element it named.
 *
 * A display guard, not the product's redaction layer. The agent already
 * scrubbed its descriptor through `packages/telemetry/src/redaction/` and the
 * service redacts before it stores or sends anything, but the panel cannot rely
 * on either for what it paints: the answer came from a page that may have
 * replaced the agent's helper.
 *
 * @param value A bounded single-line field of the descriptor.
 */
function redactCredentials(value: string): string {
  let output = value;
  for (const rule of DISPLAY_CREDENTIAL_RULES) {
    output = output.replace(rule.pattern, rule.replacement);
  }
  return output;
}

/**
 * Element text as the header shows it: {@link redactCredentials}, then every
 * dense run of 16 or more token characters that carries a digit — an opaque
 * secret no prefix identifies — replaced by the redaction marker. A long word
 * without a digit is left alone, so ordinary labels read unchanged.
 *
 * @param text The descriptor's `text`, already a bounded single line.
 */
function redactDisplayText(text: string): string {
  return redactCredentials(text).replace(DENSE_RUN_PATTERN, (run) =>
    DIGIT_PATTERN.test(run) ? DISPLAY_REDACTION_MARKER : run,
  );
}

/**
 * One `key=value` query pair as the header shows it: the key with its
 * credential shapes redacted, the value masked; a bare flag and an empty value
 * keep their form.
 */
function maskQueryPair(pair: string): string {
  const separator = pair.indexOf('=');
  if (separator === -1) {
    return redactCredentials(pair);
  }
  const key = redactCredentials(pair.slice(0, separator));
  return separator === pair.length - 1 ? `${key}=` : `${key}=${DISPLAY_URL_MASK}`;
}

/**
 * A descriptor URL as the header shows it, following the product's URL
 * redaction (AAP 0.5.2; `packages/telemetry/src/redaction/url.ts`): scheme,
 * host and port kept; userinfo replaced whole by the redaction marker, keeping
 * the `@`; the path kept with its credential shapes redacted; every query key
 * kept in order with its credential shapes redacted and every value replaced by
 * {@link DISPLAY_URL_MASK}; a non-empty fragment masked. A value that does not
 * parse — which the shared parser never lets through — shows as the redaction
 * marker rather than verbatim.
 *
 * @param url The descriptor's `url`, as the page or the service supplied it.
 */
function maskUrlForDisplay(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return DISPLAY_REDACTION_MARKER;
  }
  const userinfo =
    parsed.username !== '' || parsed.password !== '' ? `${DISPLAY_REDACTION_MARKER}@` : '';
  const query =
    parsed.search.length > 1
      ? `?${parsed.search.slice(1).split('&').map(maskQueryPair).join('&')}`
      : '';
  const fragment = parsed.hash.length > 1 ? `#${DISPLAY_URL_MASK}` : '';
  const path = redactCredentials(parsed.pathname);
  return `${parsed.protocol}//${userinfo}${parsed.host}${path}${query}${fragment}`;
}

/**
 * The target the header shows: the descriptor bounded by the shared parser —
 * so a confirmed target relayed from the service is held to the same bounds as
 * an optimistic pick — with every page-controlled field prepared for display:
 * credential shapes redacted from the selector, the tag name and each
 * component name ({@link redactCredentials}), from the text together with
 * opaque dense runs ({@link redactDisplayText}), and the URL masked
 * ({@link maskUrlForDisplay}). Nothing else is rewritten: the selector and the
 * chain identify the element, and a selector changed for any other reason
 * could name a different one.
 *
 * @param target The pending pick, or the session's confirmed target.
 * @returns The display copy, or `undefined` when there is none or it is refused.
 */
function toDisplayTarget(target: SelectedTarget | undefined): SelectedTarget | undefined {
  const bounded = target === undefined ? undefined : parseSelectedTargetDescriptor(target);
  if (bounded === undefined) {
    return undefined;
  }
  const shown = {
    selector: redactCredentials(bounded.selector),
    tagName: redactCredentials(bounded.tagName),
    componentChain: bounded.componentChain.map(redactCredentials),
    url: maskUrlForDisplay(bounded.url),
  };
  return bounded.text === undefined ? shown : { ...shown, text: redactDisplayText(bounded.text) };
}

/**
 * A comparable identity of the inspected tab's binding: it changes when the
 * tab navigates (a new URL), leaves the session's origin, closes or is unbound
 * — every event after which an in-flight description of `$0` describes a page
 * that is no longer the one the developer is looking at.
 *
 * @param binding The store's binding state.
 */
function bindingIdentity(binding: PanelBindingState): string {
  switch (binding.kind) {
    case 'unbound':
      return 'unbound';
    case 'bound':
      return `bound\n${binding.sessionId}\n${String(binding.tabId)}\n${binding.url}`;
    case 'tab-left':
      return `tab-left\n${binding.origin}\n${binding.sessionId ?? ''}`;
    default:
      return assertNever(binding, 'Unhandled binding state in the panel');
  }
}

/**
 * Whether two descriptors are the same selection: all five fields equal, the
 * component chain element-wise and in order. Exact, because both sides are the
 * very descriptor this panel set as pending, so the pick it retracts is the
 * one it sent and never a later pick of the same element whose text or chain
 * differs.
 */
function sameTargetIdentity(left: SelectedTarget, right: SelectedTarget): boolean {
  return (
    left.selector === right.selector &&
    left.url === right.url &&
    left.tagName === right.tagName &&
    left.text === right.text &&
    left.componentChain.length === right.componentChain.length &&
    left.componentChain.every((name, index) => name === right.componentChain[index])
  );
}

/**
 * Whether an `inspectedWindow.eval` callback's second argument reports a
 * failure: an `isError` record (the evaluation could not run) or an
 * `isException` record (the expression threw). Anything else — `undefined` on
 * success, as Chrome passes it — is a success.
 */
function isEvalFailure(exceptionInfo: unknown): boolean {
  return (
    isRecord(exceptionInfo) &&
    (exceptionInfo.isError === true || exceptionInfo.isException === true)
  );
}

/** Why an in-flight description of `$0` was abandoned before it settled. */
type DescriptionCancellation =
  /**
   * The page being described is no longer the page on screen: the inspected
   * tab loaded a new document (a same-URL reload included), or its binding
   * changed because it navigated, left, closed or was unbound.
   */
  | 'page-changed'
  /** A newer description replaced this one. */
  | 'superseded'
  /** The panel unmounted; nothing is left to report to. */
  | 'unmounted';

/** How one description of `$0` settled. */
type DescriptionOutcome =
  | { readonly kind: 'described'; readonly target: SelectedTarget }
  | { readonly kind: 'failed'; readonly error: DebuggenError }
  | { readonly kind: 'cancelled'; readonly reason: DescriptionCancellation };

/** The description in flight, while there is one; cancelling settles it at once. */
let activeDescription: { readonly cancel: (reason: DescriptionCancellation) => void } | undefined;

/**
 * Settle the description in flight, if any, as cancelled. Called when the
 * inspected tab loads a new document, when its binding changes, and when the
 * panel unmounts.
 *
 * @param reason Why it is abandoned.
 */
function cancelActiveDescription(reason: DescriptionCancellation): void {
  activeDescription?.cancel(reason);
}

/** A failed description, classified as the agent not being able to answer. */
function descriptionFailure(message: string, hint?: string): DescriptionOutcome {
  return {
    kind: 'failed',
    error: new DebuggenError('AGENT_NOT_READY', message, hint === undefined ? {} : { hint }),
  };
}

/**
 * Evaluate {@link DESCRIBE_SELECTION_EXPRESSION} in the inspected page and
 * parse the answer with the shared bounded descriptor parser.
 *
 * Settles exactly once, and never rejects or throws: with the bounded
 * descriptor; with a typed failure when DevTools is absent, the evaluation
 * errored or threw, the answer was refused, or no answer arrived within
 * {@link SELECTION_DESCRIBE_TIMEOUT_MS}; or as cancelled through
 * {@link cancelActiveDescription}. Whichever comes first wins, and a late
 * callback after that is ignored. Starting a description supersedes one still
 * in flight.
 *
 * No options are passed to `eval`: `useContentScriptContext` would select the
 * ISOLATED world, where neither `$0` nor the agent's helper exists.
 */
function describeSelectedElement(): Promise<DescriptionOutcome> {
  return new Promise<DescriptionOutcome>((resolve) => {
    if (!isDevtoolsAvailable()) {
      resolve(descriptionFailure(DEVTOOLS_UNAVAILABLE));
      return;
    }
    let settled = false;
    // `settle` and `cancel` run only after `timer` below is initialised: the
    // timer, the eval callback and a cancellation are all later events, and
    // the synchronous `catch` runs after the timer was scheduled.
    const handle = {
      cancel: (reason: DescriptionCancellation): void => {
        settle({ kind: 'cancelled', reason });
      },
    };
    const settle = (outcome: DescriptionOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      if (activeDescription === handle) {
        activeDescription = undefined;
      }
      resolve(outcome);
    };

    cancelActiveDescription('superseded');
    activeDescription = handle;
    const timer = window.setTimeout(() => {
      settle(descriptionFailure(SELECTION_TIMED_OUT, SELECTION_TIMED_OUT_HINT));
    }, SELECTION_DESCRIBE_TIMEOUT_MS);

    try {
      chrome.devtools.inspectedWindow.eval<unknown>(
        DESCRIBE_SELECTION_EXPRESSION,
        (
          result: unknown,
          exceptionInfo?: chrome.devtools.inspectedWindow.EvaluationExceptionInfo,
        ) => {
          if (isEvalFailure(exceptionInfo)) {
            settle(descriptionFailure(SELECTION_NOT_DESCRIBED));
            return;
          }
          const target = parseSelectedTargetDescriptor(result);
          settle(
            target === undefined
              ? descriptionFailure(SELECTION_NOT_DESCRIBED)
              : { kind: 'described', target },
          );
        },
      );
    } catch (cause: unknown) {
      // DevTools threw instead of evaluating. Its text is the host's, not
      // product copy, so the failure is stated in the panel's own words and
      // only its closed code is logged; the cause stays attached, never shown.
      panelLogger.warn('Describing the selected element failed unexpectedly.', {
        code: 'AGENT_NOT_READY',
      });
      settle({
        kind: 'failed',
        error: new DebuggenError('AGENT_NOT_READY', SELECTION_NOT_DESCRIBED, { cause }),
      });
    }
  });
}

/**
 * DevTools' "the inspected window navigated to a new page" event, when this
 * document has one: `chrome.devtools.network.onNavigated`, which fires for
 * every new document of the inspected tab — a reload and a navigation to the
 * very same URL included. `undefined` outside DevTools, or where the host
 * exposes no such event; read structurally, so it never throws.
 */
function readInspectedNavigationEvent(): chrome.events.Event<(url: string) => void> | undefined {
  try {
    const devtools = readDevtools();
    if (!isRecord(devtools) || !isRecord(devtools.network)) {
      return undefined;
    }
    const event = devtools.network.onNavigated;
    return isRecord(event) &&
      typeof event.addListener === 'function' &&
      typeof event.removeListener === 'function'
      ? chrome.devtools.network.onNavigated
      : undefined;
  } catch {
    // A DevTools API that throws on access is as absent as one that is missing.
    return undefined;
  }
}

/**
 * Call `onNavigated` when the inspected tab loads a new document, until the
 * returned function stops watching. A no-op pair outside DevTools.
 *
 * @param onNavigated What to do on the next navigation.
 * @returns The function that removes the listener; safe to call once.
 */
function watchInspectedNavigation(onNavigated: () => void): () => void {
  const event = readInspectedNavigationEvent();
  if (event === undefined) {
    return () => undefined;
  }
  const listener = (): void => {
    onNavigated();
  };
  try {
    event.addListener(listener);
  } catch {
    // A listener DevTools refused cannot fire; the evaluation's deadline still bounds the wait.
    return () => undefined;
  }
  return () => {
    try {
      event.removeListener(listener);
    } catch {
      // The DevTools context is already gone, and its listeners with it.
    }
  };
}

/**
 * Describe `$0` for the session on screen, abandoning the evaluation the
 * moment the page being described stops being the page on screen: when the
 * inspected tab loads a new document — DevTools' navigation event, which fires
 * for a reload and for a navigation to the same URL, so a late answer from the
 * old document is never adopted for the new one — and when the tab's binding
 * changes, which a different origin, the tab closing or the session ending all
 * do.
 */
async function describeForCurrentBinding(): Promise<DescriptionOutcome> {
  const startedFor = bindingIdentity(getPanelSnapshot().connection.binding);
  const stopWatchingBinding = subscribePanelStore(() => {
    if (bindingIdentity(getPanelSnapshot().connection.binding) !== startedFor) {
      cancelActiveDescription('page-changed');
    }
  });
  const stopWatchingNavigation = watchInspectedNavigation(() => {
    cancelActiveDescription('page-changed');
  });
  try {
    return await describeSelectedElement();
  } finally {
    stopWatchingNavigation();
    stopWatchingBinding();
  }
}

/** The event with `eventId` in `events`, or `undefined`. */
function findEvent(
  events: readonly TelemetryEvent[] | undefined,
  eventId: string,
): TelemetryEvent | undefined {
  return events?.find((candidate) => candidate.id === eventId);
}

/**
 * Where walking up from the selected event through its recorded parents
 * stopped. `ancestors` always runs from the topmost ancestor found down to the
 * event's immediate parent — the order `EventAncestry` carries.
 */
type ChainWalk =
  | { readonly kind: 'complete'; readonly ancestors: readonly TelemetryEvent[] }
  | {
      readonly kind: 'broken';
      /** The first span id on the way up that no event in the pool carries. */
      readonly missingSpanId: string;
      readonly ancestors: readonly TelemetryEvent[];
    }
  | { readonly kind: 'cycle'; readonly ancestors: readonly TelemetryEvent[] };

/**
 * The spans of `traceId` in `pools`, keyed by span id. The first event seen for
 * a span wins, so the stored capture — passed first — outranks the live tail.
 *
 * @param traceId The trace whose spans are indexed; other traces are skipped.
 * @param pools Event lists, in priority order.
 */
function indexTraceSpans(
  traceId: string,
  pools: readonly (readonly TelemetryEvent[])[],
): ReadonlyMap<string, TelemetryEvent> {
  const bySpan = new Map<string, TelemetryEvent>();
  for (const pool of pools) {
    for (const candidate of pool) {
      if (candidate.traceId === traceId && !bySpan.has(candidate.spanId)) {
        bySpan.set(candidate.spanId, candidate);
      }
    }
  }
  return bySpan;
}

/**
 * Walk from `event` up through its recorded parents, using only events that
 * were actually stored or streamed — the chain is never synthesised from
 * `parentSpanId` alone.
 *
 * @param event The selected event.
 * @param bySpan The event's trace, indexed by {@link indexTraceSpans}.
 * @returns A complete chain for a trace root reached (empty for a root event),
 * the first missing span with the chain below it, or a loop.
 */
function walkAncestors(
  event: TelemetryEvent,
  bySpan: ReadonlyMap<string, TelemetryEvent>,
): ChainWalk {
  const upward: TelemetryEvent[] = [];
  const visited = new Set<string>([event.spanId]);
  let parentSpanId = event.parentSpanId;
  while (parentSpanId !== undefined) {
    if (visited.has(parentSpanId)) {
      return { kind: 'cycle', ancestors: upward.reverse() };
    }
    const parent = bySpan.get(parentSpanId);
    if (parent === undefined) {
      return { kind: 'broken', missingSpanId: parentSpanId, ancestors: upward.reverse() };
    }
    visited.add(parentSpanId);
    upward.push(parent);
    parentSpanId = parent.parentSpanId;
  }
  return { kind: 'complete', ancestors: upward.reverse() };
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

/**
 * "Start capture": the worker calls the service's capture-start route for the
 * session. A refusal because another session holds the project's capture
 * names that session ({@link captureStartFailurePayload}).
 */
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
    setLastError(captureStartFailurePayload(sessionId, cause));
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
 * One period of picker mode being on, and which route armed it: `panel` when
 * "Pick element" turned it on (and {@link togglePicker} arms it), `service`
 * when the service's relayed `target.request` did (and
 * {@link armServiceRequestedPicker} arms it). Compared by identity, so a late
 * answer is only ever applied to the activation that asked.
 */
interface PickerActivation {
  readonly armedBy: 'panel' | 'service';
}

/**
 * The picker-mode activation on screen, or `undefined` while picker mode is
 * off. Owned by {@link followPickerMode}, which clears it whenever the store's
 * `target.pickRequested` is off, and claimed by {@link togglePicker} before it
 * turns picker mode on — which is what arms each activation exactly once.
 */
let currentPickerActivation: PickerActivation | undefined;

/** Why a service-requested picker mode ended: the worker answered it inactive. */
const PICKER_NOT_ENTERED =
  'the inspected page did not enter picker mode. Reload the application page, or select the element in the Elements panel and press "Use selected element".';

/**
 * Arm the picker mode the service asked for — the relayed `target.request`
 * that turned the store's `pickRequested` on (AAP §0.4.2: it "asks the panel to
 * enter picker mode"). The panel is the one arming authority, so this sends the
 * same `target.pick { enabled: true }` "Pick element" sends; the worker arms
 * nothing on its own.
 *
 * On a refusal (`AGENT_NOT_READY` when no page agent is connected), an inactive
 * answer or a lost request, picker mode is left again — while this activation
 * is still the one on screen for the same session — and the failure is
 * surfaced through `lastError`, so a request that armed nothing never looks
 * armed (AAP §0.5.5). Never rejects.
 *
 * @param activation The activation {@link followPickerMode} opened for it.
 */
async function armServiceRequestedPicker(activation: PickerActivation): Promise<void> {
  const sessionId = getSessionId();
  const stillOn = (): boolean =>
    currentPickerActivation === activation &&
    getSessionId() === sessionId &&
    getPanelSnapshot().target.pickRequested;
  const leavePickerMode = (cause: unknown): void => {
    if (!stillOn()) {
      return;
    }
    setPickerActive(false);
    reportFailure(FAILURE_LEADS.pick, cause, 'AGENT_NOT_READY');
  };

  if (sessionId === undefined) {
    leavePickerMode(new DebuggenError('TAB_NOT_BOUND', NO_SESSION_REASON));
    return;
  }
  try {
    const { active } = await panelRequest('target.pick', { sessionId, enabled: true });
    if (!active) {
      leavePickerMode(new DebuggenError('AGENT_NOT_READY', PICKER_NOT_ENTERED));
    }
  } catch (cause: unknown) {
    leavePickerMode(cause);
  }
}

/**
 * The store listener behind service-requested picker mode: picker mode turned
 * off closes the current activation; picker mode on with no activation open is
 * the service's request — "Pick element" claims its activation before it turns
 * picker mode on — so one is opened and armed. Idempotent per store state, so
 * a repeated notification or a StrictMode re-subscription arms nothing twice.
 */
function followPickerMode(): void {
  if (!getPanelSnapshot().target.pickRequested) {
    currentPickerActivation = undefined;
    return;
  }
  if (currentPickerActivation !== undefined) {
    return;
  }
  const activation: PickerActivation = { armedBy: 'service' };
  currentPickerActivation = activation;
  void armServiceRequestedPicker(activation);
}

/**
 * Follow the store's picker mode for the life of the panel: returns the
 * unsubscribe, for an effect's cleanup. The current state is applied at once,
 * so a request the store recorded before the panel mounted is armed too.
 */
function watchPickerMode(): () => void {
  const unsubscribe = subscribePanelStore(followPickerMode);
  followPickerMode();
  return unsubscribe;
}

/**
 * `CaptureControls`' root reporter: a start or stop callback that threw or
 * rejected despite catching its own failures above is presented through the
 * same non-blocking notice, under the lead of the action that failed, and never
 * escapes as an unhandled rejection.
 *
 * @param cause What the callback threw or rejected with.
 * @param action The capture action that failed.
 */
function reportCaptureActionError(cause: unknown, action: CaptureAction): void {
  reportFailure(
    action === 'start' ? FAILURE_LEADS.captureStart : FAILURE_LEADS.captureStop,
    cause,
    'INTERNAL',
  );
}

/**
 * "Pick element": toggle picker mode. The new state is shown at once through
 * the store, relayed as the worker's `target.pick` request, and corrected to
 * the worker's answer — or restored — while nothing else has changed it since.
 * Turning it on claims the activation first, so the store listener that arms a
 * service-requested picker mode does not arm this one a second time.
 */
async function togglePicker(): Promise<void> {
  const sessionId = requireSession(FAILURE_LEADS.pick);
  if (sessionId === undefined) {
    return;
  }
  const wasActive = getPanelSnapshot().target.pickRequested;
  const enabled = !wasActive;
  if (enabled) {
    currentPickerActivation = { armedBy: 'panel' };
  }
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
 * worker's `target.selected` request.
 *
 * The pick stays pending — `TargetPicker` renders busy — until the worker
 * answers with the service's verdict, not merely the send: acceptance is the
 * `session.updated` carrying the pick, which the store reconciles into the
 * confirmed target; a refusal (`TAB_NOT_BOUND` for a stale or foreign pick) or
 * a lost frame (`TRANSPORT_DISCONNECTED`) rejects. A rejection clears the
 * optimistic target again only while it is still the one on screen — same
 * session, and the pending target is this exact pick.
 *
 * Nothing is shown before the answer passed the shared bounded parser: an
 * answer it refuses, an evaluation that failed or timed out, and one abandoned
 * because the page changed are each reported through `lastError` and leave
 * the target as it was. A description the panel unmounted or superseded is
 * dropped silently — nobody is waiting for it.
 */
async function adoptSelectedElement(): Promise<void> {
  const sessionId = requireSession(FAILURE_LEADS.useSelected);
  if (sessionId === undefined) {
    return;
  }

  const outcome = await describeForCurrentBinding();
  if (outcome.kind === 'cancelled') {
    if (outcome.reason === 'page-changed') {
      setLastError(
        Object.freeze({
          code: 'AGENT_NOT_READY',
          message: `${FAILURE_LEADS.useSelected}: ${SELECTION_PAGE_CHANGED}`,
        }),
      );
    }
    return;
  }
  if (outcome.kind === 'failed') {
    reportFailure(FAILURE_LEADS.useSelected, outcome.error, 'AGENT_NOT_READY');
    return;
  }
  if (getSessionId() !== sessionId) {
    setLastError(
      Object.freeze({
        code: 'TAB_NOT_BOUND',
        message: `${FAILURE_LEADS.useSelected}: ${SELECTION_SESSION_CHANGED}`,
      }),
    );
    return;
  }

  const picked = outcome.target;
  setPendingTarget(picked);
  // Whether this pick is still the optimistic target on screen: a confirmed
  // record, the session ending or a rebind may have moved it on.
  const stillPending = (): boolean => {
    const pending = getPanelSnapshot().target.pending;
    return (
      getSessionId() === sessionId && pending !== undefined && sameTargetIdentity(pending, picked)
    );
  };
  const withdraw = (): void => {
    if (stillPending()) {
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
      return;
    }
    // Accepted. The confirming `session.updated` normally reached the store
    // first and cleared the pick; when the worker confirmed it by reading the
    // session back, this panel never saw that record, so it re-reads it too
    // and the confirmed target replaces the pick.
    if (stillPending()) {
      reloadSessionState();
    }
  } catch (cause: unknown) {
    withdraw();
    reportFailure(FAILURE_LEADS.useSelected, cause, 'TRANSPORT_DISCONNECTED');
  }
}

/**
 * `TargetPicker`'s error sink: a failure one of its callbacks raised despite
 * catching its own, surfaced through `lastError` under that control's lead.
 * Never throws, which is the contract `onActionError` states.
 *
 * @param action The control whose callback failed.
 * @param cause What it threw or rejected with.
 */
function reportTargetActionFailure(action: TargetPickerAction, cause: unknown): void {
  reportFailure(
    action === 'pick' ? FAILURE_LEADS.pick : FAILURE_LEADS.useSelected,
    cause,
    'INTERNAL',
  );
}

/**
 * `PairDialog`'s submit: redeem the one-time code through the worker, which
 * keeps the credential it receives. Rejects with the worker's typed failure so
 * the dialog shows it in place — the dialog owns that promise and never lets
 * it escape — and resolves on `{ paired: true }`.
 *
 * @param code The well-formed code the developer typed, normalised by the
 * dialog (trimmed and upper-cased).
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

/**
 * Whether a `page.reload` request is in flight — the synchronous guard that
 * keeps a second activation, dispatched before any re-render or worker push
 * has landed, from sending a second consent.
 */
let pageReloadInFlight = false;

/**
 * "Reload page": the developer's one-click consent to reload the inspected
 * page so its agent can observe it. The worker performs the reload with
 * `chrome.tabs.reload` and answers once the new document's agent reported
 * (AAP §0.7.1 Group 2).
 *
 * The request **is** the consent, so it is sent only while the worker's offer
 * says `offered` — read at call time — at most one at a time, and naming this
 * panel's inspected tab, the only tab the worker may reload for it. The
 * answer's readiness needs no handling here: the offer (`reloading`, then
 * `not-needed` or a renewed `offered`) and the session's progress arrive as
 * pushes. Never rejects; a failure is surfaced through `lastError`.
 */
async function reloadInspectedPage(): Promise<void> {
  if (pageReloadInFlight || getPanelReloadState().kind !== 'offered') {
    return;
  }
  const sessionId = requireSession(FAILURE_LEADS.reloadPage);
  if (sessionId === undefined) {
    return;
  }
  // The consent names the page it was given for — this panel's own inspected
  // tab — so the worker can refuse it for any other tab.
  const tabId = readInspectedTabId(readDevtools);
  if (tabId === undefined) {
    setLastError(
      Object.freeze({
        code: 'TAB_NOT_BOUND',
        message: `${FAILURE_LEADS.reloadPage}: ${NO_INSPECTED_PAGE_REASON}`,
      }),
    );
    return;
  }
  pageReloadInFlight = true;
  try {
    await panelRequest('page.reload', { sessionId, tabId });
  } catch (cause: unknown) {
    reportFailure(FAILURE_LEADS.reloadPage, cause, 'AGENT_NOT_READY');
  } finally {
    pageReloadInFlight = false;
  }
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

/**
 * The capture the store shows — the running capture, or the most recent one
 * after it stopped — for the data provider's `getCaptureId`.
 *
 * Module-level, so its identity is stable and the provider reads the store at
 * call time: a new capture changes this without changing the session, and the
 * provider keys every request and every live lookup's cached trace by it, so a
 * query under a new capture never joins, and a live lookup is never answered
 * by, one of the old. A panel-bound lookup's traces are keyed by its panel.
 */
function readCaptureId(): CaptureId | undefined {
  return getPanelSnapshot().capture.captureId;
}

/**
 * Whether the provider's trace cache may answer for `sessionId` — its
 * `canServeCached` (AAP 0.5.6: a devtools client reads panel data only for the
 * session bound to its tab).
 *
 * True only while the panel is connected to the service **and** its inspected
 * tab is bound to exactly that session. An unbound tab, a tab that navigated
 * away, a lost or unpaired connection, or a binding to another session all
 * answer `false`, which empties the cache and sends the lookup to the service,
 * the authority on the tab's binding. Read from the store at call time, never
 * remembered.
 *
 * @param sessionId The session the lookup is addressed to.
 */
function canServeCachedTrace(sessionId: SessionId): boolean {
  const { connection } = getPanelSnapshot();
  return (
    connection.status === 'connected' &&
    connection.binding.kind === 'bound' &&
    connection.binding.sessionId === sessionId
  );
}

/** A count or a position as the drawer writes it: grouped digits, nothing else. */
function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** A lookup whose find pass stopped at its page budget. */
type ExhaustedResolution = Extract<PanelEventResolution, { readonly status: 'budget-exhausted' }>;

/**
 * The drawer's error when the find pass stopped at its page budget without
 * reaching the selected event. The capture may hold it further on, so this is
 * never worded as "missing": it names the range of stored events read — the
 * pass's own offsets, one-based — and the hint says that Retry continues from
 * the first one it did not read. Numbers only: nothing from the capture or the
 * selection is interpolated.
 *
 * @param resolution The `budget-exhausted` answer.
 */
function searchExhaustedError(resolution: ExhaustedResolution): EventDetailsError {
  const first = formatCount(resolution.searchedFrom + 1);
  const last = formatCount(resolution.resumeOffset);
  const scope =
    resolution.scope === 'trace'
      ? "of the selected event's trace"
      : "of this session's stored capture";
  return Object.freeze({
    message: `The search for the selected event read stored events ${first}–${last} ${scope} without reaching it, the most this drawer reads at once (${formatCount(EVENT_RESOLUTION_MAX_EVENTS)}); the capture may hold it further on.`,
    hint: `Retry continues the search from stored event ${formatCount(resolution.resumeOffset + 1)}.`,
  });
}

/**
 * The drawer's failure for a rejected stored lookup, as presentable copy.
 *
 * A typed product error is kept as it is: the data provider rejects with
 * nothing else, its own messages name only the requested source and paging,
 * and a worker's refusal carries the service's schema-validated wording.
 * Anything else is an unexpected exception whose text could carry a file path,
 * a SQL statement or a credential, so it becomes {@link EVENT_LOOKUP_UNEXPECTED}
 * under `INTERNAL`, the cause kept attached but never shown, and only that
 * closed code is logged.
 *
 * @param cause What `resolveEvent` rejected with.
 */
function presentableLookupError(cause: unknown): DebuggenError {
  if (DebuggenError.is(cause)) {
    return cause;
  }
  panelLogger.warn('An event lookup failed unexpectedly; its failure is shown as fixed copy.', {
    code: 'INTERNAL',
  });
  return new DebuggenError('INTERNAL', EVENT_LOOKUP_UNEXPECTED.message, {
    hint: EVENT_LOOKUP_UNEXPECTED.hint,
    cause,
  });
}

/** The control that continues a stopped ancestry search from where it stopped. */
const CHAIN_CONTINUE_LABEL = 'Continue the ancestry search';

/** Props of {@link EventDrawer}; exported, like the component, for the unit suite. */
export interface EventDrawerProps {
  /** The store's selection: the event the drawer explains. */
  readonly selected: EventRef;
  /** The store's bounded live tail, consulted before the stored capture. */
  readonly liveTail: readonly TelemetryEvent[];
  /** The panel's actions, passed explicitly: the drawer renders outside `PanelHost`. */
  readonly actions: DevtoolsPanelActions;
  /**
   * The panel's one data provider, passed explicitly for the same reason; its
   * `resolveEvent` reads the stored capture.
   */
  readonly dataProvider: PanelDataProvider;
  /**
   * The session the selection belongs to — the one the generated panel's
   * queries are addressed to — or `undefined` when the panel shows none, in
   * which case a stored lookup rejects with `TAB_NOT_BOUND`.
   */
  readonly sessionId: string | undefined;
  /**
   * The panel whose evidence the selection is — a `PanelSpec`'s own `id` — or
   * `undefined` for live evidence. Decided by the composition root from where
   * the selection was raised ({@link drawerEvidencePanel}), never re-derived
   * here: an event id that also appears in the live tail does not turn a
   * panel-bound lookup into a live one. Bound, every page of the stored lookup
   * names this panel, so it reads the capture that panel was generated from.
   */
  readonly panelId: string | undefined;
}

/**
 * Where the selection on screen was raised — which is whose evidence it is.
 *
 * The store keeps the selection itself, an `EventRef`, and not where it came
 * from, so the composition root records this as each control raises a
 * selection (see {@link recordingSelections}):
 *
 * - `panel` — a view, table or evidence chip of the rendered panel raised it;
 *   `panelId` is that panel's own `id`, so the selection stays that panel's
 *   evidence whatever captures or panel versions follow.
 * - `live` — the live tail raised it; `captureId` is the capture the tail was
 *   streaming at that moment (the store's `capture.captureId`).
 *
 * An ancestor selected in the drawer inherits the provenance of the selection
 * it is an ancestor of. Exported, like {@link drawerEvidencePanel}, for the
 * unit suite.
 */
export type SelectionProvenance =
  | { readonly eventId: string; readonly origin: 'panel'; readonly panelId: string }
  | {
      readonly eventId: string;
      readonly origin: 'live';
      readonly captureId: CaptureId | undefined;
    };

/**
 * The panel a selection's stored lookup is bound to, or `undefined` for a
 * live read — the service answers a named panel from the capture that panel
 * was generated from, and an unnamed one from the open capture, else the most
 * recent.
 *
 * - **Raised by a panel** → that panel, always. A panel's evidence is never
 *   read live, whatever the live tail holds.
 * - **Raised by the live tail** → a live read while the capture it was raised
 *   from is still the store's current one, whatever panel is rendered: an
 *   older panel is never named for evidence the tail is still streaming. Once
 *   the store shows another capture, a live read would answer from that one
 *   instead, so the lookup is bound to the rendered panel when there is one —
 *   the panel generated when the tail's capture stopped, in the ordinary
 *   course — and stays live only when there is none. A request names a panel,
 *   never a capture, so this is the nearest scope the service can be asked
 *   for; and since an event id is unique across captures, a panel whose
 *   capture does not hold the event answers "not found" rather than another
 *   capture's evidence.
 * - **No provenance for this selection** → the rendered panel's evidence when
 *   a panel is rendered, and an explicit live read when none is.
 *
 * @param eventId The selected event's id.
 * @param provenance What the composition root recorded for the latest
 * selection; it applies only when it names `eventId`.
 * @param renderedPanelId The rendered `PanelSpec`'s own `id`, if any.
 * @param liveCaptureId The store's current capture, if known.
 * @returns The panel the lookup names, or `undefined` for a live read.
 */
export function drawerEvidencePanel(
  eventId: string,
  provenance: SelectionProvenance | undefined,
  renderedPanelId: string | undefined,
  liveCaptureId: CaptureId | undefined,
): string | undefined {
  if (provenance === undefined || provenance.eventId !== eventId) {
    return renderedPanelId;
  }
  if (provenance.origin === 'panel') {
    return provenance.panelId;
  }
  return provenance.captureId === liveCaptureId ? undefined : renderedPanelId;
}

/**
 * The events of `pool` that belong to `captureId`: the only ones a lineage of
 * an event of that capture may be built from. A trace and its span ids can
 * reach across a capture boundary — a parent span that ends after the store
 * moved to a newer capture is stored under that one — so the live tail is
 * never merged into another capture's chain.
 *
 * @param pool The live tail, or any streamed events.
 * @param captureId The capture of the event whose lineage is built.
 * @returns The events of `pool` stamped with `captureId`, in `pool`'s order.
 */
function eventsOfCapture(
  pool: readonly TelemetryEvent[],
  captureId: CaptureId,
): readonly TelemetryEvent[] {
  return pool.filter((candidate) => candidate.captureId === captureId);
}

/**
 * Where the drawer's next lookup continues a pass the last one stopped at its
 * page budget: the **find** pass from the first offset it did not read, or the
 * **ancestry** pass on top of the trace pool it collected — with the event it
 * found, which the drawer keeps showing while the search continues.
 */
type DrawerResume =
  | { readonly kind: 'find'; readonly from: number }
  | {
      readonly kind: 'ancestry';
      readonly from: number;
      readonly event: TelemetryEvent;
      readonly trace: readonly TelemetryEvent[];
    };

/**
 * The drawer's retry state, tagged with the selection it was asked for (see
 * {@link drawerSelectionKey}): a retry or a continuation never outlives the
 * selection, session or trace it belongs to.
 */
interface DrawerAttempt {
  readonly selection: string;
  /** Moves on every retry and every continuation, so each is a new lookup. */
  readonly attempt: number;
  /** The pass to continue; `undefined` for a lookup from the start. */
  readonly resume: DrawerResume | undefined;
}

/** What a stored lookup settled with. */
type StoredLookupOutcome =
  | { readonly kind: 'resolved'; readonly resolution: PanelEventResolution }
  | { readonly kind: 'failed'; readonly error: DebuggenError };

/**
 * A settled stored lookup, tagged with the request it answers (see
 * {@link storedLookupKey}), so that a settlement for an earlier selection,
 * session, attempt or resumption is never rendered for the current one.
 */
interface StoredLookup {
  readonly key: string;
  readonly outcome: StoredLookupOutcome;
}

/**
 * A shown event's ancestry search that stopped at its page budget before the
 * chain was complete: `resume` continues it. `EventDetails` states the chain
 * as incomplete; the drawer adds the control that continues the search.
 */
interface ChainGap {
  readonly kind: 'stopped';
  readonly resume: DrawerResume;
}

/**
 * What a settled lookup contributes: a stored event with its lineage — and,
 * when a pass stopped at its budget, how to continue it — or the error to
 * show, with how its retry proceeds.
 */
type StoredView =
  | {
      readonly kind: 'event';
      readonly event: TelemetryEvent;
      /** The event's lineage, for `EventDetails`' `ancestry` prop. */
      readonly ancestry: EventAncestry;
      readonly gap: ChainGap | undefined;
    }
  | {
      readonly kind: 'error';
      readonly error: EventDetailsError;
      /** The continuation a Retry performs; `undefined` restarts the lookup. */
      readonly resume: DrawerResume | undefined;
    };

/**
 * The identity of one selection: the session, the event, the trace the lookup
 * is narrowed to and the panel it is bound to (`undefined` for a live read).
 * Compared only; it holds the session and panel ids, so it is never shown or
 * logged.
 */
function drawerSelectionKey(
  sessionId: string | undefined,
  eventId: string,
  traceId: string | undefined,
  panelId: string | undefined,
): string {
  return JSON.stringify([sessionId ?? null, eventId, traceId ?? null, panelId ?? null]);
}

/**
 * The identity of one stored lookup: everything it depends on — the
 * selection, the attempt, and the pass and offset it resumes. Compared only.
 */
function storedLookupKey(
  selection: string,
  attempt: number,
  resume: DrawerResume | undefined,
): string {
  return JSON.stringify([
    selection,
    attempt,
    resume === undefined ? null : [resume.kind, resume.from],
  ]);
}

/** The attempt after `previous`, counted within `selection` only. */
function nextAttempt(previous: DrawerAttempt | undefined, selection: string): number {
  return previous?.selection === selection ? previous.attempt + 1 : 1;
}

/**
 * The provider options a lookup runs with: its signal, the panel it is bound
 * to (no `panelId` key at all for a live read), and the pass it resumes.
 */
function resolveOptionsFor(
  resume: DrawerResume | undefined,
  signal: AbortSignal,
  panelId: string | undefined,
): PanelEventResolveOptions {
  const scope: PanelEventResolveOptions = panelId === undefined ? { signal } : { signal, panelId };
  if (resume === undefined) {
    return scope;
  }
  return resume.kind === 'find'
    ? { ...scope, resumeFrom: resume.from }
    : { ...scope, resumeAncestry: { from: resume.from, trace: resume.trace } };
}

/**
 * The lineage the walk from `event` found in `pool`, in `EventDetails`'
 * vocabulary: complete (empty for a trace root), a loop, or broken at the
 * first missing span — `incomplete` when a pass stopped at its budget and
 * continuing may still find it (`eventsRead` stored events of the trace were
 * read), `missing` when the whole trace was read without it.
 *
 * @param event The event whose lineage is stated.
 * @param pools Stored and streamed events of its trace, in priority order.
 * @param stoppedAfter When the ancestry pass stopped at its budget, how many
 * stored events of the trace it read; `undefined` when it read them all.
 */
function lineageOf(
  event: TelemetryEvent,
  pools: readonly (readonly TelemetryEvent[])[],
  stoppedAfter: number | undefined,
): EventAncestry {
  const walk = walkAncestors(event, indexTraceSpans(event.traceId, pools));
  switch (walk.kind) {
    case 'complete':
      return { state: 'complete', ancestors: walk.ancestors };
    case 'cycle':
      return { state: 'cycle', ancestors: walk.ancestors };
    case 'broken':
      return stoppedAfter === undefined
        ? { state: 'missing', missingSpanId: walk.missingSpanId, ancestors: walk.ancestors }
        : {
            state: 'incomplete',
            missingSpanId: walk.missingSpanId,
            ancestors: walk.ancestors,
            eventsRead: stoppedAfter,
          };
    default:
      return assertNever(walk, 'Unhandled ancestor walk outcome');
  }
}

/**
 * The drawer's reading of a settled lookup.
 *
 * A found event's lineage is walked over its stored trace pool together with
 * the live tail's events **of the found event's own capture** — both hold
 * real, captured events of that capture, so an ancestor the store has not been
 * asked for yet but the tail already streamed completes the chain
 * ({@link lineageOf}), while a tail event of another capture that shares the
 * trace and a span id never stands in for a missing ancestor
 * ({@link eventsOfCapture}). A chain the ancestry pass could not complete
 * within its budget is stated as incomplete and carries the continuation
 * ({@link ChainGap}); one whose whole trace was read is stated as missing.
 *
 * @param outcome What the lookup settled with.
 * @param liveTail The store's live tail, to complete the chain from.
 */
function storedView(outcome: StoredLookupOutcome, liveTail: readonly TelemetryEvent[]): StoredView {
  if (outcome.kind === 'failed') {
    return { kind: 'error', error: outcome.error, resume: undefined };
  }
  const { resolution } = outcome;
  switch (resolution.status) {
    case 'found': {
      const stopped =
        resolution.budgetExhausted && resolution.ancestryResumeOffset !== undefined
          ? resolution.ancestryResumeOffset
          : undefined;
      const ancestry = lineageOf(
        resolution.event,
        [resolution.trace, eventsOfCapture(liveTail, resolution.event.captureId)],
        stopped === undefined ? undefined : resolution.trace.length,
      );
      const gap: ChainGap | undefined =
        stopped === undefined || ancestry.state === 'complete' || ancestry.state === 'cycle'
          ? undefined
          : {
              kind: 'stopped',
              resume: {
                kind: 'ancestry',
                from: stopped,
                event: resolution.event,
                trace: resolution.trace,
              },
            };
      return { kind: 'event', event: resolution.event, ancestry, gap };
    }
    case 'not-found':
      return { kind: 'error', error: EVENT_NOT_FOUND, resume: undefined };
    case 'budget-exhausted':
      return {
        kind: 'error',
        error: searchExhaustedError(resolution),
        resume: { kind: 'find', from: resolution.resumeOffset },
      };
    default:
      return assertNever(resolution, 'Unhandled event resolution in the drawer');
  }
}

/** Props of {@link ChainContinueControl}. */
interface ChainContinueControlProps {
  /** The stopped ancestry pass. */
  readonly gap: ChainGap;
  /** Continues it. */
  readonly onContinue: (resume: DrawerResume) => void;
}

/**
 * The control beneath the details that continues an ancestry search which
 * stopped at its page budget — `EventDetails` states the chain as incomplete,
 * with how many stored events were read. A renderer `Button` only.
 */
function ChainContinueControl(props: ChainContinueControlProps): ReactElement {
  const { gap, onContinue } = props;
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        onContinue(gap.resume);
      }}
    >
      {CHAIN_CONTINUE_LABEL}
    </Button>
  );
}

/**
 * Resolves the store's selected `EventRef` to an event and its parent chain,
 * and renders `EventDetails` for it — exported for the unit suite, which
 * drives it over a real {@link createPanelDataProvider}.
 *
 * The selection is only a pointer — an event id with the trace and span it
 * belongs to — so the event is looked up in two places:
 *
 * 1. **The live tail**, which answers at once for an event that just streamed
 *    in. When the tail holds the event *and* its complete ancestry among the
 *    tail's events of the event's own capture, the drawer is answered from it
 *    alone and the stored capture is not read at all.
 * 2. **The stored capture**, through the provider's `resolveEvent`, which
 *    pages the capture — narrowed to the event's trace when the selection or
 *    the tail knows it — however far into it the event and its ancestors lie:
 *    each pass within a page budget of its own, and a pass that spends it
 *    resumable from where it stopped. Repeated selections of one trace are
 *    answered from the provider's bounded, authorised cache. The lookup runs
 *    in an effect whose `AbortController` is aborted when the selection, the
 *    session, the evidence scope, the attempt or the resumption changes and
 *    on unmount, and a settlement is rendered only for the request it answers.
 *
 * ## Which capture a stored lookup reads
 *
 * A session holds several captures, and a panel on screen describes the one
 * it was generated from — which is not the store's current capture once a
 * newer one has started. So each lookup reads the evidence the selection
 * belongs to, which the composition root decides from where the selection
 * was raised ({@link drawerEvidencePanel}) and hands over as `panelId`:
 *
 * - **A panel's evidence** — `panelId` names the panel. Every page of the
 *   lookup names it, so it is answered from the capture that panel was
 *   generated from. That holds whatever the live tail shows: the drawer never
 *   turns a panel-bound lookup into a live one because an event id matches.
 * - **Live evidence** — `panelId` is `undefined`: an event raised from the
 *   live tail while its capture is still the store's, or a selection with no
 *   panel to name (none recorded and none rendered). The lookup names no
 *   panel and is answered from the open capture, else the most recent one.
 *
 * Either way, a lineage is built only from events of the selected event's own
 * capture: the tail's events of another capture never complete a chain
 * ({@link eventsOfCapture}), though a trace and its span ids can reach across
 * a capture boundary. The binding is part of the selection's identity, so
 * changing it restarts the lookup, and a settlement for the other binding is
 * never rendered.
 *
 * States: the event from the tail while the stored lookup runs; loading while
 * neither source has it; the lookup's typed failure; "not in the stored
 * capture" when the whole scan missed it; and a distinct "stopped searching"
 * error naming the range of stored events read, whose Retry **continues** the
 * search from the first event it did not read — while a Retry after any other
 * failure restarts the lookup. Never an empty drawer presented as if nothing
 * were selected (AAP 0.5.5).
 *
 * The parent chain is always stated, through `EventDetails`' `ancestry`: a
 * trace root, the complete chain, a loop, a parent the whole stored trace does
 * not hold (`missing`), an ancestry search that stopped at its budget
 * (`incomplete`, with a control beneath the details that continues it — see
 * {@link ChainGap}), a lookup still running (`loading`), or — for an event the
 * live tail shows — a stored lookup that failed (`error`, with its retry). A
 * missing chain is never presented as complete.
 *
 * @param props See {@link EventDrawerProps}.
 */
export function EventDrawer(props: EventDrawerProps): ReactElement {
  const { selected, liveTail, actions, dataProvider, sessionId, panelId } = props;
  const { eventId } = selected;

  const fromTail = useMemo(() => findEvent(liveTail, eventId), [liveTail, eventId]);
  const tailChain = useMemo(
    () =>
      fromTail === undefined
        ? undefined
        : buildEventParentChain(fromTail, eventsOfCapture(liveTail, fromTail.captureId)),
    [fromTail, liveTail],
  );
  // The tail holds the event and its complete ancestry: nothing to look up.
  const tailSuffices = tailChain !== undefined;
  const traceId = selected.traceId ?? fromTail?.traceId;

  // Retries and continuations belong to the selection they were asked for; a
  // new selection, session, trace or evidence binding starts over from the
  // first stored event. `panelId` is the binding exactly as the composition
  // root decided it (see the component documentation); nothing here
  // re-derives it.
  const selection = drawerSelectionKey(sessionId, eventId, traceId, panelId);
  const [attemptState, setAttemptState] = useState<DrawerAttempt | undefined>(undefined);
  const current = attemptState?.selection === selection ? attemptState : undefined;
  const attempt = current?.attempt ?? 0;
  const resume = current?.resume;
  const restart = useCallback(() => {
    setAttemptState((previous) => ({
      selection,
      attempt: nextAttempt(previous, selection),
      resume: undefined,
    }));
  }, [selection]);
  const continueFrom = useCallback(
    (next: DrawerResume) => {
      setAttemptState((previous) => ({
        selection,
        attempt: nextAttempt(previous, selection),
        resume: next,
      }));
    },
    [selection],
  );

  const [lookup, setLookup] = useState<StoredLookup | undefined>(undefined);
  const key = storedLookupKey(selection, attempt, resume);

  useEffect(() => {
    if (tailSuffices) {
      return undefined;
    }
    const controller = new AbortController();
    const target = traceId === undefined ? { eventId } : { eventId, traceId };
    const options = resolveOptionsFor(resume, controller.signal, panelId);
    dataProvider.resolveEvent(sessionId, target, options).then(
      (resolution) => {
        if (!controller.signal.aborted) {
          setLookup({ key, outcome: { kind: 'resolved', resolution } });
        }
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setLookup({ key, outcome: { kind: 'failed', error: presentableLookupError(cause) } });
        }
      },
    );
    return () => {
      controller.abort();
    };
  }, [dataProvider, sessionId, eventId, traceId, panelId, key, resume, tailSuffices]);

  // Only the settlement of the current request counts; an earlier one — for
  // another selection, session, evidence scope, attempt or resumption — reads
  // as "still resolving".
  const outcome = lookup !== undefined && lookup.key === key ? lookup.outcome : undefined;
  const settled = useMemo(
    () => (outcome === undefined ? undefined : storedView(outcome, liveTail)),
    [outcome, liveTail],
  );

  let event: TelemetryEvent | undefined = fromTail;
  let ancestry: EventAncestry | undefined;
  let onRetryAncestry: (() => void) | undefined;
  let status: EventDetailsStatus = 'idle';
  let error: EventDetailsError | undefined;
  let onRetry: (() => void) | undefined;
  let gap: ChainGap | undefined;
  if (tailSuffices) {
    ancestry = { state: 'complete', ancestors: tailChain };
  } else if (settled === undefined) {
    // The current lookup is still running. An ancestry continuation keeps the
    // event it continues for on screen; a tail event is shown as it is.
    if (fromTail === undefined && resume?.kind === 'ancestry') {
      event = resume.event;
      ancestry = { state: 'loading' };
    } else if (fromTail === undefined) {
      status = 'loading';
    } else {
      ancestry = { state: 'loading' };
    }
  } else if (settled.kind === 'event') {
    event = settled.event;
    ancestry = settled.ancestry;
    gap = settled.gap;
  } else {
    // The stored lookup failed, or stopped before finding the event. Its
    // Retry continues a stopped search and restarts any other.
    const { resume: retryResume } = settled;
    const retry =
      retryResume === undefined
        ? restart
        : () => {
            continueFrom(retryResume);
          };
    if (fromTail === undefined) {
      status = 'error';
      error = settled.error;
      onRetry = retry;
    } else {
      // The tail shows the event; the stored capture could not supply the
      // ancestors the tail lacks, which the parent chain states with the retry.
      ancestry = { state: 'error', error: settled.error };
      onRetryAncestry = retry;
    }
  }

  return (
    <>
      <EventDetails
        event={event}
        ancestry={ancestry}
        onRetryAncestry={onRetryAncestry}
        status={status}
        error={error}
        onRetry={onRetry}
        onOpenSource={actions.onOpenSource}
        onSelectEvent={actions.onSelectEvent}
        onClose={actions.clearSelectedEvent}
      />
      {gap === undefined || event === undefined || status !== 'idle' ? null : (
        <ChainContinueControl gap={gap} onContinue={continueFrom} />
      )}
    </>
  );
}

/*
 * ===========================================================================
 * Section F — the page reload notice
 * ===========================================================================
 */

/** Props of {@link PageReloadNotice}. */
interface PageReloadNoticeProps {
  /** The worker's offer, whenever it is anything but `not-needed`. */
  readonly reload: Exclude<PanelReloadState, { readonly kind: 'not-needed' }>;
}

/**
 * Why the inspected page must be reloaded, and the one-click action that
 * reloads it — shown while the worker offers the reload or performs it.
 *
 * While `offered`, the sentence names the reason and the control's visible
 * label and accessible name are exactly {@link PAGE_RELOAD_ACTION_LABEL}, the
 * name the browser suite drives the consent through. From the activation
 * until the worker's offer moves on, and throughout `reloading`, the control
 * is unavailable: it stays focusable (`aria-disabled` with a guarded handler,
 * as `CaptureControls` does, so the control a keyboard user activated keeps
 * focus) and reports `aria-busy`; during `reloading` its label becomes
 * {@link PAGE_RELOADING_LABEL}. A second activation is refused by the
 * rendered state, by this component's synchronous guard, and, independently,
 * by {@link reloadInspectedPage}'s own guard.
 *
 * Renderer primitives only — `Stack`, `Text`, `Button` — so every value
 * resolves through the `--dg-*` tokens (AAP 0.6.4); the copy is generic
 * product vocabulary (AAP 0.5.4).
 */
function PageReloadNotice(props: PageReloadNoticeProps): ReactElement {
  const { reload } = props;
  // Presentation-only: this notice's own consent is in flight. It covers the
  // moment between the activation and the worker's `reloading` push.
  const [requesting, setRequesting] = useState(false);
  // Synchronous re-entry guard, set before the command runs and cleared when
  // it settles: a second activation dispatched before the busy render commits
  // is refused here, so it can neither send a request nor — by settling at
  // once — release the busy state the first activation holds.
  const inFlightRef = useRef(false);
  const reloading = reload.kind === 'reloading';
  const unavailable = requesting || reloading;

  const handleReload = (): void => {
    if (unavailable || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setRequesting(true);
    void reloadInspectedPage().then(() => {
      inFlightRef.current = false;
      setRequesting(false);
    });
  };

  return (
    <Stack direction="vertical" gap={2} align="start">
      <Text as="p" role="status">
        {reload.kind === 'offered' ? PAGE_RELOAD_NOTICES[reload.reason] : PAGE_RELOADING_NOTICE}
      </Text>
      <Button
        variant="secondary"
        size="sm"
        aria-disabled={unavailable ? true : undefined}
        aria-busy={unavailable ? true : undefined}
        onClick={handleReload}
      >
        {reloading ? PAGE_RELOADING_LABEL : PAGE_RELOAD_ACTION_LABEL}
      </Button>
    </Stack>
  );
}

/*
 * ===========================================================================
 * Section G — the composition root
 * ===========================================================================
 */

/** Reads the store's current non-blocking failure, for the actions' dismissal rule. */
function readLastError(): ErrorPayload | undefined {
  return getPanelSnapshot().lastError;
}

/**
 * Return focus after a transient region — the drawer or the dialog, in either
 * mode — closed, unless the developer already moved it somewhere that still exists:
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
 * `actions`, with `onSelectEvent` first handing the raised event's id to
 * `record` — which notes where the selection came from — and then selecting
 * it exactly as `actions` does. Every other member is `actions`' own, so the
 * selection itself still lives in the store alone.
 *
 * @param actions The panel's one actions object.
 * @param record Notes the provenance of a selection raised through the result.
 * @returns A new, frozen actions object; memoize it, since `PanelHost` and the
 * live tail key their memoized views on the actions' identity.
 */
function recordingSelections(
  actions: DevtoolsPanelActions,
  record: (eventId: string) => void,
): DevtoolsPanelActions {
  const { onSelectEvent } = actions;
  return Object.freeze({
    ...actions,
    onSelectEvent: (ref: Parameters<DevtoolsPanelActions['onSelectEvent']>[0]): void => {
      record(ref.eventId);
      onSelectEvent(ref);
    },
  });
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
  // An element description still waiting on the inspected page is abandoned
  // with the panel, so no evaluation outlives the document that awaits it.
  useEffect(() => {
    const connection = startPanelConnection();
    return () => {
      cancelActiveDescription('unmounted');
      connection.stop();
    };
  }, []);

  // Picker mode the service requests (a relayed `target.request`) is armed by
  // this panel, exactly as "Pick element" arms it, and left again with the
  // reason when arming fails. Subscribed to the store rather than keyed on a
  // rendered value, so no rise and fall between two renders is missed.
  useEffect(() => watchPickerMode(), []);

  // Built once. Both are pure factories over module-stable functions that read
  // the live port and the live session at call time, so one instance serves the
  // document across every reconnect and rebind — and their stable identities
  // are what keep `PanelHost`'s query effects and memoized views from re-running.
  const dataProvider = useMemo(
    () =>
      createPanelDataProvider({
        request: panelRequest,
        getSessionId,
        getCaptureId: readCaptureId,
        canServeCached: canServeCachedTrace,
        onPortDisconnect,
      }),
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
  const reload = usePanelReloadState();
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

  // What the header shows of the session's target: the optimistic pick while
  // it awaits confirmation, otherwise the confirmed one — as a bounded display
  // copy, derived rather than stored, so the store keeps only the descriptor
  // itself. The picker's two controls need a session bound to this tab.
  const shownTarget = target.pending ?? session?.target;
  const displayTarget = useMemo(() => toDisplayTarget(shownTarget), [shownTarget]);
  const sessionBound = connection.binding.kind === 'bound';

  // Presentation-only state, duplicating nothing in the store: the pairing
  // dialog dismissed for the current connection episode, whether the developer
  // asked for the address dialog, and the tail's disclosure. `lastChangeAt`
  // moves on every connection change, so a dismissal holds only until the
  // connection changes again.
  const [pairDismissedAt, setPairDismissedAt] = useState<number | undefined>(undefined);
  const [addressDialogRequested, setAddressDialogRequested] = useState(false);
  const [tailCollapsed, setTailCollapsed] = useState(false);

  // The service-address setting, resolved once: whether this document has
  // extension storage cannot change while it is loaded. It decides whether the
  // pill offers "Change service address…" at all, and the dialog works with
  // this same accessor in both of its modes.
  const [serviceEndpoint] = useState(() => resolveServiceEndpointAccessor());

  const pairDialogOpen =
    connection.status === 'not-paired' && pairDismissedAt !== connection.lastChangeAt;
  // A pairing episode withdraws the address request, so the address dialog
  // never reopens on its own once the pairing dialog has come and gone.
  // Adjusted during render — React's documented pattern for state derived from
  // a changed value — rather than in an effect, so no frame ever renders the
  // withdrawn request.
  if (addressDialogRequested && connection.status === 'not-paired') {
    setAddressDialogRequested(false);
  }
  // Not paired, the pairing dialog — which carries the address field itself —
  // takes precedence, so the two modes are never both open.
  const addressDialogOpen = addressDialogRequested && connection.status !== 'not-paired';
  const modalOpen = pairDialogOpen || addressDialogOpen;
  const dialogMode: PairDialogMode = addressDialogOpen ? 'address' : 'pair';
  // What held focus when the developer asked for a dialog — the connection
  // pill's "Pair…" or "Change service address…" control. Recorded here, in the
  // click handler and before the header turns inert, so the opener is known
  // however the platform treats focus on an element that becomes inert; the
  // close effect below returns focus to it and forgets it.
  const modalOpenerRef = useRef<Element | null>(null);
  const openPairDialog = useCallback(() => {
    modalOpenerRef.current = document.activeElement;
    setPairDismissedAt(undefined);
  }, []);
  const closePairDialog = useCallback(() => {
    setPairDismissedAt(getPanelSnapshot().connection.lastChangeAt);
  }, []);
  const openAddressDialog = useCallback(() => {
    modalOpenerRef.current = document.activeElement;
    setAddressDialogRequested(true);
  }, []);
  const closeAddressDialog = useCallback(() => {
    setAddressDialogRequested(false);
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

  // Focus when the dialog closes, in either mode. `PairDialog` first returns
  // focus to the element it found focused on open; this effect's cleanup runs
  // after it (a child's effects are torn down before its parent's) and settles
  // the rest: when focus still sits on the document body, it goes to the opener
  // recorded above — no longer inert, because the header's `inert` was removed
  // in the same commit that removed the dialog — and, for a dialog that opened
  // by itself or whose opener is gone (the address control leaves the header
  // once the connection recovers), to the panel body. `restoreFocus` leaves
  // focus alone once it rests anywhere else, so the two never contend. Keyed
  // on the modal as a whole, so a switch from the address mode to pairing
  // keeps the opener until the dialog finally closes.
  useEffect(() => {
    if (!modalOpen) {
      // Closed: an opener recorded for an earlier dialog must not outlive it.
      modalOpenerRef.current = null;
      return undefined;
    }
    const opener = modalOpenerRef.current;
    const main = mainRef.current;
    return () => {
      restoreFocus(opener, main);
    };
  }, [modalOpen]);

  // The non-blocking failure notice's two controls. Either one removes the
  // notice, and with it the focused control, so focus moves to the panel body
  // rather than being dropped to the document. Retry re-reads the session from
  // the service; a renewed failure sets the notice again.
  const retryLastError = useCallback(() => {
    setLastError(undefined);
    mainRef.current?.focus();
    reloadSessionState();
  }, []);
  const dismissLastErrorNotice = useCallback(() => {
    dismissLastError();
    mainRef.current?.focus();
  }, []);

  const spec = panel?.spec;
  const sessionStatus = session?.status;
  const viewStatus = generationStatus(sessionStatus);
  const sessionFailure =
    viewStatus === 'error' ? describeSessionFailure(progress, instrumentation.failure) : undefined;
  const querySessionId: string | undefined = spec?.sessionId ?? session?.id;
  const hasSession = session !== undefined || spec !== undefined;

  // Where the selection on screen was raised (see `SelectionProvenance`): the
  // store's selection does not carry it, and it decides whose evidence the
  // drawer reads. Each control that raises a selection records it through
  // actions of its own: the rendered panel's views as that panel's evidence,
  // the live tail as evidence of the capture it streams, and the drawer's
  // ancestors as evidence of the selection they are listed under.
  const [provenance, setProvenance] = useState<SelectionProvenance | undefined>(undefined);
  const renderedPanelId = spec?.id;
  const panelActions = useMemo(
    () =>
      renderedPanelId === undefined
        ? actions
        : recordingSelections(actions, (eventId) => {
            setProvenance({ eventId, origin: 'panel', panelId: renderedPanelId });
          }),
    [actions, renderedPanelId],
  );
  const liveTailActions = useMemo(
    () =>
      recordingSelections(actions, (eventId) => {
        setProvenance({ eventId, origin: 'live', captureId: readCaptureId() });
      }),
    [actions],
  );
  const drawerActions = useMemo(
    () =>
      recordingSelections(actions, (eventId) => {
        // Read before the selection moves on: the ancestor inherits the
        // provenance of the selection it was listed under, and nothing else.
        const listedUnder = getPanelSnapshot().selectedEvent?.eventId;
        setProvenance((current) =>
          current !== undefined && current.eventId === listedUnder
            ? { ...current, eventId }
            : undefined,
        );
      }),
    [actions],
  );
  const drawerPanelId =
    selectedEvent === undefined
      ? undefined
      : drawerEvidencePanel(selectedEvent.eventId, provenance, renderedPanelId, capture.captureId);

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
        inert={modalOpen}
        onKeyDown={handleDrawerKeyDown}
      >
        <Section variant="card">
          <EventDrawer
            selected={selectedEvent}
            liveTail={liveTail}
            actions={drawerActions}
            dataProvider={dataProvider}
            sessionId={querySessionId}
            panelId={drawerPanelId}
          />
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
            serviceStartCommand={SERVICE_START_COMMAND}
            pairingDialogOpen={pairDialogOpen}
            onRequestPairing={openPairDialog}
            addressDialogOpen={addressDialogOpen}
            onRequestAddressChange={serviceEndpoint === undefined ? undefined : openAddressDialog}
          />
        }
        targetPicker={
          <TargetPicker
            target={displayTarget}
            pickerActive={target.pickRequested}
            busy={target.pending !== undefined}
            onPick={togglePicker}
            onUseSelected={adoptSelectedElement}
            devtoolsAvailable={devtoolsAvailable}
            sessionBound={sessionBound}
            onActionError={reportTargetActionFailure}
          />
        }
        captureControls={
          <CaptureControls
            sessionStatus={sessionStatus}
            captureId={capture.captureId}
            eventCount={capture.eventCount}
            onStartCapture={startCapture}
            onStopCapture={stopCapture}
            onActionError={reportCaptureActionError}
            disabledReason={captureDisabledReason(connection.status)}
          />
        }
        sessionTitle={session?.question}
        sessionStatus={sessionStatus}
        inert={modalOpen}
      />

      {/* Directly under the header, so the dialog is in view the moment the
          connection reports "Not paired" — or the developer asks to change
          the service address — whatever the body holds below it. The only
          region never made inert: every sibling below and the header above
          carry `inert` while it is open. One dialog serves both modes; it
          keys its body by the mode, so a switch from the address mode to
          pairing (the connection reported "Not paired" meanwhile) starts a
          fresh dialog. */}
      <PairDialog
        mode={dialogMode}
        open={modalOpen}
        onClose={dialogMode === 'address' ? closeAddressDialog : closePairDialog}
        submitCode={submitPairingCode}
        onPaired={reloadSessionState}
        serviceEndpoint={serviceEndpoint}
      />

      <Split weights={drawerOpen ? DRAWER_PANE_WEIGHTS : undefined} align="start">
        <main ref={mainRef} tabIndex={-1} inert={modalOpen}>
          <Stack direction="vertical" gap={3}>
            {lastError === undefined ? null : (
              <Stack direction="vertical" gap={2} align="start">
                <ErrorState
                  title={LAST_ERROR_TITLE}
                  message={lastError.message}
                  code={lastError.code}
                  hint={LAST_ERROR_RETRY_HINT}
                  announce="polite"
                  onRetry={retryLastError}
                  retryLabel={LAST_ERROR_RETRY_LABEL}
                />
                <Button variant="secondary" size="sm" onClick={dismissLastErrorNotice}>
                  {DISMISS_LABEL}
                </Button>
              </Stack>
            )}

            {hasSession ? (
              <>
                {/* Above the summary, because new React activity on this
                    document cannot be captured until it is reloaded; the
                    stored session summary and panel below still render. */}
                {reload.kind === 'not-needed' ? null : <PageReloadNotice reload={reload} />}

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
                  actions={panelActions}
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
        <section aria-label={LIVE_TAIL_REGION_LABEL} inert={modalOpen}>
          <LiveTail
            events={liveTail}
            droppedCount={liveTailDropped}
            capturing={capture.active}
            collapsed={tailCollapsed}
            onToggleCollapsed={toggleTail}
            actions={liveTailActions}
            selected={selectedEvent}
          />
        </section>
      ) : null}
    </Stack>
  );
}
