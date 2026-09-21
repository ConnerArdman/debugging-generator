/**
 * The cart's read and write layer.
 *
 * Five things are asked of a cart, and this module answers all five: read the
 * cart a visitor is shopping with, put a quantity of one product into it, set
 * one of its lines to an exact quantity, take one line out, and take every line
 * out. Each answer is the `CartView` of `@/lib/types` rather than a row, so the
 * cart drawer, the header badge, the checkout summary and the services that
 * price and reserve a cart all read one shape and none of them holds a column
 * name or walks a relation of its own.
 *
 * **The server is the authority on what a cart holds.** Every function below
 * ends by reading the cart back, so a caller is answered with the cart as the
 * database now holds it rather than with the change it asked for. A browser that
 * changed the cart therefore never has to work out what the cart now contains or
 * what it costs, and `./checkout.service` - which reads the stored cart for
 * itself when it prices and reserves an order - cannot disagree with what the
 * customer was shown.
 *
 * **A cart is addressed by its session token.** The token is the caller's -
 * carried by the storefront's own cookie and resolved to a default by the route
 * handler's schema before it reaches this module - so no function here names a
 * cart, and no token literal appears in this file. A token identifies one cart,
 * and a cart is only shoppable while it is `ACTIVE`: a cart that has converted
 * into an order or been abandoned is history, and looking one up is a lookup
 * that found nothing rather than a cart to change.
 *
 * **Money is recomputed here and multiplied nowhere else.** A line's unit price
 * is the price the line was captured at, its total is that price taken as many
 * times as there are units, and the cart's subtotal is the sum over its lines.
 * Every one of those values is an integer count of US cents, which is how the
 * columns behind them are stored, so the arithmetic is integer arithmetic from
 * the column to the view and no value is ever scaled into dollars and back.
 * Volume discounts are not applied here: a cart shows what its lines cost, and
 * `./pricing.service` resolves what a customer pays for them at checkout.
 *
 * **What a view carries, JSON can carry.** The one timestamp becomes an
 * ISO-8601 UTC string, because a `Date` does not survive the trip from a server
 * component into a client component and `@/providers/CartProvider` is a client
 * component.
 *
 * **A view reads the same twice.** Lines are ordered by their own identifier,
 * which is unique and never reused, so a cart read twice lists its lines in one
 * order and a line added does not shuffle the others.
 *
 * **A line's ceiling is enforced by the statement that raises it.** The most
 * units a line may hold is a predicate of the write that adds them rather than a
 * value this module reads first and compares afterwards, so two tabs adding the
 * same product at the same moment cannot both be told there was room for their
 * units. The losing caller is answered with a conflict and the stored line never
 * crosses {@link LINE_UNITS_CEILING}. Nothing here opens a transaction: each
 * function makes one decisive statement, and the statement that dates the cart
 * afterwards is metadata about a decision already taken.
 *
 * Stock is not this module's concern. Changing a cart records an intent to buy;
 * whether the units can be promised is answered by `./inventory.service` when
 * the cart is checked out, which is why nothing here decrements a stock
 * position or writes a movement.
 *
 * Importing this module opens no connection and reads no configuration - the
 * client in `@/server/db/prisma` connects on its first query - so a page that
 * imports it still builds and type-checks against a machine with no database.
 */

import { CartStatus } from '@/generated/prisma/client';
import type { CartItemDraft, CartLine, CartLineQuantityDraft, CartView } from '@/lib/types';
import { prisma } from '@/server/db/prisma';
import {
  StorefrontConflictError,
  StorefrontNotFoundError,
  StorefrontValidationError,
} from '@/server/errors';

/**
 * The most units one line may hold.
 *
 * A cart holds one line per product, so this is the ceiling on a single
 * product's quantity rather than on the cart. The bound is restated here rather
 * than read from the request schema because the two measure different things:
 * the schema bounds the units one request may add, while this bounds the units
 * the stored line ends up holding - a request for ten units against a line that
 * already holds ninety-five is a request the schema accepts and this module
 * refuses.
 */
const LINE_UNITS_CEILING = 99;

/**
 * The code a rejected unique constraint arrives with.
 *
 * `cart_items` is unique on `(cart_id, product_id)`, so this is what the
 * database answers an attempt to open a second line for a product with - the one
 * outcome {@link addCartLine} expects to lose to a concurrent caller and
 * recovers from rather than reports.
 *
 * It is matched as a string off the caught value, exactly as the mapper in
 * `@/server/errors` matches it: the generated Prisma client is produced by
 * `prisma generate` and is not in version control, so importing an error class
 * of its own to compare against would tie this module's type graph to a build
 * step it does not otherwise need.
 */
const UNIQUE_VIOLATION = 'P2002';

/**
 * What a caller is told when the token addresses no cart that can still be
 * shopped with.
 *
 * Every function in this module resolves its cart first and answers this one
 * sentence when there is none, so a read and any of the four writes report a
 * converted, abandoned or unknown cart identically.
 */
const NO_OPEN_CART = 'No open cart was found for this session.';

/**
 * What a caller is told when the line a change named is not in its cart.
 *
 * It names the line rather than the table it was looked for in, and it says the
 * same thing for a line that has been removed, a line that never existed and a
 * line belonging to somebody else's cart: all three are a request about a line
 * this session's cart does not hold, and which of the three it was is not a
 * caller's business to learn.
 */
const NO_SUCH_LINE = 'That line is no longer in this cart.';

/** The cart fields a view is built from, as the query below selects them. */
type Row = {
  id: string;
  status: CartStatus;
  updatedAt: Date;
  items: readonly {
    id: string;
    productId: string;
    quantity: number;
    unitPriceCents: number;
    product: { sku: string; slug: string; name: string; imageUrl: string | null };
  }[];
};

/**
 * One cart as every consumer reads it, with its money recomputed from the
 * quantities and unit prices the row carries.
 *
 * A line's total and the cart's subtotal are derived rather than stored, so a
 * quantity that changed and a total that did not cannot disagree. Both are
 * accumulated in cents as whole numbers: an integer count of cents times a
 * whole number of units is exact, where the same arithmetic in dollars would
 * leave a fraction of a cent behind on a long cart.
 *
 * `itemCount` is the units across the cart rather than the number of lines,
 * which is what a badge reading "14" beside a cart of three products is
 * counting.
 */
function buildCartView(row: Row): CartView {
  const lines: CartLine[] = [];
  let count = 0;
  let total = 0;

  for (const item of row.items) {
    const line = item.unitPriceCents * item.quantity;

    lines.push({
      id: item.id,
      productId: item.productId,
      sku: item.product.sku,
      slug: item.product.slug,
      name: item.product.name,
      imageUrl: item.product.imageUrl,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: line,
    });

    count += item.quantity;
    total += line;
  }

  return {
    id: row.id,
    status: row.status,
    lines,
    itemCount: count,
    subtotalCents: total,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Whether a caught value is the database's rejection of a duplicate line.
 *
 * `catch` binds `unknown`, and JavaScript permits throwing anything at all, so
 * the value is duck-typed the way `@/server/errors` duck-types the same field:
 * a `code` property is read off it as `unknown` and compared as a string. The
 * question is deliberately narrow - one code, not a family of them - because the
 * only failure {@link addCartLine} knows how to recover from is a second caller
 * having opened the line it was about to open.
 *
 * @param error Any caught value.
 * @returns `true` only for {@link UNIQUE_VIOLATION}; every other failure belongs
 * to the caller's `catch` and is rethrown unchanged.
 */
function collides(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code: unknown = error.code;

  return code === UNIQUE_VIOLATION;
}

/**
 * The identifier of the cart a session is shopping with.
 *
 * The four writes below each need the cart's own key before they can name a row
 * of it, and none of them needs its lines: the line each one changes is named by
 * the request, and the view the caller is answered with is read back at the end.
 * One lookup written once is therefore what all four share, and the columns it
 * selects are the one column they use.
 *
 * @param token The cart's session token, as {@link readActiveCart} takes it.
 * @returns The `carts.id` of the session's open cart.
 * @throws StorefrontNotFoundError with {@link NO_OPEN_CART}, the same failure
 * {@link readActiveCart} raises for the same reason.
 */
async function activeCartId(token: string): Promise<string> {
  const cart = await prisma.cart.findFirst({
    where: { sessionToken: token, status: CartStatus.ACTIVE },
    select: { id: true },
  });

  if (cart === null) {
    throw new StorefrontNotFoundError(NO_OPEN_CART);
  }

  return cart.id;
}

/**
 * Records that the cart's contents changed.
 *
 * A line is a row of its own, so a cart whose lines were written, replaced or
 * deleted has been touched while nothing about its own columns changed to say
 * so. This is metadata rather than part of any decision - the statement that
 * changed the contents has already committed by the time this runs - and it is
 * called only on the paths where something actually changed, so a cart's
 * timestamp never moves for a request that left it as it was.
 *
 * @param id The cart's identifier, as {@link activeCartId} resolved it.
 */
async function touch(id: string): Promise<void> {
  await prisma.cart.update({
    where: { id },
    data: { updatedAt: new Date() },
    select: { id: true },
  });
}

/**
 * Adds units to the line a cart holds for a product, but only while that line
 * has room for them.
 *
 * The ceiling and the increment are one statement: the predicate admits only a
 * line already at or below the headroom these units need, and the same statement
 * raises the quantity of every row it admitted. The count it reports is
 * therefore the decision - one row means the units were added within the
 * ceiling, none means there was nothing with room for them - and no reading of
 * the line happens in between for a concurrent writer to invalidate.
 *
 * That is what makes the bound hold under load. PostgreSQL runs this statement
 * at READ COMMITTED: if a concurrent transaction is updating the same row, the
 * statement waits on that row's lock and then re-evaluates its `WHERE` clause
 * against the newly committed version. The second of two racing callers
 * therefore measures the headroom that its rival's increment left behind, not
 * the headroom both of them started from, so it matches nothing and is reported
 * as a conflict instead of carrying the line past {@link LINE_UNITS_CEILING}.
 *
 * @param cartId The cart's identifier, as {@link activeCartId} resolved it.
 * @param draft The product whose line is being raised and the units to add,
 * already known to be a whole number of at least one unit and no more than
 * {@link LINE_UNITS_CEILING}.
 * @returns `true` when the units were added to an existing line, `false` when no
 * line of this cart holds that product or the line that does has no headroom for
 * these units. The two are told apart by the caller, which knows what it has
 * already tried.
 */
async function addUnits(cartId: string, draft: CartItemDraft): Promise<boolean> {
  const { count } = await prisma.cartItem.updateMany({
    where: {
      cartId,
      productId: draft.productId,
      quantity: { lte: LINE_UNITS_CEILING - draft.quantity },
    },
    data: { quantity: { increment: draft.quantity } },
  });

  return count > 0;
}

/**
 * The cart a session is shopping with, with its lines and its money.
 *
 * One statement answers the question: the lines and the product details each
 * line displays are selected with the cart rather than fetched per line, so a
 * cart costs one round trip whatever it holds.
 *
 * @param token The cart's session token, as the storefront's cookie carries it
 * and the request schema resolved it.
 * @returns The cart's view: its lines in a stable order, the units across them
 * and their subtotal in cents.
 * @throws StorefrontNotFoundError when the token belongs to no cart, or to a
 * cart that is no longer open - a converted or abandoned cart is a record of
 * what happened rather than a cart to shop with. The failure is an error rather
 * than an empty cart so that a browser is never shown somebody else's blank
 * slate as though it were their own.
 */
export async function readActiveCart(token: string): Promise<CartView> {
  const row = await prisma.cart.findFirst({
    where: { sessionToken: token, status: CartStatus.ACTIVE },
    select: {
      id: true,
      status: true,
      updatedAt: true,
      items: {
        select: {
          id: true,
          productId: true,
          quantity: true,
          unitPriceCents: true,
          product: { select: { sku: true, slug: true, name: true, imageUrl: true } },
        },
        orderBy: { id: 'asc' },
      },
    },
  });

  if (row === null) {
    throw new StorefrontNotFoundError(NO_OPEN_CART);
  }

  return buildCartView(row);
}

/**
 * Puts a quantity of one product into the cart, and answers the cart that
 * results.
 *
 * A cart holds one line per product, so a product already in the cart gains
 * units rather than a second line. The stored quantity is incremented rather
 * than replaced with a total computed here, so two tabs adding the same product
 * at once both count instead of one silently overwriting the other. The price
 * the line was captured at is the product's price when the line was opened, and
 * it is left alone when units are added: a customer who put a product in their
 * cart yesterday is charged what they were quoted, and `./pricing.service`
 * resolves the volume discount against the quantity at checkout.
 *
 * Two writes make up the operation, and which one decides depends on whether the
 * cart already holds the product:
 *
 * 1. {@link addUnits} raises an existing line, with the ceiling as the
 *    predicate of the very statement that raises it. A row it matched is the
 *    whole decision, taken by the database rather than by a check this module
 *    made before the write.
 * 2. Matching no row means the cart holds no line for the product, or holds one
 *    with no headroom. The line is opened with a single nested statement that
 *    writes the row and the cart's own timestamp together, so a brand-new line
 *    cannot land in a cart that does not admit to having been touched for it. If
 *    a concurrent caller opened that line first, the `(cart_id, product_id)`
 *    constraint rejects the write and step 1 is attempted once more - against
 *    the line that now exists.
 *
 * Only the increment path dates the cart separately, because a conditional
 * `updateMany` touches the line rather than the cart. That second statement is
 * metadata about a decision already committed, not part of it: there is no
 * transaction around the pair, and none is wanted - a request whose units landed
 * and whose timestamp did not is a cart holding the right contents with a stale
 * date on it, while a transaction spanning both would hold a row lock across
 * two round trips for the sake of that date.
 *
 * @param token The cart's session token, as {@link readActiveCart} takes it.
 * @param draft The product to add and the whole number of units of it.
 * @returns The cart's view after the line was written, with its money
 * recomputed.
 * @throws StorefrontValidationError when the quantity is not a whole number of
 * at least one unit. A parsed request body cannot carry one, but a server
 * component calls this function directly and with values of its own.
 * @throws StorefrontNotFoundError when the token belongs to no open cart, or
 * when no product owns the identifier the draft named.
 * @throws StorefrontConflictError when the units asked for would take the line
 * past {@link LINE_UNITS_CEILING}, and when the request asks for more units than
 * a line may hold at all. It is a conflict rather than a rejected request: the
 * very same request was acceptable against the line as it stood earlier, and the
 * customer can still place a second order for the rest.
 */
export async function addCartLine(token: string, draft: CartItemDraft): Promise<CartView> {
  if (!Number.isInteger(draft.quantity) || draft.quantity < 1) {
    throw new StorefrontValidationError('A quantity of at least one whole unit is required.');
  }

  // Load-bearing rather than defensive: the line is opened below with the units
  // this request names and no predicate to bound them, so a request for a
  // hundred and fifty units of a product the cart does not hold yet would open a
  // line above the ceiling. The route handler's schema bounds only the requests
  // that arrive over HTTP, and this function is called directly as well.
  if (draft.quantity > LINE_UNITS_CEILING) {
    throw new StorefrontConflictError(
      `A cart line holds at most ${String(LINE_UNITS_CEILING)} units of one product, and this asks for ${String(draft.quantity)}.`,
      { details: { requested: draft.quantity, ceiling: LINE_UNITS_CEILING } },
    );
  }

  const cartId = await activeCartId(token);

  const product = await prisma.product.findUnique({
    where: { id: draft.productId },
    select: { unitPriceCents: true },
  });

  if (product === null) {
    throw new StorefrontNotFoundError('That product is not in the catalog.');
  }

  if (await addUnits(cartId, draft)) {
    await touch(cartId);

    return readActiveCart(token);
  }

  // Nothing was raised, so the line is opened instead. Only the unique
  // constraint on `(cart_id, product_id)` is recovered from here: it means a
  // concurrent caller opened the line between the statement above and this one,
  // which is a race to retry rather than a failure to report. Every other
  // failure - a cart that has since converted, a connection that dropped - is
  // the caller's to see, unchanged.
  let opened = false;

  try {
    await prisma.cart.update({
      where: { id: cartId },
      data: {
        // Written explicitly because the line is a row of its own: a cart whose
        // contents changed has been touched, and nothing about the cart's own
        // columns changed to say so.
        updatedAt: new Date(),
        items: {
          create: {
            productId: draft.productId,
            quantity: draft.quantity,
            unitPriceCents: product.unitPriceCents,
          },
        },
      },
      select: { id: true },
    });

    opened = true;
  } catch (error) {
    if (!collides(error)) {
      throw error;
    }
  }

  if (opened) {
    return readActiveCart(token);
  }

  // The line exists after all. One more conditional increment against it is
  // enough: this attempt reads nothing, so it cannot be racing a value it has
  // already measured, and a third attempt would only be waiting for somebody
  // else to free up headroom this request is not entitled to.
  if (await addUnits(cartId, draft)) {
    await touch(cartId);

    return readActiveCart(token);
  }

  const line = await prisma.cartItem.findUnique({
    where: { cartId_productId: { cartId, productId: draft.productId } },
    select: { quantity: true },
  });

  if (line === null) {
    // Vanishingly rare and still a conflict: the line that rejected the write
    // was removed before its quantity could be read, so the cart moved under
    // this request twice over. The customer's recovery is the same one - look at
    // the cart as it now stands and ask again.
    throw new StorefrontConflictError(
      'That cart line changed while these units were being added. Review the cart and try again.',
      { details: { requested: draft.quantity, ceiling: LINE_UNITS_CEILING } },
    );
  }

  throw new StorefrontConflictError(
    `A cart line holds at most ${String(LINE_UNITS_CEILING)} units of one product, and this one already holds ${String(line.quantity)}.`,
    { details: { held: line.quantity, requested: draft.quantity, ceiling: LINE_UNITS_CEILING } },
  );
}

/**
 * Sets one line of the cart to an exact quantity, and answers the cart that
 * results.
 *
 * The quantity is what the line holds afterwards rather than a delta, so the
 * same request applied twice leaves the cart where one application left it -
 * which is what makes a stepper in the cart drawer safe to click faster than the
 * network answers. The price the line was captured at is left alone: changing how
 * many units a customer wants does not requote what they were promised each one
 * would cost, and `./pricing.service` resolves the volume discount against the
 * new quantity at checkout.
 *
 * One statement decides, and the cart is dated afterwards for the reason
 * {@link touch} gives.
 *
 * @param token The cart's session token, as {@link readActiveCart} takes it.
 * @param draft The line to change, named by the `id` a `CartView` published for
 * it, and the whole number of units it should hold afterwards.
 * @returns The cart's view after the line was written, with its money
 * recomputed.
 * @throws StorefrontValidationError when the quantity is not a whole number of
 * at least one unit. A line of nothing is not a quantity but a removal, which
 * {@link removeCartLine} performs.
 * @throws StorefrontConflictError when the quantity asked for is past
 * {@link LINE_UNITS_CEILING}, for the reason {@link addCartLine} gives.
 * @throws StorefrontNotFoundError when the token belongs to no open cart, or
 * when this cart holds no line with that identifier.
 */
export async function setCartLineQuantity(
  token: string,
  draft: CartLineQuantityDraft,
): Promise<CartView> {
  if (!Number.isInteger(draft.quantity) || draft.quantity < 1) {
    throw new StorefrontValidationError('A quantity of at least one whole unit is required.');
  }

  if (draft.quantity > LINE_UNITS_CEILING) {
    throw new StorefrontConflictError(
      `A cart line holds at most ${String(LINE_UNITS_CEILING)} units of one product, and this asks for ${String(draft.quantity)}.`,
      { details: { requested: draft.quantity, ceiling: LINE_UNITS_CEILING } },
    );
  }

  const cartId = await activeCartId(token);

  // Scoping the predicate by `cartId` as well as by the line's own identifier is
  // load-bearing rather than belt-and-braces: a line identifier is a key a
  // browser has been given, and without the second term this token could write
  // through to a line of somebody else's cart. Together the two terms mean a
  // request may only change a line of the cart its own session is shopping with,
  // and an identifier from any other cart is simply a line this cart does not
  // hold.
  const { count } = await prisma.cartItem.updateMany({
    where: { id: draft.lineId, cartId },
    data: { quantity: draft.quantity },
  });

  if (count === 0) {
    throw new StorefrontNotFoundError(NO_SUCH_LINE);
  }

  await touch(cartId);

  return readActiveCart(token);
}

/**
 * Takes one line out of the cart, and answers the cart that results.
 *
 * The line is deleted rather than set to zero units: a cart holds one line per
 * product, and a line of no units would be a row every consumer then has to know
 * to hide. Adding the product again opens a fresh line at the price it costs
 * then, which is the same thing that happens for a product the cart never held.
 *
 * A line that is already gone is reported rather than quietly accepted, because
 * the caller was looking at a cart that no longer exists: answering it with a
 * failure and the cart as it now stands is what lets the browser notice the
 * difference instead of showing a removal that removed nothing.
 *
 * @param token The cart's session token, as {@link readActiveCart} takes it.
 * @param lineId The line to take out, named by the `id` a `CartView` published
 * for it.
 * @returns The cart's view after the line was deleted, with its money
 * recomputed.
 * @throws StorefrontNotFoundError when the token belongs to no open cart, or
 * when this cart holds no line with that identifier.
 */
export async function removeCartLine(token: string, lineId: string): Promise<CartView> {
  const cartId = await activeCartId(token);

  // Scoped by `cartId` for the reason {@link setCartLineQuantity} states: the
  // second term is what keeps a line identifier from another session's cart out
  // of reach of this token.
  const { count } = await prisma.cartItem.deleteMany({
    where: { id: lineId, cartId },
  });

  if (count === 0) {
    throw new StorefrontNotFoundError(NO_SUCH_LINE);
  }

  await touch(cartId);

  return readActiveCart(token);
}

/**
 * Takes every line out of the cart, and answers the cart that results.
 *
 * The call is idempotent: emptying a cart that is already empty is a success,
 * because the caller asked for a cart with nothing in it and that is exactly the
 * cart it is answered with. There is nothing for a second attempt to conflict
 * with either, which is what makes this the safe operation to retry after a
 * reply went missing.
 *
 * The cart itself outlives its lines. It keeps its identifier, its session token
 * and its `ACTIVE` status, so the visitor carries on shopping with the same cart
 * rather than with one minted behind their back on the next request.
 *
 * @param token The cart's session token, as {@link readActiveCart} takes it.
 * @returns The cart's view with no lines, an `itemCount` of zero and a subtotal
 * of zero cents.
 * @throws StorefrontNotFoundError when the token belongs to no open cart.
 */
export async function clearCartLines(token: string): Promise<CartView> {
  const cartId = await activeCartId(token);

  const { count } = await prisma.cartItem.deleteMany({
    where: { cartId },
  });

  // Only a cart that actually lost lines is dated. A request against a cart that
  // was already empty changed nothing, and a timestamp that moved for it would
  // report activity that did not happen.
  if (count > 0) {
    await touch(cartId);
  }

  return readActiveCart(token);
}
