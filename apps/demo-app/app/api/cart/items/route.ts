/**
 * `POST /api/cart/items` - changes what is in the cart this browser is shopping
 * with.
 *
 * The handler is four steps and nothing else: resolve the cart from the query
 * with the one schema that describes it, read the body with the one schema that
 * describes the changes this endpoint accepts, hand the change to the cart
 * service, and answer with the `CartView` the service returned. The request's
 * shape lives in `@/server/validation/cart`, the cart's own rules and its money
 * live in `@/server/services/cart.service`, and every failure is turned into a
 * response by the single mapper in `@/server/errors` - so this file holds no
 * schema, no query, no arithmetic and no error classification of its own.
 *
 * One endpoint serves all four changes because a cart's contents are one
 * resource. The body is a tagged `CartMutation`, its `operation` says which
 * change is being asked for, and the switch below has one branch per member:
 * adding units of a product, setting a line to an exact quantity, taking one
 * line out and taking every line out each reach the one service function that
 * performs it. A body whose tag is missing or unknown is refused by the schema
 * rather than read as some other change, and a member the published union gains
 * without a branch here fails to compile rather than resolving to a cart nobody
 * changed.
 *
 * Which cart is changed is not the caller's to state. `changeCart()` in
 * `@/lib/api-client` sends no parameters, the query schema's token field carries
 * a default, and an unknown parameter is stripped rather than rejected, so the
 * bodies the storefront actually posts all address this session's cart.
 *
 * The cart is serialized exactly as the service built it, and the service reads
 * it back after the write, so a browser is answered with the cart as the
 * database now holds it. Money is already an integer count of cents in its
 * `*Cents` fields and the one timestamp is already an ISO-8601 UTC string, which
 * is why the object is passed to `Response.json` untouched rather than re-mapped
 * here: a field renamed, rounded or recomputed in this file would be a second,
 * divergent description of a shape `@/lib/types` already publishes, and a
 * subtotal worked out here would be a second opinion about what a shopper is
 * charged.
 *
 * A cart is written and read back within the request, and the answer describes
 * the cart of that moment, so every response says `no-store` and the segment is
 * declared dynamic. There is no caching, memoization or de-duplication anywhere
 * in this file, and none is wanted: one request from the browser is one change
 * to the cart.
 */

import type { CartMutation, CartView } from '@/lib/types';
import { StorefrontValidationError, storefrontErrorResponse } from '@/server/errors';
import {
  addCartLine,
  clearCartLines,
  removeCartLine,
  setCartLineQuantity,
} from '@/server/services/cart.service';
import { cartMutationBodySchema, cartQuerySchema } from '@/server/validation/cart';

/**
 * A cart is changed, never described, so the route is handled per request and
 * never prerendered: `next build` neither reads this route nor needs a database
 * to produce the build output, and no reply is served again for a later change.
 */
export const dynamic = 'force-dynamic';

/** What a caller is told when the request body was not readable JSON. */
const UNREADABLE = 'The cart request body could not be read as JSON.';

/**
 * Applies the change this request asked for and answers with the cart that
 * resulted.
 *
 * @param request The POST whose JSON body `cartMutationBodySchema` describes:
 * the change being asked for and the product or line it concerns. Its URL is
 * read for the cart's session token, which the query schema resolves to this
 * session's cart when the request names none.
 * @returns `200` with the cart's `CartView` as it stands after the change, or
 * the mapper's failure envelope - `400` when the body is not readable JSON or
 * does not match the schema, `404` when the token addresses no open cart, when
 * no product owns the identifier a change named, or when this cart holds no line
 * with the identifier a change named, `409` when the units asked for would take
 * a line past the most one line may hold, and a single generic `500` for
 * anything unaccounted for.
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
      throw new StorefrontValidationError(UNREADABLE, { cause });
    }

    // Parsing throws, and the rejection names every field at fault: the single
    // mapper behind `storefrontErrorResponse` turns it into the same 400 every
    // other endpoint answers an unacceptable body with.
    const mutation: CartMutation = cartMutationBodySchema.parse(payload);

    // One branch per member of the union, each handing the change to the service
    // function that performs it. The tag is narrowed by the compiler, so a branch
    // reads only the fields its own change carries, and each branch passes the
    // session token first, exactly as every function of the cart service takes
    // it.
    let cart: CartView;

    switch (mutation.operation) {
      case 'add':
        cart = await addCartLine(sessionToken, {
          productId: mutation.productId,
          quantity: mutation.quantity,
        });
        break;
      case 'set':
        cart = await setCartLineQuantity(sessionToken, {
          lineId: mutation.lineId,
          quantity: mutation.quantity,
        });
        break;
      case 'remove':
        cart = await removeCartLine(sessionToken, mutation.lineId);
        break;
      case 'empty':
        cart = await clearCartLines(sessionToken);
        break;
    }

    return Response.json(cart, {
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
