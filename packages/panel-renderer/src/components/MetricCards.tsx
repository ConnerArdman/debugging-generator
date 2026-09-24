/**
 * `MetricCards` — the capture's headline numbers as a row of tiles, one per
 * requested metric id (AAP 0.6.2).
 *
 * This module is the component behind the node catalog's `metricCards` type. It
 * is one of only three components that recur across otherwise dissimilar panels
 * (AAP 0.6.5, with the summary header and the source-location chip): a
 * slow-interaction panel opens with the per-tier durations, a re-render panel
 * with the render counts, and a duplicate-request panel with the request
 * counts. **The same component draws all three.** Which numbers appear is the
 * node's `metrics` option and nothing else — there is no branch anywhere below
 * on a question, a wording, a panel, a component name or a route, which is the
 * property AAP 0.5.4 requires and `scripts/check-no-hardcoding.mjs` enforces.
 *
 * ## NOTHING HERE IS COMPUTED
 *
 * Every value is computed once, upstream, by the telemetry package's aggregate
 * layer and arrives through the data provider already labelled, united and
 * marked available or not. This file formats and lays out what it receives: it
 * never sums, averages, converts, totals, infers or substitutes a number, and
 * it never repairs one it finds surprising. A figure computed in a renderer is a
 * figure that can disagree with the same figure elsewhere in the panel, and the
 * panel would then be arguing with itself in front of the developer.
 *
 * Two consequences worth stating, because both are easy to "tidy" away:
 *
 *   - `unchanged_render_count` and `render_trigger_unknown_count` are
 *     **separate metrics with separate meanings** (AAP 0.2.3): the first counts
 *     renders whose inputs were all provably stable, the second counts renders
 *     whose trigger could not be evaluated at all. They are never added,
 *     grouped, relabelled or presented as one another — an unevaluated render
 *     is not an unnecessary one.
 *   - the metric vocabulary is closed and owned upstream. This file names no id
 *     of it. Ordering, labelling and units all arrive with the data, so adding
 *     a metric upstream needs no change here.
 *
 * ## AN UNOBSERVABLE VALUE SAYS SO (AAP 0.6.6)
 *
 * A metric that the capture could not measure renders the package's single
 * spelling of absence — {@link NOT_AVAILABLE_LABEL} — under the
 * `dg-is-unavailable` state, muted, with no severity colour and no unit. Never
 * `0`, never a blank tile, never a dash, and never a hidden card.
 *
 * That is a correctness requirement rather than a cosmetic one. A transfer size
 * is exposed by the browser for same-origin responses only and by a server span
 * not at all, which AAP 0.6.6 records as a known gap; printing `0` there would
 * turn an absence into an observation, and a developer would read it as "nothing
 * was transferred". The same rule covers a requested id that the capture did not
 * compute at all: the tile is still drawn, still in the author's order, and says
 * that the value is not part of this capture — dropping it silently would leave
 * the reader to notice that a tile they asked for is missing.
 *
 * ## NOT ON THE PAGES READ IS NOT THE SAME AS NOT COMPUTED
 *
 * A requested id that no page carried is one of two different things, and the
 * tile says which, because only one of them is a finding:
 *
 *   - **The read was complete.** It started at the source's first item, its
 *     last page reported no further page, and it holds at least as many values
 *     as the service's `total` (when one was reported). Every value the capture
 *     computed was therefore on a page read, so the id is not part of this
 *     capture and the tile is the unavailable one described above.
 *   - **The read was partial.** A count-only `limit: 0` query, an authored
 *     `offset` past the start, or a follow that stopped because the service's
 *     counter did not advance or its page added nothing new. The value lies
 *     outside the page or pages this query requested and may well exist, so the
 *     tile reads {@link NOT_ON_PAGE_LABEL} with a note saying exactly that.
 *     Calling it "not computed" would state an observation the evidence does
 *     not support.
 *
 * Both tiles carry the muted `dg-is-unavailable` state — neither shows a
 * measurement — and neither is ever `0`, a dash or blank. The same split governs
 * a read that holds no value at all: it is the "nothing was computed" empty state
 * only when the service reported a `total` of zero or the read was complete.
 * Otherwise the requested tiles are drawn as not on the page, and a node that
 * names no ids gets its own empty message saying the computed values lie outside
 * the requested page, with the service's `total` when it reported one.
 *
 * ## THE TILES ARE NOT CONTROLS
 *
 * A metric is an aggregate of the whole capture, so it references no single
 * captured record: there is nothing for a click to select and no location for it
 * to open. Making a tile clickable would therefore have to invent a target,
 * which is fabricated evidence. A tile is consequently a list item and not a
 * button, this module imports no `PanelActions`, and the only focusable thing it
 * renders is the advisory-note affordance, whose whole purpose is to make a
 * hover-only description reachable from the keyboard. Should a metric ever carry
 * a reference to the records behind it, that is a change to the data contract
 * first and to this component second.
 *
 * ## THE NODE'S QUERY, PAGE BY PAGE, AND NO TRANSPORT IS TOUCHED
 *
 * The first request is the node's own `query`, resolved through `../host/useQuery`
 * exactly as authored: no filter, sort, limit or offset is added, because a
 * renderer that narrowed the request would be choosing evidence. The `metrics`
 * source is paged by the same `DataPage` rule as every array-valued source —
 * `limit` and `offset` are honoured, `total` and `nextOffset` come back — so one
 * page need not hold every id the node names. When it does not, the next page is
 * requested as `{ ...query, offset: nextOffset }`: the authored filter, sort and
 * limit kept, and only the offset advanced, to the value the service reported
 * rather than to one derived from the length of what arrived (which drifts the
 * moment a limit is clamped).
 *
 * The next page is followed only while all four of these hold:
 *
 *   1. the page reported a `nextOffset`, so the service says more exists;
 *   2. that offset lies beyond the page it came from — a counter that does not
 *      advance would only repeat the same request (the protocol refuses one,
 *      and a count-only `limit: 0` page reports `null`, being the last page);
 *   3. the page contributed an id not already collected, so the read is making
 *      progress; and
 *   4. an id the node names is still missing — or the node names none, which
 *      means every computed value is drawn.
 *
 * Conditions 3 and 4 are what bound the chain. Every page that is followed has
 * added at least one new id from a closed, finite vocabulary, so a read requests
 * at most one page more than that vocabulary has ids — without this file
 * knowing, or importing, how large the vocabulary is.
 *
 * Pages are stitched **by id**: the first occurrence of an id wins and arrival
 * order is preserved. `../host/useQuery` itself never merges pages; the merge is
 * this component's, made after each page has settled, and it is sound here for a
 * reason specific to tiles: a tile is addressed by its id and shows exactly what
 * one response said about that id — its label, unit, value, availability and
 * note — so no tile combines, reorders or re-derives anything across responses.
 *
 * Each page is resolved by its own module-private level ({@link MetricCardsPage}),
 * which calls the hook exactly once and then renders either the next level or the
 * settled read, so no component's hook count ever varies between renders. The
 * provider behind the hook is the host surface's (AAP 0.1.2) — there is no
 * `fetch`, no socket and no message port in this file, and `@debuggen/telemetry`
 * is imported for **types only**.
 *
 * All three states AAP 0.6.2 requires are rendered, in this precedence: a node
 * whose query names a source these tiles cannot draw (an error, reported rather
 * than silently mis-drawn), then loading — held until the last page the tiles
 * need has settled, so a partial read is never drawn as tiles and mislabelled —
 * then a failed query, reported with the query of the page that failed and a
 * retry that re-requests that page alone, then a capture that computed nothing,
 * then the tiles.
 *
 * The node's optional `title` and `description` are deliberately **not** drawn
 * here. Every query-backed node carries those two fields identically, and the
 * layout primitives already take a `title`/`description` pair, so that chrome
 * belongs to the host's node renderer where it is written once for all twelve
 * of them; drawing it here as well would give a titled node two headings.
 *
 * ## APPEARANCE IS A CLASS CONTRACT, NEVER AN INLINE STYLE (AAP 0.6.4)
 *
 * This file declares class names and one CSS custom property. There is no
 * colour, length, font or other literal CSS value in it; every declaration
 * behind the names below lives in `../styles/components.css` and resolves to a
 * `--dg-*` token:
 *
 *   `dg-metric-cards`            the block: the auto-fitting tile grid, whose
 *                                gap is a space token. It carries no breakpoint
 *                                — a narrow editor column and a wide DevTools
 *                                panel are the same rule — which is why this
 *                                component composes no responsive split.
 *   `dg-metric-cards__empty`     the three state boxes, shaped exactly like
 *   `dg-metric-cards__loading`   every other query-backed view's, so an
 *   `dg-metric-cards__error`     unresolved node is visibly a state and never
 *                                a blank area.
 *   `dg-metric-card`             one tile: the shared elevated card surface.
 *   `dg-metric-card__label`      the metric's heading.
 *   `dg-metric-card__value`      the figure, in the prominent numeric role. It
 *                                reads `--dgc-severity-color`, which is the one
 *                                custom property this file sets and the only
 *                                inline style it produces.
 *   `dg-metric-card__unit`       the unit symbol, as its own muted element
 *                                rather than a suffix inside the number.
 *   `dg-metric-card__hint`       the advisory-note affordance.
 *   `dg-is-unavailable`          the state, on the tile, which is where the
 *                                stylesheet's rule expects it. It marks both
 *                                the unavailable tile and the not-on-page
 *                                tile: each is muted for the same reason, and
 *                                their figure and note are what tell them
 *                                apart, so no further state class is needed.
 *
 * The `dg-metric-cards__card`, `__label`, `__value`, `__unit` and `__note`
 * names are emitted alongside the tile's own block names because the component
 * contract states them; they carry no declarations of their own, and the
 * stylesheet's `dg-metric-card*` names above are what style the tile. The
 * caller's `className` is composed last, on the root.
 *
 * ## ACCESSIBILITY
 *
 * The group is a list and each tile a list item, with both roles stated
 * explicitly: the stylesheet lays the grid out with `display: grid` and each
 * tile with `display: flex`, and a changed display value drops the implicit
 * list semantics in WebKit-derived engines. Every tile carries an accessible
 * name pairing its heading with its figure and unit, because a list item takes
 * its name from the author rather than from its contents, and a figure
 * announced without its heading is a number with no subject. That name carries
 * the tile's own figure, so a not-on-page tile is announced as not on the page
 * and an unavailable one as the absent label: a screen-reader user hears the
 * same distinction a sighted one sees. The advisory note is a focusable
 * affordance so that its description is reachable without a pointer, and the
 * tooltip keeps that description in the accessibility tree even while the
 * bubble is closed.
 *
 * @see ../host/useQuery for the state machine behind the three states.
 * @see ../utils/format for the metric, duration and label formatting.
 * @see ../utils/color for the four duration-severity buckets.
 * @see ../styles/components.css for the implementation of the classes above.
 */

import type { DataQuery, DataQuerySource, MetricCardsNode } from '@debuggen/panel-schema';
import { DATA_QUERY_DEFAULT_OFFSET, PANEL_NODE_CATALOG } from '@debuggen/panel-schema';
import type { MetricId, MetricValue } from '@debuggen/telemetry';
import clsx from 'clsx';
import { Info } from 'lucide-react';
import type { CSSProperties, ReactElement } from 'react';

import { useQuery } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import { durationColorVar } from '../utils/color';
import {
  NOT_AVAILABLE_LABEL,
  formatCount,
  formatDurationParts,
  formatMetric,
  humanizeLabel,
} from '../utils/format';

/**
 * A style object that may carry CSS custom properties.
 *
 * Module-private, exactly as in the primitives that need one: React's
 * `CSSProperties` has no index signature for `--*`, and this is the narrowest
 * way to pass one without reaching for `any`.
 */
type CssVariableStyle = CSSProperties & Record<`--${string}`, string>;

/**
 * The one source these tiles can draw, mirroring the catalog entry's
 * `sources`/`defaultSource` (`['metrics']`).
 *
 * A literal is needed rather than a read of the catalog because the catalog's
 * value type is the whole source union, and this component needs the *literal*
 * to type the resolved page as metric values. `satisfies` keeps it honest: were
 * the source vocabulary ever renamed, this line would stop compiling instead of
 * quietly asking for a source that no longer exists.
 */
const METRICS_SOURCE = 'metrics' satisfies DataQuerySource;

/**
 * A query narrowed to the one source these tiles draw — the node's own, or it
 * with `offset` advanced to a page the service reported.
 */
type MetricsQuery = DataQuery & { source: typeof METRICS_SOURCE };

/**
 * The offset of a source's first item.
 *
 * A read that began anywhere else cannot have seen the items before it, so it
 * can never be complete however many pages follow. Named rather than written
 * as a bare `0` at the comparison, because it is a statement about the start of
 * the source and not about the offset a query receives when it omits one
 * (`DATA_QUERY_DEFAULT_OFFSET`), even though the two are the same number.
 */
const SOURCE_START_OFFSET = 0;

/**
 * The collection a read starts from: no values yet.
 *
 * One frozen module-level array, so the first page level receives the same
 * identity on every render instead of a fresh literal.
 */
const NO_VALUES: readonly MetricValue[] = Object.freeze([]);

/** This node type's catalog entry — the single registry of what it is. */
const CATALOG_ENTRY = PANEL_NODE_CATALOG.metricCards;

/** Copy for the successful-but-empty case: the capture computed no values. */
const EMPTY_MESSAGE = 'No metrics were computed for this capture.';

/** Copy for a failed query. The code and the query carry the detail. */
const ERROR_MESSAGE = 'The computed values of this capture could not be loaded.';

/**
 * Copy for a node asking for a source these tiles cannot draw.
 *
 * Unreachable for a specification that passed validation — the validator checks
 * each node's query source against the catalog's `sources` — so this is the
 * honest report of a defect upstream rather than an expected state.
 */
const SOURCE_MISMATCH_MESSAGE = `These tiles can only draw the "${METRICS_SOURCE}" source.`;

/** The note a tile carries when the capture computed no value for its id. */
const MISSING_METRIC_NOTE = 'This value is not part of the computed set of this capture.';

/**
 * The figure of a tile whose value lies outside the page or pages this query
 * requested.
 *
 * Deliberately not {@link NOT_AVAILABLE_LABEL}: that spelling says the capture
 * holds no value, and this one says only that the read did not reach it. Not a
 * `0` and not a dash either, for the same reason the absent label is neither —
 * each would read as an observation. Module-private, because the distinction it
 * draws belongs to this view's paging and to no other formatter's vocabulary.
 */
const NOT_ON_PAGE_LABEL = 'not on page';

/** The note a tile carries when its value lies outside the page or pages read. */
const NOT_ON_PAGE_NOTE =
  'This value lies outside the page or pages this query requested; the capture may still hold it.';

/**
 * Copy for a read that holds no values although the capture may have computed
 * some — a node naming no ids, answered by a count-only or offset page.
 * {@link offPageEmptyMessage} appends the service's total when it reported one.
 */
const OFF_PAGE_EMPTY_MESSAGE =
  'The computed values of this capture lie outside the page this query requested.';

/** The accessible name of the advisory-note affordance; its description is the note. */
const NOTE_AFFORDANCE_LABEL = 'Coverage note';

/** What the loading state announces to a screen reader. */
const LOADING_LABEL = 'Loading the computed values of this capture';

/**
 * One tile, fully resolved: what to show, in what unit, and whether the figure
 * is a measurement.
 *
 * Built by {@link describeMetric} from a metric value, by
 * {@link describeMissingMetric} for a requested id a complete read did not
 * find, or by {@link describeOffPageMetric} for one a partial read did not
 * reach. Deliberately flat and string-valued: every judgement — availability,
 * the unit's split from the figure, the severity token — is made once, before
 * any markup, so the rendering below is a single pass with no arithmetic in it.
 */
interface MetricCard {
  /** Which metric this tile is, used for its React key. */
  readonly id: MetricId;
  /** The tile's heading, as the aggregate layer labelled it. */
  readonly label: string;
  /**
   * The figure, already formatted — or {@link NOT_AVAILABLE_LABEL}, or
   * {@link NOT_ON_PAGE_LABEL}.
   */
  readonly figure: string;
  /** The unit symbol, when the figure has one to show beside it. */
  readonly unit: string | undefined;
  /** A `var(--dg-duration-*)` reference for a measured duration, else absent. */
  readonly severityColor: string | undefined;
  /** The metric's coverage caveat, shown as an advisory note. */
  readonly note: string | undefined;
  /** Whether {@link figure} is a measurement rather than either absent spelling. */
  readonly available: boolean;
}

/**
 * What one read — the pages followed so far — has collected.
 *
 * Built by {@link collectPage} once per settled page, so the decision to follow
 * another page and the tiles drawn when none is followed read the same values.
 */
interface CollectedValues {
  /** Every distinct id's value, first occurrence first, in arrival order. */
  readonly values: readonly MetricValue[];
  /** Whether the latest page added an id no earlier page carried. */
  readonly contributed: boolean;
}

/**
 * Whether a node's query asks for the source these tiles draw.
 *
 * A type guard rather than a cast: the node schema types `query.source` as the
 * whole source union, while the data hook is generic over one member of it, and
 * this predicate is the one place the two meet. A query that fails it is
 * reported as an error state (see {@link SOURCE_MISMATCH_MESSAGE}) instead of
 * being coerced, because coercing it would draw metric tiles from whatever the
 * other source resolved to.
 */
function isMetricsQuery(query: DataQuery): query is MetricsQuery {
  return query.source === METRICS_SOURCE;
}

/**
 * Resolves one metric value into its tile.
 *
 * Availability comes from the shared formatter's own decision
 * (`formatMetric().available`, which folds `available: false`, a missing value
 * and a non-finite value into one answer) and is then confirmed against the
 * formatted text: a finite value whose magnitude fixed notation cannot express
 * formats as the absent label, and a tile must not be styled as a measurement
 * while showing one. The two checks together are what make this total.
 *
 * The unit is split from the figure only where the formatters offer that split
 * — durations do, through {@link formatDurationParts} — so the number in the
 * prominent role never has a unit concatenated into it and no string surgery is
 * performed on a formatted value. A count carries no unit symbol at all, and a
 * byte size formats as one string, which is what its tile shows.
 */
function describeMetric(metric: MetricValue): MetricCard {
  const display = formatMetric(metric);

  // Narrowed to a number here so the duration split and the severity lookup
  // below need no second check; `undefined` means "not a measurement".
  const measured = display.available && typeof metric.value === 'number' ? metric.value : undefined;

  const parts =
    measured !== undefined && metric.unit === 'milliseconds'
      ? formatDurationParts(measured)
      : undefined;

  // Both arms of the duration split carry a `value`, the unavailable one being
  // the absent label itself, so this needs no branch of its own.
  const figure = parts === undefined ? display.text : parts.value;
  const unit = parts?.available === true ? parts.unit : undefined;
  const available = measured !== undefined && figure !== NOT_AVAILABLE_LABEL;

  return {
    id: display.id,
    // A value always arrives labelled; a blank label is a malformed one, and a
    // tile with no heading is a number with no subject, so the same humanizer
    // the absent-value tile uses stands in for it.
    label: display.label === '' ? humanizeLabel(display.id) : display.label,
    figure,
    unit,
    // Severity is a judgement about *duration* against the product's four
    // shared thresholds, so only a measured duration carries one: a count has
    // no threshold to be read against, and an unavailable figure must never be
    // coloured as though it had been measured.
    severityColor:
      available && measured !== undefined && parts !== undefined
        ? durationColorVar(measured)
        : undefined,
    note: display.note,
    available,
  };
}

/**
 * The tile for a requested id the capture holds no value for — an id a
 * complete read did not find.
 *
 * Still drawn, still in the author's position, and explicitly unavailable: the
 * author asked for this number, and a silently dropped tile would leave them
 * reading a row that quietly answers a different question. The heading falls
 * back to the shared label humanizer, because a label only arrives with a
 * value, and the note says plainly that the value is absent rather than zero.
 */
function describeMissingMetric(id: MetricId): MetricCard {
  return {
    id,
    label: humanizeLabel(id),
    figure: NOT_AVAILABLE_LABEL,
    unit: undefined,
    severityColor: undefined,
    note: MISSING_METRIC_NOTE,
    available: false,
  };
}

/**
 * The tile for a requested id a partial read did not reach.
 *
 * Shaped like {@link describeMissingMetric} — still drawn, in the author's
 * position, muted, with the humanized heading — but it claims less: its figure
 * is {@link NOT_ON_PAGE_LABEL} and its note says the value lies outside the page
 * or pages requested, because nothing the read saw says the capture lacks it.
 */
function describeOffPageMetric(id: MetricId): MetricCard {
  return {
    id,
    label: humanizeLabel(id),
    figure: NOT_ON_PAGE_LABEL,
    unit: undefined,
    severityColor: undefined,
    note: NOT_ON_PAGE_NOTE,
    available: false,
  };
}

/**
 * Chooses which tiles to draw, and in which order.
 *
 * The node's `metrics` option is the author's emphasis — first id, first tile —
 * so it drives both the selection and the order, with every requested id
 * drawn whether or not the read found it. A node with no ids (which the
 * schema does not permit, but a hand-built object can express) falls back to the
 * order the values arrived in, which is the vocabulary's own order.
 *
 * @param node The node, for its `metrics` option.
 * @param values The values the read collected, one per id.
 * @param complete Whether the read covered every computed value, which decides
 *   whether a missing id is unavailable or merely not on the pages read.
 */
function selectCards(
  node: MetricCardsNode,
  values: readonly MetricValue[],
  complete: boolean,
): MetricCard[] {
  if (node.metrics.length === 0) {
    return values.map(describeMetric);
  }

  const byId = new Map<MetricId, MetricValue>(values.map((value) => [value.id, value]));
  const describeAbsent = complete ? describeMissingMetric : describeOffPageMetric;

  return node.metrics.map((id) => {
    // `noUncheckedIndexedAccess` makes the miss explicit, and the miss is the
    // requested-but-not-found case rather than an error.
    const value = byId.get(id);

    return value === undefined ? describeAbsent(id) : describeMetric(value);
  });
}

/**
 * Adds one page's values to what earlier pages collected, by id.
 *
 * The first occurrence of an id wins — an earlier page's, or the earlier entry
 * within this page — and arrival order is preserved, so a tile always shows
 * exactly what one response said about its id and the vocabulary's order
 * survives the stitch. Nothing is compared, combined or re-derived across
 * entries: a later value for an id already collected is not "newer", it is a
 * producer repeating itself, and it is dropped.
 *
 * @param collected The values of the pages before this one.
 * @param page The page that just settled.
 * @returns The values so far, and whether this page added an id.
 */
function collectPage(
  collected: readonly MetricValue[],
  page: readonly MetricValue[],
): CollectedValues {
  const seen = new Set<MetricId>(collected.map((value) => value.id));
  const added: MetricValue[] = [];

  for (const value of page) {
    if (!seen.has(value.id)) {
      seen.add(value.id);
      added.push(value);
    }
  }

  // The earlier collection is returned as-is when nothing was added, so a page
  // that made no progress hands on the very array it received.
  return added.length === 0
    ? { values: collected, contributed: false }
    : { values: [...collected, ...added], contributed: true };
}

/**
 * Whether the tiles still need a value no page read so far carried.
 *
 * A node naming no ids draws every computed value, so for it the answer is
 * always yes: only the service's end-of-data, a stalled counter or a page that
 * adds nothing stops that read.
 */
function needsMoreValues(node: MetricCardsNode, values: readonly MetricValue[]): boolean {
  if (node.metrics.length === 0) {
    return true;
  }

  const present = new Set<MetricId>(values.map((value) => value.id));

  return node.metrics.some((id) => !present.has(id));
}

/**
 * Whether a finished read covered every value the capture computed.
 *
 * Three facts, each read off the query or the service's counters rather than
 * guessed: the read started at the source's first item; its last page reported
 * no further page; and, when the service reported a `total`, the read holds at
 * least that many values. The third only matters for a response that contradicts itself —
 * a last page whose counters say items exist that none of the pages carried —
 * and there the honest reading is that the values lie outside what was read,
 * never that the capture lacks them.
 *
 * @param firstOffset The offset the read's first page started at.
 * @param nextOffset The last settled page's next offset, `undefined` at the end.
 * @param collectedCount How many distinct values the read holds.
 * @param total The service's reported total, if it reported one.
 */
function isCompleteRead(
  firstOffset: number,
  nextOffset: number | undefined,
  collectedCount: number,
  total: number | undefined,
): boolean {
  return (
    firstOffset === SOURCE_START_OFFSET &&
    nextOffset === undefined &&
    (total === undefined || collectedCount >= total)
  );
}

/**
 * The empty message for a node naming no ids whose read holds no values while
 * the capture may hold some: {@link OFF_PAGE_EMPTY_MESSAGE}, with the service's
 * `total` when it reported one. The count is the service's, formatted and
 * never computed here.
 */
function offPageEmptyMessage(total: number | undefined): string {
  if (total === undefined) {
    return OFF_PAGE_EMPTY_MESSAGE;
  }

  const noun = total === 1 ? 'value' : 'values';

  return `${OFF_PAGE_EMPTY_MESSAGE} The capture reports ${formatCount(total)} computed ${noun} in total.`;
}

/** A tile's accessible name: its heading, its figure and its unit, in that order. */
function accessibleName(card: MetricCard): string {
  return card.unit === undefined
    ? `${card.label}: ${card.figure}`
    : `${card.label}: ${card.figure} ${card.unit}`;
}

/**
 * The severity custom property for a tile, or no inline style at all.
 *
 * The only inline style this component produces, and it carries a token
 * reference rather than a colour: the stylesheet consumes it as
 * `var(--dgc-severity-color, var(--dg-text-primary))`, so a tile that sets
 * nothing still resolves to a token.
 */
function severityStyle(card: MetricCard): CssVariableStyle | undefined {
  return card.severityColor === undefined
    ? undefined
    : { '--dgc-severity-color': card.severityColor };
}

/** The query as text, for the error state's detail block. */
function describeQuery(query: DataQuery): string {
  return JSON.stringify(query);
}

/**
 * One of the three states, in the block's own state box.
 *
 * The root keeps the block class and the caller's `className` in every branch,
 * so a state occupies the same place in the panel that the tiles would have.
 */
function stateFrame(
  boxClass: string,
  className: string | undefined,
  child: ReactElement,
): ReactElement {
  return (
    <div className={clsx('dg-metric-cards', className)}>
      <div className={boxClass}>{child}</div>
    </div>
  );
}

/**
 * The finished read, drawn: the tiles, or the empty state when there is nothing
 * to tile.
 *
 * Called by the last page level once no further page is needed, with every
 * value the read collected. The empty state follows the coverage rule in the
 * module note: "nothing was computed" only when the service reported a `total`
 * of zero or the read was complete. Otherwise the named ids are drawn as not on
 * the page, and a node naming none gets the off-page empty message.
 *
 * @param node The node, for its `metrics` option.
 * @param className The caller's class names, composed on the root.
 * @param values The values the read collected, one per id, in arrival order.
 * @param complete Whether the read covered every computed value.
 * @param total The service's reported total, if it reported one.
 * @returns The tile grid, or an empty state.
 */
function renderRead(
  node: MetricCardsNode,
  className: string | undefined,
  values: readonly MetricValue[],
  complete: boolean,
  total: number | undefined,
): ReactElement {
  if (values.length === 0) {
    // A capture that computed nothing is an empty state rather than a row of
    // absent tiles: there is no value to report the absence of. A requested id
    // missing from a non-empty read is the other case, and it is a tile.
    if (complete || total === 0) {
      return stateFrame(
        'dg-metric-cards__empty',
        className,
        <EmptyState message={EMPTY_MESSAGE} />,
      );
    }

    // Values may lie beyond the page read. With ids named, each is a tile that
    // says so, below; with none named there is no tile to draw, and the empty
    // state says where the values are rather than that they are absent.
    if (node.metrics.length === 0) {
      return stateFrame(
        'dg-metric-cards__empty',
        className,
        <EmptyState message={offPageEmptyMessage(total)} />,
      );
    }
  }

  // Never empty past this point: an empty read naming no ids returned above,
  // and otherwise there is one tile per named id or one per collected value.
  const cards = selectCards(node, values, complete);

  return (
    <ul className={clsx('dg-metric-cards', className)} role="list" aria-label={CATALOG_ENTRY.label}>
      {cards.map((card, index) => (
        <li
          // The index joins the id because a hand-built node can name the same
          // id twice, and two tiles must not share a key.
          key={`${String(index)}:${card.id}`}
          role="listitem"
          className={clsx(
            'dg-metric-card',
            'dg-metric-cards__card',
            !card.available && 'dg-is-unavailable',
          )}
          aria-label={accessibleName(card)}
        >
          <Text
            as="span"
            size="sm"
            tone="muted"
            className={clsx('dg-metric-card__label', 'dg-metric-cards__label')}
          >
            {card.label}
          </Text>
          <Stack direction="horizontal" gap={1} align="baseline" wrap>
            {/* No tone is passed: the tile's own rules decide this colour -
                the severity property when one is set, and the muted
                unavailable rule otherwise - and a tone class would be one
                more thing to keep in step with them. */}
            <Text
              as="span"
              size="lg"
              numeric
              className={clsx('dg-metric-card__value', 'dg-metric-cards__value')}
              style={severityStyle(card)}
            >
              {card.figure}
            </Text>
            {card.unit === undefined ? null : (
              <Text
                as="span"
                size="xs"
                tone="muted"
                className={clsx('dg-metric-card__unit', 'dg-metric-cards__unit')}
              >
                {card.unit}
              </Text>
            )}
            {card.note === undefined ? null : (
              <Tooltip content={card.note}>
                {/* Focusable on purpose: the note is a description carried by a
                    tooltip, and focus is how a keyboard reader opens one. The
                    glyph is decorative, so the affordance is named here and
                    described by the bubble. */}
                <Text
                  as="span"
                  size="xs"
                  tone="muted"
                  className={clsx('dg-metric-card__hint', 'dg-metric-cards__note')}
                  tabIndex={0}
                  aria-label={NOTE_AFFORDANCE_LABEL}
                >
                  <Info aria-hidden="true" className="dg-icon" />
                </Text>
              </Tooltip>
            )}
          </Stack>
        </li>
      ))}
    </ul>
  );
}

/**
 * The props of one {@link MetricCardsPage} level.
 *
 * Every member is required, with `| undefined` spelled where a value may be
 * absent: a level is only ever created by {@link MetricCards} or by the level
 * above it, and each of those knows every value it passes.
 */
interface MetricCardsPageProps {
  /** The node being drawn, for its `metrics` option. */
  readonly node: MetricCardsNode;
  /** The caller's class names, composed on whichever root this level renders. */
  readonly className: string | undefined;
  /** This level's page: the node's own query, or it with `offset` advanced. */
  readonly query: MetricsQuery;
  /** The offset the read's first page started at, for {@link isCompleteRead}. */
  readonly firstOffset: number;
  /** What the pages before this one collected, by id, in arrival order. */
  readonly collected: readonly MetricValue[];
  /** The latest `total` an earlier page reported, if any did. */
  readonly knownTotal: number | undefined;
}

/**
 * One page of the read: resolves its query, then renders either the next page's
 * level or the finished read.
 *
 * Recursive by design, because that is what keeps the rules of hooks: each
 * level calls {@link useQuery} exactly once and unconditionally, and how many
 * levels there are is decided by the data rather than by a loop of hook calls.
 * A level stays mounted only while it is needed. A level whose own query
 * changes or fails renders a state instead of its child, which unmounts the
 * child and aborts that child's request through the hook's own cleanup, so no
 * level ever draws a page for a read that has since moved on.
 *
 * @param props The props, as documented on {@link MetricCardsPageProps}.
 * @returns This page's loading or error state, the next level, or the tiles.
 */
function MetricCardsPage(props: MetricCardsPageProps): ReactElement {
  const { node, className, query, firstOffset, collected, knownTotal } = props;
  const { status, data, error, total, nextOffset, retry } = useQuery(query);

  if (status === 'loading') {
    // `block` is the skeleton shaped like a group of tiles rather than like a
    // list of rows or a chart canvas. A follow-up page shows the same skeleton
    // as the first: the tiles are drawn once, from the finished read, never
    // from the part of it that has arrived so far.
    return stateFrame(
      'dg-metric-cards__loading',
      className,
      <LoadingState variant="block" label={LOADING_LABEL} />,
    );
  }

  if (status === 'error') {
    // Generic copy plus the machine detail: the failure's own code and the
    // query of the page that failed, with a retry that re-requests that page
    // alone. A failure is never dressed up as a finding (AAP 0.5.5), so no part
    // of the error text is presented as data — and neither are the pages that
    // did arrive before it.
    return stateFrame(
      'dg-metric-cards__error',
      className,
      <ErrorState
        message={ERROR_MESSAGE}
        code={error?.code}
        query={describeQuery(query)}
        onRetry={retry}
      />,
    );
  }

  const read = collectPage(collected, data ?? NO_VALUES);
  const reportedTotal = total ?? knownTotal;
  const pageOffset = query.offset ?? DATA_QUERY_DEFAULT_OFFSET;

  // The four conditions of the module note, in order: the service reported a
  // further page, its counter advanced past this page, this page made progress,
  // and the tiles still need a value. A `NaN` counter fails the comparison and
  // so ends the read rather than looping on it.
  if (
    nextOffset !== undefined &&
    nextOffset > pageOffset &&
    read.contributed &&
    needsMoreValues(node, read.values)
  ) {
    // The authored filter, sort and limit are kept; only the offset changes,
    // and it changes to the service's own counter.
    return (
      <MetricCardsPage
        node={node}
        className={className}
        query={{ ...query, offset: nextOffset }}
        firstOffset={firstOffset}
        collected={read.values}
        knownTotal={reportedTotal}
      />
    );
  }

  const complete = isCompleteRead(firstOffset, nextOffset, read.values.length, reportedTotal);

  return renderRead(node, className, read.values, complete, reportedTotal);
}

/**
 * The props of {@link MetricCards}.
 *
 * Every optional prop spells `| undefined`, as everything else in this package
 * does: `exactOptionalPropertyTypes` is in force repository-wide, so a parent
 * forwarding a value it may not have has to remain legal.
 */
export interface MetricCardsProps {
  /**
   * The validated `metricCards` node to draw.
   *
   * Its `query` is resolved exactly as given for the first page, and with only
   * its `offset` advanced for any page after it. Its `metrics` option — which
   * is a node option and never a query field — chooses the tiles and their
   * order, and decides whether a further page is needed at all.
   */
  node: MetricCardsNode;

  /** Extra class names, composed after this component's own, on the root. */
  className?: string | undefined;
}

/**
 * The capture's computed values as a row of tiles.
 *
 * @param props The props, as documented on {@link MetricCardsProps}.
 * @returns The tile grid, or the loading, empty or error state of its query.
 *
 * @example A panel's headline numbers, resolved through the host's provider.
 * ```tsx
 * <MetricCards node={node} />
 * ```
 */
export function MetricCards(props: MetricCardsProps): ReactElement {
  const { node, className } = props;
  const { query } = node;

  // A node naming a source these tiles cannot draw asks the provider for
  // nothing, and its error state shows the node's own query with no retry,
  // since re-issuing it cannot change the answer. This component calls no hook
  // itself — each page level calls its own — so returning early is legal.
  if (!isMetricsQuery(query)) {
    return stateFrame(
      'dg-metric-cards__error',
      className,
      <ErrorState message={SOURCE_MISMATCH_MESSAGE} query={describeQuery(query)} />,
    );
  }

  // The first page is the node's query exactly as authored; the read starts at
  // the offset it names, or at the service's default when it names none.
  return (
    <MetricCardsPage
      node={node}
      className={className}
      query={query}
      firstOffset={query.offset ?? DATA_QUERY_DEFAULT_OFFSET}
      collected={NO_VALUES}
      knownTotal={undefined}
    />
  );
}
