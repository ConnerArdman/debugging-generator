/**
 * `Stack` — the flow primitive of the layout tier of `@debuggen/panel-renderer`.
 *
 * ## What this layout primitive is
 *
 * The renderer side of the panel schema's `stack` container: a sequence of
 * nodes, read in the order they were authored, laid out along one axis. AAP
 * 0.6.2 lists it among the "layout primitives every panel composes from (no
 * panel hand-rolls layout)", and that rule is only keepable if this module is
 * complete enough to stand in for every flex container anyone would otherwise
 * write by hand. So the whole geometry is props — axis, gap, cross-axis
 * alignment, main-axis distribution and wrapping — and there is deliberately
 * nothing else: no sizing, no padding, no surface, no border, no scrolling.
 * A container that needs a card around it composes the group primitive; one
 * that needs panes side by side composes the division primitive.
 *
 * Every gap between siblings in either host surface — the DevTools panel and
 * the editor webview — comes from this primitive, from the division primitive,
 * from the filter bar or from a component's own internal padding. Never from a
 * margin on a sibling, which is why no margin appears in the rules behind the
 * classes below.
 *
 * ## It owns this tier's geometry vocabulary
 *
 * {@link SPACE_STEPS}, {@link SpaceStep}, {@link StackDirection},
 * {@link StackAlign} and {@link StackJustify} are declared here and imported
 * from here by the other containers of this folder rather than redeclared in
 * each of them. That is a structural decision, not a stylistic one: the folder
 * is fixed at exactly six modules, so a seventh shared-types module is not
 * available to hold a vocabulary three of them share, and the first module of
 * the tier is therefore where it lives. Two unions of the same name declared in
 * two files would be two vocabularies the moment either one moved.
 *
 * ## Spacing is a token step, never a length
 *
 * {@link StackProps.gap} is an *index* into the eight-step space scale of the
 * design system (AAP 0.6.3), not a measurement. There is no way to express
 * seven pixels of gap through this component, and that is the point: a value
 * that no token backs has no legal way to be written here, so the fix for a gap
 * the scale cannot express is a change to the token source rather than an
 * inline length (AAP 0.6.4). The same reasoning removes every other escape
 * hatch — there is no `style` prop, no length prop and no colour prop anywhere
 * in this signature.
 *
 * ## Zero inline styles
 *
 * This module renders class names and nothing else: no inline style object, no
 * length, no colour, no font, no shadow, no stacking level. Everything behind
 * the classes below is declared once in `../styles/components.css` against the
 * `--dg-*` custom properties, so a theme change is a cascade change and needs
 * no re-render, and the whole appearance of every panel stays reviewable in one
 * file.
 *
 * ## Class-name contract implemented by `../styles/components.css`
 *
 * The stylesheet is the implementing side; this table is its specification for
 * this block, in the package's block / `__element` / `--variant` convention. An
 * omission there is an unstyled container here, so the two are read together.
 *
 * | Class                                                                  | Role                                                       |
 * | ---------------------------------------------------------------------- | ---------------------------------------------------------- |
 * | `dg-stack`                                                             | block: the container, and the carrier of every variant     |
 * | `dg-stack__header`                                                     | element: the optional heading and its supporting line      |
 * | `dg-stack__title`                                                      | element: the heading inside that header                    |
 * | `dg-stack__items`                                                      | element: the flow container that holds the children        |
 * | `dg-stack--vertical`, `dg-stack--horizontal`                           | variant: the main axis                                     |
 * | `dg-stack--gap-0` … `dg-stack--gap-7`                                  | variant: the space step between items, one class per step  |
 * | `dg-stack--align-start`, `-center`, `-end`, `-stretch`, `-baseline`    | variant: cross-axis alignment                              |
 * | `dg-stack--justify-start`, `-center`, `-end`, `-between`               | variant: main-axis distribution                            |
 * | `dg-stack--wrap`                                                       | variant: items may break onto further lines                |
 *
 * Two facts about those rules matter to anyone reading the markup below. First,
 * every variant class sits on the **block** and is resolved onto
 * `.dg-stack__items` with a child selector, which is what lets a container's own
 * header keep its own spacing however the items are arranged — a caller that
 * asks for the widest gap between items does not thereby push the heading away
 * from them. Second, `.dg-stack__items` is rendered unconditionally, so the
 * stylesheet has one stable selector target and a test one stable structure,
 * whether or not the container was given a title and whether or not its data
 * yielded anything to put in it.
 *
 * The global utilities a caller may pair with this component are declared once
 * in `../styles/base.css` and are reused, never redefined here.
 *
 * ## Naming a container, and when not to
 *
 * A title makes the container a labelled region: the element becomes a
 * `section` whose `aria-labelledby` resolves to the heading rendered inside it,
 * so assistive technology announces the group before its contents. Without a
 * title it stays a plain `div` carrying neither a role nor a name. That is the
 * correct outcome rather than a gap — an unnamed landmark is an ARIA
 * anti-pattern, and a default name invented inside a library would be wording
 * the product never chose, which AAP 0.5.4 forbids this file to ship. The
 * heading is rendered through the heading primitive and the supporting line
 * through the text primitive, never as a raw element, because AAP 0.6.4 puts
 * library primitives ahead of the raw elements they wrap.
 *
 * ## Position in the package
 *
 * A presentational container: no state, no effect, no memoization, no context
 * created and none consumed. It imports React, `clsx` and two primitives, and
 * nothing else — in particular nothing from the host tier, so the layout tier
 * stays below it, the module graph stays acyclic, and the editor webview
 * can compose these containers with no data provider and no panel actions in
 * scope at all (AAP 0.1.2, 0.4.2). It reads no data, holds no query and opens
 * no transport of any kind.
 *
 * @example A vertical sequence with the widest step between its items
 * ```tsx
 * <Stack gap={6}>{nodes}</Stack>
 * ```
 *
 * @example A row that pins one item to each end and centres them on the axis
 * ```tsx
 * <Stack direction="horizontal" gap={2} align="center" justify="between" wrap>
 *   {leading}
 *   {trailing}
 * </Stack>
 * ```
 *
 * @example A labelled group, nested one level below its parent's heading
 * ```tsx
 * <Stack title={node.title} description={node.description} headingLevel={4}>
 *   {children}
 * </Stack>
 * ```
 *
 * @module
 */

import clsx from 'clsx';
import { useId } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { Heading } from '../primitives/Heading';
import type { HeadingLevel } from '../primitives/Heading';
import { Text } from '../primitives/Text';

/*
 * ---------------------------------------------------------------------------
 * The geometry vocabulary this tier shares
 * ---------------------------------------------------------------------------
 */

/**
 * The eight steps of the design system's space scale, in order.
 *
 * Each entry is an index into the `--dg-space-<n>` custom properties published
 * by the generated token stylesheet — `0` is the tightest step and `7` the
 * widest — and the mapping is one-to-one with that scale in every theme, so a
 * step that exists here is a step the stylesheet can resolve and no other step
 * is expressible. A raw length is deliberately absent from the union: spacing
 * is a token decision, and the scale is where it is made (AAP 0.6.3, 0.6.4).
 *
 * The tuple is exported because it is the enumerable form the vocabulary needs
 * — a caller iterating the steps, and the class table below being total over
 * them, both derive from this one list rather than restating it.
 */
export const SPACE_STEPS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/**
 * One step of the space scale: the type of {@link StackProps.gap}, and the key
 * type of every gap lookup in this tier.
 *
 * Derived from {@link SPACE_STEPS} rather than written out a second time, so a
 * change to the scale cannot leave the union behind.
 */
export type SpaceStep = (typeof SPACE_STEPS)[number];

/**
 * The axis a container lays its items along: `'vertical'` runs them down the
 * block axis, `'horizontal'` across the inline axis.
 *
 * Named after the reading direction rather than after the CSS `flex-direction`
 * values, because the schema's containers are described to a panel's author in
 * those terms and the stylesheet resolves the mapping in one place.
 */
export type StackDirection = 'vertical' | 'horizontal';

/**
 * Cross-axis alignment — how an item is placed *across* the axis its container
 * runs along.
 *
 * `'stretch'` is the default and fills the cross axis, which is what a vertical
 * sequence of full-width views wants. `'baseline'` aligns the first text
 * baseline of each item, which is what a row of labels and values wants; the
 * other three align to the start, the centre and the end of the cross axis.
 *
 * Declared here and imported by the other containers of this folder, which is
 * why the name is not prefixed with any one of them.
 */
export type StackAlign = 'start' | 'center' | 'end' | 'stretch' | 'baseline';

/**
 * Main-axis distribution — how the free space *along* the axis is shared out.
 *
 * `'start'`, `'center'` and `'end'` gather the items and place the group;
 * `'between'` pushes the first and last items to the two ends and distributes
 * the remaining space between them. There is no `'around'` or `'evenly'`: both
 * produce an edge inset that no space token backs, so neither is expressible
 * here (AAP 0.6.4).
 */
export type StackJustify = 'start' | 'center' | 'end' | 'between';

/*
 * ---------------------------------------------------------------------------
 * Variant class tables
 * ---------------------------------------------------------------------------
 */

/**
 * Axis to variant class.
 *
 * A total `Record` over the union rather than a class name built from the prop
 * value: the union and the class list cannot drift apart, a typo is a compile
 * error instead of a silently missing rule, and the lookup yields `string`
 * rather than `string | undefined` under `noUncheckedIndexedAccess` — so no
 * cast is needed to hand it to `clsx`. Every table below is written for the
 * same three reasons.
 */
const DIRECTION_CLASS: Record<StackDirection, string> = {
  vertical: 'dg-stack--vertical',
  horizontal: 'dg-stack--horizontal',
};

/**
 * Space step to variant class, total over {@link SpaceStep}.
 *
 * Totality is the coupling that keeps this tier honest in both directions: a
 * step added to {@link SPACE_STEPS} without a class here fails the typecheck,
 * and a class here that the stylesheet does not implement is caught by reading
 * this module's contract table against `../styles/components.css`.
 */
const GAP_CLASS: Record<SpaceStep, string> = {
  0: 'dg-stack--gap-0',
  1: 'dg-stack--gap-1',
  2: 'dg-stack--gap-2',
  3: 'dg-stack--gap-3',
  4: 'dg-stack--gap-4',
  5: 'dg-stack--gap-5',
  6: 'dg-stack--gap-6',
  7: 'dg-stack--gap-7',
};

/** Cross-axis alignment to variant class, total over {@link StackAlign}. */
const ALIGN_CLASS: Record<StackAlign, string> = {
  start: 'dg-stack--align-start',
  center: 'dg-stack--align-center',
  end: 'dg-stack--align-end',
  stretch: 'dg-stack--align-stretch',
  baseline: 'dg-stack--align-baseline',
};

/** Main-axis distribution to variant class, total over {@link StackJustify}. */
const JUSTIFY_CLASS: Record<StackJustify, string> = {
  start: 'dg-stack--justify-start',
  center: 'dg-stack--justify-center',
  end: 'dg-stack--justify-end',
  between: 'dg-stack--justify-between',
};

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

/*
 * ---------------------------------------------------------------------------
 * The component
 * ---------------------------------------------------------------------------
 */

/**
 * Props of {@link Stack}.
 *
 * Deliberately narrow, and closed against three kinds of prop on purpose.
 * There is no `style` prop and no length-bearing prop, because appearance is a
 * class name and spacing is a token step. There is no `ref`: no component in
 * this package is wrapped in `forwardRef`, and a container that exists to
 * arrange other nodes has nothing a caller needs to measure or focus. And
 * there is no data prop of any kind — no source, filter, sort, limit, query or
 * event callback — because the schema's containers carry no query (they hold
 * nodes, not evidence), so a container that accepted one would contradict the
 * contract it renders (AAP 0.4.2, 0.6.2).
 *
 * Every optional property declares `| undefined` explicitly, which
 * `exactOptionalPropertyTypes` makes load-bearing rather than decorative: the
 * node dispatch above this tier forwards a container node's optional title and
 * description straight through, and those arrive as `string | undefined`.
 */
export interface StackProps {
  /**
   * The nodes in the sequence, rendered in order and verbatim — no wrapper per
   * child, and nothing inserted between them, since the gap is a property of
   * the container rather than a divider.
   *
   * Optional: a container whose data yielded nothing still renders, because the
   * component above it must be able to compose a layout before its query has
   * resolved and must not have to branch around this one.
   */
  children?: ReactNode | undefined;

  /**
   * The axis the items run along.
   *
   * The default is load-bearing rather than a convenience: the schema's `stack`
   * container carries no axis field, so the node dispatch above this tier
   * renders one without this prop and has to get a sequence read top to bottom.
   *
   * @default 'vertical'
   */
  direction?: StackDirection | undefined;

  /**
   * The space step between items, as an index into the design system's
   * eight-step scale (see {@link SpaceStep}). The default is the scale's
   * ordinary interface step, which is what separates the views of a generated
   * panel.
   *
   * @default 3
   */
  gap?: SpaceStep | undefined;

  /**
   * Cross-axis alignment. The default fills the cross axis, so a vertical
   * sequence of views each occupies the container's full inline size.
   *
   * @default 'stretch'
   */
  align?: StackAlign | undefined;

  /**
   * Main-axis distribution. The default gathers the items at the start of the
   * axis and leaves any free space after them.
   *
   * @default 'start'
   */
  justify?: StackJustify | undefined;

  /**
   * Whether items may break onto further lines when the container cannot hold
   * them on one. Off by default: a sequence that wraps when it was not asked to
   * changes the reading order a panel's author chose.
   *
   * This is also the whole of this container's responsive behaviour, and it is
   * intentionally the whole of it. The stylesheet declares no length-bearing
   * media query anywhere, so there is no width at which a container silently
   * behaves differently; a caller that needs panes to reflow composes the
   * division primitive, which wraps intrinsically.
   *
   * @default false
   */
  wrap?: boolean | undefined;

  /**
   * An optional heading for the group. Supplying it turns the container into a
   * labelled region (see the module note on naming a container); omitting it
   * leaves a plain, unnamed container. Absent, empty and whitespace-only are
   * treated alike.
   *
   * A label the developer reads, never a finding: an assertion about what a
   * capture demonstrates is a fact with evidence attached, which the panel's
   * summary owns.
   */
  title?: string | undefined;

  /**
   * An optional supporting line under the heading, saying what the group shows
   * or how to read it. Rendered through the text primitive at the dense body
   * role and the secondary tone. It does not name the region: a description is
   * prose, and the accessible name comes from the heading.
   */
  description?: string | undefined;

  /**
   * The outline depth of the heading, forwarded to the heading primitive so a
   * nested container keeps the document outline correct. It selects the heading
   * element only; its visual role follows from that primitive's own mapping.
   *
   * The default suits a group one level below a panel's own title. A container
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
 * Arranges nodes along one axis, with the design system's spacing and
 * alignment.
 *
 * Renders a fixed shape and nothing more: the block, an optional header when a
 * title or a description was supplied, and the flow container, which is always
 * present. The block is a `section` labelled by its heading when the container
 * was named and a plain `div` otherwise, and it carries every variant class so
 * the stylesheet can resolve the geometry onto the flow container with a child
 * selector.
 *
 * Presentational and pure: no state, no effect, nothing read from the document
 * while rendering, and no memoization — this package's render behaviour is
 * something the product reports on rather than something a primitive should
 * smooth over.
 *
 * @param props - See {@link StackProps}.
 * @returns The container, its optional header and its items.
 */
export function Stack(props: StackProps): ReactElement {
  const {
    children,
    direction = 'vertical',
    gap = 3,
    align = 'stretch',
    justify = 'start',
    wrap = false,
    title,
    description,
    headingLevel = 3,
    className,
    id,
  } = props;

  // Called unconditionally, as a hook must be, and used only when the container
  // was named. The heading's id is always this generated value rather than the
  // caller's `id`: the two name different elements, and pointing a region's
  // `aria-labelledby` at the region itself is the one wiring that turns a name
  // into the whole of the content.
  const generatedId = useId();
  const titled = hasText(title);
  const described = hasText(description);
  const headingId = titled ? generatedId : undefined;

  const classes = clsx(
    'dg-stack',
    DIRECTION_CLASS[direction],
    GAP_CLASS[gap],
    ALIGN_CLASS[align],
    JUSTIFY_CLASS[justify],
    wrap && 'dg-stack--wrap',
    className,
  );

  // The header is absent markup rather than an empty box when neither label was
  // supplied, and the items element is present either way.
  const header =
    titled || described ? (
      <div className="dg-stack__header">
        {titled ? (
          <Heading level={headingLevel} id={headingId} className="dg-stack__title">
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

  const items = <div className="dg-stack__items">{children}</div>;

  // Two explicit branches rather than one element type chosen at runtime: the
  // difference between them is semantic, so it reads as a decision here, and an
  // intrinsic tag resolved from a union would also have to be reconciled with
  // the differing attribute types of the two elements.
  if (titled) {
    return (
      <section className={classes} id={id} aria-labelledby={headingId}>
        {header}
        {items}
      </section>
    );
  }

  return (
    <div className={classes} id={id}>
      {header}
      {items}
    </div>
  );
}
