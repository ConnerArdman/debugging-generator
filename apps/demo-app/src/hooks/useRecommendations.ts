'use client';

/**
 * Lumen Supply - the suggestions shown alongside a product.
 *
 * `GET /api/recommendations` ranks a handful of products worth putting next to
 * the one a buyer is looking at, and this hook is how the storefront reads that
 * ranking: a rail states the product and how many tiles it has room for, and
 * gets back the list, whether it is still waiting, and wording to show instead
 * if the endpoint could not answer.
 *
 * Nothing is held between mounts. Suggestions depend on live stock and on the
 * price rules in force, both of which the server is the only authority on, so a
 * mounted rail reads them from the endpoint rather than from anything this
 * module remembers. The request itself belongs to `@/lib/api-client`, which owns
 * every URL the storefront addresses.
 */

import { useEffect, useState } from 'react';

import { StorefrontApiError, loadRecommendations } from '@/lib/api-client';
import type { RecommendationItem, StorefrontErrorCode } from '@/lib/types';

/**
 * How many suggestions a rail asks for.
 *
 * This is the size the storefront's rails are laid out for, and the value a
 * call site should pass as {@link RecommendationsOptions.limit} unless it has a
 * reason of its own to differ: every place the rail appears asking for the same
 * number keeps the suggestions a buyer sees consistent across the page.
 */
export const RECOMMENDED_ITEM_LIMIT: number = 4;

/** Which product the suggestions accompany, and how many of them to ask for. */
export interface RecommendationsOptions {
  /** The product on screen, as {@link RecommendationItem.productId} identifies one. */
  readonly productId: string;
  /** Number of suggestions to request; {@link RECOMMENDED_ITEM_LIMIT} is the rail's size. */
  readonly limit: number;
}

/** Everything a rail needs to render itself. */
export interface RecommendationsFeed {
  /**
   * The suggestions in the order the endpoint ranked them: highest first, and
   * empty both before the first reply and after a failure.
   */
  readonly items: readonly RecommendationItem[];
  /** True until the first reply settles, however it settles. */
  readonly isLoading: boolean;
  /** Wording to show in place of the tiles, or `null` while the feed is healthy. */
  readonly error: string | null;
}

/**
 * The one empty list every empty feed is served with, so a rail that has
 * nothing to show is handed the same array each time rather than a new one.
 */
const NO_RECOMMENDATIONS: readonly RecommendationItem[] = Object.freeze([]);

/** Wording for a failure that carried no reason this module recognises. */
const RECOMMENDATIONS_UNAVAILABLE = 'Suggestions are unavailable right now.';

/**
 * Whether two answers name the same products in the same order.
 *
 * Ranking is what changes between answers, and the ids in order are what the
 * rail renders from, so comparing the length and then the ids is enough to know
 * that a fresh answer would put exactly the same tiles on screen.
 *
 * @param current The list the rail is showing.
 * @param incoming The list the endpoint just answered with.
 */
function sameRecommendations(
  current: readonly RecommendationItem[],
  incoming: readonly RecommendationItem[],
): boolean {
  if (current.length !== incoming.length) {
    return false;
  }
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]?.productId !== incoming[index]?.productId) {
      return false;
    }
  }
  return true;
}

/**
 * Short, customer-facing wording for a failed read.
 *
 * Suggestions are an aside on every page that shows them, so the wording says
 * what the buyer can conclude - that this one strip of the page has nothing to
 * show - and never why: an endpoint's own detail, the URL asked for and the
 * shape of the reply are all of no use to a buyer and are left out.
 *
 * @param code The reason the client or the route handler reported.
 * @param status HTTP status of the failed reply, or `0` when there was none.
 */
function recommendationNotice(code: StorefrontErrorCode, status: number): string {
  switch (code) {
    case 'NETWORK_FAILURE':
      return 'Suggestions are unavailable while the connection is down.';
    case 'NOT_FOUND':
      return 'There are no suggestions for this product yet.';
    case 'VALIDATION_FAILED':
    case 'MALFORMED_RESPONSE':
      return RECOMMENDATIONS_UNAVAILABLE;
    default:
      return `Suggestions are unavailable right now (HTTP ${String(status)}).`;
  }
}

/**
 * Reads the suggestions for `options.productId` and reports them as a feed.
 *
 * The rail renders straight from the returned {@link RecommendationsFeed}:
 * tiles while `items` has any, its skeleton while `isLoading`, and the `error`
 * wording in place of both when a read failed. A failed read leaves the rest of
 * the page alone - `items` goes back to empty and the page it decorates keeps
 * working - and a later successful read clears the wording again.
 *
 * `isLoading` describes the first read only. It is true from the first render
 * until that read settles and false from then on, so a rail already showing
 * tiles keeps showing them while a further read is in flight instead of
 * flashing its skeleton back over them. A read that answers with the same
 * products in the same order leaves the feed exactly as it stands, ids
 * included.
 *
 * A read whose answer the rail can no longer use - it has unmounted, or the
 * product it accompanies has changed - is abandoned rather than merely
 * ignored: the request is aborted, so nothing is left occupying a connection
 * on the rail's behalf, and neither the answer nor the abort reaches the state
 * a later read owns.
 *
 * @param options The product to suggest against and the number of tiles.
 * @returns The suggestions, the first-read flag and the failure wording.
 */
export function useRecommendations(options: RecommendationsOptions): RecommendationsFeed {
  const [items, setItems] = useState<readonly RecommendationItem[]>(NO_RECOMMENDATIONS);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // This read's own controller, aborted by the cleanup below. It settles two
    // questions at once: the read is let go of on the network rather than left
    // to run for a rail that has gone away or has moved on to another product,
    // and `signal.aborted` is then what both handlers consult before writing
    // state the page is no longer waiting for - including the rejection the
    // abort itself produces, which is this hook's own doing and nothing to show
    // a buyer.
    const controller = new AbortController();

    loadRecommendations({
      productId: options.productId,
      limit: options.limit,
      signal: controller.signal,
    })
      .then((rows) => {
        if (controller.signal.aborted) {
          return;
        }
        setItems((current) => (sameRecommendations(current, rows) ? current : rows));
        setError((current) => (current === null ? current : null));
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        const notice =
          cause instanceof StorefrontApiError
            ? recommendationNotice(cause.code, cause.status)
            : RECOMMENDATIONS_UNAVAILABLE;
        setItems((current) => (current.length === 0 ? current : NO_RECOMMENDATIONS));
        setError((current) => (current === notice ? current : notice));
        setIsLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [options]);

  return { items, isLoading, error };
}
