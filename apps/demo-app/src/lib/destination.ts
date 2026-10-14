/**
 * Where Lumen Supply quotes freight to, and what a destination there looks like.
 *
 * A carrier rates a shipment to a *destination*, and a destination is a country
 * and a postal code together — neither half means anything on its own. `44301`
 * is Akron, Ohio in the United States and Guadalajara in Mexico; `K1A 0B1` is
 * an address in Canada and not a postal code at all anywhere else. So the two
 * fields are judged as one thing, and they are judged here.
 *
 * WHY THIS IS A SHARED MODULE AND NOT A RULE EACH SURFACE KEEPS
 * `./types` states the convention this module is the second exception to: a
 * *shape* normally stays each surface's own, because a shape is checked where a
 * value arrives and never has to be quoted back to a customer. A complete
 * destination is not that kind of shape. Three surfaces have to act on the very
 * same judgement, and acting differently is a defect in each direction:
 *
 *   * the browser must not ask for a quote it knows will be refused, and must
 *     not treat a half-typed code as a destination - a rate taken on `443`
 *     prices a different place from `44301`, and a buyer shown it would be
 *     offered an order at a price the store never quoted;
 *   * `GET /api/shipping/quote` must refuse the same value, so a request made
 *     by hand cannot bind a rate the form would not have asked for;
 *   * the shipping service must refuse it once more against the values it hands
 *     the carrier, because `POST /api/checkout` reaches it by another route.
 *
 * One judgement in one module is what keeps those three from drifting. The
 * module has no imports and no I/O - it is pure text classification - so a
 * client component, a Zod schema and a database-backed service can all read it.
 *
 * WHAT IT DOES NOT DO
 * It is not an address-verification service and does not claim a destination
 * exists: `99999` is a well-formed United States code that no carrier serves,
 * and saying so is the carrier's answer rather than this module's. The question
 * answered here is narrower and entirely local: has the buyer finished writing
 * a destination, and is what they wrote written the way that country writes one.
 * A code that passes still reaches the carrier, and a carrier that offers
 * nothing for it is a result the picker renders as such.
 *
 * Every message below is wording a customer reads, and none of them repeats the
 * value: a postal code is somebody's address even when it is malformed, so the
 * messages name the format expected rather than the characters received.
 */

/* ---------------------------------------------------------------------------
 * How a destination's format is written down
 * ------------------------------------------------------------------------- */

/**
 * The token that stands for one decimal digit in a postal-code format.
 *
 * The formats below are written as templates rather than as regular
 * expressions, and the reason is the classification this module has to make.
 * A regular expression answers "does this match", which cannot tell a code
 * somebody is still typing from one they typed wrongly - and those two need
 * different wording, because one is a prompt to carry on and the other is a
 * correction. Walking a template answers both at once: a value that runs out
 * while the template still has tokens is unfinished, and a value that
 * contradicts a token is wrong.
 */
const DIGIT_TOKEN = '#';

/** The token that stands for one letter, in either case. */
const LETTER_TOKEN = '@';

/**
 * The token that stands for the optional separator inside a code written in
 * groups - the space in `K1A 0B1`, which many buyers leave out.
 *
 * Optional in the value rather than in the template: the token consumes a
 * single space or hyphen when one is there and nothing when it is not, so
 * `K1A 0B1`, `K1A-0B1` and `K1A0B1` are one destination written three ways.
 */
const SEPARATOR_TOKEN = ' ';

/** The characters {@link SEPARATOR_TOKEN} accepts, as a set for a single lookup. */
const SEPARATORS = new Set([' ', '-']);

/** One decimal digit. Anchored, and applied to a single character at a time. */
const DIGIT = /^[0-9]$/;

/** One letter in either case. Anchored, and applied to a single character at a time. */
const LETTER = /^[A-Za-z]$/;

/**
 * How far a value got through a postal-code format.
 *
 * `complete` is a destination that can be quoted. `partial` is a value that
 * agrees with the format as far as it goes and then stops - somebody is still
 * typing, or stopped early. `none` is a value the format contradicts.
 */
type FormatFit = 'complete' | 'partial' | 'none';

/**
 * How far `value` gets through `template`.
 *
 * @param value The postal code as the buyer wrote it, already trimmed.
 * @param template A format written in {@link DIGIT_TOKEN}, {@link LETTER_TOKEN},
 *   {@link SEPARATOR_TOKEN} and literal characters.
 * @returns `complete` when the value satisfies the whole template and ends
 *   there, `partial` when the value ends early, and `none` when a character
 *   contradicts its token or the value runs on past the template.
 */
function formatFit(value: string, template: string): FormatFit {
  let index = 0;

  for (const token of template) {
    // The value ended while the template still expects something, so what was
    // written is the beginning of this format rather than a breach of it.
    // `charAt` rather than an index read: it answers with a string for every
    // position, so nothing below has to narrow an `undefined` that the bound
    // check has already ruled out.
    if (index === value.length) {
      return 'partial';
    }

    const character = value.charAt(index);

    if (token === SEPARATOR_TOKEN) {
      // Consumed only when it is actually there; a code written without its
      // separator carries straight on to the next token.
      if (SEPARATORS.has(character)) {
        index += 1;
      }

      continue;
    }

    if (token === DIGIT_TOKEN) {
      if (!DIGIT.test(character)) {
        return 'none';
      }
    } else if (token === LETTER_TOKEN) {
      if (!LETTER.test(character)) {
        return 'none';
      }
    } else if (character !== token) {
      return 'none';
    }

    index += 1;
  }

  // Every token was satisfied. Anything left over is a longer value than this
  // format describes, which is a different code rather than a longer one.
  return index === value.length ? 'complete' : 'none';
}

/* ---------------------------------------------------------------------------
 * The destinations this store quotes freight to
 * ------------------------------------------------------------------------- */

/** One country this catalog's warehouses quote freight for. */
export interface FreightDestination {
  /** The two-letter code the address DTO carries and the quote is asked for. */
  readonly code: string;

  /** The country's name, as the checkout country control lists it. */
  readonly label: string;

  /**
   * The country as an adjective, for the sentences below.
   *
   * Stated rather than derived because English does not derive it: "Canada" and
   * "Mexico" become "Canadian" and "Mexican", while "United States" stays as it
   * is. Every message here reads naturally in the attributive form - "a
   * Canadian postal code", "United States postal codes are written like…" -
   * where the name alone would need an article the message cannot know about,
   * and a template that inserted one would produce "a Canada postal code".
   */
  readonly adjective: string;

  /**
   * The shapes a complete postal code takes there, most common first.
   *
   * More than one where a country writes more than one - a United States code
   * is five digits, and five digits with a four-digit extension - and a value
   * is complete when it satisfies any of them.
   */
  readonly postalCodeFormats: readonly string[];

  /** How a complete code is written, for the wording shown beside the field. */
  readonly postalCodeExample: string;
}

/**
 * The destinations this catalog's warehouses quote freight for.
 *
 * A closed list, because the country is the one address field the storefront
 * reads itself: it picks the warehouses that can serve the order, it decides
 * what a complete postal code is, and it is sent to the carrier as part of the
 * destination being rated. The codes are the ones the address schema accepts
 * and the labels are what the checkout control shows.
 */
export const FREIGHT_DESTINATIONS: readonly FreightDestination[] = [
  {
    code: 'US',
    label: 'United States',
    adjective: 'United States',
    postalCodeFormats: ['#####', '#####-####'],
    postalCodeExample: '44301 or 44301-1234',
  },
  {
    code: 'CA',
    label: 'Canada',
    adjective: 'Canadian',
    postalCodeFormats: ['@#@ #@#'],
    postalCodeExample: 'K1A 0B1',
  },
  {
    code: 'MX',
    label: 'Mexico',
    adjective: 'Mexican',
    postalCodeFormats: ['#####'],
    postalCodeExample: '06600',
  },
];

/** The destination a form with no prefill starts on, as the address schema defaults it. */
export const DEFAULT_FREIGHT_DESTINATION_CODE = 'US';

/**
 * `code` as this store's canonical country code: trimmed and upper-cased.
 *
 * Every surface normalises the same way, so a country arriving from a query
 * string in lower case and one chosen from the checkout control are one value.
 *
 * @param code A country code as some surface received it.
 * @returns The canonical form, which may still name no destination this store
 *   quotes for - {@link freightDestination} is what answers that.
 */
export function canonicalCountryCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * The destination `code` names, or `undefined` when this store quotes none.
 *
 * @param code A country code in any case, with or without surrounding space.
 * @returns The matching entry of {@link FREIGHT_DESTINATIONS}, or `undefined`.
 */
export function freightDestination(code: string): FreightDestination | undefined {
  const wanted = canonicalCountryCode(code);

  return FREIGHT_DESTINATIONS.find((entry) => entry.code === wanted);
}

/* ---------------------------------------------------------------------------
 * Judging a destination
 * ------------------------------------------------------------------------- */

/**
 * Which part of a destination cannot be quoted, and why.
 *
 * The four faults are kept apart because a buyer does something different
 * about each: choose a country this store serves, write a postal code at all,
 * finish the one they started, or correct one that is not written the way that
 * country writes them.
 */
export type FreightDestinationFault =
  'country' | 'postal-missing' | 'postal-incomplete' | 'postal-invalid';

/** Why a destination cannot be quoted, with the field to say it against. */
export interface FreightDestinationProblem {
  /** Which fault this is, for a caller that words or styles them differently. */
  readonly fault: FreightDestinationFault;

  /**
   * The field the message belongs against, named as the address DTO and the
   * checkout controls name it - so a form attaches the message to the control
   * at fault rather than to a panel somewhere else on the page.
   */
  readonly field: 'country' | 'postalCode';

  /** A sentence to show the buyer. It names the format expected, never the value. */
  readonly message: string;
}

/** What a buyer is told when the country control names nothing this store serves. */
const COUNTRY_MESSAGE = 'Choose the country this order ships to.';

/** What a buyer is told when the postal-code field is empty. */
const POSTAL_MISSING_MESSAGE = 'A postal code is required.';

/**
 * Guidance for writing a complete postal code for `destination`, which is the
 * sentence a field's hint carries and the tail of both postal-code faults.
 *
 * @param destination The country the order is going to.
 * @returns One sentence naming the country and how its codes are written.
 */
export function freightPostalCodeHint(destination: FreightDestination): string {
  return `${destination.adjective} postal codes are written like ${destination.postalCodeExample}.`;
}

/**
 * Whether `postalCode` is a complete postal code for `destination`.
 *
 * @param destination The country the order is going to.
 * @param postalCode The postal code as the buyer wrote it; trimmed here.
 * @returns True when the code satisfies one of the country's formats exactly.
 */
export function isCompletePostalCode(destination: FreightDestination, postalCode: string): boolean {
  const written = postalCode.trim();

  return destination.postalCodeFormats.some(
    (template) => formatFit(written, template) === 'complete',
  );
}

/**
 * Why freight cannot be quoted to the destination these two fields describe, or
 * `null` when it can.
 *
 * `null` is the whole of the go-ahead: a destination this answers `null` for is
 * one the browser may ask a quote for, one `GET /api/shipping/quote` accepts,
 * and one the shipping service will hand a carrier. Every other answer carries
 * the field to say it against and a sentence to say, and the caller neither
 * re-derives the wording nor guesses which control was at fault.
 *
 * The order the faults are tested in is the order a buyer can act on them. The
 * country decides what a postal code even looks like, so an unserved country is
 * reported before the code is read at all rather than as a code that does not
 * match a format nobody chose. Then the code: absent, unfinished, or written as
 * no code for that country is.
 *
 * @param country The destination country code, in any case.
 * @param postalCode The destination postal code as the buyer wrote it.
 * @returns The problem, or `null` when the destination can be quoted.
 */
export function freightDestinationProblem(
  country: string,
  postalCode: string,
): FreightDestinationProblem | null {
  const destination = freightDestination(country);

  if (destination === undefined) {
    return { fault: 'country', field: 'country', message: COUNTRY_MESSAGE };
  }

  const written = postalCode.trim();

  if (written.length === 0) {
    return { fault: 'postal-missing', field: 'postalCode', message: POSTAL_MISSING_MESSAGE };
  }

  // The best any of the country's formats made of the value: a complete match
  // ends the matter, and a value that at least begins like one of them is
  // unfinished rather than wrong - which is the difference between asking a
  // buyer to carry on and telling them to start again.
  let unfinished = false;

  for (const template of destination.postalCodeFormats) {
    const fit = formatFit(written, template);

    if (fit === 'complete') {
      return null;
    }

    if (fit === 'partial') {
      unfinished = true;
    }
  }

  const guidance = freightPostalCodeHint(destination);

  if (unfinished) {
    return {
      fault: 'postal-incomplete',
      field: 'postalCode',
      message: `This postal code is not complete, so freight cannot be quoted for it yet. ${guidance}`,
    };
  }

  return {
    fault: 'postal-invalid',
    field: 'postalCode',
    message: `That is not a ${destination.adjective} postal code. ${guidance}`,
  };
}
