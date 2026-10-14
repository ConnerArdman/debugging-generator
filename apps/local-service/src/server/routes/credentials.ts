/**
 * `POST /credentials/rotate` and `POST /credentials/release` — the revocation
 * half of the service's access boundary. The rotation is what
 * the VS Code command `debuggen.rotateServiceToken` calls; the release is how
 * `scripts/dev-instrumented.mjs` revokes the server-agent credential it
 * requested through `POST /dev-server/credential` as the dev server it started
 * exits (see "The release" below).
 *
 * ## What one rotation does
 *
 * The handler authorizes the caller and hands the whole rotation to
 * `../auth.ts`'s {@link AuthService.rotateAll}, which:
 *
 * 1. stages a new editor credential in the `auth.json.pending` journal (`0600`);
 * 2. in one store transaction deletes every row of `credentials` — the editor
 *    credential that authorized this very request, every paired DevTools
 *    extension's credential and every launched dev server's `server-agent`
 *    credential — and every outstanding pairing code, and inserts the new
 *    editor credential;
 * 3. publishes the new credential to `$DEBUGGEN_HOME/auth.json` and removes
 *    the journal;
 * 4. closes every open WebSocket with `WS_CLOSE_UNAUTHORIZED` (4401).
 *
 * Once the store transaction has committed — whether or not the rest then
 * finished — the handler tells the dev-server launcher
 * ({@link DevServerLauncher.credentialsRotated}), which marks every launched
 * child's credential lapsed.
 *
 * Paired Chrome extensions must pair again, and launched dev servers must be
 * relaunched to receive a fresh credential: the project's next
 * `POST /dev-server/launch` stops the child whose credential is gone and
 * launches a replacement with a new one. No credential travels in the
 * response: the new editor credential exists only in the `0600` file, and the
 * reply carries the two counts protocol's `credentialsRotateResponseSchema`
 * declares.
 *
 * ## Why the caller still receives its answer
 *
 * The reply is sent *after* every socket — the caller's own editor WebSocket
 * included — was closed with 4401, and after the caller's own credential was
 * deleted. It still reaches the caller: this HTTP response travels on the HTTP
 * connection that carried the request, which a socket revocation does not
 * touch, and the request was authorized before the rotation ran. It is the
 * last response the old credential earns. The editor client re-reads
 * `auth.json` when its socket is closed with 4401 or a request is refused
 * `UNAUTHORIZED`, then reconnects and retries with the new credential.
 *
 * A request authorized by a credential that was retired *while the request's
 * body was still being read* — by another rotation, whichever path ran it, or
 * by an expiry — is refused `401` rather than rotating again on the authority
 * of a credential that no longer exists. The handler asks
 * {@link AuthService.requireLiveCredential} after the body is read and
 * immediately before `rotateAll`, with no `await` between the two; both are
 * synchronous, so no retirement can interleave (see
 * {@link createCredentialsRoutes}).
 *
 * ## The release
 *
 * `POST /credentials/release { token }` revokes one credential `POST
 * /dev-server/credential` minted, named by the token its holder already has.
 * Without it the credential would keep authenticating until the launcher's
 * supervision noticed the dev server was gone — the disconnect grace after its
 * preload's control connection dropped, or the end of its first lease when no
 * preload ever connected. The handler delegates to
 * {@link DevServerLauncher.releaseCredential}, which ends that supervision and
 * revokes the credential through `../auth.ts`, closing its sockets with
 * `WS_CLOSE_UNAUTHORIZED` (4401):
 *
 * - `{ released: true }` — this request found a live credential of that kind
 *   under the token and removed it;
 * - `{ released: false }` — this request released nothing: no such credential
 *   was live under the token for it to remove (already revoked by
 *   supervision, lapsed, rotated away — even while the launcher still
 *   supervised it — or never issued), or it is a launched child's own
 *   credential, which only that child's exit or stop revokes and which stays
 *   live. `false` reports what the request did, so it is not proof that the
 *   token no longer authenticates. Every case answers the same, so the reply
 *   is no oracle for which credentials exist.
 *
 * The same fence guards it: the handler checks `requireLiveCredential` after
 * the body is read and calls the launcher with nothing awaited in between, and
 * the launcher reaches the store synchronously, so a rotation cannot slip
 * between the check and the revocation.
 *
 * ## Authorization, validation, delegation
 *
 * In a fixed order, so a caller that fails an early step learns nothing about
 * a later one:
 *
 * 1. the principal `../auth.ts`'s middleware resolved must hold a role
 *    `OPERATION_ROLES` grants the operation — the editor (`vscode`) only, for
 *    both. A DevTools or server-agent credential can never revoke anything,
 *    not even a server agent its own credential;
 * 2. the body is bounded ({@link MAX_CREDENTIALS_REQUEST_BODY_BYTES}) — as
 *    declared, and while it is read, by `../http.ts`'s request-body guard,
 *    which also bounds how long it may take to arrive — and must be protocol's
 *    strict body through `parseHttpRequest`: `{}` for the rotation, so no field
 *    can name a credential to spare, and exactly `{ token }` for the release,
 *    so no field can widen it past one credential;
 * 3. the credential that authorized the request must still be live
 *    (`requireLiveCredential`, the revocation fence);
 * 4. `rotateAll`, or the launcher's `releaseCredential`, runs;
 * 5. its outcome is checked against the operation's response schema through
 *    `parseHttpResponse` and sent.
 *
 * ## Failures (AAP §0.5.5)
 *
 * | Outcome | Status | Body |
 * | --- | --- | --- |
 * | rotation succeeded | `200` | `{ credentialsDeleted, socketsClosed }` |
 * | release answered | `200` | `{ released }` |
 * | no resolved principal / credential retired or expired while the body was read | `401` | `UNAUTHORIZED` |
 * | not the editor role | `403` | `UNAUTHORIZED` (`role-not-permitted`) |
 * | body larger than the bound, declared or as it arrives | `413` | `PROTOCOL_INVALID_MESSAGE` |
 * | body that did not arrive within `../http.ts`'s time ceiling | `408` | `PROTOCOL_INVALID_MESSAGE` |
 * | unreadable, non-JSON or off-schema body | `400` | `PROTOCOL_INVALID_MESSAGE` |
 * | the rotation failed, or finished only in part | `500` | the failure's code, what happened, and a `ref` |
 * | the release's revocation is still pending (retried; the credential lapses by the end of its lease at the latest) | `500` | `CLEANUP_PARTIAL`, a fixed message and a `ref` |
 * | the release failed in any other way | `500` | the failure's code, a fixed message and a `ref` |
 *
 * A failed rotation is the one `500` of this service whose message is the
 * failure's own words, deliberately: the developer must be told whether the
 * rotation happened. `rotateAll` records that in `details.rotated` and says it
 * in a constant sentence — "Credentials were not rotated; every existing
 * credential is still valid." before its store transaction committed,
 * "Credentials were rotated, but …" after — followed by its recovery hint
 * (restart the service, or make `$DEBUGGEN_HOME` private and rotate again),
 * which this module appends because protocol's error body has no `hint`
 * field. Only an error that states its outcome that way is forwarded in its
 * own words; anything else — including a `rotateAll` that threw — is answered
 * with this module's fixed sentence that the outcome is unknown. No token is
 * ever in either: `rotateAll`'s messages and hints carry none, and the hint of
 * a filesystem refusal names at most a path under `$DEBUGGEN_HOME`, the
 * editor's own state directory. A failed release is always answered in this
 * module's own fixed words. Every `500` carries a `ref` that ties it to this
 * module's log record.
 *
 * ## Secrets discipline
 *
 * The rotation passes no credential through this module: the new editor
 * credential is written to `auth.json` by `../auth.ts` and never returned. The
 * release receives one in its body, and hands it to the launcher and nothing
 * else: it is never logged, echoed or put in an error — an off-schema release
 * body is refused in a fixed sentence rather than protocol's issue
 * description, which names unrecognised keys and so could quote a token sent
 * as one. Log records carry constant text, the operation id, a status, an
 * error code, the rotation state, the counts, the release flag and a `ref` —
 * never a header, a body or a message. Every response carries
 * `Cache-Control: no-store`, and no `Access-Control-Allow-Origin` header is
 * ever set.
 *
 * ## What this module does not do
 *
 * It registers nothing, holds no credential, reads no file and closes no
 * socket itself: it returns its handlers keyed by operation id for
 * `../http.ts` to register from protocol's route table behind the auth
 * middleware; `../auth.ts` owns the whole rotation, and the dev-server
 * launcher owns finding and revoking a released credential.
 *
 * @module
 */

import type { Context, Handler } from 'hono';

import {
  httpErrorResponseSchema,
  parseHttpRequest,
  parseHttpResponse,
  toErrorPayload,
} from '@debuggen/protocol';
import type {
  CredentialsReleaseRequest,
  CredentialsReleaseResponse,
  HttpErrorResponse,
  HttpRequestBody,
} from '@debuggen/protocol';
import { DebuggenError, err, isErr, newMessageId, noopLogger, ok } from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';

import type { DevServerLauncher } from '../../dev-server/launcher.js';
import { subsystemLogger } from '../../logging.js';
import {
  AUTH_FAILURE_REASONS,
  OPERATION_ROLES,
  authErrorResponse,
  authFailureStatus,
  requireRole,
} from '../auth.js';
import type {
  AuthFailureReason,
  AuthService,
  AuthenticatedOperation,
  Principal,
  RotationOutcome,
  ServerEnv,
} from '../auth.js';

/* -------------------------------------------------------------------------------------------------
 * The operations this module owns
 * ---------------------------------------------------------------------------------------------- */

/**
 * `POST /credentials/rotate`. `satisfies AuthenticatedOperation` is the
 * compile-time proof that protocol still requires a bearer credential for it:
 * were the route table ever to flag it exempt, this line would stop compiling
 * rather than the handler running without a principal.
 */
const ROTATE = 'credentials.rotate' satisfies AuthenticatedOperation;

/**
 * `POST /credentials/release`. The same `satisfies` proof as {@link ROTATE}:
 * the release names a credential, so it must never run without a principal.
 */
const RELEASE = 'credentials.release' satisfies AuthenticatedOperation;

/**
 * The protocol operations this module answers, in the route table's order.
 *
 * `../http.ts` builds an exhaustive `Record<HttpOperationId, handler>` from the
 * route modules; this tuple is this module's slice of it, and the `satisfies`
 * clause keeps each member a genuine, authenticated protocol operation id.
 */
export const CREDENTIALS_OPERATIONS = Object.freeze([
  ROTATE,
  RELEASE,
] as const satisfies readonly AuthenticatedOperation[]);

/** One of {@link CREDENTIALS_OPERATIONS}. */
export type CredentialsOperation = (typeof CREDENTIALS_OPERATIONS)[number];

/* -------------------------------------------------------------------------------------------------
 * Policy constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The largest request body accepted, in bytes, by either operation. The only
 * valid rotation body is `{}`, two bytes. A release body carries one token:
 * every credential the service mints is 43 base64url characters, which JSON
 * never escapes, so a real release body is some 55 bytes, and even protocol's
 * longest opaque token (512 such characters) fits at some 525. The bound
 * leaves room for whitespace and refuses anything plainly larger without
 * reading it. A body declared or found larger is answered `413` without being
 * parsed.
 */
export const MAX_CREDENTIALS_REQUEST_BODY_BYTES = 1024;

/** The request header a client declares its body length in. */
const CONTENT_LENGTH_HEADER = 'content-length';

/** The response header that keeps every answer of this module out of every cache. */
const CACHE_CONTROL_HEADER = 'cache-control';

/** The {@link CACHE_CONTROL_HEADER} value on every response. */
const NO_STORE = 'no-store';

/** The log subsystem binding of this module's records. */
const LOG_SUBSYSTEM = 'server.credentials';

/**
 * The `details` key `rotateAll` records its outcome under: `false` when the
 * store transaction never committed, `true` when it did.
 */
const ROTATED_DETAIL_KEY = 'rotated';

/** The status of every failure that is the service's own. */
const SERVER_FAILURE_STATUS = 500;

/**
 * The fixed message of a failed rotation whose outcome is not stated — a
 * `rotateAll` that threw, or an error that carries no `details.rotated`.
 */
const ROTATION_OUTCOME_UNKNOWN_MESSAGE =
  'Debug Generator could not confirm whether the service credentials were rotated. Restart the Debug Generator service, read auth.json again and rotate once more; the service log holds the reason under this ref.';

/**
 * The fixed message of a failed rotation that did not commit, used when
 * `rotateAll`'s own sentence and hint do not fit protocol's error body.
 */
const ROTATION_NOT_APPLIED_MESSAGE =
  'Credentials were not rotated; every existing credential is still valid. The service log holds the reason under this ref.';

/**
 * The fixed message of a rotation that committed but did not finish, used when
 * `rotateAll`'s own sentence and hint do not fit protocol's error body.
 */
const ROTATION_INCOMPLETE_MESSAGE =
  'Credentials were rotated, but the rotation did not finish. Restart the Debug Generator service to complete it; the service log holds the reason under this ref.';

/**
 * The fixed message of a rotation that succeeded but whose reply did not
 * satisfy protocol's schema — a drift between the access boundary and the
 * route table. It says the rotation happened, because it did.
 */
const RESPONSE_DRIFT_MESSAGE =
  'Credentials were rotated, but the Debug Generator local service built a reply that does not match the protocol. Read auth.json again before the next request; the service log holds the reason under this ref.';

/**
 * The fixed message of a release whose revocation is still pending — the
 * launcher's `CLEANUP_PARTIAL`. The launcher keeps retrying it on its own
 * schedule, and the credential's lease bounds how long it can outlive the
 * failure, so the caller has nothing to do but may release it again.
 */
const RELEASE_PENDING_MESSAGE =
  'The server-agent credential could not be revoked yet. Debug Generator keeps retrying the revocation, and the credential stops working on its own by the end of its lease at the latest; the service log holds the reason under this ref.';

/**
 * The fixed message of every other failed release: a store failure, a
 * launcher that threw, or an error this module does not describe. The
 * launcher's own words are never forwarded: this module promises the release
 * reply carries nothing but constant text.
 */
const RELEASE_FAILED_MESSAGE =
  'The server-agent credential could not be released. Release it again, or restart the Debug Generator service; it stops working on its own by the end of its lease at the latest, and the service log holds the reason under this ref.';

/**
 * The fixed message of a release whose reply did not satisfy protocol's
 * schema — a drift between the launcher and the route table. Whether the
 * credential was revoked is then unknown; releasing it again is harmless.
 */
const RELEASE_RESPONSE_DRIFT_MESSAGE =
  'The Debug Generator local service built a credential release reply that does not match the protocol, so whether the credential was released is unknown. Release it again; the service log holds the reason under this ref.';

/**
 * The fixed message of a release body that is JSON but not protocol's strict
 * `{ token }`. Protocol's own issue description is withheld for this operation
 * because it renders the name of an unrecognised key, and a base64url token
 * sent as a key name is a valid field name it would echo.
 */
const RELEASE_BODY_OFF_SCHEMA_MESSAGE = `The ${RELEASE} request body must be a JSON object with exactly one string field, token.`;

/**
 * What each operation's body must be, in the words every body refusal's hint
 * uses. The rotation's reads exactly as it always has.
 */
const BODY_SHAPES: Readonly<Record<CredentialsOperation, string>> = Object.freeze({
  [ROTATE]: 'the empty JSON object {}',
  [RELEASE]: 'the JSON object {"token": "<the credential POST /dev-server/credential returned>"}',
});

/**
 * How each operation is named in this module's log records and in the
 * fail-closed message of a revocation fence that threw.
 */
const ACTION_LABELS: Readonly<Record<CredentialsOperation, string>> = Object.freeze({
  [ROTATE]: 'rotation',
  [RELEASE]: 'release',
});

/**
 * The shape a `details.reason` must have to be logged: a short kebab-case
 * word list, which is how the launcher and the access boundary name their
 * failures. Anything else is left out of the record.
 */
const LOGGABLE_REASON = /^[a-z][a-z0-9-]{0,63}$/u;

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/**
 * What {@link createCredentialsRoutes} is built from: the two operations of
 * the access boundary the handlers call, the launcher's release, and an
 * optional logger.
 *
 * Declared here, next to the route that needs it, so `../http.ts` composes its
 * dependency aggregate from this interface rather than restating its fields.
 * The field names `auth` and `launcher` match the sibling modules' slices of
 * the same services, so the aggregate asks for one object of each that
 * satisfies them all.
 */
export interface CredentialsRoutesDeps {
  /**
   * The access boundary's revocation fence and its rotation. Staging, the
   * store transaction, the publication of `auth.json`, the journal and the
   * socket revocation all happen inside `rotateAll`; `requireLiveCredential`
   * refuses a request whose credential was retired while its body was read.
   */
  readonly auth: Pick<AuthService, 'rotateAll' | 'requireLiveCredential'>;

  /**
   * The dev-server launcher, which supervises every credential
   * `POST /dev-server/credential` minted and so is what ends that supervision
   * and revokes one on its holder's release. It must reach the store
   * synchronously — before its first `await` — which is what keeps the
   * revocation fence the handler checks just before it meaningful.
   *
   * Told, through its optional `credentialsRotated`, as soon as a rotation
   * has committed, so every dev server it launched is replaced on its
   * project's next launch rather than reused with a credential that no longer
   * exists (AAP §0.5.6).
   *
   * Read only when a request is answered, never while the handlers are built.
   */
  readonly launcher: Pick<DevServerLauncher, 'releaseCredential' | 'credentialsRotated'>;

  /**
   * Where this module's diagnostics go; defaults to the no-op logger. Records
   * carry constant text, the operation, statuses, codes, counts and refs only.
   */
  readonly logger?: Logger | undefined;
}

/**
 * A credentials route handler, typed on the service's hono environment so
 * `c.get('principal')` is the principal `../auth.ts`'s middleware resolved.
 */
export type CredentialsRouteHandler = Handler<ServerEnv>;

/**
 * The handlers {@link createCredentialsRoutes} returns, keyed by protocol
 * operation id so `../http.ts` can place them in its exhaustive handler record
 * unchanged.
 */
export type CredentialsRouteHandlers = Readonly<
  Record<CredentialsOperation, CredentialsRouteHandler>
>;

/* -------------------------------------------------------------------------------------------------
 * Refusals and failures
 * ---------------------------------------------------------------------------------------------- */

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

/**
 * What a failed rotation says about itself: `true` when its store transaction
 * committed (every old credential is already refused), `false` when it did not
 * (every old credential is still valid), `undefined` when the error does not
 * say — which is then treated as unknown, never as either.
 *
 * @param error The failure.
 * @returns The stated rotation state.
 */
function rotationStateOf(error: DebuggenError): boolean | undefined {
  const rotated = error.details?.[ROTATED_DETAIL_KEY];
  return typeof rotated === 'boolean' ? rotated : undefined;
}

/**
 * The error body of a failed rotation, answered `500` with `ref`.
 *
 * The protocol payload has no `hint` field, so the recovery instruction
 * travels inside the message. The candidates, each checked against protocol's
 * own `httpErrorResponseSchema` so no bound is restated here: the error's
 * sentence followed by its hint, then the sentence alone, then this module's
 * fixed sentence for the stated outcome. An error that does not state its
 * outcome is never answered in its own words.
 *
 * @param error The failure `rotateAll` returned.
 * @param ref The correlation reference of the log record written for it.
 * @returns A schema-valid error body.
 */
function rotationFailureBody(error: DebuggenError, ref: string): HttpErrorResponse {
  const rotated = rotationStateOf(error);
  if (rotated === undefined) {
    return { code: error.code, message: ROTATION_OUTCOME_UNKNOWN_MESSAGE, ref };
  }

  const hint = error.hint?.trim();
  const candidates: readonly string[] =
    hint === undefined || hint.length === 0
      ? [error.message]
      : [`${error.message} ${hint}`, error.message];
  for (const message of candidates) {
    const body: HttpErrorResponse = { code: error.code, message, ref };
    if (httpErrorResponseSchema.safeParse(body).success) {
      return body;
    }
  }
  return {
    code: error.code,
    message: rotated ? ROTATION_INCOMPLETE_MESSAGE : ROTATION_NOT_APPLIED_MESSAGE,
    ref,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Request bodies
 * ---------------------------------------------------------------------------------------------- */

/** Why a request body was refused before the rotation ran. */
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
 * crosses {@link MAX_CREDENTIALS_REQUEST_BODY_BYTES} while it is read, or does
 * not arrive within the time ceiling. Stated here because a route module never
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

/** The refusal of a body larger than {@link MAX_CREDENTIALS_REQUEST_BODY_BYTES}. */
function bodyTooLarge(operation: CredentialsOperation): BodyRejection {
  return {
    status: 413,
    error: new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The ${operation} request body is larger than this operation accepts.`,
      {
        hint: `Send ${BODY_SHAPES[operation]} as the body, at most ${String(MAX_CREDENTIALS_REQUEST_BODY_BYTES)} bytes.`,
        details: { operation, maxBytes: MAX_CREDENTIALS_REQUEST_BODY_BYTES },
      },
    ),
  };
}

/** The refusal of a body that did not arrive within `../http.ts`'s time ceiling. */
function bodyReadTimedOut(operation: CredentialsOperation): BodyRejection {
  return {
    status: 408,
    error: new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The ${operation} request body did not arrive in time.`,
      {
        hint: `Send ${BODY_SHAPES[operation]} as the whole body at once, then wait for the reply.`,
        details: { operation, problem: GUARD_BODY_READ_TIMEOUT_REASON },
      },
    ),
  };
}

/** The refusal of a body that is unreadable or not JSON; the body itself is never quoted. */
function bodyNotJson(
  operation: CredentialsOperation,
  problem: 'unreadable' | 'not-json',
): BodyRejection {
  const message =
    problem === 'unreadable'
      ? `The ${operation} request body could not be read.`
      : `The ${operation} request body is not valid JSON.`;
  return {
    status: 400,
    error: new DebuggenError('PROTOCOL_INVALID_MESSAGE', message, {
      hint: `Send ${BODY_SHAPES[operation]} as the request body.`,
      details: { operation, problem },
    }),
  };
}

/**
 * The refusal of a JSON body that does not satisfy the operation's schema.
 *
 * The rotation's body can carry nothing but `{}`, so protocol's issue
 * description — issue codes and paths, no rejected value — is forwarded as it
 * always has been. A release body carries a credential, and that description
 * renders the name of an unrecognised key, so it is replaced by
 * {@link RELEASE_BODY_OFF_SCHEMA_MESSAGE} and the parse error is dropped
 * rather than kept as a cause.
 *
 * @param operation The operation the body belongs to.
 * @param parseError What `parseHttpRequest` refused the body with.
 * @returns The `400` refusal.
 */
function bodyOffSchema(operation: CredentialsOperation, parseError: DebuggenError): BodyRejection {
  if (operation !== RELEASE) {
    return { status: 400, error: parseError };
  }
  return {
    status: 400,
    error: new DebuggenError('PROTOCOL_INVALID_MESSAGE', RELEASE_BODY_OFF_SCHEMA_MESSAGE, {
      hint: `Send ${BODY_SHAPES[operation]} as the request body.`,
      details: { operation, problem: 'off-schema' },
    }),
  };
}

/**
 * Reads a request body as JSON, bounded by
 * {@link MAX_CREDENTIALS_REQUEST_BODY_BYTES}.
 *
 * A declared `Content-Length` above the bound is refused before anything is
 * read. A body that declares no length (a chunked upload) is bounded while it
 * is read: `../http.ts`'s request-body guard errors the stream at the same
 * bound — and at its time ceiling — so `c.req.text()` rejects with the guard's
 * refusal instead of buffering an unbounded body, and that rejection is
 * answered `413` or `408` here, in this operation's own words. The text read
 * is measured once more, which keeps the bound for a handler composed without
 * the guard. An empty body reads as `undefined`, which the operation's strict
 * schema then refuses. `JSON.parse`'s own error is discarded, because its
 * message quotes the offending input.
 *
 * @param c The request context.
 * @param operation The operation the body belongs to, for the refusal message.
 * @returns The parsed value, or the refusal.
 */
async function readJsonBody(
  c: Context<ServerEnv>,
  operation: CredentialsOperation,
): Promise<Result<unknown, BodyRejection>> {
  const declared = c.req.header(CONTENT_LENGTH_HEADER);
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_CREDENTIALS_REQUEST_BODY_BYTES) {
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
  if (Buffer.byteLength(text, 'utf8') > MAX_CREDENTIALS_REQUEST_BODY_BYTES) {
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
 * outbound body with.
 *
 * @typeParam O The operation.
 * @param c The request context.
 * @param operation The operation whose declared request schema applies.
 * @returns The validated body, or the refusal (`400`/`408`/`413`).
 */
async function readRequest<O extends CredentialsOperation>(
  c: Context<ServerEnv>,
  operation: O,
): Promise<Result<HttpRequestBody<O>, BodyRejection>> {
  const raw = await readJsonBody(c, operation);
  if (isErr(raw)) {
    return raw;
  }
  const parsed = parseHttpRequest(operation, raw.value);
  if (isErr(parsed)) {
    return err(bodyOffSchema(operation, parsed.error));
  }
  return ok(parsed.value);
}

/* -------------------------------------------------------------------------------------------------
 * Release outcomes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `details.reason` of a failure, when it has the shape
 * {@link LOGGABLE_REASON} admits — the only shape this module logs.
 *
 * @param error The failure.
 * @returns The reason, or `undefined`.
 */
function loggableReasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.[GUARD_REASON_DETAIL_KEY];
  return typeof reason === 'string' && LOGGABLE_REASON.test(reason) ? reason : undefined;
}

/**
 * The error body of a failed release, answered `500` with `ref`: the
 * failure's code and this module's fixed sentence — {@link
 * RELEASE_PENDING_MESSAGE} for a revocation the launcher is still retrying
 * (`CLEANUP_PARTIAL`), {@link RELEASE_FAILED_MESSAGE} for anything else. The
 * body is checked against protocol's `httpErrorResponseSchema`, and a code it
 * would refuse is answered as `INTERNAL`.
 *
 * @param error The failure the launcher returned, or the one standing for a
 *   launcher that threw.
 * @param ref The correlation reference of the log record written for it.
 * @returns A schema-valid error body that carries no token.
 */
function releaseFailureBody(error: DebuggenError, ref: string): HttpErrorResponse {
  const message =
    error.code === 'CLEANUP_PARTIAL' ? RELEASE_PENDING_MESSAGE : RELEASE_FAILED_MESSAGE;
  const body: HttpErrorResponse = { code: error.code, message, ref };
  return httpErrorResponseSchema.safeParse(body).success
    ? body
    : { code: 'INTERNAL', message: RELEASE_FAILED_MESSAGE, ref };
}

/* -------------------------------------------------------------------------------------------------
 * The route
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the `credentials.rotate` and `credentials.release` handlers.
 *
 * Registers nothing, opens nothing and keeps no state between requests. The
 * principal the middleware resolved is a snapshot of a credential that
 * existed when the request arrived; once the body has been read, each handler
 * asks the store itself, through `requireLiveCredential`, whether that
 * credential still exists. If a rotation — this handler's, one run on another
 * connection, or one run by any other caller of `rotateAll` — or an expiry
 * retired it while the body was in flight, the request is refused `401`
 * (`unknown-credential` / `expired-credential`): it must not revoke the
 * credentials that replaced it, nor release one on the authority of a
 * credential that no longer exists. A rotation that reports it did not commit
 * (`details.rotated: false`) deleted nothing, so every credential it left is
 * still live and passes the fence. The fence is synchronous, and so are
 * `rotateAll` and the part of `releaseCredential` that reaches the store;
 * nothing awaits between the fence and either, so no retirement can
 * interleave.
 *
 * Status codes, all with protocol's `httpErrorResponseSchema` body on failure,
 * are tabulated in the module documentation.
 *
 * @param deps The access boundary's fence and rotation, the launcher's
 *   release, and an optional logger.
 * @returns The handlers, keyed by operation id.
 *
 * @example
 * ```ts
 * const credentials = createCredentialsRoutes({ auth, launcher, logger });
 * const authFor = createAuthMiddleware(auth);
 * for (const operation of CREDENTIALS_OPERATIONS) {
 *   const { method, pattern } = HTTP_ROUTES[operation];
 *   app.on(method, pattern, authFor(operation), credentials[operation]);
 * }
 * ```
 */
export function createCredentialsRoutes(deps: CredentialsRoutesDeps): CredentialsRouteHandlers {
  const { auth } = deps;
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);

  /** Answers an access-boundary refusal at the status `../auth.ts`'s table fixes. */
  const answerRefusal = (
    c: Context<ServerEnv>,
    refusal: DebuggenError,
    operation: CredentialsOperation,
  ): Response => {
    const { status, body } = authErrorResponse(refusal);
    log.warn(`A credential ${ACTION_LABELS[operation]} request was refused`, {
      operation,
      status,
      errorCode: refusal.code,
    });
    return c.json(body, status);
  };

  /**
   * Runs the rotation. `rotateAll` reports every failure as a `Result`; a
   * throw is a defect below, answered as an outcome nobody can state.
   */
  const rotate = (): Result<RotationOutcome, DebuggenError> => {
    try {
      return auth.rotateAll();
    } catch (caught) {
      // The thrown value is kept as the cause for a debugger, never logged or
      // answered: nothing below promises it is free of credential material.
      return err(
        new DebuggenError('INTERNAL', ROTATION_OUTCOME_UNKNOWN_MESSAGE, {
          details: { reason: 'rotation-threw' },
          cause: caught,
        }),
      );
    }
  };

  /**
   * Tells the launcher that every credential was rotated away, once the
   * rotation committed — whether or not it then finished — so each dev server
   * it launched is replaced, with a new credential, on its project's next
   * launch. Best effort and synchronous: a launcher without the hook, one
   * missing from the composition or one that throws changes nothing about
   * the answer, because the launcher's own liveness check at the next launch
   * finds the same retired credentials.
   */
  const announceRotation = (): void => {
    try {
      deps.launcher.credentialsRotated?.();
    } catch {
      log.warn(
        'The dev-server launcher could not be told about the rotation; its next launch finds the retired credentials',
        { operation: ROTATE },
      );
    }
  };

  /**
   * The revocation fence: whether the credential that authorized the request
   * is still live. `requireLiveCredential` reports every failure as a
   * `Result`; a throw is a defect below and fails closed — it is answered as
   * the access boundary's `500`, never as a pass.
   */
  const requireLive = (
    principal: Principal,
    operation: CredentialsOperation,
  ): Result<void, DebuggenError> => {
    try {
      return auth.requireLiveCredential(principal);
    } catch (caught) {
      return err(
        new DebuggenError(
          'INTERNAL',
          `The credential that authorized this ${ACTION_LABELS[operation]} could not be confirmed.`,
          { details: { reason: 'credential-check-threw' }, cause: caught },
        ),
      );
    }
  };

  /**
   * Runs the release. `releaseCredential` reports every failure as a
   * `Result`; a throw — or a launcher missing from a composition that never
   * wired one — is a defect below, answered as a failed release.
   *
   * The launcher is called in the same synchronous run as the fence the
   * handler checked just before: an async function executes up to its first
   * `await` when called, and the launcher reaches the store before its own
   * first `await`, so the revocation lands before anything else can run.
   *
   * @param request The validated `{ token }`; handed on and nothing else.
   */
  const release = async (
    request: CredentialsReleaseRequest,
  ): Promise<Result<CredentialsReleaseResponse, DebuggenError>> => {
    try {
      return await deps.launcher.releaseCredential(request);
    } catch (caught) {
      // Kept as the cause for a debugger, never logged or answered: the token
      // went in, so nothing promises the thrown value is free of it.
      return err(
        new DebuggenError('INTERNAL', RELEASE_FAILED_MESSAGE, {
          details: { reason: 'release-threw' },
          cause: caught,
        }),
      );
    }
  };

  /**
   * `POST /credentials/rotate` — editor credential required.
   *
   * Order is the security property: the principal and its role are checked
   * before the body is read, the body and then the credential's liveness
   * before anything is revoked.
   */
  const rotateCredentials: CredentialsRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);

    // The middleware sets `principal` for every non-exempt operation. Its
    // absence means the handler was registered without it — a composition
    // defect — and the request is treated as unauthenticated, never trusted.
    const principal: Principal | undefined = c.get('principal');
    if (principal === undefined) {
      log.error('credentials.rotate reached its handler without a resolved principal', {
        operation: ROTATE,
      });
      return answerRefusal(c, refusalFor('missing-credential'), ROTATE);
    }
    const permitted = requireRole(principal, ...OPERATION_ROLES[ROTATE]);
    if (isErr(permitted)) {
      return answerRefusal(c, permitted.error, ROTATE);
    }

    const request = await readRequest(c, ROTATE);
    if (isErr(request)) {
      log.debug('Refused a credential rotation request body', {
        operation: ROTATE,
        status: request.error.status,
        errorCode: request.error.error.code,
      });
      return c.json(toErrorPayload(request.error.error), request.error.status);
    }

    // The body was awaited; the credential that authorized the request may
    // have been retired meanwhile. Nothing awaits between this check and the
    // rotation, and both are synchronous.
    const live = requireLive(principal, ROTATE);
    if (isErr(live)) {
      return answerRefusal(c, live.error, ROTATE);
    }

    const rotated = rotate();
    const state = isErr(rotated) ? rotationStateOf(rotated.error) : true;
    if (state === true) {
      // Committed: every launched dev server's credential is gone.
      announceRotation();
    }
    if (isErr(rotated)) {
      // A refusal is answered as one; a failure that states a rotation outcome
      // never is, even if a detail it carries happens to share a reason name.
      if (state === undefined && authFailureStatus(rotated.error) !== undefined) {
        return answerRefusal(c, rotated.error, ROTATE);
      }
      const ref = newMessageId();
      log.error('The credential rotation failed', {
        operation: ROTATE,
        status: SERVER_FAILURE_STATUS,
        errorCode: rotated.error.code,
        rotated: state ?? 'unknown',
        ref,
      });
      return c.json(rotationFailureBody(rotated.error, ref), SERVER_FAILURE_STATUS);
    }

    const response = parseHttpResponse(ROTATE, {
      credentialsDeleted: rotated.value.credentialsDeleted,
      socketsClosed: rotated.value.socketsClosed,
    });
    if (isErr(response)) {
      const ref = newMessageId();
      log.error('A credential rotation reply did not satisfy its protocol schema', {
        operation: ROTATE,
        status: SERVER_FAILURE_STATUS,
        errorCode: response.error.code,
        ref,
      });
      const body: HttpErrorResponse = { code: 'INTERNAL', message: RESPONSE_DRIFT_MESSAGE, ref };
      return c.json(body, SERVER_FAILURE_STATUS);
    }

    log.info('Rotated every service credential on the editor’s request', {
      operation: ROTATE,
      status: 200,
      credentialsDeleted: response.value.credentialsDeleted,
      socketsClosed: response.value.socketsClosed,
    });
    return c.json(response.value, 200);
  };

  /**
   * `POST /credentials/release` — editor credential required.
   *
   * The same order as the rotation: principal and role before the body, the
   * body and then the credential's liveness before anything is revoked. The
   * fence and the launcher's store action run in one synchronous stretch. The
   * token in the body goes to the launcher and nowhere else — not into a log
   * record, a refusal or a reply.
   */
  const releaseCredential: CredentialsRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);

    // As in the rotation: a missing principal is a composition defect, and the
    // request is treated as unauthenticated.
    const principal: Principal | undefined = c.get('principal');
    if (principal === undefined) {
      log.error('credentials.release reached its handler without a resolved principal', {
        operation: RELEASE,
      });
      return answerRefusal(c, refusalFor('missing-credential'), RELEASE);
    }
    const permitted = requireRole(principal, ...OPERATION_ROLES[RELEASE]);
    if (isErr(permitted)) {
      return answerRefusal(c, permitted.error, RELEASE);
    }

    const request = await readRequest(c, RELEASE);
    if (isErr(request)) {
      log.debug('Refused a credential release request body', {
        operation: RELEASE,
        status: request.error.status,
        errorCode: request.error.error.code,
      });
      return c.json(toErrorPayload(request.error.error), request.error.status);
    }

    // The body was awaited; the credential that authorized the request may
    // have been retired meanwhile. Nothing awaits between this check and the
    // launcher's store action: `release` is called, not deferred, and the
    // launcher acts before its own first `await`.
    const live = requireLive(principal, RELEASE);
    if (isErr(live)) {
      return answerRefusal(c, live.error, RELEASE);
    }

    const released = await release(request.value);
    if (isErr(released)) {
      const ref = newMessageId();
      const reason = loggableReasonOf(released.error);
      log.error('The credential release failed', {
        operation: RELEASE,
        status: SERVER_FAILURE_STATUS,
        errorCode: released.error.code,
        ...(reason === undefined ? {} : { reason }),
        ref,
      });
      return c.json(releaseFailureBody(released.error, ref), SERVER_FAILURE_STATUS);
    }

    const response = parseHttpResponse(RELEASE, { released: released.value.released });
    if (isErr(response)) {
      const ref = newMessageId();
      log.error('A credential release reply did not satisfy its protocol schema', {
        operation: RELEASE,
        status: SERVER_FAILURE_STATUS,
        errorCode: response.error.code,
        ref,
      });
      const body: HttpErrorResponse = {
        code: 'INTERNAL',
        message: RELEASE_RESPONSE_DRIFT_MESSAGE,
        ref,
      };
      return c.json(body, SERVER_FAILURE_STATUS);
    }

    log.info('Answered a server-agent credential release on the editor’s request', {
      operation: RELEASE,
      status: 200,
      released: response.value.released,
    });
    return c.json(response.value, 200);
  };

  return Object.freeze({
    [ROTATE]: rotateCredentials,
    [RELEASE]: releaseCredential,
  });
}
