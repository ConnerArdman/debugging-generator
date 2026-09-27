/**
 * `host/NodeRenderer` — the recursive dispatcher that turns the nodes of a
 * validated panel specification into elements.
 *
 * ## The one job
 *
 * For each node: look its `type` up in the component registry, render the
 * component the registry paired with that type, and — for a container — render
 * the node's `children` through this module again. That is the whole of it.
 * The per-type work of mapping a node onto a component's own props lives in
 * `./registry`, which is where the pairing is reviewed; this module knows only
 * the uniform contract that every registry entry accepts, so adding a node type
 * to the schema's catalogue and the registry needs no edit here.
 *
 * ## What this module deliberately does NOT do
 *
 * - **It does not validate.** A specification is parsed by
 *   `@debuggen/panel-schema` and, for a generated panel, checked against the
 *   capture it claims to describe, before it may be stored, broadcast or drawn.
 *   By the time a node reaches this file, that has happened.
 * - **It does not mutate or repair.** No query field is defaulted, narrowed or
 *   reordered, no node is dropped and no label is invented. The one heading this
 *   module supplies for a node that carries none — an untitled view's catalogue
 *   label, see "Headings belong to the container" below — is the schema's own
 *   vocabulary, drawn beside the node and never written onto it. A panel on
 *   screen has to be the panel the coordination service validated and stored,
 *   so every field below is read and none is written.
 * - **It reaches no transport.** The evidence behind a node arrives through that
 *   component's own `useQuery` against the ambient `DataProvider`, and an
 *   interaction leaves through the ambient `PanelActions`. There is no
 *   `fetch`, no socket, no message port and no host API in this file, and no
 *   provider or callback prop either — the host mounts the contexts once,
 *   around the whole panel.
 * - **It holds no React state.** The dispatch itself has no state, no hook and
 *   no effect; the one effect in this file belongs to the node frame, which
 *   holds a DOM focus keeper and nothing React renders from (see "Focus
 *   survives a node's own remounts" below). The dispatch is memoized, and the
 *   memo is keyed on the node *object*: a node that is the same object as on
 *   the previous render, at the same position and outline level, draws the same
 *   thing, so re-rendering it would only re-render every table and SVG view
 *   beneath it for nothing. A replaced specification brings new node objects,
 *   so a node can never stay on screen after the document behind it changed —
 *   which is why identity, and never the node's `id`, is what the memo compares.
 *   A view that reads a context (its data, its session, its actions) still
 *   re-renders when that context changes; the memo only stops a parent's render
 *   from reaching it.
 *
 * ## Focus survives a node's own remounts
 *
 * A view replaces parts of its own subtree as its query moves between states,
 * and a focused element that leaves the document hands focus to `<body>` —
 * for a keyboard or screen-reader user, the same as being thrown back to the
 * top of the panel. Pressing **Retry** is the everyday case: the query returns
 * to loading, the view swaps its `ErrorState` for a `LoadingState`, and the
 * button that was pressed is gone a moment before a fresh error or the
 * recovered view takes its place. A paging control disabled while its page
 * loads, or removed once the last page has arrived, loses focus the same way.
 *
 * The cure lives here because the wrapper this module emits around every node
 * is the one element that outlives every state its node passes through, and
 * because every panel surface renders every node through this file: one keeper
 * per frame covers all sixteen node types, the retry of every error state, a
 * table's "Load more" and any other control a view remounts, without a line of
 * focus code in the views themselves. It is plain DOM — listeners and a
 * `MutationObserver` on the frame, installed by one effect and removed by its
 * teardown — and writes no React state, so it adds no render. Its rules, in
 * full on {@link installNodeFocusKeeper}:
 *
 * - **It never steals focus.** It acts only when focus it was tracking has
 *   fallen to `<body>`, or while focus sits where the keeper itself parked it.
 *   A reader who moved on — to another control, another node, or nowhere — is
 *   left exactly where they went.
 * - **An equivalent control wins.** A control carrying the `ErrorState`'s
 *   focus-key attribute is recognised again after a remount, so a retry that
 *   fails again puts focus on the *new* Retry.
 * - **Otherwise the node's own region.** Focus is parked on the node's heading
 *   (the `Section` heading every view and every titled container draws) or,
 *   for a node without one (a source link, an untitled container, a failure),
 *   on the frame itself — made programmatically focusable with `tabindex="-1"`
 *   only while it holds focus — and stays there once the node has settled on
 *   content with no equivalent control.
 * - **Each frame answers for its own node only.** Frames nest (a container's
 *   frame holds its children's), so a frame treats as its own only the elements
 *   whose nearest frame it is.
 *
 * ## A node type with no component is an error ON SCREEN, never a blank area
 *
 * The renderer contract has two halves: a node type with no component is a
 * validation failure raised by `packages/panel-schema/src/validate.ts` before
 * rendering, and it is never a blank area. Both bind this file. The first says a
 * miss here cannot happen through the supported path — an unknown node type is
 * rejected by the validator — so the remaining ways to reach one are all
 * defects: a stored panel written by a newer vocabulary and read back, a caller
 * that rendered a specification it never validated, or a catalogue entry added
 * without a registry component. The second says what a defect must look like:
 * this module renders {@link ErrorState}, naming the node type and the node's
 * id, inside a wrapper whose stylesheet rule gives it the room the
 * visualization would have occupied.
 *
 * It must not return `null`, an empty fragment or a substituted component, and
 * it must not read as "no data": a failure is never presented as a successful
 * result. "No data" belongs to a component whose query legitimately resolved to
 * nothing, which is that component's own empty state.
 *
 * There is deliberately no error boundary. One that rendered nothing would
 * dress a failure as success, and one that rendered a message would absorb the
 * stack a developer needs; a component that throws while drawing is a defect
 * that has to reach the surface's own diagnostics, and the failure this file
 * *does* own — the registry miss — is handled explicitly below.
 *
 * ## Headings belong to the container, and are written once here
 *
 * The thirteen leaf components draw no heading. They take `node.title` as an
 * accessible name for the grid, list or figure they render and nothing more,
 * because every one of the sixteen node types carries the same optional
 * `title`/`description` pair and rendering it in thirteen places would give a
 * titled node two headings and an outline level no component can place. So a
 * *labelled leaf* is wrapped in `../layout/Section` here — once, for all of
 * them — while a *container's* own labels are forwarded by that container's
 * registry adapter, whose layout primitive already renders them.
 *
 * A *view* — one of the twelve leaf types that draw captured evidence, which
 * the catalogue marks as `kind: 'visualization'` with `requiresQuery` — is a
 * labelled leaf even when the panel gave it no title. Its heading is then the
 * catalogue `label` of its type ("Timeline", "Event log", …), the name that
 * field is documented to supply for "a section heading a panel did not title",
 * so every view is a named region in the outline and the landmark list rather
 * than a table or chart a reader can only reach by tabbing through it. The
 * label is the schema's vocabulary, not wording this file chose. Two kinds of
 * node draw a heading only for a title with text: the source-link leaf, a
 * single chip whose own accessible name already says where it goes, so a
 * heading per chip would only lengthen the outline; and the three containers,
 * which group nodes without naming them and so add no level when untitled
 * (below). A description on an untitled view renders under that label; on a
 * source link it still renders on its own, in an unnamed container. See
 * {@link leafHeadingFor}.
 *
 * The outline depth this module tracks is the depth of every heading a node
 * renders: {@link NodeRendererProps.headingLevel} is the level of the node's own
 * heading — a labelled leaf's, drawn by the `Section` this module wraps it in,
 * or a container's, drawn by its layout primitive and passed to it through the
 * registry's uniform contract (`PanelNodeComponentProps.headingLevel`). The
 * children of a container are rendered one level below the heading that
 * container actually drew: one level deeper when its title has text, at the
 * same level when it has none (a description alone adds prose, not an outline
 * level), clamped at the deepest legal level. A section inside a split inside a
 * section therefore reads as three consecutive levels, never a repeated or a
 * skipped one — the failure that actually costs a screen-reader user their
 * sense of structure.
 *
 * ## Children are an ARRAY, never a fragment
 *
 * `../layout/Split` positions its panes by index over `Children.toArray(children)`,
 * and a fragment counts as **one** entry there: handing a division its children
 * inside a fragment would collapse every pane into the first and silently
 * misalign `weights`. {@link renderPanelNodes} is therefore a function that
 * returns `ReactElement[]` rather than a list *component*, and its result is
 * spread into a container as the array it is. The same function is what a host
 * renders a specification's `layout` with, so the layout and every nested level
 * go through one implementation.
 *
 * ## The dispatched component is data, so it is `createElement`
 *
 * The wrappers below are JSX, because they are markup this file wrote. The
 * component a node dispatches to is not: it is a value resolved from the
 * registry at render time, exactly as `./registry` resolves its own components
 * with `createElement` — "which is also what the automatic JSX runtime would
 * have produced". Spelling the dispatch as a call rather than as an element
 * with a capitalised variable says that much in the syntax, and it keeps
 * `eslint-plugin-react-hooks`'s static-component guarantee meaningful for the
 * markup that genuinely is markup instead of suppressing it with a comment.
 * The identity of what is dispatched to is stable either way: the registry's
 * entries are module constants, so a node type resolves to the same component
 * on every render and nothing inside a view is remounted by this dispatch.
 *
 * ## Keys are node ids
 *
 * A sibling's key is its own validated `id`. That is what makes a view's
 * identity survive a regenerated or re-ordered layout: a node that moves keeps
 * its component instance, its local sort and filter state and its settled
 * query, instead of being remounted and refetched because it now sits at a
 * different index. Validation forbids duplicate ids, but a specification read
 * back unvalidated could still carry one, so {@link renderPanelNodes} keeps the
 * keys unique regardless: a repeated id is suffixed with its index after a `#`,
 * a character no valid id contains, so it can never collide with a real one and
 * React never has to reconcile two siblings under one key.
 *
 * The document path — `layout.0`, `layout.0.children.1` — is kept, and kept
 * for diagnosis only: it is carried down the recursion and written onto each
 * node's wrapper as `data-node-path`, so a node on screen can be traced back to
 * its place in the stored specification. The identity reported to
 * `PanelActions` is a third value and always the node's own `id`: that is what
 * the specification named it and what a stored panel's evidence references
 * point at.
 *
 * ## Appearance is two class names and no CSS value
 *
 * `../styles/components.css` implements both, under its
 * `host/PanelHost.tsx and host/NodeRenderer.tsx` heading:
 *
 *   `dg-panel__node`        the wrapper this module emits around every node. It
 *                           owns no appearance — a `section` node renders its
 *                           own container inside it and a leaf renders onto the
 *                           panel surface, its `Section` being the plain
 *                           variant, which draws no surface — but it does
 *                           carry the column flow and the zero minimum inline
 *                           size that let a wide table or timeline shrink
 *                           inside a division instead of forcing it open.
 *   `dg-panel__node-error`  added to that wrapper for the failure above. Its
 *                           minimum block size is what makes an unrenderable
 *                           node occupy the room its visualization would have,
 *                           which is the mechanical half of "never a blank
 *                           area".
 *
 * There is no inline style, no colour, no length and no font in this file, and
 * no raw interactive, tabular or heading element: the heading of a labelled leaf
 * is `../layout/Section`'s, and the failure is `../primitives/ErrorState`'s,
 * because every visual value in the renderer resolves to a token and every
 * control, table and heading to a library primitive. The focus keeper adds no
 * class either: it *reads* the frame class and `Section`'s heading class as
 * selectors, and the only attribute it ever writes is a temporary
 * `tabindex="-1"`, so a parked focus is drawn by the stylesheet's one
 * `:focus-visible` ring like any other.
 *
 * Relative specifiers are extensionless, as everywhere under `src/**` of this
 * package: it resolves with `moduleResolution: "bundler"`, unlike the
 * `.js`-suffixed convention of the Node-targeted packages.
 *
 * @module
 */

import {
  PANEL_CHILDREN_FIELD,
  PANEL_LAYOUT_PATH_ROOT,
  catalogEntryFor,
} from '@debuggen/panel-schema';
import type { PanelNode, PanelNodePath } from '@debuggen/panel-schema';
import type { DebuggenErrorCode } from '@debuggen/shared';
import { createElement, memo, useEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { Section } from '../layout/Section';
import { ErrorState, FOCUS_KEY_ATTRIBUTE } from '../primitives/ErrorState';
import type { HeadingLevel } from '../primitives/Heading';
import { componentForNodeType } from './registry';

/*
 * ---------------------------------------------------------------------------
 * Class names and wording
 * ---------------------------------------------------------------------------
 */

/** The wrapper class every rendered node carries. */
const NODE_CLASS = 'dg-panel__node';

/**
 * The wrapper class of a node that could not be rendered, composed onto
 * {@link NODE_CLASS} rather than replacing it.
 *
 * Both classes, so the wrapper stays findable as a node wrapper — one per node,
 * whatever happened inside it — while the stylesheet's minimum block size
 * applies. Written as one literal rather than through `clsx`, because both
 * parts are constants: there is no condition to compose here, and a helper call
 * would only hide that.
 */
const NODE_FAILURE_CLASS = `${NODE_CLASS} dg-panel__node-error`;

/**
 * The first line of the failure state.
 *
 * Stated rather than left to the error primitive's generic default: nothing was
 * *loaded* here, so "could not load this view" would misdescribe a node the
 * renderer has no component for.
 */
const FAILURE_TITLE = 'Could not render this part of the panel';

/**
 * The code the failure state chips, from the closed vocabulary
 * `@debuggen/shared` owns.
 *
 * `PANEL_INVALID` is the product's code for a specification that should not have
 * passed validation, which is exactly what an unrenderable node is — the
 * annotation is what proves the string is a member of that vocabulary rather
 * than a code invented here, and it costs a type-only import.
 */
const FAILURE_CODE: DebuggenErrorCode = 'PANEL_INVALID';

/**
 * The accessible name of the failure state's preformatted block.
 *
 * The block holds the node's own definition — the JSON this renderer could not
 * draw — and no data query, so the error primitive's default name ("Failing
 * query") would tell a screen-reader user it is something it is not.
 */
const FAILURE_BLOCK_LABEL = 'Node definition';

/*
 * ---------------------------------------------------------------------------
 * Outline depth
 * ---------------------------------------------------------------------------
 */

/**
 * The level a node's own heading sits at when the caller states none: **2**,
 * the level `../layout/Section` itself defaults to. Every node rendered without
 * a stated level — a labelled leaf, or a container of any of the three types —
 * therefore opens the outline at the same depth. `PanelHost` always states one,
 * placing a panel's layout below its title.
 */
const DEFAULT_HEADING_LEVEL: HeadingLevel = 2;

/** The deepest heading level the document outline has, and the clamp's ceiling. */
const DEEPEST_HEADING_LEVEL: HeadingLevel = 6;

/**
 * The heading level for the children of a container whose own title is at
 * `level`.
 *
 * One step deeper, clamped, exactly as `../layout/SummaryHeader` clamps its
 * regions: a generated panel may nest arbitrarily and a level of `7` is not an
 * element, so the bottom of the range duplicates one level rather than emitting
 * a heading that no assistive technology announces.
 *
 * @param level The level of the container's own heading.
 * @returns The level its labelled children render at.
 */
function nextHeadingLevel(level: HeadingLevel): HeadingLevel {
  return level >= DEEPEST_HEADING_LEVEL ? DEEPEST_HEADING_LEVEL : ((level + 1) as HeadingLevel);
}

/*
 * ---------------------------------------------------------------------------
 * Reading a node
 * ---------------------------------------------------------------------------
 */

/**
 * Whether an optional label carries something to render.
 *
 * Absent, empty and whitespace-only are one case, which is the rule the three
 * layout primitives apply to the same two fields: a blank title must leave a
 * container unnamed rather than produce an empty heading, and a leaf whose
 * title is blank is read exactly as a leaf that has none.
 *
 * Module-private, as the identical predicate is in each layout primitive: it is
 * two comparisons over a string and nothing about it is design-system
 * vocabulary.
 *
 * @param value The label as the specification carries it, if at all.
 * @returns `true` when the value is a string with a non-whitespace character.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * The heading a leaf's region is drawn under, or `undefined` for a leaf that
 * draws none.
 *
 * The node's own title whenever it has text: what the panel author wrote always
 * wins. Otherwise a view of captured evidence — a catalogue entry of
 * `kind: 'visualization'` whose `requiresQuery` is set, which is exactly the
 * twelve query-backed leaf types — is headed by its catalogue `label`, the
 * field `@debuggen/panel-schema` documents as the name "for a section heading a
 * panel did not title". Reading both facts from the catalogue, rather than
 * naming types here, is what keeps a node type added to the vocabulary
 * classified without an edit to this file, exactly as containment is.
 *
 * The source-link leaf is the one visualization this leaves unheaded: it reads
 * no capture (`requiresQuery` is false) and draws a single chip whose own
 * accessible name states where it leads, so a heading would name one control
 * rather than a region and add an outline entry per chip. The containers never
 * reach this function; their labels are their layout primitive's.
 *
 * @param node A leaf, already known to the registry.
 * @returns The heading text, or `undefined` when the leaf draws no heading.
 */
function leafHeadingFor(node: PanelNode): string | undefined {
  if (hasText(node.title)) {
    return node.title;
  }

  const entry = catalogEntryFor(node.type);

  return entry.kind === 'visualization' && entry.requiresQuery ? entry.label : undefined;
}

/**
 * The children of a container node, or `undefined` for a node this module
 * cannot read children from.
 *
 * The *decision* about containment is the catalogue's — {@link
 * NodeRenderer} reads `supportsChildren`, because containment is a fact the
 * schema owns and a renderer that re-derived it from a list of type names would
 * be a second source for it. This function is the type-safe *read* that the
 * decision needs: a predicate applied to `node.type` does not narrow `node`
 * itself, so the three container types are named in a switch, which is the only
 * construction the compiler uses to reach `children` without a cast.
 *
 * `undefined` for every other type is therefore not "this is a leaf" — the
 * caller already knows that from the catalogue — but "the catalogue calls this a
 * container and this module has no read for it", which can only mean the
 * vocabulary grew a fourth container. The caller renders that as a visible
 * failure instead of dropping a subtree silently.
 *
 * @param node The node whose children are wanted.
 * @returns Its children, or `undefined` when this module cannot read them.
 */
function containerChildren(node: PanelNode): readonly PanelNode[] | undefined {
  switch (node.type) {
    case 'section':
    case 'split':
    case 'stack':
      return node.children;

    default:
      return undefined;
  }
}

/**
 * The node itself, serialised for the failure state, or `undefined` when it
 * cannot be serialised.
 *
 * The error primitive renders what was asked for and never serialises anything,
 * by its own documented contract: the inside of a failure renderer is the worst
 * place in a product to throw, because the render that was reporting a problem
 * would fail and leave the reader an empty region. So the serialisation happens
 * here, where the value's type is known, and a failure of it is handled — a node
 * arrives parsed from JSON and cannot be cyclic, but a hand-built object with a
 * throwing accessor could be, and losing the detail is strictly better than
 * losing the message.
 *
 * Pretty-printed, which is the form that primitive expects, and unbounded: a
 * node is a handful of fields, and a specification carries no captured value —
 * every query in it names a prepared view, so there is nothing here to redact.
 *
 * @param node The node that could not be rendered.
 * @returns The node as indented JSON, or `undefined` if that failed.
 */
function describeNode(node: PanelNode): string | undefined {
  try {
    return JSON.stringify(node, undefined, 2);
  } catch {
    return undefined;
  }
}

/**
 * The document path that reaches a node, in its diagnostic spelling.
 *
 * Joined with `.` — `layout.0.children.1` — which is also the form the
 * normaliser derives a node id in, so for a normalized panel the value reads as
 * the node's id and points at the same place in the stored document. Written
 * onto the node's wrapper as `data-node-path` and used for nothing else: React
 * identifies siblings by their ids (see {@link uniqueSiblingKey}).
 *
 * @param path The node's path within its specification.
 * @returns The path as one string.
 */
function pathKey(path: PanelNodePath): string {
  return path.join('.');
}

/**
 * Whether two optional node paths name the same position.
 *
 * Compared element by element, because {@link renderPanelNodes} builds a fresh
 * path array for every node on every call: identity would say "moved" for a node
 * that has not, and defeat the memo it exists for.
 *
 * @param left One path, or `undefined`.
 * @param right The other path, or `undefined`.
 * @returns `true` when both are absent, or both hold the same segments.
 */
function samePath(left: PanelNodePath | undefined, right: PanelNodePath | undefined): boolean {
  if (left === right) {
    return true;
  }

  if (left === undefined || right === undefined || left.length !== right.length) {
    return false;
  }

  return left.every((segment, index) => segment === right[index]);
}

/**
 * The React key of one sibling: its own id, made unique among its siblings.
 *
 * The id is what keeps a view's instance — its local state and its settled
 * query — attached to the node when a layout is re-ordered or regenerated. A
 * valid specification has unique ids, so this is normally the id itself. A
 * repeated id (a specification that reached the renderer unvalidated) is
 * suffixed with its index after `#`, a character `PANEL_NODE_ID_PATTERN` does not
 * admit, so the suffixed key can never equal a valid sibling's id; the loop only
 * matters for ids that are themselves invalid, and guarantees uniqueness even
 * then.
 *
 * @param id The node's id, as the specification carries it.
 * @param index The node's index among its siblings.
 * @param used The keys already given to earlier siblings; extended in place.
 * @returns A key no earlier sibling holds.
 */
function uniqueSiblingKey(id: string, index: number, used: Set<string>): string {
  let key = used.has(id) ? `${id}#${String(index)}` : id;

  while (used.has(key)) {
    key = `${key}#`;
  }

  used.add(key);
  return key;
}

/*
 * ---------------------------------------------------------------------------
 * The node frame and its focus keeper
 * ---------------------------------------------------------------------------
 */

/**
 * {@link NODE_CLASS} as a selector: how an element's nearest frame is found.
 *
 * `Element.closest` with this selector is the whole of how nested frames stay
 * out of each other's way — an element belongs to exactly one frame, the
 * nearest, so a container's keeper never acts for a control inside one of its
 * children.
 */
const NODE_FRAME_SELECTOR = `.${NODE_CLASS}`;

/**
 * The heading a titled node's focus is parked on.
 *
 * `../layout/Section` renders a titled region as `<section aria-labelledby>`,
 * labelled by a `Heading` carrying this class: the region's own name and the
 * first thing announced inside it, which makes it the natural place for focus
 * to wait while the node reloads. A labelled leaf — every view, titled or
 * headed by its catalogue label (see {@link leafHeadingFor}) — receives that
 * `Section` from this module, and a `section` container from its layout
 * primitive. Read here as a selector only — the class is `Section`'s, styled
 * by `../styles/components.css`, and this file never emits it.
 */
const NODE_HEADING_SELECTOR = '.dg-section__title';

/** Any element carrying a focus key, whatever the key's value. */
const FOCUS_KEY_SELECTOR = `[${FOCUS_KEY_ATTRIBUTE}]`;

/**
 * A region still loading.
 *
 * `LoadingState` renders `aria-busy="true"`. While such a region remains in a
 * node, focus parked on that node keeps waiting, because the control
 * equivalent to the one that was lost — the Retry of a retry that fails again —
 * may still be on its way.
 */
const BUSY_SELECTOR = '[aria-busy="true"]';

/** A control that cannot take focus because it, or its fieldset, is disabled. */
const DISABLED_SELECTOR = ':disabled';

/** A subtree the browser will not focus into: hidden, or made inert. */
const UNFOCUSABLE_SUBTREE_SELECTOR = '[hidden], [inert]';

/** The attribute a parking target borrows while it holds focus. */
const TABINDEX_ATTRIBUTE = 'tabindex';

/**
 * The borrowed value: focusable by script, never a stop in the tab order, so a
 * parked heading adds no tab stop to the panel and loses even that once focus
 * moves on.
 */
const PARKED_TABINDEX = '-1';

/**
 * What a keeper's observer watches.
 *
 * `childList` over the `subtree` sees a control removed and its successor
 * inserted anywhere below the frame. The attributes are the ways a control can
 * stay in the document and still stop being focusable — `disabled` (a paging
 * control while its page loads), `hidden` and `inert` — plus `aria-busy`, whose
 * clearing is how a loading region updated in place, rather than replaced,
 * reports that it settled. Nothing else is observed, so a view restyling or
 * re-labelling its own subtree wakes the keeper only for the cheap early exit.
 */
const FOCUS_KEEPER_OBSERVATION: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['disabled', 'hidden', 'inert', 'aria-busy'],
};

/**
 * An element that can hold focus: HTML, or SVG — the chart views make SVG
 * marks focusable — both of which implement `focus()` and `tabindex`.
 */
type FocusTarget = HTMLElement | SVGElement;

/**
 * Focus the keeper moved onto the node's own region after the control holding
 * it was lost, and has not yet handed on.
 */
interface ParkedFocus {
  /** The heading, or the frame, focus is parked on. */
  readonly target: FocusTarget;

  /** The focus key of the control that was lost, or `null` when it carried none. */
  readonly key: string | null;

  /**
   * The control that was lost. It may come back — a paging control disabled
   * while its page loads is re-enabled once the page arrives — and focus
   * returns to it when it does.
   */
  readonly origin: FocusTarget;
}

/**
 * Keeps keyboard focus inside one node while that node's view replaces the
 * control that held it, and returns the teardown that removes every trace of
 * itself.
 *
 * Installed by {@link NodeFrame} on the wrapper it renders, which is the one
 * element that survives every state a node passes through. Plain DOM, and
 * deliberately so: the keeper writes no React state, so it causes no render,
 * and it needs none of the view's cooperation beyond the optional focus key
 * `../primitives/ErrorState` already puts on its Retry.
 *
 * **Scope.** An element belongs to this frame when its nearest
 * {@link NODE_FRAME_SELECTOR} ancestor (itself included) is this frame. Every
 * rule below applies to in-scope elements only, so of two nested frames only
 * the inner one acts for a control inside it.
 *
 * **Tracking.** A `focusin` on an in-scope element records it as the tracked
 * element, with its focus key: the {@link FOCUS_KEY_ATTRIBUTE} of the element
 * or of its nearest in-scope ancestor carrying one. A `focusout` towards
 * anything out of scope forgets it — the reader moved on. A `focusout` towards
 * nothing (`relatedTarget` null) is judged one microtask later, once the DOM
 * has settled: an element still connected and focusable that no longer holds
 * focus was left deliberately (a click into empty space, focus handed outside
 * the page) and is forgotten; one that was removed or disabled is a loss.
 *
 * **Loss.** The observer, a `MutationObserver` connected only while something
 * is tracked, reconciles after every mutation. Focus is lost when the tracked
 * element is disconnected, has left this frame's scope, or is disabled, hidden
 * or inert, **and** the document's focus has fallen to `<body>`. On a loss,
 * focus moves to the first focusable in-scope element carrying the same focus
 * key; failing that, it is parked on the node's own region — the first
 * in-scope {@link NODE_HEADING_SELECTOR}, or the frame when the node has no
 * heading — which borrows `tabindex="-1"` only if it had no `tabindex` of its
 * own, and gives it back the moment it loses focus.
 *
 * **Parked.** While focus rests where the keeper parked it, every later
 * mutation checks again: an equivalent control that has appeared (a retry that
 * failed again renders a new Retry), or the lost control itself focusable
 * again (a re-enabled "Load more"), takes focus, and the parked state ends.
 * When neither is possible and neither can still happen — no in-scope region
 * is busy and the lost control is gone for good — the node has settled on
 * content with no equivalent control, focus stays on the heading or frame, and
 * that becomes the tracked element.
 *
 * **Never steal.** The keeper moves focus only when focus has fallen to
 * `<body>` from an element it was tracking, or while focus is exactly where
 * the keeper parked it. Any focus the reader places elsewhere ends the parked
 * state, and nothing that settles afterwards moves focus back.
 *
 * Every focus move passes `preventScroll`, so recovering focus never jumps the
 * panel; the one timer is the microtask above.
 *
 * @param frame The node's wrapper element.
 * @returns The teardown: disconnects the observer, removes both listeners and
 * gives back any borrowed `tabindex`.
 */
function installNodeFocusKeeper(frame: HTMLElement): () => void {
  const ownerDocument = frame.ownerDocument;

  // The frame's own window, so the type checks below hold for a panel rendered
  // into another document (a portal into a popup) as well as into this one.
  const view = ownerDocument.defaultView ?? globalThis;

  /** The in-scope element focus was last seen on, while it is worth keeping. */
  let tracked: FocusTarget | null = null;

  /** The focus key of {@link tracked}, captured while it was still in the document. */
  let trackedKey: string | null = null;

  /** Where focus waits after a loss, until it can be handed on. */
  let parked: ParkedFocus | null = null;

  /** The parking target whose `tabindex` the keeper added, and must remove. */
  let borrowed: FocusTarget | null = null;

  /** Whether the observer is connected; it is only while there is focus to keep. */
  let watching = false;

  /** Set by the teardown, so a microtask queued before it does nothing after it. */
  let disposed = false;

  const observer = new view.MutationObserver(reconcile);

  function isFocusTarget(value: unknown): value is FocusTarget {
    return value instanceof view.HTMLElement || value instanceof view.SVGElement;
  }

  function inScope(element: Element): boolean {
    return element.closest(NODE_FRAME_SELECTOR) === frame;
  }

  function isFocusable(element: FocusTarget): boolean {
    return (
      element.isConnected &&
      !element.matches(DISABLED_SELECTOR) &&
      element.closest(UNFOCUSABLE_SUBTREE_SELECTOR) === null
    );
  }

  function focusFellToBody(): boolean {
    const active = ownerDocument.activeElement;
    return active === null || active === ownerDocument.body;
  }

  function focusKeyOf(element: FocusTarget): string | null {
    const keyed = element.closest(FOCUS_KEY_SELECTOR);
    return keyed !== null && inScope(keyed) ? keyed.getAttribute(FOCUS_KEY_ATTRIBUTE) : null;
  }

  /** The first in-scope, focusable element matching `selector` that `accept` admits. */
  function findFocusable(
    selector: string,
    accept: (element: FocusTarget) => boolean,
  ): FocusTarget | null {
    for (const element of frame.querySelectorAll(selector)) {
      if (isFocusTarget(element) && inScope(element) && isFocusable(element) && accept(element)) {
        return element;
      }
    }

    return null;
  }

  function isBusy(): boolean {
    for (const element of frame.querySelectorAll(BUSY_SELECTOR)) {
      if (inScope(element)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Where focus lost with `key` from `origin` should go now: the equivalent
   * control first, then the lost control itself if it is usable again, else
   * nowhere yet.
   */
  function successorFor(key: string | null, origin: FocusTarget): FocusTarget | null {
    if (key !== null) {
      const equivalent = findFocusable(
        FOCUS_KEY_SELECTOR,
        (element) => element.getAttribute(FOCUS_KEY_ATTRIBUTE) === key,
      );

      if (equivalent !== null) {
        return equivalent;
      }
    }

    return inScope(origin) && isFocusable(origin) ? origin : null;
  }

  /** Focuses `target` without scrolling, and reports whether it took focus. */
  function moveFocus(target: FocusTarget): boolean {
    target.focus({ preventScroll: true });
    return ownerDocument.activeElement === target;
  }

  function returnTabIndex(): void {
    if (borrowed !== null) {
      borrowed.removeAttribute(TABINDEX_ATTRIBUTE);
      borrowed = null;
    }
  }

  function borrowTabIndex(target: FocusTarget): void {
    if (target.hasAttribute(TABINDEX_ATTRIBUTE)) {
      return;
    }

    returnTabIndex();
    target.setAttribute(TABINDEX_ATTRIBUTE, PARKED_TABINDEX);
    borrowed = target;
  }

  function watch(): void {
    if (!watching) {
      observer.observe(frame, FOCUS_KEEPER_OBSERVATION);
      watching = true;
    }
  }

  function forget(): void {
    tracked = null;
    trackedKey = null;
    parked = null;

    if (watching) {
      observer.disconnect();
      watching = false;
    }
  }

  /** Parks focus on the node's heading, or on the frame when it has none. */
  function park(key: string | null, origin: FocusTarget): void {
    const target = findFocusable(NODE_HEADING_SELECTOR, () => true) ?? frame;

    borrowTabIndex(target);
    // Recorded before the move, so the `focusin` the move raises is recognised
    // as the keeper's own and does not end the parked state it starts.
    parked = { target, key, origin };
    watch();

    if (!moveFocus(target)) {
      // Refused (a frame hidden by its host, say): nothing is parked, and the
      // loss is tried again on the next mutation.
      parked = null;
      if (borrowed === target) {
        returnTabIndex();
      }
    }
  }

  /** Answers a loss: the successor if there is one, else the node's region. */
  function recover(key: string | null, origin: FocusTarget): void {
    const successor = successorFor(key, origin);

    if (successor !== null && moveFocus(successor)) {
      return;
    }

    park(key, origin);
  }

  /** Runs after every observed mutation, and after an unexplained `focusout`. */
  function reconcile(): void {
    if (disposed) {
      return;
    }

    const active = ownerDocument.activeElement;
    const current = parked;

    if (current !== null) {
      if (active === current.target) {
        const successor = successorFor(current.key, current.origin);

        if (successor !== null) {
          // Cleared first, so the successor's `focusin` records it normally.
          parked = null;
          if (!moveFocus(successor)) {
            parked = current;
          }
          return;
        }

        // Nothing equivalent, and nothing still on its way: the node settled on
        // content without such a control, and its own region is where focus
        // belongs from now on.
        if (!isBusy() && !inScope(current.origin)) {
          parked = null;
          tracked = current.target;
          trackedKey = null;
        }
        return;
      }

      parked = null;

      if (isFocusTarget(active) && inScope(active)) {
        tracked = active;
        trackedKey = focusKeyOf(active);
        return;
      }

      if (!focusFellToBody()) {
        forget();
        return;
      }

      // The parking target itself was removed while it held focus — a remount
      // above the view — so the original loss is answered again.
      recover(current.key, current.origin);
      return;
    }

    if (tracked === null || !focusFellToBody()) {
      return;
    }

    if (inScope(tracked) && isFocusable(tracked)) {
      return;
    }

    recover(trackedKey, tracked);
  }

  function onFocusIn(event: FocusEvent): void {
    const { target } = event;

    if (!isFocusTarget(target) || !inScope(target)) {
      return;
    }

    if (parked !== null && target === parked.target) {
      return;
    }

    parked = null;
    tracked = target;
    trackedKey = focusKeyOf(target);
    watch();
  }

  /**
   * The deferred half of a `focusout` towards nothing, judged once the DOM has
   * settled (see "Tracking" above): left deliberately, or lost.
   */
  function judgeFocusOut(target: FocusTarget): void {
    if (disposed || (target !== tracked && target !== parked?.target)) {
      return;
    }

    if (inScope(target) && isFocusable(target) && ownerDocument.activeElement !== target) {
      forget();
      return;
    }

    reconcile();
  }

  function onFocusOut(event: FocusEvent): void {
    const { target, relatedTarget } = event;

    if (borrowed !== null && target === borrowed) {
      returnTabIndex();
    }

    if (!isFocusTarget(target) || !inScope(target)) {
      return;
    }

    if (relatedTarget !== null) {
      // An in-scope destination is recorded by its own `focusin`; anything
      // else is the reader leaving this node.
      if (!isFocusTarget(relatedTarget) || !inScope(relatedTarget)) {
        forget();
      }
      return;
    }

    view.queueMicrotask(() => {
      judgeFocusOut(target);
    });
  }

  frame.addEventListener('focusin', onFocusIn);
  frame.addEventListener('focusout', onFocusOut);

  return () => {
    disposed = true;
    forget();
    frame.removeEventListener('focusin', onFocusIn);
    frame.removeEventListener('focusout', onFocusOut);
    returnTabIndex();
  };
}

/** The inputs of one {@link NodeFrame}. */
interface NodeFrameProps {
  /** {@link NODE_CLASS}, or {@link NODE_FAILURE_CLASS} for a node that could not render. */
  readonly className: string;

  /** The node's document path, written as `data-node-path` for diagnosis. */
  readonly diagnosticPath: string;

  /** The node's content: its view, its `Section`, or its failure state. */
  readonly children: ReactNode;
}

/**
 * The wrapper every node is drawn in, with its focus keeper.
 *
 * Exactly the element this module has always emitted — the same classes, the
 * same `data-node-path`, the children untouched — plus a ref and one effect
 * that installs {@link installNodeFocusKeeper} on it and tears it down on
 * unmount. The effect runs once per frame: the wrapper is this component's
 * root element and is never replaced while the node is mounted, and the keeper
 * reads everything else from the live DOM, so it depends on no prop.
 *
 * One component for every branch of {@link NodeRendererView}, so a node that
 * changes branch (a leaf that gains a title) keeps its frame and its keeper,
 * which then recovers any focus the change removed with the old subtree.
 *
 * @param props See {@link NodeFrameProps}.
 * @returns The wrapper element.
 */
function NodeFrame(props: NodeFrameProps): ReactElement {
  const { className, diagnosticPath, children } = props;
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = frameRef.current;

    if (frame === null) {
      return undefined;
    }

    return installNodeFocusKeeper(frame);
  }, []);

  return (
    <div ref={frameRef} className={className} data-node-path={diagnosticPath}>
      {children}
    </div>
  );
}

/**
 * Renders the failure a node type with no component must show.
 *
 * A plain function rather than a component: it takes no props of its own, holds
 * nothing, and inlining the element at both call sites would be the same
 * markup written twice.
 *
 * @param node The node that could not be rendered.
 * @param message What went wrong, in one sentence.
 * @param diagnosticPath The node's document path, for `data-node-path`.
 * @returns The wrapper and the error state inside it.
 */
function renderNodeFailure(node: PanelNode, message: string, diagnosticPath: string): ReactElement {
  return (
    <NodeFrame className={NODE_FAILURE_CLASS} diagnosticPath={diagnosticPath}>
      <ErrorState
        title={FAILURE_TITLE}
        message={message}
        code={FAILURE_CODE}
        query={describeNode(node)}
        queryLabel={FAILURE_BLOCK_LABEL}
      />
    </NodeFrame>
  );
}

/*
 * ---------------------------------------------------------------------------
 * The dispatcher
 * ---------------------------------------------------------------------------
 */

/**
 * The inputs of one rendered node.
 *
 * Three, and the last two are positioning rather than content: the node is the
 * whole of what is drawn, and the data provider, the session and the action
 * contract are ambient — the host mounts them once around the panel, so they are
 * not props here and must not become them.
 *
 * Every optional member spells `| undefined` explicitly, because
 * `exactOptionalPropertyTypes` is in force repository-wide and a caller
 * forwarding a value it may not have has to stay legal.
 */
export interface NodeRendererProps {
  /**
   * The validated node to draw.
   *
   * Read, never written: see this module's header on what it does not do. A
   * node arrives having been parsed by `@debuggen/panel-schema` and, for a
   * generated panel, checked against its capture.
   */
  readonly node: PanelNode;

  /**
   * Where this node sits in its specification, as the path that reaches it —
   * `['layout', 0]` for the first top-level node.
   *
   * Diagnostic only: written onto the node's wrapper as `data-node-path` and
   * extended for its children, so every node on screen can be traced back to its
   * place in the stored document. It identifies nothing to React — siblings are
   * keyed by their ids. Defaults to the node's own id as a single-segment path,
   * which is what a caller rendering a node on its own — a test, or a surface
   * showing one view — gets without having to invent a document position.
   */
  readonly path?: PanelNodePath | undefined;

  /**
   * The outline level this node's own heading sits at, when it has one.
   *
   * A labelled leaf's heading is the `Section` this module wraps it in — for
   * an untitled view, headed by its catalogue label; a container's heading is
   * its layout primitive's, reached through the registry's uniform contract,
   * and drawn only for a title with text. Either way the heading renders at
   * this level, and the children of a container whose title has text render
   * one level deeper, so the outline never repeats or skips a level.
   *
   * @default 2
   */
  readonly headingLevel?: HeadingLevel | undefined;
}

/**
 * Whether a re-render of a node would draw exactly what is already on screen.
 *
 * The same node object at the same position and outline level: the node is the
 * whole of the content, the other two are the whole of its placement, and
 * everything else a view reads arrives through a context, which re-renders its
 * consumers on its own. The node is compared by identity — never by id, which a
 * regenerated panel can share with the panel it replaced — so a changed
 * document always renders.
 *
 * @param previous The props of the last render.
 * @param next The props of this render.
 * @returns `true` when the render may be skipped.
 */
function sameNodeRendererProps(previous: NodeRendererProps, next: NodeRendererProps): boolean {
  return (
    previous.node === next.node &&
    previous.headingLevel === next.headingLevel &&
    samePath(previous.path, next.path)
  );
}

/**
 * Draws one node of a validated panel, and its subtree.
 *
 * The dispatch is a single lookup in `./registry`, so every node type is
 * treated identically here and the per-type differences stay in the adapters
 * the registry declares. A container's children are rendered through
 * {@link renderPanelNodes} and handed over as an array; a labelled leaf —
 * every view, and a source link with a title or description — is wrapped in
 * `../layout/Section`; a type the registry has no component for renders a
 * visible failure rather than nothing.
 *
 * Presentational: no state, no effect and no hook of its own. Every branch
 * draws its node inside a {@link NodeFrame}, whose one effect installs the
 * node's focus keeper and holds no React state. The exported
 * {@link NodeRenderer} is this function behind a memo; see
 * {@link sameNodeRendererProps} for when a render is skipped.
 *
 * @param props See {@link NodeRendererProps}.
 * @returns The node's wrapper and whatever belongs inside it — never an empty
 * element, whatever the node turns out to be.
 */
function NodeRendererView(props: NodeRendererProps): ReactElement {
  const { node, path, headingLevel = DEFAULT_HEADING_LEVEL } = props;
  const nodePath: PanelNodePath = path ?? [node.id];
  const diagnosticPath = pathKey(nodePath);

  // First, and deliberately: this lookup is the only *runtime* check that the
  // node's type is one this package draws. `node.type` is typed as a catalogued
  // type, but a specification read back from storage or handed over unvalidated
  // can carry a name outside the vocabulary, and the catalogue accessor below
  // is total over the type rather than over every string — so asking the
  // registry first is what keeps an unknown type a rendered failure instead of
  // a lookup on a missing catalogue entry inside React's render.
  const component = componentForNodeType(node.type);

  if (component === undefined) {
    return renderNodeFailure(
      node,
      `This panel names a node of type "${node.type}" (node "${node.id}"), which this renderer has no component for.`,
      diagnosticPath,
    );
  }

  // Containment is the catalogue's statement, not a list of type names kept
  // here: `supportsChildren` is true for exactly the container types, so a type
  // added to the vocabulary is classified without an edit to this file.
  if (catalogEntryFor(node.type).supportsChildren) {
    const children = containerChildren(node);

    if (children === undefined) {
      return renderNodeFailure(
        node,
        `The node type "${node.type}" (node "${node.id}") is catalogued as a container, but this renderer cannot read its children.`,
        diagnosticPath,
      );
    }

    return (
      <NodeFrame className={NODE_CLASS} diagnosticPath={diagnosticPath}>
        {createElement(component, {
          node,
          nodeId: node.id,
          // The container's own heading sits at the level this node was given;
          // its layout primitive renders it there instead of at its default.
          headingLevel,
          children: renderPanelNodes(children, {
            basePath: [...nodePath, PANEL_CHILDREN_FIELD],
            // One level below the heading the container actually drew: deeper
            // only when its title has text, because a description alone adds
            // prose, not an outline level.
            headingLevel: hasText(node.title) ? nextHeadingLevel(headingLevel) : headingLevel,
          }),
        })}
      </NodeFrame>
    );
  }

  // A leaf: the component draws the node's evidence and takes no children, and
  // a leaf handed children by a malformed specification is rendered exactly as
  // it would be without them (the registry's adapters ignore the prop).
  const view = createElement(component, { node, nodeId: node.id });

  // The heading a leaf's labels deserve, rendered once, here: its title, or for
  // an untitled view its catalogue label (see `leafHeadingFor`), at the level
  // this node was given, so the view is a named region in the outline. The
  // condition applies the same blank-label rule `Section` applies internally,
  // so a source link whose title is whitespace is not given an empty container
  // to sit in. Only the two labels and the outline level are passed: the frame
  // and the spacing stay at the container's own defaults, because a
  // specification carries no field for either and this file may not invent one.
  const heading = leafHeadingFor(node);

  if (heading !== undefined || hasText(node.description)) {
    return (
      <NodeFrame className={NODE_CLASS} diagnosticPath={diagnosticPath}>
        <Section title={heading} description={node.description} headingLevel={headingLevel}>
          {view}
        </Section>
      </NodeFrame>
    );
  }

  return (
    <NodeFrame className={NODE_CLASS} diagnosticPath={diagnosticPath}>
      {view}
    </NodeFrame>
  );
}

/**
 * Draws one node of a validated panel, and its subtree — skipping the render
 * when the same node object is asked for again at the same position and outline
 * level.
 *
 * {@link NodeRendererView} behind `memo`, with {@link sameNodeRendererProps} as
 * the comparison: a parent that re-renders for its own reasons does not
 * re-render a table or an SVG view beneath it, while a replaced node, a moved
 * node or a changed outline level always does. Data, session and actions reach
 * the views through contexts, which re-render their consumers independently of
 * this memo.
 *
 * @example One node, rendered on its own.
 * ```tsx
 * <NodeRenderer node={node} />
 * ```
 */
export const NodeRenderer = memo(NodeRendererView, sameNodeRendererProps);

NodeRenderer.displayName = 'NodeRenderer';

/*
 * ---------------------------------------------------------------------------
 * The list
 * ---------------------------------------------------------------------------
 */

/** How {@link renderPanelNodes} positions the nodes it renders. */
export interface RenderPanelNodesOptions {
  /**
   * The path the list itself sits at, which each node's own diagnostic path
   * extends with its index.
   *
   * Defaults to a specification's `layout` field, so a host rendering a panel's
   * layout states nothing and gets the paths `layout.0`, `layout.1`, … — the
   * same strings the normaliser used as those nodes' ids.
   */
  readonly basePath?: PanelNodePath | undefined;

  /**
   * The outline level each node in the list renders its own heading at, when it
   * has one. Omitted, each node takes {@link NodeRendererProps.headingLevel}'s
   * default.
   */
  readonly headingLevel?: HeadingLevel | undefined;
}

/**
 * Renders a list of sibling nodes — a specification's `layout`, or one
 * container's children.
 *
 * A function returning an **array**, not a list component, and that is a
 * contract rather than a style: `../layout/Split` positions its panes by index
 * over `Children.toArray(children)`, where a fragment counts as one entry, so a
 * component here would collapse every division in the product into a single
 * pane. Returning the array lets a container receive its children as the
 * sequence the specification wrote.
 *
 * An empty list renders no elements, which is the correct reading of a
 * specification whose layout is legitimately empty — "may be empty when there
 * was nothing to draw" — and a panel that drew nothing is the host's to explain,
 * since only the host knows the summary and the state of the session behind it.
 *
 * Each element is keyed by its node's id (see {@link uniqueSiblingKey}), so a
 * node that moves among its siblings keeps its component instance rather than
 * being remounted — and re-queried — at its new index. A caller that renders the
 * same `nodes` array on every render should memoize the result on that array,
 * as `PanelHost` does: identical elements are what let React skip the subtree.
 *
 * @param nodes The sibling nodes, in reading order.
 * @param options See {@link RenderPanelNodesOptions}.
 * @returns One element per node, keyed by its id.
 *
 * @example A host rendering a validated panel's layout.
 * ```tsx
 * const body = useMemo(() => renderPanelNodes(spec.layout), [spec.layout]);
 * ```
 */
export function renderPanelNodes(
  nodes: readonly PanelNode[],
  options: RenderPanelNodesOptions = {},
): ReactElement[] {
  const { basePath = PANEL_LAYOUT_PATH_ROOT, headingLevel } = options;
  const usedKeys = new Set<string>();

  return nodes.map((node, index) => {
    const path: PanelNodePath = [...basePath, index];

    return (
      <NodeRenderer
        key={uniqueSiblingKey(node.id, index, usedKeys)}
        node={node}
        path={path}
        headingLevel={headingLevel}
      />
    );
  });
}
