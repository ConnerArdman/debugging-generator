/**
 * `telemetry-capture` — the browser project's proof that the page agent observes one real
 * interaction end to end — the agent is injected before React, and a click produces interaction,
 * render and fetch events that share one `traceId` — on a freshly loaded page, across a reload
 * during a capture, and on a page that was already open before the extension was enabled; and that
 * the same agent's element picker, armed by "Pick element" in the panel or relayed from VS Code,
 * makes the element the developer clicks the session's target while the page never acts on that
 * click.
 *
 * ## What each test proves
 *
 * 1. **Present before React, dormant until armed.** On a fresh document the MAIN-world agent has
 *    published `window.__DEBUGGEN__` with a callable `span`, and React registered its renderer
 *    with the DevTools hook the agent installed — React registers only with a hook that already
 *    exists, so a registered renderer is direct evidence the `document_start` content script ran
 *    first. Without a capture the agent posts no telemetry, leaves `fetch`/`XMLHttpRequest`
 *    unpatched, the service holds no event for the session, and the page still works.
 * 2. **Fresh page, one click, one trace.** The click yields exactly one `interaction` whose
 *    `traceId` also carries the `fetch` of the fixture route (its direct child) and the React work
 *    the click caused — including the commit that follows the response, attributed to the settled
 *    request by async-continuation lineage. Time semantics, ordering, per-producer sequencing and
 *    the capture-level privacy guarantees are asserted on the stored events, and the panel's live
 *    tail is shown to stream them.
 * 3. **Reload during a capture.** The reloaded document is re-armed with the same `captureId`:
 *    every event of both documents is attributed to that one capture, whose summary names both
 *    producers, and the reload is visible where the developer watches the capture. The panel's
 *    live tail shows the reloaded document's own `navigation` event (`navigation.type` =
 *    `reload`) and, in its capture-notices list, a "Page reloaded during capture" entry: the
 *    panel store records that notice when the service announces the kept binding as `navigated`
 *    while the capture runs (`reduceSessionBound` in
 *    `apps/chrome-extension/src/panel/state/session-store.ts`), and `LiveTail.tsx` words it
 *    (`NOTICE_LABELS`). The list's name and that wording are module-private in a React component
 *    module, so `fixtures.ts` types them and exposes the entries as `panel.pageReloadedNotices`.
 * 4. **"Pick element" selects the clicked element, and only the picker sees that click.** With a
 *    bound session, the panel's toggle turns picker mode on (`aria-pressed`, the "Picker on"
 *    badge), and hovering the widget's button shows the agent's highlight over exactly that
 *    button: a `div` attached to `document.documentElement` rather than inside `body`,
 *    `aria-hidden`, fixed and click-through. A trusted click on the button then becomes the
 *    session's target in the service record — the button's tag, a selector that resolves in the
 *    page to that button, its text, the widget's display name as the nearest component, the
 *    page's URL — and the panel shows it. The click was the picker's alone: no event of the gesture
 *    reached the document, the fixture route was not requested and the widget shows no result. The
 *    pick is over everywhere — toggle released, badge and highlight gone — and the next click
 *    reaches the application as it always does, leaving the target as picked.
 * 5. **Escape cancels.** Escape pressed in the page ends an armed pick without an element: the
 *    worker releases the panel's toggle, the highlight leaves the page, the next click reaches the
 *    application, and the session record still names no target.
 * 6. **The toggle cancels.** Pressing "Pick element" again ends the armed pick in the page — its
 *    highlight leaves — so the next click on the button reaches the application and the session
 *    target stays unset.
 * 7. **VS Code's route arms the same pick.** `POST /sessions/:id/target/request` with the editor
 *    credential (`service.requestTarget`) is answered with the session's bound tab, and the
 *    service's relayed `target.request` puts that tab's panel into picker mode without a press;
 *    the page's pick then behaves exactly as in test 4.
 * 8. **A page that was open before the extension.** Such a page carries no agent, so readiness
 *    cannot be met; the service asks the developer to reload and the panel offers its own reload
 *    action, and nothing reloads the page — no document load, no `chrome.tabs.reload` from the
 *    worker — until the developer clicks that action. The click is the consent: the worker makes
 *    exactly one `chrome.tabs.reload`, of the inspected tab, and afterwards the session reaches
 *    `ready`, the new document reports `installedBeforeReact: true`, the offer is withdrawn, and a
 *    capture yields the trace shape of test 2.
 *
 * ## Where every expectation comes from
 *
 * - **Fixture vocabulary only.** The widget's display name, its route and the route's
 *   delay are read at run time from `tests/fixtures/sample-next-app` (the `export function`
 *   declaration, the `fetch('…')` literal and `DELAY_MS`), and the reply text from the running
 *   route itself, so this file names nothing of `apps/demo-app` and restates no fixture literal
 *   except the two published test ids. The session question is generic.
 * - **Kinds and attribute keys** are typed against `@debuggen/telemetry`'s catalogs with
 *   `satisfies`, so a renamed kind or key fails `tsc` here rather than silently matching nothing.
 * - **Privacy** is judged by the product's own rules: every stored event must be a fixed point of
 *   `redactEvent` (the same redactor ingest applies; idempotent by construction), URL and stack
 *   values fixed points of `redactUrl`/`redactStackUrls`, no key of `DROPPED_ATTRIBUTE_KEYS` at any
 *   depth, denied header values equal to `REDACTION_MARKER`, no value matching a pattern rule of
 *   `findDeniedRules`, and a planted cookie value and query-parameter value found nowhere.
 * - **Agent frames** are observed in the page itself: an init script — which Chromium runs before
 *   every content script, so it is exactly the "code that ran before the agent" the page channel's
 *   threat model names as out of reach (docs/SECURITY.md, section 9.1) — listens for the agent's
 *   handshake offer on `window`, keeps the private channel node it carries, and records every
 *   agent frame dispatched on that node without ever claiming one, so `agent.ready` is read
 *   exactly as the bridge relays it. No page script that starts after `document_start` can do this.
 * - **The picker is observed where it acts.** Its highlight is read from the page's DOM by the
 *   traits the agent gives it (`packages/telemetry/src/browser/dom-target.ts`, "Element picker"),
 *   and a read before any pick proves the application renders nothing like it. What reached the
 *   application is recorded by a capture-phase listener on `document` — the node after `window`,
 *   where the picker consumes the gesture — for the platform's click-gesture event types, and by
 *   the page's `request` events for the fixture route. Picker mode is the toggle's `aria-pressed`
 *   and its "Picker on" badge, whose module-private names `fixtures.ts` types; the target is the
 *   service's session record (`GET /sessions/:id`), polled until it names one.
 *
 * ## How the "already open" state of test 8 is provoked
 *
 * The tab is opened while the extension is disabled, through `chrome.management` on
 * `chrome://extensions` (the browser's own control), and the extension is enabled afterwards.
 * Chrome injects no declared content script into a tab that is already open when an extension is
 * enabled, so the tab is precisely a page loaded before the extension: it carries neither agent
 * nor bridge, and the worker judges its readiness from the same observations it makes for any such
 * page.
 *
 * The consent is given the way a developer gives it, through the panel's own reload action. The
 * service's readiness gate surfaces the reload request as a `session.progress` row; the worker,
 * which sees neither a bridge nor an agent report for the tab's document, offers the reload
 * (`agent-missing`), and the panel renders the action under `PAGE_RELOAD_ACTION_LABEL`, the name
 * this file imports rather than retypes. Clicking it sends the panel's `page.reload` request, and
 * the worker's consented reload — not Playwright — reloads the tab through `chrome.tabs.reload`
 * and waits for the next document's `agent.ready`, after which the offer returns to `not-needed`
 * and the action disappears. The reload is observed where it happens: as soon as the re-enabled
 * extension's worker exists, the test wraps `chrome.tabs.reload` in that worker, recording each
 * tab id and still calling the original (the worker hands the `chrome.tabs` namespace itself to
 * its agent control, which looks the method up at call time), so zero calls before the click and
 * exactly one, naming the inspected tab, after it are asserted beside the page-side evidence of
 * document loads and the marker. A wrapper that cannot be installed fails the test, which never
 * substitutes a reload of its own, and the finally block puts the original function back.
 *
 * ## Scope
 *
 * Browser-tier evidence only: deterministic provider, no PostgreSQL, localhost only.
 * No server-agent credential is minted or used by this file: whether a server preload is attached
 * depends solely on how `fixtures.ts` came to serve the app (`fixtureApp.servedBy`), and the
 * fixture app has no database, so server- and database-tier spans are neither required nor
 * asserted here — `tests/e2e/**` owns those tiers. Ordering is checked on browser-tier edges
 * only, because a server span's clock is the Node process's, not the page's.
 *
 * ## Shared state (`workers: 1`, `fullyParallel: false`)
 *
 * One Chromium context, one service and one `DEBUGGEN_HOME` serve the whole suite, so every query
 * and assertion is scoped to the test's own session and capture, every session is ended by the
 * fixture's tracked teardown (and every capture is stopped by `sessions.capture` even on failure),
 * the planted cookie is removed, and bindings are reset with `resetExtensionState()`. Every pick a
 * test arms ends inside that test — picked, escaped or toggled off, each proven by the released
 * toggle and the removed highlight — and one a failure leaves armed ends with the test's tab and
 * with its session's unbinding, which cancels it in the page. Test 8 disables and re-enables the
 * extension, which replaces its MV3 worker; it is declared last and always re-enables the
 * extension, and the fixtures reach the worker through their live-worker lookup, so later tests
 * start from a paired, running extension.
 */
import { randomBytes } from 'node:crypto';

import type { BrowserContext, Locator, Page, Request, Worker } from '@playwright/test';

import {
  AGENT_SOURCE_TAG,
  PAGE_AGENT_FRAME_EVENT,
  PAGE_CHANNEL_VERSION,
  PAGE_RELOAD_ACTION_LABEL,
  PAGE_HANDSHAKE_OFFER_EVENT,
  isAgentChannelMessageOfType,
} from '@debuggen/chrome-extension/messages';
import type { AgentOutboundType, PageAgentReadyPayload } from '@debuggen/chrome-extension/messages';
import { DATA_QUERY_MAX_LIMIT } from '@debuggen/panel-schema';
import type {
  ProgressStage,
  ProgressStatus,
  SelectedTarget,
  SessionRecord,
  TelemetryEvent,
} from '@debuggen/protocol';
import {
  DROPPED_ATTRIBUTE_KEYS,
  MAX_EPOCH_MS,
  MIN_EPOCH_MS,
  REDACTION_MARKER,
  RENDER_KINDS,
  RENDER_PHASES,
  STACK_ATTRIBUTE_KEYS,
  findDeniedRules,
  findNodeBySpanId,
  headerNameFromAttributeKey,
  isDeniedHeaderName,
  isHeaderAttributeKey,
  isUrlAttributeKey,
  lineageOf,
  redactEvent,
  redactStackUrls,
  redactUrl,
} from '@debuggen/telemetry';
import type {
  CaptureSummary,
  FETCH_ATTRIBUTE_KEYS,
  LineageValue,
  NAVIGATION_ATTRIBUTE_KEYS,
  RENDER_ATTRIBUTE_KEYS,
  TelemetryKind,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';

import {
  APP_READY_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  SESSION_READY_TIMEOUT_MS,
  WORKER_READY_TIMEOUT_MS,
  expect,
  readFixtureSource,
  test,
} from './fixtures';
import type {
  EditorClient,
  OpenPanelOptions,
  PanelHandle,
  ServiceHandle,
  SessionHelper,
} from './fixtures';

// ---------------------------------------------------------------------------
// Vocabulary, typed against the product's own catalogs
// ---------------------------------------------------------------------------

const KIND_INTERACTION = 'interaction' satisfies TelemetryKind;
const KIND_FETCH = 'fetch' satisfies TelemetryKind;
const KIND_RENDER = 'render' satisfies TelemetryKind;
const KIND_COMMIT = 'commit' satisfies TelemetryKind;
const KIND_STATE = 'state' satisfies TelemetryKind;
const KIND_NAVIGATION = 'navigation' satisfies TelemetryKind;
const TIER_BROWSER = 'browser' satisfies TelemetryEvent['tier'];

/** The browser-tier kinds whose parent edges are causal, and so ordered in time. */
const CAUSAL_BROWSER_KINDS: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>([
  KIND_INTERACTION,
  KIND_FETCH,
  KIND_COMMIT,
  KIND_RENDER,
  KIND_STATE,
]);

type FetchAttributeKey = (typeof FETCH_ATTRIBUTE_KEYS)[number];
const FETCH_METHOD_KEY = 'http.method' satisfies FetchAttributeKey;
const FETCH_URL_KEY = 'url' satisfies FetchAttributeKey;
const FETCH_STATUS_KEY = 'http.status_code' satisfies FetchAttributeKey;
const FETCH_SAME_ORIGIN_KEY = 'sameOrigin' satisfies FetchAttributeKey;
const FETCH_TRACEPARENT_KEY = 'traceparentInjected' satisfies FetchAttributeKey;

type RenderAttributeKey = (typeof RENDER_ATTRIBUTE_KEYS)[number];
const RENDER_COMPONENT_KEY = 'component' satisfies RenderAttributeKey;
const RENDER_PHASE_KEY = 'phase' satisfies RenderAttributeKey;
const RENDER_COUNT_KEY = 'renderCount' satisfies RenderAttributeKey;

type NavigationAttributeKey = (typeof NAVIGATION_ATTRIBUTE_KEYS)[number];
const NAVIGATION_TYPE_KEY = 'navigation.type' satisfies NavigationAttributeKey;
/** `PerformanceNavigationTiming.type` of a reload — the platform's vocabulary, which the agent carries verbatim. */
const NAVIGATION_TYPE_RELOAD = 'reload' satisfies NavigationTimingType;

const LINEAGE_ASYNC_CONTINUATION = 'async-continuation' satisfies LineageValue;

const AGENT_READY_FRAME = 'agent.ready' satisfies AgentOutboundType;
const TELEMETRY_BATCH_FRAME = 'telemetry.batch' satisfies AgentOutboundType;

const INSTRUMENT_STAGE = 'instrument' satisfies ProgressStage;
const RUNNING_STATUS = 'running' satisfies ProgressStatus;

/** The locator contract `tests/fixtures/sample-next-app/src/components/PingWidget.tsx` publishes. */
const PING_BUTTON_TEST_ID = 'ping-button';
const PING_RESULT_TEST_ID = 'ping-result';

/**
 * The one generic question every session here asks. It names the interaction and the evidence
 * wanted in the product's generic signal vocabulary (click, slow, render, fetch) and nothing of any
 * application.
 */
const QUESTION =
  'Why is it slow to see a result after I click this button, and what renders and fetches while it waits?';

// ---------------------------------------------------------------------------
// Timing — every bound is named; nothing below sleeps outside these constants
// ---------------------------------------------------------------------------

/** Tolerance on "a parent does not start after its child": both ends come from the page's `performance` clock, but each is rounded to an epoch double independently. */
const ORDERING_TOLERANCE_MS = 1;

/** How far an event's epoch `startTime` may sit outside the test's own wall-clock window: browser and runner share one machine clock, and this only absorbs `performance.timeOrigin` rounding. */
const CLOCK_WINDOW_MS = 5_000;

/**
 * The fetch duration must clear this fraction of the route's own awaited delay. A lower bound only:
 * the request cannot settle before the handler's timer fired, and a loaded CI machine can only
 * lengthen it; the 20 % slack absorbs timer coalescing and millisecond rounding on both sides.
 */
const FETCH_DURATION_FLOOR_RATIO = 0.8;

/** How long after the consented reload no further navigation may arrive — the proof there was exactly one. */
const RELOAD_QUIET_WINDOW_MS = 3_000;

/** Bound for the agent to be re-armed (or disarmed) on a document after a configuration change. */
const AGENT_ARMING_TIMEOUT_MS = 20_000;

/** A capture test covers pipeline readiness, a capture window and the evidence reads. */
const CAPTURE_TEST_TIMEOUT_MS = 180_000;

/** The pre-extension test adds an extension disable/enable cycle and a reload wait. */
const RELOAD_TEST_TIMEOUT_MS = 240_000;

/** A picker test covers pipeline readiness, one pick settled through page, worker, service and panel, and one ordinary click. */
const PICKER_TEST_TIMEOUT_MS = 150_000;

/** How far the picker's highlight may sit from the box of the element it covers: both are `getBoundingClientRect` reads of one layout, so this absorbs sub-pixel rounding only. */
const HIGHLIGHT_BOX_TOLERANCE_PX = 1;

// ---------------------------------------------------------------------------
// Planted privacy probes (random per run; never a credential literal)
// ---------------------------------------------------------------------------

/** A generic query-parameter name the fresh page is opened with; its value must never be stored. */
const PROBE_QUERY_KEY = 'probe';

/** A cookie planted on the fixture origin for the length of one test; its value must never be stored. */
const PROBE_COOKIE_NAME = 'sample_check_probe';

/** The page global the agent-frame recorder writes to — spec-owned, disjoint from every product global. */
const FRAME_STORE_KEY = '__telemetryCaptureSpecFrames';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A random lowercase hex token, fresh per call: a probe value no product code could know. */
function randomProbeValue(): string {
  return randomBytes(12).toString('hex');
}

/** Escape a literal for a `RegExp`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The one element of `items`, failing with `what` when there is none or more than one. */
function onlyOne<T>(items: readonly T[], what: string): T {
  expect(items, `expected exactly one ${what}`).toHaveLength(1);
  const [only] = items;
  if (only === undefined) {
    throw new Error(`expected exactly one ${what}, found none`);
  }
  return only;
}

/** The first element of `items` matching `predicate`, failing with `what` when none does. */
function findRequired<T>(items: readonly T[], predicate: (item: T) => boolean, what: string): T {
  const found = items.find(predicate);
  if (found === undefined) {
    throw new Error(`expected ${what}, but none was captured`);
  }
  return found;
}

/** A string attribute, or `undefined` when absent or of another type. */
function stringAttribute(event: TelemetryEvent, key: string): string | undefined {
  const value = event.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

/** The request path an event's `url` attribute names, resolved against the app origin. */
function requestPathOf(event: TelemetryEvent, baseUrl: string): string | undefined {
  const url = stringAttribute(event, FETCH_URL_KEY);
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url, baseUrl).pathname;
  } catch {
    return undefined;
  }
}

/** A compact description of a set of events, for failure messages. */
function describeKinds(events: readonly TelemetryEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  }
  return counts.size === 0
    ? 'no events at all'
    : [...counts].map(([kind, count]) => `${kind}×${String(count)}`).join(', ');
}

// ---------------------------------------------------------------------------
// The fixture app's contract, read at run time
// ---------------------------------------------------------------------------

/** What this file needs to know about the fixture app, derived from its sources and its route. */
interface FixtureContract {
  /** The widget component's display name: its named `export function`. */
  readonly widgetName: string;
  /** The same-origin route the widget's handler fetches. */
  readonly pingPath: string;
  /** The route handler's awaited delay, in milliseconds (`DELAY_MS`). */
  readonly routeDelayMs: number;
  /** The route's response body, byte for byte — which no stored event may contain. */
  readonly rawResponseBody: string;
  /** The `reply` the widget renders into its result region. */
  readonly replyText: string;
}

/**
 * Read the widget's display name, its fetch target and the route's delay from the tracked fixture,
 * then ask the running app for the route's body — so a change to the fixture changes the
 * expectations with it, and no fixture value is restated here.
 */
async function loadFixtureContract(baseUrl: string): Promise<FixtureContract> {
  const widget = await readFixtureSource('src/components/PingWidget.tsx');
  const route = await readFixtureSource('app/api/ping/route.ts');
  const widgetName = /export function ([A-Z][A-Za-z0-9]*)\s*\(/.exec(widget.text)?.[1];
  const pingPath = /fetch\(\s*'([^']+)'/.exec(widget.text)?.[1];
  const delay = /const DELAY_MS = (\d+);/.exec(route.text)?.[1];
  if (widgetName === undefined || pingPath === undefined || delay === undefined) {
    throw new Error(
      "The sample-next-app fixture no longer declares its widget as a named `export function`, calls `fetch('…')` with a literal route, or declares `const DELAY_MS = <n>;` in its route handler; update loadFixtureContract to its new shape.",
    );
  }
  const response = await fetch(new URL(pingPath, baseUrl), {
    signal: AbortSignal.timeout(APP_READY_TIMEOUT_MS),
  });
  const rawResponseBody = await response.text();
  expect(response.status, `GET ${pingPath} on the fixture app`).toBe(200);
  const parsed: unknown = JSON.parse(rawResponseBody);
  const replyText = isRecord(parsed) && typeof parsed.reply === 'string' ? parsed.reply : undefined;
  if (replyText === undefined || replyText.trim() === '') {
    throw new Error(
      `GET ${pingPath} did not answer a non-empty string \`reply\`: ${rawResponseBody}`,
    );
  }
  return { widgetName, pingPath, routeDelayMs: Number(delay), rawResponseBody, replyText };
}

/** Click the widget's button and wait for the route's reply to render in its status region. */
async function runCheck(page: Page, contract: FixtureContract): Promise<void> {
  const button = page.getByTestId(PING_BUTTON_TEST_ID);
  await expect(button).toBeEnabled({ timeout: DEFAULT_WAIT_TIMEOUT_MS });
  await button.click();
  await expect(page.getByTestId(PING_RESULT_TEST_ID)).toHaveText(contract.replyText, {
    timeout: DEFAULT_WAIT_TIMEOUT_MS,
  });
}

// ---------------------------------------------------------------------------
// The page: agent frames and globals, observed from the MAIN world
// ---------------------------------------------------------------------------

/** What the in-page recorder is told; serialised into the page, so plain data only. */
interface FrameRecorderArgs {
  readonly storeKey: string;
  readonly sourceTag: string;
  readonly channelVersion: number;
  readonly readyType: string;
  readonly offerEvent: string;
  readonly agentFrameEvent: string;
}

/**
 * Runs in every document of a page before its scripts and before every content script (an init
 * script). Records the type of every frame the agent sends on the private page channel, keeps
 * every `agent.ready` frame whole, and remembers the document's original `fetch` and
 * `XMLHttpRequest.prototype.open` — captured before any `agent.config` can have armed the agent,
 * since the agent is dormant at `document_start` — so a later probe can tell "patched" from
 * "restored" by identity.
 *
 * The channel is a detached node the agent hands the bridge in a `MouseEvent` offer on `window`
 * (its `relatedTarget`), answering the bridge's one handshake request; every frame is then a
 * `CustomEvent` on that node whose `detail` is the frame's JSON text. A `window` listener that
 * exists before the agent hears that offer too, which is the residual the product documents rather
 * than a hole in it: only pre-agent code — this init script — can hold such a listener. The
 * recorder listens on the node beside the bridge and never calls `preventDefault()`, so custody of
 * every frame stays with the bridge exactly as without the recorder.
 */
function installAgentFrameRecorder(args: FrameRecorderArgs): void {
  if (window.top !== window) {
    return;
  }
  // Read as plain property values (never bound): the probe compares these by identity, and a bound
  // copy would never equal the live function.
  const windowScope = window as unknown as Record<string, unknown>;
  const xhrPrototype = XMLHttpRequest.prototype as unknown as Record<string, unknown>;
  const store = {
    types: [] as string[],
    ready: [] as unknown[],
    originalFetch: windowScope['fetch'],
    originalXhrOpen: xhrPrototype['open'],
  };
  Object.defineProperty(window, args.storeKey, { value: store, configurable: true });

  const recordFrame = (event: Event): void => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'string') {
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(detail);
    } catch {
      return;
    }
    if (typeof data !== 'object' || data === null) {
      return;
    }
    const frame = data as {
      readonly source?: unknown;
      readonly version?: unknown;
      readonly type?: unknown;
    };
    if (
      frame.source !== args.sourceTag ||
      frame.version !== args.channelVersion ||
      typeof frame.type !== 'string'
    ) {
      return;
    }
    store.types.push(frame.type);
    if (frame.type === args.readyType) {
      store.ready.push(data);
    }
  };

  // One node per document: the agent answers one request per document, so the first offer is the
  // only one; a later one (there is none in a healthy page) is ignored rather than double-counted.
  let channel: EventTarget | undefined;
  window.addEventListener(
    args.offerEvent,
    (event: Event) => {
      const node = (event as MouseEvent).relatedTarget;
      if (channel !== undefined || node === null || typeof node.addEventListener !== 'function') {
        return;
      }
      channel = node;
      node.addEventListener(args.agentFrameEvent, recordFrame);
    },
    { capture: true },
  );
}

/** Install the recorder for every later document of `page` (reloads and navigations included). */
async function recordAgentFrames(page: Page): Promise<void> {
  await page.addInitScript(installAgentFrameRecorder, {
    storeKey: FRAME_STORE_KEY,
    sourceTag: AGENT_SOURCE_TAG,
    channelVersion: PAGE_CHANNEL_VERSION,
    readyType: AGENT_READY_FRAME,
    offerEvent: PAGE_HANDSHAKE_OFFER_EVENT,
    agentFrameEvent: PAGE_AGENT_FRAME_EVENT,
  });
}

/** What the recorder saw in the page's current document. */
interface RecordedAgentFrames {
  /** The type of every agent frame, in posting order. */
  readonly types: readonly string[];
  /** Every `agent.ready` payload, validated against the extension's own channel guard. */
  readonly ready: readonly PageAgentReadyPayload[];
}

async function readAgentFrames(page: Page): Promise<RecordedAgentFrames> {
  const raw: unknown = await page.evaluate((key) => {
    const store = (window as unknown as Record<string, unknown>)[key];
    if (typeof store !== 'object' || store === null) {
      return null;
    }
    const { types, ready } = store as { types?: unknown; ready?: unknown };
    return { types, ready };
  }, FRAME_STORE_KEY);
  if (!isRecord(raw) || !Array.isArray(raw.types) || !Array.isArray(raw.ready)) {
    throw new Error(
      `The agent-frame recorder is not installed in ${page.url()}: install it with recordAgentFrames(page) before the document loads.`,
    );
  }
  const ready: PageAgentReadyPayload[] = [];
  for (const frame of raw.ready) {
    if (!isAgentChannelMessageOfType(frame, AGENT_READY_FRAME)) {
      throw new Error(`The agent posted a malformed agent.ready frame: ${JSON.stringify(frame)}`);
    }
    ready.push(frame.payload);
  }
  const types = raw.types.filter((type): type is string => typeof type === 'string');
  return { types, ready };
}

/**
 * The `agent.ready` report of the page's current document. The agent repeats the report (on
 * `bridge.ready`, and when it first detects React), so every repetition must describe the same
 * document and producer.
 */
async function currentDocumentReport(page: Page): Promise<PageAgentReadyPayload> {
  await expect
    .poll(async () => (await readAgentFrames(page)).ready.length, {
      message: `the page agent never announced agent.ready in ${page.url()}`,
      timeout: DEFAULT_WAIT_TIMEOUT_MS,
    })
    .toBeGreaterThan(0);
  const { ready } = await readAgentFrames(page);
  const [first] = ready;
  if (first === undefined) {
    throw new Error('agent.ready vanished from the recorder between two reads');
  }
  for (const report of ready) {
    expect(report.documentId, 'every agent.ready of one document names that document').toBe(
      first.documentId,
    );
    expect(report.producerId, 'every agent.ready of one document names its producer').toBe(
      first.producerId,
    );
  }
  return first;
}

/** The agent's page-visible state, read from the MAIN world. */
interface AgentGlobals {
  /** `window.__DEBUGGEN__` exists. */
  readonly helperInstalled: boolean;
  /** Its `span` is a plain callable — what a patched function's availability check tests. */
  readonly spanCallable: boolean;
  /** Its protocol `version`, when a number. */
  readonly helperVersion: number | undefined;
  /** An `agent.config` has been applied (the dormancy probe: absent until the first one). */
  readonly configPublished: boolean;
  /** The applied configuration's capture, or `null` when it arms none. */
  readonly configCaptureId: string | null;
  /** How many hook flags the applied configuration enabled. */
  readonly configEnabledCount: number;
  /** `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` exists. */
  readonly hookInstalled: boolean;
  /** How many React renderers registered with that hook. */
  readonly rendererCount: number;
  /** `window.fetch` is the document's original function (identity when the recorder saw it, else native code). */
  readonly fetchPristine: boolean;
  /** `XMLHttpRequest.prototype.open` likewise. */
  readonly xhrOpenPristine: boolean;
}

async function readAgentGlobals(page: Page): Promise<AgentGlobals> {
  return page.evaluate((storeKey) => {
    const scope = window as unknown as Record<string, unknown>;
    const asRecord = (value: unknown): Record<string, unknown> | undefined =>
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
    const helper = asRecord(scope['__DEBUGGEN__']);
    const config = asRecord(helper?.['config']);
    const hook = asRecord(scope['__REACT_DEVTOOLS_GLOBAL_HOOK__']);
    const renderers = hook?.['renderers'];
    const store = asRecord(scope[storeKey]);
    const isNative = (fn: unknown): boolean =>
      typeof fn === 'function' && Function.prototype.toString.call(fn).includes('[native code]');
    const pristine = (current: unknown, original: unknown): boolean =>
      store === undefined ? isNative(current) : current === original;
    const version = helper?.['version'];
    const captureId = config?.['captureId'];
    const enabled = config?.['enabled'];
    return {
      helperInstalled: helper !== undefined,
      spanCallable: typeof helper?.['span'] === 'function',
      helperVersion: typeof version === 'number' ? version : undefined,
      configPublished: config !== undefined,
      configCaptureId: typeof captureId === 'string' ? captureId : null,
      configEnabledCount: Array.isArray(enabled) ? enabled.length : 0,
      hookInstalled: hook !== undefined,
      rendererCount: renderers instanceof Map ? renderers.size : 0,
      // Plain property reads (never bound), so the identity comparison sees the live functions.
      fetchPristine: pristine(scope['fetch'], store?.['originalFetch']),
      xhrOpenPristine: pristine(
        (XMLHttpRequest.prototype as unknown as Record<string, unknown>)['open'],
        store?.['originalXhrOpen'],
      ),
    };
  }, FRAME_STORE_KEY);
}

/**
 * Assert the agent is installed in the page's MAIN world and React registered with the hook it put
 * in place — React registers only with a hook that exists when React initialises, so a registered
 * renderer beside the agent's helper is the page-side proof of a `document_start` install.
 */
function expectAgentBeforeReact(globals: AgentGlobals): void {
  expect(globals.helperInstalled, 'window.__DEBUGGEN__ is installed').toBe(true);
  expect(globals.spanCallable, 'window.__DEBUGGEN__.span is callable').toBe(true);
  expect(globals.helperVersion, 'window.__DEBUGGEN__.version is a number').toEqual(
    expect.any(Number),
  );
  expect(globals.hookInstalled, 'the React DevTools hook is installed').toBe(true);
  expect(
    globals.rendererCount,
    'React registered a renderer with the hook, which it does only when the hook predates it',
  ).toBeGreaterThan(0);
}

/**
 * Whether the published configuration names only what a dormant agent may name: nothing at all, or
 * — once a capture has stopped — the capture it just left. The dormancy instruction still carries
 * that capture's id (the protocol's `agent.config` requires one, "an agent returning to dormant
 * still knows which capture it is leaving"), and the agent publishes the id it was told, so a
 * named capture with every hook off is dormant, not armed.
 */
function namesOnlyLeftCapture(globals: AgentGlobals, leftCaptureId: string | undefined): boolean {
  return (
    globals.configCaptureId === null ||
    (leftCaptureId !== undefined && globals.configCaptureId === leftCaptureId)
  );
}

/**
 * Assert the agent is dormant: nothing enabled, both transports untouched, and no capture named
 * except `leftCaptureId`, the capture it has just left (none for a page that never captured).
 */
function expectAgentDormant(globals: AgentGlobals, leftCaptureId?: string): void {
  expect(
    namesOnlyLeftCapture(globals, leftCaptureId),
    `the page names no capture${leftCaptureId === undefined ? '' : ` other than ${leftCaptureId}, the one it left`} (it names ${String(globals.configCaptureId)})`,
  ).toBe(true);
  expect(globals.configEnabledCount, 'no hook flag is enabled in the page').toBe(0);
  expect(globals.fetchPristine, 'window.fetch is the original function').toBe(true);
  expect(globals.xhrOpenPristine, 'XMLHttpRequest.prototype.open is the original function').toBe(
    true,
  );
}

/**
 * Wait until the page's agent is armed — a capture named in `window.__DEBUGGEN__.config` and the
 * fetch patch in place — for `expectedCaptureId` when given, and resolve with the armed capture.
 * A timeout here is the actionable "the capture never armed the page" failure: nothing that follows
 * could have been observed.
 */
async function waitForArmed(page: Page, expectedCaptureId?: string): Promise<string> {
  // Written from the poll's callback, so held in an object flow analysis does not narrow.
  const seen: { armed: string | null } = { armed: null };
  await expect
    .poll(
      async () => {
        const globals = await readAgentGlobals(page);
        seen.armed = globals.fetchPristine ? null : globals.configCaptureId;
        return (
          seen.armed !== null &&
          (expectedCaptureId === undefined || seen.armed === expectedCaptureId)
        );
      },
      {
        message: `the page agent was not armed${expectedCaptureId === undefined ? '' : ` for capture ${expectedCaptureId}`} (window.__DEBUGGEN__.config names no capture, or fetch is unpatched): the capture never reached this document`,
        timeout: AGENT_ARMING_TIMEOUT_MS,
      },
    )
    .toBe(true);
  if (seen.armed === null) {
    throw new Error('the page agent reported no armed capture');
  }
  return seen.armed;
}

/**
 * Wait until the page's agent is back to dormant after leaving `leftCaptureId` — hooks disabled,
 * not idled (docs/ARCHITECTURE.md, section 7.6): no flag enabled, `fetch`/XHR restored, no other
 * capture named.
 */
async function waitForDormant(page: Page, leftCaptureId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const globals = await readAgentGlobals(page);
        return (
          namesOnlyLeftCapture(globals, leftCaptureId) &&
          globals.configEnabledCount === 0 &&
          globals.fetchPristine &&
          globals.xhrOpenPristine
        );
      },
      {
        message: `the page agent did not return to dormant after capture ${leftCaptureId} (hooks still enabled, or fetch/XHR not restored)`,
        timeout: AGENT_ARMING_TIMEOUT_MS,
      },
    )
    .toBe(true);
}

// ---------------------------------------------------------------------------
// The service: sessions, bindings and stored evidence
// ---------------------------------------------------------------------------

/**
 * Create the session, open the panel inspecting `page` (which binds its tab), and wait for the
 * binding — both the worker's persisted record and the service's `session.bound` — and for the
 * session to reach `ready`, observed through pushed `session.updated` frames, never slept.
 */
async function bindReadySession(input: {
  readonly page: Page;
  readonly sessions: SessionHelper;
  readonly openPanelPage: (options?: OpenPanelOptions) => Promise<PanelHandle>;
  readonly editorClient: EditorClient;
}): Promise<{ readonly session: SessionRecord; readonly panel: PanelHandle }> {
  const created = await input.sessions.create(QUESTION);
  const panel = await input.openPanelPage({ inspect: input.page });
  const tabId = panel.tabId;
  if (tabId === undefined) {
    throw new Error(
      'The panel page inspects no tab; openPanelPage must install the DevTools stub.',
    );
  }
  await panel.waitForConnected();
  const binding = await panel.waitForBound(created.id);
  expect(binding.tabId).toBe(tabId);
  expect(binding.origin).toBe(new URL(input.page.url()).origin);
  const bound = await input.editorClient.waitFor(
    'session.bound',
    (message) => message.payload.sessionId === created.id && message.payload.tabId === tabId,
  );
  expect(new URL(bound.payload.url).origin).toBe(binding.origin);
  const session = await input.sessions.waitForReady(created.id, {
    timeoutMs: SESSION_READY_TIMEOUT_MS,
  });
  expect(session.boundTab?.tabId, 'the session record names the bound tab').toBe(tabId);
  return { session, panel };
}

/**
 * Every stored event of the session's current capture, read through `POST /sessions/:id/panel-data`
 * one maximal page at a time, following `nextOffset` to the end and checking it against `total`.
 */
async function readCaptureEvents(
  service: ServiceHandle,
  sessionId: string,
): Promise<readonly TelemetryEvent[]> {
  const collected: TelemetryEvent[] = [];
  let offset = 0;
  for (;;) {
    const page = await service.queryPanelData(sessionId, {
      source: 'events',
      limit: DATA_QUERY_MAX_LIMIT,
      offset,
    });
    collected.push(...page.events);
    if (page.nextOffset === null) {
      expect(collected, 'the paged events add up to the reported total').toHaveLength(page.total);
      return collected;
    }
    expect(page.nextOffset, 'nextOffset advances').toBeGreaterThan(offset);
    offset = page.nextOffset;
  }
}

/** The correlated tree of one trace, as the service's correlator builds it. */
async function readTrace(
  service: ServiceHandle,
  sessionId: string,
  traceId: string,
): Promise<TraceTree> {
  const result = await service.queryPanelData(sessionId, { source: 'trace', filter: { traceId } });
  if (result.trace === null) {
    throw new Error(
      `The service answered no trace tree for trace ${traceId} of session ${sessionId}.`,
    );
  }
  expect(result.trace.traceId).toBe(traceId);
  return result.trace;
}

// ---------------------------------------------------------------------------
// Evidence: the shape of one click's trace
// ---------------------------------------------------------------------------

/** The spine of one click, as found in the stored events. */
interface ClickTrace {
  readonly traceId: string;
  /** The `interaction` — the trace's root. */
  readonly interaction: TelemetryEvent;
  /** The commit of the click's synchronous state update, a child of the interaction. */
  readonly clickCommit: TelemetryEvent;
  /** The request of the fixture route, a child of the interaction. */
  readonly request: TelemetryEvent;
  /** The commit that followed the response, a child of the settled request. */
  readonly continuationCommit: TelemetryEvent;
  /** The widget's render inside that commit. */
  readonly continuationRender: TelemetryEvent;
  /** Every stored event of the trace. */
  readonly traceEvents: readonly TelemetryEvent[];
}

/**
 * Find and assert the trace of the one click made in `producerId`'s document: exactly one
 * interaction, and under its `traceId` the fixture route's request as its direct child, the click's
 * own commit, and the post-response commit attributed to the settled request by async-continuation
 * lineage, each with the widget's render inside it (docs/ARCHITECTURE.md, section 6 "Trace
 * correlation").
 */
function expectClickTrace(
  events: readonly TelemetryEvent[],
  expectation: {
    readonly contract: FixtureContract;
    readonly baseUrl: string;
    readonly producerId: string;
  },
): ClickTrace {
  const { contract, baseUrl, producerId } = expectation;
  const interaction = onlyOne(
    events.filter((event) => event.kind === KIND_INTERACTION && event.producerId === producerId),
    `interaction from the clicked document (captured: ${describeKinds(events)})`,
  );
  const traceId = interaction.traceId;
  expect(traceId, 'the trace id is 32 lowercase hex characters').toMatch(/^[0-9a-f]{32}$/);
  expect(traceId, 'the trace id is not the invalid all-zero id').not.toMatch(/^0+$/);
  expect(interaction.spanId, 'the span id is 16 lowercase hex characters').toMatch(
    /^[0-9a-f]{16}$/,
  );
  expect(interaction.parentSpanId, 'the interaction is the root of its trace').toBeUndefined();
  expect(interaction.tier).toBe(TIER_BROWSER);

  const traceEvents = events.filter((event) => event.traceId === traceId);
  const kinds = new Set<string>(traceEvents.map((event) => event.kind));
  // The React work arrives as both of the package's render kinds: the commit and the fibers it
  // rendered.
  for (const kind of [KIND_INTERACTION, KIND_FETCH, ...RENDER_KINDS]) {
    expect([...kinds], `a ${kind} event under trace ${traceId}`).toContain(kind);
  }

  const request = onlyOne(
    traceEvents.filter(
      (event) => event.kind === KIND_FETCH && requestPathOf(event, baseUrl) === contract.pingPath,
    ),
    `fetch of ${contract.pingPath} under trace ${traceId}`,
  );
  expect(request.parentSpanId, 'the request is a direct child of the interaction').toBe(
    interaction.spanId,
  );
  expect(request.tier).toBe(TIER_BROWSER);
  expect(request.producerId).toBe(producerId);
  expect(request.attributes[FETCH_METHOD_KEY]).toBe('GET');
  expect(request.attributes[FETCH_STATUS_KEY]).toBe(200);
  expect(request.attributes[FETCH_SAME_ORIGIN_KEY], 'the request is same-origin').toBe(true);
  expect(
    request.attributes[FETCH_TRACEPARENT_KEY],
    'traceparent was injected into the request, joining it to the server',
  ).toBe(true);
  expect(request.status, 'a 200 response is not an error span').not.toBe('error');
  expect(
    request.duration,
    `the request lasted at least ${String(FETCH_DURATION_FLOOR_RATIO * 100)} % of the route's ${String(contract.routeDelayMs)} ms delay`,
  ).toBeGreaterThanOrEqual(contract.routeDelayMs * FETCH_DURATION_FLOOR_RATIO);

  const commits = traceEvents.filter((event) => event.kind === KIND_COMMIT);
  const widgetRenders = traceEvents.filter(
    (event) =>
      event.kind === KIND_RENDER && event.attributes[RENDER_COMPONENT_KEY] === contract.widgetName,
  );
  expect(
    widgetRenders.length,
    `${contract.widgetName} rendered under trace ${traceId} (captured: ${describeKinds(traceEvents)})`,
  ).toBeGreaterThan(0);
  for (const render of widgetRenders) {
    expect(RENDER_PHASES, `render ${render.spanId} carries a known phase`).toContain(
      render.attributes[RENDER_PHASE_KEY],
    );
    expect(Number.isFinite(render.duration), 'a render duration is a finite number').toBe(true);
    expect(render.duration).toBeGreaterThanOrEqual(0);
    expect(render.attributes[RENDER_COUNT_KEY], 'renderCount is a positive integer').toEqual(
      expect.any(Number),
    );
    expect(Number(render.attributes[RENDER_COUNT_KEY])).toBeGreaterThanOrEqual(1);
    expect(
      commits.some((commit) => commit.spanId === render.parentSpanId),
      `render ${render.spanId} nests inside a commit of the same trace`,
    ).toBe(true);
  }

  const rendersInside = (commit: TelemetryEvent): boolean =>
    widgetRenders.some((render) => render.parentSpanId === commit.spanId);

  const clickCommit = findRequired(
    commits,
    (commit) => commit.parentSpanId === interaction.spanId && rendersInside(commit),
    `a commit under the interaction rendering ${contract.widgetName} (the click's synchronous update)`,
  );
  const continuationCommit = findRequired(
    commits,
    (commit) => commit.parentSpanId === request.spanId && rendersInside(commit),
    `a commit under the settled ${contract.pingPath} request rendering ${contract.widgetName} (the post-response update)`,
  );
  const commitLineage = lineageOf(continuationCommit);
  expect(commitLineage?.value, 'the post-response commit is attributed by continuation').toBe(
    LINEAGE_ASYNC_CONTINUATION,
  );
  expect(commitLineage?.ambiguous, 'one request settled, so the attribution is certain').toBe(
    false,
  );
  const continuationRender = findRequired(
    widgetRenders,
    (render) => render.parentSpanId === continuationCommit.spanId,
    `a ${contract.widgetName} render inside the post-response commit`,
  );
  expect(lineageOf(continuationRender)?.value).toBe(LINEAGE_ASYNC_CONTINUATION);
  expect(continuationRender.attributes[RENDER_PHASE_KEY]).toBe(
    'update' satisfies (typeof RENDER_PHASES)[number],
  );

  return {
    traceId,
    interaction,
    clickCommit,
    request,
    continuationCommit,
    continuationRender,
    traceEvents,
  };
}

/** The same spine, as the service's correlator reports it: the click → request → response → commit tree. */
function expectTraceTree(tree: TraceTree, trace: ClickTrace): void {
  const nodeOf = (event: TelemetryEvent, what: string): TraceNode => {
    const node = findNodeBySpanId(tree, event.spanId);
    if (node === undefined) {
      throw new Error(
        `the correlated tree of trace ${trace.traceId} holds no node for the ${what}`,
      );
    }
    expect(node.orphaned, `the ${what} is attached where its parent is, not re-attached`).toBe(
      false,
    );
    return node;
  };
  const childSpanIds = (node: TraceNode): readonly string[] =>
    node.children.map((child) => child.event.spanId);

  expect(
    tree.roots.map((root) => root.event.spanId),
    'the interaction is a root of the correlated tree',
  ).toContain(trace.interaction.spanId);
  if (tree.primaryRootSpanId !== undefined) {
    expect(tree.primaryRootSpanId, 'the interaction is the primary root').toBe(
      trace.interaction.spanId,
    );
  }
  const interactionNode = nodeOf(trace.interaction, 'interaction');
  expect(childSpanIds(interactionNode)).toEqual(
    expect.arrayContaining([trace.request.spanId, trace.clickCommit.spanId]),
  );
  const requestNode = nodeOf(trace.request, 'request');
  expect(childSpanIds(requestNode)).toContain(trace.continuationCommit.spanId);
  const commitNode = nodeOf(trace.continuationCommit, 'post-response commit');
  expect(commitNode.lineage?.value).toBe(LINEAGE_ASYNC_CONTINUATION);
  expect(childSpanIds(commitNode)).toContain(trace.continuationRender.spanId);
  expect(tree.kinds).toEqual(expect.arrayContaining([KIND_INTERACTION, KIND_FETCH, KIND_RENDER]));
}

// ---------------------------------------------------------------------------
// Evidence: time, ordering, sequencing and attribution
// ---------------------------------------------------------------------------

/**
 * Assert every stored event belongs to this session and capture, carries the core fields, and
 * obeys the product's time base (docs/ARCHITECTURE.md, section 5.2 "Time base"): `startTime` in
 * epoch milliseconds inside the test's own wall-clock window, `duration` non-negative
 * milliseconds, and a unique `(producerId, seq)`.
 */
function expectAttributedAndTimed(
  events: readonly TelemetryEvent[],
  scope: { readonly sessionId: string; readonly captureId: string; readonly startedAt: number },
): void {
  const upper = Date.now() + CLOCK_WINDOW_MS;
  const lower = scope.startedAt - CLOCK_WINDOW_MS;
  const ids = new Set<string>();
  const sequence = new Set<string>();
  for (const event of events) {
    expect(event.sessionId, `event ${event.id} belongs to this session`).toBe(scope.sessionId);
    expect(event.captureId, `event ${event.id} belongs to this capture`).toBe(scope.captureId);
    expect(event.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(event.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(event.producerId, `event ${event.id} names its producer`).not.toBe('');
    expect(Number.isInteger(event.seq) && event.seq >= 0, `event ${event.id} has a seq`).toBe(true);
    expect(
      event.startTime,
      `event ${event.id} starts after the epoch floor`,
    ).toBeGreaterThanOrEqual(MIN_EPOCH_MS);
    expect(event.startTime).toBeLessThanOrEqual(MAX_EPOCH_MS);
    expect(
      event.startTime,
      `event ${event.id} (${event.kind}) starts inside the test's wall-clock window`,
    ).toBeGreaterThanOrEqual(lower);
    expect(event.startTime).toBeLessThanOrEqual(upper);
    expect(
      Number.isFinite(event.duration) && event.duration >= 0,
      `event ${event.id} duration`,
    ).toBe(true);
    expect(ids.has(event.id), `event id ${event.id} is unique`).toBe(false);
    ids.add(event.id);
    const key = `${event.producerId}#${String(event.seq)}`;
    expect(sequence.has(key), `(producerId, seq) ${key} is unique`).toBe(false);
    sequence.add(key);
  }
}

/**
 * Within a trace, a parent does not start after its child — checked on the browser tier's causal
 * edges (interaction, request, commit, render, state), whose ends all come from the page's own
 * `performance` clock. Observed performance entries are excluded: their `startTime` is the entry's
 * own, which can precede the gesture they were attributed to.
 */
function expectParentsPrecedeChildren(traceEvents: readonly TelemetryEvent[]): void {
  const bySpan = new Map(traceEvents.map((event) => [event.spanId, event] as const));
  let edges = 0;
  for (const child of traceEvents) {
    if (child.tier !== TIER_BROWSER || !CAUSAL_BROWSER_KINDS.has(child.kind)) {
      continue;
    }
    const parent = child.parentSpanId === undefined ? undefined : bySpan.get(child.parentSpanId);
    if (parent === undefined || parent.tier !== TIER_BROWSER) {
      continue;
    }
    edges += 1;
    expect(
      parent.startTime,
      `${parent.kind} ${parent.spanId} does not start after its child ${child.kind} ${child.spanId}`,
    ).toBeLessThanOrEqual(child.startTime + ORDERING_TOLERANCE_MS);
  }
  expect(edges, 'the trace has causal browser edges to order').toBeGreaterThan(0);
}

/**
 * Assert the summary `capture.stop` answered describes this capture: its id, the click traces and
 * the documents that produced them, and one interaction per click.
 */
function expectCaptureSummary(
  summary: CaptureSummary,
  expected: {
    readonly captureId: string;
    readonly traceIds: readonly string[];
    readonly producerIds: readonly string[];
    readonly interactions: number;
  },
): void {
  expect(summary.captureId, 'the summary describes this capture').toBe(expected.captureId);
  expect(summary.traceIds).toEqual(expect.arrayContaining([...expected.traceIds]));
  expect(summary.producerIds, 'the summary names every document that produced evidence').toEqual(
    expect.arrayContaining([...expected.producerIds]),
  );
  expect(summary.kindCounts[KIND_INTERACTION], 'one interaction per click').toBe(
    expected.interactions,
  );
  expect(summary.eventCount).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Evidence: privacy at capture level (docs/SECURITY.md, section 3 "Redaction")
// ---------------------------------------------------------------------------

/** How deep the attribute walk descends; the redactor bounds attribute depth well inside this. */
const MAX_ATTRIBUTE_WALK_DEPTH = 16;

/** Keys folded the way the redactor folds them: lower-cased, separators removed. */
function foldAttributeKey(key: string): string {
  return key.toLowerCase().replace(/[\s._-]/g, '');
}

const DROPPED_KEY_FOLDS: ReadonlySet<string> = new Set(
  DROPPED_ATTRIBUTE_KEYS.map(foldAttributeKey),
);
const STACK_KEYS: ReadonlySet<string> = new Set<string>(STACK_ATTRIBUTE_KEYS);

/** One attribute value at any depth, with the property name it sits under. */
interface AttributeEntry {
  readonly key: string;
  readonly path: string;
  readonly value: unknown;
}

/** Every value of an attribute bag, at every depth; array items keep their property's name. */
function attributeEntries(
  attributes: Readonly<Record<string, unknown>>,
): readonly AttributeEntry[] {
  const entries: AttributeEntry[] = [];
  const visit = (key: string, value: unknown, path: string, depth: number): void => {
    entries.push({ key, path, value });
    if (depth >= MAX_ATTRIBUTE_WALK_DEPTH) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item: unknown, index) => {
        visit(key, item, `${path}[${String(index)}]`, depth + 1);
      });
    } else if (isRecord(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        visit(childKey, child, `${path}.${childKey}`, depth + 1);
      }
    }
  };
  for (const [key, value] of Object.entries(attributes)) {
    visit(key, value, key, 0);
  }
  return entries;
}

/**
 * Assert the stored capture honours the privacy model, judged by the product's own rules: every
 * event is a fixed point of `redactEvent`; no body-, row- or parameter-bag key survives at any
 * depth; a denied header's value is the redaction marker; no value matches a deny-list pattern;
 * every URL and stack is already masked; the route's response body is nowhere; and the values
 * planted in the page URL and in a cookie are nowhere either.
 */
function expectCapturePrivacy(
  events: readonly TelemetryEvent[],
  probes: { readonly planted: readonly string[]; readonly rawResponseBody: string },
): void {
  let probeUrls = 0;
  for (const event of events) {
    expect(redactEvent(event), `event ${event.id} (${event.kind}) is already redacted`).toEqual(
      event,
    );
    const serialized = JSON.stringify(event);
    for (const planted of probes.planted) {
      expect(serialized, `a planted value reached event ${event.id} (${event.kind})`).not.toContain(
        planted,
      );
    }
    for (const entry of attributeEntries(event.attributes)) {
      const where = `${event.kind} ${event.id} attribute ${entry.path}`;
      expect(
        DROPPED_KEY_FOLDS.has(foldAttributeKey(entry.key)),
        `${where} is a body-like key`,
      ).toBe(false);
      if (isHeaderAttributeKey(entry.key)) {
        const header = headerNameFromAttributeKey(entry.key) ?? entry.key;
        if (isDeniedHeaderName(header)) {
          const values: readonly unknown[] = Array.isArray(entry.value)
            ? entry.value
            : [entry.value];
          for (const value of values) {
            expect(value, `${where} carries a denied header's value`).toBe(REDACTION_MARKER);
          }
        }
      }
      if (typeof entry.value !== 'string') {
        continue;
      }
      expect(findDeniedRules(entry.value), `${where} matches a deny-list rule`).toEqual([]);
      expect(entry.value, `${where} carries the response body`).not.toContain(
        probes.rawResponseBody,
      );
      if (isUrlAttributeKey(entry.key)) {
        expect(redactUrl(entry.value), `${where} is a URL with query values`).toBe(entry.value);
        if (entry.value.includes(`${PROBE_QUERY_KEY}=`)) {
          probeUrls += 1;
        }
      }
      if (STACK_KEYS.has(entry.key)) {
        expect(redactStackUrls(entry.value), `${where} is a stack with query values`).toBe(
          entry.value,
        );
      }
    }
  }
  if (events.some((event) => event.kind === KIND_NAVIGATION)) {
    expect(
      probeUrls,
      'the document URL was stored with its query key kept and its value masked',
    ).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// The panel's live tail (apps/chrome-extension/src/panel/components/LiveTail.tsx)
// ---------------------------------------------------------------------------

/**
 * How many events the live tail's grid holds: its exact `aria-rowcount` minus the header row
 * (`DataTable`: `1 + rows.length + expandedCount`), or zero while it shows no grid yet.
 */
async function liveTailRowCount(panel: PanelHandle): Promise<number> {
  const grid = panel.liveTail.getByRole('grid');
  if ((await grid.count()) === 0) {
    return 0;
  }
  const raw = await grid.first().getAttribute('aria-rowcount');
  const total = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(total) && total > 1 ? total - 1 : 0;
}

/** Assert a visible live-tail row whose kind cell reads one of `kinds`. */
async function expectLiveTailShowsKind(
  panel: PanelHandle,
  kinds: readonly TelemetryKind[],
): Promise<void> {
  const pattern = new RegExp(`^\\s*(?:${kinds.map(escapeRegExp).join('|')})\\s*$`);
  await expect(
    panel.liveTail.getByRole('gridcell').filter({ hasText: pattern }).first(),
    `a live-tail row of kind ${kinds.join(' or ')}`,
  ).toBeVisible({ timeout: DEFAULT_WAIT_TIMEOUT_MS });
}

/**
 * Assert the live tail shows `event`: narrow the tail with its own search field to the event's
 * kind, then find the row carrying both that kind and the event's stored name — the product's own
 * text, not a restated one.
 */
async function expectLiveTailShowsEvent(panel: PanelHandle, event: TelemetryEvent): Promise<void> {
  const search = panel.liveTail.getByRole('textbox');
  await expect(search, 'the live tail offers its search field').toHaveCount(1);
  await search.fill(event.kind);
  try {
    const kindCell = panel.page.getByRole('gridcell', { name: event.kind, exact: true });
    await expect(
      panel.liveTail
        .getByRole('row')
        .filter({ has: kindCell })
        .filter({ hasText: event.name })
        .first(),
      `a live-tail row for the ${event.kind} event "${event.name}"`,
    ).toBeVisible({ timeout: DEFAULT_WAIT_TIMEOUT_MS });
  } finally {
    await search.fill('');
  }
}

// ---------------------------------------------------------------------------
// Waiting on the service
// ---------------------------------------------------------------------------

/** Poll the capture's stored events until one matches, and return it. */
async function waitForStoredEvent(
  service: ServiceHandle,
  sessionId: string,
  predicate: (event: TelemetryEvent) => boolean,
  what: string,
): Promise<TelemetryEvent> {
  // Written from the poll's callback, so held in an object flow analysis does not narrow.
  const latest: { found: TelemetryEvent | undefined; stored: readonly TelemetryEvent[] } = {
    found: undefined,
    stored: [],
  };
  await expect
    .poll(
      async () => {
        latest.stored = await readCaptureEvents(service, sessionId);
        latest.found = latest.stored.find(predicate);
        return latest.found !== undefined;
      },
      {
        message: `the capture never stored ${what}`,
        timeout: DEFAULT_WAIT_TIMEOUT_MS,
      },
    )
    .toBe(true);
  if (latest.found === undefined) {
    throw new Error(`the capture never stored ${what} (stored: ${describeKinds(latest.stored)})`);
  }
  return latest.found;
}

/**
 * The service's request that the developer reload the bound tab: the `running` progress row of the
 * instrument stage the readiness gate emits when the tab's current document has no agent report
 * (`apps/local-service/src/instrumentation/readiness.ts`). Its wording is owned by that module,
 * which this directory cannot import, so the row is recognised by stage, status and the one verb
 * the request must contain.
 */
const RELOAD_REQUEST_VERB = /\breload\b/i;

async function waitForReloadRequest(
  editor: EditorClient,
  sessionId: string,
): Promise<{ readonly message: string; readonly receivedAt: number }> {
  const row = await editor.waitFor(
    'session.progress',
    (message) =>
      message.payload.sessionId === sessionId &&
      message.payload.stage === INSTRUMENT_STAGE &&
      message.payload.status === RUNNING_STATUS &&
      RELOAD_REQUEST_VERB.test(message.payload.message),
    { timeoutMs: SESSION_READY_TIMEOUT_MS },
  );
  return { message: row.payload.message, receivedAt: row.receivedAt };
}

// ---------------------------------------------------------------------------
// The browser: the extension's enabled state and a page's document loads
// ---------------------------------------------------------------------------

/** The browser's own extension management page, which carries `chrome.management`. */
const EXTENSIONS_PAGE_URL = 'chrome://extensions/';

/** The extension's enabled state, driven through `chrome.management` on `chrome://extensions`. */
interface ExtensionSwitch {
  /** Disable the extension and wait until its worker is gone. */
  disable(): Promise<void>;
  /** Enable it and resolve with its new worker. */
  enable(): Promise<Worker>;
  close(): Promise<void>;
}

async function openExtensionSwitch(
  context: BrowserContext,
  extensionId: string,
): Promise<ExtensionSwitch> {
  const manager = await context.newPage();
  await manager.goto(EXTENSIONS_PAGE_URL);
  const workersOfExtension = (): readonly Worker[] =>
    context.serviceWorkers().filter((worker) => new URL(worker.url()).host === extensionId);
  const setEnabled = async (enabled: boolean): Promise<void> => {
    await manager.evaluate(
      async ({ id, on }) => {
        const management = (
          globalThis as unknown as {
            chrome?: { management?: { setEnabled?(id: string, enabled: boolean): Promise<void> } };
          }
        ).chrome?.management;
        if (management?.setEnabled === undefined) {
          throw new Error('chrome.management.setEnabled is not available on chrome://extensions');
        }
        await management.setEnabled(id, on);
      },
      { id: extensionId, on: enabled },
    );
  };
  return {
    async disable() {
      await setEnabled(false);
      await expect
        .poll(() => workersOfExtension().length, {
          message: 'the disabled extension still runs a service worker',
          timeout: WORKER_READY_TIMEOUT_MS,
        })
        .toBe(0);
    },
    async enable() {
      const registered = context.waitForEvent('serviceworker', {
        predicate: (worker) => new URL(worker.url()).host === extensionId,
        timeout: WORKER_READY_TIMEOUT_MS,
      });
      await setEnabled(true);
      return registered;
    },
    async close() {
      await manager.close();
    },
  };
}

/** The worker global the reload recorder writes to — spec-owned, disjoint from every product global. */
const TAB_RELOAD_STORE_KEY = '__telemetryCaptureSpecTabReloads';

/** Whether {@link installTabReloadRecorder} wrapped `chrome.tabs.reload`, and why not when it did not. */
type TabReloadRecorderInstall =
  { readonly installed: true } | { readonly installed: false; readonly reason: string };

/**
 * Runs in the extension's MV3 worker (a `worker.evaluate` callback, so it names nothing outside
 * itself). Wraps `chrome.tabs.reload` in place: the worker hands the `chrome.tabs` namespace
 * itself to its agent control, which looks `reload` up on it at call time, so the wrapper sees
 * every reload the worker asks Chrome for. Each call records the tab id it names (`null` for a call
 * naming none, which would reload whichever tab is active) and is then performed by the original
 * function with its own receiver and arguments. The recorder keeps both functions, so it can be
 * verified and removed; installing it into a worker that already carries it keeps the first one.
 */
function installTabReloadRecorder(storeKey: string): TabReloadRecorderInstall {
  const scope = globalThis as unknown as Record<string, unknown> & {
    readonly chrome?: { readonly tabs?: Record<string, unknown> };
  };
  const tabs = scope.chrome?.tabs;
  if (tabs === undefined) {
    return { installed: false, reason: 'chrome.tabs is not available in this worker' };
  }
  const existing = scope[storeKey];
  if (
    typeof existing === 'object' &&
    existing !== null &&
    tabs['reload'] === (existing as { readonly wrapper?: unknown }).wrapper
  ) {
    return { installed: true };
  }
  const current = tabs['reload'];
  if (typeof current !== 'function') {
    return {
      installed: false,
      reason: `chrome.tabs.reload is a ${typeof current}, not a function`,
    };
  }
  const original = current as (this: unknown, ...args: unknown[]) => unknown;
  const calls: (number | null)[] = [];
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    const [tabId] = args;
    calls.push(typeof tabId === 'number' ? tabId : null);
    return original.apply(this, args);
  };
  const failures: string[] = [];
  try {
    tabs['reload'] = wrapper;
  } catch (error) {
    failures.push(`assignment threw ${String(error)}`);
  }
  if (tabs['reload'] !== wrapper) {
    try {
      Object.defineProperty(tabs, 'reload', {
        value: wrapper,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch (error) {
      failures.push(`Object.defineProperty threw ${String(error)}`);
    }
  }
  if (tabs['reload'] !== wrapper) {
    return {
      installed: false,
      reason: `chrome.tabs.reload still holds the original function (${failures.length === 0 ? 'the assignment and Object.defineProperty were both ignored' : failures.join('; ')})`,
    };
  }
  Object.defineProperty(scope, storeKey, {
    value: { calls, wrapper, original },
    configurable: true,
  });
  return { installed: true };
}

/** The reloads the extension's worker asked Chrome for, observed at `chrome.tabs.reload`. */
interface TabReloadRecorder {
  /** The tab id of every `chrome.tabs.reload` call since the recorder was installed, in call order. */
  calls(): Promise<readonly (number | null)[]>;
  /** Put the original `chrome.tabs.reload` back and drop the record; a no-op once the worker is gone. */
  dispose(): Promise<void>;
}

/**
 * Install the reload recorder in `worker` — the extension's live MV3 worker — and return its
 * handle. The consented reload is the worker's to perform, so it is observed where it happens: a
 * recorder that cannot be installed fails the test, which never falls back to reloading the page
 * itself. A worker that stops takes its recorder with it, so reading one from a stopped worker
 * fails too, rather than reporting "no reload" for reloads a restarted worker made unobserved.
 */
async function recordTabReloads(worker: Worker): Promise<TabReloadRecorder> {
  let closed = false;
  worker.once('close', () => {
    closed = true;
  });
  const install = await worker.evaluate(installTabReloadRecorder, TAB_RELOAD_STORE_KEY);
  if (!install.installed) {
    throw new Error(
      `chrome.tabs.reload could not be wrapped in the extension's worker ${worker.url()}: ${install.reason}. The consented reload cannot be observed where the worker performs it, and this test does not substitute a reload of its own.`,
    );
  }
  return {
    async calls() {
      if (closed) {
        throw new Error(
          `The extension's worker ${worker.url()} stopped after its chrome.tabs.reload recorder was installed; a restarted worker carries no recorder, so its reloads cannot be counted.`,
        );
      }
      const raw: unknown = await worker.evaluate((key) => {
        const scope = globalThis as unknown as Record<string, unknown> & {
          readonly chrome?: { readonly tabs?: Record<string, unknown> };
        };
        const store = scope[key];
        if (typeof store !== 'object' || store === null) {
          return null;
        }
        const { calls, wrapper } = store as {
          readonly calls?: unknown;
          readonly wrapper?: unknown;
        };
        return { calls, wrapped: scope.chrome?.tabs?.['reload'] === wrapper };
      }, TAB_RELOAD_STORE_KEY);
      if (!isRecord(raw) || !Array.isArray(raw.calls)) {
        throw new Error(
          `The chrome.tabs.reload recorder is not installed in the extension's worker ${worker.url()}: install it with recordTabReloads(worker) before anything can reload.`,
        );
      }
      if (raw.wrapped !== true) {
        throw new Error(
          'chrome.tabs.reload was replaced after the recorder wrapped it, so a reload through the replacement would go unrecorded.',
        );
      }
      return raw.calls.map((call: unknown) => (typeof call === 'number' ? call : null));
    },
    async dispose() {
      if (closed) {
        return;
      }
      await worker.evaluate((key) => {
        const scope = globalThis as unknown as Record<string, unknown> & {
          readonly chrome?: { readonly tabs?: Record<string, unknown> };
        };
        const store = scope[key];
        const tabs = scope.chrome?.tabs;
        if (typeof store !== 'object' || store === null) {
          return;
        }
        const { wrapper, original } = store as {
          readonly wrapper?: unknown;
          readonly original?: unknown;
        };
        if (tabs !== undefined && tabs['reload'] === wrapper) {
          tabs['reload'] = original;
        }
        Reflect.deleteProperty(scope, key);
      }, TAB_RELOAD_STORE_KEY);
    },
  };
}

/** Counts of a page's real document loads: `load` events and main-frame navigation requests. */
interface DocumentLoadCounter {
  loads(): number;
  navigationRequests(): number;
  dispose(): void;
}

/**
 * Count document loads by their effects. `framenavigated` is deliberately not counted: the fixture
 * app's framework rewrites its history entry once a document loads, which the main frame reports
 * as a second, same-document navigation.
 */
function countDocumentLoads(page: Page): DocumentLoadCounter {
  let loads = 0;
  let navigationRequests = 0;
  const onLoad = (): void => {
    loads += 1;
  };
  const onRequest = (request: Request): void => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigationRequests += 1;
    }
  };
  page.on('load', onLoad);
  page.on('request', onRequest);
  return {
    loads: () => loads,
    navigationRequests: () => navigationRequests,
    dispose() {
      page.off('load', onLoad);
      page.off('request', onRequest);
    },
  };
}

/** The page global a pre-reload marker is written to — spec-owned; a new document starts without it. */
const DOCUMENT_MARKER_KEY = '__telemetryCaptureSpecMarker';

async function setDocumentMarker(page: Page, value: string): Promise<void> {
  await page.evaluate(
    ({ key, marker }) => {
      Object.defineProperty(window, key, { value: marker, configurable: true });
    },
    { key: DOCUMENT_MARKER_KEY, marker: value },
  );
}

async function readDocumentMarker(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const value = (window as unknown as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  }, DOCUMENT_MARKER_KEY);
}

// ---------------------------------------------------------------------------
// The element picker ("Pick element"): the page, the panel and the service
// ---------------------------------------------------------------------------

/**
 * The events one primary-button click dispatches to a page, in dispatch order — the platform's own
 * vocabulary (`DocumentEventMap`). An armed pick consumes each of them on `window` in the capture
 * phase, so none reaches the document; once the pick has ended, a click delivers every one.
 */
const CLICK_GESTURE_EVENT_TYPES = [
  'pointerdown',
  'mousedown',
  'pointerup',
  'mouseup',
  'click',
] as const satisfies readonly (keyof DocumentEventMap)[];

/** The page global the gesture recorder writes to — spec-owned, disjoint from every product global. */
const GESTURE_STORE_KEY = '__telemetryCaptureSpecGestures';

/** What the in-page gesture recorder is told; serialised into the page, so plain data only. */
interface GestureRecorderArgs {
  readonly storeKey: string;
  readonly types: readonly string[];
}

/**
 * Runs in the page's current document (a `page.evaluate` callback, so it names nothing outside
 * itself). Records the type of every trusted click-gesture event that reaches `document` in the
 * capture phase. `document` is the node after `window` on every event path, so an event the picker
 * consumed on `window` never reaches this listener, and every event the application's own listeners
 * could see does. It never consumes anything; installing it twice keeps the first recorder.
 */
function installGestureRecorder(args: GestureRecorderArgs): void {
  const scope = window as unknown as Record<string, unknown>;
  if (Array.isArray(scope[args.storeKey])) {
    return;
  }
  const seen: string[] = [];
  Object.defineProperty(window, args.storeKey, { value: seen, configurable: true });
  for (const type of args.types) {
    document.addEventListener(
      type,
      (event: Event) => {
        if (event.isTrusted) {
          seen.push(event.type);
        }
      },
      { capture: true },
    );
  }
}

/** What reached the application from the developer's clicks, observed in the page and on the wire. */
interface ApplicationClickObserver {
  /** The type of every trusted click-gesture event that reached the document, in order. */
  gestures(): Promise<readonly string[]>;
  /** How many requests of the fixture route the page has issued. */
  routeRequests(): number;
  dispose(): void;
}

/**
 * Observe what the application receives from clicks in `page`'s current document: the gesture
 * events that reach its document (an in-page recorder) and the requests of the fixture route it
 * issues (the browser's own `request` events). The widget's handler calls `fetch` synchronously in
 * its click handler, so a click that reached the application shows up on both.
 */
async function observeApplicationClicks(
  page: Page,
  contract: FixtureContract,
  baseUrl: string,
): Promise<ApplicationClickObserver> {
  await page.evaluate(installGestureRecorder, {
    storeKey: GESTURE_STORE_KEY,
    types: [...CLICK_GESTURE_EVENT_TYPES],
  });
  const origin = new URL(baseUrl).origin;
  let routeRequests = 0;
  const onRequest = (request: Request): void => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === contract.pingPath) {
      routeRequests += 1;
    }
  };
  page.on('request', onRequest);
  return {
    async gestures() {
      const raw: unknown = await page.evaluate((key) => {
        const seen = (window as unknown as Record<string, unknown>)[key];
        // The evaluation result is serialised, so the live record is handed back as a copy.
        return Array.isArray(seen) ? (seen as unknown[]) : null;
      }, GESTURE_STORE_KEY);
      if (!Array.isArray(raw)) {
        throw new Error(
          `The gesture recorder is not installed in ${page.url()}: the document it was installed in has been replaced.`,
        );
      }
      return raw.filter((type): type is string => typeof type === 'string');
    },
    routeRequests: () => routeRequests,
    dispose() {
      page.off('request', onRequest);
    },
  };
}

/** A box in viewport CSS pixels, as `getBoundingClientRect` measures it. */
interface ViewportBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** One element with the traits of the picker's highlight, as the page lays it out. */
interface HighlightView extends ViewportBox {
  /** Its computed `display` — `none` only for a highlight a refused teardown could merely hide. */
  readonly display: string;
}

/**
 * Every element of the page with the traits the agent gives its picker highlight
 * (`packages/telemetry/src/browser/dom-target.ts`, "Element picker"): a `div` that is a direct child
 * of `document.documentElement` — outside `body`, where no application markup sits — marked
 * `aria-hidden="true"` and laid out `position: fixed` with `pointer-events: none`. The agent gives
 * the node no id or class, so it is recognised by those traits, and a read before any pick proves
 * the application renders nothing that shares them.
 */
async function readPickerHighlights(page: Page): Promise<readonly HighlightView[]> {
  return page.evaluate(() =>
    Array.from(document.documentElement.children)
      .filter((element) => {
        if (
          element.tagName.toLowerCase() !== 'div' ||
          element.getAttribute('aria-hidden') !== 'true'
        ) {
          return false;
        }
        const style = getComputedStyle(element);
        return style.position === 'fixed' && style.pointerEvents === 'none';
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          display: getComputedStyle(element).display,
          top: box.top,
          left: box.left,
          width: box.width,
          height: box.height,
        };
      }),
  );
}

/** Whether `highlight` covers `box` within {@link HIGHLIGHT_BOX_TOLERANCE_PX} on every edge. */
function coversBox(highlight: ViewportBox, box: ViewportBox): boolean {
  return (
    Math.abs(highlight.top - box.top) <= HIGHLIGHT_BOX_TOLERANCE_PX &&
    Math.abs(highlight.left - box.left) <= HIGHLIGHT_BOX_TOLERANCE_PX &&
    Math.abs(highlight.width - box.width) <= HIGHLIGHT_BOX_TOLERANCE_PX &&
    Math.abs(highlight.height - box.height) <= HIGHLIGHT_BOX_TOLERANCE_PX
  );
}

/**
 * Aim at `target` and wait until the picker highlights it: exactly one highlight, shown, over
 * `target`'s own box — the page-side proof that a pick is armed in the current document. A pick
 * reaches the page asynchronously (panel → worker → bridge → agent), and the highlight follows only
 * a pointer *entering* an element, so every attempt first moves the pointer to the viewport's
 * corner, off `target`, and then onto it again; what is polled is the highlight itself.
 */
async function expectPickerHighlights(page: Page, target: Locator): Promise<void> {
  // Written from the poll's callback, so held in an object flow analysis does not narrow.
  const seen: { box: ViewportBox | undefined; highlights: readonly HighlightView[] } = {
    box: undefined,
    highlights: [],
  };
  try {
    await expect
      .poll(
        async () => {
          await page.mouse.move(0, 0);
          await target.hover();
          const box = await target.evaluate((element): ViewportBox => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
          });
          seen.box = box;
          seen.highlights = await readPickerHighlights(page);
          const [only] = seen.highlights;
          return (
            seen.highlights.length === 1 &&
            only !== undefined &&
            only.display !== 'none' &&
            coversBox(only, box)
          );
        },
        {
          message: 'the armed pick never highlighted the hovered element',
          timeout: DEFAULT_WAIT_TIMEOUT_MS,
        },
      )
      .toBe(true);
  } catch (error) {
    // The poll's message is fixed when the poll starts; the last observation is named here.
    throw new Error(
      `The armed pick never highlighted the hovered element, so it did not reach the page's agent: the element's box was ${JSON.stringify(seen.box)} and the page held ${String(seen.highlights.length)} highlight(s) ${JSON.stringify(seen.highlights)}.`,
      { cause: error },
    );
  }
}

/**
 * Assert the panel is in picker mode and the worker took the request: the toggle is pressed and
 * shows "Picker on", is no longer busy, and is still pressed — a request the worker refused would
 * have released it again.
 */
async function expectPickerOn(panel: PanelHandle): Promise<void> {
  const toggle = panel.pickElementButton;
  await expect(toggle, 'picker mode is on').toHaveAttribute('aria-pressed', 'true', {
    timeout: DEFAULT_WAIT_TIMEOUT_MS,
  });
  await expect(toggle, 'the pick request was answered').not.toHaveAttribute('aria-busy', 'true', {
    timeout: DEFAULT_WAIT_TIMEOUT_MS,
  });
  await expect(toggle, 'the worker armed the pick rather than refusing it').toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(panel.pickerOnBadge, 'the panel says picker mode is on').toBeVisible();
}

/**
 * Press the panel's "Pick element" once it is offered for the bound session, and wait until picker
 * mode is on ({@link expectPickerOn}).
 */
async function armPickerFromPanel(panel: PanelHandle): Promise<void> {
  const toggle = panel.pickElementButton;
  await expect(toggle, 'the panel offers "Pick element"').toBeVisible({
    timeout: DEFAULT_WAIT_TIMEOUT_MS,
  });
  // An unavailable toggle is `aria-disabled` and ignores presses, so it is waited out first.
  await expect(toggle, '"Pick element" is available for the bound session').not.toHaveAttribute(
    'aria-disabled',
    'true',
    { timeout: DEFAULT_WAIT_TIMEOUT_MS },
  );
  await expect(toggle, 'picker mode starts off').toHaveAttribute('aria-pressed', 'false');
  await expect(panel.pickerOnBadge).toBeHidden();
  await toggle.click();
  await expectPickerOn(panel);
}

/**
 * Assert the pick is over everywhere it showed: the panel's toggle released and its "Picker on"
 * badge gone, and the page's highlight removed from the document.
 */
async function expectPickerEnded(panel: PanelHandle, page: Page): Promise<void> {
  await expect(panel.pickElementButton, '"Pick element" is released').toHaveAttribute(
    'aria-pressed',
    'false',
    { timeout: DEFAULT_WAIT_TIMEOUT_MS },
  );
  await expect(panel.pickerOnBadge, 'the "Picker on" badge is gone').toBeHidden({
    timeout: DEFAULT_WAIT_TIMEOUT_MS,
  });
  await expect
    .poll(() => readPickerHighlights(page), {
      message: 'the picker highlight is still in the page after the pick ended',
      timeout: DEFAULT_WAIT_TIMEOUT_MS,
    })
    .toEqual([]);
}

/** Poll the service's session record until it names a target, and return it. */
async function waitForSessionTarget(
  service: ServiceHandle,
  sessionId: string,
): Promise<SelectedTarget> {
  // Written from the poll's callback, so held in an object flow analysis does not narrow.
  const latest: { target: SelectedTarget | undefined } = { target: undefined };
  await expect
    .poll(
      async () => {
        latest.target = (await service.getSession(sessionId)).target;
        return latest.target !== undefined;
      },
      {
        message: `session ${sessionId} never recorded a target: the pick did not reach the service (page → bridge → worker → service)`,
        timeout: DEFAULT_WAIT_TIMEOUT_MS,
      },
    )
    .toBe(true);
  if (latest.target === undefined) {
    throw new Error(`session ${sessionId} recorded no target`);
  }
  return latest.target;
}

/**
 * Assert `target` describes the widget's button as the page renders it: the button's own tag name
 * (compared case-insensitively, as the descriptor contract allows), a selector that resolves in the
 * page to exactly that button, its visible text, the widget as the nearest component of the chain,
 * and the page's own document.
 */
async function expectTargetIsButton(
  target: SelectedTarget,
  expected: {
    readonly page: Page;
    readonly button: Locator;
    readonly contract: FixtureContract;
    readonly baseUrl: string;
  },
): Promise<void> {
  const rendered = await expected.button.evaluate((element, selector) => {
    const matches = document.querySelectorAll(selector);
    return {
      tagName: element.tagName,
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      resolvesToButton: matches.length === 1 && matches[0] === element,
      matchCount: matches.length,
    };
  }, target.selector);
  expect(target.tagName.toLowerCase(), 'the target is the clicked button').toBe(
    rendered.tagName.toLowerCase(),
  );
  expect(
    rendered.resolvesToButton,
    `the target's selector ${target.selector} resolves in the page to exactly the clicked button (it matches ${String(rendered.matchCount)} element(s))`,
  ).toBe(true);
  expect(target.text, "the target carries the button's visible text").toBe(rendered.text);
  expect(target.componentChain, 'the component chain names the widget').toContain(
    expected.contract.widgetName,
  );
  expect(target.componentChain[0], 'the nearest component is the widget rendering the button').toBe(
    expected.contract.widgetName,
  );
  const targetUrl = new URL(target.url);
  expect(targetUrl.origin, "the target is of the app's origin").toBe(
    new URL(expected.baseUrl).origin,
  );
  expect(targetUrl.pathname, "the target is of the page's document").toBe(
    new URL(expected.page.url()).pathname,
  );
}

/**
 * With a pick armed in `page`, highlight and click the widget's button — a trusted click through
 * the browser's input pipeline — and assert the pick did what "Pick element" promises: the session's
 * target is that button, and the panel shows it; the pick is over in the panel and the page; and
 * the click was the picker's alone — no event of it reached the document, the route was not
 * requested and the widget shows no result. One ordinary click then proves the page is back to
 * normal: it reaches the application, which fetches its route and renders the reply, and the target
 * stays the picked one.
 */
async function pickButtonAndExpectConsumed(input: {
  readonly page: Page;
  readonly panel: PanelHandle;
  readonly service: ServiceHandle;
  readonly sessionId: string;
  readonly contract: FixtureContract;
  readonly baseUrl: string;
  readonly clicks: ApplicationClickObserver;
}): Promise<void> {
  const { page, panel, service, sessionId, contract, baseUrl, clicks } = input;
  const button = page.getByTestId(PING_BUTTON_TEST_ID);
  await expectPickerHighlights(page, button);
  await button.click();

  const target = await waitForSessionTarget(service, sessionId);
  await expectTargetIsButton(target, { page, button, contract, baseUrl });
  // The header's one summary line for the target: clipped to fit, with the whole selector as its
  // title. The same selector is repeated inside the collapsed "Target details" disclosure.
  await expect(
    panel.header.getByTitle(target.selector, { exact: true }),
    "the panel shows the picked element's selector",
  ).toBeVisible({ timeout: DEFAULT_WAIT_TIMEOUT_MS });
  await expectPickerEnded(panel, page);

  expect(await clicks.gestures(), 'no event of the picking click reached the page').toEqual([]);
  expect(clicks.routeRequests(), 'the picking click issued no request').toBe(0);
  await expect(
    page.getByTestId(PING_RESULT_TEST_ID),
    'the widget never acted on the picking click',
  ).toHaveText('');

  await runCheck(page, contract);
  expect(await clicks.gestures(), 'the next click reaches the application').toEqual(
    expect.arrayContaining([...CLICK_GESTURE_EVENT_TYPES]),
  );
  expect(clicks.routeRequests(), 'the next click issues its request').toBe(1);
  expect((await service.getSession(sessionId)).target, 'an ordinary click selects nothing').toEqual(
    target,
  );
}

/**
 * After a pick ended without an element, assert the page is back to normal and nothing was
 * selected: the first click on the widget's button reaches the application — every gesture event,
 * one request, the reply rendered — and the session record still names no target. The record is
 * read after that click's reply, a full round trip after the pick's own answer left the page.
 */
async function expectNoPickAndClickReachesApp(input: {
  readonly page: Page;
  readonly service: ServiceHandle;
  readonly sessionId: string;
  readonly contract: FixtureContract;
  readonly clicks: ApplicationClickObserver;
}): Promise<void> {
  const { page, service, sessionId, contract, clicks } = input;
  expect(await clicks.gestures(), 'no click has reached the page before this one').toEqual([]);
  expect(clicks.routeRequests(), 'no request was issued before this click').toBe(0);
  await runCheck(page, contract);
  expect(await clicks.gestures(), 'the click reached the application').toEqual(
    expect.arrayContaining([...CLICK_GESTURE_EVENT_TYPES]),
  );
  expect(clicks.routeRequests(), 'the click issued its request').toBe(1);
  expect(
    (await service.getSession(sessionId)).target,
    'the pick ended without selecting anything',
  ).toBeUndefined();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('telemetry capture', () => {
  test('the page agent is installed before React loads and stays dormant until a capture arms it', async ({
    appPage,
    editorClient,
    fixtureApp,
    openPanelPage,
    pairing,
    service,
    sessions,
  }) => {
    test.setTimeout(CAPTURE_TEST_TIMEOUT_MS);
    editorClient.clear();
    const contract = await loadFixtureContract(fixtureApp.baseUrl);

    // A fresh document of the fixture app, loaded with the frame recorder in place and with no
    // session bound to its tab.
    await recordAgentFrames(appPage);
    await appPage.goto(new URL('/', fixtureApp.baseUrl).toString(), {
      timeout: APP_READY_TIMEOUT_MS,
    });
    const fresh = await readAgentGlobals(appPage);
    expectAgentBeforeReact(fresh);
    expect(fresh.configPublished, 'no agent.config has reached a page no session armed').toBe(
      false,
    );
    expectAgentDormant(fresh);
    const report = await currentDocumentReport(appPage);
    expect(report.installedBeforeReact, 'agent.ready reports the hook predates React').toBe(true);
    expect(new URL(report.url).origin).toBe(fixtureApp.baseUrl);

    // A session that is bound and ready, but never captures.
    await pairing.ensurePaired();
    const { session } = await bindReadySession({
      page: appPage,
      sessions,
      openPanelPage,
      editorClient,
    });

    // The application behaves exactly as without the product.
    await runCheck(appPage, contract);

    const afterClick = await readAgentGlobals(appPage);
    expectAgentBeforeReact(afterClick);
    expectAgentDormant(afterClick);
    const frames = await readAgentFrames(appPage);
    expect(frames.types, 'a dormant agent posts no telemetry at all').not.toContain(
      TELEMETRY_BATCH_FRAME,
    );

    const stored = await service.queryPanelData(session.id, { source: 'events' });
    expect(stored.total, 'the service holds no event for a session that never captured').toBe(0);
    expect(stored.events).toEqual([]);
    const record = await service.getSession(session.id);
    expect(record.captures, 'the session never captured').toEqual([]);
    expect(record.status).toBe('ready' satisfies SessionRecord['status']);
  });

  test('a click on a freshly loaded page yields one trace: interaction → fetch → post-response React commit', async ({
    appPage,
    editorClient,
    extensionContext,
    fixtureApp,
    openPanelPage,
    pairing,
    service,
    sessions,
  }) => {
    test.setTimeout(CAPTURE_TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    editorClient.clear();
    const contract = await loadFixtureContract(fixtureApp.baseUrl);

    // Privacy probes: a query-parameter value in the document URL and a cookie the request carries.
    const queryProbe = randomProbeValue();
    const cookieProbe = randomProbeValue();
    await extensionContext.addCookies([
      { name: PROBE_COOKIE_NAME, value: cookieProbe, url: fixtureApp.baseUrl },
    ]);
    try {
      await recordAgentFrames(appPage);
      const freshUrl = new URL('/', fixtureApp.baseUrl);
      freshUrl.searchParams.set(PROBE_QUERY_KEY, queryProbe);
      await appPage.goto(freshUrl.toString(), { timeout: APP_READY_TIMEOUT_MS });
      expectAgentBeforeReact(await readAgentGlobals(appPage));
      const document = await currentDocumentReport(appPage);
      expect(document.installedBeforeReact).toBe(true);

      await pairing.ensurePaired();
      const { session, panel } = await bindReadySession({
        page: appPage,
        sessions,
        openPanelPage,
        editorClient,
      });
      await expect(panel.liveTail, 'the panel shows its live tail').toBeVisible();

      let armedCaptureId = '';
      const outcome = await sessions.capture(session.id, async () => {
        armedCaptureId = await waitForArmed(appPage);
        const tailBefore = await liveTailRowCount(panel);
        await runCheck(appPage, contract);
        await expect
          .poll(() => liveTailRowCount(panel), {
            message: 'the live tail did not grow while the click was captured',
            timeout: DEFAULT_WAIT_TIMEOUT_MS,
          })
          .toBeGreaterThan(tailBefore);
        await expectLiveTailShowsKind(panel, [
          KIND_INTERACTION,
          KIND_FETCH,
          KIND_COMMIT,
          KIND_RENDER,
        ]);
      });
      expect(outcome.captureId, 'the page was armed for the capture the service opened').toBe(
        armedCaptureId,
      );

      // Stopping the capture disables the hooks rather than idling them.
      await waitForDormant(appPage, outcome.captureId);

      const events = await readCaptureEvents(service, session.id);
      expect(
        events.length,
        'the capture stored no events: the agent was armed but nothing it posted reached the service (bridge → worker → service)',
      ).toBeGreaterThan(0);
      expectAttributedAndTimed(events, {
        sessionId: session.id,
        captureId: outcome.captureId,
        startedAt,
      });

      const trace = expectClickTrace(events, {
        contract,
        baseUrl: fixtureApp.baseUrl,
        producerId: document.producerId,
      });
      expectParentsPrecedeChildren(trace.traceEvents);
      expectTraceTree(await readTrace(service, session.id, trace.traceId), trace);
      expectCaptureSummary(outcome.summary, {
        captureId: outcome.captureId,
        traceIds: [trace.traceId],
        producerIds: [document.producerId],
        interactions: 1,
      });

      expectCapturePrivacy(events, {
        planted: [queryProbe, cookieProbe],
        rawResponseBody: contract.rawResponseBody,
      });
    } finally {
      await extensionContext.clearCookies({ name: PROBE_COOKIE_NAME });
    }
  });

  test('a reload during a capture continues the same capture on the new document', async ({
    appPage,
    editorClient,
    fixtureApp,
    openPanelPage,
    pairing,
    service,
    sessions,
  }) => {
    test.setTimeout(CAPTURE_TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    editorClient.clear();
    const contract = await loadFixtureContract(fixtureApp.baseUrl);

    await recordAgentFrames(appPage);
    await appPage.goto(new URL('/', fixtureApp.baseUrl).toString(), {
      timeout: APP_READY_TIMEOUT_MS,
    });
    const firstDocument = await currentDocumentReport(appPage);

    await pairing.ensurePaired();
    const { session, panel } = await bindReadySession({
      page: appPage,
      sessions,
      openPanelPage,
      editorClient,
    });

    // Written from inside the capture window, read after it closes.
    const during: { captureId: string; secondDocument: PageAgentReadyPayload | undefined } = {
      captureId: '',
      secondDocument: undefined,
    };
    const outcome = await sessions.capture(session.id, async () => {
      during.captureId = await waitForArmed(appPage);
      await runCheck(appPage, contract);

      await appPage.reload({ timeout: APP_READY_TIMEOUT_MS });
      const secondDocument = await currentDocumentReport(appPage);
      during.secondDocument = secondDocument;
      expect(secondDocument.documentId, 'the reload created a new document').not.toBe(
        firstDocument.documentId,
      );
      expect(secondDocument.producerId, 'the new document has its own producer').not.toBe(
        firstDocument.producerId,
      );
      expect(secondDocument.installedBeforeReact).toBe(true);

      // The same capture re-arms the new document.
      await waitForArmed(appPage, during.captureId);
      await runCheck(appPage, contract);

      // The reload is visible where the developer watches the capture: the navigation the reloaded
      // document produced reaches the panel's live tail, under its stored name, and the tail lists
      // the capture's "Page reloaded during capture" notice.
      const reloadNavigation = await waitForStoredEvent(
        service,
        session.id,
        (event) =>
          event.kind === KIND_NAVIGATION &&
          event.producerId === secondDocument.producerId &&
          event.attributes[NAVIGATION_TYPE_KEY] === NAVIGATION_TYPE_RELOAD,
        `the reloaded document's ${KIND_NAVIGATION} event (${NAVIGATION_TYPE_KEY} ${NAVIGATION_TYPE_RELOAD})`,
      );
      expect(reloadNavigation.captureId).toBe(during.captureId);
      await expectLiveTailShowsEvent(panel, reloadNavigation);
      await expect(
        panel.pageReloadedNotices.first(),
        'the live tail lists a "Page reloaded during capture" notice for the running capture',
      ).toBeVisible({ timeout: DEFAULT_WAIT_TIMEOUT_MS });
    });
    const secondDocument = during.secondDocument;
    if (secondDocument === undefined) {
      throw new Error('the capture window closed before the reloaded document reported');
    }
    expect(outcome.captureId, 'one capture spans both documents').toBe(during.captureId);
    await waitForDormant(appPage, outcome.captureId);

    const events = await readCaptureEvents(service, session.id);
    expectAttributedAndTimed(events, {
      sessionId: session.id,
      captureId: outcome.captureId,
      startedAt,
    });
    const browserProducers = new Set(
      events.filter((event) => event.tier === TIER_BROWSER).map((event) => event.producerId),
    );
    expect([...browserProducers], 'both documents produced evidence for the capture').toEqual(
      expect.arrayContaining([firstDocument.producerId, secondDocument.producerId]),
    );
    expect(events.filter((event) => event.kind === KIND_INTERACTION)).toHaveLength(2);

    const beforeReload = expectClickTrace(events, {
      contract,
      baseUrl: fixtureApp.baseUrl,
      producerId: firstDocument.producerId,
    });
    const afterReload = expectClickTrace(events, {
      contract,
      baseUrl: fixtureApp.baseUrl,
      producerId: secondDocument.producerId,
    });
    expect(afterReload.traceId, 'each click opened its own trace').not.toBe(beforeReload.traceId);
    expectParentsPrecedeChildren(beforeReload.traceEvents);
    expectParentsPrecedeChildren(afterReload.traceEvents);

    expectCaptureSummary(outcome.summary, {
      captureId: outcome.captureId,
      traceIds: [beforeReload.traceId, afterReload.traceId],
      producerIds: [firstDocument.producerId, secondDocument.producerId],
      interactions: 2,
    });
    const record = await service.getSession(session.id);
    expect(
      record.captures.map((capture) => capture.id),
      'the reload opened no second capture',
    ).toEqual([outcome.captureId]);
  });

  test('"Pick element" in the panel selects the element clicked in the page, and the page never receives that click', async ({
    appPage,
    editorClient,
    fixtureApp,
    openPanelPage,
    pairing,
    service,
    sessions,
  }) => {
    test.setTimeout(PICKER_TEST_TIMEOUT_MS);
    editorClient.clear();
    const contract = await loadFixtureContract(fixtureApp.baseUrl);
    await pairing.ensurePaired();
    const { session, panel } = await bindReadySession({
      page: appPage,
      sessions,
      openPanelPage,
      editorClient,
    });
    expect(session.target, 'a session created without a target has none').toBeUndefined();
    expect(
      await readPickerHighlights(appPage),
      'the application renders nothing with the traits of the picker highlight',
    ).toEqual([]);

    const clicks = await observeApplicationClicks(appPage, contract, fixtureApp.baseUrl);
    try {
      await armPickerFromPanel(panel);
      await pickButtonAndExpectConsumed({
        page: appPage,
        panel,
        service,
        sessionId: session.id,
        contract,
        baseUrl: fixtureApp.baseUrl,
        clicks,
      });
    } finally {
      clicks.dispose();
    }
  });

  test('Escape in the page leaves picker mode without selecting anything', async ({
    appPage,
    editorClient,
    fixtureApp,
    openPanelPage,
    pairing,
    service,
    sessions,
  }) => {
    test.setTimeout(PICKER_TEST_TIMEOUT_MS);
    editorClient.clear();
    const contract = await loadFixtureContract(fixtureApp.baseUrl);
    await pairing.ensurePaired();
    const { session, panel } = await bindReadySession({
      page: appPage,
      sessions,
      openPanelPage,
      editorClient,
    });
    expect(session.target).toBeUndefined();

    const clicks = await observeApplicationClicks(appPage, contract, fixtureApp.baseUrl);
    try {
      await armPickerFromPanel(panel);
      await expectPickerHighlights(appPage, appPage.getByTestId(PING_BUTTON_TEST_ID));

      // A trusted Escape in the page: the agent ends the pick and answers it without an element,
      // and the worker releases the panel's toggle.
      await appPage.keyboard.press('Escape');
      await expectPickerEnded(panel, appPage);

      await expectNoPickAndClickReachesApp({
        page: appPage,
        service,
        sessionId: session.id,
        contract,
        clicks,
      });
    } finally {
      clicks.dispose();
    }
  });

  test('pressing "Pick element" again leaves picker mode without selecting anything', async ({
    appPage,
    editorClient,
    fixtureApp,
    openPanelPage,
    pairing,
    service,
    sessions,
  }) => {
    test.setTimeout(PICKER_TEST_TIMEOUT_MS);
    editorClient.clear();
    const contract = await loadFixtureContract(fixtureApp.baseUrl);
    await pairing.ensurePaired();
    const { session, panel } = await bindReadySession({
      page: appPage,
      sessions,
      openPanelPage,
      editorClient,
    });
    expect(session.target).toBeUndefined();

    const clicks = await observeApplicationClicks(appPage, contract, fixtureApp.baseUrl);
    try {
      await armPickerFromPanel(panel);
      await expectPickerHighlights(appPage, appPage.getByTestId(PING_BUTTON_TEST_ID));

      // The toggle's second press cancels the pick in the page; the highlight leaving the page is
      // the proof the cancel arrived there, so nothing below can race a still-armed pick.
      await panel.pickElementButton.click();
      await expectPickerEnded(panel, appPage);

      await expectNoPickAndClickReachesApp({
        page: appPage,
        service,
        sessionId: session.id,
        contract,
        clicks,
      });
    } finally {
      clicks.dispose();
    }
  });

  test("the editor's pick request, relayed by the service, puts the panel in picker mode and the clicked element becomes the target", async ({
    appPage,
    editorClient,
    fixtureApp,
    openPanelPage,
    pairing,
    service,
    sessions,
  }) => {
    test.setTimeout(PICKER_TEST_TIMEOUT_MS);
    editorClient.clear();
    const contract = await loadFixtureContract(fixtureApp.baseUrl);
    await pairing.ensurePaired();
    const { session, panel } = await bindReadySession({
      page: appPage,
      sessions,
      openPanelPage,
      editorClient,
    });
    expect(session.target).toBeUndefined();
    await expect(panel.pickElementButton, 'picker mode starts off').toHaveAttribute(
      'aria-pressed',
      'false',
      { timeout: DEFAULT_WAIT_TIMEOUT_MS },
    );

    const clicks = await observeApplicationClicks(appPage, contract, fixtureApp.baseUrl);
    try {
      // VS Code's "Pick element": the editor asks the service, which pushes `target.request` to
      // the session's bound tab — the panel enters picker mode without being pressed.
      const delivered = await service.requestTarget(session.id);
      expect(delivered, 'the request was handed to the bound tab').toEqual({
        sessionId: session.id,
        tabId: panel.tabId,
      });
      await expectPickerOn(panel);

      await pickButtonAndExpectConsumed({
        page: appPage,
        panel,
        service,
        sessionId: session.id,
        contract,
        baseUrl: fixtureApp.baseUrl,
        clicks,
      });
    } finally {
      clicks.dispose();
    }
  });

  // Declared last: it disables and re-enables the extension, which replaces its MV3 worker.
  test('a page loaded before the extension was enabled recovers through one consented reload', async ({
    editorClient,
    extensionContext,
    extensionId,
    fixtureApp,
    openPanelPage,
    pairing,
    resetExtensionState,
    service,
    sessions,
  }) => {
    test.setTimeout(RELOAD_TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    editorClient.clear();
    const contract = await loadFixtureContract(fixtureApp.baseUrl);
    await pairing.ensurePaired();

    const extension = await openExtensionSwitch(extensionContext, extensionId);
    let enabled = true;
    let legacyPage: Page | undefined;
    let loads: DocumentLoadCounter | undefined;
    let reloads: TabReloadRecorder | undefined;
    try {
      // The pre-extension state, produced by the browser itself: a tab loaded while the extension
      // is disabled, then the extension enabled around it. Chrome injects no declared content
      // script into an already-open tab, so this document carries no agent and never reports.
      await extension.disable();
      enabled = false;
      legacyPage = await extensionContext.newPage();
      const legacyUrl = new URL('/', fixtureApp.baseUrl);
      legacyUrl.searchParams.set(PROBE_QUERY_KEY, randomProbeValue());
      await legacyPage.goto(legacyUrl.toString(), { timeout: APP_READY_TIMEOUT_MS });
      const worker = await extension.enable();
      enabled = true;
      // Every reload the new worker asks Chrome for is recorded from here on — before the pairing,
      // the panel, the binding or the offer exist — so no reload of the worker's can go unseen.
      const tabReloads = await recordTabReloads(worker);
      reloads = tabReloads;
      await pairing.ensurePaired();

      const legacy = await readAgentGlobals(legacyPage);
      expect(legacy.helperInstalled, 'a page loaded before the extension has no agent').toBe(false);
      expect(legacy.rendererCount, 'React met no agent hook in that page').toBe(0);

      // Observe the reload by its effects: a marker only the current document carries, and a count
      // of real document loads. The agent-frame recorder is in place for the document a reload
      // will create.
      const marker = randomProbeValue();
      await setDocumentMarker(legacyPage, marker);
      await recordAgentFrames(legacyPage);
      loads = countDocumentLoads(legacyPage);
      const urlBeforeReload = legacyPage.url();

      const created = await sessions.create(QUESTION);
      const panel = await openPanelPage({ inspect: legacyPage });
      const tabId = panel.tabId;
      if (tabId === undefined) {
        throw new Error(
          'The panel page inspects no tab; openPanelPage must install the DevTools stub.',
        );
      }
      await panel.waitForConnected();
      await panel.waitForBound(created.id);
      await editorClient.waitFor(
        'session.bound',
        (message) => message.payload.sessionId === created.id && message.payload.tabId === tabId,
      );

      // The consent step is surfaced — the service's reload request and the panel's own reload
      // action — and nothing has reloaded the page on its own.
      const request = await waitForReloadRequest(editorClient, created.id);
      expect(request.message.trim(), 'the reload request tells the developer what to do').not.toBe(
        '',
      );
      const reloadAction = panel.main.getByRole('button', {
        name: PAGE_RELOAD_ACTION_LABEL,
        exact: true,
      });
      await expect(
        reloadAction,
        `the panel offers its "${PAGE_RELOAD_ACTION_LABEL}" action for a page without an agent`,
      ).toBeVisible({ timeout: DEFAULT_WAIT_TIMEOUT_MS });
      expect(loads.loads(), 'no reload happened before the developer consented').toBe(0);
      expect(loads.navigationRequests()).toBe(0);
      expect(
        await tabReloads.calls(),
        'the worker asked Chrome for no reload before the developer consented',
      ).toEqual([]);
      expect(
        await readDocumentMarker(legacyPage),
        'the pre-extension document is still loaded',
      ).toBe(marker);
      const waiting = await service.getSession(created.id);
      expect(waiting.status, 'readiness cannot be met without an agent in the page').not.toBe(
        'ready' satisfies SessionRecord['status'],
      );

      // The developer consents through the panel's own action; the worker's consented reload, not
      // this test, reloads the inspected tab — once, through chrome.tabs.reload, of that tab.
      await reloadAction.click();
      await expect
        .poll(() => tabReloads.calls(), {
          message: `the panel's "${PAGE_RELOAD_ACTION_LABEL}" action did not make the worker call chrome.tabs.reload exactly once, for the inspected tab ${String(tabId)}`,
          timeout: DEFAULT_WAIT_TIMEOUT_MS,
        })
        .toEqual([tabId]);
      const session = await sessions.waitForReady(created.id, {
        timeoutMs: SESSION_READY_TIMEOUT_MS,
      });
      expect(session.boundTab?.tabId).toBe(tabId);
      const recovered = await currentDocumentReport(legacyPage);
      expect(
        recovered.installedBeforeReact,
        'the new document reports the hook predates React',
      ).toBe(true);
      expectAgentBeforeReact(await readAgentGlobals(legacyPage));
      expect(await readDocumentMarker(legacyPage), 'the reload replaced the document').toBeNull();
      await expect(
        reloadAction,
        `the "${PAGE_RELOAD_ACTION_LABEL}" offer is withdrawn once the new document's agent reported`,
      ).toBeHidden({ timeout: DEFAULT_WAIT_TIMEOUT_MS });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, RELOAD_QUIET_WINDOW_MS);
      });
      expect(loads.loads(), 'exactly one reload').toBe(1);
      expect(loads.navigationRequests(), 'exactly one document request').toBe(1);
      expect(
        await tabReloads.calls(),
        'exactly one chrome.tabs.reload, of the inspected tab, and none after it',
      ).toEqual([tabId]);
      expect(legacyPage.url(), 'the reload kept the URL').toBe(urlBeforeReload);

      // Recovery: a capture now yields the fresh-page trace shape.
      const page = legacyPage;
      const outcome = await sessions.capture(session.id, async () => {
        await waitForArmed(page);
        await runCheck(page, contract);
      });
      await waitForDormant(page, outcome.captureId);
      const events = await readCaptureEvents(service, session.id);
      expectAttributedAndTimed(events, {
        sessionId: session.id,
        captureId: outcome.captureId,
        startedAt,
      });
      const trace = expectClickTrace(events, {
        contract,
        baseUrl: fixtureApp.baseUrl,
        producerId: recovered.producerId,
      });
      expectParentsPrecedeChildren(trace.traceEvents);
      expectTraceTree(await readTrace(service, session.id, trace.traceId), trace);
    } finally {
      loads?.dispose();
      if (!enabled) {
        await extension.enable();
      }
      await extension.close();
      await legacyPage?.close();
      await resetExtensionState();
      // Last, so restoring the worker's own chrome.tabs.reload can never skip the cleanup above.
      await reloads?.dispose();
    }
  });
});
