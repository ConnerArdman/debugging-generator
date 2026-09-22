/*
 * Lumen Supply - the cart at its own address (`/cart`).
 *
 * The route is the full-page reading of what a buyer has collected: the lines themselves, what
 * they come to, and the two ways on from here. `SiteHeader`'s slide-over quotes the same cart in
 * the same words, because both surfaces compose the same two components; this page is the version
 * a buyer can sit with, print, or leave open in a tab while they check a part number.
 *
 * A SERVER COMPONENT THAT READS NOTHING
 * There is no `'use client'` directive and no data access of any kind: nothing from `@/server/**`,
 * no service call, no `fetch`, no cookie or header read and no environment read. This is the one
 * route of the storefront with no server-side read at all, and the reason is structural rather
 * than an omission - the cart's contents belong to the provider that `app/layout.tsx` mounts, so
 * the two components below already hold everything this page would otherwise have gone looking
 * for. Reading the cart here as well would put a second answer on the page, and the two could
 * disagree the moment a quantity changed.
 *
 * WHAT THE PAGE OWNS
 * Four things, and nothing else: the ancestry trail, the heading block, the arrangement of the two
 * columns, and the two destinations at the foot. Every piece of cart behaviour - a failure a
 * reader can act on and its retry control, the placeholders shown while the cart is first read,
 * the empty block, the lines with their quantity steppers and remove controls, the units, the
 * subtotal, the free-freight wording and the dispatch promise - belongs to `CartLineList` and
 * `CartTotalsPanel`. Restating any of it here would give the cart two descriptions in one
 * document and one file to forget when the other changed.
 *
 * That includes the state where the storefront has not established what the cart holds, which is
 * why both blocks are mounted unconditionally below. A server component cannot read the cart -
 * its contents belong to the client provider - so the decision cannot be taken here at all, and
 * it does not need to be: `@/hooks/useCartSummary` publishes either the cart's totals or the
 * reason there are none, and each block resolves that for itself. `CartTotalsPanel` withholds
 * every figure while the contents are unestablished, printing the state in their place rather
 * than a subtotal of nothing, and `CartLineList` carries the failure notice with its retry, or
 * the placeholders while the first read is in flight. Gating either of them from this file would
 * be this page deciding a question it has no way to answer.
 *
 * WHY EACH COMPONENT IS PASSED SO LITTLE
 * `variant="page"` is the whole of the configuration, and it is what selects the roomier of the two
 * arrangements each component declares - the list scrolls with the document rather than capping
 * itself, and the totals block takes the page's padding step and a level-two heading, which is the
 * right level beneath the heading below. No `emptySlot` is given: the component's own empty block
 * is written for a reader who arrived at the cart's own address, which is exactly this placing. No
 * `summary` is given either, because the totals component reads the cart for itself, and handing
 * it a second figure from here would mean this file had derived one.
 *
 * THE TRAIL IS PAGE CONTENT
 * `app/layout.tsx` mounts `PageContainer` with no heading props, and a page cannot pass props into
 * the layout's own instance, so the trail is rendered here as the first thing in the page's
 * content and the heading below it is this page's own. For the same reason this file renders no
 * main landmark and no container of its own: `PageContainer` owns the document's single main
 * region, the one carrying `id="main"` that the header's "Skip to content" link points at, and a
 * second one would give assistive technology two to choose between.
 *
 * NO CLOCK, NO CACHE, NO BUILD-TIME READ
 * Nothing here reads the current time or any other value that could differ between the server's
 * markup and the browser's first pass over it, so this route raises no hydration warning of its
 * own. `dynamic = 'force-dynamic'` is restated below as this segment's own contract, and with no
 * read on the path there is nothing here to cache or revalidate.
 *
 * CLASS CONTRACT
 * Route files under `app/` compose with the `.ls-*` utilities in `app/globals.css` and add no CSS
 * Module, so the nine class names below are the whole of this page's styling: `.ls-stack` with its
 * `.ls-stack-loose` step for the page's rhythm, `.ls-page-head` with `.ls-page-title` and
 * `.ls-page-lede` for the heading block, `.ls-split` with `.ls-split-main` and `.ls-split-side`
 * for the two columns, and `.ls-actions` for the row at the foot. There is no inline `style`, no colour, spacing or
 * type value of any kind, and no artwork - the one illustration this route can show belongs to the
 * empty block inside `CartLineList`, which names it by key rather than importing a file.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';

import { CartLineList } from '@/components/cart/CartLineList';
import { CartTotalsPanel } from '@/components/cart/CartTotalsPanel';
import { BreadcrumbTrail, type BreadcrumbCrumb } from '@/components/layout/BreadcrumbTrail';

/* ---------------------------------------------------------------------------
 * Copy
 *
 * Upper-case by convention, and the convention earns its keep:
 * `scripts/check-no-hardcoding.mjs` harvests this workspace's declared names
 * with two or more camel-case tokens into the vocabulary no product file may
 * then mention, and drops a name with no camel boundary. A constant spelled
 * this way costs the product nothing.
 * ------------------------------------------------------------------------- */

/** The page's heading, the tab's title and the final crumb, declared once so the three agree. */
const PAGE_TITLE = 'Cart';

/**
 * The sentence under the heading: what this page is for, and what happens next.
 *
 * It quotes no figure and names no line. Every number on this page is printed by the component
 * that derived it, so a count or an amount written into this sentence would be a second claim
 * about the same cart with nothing keeping the two in step.
 */
const PAGE_LEDE =
  'Everything you have collected so far, with the quantities and the order total as they stand. ' +
  'Adjust a line or remove it here, then continue to checkout to choose a delivery option and ' +
  'place the order.';

/**
 * The ancestry the trail prints. Two entries, which is the least `BreadcrumbTrail` renders
 * anything for: the storefront's entry point, and this page itself with no destination, which is
 * the one crumb it marks as current.
 */
const CRUMBS: readonly BreadcrumbCrumb[] = [{ label: 'Catalog', href: '/' }, { label: PAGE_TITLE }];

/** The way forward, in a buyer's words rather than the router's. */
const CHECKOUT_LABEL = 'Proceed to checkout';

/** The way back, for a buyer who is still adding to the cart rather than finishing with it. */
const CATALOG_LABEL = 'Continue shopping';

/**
 * Rendering mode for this segment: one pass per request, and nothing read at build time.
 *
 * The root layout declares the same value for the whole application, and it is restated here
 * because the guarantee is this segment's own: `next build` reaches for no database to produce
 * this route, so a clean clone builds with a placeholder connection string and nothing listening.
 * Hence no `generateStaticParams`, no `revalidate`, no `fetchCache` and no `runtime` override -
 * the segment runs on Node, like every other route of the storefront.
 */
export const dynamic = 'force-dynamic';

/**
 * The tab's title. Short and static: the store's name belongs to the root layout, which declares
 * it once as both the fallback title and the `'%s · Lumen Supply'` template every nested route
 * inherits, so naming it again here would print it twice. There is nothing a request could change
 * about this title, which is why it is a `metadata` export rather than a `generateMetadata`
 * function.
 */
export const metadata: Metadata = { title: PAGE_TITLE };

/**
 * The cart page: the trail, the heading, the lines beside their totals, and the two ways on.
 *
 * The two columns are a `.ls-split`, which is a single column until there is room for the second
 * one, so the page needs no breakpoint of its own. The lines come first in the document, and
 * therefore first in reading and keyboard order, with the totals beside them on a wide viewport
 * and beneath them on a narrow one. The row at the foot follows both, so a buyer reaches the cart
 * they are deciding about before the decision.
 *
 * Both destinations are plain anchors. A link that navigates is an anchor, and wrapping one in a
 * control would nest two interactive elements and announce the pair twice; the wording carries
 * where each one goes, so neither needs a label of its own. They are offered unconditionally,
 * because this file holds no cart to test - an empty cart still shows the way back to the catalog,
 * and the checkout route answers an empty cart itself.
 *
 * @returns The page's content, which the layout places inside the document's single main region.
 */
export default function CartPage(): ReactElement {
  return (
    <div className="ls-stack ls-stack-loose">
      <BreadcrumbTrail items={CRUMBS} />

      <div className="ls-page-head">
        <h1 className="ls-page-title">{PAGE_TITLE}</h1>
        <p className="ls-page-lede">{PAGE_LEDE}</p>
      </div>

      <div className="ls-split">
        <div className="ls-split-main">
          <CartLineList variant="page" />
        </div>

        <div className="ls-split-side">
          <CartTotalsPanel variant="page" />
        </div>
      </div>

      <div className="ls-actions">
        <Link href="/checkout">{CHECKOUT_LABEL}</Link>
        <Link href="/">{CATALOG_LABEL}</Link>
      </div>
    </div>
  );
}
