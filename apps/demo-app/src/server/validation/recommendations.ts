/**
 * Request validation for the suggestion feed behind a product's recommendations
 * rail — `GET /api/recommendations`.
 *
 * This module is the one place that request is parsed, and it declares a schema
 * and nothing else: no I/O, no database access, no environment lookup, no
 * `next/server` and no response building. Declaring the schema is all that
 * happens at import time, so a route handler, a server component, `next build`
 * on a machine with no database and `tsc -b` on a fresh clone all load it
 * equally happily. There is deliberately no import edge between this folder and
 * the service layer in either direction; the route handler is where the request
 * shape and the service that answers it meet.
 *
 * Four conventions come from elsewhere and are mirrored here rather than
 * restated:
 *
 * 1. **The parameter names are the browser client's.** `loadRecommendations` in
 *    `@/lib/api-client` is the only caller, and it sends `productId` and
 *    `limit`. Naming them anything else here would be a rejected request on the
 *    product page rather than a disagreement anyone could see.
 * 2. **A product identity is a `Product.id`.** The catalog's primary keys are
 *    opaque 25-character strings, and `RecommendationItem.productId` in
 *    `@/lib/types` is the same identity answered back, so the parameter is a
 *    bounded string here too. {@link Fields} below is what holds those two
 *    together.
 * 3. **Every value arrives as text**, because a query string carries nothing
 *    else. `limit` is therefore coerced rather than declared numeric, and a
 *    value that is not a whole number inside its range is rejected rather than
 *    quietly becoming `NaN`. No parameter is a boolean, which is the one
 *    coercion worth avoiding: a coerced boolean reads the string `'false'` as
 *    `true`.
 * 4. **The caller's values stay with the caller.** A rejection is handed on as
 *    the `ZodError` it is, for the single mapper in `@/server/errors` to turn
 *    into a body of field paths and messages. The messages below say what was
 *    expected and never quote what was received.
 *
 * A caller hands this schema the raw query as a record of strings —
 * `Object.fromEntries(request.nextUrl.searchParams)` — so an unstated parameter
 * is an absent key, which is what lets `limit` resolve to its default. Unknown
 * parameters are stripped rather than rejected, because a product link that
 * also carries a campaign or analytics parameter is still a perfectly good
 * request for this feed.
 */

import { z } from 'zod';

import type { RecommendationItem } from '@/lib/types';

/**
 * The fields {@link recommendationsQuerySchema} declares, each pinned to the
 * type the rest of the storefront already uses for it.
 *
 * The product identity is written as `RecommendationItem['productId']` rather
 * than as `string`, which states the invariant this endpoint rests on: the
 * identity a caller asks about is the identity the answered items carry, so the
 * query string, the handler, the service signature and the payload speak one
 * vocabulary. Should that field ever become something other than a string, the
 * schema below stops compiling instead of accepting a parameter no product can
 * be found by.
 *
 * Stating the two members explicitly also closes the shape: `satisfies Fields`
 * rejects a renamed, misspelled or invented parameter, and rejects a missing
 * one, at compile time.
 */
type Fields = {
  productId: z.ZodType<RecommendationItem['productId']>;
  limit: z.ZodType<number>;
};

/**
 * The query parameters `GET /api/recommendations` accepts.
 *
 * The bounds are deliberate rather than defensive. A product identifier is an
 * opaque key, so sixty-four characters is generous for anything this catalog
 * issues and still small enough that no oversized value reaches a query. The
 * size of the answer is capped for the same reason a paged listing is: a
 * hand-written request must not be able to turn a short strip of suggestions
 * into a full extract of the catalog.
 *
 * `satisfies Fields` is a compile-time check and nothing more — it narrows no
 * type, emits no code and is not an assertion — so
 * {@link RecommendationsQueryInput} below is still inferred from the schema
 * itself and keeps what parsing guarantees: `limit` holds a number once a
 * request has been parsed, whether or not the caller named one.
 */
export const recommendationsQuerySchema = z.object({
  /**
   * Which product the suggestions are for. Required, and the only parameter
   * with no sensible default: a suggestion is always made *alongside*
   * something, so a feed with no product named would be an arbitrary slice of
   * the catalog rather than a recommendation. Surrounding whitespace is trimmed
   * before the length is measured, so a value a copied link padded is accepted
   * while a blank one is not.
   *
   * The requirement is stated on the field as well as on its minimum length, so
   * that a parameter left out altogether and one sent blank report the same
   * sentence — wording a form can show as it stands — instead of the validator's
   * own description of a type it did not get.
   */
  productId: z
    .string({ error: 'A product identifier is required.' })
    .trim()
    .min(1, 'A product identifier is required.')
    .max(64, 'The product identifier is longer than this catalog issues.'),

  /**
   * How many suggestions one response carries — the page size of this feed.
   * Eight is what the rail is laid out for: enough tiles to fill the strip on a
   * product page and to leave something to scroll to on a narrow one.
   * Twenty-four is the ceiling, well above anything the rail presents, so the
   * figure stays a page size.
   */
  limit: z.coerce.number().int().min(1).max(24).default(8),
} satisfies Fields);

/**
 * A parsed suggestion query: one product to suggest alongside, and a resolved
 * number of suggestions to answer with.
 *
 * It is the schema's output type, not its input, so `limit` is a present number
 * rather than an optional string and no consumer re-reads a default or re-parses
 * a digit. Inferring it keeps the shape and the rules in one declaration: a
 * bound or a field changed above changes this type with it.
 */
export type RecommendationsQueryInput = z.infer<typeof recommendationsQuerySchema>;
