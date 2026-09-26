/**
 * `POST /sessions/:id/panel-data` — the one operation every rendered panel node
 * reads its evidence through (AAP §0.4.2).
 *
 * Every visualization node of a generated panel except the `sourceLink` leaf
 * carries a `DataQuery`. `PanelHost`'s `DataProvider` posts that query, byte for
 * byte, to this route — with the id of the rendered panel it belongs to when
 * the node is part of one — from the DevTools panel through its service worker,
 * and from the VS Code webview through the extension host — and renders the
 * `DataResult` member it gets back. The response envelope is therefore a hot
 * contract: whatever this route answers is exactly what a component draws.
 *
 * ## The thinnest module in the folder, by design
 *
 * This file holds **no aggregation logic whatsoever**. It authorizes, validates
 * and delegates:
 *
 * 1. the principal `../auth.ts`'s middleware resolved must hold a role
 *    `OPERATION_ROLES['panel.data']` grants — a `server-agent` credential never
 *    reaches a session route;
 * 2. the `:id` path parameter, named by protocol's route table, must have the
 *    shape of a session id;
 * 3. a `devtools` principal must name the inspected tab it acts for (the
 *    acting-tab header, verified by the auth middleware as
 *    `c.get('actingTabId')`) and that tab must be the session's live bound
 *    tab, bound by its own credential (`requireBoundSession`) — one paired
 *    credential serves every inspected tab, so the credential alone never
 *    proves which tab asks — checked **before** the store is read so a
 *    DevTools tab learns nothing about sessions it is not bound to;
 * 4. the session must exist, and the whole per-session access matrix must allow
 *    the principal (`requireSessionAccess`: an editor by its announced workspace
 *    scope, a DevTools client by its binding);
 * 5. the body must satisfy protocol's declared request schema — panel-schema's
 *    `dataQuerySchema` itself, bound by identity in `HTTP_ROUTES`;
 * 6. `PanelDataResolver.resolve` (`../../panels/data.ts`) answers the query;
 * 7. its `DataResult` is checked against protocol's `dataResultSchema` and
 *    against the query's own `source`, then sent **unchanged**.
 *
 * Everything that decides what the answer contains belongs to the resolver and
 * is not repeated here: the ten-way dispatch over `DATA_QUERY_SOURCES`, the
 * aggregates, the stable `id` tie-breaker every sort ends in, the page defaults
 * (`DATA_QUERY_DEFAULT_LIMIT`, `DATA_QUERY_DEFAULT_OFFSET`), the clamp at
 * `DATA_QUERY_MAX_LIMIT`, the `total` counted before paging and the
 * `nextOffset` echo. So is the choice of capture. The body may name the rendered
 * panel the query was sent for (`panelId`, protocol's `PanelDataRequest`); the
 * route lifts it off the query into the resolver's context — the session and
 * that panel, nothing else — and hands the resolver the `DataQuery` alone. The
 * resolver's documented rule then binds a panel's reads to the capture that
 * panel was generated from, and reads live evidence — the session's open
 * capture, else its most recent one — when no panel is named, so a panel still
 * on screen after a newer capture started keeps drawing its own evidence.
 * Re-deriving any of that here would be a second implementation of the property
 * the multi-page walk exists to prove: that paging neither duplicates nor skips
 * a row.
 *
 * The three single-value sources (`trace`, `componentTree`, `graph`) carry no
 * page and the array-valued ones always do; the route passes either shape
 * through exactly as the resolver built it and never adds, strips or rewrites a
 * paging field.
 *
 * ## Success and failure (AAP §0.5.5)
 *
 * An empty result is a **success**: a capture with no renders answers
 * `{ source: 'renders', renders: [], total: 0, … }` and the node renders its
 * `EmptyState`. A query naming an unknown trace id or an unknown component
 * yields an empty result the same way, never a 404. A failure is never dressed
 * up as a success, and every non-2xx answer carries protocol's
 * `httpErrorResponseSchema` body:
 *
 * | Outcome | Status | Code |
 * | --- | --- | --- |
 * | no resolved principal (composition defect) | `401` | `UNAUTHORIZED` |
 * | `server-agent` credential | `403` | `UNAUTHORIZED` |
 * | malformed or unknown session id | `404` | `SESSION_NOT_FOUND` |
 * | DevTools client not bound to this session | `403` | `TAB_NOT_BOUND` |
 * | editor credential outside its announced workspace | `403` | `PATH_OUTSIDE_PROJECT` |
 * | body larger than {@link MAX_PANEL_DATA_REQUEST_BODY_BYTES}, declared or as it arrives | `413` | `PROTOCOL_INVALID_MESSAGE` |
 * | body that did not arrive within `../http.ts`'s time ceiling | `408` | `PROTOCOL_INVALID_MESSAGE` |
 * | unreadable, non-JSON or off-schema body | `400` | `PROTOCOL_INVALID_MESSAGE` |
 * | paging value refused by the resolver | `400` | `PANEL_INVALID` |
 * | aggregate over more events than the resolver's ceiling | `400` | `PANEL_INVALID` |
 * | panel not held by the session, capture not the session's or not the panel's | `409` | `SESSION_INVALID_STATE` |
 * | store failure, resolver defect, response drift | `500` | the failure's own code, fixed message |
 *
 * The body schema bounds `limit` at `DATA_QUERY_MAX_LIMIT` (panel-schema: "a
 * query above it is refused rather than truncated"), so an over-limit request
 * over HTTP is a `400` from that schema; the resolver's clamp protects every
 * caller that reaches it without passing through the schema.
 *
 * ## Privacy (AAP §0.5.2)
 *
 * Nothing a query or a result carries is logged or echoed: no `db.statement`,
 * URL, attribute value, event name, `request_key`, trace id or component name.
 * Validation messages come from protocol's `parseHttpRequest`, which renders
 * issue paths and codes through `describeZodIssues` and never a rejected value.
 * Log records here carry the operation id, the query's `source`, the status,
 * the error code and a kebab-case failure reason — nothing else. Every response
 * carries `Cache-Control: no-store`, and no `Access-Control-Allow-Origin`
 * header is ever set: its absence is why a web page cannot read captured
 * evidence even if it provokes a request.
 *
 * ## What this module does not do
 *
 * It registers nothing, builds no hono application and opens no socket: it
 * returns its handler keyed by operation id for `../http.ts` to register from
 * protocol's route table behind the auth middleware. It holds no state between
 * requests — no cache, no memoisation — reads no `process.env`, and opens no
 * database: the resolver, the session lookup and the binding lookup arrive by
 * injection from `main.ts` through `../http.ts`.
 */

import type { Context, Handler } from 'hono';

import {
  HTTP_ROUTES,
  httpErrorResponseSchema,
  parseHttpRequest,
  parseHttpResponse,
  toErrorPayload,
} from '@debuggen/protocol';
import type { DataQuery } from '@debuggen/panel-schema';
import type { DataResult, HttpErrorResponse, PanelDataRequest } from '@debuggen/protocol';
import { DebuggenError, ID_PREFIXES, err, isErr, noopLogger, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result, SessionId } from '@debuggen/shared';

import { subsystemLogger, sessionLogger } from '../../logging.js';
import type { PanelDataContext, PanelDataResolver } from '../../panels/data.js';
import type { SessionsRepo } from '../../store/sessions-repo.js';
import {
  AUTH_FAILURE_REASONS,
  OPERATION_ROLES,
  authErrorResponse,
  authFailureStatus,
  requireBoundSession,
  requireRole,
  requireSessionAccess,
} from '../auth.js';
import type {
  AuthFailureReason,
  AuthenticatedOperation,
  Principal,
  PrincipalRole,
  ServerEnv,
  SessionAccessTarget,
  TabBinding,
} from '../auth.js';

/* -------------------------------------------------------------------------------------------------
 * The operation this module owns
 * ---------------------------------------------------------------------------------------------- */

/**
 * The protocol route this module serves — method, pattern, path parameters,
 * request schema and response schema — read from the one route table rather
 * than restated.
 */
const PANEL_DATA_ROUTE = HTTP_ROUTES['panel.data'];

/**
 * The operation id the handler is filed under, derived from the route table's
 * own row so the key `../http.ts` looks up cannot drift from it.
 * `satisfies AuthenticatedOperation` is the compile-time proof that protocol
 * still requires a bearer credential for it: were the table ever to flag it
 * exempt, this line would stop compiling rather than the handler below running
 * without a principal.
 */
export const PANEL_DATA_OPERATION = PANEL_DATA_ROUTE.operation satisfies AuthenticatedOperation;

/** The literal type of {@link PANEL_DATA_OPERATION}. */
export type PanelDataOperation = typeof PANEL_DATA_OPERATION;

/**
 * The protocol operations this module answers: exactly one. `../http.ts`
 * builds an exhaustive `Record<HttpOperationId, handler>` from the route
 * modules, and this tuple is this module's slice of it.
 */
export const PANEL_DATA_OPERATIONS = Object.freeze([
  PANEL_DATA_OPERATION,
] as const satisfies readonly AuthenticatedOperation[]);

/**
 * The name of the path parameter that carries the session id — the route
 * table's own declaration (`params[0]` of `/sessions/:id/panel-data`), so a
 * renamed parameter changes here in the same edit.
 */
const SESSION_ID_PARAM = PANEL_DATA_ROUTE.params[0];

/* -------------------------------------------------------------------------------------------------
 * Policy constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The largest request body this operation accepts, in bytes: sixteen kibibytes.
 *
 * A genuine body is one `DataQuery`: a source, a sort, two integers and a
 * filter whose longest fields panel-schema bounds (a trace id, a component
 * name, a list drawn from the closed kind vocabulary) — well under two
 * kibibytes even at every bound. Sixteen leaves ample room while keeping the
 * route that every panel node calls from being made to buffer an arbitrarily
 * large body. A body declared or found larger is answered `413` without being
 * parsed.
 */
export const MAX_PANEL_DATA_REQUEST_BODY_BYTES = 16 * 1024;

/**
 * The longest session id the route will look up.
 *
 * Every id this product mints is twenty characters (`ses_` plus sixteen
 * alphanumerics); sixty-four is the bound protocol applies to every opaque
 * identifier in a body, which leaves room for a future scheme while keeping an
 * arbitrary path segment out of a store key.
 */
const MAX_SESSION_ID_LENGTH = 64;

/**
 * The shape of a session id: `@debuggen/shared`'s session prefix, the
 * underscore delimiter, then lowercase alphanumerics — the alphabet `newId`
 * draws from. Built from `ID_PREFIXES` so the prefix vocabulary stays in one
 * place.
 */
const SESSION_ID_PATTERN = new RegExp(`^${ID_PREFIXES.session}_[0-9a-z]+$`);

/** The HTTP status of an answered query — whatever it held, an empty result included. */
const ANSWERED_STATUS = 200;

/** The request header a client declares its body length in. */
const CONTENT_LENGTH_HEADER = 'content-length';

/** The response header that keeps captured evidence out of every cache. */
const CACHE_CONTROL_HEADER = 'cache-control';

/**
 * The {@link CACHE_CONTROL_HEADER} value on every response: a panel read during
 * a capture must see the evidence that arrived since, never a stored copy.
 */
const NO_STORE = 'no-store';

/** The log subsystem binding of this module's records. */
const LOG_SUBSYSTEM = 'server.panel-data';

/** The `details` key a failure reason is recorded under, across the service. */
const REASON_DETAIL_KEY = 'reason';

/** The only shape of failure reason this module logs or looks up: a short kebab-case word list. */
const LOGGABLE_REASON = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The fixed message of a `500`: the store, the binding lookup or the resolver
 * failed for a reason that is not the caller's. The detail is in the service
 * log; the failure's own words never reach a response body.
 */
const PANEL_DATA_UNAVAILABLE_MESSAGE =
  'The Debug Generator local service could not read this panel data. Its log holds the reason.';

/**
 * The fixed message of a `500` when the resolver's answer does not satisfy
 * protocol's `DataResult` union, or answers a different source than was asked
 * for — a drift between the resolver and the protocol, never something a
 * client caused.
 */
const RESPONSE_DRIFT_MESSAGE =
  'The Debug Generator local service built panel data that does not match the protocol. Its log holds the reason.';

/**
 * The fallback message of a refused request whose own message protocol's error
 * schema would not accept (for instance a validation summary over its length
 * bound). The code still says what went wrong.
 */
const REQUEST_REFUSED_MESSAGE =
  'The Debug Generator local service refused this panel-data request.';

/** The message of a `404`: the path names no session this service holds. */
const SESSION_NOT_FOUND_MESSAGE = 'No Debug Generator session has the id this request names.';

/** The recovery instruction a `404` carries. */
const SESSION_NOT_FOUND_HINT =
  'Reopen the session from the Debug Generator view in VS Code, or start a new one.';

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/**
 * The tab-binding lookup the DevTools rule needs: the binding recorded for a
 * session, carrying the `tokenHash` of the DevTools credential that made it.
 *
 * A consumer-declared port in the style of `../auth.ts`'s `ConnectionRevoker`:
 * the client registry of `../clients.ts` satisfies it structurally (its
 * `bindingForSession` answers a superset of `TabBinding`), and `main.ts`
 * injects it through `../http.ts`. The binding is read from the registry the
 * connection's principal recorded it in — never from anything the request
 * says about its tab.
 */
export interface PanelDataBindingLookup {
  /**
   * The live binding of a session's tab, if one exists.
   *
   * @param sessionId The session the request acts on.
   * @returns The binding, or `undefined` when no tab is bound to the session.
   */
  bindingForSession(sessionId: SessionId): TabBinding | undefined;
}

/**
 * What {@link createPanelDataRoutes} is built from — the narrowest slice of
 * each subsystem the handler calls, declared here next to the route so
 * `../http.ts` composes its dependency aggregate from this interface rather
 * than restating its fields.
 */
export interface PanelDataRoutesDeps {
  /**
   * The panel-data resolver of `../../panels/data.ts`: the single place every
   * `DataQuery` source is mapped to its result, paged and ordered.
   */
  readonly resolver: Pick<PanelDataResolver, 'resolve'>;

  /**
   * The session lookup: whether the session exists, and the project root the
   * editor's workspace scope is checked against.
   */
  readonly sessions: Pick<SessionsRepo, 'get'>;

  /** The tab bindings a DevTools principal acts through. */
  readonly bindings: PanelDataBindingLookup;

  /**
   * Where this module's diagnostics go; defaults to the no-op logger. Records
   * carry the operation, the query's source, a status, an error code and a
   * failure reason only.
   */
  readonly logger?: Logger | undefined;
}

/**
 * The panel-data route handler, typed on the service's hono environment so
 * `c.get('principal')` is the principal `../auth.ts`'s middleware resolved.
 */
export type PanelDataRouteHandler = Handler<ServerEnv>;

/**
 * The handler {@link createPanelDataRoutes} returns, keyed by protocol
 * operation id so `../http.ts` can place it in its exhaustive handler record
 * unchanged.
 */
export type PanelDataRoutes = Readonly<Record<PanelDataOperation, PanelDataRouteHandler>>;

/** Every status this route answers a failure with. */
export type PanelDataFailureStatus = 400 | 401 | 403 | 404 | 408 | 409 | 413 | 429 | 500;

/* -------------------------------------------------------------------------------------------------
 * Failure vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The statuses of the failures this route describes to its caller in the
 * failure's own words, by error code.
 *
 * - `PROTOCOL_INVALID_MESSAGE` — a body protocol's request schema refused, or
 *   one that is not JSON: `400`.
 * - `PANEL_INVALID` — a paging value the resolver refused: `400`.
 * - `SESSION_NOT_FOUND` — the path names no session: `404`.
 * - `SESSION_INVALID_STATE` — the resolver could not determine a capture of
 *   this session to read: `409`, the session's state conflicts with the read.
 *
 * Every other code — `STORE_ERROR`, `INTERNAL`, anything unforeseen — is
 * answered `500` with {@link PANEL_DATA_UNAVAILABLE_MESSAGE} and its code, so a
 * store or resolver failure never reaches a response body in its own words.
 * Access-boundary refusals never reach this table: `../auth.ts`'s own
 * `authErrorResponse` renders them at the status its reason table fixes.
 */
const STATUS_BY_CODE: ReadonlyMap<DebuggenErrorCode, 400 | 404 | 409> = new Map<
  DebuggenErrorCode,
  400 | 404 | 409
>([
  ['PROTOCOL_INVALID_MESSAGE', 400],
  ['PANEL_INVALID', 400],
  ['SESSION_NOT_FOUND', 404],
  ['SESSION_INVALID_STATE', 409],
]);

/**
 * Failure reasons that turn a described failure into an opaque one.
 *
 * `no-capture-lookup` is the resolver reporting that it was composed without
 * the session store, so it cannot find a capture that no query can name: a
 * composition defect of the service, never a state of the caller's session,
 * and answered `500` rather than `409`.
 */
const OPAQUE_REASONS: ReadonlySet<string> = new Set(['no-capture-lookup']);

/**
 * The failure reason recorded in an error's `details`, when it has the
 * loggable kebab-case shape — the only shape this module logs or looks up.
 *
 * @param error Any failure answered here.
 * @returns The reason, or `undefined`.
 */
function reasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.[REASON_DETAIL_KEY];
  return typeof reason === 'string' && LOGGABLE_REASON.test(reason) ? reason : undefined;
}

/**
 * The status a failure is answered with.
 *
 * An access-boundary refusal (its `details.reason` names an entry of
 * `../auth.ts`'s `AUTH_FAILURE_REASONS`) takes that table's status; a failure
 * {@link STATUS_BY_CODE} describes takes its status unless its reason is one of
 * {@link OPAQUE_REASONS}; everything else is `500`.
 *
 * @param error Any failure met while answering a panel-data request.
 * @returns The HTTP status to answer with.
 *
 * @example
 * ```ts
 * panelDataFailureStatus(new DebuggenError('SESSION_NOT_FOUND', 'No such session.'));
 * // → 404
 * panelDataFailureStatus(new DebuggenError('STORE_ERROR', 'The store failed.'));
 * // → 500
 * ```
 */
export function panelDataFailureStatus(error: DebuggenError): PanelDataFailureStatus {
  const refusal = authFailureStatus(error);
  if (refusal !== undefined) {
    return refusal;
  }
  const described = STATUS_BY_CODE.get(error.code);
  if (described === undefined) {
    return 500;
  }
  const reason = reasonOf(error);
  return reason !== undefined && OPAQUE_REASONS.has(reason) ? 500 : described;
}

/**
 * Builds the refusal `../auth.ts` raises for `reason`, from its own table: the
 * table's code and constant message, `details.reason` naming the entry (which
 * is what `authErrorResponse` maps back to a status) and the table's hint when
 * it has one. No presented value can reach it.
 *
 * @param reason The {@link AUTH_FAILURE_REASONS} entry to raise.
 * @returns A refusal indistinguishable from one `../auth.ts` returned itself.
 */
function refusalFor(reason: AuthFailureReason): DebuggenError {
  const descriptor = AUTH_FAILURE_REASONS[reason];
  const hint: string | undefined = 'hint' in descriptor ? descriptor.hint : undefined;
  return new DebuggenError(descriptor.code, descriptor.message, {
    details: { reason },
    ...(hint === undefined ? {} : { hint }),
  });
}

/** The `404` for a path that names no session — malformed and unknown ids alike. */
function sessionNotFound(reason: 'malformed-session-id' | 'unknown-session'): DebuggenError {
  return new DebuggenError('SESSION_NOT_FOUND', SESSION_NOT_FOUND_MESSAGE, {
    hint: SESSION_NOT_FOUND_HINT,
    details: { reason },
  });
}

/** The failure a throwing port is converted to; the thrown value is never kept. */
function portFailure(code: 'STORE_ERROR' | 'INTERNAL', reason: string): DebuggenError {
  return new DebuggenError(code, PANEL_DATA_UNAVAILABLE_MESSAGE, { details: { reason } });
}

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a path segment has the shape of a session id: `@debuggen/shared`'s
 * session prefix, an underscore, then lowercase alphanumerics, at most
 * {@link MAX_SESSION_ID_LENGTH} characters in all.
 *
 * Checked before the value is used as a store key or bound into a log record,
 * so a path segment carrying anything else — an encoded slash, a traversal, a
 * blob of page data — is answered `404` without a lookup.
 *
 * @param value The decoded `:id` path parameter, or `undefined` when absent.
 * @returns `true` for a well-formed session id.
 *
 * @example
 * ```ts
 * isWellFormedSessionId('ses_4k2p9dq7m1zx0c3v'); // → true
 * isWellFormedSessionId('../sessions');          // → false
 * ```
 */
export function isWellFormedSessionId(value: string | undefined): value is SessionId {
  return (
    value !== undefined && value.length <= MAX_SESSION_ID_LENGTH && SESSION_ID_PATTERN.test(value)
  );
}

/* -------------------------------------------------------------------------------------------------
 * The request body
 * ---------------------------------------------------------------------------------------------- */

/** Why a request body was refused before it reached the resolver. */
interface BodyRejection {
  /**
   * `413` for an oversized body, `408` for one that did not arrive in time,
   * `400` for one that is unreadable, not JSON or off-schema.
   */
  readonly status: 400 | 408 | 413;
  /** The refusal; its message never quotes the body. */
  readonly error: DebuggenError;
}

/**
 * The `details.reason` values of the refusal `../http.ts`'s request-body guard
 * errors a body stream with — what `c.req.text()` rejects with when the body
 * crosses this operation's byte ceiling while it is read, or does not arrive
 * within the time ceiling. Stated here because a route module never imports
 * `../http.ts` (which imports it); they must equal that module's
 * `REQUEST_BODY_REFUSAL_REASONS`, and `../http-body-guard.test.ts` holds them to it.
 */
const GUARD_BODY_TOO_LARGE_REASON = 'body-too-large';

/** See {@link GUARD_BODY_TOO_LARGE_REASON}. */
const GUARD_BODY_READ_TIMEOUT_REASON = 'body-read-timeout';

/**
 * Which ceiling `../http.ts`'s request-body guard refused a body at, read
 * from what a body read rejected with.
 *
 * @param caught The rejection of `c.req.text()`.
 * @returns The guard's reason, or `undefined` for any other read failure.
 */
function guardRefusalOf(
  caught: unknown,
): typeof GUARD_BODY_TOO_LARGE_REASON | typeof GUARD_BODY_READ_TIMEOUT_REASON | undefined {
  if (!DebuggenError.is(caught)) {
    return undefined;
  }
  const reason = caught.details?.[REASON_DETAIL_KEY];
  return reason === GUARD_BODY_TOO_LARGE_REASON || reason === GUARD_BODY_READ_TIMEOUT_REASON
    ? reason
    : undefined;
}

/** The refusal of a body larger than {@link MAX_PANEL_DATA_REQUEST_BODY_BYTES}. */
function bodyTooLarge(): BodyRejection {
  return {
    status: 413,
    error: new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The ${PANEL_DATA_OPERATION} request body is larger than this operation accepts.`,
      {
        hint: `Send one data query of at most ${String(MAX_PANEL_DATA_REQUEST_BODY_BYTES)} bytes.`,
        details: {
          operation: PANEL_DATA_OPERATION,
          reason: 'body-too-large',
          maxBytes: MAX_PANEL_DATA_REQUEST_BODY_BYTES,
        },
      },
    ),
  };
}

/** The refusal of a body that did not arrive within `../http.ts`'s time ceiling. */
function bodyReadTimedOut(): BodyRejection {
  return {
    status: 408,
    error: new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The ${PANEL_DATA_OPERATION} request body did not arrive in time.`,
      {
        hint: 'Send the whole data query at once, then wait for the reply.',
        details: { operation: PANEL_DATA_OPERATION, reason: GUARD_BODY_READ_TIMEOUT_REASON },
      },
    ),
  };
}

/** The refusal of a body that is unreadable or not JSON; the body itself is never quoted. */
function bodyNotJson(problem: 'body-unreadable' | 'body-not-json'): BodyRejection {
  const message =
    problem === 'body-unreadable'
      ? `The ${PANEL_DATA_OPERATION} request body could not be read.`
      : `The ${PANEL_DATA_OPERATION} request body is not valid JSON.`;
  return {
    status: 400,
    error: new DebuggenError('PROTOCOL_INVALID_MESSAGE', message, {
      hint: 'Send the node’s data query as a JSON object.',
      details: { operation: PANEL_DATA_OPERATION, reason: problem },
    }),
  };
}

/**
 * Reads the request body as JSON, bounded by
 * {@link MAX_PANEL_DATA_REQUEST_BODY_BYTES}.
 *
 * A declared `Content-Length` above the bound is refused before anything is
 * read. A body that declares no length (a chunked upload) is bounded while it
 * is read: `../http.ts`'s request-body guard errors the stream at the same
 * bound — and at its time ceiling — so `c.req.text()` rejects with the guard's
 * refusal instead of buffering an unbounded body, and that rejection is
 * answered `413` or `408` here. The text read is measured once more, which
 * keeps the bound for a handler composed without the guard. The text is read
 * through hono's cached accessor, so a body a middleware already consumed is
 * still available here. An empty body reads as `undefined`, which the request
 * schema then refuses (a query without a `source` has nothing to draw).
 * `JSON.parse`'s own error is discarded, because its message quotes the
 * offending input.
 *
 * @param c The request context.
 * @returns The parsed value, or the refusal.
 */
async function readJsonBody(c: Context<ServerEnv>): Promise<Result<unknown, BodyRejection>> {
  const declared = c.req.header(CONTENT_LENGTH_HEADER);
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_PANEL_DATA_REQUEST_BODY_BYTES) {
      return err(bodyTooLarge());
    }
  }

  let text: string;
  try {
    text = await c.req.text();
  } catch (caught) {
    const refusal = guardRefusalOf(caught);
    if (refusal === GUARD_BODY_TOO_LARGE_REASON) {
      return err(bodyTooLarge());
    }
    if (refusal === GUARD_BODY_READ_TIMEOUT_REASON) {
      return err(bodyReadTimedOut());
    }
    return err(bodyNotJson('body-unreadable'));
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_PANEL_DATA_REQUEST_BODY_BYTES) {
    return err(bodyTooLarge());
  }
  if (text.trim().length === 0) {
    return ok(undefined);
  }

  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch {
    return err(bodyNotJson('body-not-json'));
  }
}

/**
 * Reads and validates the body against protocol's route table — the same
 * `parseHttpRequest` the client SDK validates its outbound body with, so the
 * service accepts exactly the `DataQuery` a client can send and a panel node
 * can carry, with the optional id of the panel it belongs to. The rejection message is built by `describeZodIssues` from issue
 * paths and codes: a filter value, a trace id or a component name never
 * reaches it.
 *
 * @param c The request context.
 * @returns The validated query, or the refusal (`400`/`413`).
 */
async function readQuery(c: Context<ServerEnv>): Promise<Result<PanelDataRequest, BodyRejection>> {
  const raw = await readJsonBody(c);
  if (isErr(raw)) {
    return raw;
  }
  const parsed = parseHttpRequest(PANEL_DATA_OPERATION, raw.value);
  if (isErr(parsed)) {
    return err({ status: 400, error: parsed.error });
  }
  return ok(parsed.value);
}

/* -------------------------------------------------------------------------------------------------
 * Responses
 * ---------------------------------------------------------------------------------------------- */

/** What a failure log record may say about the request: never a query field beyond its source. */
interface FailureContext {
  readonly log: Logger;
  readonly source?: PanelDataRequest['source'] | undefined;
}

/**
 * The payload a described `4xx` failure is answered with, checked against
 * protocol's own `httpErrorResponseSchema`: a payload the schema refuses (a
 * validation message over its bound, say) keeps its code and is given
 * {@link REQUEST_REFUSED_MESSAGE}, so no response here can be refused by a
 * client's parser.
 *
 * @param payload The payload to send.
 * @returns A schema-valid payload.
 */
function boundedPayload(payload: HttpErrorResponse): HttpErrorResponse {
  return httpErrorResponseSchema.safeParse(payload).success
    ? payload
    : { code: payload.code, message: REQUEST_REFUSED_MESSAGE };
}

/**
 * Logs an answered failure: constant text plus the operation, the query's
 * source when one was read, the status, the error code and — when it has the
 * loggable shape — the failure reason. Neither the error's message, its hint
 * nor its details are logged.
 */
function logFailure(context: FailureContext, status: number, error: DebuggenError): void {
  const reason = reasonOf(error);
  const fields = {
    operation: PANEL_DATA_OPERATION,
    status,
    errorCode: error.code,
    ...(context.source === undefined ? {} : { source: context.source }),
    ...(reason === undefined ? {} : { reason }),
  };
  if (status >= 500) {
    context.log.error('A panel-data request failed', fields);
  } else {
    context.log.warn('A panel-data request was refused', fields);
  }
}

/**
 * Answers any failure with protocol's error payload.
 *
 * - An access-boundary refusal is rendered by `../auth.ts`'s own
 *   `authErrorResponse`, at the status its reason table fixes.
 * - A failure {@link panelDataFailureStatus} describes is sent at its status in
 *   its own constant words.
 * - Anything else is answered `500` with its code and
 *   {@link PANEL_DATA_UNAVAILABLE_MESSAGE}.
 *
 * @param c The request context.
 * @param error The failure.
 * @param context The logger and, when read, the query's source.
 * @returns The error response.
 */
function answerFailure(
  c: Context<ServerEnv>,
  error: DebuggenError,
  context: FailureContext,
): Response {
  if (authFailureStatus(error) !== undefined) {
    const { status, body } = authErrorResponse(error);
    logFailure(context, status, error);
    return c.json(body, status);
  }
  const status = panelDataFailureStatus(error);
  logFailure(context, status, error);
  if (status === 500) {
    const body: HttpErrorResponse = { code: error.code, message: PANEL_DATA_UNAVAILABLE_MESSAGE };
    return c.json(body, 500);
  }
  return c.json(boundedPayload(toErrorPayload(error)), status);
}

/** Answers a refused body with protocol's error payload at the rejection's status. */
function answerBodyRejection(
  c: Context<ServerEnv>,
  rejection: BodyRejection,
  context: FailureContext,
): Response {
  logFailure(context, rejection.status, rejection.error);
  return c.json(boundedPayload(toErrorPayload(rejection.error)), rejection.status);
}

/**
 * Answers a resolver result that does not satisfy protocol's `DataResult`
 * union, or that answers another source than the query asked for, with a fixed
 * `INTERNAL` payload. The offending value is never logged: it holds captured
 * evidence.
 *
 * @param c The request context.
 * @param context The logger and the query's source.
 * @param reason Which of the two drifts was found.
 * @returns The `500` response.
 */
function answerResponseDrift(
  c: Context<ServerEnv>,
  context: FailureContext,
  reason: 'result-off-schema' | 'result-source-mismatch',
): Response {
  const error = new DebuggenError('INTERNAL', RESPONSE_DRIFT_MESSAGE, { details: { reason } });
  logFailure(context, 500, error);
  return c.json(toErrorPayload(error), 500);
}

/* -------------------------------------------------------------------------------------------------
 * The request steps: principal and role, binding, session and scope, delegation
 * ---------------------------------------------------------------------------------------------- */

/**
 * The first step: the principal `../auth.ts`'s middleware resolved, holding
 * one of the roles `OPERATION_ROLES` grants this operation.
 *
 * A missing principal means the route was registered without its middleware —
 * a composition defect — and is refused `401` rather than served. A
 * `server-agent` credential is refused `403` here, before the path, the store
 * or the body is looked at.
 *
 * @param c The request context.
 * @param log This module's logger.
 * @returns The principal, or the response that refuses the request.
 */
function authorize(c: Context<ServerEnv>, log: Logger): Result<Principal, Response> {
  // Widened on purpose: `ServerEnv` types the variable as always present, and
  // the absence this guards against is exactly the case the type cannot see.
  const principal: Principal | undefined = c.get('principal');
  if (principal === undefined) {
    log.error('The panel-data route ran without a resolved principal', {
      operation: PANEL_DATA_OPERATION,
    });
    return err(answerFailure(c, refusalFor('missing-credential'), { log }));
  }
  const roles: readonly PrincipalRole[] = OPERATION_ROLES[PANEL_DATA_OPERATION];
  const permitted = requireRole(principal, ...roles);
  if (isErr(permitted)) {
    return err(answerFailure(c, permitted.error, { log }));
  }
  return ok(principal);
}

/**
 * The binding a DevTools principal acts through, read from the injected
 * lookup. A throwing lookup is an `INTERNAL` failure; its thrown value is not
 * kept.
 *
 * @param bindings The binding lookup.
 * @param sessionId The session the request names.
 * @returns The binding, `undefined` when none exists, or the failure.
 */
function lookupBinding(
  bindings: PanelDataBindingLookup,
  sessionId: SessionId,
): Result<TabBinding | undefined, DebuggenError> {
  try {
    return ok(bindings.bindingForSession(sessionId));
  } catch {
    return err(portFailure('INTERNAL', 'binding-lookup-threw'));
  }
}

/**
 * The session the request names, from the injected lookup.
 *
 * @param sessions The session lookup.
 * @param sessionId The session the request names.
 * @returns The session's id and project root — the two facts its access rule
 * depends on — `SESSION_NOT_FOUND` when no such session exists, or the store's
 * own failure (a throw becomes `STORE_ERROR`).
 */
function loadSession(
  sessions: PanelDataRoutesDeps['sessions'],
  sessionId: SessionId,
): Result<SessionAccessTarget, DebuggenError> {
  let read: ReturnType<PanelDataRoutesDeps['sessions']['get']>;
  try {
    read = sessions.get(sessionId);
  } catch {
    return err(portFailure('STORE_ERROR', 'session-lookup-threw'));
  }
  if (isErr(read)) {
    return read;
  }
  const record = read.value;
  if (record?.id !== sessionId) {
    return err(sessionNotFound('unknown-session'));
  }
  return ok({ id: record.id, projectRoot: record.projectRoot });
}

/**
 * Runs the resolver, turning a rejection into an `INTERNAL` failure.
 *
 * The resolver reports every failure as a `Result` and never rejects; this
 * guard keeps that a property of this route's responses too, so a defect below
 * answers protocol's error payload instead of escaping to the framework. The
 * thrown value is not kept: its message could quote captured data.
 *
 * @param resolver The panel-data resolver.
 * @param context The session, and the rendered panel when one was named.
 * @param query The validated query, without the panel id.
 * @returns The resolver's own result, or an `INTERNAL` failure.
 */
async function resolveQuery(
  resolver: PanelDataRoutesDeps['resolver'],
  context: PanelDataContext,
  query: DataQuery,
): Promise<Result<DataResult, DebuggenError>> {
  try {
    return await resolver.resolve(context, query);
  } catch {
    return err(portFailure('INTERNAL', 'resolver-rejected'));
  }
}

/**
 * The counts a success record may carry: whether the result is paged and, when
 * it is, how many items the filtered source holds and whether this page is the
 * last. Never a row, an id or a filter value.
 *
 * @param result The answered result.
 * @returns The loggable counts.
 */
function resultCounts(result: DataResult): Record<string, number | boolean> {
  if (!('total' in result)) {
    return { paged: false };
  }
  return { paged: true, total: result.total, endOfData: result.nextOffset === null };
}

/* -------------------------------------------------------------------------------------------------
 * The route
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the `POST /sessions/:id/panel-data` handler for `../http.ts` to
 * register.
 *
 * Registers nothing, builds no application, opens no socket and holds no state
 * between requests. The handler runs the steps of the module documentation in
 * order — role, id shape, DevTools binding, session and scope, body, resolver,
 * result check — so a caller that fails an earlier step learns nothing about a
 * later one, and answers `200` with the resolver's `DataResult` exactly as the
 * resolver built it.
 *
 * @param deps The resolver, the session and binding lookups, and an optional
 * logger.
 * @returns A frozen record holding the one handler, keyed by
 * {@link PANEL_DATA_OPERATION}.
 *
 * @example
 * ```ts
 * const panelData = createPanelDataRoutes({ resolver, sessions, bindings: clients, logger });
 * const authFor = createAuthMiddleware(auth);
 * for (const operation of PANEL_DATA_OPERATIONS) {
 *   const { method, pattern } = HTTP_ROUTES[operation];
 *   app.on(method, pattern, authFor(operation), panelData[operation]);
 * }
 * ```
 */
export function createPanelDataRoutes(deps: PanelDataRoutesDeps): PanelDataRoutes {
  const { resolver, sessions, bindings } = deps;
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);

  const answerPanelData: PanelDataRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);

    const principal = authorize(c, log);
    if (isErr(principal)) {
      return principal.error;
    }

    const sessionId = c.req.param(SESSION_ID_PARAM);
    if (!isWellFormedSessionId(sessionId)) {
      return answerFailure(c, sessionNotFound('malformed-session-id'), { log });
    }
    const sessionLog = sessionLogger(log, sessionId);

    // A DevTools client acts only for the tab it names (the acting-tab header
    // the auth middleware verified) through the binding its own credential
    // made for that tab, and that is checked before the store is read: a tab
    // that is not bound to this session cannot tell an existing session from
    // an absent one.
    const actingTabId = c.get('actingTabId');
    let binding: TabBinding | undefined;
    if (principal.value.role === 'devtools') {
      const looked = lookupBinding(bindings, sessionId);
      if (isErr(looked)) {
        return answerFailure(c, looked.error, { log: sessionLog });
      }
      const bound = requireBoundSession(principal.value, sessionId, looked.value, actingTabId);
      if (isErr(bound)) {
        return answerFailure(c, bound.error, { log: sessionLog });
      }
      binding = looked.value;
    }

    const session = loadSession(sessions, sessionId);
    if (isErr(session)) {
      return answerFailure(c, session.error, { log: sessionLog });
    }
    const access = requireSessionAccess(principal.value, session.value, binding, actingTabId);
    if (isErr(access)) {
      return answerFailure(c, access.error, { log: sessionLog });
    }

    const query = await readQuery(c);
    if (isErr(query)) {
      return answerBodyRejection(c, query.error, { log: sessionLog });
    }
    const source = query.value.source;
    const queried: FailureContext = { log: sessionLog, source };

    // The panel id is the read's scope, not part of the query: it moves into
    // the context, and which capture a read uses is the resolver's rule,
    // applied by it alone — the rendered panel's, else the live one.
    const { panelId, ...dataQuery } = query.value;
    const context: PanelDataContext =
      panelId === undefined ? { sessionId } : { sessionId, panelId };
    const resolved = await resolveQuery(resolver, context, dataQuery);
    if (isErr(resolved)) {
      return answerFailure(c, resolved.error, queried);
    }

    // The resolver's result is checked, never rebuilt: protocol's union gates
    // it so a drift fails here rather than in a client, and the discriminant
    // must be the source that was asked for. What is sent is the resolver's
    // own value — paging echo included — exactly as it built it.
    const checked = parseHttpResponse(PANEL_DATA_OPERATION, resolved.value);
    if (isErr(checked)) {
      return answerResponseDrift(c, queried, 'result-off-schema');
    }
    if (checked.value.source !== source) {
      return answerResponseDrift(c, queried, 'result-source-mismatch');
    }

    sessionLog.debug('Answered a panel-data query', {
      operation: PANEL_DATA_OPERATION,
      status: ANSWERED_STATUS,
      source,
      ...resultCounts(resolved.value),
    });
    return c.json(resolved.value, ANSWERED_STATUS);
  };

  return Object.freeze({ [PANEL_DATA_OPERATION]: answerPanelData });
}
