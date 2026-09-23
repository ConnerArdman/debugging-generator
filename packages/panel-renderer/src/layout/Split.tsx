/**
 * `Split` — the pane container of the layout tier of `@debuggen/panel-renderer`.
 *
 * ## What this layout primitive is
 *
 * The renderer side of the panel schema's `split` container: two or more panes
 * read *against* each other rather than one after another — a timeline beside
 * the table that lists the same spans, a tree beside the counts taken from it.
 * AAP 0.6.2 lists it among the "layout primitives every panel composes from (no
 * panel hand-rolls layout)", so this module is the only way anything in this
 * package or in either host surface puts two nodes side by side. A component
 * that reached for its own flex container instead would take its geometry out
 * of the token scale, out of the stylesheet and out of review.
 *
 * Its sibling, the flow primitive, arranges a *sequence*: items one after
 * another along one axis, sized by their content. This one divides the
 * available space between panes that are peers, which is why panes get a grow
 * target of their own here and items do not there.
 *
 * ## The package's responsive seam
 *
 * AAP 0.6.4 requires "responsive behaviour through `Split`/`Stack`", and this
 * is the module that requirement lands on. It is a real requirement rather than
 * a nicety: the Chrome DevTools panel is routinely docked at around four
 * hundred pixels wide, so a division that insisted on two panes side by side
 * would either overflow the surface or squeeze both panes into unreadable
 * strips. {@link SplitProps.collapse} — on by default for a horizontal
 * division — is what prevents that, and it is expressed declaratively: the
 * component adds one variant class and the stylesheet owns the width at which
 * the panes fall into a single column.
 *
 * The stylesheet does it intrinsically, by letting the panes wrap once they no
 * longer fit their shared flex basis, which is better than a breakpoint in two
 * ways that matter here: the threshold follows the *container* rather than the
 * viewport, so a split nested inside another split collapses when its own share
 * of the space runs out; and the design system declares no breakpoint token, so
 * a viewport width written into a rule would be a hardcoded value with no
 * token behind it (AAP 0.6.3, 0.6.4).
 *
 * Three implementations are deliberately absent, and their absence is the
 * design. There is no `ResizeObserver`, no width held in state and no
 * `matchMedia` listener: any of them would make a presentational container
 * stateful, would re-render a panel's whole subtree on every drag of the
 * DevTools splitter, and would be untestable under `happy-dom`, which reports
 * every element as zero-sized. There is also no length-bearing media query
 * anywhere in this package to hook into — `../styles/base.css` owns the single
 * `@media` rule in the package (`prefers-reduced-motion`) and declares no width
 * query at all, precisely so that all width response stays intrinsic and lives
 * in `../styles/components.css`.
 *
 * ## Spacing is a token step, never a length
 *
 * {@link SplitProps.gap} is an *index* into the design system's eight-step
 * space scale (AAP 0.6.3), shared with the flow primitive, which declares the
 * vocabulary. A length cannot be expressed through this component at all: the
 * fix for a separation the scale cannot state is a change to the token source,
 * never an inline value (AAP 0.6.4). The default is one step wider than the
 * flow primitive's, because panes that sit beside each other need more
 * separation to read as distinct regions than items stacked in one column do.
 *
 * ## The one inline value, and why it is allowed
 *
 * This module writes no inline style except {@link SplitProps.weights}, which
 * it publishes as the component-scoped custom property `--dgc-split-weight` on
 * the pane it applies to. That is this package's sanctioned mechanism for a
 * value only the component knows — a `--dgc-<role>` property set inline and
 * consumed in `../styles/components.css` with a fallback — and the value here
 * is a unitless flex factor, which is a relational structural value and not a
 * design decision. No other inline value is permitted from this file: no width,
 * no flex basis, no percentage, no colour, no length.
 *
 * ## Class-name contract implemented by `../styles/components.css`
 *
 * The stylesheet is the implementing side; this table is its specification for
 * this block, in the package's block / `__element` / `--variant` convention. An
 * omission there is an unstyled or mis-stacked container here, so the two are
 * read together.
 *
 * | Class                                                               | Role                                                          |
 * | ------------------------------------------------------------------- | ------------------------------------------------------------- |
 * | `dg-split`                                                          | block: the container, and the carrier of every variant         |
 * | `dg-split__header`                                                  | element: the optional heading and its supporting line          |
 * | `dg-split__panes`                                                   | element: the flex container that holds the panes               |
 * | `dg-split__pane`                                                    | element: one pane, the stylesheet's grow and shrink target     |
 * | `dg-split--horizontal`, `dg-split--vertical`                        | variant: the axis the panes are divided along                  |
 * | `dg-split--gap-0` … `dg-split--gap-7`                               | variant: the space step between panes, one class per step      |
 * | `dg-split--align-start`, `-center`, `-end`, `-stretch`, `-baseline` | variant: cross-axis alignment of the panes                     |
 * | `dg-split--collapse`                                                | variant: the panes may fall into a single column when narrow   |
 *
 * And one component-scoped custom property:
 *
 * - `--dgc-split-weight` — a unitless positive factor, set inline on a
 *   `dg-split__pane` only when {@link SplitProps.weights} supplied a usable
 *   number for that pane's position. The stylesheet consumes it twice, both
 *   declared *after* the `flex` shorthand so they override it: as
 *   `flex-grow: var(--dgc-split-weight, 1)` and as the multiplier of the shared
 *   pane basis. Multiplying both is what makes a pane's size proportional to
 *   its weight rather than merely greedier for the leftover space, and the `1`
 *   fallback is what makes unweighted panes equal — a pane with no weight of
 *   its own renders exactly as it would if weights did not exist.
 *
 * Two facts about those rules matter to anyone reading the markup below.
 * First, every variant class sits on the **block** and is resolved onto
 * `.dg-split__panes` (and through it onto `.dg-split__pane`) with a child
 * selector, which is what lets a division's own header keep its spacing however
 * its panes are arranged, and confines each rule to one level so a nested
 * division is arranged by its own variants and never by its parent's. Second,
 * `.dg-split__panes` is rendered unconditionally, so the stylesheet has one
 * stable selector target and a test one stable structure — with or without a
 * title, with or without anything to put in the panes.
 *
 * `dg-split--collapse` carries the responsive obligation described above: it
 * must degrade a horizontal division to a single column at narrow widths. The
 * global utilities a caller may pair with this component are declared once in
 * `../styles/base.css` and are reused, never redefined here.
 *
 * ## Naming a division, and when not to
 *
 * Identical to the flow primitive's treatment, deliberately: a title makes the
 * container a labelled region — the element becomes a `section` whose
 * `aria-labelledby` resolves to the heading rendered inside it — and without a
 * title it stays a plain `div` carrying neither a role nor a name. That is the
 * correct outcome rather than a gap: an unnamed landmark is an ARIA
 * anti-pattern, and a default name invented inside a library would be wording
 * the product never chose, which AAP 0.5.4 forbids this file to ship. The
 * heading is rendered through the heading primitive and the supporting line
 * through the text primitive, never as a raw element, because AAP 0.6.4 puts
 * library primitives ahead of the raw elements they wrap.
 *
 * The pane wrappers carry no ARIA role of any kind. They are presentational
 * boxes that exist so the stylesheet has something to grow, and a role on each
 * would announce structure the panel's author never authored. Because they are
 * emitted in the order the children were given, the reading order of a
 * collapsed column is the same as the reading order of an expanded row —
 * accessibility ahead of visual fidelity, as AAP 0.6.4 ranks them.
 *
 * ## Position in the package
 *
 * A presentational container: no state, no effect, no memoization, no context
 * created and none consumed. It imports React, `clsx`, two primitives, the
 * geometry vocabulary of its own tier and one *type* from the panel schema —
 * and nothing else. In particular nothing from the host tier, so the layout
 * tier stays below it and the module graph stays acyclic, and the editor
 * webview can compose these containers with no data provider and no panel
 * actions in scope at all (AAP 0.1.2, 0.4.2). It reads no data, holds no query
 * and opens no transport of any kind: the schema's containers hold nodes rather
 * than evidence, so there is nothing for a division to fetch.
 *
 * @example Two panes read against each other, at the default separation
 * ```tsx
 * <Split>
 *   {left}
 *   {right}
 * </Split>
 * ```
 *
 * @example A wide pane beside a narrow one, pinned to the top of the row
 * ```tsx
 * <Split weights={[2, 1]} align="start">
 *   {chart}
 *   {legend}
 * </Split>
 * ```
 *
 * @example A labelled division stacked on the block axis, which never collapses
 * ```tsx
 * <Split direction="vertical" title={node.title} description={node.description}>
 *   {above}
 *   {below}
 * </Split>
 * ```
 *
 * @module
 */

import clsx from 'clsx';
import { Children, useId } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

// The axis vocabulary comes from the schema rather than from a union written
// here. AAP 0.6.2 fixes the direction of this dependency — "the renderer
// depends on the schema, never the reverse" — and importing the type is what
// makes a change to the authored vocabulary a compile error in this file
// instead of a silent mismatch between what a panel may say and what this
// component can render. It is a type-only import: nothing in this module needs
// the runtime tuple, and taking it would put a value-level dependency on the
// schema package into every bundle that renders a division.
import type { SplitDirection } from '@debuggen/panel-schema';

import { Heading } from '../primitives/Heading';
import type { HeadingLevel } from '../primitives/Heading';
import { Text } from '../primitives/Text';
// The space scale and the cross-axis vocabulary are declared once, by the flow
// primitive of this tier, and imported here rather than redeclared: two unions
// of the same name in two files would be two vocabularies the moment either
// one moved, and the folder has no seventh module to hold a shared set.
import type { SpaceStep, StackAlign } from './Stack';

/*
 * ---------------------------------------------------------------------------
 * Variant class tables
 * ---------------------------------------------------------------------------
 */

/**
 * The axis to its variant class, and the one place the axis semantics are
 * pinned.
 *
 * `'horizontal'` divides the space **along the horizontal axis**: the panes sit
 * beside each other, left to right in a left-to-right writing mode, which is a
 * flex *row*. `'vertical'` divides along the vertical axis: the panes sit one
 * above the other, which is a flex *column*. That reading matches the schema's
 * own description of the field, and it is stated here because the opposite
 * reading — naming the axis the panes are *stacked on* — is equally idiomatic
 * elsewhere and would transpose every generated panel without any test
 * necessarily noticing. This table emits the class; `../styles/components.css`
 * turns the class into a `flex-direction`, so the mapping exists in exactly two
 * places that are read together.
 *
 * A total `Record` over the union rather than a class name built from the prop
 * value: the union and the class list cannot drift apart, a typo is a compile
 * error instead of a silently missing rule, and the lookup yields `string`
 * rather than `string | undefined` under `noUncheckedIndexedAccess` — so no
 * cast is needed to hand it to `clsx`. Both tables below are written for the
 * same three reasons.
 */
const DIRECTION_CLASS: Record<SplitDirection, string> = {
  horizontal: 'dg-split--horizontal',
  vertical: 'dg-split--vertical',
};

/**
 * Space step to variant class, total over {@link SpaceStep}.
 *
 * Totality keeps the tier honest in both directions: a step added to the scale
 * without a class here fails the typecheck, and a class here that the
 * stylesheet does not implement is caught by reading this module's contract
 * table against `../styles/components.css`.
 */
const GAP_CLASS: Record<SpaceStep, string> = {
  0: 'dg-split--gap-0',
  1: 'dg-split--gap-1',
  2: 'dg-split--gap-2',
  3: 'dg-split--gap-3',
  4: 'dg-split--gap-4',
  5: 'dg-split--gap-5',
  6: 'dg-split--gap-6',
  7: 'dg-split--gap-7',
};

/** Cross-axis alignment to variant class, total over {@link StackAlign}. */
const ALIGN_CLASS: Record<StackAlign, string> = {
  start: 'dg-split--align-start',
  center: 'dg-split--align-center',
  end: 'dg-split--align-end',
  stretch: 'dg-split--align-stretch',
  baseline: 'dg-split--align-baseline',
};

/**
 * A style object that may also carry CSS custom properties.
 *
 * React's `CSSProperties` declares no index signature, so a literal holding a
 * `--dgc-*` key does not satisfy it. A pattern index signature over
 * `--${string}` widens the type by exactly the custom properties and nothing
 * else, which keeps the one inline value this component sets free of a cast —
 * no `as`, no `any`, no `Record<string, string>` escape hatch. File-local and
 * not exported, exactly as the chip primitive declares the same shape for its
 * own computed property.
 *
 * Nothing but a `--dgc-*` value may appear in an object of this type here. A
 * geometric or chromatic literal would be the hardcoded CSS value AAP 0.6.4
 * forbids, and a value the stylesheet can compute itself belongs in
 * `../styles/components.css` instead.
 */
type CssVariableStyle = CSSProperties & Record<`--${string}`, string>;

/**
 * Whether a string carries something to render.
 *
 * Absent, empty and whitespace-only are one case for every label this module
 * accepts: a title computed from data the caller may not have must leave the
 * container unnamed rather than produce a region whose accessible name
 * announces as nothing, and an empty heading element in the document outline is
 * worse than no heading at all. The predicate narrows, so the value can then be
 * handed to a primitive that declares `string` without `| undefined` and with
 * no cast.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * The inline style for one pane, or `undefined` when the pane has no usable
 * weight — which leaves the element with no `style` attribute at all and the
 * pane on the stylesheet's equal share.
 *
 * `noUncheckedIndexedAccess` makes the lookup `number | undefined`, which is
 * the honest type here for three separate reasons and not a formality: a caller
 * may pass no weights at all, may pass fewer weights than there are panes, and
 * — since the weights of a generated panel can be computed from a capture —
 * may pass a number that arithmetic turned into `NaN` or `Infinity`.
 *
 * Only a finite, strictly positive number survives, and each rejection is a
 * concrete failure avoided rather than a formality. `NaN` or `Infinity` would
 * make the stylesheet's `calc()` unresolvable, which drops the pane's flex
 * basis back to its initial value and would size that one pane by its content
 * while its siblings kept the scale. A negative factor is invalid for
 * `flex-grow` outright. Zero is rejected too, and deliberately: the weight
 * multiplies the pane's basis as well as its share of the free space, so a zero
 * would render a pane of zero width and silently hide whatever a panel put in
 * it — a view that does not render is never the right reading of an ambiguous
 * input (AAP 0.6.4). A caller that means "show only the other pane" composes
 * one pane instead of weighting this one to nothing.
 */
function paneStyle(weight: number | undefined): CssVariableStyle | undefined {
  if (weight === undefined || !Number.isFinite(weight) || weight <= 0) {
    return undefined;
  }

  // Published as a string because that is what a custom property is: CSS parses
  // the token itself, so the value must be the unitless number and nothing
  // more. `String` rather than a template literal to keep the conversion
  // explicit at the one point where a number leaves TypeScript for the cascade.
  return { '--dgc-split-weight': String(weight) };
}

/*
 * ---------------------------------------------------------------------------
 * The component
 * ---------------------------------------------------------------------------
 */

/**
 * Props of {@link Split}.
 *
 * Deliberately narrow, and closed against three kinds of prop on purpose.
 * There is no `style` prop and no length-bearing prop, because appearance is a
 * class name and spacing is a token step. There is no `ref`: no component in
 * this package is wrapped in `forwardRef`, and a container that exists to
 * arrange other nodes has nothing a caller needs to measure or focus. And
 * there is no data prop of any kind — no source, filter, sort, limit, query or
 * event callback — because the schema's containers carry no query (they hold
 * nodes, not evidence), so a container that accepted one would contradict the
 * contract it renders (AAP 0.2.3, 0.4.2, 0.6.2).
 *
 * Every optional property declares `| undefined` explicitly, which
 * `exactOptionalPropertyTypes` makes load-bearing rather than decorative: the
 * node dispatch above this tier forwards a container node's optional direction,
 * title and description straight through, and those arrive as
 * `SplitDirection | undefined` and `string | undefined`.
 */
export interface SplitProps {
  /**
   * The panes, in order. Each is wrapped in a pane element of its own so the
   * stylesheet has a grow target, and nothing is inserted between them — the
   * separation is a property of the container rather than a divider.
   *
   * Optional, and a single child is accepted: a division whose data yielded one
   * pane, or none, still renders, because the component above it must be able
   * to compose a layout before its queries have resolved and must not have to
   * branch around this one. How many panes a *panel* may author is the schema's
   * rule and is enforced where a panel is validated, not here.
   */
  children?: ReactNode | undefined;

  /**
   * The axis to divide along (see {@link DIRECTION_CLASS} for the semantics
   * this component pins).
   *
   * The default is load-bearing rather than a convenience: the schema leaves
   * the field optional and deliberately does not fill it in when a panel is
   * parsed, so the value a division assumes belongs to the side that renders
   * it, which is this component. A division with no stated axis is one whose
   * panes sit side by side.
   *
   * @default 'horizontal'
   */
  direction?: SplitDirection | undefined;

  /**
   * The space step between panes, as an index into the design system's
   * eight-step scale (see {@link SpaceStep}).
   *
   * The default is one step wider than the flow primitive's, because panes need
   * more separation than stacked items do to read as distinct regions rather
   * than as one wide surface.
   *
   * @default 4
   */
  gap?: SpaceStep | undefined;

  /**
   * Cross-axis alignment of the panes. The default fills the cross axis, so the
   * panes of a horizontal division are equally tall however much each contains
   * — which is what makes two views read as being *against* each other.
   *
   * @default 'stretch'
   */
  align?: StackAlign | undefined;

  /**
   * Optional proportional weights, applied to the panes **positionally**: the
   * first number weights the first pane, the second the second, and so on.
   *
   * Relative rather than absolute, so `[2, 1]` and `[4, 2]` describe the same
   * division and neither states a width: a pane's size is its weight's share of
   * the whole, which is why `[2, 1]` makes the first pane twice the second at
   * every container width. Shorter than the pane count is legal and leaves the
   * remaining panes at their equal share; a missing, non-finite or non-positive
   * entry is skipped the same way (see {@link paneStyle}). Omit the prop
   * entirely for equal panes, which is the common case.
   *
   * Weighting also moves the collapse threshold outward, which is intended: a
   * pane asked for twice the width asks for twice the room before it will share
   * a line, so the panes fall into a column while each is still readable rather
   * than after the narrowest has become a strip. A strongly weighted division
   * therefore renders as a column on a narrow surface, where the weights no
   * longer mean anything anyway, and honours them exactly wherever the panes do
   * share a line.
   *
   * This is the only prop that reaches the cascade as a value rather than as a
   * class, and it does so through the single custom property this module is
   * allowed to set (see the module header).
   */
  weights?: readonly number[] | undefined;

  /**
   * Whether the panes may fall into a single column when the container is too
   * narrow to hold them side by side.
   *
   * The default depends on the axis, which is the only sensible rule: a
   * horizontal division collapses, because a surface as narrow as a docked
   * DevTools panel cannot show two panes beside each other and must not
   * overflow (AAP 0.6.4); a vertical division is already a column, so
   * collapsing is not a behaviour it has and the variant is never emitted for
   * it. Pass `false` on a horizontal division only when the comparison itself
   * depends on the panes staying side by side.
   *
   * @default true for a horizontal division, false for a vertical one
   */
  collapse?: boolean | undefined;

  /**
   * An optional heading for the division. Supplying it turns the container into
   * a labelled region (see the module note on naming a division); omitting it
   * leaves a plain, unnamed container. Absent, empty and whitespace-only are
   * treated alike.
   *
   * A label the developer reads, never a finding: an assertion about what a
   * capture demonstrates is a fact with evidence attached, which the panel's
   * summary owns.
   */
  title?: string | undefined;

  /**
   * An optional supporting line under the heading, saying what the two panes
   * show or how to read one against the other. Rendered through the text
   * primitive at the dense body role and the secondary tone. It does not name
   * the region: a description is prose, and the accessible name comes from the
   * heading.
   */
  description?: string | undefined;

  /**
   * The outline depth of the heading, forwarded to the heading primitive so a
   * nested division keeps the document outline correct. It selects the heading
   * element only; its visual role follows from that primitive's own mapping.
   *
   * The default suits a group one level below a panel's own title. A division
   * nested inside another titled container passes the next level down.
   *
   * @default 3
   */
  headingLevel?: HeadingLevel | undefined;

  /**
   * Additional class names, merged after the system's own so a consumer extends
   * the block's classes and can never replace them.
   */
  className?: string | undefined;

  /**
   * An `id` for the block, for a caller that needs to reference the container —
   * from a skip link or a fragment, for instance. It is never reused as the
   * label target: a region whose `aria-labelledby` resolved to its own id would
   * name itself with the whole of its content, so the heading always carries an
   * id of its own.
   */
  id?: string | undefined;
}

/**
 * Divides the available space between two or more panes, with the design
 * system's spacing, alignment and collapse behaviour.
 *
 * Renders a fixed shape and nothing more: the block, an optional header when a
 * title or a description was supplied, and the panes container, which is always
 * present and holds one pane element per child. The block is a `section`
 * labelled by its heading when the division was named and a plain `div`
 * otherwise, and it carries every variant class so the stylesheet can resolve
 * the geometry onto the panes with a child selector.
 *
 * Presentational and pure: no state, no effect, nothing measured, nothing read
 * from the document while rendering, and no memoization — this package's render
 * behaviour is something the product reports on rather than something a
 * primitive should smooth over.
 *
 * @param props - See {@link SplitProps}.
 * @returns The container, its optional header and its panes.
 */
export function Split(props: SplitProps): ReactElement {
  const {
    children,
    direction = 'horizontal',
    gap = 4,
    align = 'stretch',
    weights,
    collapse,
    title,
    description,
    headingLevel = 3,
    className,
    id,
  } = props;

  // Called unconditionally, as a hook must be, and used only when the division
  // was named. The heading's id is always this generated value rather than the
  // caller's `id`: the two name different elements, and pointing a region's
  // `aria-labelledby` at the region itself is the one wiring that turns a name
  // into the whole of the content.
  const generatedId = useId();
  const titled = hasText(title);
  const described = hasText(description);
  const headingId = titled ? generatedId : undefined;

  // The axis decides both the default and the ceiling: a vertical division is
  // already a column, so it never carries the variant even if a caller asks for
  // it, and the stylesheet is spared a rule for a state that has no meaning.
  const collapses = direction === 'horizontal' && (collapse ?? true);

  const classes = clsx(
    'dg-split',
    DIRECTION_CLASS[direction],
    GAP_CLASS[gap],
    ALIGN_CLASS[align],
    collapses && 'dg-split--collapse',
    className,
  );

  // The header is absent markup rather than an empty box when neither label was
  // supplied, and the panes element is present either way.
  const header =
    titled || described ? (
      <div className="dg-split__header">
        {titled ? (
          <Heading level={headingLevel} id={headingId}>
            {title}
          </Heading>
        ) : null}
        {described ? (
          <Text as="p" size="sm" tone="secondary">
            {description}
          </Text>
        ) : null}
      </div>
    ) : null;

  // One wrapper per child, in the order the children were given, so the
  // stylesheet has something to grow and shrink and the reading order of a
  // collapsed column matches that of an expanded row. `Children.toArray`
  // flattens nested arrays — the `.map()` a caller renders its panes from
  // arrives as one child otherwise — and drops the `null`, `undefined` and
  // boolean entries a conditional call site produces, so no empty pane is
  // emitted for a child that renders nothing. A fragment stays ONE entry, which
  // is the right reading: a caller that wrote one child meant one pane, and
  // `weights` is positional against exactly these entries.
  //
  // The position is the key, because the position is the identity: a pane's
  // weight is positional, this component neither reads nor may read a child's
  // props, and `Children.toArray` has already given each surviving child a key
  // of its own that React uses for the child itself. A reordered layout is a
  // new panel specification rather than a mutation of this one, so there is no
  // state in a pane for an index key to strand.
  const panes = Children.toArray(children).map((child, index) => (
    <div key={index} className="dg-split__pane" style={paneStyle(weights?.[index])}>
      {child}
    </div>
  ));

  const panesElement = <div className="dg-split__panes">{panes}</div>;

  // Two explicit branches rather than one element type chosen at runtime: the
  // difference between them is semantic, so it reads as a decision here, and an
  // intrinsic tag resolved from a union would also have to be reconciled with
  // the differing attribute types of the two elements.
  if (titled) {
    return (
      <section className={classes} id={id} aria-labelledby={headingId}>
        {header}
        {panesElement}
      </section>
    );
  }

  return (
    <div className={classes} id={id}>
      {header}
      {panesElement}
    </div>
  );
}
