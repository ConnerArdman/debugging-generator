/**
 * Lumen Supply - the cart route's loading UI (`/cart`).
 *
 * Next.js renders this file as the Suspense fallback around `app/cart/page.tsx` while that page is
 * on its way - a client-side navigation shows it the moment the link is followed - and, being the
 * nearest `loading.tsx`, it replaces the root one, which cannot see this page and reserves no more
 * than the heading block every page opens with.
 *
 * The reservation follows the cart page's own composition, top to bottom, so the header, the
 * navigation and the footer stay still and the page's blocks land where their placeholders were:
 *
 *   - the breadcrumb trail's line, held to the reading measure;
 *   - the heading block - the page's `<h1>` and the sentence under it - as a bar and two lines;
 *   - the `.ls-split` the page lays its two columns out in: the cart's lines in the main column,
 *     one card per line, and the totals panel in the side column, a card with a head and its rows
 *     of figures.
 *
 * Exactly one status region exists in this subtree, carrying the one busy message; every
 * `Skeleton` is `aria-hidden` by construction, so the wait is announced once and nothing else is
 * read. There is no main landmark - `app/layout.tsx` owns it - no CSS Module (route files have the
 * `.ls-*` utilities of `app/globals.css` and the shared primitives, and nothing else), and no data
 * access, clock or random read: the fallback renders at once and identically on server and client.
 */

import type { ReactElement } from 'react';

import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';

/**
 * What the wait is announced as: a fragment about the content arriving, in the reader's terms, and
 * nothing about how long it is taking.
 */
const BUSY_MESSAGE = 'Loading your cart';

/**
 * How many line placeholders the main column reserves - a few rows, which is what a working cart
 * usually holds and as much as a reader takes in while the wait lasts. A choice about how much of
 * the column to hold, never a statement about the cart: nothing here knows what it contains.
 */
const RESERVED_LINE_COUNT = 3;

/** Bars per line placeholder: the product's name and the line's quantity and amount beneath it. */
const LINE_BARS = 2;

/** Bars in the totals placeholder: the subtotal, freight, tax and total rows. */
const TOTAL_BARS = 4;

/** The line placeholders, as their indices; see `CartLoading` for why an index is the key. */
const LINES = Array.from({ length: RESERVED_LINE_COUNT }, (_unused, index) => index);

/**
 * Render the cart's loading state.
 *
 * Next.js passes no props to a `loading` file, so this takes none. The line placeholders are keyed
 * by index, which is correct in exactly this case: they are empty, interchangeable boxes in a list
 * whose only variable is its length, so an index key cannot move state or DOM to the wrong item.
 *
 * The status region wraps the columns rather than sitting beside them, so the region that
 * announces the wait is the region that is waiting, and `aria-busy` is cleared for all of it at
 * once when the page replaces this subtree.
 */
export default function CartLoading(): ReactElement {
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

      <div role="status" aria-busy="true">
        <VisuallyHidden>{BUSY_MESSAGE}</VisuallyHidden>

        <div className="ls-split">
          <div className="ls-split-main ls-stack">
            {LINES.map((index) => (
              <Card key={index} pad="md">
                <Skeleton shape="text" lines={LINE_BARS} />
              </Card>
            ))}
          </div>

          <div className="ls-split-side">
            <Card pad="lg" head={<Skeleton shape="text" />}>
              <Skeleton shape="text" lines={TOTAL_BARS} />
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
