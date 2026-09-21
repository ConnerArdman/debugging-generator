/**
 * Lumen Supply - one order in the order history.
 *
 * The scope of this file is exactly the `<li>`: the order reference and the date it was placed,
 * the status chip, the item count, the money total and the link to the order itself. The `<ul>`,
 * the hairline between rows, the visible column-header strip, the pager and the blank slate belong
 * to `./OrderHistoryList`, and the grid the four cells sit on belongs to
 * `./OrderHistoryRow.module.css`. This is the same split the cart group draws between a line row
 * and the list that holds it, and it is what lets the orders page render three hundred rows
 * through one component that knows nothing about how many there are.
 *
 * A SERVER COMPONENT, AND WHY THAT IS THE WHOLE DESIGN
 * There is no client-component directive at the top of this file, no hook of any kind, no event
 * handler, no browser global and no data access. `app/orders/page.tsx` has already resolved the page of orders it is showing
 * and passes one `OrderSummary` per row, so this component is a function of its props alone: it
 * costs the client bundle nothing, it runs once per row on the server, and the markup it sends is
 * the markup the browser keeps.
 *
 * NOTHING HERE READS THE CLOCK
 * `formatTimeAgoLabel` takes the instant it measures against as an argument, and this component
 * passes the `referenceIso` its caller supplied - never a value of its own. A row that read the
 * current time while rendering would produce different text on the server and in the browser, so
 * relative wording is emitted only when a caller has committed to a reference instant, and the
 * absolute date is what a row without one shows. The same rule rules out any randomness: the
 * output is decided entirely by the props.
 *
 * FORMATTING IS BORROWED, NEVER REIMPLEMENTED
 * Money arrives as an integer number of cents and is printed by `@/components/ui/Price`; the date,
 * the item count and the status wording come from `@/lib/format`. That module pins its locale,
 * currency and time zone explicitly, which is what keeps a server-rendered figure and its
 * hydrated counterpart byte-identical - so this file does no arithmetic on a `...Cents` field and
 * builds no formatter of its own.
 *
 * WHY THE STATUS MAPPING LIVES HERE
 * `@/components/ui/Badge` is domain-agnostic: it takes a tone and a label the caller has already
 * worded. Teaching it about order statuses would make every new status a change to the
 * storefront's smallest primitive, so the mapping below is this component's, and the label always
 * names the status in words - the tone only reinforces what the text already says.
 *
 * ACCESSIBILITY
 * A row's cells have no headers of their own once the container is narrow enough for the strip
 * above them to hide, so each cell carries a screen-reader-only label and the anchor extends its
 * visible wording with the order reference: the link is announced as "View order" plus the order
 * it opens, never as a bare "View". The anchor is the row's only focusable element, and the
 * stylesheet draws one focus ring for the whole row from its `:focus-within`, so nothing here adds
 * a `tabIndex`. The reference itself stays ordinary selectable text rather than becoming a second
 * link to the same place.
 */

import clsx from 'clsx';
import Link from 'next/link';

import type { ComponentProps, ReactElement } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Price } from '@/components/ui/Price';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import {
  formatOrderDate,
  formatOrderStatusLabel,
  formatQuantityLabel,
  formatTimeAgoLabel,
} from '@/lib/format';
import type { OrderStatus, OrderSummary } from '@/lib/types';

import styles from './OrderHistoryRow.module.css';

/**
 * The tones the chip accepts, read off the component that owns them rather than restated here. The
 * five literals are declared once, in the primitive whose stylesheet selects them, so a tone
 * renamed there becomes a compile error in the map below instead of a chip that renders unstyled.
 */
type OrderStatusTone = NonNullable<ComponentProps<typeof Badge>['tone']>;

/**
 * Which tone paints each status.
 *
 * A `Record` over the finite union rather than a `switch` with a `default`: a fifth status added to
 * `OrderStatus` becomes a compile error right here instead of falling through to a neutral chip
 * that says nothing, and indexing the map with an `OrderStatus` yields a tone rather than
 * `OrderStatusTone | undefined` under this repository's `noUncheckedIndexedAccess`.
 *
 * `PENDING` is the one state still waiting on the customer, `PAID` is in hand and moving, and
 * `FULFILLED` is the outcome the row was opened to see. `CANCELLED` is the only terminal state
 * that delivered nothing, which is what earns it the alarming colour.
 */
const ORDER_STATUS_TONES: Record<OrderStatus, OrderStatusTone> = {
  PENDING: 'warning',
  PAID: 'info',
  FULFILLED: 'success',
  CANCELLED: 'danger',
};

/** Where an order's own page lives, for the common case of a row in the orders list. */
const DEFAULT_HREF_BASE = '/orders';

/**
 * Trailing separators on the base path, removed before the identifier is appended so that a base
 * written with or without one produces the same single-slash destination.
 */
const TRAILING_SLASHES = /\/+$/;

/**
 * The row's inputs.
 *
 * Local and deliberately not exported, like every other props type in this workspace: a list that
 * needs the shape writes `ComponentProps<typeof OrderHistoryRow>` rather than putting a second
 * name into circulation. The optional fields are spelled `?: T | undefined` because
 * `exactOptionalPropertyTypes` is on here, which lets a caller pass a value it is still resolving
 * straight through instead of assembling the element's props conditionally.
 */
interface Props {
  /**
   * The order this row reports, exactly as the page received it: money in integer cents, the
   * timestamp an ISO-8601 string in UTC. Nothing is re-derived from it.
   */
  order: OrderSummary;

  /**
   * The instant relative wording is measured against - a timestamp the server computed for the
   * whole page and passed down, so every row on it agrees. Leave it out and the row prints the
   * absolute date alone, which is the right behaviour wherever no stable reference exists.
   */
  referenceIso?: string | undefined;

  /**
   * The path an order's own page hangs off; the destination is this plus the order's identifier.
   * A caller that lists orders somewhere other than `/orders` overrides it.
   *
   * @default '/orders'
   */
  hrefBase?: string | undefined;

  /**
   * The placing list's own class, composed after the module's `root` class for the margin or grid
   * position a single row cannot know about.
   */
  className?: string | undefined;
}

/**
 * Render one order as a row of the history list.
 *
 * @example
 * // In the orders page, from the payload the route already resolved.
 * <OrderHistoryRow order={order} referenceIso={renderedAt} />
 */
export function OrderHistoryRow({
  order,
  referenceIso,
  hrefBase = DEFAULT_HREF_BASE,
  className,
}: Props): ReactElement {
  const placed = formatOrderDate(order.placedAt);

  // Relative wording is the caller's decision, not this component's: with no reference instant
  // there is nothing to measure against that would survive hydration.
  const relative =
    referenceIso === undefined ? null : formatTimeAgoLabel(order.placedAt, referenceIso);

  // A timestamp neither formatter can read prints the same placeholder twice, which reads as a
  // fault rather than as a date this row does not have. One placeholder is the honest rendering.
  const elapsed = relative === null || relative === placed ? null : relative;

  const href = `${hrefBase.replace(TRAILING_SLASHES, '')}/${encodeURIComponent(order.id)}`;

  return (
    <li className={clsx(styles.root, className)}>
      <div className={styles.identity}>
        <span className={styles.orderNumber}>
          <VisuallyHidden>{'Order '}</VisuallyHidden>
          {order.orderNumber}
        </span>

        <span className={styles.placed}>
          <VisuallyHidden>{'Placed '}</VisuallyHidden>
          <time dateTime={order.placedAt}>{placed}</time>
          {elapsed === null ? null : ` (${elapsed})`}
        </span>
      </div>

      <div className={styles.statusCell}>
        <VisuallyHidden>{'Status '}</VisuallyHidden>
        <Badge tone={ORDER_STATUS_TONES[order.status]} size="sm" dot>
          {formatOrderStatusLabel(order.status)}
        </Badge>
      </div>

      <div className={styles.itemsCell}>
        <VisuallyHidden>{'Items '}</VisuallyHidden>
        {formatQuantityLabel(order.itemCount)}
      </div>

      <div className={styles.totalCell}>
        <VisuallyHidden>{'Total '}</VisuallyHidden>
        <Price cents={order.totalCents} />
      </div>

      {/*
       * `prefetch={false}` because the list this row belongs to is long: a page of orders holds
       * dozens of rows and the history holds hundreds, and the default would fetch every visible
       * destination in the background whether or not the reader ever opens one. Following the link
       * still navigates on the client - only the speculative request is declined.
       */}
      <Link className={styles.link} href={href} prefetch={false}>
        View order
        <VisuallyHidden>{` ${order.orderNumber}`}</VisuallyHidden>
      </Link>
    </li>
  );
}
