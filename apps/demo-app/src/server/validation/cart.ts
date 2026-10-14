/**
 * Request validation for the cart's two surfaces — `GET /api/cart`, which answers the cart this
 * browser is shopping with, and `POST /api/cart/items`, which changes what is in it. This module is
 * the only place either request is parsed. It holds one schema for the query both surfaces read the
 * cart's session token from, one schema for each of the four changes the write surface accepts, and
 * the single discriminated union that endpoint parses its body with.
 *
 * Five conventions shape the schemas below, and they are why none of them is simply a pair of
 * strings:
 *
 * 1. **A caller never names the cart.** `loadCartContents()` in `@/lib/api-client` sends
 *    `GET /api/cart` with no parameters at all, and `addCartItem()`, `setCartItemQuantity()`,
 *    `removeCartItem()` and `clearCartContents()` send their change as a body and no parameters
 *    either: which cart a request concerns is carried by the storefront's own cookie. The token
 *    field therefore holds a default, and parsing an empty object succeeds — a request that says
 *    nothing about which cart it means is a complete request for the cart a visitor who has not
 *    shopped yet shops with.
 * 2. **The field name is the database's.** A cart is found by `carts.session_token`, which the
 *    Prisma model calls `sessionToken`, and that is the name this schema publishes. The cookie, the
 *    route handler, the cart service and the row therefore use one word for one value instead of
 *    each translating between two.
 * 3. **The request body is a `CartMutation` and nothing else.** {@link Fields} and
 *    {@link MutationFields} check that at compile time, member by member: a field the type does not
 *    declare, a field it declares and the schema omits, and a field whose parsed type differs from
 *    the declared one are each a compile error here rather than a body the browser builds and the
 *    server rejects. {@link cartMutationBodySchema} restates the same guarantee over the union as a
 *    whole, so the endpoint's four branches and the four members `@/lib/types` publishes cannot
 *    drift apart.
 * 4. **A token arrives as text, or not at all — a body arrives as JSON.** A cookie that was never
 *    set, a query parameter read with an accessor that reports an absent value as `null`, and a
 *    value holding nothing but whitespace all mean the same thing, and are normalised onto the
 *    default rather than turned into a failed request. A JSON body carries real types, so no body
 *    schema here coerces anything: `"2"` is not a quantity, and a caller that sends one is asking
 *    the server to guess.
 * 5. **The caller's values stay with the caller.** A rejection is handed on as the `ZodError` it
 *    is, and the single mapper in `@/server/errors` turns it into a body of field paths and
 *    messages. The messages below say what was expected and never repeat what was received,
 *    because a session token identifies somebody's cart even when it is malformed.
 *
 * Nothing here reads the environment, opens a connection, imports a service or builds a response:
 * declaring these schemas is all that happens at import time, so a route handler, `next build` on a
 * machine with no database and `tsc -b` on a fresh clone all load the module equally happily. There
 * is deliberately no import edge between this folder and the service layer in either direction; the
 * route handler is where the two meet.
 *
 * Unknown properties are stripped rather than rejected — by the query schema and by every member of
 * the body union alike — so a cart URL that also carries a campaign parameter, and a body sent by a
 * page newer than the server it reached, both still resolve. The one value that is never guessed at
 * is the change being asked for: a body whose `operation` is missing or is a word this module does
 * not know is refused rather than read as some other change.
 */

import { z } from 'zod';

import type { CartItemDraft, CartMutation } from '@/lib/types';

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
 * The highest code point this module treats as a control character, and the delete character that
 * sits above the printable range.
 *
 * They bound the two spans no identifier a storefront issues ever contains: the C0 controls
 * `U+0000`–`U+001F` and `U+007F`. The figures are named rather than written into the check below so
 * that the range being refused is readable at a glance.
 */
const CONTROL = 0x1f;
const DELETE = 0x7f;

/**
 * Whether `value` is free of control characters, which is what a length bound alone cannot say.
 *
 * Trimming removes the whitespace controls a copied link pads a value with, but it leaves every
 * other one in place - `U+0000` above all, which a cart session token can carry through a query
 * string. A token holding one is neither a cart this store issued nor a value PostgreSQL can
 * compare against `carts.session_token`: its `UTF8` encoding has no representation for a NUL byte,
 * so the driver refuses the parameter and a lookup that would have found nothing fails instead.
 * Refusing the value here turns that into the 400 it always was - a caller sent a character this
 * store does not issue - rather than a 500 from a database the request should never have reached.
 *
 * The scan is over code points rather than a regular expression because the characters being
 * refused cannot be written into a pattern without reintroducing them as literals; iterating the
 * string reads the same and costs nothing on values bounded to sixty-four characters. A character
 * with no code point cannot come out of a string iteration, and treating one as unprintable keeps
 * the check total without an assertion standing in for the impossible case.
 *
 * @param value A value the field's length and shape rules have already accepted.
 * @returns `true` when every character is printable, and `false` as soon as one is not.
 */
function printable(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);

    if (code === undefined || code <= CONTROL || code === DELETE) {
      return false;
    }
  }

  return true;
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
      // The character check sits after the length bounds and before the default, so a caller who
      // said nothing still gets DEMO_CART_TOKEN and a padded value is still trimmed before it is
      // judged. A rejection here carries this field's own path, so the response names
      // `sessionToken` exactly as an over-long token's does.
      .refine(printable, 'A cart session token contains no control characters.')
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
    .max(64, 'That product identifier is longer than this store issues.')
    // A body reaches a product lookup the same way a query parameter does, so the identifier is
    // held to the same character rule: a key this store minted carries no control character, and
    // one that does is refused here rather than by the driver that cannot encode it.
    .refine(printable, 'A product identifier contains no control characters.'),
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

/**
 * The fields one member of `CartMutation` has to declare, read off that member.
 *
 * It is {@link Fields} generalised over the tag: `MutationFields<'set'>` is the field roster of the
 * `set` member, `MutationFields<'empty'>` the roster of a change that carries nothing but its tag.
 * The three requirements are the same ones — every field of the member is present, a field the
 * member does not declare cannot be added, and each field parses to the declared member type — and
 * they hold for the `operation` tag too, so a member whose literal does not match the type it claims
 * to describe is a compile error here.
 *
 * `Required<…>` reads each member's declared types without their optionality, for the reason
 * {@link Fields} gives: under this workspace's `exactOptionalPropertyTypes` an optional member would
 * otherwise be satisfied by a field that parses to nothing, and a consumer would have to check a
 * hole the schema could have filled with a default.
 *
 * @typeParam K The `operation` tag of the member being described.
 */
type MutationFields<K extends CartMutation['operation']> = {
  [F in keyof Required<Extract<CartMutation, { operation: K }>>]: z.ZodType<
    Required<Extract<CartMutation, { operation: K }>>[F]
  >;
};

/**
 * The cart line a `set` or `remove` change names.
 *
 * A line is named by the `id` the server published for it in a `CartView`, never by a product: a
 * cart holds one line per product, and a line is the thing a shopper changes the quantity of or
 * takes out. The bounds match the product identifier's above for the same reason — a line
 * identifier is an opaque twenty-five-character key, so sixty-four characters accepts anything this
 * store issues and refuses a value large enough to be a document — and the lower bound restates
 * that a line identifier is a non-empty string where a reader of the field expects to find it.
 *
 * One declaration serves both members, so the two changes that name a line cannot come to bound or
 * describe it differently.
 */
const cartLineIdField = z
  .string()
  .trim()
  .min(1, 'A cart line is required.')
  .max(64, 'That cart line identifier is longer than this store issues.')
  // The character rule is stated here too, and once, so both changes that name a line refuse an
  // identifier no cart line can be found by before it becomes a parameter the database rejects.
  .refine(printable, 'A cart line identifier contains no control characters.');

/**
 * Adding units of one product: {@link cartItemBodySchema} under the `add` tag.
 *
 * The payload is the existing add-to-cart body rather than a second description of it, so the fields
 * the storefront has always sent are parsed by the same schema and the same messages whichever way
 * the request is tagged.
 */
const cartAdditionSchema = cartItemBodySchema.extend({
  operation: z.literal('add'),
}) satisfies z.ZodType<Extract<CartMutation, { operation: 'add' }>>;

/**
 * Setting one line to an exact quantity.
 *
 * `quantity` is the number of units the line holds afterwards rather than a delta, so the same
 * request applied twice leaves the cart where one application left it. Its rule is
 * {@link cartItemBodySchema}'s own `quantity` field, reused rather than restated: ninety-nine units
 * is the ceiling on a cart line, and one declaration of that bound is what keeps the two ways of
 * reaching it — adding units and setting them — from drifting to different limits or different
 * wording. A quantity of zero is refused here by that lower bound, because a line of nothing is a
 * line that is gone and {@link cartRemovalSchema} is how it goes.
 */
const cartLineQuantitySchema = z.object({
  operation: z.literal('set'),
  lineId: cartLineIdField,
  quantity: cartItemBodySchema.shape.quantity,
} satisfies MutationFields<'set'>) satisfies z.ZodType<Extract<CartMutation, { operation: 'set' }>>;

/** Taking one line, named by its identifier, out of the cart. */
const cartRemovalSchema = z.object({
  operation: z.literal('remove'),
  lineId: cartLineIdField,
} satisfies MutationFields<'remove'>) satisfies z.ZodType<
  Extract<CartMutation, { operation: 'remove' }>
>;

/**
 * Taking every line out of the cart.
 *
 * The tag is the whole body: emptying a cart names nothing, and a caller that sends a product or a
 * line alongside it has that field stripped rather than its request refused.
 */
const cartEmptySchema = z.object({
  operation: z.literal('empty'),
} satisfies MutationFields<'empty'>) satisfies z.ZodType<
  Extract<CartMutation, { operation: 'empty' }>
>;

/**
 * The body `POST /api/cart/items` accepts: one change to the cart, tagged by the change being asked
 * for.
 *
 * The four members are the cart's whole write surface, and they are the four `CartMutation`
 * publishes — add units of a product, set a line to a quantity, take one line out, take every line
 * out. `operation` discriminates them, so a body is matched against exactly one member and its
 * messages name that member's fields: a `set` missing its quantity is reported as a missing
 * quantity rather than as four simultaneous failures, and an unknown tag is refused outright
 * instead of being read as some other change.
 *
 * `satisfies z.ZodType<CartMutation>` is a compile-time check and nothing more — it narrows no type,
 * emits no code and is not an assertion — so {@link CartMutationBodyInput} below is still inferred
 * from the union itself. What it proves is that this endpoint parses to the wire type
 * `@/lib/api-client` writes: a member that parses to a shape the published union does not describe
 * fails here, and a member the union publishes and this schema omits fails in the route handler,
 * whose switch over the parsed `operation` has a branch for each of them.
 */
export const cartMutationBodySchema = z.discriminatedUnion('operation', [
  cartAdditionSchema,
  cartLineQuantitySchema,
  cartRemovalSchema,
  cartEmptySchema,
]) satisfies z.ZodType<CartMutation>;

/**
 * A parsed cart change: one of the four members, narrowed by its `operation`.
 *
 * It is structurally the `CartMutation` the browser sent, so a route handler switches on the tag and
 * hands each branch's payload to the cart service without restating either shape and without an
 * assertion standing in for the check.
 */
export type CartMutationBodyInput = z.infer<typeof cartMutationBodySchema>;
