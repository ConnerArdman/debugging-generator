/**
 * The cart's read and write layer.
 *
 * Two things are asked of a cart, and this module answers both: read the cart a
 * visitor is shopping with, and put a quantity of one product into it. Each
 * answer is the `CartView` of `@/lib/types` rather than a row, so the cart
 * drawer, the header badge, the checkout summary and the services that price
 * and reserve a cart all read one shape and none of them holds a column name or
 * walks a relation of its own.
 *
 * **A cart is addressed by its session token.** The token is the caller's -
 * carried by the storefront's own cookie and resolved to a default by the route
 * handler's schema before it reaches this module - so neither function here
 * names a cart, and no token literal appears in this file. A token identifies
 * one cart, and a cart is only shoppable while it is `ACTIVE`: a cart that has
 * converted into an order or been abandoned is history, and looking one up is a
 * lookup that found nothing rather than a cart to add a line to.
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
 * Stock is not this module's concern. Adding a line records an intent to buy;
 * whether the units can be promised is answered by `./inventory.service` when
 * the cart is checked out, which is why nothing here decrements a stock
 * position or writes a movement.
 *
 * Importing this module opens no connection and reads no configuration - the
 * client in `@/server/db/prisma` connects on its first query - so a page that
 * imports it still builds and type-checks against a machine with no database.
 */

import type { CartItemDraft, CartLine, CartStatus, CartView } from '@/lib/types';
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
    where: { sessionToken: token, status: 'ACTIVE' },
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
    throw new StorefrontNotFoundError('No open cart was found for this session.');
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
 * The line and the cart's own timestamp are written together in one statement,
 * so a cart cannot end up holding a line it does not admit to having been
 * touched for.
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
 * past {@link LINE_UNITS_CEILING}. It is a conflict rather than a rejected
 * request: the very same request was acceptable against the line as it stood
 * earlier, and the customer can still place a second order for the rest.
 */
export async function addCartLine(token: string, draft: CartItemDraft): Promise<CartView> {
  if (!Number.isInteger(draft.quantity) || draft.quantity < 1) {
    throw new StorefrontValidationError('A quantity of at least one whole unit is required.');
  }

  const cart = await prisma.cart.findFirst({
    where: { sessionToken: token, status: 'ACTIVE' },
    select: {
      id: true,
      items: { where: { productId: draft.productId }, select: { quantity: true } },
    },
  });

  if (cart === null) {
    throw new StorefrontNotFoundError('No open cart was found for this session.');
  }

  const product = await prisma.product.findUnique({
    where: { id: draft.productId },
    select: { unitPriceCents: true },
  });

  if (product === null) {
    throw new StorefrontNotFoundError('That product is not in the catalog.');
  }

  // At most one line can match, because a cart holds one line per product; the
  // loop reads it without indexing into an array whose members the compiler
  // treats as possibly absent.
  let held = 0;

  for (const item of cart.items) {
    held += item.quantity;
  }

  if (held + draft.quantity > LINE_UNITS_CEILING) {
    throw new StorefrontConflictError(
      `A cart line holds at most ${String(LINE_UNITS_CEILING)} units of one product, and this one already holds ${String(held)}.`,
      { details: { held, ceiling: LINE_UNITS_CEILING } },
    );
  }

  await prisma.cart.update({
    where: { id: cart.id },
    data: {
      // Written explicitly because the line is a row of its own: a cart whose
      // contents changed has been touched, and nothing about the cart's own
      // columns changed to say so.
      updatedAt: new Date(),
      items: {
        upsert: {
          where: { cartId_productId: { cartId: cart.id, productId: draft.productId } },
          create: {
            productId: draft.productId,
            quantity: draft.quantity,
            unitPriceCents: product.unitPriceCents,
          },
          update: { quantity: { increment: draft.quantity } },
        },
      },
    },
    select: { id: true },
  });

  return readActiveCart(token);
}
