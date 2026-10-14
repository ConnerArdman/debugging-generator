/**
 * Lumen Supply - the checkout route's loading UI (`/checkout`).
 *
 * Next.js renders this file as the Suspense fallback around `app/checkout/page.tsx` while that
 * page is on its way, and, being the nearest `loading.tsx`, it replaces the root one, which cannot
 * see this page and reserves no more than the heading block every page opens with.
 *
 * The reservation follows the checkout page's own composition, top to bottom:
 *
 *   - the breadcrumb trail's line, held to the reading measure;
 *   - the heading block - the page's `<h1>` and the sentence under it - as a bar and two lines;
 *   - the `.ls-split` the page lays its two columns out in. The main column is the form's run of
 *     sections, each a title bar over a column of field-height boxes, spaced as the form spaces its
 *     own sections; the side column is the order review, a card with a head and its rows of lines
 *     and figures.
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
const BUSY_MESSAGE = 'Loading checkout';

/**
 * The form's sections as the number of fields each reserves, in page order: contact details,
 * the shipping address and the delivery options. The delivery-notes section after them is left
 * out: it is the last and shortest of the four, and the reservation is for what a reader sees
 * first rather than a full inventory of the form.
 *
 * Each field is one `block` placeholder. In a column that gives it no height of its own it stands
 * at the skeleton stylesheet's minimum block size, about one control tall, so the column reads as
 * fields waiting for their values.
 */
const SECTION_FIELDS: readonly number[] = [3, 5, 3];

/** Bars in the order-review placeholder: its lines, then the subtotal, freight and total rows. */
const REVIEW_BARS = 6;

/**
 * Render the checkout's loading state.
 *
 * Next.js passes no props to a `loading` file, so this takes none. Sections and fields are keyed by
 * their position, which is correct in exactly this case: they are empty, interchangeable boxes in
 * fixed lists whose only variable is their length, so a positional key cannot move state or DOM to
 * the wrong item.
 *
 * The status region wraps the columns rather than sitting beside them, so the region that
 * announces the wait is the region that is waiting, and `aria-busy` is cleared for all of it at
 * once when the page replaces this subtree.
 */
export default function CheckoutLoading(): ReactElement {
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
          <div className="ls-split-main ls-stack ls-stack-loose">
            {SECTION_FIELDS.map((fields, section) => (
              <div key={section} className="ls-section">
                <div className="ls-page-lede">
                  <Skeleton shape="text" />
                </div>

                <div className="ls-stack ls-stack-tight">
                  {Array.from({ length: fields }, (_unused, field) => (
                    <Skeleton key={field} shape="block" />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="ls-split-side">
            <Card pad="lg" head={<Skeleton shape="text" />}>
              <Skeleton shape="text" lines={REVIEW_BARS} />
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
