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
 * `Record<HttpOperationId, HttpRouteHandler>` assembled from the seven route
 * modules that own protocol's twenty HTTP operations:
 *
 * | Module | Operations |
 * | --- | --- |
 * | `./routes/sessions.ts` | the twelve session, capture, target-request, panel and modification operations, `session.purge` (the on-demand retention sweep) among them |
 * | `./routes/panel-data.ts` | `panel.data` |
 * | `./routes/telemetry.ts` | `telemetry.event` (`POST /telemetry/ingest`) |
 * | `./routes/dev-server.ts` | `devServer.launch`, `devServer.stop`, `devServer.credential` |
 * | `./routes/pair.ts` | `pair.start`, `pair.complete` |
 * | `./routes/credentials.ts` | `credentials.rotate` |
 * | `./routes/health.ts` | `health` |
 *
 * Because the record is keyed by protocol's own operation-id union, a route
 * added to the table without a handler is a **compile error** here, and
 * {@link createHttpApp} re-checks the same property at run time — a missing,
 * extra, duplicated or non-callable handler is an `Err`, never a silent 404.
 * `./routes/binding.ts` owns no HTTP operation (its three handlers answer
 * WebSocket frames through `./ws.ts`), so it contributes nothing here.
 *
 * The table is the whole surface: no route is registered beside it, so every
 * route this service answers is one a client can discover through protocol's
 * table and one every table-driven suite enumerates. A registration whose
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
 * 3. Per route: **operation binding** (the route's operation id is put on the
 *    context so the auth middleware, the error boundary and the log all see
 *    it), then the **response verifier**, then **authentication** —
 *    `createAuthMiddleware(auth)(operation)`, which applies the origin policy
 *    again, skips only the bearer check for protocol's exempt operations and
 *    sets `principal` — then the **request-body guard**, and finally the route
 *    module's handler.
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
 * refuses a declared `Content-Length` above its bound before it reads a byte,
 * and checks the principal's role, the path parameters and the session binding
 * *before* it looks at the body, so a caller that fails an early step learns
 * nothing about a later one. A second parse in front of the handler would read
 * every body before those checks and invert that order.
 *
 * What this file does own is **how much, and for how long, a body can be
 * read** — which a declared length cannot settle, because a chunked body
 * declares none. The request-body guard swaps each request's body for a lazy
 * stream that counts bytes as the route reads them and errors at the
 * operation's own bound ({@link REQUEST_BODY_LIMIT_BYTES}, the route modules'
 * exported constants) or when the body has not arrived within
 * {@link HttpAppOwnDeps.requestBodyTimeoutMs}. A route therefore never holds
 * more than its bound plus one chunk, and never waits on a trickling body
 * indefinitely: its `c.req.text()` rejects with the guard's refusal, which the
 * route answers `413` or `408`; the guard makes sure that is the status sent.
 * The rest of a refused body is read and dropped for a bounded moment, so a
 * client still sending receives the refusal rather than a connection reset.
 *
 * Response bodies are validated **once**, by the route modules, through
 * `parseHttpResponse` before they are serialized. This file adds an
 * independent verifier ({@link HttpAppOwnDeps.verifyResponses}) whose default
 * `bounded` mode costs nothing per success reply: it checks every reply's
 * status class and media type, and every failure reply's body — read at most
 * sixteen kibibytes deep — against protocol's error schema. It does **not**
 * re-parse success bodies, which would clone, parse and re-validate every
 * panel-data page and trace a second time. A suite or composition root that
 * wants that belt-and-braces check opts into `full` mode. A drifted reply is
 * replaced by a `500`.
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
 * sentence and its `ref` ties it to the service log. Every error sink of this
 * module logs a caught value the same way — the request's `ref` (the one its
 * error body carries), `../logging.ts`'s closed `describeException`
 * classification (`errorClass`, and `errorCode` where the value has a
 * closed-vocabulary code), and the value itself **only** under
 * `LOG_ERROR_FIELD_KEY`, whose serializer is the single place that decides what
 * of a message or stack a record may hold. No sink copies an exception's
 * `name`, `message` or string form into a field of its own. The serializer
 * adds the redacted message and stack only to a record written at `debug` or
 * `trace`, so every `warn`/`error` record of a caught value is followed by a
 * `debug` twin — the same fields, the same `ref`, the value under
 * `LOG_ERROR_FIELD_KEY` and the constant `EXCEPTION_DIAGNOSTIC_MESSAGE` — which
 * is where a developer who opted into `debug` reads why a request failed. Every
 * `ref` is minted by the service (`newRequestRef`); no header, path parameter
 * or body value is ever used as one. A validation
 * failure's message comes from protocol's `describeZodIssues`, which renders
 * issue paths and codes and never a rejected value. No header value, token or
 * body is ever echoed into a response or a log record.
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
 *   retention: { purge: () => runRetention(retentionDeps) },
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
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';

import type { ServiceConfig } from '../config.js';
import { LOG_ERROR_FIELD_KEY, describeException, subsystemLogger } from '../logging.js';
import {
  FAILURE_COPY_BY_CODE,
  authorProductText,
  isProductAuthoredText,
} from '../sessions/progress.js';
import {
  AUTH_FAILURE_REASONS,
  authErrorResponse,
  authFailureStatus,
  createAuthMiddleware,
  isAllowedOrigin,
} from './auth.js';
import type { AuthFailureReason, AuthService, ServerEnv } from './auth.js';
import {
  MAX_CREDENTIALS_REQUEST_BODY_BYTES,
  createCredentialsRoutes,
} from './routes/credentials.js';
import type { CredentialsRoutesDeps } from './routes/credentials.js';
import { MAX_DEV_SERVER_REQUEST_BODY_BYTES, createDevServerRoutes } from './routes/dev-server.js';
import type { DevServerRoutesDeps } from './routes/dev-server.js';
import { createHealthRoutes } from './routes/health.js';
import type { HealthRoutesDeps } from './routes/health.js';
import { MAX_PAIR_REQUEST_BODY_BYTES, createPairRoutes } from './routes/pair.js';
import type { PairRoutesDeps } from './routes/pair.js';
import { MAX_PANEL_DATA_REQUEST_BODY_BYTES, createPanelDataRoutes } from './routes/panel-data.js';
import type { PanelDataRoutesDeps } from './routes/panel-data.js';
import {
  MAX_EMPTY_BODY_BYTES,
  MAX_SESSION_CREATE_BODY_BYTES,
  MAX_SESSION_QUESTION_BODY_BYTES,
  createSessionRoutes,
} from './routes/sessions.js';
import type { SessionRoutesDeps } from './routes/sessions.js';
import {
  MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES,
  createTelemetryRoutes,
} from './routes/telemetry.js';
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

/**
 * The message of the `debug` twin that follows every `warn` or `error` record
 * of a caught value at this module's error sinks (see `logDiagnosticTwin` in
 * {@link createHttpApp}).
 *
 * Constant like every record message of this module: the twin is found by its
 * `ref` — the ref of the record it follows and of the error body the request
 * was answered with — and what it adds, the value's message and stack after
 * `../logging.ts`'s diagnostic redaction, sits under `LOG_ERROR_FIELD_KEY`.
 */
const EXCEPTION_DIAGNOSTIC_MESSAGE = 'Diagnostic detail of the failure logged under this ref';

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

/** The status of a request body that did not arrive within {@link HttpAppOwnDeps.requestBodyTimeoutMs}. */
const REQUEST_TIMEOUT_STATUS = 408;

/** The status of a request body larger than its operation's ceiling. */
const PAYLOAD_TOO_LARGE_STATUS = 413;

/* -------------------------------------------------------------------------------------------------
 * Request-body ceilings
 * ---------------------------------------------------------------------------------------------- */

/**
 * The byte ceiling of a request body whose operation {@link REQUEST_BODY_LIMIT_BYTES}
 * does not name: sixty-four kibibytes, the largest bound any JSON-object
 * operation of the table declares. An operation registered here later without
 * an entry of its own is still bounded, never unlimited.
 */
export const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * How long, in milliseconds, a route may take to receive a whole request body
 * once it starts reading one: thirty seconds.
 *
 * Every producer of this service runs on the same machine, so even the largest
 * body (a thirty-two mebibyte telemetry batch) arrives in well under a second;
 * the ceiling only stops a client that trickles bytes from holding a handler —
 * and the memory it has read so far — open for as long as it likes.
 */
export const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 30_000;

/** The largest {@link HttpAppOwnDeps.requestBodyTimeoutMs} accepted, in milliseconds: ten minutes. */
const MAX_REQUEST_BODY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The most bytes of a refused body the guard reads **and drops** after the
 * refusal, so the client — still sending — can read the refusal instead of
 * having its connection reset: sixty-four mebibytes, the same bound
 * `@hono/node-server` drains an unread body by. Nothing read here is kept.
 */
const REFUSED_BODY_DISCARD_MAX_BYTES = 64 * 1024 * 1024;

/**
 * How long, in milliseconds, the guard keeps dropping a refused body's rest
 * before it cancels the source (which, for a Node request, closes the socket):
 * one second — long after the refusal was written, and past the half-second
 * `@hono/node-server` lingers on an unread body itself.
 */
const REFUSED_BODY_DISCARD_MAX_MS = 1_000;

/**
 * The byte ceiling of every body-carrying operation, keyed by the protocol
 * operation a route is authorized as. Each value is the owning route module's
 * own exported bound, so a number is defined once, next to the route that
 * explains it; this table only says which bound guards which operation.
 * `devServer.credential` shares the dev-server module's single bound, and the
 * three bodiless `POST` operations — `session.purge`, `target.request` and
 * `credentials.rotate` — take the empty-body bounds of their own modules.
 *
 * Operations without a body (`GET` routes) need no entry: no body stream
 * reaches them. Any other operation absent here takes
 * {@link DEFAULT_REQUEST_BODY_LIMIT_BYTES}.
 */
export const REQUEST_BODY_LIMIT_BYTES: Readonly<Partial<Record<HttpOperationId, number>>> =
  Object.freeze({
    'session.create': MAX_SESSION_CREATE_BODY_BYTES,
    'session.question': MAX_SESSION_QUESTION_BODY_BYTES,
    'session.end': MAX_EMPTY_BODY_BYTES,
    'session.purge': MAX_EMPTY_BODY_BYTES,
    'capture.start': MAX_EMPTY_BODY_BYTES,
    'capture.stop': MAX_EMPTY_BODY_BYTES,
    'target.request': MAX_EMPTY_BODY_BYTES,
    'panel.data': MAX_PANEL_DATA_REQUEST_BODY_BYTES,
    'telemetry.event': MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES,
    'devServer.launch': MAX_DEV_SERVER_REQUEST_BODY_BYTES,
    'devServer.stop': MAX_DEV_SERVER_REQUEST_BODY_BYTES,
    'devServer.credential': MAX_DEV_SERVER_REQUEST_BODY_BYTES,
    'pair.start': MAX_PAIR_REQUEST_BODY_BYTES,
    'pair.complete': MAX_PAIR_REQUEST_BODY_BYTES,
    'credentials.rotate': MAX_CREDENTIALS_REQUEST_BODY_BYTES,
  } satisfies Partial<Record<HttpOperationId, number>>);

/**
 * The `details.reason` of the `DebuggenError` the request-body guard errors a
 * body stream with — the value `c.req.text()` rejects with inside a route.
 *
 * This is the contract with the route modules. They never import this file
 * (it imports them), so each states these two strings itself and maps them to
 * its own refusal: `body-too-large` to its `413`, `body-read-timeout` to its
 * `408`. `http-body-guard.test.ts` holds every route module to it.
 */
export const REQUEST_BODY_REFUSAL_REASONS = Object.freeze({
  tooLarge: 'body-too-large',
  timedOut: 'body-read-timeout',
} as const);

/** One of {@link REQUEST_BODY_REFUSAL_REASONS}. */
export type RequestBodyRefusalReason =
  (typeof REQUEST_BODY_REFUSAL_REASONS)[keyof typeof REQUEST_BODY_REFUSAL_REASONS];

/** The message of a body refused at its byte ceiling; it names no byte of the body. */
const BODY_TOO_LARGE_MESSAGE = 'The request body is larger than this operation accepts.';

/** The message of a body refused at its time ceiling. */
const BODY_READ_TIMEOUT_MESSAGE =
  'The request body did not arrive within the time the Debug Generator local service waits for one.';

/* -------------------------------------------------------------------------------------------------
 * Response verification bound
 * ---------------------------------------------------------------------------------------------- */

/**
 * The most bytes the default ({@link ResponseVerificationMode} `bounded`)
 * verifier reads of a failure reply: sixteen kibibytes. Protocol's error body
 * is at most a code, a two-thousand-character message and a
 * sixty-four-character `ref` (plus `owningSessionId` on a conflict), so a
 * conforming failure body always fits; one that does not is drift itself.
 */
const MAX_VERIFIED_FAILURE_BODY_BYTES = 16 * 1024;

/* -------------------------------------------------------------------------------------------------
 * The code → status map
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every status a failure answered by this module can carry: the statuses of
 * {@link HTTP_ERROR_STATUS_BY_CODE}, plus the request-body guard's `408` and
 * `413`, which no error code maps to because they describe the transport of a
 * body rather than a failure of the service.
 */
export type HttpErrorStatus = 400 | 401 | 403 | 404 | 408 | 409 | 413 | 422 | 429 | 500 | 502 | 503;

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

/** How much of each reply the response verifier re-checks: see {@link HttpAppOwnDeps.verifyResponses}. */
export type ResponseVerificationMode = 'off' | 'bounded' | 'full';

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
   * How much of each reply the response verifier re-checks before it leaves
   * (see the module overview's "Where validation happens").
   *
   * - `'bounded'` (the default): the status class and the JSON media type of
   *   every reply, and the body of every failure reply — read at most
   *   sixteen kibibytes deep — against protocol's error schema. A success body
   *   is not read again: its route module validated it with
   *   `parseHttpResponse` before serializing it, so a second parse would only
   *   double the work and the peak memory of every large panel-data page.
   * - `'full'`: additionally re-parses every success body against its
   *   operation's response schema. A development and test aid that a suite
   *   or composition root opts into explicitly; never a default.
   * - `'off'`: no verification.
   *
   * `true` and `false` are accepted as `'full'` and `'off'`.
   */
  readonly verifyResponses?: ResponseVerificationMode | boolean | undefined;

  /**
   * The request-body time ceiling in milliseconds: how long a route may take,
   * from the moment it starts reading a body, to receive all of it. Defaults to
   * {@link DEFAULT_REQUEST_BODY_TIMEOUT_MS}; a value that is not a positive
   * integer of at most ten minutes is replaced by the default. The byte ceiling
   * is not a knob: it is each route module's own bound
   * ({@link REQUEST_BODY_LIMIT_BYTES}).
   */
  readonly requestBodyTimeoutMs?: number | undefined;

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
  CredentialsRoutesDeps &
  HealthRoutesDeps &
  HttpAppOwnDeps;

/** One route the application registered, as {@link HttpApp.routes} reports it. */
export interface RegisteredHttpRoute {
  /** The method it answers. */
  readonly method: HttpMethod;
  /** The hono pattern it is registered at, verbatim from protocol's route table. */
  readonly pattern: string;
  /**
   * The protocol operation it answers — also the operation its auth
   * middleware, role table and response verifier are keyed by.
   */
  readonly operation: HttpOperationId;
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

  /** Every registered route: the protocol table's twenty-one operations, in the table's order, and nothing else. */
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
  /** The operation of the matched route, once one matched. */
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
 *   Its message reaches a `4xx` body only when proven product text; see
 *   {@link publicBoundaryError}.
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
      error: new DebuggenError(
        'PROTOCOL_INVALID_MESSAGE',
        authorProductText(UNREADABLE_REQUEST_MESSAGE),
        {
          details: { reason: 'request-unreadable', status: caught.status },
        },
      ),
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
 * The error a failure caught at the error boundary is answered with.
 *
 * A thrown `DebuggenError` is answered as itself only when its message is
 * proven product text ({@link isProductAuthoredText}): a collaborator's error
 * built by `DebuggenError.from`, or a sentence composed from a value the
 * product did not write, can quote a path, a URL or a statement, and a `4xx`
 * body shows the message verbatim (CWE-209). Anything else keeps its code —
 * so its status — its details and itself as the cause, with the code's fixed
 * summary from `FAILURE_COPY_BY_CODE` as the message. A `5xx` needs no
 * rewording: {@link errorBodyFor} already answers it with a fixed sentence.
 * The body's `ref` names the boundary's record, where the original is logged.
 *
 * @param error The failure {@link normalizeFailure} produced.
 * @param status The status it is answered with.
 * @returns The error whose projection becomes the body.
 */
function publicBoundaryError(error: DebuggenError, status: HttpErrorStatus): DebuggenError {
  if (status >= FIRST_SERVER_FAILURE_STATUS || isProductAuthoredText(error.message)) {
    return error;
  }
  const copy = Object.hasOwn(FAILURE_COPY_BY_CODE, error.code)
    ? FAILURE_COPY_BY_CODE[error.code]
    : FAILURE_COPY_BY_CODE.INTERNAL;
  return new DebuggenError(error.code, copy.summary, {
    ...(error.details === undefined ? {} : { details: error.details }),
    cause: error,
  });
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
 * The fields a record of a caught value carries at this module's error sinks
 * that hold no hono context (the dispatch guard and the listener's two
 * handlers).
 *
 * - `ref` — the correlation reference the answered error body carries, so a
 *   developer holding one can find the other.
 * - `errorClass` / `errorCode` — `../logging.ts`'s closed
 *   {@link describeException} classification, safe at every level: a label
 *   from a fixed taxonomy and a closed-vocabulary code, never the value's own
 *   `name`, `message` or string form.
 * - `LOG_ERROR_FIELD_KEY` — the value itself, and nowhere else, so the
 *   service serializer alone decides what of its message or stack a record
 *   may hold.
 *
 * A record at `warn` or `error` built from these fields is followed by its
 * `debug` twin (`logDiagnosticTwin` in {@link createHttpApp}), the one record
 * whose `err` may carry the redacted message and stack.
 *
 * @param caught Whatever was thrown or rejected.
 * @param ref The reference the reply to this failure carries.
 * @returns A fresh field bag for one log call.
 *
 * @example
 * ```ts
 * log.error('The HTTP listener failed while writing a response', exceptionLogFields(caught, ref));
 * // {"ref":"msg_…","errorClass":"SystemError","errorCode":"EPIPE","err":{"type":"SystemError","code":"EPIPE"}, …}
 * ```
 */
function exceptionLogFields(caught: unknown, ref: string): LogFields {
  return { ref, ...describeException(caught), [LOG_ERROR_FIELD_KEY]: caught };
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
 * The request-body guard
 * ---------------------------------------------------------------------------------------------- */

/** The two ceilings one route's body is read under. */
interface RequestBodyLimits {
  /** The most bytes the body may carry. */
  readonly maxBytes: number;
  /** How long the whole body may take to arrive once the route starts reading it, in milliseconds. */
  readonly timeoutMs: number;
}

/** A body the guard refused while a route read it, and the status it is answered with. */
interface RequestBodyRefusal {
  readonly reason: RequestBodyRefusalReason;
  readonly status: typeof PAYLOAD_TOO_LARGE_STATUS | typeof REQUEST_TIMEOUT_STATUS;
}

/** One guarded body: the stream a route reads, and what the guard saw. */
interface RequestBodyGuard {
  /** The bounded stream the replacement `Request` carries. */
  readonly body: ReadableStream<Uint8Array>;
  /** The refusal raised while the route read the body, or `undefined`. */
  refusal(): RequestBodyRefusal | undefined;
  /** Stops the time ceiling's timer; idempotent. Called once the request is answered. */
  dispose(): void;
}

/** The refusal of a body that crossed its byte ceiling. */
const BODY_TOO_LARGE_REFUSAL: RequestBodyRefusal = Object.freeze({
  reason: REQUEST_BODY_REFUSAL_REASONS.tooLarge,
  status: PAYLOAD_TOO_LARGE_STATUS,
});

/** The refusal of a body that did not arrive within its time ceiling. */
const BODY_READ_TIMEOUT_REFUSAL: RequestBodyRefusal = Object.freeze({
  reason: REQUEST_BODY_REFUSAL_REASONS.timedOut,
  status: REQUEST_TIMEOUT_STATUS,
});

/**
 * The byte ceiling of the operation a route is authorized as.
 *
 * @param operation The protocol operation.
 * @returns Its entry in {@link REQUEST_BODY_LIMIT_BYTES}, or {@link DEFAULT_REQUEST_BODY_LIMIT_BYTES}.
 */
function requestBodyLimitFor(operation: HttpOperationId): number {
  return REQUEST_BODY_LIMIT_BYTES[operation] ?? DEFAULT_REQUEST_BODY_LIMIT_BYTES;
}

/**
 * The time ceiling to apply: the injected value when it is a positive integer
 * of at most {@link MAX_REQUEST_BODY_TIMEOUT_MS}, the default otherwise.
 */
function requestBodyTimeoutOrDefault(value: number | undefined): number {
  return value !== undefined &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_REQUEST_BODY_TIMEOUT_MS
    ? value
    : DEFAULT_REQUEST_BODY_TIMEOUT_MS;
}

/**
 * The error a guarded body stream is errored with — the value a route's
 * `c.req.text()` rejects with. Its `details.reason` is the contract of
 * {@link REQUEST_BODY_REFUSAL_REASONS}; its message and hint name the ceiling,
 * never a byte of the body.
 *
 * @param refusal What the guard refused.
 * @param operation The operation the body was sent to.
 * @param limits The ceilings it was read under.
 */
function requestBodyRefusalError(
  refusal: RequestBodyRefusal,
  operation: HttpOperationId,
  limits: RequestBodyLimits,
): DebuggenError {
  if (refusal.reason === REQUEST_BODY_REFUSAL_REASONS.tooLarge) {
    return new DebuggenError('PROTOCOL_INVALID_MESSAGE', BODY_TOO_LARGE_MESSAGE, {
      hint: `Send a body of at most ${String(limits.maxBytes)} bytes.`,
      details: { reason: refusal.reason, operation, maxBytes: limits.maxBytes },
    });
  }
  return new DebuggenError('PROTOCOL_INVALID_MESSAGE', BODY_READ_TIMEOUT_MESSAGE, {
    hint: `Send the whole body within ${String(limits.timeoutMs)} ms of its first byte.`,
    details: { reason: refusal.reason, operation, timeoutMs: limits.timeoutMs },
  });
}

/**
 * Wraps a request body in a stream that enforces both ceilings **while the
 * route reads it**, so no route can be made to buffer more than its bound or
 * to wait for a body indefinitely.
 *
 * - **Lazy.** Nothing is read until the route reads (`highWaterMark: 0`, one
 *   source chunk per pull). A route that refuses the caller on its role, its
 *   path parameters or its session binding before it reads the body still
 *   refuses it without a byte of the body being read.
 * - **Byte ceiling.** Bytes are counted as they arrive; the chunk that crosses
 *   `maxBytes` is never handed on. The stream errors with the `body-too-large`
 *   refusal, so at most one source chunk past the bound is ever held.
 * - **Time ceiling.** A timer starts at the first read and errors the stream
 *   with the `body-read-timeout` refusal if the body has not ended when it
 *   fires. It is unref'd, so it never holds the process open.
 * - **The refusal reaches the client.** On a refusal the source is not
 *   cancelled at once: cancelling Node's request stream destroys the socket,
 *   and closing a socket whose peer is still sending makes the kernel answer
 *   with a reset that can discard the refusal before the client reads it.
 *   Instead the rest of the body is read and **dropped** — never kept, so
 *   memory stays at one chunk — for at most
 *   {@link REFUSED_BODY_DISCARD_MAX_BYTES} or
 *   {@link REFUSED_BODY_DISCARD_MAX_MS}, whichever comes first, and then the
 *   source is cancelled. A client that finishes sending within that window
 *   keeps a usable connection; one that does not is cut off. (Once the reply
 *   is written, `@hono/node-server` lingers on the unread body itself for half
 *   a second, then closes the socket.)
 * - A cancel from the reading side (the route abandoned the body) is passed on
 *   to the source.
 *
 * @param source The request's own body stream.
 * @param limits The ceilings.
 * @param onRefusal Builds the error the stream is errored with.
 * @returns The guard.
 */
function guardRequestBody(
  source: ReadableStream<Uint8Array>,
  limits: RequestBodyLimits,
  onRefusal: (refusal: RequestBodyRefusal) => DebuggenError,
): RequestBodyGuard {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let received = 0;
  let settled = false;
  let refused: RequestBodyRefusal | undefined;

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /**
   * Reads the rest of a refused body and drops it, within the discard bounds,
   * then cancels the source. Runs detached: the refusal is answered without
   * waiting for it. Every failure ends it quietly — the source erroring or
   * being cancelled means there is nothing left to drop.
   */
  const discardRemainder = (active: ReadableStreamDefaultReader<Uint8Array>): void => {
    const cancelSource = (): void => {
      active.cancel().catch(() => {
        // The source is already closed or errored: nothing left to release.
      });
    };
    const deadline = setTimeout(cancelSource, REFUSED_BODY_DISCARD_MAX_MS);
    deadline.unref();

    const drop = async (): Promise<void> => {
      let discarded = 0;
      for (;;) {
        const chunk = await active.read();
        if (chunk.done) {
          return;
        }
        const bytes: unknown = chunk.value;
        discarded += bytes instanceof Uint8Array ? bytes.byteLength : 0;
        if (discarded > REFUSED_BODY_DISCARD_MAX_BYTES) {
          cancelSource();
          return;
        }
      }
    };
    drop()
      .catch(() => {
        // The source failed or was cancelled while its rest was dropped.
      })
      .finally(() => {
        clearTimeout(deadline);
      });
  };

  /** Ends the stream exactly once: closed, errored with a refusal, or errored with a read failure. */
  const settle = (outcome: 'close' | RequestBodyRefusal | { readonly failure: unknown }): void => {
    if (settled) {
      return;
    }
    settled = true;
    stopTimer();
    if (outcome === 'close') {
      controller?.close();
    } else if ('failure' in outcome) {
      controller?.error(outcome.failure);
    } else {
      refused = outcome;
      controller?.error(onRefusal(outcome));
      if (reader !== undefined) {
        discardRemainder(reader);
      }
    }
  };

  const body = new ReadableStream<Uint8Array>(
    {
      start(streamController): void {
        controller = streamController;
      },
      async pull(): Promise<void> {
        if (settled) {
          return;
        }
        if (timer === undefined) {
          timer = setTimeout(() => {
            settle(BODY_READ_TIMEOUT_REFUSAL);
          }, limits.timeoutMs);
          timer.unref();
        }
        reader ??= source.getReader();

        let chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;
        try {
          chunk = await reader.read();
        } catch (failure) {
          settle({ failure });
          return;
        }
        if (settled) {
          return;
        }
        if (chunk.done) {
          settle('close');
          return;
        }
        const bytes: unknown = chunk.value;
        if (!(bytes instanceof Uint8Array)) {
          settle({ failure: new TypeError('A request body chunk was not a byte array.') });
          return;
        }
        received += bytes.byteLength;
        if (received > limits.maxBytes) {
          settle(BODY_TOO_LARGE_REFUSAL);
          return;
        }
        controller?.enqueue(bytes);
      },
      async cancel(reason: unknown): Promise<void> {
        settled = true;
        stopTimer();
        await (reader === undefined ? source.cancel(reason) : reader.cancel(reason));
      },
    },
    { highWaterMark: 0 },
  );

  return {
    body,
    refusal: (): RequestBodyRefusal | undefined => refused,
    dispose: stopTimer,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Response verification
 * ---------------------------------------------------------------------------------------------- */

/**
 * The verification mode a {@link HttpAppOwnDeps.verifyResponses} value names:
 * absent is `'bounded'`, `true` is `'full'`, `false` is `'off'`.
 */
function resolveVerificationMode(
  value: ResponseVerificationMode | boolean | undefined,
): ResponseVerificationMode {
  if (value === undefined) {
    return 'bounded';
  }
  if (typeof value === 'boolean') {
    return value ? 'full' : 'off';
  }
  return value;
}

/**
 * Reads a copy of a reply's body as text, at most `maxBytes` deep.
 *
 * The reply itself is left untouched (its clone is read), and reading stops
 * at the first chunk that crosses the bound, so verifying a reply never costs
 * more than the bound however large the reply is.
 *
 * @param response The reply.
 * @param maxBytes The most bytes to read.
 * @returns The text, or `undefined` when the body is larger than `maxBytes`.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | undefined> {
  const stream = response.clone().body;
  if (stream === null) {
    return '';
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      // Not awaited: a tee branch's cancel settles only once the other branch —
      // the reply itself, not yet sent — is consumed too. Cancelling stops the
      // copy from buffering the rest of the reply.
      reader.cancel().catch(() => {
        // The copy is already closed or errored: nothing left to release.
      });
      return undefined;
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Checks one reply against the contract it must satisfy, and describes the
 * drift when it does not.
 *
 * In every mode but `'off'` (which never calls this):
 *
 * - A reply with a status this service never answers with (`1xx`, `3xx`), or
 *   one that is not JSON, is drift. Both are read from the status line and a
 *   header, so they cost nothing however large the body is.
 * - A failure reply must carry protocol's error body; a `409` may carry the
 *   capture-conflict extension instead. The body is read at most
 *   {@link MAX_VERIFIED_FAILURE_BODY_BYTES} deep, and one that does not fit is
 *   drift: no conforming error body is that large.
 *
 * Only in `'full'` mode is a `2xx` body of a protocol operation re-parsed with
 * `parseHttpResponse(operation, body)`. In `'bounded'` mode it is not read at
 * all — every route module has already validated it with the same
 * `parseHttpResponse` before serializing it, so validating it again here would
 * clone, re-parse and re-validate the largest replies this service sends (a
 * panel-data page of five thousand events, a whole trace tree) for nothing.
 * Every registered route is a protocol operation, so every success has a
 * schema to re-parse against.
 *
 * The description is safe to log: it is built from issue paths and codes by
 * `describeZodIssues`, never from a value in the body.
 *
 * @param response The reply the route produced.
 * @param operation The protocol operation the route answers.
 * @param mode `'bounded'` or `'full'`.
 * @returns `undefined` when the reply conforms; a description otherwise.
 */
async function describeResponseDrift(
  response: Response,
  operation: HttpOperationId,
  mode: Exclude<ResponseVerificationMode, 'off'>,
): Promise<string | undefined> {
  const { status } = response;
  const success = status >= FIRST_SUCCESS_STATUS && status < FIRST_REDIRECT_STATUS;
  if (!success && status < FIRST_FAILURE_STATUS) {
    return 'the reply has a status this service never answers with';
  }

  const contentType = response.headers.get(CONTENT_TYPE_HEADER) ?? '';
  if (!contentType.includes(JSON_MEDIA_TYPE)) {
    return 'the reply is not JSON';
  }

  if (success && mode === 'bounded') {
    return undefined;
  }

  let body: unknown;
  try {
    if (success) {
      body = await response.clone().json();
    } else {
      const text = await readBoundedText(response, MAX_VERIFIED_FAILURE_BODY_BYTES);
      if (text === undefined) {
        return 'the failure body is larger than any protocol error body';
      }
      body = JSON.parse(text);
    }
  } catch {
    return 'the reply body is not parseable JSON';
  }

  if (success) {
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
              operation: registration.operation,
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
 * Builds the seven HTTP route modules and turns them into the registration
 * list: protocol's twenty-one operations in the table's own order, and nothing
 * else.
 *
 * Each factory receives the whole aggregate typed as its own narrow deps
 * interface, so it sees exactly the slice it declared. The factories register
 * nothing; a factory that throws while it is built is caught here and
 * returned as the `Err` it is.
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
      credentials: createCredentialsRoutes(deps),
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
    ...modules.credentials,
    ...modules.health,
  };

  // The run-time half: duplicates, extras and non-callables a spread hides.
  const coverage = verifyHandlerCoverage([
    { owner: 'server/routes/sessions.ts', handlers: modules.sessions },
    { owner: 'server/routes/panel-data.ts', handlers: modules.panelData },
    { owner: 'server/routes/telemetry.ts', handlers: modules.telemetry.handlers },
    { owner: 'server/routes/dev-server.ts', handlers: modules.devServer.handlers },
    { owner: 'server/routes/pair.ts', handlers: modules.pair },
    { owner: 'server/routes/credentials.ts', handlers: modules.credentials },
    { owner: 'server/routes/health.ts', handlers: modules.health },
  ]);
  if (isErr(coverage)) {
    return coverage;
  }

  const registrations: readonly RouteRegistration[] = HTTP_OPERATIONS.map((operation) => {
    const route = HTTP_ROUTES[operation];
    return {
      method: route.method,
      pattern: route.pattern,
      operation,
      handler: handlers[operation],
    };
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
 * Registers every route of `HTTP_ROUTES`, and only those, behind the origin
 * guard, the request context, the operation binding, the response verifier
 * and the per-operation auth middleware, and installs the error boundary.
 * Returns a request listener for `main.ts`'s single `node:http` server; opens
 * no socket, starts no timer and mutates no global (`@hono/node-server`'s
 * global `Request`/`Response` override is declined, so building an
 * application has no side effect).
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
  const verification = resolveVerificationMode(deps.verifyResponses);
  const bodyTimeoutMs = requestBodyTimeoutOrDefault(deps.requestBodyTimeoutMs);
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

  /**
   * Writes the `debug` twin of a failure record an error sink just wrote at
   * `warn` or `error`: the same fields — its `ref` among them — plus the
   * caught value under `LOG_ERROR_FIELD_KEY`, under the constant
   * {@link EXCEPTION_DIAGNOSTIC_MESSAGE}.
   *
   * At `warn`/`error` the service serializer reduces the value to its closed
   * shape (class, closed-vocabulary code, cause chain), because a record at
   * those levels is written by default; only a `debug`/`trace` record gets
   * its message and stack, after URL, SQL and source-excerpt redaction. The
   * twin is therefore where the reason a request failed lives, found by the
   * `ref` the error body carries. Below the `debug` threshold it costs one
   * level comparison.
   *
   * @param fields The failure record's own fields, `ref` included.
   * @param caught The value the sink caught.
   *
   * @example
   * ```ts
   * const fields = exceptionLogFields(caught, ref);
   * log.error('An HTTP request failed outside the error boundary; answering 500', fields);
   * logDiagnosticTwin(fields, caught);
   * ```
   */
  const logDiagnosticTwin = (fields: LogFields, caught: unknown): void => {
    log.debug(EXCEPTION_DIAGNOSTIC_MESSAGE, { ...fields, [LOG_ERROR_FIELD_KEY]: caught });
  };

  /**
   * Answers a failure on a live hono context, with no caching and the request's
   * ref — or `ref`, when the caller already logged the failure under one (the
   * error boundary), so the body and the record always name the same ref.
   */
  const renderFailure = (
    c: Context<ServerEnv>,
    error: DebuggenError,
    status: HttpErrorStatus,
    ref: string | undefined = contexts.get(c.req.raw)?.ref,
  ): Response => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    return c.json(errorBodyFor(error, status, ref), status);
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
        context.operation = registration.operation;
        context.pattern = registration.pattern;
      }
      c.set('operation', registration.operation);
      await next();
      return undefined;
    };

  /*
   * 3b. The response verifier: after the route (and any refusal of the auth
   * middleware) answered, re-check the reply against its contract, as deep as
   * the verification mode says (`bounded` by default: framing always, failure
   * bodies bounded, success bodies never re-parsed). A drifted reply is
   * replaced wholesale — `c.res = undefined` first, so none of the drifted
   * reply's headers are merged into the replacement.
   */
  const verifyReply =
    (operation: HttpOperationId): MiddlewareHandler<ServerEnv> =>
    async (c, next) => {
      await next();
      if (verification === 'off') {
        return undefined;
      }
      const drift = await describeResponseDrift(c.res, operation, verification);
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

  /*
   * 3d. The request-body guard, innermost before the handler: the request's
   * body is swapped for one that enforces the operation's byte ceiling and the
   * time ceiling while the route reads it (see `guardRequestBody`). Nothing is
   * read here. Once the route has answered, a body the guard refused is
   * answered at the refusal's status — the route's own `413`/`408` when it
   * rendered one, this module's otherwise — so no route can present a refused
   * body as any other outcome.
   */
  const limitBody = (registration: RegisteredHttpRoute): MiddlewareHandler<ServerEnv> => {
    const { operation } = registration;
    const limits: RequestBodyLimits = Object.freeze({
      maxBytes: requestBodyLimitFor(operation),
      timeoutMs: bodyTimeoutMs,
    });
    const refusalError = (refusal: RequestBodyRefusal): DebuggenError =>
      requestBodyRefusalError(refusal, operation, limits);

    return async (c, next) => {
      const original = c.req.raw;
      const source = original.body;
      if (source === null) {
        await next();
        return undefined;
      }

      const guard = guardRequestBody(source, limits, refusalError);
      // Built from the parts rather than from `original`: the Node listener's
      // request object is not a platform `Request`, so it is never handed to
      // the platform constructor as an input.
      const guarded = new Request(original.url, {
        method: original.method,
        headers: original.headers,
        body: guard.body,
        duplex: 'half',
        signal: original.signal,
      });
      const context = contexts.get(original);
      if (context !== undefined) {
        contexts.set(guarded, context);
      }
      c.req.raw = guarded;

      try {
        await next();
      } finally {
        guard.dispose();
      }

      const refusal = guard.refusal();
      if (refusal === undefined) {
        return undefined;
      }
      const answered = c.res;
      const fields = {
        operation,
        reason: refusal.reason,
        status: refusal.status,
        maxBytes: limits.maxBytes,
        timeoutMs: limits.timeoutMs,
        ref: context?.ref,
      };
      if (answered.status === refusal.status) {
        log.debug('Refused a request body at its ceiling while the route read it', fields);
        return undefined;
      }
      log.warn('A route answered a refused request body at another status; answering the refusal', {
        ...fields,
        routeStatus: answered.status,
      });
      c.res = undefined;
      c.res = Response.json(errorBodyFor(refusalError(refusal), refusal.status, context?.ref), {
        status: refusal.status,
        headers: { [CACHE_CONTROL_HEADER]: NO_STORE },
      });
      return undefined;
    };
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
        authFor(registration.operation),
        limitBody(registration),
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
    // One ref for the record and the body: the request's own, or — for a
    // failure raised before the request context existed (the origin guard
    // runs first) — one minted here, so the answer still names its record.
    const ref = context?.ref ?? newRef();
    // `describeException` is spread first so the explicit `errorCode` wins:
    // top-level it names the code the body answers with, beside the same
    // `ref`; the thrown value's own class is `errorClass`, and anything more
    // of it is the serializer's to decide under `LOG_ERROR_FIELD_KEY`.
    const fields: LogFields = {
      ...describeException(caught),
      operation: context?.operation,
      pattern: context?.pattern,
      status,
      errorCode: error.code,
      ref,
    };
    if (expected && status < FIRST_SERVER_FAILURE_STATUS) {
      log.warn('A route raised a failure; answering it at its status', fields);
    } else {
      log.error('A route failed; answering with the protocol error body', {
        ...fields,
        [LOG_ERROR_FIELD_KEY]: caught,
      });
    }
    // Either way, the redacted reason is filed at `debug` under the same ref
    // the body carries.
    logDiagnosticTwin(fields, caught);
    return renderFailure(c, publicBoundaryError(error, status), status, ref);
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
      const fields = exceptionLogFields(caught, ref);
      log.error('An HTTP request failed outside the error boundary; answering 500', fields);
      logDiagnosticTwin(fields, caught);
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
      // Already a `debug` record, so the serializer gives it the redacted
      // message and stack itself; no twin is needed.
      log.debug(
        'Refused a request whose URL or Host header could not be read',
        exceptionLogFields(caught, ref),
      );
      return errorResponse(
        new DebuggenError('PROTOCOL_INVALID_MESSAGE', MALFORMED_REQUEST_MESSAGE, {
          details: { reason: 'request-malformed' },
        }),
        ref,
      );
    }
    const fields = exceptionLogFields(caught, ref);
    log.error('The HTTP listener failed before the application ran; answering 500', fields);
    logDiagnosticTwin(fields, caught);
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
      // No request context reaches this far out, so the ref is minted here and
      // carried by both the record and — when a body can still be written —
      // the `500`, which is what lets the developer find one from the other.
      const ref = newRef();
      const fields = exceptionLogFields(caught, ref);
      log.error('The HTTP listener failed while writing a response', fields);
      logDiagnosticTwin(fields, caught);
      if (!response.headersSent) {
        const body = errorBodyFor(
          normalizeFailure(caught).error,
          HTTP_ERROR_STATUS_BY_CODE.INTERNAL,
          ref,
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
    registrations.map(({ method, pattern, operation }) =>
      Object.freeze({ method, pattern, operation }),
    ),
  );

  log.debug('The HTTP surface is assembled from the route table', {
    routeCount: routes.length,
    verification,
    requestBodyTimeoutMs: bodyTimeoutMs,
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
