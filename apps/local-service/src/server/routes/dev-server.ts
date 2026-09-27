/**
 * The editor's control over the target project's dev server: `POST
 * /dev-server/launch`, `POST /dev-server/stop` and `POST
 * /dev-server/credential` (AAP §0.4.2, §0.5.5, §0.5.6).
 *
 * ## Three operations, one owner of the contract
 *
 * `devServer.launch`, `devServer.stop` and `devServer.credential` are rows of
 * `@debuggen/protocol`'s `HTTP_ROUTES`, which owns their methods, paths and
 * bodies. `../http.ts` registers each at the table's own method and pattern
 * while it iterates `HTTP_OPERATIONS`, behind the auth middleware for that
 * same operation, and this module answers them from
 * {@link DevServerRoutes.handlers}. Every body is validated with protocol's
 * `parseHttpRequest` and every reply with `parseHttpResponse` — the same
 * helpers the client SDK uses — so the service accepts exactly what a client
 * can send and answers exactly what a client can parse. No route of this
 * module is registered beside the table.
 *
 * A command-line client such as `scripts/dev-instrumented.mjs` follows the
 * same surface: it probes `GET /health` (unauthenticated), then either calls
 * `POST /dev-server/launch` with the editor credential and, on teardown,
 * `POST /dev-server/stop`, or requests a server-agent credential for a dev
 * server it starts itself with `POST /dev-server/credential`.
 *
 * ## Authorization comes from the resolved principal
 *
 * `../auth.ts`'s middleware refuses web origins and resolves the bearer
 * credential before any handler here runs; the handlers read the result with
 * `c.get('principal')` and never from a body field, a header or a client's
 * description of itself. Each handler then applies, in this order:
 *
 * 1. the **role** — `OPERATION_ROLES` of its own operation, the editor
 *    (`vscode`) only for all three, decided by the same role table the
 *    middleware applied. A `devtools` or `server-agent` credential can never
 *    launch, stop or mint;
 * 2. the **body** — bounded ({@link MAX_DEV_SERVER_REQUEST_BODY_BYTES}), JSON,
 *    and valid against the operation's protocol schema;
 * 3. the **project root's shape** — {@link normalizeRequestedProjectRoot}
 *    refuses a relative, network (UNC), `..`-bearing, whitespace-padded or
 *    control-character-bearing root before it reaches the launcher, and a
 *    Windows drive-letter root anywhere but on a `win32` host (where it is
 *    the native absolute form; elsewhere it is a relative path). The
 *    normalised root is the one the scope is checked against **and** the one
 *    the launcher is handed, so what was authorized is what is acted on;
 * 4. the **scope** — an editor credential acts only on projects under the
 *    workspace folders its connections announced in `client.hello`, on disk
 *    as well as in spelling. A project outside them is refused with `403`. A
 *    stop or a credential request, which acts on no project file, checks it
 *    once with `requireProjectScope`. A launch spawns in the directory after
 *    many awaits, so it is admitted with `admitProjectRoot`, which keeps the
 *    canonical path the root was admitted under; `reconfirmProjectRoot`
 *    re-proves that identity at the launch's fence (step 6) and, handed to the
 *    launcher as `confirmProjectRoot`, again immediately before detection
 *    reads the project and immediately before the child is spawned — in the
 *    canonical root — so a link on the path retargeted after admission is
 *    refused `403` rather than followed (CWE-367). A launch or a credential
 *    request is then refused `400 FS_UNSAFE_PATH` when the canonical project
 *    root is, contains or lies inside the canonical `$DEBUGGEN_HOME`, because
 *    session data and backups live outside every target project — for a
 *    launch, judged on the canonical path it was admitted under; a stop is
 *    never refused for it;
 * 5. for a launch that names a `sessionId`, the **session** — it must exist
 *    (`404`), belong to exactly the launched project and not have ended
 *    (`409`). Only then is the child tied to it: the launcher stops a child
 *    spawned for a session when the last session relying on it ends, while a
 *    launch that names no session starts the developer's own dev server, which
 *    no session end stops;
 * 6. the **revocation fence** — `AuthService.requireLiveCredential`: the
 *    credential the middleware resolved the principal from must still be
 *    live once the body has been read. A rotation (`POST /credentials/rotate`)
 *    or an expiry that retired it while the body was in flight is refused
 *    `401` (`unknown-credential` / `expired-credential`), so a retired editor
 *    credential can neither launch, stop nor mint. A launch's fence also
 *    re-proves its admitted project root (step 4).
 *
 * The role is checked before the body is read, so a caller without the editor
 * role learns nothing about dev servers.
 *
 * ## Why the fence sits where it does
 *
 * The middleware resolves the principal once, before the handler runs, and
 * the handler then awaits the client's body — for as long as the client
 * chooses. The fence runs after that await and **immediately before** the
 * launcher call, with no `await` between the two:
 *
 * - `devServer.credential` is fenced end to end. `launcher.issueCredential`
 *   runs synchronously up to its issuer call, which `main.ts`'s
 *   `credentialIssuerOf` binds to `AuthService.issueServerAgentCredential` —
 *   itself synchronous up to its insert. `AuthService.rotateAll` is
 *   synchronous too, so no rotation can run between a fence that passed and
 *   the insert of the new server-agent row: either the rotation ran first and
 *   the fence refuses, or the insert ran first and the rotation deletes it.
 * - `devServer.launch` and `devServer.stop` are fenced at **initiation**. A
 *   launch probes, spawns and waits for readiness across many awaits, and the
 *   launcher mints the child's server-agent credential only on the way; a
 *   launch started under a then-live credential may therefore complete after
 *   a rotation. Its credential goes into the child's environment, never into
 *   this response, and the rotation's contract is that launched dev servers
 *   are relaunched (AAP §0.5.6).
 *
 * ## What this module does not do
 *
 * It is authorization, validation and delegation, nothing more.
 * `../../dev-server/launcher.ts` — with `../../dev-server/detect.ts` — owns
 * every decision about probing, package managers, dev scripts, the preload
 * path, spawning, readiness, child lifetime, `SIGTERM`→`SIGKILL` escalation,
 * credential minting and exactly-once revocation, and the whole
 * `NODE_OPTIONS=--import` / `DEBUGGEN_INGEST_URL` / `DEBUGGEN_TOKEN` /
 * `DEBUGGEN_PROJECT_ROOT` environment contract. Nothing here spawns or signals
 * a process, revokes or stores a credential, reads `process.env`, opens a
 * socket or a database, or registers a route: `../http.ts` registers the
 * handlers this module returns.
 *
 * ## Graceful failure (AAP §0.5.5)
 *
 * Every failure answers with protocol's error payload, `{ code, message }`, at
 * a status chosen from the error's code (refined by the launcher's
 * `details.reason` where the code alone is ambiguous). The protocol payload
 * carries no `hint` field, so a developer-facing recovery instruction travels
 * inside `message`: the launcher's hint is appended **verbatim**. That is how
 * the exact relaunch command reaches VS Code when a dev server already runs
 * without the preload — the hint `detect.ts`'s `buildRelaunchHint` produced,
 * token-free by construction, never composed, reformatted or templated here.
 * The launcher keeps a failed start's output in the service log (its redacted
 * last lines, logged with the failure's warning) and its hints are fixed text
 * that say so. An error whose details nevertheless carry an `outputTail` —
 * a hint that could quote the dev server's own output — has that hint
 * **not** forwarded: the output stays in the service log, and the response
 * says so. Access-boundary refusals are rendered by `../auth.ts`'s own
 * `authErrorResponse`; a store or internal failure is answered `500` with a
 * fixed message, never in its own words.
 *
 * ## Secrets discipline
 *
 * The server-agent token minted by the credential route exists in this module
 * only on its way into that route's single response body. It is never logged,
 * persisted, re-read, placed in a `DebuggenError` (message, hint or details) or
 * included in any other response. No response or log line here carries
 * `NODE_OPTIONS`, a child's environment or a child's output. Every log record
 * carries constant text plus an operation label, an error code, a status, a
 * launcher reason or a pid. Validation failures are rendered from Zod issue
 * paths and codes (`describeZodIssues`), never from a submitted value. Every
 * response carries `Cache-Control: no-store`, and no
 * `Access-Control-Allow-Origin` header is ever set — its absence is why a web
 * page cannot read these responses.
 */

import type { Context, Handler } from 'hono';

import {
  httpErrorResponseSchema,
  parseHttpRequest,
  parseHttpResponse,
  toErrorPayload,
} from '@debuggen/protocol';
import type { HttpErrorResponse, HttpRequestBody, SessionRecord } from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  noopLogger,
  normalizePosix,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result } from '@debuggen/shared';

import {
  PROJECT_ROOT_UNRESOLVABLE_REASON,
  STATE_HOME_OVERLAP_REASON,
  requireProjectOutsideStateHome,
} from '../../config.js';
import { toDevServerLaunchResponse } from '../../dev-server/launcher.js';
import type { DevServerLauncher } from '../../dev-server/launcher.js';
import { subsystemLogger } from '../../logging.js';
import type { SessionManager } from '../../sessions/manager.js';
import {
  AUTH_FAILURE_REASONS,
  OPERATION_ROLES,
  admitProjectRoot,
  authErrorResponse,
  authFailureStatus,
  reconfirmProjectRoot,
  requireProjectScope,
  requireRole,
} from '../auth.js';
import type {
  AdmittedProjectRoot,
  AuthFailureReason,
  AuthService,
  AuthenticatedOperation,
  Principal,
  PrincipalRole,
  ServerEnv,
} from '../auth.js';

/* -------------------------------------------------------------------------------------------------
 * The operations this module owns
 * ---------------------------------------------------------------------------------------------- */

/**
 * `POST /dev-server/launch`. `satisfies AuthenticatedOperation` is the
 * compile-time proof that protocol still requires a bearer credential for it:
 * were the route table ever to flag it exempt, this line would stop compiling
 * rather than the handler running without a principal.
 */
const LAUNCH = 'devServer.launch' satisfies AuthenticatedOperation;

/** `POST /dev-server/stop`, pinned the same way as {@link LAUNCH}. */
const STOP = 'devServer.stop' satisfies AuthenticatedOperation;

/**
 * `POST /dev-server/credential`, pinned the same way as {@link LAUNCH}: it
 * mints a project-scoped `server-agent` credential for a dev server the caller
 * starts itself, so it must never run without a principal.
 */
const CREDENTIAL = 'devServer.credential' satisfies AuthenticatedOperation;

/**
 * The protocol operations this module answers, in the route table's order.
 *
 * `../http.ts` builds an exhaustive `Record<HttpOperationId, handler>` from the
 * route modules; this tuple is this module's slice of it, and the `satisfies`
 * clause keeps each member a genuine, authenticated protocol operation id.
 */
export const DEV_SERVER_OPERATIONS = Object.freeze([
  LAUNCH,
  STOP,
  CREDENTIAL,
] as const satisfies readonly AuthenticatedOperation[]);

/** One of {@link DEV_SERVER_OPERATIONS}. */
export type DevServerOperation = (typeof DEV_SERVER_OPERATIONS)[number];

/**
 * Every label a request handled here is logged and refused under: its
 * protocol operation id, never a path.
 */
type RouteLabel = DevServerOperation;

/* -------------------------------------------------------------------------------------------------
 * Policy constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The largest request body any of the three operations accepts, in bytes.
 *
 * The largest honest body is a launch request: a project root and a command of
 * at most 4 096 characters each (protocol's bounds, which count characters).
 * Even at four UTF-8 bytes per character that is about 33 KiB of JSON, so
 * 64 KiB never refuses a schema-valid body, while keeping a caller from making
 * the service buffer an arbitrarily large one. A body declared or found larger
 * is answered `413` without being parsed.
 */
export const MAX_DEV_SERVER_REQUEST_BODY_BYTES = 64 * 1024;

/** The request header a client declares its body length in. */
const CONTENT_LENGTH_HEADER = 'content-length';

/** The response header that keeps a dev-server answer — and above all a credential — out of every cache. */
const CACHE_CONTROL_HEADER = 'cache-control';

/** The {@link CACHE_CONTROL_HEADER} value on every response of this module. */
const NO_STORE = 'no-store';

/** The log subsystem binding of this module's records. */
const LOG_SUBSYSTEM = 'server.dev-server';

/** The key of the launcher's error details that marks a hint quoting the dev server's own output. */
const OUTPUT_TAIL_DETAIL_KEY = 'outputTail';

/** The key of an error's details that names the launcher's (or this module's) failure reason. */
const REASON_DETAIL_KEY = 'reason';

/** What a logged launcher reason must look like to be logged: a short kebab-case word list. */
const LOGGABLE_REASON = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Said in place of a hint that quotes the dev server's output. The launcher
 * logs a failed start's last output lines, redacted, with that failure's
 * warning under `subsystem: "dev-server"`, which is where the developer reads
 * them; its own hints never quote them, so this sentence stands in only for
 * an error that carries a `details.outputTail`.
 */
const OUTPUT_WITHHELD_SENTENCE =
  "The dev server's last output is in the Debug Generator service log.";

/**
 * The fixed message of a `500` for a failure that is not the developer's to act
 * on in its own words — a store or internal failure, or an error code this
 * module does not expect from the launcher.
 */
const DEV_SERVER_UNAVAILABLE_MESSAGE =
  'The Debug Generator local service could not complete this dev-server request. Its log holds the reason.';

/**
 * The fixed message of a `500` when a response this module built does not
 * satisfy its schema — a drift between the launcher and the contract, never
 * something a client caused.
 */
const RESPONSE_DRIFT_MESSAGE =
  'The Debug Generator local service built a dev-server response that does not match its contract. Its log holds the reason.';

/** The status a project root that overlaps the state root is refused with. */
const STATE_HOME_REFUSAL_STATUS = 400;

/**
 * The `details.reason` values of the two refusals `requireProjectOutsideStateHome`
 * raises, both answered {@link STATE_HOME_REFUSAL_STATUS} in their own constant
 * words.
 */
const STATE_HOME_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  STATE_HOME_OVERLAP_REASON,
  PROJECT_ROOT_UNRESOLVABLE_REASON,
]);

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/**
 * What {@link createDevServerRoutes} is built from: the narrowest slice of the
 * dev-server launcher the three handlers call, the access boundary's
 * revocation fence, and an optional logger.
 *
 * Declared here, next to the routes that need it, so `../http.ts` composes its
 * dependency aggregate from this interface rather than restating its fields.
 * The field name `auth` matches the sibling route modules' slices of the same
 * service, so the aggregate asks for one object that satisfies them all. Every
 * operation is keyed by the project root in its own body, which the
 * principal's scope is checked against directly; the session manager is read
 * only to check the session a launch names.
 */
export interface DevServerRoutesDeps {
  /**
   * The launcher's three request-serving operations. Detection, spawning,
   * readiness, child lifetime, credential minting and revocation all happen
   * inside these calls.
   */
  readonly launcher: Pick<DevServerLauncher, 'launch' | 'stop' | 'issueCredential'>;

  /**
   * The session manager, the same object the session routes receive: a launch
   * that names a session is tied to it only when the session exists, belongs
   * to the launched project and has not ended (`get`); and a session whose
   * launched dev server serves at another origin than the one it recorded is
   * brought up to date (`patch`), because its tab is bound by that origin.
   */
  readonly manager: Pick<SessionManager, 'get' | 'patch'>;

  /**
   * The revocation fence each handler applies between reading its body and
   * calling the launcher (see the module documentation).
   */
  readonly auth: Pick<AuthService, 'requireLiveCredential'>;

  /**
   * The state root (`$DEBUGGEN_HOME`) as `realpath` resolved it once at
   * start-up. `devServer.launch` and `devServer.credential` refuse a project
   * root that is, contains or lies inside it — canonicalised by
   * `requireProjectOutsideStateHome` of `../../config.ts` — with
   * `400 FS_UNSAFE_PATH` before the launcher is called, so no preload is
   * attached to, and no credential minted for, a project whose working tree
   * would hold the service's private state (CWE-200).
   * `devServer.stop` is not checked: stopping only ends a process and revokes
   * its credential, and must stay possible. Declared by the same name and type
   * as `./sessions.ts`'s field, so `../http.ts`'s aggregate carries one value to
   * both; `main.ts` always supplies it, and without it no check is made.
   */
  readonly canonicalStateHome?: string | undefined;

  /**
   * The platform whose path grammar a requested project root is read in;
   * defaults to the service's own `process.platform`, the platform the
   * launcher spawns on. Only on `win32` is a drive-letter root (`C:/work/app`)
   * absolute — on every other platform it is a relative path and is refused.
   * Injectable so both grammars are testable on one host.
   */
  readonly platform?: NodeJS.Platform | undefined;

  /**
   * Where this module's diagnostics go; defaults to the no-op logger. Records
   * carry constant text, labels, codes, statuses and pids only — never a token,
   * an environment value or a child's output.
   */
  readonly logger?: Logger | undefined;
}

/**
 * A dev-server route handler, typed on the service's hono environment so
 * `c.get('principal')` is the principal `../auth.ts`'s middleware resolved.
 */
export type DevServerRouteHandler = Handler<ServerEnv>;

/**
 * The handlers of the three protocol operations, keyed by operation id so
 * `../http.ts` can place them in its exhaustive handler record unchanged.
 */
export type DevServerRouteHandlers = Readonly<Record<DevServerOperation, DevServerRouteHandler>>;

/** Everything {@link createDevServerRoutes} returns. */
export interface DevServerRoutes {
  /**
   * `devServer.launch`, `devServer.stop` and `devServer.credential`, for the
   * table-driven registration loop.
   */
  readonly handlers: DevServerRouteHandlers;
}

/**
 * Every status this module answers a failure with, besides the access-boundary
 * statuses `../auth.ts`'s `authErrorResponse` chooses (`401`, `403`, `429`).
 */
export type DevServerFailureStatus = 400 | 403 | 404 | 408 | 409 | 413 | 500 | 502 | 503 | 504;

/* -------------------------------------------------------------------------------------------------
 * The failure vocabulary: which status a failure is answered with
 * ---------------------------------------------------------------------------------------------- */

/**
 * The status of a failure by its error code — every code the launcher, this
 * module's own validation and protocol's body parser raise.
 *
 * A code **absent** from this table (`STORE_ERROR`, `INTERNAL`, or one the
 * launcher does not document) is answered `500` with
 * {@link DEV_SERVER_UNAVAILABLE_MESSAGE}: its own words are for the service
 * log, not for a response body. Access-boundary refusals never reach this
 * table; `authErrorResponse` answers them first.
 *
 * - `PROTOCOL_INVALID_MESSAGE` — an off-schema body: `400`.
 * - `PATH_OUTSIDE_PROJECT` — a project root outside the principal's scope:
 *   `403` (this module's malformed-root refusal is refined to `400` by reason).
 * - `PROJECT_NOT_FOUND` — the project root is not an existing directory: `404`.
 * - `SESSION_NOT_FOUND` — the session a launch names does not exist: `404`.
 * - `SESSION_INVALID_STATE` — the session a launch names belongs to another
 *   project or has already ended: `409`.
 * - `CLEANUP_PARTIAL` — a stop ended its dev server but could not yet revoke
 *   the server's credential: `500`, with the launcher's constant sentence and
 *   the moment the credential lapses on its own.
 * - `SERVER_AGENT_NOT_READY` — a dev server already serves the project without
 *   the preload, so a second one was not started on its port: `409`.
 * - `DEV_SERVER_LAUNCH_FAILED` — the dev server could not be started or died
 *   before it was ready: `502`, an upstream failure.
 * - `DEV_SERVER_UNAVAILABLE` / `INSTRUMENTATION_UNAVAILABLE` — the dev server or
 *   the telemetry preload is not available: `503`.
 * - `CONFIG_INVALID` — the service's own address or preload configuration is
 *   unusable: `500`, with the launcher's constant sentence.
 */
const STATUS_BY_CODE: ReadonlyMap<DebuggenErrorCode, DevServerFailureStatus> = new Map<
  DebuggenErrorCode,
  DevServerFailureStatus
>([
  ['PROTOCOL_INVALID_MESSAGE', 400],
  ['PATH_OUTSIDE_PROJECT', 403],
  ['PROJECT_NOT_FOUND', 404],
  ['SESSION_NOT_FOUND', 404],
  ['SESSION_INVALID_STATE', 409],
  ['SERVER_AGENT_NOT_READY', 409],
  ['DEV_SERVER_LAUNCH_FAILED', 502],
  ['DEV_SERVER_UNAVAILABLE', 503],
  ['INSTRUMENTATION_UNAVAILABLE', 503],
  ['CONFIG_INVALID', 500],
  ['CLEANUP_PARTIAL', 500],
]);

/**
 * Refinements of {@link STATUS_BY_CODE} by the failure's `details.reason`,
 * where one code covers failures a client must tell apart. Consulted only for
 * a code the table above answers, so a reason can sharpen a status but never
 * turn an opaque failure into a described one; an unknown reason falls back to
 * the code's status.
 *
 * - Refused request content — a malformed project root, a request naming no
 *   project, a command that cannot be run without a shell, a command the
 *   launcher's command policy refuses (an environment assignment, `NODE_OPTIONS`
 *   or `NODE_PATH` off its allowlist, an executable other than a declared
 *   script run, `next dev` or Node running the project's framework CLI, an
 *   undeclared script, an unsafe argument, an untrusted framework CLI): `400`.
 * - The project's state conflicts with the request — no dev script, an
 *   undeterminable package manager, a dev server that answers at no address
 *   the service knows, a launch overtaken by a stop: `409`.
 * - The dev server printed no address and answered no probe in time: `504`.
 * - The service is shutting down: `503`.
 */
const STATUS_BY_REASON: ReadonlyMap<string, DevServerFailureStatus> = new Map<
  string,
  DevServerFailureStatus
>([
  ['project-root-invalid', 400],
  ['project-root-not-absolute', 400],
  ['no-selector', 400],
  ['invalid-credential-request', 400],
  ['empty-command', 400],
  ['unterminated-quote', 400],
  ['trailing-backslash', 400],
  ['shell-operator', 400],
  ['no-executable', 400],
  ['env-assignment-not-allowed', 400],
  ['node-options-not-allowed', 400],
  ['node-path-not-allowed', 400],
  ['executable-not-allowed', 400],
  ['script-not-declared', 400],
  ['argument-not-allowed', 400],
  ['dev-cli-untrusted', 400],
  ['no-dev-script', 409],
  ['unknown-package-manager', 409],
  ['running-without-address', 409],
  ['cancelled', 409],
  ['ready-timeout', 504],
  ['shutting-down', 503],
]);

/**
 * The failure reason recorded in an error's `details`, when it is a short
 * kebab-case word list — the only shape this module logs or looks up.
 *
 * @param error Any error answered here.
 * @returns The reason, or `undefined`.
 */
function reasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.[REASON_DETAIL_KEY];
  return typeof reason === 'string' && LOGGABLE_REASON.test(reason) ? reason : undefined;
}

/**
 * The status a non-refusal failure is answered with, or `undefined` for a
 * failure whose own words must not reach a response body.
 *
 * @param error The failure.
 * @returns The status from {@link STATUS_BY_REASON} or {@link STATUS_BY_CODE}.
 */
function describedStatusOf(error: DebuggenError): DevServerFailureStatus | undefined {
  const byCode = STATUS_BY_CODE.get(error.code);
  if (byCode === undefined) {
    return undefined;
  }
  const reason = reasonOf(error);
  return (reason === undefined ? undefined : STATUS_BY_REASON.get(reason)) ?? byCode;
}

/**
 * Whether an error's hint may quote the dev server's own output. The launcher
 * logs a failed start's redacted tail and never places it in an error, so its
 * errors carry no `details.outputTail` and their constant hints are
 * forwarded. This is the boundary's own guard for any error that does: a tail
 * of blank lines only leaves the hint forwardable; anything else under that
 * key — including a value that is not an array of strings — is treated as
 * quoting output.
 *
 * @param error The failure.
 * @returns `true` when the hint must not be forwarded.
 */
function hintQuotesChildOutput(error: DebuggenError): boolean {
  if (error.details === undefined || !Object.hasOwn(error.details, OUTPUT_TAIL_DETAIL_KEY)) {
    return false;
  }
  const tail: unknown = error.details[OUTPUT_TAIL_DETAIL_KEY];
  const blankOnly =
    Array.isArray(tail) &&
    tail.every((line: unknown) => typeof line === 'string' && line.trim().length === 0);
  return !blankOnly;
}

/**
 * The recovery instruction a failure's response carries after its message: the
 * error's hint **verbatim**, or {@link OUTPUT_WITHHELD_SENTENCE} in place of a
 * hint that quotes child output, or nothing when the error has no hint.
 *
 * @param error The failure.
 * @returns The sentence(s) to append, or `undefined`.
 */
function recoveryTextOf(error: DebuggenError): string | undefined {
  if (hintQuotesChildOutput(error)) {
    return OUTPUT_WITHHELD_SENTENCE;
  }
  const hint = error.hint;
  return hint !== undefined && hint.trim().length > 0 ? hint : undefined;
}

/**
 * The message a described failure is answered with.
 *
 * The protocol's error payload has no `hint` field, so the recovery
 * instruction travels inside the message (the AAP §0.5.5 convention): first
 * the error's message followed by its hint; when the pair would exceed the
 * payload's bound, the hint alone — a relaunch hint opens with the
 * consequence it addresses, so it still reads on its own — then the message
 * alone. Each candidate is checked against protocol's own
 * `httpErrorResponseSchema`, so no bound is restated here and no response
 * this module sends can be refused by a client's parser.
 *
 * @param error The failure; its code must be one {@link STATUS_BY_CODE} answers.
 * @returns A message the error payload schema accepts.
 */
function describedMessageOf(error: DebuggenError): string {
  const recovery = recoveryTextOf(error);
  const candidates =
    recovery === undefined
      ? [error.message]
      : [`${error.message} ${recovery}`, recovery, error.message];
  for (const message of candidates) {
    if (httpErrorResponseSchema.safeParse({ code: error.code, message }).success) {
      return message;
    }
  }
  return DEV_SERVER_UNAVAILABLE_MESSAGE;
}

/**
 * Builds the refusal `../auth.ts` raises for `reason`, from its own table: the
 * table's code and constant message, `details.reason` naming the entry (which is
 * what `authErrorResponse` maps back to a status) and the table's hint when it
 * has one. No presented value can reach it.
 *
 * @param reason The `AUTH_FAILURE_REASONS` entry to raise.
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

/* -------------------------------------------------------------------------------------------------
 * The requested project root
 * ---------------------------------------------------------------------------------------------- */

/**
 * Why {@link normalizeRequestedProjectRoot} refused a project root. Recorded in
 * the refusal's `details.rejection`; the refused value itself is never recorded.
 */
export type ProjectRootRejection =
  | 'control-character'
  | 'padded'
  | 'network-path'
  | 'parent-segment'
  | 'drive-letter'
  | 'not-absolute';

/**
 * The `details.reason` of every malformed-root refusal: a `PATH_OUTSIDE_PROJECT`
 * error, answered `400` because the root was refused for its shape before any
 * scope was consulted.
 */
const PROJECT_ROOT_INVALID_REASON = 'project-root-invalid';

/** The constant sentence each rejection is refused with. */
const PROJECT_ROOT_REJECTION_MESSAGES: Readonly<Record<ProjectRootRejection, string>> =
  Object.freeze({
    'control-character': 'A project root must not contain control characters.',
    padded: 'A project root must not begin or end with whitespace.',
    'network-path': 'A project root must be a local path, not a network (UNC) path.',
    'parent-segment': 'A project root must not contain ".." segments.',
    'drive-letter':
      'A drive-letter project root is absolute only on Windows; the Debug Generator service on this machine expects a POSIX absolute path.',
    'not-absolute': 'A project root must be an absolute path.',
  });

/** The recovery instruction shared by every malformed-root refusal. */
const PROJECT_ROOT_HINT =
  'Send the absolute path of the project folder, as VS Code reports it for the open workspace folder.';

/** The forward-slash prefix of a network (UNC) path once backslashes are converted. */
const NETWORK_PATH_PREFIX = '//';

/** A drive-letter root in its absolute form: the drive, a colon, then a separator. */
const DRIVE_ROOT = /^[A-Za-z]:\//;

/** The path segment that climbs to a parent directory. */
const PARENT_SEGMENT = '..';

/** The highest C0 control character; every code point up to it is refused. */
const LAST_C0_CONTROL = 0x1f;

/** The DEL control character, refused with the C0 range. */
const DELETE_CONTROL = 0x7f;

/**
 * Whether a string contains a C0 control character or DEL — NUL, CR, LF, tab,
 * escape and the rest. None belongs in a directory path a developer opened.
 *
 * @param value The string to scan.
 * @returns `true` when a control character occurs.
 */
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= LAST_C0_CONTROL || code === DELETE_CONTROL) {
      return true;
    }
  }
  return false;
}

/**
 * Builds the malformed-root refusal for `rejection`.
 *
 * @param rejection Why the root was refused.
 * @returns A `PATH_OUTSIDE_PROJECT` error whose message and hint are constant.
 */
function projectRootRefusal(rejection: ProjectRootRejection): DebuggenError {
  return new DebuggenError('PATH_OUTSIDE_PROJECT', PROJECT_ROOT_REJECTION_MESSAGES[rejection], {
    hint: PROJECT_ROOT_HINT,
    details: { reason: PROJECT_ROOT_INVALID_REASON, rejection },
  });
}

/**
 * Validates and normalises the project root a request names, before it is
 * checked against the principal's scope or handed to the launcher.
 *
 * The rules, in order:
 *
 * 1. no C0 control character or DEL, and no leading or trailing whitespace —
 *    the launcher trims what it is given, so a padded root would be
 *    scope-checked in one spelling and acted on in another;
 * 2. backslashes become forward slashes (`toPosix`), after which a root that
 *    opens with `//` is a network (UNC) path and is refused, as
 *    `requireProjectScope` would refuse it;
 * 3. no `..` segment: a root names the project folder itself, never a path
 *    that climbs out of one;
 * 4. absolute: a POSIX root must open with `/`. A drive-letter root
 *    (`C:/work/app`) is accepted only when `platform` is `win32` and the drive
 *    is followed by a separator; elsewhere it is a relative path, and a
 *    drive-relative `C:work` is not absolute anywhere;
 * 5. `normalizePosix` then collapses `.` segments, repeated separators and a
 *    trailing separator — exactly the spelling the launcher normalises to.
 *
 * @param projectRoot The root as the request body carried it (already
 *   schema-valid, so non-empty and bounded).
 * @param platform The platform whose path grammar applies.
 * @returns The normalised absolute root, or a `PATH_OUTSIDE_PROJECT` refusal
 *   with `details.reason` `project-root-invalid`; neither the message nor the
 *   details quote the submitted value.
 *
 * @example
 * normalizeRequestedProjectRoot('/work/./shop//', 'linux'); // ok('/work/shop')
 * normalizeRequestedProjectRoot('C:\\work\\shop', 'win32'); // ok('C:/work/shop')
 * normalizeRequestedProjectRoot('C:\\work\\shop', 'linux'); // err: drive-letter
 * normalizeRequestedProjectRoot('/work/../etc', 'linux'); // err: parent-segment
 */
export function normalizeRequestedProjectRoot(
  projectRoot: string,
  platform: NodeJS.Platform,
): Result<string, DebuggenError> {
  if (containsControlCharacter(projectRoot)) {
    return err(projectRootRefusal('control-character'));
  }
  if (projectRoot.trim() !== projectRoot) {
    return err(projectRootRefusal('padded'));
  }
  const posix = toPosix(projectRoot);
  if (posix.startsWith(NETWORK_PATH_PREFIX)) {
    return err(projectRootRefusal('network-path'));
  }
  if (posix.split('/').includes(PARENT_SEGMENT)) {
    return err(projectRootRefusal('parent-segment'));
  }
  if (isWindowsAbsolute(posix)) {
    if (platform !== 'win32') {
      return err(projectRootRefusal('drive-letter'));
    }
    if (!DRIVE_ROOT.test(posix)) {
      return err(projectRootRefusal('not-absolute'));
    }
  } else if (!isAbsolutePosix(posix)) {
    return err(projectRootRefusal('not-absolute'));
  }
  return ok(normalizePosix(posix));
}

/* -------------------------------------------------------------------------------------------------
 * Request bodies
 * ---------------------------------------------------------------------------------------------- */

/** A refused request body and the status it is answered with. */
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
 * crosses {@link MAX_DEV_SERVER_REQUEST_BODY_BYTES} while it is read, or does
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
  const reason = caught.details?.[REASON_DETAIL_KEY];
  return reason === GUARD_BODY_TOO_LARGE_REASON || reason === GUARD_BODY_READ_TIMEOUT_REASON
    ? reason
    : undefined;
}

/** The refusal of a body larger than {@link MAX_DEV_SERVER_REQUEST_BODY_BYTES}. */
function bodyTooLarge(label: RouteLabel): BodyRejection {
  return {
    status: 413,
    error: new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The ${label} request body is larger than this operation accepts.`,
      {
        hint: `Send a JSON body of at most ${String(MAX_DEV_SERVER_REQUEST_BODY_BYTES)} bytes.`,
        details: { operation: label, maxBytes: MAX_DEV_SERVER_REQUEST_BODY_BYTES },
      },
    ),
  };
}

/** The refusal of a body that did not arrive within `../http.ts`'s time ceiling. */
function bodyReadTimedOut(label: RouteLabel): BodyRejection {
  return {
    status: 408,
    error: new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The ${label} request body did not arrive in time.`,
      {
        hint: 'Send the whole JSON body at once, then wait for the reply.',
        details: { operation: label, reason: GUARD_BODY_READ_TIMEOUT_REASON },
      },
    ),
  };
}

/** The refusal of a body that is unreadable or not JSON; the body itself is never quoted. */
function bodyNotJson(label: RouteLabel, problem: 'unreadable' | 'not-json'): BodyRejection {
  const message =
    problem === 'unreadable'
      ? `The ${label} request body could not be read.`
      : `The ${label} request body is not valid JSON.`;
  return {
    status: 400,
    error: new DebuggenError('PROTOCOL_INVALID_MESSAGE', message, {
      hint: 'Send a JSON object as the request body.',
      details: { operation: label, problem },
    }),
  };
}

/**
 * Reads a request body as JSON, bounded by {@link MAX_DEV_SERVER_REQUEST_BODY_BYTES}.
 *
 * A declared `Content-Length` above the bound is refused before anything is
 * read. A body that declares no length (a chunked upload) is bounded while it
 * is read: `../http.ts`'s request-body guard errors the stream at the same
 * bound — and at its time ceiling — so `c.req.text()` rejects with the guard's
 * refusal instead of buffering an unbounded body, and that rejection is
 * answered `413` or `408` here. The text read is measured once more, which
 * keeps the bound for a handler composed without the guard. The text is read
 * through hono's cached accessor, so a body a middleware already consumed is
 * still available. An empty body reads as `undefined`, which every schema here
 * then refuses. `JSON.parse`'s own error is discarded, because its message
 * quotes the offending input.
 *
 * @param c The request context.
 * @param label The route the body belongs to, for the refusal message.
 * @returns The parsed value, or the refusal.
 */
async function readJsonBody(
  c: Context<ServerEnv>,
  label: RouteLabel,
): Promise<Result<unknown, BodyRejection>> {
  const declared = c.req.header(CONTENT_LENGTH_HEADER);
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_DEV_SERVER_REQUEST_BODY_BYTES) {
      return err(bodyTooLarge(label));
    }
  }

  let text: string;
  try {
    text = await c.req.text();
  } catch (caught) {
    const refusal = guardRefusalOf(caught);
    if (refusal === GUARD_BODY_TOO_LARGE_REASON) {
      return err(bodyTooLarge(label));
    }
    if (refusal === GUARD_BODY_READ_TIMEOUT_REASON) {
      return err(bodyReadTimedOut(label));
    }
    return err(bodyNotJson(label, 'unreadable'));
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_DEV_SERVER_REQUEST_BODY_BYTES) {
    return err(bodyTooLarge(label));
  }
  if (text.trim().length === 0) {
    return ok(undefined);
  }

  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch {
    return err(bodyNotJson(label, 'not-json'));
  }
}

/**
 * Reads and validates a protocol operation's request body through protocol's
 * own `parseHttpRequest` — the helper the client SDK validates its outbound
 * body with — so the service accepts exactly what a client can send.
 *
 * @typeParam O The operation.
 * @param c The request context.
 * @param operation The operation whose declared request schema applies.
 * @returns The validated body, or the refusal (`400`/`413`).
 */
async function readOperationRequest<O extends DevServerOperation>(
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

/**
 * The payload an error is answered with, checked against protocol's own
 * `httpErrorResponseSchema`: a payload the schema refuses (a message over its
 * bound, say) is replaced by the code with {@link DEV_SERVER_UNAVAILABLE_MESSAGE},
 * so no response here can be refused by a client's parser.
 *
 * @param payload The payload to send.
 * @returns A schema-valid payload.
 */
function boundedPayload(payload: HttpErrorResponse): HttpErrorResponse {
  return httpErrorResponseSchema.safeParse(payload).success
    ? payload
    : { code: payload.code, message: DEV_SERVER_UNAVAILABLE_MESSAGE };
}

/**
 * Logs an answered failure: constant text plus the route label, the status,
 * the error code and — when it has the loggable shape — the failure reason.
 * Neither the error's message, its hint nor its details are logged, since the
 * launcher's details may carry the dev server's output.
 *
 * @param log This module's logger.
 * @param label The route.
 * @param status The status answered.
 * @param error The failure.
 */
function logFailure(log: Logger, label: RouteLabel, status: number, error: DebuggenError): void {
  const reason = reasonOf(error);
  const fields = {
    operation: label,
    status,
    errorCode: error.code,
    ...(reason === undefined ? {} : { reason }),
  };
  if (status >= 500) {
    log.error('A dev-server request failed', fields);
  } else {
    log.warn('A dev-server request was refused', fields);
  }
}

/** Answers a refused body with protocol's error payload at the rejection's status. */
function answerBodyRejection(
  c: Context<ServerEnv>,
  rejection: BodyRejection,
  label: RouteLabel,
  log: Logger,
): Response {
  logFailure(log, label, rejection.status, rejection.error);
  return c.json(boundedPayload(toErrorPayload(rejection.error)), rejection.status);
}

/**
 * Answers any failure a handler meets after its body was read: an
 * access-boundary refusal, a malformed-root refusal or a launcher failure.
 *
 * - A refusal `../auth.ts` raised (role, scope, credential) is rendered by its
 *   own `authErrorResponse`, at the status its reason table fixes.
 * - A failure {@link STATUS_BY_CODE} answers is sent at its status with
 *   {@link describedMessageOf}'s message — the launcher's hint appended
 *   verbatim, or withheld when it quotes the dev server's output.
 * - Anything else is answered `500` with its code and
 *   {@link DEV_SERVER_UNAVAILABLE_MESSAGE}.
 *
 * @param c The request context.
 * @param error The failure.
 * @param label The route, for the log.
 * @param log This module's logger.
 * @returns The error response.
 */
function answerFailure(
  c: Context<ServerEnv>,
  error: DebuggenError,
  label: RouteLabel,
  log: Logger,
): Response {
  if (authFailureStatus(error) !== undefined) {
    const { status, body } = authErrorResponse(error);
    logFailure(log, label, status, error);
    return c.json(body, status);
  }
  const status = describedStatusOf(error);
  if (status === undefined) {
    logFailure(log, label, 500, error);
    const body: HttpErrorResponse = { code: error.code, message: DEV_SERVER_UNAVAILABLE_MESSAGE };
    return c.json(body, 500);
  }
  logFailure(log, label, status, error);
  const body: HttpErrorResponse = boundedPayload({
    code: error.code,
    message: describedMessageOf(error),
  });
  return c.json(body, status);
}

/**
 * Answers a response this module built that does not satisfy its contract with
 * a fixed `INTERNAL` payload. The offending value is never logged: for
 * `devServer.credential` it holds a token.
 *
 * @param c The request context.
 * @param label The route, for the log.
 * @param log This module's logger.
 * @returns The `500` response.
 */
function answerResponseDrift(c: Context<ServerEnv>, label: RouteLabel, log: Logger): Response {
  log.error('A dev-server response did not match its contract', {
    operation: label,
    status: 500,
    errorCode: 'INTERNAL',
  });
  const body: HttpErrorResponse = toErrorPayload(
    new DebuggenError('INTERNAL', RESPONSE_DRIFT_MESSAGE),
  );
  return c.json(body, 500);
}

/* -------------------------------------------------------------------------------------------------
 * The shared request steps: principal and role, project root and scope, fence, delegation
 * ---------------------------------------------------------------------------------------------- */

/** The dependencies every handler closes over, with their defaults applied. */
interface ResolvedDeps {
  readonly launcher: DevServerRoutesDeps['launcher'];
  readonly manager: DevServerRoutesDeps['manager'];
  readonly auth: DevServerRoutesDeps['auth'];
  readonly canonicalStateHome: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly log: Logger;
}

/**
 * The session step of a launch that names one: the session must exist, belong
 * to exactly the project being launched, and not have ended — a child tied to
 * a session of another project would be stopped by the wrong session's end,
 * and one tied to an ended session would have no owner left to stop it.
 *
 * Authorization is already settled by then: the project root was checked
 * against the principal's announced scope, and the session is required to be
 * that very project's, so a session outside the editor's workspace cannot be
 * named here.
 *
 * @param manager The session manager's read.
 * @param sessionId The session the body named.
 * @param projectRoot The normalised, scope-checked project root.
 * @returns The session's record when the launch may be tied to it, or the refusal.
 */
function sessionForLaunch(
  manager: DevServerRoutesDeps['manager'],
  sessionId: string,
  projectRoot: string,
): Result<SessionRecord, DebuggenError> {
  let loaded: Result<SessionRecord | undefined, DebuggenError>;
  try {
    loaded = manager.get(sessionId);
  } catch {
    return err(
      new DebuggenError('INTERNAL', DEV_SERVER_UNAVAILABLE_MESSAGE, {
        details: { reason: 'session-lookup-threw' },
      }),
    );
  }
  if (isErr(loaded)) {
    return loaded;
  }
  const record = loaded.value;
  if (record === undefined) {
    return err(
      new DebuggenError('SESSION_NOT_FOUND', 'The session this launch names does not exist.', {
        hint: 'Start a session first, or launch the dev server without naming a session.',
        details: { reason: 'unknown-session' },
      }),
    );
  }
  if (normalizePosix(toPosix(record.projectRoot)) !== projectRoot) {
    return err(
      new DebuggenError(
        'SESSION_INVALID_STATE',
        'The session this launch names belongs to a different project.',
        {
          hint: "Launch the dev server of the session's own project, or launch this project's dev server without naming a session.",
          details: { reason: 'session-project-mismatch' },
        },
      ),
    );
  }
  if (record.status === 'ended') {
    return err(
      new DebuggenError(
        'SESSION_INVALID_STATE',
        'The session this launch names has already ended.',
        {
          hint: 'Start a new session, then launch the dev server for it.',
          details: { reason: 'session-ended' },
        },
      ),
    );
  }
  return ok(record);
}

/**
 * The origin of a dev-server URL, or `undefined` when it does not parse. Two
 * spellings of one dev server (`http://127.0.0.1:3000` and
 * `http://127.0.0.1:3000/`) compare equal by origin, which is also what a tab
 * is bound by.
 */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined || url.length === 0) {
    return undefined;
  }
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Records where a session's launched dev server serves when that is another
 * origin than the one the session recorded — a session created against an
 * external server the editor configured, or one whose earlier child came back
 * on another port. The session's tab is bound by origin, so a stale address
 * would bind it to a server it does not own.
 *
 * Never fails the launch: the dev server runs either way. A record that could
 * not be updated is logged by code and the answer says so.
 *
 * @param manager The session manager.
 * @param session The session the launch was tied to, as it was read.
 * @param devServerUrl Where the launched dev server serves.
 * @param log This module's logger.
 * @returns Whether the session's recorded address was changed.
 */
async function recordLaunchedUrl(
  manager: DevServerRoutesDeps['manager'],
  session: SessionRecord,
  devServerUrl: string,
  log: Logger,
): Promise<boolean> {
  if (originOf(session.devServerUrl) === originOf(devServerUrl)) {
    return false;
  }
  let patched: Result<SessionRecord, DebuggenError>;
  try {
    patched = await manager.patch(session.id, { devServerUrl });
  } catch (error) {
    patched = err(DebuggenError.from(error, 'INTERNAL'));
  }
  if (isErr(patched)) {
    log.warn('The session could not record where its launched dev server serves', {
      operation: LAUNCH,
      errorCode: patched.error.code,
    });
    return false;
  }
  return true;
}

/**
 * The first step of every handler: the principal `../auth.ts`'s middleware
 * resolved, holding one of the roles `OPERATION_ROLES` grants `operation`.
 *
 * A missing principal means the route was registered without its middleware —
 * a composition defect — and is refused `401` rather than served. The role is
 * checked before the body is read.
 *
 * @param c The request context.
 * @param operation The protocol operation whose roles apply.
 * @param label The route, for the log.
 * @param log This module's logger.
 * @returns The principal, or the response that refuses the request.
 */
function authorize(
  c: Context<ServerEnv>,
  operation: DevServerOperation,
  label: RouteLabel,
  log: Logger,
): Result<Principal, Response> {
  const principal: Principal | undefined = c.get('principal');
  if (principal === undefined) {
    log.error('A dev-server route ran without a resolved principal', { operation: label });
    return err(answerFailure(c, refusalFor('missing-credential'), label, log));
  }
  const roles: readonly PrincipalRole[] = OPERATION_ROLES[operation];
  const permitted = requireRole(principal, ...roles);
  if (isErr(permitted)) {
    return err(answerFailure(c, permitted.error, label, log));
  }
  return ok(principal);
}

/**
 * The project-root step of a stop and of a credential request: the requested
 * root, normalised by {@link normalizeRequestedProjectRoot}, inside the
 * principal's announced scope (`requireProjectScope`). The returned spelling
 * is the one the scope was checked in and the one the launcher must be
 * handed. Neither operation acts on the project's files, so the scope is
 * checked once; a launch, which spawns in the directory, is admitted by
 * {@link admittedLaunchRoot} instead.
 *
 * @param c The request context.
 * @param principal The authorized principal.
 * @param projectRoot The root the body named.
 * @param label The route, for the log.
 * @param deps The resolved dependencies.
 * @returns The normalised root, or the response that refuses the request.
 */
function scopedProjectRoot(
  c: Context<ServerEnv>,
  principal: Principal,
  projectRoot: string,
  label: RouteLabel,
  deps: ResolvedDeps,
): Result<string, Response> {
  const normalized = normalizeRequestedProjectRoot(projectRoot, deps.platform);
  if (isErr(normalized)) {
    return err(answerFailure(c, normalized.error, label, deps.log));
  }
  const scoped = requireProjectScope(principal, normalized.value);
  if (isErr(scoped)) {
    return err(answerFailure(c, scoped.error, label, deps.log));
  }
  return ok(normalized.value);
}

/** A launch's project root: the spelling it is handed on in, and the proof it was admitted with. */
interface AdmittedLaunchRoot {
  /**
   * The root normalised by {@link normalizeRequestedProjectRoot}: the spelling
   * the session check compares and the launcher is handed — its registry key,
   * credential scope and `DEBUGGEN_PROJECT_ROOT`.
   */
  readonly projectRoot: string;
  /**
   * What `admitProjectRoot` returned: the root and the canonical path it was
   * admitted under, which {@link requireAdmittedRootUnchanged} and the
   * launcher's confirmation re-prove before the launch acts on it.
   */
  readonly admitted: AdmittedProjectRoot;
}

/**
 * The project-root step of a launch: the requested root, normalised by
 * {@link normalizeRequestedProjectRoot}, admitted to the principal's announced
 * scope by `admitProjectRoot` — the rule `requireProjectScope` applies, on
 * disk as well as in spelling — which also returns the canonical path the
 * root was admitted under.
 *
 * A launch acts on the directory only after many awaits (the state-root
 * check, the launcher's detection and credential minting), so that identity
 * is kept: the handler re-proves it at its fence
 * ({@link requireAdmittedRootUnchanged}) and hands the launcher the same
 * re-proof, which it runs immediately before detection reads the project and
 * again immediately before it spawns the child in the canonical root. A link
 * on the path retargeted after admission is refused rather than followed.
 *
 * @param c The request context.
 * @param principal The authorized principal.
 * @param projectRoot The root the body named.
 * @param label The route, for the log.
 * @param deps The resolved dependencies.
 * @returns The normalised root and its admission, or the response that
 * refuses the request (`403` for a root outside the principal's scope).
 */
function admittedLaunchRoot(
  c: Context<ServerEnv>,
  principal: Principal,
  projectRoot: string,
  label: RouteLabel,
  deps: ResolvedDeps,
): Result<AdmittedLaunchRoot, Response> {
  const normalized = normalizeRequestedProjectRoot(projectRoot, deps.platform);
  if (isErr(normalized)) {
    return err(answerFailure(c, normalized.error, label, deps.log));
  }
  const admitted = admitProjectRoot(principal, normalized.value);
  if (isErr(admitted)) {
    return err(answerFailure(c, admitted.error, label, deps.log));
  }
  return ok({ projectRoot: normalized.value, admitted: admitted.value });
}

/**
 * The project-root half of a launch's fence: the admitted root must still be
 * in the principal's scope and still resolve to the canonical path it was
 * admitted under (`reconfirmProjectRoot`). Synchronous, and called beside
 * {@link requireLive} with no `await` between it and the launcher call.
 *
 * A root that moved — a link on its path retargeted since admission, inside
 * the workspace or out of it — or left the scope is refused `403` by
 * `authErrorResponse` through {@link answerFailure}. A check that throws is
 * answered `500`: the fence fails closed, and the thrown value is not kept.
 *
 * @param c The request context.
 * @param principal The principal the root was admitted for.
 * @param admitted What `admitProjectRoot` returned for the root.
 * @param label The route, for the log.
 * @param deps The resolved dependencies.
 * @returns `ok`, or the response that refuses the request.
 */
function requireAdmittedRootUnchanged(
  c: Context<ServerEnv>,
  principal: Principal,
  admitted: AdmittedProjectRoot,
  label: RouteLabel,
  deps: ResolvedDeps,
): Result<void, Response> {
  let still: Result<AdmittedProjectRoot, DebuggenError>;
  try {
    still = reconfirmProjectRoot(principal, admitted);
  } catch {
    still = err(
      new DebuggenError('INTERNAL', DEV_SERVER_UNAVAILABLE_MESSAGE, {
        details: { reason: 'project-root-check-threw' },
      }),
    );
  }
  if (isErr(still)) {
    return err(answerFailure(c, still.error, label, deps.log));
  }
  return ok(undefined);
}

/**
 * The state-root step of a launch and of a credential request: the project
 * root must not be, contain or lie inside `$DEBUGGEN_HOME` (see
 * {@link DevServerRoutesDeps.canonicalStateHome}). Awaits the
 * canonicalisation, so both handlers run it before their revocation fence.
 *
 * A refusal of `requireProjectOutsideStateHome` is answered `400` with its own
 * constant message and hint — sentences that name no path — through
 * {@link describedMessageOf}. `FS_UNSAFE_PATH` is deliberately absent from
 * {@link STATUS_BY_CODE}: the launcher's detector raises it with a message
 * that quotes a manifest path, which stays opaque. Without a canonical state
 * root no check is made.
 *
 * @param c The request context.
 * @param projectRoot The project root to judge: for a launch, the canonical
 * path it was admitted under; for a credential request, the normalised,
 * scope-checked root.
 * @param label The route, for the log.
 * @param deps The resolved dependencies.
 * @returns `ok`, or the response that refuses the request.
 */
async function keepApartFromStateHome(
  c: Context<ServerEnv>,
  projectRoot: string,
  label: RouteLabel,
  deps: ResolvedDeps,
): Promise<Result<void, Response>> {
  const stateHome = deps.canonicalStateHome;
  if (stateHome === undefined) {
    return ok(undefined);
  }
  const checked = await delegate(() => requireProjectOutsideStateHome(stateHome, projectRoot));
  if (!isErr(checked)) {
    return ok(undefined);
  }
  const { error } = checked;
  const reason = reasonOf(error);
  if (
    error.code !== 'FS_UNSAFE_PATH' ||
    reason === undefined ||
    !STATE_HOME_REFUSAL_REASONS.has(reason)
  ) {
    return err(answerFailure(c, error, label, deps.log));
  }
  logFailure(deps.log, label, STATE_HOME_REFUSAL_STATUS, error);
  const body: HttpErrorResponse = boundedPayload({
    code: error.code,
    message: describedMessageOf(error),
  });
  return err(c.json(body, STATE_HOME_REFUSAL_STATUS));
}

/**
 * The revocation fence of every handler: the credential the principal was
 * resolved from must still be live after the body was read
 * (`AuthService.requireLiveCredential`). Synchronous, and every handler calls
 * it immediately before its launcher call with no `await` in between — the
 * ordering the module documentation's atomicity argument rests on.
 *
 * A retired or expired credential is answered by `authErrorResponse` at `401`
 * through {@link answerFailure}, exactly like the middleware's own refusal. A
 * store that cannot be read, or a fence that throws, is answered `500`: the
 * fence fails closed and never lets the launcher run on a credential it could
 * not confirm.
 *
 * @param c The request context.
 * @param principal The principal the middleware resolved.
 * @param label The route, for the log.
 * @param deps The resolved dependencies.
 * @returns `ok`, or the response that refuses the request.
 */
function requireLive(
  c: Context<ServerEnv>,
  principal: Principal,
  label: RouteLabel,
  deps: ResolvedDeps,
): Result<void, Response> {
  let live: Result<void, DebuggenError>;
  try {
    live = deps.auth.requireLiveCredential(principal);
  } catch {
    // The thrown value is not kept: nothing below promises it is free of
    // credential material.
    live = err(
      new DebuggenError('INTERNAL', DEV_SERVER_UNAVAILABLE_MESSAGE, {
        details: { reason: 'credential-check-threw' },
      }),
    );
  }
  if (isErr(live)) {
    return err(answerFailure(c, live.error, label, deps.log));
  }
  return ok(undefined);
}

/**
 * Runs one launcher call, turning a rejection into an `INTERNAL` failure.
 *
 * The launcher's operations report every failure as a `Result` and never
 * reject; this guard keeps that a property of this module's responses too, so
 * a defect below answers protocol's error payload instead of escaping to the
 * framework. The thrown value is not kept: its message could quote anything.
 *
 * @typeParam T The call's success value.
 * @param call The launcher call.
 * @returns The call's own result, or an `INTERNAL` failure.
 */
async function delegate<T>(
  call: () => Promise<Result<T, DebuggenError>>,
): Promise<Result<T, DebuggenError>> {
  try {
    return await call();
  } catch {
    return err(
      new DebuggenError('INTERNAL', DEV_SERVER_UNAVAILABLE_MESSAGE, {
        details: { reason: 'launcher-rejected' },
      }),
    );
  }
}

/* -------------------------------------------------------------------------------------------------
 * The routes
 * ---------------------------------------------------------------------------------------------- */

/**
 * `POST /dev-server/launch`: make sure the project's dev server runs with the
 * telemetry preload, and answer where it serves and which process it is.
 *
 * Whether a preload-attached server is already running, whether to probe and
 * whether to spawn is the launcher's decision (through `detect.ts`); this
 * handler only authorizes, validates and delegates. A dev server that already
 * serves the project without the preload is answered `409`
 * (`SERVER_AGENT_NOT_READY`) with the detector's exact, token-free relaunch
 * command in the message.
 */
function createLaunchHandler(deps: ResolvedDeps): DevServerRouteHandler {
  const { launcher, log } = deps;
  return async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const principal = authorize(c, LAUNCH, LAUNCH, log);
    if (isErr(principal)) {
      return principal.error;
    }
    const request = await readOperationRequest(c, LAUNCH);
    if (isErr(request)) {
      return answerBodyRejection(c, request.error, LAUNCH, log);
    }
    const root = admittedLaunchRoot(c, principal.value, request.value.projectRoot, LAUNCH, deps);
    if (isErr(root)) {
      return root.error;
    }
    const { projectRoot, admitted } = root.value;
    // Judged on the directory actually admitted, not on the links of its spelling.
    const apart = await keepApartFromStateHome(c, admitted.canonicalRoot, LAUNCH, deps);
    if (isErr(apart)) {
      return apart.error;
    }
    const { command, sessionId } = request.value;
    let owner: SessionRecord | undefined;
    if (sessionId !== undefined) {
      const found = sessionForLaunch(deps.manager, sessionId, projectRoot);
      if (isErr(found)) {
        return answerFailure(c, found.error, LAUNCH, log);
      }
      owner = found.value;
    }
    // The address detection probes before anything is spawned: the one the
    // editor configured, else the one the named session recorded. The schema
    // checked its shape only; detection's own probe dials nothing but a
    // loopback address. A server already answering there is never duplicated
    // on its port — the launcher reuses its own child and refuses any other
    // with the relaunch command (AAP §0.5.5).
    const requestedUrl = request.value.devServerUrl;
    const recordedUrl =
      owner?.devServerUrl === undefined || owner.devServerUrl.length === 0
        ? undefined
        : owner.devServerUrl;
    const devServerUrl = requestedUrl ?? recordedUrl;

    // The fence of initiation: nothing between it and the launcher call awaits.
    // The credential must still be live, and the root still the directory it
    // was admitted as; the launcher re-proves the root once more immediately
    // before it spawns, and spawns in the canonical root.
    const live = requireLive(c, principal.value, LAUNCH, deps);
    if (isErr(live)) {
      return live.error;
    }
    const unchanged = requireAdmittedRootUnchanged(c, principal.value, admitted, LAUNCH, deps);
    if (isErr(unchanged)) {
      return unchanged.error;
    }
    const launched = await delegate(() =>
      launcher.launch({
        projectRoot,
        confirmProjectRoot: () => reconfirmProjectRoot(principal.value, admitted),
        ...(command === undefined ? {} : { command }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(devServerUrl === undefined ? {} : { devServerUrl }),
      }),
    );
    if (isErr(launched)) {
      return answerFailure(c, launched.error, LAUNCH, log);
    }
    const response = toDevServerLaunchResponse(launched.value);
    if (response === undefined) {
      // An unmanaged server has no pid this service can stop. The launcher
      // attributes a preload only to a child it launched itself — which it
      // reuses before detecting anything — so reaching here is a
      // launcher/contract drift.
      return answerResponseDrift(c, LAUNCH, log);
    }
    const checked = parseHttpResponse(LAUNCH, response);
    if (isErr(checked)) {
      return answerResponseDrift(c, LAUNCH, log);
    }
    const addressUpdated =
      owner === undefined
        ? false
        : await recordLaunchedUrl(deps.manager, owner, checked.value.devServerUrl, log);
    log.info('Answered a dev-server launch', {
      operation: LAUNCH,
      status: 200,
      pid: checked.value.pid,
      sessionNamed: sessionId !== undefined,
      addressRequested: requestedUrl !== undefined,
      sessionAddressUpdated: addressUpdated,
    });
    return c.json(checked.value, 200);
  };
}

/**
 * `POST /dev-server/stop`: stop the dev server the service launched for the
 * project. The launcher signals the child (`SIGTERM`, then `SIGKILL`) and
 * revokes its server-agent credential; nothing here signals or revokes. A
 * project with no launched server answers `200 { stopped: false }` — stopping
 * is idempotent, never a failure. A stop whose credential revocation is still
 * pending is answered `500` `CLEANUP_PARTIAL` rather than a clean `200`, and a
 * repeated stop retries the revocation before it answers.
 */
function createStopHandler(deps: ResolvedDeps): DevServerRouteHandler {
  const { launcher, log } = deps;
  return async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const principal = authorize(c, STOP, STOP, log);
    if (isErr(principal)) {
      return principal.error;
    }
    const request = await readOperationRequest(c, STOP);
    if (isErr(request)) {
      return answerBodyRejection(c, request.error, STOP, log);
    }
    const projectRoot = scopedProjectRoot(
      c,
      principal.value,
      request.value.projectRoot,
      STOP,
      deps,
    );
    if (isErr(projectRoot)) {
      return projectRoot.error;
    }

    // The fence of initiation: nothing between it and the launcher call awaits.
    const live = requireLive(c, principal.value, STOP, deps);
    if (isErr(live)) {
      return live.error;
    }
    const stopped = await delegate(() => launcher.stop({ projectRoot: projectRoot.value }));
    if (isErr(stopped)) {
      return answerFailure(c, stopped.error, STOP, log);
    }
    const checked = parseHttpResponse(STOP, { stopped: stopped.value.stopped });
    if (isErr(checked)) {
      return answerResponseDrift(c, STOP, log);
    }
    log.info('Answered a dev-server stop', {
      operation: STOP,
      status: 200,
      stopped: checked.value.stopped,
    });
    return c.json(checked.value, 200);
  };
}

/**
 * `POST /dev-server/credential`: mint the `server-agent` credential a dev
 * server the caller starts itself presents on ingest.
 *
 * The launcher mints it through the `ServerAgentCredentialIssuer` port that
 * `../auth.ts` satisfies — role `server-agent`, scoped to exactly the one
 * normalised project root this handler scope-checked, stored only as a hash.
 * The credential is a lease the launcher supervises: it renews it while the
 * dev server's preload holds its `server-agent` control connection, and
 * revokes it 20 seconds after that connection is gone, at the end of the first
 * lease when no preload connected with it, and when the service shuts down; a
 * lease nothing renews any more lapses within five minutes. The response's
 * `expiresAt` is the end of the first lease. The token's plaintext leaves the
 * service in this response body and nowhere else: it is never logged, written
 * to the store or repeated. The store keeps only its hash, and the launcher
 * holds the plaintext in memory, in the lease it supervises, until the
 * credential is revoked or lapses.
 */
function createCredentialHandler(deps: ResolvedDeps): DevServerRouteHandler {
  const { launcher, log } = deps;
  return async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const principal = authorize(c, CREDENTIAL, CREDENTIAL, log);
    if (isErr(principal)) {
      return principal.error;
    }
    const request = await readOperationRequest(c, CREDENTIAL);
    if (isErr(request)) {
      return answerBodyRejection(c, request.error, CREDENTIAL, log);
    }
    // Protocol's schema checks the body's shape only; the root's form —
    // absolute, no traversal, no padding — is checked here, before the scope,
    // exactly as for a launch or a stop, and the launcher re-checks it.
    const projectRoot = scopedProjectRoot(
      c,
      principal.value,
      request.value.projectRoot,
      CREDENTIAL,
      deps,
    );
    if (isErr(projectRoot)) {
      return projectRoot.error;
    }
    const apart = await keepApartFromStateHome(c, projectRoot.value, CREDENTIAL, deps);
    if (isErr(apart)) {
      return apart.error;
    }

    // The fence, end to end: `delegate` invokes `issueCredential` at once, and
    // it runs synchronously through the issuer to the server-agent row's
    // insert. With no await in between, a rotation either ran before this
    // check (refused here) or runs after the insert (and deletes the row).
    const live = requireLive(c, principal.value, CREDENTIAL, deps);
    if (isErr(live)) {
      return live.error;
    }
    const issued = await delegate(() =>
      launcher.issueCredential({ projectRoot: projectRoot.value }),
    );
    if (isErr(issued)) {
      return answerFailure(c, issued.error, CREDENTIAL, log);
    }
    const checked = parseHttpResponse(CREDENTIAL, issued.value);
    if (isErr(checked)) {
      return answerResponseDrift(c, CREDENTIAL, log);
    }
    log.info('Issued a server-agent credential', {
      operation: CREDENTIAL,
      status: 200,
      expiresAt: checked.value.expiresAt,
    });
    return c.json(checked.value, 200);
  };
}

/**
 * Builds the dev-server routes: the `devServer.launch`, `devServer.stop` and
 * `devServer.credential` handlers for protocol's table.
 *
 * Registers nothing, opens nothing and holds no state beyond its dependencies.
 * `../http.ts` registers each handler at `HTTP_ROUTES[operation].method` /
 * `.pattern` behind the auth middleware for that same operation.
 *
 * Status codes, all with protocol's `httpErrorResponseSchema` body on failure:
 *
 * | Outcome | launch | stop | credential |
 * | --- | --- | --- | --- |
 * | success | `200 { devServerUrl, pid }` | `200 { stopped }` | `200 { token, expiresAt }` |
 * | no credential / wrong role | `401` / `403` | `401` / `403` | `401` / `403` |
 * | credential retired or expired while the body was read | `401` | `401` | `401` |
 * | body off-schema / malformed root | `400` | `400` | `400` |
 * | body too large, declared or as it arrives | `413` | `413` | `413` |
 * | body not arrived within `../http.ts`'s time ceiling | `408` | `408` | `408` |
 * | project outside the editor's workspace folders | `403` | `403` | `403` |
 * | project root is, contains or lies inside `$DEBUGGEN_HOME`, or cannot be resolved on disk | `400` | — | `400` |
 * | project root is not a directory | `404` | — | — |
 * | running without the preload / no dev script / cancelled | `409` | — | — |
 * | spawn failed / exited before ready | `502` | — | — |
 * | preload missing / service shutting down | `503` | — | — |
 * | readiness timeout | `504` | — | — |
 * | store, configuration or internal failure | `500` | `500` | `500` |
 *
 * @param deps The launcher slice, the revocation fence, the platform and the logger.
 * @returns The frozen table handlers, keyed by operation id.
 *
 * @example
 * const devServer = createDevServerRoutes({ launcher, auth, logger });
 * for (const operation of DEV_SERVER_OPERATIONS) {
 *   const route = HTTP_ROUTES[operation];
 *   app.on(route.method, route.pattern, authFor(operation), devServer.handlers[operation]);
 * }
 */
export function createDevServerRoutes(deps: DevServerRoutesDeps): DevServerRoutes {
  const resolved: ResolvedDeps = {
    launcher: deps.launcher,
    manager: deps.manager,
    auth: deps.auth,
    canonicalStateHome: deps.canonicalStateHome,
    platform: deps.platform ?? process.platform,
    log: subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM),
  };

  const handlers: DevServerRouteHandlers = Object.freeze({
    [LAUNCH]: createLaunchHandler(resolved),
    [STOP]: createStopHandler(resolved),
    [CREDENTIAL]: createCredentialHandler(resolved),
  });
  return Object.freeze({ handlers });
}
