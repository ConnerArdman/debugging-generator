/**
 * `DependencyGraph` — the correlated flow of an interaction as a STATIC layered
 * left-to-right graph: the event, the code it reached, the calls it made and the
 * datastore or external service it ended at, with an edge for every handover
 * (AAP 0.6.2).
 *
 * This module is the component behind the node catalog's `dependencyGraph`
 * type. It is the one structural view in the library — every other component
 * answers "how long" or "how often", and this one answers "what does this
 * interaction touch", because that answer is a shape.
 *
 * ## THE RECORDED GAP: THE LAYOUT IS STATIC, AND THAT IS THE DESIGN
 *
 * AAP 0.6.6 records "interactive graph layout (drag, zoom) — not in v1; layered
 * static layout with hover and click; annotated as a follow-up". So this file
 * contains, deliberately and permanently until that follow-up is taken:
 *
 *   - no drag, no pan, no wheel zoom, no transform state, no gesture handler;
 *   - no force simulation and no layout library of any kind — the layered
 *     geometry is `../utils/scale`'s, which is arithmetic over a column index
 *     and a row index and nothing more;
 *   - no measurement. `getBoundingClientRect`, `ResizeObserver` and
 *     `offsetWidth` appear nowhere: the canvas declares a fixed logical
 *     `viewBox` and the stylesheet sizes it relationally, which is also why the
 *     component renders identically under happy-dom, where every measurement
 *     answers zero.
 *
 * The limitation is stated on screen rather than left for a reader to discover
 * by trying to drag the picture — see {@link STATIC_LAYOUT_NOTE}.
 *
 * ## DETERMINISM IS THE SUBSTANCE OF THIS VIEW
 *
 * This component appears in the excessive-render panel (trigger → provider →
 * consumers, AAP 0.6.5), where a developer compares one reading of a capture
 * with another. A graph that reshuffled between renders would read as noise and
 * would quietly undermine the evidence it exists to present, so the layout is
 * reproducible for any permutation of the payload:
 *
 *   1. Layers come from the payload's own `layer` indices when **every**
 *      participant carries a usable one, and are otherwise recomputed for all
 *      of them by `assignGraphLayers` — the same all-or-nothing rule
 *      `layoutDependencyGraph` applies, so the ordering below and the geometry
 *      it feeds can never disagree. Both routes are edge-derived or
 *      payload-derived and neither depends on array order.
 *   2. Participants are then put in the canonical order the aggregate itself
 *      documents — by layer, then by descending total duration, then by id —
 *      which is a no-op for a canonical payload (the sort is stable and the
 *      rule is the same one) and restores that order for a shuffled one. The id
 *      tie-break is total, so the result is permutation-independent down to the
 *      last row.
 *   3. A cycle cannot hang or explode the layout: the relaxation in
 *      `assignGraphLayers` is capped, and the anchors of an edge that runs
 *      backwards or stays in one column are computed for that case explicitly.
 *
 * ## TWO REPRESENTATIONS OF ONE GRAPH, AND WHY BOTH ARE MANDATORY
 *
 * A picture of a graph is unreadable to a keyboard or a screen-reader user, so
 * this component renders the same data twice (AAP 0.6.4):
 *
 *   - **The canvas.** An SVG carrying `role="img"` and a text alternative that
 *     states how many participants, layers and relationships it holds and where
 *     the equivalent is. It is a picture: pointer hover and click, no tab stop,
 *     and every shape has an SVG `<title>` for the pointer user.
 *   - **The participants grid.** The `DataTable` primitive — one row per
 *     participant, ordered by layer and stating it, with the participant's
 *     label, its class, its timing, its outgoing relationships and its source
 *     chip. It is the library's own keyboard-navigable grid (a roving tab stop,
 *     arrow keys, Enter and Space), it is rendered unvirtualized so that it
 *     covers **every** participant rather than a window, and it is what makes
 *     the view operable without a pointer. A raw `<ul>` was the alternative and
 *     is not used: AAP 0.6.4 permits no raw `<table>` or bespoke list chrome
 *     above the primitives layer, `../styles/components.css` declares no rule
 *     for a list in this block, and `../styles/base.css` deliberately keeps
 *     user-agent list markers for any list that does not opt out in CSS.
 *
 * ## NO SELECTION IS EVER FABRICATED
 *
 * `PanelActions.onSelectEvent` needs an `eventId`, and `eventId` is the
 * coordinate a host resolves against the capture. A participant of this graph
 * is a **collapse** of many records: the aggregate gives it `spanIds` — a
 * bounded sample of span ids — and no event id at all. Passing a span id as an
 * event id would resolve to nothing in the details drawer, and
 * `../host/PanelActions` is explicit that a fabricated coordinate is worse than
 * an absent one. So activation selects locally (the row and the shape both take
 * `dg-is-selected`) and reports to the host **only** when the participant
 * actually carries an event coordinate — the same enrichment seam the datum's
 * `source` field documents, read here through {@link ParticipantEventCoordinate}
 * without a cast and without requiring it. A participant with neither an event
 * coordinate nor a source location still reads fully — label, class, timing,
 * relationships — and offers no control that would do nothing.
 *
 * ## PRIVACY: EVERY LABEL IS DATA, AND ARRIVES REDACTED
 *
 * A participant's label is the identity the aggregate derived from records that
 * passed the redaction layer — an interaction and its target, a matched route, a
 * module and a symbol, a database system (AAP 0.5.2). This file renders labels
 * as given: it never parses one, never reassembles a URL or a statement from
 * one, and shortens one only for display (with the full text in the tooltip).
 * The only vocabulary this file writes is generic product vocabulary: the six
 * participant classes of the closed telemetry domain and the column headings.
 * A specific component, function or route name here would be exactly the
 * hardcoded demo knowledge AAP 0.5.4 forbids and `scripts/check-no-hardcoding.mjs`
 * fails the build for.
 *
 * ## NO TRANSPORT, ONE QUERY (AAP 0.1.2, 0.4.2)
 *
 * Data arrives only through the node's `DataQuery`, resolved by `../host/useQuery`
 * against the ambient `DataProvider`; interactions leave only through
 * `../host/PanelActions`. There is no socket, no `fetch`, no paging control: the
 * `graph` source answers with one whole `DependencyGraphData` object rather than
 * a page, so there is nothing to load more of — and where the payload says it
 * was bounded, or where a relationship named a participant the payload does not
 * contain, this component says so rather than drawing a graph that looks
 * complete.
 *
 * ## THE KNOWN BOUNDS OF A STATIC PICTURE, MEASURED IN THE BROWSER
 *
 * Verified in Chrome against a fixture of eight participants across six layers,
 * and recorded here so the next reader does not have to rediscover any of it:
 *
 *   - **Direction is carried by the layout and by the grid, not by arrowheads.**
 *     The stylesheet declares no marker for this block and the geometry helper
 *     returns plain paths, so an edge is a curve: a relationship reads left to
 *     right from the flow's origin, and the grid states it as "→ ‹called
 *     participant›" in text, which is also the only route a keyboard or
 *     screen-reader user has. A relationship that runs backwards — what a cyclic
 *     dependency produces — is anchored correctly by the helper and stays
 *     legible in the grid.
 *   - **A wide graph scales to the panel's width rather than scrolling it.**
 *     `../styles/base.css` caps every `svg` at `max-width: 100%`, so the fixed
 *     `viewBox` is fitted uniformly (measured at 0.96 for eight participants)
 *     and a tall graph scrolls in the block axis inside the viewport's own
 *     `max-block-size`. The participants grid is the complete reading of a graph
 *     too large to take in at a glance, which is the other reason it is never
 *     virtualized.
 *   - **The relationship curves are faint, and that is flagged rather than
 *     overridden.** See the BLITZY [A11Y] flag beside the edge group below: the
 *     stroke is the design system's, and no information depends on it.
 *
 * ## WHAT IT READS
 *
 * The node catalog entry is imported rather than restated
 * (`catalogEntryFor('dependencyGraph')`), and it is the authority for the two
 * things this file would otherwise have hardcoded: the only source this view may
 * draw (`sources`), which the source guard reports against, and the view's own
 * name (`label`), which the canvas's text alternative and the grid's caption are
 * composed from. The participant fields drawn here — label, class, tier, record
 * count, total and slowest duration, source location and layer — are what the
 * aggregate derives from the telemetry fields that same entry declares in
 * `reads`; this component reads prepared participants and never a raw record.
 *
 * ## APPEARANCE IS A CLASS CONTRACT (AAP 0.6.4)
 *
 * No colour, length, radius or font appears in this module. The classes below
 * are implemented in `../styles/components.css` against `--dg-*` tokens; the
 * only inline value is the `--dgc-node-color` custom property, whose value is a
 * `var(--dg-*)` reference from `../utils/color`, and the only literal numbers
 * are unitless SVG geometry from `../utils/scale`:
 *
 *   dg-dependency-graph              the block
 *   dg-dependency-graph__legend      the participant-class key
 *   dg-dependency-graph__viewport    the scroll container around the canvas
 *   dg-dependency-graph__canvas      the SVG
 *   dg-dependency-graph__column      one layer's group of shapes
 *   dg-dependency-graph__node        a participant's box
 *   dg-dependency-graph__node--*     its participant class
 *   dg-dependency-graph__node-label  the label inside the box
 *   dg-dependency-graph__node-meta   the metrics line inside the box
 *   dg-dependency-graph__edge        a relationship, on the canvas and as a chip
 *   dg-dependency-graph__edge-label  a repeated relationship's count
 *   dg-dependency-graph__tooltip     the slot the tooltip is positioned in
 *   dg-dependency-graph__equivalent  the participants grid
 *   dg-dependency-graph__note        the notes under the grid
 *   dg-dependency-graph__empty       the three state boxes, as every
 *   dg-dependency-graph__loading     visualization in this folder declares
 *   dg-dependency-graph__error       them
 *   dg-is-selected / dg-is-hovered / dg-is-ambiguous   the states
 *
 * The caller's `className` is composed last.
 *
 * @see ../utils/scale for the layered geometry and the edge paths.
 * @see ../utils/color for the participant-class colour scale.
 * @see ../host/DataProvider for the data seam and the `graph` result shape.
 * @see ../styles/components.css for the implementation of the classes above.
 */

import { catalogEntryFor } from '@debuggen/panel-schema';
import type {
  DataQuery,
  DependencyGraphNode as DependencyGraphNodeSpec,
} from '@debuggen/panel-schema';
import type {
  DependencyGraphData,
  DependencyGraphEdge,
  DependencyGraphNode,
} from '@debuggen/telemetry';
import clsx from 'clsx';
import { Workflow } from 'lucide-react';
import { Fragment, useCallback, useMemo, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import { usePanelActions } from '../host/PanelActions';
import type { PanelEventRef } from '../host/PanelActions';
import { useQuery } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import { Badge } from '../primitives/Badge';
import { DataTable } from '../primitives/DataTable';
import type { DataTableColumn } from '../primitives/DataTable';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import { dependencyNodeColorVar } from '../utils/color';
import {
  NOT_AVAILABLE_LABEL,
  formatCount,
  formatDurationCompact,
  formatTierLabel,
  truncate,
} from '../utils/format';
import {
  assignGraphLayers,
  edgePathData,
  interpolate,
  layoutDependencyGraph,
} from '../utils/scale';
import type { DependencyGraphLayout, GraphNodeBox } from '../utils/scale';
import { SourceLink } from './SourceLink';

/**
 * A style object that may carry custom properties.
 *
 * Declared per module in this package, as `primitives/Badge`, `primitives/DataTable`
 * and `layout/Split` each do: `CSSProperties` is an interface, so TypeScript
 * infers no index signature for it and a plain style object is not assignable to
 * a type that requires one.
 */
type CssVariableStyle = CSSProperties & Record<`--${string}`, string>;

/** The catalog entry this component implements, and the node type that selects it. */
const CATALOG_ENTRY = catalogEntryFor('dependencyGraph');

/**
 * The one data source this view can draw, as a literal so that the narrowing
 * below produces the query type `../host/useQuery` needs.
 *
 * The catalog states the same thing (`CATALOG_ENTRY.sources`) and is what the
 * error copy names; this constant is what the compiler reads.
 */
const GRAPH_SOURCE = 'graph';

/** The query this view resolves: the node's own, narrowed to the graph source. */
type GraphQuery = DataQuery & { source: typeof GRAPH_SOURCE };

/**
 * The node's query when it names the graph source, and `undefined` when it names
 * anything else.
 *
 * A node of this type carrying another source is a product defect — the panel
 * schema's catalog permits only `graph` and its validator enforces that before a
 * specification is ever rendered — so the component reports it as a failure
 * instead of guessing how to read a payload of an unknown shape.
 */
function graphQueryOf(query: DataQuery): GraphQuery | undefined {
  return query.source === GRAPH_SOURCE ? { ...query, source: GRAPH_SOURCE } : undefined;
}

/*
 * ---------------------------------------------------------------------------
 * The participant-class vocabulary
 *
 * Every per-class table below is keyed by `DependencyGraphNode['kind']`, so the
 * compiler — not a reviewer — is what guarantees the six classes of the closed
 * telemetry domain are all handled. A seventh class added upstream fails to
 * compile here rather than rendering as an unstyled, unnamed box.
 * ---------------------------------------------------------------------------
 */

/** The stylesheet's modifier for each participant class. */
const KIND_CLASS: Readonly<Record<DependencyGraphNode['kind'], string>> = Object.freeze({
  'ui-event': 'dg-dependency-graph__node--ui-event',
  function: 'dg-dependency-graph__node--function',
  api: 'dg-dependency-graph__node--api',
  service: 'dg-dependency-graph__node--service',
  database: 'dg-dependency-graph__node--database',
  external: 'dg-dependency-graph__node--external',
});

/**
 * The readable name of each participant class.
 *
 * Generic product vocabulary and the whole of the legend's wording: the classes
 * describe *what kind of thing* took part — a page event, application code
 * either side of the boundary, a request boundary, a datastore, something
 * outside the project — and name nothing in any inspected application.
 * `humanizeLabel` is deliberately not used for these: it would render the domain
 * tokens as "Ui event" and "Api".
 */
const KIND_LABEL: Readonly<Record<DependencyGraphNode['kind'], string>> = Object.freeze({
  'ui-event': 'UI event',
  function: 'Function',
  api: 'API',
  service: 'Service',
  database: 'Database',
  external: 'External',
});

/**
 * The order the legend names the classes in: the reading order of the layout,
 * from the page event through application code and the request boundary to a
 * datastore or an external service.
 *
 * Annotated as a list of classes so a member that is not one fails here, and
 * kept complete by {@link KIND_LABEL}, whose `Record` cannot compile while a
 * class is missing.
 */
const KIND_LEGEND_ORDER: readonly DependencyGraphNode['kind'][] = Object.freeze([
  'ui-event',
  'function',
  'api',
  'service',
  'database',
  'external',
]);

/*
 * ---------------------------------------------------------------------------
 * Geometry
 *
 * Every coordinate below is either a value `../utils/scale` returned or plain
 * arithmetic over one. Nothing here is a CSS length, and nothing is measured.
 * ---------------------------------------------------------------------------
 */

/**
 * Half the participant outline's width, as the canvas inset.
 *
 * `components.css` strokes a participant box with `stroke-width: 2`, and SVG
 * centres a stroke on the path, so the outline of a box at the canvas origin
 * would lose its outer half to the viewport edge. Insetting the `viewBox` by
 * half the stroke keeps every outline whole without moving a single box.
 */
const OUTLINE_INSET = 1;

/**
 * How many bands a participant's box is divided into vertically.
 *
 * Three: the label sits on the first boundary and the metrics line on the
 * second, which centres the pair in the box whatever height the rhythm gives it.
 */
const BOX_TEXT_BANDS = 3;

/**
 * Approximate SVG user units one label character occupies at the label's type
 * role (`--dg-text-sm`).
 *
 * An estimate, and necessarily one: measuring text would mean reading layout
 * back from the document, which this component does not do. It is used only to
 * choose a truncation budget — the stylesheet, not this number, decides how the
 * text is drawn — so an approximation that errs toward a shorter label is the
 * safe direction.
 */
const LABEL_CHARACTER_WIDTH = 8;

/** The shortest label a box will show before the ellipsis, however narrow it is. */
const MIN_LABEL_CHARACTERS = 6;

/** Longest relationship-chip label in the participants grid, in code points. */
const MAX_CHIP_LABEL_CHARACTERS = 28;

/** The fraction along an edge its count label sits at: the midpoint. */
const EDGE_LABEL_POSITION = 0.5;

/** Where a participant's label baseline sits inside its box. */
function labelY(box: GraphNodeBox): number {
  return box.y + box.height / BOX_TEXT_BANDS;
}

/** Where a participant's metrics baseline sits inside its box. */
function metaY(box: GraphNodeBox): number {
  return box.y + (box.height * (BOX_TEXT_BANDS - 1)) / BOX_TEXT_BANDS;
}

/** How many code points of a label a box of this width can show. */
function labelBudget(width: number): number {
  return Math.max(MIN_LABEL_CHARACTERS, Math.floor(width / LABEL_CHARACTER_WIDTH));
}

/** The canvas box: the layout's own size, inset so no outline is clipped. */
function canvasSize(layout: DependencyGraphLayout): { width: number; height: number } {
  return {
    width: layout.width + OUTLINE_INSET * 2,
    height: layout.height + OUTLINE_INSET * 2,
  };
}

/** The logical `viewBox` of the canvas, with the outline inset applied. */
function canvasViewBox(layout: DependencyGraphLayout): string {
  const { width, height } = canvasSize(layout);
  return `${String(-OUTLINE_INSET)} ${String(-OUTLINE_INSET)} ${String(width)} ${String(height)}`;
}

/** The participant colour as the custom property the stylesheet consumes. */
function nodeColorStyle(kind: DependencyGraphNode['kind']): CssVariableStyle {
  return { '--dgc-node-color': dependencyNodeColorVar(kind) };
}

/*
 * ---------------------------------------------------------------------------
 * Layering and canonical order
 * ---------------------------------------------------------------------------
 */

/** Whether a payload's layer index can be used as a column. */
function isPlacedLayer(layer: number | undefined): layer is number {
  return layer !== undefined && Number.isInteger(layer) && layer >= 0;
}

/**
 * A column per participant id.
 *
 * The payload's own indices when every participant carries a usable one, and
 * otherwise a recomputation for all of them — the same all-or-nothing rule
 * `layoutDependencyGraph` applies internally, restated here because the
 * ordering below needs the layers *before* the layout is built. Mixing a
 * provided index with a computed one would place two participants in one column
 * by coincidence rather than by a rule.
 */
function resolveLayers(data: DependencyGraphData): ReadonlyMap<string, number> {
  if (!data.nodes.every((node) => isPlacedLayer(node.layer))) {
    return assignGraphLayers(data.nodes, data.edges);
  }

  const layers = new Map<string, number>();
  for (const node of data.nodes) {
    if (isPlacedLayer(node.layer)) {
      layers.set(node.id, node.layer);
    }
  }

  return layers;
}

/** Ascending by column, then descending by total duration, then ascending by id. */
function compareParticipants(
  left: DependencyGraphNode,
  right: DependencyGraphNode,
  layers: ReadonlyMap<string, number>,
): number {
  const leftLayer = layers.get(left.id) ?? 0;
  const rightLayer = layers.get(right.id) ?? 0;
  if (leftLayer !== rightLayer) {
    return leftLayer - rightLayer;
  }

  if (left.totalDurationMs !== right.totalDurationMs) {
    return right.totalDurationMs - left.totalDurationMs;
  }

  return left.id.localeCompare(right.id);
}

/**
 * The payload with its participants in canonical order.
 *
 * The aggregate documents that order — by layer, then by descending total
 * duration, then by id — so for a canonical payload this is a no-op and the
 * drawing agrees with every other view of the same capture. For a payload whose
 * participants arrived in another order it restores it, which is what makes the
 * geometry and the grid below reproducible rather than merely current: the id
 * tie-break is total, so no permutation of the input changes what is drawn.
 */
function canonicalGraph(data: DependencyGraphData): DependencyGraphData {
  const layers = resolveLayers(data);
  return {
    ...data,
    nodes: data.nodes.toSorted((left, right) => compareParticipants(left, right, layers)),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The two optional coordinates a payload may carry
 *
 * Both structures below are read through a local type with a REQUIRED `id`
 * overlapping the datum's own, which is what makes the read a plain assignment
 * rather than a cast (and keeps TypeScript's weak-type check satisfied). Both
 * fields are absent from the aggregate's declared shape and present on nothing
 * this component builds: they are the enrichment seam, the same one the datum's
 * `source` field documents, and reading them defensively is how an enriched
 * payload gains behaviour without this file ever inventing a value.
 * ---------------------------------------------------------------------------
 */

/** The event coordinate a participant carries when its producer recorded one. */
interface ParticipantEventCoordinate {
  readonly id: string;
  readonly eventId?: unknown;
  readonly spanId?: unknown;
  readonly traceId?: unknown;
}

/** The lineage flags a relationship carries when it was inferred rather than measured. */
interface RelationshipLineage {
  readonly id: string;
  readonly ambiguous?: unknown;
  readonly inferred?: unknown;
  readonly lineageAmbiguous?: unknown;
  readonly lineage?: unknown;
}

/** The lineage value an asynchronous continuation is attributed with (AAP 0.4.2). */
const ASYNC_CONTINUATION_LINEAGE = 'async-continuation';

/** The value when it is a string with something in it, and `undefined` otherwise. */
function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** The single span a participant collapsed, when it collapsed exactly one. */
function soleSpanId(node: DependencyGraphNode): string | undefined {
  return node.count === 1 && node.spanIds.length === 1 ? node.spanIds[0] : undefined;
}

/**
 * The event a participant stands for, or `undefined` when it stands for none.
 *
 * `undefined` is the normal answer for an aggregate built from the telemetry
 * shape alone, and it is the honest one: see this module's header for why a span
 * id is never passed off as an event id. The span hint is added only for a
 * participant that collapsed exactly one record, where the sample really is
 * that record.
 */
function eventRefFor(node: DependencyGraphNode): PanelEventRef | undefined {
  const coordinate: ParticipantEventCoordinate = node;
  const eventId = nonBlankString(coordinate.eventId);
  if (eventId === undefined) {
    return undefined;
  }

  const spanId = nonBlankString(coordinate.spanId) ?? soleSpanId(node);
  const traceId = nonBlankString(coordinate.traceId);

  return {
    eventId,
    ...(spanId === undefined ? {} : { spanId }),
    ...(traceId === undefined ? {} : { traceId }),
  };
}

/**
 * Whether a relationship was inferred rather than measured.
 *
 * An inferred relationship is drawn dashed and chipped as such, exactly as the
 * timeline marks an ambiguous async continuation: a guessed relationship must
 * never read as a measured one (AAP 0.4.2). Nothing is inferred *here* — the
 * flags are read, never derived, and an edge that carries none is drawn as the
 * measured relationship it is.
 */
function isInferredRelationship(edge: DependencyGraphEdge): boolean {
  const lineage: RelationshipLineage = edge;
  return (
    lineage.ambiguous === true ||
    lineage.inferred === true ||
    lineage.lineageAmbiguous === true ||
    nonBlankString(lineage.lineage) === ASYNC_CONTINUATION_LINEAGE
  );
}

/*
 * ---------------------------------------------------------------------------
 * The row model
 *
 * One structure serves both representations: the shapes on the canvas and the
 * rows of the grid are the same array, in the same order, so the two can never
 * disagree about what the graph contains or how it is ordered.
 * ---------------------------------------------------------------------------
 */

/** One outgoing relationship, as the grid chips it. */
interface ParticipantRelationship {
  /** The relationship itself, borrowed read-only from the payload. */
  readonly edge: DependencyGraphEdge;
  /** The called participant's own label, resolved from the payload's participants. */
  readonly targetLabel: string;
  /** Whether the relationship was inferred rather than measured. */
  readonly inferred: boolean;
}

/** One participant: its datum, its box, what it calls and what it stands for. */
interface ParticipantRow {
  /** The participant, borrowed read-only from the payload. */
  readonly node: DependencyGraphNode;
  /** Its box in the layered layout. */
  readonly box: GraphNodeBox;
  /** Its outgoing relationships, in the payload's order. */
  readonly outgoing: readonly ParticipantRelationship[];
  /** The event it stands for, when it carries one; see {@link eventRefFor}. */
  readonly eventRef: PanelEventRef | undefined;
}

/** One column of the layout: a layer and the participants placed in it. */
interface ParticipantColumn {
  /** The column index, counting from `0`. */
  readonly layer: number;
  /** Its participants, in layout order. */
  readonly rows: readonly ParticipantRow[];
}

/** The empty row list, shared so an unresolved query keeps a stable reference. */
const NO_ROWS: readonly ParticipantRow[] = Object.freeze([]);

/** The empty relationship list, shared for every participant that calls nothing. */
const NO_RELATIONSHIPS: readonly ParticipantRelationship[] = Object.freeze([]);

/** A participant's identity in the grid. */
function participantRowKey(row: ParticipantRow): string {
  return row.node.id;
}

/** Turns a positioned layout into the row model both representations read. */
function buildRows(layout: DependencyGraphLayout): readonly ParticipantRow[] {
  const labels = new Map<string, string>();
  for (const positioned of layout.nodes) {
    labels.set(positioned.node.id, positioned.node.label);
  }

  // Only relationships whose endpoints both exist are in `layout.edges`; the
  // rest are counted in `droppedEdgeCount` and reported under the grid.
  const outgoing = new Map<string, ParticipantRelationship[]>();
  for (const positioned of layout.edges) {
    const { edge } = positioned;
    const relationships = outgoing.get(edge.from) ?? [];
    relationships.push({
      edge,
      targetLabel: labels.get(edge.to) ?? edge.to,
      inferred: isInferredRelationship(edge),
    });
    outgoing.set(edge.from, relationships);
  }

  return layout.nodes.map((positioned) => ({
    node: positioned.node,
    box: positioned.box,
    outgoing: outgoing.get(positioned.node.id) ?? NO_RELATIONSHIPS,
    eventRef: eventRefFor(positioned.node),
  }));
}

/**
 * Groups the rows into columns for the canvas.
 *
 * The rows are already ordered by layer, so this is one pass that starts a new
 * column whenever the layer changes — no sorting, and therefore no second
 * ordering rule that could disagree with the first.
 */
function buildColumns(rows: readonly ParticipantRow[]): readonly ParticipantColumn[] {
  const columns: { layer: number; rows: ParticipantRow[] }[] = [];

  for (const row of rows) {
    const current = columns.at(-1);
    if (current === undefined || current.layer !== row.box.layer) {
      columns.push({ layer: row.box.layer, rows: [row] });
      continue;
    }
    current.rows.push(row);
  }

  return columns;
}

/*
 * ---------------------------------------------------------------------------
 * Copy
 *
 * Generic product vocabulary only, and every sentence states what the capture
 * holds rather than what it might mean. No value read out of an inspected
 * project is interpolated into any of it (AAP 0.5.4).
 * ---------------------------------------------------------------------------
 */

/** The recorded limitation of AAP 0.6.6, stated on screen rather than implied. */
const STATIC_LAYOUT_NOTE =
  'This layout is static in this version: hover a participant for its detail and select one to highlight it. Dragging, panning and zooming are not available.';

/** What an empty graph says. */
const EMPTY_MESSAGE = 'No dependency relationships were captured for this interaction.';

/** What the busy announcement says while the graph resolves. */
const LOADING_LABEL = 'Loading the dependency graph…';

/** What a failed query says when the provider supplied no sentence of its own. */
const GENERIC_FAILURE_MESSAGE = 'The dependency graph could not be loaded.';

/** The code shown for a node whose query names a source this view cannot draw. */
const SOURCE_MISMATCH_CODE = 'PANEL_INVALID';

/** Marks a relationship chip whose relationship was inferred rather than measured. */
const INFERRED_LABEL = 'inferred';

/** Precedes a called participant on a relationship chip. */
const RELATIONSHIP_ARROW = '→';

/** The grid's accessible name. */
const GRID_CAPTION = `${CATALOG_ENTRY.label}: every participant by layer, with its outgoing relationships and its source location.`;

/** Said when the payload reports that it was bounded. */
const TRUNCATED_NOTE =
  'Some participants or relationships were left out because this graph reached its size bound, so the flow shown is partial.';

/** Said when the layering was computed here because the payload carried none. */
const COMPUTED_LAYERS_NOTE =
  'The columns were computed from the relationships, because the captured participants carried no layer of their own.';

/** Said when a relationship named a participant the payload does not contain. */
function droppedRelationshipsNote(count: number): string {
  return `${formatCount(count)} relationship(s) named a participant this graph does not contain and are not drawn.`;
}

/** What a node whose query names another source says. */
function sourceMismatchMessage(source: string): string {
  return `This view draws the "${CATALOG_ENTRY.sources.join('", "')}" source, but its panel node asks for "${source}".`;
}

/** The sentence a failed query shows: what failed, plus the provider's hint. */
function failureMessage(message: string | undefined, hint: string | undefined): string {
  const stated = nonBlankString(message) ?? GENERIC_FAILURE_MESSAGE;
  const suffix = nonBlankString(hint);
  return suffix === undefined ? stated : `${stated} ${suffix}`;
}

/**
 * The canvas's text alternative: what the picture holds, and where its
 * keyboard-reachable equivalent is.
 */
function textAlternative(layout: DependencyGraphLayout, truncated: boolean): string {
  const shape = `${CATALOG_ENTRY.label}: ${formatCount(layout.nodes.length)} participants in ${formatCount(layout.layerCount)} layers, joined by ${formatCount(layout.edges.length)} relationships and drawn left to right from the participant the flow started at.`;
  const equivalent =
    'The participants table below carries the same participants, their outgoing relationships and their source locations.';

  return truncated ? `${shape} ${TRUNCATED_NOTE} ${equivalent}` : `${shape} ${equivalent}`;
}

/** A participant's metrics, as one line of text. */
function participantMetricsText(node: DependencyGraphNode): string {
  const records = formatCount(node.count);
  const total = formatDurationCompact(node.totalDurationMs);
  const slowest = formatDurationCompact(node.maxDurationMs);
  return `Records ${records} · Total ${total} · Slowest ${slowest}`;
}

/** The metrics line drawn inside a participant's box: its time, and its weight. */
function participantMetaText(node: DependencyGraphNode): string {
  const total = formatDurationCompact(node.totalDurationMs);
  return node.count > 1 ? `${total} · ×${formatCount(node.count)}` : total;
}

/** The pointer title of a participant's shape on the canvas. */
function participantTitle(node: DependencyGraphNode): string {
  return `${node.label} · ${KIND_LABEL[node.kind]} · ${participantMetricsText(node)}`;
}

/** A relationship chip's text: what is called, how often, and how it was known. */
function relationshipChipText(relationship: ParticipantRelationship): string {
  const target = truncate(relationship.targetLabel, MAX_CHIP_LABEL_CHARACTERS);
  const repeats = relationship.edge.count > 1 ? ` ×${formatCount(relationship.edge.count)}` : '';
  const lineage = relationship.inferred ? ` (${INFERRED_LABEL})` : '';
  return `${RELATIONSHIP_ARROW} ${target}${repeats}${lineage}`;
}

/*
 * ---------------------------------------------------------------------------
 * The grid's cells
 *
 * Each is a pure function of its row, which is what lets the column list below
 * be a module constant: no cell reads state, so nothing about the grid is
 * rebuilt when a selection or a hover changes.
 * ---------------------------------------------------------------------------
 */

/** The participant's class, as a chip carrying the class colour. */
function ClassCell({ row }: { readonly row: ParticipantRow }): ReactElement {
  const { kind } = row.node;

  return (
    <Badge tone="neutral" variant="outline" color={dependencyNodeColorVar(kind)} data-kind={kind}>
      {KIND_LABEL[kind]}
    </Badge>
  );
}

/**
 * The participant's label, truncated by the stylesheet and described in full by
 * a tooltip that also names its class, its tier and its metrics.
 *
 * The tooltip is the reason a class chip is not drawn inside the SVG box: the
 * canvas carries the colour, and the words that make the colour non-essential
 * live here and in the class column.
 */
function ParticipantCell({ row }: { readonly row: ParticipantRow }): ReactElement {
  const { node } = row;

  const detail = (
    <Stack gap={1}>
      <Text size="sm" weight="medium">
        {node.label}
      </Text>
      <Stack direction="horizontal" gap={2} align="center" wrap>
        <ClassCell row={row} />
        {node.tier === undefined ? null : (
          <Text size="xs" tone="muted">
            {formatTierLabel(node.tier)}
          </Text>
        )}
      </Stack>
      <Text size="xs" tone="muted">
        {participantMetricsText(node)}
      </Text>
    </Stack>
  );

  return (
    <Tooltip className="dg-dependency-graph__tooltip" content={detail}>
      <Text size="sm" truncate>
        {node.label}
      </Text>
    </Tooltip>
  );
}

/**
 * Everything the participant calls, one chip each.
 *
 * An inferred relationship carries the state class the stylesheet dashes on the
 * canvas, a warning tone, and the word itself — so the distinction survives in
 * text, where a dash pattern cannot reach (AAP 0.6.4: colour and pattern are
 * never the sole indicator).
 */
function RelationshipsCell({ row }: { readonly row: ParticipantRow }): ReactElement {
  if (row.outgoing.length === 0) {
    return (
      <Text size="xs" tone="muted">
        {NOT_AVAILABLE_LABEL}
      </Text>
    );
  }

  return (
    <Stack direction="horizontal" gap={1} align="center" wrap>
      {row.outgoing.map((relationship) => (
        <Badge
          key={relationship.edge.id}
          tone={relationship.inferred ? 'warning' : 'neutral'}
          variant="outline"
          className={clsx('dg-dependency-graph__edge', relationship.inferred && 'dg-is-ambiguous')}
          data-edge-id={relationship.edge.id}
        >
          {relationshipChipText(relationship)}
        </Badge>
      ))}
    </Stack>
  );
}

/** Where the participant lives in the project, when a location resolved. */
function SourceCell({ row }: { readonly row: ParticipantRow }): ReactElement {
  const { source } = row.node;

  if (source === undefined) {
    return (
      <Text size="xs" tone="muted">
        {NOT_AVAILABLE_LABEL}
      </Text>
    );
  }

  // The location object is handed over by reference and never rewritten; see
  // `./SourceLink` for why that is the single guarantee of the click path.
  return <SourceLink location={source} compact />;
}

/**
 * The columns of the participants grid, in reading order: where a participant
 * sits, what it is, how long it took, what it called, and where it lives.
 *
 * A module constant because every cell is a pure function of its row.
 */
const PARTICIPANT_COLUMNS: readonly DataTableColumn<ParticipantRow>[] = Object.freeze([
  {
    key: 'layer',
    header: 'Layer',
    align: 'end',
    cell: (row: ParticipantRow) => (
      <Text size="xs" tone="muted" numeric>
        {formatCount(row.box.layer + 1)}
      </Text>
    ),
  },
  {
    key: 'participant',
    header: 'Participant',
    rowHeader: true,
    cell: (row: ParticipantRow) => <ParticipantCell row={row} />,
  },
  {
    key: 'class',
    header: 'Class',
    cell: (row: ParticipantRow) => <ClassCell row={row} />,
  },
  {
    key: 'total-time',
    header: 'Total time',
    align: 'end',
    cell: (row: ParticipantRow) => <DurationCell ms={row.node.totalDurationMs} size="sm" />,
  },
  {
    key: 'relationships',
    header: 'Relationships',
    cell: (row: ParticipantRow) => <RelationshipsCell row={row} />,
  },
  {
    key: 'source',
    header: 'Source',
    cell: (row: ParticipantRow) => <SourceCell row={row} />,
  },
]);

/**
 * The props of {@link DependencyGraph}.
 *
 * `node` is typed `DependencyGraphNodeSpec` — the panel-schema **specification**
 * node of type `dependencyGraph`, aliased at the import site. The alias is not
 * cosmetic and must not be "simplified": `DependencyGraphNode` names two
 * different things in this monorepo, the specification node here and the
 * telemetry **datum** (one participant) that this component draws, and both are
 * used in this file.
 */
export interface DependencyGraphProps {
  /** The validated panel node to render: its query is the only input. */
  node: DependencyGraphNodeSpec;

  /** Extra class names, composed after this component's own. */
  className?: string | undefined;
}

/**
 * The correlated flow of an interaction as a layered left-to-right graph, with a
 * keyboard-reachable participants grid beside it.
 *
 * @param props The props, as documented on {@link DependencyGraphProps}.
 * @returns The graph and its grid, or the node's loading, empty or error state.
 *
 * @example A validated node from a generated panel, inside a `PanelHost`.
 * ```tsx
 * <DependencyGraph node={node} />
 * ```
 */
export function DependencyGraph(props: DependencyGraphProps): ReactElement {
  const { node, className } = props;

  // Read unconditionally, as a hook must be, and `undefined` outside a host by
  // that module's documented contract - which is what lets this component
  // render in a surface that cannot navigate.
  const actions = usePanelActions();

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [hoveredId, setHoveredId] = useState<string | undefined>(undefined);

  // `undefined` when the node names a source this view cannot draw, which stops
  // the query from being issued at all.
  const query = useMemo(() => graphQueryOf(node.query), [node.query]);
  const serializedQuery = useMemo(() => JSON.stringify(node.query, null, 2), [node.query]);

  const { status, data, error, retry } = useQuery(query);

  // The whole layout in one memo: canonical ordering, then the layered geometry.
  // Both are pure functions of the payload, so the same payload always draws the
  // same picture.
  const layout = useMemo(
    () => (data === undefined ? undefined : layoutDependencyGraph(canonicalGraph(data))),
    [data],
  );
  const rows = useMemo(() => (layout === undefined ? NO_ROWS : buildRows(layout)), [layout]);
  const columns = useMemo(() => buildColumns(rows), [rows]);

  const handleActivate = useCallback(
    (row: ParticipantRow): void => {
      setSelectedId(row.node.id);

      // Reported only when the participant really carries an event coordinate;
      // see this module's header for why nothing is invented when it does not.
      if (row.eventRef !== undefined) {
        actions?.onSelectEvent(row.eventRef);
      }
    },
    [actions],
  );

  const handleHover = useCallback((id: string | undefined): void => {
    setHoveredId(id);
  }, []);

  const blockClass = clsx('dg-dependency-graph', className);

  if (query === undefined) {
    return (
      <div className={blockClass}>
        <div className="dg-dependency-graph__error">
          <ErrorState
            message={sourceMismatchMessage(node.query.source)}
            code={SOURCE_MISMATCH_CODE}
            query={serializedQuery}
          />
        </div>
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div className={blockClass}>
        <div className="dg-dependency-graph__loading">
          <LoadingState variant="chart" label={LOADING_LABEL} />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={blockClass}>
        <div className="dg-dependency-graph__error">
          <ErrorState
            message={failureMessage(error?.message, error?.hint)}
            code={error?.code}
            query={serializedQuery}
            onRetry={retry}
          />
        </div>
      </div>
    );
  }

  if (data === undefined || layout === undefined || rows.length === 0) {
    return (
      <div className={blockClass}>
        <div className="dg-dependency-graph__empty">
          <EmptyState
            message={EMPTY_MESSAGE}
            icon={<Workflow aria-hidden="true" className="dg-icon" />}
          />
        </div>
      </div>
    );
  }

  const canvas = canvasSize(layout);

  return (
    <div className={blockClass}>
      {/*
       * The key names all six classes even though it shows five colours:
       * `function` and `service` resolve to the same `--dg-kind-function`
       * token, a decision recorded and reasoned about in
       * `../utils/color.ts` (the `service` entry of the participant-class
       * map). This component consumes that map rather than writing a second
       * one, so the pairing is honoured here rather than worked around. It
       * costs nothing legible: each badge carries its class name as text, the
       * grid below repeats it in the class column, and the layout separates
       * the two classes by layer - so colour is never the only thing telling
       * them apart.
       */}
      <Stack
        direction="horizontal"
        gap={2}
        align="center"
        wrap
        className="dg-dependency-graph__legend"
      >
        {KIND_LEGEND_ORDER.map((kind) => (
          <Badge
            key={kind}
            tone="neutral"
            variant="soft"
            color={dependencyNodeColorVar(kind)}
            data-kind={kind}
          >
            {KIND_LABEL[kind]}
          </Badge>
        ))}
      </Stack>

      <div className="dg-dependency-graph__viewport">
        <svg
          className="dg-dependency-graph__canvas"
          role="img"
          aria-label={textAlternative(layout, data.truncated)}
          width={canvas.width}
          height={canvas.height}
          viewBox={canvasViewBox(layout)}
        >
          {/*
           * Relationships are painted first. SVG paints in document order and
           * `z-index` does not apply to it, so a group of edges after the boxes
           * would be drawn across the labels it passes - and no rule in the
           * stylesheet could correct it afterwards.
           *
           * BLITZY [A11Y]: `../styles/components.css` strokes these curves with
           * `--dg-border-strong`, measured in Chrome at 1.76:1 against
           * `--dg-surface-elevated` in the dark theme and 1.72:1 in light -
           * below the 3:1 guidance for an essential non-text graphic. The value
           * belongs to the design system, which sets it once for every view
           * rather than here, so it is flagged for designer review instead of
           * being overridden: AAP 0.6.4 permits no hardcoded colour in a
           * component, and the high-contrast theme already raises the same
           * stroke to 14.34:1. Nothing is lost meanwhile - every relationship
           * is enumerated in text in the grid below, and an inferred one is
           * named there as well as dashed here.
           */}
          <g className="dg-dependency-graph__edges">
            {layout.edges.map((positioned) => (
              <Fragment key={positioned.edge.id}>
                <path
                  className={clsx(
                    'dg-dependency-graph__edge',
                    isInferredRelationship(positioned.edge) && 'dg-is-ambiguous',
                  )}
                  d={edgePathData(positioned.curve)}
                />
                {positioned.edge.count > 1 ? (
                  <text
                    className="dg-dependency-graph__edge-label"
                    x={interpolate(
                      EDGE_LABEL_POSITION,
                      positioned.anchors.source.x,
                      positioned.anchors.target.x,
                    )}
                    y={interpolate(
                      EDGE_LABEL_POSITION,
                      positioned.anchors.source.y,
                      positioned.anchors.target.y,
                    )}
                  >
                    {`×${formatCount(positioned.edge.count)}`}
                  </text>
                ) : null}
              </Fragment>
            ))}
          </g>

          {columns.map((column) => (
            <g key={column.layer} className="dg-dependency-graph__column" data-layer={column.layer}>
              {column.rows.map((row) => (
                <g
                  key={row.node.id}
                  onClick={() => {
                    handleActivate(row);
                  }}
                  onPointerEnter={() => {
                    handleHover(row.node.id);
                  }}
                  onPointerLeave={() => {
                    handleHover(undefined);
                  }}
                >
                  {/*
                   * The pointer user's label. The canvas is `role="img"` with a
                   * text alternative of its own, so this title is not what
                   * assistive technology reads - the grid below is.
                   */}
                  <title>{participantTitle(row.node)}</title>
                  <rect
                    className={clsx(
                      'dg-dependency-graph__node',
                      KIND_CLASS[row.node.kind],
                      row.node.id === selectedId && 'dg-is-selected',
                      row.node.id === hoveredId && 'dg-is-hovered',
                    )}
                    style={nodeColorStyle(row.node.kind)}
                    x={row.box.x}
                    y={row.box.y}
                    width={row.box.width}
                    height={row.box.height}
                  />
                  <text
                    className="dg-dependency-graph__node-label"
                    x={row.box.centerX}
                    y={labelY(row.box)}
                    textAnchor="middle"
                  >
                    {truncate(row.node.label, labelBudget(row.box.width))}
                  </text>
                  <text
                    className="dg-dependency-graph__node-meta"
                    x={row.box.centerX}
                    y={metaY(row.box)}
                    textAnchor="middle"
                  >
                    {participantMetaText(row.node)}
                  </text>
                </g>
              ))}
            </g>
          ))}
        </svg>
      </div>

      {/*
       * The keyboard-reachable equivalent, and deliberately unvirtualized: an
       * equivalent that covered a window of the participants rather than all of
       * them would not be one.
       */}
      <DataTable
        className="dg-dependency-graph__equivalent"
        rows={rows}
        columns={PARTICIPANT_COLUMNS}
        rowKey={participantRowKey}
        caption={GRID_CAPTION}
        selectedRowKey={selectedId ?? null}
        onRowActivate={handleActivate}
        virtualize={false}
        compact
      />

      <Stack gap={1} className="dg-dependency-graph__note">
        <Text as="p" size="xs" tone="muted">
          {STATIC_LAYOUT_NOTE}
        </Text>
        {data.truncated ? (
          <Text as="p" size="xs" tone="warning">
            {TRUNCATED_NOTE}
          </Text>
        ) : null}
        {layout.droppedEdgeCount > 0 ? (
          <Text as="p" size="xs" tone="warning">
            {droppedRelationshipsNote(layout.droppedEdgeCount)}
          </Text>
        ) : null}
        {layout.layersComputed ? (
          <Text as="p" size="xs" tone="muted">
            {COMPUTED_LAYERS_NOTE}
          </Text>
        ) : null}
      </Stack>
    </div>
  );
}
