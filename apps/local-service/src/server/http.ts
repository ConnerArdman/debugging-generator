/**
 * The local service's HTTP surface: one hono application registered, route by
 * route, from protocol's route table (AAP §0.4.2), behind the access boundary
 * of AAP §0.5.6, with one error shape for every failure (AAP §0.5.5).
 *
 * ## The registration loop is the design
 *
 * No path, method, parameter name or exemption is written in this file. Every
 * route is registered by iterating `@debuggen/protocol`'s `HTTP_OPERATIONS` and
 * reading each `HTTP_ROUTES[operation]` row for its method and its `:id`-form
 * pattern; the handler comes from an exhaustive
 * `Record<HttpOperationId, HttpRouteHandler>` assembled from the six route
 * modules that own HTTP operations:
 *
 * | Module | Operations |
 * | --- | --- |
 * | `./routes/sessions.ts` | the ten session, capture, panel and modification operations |
 * | `./routes/panel-data.ts` | `panel.data` |
 * | `./routes/telemetry.ts` | `telemetry.event` (`POST /telemetry/ingest`) |
 * | `./routes/dev-server.ts` | `devServer.launch`, `devServer.stop` |
 * | `./routes/pair.ts` | `pair.start`, `pair.complete` |
 * | `./routes/health.ts` | `health` |
 *
 * Because the record is keyed by protocol's own operation-id union, a route
 * added to the table without a handler is a **compile error** here, and
 * {@link createHttpApp} re-checks the same property at run time — a missing,
 * extra, duplicated or non-callable handler is an `Err`, never a silent 404.
 * `./routes/binding.ts` owns no HTTP operation (its three handlers answer
 * WebSocket frames through `./ws.ts`), so it contributes nothing here.
 *
 * One route is registered beside the table: `./routes/dev-server.ts`'s
 * folder-owned credential route, which mints a `server-agent` credential for a
 * dev server the developer starts without the launcher
 * (`scripts/dev-instrumented.mjs`). Its method and pattern are the launcher's
 * single definition, read off the object the route module returns, and it is
 * authorized as the protocol operation that module names. A registration whose
 * method and pattern collide with another is refused at construction.
 *
 * ## The request pipeline, outermost first
 *
 * 1. **Origin guard** (every request, matched or not): an `Origin` that
 *    `./auth.ts`'s {@link isAllowedOrigin} refuses — every `http:`/`https:`
 *    web origin, `file:`, `data:`, `null`, anything malformed — is answered
 *    `403 FORBIDDEN_ORIGIN` from `./auth.ts`'s own refusal table before
 *    anything else happens, the two unauthenticated operations included.
 * 2. **Request context**: a short correlation `ref` and a start time are
 *    recorded for the request; after a {@link HttpApp.close} every request is
 *    answered `503` here; the answered request is logged at `debug` with its
 *    operation, pattern, status and duration — never a path, a header or a
 *    body.
 * 3. Per route: **operation binding** (the resolved operation id is put on the
 *    context so the auth middleware, the error boundary and the log all see
 *    it), then the optional **response verifier**, then **authentication** —
 *    `createAuthMiddleware(auth)(operation)`, which applies the origin policy
 *    again, skips only the bearer check for protocol's exempt operations and
 *    sets `principal` — and finally the route module's handler.
 * 4. **Error boundary**: `app.onError` and `app.notFound`, plus the Node
 *    listener's own error handler for a request that could not even be parsed.
 *
 * ⚠️ **No `Access-Control-Allow-Origin` header is set anywhere, and no CORS
 * middleware is installed — deliberately.** Its absence is why a web page on
 * the developer's machine cannot read any response of this service even if it
 * provokes one, and together with the bearer requirement on every
 * state-changing route it is what closes CSRF (AAP §0.5.6). A missing CORS
 * header here is the design, not a bug to fix.
 *
 * ## Where validation happens, decided once
 *
 * Request bodies are validated **by the route modules**, through protocol's
 * table-driven `parseHttpRequest`, and deliberately not again here: each module
 * bounds the body's size before it reads a byte and checks the principal's role,
 * the path parameters and the session binding *before* it looks at the body, so
 * a caller that fails an early step learns nothing about a later one. A second
 * parse in front of the handler would read unbounded bodies and invert that
 * order. Response bodies are validated by the route modules through
 * `parseHttpResponse` as well; this file adds an independent verifier
 * ({@link HttpAppDeps.verifyResponses}, on by default) that re-checks every JSON
 * reply against the operation's response schema — and every non-2xx reply
 * against protocol's error schema — so a drift between a route module and the
 * table fails the integration suites instead of reaching a client. A drifted
 * reply is replaced by a `500`.
 *
 * ## One error shape (AAP §0.5.5: a failure is never presented as a success)
 *
 * Every non-2xx response this service sends carries protocol's
 * `httpErrorResponseSchema` body, `{ code, message, ref? }`, produced by
 * `toErrorPayload` from a `DebuggenError`. Its status is decided by
 * {@link httpStatusForError}: an access-boundary refusal takes the status of
 * `./auth.ts`'s reason table (401, 403 or 429); every other error takes its
 * code's entry in {@link HTTP_ERROR_STATUS_BY_CODE}, which is exhaustive over
 * `@debuggen/shared`'s closed code vocabulary so a new code is a compile error
 * until someone decides its status.
 *
 * The capture-ownership conflict is rendered **by `./routes/sessions.ts`**,
 * which recognises the session manager's typed conflict and answers `409` with
 * `captureStartConflictResponseSchema`, `owningSessionId` intact. The boundary
 * here renders the same body only for a conflict error that was *thrown* to it
 * instead of answered, so the two places can never disagree and the route
 * module never has to double-handle it.
 *
 * A `500` never carries the failure's own words: its message is a fixed
 * sentence, its `ref` ties it to the service log, and the detail is logged
 * through the injected logger (whose deny-list scrubs credentials). A
 * validation failure's message comes from protocol's `describeZodIssues`,
 * which renders issue paths and codes and never a rejected value. No header
 * value, token or body is ever echoed into a response or a log record.
 *
 * ## One server, two protocols
 *
 * This module builds a request listener and owns no socket: `main.ts` creates
 * the single `node:http` server with {@link HttpApp.requestListener} and
 * attaches `./ws.ts`'s WebSocket server to the same instance at protocol's
 * `WS_PATH`. `hono` and `@hono/node-server` are imported here and nowhere else
 * in the workspace, and nothing of either is re-exported. The telemetry routes
 * built here are exposed as {@link HttpApp.telemetry} so `./ws.ts` dispatches
 * relayed `telemetry.event` frames to the very instance that answers
 * `POST /telemetry/ingest`.
 *
 * @example Composition in `main.ts`
 * ```ts
 * const http = createHttpApp({
 *   auth, config, logger,
 *   manager, reopener, orchestrator, sessions: sessionsRepo, panels: panelsRepo,
 *   modifications: modificationsRepo, bindings: clients,
 *   devServers: devServerLookupFromLaunches(launcher),
 *   resolver: panelData, ingest, launcher,
 *   serviceVersion, isPairingAvailable: () => editorConnected(),
 * });
 * if (!http.ok) return http;
 * const server = createServer(http.value.requestListener);
 * const ws = createWsServer({ ..., telemetry: http.value.telemetry });
 * ```
 *
 * @module
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import { RequestError, getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context, Handler, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

import {
  CAPTURE_CONFLICT_ERROR_CODE,
  HTTP_OPERATIONS,
  HTTP_ROUTES,
  captureStartConflictResponseSchema,
  describeZodIssues,
  httpErrorResponseSchema,
  parseHttpResponse,
  toErrorPayload,
} from '@debuggen/protocol';
import type {
  CaptureStartConflictResponse,
  HttpErrorResponse,
  HttpMethod,
  HttpOperationId,
} from '@debuggen/protocol';
import { DebuggenError, err, isErr, newMessageId, ok, tryCatch } from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result } from '@debuggen/shared';

import type { ServiceConfig } from '../config.js';
import { LOG_ERROR_FIELD_KEY, subsystemLogger } from '../logging.js';
import {
  AUTH_FAILURE_REASONS,
  authErrorResponse,
  authFailureStatus,
  createAuthMiddleware,
  isAllowedOrigin,
} from './auth.js';
import type { AuthFailureReason, AuthService, ServerEnv } from './auth.js';
import { createDevServerRoutes } from './routes/dev-server.js';
import type { DevServerRoutesDeps } from './routes/dev-server.js';
import { createHealthRoutes } from './routes/health.js';
import type { HealthRoutesDeps } from './routes/health.js';
import { createPairRoutes } from './routes/pair.js';
import type { PairRoutesDeps } from './routes/pair.js';
import { createPanelDataRoutes } from './routes/panel-data.js';
import type { PanelDataRoutesDeps } from './routes/panel-data.js';
import { createSessionRoutes } from './routes/sessions.js';
import type { SessionRoutesDeps } from './routes/sessions.js';
import { createTelemetryRoutes } from './routes/telemetry.js';
import type { TelemetryRoutes, TelemetryRoutesDeps } from './routes/telemetry.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** The log subsystem binding of this module's records, beside its siblings' `server.*` names. */
const LOG_SUBSYSTEM = 'server.http';

/** The log subsystem binding handed to `./routes/health.ts`, which binds none of its own. */
const HEALTH_LOG_SUBSYSTEM = 'server.health';

/**
 * The request header the origin policy is judged on — the same lower-case name
 * `./auth.ts` reads. Header names are case-insensitive in hono's lookup.
 */
const ORIGIN_HEADER = 'origin';

/** The response header that keeps every error body out of every cache. */
const CACHE_CONTROL_HEADER = 'cache-control';

/** The {@link CACHE_CONTROL_HEADER} value on every response this module renders. */
const NO_STORE = 'no-store';

/** The response header a body's media type is read from by the response verifier. */
const CONTENT_TYPE_HEADER = 'content-type';

/** The media type every route of this service answers with. */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * The `./auth.ts` refusal a web origin is answered with. Typed against its
 * reason table, so a rename there fails to compile here.
 */
const FORBIDDEN_ORIGIN_REASON = 'forbidden-origin' satisfies AuthFailureReason;

/**
 * The fixed message of every `500`: the failure's own words never reach a
 * response body, because they can quote a path, a question or captured data.
 */
const INTERNAL_FAILURE_MESSAGE =
  'The Debug Generator local service failed while answering this request. Its log holds the reason under this ref.';

/**
 * The fixed message of a reply that did not satisfy its protocol schema — a
 * drift between a route module and the route table, never the caller's doing.
 */
const RESPONSE_DRIFT_MESSAGE =
  'The Debug Generator local service built a response that does not match the protocol. Its log holds the reason under this ref.';

/** The message of a request no registered route answers. */
const ROUTE_NOT_FOUND_MESSAGE = 'No Debug Generator service route answers this method and path.';

/** The message of a request that arrived after {@link HttpApp.close}. */
const SHUTTING_DOWN_MESSAGE =
  'The Debug Generator local service is shutting down and accepts no new requests.';

/** The message of a request whose request line or `Host` header could not be read. */
const MALFORMED_REQUEST_MESSAGE =
  'The Debug Generator local service could not read this request’s URL or Host header.';

/** The message of a request hono itself refused to read (an `HTTPException` in the 4xx range). */
const UNREADABLE_REQUEST_MESSAGE = 'The Debug Generator local service could not read this request.';

/**
 * Said in place of a 4xx error's own message when that message would not
 * satisfy protocol's error schema (an empty or over-long sentence). The code
 * still says what went wrong.
 */
const REQUEST_REFUSED_MESSAGE = 'The Debug Generator local service refused this request.';

/** The `details` key the session manager records a capture conflict's owner under. */
const OWNING_SESSION_DETAIL_KEY = 'owningSessionId' satisfies keyof CaptureStartConflictResponse;

/** The lowest status that is not a success. */
const FIRST_FAILURE_STATUS = 400;

/** The lowest server-failure status. */
const FIRST_SERVER_FAILURE_STATUS = 500;

/** The lowest success status. */
const FIRST_SUCCESS_STATUS = 200;

/** The lowest redirect status, which no route of this service answers with. */
const FIRST_REDIRECT_STATUS = 300;

/** The status of a capture-ownership conflict, the one reply whose body extends the error shape. */
const CONFLICT_STATUS = 409;

/* -------------------------------------------------------------------------------------------------
 * The code → status map
 * ---------------------------------------------------------------------------------------------- */

/** Every status a failure answered by this module can carry. */
export type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;

/**
 * The HTTP status of every `DebuggenErrorCode`, defined once for the whole
 * service boundary.
 *
 * Exhaustive by construction: `satisfies Record<DebuggenErrorCode, …>` refuses
 * a missing code and an unknown one, so a code added to `@debuggen/shared`'s
 * closed vocabulary fails to compile here until someone decides how it is
 * answered. The values agree with the route modules' own tables
 * (`./routes/sessions.ts` names the same statuses for the codes it answers):
 *
 * - `400` — a request the transport or the filesystem layer refused.
 * - `401` — not (or no longer) authenticated; `403` — authenticated, but the
 *   origin, role or scope does not permit the act.
 * - `404` — the session or the project does not exist.
 * - `409` — the session's state does not admit the request, including a
 *   capture another session owns.
 * - `422` — a stage refused what it was given to apply (a model output, a
 *   plan, a panel, a patch target).
 * - `429` — pairing is locked out after repeated failures.
 * - `502` — the project's dev server could not be launched; `503` — something
 *   the request needs is unavailable (the dev server, the model provider, a
 *   signal, a transport).
 * - `500` — everything that is the service's own failure.
 *
 * An access-boundary refusal is not read from this table first:
 * {@link httpStatusForError} gives `./auth.ts`'s reason table precedence,
 * because one code (`UNAUTHORIZED`) covers both 401 and 403 refusals.
 */
export const HTTP_ERROR_STATUS_BY_CODE = Object.freeze({
  CONFIG_INVALID: 500,
  FORBIDDEN_ORIGIN: 403,
  PAIRING_EXPIRED: 401,
  PAIRING_INVALID: 401,
  RATE_LIMITED: 429,
  UNAUTHORIZED: 401,
  CAPTURE_ALREADY_ACTIVE: 409,
  CAPTURE_EMPTY: 409,
  SESSION_INVALID_STATE: 409,
  SESSION_NOT_FOUND: 404,
  TAB_NOT_BOUND: 403,
  FS_UNSAFE_PATH: 400,
  PATH_OUTSIDE_PROJECT: 403,
  PROJECT_NOT_FOUND: 404,
  AGENT_NOT_READY: 409,
  DEV_SERVER_LAUNCH_FAILED: 502,
  DEV_SERVER_UNAVAILABLE: 503,
  SERVER_AGENT_NOT_READY: 409,
  CLEANUP_PARTIAL: 500,
  INSTRUMENTATION_INSTALL_FAILED: 500,
  INSTRUMENTATION_UNAVAILABLE: 503,
  MODIFICATION_CONFLICT: 409,
  PATCH_TARGET_NOT_FOUND: 422,
  PATCH_UNSUPPORTED: 422,
  CODE_INDEX_FAILED: 500,
  MODEL_OUTPUT_INVALID: 422,
  MODEL_UNAVAILABLE: 503,
  PANEL_INVALID: 422,
  PANEL_SEMANTIC_INVALID: 422,
  PLAN_INVALID: 422,
  PROTOCOL_INVALID_MESSAGE: 400,
  STORE_ERROR: 500,
  TRANSPORT_DISCONNECTED: 503,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 500,
} as const satisfies Readonly<Record<DebuggenErrorCode, HttpErrorStatus>>);

/**
 * The status an error is answered with at this boundary.
 *
 * An access-boundary refusal — its `details.reason` names an entry of
 * `./auth.ts`'s `AUTH_FAILURE_REASONS` — takes that table's status (401, 403
 * or 429); every other error takes its code's entry in
 * {@link HTTP_ERROR_STATUS_BY_CODE}.
 *
 * @param error Any failure met while answering a request.
 * @returns The HTTP status to answer with.
 *
 * @example
 * ```ts
 * httpStatusForError(new DebuggenError('SESSION_NOT_FOUND', 'No such session.')); // → 404
 * httpStatusForError(new DebuggenError('STORE_ERROR', 'The store failed.'));      // → 500
 * ```
 */
export function httpStatusForError(error: DebuggenError): HttpErrorStatus {
  return authFailureStatus(error) ?? HTTP_ERROR_STATUS_BY_CODE[error.code];
}

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/**
 * One route handler, typed on the service's hono environment so
 * `c.get('principal')` is the principal `./auth.ts`'s middleware resolved.
 * Every route module's handler type is this type under its own name.
 */
export type HttpRouteHandler = Handler<ServerEnv>;

/**
 * What this module itself needs, beyond the route modules' own dependencies:
 * the access boundary's HTTP check, the bind address, the logger, and three
 * optional knobs the integration suites use.
 */
export interface HttpAppOwnDeps {
  /** The access boundary; its HTTP check runs in front of every registered route. */
  readonly auth: Pick<AuthService, 'authorizeHttpRequest'>;

  /**
   * The address the service binds to. Used only as the listener's fallback
   * host for a request that carries no `Host` header (HTTP/1.0), so such a
   * request still resolves to a URL instead of being refused unread.
   */
  readonly config: Pick<ServiceConfig, 'host'>;

  /**
   * The service logger. Required here although optional for each route
   * module: the error boundary must always be able to record why it answered a
   * `500`. Its deny-list is what keeps a credential out of a record.
   */
  readonly logger: Logger;

  /**
   * Whether every JSON reply is re-checked against its protocol schema before
   * it leaves (see the module overview). Defaults to `true`; the composition
   * root may switch it off for a production build, since every route module
   * validates its own replies as well.
   */
  readonly verifyResponses?: boolean | undefined;

  /**
   * Mints the correlation `ref` of one request. Defaults to
   * `@debuggen/shared`'s `newMessageId`, whose twenty characters fit
   * protocol's `ref` bound.
   */
  readonly newRequestRef?: (() => string) | undefined;

  /** A monotonic clock in milliseconds, for request durations. Defaults to `performance.now`. */
  readonly now?: (() => number) | undefined;
}

/**
 * Everything {@link createHttpApp} is built from: the intersection of each
 * HTTP route module's own dependency interface and {@link HttpAppOwnDeps}.
 *
 * Composed rather than restated, so a route's needs are declared once, next
 * to the route: a field a route module adds reaches this aggregate — and
 * therefore the composition root's call — in the same edit. Where two modules
 * carry the same subsystem the field names agree (`sessions`, `bindings`,
 * `auth`, `logger`), so the intersection asks for one object that satisfies
 * both slices: the sessions repository, the client registry and the auth
 * service each do.
 */
export type HttpAppDeps = SessionRoutesDeps &
  PanelDataRoutesDeps &
  TelemetryRoutesDeps &
  DevServerRoutesDeps &
  PairRoutesDeps &
  HealthRoutesDeps &
  HttpAppOwnDeps;

/** One route the application registered, as {@link HttpApp.routes} reports it. */
export interface RegisteredHttpRoute {
  /** The method it answers. */
  readonly method: HttpMethod;
  /** The hono pattern it is registered at, verbatim from its single definition. */
  readonly pattern: string;
  /**
   * The protocol operation it answers, or `undefined` for the folder-owned
   * credential route of `./routes/dev-server.ts`, which is no protocol
   * operation.
   */
  readonly operation: HttpOperationId | undefined;
  /** The protocol operation whose middleware and role table authorize it. */
  readonly authorizedAs: HttpOperationId;
}

/**
 * The built HTTP surface.
 *
 * Owns no socket, no timer and no listener: `main.ts` hands
 * {@link HttpApp.requestListener} to the one `node:http` server it creates.
 */
export interface HttpApp {
  /**
   * The Node request listener: `createServer(app.requestListener)`. It never
   * throws and never rejects; a request it cannot parse is answered with
   * protocol's error body.
   */
  readonly requestListener: RequestListener;

  /**
   * Dispatches one WHATWG `Request` in-process, through exactly the pipeline
   * the listener uses, for the unit and integration suites. Never rejects.
   */
  readonly fetch: (request: Request) => Promise<Response>;

  /**
   * The telemetry routes this application answers `POST /telemetry/ingest`
   * with, whose `handleTelemetryEventFrame` `./ws.ts` dispatches relayed
   * `telemetry.event` frames to — one instance for both doors.
   */
  readonly telemetry: Pick<TelemetryRoutes, 'handleTelemetryEventFrame'>;

  /** Every registered route: the protocol table's seventeen, then the folder-owned one. */
  readonly routes: readonly RegisteredHttpRoute[];

  /**
   * Stops answering: every later request is answered `503
   * TRANSPORT_DISCONNECTED`, so a keep-alive connection that outlives the
   * server's `close()` cannot start new work during shutdown. Idempotent.
   * Nothing else needs releasing — this module opened nothing.
   */
  close(): void;

  /** Whether {@link HttpApp.close} has been called. */
  isClosed(): boolean;
}

/* -------------------------------------------------------------------------------------------------
 * Internal types
 * ---------------------------------------------------------------------------------------------- */

/** What the request-context middleware records about one request. */
interface RequestContext {
  /** The correlation reference an error body of this request carries. */
  readonly ref: string;
  /** When the request entered the pipeline, on the injected monotonic clock. */
  readonly startedAt: number;
  /** The operation the matched route is authorized as, once one matched. */
  operation: HttpOperationId | undefined;
  /** The pattern of the matched route, once one matched. */
  pattern: string | undefined;
}

/** One route module's contribution to the handler record, for the run-time coverage check. */
interface HandlerSlice {
  /** The owning module, for the error that names a duplicate. */
  readonly owner: string;
  /** Its handlers, keyed by protocol operation id. */
  readonly handlers: Readonly<Record<string, unknown>>;
}

/** One route to register: its definition and the handler that answers it. */
interface RouteRegistration extends RegisteredHttpRoute {
  readonly handler: HttpRouteHandler;
}

/** An error body this module renders: the shared shape, or its capture-conflict extension. */
type RenderedErrorBody = HttpErrorResponse | CaptureStartConflictResponse;

/* -------------------------------------------------------------------------------------------------
 * Error bodies
 * ---------------------------------------------------------------------------------------------- */

/**
 * The refusal of a web origin, built from `./auth.ts`'s own reason table so it
 * is indistinguishable from the one its middleware raises: the table's code
 * and constant message, and `details.reason` naming the entry (which is what
 * `authErrorResponse` maps back to `403`).
 */
function forbiddenOriginRefusal(): DebuggenError {
  const descriptor = AUTH_FAILURE_REASONS[FORBIDDEN_ORIGIN_REASON];
  return new DebuggenError(descriptor.code, descriptor.message, {
    details: { reason: FORBIDDEN_ORIGIN_REASON },
  });
}

/** The status and body of every web-origin refusal, computed once: the refusal is constant. */
const FORBIDDEN_ORIGIN_RESPONSE = authErrorResponse(forbiddenOriginRefusal());

/**
 * Builds the body of a failure answered at `status`.
 *
 * - A `5xx` other than `502`/`503` is the service's own failure: its message
 *   is {@link INTERNAL_FAILURE_MESSAGE} and never the error's own words.
 * - Every other failure carries `toErrorPayload`'s projection of the error —
 *   code and message, never the hint — provided the message satisfies
 *   protocol's schema; otherwise {@link REQUEST_REFUSED_MESSAGE} stands in.
 * - A capture conflict whose error names its owning session carries
 *   `owningSessionId`, validated against `captureStartConflictResponseSchema`.
 *
 * @param error The failure.
 * @param status The status it is answered with, from {@link httpStatusForError}.
 * @param ref The request's correlation reference, when one was minted.
 * @param serverFailureMessage The fixed sentence a `500` says; defaults to
 * {@link INTERNAL_FAILURE_MESSAGE}.
 * @returns A body that satisfies protocol's error schema (or its conflict extension).
 */
function errorBodyFor(
  error: DebuggenError,
  status: HttpErrorStatus,
  ref: string | undefined,
  serverFailureMessage: string = INTERNAL_FAILURE_MESSAGE,
): RenderedErrorBody {
  const withRef = (body: HttpErrorResponse): HttpErrorResponse =>
    ref === undefined ? body : { ...body, ref };

  if (status === 500) {
    return withRef({ code: error.code, message: serverFailureMessage });
  }

  const projected = toErrorPayload(error, ref);
  const payload: HttpErrorResponse = httpErrorResponseSchema.safeParse(projected).success
    ? projected
    : withRef({ code: error.code, message: REQUEST_REFUSED_MESSAGE });

  const owningSessionId = error.details?.[OWNING_SESSION_DETAIL_KEY];
  if (
    status === CONFLICT_STATUS &&
    error.code === CAPTURE_CONFLICT_ERROR_CODE &&
    typeof owningSessionId === 'string'
  ) {
    const conflict = captureStartConflictResponseSchema.safeParse({ ...payload, owningSessionId });
    if (conflict.success) {
      return conflict.data;
    }
  }

  return payload;
}

/**
 * Normalises anything that reached the error boundary into the error to
 * answer with and whether it was expected.
 *
 * - A `DebuggenError` is answered as itself: route modules throw one only on
 *   purpose (`./routes/health.ts` throws its `INTERNAL` schema failure here).
 * - A hono `HTTPException` in the 4xx range is a request hono refused to read,
 *   answered `400 PROTOCOL_INVALID_MESSAGE` with a fixed message; its own
 *   response is never forwarded, since its body is not protocol's shape.
 * - Anything else is an unexpected failure, answered `500 INTERNAL`.
 */
function normalizeFailure(caught: unknown): {
  readonly error: DebuggenError;
  readonly expected: boolean;
} {
  if (DebuggenError.is(caught)) {
    return { error: caught, expected: true };
  }
  if (
    caught instanceof HTTPException &&
    caught.status >= FIRST_FAILURE_STATUS &&
    caught.status < FIRST_SERVER_FAILURE_STATUS
  ) {
    return {
      error: new DebuggenError('PROTOCOL_INVALID_MESSAGE', UNREADABLE_REQUEST_MESSAGE, {
        details: { reason: 'request-unreadable', status: caught.status },
      }),
      expected: true,
    };
  }
  return {
    error: new DebuggenError('INTERNAL', INTERNAL_FAILURE_MESSAGE, {
      details: { reason: 'unexpected-throw' },
    }),
    expected: false,
  };
}

/**
 * A complete JSON error `Response`, for the paths that hold no live hono
 * context: the listener's own error handler, the dispatch guard and the
 * response verifier's replacement reply.
 *
 * @param error The failure.
 * @param ref The request's correlation reference, when one was minted.
 * @param serverFailureMessage The fixed sentence a `500` says.
 * @returns The response, with `Cache-Control: no-store`.
 */
function errorResponse(
  error: DebuggenError,
  ref: string | undefined,
  serverFailureMessage?: string,
): Response {
  const status = httpStatusForError(error);
  return Response.json(errorBodyFor(error, status, ref, serverFailureMessage), {
    status,
    headers: { [CACHE_CONTROL_HEADER]: NO_STORE },
  });
}

/**
 * The host the Node listener falls back to for a request without a `Host`
 * header: the bind address, bracketed when it is an IPv6 literal so the URL
 * built from it parses.
 */
function fallbackHostFor(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/* -------------------------------------------------------------------------------------------------
 * Response verification
 * ---------------------------------------------------------------------------------------------- */

/**
 * Checks one reply against the contract it must satisfy, and describes the
 * drift when it does not.
 *
 * - A `2xx` reply of a protocol operation must parse with
 *   `parseHttpResponse(operation, body)`; the folder-owned credential route
 *   has no protocol response schema, and its module validates its own.
 * - A failure reply must carry protocol's error body; a `409` may carry the
 *   capture-conflict extension instead.
 * - A reply that is not JSON, or has a status this service never answers with
 *   (`1xx`, `3xx`), is drift.
 *
 * The description is safe to log: it is built from issue paths and codes by
 * `describeZodIssues`, never from a value in the body.
 *
 * @param response The reply the route produced.
 * @param operation The protocol operation, or `undefined` for the credential route.
 * @returns `undefined` when the reply conforms; a description otherwise.
 */
async function describeResponseDrift(
  response: Response,
  operation: HttpOperationId | undefined,
): Promise<string | undefined> {
  const { status } = response;
  const success = status >= FIRST_SUCCESS_STATUS && status < FIRST_REDIRECT_STATUS;
  if (!success && status < FIRST_FAILURE_STATUS) {
    return 'the reply has a status this service never answers with';
  }
  if (success && operation === undefined) {
    return undefined;
  }

  const contentType = response.headers.get(CONTENT_TYPE_HEADER) ?? '';
  if (!contentType.includes(JSON_MEDIA_TYPE)) {
    return 'the reply is not JSON';
  }

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return 'the reply body is not parseable JSON';
  }

  if (success && operation !== undefined) {
    const parsed = parseHttpResponse(operation, body);
    return isErr(parsed) ? parsed.error.message : undefined;
  }

  if (status === CONFLICT_STATUS && captureStartConflictResponseSchema.safeParse(body).success) {
    return undefined;
  }
  const failure = httpErrorResponseSchema.safeParse(body);
  return failure.success
    ? undefined
    : `the failure body is not protocol's error shape: ${describeZodIssues(failure.error.issues)}`;
}

/* -------------------------------------------------------------------------------------------------
 * Handler coverage
 * ---------------------------------------------------------------------------------------------- */

/**
 * The run-time half of the handler record's exhaustiveness.
 *
 * The compile-time half is the `Record<HttpOperationId, HttpRouteHandler>`
 * annotation in {@link createHttpApp}, which refuses a missing operation. This
 * check adds what the type system cannot see through a spread: an operation
 * two modules both claim (the later would silently win), a key no protocol
 * operation has, and a value that is not callable — and it re-proves coverage
 * against `HTTP_OPERATIONS` so a record assembled around the type system
 * (a cast, a stale build) still cannot register a hole.
 *
 * @param slices Each route module's handler record, with its owner's name.
 * @returns `ok` when the slices partition the table exactly; `err(INTERNAL)`
 * naming the first disagreement otherwise.
 */
function verifyHandlerCoverage(slices: readonly HandlerSlice[]): Result<void, DebuggenError> {
  const claimedBy = new Map<string, string>();

  for (const slice of slices) {
    for (const [operation, handler] of Object.entries(slice.handlers)) {
      if (!Object.hasOwn(HTTP_ROUTES, operation)) {
        return err(
          new DebuggenError(
            'INTERNAL',
            `The route module ${slice.owner} returned a handler for ${operation}, which is no operation of protocol's route table.`,
            { details: { reason: 'extra-handler', owner: slice.owner, operation } },
          ),
        );
      }
      const earlier = claimedBy.get(operation);
      if (earlier !== undefined) {
        return err(
          new DebuggenError(
            'INTERNAL',
            `The operation ${operation} is claimed by both ${earlier} and ${slice.owner}.`,
            { details: { reason: 'duplicate-handler', owner: slice.owner, operation } },
          ),
        );
      }
      if (typeof handler !== 'function') {
        return err(
          new DebuggenError(
            'INTERNAL',
            `The route module ${slice.owner} returned a handler for ${operation} that is not callable.`,
            { details: { reason: 'handler-not-callable', owner: slice.owner, operation } },
          ),
        );
      }
      claimedBy.set(operation, slice.owner);
    }
  }

  for (const operation of HTTP_OPERATIONS) {
    if (!claimedBy.has(operation)) {
      return err(
        new DebuggenError(
          'INTERNAL',
          `No route module answers ${operation}, an operation of protocol's route table.`,
          { details: { reason: 'missing-handler', operation } },
        ),
      );
    }
  }

  return ok(undefined);
}

/**
 * Refuses a registration list in which two routes share a method and a
 * pattern: hono would answer the pair with whichever was registered first, and
 * the other would be unreachable.
 */
function verifyDistinctRoutes(
  registrations: readonly RouteRegistration[],
): Result<void, DebuggenError> {
  const seen = new Set<string>();
  for (const registration of registrations) {
    const key = `${registration.method} ${registration.pattern}`;
    if (seen.has(key)) {
      return err(
        new DebuggenError(
          'INTERNAL',
          `Two routes claim ${registration.method} ${registration.pattern}; the second would be unreachable.`,
          {
            details: {
              reason: 'route-collision',
              authorizedAs: registration.authorizedAs,
              method: registration.method,
            },
          },
        ),
      );
    }
    seen.add(key);
  }
  return ok(undefined);
}

/* -------------------------------------------------------------------------------------------------
 * Assembly
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the six HTTP route modules and turns them into the registration list:
 * protocol's seventeen operations in the table's own order, then the
 * folder-owned credential route.
 *
 * Each factory receives the whole aggregate typed as its own narrow deps
 * interface, so it sees exactly the slice it declared. The factories register
 * nothing; `createDevServerRoutes` refuses a credential-route collision by
 * throwing, which is caught here and returned as the `Err` it is.
 *
 * @param deps The dependency aggregate.
 * @param logger The service logger, for the health module's subsystem binding.
 * @returns The registrations and the telemetry routes, or `err(INTERNAL)`.
 */
function assembleRoutes(
  deps: HttpAppDeps,
  logger: Logger,
): Result<
  { readonly registrations: readonly RouteRegistration[]; readonly telemetry: TelemetryRoutes },
  DebuggenError
> {
  const built = tryCatch(
    () => ({
      sessions: createSessionRoutes(deps),
      panelData: createPanelDataRoutes(deps),
      telemetry: createTelemetryRoutes(deps),
      devServer: createDevServerRoutes(deps),
      pair: createPairRoutes(deps),
      health: createHealthRoutes({
        ...deps,
        logger: subsystemLogger(logger, HEALTH_LOG_SUBSYSTEM),
      }),
    }),
    'INTERNAL',
  );
  if (isErr(built)) {
    return built;
  }
  const modules = built.value;

  // The compile-time half of exhaustiveness: this annotation refuses the
  // object unless every protocol operation has a handler, so a route added to
  // `HTTP_ROUTES` without one fails to build here rather than 404ing.
  const handlers: Readonly<Record<HttpOperationId, HttpRouteHandler>> = {
    ...modules.sessions,
    ...modules.panelData,
    ...modules.telemetry.handlers,
    ...modules.devServer.handlers,
    ...modules.pair,
    ...modules.health,
  };

  // The run-time half: duplicates, extras and non-callables a spread hides.
  const coverage = verifyHandlerCoverage([
    { owner: 'server/routes/sessions.ts', handlers: modules.sessions },
    { owner: 'server/routes/panel-data.ts', handlers: modules.panelData },
    { owner: 'server/routes/telemetry.ts', handlers: modules.telemetry.handlers },
    { owner: 'server/routes/dev-server.ts', handlers: modules.devServer.handlers },
    { owner: 'server/routes/pair.ts', handlers: modules.pair },
    { owner: 'server/routes/health.ts', handlers: modules.health },
  ]);
  if (isErr(coverage)) {
    return coverage;
  }

  const registrations: RouteRegistration[] = HTTP_OPERATIONS.map((operation) => {
    const route = HTTP_ROUTES[operation];
    return {
      method: route.method,
      pattern: route.pattern,
      operation,
      authorizedAs: operation,
      handler: handlers[operation],
    };
  });

  const { credential } = modules.devServer;
  registrations.push({
    method: credential.method,
    pattern: credential.pattern,
    operation: undefined,
    authorizedAs: credential.authorizeAs,
    handler: credential.handler,
  });

  const distinct = verifyDistinctRoutes(registrations);
  if (isErr(distinct)) {
    return distinct;
  }

  return ok({ registrations: Object.freeze(registrations), telemetry: modules.telemetry });
}

/**
 * Builds the service's HTTP surface over protocol's route table.
 *
 * Registers every route of `HTTP_ROUTES` — and the folder-owned dev-server
 * credential route — behind the origin guard, the request context, the
 * operation binding, the response verifier and the per-operation auth
 * middleware, and installs the error boundary. Returns a request listener for
 * `main.ts`'s single `node:http` server; opens no socket, starts no timer and
 * mutates no global (`@hono/node-server`'s global `Request`/`Response`
 * override is declined, so building an application has no side effect).
 *
 * @param deps Every collaborator, by injection: the route modules' own deps,
 * the access boundary, the bind address and the logger.
 * @returns The application, or `err(INTERNAL)` when the route modules and the
 * route table disagree — a missing, extra, duplicated or colliding route — or
 * a route module refused to build.
 *
 * @example
 * ```ts
 * const http = createHttpApp(deps);
 * if (!http.ok) {
 *   return http;
 * }
 * const server = createServer(http.value.requestListener);
 * ```
 */
export function createHttpApp(deps: HttpAppDeps): Result<HttpApp, DebuggenError> {
  const log = subsystemLogger(deps.logger, LOG_SUBSYSTEM);
  const verifyResponses = deps.verifyResponses ?? true;
  const newRef = deps.newRequestRef ?? newMessageId;
  const now = deps.now ?? ((): number => performance.now());

  const assembled = assembleRoutes(deps, deps.logger);
  if (isErr(assembled)) {
    log.error('The HTTP surface could not be assembled from the route table', {
      errorCode: assembled.error.code,
      [LOG_ERROR_FIELD_KEY]: assembled.error,
    });
    return assembled;
  }
  const { registrations, telemetry } = assembled.value;

  /** Per-request facts, keyed by the request object hono carries through the pipeline. */
  const contexts = new WeakMap<Request, RequestContext>();
  let closed = false;

  /** Answers a failure on a live hono context, with the request's ref and no caching. */
  const renderFailure = (
    c: Context<ServerEnv>,
    error: DebuggenError,
    status: HttpErrorStatus,
  ): Response => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    return c.json(errorBodyFor(error, status, contexts.get(c.req.raw)?.ref), status);
  };

  /*
   * 1. The origin guard — outermost, for every request including the two
   * auth-exempt operations and paths no route answers. The decision is
   * `./auth.ts`'s `isAllowedOrigin`; the answer is its own refusal.
   */
  const originGuard: MiddlewareHandler<ServerEnv> = async (c, next) => {
    if (!isAllowedOrigin(c.req.header(ORIGIN_HEADER))) {
      log.debug('Refused a request from an origin this service never serves', {
        method: c.req.method,
        status: FORBIDDEN_ORIGIN_RESPONSE.status,
      });
      c.header(CACHE_CONTROL_HEADER, NO_STORE);
      return c.json(FORBIDDEN_ORIGIN_RESPONSE.body, FORBIDDEN_ORIGIN_RESPONSE.status);
    }
    await next();
    return undefined;
  };

  /*
   * 2. The request context: the correlation ref, the start time, the
   * shutdown gate and the one `debug` record per answered request.
   */
  const requestContext: MiddlewareHandler<ServerEnv> = async (c, next) => {
    const context: RequestContext = {
      ref: newRef(),
      startedAt: now(),
      operation: undefined,
      pattern: undefined,
    };
    contexts.set(c.req.raw, context);

    if (closed) {
      return renderFailure(
        c,
        new DebuggenError('TRANSPORT_DISCONNECTED', SHUTTING_DOWN_MESSAGE, {
          details: { reason: 'service-closing' },
        }),
        HTTP_ERROR_STATUS_BY_CODE.TRANSPORT_DISCONNECTED,
      );
    }

    await next();

    log.debug('Answered an HTTP request', {
      method: c.req.method,
      operation: context.operation,
      pattern: context.pattern,
      status: c.res.status,
      durationMs: Math.max(0, now() - context.startedAt),
      ref: context.ref,
    });
    return undefined;
  };

  /*
   * 3a. The operation binding: the matched route's operation onto the context
   * and the request record, before authentication, so a refusal is logged
   * under the operation it refused.
   */
  const bindOperation =
    (registration: RegisteredHttpRoute): MiddlewareHandler<ServerEnv> =>
    async (c, next) => {
      const context = contexts.get(c.req.raw);
      if (context !== undefined) {
        context.operation = registration.authorizedAs;
        context.pattern = registration.pattern;
      }
      c.set('operation', registration.authorizedAs);
      await next();
      return undefined;
    };

  /*
   * 3b. The response verifier: after the route (and any refusal of the auth
   * middleware) answered, re-check the reply against its contract. A drifted
   * reply is replaced wholesale — `c.res = undefined` first, so none of the
   * drifted reply's headers are merged into the replacement.
   */
  const verifyReply =
    (operation: HttpOperationId | undefined): MiddlewareHandler<ServerEnv> =>
    async (c, next) => {
      await next();
      if (!verifyResponses) {
        return undefined;
      }
      const drift = await describeResponseDrift(c.res, operation);
      if (drift === undefined) {
        return undefined;
      }
      const ref = contexts.get(c.req.raw)?.ref;
      log.error('A route answered with a reply its protocol contract refuses; answering 500', {
        operation,
        status: c.res.status,
        drift,
        ref,
      });
      c.res = undefined;
      c.res = errorResponse(
        new DebuggenError('INTERNAL', RESPONSE_DRIFT_MESSAGE, {
          details: { reason: 'response-drift' },
        }),
        ref,
        RESPONSE_DRIFT_MESSAGE,
      );
      return undefined;
    };

  const app = new Hono<ServerEnv>();
  app.use(originGuard);
  app.use(requestContext);

  // 3c. Authentication per operation: the origin policy again, the exemption
  // decided by protocol's own `authExempt` flag, the bearer credential and the
  // operation's role table, all inside `./auth.ts`. No CORS middleware and no
  // `Access-Control-Allow-Origin` header, anywhere — see the module overview.
  const authFor = createAuthMiddleware(deps.auth);

  const registered = tryCatch(() => {
    for (const registration of registrations) {
      app.on(
        registration.method,
        registration.pattern,
        bindOperation(registration),
        verifyReply(registration.operation),
        authFor(registration.authorizedAs),
        registration.handler,
      );
    }
  }, 'INTERNAL');
  if (isErr(registered)) {
    log.error('The HTTP router refused a route of the table', {
      errorCode: registered.error.code,
      [LOG_ERROR_FIELD_KEY]: registered.error,
    });
    return registered;
  }

  // 4. The error boundary: one error shape for every failure.
  app.onError((caught, c) => {
    const { error, expected } = normalizeFailure(caught);
    const status = httpStatusForError(error);
    const context = contexts.get(c.req.raw);
    const fields = {
      operation: context?.operation,
      pattern: context?.pattern,
      status,
      errorCode: error.code,
      ref: context?.ref,
    };
    if (expected && status < FIRST_SERVER_FAILURE_STATUS) {
      log.warn('A route raised a failure; answering it at its status', fields);
    } else {
      log.error('A route failed; answering with the protocol error body', {
        ...fields,
        [LOG_ERROR_FIELD_KEY]: caught,
      });
    }
    return renderFailure(c, error, status);
  });

  app.notFound((c) =>
    renderFailure(
      c,
      new DebuggenError('PROTOCOL_INVALID_MESSAGE', ROUTE_NOT_FOUND_MESSAGE, {
        details: { reason: 'route-not-found' },
      }),
      404,
    ),
  );

  /**
   * The dispatch guard: the application's `fetch`, with a failure that
   * escaped hono's boundary (a thrown non-`Error`) answered rather than
   * rejected.
   */
  const dispatch = async (request: Request): Promise<Response> => {
    try {
      return await app.fetch(request);
    } catch (caught) {
      const ref = contexts.get(request)?.ref ?? newRef();
      log.error('An HTTP request failed outside the error boundary; answering 500', {
        ref,
        [LOG_ERROR_FIELD_KEY]: caught,
      });
      return errorResponse(normalizeFailure(caught).error, ref);
    }
  };

  /**
   * The listener's own error handler: a request `@hono/node-server` could not
   * turn into a `Request` at all (an unreadable URL or `Host` header) is
   * answered with protocol's error body instead of the adapter's bodiless
   * `400`.
   */
  const listenerFailure = (caught: unknown): Response => {
    const ref = newRef();
    if (caught instanceof RequestError) {
      log.debug('Refused a request whose URL or Host header could not be read', { ref });
      return errorResponse(
        new DebuggenError('PROTOCOL_INVALID_MESSAGE', MALFORMED_REQUEST_MESSAGE, {
          details: { reason: 'request-malformed' },
        }),
        ref,
      );
    }
    log.error('The HTTP listener failed before the application ran; answering 500', {
      ref,
      [LOG_ERROR_FIELD_KEY]: caught,
    });
    return errorResponse(normalizeFailure(caught).error, ref);
  };

  const nodeListener = getRequestListener(dispatch, {
    hostname: fallbackHostFor(deps.config.host),
    overrideGlobalObjects: false,
    errorHandler: listenerFailure,
  });

  const requestListener: RequestListener = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    nodeListener(request, response).catch((caught: unknown) => {
      log.error('The HTTP listener failed while writing a response', {
        [LOG_ERROR_FIELD_KEY]: caught,
      });
      if (!response.headersSent) {
        const body = errorBodyFor(
          normalizeFailure(caught).error,
          HTTP_ERROR_STATUS_BY_CODE.INTERNAL,
          undefined,
        );
        response.writeHead(HTTP_ERROR_STATUS_BY_CODE.INTERNAL, {
          [CONTENT_TYPE_HEADER]: JSON_MEDIA_TYPE,
          [CACHE_CONTROL_HEADER]: NO_STORE,
        });
        response.end(JSON.stringify(body));
      } else if (!response.writableEnded) {
        response.destroy();
      }
    });
  };

  const routes: readonly RegisteredHttpRoute[] = Object.freeze(
    registrations.map(({ method, pattern, operation, authorizedAs }) =>
      Object.freeze({ method, pattern, operation, authorizedAs }),
    ),
  );

  log.debug('The HTTP surface is assembled from the route table', {
    routeCount: routes.length,
    verifyResponses,
  });

  return ok(
    Object.freeze({
      requestListener,
      fetch: dispatch,
      telemetry: Object.freeze({ handleTelemetryEventFrame: telemetry.handleTelemetryEventFrame }),
      routes,
      close(): void {
        if (!closed) {
          closed = true;
          log.info('The HTTP surface is closed; later requests are answered 503');
        }
      },
      isClosed(): boolean {
        return closed;
      },
    }),
  );
}
