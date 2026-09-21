/**
 * Lumen Supply - the loading placeholder.
 *
 * One grey box, or a short stack of them, holding the space content will occupy once it arrives.
 * The catalog grid reserves its cards with it, product detail its media and copy, the cart its
 * rows and the inventory dashboard its figures, so every loading state in the storefront shares
 * one surface and one motion instead of being improvised per page.
 *
 * WHAT IT OWNS, AND WHAT THE CALLER OWNS
 * It owns the placeholder's surface, its shape, and how many bars a text placeholder has. It owns
 * no geometry: how wide a bar is, how tall a media box stands and where either sits in a grid is
 * the placing component's business, handed in through `className` - the cart's thumbnail class,
 * the dashboard's figure class. That division is why there is no `width` or `height` prop. Two
 * sources for one box's size is one too many, and the caller is the side that knows the box it is
 * reserving; `Skeleton.module.css` also leaves a `--skeleton-size` hook for the callers that know
 * a length rather than a box.
 *
 * THE SHAPE IS AN ATTRIBUTE, NOT A LOOKED-UP CLASS
 * `Skeleton.module.css` exports three names - `root`, `lines`, `line` - and picks the three shapes
 * with `.root[data-shape='…']` selectors. So this component writes its prop straight to the DOM
 * and never indexes the styles object with a computed key: such a lookup is typed
 * `string | undefined` under this repository's `noUncheckedIndexedAccess`, and it hides a typo
 * until a box renders unstyled in a browser. An attribute is constrained by the prop union below
 * and is legible in the elements tree beside the class it qualifies.
 *
 * ACCESSIBILITY: DECORATIVE, DELIBERATELY
 * The outermost element carries `aria-hidden="true"` and holds no text, in either branch. A
 * loading catalog paints four dozen of these at once; announced, they would read out as four dozen
 * empty boxes in place of the one sentence a reader wants. The announcement belongs to the page,
 * not to the grey box: the caller states what is loading on the element that owns the busy state,
 * usually as `./VisuallyHidden` text, and this placeholder stays out of the accessibility tree
 * entirely.
 *
 * RENDER BEHAVIOUR
 * A plain function component - no state, no effects - and no client directive, so a server
 * component and a client component render it equally. Nothing is read from the clock,
 * `Math.random()` or `window` while rendering, so the markup the server sends and the markup the
 * browser first produces always agree.
 */

import clsx from 'clsx';

import type { ReactElement } from 'react';

import styles from './Skeleton.module.css';

/**
 * The placeholder's inputs.
 *
 * Local and deliberately not exported. A consumer that needs this shape reads it back with
 * `React.ComponentProps<typeof Skeleton>`; the repository's guard scripts treat an exported demo
 * identifier as vocabulary no product file may then mention, so a second exported name buys a
 * constraint and nothing else.
 *
 * Every optional member spells `| undefined` out, because this workspace compiles with
 * `exactOptionalPropertyTypes`, under which a bare `className?: string` means "absent or a
 * string" and rejects a present-but-undefined value. Realistic callers have one in hand: a CSS
 * Module lookup is `string | undefined` under `noUncheckedIndexedAccess`, and the documented
 * caller pattern is exactly `className={styles.someCell}`.
 */
interface Props {
  /**
   * Which of the stylesheet's three shapes to paint.
   *
   * `text` is a bar the height of one line of body copy, for a heading, a label or a sentence;
   * `block` fills the box it is given - an image frame, a chart area, a card body - which is the
   * caller's to give, as `className` describes; `circle` is a round slot for an avatar or a
   * thumbnail. Only `text` stacks, and only `text` reads `lines`.
   *
   * @default 'text'
   */
  shape?: 'text' | 'block' | 'circle' | undefined;

  /**
   * How many bars a `text` placeholder draws, for standing in for a paragraph rather than a single
   * line. Ignored by `block` and `circle`, which are one box by definition.
   *
   * More than one bar renders as a column, and the stylesheet shortens the last of several so the
   * group reads as prose instead of a slab of shading. Values below one are clamped to one bar
   * rather than rendering nothing: a placeholder that reserved no space would let the layout jump
   * when the content lands, which is the whole thing this component exists to prevent.
   *
   * @default 1
   */
  lines?: number | undefined;

  /**
   * The placing component's own class, carrying the size and position the placeholder cannot know
   * about. It lands on the outermost element in both branches, so a class that sizes a stack of
   * bars works exactly as one that sizes a single box.
   *
   * Size a box through the box, not through a bare `width`/`height` in this class. The stylesheet
   * already declares `width: 100%` for a placeholder and `height: var(--skeleton-size, 100%)` for
   * a `block`, and a class weighs no more than either of those, so a direct contest over the same
   * property is decided by the order a bundler happens to emit the two modules in. What holds
   * regardless of that order is a parent with a definite box, additive `min-`/`max-` bounds, an
   * `aspect-ratio`, or the module's own `--skeleton-size` property - which is why the storefront's
   * callers reserve their thumbnails and figures that way.
   */
  className?: string | undefined;
}

/**
 * Render a loading placeholder.
 *
 * @example
 * // A figure on the dashboard, a 4:3 thumbnail in the cart, and two lines of copy beside it.
 * <Skeleton shape="block" className={styles.skeletonValue} />
 * <Skeleton shape="block" className={styles.skeletonMedia} />
 * <Skeleton lines={2} className={styles.skeletonText} />
 */
export function Skeleton({ shape = 'text', lines = 1, className }: Props): ReactElement {
  /*
   * A whole number of bars, at least one, decided from the prop alone - no clock and no randomness,
   * so the server and the client always agree on how many children there are. The finiteness test
   * is what keeps `Infinity` (or a `NaN` arriving from an unguarded calculation) out of
   * `Array.from` below, which throws `RangeError: Invalid array length` on the first and silently
   * produces nothing on the second; both degrade to the single bar that any caller asking for a
   * placeholder wants at minimum.
   */
  const requested = Math.trunc(lines);
  const count = Number.isFinite(requested) ? Math.max(1, requested) : 1;

  if (shape === 'text' && count > 1) {
    /*
     * The multi-line form: `.lines` is the stylesheet's own wrapper - a column with the
     * storefront's tightest gap - and `.line` is one bar within it. They differ by one character
     * and a CSS Module gives no compile-time check for either, so read them against the class
     * contract at the top of `Skeleton.module.css` before touching this branch: a wrapper written
     * `styles.line`, or a child written `styles.lines`, typechecks perfectly and fails only in a
     * browser.
     *
     * `.root` is deliberately absent here. It paints a surface and takes a height from the shape
     * rules, both of which belong to the bars in this form, not to the box holding them; the
     * caller's own class still applies, because it is the side that sizes this column.
     *
     * The children are keyed by index, which is correct in precisely this case: they are empty,
     * interchangeable placeholders in a list whose only change is its length, so an index key can
     * never move state or DOM to the wrong item - there is neither to move.
     */
    return (
      <div className={clsx(styles.lines, className)} data-shape="text" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <span key={index} className={styles.line} />
        ))}
      </div>
    );
  }

  /*
   * One box: a single line of text, a block or a circle. A `<span>` rather than a `<div>` so the
   * placeholder is valid wherever the content it stands in for is - inside a `<p>`, a `<td>`, an
   * `<a>` or a `<button>` - and the stylesheet's `display: block` is what gives it the box that
   * `data-shape` then sizes.
   */
  return <span className={clsx(styles.root, className)} data-shape={shape} aria-hidden="true" />;
}
