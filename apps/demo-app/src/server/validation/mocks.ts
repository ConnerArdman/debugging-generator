/**
 * Request validation for the storefront's two stand-in providers —
 * `POST /api/mock/carrier` and `POST /api/mock/payment`.
 *
 * A real supply storefront rates a shipment with a parcel carrier and authorizes a payment with a
 * processor. Lumen Supply ships with neither account, so it answers both itself: these two
 * endpoints are the storefront's own imitation of those providers, which is what lets the whole
 * application run on a laptop with nothing but a database behind it. Both are called from this
 * application's server layer rather than from the browser, and this module is the only place
 * either body is parsed.
 *
 * Being the only reader of a body nobody else describes shapes every decision below:
 *
 * 1. **The field names are the contract.** No browser client calls these endpoints and no
 *    data-transfer type in `@/lib/types` describes their requests, so the names here are what a
 *    caller reads to know what to send. They are borrowed rather than invented wherever a name
 *    already exists — `destinationPostalCode` from `ShippingQuoteResult`, `serviceLevel` and
 *    `amountCents` from the persisted `ShippingQuote`, `reference` from `PaymentAuthorization` —
 *    so a quote or an authorization can be assembled from a parsed body without renaming a thing.
 * 2. **Money is an integer number of US cents**, in a field whose name ends in `Cents`, exactly as
 *    every monetary value in `@/lib/types` is. A fractional amount is rejected rather than
 *    rounded: a value that cannot be counted in cents was computed wrongly upstream, and hiding
 *    that by rounding it here would put the difference in an order total.
 * 3. **A body arrives as JSON, so nothing is coerced.** The caller is server code that can send a
 *    number as a number, unlike a query string, which carries only text. Coercion here would
 *    accept `"12"`, `""` and `null` as numbers and turn a caller's mistake into a plausible
 *    figure.
 * 4. **The required keys are the genuine minimum.** Everything a caller may reasonably leave to
 *    the provider carries an explicit default, so the shortest possible body is a complete
 *    request; unknown keys are stripped rather than rejected, which is Zod's default for an
 *    object, so a caller that sends more than is read here is not an error either.
 * 5. **Reporting a rejection is somebody else's job.** The module declares two schemas and
 *    nothing else: no I/O, no database client, no service import, no `next/server`, no
 *    environment lookup and no module-scope side effect. A route handler parses, hands the
 *    resulting `ZodError` to the single mapper in `@/server/errors`, and the response carries each
 *    issue's field path and message. That is why no message below repeats the value it rejected —
 *    a rejected value belongs to the caller — and why every one of them describes the constraint
 *    instead.
 */

import { z } from 'zod';

/**
 * The body `POST /api/mock/carrier` accepts: where a shipment is going, and enough about the
 * parcel to rate it.
 *
 * A carrier rates a shipment from its destination, its weight, how many pieces it is made of and
 * which service is being asked for, and those are the four fields below. Only the destination is
 * required, because it is the one thing no provider can assume: the other three describe a
 * single, ordinary parcel when a caller leaves them out, so a body naming nothing but a postal
 * code is already a complete request.
 */
export const carrierMockBodySchema = z.object({
  /**
   * Where the shipment is going, as the destination's postal code.
   *
   * The bounds and the pattern are what a postal code looks like across the places this catalog
   * ships to rather than one country's format: three to twelve characters, beginning and ending
   * alphanumeric, with single spaces or hyphens allowed inside. That admits a five-digit US code
   * and its nine-digit form, a Canadian code written with its space and a UK outward-inward pair,
   * and refuses the values that are not postal codes at all — a blank string, a sentence, a
   * quoted fragment. Surrounding whitespace is trimmed before the length and the pattern are
   * checked, so a value a copied address padded is accepted while a value made only of spaces is
   * not.
   *
   * The storefront's own shipping-quote parameter holds a postal code to the same shape, and
   * keeps its own copy of the definition rather than importing this one: the two surfaces are
   * parsed independently, and a cross-import between the modules of this folder would tie a
   * public endpoint's parameter to the body of a stand-in provider.
   */
  destinationPostalCode: z
    .string()
    .trim()
    .min(3, 'A destination postal code is required.')
    .max(12, 'The postal code is longer than any this catalog ships to.')
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9 -]{1,10}[A-Za-z0-9]$/,
      'must be alphanumeric, with single spaces or hyphens inside',
    ),

  /**
   * What the shipment weighs, counted in whole grams — the unit is in the name, so no caller has
   * to guess whether a figure is grams, kilograms or pounds.
   *
   * The ceiling is one parcel's worth for a supplier of this kind; a consignment heavier than
   * that is several parcels and several quotes. The default is a light, single-item parcel, which
   * is what a caller that has not weighed anything is implicitly asking about.
   */
  weightGrams: z.number().int().min(0).max(150_000).default(2_000),

  /**
   * How many pieces the shipment is made of. Carriers price a multi-piece consignment differently
   * from a single parcel, and the ceiling is far beyond any cart this store checks out, so an
   * implausible count is refused before a quote is built around it.
   */
  itemCount: z.number().int().min(1).max(500).default(1),

  /**
   * Which service is being asked for, as the carrier's own code for it — the value that ends up
   * in a quote's `serviceLevel`.
   *
   * It stays a bounded string rather than an enumeration because the set of services belongs to
   * the carrier, not to this storefront: the persisted quote records whatever code it was quoted
   * under. The pattern still holds it to the shape of a code — alphanumeric words joined by
   * single spaces, hyphens or underscores — so a sentence or a fragment of punctuation cannot
   * arrive in its place. The default is the ground service every destination is offered.
   */
  serviceLevel: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(
      /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/,
      'must be alphanumeric words joined by single spaces, hyphens or underscores',
    )
    .default('GROUND'),
});

/**
 * A parsed carrier request: a destination, and a parcel described down to its service code.
 *
 * It is the schema's output type, so the three defaulted fields hold numbers and a string rather
 * than being optional — a consumer reads them without re-applying a default of its own. Inferring
 * it keeps the shape and the rules in one declaration.
 */
export type CarrierMockBodyInput = z.infer<typeof carrierMockBodySchema>;

/**
 * The body `POST /api/mock/payment` accepts: how much to authorize, in what currency, and what
 * the attempt is for.
 *
 * The body is deliberately this short. A payment instrument — a card number, a verification code,
 * a cardholder's name, an account or a token standing in for any of them — is absent from this
 * schema, and no field below could carry one: a stand-in processor has nothing to do with an
 * instrument, so accepting one would only mean a credential posted into this application's own
 * server and written to a request log. What is left is the part an authorization actually turns
 * on, which is the amount.
 */
export const paymentMockBodySchema = z.object({
  /**
   * How much to authorize, as an integer number of US cents, matching `PaymentAuthorization`'s
   * `amountCents` and every other monetary field in the storefront.
   *
   * Zero is accepted: authorizing nothing is how an instrument is checked without being charged.
   * A negative amount is not — a refund is not an authorization — and neither is a fractional one,
   * which is a dollar figure that was never converted. The ceiling sits far above any order this
   * catalog produces and exists so that a figure computed wrongly upstream is refused here
   * instead of becoming an approval.
   */
  amountCents: z.number().int().min(0).max(100_000_000),

  /**
   * Which currency the amount is counted in, as its three-letter code.
   *
   * The store prices everything in US dollars, so that is the default and a body naming only an
   * amount is a complete request. A code that is sent in lower case is upper-cased rather than
   * rejected, because the two spellings mean the same currency, and anything that is not three
   * letters is refused: a currency this store does not price in is better discovered here than
   * inside an authorization that claims to have charged it.
   */
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'must be a three-letter currency code')
    .default('USD'),

  /**
   * What the attempt is for: the identifier of the order or cart being paid for, which a
   * processor's records are tied back to.
   *
   * The bound is generous for the 25-character keys this database issues — every model's `id` is
   * one — while still small enough that no oversized value reaches a record. It is the one field
   * here with no default, because the only default available would be an identifier this module
   * invented, and an authorization tied to a made-up reference is worse than one that is
   * honestly tied to nothing: a caller that omits it is saying the attempt stands alone.
   */
  reference: z.string().trim().min(1).max(64).optional(),
});

/**
 * A parsed payment request: an amount, a resolved currency and, where the caller named one, what
 * the attempt is for.
 *
 * `reference` is absent rather than null when it was not sent, which is the distinction this
 * workspace's `exactOptionalPropertyTypes` preserves, so a consumer that forwards the body names
 * the field and spreads it in only when it holds a value.
 */
export type PaymentMockBodyInput = z.infer<typeof paymentMockBodySchema>;
