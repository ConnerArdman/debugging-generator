/**
 * The storefront's browser-side HTTP layer.
 *
 * Client components, providers and hooks reach the route handlers under `/api`
 * through the functions below rather than calling `fetch` themselves, so a new
 * endpoint belongs here as one more thin wrapper over {@link storefrontRequest}
 * written to the same rules. Stock, pricing and cart contents are read through
 * to the server on every call, and every path stays relative, so the module
 * has no origin of its own to resolve and is as safe to import from a server
 * component as from a client one.
 *
 * Which cart a request concerns is never stated here: the server resolves it
 * from the storefront's own cookie, which is what `credentials: 'same-origin'`
 * carries.
 *
 * A caller that can stop needing an answer before it arrives - a component that
 * unmounts, a field whose value has moved on - passes an `AbortSignal` and the
 * request is carried out under it, so the connection is released rather than
 * held to the end for nobody. The signal belongs to the caller: nothing here
 * creates one, and a call made without one behaves exactly as it always has.
 */

import type {
  CartItemDraft,
  CartLineQuantityDraft,
  CartMutation,
  CartView,
  CheckoutDraft,
  CheckoutResult,
  RecommendationItem,
  ShippingQuoteResult,
  StorefrontErrorBody,
  StorefrontErrorCode,
} from './types';

/* ---------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------- */

/**
 * The failure every function in this module throws; `message` is wording a
 * component may show a customer as it stands.
 *
 * A call the caller's own `AbortSignal` cut short is the one exception: it
 * rejects with that signal's abort reason - a `DOMException` named
 * `AbortError` unless the caller named another - and never with this error,
 * because the caller asking for an answer to stop is not a failure to report to
 * anybody. A caller that aborts therefore checks its signal before it treats a
 * rejection as something to show.
 */
export class StorefrontApiError extends Error {
  /** HTTP status of the failed response, or `0` when the request never reached the server. */
  readonly status: number;

  /** Machine-readable reason, as {@link StorefrontErrorCode} enumerates them. */
  readonly code: StorefrontErrorCode;

  constructor(message: string, options: { status: number; code: StorefrontErrorCode }) {
    super(message);
    this.name = 'StorefrontApiError';
    this.status = options.status;
    this.code = options.code;
  }
}

/* ---------------------------------------------------------------------------
 * Request plumbing
 * ------------------------------------------------------------------------- */

/**
 * The canonical query string for `query`, `''` when there is nothing to send.
 *
 * Entries holding `undefined` or `null` are dropped and the rest are ordered by
 * key, so two callers asking for the same data address one identical URL
 * whatever order they happened to write the parameters in.
 */
function storefrontQueryString(
  query: Record<string, string | number | null | undefined> | undefined,
): string {
  if (query === undefined) {
    return '';
  }
  const pairs = Object.entries(query)
    .filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null,
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (pairs.length === 0) {
    return '';
  }
  const params = new URLSearchParams();
  for (const [key, value] of pairs) {
    params.append(key, String(value));
  }
  return `?${params.toString()}`;
}

/**
 * The response body parsed as JSON, or `undefined` when it could not be read as
 * JSON at all — which a failing response is allowed to be and a succeeding one
 * is not.
 */
async function storefrontJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Whether `value` is the {@link StorefrontErrorBody} a route handler reports a failure with. */
function isStorefrontErrorBody(value: unknown): value is StorefrontErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const detail: unknown = value.error;
  if (typeof detail !== 'object' || detail === null) {
    return false;
  }
  return (
    'code' in detail &&
    'message' in detail &&
    typeof detail.code === 'string' &&
    typeof detail.message === 'string'
  );
}

/** The reason to report for a failing response whose body did not name one itself. */
function storefrontCodeForStatus(status: number): StorefrontErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'VALIDATION_FAILED';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CART_CONFLICT';
    default:
      return 'INTERNAL_ERROR';
  }
}

/**
 * Sends one request to a storefront route handler and returns its JSON body;
 * the single place in the storefront's client code that reaches the network.
 *
 * @param path Route-handler path, relative and beginning `/api/`.
 * @param options Method (`GET` unless stated), query parameters, JSON body and
 *   the caller's `signal`, under which the whole exchange - the request and the
 *   reading of its body - is carried out.
 * @throws StorefrontApiError when the request fails to reach the server, the
 *   response is not successful, or its body is not the JSON the caller expects.
 * @throws The abort reason of `options.signal` when that signal is aborted,
 *   which is how a caller tells its own cancellation apart from a failure.
 */
export async function storefrontRequest<T>(
  path: string,
  options?: {
    method?: 'GET' | 'POST';
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    signal?: AbortSignal | undefined;
  },
): Promise<T> {
  const url = `${path}${storefrontQueryString(options?.query)}`;
  const payload = options?.body;
  const signal = options?.signal;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const init: RequestInit = {
    method: options?.method ?? 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers,
  };
  if (payload !== undefined) {
    init.body = JSON.stringify(payload);
  }
  if (signal !== undefined) {
    init.signal = signal;
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    // A caller that has stopped waiting gets its own abort reason back, before
    // anything decides this was a connection the customer should hear about.
    signal?.throwIfAborted();
    throw new StorefrontApiError(
      'Lumen Supply could not be reached. Check your connection and try again.',
      { status: 0, code: 'NETWORK_FAILURE' },
    );
  }

  const body = await storefrontJsonBody(response);

  // A body whose stream was cut mid-read parses as nothing, which is the abort
  // and not a reply the store got wrong; the same check answers for it.
  signal?.throwIfAborted();

  if (!response.ok) {
    if (isStorefrontErrorBody(body)) {
      throw new StorefrontApiError(body.error.message, {
        status: response.status,
        code: body.error.code,
      });
    }
    throw new StorefrontApiError(
      `Lumen Supply could not complete that request (HTTP ${String(response.status)}).`,
      { status: response.status, code: storefrontCodeForStatus(response.status) },
    );
  }

  if (body === undefined) {
    throw new StorefrontApiError('Lumen Supply sent a reply this page could not read.', {
      status: response.status,
      code: 'MALFORMED_RESPONSE',
    });
  }

  // Each route handler validates the payload it answers with server-side, so the
  // parsed body is taken at the type the endpoint publishes for it.
  return body as T;
}

/* ---------------------------------------------------------------------------
 * Endpoints
 * ------------------------------------------------------------------------- */

/**
 * Products worth showing alongside another; `GET /api/recommendations`.
 *
 * `input.signal` is the caller's, and rejecting with its abort reason is how
 * this call reports having been cut short.
 */
export function loadRecommendations(input: {
  productId: string;
  limit: number;
  signal?: AbortSignal | undefined;
}): Promise<RecommendationItem[]> {
  return storefrontRequest<RecommendationItem[]>('/api/recommendations', {
    query: { productId: input.productId, limit: input.limit },
    signal: input.signal,
  });
}

/** The cart this browser is shopping with; `GET /api/cart`. */
export function loadCartContents(): Promise<CartView> {
  return storefrontRequest<CartView>('/api/cart');
}

/* ---------------------------------------------------------------------------
 * Cart mutations
 *
 * Every change to the cart is one `POST /api/cart/items` carrying a tagged
 * `CartMutation` body, and every one of them is answered with the cart the
 * server holds afterwards. The four wrappers below differ only in the body they
 * build: none of them computes a line total, a quantity or a subtotal, because
 * the response already carries the recomputed cart and a figure worked out here
 * would be a second opinion about what a shopper is charged.
 * ------------------------------------------------------------------------- */

/**
 * Applies one change to the cart and returns the cart that resulted.
 *
 * The single request every cart mutation goes through, so the endpoint, the
 * method and the response type are stated once. `mutation` is the discriminated
 * union the endpoint's schema parses, which is what makes an unsupported change
 * a compile error here rather than a rejected request at runtime.
 */
function changeCart(mutation: CartMutation): Promise<CartView> {
  return storefrontRequest<CartView>('/api/cart/items', { method: 'POST', body: mutation });
}

/**
 * Puts a quantity of one product into the cart; `POST /api/cart/items`.
 *
 * The units are added to whatever the line already holds, so pressing an
 * add-to-cart control twice leaves a line of two rather than a line of one.
 */
export function addCartItem(draft: CartItemDraft): Promise<CartView> {
  return changeCart({ operation: 'add', ...draft });
}

/**
 * Sets one line of the cart to an exact quantity; `POST /api/cart/items`.
 *
 * `draft.quantity` is the number of units the line holds afterwards rather than
 * a delta. Emptying a line is {@link removeCartItem}'s job: this call requires
 * at least one unit and the endpoint refuses a smaller number.
 */
export function setCartItemQuantity(draft: CartLineQuantityDraft): Promise<CartView> {
  return changeCart({ operation: 'set', ...draft });
}

/**
 * Takes one line, named by its `CartLine.id`, out of the cart;
 * `POST /api/cart/items`.
 */
export function removeCartItem(lineId: string): Promise<CartView> {
  return changeCart({ operation: 'remove', lineId });
}

/**
 * Takes every line out of the cart; `POST /api/cart/items`.
 *
 * The cart itself survives — a shopper who empties their cart still has one to
 * shop with — so the response is the same `CartView`, holding no lines.
 */
export function clearCartContents(): Promise<CartView> {
  return changeCart({ operation: 'empty' });
}

/** Turns the cart into an order and pays for it; `POST /api/checkout`. */
export function submitCheckout(draft: CheckoutDraft): Promise<CheckoutResult> {
  return storefrontRequest<CheckoutResult>('/api/checkout', { method: 'POST', body: draft });
}

/**
 * The shipping services offered to a destination; `GET /api/shipping/quote`.
 *
 * `input.signal` is the caller's, and rejecting with its abort reason is how
 * this call reports having been cut short - a lookup for a destination the
 * customer has since corrected costs nothing after that point.
 */
export function requestShippingQuote(input: {
  postalCode: string;
  signal?: AbortSignal | undefined;
}): Promise<ShippingQuoteResult> {
  return storefrontRequest<ShippingQuoteResult>('/api/shipping/quote', {
    query: { postalCode: input.postalCode },
    signal: input.signal,
  });
}
