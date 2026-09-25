/**
 * The session slice of the local service's HTTP surface: the ten operations
 * of protocol's route table that create, list, reopen, question, capture, end
 * and read a debugging session (AAP §0.4.2).
 *
 * | Operation | Route | Answer |
 * | --- | --- | --- |
 * | `session.create` | `POST /sessions` | the created `SessionRecord` |
 * | `session.list` | `GET /sessions` | `{ sessions: SessionRecord[] }` |
 * | `session.get` | `GET /sessions/:id` | the (reopened) `SessionRecord` |
 * | `session.question` | `POST /sessions/:id/question` | the `SessionRecord` holding the follow-up |
 * | `session.end` | `POST /sessions/:id/end` | `{ cleanup: CleanupStatus }` |
 * | `capture.start` | `POST /sessions/:id/capture/start` | `{ captureId }`, or `409 { owningSessionId }` |
 * | `capture.stop` | `POST /sessions/:id/capture/stop` | `{ summary }` |
 * | `panel.get` | `GET /sessions/:id/panel` | `{ panel: PanelSpec \| null }` |
 * | `panel.getById` | `GET /sessions/:id/panels/:panelId` | `{ panel: PanelSpec }`, or `404` |
 * | `modifications.list` | `GET /sessions/:id/modifications` | `{ modifications: ModificationRecord[] }` |
 *
 * Every path, parameter name, body schema and response schema is read from
 * protocol's `HTTP_ROUTES`; nothing here restates one.
 *
 * ## Authorization, validation, delegation — and nothing else
 *
 * Every hard decision already has an owner, and this module defers to it:
 *
 * - **Status writes and lifecycle broadcasts** — `session.created`,
 *   `session.updated`, `capture.started`, `capture.stopped`,
 *   `cleanup.completed` — belong to `../../sessions/manager.ts`. This module
 *   writes no status, touches no state machine and broadcasts nothing.
 * - **Stage sequencing**, `session.progress`, both follow-up paths and the
 *   readiness gate belong to `../../pipeline/orchestrator.ts`.
 * - **The replay of a reopened session** belongs to
 *   `../../sessions/reopen.ts`.
 * - **Cleanup** runs inside `SessionManager.end` through its injected runner;
 *   this module never imports the cleanup module and never reports a cleanup
 *   status it did not receive.
 * - **Panel validation** happened before a panel was stored; a stored panel is
 *   served exactly as stored, a `meta.fallback` panel included.
 *
 * What remains here is the request boundary, applied in a fixed order so a
 * caller that fails an early step learns nothing about a later one:
 *
 * 1. the principal `../auth.ts`'s middleware resolved must hold a role
 *    `OPERATION_ROLES` grants the operation — a `server-agent` credential never
 *    reaches a session route;
 * 2. the `:id` (and `:panelId`) path parameters, named by the route table, must
 *    have the shape of the ids `@debuggen/shared` mints;
 * 3. a `devtools` principal must act through the tab binding its own credential
 *    made (`requireBoundSession`), checked **before** the store is read;
 * 4. the session must exist, and the per-session access matrix must admit the
 *    principal (`requireSessionAccess`: an editor by the workspace folders it
 *    announced, a DevTools client by its binding);
 * 5. a `POST` body must satisfy the operation's request schema through
 *    `parseHttpRequest`, bounded in size before it is parsed;
 * 6. the owning subsystem is called;
 * 7. its answer is checked against the operation's response schema through
 *    `parseHttpResponse` and sent unchanged.
 *
 * Authorization comes from the resolved principal only — never from a body
 * field, a header the client controls or a client's description of itself.
 *
 * ## When each operation answers
 *
 * Several operations start work that outlives a sensible request — indexing a
 * project, a model stage, analysis and panel generation. Each answers as soon
 * as the effect the caller asked for is **recorded**, and the rest of the work
 * reports itself through the frames its owners broadcast:
 *
 * - `session.create` answers with the created record the moment it is stored,
 *   and starts `PipelineOrchestrator.run` without awaiting it; the understand →
 *   investigate → plan → install sequence reaches clients as `session.progress`
 *   and `session.updated`. A run that is refused before it moved the session —
 *   the service shutting down, say — would leave a half-created session, so
 *   that session is filed `failed` at the first stage through
 *   `SessionManager.fail`, with the refusal's own code and message.
 * - `session.question` starts `PipelineOrchestrator.followUp` and answers once
 *   the follow-up stage has recorded the question on the session (it records
 *   it itself, which is why this module never calls `appendFollowUp`: the
 *   question would be stored twice). A refusal that comes first — a session in
 *   a status no follow-up starts from, another operation in flight — is
 *   answered as the error it is. Which of the two follow-up paths runs is the
 *   orchestrator's decision; a client learns it from the frames that follow.
 * - `capture.stop` starts `PipelineOrchestrator.completeCapture` and answers
 *   with the capture's summary as soon as the capture window is closed and its
 *   summary stored, while analysis and panel generation continue and announce
 *   themselves with `analysis.completed`, `panel.generated` and
 *   `session.updated`. That keeps the "Stop capture" transition instant for
 *   the DevTools panel, whose service worker gives up on a request after twenty
 *   seconds. A capture that collected nothing stores no summary; its reply is
 *   the orchestrator's own, which is quick because analysis is skipped and the
 *   session is already back at `ready` (AAP §0.5.5) — an empty capture is a
 *   success with `eventCount: 0`, never an error. A stop with no open capture
 *   (a resumed analysis, or a refusal) awaits the orchestrator's answer.
 * - `session.end` first cancels an operation in flight for the session and
 *   waits, bounded, for it to settle — cleanup must not race an installer that
 *   is still writing a patch — then awaits `SessionManager.end`, whose runner
 *   restores every modification and whose verdict is answered verbatim.
 *   `conflict` is a fully reported success, not an error (AAP §0.5.1). An
 *   operation that does not settle within the bound is answered `409` and
 *   ending again retries; nothing is skipped.
 *
 * Work that continues after a reply never rejects unobserved: its outcome is
 * logged by code, and a failure of it is filed on the session by the
 * orchestrator itself.
 *
 * ## Finding the session's dev server
 *
 * A session records its project's dev-server URL, and protocol's
 * `session.create` body deliberately carries none: the service knows it for
 * itself. {@link SessionDevServerLookup} is asked first — in production the
 * launcher's registry of the dev servers it started, adapted by
 * {@link devServerLookupFromLaunches} — and when it knows none, the URL the
 * project's most recent earlier session recorded is reused. When neither
 * knows one, `SessionManager.create` refuses the session with
 * `DEV_SERVER_UNAVAILABLE` rather than store an invented address, and the
 * reply is `503` with the manager's instruction to start or launch the dev
 * server.
 *
 * ## Failures (AAP §0.5.5)
 *
 * A failure is never dressed up as a success, and every non-2xx answer carries
 * protocol's error body — `{ code, message }`, validated against
 * `httpErrorResponseSchema`:
 *
 * | Outcome | Status | Code |
 * | --- | --- | --- |
 * | no resolved principal (composition defect) | `401` | `UNAUTHORIZED` |
 * | role not permitted (a `server-agent` credential, a DevTools create) | `403` | `UNAUTHORIZED` |
 * | DevTools client not bound to the session | `403` | `TAB_NOT_BOUND` |
 * | editor credential outside its announced workspace | `403` | `PATH_OUTSIDE_PROJECT` |
 * | malformed or unknown session id | `404` | `SESSION_NOT_FOUND` |
 * | malformed or unknown panel id, or a panel of another session | `404` | `SESSION_NOT_FOUND` |
 * | project root that is not absolute | `400` | `PROJECT_NOT_FOUND` |
 * | body larger than the operation's bound | `413` | `PROTOCOL_INVALID_MESSAGE` |
 * | unreadable, non-JSON or off-schema body | `400` | `PROTOCOL_INVALID_MESSAGE` |
 * | another session holds the project's capture | `409` | `CAPTURE_ALREADY_ACTIVE`, plus `owningSessionId` |
 * | a request the session's state does not admit, a busy pipeline | `409` | `SESSION_INVALID_STATE` |
 * | a stage's model, plan, panel or patch output refused | `422` | the stage's code |
 * | no dev-server URL, the model provider or a signal unavailable | `503` | the failure's code |
 * | store failure, cleanup failure, subsystem defect, response drift | `500` | the failure's code, fixed message |
 *
 * The capture-ownership `409` is rendered here, in exactly one place: the
 * manager's typed {@link CaptureConflictError} is recognised with
 * `isCaptureConflict` and answered with `captureStartConflictResponseSchema`,
 * `owningSessionId` intact. A session asking for a second capture of its own is
 * a plain `SESSION_INVALID_STATE` `409` without an owning session, exactly as
 * protocol describes.
 *
 * Validation messages come from `parseHttpRequest`, which renders issue paths
 * and codes through `describeZodIssues` and never a rejected value. A `500`
 * never carries the failure's own words. Log records carry the operation, a
 * status, an error code, a kebab-case reason and counts — never a question, a
 * project path, a diff, a panel, a capture summary, a header or a token. Every
 * response carries `Cache-Control: no-store`, and no
 * `Access-Control-Allow-Origin` header is ever set.
 *
 * ## What this module does not do
 *
 * It registers nothing, builds no hono application, opens no socket, database
 * or child process, reads no `process.env` and holds no state between requests.
 * It returns its handlers keyed by operation id for `../http.ts` to register
 * from protocol's route table behind the auth middleware; every collaborator
 * arrives by injection from `main.ts` through `../http.ts`.
 *
 * @example
 * ```ts
 * const sessionRoutes = createSessionRoutes({
 *   manager,
 *   reopener,
 *   orchestrator,
 *   sessions: sessionsRepo,
 *   panels: panelsRepo,
 *   modifications: modificationsRepo,
 *   bindings: clients,
 *   devServers: devServerLookupFromLaunches(launcher),
 *   logger,
 * });
 * const authFor = createAuthMiddleware(auth);
 * for (const operation of SESSION_ROUTE_OPERATIONS) {
 *   const { method, pattern } = HTTP_ROUTES[operation];
 *   app.on(method, pattern, authFor(operation), sessionRoutes[operation]);
 * }
 * ```
 *
 * @module
 */

import type { Context, Handler } from 'hono';

import {
  HTTP_ROUTES,
  captureStartConflictResponseSchema,
  httpErrorResponseSchema,
  parseHttpRequest,
  parseHttpResponse,
  toErrorPayload,
} from '@debuggen/protocol';
import type {
  CaptureStartConflictResponse,
  CaptureSummary,
  HttpErrorResponse,
  HttpRequestBody,
  HttpResponseBody,
  PanelSpec,
  ProgressStage,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import {
  DebuggenError,
  ID_PREFIXES,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  noopLogger,
  normalizePosix,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result, SessionId } from '@debuggen/shared';

import { sessionLogger, subsystemLogger } from '../../logging.js';
import type { PipelineOrchestrator } from '../../pipeline/orchestrator.js';
import { isCaptureConflict } from '../../sessions/manager.js';
import type { CaptureConflictError, SessionManager } from '../../sessions/manager.js';
import type { SessionReopener } from '../../sessions/reopen.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import type { ModificationsRepo } from '../../store/modifications-repo.js';
import type { PanelsRepo } from '../../store/panels-repo.js';
import { MAX_SESSION_LIST_LIMIT } from '../../store/sessions-repo.js';
import type { SessionsRepo } from '../../store/sessions-repo.js';
import {
  AUTH_FAILURE_REASONS,
  OPERATION_ROLES,
  authErrorResponse,
  authFailureStatus,
  requireBoundSession,
  requireProjectScope,
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
 * The operations this module owns
 * ---------------------------------------------------------------------------------------------- */

/** `POST /sessions`, read from the one route table rather than restated. */
const CREATE_ROUTE = HTTP_ROUTES['session.create'];
/** `GET /sessions`. */
const LIST_ROUTE = HTTP_ROUTES['session.list'];
/** `GET /sessions/:id`. */
const GET_ROUTE = HTTP_ROUTES['session.get'];
/** `POST /sessions/:id/question`. */
const QUESTION_ROUTE = HTTP_ROUTES['session.question'];
/** `POST /sessions/:id/end`. */
const END_ROUTE = HTTP_ROUTES['session.end'];
/** `POST /sessions/:id/capture/start`. */
const CAPTURE_START_ROUTE = HTTP_ROUTES['capture.start'];
/** `POST /sessions/:id/capture/stop`. */
const CAPTURE_STOP_ROUTE = HTTP_ROUTES['capture.stop'];
/** `GET /sessions/:id/panel`. */
const PANEL_ROUTE = HTTP_ROUTES['panel.get'];
/** `GET /sessions/:id/panels/:panelId`. */
const PANEL_BY_ID_ROUTE = HTTP_ROUTES['panel.getById'];
/** `GET /sessions/:id/modifications`. */
const MODIFICATIONS_ROUTE = HTTP_ROUTES['modifications.list'];

/*
 * The operation ids the handlers are filed under, each derived from its route
 * table row so the key `../http.ts` looks up cannot drift from it.
 * `satisfies AuthenticatedOperation` is the compile-time proof that protocol
 * still requires a bearer credential for every one of them: were the table
 * ever to flag one exempt, its line would stop compiling rather than its
 * handler running without a principal.
 */

/** `session.create`. */
export const SESSION_CREATE_OPERATION = CREATE_ROUTE.operation satisfies AuthenticatedOperation;
/** `session.list`. */
export const SESSION_LIST_OPERATION = LIST_ROUTE.operation satisfies AuthenticatedOperation;
/** `session.get`. */
export const SESSION_GET_OPERATION = GET_ROUTE.operation satisfies AuthenticatedOperation;
/** `session.question`. */
export const SESSION_QUESTION_OPERATION = QUESTION_ROUTE.operation satisfies AuthenticatedOperation;
/** `session.end`. */
export const SESSION_END_OPERATION = END_ROUTE.operation satisfies AuthenticatedOperation;
/** `capture.start`. */
export const CAPTURE_START_OPERATION =
  CAPTURE_START_ROUTE.operation satisfies AuthenticatedOperation;
/** `capture.stop`. */
export const CAPTURE_STOP_OPERATION = CAPTURE_STOP_ROUTE.operation satisfies AuthenticatedOperation;
/** `panel.get`. */
export const PANEL_GET_OPERATION = PANEL_ROUTE.operation satisfies AuthenticatedOperation;
/** `panel.getById`. */
export const PANEL_GET_BY_ID_OPERATION =
  PANEL_BY_ID_ROUTE.operation satisfies AuthenticatedOperation;
/** `modifications.list`. */
export const MODIFICATIONS_LIST_OPERATION =
  MODIFICATIONS_ROUTE.operation satisfies AuthenticatedOperation;

/**
 * The protocol operations this module answers: exactly ten. `../http.ts`
 * builds an exhaustive `Record<HttpOperationId, handler>` from the route
 * modules, and this tuple is this module's slice of it.
 */
export const SESSION_ROUTE_OPERATIONS = Object.freeze([
  SESSION_CREATE_OPERATION,
  SESSION_LIST_OPERATION,
  SESSION_GET_OPERATION,
  SESSION_QUESTION_OPERATION,
  SESSION_END_OPERATION,
  CAPTURE_START_OPERATION,
  CAPTURE_STOP_OPERATION,
  PANEL_GET_OPERATION,
  PANEL_GET_BY_ID_OPERATION,
  MODIFICATIONS_LIST_OPERATION,
] as const satisfies readonly AuthenticatedOperation[]);

/** One of {@link SESSION_ROUTE_OPERATIONS}. */
export type SessionRouteOperation = (typeof SESSION_ROUTE_OPERATIONS)[number];

/**
 * The name of the path parameter carrying the session id — the route table's
 * own declaration (`params[0]` of every session-scoped route, all of which
 * name it identically), so a renamed parameter changes here in the same edit.
 */
const SESSION_ID_PARAM = GET_ROUTE.params[0];

/** The name of the path parameter carrying the panel id: `params[1]` of `panel.getById`. */
const PANEL_ID_PARAM = PANEL_BY_ID_ROUTE.params[1];

/* -------------------------------------------------------------------------------------------------
 * Policy constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The largest `session.create` body accepted, in bytes: sixty-four kibibytes.
 *
 * A genuine body is a project path, a question of at most two thousand
 * characters and an optional selected-element descriptor (a selector, a tag,
 * a bounded text preview, a bounded component chain and a URL) — a few
 * kibibytes at every bound. The margin is generous; the bound only keeps the
 * route from being made to buffer an arbitrarily large body.
 */
export const MAX_SESSION_CREATE_BODY_BYTES = 64 * 1024;

/** The largest `session.question` body accepted, in bytes: one bounded question with room to spare. */
export const MAX_SESSION_QUESTION_BODY_BYTES = 16 * 1024;

/**
 * The largest body accepted by the operations whose body is the empty object
 * (`session.end`, `capture.start`, `capture.stop`), in bytes. `{}` is two; the
 * bound leaves room for whitespace and refuses anything that is plainly not an
 * empty object without reading it.
 */
export const MAX_EMPTY_BODY_BYTES = 1024;

/**
 * How often, in milliseconds, a request that answers once an effect is
 * recorded looks for that effect while the owning operation runs. Small enough
 * that a reply follows the effect closely, large enough that a long analysis
 * costs a handful of indexed reads per second.
 */
export const DEFAULT_SETTLE_POLL_INTERVAL_MS = 25;

/**
 * How long, in milliseconds, `session.end` waits for a cancelled pipeline
 * operation of the session to settle before it refuses to run cleanup
 * alongside it. Cancellation is observed between stages and by every model
 * call's abort signal, so a settle normally takes milliseconds; the bound only
 * stops an ending request from waiting forever.
 */
export const DEFAULT_END_SETTLE_TIMEOUT_MS = 30_000;

/** The largest interval or timeout the two knobs above accept, in milliseconds. */
const MAX_TIMING_MS = 10 * 60 * 1000;

/**
 * The longest id the routes will look up.
 *
 * Every id this product mints is its prefix, an underscore and sixteen
 * alphanumerics; sixty-four is the bound protocol applies to every opaque
 * identifier in a body, which keeps an arbitrary path segment out of a store
 * key.
 */
const MAX_ID_LENGTH = 64;

/**
 * The shape of a session id: `@debuggen/shared`'s session prefix, the
 * underscore delimiter, then lowercase alphanumerics — the alphabet `newId`
 * draws from.
 */
const SESSION_ID_PATTERN = new RegExp(`^${ID_PREFIXES.session}_[0-9a-z]+$`);

/** The shape of a panel id: `@debuggen/shared`'s panel prefix, then the same alphabet. */
const PANEL_ID_PATTERN = new RegExp(`^${ID_PREFIXES.panel}_[0-9a-z]+$`);

/**
 * The status a session is created in, and the one that marks a session whose
 * pipeline never started: typed against protocol's vocabulary, so a renamed
 * status is a compile error here.
 */
const CREATED_STATUS = 'created' as const satisfies SessionStatus;

/**
 * The stage a session whose pipeline was refused before it started is filed
 * under: the first pipeline stage, typed against protocol's stage vocabulary.
 */
const FIRST_PIPELINE_STAGE = 'understand' as const satisfies ProgressStage;

/**
 * The launcher's status of a dev server that answered its readiness probe —
 * the only launched dev server whose URL a new session is given.
 */
const SERVING_LAUNCH_STATUS = 'ready';

/** The status of every successful answer. */
const ANSWERED_STATUS = 200;

/** The status of a capture-ownership conflict. */
const CONFLICT_STATUS = 409;

/** The request header a client declares its body length in. */
const CONTENT_LENGTH_HEADER = 'content-length';

/** The response header that keeps session data out of every cache. */
const CACHE_CONTROL_HEADER = 'cache-control';

/** The {@link CACHE_CONTROL_HEADER} value on every response. */
const NO_STORE = 'no-store';

/** The log subsystem binding of this module's records. */
const LOG_SUBSYSTEM = 'server.sessions';

/** The `details` key a failure reason is recorded under, across the service. */
const REASON_DETAIL_KEY = 'reason';

/** The only shape of failure reason this module logs or looks up: a short kebab-case word list. */
const LOGGABLE_REASON = /^[a-z][a-z0-9-]{0,63}$/;

/* -------------------------------------------------------------------------------------------------
 * Fixed messages
 *
 * Constant sentences only: no request value, path, question or identifier is
 * ever interpolated into one.
 * ---------------------------------------------------------------------------------------------- */

/** The message of a `500` whose operation has no more specific one. */
const SESSION_UNAVAILABLE_MESSAGE =
  'The Debug Generator local service could not complete this session request. Its log holds the reason.';

/** The message of a `500` answering `session.end`: the session was not ended, and ending again retries. */
const END_UNAVAILABLE_MESSAGE =
  'Debug Generator could not finish cleaning up this session, so it was not ended. End the session again to retry; the service log holds the reason.';

/**
 * The message of a `500` when an answer does not satisfy the operation's
 * response schema — a drift between a subsystem and the protocol, never
 * something a client caused.
 */
const RESPONSE_DRIFT_MESSAGE =
  'The Debug Generator local service built a session response that does not match the protocol. Its log holds the reason.';

/**
 * The fallback message of a refusal whose own message protocol's error schema
 * would not accept (a validation summary over its length bound, for instance).
 * The code still says what went wrong.
 */
const REQUEST_REFUSED_MESSAGE = 'The Debug Generator local service refused this session request.';

/** The fallback message of a capture-ownership conflict whose own message the conflict schema refuses. */
const CAPTURE_CONFLICT_MESSAGE =
  'Another Debug Generator session is already capturing this project.';

/** The message of a `404` for a session id this service does not hold. */
const SESSION_NOT_FOUND_MESSAGE = 'No Debug Generator session has the id this request names.';

/** The recovery instruction of a session `404`. */
const SESSION_NOT_FOUND_HINT =
  'Reopen the session from the Debug Generator view in VS Code, or start a new one.';

/** The message of a `404` for a panel id this session does not hold. */
const PANEL_NOT_FOUND_MESSAGE =
  'This Debug Generator session holds no panel with the id this request names.';

/** The recovery instruction of a panel `404`. */
const PANEL_NOT_FOUND_HINT =
  'Read the session’s current panel instead; its record lists the ids of every panel version it produced.';

/** The message of a project root that is not an absolute path. */
const PROJECT_ROOT_NOT_ABSOLUTE_MESSAGE = 'The project root must be an absolute path.';

/** The recovery instruction of a project root that is not absolute. */
const PROJECT_ROOT_NOT_ABSOLUTE_HINT =
  'Start the session from a workspace folder opened in VS Code, whose absolute path identifies the project.';

/** The message of an ending refused because the session's pipeline did not stop in time. */
const PIPELINE_STILL_RUNNING_MESSAGE =
  'Debug Generator is still stopping a step of this session, so cleanup was not started.';

/** The recovery instruction of that refusal. */
const PIPELINE_STILL_RUNNING_HINT = 'End the session again in a moment.';

/** The failure message a half-created session is filed with when its pipeline could not start. */
const PIPELINE_NOT_STARTED_MESSAGE = 'The debugging pipeline could not start for this session.';

/** The recovery instruction filed with {@link PIPELINE_NOT_STARTED_MESSAGE}. */
const PIPELINE_NOT_STARTED_HINT =
  'Start a new session from the Debug Generator view in VS Code; the service log holds the reason.';

/* -------------------------------------------------------------------------------------------------
 * Public types — the ports this module declares, its dependencies and its handlers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The tab-binding lookup the DevTools rule needs: the binding recorded for a
 * session, carrying the `tokenHash` of the DevTools credential that made it.
 *
 * A consumer-declared port, identical in shape to the one
 * `./panel-data.ts` declares so `../http.ts` can hand both modules the same
 * object: the client registry of `../clients.ts` satisfies it structurally.
 * The binding is read from the registry the connection's principal recorded
 * it in — never from anything the request says about its tab.
 */
export interface SessionBindingLookup {
  /**
   * The live binding of a session's tab, if one exists.
   *
   * @param sessionId The session the request acts on.
   * @returns The binding, or `undefined` when no tab is bound to the session.
   */
  bindingForSession(sessionId: SessionId): TabBinding | undefined;
}

/**
 * Where a new session's dev-server URL comes from (see the module overview):
 * the service's own knowledge of the project's running dev server.
 *
 * In production {@link devServerLookupFromLaunches} adapts the dev-server
 * launcher's registry; any source that can answer "where does this project's
 * dev server serve?" without inventing an address may stand in for it.
 */
export interface SessionDevServerLookup {
  /**
   * The URL of the project's running dev server, when this source knows one.
   *
   * @param projectRoot The project's absolute root, normalised POSIX.
   * @returns The URL, or `undefined` when this source knows none.
   */
  devServerUrlFor(projectRoot: string): string | undefined | Promise<string | undefined>;
}

/**
 * One dev server the launcher started, as {@link devServerLookupFromLaunches}
 * reads it: the three members of the launcher's own snapshot it needs.
 * `../../dev-server/launcher.ts`'s `LaunchedDevServer` satisfies it
 * structurally.
 */
export interface LaunchedDevServerView {
  /** The absolute project root, normalised POSIX — the launcher's registry key. */
  readonly projectRoot: string;
  /** Where it serves, once known. */
  readonly devServerUrl?: string | undefined;
  /** Where it is in its lifetime; only a `ready` one is used. */
  readonly status: string;
}

/**
 * The launcher's registry, as {@link devServerLookupFromLaunches} reads it.
 * `../../dev-server/launcher.ts`'s `DevServerLauncher` satisfies it
 * structurally.
 */
export interface LaunchedDevServerRegistry {
  /** A snapshot of every launched dev server. */
  list(): readonly LaunchedDevServerView[];
}

/**
 * What {@link createSessionRoutes} is built from — the narrowest slice of each
 * subsystem the handlers call, declared here next to the routes so
 * `../http.ts` composes its dependency aggregate from this interface rather
 * than restating its fields. The field names match the sibling route modules'
 * where they carry the same subsystem, so the aggregate's intersection of them
 * is well-formed.
 */
export interface SessionRoutesDeps {
  /**
   * The session manager: the only writer of session status. Creates a session,
   * reads and lists them, ends one (running cleanup through its own runner) and
   * files a session whose pipeline could not start as `failed`.
   */
  readonly manager: Pick<SessionManager, 'create' | 'get' | 'list' | 'end' | 'fail'>;

  /** Rehydrates a stored session and replays it to its connected clients. */
  readonly reopener: Pick<SessionReopener, 'reopen'>;

  /**
   * The pipeline orchestrator: runs the pipeline of a new session, arms and
   * completes captures, answers follow-ups, and cancels an operation in flight
   * before a session is ended.
   */
  readonly orchestrator: Pick<
    PipelineOrchestrator,
    'run' | 'beginCapture' | 'completeCapture' | 'followUp' | 'cancel' | 'activeRun'
  >;

  /**
   * The session store's capture reads: the session's open capture window, and
   * whether a given window has closed with its summary stored.
   */
  readonly sessions: Pick<SessionsRepo, 'getActiveCapture' | 'getCapture'>;

  /** The stored panels: a session's current one, and any one version by id. */
  readonly panels: Pick<PanelsRepo, 'getLatestPanel' | 'getPanel'>;

  /** The modification journal, read per session in application order. */
  readonly modifications: Pick<ModificationsRepo, 'listBySession'>;

  /** The tab bindings a DevTools principal acts through. */
  readonly bindings: SessionBindingLookup;

  /**
   * Where a new session's dev-server URL is looked up first. Optional: without
   * it, only a URL an earlier session of the same project recorded is reused.
   */
  readonly devServers?: SessionDevServerLookup | undefined;

  /**
   * Where this module's diagnostics go; defaults to the no-op logger. Records
   * carry operations, statuses, error codes, reasons and counts only.
   */
  readonly logger?: Logger | undefined;

  /**
   * Overrides {@link DEFAULT_SETTLE_POLL_INTERVAL_MS}. A value that is not a
   * positive integer of at most ten minutes is ignored.
   */
  readonly settlePollIntervalMs?: number | undefined;

  /**
   * Overrides {@link DEFAULT_END_SETTLE_TIMEOUT_MS}. A value that is not a
   * positive integer of at most ten minutes is ignored.
   */
  readonly endSettleTimeoutMs?: number | undefined;
}

/**
 * One session route handler, typed on the service's hono environment so
 * `c.get('principal')` is the principal `../auth.ts`'s middleware resolved.
 */
export type SessionRouteHandler = Handler<ServerEnv>;

/**
 * The handlers {@link createSessionRoutes} returns, keyed by protocol operation
 * id so `../http.ts` can place them in its exhaustive handler record
 * unchanged.
 */
export type SessionRoutes = Readonly<Record<SessionRouteOperation, SessionRouteHandler>>;

/** Every status a session route answers a failure with. */
export type SessionRouteFailureStatus =
  400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503;

/* -------------------------------------------------------------------------------------------------
 * The dev-server lookup over the launcher's registry
 * ---------------------------------------------------------------------------------------------- */

/**
 * Adapts the dev-server launcher's registry into a
 * {@link SessionDevServerLookup}: the URL of the `ready` dev server the
 * launcher started for exactly this project root, if there is one.
 *
 * The launcher keys its registry by the normalised POSIX root, so the lookup
 * normalises the root it is asked about the same way before comparing. A
 * launched dev server that has not answered its readiness probe, is stopping,
 * or printed no address is not offered.
 *
 * @param launches The launcher (or any registry of the same shape).
 * @returns The lookup.
 *
 * @example
 * ```ts
 * const devServers = devServerLookupFromLaunches(launcher);
 * devServers.devServerUrlFor('/work/storefront'); // → 'http://127.0.0.1:3000/' once launched
 * ```
 */
export function devServerLookupFromLaunches(
  launches: LaunchedDevServerRegistry,
): SessionDevServerLookup {
  return Object.freeze({
    devServerUrlFor(projectRoot: string): string | undefined {
      const wanted = normalizePosix(toPosix(projectRoot));
      for (const launch of launches.list()) {
        const url = launch.devServerUrl;
        if (
          launch.status === SERVING_LAUNCH_STATUS &&
          url !== undefined &&
          url.length > 0 &&
          normalizePosix(toPosix(launch.projectRoot)) === wanted
        ) {
          return url;
        }
      }
      return undefined;
    },
  });
}

/* -------------------------------------------------------------------------------------------------
 * Failure vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** A status a failure is described at, in its own constant words. */
type DescribedStatus = 400 | 404 | 409 | 422 | 502 | 503;

/**
 * The statuses of the failures this module describes to its caller in the
 * failure's own words, by error code. The messages of these codes are the
 * product's own sentences — built by the state machine, the orchestrator, the
 * stages and the manager for display — never a thrown value's text.
 *
 * - `400` — a request the transport refused (`PROTOCOL_INVALID_MESSAGE`) or a
 *   path the filesystem layer refused (`FS_UNSAFE_PATH`).
 * - `404` — the session or the project does not exist.
 * - `409` — the session's state does not admit the request: a refused
 *   transition or a busy pipeline, a capture conflict, readiness not yet
 *   reached, an instrumented file the developer edited.
 * - `422` — a stage refused what it was given to apply: model output that
 *   failed its schema, a plan, a panel, a patch target.
 * - `502` — the project's dev server could not be launched.
 * - `503` — something the request needs is unavailable: the dev server's URL,
 *   the model provider, a telemetry signal.
 *
 * Every other code — `STORE_ERROR`, `INTERNAL`, `CONFIG_INVALID`,
 * `CODE_INDEX_FAILED`, `CLEANUP_PARTIAL`, anything unforeseen — is answered
 * `500` with a fixed message and its code, so a store or subsystem failure
 * never reaches a response body in its own words. Access-boundary refusals
 * never reach this table: `../auth.ts`'s own `authErrorResponse` renders them
 * at the status its reason table fixes.
 */
const STATUS_BY_CODE: ReadonlyMap<DebuggenErrorCode, DescribedStatus> = new Map<
  DebuggenErrorCode,
  DescribedStatus
>([
  ['PROTOCOL_INVALID_MESSAGE', 400],
  ['FS_UNSAFE_PATH', 400],
  ['PROJECT_NOT_FOUND', 404],
  ['SESSION_NOT_FOUND', 404],
  ['SESSION_INVALID_STATE', 409],
  ['CAPTURE_ALREADY_ACTIVE', 409],
  ['CAPTURE_EMPTY', 409],
  ['AGENT_NOT_READY', 409],
  ['SERVER_AGENT_NOT_READY', 409],
  ['MODIFICATION_CONFLICT', 409],
  ['MODEL_OUTPUT_INVALID', 422],
  ['PLAN_INVALID', 422],
  ['PANEL_INVALID', 422],
  ['PANEL_SEMANTIC_INVALID', 422],
  ['PATCH_TARGET_NOT_FOUND', 422],
  ['PATCH_UNSUPPORTED', 422],
  ['DEV_SERVER_LAUNCH_FAILED', 502],
  ['DEV_SERVER_UNAVAILABLE', 503],
  ['MODEL_UNAVAILABLE', 503],
  ['INSTRUMENTATION_UNAVAILABLE', 503],
]);

/**
 * Failure reasons that fix a status whatever the code, because one code covers
 * failures a client must tell apart. Each reason's message is a constant
 * sentence of the subsystem that raised it.
 *
 * - `project-root-not-absolute` — the manager refused a relative project root
 *   (code `PROJECT_NOT_FOUND`): refused request content, `400`.
 * - `orchestrator-disposed` — the service is shutting down (code `INTERNAL`):
 *   `503`, a retry after the restart succeeds.
 * - `aborted` — the operation was cancelled, normally because the session was
 *   ended meanwhile (code `INTERNAL`): the session's state conflicts with the
 *   request, `409`.
 */
const STATUS_BY_REASON: ReadonlyMap<string, DescribedStatus> = new Map<string, DescribedStatus>([
  ['project-root-not-absolute', 400],
  ['orchestrator-disposed', 503],
  ['aborted', 409],
]);

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
 * The status a failure met while answering a session request is answered
 * with.
 *
 * An access-boundary refusal (its `details.reason` names an entry of
 * `../auth.ts`'s `AUTH_FAILURE_REASONS`) takes that table's status; a reason
 * {@link STATUS_BY_REASON} names takes its status; a code
 * {@link STATUS_BY_CODE} describes takes its status; everything else is `500`.
 *
 * @param error Any failure met while answering a session request.
 * @returns The HTTP status to answer with.
 *
 * @example
 * ```ts
 * sessionRouteFailureStatus(new DebuggenError('SESSION_NOT_FOUND', 'No such session.'));
 * // → 404
 * sessionRouteFailureStatus(new DebuggenError('STORE_ERROR', 'The store failed.'));
 * // → 500
 * ```
 */
export function sessionRouteFailureStatus(error: DebuggenError): SessionRouteFailureStatus {
  const refusal = authFailureStatus(error);
  if (refusal !== undefined) {
    return refusal;
  }
  const reason = reasonOf(error);
  const byReason = reason === undefined ? undefined : STATUS_BY_REASON.get(reason);
  if (byReason !== undefined) {
    return byReason;
  }
  return STATUS_BY_CODE.get(error.code) ?? 500;
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

/**
 * The `404` for a path that names no panel of the session — a malformed id, an
 * id no panel holds, and a panel of another session alike, so a caller cannot
 * probe for panels of sessions it may not read.
 */
function panelNotFound(reason: 'malformed-panel-id' | 'unknown-panel'): DebuggenError {
  return new DebuggenError('SESSION_NOT_FOUND', PANEL_NOT_FOUND_MESSAGE, {
    hint: PANEL_NOT_FOUND_HINT,
    details: { reason },
  });
}

/** The `400` for a project root that is not an absolute path. */
function projectRootNotAbsolute(): DebuggenError {
  return new DebuggenError('PROJECT_NOT_FOUND', PROJECT_ROOT_NOT_ABSOLUTE_MESSAGE, {
    hint: PROJECT_ROOT_NOT_ABSOLUTE_HINT,
    details: { reason: 'project-root-not-absolute' },
  });
}

/** The `409` for an ending whose session's pipeline operation did not settle in time. */
function pipelineStillRunning(): DebuggenError {
  return new DebuggenError('SESSION_INVALID_STATE', PIPELINE_STILL_RUNNING_MESSAGE, {
    hint: PIPELINE_STILL_RUNNING_HINT,
    details: { reason: 'pipeline-still-running' },
  });
}

/**
 * The failure a throwing collaborator is converted to. The thrown value is
 * never kept: its message could quote a path, a question or captured data.
 */
function portFailure(code: 'STORE_ERROR' | 'INTERNAL', reason: string): DebuggenError {
  return new DebuggenError(code, SESSION_UNAVAILABLE_MESSAGE, { details: { reason } });
}

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a path segment has the shape of a session id: `@debuggen/shared`'s
 * session prefix, an underscore, then lowercase alphanumerics, at most
 * sixty-four characters in all.
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
 * isWellFormedSessionRouteId('ses_4k2p9dq7m1zx0c3v'); // → true
 * isWellFormedSessionRouteId('../sessions');          // → false
 * ```
 */
export function isWellFormedSessionRouteId(value: string | undefined): value is SessionId {
  return value !== undefined && value.length <= MAX_ID_LENGTH && SESSION_ID_PATTERN.test(value);
}

/**
 * Whether a path segment has the shape of a panel id: `@debuggen/shared`'s
 * panel prefix, an underscore, then lowercase alphanumerics, at most
 * sixty-four characters in all.
 *
 * @param value The decoded `:panelId` path parameter, or `undefined` when absent.
 * @returns `true` for a well-formed panel id.
 */
export function isWellFormedPanelRouteId(value: string | undefined): value is string {
  return value !== undefined && value.length <= MAX_ID_LENGTH && PANEL_ID_PATTERN.test(value);
}

/**
 * Normalises a requested project root the way the session manager stores
 * one — `toPosix`, then `normalizePosix` — and requires it absolute. A Windows
 * drive-letter or UNC root is refused: the service runs on the developer's
 * POSIX machine, and a session's root is an absolute POSIX path by protocol's
 * session contract. `normalizePosix` resolves `.` and `..` segments, so the
 * scope check that follows judges the path the session would actually hold.
 *
 * @param requested The `projectRoot` of a validated `session.create` body.
 * @returns The normalised root, or the `400` refusal.
 *
 * @example
 * ```ts
 * normalizeSessionProjectRoot('/work/app/../storefront/'); // → ok('/work/storefront')
 * normalizeSessionProjectRoot('storefront');               // → err(PROJECT_NOT_FOUND)
 * ```
 */
export function normalizeSessionProjectRoot(requested: string): Result<string, DebuggenError> {
  const posix = toPosix(requested);
  if (posix.length === 0 || isWindowsAbsolute(posix) || !isAbsolutePosix(posix)) {
    return err(projectRootNotAbsolute());
  }
  return ok(normalizePosix(posix));
}

/**
 * A timing knob: the configured value when it is a positive integer of at most
 * ten minutes, else the default.
 */
function timingOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 && value <= MAX_TIMING_MS
    ? value
    : fallback;
}

/**
 * Resolves after `ms` milliseconds. Used only between reads of an effect a
 * running operation is expected to record; the timer is never longer than the
 * poll interval.
 */
function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Awaits a collaborator call contracted never to reject, converting a
 * rejection — or a synchronous throw — into the `INTERNAL` `Err` it should
 * have been. The thrown value is not kept.
 */
async function settled<T>(
  call: () => Promise<Result<T, DebuggenError>> | Result<T, DebuggenError>,
  reason: string,
): Promise<Result<T, DebuggenError>> {
  try {
    return await call();
  } catch {
    return err(portFailure('INTERNAL', reason));
  }
}

/** The synchronous twin of {@link settled}, for the store's synchronous reads (a throw is `STORE_ERROR`). */
function settledSync<T>(
  call: () => Result<T, DebuggenError>,
  reason: string,
): Result<T, DebuggenError> {
  try {
    return call();
  } catch {
    return err(portFailure('STORE_ERROR', reason));
  }
}

/* -------------------------------------------------------------------------------------------------
 * Request bodies
 * ---------------------------------------------------------------------------------------------- */

/** The operations of this module that carry a request body. */
type BodyOperation =
  | typeof SESSION_CREATE_OPERATION
  | typeof SESSION_QUESTION_OPERATION
  | typeof SESSION_END_OPERATION
  | typeof CAPTURE_START_OPERATION
  | typeof CAPTURE_STOP_OPERATION;

/** The largest body each body-carrying operation accepts, in bytes. */
const MAX_BODY_BYTES: Readonly<Record<BodyOperation, number>> = Object.freeze({
  [SESSION_CREATE_OPERATION]: MAX_SESSION_CREATE_BODY_BYTES,
  [SESSION_QUESTION_OPERATION]: MAX_SESSION_QUESTION_BODY_BYTES,
  [SESSION_END_OPERATION]: MAX_EMPTY_BODY_BYTES,
  [CAPTURE_START_OPERATION]: MAX_EMPTY_BODY_BYTES,
  [CAPTURE_STOP_OPERATION]: MAX_EMPTY_BODY_BYTES,
});

/**
 * The operations whose request body is protocol's empty object. An absent
 * body on one of them reads as `{}` — the only value its schema admits — so an
 * ending sent without a body (a script's bare `POST`, say) still reaches
 * cleanup; a body that is present is validated exactly as sent.
 */
const EMPTY_BODY_OPERATIONS: ReadonlySet<BodyOperation> = new Set<BodyOperation>([
  SESSION_END_OPERATION,
  CAPTURE_START_OPERATION,
  CAPTURE_STOP_OPERATION,
]);

/** Why a request body was refused before any subsystem saw it. */
interface BodyRejection {
  /** `413` for an oversized body, `400` for one that is unreadable, not JSON or off-schema. */
  readonly status: 400 | 413;
  /** The refusal; its message never quotes the body. */
  readonly error: DebuggenError;
}

/** The refusal of a body larger than the operation accepts. */
function bodyTooLarge(operation: BodyOperation): BodyRejection {
  const maxBytes = MAX_BODY_BYTES[operation];
  return {
    status: 413,
    error: new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The ${operation} request body is larger than this operation accepts.`,
      {
        hint: `Send a body of at most ${String(maxBytes)} bytes.`,
        details: { operation, reason: 'body-too-large', maxBytes },
      },
    ),
  };
}

/** The refusal of a body that is unreadable or not JSON; the body itself is never quoted. */
function bodyNotJson(
  operation: BodyOperation,
  problem: 'body-unreadable' | 'body-not-json',
): BodyRejection {
  const message =
    problem === 'body-unreadable'
      ? `The ${operation} request body could not be read.`
      : `The ${operation} request body is not valid JSON.`;
  return {
    status: 400,
    error: new DebuggenError('PROTOCOL_INVALID_MESSAGE', message, {
      hint: `Send the ${operation} body as a JSON object.`,
      details: { operation, reason: problem },
    }),
  };
}

/**
 * Reads the request body as JSON, bounded by the operation's limit.
 *
 * A declared `Content-Length` above the bound is refused before anything is
 * read; the text actually read is measured again, which covers a chunked body
 * that declared no length. An empty body reads as `undefined`, which the
 * `session.create` and `session.question` schemas refuse and which
 * {@link readBody} reads as `{}` for the {@link EMPTY_BODY_OPERATIONS}.
 * `JSON.parse`'s own error is discarded, because its message quotes the input.
 *
 * @param c The request context.
 * @param operation The operation whose bound applies.
 * @returns The parsed value, or the refusal.
 */
async function readJsonBody(
  c: Context<ServerEnv>,
  operation: BodyOperation,
): Promise<Result<unknown, BodyRejection>> {
  const maxBytes = MAX_BODY_BYTES[operation];
  const declared = c.req.header(CONTENT_LENGTH_HEADER);
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      return err(bodyTooLarge(operation));
    }
  }

  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return err(bodyNotJson(operation, 'body-unreadable'));
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return err(bodyTooLarge(operation));
  }
  if (text.trim().length === 0) {
    return ok(undefined);
  }

  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch {
    return err(bodyNotJson(operation, 'body-not-json'));
  }
}

/**
 * Reads and validates a body against protocol's route table — the same
 * `parseHttpRequest` the client SDK validates its outbound body with, so every
 * body a client can send is accepted and nothing off-schema is. The rejection
 * message is built by `describeZodIssues` from issue paths and codes: a
 * question, a path or a selector never reaches it.
 *
 * @param c The request context.
 * @param operation The operation whose schema applies.
 * @returns The validated body, or the refusal (`400`/`413`).
 */
async function readBody<O extends BodyOperation>(
  c: Context<ServerEnv>,
  operation: O,
): Promise<Result<HttpRequestBody<O>, BodyRejection>> {
  const raw = await readJsonBody(c, operation);
  if (isErr(raw)) {
    return raw;
  }
  const value: unknown =
    raw.value === undefined && EMPTY_BODY_OPERATIONS.has(operation) ? {} : raw.value;
  const parsed = parseHttpRequest(operation, value);
  if (isErr(parsed)) {
    return err({ status: 400, error: parsed.error });
  }
  return ok(parsed.value);
}

/* -------------------------------------------------------------------------------------------------
 * Responses
 * ---------------------------------------------------------------------------------------------- */

/** What a log record about one request may say: the operation, and nothing about its content. */
interface RequestContext {
  readonly log: Logger;
  readonly operation: SessionRouteOperation;
}

/**
 * The payload a described failure is answered with, checked against
 * protocol's own `httpErrorResponseSchema`: a payload the schema refuses keeps
 * its code and is given {@link REQUEST_REFUSED_MESSAGE}, so no response here
 * can be refused by a client's parser.
 */
function boundedPayload(payload: HttpErrorResponse): HttpErrorResponse {
  return httpErrorResponseSchema.safeParse(payload).success
    ? payload
    : { code: payload.code, message: REQUEST_REFUSED_MESSAGE };
}

/**
 * Logs an answered failure: constant text plus the operation, the status, the
 * error code and — when it has the loggable shape — the failure reason.
 * Neither the error's message, its hint nor its details are logged.
 */
function logFailure(context: RequestContext, status: number, error: DebuggenError): void {
  const reason = reasonOf(error);
  const fields = {
    operation: context.operation,
    status,
    errorCode: error.code,
    ...(reason === undefined ? {} : { reason }),
  };
  if (status >= 500) {
    context.log.error('A session request failed', fields);
  } else {
    context.log.warn('A session request was refused', fields);
  }
}

/** The fixed message of a `500` answering `operation`. */
function unavailableMessageFor(operation: SessionRouteOperation): string {
  return operation === SESSION_END_OPERATION
    ? END_UNAVAILABLE_MESSAGE
    : SESSION_UNAVAILABLE_MESSAGE;
}

/**
 * Answers any failure with protocol's error payload.
 *
 * - An access-boundary refusal is rendered by `../auth.ts`'s own
 *   `authErrorResponse`, at the status its reason table fixes.
 * - A capture-ownership conflict is answered `409` with
 *   `captureStartConflictResponseSchema`'s body, `owningSessionId` intact.
 * - A failure {@link sessionRouteFailureStatus} describes is sent at its status
 *   in its own constant words.
 * - Anything else is answered `500` with its code and a fixed message.
 *
 * @param c The request context.
 * @param error The failure.
 * @param context The logger and the operation.
 * @returns The error response.
 */
function answerFailure(
  c: Context<ServerEnv>,
  error: DebuggenError,
  context: RequestContext,
): Response {
  if (authFailureStatus(error) !== undefined) {
    const { status, body } = authErrorResponse(error);
    logFailure(context, status, error);
    return c.json(body, status);
  }
  if (isCaptureConflict(error)) {
    return answerCaptureConflict(c, error, context);
  }
  const status = sessionRouteFailureStatus(error);
  logFailure(context, status, error);
  if (status === 500) {
    const body: HttpErrorResponse = {
      code: error.code,
      message: unavailableMessageFor(context.operation),
    };
    return c.json(body, 500);
  }
  return c.json(boundedPayload(toErrorPayload(error)), status);
}

/**
 * Answers the manager's capture-ownership conflict: `409` with protocol's
 * error payload plus the id of the session that holds the project's capture.
 *
 * The body is validated against `captureStartConflictResponseSchema` before it
 * is sent. A message the schema refuses is replaced by
 * {@link CAPTURE_CONFLICT_MESSAGE}; an owning-session id the schema refuses —
 * which would be a defect of the manager — degrades to a plain `409` error body
 * rather than a malformed conflict, and is logged.
 *
 * @param c The request context.
 * @param error The manager's typed conflict.
 * @param context The logger and the operation.
 * @returns The `409` response.
 */
function answerCaptureConflict(
  c: Context<ServerEnv>,
  error: CaptureConflictError,
  context: RequestContext,
): Response {
  logFailure(context, CONFLICT_STATUS, error);
  const payload = toErrorPayload(error);
  const owningSessionId = error.details.owningSessionId;
  const candidates: readonly CaptureStartConflictResponse[] = [
    { ...payload, owningSessionId },
    { code: payload.code, message: CAPTURE_CONFLICT_MESSAGE, owningSessionId },
  ];
  for (const candidate of candidates) {
    if (captureStartConflictResponseSchema.safeParse(candidate).success) {
      return c.json(candidate, CONFLICT_STATUS);
    }
  }
  context.log.error('A capture conflict named an owning session the protocol refuses', {
    operation: context.operation,
    errorCode: error.code,
  });
  return c.json(boundedPayload(payload), CONFLICT_STATUS);
}

/** Answers a refused body with protocol's error payload at the rejection's status. */
function answerBodyRejection(
  c: Context<ServerEnv>,
  rejection: BodyRejection,
  context: RequestContext,
): Response {
  logFailure(context, rejection.status, rejection.error);
  return c.json(boundedPayload(toErrorPayload(rejection.error)), rejection.status);
}

/**
 * Answers a success after checking it against the operation's response schema
 * — the same `parseHttpResponse` a client parses the reply with. The value
 * sent is the subsystem's own, exactly as it was built; the parse is a gate,
 * never a rewrite. A value the schema refuses is a drift between a subsystem
 * and the protocol and is answered `500` with a fixed `INTERNAL` payload; the
 * offending value is never logged, because it holds session data.
 *
 * The parameter is typed as a plain object on purpose: the stored panel and
 * modification types are deeply `readonly`, while the response types inferred
 * from protocol's schemas are not, so every call site states its compile-time
 * shape with `satisfies` and this runtime gate is the contract's enforcement.
 *
 * @param c The request context.
 * @param context The logger and the operation whose response schema applies.
 * @param body The answer to send.
 * @returns The `200` response, or the `500` of a drift.
 */
function answerSuccess(c: Context<ServerEnv>, context: RequestContext, body: object): Response {
  const checked = parseHttpResponse(context.operation, body);
  if (isErr(checked)) {
    const drift = new DebuggenError('INTERNAL', RESPONSE_DRIFT_MESSAGE, {
      details: { reason: 'response-off-schema' },
    });
    logFailure(context, 500, drift);
    return c.json(toErrorPayload(drift), 500);
  }
  return c.json(body, ANSWERED_STATUS);
}

/* -------------------------------------------------------------------------------------------------
 * The request steps: principal and role, binding, session and access
 * ---------------------------------------------------------------------------------------------- */

/**
 * The first step: the principal `../auth.ts`'s middleware resolved, holding
 * one of the roles `OPERATION_ROLES` grants the operation.
 *
 * A missing principal means the route was registered without its middleware —
 * a composition defect — and is refused `401` rather than served. A role the
 * operation does not grant is refused `403` here, before the path, the store
 * or the body is looked at.
 *
 * @param c The request context.
 * @param context The logger and the operation.
 * @returns The principal, or the response that refuses the request.
 */
function authorize(c: Context<ServerEnv>, context: RequestContext): Result<Principal, Response> {
  // Widened on purpose: `ServerEnv` types the variable as always present, and
  // the absence this guards against is exactly the case the type cannot see.
  const principal: Principal | undefined = c.get('principal');
  if (principal === undefined) {
    context.log.error('A session route ran without a resolved principal', {
      operation: context.operation,
    });
    return err(answerFailure(c, refusalFor('missing-credential'), context));
  }
  const roles: readonly PrincipalRole[] = OPERATION_ROLES[context.operation];
  const permitted = requireRole(principal, ...roles);
  if (isErr(permitted)) {
    return err(answerFailure(c, permitted.error, context));
  }
  return ok(principal);
}

/** A request admitted to act on one session. */
interface AdmittedSession {
  /** The session the path names, of verified shape. */
  readonly sessionId: SessionId;
  /** The session as stored when the request was admitted. */
  readonly record: SessionRecord;
  /** The principal acting on it. */
  readonly principal: Principal;
  /** The request's logger, bound to the session. */
  readonly context: RequestContext;
}

/**
 * The tab binding a DevTools principal acts through, read from the injected
 * lookup. A throwing lookup is an `INTERNAL` failure; its thrown value is not
 * kept.
 */
function lookupBinding(
  bindings: SessionBindingLookup,
  sessionId: SessionId,
): Result<TabBinding | undefined, DebuggenError> {
  try {
    return ok(bindings.bindingForSession(sessionId));
  } catch {
    return err(portFailure('INTERNAL', 'binding-lookup-threw'));
  }
}

/**
 * The session the request names, from the manager.
 *
 * @returns The stored record, `SESSION_NOT_FOUND` when no such session exists,
 * or the store's own failure (a throw becomes `STORE_ERROR`).
 */
function loadSession(
  manager: SessionRoutesDeps['manager'],
  sessionId: SessionId,
): Result<SessionRecord, DebuggenError> {
  const read = settledSync(() => manager.get(sessionId), 'session-lookup-threw');
  if (isErr(read)) {
    return read;
  }
  const record = read.value;
  if (record?.id !== sessionId) {
    return err(sessionNotFound('unknown-session'));
  }
  return ok(record);
}

/**
 * Admits a request to the session its path names, in the module's fixed
 * order: role, id shape, DevTools binding (before any store read, so a client
 * that is not bound to this session cannot tell an existing session from an
 * absent one), the stored session, and the per-session access matrix.
 *
 * @param c The request context.
 * @param deps The manager and the binding lookup.
 * @param log This module's logger.
 * @param operation The operation being answered.
 * @returns The admitted session, or the response that refuses the request.
 */
function admitSession(
  c: Context<ServerEnv>,
  deps: Pick<SessionRoutesDeps, 'manager' | 'bindings'>,
  log: Logger,
  operation: SessionRouteOperation,
): Result<AdmittedSession, Response> {
  const base: RequestContext = { log, operation };
  const principal = authorize(c, base);
  if (isErr(principal)) {
    return principal;
  }

  const sessionId = c.req.param(SESSION_ID_PARAM);
  if (!isWellFormedSessionRouteId(sessionId)) {
    return err(answerFailure(c, sessionNotFound('malformed-session-id'), base));
  }
  const context: RequestContext = { log: sessionLogger(log, sessionId), operation };

  let binding: TabBinding | undefined;
  if (principal.value.role === 'devtools') {
    const looked = lookupBinding(deps.bindings, sessionId);
    if (isErr(looked)) {
      return err(answerFailure(c, looked.error, context));
    }
    const bound = requireBoundSession(principal.value, sessionId, looked.value);
    if (isErr(bound)) {
      return err(answerFailure(c, bound.error, context));
    }
    binding = looked.value;
  }

  const session = loadSession(deps.manager, sessionId);
  if (isErr(session)) {
    return err(answerFailure(c, session.error, context));
  }
  const target: SessionAccessTarget = {
    id: session.value.id,
    projectRoot: session.value.projectRoot,
  };
  const access = requireSessionAccess(principal.value, target, binding);
  if (isErr(access)) {
    return err(answerFailure(c, access.error, context));
  }

  return ok({ sessionId, record: session.value, principal: principal.value, context });
}

/* -------------------------------------------------------------------------------------------------
 * Waiting for a recorded effect while the owning operation runs
 * ---------------------------------------------------------------------------------------------- */

/** Which came first: the owning operation's settlement, or the effect a request answers with. */
type EffectRace<T, E> =
  | { readonly kind: 'settled'; readonly outcome: T }
  | { readonly kind: 'observed'; readonly effect: E };

/**
 * Races an operation's settlement against an effect it records part-way.
 *
 * `observe` is read immediately and then once per `intervalMs` until either it
 * returns a value or the operation settles; a settlement always wins over an
 * effect observed at the same time, so a refusal or a finished operation is
 * answered as itself. The operation keeps running after an effect is
 * observed — nothing is cancelled here.
 *
 * @param operation The running operation; it must not reject (wrap it with {@link settled}).
 * @param observe Reads the effect; `undefined` means not yet recorded.
 * @param intervalMs The poll interval.
 * @returns Whichever came first.
 */
async function raceEffect<T, E>(
  operation: Promise<T>,
  observe: () => E | undefined,
  intervalMs: number,
): Promise<EffectRace<T, E>> {
  let outcome: { readonly value: T } | undefined;
  const marker = operation.then((value) => {
    outcome = { value };
  });

  for (;;) {
    if (outcome !== undefined) {
      return { kind: 'settled', outcome: outcome.value };
    }
    const effect = observe();
    if (effect !== undefined) {
      return { kind: 'observed', effect };
    }
    await Promise.race([marker, pause(intervalMs)]);
  }
}

/**
 * Waits until `isIdle` reports true, reading it once per `intervalMs`, for at
 * most `timeoutMs`.
 *
 * @returns Whether it became idle within the bound.
 */
async function waitUntilIdle(
  isIdle: () => boolean,
  intervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isIdle()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await pause(intervalMs);
  }
}

/* -------------------------------------------------------------------------------------------------
 * The routes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The failure a session whose pipeline could not start is filed with: the
 * refusal's own code, message and hint — constant sentences of the
 * orchestrator — or, for a rejection this module converted, a fixed sentence.
 */
function unstartedPipelineFailure(error: DebuggenError): SessionFailure {
  if (reasonOf(error) === 'pipeline-run-rejected' || error.message.trim().length === 0) {
    return {
      stage: FIRST_PIPELINE_STAGE,
      code: error.code,
      message: PIPELINE_NOT_STARTED_MESSAGE,
      hint: PIPELINE_NOT_STARTED_HINT,
    };
  }
  return error.hint === undefined
    ? { stage: FIRST_PIPELINE_STAGE, code: error.code, message: error.message }
    : { stage: FIRST_PIPELINE_STAGE, code: error.code, message: error.message, hint: error.hint };
}

/**
 * Builds the ten session route handlers for `../http.ts` to register.
 *
 * Registers nothing, builds no application, opens no socket and holds no state
 * between requests. Each handler runs the steps of the module documentation
 * in order and answers either `200` with the operation's response body, checked
 * against protocol's response schema, or protocol's error body at the status
 * {@link sessionRouteFailureStatus} assigns.
 *
 * @param deps The subsystems the handlers delegate to, and an optional logger
 * and timing overrides.
 * @returns A frozen record of the handlers, keyed by operation id.
 *
 * @example
 * ```ts
 * const routes = createSessionRoutes({
 *   manager, reopener, orchestrator, sessions, panels, modifications, bindings: clients,
 * });
 * app.on('POST', HTTP_ROUTES['session.create'].pattern, authFor('session.create'),
 *   routes['session.create']);
 * ```
 */
export function createSessionRoutes(deps: SessionRoutesDeps): SessionRoutes {
  const { manager, reopener, orchestrator, sessions, panels, modifications, bindings } = deps;
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);
  const pollIntervalMs = timingOrDefault(
    deps.settlePollIntervalMs,
    DEFAULT_SETTLE_POLL_INTERVAL_MS,
  );
  const endSettleTimeoutMs = timingOrDefault(
    deps.endSettleTimeoutMs,
    DEFAULT_END_SETTLE_TIMEOUT_MS,
  );

  /** {@link admitSession} over this instance's manager and bindings. */
  const admit = (
    c: Context<ServerEnv>,
    operation: SessionRouteOperation,
  ): Result<AdmittedSession, Response> => admitSession(c, { manager, bindings }, log, operation);

  /* ----------------------------------------------------------------------------------------------
   * Work that continues after a reply
   * -------------------------------------------------------------------------------------------- */

  /**
   * Logs the outcome of an operation that continues after its request was
   * answered. The operation's failure is filed on the session by the
   * orchestrator itself; this record only keeps it visible in the service log.
   */
  function observeInBackground(
    running: Promise<Result<unknown, DebuggenError>>,
    context: RequestContext,
  ): void {
    void running.then((outcome) => {
      if (isErr(outcome)) {
        const reason = reasonOf(outcome.error);
        context.log.warn('Work continuing after a session reply failed; the session records it', {
          operation: context.operation,
          errorCode: outcome.error.code,
          ...(reason === undefined ? {} : { reason }),
        });
      } else {
        context.log.info('Work continuing after a session reply finished', {
          operation: context.operation,
        });
      }
    });
  }

  /**
   * Files a session whose pipeline run was refused before it moved the
   * session. A session the run did move is left alone: the orchestrator filed
   * any failure of it itself, and a second filing would duplicate the failed
   * progress row.
   */
  async function fileUnstartedPipeline(
    sessionId: SessionId,
    error: DebuggenError,
    sessionLog: Logger,
  ): Promise<void> {
    const current = settledSync(() => manager.get(sessionId), 'session-lookup-threw');
    if (isErr(current) || current.value === undefined) {
      sessionLog.error(
        'The pipeline of a new session was refused and the session could not be read',
        {
          operation: SESSION_CREATE_OPERATION,
          errorCode: error.code,
        },
      );
      return;
    }
    if (current.value.status !== CREATED_STATUS) {
      sessionLog.warn('The pipeline of a new session stopped; the session records why', {
        operation: SESSION_CREATE_OPERATION,
        errorCode: error.code,
        status: current.value.status,
      });
      return;
    }
    const filed = await settled(
      () => manager.fail(sessionId, unstartedPipelineFailure(error)),
      'session-fail-rejected',
    );
    if (isErr(filed)) {
      sessionLog.error('A session whose pipeline could not start could not be filed as failed', {
        operation: SESSION_CREATE_OPERATION,
        errorCode: filed.error.code,
      });
      return;
    }
    sessionLog.warn(
      'The pipeline of a new session could not start; the session was filed as failed',
      {
        operation: SESSION_CREATE_OPERATION,
        errorCode: error.code,
      },
    );
  }

  /**
   * Starts the pipeline of a new session without awaiting it: stages 1–3 and
   * the installation, reported to clients by the orchestrator's progress rows
   * and the manager's broadcasts. The run never rejects unobserved.
   */
  function startPipeline(sessionId: SessionId, sessionLog: Logger): void {
    const run = async (): Promise<void> => {
      const outcome = await settled(() => orchestrator.run({ sessionId }), 'pipeline-run-rejected');
      if (isErr(outcome)) {
        await fileUnstartedPipeline(sessionId, outcome.error, sessionLog);
        return;
      }
      sessionLog.info('The pipeline of a new session finished its run', {
        operation: SESSION_CREATE_OPERATION,
        status: outcome.value.status,
        ready: outcome.value.ready,
        planVersion: outcome.value.planVersion,
      });
    };
    run().catch(() => {
      sessionLog.error('The pipeline bookkeeping of a new session failed unexpectedly', {
        operation: SESSION_CREATE_OPERATION,
      });
    });
  }

  /* ----------------------------------------------------------------------------------------------
   * Reads used by the handlers
   * -------------------------------------------------------------------------------------------- */

  /**
   * The dev-server URL a new session of `projectRoot` records: the injected
   * lookup's answer, else the URL the project's most recently updated earlier
   * session recorded, else `undefined` — which the manager refuses with
   * `DEV_SERVER_UNAVAILABLE`.
   */
  async function resolveDevServerUrl(
    projectRoot: string,
    context: RequestContext,
  ): Promise<string | undefined> {
    const lookup = deps.devServers;
    if (lookup !== undefined) {
      try {
        const found = await lookup.devServerUrlFor(projectRoot);
        if (typeof found === 'string' && found.length > 0) {
          return found;
        }
      } catch {
        context.log.warn(
          'The dev-server lookup failed; earlier sessions of the project are consulted',
          {
            operation: context.operation,
          },
        );
      }
    }

    const earlier = settledSync(
      () => manager.list({ projectRoot, limit: 1 }),
      'session-list-threw',
    );
    if (isErr(earlier)) {
      context.log.warn('Earlier sessions of the project could not be listed', {
        operation: context.operation,
        errorCode: earlier.error.code,
      });
      return undefined;
    }
    const latest = earlier.value[0];
    if (latest === undefined) {
      return undefined;
    }
    const record = settledSync(() => manager.get(latest.id), 'session-lookup-threw');
    if (isErr(record) || record.value === undefined) {
      return undefined;
    }
    return record.value.devServerUrl;
  }

  /**
   * Every stored session the principal's announced workspace covers, as full
   * records, most recently updated first. The list is paged through the store
   * at its maximum page size, so the answer is unbounded as protocol requires.
   * A record whose stored document no longer parses is skipped and counted —
   * reopening it would fail the same way, and one corrupt row must not empty the
   * Sessions tree — while any other store failure fails the request.
   */
  function collectSessions(
    principal: Principal,
    context: RequestContext,
  ): Result<SessionRecord[], DebuggenError> {
    const records: SessionRecord[] = [];
    const seen = new Set<string>();
    let unreadable = 0;

    for (let offset = 0; ; offset += MAX_SESSION_LIST_LIMIT) {
      const page = settledSync(
        () => manager.list({ limit: MAX_SESSION_LIST_LIMIT, offset }),
        'session-list-threw',
      );
      if (isErr(page)) {
        return page;
      }
      for (const item of page.value) {
        if (seen.has(item.id) || isErr(requireProjectScope(principal, item.projectRoot))) {
          continue;
        }
        seen.add(item.id);
        const read = settledSync(() => manager.get(item.id), 'session-lookup-threw');
        if (isErr(read)) {
          if (reasonOf(read.error) === 'corrupt-row') {
            unreadable += 1;
            continue;
          }
          return read;
        }
        if (read.value !== undefined) {
          records.push(read.value);
        }
      }
      if (page.value.length < MAX_SESSION_LIST_LIMIT) {
        break;
      }
    }

    if (unreadable > 0) {
      context.log.warn('Unreadable stored sessions were left out of the session list', {
        operation: context.operation,
        unreadable,
      });
    }
    return ok(records);
  }

  /**
   * The session's record once it holds more follow-ups than it did when the
   * question was asked — the follow-up stage records the question before it
   * decides anything — or `undefined` while it does not (a failed read is
   * "not yet": the operation's own settlement still answers the request).
   */
  function recordedFollowUp(sessionId: SessionId, askedBefore: number): SessionRecord | undefined {
    const read = settledSync(() => manager.get(sessionId), 'session-lookup-threw');
    if (isErr(read) || read.value === undefined) {
      return undefined;
    }
    return read.value.followUps.length > askedBefore ? read.value : undefined;
  }

  /**
   * The stored summary of a capture window once it has closed, or `undefined`
   * while it is open, has no summary (a capture that collected nothing), or
   * cannot be read.
   */
  function storedSummary(sessionId: SessionId, captureId: string): CaptureSummary | undefined {
    const read = settledSync(() => sessions.getCapture(captureId), 'capture-lookup-threw');
    if (isErr(read) || read.value?.sessionId !== sessionId) {
      return undefined;
    }
    const { capture } = read.value;
    return capture.stoppedAt === undefined ? undefined : capture.summary;
  }

  /** Whether the orchestrator has no operation in flight for the session; a throw reads as busy. */
  function isPipelineIdle(sessionId: SessionId): boolean {
    try {
      return orchestrator.activeRun(sessionId) === undefined;
    } catch {
      return false;
    }
  }

  /**
   * Cancels the session's pipeline operation in flight, if any, and waits —
   * bounded — for it to settle, so cleanup never runs alongside an installer
   * still writing a patch.
   */
  async function stopInFlight(
    sessionId: SessionId,
    context: RequestContext,
  ): Promise<Result<void, DebuggenError>> {
    let cancelled: boolean;
    try {
      cancelled = orchestrator.cancel(sessionId);
    } catch {
      return err(portFailure('INTERNAL', 'pipeline-cancel-threw'));
    }
    if (!cancelled) {
      return ok(undefined);
    }
    context.log.info('Cancelled the pipeline operation in flight before ending the session', {
      operation: context.operation,
    });
    const idle = await waitUntilIdle(
      () => isPipelineIdle(sessionId),
      pollIntervalMs,
      endSettleTimeoutMs,
    );
    return idle ? ok(undefined) : err(pipelineStillRunning());
  }

  /* ----------------------------------------------------------------------------------------------
   * The handlers
   * -------------------------------------------------------------------------------------------- */

  /** `session.create`: authorize, validate, resolve the dev server, create, start the pipeline. */
  const createSession: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const context: RequestContext = { log, operation: SESSION_CREATE_OPERATION };

    const principal = authorize(c, context);
    if (isErr(principal)) {
      return principal.error;
    }
    const body = await readBody(c, SESSION_CREATE_OPERATION);
    if (isErr(body)) {
      return answerBodyRejection(c, body.error, context);
    }
    const projectRoot = normalizeSessionProjectRoot(body.value.projectRoot);
    if (isErr(projectRoot)) {
      return answerFailure(c, projectRoot.error, context);
    }
    // The editor may act only on a project under the workspace folders its
    // connections announced (AAP §0.5.6), judged on the normalised root.
    const scoped = requireProjectScope(principal.value, projectRoot.value);
    if (isErr(scoped)) {
      return answerFailure(c, scoped.error, context);
    }

    const devServerUrl = await resolveDevServerUrl(projectRoot.value, context);
    const created = await settled(
      () =>
        manager.create({
          projectRoot: projectRoot.value,
          question: body.value.question,
          target: body.value.target,
          devServerUrl,
        }),
      'session-create-rejected',
    );
    if (isErr(created)) {
      return answerFailure(c, created.error, context);
    }

    const session = created.value;
    const sessionContext: RequestContext = {
      log: sessionLogger(log, session.id),
      operation: SESSION_CREATE_OPERATION,
    };
    startPipeline(session.id, sessionContext.log);
    sessionContext.log.info('Created a session and started its pipeline', {
      operation: SESSION_CREATE_OPERATION,
      status: session.status,
      targetSelected: session.target !== undefined,
    });
    return answerSuccess(
      c,
      sessionContext,
      session satisfies HttpResponseBody<typeof SESSION_CREATE_OPERATION>,
    );
  };

  /** `session.list`: every session the editor's announced workspace covers, as full records. */
  const listSessions: SessionRouteHandler = (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const context: RequestContext = { log, operation: SESSION_LIST_OPERATION };

    const principal = authorize(c, context);
    if (isErr(principal)) {
      return principal.error;
    }
    const collected = collectSessions(principal.value, context);
    if (isErr(collected)) {
      return answerFailure(c, collected.error, context);
    }
    context.log.debug('Listed sessions', {
      operation: SESSION_LIST_OPERATION,
      count: collected.value.length,
    });
    return answerSuccess(c, context, {
      sessions: collected.value,
    } satisfies HttpResponseBody<typeof SESSION_LIST_OPERATION>);
  };

  /**
   * `session.get`: the reopen path. The editor's reopen replays the stored
   * session to its connected clients; a DevTools read is a pure read, because
   * its panel received the replay when it bound. Writes nothing either way.
   */
  const getSession: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const admitted = admit(c, SESSION_GET_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, principal, context } = admitted.value;

    const replay = principal.role !== 'devtools';
    const reopened = await settled(
      () => reopener.reopen(sessionId, { replay }),
      'session-reopen-rejected',
    );
    if (isErr(reopened)) {
      return answerFailure(c, reopened.error, context);
    }
    context.log.debug('Reopened a session', {
      operation: SESSION_GET_OPERATION,
      replayed: reopened.value.replayed.length,
      skipped: reopened.value.skipped.length,
      readOnly: reopened.value.readOnly,
      replayInterrupted: reopened.value.replayInterrupted,
    });
    return answerSuccess(
      c,
      context,
      reopened.value.session satisfies HttpResponseBody<typeof SESSION_GET_OPERATION>,
    );
  };

  /**
   * `session.question`: drives the follow-up and answers once the question is
   * recorded, or with the refusal that came first. The follow-up stage records
   * the question itself and chooses the path; nothing here reads the question
   * beyond handing it over.
   */
  const askQuestion: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const admitted = admit(c, SESSION_QUESTION_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, record, context } = admitted.value;
    const body = await readBody(c, SESSION_QUESTION_OPERATION);
    if (isErr(body)) {
      return answerBodyRejection(c, body.error, context);
    }

    const askedBefore = record.followUps.length;
    const running = settled(
      () => orchestrator.followUp({ sessionId, question: body.value.question }),
      'follow-up-rejected',
    );
    const race = await raceEffect(
      running,
      () => recordedFollowUp(sessionId, askedBefore),
      pollIntervalMs,
    );
    if (race.kind === 'observed') {
      observeInBackground(running, context);
      context.log.info('Recorded a follow-up question; its answer continues', {
        operation: SESSION_QUESTION_OPERATION,
        status: race.effect.status,
      });
      return answerSuccess(
        c,
        context,
        race.effect satisfies HttpResponseBody<typeof SESSION_QUESTION_OPERATION>,
      );
    }

    const outcome = race.outcome;
    if (isErr(outcome)) {
      return answerFailure(c, outcome.error, context);
    }
    context.log.info('Answered a follow-up question', {
      operation: SESSION_QUESTION_OPERATION,
      path: outcome.value.path,
      status: outcome.value.status,
    });
    const latest = loadSession(manager, sessionId);
    if (isErr(latest)) {
      return answerFailure(c, latest.error, context);
    }
    return answerSuccess(
      c,
      context,
      latest.value satisfies HttpResponseBody<typeof SESSION_QUESTION_OPERATION>,
    );
  };

  /**
   * `session.end`: stops the pipeline operation in flight, then ends the
   * session through the manager, whose cleanup runner restores every
   * modification. The cleanup status is the runner's verdict, verbatim.
   */
  const endSession: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const admitted = admit(c, SESSION_END_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, context } = admitted.value;
    const body = await readBody(c, SESSION_END_OPERATION);
    if (isErr(body)) {
      return answerBodyRejection(c, body.error, context);
    }

    const stopped = await stopInFlight(sessionId, context);
    if (isErr(stopped)) {
      return answerFailure(c, stopped.error, context);
    }
    const ended = await settled(() => manager.end(sessionId), 'session-end-rejected');
    if (isErr(ended)) {
      return answerFailure(c, ended.error, context);
    }

    const { cleanup } = ended.value;
    context.log.info('Ended a session', {
      operation: SESSION_END_OPERATION,
      cleanupStatus: cleanup.status,
      conflicts: cleanup.conflicts.length,
    });
    return answerSuccess(c, context, {
      cleanup: cleanup.status,
    } satisfies HttpResponseBody<typeof SESSION_END_OPERATION>);
  };

  /**
   * `capture.start`: opens and arms a capture window through the orchestrator,
   * whose readiness gate and arming run first. Another session's capture on the
   * project is the manager's typed conflict, answered `409 { owningSessionId }`.
   */
  const startCapture: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const admitted = admit(c, CAPTURE_START_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, context } = admitted.value;
    const body = await readBody(c, CAPTURE_START_OPERATION);
    if (isErr(body)) {
      return answerBodyRejection(c, body.error, context);
    }

    const begun = await settled(
      () => orchestrator.beginCapture({ sessionId }),
      'capture-begin-rejected',
    );
    if (isErr(begun)) {
      return answerFailure(c, begun.error, context);
    }

    const { captureId } = begun.value;
    const captureContext: RequestContext = {
      log: sessionLogger(log, sessionId, captureId),
      operation: CAPTURE_START_OPERATION,
    };
    captureContext.log.info('Started a capture', {
      operation: CAPTURE_START_OPERATION,
      planVersion: begun.value.planVersion,
      readinessSource: begun.value.readinessSource,
      degradations: begun.value.degradations.length,
    });
    return answerSuccess(c, captureContext, {
      captureId,
    } satisfies HttpResponseBody<typeof CAPTURE_START_OPERATION>);
  };

  /**
   * `capture.stop`: completes the capture through the orchestrator and answers
   * with its summary once the window has closed; analysis and panel
   * generation continue and announce themselves.
   */
  const stopCapture: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const admitted = admit(c, CAPTURE_STOP_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, context } = admitted.value;
    const body = await readBody(c, CAPTURE_STOP_OPERATION);
    if (isErr(body)) {
      return answerBodyRejection(c, body.error, context);
    }

    // The window this request closes, read before the orchestrator runs, so a
    // summary observed later is provably this window's and no earlier one's.
    const open = settledSync(() => sessions.getActiveCapture(sessionId), 'capture-lookup-threw');
    if (isErr(open)) {
      return answerFailure(c, open.error, context);
    }
    const openCaptureId = open.value?.capture.id;

    const running = settled(
      () => orchestrator.completeCapture({ sessionId }),
      'capture-complete-rejected',
    );
    const race =
      openCaptureId === undefined
        ? ({ kind: 'settled', outcome: await running } as const)
        : await raceEffect(running, () => storedSummary(sessionId, openCaptureId), pollIntervalMs);

    if (race.kind === 'observed') {
      observeInBackground(running, context);
      context.log.info('Stopped a capture; its analysis continues', {
        operation: CAPTURE_STOP_OPERATION,
      });
      return answerSuccess(c, context, {
        summary: race.effect,
      } satisfies HttpResponseBody<typeof CAPTURE_STOP_OPERATION>);
    }

    const outcome = race.outcome;
    if (isErr(outcome)) {
      return answerFailure(c, outcome.error, context);
    }
    context.log.info('Completed a capture', {
      operation: CAPTURE_STOP_OPERATION,
      emptyCapture: outcome.value.emptyCapture,
      ...(outcome.value.panelVersion === undefined
        ? {}
        : { panelVersion: outcome.value.panelVersion }),
      ...(outcome.value.fallback === undefined ? {} : { fallbackPanel: outcome.value.fallback }),
    });
    return answerSuccess(c, context, {
      summary: outcome.value.summary,
    } satisfies HttpResponseBody<typeof CAPTURE_STOP_OPERATION>);
  };

  /**
   * `panel.get`: the session's current panel exactly as stored, or `null` when
   * none was generated yet — a success either way, a fallback panel included.
   */
  const getCurrentPanel: SessionRouteHandler = (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const admitted = admit(c, PANEL_GET_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, context } = admitted.value;

    const latest = settledSync(() => panels.getLatestPanel(sessionId), 'panel-lookup-threw');
    if (isErr(latest)) {
      return answerFailure(c, latest.error, context);
    }
    const panel: PanelSpec | null = latest.value ?? null;
    // The stored specification is deeply `readonly`; protocol's inferred
    // response type is not, so the shape is stated over the stored type.
    return answerSuccess(c, context, { panel } satisfies { readonly panel: PanelSpec | null });
  };

  /**
   * `panel.getById`: one panel version of the session, exactly as stored. An id
   * no panel of this session holds is `404`, whether it is malformed, unknown
   * or another session's.
   */
  const getPanelById: SessionRouteHandler = (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const admitted = admit(c, PANEL_GET_BY_ID_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, context } = admitted.value;

    const panelId = c.req.param(PANEL_ID_PARAM);
    if (!isWellFormedPanelRouteId(panelId)) {
      return answerFailure(c, panelNotFound('malformed-panel-id'), context);
    }
    const read = settledSync(() => panels.getPanel(panelId), 'panel-lookup-threw');
    if (isErr(read)) {
      return answerFailure(c, read.error, context);
    }
    const panel: PanelSpec | undefined = read.value;
    if (panel?.sessionId !== sessionId) {
      return answerFailure(c, panelNotFound('unknown-panel'), context);
    }
    return answerSuccess(c, context, { panel } satisfies { readonly panel: PanelSpec });
  };

  /**
   * `modifications.list`: the session's modification journal in application
   * order. The records carry unified diffs, so nothing about them but their
   * count is ever logged.
   */
  const listModifications: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const admitted = admit(c, MODIFICATIONS_LIST_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, context } = admitted.value;

    const listed = await settled(
      () => modifications.listBySession(sessionId),
      'modifications-lookup-rejected',
    );
    if (isErr(listed)) {
      return answerFailure(c, listed.error, context);
    }
    context.log.debug('Listed modifications', {
      operation: MODIFICATIONS_LIST_OPERATION,
      count: listed.value.length,
    });
    return answerSuccess(c, context, {
      modifications: listed.value,
    } satisfies HttpResponseBody<typeof MODIFICATIONS_LIST_OPERATION>);
  };

  return Object.freeze({
    [SESSION_CREATE_OPERATION]: createSession,
    [SESSION_LIST_OPERATION]: listSessions,
    [SESSION_GET_OPERATION]: getSession,
    [SESSION_QUESTION_OPERATION]: askQuestion,
    [SESSION_END_OPERATION]: endSession,
    [CAPTURE_START_OPERATION]: startCapture,
    [CAPTURE_STOP_OPERATION]: stopCapture,
    [PANEL_GET_OPERATION]: getCurrentPanel,
    [PANEL_GET_BY_ID_OPERATION]: getPanelById,
    [MODIFICATIONS_LIST_OPERATION]: listModifications,
  });
}
