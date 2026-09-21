/**
 * `POST /api/mock/carrier` - the storefront's stand-in freight carrier.
 *
 * Lumen Supply ships without a carrier account, so the application rates its own
 * shipments: `quote()` in `@/server/services/shipping.service` posts a
 * destination and a parcel to this endpoint over HTTP, exactly as it would post
 * them to a carrier's rating API, and reads the services on offer back out of
 * the reply. That is what lets a checkout price freight on a laptop with nothing
 * behind it but a database.
 *
 * Being a stand-in rather than a carrier is why the handler is as short as it is,
 * and it decides four things:
 *
 * 1. **Nothing is looked up.** A real rating engine reads tariffs, fuel
 *    surcharges and a zone chart; there is none of that here, so every figure
 *    below is arithmetic over the request. The handler reads no database, calls
 *    nothing over the network, keeps no state and does no work at module scope -
 *    which is also why it never caches: one request is one rating.
 * 2. **The reply is derived from the request.** The band a destination falls in,
 *    the rates, the transit times and the quote reference all come out of the
 *    body that was parsed, with nothing drawn from a clock or a source of
 *    randomness, so two identical requests are answered identically.
 * 3. **Every service the carrier runs comes back, priced.** A rating request
 *    names the service a caller is interested in, and a carrier answers it with
 *    what it runs to that destination rather than with that one service alone:
 *    the checkout's picker compares the services side by side, and a reply
 *    holding one of them would leave it nothing to compare. The service that was
 *    asked about leads the list, which is the carrier's way of saying it read the
 *    request.
 * 4. **The reply speaks `@/lib/types`.** Each entry carries exactly the fields
 *    {@link ShippingOption} declares - money as an integer number of US cents in
 *    a `*Cents` field, transit time as a whole number of business days - and the
 *    instant the quote was taken is an ISO-8601 UTC string. A `Date` never
 *    leaves here, and neither does an absolute delivery date: the store words a
 *    delivery promise from a day count, in `formatShippingEtaLabel`.
 *
 * Whatever is thrown - a body that is not readable JSON, a body the schema
 * rejects - is handed to the single mapper in `@/server/errors`, so this endpoint
 * reports a failure in the same envelope as every other one. A caller waiting on
 * a quote reads a rejection rather than a rate it could believe.
 */

import type { ShippingOption } from '@/lib/types';
import { storefrontErrorResponse } from '@/server/errors';
import { carrierMockBodySchema, type CarrierMockBodyInput } from '@/server/validation/mocks';

/**
 * A rating is answered, never described, so the route is handled per request and
 * never prerendered: `next build` rates nothing, and no reply is served again
 * for a later shipment.
 */
export const dynamic = 'force-dynamic';

/**
 * The carrier's own code, as a quote records it in `carrierCode` and as an order
 * prints it beside the service it shipped by. Four letters, which is the shape
 * of the codes this store's historical quotes were taken under.
 */
const CARRIER = 'NLEX';

/**
 * The services the carrier runs, in the order it lists them, each with the
 * figures its rate is built from.
 *
 * The identifiers are the store's own service vocabulary: they are what a quote
 * records as its service level and what a checkout sends back as the service the
 * customer chose, so each one is both the entry's `id` and its `service`. The
 * rest is a small tariff - a base charge, a charge per kilogram, a charge for
 * every piece after the first, a charge per band of distance, a transit time and
 * how many days each band of distance adds to it. Air freight is quoted at a
 * fixed transit time, which is what makes it worth its price.
 *
 * Every figure is a whole number of cents or of days, and the schema's own
 * ceilings on weight and piece count keep the arithmetic below well inside the
 * range a quote is allowed to be recorded at.
 */
const SERVICES = [
  {
    id: 'standard',
    label: 'Standard ground',
    base: 1_250,
    kilo: 45,
    piece: 140,
    step: 320,
    days: 3,
    stretch: 1,
  },
  {
    id: 'express',
    label: 'Express air',
    base: 4_400,
    kilo: 120,
    piece: 380,
    step: 900,
    days: 2,
    stretch: 0,
  },
  {
    id: 'freight',
    label: 'LTL freight',
    base: 18_000,
    kilo: 26,
    piece: 95,
    step: 2_400,
    days: 5,
    stretch: 1,
  },
] as const;

/** One of the services the carrier runs, as {@link SERVICES} declares it. */
type Service = (typeof SERVICES)[number];

/**
 * How many bands of distance the carrier's tariff has. A destination falls in
 * one of them, `1` being the nearest and this figure the farthest, and the band
 * is what the distance-dependent part of every rate and transit time is built
 * from.
 */
const ZONES = 5;

/** Grams to the kilogram, which is the unit freight is charged by. */
const GRAMS = 1_000;

/**
 * Simulated carrier processing time, in milliseconds.
 *
 * A rating engine takes a moment to answer, and a reply that came back instantly
 * would make the checkout read as though the step were free. The figure is flat
 * rather than varying, and what is added to it below is derived from the
 * shipment, so the same request costs the same time on every run.
 */
const RATING_MS = 425;

/** Added to the rating time for every piece after the first. */
const PIECE_MS = 2;

/** Added to the rating time for every kilogram of the shipment. */
const KILO_MS = 1;

/**
 * The most the shipment itself may add to the rating time. A consignment of
 * hundreds of pieces is more work to rate than a single parcel, and the ceiling
 * keeps that from turning into a wait of a different order.
 */
const VARIANCE_MS = 30;

/** The base a quote reference's signature is written in: digits and letters. */
const RADIX = 36;

/** How many characters of signature a quote reference carries. */
const SIGNATURE = 6;

/**
 * What the signature is reduced modulo, so it is always exactly
 * {@link SIGNATURE} characters in base {@link RADIX} once padded.
 */
const MODULUS = RADIX ** SIGNATURE;

/**
 * The multiplier that mixes one character into a running signature. An odd
 * number coprime with {@link MODULUS}, so two shipments that differ in one
 * character are signed differently.
 */
const MIXER = 31;

/**
 * A stable number for a piece of text, in `[0, {@link MODULUS})`.
 *
 * Every character contributes, and its position changes what it contributes, so
 * a transposed postal code signs differently from the code it was transposed
 * from. The arithmetic stays inside the range JavaScript counts integers in
 * exactly, which is what makes the result the same on every run and every
 * machine rather than merely usually the same.
 *
 * @param value The text to reduce.
 * @returns A whole number below {@link MODULUS}.
 */
function checksum(value: string): number {
  let total = 0;

  for (const character of value) {
    total = (total * MIXER + (character.codePointAt(0) ?? 0)) % MODULUS;
  }

  return total;
}

/**
 * Which band of distance a destination falls in: `1` for the nearest,
 * {@link ZONES} for the farthest.
 *
 * A carrier reads this off a zone chart. There is no chart here, so the band is
 * taken from the postal code itself - upper-cased first, so a code written in
 * lower case is rated as the same destination - and every destination therefore
 * has one stable band rather than a band that moves between quotes.
 *
 * @param postal The destination's postal code, as the body carried it.
 * @returns A whole number between `1` and {@link ZONES}.
 */
function band(postal: string): number {
  return (checksum(postal.toUpperCase()) % ZONES) + 1;
}

/**
 * One service priced for the shipment being rated.
 *
 * The charge is the service's base, plus its rate per kilogram, plus its charge
 * for each piece after the first, plus what its tariff adds for the distance.
 * Transit time is its own, plus the days the distance adds. Both are whole
 * numbers, because both of their inputs are.
 *
 * @param service The service being priced.
 * @param kilos The shipment's weight in whole kilograms, rounded up.
 * @param pieces How many pieces the shipment is made of; at least one.
 * @param zone The band of distance the destination falls in.
 * @returns The service as the storefront offers it.
 */
function rate(service: Service, kilos: number, pieces: number, zone: number): ShippingOption {
  return {
    id: service.id,
    carrier: CARRIER,
    service: service.id,
    label: service.label,
    priceCents:
      service.base +
      service.kilo * kilos +
      service.piece * (pieces - 1) +
      service.step * (zone - 1),
    estimatedDays: service.days + service.stretch * (zone - 1),
  };
}

/**
 * The reference this quote is filed under: the carrier's code, the band the
 * destination falls in, and a signature of the shipment that was rated.
 *
 * It is derived rather than issued, so asking for the same shipment twice comes
 * back under the same reference and a reference in a server log can be tied to
 * the request that produced it. It identifies a rating, and nothing about it
 * authorizes anything.
 *
 * @param body The shipment, as the schema parsed it.
 * @param zone The band of distance the destination falls in.
 * @returns An upper-case reference of fixed shape.
 */
function reference(body: CarrierMockBodyInput, zone: number): string {
  const signature = checksum(
    [body.destinationPostalCode, body.weightGrams, body.itemCount, body.serviceLevel].join('|'),
  );

  return [
    CARRIER,
    String(zone),
    signature.toString(RADIX).toUpperCase().padStart(SIGNATURE, '0'),
  ].join('-');
}

/**
 * Rates a shipment and answers with every service that can carry it.
 *
 * @param request The POST whose JSON body `carrierMockBodySchema` describes: a
 * destination postal code, and optionally what the shipment weighs, how many
 * pieces it is made of and which service is being asked about.
 * @returns 200 with the services on offer, the carrier's code, the reference the
 * quote is filed under and the instant it was taken; or 400 in the storefront's
 * one error envelope when the body is not readable JSON or does not match the
 * schema.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    let raw: unknown;

    try {
      raw = await request.json();
    } catch {
      // A body that is not readable JSON describes no shipment, so it is handed
      // to the schema as the nothing it is: the rejection that follows names
      // what a rating request needs, in the same envelope a body with a bad
      // field is answered with.
      raw = undefined;
    }

    // Parsing throws, and the rejection names every field at fault: the single
    // mapper behind `storefrontErrorResponse` turns it into the same 400 every
    // other endpoint answers an unacceptable body with. It runs before the wait,
    // so a request that cannot be rated is refused at once.
    const body = carrierMockBodySchema.parse(raw);

    // Read once, before the wait, and reported as the instant the quote was
    // taken. A second read would describe a moment this handler had already
    // spent.
    const quotedAt = new Date().toISOString();

    const kilos = Math.ceil(body.weightGrams / GRAMS);
    const zone = band(body.destinationPostalCode);
    const delay =
      RATING_MS + Math.min(VARIANCE_MS, (body.itemCount - 1) * PIECE_MS + kilos * KILO_MS);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, delay);
    });

    // The service that was asked about leads, and the others follow in the order
    // the carrier lists them. A request naming a service this carrier does not
    // run still gets everything it does run, which is what a carrier answers
    // such a request with.
    const asked = body.serviceLevel.toLowerCase();
    const offered = [
      ...SERVICES.filter((service) => service.id === asked),
      ...SERVICES.filter((service) => service.id !== asked),
    ];

    const options: ShippingOption[] = offered.map((service) =>
      rate(service, kilos, body.itemCount, zone),
    );

    return Response.json(
      {
        options,
        carrierCode: CARRIER,
        reference: reference(body, zone),
        quotedAt,
      },
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  } catch (error: unknown) {
    return storefrontErrorResponse(error);
  }
}
