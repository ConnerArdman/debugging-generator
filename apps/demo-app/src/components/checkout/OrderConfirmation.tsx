/**
 * Lumen Supply - the receipt the storefront shows once an order has been placed.
 *
 * It answers the questions a buyer has the moment they stop being a shopper: did the order go
 * through, what is its reference, what was bought at what price for how much, what settled the
 * charge, who is carrying it and where is it going. The surface
 * it sits on is `@/components/ui/Card`, the status chip is `@/components/ui/Badge`, every figure is
 * `@/components/ui/Price` and every string is worded by `@/lib/format`. What is left - which of the
 * payload's fields earns a line, and in what order those lines read - is this file's only job.
 *
 * TWO ARRIVALS, ONE COMPONENT
 * The checkout form renders it in place of its own fields in two situations: in the browser, the
 * moment a submit resolves, and on the server, when `/checkout` is requested at an order's own
 * address and the page hands the form the order it read back - which the browser then hydrates.
 * Both are only possible because the component is hook-free and entirely prop-fed: no
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
 * `order` is either an `OrderDetail` - what the order service reads back, as the checkout page does
 * for the order its address names - or the `CheckoutResult` a submit resolves to, which wraps one.
 * Both are accepted so that neither arrival has to unwrap anything, and the two `'order' in order`
 * tests below are the whole of the adaptation: one takes the order, the other takes the payment
 * that settled it.
 *
 * WHAT IS PRINTED OF THE PAYMENT, AND WHY IT MAY BE ABSENT
 * `payment` exists only on the `CheckoutResult` branch, and is `null` even there for an
 * `already_placed` result read back from the store - which retains the order but not the
 * authorization that paid for it. So the payment rows print when the payload carries one and are
 * absent entirely when it does not, leaving no empty row and no dangling label for the
 * `OrderDetail` caller. What is printed is the processor's reference and the instant it settled,
 * which are what a buyer quotes when they ring up about a charge. `authorized` and `declineReason`
 * are not: a receipt exists because the payment went through, and the wording for one that did not
 * belongs to the form that watched it fail. `amountCents` is not either - the amount that was
 * charged is already the last row of the totals block, and printing it twice would invite the two
 * to disagree.
 *
 * EVERY LINE RECONCILES ON ITS OWN FACE
 * A line prints the price it was captured at, the units bought at it, what the line's own discount
 * took off, and what it settled at, so `unit price x quantity - discount = line total` can be
 * checked by eye rather than taken on trust. The discount is derived here because `OrderLine`
 * publishes the two ends of that subtraction and not the difference; `adjustment` below states why
 * the subtraction is exact and how a negative result is treated.
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
 * which keeps the call honest instead of asserting the class away with a non-null assertion. Its
 * other calls here are the ordinary one: two module classes joined on one element, where the
 * second narrows the first.
 */

import clsx from 'clsx';
import Link from 'next/link';

import type { ComponentProps, ReactElement } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Price } from '@/components/ui/Price';
import {
  formatOrderDateTime,
  formatOrderStatusLabel,
  formatQuantityLabel,
  formatShippingEtaLabel,
  formatSkuLabel,
  formatTimeAgoLabel,
} from '@/lib/format';
import type {
  CheckoutResult,
  OrderDetail,
  OrderLine,
  OrderStatus,
  PaymentAuthorization,
  ShippingOption,
} from '@/lib/types';

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
 * How the consignment travels, as one phrase: the service the customer bought and the carrier that
 * runs it.
 *
 * The carrier is named once, whichever payload the receipt was handed. An order read back from the
 * store carries a label that is already the carrier code and the service level together - the
 * order service composes it that way because neither half identifies the service on its own -
 * while a quote taken at checkout labels the service in words, "Standard ground", and carries the
 * carrier code beside it. Naming the carrier only when the label does not already contain it is
 * what keeps "NLEX GROUND with NLEX" off a receipt, and the comparison is case-insensitive because
 * the two sources spell the code differently.
 *
 * Either field can arrive blank, and neither is printed blank: a label with no carrier reads as
 * the label, a carrier with no label reads as the carrier, and nothing at all returns the empty
 * string that `joined` drops.
 */
function carriage(option: ShippingOption): string {
  const label = option.label.trim();
  const carrier = option.carrier.trim();

  if (carrier.length === 0 || label.toUpperCase().includes(carrier.toUpperCase())) {
    return label;
  }

  return label.length === 0 ? carrier : `${label} with ${carrier}`;
}

/**
 * What a line's own discount took off it, in cents: `unitPriceCents * quantity - lineTotalCents`.
 *
 * WHY THE SUBTRACTION IS EXACT
 * The figure is derived rather than read, because `OrderLine` publishes the price the line was
 * captured at and the amount it settled at and nothing in between. The store's own order line does
 * hold the difference, and the order service refuses to write a line whose three figures disagree -
 * it requires `lineTotalCents === unitPriceCents * quantity - discountCents` - so this subtraction
 * recovers precisely the discount that was recorded against the line. Deriving it here is also why
 * no field has to be added to the DTO for a receipt to reconcile.
 *
 * HOW EACH SIGN IS TREATED
 * A positive result is a discount, printed as the amount taken off. Zero is a line charged at the
 * price it was captured at, which prints no adjustment row at all rather than a row reading
 * nothing. A negative result would mean the line settled above its own captured price - a surcharge
 * the payload does not model anywhere - and it is printed as an addition, in those words, rather
 * than dressed up as a discount or quietly dropped: a receipt that hides an increase is worse than
 * one that names an increase it cannot explain.
 *
 * A figure that is not a finite number yields `0`, so no adjustment is claimed on a line whose
 * own figures are unusable. Nothing is concealed by that: `Price` renders a non-amount as the
 * placeholder dash, so the unit price and the line total themselves say that the data is broken.
 */
function adjustment(line: OrderLine): number {
  const cut = line.unitPriceCents * line.quantity - line.lineTotalCents;

  return Number.isFinite(cut) ? cut : 0;
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

  // The authorization that settled the order, which only a checkout result carries - and which
  // even a checkout result leaves `null` for an order it merely read back. The same `in` test is
  // written again rather than derived from `detail`, because narrowing a union is what the test
  // does and `detail` no longer holds the branch it came from.
  const payment: PaymentAuthorization | null = 'order' in order ? order.payment : null;

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

  // The address the confirmation is sent to. A required string in the payload, so the only two
  // things that can reach the line are an address and a blank one, and a blank one says nothing
  // worth a row.
  const email = detail.contact.email.trim();

  // The order's own identifier, as distinct from the order number a customer reads out: the value
  // a support tool looks the order up by. Blanks are filtered for the same reason they are
  // everywhere else in this file - a label with nothing beside it is worse than no row.
  const identifier = detail.id.trim();

  // The service an order shipped by is `null` for an order whose choice was never recorded, which
  // is a line with nothing to say rather than a line saying nothing. When there is a service, the
  // line names who is carrying the goods as well as what was bought and when it lands.
  const option = detail.shippingOption;
  const arrival =
    option === null
      ? ''
      : joined([carriage(option), formatShippingEtaLabel(option.estimatedDays)], ' · ');

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
        {/* The reference a customer quotes back, captioned in words a sighted reader sees rather
            than left to be inferred from the chip's position under the heading. The caption and
            the reference are separate elements so the reference stays one selectable run of plain
            text: a double-click still takes the reference alone, which is the gesture someone uses
            to copy it into an email. */}
        <p className={styles.orderNumber}>
          <span className={styles.orderNumberCaption}>Order number</span>
          <span className={styles.orderNumberValue}>{detail.orderNumber}</span>
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
            detail.lines.map((line) => {
              // Positive is the discount the line carried, negative the surcharge the payload does
              // not model, and zero a line charged at the price it was captured at.
              const cut = adjustment(line);

              return (
                <li className={styles.line} key={line.id}>
                  <div className={styles.lineBody}>
                    <span className={styles.lineName}>{line.name}</span>
                    <span className={styles.lineMeta}>
                      Qty {formatQuantityLabel(line.quantity)} · {formatSkuLabel(line.sku)}
                    </span>
                  </div>
                  {/* The money column, ordered downwards as the arithmetic a reader checks: the
                      units at the price they were captured at, what came off them, then what the
                      line settled at - the one figure of the three at full strength, so the column
                      of line totals still scans against the totals block below. */}
                  <div className={styles.lineAmounts}>
                    <span className={styles.lineBasis}>
                      {formatQuantityLabel(line.quantity)} at{' '}
                      <Price cents={line.unitPriceCents} size="sm" tone="muted" /> each
                    </span>
                    {cut === 0 ? null : (
                      <span className={styles.lineAdjustment}>
                        {cut > 0 ? 'less' : 'plus'}{' '}
                        <Price cents={Math.abs(cut)} size="sm" tone="muted" />{' '}
                        {cut > 0 ? 'discount' : 'above the captured price'}
                      </span>
                    )}
                    <Price className={clsx(styles.lineTotal)} cents={line.lineTotalCents} />
                  </div>
                </li>
              );
            })
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

        {/* What a customer quotes when they ring up about this order: its own identifier, which is
            not the order number above and is what a support tool looks the order up by, and - when
            the payload carries a payment - the processor's reference for the charge and the instant
            it settled. Each row is a label and a value together, so a row is either both or
            neither and the block can never end on a label with nothing beside it; the block itself
            is skipped when it would hold no row at all, which is what an `OrderDetail` with no
            identifier would leave. The timestamp is printed absolutely by `formatOrderDateTime`,
            inside a machine-readable `<time>`, exactly as the placement time above is - no clock is
            read to word either of them. */}
        {identifier.length === 0 && payment === null ? null : (
          <dl className={styles.refs}>
            {identifier.length === 0 ? null : (
              <div className={styles.refRow}>
                <dt className={styles.refLabel}>Order ID</dt>
                <dd className={clsx(styles.refValue, styles.refCode)}>{identifier}</dd>
              </div>
            )}
            {payment === null ? null : (
              <>
                <div className={styles.refRow}>
                  <dt className={styles.refLabel}>Payment reference</dt>
                  <dd className={clsx(styles.refValue, styles.refCode)}>{payment.reference}</dd>
                </div>
                <div className={styles.refRow}>
                  <dt className={styles.refLabel}>Payment processed</dt>
                  <dd className={styles.refValue}>
                    <time dateTime={payment.processedAt}>
                      {formatOrderDateTime(payment.processedAt)}
                    </time>
                  </dd>
                </div>
              </>
            )}
          </dl>
        )}

        {/* Where the order is going, when it is expected, and the address the confirmation of it
            was sent to. The block is skipped entirely when the payload carries none of the three,
            so the column above it does not end on an empty row. */}
        {destination.length === 0 && arrival.length === 0 && email.length === 0 ? null : (
          <div className={styles.shipping}>
            {destination.length === 0 ? null : (
              <>
                <p>Shipping to</p>
                <address className={styles.addressBlock}>{destination}</address>
              </>
            )}
            {arrival.length === 0 ? null : <p>{arrival}</p>}
            {email.length === 0 ? null : (
              <p className={styles.contactLine}>
                Confirmation sent to <span className={styles.contactValue}>{email}</span>
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
