'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { formatShippingEtaLabel } from '@/lib/format';

/**
 * Lumen Supply - the live dispatch countdown.
 *
 * Each warehouse hands the day's picked orders to the carriers at a fixed daily cut-off: an order
 * placed before it goes out the same day, and one placed after it waits for the next collection.
 * Buyers plan around that boundary, so the storefront prints the time left in the site header, on
 * every catalog card and in the cart totals. This provider owns that value: the countdown to the
 * next cut-off, whether the same day's collection is still reachable, and the transit estimate
 * that follows dispatch.
 *
 * Two deliberate constraints shape the code below.
 *
 * The countdown is a browser concern. The instant it counts from is read by the interval in
 * `ShippingEtaProvider` after the provider mounts - never while the markup is being produced -
 * so the text the server sent and the first text the browser shows agree. Until the first reading
 * arrives, `referenceIso` and `msUntilCutoff` are `null` and a consumer prints its own
 * placeholder, which is the same discipline `@/lib/format` follows by taking every reference
 * instant as an argument.
 *
 * The arithmetic is separate from the clock. Every function in this module is a pure function of
 * the epoch milliseconds it is handed, and the only clock reading in the file happens inside the
 * interval callback, so the same instant always yields the same countdown.
 *
 * The provider contributes no markup of its own: it publishes the value and returns the tree it
 * was given, unchanged.
 */

/** Milliseconds between countdown refreshes, which is how often the value below is republished. */
export const DISPATCH_ETA_TICK_MS: number = 250;

/**
 * Hour of the day, in UTC, at which the warehouses stop adding orders to the outbound run.
 *
 * One store-wide boundary rather than a per-warehouse schedule: the carriers collect from every
 * site on the same round, and the storefront quotes the promise a buyer can rely on everywhere.
 */
export const DISPATCH_CUTOFF_HOUR_UTC: number = 16;

/** Business days in transit quoted when a mount does not name a different figure. */
export const DEFAULT_TRANSIT_DAYS: number = 2;

/** Length of a UTC day. UTC has no daylight-saving shift, so every day is exactly this long. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The dispatch promise, as published on the context. */
export interface DispatchEta {
  /** Business days between dispatch and delivery. */
  readonly transitDays: number;
  /** Wording for {@link DispatchEta.transitDays}, for example `'Arrives in 2 days'`. */
  readonly etaLabel: string;
  /** The instant the countdown was last read at, or `null` before the first reading. */
  readonly referenceIso: string | null;
  /** Milliseconds left until the next cut-off, or `null` before the first reading. */
  readonly msUntilCutoff: number | null;
  /** Whether an order placed now still makes the same day's collection. */
  readonly beforeCutoff: boolean;
}

export interface ShippingEtaProviderProps {
  readonly children: ReactNode;
  /** Business days in transit to quote, for a section that ships on its own terms. */
  readonly transitDays?: number;
}

/**
 * Epoch milliseconds of the dispatch cut-off on the UTC day that `instantMs` falls in.
 *
 * The calendar fields are read back in UTC and handed to `Date.UTC`, so the boundary is the same
 * instant for every reader regardless of where their machine thinks it is.
 */
function cutoffOnSameDay(instantMs: number): number {
  const instant = new Date(instantMs);

  return Date.UTC(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate(),
    DISPATCH_CUTOFF_HOUR_UTC,
  );
}

/**
 * Milliseconds from `instantMs` until the next cut-off, or `null` when the argument is not a
 * usable reading of the clock.
 *
 * Once the day's collection has gone the countdown runs to the next one, which is exactly one UTC
 * day after this day's boundary.
 */
function msUntilNextCutoff(instantMs: number): number | null {
  if (!Number.isFinite(instantMs)) {
    return null;
  }

  const cutoff = cutoffOnSameDay(instantMs);

  return cutoff > instantMs ? cutoff - instantMs : cutoff + MS_PER_DAY - instantMs;
}

/** Whether an order placed at `instantMs` still makes that day's collection. */
function isBeforeTodaysCutoff(instantMs: number): boolean {
  return Number.isFinite(instantMs) && instantMs < cutoffOnSameDay(instantMs);
}

/**
 * The published dispatch promise, or `null` outside a `<ShippingEtaProvider>` - which is the case
 * {@link useDispatchEta} turns into an error.
 *
 * The context object is exported because a provider that holds the countdown as part of a larger
 * value reads it directly with `useContext` instead of through the accessor.
 */
export const DispatchEtaContext = createContext<DispatchEta | null>(null);

/**
 * Reads the dispatch promise.
 *
 * Throws when called outside `<ShippingEtaProvider>`. Returning a stand-in countdown would let a
 * card quote a cut-off the store never promised, which is worse than a loud failure the first
 * time the component is mounted in the wrong place.
 */
export function useDispatchEta(): DispatchEta {
  const eta = useContext(DispatchEtaContext);

  if (eta === null) {
    throw new Error(
      'useDispatchEta must be called from a component inside <ShippingEtaProvider>. ' +
        'The root layout mounts the provider around the whole application.',
    );
  }

  return eta;
}

/**
 * Mounts the dispatch countdown for the application. The root layout wraps the site chrome in it
 * once, outside the cart provider, because the cart totals quote the same promise the header does.
 */
export function ShippingEtaProvider({
  children,
  transitDays = DEFAULT_TRANSIT_DAYS,
}: ShippingEtaProviderProps): ReactElement {
  const [quotedAtIso, setQuotedAtIso] = useState<string | null>(null);

  // The countdown follows the buyer's own clock rather than a timestamp the server sent, so a page
  // left open on a product keeps counting down towards the collection instead of standing still at
  // the moment it was opened.
  useEffect(() => {
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      setQuotedAtIso(new Date().toISOString());
    }, DISPATCH_ETA_TICK_MS);

    return () => {
      clearInterval(timer);
    };
  }, []);

  const quotedAtMs = quotedAtIso === null ? null : Date.parse(quotedAtIso);
  const value: DispatchEta = {
    transitDays,
    etaLabel: formatShippingEtaLabel(transitDays),
    referenceIso: quotedAtIso,
    msUntilCutoff: quotedAtMs === null ? null : msUntilNextCutoff(quotedAtMs),
    beforeCutoff: quotedAtMs !== null && isBeforeTodaysCutoff(quotedAtMs),
  };

  return <DispatchEtaContext.Provider value={value}>{children}</DispatchEtaContext.Provider>;
}
