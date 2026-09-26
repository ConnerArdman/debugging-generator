/**
 * `components/ComponentTree` — the colocated suite.
 *
 * ## What this suite is protecting
 *
 * The `componentTree` node draws a structure the capture could not always
 * observe completely, and that is what most of the cases below are about.
 *
 *   - **Accessibility is the substance, not a garnish.** AAP 0.6.4 names this
 *     component's shape explicitly: ARIA roles on the tree, full keyboard
 *     navigation, and a highlight that is never colour alone. So the tree's
 *     roles, its single roving tab stop — with the toggles and source chips kept
 *     out of the Tab order —, each of the seven navigation and selection keys
 *     it owns, the Shift+Enter command that opens a row's source, the words
 *     beside the highlight's icon and the badge a collapsed branch carries for
 *     the marks it hides are all asserted mechanically rather than described in
 *     a comment.
 *   - **A snapshot states its own limits (AAP 0.6.6).** The structure is taken
 *     at the last commit of a capture and cannot always be reconstructed, so
 *     `origin` and `degraded` are part of the answer. Two cases hold that line:
 *     a reconstructed, degraded snapshot must say both things on screen, and an
 *     `origin: "flat"` snapshot must render a **list** — no `role="group"`, no
 *     nesting — because a single level of nodes dressed as a tree claims a
 *     hierarchy nobody observed. That is the same class of error as an
 *     unevidenced fact in an analysis, which AAP 0.8.4 rules out structurally.
 *   - **Nothing is selected that does not exist.** A node of this datum is an
 *     aggregate; the producer names one real render to stand for it, and
 *     selecting the node reports exactly that reference with only the
 *     coordinates it carries, while a node that never rendered selects locally
 *     and reports nothing. The commit the structure came from is offered once,
 *     in the toolbar, and only when the capture recorded it. Every half is
 *     asserted, because a fabricated coordinate in an evidence drawer is worse
 *     than an absent one.
 *   - **A node's mark survives its own report.** The panel host records the
 *     reported render as the panel's selection, so the selection after a click
 *     is not the one the node was activated under. The shared-selection cases
 *     drive that transition — through a harness that records reports as the
 *     host does, and through the real `PanelHost`, both self-kept and driven by
 *     `selectedEventId` a step behind — and assert the clicked row stays marked,
 *     that any other selection takes the mark away, and that a return to the
 *     pre-click selection does not bring it back.
 *   - **Selecting is not disclosing.** A click on a row and Enter/Space select
 *     it and never toggle it; the toggle, ArrowRight/ArrowLeft and the toolbar
 *     disclose, and are asserted to keep doing so.
 *   - **Names and counts only (AAP 0.5.2).** Prop and state values are
 *     structurally absent from the datum. One case renders a payload that
 *     smuggles them in anyway and asserts they never reach the DOM, and another
 *     pins a row's complete text, so a prop or state inspector cannot be added
 *     here without failing this file.
 *   - **A large structure stays bounded.** This source answers with one object
 *     and no paging (AAP 0.4.2), so the default expansion policy is the only
 *     bound available; the last case asserts the rendered rows are a small
 *     fraction of the nodes the snapshot reports.
 *
 * Alongside those, AAP 0.8.3 asks every component suite here for the three
 * states of a query-backed view — loading, empty and error — and for the
 * click-to-source payload. Each state is driven through a stub `DataProvider`
 * that respectively never settles, resolves an empty snapshot and rejects; the
 * payload case asserts what the host actually receives, because every hop after
 * this one acts blind on the object it is handed (AAP 0.4.2, hop 2 of five).
 *
 * ## Harness conventions (shared with `./SpanTable.test.tsx`)
 *
 *   - **Test API imported explicitly** from `vitest`. The `panel-renderer`
 *     project does enable `globals`, but only so `@testing-library/react` can
 *     register its automatic cleanup on a global `afterEach`; every suite in
 *     this repository still names what it uses.
 *   - **`afterEach(cleanup)` registered explicitly**, for the same reason: a
 *     suite that leaks a mounted tree between cases fails later with a
 *     multiple-match error that reads like a component bug.
 *   - **Stub providers are built with the library's own `createDataProvider`**,
 *     so these cases exercise the very seam the DevTools panel and the editor
 *     webview implement. The resolver is a `vi.fn`, and every query it receives
 *     is recorded: what the component *asked for* is as much of its contract as
 *     what it drew.
 *   - **In-file synthetic builders, no fixture files.** {@link makeTreeNode},
 *     {@link makeSnapshot} and {@link makeNode} take overrides; nothing here is
 *     read from disk or shared with another suite.
 *   - **Generic fixture vocabulary only** (AAP 0.5.4): component names, a file
 *     path and a symbol that belong to no application, demonstration or
 *     otherwise. `scripts/check-no-hardcoding.mjs` scans this text with the rest
 *     of `packages/**`.
 *   - **Queries by role and accessible name.** The tree, its rows, its child
 *     groups, the toolbar controls and the source chips are all reached that
 *     way; a class is read only off an element already obtained semantically,
 *     since no `jest-dom` matcher is available in this repository.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…`, interactions through
 *     `userEvent`, and the one focus move a test makes itself is wrapped in
 *     `act` so React's own state update is flushed with it.
 *
 * `ComponentTreeNode` names two different things in this product, and this file
 * imports both: the panel **spec** node that selects the component, aliased to
 * `ComponentTreeNodeSpec`, and the **telemetry** datum it draws, unaliased —
 * matching the component under test. Types only: the producer's
 * `buildComponentTreeSnapshot` is never called, because a renderer suite that
 * built its input through the producer would stop failing when either of them
 * drifted.
 *
 * @see ./ComponentTree for the component, its states and its ARIA contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 */

import { PANEL_SPEC_VERSION } from '@debuggen/panel-schema';
import type {
  ComponentTreeNode as ComponentTreeNodeSpec,
  DataQuery,
  PanelSpec,
} from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import { COMPONENT_TREE_NODE_ID_PREFIX } from '@debuggen/telemetry';
import type {
  ComponentTreeNode,
  ComponentTreeOrigin,
  ComponentTreeSnapshot,
  RenderTrigger,
} from '@debuggen/telemetry';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext, PanelSelectionContext, usePanelActions } from '../host/PanelActions';
import { PanelHost } from '../host/PanelHost';
import type {
  PanelActions,
  PanelEventRef,
  PanelSelection,
  PanelEventCoordinates,
} from '../host/PanelActions';
import { formatCount, formatDurationCompact, formatRenderTriggerLabel } from '../utils/format';
import { ComponentTree } from './ComponentTree';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Every string below is application-neutral (AAP 0.5.4): no component, route,
 * service or symbol of any inspected project appears here, in the fixtures or
 * in the comments. The identifiers are shaped as the capture shapes them — node
 * ids carry the producer's own prefix, the timestamp is epoch milliseconds, the
 * source path is project-relative and POSIX — because the component reads those
 * fields and formats them.
 * ---------------------------------------------------------------------------
 */

/** The identity of the node under test, as a normaliser would assign it. */
const NODE_ID = 'layout.0.componentTree';

/** The one query this node type may carry, spelled once. */
const TREE_QUERY: DataQuery = { source: 'componentTree' };

/**
 * The moment the structure was observed, in Unix epoch milliseconds:
 * 2026-01-01T00:00:00Z. Inside the window the event schema accepts, and far
 * enough from zero that a relative performance timestamp could not be mistaken
 * for one.
 */
const CAPTURED_AT = 1_767_225_600_000;

/** The commit the structure came from: a 32-hex trace and a 16-hex span. */
const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const COMMIT_SPAN_ID = '00000000000000c1';
const COMMIT_EVENT_ID = 'event-example-commit-0001';

/**
 * The representative render of the second-level branch: the render that
 * supplied its last trigger, as the producer names it, with its span and trace.
 */
const BRANCH_RENDER_EVENT_ID = 'event-example-render-0002';
const BRANCH_RENDER_SPAN_ID = '00000000000000b2';

/**
 * The representative render of the located leaf, carried **without** its span
 * and trace: a payload the view must forward with the one coordinate present,
 * never with keys whose value is `undefined`.
 */
const LEAF_RENDER_EVENT_ID = 'event-example-render-0003';

/** What the host hears when the branch is selected. */
const BRANCH_RENDER_REF: PanelEventRef = Object.freeze({
  eventId: BRANCH_RENDER_EVENT_ID,
  spanId: BRANCH_RENDER_SPAN_ID,
  traceId: TRACE_ID,
});

/** A project-relative, POSIX path for the node that resolved to source. */
const SOURCE_FILE = 'src/example/widget.tsx';

/** The symbol at that location, and its 1-based coordinates. */
const SOURCE_SYMBOL = 'ExampleLeaf';
const SOURCE_LINE = 84;
const SOURCE_COLUMN = 9;

/**
 * A complete, resolved location for the click-to-source cases.
 *
 * Held as one frozen value so the payload assertions can compare **identity**
 * as well as contents: the component's contract is to forward the object it was
 * given, field for field and without rewriting a path or adjusting a coordinate
 * (AAP 0.4.2, `PanelActions` hop 2).
 */
const LEAF_SOURCE: SourceLocation = Object.freeze({
  file: SOURCE_FILE,
  line: SOURCE_LINE,
  column: SOURCE_COLUMN,
  symbol: SOURCE_SYMBOL,
  resolvedBy: 'react-owner',
  confidence: 0.8,
});

/** The accessible name the source chip announces (`SourceLink`'s own shape). */
const SOURCE_CHIP_NAME = `Open ${SOURCE_FILE}:${String(SOURCE_LINE)}:${String(SOURCE_COLUMN)}`;

/**
 * A second resolved location, for a **branch** row.
 *
 * Enter selects a row rather than opening anything, so the Shift+Enter command
 * is the keyboard route to a row's source — and on a branch it must also leave
 * the disclosure alone. Frozen for the same identity assertions as
 * {@link LEAF_SOURCE}.
 */
const BRANCH_SOURCE_FILE = 'src/example/section.tsx';
const BRANCH_SOURCE_LINE = 12;
const BRANCH_SOURCE_COLUMN = 3;
const BRANCH_SOURCE: SourceLocation = Object.freeze({
  file: BRANCH_SOURCE_FILE,
  line: BRANCH_SOURCE_LINE,
  column: BRANCH_SOURCE_COLUMN,
  symbol: 'ExampleBranch',
  resolvedBy: 'react-owner',
  confidence: 0.8,
});

/** The branch chip's accessible name. */
const BRANCH_SOURCE_CHIP_NAME = `Open ${BRANCH_SOURCE_FILE}:${String(BRANCH_SOURCE_LINE)}:${String(
  BRANCH_SOURCE_COLUMN,
)}`;

/** The row command that opens a row's source, as `aria-keyshortcuts` spells it. */
const OPEN_SOURCE_SHORTCUT = 'Shift+Enter';

/**
 * The one-line hint in the note, as its text content reads: the `Kbd` chord
 * contributes its keys and the separator between them.
 */
const OPEN_SOURCE_HINT = 'Press Shift+Enter on a row to open its source.';

/*
 * The product copy these cases pin.
 *
 * Spelled out here rather than imported from the component: a suite that read
 * the same constant the component renders would assert only that a string is
 * equal to itself. These are the words a developer reads, and changing one
 * should require changing this file too.
 */

/** The tree's accessible name, which falls back to the node catalog's label. */
const TREE_NAME = 'Component tree';

/** The flat listing's accessible name, which is not the tree's. */
const LIST_NAME = 'Captured components';

/** The threshold field, the two bulk disclosure chips and the commit action. */
const THRESHOLD_FIELD_NAME = 'Mark at renders ≥';

/**
 * The full reason for text that names no threshold — the field's description
 * and live region — completed with the derived default that applies meanwhile.
 */
function thresholdRejectedText(derived: number): string {
  return `Enter a whole number of at least ${formatCount(1)}. The default of ${formatCount(
    derived,
  )} applies until then.`;
}

/** The toolbar pill's short form of the same: the default in force. */
function defaultInForceText(derived: number): string {
  return `Using the default of ${formatCount(derived)}`;
}

const EXPAND_ALL_NAME = 'Expand all';
const COLLAPSE_ALL_NAME = 'Collapse all';
const SHOW_COMMIT_NAME = 'Show the commit';

/** The toolbar's own accessible name, which makes it a labelled group. */
const TOOLBAR_NAME = 'Component tree controls';

/**
 * The non-colour half of the threshold highlight. "At or above", because the
 * rule is `≥` — the field's own label says so.
 */
const AT_OR_ABOVE_THRESHOLD_TEXT = 'At or above threshold';

/**
 * The badge a collapsed branch carries for the marked nodes beneath it.
 *
 * @param hidden How many marked nodes the closed branch hides, at every depth.
 * @returns The badge's text.
 */
function hiddenMarkedText(hidden: number): string {
  return `${formatCount(hidden)} hidden at or above threshold`;
}

/** The error state's retry control and the name it gives the failing query. */
const RETRY_NAME = 'Retry';
const FAILING_QUERY_NAME = 'Failing query';

/** The announcement the skeleton state makes while the query is unsettled. */
const LOADING_LABEL = 'Loading the component tree…';

/** The three origin badges, and the explanation each one carries. */
const CAPTURED_ORIGIN_LABEL = 'Captured structure';
const RECONSTRUCTED_ORIGIN_LABEL = 'Reconstructed structure';
const FLAT_ORIGIN_LABEL = 'Flat listing';
const CAPTURED_ORIGIN_DETAIL =
  'The runtime serialized this structure itself, at the last commit of the capture.';
const RECONSTRUCTED_ORIGIN_DETAIL =
  'Rebuilt from the components that rendered during the capture, so anything that did not render is missing from it.';
const FLAT_ORIGIN_DETAIL =
  'No hierarchy could be rebuilt, so every observed component is listed at a single level.';

/**
 * The shared error-state contract, spelled out rather than imported so a drift
 * in the one place that words it fails here too (B1-F16, B2-F14): the title of
 * a failed view, the generic lead its message opens with, the title of a query
 * this view cannot draw and the focus key its retry control carries.
 */
const ERROR_TITLE = 'Could not load this view';
const ERROR_LEAD = 'The data for this view could not be loaded.';
const UNSUPPORTED_TITLE = 'This view cannot draw the requested data';
const RETRY_FOCUS_KEY = 'error-state-retry';

/**
 * A provider's own failure message, which reaches the screen as the cause
 * after the generic lead: the lead alone would hide what failed, and an error
 * state reports what failed without reading like an analysis (AAP 0.5.5).
 */
const PROVIDER_FAILURE_MESSAGE = 'The channel to the service is closed.';

/** The code that failure carries, from the shared error vocabulary. */
const PROVIDER_FAILURE_CODE = 'TRANSPORT_DISCONNECTED';

/** What a reader can do about that failure, as the provider states it. */
const PROVIDER_FAILURE_HINT = 'Start the local service, then retry.';

/** The code a payload this view cannot read is reported with. */
const SHAPE_FAILURE_CODE = 'PROTOCOL_INVALID_MESSAGE';

/** The empty state's message, matched by a generic fragment of the product copy. */
const EMPTY_MESSAGE_PATTERN = /no component tree was captured/i;

/**
 * Two values smuggled onto a node that has no field for either.
 *
 * The datum carries names, keys, counts, a duration, a trigger and a location —
 * prop and state **values are structurally absent**, which is the privacy
 * guarantee rather than an omission (AAP 0.5.2). These strings prove the view
 * renders only what its type gave it.
 */
const SMUGGLED_PROP_VALUE = 'prop-value-that-must-never-render';
const SMUGGLED_STATE_VALUE = 'state-value-that-must-never-render';

/**
 * The toolbar's count of marked rows, as the status chip spells it.
 *
 * @param marked How many rows carry the mark.
 * @returns The chip's text.
 */
function markedStatus(marked: number): string {
  return `${formatCount(marked)} at or above threshold`;
}

/**
 * A counted unit in the form the count calls for: singular for exactly one.
 *
 * Restated here rather than imported, like the copy above: the suite pins the
 * words a developer reads, "1 node" and "2 nodes", not a helper's output.
 *
 * @param count The count the unit follows.
 * @param one The singular form.
 * @param other The plural form.
 * @returns The agreeing form.
 */
function counted(count: number, one: string, other: string): string {
  return `${formatCount(count)} ${count === 1 ? one : other}`;
}

/**
 * The statistics line, as the note above the tree spells it.
 *
 * Built from the snapshot's own counters and the number of rows on screen,
 * because the component states all three rather than implying completeness from
 * whatever happens to be visible (AAP 0.6.6).
 *
 * @param snapshot The snapshot being drawn.
 * @param shown How many rows are on screen.
 * @returns The line's text.
 */
function statisticsLine(snapshot: ComponentTreeSnapshot, shown: number): string {
  return [
    counted(snapshot.nodeCount, 'node', 'nodes'),
    counted(snapshot.maxDepth + 1, 'level', 'levels'),
    `${formatCount(shown)} shown`,
  ].join(' · ');
}

/** The two notes a snapshot raises about its own completeness. */
const DEGRADED_NOTE = 'This structure is known to be incomplete — read it as partial evidence.';
const TRUNCATED_NOTE = 'Some nodes were dropped when a size bound was reached.';

/** Always shown: the snapshot is a moment with history attached. */
const PROVENANCE_NOTE =
  'Structure as it stood at the last commit of the capture; render counts are cumulative for the whole capture.';

/**
 * The units the row's two numeric cells announce to a screen reader; the count
 * agrees with its number, so one render is `render` and any other is `renders`.
 */
const RENDER_UNIT = 'render';
const RENDERS_UNIT = 'renders';
const RENDER_TIME_UNIT = 'total render time';

/** The element classes this component contributes, read off semantic elements. */
const LOADING_CLASS = 'dg-component-tree__loading';
const ERROR_CLASS = 'dg-component-tree__error';
const EMPTY_CLASS = 'dg-component-tree__empty';
const LABEL_CLASS = 'dg-component-tree__label';
const COUNT_CLASS = 'dg-component-tree__count';
const HIGHLIGHTED_CLASS = 'dg-is-highlighted';

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 * ---------------------------------------------------------------------------
 */

/**
 * The optional fields of a tree node admit `undefined` explicitly, which
 * `Partial` does not under this repository's `exactOptionalPropertyTypes`:
 * passing `{ source: undefined }` is how a case asks for a node *without* a
 * location, and {@link makeTreeNode} drops the key rather than storing the
 * value.
 */
type TreeNodeOverrides = Partial<
  Pick<ComponentTreeNode, 'id' | 'component' | 'depth' | 'renderCount' | 'totalDurationMs'>
> & {
  readonly key?: string | undefined;
  readonly lastTrigger?: RenderTrigger | undefined;
  readonly lastRenderEventId?: string | undefined;
  readonly lastRenderSpanId?: string | undefined;
  readonly lastRenderTraceId?: string | undefined;
  readonly source?: SourceLocation | undefined;
  readonly children?: readonly ComponentTreeNode[] | undefined;
};

/**
 * One node of a component-tree snapshot.
 *
 * Complete and datum-shaped by construction: an id carrying the producer's own
 * prefix, a display name, the node's depth, a cumulative render count and a
 * cumulative render time. The optional fields — instance key, last trigger,
 * the representative render's ids, source location, children — are present
 * only when a case asks for them.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh node; nothing is shared between calls.
 */
function makeTreeNode(overrides: TreeNodeOverrides = {}): ComponentTreeNode {
  const {
    id = `${COMPONENT_TREE_NODE_ID_PREFIX}0`,
    component = 'ExampleRoot',
    depth = 0,
    renderCount = 3,
    totalDurationMs = 12,
    key,
    lastTrigger,
    lastRenderEventId,
    lastRenderSpanId,
    lastRenderTraceId,
    source,
    children = [],
  } = overrides;

  return {
    id,
    component,
    depth,
    renderCount,
    totalDurationMs,
    children,
    ...(key === undefined ? {} : { key }),
    ...(lastTrigger === undefined ? {} : { lastTrigger }),
    ...(lastRenderEventId === undefined ? {} : { lastRenderEventId }),
    ...(lastRenderSpanId === undefined ? {} : { lastRenderSpanId }),
    ...(lastRenderTraceId === undefined ? {} : { lastRenderTraceId }),
    ...(source === undefined ? {} : { source }),
  };
}

/** Every node of a structure, in traversal order, for the derived counters. */
function flattenNodes(roots: readonly ComponentTreeNode[]): readonly ComponentTreeNode[] {
  return roots.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

/**
 * The greatest node depth a structure reaches, as `maxDepth` counts it.
 *
 * A single level of roots reports `0`, matching the producer's own definition —
 * which is why a leaf contributes its own depth rather than one more: an
 * off-by-one here would make every fixture disagree with the counters the view
 * prints, and the statistics assertions would then pass against the wrong
 * number.
 */
function deepestDepth(roots: readonly ComponentTreeNode[], depth = 0): number {
  return roots.reduce(
    (deepest, node) =>
      Math.max(
        deepest,
        node.children.length === 0 ? depth : deepestDepth(node.children, depth + 1),
      ),
    depth,
  );
}

/** Overrides accepted by {@link makeSnapshot}, with the same `undefined` policy. */
type SnapshotOverrides = Partial<
  Pick<
    ComponentTreeSnapshot,
    'capturedAt' | 'origin' | 'degraded' | 'roots' | 'nodeCount' | 'maxDepth' | 'truncated'
  >
> & {
  readonly commitEventId?: string | undefined;
  readonly commitSpanId?: string | undefined;
  readonly traceId?: string | undefined;
};

/**
 * A component-tree snapshot around the roots a case supplies.
 *
 * `nodeCount` and `maxDepth` are **derived from the structure** unless a case
 * overrides them, and that default matters: the component states a note when
 * the nodes it can read do not add up to the count the snapshot reports, so a
 * fixture with an inconsistent count would raise a caveat every unrelated case
 * would then have to tolerate. `degraded` follows the origin by the producer's
 * own rule — a flat listing is always degraded — again unless a case says
 * otherwise, which is exactly what the honesty cases do.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh snapshot.
 */
function makeSnapshot(overrides: SnapshotOverrides = {}): ComponentTreeSnapshot {
  const {
    capturedAt = CAPTURED_AT,
    origin = 'commit-snapshot',
    roots = [],
    degraded = origin !== 'commit-snapshot',
    nodeCount = flattenNodes(roots).length,
    maxDepth = deepestDepth(roots),
    truncated = false,
    commitEventId,
    commitSpanId,
    traceId,
  } = overrides;

  return {
    capturedAt,
    origin,
    degraded,
    roots,
    nodeCount,
    maxDepth,
    truncated,
    ...(commitEventId === undefined ? {} : { commitEventId }),
    ...(commitSpanId === undefined ? {} : { commitSpanId }),
    ...(traceId === undefined ? {} : { traceId }),
  };
}

/** Overrides accepted by {@link makeNode}, with the same `undefined` policy. */
type NodeOverrides = Partial<Pick<ComponentTreeNodeSpec, 'id' | 'query'>> & {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/**
 * A normalised `componentTree` node, as the panel normaliser produces one: an
 * id derived from its position in the layout, no heading of its own, and the
 * single data source this node type may read.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): ComponentTreeNodeSpec {
  const { id = NODE_ID, query = TREE_QUERY, title, description } = overrides;

  return {
    type: 'componentTree',
    id,
    query,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
}

/**
 * A snapshot built for one construction route, for the honesty cases.
 *
 * Exists so those cases name the route they are about — the closed origin
 * vocabulary is the subject of the assertion, not an incidental field — and so
 * that adding a fourth member to that vocabulary makes this call site the place
 * the compiler asks about.
 *
 * @param origin The construction route the snapshot reports.
 * @param extra Further fields, applied over the origin-derived defaults.
 * @returns A fresh snapshot.
 */
function snapshotWithOrigin(
  origin: ComponentTreeOrigin,
  extra: SnapshotOverrides = {},
): ComponentTreeSnapshot {
  return makeSnapshot({ origin, ...extra });
}

/*
 * ---------------------------------------------------------------------------
 * The structures these cases draw
 *
 * Two of them, and the difference between them is the render counts rather than
 * the shape, because the threshold is derived from the counts: the structural
 * and keyboard cases need a structure where **nothing** is marked, so that the
 * rows on screen are decided by the default expansion policy alone, while the
 * threshold cases need one where exactly one node is marked.
 * ---------------------------------------------------------------------------
 */

/**
 * A leaf with a resolved location: the one node that offers a source chip. Its
 * representative render carries an event id and nothing else.
 */
const LEAF_NODE = makeTreeNode({
  id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0/0`,
  component: 'ExampleLeaf',
  depth: 2,
  renderCount: 3,
  totalDurationMs: 6,
  lastTrigger: 'context',
  lastRenderEventId: LEAF_RENDER_EVENT_ID,
  source: LEAF_SOURCE,
});

/** Its sibling, with no location, so a case can select a row without a chip. */
const SIBLING_NODE = makeTreeNode({
  id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0/1`,
  component: 'ExampleSibling',
  depth: 2,
  renderCount: 3,
  totalDurationMs: 4,
  key: 'example-key-1',
});

/**
 * The second-level parent: collapsed on first paint, which the key cases need,
 * and carrying a complete representative render — event, span and trace — so
 * the selection cases can prove a branch reports it without being toggled.
 */
const BRANCH_NODE = makeTreeNode({
  id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0`,
  component: 'ExampleBranch',
  depth: 1,
  renderCount: 3,
  totalDurationMs: 9,
  lastRenderEventId: BRANCH_RENDER_EVENT_ID,
  lastRenderSpanId: BRANCH_RENDER_SPAN_ID,
  lastRenderTraceId: TRACE_ID,
  children: [LEAF_NODE, SIBLING_NODE],
});

/**
 * A first-level leaf, so the top level holds both a parent and a leaf. It names
 * no representative render, so selecting it must stay local and report nothing
 * — the view never borrows another node's reference or invents one.
 */
const ASIDE_NODE = makeTreeNode({
  id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/1`,
  component: 'ExampleAside',
  depth: 1,
  renderCount: 3,
  totalDurationMs: 3,
});

/** The root of the three-level structure. */
const ROOT_NODE = makeTreeNode({
  id: `${COMPONENT_TREE_NODE_ID_PREFIX}0`,
  component: 'ExampleRoot',
  depth: 0,
  renderCount: 3,
  totalDurationMs: 24,
  children: [BRANCH_NODE, ASIDE_NODE],
});

/**
 * The structure with uniform counts.
 *
 * Every node reports three renders, so the derived threshold — twice the median
 * and at least one render above it — lands at six and marks nothing. That is
 * what makes the structural and keyboard cases deterministic: only the roots
 * open on first paint, because no marked node pulls a deeper branch open.
 */
const UNIFORM_STRUCTURE: readonly ComponentTreeNode[] = [ROOT_NODE];

/** The three rows visible on first paint, in document order. */
const INITIAL_ROW_NAMES: readonly string[] = ['ExampleRoot', 'ExampleBranch', 'ExampleAside'];

/** Every row of {@link UNIFORM_STRUCTURE}, in document order, fully expanded. */
const EXPANDED_ROW_NAMES: readonly string[] = [
  'ExampleRoot',
  'ExampleBranch',
  'ExampleLeaf',
  'ExampleSibling',
  'ExampleAside',
];

/**
 * The same shape with uneven counts: one node far above the others.
 *
 * Per-component counts of 1, 2, 4 and 40 give a median of 3 and therefore a
 * derived threshold of 6, which marks the leaf alone — and, because every
 * ancestor of a marked node opens, puts that finding on screen without a
 * gesture.
 */
const UNEVEN_STRUCTURE: readonly ComponentTreeNode[] = [
  makeTreeNode({
    id: `${COMPONENT_TREE_NODE_ID_PREFIX}0`,
    component: 'ExampleRoot',
    depth: 0,
    renderCount: 2,
    totalDurationMs: 8,
    children: [
      makeTreeNode({
        id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0`,
        component: 'ExampleBranch',
        depth: 1,
        renderCount: 4,
        totalDurationMs: 16,
        children: [
          makeTreeNode({
            id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0/0`,
            component: 'ExampleLeaf',
            depth: 2,
            renderCount: 40,
            totalDurationMs: 120,
            lastTrigger: 'context',
          }),
          makeTreeNode({
            id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0/1`,
            component: 'ExampleSibling',
            depth: 2,
            renderCount: 1,
            totalDurationMs: 2,
          }),
        ],
      }),
    ],
  }),
];

/** The threshold the uneven structure derives, and the marks it produces. */
const UNEVEN_DERIVED_THRESHOLD = 6;

/**
 * The uniform shape again, with the location on the **branch** instead of the
 * leaf.
 *
 * Every node reports three renders, so nothing is marked and only the root
 * opens: the branch that carries the location is on screen and closed, which is
 * what the Shift+Enter cases need to prove the command opens the source without
 * toggling the row.
 */
const SOURCED_BRANCH_STRUCTURE: readonly ComponentTreeNode[] = [
  makeTreeNode({
    id: `${COMPONENT_TREE_NODE_ID_PREFIX}0`,
    component: 'ExampleRoot',
    depth: 0,
    renderCount: 3,
    totalDurationMs: 24,
    children: [
      makeTreeNode({
        id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0`,
        component: 'ExampleBranch',
        depth: 1,
        renderCount: 3,
        totalDurationMs: 9,
        source: BRANCH_SOURCE,
        children: [
          makeTreeNode({
            id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0/0`,
            component: 'ExampleLeaf',
            depth: 2,
            renderCount: 3,
            totalDurationMs: 6,
          }),
        ],
      }),
      makeTreeNode({
        id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/1`,
        component: 'ExampleAside',
        depth: 1,
        renderCount: 3,
        totalDurationMs: 3,
      }),
    ],
  }),
];

/** The branch's own id, as the host hears it in a disclosure report. */
const SOURCED_BRANCH_ID = `${COMPONENT_TREE_NODE_ID_PREFIX}0/0`;

/** Nodes in each chain of {@link DEEP_STRUCTURE}, and how many chains it has. */
const DEEP_CHAIN_LENGTH = 12;
const DEEP_CHAIN_COUNT = 3;

/**
 * One chain of single-child nodes, for the bounded-rendering case.
 *
 * Every node reports one render and a distinct component name, so the derived
 * threshold marks nothing and the default expansion policy — the roots, plus
 * the ancestors of anything marked — opens the top level only.
 *
 * @param chain Which chain this is, so ids and names stay unique.
 * @param level The node's depth in the structure.
 * @param remaining Nodes still to append below this one, including it.
 * @returns The head of the chain.
 */
function makeChain(chain: number, level: number, remaining: number): ComponentTreeNode {
  return makeTreeNode({
    id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/${String(chain)}/${String(level)}`,
    component: `ExampleNode${String(chain)}x${String(level)}`,
    depth: level,
    renderCount: 1,
    totalDurationMs: 1,
    children: remaining <= 1 ? [] : [makeChain(chain, level + 1, remaining - 1)],
  });
}

/** A root with three deep chains beneath it: many nodes, one visible level. */
const DEEP_STRUCTURE: readonly ComponentTreeNode[] = [
  makeTreeNode({
    id: `${COMPONENT_TREE_NODE_ID_PREFIX}0`,
    component: 'ExampleRoot',
    depth: 0,
    renderCount: 1,
    totalDurationMs: 2,
    children: Array.from({ length: DEEP_CHAIN_COUNT }, (_unused, chain) =>
      makeChain(chain, 1, DEEP_CHAIN_LENGTH),
    ),
  }),
];

/** Nodes the deep structure holds, and rows the policy puts on screen. */
const DEEP_NODE_COUNT = 1 + DEEP_CHAIN_COUNT * DEEP_CHAIN_LENGTH;
const DEEP_VISIBLE_ROWS = 1 + DEEP_CHAIN_COUNT;

/*
 * ---------------------------------------------------------------------------
 * Stub providers
 *
 * Built through `createDataProvider`, the factory the library publishes for
 * exactly this shape: one resolver answering every query. Two things come with
 * it — the single type assertion the generic `DataProvider.query` signature
 * would otherwise force into this file, and the factory's own check that a
 * response answers for the source it was asked about.
 * ---------------------------------------------------------------------------
 */

/** A stub provider, the queries it has received and the resolver behind it. */
interface StubProvider {
  /** The provider to hand to {@link renderComponent}. */
  readonly provider: DataProvider;

  /**
   * Every query the component has asked for, in call order.
   *
   * The assertion surface for the retry and no-request cases: what the
   * component *requested* is as much of its contract as what it rendered.
   */
  readonly queries: readonly DataQuery[];

  /** The recorded resolver, for call counts. */
  readonly resolve: Mock<DataQueryResolver>;
}

/**
 * A provider whose answers are computed per call.
 *
 * @param respond Called with each query and the 1-based number of the call.
 * @returns The stub, its recorded queries and its resolver.
 */
function recordingProvider(
  respond: (query: DataQuery, call: number) => Promise<DataQueryResponse>,
): StubProvider {
  const queries: DataQuery[] = [];
  const resolve = vi.fn<DataQueryResolver>((query) => {
    queries.push(query);

    return respond(query, queries.length);
  });

  return { provider: createDataProvider(resolve), queries, resolve };
}

/**
 * A provider that resolves the same snapshot for every query.
 *
 * @param snapshot The snapshot to answer with.
 * @returns The stub provider.
 */
function resolvingProvider(snapshot: ComponentTreeSnapshot): StubProvider {
  return recordingProvider(() =>
    Promise.resolve<DataQueryResponse>({ source: 'componentTree', data: snapshot }),
  );
}

/**
 * A provider whose promise never settles — the loading state, with no timer.
 *
 * @returns The stub provider.
 */
function pendingProvider(): StubProvider {
  return recordingProvider(() => new Promise<DataQueryResponse>(() => undefined));
}

/**
 * A provider that rejects every query.
 *
 * Rejects with a `DebuggenError` because that is what the interface asks an
 * implementation for: the code and hint it carries are what the error state
 * renders (AAP 0.5.5).
 *
 * @param error The failure to reject with.
 * @returns The stub provider.
 */
function rejectingProvider(error: DebuggenError): StubProvider {
  return recordingProvider(() => Promise.reject(error));
}

/*
 * The four payloads that violate their own type.
 *
 * This file contains exactly four type assertions — {@link MALFORMED_PAYLOAD},
 * {@link INCOMPLETE_PAYLOAD}, {@link SMUGGLED_NODE} and {@link UNMEASURED_NODE}
 * — and each one is the
 * subject of a case rather than a convenience. The component guards its input
 * at runtime because it is the end of a chain it does not control: a host
 * surface decodes the payload from a transport, and a producer writes the nodes.
 * Those guards can only be tested with values the compiler would otherwise
 * refuse, so the assertions are gathered here, named, and used nowhere else.
 */

/**
 * A payload of the wrong shape, for the guard that refuses to draw one.
 *
 * The resolver's return type promises a snapshot, and the case being tested is
 * precisely a provider that broke that promise — a transport that decoded
 * something else, or a route that answered from the wrong aggregate.
 *
 * It carries every member the host's response check requires — an own
 * `capturedAt`, `origin`, `degraded` and `nodeCount` and an array `roots`,
 * which is all that check confirms without walking the structure — but
 * `degraded` is not a boolean. So it is the component's own guard that refuses
 * it, whatever the host checks upstream.
 */
const MALFORMED_PAYLOAD = {
  capturedAt: CAPTURED_AT,
  origin: 'commit-snapshot',
  degraded: 'unknown',
  nodeCount: 0,
  roots: [],
} as unknown as ComponentTreeSnapshot;

/**
 * A payload missing members this view reads, for the host's response check.
 *
 * Only a snapshot's envelope — an own `capturedAt` and an array `roots` — and
 * none of `origin`, `degraded` and `nodeCount`. The host's check requires each
 * of them, so it refuses this answer before the view sees it, and the refusal
 * reaches the view as an ordinary failed query.
 */
const INCOMPLETE_PAYLOAD = {
  capturedAt: CAPTURED_AT,
  roots: [],
} as unknown as ComponentTreeSnapshot;

/**
 * A node carrying fields the datum has no place for.
 *
 * Shaped like something a future producer — or a bug in one — might attach: the
 * fiber's props and its hook state. The privacy case asserts neither value
 * reaches the DOM, which is only a guarantee if the component renders strictly
 * the fields it was designed around.
 */
const SMUGGLED_NODE = {
  ...makeTreeNode({
    id: `${COMPONENT_TREE_NODE_ID_PREFIX}0`,
    component: 'ExampleRoot',
    renderCount: 2,
    totalDurationMs: 4,
  }),
  props: { label: SMUGGLED_PROP_VALUE },
  memoizedState: SMUGGLED_STATE_VALUE,
} as ComponentTreeNode;

/**
 * A node whose two numeric fields are absent.
 *
 * What a payload looks like when a producer could not measure a count or a
 * duration, or when a node arrived half-formed. The view reads those fields
 * defensively and answers `n/a` from the one module that owns that spelling, so
 * one malformed node costs that node's detail rather than the whole view — and
 * the cells never read as an empty box or as the word `undefined`.
 */
const UNMEASURED_NODE = {
  id: `${COMPONENT_TREE_NODE_ID_PREFIX}0`,
  component: 'ExampleRoot',
  depth: 0,
  children: [],
} as unknown as ComponentTreeNode;

/*
 * ---------------------------------------------------------------------------
 * Actions, rendering and DOM readers
 * ---------------------------------------------------------------------------
 */

/** A host's `PanelActions`, with every member this component can raise spied on. */
interface ActionSpies {
  /** The object to provide through {@link PanelActionsContext}. */
  readonly actions: PanelActions;

  /** The event-selection spy, which only the commit action may reach. */
  readonly onSelectEvent: Mock<(ref: PanelEventRef) => void>;

  /** The open-source spy. */
  readonly onOpenSource: Mock<(location: SourceLocation) => void>;

  /** The disclosure report spy. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;

  /** The threshold report spy. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * Fresh action spies.
 *
 * All four members are supplied — the two required ones because a host missing
 * either is not a host, and the two optional ones so every case can assert not
 * only that the intent it exercised was raised but also that the others were
 * not: expanding a branch must not select an event, and activating a node must
 * not report a filter change.
 *
 * @returns The actions object and its four spies.
 */
function makeActions(): ActionSpies {
  const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();
  const onOpenSource = vi.fn<(location: SourceLocation) => void>();
  const onExpand = vi.fn<(nodeId: string, itemId: string, expanded: boolean) => void>();
  const onFilterChange = vi.fn<(nodeId: string, filter: Record<string, string>) => void>();

  return {
    actions: { onSelectEvent, onOpenSource, onExpand, onFilterChange },
    onSelectEvent,
    onOpenSource,
    onExpand,
    onFilterChange,
  };
}

/**
 * The session the rendered view's queries are addressed to, provided the way
 * `PanelHost` provides a specification's `sessionId`. Nothing below asserts on
 * it: the routing contract is pinned by `../host/PanelHost.test.tsx`.
 */
const PANEL_SESSION_ID = 'session-under-test';

/**
 * Renders the component inside both host contexts.
 *
 * @param node The node to draw.
 * @param context The provider to resolve its query and the actions to report to.
 */
function renderComponent(
  node: ComponentTreeNodeSpec,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): void {
  render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <ComponentTree node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>,
  );
}

/**
 * The rows on screen, in document order.
 *
 * @param role `treeitem` for a hierarchy, `listitem` for a flat listing.
 * @returns The row elements.
 */
function rows(role: 'treeitem' | 'listitem' = 'treeitem'): HTMLElement[] {
  return screen.getAllByRole(role);
}

/**
 * The display name of each row, in document order.
 *
 * Read off the row's own label element — obtained from an element already
 * found by role — so a row carrying an instance key, a trigger chip, a
 * threshold mark or a source chip contributes its component name and nothing
 * else.
 *
 * @param role The row role to read.
 * @returns One name per row.
 */
function rowNames(role: 'treeitem' | 'listitem' = 'treeitem'): string[] {
  return rows(role).map((row) => row.querySelector(`.${LABEL_CLASS}`)?.textContent ?? '');
}

/**
 * The row whose component name is `name`.
 *
 * @param name The display name to find.
 * @param role The row role to search.
 * @returns That row.
 */
function rowNamed(name: string, role: 'treeitem' | 'listitem' = 'treeitem'): HTMLElement {
  const row = rows(role)[rowNames(role).indexOf(name)];

  if (row === undefined) {
    throw new Error(`no rendered row is named "${name}"`);
  }

  return row;
}

/**
 * The rows that are in the tab order.
 *
 * A composite widget has exactly one, whichever row currently holds it, so
 * every keyboard case asserts the length of this rather than the attribute of
 * one row (AAP 0.6.4).
 *
 * @returns The rows whose `tabIndex` is `0`.
 */
function tabStops(): HTMLElement[] {
  return rows().filter((row) => row.getAttribute('tabindex') === '0');
}

/**
 * The child-list groups of the tree.
 *
 * Narrowed to the unnamed groups: the toolbar is a labelled group and so is the
 * failing-query block of an error state, and a bare role query would count
 * them. `hidden` decides whether a collapsed branch's group is included, which
 * is the point of the option — the element stays in the DOM while collapsed so
 * that the toggle's `aria-controls` always names something real, but it is out
 * of the accessibility tree until the branch opens.
 *
 * @param options.hidden Include groups that are hidden. Defaults to `false`.
 * @returns The child-list groups.
 */
function childGroups(options: { readonly hidden?: boolean } = {}): HTMLElement[] {
  return screen
    .queryAllByRole('group', { hidden: options.hidden ?? false })
    .filter((group) => group.getAttribute('aria-label') === null);
}

/**
 * Moves focus to a row, the way a pointer or a Tab press would.
 *
 * Wrapped in `act` because the row reports its own focus to the component,
 * which is a state update: performing it outside `act` would leave the roving
 * tab stop one render behind every assertion that follows. The synchronous form
 * of `act` returns nothing and flushes before it returns, so this helper is not
 * a promise and callers do not await it.
 *
 * @param row The row to focus.
 */
function focusRow(row: HTMLElement): void {
  act(() => {
    row.focus();
  });
}

/**
 * Renders the uniform structure and waits for the tree.
 *
 * The shared arrangement of the structural and keyboard cases: a resolved
 * snapshot in which nothing is marked, so what is on screen is decided by the
 * default expansion policy and by the gestures the case then performs.
 *
 * @returns The action spies, the stub provider and a `userEvent` session.
 */
async function renderUniformTree(): Promise<{
  readonly spies: ActionSpies;
  readonly stub: StubProvider;
  readonly user: ReturnType<typeof userEvent.setup>;
}> {
  const stub = resolvingProvider(makeSnapshot({ roots: UNIFORM_STRUCTURE }));
  const spies = makeActions();
  const user = userEvent.setup();

  renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
  await screen.findByRole('tree');

  return { spies, stub, user };
}

/**
 * The element a widget names as its description with `aria-describedby`.
 *
 * The note above the tree is that element, which is how its lines reach a
 * screen reader the moment the tree takes focus — so "announced with the tree"
 * is asserted as containment in this element rather than assumed.
 *
 * @param widget The tree or list.
 * @returns The describing element.
 */
function describedBy(widget: HTMLElement): HTMLElement {
  const id = widget.getAttribute('aria-describedby') ?? '';
  const description = id === '' ? null : document.getElementById(id);

  if (description === null) {
    throw new Error('the widget names no description element');
  }

  return description;
}

/**
 * The text a row's `aria-describedby` resolves to: one entry per element the
 * row names, in the order it names them — which is the order a screen reader
 * announces them after the row's name.
 *
 * Throws on a token that names no element, because a dangling description
 * reference is a defect this helper must not paper over.
 *
 * @param row The row.
 * @returns The text of each describing element.
 */
function rowDescription(row: HTMLElement): string[] {
  const ids = (row.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id !== '');

  return ids.map((id) => {
    const element = document.getElementById(id);

    if (element === null) {
      throw new Error(`the row names a description element that does not exist: ${id}`);
    }

    return element.textContent ?? '';
  });
}

/**
 * A row's label element: the part of the row a pointer clicks to select it,
 * away from its toggle and its source chip.
 *
 * @param row The row.
 * @returns Its label.
 */
function labelOf(row: HTMLElement): HTMLElement {
  const label = row.querySelector<HTMLElement>(`.${LABEL_CLASS}`);

  if (label === null) {
    throw new Error('the row has no label element');
  }

  return label;
}

/**
 * Asserts that a sentence is on screen as ordinary visible text inside a
 * widget's description.
 *
 * "Visible" is checked against the three ways this package hides text: a
 * tooltip bubble (which is `role="tooltip"` and, while closed, also
 * `dg-visually-hidden`), and the screen-reader-only utility on its own. A
 * sentence that passes is readable without hovering anything and is announced
 * the moment the widget takes focus.
 *
 * @param widget The tree or list whose `aria-describedby` must hold it.
 * @param text The exact sentence.
 */
function expectVisibleInDescription(widget: HTMLElement, text: string): void {
  const element = screen.getByText(text);

  expect(element.getAttribute('role')).not.toBe('tooltip');
  expect(element.closest('[role="tooltip"]')).toBeNull();
  expect(element.closest('.dg-tooltip__bubble')).toBeNull();
  expect(element.closest('.dg-visually-hidden')).toBeNull();
  expect(describedBy(widget).contains(element)).toBe(true);
}

/**
 * The open-source keyboard hint in the note, or `null` when it is not shown.
 *
 * Matched on the whole line's text, which only the hint's own element carries
 * exactly: the note around it holds more text, and the chord inside it less.
 *
 * @returns The hint's element.
 */
function sourceHint(): HTMLElement | null {
  return screen.queryByText(
    (_content, element) => element !== null && element.textContent === OPEN_SOURCE_HINT,
  );
}

/**
 * Presses Shift+Enter on a row as a bare `keydown`, and reports whether the
 * component consumed it.
 *
 * `fireEvent` answers with `dispatchEvent`'s own result, which is `false`
 * exactly when a handler called `preventDefault` — the observable difference
 * between a key the widget took and a key it left to the page.
 *
 * @param target The element holding focus.
 * @returns Whether the key was consumed.
 */
function shiftEnterConsumed(target: HTMLElement): boolean {
  return !fireEvent.keyDown(target, { key: 'Enter', shiftKey: true });
}

// Explicit, per the harness note above: automatic cleanup belongs to the
// runner's configuration, this guarantee belongs to the suite. Restoring spies
// in the same place keeps one case's mock out of the next.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ComponentTree states', () => {
  it('announces the load, and draws nothing, while the query has not settled', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes the
    // element class that places it.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.textContent).toContain(LOADING_LABEL);
    expect(busy.closest(`.${LOADING_CLASS}`)).not.toBeNull();

    // Nothing is drawn yet: no tree, no rows, no toolbar, and above all no empty
    // state — an unsettled query is not an answer (AAP 0.5.5).
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
    expect(screen.queryByRole('spinbutton', { name: THRESHOLD_FIELD_NAME })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE_PATTERN)).toBeNull();

    // One query, issued without waiting to be asked, and carrying the node's own
    // request verbatim: this source is not paged, so nothing is added to it.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(stub.queries).toEqual([TREE_QUERY]);
  });

  it('renders its own empty message for a snapshot that holds no nodes', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: [], nodeCount: 0 }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Queried by a generic fragment of the product's own copy rather than by a
    // restatement of the sentence, then checked to be exactly that.
    const message = await screen.findByText(EMPTY_MESSAGE_PATTERN);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.closest(`.${EMPTY_CLASS}`)).not.toBeNull();

    // Announced as the settled status, with its short title and a decorative
    // glyph above the sentence, like every other view's empty capture.
    const state = screen.getByRole('status');
    expect(state.contains(message)).toBe(true);
    expect(state.querySelector('.dg-empty-state__title')?.textContent).toBe('Nothing to show');
    expect(state.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden')).toBe('true');

    // An empty snapshot is a success, so it is drawn as an absence and not as a
    // failure — and there is no tree, no toolbar and no threshold to operate.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
    expect(screen.queryByRole('group', { name: TOOLBAR_NAME })).toBeNull();
  });

  it('renders its own empty message, not an error, when the capture holds no tree', async () => {
    // `null` is the service's answer for a capture with no render evidence to
    // build a tree from — a valid answer of the contract, so no type assertion.
    const stub = recordingProvider(() =>
      Promise.resolve<DataQueryResponse>({ source: 'componentTree', data: null }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const message = await screen.findByText(EMPTY_MESSAGE_PATTERN);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.closest(`.${EMPTY_CLASS}`)).not.toBeNull();

    // An empty capture, not a malformed payload: no alert and so no retry, and
    // no tree, rows, list or toolbar drawn as if a structure had arrived.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: RETRY_NAME })).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
    expect(screen.queryByRole('group', { name: TOOLBAR_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError(PROVIDER_FAILURE_CODE, PROVIDER_FAILURE_MESSAGE),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.closest(`.${ERROR_CLASS}`)).not.toBeNull();
    expect(within(alert).getByText(ERROR_TITLE)).toBeDefined();

    // The failure's code reaches the reader, because it is actionable, and so
    // does the provider's own sentence — after the generic lead, never instead
    // of it.
    expect(alert.textContent).toContain(PROVIDER_FAILURE_CODE);
    expect(alert.textContent).toContain(ERROR_LEAD);
    expect(alert.textContent).toContain(PROVIDER_FAILURE_MESSAGE);

    // The query that failed is shown in full. It serialises as JSON, so it is
    // compared as a value rather than as a spelling.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual(TREE_QUERY);

    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // The retry an error state offers is only useful if it really re-queries.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(stub.queries[1]).toEqual(stub.queries[0]);

    // No rows were invented behind the failure.
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
  });

  it('renders a provider rejection through the shared error-state contract', async () => {
    const stub = rejectingProvider(
      new DebuggenError(PROVIDER_FAILURE_CODE, PROVIDER_FAILURE_MESSAGE, {
        hint: PROVIDER_FAILURE_HINT,
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // One failure on its own is the assertive announcement.
    const alert = await screen.findByRole('alert');
    expect(alert.closest(`.${ERROR_CLASS}`)).not.toBeNull();

    // The glyph every error state draws, decorative and hidden from the name.
    const glyph = alert.querySelector('.dg-error-state__icon');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.querySelector('svg.dg-icon')).not.toBeNull();

    // The shared title, then the generic lead followed by the provider's own
    // cause, then the provider's hint on a line of its own.
    const title = within(alert).getByText(ERROR_TITLE);
    expect(title.classList.contains('dg-error-state__title')).toBe(true);
    const lines = Array.from(alert.querySelectorAll('.dg-error-state__message')).map(
      (line) => line.textContent ?? '',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith(ERROR_LEAD)).toBe(true);
    expect(lines[0]).toContain(PROVIDER_FAILURE_MESSAGE);
    expect(lines[1]).toBe(PROVIDER_FAILURE_HINT);

    // The code as a chip, not as prose.
    expect(within(alert).getByText(PROVIDER_FAILURE_CODE).closest('.dg-badge')).not.toBeNull();

    // The query block holds exactly the query that was asked.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(stub.queries).toHaveLength(1);
    expect(JSON.parse(shown.textContent ?? '')).toEqual(stub.queries[0]);
    expect(JSON.parse(shown.textContent ?? '')).toEqual(TREE_QUERY);

    // The retry carries the key the host frame restores focus by.
    const retry = within(alert).getByRole('button', { name: RETRY_NAME });
    expect(retry.getAttribute('data-dg-focus-key')).toBe(RETRY_FOCUS_KEY);
  });

  it('reports a node whose query names a source it cannot draw, and asks for nothing', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: UNIFORM_STRUCTURE }));

    renderComponent(makeNode({ query: { source: 'renders' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');

    // The shared wording of a panel defect, stated from the node catalog.
    expect(within(alert).getByText(UNSUPPORTED_TITLE)).toBeDefined();
    expect(alert.textContent).toContain('PANEL_INVALID');

    // The node's own query is what the reader is shown, and no retry is offered:
    // re-issuing it cannot change the answer.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: 'renders' });
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();

    // Nothing was asked of the provider, and nothing was drawn as if it had been.
    expect(stub.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('refuses a snapshot missing a member it reads at the host check, through the same contract', async () => {
    const stub = recordingProvider(() =>
      Promise.resolve<DataQueryResponse>({ source: 'componentTree', data: INCOMPLETE_PAYLOAD }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(ERROR_TITLE)).toBeDefined();
    expect(alert.textContent).toContain(ERROR_LEAD);
    expect(alert.textContent).toContain(
      '"componentTree" data for this view arrived in a form it cannot read',
    );
    expect(alert.textContent).toContain(SHAPE_FAILURE_CODE);
    expect(within(alert).getByRole('button', { name: RETRY_NAME })).toBeDefined();

    // Which member was missing is developer detail: it sits in the closed
    // disclosure, never on the lines a reader meets first.
    const disclosure = alert.querySelector('details');
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain('data.origin');
    const shownQuery = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shownQuery.textContent ?? '')).toEqual(TREE_QUERY);
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('refuses to draw a payload of the wrong shape, worded as the host words a refusal', async () => {
    const stub = recordingProvider(() =>
      Promise.resolve<DataQueryResponse>({ source: 'componentTree', data: MALFORMED_PAYLOAD }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      '"componentTree" data for this view arrived in a form it cannot read',
    );
    expect(alert.textContent).not.toContain('provider');
    expect(alert.textContent).toContain('Retry to request the data again.');
    expect(alert.querySelector('details')?.textContent).toContain('boolean degraded');
    expect(within(alert).getByRole('button', { name: RETRY_NAME })).toBeDefined();

    // An unreadable answer reads like any other failed view: the shared title
    // and lead, the protocol code and the query that was asked.
    expect(within(alert).getByText(ERROR_TITLE)).toBeDefined();
    expect(alert.textContent).toContain(ERROR_LEAD);
    expect(alert.textContent).toContain(SHAPE_FAILURE_CODE);
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual(TREE_QUERY);

    // A payload it cannot read is not an empty capture: no tree, and no empty
    // state either, since nothing established that the capture holds nothing.
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE_PATTERN)).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('ComponentTree structure', () => {
  it('draws one tree, a treeitem per visible node and a group per open branch', async () => {
    await renderUniformTree();

    // Named by the node catalog's label, since this node carries no title.
    expect(screen.getAllByRole('tree')).toHaveLength(1);
    await screen.findByRole('tree', { name: TREE_NAME });

    // The default policy opens the roots and nothing else, so the second-level
    // parent is on screen and closed.
    expect(rowNames()).toEqual([...INITIAL_ROW_NAMES]);

    const root = rowNamed('ExampleRoot');
    const branch = rowNamed('ExampleBranch');
    const aside = rowNamed('ExampleAside');

    // `aria-expanded` belongs to a node that owns children, and to no other:
    // a leaf that claimed it would announce a branch that does not exist.
    expect(root.getAttribute('aria-expanded')).toBe('true');
    expect(branch.getAttribute('aria-expanded')).toBe('false');
    expect(aside.hasAttribute('aria-expanded')).toBe(false);

    // Position is announced too, so a reader hears depth and set size.
    expect(root.getAttribute('aria-level')).toBe('1');
    expect(branch.getAttribute('aria-level')).toBe('2');
    expect(branch.getAttribute('aria-posinset')).toBe('1');
    expect(branch.getAttribute('aria-setsize')).toBe('2');
    expect(aside.getAttribute('aria-posinset')).toBe('2');

    // One open branch, so one child list in the accessibility tree — and the row
    // it belongs to owns it, which is how the relation survives the group being
    // a DOM sibling rather than a descendant.
    const [openGroup] = childGroups();
    expect(childGroups()).toHaveLength(1);
    expect(openGroup?.id).toBe(root.getAttribute('aria-owns'));
    expect(openGroup === undefined ? [] : within(openGroup).getAllByRole('treeitem')).toHaveLength(
      2,
    );

    // The closed branch keeps its group element, so the toggle's `aria-controls`
    // always names something real — and renders no rows inside it, which is what
    // bounds a large structure on first paint.
    const toggle = within(branch).getByRole('button', { name: 'Expand ExampleBranch' });
    const controlled = toggle.getAttribute('aria-controls');
    const closedGroup = childGroups({ hidden: true }).find((group) => group.id === controlled);
    expect(closedGroup).toBeDefined();
    expect(closedGroup?.childElementCount).toBe(0);
    expect(branch.hasAttribute('aria-owns')).toBe(false);
  });

  it('states the snapshot’s own counters rather than implying them from the rows', async () => {
    const snapshot = makeSnapshot({ roots: UNIFORM_STRUCTURE });
    const stub = resolvingProvider(snapshot);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    // Five nodes and three levels exist; three rows are on screen. All three
    // numbers are stated, and the derivation is pinned so a fixture change
    // cannot quietly make this assertion vacuous.
    expect(snapshot.nodeCount).toBe(5);
    expect(snapshot.maxDepth).toBe(2);
    expect(screen.getByText(statisticsLine(snapshot, INITIAL_ROW_NAMES.length))).toBeDefined();

    // And the view says what kind of thing the reader is looking at.
    expect(screen.getByText(PROVENANCE_NOTE)).toBeDefined();
  });

  it('uses the node title as the tree’s accessible name when the node carries one', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: UNIFORM_STRUCTURE }));

    renderComponent(makeNode({ title: 'Where the renders happened' }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('tree', { name: 'Where the renders happened' });
    expect(screen.queryByRole('tree', { name: TREE_NAME })).toBeNull();
  });

  it('opens and closes every branch from the toolbar, reporting one item at a time', async () => {
    const { spies, user } = await renderUniformTree();

    expect(screen.getByRole('group', { name: TOOLBAR_NAME })).toBeDefined();

    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));

    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });
    expect(childGroups()).toHaveLength(2);

    // Reported per item, like a single toggle, and only for what changed: the
    // root was already open, so the branch is the one disclosure that happened.
    expect(spies.onExpand.mock.calls).toEqual([[NODE_ID, BRANCH_NODE.id, true]]);

    await user.click(screen.getByRole('button', { name: COLLAPSE_ALL_NAME }));

    await waitFor(() => {
      expect(rowNames()).toEqual(['ExampleRoot']);
    });
    expect(childGroups()).toHaveLength(0);
    // Deepest branch first, because the traversal records a parent after the
    // children it followed: the order is a property of the walk, not incidental.
    expect(spies.onExpand.mock.calls).toEqual([
      [NODE_ID, BRANCH_NODE.id, true],
      [NODE_ID, BRANCH_NODE.id, false],
      [NODE_ID, ROOT_NODE.id, false],
    ]);

    // Disclosure is disclosure: it selects nothing and filters nothing.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });
});

describe('ComponentTree honesty about its snapshot', () => {
  it('presents a serialized structure as captured, with no caveat it has not earned', async () => {
    const stub = resolvingProvider(
      snapshotWithOrigin('commit-snapshot', { roots: UNIFORM_STRUCTURE }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    const tree = await screen.findByRole('tree');

    expect(screen.getByText(CAPTURED_ORIGIN_LABEL).classList.contains('dg-badge')).toBe(true);
    expectVisibleInDescription(tree, CAPTURED_ORIGIN_DETAIL);
    expect(screen.queryByText(RECONSTRUCTED_ORIGIN_LABEL)).toBeNull();
    expect(screen.queryByText(FLAT_ORIGIN_LABEL)).toBeNull();
    expect(screen.queryByText(DEGRADED_NOTE)).toBeNull();
    expect(screen.queryByText(TRUNCATED_NOTE)).toBeNull();
  });

  it('says a reconstruction is one, and that it is incomplete and short', async () => {
    const stub = resolvingProvider(
      snapshotWithOrigin('owner-chains', {
        roots: UNIFORM_STRUCTURE,
        degraded: true,
        truncated: true,
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    const tree = await screen.findByRole('tree');

    // The origin is a visible badge with a plain-language explanation, never a
    // tooltip-only footnote: the badge is no focus target, so a tooltip on it
    // could not be opened from the keyboard. The explanation is ordinary text
    // in the note the tree names as its description, so focusing the tree
    // announces it and no hover is needed to read it.
    expect(screen.getByText(RECONSTRUCTED_ORIGIN_LABEL).classList.contains('dg-badge')).toBe(true);
    expectVisibleInDescription(tree, RECONSTRUCTED_ORIGIN_DETAIL);
    for (const bubble of screen.queryAllByRole('tooltip', { hidden: true })) {
      expect(bubble.textContent).not.toContain(RECONSTRUCTED_ORIGIN_DETAIL);
    }
    expect(screen.queryByText(CAPTURED_ORIGIN_LABEL)).toBeNull();

    // Both flags the snapshot raised are stated, in words, above the tree.
    expect(screen.getByText(DEGRADED_NOTE)).toBeDefined();
    expect(screen.getByText(TRUNCATED_NOTE)).toBeDefined();
  });

  it('renders a structureless snapshot as a list, and invents no nesting', async () => {
    // A flat snapshot reports a single level, and the producer always marks it
    // degraded: no hierarchy could be rebuilt at all.
    const snapshot = snapshotWithOrigin('flat', { roots: UNIFORM_STRUCTURE, maxDepth: 0 });
    const stub = resolvingProvider(snapshot);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const list = await screen.findByRole('list', { name: LIST_NAME });

    // Not a tree, and not named as one.
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
    expect(screen.queryByRole('tree', { name: TREE_NAME })).toBeNull();

    // Every observed component is listed once, at one level. Nesting is not
    // invented: there is no child list anywhere inside the listing, hidden or
    // otherwise, and no row claims a level or a disclosure state.
    expect(rowNames('listitem')).toEqual([...EXPANDED_ROW_NAMES]);
    expect(within(list).queryAllByRole('group', { hidden: true })).toHaveLength(0);

    for (const row of rows('listitem')) {
      expect(row.hasAttribute('aria-expanded')).toBe(false);
      expect(row.hasAttribute('aria-level')).toBe(false);
      expect(row.hasAttribute('aria-owns')).toBe(false);
    }

    // No disclosure affordance either, since there is nothing to disclose.
    expect(screen.queryByRole('button', { name: EXPAND_ALL_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: COLLAPSE_ALL_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Expand Example/ })).toBeNull();

    // And the reader is told what they are looking at, and why it is caveated —
    // in visible text the listing carries as its description, not in a tooltip.
    expect(screen.getByText(FLAT_ORIGIN_LABEL)).toBeDefined();
    expectVisibleInDescription(list, FLAT_ORIGIN_DETAIL);
    expect(screen.getByText(DEGRADED_NOTE)).toBeDefined();
    expect(screen.getByText(statisticsLine(snapshot, EXPANDED_ROW_NAMES.length))).toBeDefined();
  });
});

describe('ComponentTree keyboard navigation', () => {
  it('keeps exactly one row in the tab order, and moves it with focus', async () => {
    const { user } = await renderUniformTree();

    expect(tabStops()).toHaveLength(1);
    expect(tabStops()[0]).toBe(rowNamed('ExampleRoot'));

    focusRow(rowNamed('ExampleRoot'));
    await user.keyboard('{ArrowDown}');

    expect(document.activeElement).toBe(rowNamed('ExampleBranch'));
    expect(tabStops()).toHaveLength(1);
    expect(tabStops()[0]).toBe(rowNamed('ExampleBranch'));

    // The row's own toggle is reached with the arrow keys, not with Tab, so it
    // is not a second tab stop inside the composite widget.
    expect(
      within(rowNamed('ExampleBranch'))
        .getByRole('button', { name: 'Expand ExampleBranch' })
        .getAttribute('tabindex'),
    ).toBe('-1');
  });

  it('keeps every control inside the rows out of the tab order, source chips included', async () => {
    const { user } = await renderUniformTree();

    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });

    const tree = screen.getByRole('tree');

    // The chip is still a real button a pointer can press, just not a Tab stop.
    const chip = within(rowNamed('ExampleLeaf')).getByRole('button', { name: SOURCE_CHIP_NAME });
    expect(chip.getAttribute('tabindex')).toBe('-1');

    // With every row open — so every toggle and every chip is in the DOM — the
    // single active row is the only element anywhere inside the tree that Tab
    // can reach. `tabIndex` is the browser's own reading, so a button with no
    // attribute at all would count here as the `0` it is.
    expect(tabStops()).toEqual([rowNamed('ExampleRoot')]);
    const reachable = Array.from(tree.querySelectorAll<HTMLElement>('*')).filter(
      (element) => element.tabIndex >= 0,
    );
    expect(reachable).toEqual([rowNamed('ExampleRoot')]);

    // So one Tab from the active row leaves the widget: no chip or toggle is
    // visited on the way out.
    focusRow(rowNamed('ExampleRoot'));
    await user.keyboard('{Tab}');

    expect(document.activeElement).not.toBeNull();
    expect(tree.contains(document.activeElement)).toBe(false);
  });

  it('expands a closed branch with ArrowRight, then descends into it', async () => {
    const { spies, user } = await renderUniformTree();

    focusRow(rowNamed('ExampleBranch'));
    await user.keyboard('{ArrowRight}');

    await waitFor(() => {
      expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('true');
    });
    expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    expect(spies.onExpand.mock.calls).toEqual([[NODE_ID, BRANCH_NODE.id, true]]);

    // The first press opens the branch and stays put; the second moves into it.
    expect(document.activeElement).toBe(rowNamed('ExampleBranch'));

    await user.keyboard('{ArrowRight}');

    expect(document.activeElement).toBe(rowNamed('ExampleLeaf'));
    // Descending is navigation, not disclosure, so nothing further is reported.
    expect(spies.onExpand).toHaveBeenCalledTimes(1);
  });

  it('collapses with ArrowLeft, and ascends from a row that cannot collapse', async () => {
    const { spies, user } = await renderUniformTree();

    focusRow(rowNamed('ExampleBranch'));
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(rowNamed('ExampleLeaf'));

    // A leaf has nothing to close, so ArrowLeft goes to its parent.
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(rowNamed('ExampleBranch'));
    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('true');

    // On an open parent it closes the branch, and says so to the host.
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => {
      expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
    });
    expect(rowNames()).toEqual([...INITIAL_ROW_NAMES]);
    expect(spies.onExpand.mock.calls).toEqual([
      [NODE_ID, BRANCH_NODE.id, true],
      [NODE_ID, BRANCH_NODE.id, false],
    ]);
    expect(document.activeElement).toBe(rowNamed('ExampleBranch'));

    // Closed now, so the next press ascends instead.
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(rowNamed('ExampleRoot'));
  });

  it('walks the visible rows with ArrowDown and ArrowUp, and stops at the ends', async () => {
    const { user } = await renderUniformTree();

    focusRow(rowNamed('ExampleRoot'));

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowNamed('ExampleBranch'));

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowNamed('ExampleAside'));

    // The last visible row is the last: the widget does not wrap round.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowNamed('ExampleAside'));

    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toBe(rowNamed('ExampleRoot'));

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(rowNamed('ExampleRoot'));
  });

  it('jumps to the first and last visible rows with Home and End', async () => {
    const { user } = await renderUniformTree();

    focusRow(rowNamed('ExampleBranch'));

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rowNamed('ExampleAside'));

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(rowNamed('ExampleRoot'));

    // "Visible" is what the keys walk: after opening every branch, the last row
    // is still the last one on screen rather than the deepest one in the data.
    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });

    focusRow(rowNamed('ExampleLeaf'));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rowNamed('ExampleAside'));

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(rowNamed('ExampleRoot'));
  });

  it('selects the focused row with Enter and with Space, and toggles nothing', async () => {
    const { spies, user } = await renderUniformTree();

    // Enter on a closed branch selects it and reports its render — and leaves
    // it closed: selection is not disclosure.
    focusRow(rowNamed('ExampleBranch'));
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('true');
    });
    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
    expect(rowNames()).toEqual([...INITIAL_ROW_NAMES]);
    expect(spies.onSelectEvent.mock.calls).toEqual([[BRANCH_RENDER_REF]]);

    // Space does the same thing, which is what a composite widget owes both keys.
    await user.keyboard(' ');

    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
    expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('true');
    expect(spies.onSelectEvent.mock.calls).toEqual([[BRANCH_RENDER_REF], [BRANCH_RENDER_REF]]);

    // Enter on an open root leaves it open too.
    focusRow(rowNamed('ExampleRoot'));
    await user.keyboard('{Enter}');

    expect(rowNamed('ExampleRoot').getAttribute('aria-expanded')).toBe('true');
    expect(rowNamed('ExampleRoot').getAttribute('aria-selected')).toBe('true');
    expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('false');
    expect(rowNames()).toEqual([...INITIAL_ROW_NAMES]);

    // Enter on a row that resolved to source selects it and opens nothing: the
    // chip and Shift+Enter are the routes to a file.
    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });

    focusRow(rowNamed('ExampleLeaf'));
    await user.keyboard('{Enter}');

    expect(rowNamed('ExampleLeaf').getAttribute('aria-selected')).toBe('true');
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({ eventId: LEAF_RENDER_EVENT_ID });

    // The only disclosure reported is the one the toolbar made.
    expect(spies.onExpand.mock.calls).toEqual([[NODE_ID, BRANCH_NODE.id, true]]);
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('leaves a key it does not own to the page', async () => {
    const { spies, user } = await renderUniformTree();

    const branch = rowNamed('ExampleBranch');
    focusRow(branch);

    // Escape belongs to whatever is above this widget: it changes no state here.
    await user.keyboard('{Escape}');

    expect(document.activeElement).toBe(rowNamed('ExampleBranch'));
    expect(rowNames()).toEqual([...INITIAL_ROW_NAMES]);
    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');

    // Tab is never hijacked, and focus is never trapped: it leaves the row.
    await user.keyboard('{Tab}');

    expect(document.activeElement).not.toBe(rowNamed('ExampleBranch'));
    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });
});

describe('ComponentTree open-source command', () => {
  it('opens a branch’s source with Shift+Enter, without toggling or selecting it', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: SOURCED_BRANCH_STRUCTURE }));
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('tree');

    // Closed on first paint, and the command must leave it closed.
    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');

    focusRow(rowNamed('ExampleBranch'));
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    // The very object the datum holds, once.
    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource.mock.calls[0]?.[0]).toBe(BRANCH_SOURCE);

    // And nothing else: not toggled, not selected, not reported, focus kept.
    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
    expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('false');
    expect(rowNames()).toEqual([...INITIAL_ROW_NAMES]);
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowNamed('ExampleBranch'));

    // The key is consumed, so nothing behind the widget acts on it as well.
    expect(shiftEnterConsumed(rowNamed('ExampleBranch'))).toBe(true);
    expect(spies.onOpenSource).toHaveBeenCalledTimes(2);
    expect(spies.onOpenSource.mock.calls[1]?.[0]).toBe(BRANCH_SOURCE);

    // Plain Enter keeps its own meaning on the same row: it selects, and
    // neither toggles nor opens anything. This branch names no representative
    // render, so the selection stays inside the view.
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('true');
    });
    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onOpenSource).toHaveBeenCalledTimes(2);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // Disclosure is still one arrow away, and is reported as such.
    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('true');
    });
    expect(spies.onExpand.mock.calls).toEqual([[NODE_ID, SOURCED_BRANCH_ID, true]]);
    expect(spies.onOpenSource).toHaveBeenCalledTimes(2);
  });

  it('opens a leaf’s source with Shift+Enter, which its plain Enter does not', async () => {
    const { spies, user } = await renderUniformTree();

    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });

    focusRow(rowNamed('ExampleLeaf'));
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource.mock.calls[0]?.[0]).toBe(LEAF_SOURCE);
    // A command, not a selection: the row is not selected by it.
    expect(rowNamed('ExampleLeaf').getAttribute('aria-selected')).toBe('false');
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // Plain Enter on the same row selects it and opens nothing further.
    await user.keyboard('{Enter}');

    expect(rowNamed('ExampleLeaf').getAttribute('aria-selected')).toBe('true');
    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent.mock.calls).toEqual([[{ eventId: LEAF_RENDER_EVENT_ID }]]);
  });

  it('leaves Shift+Enter to the page on a row that has no source to open', async () => {
    const { spies, user } = await renderUniformTree();

    // A leaf with no location: nothing opens, nothing is selected.
    focusRow(rowNamed('ExampleAside'));
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(rowNamed('ExampleAside').getAttribute('aria-selected')).toBe('false');
    expect(shiftEnterConsumed(rowNamed('ExampleAside'))).toBe(false);

    // A branch with no location: and, above all, not toggled either — the
    // command is never a second spelling of Enter.
    focusRow(rowNamed('ExampleBranch'));
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
    expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('false');
    expect(shiftEnterConsumed(rowNamed('ExampleBranch'))).toBe(false);
    expect(rowNames()).toEqual([...INITIAL_ROW_NAMES]);

    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('advertises the command only on rows that can open a source, and once above the tree', async () => {
    const { user } = await renderUniformTree();

    // The hint is about the structure, not the rows that happen to be open: the
    // one located node is still inside a closed branch here.
    expect(rowNames()).toEqual([...INITIAL_ROW_NAMES]);
    const hint = sourceHint();
    expect(hint).not.toBeNull();

    // Printed as a chord, one key per chip, and part of the note the tree names
    // as its description — so focusing the tree announces it too.
    expect(
      Array.from(hint?.querySelectorAll('kbd kbd') ?? []).map((key) => key.textContent),
    ).toEqual(['Shift', 'Enter']);
    expect(describedBy(screen.getByRole('tree')).contains(hint)).toBe(true);

    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });

    // Exactly the row that resolved to source announces the shortcut.
    for (const row of rows()) {
      const name = row.querySelector(`.${LABEL_CLASS}`)?.textContent;

      expect(row.getAttribute('aria-keyshortcuts')).toBe(
        name === 'ExampleLeaf' ? OPEN_SOURCE_SHORTCUT : null,
      );
    }
  });

  it('offers neither the hint nor the shortcut where no node resolved to source', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: UNEVEN_STRUCTURE }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    expect(sourceHint()).toBeNull();
    expect(screen.queryByText(/open its source/i)).toBeNull();

    for (const row of rows()) {
      expect(row.hasAttribute('aria-keyshortcuts')).toBe(false);
    }
  });

  it('offers neither the hint nor the shortcut when no host can open a file', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: UNIFORM_STRUCTURE }));
    const user = userEvent.setup();

    // No `PanelActions` in scope, which is how the view renders outside a host:
    // a location exists, but nothing could open it.
    render(
      <DataProviderContext.Provider value={stub.provider}>
        <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
          <ComponentTree node={makeNode()} />
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>,
    );
    await screen.findByRole('tree');

    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });

    expect(sourceHint()).toBeNull();
    expect(rowNamed('ExampleLeaf').hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(
      within(rowNamed('ExampleLeaf')).queryByRole('button', { name: SOURCE_CHIP_NAME }),
    ).toBeNull();
    expect(shiftEnterConsumed(rowNamed('ExampleLeaf'))).toBe(false);
  });
});

describe('ComponentTree counts', () => {
  it('shows each node’s render count and time, formatted, and nothing else', async () => {
    const renderCount = 1234;
    const totalDurationMs = 4567.5;
    const stub = resolvingProvider(
      makeSnapshot({
        roots: [
          makeTreeNode({
            id: `${COMPONENT_TREE_NODE_ID_PREFIX}0`,
            component: 'ExampleRoot',
            renderCount,
            totalDurationMs,
          }),
        ],
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    const row = rowNamed('ExampleRoot');

    // The count is the formatter's output, with its unit for a screen reader.
    const count = within(row).getByText(formatCount(renderCount));
    expect(count.classList.contains(COUNT_CLASS)).toBe(true);
    expect(count.textContent).toBe(`${formatCount(renderCount)} ${RENDERS_UNIT}`);

    // One literal, to prove the formatter groups digits rather than printing the
    // number the capture carried — which is then asserted to be absent.
    expect(formatCount(renderCount)).toBe('1,234');
    expect(row.textContent).not.toContain(String(renderCount));

    const duration = within(row).getByText(formatDurationCompact(totalDurationMs));
    expect(duration.textContent).toBe(
      `${formatDurationCompact(totalDurationMs)} ${RENDER_TIME_UNIT}`,
    );

    // The whole row, pinned: a name, a count and a time. There is no prop cell,
    // no state cell and no value of any kind (AAP 0.5.2), and a threshold this
    // node does not reach leaves no mark either.
    expect(row.textContent).toBe(
      `ExampleRoot${formatCount(renderCount)} ${RENDERS_UNIT}${formatDurationCompact(
        totalDurationMs,
      )} ${RENDER_TIME_UNIT}`,
    );
  });

  it('names a node’s last render trigger and its instance key, as names not values', async () => {
    const trigger: RenderTrigger = 'context';
    const stub = resolvingProvider(
      makeSnapshot({
        roots: [
          makeTreeNode({
            id: `${COMPONENT_TREE_NODE_ID_PREFIX}0`,
            component: 'ExampleRoot',
            renderCount: 4,
            totalDurationMs: 8,
            key: 'example-key-1',
            lastTrigger: trigger,
          }),
        ],
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    const row = rowNamed('ExampleRoot');

    // Through the package's formatter, and announced with the prefix a chip on
    // its own would lack.
    const chip = within(row).getByText(formatRenderTriggerLabel(trigger));
    expect(formatRenderTriggerLabel(trigger)).toBe('Context changed');
    expect(chip.textContent).toContain('Last render trigger:');

    expect(within(row).getByText('example-key-1').textContent).toContain('Instance key:');
  });

  it('answers n/a where a count or a duration was not measured', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: [UNMEASURED_NODE], nodeCount: 1 }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    const row = rowNamed('ExampleRoot');
    expect(within(row).getAllByText('n/a')).toHaveLength(2);
    expect(row.textContent).not.toContain('undefined');
  });

  it('says one render and one node in the singular, and every other count in the plural', async () => {
    const snapshot = makeSnapshot({
      roots: [
        makeTreeNode({
          id: `${COMPONENT_TREE_NODE_ID_PREFIX}0`,
          component: 'ExampleRoot',
          renderCount: 1,
          totalDurationMs: 2,
        }),
      ],
    });
    const stub = resolvingProvider(snapshot);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    // The row's description is its count with an agreeing unit: "1 render".
    const row = rowNamed('ExampleRoot');
    expect(rowDescription(row)).toEqual([`${formatCount(1)} ${RENDER_UNIT}`]);
    expect(row.textContent).not.toContain(RENDERS_UNIT);

    // And the statistics line agrees with each of its counts.
    expect(snapshot.nodeCount).toBe(1);
    expect(snapshot.maxDepth).toBe(0);
    expect(screen.getByText('1 node · 1 level · 1 shown')).toBeDefined();
    expect(screen.getByText(statisticsLine(snapshot, 1))).toBeDefined();

    cleanup();

    // The plural for everything else, zero included. Per-component counts of
    // 2, 0 and 2 derive a threshold of four, so no mark joins the description.
    const plural = makeSnapshot({
      roots: [
        makeTreeNode({
          id: `${COMPONENT_TREE_NODE_ID_PREFIX}0`,
          component: 'ExampleRoot',
          renderCount: 2,
          children: [
            makeTreeNode({
              id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0`,
              component: 'ExampleLeaf',
              depth: 1,
              renderCount: 0,
            }),
            makeTreeNode({
              id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/1`,
              component: 'ExampleAside',
              depth: 1,
              renderCount: 2,
            }),
          ],
        }),
      ],
    });

    renderComponent(makeNode(), {
      provider: resolvingProvider(plural).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('tree');

    expect(rowDescription(rowNamed('ExampleRoot'))).toEqual([`${formatCount(2)} ${RENDERS_UNIT}`]);
    expect(rowDescription(rowNamed('ExampleLeaf'))).toEqual([`${formatCount(0)} ${RENDERS_UNIT}`]);
    expect(screen.getByText('3 nodes · 2 levels · 3 shown')).toBeDefined();
    expect(screen.getByText(statisticsLine(plural, 3))).toBeDefined();
  });
});

describe('ComponentTree threshold', () => {
  it('marks a node at or above the derived threshold with words as well as a state', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: UNEVEN_STRUCTURE }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    // The default follows the capture: twice the median render count, and at
    // least one render above it.
    const field = screen.getByRole('spinbutton', { name: THRESHOLD_FIELD_NAME });
    expect(screen.getByDisplayValue(String(UNEVEN_DERIVED_THRESHOLD))).toBe(field);

    // Every ancestor of a marked node opens, so the finding is on screen without
    // a gesture.
    expect(rowNames()).toEqual(['ExampleRoot', 'ExampleBranch', 'ExampleLeaf', 'ExampleSibling']);

    // The mark is words beside an icon and a state class — never colour alone —
    // and the row names it in its description, so it is announced with the row.
    const marked = rowNamed('ExampleLeaf');
    expect(within(marked).getByText(AT_OR_ABOVE_THRESHOLD_TEXT)).toBeDefined();
    expect(marked.classList.contains(HIGHLIGHTED_CLASS)).toBe(true);
    expect(rowDescription(marked)).toEqual([
      `${formatCount(40)} ${RENDERS_UNIT}`,
      AT_OR_ABOVE_THRESHOLD_TEXT,
    ]);

    // A node below the threshold carries neither.
    const unmarked = rowNamed('ExampleSibling');
    expect(within(unmarked).queryByText(AT_OR_ABOVE_THRESHOLD_TEXT)).toBeNull();
    expect(unmarked.classList.contains(HIGHLIGHTED_CLASS)).toBe(false);
    expect(rowDescription(unmarked)).toEqual([`${formatCount(1)} ${RENDER_UNIT}`]);
    expect(rowNamed('ExampleRoot').classList.contains(HIGHLIGHTED_CLASS)).toBe(false);

    // Every ancestor of the mark is open, so no row hides one.
    expect(screen.queryByText(/hidden at or above threshold/)).toBeNull();

    // And the reader is told how many rows carry the mark.
    expect(screen.getByText(markedStatus(1))).toBeDefined();
    expect(screen.getAllByText(AT_OR_ABOVE_THRESHOLD_TEXT)).toHaveLength(1);
  });

  it('follows a threshold the developer types, and reports it to the host', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: UNEVEN_STRUCTURE }));
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('tree');

    const field = screen.getByRole('spinbutton', { name: THRESHOLD_FIELD_NAME });
    await user.clear(field);
    await user.type(field, '2');

    await waitFor(() => {
      expect(screen.getByText(markedStatus(3))).toBeDefined();
    });

    // Three of the four nodes reach two renders; the fourth rendered once.
    expect(rowNamed('ExampleRoot').classList.contains(HIGHLIGHTED_CLASS)).toBe(true);
    expect(rowNamed('ExampleBranch').classList.contains(HIGHLIGHTED_CLASS)).toBe(true);
    expect(rowNamed('ExampleLeaf').classList.contains(HIGHLIGHTED_CLASS)).toBe(true);
    expect(rowNamed('ExampleSibling').classList.contains(HIGHLIGHTED_CLASS)).toBe(false);
    expect(screen.getAllByText(AT_OR_ABOVE_THRESHOLD_TEXT)).toHaveLength(3);

    // Reported as the threshold in force, against this node's id: a host may
    // remember a filter, and nothing in the renderer depends on it doing so.
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { renderThreshold: '2' });

    // A threshold is not a query: the snapshot is not re-fetched for it.
    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // Clearing the field restores the derived default rather than turning the
    // highlight off, which is what "clear to restore it" has to mean.
    await user.clear(field);

    await waitFor(() => {
      expect(screen.getByText(markedStatus(1))).toBeDefined();
    });
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { renderThreshold: '' });
  });

  it('bounds the field to whole renders, from one up to the highest count captured', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: UNEVEN_STRUCTURE }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    // The highest count in the capture is forty: past it nothing more can be
    // marked, so that is where the spin buttons stop.
    const field = screen.getByRole('spinbutton', { name: THRESHOLD_FIELD_NAME });
    expect(field.getAttribute('min')).toBe('1');
    expect(field.getAttribute('step')).toBe('1');
    expect(field.getAttribute('max')).toBe('40');

    cleanup();

    // Where the derived default is higher than every count, the bound includes
    // it, so the value the field starts at is inside its own range.
    await renderUniformTree();

    const uniform = screen.getByRole('spinbutton', { name: THRESHOLD_FIELD_NAME });
    expect(uniform.getAttribute('max')).toBe('6');
    expect(screen.getByDisplayValue('6')).toBe(uniform);
  });

  it('reads an entered threshold by one rule, and reports the threshold in force', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: UNEVEN_STRUCTURE }));
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('tree');

    const field = screen.getByRole('spinbutton', { name: THRESHOLD_FIELD_NAME });

    // Leading zeros are spelling: "03" is three, and three is what is reported.
    await user.clear(field);
    await user.type(field, '03');

    await waitFor(() => {
      expect(screen.getByText(markedStatus(2))).toBeDefined();
    });
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { renderThreshold: '3' });
    expect(field.getAttribute('aria-invalid')).toBeNull();

    // Zero is below the bound, so it names no threshold: the derived default
    // is in force — one mark — and the host hears "", its spelling of that.
    // The text stays so it can be corrected, but the field is marked invalid,
    // the toolbar shows which default applies — a short pill beside the
    // controls, not an error line that would widen the field's column — and
    // the full reason describes the field and is announced by a live region.
    const toolbar = screen.getByRole('group', { name: TOOLBAR_NAME });
    const liveRegion = toolbar.querySelector<HTMLElement>('[aria-live="polite"]');

    if (liveRegion === null) {
      throw new Error('The threshold field has no live region for its rejection.');
    }

    // A live region, but not a `status`: that role marks a view still loading.
    expect(liveRegion.getAttribute('role')).toBeNull();
    expect(liveRegion.getAttribute('aria-atomic')).toBe('true');
    expect(within(toolbar).queryByRole('status')).toBeNull();
    expect(liveRegion.textContent).toBe('');
    expect(field.getAttribute('aria-describedby') ?? '').not.toContain(liveRegion.id);

    await user.clear(field);
    await user.type(field, '0');

    await waitFor(() => {
      expect(screen.getByText(markedStatus(1))).toBeDefined();
    });
    expect(screen.getByDisplayValue('0')).toBe(field);
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { renderThreshold: '' });
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const pill = within(screen.getByRole('group', { name: TOOLBAR_NAME })).getByText(
      defaultInForceText(6),
    );
    expect(pill.closest('.dg-badge--danger')).not.toBeNull();
    expect(field.closest('.dg-field')?.querySelector('.dg-field__error')).toBeNull();
    expect(liveRegion.textContent).toBe(thresholdRejectedText(6));
    expect(liveRegion.classList.contains('dg-visually-hidden')).toBe(true);
    expect((field.getAttribute('aria-describedby') ?? '').split(' ')).toContain(liveRegion.id);

    // A fraction is not a whole number of renders, and falls back the same way.
    await user.clear(field);
    await user.type(field, '2.5');

    await waitFor(() => {
      expect(screen.getByText(markedStatus(1))).toBeDefined();
    });
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { renderThreshold: '' });
    expect(field.getAttribute('aria-invalid')).toBe('true');

    // Above the field's max is honoured, not clamped: no component reached
    // fifty renders, so nothing is marked, and fifty is what is in force.
    await user.clear(field);
    await user.type(field, '50');

    await waitFor(() => {
      expect(screen.getByText(markedStatus(0))).toBeDefined();
    });
    expect(screen.queryAllByText(AT_OR_ABOVE_THRESHOLD_TEXT)).toHaveLength(0);
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { renderThreshold: '50' });
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText(defaultInForceText(6))).toBeNull();
    expect(liveRegion.textContent).toBe('');
    expect(field.getAttribute('aria-describedby') ?? '').not.toContain(liveRegion.id);

    // An empty field is the documented way back to the default, not an error.
    await user.clear(field);

    await waitFor(() => {
      expect(screen.getByText(markedStatus(1))).toBeDefined();
    });
    expect(field.getAttribute('aria-invalid')).toBeNull();

    // Every report was a canonical decimal integer or "", never raw text.
    for (const [nodeId, filter] of spies.onFilterChange.mock.calls) {
      expect(nodeId).toBe(NODE_ID);
      expect(filter.renderThreshold).toMatch(/^(?:[1-9]\d*)?$/);
    }
  });

  it('states on a collapsed branch how many marks it hides, and announces the count', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: UNEVEN_STRUCTURE }));
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    // The derived threshold of six marks the leaf alone. Closing everything
    // leaves only the root on screen, and the root says what it hides.
    await user.click(screen.getByRole('button', { name: COLLAPSE_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual(['ExampleRoot']);
    });

    const root = rowNamed('ExampleRoot');
    const hiddenBadge = within(root).getByText(hiddenMarkedText(1));

    // An icon and words, never colour alone, drawn by the badge primitive —
    // and the icon is decoration, out of the accessibility tree.
    expect(hiddenBadge.classList.contains('dg-badge')).toBe(true);
    expect(hiddenBadge.classList.contains('dg-badge--warning')).toBe(true);
    expect(hiddenBadge.classList.contains('dg-badge--outline')).toBe(true);
    expect(hiddenBadge.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    // Announced with the row, after its count.
    expect(rowDescription(root)).toEqual([
      `${formatCount(2)} ${RENDERS_UNIT}`,
      hiddenMarkedText(1),
    ]);

    // At a threshold of two the root is marked itself and hides two more marks,
    // one level down and two levels down: the count covers every depth.
    const field = screen.getByRole('spinbutton', { name: THRESHOLD_FIELD_NAME });
    await user.clear(field);
    await user.type(field, '2');

    await waitFor(() => {
      expect(within(rowNamed('ExampleRoot')).getByText(hiddenMarkedText(2))).toBeDefined();
    });
    expect(rowNames()).toEqual(['ExampleRoot']);
    expect(rowDescription(rowNamed('ExampleRoot'))).toEqual([
      `${formatCount(2)} ${RENDERS_UNIT}`,
      AT_OR_ABOVE_THRESHOLD_TEXT,
      hiddenMarkedText(2),
    ]);

    // Opening the root puts its children on screen, so it hides nothing any
    // more — and the branch, still closed, states the one mark it hides.
    await user.click(within(rowNamed('ExampleRoot')).getByRole('button', { name: /^Expand / }));
    await waitFor(() => {
      expect(rowNames()).toEqual(['ExampleRoot', 'ExampleBranch']);
    });
    expect(rowDescription(rowNamed('ExampleRoot'))).toEqual([
      `${formatCount(2)} ${RENDERS_UNIT}`,
      AT_OR_ABOVE_THRESHOLD_TEXT,
    ]);
    expect(rowDescription(rowNamed('ExampleBranch'))).toEqual([
      `${formatCount(4)} ${RENDERS_UNIT}`,
      AT_OR_ABOVE_THRESHOLD_TEXT,
      hiddenMarkedText(1),
    ]);

    // With every branch open, no badge of the kind remains anywhere.
    focusRow(rowNamed('ExampleBranch'));
    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(rowNames()).toEqual(['ExampleRoot', 'ExampleBranch', 'ExampleLeaf', 'ExampleSibling']);
    });
    expect(screen.queryByText(/hidden at or above threshold/)).toBeNull();
  });
});

describe('ComponentTree host reporting', () => {
  it('forwards the location of a node that resolved to source, unmodified', async () => {
    const { spies, user } = await renderUniformTree();

    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });

    const leaf = rowNamed('ExampleLeaf');
    const chip = within(leaf).getByRole('button', { name: SOURCE_CHIP_NAME });

    // Out of the Tab order, and still pressable by a pointer.
    expect(chip.getAttribute('tabindex')).toBe('-1');
    await user.click(chip);

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);

    const forwarded = spies.onOpenSource.mock.calls[0]?.[0];

    // Field for field, with the same key set, and the same object: no path
    // rewriting, no coordinate arithmetic, no field dropped (AAP 0.4.2).
    expect(forwarded).toEqual(LEAF_SOURCE);
    expect(Object.keys(forwarded ?? {}).sort()).toEqual(Object.keys(LEAF_SOURCE).sort());
    expect(forwarded).toBe(LEAF_SOURCE);

    // A chip click is not also a row selection — the leaf names a render it
    // could have reported — so it neither selects nor expands anything behind
    // the navigation.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(leaf.getAttribute('aria-selected')).toBe('false');
    expect(spies.onExpand).toHaveBeenCalledTimes(1);
  });

  it('lets a pressed chip keep its own keys, without toggling the branch that holds it', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: SOURCED_BRANCH_STRUCTURE }));
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('tree');

    const chip = within(rowNamed('ExampleBranch')).getByRole('button', {
      name: BRANCH_SOURCE_CHIP_NAME,
    });
    await user.click(chip);

    // The pointer press opened the source once, left focus on the chip, and
    // handed the widget's one tab stop to the row that holds it.
    expect(spies.onOpenSource.mock.calls).toEqual([[BRANCH_SOURCE]]);
    expect(spies.onOpenSource.mock.calls[0]?.[0]).toBe(BRANCH_SOURCE);
    expect(document.activeElement).toBe(chip);
    expect(tabStops()).toEqual([rowNamed('ExampleBranch')]);

    // Enter on the focused chip is the chip's: one more open, and the branch it
    // sits on is neither selected — which a row selection would have done —
    // nor toggled.
    await user.keyboard('{Enter}');

    expect(spies.onOpenSource).toHaveBeenCalledTimes(2);
    expect(spies.onOpenSource.mock.calls[1]?.[0]).toBe(BRANCH_SOURCE);
    expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('false');
    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
    expect(spies.onExpand).not.toHaveBeenCalled();

    // Shift+Enter from the chip is still one open, not the command plus the
    // chip's own activation.
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(spies.onOpenSource).toHaveBeenCalledTimes(3);
    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');

    // And the arrow keys still navigate the tree from there.
    await user.keyboard('{ArrowDown}');

    expect(document.activeElement).toBe(rowNamed('ExampleAside'));
    expect(tabStops()).toEqual([rowNamed('ExampleAside')]);
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('keeps a selection local for a node that names no render, and invents none', async () => {
    const { spies, user } = await renderUniformTree();

    // No commit was captured with this snapshot, so nothing offers one.
    expect(screen.queryByRole('button', { name: SHOW_COMMIT_NAME })).toBeNull();

    // A leaf with no location and no representative render: selecting it by
    // pointer and by both keys must invent neither an event reference — nor
    // borrow the branch beside it, which has one — nor a location.
    await user.click(rowNamed('ExampleAside'));
    focusRow(rowNamed('ExampleAside'));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();

    // The row does report itself as the selected one, which is presentation
    // inside this view rather than a claim about the capture.
    expect(rowNamed('ExampleAside').getAttribute('aria-selected')).toBe('true');
    expect(rowNamed('ExampleRoot').getAttribute('aria-selected')).toBe('false');
  });

  it('offers the commit the structure came from, and reports exactly that reference', async () => {
    const stub = resolvingProvider(
      makeSnapshot({
        roots: UNIFORM_STRUCTURE,
        commitEventId: COMMIT_EVENT_ID,
        commitSpanId: COMMIT_SPAN_ID,
        traceId: TRACE_ID,
      }),
    );
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('tree');

    await user.click(screen.getByRole('button', { name: SHOW_COMMIT_NAME }));

    // The snapshot's own reference — a property of the whole view, not of a
    // node — offered once and passed on with the hints it carried.
    expect(spies.onSelectEvent.mock.calls).toEqual([
      [{ eventId: COMMIT_EVENT_ID, spanId: COMMIT_SPAN_ID, traceId: TRACE_ID }],
    ]);
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });
});

describe('ComponentTree selection', () => {
  it('selects a closed branch on a click on its label, keeps it closed, and reports its render', async () => {
    const { spies, user } = await renderUniformTree();

    const branch = rowNamed('ExampleBranch');
    expect(branch.getAttribute('aria-expanded')).toBe('false');

    await user.click(labelOf(branch));

    // Selected, and still closed: a click on a row is not a disclosure.
    expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('true');
    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
    expect(rowNames()).toEqual([...INITIAL_ROW_NAMES]);
    expect(spies.onExpand).not.toHaveBeenCalled();

    // The node's representative render, exactly as the datum names it, with
    // every coordinate it carries and no other key.
    expect(spies.onSelectEvent.mock.calls).toEqual([[BRANCH_RENDER_REF]]);
    expect(Object.keys(spies.onSelectEvent.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'eventId',
      'spanId',
      'traceId',
    ]);
    expect(spies.onOpenSource).not.toHaveBeenCalled();

    // The ids are coordinates for the host, never text on screen.
    expect(document.body.textContent).not.toContain(BRANCH_RENDER_EVENT_ID);
  });

  it('selects an open branch on a click without collapsing it', async () => {
    const { spies, user } = await renderUniformTree();

    await user.click(labelOf(rowNamed('ExampleRoot')));

    expect(rowNamed('ExampleRoot').getAttribute('aria-selected')).toBe('true');
    expect(rowNamed('ExampleRoot').getAttribute('aria-expanded')).toBe('true');
    expect(rowNames()).toEqual([...INITIAL_ROW_NAMES]);
    expect(spies.onExpand).not.toHaveBeenCalled();
    // The root names no representative render, so the selection stays local.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('forwards only the coordinates a node carries, never an undefined one', async () => {
    const { spies, user } = await renderUniformTree();

    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });

    await user.click(labelOf(rowNamed('ExampleLeaf')));

    // The leaf's render carries an event id alone, so that is the whole
    // reference: no span or trace key, not even one set to `undefined`.
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    const reference = spies.onSelectEvent.mock.calls[0]?.[0];
    expect(reference).toStrictEqual({ eventId: LEAF_RENDER_EVENT_ID });
    expect(Object.keys(reference ?? {})).toEqual(['eventId']);

    // A click on the row is not a click on its chip: no file opens.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });

  it('still discloses with the toggle and the arrow keys, reporting each change', async () => {
    const { spies, user } = await renderUniformTree();

    // The toggle opens the branch and reports it — and selects nothing.
    await user.click(
      within(rowNamed('ExampleBranch')).getByRole('button', { name: 'Expand ExampleBranch' }),
    );
    await waitFor(() => {
      expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('true');
    });
    expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('false');
    expect(spies.onExpand.mock.calls).toEqual([[NODE_ID, BRANCH_NODE.id, true]]);

    // ArrowLeft closes it, ArrowRight opens it again, each reported once.
    focusRow(rowNamed('ExampleBranch'));
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => {
      expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
    });

    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('true');
    });

    expect(spies.onExpand.mock.calls).toEqual([
      [NODE_ID, BRANCH_NODE.id, true],
      [NODE_ID, BRANCH_NODE.id, false],
      [NODE_ID, BRANCH_NODE.id, true],
    ]);
    // Disclosure is disclosure: nothing was selected along the way.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('false');
  });

  it('marks a selected row of a flat listing as current, and reports its render', async () => {
    const stub = resolvingProvider(
      snapshotWithOrigin('flat', { roots: UNIFORM_STRUCTURE, maxDepth: 0 }),
    );
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('list', { name: LIST_NAME });

    await user.click(labelOf(rowNamed('ExampleBranch', 'listitem')));

    // A list has no selection state of its own, so the row is the current one.
    const selected = rowNamed('ExampleBranch', 'listitem');
    expect(selected.getAttribute('aria-current')).toBe('true');
    expect(selected.hasAttribute('aria-selected')).toBe(false);
    expect(rowNamed('ExampleRoot', 'listitem').hasAttribute('aria-current')).toBe(false);
    expect(spies.onSelectEvent.mock.calls).toEqual([[BRANCH_RENDER_REF]]);
    expect(spies.onExpand).not.toHaveBeenCalled();
  });

  it('reaches a host that implements the host form, with the coordinates beside the id', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: UNIFORM_STRUCTURE }));
    const selectEvent = vi.fn<(eventId: string, coordinates?: PanelEventCoordinates) => void>();
    const openSource = vi.fn<(location: SourceLocation) => void>();
    const user = userEvent.setup();

    // The form a DevTools panel or an editor webview implements, adapted by
    // the library rather than by this view.
    renderComponent(makeNode(), { provider: stub.provider, actions: { selectEvent, openSource } });
    await screen.findByRole('tree');

    await user.click(labelOf(rowNamed('ExampleBranch')));

    expect(selectEvent.mock.calls).toEqual([
      [BRANCH_RENDER_EVENT_ID, { spanId: BRANCH_RENDER_SPAN_ID, traceId: TRACE_ID }],
    ]);
    expect(openSource).not.toHaveBeenCalled();
    expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ComponentTree bounds and privacy', () => {
  it('draws only the branches the default policy opens, not the whole structure', async () => {
    const snapshot = makeSnapshot({ roots: DEEP_STRUCTURE });
    const stub = resolvingProvider(snapshot);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    // This source answers with one object and no paging, so expansion is the
    // only bound available — and it holds: the rows on screen are a small
    // fraction of the nodes the snapshot reports.
    expect(snapshot.nodeCount).toBe(DEEP_NODE_COUNT);
    expect(rows()).toHaveLength(DEEP_VISIBLE_ROWS);
    expect(rows().length).toBeLessThan(snapshot.nodeCount / 4);

    // Which is stated rather than left to be inferred from the rows.
    expect(screen.getByText(statisticsLine(snapshot, DEEP_VISIBLE_ROWS))).toBeDefined();
    expect(snapshot.maxDepth).toBe(DEEP_CHAIN_LENGTH);
  });

  it('renders nothing it was not given, so no prop or state value can leak', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: [SMUGGLED_NODE], nodeCount: 1 }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    const tree = await screen.findByRole('tree');

    // The node was handed values the datum has no field for. They are not drawn,
    // not titled, not tooltipped and not hidden in an attribute anywhere.
    expect(tree.textContent).not.toContain(SMUGGLED_PROP_VALUE);
    expect(tree.textContent).not.toContain(SMUGGLED_STATE_VALUE);
    expect(document.body.textContent).not.toContain(SMUGGLED_PROP_VALUE);
    expect(document.body.textContent).not.toContain(SMUGGLED_STATE_VALUE);
    expect(document.body.innerHTML).not.toContain(SMUGGLED_PROP_VALUE);
    expect(document.body.innerHTML).not.toContain(SMUGGLED_STATE_VALUE);

    // And there is no affordance that would ask for them: this view has no prop
    // or state inspector, by design (AAP 0.5.2).
    for (const pattern of [/prop/i, /state/i, /inspect/i, /value/i]) {
      expect(screen.queryByRole('button', { name: pattern })).toBeNull();
    }

    // What it does draw is the node it was given.
    expect(rowNames()).toEqual(['ExampleRoot']);
  });
});

describe('ComponentTree shared selection', () => {
  /** The snapshot these cases draw: the uniform structure, with its commit recorded. */
  const COMMITTED_SNAPSHOT = makeSnapshot({
    roots: UNIFORM_STRUCTURE,
    commitEventId: COMMIT_EVENT_ID,
    commitSpanId: COMMIT_SPAN_ID,
    traceId: TRACE_ID,
  });

  /**
   * The tree, under a host whose shared selection is `selection`.
   *
   * @param provider The provider to resolve its query.
   * @param actions The actions to report to.
   * @param selection The panel's current selection.
   * @returns The element tree.
   */
  function hostedTree(
    provider: DataProvider,
    actions: PanelActions,
    selection: PanelSelection | undefined,
  ) {
    return (
      <DataProviderContext.Provider value={provider}>
        <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
          <PanelActionsContext.Provider value={actions}>
            <PanelSelectionContext.Provider value={{ selection }}>
              <ComponentTree node={makeNode()} />
            </PanelSelectionContext.Provider>
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>
    );
  }

  /**
   * The names of the rows drawn as selected, each asserted to carry the state
   * class and `aria-selected` together.
   *
   * @returns The selected rows' names, in document order.
   */
  function selectedRowNames(): string[] {
    return rows()
      .filter((row) => {
        const selected = row.getAttribute('aria-selected') === 'true';

        expect(row.classList.contains('dg-is-selected')).toBe(selected);

        return selected;
      })
      .map((row) => row.querySelector(`.${LABEL_CLASS}`)?.textContent ?? '');
  }

  it('lets a node it marked give way the moment the panel selects an event', async () => {
    const stub = resolvingProvider(COMMITTED_SNAPSHOT);
    const spies = makeActions();
    const user = userEvent.setup();

    const { rerender } = render(hostedTree(stub.provider, spies.actions, undefined));
    await screen.findByRole('tree');

    // A node activated while nothing is selected is marked as the tree's row.
    await user.click(rowNamed('ExampleAside'));

    expect(selectedRowNames()).toEqual(['ExampleAside']);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // Re-delivering the same (absent) selection changes nothing.
    rerender(hostedTree(stub.provider, spies.actions, undefined));
    expect(selectedRowNames()).toEqual(['ExampleAside']);

    // Another view selects an event: the node stands for none, so the tree
    // stops claiming a selection that would contradict the panel's.
    rerender(hostedTree(stub.provider, spies.actions, { eventId: 'event-example-elsewhere' }));
    expect(selectedRowNames()).toEqual([]);

    // A node activated under that selection is marked again, until it moves.
    await user.click(rowNamed('ExampleRoot'));
    expect(selectedRowNames()).toEqual(['ExampleRoot']);

    rerender(hostedTree(stub.provider, spies.actions, { eventId: 'event-example-later' }));
    expect(selectedRowNames()).toEqual([]);
  });

  it('draws the commit control pressed exactly while the commit is the selected event', async () => {
    const stub = resolvingProvider(COMMITTED_SNAPSHOT);
    const spies = makeActions();
    const user = userEvent.setup();

    const { rerender } = render(hostedTree(stub.provider, spies.actions, undefined));
    await screen.findByRole('tree');

    const commit = (): HTMLElement => screen.getByRole('button', { name: SHOW_COMMIT_NAME });

    expect(commit().getAttribute('aria-pressed')).toBe('false');

    // Under a host the control reports and the host records; its pressed state
    // follows the host's selection, not a copy kept here.
    await user.click(commit());

    expect(spies.onSelectEvent.mock.calls).toEqual([
      [{ eventId: COMMIT_EVENT_ID, spanId: COMMIT_SPAN_ID, traceId: TRACE_ID }],
    ]);
    expect(commit().getAttribute('aria-pressed')).toBe('false');

    rerender(hostedTree(stub.provider, spies.actions, { eventId: COMMIT_EVENT_ID }));
    expect(commit().getAttribute('aria-pressed')).toBe('true');

    // The same span named under another record's id is still the commit.
    rerender(
      hostedTree(stub.provider, spies.actions, {
        eventId: 'event-example-other',
        traceId: TRACE_ID,
        spanId: COMMIT_SPAN_ID,
      }),
    );
    expect(commit().getAttribute('aria-pressed')).toBe('true');

    rerender(hostedTree(stub.provider, spies.actions, { eventId: 'event-example-elsewhere' }));
    expect(commit().getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps its own selection outside a host, where the commit supersedes a node', async () => {
    const stub = resolvingProvider(COMMITTED_SNAPSHOT);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('tree');

    await user.click(rowNamed('ExampleBranch'));
    expect(selectedRowNames()).toEqual(['ExampleBranch']);

    const commit = screen.getByRole('button', { name: SHOW_COMMIT_NAME });
    await user.click(commit);

    // With no host to share with, the view records the commit itself: the
    // control is pressed, and the node it had marked gives way to it.
    expect(commit.getAttribute('aria-pressed')).toBe('true');
    expect(selectedRowNames()).toEqual([]);
  });

  it('records a node’s render outside a host, so the commit control lets go of it', async () => {
    const stub = resolvingProvider(COMMITTED_SNAPSHOT);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('tree');

    const commit = (): HTMLElement => screen.getByRole('button', { name: SHOW_COMMIT_NAME });

    await user.click(commit());
    expect(commit().getAttribute('aria-pressed')).toBe('true');

    // Like every other event-bearing view, the tree records the render it
    // reported as its own selection: the node is marked, and the commit is no
    // longer the selected event — the two never claim the selection together.
    await user.click(rowNamed('ExampleBranch'));
    expect(selectedRowNames()).toEqual(['ExampleBranch']);
    expect(commit().getAttribute('aria-pressed')).toBe('false');

    // A node that names no render records nothing, so the selection it was
    // activated beside stays in force and the commit stays unpressed.
    await user.click(rowNamed('ExampleAside'));
    expect(selectedRowNames()).toEqual(['ExampleAside']);
    expect(commit().getAttribute('aria-pressed')).toBe('false');
  });

  /*
   * The transition a fixed context value never shows: a host that records the
   * reported render as the panel's selection, so the selection after a click
   * is not the one the node was activated under.
   */

  /** The event the panel had selected before a node was activated. */
  const PRIOR_EVENT_ID = 'event-example-prior';

  /** An unrelated event another view — or the surface — selects afterwards. */
  const ELSEWHERE_EVENT_ID = 'event-example-elsewhere';

  /** The accessible names of the two controls {@link OtherView} draws. */
  const SELECT_PRIOR_NAME = 'Select the prior event';
  const SELECT_ELSEWHERE_NAME = 'Select another event';

  /**
   * A second view of the same panel, reduced to what these cases need: two
   * controls that report an event through the shared action context, exactly
   * as any other view's activation does.
   *
   * @returns The two controls.
   */
  function OtherView(): ReactElement {
    const actions = usePanelActions();

    return (
      <div>
        <button
          type="button"
          onClick={() => {
            actions?.onSelectEvent({ eventId: PRIOR_EVENT_ID });
          }}
        >
          {SELECT_PRIOR_NAME}
        </button>
        <button
          type="button"
          onClick={() => {
            actions?.onSelectEvent({ eventId: ELSEWHERE_EVENT_ID });
          }}
        >
          {SELECT_ELSEWHERE_NAME}
        </button>
      </div>
    );
  }

  /** What {@link RecordingHost} is mounted with. */
  interface RecordingHostProps {
    /** The provider to resolve the tree's query. */
    readonly provider: DataProvider;

    /** The spies every report reaches after it has been recorded. */
    readonly spies: ActionSpies;

    /** The panel's selection before any gesture, `undefined` for none. */
    readonly initial: PanelSelection | undefined;
  }

  /**
   * The panel host's selection wiring and nothing else. It holds the panel's
   * shared selection, provides it through `PanelSelectionContext`, and records
   * every reported reference as the new selection — the id plus only the
   * coordinates present, as `PanelHost` records one — before the spy hears it.
   * The tree and {@link OtherView} share it, as two views of one panel do.
   *
   * @param props See {@link RecordingHostProps}.
   * @returns The contexts, the tree and the second view.
   */
  function RecordingHost(props: RecordingHostProps): ReactElement {
    const { provider, spies, initial } = props;
    const [selection, setSelection] = useState<PanelSelection | undefined>(initial);
    const actions = useMemo<PanelActions>(
      () => ({
        onSelectEvent: (ref: PanelEventRef) => {
          setSelection({
            eventId: ref.eventId,
            ...(ref.traceId === undefined ? {} : { traceId: ref.traceId }),
            ...(ref.spanId === undefined ? {} : { spanId: ref.spanId }),
          });
          spies.onSelectEvent(ref);
        },
        onOpenSource: spies.onOpenSource,
        onExpand: spies.onExpand,
        onFilterChange: spies.onFilterChange,
      }),
      [spies],
    );
    const selectionState = useMemo(() => ({ selection }), [selection]);

    return (
      <DataProviderContext.Provider value={provider}>
        <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
          <PanelActionsContext.Provider value={actions}>
            <PanelSelectionContext.Provider value={selectionState}>
              <ComponentTree node={makeNode()} />
              <OtherView />
            </PanelSelectionContext.Provider>
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>
    );
  }

  /**
   * A validated panel whose layout is this node alone, for the cases that
   * mount the real `PanelHost`. Its summary registers are empty, so the head
   * carries no evidence chip that could select anything.
   *
   * @returns A fresh specification.
   */
  function treePanel(): PanelSpec {
    return {
      version: PANEL_SPEC_VERSION,
      id: 'panel-example-tree',
      sessionId: PANEL_SESSION_ID,
      panelVersion: 1,
      title: 'Panel under test',
      summary: { observed: [], likelyCauses: [] },
      layout: [makeNode()],
    };
  }

  /**
   * The real panel host around {@link treePanel}, with its selection driven by
   * the surface — the way the DevTools panel passes its drawer's event, which
   * its store updates a step after the report.
   *
   * @param spec The panel to draw; the same object across a case's renders.
   * @param provider The provider to resolve the tree's query.
   * @param actions The actions every report reaches.
   * @param selectedEventId The surface's selected event, `null` for none.
   * @returns The element tree.
   */
  function drivenPanel(
    spec: PanelSpec,
    provider: DataProvider,
    actions: PanelActions,
    selectedEventId: string | null,
  ): ReactElement {
    return (
      <PanelHost
        spec={spec}
        dataProvider={provider}
        actions={actions}
        selectedEventId={selectedEventId}
      />
    );
  }

  it('keeps a node marked when the host records the render it reported', async () => {
    const stub = resolvingProvider(COMMITTED_SNAPSHOT);
    const spies = makeActions();
    const user = userEvent.setup();

    render(
      <RecordingHost
        provider={stub.provider}
        spies={spies}
        initial={{ eventId: PRIOR_EVENT_ID }}
      />,
    );
    await screen.findByRole('tree');

    await user.click(rowNamed('ExampleBranch'));

    // The host heard the render and made it the panel's selection, and the row
    // that reported it is still the tree's selected one, by attribute and class.
    expect(spies.onSelectEvent.mock.calls).toEqual([[BRANCH_RENDER_REF]]);
    const branch = rowNamed('ExampleBranch');
    expect(branch.getAttribute('aria-selected')).toBe('true');
    expect(branch.classList.contains('dg-is-selected')).toBe(true);
    expect(selectedRowNames()).toEqual(['ExampleBranch']);

    // Another view selects another event: the mark gives way.
    await user.click(screen.getByRole('button', { name: SELECT_ELSEWHERE_NAME }));
    expect(selectedRowNames()).toEqual([]);

    // A return to the selection the node was activated under does not bring
    // it back: that selection is not the event the node reported.
    await user.click(screen.getByRole('button', { name: SELECT_PRIOR_NAME }));
    expect(selectedRowNames()).toEqual([]);
  });

  it('keeps a flat listing’s row current when the host records the render it reported', async () => {
    const stub = resolvingProvider(
      snapshotWithOrigin('flat', { roots: UNIFORM_STRUCTURE, maxDepth: 0 }),
    );
    const spies = makeActions();
    const user = userEvent.setup();

    render(<RecordingHost provider={stub.provider} spies={spies} initial={undefined} />);
    await screen.findByRole('list', { name: LIST_NAME });

    await user.click(labelOf(rowNamed('ExampleBranch', 'listitem')));

    expect(spies.onSelectEvent.mock.calls).toEqual([[BRANCH_RENDER_REF]]);
    const current = rowNamed('ExampleBranch', 'listitem');
    expect(current.getAttribute('aria-current')).toBe('true');
    expect(current.classList.contains('dg-is-selected')).toBe(true);

    await user.click(screen.getByRole('button', { name: SELECT_ELSEWHERE_NAME }));

    const released = rowNamed('ExampleBranch', 'listitem');
    expect(released.hasAttribute('aria-current')).toBe(false);
    expect(released.classList.contains('dg-is-selected')).toBe(false);
  });

  it('keeps a node marked inside the panel host, and releases it to any other selection', async () => {
    const stub = resolvingProvider(COMMITTED_SNAPSHOT);
    const spies = makeActions();
    const user = userEvent.setup();

    render(<PanelHost spec={treePanel()} dataProvider={stub.provider} actions={spies.actions} />);
    await screen.findByRole('tree');

    const commit = (): HTMLElement => screen.getByRole('button', { name: SHOW_COMMIT_NAME });

    // The host records the node's render as the panel's selection, and the
    // node keeps its mark through it.
    await user.click(rowNamed('ExampleBranch'));
    expect(spies.onSelectEvent.mock.calls).toEqual([[BRANCH_RENDER_REF]]);
    expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('true');
    expect(selectedRowNames()).toEqual(['ExampleBranch']);
    expect(commit().getAttribute('aria-pressed')).toBe('false');

    // This view's own commit control selects another event: the node lets go.
    await user.click(commit());
    expect(commit().getAttribute('aria-pressed')).toBe('true');
    expect(selectedRowNames()).toEqual([]);

    // Activated while the commit is selected, the node is marked as soon as
    // its render is the panel's selection…
    await user.click(rowNamed('ExampleBranch'));
    expect(commit().getAttribute('aria-pressed')).toBe('false');
    expect(selectedRowNames()).toEqual(['ExampleBranch']);

    // …and a return to the commit, the selection it was activated under, does
    // not bring the mark back.
    await user.click(commit());
    expect(commit().getAttribute('aria-pressed')).toBe('true');
    expect(selectedRowNames()).toEqual([]);
  });

  it('keeps a node marked while a driving surface catches up, then follows the surface', async () => {
    const stub = resolvingProvider(COMMITTED_SNAPSHOT);
    const spies = makeActions();
    const user = userEvent.setup();
    const spec = treePanel();

    const { rerender } = render(drivenPanel(spec, stub.provider, spies.actions, PRIOR_EVENT_ID));
    await screen.findByRole('tree');

    // The report reaches the surface, whose drawer has not moved yet: the panel
    // still selects the previous event, and the node stays marked meanwhile.
    await user.click(rowNamed('ExampleBranch'));
    expect(spies.onSelectEvent.mock.calls).toEqual([[BRANCH_RENDER_REF]]);
    expect(selectedRowNames()).toEqual(['ExampleBranch']);

    // The surface catches up with the render the node reported.
    rerender(drivenPanel(spec, stub.provider, spies.actions, BRANCH_RENDER_EVENT_ID));
    expect(rowNamed('ExampleBranch').getAttribute('aria-selected')).toBe('true');
    expect(selectedRowNames()).toEqual(['ExampleBranch']);

    // A second node, activated while the surface shows the first one's render.
    // Until the surface catches up, the host re-derives that render by its id
    // alone — without the span and trace the branch reported — and the node
    // must stay marked through that window too.
    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });
    await user.click(labelOf(rowNamed('ExampleLeaf')));
    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({ eventId: LEAF_RENDER_EVENT_ID });
    expect(selectedRowNames()).toEqual(['ExampleLeaf']);

    rerender(drivenPanel(spec, stub.provider, spies.actions, LEAF_RENDER_EVENT_ID));
    expect(selectedRowNames()).toEqual(['ExampleLeaf']);

    // The surface moves elsewhere: the mark goes, and a return to the event the
    // leaf was activated under does not bring it back.
    rerender(drivenPanel(spec, stub.provider, spies.actions, ELSEWHERE_EVENT_ID));
    expect(selectedRowNames()).toEqual([]);

    rerender(drivenPanel(spec, stub.provider, spies.actions, BRANCH_RENDER_EVENT_ID));
    expect(selectedRowNames()).toEqual([]);
  });

  it('drops a node’s mark for good when a driving surface selects another event first', async () => {
    const stub = resolvingProvider(COMMITTED_SNAPSHOT);
    const spies = makeActions();
    const user = userEvent.setup();
    const spec = treePanel();

    const { rerender } = render(drivenPanel(spec, stub.provider, spies.actions, PRIOR_EVENT_ID));
    await screen.findByRole('tree');

    await user.click(rowNamed('ExampleBranch'));
    expect(selectedRowNames()).toEqual(['ExampleBranch']);

    // The surface selects another event, never the render the node reported.
    rerender(drivenPanel(spec, stub.provider, spies.actions, ELSEWHERE_EVENT_ID));
    expect(selectedRowNames()).toEqual([]);

    // Back to the event the node was activated under: the mark stays gone,
    // and so it does when the surface clears its selection altogether.
    rerender(drivenPanel(spec, stub.provider, spies.actions, PRIOR_EVENT_ID));
    expect(selectedRowNames()).toEqual([]);

    rerender(drivenPanel(spec, stub.provider, spies.actions, null));
    expect(selectedRowNames()).toEqual([]);
  });
});
