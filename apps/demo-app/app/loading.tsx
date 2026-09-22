/**
 * Lumen Supply - the root segment's loading UI.
 *
 * Next.js renders this file in place of `{children}` while a route beneath the root layout
 * resolves, and swaps it for the page the moment that route's markup is ready. It is the only
 * loading boundary the storefront declares, so it stands in for every route that does not bring
 * one of its own - the catalog at `/`, and equally the cart, checkout, the order list and the
 * inventory dashboard - which is why nothing below names a route, a filter, a sort order or any
 * other wording that belongs to one page rather than all of them.
 *
 * WHAT IT RESERVES, AND WHY THAT SHAPE
 * A page of this application opens with a heading block and continues with a grid, a table or a
 * list of cards, so the reservation is the same two pieces: the head's two lines of type, then a
 * grid of card-shaped placeholders. Reserving the box the content will occupy - rather than
 * centring a spinner in an empty region - is what keeps the header, navigation and footer still
 * while the swap happens, and it is what makes the wait read as "this page is arriving" instead
 * of "something is happening somewhere".
 *
 * Twelve cards, not the catalog's full page of forty-eight: a dozen fills a desktop fold and a
 * little past it, which is as much as a reader can see while the wait lasts. Reserving the whole
 * page would claim screen space that a shorter route - the cart, an order list - is never going
 * to fill.
 *
 * COMPOSITION: THE PAGE UTILITIES AND TWO COMPONENTS, NOTHING ELSE
 * Route files under `app/**` declare no CSS Module of their own, so the arrangement here comes
 * from the documented `.ls-*` page-composition utilities in `app/globals.css` - `.ls-stack` for
 * the page's vertical rhythm, `.ls-page-head` for the heading block, `.ls-page-lede` for the
 * sentence measure under a title - and every painted surface comes from a component:
 * `@/components/ui/Skeleton` for one placeholder bar and `@/components/catalog/ProductCardSkeleton`
 * for the grid. No length, colour or breakpoint is written into this file, and no element here
 * carries a style attribute.
 *
 * Both utilities sit on elements this file owns rather than on an element a component renders.
 * That division is `globals.css`'s own: a component's module is emitted after the global
 * stylesheet, so a utility placed on a component's root loses the cascade for every property the
 * module also declares - which is the right outcome, since the component owns its own box, but it
 * would leave the class silently doing nothing. Hence the small wrapper around the lede
 * placeholder: the measure belongs to the page, the surface belongs to `Skeleton`.
 *
 * ACCESSIBILITY: ONE STATUS MESSAGE, AND NO DECORATION IN THE TREE
 * Exactly one busy region exists in this subtree, and `ProductCardSkeleton` is what renders it:
 * it carries `role="status"` and `aria-busy="true"` on the element that holds its own
 * screen-reader text, so the wait is announced once, politely, and is reported as over when real
 * content replaces this tree. Nothing here wraps that in a second status region or adds a
 * competing live region, because two of them would announce the same wait twice. The head's
 * placeholders are `aria-hidden` by construction - `Skeleton` renders them that way, holds no
 * text and this file adds none - so a reader hears the message and not the grey boxes, and the
 * busy state is never carried by motion alone: the placeholder stays a visible reserved box when
 * `Skeleton.module.css` stops its shimmer for a reader who has asked for less motion.
 *
 * A SERVER COMPONENT THAT READS NOTHING
 * No client-component directive at the top of this file, no hook, no event handler and no browser
 * global - and nothing read from the clock, the environment or a random source, so this file
 * renders identically for every request and the markup a server sends always matches the markup a
 * browser first produces. There is no data access of any kind either: a loading boundary that
 * queried the database would delay the very swap it exists to cover, and it would break
 * `next build`, which renders this route with no database reachable.
 *
 * There is also deliberately no route segment configuration here. `dynamic`, `revalidate` and
 * `runtime` are honoured in `layout.tsx`, `page.tsx` and `route.ts` only; `app/layout.tsx` already
 * declares `dynamic = 'force-dynamic'` for every segment beneath it, and a second declaration in
 * this file would be inert rather than additive.
 */

import type { ReactElement } from 'react';

import { ProductCardSkeleton } from '@/components/catalog/ProductCardSkeleton';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * How many placeholder cards the grid reserves.
 *
 * A dozen is about a desktop fold's worth of the catalog's `auto-fill` grid, and it is a sensible
 * reservation for the shorter routes this boundary also covers. `ProductCardSkeleton` clamps
 * whatever it is handed into its own supported range, so this value is a choice about how much of
 * the fold to hold, never a bound.
 */
const RESERVED_CARD_COUNT = 12;

/**
 * What the wait is announced as.
 *
 * It is stated here rather than left to the component's default so that the one sentence a reader
 * hears is legible in the file that causes it to be spoken. It reads as a fragment about content
 * arriving, which is what a status message should say - not a component name, and nothing about
 * how long the arrival is taking.
 */
const BUSY_MESSAGE = 'Loading products';

/**
 * Render the storefront's loading state.
 *
 * Next.js passes no props to a `loading` file, so this takes none; it is a plain synchronous
 * function component whose output depends on nothing outside this module.
 *
 * The tree is three elements deep and each one is here for a stated reason:
 *
 *   - `.ls-stack` is the page's own column: it puts the storefront's standard gap between the
 *     heading block and the grid, so the two sit on the same rhythm a loaded page uses.
 *   - `.ls-page-head` reserves the heading block - a page's `<h1>` with its sentence underneath -
 *     with a bar for each. The title bar takes the full measure and the lede bar is held to the
 *     reading measure by the wrapper around it, so the block reads as a heading and a sentence
 *     rather than as two identical rules across the page.
 *   - `ProductCardSkeleton` reserves the content grid and owns the busy region, the announcement
 *     and the card geometry.
 *
 * No `<main>` element and no second `PageContainer` appear here: `app/layout.tsx` owns the
 * document's single main landmark and this content renders inside it, so another one would give
 * assistive technology two landmarks to choose between and break the header's "Skip to content"
 * link.
 */
export default function CatalogLoading(): ReactElement {
  return (
    <div className="ls-stack">
      <div className="ls-page-head">
        <Skeleton shape="text" />

        <div className="ls-page-lede">
          <Skeleton shape="text" />
        </div>
      </div>

      <ProductCardSkeleton count={RESERVED_CARD_COUNT} label={BUSY_MESSAGE} />
    </div>
  );
}
