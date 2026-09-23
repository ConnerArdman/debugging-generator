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
 *     roles, its single roving tab stop, each of the seven keys it owns, and the
 *     word beside the highlight's icon are all asserted mechanically rather than
 *     described in a comment.
 *   - **A snapshot states its own limits (AAP 0.6.6).** The structure is taken
 *     at the last commit of a capture and cannot always be reconstructed, so
 *     `origin` and `degraded` are part of the answer. Two cases hold that line:
 *     a reconstructed, degraded snapshot must say both things on screen, and an
 *     `origin: "flat"` snapshot must render a **list** — no `role="group"`, no
 *     nesting — because a single level of nodes dressed as a tree claims a
 *     hierarchy nobody observed. That is the same class of error as an
 *     unevidenced fact in an analysis, which AAP 0.8.4 rules out structurally.
 *   - **Nothing is selected that does not exist.** A node of this datum is an
 *     aggregate with no event of its own, so activating one must never report a
 *     selected event; the single legitimate reference — the commit the structure
 *     came from — is offered once, in the toolbar, and only when the capture
 *     recorded it. Both halves are asserted, because a fabricated coordinate in
 *     an evidence drawer is worse than an absent one.
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

import type { ComponentTreeNode as ComponentTreeNodeSpec, DataQuery } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import { COMPONENT_TREE_NODE_ID_PREFIX } from '@debuggen/telemetry';
import type {
  ComponentTreeNode,
  ComponentTreeOrigin,
  ComponentTreeSnapshot,
  RenderTrigger,
} from '@debuggen/telemetry';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
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
const EXPAND_ALL_NAME = 'Expand all';
const COLLAPSE_ALL_NAME = 'Collapse all';
const SHOW_COMMIT_NAME = 'Show the commit';

/** The toolbar's own accessible name, which makes it a labelled group. */
const TOOLBAR_NAME = 'Component tree controls';

/** The non-colour half of the threshold highlight. */
const ABOVE_THRESHOLD_TEXT = 'Above threshold';

/** The error state's retry control and the name it gives the failing query. */
const RETRY_NAME = 'Retry';
const FAILING_QUERY_NAME = 'Failing query';

/** The announcement the skeleton state makes while the query is unsettled. */
const LOADING_LABEL = 'Loading the component tree…';

/** The three origin badges, and the explanation each one carries. */
const CAPTURED_ORIGIN_LABEL = 'Captured structure';
const RECONSTRUCTED_ORIGIN_LABEL = 'Reconstructed structure';
const FLAT_ORIGIN_LABEL = 'Flat listing';
const RECONSTRUCTED_ORIGIN_DETAIL =
  'Rebuilt from the components that rendered during the capture, so anything that did not render is missing from it.';
const FLAT_ORIGIN_DETAIL =
  'No hierarchy could be rebuilt, so every observed component is listed at a single level.';

/** The error state's own title and the generic sentence under it. */
const ERROR_TITLE = 'Could not load the component tree';
const ERROR_MESSAGE_PATTERN = /could not be read from the capture/i;

/**
 * A provider's own failure message, which must **not** reach the screen.
 *
 * A transport diagnostic is not a finding, so the error state shows this
 * component's copy plus the failure's code and the query that failed; the
 * provider's sentence stays in the log (AAP 0.5.5).
 */
const PROVIDER_FAILURE_MESSAGE = 'The channel to the service is closed.';

/** The code that failure carries, from the shared error vocabulary. */
const PROVIDER_FAILURE_CODE = 'TRANSPORT_DISCONNECTED';

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
  return `${formatCount(marked)} above threshold`;
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
    `${formatCount(snapshot.nodeCount)} nodes`,
    `${formatCount(snapshot.maxDepth + 1)} levels`,
    `${formatCount(shown)} shown`,
  ].join(' · ');
}

/** The two notes a snapshot raises about its own completeness. */
const DEGRADED_NOTE = 'This structure is known to be incomplete — read it as partial evidence.';
const TRUNCATED_NOTE = 'Some nodes were dropped when a size bound was reached.';

/** Always shown: the snapshot is a moment with history attached. */
const PROVENANCE_NOTE =
  'Structure as it stood at the last commit of the capture; render counts are cumulative for the whole capture.';

/** The units the row's two numeric cells announce to a screen reader. */
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
  readonly source?: SourceLocation | undefined;
  readonly children?: readonly ComponentTreeNode[] | undefined;
};

/**
 * One node of a component-tree snapshot.
 *
 * Complete and datum-shaped by construction: an id carrying the producer's own
 * prefix, a display name, the node's depth, a cumulative render count and a
 * cumulative render time. The optional fields — instance key, last trigger,
 * source location, children — are present only when a case asks for them.
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

/** A leaf with a resolved location: the one node that offers a source chip. */
const LEAF_NODE = makeTreeNode({
  id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0/0`,
  component: 'ExampleLeaf',
  depth: 2,
  renderCount: 3,
  totalDurationMs: 6,
  lastTrigger: 'context',
  source: LEAF_SOURCE,
});

/** Its sibling, with no location, so a case can activate a row without a chip. */
const SIBLING_NODE = makeTreeNode({
  id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0/1`,
  component: 'ExampleSibling',
  depth: 2,
  renderCount: 3,
  totalDurationMs: 4,
  key: 'example-key-1',
});

/** The second-level parent: collapsed on first paint, which the key cases need. */
const BRANCH_NODE = makeTreeNode({
  id: `${COMPONENT_TREE_NODE_ID_PREFIX}0/0`,
  component: 'ExampleBranch',
  depth: 1,
  renderCount: 3,
  totalDurationMs: 9,
  children: [LEAF_NODE, SIBLING_NODE],
});

/** A first-level leaf, so the top level holds both a parent and a leaf. */
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
 * The three payloads that violate their own type.
 *
 * This file contains exactly three type assertions — {@link MALFORMED_PAYLOAD},
 * {@link SMUGGLED_NODE} and {@link UNMEASURED_NODE} — and each one is the
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
 */
const MALFORMED_PAYLOAD = { roots: [] } as unknown as ComponentTreeSnapshot;

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
      <PanelActionsContext.Provider value={context.actions}>
        <ComponentTree node={node} />
      </PanelActionsContext.Provider>
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

    // An empty snapshot is a success, so it is drawn as an absence and not as a
    // failure — and there is no tree, no toolbar and no threshold to operate.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
    expect(screen.queryByRole('group', { name: TOOLBAR_NAME })).toBeNull();
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
    expect(within(alert).getByText(ERROR_MESSAGE_PATTERN)).toBeDefined();

    // The failure's code reaches the reader, because it is actionable; the
    // provider's own sentence does not take the place of the product's copy.
    expect(alert.textContent).toContain(PROVIDER_FAILURE_CODE);
    expect(alert.textContent).not.toContain(PROVIDER_FAILURE_MESSAGE);

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

  it('reports a node whose query names a source it cannot draw, and asks for nothing', async () => {
    const stub = resolvingProvider(makeSnapshot({ roots: UNIFORM_STRUCTURE }));

    renderComponent(makeNode({ query: { source: 'renders' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');

    // The node's own query is what the reader is shown, and no retry is offered:
    // re-issuing it cannot change the answer.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: 'renders' });
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();

    // Nothing was asked of the provider, and nothing was drawn as if it had been.
    expect(stub.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('refuses to draw a payload that is not a snapshot, and names the provider', async () => {
    const stub = recordingProvider(() =>
      Promise.resolve<DataQueryResponse>({ source: 'componentTree', data: MALFORMED_PAYLOAD }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('provider');
    expect(within(alert).getByRole('button', { name: RETRY_NAME })).toBeDefined();

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
    await screen.findByRole('tree');

    expect(screen.getByText(CAPTURED_ORIGIN_LABEL).classList.contains('dg-badge')).toBe(true);
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
    await screen.findByRole('tree');

    // The origin is a visible badge with a plain-language explanation, never a
    // tooltip-only footnote: the explanation is in the document either way.
    expect(screen.getByText(RECONSTRUCTED_ORIGIN_LABEL).classList.contains('dg-badge')).toBe(true);
    expect(screen.getByText(RECONSTRUCTED_ORIGIN_DETAIL).getAttribute('role')).toBe('tooltip');
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

    // And the reader is told what they are looking at, and why it is caveated.
    expect(screen.getByText(FLAT_ORIGIN_LABEL)).toBeDefined();
    expect(screen.getByText(FLAT_ORIGIN_DETAIL).getAttribute('role')).toBe('tooltip');
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

  it('activates the focused row with Enter and with Space', async () => {
    const { spies, user } = await renderUniformTree();

    // Enter on a row that owns children toggles it, exactly as its toggle does.
    focusRow(rowNamed('ExampleBranch'));
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('true');
    });
    expect(spies.onExpand.mock.calls).toEqual([[NODE_ID, BRANCH_NODE.id, true]]);

    // Space does the same thing, which is what a composite widget owes both keys.
    await user.keyboard(' ');

    await waitFor(() => {
      expect(rowNamed('ExampleBranch').getAttribute('aria-expanded')).toBe('false');
    });
    expect(spies.onExpand.mock.calls).toEqual([
      [NODE_ID, BRANCH_NODE.id, true],
      [NODE_ID, BRANCH_NODE.id, false],
    ]);

    // Enter on a row that resolved to source opens it, and reports nothing else.
    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });

    focusRow(rowNamed('ExampleLeaf'));
    await user.keyboard('{Enter}');

    expect(spies.onOpenSource.mock.calls).toEqual([[LEAF_SOURCE]]);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
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
});

describe('ComponentTree threshold', () => {
  it('marks a node above the derived threshold with a word as well as a state', async () => {
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

    // The mark is a word beside an icon and a state class — never colour alone.
    const marked = rowNamed('ExampleLeaf');
    expect(within(marked).getByText(ABOVE_THRESHOLD_TEXT)).toBeDefined();
    expect(marked.classList.contains(HIGHLIGHTED_CLASS)).toBe(true);

    // A node below the threshold carries neither.
    const unmarked = rowNamed('ExampleSibling');
    expect(within(unmarked).queryByText(ABOVE_THRESHOLD_TEXT)).toBeNull();
    expect(unmarked.classList.contains(HIGHLIGHTED_CLASS)).toBe(false);
    expect(rowNamed('ExampleRoot').classList.contains(HIGHLIGHTED_CLASS)).toBe(false);

    // And the reader is told how many rows carry the mark.
    expect(screen.getByText(markedStatus(1))).toBeDefined();
    expect(screen.getAllByText(ABOVE_THRESHOLD_TEXT)).toHaveLength(1);
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
    expect(screen.getAllByText(ABOVE_THRESHOLD_TEXT)).toHaveLength(3);

    // Reported as the reader typed it, against this node's id: a host may
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
});

describe('ComponentTree host reporting', () => {
  it('forwards the location of a node that resolved to source, unmodified', async () => {
    const { spies, user } = await renderUniformTree();

    await user.click(screen.getByRole('button', { name: EXPAND_ALL_NAME }));
    await waitFor(() => {
      expect(rowNames()).toEqual([...EXPANDED_ROW_NAMES]);
    });

    const leaf = rowNamed('ExampleLeaf');
    await user.click(within(leaf).getByRole('button', { name: SOURCE_CHIP_NAME }));

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);

    const forwarded = spies.onOpenSource.mock.calls[0]?.[0];

    // Field for field, with the same key set, and the same object: no path
    // rewriting, no coordinate arithmetic, no field dropped (AAP 0.4.2).
    expect(forwarded).toEqual(LEAF_SOURCE);
    expect(Object.keys(forwarded ?? {}).sort()).toEqual(Object.keys(LEAF_SOURCE).sort());
    expect(forwarded).toBe(LEAF_SOURCE);

    // A chip click is not also a row activation, so it neither expands nor
    // selects anything behind the navigation.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).toHaveBeenCalledTimes(1);
  });

  it('never reports a selected event for a node, which stands for none', async () => {
    const { spies, user } = await renderUniformTree();

    // No commit was captured with this snapshot, so nothing offers one.
    expect(screen.queryByRole('button', { name: SHOW_COMMIT_NAME })).toBeNull();

    // A leaf with no location: activating it by pointer and by both activation
    // keys must invent neither an event reference nor a location.
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

    // The one legitimate reference in the snapshot, offered once for the whole
    // view and passed on with the hints it carried.
    expect(spies.onSelectEvent.mock.calls).toEqual([
      [{ eventId: COMMIT_EVENT_ID, spanId: COMMIT_SPAN_ID, traceId: TRACE_ID }],
    ]);
    expect(spies.onOpenSource).not.toHaveBeenCalled();
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
