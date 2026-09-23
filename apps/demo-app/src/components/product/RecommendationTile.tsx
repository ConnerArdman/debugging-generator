/**
 * Lumen Supply - one recommended product inside the recommendations strip.
 *
 * The strip appears twice on a product page: full size in the detail body, and as a short row
 * inside the site header. Both mounts render this same tile from the same props, and the whole
 * difference between them - a vertical card where a page has the room for one, and a thumbnail
 * beside a single line of name and price where the site header's fixed 64px bar does not - is
 * stated in `RecommendationTile.module.css` and selected by the `data-variant` attribute written
 * below. Nothing the tile does varies with the variant.
 *
 * ITS OWN PRESENTATION UNIT, NOT THE CATALOG'S CARD
 * The catalog has a product card of its own, and this tile deliberately borrows nothing from it:
 * no component, no stylesheet rule, no shared class. The two live in different places and answer
 * different questions - a catalog card is a shopping surface with a quantity and an add-to-cart
 * control, while a tile in this strip is a suggestion to look at something else - so the strip is
 * a link, a thumbnail, a name and a price. A strip that mounted the catalog's card would carry
 * that card's controls and everything they read into the site header on every page of the
 * storefront, which is both more markup than a suggestion needs and a second place where the
 * cart's behaviour would have to be reasoned about.
 *
 * A PURE PRESENTATIONAL COMPONENT
 * No `'use client'` directive, no hook, no state, no effect, no ref, and no `memo`, `useMemo` or
 * `useCallback` - the workspace's convention for a component that is a function of its props. It
 * therefore renders equally inside a server component and inside the client component that owns
 * the strip, and because nothing is read from `window`, `Date.now()` or `Math.random()` while
 * rendering, the markup the server sends and the markup the browser first produces always agree.
 *
 * ONE LINK, WITH NOTHING INTERACTIVE INSIDE IT
 * The whole tile is a single anchor, which is what makes a row of tiles one keyboard stop per
 * product and gives the thumbnail, the name and the price the same target. Its accessible name is
 * computed from its own contents, and no button, checkbox or second link is placed inside it: an
 * interactive element nested in a link is unreachable for some readers and ambiguous for the
 * rest. Choosing a quantity and adding to the cart belong to the product page this tile
 * navigates to.
 *
 * TEXT AND MONEY BELONG TO THEIR OWNERS
 * The figure is `@/components/ui/Price`, which takes the payload's whole number of cents and owns
 * every formatting decision; nothing here does arithmetic on an amount or spells one out. The
 * name is printed exactly as it arrives and is clamped by the stylesheet - to two lines in the
 * page, to one in the header - rather than shortened here, so the full wording stays selectable
 * and searchable while a row of tiles keeps one height.
 *
 * ELEMENTS
 * The anchor from `next/link` wrapping `<span class="media"> > <img>` and `<span class="body"> >
 * <span class="name"> + the price + `<span class="reason">`, that last one only when the payload
 * words one. The two wrappers are spans rather than divs so the tile is phrasing content
 * throughout and stays valid wherever the strip places it; the stylesheet makes them the boxes it
 * needs - `.root` and `.body` are flex containers, which blockifies their children. All seven
 * classes the module exports are used here, composed with `clsx`, and nothing is set with an
 * inline style.
 */

import clsx from 'clsx';
import Link from 'next/link';
import type { ReactElement } from 'react';

import { Price } from '@/components/ui/Price';
import type { RecommendationItem } from '@/lib/types';

import styles from './RecommendationTile.module.css';

/**
 * The drawing shown for a product that has no artwork of its own, which is most of the catalog:
 * `apps/demo-app/public/products/` holds a handful of pictures and the seed creates far more
 * products than that.
 *
 * A literal path into `public/`, never a static asset import: that form is typed by the ambient
 * declarations Next.js generates into the git-ignored `next-env.d.ts`, so a clean clone that has
 * never run a build would fail `pnpm typecheck` on it. A plain image element also needs no image
 * configuration of any kind - the optimiser skips SVG regardless - and it shares its intrinsic
 * 400 x 300 with the rest of the product artwork, so the frame below fits either source.
 */
const PLACEHOLDER_IMAGE = '/products/product-placeholder.svg';

/**
 * The tile's inputs. Local and deliberately not exported, like every other props type in this
 * workspace: the strip that places a tile writes `ComponentProps<typeof RecommendationTile>`
 * rather than putting a second name for this shape into circulation.
 *
 * The two optional properties are spelled `| undefined` because the workspace compiles with
 * `exactOptionalPropertyTypes`, under which an optional property does not accept an explicit
 * `undefined`. The strip can therefore forward a value it holds as optional itself - a variant it
 * takes from its own caller, a class it may or may not have - instead of assembling the element's
 * props conditionally.
 */
interface Props {
  /**
   * The suggested product, as `/api/recommendations` returns one. Its `slug` is the route this
   * tile navigates to, `name` is the text it prints, `priceCents` the figure, `imageUrl` the
   * thumbnail when the product has one, and `reason` the endpoint's own line about why the
   * product is being suggested, printed under the figure wherever the tile has room for it.
   */
  item: RecommendationItem;

  /**
   * Which of the stylesheet's two measures to paint: `detail` for the strip in a product page's
   * body, `compact` for the shorter row in the site header. Presentation only - the tile renders
   * the same elements, the same text and the same destination either way.
   *
   * @default 'detail'
   */
  variant?: 'detail' | 'compact' | undefined;

  /**
   * An extra class from the placing component, for a position or a margin a tile cannot know
   * about. It is composed after the base class, so it wins on equal specificity; the variant
   * rules are attribute-qualified and are unaffected by it.
   */
  className?: string | undefined;
}

/**
 * Renders one suggestion as a link to its product page.
 *
 * @example
 * ```tsx
 * // Inside the strip, which owns the list and the scrolling around it.
 * <ul className={styles.list}>
 *   {items.map((item) => (
 *     <li key={item.productId} className={styles.item}>
 *       <RecommendationTile item={item} variant={variant} />
 *     </li>
 *   ))}
 * </ul>
 * ```
 */
export function RecommendationTile({ item, variant = 'detail', className }: Props): ReactElement {
  // A product without a picture arrives as `null`, and a row that holds an empty string says the
  // same thing, so both resolve to the shared drawing before anything renders. Deciding it from
  // the value rather than from a failed request is what keeps the element from ever being pointed
  // at a file that is not there: there is no request to fail and no broken-image frame to appear
  // while it does. Nothing else about the address is repaired - a URL that is present but wrong
  // shows as the picture it names, which is the payload's problem and not this tile's to hide.
  const src =
    item.imageUrl === null || item.imageUrl.length === 0 ? PLACEHOLDER_IMAGE : item.imageUrl;

  // Why this product is being suggested, as `/api/recommendations` words it - "In the same
  // category as <the product on screen>". The endpoint always sends the field, so what is guarded
  // here is its content rather than its presence: it is trimmed of the surrounding whitespace a
  // payload can carry, and a value that holds nothing else renders no element at all. An empty
  // footnote would still take its line of the tile and lengthen the row's tiles to say nothing,
  // and the stylesheet's clamp cannot take back a line it has already reserved.
  const reason = item.reason.trim();

  return (
    <Link
      href={`/products/${item.slug}`}
      className={clsx(styles.root, className)}
      data-variant={variant}
    >
      <span className={styles.media}>
        {/*
          The artwork's intrinsic 400 x 300 travels as the width and height attributes, so the
          frame is reserved before the file arrives and the strip does not shift as its tiles
          paint. The stylesheet then fits the drawing inside that frame, and keeps the frame
          legible on its own when images are turned off.

          `alt=""` because the thumbnail is decorative here: it is a product photograph, most often
          the shared placeholder drawing, inside a link that already prints the product's name and
          its price as text. Naming it after the product would put that name into the link's
          accessible name twice - which is what a reader hears, once for the image and once for the
          text beside it - and say nothing a buyer has not already been told. The catalog's
          `ProductCard` and the cart's `CartLineRow` treat their thumbnails the same way, for the
          same reason.
        */}
        <img className={styles.image} src={src} alt="" width={400} height={300} />
      </span>
      <span className={styles.body}>
        <span className={styles.name}>{item.name}</span>
        <Price cents={item.priceCents} size="sm" className={styles.price} />
        {/*
          The endpoint's own merchandising line, printed under the figure. It is inside the anchor
          like the name and the price, so it joins the link's accessible name and a reader hears
          why the suggestion is being made rather than only what it is; it is phrasing content and
          adds no second target inside the link. The stylesheet mutes it, lets it wrap in full -
          the sentence ends in the name of the product on screen, which is the part a clamp would
          cut - and leaves it out of the header's row, which has no height for a footnote at all:
          `display: none`
          takes it out of that layout and out of that link's accessible name alike, so a reader
          there hears the name and the price, exactly as they are shown.
        */}
        {reason.length === 0 ? null : <span className={styles.reason}>{reason}</span>}
      </span>
    </Link>
  );
}
