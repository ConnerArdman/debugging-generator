/**
 * Where this application is allowed to call itself.
 *
 * Several of the storefront's surfaces reach the store over HTTP rather than in
 * process. The carrier and the payment processor are mounted under `/api/mock`
 * and are called the way a third-party service would be, and each is handed the
 * scheme and authority to reach them at by the route handler that is answering
 * the request. The server-rendered pages do the same thing for their own reads:
 * the catalog, a product, the order history and the inventory dashboard each
 * ask one of this application's endpoints for its payload, so each of them also
 * needs the authority this store answers on. That authority comes from the
 * request, and a request's authority is chosen by whoever made it: an authority
 * naming somewhere else turns a call the store makes to itself into a call to
 * that somewhere else, carrying a destination address and an amount to charge
 * with it.
 *
 * So an authority is checked before it is used rather than trusted because it
 * arrived, and this module is the whole of that rule. A caller that fails the
 * check is refused rather than redirected to a default. There are two entry
 * points, and the difference between them is where the authority comes from:
 *
 *   - {@link trusted} judges an authority a caller already holds, which is what
 *     a route handler reads off `request.url` before handing it to the carrier
 *     or the payment processor.
 *   - {@link storefrontOrigin} *answers* with one, for a page rendering on the
 *     server - the one context with no request object to read. It is built from
 *     configuration and from the port this process bound, and from no header at
 *     all, so nothing a client sends can choose the address a page's own read is
 *     sent to.
 *
 * The rule has two settings, and the first is the one a deployment should use.
 *
 * 1. **`APP_ORIGIN` names the store.** Set it to the scheme, host and port the
 *    storefront is served on, and that is the only authority a self-addressed
 *    call may be made to. Nothing about the request can widen it: another
 *    machine, another port on this one and another scheme are all refused. The
 *    one equivalence is between the three names for this machine, and only when
 *    the variable itself names one of them - `localhost`, `127.0.0.1` and
 *    `[::1]` on the pinned port are one address, which is what lets the
 *    variable be written the way a developer thinks of it while a server
 *    reports whichever name it prefers. The port and the scheme are never
 *    equivalent to anything.
 * 2. **Unset, only this machine.** A development checkout that has not been
 *    told where it is served falls back to this machine, so `pnpm demo:dev`
 *    works on whichever port it was started on. The two entry points read that
 *    fallback differently, and deliberately: a page's own read is built against
 *    the loopback address on the port *this process bound*, which is one exact
 *    address, while an authority handed in by a route handler is judged by
 *    family - `localhost`, `127.0.0.1` and `[::1]` over `http`, with no
 *    credentials - because the handler is reporting the address it was itself
 *    reached at and the port it names is the one the client connected to. The
 *    second is the wider of the two, which is one more reason a deployment that
 *    shares its machine with anything else sets `APP_ORIGIN`.
 *
 * A variable that is set to something which is not an authority is a mistake
 * rather than an absence: both entry points refuse it outright instead of
 * falling back to the local rule, so a typo cannot quietly widen a deployment
 * that had pinned its address.
 *
 * The variable is read here and nowhere else, which is what keeps every calling
 * module free of configuration: a service is handed an authority by the route
 * handler answering the request and asks whether it is the store's, and a page
 * asks this module for the one it is being served on.
 */

import { StorefrontError } from '@/server/errors';

/** The authorities that are this machine, written the way a URL carries them. */
const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The loopback address a self-addressed request is built against by default. */
const LOOPBACK = '127.0.0.1';

/** The range a TCP port number occupies. */
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * What a page is told when the address this store answers on cannot be
 * established at all.
 *
 * It names no value, because a page's failure copy is read by a visitor and a
 * configuration value is not theirs to see. The page that catches this renders
 * its own fixed notice.
 */
const UNKNOWN_ORIGIN = 'The storefront could not establish the address it is being served on.';

/** What a page is told when `APP_ORIGIN` is set to something that is not an authority. */
const MISCONFIGURED_ORIGIN =
  'The storefront is configured with an address it cannot be reached at.';

/**
 * `APP_ORIGIN` as the deployment wrote it, or `undefined` when it says nothing.
 *
 * A variable set to whitespace is treated as unset, which is what an empty
 * assignment in an `.env` file leaves behind. Everything else is returned for
 * the caller to parse and judge, so "not configured" and "configured wrongly"
 * stay two different situations: the first has a documented local default, and
 * the second is a mistake nothing should paper over.
 */
function declared(): string | undefined {
  const value = process.env.APP_ORIGIN;

  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value.trim();
}

/**
 * The port this process is listening on, or `null` when it cannot be read.
 *
 * `next dev` and `next start` both publish the port they actually bound - after
 * the fallback they apply when the requested one is taken - as `PORT`, so this
 * is the server's own fact about itself rather than anything a request carries.
 * A value that is not a port number reads as absent, and the caller fails
 * rather than guessing a port.
 */
function port(): number | null {
  const value = Number(process.env.PORT);

  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    return null;
  }

  return value;
}

/**
 * `value` as a URL, or `null` when it is absent, blank or not one. Returning
 * rather than throwing keeps each caller below a single expression.
 */
function parse(value: string | undefined): URL | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }

  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/**
 * Whether `url` is an authority at all: web scheme, no credentials, and nothing
 * after the authority. A user and password would travel with every
 * self-addressed request built against it, and a path, query or fragment means
 * the value is an address rather than the authority one is built from.
 */
function usable(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  );
}

/**
 * Whether `origin` is the authority this application may call itself on.
 *
 * @param origin The scheme and authority of a request being served.
 * @returns `true` when a self-addressed call may be built against it - it is
 * the authority `APP_ORIGIN` names, by scheme and port exactly and by host
 * allowing for this machine's several names, or, where that variable is not
 * set, this machine over `http`.
 */
export function trusted(origin: string): boolean {
  const url = parse(origin);

  if (url === null || !usable(url)) {
    return false;
  }

  const configured = declared();

  if (configured !== undefined) {
    const store = parse(configured);

    // Configured, but not with an authority. Nothing is trusted: falling back to
    // the local rule here would quietly widen a deployment that had tried to
    // narrow itself, and a typo in a variable must not be the thing that does
    // that.
    if (store === null || !usable(store)) {
      return false;
    }

    if (url.protocol !== store.protocol || url.port !== store.port) {
      return false;
    }

    return (
      url.hostname === store.hostname || (HOSTS.has(store.hostname) && HOSTS.has(url.hostname))
    );
  }

  return url.protocol === 'http:' && HOSTS.has(url.hostname);
}

/**
 * The address this store may address itself at, for a page rendering on the
 * server.
 *
 * NOTHING A REQUEST CARRIES DECIDES THIS
 * A page is given no request object, and the headers it could reach for -
 * `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` - are all written by whoever
 * made the request. Reading them would let a client choose the address one of
 * this application's own reads is sent to: on a developer's machine that is a
 * request to whichever service happens to be listening on the port the client
 * named, with the response or its timing visible in what the page renders. So
 * this function reads no header at all, and there are exactly two sources it
 * does read, in this order:
 *
 * 1. **`APP_ORIGIN`.** The scheme and authority the storefront is served on.
 *    This is what a deployment behind a proxy, on a port other than the one the
 *    process bound, or on `https`, must set - it is the only way to state any of
 *    those, now that no forwarded header is believed.
 * 2. **The port this process bound.** `next dev` and `next start` publish it as
 *    `PORT`, so a development checkout works on whichever port it was started
 *    on without configuration, and the address is `http://127.0.0.1:<port>`.
 *
 * FAILING CLOSED
 * An `APP_ORIGIN` that is not an authority is a mistake, not an absence: it
 * raises rather than falling back to the local rule, because a deployment that
 * tried to pin its address must not end up with the wider one through a typo.
 * A process whose port cannot be read raises too. Either way a page renders its
 * own notice, which is the same thing it renders for an endpoint that failed -
 * from a reader's side both are a surface that cannot show its data.
 *
 * @returns The scheme and authority a self-addressed request may be built
 * against, such as `http://127.0.0.1:3000`.
 * @throws StorefrontError `INTERNAL_ERROR` when `APP_ORIGIN` is set to
 * something that is not an authority, or when it is unset and this process's
 * port cannot be read. Neither message carries a configuration value.
 */
export function storefrontOrigin(): string {
  const configured = declared();

  if (configured !== undefined) {
    const store = parse(configured);

    if (store === null || !usable(store)) {
      throw new StorefrontError('INTERNAL_ERROR', 500, MISCONFIGURED_ORIGIN);
    }

    // `URL.origin` rather than the string as written, so a value carrying a
    // trailing slash resolves to the same address as one without it.
    return store.origin;
  }

  const bound = port();

  if (bound === null) {
    throw new StorefrontError('INTERNAL_ERROR', 500, UNKNOWN_ORIGIN);
  }

  return `http://${LOOPBACK}:${String(bound)}`;
}
