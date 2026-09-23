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
 * only logging is one `debug` record per call with the operation, the status and
 * the elapsed milliseconds.
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
 * own integration suites. Nothing inside `src/**` imports this module.
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

/**
 * What `URL.origin` answers for a URL whose scheme has no origin — `file:`,
 * `data:` — and therefore the one value {@link normalizeBaseUrl} must not adopt
 * as a base.
 */
const OPAQUE_ORIGIN = 'null';

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

  /** The abort signal, when the caller supplied one or a timeout applies. */
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
 * The statics this client feature-detects on `AbortSignal`.
 *
 * Both members are declared **optional** although the DOM lib types them as
 * always present, and that is the point: this bundle runs in three runtimes and
 * a static that is missing must degrade to "no timeout", never throw. Declaring
 * them optional is what makes the runtime check below type-checkable instead of
 * dead code the compiler has to be argued out of.
 */
interface AbortSignalStatics {
  /** `AbortSignal.timeout(ms)`, when the runtime provides it. */
  readonly timeout?: (milliseconds: number) => AbortSignal;

  /**
   * `AbortSignal.any(signals)`, when the runtime provides it.
   *
   * The array is mutable because that is how the DOM lib declares the
   * parameter; a `readonly` array would not satisfy it.
   */
  readonly any?: (signals: AbortSignal[]) => AbortSignal;
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
   * another port. Only the **origin** is used (see {@link normalizeBaseUrl}).
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
   * which operation it is waiting on.
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
 * @example
 * ```ts
 * const client = new HttpClient({ baseUrl, token: () => readPairedToken() });
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
   * The normalised base URL — the origin of the configured value.
   *
   * Public because both user interfaces show it: the DevTools panel's
   * `ConnectionStatus` pill and the editor's `StatusBar` say which service they
   * are talking to, and neither should re-derive it from configuration.
   */
  readonly baseUrl: string;

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
   * @param options The base URL, and optionally a credential, a transport, a
   * logger and a default timeout.
   */
  constructor(options: HttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
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
   * not reach the service when it fails: resolve the route and encode the path;
   * validate the outbound body against the route's own schema; resolve the
   * credential unless the operation is exempt; then send, read the body as text,
   * and parse it — with the route's response schema for a 2xx, and with the
   * shared error payload for anything else.
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

    // Exempt in both directions: no credential is demanded for the two exempt
    // operations, and none is sent on them even when one is available.
    if (!prepared.value.authExempt) {
      const token = await this.resolveToken(operation);

      if (isErr(token)) {
        return err(token.error);
      }

      headers[AUTHORIZATION_HEADER] = formatBearer(token.value);
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

    // `new URL` rather than concatenation: the path is absolute, so a trailing
    // slash on the configured base URL cannot produce a double slash.
    const url = tryCatch(
      () => new URL(prepared.value.path, this.baseUrl).toString(),
      'CONFIG_INVALID',
    );

    if (isErr(url)) {
      return err(
        new DebuggenError(
          'CONFIG_INVALID',
          `Cannot call ${operation}: ${this.baseUrl} is not a usable service base URL`,
          {
            hint: 'Configure the service base URL as an absolute origin, for example http://127.0.0.1:<port>.',
            details: { operation, baseUrl: this.baseUrl },
            cause: url.error,
          },
        ),
      );
    }

    const timeoutMs = args?.timeoutMs ?? this.defaultTimeoutMs;
    const signal = combineAbortSignals(args?.signal, timeoutMs);
    const init: HttpFetchInit = {
      method: prepared.value.method,
      headers,
      credentials: 'omit',
      ...(bodyText === undefined ? {} : { body: bodyText }),
      ...(signal === undefined ? {} : { signal }),
    };

    const startedAt = Date.now();
    // Invoked inside `tryCatch` as well as awaited through `fromPromise`: an
    // injected transport may throw synchronously, and this method's contract is
    // that it never rejects.
    const invoked = tryCatch(() => fetchImpl(url.value, init), 'TRANSPORT_DISCONNECTED');

    if (isErr(invoked)) {
      return err(this.transportError(operation, timeoutMs, invoked.error));
    }

    const responded = await fromPromise(invoked.value, 'TRANSPORT_DISCONNECTED');

    if (isErr(responded)) {
      this.logger.debug('protocol http request did not complete', {
        operation,
        elapsedMs: Date.now() - startedAt,
      });

      return err(this.transportError(operation, timeoutMs, responded.error));
    }

    const response = responded.value;
    const status = response.status;
    // `text()` is invoked inside `tryCatch` for the reason the transport itself
    // is: an injected response may throw synchronously, and a synchronous throw
    // would escape `fromPromise` and reject this method.
    const readBody = tryCatch(() => response.text(), 'TRANSPORT_DISCONNECTED');
    const rawBody = isErr(readBody)
      ? readBody
      : await fromPromise(readBody.value, 'TRANSPORT_DISCONNECTED');

    // The only record this client emits: the operation, the status and the
    // elapsed time. No URL, no header, no body, no credential (AAP §0.5.2).
    this.logger.debug('protocol http request completed', {
      operation,
      status,
      elapsedMs: Date.now() - startedAt,
    });

    if (isErr(rawBody)) {
      return err(this.transportError(operation, timeoutMs, rawBody.error));
    }

    // An empty body stands for `{}`, which is a diagnosis rather than a
    // success: every route in the table answers with fields, so an empty reply
    // is judged by the route's schema and rejected as a body missing those
    // fields — a far more useful failure than "not valid JSON", and the right
    // one when a proxy, a redirect or a 204-style reply delivered nothing.
    const decoded = tryCatch(
      () => (rawBody.value.trim() === '' ? {} : (JSON.parse(rawBody.value) as unknown)),
      'PROTOCOL_INVALID_MESSAGE',
    );

    if (!response.ok) {
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
        return err(credentialError(operation, 'the credential provider threw', produced.error));
      }

      const awaited = await fromPromise(Promise.resolve(produced.value), 'UNAUTHORIZED');

      if (isErr(awaited)) {
        return err(credentialError(operation, 'the credential provider failed', awaited.error));
      }

      resolved = awaited.value;
    } else {
      resolved = source;
    }

    if (resolved === undefined || resolved === '') {
      return err(credentialError(operation, 'no bearer credential is available', undefined));
    }

    return ok(resolved);
  }

  /**
   * Builds the failure for a request that never produced a response.
   *
   * The service not being started is the overwhelmingly common cause and the one
   * the hint names; an aborted call and a connection dropped mid-body reach the
   * same path. The thrown value is kept as `cause` for a developer reading a
   * stack, and nothing from it enters the message: a rejection reason is
   * arbitrary text this client did not produce.
   *
   * @param operation The operation that failed.
   * @param timeoutMs The timeout that applied, when one did.
   * @param cause The normalised rejection reason.
   * @returns A `TRANSPORT_DISCONNECTED` failure naming the operation and origin.
   */
  private transportError(
    operation: HttpOperation,
    timeoutMs: number | undefined,
    cause: DebuggenError,
  ): DebuggenError {
    return new DebuggenError(
      'TRANSPORT_DISCONNECTED',
      `The ${operation} request to ${this.baseUrl} did not complete`,
      {
        hint: `The Debug Generator local service may not be running at ${this.baseUrl}, or the request was cancelled.`,
        details: {
          operation,
          baseUrl: this.baseUrl,
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
 * Reduces the configured base URL to the origin this client sends to.
 *
 * Only the origin is used, because every path in the route table is absolute:
 * `new URL('/x', 'http://host:1/ignored')` resolves to `http://host:1/x`, so a
 * path prefix in the configured value would be silently dropped. Reducing it
 * here makes that explicit and gives both user interfaces one canonical string
 * to display.
 *
 * Deliberately non-throwing. A malformed value is returned trimmed, and the
 * first call then fails with `CONFIG_INVALID` — a constructor that threw would
 * be a constructor an extension has to guard, and AAP §0.5.5 makes a
 * misconfiguration a renderable state.
 *
 * @param baseUrl The configured value.
 * @returns The origin, or the trimmed input when it has none.
 */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const parsed = tryCatch(() => new URL(trimmed), 'CONFIG_INVALID');

  if (!isOk(parsed)) {
    return trimmed;
  }

  const origin = parsed.value.origin;

  return origin === OPAQUE_ORIGIN ? trimmed : origin;
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
 * Combines a caller's abort signal with a timeout, using only statics the
 * runtime actually provides.
 *
 * Feature-detected rather than assumed: this bundle runs in Node, in an MV3
 * service worker and in a webview, and a missing static must degrade to "no
 * timeout" instead of throwing on the path that was meant to bound a request.
 * When the caller supplied a signal and the runtime cannot combine two, the
 * caller's signal wins — losing a timeout costs patience, whereas losing the
 * caller's signal would leave a disposed view unable to cancel its request.
 *
 * @param callerSignal The caller's signal, when it passed one.
 * @param timeoutMs The timeout in milliseconds, when one applies.
 * @returns The signal to send, or `undefined` when neither applies.
 */
function combineAbortSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return callerSignal;
  }

  const statics: AbortSignalStatics | undefined = globalThis.AbortSignal;

  if (statics === undefined || typeof statics.timeout !== 'function') {
    return callerSignal;
  }

  const timeoutSignal = statics.timeout(timeoutMs);

  if (callerSignal === undefined) {
    return timeoutSignal;
  }

  if (typeof statics.any !== 'function') {
    return callerSignal;
  }

  return statics.any([callerSignal, timeoutSignal]);
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
 * with a drift guard — so the recovery step is derived from the status family
 * here, which is the one thing a client knows that the payload does not say.
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
  const hint = refusalHint(status);

  return new DebuggenError(
    resolveRefusalCode(status, fields.code),
    message,
    hint === undefined ? { details } : { details, hint },
  );
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
 * The recovery step for a status family, or `undefined` when the code and
 * message already say everything a client can act on.
 *
 * @param status The numeric HTTP status.
 * @returns A developer-facing next step, or `undefined`.
 */
function refusalHint(status: number): string | undefined {
  if (UNAUTHORIZED_STATUSES.includes(status)) {
    return 'The local service refused this credential. Pair this client again, or supply the rotated credential with setToken().';
  }

  if (status === RATE_LIMITED_STATUS) {
    return 'The local service is rate-limiting this client. Wait for the lockout to elapse before retrying.';
  }

  if (status >= SERVER_ERROR_STATUS_FLOOR) {
    return 'The local service failed while handling this request; its log names the stage that failed.';
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
 * @param operation The operation that could not be called.
 * @param reason Why no credential was available, in a clause.
 * @param cause The provider's failure, when a provider produced one.
 * @returns An `UNAUTHORIZED` failure.
 */
function credentialError(
  operation: HttpOperation,
  reason: string,
  cause: DebuggenError | undefined,
): DebuggenError {
  return new DebuggenError('UNAUTHORIZED', `Cannot call ${operation}: ${reason}`, {
    hint: 'Supply a credential with setToken(): the editor reads one from the service home directory, and the DevTools client obtains one by redeeming a pairing code.',
    details: { operation },
    ...(cause === undefined ? {} : { cause }),
  });
}
