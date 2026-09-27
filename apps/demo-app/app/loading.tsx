'use client';

/**
 * Lumen Supply - the root segment's loading UI: the catalog's, and a neutral one everywhere else.
 *
 * Next.js renders this file as the Suspense fallback around the root layout's `{children}`, and a
 * route's nearest `loading.tsx` is the one that shows during a client-side navigation. Every other
 * page of the storefront declares its own - `app/cart`, `app/checkout`, `app/orders`,
 * `app/dashboard` and `app/products/[slug]` - each shaped like the page it stands in for and
 * announcing that page's wait, so a navigation shows this file only on the way to the catalog, or
 * to an address no route answers while the not-found page is on its way.
 *
 * WHY IT READS THE ADDRESS
 * A full document load is different. The server sends the page shell before the route's own
 * segment is ready, so the first paint of every route - the cart, a product, the dashboard alike -
 * holds the root boundary's fallback, and React reveals streamed boundaries in batches, so it stays
 * up for a few hundred milliseconds before the page replaces it in one step. A catalog grid
 * announcing "Loading products" in that moment would describe the wrong page on every address but
 * one. So this file renders the catalog's skeleton only on the catalog's own address, and on any
 * other a neutral reservation - the breadcrumb line and the heading block every page of the
 * storefront opens with - announcing only that a page is on its way. That is also why it is a
 * Client Component: `usePathname` is how a loading file, which receives no props, learns where it
 * is, and it answers the same on the server render and in the browser, so the choice never
 * changes between the two.
 *
 * A route under a loading boundary streams under a `200` status sent before it renders, so a
 * `notFound()` raised there cannot change the status. That is why the 404 for a slug no product
 * owns is decided before rendering, by `proxy.ts` - the product route's own boundary behaves as
 * this one did for it - and a dotted address naming no public file is sent to the not-found route
 * by the rewrite in `next.config.ts`.
 *
 * The catalog's reservation is the heading block every page opens with, then twelve card
 * placeholders in the catalog's grid, so the header, navigation and footer stay still when the
 * content swaps in. Exactly one status region exists in either subtree - rendered by
 * `ProductCardSkeleton` on the catalog, and by this file otherwise - carrying the one busy message;
 * every placeholder is `aria-hidden`, so the wait is announced once. There is no main landmark -
 * `app/layout.tsx` owns it - and no data access, clock or random read: the fallback must render at
 * once and identically on server and client, and `next build` renders it with no database
 * reachable.
 */

import { usePathname } from 'next/navigation';
import type { ReactElement } from 'react';

import { ProductCardSkeleton } from '@/components/catalog/ProductCardSkeleton';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';

/**
 * The catalog's address: the root page, `app/page.tsx`. Its search and paging live in the query
 * string, which `usePathname` leaves out, so every state of the listing matches it.
 */
const CATALOG_PATH = '/';

/**
 * How many placeholder cards the catalog grid reserves.
 *
 * A dozen is about a desktop fold's worth of the catalog's `auto-fill` grid, which is as much as a
 * reader can take in while the wait lasts. `ProductCardSkeleton` clamps whatever it is handed into
 * its own supported range, so this value is a choice about how much of the fold to hold, never a
 * bound.
 */
const RESERVED_CARD_COUNT = 12;

/**
 * What the catalog's wait is announced as.
 *
 * It is stated here rather than left to the component's default so that the one sentence a reader
 * hears is legible in the file that causes it to be spoken. It reads as a fragment about content
 * arriving, which is what a status message should say - not a component name, and nothing about
 * how long the arrival is taking.
 */
const BUSY_MESSAGE = 'Loading products';

/**
 * What any other page's wait is announced as: that a page is arriving, and nothing about which
 * content, because this file does not know what the page holds - only the route's own loading file
 * does, and it takes over from this one on a navigation.
 */
const PAGE_BUSY_MESSAGE = 'Loading the page';

/**
 * Render the root segment's loading state.
 *
 * Named for the catalog, the one page whose shape it reserves. Next.js passes no props to a
 * `loading` file, so this takes none; its output depends only on the address, which is the same on
 * the server and in the browser.
 *
 * Each branch is built from the same parts, and each part is here for a stated reason:
 *
 *   - `.ls-stack` is the page's own column: it puts the storefront's standard gap between the
 *     heading block and what follows, so the two sit on the same rhythm a loaded page uses.
 *   - `.ls-page-head` reserves the heading block - a page's `<h1>` with its sentence underneath -
 *     with a bar for each. The title bar takes the full measure and the lede bar is held to the
 *     reading measure by the wrapper around it, so the block reads as a heading and a sentence
 *     rather than as two identical rules across the page. The measure sits on a wrapper because
 *     a utility placed on `Skeleton`'s own root would lose the cascade to its module class.
 *   - On the catalog, `ProductCardSkeleton` reserves the content grid and owns the busy region,
 *     the announcement and the card geometry. Anywhere else, the breadcrumb line every other page
 *     opens with comes first, and the status region is this file's own, holding only its message:
 *     a content reservation here would be a guess at a page this file cannot see.
 *
 * No `<main>` element and no second `PageContainer` appear here: `app/layout.tsx` owns the
 * document's single main landmark and this content renders inside it, so another one would give
 * assistive technology two landmarks to choose between and break the header's "Skip to content"
 * link.
 */
export default function CatalogLoading(): ReactElement {
  const pathname = usePathname();

  if (pathname !== CATALOG_PATH) {
    return (
      <div className="ls-stack">
        <div className="ls-page-lede">
          <Skeleton shape="text" />
        </div>

        <div className="ls-page-head">
          <Skeleton shape="text" />

          <div className="ls-page-lede">
            <Skeleton shape="text" lines={2} />
          </div>
        </div>

        <div role="status" aria-busy="true">
          <VisuallyHidden>{PAGE_BUSY_MESSAGE}</VisuallyHidden>
        </div>
      </div>
    );
  }

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
