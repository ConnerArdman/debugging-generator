/**
 * Freight quoting for Lumen Supply.
 *
 * Checkout has to tell a customer what it costs to get an order to them and
 * when it would arrive, and neither figure belongs to this store: a carrier
 * rates a shipment. This module is the one place the storefront asks. It has a
 * single operation, `quote`, and two callers - the checkout that is placing an
 * order, and `GET /api/shipping/quote`, which the checkout form calls while the
 * customer is still filling it in.
 *
 * What a rating request is made of is the same in both cases. A carrier prices
 * a shipment from its destination, its weight, the number of pieces it is made
 * of and the tier of service being asked for, so those are the four values sent
 * and the four members of {@link ShippingQuoteInput}. Only the destination is
 * required: the other three describe one ordinary parcel when a caller leaves
 * them out, which is what lets the browser ask for a quote with a postal code
 * and nothing else. A weight a caller does name is held to the range a carrier
 * will rate rather than passed on as it stands, so an implausible one is quoted
 * at the boundary instead of coming back as a rejected request; a destination or
 * a piece count beyond what a carrier rates is refused instead, because a rate
 * taken on a shorter code or on fewer pieces would price a different shipment.
 *
 * The request goes out over HTTP, to `/api/mock/carrier` on the origin the
 * caller hands over. That endpoint stands in for a carrier account this store
 * does not have, and reaching it the same way a real one would be reached is
 * the point: it is addressed at the origin of the request being served rather
 * than at a host written into this file, so the same code runs wherever the
 * application is served from and no configuration decides where a quote comes
 * from. An origin arrives from the outside, though, so it is checked against
 * `@/server/origin` before a request is addressed to it: a rating request
 * carries a customer's destination, and one addressed somewhere other than this
 * store would carry it there.
 *
 * Nothing in a reply is trusted. A carrier's wire format is not this
 * application's to guarantee, so every field is narrowed before it is read, a
 * rate that cannot be read is left out rather than repaired, and a reply that
 * yields no readable rate at all is an upstream failure rather than an empty
 * quote. A destination that genuinely has no service offered to it is a
 * different thing, and is answered with an empty option list - a result, not a
 * failure.
 *
 * The rate a quote was taken at is recorded, one row per quote, so a price the
 * customer was shown can be reconciled with the order that followed it.
 *
 * The conventions of `@/lib/types` hold at this boundary: money is an integer
 * number of US cents in a `…Cents` field, transit time is a whole number of
 * business days, an instant is an ISO-8601 UTC string, and neither a `Date` nor
 * anything else JSON cannot carry leaves this module - the result travels
 * through a route handler to the browser and into a client component.
 */

import type { ShippingOption, ShippingQuoteResult } from '@/lib/types';
import { prisma } from '@/server/db/prisma';
import { StorefrontUpstreamError, StorefrontValidationError } from '@/server/errors';
import { trusted } from '@/server/origin';

/* ---------------------------------------------------------------------------
 * The shipment a caller does not describe, and the figures a reply is held to
 * ------------------------------------------------------------------------- */

/**
 * Which dependency a failure is attributed to, as the short label
 * `StorefrontUpstreamError` reports. A word, because it reaches the browser.
 */
const UPSTREAM = 'carrier';

/** What a shipment nobody weighed is rated at, in grams: one light parcel. */
const WEIGHT = 2_000;

/** How many pieces a shipment nobody counted is rated as. */
const ITEMS = 1;

/** The tier quoted when a caller names none, and when it names one no carrier could read. */
const LEVEL = 'standard';

/**
 * The longest destination postal code a carrier will rate, and the same ceiling
 * every request surface holds a destination to, so a postal code one of them
 * accepted is never refused here.
 */
const MAX_POSTAL = 12;

/** The heaviest single shipment a carrier will rate, in grams. */
const MAX_WEIGHT = 150_000;

/**
 * The most pieces a carrier will rate as one shipment, and the same ceiling
 * every request surface holds a count to.
 *
 * A shipment of more pieces than this is refused rather than rated as fewer: a
 * rate taken on part of a consignment is the cost of a shipment nobody is
 * sending, and the consignment travels as more than one shipment, each quoted
 * on its own.
 */
const MAX_ITEMS = 500;

/** The longest service code a carrier will read. */
const MAX_LEVEL = 32;

/** The longest piece of text read out of a reply, for a name, a code or a label. */
const MAX_TEXT = 120;

/** How many quoted options are read out of one reply; a picker lists a handful. */
const MAX_OPTIONS = 24;

/**
 * The most a single service may be quoted at, in cents. Well above any freight
 * this catalog produces, and below what the amount column holds, so a figure
 * computed wrongly upstream is refused here rather than recorded.
 */
const MAX_CENTS = 100_000_000;

/** The longest transit time a quoted service may claim, in business days. */
const MAX_DAYS = 365;

/**
 * What a customer is told when a reply arrived but held no quote this module
 * could read. One sentence, naming no host, path or field: a wire format is a
 * developer's problem, and the server log is where a developer reads about it.
 */
const UNREADABLE = 'The carrier answered a shipping quote this storefront could not read.';

/**
 * What a caller is told when the address it handed over is not one this store
 * may reach itself at. The wording names no address: the value came from the
 * request, and repeating it back would only echo it.
 */
const MISADDRESSED =
  'This request was not addressed to this store, so no shipping quote was taken.';

/**
 * How long the carrier is given to answer, in milliseconds.
 *
 * Generous on purpose: rating a shipment is a request to another service rather
 * than a local calculation, and a quote that was going to arrive is worth
 * waiting for. The ceiling is there so that a dependency which has stopped
 * answering fails the checkout instead of holding it open.
 */
const BUDGET = 8_000;

/**
 * The shape of a service code: alphanumeric words joined by single spaces,
 * hyphens or underscores.
 *
 * Kept here as its own copy rather than imported from the request schemas of
 * `@/server/validation`: this folder and that one deliberately do not depend on
 * each other, and what this module needs to know is which values a carrier will
 * read, which is a property of the carrier rather than of any one endpoint.
 */
const LEVEL_PATTERN = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;

/* ---------------------------------------------------------------------------
 * What a caller asks
 * ------------------------------------------------------------------------- */

/**
 * The shipment to be quoted.
 *
 * Only the destination is required, and every other member carries a default,
 * so `{ postalCode }` is a complete request: that is the call the checkout form
 * makes through `GET /api/shipping/quote`, and it is why a caller that has not
 * weighed or counted anything still gets a usable quote. The member names are
 * the storefront's own - the unit is in the name of the one measurement - so a
 * parsed request from that endpoint is this shape already.
 */
export interface ShippingQuoteInput {
  /** Where the shipment is going, as the destination's postal code. */
  postalCode: string;

  /** What the shipment weighs, in whole grams. Defaults to one light parcel. */
  weightGrams?: number | undefined;

  /** How many units travel in the shipment. Defaults to one. */
  itemCount?: number | undefined;

  /** Which tier of service to quote around. Defaults to the store's baseline tier. */
  serviceLevel?: string | undefined;

  /**
   * The cart the shipment is for, when the caller is quoting one.
   *
   * A quote taken for a cart is recorded against it, so the order that cart
   * becomes can be placed on the very quote its customer chose rather than on
   * whichever quote happened to be taken last. The checkout form quotes a
   * destination rather than a cart and leaves this out, and such a quote is
   * recorded with no cart against it.
   */
  cart?: string | undefined;
}

/* ---------------------------------------------------------------------------
 * Reading a reply
 * ------------------------------------------------------------------------- */

/**
 * Whether `value` is an array, narrowed to elements of `unknown` rather than
 * the `any[]` that `Array.isArray` claims - so reading an element yields a
 * value that still has to be checked, which is the point.
 */
function list(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Whether `value` is an object whose members can be read one at a time.
 *
 * Arrays are excluded: a list of rates is handled as a list. What a member
 * holds is `unknown` here, so every field a caller goes on to read is narrowed
 * on its own rather than taken on the strength of this check alone.
 */
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `value` as trimmed text of at most `max` characters, or `undefined` when it
 * is not text a field can be filled from. Surrounding whitespace is dropped
 * before the length is measured, and a value made only of whitespace reads as
 * nothing at all.
 */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? undefined : trimmed;
}

/**
 * `value` as a whole number between `min` and `max`, or `undefined` when it is
 * not a figure inside that range.
 *
 * A figure out of range is refused rather than brought into it: this reads the
 * money a service is quoted at and the days it claims, and a price adjusted to
 * fit would be a price nobody quoted.
 */
function whole(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.round(value);
  return rounded < min || rounded > max ? undefined : rounded;
}

/**
 * `value` as a whole number between `min` and `max`, or `fallback` when the
 * caller named nothing usable.
 *
 * Here a figure out of range is brought into range rather than refused, because
 * this reads what a caller asked about rather than what a carrier answered: a
 * shipment described implausibly is still worth quoting at the boundary, and
 * both endpoints that reach this module bound these values already.
 */
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * The service code to ask about: the caller's, when it is one a carrier will
 * read, and the store's baseline tier otherwise. The tiers belong to the
 * services on offer rather than to this module, so any code of the right shape
 * is passed on as it stands.
 */
function tier(value: string | undefined): string {
  const named = text(value, MAX_LEVEL);

  if (named === undefined || named.length < 2 || !LEVEL_PATTERN.test(named)) {
    return LEVEL;
  }

  return named;
}

/**
 * The instant `value` names, or `fallback` when it names none this module can
 * read. A carrier stamps its own quote; a reply that did not is stamped with
 * the moment it was read, so a recorded quote always has a time.
 */
function instant(value: unknown, fallback: Date): Date {
  const named = text(value, MAX_TEXT);

  if (named === undefined) {
    return fallback;
  }

  const parsed = new Date(named);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

/**
 * One entry of a reply as a service the store can offer, or `undefined` when
 * the entry is not one.
 *
 * Every field is required, because each of them is rendered: an option missing
 * its price, its label or its transit time is not something to put in front of
 * a customer. Nothing is filled in on a carrier's behalf - an entry that falls
 * short is left out of the quote entirely.
 */
function option(value: unknown): ShippingOption | undefined {
  if (!record(value)) {
    return undefined;
  }

  const id = text(value.id, MAX_TEXT);
  const carrier = text(value.carrier, MAX_TEXT);
  const service = text(value.service, MAX_TEXT);
  const label = text(value.label, MAX_TEXT);
  const price = whole(value.priceCents, 0, MAX_CENTS);
  const days = whole(value.estimatedDays, 0, MAX_DAYS);

  if (
    id === undefined ||
    carrier === undefined ||
    service === undefined ||
    label === undefined ||
    price === undefined ||
    days === undefined
  ) {
    return undefined;
  }

  return { id, carrier, service, label, priceCents: price, estimatedDays: days };
}

/**
 * The entries a reply carries: the members of its option list when the reply is
 * the object a carrier answers with, or the reply itself when one answers with
 * a bare list of rates. `undefined` when it carries neither, which is a reply
 * this module cannot read at all.
 */
function rates(value: unknown): readonly unknown[] | undefined {
  if (list(value)) {
    return value;
  }

  if (record(value) && list(value.options)) {
    return value.options;
  }

  return undefined;
}

/**
 * The option a quote is recorded at: the one matching the tier the caller asked
 * about, and the first one offered when none matches - a carrier may answer a
 * request for a tier it does not run with the services it does. `undefined`
 * only when nothing was offered.
 */
function chosen(options: readonly ShippingOption[], level: string): ShippingOption | undefined {
  const wanted = level.toLowerCase();

  for (const offer of options) {
    if (offer.service.toLowerCase() === wanted || offer.id.toLowerCase() === wanted) {
      return offer;
    }
  }

  return options[0];
}

/* ---------------------------------------------------------------------------
 * Quoting
 * ------------------------------------------------------------------------- */

/**
 * Quotes the services that can carry a shipment to a destination, and records
 * the rate the quote was taken at.
 *
 * @param input The shipment. Only `postalCode` is required; what a caller does
 *   not describe is rated as one ordinary parcel at the store's baseline tier.
 * @param origin Where the carrier is reached, as the scheme and authority of
 *   the request being served - read from the incoming request by the route
 *   handler rather than configured or assumed anywhere, and checked here before
 *   anything is addressed to it.
 * @returns The quote the store recorded, the services on offer, the destination
 *   they were quoted for and the instant they were quoted at. A destination
 *   with no service offered to it is answered with no options and no recorded
 *   quote, which is a result rather than a failure.
 * @throws StorefrontValidationError When the shipment names no destination a
 *   carrier could rate, names more pieces than a carrier rates as one
 *   shipment, or when the address handed over is not one this store may reach
 *   itself at.
 * @throws StorefrontUpstreamError When the carrier cannot be reached, refuses
 *   the request, or answers with nothing this storefront can read. A failure of
 *   the insert that records the quote propagates as it was raised, for the
 *   single mapper in `@/server/errors` to classify: a quote that could not be
 *   recorded is not reported as one that was.
 */
export async function quote(
  input: ShippingQuoteInput,
  origin: string,
): Promise<ShippingQuoteResult> {
  const postal = text(input.postalCode, MAX_POSTAL);

  if (postal === undefined) {
    throw new StorefrontValidationError(
      `A shipment needs a destination postal code of at most ${String(MAX_POSTAL)} characters.`,
    );
  }

  const counted = input.itemCount;

  // A count a caller named above what a carrier rates as one shipment is
  // refused rather than brought down to the ceiling: a rate taken on fewer
  // pieces than travel is the price of a different shipment, and a caller told
  // the limit can ask again per shipment. A figure that is no count at all
  // takes the default below, as an unnamed one does.
  if (counted !== undefined && Number.isFinite(counted) && Math.round(counted) > MAX_ITEMS) {
    throw new StorefrontValidationError(
      `A carrier rates at most ${String(MAX_ITEMS)} pieces as one shipment. ` +
        'Quote a larger consignment as more than one shipment.',
    );
  }

  if (!trusted(origin)) {
    throw new StorefrontValidationError(MISADDRESSED);
  }

  const weight = bounded(input.weightGrams, WEIGHT, 0, MAX_WEIGHT);
  const items = bounded(counted, ITEMS, 1, MAX_ITEMS);
  const level = tier(input.serviceLevel);

  let response: Response;

  try {
    // The address is formed here rather than further up so that an origin no
    // URL can be built from fails the way an unreachable carrier does: to a
    // caller waiting on a quote, the two are one outcome.
    response = await fetch(new URL('/api/mock/carrier', origin), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        destinationPostalCode: postal,
        weightGrams: weight,
        itemCount: items,
        serviceLevel: level,
      }),
      signal: AbortSignal.timeout(BUDGET),
    });
  } catch (cause) {
    throw new StorefrontUpstreamError(
      'The carrier could not be reached for a shipping quote. Try again in a moment.',
      UPSTREAM,
      { cause },
    );
  }

  if (!response.ok) {
    throw new StorefrontUpstreamError(
      'The carrier would not quote this shipment. Try again in a moment.',
      UPSTREAM,
    );
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch (cause) {
    throw new StorefrontUpstreamError(UNREADABLE, UPSTREAM, { cause });
  }

  const entries = rates(payload);

  if (entries === undefined) {
    throw new StorefrontUpstreamError(UNREADABLE, UPSTREAM);
  }

  const options: ShippingOption[] = [];

  for (const entry of entries) {
    if (options.length >= MAX_OPTIONS) {
      break;
    }

    const offer = option(entry);

    if (offer !== undefined) {
      options.push(offer);
    }
  }

  // Rates that were offered and could not be read are a reply this module does
  // not understand, and saying so is better than answering a checkout with a
  // destination it will believe has no service.
  if (options.length === 0 && entries.length > 0) {
    throw new StorefrontUpstreamError(UNREADABLE, UPSTREAM);
  }

  const when = instant(record(payload) ? payload.quotedAt : undefined, new Date());
  const rate = chosen(options, level);

  // One row per quote, recorded at the rate the customer is shown, and against
  // the cart the shipment is for when there is one - which is what lets the
  // order that cart becomes be placed on this quote and no other. A quote that
  // came back with nothing on offer has no rate to record.
  let recorded: string | null = null;

  if (rate !== undefined) {
    const code = record(payload) ? text(payload.carrierCode, MAX_TEXT) : undefined;

    const row = await prisma.shippingQuote.create({
      data: {
        cartId: input.cart ?? null,
        carrierCode: code ?? rate.carrier,
        serviceLevel: rate.service,
        amountCents: rate.priceCents,
        etaDays: rate.estimatedDays,
        quotedAt: when,
      },
      select: { id: true },
    });

    recorded = row.id;
  }

  return {
    id: recorded,
    options,
    destinationPostalCode: postal,
    quotedAt: when.toISOString(),
  };
}
