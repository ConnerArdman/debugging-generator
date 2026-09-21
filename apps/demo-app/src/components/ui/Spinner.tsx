/*
 * Lumen Supply - the busy indicator.
 *
 * One rotating ring, shown while a request the reader started is still in flight: inside a
 * button's label as the cart or the checkout posts, and beside a line of inline "loading" copy on
 * the catalog and dashboard surfaces. It is the whole of this component - the element is empty,
 * and every pixel of it is painted by `Spinner.module.css`.
 *
 * DECORATIVE BY CONTRACT, NOT BY OVERSIGHT
 * The span carries `aria-hidden="true"` and has no `role`, no `aria-label`, no `aria-live` and no
 * text, so it contributes nothing to the accessibility tree. The announcement belongs to the
 * surface that owns the request, which is the only place that knows what is being waited for and
 * how often it changes: a control names its wait with adjacent hidden text, a region marks itself
 * `aria-busy`. This primitive renders in dozens of places, and a `role="status"` in here would
 * turn each of them into an independent live region - a reader would hear the same generic
 * "loading" announced repeatedly, from places it could neither locate nor silence, and the
 * duplicates would be loudest during exactly the repeated interactions this application exists to
 * be observed through.
 *
 *     <button type="button" aria-busy={submitting} disabled={submitting}>
 *       {submitting ? (
 *         <>
 *           <Spinner />
 *           <VisuallyHidden>Placing order</VisuallyHidden>
 *         </>
 *       ) : (
 *         'Place order'
 *       )}
 *     </button>
 *
 * Colour is never the sole carrier of meaning here either: the ring says only "something is in
 * flight", and what that something is always reaches the reader as text from the caller.
 *
 * THE SIZE IS AN ATTRIBUTE, NOT A LOOKED-UP CLASS
 * `Spinner.module.css` exports exactly one class, `root`, and selects the two non-default sizes
 * with `.root[data-size='sm']` and `.root[data-size='lg']`, each of which sets a single custom
 * property that the width, the height and nothing else read. So this component forwards its prop
 * straight into an attribute and never indexes the styles object: a variant class would have to be
 * read through a computed key, which this repository's `noUncheckedIndexedAccess` types as
 * `string | undefined`, hiding a typo until the ring renders unstyled in a browser. An attribute
 * is constrained by the prop union below, cannot be applied without the base rule, and is legible
 * in the elements tree - which is what this application is here to be inspected with.
 *
 * MOTION
 * The rotation and its reduced-motion behaviour are the stylesheet's: under
 * `prefers-reduced-motion: reduce` the ring stops turning and keeps its size, its accent arc and
 * its place in the line, so a reader who asked for less motion still sees that work is in
 * progress. There is no JavaScript motion here to keep in step with that, and deliberately no
 * media-query read during render, which would have to happen in the browser and would make the
 * server's markup and the browser's first markup disagree.
 *
 * RENDER BEHAVIOUR
 * A plain function component: no `memo`, no memoised props, no state, no effects, no `ref`
 * forwarding, and nothing read from `window`, `Date.now()` or `Math.random()` while rendering, so
 * the markup the server sends and the markup the browser first produces always agree. It
 * re-renders whenever its parent does, deliberately: this application's render behaviour is the
 * subject under investigation rather than something for a primitive to smooth over. Holding no
 * hooks, and carrying no client directive either, lets a server component and a client component
 * render it equally - which matters, because the surfaces that wait on data are of both kinds.
 */

import clsx from 'clsx';

import styles from './Spinner.module.css';

/**
 * The indicator's inputs. Local and deliberately not exported: `packages/panel-renderer` declares
 * its own primitives, and a caller that needs this shape reads it back from the component with
 * `React.ComponentProps<typeof Spinner>` rather than importing a second name for it. There is no
 * `children`, no label and no tone prop - text belongs to the caller (see the contract above), and
 * the ring takes its colours from the storefront's `--ls-*` tokens rather than from a prop.
 */
interface Props {
  /**
   * Which of the stylesheet's three diameters to paint. Each is taken from the type scale rather
   * than the spacing scale, because the ring nearly always sits beside type and matching the text
   * size is what keeps it optically the same weight as its neighbour: `sm` (13px) for a dense
   * table cell or a compact control, `md` (15px) for body copy and ordinary buttons, `lg` (24px)
   * for a section or page that is waiting as a whole.
   *
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';

  /**
   * An extra class from the placing component, for the margin or the grid position the indicator
   * cannot know about. It is composed after the base class, so it wins on equal specificity; the
   * size rules are attribute-qualified and are not affected by it.
   */
  className?: string;
}

/**
 * Renders one busy indicator.
 *
 * `styles.root` is typed `string | undefined` under `noUncheckedIndexedAccess`, which `className`
 * accepts as-is, and `clsx` drops it when it is absent: a missing class would mean the stylesheet
 * failed to load, and an unstyled empty span is then invisible rather than a bare square - the
 * safe direction to fail in for an element that carries no information of its own.
 *
 * @example
 * // Beside inline copy the reader can see, and as a whole section's indicator. The first names
 * // its wait in visible text, so it needs no hidden label; the second is announced by the region
 * // that owns it.
 * <p aria-busy="true">
 *   <Spinner size="sm" /> <span>Checking stock</span>
 * </p>
 * <Spinner size="lg" className={sectionStyles.indicator} />
 */
export function Spinner({ size = 'md', className }: Props) {
  return <span className={clsx(styles.root, className)} data-size={size} aria-hidden="true" />;
}
