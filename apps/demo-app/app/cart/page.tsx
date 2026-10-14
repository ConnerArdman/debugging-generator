/*
 * Lumen Supply - the cart at its own address (`/cart`).
 *
 * A server component that reads nothing: no `'use client'`, no service call, no `fetch` and no
 * cookie, header or environment read. The cart's contents belong to the client provider that
 * `app/layout.tsx` mounts, so a read here would put a second answer on the page that could
 * disagree the moment a quantity changed. For the same reason `CartLineList`, `CartTotalsPanel`
 * and `CartPageActions` are mounted unconditionally and each resolves the cart's state itself -
 * loading, failed, empty or populated - so this page never decides what the cart holds.
 *
 * It renders no main landmark and no container: `PageContainer` in the layout owns the document's
 * single main region, the one carrying `id="main"`, and the trail and heading below are this
 * page's own content inside it. `dynamic = 'force-dynamic'` is restated as this segment's own
 * contract.
 */

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

import { CartLineList } from '@/components/cart/CartLineList';
import { CartPageActions } from '@/components/cart/CartPageActions';
import { CartTotalsPanel } from '@/components/cart/CartTotalsPanel';
import { BreadcrumbTrail, type BreadcrumbCrumb } from '@/components/layout/BreadcrumbTrail';

/* Copy: the storefront wording this page prints, each string declared once. */

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
 * The cart page: the trail, the heading, the lines beside their totals, and the row of actions.
 *
 * The two columns are a `.ls-split`, which is a single column until there is room for the second
 * one, so the page needs no breakpoint of its own. The lines come first in the document, and
 * therefore first in reading and keyboard order, with the totals beside them on a wide viewport
 * and beneath them on a narrow one. The row at the foot follows both, so a buyer reaches the cart
 * they are deciding about before the decision.
 *
 * The destinations themselves are `CartPageActions`, which is one line here and everything there:
 * both are plain anchors wearing the button stylesheet's own class, because a link that navigates
 * is an anchor and wrapping one in a control would nest two interactive elements and announce the
 * pair twice; the wording carries where each one goes, so neither needs a label of its own. Which
 * of them a given cart can offer is that component's to answer, since it is the layer that can
 * read the cart - checkout for a cart known to hold a line, the catalog in every state - and this
 * file supplies only the row they sit in.
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
        <CartPageActions />
      </div>
    </div>
  );
}
