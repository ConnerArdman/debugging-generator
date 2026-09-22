'use client';

/**
 * Lumen Supply - reading the dispatch promise, and asking what freight costs.
 *
 * Two questions about getting an order to a buyer are answered in this module,
 * and they are answered in deliberately different ways.
 *
 * The first is the one every page asks: when does this leave the warehouse, and
 * when does it land? That is the countdown `<ShippingEtaProvider>` publishes -
 * one clock for the whole application - and {@link useShippingEta} is how the
 * header badge, a catalog card and the cart totals read it. This module holds
 * no state and owns no clock of its own for it: a second ticker would drift
 * from the first, and two parts of one page quoting different cut-offs for the
 * same order is a worse fault than either of them being a fraction of a second
 * behind.
 *
 * The second is asked at checkout only, and only once somebody has said where
 * the order is going: which carriers can take it there, at what service level,
 * and for how much. That answer comes from `GET /api/shipping/quote`, it
 * depends on a destination the store cannot guess, and {@link useFreightQuote}
 * is where the storefront asks for it. Until it is given a destination it asks
 * nothing at all, so a page that merely renders the checkout form sends no
 * request; the lookup begins when the address does.
 *
 * Neither hook composes a URL. Every request the storefront makes belongs to
 * `@/lib/api-client`, which owns the paths, the caching rules and the order the
 * parameters are written in.
 */

import { useEffect, useState } from 'react';

import { StorefrontApiError, requestShippingQuote } from '@/lib/api-client';
import { MAX_SHIPMENT_UNITS } from '@/lib/types';
import type { ShippingQuoteResult, StorefrontErrorCode } from '@/lib/types';
import { useDispatchEta, type DispatchEta } from '@/providers/ShippingEtaProvider';

/**
 * The dispatch promise, re-exported so a component that takes one as a prop can
 * name the type beside the hook it read the value from.
 */
export type { DispatchEta } from '@/providers/ShippingEtaProvider';

/**
 * Reads the live dispatch promise: the transit estimate, its wording, and how
 * long is left to make the day's collection.
 *
 * Everything the storefront prints about dispatch comes from here, so every
 * badge, card and total on a page quotes the same instant. The value is
 * republished as the countdown advances, and a consumer renders straight from
 * it: `etaLabel` for the arrival wording, `msUntilCutoff` and `beforeCutoff`
 * for the time left and whether it is still today's collection being counted
 * down to. Both of those are `null` until the first reading of the clock
 * arrives, which is what lets the markup the server produced and the first
 * markup the browser renders agree, and a consumer prints its own placeholder
 * for that first moment.
 *
 * Throws when called from a component that is not inside
 * `<ShippingEtaProvider>`, which the root layout mounts around the whole
 * application. That is a loud failure on purpose: a stand-in countdown would
 * let a page promise a cut-off the warehouses never agreed to.
 *
 * @returns The published dispatch promise.
 */
export function useShippingEta(): DispatchEta {
  return useDispatchEta();
}

/**
 * Shortest destination worth asking a quote for.
 *
 * `GET /api/shipping/quote` refuses a postal code of fewer than three
 * characters, so anything shorter is a field somebody is still typing rather
 * than a destination, and asking would spend a request on a question already
 * known to be refused. The rest of what makes a postal code plausible - which
 * characters, and how they group - is the endpoint's to judge, and is
 * deliberately not restated here: a second, competing idea of a valid address
 * would go stale the first time the store shipped somewhere new.
 */
const MIN_DESTINATION_CODE_LENGTH = 3;

/** Wording for a failed lookup that named no reason this module recognises. */
const FREIGHT_QUOTE_UNAVAILABLE = 'Shipping services could not be quoted right now.';

/**
 * A shipment too large to be quoted as one consignment, with the two figures
 * that say so.
 *
 * Its presence is the whole statement: a shipment this size is not a shipment
 * any carrier this store sells will rate, so there is no quote to wait for and
 * nothing for a caller to retry. Both figures are carried because the wording a
 * customer can act on needs both - what they are trying to send, and what fits
 * in one shipment.
 */
export interface FreightShipmentLimit {
  /** The units the caller asked to have quoted. */
  readonly units: number;
  /** The most units one shipment carries, {@link MAX_SHIPMENT_UNITS}. */
  readonly maxUnits: number;
}

/**
 * One lookup's answer, together with the question it answers.
 *
 * The question is `key` - a destination and a unit count, written as one
 * comparable value by {@link freightKeyOf} - and it travels with the answer for
 * one reason: state outlives the arguments it was gathered for. The hook is
 * called again with a corrected address or a changed cart before the effect
 * that clears the previous answer has run, and an answer without its question
 * cannot be told apart from a current one at that moment. With the question
 * attached, it can: a `key` that is not the one in hand is an answer to
 * something nobody is asking any more.
 */
interface FreightLookup {
  /** The question this answer was gathered for. */
  readonly key: string;
  /** The services quoted for that question, or `null` while none have been. */
  readonly quote: ShippingQuoteResult | null;
  /** Whether the lookup for that question is in flight. */
  readonly isQuoting: boolean;
  /** The failure wording for that question, or `null`. */
  readonly quoteError: string | null;
}

/**
 * The destination and the unit count as one value, which is what makes two
 * lookups comparable.
 *
 * A NUL separator rather than a punctuation character: a postal code is
 * letters, digits, spaces and hyphens, and none of those can be a NUL, so no
 * pair of different questions can be written the same way.
 *
 * @param destination The trimmed destination postal code, or `''`.
 * @param units The whole number of units, or `0` for no shipment described.
 * @returns The comparable form of that question.
 */
function freightKeyOf(destination: string, units: number): string {
  return `${String(units)}\u0000${destination}`;
}

/** Everything a shipping picker needs to render itself. */
export interface FreightQuoteState {
  /**
   * The services quoted for the destination and the shipment **in hand**, or
   * `null` when none have been: before a destination is given, while the first
   * lookup for a new one is in flight, after a failed lookup, and for a
   * shipment {@link FreightQuoteState.shipmentLimit} reports as too large to
   * quote.
   *
   * Once it holds a quote, that quote is the store's answer for the arguments
   * this hook was just called with, which makes it the authority on what is on
   * offer: the services it lists are the services that can be chosen, and a
   * quote listing none is a destination with nothing on offer rather than a
   * reason to fall back to a list of rates. A caller that renders its own
   * services before a quote arrives replaces them with these once it does.
   *
   * "In hand" is the whole of the guarantee, and it holds from the first render
   * after the arguments change rather than from the effect that follows it: an
   * answer gathered for another destination or another unit count reads as
   * `null` here, never as a current quote. So a caller may establish a charge,
   * a readiness or a submission on a non-null quote without checking anything
   * else - there is no moment at which this field describes a shipment other
   * than the one it was asked about.
   */
  readonly quote: ShippingQuoteResult | null;
  /** Whether a lookup is in flight; `false` while no destination has been given. */
  readonly isQuoting: boolean;
  /** Wording to show in place of the services, or `null` while the lookup is healthy. */
  readonly quoteError: string | null;
  /**
   * Why the shipment cannot be quoted as one consignment, or `null` when its
   * size is no obstacle - which includes a caller that described no shipment at
   * all.
   *
   * It is reported rather than asked about: no request is sent for a shipment
   * this size, because the endpoint refuses such a count, and the 400 it would
   * answer with carries nothing that would distinguish a cart too large from an
   * address that is wrong. A caller renders the size as the thing to change -
   * the count and the ceiling are both here for that wording - and holds back
   * whatever depends on a quote, since for this shipment none is coming.
   */
  readonly shipmentLimit: FreightShipmentLimit | null;
}

/**
 * Short, customer-facing wording for a failed lookup.
 *
 * Shipping is one panel of the checkout page, so the wording says what the
 * customer can do about it and nothing else. The endpoint's own detail, the
 * address asked about, the query it was asked with and the shape of the reply
 * are all of no use to a customer and are left out: a postal code is somebody's
 * address even when the lookup for it failed.
 *
 * @param code The reason the client or the route handler reported.
 * @param status HTTP status of the failed reply, or `0` when there was none.
 */
function freightQuoteNotice(code: StorefrontErrorCode, status: number): string {
  switch (code) {
    case 'NETWORK_FAILURE':
      return 'Shipping services cannot be quoted while the connection is down.';
    // The destination is the only thing this wording can name, and the only
    // thing it needs to: a lookup carries a postal code and a unit count, and
    // the count is checked against `MAX_SHIPMENT_UNITS` before anything is sent
    // - a shipment too large is reported as its own state and never reaches
    // this function - so a parameter the endpoint rejected is the address.
    case 'VALIDATION_FAILED':
      return 'Enter a complete destination postal code to see shipping services.';
    case 'NOT_FOUND':
      return 'No shipping service reaches that destination.';
    case 'MALFORMED_RESPONSE':
      return FREIGHT_QUOTE_UNAVAILABLE;
    default:
      return `Shipping services could not be quoted right now (HTTP ${String(status)}).`;
  }
}

/**
 * Asks what it costs to carry an order to `postalCode` and reports the answer.
 *
 * The picker renders straight from the returned {@link FreightQuoteState}: the
 * services once `quote` holds them - and only those, because a quote is the
 * store's answer about what it can sell to that destination - its waiting state
 * while `isQuoting`, the `quoteError` wording in place of both when a lookup
 * failed, and the `shipmentLimit` figures when the shipment is larger than one
 * consignment and no lookup was made. A failed lookup leaves the rest of
 * checkout alone - the order can still be reviewed and the address corrected -
 * and a later successful lookup clears the wording again.
 *
 * Nothing is asked until there is a destination to ask about. A `null`, blank
 * or half-typed code leaves the state exactly where it starts and sends no
 * request, so the panel costs nothing on a checkout page nobody has filled in
 * yet. The destination is taken as it is written and trimmed, and the lookup
 * follows that text: the same code typed again, or a re-render while the field
 * stands still, asks nothing further, and a genuinely different code asks once.
 *
 * A quote belongs to the one destination it was asked for, so a change of
 * destination clears the services on screen before the next lookup rather than
 * leaving prices for the previous address beside the new one. The lookup for
 * the address that was left behind is aborted at that moment rather than run to
 * the end and then ignored, so a field corrected two or three times does not
 * leave as many carrier lookups in flight, and no answer for a superseded
 * destination can reach state - not even to report having been cut off.
 *
 * The shipment is the second half of the question, and leaving it out is not a
 * smaller version of asking: freight is charged per piece as well as per
 * destination, so a lookup that names no unit count is answered for a shipment
 * of one unit - a figure that understates every larger order, and understates
 * it by more the larger the order is. `itemCount` is therefore what a caller
 * quoting a cart passes, and it is the cart's unit count, because that is the
 * figure `POST /api/checkout` rates the order's freight against. The lookup is
 * keyed on it as well as on the destination, so a quantity change re-quotes
 * exactly as a change of address does; a `null`, absent, non-finite or
 * non-positive count is treated as no shipment description at all and left to
 * the endpoint's own default.
 *
 * A count above {@link MAX_SHIPMENT_UNITS} is the one shipment this hook does
 * not ask about. More units than that are more than one shipment, which the
 * endpoint refuses rather than rates, so the count is neither brought down to
 * the ceiling nor dropped from the request - either would quote a shipment
 * nobody is sending - and no request is made at all. What comes back instead is
 * `shipmentLimit`, carrying the count and the ceiling, so the caller can say
 * which of the two has to change. Asking anyway would spend a carrier lookup on
 * a question already known to be refused and would collect a 400 indistinguishable
 * from a rejected address.
 *
 * @param postalCode Where the order is going, or `null` when nobody has said.
 * @param itemCount How many units the shipment carries, or `null`/omitted
 * where there is no shipment to describe yet.
 * @returns The quoted services, the in-flight flag, the failure wording and the
 * shipment-size obstacle, if the shipment has one.
 */
export function useFreightQuote(
  postalCode: string | null,
  itemCount?: number | null,
): FreightQuoteState {
  // The trimmed text is what the lookup is keyed on, so surrounding whitespace
  // a pasted or padded field carried does not read as a different destination.
  const destination = postalCode === null ? '' : postalCode.trim();

  // A whole number of units, or `0` for "no shipment described". Floored rather
  // than rounded, and guarded against a non-finite figure, so the key below is
  // always a plain integer and the request either carries a usable count or
  // carries none - never a fraction the endpoint would coerce.
  const units =
    itemCount === undefined || itemCount === null || !Number.isFinite(itemCount)
      ? 0
      : Math.max(0, Math.floor(itemCount));

  // The shipment's size as an obstacle, or `null` when it is not one. Derived
  // on every render rather than held in state: it is a statement about the
  // argument in hand, and state would let it describe a count the caller has
  // since changed. The effect below reads the same comparison, which is why no
  // request goes out for a shipment this reports on.
  const shipmentLimit: FreightShipmentLimit | null =
    units > MAX_SHIPMENT_UNITS ? { units, maxUnits: MAX_SHIPMENT_UNITS } : null;

  // The question the arguments in hand ask, and whether it is one this hook
  // will ask the store: a half-typed destination is a question nobody has
  // finished writing, and a shipment above the ceiling is one the endpoint
  // refuses. Both are computed here so that this render can say what it knows
  // without waiting for the effect below, and the effect repeats them from the
  // same two arguments rather than closing over these.
  const key = freightKeyOf(destination, units);
  const askable = destination.length >= MIN_DESTINATION_CODE_LENGTH && shipmentLimit === null;

  const [lookup, setLookup] = useState<FreightLookup>(() => ({
    key,
    quote: null,
    isQuoting: false,
    quoteError: null,
  }));

  useEffect(() => {
    // This lookup's own controller, aborted by the cleanup below. A carrier
    // lookup is one of the slower things checkout asks for, so a panel that has
    // gone away, or has moved on to another destination, cuts its lookup off
    // rather than leaving it to run to the end for an address nobody is
    // quoting any more. `signal.aborted` is then what each handler consults
    // before writing state - including on the rejection the abort itself
    // produces, which is this hook's own doing and never wording for a
    // customer.
    const controller = new AbortController();
    // Both halves of the question, written from the two arguments this effect
    // is keyed on, so the state it writes carries the question it answers and
    // the condition it was asked under is legible where it is applied. A
    // half-typed destination is a question nobody has finished writing; a
    // shipment above the ceiling is one the endpoint refuses.
    const asked = freightKeyOf(destination, units);
    const shouldQuote =
      destination.length >= MIN_DESTINATION_CODE_LENGTH && units <= MAX_SHIPMENT_UNITS;

    setLookup({ key: asked, quote: null, isQuoting: shouldQuote, quoteError: null });

    if (shouldQuote) {
      requestShippingQuote({
        postalCode: destination,
        // Sent only when there is a shipment to describe; otherwise the
        // parameter is dropped and the endpoint rates its default single unit.
        itemCount: units > 0 ? units : undefined,
        signal: controller.signal,
      })
        .then((result) => {
          if (controller.signal.aborted) {
            return;
          }
          setLookup({ key: asked, quote: result, isQuoting: false, quoteError: null });
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          setLookup({
            key: asked,
            quote: null,
            isQuoting: false,
            quoteError:
              cause instanceof StorefrontApiError
                ? freightQuoteNotice(cause.code, cause.status)
                : FREIGHT_QUOTE_UNAVAILABLE,
          });
        });
    }

    return () => {
      controller.abort();
    };
    // Both halves of the question, so a shipment that grew is re-quoted exactly
    // as a corrected address is: the services on screen are cleared, the lookup
    // for the previous shipment is aborted, and one lookup asks about what the
    // customer is actually sending now. Two integers, so a re-render while
    // neither has changed asks nothing further.
  }, [destination, units]);

  // An answer is returned only to the question it answers. The effect above
  // runs after this render, so the first render for a corrected address or a
  // changed cart still holds the previous lookup's state - and returning it
  // would price the new shipment with the old shipment's rates, publish a
  // charge for it and let an order be placed on it. Comparing the keys is what
  // closes that window: a settled answer to another question reads exactly as
  // "nothing known yet", with the in-flight flag set to whether the question in
  // hand is one this hook will ask at all, so a caller sees the lookup start in
  // the same render in which the arguments changed.
  const current = lookup.key === key;

  return {
    quote: current ? lookup.quote : null,
    isQuoting: current ? lookup.isQuoting : askable,
    quoteError: current ? lookup.quoteError : null,
    shipmentLimit,
  };
}
