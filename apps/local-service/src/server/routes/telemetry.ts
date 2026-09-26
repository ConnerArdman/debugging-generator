/**
 * Telemetry intake — the two doors runtime evidence enters the service by
 * (AAP §0.4.2): the dev-server preload's `POST /telemetry/ingest` and the
 * Chrome service worker's relayed `telemetry.event` WebSocket frames.
 *
 * ## What this module decides, and what it does not
 *
 * This file decides **who** may hand the service runtime data and **for which
 * project or tab**, then hands the batch to `../../telemetry/ingest.ts` in the
 * right transport context. Everything substantive happens there, in a fixed
 * order this file never repeats or reorders: strict per-element validation,
 * the `request_key` digest from the **unredacted** URL, redaction, attribution
 * to the bound session's open capture window, one bulk write, incremental
 * correlation and the DevTools live tail. There is no parsing loop, no
 * redaction, no hashing, no session lookup and no persistence here.
 *
 * It registers nothing either. {@link createTelemetryRoutes} returns the HTTP
 * handler keyed by its protocol operation id — for `../http.ts` to register
 * from protocol's route table behind the auth middleware — and the WebSocket
 * batch handler `../ws.ts` dispatches every parsed `telemetry.event` frame to.
 * Neither of those modules is imported here: the edge runs one way.
 *
 * ## Two authorization postures, deliberately distinct
 *
 * | | `POST /telemetry/ingest` | `telemetry.event` frame |
 * | --- | --- | --- |
 * | Producer | the Node preload inside the dev server | the MAIN-world page agent, relayed by the MV3 service worker |
 * | Credential | `server-agent`, scoped to exactly one `projectRoot` | `devtools`, scoped to the paired extension |
 * | Identity handed to ingest | the body's `projectRoot` **and** the credential's `scopedProjectRoot` | the acting `tabId`, once a live binding the connection's own credential made for that tab is found |
 * | Taken from the request | the claimed project (checked, never trusted) | the envelope's acting `tabId` (checked against the live binding table, never trusted) and its `sessionId` (which must be that binding's); the payload carries no routing |
 *
 * Neither path accepts the other's context: a `devtools` or `vscode`
 * credential is refused on the HTTP route by `OPERATION_ROLES`, and a
 * `server-agent` or `vscode` connection is refused on the frame path by
 * {@link TELEMETRY_FRAME_ROLES}. Both decisions read the principal
 * `../auth.ts` resolved from the stored credential, never a client's
 * self-description.
 *
 * ### The server-agent scope rule (AAP §0.5.6)
 *
 * A server-agent credential authorises one project, not a subtree. The body's
 * `projectRoot` is checked against the credential with `requireProjectScope`
 * (exact equality after POSIX normalisation, so a descendant such as
 * `<project>/packages/app` and a prefix sibling such as `<project>-evil` are
 * both refused) before anything is read from the store. The credential's own
 * root is then passed to ingest as `scopedProjectRoot`, where the attributor
 * applies the same rule again. A mismatch is answered `403` — an authorization
 * refusal, not a drop: the preload's project root is fixed for its lifetime,
 * so every later batch would mismatch too, and the preload's exporter treats
 * `401`/`403` as "stop posting with this credential", which is exactly right.
 *
 * ### The relayed-tab rule
 *
 * The page agent owns no socket; the service worker relays its batches under
 * the tab's DevTools connection, and one service-worker connection — one
 * paired credential — carries **every** inspected tab. Neither the credential
 * nor the connection can say which tab a batch came from, so the batch names
 * its tab and the service checks that claim against its own live binding
 * table. A batch is never attributed to a tab it did not name:
 *
 * 1. **The acting tab** is the envelope's `tabId` (the service worker fills it
 *    from Chrome's port metadata for the tab whose page produced the batch),
 *    else the tab a single-tab connection announced in `client.hello`. When
 *    both are present and differ, or neither is present, the frame is refused
 *    (`TAB_NOT_BOUND`) — the connection's hello or "primary" tab is never
 *    substituted for the page that produced the batch.
 * 2. **The acting tab's live binding** must exist and must have been made by
 *    this connection's credential (`requireBoundSession`, with the acting tab).
 *    No live binding is a refusal, not a drop: the batch is not stored,
 *    whatever durable row survived a restart, because such a row carries no
 *    credential to authorise it.
 * 3. **The envelope's `sessionId`**, when present, must be that binding's
 *    session. A key naming another session is stale — the tab moved or its
 *    binding was replaced after the batch was queued — and is refused, never
 *    re-attributed to the tab's current session.
 *
 * The acting tab — and only it — is handed to ingest, which attributes the
 * batch to that tab's session's open capture.
 *
 * ## Failure contract
 *
 * Nothing here throws and no returned promise rejects. A batch ingest
 * **dropped** in whole or in part — no open capture, an unresolvable session,
 * a tier its producer may not report — is not a failure: it is an honest
 * report, answered `202 { accepted, rejected }` over HTTP and `ok(report)` to
 * `../ws.ts`, and it is what makes "an unrelated plan collects no backend
 * telemetry" true end to end. Every real failure answers with protocol's error
 * payload at a status the producer can act on:
 *
 * | Outcome | HTTP | Frame |
 * | --- | --- | --- |
 * | accepted (including drops) | `202 { accepted, rejected? }` | `ok(IngestReport)` |
 * | no resolved principal | `401` `UNAUTHORIZED` | — |
 * | wrong role | `403` `UNAUTHORIZED` | `err` `UNAUTHORIZED` |
 * | project outside the credential's scope | `403` `PATH_OUTSIDE_PROJECT` | — |
 * | no acting tab, a conflicting one, or one with no live binding by this credential for the envelope's session | — | `err` `TAB_NOT_BOUND` |
 * | tab's relay carried {@link MALFORMED_FRAME_LIMIT} malformed frames within {@link MALFORMED_FRAME_WINDOW_MS} | — | `err` `RATE_LIMITED`, unread, for that long |
 * | body larger than {@link MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES}, declared or as it arrives | `413` | — |
 * | body that did not arrive within `../http.ts`'s time ceiling | `408` | — |
 * | unreadable, non-JSON, off-schema or over-size batch | `400` `PROTOCOL_INVALID_MESSAGE` | `err` `PROTOCOL_INVALID_MESSAGE` |
 * | store or internal failure | `500` fixed message and its code | `err` with its code |
 *
 * A `5xx` is reserved for failures a retry can fix: the store's
 * `ON CONFLICT(id) DO NOTHING` makes a retried batch idempotent, so a producer
 * that resends after a `500` never duplicates a row.
 *
 * ### One malformed span never costs a batch (AAP §0.5.5)
 *
 * The ingest body is validated against protocol's `telemetryIngestRequestSchema`
 * through `parseHttpRequest`. When every issue it reports lies *inside* an
 * element of `events` — the envelope (`projectRoot`, the array itself, its
 * bounds, no stray keys) being sound — the batch is not refused whole: the raw
 * array goes to ingest, which validates element by element, counts each
 * malformed element as `invalid` and stores the rest. The response's `rejected`
 * count says how many did not make it. Any envelope-level issue is a `400`.
 *
 * ## Privacy of what this module says
 *
 * This is the highest-volume path for a developer's runtime data, so nothing
 * captured is ever echoed. Log records carry an operation id, a status, an
 * error code, a drop reason, a connection id, a tab id and counts — never an
 * event, an attribute value, a URL, a `db.statement`, a `request_key`, a
 * project path or a credential. Validation failures are rendered by
 * protocol's `describeZodIssues` (issue paths and codes, never a rejected
 * value), `JSON.parse`'s own message (which quotes its input) is discarded, and
 * a `500` carries a fixed sentence rather than the failure's own words.
 *
 * Nor is it written at the rate a producer chooses: every warning and error
 * passes through ingest's `createLogThrottle` (a relayed-frame refusal keyed by
 * its connection id and error code, an HTTP record by its operation and error
 * code), so at most one record per key per interval is written, carrying a
 * `suppressed` count of the repeats held back, under a ceiling across all keys;
 * repeats no later record carries are written as a trailing summary one
 * interval on. The per-frame refusal debug records pass through a second
 * throttle of the same shape.
 *
 * ## Admission of relayed frames
 *
 * A page script can post bridge-shaped batches as fast as the bridge relays
 * them, and each costs a validation pass over up to `MAX_INGEST_BATCH`
 * elements. So each relayed tab of a connection is counted: once it has
 * carried {@link MALFORMED_FRAME_LIMIT} malformed frames — not an array,
 * over-size, refused by ingest as malformed, or entirely malformed elements —
 * within {@link MALFORMED_FRAME_WINDOW_MS}, its frames are refused with
 * `RATE_LIMITED` for that long without their payload being read. The page
 * agent's own batches are well formed and never counted, other tabs on the same
 * connection are unaffected, and a service fault (the store, the session
 * secret) is never counted against a producer.
 *
 * @example Composition in `../http.ts` and `../ws.ts`
 * ```ts
 * const telemetry = createTelemetryRoutes({ ingest, bindings: clients, logger });
 *
 * // http.ts — table-driven registration behind the auth middleware:
 * for (const operation of TELEMETRY_OPERATIONS) {
 *   const { method, pattern } = HTTP_ROUTES[operation];
 *   app.on(method, pattern, authFor(operation), telemetry.handlers[operation]);
 * }
 *
 * // ws.ts — inside the exhaustive inbound switch:
 * case 'telemetry.event': {
 *   const outcome = await telemetry.handleTelemetryEventFrame({ message, client });
 *   if (isErr(outcome)) replyWithError(client, outcome.error, message.id);
 *   break;
 * }
 * ```
 *
 * @module
 */

import type { Context, Handler } from 'hono';

import {
  HTTP_ROUTES,
  MESSAGE_TYPE,
  parseHttpRequest,
  parseHttpResponse,
  toErrorPayload,
} from '@debuggen/protocol';
import type { HttpErrorResponse, MessageByType, TelemetryIngestRequest } from '@debuggen/protocol';
import { DebuggenError, err, isErr, noopLogger, nowEpochMs, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';

import { guardLogger, subsystemLogger } from '../../logging.js';
import type { DropReason } from '../../telemetry/attribute.js';
import {
  MAX_INGEST_BATCH,
  createLogThrottle,
  summaryFields,
  suppressionFields,
  toIngestResponse,
} from '../../telemetry/ingest.js';
import type {
  IngestReport,
  LogThrottle,
  LogThrottleSummary,
  TelemetryIngest,
} from '../../telemetry/ingest.js';
import {
  AUTH_FAILURE_REASONS,
  OPERATION_ROLES,
  authErrorResponse,
  authFailureReasonOf,
  requireBoundSession,
  requireProjectScope,
  requireRole,
} from '../auth.js';
import type {
  AuthFailureReason,
  AuthenticatedOperation,
  Principal,
  PrincipalRole,
  ServerAgentPrincipal,
  ServerEnv,
} from '../auth.js';
import type { ClientRegistry, RegisteredClient } from '../clients.js';

/* -------------------------------------------------------------------------------------------------
 * The operation this module owns
 * ---------------------------------------------------------------------------------------------- */

/**
 * `telemetry.event` — protocol's name for both doors (prompt §16 preserved
 * verbatim): the HTTP operation of `POST /telemetry/ingest` and the WebSocket
 * message type of a relayed batch.
 *
 * The value is protocol's own `MESSAGE_TYPE.TELEMETRY_EVENT` constant, not a
 * literal restated here, so it is a WebSocket message type by derivation and
 * its spelling lives in protocol alone. `satisfies AuthenticatedOperation` is
 * the compile-time proof of the other half: the same name is still an HTTP
 * operation that protocol requires a bearer credential for — were it flagged
 * exempt, the handler below would run without a principal — so a change on
 * that side stops this line compiling.
 */
const TELEMETRY_EVENT = MESSAGE_TYPE.TELEMETRY_EVENT satisfies AuthenticatedOperation;

/**
 * The protocol operations this module answers over HTTP, in the route table's
 * order.
 *
 * `../http.ts` builds an exhaustive `Record<HttpOperationId, handler>` from the
 * route modules; this tuple is this module's slice of that record.
 */
export const TELEMETRY_OPERATIONS = Object.freeze([
  TELEMETRY_EVENT,
] as const satisfies readonly AuthenticatedOperation[]);

/** One of {@link TELEMETRY_OPERATIONS}. */
export type TelemetryOperation = (typeof TELEMETRY_OPERATIONS)[number];

/**
 * The roles the access boundary lets call `POST /telemetry/ingest`.
 *
 * Read from `../auth.ts`'s single role table, never restated; the annotation
 * pins it to exactly the server agent, so a change to that table fails this
 * file's build instead of silently letting another role post server spans.
 */
const INGEST_ROLES: readonly ['server-agent'] = OPERATION_ROLES[TELEMETRY_EVENT];

/** The one role {@link INGEST_ROLES} names, used to narrow the principal's scope. */
const [INGEST_ROLE] = INGEST_ROLES;

/**
 * The roles that may relay a `telemetry.event` frame: the DevTools connection
 * of the Chrome service worker, which carries the page agent's batches for the
 * tabs its credential bound (AAP §0.4.2).
 *
 * Declared here because `OPERATION_ROLES` covers HTTP operations only. The page
 * agent itself holds no credential (`roleForClientKind('agent')` is
 * `undefined`), the editor observes rather than produces runtime evidence, and
 * a server agent posts its spans over HTTP under its project scope — so a frame
 * from any of those is refused rather than attributed.
 */
export const TELEMETRY_FRAME_ROLES = Object.freeze([
  'devtools',
] as const satisfies readonly PrincipalRole[]);

/* -------------------------------------------------------------------------------------------------
 * Policy constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The largest ingest request body accepted, in bytes.
 *
 * The preload posts a few hundred spans per request and buffers at most the
 * protocol's element ceiling, so an honest body is well under a mebibyte. The
 * bound admits the protocol's full element ceiling at several kibibytes per
 * span — far above any real batch — while keeping one request from making the
 * service buffer an arbitrarily large body before the schema can refuse it. A
 * body declared or found larger is answered `413` without being parsed.
 */
export const MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/** The request header a client declares its body length in. */
const CONTENT_LENGTH_HEADER = 'content-length';

/** The success status of an ingest request: the batch was taken for processing and reported on. */
const ACCEPTED_STATUS = 202;

/** The log subsystem binding of this module's records. */
const LOG_SUBSYSTEM = 'server.telemetry';

/**
 * The field of the ingest body that holds the batch — schema vocabulary, typed
 * against protocol's inferred request so a rename upstream fails to compile.
 */
const EVENTS_FIELD = 'events' satisfies keyof TelemetryIngestRequest;

/** The field of the ingest body that names the project. */
const PROJECT_ROOT_FIELD = 'projectRoot' satisfies keyof TelemetryIngestRequest;

/**
 * The fixed message of a `500`: ingest failed for a reason a producer cannot
 * act on in its own words (a store or internal failure). The detail is in the
 * service log, which ingest already wrote.
 */
const INGEST_UNAVAILABLE_MESSAGE =
  'The Debug Generator local service could not store this telemetry batch. Its log holds the reason; the batch may be sent again.';

/**
 * The fixed message of a `500` when the response this module built does not
 * satisfy protocol's response schema — a drift between ingest and the route
 * table, never something a producer caused.
 */
const RESPONSE_DRIFT_MESSAGE =
  'The Debug Generator local service built a telemetry ingest response that does not match the protocol. Its log holds the reason.';

/** The fixed message of an unexpected failure inside a handler of this module. */
const HANDLER_FAILURE_MESSAGE =
  'The Debug Generator local service failed unexpectedly while taking a telemetry batch. Its log holds the reason.';

/** The refusal message of a frame whose tab this connection's credential did not bind. */
const FOREIGN_TAB_MESSAGE =
  'This DevTools connection may relay telemetry only for a tab its own credential bound.';

/** The refusal message of a frame that names no tab on a connection that announced none. */
const UNKNOWN_TAB_MESSAGE =
  'A telemetry.event frame must name the inspected tab it was captured in; this one named none.';

/** The refusal message of a frame whose tab differs from the one its connection announced. */
const CONFLICTING_TAB_MESSAGE =
  'This connection announced one inspected tab in its hello and may relay telemetry only for that tab; the frame named another.';

/** The refusal message of a frame whose tab has no live binding. */
const UNBOUND_TAB_MESSAGE =
  'The tab this telemetry.event frame names is not bound to a session, so its batch was not stored.';

/** The refusal message of a frame whose routing key names a session other than its tab's. */
const STALE_SESSION_MESSAGE =
  'This telemetry.event frame names a session its tab is no longer bound to, so its batch was not stored.';

/** The hint of every tab refusal. */
const TAB_REFUSAL_HINT =
  'Open the Debug Generator panel on the tab running the session, so its binding is made by this extension, then capture again.';

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/**
 * What {@link createTelemetryRoutes} is built from — the narrowest slices of
 * the collaborators the two handlers call, and an optional logger.
 *
 * Declared here, next to the routes that need it, so `../http.ts` and
 * `../ws.ts` compose their dependency aggregates from this interface rather
 * than restating its fields.
 */
export interface TelemetryRoutesDeps {
  /**
   * The ingest pipeline's two transport entries. Validation, keying,
   * redaction, attribution, persistence, correlation and the live tail all
   * happen inside these calls, in that order.
   */
  readonly ingest: Pick<TelemetryIngest, 'ingestFromAgent' | 'ingestFromServerAgent'>;

  /**
   * The client registry's live binding view: which credential bound which tab
   * to which session. Read to check a relayed frame's acting tab against its
   * live binding and to refuse a connection relaying for a tab another
   * credential bound, or for a tab no one has bound.
   */
  readonly bindings: Pick<ClientRegistry, 'bindingForTab' | 'bindingForSession'>;

  /**
   * Where this module's diagnostics go; defaults to the no-op logger. Records
   * carry constant text, operation ids, statuses, codes, drop reasons,
   * connection and tab ids, and counts — never an event or any part of one.
   */
  readonly logger?: Logger | undefined;

  /**
   * The clock the log throttle paces this module's warnings and errors on, in
   * epoch milliseconds; defaults to `nowEpochMs`. Optional, so the aggregates
   * `../http.ts` and `../ws.ts` compose from this interface need not name it.
   */
  readonly now?: (() => number) | undefined;
}

/**
 * The ingest route handler, typed on the service's hono environment so
 * `c.get('principal')` is the principal `../auth.ts`'s middleware resolved.
 */
export type TelemetryRouteHandler = Handler<ServerEnv>;

/**
 * The HTTP handlers of this module, keyed by protocol operation id so
 * `../http.ts` can place them in its exhaustive handler record unchanged.
 */
export type TelemetryRouteHandlers = Readonly<Record<TelemetryOperation, TelemetryRouteHandler>>;

/** A parsed `telemetry.event` frame: protocol's envelope around the `{ events }` batch. */
export type TelemetryEventMessage = MessageByType<typeof TELEMETRY_EVENT>;

/**
 * The facts about the connection a frame arrived on that this module reads:
 * its process-local id and kind (for diagnostics), the principal `../auth.ts`
 * resolved from its credential (the only authority), and the tab it announced
 * in `client.hello`, which makes it a single-tab connection (a claim checked
 * against the live binding table, never authority).
 *
 * A {@link RegisteredClient} snapshot from `../clients.ts` satisfies it as it
 * stands.
 */
export type TelemetryFrameConnection = Pick<
  RegisteredClient,
  'id' | 'kind' | 'principal' | 'tabId'
>;

/** What `../ws.ts` hands {@link TelemetryRoutes.handleTelemetryEventFrame}. */
export interface TelemetryEventFrame {
  /** The frame, already decoded and validated by protocol's `parseMessage`. */
  readonly message: TelemetryEventMessage;
  /** The authenticated connection the frame arrived on. */
  readonly client: TelemetryFrameConnection;
}

/**
 * The WebSocket batch handler. Never throws and never rejects.
 *
 * `ok(report)` — including for a batch ingest dropped — carries counts,
 * identifiers and trace ids only; `../ws.ts` sends nothing back for it. An
 * `Err` is a real refusal or failure, answered by `../ws.ts` with protocol's
 * `error` message built from `DebuggenError.toPayload()`; every error this
 * module or ingest raises is safe to send as-is.
 */
export type TelemetryEventFrameHandler = (
  frame: TelemetryEventFrame,
) => Promise<Result<IngestReport, DebuggenError>>;

/** Everything {@link createTelemetryRoutes} returns. */
export interface TelemetryRoutes {
  /** `telemetry.event` → `POST /telemetry/ingest`, for the table-driven registration loop. */
  readonly handlers: TelemetryRouteHandlers;
  /** The same HTTP handler under its descriptive name. */
  readonly handleIngestRequest: TelemetryRouteHandler;
  /** The relayed-batch handler `../ws.ts` dispatches every `telemetry.event` frame to. */
  readonly handleTelemetryEventFrame: TelemetryEventFrameHandler;
}

/** Every status the ingest route answers a failure with. */
export type TelemetryIngestFailureStatus = 400 | 401 | 403 | 408 | 413 | 429 | 500;

/* -------------------------------------------------------------------------------------------------
 * Failure vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The statuses of the failures this route describes to its caller in the
 * failure's own words, by error code.
 *
 * - `PROTOCOL_INVALID_MESSAGE` — a body protocol's request schema refused, one
 *   that is not JSON, or a batch ingest refused as not-an-array or over-size:
 *   `400`. Its message comes from protocol's `describeZodIssues` or from
 *   ingest's constant sentences, neither of which quotes a rejected value.
 *
 * Every other code — `STORE_ERROR`, `INTERNAL`, anything unforeseen — is
 * answered `500` with {@link INGEST_UNAVAILABLE_MESSAGE} and its code, so a
 * store failure never reaches a response body in its own words and the
 * producer retries (safely: the store skips an identical replayed event).
 * Access-boundary refusals never reach this table: `../auth.ts`'s own
 * `authErrorResponse` renders them at the status its reason table fixes.
 */
const STATUS_BY_CODE: ReadonlyMap<DebuggenError['code'], 400> = new Map<DebuggenError['code'], 400>(
  [['PROTOCOL_INVALID_MESSAGE', 400]],
);

/**
 * The status a failure of the ingest route is answered with.
 *
 * An access-boundary refusal (its `details.reason` names an entry of
 * `../auth.ts`'s `AUTH_FAILURE_REASONS`) takes that table's status — `401`,
 * `403` or `429`; a failure {@link STATUS_BY_CODE} describes takes its status;
 * everything else is `500`.
 *
 * Only a credential or scope problem ever becomes a `401`/`403`: the preload's
 * exporter reads either as "this credential is refused" and stops posting, so a
 * transient condition must never be reported that way.
 *
 * @param error Any failure met while answering an ingest request.
 * @returns The HTTP status to answer with.
 *
 * @example
 * ```ts
 * telemetryIngestFailureStatus(new DebuggenError('PROTOCOL_INVALID_MESSAGE', 'Not an array.'));
 * // → 400
 * telemetryIngestFailureStatus(new DebuggenError('STORE_ERROR', 'The store failed.'));
 * // → 500
 * ```
 */
export function telemetryIngestFailureStatus(error: DebuggenError): TelemetryIngestFailureStatus {
  if (authFailureReasonOf(error) !== undefined) {
    return authErrorResponse(error).status;
  }
  return STATUS_BY_CODE.get(error.code) ?? 500;
}

/**
 * Builds the refusal `../auth.ts` raises for `reason`, from its own table: the
 * table's code, its constant message unless a more specific constant is given,
 * `details.reason` naming the entry (which is what `authErrorResponse` maps
 * back to a status) and the table's hint unless one is given. No presented
 * value can reach it.
 *
 * @param reason The {@link AUTH_FAILURE_REASONS} entry to raise.
 * @param message A constant sentence replacing the table's message.
 * @param hint A constant sentence replacing the table's hint.
 * @returns A refusal indistinguishable in shape from one `../auth.ts` returned itself.
 */
function refusalFor(reason: AuthFailureReason, message?: string, hint?: string): DebuggenError {
  const descriptor = AUTH_FAILURE_REASONS[reason];
  const tableHint: string | undefined = 'hint' in descriptor ? descriptor.hint : undefined;
  const effectiveHint = hint ?? tableHint;
  return new DebuggenError(descriptor.code, message ?? descriptor.message, {
    details: { reason },
    ...(effectiveHint === undefined ? {} : { hint: effectiveHint }),
  });
}

/**
 * The refusal of a relayed batch longer than ingest accepts: counts only.
 * Raised before delegation so an over-size frame is refused whole, never
 * truncated or partially stored.
 */
function oversizeFrameError(received: number): DebuggenError {
  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    `A telemetry.event frame may carry at most ${String(MAX_INGEST_BATCH)} events.`,
    {
      hint: 'Split the batch into smaller frames; a longer one is refused whole rather than truncated.',
      details: { problem: 'batch-too-large', received, maxBatch: MAX_INGEST_BATCH },
    },
  );
}

/** The refusal of a frame whose `events` is not an array: a structural label, never the value. */
function malformedFrameError(): DebuggenError {
  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    'A telemetry.event frame must carry its events as an array.',
    {
      hint: 'Send { events: [...] } with each producer event as an element.',
      details: { problem: 'not-an-array' },
    },
  );
}

/**
 * The error an unexpected throw inside a handler becomes. The thrown value may
 * hold captured data, so it is neither echoed nor attached as a cause.
 */
function handlerFailure(): DebuggenError {
  return new DebuggenError('INTERNAL', HANDLER_FAILURE_MESSAGE);
}

/* -------------------------------------------------------------------------------------------------
 * The ingest request body
 * ---------------------------------------------------------------------------------------------- */

/** Why a request body was refused before it reached ingest. */
interface BodyRejection {
  /**
   * `413` for an oversized body, `408` for one that did not arrive in time,
   * `400` for one that is unreadable, not JSON or off-schema.
   */
  readonly status: 400 | 408 | 413;
  /** The refusal; its message never quotes the body. */
  readonly error: DebuggenError;
}

/** The `details` key `../http.ts`'s request-body guard records its refusal reason under. */
const GUARD_REASON_DETAIL_KEY = 'reason';

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
  const reason = caught.details?.[GUARD_REASON_DETAIL_KEY];
  return reason === GUARD_BODY_TOO_LARGE_REASON || reason === GUARD_BODY_READ_TIMEOUT_REASON
    ? reason
    : undefined;
}

/**
 * An ingest body whose envelope is sound: the project it claims and the batch
 * to hand ingest.
 *
 * `events` is the validated array when the whole body parsed, and the raw
 * array when only elements failed (see {@link salvageElementFailures}) — in
 * which case ingest counts each malformed element as `invalid`.
 */
interface IngestRequestEnvelope {
  /** The body's `projectRoot`, validated by protocol's field schema. */
  readonly projectRoot: string;
  /** The batch, for ingest to validate element by element. */
  readonly events: readonly unknown[];
  /** How many elements protocol's schema refused; `0` when the whole body parsed. */
  readonly refusedElements: number;
}

/** Protocol's request schema of the operation — `telemetryIngestRequestSchema`, read from the route table. */
const INGEST_REQUEST_SCHEMA = HTTP_ROUTES[TELEMETRY_EVENT].request;

/** The refusal of a body larger than {@link MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES}. */
function bodyTooLarge(): BodyRejection {
  return {
    status: 413,
    error: new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The ${TELEMETRY_EVENT} request body is larger than this operation accepts.`,
      {
        hint: `Send a JSON body of at most ${String(MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES)} bytes; split a larger batch.`,
        details: {
          operation: TELEMETRY_EVENT,
          maxBytes: MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES,
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
      `The ${TELEMETRY_EVENT} request body did not arrive in time.`,
      {
        hint: 'Send the whole batch at once, then wait for the reply.',
        details: { operation: TELEMETRY_EVENT, problem: GUARD_BODY_READ_TIMEOUT_REASON },
      },
    ),
  };
}

/** The refusal of a body that is unreadable or not JSON; the body itself is never quoted. */
function bodyNotJson(problem: 'unreadable' | 'not-json'): BodyRejection {
  const message =
    problem === 'unreadable'
      ? `The ${TELEMETRY_EVENT} request body could not be read.`
      : `The ${TELEMETRY_EVENT} request body is not valid JSON.`;
  return {
    status: 400,
    error: new DebuggenError('PROTOCOL_INVALID_MESSAGE', message, {
      hint: 'Send { projectRoot, events } as a JSON object.',
      details: { operation: TELEMETRY_EVENT, problem },
    }),
  };
}

/**
 * Reads the request body as JSON, bounded by
 * {@link MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES}.
 *
 * A declared `Content-Length` above the bound is refused before anything is
 * read. A body that declares no length (a chunked upload) is bounded while it
 * is read: `../http.ts`'s request-body guard errors the stream at the same
 * bound — and at its time ceiling — so `c.req.text()` rejects with the guard's
 * refusal instead of buffering an unbounded body, and that rejection is
 * answered `413` or `408` here. The text read is measured once more, which
 * keeps the bound for a handler composed without the guard. An empty body
 * reads as `undefined`, which protocol's request schema then refuses.
 * `JSON.parse`'s own error is discarded, because Node's message for it quotes
 * the offending input — here, captured data.
 *
 * @param c The request context.
 * @returns The parsed value, or the refusal.
 */
async function readJsonBody(c: Context<ServerEnv>): Promise<Result<unknown, BodyRejection>> {
  const declared = c.req.header(CONTENT_LENGTH_HEADER);
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES) {
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
    return err(bodyNotJson('unreadable'));
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TELEMETRY_INGEST_REQUEST_BODY_BYTES) {
    return err(bodyTooLarge());
  }
  if (text.trim().length === 0) {
    return ok(undefined);
  }

  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch {
    return err(bodyNotJson('not-json'));
  }
}

/**
 * Reads one own property of a plain JSON object, or `undefined`.
 *
 * @param value A value produced by `JSON.parse`.
 * @param key The property to read.
 */
function readJsonProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, key)
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

/**
 * Whether a validation issue lies inside one element of `events` — as opposed
 * to the envelope: the root object, its keys, `projectRoot`, or the array
 * itself (its type or its length bounds).
 *
 * @param issue One issue of protocol's request-schema parse.
 */
function isElementIssue(issue: { readonly path: readonly PropertyKey[] }): boolean {
  return (
    issue.path.length >= 2 && issue.path[0] === EVENTS_FIELD && typeof issue.path[1] === 'number'
  );
}

/**
 * Recovers the envelope of a body whose only validation failures are inside
 * elements of `events` (AAP §0.5.5: one malformed span must never cost the
 * batch).
 *
 * Re-runs protocol's own request schema to read the structured issue paths,
 * and recovers the body only when **every** issue is element-level and the
 * envelope checks out on its own: `projectRoot` passes the schema's field
 * schema, and `events` is a non-empty array within ingest's ceiling. Nothing
 * is parsed element by element here — ingest does that, with the same strict
 * ingress schema, and counts each refused element.
 *
 * @param raw The parsed JSON body protocol's schema refused.
 * @returns The envelope to delegate, or `undefined` when the body must be refused whole.
 */
function salvageElementFailures(raw: unknown): IngestRequestEnvelope | undefined {
  const parsed = INGEST_REQUEST_SCHEMA.safeParse(raw);
  if (parsed.success) {
    return undefined;
  }

  const issues = parsed.error.issues;
  if (issues.length === 0 || !issues.every(isElementIssue)) {
    return undefined;
  }

  const projectRoot = INGEST_REQUEST_SCHEMA.shape.projectRoot.safeParse(
    readJsonProperty(raw, PROJECT_ROOT_FIELD),
  );
  const events = readJsonProperty(raw, EVENTS_FIELD);
  if (
    !projectRoot.success ||
    !Array.isArray(events) ||
    events.length === 0 ||
    events.length > MAX_INGEST_BATCH
  ) {
    return undefined;
  }

  const refused = new Set<number>();
  for (const issue of issues) {
    const index = issue.path[1];
    if (typeof index === 'number') {
      refused.add(index);
    }
  }

  const batch: readonly unknown[] = events;
  return { projectRoot: projectRoot.data, events: batch, refusedElements: refused.size };
}

/**
 * Reads and validates the ingest body against protocol's route table, through
 * the same `parseHttpRequest` a client validates its outbound body with — so
 * the service accepts exactly what a producer can send — and recovers a body
 * whose only faults are inside elements.
 *
 * @param c The request context.
 * @returns The envelope to delegate, or the refusal (`400`/`413`).
 */
async function readIngestRequest(
  c: Context<ServerEnv>,
): Promise<Result<IngestRequestEnvelope, BodyRejection>> {
  const raw = await readJsonBody(c);
  if (isErr(raw)) {
    return raw;
  }

  const parsed = parseHttpRequest(TELEMETRY_EVENT, raw.value);
  if (!isErr(parsed)) {
    return ok({
      projectRoot: parsed.value.projectRoot,
      events: parsed.value.events,
      refusedElements: 0,
    });
  }

  const salvaged = salvageElementFailures(raw.value);
  return salvaged === undefined ? err({ status: 400, error: parsed.error }) : ok(salvaged);
}

/* -------------------------------------------------------------------------------------------------
 * Authorization helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The drop reason ingest reports when the body's project and the credential's
 * scope disagree — answered as the authorization refusal it is.
 */
const PROJECT_SCOPE_MISMATCH = 'project-scope-mismatch' satisfies DropReason;

/**
 * Requires the ingest role and narrows the principal to the server agent, whose
 * project scope the rest of the request is checked against.
 *
 * @param principal The principal the auth middleware resolved.
 * @returns The server-agent principal, or `UNAUTHORIZED` (`role-not-permitted`, 403).
 */
function asServerAgent(principal: Principal): Result<ServerAgentPrincipal, DebuggenError> {
  const permitted = requireRole(principal, ...INGEST_ROLES);
  if (isErr(permitted)) {
    return permitted;
  }
  return principal.role === INGEST_ROLE ? ok(principal) : err(refusalFor('role-not-permitted'));
}

/* -------------------------------------------------------------------------------------------------
 * The routes
 * ---------------------------------------------------------------------------------------------- */

/** The logging levels this module writes at. */
type TelemetryLogLevel = 'debug' | 'warn' | 'error';

/**
 * The classes of warning and error this module writes, each a log-throttle
 * key prefix: a relayed-frame refusal is keyed with its connection id and
 * error code, an HTTP record with its operation and error code.
 */
const LOG_CLASS = Object.freeze({
  missingPrincipal: 'missing-principal',
  scopeRefused: 'scope-refused',
  ingestRefused: 'ingest-refused',
  scopeMismatch: 'scope-mismatch',
  responseDrift: 'response-drift',
  ingestHandlerFailed: 'ingest-handler-failed',
  frameRefused: 'frame-refused',
  frameHandlerFailed: 'frame-handler-failed',
  frameAdmissionClosed: 'frame-admission-closed',
});

/**
 * The classes of debug record this module writes per relayed frame, admitted
 * by a debug throttle so a connection that repeats them cannot flood the log
 * at the debug level either.
 */
const DEBUG_CLASS = Object.freeze({
  frameWrongRole: 'frame-wrong-role',
  frameOversize: 'frame-oversize',
  frameForeignTab: 'frame-foreign-tab',
  frameAdmissionRefused: 'frame-admission-refused',
});

/**
 * How many malformed frames one connection may relay within
 * {@link MALFORMED_FRAME_WINDOW_MS} before its frames are refused unread.
 *
 * A malformed frame is one whose `events` is not an array or is over-size, one
 * ingest refuses outright, or one of which ingest stored nothing because every
 * element was malformed. The page agent sends a handful of well-formed batches
 * a second, so this is never reached by it; a page script posting forged
 * batches through the bridge reaches it within a fraction of a second.
 */
export const MALFORMED_FRAME_LIMIT = 20;

/**
 * The window {@link MALFORMED_FRAME_LIMIT} is counted over, and how long a
 * connection that reached it has its frames refused, in milliseconds.
 */
export const MALFORMED_FRAME_WINDOW_MS = 10_000;

/** The code of a refusal of a frame's own content, the only ingest refusal counted as malformed. */
const MALFORMED_FRAME_CODE = 'PROTOCOL_INVALID_MESSAGE' satisfies DebuggenErrorCode;

/** How many connections the malformed-frame admission remembers at once; the least recent is forgotten first. */
const MALFORMED_FRAME_MAX_CONNECTIONS = 256;

/** The refusal of a frame from a connection whose admission is closed. */
function admissionClosedError(retryAfterMs: number): DebuggenError {
  return new DebuggenError(
    'RATE_LIMITED',
    'Telemetry frames from this connection are refused for a moment: it relayed too many malformed batches.',
    {
      hint: 'Well-formed batches are accepted again once the pause ends; reload the page if it keeps happening.',
      details: { retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) },
    },
  );
}

/** One log-throttle key from its parts; the separator cannot occur in an id or a code. */
function throttleKey(...parts: readonly (string | number)[]): string {
  return parts.map(String).join('\u0000');
}

/** The total of a report's per-reason drop counts. */
function droppedTotal(report: IngestReport): number {
  let total = 0;
  for (const count of Object.values(report.dropped)) {
    total += count;
  }
  return total;
}

/**
 * The counts of a report, as log fields: counts, the drop reason vocabulary
 * and an error code only — never an identifier a producer chose, never content.
 */
function reportFields(report: IngestReport): LogFields {
  return {
    received: report.received,
    parsed: report.parsed,
    invalid: report.invalid,
    dropped: droppedTotal(report),
    persisted: report.persisted,
    inserted: report.inserted,
    skipped: report.skipped,
    ...(report.batchDropReason === undefined ? {} : { dropReason: report.batchDropReason }),
    ...(report.batchDropCode === undefined ? {} : { dropCode: report.batchDropCode }),
  };
}

/**
 * Builds the telemetry intake: the `POST /telemetry/ingest` handler and the
 * `telemetry.event` frame handler.
 *
 * Registers nothing, opens nothing and holds no state beyond its dependencies
 * and its log throttle (see "Privacy of what this module says").
 * `../http.ts` registers {@link TelemetryRoutes.handlers} from protocol's route
 * table (`HTTP_ROUTES[operation].method` / `.pattern`) behind the auth
 * middleware, which has already refused web origins and resolved the
 * principal; `../ws.ts` hands every parsed `telemetry.event` frame, with the
 * registered connection it arrived on, to
 * {@link TelemetryRoutes.handleTelemetryEventFrame}. See the module notes for
 * the status table and the two authorization postures.
 *
 * @param deps The ingest entries, the live binding view and an optional logger.
 * @returns The HTTP handler (keyed and named) and the frame handler.
 */
export function createTelemetryRoutes(deps: TelemetryRoutesDeps): TelemetryRoutes {
  const { ingest, bindings } = deps;
  // Guarded before the child is derived, so neither `child()` nor any level
  // method can throw: a failed write is dropped and counted by the shared
  // best-effort policy of `../../logging.ts`, and the handler's decision stands.
  const logger: Logger = subsystemLogger(guardLogger(deps.logger ?? noopLogger), LOG_SUBSYSTEM);

  /** Writes one record through the guarded logger; it never throws. */
  function emit(level: TelemetryLogLevel, message: string, fields: LogFields): void {
    logger[level](message, fields);
  }

  const clock = deps.now ?? nowEpochMs;

  /** A record a throttle may hold back, kept whole so its trailing summary can re-write it. */
  interface HeldRecord {
    readonly level: TelemetryLogLevel;
    readonly message: string;
    readonly fields: LogFields;
  }

  /** Re-writes a held-back record as its trailing summary. */
  const writeSummary = (summary: LogThrottleSummary<HeldRecord>): void => {
    const { level, message, fields } = summary.payload;
    emit(level, message, { ...fields, ...summaryFields(summary) });
  };

  /** Admits every warning and error of these handlers; ingest's own throttle, reused. */
  const throttle = createLogThrottle<HeldRecord>({ now: clock, onSummary: writeSummary });

  /** Admits the per-frame refusal debug records; see {@link DEBUG_CLASS}. */
  const debugThrottle = createLogThrottle<HeldRecord>({ now: clock, onSummary: writeSummary });

  /**
   * Writes a record through `through`: at most one per `key` per interval,
   * carrying how many occurrences were held back since the previous one, and a
   * trailing summary of the held-back ones when no later record carries them.
   */
  function emitThrough(
    through: LogThrottle<HeldRecord>,
    level: TelemetryLogLevel,
    key: string,
    message: string,
    fields: LogFields,
  ): void {
    const verdict = through.admit(key, { level, message, fields });
    if (verdict.write) {
      emit(level, message, { ...fields, ...suppressionFields(verdict) });
    }
  }

  /** Writes a warning or an error through the warning throttle. */
  function emitThrottled(
    level: 'warn' | 'error',
    key: string,
    message: string,
    fields: LogFields,
  ): void {
    emitThrough(throttle, level, key, message, fields);
  }

  /** Writes a per-frame refusal debug record through the debug throttle. */
  function emitDebugThrottled(key: string, message: string, fields: LogFields): void {
    emitThrough(debugThrottle, 'debug', key, message, fields);
  }

  /**
   * The malformed-frame admission, per relayed tab of a connection (keyed by
   * connection id and tab id): how many malformed frames it carried in its
   * current window, and until when its frames are refused unread once it
   * reached {@link MALFORMED_FRAME_LIMIT}. Insertion-ordered and bounded,
   * least recently seen forgotten first.
   */
  interface FrameAdmission {
    windowStartedAt: number;
    malformed: number;
    closedUntil: number | undefined;
  }
  const admissions = new Map<string, FrameAdmission>();
  let lastReading = 0;

  /** The clock's reading, or the last good one when it throws or is not finite. */
  function readClock(): number {
    try {
      const reading = clock();
      if (Number.isFinite(reading)) {
        lastReading = reading;
      }
    } catch {
      // Fall through to the last good reading.
    }
    return lastReading;
  }

  /**
   * How long a relayed tab's frames are still refused, in milliseconds, or
   * `undefined` when its admission is open. A clock that stepped back opens it.
   */
  function admissionClosedFor(key: string, at: number): number | undefined {
    const admission = admissions.get(key);
    const until = admission?.closedUntil;
    if (admission === undefined || until === undefined) {
      return undefined;
    }
    if (at >= until || at < until - MALFORMED_FRAME_WINDOW_MS) {
      admission.closedUntil = undefined;
      admission.windowStartedAt = at;
      admission.malformed = 0;
      return undefined;
    }
    return until - at;
  }

  /**
   * Counts one malformed frame against its relayed tab, and closes that tab's
   * admission for {@link MALFORMED_FRAME_WINDOW_MS} once it has carried
   * {@link MALFORMED_FRAME_LIMIT} within one window.
   */
  function noteMalformed(key: string, clientId: string, tabId: number): void {
    const at = readClock();
    let admission = admissions.get(key);
    if (admission === undefined) {
      admission = { windowStartedAt: at, malformed: 0, closedUntil: undefined };
    } else {
      admissions.delete(key);
    }
    admissions.set(key, admission);
    while (admissions.size > MALFORMED_FRAME_MAX_CONNECTIONS) {
      const oldest = admissions.keys().next();
      if (oldest.done === true) {
        break;
      }
      admissions.delete(oldest.value);
    }

    if (
      at < admission.windowStartedAt ||
      at - admission.windowStartedAt >= MALFORMED_FRAME_WINDOW_MS
    ) {
      admission.windowStartedAt = at;
      admission.malformed = 0;
    }
    admission.malformed += 1;
    if (admission.malformed < MALFORMED_FRAME_LIMIT) {
      return;
    }
    admission.closedUntil = at + MALFORMED_FRAME_WINDOW_MS;
    emitThrottled(
      'warn',
      throttleKey(LOG_CLASS.frameAdmissionClosed, key),
      'a connection relayed too many malformed telemetry frames; its frames are refused for a moment',
      {
        clientId,
        tabId,
        malformed: admission.malformed,
        windowMs: MALFORMED_FRAME_WINDOW_MS,
        refusedForMs: MALFORMED_FRAME_WINDOW_MS,
      },
    );
  }

  /**
   * Answers a failure of the ingest route with protocol's error payload.
   *
   * A refusal is rendered by `../auth.ts`'s own `authErrorResponse`, at the
   * status its reason table fixes. A failure {@link STATUS_BY_CODE} describes is
   * sent in its own words (constant sentences and `describeZodIssues` output).
   * Everything else is a `500` with a fixed message and the failure's code.
   */
  function answerFailure(c: Context<ServerEnv>, error: DebuggenError): Response {
    if (authFailureReasonOf(error) !== undefined) {
      const { status, body } = authErrorResponse(error);
      return c.json(body, status);
    }
    const status = telemetryIngestFailureStatus(error);
    if (status === 500) {
      const body: HttpErrorResponse = { code: error.code, message: INGEST_UNAVAILABLE_MESSAGE };
      return c.json(body, 500);
    }
    return c.json(toErrorPayload(error), status);
  }

  /**
   * `POST /telemetry/ingest`, steps in order — the order is the security
   * property: the role before the body is read, the project scope before
   * anything touches the store.
   */
  async function serveIngest(c: Context<ServerEnv>): Promise<Response> {
    // The middleware sets `principal` for every non-exempt operation. Its
    // absence means the handler was registered without it — a composition
    // defect — and the request is treated as unauthenticated, never as trusted.
    const principal: Principal | undefined = c.get('principal');
    if (principal === undefined) {
      emitThrottled(
        'error',
        throttleKey(LOG_CLASS.missingPrincipal, TELEMETRY_EVENT),
        'telemetry ingest reached its handler without a resolved principal',
        { operation: TELEMETRY_EVENT },
      );
      return answerFailure(c, refusalFor('missing-credential'));
    }

    // 1. Only a dev-server credential may post server spans.
    const agent = asServerAgent(principal);
    if (isErr(agent)) {
      emit('debug', 'refused telemetry ingest for a credential of another role', {
        operation: TELEMETRY_EVENT,
        role: principal.role,
        errorCode: agent.error.code,
      });
      return answerFailure(c, agent.error);
    }

    // 2. The body, validated against protocol's route table.
    const request = await readIngestRequest(c);
    if (isErr(request)) {
      emit('debug', 'refused a telemetry ingest request body', {
        operation: TELEMETRY_EVENT,
        status: request.error.status,
        errorCode: request.error.error.code,
      });
      const body: HttpErrorResponse = toErrorPayload(request.error.error);
      return c.json(body, request.error.status);
    }
    const { projectRoot, events, refusedElements } = request.value;

    // 3. The credential authorises exactly one project; the body's claim must be it.
    const scoped = requireProjectScope(agent.value, projectRoot);
    if (isErr(scoped)) {
      emitThrottled(
        'warn',
        throttleKey(LOG_CLASS.scopeRefused, TELEMETRY_EVENT, scoped.error.code),
        'refused a telemetry batch for a project outside the credential scope',
        { operation: TELEMETRY_EVENT, errorCode: scoped.error.code, received: events.length },
      );
      return answerFailure(c, scoped.error);
    }

    // 4. Delegate: the scope comes from the principal, never from the body.
    const result = await ingest.ingestFromServerAgent({
      projectRoot,
      scopedProjectRoot: agent.value.scope.projectRoot,
      events,
    });
    if (isErr(result)) {
      const status = telemetryIngestFailureStatus(result.error);
      const refusal: LogFields = {
        operation: TELEMETRY_EVENT,
        status,
        errorCode: result.error.code,
        received: events.length,
      };
      if (status >= 500) {
        emitThrottled(
          'warn',
          throttleKey(LOG_CLASS.ingestRefused, TELEMETRY_EVENT, result.error.code),
          'telemetry ingest refused a batch',
          refusal,
        );
      } else {
        emit('debug', 'telemetry ingest refused a batch', refusal);
      }
      return answerFailure(c, result.error);
    }

    const report = result.value;

    // Defence in depth: ingest's attributor applies the scope rule again.
    if (report.batchDropReason === PROJECT_SCOPE_MISMATCH) {
      emitThrottled(
        'warn',
        throttleKey(LOG_CLASS.scopeMismatch, TELEMETRY_EVENT, report.batchDropCode ?? ''),
        'telemetry ingest refused a batch outside the credential scope',
        { operation: TELEMETRY_EVENT, ...reportFields(report) },
      );
      return answerFailure(c, refusalFor('project-out-of-scope'));
    }

    // 5. Answer with counts only: accepted, and rejected when any were.
    const response = parseHttpResponse(TELEMETRY_EVENT, toIngestResponse(report));
    if (isErr(response)) {
      emitThrottled(
        'error',
        throttleKey(LOG_CLASS.responseDrift, TELEMETRY_EVENT, response.error.code),
        'a telemetry ingest response did not satisfy its protocol schema',
        { operation: TELEMETRY_EVENT, errorCode: response.error.code },
      );
      const body: HttpErrorResponse = toErrorPayload(
        new DebuggenError('INTERNAL', RESPONSE_DRIFT_MESSAGE),
      );
      return c.json(body, 500);
    }

    emit('debug', 'telemetry ingest request answered', {
      operation: TELEMETRY_EVENT,
      status: ACCEPTED_STATUS,
      refusedElements,
      ...reportFields(report),
    });
    return c.json(response.value, ACCEPTED_STATUS);
  }

  /** `POST /telemetry/ingest` — server-agent credential required; never throws. */
  const handleIngestRequest: TelemetryRouteHandler = async (c) => {
    try {
      return await serveIngest(c);
    } catch {
      emitThrottled(
        'error',
        throttleKey(LOG_CLASS.ingestHandlerFailed, TELEMETRY_EVENT),
        'the telemetry ingest handler failed unexpectedly',
        { operation: TELEMETRY_EVENT, errorCode: 'INTERNAL' },
      );
      return answerFailure(c, handlerFailure());
    }
  };

  /**
   * The tab a relayed frame belongs to, from the frame's acting tab checked
   * against the service's live binding view — see "The relayed-tab rule" in
   * the module notes. Never a guess: a frame whose tab cannot be established,
   * or whose tab holds no live binding this credential made, is refused whole.
   *
   * @param message The parsed frame; its envelope `tabId` and `sessionId` are read.
   * @param client The connection the frame arrived on.
   * @returns The tab id to hand ingest, or `TAB_NOT_BOUND` (`acting-tab-required`
   * or `session-not-bound`).
   */
  function resolveRelayedTab(
    message: TelemetryEventMessage,
    client: TelemetryFrameConnection,
  ): Result<number, DebuggenError> {
    // 1. The acting tab: the envelope's, else a single-tab connection's hello
    //    tab. The two disagreeing, or neither naming a tab, is refused — the
    //    connection's other ("primary") tab is never substituted.
    const named = message.tabId;
    const announced = client.tabId;
    if (named !== undefined && announced !== undefined && named !== announced) {
      return err(refusalFor('session-not-bound', CONFLICTING_TAB_MESSAGE, TAB_REFUSAL_HINT));
    }
    const acting = named ?? announced;
    if (acting === undefined) {
      return err(refusalFor('acting-tab-required', UNKNOWN_TAB_MESSAGE, TAB_REFUSAL_HINT));
    }

    // 2. That tab's live binding, made by this credential. A tab with no live
    //    binding has no session to attribute to — a durable row surviving a
    //    restart carries no credential and so never attributes a batch.
    const binding = bindings.bindingForTab(acting);
    if (binding === undefined) {
      return err(refusalFor('session-not-bound', UNBOUND_TAB_MESSAGE, TAB_REFUSAL_HINT));
    }
    const guard = requireBoundSession(client.principal, binding.sessionId, binding, acting);
    if (isErr(guard)) {
      return err(refusalFor('session-not-bound', FOREIGN_TAB_MESSAGE, TAB_REFUSAL_HINT));
    }

    // 3. A routing key naming another session is stale (the tab moved, or the
    //    frame was queued for a binding that has since been replaced): refused,
    //    never re-attributed to the tab's current session.
    if (message.sessionId !== undefined && message.sessionId !== binding.sessionId) {
      return err(refusalFor('session-not-bound', STALE_SESSION_MESSAGE, TAB_REFUSAL_HINT));
    }
    return ok(acting);
  }

  /**
   * The relayed-batch path, steps in order: role, admission, batch bound, tab,
   * delegation, and the malformed-frame count.
   */
  async function serveFrame(
    frame: TelemetryEventFrame,
  ): Promise<Result<IngestReport, DebuggenError>> {
    const { message, client } = frame;

    // 1. Only a DevTools connection relays page-agent batches.
    const permitted = requireRole(client.principal, ...TELEMETRY_FRAME_ROLES);
    if (isErr(permitted)) {
      emitDebugThrottled(
        throttleKey(DEBUG_CLASS.frameWrongRole, client.id),
        'refused a telemetry frame from a connection of another role',
        { clientId: client.id, role: client.principal.role, errorCode: permitted.error.code },
      );
      return permitted;
    }

    // 2. The acting tab, checked against a live binding this connection's
    //    credential made for it. Read from the envelope and the connection
    //    alone; the payload is not looked at.
    const events: unknown = message.payload.events;
    const tab = resolveRelayedTab(message, client);
    if (isErr(tab)) {
      emitDebugThrottled(
        throttleKey(DEBUG_CLASS.frameForeignTab, client.id),
        'refused a telemetry frame whose acting tab has no live binding of its own',
        {
          clientId: client.id,
          errorCode: tab.error.code,
          received: Array.isArray(events) ? events.length : 0,
        },
      );
      return tab;
    }
    // One service-worker connection relays several tabs; a page flooding its
    // own tab must not close the admission of the others.
    const admissionKey = throttleKey(client.id, tab.value);

    // 3. Admission: a tab whose relay carried too many malformed frames has
    //    its frames refused unread — no element is looked at — for a moment.
    const closedFor = admissionClosedFor(admissionKey, readClock());
    if (closedFor !== undefined) {
      emitDebugThrottled(
        throttleKey(DEBUG_CLASS.frameAdmissionRefused, admissionKey),
        'refused a telemetry frame from a connection that relayed too many malformed ones',
        { clientId: client.id, tabId: tab.value, retryAfterMs: Math.ceil(closedFor) },
      );
      return err(admissionClosedError(closedFor));
    }

    // 4. The batch must be an array no longer than ingest accepts: refused
    //    whole, before delegation, never truncated.
    if (!Array.isArray(events)) {
      noteMalformed(admissionKey, client.id, tab.value);
      return err(malformedFrameError());
    }
    const batch: readonly unknown[] = events;
    if (batch.length > MAX_INGEST_BATCH) {
      noteMalformed(admissionKey, client.id, tab.value);
      emitDebugThrottled(
        throttleKey(DEBUG_CLASS.frameOversize, admissionKey),
        'refused an over-size telemetry frame',
        { clientId: client.id, received: batch.length, maxBatch: MAX_INGEST_BATCH },
      );
      return err(oversizeFrameError(batch.length));
    }

    // 5. Delegate: attribution to the session and capture happens in ingest.
    //    The payload's delivery context rides along unchanged: `armedCaptureId`
    //    can only refuse a batch recorded for another capture (`stale-capture`),
    //    never choose one, and `droppedCount` is the producer's loss report.
    const { armedCaptureId, droppedCount } = message.payload;
    const result = await ingest.ingestFromAgent({
      tabId: tab.value,
      events: batch,
      ...(armedCaptureId === undefined ? {} : { armedCaptureId }),
      ...(droppedCount === undefined ? {} : { droppedCount }),
    });
    if (isErr(result)) {
      // Only a refusal of the frame itself counts; a service fault (the store,
      // the session secret) is not the connection's doing.
      if (result.error.code === MALFORMED_FRAME_CODE) {
        noteMalformed(admissionKey, client.id, tab.value);
      }
      emitThrottled(
        'warn',
        throttleKey(LOG_CLASS.frameRefused, client.id, result.error.code),
        'telemetry ingest refused a relayed frame',
        {
          clientId: client.id,
          tabId: tab.value,
          errorCode: result.error.code,
          received: batch.length,
        },
      );
      return result;
    }

    // 6. A frame of which nothing was stored because every element was
    //    malformed counts against the connection too.
    if (result.value.persisted === 0 && result.value.invalid > 0) {
      noteMalformed(admissionKey, client.id, tab.value);
    }
    return result;
  }

  /** The `telemetry.event` frame handler — never throws, never rejects. */
  const handleTelemetryEventFrame: TelemetryEventFrameHandler = async (frame) => {
    try {
      return await serveFrame(frame);
    } catch {
      emitThrottled(
        'error',
        throttleKey(LOG_CLASS.frameHandlerFailed),
        'the telemetry frame handler failed unexpectedly',
        { errorCode: 'INTERNAL' },
      );
      return err(handlerFailure());
    }
  };

  return Object.freeze({
    handlers: Object.freeze({ [TELEMETRY_EVENT]: handleIngestRequest }),
    handleIngestRequest,
    handleTelemetryEventFrame,
  });
}
