/**
 * `components/Waterfall` — the request and dependency view of the node catalog's
 * `waterfall` type, and one of the four components the slow-interaction
 * acceptance panel is built from (AAP 0.6.5, 0.8.3).
 *
 * ## What it answers, and why offset and nesting carry the answer
 *
 * A timeline answers "which tier held the time"; a waterfall answers "what was
 * waiting on what" (AAP 0.6.2). The story it exists to tell is that a slow
 * interaction spent its time in a *dependency* — a statement that ran long, an
 * external call that ran after another instead of beside it — rather than in the
 * handler the developer clicked. Exactly two properties make that story legible,
 * and they are the two this module treats as load-bearing:
 *
 *   - **Offsets are relative to the first included call**, never wall-clock
 *     time, so a bar's distance from the left edge *is* the wait that preceded
 *     it, and sequential work reads as a staircase.
 *   - **Children nest under the call that was waiting on them**, so the row that
 *     holds the time is visibly *inside* the row that was blocked by it.
 *
 * Nesting is reconstructed from the correlated `parentSpanId` links the service
 * already resolved, and a call whose immediate parent is not itself a waterfall
 * kind attaches to its nearest *included* ancestor rather than being orphaned to
 * the top level — which is what keeps a database statement underneath the server
 * request that issued it when the function span between them is not drawn here.
 *
 * ## The sources it draws
 *
 * The catalog entry for this node type accepts `spans` and `requests`
 * (`PANEL_NODE_CATALOG.waterfall.sources`), and validation rejects a node whose
 * query names anything else before this component is ever mounted. Both are
 * implemented here, plus the correlated `trace` payload — which costs a few
 * lines, cannot arrive through a validated specification, and means a host that
 * hands one over still renders a correct waterfall instead of an empty box:
 *
 *   - `spans` / `events` — the flat records and their parent links. The primary
 *     path: a page of records is filtered to the kinds this view draws, nested by
 *     ancestry, and ordered by start time.
 *   - `requests` — the grouped network result. Each group becomes one row; a
 *     group with more than one occurrence becomes a parent row spanning the
 *     occurrences, expandable into them. Grouping is **not** recomputed here:
 *     duplicate detection already happened in the service, on the pre-redaction
 *     request key (AAP 0.5.2), and this view only draws what it grouped.
 *   - `trace` — the ordered tree, walked directly, with calls of other kinds
 *     collapsed through so their included descendants keep their place.
 *
 * ## Privacy: render what arrived, and nothing more (AAP 0.5.2)
 *
 * URLs arrive with every query-parameter *value* already replaced per key, and
 * statements arrive parameterized with their literals replaced. Both are the
 * correct display form and are rendered verbatim: nothing here re-assembles a
 * URL from parts, unescapes a value, reconstructs a statement or offers to copy
 * a raw one. Request and response bodies are never captured, so no row can show
 * one, and row contents never exist — which is exactly why `db.rowCount` is
 * shown as a count. A transferred-byte figure is genuinely unavailable for some
 * calls; it renders as {@link NOT_AVAILABLE_LABEL}, never as a zero that would
 * read as "nothing was transferred".
 *
 * ## Constraints this module works under
 *
 *   - **Data only through the node's query.** One `useQuery` per source family,
 *     resolved by the ambient `DataProvider`. No socket, no `fetch`, no message
 *     name, no knowledge of a transport (AAP 0.1.2, 0.6.2).
 *   - **Interactions only through `PanelActions`.** Selection, source opening and
 *     disclosure are reported through the ambient actions, which may be absent —
 *     every call site chains optionally and an affordance that would lead nowhere
 *     is not rendered as a control.
 *   - **No measurement.** The time scale's range is a percentage interval, so
 *     bar geometry is relational and correct before layout: no
 *     `getBoundingClientRect`, no `ResizeObserver`, no `offsetWidth`. The
 *     colocated suite runs under happy-dom, where every measurement answers
 *     zero, and `host/registry.test.ts` renders this component against a
 *     recorded `spans` response — so it must work from data alone.
 *   - **Zero hardcoded CSS values.** Colour comes from `../utils/color` as token
 *     references, geometry from `../utils/scale` as unitless numbers, and the
 *     inline style of a bar is the `--dgc-*` custom properties the stylesheet's
 *     naming contract reserves for "a value only the component knows" plus the
 *     two geometry declarations that consume them — which is the contract
 *     `.dg-waterfall__bar` states in `../styles/components.css` ("`inset-inline-start`
 *     and `inline-size` are the component's, computed from the time scale").
 *     Neither declaration contains a literal: both are `var()` references to the
 *     properties beside them. The label slot's flex basis (`LABEL_SLOT_STYLE`)
 *     is the file's only other inline declaration and carries no design value
 *     either — a permitted `0` literal and two unitless flex factors, for the
 *     reason recorded there.
 *   - **Primitives, not raw elements.** Every non-SVG control and every piece of
 *     text is a primitive from `../primitives/**` or a container from
 *     `../layout/**`; there is no raw `button`, `input`, `select`, `table` or
 *     heading element in this file.
 *   - **Extensionless relative specifiers**, which is this workspace's
 *     `moduleResolution: "bundler"` convention — not the `.js`-suffixed
 *     convention of the Node-targeted packages.
 *
 * ## Accessibility
 *
 * The row list is the keyboard-reachable representation of the chart and is a
 * `role="tree"` of `role="treeitem"` rows: each row is focusable, activates with
 * Enter or Space, carries `aria-level` and — when it has children —
 * `aria-expanded`, and owns its child group through `aria-owns` (the group is a
 * DOM sibling because the row itself is the three-column grid the stylesheet
 * defines, and a fourth grid child would land in the label column). The arrow
 * keys of the tree pattern move between rows: down and up to the next and
 * previous row, right to open a closed row and then to step into it, left to
 * close an open one and then to step out to its parent, Home and End to either
 * end. Each row names itself with `aria-label`, so what is announced is the
 * label, what the call was, how far into the window it started and how long it
 * took, rather than the truncated label and the tooltip's copy of it. Every row
 * is its own tab stop — a deliberate departure from the pattern's single roving
 * stop, because a waterfall is read by reaching one row among many and the rows
 * are few — and the bar layer is `aria-hidden`, which the guidance prefers
 * where the duration is printed as text. The time axis is a `role="img"`
 * graphic whose label states the window it spans.
 */

import type { DataQuery, WaterfallNode } from '@debuggen/panel-schema';
import { DATA_QUERY_DEFAULT_OFFSET } from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import { clampNonNegative, roundMs } from '@debuggen/shared';
import type {
  DB_QUERY_ATTRIBUTE_KEYS,
  FETCH_ATTRIBUTE_KEYS,
  HTTP_SERVER_ATTRIBUTE_KEYS,
  RequestGroup,
  RequestOccurrence,
  TelemetryEvent,
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';
import clsx from 'clsx';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useId, useMemo, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactElement, ReactNode } from 'react';

import { Stack } from '../layout/Stack';
import { usePanelActions } from '../host/PanelActions';
import { useQuery } from '../host/useQuery';
import type { UseQueryResult } from '../host/useQuery';
import { Badge } from '../primitives/Badge';
import type { BadgeTone } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Code } from '../primitives/Code';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import { kindColorVar } from '../utils/color';
import {
  NOT_AVAILABLE_LABEL,
  formatBytes,
  formatCount,
  formatDuration,
  formatDurationCompact,
  formatKindLabel,
  formatStatusLabel,
  formatTierLabel,
  oneLinePreview,
} from '../utils/format';
import {
  DEFAULT_ROW_GUTTER,
  DEFAULT_ROW_HEIGHT,
  createTimeScale,
  generateAxisTicks,
  placeOffsetSpan,
} from '../utils/scale';
import type { AxisTick, TimeScale } from '../utils/scale';
import { SourceLink } from './SourceLink';

/* ---------------------------------------------------------------------------
 * Attribute keys
 *
 * The keys read from a record's attribute bag are declared here as constants
 * *typed against the telemetry package's own key catalogs*, which are imported
 * for their types only — no runtime import of `@debuggen/telemetry` exists in
 * this file, and none may.
 *
 * The typing is the point: renaming `http.status_code` upstream turns each line
 * below into a compile error in this file, instead of leaving a status column
 * that silently stops rendering. A bare string literal would buy nothing.
 * ------------------------------------------------------------------------- */

/** One of the keys the telemetry package declares for a `fetch` record. */
type FetchAttributeKey = (typeof FETCH_ATTRIBUTE_KEYS)[number];

/** One of the keys the telemetry package declares for an `http.server` record. */
type HttpServerAttributeKey = (typeof HTTP_SERVER_ATTRIBUTE_KEYS)[number];

/** One of the keys the telemetry package declares for a `db.query` record. */
type DbQueryAttributeKey = (typeof DB_QUERY_ATTRIBUTE_KEYS)[number];

/** The request method, as the producer reported it. */
const HTTP_METHOD_KEY: FetchAttributeKey = 'http.method';

/** The request URL, already redacted per query-parameter key. */
const URL_KEY: FetchAttributeKey = 'url';

/** The response status code. */
const HTTP_STATUS_CODE_KEY: FetchAttributeKey = 'http.status_code';

/** Bytes transferred, where the runtime could observe them. */
const TRANSFER_SIZE_KEY: FetchAttributeKey = 'transferSize';

/** The matched server route, which labels a server span better than its name. */
const HTTP_ROUTE_KEY: HttpServerAttributeKey = 'http.route';

/** The parameterized statement text. Literals are already replaced. */
const DB_STATEMENT_KEY: DbQueryAttributeKey = 'db.statement';

/** How many rows the statement touched. Row *contents* are never captured. */
const DB_ROW_COUNT_KEY: DbQueryAttributeKey = 'db.rowCount';

/**
 * The lineage keys, which the telemetry package declares as a plain
 * `readonly string[]` — so, unlike the catalogs above, its type carries no
 * literals to pin these against.
 */
const LINEAGE_AMBIGUOUS_KEY = 'lineageAmbiguous';
const LINEAGE_CANDIDATES_KEY = 'lineageCandidates';

/* ---------------------------------------------------------------------------
 * Geometry and layout constants
 * ------------------------------------------------------------------------- */

/**
 * The time scale's pixel range is a *percentage* interval rather than a measured
 * width, which is what makes every bar correct without measuring anything: the
 * numbers `../utils/scale` returns are consumed as percentages of the track, the
 * track takes its width from the row's grid template, and the chart is right on
 * the first paint and after every resize with no observer involved.
 */
const PERCENT_RANGE = 100;

/** How many axis ticks to aim for; `generateAxisTicks` rounds to a nice step. */
const AXIS_TICK_TARGET = 6;

/**
 * The minimum spacing between ticks, expressed in the same percentage units as
 * {@link PERCENT_RANGE}. The default the scale applies is a pixel figure, which
 * in a hundred-unit range would cap the axis at two ticks.
 */
const AXIS_TICK_MIN_SPACING = PERCENT_RANGE / AXIS_TICK_TARGET;

/** The axis strip's height, in the same unitless SVG geometry as the row rhythm. */
const AXIS_HEIGHT = DEFAULT_ROW_HEIGHT;

/** The length of a tick mark below the axis line. */
const AXIS_TICK_LENGTH = DEFAULT_ROW_GUTTER * 2;

/** The baseline the tick labels sit on, inside {@link AXIS_HEIGHT}. */
const AXIS_LABEL_BASELINE = AXIS_HEIGHT - DEFAULT_ROW_GUTTER;

/**
 * How deep the nesting may go before a subtree is reported as truncated.
 *
 * A correlated interaction is a handful of levels deep; a much deeper one is
 * either pathological or a cycle in the parent links, and neither should be
 * rendered as an unbounded recursion. A cut is always *reported* on the row that
 * was cut, never silently dropped.
 */
const MAX_ROW_DEPTH = 24;

/** How many parent hops to follow when looking for an included ancestor. */
const MAX_ANCESTOR_HOPS = 64;

/** How much of a redacted URL or statement a row shows before it is elided. */
const LABEL_PREVIEW_LENGTH = 120;

/** How much of a statement the tooltip shows. */
const TOOLTIP_PREVIEW_LENGTH = 400;

/* ---------------------------------------------------------------------------
 * The kinds this view draws
 * ------------------------------------------------------------------------- */

/**
 * The record kinds a waterfall draws: the two browser-side request kinds, the
 * server request, the database statement and the outgoing server-side call.
 *
 * Declared here rather than imported, because the telemetry package's
 * `WATERFALL_KINDS` is a runtime value and this file imports that package for
 * types only. It is deliberately typed as a set of {@link TelemetryKind} and
 * populated with literals: a kind renamed or removed upstream becomes a compile
 * error here, which is the opposite of what a `string[]` would do — silently
 * match nothing and leave an empty waterfall with no explanation.
 */
const WATERFALL_KINDS: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>([
  'fetch',
  'xhr',
  'http.server',
  'db.query',
  'http.client',
]);

/**
 * The kinds whose label is a URL or a route rather than a statement. Used only
 * to choose which field labels a row; membership of {@link WATERFALL_KINDS} is
 * what decides whether a record is drawn at all.
 */
const REQUEST_LIKE_KINDS: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>([
  'fetch',
  'xhr',
  'http.server',
  'http.client',
]);

/**
 * The kinds for which a transferred-byte figure is meaningful, so that its
 * absence can be reported as unavailable rather than passed over. A server-side
 * span has no resource timing behind it, so the figure is not expected there and
 * is not claimed to be missing either (AAP 0.6.6).
 */
const TRANSFER_BEARING_KINDS: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>(['fetch', 'xhr']);

/**
 * Narrow the kinds this render will include to the intersection of what the view
 * draws and what the node's own query asked for.
 *
 * The intersection is never widened: a specification that filtered to kinds this
 * view cannot draw yields an empty set, and an empty set yields the empty state
 * — which is the honest outcome, not a silently broadened query.
 */
function resolveIncludedKinds(
  filterKinds: readonly TelemetryKind[] | undefined,
): ReadonlySet<TelemetryKind> {
  if (filterKinds === undefined) {
    return WATERFALL_KINDS;
  }
  const narrowed = new Set<TelemetryKind>();
  for (const kind of filterKinds) {
    if (WATERFALL_KINDS.has(kind)) {
      narrowed.add(kind);
    }
  }
  return narrowed;
}

/* ---------------------------------------------------------------------------
 * The render-local view model
 *
 * This is a VIEW MODEL, not a schema: it exists for the duration of one render,
 * nothing outside this file constructs or consumes it, and it is not a second
 * definition of any wire or storage shape. Every cross-process shape has exactly
 * one definition in `@debuggen/telemetry`, `@debuggen/panel-schema` or
 * `@debuggen/shared` (AAP 0.2.3), and the fields below are *derived* from those:
 * the names mirror `TimelineRow` so that the offset convention is the same one
 * the correlated timeline uses.
 * ------------------------------------------------------------------------- */

/**
 * One drawn row: a call, its measured place in the window, and the calls that
 * ran inside it.
 *
 * Every member is required and nullable rather than optional, which under
 * `exactOptionalPropertyTypes` keeps the builders free of conditional spreads
 * and keeps every reader honest about absence.
 */
interface WaterfallRow {
  /** React key and the coordinate reported to the host on selection. */
  readonly eventId: string;
  /** The span this row is, when the payload carries one. */
  readonly spanId: string | undefined;
  /** The span this row was nested under, for the details drawer's parent chain. */
  readonly parentSpanId: string | undefined;
  /** The interaction this row belongs to. */
  readonly traceId: string | undefined;
  /** The record's own name, used as the label when nothing better exists. */
  readonly name: string;
  readonly kind: TelemetryKind;
  readonly tier: TelemetryTier;
  readonly status: TelemetryStatus;
  /** The request method, when the record reported one. */
  readonly method: string | undefined;
  /** The redacted URL, rendered exactly as it arrived. */
  readonly url: string | undefined;
  /** The matched server route, which labels a server request best. */
  readonly route: string | undefined;
  /** The response status code, when the record reported one. */
  readonly statusCode: number | undefined;
  /** The parameterized statement, rendered exactly as it arrived. */
  readonly statement: string | undefined;
  /** How many rows the statement touched. Never row contents. */
  readonly rowCount: number | undefined;
  /** Bytes transferred, where the runtime observed them. */
  readonly transferredBytes: number | undefined;
  /** Whether a transferred-byte figure is expected for this kind of call. */
  readonly expectsTransfer: boolean;
  /** How many grouped occurrences this row stands for, for a grouped payload. */
  readonly occurrenceCount: number | undefined;
  /** Epoch milliseconds, kept so tooltips can state an offset from the window. */
  readonly startTime: number;
  /** Milliseconds from the window's start to this call's start. */
  readonly offsetMs: number;
  /** The call's measured duration, in milliseconds. */
  readonly durationMs: number;
  /** Where the call came from in the project, when it resolved to a location. */
  readonly source: SourceLocation | undefined;
  /** Set when the parent link was inferred from an ambiguous async continuation. */
  readonly lineageAmbiguous: boolean;
  /** The other candidate parents of an ambiguous continuation. */
  readonly lineageCandidates: readonly string[];
  /** Set when this row's own children were cut by the depth bound. */
  readonly childrenTruncated: boolean;
  /** The calls that ran inside this one. */
  readonly children: readonly WaterfallRow[];
}

/** The whole drawable model of one page of one source. */
interface WaterfallModel {
  /** The top-level rows, in start-time order. */
  readonly rows: readonly WaterfallRow[];
  /** The window's start, in epoch milliseconds; every offset is relative to it. */
  readonly viewStart: number;
  /** The window's end, in epoch milliseconds. */
  readonly viewEnd: number;
  /** The window's extent, in milliseconds. */
  readonly windowMs: number;
  /** How many rows the model holds in total, children included. */
  readonly rowCount: number;
  /** How many top-level rows the model holds. */
  readonly topLevelCount: number;
  /** Set when a subtree was cut, either by the depth bound or by the payload. */
  readonly truncated: boolean;
}

const EMPTY_ROWS: readonly WaterfallRow[] = [];
const EMPTY_STRINGS: readonly string[] = [];
const EMPTY_EVENTS: readonly TelemetryEvent[] = [];
const EMPTY_GROUPS: readonly RequestGroup[] = [];

const EMPTY_MODEL: WaterfallModel = {
  rows: EMPTY_ROWS,
  viewStart: 0,
  viewEnd: 0,
  windowMs: 0,
  rowCount: 0,
  topLevelCount: 0,
  truncated: false,
};

/* ---------------------------------------------------------------------------
 * Reading a record's attribute bag
 *
 * An attribute bag is `Record<string, unknown>` by schema, because a producer
 * may report anything a key allows and the service redacts values without
 * narrowing their types. Every read below therefore validates before it returns,
 * and answers `undefined` rather than coercing: a status code that arrived as a
 * malformed string must render as absent, not as `NaN`.
 * ------------------------------------------------------------------------- */

type AttributeBag = Readonly<Record<string, unknown>>;

/** A non-empty string attribute, or `undefined`. */
function stringAttribute(attributes: AttributeBag, key: string): string | undefined {
  const value = attributes[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : value;
}

/**
 * A finite numeric attribute, or `undefined`.
 *
 * Numeric strings are accepted because a status code and a byte count both
 * legitimately arrive as text from some producers; anything else is absent.
 */
function numberAttribute(attributes: AttributeBag, key: string): number | undefined {
  const value = attributes[key];
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A boolean attribute, treating the string `"true"` as set. */
function booleanAttribute(attributes: AttributeBag, key: string): boolean {
  const value = attributes[key];
  return value === true || value === 'true';
}

/** A list-of-strings attribute, with non-strings and blanks dropped. */
function stringListAttribute(attributes: AttributeBag, key: string): readonly string[] {
  const value = attributes[key];
  if (!Array.isArray(value)) {
    return EMPTY_STRINGS;
  }
  const entries: string[] = [];
  for (const candidate of value as readonly unknown[]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      entries.push(candidate);
    }
  }
  return entries.length === 0 ? EMPTY_STRINGS : entries;
}

/* ---------------------------------------------------------------------------
 * Numeric helpers
 * ------------------------------------------------------------------------- */

/** The value when it is finite, and the fallback when it is not. */
function asFiniteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** A duration that can be drawn: never negative, never non-finite. */
function drawableDuration(value: number): number {
  return Number.isFinite(value) ? clampNonNegative(value) : 0;
}

/**
 * The offset of a call from the window's start.
 *
 * Rounded through the shared millisecond policy and clamped at zero, which is
 * the same treatment `formatOffset` applies — so a bar's position and the
 * offset a tooltip prints can never disagree by a floating-point artefact.
 */
function offsetFrom(viewStart: number, startTime: number): number {
  return clampNonNegative(roundMs(asFiniteNumber(startTime, viewStart) - viewStart));
}

/* ---------------------------------------------------------------------------
 * Ordering
 *
 * A waterfall is time-ordered by definition, so sibling rows are drawn in start
 * order regardless of the `sort` the query carried: the query's ordering decides
 * *which* records the page holds — that selection belongs to the service and is
 * never recomputed here — while the drawing order is intrinsic to the view. The
 * tie-break is the record id, which is stable and always distinct, so two calls
 * that share a start time never swap between renders.
 * ------------------------------------------------------------------------- */

function compareByStartThenId(
  leftStart: number,
  leftId: string,
  rightStart: number,
  rightId: string,
): number {
  const byStart = asFiniteNumber(leftStart, 0) - asFiniteNumber(rightStart, 0);
  if (byStart !== 0) {
    return byStart;
  }
  if (leftId === rightId) {
    return 0;
  }
  return leftId < rightId ? -1 : 1;
}

function compareEvents(left: TelemetryEvent, right: TelemetryEvent): number {
  return compareByStartThenId(left.startTime, left.id, right.startTime, right.id);
}

function compareRows(left: WaterfallRow, right: WaterfallRow): number {
  return compareByStartThenId(left.startTime, left.eventId, right.startTime, right.eventId);
}

/* ---------------------------------------------------------------------------
 * Building the model from a flat page of records (`spans` / `events`)
 * ------------------------------------------------------------------------- */

/** Mutable counters threaded through a build, so a cut is always reported. */
interface BuildState {
  rowCount: number;
  truncated: boolean;
}

/**
 * The nearest ancestor of `event` that this view is actually drawing.
 *
 * Walks the `parentSpanId` chain through *every* record in the page, not only
 * the drawn ones, which is what keeps a database statement nested under the
 * server request that issued it when the function span between them is a kind
 * this view does not draw. Bounded by {@link MAX_ANCESTOR_HOPS} and guarded
 * against a cycle in the links, both of which answer `undefined` — the row then
 * sits at the top level, which is honest about an unresolved ancestry rather
 * than inventing one.
 */
function nearestDrawnAncestor(
  event: TelemetryEvent,
  bySpanId: ReadonlyMap<string, TelemetryEvent>,
  drawnBySpanId: ReadonlyMap<string, TelemetryEvent>,
): TelemetryEvent | undefined {
  const seen = new Set<string>([event.spanId]);
  let parentSpanId = event.parentSpanId;
  for (let hop = 0; parentSpanId !== undefined && hop < MAX_ANCESTOR_HOPS; hop += 1) {
    if (seen.has(parentSpanId)) {
      return undefined;
    }
    seen.add(parentSpanId);
    const drawn = drawnBySpanId.get(parentSpanId);
    if (drawn !== undefined && drawn.id !== event.id) {
      return drawn;
    }
    const linked = bySpanId.get(parentSpanId);
    if (linked === undefined) {
      return undefined;
    }
    parentSpanId = linked.parentSpanId;
  }
  return undefined;
}

/** One row from one record, with its children already materialised. */
function rowFromEvent(
  event: TelemetryEvent,
  viewStart: number,
  children: readonly WaterfallRow[],
  childrenTruncated: boolean,
): WaterfallRow {
  const attributes: AttributeBag = event.attributes;
  const isQuery = event.kind === 'db.query';
  return {
    eventId: event.id,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    traceId: event.traceId,
    name: event.name,
    kind: event.kind,
    tier: event.tier,
    status: event.status,
    method: stringAttribute(attributes, HTTP_METHOD_KEY),
    url: stringAttribute(attributes, URL_KEY),
    route: stringAttribute(attributes, HTTP_ROUTE_KEY),
    statusCode: numberAttribute(attributes, HTTP_STATUS_CODE_KEY),
    statement: isQuery ? stringAttribute(attributes, DB_STATEMENT_KEY) : undefined,
    rowCount: isQuery ? numberAttribute(attributes, DB_ROW_COUNT_KEY) : undefined,
    transferredBytes: numberAttribute(attributes, TRANSFER_SIZE_KEY),
    expectsTransfer: TRANSFER_BEARING_KINDS.has(event.kind),
    occurrenceCount: undefined,
    startTime: asFiniteNumber(event.startTime, viewStart),
    offsetMs: offsetFrom(viewStart, event.startTime),
    durationMs: drawableDuration(event.duration),
    source: event.source,
    lineageAmbiguous: booleanAttribute(attributes, LINEAGE_AMBIGUOUS_KEY),
    lineageCandidates: stringListAttribute(attributes, LINEAGE_CANDIDATES_KEY),
    childrenTruncated,
    children,
  };
}

/** Materialise one record and, depth permitting, everything nested under it. */
function materialiseEvent(
  event: TelemetryEvent,
  depth: number,
  childrenByParentId: ReadonlyMap<string, readonly TelemetryEvent[]>,
  viewStart: number,
  state: BuildState,
  visited: Set<string>,
): WaterfallRow {
  visited.add(event.id);
  state.rowCount += 1;
  const candidates = childrenByParentId.get(event.id) ?? EMPTY_EVENTS;
  const pending = candidates.filter((child) => !visited.has(child.id));
  if (pending.length === 0) {
    return rowFromEvent(event, viewStart, EMPTY_ROWS, false);
  }
  if (depth + 1 >= MAX_ROW_DEPTH) {
    state.truncated = true;
    return rowFromEvent(event, viewStart, EMPTY_ROWS, true);
  }
  const children = pending.map((child) =>
    materialiseEvent(child, depth + 1, childrenByParentId, viewStart, state, visited),
  );
  return rowFromEvent(event, viewStart, children, false);
}

/**
 * Build the model from a flat page of records.
 *
 * The window starts at the earliest *drawn* record, which is the only origin a
 * flat page can offer and the one that makes the leftmost bar sit at zero.
 */
function buildFromEvents(
  events: readonly TelemetryEvent[],
  kinds: ReadonlySet<TelemetryKind>,
): WaterfallModel {
  const drawn = events.filter((event) => kinds.has(event.kind));
  if (drawn.length === 0) {
    return EMPTY_MODEL;
  }

  let viewStart = Number.POSITIVE_INFINITY;
  let viewEnd = Number.NEGATIVE_INFINITY;
  for (const event of drawn) {
    const start = asFiniteNumber(event.startTime, 0);
    const end = start + drawableDuration(event.duration);
    viewStart = Math.min(viewStart, start);
    viewEnd = Math.max(viewEnd, end);
  }
  if (!Number.isFinite(viewStart)) {
    return EMPTY_MODEL;
  }

  const bySpanId = new Map<string, TelemetryEvent>();
  for (const event of events) {
    if (!bySpanId.has(event.spanId)) {
      bySpanId.set(event.spanId, event);
    }
  }
  const drawnBySpanId = new Map<string, TelemetryEvent>();
  for (const event of drawn) {
    if (!drawnBySpanId.has(event.spanId)) {
      drawnBySpanId.set(event.spanId, event);
    }
  }

  const childrenByParentId = new Map<string, TelemetryEvent[]>();
  const roots: TelemetryEvent[] = [];
  for (const event of drawn) {
    const ancestor = nearestDrawnAncestor(event, bySpanId, drawnBySpanId);
    if (ancestor === undefined) {
      roots.push(event);
      continue;
    }
    const siblings = childrenByParentId.get(ancestor.id);
    if (siblings === undefined) {
      childrenByParentId.set(ancestor.id, [event]);
    } else {
      siblings.push(event);
    }
  }
  roots.sort(compareEvents);
  for (const siblings of childrenByParentId.values()) {
    siblings.sort(compareEvents);
  }

  const state: BuildState = { rowCount: 0, truncated: false };
  const visited = new Set<string>();
  const rows = roots.map((root) =>
    materialiseEvent(root, 0, childrenByParentId, viewStart, state, visited),
  );

  return {
    rows,
    viewStart,
    viewEnd: Math.max(viewEnd, viewStart),
    windowMs: clampNonNegative(roundMs(Math.max(viewEnd, viewStart) - viewStart)),
    rowCount: state.rowCount,
    topLevelCount: rows.length,
    truncated: state.truncated,
  };
}

/* ---------------------------------------------------------------------------
 * Building the model from the correlated tree (`trace`)
 *
 * Not a source the catalog accepts for this node type, so a validated
 * specification cannot reach this path. It exists because a host that hands a
 * tree over should see a correct waterfall rather than an empty box, and because
 * the tree carries two things a flat page does not: the interaction's own start,
 * which is the origin every offset in the AAP's example is measured from, and a
 * resolved lineage record per node.
 * ------------------------------------------------------------------------- */

/** One row from one tree node, with its children already materialised. */
function rowFromTraceNode(
  node: TraceNode,
  viewStart: number,
  children: readonly WaterfallRow[],
  childrenTruncated: boolean,
): WaterfallRow {
  const base = rowFromEvent(node.event, viewStart, children, childrenTruncated);
  const lineage = node.lineage;
  if (lineage === undefined) {
    return base;
  }
  return {
    ...base,
    lineageAmbiguous: lineage.ambiguous,
    lineageCandidates: lineage.candidateSpanIds,
  };
}

/**
 * Collect the drawable rows of a level of the tree.
 *
 * A node of a kind this view does not draw is *collapsed through*: its drawable
 * descendants are lifted to the level it occupied, at the same depth, so nothing
 * disappears because an intermediate call was of another kind.
 */
function collectTraceRows(
  nodes: readonly TraceNode[],
  depth: number,
  kinds: ReadonlySet<TelemetryKind>,
  viewStart: number,
  state: BuildState,
): readonly WaterfallRow[] {
  const rows: WaterfallRow[] = [];
  for (const node of nodes) {
    if (!kinds.has(node.event.kind)) {
      rows.push(...collectTraceRows(node.children, depth, kinds, viewStart, state));
      continue;
    }
    state.rowCount += 1;
    if (node.children.length === 0) {
      rows.push(rowFromTraceNode(node, viewStart, EMPTY_ROWS, false));
      continue;
    }
    if (depth + 1 >= MAX_ROW_DEPTH) {
      state.truncated = true;
      rows.push(rowFromTraceNode(node, viewStart, EMPTY_ROWS, true));
      continue;
    }
    const children = collectTraceRows(node.children, depth + 1, kinds, viewStart, state);
    rows.push(rowFromTraceNode(node, viewStart, children, false));
  }
  rows.sort(compareRows);
  return rows;
}

function buildFromTrace(tree: TraceTree, kinds: ReadonlySet<TelemetryKind>): WaterfallModel {
  const viewStart = asFiniteNumber(tree.startTime, 0);
  const viewEnd = Math.max(asFiniteNumber(tree.endTime, viewStart), viewStart);
  const state: BuildState = { rowCount: 0, truncated: tree.truncated };
  const rows = collectTraceRows(tree.roots, 0, kinds, viewStart, state);
  if (rows.length === 0) {
    return EMPTY_MODEL;
  }
  return {
    rows,
    viewStart,
    viewEnd,
    windowMs: clampNonNegative(roundMs(viewEnd - viewStart)),
    rowCount: state.rowCount,
    topLevelCount: rows.length,
    truncated: state.truncated,
  };
}

/* ---------------------------------------------------------------------------
 * Building the model from grouped network calls (`requests`)
 *
 * The grouped result keeps each occurrence's own start and duration, so the same
 * bars can be drawn for calls the service grouped for duplicate detection. What
 * is NOT done here: any grouping, matching or comparison of requests. That
 * happened in the service, on the pre-redaction request key, and a second
 * attempt over the redacted URLs on this side would answer differently and be
 * wrong (AAP 0.5.2).
 * ------------------------------------------------------------------------- */

/** One row from one occurrence, labelled from the group it belongs to. */
function rowFromOccurrence(
  group: RequestGroup,
  occurrence: RequestOccurrence,
  viewStart: number,
): WaterfallRow {
  return {
    eventId: occurrence.eventId,
    spanId: occurrence.spanId,
    parentSpanId: occurrence.parentSpanId,
    traceId: occurrence.traceId,
    name: group.path,
    kind: occurrence.kind,
    tier: occurrence.tier,
    status: occurrence.status,
    method: group.method,
    url: group.url,
    route: undefined,
    statusCode: occurrence.statusCode,
    statement: undefined,
    rowCount: undefined,
    transferredBytes: occurrence.transferredBytes,
    expectsTransfer: TRANSFER_BEARING_KINDS.has(occurrence.kind),
    occurrenceCount: undefined,
    startTime: asFiniteNumber(occurrence.startTime, viewStart),
    offsetMs: offsetFrom(viewStart, occurrence.startTime),
    durationMs: drawableDuration(occurrence.durationMs),
    source: occurrence.source,
    lineageAmbiguous: false,
    lineageCandidates: EMPTY_STRINGS,
    childrenTruncated: false,
    children: EMPTY_ROWS,
  };
}

/**
 * The row for a group that holds more than one occurrence.
 *
 * Its bar spans from the first occurrence's start to the last one's end, and its
 * duration cell prints that same extent — bar length and printed duration are
 * the same measured quantity, never two different ones — while the per-call
 * timings stay exact on the occurrence rows nested beneath it.
 */
function rowFromGroup(
  group: RequestGroup,
  occurrences: readonly RequestOccurrence[],
  viewStart: number,
  children: readonly WaterfallRow[],
): WaterfallRow {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let worstStatus: TelemetryStatus = 'unset';
  for (const occurrence of occurrences) {
    const start = asFiniteNumber(occurrence.startTime, viewStart);
    first = Math.min(first, start);
    last = Math.max(last, start + drawableDuration(occurrence.durationMs));
    if (occurrence.status === 'error') {
      worstStatus = 'error';
    } else if (worstStatus === 'unset' && occurrence.status === 'ok') {
      worstStatus = 'ok';
    }
  }
  const start = Number.isFinite(first) ? first : viewStart;
  const end = Number.isFinite(last) ? Math.max(last, start) : start;
  const [firstOccurrence] = occurrences;
  return {
    eventId: firstOccurrence === undefined ? group.id : firstOccurrence.eventId,
    spanId: firstOccurrence?.spanId,
    parentSpanId: undefined,
    traceId: firstOccurrence?.traceId,
    name: group.path,
    kind: firstOccurrence === undefined ? 'fetch' : firstOccurrence.kind,
    tier: firstOccurrence === undefined ? 'browser' : firstOccurrence.tier,
    status: worstStatus,
    method: group.method,
    url: group.url,
    route: undefined,
    statusCode: undefined,
    statement: undefined,
    rowCount: undefined,
    transferredBytes: group.transferredBytes,
    expectsTransfer: occurrences.some((occurrence) => TRANSFER_BEARING_KINDS.has(occurrence.kind)),
    occurrenceCount: occurrences.length,
    startTime: start,
    offsetMs: offsetFrom(viewStart, start),
    durationMs: clampNonNegative(roundMs(end - start)),
    source: firstOccurrence?.source,
    lineageAmbiguous: false,
    lineageCandidates: EMPTY_STRINGS,
    childrenTruncated: group.occurrencesTruncated,
    children,
  };
}

function buildFromRequests(
  groups: readonly RequestGroup[],
  kinds: ReadonlySet<TelemetryKind>,
): WaterfallModel {
  const drawable: {
    readonly group: RequestGroup;
    readonly occurrences: readonly RequestOccurrence[];
  }[] = [];
  let viewStart = Number.POSITIVE_INFINITY;
  let viewEnd = Number.NEGATIVE_INFINITY;
  for (const group of groups) {
    const occurrences = group.occurrences.filter((occurrence) => kinds.has(occurrence.kind));
    if (occurrences.length === 0) {
      continue;
    }
    drawable.push({ group, occurrences });
    for (const occurrence of occurrences) {
      const start = asFiniteNumber(occurrence.startTime, 0);
      viewStart = Math.min(viewStart, start);
      viewEnd = Math.max(viewEnd, start + drawableDuration(occurrence.durationMs));
    }
  }
  if (drawable.length === 0 || !Number.isFinite(viewStart)) {
    return EMPTY_MODEL;
  }

  const state: BuildState = { rowCount: 0, truncated: false };
  const rows: WaterfallRow[] = [];
  for (const { group, occurrences } of drawable) {
    const ordered = [...occurrences].sort((left, right) =>
      compareByStartThenId(left.startTime, left.eventId, right.startTime, right.eventId),
    );
    const [single] = ordered;
    if (ordered.length === 1 && single !== undefined) {
      state.rowCount += 1;
      rows.push(rowFromOccurrence(group, single, viewStart));
      continue;
    }
    const children = ordered.map((occurrence) => rowFromOccurrence(group, occurrence, viewStart));
    state.rowCount += children.length + 1;
    if (group.occurrencesTruncated) {
      state.truncated = true;
    }
    rows.push(rowFromGroup(group, ordered, viewStart, children));
  }
  rows.sort(compareRows);

  return {
    rows,
    viewStart,
    viewEnd: Math.max(viewEnd, viewStart),
    windowMs: clampNonNegative(roundMs(Math.max(viewEnd, viewStart) - viewStart)),
    rowCount: state.rowCount,
    topLevelCount: rows.length,
    truncated: state.truncated,
  };
}

/* ---------------------------------------------------------------------------
 * Resolving the node's query
 *
 * `useQuery` reports a status, a payload and the paging counters — it does not
 * echo the source back, so the payload's shape is decided by the discriminant
 * this component already holds: `node.query.source`. Narrowing happens *before*
 * the hook, by building a query whose static type carries its own source, which
 * is what lets each payload be read as the one shape it is with no assertion and
 * no inspection of the data. Duck-typing the payload is what this avoids: two
 * sources can answer with structurally similar data, and a branch that sniffed
 * it would draw the wrong thing without ever failing.
 *
 * Three hooks are called unconditionally, and at most one of them is handed a
 * query: the other two receive `undefined`, which `useQuery` treats as "nothing
 * to resolve" — no request is made and no provider is touched.
 * ------------------------------------------------------------------------- */

type SpanListSource = 'spans' | 'events';
type SpanListQuery = DataQuery & { source: SpanListSource };
type RequestsQuery = DataQuery & { source: 'requests' };
type TraceQuery = DataQuery & { source: 'trace' };

/** The flat-record query, at the offset this render is paged to. */
function narrowSpanListQuery(query: DataQuery, offset: number): SpanListQuery | undefined {
  const source = query.source;
  if (source !== 'spans' && source !== 'events') {
    return undefined;
  }
  return { ...query, source, offset };
}

/** The grouped-network query, at the offset this render is paged to. */
function narrowRequestsQuery(query: DataQuery, offset: number): RequestsQuery | undefined {
  const source = query.source;
  return source === 'requests' ? { ...query, source, offset } : undefined;
}

/**
 * The correlated-tree query. Not paged: the tree is a scalar result, so it
 * carries no total and no next offset, and it reports its own truncation
 * instead.
 */
function narrowTraceQuery(query: DataQuery): TraceQuery | undefined {
  const source = query.source;
  return source === 'trace' ? { ...query, source } : undefined;
}

/**
 * A stable identity for everything about the query *except* its offset.
 *
 * Paging changes the offset deliberately, so the offset must not be part of the
 * identity that decides whether the accumulated pages still belong to the query
 * on screen. Written field by field rather than with a generic serializer so
 * that a new query field cannot silently join the identity — or silently stay
 * out of it — when the schema grows.
 */
function queryIdentity(query: DataQuery): string {
  const filter = query.filter;
  return JSON.stringify([
    query.source,
    query.sort ?? null,
    query.limit ?? null,
    filter === undefined
      ? null
      : [
          filter.traceId ?? null,
          filter.kinds ?? null,
          filter.component ?? null,
          filter.tier ?? null,
          filter.minDuration ?? null,
        ],
  ]);
}

/** The query as the error state reports it, so a failure names what failed. */
function describeQuery(query: DataQuery, offset: number): string {
  return JSON.stringify({ ...query, offset });
}

/* ---------------------------------------------------------------------------
 * Paging
 *
 * The provider resolves ONE page. "Load more" therefore keeps the pages already
 * resolved in state and advances the offset to the `nextOffset` the response
 * reported — never to a figure computed from the length of what arrived, which
 * would drift the moment the service clamped a limit.
 *
 * The accumulated pages are held beside the identity of the query they came
 * from, and a render whose identity no longer matches simply derives the initial
 * page instead of using them. That is deliberate: resetting the state would mean
 * either setting state during a render or setting it from an effect, and both are
 * errors under this repository's React rules — while a derivation is correct on
 * the very first render after the change, with no intermediate frame showing
 * another query's rows.
 * ------------------------------------------------------------------------- */

type LoadedPages =
  | { readonly kind: 'none' }
  | { readonly kind: 'spans'; readonly items: readonly TelemetryEvent[] }
  | { readonly kind: 'requests'; readonly items: readonly RequestGroup[] };

const NO_PAGES: LoadedPages = { kind: 'none' };

interface PagingState {
  /** The {@link queryIdentity} the accumulated pages belong to. */
  readonly identity: string;
  /** The offset the current request is made at. */
  readonly offset: number;
  /** Every page resolved before the current one. */
  readonly loaded: LoadedPages;
}

function initialPaging(identity: string, offset: number | undefined): PagingState {
  return { identity, offset: offset ?? DATA_QUERY_DEFAULT_OFFSET, loaded: NO_PAGES };
}

/* ---------------------------------------------------------------------------
 * Presentation
 * ------------------------------------------------------------------------- */

/** How many decimals a percentage coordinate keeps. */
const PERCENT_DECIMALS = 3;

/** A scale coordinate as a CSS percentage of the track. */
function percent(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(PERCENT_DECIMALS)}%`;
}

/** An inline style that may carry custom properties alongside declarations. */
type CustomPropertyStyle = CSSProperties & Record<`--${string}`, string>;

/**
 * The label slot's two declarations: a zero flex basis and a zero minimum, so
 * the label claims only the width the row's chips leave it.
 *
 * Everything else in the label cell is a chip with no shorter form — a request
 * method, a response status, a row count, the source chip — while the label is
 * the item built to give way: `.dg-waterfall__label` and `.dg-truncate` end it
 * in an ellipsis and its tooltip carries the value in full. Flexbox shares a
 * deficit in proportion to content width, though, so with the chips and the
 * label all sized from their content the longest item takes the largest share
 * of the *space* and the smallest share of the *loss*: a statement several
 * hundred pixels wide keeps a readable prefix while the source chip beside it —
 * the one item the stylesheet allows to shrink to nothing, through the
 * `min-inline-size: 0` on `.dg-source-link` that suits it to a table cell — is
 * squeezed to a couple of pixels. That is a control the developer can no longer
 * read, aim at, or recognise when the keyboard reaches it.
 *
 * A zero basis inverts the order: the chips are laid out at their content width
 * and the label takes what is left. The zero minimum is what makes that true
 * rather than merely stated — a flex item's automatic minimum is its
 * content-based minimum, and a single line of `white-space: nowrap` text has
 * the same minimum as maximum, so without it the slot cannot go below the whole
 * statement, the cell overflows instead of the label ending in an ellipsis, and
 * the shrinking lands back on the source chip. Both declarations are structural
 * and carry no design value: `0` is a permitted literal and the two flex factors
 * are unitless. Together they are the counterpart of the `flex: none` the
 * stylesheet puts on `.dg-waterfall__status`, the one row chip it knew about.
 *
 * The order this sets is deliberate where the row genuinely holds more than the
 * panel is wide: a narrow panel leaves a long statement only a few characters,
 * because the alternative is to spend those characters on the chips and hand
 * back an unreadable count and an unaimable control. A truncated label is the
 * conventional degradation and loses nothing — the value is in the tooltip, in
 * the row's name, and one click away at its source — while a two-pixel button
 * is a control that has stopped working. A row too full to draw on one line is
 * a shortage of width, not a shortage this component can resolve by choosing
 * differently.
 */
const LABEL_SLOT_STYLE: CSSProperties = { flex: '1 1 0', minInlineSize: 0 };

/**
 * The tone of a response status code: a client or server failure reads as a
 * failure, a redirect as a caution, a success as a success, and anything else —
 * including an informational code and an absent one — stays neutral. Every tone
 * resolves to a token inside `Badge`; no colour is chosen here.
 */
function statusCodeTone(statusCode: number): BadgeTone {
  if (statusCode >= 400) {
    return 'danger';
  }
  if (statusCode >= 300) {
    return 'warning';
  }
  if (statusCode >= 200) {
    return 'success';
  }
  return 'neutral';
}

/**
 * The full text a row is labelled with, exactly as it arrived.
 *
 * A statement wins for a database call, then — for a call that is actually a
 * request — the redacted URL and then the matched route, and otherwise the
 * record's own name. The kind check is what keeps a stray `url` attribute on a
 * non-request record from hijacking its label. Nothing is assembled, decoded or
 * rebuilt: a URL whose query values are already replaced per key is the correct
 * display form (AAP 0.5.2).
 */
function rowLabel(row: WaterfallRow): string {
  if (row.statement !== undefined) {
    return row.statement;
  }
  if (REQUEST_LIKE_KINDS.has(row.kind)) {
    return row.url ?? row.route ?? row.name;
  }
  return row.name;
}

/**
 * Everything about a row that does not fit on it, as one line of text.
 *
 * Reached by pointer as a tooltip and by assistive technology as the label's
 * description. A byte figure that the runtime could not observe for a call that
 * would normally carry one is stated as unavailable rather than omitted or
 * shown as a zero.
 */
function rowDescription(row: WaterfallRow): string {
  const parts: string[] = [oneLinePreview(rowLabel(row), TOOLTIP_PREVIEW_LENGTH)];
  parts.push(`${formatKindLabel(row.kind)} · ${formatTierLabel(row.tier)}`);
  parts.push(
    `starts ${formatDuration(row.offsetMs)} into the window · took ${formatDuration(row.durationMs)}`,
  );
  if (row.statusCode !== undefined) {
    parts.push(`status ${String(row.statusCode)}`);
  } else if (row.status !== 'unset') {
    parts.push(`status ${formatStatusLabel(row.status)}`);
  }
  if (row.rowCount !== undefined) {
    parts.push(`${formatCount(row.rowCount)} rows touched`);
  }
  if (row.transferredBytes !== undefined) {
    parts.push(`transferred ${formatBytes(row.transferredBytes)}`);
  } else if (row.expectsTransfer) {
    parts.push(`transferred ${NOT_AVAILABLE_LABEL}`);
  }
  if (row.occurrenceCount !== undefined) {
    parts.push(`${formatCount(row.occurrenceCount)} calls in this group`);
  }
  if (row.lineageAmbiguous) {
    const candidates =
      row.lineageCandidates.length === 0
        ? ''
        : ` · other candidates: ${row.lineageCandidates.join(', ')}`;
    parts.push(`parent inferred from an async continuation${candidates}`);
  }
  if (row.childrenTruncated) {
    parts.push('nested calls below this row were not drawn');
  }
  return parts.join(' · ');
}

/** The selector for the controls nested inside a row, which own their own clicks. */
const NESTED_CONTROL_SELECTOR = 'button, a[href], input, select, textarea';

/**
 * Whether an event came from a control nested inside a row.
 *
 * A row is activatable and holds controls of its own — the disclosure button and
 * the source chip — so row activation has to distinguish the two. Asking the DOM
 * which control the event came from covers every nested control, including the
 * one the source chip renders for itself, without each of them having to
 * remember to stop propagation.
 */
function isNestedControlEvent(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(NESTED_CONTROL_SELECTOR) !== null;
}

/* ---------------------------------------------------------------------------
 * Moving between rows
 *
 * The arrow keys of the tree pattern, resolved through the DOM rather than
 * through a ref per row: the rows are already in the document in the order they
 * are read, a collapsed subtree is not in the document at all, and the row that
 * handled the key is the event's own target — so the next row to focus is a
 * query away and nothing has to be held between renders.
 * ------------------------------------------------------------------------- */

/** The rows of the tree this row belongs to, in the order they are read. */
function visibleRowsOf(row: HTMLElement): readonly HTMLElement[] {
  const tree = row.closest('[role="tree"]');
  if (tree === null) {
    return [];
  }
  return Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
}

/** Moves focus one row down (`1`) or up (`-1`), stopping at either end. */
function focusStep(row: HTMLElement, step: 1 | -1): void {
  const rows = visibleRowsOf(row);
  const index = rows.indexOf(row);
  if (index < 0) {
    return;
  }
  rows[index + step]?.focus();
}

/** Moves focus to the first (`0`) or last (`-1`) row of the tree. */
function focusEdge(row: HTMLElement, edge: 0 | -1): void {
  const rows = visibleRowsOf(row);
  const target = edge === 0 ? rows[0] : rows[rows.length - 1];
  target?.focus();
}

/**
 * Moves focus to the first row nested under this one, if the group is open.
 *
 * The group is the row's next sibling rather than its child — a fourth child of
 * the row would land in the label column — so the lookup is sideways.
 */
function focusFirstChild(row: HTMLElement): void {
  const group = row.nextElementSibling;
  if (group === null || group.getAttribute('role') !== 'group') {
    return;
  }
  group.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
}

/**
 * Moves focus to the row this one is nested under.
 *
 * A nested row's parent element is the group, and the row that owns the group is
 * the element before it.
 */
function focusParent(row: HTMLElement): void {
  const group = row.parentElement;
  if (group === null || group.getAttribute('role') !== 'group') {
    return;
  }
  const owner = group.previousElementSibling;
  if (owner instanceof HTMLElement && owner.getAttribute('role') === 'treeitem') {
    owner.focus();
  }
}

/* ---------------------------------------------------------------------------
 * The time axis
 * ------------------------------------------------------------------------- */

interface WaterfallAxisProps {
  /** The ticks, already placed in the scale's percentage range. */
  readonly ticks: readonly AxisTick[];
  /** The window's extent, in milliseconds. */
  readonly windowMs: number;
}

/**
 * The axis strip above the rows, laid out on the same three-column grid as a row
 * so its ticks line up with the bars beneath them.
 *
 * Drawn as an SVG because a tick sits at a fraction of the track and text is the
 * only thing there is to place; the percentages come from the same scale the
 * bars use, so nothing here is measured either. The graphic is a single
 * `role="img"` with a label that states the window it spans — its tick text is
 * a scale, not content to be read one label at a time — and its colours are
 * `currentColor`, inherited from the muted type role around it, so the axis
 * carries no colour of its own.
 *
 * The window's extent is printed through the same `DurationCell` at the same
 * size a row uses, rather than as plain text, so the strip's third column is
 * the same box as a row's duration column and the track between them starts and
 * ends in the same place. The stylesheet's grid ends in a `max-content` column,
 * which is per-row: what keeps the strip in register with a top-level track is
 * that both of them size that column from a duration in the same monospaced,
 * tabular type role.
 *
 * A nested row is a different case, and deliberately so: the stylesheet indents
 * the child group ("indented on the elevated surface so the nesting is visible
 * without a second grid"), which narrows the track it contains. A nested bar is
 * therefore exact within its own row's track — the reading the eye makes when
 * comparing a row with its children — rather than against this strip, and the
 * exact figures never depend on the pixels at all: every row prints its own
 * duration, and its tooltip states how far into the window it started. Putting
 * a nested track back in register with the strip would mean overriding the
 * stylesheet's indentation from here, which is not this component's to override.
 */
function WaterfallAxis(props: WaterfallAxisProps): ReactElement {
  const { ticks, windowMs } = props;
  const lastIndex = ticks.length - 1;
  return (
    <div className="dg-waterfall__row dg-waterfall__axis">
      <Text as="span" size="xs" tone="muted">
        Offset from the first call
      </Text>
      <Text as="div" size="xs" tone="muted" className="dg-waterfall__axis-strip">
        <svg
          width="100%"
          height={AXIS_HEIGHT}
          role="img"
          aria-label={`Time axis spanning ${formatDurationCompact(windowMs)} from the first call`}
          focusable="false"
        >
          <line
            x1={0}
            y1={0}
            x2="100%"
            y2={0}
            stroke="currentColor"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          {ticks.map((tick, index) => (
            <g key={`${String(tick.value)}-${String(tick.offset)}`}>
              <line
                x1={percent(tick.offset)}
                y1={0}
                x2={percent(tick.offset)}
                y2={AXIS_TICK_LENGTH}
                stroke="currentColor"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={percent(tick.offset)}
                y={AXIS_LABEL_BASELINE}
                textAnchor={index === 0 ? 'start' : index === lastIndex ? 'end' : 'middle'}
                fill="currentColor"
              >
                {tick.label}
              </text>
            </g>
          ))}
        </svg>
      </Text>
      <DurationCell ms={windowMs} severity="none" size="sm" className="dg-waterfall__duration" />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * One row, and the rows nested under it
 * ------------------------------------------------------------------------- */

interface WaterfallRowItemProps {
  readonly row: WaterfallRow;
  /** Zero-based nesting depth, reported to assistive technology as the level. */
  readonly depth: number;
  /** The shared time scale; every bar is placed in it. */
  readonly scale: TimeScale;
  /** The window's start, which every offset is measured from. */
  readonly viewStart: number;
  /** Prefix for the child group's id, unique per mounted component. */
  readonly groupIdPrefix: string;
  readonly expandedIds: ReadonlySet<string>;
  readonly selectedId: string | undefined;
  readonly onToggle: (row: WaterfallRow) => void;
  readonly onSelect: (row: WaterfallRow) => void;
}

/**
 * A row and, when it is expanded, the group of rows nested beneath it.
 *
 * The row element is the three-column grid the stylesheet defines — label,
 * track, duration — so it holds exactly three children and the child group is a
 * DOM sibling, owned by the row through `aria-owns`. A fourth child would land
 * in the label column and squeeze the nesting into a two-fifths-wide box.
 */
function WaterfallRowItem(props: WaterfallRowItemProps): ReactElement {
  const {
    row,
    depth,
    scale,
    viewStart,
    groupIdPrefix,
    expandedIds,
    selectedId,
    onToggle,
    onSelect,
  } = props;

  const hasChildren = row.children.length > 0;
  const expanded = hasChildren && expandedIds.has(row.eventId);
  const selected = selectedId === row.eventId;
  const groupId = `${groupIdPrefix}-${row.eventId}`;
  const label = rowLabel(row);
  const description = rowDescription(row);

  // Bar geometry, in the scale's percentage range: `x` is how far into the
  // window the call started, `width` its extent with the scale's minimum
  // visible width applied so a sub-millisecond call is still a bar.
  const geometry = placeOffsetSpan(row.offsetMs, row.durationMs, viewStart, scale);

  // A call too short to draw is given the scale's minimum visible width, and one
  // that would then run past the end of the window is pulled back to the
  // window's edge: a sliver at the right-hand edge reads as "at the very end"
  // rather than as a measurement, and the exact figures are in the row's
  // duration cell and in its name. That is `../utils/scale`'s behaviour, not a
  // judgement made here.
  //
  // The bar's geometry, and with `LABEL_SLOT_STYLE` one of the file's two
  // inline styles. The values live in `--dgc-*` custom properties — the colour a token reference from `../utils/color`, the two
  // coordinates percentages from `../utils/scale` — and the two declarations
  // beside them are `var()` references that contain no value of their own. This
  // is the contract `.dg-waterfall__bar` states in `../styles/components.css`:
  // "`inset-inline-start` and `inline-size` are the component's, computed from
  // the time scale".
  const barStyle: CustomPropertyStyle = {
    '--dgc-bar-color': kindColorVar(row.kind),
    '--dgc-bar-offset': percent(geometry.x),
    '--dgc-bar-extent': percent(geometry.width),
    insetInlineStart: 'var(--dgc-bar-offset)',
    inlineSize: 'var(--dgc-bar-extent)',
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (isNestedControlEvent(event.target)) {
      return;
    }
    onSelect(row);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // A key pressed on the disclosure button or the source chip belongs to that
    // control: both are buttons, and both act on Enter and Space themselves.
    if (isNestedControlEvent(event.target)) {
      return;
    }
    const element = event.currentTarget;
    switch (event.key) {
      case 'Enter':
      case ' ':
        // Space scrolls the panel otherwise, and Enter would submit an
        // enclosing form in a host that has one.
        event.preventDefault();
        onSelect(row);
        return;
      case 'ArrowDown':
        event.preventDefault();
        focusStep(element, 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusStep(element, -1);
        return;
      case 'ArrowRight':
        // Open a closed row, then step into it: the two presses the tree
        // pattern asks for, in that order.
        event.preventDefault();
        if (hasChildren && !expanded) {
          onToggle(row);
          return;
        }
        focusFirstChild(element);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (expanded) {
          onToggle(row);
          return;
        }
        focusParent(element);
        return;
      case 'Home':
        event.preventDefault();
        focusEdge(element, 0);
        return;
      case 'End':
        event.preventDefault();
        focusEdge(element, -1);
        return;
      default:
        return;
    }
  };

  const handleToggle = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onToggle(row);
  };

  return (
    <>
      <div
        className={clsx(
          'dg-waterfall__row',
          expanded && 'dg-is-expanded',
          selected && 'dg-is-selected',
          row.status === 'error' && 'dg-is-error',
          row.lineageAmbiguous && 'dg-is-ambiguous',
        )}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-selected={selected}
        aria-owns={expanded ? groupId : undefined}
        // The same sentence the tooltip carries, and for the same reason: the
        // row's visible text is a truncated label beside a handful of chips,
        // and the figure a reader most needs — how far into the window the call
        // started — is in neither. Naming the row explicitly also settles what
        // it is called: the tooltip's bubble is a descendant of the row, so a
        // name computed from the row's contents would read the label once as
        // itself and once again inside the description.
        aria-label={description}
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <Stack direction="horizontal" gap={1} align="center" className="dg-waterfall__name">
          {hasChildren ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={
                expanded ? (
                  <ChevronDown aria-hidden="true" className="dg-icon" />
                ) : (
                  <ChevronRight aria-hidden="true" className="dg-icon" />
                )
              }
              aria-label={expanded ? 'Collapse nested calls' : 'Expand nested calls'}
              aria-expanded={expanded}
              // Referenced only while the group exists: a control may not point
              // at an id that is not in the document.
              {...(expanded ? { 'aria-controls': groupId } : {})}
              onClick={handleToggle}
            />
          ) : null}
          {row.method === undefined ? null : (
            <Badge variant="outline" tone="neutral">
              {row.method}
            </Badge>
          )}
          <span className="dg-waterfall__label-slot" style={LABEL_SLOT_STYLE}>
            <Tooltip content={description} className="dg-waterfall__tooltip">
              {row.statement === undefined ? (
                <Text as="span" size="sm" truncate className="dg-waterfall__label">
                  {oneLinePreview(label, LABEL_PREVIEW_LENGTH)}
                </Text>
              ) : (
                // A statement is monospace, and `dg-waterfall__label` carries
                // the UI type role, which would override that role for the
                // whole string. The truncation utility is composed directly
                // instead, so the statement keeps both its font and its single
                // line.
                <Code size="sm" className="dg-truncate">
                  {oneLinePreview(label, LABEL_PREVIEW_LENGTH)}
                </Code>
              )}
            </Tooltip>
          </span>
          {row.occurrenceCount === undefined ? null : (
            <Badge tone="info" variant="outline">
              {`${formatCount(row.occurrenceCount)} calls`}
            </Badge>
          )}
          {row.statusCode === undefined ? null : (
            <Badge tone={statusCodeTone(row.statusCode)} className="dg-waterfall__status">
              {String(row.statusCode)}
            </Badge>
          )}
          {row.rowCount === undefined ? null : (
            <Badge tone="neutral" variant="outline">
              {`${formatCount(row.rowCount)} rows`}
            </Badge>
          )}
          {row.lineageAmbiguous ? (
            <Badge tone="warning" variant="outline">
              Inferred parent
            </Badge>
          ) : null}
          {row.childrenTruncated ? (
            <Badge tone="warning" variant="outline">
              Nested calls not drawn
            </Badge>
          ) : null}
          {row.source === undefined ? null : <SourceLink location={row.source} compact />}
        </Stack>
        <div className="dg-waterfall__track">
          {/* Decorative: the duration cell beside it prints the same measurement
              as text, so the bar adds no information for a reader. */}
          <div
            className="dg-waterfall__bar dg-waterfall__bar--active"
            style={barStyle}
            aria-hidden="true"
          />
        </div>
        <DurationCell
          ms={row.durationMs}
          severity="auto"
          size="sm"
          className="dg-waterfall__duration"
        />
      </div>
      {expanded ? (
        <div id={groupId} role="group" className="dg-waterfall__children dg-waterfall__child-rows">
          {row.children.map((child) => (
            <WaterfallRowItem
              key={child.eventId}
              row={child}
              depth={depth + 1}
              scale={scale}
              viewStart={viewStart}
              groupIdPrefix={groupIdPrefix}
              expandedIds={expandedIds}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------------------
 * The component
 * ------------------------------------------------------------------------- */

/** What the panel host hands a `waterfall` node. */
export interface WaterfallProps {
  /**
   * The validated panel node this component renders. Its `query` decides what
   * is drawn and its `id` is the identity reported to
   * the `onExpand` report of the ambient `PanelActions`.
   */
  node: WaterfallNode;
  /** Appended to the block's class list, last, so a host can place the view. */
  className?: string | undefined;
}

/** No row expanded — the state every render starts from. */
const NO_EXPANDED_IDS: ReadonlySet<string> = new Set<string>();

/** Any resolved query, read for its status and paging counters alone. */
type AnyQueryResult = UseQueryResult<unknown>;

/**
 * The request and dependency waterfall of one interaction.
 *
 * Resolves the node's query through the ambient `DataProvider`, normalises the
 * payload into rows nested by ancestry and positioned by their offset from the
 * first call, and renders the loading, error and empty states in that
 * precedence. A page that arrived while rows are already on screen degrades to
 * a footer notice rather than replacing the view, so paging never blanks a chart
 * the developer is reading — and a failure is still reported as a failure, with
 * a retry, never as a successful empty result (AAP 0.5.5).
 *
 * @param props The node to draw and an optional class name.
 */
export function Waterfall(props: WaterfallProps): ReactElement {
  const { node, className } = props;
  const actions = usePanelActions();
  const nodeId = node.id;
  const baseQuery = node.query;
  const domIdSeed = useId();

  const identity = useMemo(() => queryIdentity(baseQuery), [baseQuery]);
  const [paging, setPaging] = useState<PagingState>(() =>
    initialPaging(identity, baseQuery.offset),
  );
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(NO_EXPANDED_IDS);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  // Accumulated pages belong to one query identity. When the node's query
  // changes, the pages held in state are simply not used — derived here rather
  // than reset in an effect, so the first render after the change already draws
  // the new query's first page.
  const paged = paging.identity === identity ? paging : initialPaging(identity, baseQuery.offset);
  const carried = paged.loaded;
  const offset = paged.offset;

  const filterKinds = baseQuery.filter?.kinds;
  const includedKinds = useMemo(() => resolveIncludedKinds(filterKinds), [filterKinds]);

  const spanQuery = useMemo(() => narrowSpanListQuery(baseQuery, offset), [baseQuery, offset]);
  const requestsQuery = useMemo(() => narrowRequestsQuery(baseQuery, offset), [baseQuery, offset]);
  const traceQuery = useMemo(() => narrowTraceQuery(baseQuery), [baseQuery]);

  // At most one of the three carries a query; the other two resolve nothing.
  const spanResult = useQuery(spanQuery);
  const requestsResult = useQuery(requestsQuery);
  const traceResult = useQuery(traceQuery);

  const spanPage = spanResult.data;
  const requestsPage = requestsResult.data;
  const tracePayload = traceResult.data;

  const model = useMemo<WaterfallModel>(() => {
    if (spanQuery !== undefined) {
      const previous = carried.kind === 'spans' ? carried.items : EMPTY_EVENTS;
      const page = spanPage ?? EMPTY_EVENTS;
      return buildFromEvents(previous.length === 0 ? page : [...previous, ...page], includedKinds);
    }
    if (requestsQuery !== undefined) {
      const previous = carried.kind === 'requests' ? carried.items : EMPTY_GROUPS;
      const page = requestsPage ?? EMPTY_GROUPS;
      return buildFromRequests(
        previous.length === 0 ? page : [...previous, ...page],
        includedKinds,
      );
    }
    if (traceQuery !== undefined && tracePayload !== undefined) {
      return buildFromTrace(tracePayload, includedKinds);
    }
    return EMPTY_MODEL;
  }, [
    spanQuery,
    spanPage,
    requestsQuery,
    requestsPage,
    traceQuery,
    tracePayload,
    carried,
    includedKinds,
  ]);

  // How many source items have been resolved so far, which is what "loaded of
  // total" compares against — the drawn row count is a different figure,
  // because records of other kinds are filtered out and groups expand into
  // occurrences.
  const loadedItemCount = useMemo(() => {
    if (spanQuery !== undefined) {
      const previous = carried.kind === 'spans' ? carried.items.length : 0;
      return previous + (spanPage?.length ?? 0);
    }
    if (requestsQuery !== undefined) {
      const previous = carried.kind === 'requests' ? carried.items.length : 0;
      return previous + (requestsPage?.length ?? 0);
    }
    return model.rowCount;
  }, [spanQuery, requestsQuery, carried, spanPage, requestsPage, model.rowCount]);

  const result: AnyQueryResult | undefined =
    spanQuery !== undefined
      ? spanResult
      : requestsQuery !== undefined
        ? requestsResult
        : traceQuery !== undefined
          ? traceResult
          : undefined;
  const nextOffset = result?.nextOffset;

  const scale = useMemo(
    () => createTimeScale([model.viewStart, model.viewEnd], [0, PERCENT_RANGE]),
    [model.viewStart, model.viewEnd],
  );
  const axis = useMemo(
    () =>
      generateAxisTicks(scale, {
        origin: model.viewStart,
        targetCount: AXIS_TICK_TARGET,
        minSpacing: AXIS_TICK_MIN_SPACING,
      }),
    [scale, model.viewStart],
  );

  const handleSelect = useCallback(
    (row: WaterfallRow): void => {
      setSelectedId(row.eventId);
      actions?.onSelectEvent({ eventId: row.eventId, spanId: row.spanId, traceId: row.traceId });
    },
    [actions],
  );

  const handleToggle = useCallback(
    (row: WaterfallRow): void => {
      const willExpand = !expandedIds.has(row.eventId);
      const next = new Set(expandedIds);
      if (willExpand) {
        next.add(row.eventId);
      } else {
        next.delete(row.eventId);
      }
      setExpandedIds(next);
      actions?.onExpand?.(nodeId, row.eventId, willExpand);
    },
    [actions, expandedIds, nodeId],
  );

  const handleLoadMore = useCallback((): void => {
    if (nextOffset === undefined) {
      return;
    }
    if (spanQuery !== undefined) {
      const previous = carried.kind === 'spans' ? carried.items : EMPTY_EVENTS;
      const page = spanPage ?? EMPTY_EVENTS;
      setPaging({
        identity,
        offset: nextOffset,
        loaded: { kind: 'spans', items: [...previous, ...page] },
      });
      return;
    }
    if (requestsQuery !== undefined) {
      const previous = carried.kind === 'requests' ? carried.items : EMPTY_GROUPS;
      const page = requestsPage ?? EMPTY_GROUPS;
      setPaging({
        identity,
        offset: nextOffset,
        loaded: { kind: 'requests', items: [...previous, ...page] },
      });
    }
  }, [carried, identity, nextOffset, requestsPage, requestsQuery, spanPage, spanQuery]);

  const queryDescription = describeQuery(baseQuery, offset);
  const hasRows = model.rowCount > 0;

  let body: ReactNode;
  if (result === undefined) {
    // A validated specification cannot reach this state: the node catalog
    // constrains a waterfall node to the sources handled above. A host that
    // rendered an unvalidated node still gets a stated failure rather than an
    // empty chart that would read as "nothing was captured".
    body = (
      <div className="dg-waterfall__error">
        <ErrorState
          title="This view cannot draw that data source"
          message="The panel node asked for a source this view does not read. Regenerate the panel, or open the data in a view that reads it."
          query={queryDescription}
        />
      </div>
    );
  } else if (result.status === 'loading' && !hasRows) {
    body = (
      <div className="dg-waterfall__loading">
        <LoadingState variant="chart" label="Loading captured calls" />
      </div>
    );
  } else if (result.status === 'error' && !hasRows) {
    body = (
      <div className="dg-waterfall__error">
        <ErrorState
          message="The captured calls could not be loaded."
          code={result.error?.code}
          query={queryDescription}
          onRetry={result.retry}
        />
      </div>
    );
  } else if (!hasRows) {
    body = (
      <div className="dg-waterfall__empty">
        <EmptyState message="No network or database calls were captured for this interaction." />
      </div>
    );
  } else {
    const loadingMore = result.status === 'loading';
    const failedMore = result.status === 'error';
    const total = result.total;
    const countText =
      total === undefined
        ? `${formatCount(model.rowCount)} calls`
        : `${formatCount(model.rowCount)} calls · loaded ${formatCount(loadedItemCount)} of ${formatCount(total)}`;
    body = (
      <>
        <WaterfallAxis ticks={axis.ticks} windowMs={model.windowMs} />
        <div
          className="dg-waterfall__rows"
          role="tree"
          aria-label="Captured calls, nested under the call that was waiting on them"
        >
          {model.rows.map((row) => (
            <WaterfallRowItem
              key={row.eventId}
              row={row}
              depth={0}
              scale={scale}
              viewStart={model.viewStart}
              groupIdPrefix={domIdSeed}
              expandedIds={expandedIds}
              selectedId={selectedId}
              onToggle={handleToggle}
              onSelect={handleSelect}
            />
          ))}
        </div>
        <Stack
          direction="horizontal"
          gap={2}
          align="center"
          justify="between"
          wrap
          className="dg-waterfall__footer"
        >
          <Text size="xs" tone="muted">
            {model.truncated ? `${countText} · some nested calls were not drawn` : countText}
          </Text>
          {nextOffset === undefined ? null : (
            <Button variant="secondary" size="sm" disabled={loadingMore} onClick={handleLoadMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </Stack>
        {failedMore ? (
          <div className="dg-waterfall__error">
            <ErrorState
              message="The next page of captured calls could not be loaded."
              code={result.error?.code}
              query={queryDescription}
              onRetry={result.retry}
            />
          </div>
        ) : null}
      </>
    );
  }

  return <div className={clsx('dg-waterfall', className)}>{body}</div>;
}
