/**
 * Seeded defect 2 of the demo — excessive renders — proven end to end for
 * "Why is this component rendering so many times?" against the Lumen Supply
 * catalog (docs/DEMO.md, Walkthrough 2 and "Defect 2 — excessive renders").
 *
 * What a pass proves, all through the real pipeline and a real capture:
 *
 * 1. **The question was understood as a render problem.** The card selected
 *    through the product's `$0` path resolves to `ProductCard` inside
 *    `CatalogGrid`, the investigation names both files, and the plan arms the
 *    React adapter's runtime render tracking.
 * 2. **Renders accumulate with no user input.** The capture is left idle: the
 *    shipping-ETA provider ticks every 250 ms, the cart provider hands out a new
 *    value on each of those renders, and every card re-renders through the cart
 *    context. The capture holds no interaction at all.
 * 3. **Per-component counts and trigger attribution.** The render statistics
 *    count the card's repeated renders, attribute them to their triggers, and
 *    keep `unchanged` (props shallow-equal, own hook state unchanged, no
 *    consumed context changed) and `unknown` (a classification input
 *    unavailable) as distinct outcomes — in every statistic, in the metrics and
 *    in the panel.
 * 4. **The evidence is privacy-safe and correlated.** Changed props travel as
 *    key names with bounded summaries only; every render event is a browser
 *    span with a component, a phase and trace context.
 * 5. **The panel is materially different from the slow-interaction panel**
 *    (docs/DEMO.md, "How the three panels differ"). The slow-interaction
 *    baseline is derived IN THIS FILE — this spec runs before
 *    `demo-slow-interaction.spec.ts`, so it never depends on that one — and
 *    the two panels share only the permitted nodes (`metricCards`,
 *    `sourceLink`): their visualization bodies are disjoint and even their
 *    metric cards differ.
 *
 * What this spec does not re-test: the renderer's component behaviour
 * (`packages/panel-renderer/src/components/RenderTable.test.tsx`) and the
 * fiber-diff semantics (`packages/telemetry/src/browser/fiber-diff.test.ts`).
 * Its contribution is that a real capture of a real page yields those numbers
 * and a materially different panel.
 *
 * Instrumentation arrives only through the real installer and leaves only
 * through the real cleanup: nothing here writes to `apps/demo-app`, and
 * `afterAll` proves every tracked demo file is byte-identical to its
 * pre-session content. `tests/e2e/**` is excluded from the no-hardcoding
 * guard, which is why the demo's component names appear below.
 */

import type { Frame, Locator, Page } from '@playwright/test';

import { DATA_QUERY_MAX_LIMIT, walkPanelNodes } from '@debuggen/panel-schema';
import type { DataQueryFilter } from '@debuggen/panel-schema';
import type { AnalysisResult } from '@debuggen/protocol';
import type { SourceLocation } from '@debuggen/shared';
import {
  ATTRIBUTE_VALUE_TYPES,
  LINEAGE_VALUES,
  MAX_PREVIEW_LENGTH,
  MAX_TRACKED_KEYS,
  RENDER_PHASES,
  RENDER_TRIGGERS,
  containsDenied,
} from '@debuggen/telemetry';
import type {
  ComponentTreeNode,
  ComponentTreeSnapshot,
  MetricId,
  MetricValue,
  RenderStat,
  RenderTrigger,
  StateTransition,
  TelemetryEvent,
} from '@debuggen/telemetry';

import {
  E2E_TIMEOUTS,
  PERMITTED_VISUALIZATION_OVERLAP,
  createSessionTracker,
  describeEvent,
  eventsOfKind,
  expect,
  expectAnyNodeType,
  expectDisjointVisualizations,
  expectEvidenceResolves,
  expectFactsAndHypothesesSeparate,
  expectHexId,
  expectMetricAvailable,
  expectNoPanelErrorState,
  expectNoSpanIdCollisions,
  expectNodeTypes,
  expectRenderStat,
  expectRenderTrigger,
  expectSourceLocationShape,
  expectValidPanelSpec,
  generatePanelNodeTypes,
  nodeTypesOf,
  runDebugSession,
  test,
  visualizationNodeTypesOf,
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
  TrackedFileSnapshot,
} from './helpers/fixtures';
import {
  waitForOrderableCheckout,
  waitForStreamedContent,
  withEditorAnnouncement,
} from './helpers/demo-app';

// ---------------------------------------------------------------------------
// The questions, the targets and the demo's observable surface
// ---------------------------------------------------------------------------

/** The developer's question, verbatim from `docs/DEMO.md` Walkthrough 2. */
const QUESTION = 'Why is this component rendering so many times?';

/** The slow-interaction question the comparison baseline asks (`docs/DEMO.md` Walkthrough 1). */
const BASELINE_QUESTION = 'Why is this button slow?';

/** What the composition assertions prove, for their failure text. */
const COMPOSITION_CONTEXT = `The render panel composition for "${QUESTION}" versus "${BASELINE_QUESTION}"`;

/** The card component whose renders the defect multiplies (`memo(ProductCardBody)`). */
const CARD_COMPONENT = 'ProductCard';

/** The grid that owns every card and passes each an inline `onSelect`. */
const GRID_COMPONENT = 'CatalogGrid';

/** The provider whose 250 ms ticker updates its own state. */
const TICKER_PROVIDER = 'ShippingEtaProvider';

/** The provider that consumes the ticker's context and publishes a fresh cart value each render. */
const CART_PROVIDER = 'CartProvider';

/** The card and grid files, project-relative as `relevantFiles` and every location report them. */
const CARD_FILE = 'src/components/catalog/ProductCard.tsx';
const GRID_FILE = 'src/components/catalog/CatalogGrid.tsx';

/** The two provider files the defect's engine lives in. */
const TICKER_PROVIDER_FILE = 'src/providers/ShippingEtaProvider.tsx';
const CART_PROVIDER_FILE = 'src/providers/CartProvider.tsx';
const PROVIDER_FILES: readonly string[] = [TICKER_PROVIDER_FILE, CART_PROVIDER_FILE];

/**
 * The catalog grid's region: `<section aria-labelledby="catalog-grid-heading">`
 * around the `<ul>` of cards (`CatalogGrid.tsx`, `CATALOG_HEADING_ID`).
 */
const CATALOG_GRID_SELECTOR = 'section[aria-labelledby="catalog-grid-heading"]';

/** One card's list item in the grid. */
const CATALOG_CARD_ITEM_SELECTOR = `${CATALOG_GRID_SELECTOR} > ul > li`;

/**
 * The element the developer points at: the first card's product name heading,
 * rendered by `ProductCard` inside the grid.
 */
const CARD_TARGET_SELECTOR = `${CATALOG_CARD_ITEM_SELECTOR}:first-child h3`;

/** The checkout form and its submit control (`src/components/checkout`). */
const CHECKOUT_PAGE_PATH = '/checkout';
const CHECKOUT_FORM_SELECTOR = 'form[aria-label="Checkout details"]';
const PLACE_ORDER_SELECTOR = `${CHECKOUT_FORM_SELECTOR} button[type="submit"]`;
const PLACE_ORDER_NAME = 'Place order';
const ORDER_CONFIRMED_HEADLINE = 'Thank you for your order';

/** The storefront routes the baseline fills a cart through, as a shopper would. */
const CART_PATH = '/api/cart';
const CART_ITEMS_PATH = '/api/cart/items';
const PRODUCTS_PATH = '/api/products';

/** The catalog's first page size, and how the baseline refills an empty cart. */
const CATALOG_PAGE_SIZE = 48;
const REFILL_LINE_COUNT = 4;
const REFILL_QUANTITY = 2;

// ---------------------------------------------------------------------------
// Product vocabulary this spec asserts against
// ---------------------------------------------------------------------------

/** The capture signal React render tracking answers to (`plan.capture`). */
const REACT_SIGNAL = 'react';

/** The React adapter's render-tracking action, claimed by adapter `react` in runtime mode. */
const REACT_ACTION_TYPE = 'react-render-tracking';
const REACT_ADAPTER_ID = 'react';

/** The React adapter's runtime hook as `instrumentation.ready` labels it ("React renders and commits"). */
const REACT_HOOK_PATTERN = /\bReact renders?\b/iu;

/** The metric cards the render panel shows (docs/DEMO.md, "How the three panels differ"). */
const RENDER_CARD_METRICS: readonly MetricId[] = [
  'render_count',
  'unchanged_render_count',
  'render_trigger_unknown_count',
  'blocking_time',
];

/** The metric cards the slow-interaction panel shows (docs/DEMO.md, "How the three panels differ"). */
const DURATION_CARD_METRICS: readonly MetricId[] = [
  'total_duration',
  'frontend_duration',
  'backend_duration',
  'database_duration',
];

/**
 * The render views `docs/DEMO.md` lists for this question, of which the render
 * panel must compose at least two.
 */
const RENDER_VIEW_TYPES: readonly PanelNodeType[] = [
  'componentTree',
  'stateTransitions',
  'dependencyGraph',
  'eventLog',
];
const MIN_RENDER_VIEWS = 2;

/** The latency views a render panel must not compose. */
const LATENCY_VIEW_TYPES: readonly PanelNodeType[] = ['queryTable', 'waterfall', 'flame'];

/** The triggers that explain an idle card re-render: a changed context value, or stable inputs. */
const IDLE_CARD_TRIGGERS: readonly RenderTrigger[] = ['context', 'unchanged'];

/** The event kinds that carry a user's input; an idle capture holds none of them. */
const INPUT_KINDS: readonly TelemetryEvent['kind'][] = ['interaction'];

/** The attribute a render continuing a settled request carries (`attributes.lineage`). */
const LINEAGE_ATTRIBUTE = 'lineage';

/** The fields of one changed-prop entry, and of one value summary, as `schema/attributes.ts` declares them. */
const CHANGED_PROP_ENTRY_FIELDS: ReadonlySet<string> = new Set(['key', 'previous', 'next']);
const VALUE_SUMMARY_FIELDS: ReadonlySet<string> = new Set(['type', 'preview', 'truncated']);

/** Summary types whose preview names a shape and may never carry source text or markup. */
const SHAPE_ONLY_VALUE_TYPES: ReadonlySet<string> = new Set(['function', 'dom']);

/** What would betray serialised code or markup inside a shape-only preview. */
const SERIALISED_BODY_PATTERN = /[{}]|=>|\n|<\/|\bfunction\s*\(/u;

// ---------------------------------------------------------------------------
// Bounds — lower bounds only: render counts are timing-dependent by nature
// ---------------------------------------------------------------------------

/**
 * Ticker updates the idle capture waits for. Every update of the shipping-ETA
 * provider re-renders each visible card once through the cart context, so the
 * wait ends once the card's statistics hold at least this many renders per
 * visible card — about a second of idleness at 250 ms per tick.
 */
const IDLE_TICKS_REQUIRED = 4;

/**
 * The smallest render count that is "clearly repeated". The idle wait above
 * guarantees `IDLE_TICKS_REQUIRED` renders per visible card, and stored counts
 * only grow, so this bound can never be missed by a timing accident.
 */
const MIN_REPEATED_RENDERS = 3;

// ---------------------------------------------------------------------------
// The renderer's DOM contract (packages/panel-renderer)
// ---------------------------------------------------------------------------

/** Block classes of the node types this spec reads the DOM of. */
const RENDER_TABLE_BLOCK = '.dg-render-table';
const COMPONENT_TREE_BLOCK = '.dg-component-tree';
const STATE_TRANSITIONS_BLOCK = '.dg-state-transitions';

/** `RenderTable`'s grid caption, its per-row disclosure names and its figure cells. */
const RENDER_TABLE_CAPTION = 'Render statistics per component';
const SHOW_RENDERS_LABEL = 'Show individual renders of';
const HIDE_RENDERS_LABEL = 'Hide individual renders of';
const RENDER_COUNT_CELL = '.dg-render-table__count-cell';
const RENDER_OCCURRENCE = '.dg-render-table__detail .dg-render-table__occurrence';

/** `ComponentTree`'s toolbar action and the per-node parts. */
const EXPAND_ALL_LABEL = 'Expand all';
const TREE_TOGGLE = 'button.dg-component-tree__toggle';
const TREE_COUNT = '.dg-component-tree__count';

/** `StateTransitionViewer`'s old → trigger → new cells. */
const TRANSITION_PREVIOUS = '.dg-state-transitions__previous';
const TRANSITION_TRIGGER = '.dg-state-transitions__trigger';
const TRANSITION_NEXT = '.dg-state-transitions__next';

// ---------------------------------------------------------------------------
// Budgets — every wait is on evidence arriving, never a bare sleep
// ---------------------------------------------------------------------------

/**
 * How long the application page must go without a request or a main-frame
 * navigation before the capture starts: the developer's pause between "Ready
 * to capture" and Start capture. Installing the plan patches a server module,
 * and the dev server answers with a server-component refresh the page fetches
 * a moment later; waiting that out keeps the refresh's request out of an idle
 * capture.
 */
const SETTLE_QUIET_MS = 2_000;

/** The longest the page may keep loading after the session turned ready. */
const SETTLE_BUDGET_MS = 45_000;

/** The idle capture's wait for the ticker-driven renders to be stored. */
const IDLE_BUDGET_MS = 60_000;

/** The baseline's wait for the checkout's server span to be stored. */
const SERVER_SPAN_BUDGET_MS = 30_000;

/** A rendered panel element becoming visible, or a disclosure opening. */
const PANEL_DOM_TIMEOUT_MS = 30_000;

/**
 * The bound every panel locator action takes: the suite sets no `actionTimeout`,
 * so an unbounded `innerText` or `click` on an absent element would wait out the
 * whole test instead of failing where the element is missing.
 */
const PANEL_DOM_ACTION = { timeout: PANEL_DOM_TIMEOUT_MS } as const;

/** The render workflow test: every session budget, the settle, the idle wait and the DOM checks. */
const RENDER_TEST_TIMEOUT_MS =
  E2E_TIMEOUTS.longTestTimeoutMs + SETTLE_BUDGET_MS + IDLE_BUDGET_MS + 4 * PANEL_DOM_TIMEOUT_MS;

/** The baseline test: every session budget, the settle, the order and its server span. */
const BASELINE_TEST_TIMEOUT_MS =
  E2E_TIMEOUTS.longTestTimeoutMs +
  SETTLE_BUDGET_MS +
  2 * E2E_TIMEOUTS.pageReady +
  SERVER_SPAN_BUDGET_MS;

// ---------------------------------------------------------------------------
// Module-scoped state, written once by the two workflow tests
// ---------------------------------------------------------------------------

let tracker: SessionTracker | undefined;
let demoSnapshot: TrackedFileSnapshot | undefined;
let renderOutcome: DebugSessionOutcome | undefined;
let renderSession: SessionRecord | undefined;
let renderEvents: readonly TelemetryEvent[] | undefined;
let renderStats: readonly RenderStat[] | undefined;
let componentTree: ComponentTreeSnapshot | undefined;
let stateTransitions: readonly StateTransition[] | undefined;
let renderMetrics: readonly MetricValue[] | undefined;
let renderAnalysis: AnalysisResult | undefined;
let renderPanel: PanelSpec | undefined;
let visibleCardCount: number | undefined;
let baselinePanel: PanelSpec | undefined;
let baselineNodeTypes: ReadonlySet<PanelNodeType> | undefined;

/**
 * Narrows a module-scoped value written by a workflow test. Serial mode skips
 * every later test when a workflow test fails, so reaching the throw means the
 * value was never written — which is itself the failure to report.
 */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `${what} was not recorded: its workflow test did not complete, so there is nothing to assert against.`,
    );
  }
  return value;
}

/** The newest session the tracker registered: the one `runDebugSession` is driving. */
function currentSessionId(active: SessionTracker): string {
  const sessionId = active.registered.at(-1);
  if (sessionId === undefined) {
    throw new Error('No session has been registered yet, so there is no capture to read from.');
  }
  return sessionId;
}

// ---------------------------------------------------------------------------
// Pure readers over captured data
// ---------------------------------------------------------------------------

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string attribute of an event, or `undefined` when absent or of another type. */
function stringAttribute(event: TelemetryEvent, key: string): string | undefined {
  const value: unknown = event.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * How many fiber renders one render event stands for.
 *
 * The page agent coalesces the fibers of one component that rendered alike in
 * one commit into a single event carrying `instanceCount` (present only when
 * greater than one), so an event counts as that many renders and as one when
 * the attribute is absent — the rule the render statistics are computed by.
 */
function instancesOf(event: TelemetryEvent): number {
  const value: unknown = event.attributes['instanceCount'];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

/** The whole number a rendered figure shows (`1,234` → `1234`), or `NaN` when it shows none. */
function figureOf(text: string): number {
  const digits = text.replace(/\D/gu, '');
  return digits.length === 0 ? Number.NaN : Number(digits);
}

/** Length in code points, the unit `MAX_PREVIEW_LENGTH` is stated in. */
function codePointLength(value: string): number {
  return [...value].length;
}

/** A set's members, sorted, for stable comparison and failure text. */
function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** The trigger bucket holding most of a statistic's renders (vocabulary order breaks a tie). */
function dominantTrigger(stat: RenderStat): RenderTrigger {
  let best: RenderTrigger = RENDER_TRIGGERS[0];
  for (const trigger of RENDER_TRIGGERS) {
    if (stat.triggers[trigger] > stat.triggers[best]) {
      best = trigger;
    }
  }
  return best;
}

/** The sum of one field over every render statistic. */
function sumOf(stats: readonly RenderStat[], read: (stat: RenderStat) => number): number {
  return stats.reduce((total, stat) => total + read(stat), 0);
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

/** The locations of a panel's `sourceLink` leaves, in document order. */
function sourceLinkLocations(spec: PanelSpec): SourceLocation[] {
  const locations: SourceLocation[] = [];
  walkPanelNodes(spec.layout, (node) => {
    if (node.type === 'sourceLink') {
      locations.push(node.location);
    }
  });
  return locations;
}

/** The filter of a panel's first `renderTable` node, or `undefined` when it reads every render. */
function renderTableFilter(spec: PanelSpec): DataQueryFilter | undefined {
  let filter: DataQueryFilter | undefined;
  let seen = false;
  walkPanelNodes(spec.layout, (node) => {
    if (!seen && node.type === 'renderTable') {
      seen = true;
      filter = node.query.filter;
    }
  });
  return filter;
}

/** One component-tree node with the chain of components above it, root first. */
interface PlacedTreeNode {
  readonly node: ComponentTreeNode;
  readonly ancestors: readonly string[];
  readonly parentDepth: number | undefined;
}

/** Every node of a component-tree snapshot, depth first, with its ancestors. */
function placedTreeNodes(snapshot: ComponentTreeSnapshot): PlacedTreeNode[] {
  const placed: PlacedTreeNode[] = [];
  const visit = (
    node: ComponentTreeNode,
    ancestors: readonly string[],
    parentDepth: number | undefined,
  ): void => {
    placed.push({ node, ancestors, parentDepth });
    for (const child of node.children) {
      visit(child, [...ancestors, node.component], node.depth);
    }
  };
  for (const root of snapshot.roots) {
    visit(root, [], undefined);
  }
  return placed;
}

/** The changed-prop entries a render event carries, unvalidated (`[]` when it carries none). */
function changedPropEntriesOf(event: TelemetryEvent): readonly unknown[] {
  const value: unknown = event.attributes['changedProps'];
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** The prop names a render event's changed-prop list carries, from either item shape. */
function changedPropNamesOf(event: TelemetryEvent): string[] {
  return changedPropEntriesOf(event).flatMap((entry) => {
    const name: unknown = isRecord(entry) ? entry.key : entry;
    return typeof name === 'string' && name.length > 0 ? [name] : [];
  });
}

/**
 * The privacy violations of one value summary: an unknown field, a type outside
 * the vocabulary, a preview past the bound, a shape-only preview carrying code
 * or markup, or credential-shaped content.
 */
function summaryViolations(summary: unknown, where: string): string[] {
  if (!isRecord(summary)) {
    return [`${where}: not a value summary`];
  }
  const problems: string[] = [];
  const extra = Object.keys(summary).filter((field) => !VALUE_SUMMARY_FIELDS.has(field));
  if (extra.length > 0) {
    problems.push(`${where}: carries fields beyond a summary (${extra.join(', ')})`);
  }
  const { type, preview, truncated } = summary;
  if (typeof type !== 'string' || !(ATTRIBUTE_VALUE_TYPES as readonly string[]).includes(type)) {
    const shown = typeof type === 'string' ? `"${type}"` : `of JS type ${typeof type}`;
    problems.push(`${where}: type ${shown} is outside the vocabulary`);
  }
  if (typeof truncated !== 'boolean') {
    problems.push(`${where}: truncated is not a boolean`);
  }
  if (typeof preview !== 'string') {
    problems.push(`${where}: preview is not a string`);
    return problems;
  }
  if (codePointLength(preview) > MAX_PREVIEW_LENGTH) {
    problems.push(`${where}: preview of ${String(codePointLength(preview))} code points`);
  }
  if (typeof type === 'string' && SHAPE_ONLY_VALUE_TYPES.has(type)) {
    if (SERIALISED_BODY_PATTERN.test(preview)) {
      problems.push(`${where}: a ${type} preview carries serialised code or markup`);
    }
  }
  if (containsDenied(preview)) {
    problems.push(`${where}: preview matches a credential pattern`);
  }
  return problems;
}

/**
 * The privacy violations of one prop name: empty, longer than a preview may be,
 * shaped like serialised code or markup rather than a name, or credential-shaped.
 */
function propNameViolations(name: unknown, where: string): string[] {
  if (typeof name !== 'string' || name.length === 0) {
    return [`${where}: key is not a prop name`];
  }
  const problems: string[] = [];
  if (codePointLength(name) > MAX_PREVIEW_LENGTH) {
    problems.push(`${where}: a prop name of ${String(codePointLength(name))} code points`);
  }
  if (SERIALISED_BODY_PATTERN.test(name)) {
    problems.push(`${where}: carries serialised code or markup instead of a prop name`);
  }
  if (containsDenied(name)) {
    problems.push(`${where}: key matches a credential pattern`);
  }
  return problems;
}

/**
 * The privacy violations of one render event's changed-prop list.
 *
 * `schema/attributes.ts` admits two shapes per item, and `aggregate/renders.ts`
 * reads both: a plain prop name — what the browser agent emits, since the value
 * transitions belong to `state` events — or a `ChangedPropEntry` whose ends
 * are value summaries. Either way nothing beyond a name and bounded summaries
 * may appear.
 */
function changedPropViolations(event: TelemetryEvent): string[] {
  const entries = changedPropEntriesOf(event);
  const where = `render ${event.id}`;
  const problems: string[] = [];
  if (entries.length > MAX_TRACKED_KEYS) {
    problems.push(`${where}: ${String(entries.length)} entries exceed ${String(MAX_TRACKED_KEYS)}`);
  }
  entries.forEach((entry, position) => {
    const at = `${where} changedProps[${String(position)}]`;
    if (typeof entry === 'string') {
      problems.push(...propNameViolations(entry, at));
      return;
    }
    if (!isRecord(entry)) {
      problems.push(`${at}: neither a prop name nor an entry`);
      return;
    }
    const extra = Object.keys(entry).filter((field) => !CHANGED_PROP_ENTRY_FIELDS.has(field));
    if (extra.length > 0) {
      problems.push(`${at}: carries fields beyond key and summaries (${extra.join(', ')})`);
    }
    problems.push(...propNameViolations(entry.key, at));
    for (const side of ['previous', 'next'] as const) {
      if (entry[side] !== undefined) {
        problems.push(...summaryViolations(entry[side], `${at}.${side}`));
      }
    }
  });
  return problems;
}

/** A W3C span id: 16 lowercase hex characters, not all zero. */
const SPAN_ID_SHAPE = /^(?!0{16}$)[0-9a-f]{16}$/u;

/** A W3C trace id: 32 lowercase hex characters, not all zero. */
const TRACE_ID_SHAPE = /^(?!0{32}$)[0-9a-f]{32}$/u;

/**
 * What one `render` event gets wrong as a correlated browser span: its tier,
 * its component, phase or trigger, its trace context, or an unknown lineage.
 * A render continuing a settled request carries `lineage: async-continuation`;
 * that is legitimate evidence and is accepted, never filtered away.
 */
function renderEventViolations(event: TelemetryEvent): string[] {
  const where = describeEvent(event);
  const problems: string[] = [];
  if (event.tier !== 'browser') {
    problems.push(`${where}: tier "${event.tier}", not browser`);
  }
  if ((stringAttribute(event, 'component') ?? '') === '') {
    problems.push(`${where}: names no component`);
  }
  const phase = stringAttribute(event, 'phase');
  if (phase === undefined || !(RENDER_PHASES as readonly string[]).includes(phase)) {
    problems.push(`${where}: phase ${String(phase)} is not a render phase`);
  }
  const trigger = stringAttribute(event, 'trigger');
  if (trigger !== undefined && !(RENDER_TRIGGERS as readonly string[]).includes(trigger)) {
    problems.push(`${where}: trigger "${trigger}" is outside the vocabulary`);
  }
  if (!TRACE_ID_SHAPE.test(event.traceId)) {
    problems.push(`${where}: traceId "${event.traceId}" is not a W3C trace id`);
  }
  if (!SPAN_ID_SHAPE.test(event.spanId)) {
    problems.push(`${where}: spanId "${event.spanId}" is not a W3C span id`);
  }
  const lineage = stringAttribute(event, LINEAGE_ATTRIBUTE);
  if (lineage !== undefined && !(LINEAGE_VALUES as readonly string[]).includes(lineage)) {
    problems.push(`${where}: lineage "${lineage}" is outside the vocabulary`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The demo, reached through the application page and over HTTP
// ---------------------------------------------------------------------------

/** Waits until the catalog grid shows its cards, and returns how many are listed. */
async function expectCatalogGrid(page: Page): Promise<number> {
  const cards = page.locator(CATALOG_CARD_ITEM_SELECTOR);
  await expect(cards.first(), 'the catalog grid must list product cards').toBeVisible({
    timeout: E2E_TIMEOUTS.pageReady,
  });
  const count = await cards.count();
  expect(count, 'the catalog grid lists no product card').toBeGreaterThan(0);
  return count;
}

/**
 * Waits until `page` has gone {@link SETTLE_QUIET_MS} without a request or a
 * main-frame navigation and has finished loading (see the constant for why).
 * The quiet period is measured by `expect.poll`, not slept.
 */
async function settlePage(page: Page): Promise<void> {
  let lastActivityAt = Date.now();
  const touch = (): void => {
    lastActivityAt = Date.now();
  };
  const onNavigated = (frame: Frame): void => {
    if (frame === page.mainFrame()) {
      touch();
    }
  };
  page.on('request', touch);
  page.on('requestfinished', touch);
  page.on('framenavigated', onNavigated);
  try {
    await expect
      .poll(() => Date.now() - lastActivityAt, {
        message: `the application page kept loading for ${String(SETTLE_BUDGET_MS)} ms after the session turned ready`,
        timeout: SETTLE_BUDGET_MS,
        intervals: [...E2E_TIMEOUTS.pollIntervals],
      })
      .toBeGreaterThanOrEqual(SETTLE_QUIET_MS);
    await page.waitForLoadState('load', { timeout: E2E_TIMEOUTS.pageReady });
    await waitForStreamedContent(page);
  } finally {
    page.off('request', touch);
    page.off('requestfinished', touch);
    page.off('framenavigated', onNavigated);
  }
}

/** How many renders of the card component the service has stored for the session so far. */
async function storedCardRenders(service: ServiceHandle, sessionId: string): Promise<number> {
  const renders = await service.queryAllPanelData(sessionId, {
    source: 'renders',
    limit: DATA_QUERY_MAX_LIMIT,
  });
  return renders.items.find((stat) => stat.component === CARD_COMPONENT)?.renderCount ?? 0;
}

/** The product ids in the storefront cart of the page's browser context. */
async function cartProductIds(page: Page, baseUrl: string): Promise<string[]> {
  const response = await page.request.get(new URL(CART_PATH, baseUrl).href);
  expect(response.ok(), `GET ${CART_PATH} answered HTTP ${String(response.status())}.`).toBe(true);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.lines)) {
    throw new Error(`GET ${CART_PATH} did not answer a cart view.`);
  }
  const lines: readonly unknown[] = body.lines;
  return lines.map((line) => {
    if (!isRecord(line) || typeof line.productId !== 'string') {
      throw new Error(`GET ${CART_PATH} answered a cart line without a product id.`);
    }
    return line.productId;
  });
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
 * Leaves the storefront's cart holding lines, refilling an empty one the way a
 * shopper does (`POST /api/cart/items`): a placed order converts the cart, so an
 * earlier run may have left it empty.
 */
async function ensureCheckoutCart(page: Page, baseUrl: string): Promise<void> {
  if ((await cartProductIds(page, baseUrl)).length > 0) {
    return;
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
  expect(
    (await cartProductIds(page, baseUrl)).length,
    'The refilled cart is still empty.',
  ).toBeGreaterThan(0);
}

/** The checkout's "Place order" control. */
function placeOrderControl(page: Page): Locator {
  return page.locator(PLACE_ORDER_SELECTOR);
}

/** Opens the checkout page and waits until "Place order" can be pressed. */
async function openCheckoutPage(page: Page, baseUrl: string): Promise<void> {
  await page.goto(new URL(CHECKOUT_PAGE_PATH, baseUrl).href, { timeout: E2E_TIMEOUTS.pageReady });
  await waitForStreamedContent(page);
  const control = placeOrderControl(page);
  await expect(control, `"${PLACE_ORDER_SELECTOR}" must match exactly one control.`).toHaveCount(1);
  await expect(control).toHaveAccessibleName(PLACE_ORDER_NAME);
  // The control is enabled as soon as the cart is orderable, and a press made while the shipping
  // quote is still in flight is refused by the form's own validation, so wait for an orderable
  // form rather than an enabled button.
  await waitForOrderableCheckout(page, E2E_TIMEOUTS.pageReady);
}

/**
 * The baseline's reproduction: the click a developer makes, then the page's own
 * answer — the confirmation headline, or the form's alert, whose text is the
 * failure.
 */
async function placeOrder(page: Page): Promise<void> {
  const control = page.getByRole('button', { name: PLACE_ORDER_NAME, exact: true });
  await expect(control).toBeEnabled({ timeout: E2E_TIMEOUTS.pageReady });
  await control.click({ timeout: E2E_TIMEOUTS.pageReady });
  const confirmation = page.getByRole('heading', { name: ORDER_CONFIRMED_HEADLINE, exact: true });
  const failure = page.locator(`${CHECKOUT_FORM_SELECTOR} [role="alert"]`);
  await expect(confirmation.or(failure).first()).toBeVisible({ timeout: E2E_TIMEOUTS.pageReady });
  if (!(await confirmation.isVisible())) {
    const reason = (await failure.first().innerText({ timeout: E2E_TIMEOUTS.pageReady }))
      .replace(/\s+/gu, ' ')
      .trim();
    throw new Error(`Placing the order failed on the checkout page: ${reason}`);
  }
}

/** Waits, capture open, until the service has stored the checkout request's server span. */
async function awaitServerSpan(service: ServiceHandle, sessionId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await service.queryAllPanelData(sessionId, {
            source: 'events',
            filter: { kinds: ['http.server'] },
            limit: DATA_QUERY_MAX_LIMIT,
          })
        ).total,
      {
        message: 'the checkout request produced no stored server span',
        timeout: SERVER_SPAN_BUDGET_MS,
        intervals: [...E2E_TIMEOUTS.pollIntervals],
      },
    )
    .toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// The generated panel, read through the DevTools panel's DOM
// ---------------------------------------------------------------------------

/**
 * The render table shows one row per component with its counts: the card's row
 * shows the count and the dominant trigger the data API answers for the node's
 * own query, and expanding it lists the individual renders.
 */
async function expectRenderTableDom(
  page: Page,
  panelView: Locator,
  expected: RenderStat,
): Promise<void> {
  const block = panelView.locator(RENDER_TABLE_BLOCK).first();
  const grid = block.getByRole('grid', { name: RENDER_TABLE_CAPTION, exact: true });
  await expect(grid, 'the render table must render its grid').toBeVisible({
    timeout: PANEL_DOM_TIMEOUT_MS,
  });

  const dataRows = grid.getByRole('row').filter({ has: page.locator(RENDER_COUNT_CELL) });
  await expect
    .poll(() => dataRows.count(), {
      message: 'the render table must list a row per rendered component',
      timeout: PANEL_DOM_TIMEOUT_MS,
      intervals: [...E2E_TIMEOUTS.pollIntervals],
    })
    .toBeGreaterThanOrEqual(2);
  const rowCount = await dataRows.count();
  for (let index = 0; index < rowCount; index += 1) {
    const figure = figureOf(
      await dataRows.nth(index).locator(RENDER_COUNT_CELL).first().innerText(PANEL_DOM_ACTION),
    );
    expect(figure, `render table row ${String(index)} must show a render count`).toBeGreaterThan(0);
  }

  const showName = `${SHOW_RENDERS_LABEL} ${CARD_COMPONENT}`;
  const show = grid.getByRole('button', { name: showName, exact: true });
  await expect(show, `the render table must hold a row for ${CARD_COMPONENT}`).toBeVisible({
    timeout: PANEL_DOM_TIMEOUT_MS,
  });
  // A `has` locator is resolved relative to each row, so it starts from the page, not the grid.
  const cardRow = grid
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: showName, exact: true }) });
  const shownCount = figureOf(
    await cardRow.locator(RENDER_COUNT_CELL).first().innerText(PANEL_DOM_ACTION),
  );
  expect(shownCount, `the ${CARD_COMPONENT} row shows the data API's render count`).toBe(
    expected.renderCount,
  );

  const trigger = dominantTrigger(expected);
  const chip = cardRow.locator(`.dg-render-table__trigger[data-trigger="${trigger}"]`);
  await expect(
    chip,
    `the ${CARD_COMPONENT} row shows its "${trigger}" histogram chip`,
  ).toBeVisible();
  expect(
    figureOf(await chip.innerText(PANEL_DOM_ACTION)),
    `the "${trigger}" chip shows its count`,
  ).toBe(expected.triggers[trigger]);

  await show.click(PANEL_DOM_ACTION);
  const hide = grid.getByRole('button', {
    name: `${HIDE_RENDERS_LABEL} ${CARD_COMPONENT}`,
    exact: true,
  });
  await expect(hide, 'the row disclosure reports itself open').toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(
    block.locator(RENDER_OCCURRENCE).first(),
    `expanding the ${CARD_COMPONENT} row lists its individual renders`,
  ).toBeVisible({ timeout: PANEL_DOM_TIMEOUT_MS });
}

/**
 * The component tree is expandable and carries per-node render counts: after
 * "Expand all" the card appears as a tree item with a count, and the grid's
 * branch collapses through its own toggle.
 */
async function expectComponentTreeDom(panelView: Locator): Promise<void> {
  const block = panelView.locator(COMPONENT_TREE_BLOCK).first();
  const tree = block.getByRole('tree');
  await expect(tree, 'the component tree must render as a tree').toBeVisible({
    timeout: PANEL_DOM_TIMEOUT_MS,
  });

  await block.getByRole('button', { name: EXPAND_ALL_LABEL, exact: true }).click(PANEL_DOM_ACTION);
  const cardItem = tree.getByRole('treeitem', { name: CARD_COMPONENT, exact: true }).first();
  await expect(cardItem, `"${EXPAND_ALL_LABEL}" reveals ${CARD_COMPONENT}`).toBeVisible({
    timeout: PANEL_DOM_TIMEOUT_MS,
  });
  const cardCount = figureOf(
    await cardItem.locator(TREE_COUNT).first().innerText(PANEL_DOM_ACTION),
  );
  expect(cardCount, `the ${CARD_COMPONENT} node shows its render count`).toBeGreaterThanOrEqual(
    MIN_REPEATED_RENDERS,
  );

  const gridItem = tree.getByRole('treeitem', { name: GRID_COMPONENT, exact: true }).first();
  await expect(
    gridItem,
    `the ${GRID_COMPONENT} branch is open after "${EXPAND_ALL_LABEL}"`,
  ).toHaveAttribute('aria-expanded', 'true');
  await gridItem.locator(TREE_TOGGLE).first().click(PANEL_DOM_ACTION);
  await expect(
    gridItem,
    `the ${GRID_COMPONENT} branch collapses through its toggle`,
  ).toHaveAttribute('aria-expanded', 'false');
}

/**
 * The state-transition rows read old → trigger → new, left to right, when the
 * panel composes the viewer; when it does not, no empty viewer is on screen.
 */
async function expectStateTransitionsDom(
  page: Page,
  panelView: Locator,
  composed: boolean,
): Promise<void> {
  const block = panelView.locator(STATE_TRANSITIONS_BLOCK);
  if (!composed) {
    await expect(
      block,
      'no state-transition viewer is rendered for a panel without one',
    ).toHaveCount(0);
    return;
  }
  const row = block
    .first()
    .getByRole('row')
    .filter({ has: page.locator(TRANSITION_PREVIOUS) })
    .first();
  await expect(row, 'the state-transition viewer lists a transition').toBeVisible({
    timeout: PANEL_DOM_TIMEOUT_MS,
  });
  const boxes = await Promise.all(
    [TRANSITION_PREVIOUS, TRANSITION_TRIGGER, TRANSITION_NEXT].map((cell) =>
      row.locator(cell).first().boundingBox(PANEL_DOM_ACTION),
    ),
  );
  const lefts = boxes.map(
    (box, position) =>
      required(box ?? undefined, `the laid-out box of state-transition cell ${String(position)}`).x,
  );
  expect(
    lefts.every((left, position) => position === 0 || (lefts[position - 1] ?? left) < left),
    `a state-transition row reads old value → trigger → new value (cell offsets ${lefts.join(', ')})`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

test.describe('demo defect 2 — excessive renders on the idle catalog', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ service, demoApp }) => {
    tracker = createSessionTracker(service);
    // The byte-level baseline every tracked demo file is compared against once
    // both sessions have ended.
    demoSnapshot = await demoApp.snapshotTrackedFiles();
  });

  test.afterAll(async ({ service, demoApp }) => {
    test.setTimeout(E2E_TIMEOUTS.teardown);
    const active = tracker;
    if (active === undefined) {
      return;
    }
    // The `vscode` role may only end sessions under a folder a live editor
    // connection announced; the per-test editor client is closed by now.
    const report = await withEditorAnnouncement(service, () => active.endAll());
    expect(report.problems, `Ending both sessions must restore the demo:\n${report.text}`).toEqual(
      [],
    );
    const markers = await demoApp.findMarkers();
    expect(
      markers.map((finding) => `${finding.file}:${String(finding.line)} ${finding.marker}`),
      'No instrumentation marker may remain in the demo source after the sessions ended.',
    ).toEqual([]);
    if (demoSnapshot !== undefined) {
      await demoApp.verifyRestored(demoSnapshot, {
        message: 'After the render and baseline sessions ended',
      });
    }
  });

  test('captures the idle catalog re-rendering through the real pipeline', async ({
    service,
    demoApp,
    appPage,
    panel,
    editorClient,
  }) => {
    test.setTimeout(RENDER_TEST_TIMEOUT_MS);
    const active = required(tracker, 'the session tracker');

    await test.step('the catalog grid is on screen', async () => {
      await expectCatalogGrid(appPage);
    });

    // The developer's reproduction (docs/DEMO.md, Walkthrough 2): press Start
    // capture and do nothing. The wait below is on the stored evidence — the
    // card's render statistics — never on the clock.
    let cards: number | undefined;
    const beforeCapture: SessionPreparation = async ({ appPage: page }) => {
      await settlePage(page);
      cards = await expectCatalogGrid(page);
    };
    const interact: SessionInteraction = async () => {
      const sessionId = currentSessionId(active);
      const needed = IDLE_TICKS_REQUIRED * required(cards, 'the visible card count');
      await expect
        .poll(() => storedCardRenders(service, sessionId), {
          message: `the idle catalog must re-render each of its ${String(cards)} cards ${String(IDLE_TICKS_REQUIRED)} times with no user input`,
          timeout: IDLE_BUDGET_MS,
          intervals: [...E2E_TIMEOUTS.pollIntervals],
        })
        .toBeGreaterThanOrEqual(needed);
    };

    const run = await test.step('select a card, ask the question and capture idleness', () =>
      runDebugSession({
        service,
        editorClient,
        projectRoot: demoApp.projectRoot,
        question: QUESTION,
        panel,
        appPage,
        target: { selector: CARD_TARGET_SELECTOR },
        selectTargetVia: 'devtools-eval',
        selectBeforeQuestion: true,
        beforeCapture,
        interact,
        tracker: active,
      }));

    await test.step('the pipeline understood a render problem, not a latency one', () => {
      const files = run.session.relevantFiles.map((entry) => entry.file);
      for (const file of [CARD_FILE, GRID_FILE]) {
        expect(
          files,
          `relevantFiles must name ${file}; reported: ${files.join(', ') || '(none)'}`,
        ).toContain(file);
      }

      const chain = run.target?.componentChain ?? [];
      const described = chain.join(' < ') || '(empty)';
      expect(chain, `the $0 target resolves to ${CARD_COMPONENT}: ${described}`).toContain(
        CARD_COMPONENT,
      );
      expect(chain, `the $0 target sits inside ${GRID_COMPONENT}: ${described}`).toContain(
        GRID_COMPONENT,
      );
      expect(
        chain.indexOf(CARD_COMPONENT),
        `the owner chain lists the card before the grid that owns it: ${described}`,
      ).toBeLessThan(chain.indexOf(GRID_COMPONENT));

      const plan = required(run.plan, 'the instrumentation plan');
      expect(
        plan.capture,
        `the plan's capture list must name React render tracking; it lists: ${plan.capture.join(', ')}`,
      ).toContain(REACT_SIGNAL);
      expect(
        plan.instrumentationTargets
          .filter((action) => action.type === REACT_ACTION_TYPE)
          .map((action) => `${action.adapter}/${action.mode}`),
        `the plan must hold a runtime ${REACT_ACTION_TYPE} action of the React adapter`,
      ).toContain(`${REACT_ADAPTER_ID}/runtime`);

      // The React adapter's signal is accounted for in instrumentation.ready:
      // armed among the runtime hooks, or — because the service installs on
      // session.create, before the tab's agent reports — deferred with the
      // page-agent reason and a hint, and armed once the agent reports. Either
      // way the capture must then hold render events, which the idle wait above
      // and the serial tests below assert.
      const ready = required(run.instrumentation, 'the instrumentation.ready snapshot');
      const armed = ready.runtimeHooks.some((hook) => REACT_HOOK_PATTERN.test(hook));
      const deferred = ready.unavailable.find((entry) => entry.signal === REACT_SIGNAL);
      if (armed) {
        expect(deferred, 'an armed React signal is not also reported unavailable').toBeUndefined();
      } else {
        const gap = required(
          deferred,
          `instrumentation.ready must account for the ${REACT_SIGNAL} signal (runtime hooks: ${ready.runtimeHooks.join(', ')})`,
        );
        expect(gap.reason, 'the deferral names the missing page agent').toMatch(/page agent/iu);
        expect(gap.hint.trim(), 'the deferral carries a hint').not.toBe('');
      }
      test.info().annotations.push({
        type: 'react-signal',
        description: armed
          ? 'React render tracking was armed at install.'
          : `React render tracking was deferred at install: ${deferred?.reason ?? ''}`,
      });
      expect(run.captureSummary, 'capture.stopped must carry the capture summary').toBeDefined();
    });

    const sessionId = run.sessionId;
    const [events, stats, metrics, transitions, tree, stored] =
      await test.step('read the capture back through the panel-data API', () =>
        Promise.all([
          service.queryAllPanelData(sessionId, { source: 'events', limit: DATA_QUERY_MAX_LIMIT }),
          service.queryAllPanelData(sessionId, { source: 'renders', limit: DATA_QUERY_MAX_LIMIT }),
          service.queryAllPanelData(sessionId, { source: 'metrics' }),
          service.queryAllPanelData(sessionId, {
            source: 'stateTransitions',
            limit: DATA_QUERY_MAX_LIMIT,
          }),
          service.queryPanelData(sessionId, { source: 'componentTree' }),
          service.getCurrentPanel(sessionId),
        ]));

    const spec = required(run.panel, 'the generated panel');
    expect(stored?.id, 'GET /sessions/:id/panel serves the panel panel.generated carried').toBe(
      spec.id,
    );

    renderOutcome = run;
    renderSession = run.session;
    renderEvents = events.items;
    renderStats = stats.items;
    renderMetrics = metrics.items;
    stateTransitions = transitions.items;
    componentTree = tree.componentTree ?? undefined;
    renderAnalysis = run.analysis;
    renderPanel = spec;
    visibleCardCount = required(cards, 'the visible card count');

    await test.step('the DevTools panel renders the render views', async () => {
      const { locators } = panel;
      await expect(locators.panelView, 'the generated panel must render').toBeVisible({
        timeout: PANEL_DOM_TIMEOUT_MS,
      });
      await expect(locators.fallbackBanner, 'the panel must not be the fallback view').toHaveCount(
        0,
      );
      await expectNoPanelErrorState(panel.page, { timeoutMs: PANEL_DOM_TIMEOUT_MS });

      const generated = nodeTypesOf(spec);
      const rendered = await locators.renderedNodeTypes();
      expect(
        sorted(rendered),
        'the panel renders exactly the node types it was generated with',
      ).toEqual(sorted(generated));
      await expect(locators.observedFacts, 'every observed fact is on screen').toHaveCount(
        spec.summary.observed.length,
      );
      await expect(locators.likelyCauses, 'every likely cause is on screen').toHaveCount(
        spec.summary.likelyCauses.length,
      );

      // What the render table's own query answers, so the rendered figures are
      // compared with the data API rather than with a number written here.
      const filter = renderTableFilter(spec);
      const tableStats =
        filter === undefined
          ? stats.items
          : (
              await service.queryAllPanelData(sessionId, {
                source: 'renders',
                filter,
                limit: DATA_QUERY_MAX_LIMIT,
              })
            ).items;
      await expectRenderTableDom(
        panel.page,
        locators.panelView,
        expectRenderStat(tableStats, CARD_COMPONENT, { message: 'the render table query' }),
      );
      await expectComponentTreeDom(locators.panelView);
      await expectStateTransitionsDom(
        panel.page,
        locators.panelView,
        generated.has('stateTransitions'),
      );
    });

    await test.step('end the render session before the baseline question', async () => {
      const ended = await active.end(sessionId);
      expect(
        ended.cleanup,
        `ending the render session ${sessionId} must restore the demo (${ended.error ?? 'no error'})`,
      ).toBe('clean');
    });
  });

  test('derives the slow-interaction baseline panel in this file', async ({
    service,
    demoApp,
    appPage,
    panel,
    editorClient,
  }) => {
    test.setTimeout(BASELINE_TEST_TIMEOUT_MS);
    const active = required(tracker, 'the session tracker');

    await test.step('open the checkout with a filled cart', async () => {
      await ensureCheckoutCart(appPage, demoApp.baseUrl);
      await openCheckoutPage(appPage, demoApp.baseUrl);
    });

    const beforeCapture: SessionPreparation = async ({ appPage: page }) => {
      await settlePage(page);
      await expect(placeOrderControl(page)).toBeEnabled({ timeout: E2E_TIMEOUTS.pageReady });
    };
    const interact: SessionInteraction = async ({ appPage: page }) => {
      await placeOrder(page);
      await awaitServerSpan(service, currentSessionId(active));
    };

    const baseline = await test.step('ask the slow-interaction question and place an order', () =>
      generatePanelNodeTypes({
        service,
        editorClient,
        projectRoot: demoApp.projectRoot,
        question: BASELINE_QUESTION,
        panel,
        appPage,
        target: { selector: PLACE_ORDER_SELECTOR },
        selectTargetVia: 'devtools-eval',
        selectBeforeQuestion: true,
        beforeCapture,
        interact,
        tracker: active,
      }));

    // The baseline is only a baseline if it is the latency panel `docs/DEMO.md`
    // describes: a real, generated panel with the trace and query views.
    const spec = expectValidPanelSpec(required(baseline.outcome.panel, 'the baseline panel'), {
      message: 'The slow-interaction baseline',
    });
    expectNodeTypes(spec, ['timeline', 'queryTable'], {
      message: 'The slow-interaction baseline',
    });
    expectAnyNodeType(spec, ['flame', 'waterfall'], { message: 'The slow-interaction baseline' });
    expect(sorted(baseline.nodeTypes), 'the helper walked the same layout').toEqual(
      sorted(nodeTypesOf(spec)),
    );

    baselinePanel = spec;
    baselineNodeTypes = baseline.nodeTypes;

    const ended = await active.end(baseline.outcome.sessionId);
    expect(
      ended.cleanup,
      `ending the baseline session ${baseline.outcome.sessionId} must restore the demo (${ended.error ?? 'no error'})`,
    ).toBe('clean');
  });

  test('counts the card component’s repeated renders, per component', () => {
    const stats = required(renderStats, 'the render statistics');
    const metrics = required(renderMetrics, 'the capture metrics');
    const cards = required(visibleCardCount, 'the visible card count');

    const card = expectRenderStat(stats, CARD_COMPONENT, { message: 'The idle catalog' });
    // The idle wait ended only once the store held IDLE_TICKS_REQUIRED renders
    // per visible card, and stored counts only grow: both bounds are
    // guaranteed by the capture itself, never by the clock.
    expect(
      card.renderCount,
      `${CARD_COMPONENT} must render repeatedly while idle (${String(cards)} visible cards)`,
    ).toBeGreaterThanOrEqual(Math.max(MIN_REPEATED_RENDERS, IDLE_TICKS_REQUIRED * cards));
    expect(
      card.renderCount / cards,
      'each visible card re-rendered repeatedly',
    ).toBeGreaterThanOrEqual(MIN_REPEATED_RENDERS);
    expectSourceLocationShape(card.source, {
      expectedFile: CARD_FILE,
      message: `${CARD_COMPONENT}'s statistics link to its declaration`,
    });

    // Per-component counts and timing, each histogram accounting for every
    // render exactly once: the five classifications are disjoint and total.
    for (const stat of stats) {
      const where = `the ${stat.component} statistics`;
      expect(stat.renderCount, `${where} count at least one render`).toBeGreaterThan(0);
      expect(stat.totalDurationMs, `${where} carry a total render time`).toBeGreaterThanOrEqual(0);
      expect(
        Number.isFinite(stat.averageDurationMs),
        `${where} carry a finite average render time`,
      ).toBe(true);
      expect(
        RENDER_TRIGGERS.reduce((total, trigger) => total + stat.triggers[trigger], 0),
        `${where}: the trigger histogram accounts for every render once`,
      ).toBe(stat.renderCount);
    }

    // The defect's engine is visible in the same statistics: the ticker's own
    // state updates, and the cart provider re-rendering on the ticker's context.
    const ticker = expectRenderStat(stats, TICKER_PROVIDER, { message: 'The ticking provider' });
    expectRenderTrigger(ticker, 'state', { message: `${TICKER_PROVIDER} updates its own state` });
    expectSourceLocationShape(ticker.source, { expectedFile: TICKER_PROVIDER_FILE });
    const cart = expectRenderStat(stats, CART_PROVIDER, { message: 'The cart provider' });
    expectRenderTrigger(cart, 'context', {
      message: `${CART_PROVIDER} re-renders on the ticker's context`,
    });
    expectSourceLocationShape(cart.source, { expectedFile: CART_PROVIDER_FILE });

    expect(
      expectMetricAvailable(metrics, 'render_count'),
      'render_count counts every render the statistics hold',
    ).toBe(sumOf(stats, (stat) => stat.renderCount));
  });

  test('attributes the renders to their triggers, keeping unchanged and unknown apart', () => {
    const stats = required(renderStats, 'the render statistics');
    const metrics = required(renderMetrics, 'the capture metrics');
    const card = expectRenderStat(stats, CARD_COMPONENT, { message: 'The idle catalog' });

    // Idle renders of a card are explained by a changed context value or by
    // stable inputs — never by props nobody changed, nor left unexplained.
    const dominant = dominantTrigger(card);
    expect(
      IDLE_CARD_TRIGGERS,
      `the ${CARD_COMPONENT} histogram must be dominated by ${IDLE_CARD_TRIGGERS.join(' or ')}; triggers: ${JSON.stringify(card.triggers)}`,
    ).toContain(dominant);
    expectRenderTrigger(card, dominant, {
      minCount: Math.ceil(card.renderCount / 2),
      message: `the dominant trigger of ${CARD_COMPONENT}`,
    });

    // `unchanged` and `unknown` are separate buckets with separate mirrors in
    // every statistic; an undeterminable render is never counted as unchanged.
    for (const stat of stats) {
      expectRenderTrigger(stat, 'unchanged', { minCount: 0, message: stat.component });
      expectRenderTrigger(stat, 'unknown', { minCount: 0, message: stat.component });
    }

    const renderCount = expectMetricAvailable(metrics, 'render_count');
    const unchanged = expectMetricAvailable(metrics, 'unchanged_render_count');
    const unknown = expectMetricAvailable(metrics, 'render_trigger_unknown_count');
    expect(unchanged, 'this defect re-renders components whose inputs held').toBeGreaterThanOrEqual(
      1,
    );
    expect(renderCount, 'render_count covers the unchanged renders').toBeGreaterThanOrEqual(
      unchanged,
    );
    expect(
      renderCount,
      'unchanged and unknown are disjoint subsets of all renders',
    ).toBeGreaterThanOrEqual(unchanged + unknown);
    expect(unchanged, 'unchanged_render_count is the sum of the unchanged buckets').toBe(
      sumOf(stats, (stat) => stat.triggers.unchanged),
    );
    expect(unknown, 'render_trigger_unknown_count is the sum of the unknown buckets alone').toBe(
      sumOf(stats, (stat) => stat.triggers.unknown),
    );
  });

  test('records changed props as key names and bounded summaries only', () => {
    const events = required(renderEvents, 'the captured events');
    const stats = required(renderStats, 'the render statistics');
    const renders = eventsOfKind(events, 'render');

    const violations = renders.flatMap(changedPropViolations);
    expect(violations, 'changed props must be privacy-safe key/summary pairs').toEqual([]);
    expect(
      renders.some((event) => changedPropEntriesOf(event).length > 0),
      'some captured render changed a prop, so the privacy check above is not vacuous',
    ).toBe(true);

    // The statistics carry the key names alone, bounded, and every name they
    // report was carried by one of that component's own render events.
    const namesByComponent = new Map<string, Set<string>>();
    for (const event of renders) {
      const component = stringAttribute(event, 'component');
      if (component === undefined) continue;
      const names = namesByComponent.get(component) ?? new Set<string>();
      changedPropNamesOf(event).forEach((name) => names.add(name));
      namesByComponent.set(component, names);
    }
    for (const stat of stats) {
      const carried = namesByComponent.get(stat.component) ?? new Set<string>();
      expect(
        stat.changedPropKeys.filter((key) => !carried.has(key)),
        `${stat.component}: changed-prop keys no render event of it carried`,
      ).toEqual([]);
      expect(
        stat.changedPropKeys.length,
        `${stat.component}: at most ${String(MAX_TRACKED_KEYS)} changed-prop keys`,
      ).toBeLessThanOrEqual(MAX_TRACKED_KEYS);
      for (const key of stat.changedPropKeys) {
        expect(typeof key, `${stat.component}: a changed-prop key is a name`).toBe('string');
        expect(containsDenied(key), `${stat.component}: a changed-prop key is not a secret`).toBe(
          false,
        );
      }
    }

    // A card re-rendered only through context reports no changed prop: its
    // inputs held, which is exactly what defeats nothing but the memo.
    const card = expectRenderStat(stats, CARD_COMPONENT);
    if (card.triggers.props === 0) {
      expect(card.changedPropKeys, `${CARD_COMPONENT} re-rendered with no changed props`).toEqual(
        [],
      );
    }
  });

  test('snapshots the component tree with per-node render counts, and the state transitions', () => {
    const snapshot = required(componentTree, 'the component-tree snapshot');
    const stats = required(renderStats, 'the render statistics');
    const events = required(renderEvents, 'the captured events');
    const outcome = required(renderOutcome, 'the render session outcome');
    const card = expectRenderStat(stats, CARD_COMPONENT);
    const eventIds = new Set(events.map((event) => event.id));

    expect(snapshot.roots.length, 'the snapshot has a root').toBeGreaterThan(0);
    const placed = placedTreeNodes(snapshot);
    for (const { node, parentDepth } of placed) {
      const where = `tree node ${node.id} (${node.component})`;
      expect(Number.isInteger(node.renderCount) && node.renderCount >= 0, `${where} count`).toBe(
        true,
      );
      expect(node.depth, `${where} sits one level below its parent`).toBe(
        parentDepth === undefined ? 0 : parentDepth + 1,
      );
      if (node.lastRenderEventId !== undefined) {
        expect(eventIds.has(node.lastRenderEventId), `${where} cites a captured render`).toBe(true);
      }
    }

    // The card sits under the grid, and carries the component's cumulative count.
    const cardsUnderGrid = placed.filter(
      ({ node, ancestors }) =>
        node.component === CARD_COMPONENT && ancestors.includes(GRID_COMPONENT),
    );
    expect(
      cardsUnderGrid.length,
      `the tree places ${CARD_COMPONENT} under ${GRID_COMPONENT} (origin ${snapshot.origin})`,
    ).toBeGreaterThan(0);
    for (const { node } of cardsUnderGrid) {
      expect(node.renderCount, `a ${CARD_COMPONENT} node carries the component's count`).toBe(
        card.renderCount,
      );
    }

    // State transitions are captured when the plan asked for them; either way
    // the source agrees with the capture and every transition is well formed.
    const transitions = required(stateTransitions, 'the state transitions');
    const plannedState = required(outcome.plan, 'the instrumentation plan').capture.includes(
      'state',
    );
    const stateEvents = eventsOfKind(events, 'state').length;
    test.info().annotations.push({
      type: 'state-transitions',
      description: `${String(transitions.length)} transition(s) from ${String(stateEvents)} state event(s); the plan ${plannedState ? 'asked' : 'did not ask'} for state tracking.`,
    });
    if (stateEvents === 0) {
      expect(transitions, 'no state event was captured, so no transition is served').toEqual([]);
    }
    for (const transition of transitions) {
      const where = `transition ${transition.id}`;
      expect(eventIds.has(transition.eventId), `${where} cites a captured state event`).toBe(true);
      expect(
        transition.hookLabel !== undefined || transition.hookIndex !== undefined,
        `${where} names its hook`,
      ).toBe(true);
      expect(transition.component, `${where} names its component`).toBeDefined();
      for (const value of [transition.previousValue, transition.nextValue]) {
        if (value !== undefined) {
          expect(codePointLength(value), `${where}: a bounded value summary`).toBeLessThanOrEqual(
            MAX_PREVIEW_LENGTH,
          );
          expect(containsDenied(value), `${where}: a value summary is not a secret`).toBe(false);
        }
      }
      if (transition.triggerEventId !== undefined) {
        expect(eventIds.has(transition.triggerEventId), `${where} cites its trigger`).toBe(true);
      }
    }
  });

  test('correlates every render event as a browser span with trace context, and no input', () => {
    const events = required(renderEvents, 'the captured events');
    const stats = required(renderStats, 'the render statistics');
    const renders = eventsOfKind(events, 'render');
    expect(renders.length, 'the capture holds render events').toBeGreaterThan(0);

    expectNoSpanIdCollisions(events, { message: 'The idle capture' });
    // Thousands of renders: the per-event checks are collected, then asserted
    // once, so the report names every offending event without one expectation
    // per field per event.
    expect(
      renders.flatMap(renderEventViolations),
      'every render event is a browser span naming its component, phase and trace context',
    ).toEqual([]);
    for (const traceId of new Set(renders.map((event) => event.traceId))) {
      expectHexId(traceId, 32, `the traceId ${traceId} the captured renders carry`);
    }

    // The statistics count fiber renders: each event weighs its instanceCount,
    // because the agent coalesces the cards that re-render alike in a commit.
    const cardRenders = renders.filter(
      (event) => stringAttribute(event, 'component') === CARD_COMPONENT,
    );
    expect(
      cardRenders.reduce((total, event) => total + instancesOf(event), 0),
      `the ${CARD_COMPONENT} statistics count the renders its events stand for`,
    ).toBe(expectRenderStat(stats, CARD_COMPONENT).renderCount);

    // The point of the defect: nobody touched the page while it rendered.
    for (const kind of INPUT_KINDS) {
      expect(
        eventsOfKind(events, kind).map(describeEvent),
        `the idle capture holds no ${kind} event`,
      ).toEqual([]);
    }
  });

  test('generates a validated render panel composed of render views', () => {
    const spec = expectValidPanelSpec(required(renderPanel, 'the render panel'), {
      message: 'The render panel',
    });
    const types = expectNodeTypes(spec, ['renderTable'], { message: COMPOSITION_CONTEXT });

    const views = RENDER_VIEW_TYPES.filter((type) => types.has(type));
    expect(
      views.length,
      `the render panel composes at least ${String(MIN_RENDER_VIEWS)} of ${RENDER_VIEW_TYPES.join(', ')}; present: ${sorted(types).join(', ')}`,
    ).toBeGreaterThanOrEqual(MIN_RENDER_VIEWS);
    expect(
      LATENCY_VIEW_TYPES.filter((type) => types.has(type)),
      `the render panel composes no latency view; present: ${sorted(types).join(', ')}`,
    ).toEqual([]);

    walkPanelNodes(spec.layout, (node) => {
      if (node.type === 'renderTable') {
        expect(node.query.source, 'the render table reads the render statistics').toBe('renders');
      }
      if (node.type === 'componentTree') {
        expect(node.query.source, 'the tree reads the component-tree snapshot').toBe(
          'componentTree',
        );
      }
    });

    const cards = metricCardIds(spec);
    for (const id of RENDER_CARD_METRICS) {
      expect(cards, `the render panel's metric cards include ${id}`).toContain(id);
    }
  });

  test('composes a panel materially different from the slow-interaction panel', () => {
    const render = required(renderPanel, 'the render panel');
    const slow = required(baselinePanel, 'the slow-interaction baseline panel');
    const renderTypes = nodeTypesOf(render);
    const slowTypes = required(baselineNodeTypes, 'the baseline node types');
    const sets = `render panel: ${sorted(renderTypes).join(', ')}\nslow-interaction panel: ${sorted(slowTypes).join(', ')}`;

    expect(sorted(renderTypes), `the two panels compose different node sets\n${sets}`).not.toEqual(
      sorted(slowTypes),
    );
    expectDisjointVisualizations(render, slow, {
      labels: ['render panel', 'slow-interaction panel'],
      message: COMPOSITION_CONTEXT,
    });

    // The same ruling, stated directly: after removing the layout containers
    // and the permitted shared nodes, nothing is left in common.
    const bodies = (spec: PanelSpec): Set<PanelNodeType> =>
      new Set(
        [...visualizationNodeTypesOf(spec)].filter(
          (type) => !PERMITTED_VISUALIZATION_OVERLAP.has(type),
        ),
      );
    const slowBodies = bodies(slow);
    const overlap = sorted([...bodies(render)].filter((type) => slowBodies.has(type)));
    expect(
      overlap,
      `the visualization bodies must be disjoint\n${sets}\nintersection: ${overlap.join(', ')}`,
    ).toEqual([]);

    // Even the shared node carries different content.
    const renderCards = metricCardIds(render);
    const slowCards = metricCardIds(slow);
    const cardSets = `render cards: ${renderCards.join(', ')}\nslow cards: ${slowCards.join(', ')}`;
    for (const id of RENDER_CARD_METRICS) {
      expect(renderCards, `${cardSets}`).toContain(id);
      expect(slowCards, `${cardSets}`).not.toContain(id);
    }
    for (const id of DURATION_CARD_METRICS) {
      expect(slowCards, `${cardSets}`).toContain(id);
      expect(renderCards, `${cardSets}`).not.toContain(id);
    }
    expect(
      renderCards.filter((id) => slowCards.includes(id)),
      `the two panels' metric cards measure different things\n${cardSets}`,
    ).toEqual([]);
  });

  test('keeps observed facts evidenced and points a likely cause at where the renders come from', () => {
    const analysis = required(renderAnalysis, 'the analysis');
    const spec = required(renderPanel, 'the render panel');
    const events = required(renderEvents, 'the captured events');
    const session = required(renderSession, 'the render session record');

    expectFactsAndHypothesesSeparate(analysis, { message: 'The render analysis' });
    expectEvidenceResolves(analysis, events, { message: 'The render analysis' });
    expectEvidenceResolves(spec, events, { message: 'The render panel summary' });
    expect(
      spec.summary.observed.map((fact) => fact.statement),
      'the panel shows exactly the analysis’s observed facts',
    ).toEqual(analysis.observed.map((fact) => fact.statement));
    expect(
      session.analyses.map((entry) => entry.id),
      'the session record stores the analysis the panel was generated from',
    ).toContain(analysis.id);

    expect(analysis.likelyCauses.length, 'the analysis offers a likely cause').toBeGreaterThan(0);
    const located = analysis.likelyCauses.flatMap((cause) =>
      cause.suggestedLocation === undefined ? [] : [cause.suggestedLocation],
    );
    for (const location of located) {
      expectSourceLocationShape(location, { message: 'A suggested location' });
    }
    const listed = located.map((location) => `${location.file}:${String(location.line)}`);
    expect(
      located.filter(
        (location) => PROVIDER_FILES.includes(location.file) || location.file === GRID_FILE,
      ),
      `a likely cause must point at a provider (${PROVIDER_FILES.join(', ')}) or at ${GRID_FILE}; suggested: ${listed.join(', ') || '(none)'}`,
    ).not.toEqual([]);

    // The panel's source chip sends the developer to one of those suggestions.
    for (const link of sourceLinkLocations(spec)) {
      expectSourceLocationShape(link, { message: 'The render panel source link' });
      expect(
        located.some((location) => location.file === link.file && location.line === link.line),
        `the source link ${link.file}:${String(link.line)} is a location the analysis suggested (${listed.join(', ')})`,
      ).toBe(true);
    }
  });
});
