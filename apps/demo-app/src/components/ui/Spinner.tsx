/*
 * Lumen Supply - the busy indicator: one rotating ring shown while a request the reader started is
 * still in flight. The element is empty; `Spinner.module.css` paints all of it.
 *
 * Decorative by contract: `aria-hidden="true"`, with no role, label, live region or text. The
 * announcement belongs to the control or region that owns the request, the only place that knows
 * what is being waited for - a control names its wait with adjacent hidden text, a region marks
 * itself `aria-busy`. A `role="status"` here would make each of its many placements a separate
 * live region repeating a generic "loading".
 *
 *     <button type="button" aria-busy={submitting} disabled={submitting}>
 *       {submitting ? <Spinner /> : null}
 *       {submitting ? <VisuallyHidden>Placing order</VisuallyHidden> : 'Place order'}
 *     </button>
 *
 * The size is a `data-size` attribute, not a class looked up in `styles`. Rotation and its
 * reduced-motion behaviour live in the stylesheet: under `prefers-reduced-motion: reduce` the ring
 * stops turning but keeps its size and accent arc. No state, effects or client directive, and no
 * media-query read during render, so it renders on either side and server and client markup agree.
 */

import clsx from 'clsx';

import styles from './Spinner.module.css';

/**
 * The indicator's inputs. Local and deliberately not exported: a caller that needs this shape reads
 * it back with `React.ComponentProps<typeof Spinner>`. There is no `children`, no label and no tone
 * prop - text belongs to the caller (see the contract above), and the ring takes its colours from
 * the storefront's `--ls-*` tokens rather than from a prop.
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
