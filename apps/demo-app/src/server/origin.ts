/**
 * Where this application is allowed to call itself.
 *
 * Two of the storefront's server modules reach the store over HTTP rather than
 * in process - the carrier and the payment processor are mounted under
 * `/api/mock` and are called the way a third-party service would be - and both
 * are handed the scheme and authority to reach them at by the route handler
 * that is answering the request. That authority comes from the request, and a
 * request's authority is chosen by whoever made it: an authority naming
 * somewhere else turns a call the store makes to itself into a call to that
 * somewhere else, carrying a destination address and an amount to charge with
 * it.
 *
 * So an authority is checked before it is used rather than trusted because it
 * arrived, and this module is the whole of that rule. It is a check and not a
 * source: it never builds the address anything is sent to, and a caller that
 * fails the check is refused rather than redirected to a default.
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
 * 2. **Unset, only this machine over HTTP.** A development checkout that has
 *    not been told where it is served accepts `localhost`, `127.0.0.1` and
 *    `[::1]`, over `http` and with no credentials, so `pnpm demo:dev` works on
 *    whichever port it was started on. That is a narrower rule than trusting
 *    the request, and a wider one than setting `APP_ORIGIN`: it treats any
 *    listener on this machine as possibly being the store, so a deployment that
 *    shares its machine with anything else sets `APP_ORIGIN`.
 *
 * The variable is read here and nowhere else, which is what keeps the two
 * calling modules free of configuration: they are handed an authority by their
 * caller and ask this module whether it is the store's.
 */

/** The authorities that are this machine, written the way a URL carries them. */
const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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

  const store = parse(process.env.APP_ORIGIN);

  if (store !== null && usable(store)) {
    if (url.protocol !== store.protocol || url.port !== store.port) {
      return false;
    }

    return (
      url.hostname === store.hostname || (HOSTS.has(store.hostname) && HOSTS.has(url.hostname))
    );
  }

  return url.protocol === 'http:' && HOSTS.has(url.hostname);
}
