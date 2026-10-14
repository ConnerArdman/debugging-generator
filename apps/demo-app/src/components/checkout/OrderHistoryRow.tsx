/**
 * Lumen Supply - one order in the order history.
 *
 * The scope of this file is exactly the `<li>`: the order reference and the date it was placed,
 * the status chip, the item count and the money total. The `<ul>`, the hairline between rows, the
 * visible column-header strip, the pager and the blank slate belong to `./OrderHistoryList`, and
 * the grid the four cells sit on belongs to `./OrderHistoryRow.module.css`. This is the same split
 * the cart group draws between a line row and the list that holds it, and it is what lets the
 * orders page render three hundred rows through one component that knows nothing about how many
 * there are.
 *
 * THE ROW IS THE ORDER, AND IT LINKS NOWHERE
 * A row carries every field this storefront records about an order in a listing - reference, date,
 * state, units and sum - and it deliberately offers no "view order" destination, because this
 * application serves no per-order route: its pages are the catalog, a product, the cart, checkout,
 * this history and the inventory dashboard. A row that linked to `/orders/<id>` would be a link to
 * a 404 on every one of the hundreds of rows a history holds, which is worse than no link at all -
 * so the reference stays ordinary selectable text and the row holds nothing focusable. The day a
 * per-order page exists, the anchor belongs here, wrapped around the reference, and
 * `./OrderHistoryRow.module.css` grows the focus affordance back with it.
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
 * above them to hide, so each cell carries a screen-reader-only label and is announced as "Items
 * 7" rather than as a bare "7". Below that same width the item count also prints a visible unit
 * beside the figure, because a sighted reader loses the strip's "Items" heading exactly when the
 * columns collapse and would otherwise be left with an unlabelled integer under the date; the unit
 * is `aria-hidden`, so the cell is announced once rather than as "Items 7 items". The row holds
 * nothing focusable and adds no `tabIndex`: it is data, and its four values are all read from the
 * text.
 */

import clsx from 'clsx';

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

/**
 * The unit the item count is printed with when the row is narrow enough to have lost its column
 * headings, singular and plural.
 *
 * Both forms are stated rather than a suffix appended to one, because the singular is what a
 * one-line order reads with and "1 items" is the kind of wording a reader notices. The words are
 * this file's because the figure is this file's: `@/lib/format` formats the number and takes no
 * view on what it counts.
 */
const ITEM_UNIT = 'item';
const ITEMS_UNIT = 'items';

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
export function OrderHistoryRow({ order, referenceIso, className }: Props): ReactElement {
  const placed = formatOrderDate(order.placedAt);

  // Relative wording is the caller's decision, not this component's: with no reference instant
  // there is nothing to measure against that would survive hydration.
  const relative =
    referenceIso === undefined ? null : formatTimeAgoLabel(order.placedAt, referenceIso);

  // A timestamp neither formatter can read prints the same placeholder twice, which reads as a
  // fault rather than as a date this row does not have. One placeholder is the honest rendering.
  const elapsed = relative === null || relative === placed ? null : relative;

  /*
   * The word beside the item count in the narrow arrangement, and `null` for a count no formatter
   * could read: `formatQuantityLabel` prints its own placeholder for a non-finite figure, and
   * "- items" would dress a missing value up as a measured one.
   */
  const unit = !Number.isFinite(order.itemCount)
    ? null
    : order.itemCount === 1
      ? ITEM_UNIT
      : ITEMS_UNIT;

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
        {/*
         * The unit the stylesheet reveals only once the column headings are gone, and hidden from
         * assistive technology because the label above already names the figure. Rendered inside
         * the cell so it inherits the cell's end alignment and tabular figures rather than
         * becoming a second cell the header strip has no track for.
         */}
        {unit === null ? null : (
          <span className={styles.itemsUnit} aria-hidden="true">{` ${unit}`}</span>
        )}
      </div>

      <div className={styles.totalCell}>
        <VisuallyHidden>{'Total '}</VisuallyHidden>
        <Price cents={order.totalCents} />
      </div>
    </li>
  );
}
