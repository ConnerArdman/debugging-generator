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

/** Everything a shipping picker needs to render itself. */
export interface FreightQuoteState {
  /**
   * The services quoted to the destination that was asked about, or `null`
   * when none has been: before a destination is given, while the first lookup
   * for a new one is in flight, and after a failed lookup.
   */
  readonly quote: ShippingQuoteResult | null;
  /** Whether a lookup is in flight; `false` while no destination has been given. */
  readonly isQuoting: boolean;
  /** Wording to show in place of the services, or `null` while the lookup is healthy. */
  readonly quoteError: string | null;
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
 * services once `quote` holds them, its waiting state while `isQuoting`, and
 * the `quoteError` wording in place of both when a lookup failed. A failed
 * lookup leaves the rest of checkout alone - the order can still be reviewed
 * and the address corrected - and a later successful lookup clears the wording
 * again.
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
 * @param postalCode Where the order is going, or `null` when nobody has said.
 * @returns The quoted services, the in-flight flag and the failure wording.
 */
export function useFreightQuote(postalCode: string | null): FreightQuoteState {
  // The trimmed text is what the lookup is keyed on, so surrounding whitespace
  // a pasted or padded field carried does not read as a different destination.
  const destination = postalCode === null ? '' : postalCode.trim();

  const [quote, setQuote] = useState<ShippingQuoteResult | null>(null);
  const [isQuoting, setIsQuoting] = useState<boolean>(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

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
    const shouldQuote = destination.length >= MIN_DESTINATION_CODE_LENGTH;

    setQuote(null);
    setQuoteError(null);
    setIsQuoting(shouldQuote);

    if (shouldQuote) {
      requestShippingQuote({ postalCode: destination, signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) {
            return;
          }
          setQuote(result);
          setIsQuoting(false);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          setQuoteError(
            cause instanceof StorefrontApiError
              ? freightQuoteNotice(cause.code, cause.status)
              : FREIGHT_QUOTE_UNAVAILABLE,
          );
          setIsQuoting(false);
        });
    }

    return () => {
      controller.abort();
    };
  }, [destination]);

  return { quote, isQuoting, quoteError };
}
