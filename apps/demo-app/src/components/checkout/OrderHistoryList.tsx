/**
 * Lumen Supply - the order history.
 *
 * The collection around the rows: the heading and the result count, the visible column-header
 * strip, the `<ul>` that holds one `./OrderHistoryRow` per order, the pager, and the block that
 * stands in for all of it when a customer has not ordered anything yet. One row is
 * `./OrderHistoryRow`'s `<li>`; the hairline between rows, the strip's tracks and the pager's
 * chrome are `./OrderHistoryList.module.css`'s. This is the same split the cart group draws
 * between its line list and its line row.
 *
 * A SERVER COMPONENT, AND WHY PAGING IS LINKS
 * There is no client-component directive here, no hook of any kind, no state, no effect, no event
 * handler and no browser read. `app/orders/page.tsx` resolves the page of orders and passes it in
 * as a `PagedList<OrderSummary>`, so this component is a function of its props alone - it adds no
 * client component of its own to the orders page, and the markup it sends is the markup the
 * browser keeps.
 *
 * That constraint decides how a reader moves between pages. A server component cannot read the
 * address bar - the hook that reports the query string runs in a client component only - and it
 * cannot hold the page it is on either, so every destination
 * is spelled out as a real `next/link` anchor over `pageHrefBase`, and the page the list is
 * showing comes from the payload rather than from a second reading of the address bar - the two
 * can then never disagree. Real anchors also bring the platform's own affordances: middle-click
 * and Ctrl/Cmd-click open a page in a new tab, hovering previews the destination, "Copy link
 * address" yields a URL that works, and assistive technology announces a link as a link.
 *
 * The unavailable direction - Previous on the first page, Next on the last - is a `<span>`, not a
 * disabled anchor: a `<span>` has no activation behaviour to intercept and no tab stop to remove,
 * and there is no such thing as a disabled link. Both directions are always rendered so the strip
 * keeps its shape as the reader moves through the pages.
 *
 * NOTHING HERE READS THE CLOCK, AND NOTHING FORMATS ITS OWN NUMBERS
 * No clock read of any kind, and no randomness: relative date wording needs an instant to measure
 * against, so the caller's `referenceIso` is forwarded to each row and a row without one prints
 * the absolute date alone. The one number this file prints goes through `@/lib/format`, which
 * pins its locale explicitly - that pinning is what keeps the server-rendered markup and its
 * hydrated counterpart byte-identical.
 *
 * DEFENSIVE ARITHMETIC
 * `page`, `pageSize` and `total` describe a query string a reader can type by hand, so all three
 * are treated as untrusted: a zero or negative page size, a negative or non-finite total and a
 * page past the end are each folded into the nearest sensible whole number rather than propagated
 * into a division, an out-of-range link or a `NaN` on screen.
 *
 * ACCESSIBILITY
 * The orders are a real `<ul>` of `<li>`s, so assistive technology announces how many there are;
 * nothing bolts a table role onto that list. Every row labels its own cells, which is why the
 * visible strip above them is `aria-hidden` - it repeats those labels for sighted readers and
 * would otherwise be announced as four loose words with no relationship to anything. The pager is
 * a labelled `<nav>` landmark, each direction extends its visible word with screen-reader-only
 * text so it is announced as "Previous page" rather than "Previous", and the position is stated in
 * words beside the links rather than left to their colour. Focus rings belong to the stylesheets.
 */

import clsx from 'clsx';
import Link from 'next/link';

import type { ReactElement } from 'react';

import { BlankSlate } from '@/components/ui/BlankSlate';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { formatQuantityLabel } from '@/lib/format';
import type { OrderSummary, PagedList } from '@/lib/types';

import { OrderHistoryRow } from './OrderHistoryRow';
import styles from './OrderHistoryList.module.css';

/** The heading a caller that has nothing more specific to say gets. */
const DEFAULT_HEADING = 'Your orders';

/** Where an order's own page lives, and where a page of this list lives. */
const DEFAULT_HREF_BASE = '/orders';

/** The query parameter the pager rewrites, leaving every other one exactly as the reader left it. */
const PAGE_PARAM = 'page';

/**
 * The strip's labels, in the order `OrderHistoryList.module.css` places them - the same order a row
 * puts its cells in, and the reason the last two are end-aligned there: a quantity and a sum are
 * read from their last digit.
 */
const COLUMN_LABELS = ['Order', 'Status', 'Items', 'Total'] as const;

/** The accessible name of the paging landmark. */
const PAGER_LABEL = 'Order history pages';

/** The empty state's heading, and the sentence under it. */
const EMPTY_HEADING = 'No orders yet';
const EMPTY_BODY =
  'Orders placed from this account appear here, newest first, with what each one cost and how far along it is. Add something to your cart from the catalog to place the first one.';

/**
 * Alternative text for the empty state's illustration.
 *
 * It describes the drawing - `public/illustrations/empty-orders.svg`, a clipboard holding one blank
 * ruled slip with two more fanned behind it - rather than restating the heading above it, so a
 * screen reader is not told the same thing twice and is not told about a picture that is not there.
 */
const EMPTY_ART_ALT = 'A clipboard holding one blank ruled slip, with two more fanned behind it.';

/** Returns `value` when it is a usable number, and `fallback` for `NaN` and the infinities. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The address of page `page` of a list based at `base`.
 *
 * `base` is split once into the three parts a URL can carry, so a query the caller already put on
 * it survives - a status filter, a date range - while `page` is *set* rather than appended, which
 * replaces an existing value instead of adding a second one. A fragment stays at the end, where
 * the syntax requires it.
 *
 * Total and free of ambient input: the same arguments always produce the same address, and no
 * argument can make it throw.
 *
 * @param base Path the list is served from, optionally with its own query and fragment.
 * @param page 1-based page to address.
 * @returns A relative URL with `page` set to `page`.
 */
function hrefForPage(base: string, page: number): string {
  // Both are offsets into the string, and `-1` is "this part is absent".
  const fragment = base.indexOf('#');
  const hash = fragment === -1 ? '' : base.slice(fragment);
  const address = fragment === -1 ? base : base.slice(0, fragment);

  const separator = address.indexOf('?');
  const path = separator === -1 ? address : address.slice(0, separator);
  const params = new URLSearchParams(separator === -1 ? '' : address.slice(separator + 1));

  params.set(PAGE_PARAM, String(page));

  return `${path}?${params.toString()}${hash}`;
}

/**
 * The list's inputs.
 *
 * Local and deliberately not exported, like every other props type in this workspace: a caller
 * that needs the shape writes `ComponentProps<typeof OrderHistoryList>` rather than putting a
 * second name into circulation. The optional fields are spelled `?: T | undefined` because
 * `exactOptionalPropertyTypes` is on here, so a caller may pass a value it is still resolving
 * straight through instead of assembling the element's props conditionally.
 *
 * Every field is serializable on purpose. This is a server component rendering another one, and a
 * function prop - an href builder, a page handler - would either force a client boundary or simply
 * not survive the crossing.
 */
interface Props {
  /**
   * The page of orders to show, exactly as the route received it: `items` in the order the query
   * returned them, `total` counting every order the query matched rather than the ones on this
   * page, and `page` 1-based.
   */
  orders: PagedList<OrderSummary>;

  /**
   * The instant relative date wording is measured against - a timestamp the server computed for
   * the whole page, so every row on it agrees. Forwarded to each row and used nowhere else here.
   * Leave it out and the rows print absolute dates alone.
   */
  referenceIso?: string | undefined;

  /**
   * The section's heading, and its accessible name.
   *
   * @default 'Your orders'
   */
  heading?: string | undefined;

  /**
   * The path an order's own page hangs off, forwarded to each row, which appends the order's
   * identifier to it.
   *
   * @default '/orders'
   */
  hrefBase?: string | undefined;

  /**
   * The path this list is served from, which the pager rewrites the `page` parameter of. It is
   * separate from `hrefBase` because a list embedded somewhere other than the orders page still
   * links each row to the order's own page under `/orders`.
   *
   * @default '/orders'
   */
  pageHrefBase?: string | undefined;

  /** The placing page's own class, for the geometry a list cannot know about. */
  className?: string | undefined;
}

/**
 * Render a page of the order history, or the block that says there is nothing in it yet.
 *
 * @example
 * // On the orders page, from the payload the route already resolved.
 * <OrderHistoryList orders={page} referenceIso={renderedAt} />
 */
export function OrderHistoryList({
  orders,
  referenceIso,
  heading = DEFAULT_HEADING,
  hrefBase = DEFAULT_HREF_BASE,
  pageHrefBase = DEFAULT_HREF_BASE,
  className,
}: Props): ReactElement {
  const items = orders.items;

  /*
   * A page holds at least one order, and a page size the payload does not state is taken to be
   * the page it delivered - the best available reading, and never a divisor of zero below.
   */
  const safePageSize = Math.max(1, Math.trunc(finiteOr(orders.pageSize, items.length)));

  /*
   * Never fewer matches than the rows in hand: a payload whose count disagrees with its own items
   * would otherwise have this list printing "0 orders" above a page of them.
   */
  const total = Math.max(items.length, Math.trunc(Math.max(0, finiteOr(orders.total, 0))));

  const pageCount = Math.max(1, Math.ceil(total / safePageSize));
  const currentPage = Math.min(Math.max(1, Math.trunc(finiteOr(orders.page, 1))), pageCount);

  const count = `${formatQuantityLabel(total)} ${total === 1 ? 'order' : 'orders'}`;

  return (
    <section className={clsx(styles.root, className)} aria-label={heading}>
      <div className={styles.head}>
        <h2 className={styles.heading}>{heading}</h2>
        <p className={styles.count}>{count}</p>
      </div>

      {items.length === 0 ? (
        /*
         * `.empty` is placement - it centres the block and gives it its block margin - so it goes
         * on a wrapper rather than on `BlankSlate`, whose own module owns the column the
         * illustration, heading and sentence are stacked in.
         *
         * No `action`: this file has no token-styled anchor of its own (`.pagerLink` is the
         * pager's, and `ui/Button` renders a `<button>`), so a control here would be either an
         * unstyled link or a class used against its stated purpose. The sentence names the
         * catalog, and the site header links to it from every page.
         */
        <div className={styles.empty}>
          <BlankSlate art="empty-orders" alt={EMPTY_ART_ALT} heading={EMPTY_HEADING}>
            {EMPTY_BODY}
          </BlankSlate>
        </div>
      ) : (
        <>
          {/*
            Hidden from assistive technology on purpose: every row already labels each of its own
            cells, because the stylesheet removes this strip as soon as the rows stack. Announcing
            it as well would read as four loose words attached to nothing.
          */}
          <div className={styles.columns} aria-hidden="true">
            {COLUMN_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>

          <ul className={styles.list}>
            {items.map((order) => (
              /*
               * The key is the order's own identifier - stable across pages and renders in a way
               * an array index is not, since the same row appears at a different offset as newer
               * orders arrive.
               */
              <OrderHistoryRow
                key={order.id}
                order={order}
                referenceIso={referenceIso}
                hrefBase={hrefBase}
              />
            ))}
          </ul>

          {/* Rendered only when there is more history than one page holds. */}
          {pageCount > 1 ? (
            <nav className={styles.pager} aria-label={PAGER_LABEL}>
              <p className={styles.pagerStatus}>
                {`Page ${formatQuantityLabel(currentPage)} of ${formatQuantityLabel(pageCount)}`}
              </p>

              <div className={styles.pagerLinks}>
                {currentPage > 1 ? (
                  <Link
                    className={styles.pagerLink}
                    href={hrefForPage(pageHrefBase, currentPage - 1)}
                    rel="prev"
                  >
                    Previous
                    <VisuallyHidden>{' page'}</VisuallyHidden>
                  </Link>
                ) : (
                  <span className={styles.pagerLinkDisabled} aria-disabled="true">
                    Previous
                    <VisuallyHidden>{' page'}</VisuallyHidden>
                  </span>
                )}

                {currentPage < pageCount ? (
                  <Link
                    className={styles.pagerLink}
                    href={hrefForPage(pageHrefBase, currentPage + 1)}
                    rel="next"
                  >
                    Next
                    <VisuallyHidden>{' page'}</VisuallyHidden>
                  </Link>
                ) : (
                  <span className={styles.pagerLinkDisabled} aria-disabled="true">
                    Next
                    <VisuallyHidden>{' page'}</VisuallyHidden>
                  </span>
                )}
              </div>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
