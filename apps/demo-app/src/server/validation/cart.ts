/**
 * Request validation for the cart's two surfaces — `GET /api/cart`, which answers the cart this
 * browser is shopping with, and `POST /api/cart/items`, which puts a quantity of one product into
 * it. This module is the only place either request is parsed, and it holds exactly one schema for
 * each.
 *
 * Five conventions shape the two schemas below, and they are why neither is simply a pair of
 * strings:
 *
 * 1. **A caller never names the cart.** `loadCartContents()` in `@/lib/api-client` sends
 *    `GET /api/cart` with no parameters at all, and `addCartItem()` sends only the product and the
 *    quantity: which cart a request concerns is carried by the storefront's own cookie. The token
 *    field therefore holds a default, and parsing an empty object succeeds — a request that says
 *    nothing about which cart it means is a complete request for the cart a visitor who has not
 *    shopped yet shops with.
 * 2. **The field name is the database's.** A cart is found by `carts.session_token`, which the
 *    Prisma model calls `sessionToken`, and that is the name this schema publishes. The cookie, the
 *    route handler, the cart service and the row therefore use one word for one value instead of
 *    each translating between two.
 * 3. **The request body is `CartItemDraft` and nothing else.** {@link Fields} checks that at
 *    compile time: a field the type does not declare, a field it declares and the schema omits, and
 *    a field whose parsed type differs from the declared one are each a compile error here rather
 *    than a body the browser builds and the server rejects.
 * 4. **A token arrives as text, or not at all — a body arrives as JSON.** A cookie that was never
 *    set, a query parameter read with an accessor that reports an absent value as `null`, and a
 *    value holding nothing but whitespace all mean the same thing, and are normalised onto the
 *    default rather than turned into a failed request. A JSON body carries real types, so the body
 *    schema coerces nothing: `"2"` is not a quantity, and a caller that sends one is asking the
 *    server to guess.
 * 5. **The caller's values stay with the caller.** A rejection is handed on as the `ZodError` it
 *    is, and the single mapper in `@/server/errors` turns it into a body of field paths and
 *    messages. The messages below say what was expected and never repeat what was received,
 *    because a session token identifies somebody's cart even when it is malformed.
 *
 * Nothing here reads the environment, opens a connection, imports a service or builds a response:
 * declaring two schemas is all that happens at import time, so a route handler, `next build` on a
 * machine with no database and `tsc -b` on a fresh clone all load the module equally happily. There
 * is deliberately no import edge between this folder and the service layer in either direction; the
 * route handler is where the two meet.
 *
 * Unknown properties are stripped rather than rejected, so a cart URL that also carries a campaign
 * parameter, and a body sent by a page newer than the server it reached, both still resolve.
 */

import { z } from 'zod';

import type { CartItemDraft } from '@/lib/types';

/**
 * The cart a browser is answered with when it has not said which cart it means.
 *
 * It is the fixed session token the seed script assigns to the one cart it leaves populated and
 * `ACTIVE`, so a freshly seeded database, a storefront opened for the first time and an automated
 * run all address the same cart and the drawer opens with lines in it. It is a readable identifier
 * rather than a minted key precisely so that it can be relied on by name.
 *
 * The literal is duplicated from the seed rather than shared with it: `prisma/seed.ts` is a script
 * the Prisma CLI runs, nothing under `src/` may import from it, and a two-word constant is a
 * cheaper thing to keep in step than a dependency in that direction would be.
 */
const DEMO_CART_TOKEN = 'lumen-supply-demo-cart';

/**
 * Normalises a value that says nothing onto `undefined`, so that the field's own default takes
 * over.
 *
 * Three inputs mean "nothing was said" on this surface, and collapsing them here is what keeps the
 * distinction out of the route handler: a value that was never sent (already `undefined`), one read
 * off the query string with `URLSearchParams.get()`, which answers `null` rather than `undefined`
 * for a parameter that is absent, and one holding nothing but whitespace, which is what a cleared
 * cookie or a padded copied link leaves behind. Everything else is passed through untouched for the
 * field's own schema to judge, which is why the parameter is `unknown`: this step decides whether a
 * value is worth judging, never what it means.
 *
 * @param value Whatever the caller supplied for the field.
 * @returns `undefined` when the value says nothing, and `value` itself otherwise.
 */
function unset(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }

  return value;
}

/**
 * What `GET /api/cart` accepts: the token of the cart to answer with.
 *
 * Parsing succeeds for a request that carries nothing — which is the request the storefront
 * actually makes — and the result is always complete, holding either the token the caller sent or
 * {@link DEMO_CART_TOKEN}. Surrounding whitespace is trimmed before the length is measured, so a
 * value a copied link padded is accepted while a blank one falls back to the default.
 *
 * Sixty-four characters is comfortably more than the twenty-five-character keys this store mints
 * and small enough that no oversized value reaches a query. The lower bound restates the
 * constraint — a token is a non-empty string — where a reader of the field expects to find it,
 * beneath a normalisation step that has already turned a blank value into the default.
 */
export const cartQuerySchema = z.object({
  sessionToken: z.preprocess(
    unset,
    z
      .string()
      .trim()
      .min(1, 'A cart session token cannot be blank.')
      .max(64, 'That cart session token is longer than this store issues.')
      .default(DEMO_CART_TOKEN),
  ),
});

/**
 * A parsed cart query: one session token, ready to look a cart up with.
 *
 * It is the schema's output type rather than its input, so the token is a present string and no
 * consumer re-reads the default or re-checks the length. Inferring it keeps the shape and the rules
 * in one declaration: a bound or a field changed above changes this type with it.
 */
export type CartQueryInput = z.infer<typeof cartQuerySchema>;

/**
 * The fields {@link cartItemBodySchema} has to declare, read off `CartItemDraft`.
 *
 * Mapping over `keyof Required<CartItemDraft>` states three requirements at once: every field of
 * the type is present, a field the type does not declare cannot be added, and each field parses to
 * the member type the type declares. A renamed or invented field is therefore a compile error here
 * rather than a body nobody accepts.
 *
 * `Required<…>[K]` reads each member's declared type without its optionality, which this
 * workspace's `exactOptionalPropertyTypes` would otherwise widen. The type declares no optional
 * member today; should it gain one, this mapping asks the schema for a field that always parses to
 * a value, which means an explicit default rather than a hole a consumer has to check.
 */
type Fields = {
  [K in keyof Required<CartItemDraft>]: z.ZodType<Required<CartItemDraft>[K]>;
};

/**
 * The body `POST /api/cart/items` accepts: one product and how many units of it to add.
 *
 * Both fields are required, because both are required of `CartItemDraft` and a line is meaningless
 * without either: there is no sensible default quantity for a product a customer has not said they
 * want. Nothing is coerced either, because the body is JSON written by `addCartItem()` — a
 * quantity that arrives as a string, a fraction or a negative number is a caller's mistake worth
 * reporting rather than a value worth rescuing.
 *
 * The bounds are deliberate rather than defensive. A product identifier is an opaque
 * twenty-five-character key, so sixty-four characters accepts anything this store issues and
 * refuses a value large enough to be a document. Ninety-nine units is the most one line may carry:
 * a cart holds one line per product, and a quantity beyond a stock room's worth of a single item is
 * a typed digit too many rather than an order this storefront takes.
 *
 * `satisfies Fields` is a compile-time check and nothing more — it narrows no type, emits no code
 * and is not an assertion — so {@link CartItemBodyInput} below is still inferred from the schema
 * itself.
 */
export const cartItemBodySchema = z.object({
  productId: z
    .string()
    .trim()
    .min(1, 'A product is required.')
    .max(64, 'That product identifier is longer than this store issues.'),
  quantity: z
    .number()
    .int('A quantity must be a whole number of units.')
    .min(1, 'A quantity of at least one unit is required.')
    .max(99, 'A cart line holds at most 99 units of one product.'),
} satisfies Fields);

/**
 * A parsed cart line request: a product and a whole number of units.
 *
 * It is structurally the `CartItemDraft` the browser sent, a guarantee {@link Fields} makes at
 * compile time, so a route handler hands this value to the cart service without restating either
 * shape and without an assertion standing in for the check.
 */
export type CartItemBodyInput = z.infer<typeof cartItemBodySchema>;
