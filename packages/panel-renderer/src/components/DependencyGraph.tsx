/**
 * `DependencyGraph` — the correlated flow of an interaction as a STATIC layered
 * left-to-right graph: the event, the code it reached, the calls it made and the
 * datastore or external service it ended at, with an edge for every handover.
 *
 * This module is the component behind the node catalog's `dependencyGraph`
 * type. It is the one structural view in the library — every other component
 * answers "how long" or "how often", and this one answers "what does this
 * interaction touch", because that answer is a shape.
 *
 * ## THE RECORDED GAP: THE LAYOUT IS STATIC, AND THAT IS THE DESIGN
 *
 * Interactive graph layout (drag, zoom) is a recorded gap of this version: the
 * graph is a layered static layout with hover and click. So this file contains,
 * deliberately and for as long as that gap stands:
 *
 *   - no drag, no pan, no wheel zoom, no transform state, no gesture handler;
 *   - no force simulation and no layout library of any kind — the layered
 *     geometry is `../utils/scale`'s, which is arithmetic over a column index
 *     and a row index and nothing more;
 *   - no measurement of any kind: nothing here reads a size from the DOM, a
 *     font or a layout. The canvas is a fixed logical drawing whose `viewBox`
 *     is the layout's own size, and the stylesheet sizes it relationally
 *     inside a scroll viewport. Every coordinate is a pure function of the
 *     payload, so one payload draws the same picture in a browser, under a
 *     layout-free test DOM and on every render. See "The canvas is a fixed
 *     logical drawing" below.
 *
 * The limitation is stated on screen rather than left for a reader to discover
 * by trying to drag the picture — see {@link STATIC_LAYOUT_NOTE}.
 *
 * ## DETERMINISM IS THE SUBSTANCE OF THIS VIEW
 *
 * This component appears in the excessive-render panel (trigger → provider →
 * consumers), where a developer compares one reading of a capture with
 * another. A graph that reshuffled between renders would read as noise and
 * would quietly undermine the evidence it exists to present, so the layout is
 * reproducible for any permutation of the payload:
 *
 *   1. Layers come from the payload's own `layer` indices when **every**
 *      participant carries a usable one, and are otherwise computed for all of
 *      them from the relationships — the all-or-nothing rule of
 *      `resolveGraphLayering` in `../utils/scale`. That layering is resolved
 *      **once** per payload and the same object feeds both the ordering below
 *      and `layoutDependencyGraph`, so the ordering and the geometry can never
 *      disagree and the layering never runs twice. Both routes are
 *      edge-derived or payload-derived and neither depends on array order.
 *   2. Participants are then put in the canonical order the aggregate itself
 *      documents — by layer, then by descending total duration, then by id —
 *      which is a no-op for a canonical payload (the sort is stable and the
 *      rule is the same one) and restores that order for a shuffled one. The id
 *      tie-break is total, so the result is permutation-independent down to the
 *      last row.
 *   3. A cycle cannot hang or explode the layout: the computed layering is one
 *      linear, non-recursive pass (strongly connected components, then the
 *      longest path over the acyclic graph they form), so the members of a
 *      cycle share one column instead of being pushed apart, and the anchors of
 *      an edge that runs backwards or stays in one column are computed for that
 *      case explicitly.
 *
 * ## TWO REPRESENTATIONS OF ONE GRAPH, AND WHY BOTH ARE MANDATORY
 *
 * A picture of a graph is unreadable to a keyboard or a screen-reader user, so
 * this component renders the same data twice:
 *
 *   - **The canvas.** An SVG carrying `role="img"` and a text alternative that
 *     states how many participants, layers and relationships it holds and where
 *     the equivalent is. It is a picture: pointer hover and click, no tab stop,
 *     and every shape has an SVG `<title>` for the pointer user. A click on a
 *     shape selects its participant and, where the participant resolved to a
 *     source location, opens that location in the editor through
 *     `onOpenSource` — the canvas has no chip of its own, so the shape carries
 *     both intents, and its title says so. That title is the user agent's —
 *     never shown on focus, never dismissible — so nothing it says is found
 *     there alone: the participant's grid row below always shows the same
 *     detail. Hovering a shape highlights it on the canvas, and Escape
 *     dismisses that highlight.
 *   - **The participants grid.** The `DataTable` primitive — one row per
 *     participant, ordered by layer and stating it, with the participant's
 *     label, its class, its timing, its outgoing relationships and its source
 *     chip. It is the library's own keyboard-navigable grid (a roving tab stop,
 *     arrow keys, Enter and Space), it is rendered unvirtualized so that it
 *     covers **every** participant rather than a window, and it is what makes
 *     the view operable without a pointer. Every row shows its participant's
 *     full label, tier and metrics inline, in one form whatever holds focus,
 *     the pointer or the selection — so nothing is reachable by hover alone,
 *     no tab stop is added to get there, and no row changes height under a
 *     pointer between the press and the release of a click (see
 *     {@link ParticipantCell}). A raw `<ul>` is not used: no raw `<table>` or
 *     bespoke list chrome is permitted above the primitives layer,
 *     `../styles/components.css` declares no rule for a list in this block,
 *     and `../styles/base.css` deliberately keeps user-agent list markers for
 *     any list that does not opt out in CSS.
 *
 * ## NO SELECTION IS EVER FABRICATED
 *
 * `PanelActions.onSelectEvent` needs an `eventId`, and `eventId` is the
 * coordinate a host resolves against the capture. A participant of this graph
 * is a **collapse** of records, and the aggregate declares the coordinate it may
 * carry: `eventId` and `traceId`, which `buildDependencyGraph` sets only for a
 * participant that collapsed exactly one record — the one case where the
 * participant and an event are the same thing. A collapse of several records
 * carries neither, and its `spanIds` sample is never passed off as an event id:
 * that would resolve to nothing in the details drawer, and
 * `../host/PanelActions` is explicit that a fabricated coordinate is worse than
 * an absent one. So activation reports to the host **only** when the
 * participant declares a coordinate that passes validation: a single record,
 * one well-formed span id, an opaque event id and a well-formed trace id (see
 * `eventCoordinateOf`). The payload crosses a shallow protocol guard, so a
 * coordinate that breaks those rules — an event id on a multi-record
 * participant, say — is not reported at all, and the view says under the grid
 * how many participants declared one. Nothing is invented. A participant with
 * neither an event coordinate nor a source location still reads fully — label,
 * class, timing, relationships — and offers no control that would do nothing.
 *
 * Opening source is a separate intent with separate evidence. A participant's
 * `source` is the location the aggregate resolved for it, which a collapse of
 * several records carries as readily as a single one, so a click on its shape
 * opens that location whenever it exists — with or without an event coordinate
 * — and hands the host the payload's own object, by reference, exactly as
 * `./SourceLink` does. In the grid the two intents stay apart: activating a row
 * (a click, Enter or Space) only selects, and the row's source chip is the
 * control that opens the editor, so a keyboard user can do either without
 * doing both.
 *
 * ## THE SELECTION IS THE PANEL'S, AND A LOCAL HIGHLIGHT YIELDS TO IT
 *
 * The selected participant (the row and the shape both take `dg-is-selected`)
 * is resolved from the panel host's one shared selection, read through
 * `useViewSelection`: the participant whose validated coordinate
 * `matchesPanelSelection` pairs with it is the selected one, so a span selected
 * in the timeline or the flame chart is marked here too, and one activated here
 * moves their marks. A participant with no coordinate cannot enter that
 * selection, yet activating it still has to show where the reader aimed; it is
 * highlighted locally, and the highlight records the shared selection it was
 * made under. The moment that selection changes — any view, or this one,
 * selects an event — the local highlight gives way to it, so this graph never
 * keeps marking a participant the other charts have moved on from. Re-selecting
 * the event that is already selected is not a change the host reports, so it
 * leaves the highlight as it is.
 *
 * The same holds for how a relationship was known. The aggregate counts, per
 * edge, how many of its records joined their caller through a lineage
 * attribution rather than by nesting (`inferredCount`) and how many of those
 * attributions were ambiguous (`ambiguousCount`). This component validates that
 * the two shares nest inside the edge's `count` and derives nothing: an edge
 * that carries neither is the measured relationship it is, and one whose shares
 * do not add up is drawn without a lineage state and reported under the grid
 * rather than capped into a claim the capture never made.
 *
 * ## PRIVACY: EVERY LABEL IS DATA, AND ARRIVES REDACTED
 *
 * A participant's label is the identity the aggregate derived from records that
 * passed the redaction layer (docs/SECURITY.md, "Redaction") — an interaction
 * and its target, a matched route, a module and a symbol, a database system.
 * This file renders labels as given: it never parses one, never reassembles a
 * URL or a statement from one, and shortens one only to fit a box on the canvas
 * (with the full text in that shape's title, and in full, wrapped, in its grid
 * row).
 * The only vocabulary this file writes is generic product vocabulary: the six
 * participant classes of the closed telemetry domain and the column headings.
 * A specific component, function or route name here would be exactly the
 * hardcoded demo knowledge the product forbids, which
 * `scripts/check-no-hardcoding.mjs` fails the build for (docs/ARCHITECTURE.md,
 * "Workspace layout and dependency layering").
 *
 * ## NO TRANSPORT, ONE QUERY
 *
 * Data arrives only through the node's `DataQuery`, resolved by `../host/useQuery`
 * against the ambient `DataProvider`; interactions leave only through
 * `../host/PanelActions`. There is no socket, no `fetch`, no paging control: the
 * `graph` source answers with one whole `DependencyGraphData` object rather than
 * a page, so there is nothing to load more of — and where the payload says it
 * was bounded, or where a relationship named a participant the payload does not
 * contain, this component says so rather than drawing a graph that looks
 * complete. A bounded graph is a PARTIAL RESULT, stated beside the canvas in
 * the shape the timeline and the flame chart share: the "Partial result"
 * badge, how many of the most significant participants are drawn, and the
 * route to the rest — narrowing the query to one trace or interaction.
 *
 * ## THE KNOWN BOUNDS OF A STATIC PICTURE
 *
 * Recorded here so the next reader does not have to rediscover any of it. The
 * first and the last were verified in Chrome against a fixture of eight
 * participants across six layers; the second follows from the geometry below
 * and holds for every payload by construction:
 *
 *   - **Direction is carried by the layout and by the grid, not by arrowheads.**
 *     The stylesheet declares no marker for this block and the geometry helper
 *     returns plain paths, so an edge is a curve: a relationship reads left to
 *     right from the flow's origin, and the grid states it as "→ ‹called
 *     participant›" in text, which is also the only route a keyboard or
 *     screen-reader user has. A relationship that runs backwards — what a cyclic
 *     dependency produces — is anchored correctly by the helper and stays
 *     legible in the grid.
 *   - **The canvas is a fixed logical drawing, and a graph too big to fit
 *     scrolls.** Its `viewBox` is the layout's own size — every box, gap and
 *     curve in SVG user units, plus the outline inset on each side — and its
 *     `width` and `height` attributes carry those same two numbers, so at rest
 *     one user unit is one CSS pixel: text renders at its token size and the
 *     canvas is exactly as tall as its participants, with no band beneath it.
 *     Nothing sizes the drawing from its container. The stylesheet, not this
 *     component, decides how the element sits in its scroll viewport, and that
 *     viewport scrolls a graph wider than the panel in the inline axis and a
 *     tall one in the block axis. A `viewBox` scaled to fit the panel would
 *     shrink every label with the panel — to about a quarter of its type size
 *     in a docked DevTools panel — so the drawing is never scaled to fit. The
 *     boxes, the row gap and the column gap are the scale module's rhythm; the
 *     column gap widens beyond it only as far as the data requires, to hold the
 *     widest relationship count drawn inside a gap (see {@link columnGapOf}).
 *     The participants grid is the complete reading of a graph too large to
 *     take in at a glance, which is the other reason it is never virtualized.
 *   - **The relationship curves carry no information of their own.** The
 *     stroke is the design system's edge treatment in
 *     `../styles/components.css`, whose contrast is owned and tested with the
 *     design tokens; a relationship known through an inferred lineage is
 *     stroked in the info tone and one whose lineage was ambiguous is dashed
 *     in the warning tone, by state class. This component writes no colour,
 *     and every relationship — with how it was known — is also enumerated in
 *     text in the grid. See the BLITZY [A11Y] note beside the edge group
 *     below.
 *
 * ## WHAT IT READS
 *
 * The node catalog entry is imported rather than restated
 * (`catalogEntryFor('dependencyGraph')`), and it is the authority for the two
 * things this file would otherwise have hardcoded: the only source this view may
 * draw (`sources`), which the source guard reports against, and the view's own
 * name (`label`), which the canvas's text alternative and the grid's caption are
 * composed from. The participant fields drawn here — label, class, tier, record
 * count, total and slowest duration, source location, layer and event
 * coordinate — and the relationship fields — its endpoints, its count and its
 * inferred and ambiguous shares — are what the aggregate derives from the
 * telemetry fields that same entry declares in `reads`; this component reads
 * prepared participants and never a raw record.
 *
 * ## APPEARANCE IS A CLASS CONTRACT
 *
 * No colour, length, radius or font appears in this module. The classes below
 * are implemented in `../styles/components.css` against `--dg-*` tokens; the
 * only inline value is the `--dgc-node-color` custom property, whose value is a
 * `var(--dg-*)` reference from `../utils/color`, and the only literal numbers
 * are unitless SVG geometry from `../utils/scale`:
 *
 *   dg-dependency-graph              the block
 *   dg-dependency-graph__legend      the colour key: the six participant
 *                                    classes, then any span-kind colour a
 *                                    participant is drawn in instead
 *   dg-dependency-graph__viewport    the scroll container around the canvas
 *   dg-dependency-graph__canvas      the SVG
 *   dg-dependency-graph__column      one layer's group of shapes
 *   dg-dependency-graph__node        a participant's box
 *   dg-dependency-graph__node--*     its participant class
 *   dg-dependency-graph__node-label  the label inside the box
 *   dg-dependency-graph__node-meta   the metrics line inside the box
 *   dg-dependency-graph__edge        a relationship's curve on the canvas
 *   dg-dependency-graph__edge-label  a repeated relationship's count
 *   dg-dependency-graph__relationship
 *                                    a relationship's chip in the grid, which
 *                                    wraps inside its cell
 *   dg-dependency-graph__participant-label
 *                                    a participant's full label in the grid,
 *                                    wrapped rather than truncated
 *   dg-dependency-graph__equivalent  the participants grid
 *   dg-dependency-graph__note        the notes under the grid
 *   dg-dependency-graph__empty       the three state boxes, as every
 *   dg-dependency-graph__loading     visualization in this folder declares
 *   dg-dependency-graph__error       them
 *   dg-is-selected / dg-is-hovered   a participant's states
 *   dg-is-inferred / dg-is-ambiguous a relationship's lineage state, on its
 *                                    curve and on its chip
 *
 * The caller's `className` is composed last.
 *
 * @see ../utils/scale for the layered geometry, the edge paths and the column rhythm.
 * @see ../utils/format for the deterministic text-width estimate the column gap
 * holds its count labels with.
 * @see ../utils/color for the participant colour rule: span kinds first, then
 * the participant-class scale.
 * @see ../host/DataProvider for the data seam and the `graph` result shape.
 * @see ../styles/components.css for the implementation of the classes above.
 */

import { catalogEntryFor } from '@debuggen/panel-schema';
import type {
  DataQuery,
  DependencyGraphNode as DependencyGraphNodeSpec,
} from '@debuggen/panel-schema';
import { isSpanId, isTraceId } from '@debuggen/shared';
import type {
  DependencyGraphData,
  DependencyGraphEdge,
  DependencyGraphNode,
  TelemetryKind,
} from '@debuggen/telemetry';
import clsx from 'clsx';
import { Workflow } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import { matchesPanelSelection, usePanelActions, useViewSelection } from '../host/PanelActions';
import type { PanelEventRef, PanelSelection } from '../host/PanelActions';
import { queryFailureProps, unsupportedQueryProps, useQuery } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import { Badge } from '../primitives/Badge';
import type { BadgeTone } from '../primitives/Badge';
import { DataTable } from '../primitives/DataTable';
import type { DataTableColumn } from '../primitives/DataTable';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import {
  dependencyNodeColorVar,
  dependencyNodeTokenKey,
  dependencyParticipantColorVar,
  dependencyParticipantTokenKey,
} from '../utils/color';
import {
  DEFAULT_LABEL_FONT_SIZE,
  NOT_AVAILABLE_LABEL,
  countedNoun,
  createEstimateMeasure,
  formatCount,
  formatCountOf,
  formatDurationCompact,
  formatKindLabel,
  formatTierLabel,
  pluralize,
  truncate,
} from '../utils/format';
import type { CountedNoun, TextMeasure } from '../utils/format';
import {
  DEFAULT_GRAPH_COLUMN_GAP,
  edgePathData,
  interpolate,
  layoutDependencyGraph,
  resolveGraphLayering,
} from '../utils/scale';
import type { DependencyGraphLayout, GraphLayering, GraphNodeBox } from '../utils/scale';
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
 * arithmetic over one, in SVG user units that the canvas declares one to a CSS
 * pixel. Nothing here is a CSS length, and nothing is measured: no element's
 * size, no font metric, no layout. The one input beyond the scale module's
 * rhythm is the payload itself — the relationship count labels a column gap
 * must hold, whose advance is `../utils/format`'s deterministic estimate — so
 * the column gap ({@link columnGapOf}), and with it the whole drawing, is a
 * pure function of the data.
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
 * An estimate: a box is the scale module's fixed width for every payload and at
 * every panel width, so its budget is a constant of the rhythm rather than a
 * measurement. It is used only to choose a truncation
 * budget — the stylesheet, not this number, decides how the text is drawn — so
 * an approximation that errs toward a shorter label is the safe direction.
 */
const LABEL_CHARACTER_WIDTH = 8;

/** The shortest label a box will show before the ellipsis, however narrow it is. */
const MIN_LABEL_CHARACTERS = 6;

/** The fraction along an edge its count label sits at: the midpoint. */
const EDGE_LABEL_POSITION = 0.5;

/**
 * The advance of a relationship's count label, as {@link columnGapOf} sizes a
 * column gap for it: `../utils/format`'s deterministic estimate at
 * `DEFAULT_LABEL_FONT_SIZE`, the 11-unit size of the `monoSm` role that
 * `components.css` sets `dg-dependency-graph__edge-label` in. The canvas
 * declares one user unit per CSS pixel, so that is the size the label is drawn
 * at; and the estimate's 0.6 em per narrow grapheme is the advance of the
 * monospace faces that role names, so a label sized by it fits the gap drawn.
 *
 * A module constant, created once: it reads no font, no element and no layout,
 * so the same labels always ask for the same gap.
 */
const EDGE_LABEL_MEASURE: TextMeasure = createEstimateMeasure(DEFAULT_LABEL_FONT_SIZE);

/**
 * The space kept clear between a count label's ink and the outline of the box
 * on either side of it, in SVG user units, so a label drawn in a column gap
 * never touches the participant it sits beside.
 */
const EDGE_LABEL_CLEARANCE = 4;

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

/** A repeated relationship's count, as the canvas labels its curve: `×3`. */
function edgeCountText(count: number): string {
  return `×${formatCount(count)}`;
}

/**
 * The canvas box: the layout's own logical size, inset so no outline is
 * clipped.
 *
 * It is also the size the canvas declares. The `width` and `height`
 * attributes and the `viewBox` ({@link canvasViewBox}) are the same two
 * numbers, so at rest one user unit is one CSS pixel: its text renders at its
 * token size, and the element is exactly as tall as its content, with no band
 * beneath it. Both are pure functions of the layout — nothing is read from the
 * element or its container — and the scroll viewport around the canvas is what
 * lets a drawing larger than the panel be reached.
 */
function canvasSize(layout: DependencyGraphLayout): { width: number; height: number } {
  return {
    width: layout.width + OUTLINE_INSET * 2,
    height: layout.height + OUTLINE_INSET * 2,
  };
}

/** The `viewBox` of the canvas: its logical size, with the outline inset applied. */
function canvasViewBox(layout: DependencyGraphLayout): string {
  const { width, height } = canvasSize(layout);
  return `${String(-OUTLINE_INSET)} ${String(-OUTLINE_INSET)} ${String(width)} ${String(height)}`;
}

/**
 * The distinct count labels the canvas draws inside a column gap.
 *
 * A repeated relationship's count sits at the midpoint of its anchors
 * ({@link EDGE_LABEL_POSITION}). For a relationship from one column to the
 * next, that midpoint is the centre of the gap between the two columns, so
 * the gap is all the room its label has; those are the labels the column gap
 * is widened for. A relationship that skips columns, runs backwards or stays
 * in one column labels a point outside any single gap, and one naming a
 * participant the graph does not contain is not drawn, so neither constrains
 * the gap.
 *
 * @param edges The payload's relationships.
 * @param layers The column of every participant, from the resolved layering.
 */
function gapCountLabelsOf(
  edges: readonly DependencyGraphEdge[],
  layers: ReadonlyMap<string, number>,
): readonly string[] {
  const labels = new Set<string>();
  for (const edge of edges) {
    if (edge.count <= 1) {
      continue;
    }
    const from = layers.get(edge.from);
    if (from !== undefined && layers.get(edge.to) === from + 1) {
      labels.add(edgeCountText(edge.count));
    }
  }
  return [...labels];
}

/**
 * The narrowest column gap that holds every label in `labels`: the widest
 * one's advance, plus {@link EDGE_LABEL_CLEARANCE} and the half outline
 * ({@link OUTLINE_INSET}) that each neighbouring box's stroke reaches into the
 * gap, on both sides. `0` when there is no label to hold, so the label
 * requirement alone never sets a floor; {@link columnGapOf} supplies that.
 *
 * A measure that answers a non-finite or non-positive advance is ignored
 * rather than trusted, so it can never shrink or poison the gap.
 *
 * @param labels The count labels drawn inside a column gap.
 * @param measure Estimates a string's advance in the labels' type role.
 * @returns A finite, non-negative width in SVG user units.
 */
function minimumColumnGap(labels: readonly string[], measure: TextMeasure): number {
  let widest = 0;
  for (const label of labels) {
    const advance = measure(label);
    if (Number.isFinite(advance) && advance > widest) {
      widest = advance;
    }
  }
  if (widest === 0) {
    return 0;
  }
  return Math.ceil(widest) + 2 * (EDGE_LABEL_CLEARANCE + OUTLINE_INSET);
}

/**
 * The column gap to lay the graph out with: the scale module's rhythm,
 * `DEFAULT_GRAPH_COLUMN_GAP`, widened only as far as the data requires so the
 * widest repeated-relationship count drawn inside a gap still fits it
 * ({@link minimumColumnGap}, estimated by {@link EDGE_LABEL_MEASURE}).
 *
 * A pure function of the payload's labels. No element, font or container is
 * read, so identical data yields an identical gap — and so an identical
 * drawing — in a browser, under a layout-free test DOM and on every render.
 * A graph that is wider than its panel at this gap is not squeezed to fit:
 * the canvas keeps its logical size and its scroll viewport scrolls.
 *
 * @example A chain whose one repeated relationship ran twice keeps the rhythm,
 * because `×2` needs far less room than the default gap already gives:
 * ```ts
 * columnGapOf(['×2']); // DEFAULT_GRAPH_COLUMN_GAP
 * ```
 *
 * @param gapLabels The count labels drawn inside a column gap; see
 *   {@link gapCountLabelsOf}.
 * @returns A finite gap in SVG user units, never below the default rhythm.
 */
function columnGapOf(gapLabels: readonly string[]): number {
  return Math.max(DEFAULT_GRAPH_COLUMN_GAP, minimumColumnGap(gapLabels, EDGE_LABEL_MEASURE));
}

/**
 * The participant colour as the custom property the stylesheet consumes.
 *
 * The participant's own span kinds decide it when they agree on one span-kind
 * colour, so a box is drawn in the colour the same spans have in the timeline,
 * the flame view and the waterfall; otherwise its class colour does. The rule
 * is `dependencyParticipantTokenKey` in `../utils/color.ts`.
 */
function nodeColorStyle(node: DependencyGraphNode): CssVariableStyle {
  return { '--dgc-node-color': dependencyParticipantColorVar(node) };
}

/**
 * One key entry beyond the six class chips: a span-kind colour some participant
 * is drawn in that is not its class's own colour, with the kinds it stands for.
 */
interface SpanColourKeyEntry {
  /** The `var(--dg-*)` reference the entry's participants are stroked with. */
  readonly colorVar: string;
  /** The kinds drawn in that colour off their class colour, first seen first. */
  readonly kinds: readonly TelemetryKind[];
}

/**
 * The key entries the six class chips do not already explain.
 *
 * A participant whose span kinds settle a colour of their own — a render, the
 * server's end of a request, a failure — is drawn in that colour rather than its
 * class's, so the class key alone would leave the colour unnamed. Each such
 * colour gets one entry, labelled with the kinds drawn in it, in the order the
 * participants are listed, which is deterministic for one graph. A colour that
 * equals a participant's class colour needs no entry: its class chip names it.
 *
 * @param rows The participants, in the grid's canonical order.
 * @returns One entry per off-class colour, first seen first; empty when every
 *   participant is drawn in its class colour.
 */
function spanColourKey(rows: readonly ParticipantRow[]): SpanColourKeyEntry[] {
  const entries = new Map<string, { colorVar: string; kinds: TelemetryKind[] }>();

  for (const { node } of rows) {
    const token = dependencyParticipantTokenKey(node);
    if (token === dependencyNodeTokenKey(node.kind)) {
      continue;
    }

    const entry = entries.get(token) ?? {
      colorVar: dependencyParticipantColorVar(node),
      kinds: [],
    };
    for (const kind of node.spanKinds ?? []) {
      if (!entry.kinds.includes(kind)) {
        entry.kinds.push(kind);
      }
    }
    entries.set(token, entry);
  }

  return [...entries.values()];
}

/** A key entry's text: the readable names of the kinds it stands for. */
function spanColourKeyLabel(entry: SpanColourKeyEntry): string {
  return entry.kinds.map(formatKindLabel).join(' · ');
}

/*
 * ---------------------------------------------------------------------------
 * Layering and canonical order
 * ---------------------------------------------------------------------------
 */

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
 *
 * `layers` is the layering already resolved for this payload — the same map the
 * layout is then built from — so ordering never computes a layering of its own.
 * Only the participant order changes: the relationships and every participant
 * object are the payload's own, which is what keeps that layering valid for the
 * returned graph.
 */
function canonicalGraph(
  data: DependencyGraphData,
  layers: ReadonlyMap<string, number>,
): DependencyGraphData {
  return {
    ...data,
    nodes: data.nodes.toSorted((left, right) => compareParticipants(left, right, layers)),
  };
}

/** A payload prepared for layout: every input `layoutDependencyGraph` is given. */
interface GraphArrangement {
  /** The payload with its participants in canonical order. */
  readonly graph: DependencyGraphData;
  /** The layering resolved for it, which both the order and the geometry use. */
  readonly layering: GraphLayering;
  /** The column gap its count labels require; see {@link columnGapOf}. */
  readonly columnGap: number;
}

/**
 * Everything a payload's layout is built from: one layering, the canonical
 * order built from that same object, and the column gap its count labels
 * require.
 *
 * A pure function of the payload, computed once per payload, so the layering
 * never runs twice for one payload and the geometry built from this
 * arrangement is the same for identical data wherever it is drawn.
 */
function arrangeGraph(data: DependencyGraphData): GraphArrangement {
  const layering = resolveGraphLayering(data.nodes, data.edges);
  return {
    graph: canonicalGraph(data, layering.layers),
    layering,
    columnGap: columnGapOf(gapCountLabelsOf(data.edges, layering.layers)),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The event coordinate and the lineage the aggregate declares — validated
 *
 * Both are optional fields of the authoritative telemetry shapes, produced by
 * `buildDependencyGraph`: a participant's `eventId` and `traceId`, and a
 * relationship's `inferredCount` and `ambiguousCount`. Their invariants are
 * stated on those declarations, and they are what this section checks:
 *
 *   - an event coordinate belongs to a participant that collapsed exactly one
 *     record (`count === 1`, one well-formed span id in `spanIds`), and carries
 *     an opaque, non-blank `eventId` together with a well-formed `traceId`;
 *   - a relationship's shares nest: `0 ≤ ambiguousCount ≤ inferredCount ≤
 *     count`, every one a whole number and `count` at least one.
 *
 * The protocol's guard on a `graph` result checks only its outer shape, and this
 * package may take `@debuggen/telemetry` as types only, so the checks are
 * written here, against those declared rules, and run before either field can
 * drive anything. A declaration that breaks a rule is **not used** —
 * no host selection, no inferred state — and is counted, so the view says under
 * the grid that part of the payload was inconsistent rather than repairing it
 * into a claim the capture never made. Nothing below derives a value the
 * payload did not state.
 * ---------------------------------------------------------------------------
 */

/**
 * One optional declaration, read against its rules: absent, valid (with the
 * value it declares), or present and inconsistent.
 */
type Declaration<T> =
  | { readonly state: 'absent' }
  | { readonly state: 'valid'; readonly value: T }
  | { readonly state: 'invalid' };

/** The absent declaration, shared. */
const ABSENT: Declaration<never> = Object.freeze({ state: 'absent' });

/** The inconsistent declaration, shared. */
const INVALID: Declaration<never> = Object.freeze({ state: 'invalid' });

/**
 * Whether a value is an opaque event id: a non-empty string with no surrounding
 * whitespace, the shape the telemetry event schema admits for `id`.
 */
function isOpaqueEventId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/**
 * The event coordinate a participant declares, validated.
 *
 * Absent when the participant carries neither `eventId` nor `traceId` — the
 * normal, honest answer for a collapse of several records; see this module's
 * header for why a span id is never passed off as an event id. Valid only when
 * every rule of the section above holds, in which case the reference carries
 * the declared event and trace and the participant's one span as the hint.
 * Anything else — an event id on a multi-record participant, a trace id
 * without an event id, a blank or malformed id — is inconsistent, and the
 * participant then reports no selection at all rather than a coordinate that
 * could name the wrong event or none.
 */
function eventCoordinateOf(node: DependencyGraphNode): Declaration<PanelEventRef> {
  const { eventId, traceId } = node;
  if (eventId === undefined && traceId === undefined) {
    return ABSENT;
  }

  const [spanId, ...otherSpans] = node.spanIds;
  const singleRecord = node.count === 1 && otherSpans.length === 0 && isSpanId(spanId);

  if (!singleRecord || !isOpaqueEventId(eventId) || !isTraceId(traceId)) {
    return INVALID;
  }

  return { state: 'valid', value: { eventId, spanId, traceId } };
}

/** How a relationship was known, as the counts its payload declared. */
interface LineageTally {
  /** How many records the relationship stands for: its `count`. */
  readonly total: number;
  /** How many of them joined their caller through a lineage attribution. */
  readonly inferred: number;
  /** How many of those attributions had several candidates. */
  readonly ambiguous: number;
}

/** Whether a value is a whole number of zero or more. */
function isWholeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The lineage a relationship declares, validated.
 *
 * Absent when it declares neither share — a measured relationship. Valid when
 * the shares nest (`0 ≤ ambiguousCount ≤ inferredCount ≤ count`, all whole,
 * `count ≥ 1`), with an omitted share read as the zero the aggregate omits.
 * Anything else is inconsistent: it is neither capped into agreement nor read
 * as a measurement it may not be, but dropped and reported.
 */
function edgeLineageOf(edge: DependencyGraphEdge): Declaration<LineageTally> {
  const { count, inferredCount, ambiguousCount } = edge;
  if (inferredCount === undefined && ambiguousCount === undefined) {
    return ABSENT;
  }

  const inferred = inferredCount ?? 0;
  const ambiguous = ambiguousCount ?? 0;
  const nested =
    isWholeCount(count) &&
    count >= 1 &&
    isWholeCount(inferred) &&
    inferred <= count &&
    isWholeCount(ambiguous) &&
    ambiguous <= inferred;

  return nested ? { state: 'valid', value: { total: count, inferred, ambiguous } } : INVALID;
}

/** The counts of a relationship whose lineage is usable, and `undefined` otherwise. */
function usableLineageOf(edge: DependencyGraphEdge): LineageTally | undefined {
  const lineage = edgeLineageOf(edge);
  return lineage.state === 'valid' ? lineage.value : undefined;
}

/**
 * How a relationship was known, as the one state both of its marks — the curve
 * on the canvas and the chip in the grid — are drawn from.
 *
 * - `measured`: every record joined its caller by nesting. So is an edge that
 *   declares no lineage, or an inconsistent one (which is reported instead).
 * - `inferred`: some records joined through a lineage attribution (an async
 *   continuation), and each of those attributions had exactly one candidate.
 *   Not measured, so it is told apart — but not in doubt either.
 * - `ambiguous`: at least one of those attributions chose among several open
 *   candidates. This, and only this, is the relationship the timeline dashes
 *   (an edge is dashed when `lineageAmbiguous` is set; see docs/ARCHITECTURE.md,
 *   "Async-continuation lineage"), so it is the only one dashed here.
 */
type LineageState = 'measured' | 'inferred' | 'ambiguous';

/**
 * The lineage state of a relationship's validated counts.
 *
 * Nothing is inferred *here*: the counts are read and validated by
 * {@link edgeLineageOf}, never derived, and a relationship whose declaration is
 * absent or inconsistent reads as measured.
 */
function lineageStateOf(lineage: LineageTally | undefined): LineageState {
  if (lineage === undefined || lineage.inferred === 0) {
    return 'measured';
  }

  return lineage.ambiguous > 0 ? 'ambiguous' : 'inferred';
}

/**
 * The state class each lineage state carries, on the curve and on the chip.
 * Spelled out, as the class inventory requires; a measured relationship
 * carries none.
 */
const LINEAGE_STATE_CLASS: Readonly<Record<LineageState, string | undefined>> = Object.freeze({
  measured: undefined,
  inferred: 'dg-is-inferred',
  ambiguous: 'dg-is-ambiguous',
});

/**
 * The chip tone each lineage state reads in: the info tone for a relationship
 * inferred from a single candidate, the warning tone for one that was a choice
 * among several. The chip's text names the state in words either way, so
 * the tone is never the only signal.
 */
const LINEAGE_TONE: Readonly<Record<LineageState, BadgeTone>> = Object.freeze({
  measured: 'neutral',
  inferred: 'info',
  ambiguous: 'warning',
});

/** How many declarations of a payload were present but inconsistent. */
interface InconsistentDeclarations {
  /** Participants whose event coordinate broke its rules. */
  readonly coordinates: number;
  /** Drawn relationships whose lineage shares broke theirs. */
  readonly lineages: number;
}

/** No inconsistent declaration: the count of an unresolved query, shared. */
const NO_INCONSISTENT_DECLARATIONS: InconsistentDeclarations = Object.freeze({
  coordinates: 0,
  lineages: 0,
});

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
  /**
   * How many of its records were inferred, and how many of those ambiguously —
   * `undefined` when it declares no lineage or an inconsistent one; see
   * {@link edgeLineageOf}.
   */
  readonly lineage: LineageTally | undefined;
  /** How it was known — measured, inferred or ambiguous; see {@link lineageStateOf}. */
  readonly state: LineageState;
}

/** One participant: its datum, its box, what it calls and what it stands for. */
interface ParticipantRow {
  /** The participant, borrowed read-only from the payload. */
  readonly node: DependencyGraphNode;
  /** Its box in the layered layout. */
  readonly box: GraphNodeBox;
  /** Its outgoing relationships, in the payload's order. */
  readonly outgoing: readonly ParticipantRelationship[];
  /**
   * The event it stands for, when it declares a valid coordinate; see
   * {@link eventCoordinateOf}.
   */
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
    const lineage = usableLineageOf(edge);
    relationships.push({
      edge,
      targetLabel: labels.get(edge.to) ?? edge.to,
      lineage,
      state: lineageStateOf(lineage),
    });
    outgoing.set(edge.from, relationships);
  }

  return layout.nodes.map((positioned) => {
    const coordinate = eventCoordinateOf(positioned.node);
    return {
      node: positioned.node,
      box: positioned.box,
      outgoing: outgoing.get(positioned.node.id) ?? NO_RELATIONSHIPS,
      eventRef: coordinate.state === 'valid' ? coordinate.value : undefined,
    };
  });
}

/**
 * A participant highlighted locally because it stands for no single event, and
 * the panel selection that was current when it was activated.
 *
 * The highlight holds only while that selection is still the panel's current
 * one — compared by identity, which the host and the standalone fallback both
 * keep stable until a different event is selected — so a later selection in
 * any view ends it without an effect or a subscription.
 */
interface LocalHighlight {
  /** The highlighted participant's id. */
  readonly participantId: string;
  /** The panel selection it was made under; `undefined` when nothing was selected. */
  readonly basis: PanelSelection | undefined;
}

/**
 * The id of the participant this graph marks as selected, or `undefined`.
 *
 * A local highlight still made under the current selection wins, because it is
 * the reader's latest gesture in this view and it names no event the other
 * charts could be marking instead. Otherwise the participant whose validated
 * coordinate the panel's selection matches is the selected one — the same
 * event every other chart of the panel marks.
 *
 * @param rows The participants, as both representations draw them.
 * @param selection The panel's selection, as `useViewSelection` returns it.
 * @param local The local highlight, if one was made.
 * @returns The selected participant's id, if any participant is selected.
 */
function selectedParticipantIdOf(
  rows: readonly ParticipantRow[],
  selection: PanelSelection | undefined,
  local: LocalHighlight | undefined,
): string | undefined {
  if (
    local !== undefined &&
    local.basis === selection &&
    rows.some((row) => row.node.id === local.participantId)
  ) {
    return local.participantId;
  }

  return rows.find((row) => matchesPanelSelection(selection, row.eventRef))?.node.id;
}

/**
 * How many declarations of a laid-out payload were present but inconsistent.
 *
 * Counted over what is drawn: every participant, and every relationship both of
 * whose endpoints exist (the others are already counted as dropped). The view
 * reports each non-zero count under the grid, so a declaration that was not
 * used is never silently discarded.
 */
function inconsistentDeclarationsOf(layout: DependencyGraphLayout): InconsistentDeclarations {
  let coordinates = 0;
  for (const positioned of layout.nodes) {
    if (eventCoordinateOf(positioned.node).state === 'invalid') {
      coordinates += 1;
    }
  }

  let lineages = 0;
  for (const positioned of layout.edges) {
    if (edgeLineageOf(positioned.edge).state === 'invalid') {
      lineages += 1;
    }
  }

  return { coordinates, lineages };
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
 * project is interpolated into any of it.
 * ---------------------------------------------------------------------------
 */

/** The static layout's recorded limitation, stated on screen rather than implied. */
const STATIC_LAYOUT_NOTE =
  'This layout is static in this version: the table below details every participant, and selecting one there or on the picture highlights it in both. Clicking a participant on the picture also opens its source location in the editor when it has one, as its source chip in the table does. Dragging, panning and zooming are not available.';

/** What an empty graph says. */
const EMPTY_MESSAGE = 'No dependency relationships were captured for this interaction.';

/** The short label above {@link EMPTY_MESSAGE}. */
const EMPTY_TITLE = 'No relationships';

/** What the busy announcement says while the graph resolves. */
const LOADING_LABEL = 'Loading the dependency graph…';

// No failure copy lives here: both error states take their title, message,
// hint, code and query block from the one contract in `../host/useQuery`
// (`queryFailureProps`, `unsupportedQueryProps`), so this view words a failure
// exactly as every other node does.

/** Marks a relationship chip whose relationship was inferred rather than measured. */
const INFERRED_LABEL = 'inferred';

/** Qualifies how many of a relationship's inferences had several candidates. */
const AMBIGUOUS_LABEL = 'ambiguous';

/** Precedes a called participant on a relationship chip. */
const RELATIONSHIP_ARROW = '→';

/** The grid's accessible name. */
const GRID_CAPTION = `${CATALOG_ENTRY.label}: every participant by layer, with its outgoing relationships and its source location.`;

/**
 * The badge a partial result carries — the same words, tone and variant the
 * timeline's summary strip and the flame chart use, so the three charts mark
 * a subset identically.
 */
const PARTIAL_RESULT_LABEL = 'Partial result';

/**
 * Said beside the canvas when the payload reports that it was bounded: what is
 * drawn, what was left out, and the route to the rest.
 *
 * The aggregate keeps the costliest participants when it reaches its bound, so
 * what is drawn is named as the most significant ones. The payload says only
 * THAT it was bounded — participants, relationships or both — never how much
 * was left out, so no total is claimed. A `graph` result is one whole object
 * with nothing more in memory, so the route is a narrower query, never a
 * control.
 *
 * @param drawn How many participants the canvas draws.
 * @returns The notice's sentences.
 */
function truncatedNotice(drawn: number): string {
  return `Showing the ${formatCount(drawn)} most significant participants: some participants or relationships were left out at this graph's size bound. Narrow the query to one trace or interaction to see more.`;
}

/** Said when the layering was computed here because the payload carried none. */
const COMPUTED_LAYERS_NOTE =
  'The columns were computed from the relationships, because the captured participants carried no layer of their own.';

/*
 * The words the notes and the text alternative count in. Each sentence agrees
 * its noun, its verb and its pronouns with the count it prints, through the
 * package's one rule in `../utils/format` — never a "(s)" left for the reader
 * to resolve.
 */
const PARTICIPANT_NOUN: CountedNoun = countedNoun('participant');
const RELATIONSHIP_NOUN: CountedNoun = countedNoun('relationship');
const LAYER_NOUN: CountedNoun = countedNoun('layer');
const IS_VERB: CountedNoun = countedNoun('is', 'are');
const POSSESSIVE_PRONOUN: CountedNoun = countedNoun('its', 'their');
const OBJECT_PRONOUN: CountedNoun = countedNoun('it', 'them');

/** Said when a relationship named a participant the payload does not contain. */
function droppedRelationshipsNote(count: number): string {
  return `${formatCountOf(count, RELATIONSHIP_NOUN)} named a participant this graph does not contain and ${pluralize(count, IS_VERB)} not drawn.`;
}

/** Said when participants declared an event coordinate that contradicts their records. */
function inconsistentCoordinatesNote(count: number): string {
  return `${formatCountOf(count, PARTICIPANT_NOUN)} declared an event that does not match ${pluralize(count, POSSESSIVE_PRONOUN)} records, so selecting ${pluralize(count, OBJECT_PRONOUN)} opens no event.`;
}

/**
 * Said when relationships declared lineage shares that do not add up. The
 * relationship itself is still drawn; what is withheld is its declared counts,
 * so "which are not shown" agrees with those counts and stays plural whatever
 * the number of relationships.
 */
function inconsistentLineagesNote(count: number): string {
  return `${formatCountOf(count, RELATIONSHIP_NOUN)} declared inconsistent inferred or ambiguous counts, which are not shown.`;
}

/**
 * The canvas's text alternative: what the picture holds, and where its
 * keyboard-reachable equivalent is.
 */
function textAlternative(layout: DependencyGraphLayout, truncated: boolean): string {
  const shape = `${CATALOG_ENTRY.label}: ${formatCountOf(layout.nodes.length, PARTICIPANT_NOUN)} in ${formatCountOf(layout.layerCount, LAYER_NOUN)}, joined by ${formatCountOf(layout.edges.length, RELATIONSHIP_NOUN)} and drawn left to right from the participant the flow started at.`;
  const equivalent =
    'The participants table below carries the same participants, their outgoing relationships and their source locations.';

  return truncated
    ? `${shape} ${truncatedNotice(layout.nodes.length)} ${equivalent}`
    : `${shape} ${equivalent}`;
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

/**
 * What a click on a shape does besides selecting it, for a participant with a
 * location. The path is the payload's own, project-relative and redacted
 * upstream; the sentence around it is product vocabulary.
 */
function openSourceHint(file: string): string {
  return `Click to open ${file} in the editor.`;
}

/**
 * The pointer title of a participant's shape on the canvas: what it is, how
 * long it took and — for a participant with a location, in a surface that can
 * open one — that a click opens it in the editor.
 *
 * @param node The participant.
 * @param canOpenSource Whether the host supplied the action a click would raise.
 */
function participantTitle(node: DependencyGraphNode, canOpenSource: boolean): string {
  const identity = `${node.label} · ${KIND_LABEL[node.kind]} · ${participantMetricsText(node)}`;

  // The click's second effect is named only where it exists: a participant
  // with a location, drawn in a surface whose host can open one. Promising a
  // navigation the click would not perform is the pointer-side form of a
  // control that does nothing.
  return canOpenSource && node.source !== undefined
    ? `${identity}. ${openSourceHint(node.source.file)}`
    : identity;
}

/**
 * How a relationship was known, as the suffix of its chip.
 *
 * Nothing for a measured relationship; ` (inferred)` when every record was
 * inferred; ` (1 of 3 inferred)` when only part of it was; and, when any of
 * those inferences had several candidates, the ambiguous share appended — for
 * example ` (inferred, 1 ambiguous)`. A partial inference is stated as a share
 * rather than as the word alone, because "inferred" on an edge that is mostly
 * measured would overstate the guess.
 */
function lineageSuffix(lineage: LineageTally | undefined): string {
  if (lineage === undefined || lineage.inferred === 0) {
    return '';
  }

  const share =
    lineage.inferred >= lineage.total
      ? INFERRED_LABEL
      : `${formatCount(lineage.inferred)} of ${formatCount(lineage.total)} ${INFERRED_LABEL}`;
  const ambiguity =
    lineage.ambiguous > 0 ? `, ${formatCount(lineage.ambiguous)} ${AMBIGUOUS_LABEL}` : '';

  return ` (${share}${ambiguity})`;
}

/**
 * A relationship chip's text: what is called, how often, and how it was known.
 *
 * The called participant is named in full. The chip wraps inside its cell
 * (`dg-dependency-graph__relationship`), so a long module path or route costs
 * a line rather than its identity — a shortened name here would be the only
 * place a relationship's target could not be read, since the chip is the
 * relationship's sole text form in the grid.
 */
function relationshipChipText(relationship: ParticipantRelationship): string {
  const repeats = relationship.edge.count > 1 ? ` ×${formatCount(relationship.edge.count)}` : '';
  return `${RELATIONSHIP_ARROW} ${relationship.targetLabel}${repeats}${lineageSuffix(relationship.lineage)}`;
}

/*
 * ---------------------------------------------------------------------------
 * The grid's cells
 *
 * Each is a function of its row and of nothing else, which is what lets the
 * column list below be a module constant: no cell reads component state or
 * context, so nothing about the grid is rebuilt — and no cell changes form —
 * when focus, the pointer or the selection moves. The row's own states
 * (`dg-is-active`, `dg-is-selected`) belong to the `DataTable` primitive and
 * change only colour, never the row's content or its size.
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

/** A participant's second line in the grid: its tier, when it has one, and its metrics. */
function participantDetailText(node: DependencyGraphNode): string {
  const metrics = participantMetricsText(node);
  return node.tier === undefined ? metrics : `${formatTierLabel(node.tier)} · ${metrics}`;
}

/**
 * The participant's label and detail, in ONE form in every state.
 *
 * The full label — never truncated, wrapped by the stylesheet
 * (`dg-dependency-graph__participant-label`) wherever it runs past the column —
 * with a muted line under it naming the tier and the metrics. The class is not
 * repeated: it is the next column, and it is that column and this text that
 * make the canvas colour non-essential.
 *
 * The form is the same whether the row holds keyboard focus, sits under the
 * pointer, is selected or none of these, and both halves of that are
 * load-bearing:
 *
 * - **Nothing is reachable by hover alone.** The grid's focus target is its
 *   row, so a tooltip on this label would never open for a keyboard user.
 *   Showing the detail in every row reaches it without a pointer and without a
 *   second tab stop.
 * - **A row never changes size on its way to a click.** A mouse press on the
 *   row's source chip focuses the chip before the button is released. Were this
 *   cell to answer that focus by growing — a longer label, an extra line — the
 *   row would grow with it and, because the grid centres a row's cells in the
 *   block axis, carry the chip out from under the pointer: the release would
 *   land on the row, and the click would select the participant instead of
 *   opening its source. Nothing in this view changes a row's content on focus,
 *   hover or selection, so that cannot happen.
 *
 * The label carries the participant's id in `data-participant-id`, as a
 * relationship chip carries its relationship's in `data-edge-id`, so the
 * participant a row stands for is legible in the markup without parsing the
 * label's text.
 */
function ParticipantCell({ row }: { readonly row: ParticipantRow }): ReactElement {
  const { node } = row;

  return (
    <Stack gap={1}>
      <Text
        size="sm"
        weight="medium"
        className="dg-dependency-graph__participant-label"
        data-participant-id={node.id}
      >
        {node.label}
      </Text>
      <Text size="xs" tone="muted">
        {participantDetailText(node)}
      </Text>
    </Stack>
  );
}

/**
 * Everything the participant calls, one chip each.
 *
 * Each chip carries the lineage state its curve on the canvas carries —
 * `dg-is-inferred` in the info tone, `dg-is-ambiguous` in the warning tone and
 * with a dashed outline, nothing for a measured relationship — and the words
 * themselves: the inferred share and the ambiguous part when either applies,
 * see {@link lineageSuffix}. So the distinction survives in text, where neither
 * a tone nor a dash pattern can reach: colour and pattern are never the sole
 * indicator.
 *
 * The chip is `dg-dependency-graph__relationship`, a class of its own rather
 * than the canvas curve's: the curve's rule is SVG paint (`fill`, `stroke`,
 * `pointer-events: none`) that means nothing on an HTML chip, and the chip
 * needs the one thing the shared chip rule withholds — permission to wrap — so
 * that a long called participant and its lineage suffix stay inside the cell
 * instead of running past its border. `data-edge-id` names the relationship.
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
          tone={LINEAGE_TONE[relationship.state]}
          variant="outline"
          className={clsx(
            'dg-dependency-graph__relationship',
            LINEAGE_STATE_CLASS[relationship.state],
          )}
          data-edge-id={relationship.edge.id}
        >
          {relationshipChipText(relationship)}
        </Badge>
      ))}
    </Stack>
  );
}

/**
 * Where the participant lives in the project, when a location resolved.
 *
 * The chip is `tabIndex={-1}`, as every control inside a `DataTable` cell must
 * be: the grid's active row is the view's one Tab stop, and the grid's own
 * cell navigation (ArrowRight or F2 from the row) is the keyboard route onto
 * the chip, where Enter and Space activate it natively. The pointer still
 * focuses and activates it in one click, which is what
 * {@link ParticipantCell}'s one form keeps working.
 */
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
  return <SourceLink location={source} compact tabIndex={-1} />;
}

/**
 * The columns of the participants grid, in reading order: where a participant
 * sits, what it is, how long it took, what it called, and where it lives.
 *
 * A module constant because every cell is a function of its row alone.
 *
 * Every column declares its width ROLE, never a size (`DataTableColumnWidth`
 * in `../primitives/DataTable`): `DataTable` resolves each role to a track
 * built from the design system's column floor and share tokens, the same track
 * every other table gives content of that kind, so no number here decides how
 * wide a column is. The roles follow the content:
 *
 * - **Layer** and **Total time** are figures — a short layer number and a
 *   formatted duration — so they take `status` and `quantity`, the compact
 *   roles that leave the spare width to the text columns.
 * - **Class** is a short categorical chip ("UI event", "Database"): `label`.
 * - **Participant** is `name`, the identifier role's wide share: it carries a
 *   full label and a detail line, both wrapped rather than truncated, so the
 *   extra share is spent where the text is.
 * - **Relationships** is `name` too, for the same reason: its chips name their
 *   full target and wrap rather than truncate, so a floor narrower than an
 *   identifier would break a typical `GET /api/… ×4` chip into fragments of a
 *   few characters and make its row several hundred pixels tall.
 * - **Source** is `name`, the role of a source-location chip.
 *
 * Every role track is a floor and a ratio, so it resolves identically in the
 * header and in every row, and `DataTable` sums the floors into the grid's
 * minimum width: a panel narrower than their sum scrolls the table
 * horizontally instead of squeezing the participant label a few characters
 * per line.
 */
const PARTICIPANT_COLUMNS: readonly DataTableColumn<ParticipantRow>[] = Object.freeze([
  {
    key: 'layer',
    header: 'Layer',
    align: 'end',
    width: 'status',
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
    width: 'name',
    cell: (row: ParticipantRow) => <ParticipantCell row={row} />,
  },
  {
    key: 'class',
    header: 'Class',
    width: 'label',
    cell: (row: ParticipantRow) => <ClassCell row={row} />,
  },
  {
    key: 'total-time',
    header: 'Total time',
    align: 'end',
    width: 'quantity',
    cell: (row: ParticipantRow) => <DurationCell ms={row.node.totalDurationMs} size="sm" />,
  },
  {
    key: 'relationships',
    header: 'Relationships',
    width: 'name',
    cell: (row: ParticipantRow) => <RelationshipsCell row={row} />,
  },
  {
    key: 'source',
    header: 'Source',
    width: 'name',
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

  // The panel's one shared selection under a host, this view's own last
  // activation outside one; and the local highlight of a participant that
  // stands for no single event, which yields as soon as that selection changes
  // (see "THE SELECTION IS THE PANEL'S" above).
  const { selection, markSelected } = useViewSelection();
  const [localHighlight, setLocalHighlight] = useState<LocalHighlight | undefined>(undefined);
  const [hoveredId, setHoveredId] = useState<string | undefined>(undefined);

  // `undefined` when the node names a source this view cannot draw, which stops
  // the query from being issued at all.
  const query = useMemo(() => graphQueryOf(node.query), [node.query]);

  const { status, data, error, announcement, retry } = useQuery(query);

  // The layout, as a pure function of the payload and nothing else: no element
  // is observed and no size is read, so one payload always draws the same
  // picture. The arrangement (one layering, the canonical ordering built from
  // that same object, and the column gap its count labels require) is
  // resolved exactly once per payload, and the geometry is built from it.
  const arrangement = useMemo(() => (data === undefined ? undefined : arrangeGraph(data)), [data]);
  const layout = useMemo(
    () =>
      arrangement === undefined
        ? undefined
        : layoutDependencyGraph(
            arrangement.graph,
            { columnGap: arrangement.columnGap },
            arrangement.layering,
          ),
    [arrangement],
  );
  const rows = useMemo(() => (layout === undefined ? NO_ROWS : buildRows(layout)), [layout]);
  const colourKey = useMemo(() => spanColourKey(rows), [rows]);
  const columns = useMemo(() => buildColumns(rows), [rows]);
  const inconsistent = useMemo(
    () =>
      layout === undefined ? NO_INCONSISTENT_DECLARATIONS : inconsistentDeclarationsOf(layout),
    [layout],
  );

  const selectedId = selectedParticipantIdOf(rows, selection, localHighlight);

  // Selecting a participant: what a row activation in the grid does (a click on
  // the row, Enter or Space), and the first half of a click on its shape. It
  // never opens source — in the grid that is the row's chip's job, and the
  // table does not treat a click on the chip as a row activation.
  const handleActivate = useCallback(
    (row: ParticipantRow): void => {
      // Reported only when the participant really carries an event coordinate;
      // see this module's header for why nothing is invented when it does not.
      // Such a participant becomes the panel's selection, and any local
      // highlight is dropped even when that event was already selected, so the
      // graph marks what the reader just activated.
      if (row.eventRef !== undefined) {
        setLocalHighlight(undefined);
        markSelected(row.eventRef);
        actions?.onSelectEvent(row.eventRef);
        return;
      }

      setLocalHighlight({ participantId: row.node.id, basis: selection });
    },
    [actions, markSelected, selection],
  );

  // A click on a participant's shape: the selection above, then — where the
  // participant resolved to a location — that location opened in the editor,
  // once. The object is the payload's own, handed over by reference and never
  // copied or normalised, because every hop after this one acts on the object
  // it receives (see `./SourceLink`). A collapse of several records carries no
  // event coordinate but may well carry a location, so the two are decided
  // independently.
  const handleNodeClick = useCallback(
    (row: ParticipantRow): void => {
      handleActivate(row);

      const { source } = row.node;
      if (source !== undefined) {
        actions?.onOpenSource(source);
      }
    },
    [actions, handleActivate],
  );

  // The hovered shape is highlighted on the canvas only. No grid cell reads it,
  // so a pointer crossing the picture never changes a row.
  const handleHover = useCallback((id: string): void => {
    setHoveredId(id);
  }, []);

  // Only the box that started the hover ends it, so a leave that arrives after
  // the pointer already entered a neighbouring box changes nothing.
  const handleHoverEnd = useCallback((id: string): void => {
    setHoveredId((current) => (current === id ? undefined : current));
  }, []);

  // The hover highlight is the one preview this view draws, and Escape
  // dismisses it without moving the pointer, focus or the selection (WCAG
  // 1.4.13) — until the pointer enters a box again. Nothing here previews on
  // focus: every grid row already shows its participant's full detail in one
  // form, so keyboard focus reveals nothing that would need dismissing.
  //
  // The pointer does not move focus, so while it rests on a box the key goes to
  // whatever holds focus — a grid row or the page body alike. The listener
  // therefore lives on the view's own document, for exactly as long as a box is
  // hovered; it consumes nothing, and it leaves alone an Escape something else
  // already handled.
  const hovering = hoveredId !== undefined;
  const blockRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hovering) {
      return undefined;
    }

    const ownerDocument = blockRef.current?.ownerDocument ?? document;
    const dismiss = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setHoveredId(undefined);
      }
    };

    ownerDocument.addEventListener('keydown', dismiss);
    return () => {
      ownerDocument.removeEventListener('keydown', dismiss);
    };
  }, [hovering]);

  const blockClass = clsx('dg-dependency-graph', className);

  // A defect in the panel rather than a failed request: the contract names what
  // this view reads next to what it was asked for, and offers no retry, because
  // asking again cannot change the answer.
  if (query === undefined) {
    return (
      <div className={blockClass}>
        <div className="dg-dependency-graph__error">
          <ErrorState {...unsupportedQueryProps(node.type, node.query)} />
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
          <ErrorState {...queryFailureProps({ error, announcement, retry }, query)} />
        </div>
      </div>
    );
  }

  if (data === undefined || layout === undefined || rows.length === 0) {
    return (
      <div className={blockClass}>
        <div className="dg-dependency-graph__empty">
          <EmptyState
            title={EMPTY_TITLE}
            message={EMPTY_MESSAGE}
            icon={<Workflow aria-hidden="true" className="dg-icon" />}
          />
        </div>
      </div>
    );
  }

  const canvas = canvasSize(layout);

  return (
    <div ref={blockRef} className={blockClass}>
      {/*
       * The key names all six classes in six distinct colours, each the
       * participant-class map's entry in `../utils/color.ts`. A participant
       * whose span kinds settle a colour of their own is drawn in that colour
       * instead - the colour the same spans have in every other view - so each
       * such colour follows the class chips as one more entry naming the kinds
       * drawn in it. Those entries carry no `data-kind`: they name span kinds,
       * not classes. Colour is never the only carrier either way: each chip
       * carries its name as text, and the grid below repeats every
       * participant's class in its class column.
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
        {colourKey.map((entry) => (
          <Badge
            key={entry.colorVar}
            tone="neutral"
            variant="soft"
            color={entry.colorVar}
            data-span-kinds={entry.kinds.join(' ')}
          >
            {spanColourKeyLabel(entry)}
          </Badge>
        ))}
      </Stack>

      {data.truncated ? (
        // Beside the canvas it qualifies rather than under the grid, in the
        // shape the timeline and the flame chart share: the badge, what is
        // drawn, and the way to see more.
        <Stack direction="horizontal" gap={2} align="center" wrap>
          <Badge tone="warning" variant="outline">
            {PARTIAL_RESULT_LABEL}
          </Badge>
          <Text as="p" size="xs" tone="muted">
            {truncatedNotice(layout.nodes.length)}
          </Text>
        </Stack>
      ) : null}

      {/*
       * The scroll viewport. Nothing reads its size: the canvas inside declares
       * the layout's own logical size, one user unit to a pixel at rest, and
       * the viewport scrolls a drawing larger than the panel.
       */}
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
           * BLITZY [A11Y]: the curves are drawn with the design system's edge
           * treatment, which `../styles/components.css` declares for
           * `dg-dependency-graph__edge`; its contrast against the canvas
           * surface is owned by the design tokens and tested with them, in
           * every theme, rather than decided here. This component writes no
           * colour, and no information depends on the stroke alone: every
           * relationship is also enumerated in text in the grid below, and an
           * inferred or ambiguous one is named there in words as well as
           * marked here — solid in the info tone, or dashed in the warning
           * tone — by the state class the stylesheet implements.
           */}
          <g className="dg-dependency-graph__edges">
            {layout.edges.map((positioned) => (
              <Fragment key={positioned.edge.id}>
                <path
                  className={clsx(
                    'dg-dependency-graph__edge',
                    LINEAGE_STATE_CLASS[lineageStateOf(usableLineageOf(positioned.edge))],
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
                    {edgeCountText(positioned.edge.count)}
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
                    handleNodeClick(row);
                  }}
                  onPointerEnter={() => {
                    handleHover(row.node.id);
                  }}
                  onPointerLeave={() => {
                    handleHoverEnd(row.node.id);
                  }}
                >
                  {/*
                   * The pointer user's label, as the user agent's own tooltip.
                   * The canvas is `role="img"` with a text alternative of its
                   * own, so this title is not what assistive technology reads -
                   * the grid below is - and the same detail is always drawn in
                   * this participant's grid row, so nothing in it is reachable
                   * by hover alone. Where a click also opens the participant's
                   * source, the title says so.
                   */}
                  <title>{participantTitle(row.node, actions !== undefined)}</title>
                  <rect
                    className={clsx(
                      'dg-dependency-graph__node',
                      KIND_CLASS[row.node.kind],
                      row.node.id === selectedId && 'dg-is-selected',
                      row.node.id === hoveredId && 'dg-is-hovered',
                    )}
                    style={nodeColorStyle(row.node)}
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
       * them would not be one. Every row already shows its participant's full
       * label and detail, so nothing here follows focus or the pointer.
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
        {layout.droppedEdgeCount > 0 ? (
          <Text as="p" size="xs" tone="warning">
            {droppedRelationshipsNote(layout.droppedEdgeCount)}
          </Text>
        ) : null}
        {inconsistent.coordinates > 0 ? (
          <Text as="p" size="xs" tone="warning">
            {inconsistentCoordinatesNote(inconsistent.coordinates)}
          </Text>
        ) : null}
        {inconsistent.lineages > 0 ? (
          <Text as="p" size="xs" tone="warning">
            {inconsistentLineagesNote(inconsistent.lineages)}
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
