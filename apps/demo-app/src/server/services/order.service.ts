/**
 * Orders: writing one, and reading a customer's back.
 *
 * Two jobs live here and nothing else. A placed order is written at the end of
 * checkout - the order together with every one of its lines, in one
 * transaction, so a customer is never left with a charge recorded against half
 * an order - and a customer's orders are read back for the history view and
 * for the confirmation screen. No stock is moved and no cart is touched: an
 * order is a record of what was bought, and the modules that own inventory and
 * carts own the rest of what placing one means.
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

import type {
  CustomerContact,
  OrderDetail,
  OrderLine,
  OrderStatus,
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
  id: string;
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
 */
function service(quotes: readonly Quote[]): ShippingOption | null {
  const quote = quotes.at(0);

  if (quote === undefined) {
    return null;
  }

  return {
    id: quote.id,
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
 * @param input Everything the checkout assembled: the customer, the
 * destination, the priced lines, the chosen service, the payment and the
 * figures they add up to.
 * @returns The order as it was written, with its lines, the service it ships by
 * and the destination the draft carried.
 * @throws StorefrontValidationError When the draft is not a recordable order.
 * @throws StorefrontConflictError When the draft's figures disagree with one
 * another or with the amount approved for payment.
 */
export async function recordOrder(input: OrderDraft): Promise<OrderDetail> {
  check(input);

  const at = new Date();
  const status: OrderStatus = input.payment.authorized ? 'PAID' : 'PENDING';

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
          id: true,
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
