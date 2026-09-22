/**
 * Request validation for the order history listing, `GET /api/orders`.
 *
 * This module is the one place that request is parsed, and it declares a schema
 * and nothing else: no I/O, no database access, no environment lookup and no
 * response building. That is what lets the route handler parse a request before
 * it has decided anything, and lets the order service be written against a
 * parsed shape without knowing how the request arrived. There is deliberately
 * no import edge between this folder and the service layer in either direction;
 * the route handler is where the two meet.
 *
 * Five conventions come from elsewhere and are mirrored here rather than
 * restated:
 *
 * 1. **The paging names are the response's.** `PagedList<T>` in `@/lib/types`
 *    answers with `page` and `pageSize`, and its `page` is 1-based, so those
 *    are the parameter names and that is where counting starts. A caller can
 *    hand the page it was given straight back.
 * 2. **The status vocabulary is the database's.** `OrderStatus` in
 *    `@/lib/types` mirrors the `order_status` enum, and the tuple below is
 *    annotated with that union, so a literal the database does not declare
 *    fails to compile here instead of failing later against a query.
 * 3. **Every value arrives as a string**, because a query string carries
 *    nothing else. The numeric parameters therefore coerce. No parameter is a
 *    boolean, which is the one coercion worth avoiding: a coerced boolean reads
 *    the string `'false'` as `true`.
 * 4. **The caller's values stay with the caller.** A rejection is handed on as
 *    the `ZodError` it is, for the single error mapper in `@/server/errors` to
 *    turn into a response body of field paths and messages. The messages below
 *    say what was expected and never repeat what was received, because a
 *    customer identifier is somebody's data even when it is malformed.
 * 5. **The consumer classification is the endpoint's.** The only caller of this
 *    schema is the route handler for `GET /api/orders`: the query it parses
 *    arrives over HTTP, no browser code in this application builds that query -
 *    the order history is server-rendered and its page calls the order service
 *    directly - and `@/lib/types` therefore mirrors this shape with no
 *    client-side DTO.
 *
 * Unknown parameters are stripped rather than rejected, so a link that arrived
 * carrying a tracking parameter still resolves to a page of orders.
 */

import { z } from 'zod';

import type { OrderStatus } from '@/lib/types';

/**
 * The statuses an order may be filtered by, in lifecycle order.
 *
 * The annotation is what keeps this list honest: `readonly [OrderStatus,
 * ...OrderStatus[]]` accepts only members of the imported union and demands at
 * least one of them, so neither a typo nor a status the database does not
 * declare can reach `z.enum` below, and a status added to the union is a
 * compile error here until it is listed. The list is a mirror of the union, not
 * a second declaration of it.
 */
const statuses: readonly [OrderStatus, ...OrderStatus[]] = [
  'PENDING',
  'PAID',
  'FULFILLED',
  'CANCELLED',
];

/**
 * The highest code point counted as a control character, and the delete character that sits above
 * the printable range.
 *
 * The two figures name the spans an identifier this store issues never contains - the C0 controls
 * `U+0000`–`U+001F`, and `U+007F` - and they are named rather than written into the check below so
 * that the range being refused can be read where it is applied.
 */
const CONTROL = 0x1f;
const DELETE = 0x7f;

/**
 * Whether `value` is free of control characters - the one constraint a length bound cannot express.
 *
 * Trimming removes the whitespace a copied link pads a parameter with and leaves every other
 * control character in place, `U+0000` included, which a query string carries happily and a `UTF8`
 * parameter cannot represent at all. A customer identifier holding one matches no customer this
 * store has, so the listing it asks for is empty by construction; refusing it here reports the
 * caller's mistake as a 400 instead of letting the driver refuse the parameter and the endpoint
 * answer as though the storefront had failed.
 *
 * The check walks code points rather than matching a pattern, because a pattern for these
 * characters would have to contain them, and the walk is free over a parameter bounded to
 * sixty-four characters. A character with no code point cannot come out of a string iteration, and
 * counting one as unprintable keeps the check total without an assertion standing in for the
 * impossible case.
 *
 * @param value A parameter the length rules have already accepted.
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
 * The query parameters the order history listing accepts.
 *
 * The bounds are deliberate rather than defensive. A customer identifier is an
 * opaque 25-character key, so sixty-four characters is generous for anything
 * this store issues and still small enough that no oversized value reaches a
 * query. `pageSize` is capped because a hand-written request must not be able
 * to ask for the whole table in one response, and `page` is capped well beyond
 * any order history a single customer accumulates, so a caller walking pages
 * cannot run the listing off the end of its index either. Both carry the
 * defaults the first page of the view uses, which is why a request that names
 * only a customer is complete.
 */
export const ordersQuerySchema = z.object({
  /**
   * Whose orders these are. Required, and listed first because it is the only
   * parameter with no sensible default: every order belongs to exactly one
   * customer, and a listing with no customer would be every customer's orders.
   * Surrounding whitespace is trimmed before the length is measured, so a value
   * that a copied link padded is accepted while a blank one is not, and the
   * character rule is checked after both, so a rejection carries this field's
   * own path and the response names `customerId` as an over-long identifier's
   * does.
   */
  customerId: z
    .string()
    .trim()
    .min(1, 'A customer identifier is required.')
    .max(64, 'The customer identifier is longer than this store issues.')
    .refine(printable, 'A customer identifier contains no control characters.'),

  /**
   * Narrows the listing to one point in an order's lifecycle. Optional, and
   * absent rather than null when the caller filters nothing, matching how
   * `CatalogQuery` in `@/lib/types` leaves an unconstrained parameter out
   * altogether.
   */
  status: z.enum(statuses).optional(),

  /** Which page to return, counting from 1 as `PagedList` does. */
  page: z.coerce.number().int().min(1).max(10_000).default(1),

  /** How many orders that page holds. */
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * The parsed query: a customer, an optional status filter and a resolved page
 * window.
 *
 * It is the output type of the schema, not its input, so the paging fields are
 * present numbers rather than optional strings and a consumer neither re-reads
 * a default nor re-parses a digit. Inferring it keeps the shape and the rules
 * in one declaration: a bound or a field changed above changes this type with
 * it.
 */
export type OrdersQueryInput = z.infer<typeof ordersQuerySchema>;
