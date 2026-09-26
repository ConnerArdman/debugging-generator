/**
 * The "Slow Button" acceptance test: the demo's "Place order" control is slow,
 * and the product must explain why from real evidence.
 *
 * One workflow test drives the whole product — code analysis, a validated and
 * applied instrumentation plan, a real capture of a real click on the demo's
 * checkout page, analysis and panel generation — through
 * `helpers/session.ts`'s `runDebugSession`, with the deterministic provider.
 * While the session is still live it gathers every piece of evidence that only
 * exists while it is live (the panel page's DOM, the click-to-source round
 * trip into a real VS Code window, the modification journal and the
 * instrumented bytes on disk) into module state. The focused tests after it
 * assert that evidence, one claim each, so a reviewer reads one failure per
 * broken contract:
 *
 * 1. the pipeline understood the question and armed the checkout path;
 * 2. one trace correlates the click, the checkout request, the route and the
 *    SQL, and the SQL span carries no data;
 * 3. the trace tree the data API serves agrees with the flat event list;
 * 4. times are epoch milliseconds and every span nests inside its parent;
 * 5. the per-tier durations the panel shows are available and consistent;
 * 6. the generated panel is valid, not a fallback, and rendered the timeline,
 *    a flame or waterfall view and the query table;
 * 7. observed facts and likely causes stay apart, each backed by evidence;
 * 8. clicking the SQL row's source chip opens the demo's own `pool.query` call
 *    site: the service forwards the `source.open`, and a real VS Code window
 *    with the extension activated puts its cursor on that line and column;
 * 9. the patch was journalled with both hashes and a backup outside the
 *    repository.
 *
 * `describe.configure({ mode: 'serial' })` makes a failed workflow skip the
 * assertions that depend on it rather than report them as misleading passes.
 *
 * Two facts about the demo shape the workflow:
 *
 * - Placing an order converts the storefront's cart, and specs run in file
 *   order, so an earlier spec may already have emptied it. The workflow refills
 *   the cart through the storefront's own API when it is empty, the way a
 *   shopper would, and never touches the database or a demo file.
 * - The SQL call site's line is read from the demo source at run time, before
 *   the session starts (when the precondition proves the file is pristine). The
 *   resolver's code graph indexes the developer's own source, never the
 *   instrumented copy, and a patch stamps the original position too, so the
 *   pristine line is the contract; the line in the file as served during the
 *   session is recorded as an annotation when a patch moved it.
 *
 * The editor end of the click is real. The `editorHost` fixture is a VS Code
 * window (`helpers/editor-host.ts`) opened on the demo with the built extension
 * activated and pointed at the suite's service. It is started once the pipeline
 * has generated the panel — never while the session's first stage builds the
 * code index, which holds the service's event loop and would fail the one
 * service probe the extension makes as it activates — and warmed up just
 * before the chip is clicked: the recording editor connection sends
 * `source.open` for line 1, column 1 of the inventory service file, and the
 * window's own cursor must arrive there. That proves the window serves the live session without
 * relying on any acknowledgement from the service. After the click the window's
 * cursor, not a recorded frame, must sit in that file on the pristine call-site
 * line and at the chip's column. The window opens the file as it is on disk,
 * instrumented, and VS Code clamps a column past the end of a line to that
 * end, so the expected column is clamped the same way. A window that could not
 * start or connect is recorded as evidence rather than thrown, so only the
 * editor test fails for it.
 *
 * The control is pointed at before the question is asked, as a developer who
 * selects an element in the Elements panel and then asks about it does
 * (`runDebugSession`'s `selectBeforeQuestion`): the service starts problem
 * understanding as `session.create` returns, so only a target the question
 * carries can be read by Stage 1. Once the session is ready the element is
 * selected again through `$0`, so `target.selected` runs for the live session
 * as well; both selections wait for the descriptor to carry the React owner
 * chain, because installing the plan can make Fast Refresh reload the page.
 *
 * Restoration after `session.end` is `cleanup.spec.ts`'s claim; this file only
 * ends its session (the `sessions` fixture in test teardown, and `afterAll` as
 * a second, idempotent guarantee).
 *
 * Failure text names kinds, span ids, paths and counts only — never a raw
 * attribute value, a header, a full URL or statement text.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

import {
  INSTRUMENTATION_MODES,
  SHA256_HEX_PATTERN,
  instrumentationPlanSchema,
} from '@debuggen/instrumentation/schema';
import {
  CONFIDENCE_LEVELS,
  DATA_QUERY_MAX_LIMIT,
  PANEL_NODE_CATALOG,
  isKnownPanelNodeType,
  validatePanelSpec,
  walkPanelNodes,
} from '@debuggen/panel-schema';
import type { PanelNodeType } from '@debuggen/panel-schema';
import type {
  AnalysisResult,
  CaptureSummary,
  InstrumentationPlan,
  ModificationRecord,
  PanelSpec,
  ProgressStage,
  SelectedTarget,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import { isSafeRelativePath } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import {
  LINEAGE_ATTRIBUTE_KEYS,
  LINEAGE_VALUES,
  MIN_EPOCH_MS,
  REDACTION_MASK,
  compareEventsCanonical,
  findNodeBySpanId,
  walkTrace,
} from '@debuggen/telemetry';
import type {
  DB_QUERY_ATTRIBUTE_KEYS,
  FETCH_ATTRIBUTE_KEYS,
  HTTP_SERVER_ATTRIBUTE_KEYS,
  INTERACTION_ATTRIBUTE_KEYS,
  MetricId,
  MetricValue,
  TelemetryEvent,
  TraceTree,
} from '@debuggen/telemetry';

import { messageOf, waitForStreamedContent, withEditorAnnouncement } from './helpers/demo-app';
import {
  E2E_TIMEOUTS,
  EDITOR_HOST_TIMEOUTS,
  createSessionTracker,
  describeEvent,
  eventsOfKind,
  expect,
  expectAncestorKinds,
  expectAnyNodeType,
  expectEvidenceResolves,
  expectFactsAndHypothesesSeparate,
  expectHexId,
  expectMetricAvailable,
  expectNoPanelErrorState,
  expectNoSpanIdCollisions,
  expectNodeTypes,
  expectSourceLocationShape,
  expectValidPanelSpec,
  flattenTrace,
  isEditorWarmUpLocation,
  repoRoot,
  runDebugSession,
  test,
} from './helpers/fixtures';
import type {
  DebugSessionOutcome,
  DemoAppHandle,
  EditorClientHandle,
  EditorHostHandle,
  EditorSelectionRecord,
  PanelHandle,
  ServiceHandle,
  SessionStageRecord,
} from './helpers/fixtures';
import { DEFAULT_WAIT_TIMEOUT_MS, POLL_INTERVALS_MS } from './helpers/service';

// ---------------------------------------------------------------------------
// The question, the page and the control
// ---------------------------------------------------------------------------

/** The question of `docs/DEMO.md`'s first walkthrough, asked verbatim. */
const QUESTION = 'Why is this button slow?';

/** The storefront page the defect is reproduced on. */
const CHECKOUT_PAGE_PATH = '/checkout';

/** The checkout form's accessible name (`CheckoutForm.tsx`, `aria-label`). */
const CHECKOUT_FORM_SELECTOR = 'form[aria-label="Checkout details"]';

/**
 * The place-order control as the DOM renders it: `CheckoutButton` renders the
 * `Button` primitive as the form's one submit button. The selector is checked
 * to be unique and to carry {@link PLACE_ORDER_NAME} before it is used.
 */
const PLACE_ORDER_SELECTOR = `${CHECKOUT_FORM_SELECTOR} button[type="submit"]`;

/** The control's accessible name while idle (`CheckoutButton.tsx`). */
const PLACE_ORDER_NAME = 'Place order';

/** The confirmation headline a newly placed order renders (`OrderConfirmation.tsx`). */
const ORDER_CONFIRMED_HEADLINE = 'Thank you for your order';

/** The component the selected element's owner chain must name. */
const TARGET_COMPONENT = 'CheckoutButton';

// ---------------------------------------------------------------------------
// The storefront API used to prepare the cart
// ---------------------------------------------------------------------------

const CART_PATH = '/api/cart';
const CART_ITEMS_PATH = '/api/cart/items';
const PRODUCTS_PATH = '/api/products';

/** One catalog page is plenty to find in-stock products to refill a cart with. */
const CATALOG_PAGE_SIZE = 48;

/** Lines added when the cart is empty: several lines, so the per-line work is visible. */
const REFILL_LINE_COUNT = 4;

/** Units per refilled line: small, so no order approaches the one-shipment ceiling. */
const REFILL_QUANTITY = 2;

// ---------------------------------------------------------------------------
// The code the trace must lead back to
// ---------------------------------------------------------------------------

/** The route the click's request reaches. */
const CHECKOUT_ROUTE = '/api/checkout';

/** The route handler file, project-relative, as a relevant-file suffix. */
const ROUTE_FILE_SUFFIX = 'app/api/checkout/route.ts';

/** The directory the checkout component and form live in, project-relative. */
const CHECKOUT_COMPONENT_DIR = 'src/components/checkout/';

/** The service file holding the stock reservation query, project-relative. */
const INVENTORY_FILE = 'src/server/services/inventory.service.ts';

/** The function whose raw `pool.query` the reservation statement is issued from. */
const RESERVATION_FUNCTION = 'reserveStock';

/** The call the source location must point at. */
const SQL_CALL = 'pool.query';

/** The table the reservation statement reads. */
const RESERVATION_TABLE = 'inventory_movements';

/**
 * The reservation statement's opening CTE. It identifies the statement in the
 * captured (redacted) text and in the query table's row, whose statement
 * preview always starts with it.
 */
const RESERVATION_STATEMENT_PATTERN = /\bWITH\s+ledger\s+AS\b/i;

/** An inline literal of the reservation statement that redaction must mask. */
const RESERVATION_LITERAL = 'RESERVATION';

// ---------------------------------------------------------------------------
// Telemetry vocabulary, typed against the schema's own key lists
// ---------------------------------------------------------------------------

type InteractionKey = (typeof INTERACTION_ATTRIBUTE_KEYS)[number];
type FetchKey = (typeof FETCH_ATTRIBUTE_KEYS)[number];
type HttpServerKey = (typeof HTTP_SERVER_ATTRIBUTE_KEYS)[number];
type DbQueryKey = (typeof DB_QUERY_ATTRIBUTE_KEYS)[number];

const INTERACTION_TYPE = 'event.type' satisfies InteractionKey;
const INTERACTION_TEXT = 'target.text' satisfies InteractionKey;
const INTERACTION_CHAIN = 'componentChain' satisfies InteractionKey;
const FETCH_METHOD = 'http.method' satisfies FetchKey;
const FETCH_URL = 'url' satisfies FetchKey;
const SERVER_ROUTE_KEYS = ['http.route', 'next.route'] as const satisfies readonly HttpServerKey[];
const SERVER_URL = 'url' satisfies HttpServerKey;
const DB_SYSTEM = 'db.system' satisfies DbQueryKey;
const DB_STATEMENT = 'db.statement' satisfies DbQueryKey;
const DB_ROW_COUNT = 'db.rowCount' satisfies DbQueryKey;

/**
 * Attribute names that would carry row, parameter or body payloads. The
 * privacy model keeps only `db.rowCount` about a result, so none may appear on
 * a database span (`db.rowCount` itself does not match).
 */
const PAYLOAD_ATTRIBUTE_PATTERN =
  /(?:^|\.)(?:rows?|results?|values|param(?:eter)?s|body|payload)$/i;

/**
 * A numeric literal outside a `$n` placeholder or an identifier. Redaction masks
 * every literal, so none may survive in a stored statement.
 */
const NUMERIC_LITERAL_PATTERN = /(?<![\w$.])\d+(?:\.\d+)?(?![\w.])/;

/** The instrument stage's closing row: "Ready to capture". */
const READY_TO_CAPTURE_PATTERN = /^ready to capture$/i;

/**
 * The signal rows the instrument stage must report done for this question:
 * the server and database tiers the correlated trace below depends on, by the
 * labels the progress view shows (`docs/ARCHITECTURE.md`, "Progress from real
 * findings"). Both are served by the dev server's preload, which is attached
 * before the session starts. The page-side signals ("Network tracing", "React
 * renders", …) are armed through the page agent, which may report only after
 * installation ran; they are then listed as unavailable with a reason and a
 * hint, and armed when the agent reports, which the captured fetch and
 * interaction spans prove.
 */
const ARMED_SIGNAL_LABELS = ['Server spans', 'Database tracing'] as const;

/** The planning stages, in the order the pipeline runs them. */
const PLANNING_STAGES = [
  'understand',
  'investigate',
  'plan',
  'instrument',
] as const satisfies readonly ProgressStage[];

/** The stages after readiness; none of them may report a failure. */
const LATER_STAGES = [
  'capture',
  'analyze',
  'generate-panel',
] as const satisfies readonly ProgressStage[];

/** The per-tier durations the slow-interaction panel is about. */
const TIER_METRICS = [
  'total_duration',
  'frontend_duration',
  'backend_duration',
  'database_duration',
] as const satisfies readonly MetricId[];

// ---------------------------------------------------------------------------
// Clock tolerances
// ---------------------------------------------------------------------------

/**
 * Nesting slack between two spans of the same producer: both readings come from
 * one clock, so only floating-point rounding separates a child's edge from its
 * parent's.
 */
const SAME_PRODUCER_TOLERANCE_MS = 1;

/**
 * Nesting slack between the browser agent and the Node preload. Each converts
 * its own monotonic clock to epoch milliseconds (`performance.timeOrigin` and
 * OpenTelemetry `hrTime`) and nothing aligns the two beyond that
 * (`docs/ARCHITECTURE.md`, "Time base": the per-producer clock offset is
 * informational), so a server span may appear to start a few milliseconds
 * before the fetch that caused it. 100 ms bounds that skew on one machine by
 * orders of magnitude while staying far below the request itself.
 */
const CROSS_PRODUCER_TOLERANCE_MS = 100;

/**
 * Slack around the service's capture window (its own `Date.now()` readings)
 * for the producers' clocks. Any value from milliseconds to minutes separates
 * epoch milliseconds from seconds (10³ smaller) or microseconds (10³ larger);
 * one second absorbs clock skew and batching without weakening that.
 */
const CAPTURE_WINDOW_TOLERANCE_MS = 1_000;

/**
 * Budget for the workflow test: the session workflow and panel budget
 * (`E2E_TIMEOUTS.longTestTimeoutMs`) plus one page budget for preparing the
 * checkout page before the session and one for collecting evidence and
 * clicking through to source after it, plus the editor window's: its start
 * overlaps the pipeline but may outlast a quick one, and its warm-up and the
 * cursor wait run after it.
 */
const WORKFLOW_TIMEOUT_MS =
  E2E_TIMEOUTS.longTestTimeoutMs +
  2 * E2E_TIMEOUTS.pageReady +
  EDITOR_HOST_TIMEOUTS.startup +
  EDITOR_HOST_TIMEOUTS.warmUp +
  EDITOR_HOST_TIMEOUTS.selection;

/** How many of the window's cursor positions after the click the evidence lists. */
const MAX_OBSERVED_SELECTIONS = 20;

// ---------------------------------------------------------------------------
// The panel page's DOM contract (`packages/panel-renderer`)
// ---------------------------------------------------------------------------

/**
 * Each checked node type's block class. `@debuggen/panel-renderer` is not
 * importable from tests, so the component root classes are restated here, as
 * `helpers/chrome.ts` does for `renderedNodeTypes()`.
 */
const NODE_BLOCK_CLASSES = Object.freeze({
  timeline: 'dg-timeline',
  flame: 'dg-flame',
  waterfall: 'dg-waterfall',
  queryTable: 'dg-query-table',
} satisfies Partial<Record<PanelNodeType, string>>);

/** The node types whose rendered content is checked. */
type CheckedNodeType = keyof typeof NODE_BLOCK_CLASSES;

const CHECKED_NODE_TYPES: readonly CheckedNodeType[] = Object.freeze([
  'timeline',
  'flame',
  'waterfall',
  'queryTable',
]);

/** `primitives/EmptyState.tsx`'s root: a block showing it rendered no data. */
const EMPTY_STATE_SELECTOR = '.dg-empty-state';

/** A loading view still in flight. */
const BUSY_SELECTOR = '[aria-busy="true"]';

/** Every source chip (`components/SourceLink.tsx`). */
const SOURCE_LINK_SELECTOR = '.dg-source-link';

/** The summary's evidence chip lists (`layout/SummaryHeader.tsx`). */
const EVIDENCE_LIST_SELECTOR = '.dg-summary-header__evidence';

/** Every evidence chip, each carrying the id of the event it cites. */
const EVIDENCE_CHIP_SELECTOR = `${EVIDENCE_LIST_SELECTOR} [data-event-id]`;

/** A query-table row's disclosure toggle while collapsed. */
const COLLAPSED_TOGGLE_SELECTOR = '[aria-expanded="false"]';

/** The same toggle once its detail row is open. */
const EXPANDED_TOGGLE_SELECTOR = '[aria-expanded="true"]';

/** An expanded query row's per-execution selector (`QueryTable.tsx`). */
const SELECT_EXECUTION_NAME = /^select the execution at\b/i;

/** Event ids are opaque identifiers; checked before one is put in a selector. */
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Evidence gathered while the session is live
// ---------------------------------------------------------------------------

/** Where the SQL call site sits in the demo's source. */
interface SqlCallSite {
  /** 1-based line of the `pool.query` call inside {@link RESERVATION_FUNCTION}. */
  readonly line: number;
  /** 1-based column of the call on that line. */
  readonly column: number;
  /** The line's text length, which bounds a plausible column. */
  readonly lineLength: number;
}

/** What the panel page rendered once the generated panel settled. */
interface RenderedBlock {
  readonly nodeType: CheckedNodeType;
  readonly count: number;
  readonly emptyStates: number;
  readonly busy: number;
  readonly textLength: number;
}

interface RenderedPanelEvidence {
  readonly nodeTypes: readonly PanelNodeType[];
  readonly blocks: readonly RenderedBlock[];
  readonly reservationRows: number;
  readonly nodeErrors: number;
  readonly fallbackBanners: number;
  readonly observedFacts: number;
  readonly likelyCauses: number;
  readonly observedText: string;
  readonly likelyCauseText: string;
  readonly evidenceChipIds: readonly string[];
}

/** The `source.open` the editor received after the SQL row's chip was clicked. */
interface SourceOpenEvidence {
  /** Which rung of the chip ladder produced the click. */
  readonly rung: string;
  readonly sessionId: string;
  readonly location: SourceLocation;
}

/** How far the real editor window got before the chip was clicked. */
interface EditorReadiness {
  /** Why the window cannot be relied on (it did not start, or never reached the warm-up position). */
  readonly problem: string | undefined;
  /** How many warm-up `source.open` frames the window needed; 0 when the warm-up did not succeed. */
  readonly attempts: number;
}

/** What the real VS Code window did with the chip's `source.open` (`helpers/editor-host.ts`). */
interface EditorHopEvidence {
  /** Why the window's cursor was not observed at the clicked location; `undefined` when it was. */
  readonly problem: string | undefined;
  /** The cursor the window recorded at the location, else its last one in that file after the click. */
  readonly selection: EditorSelectionRecord | undefined;
  /** The demo's inventory service file by real path: the document the cursor must be in. */
  readonly expectedRealpath: string;
  /** The column the cursor must be at: the location's, clamped by VS Code to its line's end. */
  readonly expectedColumn: number;
  /** The window's cursor positions after the click, `file:line:column`, oldest first (bounded). */
  readonly observed: readonly string[];
  /** Warm-up frames the window needed before the click. */
  readonly warmUpAttempts: number;
  /** The panel's error states once the editor answered the click; `undefined` when it shows none. */
  readonly panelProblem: string | undefined;
}

/** Every protocol payload the editor connection recorded for the session. */
interface PublishedMessages {
  readonly plans: readonly InstrumentationPlan[];
  readonly readyRuntimeHooks: readonly (readonly string[])[];
  readonly panels: readonly { readonly panelId: string; readonly panel: PanelSpec }[];
  readonly captureStopped: boolean;
  readonly analysisCompleted: boolean;
}

/** The rest of the workflow's outcome the dependent tests read. */
interface RunEvidence {
  readonly sessionId: string;
  readonly captureId: string;
  readonly panelId: string;
  readonly statuses: readonly SessionStatus[];
  readonly plan: InstrumentationPlan;
  readonly instrumentation: NonNullable<DebugSessionOutcome['instrumentation']>;
  readonly target: SelectedTarget;
  readonly cartProductIds: readonly string[];
  readonly checkoutTraceId: string;
  readonly traceEvents: readonly TelemetryEvent[];
  readonly traceSpans: readonly TelemetryEvent[];
  readonly captureMetrics: readonly MetricValue[];
  readonly traceMetrics: readonly MetricValue[];
  readonly currentPanel: PanelSpec | null;
  readonly published: PublishedMessages;
  readonly rendered: RenderedPanelEvidence;
  readonly sourceOpen: SourceOpenEvidence;
  readonly editorHop: EditorHopEvidence;
  readonly sqlCallSite: SqlCallSite;
  readonly instrumentedHashes: ReadonlyMap<string, string>;
  readonly debuggenHome: string;
}

// The workflow's outcome. Each dependent test narrows what it reads with
// `fromWorkflow`, which throws when the workflow test did not run.
let session: SessionRecord | undefined = undefined;
let captureSummary: CaptureSummary | undefined = undefined;
let captureEvents: readonly TelemetryEvent[] | undefined = undefined;
let traceTree: TraceTree | undefined = undefined;
let analysis: AnalysisResult | undefined = undefined;
let panelSpec: PanelSpec | undefined = undefined;
let modifications: readonly ModificationRecord[] | undefined = undefined;
let progressStages: readonly SessionStageRecord[] | undefined = undefined;
let run: RunEvidence | undefined = undefined;

/** Every session the workflow created, ended again in `afterAll`. */
const workflowSessionIds: string[] = [];

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

/** The dependent tests' guard: the value the workflow test should have stored. */
function fromWorkflow<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`The workflow test did not run, so ${what} is unavailable.`);
  }
  return value;
}

/** A value the spec's own logic requires, with the reason it is missing. */
function present<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Reading telemetry events
// ---------------------------------------------------------------------------

/** A string-valued attribute, or `undefined` when absent or of another type. */
function stringAttribute(event: TelemetryEvent, key: string): string | undefined {
  const value = event.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

/** Whether a string attribute, or any string in an array attribute, contains `needle`. */
function mentions(value: unknown, needle: string): boolean {
  if (typeof value === 'string') {
    return value.includes(needle);
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.some((item) => typeof item === 'string' && item.includes(needle));
  }
  return false;
}

/** The path of an absolute or root-relative URL attribute, or `undefined`. */
function pathOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url, 'http://path.invalid').pathname;
  } catch {
    return undefined;
  }
}

/** Whether an `http.server` span handled the checkout route. */
function identifiesCheckoutRoute(event: TelemetryEvent): boolean {
  if (SERVER_ROUTE_KEYS.some((key) => stringAttribute(event, key) === CHECKOUT_ROUTE)) {
    return true;
  }
  if (pathOf(stringAttribute(event, SERVER_URL)) === CHECKOUT_ROUTE) {
    return true;
  }
  // Next.js names the request span "[http.method] [next.route]".
  return event.name.endsWith(` ${CHECKOUT_ROUTE}`);
}

/** Whether a browser `fetch` span is the order's `POST /api/checkout`. */
function isCheckoutFetch(event: TelemetryEvent): boolean {
  return (
    event.kind === 'fetch' &&
    stringAttribute(event, FETCH_METHOD)?.toUpperCase() === 'POST' &&
    pathOf(stringAttribute(event, FETCH_URL)) === CHECKOUT_ROUTE
  );
}

/**
 * The labels a press on the submit button can carry. The agent coalesces the
 * gesture (`pointerdown`, `click` and the form's `submit`) into one interaction,
 * names it by its most meaningful type, `submit` before `click`, and describes
 * the element the gesture opened on (`browser/interaction.ts`).
 */
const PRESS_EVENT_TYPES: readonly string[] = Object.freeze(['submit', 'click']);

/**
 * Whether an `interaction` is the press on the place-order control. A pointer
 * lands on the innermost element under it, so the element the gesture opened
 * on may be the button or the label inside it. The control is therefore named
 * by the owner chain, which reaches `CheckoutButton` either way, and the
 * element's text, when the agent kept it, must be the control's own.
 */
function isPlaceOrderClick(event: TelemetryEvent): boolean {
  const type = stringAttribute(event, INTERACTION_TYPE);
  const text = event.attributes[INTERACTION_TEXT];
  return (
    event.kind === 'interaction' &&
    type !== undefined &&
    PRESS_EVENT_TYPES.includes(type) &&
    mentions(event.attributes[INTERACTION_CHAIN], TARGET_COMPONENT) &&
    (text === undefined || mentions(text, PLACE_ORDER_NAME))
  );
}

/** The stored (redacted) statement of a database span. */
function statementOf(event: TelemetryEvent): string | undefined {
  return stringAttribute(event, DB_STATEMENT);
}

/** Whether a database span is the stock reservation statement. */
function isReservationQuery(event: TelemetryEvent): boolean {
  const statement = statementOf(event);
  return (
    event.kind === 'db.query' &&
    statement !== undefined &&
    statement.includes(RESERVATION_TABLE) &&
    RESERVATION_STATEMENT_PATTERN.test(statement)
  );
}

/** Kind, name and span id of each event, for failure text. */
function describeEvents(events: readonly TelemetryEvent[], limit = 20): string {
  const listed = events.slice(0, limit).map(describeEvent);
  const rest = events.length > limit ? [`(+${String(events.length - limit)} more)`] : [];
  return [...listed, ...rest].join(', ') || '(none)';
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The nesting slack between two events' clocks. */
function toleranceBetween(parent: TelemetryEvent, child: TelemetryEvent): number {
  return parent.producerId === child.producerId
    ? SAME_PRODUCER_TOLERANCE_MS
    : CROSS_PRODUCER_TOLERANCE_MS;
}

/**
 * The lineage attribute the browser agent stamps on work it attributes to a
 * settled request, checked against the schema's own key list.
 */
const LINEAGE_KEY = present(
  LINEAGE_ATTRIBUTE_KEYS.find((key) => key === 'lineage'),
  'The telemetry schema no longer declares the "lineage" attribute.',
);

/** Whether an event is an async continuation of the request it is parented to. */
function isAsyncContinuation(event: TelemetryEvent): boolean {
  const lineage = event.attributes[LINEAGE_KEY];
  return LINEAGE_VALUES.some((value) => value === lineage);
}

/** A failure line for a child whose window leaves its parent's, or `undefined`. */
function containmentViolation(parent: TelemetryEvent, child: TelemetryEvent): string | undefined {
  const slack = toleranceBetween(parent, child);
  const parentEnd = parent.startTime + parent.duration;
  const childEnd = child.startTime + child.duration;
  const startsEarly = child.startTime < parent.startTime - slack;
  const endsLate = childEnd > parentEnd + slack;
  if (!startsEarly && !endsLate) {
    return undefined;
  }
  return [
    `${describeEvent(child)} is not inside ${describeEvent(parent)} (slack ${String(slack)} ms):`,
    `child starts ${(child.startTime - parent.startTime).toFixed(3)} ms after the parent`,
    `and ends ${(childEnd - parentEnd).toFixed(3)} ms after it`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// The correlated checkout chain
// ---------------------------------------------------------------------------

/** The spans that must line up from the click to the reservation SQL. */
interface CheckoutChain {
  readonly interaction: TelemetryEvent;
  readonly browserFetch: TelemetryEvent;
  readonly server: TelemetryEvent;
  /** The nearest `function` or `route.handler` span above the SQL. */
  readonly handler: TelemetryEvent;
  readonly query: TelemetryEvent;
  /** Every captured event of the interaction's trace. */
  readonly traceEvents: readonly TelemetryEvent[];
  readonly index: ReadonlyMap<string, TelemetryEvent>;
}

/**
 * Locates the click, then walks up from its trace's first reservation
 * statement to it: `db.query` → `function | route.handler` → `http.server` →
 * `fetch` → `interaction`, extra intermediate spans allowed. A missing link
 * fails with the actual chain of kinds and names (`expectAncestorKinds`).
 */
function resolveCheckoutChain(events: readonly TelemetryEvent[]): CheckoutChain {
  const interactions = eventsOfKind(events, 'interaction');
  const clicks = interactions.filter(isPlaceOrderClick);
  expect(
    clicks.length,
    [
      `Expected exactly one captured click on "${PLACE_ORDER_NAME}".`,
      `  interactions: ${describeEvents(interactions)}`,
    ].join('\n'),
  ).toBe(1);
  const interaction = present(clicks[0], 'The place-order click is missing.');

  const traceEvents = events.filter((event) => event.traceId === interaction.traceId);
  const index = expectNoSpanIdCollisions(traceEvents, {
    message: 'The checkout trace reuses span ids.',
  });

  const reservations = eventsOfKind(traceEvents, 'db.query')
    .filter(isReservationQuery)
    .sort(compareEventsCanonical);
  const query = present(
    reservations[0],
    [
      `The checkout trace holds no "${RESERVATION_TABLE}" reservation statement.`,
      `  database spans in the trace: ${describeEvents(eventsOfKind(traceEvents, 'db.query'))}`,
    ].join('\n'),
  );

  const matched = expectAncestorKinds(
    index,
    query,
    [['function', 'route.handler'], 'http.server', 'fetch', 'interaction'],
    {
      sameTrace: true,
      message: 'The reservation SQL does not lead back to the place-order click.',
    },
  );
  const [handler, server, browserFetch, root] = matched;
  expect(
    root?.spanId,
    'The chain climbed to an interaction other than the place-order click.',
  ).toBe(interaction.spanId);

  return {
    interaction,
    browserFetch: present(browserFetch, 'The chain matched no fetch span.'),
    server: present(server, 'The chain matched no http.server span.'),
    handler: present(handler, 'The chain matched no function or route.handler span.'),
    query,
    traceEvents,
    index,
  };
}

// ---------------------------------------------------------------------------
// The demo's source
// ---------------------------------------------------------------------------

/** `export async function reserveStock(` — where the search for the call starts. */
const RESERVATION_DECLARATION_PATTERN = new RegExp(`\\bfunction\\s+${RESERVATION_FUNCTION}\\b`);

/** The next module-level declaration, where the search stops. */
const NEXT_DECLARATION_PATTERN = /^export\s+(?:async\s+)?function\s/;

/**
 * The first `pool.query` call inside {@link RESERVATION_FUNCTION}, found by
 * reading the source rather than remembered, so the demo file can change.
 */
function sqlCallSiteIn(lines: readonly string[]): SqlCallSite | undefined {
  const declaration = lines.findIndex((line) => RESERVATION_DECLARATION_PATTERN.test(line));
  if (declaration < 0) {
    return undefined;
  }
  for (let index = declaration + 1; index < lines.length; index += 1) {
    const text = lines[index];
    if (text === undefined || NEXT_DECLARATION_PATTERN.test(text)) {
      return undefined;
    }
    const offset = text.indexOf(SQL_CALL);
    if (offset >= 0) {
      return { line: index + 1, column: offset + 1, lineLength: text.length };
    }
  }
  return undefined;
}

async function readSqlCallSite(demoApp: DemoAppHandle): Promise<SqlCallSite> {
  const source = await demoApp.readSource(INVENTORY_FILE);
  return present(
    sqlCallSiteIn(source.lines),
    `${INVENTORY_FILE} has no ${SQL_CALL} call inside ${RESERVATION_FUNCTION}; the spec's anchor moved.`,
  );
}

// ---------------------------------------------------------------------------
// Preparing the checkout page through the storefront's own API
// ---------------------------------------------------------------------------

interface CartSnapshot {
  readonly productIds: readonly string[];
  readonly itemCount: number;
}

async function readCart(page: Page, baseUrl: string): Promise<CartSnapshot> {
  const response = await page.request.get(new URL(CART_PATH, baseUrl).href);
  expect(response.ok(), `GET ${CART_PATH} answered HTTP ${String(response.status())}.`).toBe(true);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.lines) || typeof body.itemCount !== 'number') {
    throw new Error(`GET ${CART_PATH} did not answer a cart view.`);
  }
  const lines: readonly unknown[] = body.lines;
  const productIds = lines.map((line) => {
    if (!isRecord(line) || typeof line.productId !== 'string') {
      throw new Error(`GET ${CART_PATH} answered a cart line without a product id.`);
    }
    return line.productId;
  });
  return { productIds, itemCount: body.itemCount };
}

/** Ids of in-stock products on the catalog's first page, in catalog order. */
async function stockedProductIds(page: Page, baseUrl: string): Promise<string[]> {
  const url = new URL(PRODUCTS_PATH, baseUrl);
  url.searchParams.set('pageSize', String(CATALOG_PAGE_SIZE));
  const response = await page.request.get(url.href);
  expect(response.ok(), `GET ${PRODUCTS_PATH} answered HTTP ${String(response.status())}.`).toBe(
    true,
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error(`GET ${PRODUCTS_PATH} did not answer a product page.`);
  }
  const items: readonly unknown[] = body.items;
  return items.flatMap((item) =>
    isRecord(item) &&
    typeof item.id === 'string' &&
    item.stockState === 'IN_STOCK' &&
    typeof item.availableQuantity === 'number' &&
    item.availableQuantity >= REFILL_QUANTITY
      ? [item.id]
      : [],
  );
}

/**
 * Leaves the storefront's cart holding lines. A placed order converts the cart,
 * so an earlier spec (or an earlier run) may have left it empty; it is then
 * refilled the way a shopper fills it, through `POST /api/cart/items`.
 */
async function ensureCheckoutCart(page: Page, baseUrl: string): Promise<CartSnapshot> {
  const current = await readCart(page, baseUrl);
  if (current.productIds.length > 0) {
    return current;
  }
  const candidates = await stockedProductIds(page, baseUrl);
  expect(
    candidates.length,
    `The catalog's first page offers fewer than ${String(REFILL_LINE_COUNT)} in-stock products.`,
  ).toBeGreaterThanOrEqual(REFILL_LINE_COUNT);
  for (const productId of candidates.slice(0, REFILL_LINE_COUNT)) {
    const response = await page.request.post(new URL(CART_ITEMS_PATH, baseUrl).href, {
      data: { operation: 'add', productId, quantity: REFILL_QUANTITY },
    });
    expect(
      response.ok(),
      `Adding a product to the cart answered HTTP ${String(response.status())}.`,
    ).toBe(true);
  }
  const refilled = await readCart(page, baseUrl);
  expect(refilled.productIds.length, 'The refilled cart is still empty.').toBeGreaterThan(0);
  return refilled;
}

/** Opens the checkout page and waits until "Place order" can be pressed. */
async function openCheckoutPage(page: Page, baseUrl: string): Promise<void> {
  await page.goto(new URL(CHECKOUT_PAGE_PATH, baseUrl).href);
  await waitForStreamedContent(page);
  const control = page.locator(PLACE_ORDER_SELECTOR);
  await expect(control, `"${PLACE_ORDER_SELECTOR}" must match exactly one control.`).toHaveCount(1);
  await expect(control).toHaveAccessibleName(PLACE_ORDER_NAME);
  // Enabled once the cart has been read and the shipping quote has settled.
  await expect(control).toBeEnabled({ timeout: E2E_TIMEOUTS.pageReady });
}

/**
 * The reproduction: the click a developer makes, then the page's own answer —
 * the confirmation headline, or the form's danger alert, whose text is the
 * failure. Both are waited on together so a failed order fails fast.
 */
async function placeOrder(
  page: Page,
  service: ServiceHandle,
  editorClient: EditorClientHandle,
  captureId: string,
): Promise<void> {
  const control = page.getByRole('button', { name: PLACE_ORDER_NAME, exact: true });
  await expect(control).toBeEnabled({ timeout: E2E_TIMEOUTS.pageReady });
  await control.click();

  const confirmation = page.getByRole('heading', { name: ORDER_CONFIRMED_HEADLINE, exact: true });
  const failure = page.locator(`${CHECKOUT_FORM_SELECTOR} [role="alert"]`);
  await expect(confirmation.or(failure).first()).toBeVisible({ timeout: E2E_TIMEOUTS.pageReady });
  if (!(await confirmation.isVisible())) {
    const reason = collapseWhitespace(await failure.first().innerText());
    throw new Error(`Placing the order failed on the checkout page: ${reason}`);
  }
  await awaitRecordedOrder(service, editorClient, captureId);
}

/** What {@link awaitRecordedOrder}'s poll answers once the order's trace is stored. */
const ORDER_RECORDED = 'the press, its request and the server span are stored';

/** The kinds that tie the press to the server: the press, its request and the request's handling. */
const ORDER_TRACE_KINDS: readonly TelemetryEvent['kind'][] = Object.freeze([
  'interaction',
  'fetch',
  'http.server',
]);

/**
 * Waits, with the capture still open, until the service has stored the press,
 * the checkout `fetch` it started and the checkout `http.server` span that
 * request produced, all in one trace.
 *
 * The page agent reports a request span once the request settles and ships it
 * on a short batch timer, page → bridge → worker → service, so the page can
 * show its confirmation before the span is stored. A developer stops a capture
 * after seeing the result; stopping in the same breath would summarise the
 * capture without the span that joins the click to the server. This waits on
 * the stored evidence itself, through the data API, never on a timer.
 */
async function awaitRecordedOrder(
  service: ServiceHandle,
  editorClient: EditorClientHandle,
  captureId: string,
): Promise<void> {
  const started = await editorClient.waitFor(
    'capture.started',
    (payload) => payload.captureId === captureId,
  );
  const { sessionId } = started.payload;
  await expect
    .poll(
      async () => {
        const events = (
          await service.queryAllPanelData(sessionId, {
            source: 'events',
            filter: { kinds: [...ORDER_TRACE_KINDS] },
            limit: DATA_QUERY_MAX_LIMIT,
          })
        ).items;
        const joined = events.filter(isPlaceOrderClick).some((click) => {
          const request = events.find(
            (event) =>
              isCheckoutFetch(event) &&
              event.traceId === click.traceId &&
              event.parentSpanId === click.spanId,
          );
          return (
            request !== undefined &&
            events.some(
              (event) =>
                event.kind === 'http.server' &&
                event.parentSpanId === request.spanId &&
                identifiesCheckoutRoute(event),
            )
          );
        });
        // What is stored so far is the received value a timeout reports.
        return joined ? ORDER_RECORDED : `stored so far: ${describeEvents(events)}`;
      },
      {
        message: `The service never stored the press, its ${CHECKOUT_ROUTE} request and that request's http.server span in one trace.`,
        timeout: DEFAULT_WAIT_TIMEOUT_MS,
        intervals: [...POLL_INTERVALS_MS],
      },
    )
    .toBe(ORDER_RECORDED);
}

// ---------------------------------------------------------------------------
// The panel page
// ---------------------------------------------------------------------------

/** Waits up to `timeoutMs` for `locator` to show; `false` when it does not. */
async function appears(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return false;
    }
    throw error;
  }
}

/**
 * A summary region's text, or `''` when the region is absent: the summary
 * renders its "Likely cause" region only when there is a cause to show, and
 * an absent region is what the panel tests then report.
 */
async function regionText(region: Locator): Promise<string> {
  if ((await region.count()) === 0) {
    return '';
  }
  return collapseWhitespace(await region.first().innerText());
}

/** Reads what the settled panel page rendered, for the panel tests to assert. */
async function collectRenderedPanel(panel: PanelHandle): Promise<RenderedPanelEvidence> {
  const { locators } = panel;
  await expect(locators.panelView).toBeVisible({ timeout: DEFAULT_WAIT_TIMEOUT_MS });
  // Waits for every loading state to settle, and throws on an unclassified node.
  const nodeTypes = [...(await locators.renderedNodeTypes())];
  await expectNoPanelErrorState(panel.page);

  const blocks: RenderedBlock[] = [];
  for (const nodeType of CHECKED_NODE_TYPES) {
    const block = locators.panelView.locator(`.${NODE_BLOCK_CLASSES[nodeType]}`);
    const count = await block.count();
    blocks.push({
      nodeType,
      count,
      emptyStates: count === 0 ? 0 : await block.locator(EMPTY_STATE_SELECTOR).count(),
      busy: count === 0 ? 0 : await block.locator(BUSY_SELECTOR).count(),
      textLength: count === 0 ? 0 : collapseWhitespace(await block.first().innerText()).length,
    });
  }

  const reservationRows = await locators.panelView
    .locator(`.${NODE_BLOCK_CLASSES.queryTable}`)
    .getByRole('row')
    .filter({ hasText: RESERVATION_STATEMENT_PATTERN })
    .count();

  return {
    nodeTypes,
    blocks,
    reservationRows,
    nodeErrors: await locators.nodeErrors.count(),
    fallbackBanners: await locators.fallbackBanner.count(),
    observedFacts: await locators.observedFacts.count(),
    likelyCauses: await locators.likelyCauses.count(),
    observedText: await regionText(locators.observedRegion),
    likelyCauseText: await regionText(locators.likelyCauseRegion),
    evidenceChipIds: await locators.panelView
      .locator(EVIDENCE_CHIP_SELECTOR)
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-event-id') ?? ''),
      ),
  };
}

/** What {@link openSqlSource} clicks through and listens with. */
interface OpenSqlSourceOptions {
  readonly panel: PanelHandle;
  readonly editorClient: EditorClientHandle;
  /** The real editor window, whose cursor position is marked just before the click. */
  readonly editorHost: EditorHostHandle;
  readonly sessionId: string;
  /** The line the chip must name: the call site's line in the demo source. */
  readonly line: number;
  /** The captured reservation statements, whose selection opens `EventDetails`. */
  readonly reservationEventIds: readonly string[];
}

/** What {@link openSqlSource} clicked through to. */
interface SqlSourceClick {
  /** The `source.open` the recording editor connection received for the click. */
  readonly sourceOpen: SourceOpenEvidence;
  /** The editor window's record index just before the click, which scopes its cursor wait. */
  readonly editorMark: number;
}

/**
 * Clicks the SQL call site's source chip the way a developer would and returns
 * the `source.open` the recording editor connection received, so the whole
 * outbound path runs: `SourceLink` → `PanelActions.openSource` → the panel's
 * actions → the runtime port → the service worker → WS `source.open` → the
 * service → the session's editor connections — the recorder, whose frame this
 * returns, and the real VS Code window of `editorHost`, whose extension opens
 * the location with `showTextDocument` (read afterwards by
 * {@link observeEditorHop} from the window's record index marked just before
 * the click). Nothing is sent by hand; the warm-up frame the recorder sent
 * itself earlier is never taken for the click's.
 *
 * The ladder, first hit wins:
 *
 * 1. a caller chip on the query table's reservation row;
 * 2. the chip of one of that row's executions, in the detail row its
 *    disclosure toggle opens;
 * 3. the chip in `EventDetails`, after selecting a reservation statement
 *    through its evidence chip (or that detail row's execution selector);
 *
 * Every rung is scoped to the reservation statement, so a chip of another
 * statement can never be the one clicked, and a chip must name the call
 * site's file and line.
 *
 * and otherwise a failure naming every place searched and the chips present.
 */
async function openSqlSource(options: OpenSqlSourceOptions): Promise<SqlSourceClick> {
  const { panel, editorClient, editorHost, sessionId, line } = options;
  const { locators } = panel;
  const queryTable = locators.panelView.locator(`.${NODE_BLOCK_CLASSES.queryTable}`).first();
  const searched: string[] = [];

  const clickThrough = async (
    rung: string,
    scope: Locator,
    waitMs: number,
  ): Promise<SqlSourceClick | undefined> => {
    const chip = locators.sourceLinkByFile(INVENTORY_FILE, { line, within: scope });
    if (waitMs > 0) {
      await appears(chip, waitMs);
    }
    const count = await chip.count();
    searched.push(`${rung}: ${String(count)} chip(s) for ${INVENTORY_FILE}:${String(line)}`);
    if (count === 0) {
      return undefined;
    }
    const sinceIndex = editorClient.snapshotIndex();
    const editorMark = editorHost.snapshotIndex();
    await chip.first().click();
    // The service forwards a `source.open` to the session's editor
    // connections, which can include its sender, so the recorder's own warm-up
    // frame (line 1, column 1) may still be in flight; a call site never sits
    // there.
    const message = await editorClient.waitFor(
      'source.open',
      (payload) => payload.sessionId === sessionId && !isEditorWarmUpLocation(payload.location),
      { sinceIndex, timeoutMs: DEFAULT_WAIT_TIMEOUT_MS },
    );
    return {
      sourceOpen: {
        rung,
        sessionId: message.payload.sessionId,
        location: message.payload.location,
      },
      editorMark,
    };
  };

  // The reservation statement's data row. While it is collapsed no detail row
  // exists, so the first row whose preview shows the statement is the data row.
  const row = queryTable
    .getByRole('row')
    .filter({ hasText: RESERVATION_STATEMENT_PATTERN })
    .first();
  if ((await row.count()) === 0) {
    throw new Error(
      `The query table has no row for the "${RESERVATION_TABLE}" reservation statement.`,
    );
  }

  // 1. The panel has settled, so a caller chip on the row is already rendered.
  const onRow = await clickThrough('query table reservation row', row, 0);
  if (onRow !== undefined) {
    return onRow;
  }

  // 2. Expand the row: each execution in its detail row carries its own call
  //    site. The toggle names that detail row through `aria-controls`.
  let detail: Locator | undefined;
  const toggle = row.locator(COLLAPSED_TOGGLE_SELECTOR).first();
  if ((await toggle.count()) > 0) {
    await toggle.click();
    const expanded = row.locator(EXPANDED_TOGGLE_SELECTOR).first();
    await expect(expanded).toBeVisible();
    const detailRowId = await expanded.getAttribute('aria-controls');
    if (detailRowId !== null && detailRowId.length > 0) {
      detail = queryTable.locator(`[id="${detailRowId}"]`);
      const onExecution = await clickThrough(
        'expanded reservation row',
        detail,
        DEFAULT_WAIT_TIMEOUT_MS,
      );
      if (onExecution !== undefined) {
        return onExecution;
      }
    } else {
      searched.push('expanded reservation row: the toggle names no detail row');
    }
  } else {
    searched.push('expanded reservation row: the row has no collapsed disclosure toggle');
  }

  // 3. Select a reservation statement and use the chip in the event drawer.
  let selected = false;
  for (const eventId of options.reservationEventIds) {
    if (!EVENT_ID_PATTERN.test(eventId)) {
      continue;
    }
    const citation = locators.panelView
      .locator(`${EVIDENCE_LIST_SELECTOR} [data-event-id="${eventId}"]`)
      .first();
    if ((await citation.count()) > 0) {
      await citation.click();
      selected = true;
      break;
    }
  }
  if (!selected && detail !== undefined) {
    const execution = detail.getByRole('button', { name: SELECT_EXECUTION_NAME }).first();
    if ((await execution.count()) > 0) {
      await execution.click();
      selected = true;
    }
  }
  if (selected && (await appears(locators.eventDetails, DEFAULT_WAIT_TIMEOUT_MS))) {
    const inDetails = await clickThrough(
      'event details',
      locators.eventDetails,
      DEFAULT_WAIT_TIMEOUT_MS,
    );
    if (inDetails !== undefined) {
      return inDetails;
    }
  } else {
    searched.push(
      selected
        ? 'event details: the drawer did not open for the selected statement'
        : 'event details: no evidence chip or execution selector selects a reservation statement',
    );
  }

  const chips = await locators.main
    .locator(SOURCE_LINK_SELECTOR)
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label') ?? ''));
  throw new Error(
    [
      `No source chip opens ${INVENTORY_FILE}:${String(line)} (${SQL_CALL} in ${RESERVATION_FUNCTION}).`,
      ...searched.map((entry) => `  searched ${entry}`),
      `  chips on the panel (${String(chips.length)}): ${chips.slice(0, 20).join(' | ') || '(none)'}`,
    ].join('\n'),
  );
}

/** What {@link warmUpEditor} needs. */
interface WarmUpEditorOptions {
  readonly editorHost: EditorHostHandle;
  /** The recording editor connection, which sends the warm-up `source.open` frames. */
  readonly editorClient: EditorClientHandle;
  /** The live session the window must serve. */
  readonly sessionId: string;
  /** The window's launch, started as the workflow began: a failure's message, or `undefined`. */
  readonly starting: Promise<string | undefined>;
}

/**
 * Proves the real editor window is connected to the service for the live
 * session before the chip is clicked. The recording editor connection sends
 * `source.open` for line 1, column 1 of the inventory service file (resent
 * until the window's cursor arrives there, `EditorHostHandle.warmUp`), so the
 * proof rests on the window's own cursor rather than on any acknowledgement
 * from the service. A window that did not start or never arrived is returned
 * as the readiness problem the editor test reports, not thrown: the click and
 * the recorder's payload are still worth collecting.
 */
async function warmUpEditor(options: WarmUpEditorOptions): Promise<EditorReadiness> {
  const { editorHost, editorClient, sessionId } = options;
  const startProblem = await options.starting;
  if (startProblem !== undefined) {
    return { problem: `The VS Code window did not start: ${startProblem}`, attempts: 0 };
  }
  try {
    const warmed = await editorHost.warmUp({
      sender: editorClient,
      sessionId,
      file: INVENTORY_FILE,
    });
    return { problem: undefined, attempts: warmed.attempts };
  } catch (error) {
    return {
      problem: `The VS Code window never served session ${sessionId}: ${messageOf(error)}`,
      attempts: 0,
    };
  }
}

/** What {@link observeEditorHop} reads the window's answer to the click with. */
interface ObserveEditorHopOptions {
  readonly editorHost: EditorHostHandle;
  readonly panel: PanelHandle;
  /** The demo checkout the window opened as its workspace folder. */
  readonly projectRoot: string;
  /** The location the click's `source.open` carried. */
  readonly location: SourceLocation;
  /** The window's record index just before the click ({@link SqlSourceClick.editorMark}). */
  readonly editorMark: number;
  /** Whether the window was proven connected before the click. */
  readonly readiness: EditorReadiness;
}

/**
 * The column VS Code puts the cursor at for `column` on a line `lineLength`
 * characters long: `TextDocument.validatePosition` clamps a column past the
 * line's end to that end. The window opens the file as it is on disk, which
 * is instrumented during the session, so the pristine call site's column may
 * fall past the end of the line now at that number. `lineLength` is -1 when
 * the probe could not read the line, and the column is then taken as it is.
 */
function clampedColumn(column: number, lineLength: number): number {
  return lineLength >= 0 ? Math.min(column, lineLength + 1) : column;
}

/**
 * Reads what the real VS Code window did with the click's `source.open`: waits
 * for its cursor to land in the inventory service file at the location's line
 * and (clamped) column, then checks the panel shows no error state once the
 * editor has answered. Every failure is returned as evidence, never thrown, so
 * only the editor test fails for it.
 */
async function observeEditorHop(options: ObserveEditorHopOptions): Promise<EditorHopEvidence> {
  const { editorHost, panel, location, editorMark, readiness } = options;
  const expectedRealpath = await realpath(path.join(options.projectRoot, INVENTORY_FILE));

  let problem = readiness.problem;
  let landed: EditorSelectionRecord | undefined;
  if (problem === undefined) {
    try {
      landed = await editorHost.waitForSelection({
        file: INVENTORY_FILE,
        sinceIndex: editorMark,
        description: `at ${String(location.line)}:${String(location.column)} (the chip's location)`,
        matches: (candidate) =>
          candidate.line === location.line &&
          candidate.column === clampedColumn(location.column, candidate.lineLength),
      });
    } catch (error) {
      problem = `The VS Code window's cursor never reached the clicked location: ${messageOf(error)}`;
    }
  }

  let after: readonly EditorSelectionRecord[] = [];
  try {
    after = await editorHost.selections(editorMark);
  } catch (error) {
    problem ??= `The VS Code window's cursor positions could not be read: ${messageOf(error)}`;
  }
  const selection =
    landed ?? after.filter((candidate) => candidate.realpath === expectedRealpath).at(-1);

  let panelProblem: string | undefined;
  try {
    await expectNoPanelErrorState(panel.page);
  } catch (error) {
    panelProblem = messageOf(error);
  }

  return {
    problem,
    selection,
    expectedRealpath,
    expectedColumn: clampedColumn(location.column, selection?.lineLength ?? -1),
    observed: after
      .slice(-MAX_OBSERVED_SELECTIONS)
      .map((candidate) => editorHost.describeSelection(candidate)),
    warmUpAttempts: readiness.attempts,
    panelProblem,
  };
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

test.describe('slow checkout interaction', () => {
  test.describe.configure({ mode: 'serial' });

  // Hygiene, not a restoration claim: the `sessions` fixture already ended the
  // workflow's session in test teardown, and ending it again is idempotent. It
  // guarantees nothing stays instrumented even if that teardown was cut short.
  // Only a failure to end is this file's concern; the cleanup verdict itself
  // (`clean`, `conflict`) is `cleanup.spec.ts`'s claim and is attached here.
  test.afterAll(async ({ service }, testInfo) => {
    if (workflowSessionIds.length === 0) {
      return;
    }
    const tracker = createSessionTracker(service);
    for (const sessionId of workflowSessionIds) {
      tracker.register(sessionId);
    }
    const report = await withEditorAnnouncement(service, () => tracker.endAll());
    await testInfo.attach('session-end', { body: report.text, contentType: 'text/plain' });
    expect(
      report.entries
        .filter((entry) => entry.outcome === 'failed')
        .map((entry) => `${entry.sessionId}: ${entry.error ?? 'failed'}`),
      'A workflow session could not be ended.',
    ).toEqual([]);
  });

  test('reproduces the slow checkout through the real pipeline', async ({
    service,
    demoApp,
    appPage,
    panel,
    editorClient,
    editorHost,
    sessions,
  }) => {
    test.setTimeout(WORKFLOW_TIMEOUT_MS);

    // Preconditions: the launcher attached the telemetry preload, and no
    // earlier session left a patch behind — so the source read here is the
    // developer's own.
    demoApp.expectPreloadAttached();
    const markers = await demoApp.findMarkers();
    expect(
      markers.map((finding) => `${finding.file}:${String(finding.line)} ${finding.marker}`),
      'The demo carries instrumentation markers before this session started.',
    ).toEqual([]);
    const sqlCallSite = await readSqlCallSite(demoApp);

    const cart = await ensureCheckoutCart(appPage, demoApp.baseUrl);
    await openCheckoutPage(appPage, demoApp.baseUrl);

    // The real pipeline, in the developer's order: point at the control in the
    // Elements panel (DevTools' `$0`, described by the page agent) → ask, with
    // that element as the question's target → bind → understand, investigate,
    // plan, instrument → ready → select the control again through `$0` so
    // `target.selected` records it on the live session → capture the click →
    // analysis → panel. Pointing first is what lets problem understanding read
    // the element: the service starts Stage 1 as `session.create` returns.
    const outcome = await runDebugSession({
      service,
      editorClient,
      projectRoot: demoApp.projectRoot,
      question: QUESTION,
      panel,
      appPage,
      target: { selector: PLACE_ORDER_SELECTOR },
      selectTargetVia: 'devtools-eval',
      selectBeforeQuestion: true,
      interact: ({ appPage: page, captureId: openCapture }) =>
        placeOrder(page, service, editorClient, openCapture),
      tracker: sessions,
    }).finally(() => {
      for (const sessionId of sessions.registered) {
        if (!workflowSessionIds.includes(sessionId)) {
          workflowSessionIds.push(sessionId);
        }
      }
    });

    const { sessionId } = outcome;
    const captureId = present(outcome.captureId, 'The workflow recorded no capture id.');
    const panelId = present(outcome.panelId, 'The workflow recorded no panel id.');
    const generated = present(outcome.panel, 'The workflow recorded no generated panel.');
    const plan = present(outcome.plan, 'The workflow recorded no instrumentation plan.');
    const armed = present(outcome.instrumentation, 'The workflow saw no instrumentation.ready.');
    const target = present(outcome.target, 'The workflow recorded no selected target.');
    const result = present(outcome.analysis, 'The workflow recorded no analysis.');
    const summary = present(outcome.captureSummary, 'The workflow recorded no capture summary.');

    // Everything below exists only while the session is live: the data API's
    // view of the capture, the journal and the instrumented bytes on disk, the
    // panel page's DOM and the click-to-source round trip.
    const events = (
      await service.queryAllPanelData(sessionId, { source: 'events', limit: DATA_QUERY_MAX_LIMIT })
    ).items;
    const checkoutServers = eventsOfKind(events, 'http.server').filter(identifiesCheckoutRoute);
    expect(
      checkoutServers.length,
      `Expected exactly one http.server span for ${CHECKOUT_ROUTE}; found: ${describeEvents(checkoutServers)}`,
    ).toBe(1);
    const checkoutServer = present(checkoutServers[0], 'The checkout request span is missing.');
    const traceId = checkoutServer.traceId;

    const traceEvents = (
      await service.queryAllPanelData(sessionId, {
        source: 'events',
        filter: { traceId },
        limit: DATA_QUERY_MAX_LIMIT,
      })
    ).items;
    const traceSpans = (
      await service.queryAllPanelData(sessionId, {
        source: 'spans',
        filter: { traceId },
        limit: DATA_QUERY_MAX_LIMIT,
      })
    ).items;
    const tree = (await service.queryPanelData(sessionId, { source: 'trace', filter: { traceId } }))
      .trace;
    const captureMetrics = (await service.queryAllPanelData(sessionId, { source: 'metrics' }))
      .items;
    const traceMetrics = (
      await service.queryAllPanelData(sessionId, { source: 'metrics', filter: { traceId } })
    ).items;
    const currentPanel = await service.getCurrentPanel(sessionId);

    const journal = await service.getModifications(sessionId);
    const instrumentedHashes = new Map<string, string>();
    for (const record of journal) {
      if (record.status === 'applied') {
        instrumentedHashes.set(record.id, await demoApp.hashFile(record.file));
      }
    }

    const published: PublishedMessages = {
      plans: editorClient
        .messagesOf('instrumentation.plan')
        .filter((message) => message.payload.sessionId === sessionId)
        .map((message) => message.payload.plan),
      readyRuntimeHooks: editorClient
        .messagesOf('instrumentation.ready')
        .filter((message) => message.payload.sessionId === sessionId)
        .map((message) => message.payload.runtimeHooks),
      panels: editorClient
        .messagesOf('panel.generated')
        .filter((message) => message.payload.sessionId === sessionId)
        .map((message) => ({ panelId: message.payload.panelId, panel: message.payload.panel })),
      captureStopped: editorClient
        .messagesOf('capture.stopped')
        .some(
          (message) =>
            message.payload.sessionId === sessionId && message.payload.captureId === captureId,
        ),
      analysisCompleted: editorClient
        .messagesOf('analysis.completed')
        .some((message) => message.payload.sessionId === sessionId),
    };

    // The real VS Code window boots only once the pipeline has settled. The
    // extension probes the service once as it activates and connects only when
    // that probe answers, and the session's first stage builds the project's
    // code index synchronously, holding the service's event loop for seconds;
    // a window activating inside that interval would stay disconnected for the
    // rest of the test. It boots while the panel's DOM is collected, and its
    // launch never rejects here: a failure to start becomes the editor test's
    // evidence.
    const editorStarting = editorHost.start().then(
      () => undefined,
      (error: unknown) => messageOf(error),
    );
    const rendered = await collectRenderedPanel(panel);
    const readiness = await warmUpEditor({
      editorHost,
      editorClient,
      sessionId,
      starting: editorStarting,
    });
    const { sourceOpen, editorMark } = await openSqlSource({
      panel,
      editorClient,
      editorHost,
      sessionId,
      line: sqlCallSite.line,
      reservationEventIds: traceEvents.filter(isReservationQuery).map((event) => event.id),
    });
    const editorHop = await observeEditorHop({
      editorHost,
      panel,
      projectRoot: demoApp.projectRoot,
      location: sourceOpen.location,
      editorMark,
      readiness,
    });
    test.info().annotations.push(
      {
        type: 'source-link',
        description: `${sourceOpen.rung} → ${sourceOpen.location.file}:${String(sourceOpen.location.line)} (${sourceOpen.location.resolvedBy})`,
      },
      {
        type: 'editor-hop',
        description:
          editorHop.problem === undefined && editorHop.selection !== undefined
            ? `VS Code cursor at ${editorHost.describeSelection(editorHop.selection)} after ${String(editorHop.warmUpAttempts)} warm-up source.open frame(s)`
            : `VS Code cursor not observed at the location: ${(editorHop.problem ?? 'no cursor position was recorded').split('\n')[0] ?? ''}`,
      },
    );
    // The editor test fails on this evidence while this test passes, so the
    // editor fixture's own failure-only diagnostics would never be taken: the
    // window's text-free diagnostics are attached here, while it still runs.
    if (editorHop.problem !== undefined) {
      const diagnostics = await editorHost
        .collectDiagnostics()
        .catch((error: unknown) => [`The diagnostics could not be collected: ${messageOf(error)}`]);
      await test.info().attach('editor-host-diagnostics', {
        body: diagnostics.join('\n'),
        contentType: 'text/plain',
      });
    }

    // The developer's file, as the dev server serves it during the session: a
    // patch in it moves the call's line, which is worth recording beside the
    // pristine line the location is held to.
    const served = sqlCallSiteIn((await demoApp.readSource(INVENTORY_FILE)).lines);
    if (served !== undefined && served.line !== sqlCallSite.line) {
      test.info().annotations.push({
        type: 'served-sql-line',
        description: `${INVENTORY_FILE}: ${SQL_CALL} is on line ${String(served.line)} while instrumented, line ${String(sqlCallSite.line)} in the developer's source.`,
      });
    }

    session = outcome.session;
    captureSummary = summary;
    captureEvents = events;
    traceTree = present(tree ?? undefined, `The data API served no trace for ${traceId}.`);
    analysis = result;
    panelSpec = generated;
    modifications = journal;
    progressStages = outcome.stages;
    run = {
      sessionId,
      captureId,
      panelId,
      statuses: outcome.statuses,
      plan,
      instrumentation: armed,
      target,
      cartProductIds: cart.productIds,
      checkoutTraceId: traceId,
      traceEvents,
      traceSpans,
      captureMetrics,
      traceMetrics,
      currentPanel,
      published,
      rendered,
      sourceOpen,
      editorHop,
      sqlCallSite,
      instrumentedHashes,
      debuggenHome: service.debuggenHome,
    };
  });

  test('understood the question and armed the checkout path before capture', () => {
    const record = fromWorkflow(session, 'the session record');
    const stages = fromWorkflow(progressStages, 'the progress stream');
    const evidence = fromWorkflow(run, 'the workflow evidence');

    // Stage 2 found both ends of the interaction, as project-relative paths.
    const files = record.relevantFiles.map((entry) => entry.file);
    const listed = files.join(', ') || '(none)';
    for (const file of files) {
      expect(isSafeRelativePath(file), `"${file}" is not a safe project-relative path.`).toBe(true);
    }
    expect(
      files.some((file) => file.endsWith(ROUTE_FILE_SUFFIX)),
      `The relevant files do not include the checkout route handler: ${listed}`,
    ).toBe(true);
    expect(
      files.some((file) => file.includes(CHECKOUT_COMPONENT_DIR)),
      `The relevant files do not include a checkout component: ${listed}`,
    ).toBe(true);

    // Stage 1 read the element the question was asked about: the owner chain
    // it resolved became the understanding's components, which is what Stage 2
    // followed from the control to the route above.
    const understanding = present(record.understanding, 'The session stored no understanding.');
    const components = understanding.entities
      .filter((entity) => entity.kind === 'component')
      .map((entity) => entity.name);
    expect(
      components,
      `Problem understanding did not read the selected element; its entities are: ${understanding.entities.map((entity) => `${entity.kind}:${entity.name}`).join(', ') || '(none)'}`,
    ).toContain(TARGET_COMPONENT);

    // The target came from the page through `$0`, carrying the owner chain.
    const { target } = evidence;
    expect(target.tagName.toLowerCase()).toBe('button');
    expect(target.componentChain, 'The owner chain of the selected element').toContain(
      TARGET_COMPONENT,
    );
    expect(pathOf(target.url)).toBe(CHECKOUT_PAGE_PATH);
    expect(record.target, 'The session stored a different target.').toEqual(target);

    // A validated plan was published and stored.
    const { plan } = evidence;
    const parsed = instrumentationPlanSchema.safeParse(plan);
    expect(
      parsed.success,
      parsed.success
        ? 'The plan validates.'
        : `The plan fails its schema: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    ).toBe(true);
    expect(plan.sessionId).toBe(evidence.sessionId);
    expect(plan.objective.trim().length, 'The plan states no objective.').toBeGreaterThan(0);
    expect(plan.capture.length, 'The plan captures nothing.').toBeGreaterThan(0);
    expect(plan.instrumentationTargets.length, 'The plan has no actions.').toBeGreaterThan(0);
    for (const action of plan.instrumentationTargets) {
      expect(INSTRUMENTATION_MODES).toContain(action.mode);
      expect(isSafeRelativePath(action.file), `Action ${action.id} names an unsafe path.`).toBe(
        true,
      );
      expect(
        action.rationale.trim().length,
        `Action ${action.id} has no rationale.`,
      ).toBeGreaterThan(0);
    }
    expect(evidence.published.plans.at(-1), 'The published instrumentation.plan').toEqual(plan);
    expect(
      record.plans.some((stored) => stored.planVersion === plan.planVersion),
      `The session stores no plan version ${String(plan.planVersion)}.`,
    ).toBe(true);

    // ...and was applied: runtime hooks armed, each gap explained.
    const { instrumentation } = evidence;
    expect(instrumentation.runtimeHooks.length, 'No runtime hook was armed.').toBeGreaterThan(0);
    expect(
      evidence.published.readyRuntimeHooks.at(-1),
      'The published instrumentation.ready',
    ).toEqual(instrumentation.runtimeHooks);
    for (const gap of instrumentation.unavailable) {
      expect(
        gap.reason.trim().length,
        `Unavailable "${gap.signal}" gives no reason.`,
      ).toBeGreaterThan(0);
      expect(gap.hint.trim().length, `Unavailable "${gap.signal}" gives no hint.`).toBeGreaterThan(
        0,
      );
    }

    // The session was armed ("Reproduce the issue now.") before it captured.
    const { statuses } = evidence;
    expect(statuses, 'The session never reached ready').toContain('ready');
    expect(statuses, 'The session failed along the way').not.toContain('failed');
    expect(statuses.indexOf('ready')).toBeLessThan(statuses.lastIndexOf('generated'));
    expect(record.status).toBe('generated');

    // The progress stream came from the pipeline, stage by stage.
    const describeRow = (row: SessionStageRecord): string =>
      `#${String(row.index)} ${row.stage}/${row.status}: ${row.message}`;
    const failures = stages.filter((row) => row.status === 'failed');
    expect(
      failures.filter((row) => row.stage !== 'instrument').map(describeRow),
      'A pipeline stage reported a failure.',
    ).toEqual([]);
    // An instrument-stage failure row is how an unavailable signal is reported.
    expect(
      failures.length,
      `More failed signal rows than unavailable signals: ${failures.map(describeRow).join('; ')}`,
    ).toBeLessThanOrEqual(instrumentation.unavailable.length);

    let previousFirst = -1;
    for (const stage of PLANNING_STAGES) {
      const rows = stages.filter((row) => row.stage === stage);
      expect(rows.length, `The ${stage} stage reported no progress.`).toBeGreaterThan(0);
      expect(
        rows.some((row) => row.status === 'done'),
        `The ${stage} stage never completed: ${rows.map(describeRow).join('; ')}`,
      ).toBe(true);
      const first = Math.min(...rows.map((row) => row.index));
      expect(first, `The ${stage} stage started out of order.`).toBeGreaterThan(previousFirst);
      previousFirst = first;
    }

    const instrumentRows = stages.filter((row) => row.stage === 'instrument');
    const doneMessages = instrumentRows
      .filter((row) => row.status === 'done')
      .map((row) => row.message);
    for (const label of ARMED_SIGNAL_LABELS) {
      expect(doneMessages, `"${label}" was not reported armed.`).toContain(label);
    }
    const ready = present(
      instrumentRows.find(
        (row) => row.status === 'done' && READY_TO_CAPTURE_PATTERN.test(row.message),
      ),
      `The instrument stage never reported "Ready to capture": ${instrumentRows.map(describeRow).join('; ')}`,
    );
    expect(ready.index, '"Ready to capture" arrived before planning started.').toBeGreaterThan(
      previousFirst,
    );
    const later = stages.filter((row) => LATER_STAGES.some((stage) => stage === row.stage));
    for (const row of later) {
      expect(row.index, `${describeRow(row)} arrived before "Ready to capture".`).toBeGreaterThan(
        ready.index,
      );
    }
    expect(evidence.published.captureStopped, 'No capture.stopped reached the editor.').toBe(true);
    expect(evidence.published.analysisCompleted, 'No analysis.completed reached the editor.').toBe(
      true,
    );
  });

  test('correlates the click, the checkout request, the route and the SQL in one trace', () => {
    const events = fromWorkflow(captureEvents, 'the captured events');
    const evidence = fromWorkflow(run, 'the workflow evidence');
    const { interaction, browserFetch, server, handler, query, traceEvents } =
      resolveCheckoutChain(events);

    // The click on the control starts the trace, in the browser.
    expect(interaction.tier).toBe('browser');
    expect(interaction.parentSpanId, 'The click span has a parent.').toBeUndefined();
    expectHexId(interaction.traceId, 32, 'the interaction traceId');
    expect(interaction.traceId, 'The click and the checkout request are in different traces.').toBe(
      evidence.checkoutTraceId,
    );
    for (const event of traceEvents) {
      expectHexId(event.spanId, 16, `the spanId of ${describeEvent(event)}`);
      if (event.parentSpanId !== undefined) {
        expectHexId(event.parentSpanId, 16, `the parentSpanId of ${describeEvent(event)}`);
      }
    }

    // The request left the page carrying the click's trace context...
    expect(
      isCheckoutFetch(browserFetch),
      `${describeEvent(browserFetch)} is not the page's POST ${CHECKOUT_ROUTE}.`,
    ).toBe(true);
    expect(browserFetch.tier).toBe('browser');

    // ...and started exactly one server span of the same trace, as its child.
    const checkoutServers = eventsOfKind(traceEvents, 'http.server').filter(
      identifiesCheckoutRoute,
    );
    expect(
      checkoutServers.map((event) => event.spanId),
      `Expected one http.server span for ${CHECKOUT_ROUTE} in the trace: ${describeEvents(checkoutServers)}`,
    ).toEqual([server.spanId]);
    expect(server.tier).toBe('server');
    expect(server.traceId).toBe(interaction.traceId);
    expect(
      server.parentSpanId,
      `${describeEvent(server)} was not started from the browser's fetch span.`,
    ).toBe(browserFetch.spanId);
    expect(['function', 'route.handler']).toContain(handler.kind);
    expect(handler.tier).toBe('server');

    // The SQL ran in the database tier, as parameterized text.
    expect(query.tier).toBe('db');
    expect(
      stringAttribute(query, DB_SYSTEM)?.trim().length ?? 0,
      `${describeEvent(query)} names no ${DB_SYSTEM}.`,
    ).toBeGreaterThan(0);

    // Privacy, on every reservation statement the click caused (one per cart
    // line) and on every database span of the trace. Failure text reports
    // flags, never the statement.
    const reservations = traceEvents.filter(isReservationQuery);
    for (const reservation of reservations) {
      const statement = present(
        statementOf(reservation),
        `${describeEvent(reservation)} has no statement.`,
      );
      const label = describeEvent(reservation);
      expect(statement.includes('$1'), `${label}: the statement is not parameterized.`).toBe(true);
      expect(
        statement.includes(RESERVATION_LITERAL),
        `${label}: an inline string literal survived redaction.`,
      ).toBe(false);
      expect(
        statement.includes(REDACTION_MASK),
        `${label}: the statement's inline literals are not masked with "${REDACTION_MASK}".`,
      ).toBe(true);
    }
    for (const database of eventsOfKind(traceEvents, 'db.query')) {
      const label = describeEvent(database);
      const statement = statementOf(database) ?? '';
      expect(statement.includes("'"), `${label}: a quoted literal survived redaction.`).toBe(false);
      expect(
        NUMERIC_LITERAL_PATTERN.test(statement),
        `${label}: a numeric literal survived redaction.`,
      ).toBe(false);
      const rowCount = database.attributes[DB_ROW_COUNT];
      expect(
        rowCount === undefined || typeof rowCount === 'number',
        `${label}: ${DB_ROW_COUNT} is not a count.`,
      ).toBe(true);
      expect(
        Object.keys(database.attributes).filter((key) => PAYLOAD_ATTRIBUTE_PATTERN.test(key)),
        `${label}: the span carries result, parameter or body attributes.`,
      ).toEqual([]);
      const serialized = JSON.stringify(database);
      expect(
        evidence.cartProductIds.filter((productId) => serialized.includes(productId)).length,
        `${label}: a request value (a cart product id) appears on the span.`,
      ).toBe(0);
    }
  });

  test('serves a trace tree that agrees with the flat event list', () => {
    const tree = fromWorkflow(traceTree, 'the trace tree');
    const events = fromWorkflow(captureEvents, 'the captured events');
    const evidence = fromWorkflow(run, 'the workflow evidence');
    const chain = resolveCheckoutChain(events);

    expect(tree.traceId).toBe(chain.interaction.traceId);
    expect(tree.truncated, 'The trace tree was truncated.').toBe(false);
    expect(tree.duplicateSpanIds, 'The trace tree dropped duplicate span ids.').toEqual([]);

    // One root: the click.
    expect(
      tree.roots.map((root) => describeEvent(root.event)),
      'The trace has more than one root.',
    ).toHaveLength(1);
    const root = present(tree.roots[0], 'The trace tree has no root.');
    expect(root.event.spanId).toBe(chain.interaction.spanId);
    expect(root.orphaned).toBe(false);

    // The same spans as the flat list, however it was fetched.
    const treeIds = flattenTrace(tree)
      .map((event) => event.spanId)
      .sort();
    const flatIds = chain.traceEvents.map((event) => event.spanId).sort();
    const filteredIds = evidence.traceEvents.map((event) => event.spanId).sort();
    expect(treeIds, 'The tree and the capture disagree on the spans of the trace.').toEqual(
      flatIds,
    );
    expect(filteredIds, 'A traceId-filtered events query disagrees with the tree.').toEqual(
      treeIds,
    );
    expect(tree.nodeCount).toBe(treeIds.length);
    const treeIdSet = new Set(treeIds);
    expect(
      evidence.traceSpans.filter((span) => !treeIdSet.has(span.spanId)).map(describeEvent),
      'The spans query returned spans the tree does not hold.',
    ).toEqual([]);

    // Structure: parent links, depth, and canonical sibling order.
    const violations: string[] = [];
    walkTrace(tree, (node, parent) => {
      if (parent !== undefined && !node.orphaned) {
        if (node.event.parentSpanId !== parent.event.spanId) {
          violations.push(
            `${describeEvent(node.event)} hangs under ${describeEvent(parent.event)}`,
          );
        }
        if (node.depth !== parent.depth + 1) {
          violations.push(`${describeEvent(node.event)} has depth ${String(node.depth)}`);
        }
      }
      node.children.forEach((child, position) => {
        const previous = node.children[position - 1];
        if (previous === undefined) {
          return;
        }
        if (
          previous.event.startTime > child.event.startTime ||
          compareEventsCanonical(previous.event, child.event) > 0
        ) {
          violations.push(
            `${describeEvent(child.event)} is ordered after ${describeEvent(previous.event)}`,
          );
        }
      });
    });
    expect(violations, 'The trace tree is not in canonical order.').toEqual([]);

    // No span on the checkout chain was attached as an orphan.
    for (const event of [
      chain.interaction,
      chain.browserFetch,
      chain.server,
      chain.handler,
      chain.query,
    ]) {
      const node = present(
        findNodeBySpanId(tree, event.spanId),
        `${describeEvent(event)} is missing from the trace tree.`,
      );
      expect(node.orphaned, `${describeEvent(event)} is flagged as an orphan.`).toBe(false);
    }
    if (tree.orphanCount > 0) {
      test.info().annotations.push({
        type: 'trace-orphans',
        description: `${String(tree.orphanCount)} span(s) of the checkout trace arrived without their parent.`,
      });
    }
  });

  test('records epoch-millisecond times and nests each span inside its parent', () => {
    const record = fromWorkflow(session, 'the session record');
    const tree = fromWorkflow(traceTree, 'the trace tree');
    const events = fromWorkflow(captureEvents, 'the captured events');
    const evidence = fromWorkflow(run, 'the workflow evidence');
    const chain = resolveCheckoutChain(events);

    // Epoch milliseconds: inside the service's own capture window. Seconds or
    // microseconds would miss it by three orders of magnitude.
    const capture = present(
      record.captures.find((entry) => entry.id === evidence.captureId),
      `The session stores no capture ${evidence.captureId}.`,
    );
    const stoppedAt = present(capture.stoppedAt, `Capture ${evidence.captureId} never stopped.`);
    const windowStart = capture.startedAt - CAPTURE_WINDOW_TOLERANCE_MS;
    const windowEnd = stoppedAt + CAPTURE_WINDOW_TOLERANCE_MS;
    for (const event of chain.traceEvents) {
      const label = describeEvent(event);
      expect(Number.isFinite(event.startTime), `${label}: startTime is not finite.`).toBe(true);
      expect(event.startTime, `${label}: startTime is not epoch milliseconds.`).toBeGreaterThan(
        MIN_EPOCH_MS,
      );
      expect(event.startTime, `${label} starts before the capture.`).toBeGreaterThanOrEqual(
        windowStart,
      );
      expect(
        event.startTime + event.duration,
        `${label} ends after the capture.`,
      ).toBeLessThanOrEqual(windowEnd);
      expect(event.duration, `${label}: the duration is negative.`).toBeGreaterThanOrEqual(0);
    }

    // Durations are measured, not defaulted, on the tiers of the request.
    for (const event of [chain.browserFetch, chain.server, chain.query]) {
      expect(event.duration, `${describeEvent(event)} has no duration.`).toBeGreaterThan(0);
    }

    // Every child lies inside its parent's window, across the whole trace tree
    // (orphans excepted: their parent never arrived). Two parent/child
    // relations are ordered in time rather than nested, by the telemetry
    // model's own definition:
    // - an interaction span measures the click's handler, and the work it
    //   starts (the request, the renders) outlives it;
    // - an async continuation (a commit after a response settled) is parented
    //   to the request it follows, and so begins after that request ends.
    // For those, the child must not start before its parent.
    const violations: string[] = [];
    let nested = 0;
    walkTrace(tree, (node, parent) => {
      if (parent === undefined || node.orphaned) {
        return;
      }
      const child = node.event;
      const owner = parent.event;
      const orderedOnly = owner.kind === 'interaction' || isAsyncContinuation(child);
      if (orderedOnly) {
        if (child.startTime < owner.startTime - toleranceBetween(owner, child)) {
          violations.push(`${describeEvent(child)} starts before ${describeEvent(owner)}`);
        }
        return;
      }
      nested += 1;
      const violation = containmentViolation(owner, child);
      if (violation !== undefined) {
        violations.push(violation);
      }
    });
    expect(violations, 'A span of the checkout trace escapes its parent.').toEqual([]);

    // The request's own spans are among those checked for nesting: the server
    // span in the fetch's window, the handler in the server span's, the SQL in
    // the handler's — at least the three links above the fetch.
    let hops = 0;
    for (let link = chain.query; link.spanId !== chain.browserFetch.spanId; hops += 1) {
      expect(hops, 'The parent walk did not reach the fetch span.').toBeLessThan(chain.index.size);
      const parentSpanId = present(link.parentSpanId, `${describeEvent(link)} has no parent.`);
      link = present(
        chain.index.get(parentSpanId),
        `The parent of ${describeEvent(link)} was not captured.`,
      );
    }
    expect(hops, 'The SQL is fewer than three links below the fetch.').toBeGreaterThanOrEqual(3);
    expect(
      nested,
      'Fewer spans were checked for nesting than the chain holds.',
    ).toBeGreaterThanOrEqual(hops);
    expect(
      chain.browserFetch.startTime,
      'The checkout request starts before the click.',
    ).toBeGreaterThanOrEqual(
      chain.interaction.startTime - toleranceBetween(chain.interaction, chain.browserFetch),
    );
  });

  test('reports per-tier durations for the interaction', () => {
    const summary = fromWorkflow(captureSummary, 'the capture summary');
    const evidence = fromWorkflow(run, 'the workflow evidence');

    expect(summary.captureId).toBe(evidence.captureId);
    expect(summary.traceIds, 'The capture summary does not list the checkout trace.').toContain(
      evidence.checkoutTraceId,
    );

    for (const id of TIER_METRICS) {
      expectMetricAvailable(evidence.captureMetrics, id, { message: 'Across the capture:' });
      expect(
        evidence.traceMetrics.find((metric) => metric.id === id)?.unit,
        `${id} is not reported in milliseconds.`,
      ).toBe('milliseconds');
    }

    // Scoped to the click's trace, as the panel's metric cards read them.
    const scoped = { message: 'For the checkout trace:' };
    const total = expectMetricAvailable(evidence.traceMetrics, 'total_duration', scoped);
    const frontend = expectMetricAvailable(evidence.traceMetrics, 'frontend_duration', scoped);
    const backend = expectMetricAvailable(evidence.traceMetrics, 'backend_duration', scoped);
    const database = expectMetricAvailable(evidence.traceMetrics, 'database_duration', scoped);
    expect(database, 'No database time was attributed to the checkout.').toBeGreaterThan(0);
    expect(backend, 'Database time exceeds the server time it nests in.').toBeGreaterThanOrEqual(
      database,
    );
    expect(
      frontend + backend,
      'The frontend and backend parts exceed the interaction they divide.',
    ).toBeLessThanOrEqual(total + CROSS_PRODUCER_TOLERANCE_MS);

    const captureDatabase = expectMetricAvailable(evidence.captureMetrics, 'database_duration');
    const captureBackend = expectMetricAvailable(evidence.captureMetrics, 'backend_duration');
    expect(captureDatabase).toBeGreaterThan(0);
    expect(captureBackend).toBeGreaterThanOrEqual(captureDatabase);
  });

  test('generated a validated panel with a timeline, a flame or waterfall view and a query table', () => {
    const spec = fromWorkflow(panelSpec, 'the generated panel');
    const evidence = fromWorkflow(run, 'the workflow evidence');

    // The product's own validator accepts it, and it is not the fallback view,
    // which is never acceptance evidence.
    expectValidPanelSpec(spec, { message: 'The generated panel:' });
    const validated = validatePanelSpec(spec);
    expect(validated.ok, 'validatePanelSpec rejects the generated panel.').toBe(true);
    expect(spec.meta?.fallback ?? false, 'The generated panel is the fallback view.').toBe(false);
    expect(spec.id).toBe(evidence.panelId);
    expect(spec.sessionId).toBe(evidence.sessionId);

    // One spec, however it is read: the panel.generated payload and the
    // service's current panel.
    const announced = present(
      evidence.published.panels.at(-1),
      'No panel.generated reached the editor for the session.',
    );
    expect(announced.panelId).toBe(evidence.panelId);
    expect(announced.panel, 'The panel.generated payload').toEqual(spec);
    expect(evidence.currentPanel, 'GET /sessions/:id/panel').toEqual(spec);

    // Its nodes are catalogued, and include what a slow interaction needs.
    const types = new Set<PanelNodeType>();
    const uncatalogued: string[] = [];
    walkPanelNodes(spec.layout, (node) => {
      types.add(node.type);
      if (!isKnownPanelNodeType(node.type) || !Object.hasOwn(PANEL_NODE_CATALOG, node.type)) {
        uncatalogued.push(node.type);
      }
    });
    expect(uncatalogued, 'The panel uses node types the catalog does not define.').toEqual([]);
    expectNodeTypes(spec, ['timeline', 'queryTable'], { message: 'The slow-interaction panel:' });
    const hierarchy = expectAnyNodeType(spec, ['flame', 'waterfall'], {
      message: 'The slow-interaction panel:',
    });

    // The panel page rendered exactly those nodes, each with content: no
    // registry miss, no error state, no empty or still-loading block.
    const { rendered } = evidence;
    expect([...rendered.nodeTypes].sort(), 'The rendered node types').toEqual([...types].sort());
    expect(rendered.nodeErrors, 'The renderer failed to render a node.').toBe(0);
    expect(rendered.fallbackBanners, 'The panel page shows the fallback banner.').toBe(0);
    for (const nodeType of ['timeline', 'queryTable', hierarchy] as const) {
      const block = present(
        rendered.blocks.find((entry) => entry.nodeType === nodeType),
        `No rendered block was read for ${nodeType}.`,
      );
      expect(block.count, `The ${nodeType} node is not on the panel page.`).toBeGreaterThan(0);
      expect(block.emptyStates, `The ${nodeType} node rendered an empty state.`).toBe(0);
      expect(block.busy, `The ${nodeType} node is still loading.`).toBe(0);
      expect(block.textLength, `The ${nodeType} node rendered no content.`).toBeGreaterThan(0);
    }
    expect(
      rendered.reservationRows,
      'The query table has no row for the reservation statement.',
    ).toBeGreaterThan(0);
  });

  test('keeps observed facts and likely causes apart, each backed by captured evidence', () => {
    const spec = fromWorkflow(panelSpec, 'the generated panel');
    const result = fromWorkflow(analysis, 'the analysis');
    const events = fromWorkflow(captureEvents, 'the captured events');
    const evidence = fromWorkflow(run, 'the workflow evidence');
    const { observed, likelyCauses, headline } = spec.summary;

    expect(result.sessionId).toBe(evidence.sessionId);
    expect(result.captureId).toBe(evidence.captureId);
    expectFactsAndHypothesesSeparate(result, { message: 'The analysis:' });
    expectEvidenceResolves(result, events, { message: 'The analysis:' });
    expectEvidenceResolves(spec, events, { message: 'The panel summary:' });

    // Observed facts are evidenced objects copied from the analysis, never the
    // non-evidentiary headline promoted into a fact.
    expect(observed.length, 'The panel reports no observed facts.').toBeGreaterThan(0);
    const analysedStatements = new Set(result.observed.map((fact) => fact.statement));
    for (const fact of observed) {
      expect(typeof fact, 'An observed fact is not an evidenced object.').toBe('object');
      expect(fact.statement.trim().length, 'An observed fact states nothing.').toBeGreaterThan(0);
      expect(fact.evidence.length, `"${fact.statement}" cites no evidence.`).toBeGreaterThan(0);
      expect(
        analysedStatements.has(fact.statement),
        `"${fact.statement}" is not a fact of the analysis.`,
      ).toBe(true);
      if (headline !== undefined) {
        expect(fact.statement, 'The headline was promoted into an observed fact.').not.toBe(
          headline,
        );
      }
    }

    // Likely causes carry a confidence, and at least one says where to look.
    expect(likelyCauses.length, 'The panel names no likely cause.').toBeGreaterThan(0);
    for (const cause of likelyCauses) {
      expect(CONFIDENCE_LEVELS).toContain(cause.confidence);
    }
    const located = likelyCauses.filter((cause) => cause.suggestedLocation !== undefined);
    expect(located.length, 'No likely cause suggests a source location.').toBeGreaterThan(0);
    for (const cause of located) {
      expectSourceLocationShape(cause.suggestedLocation, {
        message: `The suggested location of "${cause.statement}":`,
      });
    }

    // On the page, the two lists render in their own regions.
    const { rendered } = evidence;
    expect(rendered.observedFacts, 'Observed facts on the page').toBe(observed.length);
    expect(rendered.likelyCauses, 'Likely causes on the page').toBe(likelyCauses.length);
    for (const fact of observed) {
      expect(rendered.observedText, 'The "Observed" region').toContain(
        collapseWhitespace(fact.statement),
      );
    }
    for (const cause of likelyCauses) {
      const statement = collapseWhitespace(cause.statement);
      expect(rendered.likelyCauseText, 'The "Likely cause" region').toContain(statement);
      if (!observed.some((fact) => collapseWhitespace(fact.statement).includes(statement))) {
        expect(rendered.observedText, 'A likely cause is shown as an observed fact.').not.toContain(
          statement,
        );
      }
    }
    const known = new Set(events.map((event) => event.id));
    expect(
      rendered.evidenceChipIds.filter((eventId) => !known.has(eventId)),
      'Evidence chips cite events the capture does not hold.',
    ).toEqual([]);
  });

  test('opens the demo SQL call site in the editor from the query table', () => {
    const events = fromWorkflow(captureEvents, 'the captured events');
    const evidence = fromWorkflow(run, 'the workflow evidence');
    const { sourceOpen, editorHop, sqlCallSite } = evidence;

    // The service forwarded the click, for this session, at the SQL call site.
    expect(sourceOpen.sessionId).toBe(evidence.sessionId);
    const location = expectSourceLocationShape(sourceOpen.location, {
      expectedFile: INVENTORY_FILE,
      expectedLine: sqlCallSite.line,
      expectedSymbol: sourceOpen.location.symbol === undefined ? undefined : RESERVATION_FUNCTION,
      message: `The source.open reached through "${sourceOpen.rung}":`,
    });
    expect(path.isAbsolute(location.file)).toBe(false);
    expect(location.file.split('/')).not.toContain('..');
    // The column is the call's own: where `pool.query` starts on its line in
    // the developer's source, read from that source before the session began.
    expect(
      location.column,
      `The source.open does not point at the start of ${SQL_CALL} on its line.`,
    ).toBe(sqlCallSite.column);

    // The click carried the resolver's answer for the captured statement.
    const { traceEvents } = resolveCheckoutChain(events);
    const resolved = traceEvents
      .filter(isReservationQuery)
      .flatMap((event) => (event.source === undefined ? [] : [event.source]));
    if (resolved.length > 0) {
      expect(
        resolved,
        'The chip opened a location no reservation statement resolved to.',
      ).toContainEqual(location);
    }

    // The real VS Code window opened it: after the click its cursor sits in
    // the demo's inventory service file on the pristine call-site line, at the
    // call's own column — derived from the source, not from the click — which
    // VS Code clamps only to the end of the line as it stands on disk.
    const observed = `The window recorded after the click: ${editorHop.observed.join(', ') || '(no cursor position)'}; it needed ${String(editorHop.warmUpAttempts)} warm-up source.open frame(s).`;
    expect(editorHop.problem, `The VS Code window did not open the location. ${observed}`).toBe(
      undefined,
    );
    const selection = present(
      editorHop.selection,
      `The VS Code window recorded no cursor position in ${INVENTORY_FILE}. ${observed}`,
    );
    expect(selection.realpath, `The cursor is in another document. ${observed}`).toBe(
      editorHop.expectedRealpath,
    );
    expect(selection.line, `The cursor is not on the ${SQL_CALL} line. ${observed}`).toBe(
      sqlCallSite.line,
    );
    expect(
      selection.column,
      `The cursor is not at the start of ${SQL_CALL} on its line. ${observed}`,
    ).toBe(clampedColumn(sqlCallSite.column, selection.lineLength));
    expect(editorHop.expectedColumn, 'The click and the call site disagree on the column.').toBe(
      clampedColumn(sqlCallSite.column, selection.lineLength),
    );
    expect(
      editorHop.panelProblem,
      'The panel shows an error state after the editor opened the location.',
    ).toBeUndefined();
  });

  test('journalled a reversible patch with a backup outside the repository', () => {
    const records = fromWorkflow(modifications, 'the modification journal');
    const evidence = fromWorkflow(run, 'the workflow evidence');

    const applied = records.filter((record) => record.status === 'applied');
    expect(
      applied.length,
      `No modification is applied while the session is live: ${
        records.map((record) => `${record.file} ${record.status}`).join(', ') || '(none)'
      }`,
    ).toBeGreaterThan(0);

    const patchTargets = new Set(
      evidence.plan.instrumentationTargets
        .filter((action) => action.mode === 'patch')
        .map((action) => action.file),
    );
    const home = path.resolve(evidence.debuggenHome);
    const repository = path.resolve(repoRoot());
    // A file patched for more than one action carries a chain of records: each
    // later link takes the previous link's instrumented content as its original
    // (`previousRecordId`), so only the newest link describes the bytes on disk.
    const appliedById = new Map(applied.map((record) => [record.id, record]));
    const superseded = new Set(
      applied.flatMap((record) =>
        record.previousRecordId === undefined ? [] : [record.previousRecordId],
      ),
    );
    for (const record of applied) {
      const label = `${record.file} (${record.id})`;
      expect(record.sessionId).toBe(evidence.sessionId);
      expect(isSafeRelativePath(record.file), `${label}: unsafe path.`).toBe(true);
      expect(patchTargets.has(record.file), `${label} is not a patch target of the plan.`).toBe(
        true,
      );

      // Both hashes, and the file on disk is the instrumented one.
      expect(record.originalHash, `${label}: originalHash`).toMatch(SHA256_HEX_PATTERN);
      expect(record.instrumentedHash, `${label}: instrumentedHash`).toMatch(SHA256_HEX_PATTERN);
      expect(record.instrumentedHash, `${label}: the patch changed nothing.`).not.toBe(
        record.originalHash,
      );
      if (record.previousRecordId !== undefined) {
        const previous = appliedById.get(record.previousRecordId);
        expect(
          previous?.file,
          `${label}: its previous link ${record.previousRecordId} is not an applied record of the same file.`,
        ).toBe(record.file);
        expect(
          record.originalHash,
          `${label}: it does not continue its previous link's instrumented content.`,
        ).toBe(previous?.instrumentedHash);
      }
      if (!superseded.has(record.id)) {
        expect(
          evidence.instrumentedHashes.get(record.id),
          `${label}: the file on disk is not the instrumented content.`,
        ).toBe(record.instrumentedHash);
      }

      // The original bytes are kept under $DEBUGGEN_HOME, outside every checkout.
      const backup = path.resolve(record.backupPath);
      const insideHome = path.relative(home, backup);
      expect(path.isAbsolute(record.backupPath), `${label}: the backup path is relative.`).toBe(
        true,
      );
      expect(
        insideHome !== '' && !insideHome.startsWith('..') && !path.isAbsolute(insideHome),
        `${label}: the backup is not under $DEBUGGEN_HOME.`,
      ).toBe(true);
      expect(
        path.relative(repository, backup).startsWith('..'),
        `${label}: the backup is inside the repository.`,
      ).toBe(true);
      expect(path.basename(backup), `${label}: the backup is not named by its hash.`).toBe(
        record.originalHash,
      );

      // A reviewable diff that adds the wrapper.
      const added = record.diff
        .split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
      expect(record.diff.trim().length, `${label}: the diff is empty.`).toBeGreaterThan(0);
      expect(added.length, `${label}: the diff adds nothing.`).toBeGreaterThan(0);
    }

    // instrumentation.ready announced journalled records.
    const journalled = new Set(records.map((record) => record.id));
    expect(
      evidence.instrumentation.applied
        .map((record) => record.id)
        .filter((recordId) => !journalled.has(recordId)),
      'instrumentation.ready announced modifications the journal does not hold.',
    ).toEqual([]);
  });
});
