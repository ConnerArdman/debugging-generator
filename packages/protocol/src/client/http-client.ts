/**
 * The HTTP half of this package's transport SDK: one client over the seventeen
 * routes `../http.ts` declares, with the bearer credential applied and every
 * reply parsed by the route's own schema before it reaches a caller.
 *
 * AAP §0.7.1 (Group 1) specifies exactly this — "`HttpClient` wrapping fetch
 * with the bearer token and schema-parsed responses" — and the wrapping is the
 * whole value. Three processes call the local service: the service's own tests,
 * the VS Code extension host (`apps/vscode-extension/src/service/*`) and the
 * Chrome MV3 service worker (`apps/chrome-extension/src/background/*`), which
 * also proxies the DevTools panel's panel-data queries. Each of them would
 * otherwise spell out a path, a method, a header set and a response parse of its
 * own, and those four spellings are exactly what drift. Here they are read from
 * the route table, so a route change is a compile error in every caller at once
 * (AAP §0.1.2: "Share protocol schemas between components. Avoid duplicating
 * type definitions.").
 *
 * ## Nothing in this file states a route
 *
 * No path, method, operation name or schema is written below. The method comes
 * from `HTTP_ROUTES[operation].method`, the path from {@link buildPath}, the
 * bodies from {@link parseHttpRequest} and {@link parseHttpResponse}, and the
 * credential requirement from {@link isAuthExemptOperation}. A literal here
 * would be the second definition AAP §0.9.1 forbids — and the one a reviewer
 * cannot see disagreeing with the first.
 *
 * ## Why `fetch` is injected
 *
 * `tsconfig.json` declares `types: []` and `tsup.config.ts` builds this package
 * with `platform: 'neutral'`, so no Node HTTP client may enter this graph and no
 * ambient Node type is nameable. The web-standard `fetch` exists in all three
 * runtimes that load this bundle — Node 24, the MV3 service worker and the VS
 * Code webview — but it is still taken as an **option** typed by this file's own
 * {@link FetchLike}, for the reason the sibling `ws-client.ts` takes a WebSocket
 * constructor: a structural parameter lets a test drive the client with a plain
 * function and assert on the headers it produced, without a global to patch and
 * restore. When the option is omitted the platform global is resolved **at call
 * time**, never at import time, so importing this module still does nothing
 * (`package.json` declares `sideEffects: false`).
 *
 * ## Only a loopback origin ever receives a credential
 *
 * The configured base URL is validated in the constructor by
 * {@link parseServiceOrigin} — Section A.1, the one host policy this client and
 * `./ws-client.ts` share — and reduced to a canonical {@link ServiceOrigin}. A
 * value that names any host other than this machine's loopback interface, or
 * that carries user information, a path, a query or a fragment, is refused: the
 * constructor still returns (AAP §0.5.5), with {@link HttpClient.baseUrl}
 * `undefined` and {@link HttpClient.configurationError} naming the rule, and
 * every call — exempt ones included — answers `CONFIG_INVALID` **before** the
 * credential provider or the transport is touched. The refused value is not
 * kept, so no message, hint or `details` can quote it (AAP §0.5.2).
 *
 * ## Cancellation is established before the credential is resolved
 *
 * A call's caller signal and its timeout are linked into one controller before
 * the call's first asynchronous step, and every step after it — resolving the
 * credential, sending, reading the body — is raced against that controller. A
 * credential provider that never settles therefore ends at the call's deadline
 * rather than leaving the call pending forever, and a credential that resolves
 * after the call was cancelled never reaches the transport. The failure is
 * `TRANSPORT_DISCONNECTED` with `details.cancelled` naming the source that fired
 * — `timeout` or `aborted` — and the timer and listener are released on every
 * exit path.
 *
 * ## Two routes carry no credential, and only two
 *
 * `Authorization: Bearer <token>` goes on every request except the two
 * operations `AUTH_EXEMPT_OPERATIONS` names — `health`, which has to answer
 * before a client holds a credential, and `pair.complete`, whose one-time code
 * *is* the capability being presented (AAP §0.5.6). The decision is delegated to
 * {@link isAuthExemptOperation} rather than made here, and it is made in both
 * directions: an exempt route is called with no `Authorization` header even when
 * a credential is available, and a protected route with no credential fails
 * locally rather than reaching the service unauthenticated.
 *
 * Nothing here sets `Origin`, `Cookie` or any `Access-Control-*` header, and
 * `credentials: 'omit'` goes on every call. The service answers no
 * `Access-Control-Allow-Origin` and refuses web origins outright (AAP §0.5.6);
 * a client that tried to work around that would be defeating the boundary that
 * keeps a page on `localhost` from driving the developer's editor.
 *
 * ## Failures are returned, never thrown, and never carry data
 *
 * Every method answers `Result<…, DebuggenError>` and
 * {@link HttpClient.request} **never rejects**: a service that is not running, a
 * refused credential, a malformed reply and a missing path parameter all arrive
 * as an `Err` a user interface can render, because AAP §0.5.5 makes "Service not
 * running" a first-class state rather than an exception. It matters most in the
 * MV3 service worker, where an unhandled rejection takes the worker down and
 * with it the panel's connection.
 *
 * What a failure carries is bounded by AAP §0.5.2: the credential, the request
 * body and the response body never appear in a message, a hint, `details` or a
 * log line. A schema rejection is rendered by `../version.ts`'s
 * `describeZodIssues` through the two parse helpers, which emit issue paths and
 * codes and no rejected value; a refusal carries the numeric status, the
 * operation and the fields the error payload's own schema validated; and the
 * only logging is one `debug` record per call that reached the transport, with
 * the operation, the status when one arrived, the elapsed milliseconds and, for
 * a cancelled call, which source fired.
 *
 * ## The public surface
 *
 * One generic {@link HttpClient.request} covers all seventeen routes with exact
 * body and response types, and three named methods exist only because their
 * callers need something a route table cannot express: {@link HttpClient.health}
 * is called before a credential exists, {@link HttpClient.pairComplete} carries
 * a capability that must not be logged, and {@link HttpClient.startCapture}
 * turns the documented `409` reply into a failure that names the session holding
 * the capture. There is deliberately no wrapper per route — that would be the
 * duplication this package exists to prevent.
 *
 * Consumed through `./index.ts` only (`tsup.config.ts`: the barrel is the single
 * entry, so a symbol it does not re-export does not exist for a consumer), by
 * `apps/vscode-extension/src/service/{client,discovery,process}.ts`,
 * `apps/chrome-extension/src/background/{ws-bridge,auth}.ts` and the service's
 * own integration suites. Inside `src/**` only `./ws-client.ts` imports this
 * module, and only for Section A.1's origin validator.
 */

import {
  DebuggenError,
  err,
  fromPromise,
  isErr,
  isOk,
  noopLogger,
  ok,
  tryCatch,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result } from '@debuggen/shared';

import {
  AUTHORIZATION_HEADER,
  HTTP_ROUTES,
  buildPath,
  captureStartConflictResponseSchema,
  formatBearer,
  httpErrorResponseSchema,
  isAuthExemptOperation,
  parseHttpRequest,
  parseHttpResponse,
} from '../http.js';
import type {
  CaptureStartResponse,
  HealthResponse,
  HttpOperation,
  HttpRequestBody,
  HttpResponseBody,
  PairCompleteResponse,
} from '../http.js';

// ---------------------------------------------------------------------------
// Section A — the transport constants this client writes
//
// Header names are lowercase for the reason `../http.ts` gives for
// `AUTHORIZATION_HEADER`: the web platform normalises a header name, so one
// lowercase spelling is correct for writing here and for reading in hono.
// ---------------------------------------------------------------------------

/** The `Accept` header's name, lowercase. Sent on every request. */
const ACCEPT_HEADER = 'accept';

/** The `Content-Type` header's name, lowercase. Sent only with a body. */
const CONTENT_TYPE_HEADER = 'content-type';

/**
 * The one media type this client sends and accepts.
 *
 * Every route's request and response body is JSON — `../http.ts` binds a Zod
 * schema to each — so there is no content negotiation to express.
 */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * The statuses that mean "your credential was missing, wrong, expired or
 * presented from an origin this service refuses".
 *
 * Typed `readonly number[]` rather than a literal tuple so a status read off a
 * response can be tested against it without a cast.
 */
const UNAUTHORIZED_STATUSES: readonly number[] = [401, 403];

/** The status the service's pairing rate limit answers with. */
const RATE_LIMITED_STATUS = 429;

/** The lowest status that means the service itself failed rather than refused. */
const SERVER_ERROR_STATUS_FLOOR = 500;

/**
 * The longest delay a platform timer honours, in milliseconds: 2³¹ − 1, about
 * 24.8 days.
 *
 * Every runtime this bundle targets stores the delay as a signed 32-bit integer
 * and fires *immediately* for anything larger, so a generous timeout would turn
 * into an instant one. A longer timeout is scheduled at this bound instead,
 * which no call outlives.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The error codes that already say "unauthorized" in the closed vocabulary of
 * `@debuggen/shared`.
 *
 * Used to keep a `401`/`403` in that family without flattening a more precise
 * code the service chose: `PAIRING_EXPIRED` tells the DevTools panel to ask for
 * a fresh code, which a blanket `UNAUTHORIZED` would not.
 */
const UNAUTHORIZED_FAMILY_CODES: readonly DebuggenErrorCode[] = [
  'FORBIDDEN_ORIGIN',
  'PAIRING_EXPIRED',
  'PAIRING_INVALID',
  'RATE_LIMITED',
  'UNAUTHORIZED',
];

/** The recovery step for a credential the service would not accept, or for none. */
const CREDENTIAL_REFUSED_HINT =
  'The local service refused this credential. Pair this client again, or supply the rotated credential with setToken().';

/** The recovery step for a refusal from the service's pairing rate limit. */
const RATE_LIMITED_HINT =
  'The local service is rate-limiting this client. Wait for the lockout to elapse before retrying.';

/** The recovery step for a reply that says the service itself failed. */
const SERVER_FAILURE_HINT =
  'The local service failed while handling this request; its log names the stage that failed.';

/**
 * The recovery step for each refusal code whose remedy the code alone decides,
 * whatever status it arrived with.
 *
 * Keyed on the code rather than the status because one status covers refusals
 * with opposite remedies: a `403` is both a credential the service would not
 * accept, which pairing again or rotating fixes, and a request from a web origin
 * (`FORBIDDEN_ORIGIN`, AAP §0.5.6), which no credential fixes — advising a
 * re-pair there sends the developer round a loop that cannot succeed. Every
 * member of {@link UNAUTHORIZED_FAMILY_CODES} has an entry, and
 * `resolveRefusalCode` keeps every `401`/`403` inside that family, so an
 * authentication refusal always carries a hint.
 *
 * Each text is constant: none quotes the reply body, the credential or the base
 * URL, so a hint can be rendered and logged anywhere (AAP §0.5.2). The pairing
 * lifetime and lockout it names are the pairing rules of AAP §0.5.6.
 */
const REFUSAL_CODE_HINTS: Readonly<Partial<Record<DebuggenErrorCode, string>>> = {
  FORBIDDEN_ORIGIN:
    'The local service refuses every request whose Origin is an http: or https: web page, whatever credential it carries. Call it from the VS Code extension, the Debug Generator Chrome extension (a chrome-extension:// origin) or a local Node client that sends no web Origin; pairing again or supplying a new credential does not change this.',
  PAIRING_EXPIRED:
    'The pairing code is no longer valid: codes are single-use and expire five minutes after they are issued. Run "Debug Generator: Pair Chrome DevTools Panel" (debuggen.pairChrome) in VS Code for a new code.',
  PAIRING_INVALID:
    'The local service did not accept this pairing code. Enter the code VS Code shows exactly as displayed, or run "Debug Generator: Pair Chrome DevTools Panel" (debuggen.pairChrome) for a new one; five failed attempts lock pairing for 60 seconds.',
  RATE_LIMITED: RATE_LIMITED_HINT,
  UNAUTHORIZED: CREDENTIAL_REFUSED_HINT,
};

// ---------------------------------------------------------------------------
// Section A.1 — the service origin both transports send their credential to
//
// The one host policy of this SDK, shared by both halves: this client's
// constructor and the sibling `./ws-client.ts` (its `resolveWsUrl` and its
// constructor) validate the configured value here and nowhere else, so the two
// transports cannot disagree about where a credential may go. The edge runs one
// way only — the WebSocket half imports this section, and this module imports
// nothing from it.
//
// Why a policy at all: the local service binds a loopback interface (AAP
// §0.5.6, `DEBUGGEN_HOST` defaults to `127.0.0.1` per AAP §0.3.4), and both
// clients present a bearer credential — the HTTP `Authorization` header, the
// WebSocket `client.hello` frame — together with private project data on their
// very first write. A configured base URL is not trusted input: the editor
// reads it from `debuggen.serviceUrl`, a service worker from its own storage,
// and a value naming any other host would hand the developer's credential and
// project to that host before the service's own authentication or origin
// policy could say anything (CWE-200, CWE-918). So a value that does not name
// this machine's loopback interface is refused *before* any credential is
// resolved, and nothing is sent.
// ---------------------------------------------------------------------------

/**
 * The brand that makes {@link ServiceOrigin} nominal.
 *
 * Declared, never defined: it exists only in the type system, so nothing is
 * emitted and importing this module still has no side effect.
 */
declare const SERVICE_ORIGIN_BRAND: unique symbol;

/**
 * A validated origin of the local service: `http:` or `https:`, a loopback host,
 * an optional port, and nothing else — no userinfo, no path, no query, no
 * fragment. For example `http://127.0.0.1:43117`.
 *
 * Branded so that the only way to hold one is {@link parseServiceOrigin}: a
 * plain `string` does not satisfy it, which is what lets a consumer that
 * accepts a `ServiceOrigin` rely on the loopback check having run. It is still a
 * `string` at run time, so it displays, compares and concatenates as one — the
 * DevTools panel's `ConnectionStatus` pill and the editor's `StatusBar` render
 * it as is.
 */
export type ServiceOrigin = string & { readonly [SERVICE_ORIGIN_BRAND]: true };

/**
 * Which rule a refused service base URL broke, as it appears in
 * `error.details.rule`.
 *
 * A closed vocabulary rather than a message a consumer would have to parse, and
 * never a function of the input: a refused value can carry a pasted credential,
 * so the rule is the whole account of what was wrong with it.
 *
 * - `empty` — nothing but whitespace was configured.
 * - `unparseable` — the value is not an absolute URL, or not a string at all.
 * - `userinfo` — the authority embeds a user name or password.
 * - `scheme` — the scheme is not `http`, `https`, `ws` or `wss`.
 * - `host` — the URL names no host.
 * - `not-loopback` — the host is not this machine's loopback interface.
 * - `path` — the URL carries a path other than the root (or the one path the
 *   caller allowed).
 * - `query-or-fragment` — the URL carries a `?` query or a `#` fragment, even an
 *   empty one.
 */
export type ServiceOriginRule =
  | 'empty'
  | 'unparseable'
  | 'userinfo'
  | 'scheme'
  | 'host'
  | 'not-loopback'
  | 'path'
  | 'query-or-fragment';

/** How {@link parseServiceOrigin} is asked to read one value. */
export interface ServiceOriginOptions {
  /**
   * The one path, besides the root, the value may carry — `WS_PATH` when the
   * value is the socket URL rather than the base URL.
   *
   * Omitted means only the root is accepted, which is the right answer for a
   * base URL: every route path is absolute, so a path prefix in the configured
   * value could only be dropped silently or be a mistake.
   */
  readonly allowedPath?: string | undefined;
}

/**
 * The scheme each accepted input scheme is canonicalised to.
 *
 * `ws:`/`wss:` are accepted because a socket URL and a base URL name the same
 * service origin; the result is always the HTTP spelling, so both transports
 * start from one canonical string. The default ports agree pairwise (80 for
 * `http:`/`ws:`, 443 for `https:`/`wss:`), so the mapping never changes which
 * port is meant.
 */
const SERVICE_ORIGIN_SCHEME_BY_INPUT_SCHEME: Readonly<
  Record<string, 'http:' | 'https:' | undefined>
> = Object.freeze({
  'http:': 'http:',
  'https:': 'https:',
  'ws:': 'http:',
  'wss:': 'https:',
});

/** The loopback name, as the WHATWG URL parser lowercases it. */
const LOOPBACK_HOST_NAME = 'localhost';

/** The IPv6 loopback address, as the URL parser serialises every spelling of it. */
const IPV6_LOOPBACK_HOSTNAME = '[::1]';

/**
 * An IPv4-mapped IPv6 address inside `127.0.0.0/8`, as the URL parser
 * serialises it: `[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`, so the first
 * embedded hextet always begins `7f`.
 */
const IPV4_MAPPED_LOOPBACK_HOSTNAME = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u;

/**
 * A dotted-quad IPv4 hostname. The URL parser has already normalised every
 * other IPv4 spelling (`127.1`, `0x7f.1`, `2130706433`) to this form with
 * in-range octets, so the first capture is all the loopback test needs.
 */
const IPV4_DOTTED_QUAD_HOSTNAME = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

/** The first octet of `127.0.0.0/8`, the IPv4 loopback block, as the parser prints it. */
const IPV4_LOOPBACK_FIRST_OCTET = '127';

/**
 * The characters that begin a query or a fragment. Tested on the raw value
 * because the parser reports an *empty* query or fragment as `''`, and a value
 * that carries either marker is not an origin.
 */
const QUERY_OR_FRAGMENT_MARKER = /[?#]/u;

/**
 * The raw shape of an origin as written: a scheme, exactly `://`, the authority
 * up to the first `/`, `\`, `?` or `#`, and then the path up to a query or a
 * fragment.
 *
 * Why the raw value is read at all: the WHATWG parser is lenient in exactly the
 * places this policy must be strict. It erases an **empty** userinfo
 * (`http://@host`, `http://:@host` both parse with an empty `username`), it
 * resolves dot segments (`/a/..` and `/hidden/../ws` become `/` and `/ws`),
 * it reads `\` as `/` and `%2e` as `.` in a special URL's path, and it accepts a
 * special scheme with no slashes at all (`http:host`). Each of those would let a
 * value that is not written as a plain origin through a check made on the
 * parsed result, so the userinfo and path rules below are applied to these two
 * captures as written, and a value that does not have this shape is refused.
 *
 * The authority stops at the same four characters the parser stops at for a
 * special scheme, so any `@` it contains is a userinfo separator to the parser
 * too.
 */
const RAW_ORIGIN_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/([^/\\?#]*)([^?#]*)/iu;

/** The separator between a userinfo component and a host, in a raw authority. */
const USERINFO_SEPARATOR = '@';

/**
 * The code points at or below which a character is an ASCII control or a
 * space. The parser silently strips a tab or a newline anywhere in its input
 * and trims controls and spaces at both ends, so a value carrying one inside it
 * does not say what the parser reads; such a value is refused instead.
 */
const LAST_CONTROL_OR_SPACE_CODE_POINT = 0x20;

/** DEL, the one ASCII control above {@link LAST_CONTROL_OR_SPACE_CODE_POINT}. */
const DELETE_CODE_POINT = 0x7f;

/** The root path the URL parser gives an origin with no path. */
const ROOT_PATH = '/';

/** The example every hint below points at. */
const SERVICE_ORIGIN_EXAMPLE = 'http://127.0.0.1:43117';

/**
 * Validates a configured service base URL and reduces it to its canonical
 * loopback origin.
 *
 * The single host policy both transports apply before they resolve or send a
 * credential (see Section A.1 above). The rules, in the order they are checked:
 * the value is a non-empty string; it contains no ASCII control character or
 * space inside it and parses as an absolute URL; its authority embeds no user
 * name or password; its scheme is `http`, `https`, `ws` or `wss`; it is written
 * as `scheme://authority` and that authority, **as written**, contains no `@` —
 * so an empty userinfo the parser would erase is refused too; it names a host;
 * that host is this machine's loopback interface — the name `localhost`, an IPv4
 * address in `127.0.0.0/8`, the IPv6 loopback address `[::1]` or an IPv4-mapped
 * IPv6 address in `127.0.0.0/8`, the same set `apps/local-service/src/config.ts`
 * accepts for `DEBUGGEN_HOST`; its path, **as written and as parsed**, is the
 * root or exactly {@link ServiceOriginOptions.allowedPath} — so dot segments,
 * `\` and `%2e` are refused however they would normalise; and it carries no
 * query and no fragment. A name is compared, never resolved: a host that merely
 * resolves to a loopback address today is still refused.
 *
 * **A failure is returned, not thrown**, because a misconfigured service URL is
 * a state a user interface renders (AAP §0.5.5). Every failure is
 * `CONFIG_INVALID` with a constant message, a constant hint and
 * `details: { rule }` — and nothing else. The value itself never appears in the
 * error, not even in part: the parser's own `TypeError` quotes its input and is
 * therefore discarded, and a refused value can carry a pasted credential
 * (AAP §0.5.2).
 *
 * @param value The configured value, for example `http://127.0.0.1:43117`.
 * Surrounding whitespace is ignored.
 * @param options The one extra path the value may carry, when it is a socket URL.
 * @returns `ok(origin)` — always `http:` or `https:` followed by the host and any
 * non-default port — or `err(error)` naming the rule the value broke.
 *
 * @example
 * ```ts
 * const origin = parseServiceOrigin(config.serviceUrl);
 * if (isErr(origin)) {
 *   return view.showConfigurationError(origin.error); // never quotes the value
 * }
 * statusBar.render(origin.value); // "http://127.0.0.1:43117"
 * ```
 */
export function parseServiceOrigin(
  value: string,
  options?: ServiceOriginOptions,
): Result<ServiceOrigin, DebuggenError> {
  // Unreachable for a typed caller, but not for an untyped one: a service worker
  // forwarding what it read from `chrome.storage.local` can hand over
  // `undefined`, and both transports' constructors promise never to throw. Read
  // as `unknown` so the guard is a real check rather than one the compiler
  // considers dead, and answered here so the two transports report it alike.
  const configured: unknown = value;

  if (typeof configured !== 'string') {
    return err(
      serviceOriginError(
        'unparseable',
        'The service base URL is not text',
        `Configure the service URL as a string naming a loopback host and port, for example ${SERVICE_ORIGIN_EXAMPLE}.`,
      ),
    );
  }

  const trimmed = configured.trim();

  if (trimmed.length === 0) {
    return err(
      serviceOriginError(
        'empty',
        'The service base URL is empty',
        `Set the service URL to the loopback host and port the local service listens on, for example ${SERVICE_ORIGIN_EXAMPLE}.`,
      ),
    );
  }

  // `new URL` throws a `TypeError` whose message quotes the input — the one
  // thing that must not be forwarded — hence `tryCatch` and a constant sentence
  // rather than the caught error, which is not kept even as `cause`. A value
  // with a control character or a space inside it is refused the same way
  // before it is parsed: the parser would drop or trim those silently, and the
  // raw checks below have to see exactly what the parser sees.
  const parsed = containsControlOrSpace(trimmed)
    ? undefined
    : tryCatch(() => new URL(trimmed), 'CONFIG_INVALID');

  if (parsed === undefined || isErr(parsed)) {
    return err(unparseableServiceOriginError());
  }

  const url = parsed.value;

  if (url.username.length > 0 || url.password.length > 0) {
    return err(
      serviceOriginError(
        'userinfo',
        'The service base URL carries embedded credentials',
        'Remove the user information from the URL: the local service authenticates with a bearer credential, never with credentials in the URL.',
      ),
    );
  }

  const scheme = SERVICE_ORIGIN_SCHEME_BY_INPUT_SCHEME[url.protocol];

  if (scheme === undefined) {
    return err(
      serviceOriginError(
        'scheme',
        'The service base URL has an unsupported scheme',
        'Use http or https (ws and wss name the same origin); the local service listens over plain HTTP on a loopback address.',
      ),
    );
  }

  // The value as written, for the two rules the parser's normalisation would
  // otherwise defeat (see RAW_ORIGIN_SHAPE): a special scheme written without
  // `//` — or with `\` in its place — is not an origin as written, so it is
  // refused rather than read the way the parser would read it.
  const raw = RAW_ORIGIN_SHAPE.exec(trimmed);
  const rawAuthority = raw?.[1];
  const rawPath = raw?.[2];

  if (rawAuthority === undefined || rawPath === undefined) {
    return err(unparseableServiceOriginError());
  }

  // Any `@` in the authority as written is a userinfo separator, including one
  // in front of an empty user name or password, which the parser erases
  // without a trace in `username` and `password`.
  if (rawAuthority.includes(USERINFO_SEPARATOR)) {
    return err(
      serviceOriginError(
        'userinfo',
        'The service base URL carries embedded credentials',
        'Remove the user information from the URL: the local service authenticates with a bearer credential, never with credentials in the URL.',
      ),
    );
  }

  if (url.hostname.length === 0) {
    return err(
      serviceOriginError(
        'host',
        'The service base URL names no host',
        `Include the loopback host and port, for example ${SERVICE_ORIGIN_EXAMPLE}.`,
      ),
    );
  }

  if (!isLoopbackServiceHostname(url.hostname)) {
    return err(
      serviceOriginError(
        'not-loopback',
        'The service base URL does not name a loopback address',
        'The local service only listens on this machine: use 127.0.0.1 (or another address in 127.0.0.0/8), localhost or [::1]. No credential is ever sent to another host.',
      ),
    );
  }

  // Judged as written *and* as parsed. The raw path must be exactly the root
  // (or nothing) or exactly the allowed path — so dot segments, `\`, `%2e` and
  // doubled slashes are refused however they would normalise — and the parsed
  // path must agree, which it does for every raw path that passes.
  if (
    !isPermittedServicePath(rawPath, options?.allowedPath) ||
    !isPermittedServicePath(url.pathname, options?.allowedPath)
  ) {
    return err(
      serviceOriginError(
        'path',
        'The service base URL carries a path',
        `Configure the origin only — scheme, host and port, for example ${SERVICE_ORIGIN_EXAMPLE}; every route path is added by the client.`,
      ),
    );
  }

  if (QUERY_OR_FRAGMENT_MARKER.test(trimmed)) {
    return err(
      serviceOriginError(
        'query-or-fragment',
        'The service base URL carries a query or a fragment',
        `Configure the origin only — scheme, host and port, for example ${SERVICE_ORIGIN_EXAMPLE}.`,
      ),
    );
  }

  // The one assertion that mints the brand, and the reason the brand exists:
  // every rule above has held, so this string is a loopback origin.
  return ok(`${scheme}//${url.host}` as ServiceOrigin);
}

/**
 * Whether a hostname, exactly as the WHATWG URL parser reports it, names this
 * machine's loopback interface.
 *
 * Only the parser's canonical forms need recognising, because
 * {@link parseServiceOrigin} is the only caller and always parses first: the
 * name is already lowercase, an IPv4 address is already a dotted quad, and an
 * IPv6 literal is already bracketed and compressed. An IPv4-*compatible* IPv6
 * address (`[::7f00:1]`) is deliberately refused — it is deprecated and does not
 * route to the loopback interface on every platform — and so is `localhost.`
 * with a trailing dot, which a resolver may look up rather than answer locally.
 *
 * @param hostname `URL.hostname` of a parsed value.
 * @returns `true` when the host is verifiably loopback without resolving it.
 */
function isLoopbackServiceHostname(hostname: string): boolean {
  if (hostname === LOOPBACK_HOST_NAME || hostname === IPV6_LOOPBACK_HOSTNAME) {
    return true;
  }

  if (IPV4_MAPPED_LOOPBACK_HOSTNAME.test(hostname)) {
    return true;
  }

  const quad = IPV4_DOTTED_QUAD_HOSTNAME.exec(hostname);

  return quad !== null && quad[1] === IPV4_LOOPBACK_FIRST_OCTET;
}

/**
 * Builds one refusal of {@link parseServiceOrigin}: `CONFIG_INVALID`, a constant
 * message and hint, and the rule as the only detail.
 *
 * @param rule The rule the value broke.
 * @param message One constant sentence naming what was wrong.
 * @param hint The step that corrects it.
 * @returns The failure, which carries nothing derived from the refused value.
 */
function serviceOriginError(rule: ServiceOriginRule, message: string, hint: string): DebuggenError {
  return new DebuggenError('CONFIG_INVALID', message, { hint, details: { rule } });
}

/**
 * The refusal for a value that is not an absolute URL written as a plain
 * `scheme://authority` origin — shared by the parse failure, a control
 * character or space inside the value, and a special scheme written without
 * `//`, which are all the `unparseable` rule.
 *
 * @returns The `unparseable` refusal, with a constant message and hint.
 */
function unparseableServiceOriginError(): DebuggenError {
  return serviceOriginError(
    'unparseable',
    'The service base URL is not a valid absolute URL',
    `Write the URL with a scheme, a loopback host and a port, for example ${SERVICE_ORIGIN_EXAMPLE}.`,
  );
}

/**
 * Whether a path — raw or parsed — is one a service origin may carry: nothing,
 * the root, or exactly the one path the caller allowed.
 *
 * @param path The path to judge.
 * @param allowedPath {@link ServiceOriginOptions.allowedPath}, when given.
 * @returns `true` when the path is permitted.
 */
function isPermittedServicePath(path: string, allowedPath: string | undefined): boolean {
  return path === '' || path === ROOT_PATH || (allowedPath !== undefined && path === allowedPath);
}

/**
 * Whether a value contains an ASCII control character, a space or DEL.
 *
 * A loop over code units rather than a regular expression with a control range,
 * which ESLint's `no-control-regex` would rightly flag as usually a mistake.
 * Only the ASCII range matters here: it is what the URL parser strips or trims
 * silently, while anything outside it survives into the parsed value, where
 * the host and path rules judge it.
 *
 * @param value The trimmed configured value.
 * @returns `true` when the value contains such a character anywhere.
 */
function containsControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);

    if (codePoint <= LAST_CONTROL_OR_SPACE_CODE_POINT || codePoint === DELETE_CODE_POINT) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Section B — the injected transport, typed structurally
//
// These three declarations are the whole reason no `@types/node` and no DOM
// `RequestInit` appears in this package's surface. They describe only what this
// client uses, which is what lets both Node 24's global `fetch` and a five-line
// test stub satisfy them.
// ---------------------------------------------------------------------------

/**
 * The request options this client sets, and nothing else.
 *
 * Narrower than the platform's `RequestInit` on purpose: a field absent here is
 * a field this client never sends, which is a reviewable statement about the
 * transport rather than a comment about it. `credentials` is restricted to the
 * single literal `'omit'` so no call site can start sending cookies to the local
 * service (AAP §0.5.6).
 */
export interface HttpFetchInit {
  /** The method, taken from the route definition — never spelled here. */
  method: string;

  /** The request headers, already lowercase. */
  headers?: Record<string, string>;

  /** The JSON request body, present only for a route that declares one. */
  body?: string;

  /**
   * The abort signal, when the caller supplied one or a timeout applies: the
   * call's own controller, which the caller's signal and the timeout both
   * abort, so the transport sees one signal whichever fires first.
   */
  signal?: AbortSignal | null;

  /** Always `'omit'`: the local service authenticates by bearer credential. */
  credentials?: 'omit';
}

/**
 * The part of a response this client reads.
 *
 * `text()` rather than `json()`, because the reply has to be parsed by the
 * route's schema either way and a `json()` rejection would lose the distinction
 * between "the service sent nothing" and "the service sent something that is not
 * JSON". `statusText` is optional: it is advisory, absent on an HTTP/2 response,
 * and never rendered by this client.
 */
export interface HttpResponseLike {
  /** Whether the status is in the 2xx range. */
  readonly ok: boolean;

  /** The numeric status, which is what every failure below reports. */
  readonly status: number;

  /** The reason phrase, when the transport has one. */
  readonly statusText?: string;

  /** Reads the whole body as text. */
  text(): Promise<string>;
}

/**
 * The injected transport: anything that takes a URL string plus
 * {@link HttpFetchInit} and answers an {@link HttpResponseLike}.
 *
 * Satisfied by the platform `fetch` in every supported runtime — asserted below
 * — and by a test stub that ignores its arguments and resolves a literal.
 */
export type FetchLike = (url: string, init?: HttpFetchInit) => Promise<HttpResponseLike>;

/** Constrains {@link AssignableTo} to a proof rather than a boolean. */
type AssertTrue<TAssertion extends true> = TAssertion;

/** Whether `TSource` is assignable to `TTarget`, as a literal `true`/`false`. */
type AssignableTo<TSource, TTarget> = [TSource] extends [TTarget] ? true : false;

/**
 * Compile-time proof that the platform `fetch` satisfies {@link FetchLike}.
 *
 * The structural aliases above exist so that no ambient Node or DOM type enters
 * this package's public surface, which means nothing would otherwise notice if
 * they drifted from the real signature — until a consumer passed
 * `globalThis.fetch` and the compiler refused it in *their* build. This alias
 * moves that failure here, into `pnpm typecheck` of this package.
 *
 * Exported for the mechanical reason `../http.ts`'s own drift guards are
 * exported: the repository compiles with `noUnusedLocals` and lints with
 * `@typescript-eslint/no-unused-vars`, under which an unreferenced local type
 * alias is itself an error. It is a type, so nothing is emitted.
 */
export type GlobalFetchIsFetchLike = AssertTrue<AssignableTo<typeof fetch, FetchLike>>;

/**
 * The platform globals one call's cancellation is built from, read off
 * `globalThis` when the call is made.
 *
 * Every member is declared **optional** although the DOM lib types them as
 * always present, and that is the point: this bundle runs in three runtimes and
 * a global that is missing must degrade — to "the caller's own signal" without
 * `AbortController`, to "no timeout" without timers — never throw. Declaring
 * them optional is what makes the runtime checks in
 * {@link createCallCancellation} type-checkable instead of dead code the
 * compiler has to be argued out of.
 *
 * Plain `AbortController` and `setTimeout` rather than the `AbortSignal.timeout`
 * and `AbortSignal.any` statics, for two reasons: the timer behind
 * `AbortSignal.timeout` cannot be cancelled, so it would outlive every call that
 * finished early, whereas a handle from `setTimeout` is cleared the moment the
 * call ends; and a timeout scheduled through the global `setTimeout` is one a
 * test's fake clock can drive, so the deadline is provable without waiting for
 * it.
 */
interface CancellationPlatform {
  /** The `AbortController` constructor, when the runtime provides it. */
  readonly AbortController?: (new () => AbortController) | undefined;

  /**
   * The platform `setTimeout`, when the runtime provides it.
   *
   * Typed as the DOM lib types it — a numeric handle — which is also what Node
   * 24 accepts back through `clearTimeout`, although it mints an object there.
   */
  readonly setTimeout?: ((handler: () => void, milliseconds: number) => number) | undefined;

  /** The platform `clearTimeout`, when the runtime provides it. */
  readonly clearTimeout?: ((handle: number) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Section C — credentials and construction options
// ---------------------------------------------------------------------------

/**
 * A credential resolved per call, synchronously or not.
 *
 * The lazy form is what the Chrome service worker needs: its DevTools
 * credential lives in `chrome.storage.local`, whose read is asynchronous, and
 * the worker is suspended and revived between calls, so a token captured once at
 * construction would be a token read from a dead closure. It is also what makes
 * `debuggen.rotateServiceToken` take effect without rebuilding a client — the
 * next call simply resolves the new value.
 *
 * Answering `undefined` means "no credential is available", which fails a
 * protected operation locally with an unauthorized-family error rather than
 * sending an unauthenticated request.
 */
export type TokenProvider = () => string | undefined | Promise<string | undefined>;

/**
 * How one {@link HttpClient} is configured.
 *
 * Only `baseUrl` is required. Every other field has a defined default, and each
 * default is the one a consumer would otherwise write itself.
 *
 * Every optional field declares `| undefined` explicitly, which is what
 * `tsconfig.base.json` prescribes for a hand-written optional that can
 * legitimately hold `undefined`: with `exactOptionalPropertyTypes`, `fetch?:
 * FetchLike` means "absent or a transport" and refuses `fetch: undefined`, so a
 * consumer assembling options from its own configuration —
 * `{ token: config.token, defaultTimeoutMs: config.timeoutMs }`, where both are
 * `T | undefined` — would have to write a conditional spread per field. Stating
 * the union accepts both spellings and weakens nothing: the field is still
 * optional, and every read below already handles its absence.
 */
export interface HttpClientOptions {
  /**
   * The service's base URL, for example `http://127.0.0.1:43117`.
   *
   * Required and never defaulted: AAP §0.3.4 puts `DEBUGGEN_HOST` and
   * `DEBUGGEN_PORT` in the environment and each client resolves its own base URL
   * from configuration, which is what lets a second service instance run on
   * another port.
   *
   * **Only a loopback origin is accepted.** The value is validated by
   * {@link parseServiceOrigin} — the one host policy this SDK's two transports
   * share — so it must name `localhost`, an address in `127.0.0.0/8`, `[::1]`
   * or an IPv4-mapped loopback address, with no user information, no path, no
   * query and no fragment (`ws:`/`wss:` are accepted and read as `http:`/
   * `https:`). A value that breaks any rule does not make the constructor throw:
   * the client is built with {@link HttpClient.baseUrl} `undefined` and
   * {@link HttpClient.configurationError} set, and every call answers
   * `CONFIG_INVALID` without resolving a credential or touching the transport.
   */
  readonly baseUrl: string;

  /**
   * The bearer credential, or a provider that resolves one per call.
   *
   * Omit it for a client that only calls the two auth-exempt operations — the
   * probe `apps/vscode-extension/src/service/discovery.ts` performs before it
   * knows whether a service is running, and the pairing exchange the Chrome
   * service worker performs before it holds a credential at all.
   */
  readonly token?: string | TokenProvider | undefined;

  /**
   * The transport. Defaults to the platform `fetch`, resolved at call time.
   */
  readonly fetch?: FetchLike | undefined;

  /**
   * Where the one `debug` record per call goes. Defaults to `noopLogger`, so a
   * library consumer that wants no output configures nothing.
   */
  readonly logger?: Logger | undefined;

  /**
   * The timeout applied to a call that does not set its own, in milliseconds.
   *
   * Omitted means no timeout: the local service performs work — indexing a
   * project, running a model stage — that legitimately takes longer than any
   * default this file could pick, so the choice belongs to the caller that knows
   * which operation it is waiting on. A value that is not a finite positive
   * number also means no timeout.
   *
   * The timeout starts when the call is made and bounds all of it — resolving
   * the credential, sending, and reading the reply — so a stalled credential
   * provider is bounded exactly like a stalled service.
   */
  readonly defaultTimeoutMs?: number | undefined;
}

/**
 * The per-call options the three named methods accept.
 *
 * The same two fields {@link HttpRequestArgs} carries, without the path
 * parameters and body those methods supply themselves. Both declare
 * `| undefined` for the reason {@link HttpClientOptions} states: a caller
 * forwarding its own `AbortSignal | undefined` should not need a conditional
 * spread to do it.
 */
export interface HttpCallOptions {
  /** A caller-owned abort signal — a cancelled command, a disposed view. */
  readonly signal?: AbortSignal | undefined;

  /** Overrides {@link HttpClientOptions.defaultTimeoutMs} for this call. */
  readonly timeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Section D — the per-operation argument types
//
// Both are derived from the route table rather than hand-listed, so a route
// that gains a path parameter or changes its body schema changes the type of
// every call site in the same edit.
// ---------------------------------------------------------------------------

/**
 * The path parameters an operation declares, each a string.
 *
 * `{}` for the eight routes that declare none, `{ id }` for the session-scoped
 * routes, `{ id, panelId }` for the one route that names a specific panel.
 *
 * @typeParam O The operation.
 */
export type HttpPathParams<O extends HttpOperation> = {
  readonly [K in (typeof HTTP_ROUTES)[O]['params'][number]]: string;
};

/**
 * Everything one call can carry beyond its operation.
 *
 * @typeParam O The operation.
 */
export interface HttpRequestArgs<O extends HttpOperation> {
  /**
   * The path parameters, encoded by {@link buildPath}.
   *
   * Optional even for a route that declares parameters, because a caller can
   * still omit one and that has to be a returned failure rather than a compile
   * error the untyped edges of this product would never see.
   */
  readonly params?: HttpPathParams<O> | undefined;

  /**
   * The request body, validated against the route's schema before it is sent.
   *
   * `undefined` for every `GET`, which declares none; required for a `POST`,
   * including the four whose body is the empty object `{}`.
   */
  readonly body?: HttpRequestBody<O> | undefined;

  /** A caller-owned abort signal. */
  readonly signal?: AbortSignal | undefined;

  /** Overrides {@link HttpClientOptions.defaultTimeoutMs} for this call. */
  readonly timeoutMs?: number | undefined;
}

/**
 * What {@link HttpClient.request} needs from the route table before it can send
 * anything, resolved in one step so that a table lookup and a path substitution
 * share a single failure path.
 */
interface PreparedRoute {
  /** The method, from the route definition. */
  readonly method: string;

  /** The concrete, parameter-encoded path. */
  readonly path: string;

  /** Whether the route may be called without a credential. */
  readonly authExempt: boolean;
}

/**
 * The fields a refusal reply contributed, each present or explicitly absent.
 *
 * Declared with `| undefined` rather than as optional properties so the three
 * call sites in {@link httpFailureError} read the same way — a body that parsed
 * as a conflict, a body that parsed as the shared error payload, and a body that
 * parsed as neither — without conditional spreads at each one.
 */
interface RefusalFields {
  /** The code the payload carried, already drawn from the closed vocabulary. */
  readonly code: DebuggenErrorCode | undefined;

  /** The one-sentence message the payload carried. */
  readonly message: string | undefined;

  /** The correlation reference the payload carried. */
  readonly ref: string | undefined;

  /** The session holding the capture, from a capture-ownership conflict. */
  readonly owningSessionId: string | undefined;
}

/**
 * Which of a call's two cancellation sources ended it, as it appears in
 * `error.details.cancelled`.
 *
 * - `timeout` — the call's timeout elapsed first.
 * - `aborted` — the caller's `AbortSignal` fired first, including a signal that
 *   had already fired when the call was made.
 */
type CancellationSource = 'timeout' | 'aborted';

/**
 * One call's cancellation: the caller's signal and the call's timeout, linked
 * into one controller before anything asynchronous starts.
 *
 * Built per call by {@link createCallCancellation} — never shared, never kept
 * on the client — and disposed of in a `finally` on every exit path, so no timer
 * and no listener outlives the call it belonged to.
 */
interface CallCancellation {
  /**
   * The signal handed to the transport: the linked controller's; the caller's
   * own when the runtime has no `AbortController`; `undefined` when neither a
   * caller signal nor a timeout applies.
   */
  readonly signal: AbortSignal | undefined;

  /** The timeout that applies, in milliseconds, or `undefined` for none. */
  readonly timeoutMs: number | undefined;

  /** Which source fired first, or `undefined` while neither has. */
  readonly source: CancellationSource | undefined;

  /**
   * Fulfils with {@link CallCancellation.source} the moment the call is
   * cancelled, and never settles for a call that is not. Never rejects, so it
   * can be raced against any step without a rejection handler of its own.
   */
  readonly cancelled: Promise<CancellationSource>;

  /**
   * Clears the timer and removes the listener on the caller's signal.
   * Idempotent; after it has run, neither source can fire any more.
   */
  dispose(): void;
}

/**
 * What racing one step of a call against its cancellation produced: the step's
 * own value, or the source that cancelled the call first.
 *
 * @typeParam T What the step produces. Always a `Result`, because every step
 * raced here is one that has already been made non-rejecting.
 */
type RacedStep<T> =
  | { readonly cancelled: false; readonly value: T }
  | { readonly cancelled: true; readonly source: CancellationSource };

/**
 * Everything {@link HttpClient.request} has settled locally before the first
 * asynchronous step: the route, the validated body, the transport and the URL.
 *
 * Handed to the private exchange step as one value so that the part of a call
 * that can be cancelled is a single method, wrapped in a single `finally`.
 */
interface OutboundRequest {
  /** The method, from the route definition. */
  readonly method: string;

  /** The absolute URL: the validated origin joined with the encoded path. */
  readonly url: string;

  /** Whether the route is sent without a credential. */
  readonly authExempt: boolean;

  /** The `accept` and, with a body, `content-type` headers — never a credential. */
  readonly headers: Readonly<Record<string, string>>;

  /** The serialised, schema-validated body, or `undefined` for none. */
  readonly body: string | undefined;

  /** The transport the request is sent with. */
  readonly fetchImpl: FetchLike;
}

/** What the transport answered, before any of it has been parsed. */
interface RawReply {
  /** Whether the status is in the 2xx range. */
  readonly ok: boolean;

  /** The numeric status. */
  readonly status: number;

  /** The whole body, as text. */
  readonly body: string;
}

// ---------------------------------------------------------------------------
// Section E — the client
// ---------------------------------------------------------------------------

/**
 * A typed client over the local service's HTTP surface.
 *
 * One instance per base URL and credential source. It holds no connection, no
 * queue and no cache, so constructing one is free and disposing of one is
 * nothing: the only state is the configuration, and the credential is
 * deliberately re-resolved per call ({@link TokenProvider}).
 *
 * The configured base URL is validated once, here, by {@link parseServiceOrigin}.
 * A refused value — a remote host, embedded credentials, a path — still yields
 * an instance, because a misconfiguration is a state a user interface renders
 * (AAP §0.5.5): {@link HttpClient.configurationError} says which rule it broke,
 * and every call answers `CONFIG_INVALID` before any credential is resolved.
 *
 * @example
 * ```ts
 * const client = new HttpClient({ baseUrl, token: () => readPairedToken() });
 * if (client.configurationError !== undefined) {
 *   return showConfigurationError(client.configurationError); // never quotes the value
 * }
 *
 * const health = await client.health();
 * if (isErr(health)) {
 *   // "Service not running" is a state, not an exception (AAP §0.5.5).
 *   return showServiceStopped(health.error);
 * }
 *
 * const session = await client.request('session.create', {
 *   body: { projectRoot, question },
 * });
 * ```
 */
export class HttpClient {
  /**
   * The validated service origin every request goes to — for example
   * `http://127.0.0.1:43117` — or `undefined` when the configured base URL was
   * refused.
   *
   * Public because both user interfaces show it: the DevTools panel's
   * `ConnectionStatus` pill and the editor's `StatusBar` say which service they
   * are talking to, and neither should re-derive it from configuration. Typed
   * {@link ServiceOrigin} so a consumer holding it knows the loopback check has
   * run: it is always the canonical `http:`/`https:` origin of a loopback host
   * with no user information, so it is safe to display. A refused value is
   * never kept, not even trimmed — it may carry a pasted credential — so there
   * is nothing to display in its place but {@link HttpClient.configurationError}.
   */
  readonly baseUrl: ServiceOrigin | undefined;

  /**
   * Why the configured base URL was refused, or `undefined` when it was
   * accepted.
   *
   * Exactly the failure {@link parseServiceOrigin} returned: `CONFIG_INVALID`,
   * a constant message and hint, and `details: { rule }` naming the
   * {@link ServiceOriginRule} the value broke — nothing derived from the value
   * itself. Defined exactly when {@link HttpClient.baseUrl} is `undefined`.
   */
  readonly configurationError: DebuggenError | undefined;

  /**
   * The validation outcome both public fields above are read from.
   *
   * Kept as one `Result` so {@link HttpClient.request} narrows it once — to the
   * origin, or to the refusal — with no second source of truth to disagree with.
   */
  private readonly origin: Result<ServiceOrigin, DebuggenError>;

  /** The injected transport, or `undefined` to use the platform global. */
  private readonly fetchImpl: FetchLike | undefined;

  /** Where the one record per call goes. */
  private readonly logger: Logger;

  /** The timeout for a call that sets none. */
  private readonly defaultTimeoutMs: number | undefined;

  /**
   * The credential, or the provider that resolves one.
   *
   * The only mutable member, and mutable for exactly one reason:
   * {@link HttpClient.setToken}. A rotation and the moment pairing completes
   * both replace it on a client every open view already holds.
   */
  private tokenSource: string | TokenProvider | undefined;

  /**
   * Never throws: a refused base URL is recorded in
   * {@link HttpClient.configurationError} and reported by every call.
   *
   * @param options The base URL, and optionally a credential, a transport, a
   * logger and a default timeout.
   */
  constructor(options: HttpClientOptions) {
    // `parseServiceOrigin` is total, including for the one option that can
    // arrive untyped — an unset `chrome.storage.local` key reads back as
    // `undefined`, which it refuses as `unparseable` — so the constructor stays
    // total as well (AAP §0.5.5).
    const origin = parseServiceOrigin(options.baseUrl);

    this.origin = origin;
    this.baseUrl = isOk(origin) ? origin.value : undefined;
    this.configurationError = isErr(origin) ? origin.error : undefined;
    this.fetchImpl = options.fetch;
    this.logger = options.logger ?? noopLogger;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.tokenSource = options.token;
  }

  /**
   * Replaces the credential this client presents from the next call onward.
   *
   * The two moments that need it are pairing and rotation (AAP §0.5.6): the
   * Chrome service worker holds no credential until `pair.complete` answers with
   * one, and `debuggen.rotateServiceToken` invalidates every credential in the
   * store, after which each client has to present the replacement. Passing
   * `undefined` clears the credential, which fails the next protected call
   * locally instead of sending a request that cannot be authorized.
   *
   * @param token The credential, a provider that resolves one, or `undefined`.
   */
  setToken(token: string | TokenProvider | undefined): void {
    this.tokenSource = token;
  }

  /**
   * Calls one operation and parses its reply.
   *
   * The only method that performs a network call; the three named methods below
   * delegate to it. **It never rejects** — every outcome, including a
   * programming mistake such as a missing path parameter, arrives as a fulfilled
   * `Result` (AAP §0.5.5), which is what keeps a failed call from taking down the
   * MV3 service worker.
   *
   * The sequence is fixed, and every step before the request is one that must
   * not reach the service when it fails:
   *
   * 1. refuse the call when the configured base URL was refused — before
   *    anything else, so neither the credential provider nor the transport is
   *    reached for a host this client must not send to;
   * 2. resolve the route and encode the path;
   * 3. validate the outbound body against the route's own schema, and
   *    serialise it;
   * 4. resolve the transport and join the path to the validated origin;
   * 5. link the caller's signal and the timeout into the call's cancellation —
   *    a signal that has already fired ends the call here, with nothing read
   *    and nothing sent;
   * 6. resolve the credential unless the operation is exempt, raced against
   *    that cancellation;
   * 7. send with the linked signal and read the body as text, both raced
   *    against it as well;
   * 8. parse the body — with the route's response schema for a 2xx, and with
   *    the shared error payload for anything else.
   *
   * The timeout therefore bounds the whole call from the moment it is made,
   * credential resolution included, and a cancelled call answers
   * `TRANSPORT_DISCONNECTED` with `details.cancelled` set to `timeout` or
   * `aborted`.
   *
   * @typeParam O The operation, which fixes both the body and the result type.
   * @param operation The operation to call, keyed into the route table.
   * @param args The path parameters, body, abort signal and timeout for this
   * call. Omitted entirely for a route that needs none of them.
   * @returns `ok(body)` with the operation's parsed response, or `err(error)`
   * carrying a renderable code, a message naming the operation, and details
   * limited to the status, the operation and schema-validated payload fields.
   */
  async request<O extends HttpOperation>(
    operation: O,
    args?: HttpRequestArgs<O>,
  ): Promise<Result<HttpResponseBody<O>, DebuggenError>> {
    // First, before anything else runs: a refused base URL names a host this
    // client must never send to, so neither the credential provider nor the
    // transport may be reached — not even for the two exempt operations, whose
    // bodies (a pairing code) are capabilities too (AAP §0.5.6).
    const origin = this.origin;

    if (isErr(origin)) {
      return err(refusedOriginError(operation, origin.error));
    }

    const baseUrl = origin.value;
    const prepared = prepareRoute(operation, args?.params);

    if (isErr(prepared)) {
      return err(prepared.error);
    }

    // The outbound body is validated by the same helper the service validates
    // an inbound body with, so a client cannot send something the service will
    // refuse — and the rejection carries issue paths and codes only, never the
    // project path or the developer's question the body holds (AAP §0.5.2).
    const validated = parseHttpRequest(operation, args?.body);

    if (isErr(validated)) {
      return err(validated.error);
    }

    // Serialisation is fallible in one narrow case worth covering rather than
    // arguing about: a validated body may still carry a value a schema guards
    // only shallowly — the ingest batch's attribute records, for instance — and
    // a cyclic value there would make `JSON.stringify` throw on a method whose
    // contract is that it never rejects.
    const encoded = tryCatch(
      () => (validated.value === undefined ? undefined : JSON.stringify(validated.value)),
      'PROTOCOL_INVALID_MESSAGE',
    );

    if (isErr(encoded)) {
      return err(
        new DebuggenError(
          'PROTOCOL_INVALID_MESSAGE',
          `The ${operation} request body could not be serialised as JSON`,
          {
            hint: 'A value in the body cannot be represented as JSON — a cycle, a function or a BigInt.',
            details: { operation },
            cause: encoded.error,
          },
        ),
      );
    }

    const headers: Record<string, string> = { [ACCEPT_HEADER]: JSON_MEDIA_TYPE };
    const bodyText = encoded.value;

    if (bodyText !== undefined) {
      headers[CONTENT_TYPE_HEADER] = JSON_MEDIA_TYPE;
    }

    const fetchImpl = this.fetchImpl ?? resolveGlobalFetch();

    if (fetchImpl === undefined) {
      return err(
        new DebuggenError(
          'CONFIG_INVALID',
          `Cannot call ${operation}: this runtime provides no fetch implementation`,
          {
            hint: 'Pass { fetch } to the HttpClient constructor.',
            details: { operation },
          },
        ),
      );
    }

    // `new URL` rather than concatenation: the path is absolute and the origin
    // carries no path, so the join cannot produce a double slash or keep a
    // prefix. It cannot fail for a validated origin and an encoded path, but a
    // failure is still returned rather than thrown — with a constant sentence
    // and no `cause`, because the parser's `TypeError` quotes its input.
    const url = tryCatch(() => new URL(prepared.value.path, baseUrl).toString(), 'CONFIG_INVALID');

    if (isErr(url)) {
      return err(
        new DebuggenError(
          'CONFIG_INVALID',
          `Cannot call ${operation}: the request URL could not be built from the service origin`,
          {
            hint: `Configure the service URL as a loopback origin only — scheme, host and port, for example ${SERVICE_ORIGIN_EXAMPLE}.`,
            details: { operation },
          },
        ),
      );
    }

    // The call's cancellation exists before its first asynchronous step, so the
    // caller's signal and the timeout bound credential resolution as well as the
    // request: a credential provider that never settles — a suspended storage
    // read — ends the call at its deadline instead of leaving it pending forever.
    // Disposed on every exit path, so no timer and no listener outlives the call.
    const cancellation = createCallCancellation(
      args?.signal,
      args?.timeoutMs ?? this.defaultTimeoutMs,
    );
    let exchanged: Result<RawReply, DebuggenError>;

    try {
      exchanged = await this.exchange(
        operation,
        baseUrl,
        {
          method: prepared.value.method,
          url: url.value,
          authExempt: prepared.value.authExempt,
          headers,
          body: bodyText,
          fetchImpl,
        },
        cancellation,
      );
    } finally {
      cancellation.dispose();
    }

    if (isErr(exchanged)) {
      return err(exchanged.error);
    }

    const { status, body: rawBody } = exchanged.value;

    // An empty body stands for `{}`, which is a diagnosis rather than a
    // success: every route in the table answers with fields, so an empty reply
    // is judged by the route's schema and rejected as a body missing those
    // fields — a far more useful failure than "not valid JSON", and the right
    // one when a proxy, a redirect or a 204-style reply delivered nothing.
    const decoded = tryCatch(
      () => (rawBody.trim() === '' ? {} : (JSON.parse(rawBody) as unknown)),
      'PROTOCOL_INVALID_MESSAGE',
    );

    if (!exchanged.value.ok) {
      return err(httpFailureError(operation, status, isOk(decoded) ? decoded.value : undefined));
    }

    if (isErr(decoded)) {
      return err(
        new DebuggenError(
          'PROTOCOL_INVALID_MESSAGE',
          `The ${operation} reply was not valid JSON (status ${String(status)})`,
          {
            hint: 'The reply did not come from the Debug Generator local service, or came from a build that speaks a different protocol version.',
            details: { operation, status },
          },
        ),
      );
    }

    const parsed = parseHttpResponse(operation, decoded.value);

    if (isErr(parsed)) {
      return err(withRequestContext(parsed.error, operation, status));
    }

    return parsed;
  }

  /**
   * Asks whether the service is running, and what it speaks.
   *
   * Auth-exempt, and that is the point: `apps/vscode-extension/src/service/discovery.ts`
   * calls this to decide whether to spawn the service, and the DevTools panel
   * calls it to decide between "Not paired" and "Service not running", both
   * before any credential exists. A configured credential is deliberately **not**
   * sent (AAP §0.5.6).
   *
   * @param options An abort signal and a timeout for this call.
   * @returns The service's build version, its protocol version and whether
   * pairing is available — or a failure, which is itself the answer "not
   * running".
   */
  health(options?: HttpCallOptions): Promise<Result<HealthResponse, DebuggenError>> {
    return this.request('health', { ...options });
  }

  /**
   * Redeems a one-time pairing code for this client's own credential.
   *
   * The other auth-exempt operation, and unauthenticated precisely because the
   * code **is** the capability being presented (AAP §0.5.6). The code is
   * therefore treated as a credential everywhere below: it is never logged, and
   * it cannot reach a message, a hint or `details` — a rejected body is reported
   * by issue path and code only, and a refusal by status and operation only.
   *
   * The caller stores the returned token — `apps/chrome-extension/src/background/auth.ts`
   * puts it in `chrome.storage.local` — and hands it to
   * {@link HttpClient.setToken}.
   *
   * @param code The code the developer read from the editor.
   * @param options An abort signal and a timeout for this call.
   * @returns The credential scoped to this client's origin, or a failure.
   */
  pairComplete(
    code: string,
    options?: HttpCallOptions,
  ): Promise<Result<PairCompleteResponse, DebuggenError>> {
    return this.request('pair.complete', { body: { code }, ...options });
  }

  /**
   * Opens a capture window on a session.
   *
   * Named rather than left to {@link HttpClient.request} because of its one
   * documented refusal: at most one session may hold a capture on a project at a
   * time, and a start for a project another session is already capturing answers
   * `409` with that session's id (AAP §0.4.2). That body is the shared error
   * payload **extended** with `owningSessionId`, and because both schemas are
   * strict it parses as the conflict schema and not as the plain payload — so
   * {@link httpFailureError} tries the conflict schema first and this method
   * needs no special case of its own. The id arrives in
   * `error.details.owningSessionId`, which is what lets a caller say *which*
   * session holds the capture and offer to reopen it.
   *
   * @param sessionId The session to open a capture on.
   * @param options An abort signal and a timeout for this call.
   * @returns The new capture's id, or a failure whose `details` name the owning
   * session when the refusal was an ownership conflict.
   */
  startCapture(
    sessionId: string,
    options?: HttpCallOptions,
  ): Promise<Result<CaptureStartResponse, DebuggenError>> {
    return this.request('capture.start', { params: { id: sessionId }, body: {}, ...options });
  }

  /**
   * The cancellable part of a call: resolve the credential, send, read the body.
   *
   * Each asynchronous step is raced against the call's cancellation, and the
   * race is what makes a stalled step harmless: the call ends at its deadline or
   * at the caller's abort whatever the step is doing, and a step that settles
   * afterwards is ignored — a credential that resolves late never reaches the
   * transport, and a reply that arrives late is never read. The transport is
   * also handed the linked signal, so a compliant `fetch` stops the request
   * itself rather than leaving it to finish unobserved.
   *
   * Never rejects: every step raced here is already non-rejecting
   * (`resolveToken` returns a `Result`, and the transport and body promises are
   * wrapped by `fromPromise`), and the cancellation promise only ever fulfils.
   *
   * @param operation The operation being called.
   * @param baseUrl The validated origin, named in a transport failure.
   * @param outbound The request, settled locally by {@link HttpClient.request}.
   * @param cancellation This call's cancellation, disposed of by the caller.
   * @returns The status and body text, or the failure that prevented them.
   */
  private async exchange(
    operation: HttpOperation,
    baseUrl: ServiceOrigin,
    outbound: OutboundRequest,
    cancellation: CallCancellation,
  ): Promise<Result<RawReply, DebuggenError>> {
    const timeoutMs = cancellation.timeoutMs;

    // A caller signal that had already fired when the call was made: nothing
    // is started — no credential is read and the transport is never touched.
    if (cancellation.source !== undefined) {
      return err(cancellationError(operation, cancellation.source, timeoutMs));
    }

    const headers: Record<string, string> = { ...outbound.headers };

    // Exempt in both directions: no credential is demanded for the two exempt
    // operations, and none is sent on them even when one is available.
    if (!outbound.authExempt) {
      const token = await raceCancellation(this.resolveToken(operation), cancellation);

      if (token.cancelled) {
        return err(cancellationError(operation, token.source, timeoutMs));
      }

      if (isErr(token.value)) {
        return err(token.value.error);
      }

      headers[AUTHORIZATION_HEADER] = formatBearer(token.value.value);
    }

    const signal = cancellation.signal;
    const init: HttpFetchInit = {
      method: outbound.method,
      headers,
      credentials: 'omit',
      ...(outbound.body === undefined ? {} : { body: outbound.body }),
      ...(signal === undefined ? {} : { signal }),
    };

    const startedAt = Date.now();
    // Invoked inside `tryCatch` as well as awaited through `fromPromise`: an
    // injected transport may throw synchronously, and this method's contract is
    // that it never rejects. Called detached, never as `outbound.fetchImpl(…)`:
    // the platform `fetch` refuses a receiver other than the global object
    // ("Illegal invocation" in Chromium), and a detached call has none.
    const fetchImpl = outbound.fetchImpl;
    const invoked = tryCatch(() => fetchImpl(outbound.url, init), 'TRANSPORT_DISCONNECTED');

    if (isErr(invoked)) {
      const source = cancellation.source;

      return err(
        source === undefined
          ? this.transportError(operation, baseUrl, timeoutMs, invoked.error)
          : cancellationError(operation, source, timeoutMs),
      );
    }

    const responded = await raceCancellation(
      fromPromise(invoked.value, 'TRANSPORT_DISCONNECTED'),
      cancellation,
    );

    if (responded.cancelled) {
      this.logger.debug('protocol http request did not complete', {
        operation,
        cancelled: responded.source,
        elapsedMs: Date.now() - startedAt,
      });

      return err(cancellationError(operation, responded.source, timeoutMs));
    }

    if (isErr(responded.value)) {
      this.logger.debug('protocol http request did not complete', {
        operation,
        elapsedMs: Date.now() - startedAt,
      });

      return err(this.transportError(operation, baseUrl, timeoutMs, responded.value.error));
    }

    const response = responded.value.value;
    const status = response.status;
    // `text()` is invoked inside `tryCatch` for the reason the transport itself
    // is: an injected response may throw synchronously, and a synchronous throw
    // would escape `fromPromise` and reject this method.
    const readBody = tryCatch(() => response.text(), 'TRANSPORT_DISCONNECTED');
    const rawBody: RacedStep<Result<string, DebuggenError>> = isErr(readBody)
      ? { cancelled: false, value: readBody }
      : await raceCancellation(fromPromise(readBody.value, 'TRANSPORT_DISCONNECTED'), cancellation);

    if (rawBody.cancelled) {
      this.logger.debug('protocol http request did not complete', {
        operation,
        status,
        cancelled: rawBody.source,
        elapsedMs: Date.now() - startedAt,
      });

      return err(cancellationError(operation, rawBody.source, timeoutMs));
    }

    // The only record this client emits for a completed exchange: the
    // operation, the status and the elapsed time. No URL, no header, no body,
    // no credential (AAP §0.5.2).
    this.logger.debug('protocol http request completed', {
      operation,
      status,
      elapsedMs: Date.now() - startedAt,
    });

    if (isErr(rawBody.value)) {
      return err(this.transportError(operation, baseUrl, timeoutMs, rawBody.value.error));
    }

    return ok({ ok: response.ok, status, body: rawBody.value.value });
  }

  /**
   * Resolves the credential for a protected operation.
   *
   * A provider is called per request and may be synchronous or asynchronous, may
   * throw and may reject; all three arrive here as an unauthorized-family
   * failure rather than as an exception. A provider is called as a plain
   * function, so a consumer passing a method must bind it.
   *
   * @param operation The operation being called, for the message only.
   * @returns `ok(token)`, or an `UNAUTHORIZED` failure that names no value.
   */
  private async resolveToken(operation: HttpOperation): Promise<Result<string, DebuggenError>> {
    const source = this.tokenSource;
    let resolved: string | undefined;

    if (typeof source === 'function') {
      const produced = tryCatch(() => source(), 'UNAUTHORIZED');

      if (isErr(produced)) {
        return err(credentialError(operation, 'the credential provider threw'));
      }

      const awaited = await fromPromise(Promise.resolve(produced.value), 'UNAUTHORIZED');

      if (isErr(awaited)) {
        return err(credentialError(operation, 'the credential provider failed'));
      }

      resolved = awaited.value;
    } else {
      resolved = source;
    }

    if (resolved === undefined || resolved === '') {
      return err(credentialError(operation, 'no bearer credential is available'));
    }

    return ok(resolved);
  }

  /**
   * Builds the failure for a request that never produced a response.
   *
   * The service not being started is the overwhelmingly common cause and the one
   * the hint names; a connection dropped mid-body reaches the same path. A call
   * ended by its caller's signal or its timeout does **not**: that is reported
   * by {@link cancellationError}, with the source that fired, even when it
   * surfaced as a transport rejection. The thrown value is kept as `cause` for a
   * developer reading a stack, and nothing from it enters the message: a
   * rejection reason is arbitrary text this client did not produce.
   *
   * The origin is named in the message, the hint and `details`, and that is safe
   * only because it is the validated {@link ServiceOrigin}: a loopback host and
   * port with no user information, never the raw configured value.
   *
   * @param operation The operation that failed.
   * @param baseUrl The validated origin the request was sent to.
   * @param timeoutMs The timeout that applied, when one did.
   * @param cause The normalised rejection reason.
   * @returns A `TRANSPORT_DISCONNECTED` failure naming the operation and origin.
   */
  private transportError(
    operation: HttpOperation,
    baseUrl: ServiceOrigin,
    timeoutMs: number | undefined,
    cause: DebuggenError,
  ): DebuggenError {
    return new DebuggenError(
      'TRANSPORT_DISCONNECTED',
      `The ${operation} request to ${baseUrl} did not complete`,
      {
        hint: `The Debug Generator local service may not be running at ${baseUrl}, or the connection dropped before the reply was read.`,
        details: {
          operation,
          baseUrl,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        cause,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Section F — module-private helpers
//
// Pure functions, each with one reason to exist. None of them reads a global at
// module scope: the two that touch a platform global read it when they are
// called, so importing this module still has no side effect.
// ---------------------------------------------------------------------------

/**
 * Resolves a route's method, concrete path and exemption in one fallible step.
 *
 * Wrapped in `tryCatch` for two throwing cases that are both programming
 * mistakes rather than conditions a developer can produce: `buildPath` throws
 * when the route declares a path parameter the caller omitted, and a table
 * lookup with an operation id that came from untyped JavaScript throws on the
 * property access. AAP §0.5.5 wants both as returned failures — the MV3 service
 * worker must not crash — and `tryCatch` preserves the `DebuggenError` that
 * `buildPath` already raises, including the parameter name it names.
 *
 * @typeParam O The operation.
 * @param operation The operation being prepared.
 * @param params The path parameters the caller supplied.
 * @returns The prepared route, or the failure that prevented it.
 */
function prepareRoute<O extends HttpOperation>(
  operation: O,
  params: HttpPathParams<O> | undefined,
): Result<PreparedRoute, DebuggenError> {
  return tryCatch(() => {
    const route = HTTP_ROUTES[operation];
    const pathParams: Readonly<Record<string, string>> | undefined = params;

    return {
      method: route.method,
      path: buildPath(operation, pathParams),
      authExempt: isAuthExemptOperation(operation),
    };
  }, 'INTERNAL');
}

/**
 * Builds the failure every call of a client whose base URL was refused answers
 * with.
 *
 * `CONFIG_INVALID`, like the refusal it wraps, and built only from values this
 * module produced: a constant sentence naming the operation, the refusal's own
 * constant hint, and `details: { operation, rule }`. The refused value itself is
 * not available here to leak — the constructor never kept it — and the
 * refusal is attached as `cause` so the rule stays reachable to a developer
 * reading a stack.
 *
 * @param operation The operation that was not called.
 * @param refusal The failure {@link parseServiceOrigin} returned at construction.
 * @returns The failure to hand the caller.
 */
function refusedOriginError(operation: HttpOperation, refusal: DebuggenError): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `Cannot call ${operation}: the configured service base URL was refused`,
    {
      ...(refusal.hint === undefined ? {} : { hint: refusal.hint }),
      details: { operation, rule: refusal.details?.rule },
      cause: refusal,
    },
  );
}

/**
 * Resolves the platform `fetch`, at call time and defensively.
 *
 * Read as a property of `globalThis` rather than as a bare identifier, so a
 * runtime without it yields `undefined` instead of a `ReferenceError`, and read
 * per call rather than once at module scope, so a test can stub the global and
 * so importing this module performs no environment lookup.
 *
 * @returns The global transport, or `undefined` when this runtime has none.
 */
function resolveGlobalFetch(): FetchLike | undefined {
  const candidate = globalThis.fetch;

  return typeof candidate === 'function' ? candidate : undefined;
}

/**
 * Builds one call's cancellation: the caller's signal and the call's timeout,
 * linked into one controller whose signal the transport receives.
 *
 * Created by {@link HttpClient.request} before the call's first asynchronous
 * step, so both sources bound everything after it — credential resolution
 * included — and disposed of when the call ends. The first source to fire wins
 * and is recorded; a later one changes nothing. Firing aborts the linked
 * controller (with the caller's own abort reason, when it was the caller) and
 * then fulfils {@link CallCancellation.cancelled}.
 *
 * The platform globals are read here, when a call is made, and feature-detected
 * rather than assumed ({@link CancellationPlatform}): this bundle runs in Node,
 * in an MV3 service worker and in a webview, and a missing global must degrade
 * instead of throwing on the path that was meant to bound a request. Without
 * `AbortController` the transport receives the caller's own signal and the
 * timeout is still enforced by the race; without timers there is no timeout.
 * The caller's signal is never lost — losing a timeout costs patience, whereas
 * losing the caller's signal would leave a disposed view unable to cancel its
 * request.
 *
 * A timeout that is absent, not finite or not positive means "no timeout", as
 * {@link HttpClientOptions.defaultTimeoutMs} documents; one beyond
 * {@link MAX_TIMER_DELAY_MS} is scheduled at that bound.
 *
 * @param callerSignal The caller's signal, when it passed one.
 * @param requestedTimeoutMs The timeout for this call, in milliseconds.
 * @returns The call's cancellation. Its source is already `aborted` when the
 * caller's signal had fired before the call was made.
 */
function createCallCancellation(
  callerSignal: AbortSignal | undefined,
  requestedTimeoutMs: number | undefined,
): CallCancellation {
  const timeoutMs =
    requestedTimeoutMs !== undefined &&
    Number.isFinite(requestedTimeoutMs) &&
    requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : undefined;
  const platform: CancellationPlatform = globalThis;
  const Controller = platform.AbortController;
  const controller =
    (callerSignal !== undefined || timeoutMs !== undefined) && typeof Controller === 'function'
      ? new Controller()
      : undefined;
  // Captured from the executor, which runs synchronously, so `resolve` is set
  // before anything below can fire.
  const settlement: { resolve?: (source: CancellationSource) => void } = {};
  const cancelled = new Promise<CancellationSource>((resolve) => {
    settlement.resolve = resolve;
  });

  let source: CancellationSource | undefined;
  let timerHandle: number | undefined;
  let disposed = false;

  const fire = (fired: CancellationSource, reason: unknown): void => {
    if (source !== undefined || disposed) {
      return;
    }

    source = fired;
    // Aborted before `cancelled` settles, so a transport holding the signal is
    // told to stop in the same turn the call is abandoned.
    controller?.abort(reason);
    settlement.resolve?.(fired);
  };

  const onCallerAbort = (): void => {
    const reason: unknown = callerSignal?.reason;

    fire('aborted', reason);
  };

  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      onCallerAbort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  // Called as a method of `globalThis`, never detached, and only when the call
  // is not already cancelled: a pre-aborted call schedules nothing.
  if (
    source === undefined &&
    timeoutMs !== undefined &&
    typeof platform.setTimeout === 'function'
  ) {
    timerHandle = platform.setTimeout(
      () => {
        timerHandle = undefined;
        fire('timeout', undefined);
      },
      Math.min(timeoutMs, MAX_TIMER_DELAY_MS),
    );
  }

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;

    if (timerHandle !== undefined && typeof platform.clearTimeout === 'function') {
      platform.clearTimeout(timerHandle);
    }

    timerHandle = undefined;
    callerSignal?.removeEventListener('abort', onCallerAbort);
  };

  return {
    signal: controller?.signal ?? callerSignal,
    timeoutMs,
    get source(): CancellationSource | undefined {
      return source;
    },
    cancelled,
    dispose,
  };
}

/**
 * Races one non-rejecting step of a call against the call's cancellation.
 *
 * A step that loses is abandoned, not stopped — the promise may still settle,
 * and nothing observes it when it does — which is exactly what keeps a late
 * credential out of the transport. A step that settles in the same turn the
 * call is cancelled is discarded as well: once a source has fired, the call is
 * over, and reporting the step's outcome instead would make the result depend
 * on microtask order.
 *
 * @typeParam T What the step produces.
 * @param work The step, which must not reject.
 * @param cancellation The call's cancellation.
 * @returns The step's value, or the source that cancelled the call.
 */
async function raceCancellation<T>(
  work: Promise<T>,
  cancellation: CallCancellation,
): Promise<RacedStep<T>> {
  const raced = await Promise.race([
    work.then((value): RacedStep<T> => ({ cancelled: false, value })),
    cancellation.cancelled.then((source): RacedStep<T> => ({ cancelled: true, source })),
  ]);
  const source = cancellation.source;

  return !raced.cancelled && source !== undefined ? { cancelled: true, source } : raced;
}

/**
 * Builds the failure for a call its caller's signal or its timeout ended.
 *
 * `TRANSPORT_DISCONNECTED`, because the service's answer — if it ever comes —
 * will not reach the caller; `details.cancelled` says which source fired, so a
 * user interface can tell "the service is slow" from "you cancelled this". The
 * message is a constant sentence naming the operation and, for a timeout, the
 * milliseconds that elapsed. No `cause`: an abort reason is whatever the caller
 * chose to pass, and the source already says everything this client knows.
 *
 * @param operation The operation that was cancelled.
 * @param source Which source fired first.
 * @param timeoutMs The timeout that applied, when one did.
 * @returns The failure to hand the caller.
 */
function cancellationError(
  operation: HttpOperation,
  source: CancellationSource,
  timeoutMs: number | undefined,
): DebuggenError {
  const details = {
    operation,
    cancelled: source,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };

  if (source === 'timeout') {
    return new DebuggenError(
      'TRANSPORT_DISCONNECTED',
      timeoutMs === undefined
        ? `The ${operation} request timed out`
        : `The ${operation} request timed out after ${String(timeoutMs)} ms`,
      {
        hint: 'The local service did not answer in time. Check that it is running and not stalled, or allow this call a longer timeoutMs.',
        details,
      },
    );
  }

  return new DebuggenError('TRANSPORT_DISCONNECTED', `The ${operation} request was cancelled`, {
    hint: 'The caller cancelled this request before it completed. Nothing was retried; call it again if the result is still wanted.',
    details,
  });
}

/**
 * Builds the failure for a response the service refused.
 *
 * Tries the capture-ownership conflict schema before the shared error payload,
 * in that order for a structural reason rather than a preference: both are
 * strict objects, so a conflict body — the payload plus `owningSessionId` —
 * fails the plain payload schema, and a plain payload fails the conflict schema.
 * A body that parses as neither still produces a renderable failure from the
 * status and the operation alone.
 *
 * Nothing unvalidated is carried: `details` holds the status, the operation and
 * the fields a schema accepted, never the raw body (AAP §0.5.2).
 *
 * @param operation The operation that was refused.
 * @param status The numeric HTTP status.
 * @param body The decoded reply body, or `undefined` when it was not JSON.
 * @returns The failure to hand the caller.
 */
function httpFailureError(operation: HttpOperation, status: number, body: unknown): DebuggenError {
  const conflict = captureStartConflictResponseSchema.safeParse(body);

  if (conflict.success) {
    return refusalError(operation, status, {
      code: conflict.data.code,
      message: conflict.data.message,
      ref: conflict.data.ref,
      owningSessionId: conflict.data.owningSessionId,
    });
  }

  const payload = httpErrorResponseSchema.safeParse(body);

  if (payload.success) {
    return refusalError(operation, status, {
      code: payload.data.code,
      message: payload.data.message,
      ref: payload.data.ref,
      owningSessionId: undefined,
    });
  }

  return refusalError(operation, status, {
    code: undefined,
    message: undefined,
    ref: undefined,
    owningSessionId: undefined,
  });
}

/**
 * Assembles a refusal into a `DebuggenError`.
 *
 * The error payload the service sends carries no `hint` — AAP §0.4.2 fixes that
 * shape at `{ code, message, ref? }` and `../messages/error.ts` holds the line
 * with a drift guard — so the recovery step is derived here: from the resolved
 * code first, which is what separates a web-origin refusal from a refused
 * credential under one `403`, and from the status family only when that code has
 * no remedy of its own (see `refusalHint`).
 *
 * @param operation The operation that was refused.
 * @param status The numeric HTTP status.
 * @param fields What the payload contributed.
 * @returns The failure, with a code a user interface can switch on.
 */
function refusalError(
  operation: HttpOperation,
  status: number,
  fields: RefusalFields,
): DebuggenError {
  const details: Record<string, unknown> = { operation, status };

  if (fields.ref !== undefined) {
    details.ref = fields.ref;
  }

  if (fields.owningSessionId !== undefined) {
    details.owningSessionId = fields.owningSessionId;
  }

  const reported = fields.message === undefined ? '' : `: ${fields.message}`;
  const message = `The ${operation} request failed (status ${String(status)})${reported}`;
  const code = resolveRefusalCode(status, fields.code);
  const hint = refusalHint(code, status);

  return new DebuggenError(code, message, hint === undefined ? { details } : { details, hint });
}

/**
 * Chooses the code a refusal is reported with.
 *
 * The service's own code wins when it sent one — it is already a member of the
 * closed vocabulary, because the payload schema validated it against
 * `DEBUGGEN_ERROR_CODES`, and it is more precise than anything a status can say.
 * The exception is an authentication failure: a `401` or `403` must always reach
 * the caller as an unauthorized-family code, so the DevTools panel can render
 * "Not paired" and open its pairing dialog and the editor can offer a rotation,
 * and a status in that family with an unrelated code is normalised.
 *
 * @param status The numeric HTTP status.
 * @param reported The code the payload carried, when it parsed.
 * @returns The code to report.
 */
function resolveRefusalCode(
  status: number,
  reported: DebuggenErrorCode | undefined,
): DebuggenErrorCode {
  if (reported === undefined) {
    return statusFamilyCode(status);
  }

  if (UNAUTHORIZED_STATUSES.includes(status) && !UNAUTHORIZED_FAMILY_CODES.includes(reported)) {
    return 'UNAUTHORIZED';
  }

  return reported;
}

/**
 * The code for a refusal whose body did not conform to the error contract.
 *
 * A 5xx is the service failing rather than refusing, so it is `INTERNAL`. Any
 * other unconformant reply is a protocol failure: the service either refused
 * with a body this protocol does not define, or something that is not this
 * service answered on its port.
 *
 * @param status The numeric HTTP status.
 * @returns The code to report.
 */
function statusFamilyCode(status: number): DebuggenErrorCode {
  if (UNAUTHORIZED_STATUSES.includes(status)) {
    return 'UNAUTHORIZED';
  }

  if (status === RATE_LIMITED_STATUS) {
    return 'RATE_LIMITED';
  }

  if (status >= SERVER_ERROR_STATUS_FLOOR) {
    return 'INTERNAL';
  }

  return 'PROTOCOL_INVALID_MESSAGE';
}

/**
 * The recovery step for a refusal, or `undefined` when the code and message
 * already say everything a client can act on.
 *
 * The resolved code is consulted first, through {@link REFUSAL_CODE_HINTS},
 * because it is the more precise of the two signals: a `403 FORBIDDEN_ORIGIN`
 * needs the origin policy explained, a `401 PAIRING_EXPIRED` a fresh code, and a
 * `401 UNAUTHORIZED` a new credential. The status family is the fallback for a
 * code with no remedy of its own — a `429` whose body named some other code is
 * still a rate limit, and any `5xx` is the service failing — and any other
 * refusal (`404 SESSION_NOT_FOUND`, a bare `400`) carries none.
 *
 * @param code The code the refusal is reported with, as `resolveRefusalCode`
 *   chose it.
 * @param status The numeric HTTP status.
 * @returns A developer-facing next step, or `undefined`.
 * @example
 * refusalHint('FORBIDDEN_ORIGIN', 403); // the origin-policy hint, never "pair again"
 * refusalHint('INTERNAL', 429); // the rate-limit hint, from the status fallback
 * refusalHint('SESSION_NOT_FOUND', 404); // undefined
 */
function refusalHint(code: DebuggenErrorCode, status: number): string | undefined {
  const specific = REFUSAL_CODE_HINTS[code];

  if (specific !== undefined) {
    return specific;
  }

  if (status === RATE_LIMITED_STATUS) {
    return RATE_LIMITED_HINT;
  }

  if (status >= SERVER_ERROR_STATUS_FLOOR) {
    return SERVER_FAILURE_HINT;
  }

  return undefined;
}

/**
 * Re-reports a schema failure with the request's context attached.
 *
 * `parseHttpResponse` names the operation and renders the offending issue paths,
 * which is what a developer needs to see; what it cannot know is the status the
 * body arrived with. Rather than validate the reply a second time, this rebuilds
 * the same failure with `{ operation, status }` merged into its details and the
 * original kept as `cause`, so the issue list survives and nothing new is
 * invented.
 *
 * @param error The failure `parseHttpResponse` produced.
 * @param operation The operation that was called.
 * @param status The numeric HTTP status the body arrived with.
 * @returns The same failure, with request context in its details.
 */
function withRequestContext(
  error: DebuggenError,
  operation: HttpOperation,
  status: number,
): DebuggenError {
  return new DebuggenError(error.code, error.message, {
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    details: { ...error.details, operation, status },
    cause: error,
  });
}

/**
 * Builds the failure for a protected operation with no usable credential.
 *
 * Nothing about the credential itself appears: not its value, not its length,
 * not whether a provider returned an empty string or nothing at all. The hint
 * names the two ways a client obtains one (AAP §0.5.6).
 *
 * A provider that threw or rejected is reported by the constant `reason`
 * alone, and its own error is deliberately **not** kept as `cause` — exactly as
 * the sibling WebSocket client reports the same failure. A credential store's
 * failure text is arbitrary and can name a storage key or quote the value it
 * could not read, and a `cause` travels wherever the error does: into a log, a
 * user interface, a serialised report (AAP §0.5.2).
 *
 * @param operation The operation that could not be called.
 * @param reason Why no credential was available, in a clause.
 * @returns An `UNAUTHORIZED` failure.
 */
function credentialError(operation: HttpOperation, reason: string): DebuggenError {
  return new DebuggenError('UNAUTHORIZED', `Cannot call ${operation}: ${reason}`, {
    hint: 'Supply a credential with setToken(): the editor reads one from the service home directory, and the DevTools client obtains one by redeeming a pairing code.',
    details: { operation },
  });
}
