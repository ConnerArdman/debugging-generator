/**
 * Lumen Supply - a product page's loading UI (`/products/[slug]`).
 *
 * Next.js renders this file as the Suspense fallback around `app/products/[slug]/page.tsx` while
 * that page is reading its product - a catalog card or a suggestion tile shows it the moment it is
 * followed, and it stays for as long as the read takes - and, being the nearest `loading.tsx`, it
 * replaces the root one, which cannot see this page and reserves no more than the heading block
 * every page opens with.
 *
 * It is also the boundary this route streams under, which is what `page.tsx` and `proxy.ts` plan
 * around: a response streamed through a loading boundary has sent its `200` before the page can
 * raise a not-found signal, so the 404 for a slug no product owns is decided by `proxy.ts` before
 * rendering begins, exactly as it was while the root boundary was the nearest one.
 *
 * The reservation follows the product page's own composition, top to bottom:
 *
 *   - the breadcrumb trail's line, held to the reading measure;
 *   - the heading block - the product's name as the page's `<h1>` and its description under it -
 *     as a bar and two lines;
 *   - the `.ls-split` the page lays the product out in. The main column is the gallery's frame: a
 *     full-width box at the 4:3 ratio the product artwork is drawn to, which the placeholder
 *     fills. The side column is the selling panel - the stock badge, the price, the add-to-cart
 *     control and the specification list - as a bar, a bar, a control-height box and a card of
 *     rows.
 *
 * The suggestion strip below the product is not reserved: it arrives after the page, from its own
 * request, and holds its own loading state when it does.
 *
 * ONLY STYLESHEETS THE ROOT SHELL HAS ALREADY LOADED
 * A loading file can only paint once every stylesheet it draws with is in the document: React
 * holds back a boundary whose stylesheet is still downloading and shows the nearest boundary above
 * it instead - here the root `app/loading.tsx`, which knows nothing of the product. A reader
 * following a catalog card to a product has not loaded this route's styles yet, so a class from
 * the product components (the gallery's own frame, say) would keep this file off the screen for
 * exactly as long as it is needed. It therefore draws only with what every page of the storefront
 * has already loaded: the `.ls-*` utilities of `app/globals.css`, the `ui` primitives the root
 * layout renders, and the stylesheet of `ProductCardSkeleton` - the root loading file's own
 * placeholder, part of the root segment on every route - whose `.media` box is the full-width 4:3
 * artwork frame this file needs. It adds no CSS Module of its own.
 *
 * Exactly one status region exists in this subtree, carrying the one busy message; every
 * `Skeleton` is `aria-hidden` by construction, so the wait is announced once. There is no main
 * landmark - `app/layout.tsx` owns it - and no data access, clock or random read: the fallback
 * renders at once and identically on server and client.
 */

import type { ReactElement } from 'react';

import catalogSkeletonStyles from '@/components/catalog/ProductCardSkeleton.module.css';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';

/**
 * What the wait is announced as: a fragment about the content arriving, in the reader's terms, and
 * nothing about how long it is taking.
 */
const BUSY_MESSAGE = 'Loading product details';

/** Bars in the specification placeholder: about the rows a product's list opens with. */
const SPEC_BARS = 5;

/**
 * Render a product page's loading state.
 *
 * Next.js passes no props to a `loading` file - not even the slug - so this takes none, and it is
 * the same for every product: nothing about the product is known until the page has read it.
 *
 * The status region wraps the columns rather than sitting beside them, so the region that
 * announces the wait is the region that is waiting, and `aria-busy` is cleared for all of it at
 * once when the page replaces this subtree.
 */
export default function ProductDetailLoading(): ReactElement {
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
        <VisuallyHidden>{BUSY_MESSAGE}</VisuallyHidden>

        <div className="ls-split">
          <div className="ls-split-main">
            {/*
             * `.media` is a full-width block at the artwork's 4:3 ratio whose child fills it, so
             * the placeholder stands exactly as wide and as tall as the gallery frame will.
             */}
            <div className={catalogSkeletonStyles.media}>
              <Skeleton shape="block" />
            </div>
          </div>

          <div className="ls-split-side ls-stack">
            <Skeleton shape="text" />
            <Skeleton shape="text" />
            <Skeleton shape="block" />

            <Card pad="md">
              <Skeleton shape="text" lines={SPEC_BARS} />
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
