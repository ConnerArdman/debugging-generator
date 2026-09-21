/**
 * `EmptyState` — the "there is nothing of that kind here" structural state of
 * the in-repo design system (AAP 0.6.2, 0.6.3, 0.6.4).
 *
 * AAP 0.6.2 obliges every catalogued visualization component to declare three
 * states, not one: an empty state carrying a node-specific message, a loading
 * state while the host's provider resolves its query, and an error state
 * carrying the query and a retry action. This module is the first of those
 * three, and the section closes with the renderer contract that decides how
 * seriously to take it — a node the renderer cannot fill must never leave "a
 * blank area". This component is what stands in that space.
 *
 * ## It sits on the normal path, not the exceptional one
 *
 * A generated panel composes catalogued nodes against whatever a single capture
 * happened to contain, and the two rarely line up exactly: a question about
 * repeated component work produces no database evidence, a question about a
 * single interaction produces no state-transition evidence, and a node whose
 * filter is narrower than the data is empty by construction rather than by
 * fault. Every one of those is a correct, successful render with nothing to
 * draw. That is why this component carries no apology, no warning colour and no
 * retry affordance of its own: it explains an absence, while `ErrorState`
 * explains a failure. Conflating the two teaches a reader to distrust panels
 * that are working perfectly.
 *
 * A blank region would be worse than either, because it is indistinguishable
 * from a component that failed silently — which is the reading AAP 0.6.2's
 * "never a blank area" rule exists to prevent.
 *
 * ## Tier 3, and the narrowest possible composition
 *
 * It composes exactly one thing from this package: the `Text` primitive, for
 * both lines of copy. It imports no layout primitive, no visualization
 * component, no host module, no panel schema, no transport and no icon library
 * — the glyph and the action arrive from the caller as nodes, already
 * configured. So the only thing above this file in the package's dependency
 * order is whoever renders it, which is what lets all thirteen visualization
 * components and the host layer use it without any risk of a cycle
 * (AAP 0.2.2, 0.6.2).
 *
 * ## The caller owns every word
 *
 * There is no default message, and there is deliberately no example of one
 * anywhere in this file. The message is the product's voice for "this capture
 * has nothing of that kind", and it is specific to the node that renders it, so
 * the node writes it. Two consequences follow, and both are requirements rather
 * than preferences:
 *
 *   1. AAP 0.5.4 forbids any knowledge of a target application inside the
 *      product. Empty-state copy is the single most likely place for a
 *      component, service, table or route name from an inspected project to
 *      leak into shipped code, and the copy is the one thing this file does not
 *      contain — so there is nothing here for the gate to find.
 *   2. The wording a caller supplies names, in generic product vocabulary, what
 *      was looked for and not found. It describes the evidence class the node
 *      draws, never a value read out of a capture and never a fragment of a
 *      developer's own codebase.
 *
 * The same shape serves the last rung of AAP 0.6.4's degradation ladder — the
 * "placeholder flagged as a gap" a panel falls back to when the catalog has no
 * component for what was asked for — which is why `message` alone is a complete
 * call: no icon, no title and no action are required to render.
 *
 * ## No heading element, in any form
 *
 * The optional title is body text with a raised weight, not a heading. An empty
 * state appears wherever a generated panel puts the node that rendered it,
 * nested at a depth this file cannot know, so emitting an `h*` here would
 * insert an outline level that the `Heading` primitive and `layout/Section`
 * never sanctioned — and a skipped or duplicated level is invisible on screen
 * while being exactly what a screen-reader user navigates by. Outline decisions
 * belong to the components that own the surrounding structure (AAP 0.6.4).
 *
 * ## No live region, and why that is the accessible choice
 *
 * This component declares no `role`, no `aria-live` and no `aria-busy`. It is
 * static content sitting inside a region the panel already labelled, and a
 * `role="status"` here would make every unrelated re-render of a panel announce
 * itself again. The three states divide that responsibility once, so exactly
 * one of them can speak at a time: `LoadingState` owns the busy announcement
 * while a query is in flight, `ErrorState` owns the assertive alert when one
 * fails, and this component stays silent and simply reads in place. A caller
 * with a genuine reason to announce an absence can still pass the ARIA
 * attributes through, which keeps the decision where the context is.
 *
 * ## Appearance is class names, and nothing else
 *
 * Not one colour, length, font or radius appears in this module, and there is
 * no inline `style` object, no width, no height and no minimum height: the
 * container's geometry and every visual value belong to
 * `../styles/components.css`, which resolves them to `--dg-*` tokens
 * (AAP 0.6.3, 0.6.4). The class contract this file DECLARES, and that
 * `components.css` must implement:
 *
 *   dg-empty-state              the block — a centred column on
 *                               `--dg-surface-base`, or on
 *                               `--dg-surface-elevated` inside
 *                               `--dg-border-subtle` where the node draws its
 *                               own card; `--dg-space-*` for padding and for
 *                               the gap between the parts
 *   dg-empty-state__icon        the decorative glyph box, in
 *                               `--dg-text-secondary` so the glyph reads one
 *                               step below the copy it accompanies
 *   dg-empty-state__title       the optional first line, which `Text` already
 *                               renders at the `--dg-text-md` role and the
 *                               raised weight
 *   dg-empty-state__message     the required explanation, which `Text` already
 *                               renders at `--dg-text-sm` in `--dg-text-muted`
 *   dg-empty-state__action      the optional control box, spaced from the copy
 *                               by `--dg-space-*`
 *
 * `dg-icon` is reused from `../styles/base.css` — the caller puts it on the
 * glyph — and is never redefined here or in a component rule.
 */

import clsx from 'clsx';
import type { HTMLAttributes, ReactElement, ReactNode } from 'react';

import { Text } from './Text';

/**
 * Whether a node would render anything a reader could perceive.
 *
 * `null`, `undefined` and both booleans render nothing in React, and the empty
 * string renders no text, so none of them justifies an icon box or an action
 * box: an empty wrapper still carries that wrapper's gap and padding, which
 * shows up as an unexplained blank strip above or below the copy. `0` is
 * renderable and stays renderable, and no value is ever coerced into visible
 * text — AAP 0.6.4's defensive rule is that "null" and "undefined" must never
 * reach the screen as words.
 *
 * The predicate is local on purpose. It is three comparisons over a React type
 * and nothing about it is design-system vocabulary, so it stays private to this
 * module rather than becoming a shared utility that the primitives layer would
 * have to import from somewhere.
 *
 * @param node The slot content a caller supplied, if any.
 * @returns `true` when the node contributes visible or announced content.
 */
function isRenderable(node: ReactNode): boolean {
  return node !== null && node !== undefined && typeof node !== 'boolean' && node !== '';
}

/**
 * The HTML attributes {@link EmptyStateProps} inherits for its container.
 *
 * A named alias rather than an inline `Omit<…>` in the `extends` clause, so the
 * reason for each removal can be documented once on the interface below and the
 * declaration stays one readable line. It is intentionally not exported: the
 * public surface of this module is the component and its props, and an alias of
 * React's own attribute type is not part of the design system's vocabulary.
 */
type ContainerAttributes = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'title'>;

/**
 * The inputs of one empty state.
 *
 * Extending React's `HTMLAttributes` is what keeps this interface short while
 * leaving the element fully addressable: `id`, every `aria-*` attribute, every
 * `data-*` attribute and the event handlers reach the rendered container
 * through `...rest` with their standard types, without being enumerated here.
 *
 * Two members of that set are removed:
 *
 *   `children`  The parts of an empty state are named props in a fixed order,
 *               so arbitrary children would be a second, unordered way to put
 *               content in the same box.
 *   `title`     Repurposed below as the rendered first line. Omitting the HTML
 *               attribute of the same name states that at type level instead of
 *               silently swallowing a standard attribute, and a hover
 *               explanation belongs to the `Tooltip` primitive. `Text` removes
 *               `color` from its own attribute set for the same reason.
 *
 * Every optional member states `| undefined` explicitly: `exactOptionalPropertyTypes`
 * is on repository-wide, and a caller forwarding a value it may not have —
 * `title={group.label}`, `icon={node.icon}` — has to stay legal.
 */
export interface EmptyStateProps extends ContainerAttributes {
  /**
   * The explanation, and the only required prop.
   *
   * The caller owns this wording completely: there is no default, and this file
   * supplies no example of one. Write one sentence that names, in generic
   * product vocabulary, the class of evidence this node draws and states that
   * the capture holds none of it — the reader's next question is "did I capture
   * the wrong thing?", and this sentence is what answers it. Never interpolate
   * a symbol, path, table or route name read out of an inspected project
   * (AAP 0.5.4).
   *
   * Rendered as body text through `Text` at the `--dg-text-sm` role in
   * `--dg-text-muted`, because it explains rather than announces.
   */
  message: string;

  /**
   * An optional first line above the message — a short label for the absence,
   * for the nodes whose message alone would read as a wall of prose in a dense
   * column.
   *
   * Rendered through `Text` at the `--dg-text-md` role with the raised weight,
   * as a paragraph. It is NOT a heading and no heading element is emitted for
   * it, for the reason this module's header records: an empty state cannot know
   * its own outline depth. Omit it whenever the message stands on its own.
   */
  title?: string | undefined;

  /**
   * A decorative glyph above the copy.
   *
   * It is rendered inside a wrapper this component marks `aria-hidden="true"`,
   * so it is never part of the accessible name — the copy carries the whole
   * meaning, and the glyph reinforces it (AAP 0.6.4: colour and iconography are
   * never the sole indicator).
   *
   * Pass the glyph already carrying the global `dg-icon` class —
   * `icon={<SomeGlyph className="dg-icon" />}` — so it takes its `1em` square
   * and `currentColor` from `../styles/base.css` and scales with the type role
   * around it. Never pass an icon library's numeric `size` or `color` prop:
   * those are hardcoded values, which AAP 0.6.4 forbids. This module imports no
   * icon library at all; the glyph is the caller's choice.
   *
   * Omitted, absent or blank, no wrapper is rendered and the column starts at
   * the copy.
   */
  icon?: ReactNode | undefined;

  /**
   * An optional affordance below the copy, as an already-configured node.
   *
   * It is a node rather than a label plus a callback so that this file never
   * invents user-facing copy: the caller passes a `Button` it has already
   * labelled and wired — the same primitive every other control in the product
   * uses (AAP 0.6.4 permits no raw `<button>` above the primitives layer) — and
   * this component only positions it. A `sm` `secondary` or `ghost` button suits
   * the density of a panel section; a primary fill would make an absence look
   * like the surface's main action.
   *
   * The action is entirely the caller's: this component renders it, raises
   * nothing itself, and never fetches, retries or inspects a data provider
   * (AAP 0.4.2). Omitted, the state is purely informational, which is the form
   * AAP 0.6.4's "flagged as a gap" placeholder uses.
   */
  action?: ReactNode | undefined;

  /**
   * Extra classes composed after `dg-empty-state`, for the layout the
   * surrounding node owns — the column span of a section, an alignment a
   * specific container needs.
   *
   * It is composition, never an escape hatch for visual values: any class named
   * here is defined in `../styles/components.css` against `--dg-*` tokens like
   * every other class in this package.
   */
  className?: string | undefined;
}

/**
 * Renders the empty state of a node: an optional glyph, an optional title, the
 * required message, and an optional action, in that order.
 *
 * Presentational and pure — no state, no effects, no hooks, nothing read from
 * the document while rendering, and no memoization. It re-renders with its
 * parent deliberately: this package's own render behaviour is something the
 * product measures and reports on, so a primitive here does not smooth it over.
 *
 * Nothing is implied on the reader's behalf. No `role`, no `tabIndex`, no
 * `aria-live` and no `aria-hidden` is set on the container, and every attribute
 * the caller passes reaches it unchanged, so an empty state is never silently
 * renamed, hidden from assistive technology or made focusable. The one
 * `aria-hidden` this component does set is on the glyph box, where it belongs.
 *
 * @param props The props documented on {@link EmptyStateProps}.
 * @returns The container element with the parts the caller supplied — no
 *   wrapper for an omitted part, no inline style, no geometry.
 *
 * @example
 * // The complete form. `message` is the caller's own sentence; the glyph and
 * // the control arrive already configured.
 * <EmptyState
 *   icon={<SomeGlyph className="dg-icon" />}
 *   title={sectionLabel}
 *   message={nodeSpecificSentence}
 *   action={
 *     <Button size="sm" onClick={onRetryCapture}>
 *       {retryLabel}
 *     </Button>
 *   }
 * />
 *
 * @example
 * // The minimal form, and the one AAP 0.6.4's gap placeholder uses.
 * <EmptyState message={nodeSpecificSentence} />
 */
export function EmptyState(props: EmptyStateProps): ReactElement {
  const { message, title, icon, action, className, ...rest } = props;

  // The caller's attributes are spread first so a passthrough can never
  // displace the composed class name, and the optional parts are guarded
  // individually so an omitted one leaves no empty box behind (see
  // `isRenderable`). The order below is the contract: glyph, title, message,
  // action.
  return (
    <div {...rest} className={clsx('dg-empty-state', className)}>
      {isRenderable(icon) ? (
        <span className="dg-empty-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {title !== undefined && title !== '' ? (
        <Text as="p" size="md" weight="medium" className="dg-empty-state__title">
          {title}
        </Text>
      ) : null}
      <Text as="p" size="sm" tone="muted" className="dg-empty-state__message">
        {message}
      </Text>
      {isRenderable(action) ? <div className="dg-empty-state__action">{action}</div> : null}
    </div>
  );
}
