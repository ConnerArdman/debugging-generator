/**
 * @debuggen/panel-renderer — src/primitives/Text.tsx
 *
 * The body-text primitive of the in-repo design system, and the only sanctioned
 * way to put a string on the screen inside this package. Summary prose, table
 * cells, axis and lane labels, the inner text of a chip or a status line, and
 * every caption in the editor webview are all this one component with a
 * different type role and a different tone (AAP 0.6.2 lists `Text` among the UI
 * primitives that components use "instead of raw HTML").
 *
 * ## Tier 1 atom
 *
 * It imports nothing from this folder and nothing from the layers above it — no
 * layout primitive, no visualization component, no host module, no panel schema
 * and no transport. Its only dependencies are React's types and `clsx`, which
 * is what lets every other module in the package compose it freely without
 * risking a cycle. The reverse direction is what would be wrong: a primitive
 * that knew about a panel node, a data query or a socket would drag the whole
 * design system into the product's data flow (AAP 0.4.2, 0.6.2).
 *
 * ## The fixed vocabulary
 *
 * Four type roles and eight tones, each mapping one-to-one onto a token from
 * the single token source (`src/tokens/tokens.ts`, AAP 0.6.3):
 *
 *   size  'lg' -> --dg-text-lg (15/20/500)   tone  'primary'   -> --dg-text-primary
 *         'md' -> --dg-text-md (13/18/400)         'secondary' -> --dg-text-secondary
 *         'sm' -> --dg-text-sm (12/16/400)         'muted'     -> --dg-text-muted
 *         'xs' -> --dg-text-xs (11/16/400)         'accent'    -> --dg-accent
 *                                                  'success'   -> --dg-success
 *                                                  'warning'   -> --dg-warning
 *                                                  'danger'    -> --dg-danger
 *                                                  'info'      -> --dg-info
 *
 * There is deliberately no fifth size and no ninth tone: a role with no token
 * has no legal way to be expressed here, so the fix is to add it to the token
 * source rather than to inline a value (AAP 0.6.4). Both consumer surfaces —
 * the DevTools panel and the editor webview — are dense, which is why `md` is
 * the body default and why `sm` and `xs` carry table, axis and legend text.
 *
 * ## Zero hardcoded CSS
 *
 * This module renders class names and nothing else: no inline style object, no
 * colour, no length, no font. Every declaration behind the classes below lives
 * in `../styles/components.css` and resolves to a `--dg-*` token, so a theme
 * change is a cascade change and needs no re-render (AAP 0.6.4).
 *
 * The class names this file DECLARES, in the package's naming convention
 * (block `dg-<block>`, variant `dg-<block>--<variant>`; see
 * `../styles/base.css`):
 *
 *   dg-text                                                     the block
 *   dg-text--lg | --md | --sm | --xs                            type role
 *   dg-text--primary | --secondary | --muted | --accent
 *            | --success | --warning | --danger | --info        tone
 *   dg-text--medium                                             raised weight
 *   dg-text--numeric                                            tabular figures
 *   dg-text--truncate                                           single-line clip
 *
 * The two global utilities a caller may pair with this component — the
 * `dg-visually-hidden` escort for a truncated value and the `dg-icon` square
 * for a leading glyph — are declared once in `../styles/base.css` and are
 * reused, never redefined.
 *
 * ## Why `createElement` rather than a JSX tag
 *
 * The element is chosen at runtime from a union of six intrinsic tags, and
 * `ref` is a plain prop typed `Ref<HTMLElement>` (React 19; no `forwardRef`).
 * A JSX tag resolved from that union does not type-check under this
 * repository's compiler settings: `p`, `div` and `span` narrow their intrinsic
 * `ref` to `Ref<HTMLParagraphElement>`, `Ref<HTMLDivElement>` and
 * `Ref<HTMLSpanElement>`, and `Ref<HTMLElement>` is not assignable to any of
 * them (TS2322, because `RefObject` is invariant in its element). Every
 * annotation that keeps the JSX form — `ElementType<…>` with or without
 * `RefAttributes`, or a pre-typed props object spread onto the tag — moves the
 * same error rather than removing it. `createElement`, with its element type
 * pinned to `HTMLElement`, expresses exactly what this component promises and
 * needs no `any` and no widening cast. The emitted markup is identical to what
 * the automatic JSX runtime would produce: one element, one class attribute,
 * no wrapper.
 */

import clsx from 'clsx';
import { createElement } from 'react';
import type { HTMLAttributes, ReactElement, ReactNode, Ref } from 'react';

/**
 * The four type roles, named after the tokens that back them: `lg` for the
 * heaviest body line a panel uses, `md` for ordinary interface text, `sm` for
 * dense table rows and `xs` for axis ticks, legends and metadata.
 *
 * Headings are NOT part of this scale — `--dg-heading` belongs to the `Heading`
 * primitive, which also owns the semantic element (AAP 0.6.4).
 */
export type TextSize = 'lg' | 'md' | 'sm' | 'xs';

/**
 * The eight text tones. `primary`, `secondary` and `muted` are the three levels
 * of emphasis; `accent` marks a value the surface treats as selectable or
 * linked; `success`, `warning`, `danger` and `info` are the four status
 * colours the whole design system shares.
 *
 * No duration tone exists here on purpose: severity colouring for a measured
 * duration is `DurationCell`'s responsibility, which resolves the
 * `--dg-duration-*` aliases from the measurement itself.
 */
export type TextTone =
  'primary' | 'secondary' | 'muted' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/**
 * The elements this primitive may render.
 *
 * `span` is inline and neutral, which is why it is the default; `p` is a
 * paragraph of prose; `div` is for a block of text that legitimately contains
 * other blocks; `small`, `strong` and `em` carry the meanings their tags
 * already have, so emphasis stays in the accessibility tree instead of being
 * implied by a tone or a weight.
 *
 * No heading tag is offered, in any form: a heading is a document-outline
 * decision that `Heading` makes, and letting a body-text primitive emit one
 * would let a panel skip an outline level invisibly.
 */
export type TextElement = 'p' | 'span' | 'div' | 'small' | 'strong' | 'em';

/**
 * Type role to class name.
 *
 * A total `Record` over the union rather than a template string: the union and
 * the class list cannot drift apart, a typo is a compile error, and the lookup
 * yields `string` rather than `string | undefined` under
 * `noUncheckedIndexedAccess` — so no cast is needed to hand it to `clsx`.
 */
const SIZE_CLASS: Record<TextSize, string> = {
  lg: 'dg-text--lg',
  md: 'dg-text--md',
  sm: 'dg-text--sm',
  xs: 'dg-text--xs',
};

/** Tone to class name, total over the union for the same reasons as `SIZE_CLASS`. */
const TONE_CLASS: Record<TextTone, string> = {
  primary: 'dg-text--primary',
  secondary: 'dg-text--secondary',
  muted: 'dg-text--muted',
  accent: 'dg-text--accent',
  success: 'dg-text--success',
  warning: 'dg-text--warning',
  danger: 'dg-text--danger',
  info: 'dg-text--info',
};

/**
 * The inputs of one run of text.
 *
 * Extending `HTMLAttributes<HTMLElement>` is deliberate and is what keeps this
 * interface short: `id`, `title`, `lang`, `dir`, every `aria-*` attribute, the
 * event handlers and any `data-*` attribute reach the element through `...rest`
 * without being enumerated here, and they keep their standard types.
 *
 * `color` is the one attribute removed from that set. It is a presentational
 * HTML attribute that no token backs, and `tone` is how colour is chosen in
 * this design system (AAP 0.6.3, 0.6.4).
 */
export interface TextProps extends Omit<HTMLAttributes<HTMLElement>, 'color'> {
  /**
   * Which element to render. Pick the tag that matches the content's meaning —
   * `p` for prose, `strong` or `em` for emphasis that must be announced — and
   * leave it alone for a plain run of inline text.
   *
   * @default 'span'
   */
  as?: TextElement;

  /**
   * The type role, resolved from `--dg-text-lg`, `--dg-text-md`,
   * `--dg-text-sm` or `--dg-text-xs`. The role tokens are complete `font`
   * shorthands, so one class sets weight, size, line height and family
   * together.
   *
   * @default 'md'
   */
  size?: TextSize;

  /**
   * The text colour, resolved from `--dg-text-primary`, `--dg-text-secondary`,
   * `--dg-text-muted`, `--dg-accent`, `--dg-success`, `--dg-warning`,
   * `--dg-danger` or `--dg-info`.
   *
   * A tone is decoration and reinforcement, never the sole carrier of meaning:
   * a status expressed as a colour here must also be stated in the words this
   * component renders, or carried by a `Badge` that names it. The token values
   * are the ones the contrast ratios were computed against, which is a second
   * reason a tone is picked from this union rather than written as a colour.
   *
   * @default 'primary'
   */
  tone?: TextTone;

  /**
   * `'medium'` raises the weight for a label or a column header that has to
   * separate itself from the rows beneath it without changing size. It is the
   * same weight the `lg` role already carries, so pairing the two changes
   * nothing; `'regular'` leaves the role's own weight in place.
   *
   * @default 'regular'
   */
  weight?: 'regular' | 'medium';

  /**
   * Renders figures with `font-variant-numeric: tabular-nums`, so digits
   * occupy equal width and values line up down a column. Set it on counts,
   * durations, sizes and percentages in any table or metric — anywhere a
   * reader compares one row against the next (AAP 0.6.3).
   *
   * @default false
   */
  numeric?: boolean;

  /**
   * Clips the text to a single line with an ellipsis. The clip is VISUAL only:
   * the children are rendered in full and this component never shortens them in
   * JavaScript, so the complete value stays in the accessibility tree and stays
   * selectable and copyable.
   *
   * Because the ellipsis hides characters from a sighted reader, a caller that
   * truncates also supplies the full value another way — the usual form is a
   * `title` passed straight through, and a `dg-visually-hidden` sibling where
   * the full value must be announced rather than hovered.
   *
   * @default false
   */
  truncate?: boolean;

  /**
   * The text to render. A node rather than a string, so a run can carry an
   * inline `Code` fragment, a glyph or a count — never so it can nest a
   * control, which belongs in `Button` or a link.
   */
  children?: ReactNode;

  /**
   * A ref to the rendered element, typed as the common `HTMLElement` base
   * because `as` chooses the tag. React 19 passes `ref` as an ordinary prop, so
   * no `forwardRef` wrapper exists here and none should be added.
   *
   * It is here for the measuring a few components genuinely need — a label that
   * has to know whether it overflowed, an element a virtualized list scrolls
   * into view — not as a general escape hatch for imperative styling.
   */
  ref?: Ref<HTMLElement>;
}

/**
 * Renders one run of body text.
 *
 * Presentational and pure: no state, no effects, no hooks, nothing read from
 * the document while rendering, and no memoization — it re-renders with its
 * parent, deliberately, because this package's render behaviour is something
 * the product reports on rather than something a primitive should smooth over.
 *
 * `role`, `tabIndex` and `aria-hidden` are never set implicitly. A caller that
 * needs one passes it through, so nothing this component renders is silently
 * renamed, hidden from assistive technology or made focusable.
 *
 * @param props The design props above, plus any HTML attribute of the element.
 * @returns The single element named by `as`, carrying only the composed class
 *   attribute and the caller's own attributes — no wrapper, no inline style.
 *
 * @example
 * // A dense, right-aligned count in a table cell, with the full value on hover.
 * <Text size="sm" tone="muted" numeric truncate title="1,175">
 *   1,175
 * </Text>
 *
 * @example
 * // A paragraph of summary prose, and an emphasized status word beside it.
 * <Text as="p">The interaction resolved to one trace.</Text>
 * <Text as="strong" tone="warning" weight="medium">
 *   partial
 * </Text>
 */
export function Text(props: TextProps): ReactElement {
  const {
    as: element = 'span',
    size = 'md',
    tone = 'primary',
    weight = 'regular',
    numeric = false,
    truncate = false,
    children,
    className,
    ref,
    ...rest
  } = props;

  const classes = clsx(
    'dg-text',
    SIZE_CLASS[size],
    TONE_CLASS[tone],
    weight === 'medium' && 'dg-text--medium',
    numeric && 'dg-text--numeric',
    truncate && 'dg-text--truncate',
    className,
  );

  // The caller's attributes come first so the composed class name, the ref and
  // the children cannot be displaced by a stray passthrough of the same name.
  return createElement<HTMLAttributes<HTMLElement>, HTMLElement>(element, {
    ...rest,
    ref,
    className: classes,
    children,
  });
}
