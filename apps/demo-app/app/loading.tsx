/**
 * Lumen Supply - the root segment's loading UI.
 *
 * Next.js renders this file as the Suspense fallback around the root layout's `{children}`, so it
 * is the loading state of the catalog and of every route beneath the root layout that declares no
 * `loading.tsx` of its own. Nothing here depends on which route is waiting.
 *
 * Because the boundary also wraps `/products/[slug]`, that route streams under a `200` status sent
 * before it renders, and a `notFound()` raised there cannot change the status. The 404 for
 * a slug no product owns is therefore decided before rendering, by `proxy.ts`, and a dotted address
 * naming no public file is sent to the not-found route by the rewrite in `next.config.ts`.
 *
 * The reservation is the heading block every page opens with, then twelve card placeholders in the
 * catalog's grid, so the header, navigation and footer stay still when the content swaps in.
 * Exactly one status region exists in this subtree, rendered by `ProductCardSkeleton` with the busy
 * message; the heading placeholders are `aria-hidden`, so the wait is announced once. There is no
 * main landmark - `app/layout.tsx` owns it - and no data access, clock or random read: the fallback
 * must render at once and identically on server and client, and `next build` renders it with no
 * database reachable.
 */

import type { ReactElement } from 'react';

import { ProductCardSkeleton } from '@/components/catalog/ProductCardSkeleton';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * How many placeholder cards the grid reserves.
 *
 * A dozen is about a desktop fold's worth of the catalog's `auto-fill` grid, which is as much as a
 * reader can take in while the wait lasts. `ProductCardSkeleton` clamps whatever it is handed into
 * its own supported range, so this value is a choice about how much of the fold to hold, never a
 * bound.
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
 * Render the root segment's loading state.
 *
 * Named for the catalog listing whose shape it reserves; it is the fallback for every route the
 * root boundary covers. Next.js passes no props to a `loading` file, so this takes none; it is a
 * plain synchronous function component whose output depends on nothing outside this module.
 *
 * The tree is three elements deep and each one is here for a stated reason:
 *
 *   - `.ls-stack` is the page's own column: it puts the storefront's standard gap between the
 *     heading block and the grid, so the two sit on the same rhythm a loaded page uses.
 *   - `.ls-page-head` reserves the heading block - a page's `<h1>` with its sentence underneath -
 *     with a bar for each. The title bar takes the full measure and the lede bar is held to the
 *     reading measure by the wrapper around it, so the block reads as a heading and a sentence
 *     rather than as two identical rules across the page. The measure sits on a wrapper because
 *     a utility placed on `Skeleton`'s own root would lose the cascade to its module class.
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
