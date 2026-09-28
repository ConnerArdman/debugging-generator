/**
 * The heading primitive of the in-repo design system `@debuggen/panel-renderer`.
 *
 * ## Why a primitive exists at all for something as small as a heading
 *
 * The design system's non-negotiable rule is that library primitives are used
 * in place of the raw elements they wrap — `Button`, `Input`, `Select`,
 * `DataTable` and this module — so no layout primitive, no visualization
 * component and no editor-side view writes a bare `<h2>`. Two things follow
 * from that, and both are the point of this file:
 *
 * 1. Appearance is selected by class name only. Not one colour, length, weight
 *    or family is written here; the block and variant classes below are
 *    implemented once in `../styles/components.css` against the `--dg-*`
 *    tokens, so a type role changes in the token source and every heading in
 *    both host surfaces follows. There is deliberately no `style` escape
 *    hatch, no `font`/`color` prop and no size expressed as a number.
 * 2. The document outline and the visual role are separable. In a dense
 *    debugging surface they routinely disagree: a region nested three levels
 *    deep still needs a correct `h4` for assistive technology while rendering
 *    at the smallest available role, and a generated layout can nest regions
 *    arbitrarily. So {@link HeadingProps.level} chooses the *element* and
 *    {@link HeadingProps.size} chooses the *type role*, independently.
 *
 * ## The type roles this primitive may use
 *
 * Exactly four, and no other size exists anywhere in the system:
 *
 * | `size`      | token           | weight / size / line-height |
 * | ----------- | --------------- | --------------------------- |
 * | `'heading'` | `--dg-heading`  | 600 · 16 · 22               |
 * | `'lg'`      | `--dg-text-lg`  | 500 · 15 · 20               |
 * | `'md'`      | `--dg-text-md`  | 400 · 13 · 18               |
 * | `'sm'`      | `--dg-text-sm`  | 400 · 12 · 16               |
 *
 * Tone is limited to the three text tones — `--dg-text-primary`,
 * `--dg-text-secondary` and `--dg-text-muted` — because a heading is text, and
 * de-emphasis is a tone rather than an opacity, which would silently invalidate
 * the contrast ratios the token test pins.
 *
 * Both are needed on top of the element-level default in `../styles/base.css`,
 * which gives every `h1`–`h6` the `--dg-heading` role at zero specificity: the
 * single `dg-heading--*` class below always wins, which is what lets a level-5
 * element render at the `md` role without a longer selector.
 *
 * ## Class-name contract this module declares
 *
 * `../styles/components.css` implements exactly these, in the system's
 * block / `--variant` convention:
 *
 * - `dg-heading` — the block
 * - `dg-heading--heading`, `dg-heading--lg`, `dg-heading--md`, `dg-heading--sm`
 * - `dg-heading--primary`, `dg-heading--secondary`, `dg-heading--muted`
 *
 * plus `dg-visually-hidden`, the global utility from `../styles/base.css`,
 * which is reused and never redefined here.
 *
 * ## Position in the package
 *
 * A tier-one atom: it imports `clsx`, React's types and the untrusted-text
 * helper `./untrusted-text` (a pure function over strings, not a component)
 * and nothing else — no sibling primitive, no layout primitive, no component,
 * no host module, no workspace package, no transport. It is presentational, so
 * it reads no data and holds no state, and every attribute it does not own is
 * forwarded untouched. That forwarding is load-bearing rather than incidental:
 * the layout primitives and the panel host give a heading an `id` and then
 * point their region's `aria-labelledby` at it, so swallowing unknown props
 * would leave those regions unnamed.
 *
 * ## What is on screen is the logical text
 *
 * A heading can carry untrusted text — a generated panel's title, a section
 * named after a captured route — and an invisible Unicode direction control in
 * it (U+202E and its eleven siblings) would draw the glyphs after it in an
 * order that was never written. Every string child, and a string `title` or
 * `aria-label`, is therefore rendered through
 * `formatUntrustedNode`/`formatUntrustedText`, which print each control as its
 * visible escape (`\u202E`) and change nothing else. That is not truncating,
 * transforming or re-casing the heading: it is the guarantee that the glyphs
 * shown are the characters given, in the order given, and the tooltip and the
 * accessible name match the visible heading (WCAG 2.5.3).
 *
 * @example A titled region whose heading is three levels deep but small
 * ```tsx
 * <section aria-labelledby={titleId}>
 *   <Heading id={titleId} level={4} size="sm" tone="secondary">
 *     Slowest operations
 *   </Heading>
 * </section>
 * ```
 *
 * @example A region that needs an accessible name but shows no visible title
 * ```tsx
 * <Heading id={titleId} level={2} visuallyHidden>
 *   Captured events
 * </Heading>
 * ```
 *
 * @module
 */

import clsx from 'clsx';
import type { HTMLAttributes, ReactElement, ReactNode, Ref } from 'react';

import { formatUntrustedNode, formatUntrustedText } from './untrusted-text';

/**
 * The heading element this primitive renders, and therefore the node's depth in
 * the document outline. It is a required prop precisely because it is a
 * decision about the outline that no default can make for a caller: a heading
 * is only useful to assistive technology when its level follows the one above
 * it, and a generated layout nests regions to arbitrary depth.
 */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The visual type role, independent of {@link HeadingLevel}. Each value names
 * one of the four type-role tokens the design system defines for headings:
 * `'heading'` → `--dg-heading`, `'lg'` → `--dg-text-lg`, `'md'` →
 * `--dg-text-md`, `'sm'` → `--dg-text-sm`.
 */
export type HeadingSize = 'heading' | 'lg' | 'md' | 'sm';

/**
 * The text tone: `'primary'` → `--dg-text-primary`, `'secondary'` →
 * `--dg-text-secondary`, `'muted'` → `--dg-text-muted`. The status, accent and
 * span-kind tokens are deliberately unreachable from here — a heading that
 * needs to carry state carries a `Badge` beside it instead, so colour is never
 * the sole indicator of meaning.
 */
export type HeadingTone = 'primary' | 'secondary' | 'muted';

/**
 * Props of {@link Heading}.
 *
 * Every standard heading attribute is accepted and forwarded, which is how
 * `id`, `aria-*`, `data-*`, `title` and event handlers reach the element. The
 * deprecated presentational `color` attribute is the one exclusion: colour is a
 * {@link HeadingProps.tone}, never a literal.
 */
export interface HeadingProps extends Omit<HTMLAttributes<HTMLHeadingElement>, 'color'> {
  /**
   * The outline depth, and the only input that decides which element is
   * rendered: `1` → `h1` … `6` → `h6`. Required.
   */
  level: HeadingLevel;

  /**
   * The type role to render at. Omitted, it is derived from `level` by
   * {@link DEFAULT_SIZE_BY_LEVEL} — levels 1–2 render at `'heading'`, 3–4 at
   * `'lg'`, 5–6 at `'md'` — which keeps the common case (a heading that looks
   * as deep as it is) free of ceremony. An explicit value always wins, and it
   * never changes the rendered element.
   */
  size?: HeadingSize | undefined;

  /**
   * The text tone. Defaults to `'primary'` (`--dg-text-primary`).
   */
  tone?: HeadingTone | undefined;

  /**
   * Keep the heading in the document outline and in the accessibility tree
   * while removing it from the visual surface — the shape a region takes when
   * it needs an accessible name but its content already reads as titled. It
   * applies the global `dg-visually-hidden` utility, which hides the text with
   * `clip-path` so it stays rendered and announced; `display: none` and the
   * `hidden` attribute are never used for this, because both would take the
   * heading out of the outline, which is the one thing this primitive exists to
   * protect.
   */
  visuallyHidden?: boolean | undefined;

  /**
   * The heading text. Forwarded verbatim: this primitive never truncates,
   * transforms or re-cases what it is given. Clamping is a decision of the
   * component that owns the surrounding layout. The one change is display
   * only — a direction control in a string is printed as its visible escape
   * (see the module header).
   */
  children?: ReactNode | undefined;

  /**
   * A ref to the rendered heading element — a plain prop, as React 19 makes it,
   * so no `forwardRef` wrapper stands between a caller and the element it needs
   * (the layout shell focuses a region's heading when a generated view
   * replaces the one before it).
   */
  ref?: Ref<HTMLHeadingElement> | undefined;
}

/**
 * The outline depth to element mapping — the complete and only way this module
 * decides what to render. A record of literal tag names rather than a string
 * built from the level: a literal keeps the union of intrinsic elements in the
 * type system, where a typo is a compile error rather than a silently invalid
 * element at runtime.
 */
const TAG_BY_LEVEL: Record<HeadingLevel, 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'> = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
  4: 'h4',
  5: 'h5',
  6: 'h6',
};

/**
 * The type role used when a caller states a level and no size. The steps mirror
 * how deeply a region is nested rather than the six element names, because the
 * system has four heading roles and not six: levels 1–2 → `'heading'`, levels
 * 3–4 → `'lg'`, levels 5–6 → `'md'`. `'sm'` is never a default — it is the
 * deliberate choice a dense nested region makes for itself.
 */
const DEFAULT_SIZE_BY_LEVEL: Record<HeadingLevel, HeadingSize> = {
  1: 'heading',
  2: 'heading',
  3: 'lg',
  4: 'lg',
  5: 'md',
  6: 'md',
};

/** The size variant class per type role. */
const CLASS_BY_SIZE: Record<HeadingSize, string> = {
  heading: 'dg-heading--heading',
  lg: 'dg-heading--lg',
  md: 'dg-heading--md',
  sm: 'dg-heading--sm',
};

/** The tone variant class per text tone. */
const CLASS_BY_TONE: Record<HeadingTone, string> = {
  primary: 'dg-heading--primary',
  secondary: 'dg-heading--secondary',
  muted: 'dg-heading--muted',
};

/**
 * Renders a heading whose element comes from `level` and whose appearance comes
 * from `size` and `tone`.
 *
 * The rendered tag is derived **only** from {@link HeadingProps.level}. No
 * other prop can change it: `size` selects a class and never an element, so
 * making a heading look smaller can never flatten the document outline, and a
 * reviewer can confirm that by reading the single lookup below. `role` and
 * `aria-level` are correspondingly never injected — a real heading element
 * already conveys both, and stating them again is redundant at best and
 * contradictory at worst.
 *
 * Unknown props are spread onto the element unchanged, so `id`, `aria-*` and
 * `data-*` all pass through (a string `title` and `aria-label` with their
 * direction controls revealed), and any `className` a caller supplies is
 * appended after the system's own classes rather than replacing them.
 *
 * @param props - See {@link HeadingProps}.
 * @returns The heading element for `props.level`.
 */
export function Heading(props: HeadingProps): ReactElement {
  const {
    level,
    size,
    tone = 'primary',
    visuallyHidden,
    className,
    children,
    title,
    'aria-label': label,
    ...rest
  } = props;

  const Tag = TAG_BY_LEVEL[level];
  const resolvedSize = size ?? DEFAULT_SIZE_BY_LEVEL[level];

  // The heading text and the two string attributes a reader hovers or hears
  // are revealed (see the module header); an absent attribute stays absent.
  return (
    <Tag
      className={clsx(
        'dg-heading',
        CLASS_BY_SIZE[resolvedSize],
        CLASS_BY_TONE[tone],
        visuallyHidden && 'dg-visually-hidden',
        className,
      )}
      title={title === undefined ? title : formatUntrustedText(title)}
      aria-label={label === undefined ? label : formatUntrustedText(label)}
      {...rest}
    >
      {formatUntrustedNode(children)}
    </Tag>
  );
}
