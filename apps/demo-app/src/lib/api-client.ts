/**
 * The storefront's HTTP layer.
 *
 * Client components, providers and hooks reach the route handlers under `/api`
 * through the functions below rather than calling `fetch` themselves, and so do
 * the server-rendered pages that read their own surface's endpoint, so a new
 * endpoint belongs here as one more thin wrapper over {@link storefrontRequest}
 * written to the same rules. Stock, pricing and cart contents are read through
 * to the server on every call.
 *
 * Every path written here is relative, and this module resolves no origin of
 * its own: it reads no environment variable, no `window.location` and no
 * header. A caller that has no relative base to resolve against - a
 * server-rendered page, which runs where a bare `/api/...` names nothing -
 * hands in the scheme and authority to prefix the path with, and the only place
 * that authority is established and checked is `@/server/origin`. That keeps
 * one HTTP layer for the whole storefront while leaving the question "which
 * server is this?" where it is answered: a browser answers it by construction,
 * and a server render answers it from its own configuration and the port it
 * bound, never from a header a client wrote.
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
 *
 * The two `/api/mock` handlers are the only endpoints of this application with
 * no wrapper here, and that is deliberate: the carrier and the payment
 * processor are called server-to-server by `@/server/services`, the way a
 * third-party dependency would be, so a browser call to either would be wrong.
 * Every other endpoint is reached through this module, by the browser or by the
 * page that renders the surface it belongs to.
 */

import type {
  CartItemDraft,
  CartLineQuantityDraft,
  CartMutation,
  CartView,
  CatalogQuery,
  CheckoutDraft,
  CheckoutResult,
  InventorySummary,
  MovementType,
  OrderStatus,
  OrderSummary,
  PagedList,
  ProductDetail,
  ProductSummary,
  RecommendationItem,
  ShippingQuoteResult,
  StockState,
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
  /**
   * HTTP status of the failed response, or `0` when no response arrived at all.
   *
   * `0` says nothing about whether the request reached the server: a request
   * that never left this browser and one the server carried out before the
   * connection dropped both end without a response.
   */
  readonly status: number;

  /** Machine-readable reason, as {@link StorefrontErrorCode} enumerates them. */
  readonly code: StorefrontErrorCode;

  /**
   * Whether `code` is the reason the server named, rather than one derived here
   * from the status or from the request having failed outright.
   *
   * A derived reason is a guess about a request whose answer never arrived
   * intelligibly, and for a request that changes something - an order, a cart -
   * the difference matters: the server's own reason states what happened, while
   * a guess cannot rule out that the request was carried out and only its reply
   * was lost. A caller whose recovery advice depends on that reads this before
   * it treats `code` as a fact.
   *
   * `NETWORK_FAILURE` is always unreported, and it is the plainest case of a
   * guess: `fetch` rejects alike for a request that never went out and for one
   * the server received and carried out before the connection was lost, and
   * nothing this browser can observe afterwards - its connection state included,
   * which may have changed in between - tells the two apart. A caller that needs
   * to know nothing was sent decides that before it sends, not from the
   * rejection.
   */
  readonly reported: boolean;

  constructor(
    message: string,
    options: {
      status: number;
      code: StorefrontErrorCode;
      reported?: boolean;
    },
  ) {
    super(message);
    this.name = 'StorefrontApiError';
    this.status = options.status;
    this.code = options.code;
    this.reported = options.reported ?? false;
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
 * @param options Method (`GET` unless stated), query parameters, JSON body, the
 *   caller's `signal`, under which the whole exchange - the request and the
 *   reading of its body - is carried out, and `origin`: the scheme and
 *   authority to resolve `path` against for a caller with no relative base of
 *   its own. A browser omits it and the request stays same-origin by
 *   construction; a server render supplies the authority `@/server/origin`
 *   answers with, which is configuration and this process's own port rather
 *   than anything a request carried. Nothing about the authority is decided in
 *   this module.
 * @throws StorefrontApiError when no response arrives, the response is not
 *   successful, or its body is not the JSON the caller expects.
 * @throws The abort reason of `options.signal` when that signal is aborted,
 *   which is how a caller tells its own cancellation apart from a failure.
 */
export async function storefrontRequest<T>(
  path: string,
  options?: {
    method?: 'GET' | 'POST';
    query?: Record<string, string | number | null | undefined>;
    body?: unknown;
    signal?: AbortSignal | undefined;
    origin?: string | undefined;
  },
): Promise<T> {
  const url = `${options?.origin ?? ''}${path}${storefrontQueryString(options?.query)}`;
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
    // Unreported, and deliberately silent about whether the request went out:
    // a rejection looks the same whether nothing was sent or the server carried
    // the request out and only the reply was lost, and the browser's connection
    // state now is not its state when the bytes left. See
    // `StorefrontApiError.reported`.
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
        reported: true,
      });
    }
    // The store failed without saying why in the one shape that says why, so
    // the reason below is this module's reading of the status rather than the
    // store's own: it is left unreported, which is what stops a caller treating
    // it as a statement about what the request did.
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
 * Listing and detail reads
 *
 * The four endpoints behind the storefront's server-rendered surfaces: the
 * catalog, one product, the order history and the inventory dashboard. Each
 * page parses its own address, hands the parsed values to one of these
 * functions and renders the payload that comes back, so the surface a reader
 * sees and the endpoint an outside caller reaches answer the same question
 * through the same code.
 *
 * Every one of them takes `origin`, because their callers render on the server
 * where a bare `/api/...` names nothing. It is a parameter rather than
 * something resolved here: `@/server/origin` is the single place the
 * storefront's own address is established, and a page passes in what it
 * answers.
 * ------------------------------------------------------------------------- */

/**
 * One page of the catalog; `GET /api/products`.
 *
 * Every member of `input.query` is optional, and one that is absent constrains
 * nothing rather than constraining on nothing - the endpoint's own schema owns
 * the defaults, so `{ query: {} }` is a complete request for the first page in
 * the catalog's own order.
 */
export function loadCatalogPage(input: {
  query: CatalogQuery;
  origin?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<PagedList<ProductSummary>> {
  return storefrontRequest<PagedList<ProductSummary>>('/api/products', {
    query: {
      categorySlug: input.query.categorySlug,
      search: input.query.search,
      sort: input.query.sort,
      page: input.query.page,
      pageSize: input.query.pageSize,
    },
    signal: input.signal,
    origin: input.origin,
  });
}

/**
 * One product, by the slug its address carries; `GET /api/products/[slug]`.
 *
 * The slug is encoded into the path, so a value carrying a separator addresses
 * one segment rather than a deeper path. A slug no product owns is answered
 * with a `NOT_FOUND` {@link StorefrontApiError}, which is what lets a page
 * answer the reader with its own 404.
 */
export function loadProductDetail(input: {
  slug: string;
  origin?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<ProductDetail> {
  return storefrontRequest<ProductDetail>(`/api/products/${encodeURIComponent(input.slug)}`, {
    signal: input.signal,
    origin: input.origin,
  });
}

/**
 * One page of an account's orders, most recently placed first;
 * `GET /api/orders`.
 *
 * The account is named explicitly because an order belongs to exactly one and a
 * listing with no account named would be every account's orders. The page
 * window and the status filter are optional and default at the endpoint.
 */
export function loadOrderHistory(input: {
  customerId: string;
  status?: OrderStatus | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
  origin?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<PagedList<OrderSummary>> {
  return storefrontRequest<PagedList<OrderSummary>>('/api/orders', {
    query: {
      customerId: input.customerId,
      status: input.status,
      page: input.page,
      pageSize: input.pageSize,
    },
    signal: input.signal,
    origin: input.origin,
  });
}

/**
 * The inventory dashboard's figures, stocking locations, page of stock lines
 * and low-stock lines; `GET /api/inventory/summary`.
 *
 * A filter that is not applied may be passed as `null` - which is how the
 * dashboard's parsed query carries "every location", "any selling state" and
 * "any kind of recorded change" - and is dropped from the request rather than
 * sent as the word `null`.
 */
export function loadInventorySummary(input: {
  warehouseId?: string | null | undefined;
  threshold?: number | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
  state?: StockState | null | undefined;
  movement?: MovementType | null | undefined;
  origin?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<InventorySummary> {
  return storefrontRequest<InventorySummary>('/api/inventory/summary', {
    query: {
      warehouseId: input.warehouseId,
      threshold: input.threshold,
      page: input.page,
      pageSize: input.pageSize,
      state: input.state,
      movement: input.movement,
    },
    signal: input.signal,
    origin: input.origin,
  });
}

/* ---------------------------------------------------------------------------
 * Cart, checkout and suggestion reads
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

/**
 * The cart this browser is shopping with; `GET /api/cart`.
 *
 * `input.signal` is the caller's, and rejecting with its abort reason is how
 * this call reports having been cut short - the read a provider starts as it
 * mounts is the case that needs it, because a cart nobody is left to show is a
 * connection worth releasing. A call made without a signal reads the cart
 * exactly as it always has.
 */
export function loadCartContents(input?: { signal?: AbortSignal | undefined }): Promise<CartView> {
  return storefrontRequest<CartView>('/api/cart', { signal: input?.signal });
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

/**
 * Turns the cart into an order and pays for it; `POST /api/checkout`.
 *
 * `input.draft.idempotencyKey` is what makes sending this twice safe: the
 * endpoint answers a submission whose name it has already seen with the order
 * that attempt placed - `result.outcome` says which of the two it is - so a
 * caller whose reply was lost resolves the attempt by sending the exact draft it
 * recorded, under the same key, rather than by deciding for itself whether an
 * order exists. That holds after a reload too: the endpoint answers from the
 * store's own record of the key, and the draft the caller kept is what lets the
 * repeat pass the same checks the first submission passed, and complete the
 * order under that key if the store never received it. A caller that mints a
 * new name is asking for a new order.
 *
 * A rejection with `NETWORK_FAILURE` is no exception: it does not say the
 * request never arrived - see `StorefrontApiError.reported` - so it leaves the
 * attempt exactly as unresolved as a lost reply does.
 *
 * `input.signal` is the caller's, on the same terms as every other wrapper
 * here - a component that goes away releases the connection rather than
 * holding it open for nobody - but what an abort means is different for this
 * endpoint than for a read, and a caller has to know it. Aborting stops this
 * browser waiting for the reply. It does not stop the order: the route handler
 * reads no signal and the work it has started - the stock reservation, the
 * carrier, the payment - runs to completion, so an aborted submission may
 * still have placed an order and taken a payment for it. A caller therefore
 * treats its own abort as "the outcome of this attempt is unknown" and never
 * as "no order exists", and resolves it later by sending the same
 * `idempotencyKey` again, which the endpoint answers with the order it already
 * holds.
 */
export function submitCheckout(input: {
  draft: CheckoutDraft;
  signal?: AbortSignal | undefined;
}): Promise<CheckoutResult> {
  return storefrontRequest<CheckoutResult>('/api/checkout', {
    method: 'POST',
    body: input.draft,
    signal: input.signal,
  });
}

/**
 * The shipping services offered to a destination; `GET /api/shipping/quote`.
 *
 * `input.signal` is the caller's, and rejecting with its abort reason is how
 * this call reports having been cut short - a lookup for a destination the
 * customer has since corrected costs nothing after that point.
 *
 * `input.country` is the other half of the destination, and it changes the
 * answer: freight is rated to a place, and a postal code names a place only
 * within a country - the same five digits are one town in the United States and
 * another in Mexico, at different distances from this catalog's warehouses. A
 * caller quoting a buyer's address therefore sends the country that buyer
 * chose, because that is the destination `POST /api/checkout` will rate the
 * order's freight to, and a quote taken for a different country is a rate the
 * order would not be charged. Omitting it quotes the store's own country, which
 * is what a caller naming a domestic postal code alone is asking about. The
 * endpoint also pairs the two: a postal code that is not a complete one for the
 * country sent with it is answered 400 rather than rated, so a caller checks
 * the destination before it asks - `useFreightQuote` in `@/hooks/useShippingEta`
 * does exactly that, against the one rule `@/lib/destination` publishes.
 *
 * `input.itemCount` is how many units the shipment is made of, and naming it
 * matters to what comes back: the freight a service charges is a function of
 * the shipment as well as of the destination, so a caller that omits it is
 * quoted the endpoint's default of a single unit - a figure that is correct for
 * nothing but a one-unit order. A caller quoting a cart therefore passes the
 * cart's unit count, which is the same figure the checkout request rates the
 * order's freight against, so the rate a customer is shown is the rate their
 * order is charged. Omit it only where there is no shipment to describe yet.
 *
 * It is also bounded, and the bound belongs to the caller as much as to the
 * endpoint: more than `MAX_SHIPMENT_UNITS` units - the figure `./types`
 * publishes - is more than one shipment, and the endpoint refuses such a count
 * with 400 rather than rating part of it. This module sends what it is given
 * and states no second opinion about it, so a caller quoting a cart compares
 * the count with that ceiling before it calls: `useFreightQuote` in
 * `@/hooks/useShippingEta` does exactly that, and reports the cart's size to
 * checkout instead of asking a question already known to be refused.
 */
export function requestShippingQuote(input: {
  postalCode: string;
  country?: string | undefined;
  itemCount?: number | undefined;
  signal?: AbortSignal | undefined;
}): Promise<ShippingQuoteResult> {
  return storefrontRequest<ShippingQuoteResult>('/api/shipping/quote', {
    // `storefrontQueryString` drops an absent `itemCount` or `country` rather
    // than sending an empty parameter, so a caller with no shipment to describe
    // addresses exactly the URL it addressed before those parameters existed.
    query: {
      postalCode: input.postalCode,
      country: input.country,
      itemCount: input.itemCount,
    },
    signal: input.signal,
  });
}
