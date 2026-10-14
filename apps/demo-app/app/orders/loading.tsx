/**
 * Lumen Supply - the order history's loading UI (`/orders`).
 *
 * Next.js renders this file as the Suspense fallback around `app/orders/page.tsx` while that page
 * is reading the account's orders - a client-side navigation shows it the moment the link is
 * followed, and it stays for as long as the read takes - and, being the nearest `loading.tsx`, it
 * replaces the root one, which cannot see this page and reserves no more than the heading block
 * every page opens with.
 *
 * The reservation follows the orders page's own composition, top to bottom:
 *
 *   - the breadcrumb trail's line, held to the reading measure;
 *   - the heading block - the page's `<h1>` and the sentence under it - as a bar and two lines;
 *   - the order list as a `.ls-section`: its head, which carries the list's title and count, as
 *     one bar, and then one slim card per order row, stacked closely because the loaded rows sit
 *     directly under one another with only a rule between them.
 *
 * Exactly one status region exists in this subtree, carrying the one busy message; every
 * `Skeleton` is `aria-hidden` by construction, so the wait is announced once. There is no main
 * landmark - `app/layout.tsx` owns it - no CSS Module (route files have the `.ls-*` utilities of
 * `app/globals.css` and the shared primitives, and nothing else), and no data access, clock or
 * random read: the fallback renders at once and identically on server and client.
 */

import type { ReactElement } from 'react';

import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';

/**
 * What the wait is announced as: a fragment about the content arriving, in the reader's terms, and
 * nothing about how long it is taking.
 */
const BUSY_MESSAGE = 'Loading your orders';

/**
 * How many order rows the list reserves: about a fold's worth of the history at a desktop height.
 * A choice about how much of the page to hold, never a statement about the account - nothing here
 * knows how many orders it has, or whether it has any.
 */
const RESERVED_ROW_COUNT = 6;

/** The row placeholders, as their indices; see `OrdersLoading` for why an index is the key. */
const ROWS = Array.from({ length: RESERVED_ROW_COUNT }, (_unused, index) => index);

/**
 * Render the order history's loading state.
 *
 * Next.js passes no props to a `loading` file, so this takes none. The rows are keyed by index,
 * which is correct in exactly this case: they are empty, interchangeable boxes in a list whose
 * only variable is its length, so an index key cannot move state or DOM to the wrong item.
 *
 * The status region is the list's own placeholder rather than a wrapper around the whole page, so
 * the region that announces the wait is the region that is waiting, and `aria-busy` is cleared for
 * all of it at once when the page replaces this subtree.
 */
export default function OrdersLoading(): ReactElement {
  return (
    <div className="ls-stack ls-stack-loose">
      <div className="ls-page-lede">
        <Skeleton shape="text" />
      </div>

      <div className="ls-page-head">
        <Skeleton shape="text" />

        <div className="ls-page-lede">
          <Skeleton shape="text" lines={2} />
        </div>
      </div>

      <div className="ls-section" role="status" aria-busy="true">
        <VisuallyHidden>{BUSY_MESSAGE}</VisuallyHidden>

        <Skeleton shape="text" />

        <div className="ls-stack ls-stack-tight">
          {ROWS.map((index) => (
            <Card key={index} pad="sm">
              <Skeleton shape="text" />
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
