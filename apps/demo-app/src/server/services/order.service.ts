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
 * a single conditional write that one caller wins. The same write puts the name
 * of the attempt that took it on the cart - `CheckoutDraft.idempotencyKey`, in
 * `carts.checkout_key` - so which attempt holds which cart is a fact the store
 * keeps rather than one a process remembers. {@link unclaim} puts it back, name
 * and all, when the checkout it was taken for did not finish, so a customer
 * whose payment was declined still has their cart and the name holds nothing.
 * The cart's last transition, to `CONVERTED`, happens inside the transaction
 * that writes the order, which is what makes a cart and the order it became one
 * fact rather than two: there is no moment at which an order exists and its
 * cart is still orderable, and no second order can be written from a cart that
 * has already become one. The name stays on the converted cart, and that is
 * what {@link readAttempt} reads back: what the attempt of a given name did -
 * the order its cart became, or the cart it is still holding - so a repeat of a
 * submission is answered with that attempt's own outcome by any process, after
 * any restart, and never with the outcome of another attempt.
 *
 * The same transaction releases the session's open-cart pointer. A cart holds
 * `carts.open_token` for as long as it is the cart its session shops with, and
 * the conversion sets it to `NULL`, which is what lets `./cart.service` open
 * the next cart for that session: the shopper who has just bought something
 * carries on shopping instead of being left with a store that has no cart for
 * them. The cart itself is not touched otherwise - its lines, its prices and
 * its session token all stay - so it remains the readable record of what was
 * ordered and of the session that ordered it.
 *
 * **The order is written against the session's own account.** The cart carries
 * the account when it has one, and it is preferred over the contact's email
 * address, so a session that has bought before keeps the account its history is
 * filed under and the order it has just placed appears in that history. Only a
 * cart with no account at all resolves one from the email - a first order is how
 * a trade customer gets an account - and the contact the checkout collected is
 * kept on the order either way, so the person who placed it is recorded even
 * when the account was opened for somebody else at the same company.
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
 * **What the checkout collected is stored, not echoed.** The contact, the
 * destination and the delivery note go into columns of the order in the same
 * transaction as its lines, and every order this module answers with - the one
 * just written as much as one read back weeks later - is built from those
 * columns rather than from the request that carried them. An order written
 * without a collected contact or destination - the seeded order history, which
 * records charges and lines only - carries none, which reads back as the
 * account's own contact and as the empty address {@link blank} describes,
 * rather than as a guess.
 *
 * Importing this module opens no connection and reads no configuration other
 * than `DATABASE_URL`, which `@/server/db/pool` reads to build the pool the
 * client in `@/server/db/prisma` queries through. Neither connects until the
 * first query, and an absent `DATABASE_URL` surfaces only there, so a page that
 * imports this module still builds and type-checks against a machine with no
 * database.
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
 * The code a rejected unique constraint arrives with.
 *
 * `carts.checkout_key` is unique, so it is what the database answers a claim
 * with when the attempt name it carries is already on another cart. It is
 * matched as a string off the caught value, as `./cart.service` and the mapper
 * in `@/server/errors` match it, because the generated client's error classes
 * are a build product this module's types do not otherwise depend on.
 */
const DUPLICATE = 'P2002';

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
  /**
   * Who is buying, as the checkout collected it. It is recorded on the order,
   * and it identifies the account the order is written against only when the
   * cart carries none of its own - see {@link recordOrder}.
   */
  customer: CustomerContact;
  /** Where the goods are going, as the checkout collected it. */
  address: ShippingAddress;
  /**
   * What the buyer asked the packers to know, or `null` when they said nothing.
   * It is stored with the order and returned with it; nothing acts on it.
   */
  notes: string | null;
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
 * An order as it stands before a payment exists for it: everything
 * {@link OrderDraft} carries except the authorization.
 *
 * It is the shape {@link checkOrderDraft} asks its questions of, and it exists
 * because a checkout assembles all of this before it has anything to pay with -
 * the cart, the priced lines, the quote, the chosen service and the figures are
 * settled by the time an amount is sent to a processor, and the authorization is
 * the one member that is not. Stating that as a type is what lets a checkout
 * hand the very same object to the check and then to {@link recordOrder} with
 * the authorization added, so the figures that were checked and the figures that
 * are written cannot differ.
 */
export type UnpaidOrderDraft = Omit<OrderDraft, 'payment'>;

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
 * The columns an order keeps of what its checkout collected: who placed it,
 * where it ships and what the packers were told.
 *
 * Every member is nullable because an order written without a collected
 * contact or destination carries none, and each of the two groups is written
 * as a set or not at all - so the order has a contact of its own only when both
 * `contactName` and `contactEmail` are present, and a destination only when all
 * five required `ship*` columns are, rather than each field being interpreted
 * on its own. {@link recorded} and {@link destination} are where those two
 * decisions are made, and they are made in one place so that a freshly written
 * order and one read back weeks later are described identically.
 */
type Collected = {
  contactName: string | null;
  contactEmail: string | null;
  contactCompany: string | null;
  shipLine1: string | null;
  shipLine2: string | null;
  shipCity: string | null;
  shipRegion: string | null;
  shipPostalCode: string | null;
  shipCountry: string | null;
  deliveryNotes: string | null;
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
 * The last code point below the printable range: the top of the C0 control
 * block, `U+001F`.
 */
const CONTROL = 0x1f;

/** `DEL`, the one control character above the printable ASCII range. */
const DEL = 0x7f;

/**
 * Whether `value` is text this store can record: no C0 control character and
 * no `DEL`.
 *
 * It is a property of the column rather than a house style. A text column
 * cannot hold `U+0000` at all - the write is refused by the database, not
 * truncated - and the rest of the class is invisible in everything that reads
 * an order back, so a value carrying one of these characters is a value an
 * order cannot be written with. Asking here is what turns that into a rejected
 * draft instead of a transaction that fails partway through, which matters
 * because by the time a checkout writes an order it has already held stock,
 * taken a freight quote and had an amount approved.
 *
 * Nothing else is refused: an accented letter, an ideograph and an emoji are
 * ordinary text to this store and to its columns alike. The class is stated as
 * a code-point test rather than as a pattern because a pattern for it has to
 * contain the very characters it excludes, and the loop reads UTF-16 units,
 * which is exact for it: a control character is always one unit and a surrogate
 * is numerically far above both bounds.
 *
 * @param value A value a draft carries into a column.
 */
function plain(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);

    if (code <= CONTROL || code === DEL) {
      return false;
    }
  }

  return true;
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
 * Checks everything about an order that can be established without a payment,
 * and says so by throwing when the draft cannot be written as it stands.
 *
 * Two kinds of rejection are distinguished, because a customer can act on one
 * and not the other. A draft that is not an order at all - no lines, a
 * fractional quantity, a negative charge, text no column can hold - is a
 * rejected request. A draft whose figures do not add up is a collision: the
 * cart was priced and quoted a moment ago, and if its parts no longer reconcile
 * then something moved in between, which a fresh attempt resolves and a
 * silently corrected total would hide. Which error class carries which is part
 * of the contract, not an implementation detail: a caller distinguishes "this
 * is not an order" from "these figures do not reconcile" by the class alone.
 *
 * **It is exported so that a checkout can ask it before it charges anything.**
 * Every question here is answered from the draft alone, so the answer does not
 * change between the moment a checkout has assembled the order and the moment
 * {@link recordOrder} would ask it. A caller that runs it first therefore
 * cannot be refused after it has authorized a payment - and a refusal after a
 * charge is the one failure that leaves an amount approved with no order
 * against it and no safe way to retry. `./checkout.service` depends on exactly
 * that guarantee: it assembles the draft, runs this, and only then sends an
 * amount to a processor. The check is synchronous and issues no query, so
 * running it earlier costs a caller nothing.
 *
 * What is left to {@link check} is the one question this cannot answer: whether
 * the amount a processor approved is the total the order is written for.
 *
 * @param input The order as it stands before a payment exists for it.
 * @throws StorefrontValidationError When the draft is not a recordable order.
 * @throws StorefrontConflictError When its figures disagree with one another.
 */
export function checkOrderDraft(input: UnpaidOrderDraft): void {
  if (input.cart.length === 0 || input.quote.length === 0) {
    throw new StorefrontValidationError(
      'An order has to name the cart it was assembled from and the quote its freight was charged at.',
    );
  }

  // Everything the draft carries into a column is asked about here, which is
  // the contact and the destination: `recordOrder` writes both, so a value one
  // of them holds that no column can is a draft this store cannot record. The
  // request surfaces hold their own fields to the same class, and this is the
  // layer that has to hold, because a draft can be assembled in process - by a
  // page or a script - and reach this function without having been through one
  // of them.
  for (const value of [
    input.customer.name,
    input.customer.email,
    input.customer.company,
    input.address.line1,
    input.address.line2,
    input.address.city,
    input.address.region,
    input.address.postalCode,
    input.address.country,
  ]) {
    if (value !== null && !plain(value)) {
      throw new StorefrontValidationError(
        'The contact details or the delivery address on the order hold a character this store cannot record. Use ordinary text characters and place the order again.',
      );
    }
  }

  // The note is free text the packers read, and it is held to less than the
  // fields above on purpose: a note written across several lines is an ordinary
  // note, so the line breaks and tabs a form may collect are kept rather than
  // refused. What is refused is the one character the column genuinely cannot
  // hold - PostgreSQL's `UTF8` encoding has no representation for `U+0000`, so
  // the driver rejects the parameter and the order's transaction fails partway
  // through instead of the draft being turned away here, before anything has
  // been spent on it.
  if (input.notes !== null && input.notes.includes('\u0000')) {
    throw new StorefrontValidationError(
      'The delivery notes on the order hold a character this store cannot record. Use ordinary text characters and place the order again.',
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
}

/**
 * Checks that a draft with its payment can be written as it stands, and says so
 * by throwing when it cannot.
 *
 * It is everything {@link checkOrderDraft} asks, which is all of the draft's own
 * questions, followed by the one question that needs the authorization: an
 * approved amount has to be the total the order is written for, because an order
 * paid for a different figure than it charges is neither the order the customer
 * agreed to nor one the store can settle. That is a collision like the other
 * figures that no longer reconcile, and for the same reason - the cart was
 * priced, quoted and authorized a moment ago.
 *
 * {@link recordOrder} asks this and nothing else before it opens its
 * transaction, so a draft it accepts is one whose remaining ways to fail are the
 * conditions inside that transaction. A caller recovering from a failed write
 * can rely on that, and a caller that has already run {@link checkOrderDraft}
 * against the same figures can rely on more: the only question left for this to
 * refuse it on is the one about the amount its own processor approved.
 *
 * @param input The order as it will be written, authorization included.
 * @throws StorefrontValidationError When the draft is not a recordable order.
 * @throws StorefrontConflictError When its figures disagree with one another or
 * with the amount approved for payment.
 */
function check(input: OrderDraft): void {
  checkOrderDraft(input);

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
 * Who placed the order, as the checkout collected it, or `null` for an order
 * that recorded nobody.
 *
 * The three columns are written together by {@link recordOrder}, so the name
 * and the email - the two a contact cannot be described without - are checked
 * together to decide whether the order has a contact of its own; the company
 * passes through as recorded. An order that has none is described by its
 * account instead, which is what {@link contact} answers, and the two are read
 * in that order everywhere an order is returned.
 *
 * @param row The order's collected columns, as every query below selects them.
 */
function recorded(row: Collected): CustomerContact | null {
  const { contactName: name, contactEmail: email } = row;

  if (name === null || email === null) {
    return null;
  }

  return { name, email, company: row.contactCompany };
}

/**
 * Where the order ships, as the checkout collected it, or {@link blank} for an
 * order that recorded no destination.
 *
 * The six columns are written together by {@link recordOrder}, so an order
 * either carries the whole address or carries none of it, and the five required
 * ones are checked together rather than each being defaulted on its own: a
 * half-known destination is not a destination, and printing one would be worse
 * than admitting there is none. `line2` is genuinely optional - a customer with
 * no dock or suite leaves it empty - so it passes through as the `null` the
 * shape declares.
 *
 * @param row The order's collected columns, as every query below selects them.
 */
function destination(row: Collected): ShippingAddress {
  const {
    shipLine1: line1,
    shipCity: city,
    shipRegion: region,
    shipPostalCode: postalCode,
    shipCountry: country,
  } = row;

  if (
    line1 === null ||
    city === null ||
    region === null ||
    postalCode === null ||
    country === null
  ) {
    return blank();
  }

  return { line1, line2: row.shipLine2, city, region, postalCode, country };
}

/**
 * The destination of an order that recorded none, which is an address with no
 * content.
 *
 * Every order placed through this store's checkout carries where it ships (see
 * {@link recordOrder}), so this is what the orders written without a
 * destination read back as - the seeded history, which records charges and
 * lines and never had an address to record. An empty address is the truthful
 * answer for them: it says the store does not know where that order went, where
 * an invented or partially defaulted one would say something false.
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
 * The same statement writes the name of the attempt that took the cart, so the
 * hold and the name it is held under are one fact: there is no moment at which
 * a cart is held by nobody in particular, and {@link readAttempt} can answer a
 * repeat of that name from this row after the process that took it is gone. The
 * column is unique, so a name already on another cart makes the whole write
 * fail and the cart is not taken. That is answered as the collision it is
 * rather than as the database's own wording: nothing has been spent, and the
 * submission that carried the name is not the attempt that holds it.
 *
 * @param id The cart to take.
 * @param key The name of the attempt taking it, as the submission carried it.
 * @throws StorefrontConflictError When the cart is not open to be taken -
 * another checkout holds it, or it has already become an order - or when `key`
 * already holds another cart.
 */
export async function claim(id: string, key: string): Promise<void> {
  let taken: { count: number };

  try {
    taken = await prisma.cart.updateMany({
      where: { id, status: CartStatus.ACTIVE },
      data: { status: CartStatus.ABANDONED, checkoutKey: key },
    });
  } catch (cause) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === DUPLICATE
    ) {
      throw new StorefrontConflictError(
        'This order was already started from another cart, so nothing was taken from this one. Check your orders before placing it again.',
        { cause },
      );
    }

    throw cause;
  }

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
 * The attempt's name comes off the cart in the same statement. A checkout puts
 * a cart back only when it took nothing against it, so the name no longer holds
 * anything, and a repeat of it is a submission like any other rather than one
 * answered with a cart the customer is shopping with again.
 *
 * @param id The cart to put back.
 */
export async function unclaim(id: string): Promise<void> {
  await prisma.cart.updateMany({
    where: { id, status: CartStatus.ABANDONED },
    data: { status: CartStatus.ACTIVE, checkoutKey: null },
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
 * The account the order is written against is the cart's own, whenever the cart
 * has one. A cart carries the account of the session that filled it - attached
 * when an earlier order converted a cart of that session, or by the seed - so
 * preferring it is what keeps a session's orders in one history: the order just
 * placed appears in the same list as the ones before it, which is the list the
 * storefront shows. Only a cart with no account resolves one from the contact's
 * email address, and an address the store has not seen before opens an account
 * there: a first order is how a trade customer gets one, and refusing the order
 * instead would refuse the customer. An account that already exists is left
 * exactly as it is, contact details included - a purchaser who types their own
 * name into a colleague's account is recorded on the order rather than written
 * over the account.
 *
 * What the checkout collected is written with the order: the contact, the six
 * fields of the destination and the delivery note. They are columns of the
 * order rather than a copy of the request, and the value returned is selected
 * back out of the row that was written, so the confirmation screen shows what
 * the store holds rather than what the browser sent.
 *
 * The status the order opens in follows the payment: an approved authorization
 * makes it `PAID`, and anything else leaves it `PENDING` for the store to
 * settle. Nothing else about the order is decided here - the figures are the
 * draft's, checked rather than adjusted.
 *
 * What is checked before the transaction opens is {@link check}: the draft's own
 * questions, which are {@link checkOrderDraft}, and then whether an approved
 * amount is this order's total. The first half is exported for a reason that
 * matters to whoever calls this after paying for the order - a caller that ran
 * {@link checkOrderDraft} before it authorized anything has already answered
 * every question here that does not concern the authorization, so the only way
 * this call can refuse its draft is the amount its own processor approved.
 *
 * Three writes share that transaction, and each of the other two is conditional
 * on something the order depends on still being true. The cart the order was
 * assembled from becomes `CONVERTED` and releases its session's open-cart
 * pointer, and a cart that has already become an order is not converted again -
 * so a second attempt at the same cart writes no second order, whatever it was
 * told earlier in the checkout. Releasing the pointer in this write rather than
 * afterwards is what makes "the cart is finished" and "the session may open
 * another" one fact: there is no window in which the order exists and the
 * session still has no cart it can shop with, and a rolled-back order leaves
 * the pointer exactly where it was. The quote the freight was charged at
 * becomes this order's, by identifier, and a quote already belonging to another
 * order is not taken from it. Either condition failing rolls the order back
 * with it: the cart, the quote and the order are one fact.
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
    // The session's own account, when its cart carries one. It is read inside
    // the transaction the order is written in, so the account the order is
    // filed under is the one the cart held at the moment it was converted.
    const shopper = await tx.cart.findUnique({
      where: { id: input.cart },
      select: { customerId: true },
    });

    const account =
      shopper?.customerId ??
      (
        await tx.customer.upsert({
          where: { email: input.customer.email },
          create: {
            email: input.customer.email,
            companyName: input.customer.company ?? input.customer.name,
            contactName: input.customer.name,
          },
          update: {},
          select: { id: true },
        })
      ).id;

    // The cart is finished here, and the condition is what makes writing this
    // order safe: a cart that has already become an order is not converted a
    // second time, the count says so, and the order this call was about to
    // write is rolled back with it. Two more columns move in the same
    // statement. The account it was checked out under goes on the cart, which
    // is how a cart a visitor filled anonymously ends up attached to the
    // customer who bought it and how the session that filled it keeps that
    // account for the cart after this one. The open-cart pointer is released,
    // which is what lets `./cart.service` open that next cart: the token stays
    // on the cart as the session's history, and only the claim to be the cart
    // that session shops with is given up.
    const converted = await tx.cart.updateMany({
      where: { id: input.cart, status: { not: CartStatus.CONVERTED } },
      data: { status: CartStatus.CONVERTED, customerId: account, openToken: null },
    });

    if (converted.count === 0) {
      throw new StorefrontConflictError(
        'That cart has already been ordered. Open the order it became rather than placing it again.',
      );
    }

    const order = await tx.order.create({
      data: {
        orderNumber: mint(at),
        customerId: account,
        status,
        subtotalCents: input.subtotalCents,
        discountCents: input.discountCents,
        shippingCents: input.freightCents,
        totalCents: input.totalCents,
        placedAt: at,
        // What the checkout collected, written with the order rather than kept
        // by the request: the contact as a set, the destination as a set, and
        // the note the buyer may have left. This is what makes the order's own
        // account of who placed it and where it ships readable afterwards, by
        // the confirmation screen and by anything that reads the order later.
        contactName: input.customer.name,
        contactEmail: input.customer.email,
        contactCompany: input.customer.company,
        shipLine1: input.address.line1,
        shipLine2: input.address.line2,
        shipCity: input.address.city,
        shipRegion: input.address.region,
        shipPostalCode: input.address.postalCode,
        shipCountry: input.address.country,
        deliveryNotes: input.notes,
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
        contactName: true,
        contactEmail: true,
        contactCompany: true,
        shipLine1: true,
        shipLine2: true,
        shipCity: true,
        shipRegion: true,
        shipPostalCode: true,
        shipCountry: true,
        deliveryNotes: true,
        // Selected so that the contact this call answers with is read through
        // the same two steps as a re-read order's: the order's own contact, and
        // the account's when the order recorded none. One path, so a freshly
        // placed order and the same order opened later cannot describe their
        // buyer differently.
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

  // Everything but the service comes out of the row that was just written, so
  // the caller is answered with the order the store now holds rather than with
  // the draft it submitted. The service is the draft's because the quote row
  // this order was placed on is the very one the checkout chose and recorded -
  // the transaction above attached it by identifier - and reading it back would
  // be a second query for a value already in hand.
  return {
    ...summary(row, row.items),
    lines: lines(row.items),
    shippingOption: input.option,
    contact: recorded(row) ?? contact(row.customer),
    shippingAddress: destination(row),
    notes: row.deliveryNotes,
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
 * One order in full, found by either of the two keys that name exactly one
 * order: the identifier the store assigned it, or the reference printed on it.
 *
 * Both exported reads below are this one query and this one mapping, so an
 * order opened by its identifier and the same order opened by its reference
 * cannot be described differently - the same columns, the same lines in the
 * same order, the same fallbacks for a contact or a destination the order never
 * recorded. Each key is unique in the schema, which is what lets the lookup be a
 * `findUnique` rather than a search.
 *
 * @param where The one unique key to find the order by.
 * @returns The order's full detail payload.
 * @throws StorefrontNotFoundError When no order owns the key. The message names
 * no value the caller supplied.
 */
async function detailWhere(where: { id: string } | { orderNumber: string }): Promise<OrderDetail> {
  const row = await prisma.order.findUnique({
    where,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      placedAt: true,
      subtotalCents: true,
      discountCents: true,
      shippingCents: true,
      totalCents: true,
      contactName: true,
      contactEmail: true,
      contactCompany: true,
      shipLine1: true,
      shipLine2: true,
      shipCity: true,
      shipRegion: true,
      shipPostalCode: true,
      shipCountry: true,
      deliveryNotes: true,
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
    contact: recorded(row) ?? contact(row.customer),
    shippingAddress: destination(row),
    notes: row.deliveryNotes,
  };
}

/**
 * One order in full: its figures, its lines, the service it ships by and the
 * account it was placed against.
 *
 * The lookup is by the order's own identifier, so nothing has to be searched
 * for, and the lines are read in a fixed order so the same order reads the same
 * way on every visit. The contact and the destination come from the order's own
 * columns, falling back to the account's contact and to {@link blank} for an
 * order written without a collected contact or destination.
 *
 * @param id The order's identifier.
 * @returns The order's full detail payload.
 * @throws StorefrontNotFoundError When no order owns the identifier. The
 * failure is an error rather than a `null` return so that every caller - a
 * route handler and a server component alike - reports it the one way, and the
 * message names no value the caller supplied.
 */
export async function readOrderDetail(id: string): Promise<OrderDetail> {
  return detailWhere({ id });
}

/**
 * One order in full, found by the reference the store printed on it - the
 * `LS-…` order number a buyer reads out, copies and finds in the address of
 * their receipt.
 *
 * It is the read behind that address: `/checkout?order=…` names an order by
 * its reference, because that is the value a buyer holds, and the page renders
 * the receipt from what this returns. The answer is {@link readOrderDetail}'s
 * in every respect - the same query, the same mapping - so an order read back by
 * its reference is described exactly as it is everywhere else it is read.
 *
 * The reference is matched exactly as given. The caller decides what counts as
 * a well-formed reference before it asks; a value no order carries is answered
 * as not found, never as a near match.
 *
 * @param orderNumber The order's reference, such as `LS-2026-MUJ8HJ2CV31`.
 * @returns The order's full detail payload.
 * @throws StorefrontNotFoundError When no order carries the reference, for the
 * reason {@link readOrderDetail} gives for throwing rather than returning
 * `null`.
 */
export async function readOrderByNumber(orderNumber: string): Promise<OrderDetail> {
  return detailWhere({ orderNumber });
}

/**
 * What the attempt of a given name did, as the store's records say: the cart it
 * claimed, and the order that cart became.
 *
 * It answers the question a checkout asks of a submission before it takes
 * anything: has this very attempt already been made? The name is written on the
 * cart by {@link claim}, kept when the cart becomes an order and taken off by
 * {@link unclaim}, so the row that carries it is the whole record, and the
 * answer is the same from any process and after any restart. Each state the
 * cart can be in has exactly one reading:
 *
 * * **`CONVERTED`.** The attempt placed an order, and that order is the answer.
 * * **`ABANDONED`.** The attempt is holding the cart - running now, or ended
 *   with an authorization that may stand against it - and no order was written.
 *   The cart comes back with `order: null`, which is never a statement that
 *   nothing was charged. A hold that outlived its attempt has given the
 *   session's open-cart pointer up (`./cart.service` `vacate`, and its stale-hold
 *   recovery), so the session shops on with another cart while this one stays
 *   held under the name; the lookup below is by name, not by pointer, so it
 *   answers for the held cart either way.
 * * **`ACTIVE`, or no cart at all.** The name holds nothing: the attempt never
 *   claimed a cart, or put the cart back having taken nothing, or the store
 *   settled the hold by hand and reopened the cart. That is `null`, the same
 *   answer a name nobody has used gets.
 *
 * The cart is addressed by the session's own token as well as by the name, so
 * what this returns is only ever the order of a cart the caller was already
 * entitled to read: a name from a request can find this session's attempt and
 * nothing else. The link from the cart to its order is the quote the freight
 * was charged at - it is written against the cart when the freight is rated and
 * against the order when the order is placed, in the transaction that writes it
 * - so an order with a quote for this cart is an order that was placed from it.
 * The most recently quoted one wins, which is the order a repeated checkout of
 * one cart would have placed.
 *
 * @param token The session token the cart is addressed by, as `./cart.service`
 * addresses it.
 * @param key The attempt's name, as the submission carried it.
 * @returns `cart`, the cart the attempt claimed, with `order`, the order it
 * became - or `null` in `order` for a cart still held, and for a converted cart
 * whose order cannot be found through its quotes - or `null` when the name holds
 * no cart of this session. A quote that names an order names one that exists:
 * deleting an order deletes the quotes written against it.
 */
export async function readAttempt(
  token: string,
  key: string,
): Promise<{ cart: string; order: OrderDetail | null } | null> {
  // One row at most: the name is unique across carts, and the token keeps the
  // lookup inside the session asking.
  const cart = await prisma.cart.findUnique({
    where: { checkoutKey: key, sessionToken: token },
    select: { id: true, status: true },
  });

  if (cart === null || cart.status === CartStatus.ACTIVE) {
    return null;
  }

  if (cart.status === CartStatus.ABANDONED) {
    return { cart: cart.id, order: null };
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
