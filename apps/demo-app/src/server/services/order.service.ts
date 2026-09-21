/**
 * Orders: writing one, and reading a customer's back.
 *
 * Two jobs live here and nothing else. A placed order is written at the end of
 * checkout - the order together with every one of its lines, in one
 * transaction, so a customer is never left with a charge recorded against half
 * an order - and a customer's orders are read back for the history view and
 * for the confirmation screen. No stock is moved: an order is a record of what
 * was bought, and the module that owns inventory owns that part of what placing
 * one means.
 *
 * A cart, on the other hand, is finished by the order it became, so the cart is
 * this module's business at three moments and no others. {@link claim} takes a
 * cart out of the session's hands before a checkout starts spending money
 * against it, and it is the reason two checkouts of one cart cannot both reach
 * a carrier or a processor: exactly one of them takes it, because taking it is
 * a single conditional write that one caller wins. {@link unclaim} puts it back
 * when the checkout it was taken for did not finish, so a customer whose
 * payment was declined still has their cart. The cart's last transition, to
 * `CONVERTED`, happens inside the transaction that writes the order, which is
 * what makes a cart and the order it became one fact rather than two: there is
 * no moment at which an order exists and its cart is still orderable, and no
 * second order can be written from a cart that has already become one. That
 * last property is what makes the third moment worth having:
 * {@link readCartOutcome} reads back what a session's cart became, so a
 * checkout that finds the session holding no open cart can tell an order that
 * was already placed from a cart an attempt is holding and from a session that
 * never had a cart at all.
 *
 * Everything returned is stated in the shapes of `@/lib/types` rather than in
 * database rows, so a page, a route handler and a client component all read an
 * order the same way. Three conversions belong to this boundary:
 *
 * * **Money stays an integer count of US cents.** Every monetary column of an
 *   order and of its lines is already an integer, so the figures are passed
 *   through rather than scaled or rounded.
 * * **Instants become ISO-8601 UTC strings.** A `Date` does not survive the
 *   trip from a server component into a client component, so the one timestamp
 *   an order carries is stringified here.
 * * **Tax is derived rather than stored.** An order keeps four figures - its
 *   subtotal, its discount, its freight and its total - and `OrderSummary`
 *   reconciles `subtotal - discount + freight + tax` to that total, so the tax
 *   an order bore is exactly the remainder. A store that charges none reads
 *   back zero, which is the truthful answer rather than an assumed one.
 *
 * The destination is the one part of an order this application does not retain:
 * there is no address on the order, so `recordOrder` returns the address the
 * checkout handed it and a re-read order carries an empty one. That is stated
 * plainly at {@link blank} rather than filled in with a guess.
 *
 * Importing this module opens no connection and reads no configuration - the
 * client in `@/server/db/prisma` connects on its first query - so a page that
 * imports it still builds and type-checks against a machine with no database.
 */

import { CartStatus, OrderStatus } from '@/generated/prisma/client';
import type {
  CustomerContact,
  OrderDetail,
  OrderLine,
  OrderSummary,
  PagedList,
  PaymentAuthorization,
  ShippingAddress,
  ShippingOption,
} from '@/lib/types';
import { prisma } from '@/server/db/prisma';
import {
  StorefrontConflictError,
  StorefrontNotFoundError,
  StorefrontValidationError,
} from '@/server/errors';

import type { PricedLine } from './pricing.service';

/** A page of order history: what a caller naming no page size is answered with. */
const PAGE_SIZE_DEFAULT = 20;

/** The largest page this module answers, whatever size a caller asks for. */
const PAGE_SIZE_CEILING = 100;

/** How many lines one order may carry, which is well beyond any cart this store takes. */
const LINE_CEILING = 200;

/**
 * Everything needed to write an order, as the checkout assembles it.
 *
 * The figures are the checkout's, not this module's: it priced the cart, it
 * quoted the freight and it authorized the payment, so it knows what the
 * customer agreed to pay. They are checked for agreement before anything is
 * written - see {@link recordOrder} - and never quietly recomputed, because a
 * total that disagrees with its parts means the cart moved underneath the
 * checkout rather than that one of the figures needs correcting.
 *
 * `lines` is `readonly` so that a caller may hand over the array it already
 * has, and `taxCents` may be left out by a checkout that charges none.
 */
export interface OrderDraft {
  /** Who is buying. The email identifies the account the order is written against. */
  customer: CustomerContact;
  /** Where the goods are going, as the checkout collected it. */
  address: ShippingAddress;
  /** The lines to write, priced. */
  lines: readonly PricedLine[];
  /**
   * The cart this order was assembled from, which becomes `CONVERTED` in the
   * same transaction the order is written in.
   */
  cart: string;
  /**
   * The quote the freight was charged at, as `./shipping.service` recorded it.
   * That quote is put on the order rather than whichever quote for the cart was
   * taken most recently, so a re-read order shows the service its customer
   * actually chose.
   */
  quote: string;
  /** The shipping service the customer chose. */
  option: ShippingOption;
  /** How the payment resolved, which decides the status the order opens in. */
  payment: PaymentAuthorization;
  /** The lines' gross, in cents, before any discount. */
  subtotalCents: number;
  /** What the price rules took off, in cents. */
  discountCents: number;
  /** The freight charged, in cents. */
  freightCents: number;
  /** Tax charged, in cents; omitted where none was. */
  taxCents?: number | undefined;
  /** `subtotalCents - discountCents + freightCents + taxCents`. */
  totalCents: number;
}

/**
 * Which page of whose orders to read.
 *
 * The optional members are declared as `T | undefined` on purpose. This
 * workspace compiles with `exactOptionalPropertyTypes`, and a caller usually
 * hands over a parsed query object whose unconstrained members are present and
 * `undefined`; accepting that shape is what lets the parsed value flow straight
 * into {@link listCustomerOrders} without being rebuilt field by field.
 */
export interface CustomerOrdersInput {
  /** Whose orders these are. */
  customerId: string;
  /** Which page to return, counting from 1 as `PagedList` does. */
  page?: number | undefined;
  /** How many orders that page holds, capped at {@link PAGE_SIZE_CEILING}. */
  pageSize?: number | undefined;
  /** Narrows the listing to one point in an order's lifecycle. */
  status?: OrderStatus | undefined;
}

/** The order columns every query below selects, and everything the mappers read. */
type Row = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  placedAt: Date;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
};

/** The line columns the detail queries select, with the product each line sold. */
type Item = {
  id: string;
  productId: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  product: { sku: string; name: string };
};

/** The quote columns the detail query selects, one per shipping service recorded. */
type Quote = {
  carrierCode: string;
  serviceLevel: string;
  amountCents: number;
  etaDays: number;
};

/** The account columns the detail query selects. */
type Account = {
  email: string;
  companyName: string;
  contactName: string;
};

/**
 * A page number or page size as a whole number, or `fallback` when the caller
 * named none or named something that is not a finite number.
 *
 * The bounds are left to the caller, because the two parameters are bounded
 * differently. Guarding them at all is deliberate: a parsed request arrives
 * with both already coerced, but a server component calls these functions
 * directly and with values of its own.
 */
function whole(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/** Whether `value` is an amount of money this application can record: whole cents, never negative. */
function cents(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * The reference the store prints on an order, unique to it.
 *
 * The year reads first because that is how the reference is filed and quoted,
 * and what follows is the instant the order was placed with a short random
 * tail, so two orders taken in the same millisecond still get references of
 * their own. Uniqueness is also a constraint on the column, so a reference is
 * checked by the database rather than trusted from here.
 */
function mint(at: Date): string {
  const year = String(at.getUTCFullYear());
  const stamp = at.getTime().toString(36).toUpperCase();
  const tail = Math.floor(Math.random() * 46_656)
    .toString(36)
    .toUpperCase()
    .padStart(3, '0');

  return `LS-${year}-${stamp}${tail}`;
}

/**
 * Checks that a draft can be written as it stands, and says so by throwing when
 * it cannot.
 *
 * Two kinds of rejection are distinguished, because a customer can act on one
 * and not the other. A draft that is not an order at all - no lines, a
 * fractional quantity, a negative charge - is a rejected request. A draft whose
 * figures do not add up is a collision: the cart was priced, quoted and
 * authorized a moment ago, and if its parts no longer reconcile then something
 * moved in between, which a fresh attempt resolves and a silently corrected
 * total would hide.
 *
 * @throws StorefrontValidationError When the draft is not a recordable order.
 * @throws StorefrontConflictError When its figures disagree with one another.
 */
function check(input: OrderDraft): void {
  if (input.cart.length === 0 || input.quote.length === 0) {
    throw new StorefrontValidationError(
      'An order has to name the cart it was assembled from and the quote its freight was charged at.',
    );
  }

  if (input.lines.length === 0) {
    throw new StorefrontValidationError('An order needs at least one item. Your cart is empty.');
  }

  if (input.lines.length > LINE_CEILING) {
    throw new StorefrontValidationError(
      `An order carries at most ${String(LINE_CEILING)} items. Place the rest as a second order.`,
    );
  }

  const tax = input.taxCents ?? 0;

  for (const figure of [
    input.subtotalCents,
    input.discountCents,
    input.freightCents,
    tax,
    input.totalCents,
  ]) {
    if (!cents(figure)) {
      throw new StorefrontValidationError(
        "The order's charges are not amounts that can be billed. Review your cart and try again.",
      );
    }
  }

  let merchandise = 0;

  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new StorefrontValidationError(
        'An item on the order has a quantity that cannot be ordered. Use whole units.',
      );
    }

    if (!cents(line.unitPriceCents) || !cents(line.discountCents) || !cents(line.lineTotalCents)) {
      throw new StorefrontValidationError(
        'An item on the order has a price that cannot be charged. Add the product again.',
      );
    }

    if (line.lineTotalCents !== line.unitPriceCents * line.quantity - line.discountCents) {
      throw new StorefrontConflictError(
        'An item on the order no longer adds up to its price. Review your cart and place the order again.',
      );
    }

    merchandise += line.lineTotalCents;
  }

  if (merchandise !== input.subtotalCents - input.discountCents) {
    throw new StorefrontConflictError(
      'The items on the order no longer add up to its subtotal. Review your cart and place the order again.',
    );
  }

  if (input.subtotalCents - input.discountCents + input.freightCents + tax !== input.totalCents) {
    throw new StorefrontConflictError(
      "The order's charges no longer add up to its total. Review your cart and place the order again.",
    );
  }

  if (input.payment.authorized && input.payment.amountCents !== input.totalCents) {
    throw new StorefrontConflictError(
      'The amount approved for payment is not the order total. Place the order again.',
    );
  }
}

/** The units an order is for: the quantity summed across its lines, not the number of lines. */
function units(items: readonly { quantity: number }[]): number {
  let total = 0;

  for (const item of items) {
    total += item.quantity;
  }

  return total;
}

/**
 * The tax the order bore, in cents.
 *
 * It is the remainder of the reconciliation `OrderSummary` states: what the
 * total holds over and above the merchandise and the freight. An order taken by
 * a store that charges no tax reads back zero.
 */
function levy(row: Row): number {
  return row.totalCents - row.subtotalCents + row.discountCents - row.shippingCents;
}

/** An order as the history list renders it. */
function summary(row: Row, items: readonly { quantity: number }[]): OrderSummary {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    placedAt: row.placedAt.toISOString(),
    itemCount: units(items),
    subtotalCents: row.subtotalCents,
    discountCents: row.discountCents,
    shippingCents: row.shippingCents,
    taxCents: levy(row),
    totalCents: row.totalCents,
  };
}

/** The order's lines, priced as they stood when it was placed. */
function lines(items: readonly Item[]): OrderLine[] {
  return items.map((item) => ({
    id: item.id,
    productId: item.productId,
    sku: item.product.sku,
    name: item.product.name,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
    lineTotalCents: item.lineTotalCents,
  }));
}

/**
 * The shipping service the order was quoted, or `null` when none was recorded
 * against it.
 *
 * The most recent quote is the one that stands, which is the order the query
 * reads them in. The label is the carrier and the service together, because
 * that is what the store printed on the order and neither alone identifies the
 * service the customer bought.
 *
 * The identifier is the service's own rather than the quote row's, so an order
 * read back names the service the same way the checkout that placed it named
 * the service it chose.
 */
function service(quotes: readonly Quote[]): ShippingOption | null {
  const quote = quotes.at(0);

  if (quote === undefined) {
    return null;
  }

  return {
    id: quote.serviceLevel,
    carrier: quote.carrierCode,
    service: quote.serviceLevel,
    label: `${quote.carrierCode} ${quote.serviceLevel}`,
    priceCents: quote.amountCents,
    estimatedDays: quote.etaDays,
  };
}

/** Who bought the order, read off the account it was written against. */
function contact(account: Account): CustomerContact {
  return {
    name: account.contactName,
    email: account.email,
    company: account.companyName,
  };
}

/**
 * The destination as an order retains it, which is nothing.
 *
 * An order records its charges, its lines and the service it shipped by; where
 * the goods went is collected at checkout and not kept afterwards. A re-read
 * order therefore carries an address with no content rather than an invented
 * one, and the confirmation screen shows the address the checkout submitted,
 * which {@link recordOrder} returns from the draft it was handed.
 */
function blank(): ShippingAddress {
  return {
    line1: '',
    line2: null,
    city: '',
    region: '',
    postalCode: '',
    country: '',
  };
}

/**
 * Takes a cart for a checkout, and answers only to the caller that got it.
 *
 * A checkout spends real money on the strength of a cart: it holds stock, asks
 * a carrier to rate a shipment and asks a processor to approve an amount. Two
 * checkouts of one cart doing that at the same time is two charges for one
 * order, and the cart is the thing they have in common, so the cart is what
 * they compete for. The competition is a single conditional write, which the
 * database settles: whichever caller finds the cart still open takes it out of
 * the session's hands, and the other finds it taken and is told so before it
 * has spent anything.
 *
 * A cart in that state is neither being shopped nor ordered, and a checkout
 * that ends without either finishing or putting it back has abandoned it -
 * which is what it reads as afterwards. {@link unclaim} is how a checkout that
 * failed puts it back.
 *
 * @param id The cart to take.
 * @throws StorefrontConflictError When the cart is not open to be taken -
 * another checkout holds it, or it has already become an order.
 */
export async function claim(id: string): Promise<void> {
  const taken = await prisma.cart.updateMany({
    where: { id, status: CartStatus.ACTIVE },
    data: { status: CartStatus.ABANDONED },
  });

  if (taken.count === 0) {
    throw new StorefrontConflictError(
      'This cart is already being checked out. Wait for that order to finish, or open your cart again.',
    );
  }
}

/**
 * Puts a cart back in the session's hands after a checkout did not finish.
 *
 * The condition matters as much as the write: only a cart a checkout is holding
 * is put back, so this cannot reopen one that has already become an order, and
 * a caller recovering from a failure does not have to work out which of the two
 * happened. A cart that was never taken, or has since been converted, is left
 * exactly as it is.
 *
 * @param id The cart to put back.
 */
export async function unclaim(id: string): Promise<void> {
  await prisma.cart.updateMany({
    where: { id, status: CartStatus.ABANDONED },
    data: { status: CartStatus.ACTIVE },
  });
}

/**
 * Writes a placed order and answers with it.
 *
 * The order and its lines are one unit of work: both are written inside a
 * single transaction, so a customer is never left with an order that has no
 * lines or with lines belonging to an order that was not written. The lines go
 * in as one statement alongside the order rather than one statement each, which
 * is what keeps writing a twelve-line order no more work than writing a
 * one-line order.
 *
 * The account the order is written against is resolved from the contact's email
 * address, and an address the store has not seen before opens an account: a
 * first order is how a trade customer gets one, and refusing the order instead
 * would refuse the customer. An account that already exists is left exactly as
 * it is.
 *
 * The status the order opens in follows the payment: an approved authorization
 * makes it `PAID`, and anything else leaves it `PENDING` for the store to
 * settle. Nothing else about the order is decided here - the figures are the
 * draft's, checked rather than adjusted.
 *
 * Three writes share that transaction, and each of the other two is conditional
 * on something the order depends on still being true. The cart the order was
 * assembled from becomes `CONVERTED`, and a cart that has already become an
 * order is not converted again - so a second attempt at the same cart writes no
 * second order, whatever it was told earlier in the checkout. The quote the
 * freight was charged at becomes this order's, by identifier, and a quote
 * already belonging to another order is not taken from it. Either condition
 * failing rolls the order back with it: the cart, the quote and the order are
 * one fact.
 *
 * @param input Everything the checkout assembled: the customer, the
 * destination, the priced lines, the cart they came from, the quote the freight
 * was charged at, the chosen service, the payment and the figures they add up
 * to.
 * @returns The order as it was written, with its lines, the service it ships by
 * and the destination the draft carried.
 * @throws StorefrontValidationError When the draft is not a recordable order.
 * @throws StorefrontConflictError When the draft's figures disagree with one
 * another or with the amount approved for payment, when the cart has already
 * become an order, or when the quote is not one this order can be placed on.
 */
export async function recordOrder(input: OrderDraft): Promise<OrderDetail> {
  check(input);

  const at = new Date();
  const status: OrderStatus = input.payment.authorized ? OrderStatus.PAID : OrderStatus.PENDING;

  const row = await prisma.$transaction(async (tx) => {
    const account = await tx.customer.upsert({
      where: { email: input.customer.email },
      create: {
        email: input.customer.email,
        companyName: input.customer.company ?? input.customer.name,
        contactName: input.customer.name,
      },
      update: {},
      select: { id: true },
    });

    // The cart is finished here, and the condition is what makes writing this
    // order safe: a cart that has already become an order is not converted a
    // second time, the count says so, and the order this call was about to
    // write is rolled back with it. The account it was checked out under goes
    // on the cart at the same time, which is how a cart a visitor filled
    // anonymously ends up attached to the customer who bought it.
    const converted = await tx.cart.updateMany({
      where: { id: input.cart, status: { not: CartStatus.CONVERTED } },
      data: { status: CartStatus.CONVERTED, customerId: account.id },
    });

    if (converted.count === 0) {
      throw new StorefrontConflictError(
        'That cart has already been ordered. Open the order it became rather than placing it again.',
      );
    }

    const order = await tx.order.create({
      data: {
        orderNumber: mint(at),
        customerId: account.id,
        status,
        subtotalCents: input.subtotalCents,
        discountCents: input.discountCents,
        shippingCents: input.freightCents,
        totalCents: input.totalCents,
        placedAt: at,
        items: {
          createMany: {
            data: input.lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPriceCents: line.unitPriceCents,
              discountCents: line.discountCents,
              lineTotalCents: line.lineTotalCents,
            })),
          },
        },
      },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        placedAt: true,
        subtotalCents: true,
        discountCents: true,
        shippingCents: true,
        totalCents: true,
        items: {
          select: {
            id: true,
            productId: true,
            quantity: true,
            unitPriceCents: true,
            lineTotalCents: true,
            product: { select: { sku: true, name: true } },
          },
          orderBy: { id: 'asc' },
        },
      },
    });

    // The quote the freight was charged at becomes this order's, and only that
    // one: naming it by identifier is what keeps a re-read order showing the
    // service its customer chose rather than a later quote for the same cart.
    // A quote already on another order is not taken from it.
    const quoted = await tx.shippingQuote.updateMany({
      where: { id: input.quote, orderId: null },
      data: { orderId: order.id },
    });

    if (quoted.count === 0) {
      throw new StorefrontConflictError(
        'The shipping quote this order was priced from is no longer available to place it on. Choose a service and place the order again.',
      );
    }

    return order;
  });

  return {
    ...summary(row, row.items),
    lines: lines(row.items),
    shippingOption: input.option,
    contact: input.customer,
    shippingAddress: input.address,
  };
}

/**
 * One page of a customer's orders, most recently placed first.
 *
 * The customer decides which orders the page is drawn from, and a status
 * narrows it to one point in the lifecycle; the same condition sizes the total,
 * so the count is of every order the customer has rather than of the ones
 * returned and a pager can be laid out without a second request. Both
 * statements are issued together because neither depends on the other's result.
 *
 * The ordering ends in the order's own identifier so that paging is stable:
 * orders placed in the same instant would otherwise be free to change places
 * between one request and the next, and an order can only be missing from one
 * page and repeated on another while that is true.
 *
 * A customer with no orders - and an identifier no customer owns - is answered
 * an empty page rather than a failure. An order history is a list that can
 * legitimately be empty, and the view says so far better than an error would.
 *
 * @param input Whose orders, which page, how large, and the status to narrow
 * to. Only the customer is required.
 * @returns The page's orders, the number of orders the filter matched, and the
 * page number and page size the answer was actually built with - both resolved,
 * so a caller never has to re-derive them.
 */
export async function listCustomerOrders(
  input: CustomerOrdersInput,
): Promise<PagedList<OrderSummary>> {
  const size = Math.min(Math.max(whole(input.pageSize, PAGE_SIZE_DEFAULT), 1), PAGE_SIZE_CEILING);
  const page = Math.max(whole(input.page, 1), 1);

  const where =
    input.status === undefined
      ? { customerId: input.customerId }
      : { customerId: input.customerId, status: input.status };

  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [{ placedAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * size,
      take: size,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        placedAt: true,
        subtotalCents: true,
        discountCents: true,
        shippingCents: true,
        totalCents: true,
        items: { select: { quantity: true } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  return {
    items: rows.map((row) => summary(row, row.items)),
    total,
    page,
    pageSize: size,
  };
}

/**
 * One order in full: its figures, its lines, the service it ships by and the
 * account it was placed against.
 *
 * The lookup is by the order's own identifier, so nothing has to be searched
 * for, and the lines are read in a fixed order so the same order reads the same
 * way on every visit. The destination is the one part that cannot be read back;
 * {@link blank} says why.
 *
 * @param id The order's identifier.
 * @returns The order's full detail payload.
 * @throws StorefrontNotFoundError When no order owns the identifier. The
 * failure is an error rather than a `null` return so that every caller - a
 * route handler and a server component alike - reports it the one way, and the
 * message names no value the caller supplied.
 */
export async function readOrderDetail(id: string): Promise<OrderDetail> {
  const row = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      placedAt: true,
      subtotalCents: true,
      discountCents: true,
      shippingCents: true,
      totalCents: true,
      customer: { select: { email: true, companyName: true, contactName: true } },
      items: {
        select: {
          id: true,
          productId: true,
          quantity: true,
          unitPriceCents: true,
          lineTotalCents: true,
          product: { select: { sku: true, name: true } },
        },
        orderBy: { id: 'asc' },
      },
      shippingQuotes: {
        select: {
          carrierCode: true,
          serviceLevel: true,
          amountCents: true,
          etaDays: true,
        },
        orderBy: { quotedAt: 'desc' },
        take: 1,
      },
    },
  });

  if (row === null) {
    throw new StorefrontNotFoundError('That order is not in this account.');
  }

  return {
    ...summary(row, row.items),
    lines: lines(row.items),
    shippingOption: service(row.shippingQuotes),
    contact: contact(row.customer),
    shippingAddress: blank(),
  };
}

/**
 * What the store's records say about the cart a session is shopping with, for a
 * caller that has already established the session is holding no open one.
 */
export interface CartOutcome {
  /** The cart the session's token names. */
  cart: string;

  /**
   * The order it became, or `null` when it has not become one - which, for a
   * cart that is no longer open, means an attempt is holding it rather than
   * that nothing happened to it.
   */
  order: OrderDetail | null;
}

/**
 * What became of the cart a session is shopping with: the order it became, or
 * the fact that it exists and became none.
 *
 * It answers the question a checkout asks when it finds the session holding no
 * open cart: did the cart this session had become an order, is it being held by
 * an attempt, or was there never a cart at all? Without an answer all three are
 * indistinguishable, and a customer whose order was placed by a submission whose
 * reply was lost would be told their cart is gone and invited to order again.
 * With one, each of the three has its own answer, and none of them is a
 * statement that nothing was charged.
 *
 * The cart is addressed by the session's own token, so what this returns is only
 * ever the order of the cart the caller was already entitled to read; nothing
 * about which order to look for comes from a request. The link between the two
 * is the quote the freight was charged at - it is written against the cart when
 * the freight is rated and against the order when the order is placed, in the
 * transaction that writes it - so an order with a quote for this cart is an
 * order that was placed from it. The most recently quoted one wins, which is
 * the order a repeated checkout of one cart would have placed.
 *
 * @param token The session token the cart is addressed by, as `./cart.service`
 * addresses it.
 * @returns The cart and the order it became, the cart and `null` when it became
 * none, or `null` when this session has no cart at all. A quote that names an
 * order names one that exists: deleting an order deletes the quotes written
 * against it.
 */
export async function readCartOutcome(token: string): Promise<CartOutcome | null> {
  const cart = await prisma.cart.findUnique({
    where: { sessionToken: token },
    select: { id: true },
  });

  if (cart === null) {
    return null;
  }

  const quoted = await prisma.shippingQuote.findFirst({
    where: { cartId: cart.id, orderId: { not: null } },
    // The identifier breaks a tie the timestamp cannot: two quotes taken in one
    // instant would otherwise be free to change places between reads.
    orderBy: [{ quotedAt: 'desc' }, { id: 'desc' }],
    select: { orderId: true },
  });

  const id = quoted?.orderId ?? null;

  return { cart: cart.id, order: id === null ? null : await readOrderDetail(id) };
}
