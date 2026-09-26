/**
 * `components/ComponentTree` — the renderer for the `componentTree` panel node.
 *
 * The node's contract fits in one line: the `componentTree` data source
 * resolves to a component-tree snapshot — an owner/parent tree with per-node
 * render counts — drawn as an expandable tree that highlights the components
 * above a render threshold. Everything below follows from that sentence plus
 * three properties of the datum it draws.
 *
 * ## What the datum actually is, and what that forbids
 *
 * The snapshot is **structure with history attached, not a live tree**. It was
 * taken at the last commit of the capture, and each node's `renderCount` is
 * cumulative over the whole capture rather than over that commit. So the copy
 * in this view never implies inspection of a running page: it says "at the last
 * commit of the capture", and the counts are labelled as cumulative.
 *
 * The snapshot also **states its own limits**, and they are part of the answer
 * rather than diagnostics:
 *
 *   - `origin` records how the structure was obtained — serialized by the
 *     runtime, rebuilt from the owner chains of the individual renders, or not
 *     rebuilt at all. A reconstruction covers only what rendered during the
 *     capture; presenting it as the page's structure would be a quiet lie, so
 *     the origin is a visible badge with a plain-language explanation, never a
 *     tooltip-only footnote. The explanation is a line of text in the note
 *     above the tree, which the tree names with `aria-describedby`: a sighted
 *     reader sees it without hovering, and focusing the tree announces it.
 *   - `degraded` and `truncated` record incompleteness. Both are surfaced as
 *     short notes above the tree, and `nodeCount`/`maxDepth` are stated as
 *     numbers rather than implied by whatever happens to be on screen.
 *   - `origin: 'flat'` means no hierarchy could be reconstructed. This view
 *     then renders a **list** — `role="list"` of `role="listitem"` — because a
 *     single level of nodes dressed as a tree claims a structure nobody
 *     observed.
 *
 * A node's **event reference is the render that supplied its last trigger**. A
 * node is an aggregate (its count is per component, across every position that
 * component occupies), so the producer names one real, captured render to stand
 * for it — `lastRenderEventId`, with that render's span and trace — and
 * selecting the node reports exactly that reference, carrying only the
 * coordinates the datum holds. A node that is structure alone never rendered
 * during the capture and carries no reference; selecting it stays inside this
 * view and reports nothing, because an invented id would resolve to nothing, or
 * to the wrong thing, in a drawer the developer reads as evidence. The commit
 * the structure came from is a property of the whole view rather than of a
 * node, so it is offered once, in the toolbar, and only when the capture
 * actually recorded it.
 *
 * The panel has one selected event, owned by the panel host and read here
 * through `useViewSelection`. The commit control is drawn pressed while the
 * commit is that event. A node the reader activated is marked as the tree's
 * selected row (`aria-selected`, or `aria-current` in a flat listing, with
 * `dg-is-selected`) for as long as the panel's selection is the one that
 * activation left it with: the node's representative render once the host has
 * recorded the report, or — for a node that names none — the selection it was
 * activated beside. Any other selection takes the mark away — and a node whose
 * render was reported does not reclaim it when the panel later returns to the
 * selection it was activated under — so the tree never shows a selection that
 * contradicts the event every other view and the details drawer show.
 *
 * ## Privacy
 *
 * A node carries a display name, an optional instance key, counts, a duration,
 * the trigger of its most recent render and that render's ids, and an optional
 * source location. Prop and state **values are structurally absent from the
 * datum**, which is the privacy guarantee rather than an omission — so this
 * file adds no prop or state inspector, and renders nothing it was not given.
 * The render ids are coordinates handed to the host, never text on screen.
 * Names and keys are length-bounded through `../utils/format` before they
 * reach the DOM, because they arrive from a page this product does not control.
 * `docs/SECURITY.md` ("Browser tier — the page agent" and "Never captured")
 * states what the capture records for this snapshot and what it never records.
 *
 * ## Accessibility
 *
 * The tree is a single composite widget with **one tab stop**: a roving
 * `tabIndex` over the visible rows, and nothing inside a row in the Tab order.
 * The keyboard model, on the focused row:
 *
 *   - ArrowDown/ArrowUp — the next and previous visible row; the ends do not
 *     wrap round.
 *   - ArrowRight — expand a closed branch, then descend to its first child.
 *   - ArrowLeft — collapse an open branch, then ascend to the parent.
 *   - Home/End — the first and last visible row.
 *   - Enter/Space — select the row, and nothing else: it becomes the selected
 *     row (`aria-selected` in a tree, `aria-current` in a flat listing) and,
 *     when its node names a representative render, that event is reported to
 *     the host with `onSelectEvent`. Selection never toggles a branch and never
 *     opens a file. A pointer click on the row, outside its two controls, is
 *     the same gesture.
 *   - Shift+Enter — open the row's source, on any row that resolved to one,
 *     branch or leaf alike, without toggling or selecting it. Offered only when
 *     the host can open a file, advertised on the row with
 *     `aria-keyshortcuts`, and stated once in the note above the tree with a
 *     `Kbd` hint. A row that cannot open anything leaves the key untouched.
 *
 * Selection and disclosure are separate gestures on purpose: a developer who
 * selects a branch to read its evidence must not lose the rows beneath it. So
 * disclosure belongs to ArrowRight/ArrowLeft, to the row's toggle and to the
 * toolbar's Expand all/Collapse all, and to nothing else.
 *
 * The two controls a row may hold — the disclosure toggle and the source chip
 * — are `tabIndex={-1}`: still real buttons a pointer can press, but reached
 * from the keyboard through the row's own keys above rather than by Tab, so a
 * row is never two or three stops. A pointer press on either leaves focus on
 * that control; the row still takes the roving stop (its `focus` handler sees
 * the focus bubble up), the arrow keys still navigate from there, and Enter or
 * Space is left to the focused control's own activation instead of being read
 * as a row selection — so pressing Enter on a branch's chip opens the source
 * and selects nothing.
 *
 * A collapsed branch does not hide the finding inside it: when marked nodes sit
 * beneath a closed row, the row carries a badge stating how many — an icon and
 * words, never colour alone — and names that badge, together with its own
 * mark, in its `aria-describedby`, so the count is announced with the row.
 *
 * Tab is never hijacked and focus is never trapped: a key this widget does not
 * own falls through untouched.
 *
 * The child lists are real `role="group"` elements, but they are **siblings** of
 * the row they belong to rather than its descendants, tied to it with
 * `aria-owns` (and named to the toggle with `aria-controls`). That is not a
 * stylistic choice: `src/styles/components.css` defines
 * `.dg-component-tree__node` as the row itself — a flex line holding the
 * toggle, the label and the counts, indented by
 * `calc(var(--dgc-depth) * var(--dg-space-4))` — so nesting a group inside a
 * row would lay the children out *along* it and compound the indentation.
 * `aria-owns` expresses the same parent/child relation to assistive technology
 * with the DOM the stylesheet describes.
 *
 * Indentation is therefore the `--dgc-depth` custom property and nothing else.
 * This file writes no other inline style, no colour and no dimension: every
 * value it produces is a token reference resolved by the stylesheet.
 *
 * ## Transport blindness
 *
 * Data arrives only through `useQuery(node.query)`, resolved by whatever
 * `DataProvider` the surrounding host mounted; interactions leave only through
 * `PanelActions`. No socket, no `fetch`, no message name, no knowledge of which
 * of the two host surfaces is rendering — the rule `docs/ARCHITECTURE.md`
 * ("The renderer contract") sets for every component.
 */

import clsx from 'clsx';
import { ChevronDown, ChevronRight, ListTree, TriangleAlert } from 'lucide-react';
import { Fragment, useCallback, useId, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from 'react';

import { PANEL_NODE_CATALOG, isSourceAllowedForNode } from '@debuggen/panel-schema';
import type {
  DataQuery,
  DataQuerySource,
  ComponentTreeNode as ComponentTreeNodeSpec,
} from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
// `ComponentTreeNode` names two different things in this product: the panel
// **spec** node that selects this component (imported above, aliased) and the
// **telemetry** datum this component draws (imported below, unaliased). The
// alias is load-bearing — do not "tidy" it away by dropping one of the two.
import type {
  ComponentTreeNode,
  ComponentTreeOrigin,
  ComponentTreeSnapshot,
} from '@debuggen/telemetry';

import type { PanelEventRef, PanelSelection } from '../host/PanelActions';
import { matchesPanelSelection, usePanelActions, useViewSelection } from '../host/PanelActions';
import { queryFailureProps, unsupportedQueryProps, useQuery } from '../host/useQuery';
import { REFUSED_RESPONSE_HINT, unreadableDataMessage } from '../host/DataProvider';
import { Stack } from '../layout/Stack';
import { Toolbar } from '../layout/Toolbar';
import type { ToolbarAction, ToolbarStatus } from '../layout/Toolbar';
import { Badge } from '../primitives/Badge';
import type { BadgeTone } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { Input } from '../primitives/Input';
import { Kbd } from '../primitives/Kbd';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import { renderTriggerColorVar } from '../utils/color';
import {
  NOT_AVAILABLE_LABEL,
  formatCount,
  formatDurationCompact,
  formatRenderTriggerLabel,
  truncate,
} from '../utils/format';
import { SourceLink } from './SourceLink';

/* ---------------------------------------------------------------------------
 * Copy
 *
 * Every string a developer can read lives here, and every one of them is
 * generic: no component name, no route, no framework-specific noun and nothing
 * drawn from any particular project. The names on screen come from the data,
 * never from this file.
 * ------------------------------------------------------------------------- */

/** The node type this component draws, as the panel schema spells it. */
const COMPONENT_TREE_NODE_TYPE = 'componentTree';

/** The one data source this view reads, as the query vocabulary spells it. */
const COMPONENT_TREE_SOURCE: DataQuerySource = 'componentTree';

/**
 * This node type's entry in the single registry of node types.
 *
 * Imported rather than restated: the catalog owns the node's label, the data
 * sources it may read — which the query guard below checks against — and the
 * `reads` list naming the captured fields this view draws, which is the same
 * list the schema's semantic validation checks a capture can satisfy. A second
 * copy of any of the three in this file is how a renderer and its schema drift
 * apart.
 */
const CATALOG_ENTRY = PANEL_NODE_CATALOG[COMPONENT_TREE_NODE_TYPE];

/** The same, for the flat listing that a structureless snapshot becomes. */
const LIST_LABEL = 'Captured components';

/** Always shown: the snapshot is a moment with history attached, not a live tree. */
const PROVENANCE_NOTE =
  'Structure as it stood at the last commit of the capture; render counts are cumulative for the whole capture.';

/**
 * A counted unit with its singular and plural forms, chosen by the count it
 * follows ({@link nounForCount}).
 *
 * Private to this file on purpose: the handful of units below are the only
 * counted words this view prints, and each is stated once here with both
 * spellings rather than derived by suffixing, which English does not support in
 * general.
 */
interface CountedNoun {
  readonly one: string;
  readonly other: string;
}

/** Screen-reader unit for the render-count cell: "1 render", "3 renders". */
const RENDERS_UNIT_LABEL: CountedNoun = Object.freeze({ one: 'render', other: 'renders' });

/** Screen-reader unit for the cumulative-duration cell. */
const RENDER_TIME_UNIT_LABEL = 'total render time';

/** Screen-reader prefix for the trigger badge, which is ambiguous on its own. */
const TRIGGER_PREFIX_LABEL = 'Last render trigger:';

/** Screen-reader prefix for the instance-key badge. */
const INSTANCE_KEY_PREFIX_LABEL = 'Instance key:';

/**
 * The non-colour half of the highlight: words, beside an icon.
 *
 * "At or above" because the rule is `renderCount ≥ threshold` — the field's own
 * label says "≥" — and a mark that said "above" on a node exactly at the value
 * would contradict the control that set it.
 */
const AT_OR_ABOVE_THRESHOLD_LABEL = 'At or above threshold';

/**
 * Suffix of the badge a collapsed branch carries when marked nodes sit beneath
 * it; completed with how many, at every depth. Phrased with the count first so
 * it reads correctly for one node and for many.
 */
const HIDDEN_MARKED_SUFFIX = 'hidden at or above threshold';

/** Toolbar grouping name. */
const TOOLBAR_LABEL = 'Component tree controls';

/** Label of the threshold field. Visible: a hidden label would hide the control's meaning. */
const THRESHOLD_LABEL = 'Mark at renders ≥';

/**
 * The threshold field's rejection, first half: what the field accepts.
 * Completed with the default that applies meanwhile, so a rejected value never
 * reads as the one in force. Announced with the field and through its live
 * region; the toolbar shows the short form below.
 */
const THRESHOLD_REJECTED_PREFIX = 'Enter a whole number of at least';

/**
 * The visible short form of the rejection, a toolbar status pill completed
 * with the default in force. Short on purpose: a status pill is one line and
 * does not wrap, so it has to fit the narrowest panel beside the marked count.
 */
const THRESHOLD_DEFAULT_IN_FORCE_PREFIX = 'Using the default of';

/** Loading announcement for the skeleton state. */
const LOADING_LABEL = 'Loading the component tree…';

/** Empty state, worded for this node type rather than generically. */
const EMPTY_MESSAGE = 'No component tree was captured for this interaction.';

/** Empty state, second line: what to do about it. */
const EMPTY_TITLE = 'Nothing to show';

/*
 * Error copy is not written here. Every failure this view reports reaches
 * `ErrorState` through the one contract in `../host/useQuery` — the shared
 * title, a generic lead followed by the cause, the error's code, the query as
 * `formatDataQuery` prints it and, where asking again can change the answer, a
 * retry — so a failed component tree reads exactly like every other failed node
 * of a panel. The host's response check (`../host/DataProvider`) already
 * refuses a snapshot missing any member this view reads, so that refusal
 * arrives here as an ordinary failed query; the shape guard below stays as
 * defence in depth for a member present with the wrong type, and words its
 * refusal with the host's own sentence and hint.
 */

/** The shape the guard requires, for the closed "Technical details" disclosure. */
const SHAPE_FAILURE_EXPECTED =
  'a component-tree snapshot: an object with a string origin, a boolean degraded, a numeric nodeCount and an array of roots';

/**
 * The failure a payload this view cannot read is reported as.
 *
 * The provider resolved, so `useQuery` has no error of its own to report, yet
 * the answer is unusable — the same defect the host's response check refuses
 * with `PROTOCOL_INVALID_MESSAGE` when it catches a malformed answer itself.
 * It therefore carries that refusal's sentence and hint, and its diagnostics
 * name the source and the required shape (never anything read out of the
 * payload). Reported through `queryFailureProps`, it takes the same title,
 * lead, code chip and query block as every other failure, and keeps its
 * retry, because a provider can answer correctly when asked again. Never shown
 * for `null`: that is the service's own answer for a capture that holds no
 * render evidence, and it renders the empty state. Built once: it describes
 * the failure handed to the contract, and it is never thrown.
 */
const SHAPE_FAILURE = new DebuggenError(
  'PROTOCOL_INVALID_MESSAGE',
  unreadableDataMessage(COMPONENT_TREE_SOURCE),
  {
    hint: REFUSED_RESPONSE_HINT,
    details: { source: COMPONENT_TREE_SOURCE, field: 'data', expected: SHAPE_FAILURE_EXPECTED },
  },
);

/** Expand-toggle name prefix; completed with the row's own display name. */
const EXPAND_PREFIX_LABEL = 'Expand';

/** Collapse-toggle name prefix; completed with the row's own display name. */
const COLLAPSE_PREFIX_LABEL = 'Collapse';

/**
 * The keys of the row command that opens a row's source, in pressing order.
 *
 * One list feeds both spellings of the shortcut — the `Kbd` chord a sighted
 * reader sees in the note and the `aria-keyshortcuts` value a screen reader
 * announces on the row — so the two can never name different keys. The key
 * handler that honours it is {@link isOpenSourceChord}, which must change with
 * this list.
 */
const OPEN_SOURCE_KEYS: readonly string[] = Object.freeze(['Shift', 'Enter']);

/**
 * `aria-keyshortcuts` for {@link OPEN_SOURCE_KEYS}: modifiers joined with `+`,
 * as WAI-ARIA spells a chord.
 */
const OPEN_SOURCE_KEYSHORTCUTS = OPEN_SOURCE_KEYS.join('+');

/** The hint in the note, before the chord: generic, naming no row or file. */
const OPEN_SOURCE_HINT_PREFIX = 'Press';

/** The hint in the note, after the chord. */
const OPEN_SOURCE_HINT_SUFFIX = 'on a row to open its source.';

/** Toolbar action: open every branch of the structure. */
const EXPAND_ALL_LABEL = 'Expand all';

/** Toolbar action: close every branch of the structure. */
const COLLAPSE_ALL_LABEL = 'Collapse all';

/** Toolbar action: select the commit event the structure was taken from. */
const SHOW_COMMIT_LABEL = 'Show the commit';

/**
 * Toolbar status suffix: completed with how many nodes carry the mark. Count
 * first, so one wording serves one node and many.
 */
const MARKED_STATUS_SUFFIX = 'at or above threshold';

/** Unit in the statistics line: nodes the snapshot reports. */
const NODES_LABEL: CountedNoun = Object.freeze({ one: 'node', other: 'nodes' });

/** Unit in the statistics line: levels the snapshot reaches. */
const LEVELS_LABEL: CountedNoun = Object.freeze({ one: 'level', other: 'levels' });

/** Unit in the threshold explanation: components the median is taken over. */
const COMPONENTS_LABEL: CountedNoun = Object.freeze({ one: 'component', other: 'components' });

/**
 * Suffix in the statistics line: rows currently on screen. A participle, so it
 * has one form whatever the count.
 */
const SHOWN_LABEL = 'shown';

/**
 * Note prefix: completed with how many branches a guard declined to follow.
 *
 * Phrased with the count last so the sentence reads correctly for one branch and
 * for many, without this file carrying a pluralisation rule for one string.
 */
const UNFOLLOWED_NOTE_PREFIX = 'Branches not followed any further:';

/** Human wording for each construction route, in the badge above the tree. */
const ORIGIN_LABELS: Readonly<Record<ComponentTreeOrigin, string>> = Object.freeze({
  'commit-snapshot': 'Captured structure',
  'owner-chains': 'Reconstructed structure',
  flat: 'Flat listing',
});

/**
 * What each construction route can and cannot promise, stated as visible text
 * in the note beside the badge — never in a tooltip, which the badge, not being
 * a focus target, could not open from the keyboard.
 */
const ORIGIN_DETAILS: Readonly<Record<ComponentTreeOrigin, string>> = Object.freeze({
  'commit-snapshot':
    'The runtime serialized this structure itself, at the last commit of the capture.',
  'owner-chains':
    'Rebuilt from the components that rendered during the capture, so anything that did not render is missing from it.',
  flat: 'No hierarchy could be rebuilt, so every observed component is listed at a single level.',
});

/** A reconstruction is caveated, a serialized structure is not. */
const ORIGIN_TONES: Readonly<Record<ComponentTreeOrigin, BadgeTone>> = Object.freeze({
  'commit-snapshot': 'info',
  'owner-chains': 'warning',
  flat: 'warning',
});

/** Note shown when the snapshot reports itself incomplete. */
const DEGRADED_NOTE = 'This structure is known to be incomplete — read it as partial evidence.';

/** Note shown when the snapshot reports that nodes were dropped. */
const TRUNCATED_NOTE = 'Some nodes were dropped when a size bound was reached.';

/**
 * Note prefix for a payload whose readable nodes do not add up to the count the
 * snapshot reports.
 *
 * Stated rather than reconciled: the snapshot's `nodeCount` is one of the
 * bounds it declares, so a structure that does not match it is evidence about
 * the capture, and quietly showing whichever number happens to be on screen
 * would imply a completeness nobody established.
 */
const COUNT_MISMATCH_NOTE_PREFIX = 'Readable nodes differ from the reported count:';

/* ---------------------------------------------------------------------------
 * Bounds and derivations
 * ------------------------------------------------------------------------- */

/**
 * How deep this view will follow a structure, whatever the data says.
 *
 * The producer already bounds depth and node count, and `maxDepth` reports the
 * bound it reached — so this ceiling exists for the case the producer cannot
 * cover: a payload that is not a tree at all. Together with the ancestor check
 * in {@link prepareTree} it makes the traversal total on any input, including a
 * cyclic one, and every branch it declines to follow is counted and reported
 * rather than silently dropped.
 */
const ABSOLUTE_DEPTH_CEILING = 64;

/** Multiple of the median render count that the default threshold uses. */
const THRESHOLD_MEDIAN_MULTIPLE = 2;

/**
 * Floor for the derived threshold.
 *
 * A capture in which every component rendered once has a median of one; at a
 * threshold of one every row would be marked, which says nothing. Two is the
 * smallest count that can stand out from a single render.
 */
const MINIMUM_THRESHOLD = 2;

/**
 * The lowest threshold a developer may enter, and the field's native `min`.
 *
 * Lower than {@link MINIMUM_THRESHOLD} on purpose: that floor keeps the
 * *derived* default from marking a uniform capture, while a developer who asks
 * to see every component that rendered at all is entitled to one. Zero is not a
 * threshold — every count reaches it — so it is below the bound.
 */
const MINIMUM_ENTERED_THRESHOLD = 1;

/** The field's native `step`: a render count is a whole number. */
const THRESHOLD_STEP = 1;

/**
 * What an entered threshold must look like once trimmed: decimal digits and
 * nothing else. No sign, no fraction, no exponent — each of those is either
 * out of range or not a whole number of renders.
 */
const WHOLE_NUMBER_PATTERN = /^\d+$/;

/** Characters of a display name or instance key that reach the DOM. */
const MAX_NAME_LENGTH = 64;

/** Skeleton rows shown while the query is unresolved. */
const LOADING_ROW_COUNT = 6;

/** Key under which the threshold is reported to `PanelActions.onFilterChange`. */
const THRESHOLD_FILTER_KEY = 'renderThreshold';

/** Separator that makes a repeated node id unique within one rendering. */
const DUPLICATE_KEY_SEPARATOR = '#';

/** Prefix for the positional key a node with no id of its own falls back to. */
const POSITIONAL_KEY_PREFIX = 'position:';

/** The empty override map, hoisted so the initial state is referentially stable. */
const NO_OVERRIDES: ReadonlyMap<string, boolean> = new Map<string, boolean>();

/**
 * The one inline style this component writes: the unitless depth the stylesheet
 * multiplies by a spacing token. Typed as a CSS custom property so that no
 * other property can be smuggled in beside it.
 */
type DepthStyle = CSSProperties & Record<'--dgc-depth', string>;

/* ---------------------------------------------------------------------------
 * Layout model
 *
 * Three pure passes, each memoized on exactly what it reads:
 *
 *   1. `prepareTree`   — snapshot            → keyed nodes, once per snapshot.
 *   2. `expandedByDefault` — keyed nodes + threshold → the branches to open.
 *   3. `projectRows`   — keyed nodes + expansion     → the visible rows.
 *
 * Keys are assigned in pass 1 and reused by passes 2 and 3, which is why the
 * passes are separate: expansion state is addressed by key, so two independent
 * walks would have to agree on key assignment, and one day they would not.
 * ------------------------------------------------------------------------- */

/** One node of the snapshot after keying, with its structural coordinates. */
interface PreparedNode {
  /** Unique within this rendering; the datum's id, or a positional fallback. */
  readonly key: string;
  /** What is reported to the host for this item: the datum's own id when it has one. */
  readonly itemId: string;
  /** The datum itself, unmodified. */
  readonly datum: ComponentTreeNode;
  /** Distance from the top of what is rendered; a root is `0`. */
  readonly depth: number;
  /** The key of the node that owns this one, absent for a root. */
  readonly parentKey: string | undefined;
  /** 1-based position among its siblings, for `aria-posinset`. */
  readonly position: number;
  /** How many siblings it has in total, for `aria-setsize`. */
  readonly setSize: number;
  /** Ordinal in traversal order, which makes this node's element ids stable. */
  readonly ordinal: number;
  /** Children that were followed. Empty for a leaf, and for a branch declined by a guard. */
  readonly children: readonly PreparedNode[];
  /** Immediate children that a guard declined to follow, counted for the note. */
  readonly unfollowed: number;
}

/** The result of pass 1: the whole snapshot, keyed. */
interface PreparedTree {
  /** Top-level nodes, in the order the structure presented them. */
  readonly roots: readonly PreparedNode[];
  /** Every prepared node, in traversal order. */
  readonly all: readonly PreparedNode[];
  /** Keys of the nodes that own children, for the expand-all and collapse-all actions. */
  readonly parentKeys: readonly string[];
  /** Branches a guard declined to follow, across the whole walk. */
  readonly unfollowed: number;
}

/** One rendered row: a prepared node plus the state this rendering gives it. */
interface TreeRow {
  /** The prepared node this row draws. */
  readonly node: PreparedNode;
  /** Whether the row's children are currently shown. */
  readonly expanded: boolean;
  /** Whether the row's render count is at or above the threshold. */
  readonly highlighted: boolean;
}

/** One rendered row together with the rows nested beneath it. */
interface RowTree {
  readonly row: TreeRow;
  readonly children: readonly RowTree[];
}

/** The result of pass 3: what is on screen, and how to navigate it. */
interface RowProjection {
  /** The top level, for rendering. */
  readonly trees: readonly RowTree[];
  /** Every visible row in depth-first order, for keyboard navigation. */
  readonly rows: readonly TreeRow[];
  /** Row key to its index in {@link rows}. */
  readonly index: ReadonlyMap<string, number>;
}

/** The empty projection, hoisted so an unresolved query allocates nothing. */
const EMPTY_PROJECTION: RowProjection = Object.freeze({
  trees: Object.freeze([]),
  rows: Object.freeze([]),
  index: new Map<string, number>(),
});

/** The empty prepared tree, for the same reason. */
const EMPTY_PREPARED: PreparedTree = Object.freeze({
  roots: Object.freeze([]),
  all: Object.freeze([]),
  parentKeys: Object.freeze([]),
  unfollowed: 0,
});

/* ---------------------------------------------------------------------------
 * Guards
 *
 * Two of them, and both exist because this view is the end of a chain it does
 * not control: a panel specification decides the query, and a host decides how
 * it is resolved. A validated specification cannot reach either failure — the
 * node catalog constrains this node type to the `componentTree` source and the
 * data provider contract pairs a source with its result shape — so both render
 * an error that says the product is at fault, which is the honest reading, and
 * neither guesses at the payload it was handed.
 * ------------------------------------------------------------------------- */

/**
 * Whether the node's query reads the one source this view can draw.
 *
 * Two clauses, and both earn their place: the catalog decides which sources this
 * node type may read at all, and the literal comparison is what narrows the
 * query's type to the single source whose result shape this file knows how to
 * draw. A catalog that stopped allowing the source, and a specification that
 * named another one, both land in the product-bug error state.
 */
function isComponentTreeQuery(query: DataQuery): query is DataQuery & { source: 'componentTree' } {
  return (
    isSourceAllowedForNode(COMPONENT_TREE_NODE_TYPE, query.source) &&
    query.source === 'componentTree'
  );
}

/**
 * Whether a resolved payload is shaped like a component-tree snapshot.
 *
 * Structural, and deliberately shallow: it checks the four fields this view
 * dereferences before it can render anything at all. Per-node fields are read
 * defensively at the point of use instead, so one malformed node inside an
 * otherwise usable structure costs that node's detail rather than the whole
 * view.
 */
function isComponentTreeSnapshot(value: unknown): value is ComponentTreeSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Readonly<Record<string, unknown>>;

  return (
    typeof record.origin === 'string' &&
    typeof record.degraded === 'boolean' &&
    typeof record.nodeCount === 'number' &&
    Array.isArray(record.roots)
  );
}

/* ---------------------------------------------------------------------------
 * Presentation helpers
 *
 * Each one bounds a value that arrives from a page this product does not
 * control, and each one has an answer for the absent case — `n/a` from the one
 * module that owns that spelling, never an empty cell and never the strings
 * "undefined" or "null": no part of a view is ever a blank area, and an absent
 * value is stated as absent rather than left for the reader to mistake for
 * data.
 * ------------------------------------------------------------------------- */

/** The tree's own reading of a node's display name, length-bounded. */
function displayNameOf(datum: ComponentTreeNode): string {
  const component = typeof datum.component === 'string' ? datum.component.trim() : '';

  return component === '' ? NOT_AVAILABLE_LABEL : truncate(component, MAX_NAME_LENGTH);
}

/** The instance key the structure carried, length-bounded, or absent. */
function instanceKeyOf(datum: ComponentTreeNode): string | undefined {
  const key = typeof datum.key === 'string' ? datum.key.trim() : '';

  return key === '' ? undefined : truncate(key, MAX_NAME_LENGTH);
}

/** The node's cumulative render count, grouped, or `n/a`. */
function countTextOf(datum: ComponentTreeNode): string {
  const count = datum.renderCount;

  return typeof count === 'number' ? formatCount(count) : NOT_AVAILABLE_LABEL;
}

/**
 * `noun` in the form that agrees with `count`: singular for exactly one, plural
 * for everything else — zero, many, and a count that could not be read, which
 * prints as `n/a` and reads as "n/a renders".
 */
function nounForCount(noun: CountedNoun, count: number): string {
  return count === 1 ? noun.one : noun.other;
}

/** The unit announced after a node's render count, agreeing with it. */
function renderUnitOf(datum: ComponentTreeNode): string {
  const count = datum.renderCount;

  return nounForCount(RENDERS_UNIT_LABEL, typeof count === 'number' ? count : Number.NaN);
}

/**
 * One identifier from a payload, trimmed, or `undefined` when it is absent or
 * blank. Read over `unknown` because the payload crossed a transport.
 */
function presentIdOf(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';

  return text === '' ? undefined : text;
}

/**
 * An event reference carrying only the coordinates that are present — never a
 * key whose value is `undefined`, and never a reference without an event id.
 *
 * The single builder for both references this view reports, the commit's and a
 * node's, so the two cannot follow different rules about absent coordinates.
 */
function eventRefOf(
  eventId: unknown,
  spanId: unknown,
  traceId: unknown,
): PanelEventRef | undefined {
  const id = presentIdOf(eventId);

  if (id === undefined) {
    return undefined;
  }

  const span = presentIdOf(spanId);
  const trace = presentIdOf(traceId);

  return {
    eventId: id,
    ...(span === undefined ? {} : { spanId: span }),
    ...(trace === undefined ? {} : { traceId: trace }),
  };
}

/**
 * A node's representative event: the render that supplied its last trigger, as
 * the producer named it, or `undefined` for a node that never rendered.
 *
 * Nothing is derived here. The reference is the datum's own, so a node with no
 * `lastRenderEventId` yields none rather than borrowing a neighbour's, the
 * commit's, or an id built from the node's position.
 */
function representativeEventRefOf(datum: ComponentTreeNode): PanelEventRef | undefined {
  return eventRefOf(datum.lastRenderEventId, datum.lastRenderSpanId, datum.lastRenderTraceId);
}

/** The node's cumulative render time, or `n/a` when it was not measured. */
function durationTextOf(datum: ComponentTreeNode): string {
  const duration = datum.totalDurationMs;

  return typeof duration === 'number' && Number.isFinite(duration)
    ? formatDurationCompact(duration)
    : NOT_AVAILABLE_LABEL;
}

/** Label, explanation and tone for a construction route. */
interface OriginDescription {
  readonly label: string;
  readonly detail: string;
  readonly tone: BadgeTone;
}

/**
 * Describes a snapshot's construction route.
 *
 * The three tables are total over the closed origin union, so the fallbacks
 * below are unreachable through a validated snapshot. They resolve to the
 * *caveated* wording rather than the confident wording anyway: an origin this
 * build does not recognise is exactly the case where claiming a complete
 * structure would be wrong.
 */
function describeOrigin(origin: ComponentTreeOrigin): OriginDescription {
  const label: string | undefined = ORIGIN_LABELS[origin];
  const detail: string | undefined = ORIGIN_DETAILS[origin];
  const tone: BadgeTone | undefined = ORIGIN_TONES[origin];

  return {
    label: label ?? ORIGIN_LABELS['owner-chains'],
    detail: detail ?? ORIGIN_DETAILS['owner-chains'],
    tone: tone ?? ORIGIN_TONES['owner-chains'],
  };
}

/* ---------------------------------------------------------------------------
 * Row input
 *
 * A row is one focus target that may hold two real buttons, the disclosure
 * toggle and the source chip. Both are out of the Tab order, but a pointer can
 * still press — and so focus — either one, and every key and click on them
 * bubbles to the row. The two helpers below are how the row tells its own
 * gestures apart from gestures its controls already own.
 * ------------------------------------------------------------------------- */

/**
 * The button inside a row that an event came from, or `undefined` when it came
 * from the row itself.
 *
 * Bounded by the row on purpose: `closest` walks past the row to the whole
 * document, and a host that happened to place the view inside some other
 * button must not make every row gesture look like a control's.
 */
function nestedControlOf(
  event: Pick<
    ReactMouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>,
    'target' | 'currentTarget'
  >,
): Element | undefined {
  const target = event.target;
  const row = event.currentTarget;

  if (!(target instanceof Element) || target === row) {
    return undefined;
  }

  const control = target.closest('button');

  return control !== null && row.contains(control) ? control : undefined;
}

/**
 * Whether a key press is the open-source row command, {@link OPEN_SOURCE_KEYS}.
 *
 * Shift and nothing else: Ctrl, Alt and Meta chords with Enter belong to the
 * host surface (an editor, a browser), which this widget never takes a key
 * from.
 */
function isOpenSourceChord(
  event: Pick<ReactKeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>,
): boolean {
  return (
    event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
  );
}

/* ---------------------------------------------------------------------------
 * The three passes
 * ------------------------------------------------------------------------- */

/**
 * Whether a value is an array of nodes.
 *
 * Written as a predicate over `unknown` rather than as an inline
 * `Array.isArray` on the typed field: that built-in narrows to `any[]`, and an
 * `any` reaching the traversal would silence every type error inside it.
 */
function isNodeArray(value: unknown): value is readonly ComponentTreeNode[] {
  return Array.isArray(value);
}

/** A node's children, tolerating a payload whose node is not fully formed. */
function childrenOf(datum: ComponentTreeNode): readonly ComponentTreeNode[] {
  const children: unknown = datum.children;

  return isNodeArray(children) ? children : [];
}

/** Whether a node's count reaches the mark. A threshold of zero marks nothing. */
function isAboveThreshold(datum: ComponentTreeNode, threshold: number): boolean {
  const count = datum.renderCount;

  return threshold > 0 && typeof count === 'number' && Number.isFinite(count) && count >= threshold;
}

/**
 * Pass 1 — key every node of the snapshot and record its coordinates.
 *
 * Total on any input. Two guards make it so, and both *report* rather than hide
 * what they decline: a node whose own id appears among its ancestors is not
 * descended into (a structure that points back at itself), and neither is a
 * node at {@link ABSOLUTE_DEPTH_CEILING}. Each declined branch adds its
 * immediate children to {@link PreparedTree.unfollowed}, which the note above
 * the tree states.
 *
 * `hierarchical` is `false` for a snapshot whose origin is `flat`. Then every
 * node — including anything nested inside the payload — is collected into a
 * single level, because that is what a structureless listing is; dressing it as
 * a tree would claim a hierarchy nobody observed.
 */
function prepareTree(
  snapshot: ComponentTreeSnapshot | undefined,
  hierarchical: boolean,
): PreparedTree {
  if (snapshot === undefined) {
    return EMPTY_PREPARED;
  }

  const declaredRoots: unknown = snapshot.roots;
  const roots: readonly ComponentTreeNode[] = isNodeArray(declaredRoots) ? declaredRoots : [];
  const all: PreparedNode[] = [];
  const parentKeys: string[] = [];
  const usedKeys = new Set<string>();
  let ordinal = 0;
  let unfollowed = 0;

  const declaredIdOf = (datum: ComponentTreeNode): string =>
    typeof datum.id === 'string' ? datum.id.trim() : '';

  const assignKey = (datum: ComponentTreeNode, path: string, nodeOrdinal: number): string => {
    const declared = declaredIdOf(datum);
    const base = declared === '' ? `${POSITIONAL_KEY_PREFIX}${path}` : declared;

    if (!usedKeys.has(base)) {
      usedKeys.add(base);
      return base;
    }

    // Ids are unique inside a well-formed snapshot, so this only runs on a
    // payload that repeated one. The ordinal makes the result unique without
    // dropping the node, which keeps the count on screen honest.
    const unique = `${base}${DUPLICATE_KEY_SEPARATOR}${String(nodeOrdinal)}`;
    usedKeys.add(unique);

    return unique;
  };

  const canDescend = (datum: ComponentTreeNode, depth: number, ancestors: readonly string[]) => {
    const declared = declaredIdOf(datum);

    return (
      depth + 1 <= ABSOLUTE_DEPTH_CEILING && (declared === '' || !ancestors.includes(declared))
    );
  };

  const visit = (
    data: readonly ComponentTreeNode[],
    depth: number,
    parentKey: string | undefined,
    ancestors: readonly string[],
    path: string,
  ): PreparedNode[] => {
    const setSize = data.length;

    return data.map((datum, offset) => {
      const nodeOrdinal = ordinal;
      ordinal += 1;

      const nodePath = `${path}${String(offset)}.`;
      const key = assignKey(datum, nodePath, nodeOrdinal);
      const children = childrenOf(datum);
      const followable = children.length > 0 && canDescend(datum, depth, ancestors);
      const declined = children.length > 0 && !followable ? children.length : 0;
      unfollowed += declined;

      const declared = declaredIdOf(datum);
      const childNodes = followable
        ? visit(
            children,
            depth + 1,
            key,
            declared === '' ? ancestors : [...ancestors, declared],
            nodePath,
          )
        : [];

      const node: PreparedNode = {
        key,
        itemId: declared === '' ? key : declared,
        datum,
        depth,
        parentKey,
        position: offset + 1,
        setSize,
        ordinal: nodeOrdinal,
        children: childNodes,
        unfollowed: declined,
      };

      all.push(node);

      if (childNodes.length > 0) {
        parentKeys.push(key);
      }

      return node;
    });
  };

  if (!hierarchical) {
    const collected: ComponentTreeNode[] = [];

    const collect = (
      data: readonly ComponentTreeNode[],
      depth: number,
      ancestors: readonly string[],
    ): void => {
      for (const datum of data) {
        collected.push(datum);

        const children = childrenOf(datum);

        if (children.length === 0) {
          continue;
        }

        if (!canDescend(datum, depth, ancestors)) {
          unfollowed += children.length;
          continue;
        }

        const declared = declaredIdOf(datum);
        collect(children, depth + 1, declared === '' ? ancestors : [...ancestors, declared]);
      }
    };

    collect(roots, 0, []);

    const listed = collected.map((datum, offset) => {
      const nodeOrdinal = ordinal;
      ordinal += 1;

      const key = assignKey(datum, `${String(offset)}.`, nodeOrdinal);
      const declared = declaredIdOf(datum);

      const node: PreparedNode = {
        key,
        itemId: declared === '' ? key : declared,
        datum,
        depth: 0,
        parentKey: undefined,
        position: offset + 1,
        setSize: collected.length,
        ordinal: nodeOrdinal,
        children: [],
        unfollowed: 0,
      };

      all.push(node);

      return node;
    });

    return { roots: listed, all, parentKeys: [], unfollowed };
  }

  const prepared = visit(roots, 0, undefined, [], '');

  return { roots: prepared, all, parentKeys, unfollowed };
}

/**
 * Pass 2 — which branches open without the developer asking.
 *
 * Two rules, and the second is the reason this view is usable on a large
 * structure: the roots open so the first level is visible, and every ancestor
 * of a marked node opens so the finding is on screen. Nothing else does, so a
 * structure of thousands of nodes puts a bounded number of rows in the DOM on
 * first paint. This source answers with one object and no paging, so expansion
 * is the only bound available.
 *
 * The result is a *default*, not the state: a developer's own toggles are held
 * separately and win, so re-deriving this set after a threshold change never
 * reverses a collapse they asked for.
 */
function expandedByDefault(prepared: PreparedTree, threshold: number): ReadonlySet<string> {
  const expanded = new Set<string>();

  const reveal = (node: PreparedNode): boolean => {
    let marked = false;

    for (const child of node.children) {
      // Both operands run: `reveal` records the deeper ancestors it opens, so
      // short-circuiting here would leave a marked node buried.
      const childMarked = isAboveThreshold(child.datum, threshold);
      const descendantMarked = reveal(child);

      if (childMarked || descendantMarked) {
        marked = true;
      }
    }

    if (marked) {
      expanded.add(node.key);
    }

    return marked;
  };

  for (const root of prepared.roots) {
    if (root.children.length > 0) {
      expanded.add(root.key);
    }

    reveal(root);
  }

  return expanded;
}

/**
 * How many marked nodes sit beneath each branch, at every depth.
 *
 * What a collapsed row states so that closing it never hides a finding: every
 * descendant of a closed branch is off screen, so this count *is* the number
 * of hidden marks behind it. Per position, like the toolbar's total, because
 * each position is a row the developer would otherwise have to open to find.
 *
 * Only branches with at least one marked descendant are recorded, so a lookup
 * that misses means zero. One post-order walk over the prepared tree — whose
 * depth {@link prepareTree} already bounds — memoized on the tree and the
 * threshold, like pass 2.
 */
function markedDescendantCounts(
  prepared: PreparedTree,
  threshold: number,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  const visit = (node: PreparedNode): number => {
    let marked = 0;

    for (const child of node.children) {
      marked += visit(child) + (isAboveThreshold(child.datum, threshold) ? 1 : 0);
    }

    if (marked > 0) {
      counts.set(node.key, marked);
    }

    return marked;
  };

  for (const root of prepared.roots) {
    visit(root);
  }

  return counts;
}

/**
 * Pass 3 — the rows that are on screen, in the order the keyboard walks them.
 *
 * Returns both shapes the render needs: the nested form, which mirrors the
 * `role="group"` structure, and the flat depth-first form with an index, which
 * is what "the next visible row" means for ArrowDown.
 */
function projectRows(
  prepared: PreparedTree,
  isExpanded: (key: string) => boolean,
  threshold: number,
): RowProjection {
  if (prepared.roots.length === 0) {
    return EMPTY_PROJECTION;
  }

  const rows: TreeRow[] = [];
  const index = new Map<string, number>();

  const build = (nodes: readonly PreparedNode[]): RowTree[] =>
    nodes.map((node) => {
      const expanded = node.children.length > 0 && isExpanded(node.key);
      const row: TreeRow = {
        node,
        expanded,
        highlighted: isAboveThreshold(node.datum, threshold),
      };

      index.set(node.key, rows.length);
      rows.push(row);

      return { row, children: expanded ? build(node.children) : [] };
    });

  const trees = build(prepared.roots);

  return { trees, rows, index };
}

/* ---------------------------------------------------------------------------
 * The threshold
 *
 * Highlighting the components above a render threshold needs a number, and a
 * constant would be a claim this product cannot support: what counts as too
 * many renders depends on the interaction that was captured. So the default is
 * derived from the capture itself and the derivation is explained on screen,
 * where a developer can disagree with it and type their own.
 * ------------------------------------------------------------------------- */

/** The median of a set of counts; `0` for an empty set. */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;

  if (sorted.length % 2 === 1) {
    return upper;
  }

  return ((sorted[middle - 1] ?? upper) + upper) / 2;
}

/**
 * The highest render count per component name.
 *
 * Per **component**, because the datum's counts are per component and a
 * component at several positions repeats the same count at each: counting
 * positions would let one widely-reused component decide the median for the
 * whole capture.
 */
function componentCounts(prepared: PreparedTree): readonly number[] {
  const byComponent = new Map<string, number>();

  for (const node of prepared.all) {
    const count = node.datum.renderCount;

    if (typeof count !== 'number' || !Number.isFinite(count)) {
      continue;
    }

    const name = typeof node.datum.component === 'string' ? node.datum.component : '';
    const previous = byComponent.get(name);

    if (previous === undefined || count > previous) {
      byComponent.set(name, count);
    }
  }

  return [...byComponent.values()];
}

/**
 * The default mark: a multiple of the median, never below
 * {@link MINIMUM_THRESHOLD} and always at least one render above the median.
 *
 * The second clause is what keeps a uniform capture quiet. Where every
 * component rendered the same number of times nothing stands out, and a
 * threshold equal to the median would mark every row — which is the same as
 * marking none, told less honestly.
 */
function deriveThreshold(counts: readonly number[]): number {
  const median = medianOf(counts);

  return Math.max(
    Math.ceil(median * THRESHOLD_MEDIAN_MULTIPLE),
    Math.ceil(median) + 1,
    MINIMUM_THRESHOLD,
  );
}

/**
 * The threshold a developer's text names, or `undefined` when it names none.
 *
 * The one rule every reading of the field goes through: once trimmed, the text
 * must be decimal digits ({@link WHOLE_NUMBER_PATTERN}) naming a safe integer
 * of at least {@link MINIMUM_ENTERED_THRESHOLD}. Anything else — an empty
 * field, zero, a fraction, a sign, an exponent, a number past the safe-integer
 * range, or text a number field could not hold — names no threshold. Leading
 * zeros and surrounding space are spelling, not meaning: " 03" names three.
 *
 * There is no upper clamp. A value above the field's `max` is a whole number
 * of renders no component reached, so it is honoured and marks nothing — which
 * is what it says — rather than being rewritten into a value nobody typed.
 */
function enteredThresholdOf(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }

  const trimmed = text.trim();

  if (!WHOLE_NUMBER_PATTERN.test(trimmed)) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);

  return Number.isSafeInteger(parsed) && parsed >= MINIMUM_ENTERED_THRESHOLD ? parsed : undefined;
}

/**
 * The threshold in force: what the developer entered, or the derived default.
 *
 * Text that names no threshold ({@link enteredThresholdOf}) falls back to the
 * default rather than to zero or to the bound, so clearing the control — or
 * typing something it cannot read — restores the derived mark instead of
 * silently turning the highlight off or marking every row.
 */
function resolveThreshold(text: string | undefined, derived: number): number {
  return enteredThresholdOf(text) ?? derived;
}

/**
 * What the threshold field reports to `PanelActions.onFilterChange`: the
 * entered threshold in force, spelled canonically as a decimal integer (" 03"
 * reports `"3"`), or `""` when no entered threshold is in force — the field was
 * cleared, or holds text that names none — which means "the derived default".
 *
 * Never the raw text: a host that remembers the value and hands it back must
 * get exactly the threshold that was applied, not a spelling of it.
 */
function thresholdFilterValueOf(text: string): string {
  const entered = enteredThresholdOf(text);

  return entered === undefined ? '' : String(entered);
}

/**
 * The field's native `max`: the highest render count any component reached,
 * or the derived default when that is higher.
 *
 * Past the highest count nothing more can be marked, so that is where the spin
 * buttons stop; the derived default is included so the value the field starts
 * at is always inside its own bounds.
 */
function thresholdMaximumOf(counts: readonly number[], derived: number): number {
  const highest = counts.reduce((current, count) => Math.max(current, Math.ceil(count)), 0);

  return Math.max(highest, derived, MINIMUM_ENTERED_THRESHOLD);
}

/**
 * The event reference of the whole snapshot: the commit the structure was
 * taken from, when the capture recorded it.
 *
 * A property of the view rather than of any node, so it is offered once, from
 * the toolbar. A node's own reference is {@link representativeEventRefOf}; both
 * are built by {@link eventRefOf}, carrying only the coordinates present.
 */
function commitEventRefOf(snapshot: ComponentTreeSnapshot | undefined): PanelEventRef | undefined {
  if (snapshot === undefined) {
    return undefined;
  }

  return eventRefOf(snapshot.commitEventId, snapshot.commitSpanId, snapshot.traceId);
}

/**
 * The node a reader activated, the panel's selection as it stood at that
 * moment, and the selection the activation asked the panel for.
 *
 * A node is an aggregate, so its mark is this view's presentation rather than
 * the panel's shared selection — but it must never contradict that selection.
 * Two kinds of activation make the rule concrete:
 *
 *   - **A node that names a representative render** reports it with
 *     `onSelectEvent`, and the panel host records the report as the panel's
 *     new selection. The selection after the click is therefore that render,
 *     not the one the node was activated under, and the mark has to survive
 *     exactly that change. `expected` holds the reported reference, normalised
 *     as the host records one ({@link selectionOfReference}), and the record
 *     is **pending** until the panel's selection names that event. While it is
 *     pending the node stays marked only as long as the selection still names
 *     the event it was activated under: the window in which a host that drives
 *     the selection itself — the DevTools panel passes its drawer's
 *     `selectedEventId`, which its store updates a tick later — still shows the
 *     previous event. The panel host re-derives that previous id without the
 *     coordinates it was reported with, which is why the window compares the
 *     event rather than every coordinate ({@link sameSelectedEvent}). Once the
 *     selection names the expected event the record is **adopted**: `under`
 *     becomes that observed selection and `expected` is cleared. Any other
 *     selection first drops the record, so a later return to the pre-click
 *     selection cannot bring the mark back.
 *   - **A node that names none** reports nothing and the panel's selection does
 *     not move, so its record is settled from the start, `expected` unset.
 *
 * A settled record — adopted, or made by a node that names no render — keeps
 * its mark exactly while the panel's selection is still `under`, compared
 * coordinate by coordinate ({@link sameSelection}): the moment any view, or
 * this view's own commit control, selects another event, the tree stops
 * claiming a selection of its own. See {@link settleNodeSelection} and
 * {@link isNodeSelectionShown}.
 */
interface NodeSelection {
  /** The activated node's key. */
  readonly key: string;

  /**
   * The panel's selection the mark lives beside: the one in force when the
   * node was activated, replaced by the observed expected selection when a
   * pending record is adopted. `undefined` for "nothing selected".
   */
  readonly under: PanelSelection | undefined;

  /**
   * The selection the activation reported — the node's representative render
   * — while the panel has not yet shown it; `undefined` once adopted, and for
   * a node that names no render.
   */
  readonly expected: PanelSelection | undefined;
}

/**
 * The selection a reported reference becomes once a host records it.
 *
 * The id plus only the coordinates present, never a key written with an
 * `undefined` value — the shape the panel host records for every report and
 * `useViewSelection` keeps outside a host — so the pending record compares
 * like with like against the selection the panel then holds.
 *
 * @param reference The reference the activation reported.
 * @returns A fresh selection value.
 */
function selectionOfReference(reference: PanelEventRef): PanelSelection {
  const { eventId, traceId, spanId } = reference;

  return {
    eventId,
    ...(traceId === undefined ? {} : { traceId }),
    ...(spanId === undefined ? {} : { spanId }),
  };
}

/**
 * Whether two readings of the panel's selection name the same event with the
 * same coordinates.
 *
 * Compared field by field rather than by identity, so a host that re-delivers
 * an equal selection as a new object does not clear a node's mark.
 *
 * @param a One reading, `undefined` for "nothing selected".
 * @param b The other.
 * @returns `true` when both are absent, or both name the same event alike.
 */
function sameSelection(a: PanelSelection | undefined, b: PanelSelection | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }

  return a.eventId === b.eventId && a.traceId === b.traceId && a.spanId === b.spanId;
}

/**
 * Whether two readings of the panel's selection name the same event, whatever
 * coordinates each carries.
 *
 * The event id is a captured event's identity, and it is all a driven host
 * re-derives for a selection it has not caught up with, so a pending record
 * (see {@link NodeSelection}) is judged by it: the previous event shown
 * without the coordinates it was reported with is still the previous event.
 *
 * @param a One reading, `undefined` for "nothing selected".
 * @param b The other.
 * @returns `true` when both are absent, or both name the same event id.
 */
function sameSelectedEvent(a: PanelSelection | undefined, b: PanelSelection | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }

  return a.eventId === b.eventId;
}

/**
 * The node record as the panel's current selection leaves it.
 *
 * A pending record whose expected event the panel now shows is adopted, with
 * the observed selection as the one its mark lives beside; one the panel moved
 * past before showing its expected event is dropped; everything else is
 * returned as the very same object, so the caller tells a transition by
 * identity and writes state only when there is one.
 *
 * @param record The record held in state, `undefined` when no node was activated.
 * @param selection The panel's current selection.
 * @returns The settled record, or `undefined` when none survives.
 */
function settleNodeSelection(
  record: NodeSelection | undefined,
  selection: PanelSelection | undefined,
): NodeSelection | undefined {
  if (record === undefined || record.expected === undefined) {
    return record;
  }

  if (sameSelectedEvent(record.expected, selection)) {
    return { key: record.key, under: selection, expected: undefined };
  }

  return sameSelectedEvent(record.under, selection) ? record : undefined;
}

/**
 * Whether a record's node is drawn as the selected row under `selection`.
 *
 * A pending record is shown while the panel still names the event it was
 * activated under; a settled one while the panel's selection is still, in
 * every coordinate, the one it lives beside.
 *
 * @param record A record already passed through {@link settleNodeSelection}.
 * @param selection The panel's current selection.
 * @returns `true` when the node is marked.
 */
function isNodeSelectionShown(
  record: NodeSelection,
  selection: PanelSelection | undefined,
): boolean {
  return record.expected === undefined
    ? sameSelection(record.under, selection)
    : sameSelectedEvent(record.under, selection);
}

/* ---------------------------------------------------------------------------
 * The component
 * ------------------------------------------------------------------------- */

/** What this component needs, and nothing else. */
export interface ComponentTreeProps {
  /**
   * The validated panel node that selected this component.
   *
   * Its `query` is the only route to data — resolved by whatever
   * `DataProvider` the host mounted — and its `id` is what this view reports
   * alongside every interaction, so a host with several component-tree nodes in
   * one panel can tell them apart.
   */
  node: ComponentTreeNodeSpec;

  /** Appended last to the block's class list, so a host can place the view. */
  className?: string | undefined;
}

/**
 * The component hierarchy of the last commit of a capture, each node annotated
 * with how often that component rendered.
 *
 * See the module documentation for why the child groups are siblings tied with
 * `aria-owns`, why selecting a node reports its representative render and
 * never an invented one, why selection never toggles a branch, and why the
 * origin and the degradation of the snapshot are stated on screen.
 */
export function ComponentTree(props: ComponentTreeProps): ReactElement {
  const { node, className } = props;
  const actions = usePanelActions();
  // The panel's selected event: the host's shared selection, or this view's own
  // last one when no host is mounted. The commit control is marked by it
  // directly; a node's mark follows the selection its activation left the
  // panel with, and gives way to any other (see `NodeSelection`).
  const { selection, markSelected } = useViewSelection();
  const baseId = useId();

  // The query is narrowed before it is handed to the hook: a node whose source
  // this view cannot draw resolves nothing at all, and renders the product-bug
  // error below rather than a request that could never be read.
  const query = node.query;
  const supported = isComponentTreeQuery(query);
  const result = useQuery<'componentTree'>(supported ? query : undefined);

  // `null` is how the service answers for a capture that holds no render
  // evidence to build a tree from — the wire's spelling of "no tree", because an
  // absent value does not survive a JSON round trip. That is an empty capture,
  // drawn as this view's empty state; only a NON-null payload that fails the
  // shape check below is a provider fault.
  const emptyCapture = result.status === 'success' && result.data === null;
  const payload: unknown = result.status === 'success' ? result.data : undefined;
  const snapshot = isComponentTreeSnapshot(payload) ? payload : undefined;

  // A structureless snapshot is rendered as the listing it is, not as a tree.
  const hierarchical = snapshot !== undefined && snapshot.origin !== 'flat';

  const prepared = useMemo(() => prepareTree(snapshot, hierarchical), [snapshot, hierarchical]);
  const counts = useMemo(() => componentCounts(prepared), [prepared]);
  const derivedThreshold = useMemo(() => deriveThreshold(counts), [counts]);
  const thresholdMaximum = useMemo(
    () => thresholdMaximumOf(counts, derivedThreshold),
    [counts, derivedThreshold],
  );
  const itemIds = useMemo(
    () => new Map(prepared.all.map((entry) => [entry.key, entry.itemId] as const)),
    [prepared],
  );

  // `undefined` means "the developer has not chosen", which is what lets the
  // derived default follow the data until they do.
  const [thresholdText, setThresholdText] = useState<string | undefined>(undefined);
  const threshold = resolveThreshold(thresholdText, derivedThreshold);

  // Expansion is the default set plus the developer's own toggles, held apart so
  // re-deriving the former never undoes the latter.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(NO_OVERRIDES);
  const defaultExpanded = useMemo(
    () => expandedByDefault(prepared, threshold),
    [prepared, threshold],
  );
  const isExpanded = useCallback(
    (key: string): boolean => overrides.get(key) ?? defaultExpanded.has(key),
    [overrides, defaultExpanded],
  );
  const projection = useMemo(
    () => projectRows(prepared, isExpanded, threshold),
    [prepared, isExpanded, threshold],
  );
  const markedTotal = useMemo(
    () => prepared.all.filter((entry) => isAboveThreshold(entry.datum, threshold)).length,
    [prepared, threshold],
  );
  const markedBeneath = useMemo(
    () => markedDescendantCounts(prepared, threshold),
    [prepared, threshold],
  );

  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const [selectedNode, setSelectedNode] = useState<NodeSelection | undefined>(undefined);
  const rowElements = useRef<Map<string, HTMLDivElement>>(new Map());

  // The node drawn as selected: the one last activated, for exactly as long as
  // the panel's selection is the one that activation left it with — the node's
  // reported render once the host shows it, the previous event until then, or
  // the selection it was activated beside for a node that names no render. A
  // selection made anywhere else supersedes it, so the tree never marks a node
  // while the panel's selection — the event its details drawer shows — is
  // another one.
  //
  // Adjusting state during render, the documented pattern for local state that
  // describes an input that changed: the settled record is used by THIS render
  // as well as written back, and the write happens only on a transition, which
  // `settleNodeSelection` signals by returning a different object. An effect
  // would paint one frame with the stale record first.
  const settledNode = settleNodeSelection(selectedNode, selection);

  if (settledNode !== selectedNode) {
    setSelectedNode(settledNode);
  }

  const selectedKey =
    settledNode !== undefined && isNodeSelectionShown(settledNode, selection)
      ? settledNode.key
      : undefined;

  const rows = projection.rows;

  // The single tab stop. Resolved every render against the rows that exist, so
  // collapsing the branch that held it moves it to the first row rather than
  // leaving the widget unreachable by Tab.
  const activeRow =
    (activeKey === undefined ? undefined : rows.find((entry) => entry.node.key === activeKey)) ??
    rows[0];
  const activeRowKey = activeRow?.node.key;

  const openSource = actions?.onOpenSource;
  const commitRef = commitEventRefOf(snapshot);

  // Whether any node — shown or still collapsed — resolved to source. Decides
  // the one-line keyboard hint in the note, which is about the whole structure
  // rather than about the rows that happen to be open.
  const anySource = useMemo(
    () => prepared.all.some((entry) => entry.datum.source !== undefined),
    [prepared],
  );
  const sourceCommandOffered = openSource !== undefined && anySource;

  const focusRow = (key: string): void => {
    setActiveKey(key);
    rowElements.current.get(key)?.focus();
  };

  const applyExpansion = (row: TreeRow, expanded: boolean): void => {
    setOverrides((previous) => {
      const next = new Map(previous);
      next.set(row.node.key, expanded);

      return next;
    });

    actions?.onExpand?.(node.id, row.node.itemId, expanded);
  };

  const applyExpansionToAll = (expanded: boolean): void => {
    const changed = prepared.parentKeys.filter((key) => isExpanded(key) !== expanded);

    setOverrides(new Map(prepared.parentKeys.map((key) => [key, expanded] as const)));

    const report = actions?.onExpand;

    if (report === undefined) {
      return;
    }

    // Reported per item, like a single toggle: the host's record of disclosure
    // is per node, so a bulk action that reported once would leave it wrong.
    for (const key of changed) {
      report(node.id, itemIds.get(key) ?? key, expanded);
    }
  };

  /**
   * Row selection — a click on the row, or Enter/Space on it — and nothing else.
   *
   * The row becomes the active and the selected one. When its node names a
   * representative render, that reference goes to the host exactly as the datum
   * holds it, with only the coordinates present, and the record expects the
   * panel's selection to become it — so the row stays marked when the host
   * records the report (see `NodeSelection`). Like every other event-bearing
   * view, the reference is also recorded through `markSelected`: a no-op under
   * a host, and this view's own selection outside one, so a standalone tree
   * moves its commit control's pressed state exactly as a hosted one does. A
   * node that never rendered has no reference, so the selection stays inside
   * this view and nothing is reported. It never toggles a branch — disclosure
   * is the toggle's and the arrow keys' — and never opens a file, which is the
   * chip's and Shift+Enter's.
   */
  const selectRow = (row: TreeRow): void => {
    const reference = representativeEventRefOf(row.node.datum);

    setActiveKey(row.node.key);
    setSelectedNode({
      key: row.node.key,
      under: selection,
      expected: reference === undefined ? undefined : selectionOfReference(reference),
    });

    if (reference !== undefined) {
      markSelected(reference);
      actions?.onSelectEvent(reference);
    }
  };

  /**
   * The Shift+Enter row command: open the row's source and do nothing else.
   *
   * The keyboard route to the chip's intent, which is what lets the chip leave
   * the Tab order. It works on a branch as well as a leaf — Enter selects a row
   * rather than opening anything, so without this no row's source would be
   * reachable from the keyboard — and it neither toggles, selects nor reports a
   * disclosure. The location is handed over as the very object the datum holds,
   * exactly as the chip does.
   *
   * @returns Whether the row could open anything; only then is the key consumed.
   */
  const openRowSource = (row: TreeRow): boolean => {
    const location = row.node.datum.source;

    if (location === undefined || openSource === undefined) {
      return false;
    }

    openSource(location);

    return true;
  };

  const handleRowClick = (event: ReactMouseEvent<HTMLDivElement>, row: TreeRow): void => {
    // A control inside the row — the toggle, or the source chip — has already
    // handled this gesture. Without the guard, clicking a chip would open the
    // file and then select the row that contains it as well.
    if (nestedControlOf(event) !== undefined) {
      return;
    }

    selectRow(row);
  };

  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, row: TreeRow): void => {
    const position = projection.index.get(row.node.key);

    if (position === undefined) {
      return;
    }

    // Checked before the switch so that Shift+Enter never reaches the plain
    // Enter selection below. Consumed only when the row can actually open
    // something; otherwise it falls through to the page untouched. Consuming it
    // also cancels the native activation of a focused toggle or chip, so one
    // press is one open, whichever element inside the row holds focus.
    if (isOpenSourceChord(event)) {
      if (openRowSource(row)) {
        event.preventDefault();
      }

      return;
    }

    // Focus can sit on the toggle or the chip after a pointer press. Enter and
    // Space then belong to that control's own activation — the chip opens the
    // source, the toggle toggles — rather than to the row, which would otherwise
    // select the row as well when its chip was the thing pressed. The arrow
    // keys, Home and End still navigate from there.
    if ((event.key === 'Enter' || event.key === ' ') && nestedControlOf(event) !== undefined) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown': {
        const next = rows[position + 1];

        if (next === undefined) {
          return;
        }

        focusRow(next.node.key);
        break;
      }

      case 'ArrowUp': {
        const previous = position === 0 ? undefined : rows[position - 1];

        if (previous === undefined) {
          return;
        }

        focusRow(previous.node.key);
        break;
      }

      case 'ArrowRight': {
        if (!hierarchical || row.node.children.length === 0) {
          return;
        }

        if (!row.expanded) {
          applyExpansion(row, true);
          break;
        }

        // Depth-first order puts the first child immediately after its parent.
        const child = rows[position + 1];

        if (child === undefined || child.node.parentKey !== row.node.key) {
          return;
        }

        focusRow(child.node.key);
        break;
      }

      case 'ArrowLeft': {
        if (!hierarchical) {
          return;
        }

        if (row.node.children.length > 0 && row.expanded) {
          applyExpansion(row, false);
          break;
        }

        const parentKey = row.node.parentKey;

        if (parentKey === undefined) {
          return;
        }

        focusRow(parentKey);
        break;
      }

      case 'Home': {
        const first = rows[0];

        if (first === undefined) {
          return;
        }

        focusRow(first.node.key);
        break;
      }

      case 'End': {
        const last = rows[rows.length - 1];

        if (last === undefined) {
          return;
        }

        focusRow(last.node.key);
        break;
      }

      case 'Enter':
      case ' ': {
        // Selection only: a branch keeps its disclosure state, and a row with a
        // source keeps it closed until the chip or Shift+Enter asks for it.
        selectRow(row);
        break;
      }

      default:
        // Every other key, Tab included, belongs to the page.
        return;
    }

    event.preventDefault();
  };

  const registerRow = (key: string, element: HTMLDivElement | null): void => {
    if (element === null) {
      rowElements.current.delete(key);

      return;
    }

    rowElements.current.set(key, element);
  };

  const renderRow = (row: TreeRow): ReactElement => {
    const item = row.node;
    const datum = item.datum;
    const rowId = `${baseId}-i${String(item.ordinal)}`;
    const groupId = `${baseId}-g${String(item.ordinal)}`;
    const nameElementId = `${baseId}-l${String(item.ordinal)}`;
    const metaId = `${baseId}-m${String(item.ordinal)}`;
    const markId = `${baseId}-t${String(item.ordinal)}`;
    const hiddenMarkId = `${baseId}-h${String(item.ordinal)}`;

    const name = displayNameOf(datum);
    const instanceKey = instanceKeyOf(datum);
    const trigger = datum.lastTrigger;
    const location = datum.source;
    const hasChildren = hierarchical && item.children.length > 0;
    const isSelected = item.key === selectedKey;
    // The same two conditions `openRowSource` checks, so the row advertises the
    // command exactly when pressing it would do something.
    const opensSource = location !== undefined && openSource !== undefined;
    // Every descendant of a closed branch is off screen, so the marks beneath
    // it are exactly the marks it hides. An open branch hides none of its own:
    // its children are rows, and a closed one among them states its own count.
    const hiddenMarked = hasChildren && !row.expanded ? (markedBeneath.get(item.key) ?? 0) : 0;
    // The count first, then each badge the row carries, in reading order — so
    // a screen reader hears the mark and the hidden count with the row rather
    // than only by walking into it.
    const descriptionIds = [
      metaId,
      row.highlighted ? markId : undefined,
      hiddenMarked > 0 ? hiddenMarkId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    // The only inline style in this file, and the mechanism the stylesheet
    // expects: a unitless level it multiplies by one spacing token.
    const depthStyle: DepthStyle = { '--dgc-depth': String(item.depth) };

    return (
      <div
        id={rowId}
        ref={(element) => {
          registerRow(item.key, element);
        }}
        role={hierarchical ? 'treeitem' : 'listitem'}
        className={clsx(
          'dg-component-tree__node',
          row.expanded && 'dg-is-expanded',
          row.highlighted && 'dg-is-highlighted',
          isSelected && 'dg-is-selected',
        )}
        style={depthStyle}
        tabIndex={item.key === activeRowKey ? 0 : -1}
        aria-level={hierarchical ? item.depth + 1 : undefined}
        aria-posinset={item.position}
        aria-setsize={item.setSize}
        aria-expanded={hasChildren ? row.expanded : undefined}
        aria-selected={hierarchical ? isSelected : undefined}
        aria-current={!hierarchical && isSelected ? true : undefined}
        aria-owns={hasChildren && row.expanded ? groupId : undefined}
        aria-labelledby={nameElementId}
        aria-describedby={descriptionIds}
        aria-keyshortcuts={opensSource ? OPEN_SOURCE_KEYSHORTCUTS : undefined}
        onClick={(event) => {
          handleRowClick(event, row);
        }}
        onKeyDown={(event) => {
          handleRowKeyDown(event, row);
        }}
        onFocus={() => {
          setActiveKey(item.key);
        }}
      >
        {hasChildren ? (
          <Button
            className="dg-component-tree__toggle"
            variant="ghost"
            size="sm"
            iconOnly
            icon={
              row.expanded ? (
                <ChevronDown className="dg-icon" aria-hidden="true" />
              ) : (
                <ChevronRight className="dg-icon" aria-hidden="true" />
              )
            }
            aria-label={`${row.expanded ? COLLAPSE_PREFIX_LABEL : EXPAND_PREFIX_LABEL} ${name}`}
            aria-expanded={row.expanded}
            aria-controls={groupId}
            // The widget is one tab stop: the toggle is reached with
            // ArrowRight/ArrowLeft on the row that owns it, not with Tab.
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              setActiveKey(item.key);
              applyExpansion(row, !row.expanded);
            }}
          />
        ) : (
          // An empty box in the toggle's place, which is what keeps a leaf's
          // label aligned with its siblings'.
          <span className="dg-component-tree__toggle" aria-hidden="true" />
        )}

        <Text as="span" id={nameElementId} className="dg-component-tree__label" truncate>
          {name}
        </Text>

        {instanceKey === undefined ? null : (
          <Badge variant="outline">
            <span className="dg-visually-hidden">{`${INSTANCE_KEY_PREFIX_LABEL} `}</span>
            {instanceKey}
          </Badge>
        )}

        <span id={metaId} className="dg-component-tree__count">
          {countTextOf(datum)}
          <span className="dg-visually-hidden">{` ${renderUnitOf(datum)}`}</span>
        </span>

        <span className="dg-component-tree__count">
          {durationTextOf(datum)}
          <span className="dg-visually-hidden">{` ${RENDER_TIME_UNIT_LABEL}`}</span>
        </span>

        {trigger === undefined ? null : (
          <Badge variant="outline" color={renderTriggerColorVar(trigger)}>
            <span className="dg-visually-hidden">{`${TRIGGER_PREFIX_LABEL} `}</span>
            {formatRenderTriggerLabel(trigger)}
          </Badge>
        )}

        {row.highlighted ? (
          // The mark is words and an icon, never colour alone.
          <Badge
            id={markId}
            tone="warning"
            variant="soft"
            icon={<TriangleAlert className="dg-icon" aria-hidden="true" />}
          >
            {AT_OR_ABOVE_THRESHOLD_LABEL}
          </Badge>
        ) : null}

        {hiddenMarked > 0 ? (
          // Outline rather than soft: it points at marks elsewhere rather than
          // being this row's own, and the two must not read as the same badge.
          <Badge
            id={hiddenMarkId}
            tone="warning"
            variant="outline"
            icon={<TriangleAlert className="dg-icon" aria-hidden="true" />}
          >
            {`${formatCount(hiddenMarked)} ${HIDDEN_MARKED_SUFFIX}`}
          </Badge>
        ) : null}

        {location === undefined ? null : (
          // Forwarded field for field: this view rewrites no part of a location.
          // Out of the Tab order like the toggle: the row is the widget's one
          // stop, and Shift+Enter on it is the keyboard route to this chip.
          <SourceLink location={location} compact onOpenSource={openSource} tabIndex={-1} />
        )}
      </div>
    );
  };

  const renderRowTree = (tree: RowTree): ReactElement => {
    const item = tree.row.node;
    const groupId = `${baseId}-g${String(item.ordinal)}`;
    const hasChildren = hierarchical && item.children.length > 0;

    return (
      <Fragment key={item.key}>
        {renderRow(tree.row)}
        {hasChildren ? (
          // A sibling rather than a descendant — see the module documentation —
          // and present even while collapsed so `aria-controls` on the toggle
          // always names a real element. Collapsed it renders no children, which
          // is what bounds a large structure on first paint.
          <div
            id={groupId}
            role="group"
            className="dg-component-tree__children"
            hidden={!tree.row.expanded}
          >
            {tree.row.expanded ? tree.children.map(renderRowTree) : null}
          </div>
        ) : null}
      </Fragment>
    );
  };

  // One empty state for both ways a capture can hold no structure to draw: the
  // service's `null` and a snapshot with no nodes. The two are the same fact
  // about the capture, so they render the same markup.
  const renderEmpty = (): ReactElement => (
    <div className="dg-component-tree__empty">
      <EmptyState
        title={EMPTY_TITLE}
        message={EMPTY_MESSAGE}
        icon={<ListTree className="dg-icon" aria-hidden="true" />}
      />
    </div>
  );

  const renderBody = (): ReactElement => {
    if (!supported) {
      // A defect in the panel rather than a failed request: worded from the
      // node catalog, with no retry, because asking again cannot change it.
      return (
        <div className="dg-component-tree__error">
          <ErrorState {...unsupportedQueryProps(node.type, query)} />
        </div>
      );
    }

    if (result.status === 'loading') {
      return (
        <div className="dg-component-tree__loading">
          <LoadingState variant="rows" rows={LOADING_ROW_COUNT} label={LOADING_LABEL} />
        </div>
      );
    }

    if (result.status === 'error') {
      return (
        <div className="dg-component-tree__error">
          {/* The shared contract: the generic lead followed by the cause the
              provider stated, its hint and code, the query as asked and a
              retry. It reports what failed and never reads like an analysis. */}
          <ErrorState {...queryFailureProps(result, query)} />
        </div>
      );
    }

    // Checked before the shape guard, which a `null` would otherwise fail: the
    // service's "no tree" is an answer about the capture, not a malformed one.
    if (emptyCapture) {
      return renderEmpty();
    }

    if (snapshot === undefined) {
      // An answer that arrived but cannot be read: the same contract as a
      // failed request, carrying this view's own cause (see SHAPE_FAILURE).
      return (
        <div className="dg-component-tree__error">
          <ErrorState
            {...queryFailureProps(
              { error: SHAPE_FAILURE, announcement: undefined, retry: result.retry },
              query,
            )}
          />
        </div>
      );
    }

    if (snapshot.nodeCount === 0 || rows.length === 0) {
      return renderEmpty();
    }

    const origin = describeOrigin(snapshot.origin);
    const levels =
      typeof snapshot.maxDepth === 'number' && Number.isFinite(snapshot.maxDepth)
        ? snapshot.maxDepth + 1
        : Number.NaN;
    const statistics = [
      `${formatCount(snapshot.nodeCount)} ${nounForCount(NODES_LABEL, snapshot.nodeCount)}`,
      `${formatCount(levels)} ${nounForCount(LEVELS_LABEL, levels)}`,
      `${formatCount(rows.length)} ${SHOWN_LABEL}`,
    ].join(' · ');

    const caveats: string[] = [];

    if (snapshot.degraded) {
      caveats.push(DEGRADED_NOTE);
    }

    if (snapshot.truncated) {
      caveats.push(TRUNCATED_NOTE);
    }

    if (prepared.unfollowed > 0) {
      caveats.push(`${UNFOLLOWED_NOTE_PREFIX} ${formatCount(prepared.unfollowed)}.`);
    }

    if (prepared.all.length !== snapshot.nodeCount) {
      caveats.push(
        `${COUNT_MISMATCH_NOTE_PREFIX} ${formatCount(prepared.all.length)} of ${formatCount(
          snapshot.nodeCount,
        )}.`,
      );
    }

    const toolbarActions: ToolbarAction[] = [];

    if (hierarchical && prepared.parentKeys.length > 0) {
      toolbarActions.push({
        id: `${baseId}-expand-all`,
        label: EXPAND_ALL_LABEL,
        onSelect: () => {
          applyExpansionToAll(true);
        },
      });
      toolbarActions.push({
        id: `${baseId}-collapse-all`,
        label: COLLAPSE_ALL_LABEL,
        onSelect: () => {
          applyExpansionToAll(false);
        },
      });
    }

    if (commitRef !== undefined && actions !== undefined) {
      toolbarActions.push({
        id: `${baseId}-commit`,
        label: SHOW_COMMIT_LABEL,
        // Pressed exactly while the commit is the panel's selected event, from
        // this control or from any view that drew the same event: the toolbar
        // turns it into `aria-pressed` and the pressed surface together.
        pressed: matchesPanelSelection(selection, commitRef),
        onSelect: () => {
          // A no-op under a host, whose record of the report is what every
          // view then marks; the view's own selection outside one.
          markSelected(commitRef);
          actions.onSelectEvent(commitRef);
        },
      });
    }

    // Text that names no threshold — zero, a sign, a fraction — is kept in the
    // field so the developer can correct it, but the field is marked invalid
    // and the toolbar says which default applies meanwhile, so a rejected value
    // never reads as the one in force. An empty field is not an error: clearing
    // it is the documented way back to the default.
    const thresholdRejected =
      thresholdText !== undefined &&
      thresholdText.trim() !== '' &&
      enteredThresholdOf(thresholdText) === undefined;

    const toolbarStatus: ToolbarStatus[] = [
      {
        label: `${formatCount(markedTotal)} ${MARKED_STATUS_SUFFIX}`,
        tone: markedTotal > 0 ? 'warning' : 'neutral',
      },
    ];

    if (thresholdRejected) {
      // A short status pill rather than the field's own error line: the
      // toolbar wraps between pills, so the pill takes the next free place,
      // whereas an error line under the field would widen the field's column to
      // the sentence and push every action beside it sideways. The full
      // sentence is the field's description and live region below.
      toolbarStatus.push({
        label: `${THRESHOLD_DEFAULT_IN_FORCE_PREFIX} ${formatCount(derivedThreshold)}`,
        tone: 'danger',
      });
    }

    const thresholdRejection = thresholdRejected
      ? `${THRESHOLD_REJECTED_PREFIX} ${formatCount(
          MINIMUM_ENTERED_THRESHOLD,
        )}. The default of ${formatCount(derivedThreshold)} applies until then.`
      : '';
    const thresholdRejectionId = `${baseId}-threshold-rejection`;

    const thresholdExplanation = `Marks every component whose cumulative render count reaches this value. The default of ${formatCount(derivedThreshold)} is ${String(THRESHOLD_MEDIAN_MULTIPLE)}× the median render count of the ${formatCount(counts.length)} ${nounForCount(COMPONENTS_LABEL, counts.length)} in this capture, so it follows the capture rather than a fixed number. Clear the field, or enter anything but a whole number of at least ${formatCount(MINIMUM_ENTERED_THRESHOLD)}, to restore it.`;

    const noteId = `${baseId}-note`;

    return (
      <>
        <Stack gap={1} className="dg-component-tree__note" id={noteId}>
          <Stack direction="horizontal" gap={2} align="center" wrap>
            <Badge tone={origin.tone} variant="outline">
              {origin.label}
            </Badge>
            <Text size="xs" tone="muted" numeric>
              {statistics}
            </Text>
          </Stack>

          {/* The badge's explanation is visible text, never a tooltip: the badge
              is not a focus target, so a tooltip on it would be unreachable from
              the keyboard, and what the structure can and cannot promise is part
              of the answer. Being in the note, it is also in the description the
              tree carries, so focusing the tree announces it. */}
          <Text size="xs" tone="muted">
            {origin.detail}
          </Text>

          <Text size="xs" tone="muted">
            {PROVENANCE_NOTE}
          </Text>

          {caveats.map((caveat) => (
            <Text key={caveat} size="xs" tone="warning">
              {caveat}
            </Text>
          ))}

          {sourceCommandOffered ? (
            // The visible half of the row command a chip out of the Tab order
            // needs; the row's `aria-keyshortcuts` is the announced half. In the
            // note, so it is also part of the description the tree carries.
            <Text size="xs" tone="muted">
              {OPEN_SOURCE_HINT_PREFIX} <Kbd keys={OPEN_SOURCE_KEYS} /> {OPEN_SOURCE_HINT_SUFFIX}
            </Text>
          ) : null}
        </Stack>

        <Toolbar
          label={TOOLBAR_LABEL}
          compact
          wrap
          className="dg-component-tree__toolbar"
          actions={toolbarActions}
          status={toolbarStatus}
        >
          <Tooltip content={thresholdExplanation}>
            <Input
              label={THRESHOLD_LABEL}
              type="number"
              controlSize="sm"
              // Bounds for the spin buttons and the arrow keys, not a clamp: the
              // text is still read by `enteredThresholdOf`, which owns the rule.
              min={MINIMUM_ENTERED_THRESHOLD}
              max={thresholdMaximum}
              step={THRESHOLD_STEP}
              invalid={thresholdRejected}
              // Merged by the tooltip with its own bubble id, so the field is
              // described by the rule and, while rejected, by the reason.
              aria-describedby={thresholdRejected ? thresholdRejectionId : undefined}
              value={thresholdText ?? String(derivedThreshold)}
              onValueChange={(next) => {
                // The field keeps what the developer typed, mid-edit included;
                // the host hears the threshold that is actually in force.
                setThresholdText(next);
                actions?.onFilterChange?.(node.id, {
                  [THRESHOLD_FILTER_KEY]: thresholdFilterValueOf(next),
                });
              }}
            />
          </Tooltip>
          {/* Always mounted, so the change of its text is announced as the
              developer types; visually hidden, so it takes no place in the
              wrapping toolbar row. Empty while the value is accepted. A live
              region without the `status` role, which the renderer reserves
              for a view that is still loading. */}
          <span
            id={thresholdRejectionId}
            className="dg-visually-hidden"
            aria-live="polite"
            aria-atomic="true"
          >
            {thresholdRejection}
          </span>
        </Toolbar>

        <div
          role={hierarchical ? 'tree' : 'list'}
          aria-label={node.title ?? (hierarchical ? CATALOG_ENTRY.label : LIST_LABEL)}
          aria-describedby={noteId}
        >
          {projection.trees.map(renderRowTree)}
        </div>
      </>
    );
  };

  return <div className={clsx('dg-component-tree', className)}>{renderBody()}</div>;
}
