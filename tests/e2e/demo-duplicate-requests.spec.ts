/**
 * Seeded defect 3 of the demo — duplicate network requests — proven end to end
 * through the real product (docs/DEMO.md, Walkthrough 3 and "Defect 3 —
 * duplicate requests").
 *
 * ## What the demo does
 *
 * A Lumen Supply product page mounts `RecommendationsRail` twice: once in the
 * detail body (`app/products/[slug]/page.tsx`, `variant="detail"`) and once as
 * the compact mini-rail in `SiteHeader` (`variant="compact"`). Both call
 * `useRecommendations({ productId, limit: RECOMMENDED_ITEM_LIMIT })` with an
 * inline options object, and the hook keys its effect on that object's
 * identity, so every render of either rail issues a fresh
 * `GET /api/recommendations?limit=…&productId=…` (aborting the one its previous
 * run left in flight, but never reusing an answer). The header re-renders on
 * the shipping-ETA ticker, which keeps the compact rail refetching. Because
 * both mounts pass the same exported rail-size constant, the two rails'
 * requests are byte-identical.
 *
 * ## What this spec proves
 *
 * 1. **The pipeline understood a request problem**: the question "Why are
 *    these requests duplicated?", asked about the detail rail selected through
 *    the product's own `$0` path, yields relevant files naming the hook or the
 *    rail, a plan whose actions include the runtime `fetch-tracking` action of
 *    the `FetchAdapter`, and an `instrumentation.ready` that accounts for its
 *    `fetch` signal — "Network tracing" among the runtime hooks, or deferred
 *    with the page-agent reason and a hint when the service installed before
 *    the tab bound, to be armed when the tab's agent reports (the capture then
 *    holds its browser-tier fetch spans).
 * 2. **Duplicate detection works on a real browser and a real route**: the
 *    `requests` aggregate served by `POST /sessions/:id/panel-data` holds a
 *    `/api/recommendations` group with a redundancy of at least 2, all
 *    identical in method, path and status and issued within the product's
 *    duplicate window, whose occurrences resolve to both mounts of the rail —
 *    the header's mini-rail and the detail body's rail — through the rail's own
 *    render telemetry, and carry at least two distinct initiators, every one
 *    running through `useRecommendations`.
 * 3. **Duplicate detection is keyed correctly**: the same capture also visits
 *    a second product. Its requests display under exactly the same redacted
 *    URL (`/api/recommendations?limit=?&productId=?`) yet form a different
 *    group — so grouping uses the pre-redaction HMAC `request_key`, not the
 *    shown URL (docs/SECURITY.md, "The pre-redaction request key").
 *    Byte-identical requests collide; a different `productId` does not.
 *    Neither the per-session key nor a digest is read or recomputed here: only
 *    the observable grouping is asserted.
 * 4. **Privacy holds on the stored events**: query values are masked while the
 *    path and the key names remain, no query value survives anywhere in an
 *    event, no attribute holds a body, a payload or a header, and neither the
 *    response content nor a trace-context header value leaks into them.
 * 5. **The generated panel and analysis answer the question**: a validated,
 *    non-fallback panel composing `requestTable` and `metricCards` with the
 *    `request_count` and `duplicate_request_count` metrics, rendered in the
 *    DevTools panel with the duplicate group badged and its occurrences listed
 *    with initiator source links; an analysis whose observed facts cite
 *    captured events and whose likely causes carry a confidence and a suggested
 *    location.
 *
 * What this spec deliberately does not repeat: the unit-level key semantics of
 * `packages/telemetry/src/redaction/request-key.test.ts` and the windowing
 * arithmetic of `packages/telemetry/src/aggregate/requests.test.ts`. Its
 * contribution is the real-browser, real-route grouping and initiator
 * attribution.
 *
 * ## Structure
 *
 * The `e2e` project runs `workers: 1`, and the pages, the panel and the editor
 * connection are test-scoped fixtures, so the one test that drives the browser
 * also checks the rendered panel while it is open. It stores what it observed
 * in the module-scoped state below; the serial tests after it assert against
 * that state and the worker-scoped service only. The session is registered with
 * a module-scoped tracker from the moment it exists and is ended — cleanup
 * included — in `afterAll`, inside a live editor announcement.
 *
 * Nothing here writes under `apps/demo-app`: instrumentation is installed by
 * the product's installer and removed by its cleanup. Nothing here sleeps:
 * every wait is a protocol frame (inside `runDebugSession`) or an `expect.poll`
 * over the service's stored telemetry. `tests/e2e/**` is exempt from the
 * no-hardcoding gate, which is why the demo's component, hook and route names
 * appear below; no seeded slug or product id does — both are resolved at
 * runtime from the demo's own `GET /api/products`.
 *
 * @module tests/e2e/demo-duplicate-requests.spec
 */

import { setTimeout as delay } from 'node:timers/promises';

import type { Frame, Locator, Page, Request } from '@playwright/test';

import {
  DATA_QUERY_MAX_LIMIT,
  PANEL_NODE_CATALOG,
  isKnownPanelNodeType,
  walkPanelNodes,
} from '@debuggen/panel-schema';
import type { AnalysisResult } from '@debuggen/protocol';
import { DEFAULT_DUPLICATE_WINDOW_MS, redactUrl } from '@debuggen/telemetry';
import type {
  MetricId,
  MetricValue,
  RequestGroup,
  RequestOccurrence,
  TelemetryEvent,
} from '@debuggen/telemetry';

import {
  DEFAULT_SESSION_TIMEOUTS,
  E2E_TIMEOUTS,
  createSessionTracker,
  describeEvent,
  expect,
  expectDuplicateGroup,
  expectEvidenceResolves,
  expectFactsAndHypothesesSeparate,
  expectMetricAvailable,
  expectNoPanelErrorState,
  expectNodeTypes,
  expectSourceLocationShape,
  expectValidPanelSpec,
  runDebugSession,
  selectTarget,
  test,
  waitForBound,
} from './helpers/fixtures';
import type {
  DebugSessionOutcome,
  PanelNodeType,
  PanelSpec,
  ServiceHandle,
  SessionInteraction,
  SessionPreparation,
  SessionRecord,
  SessionTracker,
} from './helpers/fixtures';
import { waitForStreamedContent, withEditorAnnouncement } from './helpers/demo-app';

// ---------------------------------------------------------------------------
// The question, the target and the demo's observable surface
// ---------------------------------------------------------------------------

/** The developer's question, verbatim from `docs/DEMO.md` Walkthrough 3. */
const QUESTION = 'Why are these requests duplicated?';

/** What the panel and analysis assertions prove, for their failure text. */
const DUPLICATE_REQUESTS_CONTEXT = `The duplicate-requests panel and analysis for "${QUESTION}"`;

/** The route both rails read (`apps/demo-app/app/api/recommendations/route.ts`). */
const RECOMMENDATIONS_PATH = '/api/recommendations';

/** The query keys `useRecommendations` sends, as the route's Zod schema names them. */
const RECOMMENDATIONS_QUERY_KEYS: readonly string[] = ['productId', 'limit'];

/** The request method the hook's client call uses. */
const RECOMMENDATIONS_METHOD = 'GET';

/**
 * The detail-body rail, selected through the product's `$0` path. The rail
 * renders a `<section data-variant="detail">`; the header's mini-rail carries
 * `data-variant="compact"`.
 */
const DETAIL_RAIL_SELECTOR = 'section[data-variant="detail"]';

/** The detail rail's accessible name: its `h2` ("Recommended for you"). */
const DETAIL_RAIL_NAME = 'Recommended for you';

/** The header mini-rail's accessible name: its paragraph title ("Recommended"). */
const COMPACT_RAIL_NAME = 'Recommended';

/** The two files the defect lives in, project-relative as `relevantFiles` reports them. */
const DEFECT_FILES: readonly string[] = [
  'src/hooks/useRecommendations.ts',
  'src/components/product/RecommendationsRail.tsx',
];

/** The component whose two mounts issue the duplicates. */
const RAIL_COMPONENT = 'RecommendationsRail';

/** The hook whose effect dependency is the options object. */
const RAIL_HOOK = 'useRecommendations';

/** The layout component that owns the compact mini-rail on the product route. */
const HEADER_COMPONENT = 'SiteHeader';

/**
 * The longest a rail render may precede a request for the request to count as
 * issued by that render's commit: the effect runs right after the commit
 * (observed at a few milliseconds), and the header re-renders on a 250 ms
 * shipping-ETA tick, so a request further than this from the last rail render
 * was not issued by it.
 */
const EFFECT_AFTER_RENDER_MAX_MS = 200;

/**
 * What a likely cause of the duplicates must name: the hook or the rail, the
 * effect that re-runs on a rebuilt dependency, or the double mount.
 */
const DUPLICATE_CAUSE_PATTERN = new RegExp(
  `${RAIL_HOOK}|${RAIL_COMPONENT}|\\beffect\\b|dependenc|mount`,
  'iu',
);

/** The instrumentation action type and adapter id that observe the page's requests. */
const FETCH_ACTION_TYPE = 'fetch-tracking';
const FETCH_ADAPTER_ID = 'fetch';
/** The capture signal the FetchAdapter collects, as `instrumentation.ready` names it. */
const FETCH_SIGNAL = 'fetch';

/** The runtime hook label the `FetchAdapter` reports in `instrumentation.ready`. */
const NETWORK_TRACING_HOOK = 'Network tracing';

/**
 * The node types this question's panel composes and the two metrics its cards
 * show (docs/DEMO.md, "How the three panels differ").
 */
const REQUIRED_NODE_TYPES: readonly PanelNodeType[] = ['requestTable', 'metricCards'];
const REQUIRED_METRICS: readonly MetricId[] = ['request_count', 'duplicate_request_count'];

/** The request kinds the page agent emits (the `fetch`/`xhr` patch). */
const REQUEST_KINDS: readonly TelemetryEvent['kind'][] = ['fetch', 'xhr'];

/** The only status the recommendations route answers a well-formed request with. */
const EXPECTED_STATUS = 200;

/**
 * The pass floors: a redundancy of at least two (three identical requests in
 * one window) issued by at least two distinct initiators.
 */
const MIN_DUPLICATE_COUNT = 2;
const MIN_INITIATORS = 2;

/** Occurrences needed per visited product before the capture may move on. */
const MIN_OCCURRENCES_PER_PRODUCT = MIN_DUPLICATE_COUNT + 1;

/** How many catalog entries the product lookup reads (the route's default page size). */
const PRODUCT_LOOKUP_PAGE_SIZE = 48;

/** The `traceparent` header shape: its value must never reach a stored attribute. */
const TRACEPARENT_VALUE_PATTERN = /\b00-[0-9a-f]{32}-[0-9a-f]{16}-0[0-9a-f]\b/u;

/**
 * Attribute names that would carry request or response content or a header
 * (bodies are never captured, header values never stored). The
 * agent adds keys beyond the declared catalog (`traceparentSkipReason`,
 * `aborted`, `response.type` — `packages/telemetry/src/browser/fetch.ts`), so
 * the privacy check is by name and value rather than by catalog membership.
 */
const CONTENT_ATTRIBUTE_PATTERN = /body|payload|header|cookie|authorization/iu;

/**
 * The request attribute naming the components that created the initiating
 * component, nearest first (`packages/telemetry/src/schema/attributes.ts`).
 */
const INITIATOR_OWNERS_KEY = 'initiatorOwners';

/** The most owner names the agent records (`MAX_INITIATOR_OWNERS` in `browser/initiator-owner.ts`). */
const MAX_OWNER_NAMES = 8;

/** The longest owner name the agent records, in code points (`MAX_INITIATOR_NAME_LENGTH`). */
const MAX_OWNER_NAME_LENGTH = 200;

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** How long one product visit may take for its recommendations requests to be stored. */
const ARRIVAL_TIMEOUT_MS = 45_000;

/** One navigation of the application page (`E2E_TIMEOUTS.pageReady` covers a first compile). */
const NAVIGATION_TIMEOUT_MS = E2E_TIMEOUTS.pageReady;

/** The spec-owned interaction: two product visits, each bounded by its arrival budget. */
const INTERACTION_BUDGET_MS = 2 * (NAVIGATION_TIMEOUT_MS + ARRIVAL_TIMEOUT_MS);

/**
 * How long the application page must go without a navigation before the
 * capture starts, so a reload the dev server performs on its own after the
 * install has landed (see {@link settlePage}).
 */
const SETTLE_QUIET_MS = 2_000;

/** How often {@link settlePage} checks for that quiet. */
const SETTLE_POLL_MS = 100;

/** The pause before the capture: the quiet itself, within one navigation's budget. */
const SETTLE_BUDGET_MS = NAVIGATION_TIMEOUT_MS + SETTLE_QUIET_MS;

/**
 * The selection session: its creation and tab binding, the `$0` selection
 * recorded on it, and its end with cleanup.
 */
const SELECTION_BUDGET_MS =
  2 * DEFAULT_SESSION_TIMEOUTS.bind + DEFAULT_SESSION_TIMEOUTS.end + NAVIGATION_TIMEOUT_MS;

/**
 * The workflow test: every session budget, the panel and page setup, the
 * selection session and the interaction.
 */
const WORKFLOW_TEST_TIMEOUT_MS =
  E2E_TIMEOUTS.longTestTimeoutMs + SELECTION_BUDGET_MS + SETTLE_BUDGET_MS + INTERACTION_BUDGET_MS;

/** A rendered panel element becoming visible, or a disclosure opening. */
const PANEL_DOM_TIMEOUT_MS = 30_000;

/** The session end (cleanup included) and the marker scan, in `afterAll`. */
const TEARDOWN_TIMEOUT_MS = E2E_TIMEOUTS.teardown;

// ---------------------------------------------------------------------------
// Module-scoped state, written once by the workflow test
// ---------------------------------------------------------------------------

/** One catalog product the capture visits, resolved at runtime from the demo's API. */
interface VisitedProduct {
  readonly id: string;
  readonly slug: string;
  /**
   * The one recommendations URL the browser sent for it, byte for byte — both
   * rails pass the same rail-size constant, so there is exactly one.
   */
  readonly wireUrl: string;
  /** The recommended products' names and ids the route answers for it: response content. */
  readonly responseTexts: readonly string[];
}

/**
 * When the capture moved from the first product to the second, and which visit
 * each page document belongs to.
 */
interface CaptureTimeline {
  /** When the second product was opened (Node epoch milliseconds). */
  readonly secondVisitStartedAt: number;
  /**
   * The visit of each page document that sent capture events, by producer id:
   * the visit its earliest event started in.
   */
  readonly documentVisits: ReadonlyMap<string, Visit>;
  /** The producer of each captured event, by event id. */
  readonly producerOfEvent: ReadonlyMap<string, string>;
  /**
   * When the reproduction navigated each page document away (the reload that
   * opened the first product, the navigation that opened the second), by
   * producer id: the first navigation mark after the document's earliest event.
   * A document keeps running until its successor commits, and the requests it
   * starts in that window are cancelled by the navigation.
   */
  readonly navigatedAwayAt: ReadonlyMap<string, number>;
}

/**
 * The capture's timeline. A request belongs to the product whose page issued
 * it: the first product's document keeps running its ticker-driven refetches
 * until the second product's document commits, so a request it starts after
 * the second visit began — while that navigation is still in flight — is still
 * a first-product request. Each browser document (its own `producerId`) is
 * therefore assigned to the visit its earliest event started in, and an event
 * is judged by its document; only an event without a known document is judged
 * by its start time.
 */
function captureTimeline(
  marks: { readonly firstVisitStartedAt: number; readonly secondVisitStartedAt: number },
  captured: readonly TelemetryEvent[],
): CaptureTimeline {
  const { secondVisitStartedAt } = marks;
  const navigations = [marks.firstVisitStartedAt, secondVisitStartedAt].sort((a, b) => a - b);
  const earliest = new Map<string, number>();
  const producerOfEvent = new Map<string, string>();
  for (const event of captured) {
    producerOfEvent.set(event.id, event.producerId);
    if (event.tier !== 'browser') {
      continue;
    }
    const seen = earliest.get(event.producerId);
    if (seen === undefined || event.startTime < seen) {
      earliest.set(event.producerId, event.startTime);
    }
  }
  const documentVisits = new Map<string, Visit>();
  const navigatedAwayAt = new Map<string, number>();
  for (const [producerId, startTime] of earliest) {
    documentVisits.set(producerId, startTime < secondVisitStartedAt ? 'first' : 'second');
    const leftAt = navigations.find((mark) => mark > startTime);
    if (leftAt !== undefined) {
      navigatedAwayAt.set(producerId, leftAt);
    }
  }
  return { secondVisitStartedAt, documentVisits, producerOfEvent, navigatedAwayAt };
}

let tracker: SessionTracker | undefined;
let outcome: DebugSessionOutcome | undefined;
let session: SessionRecord | undefined;
let events: readonly TelemetryEvent[] | undefined;
let groups: readonly RequestGroup[] | undefined;
let metrics: readonly MetricValue[] | undefined;
let analysis: AnalysisResult | undefined;
let panelSpec: PanelSpec | undefined;
let products: readonly [VisitedProduct, VisitedProduct] | undefined;
let timeline: CaptureTimeline | undefined;

/**
 * Narrows a module-scoped value written by the workflow test. Serial mode skips
 * every later test when that one fails, so reaching the throw means the value
 * was never written — which is itself the failure to report.
 */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `${what} was not recorded: the workflow test did not complete, so there is nothing to assert against.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Pure readers over captured data
// ---------------------------------------------------------------------------

/** A string attribute of an event, or `undefined` when absent or of another type. */
function stringAttribute(event: TelemetryEvent, key: string): string | undefined {
  const value: unknown = event.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Whether `value` is a bounded list of component names — the shape the agent
 * gives `initiatorOwners` — rather than a captured structure.
 */
function isListOfNames(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_OWNER_NAMES &&
    value.every(
      (name) =>
        typeof name === 'string' && name.length > 0 && [...name].length <= MAX_OWNER_NAME_LENGTH,
    )
  );
}

/** A finite numeric attribute of an event, or `undefined`. */
function numberAttribute(event: TelemetryEvent, key: string): number | undefined {
  const value: unknown = event.attributes[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Parses an as-written, absolute or redacted URL without a base of its own. */
function parseAnyUrl(url: string): URL | undefined {
  try {
    return new URL(url, 'http://url-parser.invalid');
  } catch {
    return undefined;
  }
}

/** The path of a URL in any of the forms a request event or the wire carries. */
function pathOf(url: string): string | undefined {
  return parseAnyUrl(url)?.pathname;
}

/** The query keys of a URL, in order. */
function queryKeysOf(url: string): string[] {
  const parsed = parseAnyUrl(url);
  return parsed === undefined ? [] : [...parsed.searchParams.keys()];
}

/** Whether an event is one of the page's recommendations requests. */
function isRecommendationsRequest(event: TelemetryEvent): boolean {
  if (!REQUEST_KINDS.includes(event.kind)) {
    return false;
  }
  const url = stringAttribute(event, 'url');
  return url !== undefined && pathOf(url) === RECOMMENDATIONS_PATH;
}

/** Whether a request group is a group of recommendations requests. */
function isRecommendationsGroup(group: RequestGroup): boolean {
  return group.path === RECOMMENDATIONS_PATH || pathOf(group.url) === RECOMMENDATIONS_PATH;
}

/** Which visit a request started in: before the second product was opened, or after. */
type Visit = 'first' | 'second';

function visitOf(startTime: number, captured: CaptureTimeline): Visit {
  return startTime < captured.secondVisitStartedAt ? 'first' : 'second';
}

/** The visit of one event: its page document's, else its start time's. */
function visitOfEvent(
  event: { readonly startTime: number; readonly producerId: string | undefined },
  captured: CaptureTimeline,
): Visit {
  const byDocument =
    event.producerId === undefined ? undefined : captured.documentVisits.get(event.producerId);
  return byDocument ?? visitOf(event.startTime, captured);
}

/**
 * The visits a group's occurrences fall in, each judged by the document that
 * issued it; a group that lists no occurrence is judged by its first and last
 * start.
 */
function visitsOfGroup(group: RequestGroup, captured: CaptureTimeline): Set<Visit> {
  if (group.occurrences.length === 0) {
    return new Set<Visit>([
      visitOf(group.firstStartTime, captured),
      visitOf(group.lastStartTime, captured),
    ]);
  }
  const visits = new Set<Visit>();
  for (const occurrence of group.occurrences) {
    visits.add(
      visitOfEvent(
        {
          startTime: occurrence.startTime,
          producerId: captured.producerOfEvent.get(occurrence.eventId),
        },
        captured,
      ),
    );
  }
  return visits;
}

/** The single recommendations group of one visit; asserts there is exactly one. */
function groupOfVisit(
  recommendationGroups: readonly RequestGroup[],
  captured: CaptureTimeline,
  visit: Visit,
): RequestGroup {
  const matching = recommendationGroups.filter((group) => {
    const visits = visitsOfGroup(group, captured);
    return visits.size === 1 && visits.has(visit);
  });
  expect(
    matching.length,
    [
      `Every byte-identical request of the ${visit} product must collapse into ONE group keyed by its request key.`,
      `  recommendations groups: ${describeGroups(recommendationGroups)}`,
    ].join('\n'),
  ).toBe(1);
  return required(matching[0], `the ${visit} product's recommendations group`);
}

/**
 * A bounded description of request groups for a failure message: positional
 * labels, never a group id (which embeds the request-key digest), and the
 * redacted URL only, never a query value.
 */
function describeGroups(list: readonly RequestGroup[]): string {
  if (list.length === 0) {
    return '(none)';
  }
  return list
    .slice(0, 8)
    .map(
      (group, index) =>
        `[#${String(index + 1)}: ${group.method} ${group.url} count=${String(group.count)} duplicates=${String(
          group.duplicateCount,
        )} groupedBy=${group.groupedBy} initiators=${String(group.initiators.length)}]`,
    )
    .join(' ');
}

/** The first frames of each initiator label, one per line, bounded for a failure message. */
function describeInitiators(initiators: readonly string[]): string {
  if (initiators.length === 0) {
    return '    (no initiator label reported)';
  }
  return initiators
    .slice(0, 6)
    .map((label, index) => {
      const frames = label
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .slice(0, 4)
        .join(' | ');
      return `    #${String(index + 1)}: ${frames.slice(0, 400)}`;
    })
    .join('\n');
}

/**
 * The owner chain a `render` event recorded (the `ownerChain` attribute of
 * `packages/telemetry/src/schema/attributes.ts`), nearest owner first.
 */
function ownerChainOf(event: TelemetryEvent): string[] {
  const chain: unknown = event.attributes['ownerChain'];
  return Array.isArray(chain)
    ? chain.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** One render of the rail during a visit: when it started and the mount that rendered. */
interface RailRender {
  readonly startTime: number;
  /** The mount's owner chain, `nearest < … < farthest`. */
  readonly owners: string;
}

/**
 * Every render of the rail during one visit that recorded its owner chain, in
 * start order. Each distinct chain is one mounted instance of the component.
 */
function railRendersOfVisit(
  all: readonly TelemetryEvent[],
  captured: CaptureTimeline,
  visit: Visit,
): RailRender[] {
  const renders: RailRender[] = [];
  for (const event of all) {
    if (
      event.kind === 'render' &&
      stringAttribute(event, 'component') === RAIL_COMPONENT &&
      visitOfEvent(event, captured) === visit
    ) {
      const chain = ownerChainOf(event);
      if (chain.length > 0) {
        renders.push({ startTime: event.startTime, owners: chain.join(' < ') });
      }
    }
  }
  return renders.sort((left, right) => left.startTime - right.startTime);
}

/** One request occurrence and the rail mount whose commit issued it, when one did. */
interface AttributedOccurrence {
  readonly occurrence: RequestOccurrence;
  readonly owners: string | undefined;
}

/**
 * The rail mount that issued each occurrence of a group.
 *
 * `useRecommendations` fetches from a passive effect, and React flushes a
 * commit's passive effects before it renders anything else. An occurrence was
 * therefore issued by the mount whose render most recently preceded it — the
 * render whose commit ran that effect — provided that render is recent enough
 * to be its commit ({@link EFFECT_AFTER_RENDER_MAX_MS}). The initiator stack
 * cannot say this itself: React runs every effect from its own commit frames,
 * so the stack names the hook but never the instance that owns it.
 */
function attributeToRailMounts(
  group: RequestGroup,
  renders: readonly RailRender[],
): AttributedOccurrence[] {
  return group.occurrences.map((occurrence) => {
    let issuer: RailRender | undefined;
    for (const render of renders) {
      if (render.startTime > occurrence.startTime) {
        break;
      }
      issuer = render;
    }
    const recent =
      issuer !== undefined && occurrence.startTime - issuer.startTime <= EFFECT_AFTER_RENDER_MAX_MS;
    return { occurrence, owners: recent ? issuer?.owners : undefined };
  });
}

/** A bounded description of attributed occurrences, for a failure message. */
function describeAttribution(attributed: readonly AttributedOccurrence[]): string {
  if (attributed.length === 0) {
    return '    (no occurrence listed)';
  }
  const origin = Math.min(...attributed.map((entry) => entry.occurrence.startTime));
  return attributed
    .slice(0, 16)
    .map(
      (entry) =>
        `    +${(entry.occurrence.startTime - origin).toFixed(0)} ms → ${entry.owners ?? '(no rail render just before it)'}`,
    )
    .join('\n');
}

/** A location's `file:line`, the identity two initiators are told apart by. */
function locationKey(occurrence: RequestOccurrence): string | undefined {
  const { source } = occurrence;
  return source === undefined ? undefined : `${source.file}:${String(source.line)}`;
}

/** Every event id a request group holds evidence for: its occurrences and its duplicate windows. */
function eventIdsOfGroup(group: RequestGroup): Set<string> {
  const ids = new Set<string>(group.occurrences.map((occurrence) => occurrence.eventId));
  for (const window of group.duplicateWindows) {
    for (const id of window.eventIds) {
      ids.add(id);
    }
  }
  return ids;
}

/** Every node type of a panel's layout, at any depth, through the schema's own walk. */
function layoutNodeTypes(spec: PanelSpec): PanelNodeType[] {
  const types: PanelNodeType[] = [];
  walkPanelNodes(spec.layout, (node) => {
    types.push(node.type);
  });
  return types;
}

/** The metric ids every `metricCards` node of a panel shows, in document order. */
function metricCardIds(spec: PanelSpec): MetricId[] {
  const ids: MetricId[] = [];
  walkPanelNodes(spec.layout, (node) => {
    if (node.type === 'metricCards') {
      ids.push(...node.metrics);
    }
  });
  return ids;
}

// ---------------------------------------------------------------------------
// The demo, reached over HTTP and through the application page
// ---------------------------------------------------------------------------

/** One catalog entry, as far as this spec reads it. */
interface CatalogProduct {
  readonly id: string;
  readonly slug: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The catalog entries of a `GET /api/products` body that carry a usable id and slug. */
function catalogProductsOf(body: unknown): CatalogProduct[] {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    return [];
  }
  const found: CatalogProduct[] = [];
  for (const item of body.items as unknown[]) {
    if (
      isRecord(item) &&
      typeof item.id === 'string' &&
      item.id !== '' &&
      typeof item.slug === 'string' &&
      item.slug !== ''
    ) {
      found.push({ id: item.id, slug: item.slug });
    }
  }
  return found;
}

/**
 * Two distinct seeded products, resolved from the demo's own catalog route at
 * runtime — never a slug written into this file.
 */
async function resolveTwoProducts(
  baseUrl: string,
): Promise<readonly [CatalogProduct, CatalogProduct]> {
  const url = new URL('/api/products', baseUrl);
  url.searchParams.set('pageSize', String(PRODUCT_LOOKUP_PAGE_SIZE));
  const response = await fetch(url);
  expect(response.status, `GET ${url.pathname} on the demo must answer 200`).toBe(200);
  const catalog = catalogProductsOf(await response.json());
  const first = catalog[0];
  const second = catalog.find((candidate) => first !== undefined && candidate.id !== first.id);
  expect(
    first !== undefined && second !== undefined,
    `the seeded catalog must list two distinct products (listed: ${String(catalog.length)})`,
  ).toBe(true);
  return [
    required(first, 'the first seeded product'),
    required(second, 'the second seeded product'),
  ];
}

/**
 * What the recommendations route answers for one request URL the browser
 * actually sent: the recommended products' names and ids. This is response
 * content, which must never appear in a stored request event.
 */
async function responseTextsFor(wireUrl: string): Promise<string[]> {
  const response = await fetch(wireUrl);
  expect(response.status, `the recommendations route must answer ${String(EXPECTED_STATUS)}`).toBe(
    EXPECTED_STATUS,
  );
  const body: unknown = await response.json();
  const texts: string[] = [];
  if (Array.isArray(body)) {
    for (const item of body as unknown[]) {
      if (isRecord(item)) {
        for (const key of ['name', 'productId'] as const) {
          const value = item[key];
          if (typeof value === 'string' && value.length >= 4) {
            texts.push(value);
          }
        }
      }
    }
  }
  return texts;
}

/** The product page of a slug on the demo. */
function productUrl(baseUrl: string, slug: string): string {
  return new URL(`/products/${encodeURIComponent(slug)}`, baseUrl).toString();
}

/** The detail-body rail: a region named by its `h2`. */
function detailRail(page: Page): Locator {
  return page.getByRole('region', { name: DETAIL_RAIL_NAME, exact: true });
}

/** The header's mini-rail: a region named by its paragraph title. */
function compactRail(page: Page): Locator {
  return page.getByRole('region', { name: COMPACT_RAIL_NAME, exact: true });
}

/** Waits until both mounts of the rail are in the document of a product page. */
async function expectBothRailsMounted(page: Page): Promise<void> {
  await expect(detailRail(page), `the detail-body ${RAIL_COMPONENT} must render`).toBeVisible({
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await expect(
    compactRail(page),
    `the header's compact ${RAIL_COMPONENT} must be mounted on a product page`,
  ).toBeAttached({ timeout: NAVIGATION_TIMEOUT_MS });
}

/** How many times {@link reloadPage} retries a reload another navigation aborted. */
const MAX_RELOAD_ATTEMPTS = 3;

/**
 * Whether a navigation failed because another navigation of the same page
 * replaced it — Chromium's `net::ERR_ABORTED`, which Playwright also words as a
 * detached frame.
 */
function isAbortedByNavigation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('net::ERR_ABORTED') || message.includes('frame was detached');
}

/**
 * Reloads `page`, tolerating a navigation that replaces the reload.
 *
 * A plan that patches a client module (a fetch wrapper the code graph resolves
 * as an API call site) makes the dev server's Fast Refresh reload the page on
 * its own once it has recompiled that module, and that reload can land just as
 * the capture starts, aborting this one. The concurrent load is waited out and
 * the reload is issued again, so the page the reproduction measures is loaded
 * inside the capture, by the reload this spec asked for.
 */
async function reloadPage(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.reload({ timeout: NAVIGATION_TIMEOUT_MS });
      return;
    } catch (error) {
      if (attempt >= MAX_RELOAD_ATTEMPTS || !isAbortedByNavigation(error)) {
        throw error;
      }
      await page.waitForLoadState('load', { timeout: NAVIGATION_TIMEOUT_MS });
    }
  }
}

/**
 * Waits until `page` has gone {@link SETTLE_QUIET_MS} without a main-frame
 * navigation and has finished loading: the developer's pause between "Ready
 * to capture" and pressing Start capture (docs/DEMO.md, Walkthrough 3).
 *
 * The plan patches the client fetch wrapper, and the dev server's Fast Refresh
 * reloads the page on its own once it has recompiled that module — a few
 * milliseconds after the session turns ready. Until then the page still runs
 * the uninstrumented module and, driven by the header's ticker, keeps asking
 * for recommendations. Captured, those requests carry initiator frames from a
 * chunk the dev server no longer serves, so they cannot be placed at the call
 * site the instrumented document's requests share, and the duplicate group
 * they join loses its location. Waiting the reload out keeps every captured
 * request on the code the capture instruments.
 */
async function settlePage(page: Page): Promise<void> {
  let lastNavigationAt = Date.now();
  const onNavigated = (frame: Frame): void => {
    if (frame === page.mainFrame()) {
      lastNavigationAt = Date.now();
    }
  };
  page.on('framenavigated', onNavigated);
  try {
    const deadline = Date.now() + SETTLE_BUDGET_MS;
    while (Date.now() - lastNavigationAt < SETTLE_QUIET_MS) {
      if (Date.now() > deadline) {
        throw new Error(
          `the application page kept navigating for ${String(SETTLE_BUDGET_MS)} ms after the session turned ready`,
        );
      }
      await delay(SETTLE_POLL_MS);
    }
    await page.waitForLoadState('load', { timeout: NAVIGATION_TIMEOUT_MS });
    await waitForRevealedContent(page);
  } finally {
    page.off('framenavigated', onNavigated);
  }
}

/**
 * Waits until `page` has revealed what it streamed, reloading it once when it
 * does not.
 *
 * Instrumenting and restoring files makes the dev server recompile modules
 * while the page may still be loading. When a patch or a restore lands during
 * a reload of a freshly compiled route, the dev server's server render can fail
 * for that one request — React reports "Switched to client rendering because
 * the server rendering errored" — and that document never reveals its streamed
 * segment. The next request renders against the recompiled modules, so a
 * developer reloads, and so does this: once, before the capture starts. A
 * document that still does not reveal its content after the reload is a real
 * failure and is reported as one.
 */
async function waitForRevealedContent(page: Page): Promise<void> {
  try {
    await waitForStreamedContent(page);
    return;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'TimeoutError') {
      throw error;
    }
  }
  await reloadPage(page);
  await page.waitForLoadState('load', { timeout: NAVIGATION_TIMEOUT_MS });
  await waitForStreamedContent(page);
}

/** One recommendations request as the browser sent it, observed by Playwright. */
interface WireRequest {
  readonly url: string;
  readonly productId: string | null;
}

// ---------------------------------------------------------------------------
// The service's stored telemetry
// ---------------------------------------------------------------------------

/** Every stored request event of the session's capture that targets the recommendations route. */
async function storedRecommendationRequests(
  service: ServiceHandle,
  sessionId: string,
): Promise<TelemetryEvent[]> {
  const page = await service.queryAllPanelData(sessionId, {
    source: 'events',
    filter: { kinds: [...REQUEST_KINDS] },
    limit: DATA_QUERY_MAX_LIMIT,
  });
  return page.items.filter(isRecommendationsRequest);
}

/**
 * Waits until the service has stored enough recommendations requests issued
 * since `since` — at least {@link MIN_OCCURRENCES_PER_PRODUCT}, from at least
 * {@link MIN_INITIATORS} distinct initiators — so the capture only moves on once
 * the evidence the later assertions read has arrived. Returns the last reading.
 */
async function awaitRecommendationRequests(
  service: ServiceHandle,
  sessionId: string,
  since: number,
  label: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const stored = (await storedRecommendationRequests(service, sessionId)).filter(
          (event) => event.startTime >= since,
        );
        const initiators = new Set(
          stored
            .map((event) => stringAttribute(event, 'initiator'))
            .filter((initiator): initiator is string => initiator !== undefined),
        );
        return stored.length >= MIN_OCCURRENCES_PER_PRODUCT && initiators.size >= MIN_INITIATORS
          ? 'arrived'
          : `${String(stored.length)} request(s) from ${String(initiators.size)} initiator(s)`;
      },
      {
        message: `${label}: waiting for at least ${String(MIN_OCCURRENCES_PER_PRODUCT)} stored ${RECOMMENDATIONS_PATH} requests from at least ${String(MIN_INITIATORS)} initiators`,
        timeout: ARRIVAL_TIMEOUT_MS,
        intervals: [...E2E_TIMEOUTS.pollIntervals],
      },
    )
    .toBe('arrived');
}

/** The session the tracker registered last: the one `runDebugSession` created for this run. */
function currentSessionId(active: SessionTracker): string {
  return required(active.registered.at(-1), 'the session runDebugSession registered');
}

/** The single, byte-identical wire URL the browser sent for one product. */
function singleWireUrl(
  wire: readonly WireRequest[],
  product: CatalogProduct,
  label: string,
): string {
  const urls = [
    ...new Set(wire.filter((request) => request.productId === product.id).map((r) => r.url)),
  ];
  expect(
    urls.length,
    [
      `Both ${RAIL_COMPONENT} mounts on the ${label} product must send byte-identical ${RECOMMENDATIONS_PATH} requests (the same rail-size constant).`,
      `  distinct URLs observed on the wire: ${String(urls.length)}`,
      ...urls.slice(0, 4).map((url) => `    ${redactUrl(url)}`),
    ].join('\n'),
  ).toBe(1);
  return required(urls[0], `the ${label} product's wire URL`);
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

test.describe('demo defect 3 — duplicate recommendations requests', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(({ service }) => {
    tracker = createSessionTracker(service);
  });

  test.afterAll(async ({ service, demoApp }) => {
    test.setTimeout(TEARDOWN_TIMEOUT_MS);
    const active = tracker;
    if (active === undefined) {
      return;
    }
    // The `vscode` role may only end sessions under a folder a live editor
    // connection announced; the per-test editor client is closed by now.
    const report = await withEditorAnnouncement(service, () => active.endAll());
    expect(report.problems, `Ending the session must restore the demo:\n${report.text}`).toEqual(
      [],
    );
    const markers = await demoApp.findMarkers();
    expect(
      markers.map((finding) => `${finding.file}:${String(finding.line)} ${finding.marker}`),
      'No instrumentation marker may remain in the demo source after the session ended.',
    ).toEqual([]);
  });

  test('reproduces duplicate recommendations requests on two products in one capture', async ({
    service,
    demoApp,
    appPage,
    panel,
    editorClient,
  }) => {
    test.setTimeout(WORKFLOW_TEST_TIMEOUT_MS);
    const active = required(tracker, 'the session tracker');
    const [firstProduct, secondProduct] = await resolveTwoProducts(demoApp.baseUrl);

    // Every recommendations request exactly as it left the page, for the
    // byte-identity check and the pre-redaction comparison below.
    const wire: WireRequest[] = [];
    const onRequest = (request: Request): void => {
      const url = request.url();
      if (pathOf(url) === RECOMMENDATIONS_PATH) {
        wire.push({ url, productId: parseAnyUrl(url)?.searchParams.get('productId') ?? null });
      }
    };
    appPage.on('request', onRequest);

    await test.step('open the first product page with both rails mounted', async () => {
      await appPage.goto(productUrl(demoApp.baseUrl, firstProduct.slug), {
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      await expectBothRailsMounted(appPage);
    });

    // The developer selects the detail rail in the Elements panel before asking.
    // The product records a `$0` selection only on a session bound to the tab,
    // while Stage 1 reads the target when a session is created — so the
    // selection is made under a first session, whose record the service
    // updates through the real `devtools.element` → `target.selected` path, and
    // the question is then asked with that recorded target, which
    // `session.create` carries. The first session is ended — its cleanup
    // included — before the question is asked.
    const selected =
      await test.step('select the detail rail in the Elements panel through the product', async () => {
        const mark = editorClient.snapshotIndex();
        const selection = await service.createSession({
          projectRoot: demoApp.projectRoot,
          question: QUESTION,
        });
        active.register(selection.id);
        // The panel is open on the tab, so the product binds the new session
        // to it by itself; reloading the panel here would unbind it again.
        await waitForBound(editorClient, selection.id, {
          tabId: panel.tabId,
          url: appPage.url(),
          sinceIndex: mark,
          timeoutMs: DEFAULT_SESSION_TIMEOUTS.bind,
        });
        const picked = await selectTarget({
          panel,
          appPage,
          selector: DETAIL_RAIL_SELECTOR,
          editorClient,
          sessionId: selection.id,
          route: 'devtools-eval',
          timeoutMs: DEFAULT_SESSION_TIMEOUTS.bind,
        });
        const ended = await active.end(selection.id);
        expect(
          ended.cleanup,
          `ending the selection session ${selection.id} must restore the demo (${ended.error ?? 'no error'})`,
        ).toBe('clean');
        return picked.target;
      });

    // The developer's reproduction (docs/DEMO.md Walkthrough 3): once the page
    // has settled on the instrumented code, start the capture, reload the
    // product page so both rails mount and fetch, let the header's
    // ticker-driven renders provoke refetches, then open a second product.
    // Each step moves on only once its evidence is stored.
    let firstVisitStartedAt: number | undefined;
    let secondVisitStartedAt: number | undefined;
    const beforeCapture: SessionPreparation = ({ appPage: page }) => settlePage(page);
    const interact: SessionInteraction = async ({ appPage: page }) => {
      const sessionId = currentSessionId(active);
      firstVisitStartedAt = Date.now();
      await reloadPage(page);
      await expectBothRailsMounted(page);
      await awaitRecommendationRequests(service, sessionId, firstVisitStartedAt, 'first product');

      secondVisitStartedAt = Date.now();
      await page.goto(productUrl(demoApp.baseUrl, secondProduct.slug), {
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      await expectBothRailsMounted(page);
      await awaitRecommendationRequests(service, sessionId, secondVisitStartedAt, 'second product');
    };

    const run = await test.step('ask the question and capture through the real pipeline', () =>
      runDebugSession({
        service,
        editorClient,
        projectRoot: demoApp.projectRoot,
        question: QUESTION,
        panel,
        appPage,
        target: selected,
        beforeCapture,
        interact,
        tracker: active,
      }));
    appPage.off('request', onRequest);

    await test.step('the pipeline understood a request problem', () => {
      const files = run.session.relevantFiles.map((entry) => entry.file);
      expect(
        files.filter((file) => DEFECT_FILES.includes(file)),
        `relevantFiles must name ${DEFECT_FILES.join(' or ')}; reported: ${files.join(', ') || '(none)'}`,
      ).not.toEqual([]);

      const chain = run.target?.componentChain ?? [];
      expect(
        chain,
        `the target selected through $0 must resolve to ${RAIL_COMPONENT}; its component chain: ${chain.join(' < ') || '(empty)'}`,
      ).toContain(RAIL_COMPONENT);

      const plan = required(run.plan, 'the instrumentation plan');
      expect(
        plan.capture.some((entry) => /\b(?:fetch|request|network)/iu.test(entry)),
        `the plan's capture list must name request tracking; it lists: ${plan.capture.join('; ')}`,
      ).toBe(true);
      const requestActions = plan.instrumentationTargets
        .filter((action) => action.type === FETCH_ACTION_TYPE)
        .map((action) => `${action.adapter}/${action.mode}`);
      expect(
        requestActions,
        `the plan must hold a runtime ${FETCH_ACTION_TYPE} action of the FetchAdapter`,
      ).toContain(`${FETCH_ADAPTER_ID}/runtime`);

      // The FetchAdapter's signal is accounted for in instrumentation.ready:
      // armed ("Network tracing" among the runtime hooks), or — because the
      // service installs on session.create, before the tab binds — deferred
      // with the page-agent reason and a hint, to be armed once the tab's agent
      // reports. Either way the capture must then hold the hook's browser-tier
      // fetch spans, which the arrival polls above and the serial tests assert.
      const ready = required(run.instrumentation, 'the instrumentation.ready snapshot');
      const deferred = ready.unavailable.find((entry) => entry.signal === FETCH_SIGNAL);
      if (ready.runtimeHooks.includes(NETWORK_TRACING_HOOK)) {
        expect(deferred, 'an armed fetch signal is not also reported unavailable').toBeUndefined();
      } else {
        const gap = required(
          deferred,
          `instrumentation.ready must account for the ${FETCH_SIGNAL} signal (runtime hooks: ${ready.runtimeHooks.join(', ')})`,
        );
        expect(gap.reason, 'the deferral names the missing page agent').toMatch(/page agent/iu);
        expect(gap.hint.trim(), 'the deferral carries a hint').not.toBe('');
      }
      test.info().annotations.push({
        type: 'fetch-signal',
        description: ready.runtimeHooks.includes(NETWORK_TRACING_HOOK)
          ? 'Network tracing was armed at install.'
          : `Network tracing was deferred at install: ${deferred?.reason ?? ''}`,
      });
      expect(run.captureSummary, 'capture.stopped must carry the capture summary').toBeDefined();
    });

    const sessionId = run.sessionId;
    const firstWireUrl = singleWireUrl(wire, firstProduct, 'first');
    const secondWireUrl = singleWireUrl(wire, secondProduct, 'second');
    expect(
      wire.every(
        (request) =>
          request.productId === firstProduct.id || request.productId === secondProduct.id,
      ),
      `every ${RECOMMENDATIONS_PATH} request on the wire must name one of the two visited products`,
    ).toBe(true);

    outcome = run;
    session = run.session;
    analysis = run.analysis;
    panelSpec = run.panel;
    products = [
      {
        ...firstProduct,
        wireUrl: firstWireUrl,
        responseTexts: await responseTextsFor(firstWireUrl),
      },
      {
        ...secondProduct,
        wireUrl: secondWireUrl,
        responseTexts: await responseTextsFor(secondWireUrl),
      },
    ];
    events = (
      await service.queryAllPanelData(sessionId, { source: 'events', limit: DATA_QUERY_MAX_LIMIT })
    ).items;
    timeline = captureTimeline(
      {
        firstVisitStartedAt: required(firstVisitStartedAt, 'the first visit start time'),
        secondVisitStartedAt: required(secondVisitStartedAt, 'the second visit start time'),
      },
      events,
    );
    groups = (
      await service.queryAllPanelData(sessionId, {
        source: 'requests',
        limit: DATA_QUERY_MAX_LIMIT,
      })
    ).items;
    metrics = (await service.queryAllPanelData(sessionId, { source: 'metrics' })).items;

    const recommendationGroups = groups.filter(isRecommendationsGroup);

    await test.step('the DevTools panel badges the duplicate group and lists its occurrences', async () => {
      const { locators } = panel;
      await expect(locators.panelView, 'the generated panel must render').toBeVisible({
        timeout: PANEL_DOM_TIMEOUT_MS,
      });
      await expect(locators.fallbackBanner, 'the panel must not be the fallback view').toHaveCount(
        0,
      );
      await expectNoPanelErrorState(panel.page, { timeoutMs: PANEL_DOM_TIMEOUT_MS });

      const rendered = await locators.renderedNodeTypes();
      expect(
        REQUIRED_NODE_TYPES.filter((type) => !rendered.has(type)),
        `the rendered panel must compose ${REQUIRED_NODE_TYPES.join(', ')}; rendered: ${[...rendered].sort().join(', ')}`,
      ).toEqual([]);

      // A group's grid row: its request cell marks it duplicated, and its
      // duplicates cell carries the badge.
      const table = locators.panelView.locator('.dg-request-table').first();
      const duplicateRows = table.getByRole('row').filter({
        has: panel.page.locator('.dg-request-table__group-row.dg-is-duplicate', {
          hasText: RECOMMENDATIONS_PATH,
        }),
      });
      // One badged row per product: the same redacted URL, two groups.
      await expect
        .poll(() => duplicateRows.count(), {
          message: `the request table must badge a duplicate ${RECOMMENDATIONS_PATH} row per visited product`,
          timeout: PANEL_DOM_TIMEOUT_MS,
          intervals: [...E2E_TIMEOUTS.pollIntervals],
        })
        .toBeGreaterThanOrEqual(2);

      const expectedCounts = new Set(
        recommendationGroups.map((group) => String(group.duplicateCount)),
      );
      const rowCount = await duplicateRows.count();
      for (let index = 0; index < rowCount; index += 1) {
        const badge = duplicateRows.nth(index).locator('.dg-request-table__duplicate-badge');
        await expect(badge, 'each duplicate row carries the duplicate badge').toBeVisible();
        const digits = ((await badge.textContent()) ?? '').replace(/\D/gu, '');
        expect(
          expectedCounts.has(digits),
          `the badge (${digits}) must show a recommendations group's duplicateCount (${[...expectedCounts].join(', ')})`,
        ).toBe(true);
      }

      const firstRow = duplicateRows.first();
      await firstRow
        .getByRole('button', {
          name: `Show occurrences: ${RECOMMENDATIONS_METHOD} ${RECOMMENDATIONS_PATH}`,
          exact: true,
        })
        .click();
      const occurrences = table.locator('.dg-request-table__occurrences').first();
      await expect(occurrences, 'expanding the row lists its occurrences').toBeVisible({
        timeout: PANEL_DOM_TIMEOUT_MS,
      });
      const occurrenceRows = occurrences.locator('.dg-request-table__occurrence-row');
      const listed = await occurrenceRows.count();
      expect(listed, 'the expanded group lists each occurrence').toBeGreaterThanOrEqual(
        MIN_OCCURRENCES_PER_PRODUCT,
      );
      await expect(
        occurrenceRows.locator('.dg-request-table__initiator'),
        'every listed occurrence carries its initiator source link',
      ).toHaveCount(listed);
    });
  });

  test('groups the byte-identical requests of both rails into one duplicate group', () => {
    const captured = required(timeline, 'the capture timeline');
    const recommendationGroups = required(groups, 'the request groups').filter(
      isRecommendationsGroup,
    );
    const all = required(events, 'the captured events');
    const byId = new Map(all.map((event) => [event.id, event]));
    const firstGroup = groupOfVisit(recommendationGroups, captured, 'first');

    const group = expectDuplicateGroup([firstGroup], isRecommendationsGroup, {
      minDuplicateCount: MIN_DUPLICATE_COUNT,
      minInitiators: MIN_INITIATORS,
      message: `the ${RECOMMENDATIONS_PATH} requests of the first product`,
    });

    // Distinct initiators, as the aggregate exposes them: each carried by at
    // least one of the group's own occurrences and labelled by the component
    // whose effect issued the request, with the component that wrote that
    // mount beside it — so the header's mini-rail and the detail body's rail
    // are two initiators of one group, named apart.
    expect(
      group.initiators.length,
      [
        `The duplicate group must be initiated by at least ${String(MIN_INITIATORS)} distinct initiators.`,
        '  observed initiators:',
        describeInitiators(group.initiators),
      ].join('\n'),
    ).toBeGreaterThanOrEqual(MIN_INITIATORS);
    expect(
      group.initiators.filter((initiator) => !initiator.startsWith(RAIL_COMPONENT)),
      [
        `Every initiator must name ${RAIL_COMPONENT}, the component whose effect issued the request.`,
        '  observed initiators:',
        describeInitiators(group.initiators),
      ].join('\n'),
    ).toEqual([]);
    const labelledMounts = {
      header: group.initiators.filter((initiator) => initiator.includes(HEADER_COMPONENT)),
      body: group.initiators.filter((initiator) => !initiator.includes(HEADER_COMPONENT)),
    };
    expect(
      labelledMounts.header.length > 0 && labelledMounts.body.length > 0,
      [
        `The initiators must name both ${RAIL_COMPONENT} mounts: the one ${HEADER_COMPONENT} writes and the one the page body writes.`,
        '  observed initiators:',
        describeInitiators(group.initiators),
      ].join('\n'),
    ).toBe(true);

    // The code behind every mount is the same: each occurrence's captured call
    // stack runs through the rails' hook effect, which is why the stack alone
    // cannot tell the mounts apart and the component label is what does.
    expect(
      group.occurrences
        .filter(
          (occurrence) =>
            occurrence.initiatorStack !== undefined &&
            !occurrence.initiatorStack.includes(RAIL_HOOK),
        )
        .map((occurrence) => occurrence.eventId),
      `Every occurrence's captured stack must run through ${RAIL_HOOK}, the hook both ${RAIL_COMPONENT} mounts call.`,
    ).toEqual([]);

    // Two initiating components: the group's occurrences resolve to both
    // mounts of the rail — the header's mini-rail and the detail body's rail —
    // through the rail's own render telemetry (see attributeToRailMounts).
    const renders = railRendersOfVisit(all, captured, 'first');
    const attributed = attributeToRailMounts(group, renders);
    const issuers = new Set(
      attributed
        .map((entry) => entry.owners)
        .filter((owners): owners is string => owners !== undefined),
    );
    const initiatingMounts = [
      '  observed initiators:',
      describeInitiators(group.initiators),
      `  mounts of ${RAIL_COMPONENT} that rendered (owner chains, nearest first):`,
      ...[...new Set(renders.map((render) => render.owners))].map((owners) => `    ${owners}`),
      '  each occurrence → the mount whose commit issued it:',
      describeAttribution(attributed),
    ].join('\n');
    expect(
      issuers.size,
      [
        `The duplicate group's occurrences must come from at least ${String(MIN_INITIATORS)} distinct ${RAIL_COMPONENT} mounts.`,
        initiatingMounts,
      ].join('\n'),
    ).toBeGreaterThanOrEqual(MIN_INITIATORS);
    const fromHeader = [...issuers].filter((owners) => owners.startsWith(HEADER_COMPONENT));
    const fromBody = [...issuers].filter((owners) => !owners.includes(HEADER_COMPONENT));
    expect(
      fromHeader.length > 0 && fromBody.length > 0,
      [
        `The duplicates must be issued both by the ${RAIL_COMPONENT} ${HEADER_COMPONENT} owns (the mini-rail) and by the one the page body owns (the detail rail).`,
        initiatingMounts,
      ].join('\n'),
    ).toBe(true);

    const carried = new Set(
      group.occurrences
        .map((occurrence) => occurrence.initiator)
        .filter((initiator): initiator is string => initiator !== undefined),
    );
    if (!group.occurrencesTruncated) {
      expect(
        group.initiators.filter((initiator) => !carried.has(initiator)),
        'every initiator the group reports is carried by one of its occurrences',
      ).toEqual([]);
    }
    const locations = new Set(
      group.occurrences
        .map(locationKey)
        .filter((location): location is string => location !== undefined),
    );
    expect(
      locations.size,
      'the occurrences resolve to at least one project source location',
    ).toBeGreaterThan(0);
    for (const occurrence of group.occurrences) {
      if (occurrence.source !== undefined) {
        expectSourceLocationShape(occurrence.source, {
          message: `occurrence ${occurrence.eventId}'s initiator location`,
        });
      }
    }

    // Identical requests: one method, one path, one settled status, one stored URL.
    expect(group.groupedBy, 'the group must be keyed by the pre-redaction request key').toBe(
      'request-key',
    );
    expect(group.method).toBe(RECOMMENDATIONS_METHOD);
    expect(group.path).toBe(RECOMMENDATIONS_PATH);
    expect(group.statusCodes, 'every settled occurrence answered the same status').toEqual([
      EXPECTED_STATUS,
    ]);
    const storedUrls = new Set(
      group.occurrences.map((occurrence) => {
        const event = byId.get(occurrence.eventId);
        return event === undefined
          ? '(event missing)'
          : (stringAttribute(event, 'url') ?? '(no url)');
      }),
    );
    expect([...storedUrls], 'every occurrence of the group stores the same (redacted) URL').toEqual(
      [group.url],
    );

    // Near-simultaneous: the product's own duplicate windows, each within its
    // bound, and at least one holding three identical requests.
    expect(group.duplicateWindows.length).toBeGreaterThan(0);
    for (const [index, window] of group.duplicateWindows.entries()) {
      expect(
        window.endTime - window.startTime,
        `duplicate window #${String(index + 1)} spans its issuance within the duplicate window`,
      ).toBeLessThanOrEqual(DEFAULT_DUPLICATE_WINDOW_MS);
      expect(window.count, `duplicate window #${String(index + 1)} lists its events`).toBe(
        window.eventIds.length,
      );
    }
    const largest = Math.max(...group.duplicateWindows.map((window) => window.count));
    expect(
      largest,
      'one duplicate window holds at least three identical requests',
    ).toBeGreaterThanOrEqual(MIN_OCCURRENCES_PER_PRODUCT);
  });

  test('keeps a different productId apart: grouping uses the pre-redaction request key', () => {
    const captured = required(timeline, 'the capture timeline');
    const [first, second] = required(products, 'the visited products');
    const recommendationGroups = required(groups, 'the request groups').filter(
      isRecommendationsGroup,
    );

    // No group mixes the two products' requests.
    const straddling = recommendationGroups.filter(
      (group) => visitsOfGroup(group, captured).size > 1,
    );
    expect(
      straddling.length,
      `a ${RECOMMENDATIONS_PATH} group holds requests for both products: ${describeGroups(straddling)}`,
    ).toBe(0);

    // Byte-identical requests collide: one group per product.
    const firstGroup = groupOfVisit(recommendationGroups, captured, 'first');
    const secondGroup = groupOfVisit(recommendationGroups, captured, 'second');
    expect(
      recommendationGroups.length,
      `exactly one ${RECOMMENDATIONS_PATH} group per visited product: ${describeGroups(recommendationGroups)}`,
    ).toBe(2);
    expect(secondGroup.count).toBeGreaterThanOrEqual(MIN_OCCURRENCES_PER_PRODUCT);

    // Different productId values do not: two keyed groups...
    for (const [label, group] of [
      ['first', firstGroup],
      ['second', secondGroup],
    ] as const) {
      expect(group.groupedBy, `the ${label} product's group is keyed by the request key`).toBe(
        'request-key',
      );
      expect(
        typeof group.requestKey === 'string' && group.requestKey !== '',
        `the ${label} product's group carries its service-assigned request key`,
      ).toBe(true);
    }
    expect(
      firstGroup.id === secondGroup.id,
      'the two products form two groups (the ids embed the key digest and are not printed)',
    ).toBe(false);
    expect(
      firstGroup.requestKey === secondGroup.requestKey,
      'the two products hash to different request keys (the keys themselves are not printed)',
    ).toBe(false);

    // ...although the redacted URL a panel shows is the same string for both.
    // A detector grouping on that string would have merged them.
    expect(
      secondGroup.url,
      'both products display under the same redacted URL; only the pre-redaction key separates them',
    ).toBe(firstGroup.url);
    expect(first.wireUrl, 'the two products sent different URLs on the wire').not.toBe(
      second.wireUrl,
    );
    expect(redactUrl(second.wireUrl), 'which mask to the same display URL').toBe(
      redactUrl(first.wireUrl),
    );
  });

  test('stores the requests redacted, without bodies or header values', () => {
    const all = required(events, 'the captured events');
    const captured = required(timeline, 'the capture timeline');
    const [first, second] = required(products, 'the visited products');
    const requests = all.filter(isRecommendationsRequest);
    expect(requests.length).toBeGreaterThanOrEqual(2 * MIN_OCCURRENCES_PER_PRODUCT);

    const productIds = [first.id, second.id];
    const responseTexts = [...first.responseTexts, ...second.responseTexts];
    const expectedUrls = new Set<string>();
    for (const wireUrl of [first.wireUrl, second.wireUrl]) {
      const parsed = parseAnyUrl(wireUrl);
      expectedUrls.add(redactUrl(wireUrl));
      if (parsed !== undefined) {
        expectedUrls.add(redactUrl(`${parsed.pathname}${parsed.search}`));
      }
    }

    let settled = 0;
    for (const event of requests) {
      const where = describeEvent(event);
      expect(REQUEST_KINDS, `${where}: a request event`).toContain(event.kind);
      expect(event.tier, `${where}: produced by the page agent`).toBe('browser');
      expect(stringAttribute(event, 'http.method'), `${where}: method`).toBe(
        RECOMMENDATIONS_METHOD,
      );

      // The URL: path and key names retained, every value masked.
      const url = required(stringAttribute(event, 'url'), `${where}'s url attribute`);
      expect(pathOf(url), `${where}: path retained`).toBe(RECOMMENDATIONS_PATH);
      expect(queryKeysOf(url).sort(), `${where}: query key names retained`).toEqual(
        [...RECOMMENDATIONS_QUERY_KEYS].sort(),
      );
      expect(
        [...(parseAnyUrl(url)?.searchParams.values() ?? [])].every((value) => value === '?'),
        `${where}: every query value is masked`,
      ).toBe(true);
      const stored = JSON.stringify(event);
      expect(
        productIds.filter((id) => stored.includes(id)).length,
        `${where}: no product id (a query value) survives anywhere in the stored event`,
      ).toBe(0);
      expect(
        expectedUrls.has(url),
        `${where}: the stored URL is the redaction of the URL the browser sent`,
      ).toBe(true);

      // No body and no header: no attribute is named for either, every value is
      // a scalar (a captured payload would not be), and neither the response
      // content nor a trace-context header value appears anywhere in it.
      expect(
        Object.keys(event.attributes).filter((key) => CONTENT_ATTRIBUTE_PATTERN.test(key)),
        `${where}: attributes named for a body, a payload or a header`,
      ).toEqual([]);
      // The one list a request carries is `initiatorOwners`: the names of the
      // components that created the initiating component — an OpenTelemetry
      // style array of strings, never a captured structure.
      expect(
        Object.entries(event.attributes)
          .filter(([, value]) => value !== null && typeof value === 'object')
          .filter(([key, value]) => !(key === INITIATOR_OWNERS_KEY && isListOfNames(value)))
          .map(([key]) => key),
        `${where}: structured attribute values (only scalars and the initiator's owner names are captured for a request)`,
      ).toEqual([]);
      const values = JSON.stringify(event.attributes);
      expect(
        responseTexts.filter((text) => values.includes(text)).length,
        `${where}: no response content appears in the event`,
      ).toBe(0);
      expect(
        TRACEPARENT_VALUE_PATTERN.test(values),
        `${where}: no header value (traceparent) appears in the event`,
      ).toBe(false);

      // A status code on every settled request, always the route's success
      // status. The hook aborts the request its previous effect run left in
      // flight, so an aborted request settles as an error without one; a
      // request its page started after the reproduction navigated that page
      // away is cancelled when the next document commits, a network error
      // without one; a request still open when the capture stopped has none
      // either.
      const statusCode = numberAttribute(event, 'http.status_code');
      if (statusCode !== undefined) {
        expect(statusCode, `${where}: status`).toBe(EXPECTED_STATUS);
        settled += 1;
      } else {
        const leftAt = captured.navigatedAwayAt.get(event.producerId);
        const cancelledByNavigation =
          event.status === 'error' && leftAt !== undefined && event.startTime >= leftAt;
        expect(
          (event.status === 'error' && event.attributes.aborted === true) ||
            cancelledByNavigation ||
            event.attributes.inFlight === true,
          `${where}: a request without a status code was aborted, cancelled by its page's navigation, or still in flight when the capture stopped`,
        ).toBe(true);
      }
    }
    expect(settled, 'settled requests carrying http.status_code').toBeGreaterThanOrEqual(
      2 * MIN_OCCURRENCES_PER_PRODUCT,
    );

    // Lineage, where the capture holds it: a request's parent is in its trace.
    const bySpan = new Map(all.map((event) => [event.spanId, event]));
    let linked = 0;
    for (const event of requests) {
      const parent = event.parentSpanId === undefined ? undefined : bySpan.get(event.parentSpanId);
      if (parent !== undefined) {
        expect(
          parent.traceId,
          `${describeEvent(event)} shares its trace with the ${parent.kind} that initiated it`,
        ).toBe(event.traceId);
        linked += 1;
      }
    }
    test.info().annotations.push({
      type: 'lineage',
      description: `${String(linked)} of ${String(requests.length)} ${RECOMMENDATIONS_PATH} requests carried a parent span held by the capture; each shares its trace.`,
    });
  });

  test('generates a validated request panel for the question', () => {
    const run = required(outcome, 'the workflow outcome');
    const spec = expectValidPanelSpec(required(panelSpec, 'the generated panel'), {
      message: 'the duplicate-requests panel',
    });
    expect(spec.meta?.fallback ?? false, 'the panel is generated, not the fallback').toBe(false);
    expect(spec.sessionId).toBe(run.sessionId);
    expect(run.panelId).toBe(spec.id);

    expectNodeTypes(spec, REQUIRED_NODE_TYPES, { message: DUPLICATE_REQUESTS_CONTEXT });
    const types = layoutNodeTypes(spec);
    expect(
      types.filter((type) => !isKnownPanelNodeType(type) || !(type in PANEL_NODE_CATALOG)),
      'every node type is a PANEL_NODE_CATALOG entry',
    ).toEqual([]);
    walkPanelNodes(spec.layout, (node) => {
      if (node.type === 'requestTable') {
        expect(node.query.source, 'the requestTable reads the requests aggregate').toBe('requests');
      }
    });

    const cardIds = metricCardIds(spec);
    expect(
      REQUIRED_METRICS.filter((id) => !cardIds.includes(id)),
      `the metric cards must show ${REQUIRED_METRICS.join(' and ')}; they show: ${cardIds.join(', ')}`,
    ).toEqual([]);

    // The cards' values agree with the aggregate the request table renders.
    const values = required(metrics, 'the capture metrics');
    const recommendationGroups = required(groups, 'the request groups').filter(
      isRecommendationsGroup,
    );
    const requestCount = expectMetricAvailable(values, 'request_count');
    const duplicateCount = expectMetricAvailable(values, 'duplicate_request_count');
    expect(requestCount).toBeGreaterThanOrEqual(
      recommendationGroups.reduce((total, group) => total + group.count, 0),
    );
    expect(duplicateCount).toBeGreaterThanOrEqual(
      recommendationGroups.reduce((total, group) => total + group.duplicateCount, 0),
    );
    expect(duplicateCount).toBeGreaterThanOrEqual(2 * MIN_DUPLICATE_COUNT);
  });

  test('keeps observed facts apart from likely causes', () => {
    const run = required(outcome, 'the workflow outcome');
    const result = required(analysis, 'the analysis');
    const all = required(events, 'the captured events');
    const recommendationGroups = required(groups, 'the request groups').filter(
      isRecommendationsGroup,
    );
    expect(result.sessionId).toBe(run.sessionId);
    expect(result.captureId).toBe(run.captureId);
    expect(required(session, 'the session record').analyses.length).toBeGreaterThan(0);

    expectFactsAndHypothesesSeparate(result, { message: DUPLICATE_REQUESTS_CONTEXT });
    expectEvidenceResolves(result, all, { message: DUPLICATE_REQUESTS_CONTEXT });

    // An observed fact is evidenced by the identical requests themselves.
    const duplicated = new Set<string>();
    for (const group of recommendationGroups) {
      for (const id of eventIdsOfGroup(group)) {
        duplicated.add(id);
      }
    }
    expect(
      result.observed.filter((fact) =>
        fact.evidence.some((reference) => duplicated.has(reference.eventId)),
      ).length,
      `at least one observed fact cites the duplicated ${RECOMMENDATIONS_PATH} requests`,
    ).toBeGreaterThan(0);

    // Likely causes: each with a confidence (checked above), at least one with
    // a well-formed suggested location, pointing at the effect dependency
    // identity or the double mount.
    expect(result.likelyCauses.length, 'the analysis offers a likely cause').toBeGreaterThan(0);
    const located = result.likelyCauses.filter(
      (hypothesis) => hypothesis.suggestedLocation !== undefined,
    );
    expect(located.length, 'at least one likely cause suggests a location').toBeGreaterThan(0);
    for (const hypothesis of located) {
      expectSourceLocationShape(hypothesis.suggestedLocation, {
        message: 'a likely cause suggested location',
      });
    }
    // The cause of the duplicates themselves: evidenced by the duplicated
    // requests, naming the effect that re-runs on a rebuilt dependency (or the
    // double mount), and located at the call site the requests share.
    const listed = result.likelyCauses
      .map(
        (hypothesis, index) =>
          `  likelyCauses[${String(index)}] (${hypothesis.confidence}): ${hypothesis.statement.slice(0, 200)} @ ${hypothesis.suggestedLocation?.file ?? '(no location)'}`,
      )
      .join('\n');
    const duplicateCause = result.likelyCauses.find(
      (hypothesis) =>
        hypothesis.evidence.some((reference) => duplicated.has(reference.eventId)) &&
        DUPLICATE_CAUSE_PATTERN.test(hypothesis.statement),
    );
    const cause = required(
      duplicateCause,
      `a likely cause citing the duplicated ${RECOMMENDATIONS_PATH} requests and naming the effect dependency or the double mount; offered:\n${listed}`,
    );
    const location = required(
      cause.suggestedLocation,
      `the duplicate-request cause's suggested location:\n${listed}`,
    );
    const callSites = new Set<string>();
    for (const group of recommendationGroups) {
      for (const occurrence of group.occurrences) {
        if (occurrence.source !== undefined) {
          callSites.add(occurrence.source.file);
        }
      }
    }
    expect(
      DEFECT_FILES.includes(location.file) || callSites.has(location.file),
      `the cause must point at the rail, its hook or the requests' shared call site (${[...callSites].join(', ')}); it points at ${location.file}`,
    ).toBe(true);
  });
});
