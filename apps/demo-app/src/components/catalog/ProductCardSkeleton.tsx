/*
 * Lumen Supply - the catalog's loading state.
 *
 * A grid of card-shaped placeholders that stands in for the product grid while the catalog's data
 * resolves. Its job is to reserve the box the loaded grid will occupy - the same track sizing and
 * gutters, and the same order inside one card: media, title, meta, actions - so the page holds
 * still when the real cards arrive. `app/loading.tsx` renders it, and any catalog surface waiting
 * on data can.
 *
 * COMPOSITION
 * Geometry comes from `./ProductCardSkeleton.module.css` and from nowhere else. `.root`, `.grid`,
 * `.card`, `.media`, `.body`, `.meta` and `.actions` are that stylesheet's whole vocabulary, and
 * every class named below is one of them: no length, colour or breakpoint is written into this
 * file. The surface of a card is `@/components/ui/Card` and the surface of a placeholder is
 * `@/components/ui/Skeleton`; neither is restyled here, and each is given only the props its own
 * module declares.
 *
 * The placeholder standing in for product artwork sits *inside* the `.media` box rather than
 * wearing that class itself. The box is the side that carries the 4:3 ratio, clips its corners and
 * owns the stylesheet's `.media > *` rule, which makes its child fill it - so the reserved shape is
 * a property of the box, and does not depend on how a percentage height happens to resolve against
 * the row above it. `Skeleton`'s own module documents the same division: a `block` placeholder
 * fills the box its caller gives it.
 *
 * ACCESSIBILITY: ONE MESSAGE, ONE BUSY REGION
 * `Skeleton` is `aria-hidden` by construction and the grid is hidden as a whole, so a reader is
 * told what is loading once instead of hearing four dozen empty boxes. `role="status"` and
 * `aria-busy="true"` sit on the same element as that single piece of text, which is what lets the
 * wait be announced politely and be reported as over once real content replaces this subtree.
 *
 * SERVER COMPONENT
 * No client directive, no hook, no event handler, no browser global, and nothing read from the
 * clock or a random source: the markup is a function of the two props alone, so what a server
 * renders and what a browser first produces always agree.
 */

import type { ReactElement } from 'react';

import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';

import styles from './ProductCardSkeleton.module.css';

/**
 * Cards reserved when a caller states no count - roughly a first screen of the catalog grid at a
 * desktop width, which is the width the wait is most visible at.
 */
const DEFAULT_CARD_COUNT = 12;

/**
 * The fewest cards this component will paint. A loading state that reserved no space at all would
 * let the page jump exactly when the content it stands in for lands, which is the one thing it
 * exists to prevent.
 */
const MIN_CARD_COUNT = 1;

/**
 * The most it will paint, whatever it is handed. The catalog serves a page of products at a time,
 * and a placeholder grid longer than the page it precedes reserves space the loaded grid will not
 * fill.
 */
const MAX_CARD_COUNT = 48;

/** The announcement used when a caller states no label, or states a blank one. */
const DEFAULT_LABEL = 'Loading products';

/**
 * Props of {@link ProductCardSkeleton}.
 *
 * Exported, unlike the local `Props` of the `@/components/ui` primitives, because this component
 * stands between a route's `loading.tsx` and the grid: a catalog surface that forwards a page size
 * or its own wording needs the shape to type that pass-through.
 *
 * Both members spell `| undefined` out, because this workspace compiles with
 * `exactOptionalPropertyTypes`: under it a bare `count?: number` means "absent or a number" and
 * rejects a present-but-undefined value, which is precisely what a forwarded optional - a page
 * size read from a search parameter, say - is typed as.
 */
export interface ProductCardSkeletonProps {
  /**
   * How many placeholder cards to reserve. The value is truncated and clamped to the 1-48 range,
   * and a `NaN` - the shape an unguarded `Number()` or `parseInt()` of a query string takes -
   * falls back to the default, so a caller computing this can produce neither an empty grid nor
   * an unbounded one.
   *
   * @default 12
   */
  count?: number | undefined;

  /**
   * What the page is waiting for, in the reader's terms. It becomes the busy region's only
   * accessible text, so it reads as a sentence fragment about content ("Loading products",
   * "Loading search results") rather than as a component name.
   *
   * @default 'Loading products'
   */
  label?: string | undefined;
}

/**
 * Render the catalog's placeholder grid.
 *
 * @example
 * // A route's loading state, and a narrower surface that reserves one row.
 * <ProductCardSkeleton />
 * <ProductCardSkeleton count={4} label="Loading search results" />
 */
export function ProductCardSkeleton({
  count = DEFAULT_CARD_COUNT,
  label = DEFAULT_LABEL,
}: ProductCardSkeletonProps): ReactElement {
  /*
   * A whole number of cards inside the supported range, decided from the prop alone.
   *
   * `NaN` is the one value the clamp below cannot repair, so it is answered first: `Math.trunc`
   * returns it unchanged, `Math.min`/`Math.max` propagate it because every comparison against it
   * is false, and `Array.from({ length: NaN })` then yields an empty array - a loading state that
   * silently reserves nothing, which is the failure this component exists to prevent. The test is
   * `Number.isNaN` rather than `Number.isFinite` on purpose: the two infinities are perfectly
   * clampable, and they mean "as many as allowed" and "as few as allowed" rather than "no count
   * was given".
   */
  const requested = Number.isNaN(count) ? DEFAULT_CARD_COUNT : count;
  const cardCount = Math.min(Math.max(Math.trunc(requested), MIN_CARD_COUNT), MAX_CARD_COUNT);

  /*
   * `Array.from` with a mapper, rather than `new Array(n).map()`, which skips holes and would
   * produce nothing at all. The values are the indices, and they are the keys below: the cards are
   * empty, interchangeable placeholders in a list whose only variable is its length, so an index
   * key cannot move state or DOM to the wrong item - there is neither to move.
   */
  const placeholders = Array.from({ length: cardCount }, (_unused, index) => index);

  /*
   * A blank label would leave the busy region with no accessible text, which is a silent status
   * message rather than a quiet one, so an all-whitespace string is treated as absent.
   */
  const announcement = label.trim() === '' ? DEFAULT_LABEL : label;

  return (
    <div className={styles.root} role="status" aria-busy="true">
      <VisuallyHidden>{announcement}</VisuallyHidden>

      <div className={styles.grid} aria-hidden="true">
        {placeholders.map((index) => (
          <Card key={index} pad="md" className={styles.card}>
            <div className={styles.media}>
              <Skeleton shape="block" />
            </div>

            <div className={styles.body}>
              <Skeleton shape="text" lines={2} />
            </div>

            <div className={styles.meta}>
              <Skeleton shape="text" lines={1} />
            </div>

            <div className={styles.actions}>
              <Skeleton shape="block" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
