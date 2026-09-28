/**
 * The session slice of the local service's HTTP surface: the twelve operations
 * of protocol's route table that create, list, reopen, question, capture, end,
 * read and purge debugging sessions, and that ask a session's bound DevTools
 * tab for an element (AAP §0.4.2).
 *
 * | Operation | Route | Answer |
 * | --- | --- | --- |
 * | `session.create` | `POST /sessions` | the created `SessionRecord` |
 * | `session.list` | `GET /sessions` | one page `{ sessions: SessionListItem[], total, limit, offset, nextOffset }` |
 * | `session.get` | `GET /sessions/:id` | the (reopened) `SessionRecord` |
 * | `session.question` | `POST /sessions/:id/question` | the `SessionRecord` holding the follow-up |
 * | `session.end` | `POST /sessions/:id/end` | `{ cleanup: CleanupStatus }` |
 * | `session.purge` | `POST /sessions/purge` | the retention sweep's report: counts, the sessions kept for a conflict |
 * | `capture.start` | `POST /sessions/:id/capture/start` | `{ captureId }`, or `409 { owningSessionId }` |
 * | `capture.stop` | `POST /sessions/:id/capture/stop` | `{ summary }` |
 * | `target.request` | `POST /sessions/:id/target/request` | `{ sessionId, tabId }` once the bound tab's connection took the `target.request` push |
 * | `panel.get` | `GET /sessions/:id/panel` | `{ panel: PanelSpec \| null }` |
 * | `panel.getById` | `GET /sessions/:id/panels/:panelId` | `{ panel: PanelSpec }`, or `404` |
 * | `modifications.list` | `GET /sessions/:id/modifications` | one diff-budgeted page `{ modifications: ModificationRecord[], total, limit, offset, nextOffset }` |
 *
 * Every path, parameter name, body schema and response schema is read from
 * protocol's `HTTP_ROUTES`; nothing here restates one.
 *
 * ## The two paged listings
 *
 * `session.list` and `modifications.list` answer one page each, never the whole
 * store (protocol's Section C.1). The window comes from the `limit` and
 * `offset` query parameters through protocol's `parseListPageQuery` — a
 * malformed or oversized one is answered exactly as a malformed body is: `400`
 * in the parser's own words, which name the offending parameter and never its
 * value — with the listing's documented default `limit` and offset `0` filled
 * in and echoed.
 * Each page is read by one repository call that counts and pages in SQL:
 *
 * - `session.list` reads list rows (`SessionListItem`) scoped **in SQL** to
 *   the editor's announced workspace folders
 *   (`SessionsRepo.listWithinFolders`), never a whole record; a stored row
 *   that cannot be read is left out, counted, and moved past.
 * - `modifications.list` reads the journal in application order and ends a
 *   page early rather than let its diffs exceed protocol's
 *   `MODIFICATIONS_PAGE_DIFF_BUDGET` of UTF-8 bytes
 *   (`ModificationsRepo.listPageBySession`, which measures each diff before
 *   reading it); `limit=0` counts without reading a diff.
 *
 * `nextOffset` is the offset just past the rows the page consumed, or `null`
 * when nothing remains after them.
 *
 * ## Authorization, validation, delegation — and nothing else
 *
 * Every hard decision already has an owner, and this module defers to it:
 *
 * - **Status writes and lifecycle broadcasts** — `session.created`,
 *   `session.updated`, `capture.started`, `capture.stopped`,
 *   `cleanup.completed` — belong to `../../sessions/manager.ts`. This module
 *   writes no status, touches no state machine and broadcasts nothing.
 * - **Which connection carries a session's tab** belongs to `../clients.ts`.
 *   The one frame this module sends, `target.request`, is handed to the
 *   registry's `sendToBoundTab`, which delivers it to the connection of the
 *   session's bound tab alone — never a fan-out, never a tab the request
 *   names.
 * - **Stage sequencing**, `session.progress`, both follow-up paths and the
 *   readiness gate belong to `../../pipeline/orchestrator.ts`.
 * - **The replay of a reopened session** belongs to
 *   `../../sessions/reopen.ts`.
 * - **Cleanup** runs inside `SessionManager.end` through its injected runner;
 *   this module never imports the cleanup module and never reports a cleanup
 *   status it did not receive.
 * - **Panel validation** happened before a panel was stored; a stored panel is
 *   served exactly as stored, a `meta.fallback` panel included.
 * - **Retention** belongs to `../../store/retention.ts`, reached through the
 *   injected {@link SessionRetentionPort}: which sessions have aged out, the
 *   conflict-backup exemption, the orphan-backup grace and every deletion are
 *   its decisions. `session.purge` only authorizes, scopes the sweep to the
 *   editor's announced workspace, runs one sweep at a time and reports the
 *   sweep's counts.
 *
 * What remains here is the request boundary, applied in a fixed order so a
 * caller that fails an early step learns nothing about a later one:
 *
 * 1. the principal `../auth.ts`'s middleware resolved must hold a role
 *    `OPERATION_ROLES` grants the operation — a `server-agent` credential never
 *    reaches a session route;
 * 2. the `:id` (and `:panelId`) path parameters, named by the route table, must
 *    have the shape of the ids `@debuggen/shared` mints;
 * 3. a `devtools` principal must name the inspected tab it acts for (the
 *    acting-tab header, verified by the auth middleware as
 *    `c.get('actingTabId')`) and that tab must be the session's live bound
 *    tab, bound by its own credential (`requireBoundSession`), checked
 *    **before** the store is read — one paired credential serves every
 *    inspected tab, so the credential alone never proves which tab asks;
 * 4. the session must exist, and the per-session access matrix must admit the
 *    principal (`requireSessionAccess`: an editor by the workspace folders it
 *    announced, a DevTools client by its binding) — decided on the stored
 *    record, except for `modifications.list`, which never needs the record and
 *    decides on the id and project root `SessionsRepo.getAccessTarget` reads
 *    from the store's projection columns;
 * 5. a `POST` body must satisfy the operation's request schema through
 *    `parseHttpRequest`, bounded in size before it is parsed;
 * 6. a `POST` must pass the **revocation fence**: the credential the
 *    middleware resolved the principal from must still be live
 *    (`AuthService.requireLiveCredential`), checked after the handler's last
 *    `await` and immediately before the owning subsystem is called;
 * 7. the owning subsystem is called;
 * 8. its answer is checked against the operation's response schema through
 *    `parseHttpResponse` and sent unchanged.
 *
 * Authorization comes from the resolved principal only — never from a body
 * field, a header the client controls or a client's description of itself.
 *
 * ## The revocation fence
 *
 * The middleware resolves the principal once, before the handler runs; every
 * `POST` handler then awaits the client's body, for as long as the client
 * chooses. A credential retired inside that wait — by `POST
 * /credentials/rotate` on another connection, by an expiry — must authorize
 * nothing, or a stalled body would let a revoked editor credential create,
 * question, capture, end or purge (AAP §0.5.6). Every `POST` handler therefore
 * calls one fence, {@link requireLivePrincipal}, with no `await` between it
 * and the call that acts; a retired credential is answered `401`
 * (`unknown-credential` / `expired-credential`) and nothing runs.
 *
 * The check and every retirement are synchronous, so no rotation can run
 * between a fence that passed and the synchronous start of the call it
 * guards: `SessionManager.create` stores the session synchronously and the
 * retention sweep, the follow-up, the capture calls and the ending all start
 * in the same turn. The fence guards **initiation**; an operation started
 * under a then-live credential — a sweep, a follow-up, an ending waiting for
 * its cleanup — finishes, exactly as a request authorized before a rotation
 * still receives its answer. `session.create` is fenced after its dev-server
 * lookup, which awaits, and before the manager call — the same point at which
 * it re-proves its project root (next section). The `GET` handlers read
 * no body and await nothing before their effect, so the middleware's check,
 * made in the same turn, is already the fence for them.
 *
 * ## The project root a session is created for
 *
 * A scope check answers only for the moment it runs, and `session.create`
 * awaits twice after it — the state-root check and the dev-server lookup — so
 * a link on the root's path retargeted in between, even to another directory
 * inside the workspace, would otherwise be stored as the root the pipeline
 * indexes and patches (CWE-367). The root is therefore held to one canonical
 * directory from admission to storage:
 *
 * 1. `admitProjectRoot` (`../auth.ts`) admits it for the editor — under an
 *    announced workspace folder both as spelled and once every link is
 *    resolved — and returns the proof: the root and the canonical path it was
 *    judged on. It is `requireProjectScope`'s editor rule, and `session.create`
 *    is the editor's alone.
 * 2. The state-root separation is judged on that canonical path, the
 *    directory actually admitted.
 * 3. After the dev-server lookup's `await`, at the revocation fence,
 *    `reconfirmProjectRoot` re-proves synchronously that the root is still in
 *    scope and still resolves to the admitted path, with no `await` before
 *    `SessionManager.create` stores the session. A root that moved is refused
 *    `403 PATH_OUTSIDE_PROJECT`, the dev-server hold is given up, and nothing
 *    is stored, broadcast or started.
 * 4. The re-proved proof is handed to `SessionManager.create`, which records it
 *    against the new session; the pipeline's indexing and patching are held to
 *    it through `SessionManager.confirmProjectRoot`, immediately before each
 *    acts, in the canonical directory it proves.
 *
 * The session records the root as the editor spelled it, and the dev server
 * is looked up by that spelling, which is how the launcher and earlier
 * sessions know the project.
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
 *   the follow-up stage has recorded the ask on the session (it records it
 *   itself, which is why this module never calls `appendFollowUp`: the
 *   question would be stored twice). The ask is keyed by protocol's
 *   `attemptId` — the body's, or one minted here — and its recording is
 *   recognised by that attempt's counter growing, so a Retry recorded in place
 *   of a failed attempt is answered as promptly as a new follow-up. A refusal
 *   that comes first — a session in a status no follow-up starts from, another
 *   operation in flight, an attempt that was already answered or superseded —
 *   is answered as the error it is. Which of the two follow-up paths runs is
 *   the orchestrator's decision; a client learns it from the frames that
 *   follow.
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
 * - `target.request` answers as soon as the `target.request { sessionId }`
 *   push has been written to the bound tab's live connection. It never waits
 *   for an element: picking is the developer's and may never happen, and the
 *   panel's answer — a `target.selected` frame — reaches the editor as the
 *   `session.updated` that carries the new target. An ended session is
 *   refused `409 SESSION_INVALID_STATE`, a session with no bound tab
 *   `409 TAB_NOT_BOUND`, and a bound tab whose DevTools connection is offline
 *   `503 TRANSPORT_DISCONNECTED` — in that order, and each before anything is
 *   sent (protocol's `http.ts`, Section D2).
 * - `session.purge` answers once the retention sweep has finished, with what it
 *   removed. The sweep is **scoped** to the requesting editor: it acts only on
 *   the state of projects under the workspace folders the editor's credential
 *   announced — the very check `requireProjectScope` makes for the other
 *   routes and `admitProjectRoot`, its editor rule, for `session.create`,
 *   joined by a canonical one: the folders and each stored
 *   root are resolved on disk, and a root is admitted only when its real
 *   location lies under a real folder — so a purge for workspace A never
 *   removes workspace B's sessions, telemetry, backups or index caches, not
 *   even through a link inside A that points into B (CWE-863); the start-up
 *   sweep in `main.ts` alone is machine-wide. Sweeps are serialised: a purge
 *   requested while a sweep for the **same** folder set is running or queued
 *   joins it and receives the same report, and one for another folder set
 *   waits for the sweep before it, so two sweeps never race over the same rows
 *   and files and no editor receives a sweep — or a report — started for
 *   another workspace. The sweep only ever deletes sessions last updated
 *   before the `DEBUGGEN_RETENTION_DAYS` window; a session inside the window —
 *   every active one — is never touched, and an aged session whose journal
 *   holds a `conflict` record is kept, with its backups, and named in the
 *   report instead (AAP §0.5.1). Per-item problems the sweep stepped over are
 *   a count, never a failure of the request.
 *
 * Work that continues after a reply never rejects unobserved: its outcome is
 * logged by code, and a failure of it is filed on the session by the
 * orchestrator itself.
 *
 * ## Finding the session's dev server
 *
 * A session is created "with a `projectRoot` and the project's dev-server URL
 * (probed or launched)" (AAP §0.2.3). The URL comes from the first source that
 * knows one:
 *
 * 1. **A dev server the service launched** for the project and that serves —
 *    {@link SessionDevServerLookup.acquireLaunched} (else
 *    {@link SessionDevServerLookup.devServerUrlFor}), in production the
 *    launcher's registry adapted by {@link devServerLookupFromLaunches}. It is
 *    known to carry the telemetry preload. The lookup **holds** that dev server
 *    while the session is created: once the session exists the hold is handed
 *    to it (a child launched for sessions counts it among its owners), and if
 *    creation fails the hold is given up. So no other session's end can stop
 *    the dev server between choosing its URL and recording it.
 * 2. **The URL the editor sent** (`session.create`'s optional `devServerUrl`) —
 *    the developer's own dev server, which the editor found answering at its
 *    `debuggen.devServerUrl` setting. The service never records a client's
 *    word unverified: {@link SessionDevServerLookup.verifyRequestedUrl} probes
 *    it on loopback first. A URL that names another host is refused `400`; one
 *    that does not answer is refused `503` with the instruction to start or
 *    launch the dev server. One that answers is recorded whether or not a
 *    preload is connected for the project: an **untraced** external server
 *    still serves browser-side signals, and the capture readiness gate names
 *    the missing server signals with the exact relaunch command (AAP §0.5.5).
 *    An HTTP answer proves only that *something* serves there. Whether that
 *    process carries the preload is attributed only through the launcher's
 *    own evidence (a child it started, serving at that origin, whose own
 *    credential's preload is connected) — never through some connected preload
 *    of the project, which may belong to another dev server — so a URL the
 *    editor sent is recorded untraced unless the launcher vouches for it.
 *    Without a verifier the URL is not used.
 * 3. **The URL the project's most recent earlier session recorded.**
 *
 * When none knows one, `SessionManager.create` refuses the session with
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
 * | credential retired or expired while the body was read | `401` | `UNAUTHORIZED` |
 * | role not permitted (a `server-agent` credential, a DevTools create) | `403` | `UNAUTHORIZED` |
 * | DevTools client not bound to the session | `403` | `TAB_NOT_BOUND` |
 * | editor credential outside its announced workspace; a new session's root relinked after it was admitted | `403` | `PATH_OUTSIDE_PROJECT` |
 * | malformed or unknown session id | `404` | `SESSION_NOT_FOUND` |
 * | malformed or unknown panel id, or a panel of another session | `404` | `SESSION_NOT_FOUND` |
 * | project root that is not absolute | `400` | `PROJECT_NOT_FOUND` |
 * | project root (of a new session or a follow-up) that is, contains or lies inside `$DEBUGGEN_HOME`, or cannot be resolved on disk | `400` | `FS_UNSAFE_PATH` |
 * | body larger than the operation's bound, declared or as it arrives | `413` | `PROTOCOL_INVALID_MESSAGE` |
 * | body that did not arrive within `../http.ts`'s time ceiling | `408` | `PROTOCOL_INVALID_MESSAGE` |
 * | unreadable, non-JSON or off-schema body; a sent dev-server URL that is not a loopback address | `400` | `PROTOCOL_INVALID_MESSAGE` |
 * | a listing's `limit`/`offset` malformed or above its ceiling, or a query parameter it does not accept | `400` | `PROTOCOL_INVALID_MESSAGE` |
 * | another session holds the project's capture | `409` | `CAPTURE_ALREADY_ACTIVE`, plus `owningSessionId` |
 * | a request the session's state does not admit, a busy pipeline | `409` | `SESSION_INVALID_STATE` |
 * | a capture refused by the readiness gate: no bound tab, no page agent, no preload | `409` | `TAB_NOT_BOUND`, `AGENT_NOT_READY`, `SERVER_AGENT_NOT_READY` |
 * | an element requested of a session no tab is bound to | `409` | `TAB_NOT_BOUND` |
 * | a stage's model, plan, panel or patch output refused | `422` | the stage's code |
 * | no dev-server URL (or a sent one nothing answers at), the model provider or a signal unavailable | `503` | the failure's code |
 * | the bound tab's DevTools connection offline, so no frame could reach it | `503` | `TRANSPORT_DISCONNECTED` |
 * | store failure, cleanup failure, a retention sweep that could not run, subsystem defect, response drift | `500` | the failure's code, fixed message, diagnostic `ref` |
 *
 * The capture-ownership `409` is rendered here, in exactly one place: the
 * manager's typed {@link CaptureConflictError} is recognised with
 * `isCaptureConflict` and answered with `captureStartConflictResponseSchema`,
 * `owningSessionId` intact. A session asking for a second capture of its own is
 * a plain `SESSION_INVALID_STATE` `409` without an owning session, exactly as
 * protocol describes.
 *
 * Validation messages come from `parseHttpRequest` for a body and from
 * `parseListPageQuery` for a listing's window, and are sent as those parsers
 * built them: issue paths and codes rendered by `describeZodIssues`, or a
 * constant sentence naming the parameter over its ceiling — never a rejected
 * value. A `500` never carries the failure's own words: it carries a fixed
 * message and a freshly minted `ref`. A described failure is sent in its own
 * words only when its code is a lifecycle, readiness or request-content
 * refusal and `isProductAuthoredText` proves its message product text — so a
 * refused `devServerUrl` is answered with a constant sentence naming the
 * field, never the URL; a failure a collaborator reported (the installer,
 * cleanup, the model provider, the dev server), a wrapped exception's text,
 * and any refusal sentence no product builder registered are answered with
 * the code's fixed copy from `../../sessions/progress.ts` and a `ref`
 * (CWE-209). Every `ref` is repeated by the failure's log record and by
 * that record's `debug` twin, which alone carries the failure's redacted
 * message and stack. Log records carry the operation, a
 * status, an error code, a kebab-case reason and counts — never a question, a
 * project path, a diff, a panel, a capture summary, a header or a token. Every
 * response carries `Cache-Control: no-store`, and no
 * `Access-Control-Allow-Origin` header is ever set.
 *
 * ## What this module does not do
 *
 * It registers nothing, builds no hono application, opens no socket, database
 * or child process, reads no `process.env` and holds no state between requests
 * beyond the retention sweeps `session.purge` requests have running or queued.
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
 *   retention: { purge: (scope) => runRetention(retentionDeps, { scope }) },
 *   auth,
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
  FOLLOW_UP_ATTEMPT_ID_PREFIX,
  HTTP_ROUTES,
  MODIFICATIONS_PAGE_DEFAULT_LIMIT,
  MODIFICATIONS_PAGE_DIFF_BUDGET,
  MODIFICATIONS_PAGE_MAX_LIMIT,
  SESSION_LIST_DEFAULT_LIMIT,
  SESSION_LIST_MAX_LIMIT,
  SESSION_PURGE_MAX_REPORTED_SESSIONS,
  captureStartConflictResponseSchema,
  createEnvelope,
  httpErrorResponseSchema,
  parseHttpRequest,
  parseHttpResponse,
  parseListPageQuery,
  toErrorPayload,
} from '@debuggen/protocol';
import type {
  CaptureStartConflictResponse,
  CaptureSummary,
  HttpErrorResponse,
  HttpRequestBody,
  HttpResponseBody,
  ListPageBounds,
  MessageType,
  PanelSpec,
  ProgressStage,
  SessionListItem,
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
  isWithin,
  newId,
  newMessageId,
  noopLogger,
  normalizePosix,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result, SessionId } from '@debuggen/shared';

import {
  PROJECT_ROOT_UNRESOLVABLE_REASON,
  STATE_HOME_OVERLAP_REASON,
  canonicalizePath,
  requireProjectOutsideStateHome,
} from '../../config.js';
import type { DevServerProbeResult } from '../../dev-server/detect.js';
import { LOG_ERROR_FIELD_KEY, sessionLogger, subsystemLogger } from '../../logging.js';
import type { PipelineOrchestrator } from '../../pipeline/orchestrator.js';
import { isCaptureConflict } from '../../sessions/manager.js';
import type { CaptureConflictError, SessionManager } from '../../sessions/manager.js';
import {
  FAILURE_COPY_BY_CODE,
  authorProductText,
  isProductAuthoredText,
} from '../../sessions/progress.js';
import type { SessionReopener } from '../../sessions/reopen.js';
import { isTerminalSessionStatus } from '../../sessions/state-machine.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import type { ModificationsRepo } from '../../store/modifications-repo.js';
import type { PanelsRepo } from '../../store/panels-repo.js';
import type { RetentionReport, RetentionScope } from '../../store/retention.js';
import type { SessionsRepo } from '../../store/sessions-repo.js';
import {
  AUTH_FAILURE_REASONS,
  OPERATION_ROLES,
  admitProjectRoot,
  authErrorResponse,
  authFailureStatus,
  reconfirmProjectRoot,
  requireBoundSession,
  requireProjectScope,
  requireRole,
  requireSessionAccess,
} from '../auth.js';
import type {
  AdmittedProjectRoot,
  AuthFailureReason,
  AuthService,
  AuthenticatedOperation,
  Principal,
  PrincipalRole,
  ServerEnv,
  SessionAccessTarget,
  TabBinding,
} from '../auth.js';
import type { ClientRegistry, DeliveryReceipt } from '../clients.js';
import { redactSelectedTarget } from './binding.js';

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
/** `POST /sessions/purge`. */
const PURGE_ROUTE = HTTP_ROUTES['session.purge'];
/** `POST /sessions/:id/capture/start`. */
const CAPTURE_START_ROUTE = HTTP_ROUTES['capture.start'];
/** `POST /sessions/:id/capture/stop`. */
const CAPTURE_STOP_ROUTE = HTTP_ROUTES['capture.stop'];
/** `POST /sessions/:id/target/request`. */
const TARGET_REQUEST_ROUTE = HTTP_ROUTES['target.request'];
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
/** `session.purge`. */
export const SESSION_PURGE_OPERATION = PURGE_ROUTE.operation satisfies AuthenticatedOperation;
/** `capture.start`. */
export const CAPTURE_START_OPERATION =
  CAPTURE_START_ROUTE.operation satisfies AuthenticatedOperation;
/** `capture.stop`. */
export const CAPTURE_STOP_OPERATION = CAPTURE_STOP_ROUTE.operation satisfies AuthenticatedOperation;
/** `target.request`. */
export const TARGET_REQUEST_OPERATION =
  TARGET_REQUEST_ROUTE.operation satisfies AuthenticatedOperation;

/**
 * The WebSocket message the `target.request` operation is answered with: the
 * route's own operation id, because protocol names the editor→service HTTP leg
 * and the service→panel WebSocket leg of the one instruction identically
 * (`http.ts`, Section D2). `satisfies MessageType` is the compile-time proof
 * that the name still is a WebSocket message type, so a rename on either side
 * of protocol stops this line compiling rather than sending a frame no panel
 * recognises.
 */
const TARGET_REQUEST_MESSAGE = TARGET_REQUEST_OPERATION satisfies MessageType;

/** `panel.get`. */
export const PANEL_GET_OPERATION = PANEL_ROUTE.operation satisfies AuthenticatedOperation;
/** `panel.getById`. */
export const PANEL_GET_BY_ID_OPERATION =
  PANEL_BY_ID_ROUTE.operation satisfies AuthenticatedOperation;
/** `modifications.list`. */
export const MODIFICATIONS_LIST_OPERATION =
  MODIFICATIONS_ROUTE.operation satisfies AuthenticatedOperation;

/**
 * The protocol operations this module answers: exactly twelve, in the route
 * table's order. `../http.ts` builds an exhaustive
 * `Record<HttpOperationId, handler>` from the route modules, and this tuple is
 * this module's slice of it.
 */
export const SESSION_ROUTE_OPERATIONS = Object.freeze([
  SESSION_CREATE_OPERATION,
  SESSION_LIST_OPERATION,
  SESSION_GET_OPERATION,
  SESSION_QUESTION_OPERATION,
  SESSION_END_OPERATION,
  SESSION_PURGE_OPERATION,
  CAPTURE_START_OPERATION,
  CAPTURE_STOP_OPERATION,
  TARGET_REQUEST_OPERATION,
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
 * (`session.end`, `session.purge`, `capture.start`, `capture.stop`,
 * `target.request`), in bytes. `{}` is two; the bound leaves room for
 * whitespace and refuses anything that is plainly not an empty object without
 * reading it.
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

/**
 * The status of a listing whose `limit`/`offset` window was refused: the `400`
 * a malformed body gets.
 */
const LIST_WINDOW_REFUSED_STATUS = 400;

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

/** The `msg` of the `error` record of a session request answered `5xx`. */
export const SESSION_REQUEST_FAILED_LOG_MESSAGE = 'A session request failed';

/** The `msg` of the `warn` record of a session request answered `4xx`. */
export const SESSION_REQUEST_REFUSED_LOG_MESSAGE = 'A session request was refused';

/**
 * The `msg` of the `debug` twin of a failure answered with a diagnostic `ref`:
 * the same operation, status, code and reference as the
 * {@link SESSION_REQUEST_FAILED_LOG_MESSAGE} or
 * {@link SESSION_REQUEST_REFUSED_LOG_MESSAGE} record, with the failure under
 * `LOG_ERROR_FIELD_KEY`.
 *
 * Written at `debug` because only there does the service's error serializer
 * add the failure's redacted message and stack, so the `ref` a client was
 * answered with leads, once `DEBUGGEN_LOG_LEVEL=debug` is set, to the
 * detailed local diagnostic — and at the default level to the closed shape
 * only.
 */
export const SESSION_REQUEST_DIAGNOSTIC_MESSAGE =
  'The diagnostic of a session request answered under this reference';

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
 * The message of a `500` answering `session.purge`: the sweep could not run,
 * or stopped on a defect. What it removed before stopping stays removed and
 * nothing active was touched, so purging again is safe.
 */
const PURGE_UNAVAILABLE_MESSAGE =
  'Debug Generator could not complete the retention sweep. Sessions inside the retention window were not touched; purge again to retry, and see the service log for the reason.';

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

/**
 * The message of a `400` for a `session.create` whose `devServerUrl` the
 * service's probe will not dial: another host, a scheme other than `http:` or
 * `https:`, or embedded credentials.
 *
 * Worded like the schema refusals of the same body that `parseHttpRequest`
 * builds ("Invalid session.create request body: devServerUrl (custom)"), so
 * every refusal of the field names it and a client learns which field to fix.
 * It names the field and the requirement only — never the rejected URL, its
 * host or its credentials (CWE-209). Exported so a client-facing test can
 * hold the reply to these exact words.
 */
export const REQUESTED_DEV_SERVER_URL_REFUSED_MESSAGE =
  'Invalid session.create request body: devServerUrl must be a loopback http: or https: address without credentials.';

/** The recovery instruction of {@link REQUESTED_DEV_SERVER_URL_REFUSED_MESSAGE}. */
const REQUESTED_DEV_SERVER_URL_REFUSED_HINT =
  'Set debuggen.devServerUrl to the local address the dev server prints, for example http://localhost:<port>.';

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

/** The message of an element requested of a session that has ended. */
const TARGET_SESSION_ENDED_MESSAGE =
  'This Debug Generator session has ended, so no element can be selected for it.';

/** The recovery instruction of {@link TARGET_SESSION_ENDED_MESSAGE}. */
const TARGET_SESSION_ENDED_HINT =
  'Start a new session from the Debug Generator view in VS Code, then pick the element for it.';

/** The message of an element requested of a session no Chrome tab is bound to. */
const TARGET_NO_BOUND_TAB_MESSAGE =
  'No Chrome tab is bound to this session, so there is no Debug Generator panel to pick an element in.';

/** The recovery instruction of {@link TARGET_NO_BOUND_TAB_MESSAGE}. */
const TARGET_NO_BOUND_TAB_HINT =
  'Open Chrome DevTools on the application’s tab and select the Debug Generator panel, then request the element again.';

/** The message of an element requested of a bound tab whose DevTools connection is offline. */
const TARGET_TAB_OFFLINE_MESSAGE =
  'The Debug Generator panel of the bound Chrome tab is not connected, so it could not be asked to pick an element.';

/** The recovery instruction of {@link TARGET_TAB_OFFLINE_MESSAGE}. */
const TARGET_TAB_OFFLINE_HINT =
  'Keep Chrome DevTools open on that tab; the Chrome extension reconnects on its own. Then request the element again.';

/* -------------------------------------------------------------------------------------------------
 * Public types — the ports this module declares, its dependencies and its handlers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The tab bindings this module reads and the one delivery it makes through
 * them: the binding recorded for a session, carrying the `tokenHash` of the
 * DevTools credential that made it, and the single-recipient path to the
 * connection that carries the session's bound tab.
 *
 * A consumer-declared port whose lookup half is identical in shape to the one
 * `./panel-data.ts` declares, so `../http.ts` hands both modules the same
 * object: the client registry of `../clients.ts` satisfies it structurally.
 * The binding — and so the recipient of `target.request` — is read from the
 * registry the connection's principal recorded it in, never from anything the
 * request says about its tab.
 */
export interface SessionBindingLookup extends Pick<ClientRegistry, 'sendToBoundTab'> {
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

  /**
   * Checks a dev-server URL the creating client supplied before it is
   * recorded: it must name this machine and answer.
   *
   * Optional; without it a client-supplied URL is never used.
   *
   * @param projectRoot The project's absolute root, normalised POSIX.
   * @param url The URL from the `session.create` body.
   * @returns The URL to record and whether the telemetry preload is
   *   attributable to the dev server answering there, or the refusal:
   *   `PROTOCOL_INVALID_MESSAGE` for a URL that may not be probed,
   *   `DEV_SERVER_UNAVAILABLE` for one that does not answer.
   */
  verifyRequestedUrl?(
    projectRoot: string,
    url: string,
  ): Promise<Result<VerifiedDevServerUrl, DebuggenError>>;

  /**
   * The project's serving launched dev server, **held** for a session about
   * to be created — the URL and the hold taken together, so the dev server
   * cannot be stopped by another session's end before this one exists.
   *
   * Optional; without it {@link devServerUrlFor} is asked and nothing is held.
   *
   * @param projectRoot The project's absolute root, normalised POSIX.
   * @returns The hold, or `undefined` when no launched dev server serves the project.
   */
  acquireLaunched?(projectRoot: string): SessionDevServerHold | undefined;
}

/**
 * A launched dev server held for a session being created. Exactly one of
 * `commit` and `release` takes effect. `../../dev-server/launcher.ts`'s
 * `DevServerHold` satisfies it structurally.
 */
export interface SessionDevServerHold {
  /** Where the held dev server serves. */
  readonly devServerUrl: string;
  /**
   * Whether the dev server was launched for sessions (and so is stopped when
   * the last of them ends). A developer-owned one is never stopped by a
   * session's end, so it needs no owner and its `commit` is `false` by design.
   */
  readonly sessionOwned: boolean;
  /**
   * The session exists: hand it the hold.
   *
   * @returns Whether the session now counts among the dev server's owners —
   *   always `false` for a developer-owned dev server; for a session-owned
   *   one, `false` means it stopped serving (it exited) while the session was
   *   being created, or the session has already ended.
   */
  commit(sessionId: string): boolean;
  /** The session was not created: give the hold up. */
  release(): Promise<void>;
}

/** A client-supplied dev-server URL the service checked. */
export interface VerifiedDevServerUrl {
  /** The URL as the probe renders it: origin and path, no query or fragment. */
  readonly url: string;
  /**
   * Whether the telemetry preload is attributable to the process answering at
   * the URL: only a dev server the service launched, serving at that origin,
   * whose own credential's `server-agent` connection is online. A connected
   * preload of some other dev server of the project is no evidence (a plain
   * server on another port would pass that test), so `false` means untraced:
   * server and database signals need the dev server relaunched with the
   * preload, which the readiness gate says with the exact command.
   */
  readonly preloadAttributed: boolean;
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
  /**
   * Holds the project's serving launched dev server for a session being
   * created; see {@link SessionDevServerLookup.acquireLaunched}.
   */
  acquireForSession?(projectRoot: string): SessionDevServerHold | undefined;
  /**
   * Whether the telemetry preload is attributable to the dev server answering
   * at a URL — the launcher's own evidence; see
   * {@link VerifiedDevServerUrl.preloadAttributed}. Without it no URL the
   * editor sent is ever attributed.
   */
  preloadServesAt?(projectRoot: string, devServerUrl: string): boolean;
}

/**
 * The collaborators {@link devServerLookupFromLaunches} verifies a
 * client-supplied URL with. `../../dev-server/detect.ts` supplies both in
 * production.
 */
export interface DevServerLookupOptions {
  /**
   * One bounded loopback probe of a URL — `detect.ts`'s `probeDevServer`,
   * which refuses anything but an `http:`/`https:` loopback URL without
   * credentials before any request is made.
   */
  readonly probe?:
    ((url: string) => Promise<Result<DevServerProbeResult, DebuggenError>>) | undefined;
}

/**
 * The retention sweep, as `session.purge` runs it on demand.
 *
 * In production `main.ts` binds it to `../../store/retention.ts`'s
 * `runRetention` over the very dependencies the start-up sweep used — the
 * store, the four repositories, the configured paths and
 * `DEBUGGEN_RETENTION_DAYS` window, the logger and the clock — so the command
 * and the start-up pass apply one rule set. The one option a request decides
 * is whose state the sweep may remove: the scope of the requesting editor's
 * credential. The window is the developer's configuration, never a request's.
 *
 * @example
 * ```ts
 * const retention: SessionRetentionPort = {
 *   purge: (scope) => runRetention(retentionDeps, { scope }),
 * };
 * ```
 */
export interface SessionRetentionPort {
  /**
   * Runs one retention sweep limited to `scope`.
   *
   * @param scope Admits the project roots whose state the sweep may remove —
   *   for `session.purge`, those whose canonical location lies under the
   *   requesting editor's canonical workspace folders. It answers
   *   asynchronously, because it resolves each root on disk. Passed on as
   *   `runRetention`'s `scope` option.
   * @returns The sweep's report — per-item problems are in its `errors` — or
   * `Err` only when the sweep could not run at all.
   */
  purge(scope: RetentionScope): Promise<Result<RetentionReport, DebuggenError>>;
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
   * reads and lists them, ends one (running cleanup through its own runner),
   * files a session whose pipeline could not start as `failed`, and records
   * the address of the dev server a new session joined when the one it was
   * created against stopped meanwhile (`patch`).
   */
  readonly manager: Pick<SessionManager, 'create' | 'get' | 'list' | 'end' | 'fail' | 'patch'>;

  /** Rehydrates a stored session and replays it to its connected clients. */
  readonly reopener: Pick<SessionReopener, 'reopen'>;

  /**
   * The pipeline orchestrator: runs the pipeline of a new session, arms and
   * completes captures, answers follow-ups, cancels an operation in flight
   * before a session is ended, and releases what it keeps for a session — the
   * project's code-index handles above all — once that session has ended.
   */
  readonly orchestrator: Pick<
    PipelineOrchestrator,
    | 'run'
    | 'beginCapture'
    | 'completeCapture'
    | 'followUp'
    | 'cancel'
    | 'activeRun'
    | 'releaseSession'
  >;

  /**
   * The session store's reads: the session's open capture window, whether a
   * given window has closed with its summary stored, one page of session list
   * rows scoped to an editor's workspace folders, and the id and project root
   * `modifications.list` admits a request on without reading the session's
   * document.
   */
  readonly sessions: Pick<
    SessionsRepo,
    'getActiveCapture' | 'getCapture' | 'listWithinFolders' | 'getAccessTarget'
  >;

  /** The stored panels: a session's current one, and any one version by id. */
  readonly panels: Pick<PanelsRepo, 'getLatestPanel' | 'getPanel'>;

  /**
   * The modification journal, read one diff-budgeted page of a session at a
   * time, in application order.
   */
  readonly modifications: Pick<ModificationsRepo, 'listPageBySession'>;

  /**
   * The tab bindings a DevTools principal acts through, and the delivery path
   * of the `target.request` push to a session's bound tab.
   */
  readonly bindings: SessionBindingLookup;

  /**
   * Where a new session's dev-server URL is looked up first, where a URL the
   * editor sent is verified, and how a new session joins a launched dev
   * server's owners. Optional: without it, only a URL an earlier session of the
   * same project recorded is reused.
   */
  readonly devServers?: SessionDevServerLookup | undefined;

  /** The retention sweep `session.purge` runs, scoped to the editor and one at a time. */
  readonly retention: SessionRetentionPort;

  /**
   * The state root (`$DEBUGGEN_HOME`) as `realpath` resolved it once at
   * start-up. `session.create` and `session.question` refuse a project root
   * that is, contains or lies inside it — canonicalised by
   * `requireProjectOutsideStateHome` of `../../config.ts`, so a symbolic link
   * into the state root is refused too — with `400 FS_UNSAFE_PATH`, before
   * any dev server is resolved, any session is stored or any follow-up can
   * re-plan and patch, because session data and backups stay outside the
   * target project (CWE-200). The same field, by the same name and type, is
   * declared by `./dev-server.ts`, so `../http.ts`'s aggregate carries one
   * value to both. `main.ts` always supplies it; a suite that composes these
   * routes without a state tree leaves it out, and no overlap check is made.
   */
  readonly canonicalStateHome?: string | undefined;

  /**
   * The access boundary's revocation fence, applied by every `POST` handler
   * between reading its body and calling its subsystem (see the module
   * documentation). The field name matches the sibling route modules' slices
   * of the same service.
   */
  readonly auth: Pick<AuthService, 'requireLiveCredential'>;

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
  400 | 401 | 403 | 404 | 408 | 409 | 413 | 422 | 429 | 500 | 502 | 503;

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
 * With a `probe`, the lookup also verifies a URL the editor sent: the probe
 * must get an answer on loopback, and the registry's `preloadServesAt` says
 * whether the preload is attributable to the process answering there. With a
 * registry that can hold, a session created against a launched child joins
 * that child's owners.
 *
 * @param launches The launcher (or any registry of the same shape).
 * @param options The probe a client-supplied URL is verified with.
 * @returns The lookup.
 *
 * @example
 * ```ts
 * const devServers = devServerLookupFromLaunches(launcher, {
 *   probe: (url) => probeDevServer(url, { logger }),
 * });
 * devServers.devServerUrlFor('/work/storefront'); // → 'http://127.0.0.1:3000/' once launched
 * ```
 */
export function devServerLookupFromLaunches(
  launches: LaunchedDevServerRegistry,
  options: DevServerLookupOptions = {},
): SessionDevServerLookup {
  const { probe } = options;
  const lookup: SessionDevServerLookup = {
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
    acquireLaunched(projectRoot: string): SessionDevServerHold | undefined {
      return launches.acquireForSession?.(projectRoot);
    },
  };
  if (probe !== undefined) {
    lookup.verifyRequestedUrl = async (projectRoot, url) => {
      const probed = await probe(url);
      if (isErr(probed)) {
        return err(requestedUrlRefused());
      }
      if (!probed.value.reachable) {
        return err(requestedUrlUnreachable(probed.value.error?.code));
      }
      const answering = probed.value.url;
      let preloadAttributed: boolean;
      try {
        preloadAttributed = launches.preloadServesAt?.(projectRoot, answering) === true;
      } catch {
        // No evidence: the URL is recorded untraced.
        preloadAttributed = false;
      }
      return ok(Object.freeze({ url: answering, preloadAttributed }));
    };
  }
  return Object.freeze(lookup);
}

/**
 * The refusal of a client-supplied dev-server URL the probe would not dial —
 * another host, another scheme, embedded credentials. Refused request content,
 * in this module's own words, never the URL's.
 *
 * Like the refusals under "Failure vocabulary", its constant message is
 * registered with `authorProductText` as it is built, so
 * {@link describedRefusalBody} proves it product text and answers the `400`
 * in these words — naming `devServerUrl` — rather than with the generic
 * malformed-message copy.
 */
function requestedUrlRefused(): DebuggenError {
  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    authorProductText(REQUESTED_DEV_SERVER_URL_REFUSED_MESSAGE),
    {
      hint: REQUESTED_DEV_SERVER_URL_REFUSED_HINT,
      details: { reason: 'requested-url-refused' },
    },
  );
}

/**
 * The refusal of a client-supplied dev-server URL nothing answers at. The
 * editor sends one only after its own probe got an answer, so this is a dev
 * server that stopped in between, or one the service cannot reach.
 *
 * @param probeCode The probe's transport failure code, when it had one.
 */
function requestedUrlUnreachable(probeCode: string | undefined): DebuggenError {
  return new DebuggenError(
    'DEV_SERVER_UNAVAILABLE',
    'Nothing answers at the dev-server URL the editor sent.',
    {
      hint: 'Start the project\'s dev server at debuggen.devServerUrl, or run "Debug Generator: Launch Dev Server", then start the session again.',
      details: {
        reason: 'requested-url-unreachable',
        ...(probeCode === undefined ? {} : { probeCode }),
      },
    },
  );
}

/* -------------------------------------------------------------------------------------------------
 * Failure vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** A status a failure is described at, rather than answered `500`. */
type DescribedStatus = 400 | 404 | 409 | 422 | 502 | 503;

/**
 * The statuses of the failures this module describes to its caller, by error
 * code. Which words a described failure is sent in is decided separately by
 * {@link describedRefusalBody}: a lifecycle or readiness refusal
 * ({@link VERBATIM_REFUSAL_CODES}) whose message is proven product text keeps
 * it, and everything else is answered with the fixed copy of its code,
 * because its message may quote what a collaborator was handed.
 *
 * - `400` — a request the transport refused (`PROTOCOL_INVALID_MESSAGE`) or a
 *   path the filesystem layer refused (`FS_UNSAFE_PATH`).
 * - `404` — the session or the project does not exist.
 * - `409` — the session's state does not admit the request: a refused
 *   transition or a busy pipeline, a capture conflict, readiness not yet
 *   reached, an instrumented file the developer edited. "Readiness not yet
 *   reached" covers all three codes the capture stage's blocked readiness
 *   gate raises, one per remediation it names: `TAB_NOT_BOUND` (bind the
 *   tab), `AGENT_NOT_READY` (reload the page) and `SERVER_AGENT_NOT_READY`
 *   (relaunch the dev server). `TAB_NOT_BOUND` is also the answer to an
 *   element requested of a session no tab is bound to. The `TAB_NOT_BOUND` an
 *   access-boundary refusal raises for a DevTools caller never reaches this
 *   table: it carries its `details.reason` and is answered `403` by
 *   `../auth.ts`'s table first.
 * - `422` — a stage refused what it was given to apply: model output that
 *   failed its schema, a plan, a panel, a patch target.
 * - `502` — the project's dev server could not be launched.
 * - `503` — something the request needs is unavailable: the dev server's URL,
 *   the model provider, a telemetry signal, the DevTools connection of the
 *   session's bound tab (`TRANSPORT_DISCONNECTED`, which a retry answers once
 *   the Chrome extension has reconnected).
 *
 * Every other code — `STORE_ERROR`, `INTERNAL`, `CONFIG_INVALID`,
 * `CODE_INDEX_FAILED`, `CLEANUP_PARTIAL`, anything unforeseen — is answered
 * `500` with a fixed message, its code and a diagnostic `ref`, so a store or
 * subsystem failure never reaches a response body in its own words.
 * Access-boundary refusals never reach this table: `../auth.ts`'s own
 * `authErrorResponse` renders them at the status its reason table fixes.
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
  ['TAB_NOT_BOUND', 409],
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
  ['TRANSPORT_DISCONNECTED', 503],
]);

/**
 * The described codes whose refusal may be sent in the error's own words: the
 * session-lifecycle and readiness refusals whose sentences a developer acts on
 * ("the session is not ready to capture", "Could not enable ‹signal›:
 * ‹reason›."). Membership is necessary, not sufficient: the message must also
 * be proven product text by `isProductAuthoredText` — this module's own
 * refusals and the readiness gate's builders register theirs with
 * `authorProductText` as they compose them — because a refusal of a listed
 * code can still be composed from an adapter's reason or copied from an
 * exception. Such an unproven message, of a listed code or not, is answered
 * with {@link FAILURE_COPY_BY_CODE}'s fixed summary and a diagnostic `ref`.
 *
 * Every other described code names a failure a collaborator reports — the
 * installer, the patcher, cleanup's backup store, the model provider, the dev
 * server — whose message may quote what that collaborator was handed: a path,
 * a statement, a provider response (CWE-209). Those are always answered with
 * the fixed summary and a `ref`, and the failure itself is logged under the
 * same `ref`.
 *
 * `FS_UNSAFE_PATH` is listed for one refusal this module composes: a project
 * root that overlaps the state root ({@link stateHomeRefusal}), whose constant
 * sentence — "set DEBUGGEN_HOME outside the project" — is the only way the
 * developer learns what to change. It is registered as product text where it
 * is raised; any other `FS_UNSAFE_PATH` failure, whose message may quote a
 * path, is never registered and so still receives the fixed copy.
 *
 * `PROTOCOL_INVALID_MESSAGE` reaches this set through one refusal this module
 * composes: a `session.create` `devServerUrl` the probe will not dial
 * ({@link requestedUrlRefused}), whose constant sentence names the field and
 * the requirement and never the URL. A body the schema refuses never gets
 * here — {@link answerBodyRejection} sends it in the parser's own words — and
 * any other `PROTOCOL_INVALID_MESSAGE` failure, never registered, still
 * receives the fixed copy.
 */
const VERBATIM_REFUSAL_CODES: ReadonlySet<DebuggenErrorCode> = new Set<DebuggenErrorCode>([
  'PROTOCOL_INVALID_MESSAGE',
  'FS_UNSAFE_PATH',
  'PROJECT_NOT_FOUND',
  'SESSION_NOT_FOUND',
  'SESSION_INVALID_STATE',
  'CAPTURE_ALREADY_ACTIVE',
  'CAPTURE_EMPTY',
  'TAB_NOT_BOUND',
  'AGENT_NOT_READY',
  'SERVER_AGENT_NOT_READY',
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

/*
 * The four refusals below — and {@link requestedUrlRefused}, which the
 * dev-server lookup above raises — are the ones this module composes and
 * answers in their own words. Each registers its constant message with
 * `authorProductText` as it is built — rather than once at load — so
 * {@link describedRefusalBody} proves it product text however many texts other
 * builders registered since, and sends it verbatim.
 */

/** The `404` for a path that names no session — malformed and unknown ids alike. */
function sessionNotFound(reason: 'malformed-session-id' | 'unknown-session'): DebuggenError {
  return new DebuggenError('SESSION_NOT_FOUND', authorProductText(SESSION_NOT_FOUND_MESSAGE), {
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
  return new DebuggenError('SESSION_NOT_FOUND', authorProductText(PANEL_NOT_FOUND_MESSAGE), {
    hint: PANEL_NOT_FOUND_HINT,
    details: { reason },
  });
}

/** The `400` for a project root that is not an absolute path. */
function projectRootNotAbsolute(): DebuggenError {
  return new DebuggenError(
    'PROJECT_NOT_FOUND',
    authorProductText(PROJECT_ROOT_NOT_ABSOLUTE_MESSAGE),
    {
      hint: PROJECT_ROOT_NOT_ABSOLUTE_HINT,
      details: { reason: 'project-root-not-absolute' },
    },
  );
}

/** The `409` for an ending whose session's pipeline operation did not settle in time. */
function pipelineStillRunning(): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    authorProductText(PIPELINE_STILL_RUNNING_MESSAGE),
    {
      hint: PIPELINE_STILL_RUNNING_HINT,
      details: { reason: 'pipeline-still-running' },
    },
  );
}

/**
 * The `400` for a project root that overlaps the state root, or whose
 * canonical location could not be established to show it does not.
 *
 * `../../config.ts`'s `requireProjectOutsideStateHome` raises both as
 * `FS_UNSAFE_PATH` errors whose message and hint are constant sentences that
 * name no path; they are rebuilt here with the message registered as product
 * text, so {@link describedRefusalBody} sends the instruction — set
 * `DEBUGGEN_HOME` outside the project — verbatim. Any other error (a rejected
 * check, converted by {@link settled}) passes through unchanged and is
 * answered as its own code would be.
 *
 * @param error The check's refusal.
 * @returns The refusal to answer the request with.
 */
function stateHomeRefusal(error: DebuggenError): DebuggenError {
  const reason = reasonOf(error);
  if (
    error.code !== 'FS_UNSAFE_PATH' ||
    (reason !== STATE_HOME_OVERLAP_REASON && reason !== PROJECT_ROOT_UNRESOLVABLE_REASON)
  ) {
    return error;
  }
  return new DebuggenError(error.code, authorProductText(error.message), {
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

/** The `409` for an element requested of a session in a terminal status. */
function targetSessionEnded(): DebuggenError {
  return new DebuggenError('SESSION_INVALID_STATE', TARGET_SESSION_ENDED_MESSAGE, {
    hint: TARGET_SESSION_ENDED_HINT,
    details: { reason: 'session-ended' },
  });
}

/**
 * The refusal an undelivered `target.request` is answered with, chosen by the
 * client registry's own verdict on the delivery and worded for the editor that
 * asked:
 *
 * - `TAB_NOT_BOUND` — no tab is bound to the session: `409`, open the panel in
 *   the application's tab first;
 * - `TRANSPORT_DISCONNECTED` — a tab is bound but its DevTools connection is
 *   offline or could not take the frame: `503`, retry once it reconnects;
 * - anything else — the registry refused a frame this module built, which is a
 *   service defect rather than a client mistake: `500`.
 *
 * The registry's own sentences are not forwarded: they are written for the
 * service log and one of them promises a replay from stored data, which a
 * picker request — never stored — does not get.
 *
 * @param error The registry's refusal of the delivery.
 * @returns The refusal to answer the request with.
 */
function undeliveredTargetRequest(error: DebuggenError): DebuggenError {
  switch (error.code) {
    case 'TAB_NOT_BOUND':
      return new DebuggenError('TAB_NOT_BOUND', TARGET_NO_BOUND_TAB_MESSAGE, {
        hint: TARGET_NO_BOUND_TAB_HINT,
        details: { reason: 'no-bound-tab' },
      });
    case 'TRANSPORT_DISCONNECTED':
      return new DebuggenError('TRANSPORT_DISCONNECTED', TARGET_TAB_OFFLINE_MESSAGE, {
        hint: TARGET_TAB_OFFLINE_HINT,
        details: { reason: 'bound-tab-offline' },
      });
    default:
      return portFailure('INTERNAL', 'target-request-undeliverable');
  }
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
 * Projects a retention sweep's report onto protocol's `session.purge` reply.
 *
 * The counts, the cutoff and the duration are copied unchanged. The sessions
 * kept for a conflict are de-duplicated in the sweep's own order and listed up
 * to {@link SESSION_PURGE_MAX_REPORTED_SESSIONS}, with the de-duplicated count
 * as the total, so a long list is visibly truncated rather than silently
 * partial. The per-item problems become `issueCount`; their detail — relative
 * paths, messages — and the deleted session ids and reclaimed bytes stay in
 * the service log, which is where the sweep already recorded them, because the
 * reply is a strict summary.
 *
 * @param report The sweep's report.
 * @returns The reply body, before its schema check.
 *
 * @example
 * ```ts
 * const body = toSessionPurgeResponse(report);
 * body.sessionsRetainedForConflicts.length; // ≤ SESSION_PURGE_MAX_REPORTED_SESSIONS
 * ```
 */
export function toSessionPurgeResponse(
  report: RetentionReport,
): HttpResponseBody<typeof SESSION_PURGE_OPERATION> {
  const retained = [...new Set(report.sessionsRetainedForConflicts)];
  return {
    cutoff: report.cutoff,
    sessionsDeleted: report.sessionsDeleted,
    telemetryEventsDeleted: report.telemetryEventsDeleted,
    panelsDeleted: report.panelsDeleted,
    analysesDeleted: report.analysesDeleted,
    modificationsDeleted: report.modificationsDeleted,
    backupDirsDeleted: report.backupDirsDeleted,
    orphanBackupsDeleted: report.orphanBackupsDeleted,
    indexCachesDeleted: report.indexCachesDeleted,
    sessionsRetainedForConflicts: retained.slice(0, SESSION_PURGE_MAX_REPORTED_SESSIONS),
    sessionsRetainedForConflictsTotal: retained.length,
    issueCount: report.errors.length,
    durationMs: report.durationMs,
  };
}

/** The scope one `session.purge` hands its sweep, and what building it could not resolve. */
interface PurgeScope {
  /** The predicate, closed over the request's principal and its canonical folders. */
  readonly scope: RetentionScope;
  /** How many of the principal's workspace folders could not be canonicalised; each admits nothing. */
  readonly unresolvedFolders: number;
}

/**
 * The workspace folders whose projects a `session.purge` of `principal` may
 * sweep: an editor's announced folders, normalised and de-duplicated. Every
 * other role — which the operation's role row refuses before the handler runs
 * — has none, so its scope admits nothing.
 */
function purgeFoldersOf(principal: Principal): readonly string[] {
  if (principal.role !== 'vscode') {
    return [];
  }
  return [
    ...new Set(principal.scope.workspaceFolders.map((folder) => normalizePosix(toPosix(folder)))),
  ];
}

/**
 * `path`'s canonical location through `../../config.ts`'s `canonicalizePath`,
 * or `undefined` when it cannot be established. A throw is read as
 * unresolvable too, so the caller never has to guard against one.
 */
async function canonicalLocationOf(path: string): Promise<string | undefined> {
  try {
    const canonical = await canonicalizePath(path);
    return isErr(canonical) ? undefined : canonical.value;
  } catch {
    return undefined;
  }
}

/**
 * The scope of the retention sweep `session.purge` runs for `principal`,
 * built once per purge (CWE-863).
 *
 * Every workspace folder the editor announced is canonicalised first, once:
 * each symbolic link resolved, a folder that does not exist yet judged by its
 * nearest existing ancestor. A folder that cannot be canonicalised — a link
 * loop, a directory this account may not read — contributes no canonical
 * folder, so it admits nothing. The scope then admits a stored project root
 * only when **both** hold:
 *
 * 1. `requireProjectScope` lets the principal act on it — the same lexical
 *    check every other route makes; it runs first, so a root outside the
 *    announced folders is never resolved on disk;
 * 2. the root's own canonical location lies within at least one canonical
 *    folder (`isWithin`, whole path segments).
 *
 * So `/w/A/link-to-B`, a link inside workspace A whose target lives in B, is
 * not A's: it passes the lexical check and fails the canonical one. A root
 * whose canonical location cannot be established is refused, which keeps its
 * state. A root that no longer exists is judged by its nearest existing
 * ancestor, so the aged state of a project deleted from A is still A's to
 * remove. The lexical check holds on its own merits: this module does not
 * rely on `requireProjectScope` resolving links, and keeps working unchanged
 * if it does.
 *
 * @param principal The requesting principal, already past the revocation fence.
 * @returns The scope, and how many folders could not be canonicalised.
 *
 * @example
 * ```ts
 * // /w/A announced; /w/A/link-to-B → /w/B/app
 * const { scope } = await purgeScopeOf(editor);
 * await scope('/w/A/app'); // true
 * await scope('/w/A/link-to-B'); // false: it really lives in B
 * await scope('/w/B/app'); // false: outside the announced folders
 * ```
 */
async function purgeScopeOf(principal: Principal): Promise<PurgeScope> {
  const resolved = await Promise.all(purgeFoldersOf(principal).map(canonicalLocationOf));
  const canonicalFolders = Object.freeze(
    resolved.filter((folder): folder is string => folder !== undefined),
  );
  const unresolvedFolders = resolved.length - canonicalFolders.length;

  const scope: RetentionScope = async (projectRoot) => {
    if (canonicalFolders.length === 0 || isErr(requireProjectScope(principal, projectRoot))) {
      return false;
    }
    const canonicalRoot = await canonicalLocationOf(projectRoot);
    return (
      canonicalRoot !== undefined &&
      canonicalFolders.some((folder) => isWithin(folder, canonicalRoot))
    );
  };
  return { scope, unresolvedFolders };
}

/** Orders two strings by UTF-16 code unit, independent of any locale. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * The key under which `session.purge` requests share one sweep: equal exactly
 * when their announced folder sets are, so their scopes ({@link purgeScopeOf})
 * pass the same lexical check and — resolved from the same folders — admit
 * the same canonical locations. An editor's is its set of announced workspace
 * folders — normalised, de-duplicated and sorted, so the order they were
 * announced in does not matter; any other principal's is its own credential,
 * which it shares with no one.
 *
 * @param principal The requesting principal.
 * @returns The key; never shown or logged.
 */
function purgeScopeKey(principal: Principal): string {
  if (principal.role === 'vscode') {
    const folders = new Set(
      principal.scope.workspaceFolders.map((folder) => normalizePosix(toPosix(folder))),
    );
    return JSON.stringify([principal.role, ...[...folders].sort(compareCodeUnits)]);
  }
  return JSON.stringify([principal.role, principal.tokenHash]);
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

/** What {@link joinLaunchedDevServer} did with a hold; see there. */
export type LaunchedDevServerJoin =
  'joined' | 'developer-owned' | 'rejoined' | 'session-ended' | 'lost';

/** What {@link joinLaunchedDevServer} reads and writes besides the hold. */
export interface JoinLaunchedDevServerDeps {
  /** The session manager: the new session's current status, and its recorded address. */
  readonly manager: Pick<SessionManager, 'get' | 'patch'>;
  /** Where the project's launched dev server is acquired again after a lost join. */
  readonly devServers?: Pick<SessionDevServerLookup, 'acquireLaunched'> | undefined;
  readonly log: Logger;
  readonly operation: string;
}

/**
 * One `commit` of a hold, a throwing hold reading as "not joined".
 *
 * @returns Whether the session is served by the held dev server from here on:
 *   it joined a session-owned child's owners, or the child is the developer's
 *   own (which no session end stops, so it needs no owner).
 */
function joinHeld(
  hold: SessionDevServerHold,
  sessionId: string,
  log: Logger,
  operation: string,
): boolean {
  let joined: boolean;
  try {
    joined = hold.commit(sessionId);
  } catch {
    log.warn('The hold on a launched dev server could not be handed over', { operation });
    return false;
  }
  return joined || !hold.sessionOwned;
}

/**
 * Hands the hold on a launched dev server to the session just created against
 * it, so a child launched for sessions counts the session among its owners.
 *
 * The hold kept every other session's end from stopping that child while this
 * one was created, so the join is lost only when the child itself stopped
 * serving meanwhile (it exited), or when this session was already ended by a
 * concurrent request. After an exit, the project's launched dev server is
 * acquired once more — a relaunch may already serve it — and the session
 * records that one's address when it differs. With none, the session keeps
 * the address it was created with: like a dev server that exits at any later
 * moment, the readiness gate reports it, with the command to launch it,
 * before anything is captured.
 *
 * Never rejects: the session exists either way.
 *
 * @param hold The hold taken, together with the URL, before the session was created.
 * @param session The session as it was created.
 * @param deps The manager, the lookup and the log.
 * @returns `joined` (a session-owned child now counts the session among its
 *   owners), `developer-owned` (nothing to join), `rejoined` (the relaunched
 *   dev server of the project was joined instead), `session-ended` (nothing
 *   left to own), or `lost` (no launched dev server serves the project now).
 */
export async function joinLaunchedDevServer(
  hold: SessionDevServerHold,
  session: SessionRecord,
  deps: JoinLaunchedDevServerDeps,
): Promise<LaunchedDevServerJoin> {
  const { log, operation } = deps;
  if (joinHeld(hold, session.id, log, operation)) {
    return hold.sessionOwned ? 'joined' : 'developer-owned';
  }
  const current = settledSync(() => deps.manager.get(session.id), 'session-lookup-threw');
  if (isErr(current) || current.value === undefined || current.value.status === 'ended') {
    return 'session-ended';
  }

  let again: SessionDevServerHold | undefined;
  try {
    again = deps.devServers?.acquireLaunched?.(session.projectRoot);
  } catch {
    again = undefined;
  }
  if (again === undefined || !joinHeld(again, session.id, log, operation)) {
    return 'lost';
  }
  if (again.devServerUrl !== session.devServerUrl) {
    const patched = await settled(
      () => deps.manager.patch(session.id, { devServerUrl: again.devServerUrl }),
      'session-patch-rejected',
    );
    if (isErr(patched)) {
      log.warn('The new session could not record the address of the relaunched dev server', {
        operation,
        errorCode: patched.error.code,
      });
    }
  }
  return 'rejoined';
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

/**
 * Runs one of `../auth.ts`'s synchronous project-root proofs —
 * `admitProjectRoot` or `reconfirmProjectRoot` — converting a throw into the
 * `INTERNAL` `Err` it should have been. The thrown value is not kept: its
 * message could quote the root.
 *
 * Synchronous on purpose, like the proofs it wraps: the caller acts on the
 * returned proof in the same turn, with no `await` between the two.
 *
 * @param prove The proof to run.
 * @param reason The kebab-case reason a throw is filed under.
 * @returns The proof's own answer, or the `INTERNAL` failure.
 */
function provenRoot(
  prove: () => Result<AdmittedProjectRoot, DebuggenError>,
  reason: string,
): Result<AdmittedProjectRoot, DebuggenError> {
  try {
    return prove();
  } catch {
    return err(portFailure('INTERNAL', reason));
  }
}

/* -------------------------------------------------------------------------------------------------
 * Paged listings
 * ---------------------------------------------------------------------------------------------- */

/** How one paged listing reads its window: protocol's `limit` ceiling and the listing's default. */
interface ListPaging extends ListPageBounds {
  /** The `limit` applied when the request names none. */
  readonly defaultLimit: number;
}

/**
 * `session.list`'s window: {@link SESSION_LIST_DEFAULT_LIMIT} rows unless the
 * request asks otherwise, at most {@link SESSION_LIST_MAX_LIMIT}.
 */
const SESSION_LIST_PAGING: ListPaging = Object.freeze({
  maxLimit: SESSION_LIST_MAX_LIMIT,
  defaultLimit: SESSION_LIST_DEFAULT_LIMIT,
});

/**
 * `modifications.list`'s window: {@link MODIFICATIONS_PAGE_DEFAULT_LIMIT}
 * records unless the request asks otherwise, at most
 * {@link MODIFICATIONS_PAGE_MAX_LIMIT}; the diff budget ends a page earlier.
 */
const MODIFICATIONS_PAGING: ListPaging = Object.freeze({
  maxLimit: MODIFICATIONS_PAGE_MAX_LIMIT,
  defaultLimit: MODIFICATIONS_PAGE_DEFAULT_LIMIT,
});

/** The window a listing applied, its defaults filled in — echoed in the answer. */
interface ListWindow {
  /** The page size applied; `0` is a count-only request. */
  readonly limit: number;
  /** How many items the page skipped. */
  readonly offset: number;
}

/**
 * Reads a listing's page window from the request's query string with
 * protocol's `parseListPageQuery`, the one parser both listings share, and
 * fills in what the request left out: the listing's default `limit` and offset
 * `0`. A parameter other than `limit` and `offset`, a value that is not a
 * canonical non-negative integer, or a `limit` above the ceiling is refused
 * with the parser's own `PROTOCOL_INVALID_MESSAGE`, which the listing answers
 * through {@link answerListWindowRejection}: `400`, the message as the parser
 * built it — the offending parameter named, its value never quoted.
 *
 * @param c The request context.
 * @param paging The listing's ceiling and default.
 * @returns The applied window, or the parser's refusal.
 *
 * @example
 * ```ts
 * readListWindow(c, SESSION_LIST_PAGING); // GET /sessions?offset=abc
 * // → err: 'Invalid listing query: offset (invalid_format format=regex)'
 * readListWindow(c, SESSION_LIST_PAGING); // GET /sessions?limit=100000
 * // → err: 'Invalid listing query: limit is too large'
 * ```
 */
function readListWindow(
  c: Context<ServerEnv>,
  paging: ListPaging,
): Result<ListWindow, DebuggenError> {
  const parsed = parseListPageQuery(c.req.query(), paging);
  if (isErr(parsed)) {
    return parsed;
  }
  return ok({
    limit: parsed.value.limit ?? paging.defaultLimit,
    offset: parsed.value.offset ?? 0,
  });
}

/**
 * The `nextOffset` of a page: the offset just past the stored items the page
 * **consumed**, or `null` when it consumed nothing (a count-only request, a
 * window past the end) or nothing remains after it.
 *
 * Consumed rather than returned, because a page may move past an item it
 * leaves out (an unreadable session row) and may end before `limit` (the
 * journal's diff budget); protocol's paging rule admits both, and a loop that
 * follows this value always advances, never skips an unread item and stops.
 *
 * @param window The window the page applied.
 * @param consumed How many stored items of the window the page read.
 * @param total How many items the listing holds.
 * @returns The following page's offset, or `null`.
 */
function listPageNextOffset(window: ListWindow, consumed: number, total: number): number | null {
  const next = window.offset + consumed;
  return consumed > 0 && next < total ? next : null;
}

/* -------------------------------------------------------------------------------------------------
 * Request bodies
 * ---------------------------------------------------------------------------------------------- */

/** The operations of this module that carry a request body. */
type BodyOperation =
  | typeof SESSION_CREATE_OPERATION
  | typeof SESSION_QUESTION_OPERATION
  | typeof SESSION_END_OPERATION
  | typeof SESSION_PURGE_OPERATION
  | typeof CAPTURE_START_OPERATION
  | typeof CAPTURE_STOP_OPERATION
  | typeof TARGET_REQUEST_OPERATION;

/** The largest body each body-carrying operation accepts, in bytes. */
const MAX_BODY_BYTES: Readonly<Record<BodyOperation, number>> = Object.freeze({
  [SESSION_CREATE_OPERATION]: MAX_SESSION_CREATE_BODY_BYTES,
  [SESSION_QUESTION_OPERATION]: MAX_SESSION_QUESTION_BODY_BYTES,
  [SESSION_END_OPERATION]: MAX_EMPTY_BODY_BYTES,
  [SESSION_PURGE_OPERATION]: MAX_EMPTY_BODY_BYTES,
  [CAPTURE_START_OPERATION]: MAX_EMPTY_BODY_BYTES,
  [CAPTURE_STOP_OPERATION]: MAX_EMPTY_BODY_BYTES,
  [TARGET_REQUEST_OPERATION]: MAX_EMPTY_BODY_BYTES,
});

/**
 * The operations whose request body is protocol's empty object. An absent
 * body on one of them reads as `{}` — the only value its schema admits — so an
 * ending sent without a body (a script's bare `POST`, say) still reaches
 * cleanup; a body that is present is validated exactly as sent.
 */
const EMPTY_BODY_OPERATIONS: ReadonlySet<BodyOperation> = new Set<BodyOperation>([
  SESSION_END_OPERATION,
  SESSION_PURGE_OPERATION,
  CAPTURE_START_OPERATION,
  CAPTURE_STOP_OPERATION,
  TARGET_REQUEST_OPERATION,
]);

/** Why a request body was refused before any subsystem saw it. */
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
 * crosses the operation's byte ceiling while it is read, or does not arrive
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

/** The refusal of a body that did not arrive within `../http.ts`'s time ceiling. */
function bodyReadTimedOut(operation: BodyOperation): BodyRejection {
  return {
    status: 408,
    error: new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The ${operation} request body did not arrive in time.`,
      {
        hint: 'Send the whole body at once, then wait for the reply.',
        details: { operation, reason: GUARD_BODY_READ_TIMEOUT_REASON },
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
 * read. A body that declares no length (a chunked upload) is bounded while it
 * is read: `../http.ts`'s request-body guard errors the stream at the same
 * bound — and at its time ceiling — so `c.req.text()` rejects with the guard's
 * refusal instead of buffering an unbounded body, and that rejection is
 * answered `413` or `408` here. The text read is measured once more, which
 * keeps the bound for a handler composed without the guard. An empty body
 * reads as `undefined`, which the `session.create` and `session.question`
 * schemas refuse and which {@link readBody} reads as `{}` for the
 * {@link EMPTY_BODY_OPERATIONS}. `JSON.parse`'s own error is discarded,
 * because its message quotes the input.
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
  } catch (caught) {
    const refusal = guardRefusalOf(caught);
    if (refusal === GUARD_BODY_TOO_LARGE_REASON) {
      return err(bodyTooLarge(operation));
    }
    if (refusal === GUARD_BODY_READ_TIMEOUT_REASON) {
      return err(bodyReadTimedOut(operation));
    }
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
  /**
   * The request's correlation ref, minted by `../http.ts`'s request context
   * (`requestRef` on the hono context) — the ref that module adds to a failure
   * body answered without one and announces in its `X-Debuggen-Ref` header.
   * Absent when the routes run without that module (a suite's bare app).
   */
  readonly requestRef?: string;
}

/**
 * `context` extended with the request's correlation ref, when the request
 * carries one, so a failure record names the ref its reply is answered under.
 *
 * @param c The request context.
 * @param context The logger and the operation.
 * @returns `context` itself, or a copy carrying `requestRef`.
 */
function withRequestRef(c: Context<ServerEnv>, context: RequestContext): RequestContext {
  const requestRef = c.get('requestRef');
  return requestRef === undefined ? context : { ...context, requestRef };
}

/** Where a new session's dev-server URL came from; see the module overview. */
type DevServerSource = 'launched' | 'requested' | 'earlier-session' | 'none';

/** The dev-server URL a new session records, and its provenance. */
interface DevServerResolution {
  /** The URL to record; `undefined` when no source knew one. */
  readonly url: string | undefined;
  readonly source: DevServerSource;
  /** For a URL the editor sent: whether the preload is attributable to the process there. */
  readonly preloadAttributed?: boolean;
  /** For a launched dev server: the hold to hand to the session, or give up. */
  readonly hold?: SessionDevServerHold;
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
 * Neither the error's message, its hint nor its details are logged as fields.
 *
 * When the answer carries a diagnostic `ref` — every `500`, and every
 * described failure whose words were replaced by fixed copy — the record
 * carries the same `ref` and the error under `LOG_ERROR_FIELD_KEY`, where the
 * service serializer keeps its closed shape at `warn` and `error`; and a
 * `debug` twin, {@link SESSION_REQUEST_DIAGNOSTIC_MESSAGE}, repeats the
 * operation, status, code and `ref` with the error, which the serializer
 * emits there with its redacted message and stack. So a developer holding the
 * `ref` a client showed finds the failure at the default level and its
 * detail once `debug` is enabled.
 *
 * When the answer carries no `ref` of its own, `../http.ts` answers it under
 * the request's correlation ref (`context.requestRef`), so the record carries
 * that ref instead — without the error field or the twin, since the words
 * were sent as they are. Either way the record names the ref the reply does.
 *
 * @param context The logger, the operation and the request's ref.
 * @param status The status the failure was answered with.
 * @param error The failure.
 * @param ref The diagnostic reference the response body carries, when it has one.
 */
function logFailure(
  context: RequestContext,
  status: number,
  error: DebuggenError,
  ref?: string,
): void {
  const reason = reasonOf(error);
  const answeredRef =
    ref === undefined
      ? context.requestRef === undefined
        ? {}
        : { ref: context.requestRef }
      : { ref, [LOG_ERROR_FIELD_KEY]: error };
  const fields = {
    operation: context.operation,
    status,
    errorCode: error.code,
    ...(reason === undefined ? {} : { reason }),
    ...answeredRef,
  };
  if (status >= 500) {
    context.log.error(SESSION_REQUEST_FAILED_LOG_MESSAGE, fields);
  } else {
    context.log.warn(SESSION_REQUEST_REFUSED_LOG_MESSAGE, fields);
  }
  if (ref !== undefined) {
    context.log.debug(SESSION_REQUEST_DIAGNOSTIC_MESSAGE, {
      operation: context.operation,
      status,
      errorCode: error.code,
      ref,
      [LOG_ERROR_FIELD_KEY]: error,
    });
  }
}

/** The fixed message of a `500` answering `operation`. */
function unavailableMessageFor(operation: SessionRouteOperation): string {
  if (operation === SESSION_END_OPERATION) {
    return END_UNAVAILABLE_MESSAGE;
  }
  return operation === SESSION_PURGE_OPERATION
    ? PURGE_UNAVAILABLE_MESSAGE
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
 *   in the words {@link describedRefusalBody} chooses: its own when its code is
 *   one of {@link VERBATIM_REFUSAL_CODES} and its message is proven product
 *   text, and otherwise {@link FAILURE_COPY_BY_CODE}'s fixed summary with a
 *   diagnostic `ref` the log records carry too.
 * - Anything else — a store failure, a returned pipeline `Err` of an
 *   unforeseen code, a subsystem defect — is answered `500` with its code, a
 *   fixed message and a freshly minted diagnostic `ref`, which its `error`
 *   record and that record's `debug` twin carry too.
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
    logFailure(withRequestRef(c, context), status, error);
    return c.json(body, status);
  }
  if (isCaptureConflict(error)) {
    return answerCaptureConflict(c, error, context);
  }
  const status = sessionRouteFailureStatus(error);
  if (status === 500) {
    const ref = newMessageId();
    logFailure(context, status, error, ref);
    const body: HttpErrorResponse = {
      code: error.code,
      message: unavailableMessageFor(context.operation),
      ref,
    };
    return c.json(body, 500);
  }
  const refusal = describedRefusalBody(error);
  logFailure(withRequestRef(c, context), status, error, refusal.ref);
  return c.json(refusal.body, status);
}

/** The body a described (non-`500`) failure is answered with, and its diagnostic reference. */
export interface DescribedRefusal {
  /** Protocol's error body, valid against `httpErrorResponseSchema`. */
  readonly body: HttpErrorResponse;
  /**
   * Present when the error's words were replaced by fixed copy: the reference
   * the body carries and the failure's log record repeats.
   */
  readonly ref?: string;
}

/**
 * Chooses the words a described failure is answered with.
 *
 * An error keeps its own message, projected by `toErrorPayload`, only when
 * both hold: its code is one of {@link VERBATIM_REFUSAL_CODES}, and
 * `isProductAuthoredText` proves its message product text — a sentence of
 * {@link FAILURE_COPY_BY_CODE}, or one a product builder registered with
 * `authorProductText` as it composed it (this module's own refusals, a
 * readiness gate's wording). A code alone proves nothing about the words: a
 * refusal composed from an adapter's reason, a message `DebuggenError.from`
 * copied from an exception, or any other sentence nobody registered is
 * answered with its code's fixed summary and a fresh diagnostic `ref`, so a
 * quoted path, statement, URL or provider response never reaches the client
 * (CWE-209). Either body is bounded by protocol's schema.
 *
 * Pure apart from minting the reference and refreshing the provenance
 * registry's recency.
 *
 * @param error A failure {@link sessionRouteFailureStatus} describes.
 * @param newRef Mints the diagnostic reference; defaults to `newMessageId`.
 * @returns The body and, when copy replaced the message, the reference.
 *
 * @example
 * ```ts
 * describedRefusalBody(new DebuggenError('SESSION_INVALID_STATE', composedElsewhere));
 * // → { body: { code, message: FAILURE_COPY_BY_CODE.SESSION_INVALID_STATE.summary, ref }, ref }
 * describedRefusalBody(pipelineStillRunning());
 * // → { body: { code: 'SESSION_INVALID_STATE', message: PIPELINE_STILL_RUNNING_MESSAGE } }
 * ```
 */
export function describedRefusalBody(
  error: DebuggenError,
  newRef: () => string = newMessageId,
): DescribedRefusal {
  if (VERBATIM_REFUSAL_CODES.has(error.code) && isProductAuthoredText(error.message)) {
    return { body: boundedPayload(toErrorPayload(error)) };
  }
  const ref = newRef();
  const copy = Object.hasOwn(FAILURE_COPY_BY_CODE, error.code)
    ? FAILURE_COPY_BY_CODE[error.code]
    : FAILURE_COPY_BY_CODE.INTERNAL;
  return {
    body: boundedPayload({ code: error.code, message: copy.summary, ref }),
    ref,
  };
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
  logFailure(withRequestRef(c, context), CONFLICT_STATUS, error);
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
  logFailure(withRequestRef(c, context), rejection.status, rejection.error);
  return c.json(boundedPayload(toErrorPayload(rejection.error)), rejection.status);
}

/**
 * Answers a listing whose page window {@link readListWindow} refused exactly as
 * {@link answerBodyRejection} answers a refused body: `400`, protocol's error
 * payload in the words `parseListPageQuery` chose, and a `warn` record from
 * {@link logFailure} carrying the operation, status and code.
 *
 * The message is sent as built rather than routed through
 * {@link describedRefusalBody}'s fixed copy, because its provenance is the
 * parser's and nothing else's: issue paths and codes rendered by
 * `describeZodIssues` (an unrecognised parameter by its name, and only when the
 * name looks like one), or a constant sentence naming `limit` or `offset` —
 * never the rejected value. That is what lets a client learn which parameter to
 * fix, as it does for a malformed body. The payload is still bounded by
 * protocol's error schema, so no answer here can be refused by a client's
 * parser.
 *
 * @param c The request context.
 * @param refusal The refusal {@link readListWindow} returned.
 * @param context The logger and the listing's operation.
 * @returns The `400` response.
 *
 * @example
 * ```ts
 * // GET /sessions?limit=-1
 * // → 400 { code: 'PROTOCOL_INVALID_MESSAGE',
 * //         message: 'Invalid listing query: limit (invalid_format format=regex)' }
 * ```
 */
function answerListWindowRejection(
  c: Context<ServerEnv>,
  refusal: DebuggenError,
  context: RequestContext,
): Response {
  logFailure(withRequestRef(c, context), LIST_WINDOW_REFUSED_STATUS, refusal);
  return c.json(boundedPayload(toErrorPayload(refusal)), LIST_WINDOW_REFUSED_STATUS);
}

/**
 * Answers a success after checking it against the operation's response schema
 * — the same `parseHttpResponse` a client parses the reply with. The value
 * sent is the subsystem's own, exactly as it was built; the parse is a gate,
 * never a rewrite. A value the schema refuses is a drift between a subsystem
 * and the protocol and is answered `500` with a fixed `INTERNAL` payload and a
 * fresh diagnostic `ref` its log records carry too; the offending value is
 * never logged, because it holds session data.
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
    const ref = newMessageId();
    logFailure(context, 500, drift, ref);
    return c.json(toErrorPayload(drift, ref), 500);
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

/**
 * The revocation fence of every `POST` handler (see the module
 * documentation): the credential the middleware resolved `principal` from
 * must still be live after the body was read.
 *
 * Synchronous, and called with no `await` between it and the subsystem call
 * it guards. A retired or expired credential is answered by `../auth.ts`'s
 * `authErrorResponse` at `401` through {@link answerFailure}, exactly like the
 * middleware's own refusal; a store that cannot be read, or a fence that
 * throws, is answered `500` — the fence fails closed and never lets the
 * subsystem run on a credential it could not confirm.
 *
 * @param c The request context.
 * @param auth The access boundary's fence.
 * @param principal The principal the middleware resolved.
 * @param context The logger and the operation.
 * @returns `ok`, or the response that refuses the request.
 */
function requireLivePrincipal(
  c: Context<ServerEnv>,
  auth: SessionRoutesDeps['auth'],
  principal: Principal,
  context: RequestContext,
): Result<void, Response> {
  const live = settledSync(() => auth.requireLiveCredential(principal), 'credential-check-threw');
  return isErr(live) ? err(answerFailure(c, live.error, context)) : ok(undefined);
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
 * The id and project root of the session the request names, from the session
 * store's projection columns — never its document.
 *
 * The twin of {@link loadSession} for an operation that needs nothing of the
 * session beyond existence and ownership, with the same answers: a session
 * the store does not hold is `SESSION_NOT_FOUND`, and the store's own failure
 * travels unchanged (a throw becomes `STORE_ERROR`).
 *
 * @returns The access target, `SESSION_NOT_FOUND` when no such session exists,
 * or the store's failure.
 */
function loadAccessTarget(
  sessions: SessionRoutesDeps['sessions'],
  sessionId: SessionId,
): Result<SessionAccessTarget, DebuggenError> {
  const read = settledSync(() => sessions.getAccessTarget(sessionId), 'session-lookup-threw');
  if (isErr(read)) {
    return read;
  }
  const target = read.value;
  if (target?.id !== sessionId) {
    return err(sessionNotFound('unknown-session'));
  }
  return ok({ id: target.id, projectRoot: target.projectRoot });
}

/** A request past the steps that precede every store read: role, id shape, binding. */
interface AdmittedCaller {
  /** The session the path names, of verified shape. */
  readonly sessionId: SessionId;
  /** The principal acting on it. */
  readonly principal: Principal;
  /** The DevTools principal's own binding of the session; absent for an editor. */
  readonly binding: TabBinding | undefined;
  /**
   * The inspected tab a DevTools request acts for, as the auth middleware
   * verified it from the acting-tab header; absent for every other role.
   */
  readonly actingTabId: number | undefined;
  /** The request's logger, bound to the session. */
  readonly context: RequestContext;
}

/**
 * The first three steps of every per-session admission, in the module's fixed
 * order: role, id shape, and a DevTools principal's binding of the request's
 * acting tab — checked before any store read, so a tab that is not bound to
 * this session cannot tell an existing session from an absent one.
 *
 * @param c The request context.
 * @param bindings The binding lookup.
 * @param log This module's logger.
 * @param operation The operation being answered.
 * @returns The admitted caller, or the response that refuses the request.
 */
function admitCaller(
  c: Context<ServerEnv>,
  bindings: SessionBindingLookup,
  log: Logger,
  operation: SessionRouteOperation,
): Result<AdmittedCaller, Response> {
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

  // The inspected tab a DevTools request acts for, as the auth middleware
  // verified it from the acting-tab header; `undefined` for every other role.
  const actingTabId = c.get('actingTabId');
  let binding: TabBinding | undefined;
  if (principal.value.role === 'devtools') {
    const looked = lookupBinding(bindings, sessionId);
    if (isErr(looked)) {
      return err(answerFailure(c, looked.error, context));
    }
    const bound = requireBoundSession(principal.value, sessionId, looked.value, actingTabId);
    if (isErr(bound)) {
      return err(answerFailure(c, bound.error, context));
    }
    binding = looked.value;
  }

  return ok({ sessionId, principal: principal.value, binding, actingTabId, context });
}

/**
 * Admits a request to the session its path names, in the module's fixed
 * order: role, id shape, DevTools binding of the request's acting tab (before
 * any store read, so a tab that is not bound to this session cannot tell an
 * existing session from an absent one), the stored session, and the
 * per-session access matrix.
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
  const caller = admitCaller(c, deps.bindings, log, operation);
  if (isErr(caller)) {
    return caller;
  }
  const { sessionId, principal, binding, actingTabId, context } = caller.value;

  const session = loadSession(deps.manager, sessionId);
  if (isErr(session)) {
    return err(answerFailure(c, session.error, context));
  }
  const target: SessionAccessTarget = {
    id: session.value.id,
    projectRoot: session.value.projectRoot,
  };
  const access = requireSessionAccess(principal, target, binding, actingTabId);
  if (isErr(access)) {
    return err(answerFailure(c, access.error, context));
  }

  return ok({ sessionId, record: session.value, principal, context });
}

/** A request admitted to a session it acts on without its record. */
interface AdmittedTarget {
  /** The session the path names, of verified shape and known to exist. */
  readonly sessionId: SessionId;
  /** The principal acting on it. */
  readonly principal: Principal;
  /** The request's logger, bound to the session. */
  readonly context: RequestContext;
}

/**
 * Admits a request exactly as {@link admitSession} does — the same steps in
 * the same order, the same refusals at the same statuses — except that the
 * session is read as its access target through `SessionsRepo.getAccessTarget`
 * rather than as a whole record through the manager.
 *
 * For an operation whose answer never needs the record: `modifications.list`,
 * whose records come from the journal table. Hydrating the record there would
 * read and parse a document that embeds every modification with its diff —
 * the very payload the paged listing exists to bound — before a single journal
 * row was read, even for a count-only `limit=0`.
 *
 * @param c The request context.
 * @param deps The session store and the binding lookup.
 * @param log This module's logger.
 * @param operation The operation being answered.
 * @returns The admitted session id, or the response that refuses the request.
 */
function admitAccessTarget(
  c: Context<ServerEnv>,
  deps: Pick<SessionRoutesDeps, 'sessions' | 'bindings'>,
  log: Logger,
  operation: SessionRouteOperation,
): Result<AdmittedTarget, Response> {
  const caller = admitCaller(c, deps.bindings, log, operation);
  if (isErr(caller)) {
    return caller;
  }
  const { sessionId, principal, binding, actingTabId, context } = caller.value;

  const target = loadAccessTarget(deps.sessions, sessionId);
  if (isErr(target)) {
    return err(answerFailure(c, target.error, context));
  }
  const access = requireSessionAccess(principal, target.value, binding, actingTabId);
  if (isErr(access)) {
    return err(answerFailure(c, access.error, context));
  }

  return ok({ sessionId, principal, context });
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
 * refusal's own code, message and hint — of which the failed row shows the
 * code and, only when `../../sessions/progress.ts` proves it product text, the
 * hint — or, for a rejection this module converted, a fixed sentence and this
 * module's own hint, registered with `authorProductText` here so the row may
 * show it.
 */
function unstartedPipelineFailure(error: DebuggenError): SessionFailure {
  if (reasonOf(error) === 'pipeline-run-rejected' || error.message.trim().length === 0) {
    return {
      stage: FIRST_PIPELINE_STAGE,
      code: error.code,
      message: PIPELINE_NOT_STARTED_MESSAGE,
      hint: authorProductText(PIPELINE_NOT_STARTED_HINT),
    };
  }
  return error.hint === undefined
    ? { stage: FIRST_PIPELINE_STAGE, code: error.code, message: error.message }
    : { stage: FIRST_PIPELINE_STAGE, code: error.code, message: error.message, hint: error.hint };
}

/**
 * Builds the eleven session route handlers for `../http.ts` to register.
 *
 * Registers nothing, builds no application and opens no socket. The only state
 * held between requests is the retention sweeps `session.purge` has running or
 * queued, one per workspace folder set, which purges of that set share. Each handler runs the steps of the
 * module documentation in order and answers either `200` with the operation's
 * response body, checked against protocol's response schema, or protocol's
 * error body at the status {@link sessionRouteFailureStatus} assigns.
 *
 * @param deps The subsystems the handlers delegate to, and an optional logger
 * and timing overrides.
 * @returns A frozen record of the handlers, keyed by operation id.
 *
 * @example
 * ```ts
 * const routes = createSessionRoutes({
 *   manager, reopener, orchestrator, sessions, panels, modifications, bindings: clients,
 *   retention: { purge: (scope) => runRetention(retentionDeps, { scope }) }, auth,
 * });
 * app.on('POST', HTTP_ROUTES['session.create'].pattern, authFor('session.create'),
 *   routes['session.create']);
 * ```
 */
export function createSessionRoutes(deps: SessionRoutesDeps): SessionRoutes {
  const {
    manager,
    reopener,
    orchestrator,
    sessions,
    panels,
    modifications,
    bindings,
    retention,
    auth,
  } = deps;
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

  /** {@link admitAccessTarget} over this instance's session store and bindings. */
  const admitTarget = (
    c: Context<ServerEnv>,
    operation: SessionRouteOperation,
  ): Result<AdmittedTarget, Response> =>
    admitAccessTarget(c, { sessions, bindings }, log, operation);

  /** {@link requireLivePrincipal} over this instance's access boundary. */
  const fence = (
    c: Context<ServerEnv>,
    principal: Principal,
    context: RequestContext,
  ): Result<void, Response> => requireLivePrincipal(c, auth, principal, context);

  /**
   * Refuses a project root that is, contains or lies inside the state root
   * (see {@link SessionRoutesDeps.canonicalStateHome}), answered
   * `400 FS_UNSAFE_PATH` in the check's own constant words. Awaits the
   * canonicalisation, so every caller runs it before its revocation fence.
   * Without a canonical state root no check is made.
   *
   * @param c The request context.
   * @param projectRoot The normalised absolute root the request acts on — for
   * `session.create`, the canonical directory `admitProjectRoot` admitted.
   * @param context The logger and the operation.
   * @returns `ok`, or the response that refuses the request.
   */
  async function keepApartFromStateHome(
    c: Context<ServerEnv>,
    projectRoot: string,
    context: RequestContext,
  ): Promise<Result<void, Response>> {
    const stateHome = deps.canonicalStateHome;
    if (stateHome === undefined) {
      return ok(undefined);
    }
    const checked = await settled(
      () => requireProjectOutsideStateHome(stateHome, projectRoot),
      'state-home-check-rejected',
    );
    return isErr(checked)
      ? err(answerFailure(c, stateHomeRefusal(checked.error), context))
      : ok(undefined);
  }

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
   * The dev-server URL a new session of `projectRoot` records, and where it
   * came from (see the module overview): a serving dev server the service
   * launched, else the URL the editor sent once verified, else the URL the
   * project's most recently updated earlier session recorded, else none —
   * which the manager refuses with `DEV_SERVER_UNAVAILABLE`.
   *
   * @returns The resolution, or the refusal of a client-supplied URL.
   */
  async function resolveDevServerUrl(
    projectRoot: string,
    requestedUrl: string | undefined,
    context: RequestContext,
  ): Promise<Result<DevServerResolution, DebuggenError>> {
    const lookup = deps.devServers;
    if (lookup !== undefined) {
      try {
        const acquire = lookup.acquireLaunched?.bind(lookup);
        const hold = acquire?.(projectRoot);
        const found =
          acquire === undefined ? await lookup.devServerUrlFor(projectRoot) : hold?.devServerUrl;
        if (typeof found === 'string' && found.length > 0) {
          if (requestedUrl !== undefined) {
            context.log.info(
              'A launched dev server serves the project; the dev-server URL the editor sent was not used',
              { operation: context.operation },
            );
          }
          return ok(
            hold === undefined
              ? { url: found, source: 'launched' }
              : { url: found, source: 'launched', hold },
          );
        }
      } catch {
        context.log.warn(
          'The dev-server lookup failed; the URL the editor sent and earlier sessions are consulted',
          { operation: context.operation },
        );
      }
    }

    if (requestedUrl !== undefined) {
      const verify = lookup?.verifyRequestedUrl?.bind(lookup);
      if (verify === undefined) {
        context.log.warn(
          'The dev-server URL the editor sent cannot be verified here, so it was not used',
          { operation: context.operation },
        );
      } else {
        const verified = await settled(
          () => verify(projectRoot, requestedUrl),
          'dev-server-verify-rejected',
        );
        if (isErr(verified)) {
          return verified;
        }
        return ok({
          url: verified.value.url,
          source: 'requested',
          preloadAttributed: verified.value.preloadAttributed,
        });
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
      return ok({ url: undefined, source: 'none' });
    }
    const latest = earlier.value[0];
    if (latest === undefined) {
      return ok({ url: undefined, source: 'none' });
    }
    const record = settledSync(() => manager.get(latest.id), 'session-lookup-threw');
    if (isErr(record) || record.value === undefined) {
      return ok({ url: undefined, source: 'none' });
    }
    return ok({ url: record.value.devServerUrl, source: 'earlier-session' });
  }

  /**
   * Hands the hold on a launched dev server to the session created against
   * it; see {@link joinLaunchedDevServer}. Never fails the creation.
   */
  async function commitDevServerHold(
    hold: SessionDevServerHold,
    session: SessionRecord,
    context: RequestContext,
  ): Promise<void> {
    const outcome = await joinLaunchedDevServer(hold, session, {
      manager,
      devServers: deps.devServers,
      log: context.log,
      operation: context.operation,
    });
    if (outcome === 'lost') {
      context.log.warn(
        'The launched dev server of a new session stopped while the session was being created; the readiness gate reports it before any capture',
        { operation: context.operation, reason: 'dev-server-exited' },
      );
      return;
    }
    context.log.info('Resolved the launched dev server of a new session', {
      operation: context.operation,
      join: outcome,
    });
  }

  /**
   * Gives up the hold on a launched dev server when its session was not
   * created, so a child launched for sessions that nothing else relies on is
   * stopped rather than left without an owner. Never throws.
   */
  async function releaseDevServerHold(
    hold: SessionDevServerHold | undefined,
    context: RequestContext,
  ): Promise<void> {
    if (hold === undefined) {
      return;
    }
    try {
      await hold.release();
    } catch {
      context.log.warn('The hold on a launched dev server could not be given up', {
        operation: context.operation,
      });
    }
  }

  /**
   * One page of the sessions the principal's announced workspace covers, as
   * list rows, most recently updated first.
   *
   * One repository call reads the page: a `COUNT(*)` and a `LIMIT`/`OFFSET`
   * select, both scoped in SQL to the principal's workspace folders, with the
   * cleanup summary read from the store's `session_cleanup_summaries`
   * projection — no stored document is read, by SQLite or here, parsed or
   * held. Every row is checked once more against `requireProjectScope`, the
   * access rule itself, so a stored root that is not in normalised form can
   * never widen what the editor sees. A row the store could not read, or one
   * this check refuses, is left out and counted — one corrupt row must not empty
   * the Sessions tree — and the page still moves past it; any other store
   * failure fails the request.
   *
   * @param principal The requesting editor principal.
   * @param window The applied page window.
   * @param context The logger and the operation.
   * @returns The response body, or the store's failure.
   */
  function readSessionPage(
    principal: Principal,
    window: ListWindow,
    context: RequestContext,
  ): Result<HttpResponseBody<typeof SESSION_LIST_OPERATION>, DebuggenError> {
    // Only an editor principal carries workspace folders; any other role would
    // have been refused by `authorize`, and is given an empty scope regardless.
    const folders = principal.role === 'vscode' ? principal.scope.workspaceFolders : [];
    const page = settledSync(
      () => sessions.listWithinFolders({ folders, limit: window.limit, offset: window.offset }),
      'session-list-threw',
    );
    if (isErr(page)) {
      return page;
    }

    const rows: SessionListItem[] = [];
    let outOfScope = 0;
    for (const item of page.value.items) {
      if (isErr(requireProjectScope(principal, item.projectRoot))) {
        outOfScope += 1;
        continue;
      }
      rows.push(item);
    }

    const { total, consumed, unreadable } = page.value;
    if (unreadable > 0 || outOfScope > 0) {
      context.log.warn('Stored sessions were left out of the session list page', {
        operation: context.operation,
        unreadable,
        outOfScope,
      });
    }
    return ok({
      sessions: rows,
      total,
      limit: window.limit,
      offset: window.offset,
      nextOffset: listPageNextOffset(window, consumed, total),
    });
  }

  /**
   * The session's record once the follow-up stage has recorded this ask — it
   * records it before it decides anything — or `undefined` while it has not
   * (a failed read is "not yet": the operation's own settlement still answers
   * the request).
   *
   * Recording is recognised by identity alone: the ladder holds the entry of
   * `attemptId` with an `attempt` counter above `baseline`. A new follow-up
   * appears with `attempt: 1` over a baseline of `0`; a retry recorded in place
   * raises the counter of the entry it replaces. Neither the ladder's length
   * (a retry keeps it), the entries' `askedAt` (two asks can share a
   * millisecond) nor the question text (AAP §0.5.4) is consulted.
   *
   * @param sessionId The session the follow-up was asked on.
   * @param attemptId The attempt this request asked.
   * @param baseline The attempt's counter when the request arrived, `0` when
   *   the ladder did not hold it.
   */
  function recordedFollowUp(
    sessionId: SessionId,
    attemptId: string,
    baseline: number,
  ): SessionRecord | undefined {
    const read = settledSync(() => manager.get(sessionId), 'session-lookup-threw');
    if (isErr(read) || read.value === undefined) {
      return undefined;
    }
    const recorded = read.value.followUps.some(
      (entry) => entry.attemptId === attemptId && (entry.attempt ?? 0) > baseline,
    );
    return recorded ? read.value : undefined;
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

  /**
   * Hands `target.request { sessionId }` to the connection of the session's
   * bound tab through the registry's single-recipient path — no fan-out, and
   * no tab the request could name — then reads the tab it reached from the
   * same binding. No `await` separates the delivery from that read, so the tab
   * the reply names is the tab the frame was written to.
   *
   * A throwing registry is an `INTERNAL` failure whose thrown value is not
   * kept; a refused delivery is answered as {@link undeliveredTargetRequest}
   * words it, and a refusal the registry should never raise for a frame built
   * here is logged by its code.
   *
   * @param sessionId The admitted session.
   * @param context The request's logger and operation.
   * @returns The bound tab's id, or the refusal to answer with.
   */
  function deliverTargetRequest(
    sessionId: SessionId,
    context: RequestContext,
  ): Result<number, DebuggenError> {
    let sent: Result<DeliveryReceipt, DebuggenError>;
    let binding: TabBinding | undefined;
    try {
      sent = bindings.sendToBoundTab(
        sessionId,
        createEnvelope(TARGET_REQUEST_MESSAGE, { sessionId }),
      );
      binding = bindings.bindingForSession(sessionId);
    } catch {
      return err(portFailure('INTERNAL', 'target-request-send-threw'));
    }
    if (isErr(sent)) {
      const code = sent.error.code;
      if (code !== 'TAB_NOT_BOUND' && code !== 'TRANSPORT_DISCONNECTED') {
        context.log.error('The client registry refused a target request the service built', {
          operation: context.operation,
          errorCode: code,
        });
      }
      return err(undeliveredTargetRequest(sent.error));
    }
    if (binding?.sessionId !== sessionId) {
      return err(portFailure('INTERNAL', 'target-request-binding-vanished'));
    }
    return ok(binding.tabId);
  }

  /* ----------------------------------------------------------------------------------------------
   * The handlers
   * -------------------------------------------------------------------------------------------- */

  /**
   * `session.create`: authorize, validate, admit the project root, resolve the
   * dev server, re-prove the root, create, start the pipeline.
   *
   * The root is held to one canonical directory from admission to storage
   * (CWE-367; see "The project root a session is created for" in the module
   * overview): `admitProjectRoot` judges it and keeps the canonical path it
   * judged, the state-root separation is judged on that path, and — after the
   * dev-server lookup's `await`, at the revocation fence —
   * `reconfirmProjectRoot` re-proves it synchronously, with no `await` before
   * `SessionManager.create` stores the session and records the proof for the
   * pipeline's sinks. A refusal at the fence or at the re-proof gives up the
   * dev-server hold the lookup took, so no launched child is left without an
   * owner.
   */
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
    // connections announced, judged on the normalised root and on
    // the canonical directory it resolves to, which the admission keeps.
    const admitted = provenRoot(
      () => admitProjectRoot(principal.value, projectRoot.value),
      'project-root-admission-threw',
    );
    if (isErr(admitted)) {
      return answerFailure(c, admitted.error, context);
    }
    // Session data and backups live outside the project: the
    // directory actually admitted must not overlap the state root. Refused
    // before any dev server is looked up, held or probed, and before anything
    // is stored.
    const apart = await keepApartFromStateHome(c, admitted.value.canonicalRoot, context);
    if (isErr(apart)) {
      return apart.error;
    }

    // Looked up by the session's own spelling of the root: the launcher's
    // registry and earlier sessions are keyed by it.
    const devServer = await resolveDevServerUrl(
      projectRoot.value,
      body.value.devServerUrl,
      context,
    );
    if (isErr(devServer)) {
      return answerFailure(c, devServer.error, context);
    }
    const { hold, preloadAttributed } = devServer.value;
    // Fenced and re-proved after the lookup's await, immediately before the
    // manager stores the session — which it does synchronously, inside the
    // call — so no rotation can land between the checks and the store, and a
    // relink is caught unless it lands within these synchronous calls.
    const live = fence(c, principal.value, context);
    if (isErr(live)) {
      await releaseDevServerHold(hold, context);
      return live.error;
    }
    const still = provenRoot(
      () => reconfirmProjectRoot(principal.value, admitted.value),
      'project-root-reconfirmation-threw',
    );
    if (isErr(still)) {
      await releaseDevServerHold(hold, context);
      return answerFailure(c, still.error, context);
    }
    const created = await settled(
      () =>
        manager.create({
          projectRoot: projectRoot.value,
          question: body.value.question,
          target:
            body.value.target === undefined ? undefined : redactSelectedTarget(body.value.target),
          devServerUrl: devServer.value.url,
          admittedRoot: still.value,
        }),
      'session-create-rejected',
    );
    if (isErr(created)) {
      await releaseDevServerHold(hold, context);
      return answerFailure(c, created.error, context);
    }

    const session = created.value;
    const sessionContext: RequestContext = {
      log: sessionLogger(log, session.id),
      operation: SESSION_CREATE_OPERATION,
    };
    if (hold !== undefined) {
      await commitDevServerHold(hold, session, sessionContext);
    }
    startPipeline(session.id, sessionContext.log);
    sessionContext.log.info('Created a session and started its pipeline', {
      operation: SESSION_CREATE_OPERATION,
      status: session.status,
      targetSelected: session.target !== undefined,
      devServerSource: devServer.value.source,
      ...(preloadAttributed === undefined ? {} : { preloadAttributed }),
    });
    return answerSuccess(
      c,
      sessionContext,
      session satisfies HttpResponseBody<typeof SESSION_CREATE_OPERATION>,
    );
  };

  /**
   * `session.list`: one page of the sessions the editor's announced workspace
   * covers, as list rows — the window read from `limit`/`offset`, defaulting to
   * {@link SESSION_LIST_DEFAULT_LIMIT} rows from offset `0`, and echoed with
   * `total` and `nextOffset`. The principal is authorized first; a window the
   * parser refuses is then answered `400` naming the parameter
   * ({@link answerListWindowRejection}), before any store read.
   */
  const listSessions: SessionRouteHandler = (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const context: RequestContext = { log, operation: SESSION_LIST_OPERATION };

    const principal = authorize(c, context);
    if (isErr(principal)) {
      return principal.error;
    }
    const window = readListWindow(c, SESSION_LIST_PAGING);
    if (isErr(window)) {
      return answerListWindowRejection(c, window.error, context);
    }
    const page = readSessionPage(principal.value, window.value, context);
    if (isErr(page)) {
      return answerFailure(c, page.error, context);
    }
    context.log.debug('Listed sessions', {
      operation: SESSION_LIST_OPERATION,
      count: page.value.sessions.length,
      total: page.value.total,
      limit: page.value.limit,
      offset: page.value.offset,
    });
    return answerSuccess(c, context, page.value);
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
   * `session.question`: drives the follow-up and answers once this ask is
   * recorded, or with the refusal that came first. The follow-up stage records
   * the question itself and chooses the path; nothing here reads the question
   * beyond handing it over.
   *
   * The ask is keyed by its attempt id — the body's, or one minted here when
   * the body carries none, which makes it a new follow-up. The orchestrator
   * refuses an id naming an answered or superseded follow-up before anything
   * runs (`409 SESSION_INVALID_STATE`), and retries the latest unanswered one
   * in place.
   */
  const askQuestion: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const admitted = admit(c, SESSION_QUESTION_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, record, principal, context } = admitted.value;
    const body = await readBody(c, SESSION_QUESTION_OPERATION);
    if (isErr(body)) {
      return answerBodyRejection(c, body.error, context);
    }
    // A follow-up can re-plan and patch the project, writing backups into the
    // state root: refused, like a new session, when the two overlap.
    const apart = await keepApartFromStateHome(c, record.projectRoot, context);
    if (isErr(apart)) {
      return apart.error;
    }

    const attemptId = body.value.attemptId ?? newId(FOLLOW_UP_ATTEMPT_ID_PREFIX);
    const baseline = record.followUps.find((entry) => entry.attemptId === attemptId)?.attempt ?? 0;
    const live = fence(c, principal, context);
    if (isErr(live)) {
      return live.error;
    }
    const running = settled(
      () => orchestrator.followUp({ sessionId, question: body.value.question, attemptId }),
      'follow-up-rejected',
    );
    const race = await raceEffect(
      running,
      () => recordedFollowUp(sessionId, attemptId, baseline),
      pollIntervalMs,
    );
    if (race.kind === 'observed') {
      observeInBackground(running, context);
      context.log.info('Recorded a follow-up question; its answer continues', {
        operation: SESSION_QUESTION_OPERATION,
        status: race.effect.status,
        retried: baseline > 0,
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
   * modification. The cleanup status is the runner's verdict, verbatim. Once
   * the session is ended — now, or by an earlier request — the orchestrator
   * releases what it kept for it, so an idle service holds no ts-morph program
   * for a session nobody can act on; that release never changes the answer.
   */
  const endSession: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const admitted = admit(c, SESSION_END_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, principal, context } = admitted.value;
    const body = await readBody(c, SESSION_END_OPERATION);
    if (isErr(body)) {
      return answerBodyRejection(c, body.error, context);
    }

    // Fenced before the first effect, the cancellation of the operation in flight.
    const live = fence(c, principal, context);
    if (isErr(live)) {
      return live.error;
    }
    const stopped = await stopInFlight(sessionId, context);
    if (isErr(stopped)) {
      return answerFailure(c, stopped.error, context);
    }
    const ended = await settled(() => manager.end(sessionId), 'session-end-rejected');
    if (isErr(ended)) {
      return answerFailure(c, ended.error, context);
    }
    try {
      orchestrator.releaseSession(sessionId);
    } catch (thrown) {
      context.log.warn('The pipeline state of an ended session could not be released', {
        operation: SESSION_END_OPERATION,
        errorCode: DebuggenError.from(thrown, 'INTERNAL').code,
      });
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
    const { sessionId, principal, context } = admitted.value;
    const body = await readBody(c, CAPTURE_START_OPERATION);
    if (isErr(body)) {
      return answerBodyRejection(c, body.error, context);
    }

    const live = fence(c, principal, context);
    if (isErr(live)) {
      return live.error;
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
    const { sessionId, principal, context } = admitted.value;
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

    const live = fence(c, principal, context);
    if (isErr(live)) {
      return live.error;
    }
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
      // The window may have closed before a later stage failed within one poll:
      // the stop itself succeeded, and the stage failure reaches both surfaces
      // through the session's failed status and progress row.
      const closed =
        openCaptureId === undefined ? undefined : storedSummary(sessionId, openCaptureId);
      if (closed !== undefined) {
        context.log.info('Stopped a capture; a later stage failed', {
          operation: CAPTURE_STOP_OPERATION,
          code: outcome.error.code,
        });
        return answerSuccess(c, context, {
          summary: closed,
        } satisfies HttpResponseBody<typeof CAPTURE_STOP_OPERATION>);
      }
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
   * `target.request`: asks the session's bound DevTools tab — and it alone —
   * to enter element-picker mode, and answers which tab was asked.
   *
   * The editor-only role, the session and its workspace scope are admitted as
   * for every session route; the status is then read again, after the body,
   * so an ending that landed meanwhile is refused `409 SESSION_INVALID_STATE`
   * rather than sent a picker request. From that read to the delivery nothing
   * is awaited. Nothing is recorded: the panel's answer is a `target.selected`
   * frame, which the WebSocket router judges against the bound tab's document
   * on its own, and whose acceptance the editor sees as `session.updated`.
   */
  const requestTarget: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const admitted = admit(c, TARGET_REQUEST_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, context } = admitted.value;
    const body = await readBody(c, TARGET_REQUEST_OPERATION);
    if (isErr(body)) {
      return answerBodyRejection(c, body.error, context);
    }

    const current = loadSession(manager, sessionId);
    if (isErr(current)) {
      return answerFailure(c, current.error, context);
    }
    if (isTerminalSessionStatus(current.value.status)) {
      return answerFailure(c, targetSessionEnded(), context);
    }

    const delivered = deliverTargetRequest(sessionId, context);
    if (isErr(delivered)) {
      return answerFailure(c, delivered.error, context);
    }
    context.log.info('Asked the bound tab to pick an element', {
      operation: TARGET_REQUEST_OPERATION,
      tabId: delivered.value,
    });
    return answerSuccess(c, context, {
      sessionId,
      tabId: delivered.value,
    } satisfies HttpResponseBody<typeof TARGET_REQUEST_OPERATION>);
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
   * `modifications.list`: one page of the session's modification journal in
   * application order — the window read from `limit`/`offset`, defaulting to
   * {@link MODIFICATIONS_PAGE_DEFAULT_LIMIT} records from offset `0` — ended
   * early rather than let the page's diffs exceed
   * {@link MODIFICATIONS_PAGE_DIFF_BUDGET} UTF-8 bytes, and echoed with the
   * journal's `total` and `nextOffset`. The journal measures each diff's bytes
   * before it reads the diff, so no diff past the page is loaded; `limit=0`
   * answers the count without reading a record. The request is admitted on
   * the session's id and project root ({@link admitAccessTarget}), never on
   * its record; only an admitted request has its window read, and a window the
   * parser refuses is answered `400` naming the parameter
   * ({@link answerListWindowRejection}). The records carry unified diffs, so
   * nothing about them but counts is ever logged.
   */
  const listModifications: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    // Admitted on the session's id and project root alone: the answer comes
    // from the journal, so the record — every diff included — is never read.
    const admitted = admitTarget(c, MODIFICATIONS_LIST_OPERATION);
    if (isErr(admitted)) {
      return admitted.error;
    }
    const { sessionId, context } = admitted.value;

    const window = readListWindow(c, MODIFICATIONS_PAGING);
    if (isErr(window)) {
      return answerListWindowRejection(c, window.error, context);
    }
    const { limit, offset } = window.value;
    const listed = await settled(
      () =>
        modifications.listPageBySession(sessionId, {
          limit,
          offset,
          maxDiffBytes: MODIFICATIONS_PAGE_DIFF_BUDGET,
        }),
      'modifications-lookup-rejected',
    );
    if (isErr(listed)) {
      return answerFailure(c, listed.error, context);
    }
    const { records, total } = listed.value;
    const nextOffset = listPageNextOffset(window.value, records.length, total);
    // Counts only: never a file, a hash, a backup path or any of a diff.
    context.log.debug('Listed modifications', {
      operation: MODIFICATIONS_LIST_OPERATION,
      count: records.length,
      total,
      limit,
      offset,
      // A page that stopped short of its window with records left: the byte budget ended it.
      endedByBudget: nextOffset !== null && records.length < limit,
    });
    return answerSuccess(c, context, {
      modifications: records,
      total,
      limit,
      offset,
      nextOffset,
    } satisfies HttpResponseBody<typeof MODIFICATIONS_LIST_OPERATION>);
  };

  /**
   * The retention sweep running or queued for `session.purge`, per scope key
   * ({@link purgeScopeKey}): shared by every request of that scope that arrives
   * before it settles, and cleared once it does, so the next purge of the
   * scope starts a fresh sweep. A request of another scope never receives it.
   * No entry ever rejects: {@link settled} turns a rejection into the `Err` it
   * should have been.
   */
  const purgesByScope = new Map<string, Promise<Result<RetentionReport, DebuggenError>>>();

  /**
   * The sweep queued last. Each new sweep starts only once it has settled, so
   * two sweeps — of one scope or of two overlapping ones — never run at once.
   * Never rejects, like every sweep it chains.
   */
  let purgeQueueTail: Promise<unknown> = Promise.resolve();

  /**
   * The sweep of `principal`'s scope already running or queued, or a new one
   * over `scope` — the one {@link purgeScopeOf} built for this request —
   * queued behind every other; `joined` says which. Synchronous, so nothing
   * lands between the caller's revocation fence and the sweep it starts or
   * joins.
   */
  function runPurgeOnce(
    principal: Principal,
    scope: RetentionScope,
  ): {
    readonly sweep: Promise<Result<RetentionReport, DebuggenError>>;
    readonly joined: boolean;
  } {
    const key = purgeScopeKey(principal);
    const pending = purgesByScope.get(key);
    if (pending !== undefined) {
      return { sweep: pending, joined: true };
    }
    const sweep = purgeQueueTail.then(() =>
      settled(() => retention.purge(scope), 'retention-purge-rejected'),
    );
    purgeQueueTail = sweep;
    purgesByScope.set(key, sweep);
    void sweep.finally(() => {
      if (purgesByScope.get(key) === sweep) {
        purgesByScope.delete(key);
      }
    });
    return { sweep, joined: false };
  }

  /**
   * `session.purge`: runs the retention sweep now, for
   * `debuggen.purgeSessions`, and answers with its report once it finished.
   * Editor role only; the body is protocol's empty object. The sweep is scoped
   * to the projects that really live under the editor's announced workspace
   * folders ({@link purgeScopeOf}): the folders are canonicalised once, after
   * the revocation fence and before the sweep is started or joined. A purge of
   * the same folder set joins one already running or queued, any other waits
   * its turn. Never touches a session inside the retention window — which
   * sessions go is the sweep's rule, not this handler's.
   */
  const purgeSessions: SessionRouteHandler = async (c) => {
    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    const context: RequestContext = { log, operation: SESSION_PURGE_OPERATION };

    const principal = authorize(c, context);
    if (isErr(principal)) {
      return principal.error;
    }
    const body = await readBody(c, SESSION_PURGE_OPERATION);
    if (isErr(body)) {
      return answerBodyRejection(c, body.error, context);
    }

    // Fenced before anything is resolved: a retired credential neither reads
    // the disk, runs a sweep, nor receives the report of one another request
    // started.
    const live = fence(c, principal.value, context);
    if (isErr(live)) {
      return live.error;
    }
    const { scope, unresolvedFolders } = await purgeScopeOf(principal.value);
    if (unresolvedFolders > 0) {
      // A count only: a folder is a path on this machine and is never logged.
      context.log.warn(
        'Workspace folders could not be resolved on disk; the purge admits nothing under them',
        {
          operation: SESSION_PURGE_OPERATION,
          unresolvedFolders,
        },
      );
    }
    // Fenced again after that await, immediately before the sweep is started
    // or joined with nothing awaited in between: a credential retired while
    // the folders resolved runs nothing either.
    const stillLive = fence(c, principal.value, context);
    if (isErr(stillLive)) {
      return stillLive.error;
    }
    const { sweep, joined } = runPurgeOnce(principal.value, scope);
    const swept = await sweep;
    if (isErr(swept)) {
      return answerFailure(c, swept.error, context);
    }
    const reply = toSessionPurgeResponse(swept.value);
    context.log.info('Ran the retention sweep on request', {
      operation: SESSION_PURGE_OPERATION,
      joinedRunningSweep: joined,
      sessionsDeleted: reply.sessionsDeleted,
      sessionsRetainedForConflicts: reply.sessionsRetainedForConflictsTotal,
      issueCount: reply.issueCount,
    });
    return answerSuccess(c, context, reply);
  };

  return Object.freeze({
    [SESSION_CREATE_OPERATION]: createSession,
    [SESSION_LIST_OPERATION]: listSessions,
    [SESSION_GET_OPERATION]: getSession,
    [SESSION_QUESTION_OPERATION]: askQuestion,
    [SESSION_END_OPERATION]: endSession,
    [SESSION_PURGE_OPERATION]: purgeSessions,
    [CAPTURE_START_OPERATION]: startCapture,
    [CAPTURE_STOP_OPERATION]: stopCapture,
    [TARGET_REQUEST_OPERATION]: requestTarget,
    [PANEL_GET_OPERATION]: getCurrentPanel,
    [PANEL_GET_BY_ID_OPERATION]: getPanelById,
    [MODIFICATIONS_LIST_OPERATION]: listModifications,
  });
}
