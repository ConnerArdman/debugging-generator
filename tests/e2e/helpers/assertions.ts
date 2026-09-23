/**
 * The shared assertion vocabulary of the Playwright `e2e` project.
 *
 * ## Why this module exists
 *
 * Four of the six end-to-end specs need the same two non-trivial checks, and
 * both are the acceptance evidence itself rather than a convenience:
 *
 * 1. **the ordered ancestor chain** — `demo-slow-interaction.spec.ts` proves one
 *    click resolves to one correlated tree spanning browser, server and
 *    database, and `generalization.spec.ts` proves the same chain minus the
 *    database tier on a project that shares no identifier with the demo. A
 *    per-spec copy of that walk would drift, and a drifted copy weakens exactly
 *    the claim the suite exists to make (AAP 0.8.3-0.8.4);
 * 2. **the panel node-type-set comparison** — `demo-excessive-renders.spec.ts`
 *    proves the render panel is *materially* different from the latency panel,
 *    which is a statement about two sets and their permitted overlap
 *    (AAP 0.6.5), not about a title.
 *
 * So both live here once.
 *
 * ## What this module is
 *
 * **Pure.** No filesystem, no network, no timers, no process access, no
 * Playwright fixtures, and no `test(...)` / `describe(...)` block — the `e2e`
 * project's `testMatch` is `**\/*.spec.ts`, so nothing under `helpers/` is
 * collected, and this file must stay collectable-free by construction anyway.
 * It imports `expect` from `@playwright/test` and types from the four mapped
 * `@debuggen/*` packages, and nothing else. `@debuggen/panel-renderer` is
 * deliberately absent from `tests/tsconfig.json`'s path map: DOM-level panel
 * assertions belong to the accessors the specs drive through `chrome.ts`.
 *
 * ## Privacy of failure text (AAP 0.5.2)
 *
 * A message here may print event ids, span ids, kinds, names, durations, node
 * types, request methods and redacted paths. It must never print a raw
 * attribute map, a header value, statement text beyond the already-parameterized
 * form, or a full URL with its query. Every list and every chain is bounded and
 * summarised with `(+N more)`, so a 5 000-event capture cannot dump itself into
 * the report.
 *
 * ## Conventions
 *
 * - every `expect*` helper returns the value it matched, so a spec chains
 *   instead of searching twice;
 * - no input array or object is ever mutated: every parameter is `readonly` and
 *   every sort runs on a copy;
 * - a `Result`-returning contract (`validatePanelSpec`) is unwrapped
 *   explicitly and turned into readable `expect` failure text. A silently
 *   ignored `Err` is the easiest way to make an acceptance suite lie.
 */

import { expect } from '@playwright/test';

import {
  CONFIDENCE_LEVELS,
  catalogEntryFor,
  isConfidenceLevel,
  validatePanelSpec,
  walkPanelNodes,
} from '@debuggen/panel-schema';
import type { Fact, Hypothesis, PanelNodeType, PanelSpec } from '@debuggen/panel-schema';
import type { AnalysisResult } from '@debuggen/protocol';
import {
  SOURCE_RESOLVED_BY,
  SPAN_ID_PATTERN,
  TRACE_ID_PATTERN,
  isSafeRelativePath,
} from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import { isMetricId, walkTrace } from '@debuggen/telemetry';
import type {
  MetricId,
  MetricValue,
  QueryGroup,
  RenderStat,
  RenderTrigger,
  RequestGroup,
  TelemetryEvent,
  TelemetryKind,
  TraceTree,
} from '@debuggen/telemetry';

/*
 * ---------------------------------------------------------------------------
 * Bounded failure text
 * ---------------------------------------------------------------------------
 */

/** How many entries a failure message prints before it summarises the rest. */
const MAX_LISTED_ENTRIES = 12;

/** How many characters of a free-form name a message prints. */
const MAX_LABEL_LENGTH = 80;

/** How many characters of a parameterized statement a message prints. */
const MAX_STATEMENT_LENGTH = 100;

/**
 * How far {@link ancestorChainOf} walks before it stops.
 *
 * A trace of a single interaction is a handful of levels deep; the correlator's
 * own ceiling is three orders of magnitude higher because it describes a whole
 * capture. This one exists to bound a *malformed* input — a `parentSpanId` cycle
 * that a partial capture or a hand-built fixture can produce — so the suite
 * fails with a readable message instead of hanging a 120-second test.
 */
export const DEFAULT_ANCESTOR_MAX_DEPTH = 64;

/** Collapses whitespace and caps a free-form value taken from captured data. */
function truncate(value: string, max: number = MAX_LABEL_LENGTH): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}...`;
}

/** Renders a list for a failure message, bounded and summarised. */
function formatList(values: readonly string[], limit: number = MAX_LISTED_ENTRIES): string {
  if (values.length === 0) {
    return '(none)';
  }

  const shown = values.slice(0, limit);
  const hidden = values.length - shown.length;

  return hidden === 0 ? shown.join(', ') : `${shown.join(', ')} (+${String(hidden)} more)`;
}

/** Counts items by a derived key, preserving insertion order of first sight. */
function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

/** Renders a histogram as `key xN`, most frequent first, bounded. */
function formatCounts(
  counts: ReadonlyMap<string, number>,
  limit: number = MAX_LISTED_ENTRIES,
): string {
  const entries = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => `${key} x${String(count)}`);

  return formatList(entries, limit);
}

/** Joins a caller's optional message with this module's own description. */
function prefixed(message: string | undefined, fallback: string): string {
  return message === undefined ? fallback : `${message}: ${fallback}`;
}

/**
 * Asserts a value is present and returns it narrowed.
 *
 * The `throw` is unreachable — a failing `expect` throws — and is present so the
 * compiler narrows without a non-null assertion, which
 * `noUncheckedIndexedAccess` would otherwise force on every `[0]` and
 * `Map.get` below.
 */
function required<T>(value: T | undefined, message: string): T {
  expect(value, message).toBeDefined();

  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

/** Asserts a number is present and finite, and returns it. Mirrors {@link required}. */
function finiteNumber(value: number | undefined, message: string): number {
  expect(typeof value === 'number' && Number.isFinite(value), message).toBe(true);

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(message);
  }

  return value;
}

/** Normalizes a statement for comparison: collapsed whitespace, lower case. */
function normalizeStatement(statement: string): string {
  return statement.replace(/\s+/gu, ' ').trim().toLowerCase();
}

/*
 * ---------------------------------------------------------------------------
 * Identifiers
 * ---------------------------------------------------------------------------
 */

/**
 * Asserts a value is a lowercase hexadecimal id of exactly the given length.
 *
 * The patterns come from `@debuggen/shared` rather than being restated here, so
 * a spec and the store agree on what a `traceId` (32) and a `spanId` (16) are.
 *
 * @param value The candidate id, which may be absent.
 * @param length `32` for a trace id, `16` for a span id.
 * @param label What the id is, for the failure message.
 */
export function expectHexId(value: string | undefined, length: 32 | 16, label: string): void {
  const pattern = length === 32 ? TRACE_ID_PATTERN : SPAN_ID_PATTERN;
  const received =
    value === undefined
      ? '(undefined)'
      : `"${truncate(value, 64)}" (length ${String(value.length)})`;

  expect(
    typeof value === 'string' && pattern.test(value),
    `${label} must be exactly ${String(length)} lowercase hexadecimal characters; received ${received}`,
  ).toBe(true);
}

/*
 * ---------------------------------------------------------------------------
 * Trace indexing and the ordered ancestor chain
 * ---------------------------------------------------------------------------
 */

/** Either shape a spec holds events in: the flat array, or a built span index. */
export type SpanSource = readonly TelemetryEvent[] | ReadonlyMap<string, TelemetryEvent>;

/** Two distinct events that claimed the same `spanId`. */
export interface SpanIdCollision {
  /** The span id both events carry. */
  readonly spanId: string;
  /** The id of the event the index kept: the first one seen. */
  readonly keptEventId: string;
  /** The id of the event the index did not key. */
  readonly discardedEventId: string;
}

/**
 * Indexes events by `spanId`, keeping the **first** event for a repeated id.
 *
 * Keeping the first rather than overwriting is what makes a collision
 * observable: {@link collectSpanIdCollisions} reports every one, and
 * {@link expectNoSpanIdCollisions} turns them into a failure. A silent
 * last-write-wins index would quietly re-parent a subtree and make a correlation
 * assertion pass for the wrong reason.
 *
 * @param events Captured events, in any order.
 * @returns A map from `spanId` to the first event that claimed it.
 */
export function buildSpanIndex(events: readonly TelemetryEvent[]): Map<string, TelemetryEvent> {
  const index = new Map<string, TelemetryEvent>();

  for (const event of events) {
    if (!index.has(event.spanId)) {
      index.set(event.spanId, event);
    }
  }

  return index;
}

/**
 * Reports every `spanId` claimed by two *different* events.
 *
 * The same event delivered twice — a retried batch, a paged query that overlaps
 * — is not a collision and is not reported: the comparison is on `id`, the
 * store's own identity for an event.
 */
export function collectSpanIdCollisions(events: readonly TelemetryEvent[]): SpanIdCollision[] {
  const seen = new Map<string, TelemetryEvent>();
  const collisions: SpanIdCollision[] = [];

  for (const event of events) {
    const kept = seen.get(event.spanId);

    if (kept === undefined) {
      seen.set(event.spanId, event);
      continue;
    }

    if (kept.id === event.id) {
      continue;
    }

    collisions.push({
      spanId: event.spanId,
      keptEventId: kept.id,
      discardedEventId: event.id,
    });
  }

  return collisions;
}

/**
 * Asserts no two distinct events share a `spanId`, and returns the index.
 *
 * @param events Captured events, in any order.
 * @param options `message` prefixes the failure text.
 */
export function expectNoSpanIdCollisions(
  events: readonly TelemetryEvent[],
  options: { readonly message?: string | undefined } = {},
): Map<string, TelemetryEvent> {
  const collisions = collectSpanIdCollisions(events);

  expect(
    collisions.length,
    [
      prefixed(options.message, 'Two distinct events claimed the same span id.'),
      `  collisions (${String(collisions.length)}): ${formatList(
        collisions.map(
          (collision) =>
            `${collision.spanId} kept=${collision.keptEventId} discarded=${collision.discardedEventId}`,
        ),
      )}`,
    ].join('\n'),
  ).toBe(0);

  return buildSpanIndex(events);
}

/**
 * Flattens a correlated trace into the **events** it holds, in walk order.
 *
 * `@debuggen/telemetry` exports a `flattenTrace` of its own that returns
 * `TraceNode[]` — the nodes, with their depth, orphan flags and lineage. This
 * one returns the `TelemetryEvent`s, so a spec holding the `trace` data source
 * can feed the flat-array helpers in this module without unwrapping each node.
 * The two are deliberately not the same function and this module does not import
 * the package's version; the traversal itself is the package's `walkTrace`, so
 * canonical order (parent before child, siblings as the correlator ordered them)
 * is never re-derived here.
 */
export function flattenTrace(tree: TraceTree): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];

  walkTrace(tree, (node) => {
    events.push(node.event);
  });

  return events;
}

/** Bounds the upward walk of {@link ancestorChainOf}. */
export interface AncestorChainOptions {
  /** How many ancestors to collect at most. Defaults to {@link DEFAULT_ANCESTOR_MAX_DEPTH}. */
  readonly maxDepth?: number | undefined;
}

/**
 * Walks `parentSpanId` upward from — and excluding — `event`.
 *
 * Stops cleanly at three boundaries, none of which is an error:
 *
 * - **no parent**: a root, which is the interaction in a well-formed trace;
 * - **parent absent from the index**: the orphan case of AAP 0.4.2, where an
 *   event whose parent never arrived is attached to the trace root with a flag
 *   rather than dropped. The chain ends where the evidence ends;
 * - **a span id already visited**: a cycle, which only a malformed or truncated
 *   input produces. Guarded with a visited set *and* a depth cap so neither a
 *   two-node loop nor a long degenerate chain can hang the suite.
 *
 * An ancestor reached across an asynchronous boundary — a React commit whose
 * parent is a settled request span, carrying `attributes.lineage ===
 * 'async-continuation'` and possibly `lineageAmbiguous` — is a legitimate
 * parent and is walked like any other. This helper never reads those flags.
 *
 * @returns The ancestors, **nearest first**.
 */
export function ancestorChainOf(
  event: TelemetryEvent,
  index: ReadonlyMap<string, TelemetryEvent>,
  options: AncestorChainOptions = {},
): TelemetryEvent[] {
  const maxDepth = options.maxDepth ?? DEFAULT_ANCESTOR_MAX_DEPTH;
  const chain: TelemetryEvent[] = [];
  const visited = new Set<string>([event.spanId]);
  let current: TelemetryEvent = event;

  while (chain.length < maxDepth) {
    const parentSpanId = current.parentSpanId;

    if (parentSpanId === undefined || visited.has(parentSpanId)) {
      break;
    }

    const parent = index.get(parentSpanId);

    if (parent === undefined) {
      break;
    }

    visited.add(parentSpanId);
    chain.push(parent);
    current = parent;
  }

  return chain;
}

/** One step of an expected ancestor chain: a kind, or a set of acceptable kinds. */
export type AncestorKindStep = TelemetryKind | readonly TelemetryKind[];

/** How {@link expectAncestorKinds} matches and reports. */
export interface AncestorKindsOptions {
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
  /** Assert every matched ancestor shares the starting event's trace. Defaults to `true`. */
  readonly sameTrace?: boolean | undefined;
  /** Bounds the upward walk. Defaults to {@link DEFAULT_ANCESTOR_MAX_DEPTH}. */
  readonly maxDepth?: number | undefined;
}

/** Does an ancestor's kind satisfy one expected step? */
function stepAccepts(kind: TelemetryKind, step: AncestorKindStep): boolean {
  return typeof step === 'string' ? step === kind : step.includes(kind);
}

/** Renders one expected step for a failure message. */
function describeStep(step: AncestorKindStep): string {
  return typeof step === 'string' ? step : step.join('|');
}

/**
 * Renders an event as `kind name(spanId)`.
 *
 * Kind, name and span id only: an attribute map can carry a header value or a
 * statement, and a failure message is not the place to discover that (AAP
 * 0.5.2).
 */
export function describeEvent(event: TelemetryEvent): string {
  return `${event.kind} ${truncate(event.name)}(${event.spanId})`;
}

/**
 * Asserts an ordered ancestor chain above `start`, allowing extra intermediate
 * spans.
 *
 * The match is an **ordered subsequence**: each expected step is satisfied by
 * the next ancestor of an acceptable kind, and ancestors of other kinds between
 * two matched steps are skipped. Both properties are required by the acceptance
 * tests:
 *
 * - `demo-slow-interaction.spec.ts` asserts `db.query` sits under a `function`
 *   **or** `route.handler` span, under `http.server`, under `fetch`, under
 *   `interaction` — the alternatives exist because whether a named service
 *   function was instrumented is a property of the plan, not of the product;
 * - `generalization.spec.ts` asserts the same chain on a fixture app with no
 *   database tier, and the framework's own intermediate spans (`BaseServer`
 *   work, route resolution) sit between the steps in both.
 *
 * Nesting is judged from the parent links only. Events are never re-sorted by
 * `startTime` here: canonical order is parent-before-child, then `startTime`,
 * then `(producerId, seq)`, then `ingestSeq`, and a sort on one field of that
 * tuple would invent a tree the correlator did not build.
 *
 * @param events The capture, as a flat array or an already-built span index.
 * @param start The deepest event of the chain, typically the database or
 * function span the spec just located.
 * @param expected The ancestor kinds, **nearest first**.
 * @returns The matched ancestors, nearest first, so the caller can assert
 * further facts about them (durations, `source`, attributes) without re-walking.
 */
export function expectAncestorKinds(
  events: SpanSource,
  start: TelemetryEvent,
  expected: readonly AncestorKindStep[],
  options: AncestorKindsOptions = {},
): TelemetryEvent[] {
  const index = toSpanIndex(events);
  const chain = ancestorChainOf(start, index, { maxDepth: options.maxDepth });
  const matched: TelemetryEvent[] = [];
  let stepIndex = 0;

  for (const ancestor of chain) {
    const step = expected[stepIndex];

    if (step === undefined) {
      break;
    }

    if (stepAccepts(ancestor.kind, step)) {
      matched.push(ancestor);
      stepIndex += 1;
    }
  }

  const unmatched = expected[stepIndex];

  expect(
    stepIndex,
    [
      prefixed(options.message, 'The ordered ancestor chain did not match.'),
      `  expected (nearest first): ${expected.map(describeStep).join(' -> ')}`,
      `  matched ${String(stepIndex)} of ${String(expected.length)} steps${
        unmatched === undefined ? '' : `; first unmatched: ${describeStep(unmatched)}`
      }`,
      `  start: kind=${start.kind} name="${truncate(start.name)}" spanId=${start.spanId} traceId=${start.traceId}`,
      `  actual chain (nearest first, ${String(chain.length)} ancestor(s)): ${formatList(
        chain.map(describeEvent),
      )}`,
    ].join('\n'),
  ).toBe(expected.length);

  if (options.sameTrace !== false) {
    const foreign = matched.filter((ancestor) => ancestor.traceId !== start.traceId);

    expect(
      foreign.length,
      [
        prefixed(options.message, 'Matched ancestors do not all share the starting trace.'),
        `  start traceId: ${start.traceId}`,
        `  foreign (${String(foreign.length)}): ${formatList(
          foreign.map((ancestor) => `${describeEvent(ancestor)} traceId=${ancestor.traceId}`),
        )}`,
      ].join('\n'),
    ).toBe(0);
  }

  return matched;
}

/**
 * Is this source already an index?
 *
 * A type predicate rather than an inline `Array.isArray`: that guard is
 * declared `arg is any[]`, which a `readonly TelemetryEvent[]` is not assignable
 * to, so it narrows the array branch but leaves the other branch the whole
 * union. Stating the predicate narrows both, with no type assertion anywhere.
 */
function isSpanIndex(source: SpanSource): source is ReadonlyMap<string, TelemetryEvent> {
  return !Array.isArray(source);
}

/** Accepts either shape a spec holds events in and yields a span index. */
function toSpanIndex(source: SpanSource): ReadonlyMap<string, TelemetryEvent> {
  return isSpanIndex(source) ? source : buildSpanIndex(source);
}

/** The distinct trace ids present in a set of events. */
export function traceIdsOf(events: readonly TelemetryEvent[]): Set<string> {
  const ids = new Set<string>();

  for (const event of events) {
    ids.add(event.traceId);
  }

  return ids;
}

/** How {@link expectSingleTrace} narrows and reports. */
export interface SingleTraceOptions {
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
  /**
   * Narrows the events considered before the reduction, for a capture that
   * legitimately holds more than one trace — a page that also loaded data on
   * mount, an earlier interaction in the same capture.
   */
  readonly filter?: ((event: TelemetryEvent) => boolean) | undefined;
}

/**
 * Asserts the considered events belong to exactly one trace, and returns its id.
 *
 * The reduction every correlation spec would otherwise repeat. With a `filter`
 * it asserts one *dominant* trace among the events the spec cares about; without
 * one it asserts the whole set shares a trace.
 */
export function expectSingleTrace(
  events: readonly TelemetryEvent[],
  options: SingleTraceOptions = {},
): string {
  const considered = options.filter === undefined ? events : events.filter(options.filter);
  const counts = countBy(considered, (event) => event.traceId);
  const first = required(
    considered[0],
    [
      prefixed(options.message, 'No events were available to correlate.'),
      `  events supplied: ${String(events.length)}, considered after filtering: ${String(
        considered.length,
      )}`,
    ].join('\n'),
  );

  expect(
    counts.size,
    [
      prefixed(options.message, 'The considered events span more than one trace.'),
      `  events considered: ${String(considered.length)}`,
      `  traces: ${formatCounts(counts)}`,
    ].join('\n'),
  ).toBe(1);

  return first.traceId;
}

/** The events of one kind, or of any of several kinds, preserving input order. */
export function eventsOfKind(
  events: readonly TelemetryEvent[],
  kinds: TelemetryKind | readonly TelemetryKind[],
): TelemetryEvent[] {
  const accepted: readonly TelemetryKind[] = typeof kinds === 'string' ? [kinds] : kinds;

  return events.filter((event) => accepted.includes(event.kind));
}

/** How {@link expectEventOfKind} narrows and reports. */
export interface EventOfKindOptions {
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
  /** Narrows the candidates further, for example to a name or a tier. */
  readonly predicate?: ((event: TelemetryEvent) => boolean) | undefined;
}

/** Renders one or several expected kinds for a failure message. */
function describeKinds(kinds: TelemetryKind | readonly TelemetryKind[]): string {
  return typeof kinds === 'string' ? kinds : kinds.join('|');
}

/**
 * Asserts the capture holds an event of the given kind, and returns the first.
 *
 * The failure message lists the kinds that **were** present with their counts,
 * which is the whole diagnostic for the standard "capture yielded the wrong
 * tier" failure: an interaction question whose server signals never armed, a
 * database question against a dev server started without the preload.
 */
export function expectEventOfKind(
  events: readonly TelemetryEvent[],
  kind: TelemetryKind | readonly TelemetryKind[],
  options: EventOfKindOptions = {},
): TelemetryEvent {
  const ofKind = eventsOfKind(events, kind);
  const candidates = options.predicate === undefined ? ofKind : ofKind.filter(options.predicate);

  return required(
    candidates[0],
    [
      prefixed(
        options.message,
        `No captured event of kind ${describeKinds(kind)}${
          options.predicate === undefined ? '' : ' matching the predicate'
        } was found.`,
      ),
      `  events captured: ${String(events.length)}`,
      `  kinds present: ${formatCounts(countBy(events, (event) => event.kind))}`,
      ...(ofKind.length === 0
        ? []
        : [
            `  of that kind but rejected by the predicate (${String(ofKind.length)}): ${formatList(
              ofKind.map(describeEvent),
            )}`,
          ]),
    ].join('\n'),
  );
}

/*
 * ---------------------------------------------------------------------------
 * Panel specifications
 * ---------------------------------------------------------------------------
 */

/**
 * Every node type a specification's layout contains, at any depth.
 *
 * The traversal is the schema package's own `walkPanelNodes`, never a
 * hand-written recursion over `layout`: a layout node's children live under a
 * field the schema owns, and a private copy of that knowledge here would go
 * stale the first time a container node gains a second child collection.
 */
export function nodeTypesOf(spec: PanelSpec): Set<PanelNodeType> {
  const types = new Set<PanelNodeType>();

  walkPanelNodes(spec.layout, (node) => {
    types.add(node.type);
  });

  return types;
}

/**
 * The **visualization** node types a specification contains.
 *
 * The layout/visualization split is read from `PANEL_NODE_CATALOG` through
 * `catalogEntryFor`, never from a list restated here. A node type added to the
 * catalog therefore cannot silently bypass the materially-different check below
 * by being unknown to this module.
 */
export function visualizationNodeTypesOf(spec: PanelSpec): Set<PanelNodeType> {
  const types = new Set<PanelNodeType>();

  for (const type of nodeTypesOf(spec)) {
    if (catalogEntryFor(type).kind === 'visualization') {
      types.add(type);
    }
  }

  return types;
}

/**
 * The overlap two generated panels may legitimately share (AAP 0.6.5).
 *
 * The ruling is that the latency panel and the render panel share only the
 * summary header, the metric cards and the source chips, and that their
 * visualization bodies are otherwise disjoint. The summary header is not a
 * layout node — `PanelHost` renders it from `spec.summary` — so it never appears
 * in a node-type set, which leaves exactly `metricCards` and `sourceLink` as
 * permitted members of the intersection.
 */
export const PERMITTED_VISUALIZATION_OVERLAP: ReadonlySet<PanelNodeType> = new Set<PanelNodeType>([
  'metricCards',
  'sourceLink',
]);

/** How {@link expectDisjointVisualizations} compares and reports. */
export interface DisjointVisualizationOptions {
  /** The permitted intersection. Defaults to {@link PERMITTED_VISUALIZATION_OVERLAP}. */
  readonly permitted?: ReadonlySet<PanelNodeType> | undefined;
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
  /** Names for the two panels in the failure text. Defaults to `['panel A', 'panel B']`. */
  readonly labels?: readonly [string, string] | undefined;
}

/**
 * Asserts two generated panels are materially different (AAP 0.6.5, 0.8.4).
 *
 * Three assertions, because "materially different" is not one statement:
 *
 * 1. each panel composes at least one visualization node — without this the
 *    comparison passes vacuously for two empty layouts;
 * 2. the intersection of the two visualization sets is a subset of `permitted`;
 * 3. **each** panel contributes at least one visualization type the other
 *    lacks. Two panels drawn from the permitted overlap alone would satisfy (2)
 *    while being the same panel twice, so difference is proven rather than
 *    asserted by construction.
 */
export function expectDisjointVisualizations(
  a: PanelSpec,
  b: PanelSpec,
  options: DisjointVisualizationOptions = {},
): void {
  const permitted = options.permitted ?? PERMITTED_VISUALIZATION_OVERLAP;
  const [labelA, labelB] = options.labels ?? ['panel A', 'panel B'];
  const typesA = visualizationNodeTypesOf(a);
  const typesB = visualizationNodeTypesOf(b);
  const sets = [
    `  ${labelA} "${truncate(a.title)}" (${a.id}): ${formatList([...typesA].sort())}`,
    `  ${labelB} "${truncate(b.title)}" (${b.id}): ${formatList([...typesB].sort())}`,
    `  permitted overlap: ${formatList([...permitted].sort())}`,
  ].join('\n');

  expect(
    typesA.size,
    [prefixed(options.message, `${labelA} composes no visualization nodes.`), sets].join('\n'),
  ).toBeGreaterThan(0);
  expect(
    typesB.size,
    [prefixed(options.message, `${labelB} composes no visualization nodes.`), sets].join('\n'),
  ).toBeGreaterThan(0);

  const shared = [...typesA].filter((type) => typesB.has(type)).sort();
  const forbidden = shared.filter((type) => !permitted.has(type));

  expect(
    forbidden,
    [
      prefixed(
        options.message,
        'The two panels share visualization node types beyond the permitted overlap.',
      ),
      `  shared: ${formatList(shared)}`,
      `  beyond the permitted overlap: ${formatList(forbidden)}`,
      sets,
    ].join('\n'),
  ).toEqual([]);

  const onlyA = [...typesA].filter((type) => !typesB.has(type)).sort();
  const onlyB = [...typesB].filter((type) => !typesA.has(type)).sort();

  expect(
    onlyA.length,
    [
      prefixed(options.message, `${labelA} contributes no visualization type ${labelB} lacks.`),
      sets,
    ].join('\n'),
  ).toBeGreaterThan(0);
  expect(
    onlyB.length,
    [
      prefixed(options.message, `${labelB} contributes no visualization type ${labelA} lacks.`),
      sets,
    ].join('\n'),
  ).toBeGreaterThan(0);
}

/** How {@link expectValidPanelSpec} validates and reports. */
export interface ValidPanelSpecOptions {
  /**
   * Accept a deterministic fallback panel.
   *
   * `false` by default, because AAP 0.8.4 requires a genuinely generated panel:
   * a fallback assembled from the capture aggregates proves the failure path
   * works, not that the pipeline produced an answer. A spec deliberately
   * checking that path opts in.
   */
  readonly allowFallback?: boolean | undefined;
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
}

/**
 * Validates an unknown value as a panel specification and returns it typed.
 *
 * `validatePanelSpec` returns a `Result` and never throws, so the `Err` is
 * unwrapped here and turned into readable failure text carrying the error code,
 * the rendered issue list the schema package already built (paths and codes, no
 * captured values) and the hint. Ignoring that `Err` — the easy mistake with a
 * `Result` API — would let a spec assert against a value it never validated.
 */
export function expectValidPanelSpec(
  value: unknown,
  options: ValidPanelSpecOptions = {},
): PanelSpec {
  const validated = validatePanelSpec(value);

  if (!validated.ok) {
    const { error } = validated;
    const detail = [
      prefixed(options.message, 'The panel specification failed validation.'),
      `  code: ${error.code}`,
      `  issues: ${truncate(error.message, 600)}`,
      ...(error.hint === undefined ? [] : [`  hint: ${truncate(error.hint, 300)}`]),
    ].join('\n');

    expect(validated.ok, detail).toBe(true);
    throw error;
  }

  const spec = validated.value;

  if (options.allowFallback !== true) {
    expect(
      spec.meta?.fallback === true,
      [
        prefixed(
          options.message,
          'The panel is the deterministic fallback, not a generated panel.',
        ),
        `  panel: "${truncate(spec.title)}" (${spec.id}) version ${String(spec.panelVersion)}`,
        '  pass { allowFallback: true } where the fallback path is what the spec asserts',
      ].join('\n'),
    ).toBe(false);
  }

  return spec;
}

/** How the node-type assertions report. */
export interface NodeTypesOptions {
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
}

/**
 * Asserts a panel contains every one of the required node types.
 *
 * @returns Every node type the panel contains, so a caller can go on to compare
 * sets without walking the layout again.
 */
export function expectNodeTypes(
  spec: PanelSpec,
  requiredTypes: readonly PanelNodeType[],
  options: NodeTypesOptions = {},
): Set<PanelNodeType> {
  const present = nodeTypesOf(spec);
  const missing = requiredTypes.filter((type) => !present.has(type));

  expect(
    missing,
    [
      prefixed(options.message, 'The panel is missing required node types.'),
      `  panel: "${truncate(spec.title)}" (${spec.id})`,
      `  required: ${formatList(requiredTypes)}`,
      `  present: ${formatList([...present].sort())}`,
    ].join('\n'),
  ).toEqual([]);

  return present;
}

/**
 * Asserts a panel contains at least one of the given node types, and returns
 * the first one it contains.
 *
 * `demo-slow-interaction.spec.ts` requires `timeline` and `queryTable` through
 * {@link expectNodeTypes} plus at least one of `flame` / `waterfall` through
 * this one: which of the two the generator chose is its decision to make, and
 * pinning it would assert the generator's taste rather than the product's
 * behaviour.
 */
export function expectAnyNodeType(
  spec: PanelSpec,
  oneOf: readonly PanelNodeType[],
  options: NodeTypesOptions = {},
): PanelNodeType {
  const present = nodeTypesOf(spec);

  return required(
    oneOf.find((type) => present.has(type)),
    [
      prefixed(options.message, 'The panel contains none of the acceptable node types.'),
      `  panel: "${truncate(spec.title)}" (${spec.id})`,
      `  acceptable: ${formatList(oneOf)}`,
      `  present: ${formatList([...present].sort())}`,
    ].join('\n'),
  );
}

/*
 * ---------------------------------------------------------------------------
 * Evidence: observed facts against the capture
 * ---------------------------------------------------------------------------
 */

/** The two finding collections, wherever they were read from. */
export interface Findings {
  /** Statements that must each cite evidence present in the capture. */
  readonly observed: readonly Fact[];
  /** Inferences, each carrying a confidence level. */
  readonly likelyCauses: readonly Hypothesis[];
}

/**
 * Reads the findings out of an analysis result or a panel specification.
 *
 * An `AnalysisResult` carries `observed` / `likelyCauses` at its top level; a
 * `PanelSpec` carries them under `summary`. One accessor keeps the assertions
 * below identical for both.
 */
function findingsOf(source: AnalysisResult | PanelSpec): Findings {
  if ('summary' in source) {
    return { observed: source.summary.observed, likelyCauses: source.summary.likelyCauses };
  }

  return { observed: source.observed, likelyCauses: source.likelyCauses };
}

/** How the evidence assertions report. */
export interface EvidenceOptions {
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
}

/** One evidence reference and where it was cited from. */
interface CitedReference {
  /** `observed[0]`, `likelyCauses[2]` — the citing finding. */
  readonly label: string;
  /** The event id cited. */
  readonly eventId: string;
}

/**
 * Asserts every cited event id resolves to an event of the capture, and that
 * every observed fact cites at least one.
 *
 * The structural half of AAP 0.8.4's rule that observed facts cite evidence
 * that exists. It is deliberately checked against the events the spec actually
 * fetched from `POST /sessions/:id/panel-data` rather than through the schema
 * package's semantic validation: `validateAgainstCapture` works from a
 * `CaptureSummary`, whose sections are bounded top-N lists, so it answers
 * `unverifiable` for a reference to an event outside them — an honest answer
 * that is not the definitive one an acceptance test needs.
 *
 * Only ids are reported on failure, never the statements that cited them.
 */
export function expectEvidenceResolves(
  source: AnalysisResult | PanelSpec,
  events: readonly TelemetryEvent[],
  options: EvidenceOptions = {},
): void {
  const findings = findingsOf(source);
  const known = new Set<string>(events.map((event) => event.id));
  const cited: CitedReference[] = [];
  const unevidenced: string[] = [];

  findings.observed.forEach((fact, position) => {
    const label = `observed[${String(position)}]`;

    if (fact.evidence.length === 0) {
      unevidenced.push(label);
    }

    for (const reference of fact.evidence) {
      cited.push({ label, eventId: reference.eventId });
    }
  });

  findings.likelyCauses.forEach((hypothesis, position) => {
    const label = `likelyCauses[${String(position)}]`;

    for (const reference of hypothesis.evidence) {
      cited.push({ label, eventId: reference.eventId });
    }
  });

  expect(
    unevidenced,
    [
      prefixed(options.message, 'An observed fact cites no evidence at all.'),
      `  observed facts: ${String(findings.observed.length)}`,
      `  without evidence: ${formatList(unevidenced)}`,
    ].join('\n'),
  ).toEqual([]);

  const unresolved = cited.filter((reference) => !known.has(reference.eventId));

  expect(
    unresolved.length,
    [
      prefixed(options.message, 'Evidence references do not resolve to captured events.'),
      `  references cited: ${String(cited.length)}, capture holds ${String(
        known.size,
      )} distinct event ids`,
      `  unresolved (${String(unresolved.length)}): ${formatList(
        unresolved.map((reference) => `${reference.label} -> ${reference.eventId}`),
      )}`,
    ].join('\n'),
  ).toBe(0);
}

/**
 * Asserts an analysis keeps observation and inference apart (AAP 0.8.4).
 *
 * Three checks: the analysis observed something at all — the schema permits an
 * empty `observed` array, so non-emptiness is asserted here rather than assumed
 * —, every hypothesis carries a confidence from the schema's vocabulary, and no
 * observed statement is merely a hypothesis restated. The last is what stops a
 * pipeline presenting an inference as a measurement: a statement that appears in
 * both lists has been laundered from one to the other.
 */
export function expectFactsAndHypothesesSeparate(
  analysis: AnalysisResult,
  options: EvidenceOptions = {},
): void {
  expect(
    analysis.observed.length,
    [
      prefixed(options.message, 'The analysis records no observed facts.'),
      `  likely causes: ${String(analysis.likelyCauses.length)}`,
    ].join('\n'),
  ).toBeGreaterThan(0);

  const invalidConfidence = analysis.likelyCauses
    .map((hypothesis, position) => ({ position, confidence: hypothesis.confidence }))
    .filter((entry) => !isConfidenceLevel(entry.confidence));

  expect(
    invalidConfidence.length,
    [
      prefixed(options.message, 'A likely cause carries no recognised confidence level.'),
      `  allowed: ${CONFIDENCE_LEVELS.join(', ')}`,
      `  offending: ${formatList(
        invalidConfidence.map((entry) => `likelyCauses[${String(entry.position)}]`),
      )}`,
    ].join('\n'),
  ).toBe(0);

  const observedByStatement = new Map<string, number>();

  analysis.observed.forEach((fact, position) => {
    const key = normalizeStatement(fact.statement);

    if (!observedByStatement.has(key)) {
      observedByStatement.set(key, position);
    }
  });

  const duplicated = analysis.likelyCauses
    .map((hypothesis, position) => ({
      position,
      observedAt: observedByStatement.get(normalizeStatement(hypothesis.statement)),
    }))
    .filter((entry) => entry.observedAt !== undefined);

  expect(
    duplicated.length,
    [
      prefixed(options.message, 'A likely cause repeats an observed statement verbatim.'),
      `  offending: ${formatList(
        duplicated.map(
          (entry) =>
            `likelyCauses[${String(entry.position)}] == observed[${String(entry.observedAt)}]`,
        ),
      )}`,
    ].join('\n'),
  ).toBe(0);
}

/*
 * ---------------------------------------------------------------------------
 * Aggregates: renders, requests, queries, metrics
 * ---------------------------------------------------------------------------
 */

/** The render statistics for one component, if the capture holds any. */
export function renderStatFor(
  stats: readonly RenderStat[],
  component: string,
): RenderStat | undefined {
  return stats.find((stat) => stat.component === component);
}

/** How the render assertions report. */
export interface RenderStatOptions {
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
}

/**
 * Asserts the capture holds render statistics for a component, and returns them.
 *
 * The component name arrives from the spec, never from this module: a demo
 * component name written here would be exactly the hardcoded demo knowledge the
 * product forbids (AAP 0.5.4), and `tests/e2e/**` being excluded from the guard
 * script is not a licence to write one.
 */
export function expectRenderStat(
  stats: readonly RenderStat[],
  component: string,
  options: RenderStatOptions = {},
): RenderStat {
  return required(
    renderStatFor(stats, component),
    [
      prefixed(options.message, `No renders were captured for component "${truncate(component)}".`),
      `  components present (${String(stats.length)}): ${formatList(
        stats.map((stat) => `${stat.component} x${String(stat.renderCount)}`),
      )}`,
    ].join('\n'),
  );
}

/** How {@link expectRenderTrigger} thresholds and reports. */
export interface RenderTriggerOptions {
  /** The smallest acceptable count in the bucket. Defaults to `1`. */
  readonly minCount?: number | undefined;
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
}

/**
 * Asserts a component's trigger histogram bucket is populated, and returns its
 * count.
 *
 * The two buckets that carry a product ruling are checked against their mirror
 * fields as part of the assertion:
 *
 * - `unchanged` must equal `unchangedRenderCount` — a render whose props were
 *   shallow-equal, whose own hook state did not change and whose consumed
 *   context values did not change;
 * - `unknown` must equal `unknownTriggerCount` — a render whose trigger could
 *   not be determined, which counts **only** here.
 *
 * The two are disjoint by construction and a caller must never add them: a
 * render with an undeterminable trigger is not evidence of a render with stable
 * inputs, which is the distinction the excessive-render panel rests on.
 */
export function expectRenderTrigger(
  stat: RenderStat,
  trigger: RenderTrigger,
  options: RenderTriggerOptions = {},
): number {
  const minCount = options.minCount ?? 1;
  const count = stat.triggers[trigger];
  const context = [
    `  component: ${truncate(stat.component)} (${String(stat.renderCount)} render(s))`,
    `  triggers: ${formatCounts(new Map(Object.entries(stat.triggers)))}`,
  ].join('\n');

  expect(
    count,
    [
      prefixed(
        options.message,
        `Fewer than ${String(minCount)} render(s) were attributed to trigger "${trigger}".`,
      ),
      context,
    ].join('\n'),
  ).toBeGreaterThanOrEqual(minCount);

  if (trigger === 'unchanged') {
    expect(
      stat.unchangedRenderCount,
      [
        prefixed(
          options.message,
          'unchangedRenderCount disagrees with the "unchanged" histogram bucket.',
        ),
        context,
      ].join('\n'),
    ).toBe(stat.triggers.unchanged);
  }

  if (trigger === 'unknown') {
    expect(
      stat.unknownTriggerCount,
      [
        prefixed(
          options.message,
          'unknownTriggerCount disagrees with the "unknown" histogram bucket.',
        ),
        context,
      ].join('\n'),
    ).toBe(stat.triggers.unknown);
  }

  return count;
}

/** Renders a request group for a failure message: no URL, no query, no headers. */
function describeRequestGroup(group: RequestGroup): string {
  return [
    `${group.method} ${truncate(group.path)}`,
    `count=${String(group.count)}`,
    `duplicates=${String(group.duplicateCount)}`,
    `groupedBy=${group.groupedBy}`,
    `initiators=[${formatList(group.initiators, 4)}]`,
  ].join(' ');
}

/**
 * The request groups that contain redundant occurrences.
 *
 * `hasDuplicates` and a non-zero `duplicateCount` are the aggregate's two ways
 * of saying the same thing; both are read so a group stays selected if either is
 * the one a future aggregate populates.
 */
export function duplicateGroupsOf(groups: readonly RequestGroup[]): RequestGroup[] {
  return groups.filter((group) => group.hasDuplicates || group.duplicateCount >= 1);
}

/** How {@link expectDuplicateGroup} thresholds and reports. */
export interface DuplicateGroupOptions {
  /** The smallest acceptable redundancy within the group. Defaults to `1`. */
  readonly minDuplicateCount?: number | undefined;
  /** The smallest acceptable number of distinct initiating components. Defaults to `1`. */
  readonly minInitiators?: number | undefined;
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
}

/**
 * Asserts a duplicate request group matches, and returns the most redundant one.
 *
 * `demo-duplicate-requests.spec.ts` asks for a group whose redundancy is at
 * least two and whose occurrences came from two distinct initiating components
 * — the two mounted rails of the seeded defect — so both thresholds are
 * parameters rather than constants. Candidates are ordered by redundancy so the
 * returned group is the strongest evidence, with a stable secondary key on the
 * group id.
 */
export function expectDuplicateGroup(
  groups: readonly RequestGroup[],
  predicate: (group: RequestGroup) => boolean,
  options: DuplicateGroupOptions = {},
): RequestGroup {
  const minDuplicateCount = options.minDuplicateCount ?? 1;
  const minInitiators = options.minInitiators ?? 1;
  const candidates = duplicateGroupsOf(groups)
    .filter(predicate)
    .filter(
      (group) =>
        group.duplicateCount >= minDuplicateCount && group.initiators.length >= minInitiators,
    )
    .sort(
      (left, right) =>
        right.duplicateCount - left.duplicateCount || left.id.localeCompare(right.id),
    );

  return required(
    candidates[0],
    [
      prefixed(options.message, 'No duplicate request group matched.'),
      `  required: duplicateCount >= ${String(minDuplicateCount)}, distinct initiators >= ${String(
        minInitiators,
      )}, plus the spec's predicate`,
      `  groups aggregated: ${String(groups.length)}, of which ${String(
        duplicateGroupsOf(groups).length,
      )} hold duplicates`,
      ...groups.slice(0, MAX_LISTED_ENTRIES).map((group) => `    ${describeRequestGroup(group)}`),
      ...(groups.length > MAX_LISTED_ENTRIES
        ? [`    (+${String(groups.length - MAX_LISTED_ENTRIES)} more)`]
        : []),
    ].join('\n'),
  );
}

/** Renders a query group for a failure message: parameterized statement only. */
function describeQueryGroup(group: QueryGroup): string {
  return [
    `x${String(group.executionCount)}`,
    `"${truncate(group.normalizedStatement, MAX_STATEMENT_LENGTH)}"`,
    `callers=[${formatList(
      group.callers.map((caller) => truncate(caller.name, 40)),
      4,
    )}]`,
  ].join(' ');
}

/** The query groups a predicate selects, preserving aggregate order. */
export function queryGroupMatching(
  groups: readonly QueryGroup[],
  predicate: (group: QueryGroup) => boolean,
): QueryGroup[] {
  return groups.filter(predicate);
}

/** How {@link expectQueryGroup} thresholds and reports. */
export interface QueryGroupOptions {
  /** The smallest acceptable execution count. Defaults to `1`. */
  readonly minExecutionCount?: number | undefined;
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
}

/**
 * Asserts a query group matches, and returns the most frequently executed one.
 *
 * Predicates operate on `normalizedStatement` / `statement` — already
 * parameterized with `$1` placeholders and stripped of inline literals by the
 * redaction layer — and on `callers`. Row contents were never captured, so
 * nothing a predicate can reach here carries user data.
 */
export function expectQueryGroup(
  groups: readonly QueryGroup[],
  predicate: (group: QueryGroup) => boolean,
  options: QueryGroupOptions = {},
): QueryGroup {
  const minExecutionCount = options.minExecutionCount ?? 1;
  const candidates = queryGroupMatching(groups, predicate)
    .filter((group) => group.executionCount >= minExecutionCount)
    .sort(
      (left, right) =>
        right.executionCount - left.executionCount || left.id.localeCompare(right.id),
    );

  return required(
    candidates[0],
    [
      prefixed(options.message, 'No database query group matched.'),
      `  required: executionCount >= ${String(minExecutionCount)}, plus the spec's predicate`,
      `  groups aggregated (${String(groups.length)}):`,
      ...groups.slice(0, MAX_LISTED_ENTRIES).map((group) => `    ${describeQueryGroup(group)}`),
      ...(groups.length > MAX_LISTED_ENTRIES
        ? [`    (+${String(groups.length - MAX_LISTED_ENTRIES)} more)`]
        : []),
    ].join('\n'),
  );
}

/** Renders a metric for a failure message. */
function describeMetric(metric: MetricValue): string {
  return metric.available && metric.value !== undefined
    ? `${metric.id}=${String(metric.value)}${metric.unit === 'count' ? '' : ` ${metric.unit}`}`
    : `${metric.id}=n/a`;
}

/** The computed metric with the given id, if the capture summary holds it. */
export function metricValue(
  metrics: readonly MetricValue[],
  id: MetricId,
): MetricValue | undefined {
  return metrics.find((metric) => metric.id === id);
}

/** How the metric assertions report. */
export interface MetricOptions {
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
}

/** Asserts the id is one the product computes — a guard for a value cast in from JSON. */
function expectKnownMetricId(id: MetricId): void {
  expect(isMetricId(id), `"${truncate(id, 64)}" is not a known metric id`).toBe(true);
}

/**
 * Asserts a metric was computed and carries a finite value, and returns it.
 *
 * @returns The metric's numeric value, so a spec compares or thresholds it
 * without looking the metric up twice.
 */
export function expectMetricAvailable(
  metrics: readonly MetricValue[],
  id: MetricId,
  options: MetricOptions = {},
): number {
  expectKnownMetricId(id);

  const present = `  metrics present (${String(metrics.length)}): ${formatList(
    metrics.map(describeMetric),
  )}`;
  const metric = required(
    metricValue(metrics, id),
    [prefixed(options.message, `Metric "${id}" is absent from the capture summary.`), present].join(
      '\n',
    ),
  );

  expect(
    metric.available,
    [
      prefixed(options.message, `Metric "${id}" was reported unavailable.`),
      ...(metric.note === undefined ? [] : [`  note: ${truncate(metric.note, 160)}`]),
      present,
    ].join('\n'),
  ).toBe(true);

  return finiteNumber(
    metric.value,
    [
      prefixed(options.message, `Metric "${id}" is available but carries no finite value.`),
      present,
    ].join('\n'),
  );
}

/**
 * Asserts a metric is legitimately unavailable, and returns it.
 *
 * AAP 0.6.6 records `transferred_bytes` as genuinely unobservable for server
 * spans, so "n/a" is a correct answer that must be assertable as such. Treating
 * an unavailable metric as a failure — or, worse, reading its absent value as
 * zero — would turn a recorded gap into a fabricated measurement.
 */
export function expectMetricUnavailable(
  metrics: readonly MetricValue[],
  id: MetricId,
  options: MetricOptions = {},
): MetricValue {
  expectKnownMetricId(id);

  const present = `  metrics present (${String(metrics.length)}): ${formatList(
    metrics.map(describeMetric),
  )}`;
  const metric = required(
    metricValue(metrics, id),
    [prefixed(options.message, `Metric "${id}" is absent from the capture summary.`), present].join(
      '\n',
    ),
  );

  expect(
    metric.available,
    [prefixed(options.message, `Metric "${id}" was expected to be unavailable.`), present].join(
      '\n',
    ),
  ).toBe(false);

  expect(
    metric.value,
    prefixed(options.message, `Unavailable metric "${id}" must not carry a value.`),
  ).toBeUndefined();

  return metric;
}

/*
 * ---------------------------------------------------------------------------
 * Source locations
 * ---------------------------------------------------------------------------
 */

/** How {@link expectSourceLocationShape} compares and reports. */
export interface SourceLocationShapeOptions {
  /** The exact project-relative POSIX path expected, when the spec knows it. */
  readonly expectedFile?: string | undefined;
  /** The exact 1-based line expected, computed by the spec at runtime. */
  readonly expectedLine?: number | undefined;
  /** The exact symbol expected, when the spec knows it. */
  readonly expectedSymbol?: string | undefined;
  /** Prefixes the failure text with what the spec was proving. */
  readonly message?: string | undefined;
}

/**
 * Asserts a runtime item's source location is well formed, and returns it.
 *
 * Checked: the path is project-relative POSIX (not absolute, no backslash, no
 * `..` segment, and accepted by `@debuggen/shared`'s own
 * `isSafeRelativePath` — the same predicate the schema refines with, so a
 * location that passes here is one the service would accept for
 * `source.open`); `line` and `column` are 1-based integers; `endLine`, when
 * present, is at or after `line`; `resolvedBy` names one of the four resolution
 * routes; `confidence` sits in `[0, 1]`.
 *
 * This helper embeds **no** line number of its own. A spec that knows where the
 * location should point computes it at runtime — `demo-app.ts`'s
 * `sourceLineContaining` reads the line out of the file under test — and passes
 * it in, so a refactor of the target project moves the expectation with the
 * code instead of breaking the suite.
 */
export function expectSourceLocationShape(
  location: SourceLocation | undefined,
  options: SourceLocationShapeOptions = {},
): SourceLocation {
  const resolved = required(
    location,
    prefixed(options.message, 'Expected a source location, received none.'),
  );
  const where = [
    `  location: ${truncate(resolved.file, 200)}:${String(resolved.line)}:${String(
      resolved.column,
    )}`,
    `  symbol: ${resolved.symbol === undefined ? '(none)' : truncate(resolved.symbol, 80)}`,
    `  resolvedBy: ${resolved.resolvedBy}, confidence: ${String(resolved.confidence)}`,
  ].join('\n');
  const fail = (what: string): string => [prefixed(options.message, what), where].join('\n');

  expect(resolved.file.length, fail('A source location must name a file.')).toBeGreaterThan(0);
  expect(
    resolved.file.startsWith('/'),
    fail('A source location must be project-relative, not absolute.'),
  ).toBe(false);
  expect(resolved.file.includes('\\'), fail('A source location must use POSIX separators.')).toBe(
    false,
  );
  expect(
    resolved.file.split('/').includes('..'),
    fail('A source location must not escape the project root.'),
  ).toBe(false);
  expect(
    isSafeRelativePath(resolved.file),
    fail('A source location path must be a safe relative path.'),
  ).toBe(true);
  expect(
    Number.isInteger(resolved.line) && resolved.line >= 1,
    fail('A source location line must be a 1-based integer.'),
  ).toBe(true);
  expect(
    Number.isInteger(resolved.column) && resolved.column >= 1,
    fail('A source location column must be a 1-based integer.'),
  ).toBe(true);

  if (resolved.endLine !== undefined) {
    expect(
      resolved.endLine >= resolved.line,
      fail('A source location endLine must not precede its line.'),
    ).toBe(true);
  }

  expect(
    SOURCE_RESOLVED_BY.includes(resolved.resolvedBy),
    fail(`resolvedBy must be one of: ${SOURCE_RESOLVED_BY.join(', ')}.`),
  ).toBe(true);
  expect(
    Number.isFinite(resolved.confidence) && resolved.confidence >= 0 && resolved.confidence <= 1,
    fail('A source location confidence must sit within [0, 1].'),
  ).toBe(true);

  if (options.expectedFile !== undefined) {
    expect(resolved.file, fail('The source location names an unexpected file.')).toBe(
      options.expectedFile,
    );
  }

  if (options.expectedLine !== undefined) {
    expect(resolved.line, fail('The source location names an unexpected line.')).toBe(
      options.expectedLine,
    );
  }

  if (options.expectedSymbol !== undefined) {
    expect(resolved.symbol, fail('The source location names an unexpected symbol.')).toBe(
      options.expectedSymbol,
    );
  }

  return resolved;
}
