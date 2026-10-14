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
 * handler's schema before it reaches this module - so no function a shopper
 * reaches names a cart, and no token literal appears in this file. A token
 * identifies the session rather than one row: a cart that has converted into an
 * order is that session's history, and the session shops on with the next one.
 * The one function that does name a cart, {@link vacate}, is not a shopper's:
 * `./checkout.service` calls it for the cart its own attempt claimed, and it can
 * only ever take the open-cart pointer off a cart a checkout is holding.
 *
 * **A session always has a cart to shop with, and this module is what opens
 * it.** Every function below resolves the session's open cart and opens one
 * when there is none, so a visitor arriving for the first time, a visitor whose
 * last cart became an order and a visitor returning to a store that has been
 * reseeded are all answered with a cart rather than with a failure. Which cart
 * is open is a fact the database keeps: `carts.open_token` is unique and holds
 * the session's token for exactly as long as that cart is the one being shopped
 * with, so two requests racing to open the first cart of a session cannot both
 * succeed and the loser reads the winner's cart. `./order.service` releases the
 * pointer in the same transaction that turns the cart into an order, which is
 * what frees the token for the cart after it.
 *
 * The one state that is not a cart to shop with is a cart a checkout is
 * holding. It keeps the pointer for as long as the attempt runs - so that a
 * failed checkout can put the very cart the customer filled back in their
 * hands, lines and prices intact - and while it does, this module reports
 * {@link CART_HELD} rather than opening a second cart behind the checkout's
 * back. An attempt leaves no hold behind whichever way it ends: the order's
 * conversion releases the pointer, a checkout that took nothing puts the cart
 * back open, and a checkout whose payment was left unsettled keeps its cart held
 * under the attempt's name for the store to settle but sets the pointer aside
 * through {@link vacate}, so the session shops on with a fresh cart instead of
 * waiting on a settlement only the store can make. A hold whose attempt never
 * reached its end - the process running it stopped mid-checkout - is the one
 * that could otherwise last forever, and {@link recover} ends it once it has
 * outlived {@link HOLD_HORIZON}, which no running attempt can.
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
 * Importing this module opens no connection and reads no configuration other
 * than `DATABASE_URL`, which `@/server/db/pool` reads to build the pool the
 * client in `@/server/db/prisma` queries through. Neither connects until the
 * first query, and an absent `DATABASE_URL` surfaces only there, so a page that
 * imports this module still builds and type-checks against a machine with no
 * database.
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
 * Two constraints in this module's path are races rather than faults, and both
 * answer with this code. `cart_items` is unique on `(cart_id, product_id)`, so
 * it is what the database answers an attempt to open a second line for a
 * product with - the one outcome {@link addCartLine} expects to lose to a
 * concurrent caller and recovers from rather than reports. `carts.open_token`
 * is unique, so it is also what answers an attempt to open a second cart for
 * one session, which is the race {@link mintCart} loses and recovers from by
 * reading the cart the winner opened.
 *
 * It is matched as a string off the caught value, exactly as the mapper in
 * `@/server/errors` matches it: the generated Prisma client is produced by
 * `prisma generate` and is not in version control, so importing an error class
 * of its own to compare against would tie this module's type graph to a build
 * step it does not otherwise need.
 */
const UNIQUE_VIOLATION = 'P2002';

/**
 * What a caller is told when the session's cart cannot be shopped with because
 * a checkout is running against it right now.
 *
 * It is the one reason this module reports no cart: every other session -
 * including one whose cart has just become an order, and one whose last
 * checkout ended with its payment unsettled - is answered with a cart that
 * either already existed or was opened for it. The sentence therefore says what
 * is happening and what to do about it rather than reporting a cart that could
 * not be found, and a read and all four writes say it identically.
 *
 * The hold ends by itself, and within seconds: the checkout either writes the
 * order, which converts the cart and frees the session to open the next one,
 * fails having taken nothing and puts this very cart back in the session's
 * hands, or fails with its payment unsettled and sets the pointer aside so the
 * session opens a fresh cart. A hold no attempt is left to end is ended by
 * {@link recover} once it is older than {@link HOLD_HORIZON}, so this is never
 * the answer for longer than that.
 */
const CART_HELD =
  'This cart is being checked out right now. Wait for that order to finish, then open your cart again.';

/**
 * How long a checkout's hold on the session's open-cart pointer may stand
 * before it is taken to have outlived the attempt that raised it, in
 * milliseconds.
 *
 * Every attempt that ends leaves no hold behind - see the top of this file - so
 * a hold older than any attempt can run is one whose attempt never reached its
 * end, and nothing but this bound will ever end it. The bound is derived from
 * what one attempt can wait on, measured from the claim that raised the hold,
 * which is the write that dates the held cart (Prisma stamps `updatedAt` on
 * that conditional `updateMany` like on any other update). Its two network
 * calls are capped by their own services: the carrier's quote by `BUDGET` in
 * `./shipping.service` (eight seconds) and the processor's authorization by
 * `TIMEOUT` in `./payment.service` (ten seconds), eighteen seconds between
 * them. Everything else it does is queries against this database, each given at
 * most five seconds to get a connection by `@/server/db/pool`. Five minutes is
 * more than fifteen times the network ceilings and leaves well over four
 * minutes for those queries, so no attempt still running is mistaken for one
 * that stopped.
 *
 * Erring the other way would cost a cart, never a charge. A hold set aside
 * while its attempt was somehow still running leaves that cart `ABANDONED`
 * under the attempt's name, so the attempt can still convert it into its order
 * and a repeat of the name is still answered from it; the session merely shops
 * on with the next cart. Nothing here reopens the held cart, so nothing here
 * can let a second attempt authorize it.
 */
const HOLD_HORIZON = 300_000;

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

/** A cart as it stands the moment it is opened, before it has any line. */
type OpenedCart = Omit<Row, 'items'>;

/**
 * The cart a session is shopping with, with everything a view is built from, or
 * `null` when the session has no open cart.
 *
 * The session's open-cart pointer is what identifies it. `carts.open_token` is
 * unique and is held by the cart being shopped with, so this is a single-row
 * lookup rather than a search through the session's history, and the status term
 * beside it is what excludes the one cart that carries the pointer without being
 * shoppable: the cart a checkout is holding.
 *
 * It is read twice on the path through {@link readActiveCart} - once before
 * opening a cart and once after losing the race to open one - so it is written
 * once here rather than spelled out at both call sites, where the two copies
 * could drift.
 *
 * @param token The cart's session token, as {@link readActiveCart} takes it.
 * @returns The cart's row with its lines in a stable order, or `null`.
 */
async function openCart(token: string): Promise<Row | null> {
  return prisma.cart.findFirst({
    where: { openToken: token, status: CartStatus.ACTIVE },
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
}

/**
 * Opens a cart for a session that has none, and answers the cart it opened.
 *
 * The write is the decision. `carts.open_token` is unique, so the insert either
 * takes the session's open-cart pointer or is refused, and no reading of the
 * session's carts happens in between for a concurrent caller to invalidate:
 * two tabs that both find no open cart and both try to open one produce exactly
 * one cart, and the tab that lost reads the cart the other opened. The same
 * refusal is what keeps a running checkout's hold intact, because the cart it
 * is holding carries the pointer until the attempt ends.
 *
 * The account carries over from the session's own history. A visitor who has
 * bought before keeps the account their last cart was attached to, which is
 * what lets `./order.service` write their next order against it instead of
 * opening a second account for the same shopper - and what makes the order
 * history a returning visitor sees include the order they have just placed. A
 * session with no history opens an anonymous cart, and the account is attached
 * when it is checked out.
 *
 * @param token The cart's session token, as {@link readActiveCart} takes it.
 * @returns The cart this call opened - always empty, since nothing has been put
 * in it yet - or `null` when the session's pointer is already held: by a
 * concurrent caller that opened a cart first, or by a checkout still holding
 * the cart it took.
 */
async function mintCart(token: string): Promise<OpenedCart | null> {
  const previous = await prisma.cart.findFirst({
    where: { sessionToken: token, customerId: { not: null } },
    // The identifier breaks a tie the timestamp cannot: two carts touched in one
    // instant would otherwise be free to change places between reads.
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    select: { customerId: true },
  });

  try {
    return await prisma.cart.create({
      data: {
        sessionToken: token,
        openToken: token,
        customerId: previous?.customerId ?? null,
      },
      select: { id: true, status: true, updatedAt: true },
    });
  } catch (error) {
    // Only the pointer's own constraint is recovered from: it means this
    // session already has an open cart, which is the caller's answer rather
    // than a failure. Everything else - a connection that dropped, an account
    // that has since been deleted - is the caller's to see, unchanged.
    if (!collides(error)) {
      throw error;
    }

    return null;
  }
}

/**
 * Takes the session's open-cart pointer off a cart a checkout is holding, and
 * leaves the cart itself held.
 *
 * This is the one function in this module that names a cart rather than a
 * session, and the reason is its caller: not a shopper but `./checkout.service`,
 * for the cart its own attempt claimed, once that attempt has ended with an
 * amount sent to the processor and no order written. That cart has to stay held
 * - reopening it is what would let a second attempt authorize the same order -
 * but a held cart that also kept the pointer would leave its session with no
 * cart at all until the store settled the payment by hand. So only the pointer
 * moves. The cart keeps its `ABANDONED` status and the attempt's name, which is
 * what `./order.service` answers a repeat of that name from, whatever the
 * pointer says, and the session's next read opens a fresh cart for it.
 *
 * The condition is what makes naming a cart safe. Only a held cart that still
 * carries a pointer matches, so this can never take the pointer off a cart a
 * visitor is shopping with, never touches a cart that has become an order - its
 * conversion released the pointer already - and does nothing on a second call.
 * The cart's status and its attempt's name are left exactly as they were.
 *
 * @param id The cart the calling checkout claimed.
 */
export async function vacate(id: string): Promise<void> {
  await prisma.cart.updateMany({
    where: { id, status: CartStatus.ABANDONED, openToken: { not: null } },
    data: { openToken: null },
  });
}

/**
 * The session's open cart once its pointer has turned out to be held by a cart
 * that is not open, opening the session's next cart when that hold has outlived
 * any attempt that could have raised it.
 *
 * A pointer held by a cart that is not open is held by a checkout. While that
 * checkout is running the hold is exactly right, and the answer is
 * {@link CART_HELD}. Every checkout that ends leaves no hold behind, so a hold
 * older than {@link HOLD_HORIZON} is one whose attempt never got that far - the
 * process running it stopped mid-checkout - and nothing else will ever end it.
 * The holder is therefore read, and a held cart that old has its pointer set
 * aside exactly as {@link vacate} would: the cart stays `ABANDONED` under its
 * attempt's name for the store to settle, and the session's next cart is opened.
 *
 * The write that sets the pointer aside repeats the staleness as its own
 * condition rather than trusting the read before it, so a hold that became
 * fresh in between - the cart put back and claimed again by a checkout that has
 * just started - no longer matches, and a claim in flight is never robbed of
 * its pointer. The cut-off is taken from this process's clock, the same clock
 * Prisma stamped the claim's `updatedAt` with, so the comparison does not
 * depend on the database server's clock agreeing with the application's.
 *
 * Opening the next cart is then the race {@link readActiveCart} already runs: a
 * concurrent caller that recovered the same hold may open it first, and then
 * the cart that caller opened is the answer.
 *
 * Both {@link readActiveCart} and {@link activeCartId} end here, so a read and
 * all four writes recover a hold identically.
 *
 * @param token The cart's session token, as {@link readActiveCart} takes it.
 * @returns The session's open cart: the empty one opened here, or the one a
 * concurrent caller opened first.
 * @throws StorefrontNotFoundError with {@link CART_HELD} while the pointer is
 * held by a checkout that may still be running.
 */
async function recover(token: string): Promise<Row> {
  const holder = await prisma.cart.findUnique({
    where: { openToken: token },
    select: { id: true, status: true, updatedAt: true },
  });

  // A holder that is not held is not this function's business: no holder at all
  // means the attempt has just given the pointer up, and an open holder means a
  // concurrent caller has just opened the session's cart. Either way the pointer
  // is decided below exactly as it is for a session with no cart.
  if (holder?.status === CartStatus.ABANDONED) {
    const cutoff = new Date(Date.now() - HOLD_HORIZON);

    if (holder.updatedAt.getTime() >= cutoff.getTime()) {
      throw new StorefrontNotFoundError(CART_HELD);
    }

    const { count } = await prisma.cart.updateMany({
      where: {
        id: holder.id,
        status: CartStatus.ABANDONED,
        openToken: token,
        updatedAt: { lt: cutoff },
      },
      data: { openToken: null },
    });

    if (count > 0) {
      // The attempt that took this cart may have sent an amount to the processor
      // before it stopped, so the operator is told what was held, since when, and
      // that the cart is left held rather than reopened.
      console.error(
        `cart: cart ${holder.id} had been held by a checkout since ${holder.updatedAt.toISOString()} with no attempt left to end the hold - its session has been given a fresh cart and the held cart stays held under its attempt's name. An authorization may stand against it: settle it before converting the cart`,
      );
    }
  }

  const opened = await mintCart(token);

  if (opened !== null) {
    return { ...opened, items: [] };
  }

  const contended = await openCart(token);

  if (contended === null) {
    throw new StorefrontNotFoundError(CART_HELD);
  }

  return contended;
}

/**
 * The identifier of the cart a session is shopping with, opening one when the
 * session has none.
 *
 * The four writes below each need the cart's own key before they can name a row
 * of it, and none of them needs its lines: the line each one changes is named by
 * the request, and the view the caller is answered with is read back at the end.
 * One lookup written once is therefore what all four share, and the columns it
 * selects are the one column they use.
 *
 * Three steps in all but the rarest case, and the common one is the first: the
 * session's open cart is found, or a cart is opened for it, or - when the
 * open-cart pointer turns out to be held - the cart the winner of that race
 * opened is read. A pointer held by a checkout leaves nothing to read, and
 * {@link recover} decides that case: a checkout that may still be running keeps
 * it, which is the one case that fails, and a hold no attempt is left to end is
 * set aside so the session's next cart can be opened.
 *
 * @param token The cart's session token, as {@link readActiveCart} takes it.
 * @returns The `carts.id` of the session's open cart.
 * @throws StorefrontNotFoundError with {@link CART_HELD}, the same failure
 * {@link readActiveCart} raises for the same reason.
 */
async function activeCartId(token: string): Promise<string> {
  const cart = await prisma.cart.findFirst({
    where: { openToken: token, status: CartStatus.ACTIVE },
    select: { id: true },
  });

  if (cart !== null) {
    return cart.id;
  }

  const opened = await mintCart(token);

  if (opened !== null) {
    return opened.id;
  }

  const contended = await prisma.cart.findFirst({
    where: { openToken: token, status: CartStatus.ACTIVE },
    select: { id: true },
  });

  if (contended === null) {
    return (await recover(token)).id;
  }

  return contended.id;
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
 * The cart a session is shopping with, with its lines and its money, opening
 * one when the session has none.
 *
 * One statement answers the question: the lines and the product details each
 * line displays are selected with the cart rather than fetched per line, so a
 * cart costs one round trip whatever it holds. A session with no open cart
 * costs one more - the write that opens it - and the cart that comes back has
 * no lines, so nothing has to be read again to describe it.
 *
 * A first visit, a cart that has just become an order, a cart whose checkout
 * ended with its payment unsettled and a store that has been reseeded are
 * therefore all answered with an empty cart rather than with a failure. That is
 * what keeps the storefront usable after a purchase, and after a payment only
 * the store can settle: the browser is told the cart is empty, and the next
 * thing put in it opens a line of the cart opened here.
 *
 * @param token The cart's session token, as the storefront's cookie carries it
 * and the request schema resolved it.
 * @returns The cart's view: its lines in a stable order, the units across them
 * and their subtotal in cents.
 * @throws StorefrontNotFoundError with {@link CART_HELD} when a checkout that
 * may still be running is holding this session's cart. It is the one state that
 * is not a cart to shop with, and it is reported rather than worked around:
 * opening a second cart would take the pointer the checkout needs to put this
 * one back if it fails. A checkout that has ended no longer holds the pointer,
 * and a hold older than {@link HOLD_HORIZON} is ended by {@link recover}, so
 * neither is reported.
 */
export async function readActiveCart(token: string): Promise<CartView> {
  const row = await openCart(token);

  if (row !== null) {
    return buildCartView(row);
  }

  const opened = await mintCart(token);

  if (opened !== null) {
    // Nothing has been put in it yet, so the view is complete without a second
    // read: a cart opened by this call has no lines, no units and no subtotal.
    return buildCartView({ ...opened, items: [] });
  }

  // The pointer is held, so one more read decides which of the two holders has
  // it. A concurrent caller that opened the session's cart between the read and
  // the write leaves a cart to answer with - the one this request was asking
  // for. A checkout holding the cart it took leaves none, and `recover` decides
  // what that hold is: one that may still be running is reported, and one that
  // has outlived every attempt is set aside and the session's next cart opened.
  const contended = await openCart(token);

  if (contended === null) {
    return buildCartView(await recover(token));
  }

  return buildCartView(contended);
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
 * @throws StorefrontNotFoundError when a checkout is holding this session's
 * cart, and when no product owns the identifier the draft named. A session
 * with no cart at all is not a failure: one is opened for it and the product
 * goes into it.
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
 * @throws StorefrontNotFoundError when a checkout is holding this session's
 * cart, and when this cart holds no line with that identifier - which is what
 * a line identifier from a cart that has since been ordered now is.
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
 * @throws StorefrontNotFoundError when a checkout is holding this session's
 * cart, and when this cart holds no line with that identifier - which is what
 * a line identifier from a cart that has since been ordered now is.
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
 * @throws StorefrontNotFoundError when a checkout is holding this session's
 * cart. A session with no cart at all is answered with the empty cart opened
 * for it, which is the cart it asked for.
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
