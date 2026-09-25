/**
 * The devtools page controller of the "Debug Generator" Manifest V3 extension.
 *
 * ## What this module is
 *
 * `manifest.config.ts` names `src/devtools/devtools.html` as the extension's
 * `devtools_page`, and that document loads this module the moment a DevTools
 * window opens on a tab — before any panel document exists. It is a
 * **coordination shim** that renders nothing. It does three things only this
 * context can do (AAP §0.7.1 Group 4, §0.2.4):
 *
 * 1. **Contributes the panel.** `chrome.devtools.panels.create` adds the
 *    "Debug Generator" tab, whose document is `src/panel/panel.html`.
 * 2. **Announces the inspected tab.** `chrome.devtools.inspectedWindow.tabId`
 *    is the earliest and only reliable source of the tab DevTools inspects. It
 *    travels to the service worker as `devtools.hello` on the
 *    {@link PORT_DEVTOOLS} port, which is what lets `background/tab-registry.ts`
 *    send `session.bind { tabId, url, origin }` (AAP §0.2.3). The port's later
 *    disconnect is the worker's "DevTools closed" signal behind
 *    `session.unbind`.
 * 3. **Relays the Elements panel's selection.** On
 *    `chrome.devtools.panels.elements.onSelectionChanged`, and whenever the
 *    worker asks, {@link SELECTION_DESCRIPTOR_EXPRESSION} is evaluated in the
 *    inspected page. It asks the MAIN-world telemetry agent to describe `$0`
 *    through `window.__DEBUGGEN__.describeTarget`, the result is validated
 *    structurally by {@link parseSelectionResult}, and the descriptor is sent
 *    verbatim as `devtools.element`; the worker turns it into the protocol's
 *    `target.selected { sessionId, target }` (AAP §0.4.2).
 *
 * It also reads `chrome.devtools.panels.themeName` as an opaque string. The
 * mapping to a renderer theme belongs to `../panel/theme.ts` (AAP §0.6.3), so
 * the raw value is kept unmapped here.
 *
 * ## What it deliberately does not do
 *
 * - No rendering, no styling and no React: this document is never seen.
 * - No `WebSocket`, no `fetch`, no `chrome.storage`, no credential and no
 *   `chrome.alarms` keepalive. The service worker owns all service traffic,
 *   pairing and the keepalive (`background/ws-bridge.ts`); this page only holds
 *   one runtime port.
 * - No picker mode, highlighting or hover listeners: `target.pick` drives the
 *   agent's own picker through the worker and the ISOLATED-world bridge.
 * - No `useContentScriptContext`: the agent installs `__DEBUGGEN__` in the
 *   page's MAIN world, which is the default context of `inspectedWindow.eval`
 *   and the only one in which `$0` resolves.
 * - No access to the panel document: the panel is reached through the worker.
 *
 * ## Contract gaps
 *
 * `../shared/messages` is the only wire contract on this port, and it declares
 * exactly two upstream frames (`devtools.hello`, `devtools.element`). Three
 * needs of this page have no declared frame, so they are kept as controller
 * state (see {@link DevtoolsController.getState}) instead of widening the
 * union locally. Each site is marked `contract gap:`.
 *
 * - the DevTools theme name — the panel reads it itself through
 *   `../panel/theme.ts`;
 * - panel visibility (`onShown` / `onHidden`);
 * - the reason a selection could not be described — the declared shape
 *   carries `target: null` for every failure.
 *
 * ## Worker suspension and DevTools teardown
 *
 * A Manifest V3 worker is suspended after roughly thirty seconds idle, and its
 * ports die with it (AAP §0.1.1). A disconnect while this page lives is
 * therefore answered by reconnecting with bounded, jittered exponential
 * backoff and re-announcing the tab. A selection that could not be delivered
 * while the port was down is flushed after the announcement; a selection that
 * was already delivered is not replayed, because the worker keeps none — it
 * forwards each one to the service, which persisted the session's target —
 * so a replay would only re-send a possibly stale element.
 *
 * Closing DevTools destroys this page. A `pagehide` listener marks the
 * controller as unloading and disposes it before anything else runs, so the
 * reconnect loop can never resurrect the port after teardown: a suspension
 * produces a prompt reconnect and `devtools.hello`, a close produces neither.
 *
 * ## Privacy
 *
 * Nothing is logged except reason codes, tab ids and counters — never a URL,
 * a selector, element text or a component name. The descriptor is relayed as
 * the agent produced it (already scrubbed and bounded); this module neither
 * redacts it again nor adds a field. It never constructs a `SourceLocation`.
 *
 * ## Structure
 *
 * Constants, the structural surfaces of the `chrome.devtools` / `chrome.runtime`
 * members used, pure helpers, the side-effect-free
 * {@link createDevtoolsController} factory, and one guarded
 * {@link bootstrapDevtoolsPage} call at the end. Importing this module under
 * Vitest — where `chrome.devtools` does not exist — creates no panel and
 * attaches no listener; a spec drives the factory with fakes instead.
 *
 * @module apps/chrome-extension/src/devtools/devtools
 */

import type { SelectedTarget } from '@debuggen/protocol';

import {
  EXTENSION_CHANNEL,
  isDevtoolsDownstreamMessage,
  PORT_DEVTOOLS,
  PORT_PROTOCOL_VERSION,
} from '../shared/messages';
import type {
  DevtoolsDownstreamMessage,
  DevtoolsUpstreamMessage,
  DevtoolsUpstreamPayloads,
  PortRequestId,
} from '../shared/messages';

/*
 * ===========================================================================
 * Panel contribution constants
 * ===========================================================================
 */

/**
 * The DevTools tab label: exactly "Debug Generator" (AAP §0.7.3). The browser
 * suite looks the tab up by this string.
 */
export const PANEL_TITLE = 'Debug Generator';

/**
 * The panel's tab icon, relative to the extension root — no leading `/` and no
 * `./`. `vite.config.ts` sets `publicDir: 'public'`, so `public/icons/16.png`
 * is copied to `dist/icons/16.png`.
 *
 * Verification step (repeat it after any build-config change): run
 * `pnpm --filter @debuggen/chrome-extension build` and confirm
 * `apps/chrome-extension/dist/icons/16.png` exists.
 */
export const PANEL_ICON_PATH = 'icons/16.png';

/**
 * The panel document, relative to the extension root. `vite.config.ts` builds
 * `src/panel/panel.html` as an explicit Rollup input (no manifest key names
 * it), and Vite keeps an HTML input's path relative to the project root, so it
 * is emitted at `dist/src/panel/panel.html`.
 *
 * A wrong value compiles, lints and passes every unit test while shipping an
 * empty DevTools tab. Verification step (repeat it after any build-config
 * change): run `pnpm --filter @debuggen/chrome-extension build` and confirm
 * `apps/chrome-extension/dist/src/panel/panel.html` exists. Correct this
 * constant, never the call site.
 */
export const PANEL_PAGE_PATH = 'src/panel/panel.html';

/*
 * ===========================================================================
 * Timing constants
 * ===========================================================================
 */

/** The first reconnect delay after the worker port dies, in milliseconds. */
export const DEVTOOLS_RECONNECT_BASE_MS = 250;

/** The longest reconnect delay, in milliseconds; the backoff never exceeds it. */
export const DEVTOOLS_RECONNECT_MAX_MS = 5_000;

/**
 * The fraction of each delay that jitter may remove: a delay lies in
 * `[ceiling × (1 − jitter), ceiling]`, so DevTools windows reconnecting after
 * one worker revival spread out and the cap is never exceeded.
 */
export const DEVTOOLS_RECONNECT_JITTER = 0.2;

/**
 * How long a port must stay open, in milliseconds, before its loss resets the
 * backoff. `chrome.runtime.connect` returns a port even when the worker side
 * refuses it within milliseconds, so only a port that lived this long — or
 * delivered a worker frame — proves the worker was reachable.
 */
export const DEVTOOLS_PORT_STABLE_MS = 1_000;

/**
 * How long a burst of `onSelectionChanged` events is coalesced, in
 * milliseconds: arrow-key navigation through the Elements tree fires one event
 * per node, and only the node the developer stops on is described.
 */
export const SELECTION_DEBOUNCE_MS = 75;

/**
 * The longest wait for one `inspectedWindow.eval` answer, in milliseconds. An
 * evaluation against a page that is mid-navigation can stall; past this bound
 * it settles as `eval-failed` rather than holding a reply the worker awaits.
 */
export const INSPECTED_EVAL_TIMEOUT_MS = 2_000;

/**
 * The longest wait for the inspected document's URL before `devtools.hello` is
 * sent without it, in milliseconds. The worker then reads the tab's URL
 * through `chrome.tabs.get`, so an unanswered evaluation delays the
 * announcement by at most this much.
 */
export const HELLO_LOCATION_TIMEOUT_MS = 500;

/** Caps the exponent so `2 ** attempt` can never overflow into `Infinity`. */
const MAX_BACKOFF_EXPONENT = 16;

/*
 * ===========================================================================
 * Descriptor bounds
 *
 * Mirrors of the authoritative `selectedTargetSchema` bounds in
 * `packages/instrumentation/src/schema/target.ts`, which the service applies to
 * every `target.selected`. Enforcing the same ceilings here means a hostile
 * page that overwrote `__DEBUGGEN__` cannot inflate the frame, while nothing
 * the service would accept is ever refused on the way.
 * ===========================================================================
 */

/** Longest `selector`, in UTF-16 code units. */
export const SELECTION_MAX_SELECTOR_LENGTH = 1_024;

/** Longest `tagName`. */
export const SELECTION_MAX_TAG_NAME_LENGTH = 64;

/** Longest `text`; a longer or multi-line value is dropped (the field is optional). */
export const SELECTION_MAX_TEXT_LENGTH = 256;

/** Most `componentChain` entries kept, nearest-first. */
export const SELECTION_MAX_COMPONENT_CHAIN = 16;

/** Longest component name; a longer entry is dropped from the chain. */
export const SELECTION_MAX_COMPONENT_NAME_LENGTH = 128;

/** Longest `url`. */
export const SELECTION_MAX_URL_LENGTH = 2_048;

/** Longest failure `message` kept from the page. */
export const SELECTION_MAX_MESSAGE_LENGTH = 200;

/*
 * ===========================================================================
 * The `$0` evaluation
 * ===========================================================================
 */

/**
 * Every way describing the Elements selection can fail, as a closed
 * vocabulary.
 *
 * The first four are answered by {@link SELECTION_DESCRIPTOR_EXPRESSION} in the
 * page; the last two are decided here.
 *
 * - `no-selection` — nothing is selected in the Elements panel.
 * - `not-element` — `$0` is a text node, a comment or the document.
 * - `agent-unavailable` — no telemetry agent on the page: its origin is
 *   outside the extension's host permissions, the document predates the
 *   extension, or the agent released the document. An ordinary case, not a
 *   fault.
 * - `describe-failed` — the agent threw while describing the element.
 * - `eval-failed` — `inspectedWindow.eval` reported an error or an exception,
 *   threw, or did not answer within {@link INSPECTED_EVAL_TIMEOUT_MS}.
 * - `invalid-descriptor` — the page answered something that is not a
 *   well-formed, bounded descriptor.
 */
export const SELECTION_FAILURE_REASONS = [
  'no-selection',
  'not-element',
  'agent-unavailable',
  'describe-failed',
  'eval-failed',
  'invalid-descriptor',
] as const;

/** One of {@link SELECTION_FAILURE_REASONS}. */
export type SelectionFailureReason = (typeof SELECTION_FAILURE_REASONS)[number];

/** The reasons the page-side expression itself may answer with. */
const EXPRESSION_FAILURE_REASONS = [
  'no-selection',
  'not-element',
  'agent-unavailable',
  'describe-failed',
] as const satisfies readonly SelectionFailureReason[];

/**
 * The outcome of describing the Elements selection: the validated descriptor,
 * or a typed failure. `message` is a bounded diagnostic and is never logged.
 */
export type SelectionResult =
  | { readonly ok: true; readonly target: SelectedTarget }
  | {
      readonly ok: false;
      readonly reason: SelectionFailureReason;
      readonly message?: string | undefined;
    };

/**
 * The expression evaluated in the inspected page to describe `$0`.
 *
 * Plain JavaScript in a self-contained IIFE: it declares no page global,
 * mutates nothing and reads nothing beyond the descriptor the agent produces.
 * It returns only JSON-compliant values — `inspectedWindow.eval` transports
 * nothing else, which is why the agent publishes `describeTarget` rather than
 * letting this page reach into the DOM. `$0` is read once, inside a `try`,
 * because it is a Command Line API binding rather than a variable. An agent
 * that answers nothing for an element means the agent released the document,
 * which is reported as `agent-unavailable`.
 */
export const SELECTION_DESCRIPTOR_EXPRESSION = [
  '(function () {',
  '  var el = null;',
  '  try { el = $0; } catch (e) { el = null; }',
  "  if (el === null || el === undefined) { return { ok: false, reason: 'no-selection' }; }",
  "  if (el.nodeType !== 1) { return { ok: false, reason: 'not-element' }; }",
  '  var helper = window.__DEBUGGEN__;',
  "  if (!helper || typeof helper.describeTarget !== 'function') {",
  "    return { ok: false, reason: 'agent-unavailable' };",
  '  }',
  '  var target;',
  '  try {',
  '    target = helper.describeTarget(el);',
  '  } catch (error) {',
  "    var text = '';",
  "    try { text = String(error && error.message !== undefined ? error.message : error); } catch (e) { text = ''; }",
  `    return { ok: false, reason: 'describe-failed', message: text.slice(0, ${SELECTION_MAX_MESSAGE_LENGTH}) };`,
  '  }',
  "  if (target === null || target === undefined) { return { ok: false, reason: 'agent-unavailable' }; }",
  '  return { ok: true, target: target };',
  '})()',
].join('\n');

/**
 * The expression that reads the inspected document's URL and origin for
 * `devtools.hello`. Strings only, so the answer is JSON-compliant.
 */
export const INSPECTED_LOCATION_EXPRESSION =
  '(function () { return { url: String(location.href), origin: String(location.origin) }; })()';

/*
 * ===========================================================================
 * Pure helpers
 * ===========================================================================
 */

/** A plain object — not `null`, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Membership in a closed string vocabulary, narrowing without a cast. */
function isMember<Member extends string>(
  vocabulary: readonly Member[],
  value: unknown,
): value is Member {
  return typeof value === 'string' && vocabulary.some((member) => member === value);
}

/** The C0 and C1 control ranges, which the service's single-line rule refuses. */
const C0_CONTROL_MAX = 0x1f;
const C1_CONTROL_MIN = 0x7f;
const C1_CONTROL_MAX = 0x9f;

/** Whether `value` contains a C0/C1 control character (a line break, a tab, NUL…). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= C0_CONTROL_MAX || (code >= C1_CONTROL_MIN && code <= C1_CONTROL_MAX)) {
      return true;
    }
  }
  return false;
}

/**
 * A string of at most `maxLength` code units with visible content and no
 * control character — the service's single-line rule, with its bound.
 */
function isBoundedLine(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    value.trim().length > 0 &&
    !hasControlCharacter(value)
  );
}

/** An absolute `http:`/`https:` URL with a host, as the service requires. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

/** A descriptor `url`: bounded, single-line, untrimmed-equal and absolute http(s). */
function isDescriptorUrl(value: unknown): value is string {
  return (
    isBoundedLine(value, SELECTION_MAX_URL_LENGTH) &&
    value.trim() === value &&
    isAbsoluteHttpUrl(value)
  );
}

/** A failure outcome, with its message only when one was given. */
function failure(reason: SelectionFailureReason, message?: string): SelectionResult {
  return message === undefined || message === ''
    ? { ok: false, reason }
    : { ok: false, reason, message };
}

/**
 * Validate a descriptor the page returned and rebuild it from its five known
 * fields, so no unrecognised key rides along.
 *
 * @returns The descriptor, or `undefined` when a required field is missing,
 * mistyped or out of bounds.
 */
function parseDescriptor(raw: unknown): SelectedTarget | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { selector, tagName, text, componentChain, url } = raw;
  if (
    !isBoundedLine(selector, SELECTION_MAX_SELECTOR_LENGTH) ||
    !isBoundedLine(tagName, SELECTION_MAX_TAG_NAME_LENGTH) ||
    !isDescriptorUrl(url) ||
    !Array.isArray(componentChain)
  ) {
    return undefined;
  }
  // Nearest-first is the chain's contract, so entries are filtered in order
  // and the cap keeps the nearest ones.
  const chain = componentChain
    .filter((entry): entry is string => isBoundedLine(entry, SELECTION_MAX_COMPONENT_NAME_LENGTH))
    .slice(0, SELECTION_MAX_COMPONENT_CHAIN);
  // `text` is optional: a value that is not a bounded single line is dropped
  // rather than truncated, so nothing the agent did not write is relayed.
  return isBoundedLine(text, SELECTION_MAX_TEXT_LENGTH)
    ? { selector, tagName, text, componentChain: chain, url }
    : { selector, tagName, componentChain: chain, url };
}

/**
 * Validate what {@link SELECTION_DESCRIPTOR_EXPRESSION} answered.
 *
 * The page is untrusted — any script can overwrite `window.__DEBUGGEN__` — so
 * the answer is checked structurally, bounded as the service would bound it,
 * and rebuilt from known keys only. The descriptor is otherwise relayed
 * verbatim: it is not redacted again (the agent applied the deny-list) and no
 * field is added.
 *
 * @param raw Whatever `inspectedWindow.eval` returned.
 * @returns The descriptor, or a typed failure; never throws.
 */
export function parseSelectionResult(raw: unknown): SelectionResult {
  try {
    if (!isRecord(raw)) {
      return failure('invalid-descriptor');
    }
    if (raw.ok === true) {
      const target = parseDescriptor(raw.target);
      return target === undefined ? failure('invalid-descriptor') : { ok: true, target };
    }
    if (raw.ok === false && isMember(EXPRESSION_FAILURE_REASONS, raw.reason)) {
      const message =
        typeof raw.message === 'string'
          ? raw.message.slice(0, SELECTION_MAX_MESSAGE_LENGTH)
          : undefined;
      return failure(raw.reason, message);
    }
    return failure('invalid-descriptor');
  } catch {
    // A getter on a hostile object can throw; that is an invalid answer too.
    return failure('invalid-descriptor');
  }
}

/** The inspected document's location, as `devtools.hello` carries it. */
export interface InspectedLocation {
  readonly url?: string | undefined;
  readonly origin?: string | undefined;
}

/**
 * Validate what {@link INSPECTED_LOCATION_EXPRESSION} answered. Each field is
 * kept only when it is a bounded single-line string; the worker parses and
 * redacts the URL itself.
 *
 * @param raw Whatever `inspectedWindow.eval` returned.
 */
export function parseInspectedLocation(raw: unknown): InspectedLocation {
  if (!isRecord(raw)) {
    return {};
  }
  const url = isBoundedLine(raw.url, SELECTION_MAX_URL_LENGTH) ? raw.url : undefined;
  const origin = isBoundedLine(raw.origin, SELECTION_MAX_URL_LENGTH) ? raw.origin : undefined;
  return {
    ...(url === undefined ? {} : { url }),
    ...(origin === undefined ? {} : { origin }),
  };
}

/**
 * The delay before reconnect attempt `attempt` (0-based): exponential from
 * {@link DEVTOOLS_RECONNECT_BASE_MS}, capped at {@link DEVTOOLS_RECONNECT_MAX_MS},
 * minus up to {@link DEVTOOLS_RECONNECT_JITTER} of itself. Pure.
 *
 * @param attempt Consecutive failed attempts before this one; non-finite or
 * negative values count as 0.
 * @param random A source of values in `[0, 1)`; out-of-range draws are clamped.
 * @returns A whole number of milliseconds.
 */
export function computeDevtoolsReconnectDelay(
  attempt: number,
  random: () => number = () => Math.random(),
): number {
  const exponent =
    Number.isFinite(attempt) && attempt > 0
      ? Math.min(Math.floor(attempt), MAX_BACKOFF_EXPONENT)
      : 0;
  const ceiling = Math.min(DEVTOOLS_RECONNECT_MAX_MS, DEVTOOLS_RECONNECT_BASE_MS * 2 ** exponent);
  const draw = random();
  const unit = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0;
  return Math.round(ceiling * (1 - DEVTOOLS_RECONNECT_JITTER * unit));
}

/**
 * Whether a value is a usable Chrome tab id: a non-negative safe integer
 * (`-1` is `chrome.tabs.TAB_ID_NONE`).
 */
export function isUsableTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/*
 * ===========================================================================
 * Structural surfaces
 *
 * The narrow slices of `chrome.devtools`, `chrome.runtime` and the page's
 * `window` this module touches. Local on purpose — not a cross-process
 * contract — and written so the real globals satisfy them structurally (the
 * bootstrap passes `chrome.devtools`, `chrome.runtime` and `window`) while a
 * spec can pass plain fakes.
 * ===========================================================================
 */

/**
 * The listener-registration half of a `chrome.events.Event`.
 *
 * @typeParam Listener The callback signature the event dispatches to.
 */
export interface EventLike<Listener> {
  /** Register `listener`. */
  addListener(listener: Listener): void;
  /** Unregister a listener previously passed to {@link addListener}. */
  removeListener(listener: Listener): void;
}

/** The members of a `chrome.runtime.Port` this page uses. */
export interface DevtoolsPortLike {
  /** Send one frame to the worker; throws when the port is already dead. */
  postMessage(message: unknown): void;
  /** Close the port; the worker's `onDisconnect` fires, this side's does not. */
  disconnect(): void;
  /** Frames the worker posts on this port. */
  readonly onMessage: EventLike<(message: unknown) => void>;
  /** Fired once, when the worker closes the port or goes away. */
  readonly onDisconnect: EventLike<(port: unknown) => void>;
}

/** The members of `chrome.runtime` this page uses. */
export interface DevtoolsRuntimeLike {
  /**
   * The extension id: a string while the extension context is alive,
   * `undefined` once the extension was reloaded, updated or removed.
   */
  readonly id?: string | undefined;
  /** Set while an `onDisconnect` listener runs if the port closed on an error. */
  readonly lastError?: { readonly message?: string | undefined } | undefined;
  /** Open a long-lived port to the extension's service worker. */
  connect(connectInfo: { name: string }): DevtoolsPortLike;
}

/** The members of `chrome.devtools.inspectedWindow` this page uses. */
export interface InspectedWindowLike {
  /** The inspected tab's id; read defensively, validated by {@link isUsableTabId}. */
  readonly tabId?: unknown;
  /**
   * Evaluate `expression` in the inspected page's default (MAIN-world)
   * context. The callback receives a JSON-compliant result, or `undefined` and
   * an exception record (`isError` with `code`/`description`/`details`, or
   * `isException` with `value`).
   */
  eval(expression: string, callback: (result: unknown, exceptionInfo?: unknown) => void): void;
}

/** The members of a `chrome.devtools.panels.ExtensionPanel` this page uses. */
export interface ExtensionPanelLike {
  /** Fired each time the developer switches to the panel. */
  readonly onShown: EventLike<(window: Window) => void>;
  /** Fired each time the developer switches away from the panel. */
  readonly onHidden: EventLike<() => void>;
}

/** The members of `chrome.devtools.panels` this page uses. */
export interface PanelsLike {
  /** `'default'` or `'dark'` in practice; read as an opaque string. */
  readonly themeName?: unknown;
  /** The Elements panel, for its selection event (which passes no arguments). */
  readonly elements: { readonly onSelectionChanged: EventLike<() => void> };
  /** Contribute a panel; `callback` receives it once it exists. */
  create(
    title: string,
    iconPath: string,
    pagePath: string,
    callback: (panel: ExtensionPanelLike) => void,
  ): void;
}

/** The members of `chrome.devtools` this page uses. */
export interface DevtoolsApiLike {
  readonly inspectedWindow: InspectedWindowLike;
  readonly panels: PanelsLike;
}

/** The devtools page's own `window`, for the teardown signal only. */
export interface PageLifecycleLike {
  addEventListener(type: 'pagehide', listener: () => void): void;
  removeEventListener(type: 'pagehide', listener: () => void): void;
}

/**
 * The logging surface this page writes to; `@debuggen/shared`'s `Logger`
 * satisfies it. Fields carry reason codes, tab ids and counters only.
 */
export interface DevtoolsLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Everything {@link createDevtoolsController} needs, injectable for tests. */
export interface DevtoolsControllerDeps {
  /** `chrome.devtools`, or a fake with the same members. */
  readonly devtools: DevtoolsApiLike;
  /** `chrome.runtime`, or a fake with the same members. */
  readonly runtime: DevtoolsRuntimeLike;
  /** The devtools page's `window`, whose `pagehide` marks the teardown. */
  readonly page?: PageLifecycleLike | undefined;
  /** Schedules a timer. Defaults to `globalThis.setTimeout`, looked up at call time. */
  readonly setTimeout?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  /** Cancels a handle returned by {@link setTimeout}. Defaults to `globalThis.clearTimeout`. */
  readonly clearTimeout?: ((handle: unknown) => void) | undefined;
  /** Jitter source in `[0, 1)`. Defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** Clock in milliseconds, for port-stability decisions. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Diagnostics sink. Defaults to silence. */
  readonly logger?: DevtoolsLogger | undefined;
}

/**
 * A snapshot of the controller. It carries the three facts the port has no
 * frame for (theme, visibility, the selection's failure reason) so they stay
 * observable.
 */
export interface DevtoolsControllerState {
  /** Whether {@link DevtoolsController.start} ran. */
  readonly started: boolean;
  /** Whether {@link DevtoolsController.dispose} ran (directly or on `pagehide`). */
  readonly disposed: boolean;
  /** Whether the page is being torn down; no reconnect follows once set. */
  readonly unloading: boolean;
  /** Whether reconnecting stopped for good because the extension context is gone. */
  readonly terminated: boolean;
  /** The announced inspected tab, once validated. */
  readonly tabId: number | undefined;
  /** Whether DevTools reported a tab id that cannot be announced. */
  readonly tabIdRejected: boolean;
  /** `chrome.devtools.panels.themeName`, unmapped. */
  readonly themeName: string | undefined;
  /** Whether `panels.create` delivered the panel. */
  readonly panelCreated: boolean;
  /** Whether the panel is the DevTools tab currently shown. */
  readonly panelVisible: boolean;
  /** Whether the panel document has been shown at least once. */
  readonly panelFirstShown: boolean;
  /** Whether a worker port is open. */
  readonly connected: boolean;
  /** Ports opened so far, the first included. */
  readonly connections: number;
  /** `devtools.hello` frames delivered so far. */
  readonly announcements: number;
  /** Consecutive reconnect attempts since the last stable port. */
  readonly reconnectAttempt: number;
  /** The most recent description of the Elements selection. */
  readonly lastSelection: SelectionResult | undefined;
  /** Whether a selection awaits delivery after the next announcement. */
  readonly selectionPending: boolean;
}

/** The handle {@link createDevtoolsController} returns. */
export interface DevtoolsController {
  /**
   * Contribute the panel, validate and announce the inspected tab, subscribe
   * to the Elements selection and open the worker port. Idempotent; a no-op
   * after {@link dispose}.
   */
  start(): void;
  /**
   * Remove every listener, cancel every timer, settle pending evaluations and
   * close the port. Idempotent; nothing reconnects afterwards. The panel
   * itself stays (DevTools offers no way to remove one) and dies with the page.
   */
  dispose(): void;
  /** Evaluate {@link SELECTION_DESCRIPTOR_EXPRESSION} now; never rejects. */
  describeSelection(): Promise<SelectionResult>;
  /** A snapshot; see {@link DevtoolsControllerState}. */
  getState(): DevtoolsControllerState;
}

/*
 * ===========================================================================
 * Private helpers
 * ===========================================================================
 */

/** The default logger: silence, so the devtools page adds no console noise. */
const SILENT_LOGGER: DevtoolsLogger = Object.freeze({
  debug: (): undefined => undefined,
  info: (): undefined => undefined,
  warn: (): undefined => undefined,
});

/** The default timer, resolved at call time so fake timers installed later apply. */
function defaultSetTimeout(callback: () => void, delayMs: number): unknown {
  return globalThis.setTimeout(callback, delayMs);
}

/** The default cancellation; browser timer handles are numbers. */
function defaultClearTimeout(handle: unknown): void {
  if (typeof handle === 'number') {
    globalThis.clearTimeout(handle);
  }
}

/** A loggable description of a thrown value: its name, never its message. */
function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause;
}

/**
 * A short code for an `inspectedWindow.eval` exception record: the error's
 * `code` (for example `E_PROTOCOLERROR`) or `exception`. The thrown value and
 * the description are never kept, because they can quote page content.
 */
function evalFailureDetail(exceptionInfo: Record<string, unknown>): string {
  if (exceptionInfo.isError === true) {
    return typeof exceptionInfo.code === 'string' && exceptionInfo.code !== ''
      ? `error:${exceptionInfo.code.slice(0, 64)}`
      : 'error';
  }
  return 'exception';
}

/** Whether an eval callback's second argument reports a failure. */
function isEvalFailure(exceptionInfo: unknown): exceptionInfo is Record<string, unknown> {
  return (
    isRecord(exceptionInfo) &&
    (exceptionInfo.isError === true || exceptionInfo.isException === true)
  );
}

/** The framing fields every devtools page → worker frame starts with. */
const UPSTREAM_FRAMING = {
  channel: EXTENSION_CHANNEL,
  version: PORT_PROTOCOL_VERSION,
  direction: 'upstream',
} as const;

/** A `devtools.hello` frame. */
function helloFrame(
  payload: DevtoolsUpstreamPayloads['devtools.hello'],
): DevtoolsUpstreamMessage<'devtools.hello'> {
  return { ...UPSTREAM_FRAMING, type: 'devtools.hello', payload };
}

/** A `devtools.element` frame. */
function elementFrame(
  payload: DevtoolsUpstreamPayloads['devtools.element'],
): DevtoolsUpstreamMessage<'devtools.element'> {
  return { ...UPSTREAM_FRAMING, type: 'devtools.element', payload };
}

/** The outcome of one `inspectedWindow.eval`. */
type EvalOutcome =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly detail: string };

/** A scheduled timer; the wrapper makes "no timer" distinct from any handle. */
interface TimerSlot {
  readonly handle: unknown;
}

/*
 * ===========================================================================
 * The controller
 * ===========================================================================
 */

/**
 * Create the devtools page controller. Side-effect free: nothing is created,
 * subscribed or connected until {@link DevtoolsController.start}.
 *
 * @param deps The `chrome.devtools` / `chrome.runtime` surfaces, the page
 * `window`, timers, clock, jitter source and logger.
 * @returns The controller. See {@link DevtoolsController} for each member.
 */
export function createDevtoolsController(deps: DevtoolsControllerDeps): DevtoolsController {
  const { devtools, runtime } = deps;
  const setTimer = deps.setTimeout ?? defaultSetTimeout;
  const clearTimer = deps.clearTimeout ?? defaultClearTimeout;
  const random = deps.random ?? ((): number => Math.random());
  const now = deps.now ?? ((): number => Date.now());
  const log = deps.logger ?? SILENT_LOGGER;

  // Lifecycle.
  let started = false;
  let disposed = false;
  let unloading = false;
  let terminated = false;

  // What only this page knows.
  let tabId: number | undefined;
  let tabIdRejected = false;
  let themeName: string | undefined;

  // The panel.
  let panelCreateRequested = false;
  let panel: ExtensionPanelLike | undefined;
  let panelVisible = false;
  let panelFirstShown = false;
  let selectionSubscribed = false;

  // The worker port. `portGeneration` changes on every open and close, so a
  // listener or an asynchronous announcement that belongs to an older port
  // recognises itself as stale.
  let port: DevtoolsPortLike | undefined;
  let portListeners:
    | { readonly onMessage: (message: unknown) => void; readonly onDisconnect: () => void }
    | undefined;
  let portGeneration = 0;
  let portOpenedAt = 0;
  let portHeardFrom = false;
  let connections = 0;
  let announcements = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: TimerSlot | undefined;

  // The Elements selection. `selectionSeq` increases on every change, so a
  // late answer for an older selection is discarded instead of overwriting a
  // newer one.
  let selectionSeq = 0;
  let selectionTimer: TimerSlot | undefined;
  let lastSelection: SelectionResult | undefined;
  let pendingElement: DevtoolsUpstreamPayloads['devtools.element'] | undefined;
  const pendingEvaluations = new Set<(outcome: EvalOutcome) => void>();

  // -------------------------------------------------------------------------
  // Timers and background work
  // -------------------------------------------------------------------------

  function schedule(callback: () => void, delayMs: number): TimerSlot {
    return { handle: setTimer(callback, delayMs) };
  }

  function cancel(slot: TimerSlot | undefined): void {
    if (slot === undefined) {
      return;
    }
    try {
      clearTimer(slot.handle);
    } catch {
      // A handle the host no longer knows is already cancelled.
    }
  }

  /** Run a promise-returning task whose failure must never escape. */
  function background(task: Promise<void>, label: string): void {
    task.catch((cause: unknown) => {
      log.warn('A devtools page task failed.', { task: label, error: errorName(cause) });
    });
  }

  // -------------------------------------------------------------------------
  // `inspectedWindow.eval`
  // -------------------------------------------------------------------------

  /**
   * Evaluate `expression` in the inspected page's default context. Settles
   * exactly once — with the result, the exception code, a timeout, a
   * synchronous throw, or disposal — and never rejects. No options are passed:
   * `useContentScriptContext` would select the ISOLATED world, where neither
   * `$0` nor the agent's helper exists.
   */
  function evaluate(expression: string, timeoutMs: number): Promise<EvalOutcome> {
    return new Promise<EvalOutcome>((resolve) => {
      if (disposed) {
        resolve({ ok: false, detail: 'disposed' });
        return;
      }
      let settled = false;
      // The timer fires asynchronously, so `settle` below is defined by then.
      const timer = schedule(() => {
        settle({ ok: false, detail: 'timeout' });
      }, timeoutMs);
      const settle = (outcome: EvalOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        pendingEvaluations.delete(settle);
        cancel(timer);
        resolve(outcome);
      };
      pendingEvaluations.add(settle);
      try {
        devtools.inspectedWindow.eval(expression, (result: unknown, exceptionInfo?: unknown) => {
          settle(
            isEvalFailure(exceptionInfo)
              ? { ok: false, detail: evalFailureDetail(exceptionInfo) }
              : { ok: true, value: result },
          );
        });
      } catch (cause: unknown) {
        settle({ ok: false, detail: `threw:${errorName(cause)}` });
      }
    });
  }

  async function describeSelection(): Promise<SelectionResult> {
    const outcome = await evaluate(SELECTION_DESCRIPTOR_EXPRESSION, INSPECTED_EVAL_TIMEOUT_MS);
    return outcome.ok
      ? parseSelectionResult(outcome.value)
      : failure('eval-failed', outcome.detail);
  }

  // -------------------------------------------------------------------------
  // Reading DevTools
  // -------------------------------------------------------------------------

  function readInspectedTabId(): unknown {
    try {
      return devtools.inspectedWindow.tabId;
    } catch {
      return undefined;
    }
  }

  /** `panels.themeName` as an opaque string; absent on older surfaces. */
  function readThemeName(): string | undefined {
    try {
      const value: unknown = devtools.panels.themeName;
      return typeof value === 'string' && value !== '' ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Re-read the theme. DevTools exposes no theme-change event this page
   * relies on, so this runs at start and on every panel show, and records a
   * change only when the value actually differs.
   */
  function refreshTheme(): void {
    const next = readThemeName();
    if (next === themeName) {
      return;
    }
    themeName = next;
    // contract gap: `../shared/messages` declares no theme frame on
    // PORT_DEVTOOLS. The raw value is kept in state; `../panel/theme.ts`
    // reads and maps `panels.themeName` itself.
    log.debug('DevTools theme read.', { themeName: next ?? 'unknown' });
  }

  // -------------------------------------------------------------------------
  // The worker port
  // -------------------------------------------------------------------------

  /** Post one frame on the open port; `false` when there is none or it died. */
  function postFrame(frame: DevtoolsUpstreamMessage): boolean {
    const current = port;
    if (current === undefined) {
      return false;
    }
    try {
      current.postMessage(frame);
      return true;
    } catch (cause: unknown) {
      // The port died between its disconnect and our noticing; `onDisconnect`
      // (or the next connect) takes it from here.
      log.debug('A frame could not be posted to the service worker.', {
        type: frame.type,
        error: errorName(cause),
      });
      return false;
    }
  }

  /** Whether `chrome.runtime` still belongs to a live extension context. */
  function isExtensionContextAlive(): boolean {
    try {
      return !('id' in runtime) || (typeof runtime.id === 'string' && runtime.id !== '');
    } catch {
      return false;
    }
  }

  /** Read (and thereby clear) `chrome.runtime.lastError`; its text is never logged. */
  function readLastError(): boolean {
    try {
      return runtime.lastError !== undefined;
    } catch {
      return false;
    }
  }

  function connect(): void {
    if (disposed || unloading || terminated || port !== undefined || tabId === undefined) {
      return;
    }
    if (!isExtensionContextAlive()) {
      terminated = true;
      log.info('The extension context is gone; the devtools page stops reconnecting.', { tabId });
      return;
    }
    let opened: DevtoolsPortLike;
    try {
      opened = runtime.connect({ name: PORT_DEVTOOLS });
    } catch (cause: unknown) {
      log.debug('The service worker port could not be opened.', { error: errorName(cause) });
      scheduleReconnect();
      return;
    }
    portGeneration += 1;
    const generation = portGeneration;
    const onMessage = (message: unknown): void => {
      if (generation === portGeneration) {
        receive(message);
      }
    };
    const onDisconnect = (): void => {
      if (generation === portGeneration) {
        handleDisconnect();
      }
    };
    port = opened;
    portListeners = { onMessage, onDisconnect };
    portOpenedAt = now();
    portHeardFrom = false;
    connections += 1;
    try {
      opened.onMessage.addListener(onMessage);
      opened.onDisconnect.addListener(onDisconnect);
    } catch (cause: unknown) {
      log.debug('The service worker port rejected its listeners.', { error: errorName(cause) });
      handleDisconnect();
      return;
    }
    announce(generation);
  }

  /** Detach this page's listeners from `target` and forget it as the open port. */
  function releasePort(target: DevtoolsPortLike): void {
    const listeners = portListeners;
    portListeners = undefined;
    port = undefined;
    portGeneration += 1;
    if (listeners === undefined) {
      return;
    }
    try {
      target.onMessage.removeListener(listeners.onMessage);
      target.onDisconnect.removeListener(listeners.onDisconnect);
    } catch {
      // A dead port may refuse the call; its listeners die with it.
    }
  }

  function handleDisconnect(): void {
    const lastErrorReported = readLastError();
    const livedMs = Math.max(0, now() - portOpenedAt);
    const closed = port;
    if (closed !== undefined) {
      releasePort(closed);
    }
    if (portHeardFrom || livedMs >= DEVTOOLS_PORT_STABLE_MS) {
      reconnectAttempt = 0;
    }
    log.debug('The service worker port closed.', { tabId, lastErrorReported, livedMs });
    if (disposed || unloading || terminated) {
      return;
    }
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== undefined || disposed || unloading || terminated) {
      return;
    }
    const delayMs = computeDevtoolsReconnectDelay(reconnectAttempt, random);
    reconnectAttempt += 1;
    reconnectTimer = schedule(() => {
      reconnectTimer = undefined;
      connect();
    }, delayMs);
  }

  /**
   * Announce the inspected tab on the port opened as `generation`: read the
   * document's URL and origin (bounded by {@link HELLO_LOCATION_TIMEOUT_MS};
   * without them the worker reads the tab through `chrome.tabs.get`), send
   * `devtools.hello`, then deliver a selection the previous port could not.
   * Idempotent and replayed on every reconnect, because a revived worker
   * starts with an empty registry.
   */
  function announce(generation: number): void {
    background(
      evaluate(INSPECTED_LOCATION_EXPRESSION, HELLO_LOCATION_TIMEOUT_MS).then((outcome) => {
        const announcedTab = tabId;
        if (disposed || generation !== portGeneration || announcedTab === undefined) {
          return;
        }
        const location = outcome.ok ? parseInspectedLocation(outcome.value) : {};
        if (!postFrame(helloFrame({ tabId: announcedTab, ...location }))) {
          return;
        }
        announcements += 1;
        // contract gap: `devtools.hello` carries no theme and no panel
        // visibility, and no other declared frame does; both stay in state.
        const pending = pendingElement;
        if (pending !== undefined && postFrame(elementFrame(pending))) {
          pendingElement = undefined;
        }
      }),
      'announce',
    );
  }

  // -------------------------------------------------------------------------
  // Worker → devtools page frames
  // -------------------------------------------------------------------------

  function receive(message: unknown): void {
    portHeardFrom = true;
    if (disposed || !isDevtoolsDownstreamMessage(message)) {
      // Unrecognised shapes are ignored silently: a newer worker may speak a
      // frame this page does not know yet.
      return;
    }
    handleDownstream(message);
  }

  function handleDownstream(message: DevtoolsDownstreamMessage): void {
    switch (message.type) {
      case 'devtools.describeRequest': {
        // The panel's pick found no page agent to ask, so the worker asks for
        // the Elements selection instead; the answer echoes the request id.
        const requestId = message.payload.requestId;
        background(
          describeSelection().then((result) => {
            if (disposed) {
              return;
            }
            lastSelection = result;
            relayElement(result, requestId);
          }),
          'describe request',
        );
        return;
      }
      case 'target.request': {
        // The service wants a target: offer the current Elements selection
        // when there is one to offer. Picker mode itself is the agent's and
        // the worker's, never this page's.
        background(
          describeSelection().then((result) => {
            if (disposed) {
              return;
            }
            if (!result.ok) {
              log.debug('No Elements selection to offer for a target request.', {
                tabId,
                reason: result.reason,
              });
              return;
            }
            lastSelection = result;
            relayElement(result, undefined);
          }),
          'target request',
        );
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // The Elements selection
  // -------------------------------------------------------------------------

  /**
   * Send a selection outcome as `devtools.element`. An unsolicited one that
   * cannot be posted is kept, newest wins, for delivery after the next
   * announcement; a solicited one belongs to a worker request that died with
   * its port and is dropped.
   */
  function relayElement(result: SelectionResult, requestId: PortRequestId | undefined): void {
    const announcedTab = tabId;
    if (announcedTab === undefined) {
      return;
    }
    if (!result.ok) {
      // contract gap: `devtools.element` carries `target: null` for every
      // failure, so the typed reason — `agent-unavailable` is the ordinary
      // one — is kept in state and logged here, never thrown.
      log.debug('The Elements selection could not be described.', {
        tabId: announcedTab,
        reason: result.reason,
      });
    }
    const target = result.ok ? result.target : null;
    const payload: DevtoolsUpstreamPayloads['devtools.element'] =
      requestId === undefined
        ? { tabId: announcedTab, target }
        : { tabId: announcedTab, target, requestId };
    if (postFrame(elementFrame(payload))) {
      if (requestId === undefined) {
        pendingElement = undefined;
      }
      return;
    }
    if (requestId === undefined) {
      pendingElement = payload;
    }
  }

  function describeAndRelay(seq: number): void {
    background(
      describeSelection().then((result) => {
        if (disposed || seq !== selectionSeq) {
          return;
        }
        lastSelection = result;
        relayElement(result, undefined);
      }),
      'selection',
    );
  }

  /** `panels.elements.onSelectionChanged`, coalesced over {@link SELECTION_DEBOUNCE_MS}. */
  const onSelectionChanged = (): void => {
    if (disposed) {
      return;
    }
    selectionSeq += 1;
    const seq = selectionSeq;
    cancel(selectionTimer);
    selectionTimer = schedule(() => {
      selectionTimer = undefined;
      describeAndRelay(seq);
    }, SELECTION_DEBOUNCE_MS);
  };

  // -------------------------------------------------------------------------
  // The panel
  // -------------------------------------------------------------------------

  const onPanelShown = (): void => {
    if (disposed) {
      return;
    }
    panelVisible = true;
    if (!panelFirstShown) {
      panelFirstShown = true;
      log.info('The Debug Generator panel was shown for the first time.', { tabId });
    }
    // contract gap: panel visibility has no declared frame; it stays in state.
    refreshTheme();
  };

  const onPanelHidden = (): void => {
    panelVisible = false;
  };

  function onPanelCreated(created: ExtensionPanelLike): void {
    if (disposed || panel !== undefined) {
      return;
    }
    panel = created;
    try {
      created.onShown.addListener(onPanelShown);
      created.onHidden.addListener(onPanelHidden);
    } catch (cause: unknown) {
      log.warn('The panel visibility events could not be observed.', { error: errorName(cause) });
    }
  }

  /** `panels.create`, exactly once per controller. */
  function createPanel(): void {
    if (panelCreateRequested) {
      return;
    }
    panelCreateRequested = true;
    try {
      devtools.panels.create(PANEL_TITLE, PANEL_ICON_PATH, PANEL_PAGE_PATH, onPanelCreated);
    } catch (cause: unknown) {
      log.warn('The Debug Generator panel could not be created.', { error: errorName(cause) });
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** DevTools is closing: stop before anything else can reconnect. */
  const onPageHide = (): void => {
    unloading = true;
    dispose();
  };

  function start(): void {
    if (started || disposed) {
      return;
    }
    started = true;
    // Registered first, so the teardown signal wins over every later step.
    try {
      deps.page?.addEventListener('pagehide', onPageHide);
    } catch (cause: unknown) {
      log.warn('The devtools page teardown could not be observed.', { error: errorName(cause) });
    }
    createPanel();
    refreshTheme();

    const reported = readInspectedTabId();
    if (!isUsableTabId(reported)) {
      // A bogus binding key is worse than none: the tab is not announced and
      // no selection is relayed, and the panel explains the unbound state.
      tabIdRejected = true;
      log.warn('DevTools reported no usable inspected tab id; the tab is not announced.', {
        tabIdType: typeof reported,
      });
      return;
    }
    tabId = reported;

    try {
      devtools.panels.elements.onSelectionChanged.addListener(onSelectionChanged);
      selectionSubscribed = true;
    } catch (cause: unknown) {
      log.warn('The Elements selection could not be observed.', { error: errorName(cause) });
    }
    connect();
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    unloading = true;
    cancel(selectionTimer);
    selectionTimer = undefined;
    cancel(reconnectTimer);
    reconnectTimer = undefined;
    for (const settle of [...pendingEvaluations]) {
      settle({ ok: false, detail: 'disposed' });
    }
    if (selectionSubscribed) {
      selectionSubscribed = false;
      try {
        devtools.panels.elements.onSelectionChanged.removeListener(onSelectionChanged);
      } catch {
        // DevTools is going away; its events go with it.
      }
    }
    const createdPanel = panel;
    if (createdPanel !== undefined) {
      try {
        createdPanel.onShown.removeListener(onPanelShown);
        createdPanel.onHidden.removeListener(onPanelHidden);
      } catch {
        // As above.
      }
    }
    try {
      deps.page?.removeEventListener('pagehide', onPageHide);
    } catch {
      // As above.
    }
    const open = port;
    if (open !== undefined) {
      releasePort(open);
      try {
        open.disconnect();
      } catch {
        // Already closed.
      }
    }
    pendingElement = undefined;
    panelVisible = false;
  }

  function getState(): DevtoolsControllerState {
    return {
      started,
      disposed,
      unloading,
      terminated,
      tabId,
      tabIdRejected,
      themeName,
      panelCreated: panel !== undefined,
      panelVisible,
      panelFirstShown,
      connected: port !== undefined,
      connections,
      announcements,
      reconnectAttempt,
      lastSelection,
      selectionPending: pendingElement !== undefined,
    };
  }

  return { start, dispose, describeSelection, getState };
}

/*
 * ===========================================================================
 * Bootstrap
 * ===========================================================================
 */

/**
 * A realm-wide marker. A second evaluation of this module in the same page
 * (a duplicated script tag, a re-import) has a module scope of its own; this
 * `Symbol.for` key is what stops it contributing a second panel.
 */
const BOOTSTRAP_MARKER = Symbol.for('debuggen.devtools-page');

/** The controller this realm's bootstrap started, so a second call cannot start another. */
let bootstrapped: DevtoolsController | undefined;

/**
 * Whether this realm is an extension devtools page: a `window`, a
 * `chrome.devtools` with `panels.create` and `inspectedWindow`, and a
 * `chrome.runtime.connect`. False under Vitest, in a plain page, and in the
 * panel document opened directly as an extension page.
 */
export function isDevtoolsPageEnvironment(): boolean {
  try {
    if (typeof window === 'undefined' || typeof chrome === 'undefined') {
      return false;
    }
    const host: unknown = chrome;
    if (!isRecord(host)) {
      return false;
    }
    const devtoolsApi = host.devtools;
    const runtimeApi = host.runtime;
    return (
      isRecord(devtoolsApi) &&
      isRecord(devtoolsApi.panels) &&
      typeof devtoolsApi.panels.create === 'function' &&
      isRecord(devtoolsApi.inspectedWindow) &&
      isRecord(runtimeApi) &&
      typeof runtimeApi.connect === 'function'
    );
  } catch {
    return false;
  }
}

/**
 * Start the controller from the real globals, once per realm.
 *
 * @returns The running controller — the one a previous call started, if any —
 * or `undefined` outside a devtools page, where nothing is touched.
 */
export function bootstrapDevtoolsPage(): DevtoolsController | undefined {
  if (bootstrapped !== undefined) {
    return bootstrapped;
  }
  if (!isDevtoolsPageEnvironment()) {
    return undefined;
  }
  if (Reflect.get(globalThis, BOOTSTRAP_MARKER) === true) {
    return undefined;
  }
  Reflect.set(globalThis, BOOTSTRAP_MARKER, true);
  const controller = createDevtoolsController({
    devtools: chrome.devtools,
    runtime: chrome.runtime,
    page: window,
  });
  bootstrapped = controller;
  controller.start();
  return controller;
}

// The module's only import-time effect, guarded so that importing it under
// Vitest (no `chrome.devtools`) is inert. Keep the guard: specs drive
// createDevtoolsController() with fakes instead.
bootstrapDevtoolsPage();
