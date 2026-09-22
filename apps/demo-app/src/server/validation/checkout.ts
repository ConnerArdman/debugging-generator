/**
 * Request validation for the checkout submission — `POST /api/checkout`.
 *
 * This is the request behind the "Place order" button, and this module is the
 * only place it is parsed. It declares schemas and nothing else: no I/O, no
 * database access, no environment lookup, no `next/server` and no response
 * building, so importing it costs one object graph and can be done from a route
 * handler, from `tsc -b` on a fresh clone, or from `next build` on a machine
 * with no database. There is deliberately no import edge between this folder and
 * the service layer in either direction — the route handler is where the two
 * meet, parsing the body here and handing named fields to the checkout service.
 *
 * Five conventions come from elsewhere and are mirrored here rather than
 * restated:
 *
 * 1. **The body is the published DTO.** `submitCheckout` in `@/lib/api-client`
 *    sends a {@link CheckoutDraft} as JSON with no transformation, so the
 *    accepted input is that value and the parsed output is structurally
 *    identical to it. {@link Mirror} is how that is checked by the compiler
 *    instead of by hand.
 * 2. **The cart is not named in the body.** `CheckoutDraft` carries no cart
 *    identifier on purpose: the cart belongs to the browser's own session and
 *    the server resolves it from the storefront's cookie, which is what
 *    `credentials: 'same-origin'` carries. A cart field here would be a way for
 *    a caller to check out somebody else's cart, so there is none — not even an
 *    optional one. The one identifier the body does carry names the caller's own
 *    attempt and nothing in this store, which is why it is bounded and shaped
 *    here and given no meaning at all.
 * 3. **A JSON body carries typed values, so nothing is coerced.** Coercion
 *    belongs to the query-string surfaces, where every value arrives as text; a
 *    number or a boolean that arrives here as a string is a caller that did not
 *    send the DTO, and saying so is more useful than quietly repairing it.
 * 4. **An optional value resolves to a value.** Every field the DTO allows to be
 *    blank carries an explicit default, so the checkout service reads `null` for
 *    "the customer left this empty" and never has to tell `undefined`, `null`
 *    and `''` apart.
 * 5. **The caller's values stay with the caller.** A rejection is handed on as
 *    the `ZodError` it is, for the single mapper in `@/server/errors` to turn
 *    into a body of field paths and messages. The messages below say what was
 *    expected and never repeat what was received, which matters more on this
 *    surface than on any other: a checkout body holds somebody's name, email
 *    address and street address.
 *
 * Unknown keys are stripped rather than rejected, so a form that grew a field
 * the server does not read yet still places an order.
 */

import { z } from 'zod';

import type { CheckoutDraft, CustomerContact, ShippingAddress } from '@/lib/types';

/**
 * One schema per member of `T`, and no member `T` does not declare.
 *
 * Used with `satisfies` on the object literal handed to `z.object`, which states
 * three requirements at once and checks them at compile time: every member of
 * the type is present, a member the type does not declare cannot be added, and
 * each member parses to exactly the type the DTO declares for it. A renamed
 * field, a forgotten one and a schema that answers the wrong type are therefore
 * compile errors in this file rather than a body the browser sends and the
 * server rejects. It narrows nothing and emits no code, so each `XInput` type
 * below is still inferred from its schema.
 */
type Mirror<T> = { [K in keyof T]: z.ZodType<T[K]> };

/**
 * The last code point below the printable range: the top of the C0 control
 * block, `U+001F`.
 */
const CONTROL = 0x1f;

/** `DEL`, the one control character above the printable ASCII range. */
const DEL = 0x7f;

/**
 * The one wording every free-text field below uses when it holds a character it
 * does not carry.
 *
 * It says what the field takes and never repeats what arrived in it, which is
 * the fifth convention at the top of this file: the value at fault here is
 * somebody's name, company or street address.
 */
const TYPED =
  'Use ordinary text characters here: tab, line break and other control characters are not accepted.';

/**
 * Whether `value` is text a free-text field carries: no C0 control character
 * and no `DEL`.
 *
 * The fields it guards are bounded by length alone, and a length is not the
 * whole of what makes a value usable. A control character occupies one
 * character, so it fits inside any bound; it survives `trim()`, which removes
 * whitespace and leaves `U+0000` exactly where it was; and the columns an order
 * is written into cannot hold it at all. A body carrying one is therefore a
 * body this storefront would take and then be unable to act on - the very thing
 * the postal-code rule below exists to prevent - so it is refused here, before
 * the checkout service holds any stock, takes any freight quote or asks for any
 * amount to be approved. The rule is stated for every free-text field rather
 * than only for the fields an order retains, because which of them it retains
 * is the order service's to change and not a caller's to keep track of. The
 * fields carrying a pattern exclude these characters as a by-product of the
 * shape they demand; this states the same rule for the fields whose content is
 * the customer's own to write.
 *
 * It is the control characters that are refused and nothing else. Everything
 * else a customer may legitimately type stays acceptable - an accented letter,
 * an ideograph, an emoji - because an allowlist of the letters a store expects
 * would refuse customers rather than protect anything.
 *
 * The class is stated as a code-point test rather than as a regular expression
 * because a pattern for it has to contain the very characters it excludes,
 * which is neither readable nor something this repository's lint settings
 * accept. The loop reads UTF-16 units, which is what makes it exact: a control
 * character is always one unit, and a surrogate - half of an emoji, or a lone
 * one a caller sends - is numerically far above both bounds and therefore
 * untouched.
 *
 * Written out in this module rather than shared with the query-string surfaces
 * that hold their own values to the same class, for the reason given at
 * {@link shippingAddressSchema}: the modules of this folder deliberately do not
 * depend on each other, and each surface carries its own copy of a rule.
 *
 * @param value The trimmed, length-checked value a field parsed.
 */
function plain(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);

    if (code <= CONTROL || code === DEL) {
      return false;
    }
  }

  return true;
}

/**
 * A free-text field the customer may leave empty, bounded at `max` characters.
 *
 * The DTO's discipline for such a field is a present `null` rather than an
 * absent key — `ShippingAddress.line2` and `CheckoutDraft.notes` are both
 * declared `string | null` — so all four ways of saying "nothing" collapse onto
 * `null` here: an omitted key, an explicit `null`, an empty string and the
 * whitespace a copied value can leave behind. A consumer then reads either a
 * meaningful string or `null`, and one empty field cannot reach the checkout
 * service in four different forms.
 *
 * A value that is present is held to {@link plain} as well as to `max`, on the
 * same terms as the required fields below: the check follows the trim and the
 * bound, so surrounding whitespace is still normalised away before anything is
 * refused and a value is judged as the field will carry it.
 *
 * @param max Longest value accepted, measured after surrounding whitespace is
 *   trimmed.
 * @param message Wording shown when the value is longer than that.
 */
function blank(max: number, message: string): z.ZodType<string | null> {
  return z
    .string()
    .trim()
    .max(max, message)
    .refine(plain, TYPED)
    .nullable()
    .default(null)
    .transform((value) => (value !== null && value.length > 0 ? value : null));
}

/**
 * Where an order ships to.
 *
 * The bounds are what a shipping label holds rather than what a database column
 * allows: a line, a city or a region longer than the label can print is a
 * mistake worth catching at the form instead of at the carrier. The postal code
 * is held to the one shape this storefront rates a destination in — three to
 * twelve characters in alphanumeric groups joined by single spaces or hyphens,
 * which covers the five-digit and nine-digit domestic forms as well as the
 * alphanumeric ones a neighbouring country writes — because the destination an
 * order carries is the destination its freight is quoted for: a value this
 * schema accepted and the shipping-quote surface refused would be a body the
 * storefront took and then could not act on. The rule is written out here
 * rather than imported from the shipping-quote parameter that states it too,
 * because the modules of this folder deliberately do not depend on each other;
 * each surface carries its own copy of a rule both are held to.
 * The country is the only field with a default: every warehouse behind this
 * catalog ships domestically, so a form with no country control still submits a
 * complete address.
 *
 * The annotation is the second half of the conformance check {@link Mirror}
 * begins: `z.ZodType<ShippingAddress>` demands that what this schema parses to
 * is an address the storefront's own DTO declares, so the shape the browser
 * sends and the shape the checkout service reads cannot drift apart.
 */
export const shippingAddressSchema: z.ZodType<ShippingAddress> = z.object({
  line1: z
    .string()
    .trim()
    .min(1, 'A street address is required.')
    .max(120, 'Keep the street address to 120 characters.')
    .refine(plain, TYPED),

  /** Suite, unit or floor; `null` when the customer leaves it blank. */
  line2: blank(120, 'Keep the second address line to 120 characters.'),

  city: z
    .string()
    .trim()
    .min(1, 'A city is required.')
    .max(80, 'Keep the city to 80 characters.')
    .refine(plain, TYPED),

  /** State, province or territory, spelled as the customer writes it. */
  region: z
    .string()
    .trim()
    .min(1, 'A state or region is required.')
    .max(80, 'Keep the state or region to 80 characters.')
    .refine(plain, TYPED),

  postalCode: z
    .string()
    .trim()
    .min(3, 'A postal code is required.')
    .max(12, 'Keep the postal code to 12 characters.')
    .regex(
      /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/,
      'A postal code holds letters and digits in groups separated by single spaces or hyphens.',
    ),

  /**
   * Two-letter country code, upper-cased before it is checked so that a form
   * submitting `us` is accepted and the service reads one canonical form.
   */
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Use a two-letter country code.')
    .default('US'),
} satisfies Mirror<ShippingAddress>);

/**
 * A parsed shipping address: every line present, the optional one resolved to a
 * string or `null`, and the country a two-letter code.
 *
 * Inferred from the schema rather than declared beside it, so a bound or a field
 * changed above changes this type with it.
 */
export type ShippingAddressInput = z.infer<typeof shippingAddressSchema>;

/**
 * Who is buying, as the order confirmation addresses them.
 *
 * The email address is checked with Zod's own `email` format rather than a
 * pattern invented here, and it is trimmed before that check rather than after:
 * a trailing space is what a browser leaves in a text field, and refusing an
 * otherwise valid address over one is a rejection a customer cannot act on. The
 * ceiling is the 254 characters an address may occupy in a message envelope, so
 * an address this schema accepts is one the confirmation can be sent to.
 * `company` is `null` for a customer purchasing as an individual.
 */
export const customerContactSchema: z.ZodType<CustomerContact> = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'A contact name is required.')
    .max(120, 'Keep the contact name to 120 characters.')
    .refine(plain, TYPED),

  email: z
    .string()
    .trim()
    .pipe(
      z
        .email('Enter an email address the order confirmation can reach.')
        .max(254, 'Keep the email address to 254 characters.'),
    ),

  company: blank(120, 'Keep the company name to 120 characters.'),
} satisfies Mirror<CustomerContact>);

/**
 * A parsed contact: a name, a deliverable email address and either a company or
 * `null`.
 */
export type CustomerContactInput = z.infer<typeof customerContactSchema>;

/**
 * The body `POST /api/checkout` accepts: the request that turns the cart into an
 * order.
 *
 * It is `CheckoutDraft` field for field — contact, destination, chosen service
 * and an optional note — and `satisfies Mirror<CheckoutDraft>` is what keeps it
 * that way. `shippingOptionId` echoes back the `id` of a shipping option the
 * quote offered, so it is accepted as the bounded opaque token it is rather
 * than as a closed vocabulary: the services that price freight mint
 * those identifiers, and a service level this store stops offering must fail
 * against the quote it is checked with rather than against a list frozen here.
 * Whether the identifier names an option still on offer, whether the cart holds
 * anything and whether the stock is still there are all decided by the checkout
 * service against the data of the moment; this schema decides only that the
 * request is well formed.
 */
export const checkoutBodySchema = z.object({
  contact: customerContactSchema,

  shippingAddress: shippingAddressSchema,

  /** The shipping service the customer chose, as the quote identified it. */
  shippingOptionId: z
    .string()
    .trim()
    .min(1, 'Choose a shipping service.')
    .max(64, 'That shipping service identifier is longer than this store issues.')
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      'A shipping service identifier holds letters, digits, dots, hyphens and underscores.',
    ),

  /** Delivery instructions for the warehouse; `null` when there are none. */
  notes: blank(500, 'Keep delivery notes to 500 characters.'),

  /**
   * What the caller calls this attempt to place the order, so that repeating a
   * submission whose reply was lost is answered with the order that attempt
   * already placed rather than placing a second one.
   *
   * It is accepted as the bounded opaque token it is, on the same terms as the
   * shipping service above: the value is the caller's, it names nothing in this
   * store, and the checkout service reads no meaning from its content - so the
   * only requirements are that it is long enough to be a caller's own value
   * rather than a guess, short enough to be worth remembering, and made of
   * characters that are safe to log and to compare. A body that omits it is
   * refused here rather than treated as an unrepeatable request, because a
   * submission nobody can name is one nobody can retry safely.
   */
  idempotencyKey: z
    .string()
    .trim()
    .min(8, 'Name the attempt this order is being placed under.')
    .max(64, 'That attempt identifier is longer than this store accepts.')
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      'An attempt identifier holds letters, digits, dots, hyphens and underscores.',
    ),
} satisfies Mirror<CheckoutDraft>);

/**
 * A parsed checkout body: the shape the route handler destructures and hands on
 * to the checkout service.
 *
 * It is the schema's output rather than its input, so every field holds a value:
 * the note, the second address line and the company are each a string or
 * `null`, the country is a two-letter code, and nothing is `undefined`.
 */
export type CheckoutBodyInput = z.infer<typeof checkoutBodySchema>;
