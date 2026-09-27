/**
 * Lumen Supply - the order history.
 *
 * The collection around the rows: the heading and the result count, the line that says a filter is
 * narrowing the list, the visible column-header strip, the `<ul>` that holds one
 * `./OrderHistoryRow` per order, the pager, and the block that stands in for the rows when this
 * page of the listing holds none. One row is `./OrderHistoryRow`'s `<li>`; the hairline between
 * rows, the strip's tracks and the pager's chrome are `./OrderHistoryList.module.css`'s. This is
 * the same split the cart group draws between its line list and its line row.
 *
 * THREE WAYS TO BE EMPTY, AND A WAY OUT OF TWO OF THEM
 * An empty page of orders is not one situation. The account may never have ordered; a filter may
 * have matched none of the orders it does have; or the address may name a page past the end of a
 * listing that matched plenty. The payload distinguishes them - `total` counts what the query
 * matched, not what this page carries - so the block below says which one it is and offers the
 * corresponding way out: the unfiltered listing, or the first page. Saying "no orders yet" to a
 * customer holding nine of them, which one sentence for all three cases amounts to, is simply
 * untrue, and the result count printed directly above it says as much.
 *
 * The pager takes no part in that: it states which page of rows the reader is on, and a window
 * past the end of the listing is on no page at all, so it stays with the rows and the blank slate
 * carries the route back.
 *
 * A SERVER COMPONENT, AND WHY PAGING IS LINKS
 * There is no client-component directive here, no hook of any kind, no state, no effect, no event
 * handler and no browser read. `app/orders/page.tsx` resolves the page of orders and passes it in
 * as a `PagedList<OrderSummary>`, so this component is a function of its props alone - it adds no
 * client component of its own to the orders page, and the markup it sends is the markup the
 * browser keeps. That page reads the orders from `GET /api/orders` while it renders, so nothing on
 * this surface calls that endpoint from the browser: this list issues no request of any kind, and
 * a page turn is a new request for the page rather than a fetch from this component.
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
 * words beside the links rather than left to their colour - carrying `aria-current="page"` to mark
 * it as the place in the sequence, and `role="status"` so that turning a page, which replaces the
 * list without moving focus, is announced rather than silent. That is the same treatment the
 * inventory dashboard's pager gives its own indicator, so the two pagers in this application
 * behave alike. Focus rings belong to the stylesheets.
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

/** Where a page of this list lives, and so what the pager rewrites the page parameter of. */
const DEFAULT_PAGE_HREF_BASE = '/orders';

/** The query parameter the pager rewrites, leaving every other one exactly as the reader left it. */
const PAGE_PARAM = 'page';

/** The page a listing returns to from a page past its end, and from a cleared filter. */
const FIRST_PAGE = 1;

/**
 * The strip's labels, in the order `OrderHistoryList.module.css` places them - the same order a row
 * puts its cells in, and the reason the last two are end-aligned there: a quantity and a sum are
 * read from their last digit.
 */
const COLUMN_LABELS = ['Order', 'Status', 'Items', 'Total'] as const;

/** The accessible name of the paging landmark. */
const PAGER_LABEL = 'Order history pages';

/**
 * The three ways this page of the list can be empty, in the words each one needs.
 *
 * They are told apart rather than collapsed into one sentence because they leave the reader three
 * different things to do. An account that has never ordered is told how the history fills up. A
 * filter that matched nothing is told the filter is why, and handed the way to drop it - the
 * alternative, telling a customer with nine orders that they have never placed one, is simply
 * false, and the result count printed directly above says as much. An address that ran off the end
 * of a listing is told how many orders the history does hold and that the page it named holds none
 * of them, which is the sentence the inventory dashboard's table uses for the same situation, and
 * is handed the way back to the first page.
 *
 * The past-end sentence is assembled at render time because it quotes two figures, so it lives
 * with the arithmetic rather than here.
 */
const EMPTY_HEADING_NEVER_ORDERED = 'No orders yet';
const EMPTY_BODY_NEVER_ORDERED =
  'Orders placed from this account appear here, newest first, with what each one cost and how far along it is. Add something to your cart from the catalog to place the first one.';

const EMPTY_HEADING_NO_MATCHES = 'No orders match this filter';
const EMPTY_BODY_NO_MATCHES =
  'This account has no orders in the state the filter selects. Clearing it lists the whole history again, newest first.';

const EMPTY_HEADING_PAST_END = 'That page is past the end of this history';

/** The two recovery controls, worded as the destination rather than as the act. */
const CLEAR_FILTER_LABEL = 'Clear filter';
const FIRST_PAGE_LABEL = 'Go to the first page';

/** The sentence that says a filter is narrowing the list, around the value it is narrowed to. */
const FILTER_PREFIX = 'Showing ';
const FILTER_SUFFIX = ' orders only.';

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
   * The path this list is served from, which the pager rewrites the `page` parameter of, and which
   * the recovery control of a page past the end returns to the first page of.
   *
   * @default '/orders'
   */
  pageHrefBase?: string | undefined;

  /**
   * What the listing is filtered to, in the reader's words - the name of an order state, not the
   * parameter's value - or left out when nothing is filtered.
   *
   * It is the caller's to word because the query vocabulary is the caller's: the page that parsed
   * `?status=PAID` is the one that knows it means "Paid", and a list handed the raw value would
   * either print it as it arrived or have to learn this store's status names. Supplying it is what
   * makes a narrowed listing say why it is short - "2 orders / Showing paid orders only" - rather
   * than leaving the reader to wonder where the other seven went.
   */
  filterLabel?: string | undefined;

  /**
   * Where the filter is cleared: the same listing with no filter on it, from its first page.
   * Rendered as the control at the end of the filter sentence, and as the empty state's recovery
   * control when the filter is what emptied the list. Leave it out and the filter is stated
   * without a way to drop it, which is the right behaviour for a caller whose filter is not
   * expressed in the address.
   */
  clearFilterHref?: string | undefined;

  /** The placing page's own class, for the geometry a list cannot know about. */
  className?: string | undefined;
}

/**
 * Render a page of the order history, or the block that says why this page of it holds nothing.
 *
 * @example
 * // On the orders page, from the payload the route already resolved.
 * <OrderHistoryList orders={page} referenceIso={renderedAt} />
 *
 * @example
 * // The same listing narrowed to one order state, able to say so and to offer the way back.
 * <OrderHistoryList
 *   orders={page}
 *   pageHrefBase="/orders?pageSize=20&status=PAID"
 *   filterLabel="Paid"
 *   clearFilterHref="/orders?pageSize=20"
 * />
 */
export function OrderHistoryList({
  orders,
  referenceIso,
  heading = DEFAULT_HEADING,
  pageHrefBase = DEFAULT_PAGE_HREF_BASE,
  filterLabel,
  clearFilterHref,
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

  /*
   * The page the address asked for, and the page the rows in hand are actually a page of. They are
   * kept apart because each answers a different question: the request's own number is what the
   * blank slate has to quote back - "none of them are on page 9,999" is the sentence that explains
   * an empty window - while the pager, which only ever describes a page that has rows, wants the
   * number clamped to a page that exists.
   */
  const requestedPage = Math.max(1, Math.trunc(finiteOr(orders.page, 1)));
  const currentPage = Math.min(requestedPage, pageCount);

  const count = `${formatQuantityLabel(total)} ${total === 1 ? 'order' : 'orders'}`;

  /*
   * Which of the three empty situations this is, and the words and the way out that follow from
   * it. The question is decided by the payload's own count rather than by the emptiness of the
   * page: a query that matched orders the requested window lies past is a different situation from
   * one that matched none, and a filter that matched none is different again from an account that
   * has never ordered.
   *
   * Only the first two have a way out, and both destinations are real addresses, so both controls
   * are anchors carrying this module's own chip class - `../ui/Button` renders a `<button>`, which
   * this server component has no handler for. The third passes none: its sentence names the
   * catalog, the site header links to it from every page, and a control repeating that would be a
   * third route to the same place.
   */
  let emptyHeading = EMPTY_HEADING_NEVER_ORDERED;
  let emptyBody = EMPTY_BODY_NEVER_ORDERED;
  let emptyAction: ReactElement | undefined;
  let clearedFromEmptyState = false;

  if (total > 0) {
    emptyHeading = EMPTY_HEADING_PAST_END;
    emptyBody = `The history holds ${count}, but none of them are on page ${formatQuantityLabel(requestedPage)}.`;
    emptyAction = (
      <Link className={styles.action} href={hrefForPage(pageHrefBase, FIRST_PAGE)}>
        {FIRST_PAGE_LABEL}
      </Link>
    );
  } else if (filterLabel !== undefined) {
    emptyHeading = EMPTY_HEADING_NO_MATCHES;
    emptyBody = EMPTY_BODY_NO_MATCHES;

    if (clearFilterHref !== undefined) {
      emptyAction = (
        <Link className={styles.action} href={clearFilterHref}>
          {CLEAR_FILTER_LABEL}
        </Link>
      );
      clearedFromEmptyState = true;
    }
  }

  /*
   * One control per job on screen. The filter line always states the filter, but it carries the
   * control to drop it only when nothing below is already offering the same address under the same
   * label - otherwise the filtered-empty screen would show "Clear filter" twice, pointing at one
   * destination, styled as two different kinds of control. The blank slate keeps it in that case,
   * because it is the block the reader is looking at; a listing showing rows has no blank slate, so
   * the line keeps it there. A window past the end of a *filtered* listing keeps both, and has to:
   * the blank slate's control goes to the first page of the filter, and dropping the filter
   * altogether is then only offered by the line.
   */
  const clearOnFilterLine = clearFilterHref !== undefined && !clearedFromEmptyState;

  return (
    <section className={clsx(styles.root, className)} aria-label={heading}>
      <div className={styles.head}>
        <h2 className={styles.heading}>{heading}</h2>
        <p className={styles.count}>{count}</p>
      </div>

      {/*
        Rendered whenever a filter is narrowing the list, empty or not: a reader looking at two of
        this account's nine orders is owed the reason as much as a reader looking at none of them.
        The sentence is plain text around the emphasised value, and the control at the end of it is
        the same address the empty state offers.
      */}
      {filterLabel === undefined ? null : (
        <p className={styles.filterBar}>
          <span>
            {FILTER_PREFIX}
            {/*
              `toLowerCase` rather than `toLocaleLowerCase`: the word sits mid-sentence, so it is
              lower-cased for grammar rather than for a reader's locale, and the locale-sensitive
              form would fold an `I` differently on a Turkish host than on any other - exactly the
              kind of ambient input `@/lib/format` pins its own locale to keep out.
            */}
            <span className={styles.filterValue}>{filterLabel.toLowerCase()}</span>
            {FILTER_SUFFIX}
          </span>
          {clearOnFilterLine && clearFilterHref !== undefined ? (
            <Link className={styles.filterClear} href={clearFilterHref}>
              {CLEAR_FILTER_LABEL}
              <VisuallyHidden>{` (${filterLabel})`}</VisuallyHidden>
            </Link>
          ) : null}
        </p>
      )}

      {items.length === 0 ? (
        /*
         * `.empty` is placement - it centres the block and gives it its block margin - so it goes
         * on a wrapper rather than on `BlankSlate`, whose own module owns the column the
         * illustration, heading, sentence and control are stacked in. Its heading is an `<h3>`
         * because it sits inside this section, whose own `<h2>` is the level above it.
         */
        <div className={styles.empty}>
          <BlankSlate
            art="empty-orders"
            alt={EMPTY_ART_ALT}
            heading={emptyHeading}
            headingAs="h3"
            action={emptyAction}
          >
            {emptyBody}
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
              <OrderHistoryRow key={order.id} order={order} referenceIso={referenceIso} />
            ))}
          </ul>

          {/*
            Rendered only when there is more history than one page holds, and only beside rows: the
            pager states which page the reader is on, and a window past the end of the listing is
            not on a page at all - "Page 3 of 3" printed over no rows would be a position the list
            is not in, and its Previous would lead past the very page it claimed. The way back from
            there is the blank slate's own control instead.
          */}
          {pageCount > 1 ? (
            <nav className={styles.pager} aria-label={PAGER_LABEL}>
              {/*
            `aria-current="page"` marks this as the position in the sequence the two anchors move
            through, which is what the inventory dashboard's pager does with its own indicator, and
            `role="status"` makes the change audible: a page turn here is a client-side navigation
            that swaps the list in place, so without a live region a screen-reader user activates
            Next and is told nothing. `aria-live` is stated alongside the role it is implied by, as
            every live region in this application states it.
          */}
              <p
                className={styles.pagerStatus}
                role="status"
                aria-live="polite"
                aria-current="page"
              >
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
