/**
 * Request validation for the shipping quote — `GET /api/shipping/quote`.
 *
 * Checkout asks this endpoint which services can carry an order to a
 * destination, and this module is the single place that request is turned into
 * values the shipping service can be written against. It declares one schema
 * and the type of what that schema produces, and nothing else: no I/O, no
 * database client, no service, no `next/server`, no environment lookup and no
 * response building. Declaring a schema is all that happens at import time, so
 * a route handler, `next build` on a machine with no database and `tsc -b` on a
 * fresh clone all load it equally happily — and the route handler stays the one
 * place this folder and the service layer meet, since there is deliberately no
 * import edge between them in either direction.
 *
 * Five conventions shape the schema below, and they are the reason it is not
 * simply four strings:
 *
 * 1. **One parameter is required; every other one carries a default.** The
 *    browser asks for a quote with a destination and nothing more —
 *    `requestShippingQuote` in `@/lib/api-client` sends the two halves of one,
 *    `postalCode` and `country` — while what a service costs to a destination
 *    depends on more than the destination. That gap is closed here, by stating a
 *    default for each of the remaining parameters, rather than by asking
 *    checkout to send figures it has not got or by letting the shipping service
 *    receive `undefined` where it expects a value. Parsing `{ postalCode }`
 *    therefore succeeds and yields a complete query for a domestic shipment.
 * 1a. **A destination is a country and a postal code together, and is checked as
 *    one.** `44301` is a place in the United States and a different place in
 *    Mexico, so the two parameters cannot be judged separately: the rule that
 *    decides what a complete code looks like for a country lives in
 *    `@/lib/destination` and is read here, by the browser before it asks, and by
 *    the shipping service once more before a carrier is addressed. That is a
 *    deliberate exception to the convention below that a shape stays each
 *    surface's own, and the module states why. A country the store does not
 *    quote for, and a postal code no destination in the chosen country is
 *    written as, are both rejected here rather than rated: a rate taken on an
 *    unfinished code prices a different place from the one the buyer is at.
 * 2. **Everything arrives as text.** A query string carries characters and
 *    nothing else, so both numeric parameters coerce. A handler hands this
 *    schema the query as a record of strings —
 *    `Object.fromEntries(request.nextUrl.searchParams)` — where a parameter the
 *    caller omitted is an absent key and the default below takes over. Reading
 *    parameters one at a time with `URLSearchParams.get()` instead would hand a
 *    coerced number the `null` that method answers with for an absent
 *    parameter, and `null` coerces to `0` rather than to a default.
 * 3. **No parameter is a boolean.** That is a deliberate omission rather than
 *    an oversight: a coerced boolean reads the string `'false'` as `true`, so a
 *    flag on this surface would have to be parsed as the two words it arrives
 *    as, and there is no question here a flag answers. Every parameter below is
 *    either a short piece of text or a whole number.
 * 4. **The vocabulary and the units are the storefront's own.** No money
 *    travels in this request: a quote asks what the services cost, and each
 *    figure it answers with is an integer number of US cents in a `…Cents`
 *    field of `ShippingOption`. The one measurement the request does carry
 *    names its unit in the field itself, `weightGrams`, so neither a caller nor
 *    a reader has to tell grams from kilograms, and `serviceLevel` is the name
 *    the persisted quote records a tier under.
 * 5. **The caller's values stay with the caller.** `parse` throws, the route
 *    handler hands the `ZodError` to the single mapper in `@/server/errors`,
 *    and the response names each rejected parameter and the constraint it
 *    missed without repeating what was received: a postal code is somebody's
 *    address even when it is malformed.
 *
 * Unknown parameters are stripped rather than rejected, so a checkout URL that
 * also carries a campaign or analytics parameter still asks a perfectly good
 * question.
 */

import { z } from 'zod';

import {
  DEFAULT_FREIGHT_DESTINATION_CODE,
  freightDestination,
  isCompletePostalCode,
} from '@/lib/destination';
import { MAX_SHIPMENT_UNITS } from '@/lib/types';
import type { ShippingAddress, ShippingOption } from '@/lib/types';

/**
 * The fields {@link shippingQuoteQuerySchema} declares, each tied to the type
 * the value travels as elsewhere in the storefront.
 *
 * Stating them states three requirements at once: the schema declares exactly
 * these parameters and no others, a renamed or invented parameter is a compile
 * error here rather than a query string nobody answers, and the two textual
 * parameters parse to the very member types the storefront's own shapes
 * declare — a destination as `ShippingAddress` writes one, a tier as the
 * `service` of the `ShippingOption` it will be answered with. The check is
 * `satisfies` rather than an annotation, so it narrows nothing: the exported
 * type below is still inferred from the schema itself.
 */
type Fields = {
  postalCode: z.ZodType<ShippingAddress['postalCode']>;
  country: z.ZodType<ShippingAddress['country']>;
  weightGrams: z.ZodType<number>;
  itemCount: z.ZodType<number>;
  serviceLevel: z.ZodType<ShippingOption['service']>;
};

/**
 * The highest code point counted as a control character, and the delete
 * character that sits above the printable range.
 *
 * The two figures name the spans a service tier's name never contains - the C0
 * controls `U+0000`–`U+001F`, and `U+007F` - and they are named rather than
 * written into {@link printable} so that the range being refused can be read
 * where it is applied.
 */
const CONTROL = 0x1f;
const DELETE = 0x7f;

/**
 * Whether `value` is free of control characters, which is the one constraint a
 * length bound cannot state.
 *
 * The destination parameter is held to a pattern and therefore already admits
 * nothing but letters, digits, spaces and hyphens; the tier is bounded text by
 * design, because the tiers belong to the services this store offers rather
 * than to this endpoint, and bounded text is exactly where a control character
 * can hide. Trimming does not remove one - `U+0000` in particular travels
 * through a query string and then cannot be encoded as a `UTF8` parameter at
 * all - and a tier carrying one is a name no service publishes, so it is
 * refused here rather than being narrowed against or written into a persisted
 * quote's service level.
 *
 * The check walks code points instead of matching a pattern, because a pattern
 * for these characters would have to spell them out, and the walk is free over
 * a parameter bounded to thirty-two characters. A character with no code point
 * cannot come out of a string iteration, and counting one as unprintable keeps
 * the check total without an assertion standing in for the impossible case.
 *
 * @param value A parameter the length rules have already accepted.
 * @returns `true` when every character is printable, and `false` as soon as one
 * is not.
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
 * The query parameters `GET /api/shipping/quote` accepts.
 *
 * Every bound is stated rather than left open, because each parameter is a
 * string of unknown length written by whoever called the endpoint: an unbounded
 * postal code is a way to hand a lookup a megabyte, and an unbounded weight or
 * count is a way to ask for a quote on a shipment nobody could tender.
 *
 * The fields are checked first and the destination second: the refinement at
 * the end pairs `country` with `postalCode`, because neither of them describes
 * a place on its own. A rejection therefore names one field in either case -
 * the field whose own rule failed, or `postalCode` when the pair does not
 * describe a destination this store can rate.
 */
export const shippingQuoteQuerySchema = z
  .object({
    /**
     * Where the order is going. The only required parameter, because it is the
     * only one with no sensible default: a quote with no destination would be a
     * quote to everywhere.
     *
     * Surrounding whitespace is trimmed before the length is measured, so a value
     * a copied link or a form field padded is accepted while a blank one is not.
     * The pattern is permissive on purpose — this is a storefront, not an
     * address-verification service — and accepts the shapes checkout actually
     * produces: a five-digit code, a code with a hyphenated extension, and the
     * two- and three-group codes written with a space that customers outside the
     * United States enter. A code no destination uses is not this module's to
     * refuse: it matches no serviceable destination and is answered as one,
     * whereas punctuation, quoting and path junk are refused here, before the
     * value travels on as a lookup key.
     *
     * Three to twelve characters in alphanumeric groups joined by single spaces
     * or hyphens is the coarse shape a destination is held to here, and every
     * surface a destination arrives on states it identically: the checkout body's
     * address field is written to this very rule. Each surface keeps its own copy
     * rather than importing another's, because the modules of this folder
     * deliberately do not depend on each other, and writing the rule twice is the
     * price of that independence. Letting the two copies drift apart is not: a
     * destination one surface accepted and the other refused would be a request
     * the storefront took and then could not act on.
     *
     * Whether the code is a *complete* one for the country it is paired with is
     * the separate question the refinement under this object answers, because it
     * cannot be asked of this field alone.
     */
    postalCode: z
      .string()
      .trim()
      .min(3, 'A destination postal code of at least three characters is required.')
      .max(12, 'The postal code is longer than any destination this store ships to.')
      .regex(
        /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/,
        'must be letters and digits in groups separated by single spaces or hyphens',
      ),

    /**
     * Which country the destination is in, as the two-letter code the address DTO
     * carries.
     *
     * It is half of the destination rather than a detail of it: freight is rated
     * from where a shipment is going, and a postal code names a different place
     * in each country that writes codes that way. A quote asked for without it is
     * quoted for the store's own country, which is what a caller naming only a
     * postal code is asking about; a quote asked for *with* it is rated to that
     * country, and the two answers differ.
     *
     * Upper-cased before it is judged, so a code written in lower case by a
     * hand-made request and one chosen from the checkout control are one value,
     * and held to the destinations `@/lib/destination` publishes rather than to a
     * two-letter pattern - a pattern would accept any pair of letters and leave
     * the shipping service to rate a country this store does not serve.
     */
    country: z
      .string()
      .trim()
      .toUpperCase()
      .refine(
        (value) => freightDestination(value) !== undefined,
        'names a country this store does not quote freight to',
      )
      .default(DEFAULT_FREIGHT_DESTINATION_CODE),

    /**
     * How much the shipment weighs, in grams.
     *
     * Two kilograms is what a typical order of this store's goods travels at, and
     * it is the figure a caller that weighs nothing is quoted on. Seventy
     * kilograms is the ceiling: it is the heaviest single parcel the services
     * offered at checkout accept, so a heavier shipment is a different
     * conversation rather than a quote. An explicit `0` is accepted rather than
     * rejected — a caller may say it has not weighed the shipment, and the base
     * rates answer that — while an absent parameter takes the default instead.
     */
    weightGrams: z.coerce.number().int().min(0).max(70_000).default(2_000),

    /**
     * How many units travel in the shipment, which is what decides how many
     * packages the shipment is made up of.
     *
     * At least one, because a shipment of nothing is not a shipment, and at most
     * {@link MAX_SHIPMENT_UNITS}, which is the largest consignment the services
     * offered at checkout rate as one shipment. The ceiling is a refusal rather
     * than a cap: a larger order travels as more than one shipment and is quoted
     * once per shipment, so quoting it here as five hundred pieces would answer
     * with the cost of a shipment nobody is sending. One unit is the default, so
     * a caller naming only a destination is quoted on the smallest shipment this
     * store sends.
     *
     * The ceiling is the one rule this schema imports rather than restates. The
     * browser has to hold to the same figure *before* it asks — a checkout that
     * sent a larger cart's count would collect a 400 it could only describe as a
     * rejected postal code, and a customer would be told to correct an address
     * that was never the problem — so the figure is published once, in
     * `@/lib/types`, and read here. The postal-code pattern above is the opposite
     * case and stays this module's own: it is a shape checked where a value
     * arrives, not a number a caller has to reason about.
     */
    itemCount: z.coerce
      .number()
      .int()
      .min(1)
      .max(
        MAX_SHIPMENT_UNITS,
        `A shipment carries at most ${String(MAX_SHIPMENT_UNITS)} units; a larger order ships as more than one.`,
      )
      .default(1),

    /**
     * Which tier of service to quote around, named as the persisted quote records
     * it and as the `service` of the options it is answered with.
     *
     * It is bounded text rather than a fixed set because the tiers belong to the
     * services this store offers rather than to this endpoint: both
     * `ShippingOption.service` and the stored quote's service level are free
     * text, so enumerating them here would be a second, competing vocabulary that
     * went stale the first time an option was added. Thirty-two characters is
     * more than any tier's name needs. The store's own baseline tier is the
     * default, so a caller that names nothing is asking the question checkout
     * opens on; a tier no service offers narrows to nothing and is answered with
     * what is offered, which is a result rather than a bad request.
     *
     * The character check sits after the length bounds and before the default, so
     * a caller that names no tier is still quoted on the store's baseline one,
     * and a rejection carries this field's own path.
     */
    serviceLevel: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .refine(printable, 'A service level contains no control characters.')
      .default('standard'),
  } satisfies Fields)
  /**
   * The two halves of the destination, judged together.
   *
   * It runs after the fields, so both values are present and normalised by the
   * time it reads them - the country upper-cased, the postal code trimmed - and
   * a request that failed either field is already rejected with that field's own
   * message rather than with this one.
   *
   * The issue is raised against `postalCode` because that is the value the
   * caller can correct: the country was chosen from a closed list, and a code
   * that is unfinished or written as no code in that country is what is
   * actually wrong. `@/lib/destination` owns both the judgement and the wording,
   * so the sentence a customer reads here is the same sentence the checkout form
   * shows beside the field before it ever sends the request.
   */
  .superRefine((query, ctx) => {
    const destination = freightDestination(query.country);

    // Unreachable through `parse`: the country field refuses a code no
    // destination carries. Handled rather than asserted, because a future
    // caller may reach this refinement with a schema composed differently, and
    // an unchecked read here would be the one place that assumption was silent.
    if (destination === undefined) {
      return;
    }

    if (!isCompletePostalCode(destination, query.postalCode)) {
      ctx.addIssue({
        code: 'custom',
        path: ['postalCode'],
        message: `is not a complete ${destination.adjective} postal code; they are written like ${destination.postalCodeExample}`,
      });
    }
  });

/**
 * A parsed shipping-quote query: a destination, and a shipment described in
 * whole numbers with a tier to quote it at.
 *
 * It is the schema's output type rather than its input, so every field holds a
 * value once a request has been parsed — the four defaulted parameters are
 * present numbers and text, not optional strings — and a consumer neither
 * re-reads a default nor re-parses a digit. Inferring it keeps the shape and
 * the rules in one declaration: a bound or a field changed above changes this
 * type with it.
 */
export type ShippingQuoteQueryInput = z.infer<typeof shippingQuoteQuerySchema>;
