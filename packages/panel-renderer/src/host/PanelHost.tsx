/**
 * `host/PanelHost` — the entry point of the renderer: one validated panel
 * specification in, one live panel out.
 *
 * Two surfaces mount this component and nothing else of this tier: the Chrome
 * DevTools panel and the editor webview. Everything a generated panel is
 * allowed to be, it is because of what happens here.
 *
 * ## What this component does
 *
 * Four things, in this order, and no fifth:
 *
 * 1. Mounts the theme root (`../layout/PanelShell`), which is the one module in
 *    the package that writes the theme attribute and the one scroll region a
 *    panel has. That region is a keyboard focus stop, so it is named: its
 *    `labelledBy` is the id this component hands the head's visible title, and
 *    the region is announced by the panel's own title rather than as an
 *    anonymous container, with no second heading added to the outline.
 * 2. Provides the ambient contracts — the data provider, the session the
 *    specification belongs to, and the action contract — around the whole
 *    subtree, so that every view beneath it reaches its evidence and reports its
 *    interactions without any of them being threaded through each intervening
 *    layer. The session is `spec.sessionId`, the document's own statement of
 *    which capture it describes; every query a view makes is addressed to it
 *    (`POST /sessions/:id/panel-data`). Beside them it provides the panel's one
 *    shared selection — the event every view marks as selected — which it
 *    records from every selection a view or evidence chip reports, or takes
 *    from the surface when the surface drives it.
 * 3. Renders the head (`../layout/SummaryHeader`), which is where the
 *    observed/inferred separation lives, handing it the document's generation
 *    (`panelVersion`, and whether it `supersedes` a predecessor) so a
 *    follow-up's answer is marked as the version it is.
 * 4. Renders the layout, node by node, through `./NodeRenderer`.
 *
 * A specification that arrived as the deterministic fallback is announced
 * above all of it, by the banner below. A later generation replacing the panel
 * in place is announced politely, by a visually hidden live region that stays
 * mounted across the replacement, and keyboard focus that was inside the
 * outgoing panel is carried into the new one (see "Focus survives a panel
 * replacement" below).
 *
 * ## What this component does NOT do, on purpose
 *
 * **It does not validate.** No parse, no normalisation, no repair, no
 * defaulting: a specification reaches this component having already been parsed
 * against the schema and, for a generated panel, checked against the capture it
 * claims to describe, by the coordination service that owns both steps. A
 * second, partial check here would be a second opinion about what a valid
 * document is — and the weaker one, because this component cannot see the
 * capture.
 *
 * **It does not mutate.** The specification is read, never sorted, filtered,
 * cloned-and-edited or written into. It is a document that is generated once
 * and then travels: the same object is held by the store, carried by the
 * transport and rendered by two surfaces at once, so a convenience sort here
 * would change what a developer sees in the other one.
 *
 * **It does not fetch.** No socket, no request, no host API. Data arrives
 * through the injected provider and interactions leave through the injected
 * actions, which is what lets one panel render identically in an inspected page
 * and in an editor, and what keeps this tier testable without a transport.
 *
 * **It does not present a failure as an answer.** A fallback panel carries
 * `meta.fallback`, and this component draws it under a visible banner that says
 * so, above the summary, in words rather than as a colour — while still
 * rendering every view beneath it, because a deterministic summary of a real
 * capture is worth reading.
 *
 * **It does not re-render what did not change.** A host surface re-renders this
 * component for reasons that have nothing to do with the panel — a selection in
 * its details drawer, a connection pill, a fresh `actions` object built from the
 * same callbacks — and a panel is a dozen tables and SVG views deep. So the
 * action context is rebuilt only when one of its callbacks changes identity,
 * the head only when the title, the summary, the generation, its two callbacks
 * or the id of the selected event change, and
 * the rendered layout only when `spec.layout` itself is a different value. The
 * data and session contexts carry values that are already stable (the injected
 * provider, and a string). A replaced specification still re-renders exactly
 * what it replaced: every memo below is keyed on the document's own objects,
 * never on an id that a regenerated panel could share with its predecessor.
 *
 * **It does not let a view outlive the panel it was drawn for.** Re-rendering
 * less is only safe while the mounted views belong to the document on screen.
 * The panel column is therefore keyed on the document's session, id and
 * generation, so a specification for another session — or another panel, or a
 * regenerated one — unmounts every view of the previous panel and mounts fresh
 * ones, instead of reusing views whose paged rows, next-page offsets and
 * filters were accumulated against a different capture. A re-delivery of the
 * same panel keeps the key, and with it every mounted view (see
 * `panelIdentityKey` below).
 *
 * ## Focus survives a panel replacement
 *
 * Remounting the column destroys the element that held keyboard focus, and a
 * focused element that leaves the document hands focus to `<body>` — for a
 * keyboard or screen-reader user, being thrown out of the panel at the moment a
 * follow-up's answer arrives. `./NodeRenderer`'s focus keepers cannot help:
 * they live in the node frames, which go with the column. So the host, whose
 * instance outlives every column it renders, carries focus across:
 *
 * - **Tracking.** The column's `focus`/`blur` handlers record the element
 *   holding focus inside it, and forget it when the reader moves focus out of
 *   the column deliberately — to another element, or into empty space. A
 *   focused element that is *removed* is not a departure, so the record
 *   survives the remount.
 * - **Restoring.** After a replaced column commits, the one effect in this
 *   file checks the record. When focus was inside the outgoing column and has
 *   fallen to `<body>`, it moves focus to the same node in the new panel — a
 *   node of the same type, matched by id and then by its position among nodes
 *   of that type, innermost node first, landing on that node's heading — and
 *   otherwise to the panel title. A node heading
 *   borrows `tabindex="-1"` only while it holds focus; the title is
 *   programmatically focusable by `../layout/SummaryHeader`'s own contract.
 *   Neither ever becomes a tab stop.
 * - **Keeping it visible.** The new panel's views load after the column
 *   commits, and each arrival grows the layout around the restored target. A
 *   bounded watch reveals the target again whenever the column resizes, until
 *   the reader moves focus, scrolls, points or types, or the panel settles —
 *   so focus that was carried across is never left below the fold.
 * - **Never stealing.** Nothing moves when focus was outside the panel before
 *   the replacement, or has gone anywhere but `<body>` since.
 *
 * ## Class names
 *
 * `dg-panel` is the block, with `dg-panel__banner`/`--fallback` for the notice,
 * `dg-panel__summary` composed onto the head and `dg-panel__body` around the
 * layout. The rules behind those names live in `../styles/components.css`
 * against `--dg-*` tokens; this file names classes and never carries a visual
 * value of its own.
 *
 * Relative specifiers are extensionless: this workspace resolves with
 * `moduleResolution: "bundler"`, unlike the `.js`-suffixed convention of the
 * Node-targeted packages.
 *
 * @module
 */

import { PANEL_CHILDREN_FIELD, PANEL_LAYOUT_PATH_ROOT } from '@debuggen/panel-schema';
import type { PanelNode, PanelNodePath, PanelSpec } from '@debuggen/panel-schema';
import { LayoutTemplate, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FocusEvent, ReactElement, ReactNode } from 'react';

import { PanelShell } from '../layout/PanelShell';
import { SummaryHeader } from '../layout/SummaryHeader';
import { EmptyState } from '../primitives/EmptyState';
import type { HeadingLevel } from '../primitives/Heading';
import { Text } from '../primitives/Text';
import type { PanelTheme } from '../tokens/theme';
import { DataProviderContext, PanelSessionContext } from './DataProvider';
import type { DataProvider } from './DataProvider';
import { renderPanelNodes } from './NodeRenderer';
import {
  PanelActionsContext,
  PanelSelectionContext,
  isPanelHostActions,
  toPanelHostActions,
  toPanelViewActions,
} from './PanelActions';
import type {
  PanelActions,
  PanelEventRef,
  PanelHostActions,
  PanelSelection,
  PanelSelectionState,
  PanelViewActions,
} from './PanelActions';

/*
 * ---------------------------------------------------------------------------
 * Class names and wording
 * ---------------------------------------------------------------------------
 */

/** The panel block: the flow column inside the shell's scroll viewport. */
const PANEL_CLASS = 'dg-panel';

/**
 * Composed onto the head's own block class, which is why it is passed as
 * `className` rather than wrapped around it: one element fewer between the
 * panel column and the head, and the head keeps its `header` semantics.
 */
const SUMMARY_CLASS = 'dg-panel__summary';

/** The column the layout's nodes, or the empty state, sit in. */
const BODY_CLASS = 'dg-panel__body';

/**
 * The fallback notice. Both classes: the element class carries the shared
 * banner box, the variant carries the warning edge that makes the notice
 * impossible to mistake for the panel's ordinary surface.
 */
const FALLBACK_BANNER_CLASS = 'dg-panel__banner dg-panel__banner--fallback';

/**
 * The global icon utility of `../styles/base.css`: a `1em` square in
 * `currentColor`, so a glyph scales with the type role around it instead of
 * carrying a size of its own: the renderer hardcodes no dimension.
 */
const ICON_CLASS = 'dg-icon';

/**
 * The fixed, developer-facing wording of the fallback notice.
 *
 * It states two things a shorter notice would drop, and both are the point: the
 * generated panel *failed validation* (so the views below are not an answer to
 * the question that was asked), and what is on screen was *built from captured
 * data* (so it is not invented either). Product copy, not analysis — it makes
 * no claim about the capture, which is what keeps it out of the summary's fact
 * register.
 */
const FALLBACK_BANNER_MESSAGE =
  'Generated panel failed validation; showing a fallback view built from captured data.';

/**
 * The wording for a validated specification whose layout is legitimately empty.
 *
 * Deliberately not an error and deliberately not the fallback notice: a panel
 * may carry a summary and no views — the schema allows it, and for a capture
 * that yielded little it is the honest document — so this states the fact
 * plainly and leaves the reader with the summary that *is* there. Generic
 * product vocabulary only; nothing read out of an inspected project ever
 * reaches a string in this package.
 */
const EMPTY_LAYOUT_MESSAGE = 'This panel specifies no views, so the summary above is all of it.';

/**
 * The global visually hidden utility of `../styles/base.css`: removed from the
 * visual surface, kept in the accessibility tree. The version announcement is
 * read, never seen — the head already shows the version beside the title.
 */
const VISUALLY_HIDDEN_CLASS = 'dg-visually-hidden';

/** The generation a panel starts at; see `PanelSpec.panelVersion`. */
const FIRST_PANEL_VERSION = 1;

/**
 * What the live region says for a panel that names a predecessor but whose
 * own number is the first generation, so no predecessor number exists to name.
 */
const UPDATED_PANEL_ANNOUNCEMENT = 'Showing an updated version of this panel.';

/**
 * The sentence the version live region carries for the panel on screen, or an
 * empty string for a first version.
 *
 * Derived from the document alone, during render. The region itself stays
 * mounted across a panel replacement (it sits outside the keyed column), so
 * assistive technology announces exactly the changes of this text: a follow-up
 * that replaces version 1 with version 2 in place is announced once, a
 * re-delivery of the same version changes nothing and is not re-announced, and
 * a first version says nothing at all. A panel that first mounts as a later
 * version is not announced — a live region reports changes, not its initial
 * content — and the head's version badge states it for every reader.
 *
 * Generic product wording; the predecessor of generation `n` is `n - 1`, as a
 * follow-up stores its answer as the next generation (AAP 0.4.2). A number
 * that is not a whole generation of at least one announces nothing.
 *
 * @param panelVersion The document's `panelVersion`.
 * @param supersedes Whether the document names a panel it supersedes.
 * @returns The announcement, possibly empty.
 */
function versionAnnouncement(panelVersion: number, supersedes: boolean): string {
  if (!Number.isInteger(panelVersion) || panelVersion < FIRST_PANEL_VERSION) {
    return '';
  }

  if (panelVersion > FIRST_PANEL_VERSION) {
    return `Showing version ${String(panelVersion)} of this panel, which updates version ${String(panelVersion - 1)}.`;
  }

  return supersedes ? UPDATED_PANEL_ANNOUNCEMENT : '';
}

/*
 * ---------------------------------------------------------------------------
 * Outline levels
 * ---------------------------------------------------------------------------
 */

/**
 * The level of the panel's own title: **2**, the summary head's documented
 * default, stated here so the relationship with the layout below is written in
 * one file rather than inferred across two. A surface's own chrome — a product
 * wordmark, an editor view title — sits above it.
 */
const PANEL_TITLE_HEADING_LEVEL: HeadingLevel = 2;

/**
 * The level the layout's top-level nodes render their headings at: **3**, one
 * below {@link PANEL_TITLE_HEADING_LEVEL}.
 *
 * A panel's sections are parts of the panel, so their headings belong under its
 * title — beside the head's own "Observed" and "Likely cause" regions, which sit
 * at the same depth — and never beside it. `./NodeRenderer` hands this level to
 * every top-level node, container or labelled leaf, and one level deeper to the
 * children of each container whose title it renders, so the whole outline below
 * the title follows from this one value without a skipped or repeated level.
 */
const LAYOUT_HEADING_LEVEL: HeadingLevel = 3;

/*
 * ---------------------------------------------------------------------------
 * The fallback notice
 * ---------------------------------------------------------------------------
 */

/**
 * Renders the fallback notice.
 *
 * A plain function rather than a component, matching `./NodeRenderer`'s own
 * failure helper: it takes no input, holds no state and exists only to keep the
 * host's return readable, so an extra element in the tree would buy nothing.
 *
 * `role="status"` with `aria-live="polite"`: the notice is advisory rather than
 * interrupting — the panel beneath it is worth reading — and a regenerated
 * panel that arrives as a fallback is exactly the change a reader needs told
 * without losing their place. The same pairing `../primitives/LoadingState`
 * uses, and deliberately not the assertive `role="alert"` of
 * `../primitives/ErrorState`: this is not a failed render, it is a panel of a
 * different provenance.
 *
 * The glyph is hidden from assistive technology and the whole meaning is in the
 * sentence beside it, because colour and iconography are never the sole
 * carriers of a state in this design system.
 *
 * @returns The notice, as one banner element.
 */
function renderFallbackBanner(): ReactElement {
  return (
    <div className={FALLBACK_BANNER_CLASS} role="status" aria-live="polite">
      <TriangleAlert className={ICON_CLASS} aria-hidden="true" />
      <Text as="p" size="sm">
        {FALLBACK_BANNER_MESSAGE}
      </Text>
    </div>
  );
}

/*
 * ---------------------------------------------------------------------------
 * Panel identity
 * ---------------------------------------------------------------------------
 */

/**
 * The React key of the panel column: which capture, which panel and which
 * generation of that panel the mounted views belong to.
 *
 * **Why the column is keyed at all — cross-session isolation.** Several views
 * hold component-local state that outlives a render: the rows they have paged
 * in so far and the offset of the next page (the event log, the span, render,
 * request and query tables, the state-transition viewer, the timeline, the
 * waterfall), a filter or sort chosen in their toolbar, an expanded row. That
 * state is keyed by what the *view* can see — its node, its query, the
 * provider — and none of those name a session. Without this key, a host that
 * swaps in a panel for another session whose layout happens to carry the same
 * node ids and queries (a reopened session of another project, a regenerated
 * panel of the same shape) would keep every view mounted, so a table could
 * keep drawing the previous capture's rows under the new session's title and
 * ask for *its* next page at the previous capture's offset. Keying the column
 * on the document's identity makes React unmount every view of the old panel —
 * aborting its in-flight requests through the query hook's cleanup — and mount
 * fresh ones that start from their first page, under the new session.
 *
 * **What is in the key, and what is deliberately not.**
 *
 * - `sessionId` — the capture every query beneath is addressed to. Another
 *   session is another project's evidence, and nothing a view accumulated may
 *   cross into it.
 * - `id` — another panel of the same session is another document; its views
 *   answer another question and inherit nothing from this one's.
 * - `panelVersion` — a regenerated panel is a new generation of the document,
 *   validated against the capture afresh, so its views start clean as well.
 *
 * Nothing else. A re-delivery of the same panel — a new specification object, a
 * retitled head, a reordered layout, a fresh `actions` object — keeps the same
 * key, so mounted views, their pages and their open disclosures survive it,
 * which is what the render memos below and the node renderer's id keys exist
 * to preserve.
 *
 * Built with `JSON.stringify` over a tuple rather than by joining with a
 * separator, so no identifier can collide with another by containing the
 * separator (`"a|b" + "c"` against `"a" + "b|c"`): an ambiguous key would be a
 * way for two sessions to share a mounted view.
 *
 * @param spec The panel being rendered.
 * @returns A string equal for, and only for, the same session, panel and
 * generation.
 */
function panelIdentityKey(spec: PanelSpec): string {
  return JSON.stringify([spec.sessionId, spec.id, spec.panelVersion]);
}

/*
 * ---------------------------------------------------------------------------
 * Focus across a panel replacement
 * ---------------------------------------------------------------------------
 */

/**
 * `./NodeRenderer`'s node frame class, read as a selector: how the node a
 * focused element sat in is found, and how a node of the new panel is found
 * again. This file never emits the class.
 */
const NODE_FRAME_SELECTOR = '.dg-panel__node';

/**
 * The attribute `./NodeRenderer` writes each frame's document path to —
 * `layout.0.children.1` — the spelling {@link nodePathKey} reproduces.
 */
const NODE_PATH_ATTRIBUTE = 'data-node-path';

/**
 * The heading of a titled node: `../layout/Section`'s title class, read as a
 * selector only. It is the node's own name and the first thing announced
 * inside it, which is what makes it the place focus lands in that node.
 */
const NODE_HEADING_SELECTOR = '.dg-section__title';

/**
 * The panel title inside this host's head. `../layout/SummaryHeader` renders
 * its title programmatically focusable (`tabindex="-1"`) for exactly this use.
 */
const PANEL_TITLE_SELECTOR = `.${SUMMARY_CLASS} .dg-summary-header__title`;

/** A subtree the browser will not focus into. */
const UNFOCUSABLE_SUBTREE_SELECTOR = '[hidden], [inert]';

/** The attribute a node heading borrows while it holds restored focus. */
const TABINDEX_ATTRIBUTE = 'tabindex';

/** The borrowed value: focusable by script, never a stop in the tab order. */
const BORROWED_TABINDEX = '-1';

/**
 * Where keyboard focus was last seen inside the panel column, while the reader
 * has not deliberately taken it elsewhere.
 */
interface ColumnFocus {
  /** The column element the focus was inside — one mounted generation. */
  readonly column: HTMLElement;

  /**
   * The element that held focus. Kept after it leaves the document: a detached
   * subtree still answers `closest`, which is how the node it sat in is read
   * once the column that held it is gone.
   */
  readonly element: Element;
}

/**
 * A node path in `./NodeRenderer`'s diagnostic spelling: its segments joined
 * with `.`, as written onto `data-node-path`.
 *
 * @param path The node's path within its specification.
 * @returns The path as one string.
 */
function nodePathKey(path: PanelNodePath): string {
  return path.join('.');
}

/**
 * The children of a node, or none.
 *
 * Tolerant by design, unlike the schema package's own walk: the host renders
 * specifications it never validates, and a node type outside the vocabulary —
 * which `./NodeRenderer` draws as an error state — must not throw from focus
 * bookkeeping. The three container types are the ones that hold children.
 *
 * @param node A node of the layout.
 * @returns The node's children in document order, or an empty list.
 */
function childNodesOf(node: PanelNode): readonly PanelNode[] {
  switch (node.type) {
    case 'section':
    case 'split':
    case 'stack':
      return node.children;

    default:
      return [];
  }
}

/** One node of a layout with the path key `./NodeRenderer` writes for it. */
interface PlacedNode {
  /** The node itself, read and never written. */
  readonly node: PanelNode;

  /** Its path key, as `data-node-path` spells it. */
  readonly pathKey: string;
}

/**
 * Every node of a layout, depth first, in document order, each with its path
 * key.
 *
 * The paths are the ones `./NodeRenderer` writes for the same layout: the
 * layout root, then each index, with the children field between a container
 * and its children.
 *
 * @param layout The nodes to walk.
 * @returns The nodes in reading order.
 */
function placedNodesOf(layout: readonly PanelNode[]): readonly PlacedNode[] {
  const placed: PlacedNode[] = [];
  const stack: { readonly node: PanelNode; readonly path: PanelNodePath }[] = [];
  const pushSiblings = (nodes: readonly PanelNode[], basePath: PanelNodePath): void => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (node !== undefined) {
        stack.push({ node, path: [...basePath, index] });
      }
    }
  };

  pushSiblings(layout, PANEL_LAYOUT_PATH_ROOT);

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    placed.push({ node: frame.node, pathKey: nodePathKey(frame.path) });
    pushSiblings(childNodesOf(frame.node), [...frame.path, PANEL_CHILDREN_FIELD]);
  }

  return placed;
}

/**
 * The path keys of the node frames enclosing `element`, innermost first.
 *
 * @param element The element that held focus, attached or not.
 * @returns Every enclosing frame's path, possibly none.
 */
function enclosingNodePaths(element: Element): readonly string[] {
  const paths: string[] = [];

  for (
    let frame = element.closest(NODE_FRAME_SELECTOR);
    frame !== null;
    frame = frame.parentElement?.closest(NODE_FRAME_SELECTOR) ?? null
  ) {
    const path = frame.getAttribute(NODE_PATH_ATTRIBUTE);
    if (path !== null) {
      paths.push(path);
    }
  }

  return paths;
}

/**
 * Where the node found at `path` in the outgoing layout sits in the incoming
 * one, best candidate first.
 *
 * Only a node of the **same type** is the same node: the normaliser derives an
 * unnamed node's id from its position, so after a follow-up that inserted a
 * view, the same id — and the same path — can name a different kind of view,
 * and landing there would tell the reader they are somewhere they are not. So:
 *
 * 1. the node of that type carrying the same id — an authored id survives any
 *    reordering;
 * 2. otherwise the node of that type at the same ordinal among nodes of its
 *    type — the second table is still the second table after a view was
 *    inserted before it.
 *
 * A path the outgoing layout does not hold (a column drawn from a
 * specification this host could not walk) is tried as it stands.
 *
 * @param path A node's path key in the outgoing layout.
 * @param outgoing The layout the focused column was drawn from.
 * @param incoming The layout now on screen.
 * @returns The candidate path keys in the incoming layout, best first.
 */
function incomingNodePaths(
  path: string,
  outgoing: readonly PanelNode[],
  incoming: readonly PanelNode[],
): readonly string[] {
  const outgoingNodes = placedNodesOf(outgoing);
  const focused = outgoingNodes.find((placed) => placed.pathKey === path);

  if (focused === undefined) {
    return [path];
  }

  const { type, id } = focused.node;
  const ordinal = outgoingNodes
    .filter((placed) => placed.node.type === type)
    .findIndex((placed) => placed.pathKey === path);
  const sameType = placedNodesOf(incoming).filter((placed) => placed.node.type === type);

  const candidates: string[] = [];
  for (const placed of [sameType.find((entry) => entry.node.id === id), sameType[ordinal]]) {
    if (placed !== undefined && !candidates.includes(placed.pathKey)) {
      candidates.push(placed.pathKey);
    }
  }

  return candidates;
}

/**
 * Whether an element can take focus: attached, and outside any hidden or
 * inert subtree.
 *
 * @param element A candidate target.
 * @returns `true` when the browser would focus it.
 */
function canTakeFocus(element: HTMLElement): boolean {
  return element.isConnected && element.closest(UNFOCUSABLE_SUBTREE_SELECTOR) === null;
}

/**
 * The heading of the node whose frame sits at `path` in `column`, when that
 * node is on screen and titled.
 *
 * Only a heading whose nearest frame is that node's own counts, so a container
 * never answers with one of its children's headings.
 *
 * @param column The newly mounted panel column.
 * @param path A node path key.
 * @returns The heading, or `null`.
 */
function nodeHeadingAt(column: HTMLElement, path: string): HTMLElement | null {
  for (const frame of column.querySelectorAll<HTMLElement>(NODE_FRAME_SELECTOR)) {
    if (frame.getAttribute(NODE_PATH_ATTRIBUTE) !== path) {
      continue;
    }

    for (const heading of frame.querySelectorAll<HTMLElement>(NODE_HEADING_SELECTOR)) {
      if (heading.closest(NODE_FRAME_SELECTOR) === frame && canTakeFocus(heading)) {
        return heading;
      }
    }

    return null;
  }

  return null;
}

/**
 * Focuses `target`, borrowing `tabindex="-1"` when it has no tab index of its
 * own and giving it back the moment focus leaves.
 *
 * Not `preventScroll`: the new panel's content is not the content the reader
 * had scrolled to, and a focused element out of view is a focus indicator
 * nobody can see.
 *
 * @param target The element to focus.
 * @returns Whether it took focus.
 */
function focusRestoredTarget(target: HTMLElement): boolean {
  const borrowed = !target.hasAttribute(TABINDEX_ATTRIBUTE);

  if (borrowed) {
    target.setAttribute(TABINDEX_ATTRIBUTE, BORROWED_TABINDEX);
  }

  target.focus();

  if (target.ownerDocument.activeElement === target) {
    if (borrowed) {
      target.addEventListener(
        'focusout',
        () => {
          target.removeAttribute(TABINDEX_ATTRIBUTE);
        },
        { once: true },
      );
    }
    return true;
  }

  if (borrowed) {
    target.removeAttribute(TABINDEX_ATTRIBUTE);
  }
  return false;
}

/**
 * Moves focus into a newly mounted panel column for focus that was lost with
 * the column before it.
 *
 * The node the lost element sat in comes first — the innermost enclosing node,
 * then each container around it — each matched into the new layout by
 * {@link incomingNodePaths}, and focused on its heading. When no such node is on screen, or
 * none of them is titled, the panel title takes focus: it names the panel and
 * sits immediately before the version it now shows.
 *
 * @param column The newly mounted column.
 * @param lost The element that held focus in the outgoing column.
 * @param outgoing The layout the outgoing column was drawn from.
 * @param incoming The layout now on screen.
 * @returns The element that took focus, or `null` when none could.
 */
function restoreColumnFocus(
  column: HTMLElement,
  lost: Element,
  outgoing: readonly PanelNode[],
  incoming: readonly PanelNode[],
): HTMLElement | null {
  for (const path of enclosingNodePaths(lost)) {
    for (const candidate of incomingNodePaths(path, outgoing, incoming)) {
      const heading = nodeHeadingAt(column, candidate);
      if (heading !== null && focusRestoredTarget(heading)) {
        return heading;
      }
    }
  }

  const title = column.querySelector<HTMLElement>(PANEL_TITLE_SELECTOR);
  if (title !== null && canTakeFocus(title) && focusRestoredTarget(title)) {
    return title;
  }

  return null;
}

/**
 * How long, at most, a restored focus target is kept in view while the new
 * panel settles, in milliseconds. The views of a replacement resolve their
 * queries after the column commits — a large trace takes seconds — and each
 * one that arrives grows the layout above or around the target; past this
 * window the panel is taken to have settled and nothing is moved any more.
 */
const RESTORED_FOCUS_SETTLE_MS = 10_000;

/**
 * The reveal a restored focus target is given when the settling layout moves
 * it. A restored target is always a heading — a view's or the panel's title —
 * which names the region below it, so it is brought to the top of the scroll
 * viewport (`block: 'start'`) where the region it names follows it on screen;
 * aligned to the nearest edge instead, it would settle at the bottom with its
 * own content below the fold. Horizontally it takes the least scroll.
 */
const RESTORED_FOCUS_REVEAL: ScrollIntoViewOptions = { block: 'start', inline: 'nearest' };

/**
 * The document events that mean the reader has taken over — scrolling,
 * pointing or typing. Any one of them ends the watch, so the panel never pulls
 * a reader back to a target they chose to scroll away from.
 */
const READER_INPUT_EVENTS = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;

/**
 * Keeps the element focus was restored to on screen while the replacing
 * panel's views load.
 *
 * Focus is restored the moment the new column commits, when its views are
 * still loading. As each view's data arrives it grows the layout, which can
 * push the focused heading out of the scroll viewport — focus in the right
 * place that nobody can see. A `ResizeObserver` on the column reveals the
 * target again ({@link RESTORED_FOCUS_REVEAL}) each time the column's size
 * changes, for as long as the target still holds focus.
 *
 * The watch ends — and never moves anything again — at the first of: focus
 * leaving the target, any reader input ({@link READER_INPUT_EVENTS}), the
 * column leaving the document, {@link RESTORED_FOCUS_SETTLE_MS} elapsing, or
 * the returned function being called (a later replacement, or the host
 * unmounting). A DOM without `ResizeObserver` or `scrollIntoView` gets no
 * watch, which leaves the focus exactly where it was restored.
 *
 * @param target The element focus was restored to.
 * @param column The column it sits in.
 * @returns A function that ends the watch; calling it again does nothing.
 */
function keepRestoredFocusInView(target: HTMLElement, column: HTMLElement): () => void {
  const view = column.ownerDocument.defaultView;

  if (
    view === null ||
    typeof view.ResizeObserver !== 'function' ||
    typeof target.scrollIntoView !== 'function'
  ) {
    return () => undefined;
  }

  const doc = column.ownerDocument;
  let active = true;

  const stop = (): void => {
    if (!active) {
      return;
    }
    active = false;
    observer.disconnect();
    view.clearTimeout(timer);
    target.removeEventListener('focusout', stop);
    for (const type of READER_INPUT_EVENTS) {
      doc.removeEventListener(type, stop, true);
    }
  };

  const observer = new view.ResizeObserver(() => {
    if (!active) {
      return;
    }
    if (!column.isConnected || doc.activeElement !== target) {
      stop();
      return;
    }
    target.scrollIntoView(RESTORED_FOCUS_REVEAL);
  });

  const timer = view.setTimeout(stop, RESTORED_FOCUS_SETTLE_MS);
  target.addEventListener('focusout', stop);
  for (const type of READER_INPUT_EVENTS) {
    doc.addEventListener(type, stop, { capture: true, passive: true });
  }
  observer.observe(column);

  return stop;
}

/*
 * ---------------------------------------------------------------------------
 * The two action forms
 * ---------------------------------------------------------------------------
 */

/**
 * The callbacks a surface supplied, flattened out of whichever form it used.
 *
 * Exactly one of the two required pairs is set — `selectEvent`/`openSource`
 * for the host form, `onSelectEvent`/`onOpenSource` for the view form — and the
 * other is `undefined`. Flattened so the host can memoize on the callbacks'
 * own identities rather than on the object that carried them.
 */
interface SuppliedActionMembers {
  /** The host form's selection callback, or `undefined` for a view-form value. */
  readonly selectEvent: PanelHostActions['selectEvent'] | undefined;

  /** The host form's navigation callback, or `undefined` for a view-form value. */
  readonly openSource: PanelHostActions['openSource'] | undefined;

  /** The view form's selection callback, or `undefined` for a host-form value. */
  readonly onSelectEvent: PanelViewActions['onSelectEvent'] | undefined;

  /** The view form's navigation callback, or `undefined` for a host-form value. */
  readonly onOpenSource: PanelViewActions['onOpenSource'] | undefined;

  /** The optional disclosure report, shared by both forms. */
  readonly onExpand: PanelHostActions['onExpand'];

  /** The optional filter report, shared by both forms. */
  readonly onFilterChange: PanelHostActions['onFilterChange'];
}

/** Both forms of one surface's actions, as the host hands them on. */
interface PanelActionForms {
  /** What the summary head reports through: `selectEvent` and `openSource`. */
  readonly host: PanelHostActions | undefined;

  /** What the action context carries for the views: `onSelectEvent` and `onOpenSource`. */
  readonly view: PanelViewActions | undefined;
}

/**
 * Rebuilds the supplied actions from their callbacks and derives the other form
 * through the compatibility adapters of `./PanelActions`.
 *
 * The form the surface supplied is rebuilt as a plain object holding the very
 * same callbacks (optional members only where present); the other form is its
 * adaptation. So a host-form surface's `openSource` is the function the views'
 * `onOpenSource` calls, and a view-form surface's `onOpenSource` is the
 * function the head's `openSource` calls — the location reaches the surface by
 * reference either way.
 *
 * A value that carries neither complete pair — impossible for a type-checked
 * surface, reachable only from an untyped caller — yields no actions at all,
 * which renders every affordance in its inert form: a chip that is plainly not
 * a link, never a control that throws when pressed.
 *
 * @param members The supplied callbacks, flattened.
 * @returns The host and view forms, both absent only for an incomplete value.
 */
function panelActionForms(members: SuppliedActionMembers): PanelActionForms {
  const { selectEvent, openSource, onSelectEvent, onOpenSource, onExpand, onFilterChange } =
    members;
  const optional = {
    ...(onExpand === undefined ? {} : { onExpand }),
    ...(onFilterChange === undefined ? {} : { onFilterChange }),
  };

  if (selectEvent !== undefined && openSource !== undefined) {
    const host: PanelHostActions = { selectEvent, openSource, ...optional };

    return { host, view: toPanelViewActions(host) };
  }

  if (onSelectEvent !== undefined && onOpenSource !== undefined) {
    const view: PanelViewActions = { onSelectEvent, onOpenSource, ...optional };

    return { host: toPanelHostActions(view), view };
  }

  return { host: undefined, view: undefined };
}

/*
 * ---------------------------------------------------------------------------
 * The shared selection
 * ---------------------------------------------------------------------------
 */

/**
 * A selection the host recorded from a view's or the head's report, together
 * with the panel it was made in.
 *
 * The panel is part of the record so a selection can never outlive the
 * document it was made against: a panel for another session, another panel or
 * another generation (see {@link panelIdentityKey}) starts with nothing
 * selected, by derivation during render rather than by an effect that would
 * paint the stale mark for a frame first.
 */
interface RecordedSelection {
  /** The {@link panelIdentityKey} of the panel the selection was made in. */
  readonly panelKey: string;

  /** What was selected: the event id and the coordinates the reporter held. */
  readonly selection: PanelSelection;
}

/**
 * The selection a pointer stands for, holding only the coordinates that are
 * present — never a key written with an `undefined` value, and never anything
 * but the three addressing fields (an evidence chip's `kind` and `label` are
 * display sugar, not coordinates).
 *
 * @param ref The pointer a view or the head reported.
 * @returns A fresh selection value.
 */
function selectionOf(ref: PanelEventRef): PanelSelection {
  const { eventId, traceId, spanId } = ref;

  return {
    eventId,
    ...(traceId === undefined ? {} : { traceId }),
    ...(spanId === undefined ? {} : { spanId }),
  };
}

/**
 * Whether two selections name the same event with the same coordinates, so a
 * repeated activation of one item keeps the recorded value — and with it the
 * context's identity — instead of re-rendering every view that reads it.
 *
 * @param a One selection.
 * @param b The other.
 * @returns `true` when every addressing field is equal.
 */
function sameSelection(a: PanelSelection, b: PanelSelection): boolean {
  return a.eventId === b.eventId && a.traceId === b.traceId && a.spanId === b.spanId;
}

/**
 * Both action forms with their selection intent routed through the host
 * first, so the panel's shared selection follows every report — from any view,
 * through the action context, and from the head's evidence chips, through the
 * host form — before the surface's own callback runs.
 *
 * Only the selection member of each form is replaced; every other member is
 * carried over as the very same function, so a location still reaches the
 * surface's `openSource` by reference. The two wrappers never call each other:
 * a view reports through the view form's wrapper, which records once and then
 * calls the view form it wrapped (itself the adaptation of the host form when
 * that is what the surface supplied), so one activation is one recording and
 * one call of the surface's callback.
 *
 * Forms with no actions at all are returned as they are: nothing can report a
 * selection without a handler, so there is nothing to record.
 *
 * @param forms The two forms of the surface's actions.
 * @param record Records a selection as the panel's current one.
 * @returns The two forms, reporting through `record` first.
 */
function withSelectionRecording(
  forms: PanelActionForms,
  record: (selection: PanelSelection) => void,
): PanelActionForms {
  const { host, view } = forms;

  if (host === undefined || view === undefined) {
    return forms;
  }

  const { selectEvent } = host;
  const { onSelectEvent } = view;

  return {
    host: {
      ...host,
      selectEvent: (eventId, coordinates) => {
        record(selectionOf({ eventId, ...coordinates }));
        selectEvent(eventId, coordinates);
      },
    },
    view: {
      ...view,
      onSelectEvent: (ref) => {
        record(selectionOf(ref));
        onSelectEvent(ref);
      },
    },
  };
}

/*
 * ---------------------------------------------------------------------------
 * The host
 * ---------------------------------------------------------------------------
 */

/**
 * The inputs of one rendered panel.
 *
 * Three required members and three conveniences. The document (which names its
 * own session), the data contract and the action contract are the whole of what
 * a panel needs: the provider and the actions are *injected* rather than
 * constructed here, which is the boundary that keeps this tier free of any
 * transport.
 *
 * Every optional member spells `| undefined` explicitly, because
 * `exactOptionalPropertyTypes` is in force repository-wide and a host
 * forwarding a value it may not have — `theme={resolvedTheme}` from a host
 * signal that has not arrived yet — has to stay legal.
 *
 * There is deliberately no `spec`-adjacent escape hatch: no `validate` flag, no
 * `onError`, no node override map, no style or token prop. A panel that needs
 * a view this package does not have needs a node type, and a value that is not
 * in the token set is not a value this design system renders.
 */
export interface PanelHostProps {
  /**
   * The validated, normalized panel to draw.
   *
   * Read only — see this module's header on what this component does not do
   * with it. `spec.meta?.fallback === true` is the one field it branches on,
   * and `spec.sessionId` is the session every query beneath it is addressed to.
   */
  spec: PanelSpec;

  /**
   * How every view beneath this panel resolves the `DataQuery` its node
   * carries, for the session named by `spec.sessionId`.
   *
   * Provided as context, so the reference must be **stable** across renders:
   * it is part of the query effect's dependencies in `./useQuery`, and a
   * provider rebuilt per render would refetch every node forever. The session
   * travels on each call rather than inside the provider, so one provider per
   * host surface serves every session it shows.
   */
  dataProvider: DataProvider;

  /**
   * What this panel's interactions do — selecting an event, opening a place in
   * the project, and the two optional disclosure and filter reports.
   *
   * Host surfaces supply the host form, `PanelHostActions` —
   * `selectEvent(eventId, coordinates?)` and `openSource(location)`, the
   * contract the DevTools panel and the editor webview implement. The view
   * form (`onSelectEvent`/`onOpenSource`) is accepted as well and behaves
   * identically.
   *
   * The views receive the view form through the action context, and the head's
   * two plain callbacks are wired to the host form (see {@link PanelHost}).
   * Both are keyed on the callbacks' own identities rather than on this
   * object's, so a host may pass a freshly built object on every render without
   * re-rendering a view — as long as the callbacks inside it are stable.
   */
  actions: PanelActions;

  /**
   * The event the host surface has selected, when the surface drives the
   * panel's selection itself — typically from the event its details drawer is
   * showing.
   *
   * Three readings, so a surface can say each thing it may mean:
   *
   * - **omitted or `undefined`** — the panel keeps the selection itself: every
   *   selection a view or an evidence chip reports becomes the panel's current
   *   one, and every view marks it. This is the default, and it needs nothing
   *   from the surface beyond the `selectEvent` it already implements.
   * - **a string** — that event is the panel's selection, whatever a view last
   *   reported. Reports still reach the surface's `selectEvent`, which is where
   *   a surface that drives the selection updates this prop. When the id is the
   *   one a view just reported, the coordinates that view held travel with it,
   *   so views keyed by trace and span keep matching.
   * - **`null`** — the surface has explicitly cleared the selection (its drawer
   *   closed, say): nothing is marked until the prop changes again.
   *
   * A blank string names no event and reads as `null`.
   */
  selectedEventId?: string | null | undefined;

  /**
   * The token value set to render, forwarded to the theme root untouched.
   *
   * Omitted, the shell applies the product default. Resolving a host signal —
   * a DevTools theme name, an editor body class — into a theme belongs to the
   * host surface that owns that API; `../tokens/theme` carries the two
   * translations.
   */
  theme?: PanelTheme | undefined;

  /**
   * Additional class names for the theme root, for positioning the panel inside
   * its host frame.
   *
   * Composition, never an escape hatch for a visual value: a class named here
   * is defined against `--dg-*` tokens like every other class in this package.
   */
  className?: string | undefined;

  /** An `id` for the theme root, for a host that needs to reference it. */
  id?: string | undefined;
}

/**
 * Renders a validated panel specification.
 *
 * The theme root, the four ambient contracts, the fallback notice when the
 * document carries one, the head, the layout, and the version live region — in
 * that order and nothing else. No write to the specification, one piece of
 * state — the panel's shared selection — and one effect, which carries keyboard
 * focus into a replaced panel (see "Focus survives a panel replacement" in this
 * module's header) and writes no state. Its other hooks are the memos described
 * in this module's header, which keep an unrelated host render from reaching
 * the views, the refs that effect reads, and the one key on the panel column,
 * which keeps a view from outliving its session or panel.
 *
 * Seven details are decisions rather than mechanics:
 *
 * - **The panel has one selection, and the host owns it.** Every view that
 *   draws captured events reads it from the selection context and marks the
 *   items that stand for it, so a timeline bar, a flame cell, a table row, a
 *   log line and an evidence chip for one span are selected together, and
 *   selecting one elsewhere moves every mark — an evidence chip selects the
 *   events it cites. A report from any view or chip is recorded before the
 *   surface's own `selectEvent` runs; a surface that drives the selection from
 *   its drawer passes `selectedEventId` instead (see
 *   {@link PanelHostProps.selectedEventId}). A recorded selection belongs to
 *   the panel it was made in and is dropped with it.
 *
 * - **Queries are addressed to the document's own session.** The session
 *   context carries `spec.sessionId` and nothing else: not a session the host
 *   surface happens to have selected, and not one remembered by the provider.
 *   A reopened session's panel therefore reads its own capture even while the
 *   surface is bound to a newer one, and a panel for another session — or
 *   another panel, or another generation of this one — remounts every view the
 *   moment it is swapped in, so each starts from its first page under the new
 *   session and nothing it drew for the previous capture is shown or paged on.
 * - **The head's callbacks are wired, not re-implemented.** `../layout/SummaryHeader`
 *   imports nothing from this folder by design, so it declares two plain
 *   callbacks over the schema's own citation and location types — the host
 *   form's `selectEvent(eventId, coordinates)` and `openSource(location)`.
 *   For a surface that supplied the host form they are its own members, passed
 *   through; for one that supplied the view form they are the compatibility
 *   adapter's, whose `openSource` is the surface's `onOpenSource` itself.
 *   Either way the guarantee that matters at the far end of the click-to-source
 *   chain holds: what a hypothesis suggested is what the host receives, the
 *   same object.
 * - **The views read the view form.** The action context carries
 *   `onSelectEvent`/`onOpenSource` — the names the components call — adapted
 *   from the host form when that is what the surface supplied, so no component
 *   knows which surface it is in.
 * - **The outline is stated once, here.** The title renders at
 *   {@link PANEL_TITLE_HEADING_LEVEL} and the layout's top-level nodes one level
 *   below it, at {@link LAYOUT_HEADING_LEVEL}; `./NodeRenderer` carries the level
 *   down, one step per titled container, into every container's own heading as
 *   well as every labelled leaf's.
 * - **An empty layout is a state, not a gap.** A validated specification may
 *   carry no views, so the body renders the library's empty state with a
 *   neutral sentence — never a blank area, and never an error, which is what a
 *   failed *validation* looks like and this is not.
 * - **A replaced panel keeps the reader's place.** A later generation is
 *   stated beside the unchanged title and announced once, politely, and focus
 *   that was inside the outgoing panel lands on the same node's heading in the
 *   new one, or on its title — never on `<body>`, and never taken from
 *   anywhere outside the panel.
 *
 * @param props See {@link PanelHostProps}.
 * @returns The whole panel: theme root, contexts, notice, head and layout.
 *
 * @example A host surface mounting one session's current panel.
 * ```tsx
 * <PanelHost
 *   spec={currentPanel}
 *   dataProvider={surfaceDataProvider}
 *   actions={hostActions}
 *   theme={resolvedTheme}
 * />
 * ```
 */
export function PanelHost(props: PanelHostProps): ReactElement {
  const { spec, dataProvider, actions, selectedEventId, theme, className, id } = props;
  const { sessionId, title, summary, layout, panelVersion } = spec;
  const supersedesPrevious = spec.supersedes !== undefined;
  const panelKey = panelIdentityKey(spec);

  // The id of the head's visible title, which also names the shell's scroll
  // region. Generated once per mounted host rather than per document: the head
  // remounts with every replaced panel (it sits in the keyed column below), and
  // handing each new title the same id keeps the region's `aria-labelledby`
  // resolving to whichever title is on screen. `useId` keeps two hosts on one
  // page — the editor mirrors the DevTools panel — from sharing it.
  const titleId = useId();

  // The selection the views and the head reported, with the panel it was made
  // in. Recording a selection equal to the current one keeps the recorded
  // object, so a repeated click re-renders nothing.
  const [recorded, setRecorded] = useState<RecordedSelection | undefined>(undefined);
  const recordSelection = useCallback(
    (selection: PanelSelection): void => {
      setRecorded((previous) =>
        previous !== undefined &&
        previous.panelKey === panelKey &&
        sameSelection(previous.selection, selection)
          ? previous
          : { panelKey, selection },
      );
    },
    [panelKey],
  );

  // The panel's current selection: the surface's when it drives one, and
  // otherwise the last one reported in THIS panel — a selection made in another
  // session, panel or generation is never carried into this one. A driven id
  // keeps the coordinates of the report that named it, so a view that matches
  // by trace and span keeps matching; any other driven id stands alone.
  const recordedHere = recorded?.panelKey === panelKey ? recorded.selection : undefined;
  const selection = useMemo<PanelSelection | undefined>(() => {
    if (selectedEventId === undefined) {
      return recordedHere;
    }

    if (selectedEventId === null || selectedEventId.trim() === '') {
      return undefined;
    }

    return recordedHere?.eventId === selectedEventId ? recordedHere : { eventId: selectedEventId };
  }, [selectedEventId, recordedHere]);

  // What the selection context carries: a holder whose presence tells a view it
  // is inside a host (and so must not keep a selection of its own), and whose
  // identity changes only when the selection does.
  const selectionState = useMemo<PanelSelectionState>(() => ({ selection }), [selection]);

  // The supplied callbacks, flattened out of whichever form the surface used:
  // one required pair is set and the other is `undefined`, and the optional
  // pair is shared by both forms.
  const hostForm = isPanelHostActions(actions);
  const suppliedSelectEvent = hostForm ? actions.selectEvent : undefined;
  const suppliedOpenSource = hostForm ? actions.openSource : undefined;
  const suppliedOnSelectEvent = hostForm ? undefined : actions.onSelectEvent;
  const suppliedOnOpenSource = hostForm ? undefined : actions.onOpenSource;
  const { onExpand, onFilterChange } = actions;

  // Both action forms, keyed on the callbacks rather than on the object that
  // carried them. A host that rebuilds `actions` on every render from stable
  // callbacks — the natural way to write it — then changes nothing any view
  // reads, and a host that genuinely swaps a callback still reaches every
  // consumer. The supplied form keeps its callbacks as they are and the other
  // is its adaptation, so what a view or the head reports is what the host
  // receives, location by reference.
  //
  // Each form's selection member records the report as the panel's shared
  // selection before the surface's own callback runs (see
  // `withSelectionRecording`); the recorder is stable for as long as the panel
  // is the same one, so a re-delivered panel still changes nothing a view reads.
  const forms = useMemo(
    () =>
      withSelectionRecording(
        panelActionForms({
          selectEvent: suppliedSelectEvent,
          openSource: suppliedOpenSource,
          onSelectEvent: suppliedOnSelectEvent,
          onOpenSource: suppliedOnOpenSource,
          onExpand,
          onFilterChange,
        }),
        recordSelection,
      ),
    [
      suppliedSelectEvent,
      suppliedOpenSource,
      suppliedOnSelectEvent,
      suppliedOnOpenSource,
      onExpand,
      onFilterChange,
      recordSelection,
    ],
  );
  const viewActions = forms.view;
  const selectEvent = forms.host?.selectEvent;
  const openSource = forms.host?.openSource;

  // The head, re-rendered only when what it draws or what it reports to has
  // changed. It reports through the host form — `selectEvent(eventId,
  // coordinates)` and `openSource(location)` — whose members are stable for as
  // long as the supplied callbacks are. It marks the evidence chips that cite
  // the panel's shared selection, handed in as the bare id because the head
  // imports nothing from this folder; the id is a string, so the head
  // re-renders when a different event is selected and not otherwise. The
  // generation travels as the two primitives the document carries — its
  // number and whether it names a predecessor — and the head decides whether
  // to state it, so a first version renders exactly as before. The title takes
  // the id the shell's scroll region is labelled by.
  const selectedId = selection?.eventId;
  const head = useMemo<ReactElement>(
    () => (
      <SummaryHeader
        title={title}
        summary={summary}
        version={{ current: panelVersion, supersedes: supersedesPrevious }}
        headingLevel={PANEL_TITLE_HEADING_LEVEL}
        selectEvent={selectEvent}
        selectedEventId={selectedId}
        openSource={openSource}
        className={SUMMARY_CLASS}
        titleId={titleId}
      />
    ),
    [
      title,
      summary,
      panelVersion,
      supersedesPrevious,
      selectEvent,
      selectedId,
      openSource,
      titleId,
    ],
  );

  // The layout, rendered once per `spec.layout` value. Handing React the very
  // same element objects on a later render is what lets it skip every node
  // beneath: nothing a host render changes reaches a table or an SVG view
  // unless it changed a context that view reads. A new specification brings a
  // new `layout` array, so a replaced panel is always re-rendered in full.
  const body = useMemo<ReactNode>(
    () =>
      layout.length > 0 ? (
        renderPanelNodes(layout, { headingLevel: LAYOUT_HEADING_LEVEL })
      ) : (
        <EmptyState
          message={EMPTY_LAYOUT_MESSAGE}
          icon={<LayoutTemplate className={ICON_CLASS} />}
        />
      ),
    [layout],
  );

  // Focus across a replacement (see "Focus survives a panel replacement" in
  // this module's header). Refs, not state: none of this is rendered, and
  // recording where focus sits must never re-render a panel.
  //
  // `columnRef` is the mounted column; `focusRef` is where focus was last seen
  // inside a column, until the reader deliberately takes it elsewhere; and
  // `drawnLayoutRef` is the layout the mounted column was drawn from, so the
  // node a lost element sat in can be matched into the next layout by id.
  const columnRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<ColumnFocus | null>(null);
  const drawnLayoutRef = useRef<readonly PanelNode[]>(layout);
  // Ends the watch that keeps a restored focus target on screen while the new
  // column's views load (see `keepRestoredFocusInView`); `null` when none runs.
  const stopFocusWatchRef = useRef<(() => void) | null>(null);

  // Focus arriving anywhere in the column — `onFocus` is React's `focusin` —
  // is recorded against that column.
  const recordColumnFocus = useCallback((event: FocusEvent<HTMLDivElement>): void => {
    focusRef.current = { column: event.currentTarget, element: event.target };
  }, []);

  // Focus leaving an element of the column. Towards another element of the
  // same column, that element's own focus event records it; towards anything
  // else, the reader moved on. Towards nothing, the verdict waits one microtask
  // for the DOM to settle: an element still attached that no longer holds focus
  // was left on purpose (a click into empty space), while one that was removed
  // — the column itself being replaced — is a loss the effect below answers.
  const releaseColumnFocus = useCallback((event: FocusEvent<HTMLDivElement>): void => {
    const { currentTarget, target, relatedTarget } = event;
    const recorded = focusRef.current;

    if (recorded === null || recorded.column !== currentTarget) {
      return;
    }

    if (relatedTarget !== null) {
      if (!currentTarget.contains(relatedTarget)) {
        focusRef.current = null;
      }
      return;
    }

    queueMicrotask(() => {
      const current = focusRef.current;
      if (
        current !== null &&
        current.element === target &&
        target.isConnected &&
        target.ownerDocument.activeElement !== target
      ) {
        focusRef.current = null;
      }
    });
  }, []);

  // After a replaced column commits: focus that was inside the outgoing column,
  // and has fallen to `<body>` with it, moves into the new panel. Declared
  // before the layout bookkeeping below so it reads the outgoing layout, and a
  // passive effect so the new nodes' own focus keepers are installed first and
  // track the element focus lands on. Keyed on the identity and the layout: a
  // re-delivery keeps the column, which the column check turns into a no-op.
  useEffect(() => {
    const recorded = focusRef.current;
    const column = columnRef.current;

    if (recorded === null || column === null || recorded.column === column) {
      return;
    }

    // One answer per loss, whatever it turns out to be.
    focusRef.current = null;

    if (recorded.column.isConnected) {
      return;
    }

    const { activeElement, body: documentBody } = column.ownerDocument;
    const focusFellToBody =
      activeElement === null || activeElement === documentBody || !activeElement.isConnected;

    if (focusFellToBody) {
      // A watch left by an earlier replacement belongs to a column that is gone.
      stopFocusWatchRef.current?.();
      stopFocusWatchRef.current = null;

      const restored = restoreColumnFocus(column, recorded.element, drawnLayoutRef.current, layout);
      if (restored !== null) {
        stopFocusWatchRef.current = keepRestoredFocusInView(restored, column);
      }
    }
  }, [panelKey, layout]);

  // The layout the mounted column now shows, for the next replacement.
  useEffect(() => {
    drawnLayoutRef.current = layout;
  }, [layout]);

  // A host that unmounts ends any watch still keeping a restored target in view.
  useEffect(
    () => () => {
      stopFocusWatchRef.current?.();
      stopFocusWatchRef.current = null;
    },
    [],
  );

  return (
    <PanelShell theme={theme} className={className} id={id} labelledBy={titleId}>
      {/* All four contracts wrap the head as well as the layout. The head is
          handed its two callbacks directly, because it imports nothing from
          this folder, but a component it composes still reads the ambient
          contracts — and a tree where only part of the panel can reach the host
          is the harder failure to notice. Each value is stable for as long as
          what it stands for is: the injected provider, the document's session
          string, the memoized view form of the actions, and the selection,
          which changes identity only when a different event is selected. */}
      <DataProviderContext.Provider value={dataProvider}>
        <PanelSessionContext.Provider value={sessionId}>
          <PanelActionsContext.Provider value={viewActions}>
            <PanelSelectionContext.Provider value={selectionState}>
              {/* Keyed on the document's session, id and generation (see
                  `panelIdentityKey`): a panel for another session, or another
                  panel, remounts every view beneath, so no page, offset or
                  filter a view accumulated survives into a capture it was not
                  drawn from. The shell and the four providers stay mounted.
                  The focus handlers record where focus sits inside it, so the
                  effect above can carry focus into the column that replaces
                  it. */}
              <div
                key={panelKey}
                ref={columnRef}
                className={PANEL_CLASS}
                onFocus={recordColumnFocus}
                onBlur={releaseColumnFocus}
              >
                {/* Above the summary, so the provenance of what follows is read
                    first. The explicit `=== true` is the reading `PanelMeta`
                    prescribes: the flag is absent on an ordinary generated
                    panel and is never defaulted on parse. */}
                {spec.meta?.fallback === true ? renderFallbackBanner() : null}

                {head}

                <div className={BODY_CLASS}>{body}</div>
              </div>

              {/* Outside the keyed column, so it is the same element before and
                  after a replacement and its text change is what assistive
                  technology announces. `aria-live` without `role="status"`: it
                  is a notification channel, not a status the panel reports, and
                  it adds no status to the ones the views and the fallback
                  banner already expose. After the column, so the column stays
                  the viewport's first child. */}
              <Text
                as="div"
                className={VISUALLY_HIDDEN_CLASS}
                aria-live="polite"
                aria-atomic="true"
              >
                {versionAnnouncement(panelVersion, supersedesPrevious)}
              </Text>
            </PanelSelectionContext.Provider>
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>
    </PanelShell>
  );
}
