/**
 * `POST /api/cart/items` - changes what is in the cart this browser is shopping
 * with.
 *
 * The handler is four steps and nothing else: parse the query with the one
 * schema that describes it, parse the body with the one schema that describes
 * every change this endpoint accepts, hand that change to the cart service
 * operation which performs it, and answer with the `CartView` the service
 * returned. The shapes live in `@/server/validation/cart`, the cart's own rules
 * and its money live in `@/server/services/cart.service`, and every failure is
 * turned into a response by the single mapper in `@/server/errors` - so this
 * file holds no schema, no query, no arithmetic and no error classification of
 * its own.
 *
 * One endpoint carries all four changes, because a cart's contents are one
 * resource. `addCartItem()`, `setCartItemQuantity()`, `removeCartItem()` and
 * `clearCartContents()` in `@/lib/api-client` all post here, each tagged with
 * the `operation` it is asking for, and each is answered with the same
 * authoritative view of the whole cart. That is what makes the server the
 * authority on what a cart holds: a browser publishes the cart that came back
 * rather than the change it asked for, so the lines, quantities and totals it
 * displays are the ones `POST /api/checkout` will read for itself when it prices
 * and reserves the order.
 *
 * Nothing about the request names the cart. The client sends no parameters at
 * all, the query schema's token field carries a default, and an unknown
 * parameter is stripped rather than rejected, so which cart a change concerns is
 * carried by the storefront's own cookie and resolved by the schema before the
 * service sees it. A body that is not readable JSON never comes from
 * `@/lib/api-client`, and it is still the caller's mistake rather than this
 * endpoint's: the one thing this file names about a failure is that such a body
 * is a rejected request, which is the same answer `POST /api/checkout` gives it.
 * Every other failure is classified by the single mapper.
 *
 * The view is serialized exactly as the service built it. Money is already an
 * integer count of US cents in its `*Cents` fields and the one timestamp is
 * already an ISO-8601 UTC string, which is why the object is passed to
 * `Response.json` untouched rather than re-mapped here: a field renamed, rounded
 * or reformatted in this file would be a second, divergent description of a
 * shape `@/lib/types` already publishes.
 *
 * Changing a cart is a write, and the cart is read straight back out of it, so
 * every response says `no-store` and the segment is declared dynamic. There is
 * no caching, reuse or de-duplication anywhere in this file, and none is wanted:
 * one request from the browser is one change to the cart.
 */

import type { CartView } from '@/lib/types';
import { StorefrontValidationError, storefrontErrorResponse } from '@/server/errors';
import {
  addCartLine,
  clearCartLines,
  removeCartLine,
  setCartLineQuantity,
} from '@/server/services/cart.service';
import { cartMutationBodySchema, cartQuerySchema } from '@/server/validation/cart';

/**
 * The cart is changed, never described, so the route is handled per request and
 * never prerendered: `next build` neither reads this route nor needs a database
 * to produce the build output, and no reply is served again for a later change.
 */
export const dynamic = 'force-dynamic';

/** What a caller is told when the request body was not readable JSON. */
const UNREADABLE = 'The cart request body could not be read as JSON.';

/**
 * Applies the change this request carries and answers with the cart that
 * results.
 *
 * @param request The POST whose JSON body `cartMutationBodySchema` describes:
 * one of `add`, `set`, `remove` or `empty`, with the product, line and quantity
 * that change needs. Its URL is read for the session token, which the client
 * does not send and the schema therefore resolves to its default.
 * @returns `200` with the cart's `CartView` as the service recomputed it, or the
 * mapper's failure envelope: `400` when the body is not readable JSON or does
 * not match the schema, `404` when the session is shopping with no open cart or
 * the change named a line the cart does not hold, and `409` when the units asked
 * for would carry a line past the ceiling one line may hold.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { sessionToken } = cartQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );

    let payload: unknown;

    try {
      payload = await request.json();
    } catch (cause) {
      // An empty or malformed body is the caller's mistake, so it is reported as
      // the validation failure it is rather than as a failure of this endpoint.
      // Without this, the `SyntaxError` would reach the mapper as a value it
      // cannot tell from a defect and be answered with a generic 500.
      throw new StorefrontValidationError(UNREADABLE, { cause });
    }

    // Parsing throws, and the rejection names every field at fault: the single
    // mapper behind `storefrontErrorResponse` turns it into the same 400 every
    // other endpoint answers an unacceptable body with. The parsed value is
    // narrowed by its `operation`, so each branch below hands the service
    // exactly the payload that change is defined over.
    const mutation = cartMutationBodySchema.parse(payload);

    let view: CartView;

    switch (mutation.operation) {
      case 'add':
        view = await addCartLine(sessionToken, mutation);
        break;
      case 'set':
        view = await setCartLineQuantity(sessionToken, mutation);
        break;
      case 'remove':
        view = await removeCartLine(sessionToken, mutation.lineId);
        break;
      case 'empty':
        view = await clearCartLines(sessionToken);
        break;
      default: {
        // Unreachable, and typed to stay that way: `mutation` narrows to `never`
        // here only while every member of the union above has a branch of its
        // own, so a fifth change added to the contract fails this assignment at
        // compile time instead of reaching a customer as a request that quietly
        // changed nothing. The throw is what an impossible state deserves - the
        // mapper answers it with the generic 500 it gives any unexpected value.
        const unhandled: never = mutation;

        throw new Error(`Unsupported cart operation: ${String(unhandled)}`);
      }
    }

    return Response.json(view, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return storefrontErrorResponse(error);
  }
}
