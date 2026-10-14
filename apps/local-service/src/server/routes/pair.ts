/**
 * `POST /pair/start` and `POST /pair/complete` — how the Chrome extension, which
 * cannot read `$DEBUGGEN_HOME/auth.json`, obtains its DevTools credential
 * (AAP §0.5.6).
 *
 * ## The flow
 *
 * 1. The VS Code command `debuggen.pairChrome` calls `POST /pair/start` with the
 *    editor credential and shows the returned code in its `PairingCode` view.
 * 2. The developer types that code into the DevTools panel's `PairDialog`.
 * 3. The MV3 service worker calls `POST /pair/complete { code }` from its own
 *    `chrome-extension://<id>` origin and stores the returned credential in
 *    `chrome.storage.local`. The credential is scoped to that extension id, so
 *    it is refused from every other origin.
 *
 * ## Two authorization postures, deliberately asymmetric
 *
 * `pair.start` is the most privileged pairing call: it mints a capability, so it
 * requires the editor role (`OPERATION_ROLES['pair.start']` in `../auth.ts`),
 * checked against the principal the auth middleware resolved from the stored
 * credential — never against anything the request says about itself — and
 * checked before the body is even read, so a DevTools or server-agent caller
 * learns nothing about pairing state.
 *
 * That principal is a snapshot of a credential that existed when the request
 * arrived, and reading the body awaits the client for as long as it takes to
 * send it. A credential retired inside that gap — by a rotation, a revocation
 * or an expiry — must not mint a pairing code, so once the body is read the
 * handler asks {@link AuthService.requireLiveCredential} (the revocation
 * fence) whether it is still live, immediately before
 * {@link AuthService.startPairing} and with no `await` between the two. Both
 * are synchronous, and so is every retirement, so none can interleave. A
 * credential retired meanwhile is answered `401`; a fence that cannot give a
 * verdict — a store failure, or a throw — fails closed with a `500`, never a
 * pass.
 *
 * `pair.complete` is the least privileged call in the service and its only
 * state-changing unauthenticated operation (protocol's `AUTH_EXEMPT_OPERATIONS`):
 * the one-time code **is** the capability being presented. Exempt means "no
 * bearer credential", never "unprotected": the middleware still refuses every
 * `http:`/`https:` origin before this handler runs, and `../auth.ts` refuses any
 * origin that is not `chrome-extension://<id>`. The extension id the new
 * credential is scoped to is taken from that validated `Origin` header — never
 * from a body field.
 *
 * Both postures are pinned at compile time below: `'pair.start' satisfies
 * AuthenticatedOperation` and `'pair.complete' satisfies AuthExemptOperation`,
 * so a change to protocol's exemption table fails this file's build instead of
 * silently flipping either posture.
 *
 * ## What this module does not do
 *
 * `../auth.ts` owns the whole pairing mechanism: the eight-character CSPRNG code,
 * compared exactly as submitted (this file passes `code` through untouched —
 * no trimming, no case folding), the five-minute validity, the single-use rule,
 * hash-only storage in `pairing_codes`, the five-failure / sixty-second lockout
 * — one service-wide lockout, never keyed by the caller-controlled `Origin`, so
 * forged extension ids share it — and the issuance of the DevTools credential,
 * scoped to the redeeming extension's id, in the same transaction that marks
 * the code used. This file generates no code, counts no failure,
 * hashes nothing and reads no credential file; it is an authorization-correct,
 * leak-free HTTP shell over {@link AuthService.startPairing} and
 * {@link AuthService.completePairing}, with the revocation fence
 * ({@link AuthService.requireLiveCredential}) in front of the first. It
 * registers nothing either: it returns
 * its two handlers, keyed by operation id, for `../http.ts` to register from
 * protocol's route table behind the auth middleware.
 *
 * ## Uniform refusals
 *
 * `../auth.ts` tells a wrong code, an already-used code and an expired code
 * apart — which its own log needs. The response must not: a caller that could
 * tell "used" or "expired" from "wrong" would learn which guesses were once real
 * codes. {@link normalizePairingRefusal} therefore folds those three verdicts
 * into auth.ts's own `pairing-invalid` refusal (`401`, `PAIRING_INVALID`,
 * "The pairing code is not valid."), carrying auth.ts's vocabulary rather than
 * inventing a state. A lockout stays what auth.ts says it is — a `429`
 * rate-limit outcome — and reveals nothing about any code, because auth.ts
 * refuses during a lockout before it looks at the code at all.
 *
 * ## Secrets discipline
 *
 * The pairing code, the minted token and the read proof issued with it exist
 * in this module only on the way into exactly one response body. None is logged, persisted, re-read, placed
 * in a `DebuggenError` (message, hint or details) or included in any other
 * response. Every log record here carries constant text plus an operation id, an
 * error code or a status. Validation failures are rendered by protocol's
 * `parseHttpRequest`, whose messages come from `describeZodIssues` — issue paths
 * and codes, never a submitted value. Both success responses carry
 * `Cache-Control: no-store`, and no `Access-Control-Allow-Origin` header is ever
 * set: its absence is why a web page cannot read these responses, which together
 * with the bearer requirement on every other route closes CSRF.
 */

import type { Context, Handler } from 'hono';

import { parseHttpRequest, parseHttpResponse, toErrorPayload } from '@debuggen/protocol';
import type {
  AuthExemptOperation,
  HttpErrorResponse,
  HttpOperationId,
  HttpRequestBody,
} from '@debuggen/protocol';
import { DebuggenError, err, isErr, noopLogger, ok } from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';

import { subsystemLogger } from '../../logging.js';
import {
  AUTH_FAILURE_REASONS,
  OPERATION_ROLES,
  PAIRING_LOCKOUT_MS,
  authErrorResponse,
  authFailureReasonOf,
  requireRole,
} from '../auth.js';
import type {
  AuthFailureReason,
  AuthService,
  AuthenticatedOperation,
  Principal,
  ServerEnv,
} from '../auth.js';

/* -------------------------------------------------------------------------------------------------
 * The operations this module owns
 * ---------------------------------------------------------------------------------------------- */

/**
 * `POST /pair/start`. `satisfies AuthenticatedOperation` is the compile-time
 * proof that protocol still requires a bearer credential for it: if the route
 * table ever flagged it exempt, this line would stop compiling rather than the
 * handler below silently running without a principal.
 */
const PAIR_START = 'pair.start' satisfies AuthenticatedOperation;

/**
 * `POST /pair/complete`. `satisfies AuthExemptOperation` pins protocol's
 * exemption: the handler below never reads a principal, which is only correct
 * while the operation is one of `AUTH_EXEMPT_OPERATIONS`.
 */
const PAIR_COMPLETE = 'pair.complete' satisfies AuthExemptOperation;

/**
 * The protocol operations this module answers, in the route table's order.
 *
 * `../http.ts` builds an exhaustive `Record<HttpOperationId, handler>` from the
 * route modules; this tuple is this module's slice of that record, and the
 * `satisfies` clause keeps each member a genuine protocol operation id.
 */
export const PAIR_OPERATIONS = Object.freeze([
  PAIR_START,
  PAIR_COMPLETE,
] as const satisfies readonly HttpOperationId[]);

/** One of {@link PAIR_OPERATIONS}. */
export type PairOperation = (typeof PAIR_OPERATIONS)[number];

/* -------------------------------------------------------------------------------------------------
 * Policy constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The largest request body either pairing operation accepts, in bytes.
 *
 * A genuine `pair.complete` body is `{"code":"<eight characters>"}` and a
 * genuine `pair.start` body is `{}`; protocol bounds the code field at 512
 * characters. Four kibibytes is therefore far above anything an honest client
 * sends, while keeping the one state-changing unauthenticated route from being
 * made to buffer an arbitrarily large body. A body declared or found larger is
 * answered `413` without being parsed.
 */
export const MAX_PAIR_REQUEST_BODY_BYTES = 4096;

/**
 * The `auth.ts` refusal verdicts a `pair.complete` response must not tell apart:
 * a wrong code, an already-used code and an expired code (see the module
 * documentation). All three are answered as {@link UNIFORM_PAIRING_REFUSAL}.
 */
export const UNIFORM_PAIRING_REFUSAL_REASONS = Object.freeze([
  'pairing-invalid',
  'pairing-used',
  'pairing-expired',
] as const satisfies readonly AuthFailureReason[]);

/** The single `auth.ts` verdict the {@link UNIFORM_PAIRING_REFUSAL_REASONS} are answered with. */
const UNIFORM_PAIRING_REFUSAL = 'pairing-invalid' satisfies AuthFailureReason;

/**
 * The request header the auth middleware judged the origin policy on — the same
 * lower-case name `../auth.ts` reads, and the only source of the extension id a
 * redeemed credential is scoped to.
 */
const ORIGIN_HEADER = 'origin';

/** The request header a client declares its body length in. */
const CONTENT_LENGTH_HEADER = 'content-length';

/** The response header that keeps a code or credential out of every cache. */
const CACHE_CONTROL_HEADER = 'cache-control';

/** The {@link CACHE_CONTROL_HEADER} value on every pairing response. */
const NO_STORE = 'no-store';

/**
 * The response header a rate-limited client reads its wait from, in seconds
 * (RFC 9110 §10.2.3). Set on a lockout refusal only.
 */
const RETRY_AFTER_HEADER = 'retry-after';

/** The `../auth.ts` verdict of a redemption refused while pairing is locked. */
const PAIRING_LOCKED_REASON = 'pairing-locked' satisfies AuthFailureReason;

/**
 * The {@link RETRY_AFTER_HEADER} value of a lockout refusal: the whole lockout
 * in seconds, rounded up. The access boundary does not expose how much of the
 * lock is left, so this is its bound — an attempt inside the lock never waits
 * longer, and one made after waiting this long is judged afresh. The refusal's
 * message states the same bound in words, for the developer reading it.
 */
const PAIRING_RETRY_AFTER_SECONDS = String(Math.ceil(PAIRING_LOCKOUT_MS / 1000));

/** The log subsystem binding of this module's records. */
const LOG_SUBSYSTEM = 'server.pair';

/**
 * The fixed message of a `500` from `pair.start`: the access boundary failed
 * for a reason other than a refusal (a store failure, a failed random draw,
 * a revocation fence that could not give a verdict). The detail is in the
 * service log, which `../auth.ts` already wrote — or, for a fence that threw,
 * this module.
 */
const PAIRING_START_UNAVAILABLE_MESSAGE =
  'The Debug Generator local service could not issue a pairing code. Its log holds the reason.';

/** The fixed message of a `500` from `pair.complete`, for the same class of failure. */
const PAIRING_COMPLETE_UNAVAILABLE_MESSAGE =
  'The Debug Generator local service could not complete pairing. Its log holds the reason.';

/**
 * The fixed message of a `500` when a response this module built does not
 * satisfy protocol's response schema — a drift between the access boundary and
 * the route table, never something a client caused.
 */
const RESPONSE_DRIFT_MESSAGE =
  'The Debug Generator local service built a pairing response that does not match the protocol. Its log holds the reason.';

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/**
 * What {@link createPairRoutes} is built from: the narrowest slice of the
 * access boundary the two handlers call, and an optional logger.
 *
 * Declared here, next to the routes that need it, so `../http.ts` composes its
 * dependency aggregate from this interface rather than restating its fields.
 */
export interface PairRoutesDeps {
  /**
   * The access boundary's two pairing operations and its revocation fence.
   * Everything that makes pairing safe — code generation, expiry, single use,
   * lockout, hash-only storage and credential issuance — happens inside the
   * two pairing calls; `requireLiveCredential` refuses a `pair.start` whose
   * credential was retired while its body was read. The field name `auth`
   * matches the sibling route modules' slices of the same service, so
   * `../http.ts`'s aggregate asks for one object that satisfies them all.
   */
  readonly auth: Pick<AuthService, 'startPairing' | 'completePairing' | 'requireLiveCredential'>;

  /**
   * Where this module's diagnostics go; defaults to the no-op logger. Records
   * carry constant text and codes only — never a pairing code or a token.
   */
  readonly logger?: Logger | undefined;
}

/**
 * A pairing route handler, typed on the service's hono environment so
 * `c.get('principal')` is the principal `../auth.ts`'s middleware resolved.
 */
export type PairRouteHandler = Handler<ServerEnv>;

/**
 * The handlers {@link createPairRoutes} returns, keyed by protocol operation id
 * so `../http.ts` can place them in its exhaustive handler record unchanged.
 */
export type PairRouteHandlers = Readonly<Record<PairOperation, PairRouteHandler>>;

/* -------------------------------------------------------------------------------------------------
 * Refusal vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the refusal `../auth.ts` raises for `reason`, from its own table: the
 * table's code and constant message, `details.reason` naming the entry (which is
 * what `authErrorResponse` maps back to a status) and the table's hint when it
 * has one. No presented value can reach it.
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

/** Whether a verdict is one of the {@link UNIFORM_PAIRING_REFUSAL_REASONS}. */
function isUniformPairingReason(reason: AuthFailureReason): boolean {
  return (UNIFORM_PAIRING_REFUSAL_REASONS as readonly AuthFailureReason[]).includes(reason);
}

/**
 * Folds the pairing verdicts a response must not distinguish into one.
 *
 * A wrong, already-used or expired code becomes `../auth.ts`'s own
 * `pairing-invalid` refusal — `401`, `PAIRING_INVALID`, "The pairing code is not
 * valid." — so the three cannot be told apart by status, code, message or
 * payload shape. Every other error is returned unchanged: a lockout stays a
 * `429` rate-limit outcome, an origin refusal stays a `403`, and a failure that
 * is not a refusal stays one, so `authErrorResponse` still answers it with a
 * fixed `500`.
 *
 * @param error An error returned by {@link AuthService.completePairing}.
 * @returns The error the response is built from.
 */
export function normalizePairingRefusal(error: DebuggenError): DebuggenError {
  const reason = authFailureReasonOf(error);
  return reason !== undefined && isUniformPairingReason(reason)
    ? refusalFor(UNIFORM_PAIRING_REFUSAL)
    : error;
}

/* -------------------------------------------------------------------------------------------------
 * Request bodies
 * ---------------------------------------------------------------------------------------------- */

/** Why a request body was refused before it reached the access boundary. */
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
 * crosses {@link MAX_PAIR_REQUEST_BODY_BYTES} while it is read, or does not
 * arrive within the time ceiling. Stated here because a route module never
 * imports `../http.ts` (which imports it); they must equal that module's
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

/** The refusal of a body larger than {@link MAX_PAIR_REQUEST_BODY_BYTES}. */
function bodyTooLarge(operation: PairOperation): BodyRejection {
  return {
    status: 413,
    error: new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The ${operation} request body is larger than this operation accepts.`,
      {
        hint: `Send a JSON body of at most ${String(MAX_PAIR_REQUEST_BODY_BYTES)} bytes.`,
        details: { operation, maxBytes: MAX_PAIR_REQUEST_BODY_BYTES },
      },
    ),
  };
}

/** The refusal of a body that did not arrive within `../http.ts`'s time ceiling. */
function bodyReadTimedOut(operation: PairOperation): BodyRejection {
  return {
    status: 408,
    error: new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The ${operation} request body did not arrive in time.`,
      {
        hint: 'Send the whole JSON body at once, then wait for the reply.',
        details: { operation, problem: GUARD_BODY_READ_TIMEOUT_REASON },
      },
    ),
  };
}

/** The refusal of a body that is unreadable or not JSON; the body itself is never quoted. */
function bodyNotJson(operation: PairOperation, problem: 'unreadable' | 'not-json'): BodyRejection {
  const message =
    problem === 'unreadable'
      ? `The ${operation} request body could not be read.`
      : `The ${operation} request body is not valid JSON.`;
  return {
    status: 400,
    error: new DebuggenError('PROTOCOL_INVALID_MESSAGE', message, {
      hint: 'Send a JSON object as the request body.',
      details: { operation, problem },
    }),
  };
}

/**
 * Reads a request body as JSON, bounded by {@link MAX_PAIR_REQUEST_BODY_BYTES}.
 *
 * A declared `Content-Length` above the bound is refused before anything is
 * read. A body that declares no length (a chunked upload to this
 * unauthenticated route) is bounded while it is read: `../http.ts`'s
 * request-body guard errors the stream at the same bound — and at its time
 * ceiling — so `c.req.text()` rejects with the guard's refusal instead of
 * buffering an unbounded body, and that rejection is answered `413` or `408`
 * here. The text read is measured once more, which keeps the bound for a
 * handler composed without the guard. The text is read through hono's cached
 * accessor, so a body a middleware already consumed is still available here.
 * An empty body reads as `undefined`, which protocol's request schema then
 * refuses for both operations. `JSON.parse`'s own error is discarded, because
 * Node's message for it quotes the offending input.
 *
 * @param c The request context.
 * @param operation The operation the body belongs to, for the refusal message.
 * @returns The parsed value, or the refusal.
 */
async function readJsonBody(
  c: Context<ServerEnv>,
  operation: PairOperation,
): Promise<Result<unknown, BodyRejection>> {
  const declared = c.req.header(CONTENT_LENGTH_HEADER);
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_PAIR_REQUEST_BODY_BYTES) {
      return err(bodyTooLarge(operation));
    }
  }

  let text: string;
  try {
    text = await c.req.text();
  } catch (caught) {
    const refusal = guardRefusalOf(caught);
    if (refusal === GUARD_BODY_TOO_LARGE_REASON) {
      return err(bodyTooLarge(operation));
    }
    if (refusal === GUARD_BODY_READ_TIMEOUT_REASON) {
      return err(bodyReadTimedOut(operation));
    }
    return err(bodyNotJson(operation, 'unreadable'));
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_PAIR_REQUEST_BODY_BYTES) {
    return err(bodyTooLarge(operation));
  }
  if (text.trim().length === 0) {
    return ok(undefined);
  }

  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch {
    return err(bodyNotJson(operation, 'not-json'));
  }
}

/**
 * Reads and validates an operation's request body against protocol's route
 * table, through the same `parseHttpRequest` the client SDK validates its
 * outbound body with — so the service accepts exactly what a client can send.
 *
 * @typeParam O The operation.
 * @param c The request context.
 * @param operation The operation whose declared request schema applies.
 * @returns The validated body, or the refusal (`400`/`413`).
 */
async function readRequest<O extends PairOperation>(
  c: Context<ServerEnv>,
  operation: O,
): Promise<Result<HttpRequestBody<O>, BodyRejection>> {
  const raw = await readJsonBody(c, operation);
  if (isErr(raw)) {
    return raw;
  }
  const parsed = parseHttpRequest(operation, raw.value);
  if (isErr(parsed)) {
    return err({ status: 400, error: parsed.error });
  }
  return ok(parsed.value);
}

/* -------------------------------------------------------------------------------------------------
 * Responses
 * ---------------------------------------------------------------------------------------------- */

/** Answers a refused body with protocol's error payload at the rejection's status. */
function answerBodyRejection(c: Context<ServerEnv>, rejection: BodyRejection): Response {
  const body: HttpErrorResponse = toErrorPayload(rejection.error);
  return c.json(body, rejection.status);
}

/**
 * Answers an error from the access boundary.
 *
 * A refusal is rendered by `../auth.ts`'s own `authErrorResponse` — its payload
 * at the status its reason table fixes (401, 403 or 429). A failure that is not
 * a refusal is answered `500` with this operation's fixed message and the
 * error's code, so a store or random-source failure never reaches a response
 * body in its own words.
 *
 * @param c The request context.
 * @param error The error the access boundary returned (already normalised).
 * @param unavailableMessage The fixed message for a non-refusal failure.
 * @returns The error response.
 */
function answerAccessBoundaryError(
  c: Context<ServerEnv>,
  error: DebuggenError,
  unavailableMessage: string,
): Response {
  if (authFailureReasonOf(error) === undefined) {
    const body: HttpErrorResponse = { code: error.code, message: unavailableMessage };
    return c.json(body, 500);
  }
  const { status, body } = authErrorResponse(error);
  return c.json(body, status);
}

/** Answers a response-schema drift with a fixed `INTERNAL` payload. */
function answerResponseDrift(c: Context<ServerEnv>): Response {
  const body: HttpErrorResponse = toErrorPayload(
    new DebuggenError('INTERNAL', RESPONSE_DRIFT_MESSAGE),
  );
  return c.json(body, 500);
}

/* -------------------------------------------------------------------------------------------------
 * The routes
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the `pair.start` and `pair.complete` handlers.
 *
 * Registers nothing, opens nothing and holds no state beyond its dependencies:
 * `../http.ts` registers each handler from protocol's route table
 * (`HTTP_ROUTES[operation].method` / `.pattern`) behind the auth middleware,
 * which has already refused web origins for both, resolved the principal for
 * `pair.start`, and skipped only the bearer check for `pair.complete`.
 *
 * Status codes, all with protocol's `httpErrorResponseSchema` body on failure:
 *
 * | Outcome | `pair.start` | `pair.complete` |
 * | --- | --- | --- |
 * | success | `200 { code, expiresAt }` | `200 { token, readProof }` |
 * | no resolved principal | `401` (`missing-credential`) | — |
 * | not the editor role | `403` (`role-not-permitted`) | — |
 * | oversized body, declared or as it arrives | `413` | `413` |
 * | body not arrived within `../http.ts`'s time ceiling | `408` | `408` |
 * | unreadable / non-JSON / off-schema body | `400` | `400` |
 * | credential retired or expired while the body was read | `401` (`unknown-credential` / `expired-credential` / `corrupt-credential`) | — |
 * | origin not `chrome-extension://<id>` | — | `403` (auth.ts's verdict) |
 * | wrong, used or expired code | — | `401` uniform `PAIRING_INVALID` |
 * | lockout | — | `429` `RATE_LIMITED`, `Retry-After` the lockout's seconds |
 * | store / random-source / revocation-fence / drift failure | `500` fixed message | `500` fixed message |
 *
 * @param deps The access boundary's pairing operations and revocation fence,
 * and an optional logger.
 * @returns The two handlers, keyed by operation id.
 *
 * @example
 * ```ts
 * const pair = createPairRoutes({ auth, logger });
 * const authFor = createAuthMiddleware(auth);
 * for (const operation of PAIR_OPERATIONS) {
 *   const { method, pattern } = HTTP_ROUTES[operation];
 *   app.on(method, pattern, authFor(operation), pair[operation]);
 * }
 * ```
 */
export function createPairRoutes(deps: PairRoutesDeps): PairRouteHandlers {
  const { auth } = deps;
  const logger = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);

  /**
   * The revocation fence: whether the credential that authorized a
   * `pair.start` is still live. `requireLiveCredential` reports every failure
   * as a `Result` and logs its own refusals and store failures; a throw is a
   * defect below and fails closed — it is logged here by operation and code
   * and answered as the access boundary's `500`, never as a pass. The thrown
   * value is kept as the cause for a debugger, never logged or answered.
   */
  const requireLive = (principal: Principal): Result<void, DebuggenError> => {
    try {
      return auth.requireLiveCredential(principal);
    } catch (caught) {
      logger.error('the revocation fence threw while a pairing request was checked', {
        operation: PAIR_START,
        errorCode: 'INTERNAL',
      });
      return err(
        new DebuggenError(
          'INTERNAL',
          'The credential that authorized this pairing request could not be confirmed.',
          { details: { reason: 'credential-check-threw' }, cause: caught },
        ),
      );
    }
  };

  /**
   * `POST /pair/start` — editor credential required.
   *
   * Order is the security property: the principal and its role are checked
   * before the body is read, so a caller without the editor role is refused
   * without learning anything about pairing; only then is the (empty) body
   * validated, the credential's liveness confirmed — it may have been retired
   * while the body was awaited — and a code minted.
   */
  const startPairing: PairRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);

    // The middleware sets `principal` for every non-exempt operation. Its
    // absence means the handler was registered without it — a composition
    // defect — and the request is treated as unauthenticated, never as trusted.
    const principal: Principal | undefined = c.get('principal');
    if (principal === undefined) {
      logger.error('pair.start reached its handler without a resolved principal', {
        operation: PAIR_START,
      });
      const { status, body } = authErrorResponse(refusalFor('missing-credential'));
      return c.json(body, status);
    }

    const permitted = requireRole(principal, ...OPERATION_ROLES[PAIR_START]);
    if (isErr(permitted)) {
      const { status, body } = authErrorResponse(permitted.error);
      return c.json(body, status);
    }

    const request = await readRequest(c, PAIR_START);
    if (isErr(request)) {
      logger.debug('refused a pairing request body', {
        operation: PAIR_START,
        status: request.error.status,
        errorCode: request.error.error.code,
      });
      return answerBodyRejection(c, request.error);
    }

    // The body was awaited; the credential that authorized the request may
    // have been retired meanwhile. Nothing awaits between this check and the
    // minting, and both are synchronous. A refusal is answered `401` by
    // auth.ts's table; any other failure is a fixed `500`.
    const live = requireLive(principal);
    if (isErr(live)) {
      return answerAccessBoundaryError(c, live.error, PAIRING_START_UNAVAILABLE_MESSAGE);
    }

    const issued = auth.startPairing();
    if (isErr(issued)) {
      return answerAccessBoundaryError(c, issued.error, PAIRING_START_UNAVAILABLE_MESSAGE);
    }

    // The code travels from here into the response body and nowhere else.
    const response = parseHttpResponse(PAIR_START, {
      code: issued.value.code,
      expiresAt: issued.value.expiresAt,
    });
    if (isErr(response)) {
      logger.error('a pairing response did not satisfy its protocol schema', {
        operation: PAIR_START,
        errorCode: response.error.code,
      });
      return answerResponseDrift(c);
    }
    return c.json(response.value, 200);
  };

  /**
   * `POST /pair/complete` — unauthenticated; the code is the capability.
   *
   * The handler never reads a principal. The body is validated against
   * protocol's schema, then the code and the request's own `Origin` header go
   * to the access boundary, which refuses a non-extension origin, applies the
   * lockout, checks the code, and issues a DevTools credential scoped to the
   * extension id in that origin, with the read proof its reads carry. Its refusals are folded by
   * {@link normalizePairingRefusal} before they are answered.
   */
  const completePairing: PairRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);

    const request = await readRequest(c, PAIR_COMPLETE);
    if (isErr(request)) {
      logger.debug('refused a pairing request body', {
        operation: PAIR_COMPLETE,
        status: request.error.status,
        errorCode: request.error.error.code,
      });
      return answerBodyRejection(c, request.error);
    }

    const redeemed = auth.completePairing({
      code: request.value.code,
      origin: c.req.header(ORIGIN_HEADER),
    });
    if (isErr(redeemed)) {
      const refusal = normalizePairingRefusal(redeemed.error);
      // A lockout tells the client how long to wait, as HTTP says a 429 may;
      // every other refusal is final for the code presented, so it gets none.
      if (authFailureReasonOf(refusal) === PAIRING_LOCKED_REASON) {
        c.header(RETRY_AFTER_HEADER, PAIRING_RETRY_AFTER_SECONDS);
      }
      return answerAccessBoundaryError(c, refusal, PAIRING_COMPLETE_UNAVAILABLE_MESSAGE);
    }

    // The token and the read proof issued with it travel from here into the
    // response body and nowhere else: this is the only moment the service ever
    // holds the proof in plaintext. If the drift branch below were ever taken,
    // the credential just issued would reach no client and stay unusable until
    // the next rotation removes it.
    const response = parseHttpResponse(PAIR_COMPLETE, {
      token: redeemed.value.token,
      readProof: redeemed.value.readProof,
    });
    if (isErr(response)) {
      logger.error('a pairing response did not satisfy its protocol schema', {
        operation: PAIR_COMPLETE,
        errorCode: response.error.code,
      });
      return answerResponseDrift(c);
    }
    return c.json(response.value, 200);
  };

  return Object.freeze({
    [PAIR_START]: startPairing,
    [PAIR_COMPLETE]: completePairing,
  });
}
