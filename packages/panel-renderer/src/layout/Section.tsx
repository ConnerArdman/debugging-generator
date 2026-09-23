/**
 * `Section` — the titled container of the layout tier of
 * `@debuggen/panel-renderer`.
 *
 * ## What this layout primitive is
 *
 * The renderer side of the panel schema's `section` container: one part of a
 * generated panel, given a heading, an optional supporting line and — when the
 * caller asks for it — a frame of its own, so that each question a panel
 * answers is visibly its own region. AAP 0.6.2 lists it among the "layout
 * primitives every panel composes from (no panel hand-rolls layout)" and names
 * it for the schema's `section` node, so every titled region in either host
 * surface is this component and no view writes its own titled box.
 *
 * It has a second, deliberate role. AAP 0.6.4's degradation ladder ends its
 * third rung at a "generic `Section` styled with tokens": when the component
 * catalog holds nothing that matches a node, what renders in its place is this
 * container with the node's title and whatever content could be assembled. So
 * it has to read as a finished part of the product on its own, not as a
 * fallback that looks like one — which is why the frame is a first-class
 * variant here rather than something a caller improvises with a class name.
 *
 * ## The two variants
 *
 * {@link SectionProps.variant} chooses between a plain grouping and a framed
 * card, and it chooses a class name — never a value. `'plain'` is the default
 * and adds no surface at all: it is a heading over its content, which is what a
 * region nested inside a card already sitting on the elevated surface wants.
 * `'card'` is the framed grouping of AAP 0.6.3 — the elevated surface, the
 * subtle hairline and the medium radius — and it is what a top-level region of
 * a panel, or the degradation-ladder fallback above, asks for.
 *
 * ## Spacing is composed, never declared here
 *
 * The gap between this container's children comes from the flow primitive this
 * module composes, not from a rule of its own. AAP 0.6.4 routes *all* spacing
 * and alignment through the layout primitives, and a titled container that
 * declared its own gap would be a second place where the space scale is
 * spent — so the body of this component is a flow container, and
 * {@link SectionProps.gap} is forwarded to it verbatim as a space step. A later
 * reader tempted to "simplify" the extra element away would be moving spacing
 * back out of the primitive that owns it, so the composition is intentional and
 * stays.
 *
 * ## Zero inline styles
 *
 * This module renders class names and nothing else: no inline style object, no
 * custom property, no length, no colour, no font, no shadow. Everything behind
 * the classes below is declared once in `../styles/components.css` against the
 * `--dg-*` custom properties, so a theme change is a cascade change, needs no
 * re-render, and the whole appearance of every panel stays reviewable in one
 * file.
 *
 * ## Class-name contract implemented by `../styles/components.css`
 *
 * The stylesheet is the implementing side; this table is its specification for
 * this block, in the package's block / `__element` / `--variant` convention. An
 * omission there is an unstyled container here, so the two are read together.
 *
 * | Class                     | Role                                                            |
 * | ------------------------- | --------------------------------------------------------------- |
 * | `dg-section`              | block: the container, and the carrier of the variant            |
 * | `dg-section__header`      | element: the heading and its supporting line, stacked           |
 * | `dg-section__title`       | element: the heading inside that header                         |
 * | `dg-section__description` | element: the supporting line under the heading                  |
 * | `dg-section__body`        | element: the region the flow container and its children sit in  |
 * | `dg-section--plain`       | variant: a heading over its content, with no surface of its own |
 * | `dg-section--card`        | variant: the framed grouping                                    |
 *
 * Two facts about those rules matter to anyone reading the markup below.
 * First, `dg-section--card` is what resolves the frame — `--dg-surface-elevated`
 * for the surface, `--dg-border-subtle` for the hairline and the medium radius
 * token for the corners — and it is also what carries the card's internal
 * inset, so `dg-section--plain` needs no counter-rule: it adds no surface
 * because nothing gives it one. Second, `dg-section__body` is rendered
 * unconditionally, so the stylesheet has one stable selector target and a test
 * one stable structure, whether or not the container was given a title and
 * whether or not its data yielded anything to put in it.
 *
 * The global utilities a caller may pair with this component are declared once
 * in `../styles/base.css` and are reused, never redefined here.
 *
 * ## Naming a region, and when not to
 *
 * A title makes the container a labelled region: the element becomes a
 * `section` whose `aria-labelledby` resolves to the heading rendered inside it,
 * so assistive technology announces the region before its contents. Without a
 * title it stays a plain `div` carrying neither a role nor a name — the node
 * dispatch above this tier may group nodes without labelling them, and that is
 * the correct outcome rather than a gap: an unnamed landmark is an ARIA
 * anti-pattern, and a default name invented inside a library would be wording
 * the product never chose, which AAP 0.5.4 forbids this file to ship. The
 * heading is rendered through the heading primitive and the supporting line
 * through the text primitive, never as a raw element, because AAP 0.6.4 puts
 * library primitives ahead of the raw elements they wrap.
 *
 * ## Position in the package
 *
 * A presentational container: no state, no effect, no memoization, no context
 * created and none consumed. It imports React, `clsx`, the flow primitive of
 * this folder and two UI primitives, and nothing else — in particular nothing
 * from the host tier, so the layout tier stays below it, the module graph stays
 * acyclic, and the editor webview can compose these containers with no data
 * provider and no panel actions in scope at all (AAP 0.1.2, 0.4.2). It reads no
 * data, holds no query and opens no transport of any kind. The schema's
 * `section` node carries no query either (AAP 0.2.3), so the props below are
 * that node's own surface — an identity and two optional labels — plus
 * presentation.
 *
 * There is no actions slot, and none is needed: a filter, sort or search row is
 * the filter-bar primitive of this folder, which a caller places inside
 * `children` like any other node, so this container never has to decide where
 * someone else's controls belong.
 *
 * @example A framed, titled region at the top level of a panel
 * ```tsx
 * <Section variant="card" title={node.title} description={node.description}>
 *   {children}
 * </Section>
 * ```
 *
 * @example A region nested one level below another, keeping the outline correct
 * ```tsx
 * <Section title={node.title} headingLevel={3} gap={2}>
 *   {children}
 * </Section>
 * ```
 *
 * @example An untitled grouping — no role, no name, just the container
 * ```tsx
 * <Section gap={4}>{children}</Section>
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
import { Stack } from './Stack';
import type { SpaceStep } from './Stack';

/*
 * ---------------------------------------------------------------------------
 * The variant vocabulary
 * ---------------------------------------------------------------------------
 */

/**
 * How much of a boundary the container draws around its content.
 *
 * `'plain'` draws none: the heading and the content group together with no
 * surface, no hairline and no inset, which is how a region nested inside
 * another already-framed one reads. `'card'` draws the design system's framed
 * grouping — the elevated surface, the subtle hairline and the medium radius of
 * AAP 0.6.3 — which is how a top-level region of a panel reads, and what the
 * degradation ladder of AAP 0.6.4 falls back to.
 *
 * Both are class-name selections resolved in `../styles/components.css`. There
 * is deliberately no third value and no way to express a surface, a border
 * width or a radius through this component: a frame that no token backs has no
 * legal way to be written here.
 */
export type SectionVariant = 'plain' | 'card';

/**
 * Variant to variant class.
 *
 * A total `Record` over the union rather than a class name built from the prop
 * value: the union and the class list cannot drift apart, a typo is a compile
 * error instead of a silently missing rule, and the lookup yields `string`
 * rather than `string | undefined` under `noUncheckedIndexedAccess` — so no
 * cast is needed to hand it to `clsx`.
 */
const VARIANT_CLASS: Record<SectionVariant, string> = {
  plain: 'dg-section--plain',
  card: 'dg-section--card',
};

/**
 * Whether a string carries something to render.
 *
 * Absent, empty and whitespace-only are one case for every label this module
 * accepts: a title that came from a generated panel's node — where it is
 * optional — must leave the container unnamed rather than produce a region
 * whose accessible name announces as nothing, and an empty heading element in
 * the document outline is worse than no heading at all. The predicate narrows,
 * so the value can then be handed to a primitive that declares `string` without
 * `| undefined` and with no cast.
 *
 * It is declared here rather than imported because the flow primitive keeps its
 * own copy module-private: the folder is fixed at six modules, so a shared
 * predicate has nowhere of its own to live, and exporting a helper from a
 * component to a component would widen a public API for three lines of logic.
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
 * Props of {@link Section}.
 *
 * Deliberately narrow, and closed against four kinds of prop on purpose. There
 * is no `style` prop and no length-, colour- or surface-bearing prop, because
 * appearance is a class name and spacing is a token step. There is no `ref`: no
 * component in this package is wrapped in `forwardRef`, and a container that
 * exists to title and group other nodes has nothing a caller needs to measure
 * or focus. There is no data prop of any kind — no source, filter, sort, limit,
 * query or event callback — because the schema's containers carry no query
 * (they hold nodes, not evidence), so a container that accepted one would
 * contradict the contract it renders (AAP 0.2.3, 0.4.2). And there is no
 * actions slot: controls are children, which keeps the one decision this
 * container makes about its content — where the heading goes — the only one.
 *
 * Every optional property declares `| undefined` explicitly, which
 * `exactOptionalPropertyTypes` makes load-bearing rather than decorative: the
 * node dispatch above this tier forwards a container node's optional title and
 * description straight through, and those arrive as `string | undefined`.
 */
export interface SectionProps {
  /**
   * The nodes this region groups, rendered in order and verbatim — no wrapper
   * per child, and nothing inserted between them, since the gap is a property
   * of the flow container rather than a divider.
   *
   * Optional: a region whose data yielded nothing still renders, because the
   * component above it must be able to compose a layout before its query has
   * resolved and must not have to branch around this one.
   */
  children?: ReactNode | undefined;

  /**
   * The heading for the region. Supplying it turns the container into a
   * labelled region (see the module note on naming a region); omitting it
   * leaves a plain, unnamed container, which is what the node dispatch above
   * this tier renders for an untitled grouping. Absent, empty and
   * whitespace-only are treated alike.
   *
   * A label the developer reads, never a finding: an assertion about what a
   * capture demonstrates is a fact with evidence attached, which the panel's
   * summary owns.
   */
  title?: string | undefined;

  /**
   * An optional supporting line under the heading, saying what the region shows
   * or how to read it. Rendered through the text primitive at the dense body
   * role and the secondary tone. It does not name the region: a description is
   * prose, and the accessible name comes from the heading.
   */
  description?: string | undefined;

  /**
   * The outline depth of the heading, forwarded to the heading primitive so a
   * nested region keeps the document outline correct. It selects the heading
   * element only; its visual role follows from that primitive's own mapping.
   *
   * The default is the level directly below a panel's own title, which the
   * summary header renders at level two by default — sections are a panel's
   * next outline level, so a top-level region needs no `headingLevel` at all.
   * A region nested inside another titled region is given the next level down
   * by its caller, which is the only way the outline of a deeply nested
   * generated panel stays correct: no component can infer its own depth.
   *
   * @default 2
   */
  headingLevel?: HeadingLevel | undefined;

  /**
   * How much of a boundary to draw (see {@link SectionVariant}). The default
   * draws none, so a region composed inside an already-framed one does not
   * stack a second frame inside the first.
   *
   * @default 'plain'
   */
  variant?: SectionVariant | undefined;

  /**
   * The space step between the region's children, as an index into the design
   * system's eight-step scale, forwarded to the flow container this component
   * composes (see {@link SpaceStep}). The default is the scale's ordinary
   * interface step, which is what separates the views of a generated panel.
   *
   * @default 3
   */
  gap?: SpaceStep | undefined;

  /**
   * Additional class names, merged after the system's own so a consumer extends
   * the block's classes and can never replace them.
   */
  className?: string | undefined;

  /**
   * An `id` for the block, for a caller that needs to reference the region —
   * from a skip link or a fragment, for instance. It is never reused as the
   * label target: a region whose `aria-labelledby` resolved to its own id would
   * name itself with the whole of its content, so the heading always carries an
   * id of its own.
   */
  id?: string | undefined;
}

/**
 * Groups nodes under a heading, optionally inside the design system's framed
 * card.
 *
 * Renders a fixed shape and nothing more: the block, an optional header when a
 * title or a description was supplied, and the body, which is always present
 * and always holds the flow container the children sit in. The block is a
 * `section` labelled by its heading when the region was named and a plain `div`
 * otherwise, and it carries the variant class so the stylesheet can resolve the
 * frame and its inset from one selector.
 *
 * Presentational and pure: no state, no effect, nothing read from the document
 * while rendering, and no memoization — this package's render behaviour is
 * something the product reports on rather than something a primitive should
 * smooth over.
 *
 * @param props - See {@link SectionProps}.
 * @returns The container, its optional header and its body.
 */
export function Section(props: SectionProps): ReactElement {
  const {
    children,
    title,
    description,
    headingLevel = 2,
    variant = 'plain',
    gap = 3,
    className,
    id,
  } = props;

  // Called unconditionally, as a hook must be, and used only when the region
  // was named. The heading's id is always this generated value rather than the
  // caller's `id`: the two name different elements, and pointing a region's
  // `aria-labelledby` at the region itself is the one wiring that turns a name
  // into the whole of the content.
  const generatedId = useId();
  const titled = hasText(title);
  const described = hasText(description);
  const headingId = titled ? generatedId : undefined;

  const classes = clsx('dg-section', VARIANT_CLASS[variant], className);

  // The header is absent markup rather than an empty box when neither label was
  // supplied, and the body is present either way.
  const header =
    titled || described ? (
      <div className="dg-section__header">
        {titled ? (
          <Heading level={headingLevel} id={headingId} className="dg-section__title">
            {title}
          </Heading>
        ) : null}
        {described ? (
          <Text as="p" size="sm" tone="secondary" className="dg-section__description">
            {description}
          </Text>
        ) : null}
      </div>
    ) : null;

  // The children go through the flow primitive, which is where this tier's
  // spacing lives (AAP 0.6.4): this container declares no gap of its own, and
  // collapsing the two elements into one would put the space scale back in two
  // places. The flow container is given no title and no description on
  // purpose — the header above belongs to this region, and a labelled flow
  // container nested inside it would emit a second labelled region announcing
  // the same name.
  const body = (
    <div className="dg-section__body">
      <Stack direction="vertical" gap={gap}>
        {children}
      </Stack>
    </div>
  );

  // Two explicit branches rather than one element type chosen at runtime: the
  // difference between them is semantic, so it reads as a decision here, and an
  // intrinsic tag resolved from a union would also have to be reconciled with
  // the differing attribute types of the two elements.
  if (titled) {
    return (
      <section className={classes} id={id} aria-labelledby={headingId}>
        {header}
        {body}
      </section>
    );
  }

  return (
    <div className={classes} id={id}>
      {header}
      {body}
    </div>
  );
}
