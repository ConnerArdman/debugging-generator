/**
 * Lumen Supply - the receipt the storefront shows once an order has been placed.
 *
 * It answers the questions a buyer has the moment they stop being a shopper: did the order go
 * through, what is its reference, what was bought for how much, and where is it going. The surface
 * it sits on is `@/components/ui/Card`, the status chip is `@/components/ui/Badge`, every figure is
 * `@/components/ui/Price` and every string is worded by `@/lib/format`. What is left - which of the
 * payload's fields earns a line, and in what order those lines read - is this file's only job.
 *
 * TWO CALLERS, ONE COMPONENT
 * The `/checkout` and `/orders` routes render it on the server from a payload they already hold,
 * and the checkout form renders it in the browser, in place of its own fields, the moment a submit
 * resolves. That is only possible because the component is hook-free and entirely prop-fed: no
 * `'use client'`, no state, no effect, no context, nothing read from the browser and nothing
 * fetched. It renders what it is given, so the markup a server sends is the markup a client mounts.
 *
 * NOTHING HERE READS A CLOCK
 * `placedAt` is printed absolutely by `formatOrderDateTime`, and the relative wording beside it
 * appears only when the caller passes `referenceIso` - the instant it wants that wording measured
 * against. There is deliberately no fallback to the current time: a receipt that reads the clock
 * while it renders prints one sentence on the server and a different one in the browser, which is
 * a hydration mismatch at best and a wrong statement at worst.
 *
 * THE PAYLOAD IT ACCEPTS
 * `order` is either an `OrderDetail` - what the order routes return - or the `CheckoutResult` a
 * submit resolves to, which wraps one. Both are accepted so that neither caller has to unwrap
 * anything, and the single `'order' in order` test below is the whole of the adaptation. The
 * payment half of a `CheckoutResult` is deliberately not printed here: this block is the order's
 * receipt, and how the payment resolved belongs to the form that performed it.
 *
 * HOW THE CARD IS DIVIDED
 * The headline takes the card's `head` slot and the orders link takes its `foot`, so both arrive
 * with the hairline `Card.module.css` draws for those slots and neither needs a rule of its own.
 * Everything else is one column inside `.root`, which is where the order reference belongs as
 * well: `.orderNumber` is written with `align-self`, so it wants the flex parent `.root` is and
 * the head slot is not.
 *
 * WHY `clsx` WRAPS A SINGLE CLASS
 * A CSS Module class is typed `string | undefined` under this repository's
 * `noUncheckedIndexedAccess`, while `Price` declares `className?: string` - and
 * `exactOptionalPropertyTypes` makes those two different types. `clsx` collapses the difference,
 * which keeps the call honest instead of asserting the class away with a non-null assertion.
 */

import clsx from 'clsx';
import Link from 'next/link';

import type { ComponentProps, ReactElement } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Price } from '@/components/ui/Price';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import {
  formatOrderDateTime,
  formatOrderStatusLabel,
  formatQuantityLabel,
  formatShippingEtaLabel,
  formatSkuLabel,
  formatTimeAgoLabel,
} from '@/lib/format';
import type { CheckoutResult, OrderDetail, OrderStatus } from '@/lib/types';

import styles from './OrderConfirmation.module.css';

/**
 * The tones the badge accepts, read off the component rather than restated here, exactly as the
 * product page's availability chip does it. The five literals are declared once, in the primitive
 * whose stylesheet selects on them, so a tone renamed there becomes a compile error in the map
 * below instead of a chip that quietly renders unstyled.
 */
type OrderTone = NonNullable<ComponentProps<typeof Badge>['tone']>;

/**
 * Which tone paints each lifecycle state.
 *
 * A `Record` over the finite union rather than a `switch`: a fifth state added to `OrderStatus`
 * becomes a compile error right here instead of falling through to a neutral chip that says
 * nothing, and indexing the map with an `OrderStatus` yields a tone rather than
 * `OrderTone | undefined` under `noUncheckedIndexedAccess`.
 *
 * One tone each, because each of the four means something different to the person reading the
 * receipt: an order still to settle is the one worth a second look, an accepted one is merely
 * progress, a shipped one is the outcome they wanted, and a cancelled one is the outcome they did
 * not. The chip's label states the status in words either way - `formatOrderStatusLabel` writes
 * it - so the colour reinforces the sentence and never carries it alone.
 */
const ORDER_STATUS_TONES: Record<OrderStatus, OrderTone> = {
  PENDING: 'warning',
  PAID: 'info',
  FULFILLED: 'success',
  CANCELLED: 'danger',
};

/**
 * Props of the receipt.
 *
 * Local and deliberately not exported, like every other props type in this workspace: a caller
 * that needs the shape writes `ComponentProps<typeof OrderConfirmation>` rather than putting a
 * second name into circulation. The optional members spell `| undefined` out because the workspace
 * compiles with `exactOptionalPropertyTypes`, under which a bare `headline?: string` rejects the
 * `string | undefined` a caller reading an optional field of its own actually holds.
 */
interface Props {
  /**
   * The order that was placed - the detail payload the order routes return, or the checkout result
   * that wraps one. Whichever arrives, the fields printed below come from the same `OrderDetail`.
   */
  order: OrderDetail | CheckoutResult;

  /**
   * The instant any relative wording is measured against, as an ISO-8601 timestamp: a value the
   * rendering route computed, or one a client component captured after it mounted. Omitted, the
   * receipt prints the absolute placement time on its own and no relative phrase at all, because
   * the only other way to word one would be to read the clock.
   */
  referenceIso?: string | undefined;

  /** Where the trailing link goes. Defaults to the order history at `/orders`. */
  ordersHref?: string | undefined;

  /**
   * The heading. Defaults to the wording for the case this block exists for - an order that has
   * just been placed - and is worth overriding where the same receipt is read back later, from the
   * order history rather than from the checkout.
   */
  headline?: string | undefined;

  /** The consuming module's own class, composed by `Card` for the block's placement and width. */
  className?: string | undefined;
}

/**
 * Join the parts of one line, dropping the blank and absent ones and trimming what is left.
 *
 * Every field of an address is a required string in the payload and an optional one is `null`
 * rather than missing, so the two things that can reach a line are a value and nothing at all.
 * Filtering here is what keeps a blank field from printing as a stray comma or an empty row, and
 * it is why the address can be assembled as text with newlines in it - which is the one shape a
 * multi-line address should take, rather than a chain of `<br>` elements that a screen reader
 * reads out as empty lines.
 */
function joined(parts: readonly (string | null)[], separator: string): string {
  return parts
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .map((part) => part.trim())
    .join(separator);
}

/**
 * Render the receipt for one placed order.
 *
 * @example
 * // From the server component that resolved the order.
 * <OrderConfirmation order={order} referenceIso={renderedAt} />
 *
 * @example
 * // From the checkout form, with the result its submit resolved to.
 * <OrderConfirmation order={result} headline="Thank you for your order" />
 */
export function OrderConfirmation({
  order,
  referenceIso,
  ordersHref = '/orders',
  headline = 'Order placed',
  className,
}: Props): ReactElement {
  // The whole of the adaptation between the two payloads this component accepts. `OrderDetail`
  // declares no `order` member, so the test narrows the union without a cast and without either
  // caller having to unwrap anything.
  const detail: OrderDetail = 'order' in order ? order.order : order;

  const address = detail.shippingAddress;
  // The one line of a postal address that is assembled from several fields rather than printed as
  // it stands, so it is built with the same blank-dropping join as the address around it.
  const locality = joined([joined([address.city, address.region], ', '), address.postalCode], ' ');
  const destination = joined(
    [
      detail.contact.name,
      detail.contact.company,
      address.line1,
      address.line2,
      locality,
      address.country,
    ],
    '\n',
  );

  // The service an order shipped by is `null` for an order whose choice was never recorded, which
  // is a line with nothing to say rather than a line saying nothing.
  const option = detail.shippingOption;
  const arrival =
    option === null
      ? ''
      : joined([option.label, formatShippingEtaLabel(option.estimatedDays)], ' · ');

  // What the subtotal is a subtotal of. The count comes from the payload rather than from the
  // lines, so it still reads correctly for an order whose lines were not included.
  const items = `${formatQuantityLabel(detail.itemCount)} ${detail.itemCount === 1 ? 'item' : 'items'}`;

  return (
    <Card
      className={className}
      pad="lg"
      head={<h2 className={styles.headline}>{headline}</h2>}
      foot={
        <div className={styles.actions}>
          <Link className={styles.actionLink} href={ordersHref}>
            View all orders
          </Link>
        </div>
      }
    >
      <div className={styles.root}>
        {/* The reference a customer quotes back. Plain selectable text, and prefixed for a screen
            reader with the words a sighted reader takes from the chip's position under the
            heading. */}
        <p className={styles.orderNumber}>
          <VisuallyHidden>Order number</VisuallyHidden> {detail.orderNumber}
        </p>

        <div className={styles.statusRow}>
          <Badge tone={ORDER_STATUS_TONES[detail.status]}>
            {formatOrderStatusLabel(detail.status)}
          </Badge>
          <span>
            Placed <time dateTime={detail.placedAt}>{formatOrderDateTime(detail.placedAt)}</time>
          </span>
          {referenceIso === undefined ? null : (
            <span>{formatTimeAgoLabel(detail.placedAt, referenceIso)}</span>
          )}
        </div>

        {/* A real list, so the lines are announced as a list of as many items as there are. An
            order with none still gets one row rather than an empty list: a bordered gap where a
            list used to be reads as something having gone missing. */}
        <ul className={styles.lines}>
          {detail.lines.length === 0 ? (
            <li className={styles.line}>
              <span className={styles.lineMeta}>No items were recorded on this order.</span>
            </li>
          ) : (
            detail.lines.map((line) => (
              <li className={styles.line} key={line.id}>
                <div className={styles.lineBody}>
                  <span className={styles.lineName}>{line.name}</span>
                  <span className={styles.lineMeta}>
                    Qty {formatQuantityLabel(line.quantity)} · {formatSkuLabel(line.sku)}
                  </span>
                </div>
                <Price className={clsx(styles.lineTotal)} cents={line.lineTotalCents} />
              </li>
            ))
          )}
        </ul>

        {/* The breakdown, as the label-and-value pairs it is. Every figure but the last recedes,
            because the last one is the amount that was actually charged - and it is the only one
            given the larger size, since `Price` owns the figure's type scale and the emphasis on
            `.grandTotal` cannot reach across that boundary. */}
        <dl className={styles.totals}>
          <div className={styles.totalsRow}>
            <dt className={styles.totalsLabel}>Subtotal ({items})</dt>
            <dd className={styles.totalsValue}>
              <Price cents={detail.subtotalCents} size="sm" tone="muted" />
            </dd>
          </div>
          {detail.discountCents === 0 ? null : (
            <div className={styles.totalsRow}>
              <dt className={styles.totalsLabel}>Discount</dt>
              {/* Printed as the signed effect on the total, which is what makes the rows add up
                  to it: subtotal, minus the discount, plus shipping, plus tax. */}
              <dd className={styles.totalsValue}>
                <Price cents={-detail.discountCents} size="sm" tone="muted" />
              </dd>
            </div>
          )}
          <div className={styles.totalsRow}>
            <dt className={styles.totalsLabel}>Shipping</dt>
            <dd className={styles.totalsValue}>
              <Price cents={detail.shippingCents} size="sm" tone="muted" />
            </dd>
          </div>
          <div className={styles.totalsRow}>
            <dt className={styles.totalsLabel}>Tax</dt>
            <dd className={styles.totalsValue}>
              <Price cents={detail.taxCents} size="sm" tone="muted" />
            </dd>
          </div>
          <div className={clsx(styles.totalsRow, styles.grandTotal)}>
            <dt className={styles.totalsLabel}>Total</dt>
            <dd className={styles.totalsValue}>
              <Price cents={detail.totalCents} size="lg" />
            </dd>
          </div>
        </dl>

        {/* Where the order is going and when it is expected. The block is skipped entirely when
            the payload carries neither, so the column above it does not end on an empty row. */}
        {destination.length === 0 && arrival.length === 0 ? null : (
          <div className={styles.shipping}>
            {destination.length === 0 ? null : (
              <>
                <p>Shipping to</p>
                <address className={styles.addressBlock}>{destination}</address>
              </>
            )}
            {arrival.length === 0 ? null : <p>{arrival}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}
