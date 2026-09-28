/**
 * The tab↔session binding route: the WebSocket half of the service that owns
 * `session.bind` → `session.bound`, `tab.navigated` and `session.unbind`
 * (AAP §0.2.3 "Tab/session binding", §0.4.2's four binding rows, §0.5.5).
 *
 * ## Why this module matters
 *
 * The binding is the product's routing primitive. Once an inspected Chrome tab
 * is bound to a session, that pairing is the single, deterministic recipient of
 * the session's `agent.config`, `target.request`, `telemetry.tail` and
 * `panel.generated`, and the tab's document URL is the "current URL" the
 * problem-understanding stage reads when no element is selected. Everything
 * here exists to keep that pairing exact across binds, replacements,
 * navigations, reloads and teardown.
 *
 * ## Shape
 *
 * {@link createBindingRoutes} returns three handlers — {@link BindingRoutes} —
 * which `../ws.ts` calls from its exhaustive inbound dispatch with the frame's
 * already-parsed payload and the connection's resolved {@link Principal}. The
 * module registers nothing, opens no socket, owns no HTTP route and reads no
 * environment: every collaborator is injected through {@link BindingRoutesDeps},
 * each narrowed to the members actually used. Every handler answers with a
 * `Result`, so a refusal becomes protocol's `error` frame at the caller and
 * never a thrown exception; an unexpected throw inside a handler is caught and
 * answered as `INTERNAL`.
 *
 * ## The rules applied
 *
 * | Message | Effect |
 * | --- | --- |
 * | `session.bind` | Only a `devtools` principal binds. The payload's `origin` must be the origin of its `url`. Without `sessionId` the tab binds to the most recently updated live session — neither ended nor failed — whose dev-server origin equals the tab's origin, and to the most recently updated failed one only when no live session serves that origin; with `sessionId` it binds to that session only if its dev-server origin matches — a mismatch is a refusal, never a silent bind. A named session that ended or vanished is refused, and the injected {@link EndedSessionAgentPort} is told so the page disarm it owes is settled. |
 * | `tab.navigated` | Every accepted navigation — kept, dropped, or of a tab not yet bound — is first recorded with the injected {@link NavigationRecorder}, so readiness can tell a page-agent report a reload or a same-URL load left behind. Same origin then keeps the binding, records the new URL, announces it as the binding now stands (`reason: 'bound'`) and re-arms the agent a new document starts dormant; a different origin drops the binding. A navigation of an unbound tab changes no binding. A navigation of a tab id that only another credential holds a binding of is refused `TAB_NOT_BOUND` and records nothing: readiness keys its evidence by tab id, and could not tell it from the other browser's bound tab. |
 * | page-agent report | Every `agent.ready` the readiness path accepts reaches {@link BindingDocumentObserver.documentReported}. A report naming a document other than the one the tab showed before its kept navigation proves that navigation a reload: it is announced (`reason: 'navigated'`) and, while its capture is open, reported as `Page reloaded during capture`. |
 * | `session.unbind` | Drops the sending credential's binding of the tab. Idempotent: a tab that credential has not bound is a no-op, even when another browser's tab with the same id is bound. It never ends the session, cancels a capture or disarms instrumentation. |
 *
 * **A tab that has no session yet awaits one.** A panel is opened — and its
 * tab announced — before the question that creates its session is asked, and
 * stays open while the next question follows a session's end. So the tab is
 * recorded as awaiting a session for its document's origin with
 * {@link ClientRegistry.awaitSession} whenever it is left without one: an
 * origin bind that finds no session, an unbind of a binding whose session has
 * ended (the Chrome worker's own cleanup after `session.end`, while its
 * DevTools stays open), and a navigation that took the tab off its session's
 * origin (recorded for the new origin; the panel shows "Tab left ‹origin›").
 * The next session created for that origin reaches the tab's connection with
 * its `session.created`, and the worker announces the tab again, which binds
 * it here exactly as a freshly opened panel is bound. A session may already
 * serve the origin when the tab starts awaiting — `session.end` and the next
 * `POST /sessions` can both land before the worker's unbind does, so that
 * session's `session.created` found the tab still bound — and then the newest
 * such session is offered to the tab's connection at once
 * ({@link ClientRegistry.offerSessionToAwaitingTab}), with the same effect. An
 * unbind of an unbound tab, or of a binding whose session is still open, is
 * its DevTools closing: the tab awaits nothing more.
 *
 * **Cardinality** (AAP §0.2.3): one tab binds to at most one session and one
 * session accepts one tab at a time. A Chrome tab id is unique only within one
 * browser, so "one tab" is one credential's tab: both stores key a binding by
 * the credential that made it (its `tokenHash`, `boundBy`) and its tab id, and
 * two paired browsers binding their own tab 7 to two sessions keep both
 * bindings and hear nothing of each other. A second bind replaces the first and is
 * announced: once the bind's writes stand, every displaced binding is told with
 * `session.bound` carrying the displaced session, tab and URL and
 * `reason: 'replaced'`, before the new binding is announced — the order the
 * Chrome service worker's tab registry relies on (it drops a record only when
 * a drop names that record's tab *and* session). A redundant re-bind of the
 * same pair by the same credential — a service-worker reconnect re-announcing
 * its bindings — displaces nothing and announces no replacement. The same pair
 * bound by **another** credential is a takeover: the first holder's binding is
 * displaced and announced `replaced` to it, and — because the registry never
 * sends an establishment to a released binding's connection — the new
 * `session.bound` reaches only the new holder and the session's editors.
 *
 * **Two stores, one truth.** The durable `bindings` row
 * (`../../store/sessions-repo.ts`) survives a restart; the live
 * {@link ClientRegistry} view finds the socket. Every mutation writes the store
 * first and the registry second, then mirrors the tab onto the session record
 * through {@link SessionManager.setBoundTab} — the manager is the only writer of
 * the record and the only broadcaster of `session.updated`.
 *
 * **Nothing is announced before every write stands.** A bind writes the row,
 * the live binding and then the record mirrors (each other session that lost
 * its tab cleared, the bound session shown its tab); should the registry or any
 * mirror refuse, every write already made is compensated in reverse — each
 * mirrored record gets its previous bound tab back, the new live binding is
 * released and every live binding it displaced is re-established under the
 * credential that made it, and the new row is removed with the rows it
 * displaced written back — and the original refusal is returned with no
 * `replaced` or `bound` announcement sent. A re-bind of the same tab to the
 * same session — a new URL, or a new DevTools connection — replaces a binding
 * the store never reports displaced (nor does the registry, which updates the
 * same credential's binding in place), so the tab's row and live binding are
 * read before the first write and a refusal puts both back, URL and bound-at
 * stamp included. Compensation failures are logged by ids and codes; a
 * displaced binding whose credential no registered connection holds keeps its
 * durable row, as after a restart. A same-origin navigation
 * is held to the same rule: when the registry or the record refuses the new
 * URL, the row and the registry get the previous URL back and the navigation
 * is neither announced nor re-armed. So is a drop — an unbind or a
 * cross-origin navigation: when the record refuses to clear its bound tab,
 * the live binding and the durable row are put back exactly as they were, the
 * drop is not announced and the refusal is returned, so the retried unbind or
 * the next navigation still finds the binding to drop.
 *
 * **Restoration is status-aware.** The binding queue does not serialize with
 * {@link SessionManager.end}, which may commit `ended` — and remove the
 * session's `bindings` row in the same transaction — while a route awaits a
 * record mirror. A durable row is therefore only ever written back inside one
 * store transaction that first finds its session open; a session that has
 * ended or vanished gets nothing written. A drop whose session ended during
 * its mirror restores neither the live binding nor the row, announces
 * nothing and answers as ignored: `session.end` already did what the drop set
 * out to do. The status read and the writes of a restoration run in one
 * synchronous turn of the single service process that owns the store, so no
 * end can commit between them.
 *
 * **Announcements** go to the session's DevTools and VS Code clients (the two
 * receivers AAP §0.4.2 names) through `broadcastToKinds`. The registry keeps a
 * released binding's connection eligible for release announcements for a
 * short window, which is how a displaced or unbound panel still hears that it
 * lost its binding.
 *
 * **Replay.** After a bind, {@link SessionReopener.reopen} replays the stored
 * record, progress rows, latest analysis and latest panel to the DevTools kind
 * only, so a panel that binds to an existing session re-renders from stored
 * data. Panel node data is not replayed; the panel fetches it through
 * `POST /sessions/:id/panel-data`.
 *
 * **Re-arming** is a request, never an envelope built here: when the session
 * has an open capture, the injected {@link AgentArmingPort} (the instrumentation
 * service's `armCapture`) re-sends `agent.config` for the same `captureId`, so a
 * newly bound tab or a reloaded document continues the capture (AAP §0.5.5,
 * "Page reloaded during capture").
 *
 * **The reload is reported, once — and only a reload.** A `tab.navigated`
 * cannot tell a reload from a same-document URL change (the history API):
 * both keep the binding on a new URL. Only a reload brings a new page-agent
 * document, so a kept navigation is announced at once as the binding as it
 * stands (`reason: 'bound'`) and held until the tab's next accepted report
 * (`agent.ready`, through {@link BindingDocumentObserver}): a report naming
 * another document than the one last reported for the tab before the
 * navigation — or the first report, when none was — proves the reload. It is
 * then announced with `reason: 'navigated'` (the one reason the panel shows a
 * reload notice for), and, while the capture the navigation re-armed is still
 * the session's open capture, told to the developer as exactly one
 * `Page reloaded during capture` progress row of the capture stage, emitted
 * through the injected progress port (`../../sessions/progress.ts`, which
 * persists it for replay and sends it to the session's editor and panel), its
 * detail saying whether the agent resumed. A same-document change, a
 * navigation without an open capture, a refused navigation, a re-relayed
 * report of the previous document and a bind report nothing; a binding that
 * ends forgets its held navigation. The INFO log lines stay.
 *
 * **Explicit unbind versus a dropped socket.** A socket that closes is marked
 * offline by `../ws.ts` and `../clients.ts` and keeps its bindings, because the
 * MV3 service worker suspends after about 30 s of idleness and reconnects with
 * the same credential (AAP §0.5.5). Only `session.unbind` and a cross-origin
 * `tab.navigated` end a binding, and neither touches the session's status, its
 * capture or its instrumentation.
 *
 * **Stale store rows.** After a restart the registry is empty while the store
 * still holds rows. A row records its holder's digest, which keys it but never
 * authorizes a change on its own: no connection proved that credential since
 * the restart. Such a row is left until the panel re-binds (the reconnecting
 * service worker re-announces its tabs, and `upsertBinding` replaces the
 * holder's row — or consumes a row that recorded no holder, one written before
 * holders were recorded) or the session ends. Navigation and unbind act only
 * on live bindings, authorized against the
 * credential that made them with `requireBoundSession`, with the tab the
 * frame's payload names as the acting tab: a frame about tab A changes only
 * tab A's binding, even though every tab of one paired extension presents the
 * same credential. `../ws.ts` delivers a binding frame here only when that tab
 * is the sender's own — a connection whose hello announced a tab may bind,
 * navigate and unbind that tab alone.
 *
 * ## Protocol discipline and privacy
 *
 * No message name, binding reason or client kind is spelled here: the
 * `session.bound` type is resolved by schema identity in protocol's registry,
 * and reasons and kinds are read from protocol's own enums. Every outgoing
 * payload is validated with protocol's parser before it is framed with
 * `createEnvelope`, and incoming payloads are re-validated with protocol's
 * parsers, whose errors are rendered from issue paths and codes only. Error
 * messages are constants and never echo a URL, an origin, an id or a token; log
 * records carry session ids, tab ids, reasons and error codes — never a URL and
 * never a credential digest. Origins are compared as parsed, serialized
 * origins, never by string prefix, and none is hardcoded: they come from the
 * session's stored `devServerUrl` and the payload.
 *
 * **No raw inspected URL outlives the frame** (AAP §0.5.2). The raw document
 * URL is read once, to compute the origin every decision compares; what the
 * `bindings` row, the registry, the record's `boundTab` and every
 * `session.bound` carry is {@link redactBoundUrl}'s form — query values `?` per
 * key, path pattern-scrubbed. A selected-element descriptor is redacted the
 * same way — its URL, and every URL embedded in its text, selector, tag name
 * and component names — by {@link redactSelectedTarget}, which
 * `../../main.ts` applies to `target.selected` and `./sessions.ts` to the
 * target a `session.create` carries, before either reaches the record.
 *
 * Operations are serialized through one queue, so the replacement, the record
 * mirror, the announcements and the replay of one frame are never interleaved
 * with another binding frame's.
 *
 * @example Wiring in `main.ts` and dispatch in `ws.ts`
 * ```ts
 * const binding = createBindingRoutes({
 *   clients,
 *   sessions: sessionsRepo,
 *   manager: sessionManager,
 *   reopener,
 *   arming: instrumentationService,
 *   progress: sessionProgress,
 *   navigations: agentReadyLedger,
 *   logger,
 * });
 * // inside ws.ts's exhaustive switch over the parsed message type:
 * //   const outcome = await binding.handleSessionBind(message.payload, { principal, clientId });
 * //   if (!outcome.ok) reply with protocol's error frame, ref = message.id
 * ```
 *
 * @module
 */

import { parseSelectedTarget, selectedTargetSchema } from '@debuggen/instrumentation';
import {
  MESSAGE_PAYLOAD_SCHEMAS,
  MESSAGE_TYPES,
  SESSION_STATUSES,
  boundTabSchema,
  bindingReasonSchema,
  clientKindSchema,
  createEnvelope,
  parseSessionBindPayload,
  parseSessionBoundPayload,
  parseSessionUnbindPayload,
  parseTabNavigatedPayload,
  progressStageSchema,
  progressStatusSchema,
  sessionBoundPayloadSchema,
  sessionCreatedPayloadSchema,
  sessionStatusSchema,
} from '@debuggen/protocol';
import type {
  AgentReadyPayload,
  BoundTab,
  ClientKind,
  MessagePayload,
  MessageType,
  SelectedTarget,
  SessionBindPayload,
  SessionBoundPayload,
  SessionRecord,
  SessionStatus,
  SessionUnbindPayload,
  TabNavigatedPayload,
} from '@debuggen/protocol';
import {
  DebuggenError,
  assertDefined,
  err,
  isErr,
  noopLogger,
  nowEpochMs,
  ok,
} from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result, SessionId } from '@debuggen/shared';
import { REDACTION_MARKER, redactTextUrls, redactUrl, scrub, truncate } from '@debuggen/telemetry';

import type {
  InstrumentationService,
  ProducerReconciler,
  SignalReportPublisher,
} from '../../instrumentation/service.js';
import { LOG_BINDING_KEYS, subsystemLogger } from '../../logging.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { SessionProgress } from '../../sessions/progress.js';
import type { SessionReopener } from '../../sessions/reopen.js';
import { isTerminalSessionStatus } from '../../sessions/state-machine.js';
import { UNRECORDED_BINDING_HOLDER } from '../../store/sessions-repo.js';
import type {
  BindingUpsert,
  SessionsRepo,
  TabBinding as StoredTabBinding,
} from '../../store/sessions-repo.js';
import { AUTH_FAILURE_REASONS, requireBoundSession, requireRole } from '../auth.js';
import type { Principal } from '../auth.js';
import { heldTabKey } from '../clients.js';
import type {
  BindTabOutcome,
  ClientRegistry,
  RegisteredClient,
  TabBindingView,
} from '../clients.js';

/* -------------------------------------------------------------------------------------------------
 * Section A — protocol vocabulary, resolved rather than restated
 * ---------------------------------------------------------------------------------------------- */

/** The `subsystem` binding of this module's log records, following the file-name convention of `../auth.ts` and `../clients.ts`. */
const LOG_SUBSYSTEM = 'binding';

/** Accepts only `true`, so an assertion that evaluates to `false` fails to compile. */
type AssertTrue<T extends true> = T;

/** Protocol's message registry, as a type. */
type MessagePayloadRegistry = typeof MESSAGE_PAYLOAD_SCHEMAS;

/**
 * The message type whose registered payload schema is exactly `S` — mutual
 * assignability, so a schema that is merely a structural subset of another
 * never resolves to it.
 */
type MessageTypeOfSchema<S> = {
  [K in MessageType]: [MessagePayloadRegistry[K]] extends [S]
    ? [S] extends [MessagePayloadRegistry[K]]
      ? K
      : never
    : never;
}[MessageType];

/** The binding announcement's message type, derived from its schema. */
type SessionBoundMessageType = MessageTypeOfSchema<typeof sessionBoundPayloadSchema>;

/**
 * Compile-time proof that the derivation above resolved to exactly the message
 * whose payload is a {@link SessionBoundPayload}: were it `never` or a union,
 * this alias would stop compiling.
 */
export type SessionBoundMessageTypeResolves = AssertTrue<
  [MessagePayload<SessionBoundMessageType>] extends [SessionBoundPayload]
    ? [SessionBoundPayload] extends [MessagePayload<SessionBoundMessageType>]
      ? true
      : false
    : false
>;

/** Narrows a message type to the binding announcement, by schema identity in protocol's registry. */
function isSessionBoundType(candidate: MessageType): candidate is SessionBoundMessageType {
  return MESSAGE_PAYLOAD_SCHEMAS[candidate] === sessionBoundPayloadSchema;
}

/**
 * The binding announcement's message type, looked up in protocol's registry so
 * no message name is spelled in this module.
 *
 * @throws DebuggenError `INTERNAL` at module load when the schema is not
 * registered — an impossible state for a schema protocol exports.
 */
function resolveSessionBoundType(): SessionBoundMessageType {
  const type = MESSAGE_TYPES.find(isSessionBoundType);
  assertDefined(
    type,
    "The binding announcement's payload schema is not registered in protocol's message registry.",
  );
  return type;
}

/** The binding announcement: the message type this module answers binds with. */
const SESSION_BOUND_TYPE = resolveSessionBoundType();

/**
 * The new-session announcement's message type(s), by payload structure — the
 * `session.updated` payload shares its shape, so this may be a union; the
 * value below is resolved by schema identity and is exactly one of them.
 */
type SessionCreatedMessageType = MessageTypeOfSchema<typeof sessionCreatedPayloadSchema>;

/** Narrows a message type to the new-session announcement, by schema identity in protocol's registry. */
function isSessionCreatedType(candidate: MessageType): candidate is SessionCreatedMessageType {
  return MESSAGE_PAYLOAD_SCHEMAS[candidate] === sessionCreatedPayloadSchema;
}

/**
 * The new-session announcement's message type, looked up in protocol's
 * registry so no message name is spelled in this module.
 *
 * @throws DebuggenError `INTERNAL` at module load when the schema is not
 * registered — an impossible state for a schema protocol exports.
 */
function resolveSessionCreatedType(): SessionCreatedMessageType {
  const type = MESSAGE_TYPES.find(isSessionCreatedType);
  assertDefined(
    type,
    "The new-session announcement's payload schema is not registered in protocol's message registry.",
  );
  return type;
}

/**
 * The new-session announcement, sent only to offer an open session to one
 * tab awaiting its origin (see "A tab that has no session yet awaits one").
 */
const SESSION_CREATED_TYPE = resolveSessionCreatedType();

/** Protocol's binding-reason vocabulary, keyed by member. */
const REASONS = bindingReasonSchema.enum;

/** A binding ended because its tab navigated to another origin. */
const REASON_ORIGIN_CHANGED = REASONS['origin-changed'];

/** A binding ended without a navigation: DevTools closed, the tab closed or the session ended. */
const REASON_UNBOUND = REASONS.unbound;

/** A binding was taken over by another bind. */
const REASON_REPLACED = REASONS.replaced;

/**
 * A binding as it now stands: the announcement of a same-origin navigation
 * when it is committed, which may be a same-document URL change.
 */
const REASON_BOUND = REASONS.bound;

/** A binding kept across a reload: its tab's page agent reported a new document. */
const REASON_NAVIGATED = REASONS.navigated;

/**
 * The most tabs whose latest page-agent document, and whose navigation still
 * awaiting a new document, this module remembers. A tab reports one document
 * per load and a service serves a handful of tabs, so the bound only keeps a
 * misbehaving connection from growing either map without limit. Beyond it the
 * least recently reported tab is forgotten: at worst that tab's next report is
 * compared with no earlier document, and — as for a tab never seen — confirms
 * the navigation it awaits.
 */
const MAX_DOCUMENT_TRACKED_TABS = 1024;

/** The reasons this module ends a binding with. */
type DropReason = typeof REASON_ORIGIN_CHANGED | typeof REASON_UNBOUND;

/** Protocol's client-kind vocabulary, keyed by member. */
const KINDS = clientKindSchema.enum;

/** The only role that may bind, navigate or unbind a tab (AAP §0.5.6). */
const BINDING_ROLE = KINDS.devtools;

/** Who hears a binding announcement: the session's DevTools panel and its VS Code views (AAP §0.4.2). */
const ANNOUNCEMENT_KINDS: readonly ClientKind[] = Object.freeze([KINDS.devtools, KINDS.vscode]);

/** Protocol's progress-stage vocabulary, keyed by member. */
const PROGRESS_STAGE = progressStageSchema.enum;

/** Protocol's progress-status vocabulary, keyed by member. */
const PROGRESS_STATUS = progressStatusSchema.enum;

/** The stage a reload notice is filed under: the capture the reload interrupted. */
const RELOAD_NOTICE_STAGE = PROGRESS_STAGE.capture;

/**
 * A reload notice is a finding within the capture's group — a `done` row, as
 * every finding row is — and never the capture stage's own close.
 */
const RELOAD_NOTICE_STATUS = PROGRESS_STATUS.done;

/** Who receives the reopen replay after a bind: only the panel that just bound; the editor already holds it. */
const REPLAY_KINDS: readonly ClientKind[] = Object.freeze([KINDS.devtools]);

/**
 * The statuses a tab can be bound to a session in: protocol's vocabulary minus
 * the state machine's terminal statuses, derived so neither rule is restated.
 */
const ACTIVE_SESSION_STATUSES: readonly SessionStatus[] = Object.freeze(
  SESSION_STATUSES.filter((status) => !isTerminalSessionStatus(status)),
);

/** Protocol's session-status vocabulary, keyed by member. */
const SESSION_STATUS = sessionStatusSchema.enum;

/**
 * The bindable status of a session a pipeline stage failed: still bindable —
 * the panel shows the failing stage and its retry (AAP §0.5.5) — but never
 * preferred over a session that is still running. Drawn from
 * {@link ACTIVE_SESSION_STATUSES}, so it can never name a terminal status.
 */
const FAILED_SESSION_STATUSES: readonly SessionStatus[] = Object.freeze(
  ACTIVE_SESSION_STATUSES.filter((status) => status === SESSION_STATUS.failed),
);

/**
 * The bindable statuses of a session that is still running: every
 * {@link ACTIVE_SESSION_STATUSES} member except `failed`. A bind by origin
 * searches these first, so a failed second session on the same dev server
 * never takes a new tab from the ready or capturing session beside it.
 */
const LIVE_SESSION_STATUSES: readonly SessionStatus[] = Object.freeze(
  ACTIVE_SESSION_STATUSES.filter((status) => status !== SESSION_STATUS.failed),
);

/**
 * The passes of a bind by origin, in order of preference: a live session, and
 * only when no live session serves the origin, a failed one.
 */
const ORIGIN_LOOKUP_PASSES: readonly (readonly SessionStatus[])[] = Object.freeze([
  LIVE_SESSION_STATUSES,
  FAILED_SESSION_STATUSES,
]);

/** The two URL schemes a document a session can bind to is served over. */
const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * The WHATWG serialization of an opaque origin (`about:`, `chrome:`, `data:`,
 * `file:` …), which is what `URL.prototype.origin` answers for such a document.
 */
const OPAQUE_ORIGIN = 'null';

/**
 * Protocol's rule for a document URL on a session record, in a `session.bound`
 * announcement and in the registry's view alike: an absolute URL within the
 * shared 2048-character bound. Read off the record schema rather than restated.
 */
const DOCUMENT_URL_SCHEMA = boundTabSchema.shape.url;

/** The upstream field rules of a selected-element descriptor, one schema per field. */
const TARGET_FIELD_SCHEMAS = selectedTargetSchema.shape;

/** The upstream rule for one component name of a descriptor's chain. */
const TARGET_COMPONENT_NAME_SCHEMA = TARGET_FIELD_SCHEMAS.componentChain.element;

/* -------------------------------------------------------------------------------------------------
 * Section B — constant refusal wording (never echoes a value)
 * ---------------------------------------------------------------------------------------------- */

const ORIGIN_DISAGREES_MESSAGE =
  'The announced origin is not the HTTP(S) origin of the announced document URL.';
const ORIGIN_DISAGREES_HINT =
  'Send the serialized origin of the inspected document (new URL(url).origin) together with its URL.';

const NAMED_SESSION_MISSING_MESSAGE = 'No session with the requested id exists.';
const NAMED_SESSION_MISSING_HINT =
  'Reopen the session from the Sessions view in VS Code, or bind without a session id to match by origin.';

const ORIGIN_MISMATCH_MESSAGE =
  "The inspected page is not served by the requested session's dev server, so the tab was not bound.";
const ORIGIN_MISMATCH_HINT =
  "Open the Debug Generator panel on a page of the application the session is debugging, at its dev server's address.";

const NO_SESSION_FOR_ORIGIN_MESSAGE =
  'No active session is debugging the application at this origin.';
const NO_SESSION_FOR_ORIGIN_HINT =
  'Start a session from the Debug Generator view in VS Code for this project, then open the panel again.';

const SESSION_ENDED_MESSAGE = 'The session has ended, so no tab can be bound to it.';
const SESSION_ENDED_HINT = 'Start a new session from the Debug Generator view in VS Code.';

const ANNOUNCEMENT_INVALID_MESSAGE =
  'The binding announcement could not be built from the binding state.';

/** The event-log entry AAP §0.5.5 names for a same-origin reload while a capture is open. */
const RELOAD_DURING_CAPTURE_MESSAGE = 'Page reloaded during capture';
const RELOAD_RESUMED_DETAIL =
  'The page agent was re-armed in the reloaded page; the same capture continues.';
const RELOAD_NOT_RESUMED_DETAIL =
  'The page agent could not be re-armed in the reloaded page, so its events are missing from this capture';

const UNEXPECTED_FAILURE_MESSAGE = 'The binding operation failed unexpectedly.';
const UNEXPECTED_FAILURE_HINT =
  'Reopen the Debug Generator panel; the service log names the failing step.';

/* -------------------------------------------------------------------------------------------------
 * Section C — injected ports and the public surface
 * ---------------------------------------------------------------------------------------------- */

/**
 * The agent-arming port: asks the owning subsystem to (re-)send `agent.config`
 * for a session's open capture window.
 *
 * Satisfied structurally by `../../instrumentation/service.ts`'s
 * `InstrumentationService`, whose `armCapture` builds, validates and delivers
 * the configuration to the session's bound tab. This module only supplies the
 * capture id and — for a service that restarted and holds no arming state —
 * the session's project root and the plan version the capture runs under.
 *
 * The optional `replaySignalReport` — `SignalReportPublisher`'s, which the
 * instrumentation driver implements — is how a freshly bound panel learns
 * which signals the session's instrumentation enabled: the stored-state
 * replay of `../../sessions/reopen.ts` carries the record, the progress rows,
 * the analysis and the panel, never the latest `instrumentation.ready` or
 * `instrumentation.failed`, so without it the panel's signal list stays empty
 * for every session installed before the panel bound. The call also names the
 * tab to the driver, which re-judges a report that still waits for the page
 * once that tab's page agent reports. It is optional so a port that only arms
 * captures (a test double, a driver without a report to replay) still fits.
 */
export type AgentArmingPort = Pick<InstrumentationService, 'armCapture'> &
  Partial<Pick<SignalReportPublisher, 'replaySignalReport'>>;

/**
 * The ended-session port: told that a DevTools connection was refused a bind
 * naming a session that ended, failed or no longer exists.
 *
 * Satisfied structurally by `../../instrumentation/service.ts`'s producer
 * reconciler. Only the DevTools service worker names a session in
 * `session.bind`, and only when it re-announces a persisted binding on a new
 * connection — so this refusal is the one moment a tab whose session ended
 * while its connection was away is seen again. The worker answers the refusal
 * (delivered on that live connection, `ref` naming its bind) by ending the
 * tab's binding and returning its page agent to dormant; the reconciler
 * settles the page disarm the session still owed, so a `partial` cleanup can
 * become `clean`. Best effort: the refusal is returned unchanged whatever the
 * port does.
 */
export type EndedSessionAgentPort = Pick<ProducerReconciler, 'pageAgentReleased'>;

/**
 * Where the route records every committed navigation it accepts: a
 * `tab.navigated` from a DevTools principal, well formed, for a tab that is
 * unbound or bound by that principal's own credential — the rule `../ws.ts`
 * applies before it accepts an `agent.ready` for the tab.
 *
 * Satisfied structurally by `../../main.ts`'s agent-ready ledger, which
 * answers the readiness gate's `latestNavigationAt` from these records
 * (`../../instrumentation/readiness.ts`). A navigation is the one sign of a
 * reload or of a load of the same URL, which the binding's URL cannot show:
 * without it, readiness would trust the page-agent report of the document the
 * tab just left, when after a reload mid-session it must rest on the report of
 * the bound tab's current document.
 *
 * Carries the tab id only — never the URL, which is page-shaped text.
 */
export interface NavigationRecorder {
  /**
   * Records that `tabId` committed a navigation now. Synchronous, and must
   * not throw; the route contains a throw regardless, so a recorder fault
   * never changes what the navigation does to the binding.
   */
  recordNavigation(tabId: number): void;
}

/**
 * Everything {@link createBindingRoutes} is given; all of it is injected and
 * each field is narrowed to the members this module calls.
 */
export interface BindingRoutesDeps {
  /**
   * The live bindings and the fan-out; the client registry in production.
   * `get` and `list` find the connection whose credential made a displaced
   * binding, so a refused bind can re-establish it under that credential.
   * `tabHeldByAnotherCredential` is what refuses a navigation of a tab id only
   * another paired browser holds a binding of.
   */
  readonly clients: Pick<
    ClientRegistry,
    | 'bindTab'
    | 'updateTabUrl'
    | 'unbindTab'
    | 'bindingForTab'
    | 'tabHeldByAnotherCredential'
    | 'bindingForSession'
    | 'broadcastToKinds'
    | 'get'
    | 'list'
    | 'awaitSession'
    | 'forgetAwaitingTab'
    | 'offerSessionToAwaitingTab'
  >;
  /**
   * The durable `bindings` rows, session records, the indexed origin lookup
   * and open captures. Every row is read, written and removed under its
   * holder — the binding credential's `tokenHash` — so another browser's row
   * of the same tab id is never touched. `getBindingByTab` reads a tab's row before a bind
   * replaces it or a drop removes it, so a refused re-bind of the same tab and
   * session, or a drop whose record mirror refuses, can write that row back.
   * `transaction` makes every such write-back status-aware: the row's session
   * is read and the row written in one unit, so a session `session.end` closed
   * while the route awaited its record mirror is never bound again.
   */
  readonly sessions: Pick<
    SessionsRepo,
    | 'transaction'
    | 'get'
    | 'findLatestByDevServer'
    | 'getBindingByTab'
    | 'upsertBinding'
    | 'deleteBinding'
    | 'getActiveCapture'
  >;
  /** The one writer of the session record, which mirrors the bound tab and broadcasts `session.updated`. */
  readonly manager: Pick<SessionManager, 'setBoundTab'>;
  /** Replays stored state to a panel that just bound. */
  readonly reopener: Pick<SessionReopener, 'reopen'>;
  /** Re-sends `agent.config` for an open capture. */
  readonly arming: AgentArmingPort;
  /**
   * Told when a bind naming a session is refused because that session ended or
   * vanished, so the page disarm it still owes is settled; the instrumentation
   * service in production. Omitted, the refusal is only returned.
   */
  readonly endedSessions?: EndedSessionAgentPort | undefined;
  /**
   * Where a same-origin reload during an open capture is reported: one `done`
   * row of the capture stage, persisted and sent to the session's editor and
   * panel (AAP §0.5.5, "Page reloaded during capture"). The session progress
   * emitter in production; omitted, the reload is logged only.
   */
  readonly progress?: Pick<SessionProgress, 'emit'> | undefined;
  /**
   * Where every accepted `tab.navigated` is recorded before the binding is
   * kept or dropped; the service's agent-ready ledger in production. Required,
   * so a composition that forgets it does not compile rather than leaving
   * readiness blind to reloads.
   */
  readonly navigations: NavigationRecorder;
  /** The service logger; bound to `subsystem: "binding"`. Defaults to silence. */
  readonly logger?: Logger | undefined;
  /** The clock bindings and frames are stamped with, in epoch milliseconds. Defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
}

/**
 * The connection a binding frame arrived on, as `../ws.ts` resolved it.
 *
 * `principal` is the only authority consulted. `clientId` names the sending
 * connection so the registry prefers it as the tab's recipient; when absent the
 * registry resolves the carrier from the binding credential.
 */
export interface BindingConnection {
  readonly principal: Principal;
  readonly clientId?: string | undefined;
}

/** How a `session.bind` found its session. */
export type SessionMatch = 'session-id' | 'origin';

/** What re-arming the page agent achieved. */
export type AgentRearmStatus = 'rearmed' | 'no-active-capture' | 'failed';

/** The outcome of one re-arm request. */
export interface AgentRearmOutcome {
  readonly status: AgentRearmStatus;
  /** The capture the agent was (or would have been) re-armed for. */
  readonly captureId?: string;
  /** Why a re-arm failed, when it did. */
  readonly errorCode?: DebuggenErrorCode;
}

/** One `session.bound` frame this module sent. */
export interface BindingAnnouncement {
  /** The validated payload that was framed. */
  readonly payload: SessionBoundPayload;
  /** How many connections received it. */
  readonly delivered: number;
}

/** What a successful `session.bind` did. */
export interface SessionBindOutcome {
  readonly sessionId: SessionId;
  readonly tabId: number;
  /** The bound document's URL as recorded and announced: redacted by {@link redactBoundUrl}. */
  readonly url: string;
  /** Whether the session was named by the panel or matched by origin. */
  readonly matchedBy: SessionMatch;
  /** The establishment announcement. */
  readonly announced: BindingAnnouncement;
  /** The `replaced` announcements of every binding the bind displaced, in send order. */
  readonly displaced: readonly BindingAnnouncement[];
  /** Whether the reopen replay delivered stored state to the panel. */
  readonly replayed: boolean;
  /** Whether the agent was re-armed for an open capture. */
  readonly rearm: AgentRearmOutcome;
}

/** What a `tab.navigated` did. */
export type TabNavigatedOutcome =
  /** The tab is not bound: no binding changes (the navigation itself is still recorded). */
  | { readonly kind: 'ignored' }
  /** Same origin: the binding was kept, its URL recorded and the agent re-armed. */
  | {
      readonly kind: 'kept';
      readonly announced: BindingAnnouncement;
      readonly rearm: AgentRearmOutcome;
    }
  /** Another origin (or a session that no longer exists): the binding was dropped. */
  | { readonly kind: 'dropped'; readonly announced: BindingAnnouncement };

/** What a `session.unbind` did. */
export type SessionUnbindOutcome =
  /** The tab was not bound: the unbind is an idempotent no-op. */
  | { readonly kind: 'ignored' }
  /** The binding was dropped and announced. */
  | { readonly kind: 'dropped'; readonly announced: BindingAnnouncement };

/**
 * The three WebSocket handlers `../ws.ts` dispatches the binding messages to.
 *
 * Each takes the parsed payload and the connection it arrived on, never throws,
 * and answers `Err` with a `DebuggenError` the caller turns into protocol's
 * `error` frame.
 */
export interface BindingRoutes {
  /**
   * `session.bind` → `session.bound`.
   *
   * @returns The binding established; `UNAUTHORIZED` for a non-DevTools
   * principal; `PROTOCOL_INVALID_MESSAGE` for a malformed payload or an origin
   * that disagrees with its URL; `SESSION_NOT_FOUND` when the named session does
   * not exist or no active session serves the origin; `TAB_NOT_BOUND` when the
   * named session's dev server has another origin; `SESSION_INVALID_STATE` for
   * an ended session; `STORE_ERROR` when the binding could not be persisted.
   */
  handleSessionBind(
    payload: SessionBindPayload,
    connection: BindingConnection,
  ): Promise<Result<SessionBindOutcome, DebuggenError>>;

  /**
   * `tab.navigated`: record the navigation with the {@link NavigationRecorder},
   * then keep and re-arm on the same origin, drop on another.
   *
   * @returns What was done; `UNAUTHORIZED` for a non-DevTools principal;
   * `TAB_NOT_BOUND` when the credential holds no binding of the tab id and
   * another credential does; `PROTOCOL_INVALID_MESSAGE` for a malformed
   * payload; `STORE_ERROR`.
   */
  handleTabNavigated(
    payload: TabNavigatedPayload,
    connection: BindingConnection,
  ): Promise<Result<TabNavigatedOutcome, DebuggenError>>;

  /**
   * `session.unbind`: drop the credential's own binding of the tab,
   * idempotently — another browser's binding of the same tab id is never
   * reached, and an unbind of a tab the credential has not bound is ignored.
   *
   * @returns What was done; `UNAUTHORIZED` for a non-DevTools principal;
   * `PROTOCOL_INVALID_MESSAGE` for a malformed payload; `STORE_ERROR`.
   */
  handleSessionUnbind(
    payload: SessionUnbindPayload,
    connection: BindingConnection,
  ): Promise<Result<SessionUnbindOutcome, DebuggenError>>;
}

/** One page-agent document report the readiness path accepted for a tab. */
export interface DocumentReport {
  readonly tabId: number;
  /** The reporting document's id, as the page agent minted it. */
  readonly documentId: string;
  /**
   * The principal of the connection that relayed the report. A tab id is
   * unique only within one browser, so the report is about that credential's
   * tab — its document state and its binding — and never another browser's
   * tab with the same id.
   */
  readonly principal: Principal;
}

/** A kept navigation of a tab, waiting for a new page-agent document to prove it a reload. */
interface AwaitingDocument {
  /** The session the navigation kept the tab bound to. */
  readonly sessionId: SessionId;
  /** What re-arming the agent for the session's open capture achieved at the navigation. */
  readonly rearm: AgentRearmOutcome;
  /** The document last reported for the tab before the navigation; unknown when none was. */
  readonly previousDocumentId: string | undefined;
}

/**
 * The second thing {@link createBindingRoutes} answers: the observer of every
 * page-agent document report the service accepted, which is what proves a
 * kept navigation a reload.
 *
 * A `tab.navigated` alone cannot: a same-document URL change (the history
 * API) is reported exactly like a reload, and only a reload brings a new page
 * agent document. So a kept navigation is announced at once as the binding as
 * it now stands (`reason: 'bound'`, the new URL), and a report naming a
 * document other than the one the tab showed before it is what announces the
 * reload (`reason: 'navigated'`) and, while the capture it re-armed is still
 * open, emits the one `Page reloaded during capture` row.
 */
export interface BindingDocumentObserver {
  /**
   * Applies one accepted report, in order with the binding operations. Never
   * rejects; a failure inside is logged and contained.
   */
  documentReported(report: DocumentReport): Promise<void>;
}

/** A value, or a promise of one. */
type MaybePromise<T> = T | Promise<T>;

/**
 * The page-agent readiness port of `../ws.ts` (`AgentReadinessPort`),
 * declared structurally over the connection type it is handed, because this
 * module never imports the router.
 */
export interface AgentReadyPort<Client> {
  agentReady(
    payload: AgentReadyPayload,
    client: Client,
  ): MaybePromise<Result<unknown, DebuggenError>>;
}

/**
 * Wraps a readiness port so every `agent.ready` it accepts is also told to
 * `observer`, after the port answered `Ok` and before that answer is returned
 * — so the service has applied the report to the tab's binding by the time
 * the router moves on to the connection's next frame. A refused report is
 * told nothing; a throw from the port propagates unchanged (the router answers
 * it as `INTERNAL`). The observer is told the relaying connection's principal
 * with the report, so the report reaches that credential's tab only.
 *
 * @example
 * ```ts
 * const readiness = observingDocumentReports(ledger, binding); // then wrapped for re-gating
 * ```
 */
export function observingDocumentReports<Client extends { readonly principal: Principal }>(
  port: AgentReadyPort<Client>,
  observer: BindingDocumentObserver,
): AgentReadyPort<Client> {
  return Object.freeze({
    agentReady: async (
      payload: AgentReadyPayload,
      client: Client,
    ): Promise<Result<unknown, DebuggenError>> => {
      const recorded = await port.agentReady(payload, client);
      if (recorded.ok) {
        await observer.documentReported({
          tabId: payload.tabId,
          documentId: payload.documentId,
          principal: client.principal,
        });
      }
      return recorded;
    },
  });
}

/* -------------------------------------------------------------------------------------------------
 * Section D — pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The serialized HTTP(S) origin of a URL, or `undefined` for one that does not
 * parse or whose origin is opaque (`about:`, `chrome:`, `file:` …).
 *
 * The comparison every binding decision rests on: two documents share an
 * origin exactly when these strings are equal, so a different port, a
 * different scheme and a host that merely shares a prefix all differ.
 */
export function serializedOriginOf(url: string): string | undefined {
  const parsed = URL.parse(url);
  if (parsed === null || !HTTP_PROTOCOLS.has(parsed.protocol)) {
    return undefined;
  }
  return parsed.origin;
}

/**
 * Whether a document URL belongs to a session's dev server: both parse to the
 * same serialized HTTP(S) origin.
 */
export function isSessionOrigin(devServerUrl: string, documentUrl: string): boolean {
  const sessionOrigin = serializedOriginOf(devServerUrl);
  return sessionOrigin !== undefined && sessionOrigin === serializedOriginOf(documentUrl);
}

/** Whether a value satisfies protocol's document-URL rule (absolute, at most 2048 characters). */
function isRecordableUrl(value: string): boolean {
  return DOCUMENT_URL_SCHEMA.safeParse(value).success;
}

/**
 * The shortest honest stand-in for a document URL whose redacted form cannot
 * be recorded: `${origin}/` for an HTTP(S) document, the tuple origin of
 * another special scheme (`ws:`, `ftp:`), or the bare scheme of an
 * opaque-origin document (`about:`, `chrome:`, `file:`). `undefined` only for
 * a value that is not an absolute URL at all.
 */
function documentUrlFallback(raw: string, origin: string | undefined): string | undefined {
  if (origin !== undefined) {
    return `${origin}/`;
  }
  const parsed = URL.parse(raw);
  if (parsed === null) {
    return undefined;
  }
  const candidate = parsed.origin === OPAQUE_ORIGIN ? parsed.protocol : `${parsed.origin}/`;
  return isRecordableUrl(candidate) ? candidate : undefined;
}

/**
 * The form of an inspected document's URL that may be persisted, mirrored onto
 * the session record, held by the registry and announced (AAP §0.5.2: query
 * values become `?` per key for display *and* storage; the path is kept and
 * pattern-scrubbed; userinfo and a non-empty fragment are masked).
 *
 * Redaction is `@debuggen/telemetry`'s `redactUrl`, the same function ingest
 * applies to captured request URLs, so a bound URL and a captured one read
 * alike. The result must still be recordable and still belong to the origin
 * the caller compared: were the redacted text longer than protocol's bound, or
 * were it to parse to another origin or scheme, `${origin}/` (or its
 * opaque-origin analogue) is returned instead — never the raw URL.
 *
 * The raw URL is used only by the caller, ephemerally, for the origin
 * comparison every binding decision rests on; this is the value that outlives
 * the frame.
 *
 * @param raw The document URL exactly as the panel or the service worker sent it.
 * @param origin The caller's {@link serializedOriginOf} of `raw` — the origin it
 * compared — or `undefined` for a document without an HTTP(S) origin.
 * @returns The redacted URL; for a value that is not an absolute URL at all,
 * the redacted text, which the caller's schema validation then refuses.
 *
 * @example
 * ```ts
 * redactBoundUrl('http://127.0.0.1:3000/reports?token=abc&sort=price', 'http://127.0.0.1:3000');
 * // → 'http://127.0.0.1:3000/reports?token=?&sort=?'
 * ```
 */
export function redactBoundUrl(raw: string, origin: string | undefined): string {
  const redacted = redactUrl(raw);
  const keepsOrigin =
    serializedOriginOf(redacted) === origin &&
    (origin !== undefined || URL.parse(redacted)?.protocol === URL.parse(raw)?.protocol);
  if (keepsOrigin && isRecordableUrl(redacted)) {
    return redacted;
  }
  return documentUrlFallback(raw, origin) ?? redacted;
}

/** Anything a descriptor field can be checked against: the upstream field schema. */
interface FieldRule {
  safeParse(value: unknown): { readonly success: boolean };
}

/**
 * One label of a selected-element descriptor, redacted and still satisfying
 * its upstream field rule.
 *
 * Two passes, in the order `@debuggen/telemetry` requires: `scrub` replaces
 * every secret-shaped run by pattern, then `redactTextUrls` masks the query
 * values and fragment of every URL the label embeds — an absolute link text
 * (`http://127.0.0.1:3000/reset?code=…`), an origin-relative reference in a
 * sentence (`Visit /reset?code=…`) or an attribute selector
 * (`a[href="/p?id=…"]`) — keeping keys, paths and the surrounding text. Should
 * the masks have lengthened the label past the rule's bound, it is truncated
 * back to the length the valid original had; truncation only ever shortens
 * the redacted text. `undefined` when neither form satisfies the rule.
 */
function redactedLabel(value: string, rule: FieldRule): string | undefined {
  const redacted = redactTextUrls(scrub(value));
  if (rule.safeParse(redacted).success) {
    return redacted;
  }
  const bounded = truncate(redacted, value.length);
  return rule.safeParse(bounded).success ? bounded : undefined;
}

/**
 * The form of a selected-element descriptor that may be stored on a session
 * record, broadcast and handed to Stage 1 (AAP §0.5.2): its `url` through
 * {@link redactBoundUrl}, and its `text`, `selector`, `tagName` and every
 * component name through `@debuggen/telemetry`'s `scrub` and then its
 * `redactTextUrls`, so neither a bearer token, a JWT or a key the page
 * rendered into a label nor the query value of a URL a label embeds — a link
 * whose text is its own address, `Visit /reset?coupon=…`, an attribute
 * selector `a[href="/p?id=…"]` — reaches the store: each such value becomes
 * `?` per key, exactly as in the descriptor's own `url`.
 *
 * The result re-validates with `parseSelectedTarget`. A field whose redacted
 * form no longer satisfies its rule degrades rather than failing the frame:
 * `text` (optional) is omitted, a component name is dropped from the chain,
 * `selector` and `tagName` become the redaction marker, and `url` falls back to
 * `${origin}/`. Should even that not validate — possible only for an input that
 * was not a valid descriptor to begin with — the most conservative descriptor
 * is returned, still redacted, and the record's own validation refuses it
 * downstream. No field of the input is ever returned unredacted.
 *
 * @param target A descriptor as `target.selected` or `session.create` carried it.
 * @returns The redacted descriptor.
 */
export function redactSelectedTarget(target: SelectedTarget): SelectedTarget {
  const origin = serializedOriginOf(target.url);
  const redactedUrl = redactBoundUrl(target.url, origin);
  const url =
    TARGET_FIELD_SCHEMAS.url.safeParse(redactedUrl).success || origin === undefined
      ? redactedUrl
      : `${origin}/`;
  const text =
    target.text === undefined ? undefined : redactedLabel(target.text, TARGET_FIELD_SCHEMAS.text);
  const redacted: SelectedTarget = {
    selector: redactedLabel(target.selector, TARGET_FIELD_SCHEMAS.selector) ?? REDACTION_MARKER,
    tagName: redactedLabel(target.tagName, TARGET_FIELD_SCHEMAS.tagName) ?? REDACTION_MARKER,
    ...(text === undefined ? {} : { text }),
    componentChain: target.componentChain.flatMap((name) => {
      const label = redactedLabel(name, TARGET_COMPONENT_NAME_SCHEMA);
      return label === undefined ? [] : [label];
    }),
    url,
  };
  const validated = parseSelectedTarget(redacted);
  if (validated.ok) {
    return validated.value;
  }
  return { selector: REDACTION_MARKER, tagName: REDACTION_MARKER, componentChain: [], url };
}

/** A typed refusal whose message and hint are constants. */
function refusal(
  code: DebuggenErrorCode,
  message: string,
  hint: string,
  details?: LogFields,
): Result<never, DebuggenError> {
  return err(
    new DebuggenError(code, message, details === undefined ? { hint } : { hint, details }),
  );
}

/** The log fields that describe an error without its content: the code and, when present, its enumerated reason. */
function errorFields(error: DebuggenError): LogFields {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' ? { code: error.code, reason } : { code: error.code };
}

/** The name of a thrown value, for a log line that must not carry its message. */
function thrownName(thrown: unknown): string {
  return thrown instanceof Error ? thrown.name : typeof thrown;
}

/** Whether a session record already mirrors exactly this bound tab. */
function recordShowsTab(record: SessionRecord, tabId: number, url: string): boolean {
  return record.boundTab?.tabId === tabId && record.boundTab.url === url;
}

/** One binding a bind displaced, from whichever store reported it. */
interface DisplacedBinding {
  readonly sessionId: SessionId;
  readonly tabId: number;
  readonly url: string;
  /**
   * The `tokenHash` of the DevTools credential that held the binding;
   * `UNRECORDED_BINDING_HOLDER` for a durable row that recorded none — one
   * written before the store recorded holders, which is nobody's in
   * particular, so a bind of its very tab and session consumes it silently.
   * Compared, never logged.
   */
  readonly boundBy: string;
}

/** The binding a bind made: the pair and the binding credential's `tokenHash`. */
interface BoundIdentity {
  readonly sessionId: SessionId;
  readonly tabId: number;
  readonly boundBy: string;
}

/**
 * The bindings a bind displaced, from the live view and the durable store,
 * each once, the live view first. The store can report a binding the live view
 * no longer holds (a row written before a restart); that session lost its tab
 * too and is told the same way.
 *
 * Whether a binding is left out depends on its holder as well as its pair.
 * One that pairs the very tab and session of the new binding is left out only
 * when the binder itself held it (a re-announcement, which displaces nothing)
 * or no holder was recorded; held by **another** credential, it was taken over
 * and is announced `replaced` like any other displaced binding (AAP §0.2.3: "a
 * second bind replaces the first and is announced").
 *
 * Entries are merged by pair alone. A session holds at most one binding in
 * each store, so a pair both stores report within one bind is one binding
 * seen twice — the live view names its holder, and so does its row, unless
 * the row was written before the store recorded holders — and it is announced
 * once, from the live view.
 */
function mergeDisplaced(
  live: readonly { readonly binding: TabBindingView }[],
  stored: BindingUpsert,
  bound: BoundIdentity,
): readonly DisplacedBinding[] {
  const merged = new Map<string, DisplacedBinding>();
  const add = (entry: DisplacedBinding): void => {
    if (
      entry.sessionId === bound.sessionId &&
      entry.tabId === bound.tabId &&
      (entry.boundBy === bound.boundBy || entry.boundBy === UNRECORDED_BINDING_HOLDER)
    ) {
      return;
    }
    const key = `${String(entry.tabId)}\u0000${entry.sessionId}`;
    if (!merged.has(key)) {
      merged.set(key, entry);
    }
  };
  for (const change of live) {
    add({
      sessionId: change.binding.sessionId,
      tabId: change.binding.tabId,
      url: change.binding.url,
      boundBy: change.binding.boundBy,
    });
  }
  for (const row of [stored.displacedTab, stored.displacedSession]) {
    if (row !== undefined) {
      add({
        sessionId: row.sessionId,
        tabId: row.tab.tabId,
        url: row.tab.url,
        boundBy: row.boundBy,
      });
    }
  }
  return [...merged.values()];
}

/* -------------------------------------------------------------------------------------------------
 * Section E — the route
 * ---------------------------------------------------------------------------------------------- */

/** A session the bind resolved, and how. */
interface ResolvedSession {
  readonly record: SessionRecord;
  readonly matchedBy: SessionMatch;
}

/** One session-record mirror a bind wrote, and the bound tab the record showed before it. */
interface MirrorWrite {
  readonly sessionId: SessionId;
  readonly previous: BoundTab | undefined;
}

/**
 * What a tab was bound to when a bind began, in both stores.
 *
 * A re-bind of the same tab to the same session — a new URL, or a new
 * DevTools connection — replaces this binding unreported: `upsertBinding`
 * reports only another session's or another tab's row as displaced, and the
 * registry, when the same credential re-binds, updates its binding in place
 * and reports nothing either. Only this snapshot lets a refused re-bind put
 * the tab's row and live binding back.
 */
interface PriorBinding {
  /**
   * The binder's view of the tab's durable row (its own row, else the tab's
   * row that recorded no holder), or `undefined` when it had none.
   */
  readonly row: StoredTabBinding | undefined;
  /** The binder's own live binding of the tab, or `undefined` when it had none. */
  readonly live: TabBindingView | undefined;
}

/** Everything a bind wrote before a later step refused, for {@link BindingRoutes.handleSessionBind}'s compensation. */
interface BindUndo {
  /** The durable row the bind wrote, with the rows it displaced. */
  readonly stored: BindingUpsert;
  /** The live binding the bind made, with the bindings it displaced; absent when the registry refused. */
  readonly live: BindTabOutcome | undefined;
  /** The record mirrors that succeeded, in write order. */
  readonly mirrored: readonly MirrorWrite[];
  /** The tab's bindings before the bind, for the one a same-pair re-bind replaces unreported. */
  readonly prior: PriorBinding;
  /** The tab the bind was for. */
  readonly tabId: number;
  /** The binding credential, the only one that may release the new live binding. */
  readonly principal: Principal;
}

/** What makes two bindings one: the holder, the tab and the session. */
interface BindingIdentity {
  readonly tabId: number;
  readonly sessionId: string;
  /** The holder's `tokenHash`, or `UNRECORDED_BINDING_HOLDER`. Compared, never logged. */
  readonly boundBy: string;
}

/**
 * Whether two bindings are one: the same holder pairing the same tab with the
 * same session. Two paired browsers' bindings of the same tab id and session
 * are two bindings, one of which displaced the other.
 */
function sameBinding(left: BindingIdentity, right: BindingIdentity): boolean {
  return (
    left.tabId === right.tabId &&
    left.sessionId === right.sessionId &&
    left.boundBy === right.boundBy
  );
}

/** The holder, tab and session of a durable row, in the shape {@link sameBinding} compares. */
function identityOfRow(row: StoredTabBinding): BindingIdentity {
  return { tabId: row.tab.tabId, sessionId: row.sessionId, boundBy: row.boundBy };
}

/**
 * Whether a session can no longer hold a binding: its record is gone
 * (purged by retention) or its status is terminal by the state machine's rule
 * (`ended`). An ended session is no recipient of tab-bound messages.
 */
function isClosedSession(record: SessionRecord | undefined): boolean {
  return record === undefined || isTerminalSessionStatus(record.status);
}

/**
 * What writing one previous durable row back came to.
 *
 * - `restored`: the row stands again, with its own URL and bound-at stamp.
 * - `session-closed`: its session has ended or no longer exists, so nothing was
 *   written — the state `session.end` (or retention) left stands.
 * - `failed`: the session could not be read or the row could not be written;
 *   logged by ids and codes.
 */
type RowRestoration = 'restored' | 'session-closed' | 'failed';

/**
 * What putting back a binding a refused drop removed came to.
 *
 * - `restored`: the live binding was re-established and the row written back
 *   (each failure logged), so the drop is refused and can be retried.
 * - `session-closed`: the session was confirmed ended or vanished before
 *   anything was written, so neither store was touched and the drop stands.
 */
type DropRestoration = 'restored' | 'session-closed';

/**
 * Builds the binding route over its injected collaborators.
 *
 * Constructing it has no side effect: no timer, no socket, no store access.
 *
 * @param deps The registry, the repository, the manager, the reopener, the
 * arming port, the navigation recorder, and the optional ended-session port,
 * progress port, logger and clock.
 * @returns The three handlers `../ws.ts` dispatches to, and the
 * {@link BindingDocumentObserver} the readiness path tells of each accepted
 * page-agent report (wire it with {@link observingDocumentReports}).
 */
export function createBindingRoutes(
  deps: BindingRoutesDeps,
): BindingRoutes & BindingDocumentObserver {
  const { clients, sessions, manager, reopener, arming, navigations } = deps;
  const clock = deps.now ?? nowEpochMs;
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);

  /** The fields that name a session in a log record. */
  const sessionFields = (sessionId: SessionId, extra: LogFields = {}): LogFields => ({
    [LOG_BINDING_KEYS.sessionId]: sessionId,
    ...extra,
  });

  /* ---- serialization ---- */

  /** The tail of the operation queue; every queued task settles it, never rejects it. */
  let tail: Promise<void> = Promise.resolve();

  /**
   * Runs one binding operation after every earlier one has settled, and turns
   * a throw into an `INTERNAL` refusal so no frame can take the connection down.
   */
  function exclusive<T>(
    operation: string,
    task: () => Promise<Result<T, DebuggenError>>,
  ): Promise<Result<T, DebuggenError>> {
    const run = tail.then(async (): Promise<Result<T, DebuggenError>> => {
      try {
        return await task();
      } catch (thrown) {
        log.error('A binding operation threw', { operation, errorName: thrownName(thrown) });
        return err(
          DebuggenError.is(thrown)
            ? thrown
            : new DebuggenError('INTERNAL', UNEXPECTED_FAILURE_MESSAGE, {
                hint: UNEXPECTED_FAILURE_HINT,
                details: { operation },
                cause: thrown,
              }),
        );
      }
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /* ---- page-agent documents ---- */

  /**
   * Per credential and tab (`heldTabKey`): the last page-agent document
   * reported for it — what a kept navigation's new document is told apart
   * from. Keyed by the relaying credential as well as the tab id, because a
   * tab id is unique only within one browser. Oldest report first, bounded by
   * {@link MAX_DOCUMENT_TRACKED_TABS}.
   */
  const reportedDocuments = new Map<string, string>();

  /**
   * Per credential and tab (`heldTabKey`, the binding's holder): the kept
   * navigation still waiting for a new page-agent document to prove it a
   * reload, bounded like {@link reportedDocuments}. An entry leaves when a
   * report confirms it, when the next kept navigation replaces it, and when
   * the tab's binding ends.
   */
  const awaitingDocument = new Map<string, AwaitingDocument>();

  /** Sets `key` as the most recent entry of a bounded map, evicting the oldest beyond the bound. */
  function rememberBounded<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_DOCUMENT_TRACKED_TABS) {
      const oldest = map.keys().next();
      if (oldest.done === true) {
        break;
      }
      map.delete(oldest.value);
    }
  }

  /**
   * Applies one accepted page-agent report: remembers the tab's document and,
   * when a kept navigation of the tab awaits a new document and this is one,
   * announces the reload — `reason: 'navigated'` with the live binding's URL —
   * and, while the capture the navigation re-armed is still the session's
   * open capture, reports `Page reloaded during capture` once. A navigation
   * whose tab has since been bound elsewhere, or whose capture has closed, is
   * forgotten without a word about the capture.
   */
  function applyDocumentReport(report: DocumentReport): Result<void, DebuggenError> {
    const { tabId, documentId, principal } = report;
    // The relaying credential's tab: another browser's tab with the same id
    // has its own document state and binding, which this report never touches.
    const key = heldTabKey(principal.tokenHash, tabId);
    rememberBounded(reportedDocuments, key, documentId);
    const awaiting = awaitingDocument.get(key);
    if (awaiting === undefined || awaiting.previousDocumentId === documentId) {
      // No navigation awaits a document, or the document the tab showed
      // before it reported again (a re-relayed report): nothing is proven.
      return ok(undefined);
    }
    awaitingDocument.delete(key);
    const { sessionId, rearm } = awaiting;
    const live = clients.bindingForTab(tabId, principal);
    if (live?.sessionId !== sessionId) {
      log.debug(
        'A reload was confirmed for a tab no longer bound to its session; nothing was announced',
        sessionFields(sessionId, { tabId }),
      );
      return ok(undefined);
    }
    const announced = announce({ sessionId, tabId, url: live.url, reason: REASON_NAVIGATED });
    if (isErr(announced)) {
      return announced;
    }
    const reloadNotice = captureStillOpen(sessionId, rearm)
      ? reportReloadDuringCapture(sessionId, rearm)
      : false;
    log.info(
      'A new page-agent document confirmed a reload of the bound tab',
      sessionFields(sessionId, { tabId, reloadNotice }),
    );
    return ok(undefined);
  }

  /**
   * Whether the capture a kept navigation re-armed (or tried to) is still the
   * session's open capture. A store that cannot answer is taken as closed: a
   * missing notice is logged, a false one would mislead.
   */
  function captureStillOpen(sessionId: SessionId, rearm: AgentRearmOutcome): boolean {
    if (rearm.captureId === undefined) {
      return false;
    }
    const active = sessions.getActiveCapture(sessionId);
    if (isErr(active)) {
      log.warn(
        'The open capture could not be read; the reload was not reported to it',
        sessionFields(sessionId, errorFields(active.error)),
      );
      return false;
    }
    return active.value?.capture.id === rearm.captureId;
  }

  /* ---- announcements ---- */

  /**
   * Validates a `session.bound` payload, frames it and delivers it to the
   * session's DevTools and VS Code clients (including a connection whose
   * binding was just released).
   */
  function announce(payload: SessionBoundPayload): Result<BindingAnnouncement, DebuggenError> {
    const validated = parseSessionBoundPayload(payload);
    if (isErr(validated)) {
      log.error(
        'A binding announcement failed its schema and was not sent',
        sessionFields(payload.sessionId, errorFields(validated.error)),
      );
      return refusal('INTERNAL', ANNOUNCEMENT_INVALID_MESSAGE, UNEXPECTED_FAILURE_HINT);
    }
    const message = createEnvelope(SESSION_BOUND_TYPE, validated.value, { ts: clock() });
    const delivered = clients.broadcastToKinds(
      validated.value.sessionId,
      ANNOUNCEMENT_KINDS,
      message,
    );
    log.debug(
      'Binding announced',
      sessionFields(validated.value.sessionId, {
        tabId: validated.value.tabId,
        reason: validated.value.reason,
        delivered,
      }),
    );
    return ok({ payload: validated.value, delivered });
  }

  /* ---- the session record mirror ---- */

  /**
   * Mirrors a tab (or its absence) onto a session record through the manager.
   * A failure is logged and reported; the two routing stores are unaffected.
   */
  async function mirrorBoundTab(
    sessionId: SessionId,
    boundTab: BoundTab | undefined,
  ): Promise<Result<void, DebuggenError>> {
    const mirrored = await manager.setBoundTab(sessionId, boundTab);
    if (isErr(mirrored)) {
      log.warn(
        'The bound tab could not be mirrored onto the session record',
        sessionFields(sessionId, { ...errorFields(mirrored.error), bound: boundTab !== undefined }),
      );
      return mirrored;
    }
    return ok(undefined);
  }

  /* ---- re-arming ---- */

  /**
   * Asks the arming port to re-send `agent.config` for the session's open
   * capture, if it has one, so the tab's current document (freshly bound or
   * freshly loaded) continues the same capture. Never fails the caller.
   */
  function rearmAgent(record: SessionRecord): AgentRearmOutcome {
    const sessionId = record.id;
    const active = sessions.getActiveCapture(sessionId);
    if (isErr(active)) {
      log.warn(
        'The open capture could not be read; the agent was not re-armed',
        sessionFields(sessionId, errorFields(active.error)),
      );
      return { status: 'failed', errorCode: active.error.code };
    }
    if (active.value === undefined) {
      return { status: 'no-active-capture' };
    }
    const capture = active.value.capture;
    const plan = record.plans.find((candidate) => candidate.planVersion === capture.planVersion);
    const armed = arming.armCapture({
      sessionId,
      captureId: capture.id,
      projectRoot: record.projectRoot,
      plan,
    });
    if (isErr(armed)) {
      log.warn(
        'The page agent could not be re-armed for the open capture',
        sessionFields(sessionId, {
          [LOG_BINDING_KEYS.captureId]: capture.id,
          ...errorFields(armed.error),
        }),
      );
      return { status: 'failed', captureId: capture.id, errorCode: armed.error.code };
    }
    log.info(
      'Page agent re-armed for the open capture',
      sessionFields(sessionId, { [LOG_BINDING_KEYS.captureId]: capture.id }),
    );
    return { status: 'rearmed', captureId: capture.id };
  }

  /**
   * Replays the session's latest signal report — the `instrumentation.ready`
   * (or `instrumentation.failed`) the instrumentation driver holds for it — to
   * the freshly bound panel, and names the bound tab to the driver so a report
   * still waiting for the page is re-judged once that tab's page agent reports.
   *
   * Runs after the stored-state replay, so the panel receives the signal
   * report after the record and the progress rows it belongs to. Best effort
   * and bounded to the port's synchronous answer: a port without the method,
   * a session with nothing to replay, a refusal or a throw is logged (ids and
   * codes only — never the URL) and never changes the bind's answer.
   *
   * @param sessionId - The session the tab was just bound to.
   * @param boundTab - The tab now bound, with the redacted URL the stores hold.
   * @returns `true` when a signal report was sent to the panel.
   */
  function replaySignalReport(
    sessionId: SessionId,
    boundTab: { readonly tabId: number; readonly url: string },
  ): boolean {
    if (arming.replaySignalReport === undefined) {
      return false;
    }
    try {
      // Called on the port, so an implementation that reads `this` keeps it.
      const replayed = arming.replaySignalReport({ sessionId, boundTab, kinds: REPLAY_KINDS });
      if (isErr(replayed)) {
        log.warn(
          'The signal report could not be replayed to the bound panel',
          sessionFields(sessionId, { tabId: boundTab.tabId, ...errorFields(replayed.error) }),
        );
        return false;
      }
      log.debug(
        'Signal report replay to the bound panel settled',
        sessionFields(sessionId, { tabId: boundTab.tabId, outcome: replayed.value }),
      );
      return replayed.value === 'replayed';
    } catch (thrown) {
      log.warn(
        'Replaying the signal report to the bound panel threw',
        sessionFields(sessionId, { tabId: boundTab.tabId, errorName: thrownName(thrown) }),
      );
      return false;
    }
  }

  /**
   * Reports a same-origin reload of the bound tab while the session has an
   * open capture — the re-arm named a capture — as exactly one progress row:
   * the `Page reloaded during capture` entry of the capture stage, whose
   * detail says whether the agent resumed (with the error code when it did
   * not) and carries no URL. Best effort: a row that cannot be emitted is
   * logged and never fails the navigation, which has already been announced.
   *
   * @returns Whether the row was emitted.
   */
  function reportReloadDuringCapture(sessionId: SessionId, rearm: AgentRearmOutcome): boolean {
    if (deps.progress === undefined || rearm.captureId === undefined) {
      return false;
    }
    const detail =
      rearm.status === 'rearmed'
        ? RELOAD_RESUMED_DETAIL
        : rearm.errorCode === undefined
          ? `${RELOAD_NOT_RESUMED_DETAIL}.`
          : `${RELOAD_NOT_RESUMED_DETAIL} (${rearm.errorCode}).`;
    const fields = sessionFields(sessionId, { [LOG_BINDING_KEYS.captureId]: rearm.captureId });
    try {
      const emitted = deps.progress.emit(sessionId, {
        stage: RELOAD_NOTICE_STAGE,
        status: RELOAD_NOTICE_STATUS,
        message: RELOAD_DURING_CAPTURE_MESSAGE,
        detail,
      });
      if (isErr(emitted)) {
        log.warn('The reload-during-capture notice was not emitted', {
          ...fields,
          ...errorFields(emitted.error),
        });
        return false;
      }
      return true;
    } catch (thrown) {
      log.warn('Emitting the reload-during-capture notice threw', {
        ...fields,
        errorName: thrownName(thrown),
      });
      return false;
    }
  }

  /* ---- store restoration ---- */

  /**
   * Writes a previous durable row back — one a bind displaced or replaced, the
   * pre-navigation row of a refused navigation, or the row a refused drop
   * removed — with its own URL and bound-at stamp, provided its session is
   * still open.
   *
   * A refused bind's compensation, a refused navigation's revert and a refused
   * drop's restoration run this after awaiting a record mirror, and in that
   * window `SessionManager.end` may have committed `ended` together with the
   * removal of the session's `bindings` row. `upsertBinding` checks no status
   * and the foreign key admits an ended session, so an unconditional write
   * would bind an ended session again after `session.end` answered success.
   * The row's session is therefore read and the row written inside one
   * `sessions.transaction`: an ended or vanished session gets nothing written,
   * and no end can commit between the read and the write. Failures are logged
   * by ids and codes, never propagated.
   *
   * @param row The row to write back, exactly as it was read.
   * @returns Whether the row stands again, was left out because its session
   * is closed, or could not be written.
   */
  function restoreRow(row: StoredTabBinding): RowRestoration {
    const fields = sessionFields(row.sessionId, { tabId: row.tab.tabId });
    const outcome = sessions.transaction((): Result<RowRestoration, DebuggenError> => {
      const loaded = sessions.get(row.sessionId);
      if (isErr(loaded)) {
        return loaded;
      }
      if (isClosedSession(loaded.value)) {
        return ok('session-closed');
      }
      const restored = sessions.upsertBinding({
        tabId: row.tab.tabId,
        sessionId: row.sessionId,
        url: row.tab.url,
        boundAt: row.boundAt,
        boundBy: row.boundBy,
      });
      return isErr(restored) ? restored : ok('restored');
    });
    if (isErr(outcome)) {
      log.error('A previous binding row could not be restored', {
        ...fields,
        ...errorFields(outcome.error),
      });
      return 'failed';
    }
    if (outcome.value === 'session-closed') {
      log.info(
        'A previous binding row was not restored: its session has ended or no longer exists',
        fields,
      );
    }
    return outcome.value;
  }

  /**
   * Undoes one `upsertBinding`: removes the new row, then writes back every
   * row it replaced — the rows it reported displaced and, when the bind
   * re-bound the same tab to the same session, the tab's own previous row,
   * which the upsert replaced without reporting it. Each goes through
   * {@link restoreRow}, so a row whose session has ended meanwhile stays gone.
   *
   * The new row is removed as its holder's view of the tab — its own row and
   * the tab's row that recorded no holder — never another browser's row of
   * the same tab id. That view held exactly the new row: the upsert consumed
   * whatever the view showed before it, and a holder's own row and an
   * unrecorded row of one tab never stand together, because the holder's
   * first bind of the tab consumes the unrecorded one.
   *
   * @param upsert What the bind's `upsertBinding` answered.
   * @param priorRow The holder's view of the tab's row before the bind, from {@link PriorBinding}.
   */
  function rollbackUpsert(upsert: BindingUpsert, priorRow: StoredTabBinding | undefined): void {
    const removed = sessions.deleteBinding(upsert.binding.tab.tabId, upsert.binding.boundBy);
    if (isErr(removed)) {
      log.error(
        'A binding row could not be rolled back',
        sessionFields(upsert.binding.sessionId, {
          tabId: upsert.binding.tab.tabId,
          ...errorFields(removed.error),
        }),
      );
      return;
    }
    const reported = [upsert.displacedTab, upsert.displacedSession].filter(
      (row): row is StoredTabBinding => row !== undefined,
    );
    for (const row of reported) {
      restoreRow(row);
    }
    if (
      priorRow !== undefined &&
      !reported.some((row) => sameBinding(identityOfRow(row), identityOfRow(priorRow)))
    ) {
      restoreRow(priorRow);
    }
  }

  /* ---- bind: record mirror and compensation ---- */

  /**
   * Mirrors a bind onto the session records through the manager: first the
   * record of every other session that lost its tab is cleared, then the bound
   * session's record is given the tab (skipped when it already shows it).
   * Each write that succeeds is appended to `written` with the bound tab the
   * record showed before it, so a later failure can put every record back.
   *
   * @returns `ok` once every write succeeded; the first refusal otherwise,
   * with `written` holding exactly the writes that were made.
   */
  async function mirrorBind(
    record: SessionRecord,
    released: readonly DisplacedBinding[],
    bound: BoundTab,
    written: MirrorWrite[],
  ): Promise<Result<void, DebuggenError>> {
    const orphaned = new Set(
      released.map((previous) => previous.sessionId).filter((id) => id !== record.id),
    );
    for (const orphan of orphaned) {
      const loaded = sessions.get(orphan);
      if (isErr(loaded)) {
        return loaded;
      }
      const previous = loaded.value?.boundTab;
      if (previous === undefined) {
        // No record, or one that shows no tab: nothing to clear or to restore.
        continue;
      }
      const cleared = await mirrorBoundTab(orphan, undefined);
      if (isErr(cleared)) {
        return cleared;
      }
      written.push({ sessionId: orphan, previous });
    }
    if (!recordShowsTab(record, bound.tabId, bound.url)) {
      const shown = await mirrorBoundTab(record.id, bound);
      if (isErr(shown)) {
        return shown;
      }
      written.push({ sessionId: record.id, previous: record.boundTab });
    }
    return ok(undefined);
  }

  /**
   * The registered DevTools connection holding the credential that made a
   * binding: the binding's recorded recipient when it still qualifies,
   * otherwise any connection of that credential; `undefined` when none is
   * registered. Only a connection's own principal can re-make its binding.
   */
  function holderOf(binding: TabBindingView): RegisteredClient | undefined {
    const holds = (client: RegisteredClient | undefined): client is RegisteredClient =>
      client !== undefined &&
      client.kind === BINDING_ROLE &&
      client.principal.tokenHash === binding.boundBy;
    const recipient =
      binding.recipientId === undefined ? undefined : clients.get(binding.recipientId);
    return holds(recipient) ? recipient : clients.list({ kind: BINDING_ROLE }).find(holds);
  }

  /**
   * Re-establishes a live binding a refused bind displaced or changed in
   * place, under the credential that made it and with its original URL and
   * `boundAt`. When no registered connection holds that credential any more,
   * the binding stays with its durable row alone — exactly the state a restart
   * leaves, which the reconnecting service worker's re-bind repairs.
   */
  function restoreLiveBinding(binding: TabBindingView): void {
    const fields = sessionFields(binding.sessionId, { tabId: binding.tabId });
    const holder = holderOf(binding);
    if (holder === undefined) {
      log.warn(
        'A previous live binding was not re-established: no connection holds its credential; its binding row is restored',
        fields,
      );
      return;
    }
    const rebound = clients.bindTab({
      tabId: binding.tabId,
      sessionId: binding.sessionId,
      url: binding.url,
      principal: holder.principal,
      clientId: holder.id,
      boundAt: binding.boundAt,
    });
    if (isErr(rebound)) {
      log.error('A previous live binding could not be re-established', {
        ...fields,
        ...errorFields(rebound.error),
      });
    }
  }

  /**
   * Undoes a bind that failed after its durable row was written, in the
   * reverse of the order it was made: each mirrored record gets its previous
   * bound tab back; the new live binding is released and every live binding it
   * displaced is re-established, as is the tab's previous binding when the
   * registry changed it in place (the same credential re-binding the same tab
   * and session) rather than reporting it displaced; and the durable row is
   * removed with every row it replaced written back, the tab's own previous
   * row of the same session included. Nothing was announced, so nothing is
   * retracted. Every compensation failure is logged by ids and codes and
   * none is propagated — the caller answers with the original refusal.
   */
  async function compensateBind(undo: BindUndo): Promise<void> {
    for (const write of [...undo.mirrored].reverse()) {
      const fields = sessionFields(write.sessionId, { bound: write.previous !== undefined });
      try {
        const restored = await manager.setBoundTab(write.sessionId, write.previous);
        if (isErr(restored)) {
          log.error('A session record could not be restored after a refused bind', {
            ...fields,
            ...errorFields(restored.error),
          });
        }
      } catch (thrown) {
        log.error('Restoring a session record after a refused bind threw', {
          ...fields,
          errorName: thrownName(thrown),
        });
      }
    }
    if (undo.live !== undefined) {
      const undone = clients.unbindTab(undo.tabId, { principal: undo.principal });
      if (isErr(undone)) {
        log.error(
          'The live binding of a refused bind could not be released',
          sessionFields(undo.live.binding.sessionId, {
            tabId: undo.tabId,
            ...errorFields(undone.error),
          }),
        );
      }
      for (const change of undo.live.displaced) {
        restoreLiveBinding(change.binding);
      }
      const priorLive = undo.prior.live;
      if (
        priorLive !== undefined &&
        !undo.live.displaced.some((change) => sameBinding(change.binding, priorLive))
      ) {
        restoreLiveBinding(priorLive);
      }
    }
    rollbackUpsert(undo.stored, undo.prior.row);
  }

  /* ---- session resolution ---- */

  /**
   * The named session, provided its dev server serves the tab's origin and it
   * has not ended. Whether it has ended is the state machine's terminal-status
   * rule applied to the record just read — no history is reopened to ask.
   */
  function resolveNamed(
    sessionId: SessionId,
    origin: string,
  ): Result<ResolvedSession, DebuggenError> {
    const loaded = sessions.get(sessionId);
    if (isErr(loaded)) {
      return loaded;
    }
    const record = loaded.value;
    if (record === undefined) {
      return refusal(
        'SESSION_NOT_FOUND',
        NAMED_SESSION_MISSING_MESSAGE,
        NAMED_SESSION_MISSING_HINT,
      );
    }
    if (serializedOriginOf(record.devServerUrl) !== origin) {
      log.info('A bind naming a session was refused: origin mismatch', sessionFields(record.id));
      return refusal('TAB_NOT_BOUND', ORIGIN_MISMATCH_MESSAGE, ORIGIN_MISMATCH_HINT, {
        reason: 'origin-mismatch',
      });
    }
    if (isTerminalSessionStatus(record.status)) {
      return refusal('SESSION_INVALID_STATE', SESSION_ENDED_MESSAGE, SESSION_ENDED_HINT, {
        reason: 'session-ended',
      });
    }
    return ok({ record, matchedBy: 'session-id' });
  }

  /**
   * The most recently updated session in one of `statuses` whose dev server
   * serves `origin`, or `undefined` when none does.
   *
   * The store answers from its projections alone —
   * {@link SessionsRepo.findLatestByDevServer} reads only the `id`,
   * `dev_server_url` and `updated_at` columns of the sessions in `statuses`
   * `idx_sessions_status` narrows the read to, newest first, and stops at the
   * first whose URL
   * canonicalises to `origin` through {@link serializedOriginOf} — so the
   * record of the winner is the only one read and parsed, and an ended
   * session's history is never touched. The winner's record is re-checked
   * against both rules — its status still in `statuses`, its dev server still
   * serving `origin` — because the session may have moved since its
   * projections were read: one that failed in between is not taken by the live
   * pass, and the failed pass meets it afresh. A winner whose record cannot be
   * read or no longer matches is skipped, and the lookup continues past it,
   * rather than allowed to hide every older match.
   *
   * @param statuses One of {@link ORIGIN_LOOKUP_PASSES}; each is drawn from
   * {@link ACTIVE_SESSION_STATUSES}, so no terminal status is ever searched.
   */
  function latestServingOrigin(
    origin: string,
    statuses: readonly SessionStatus[],
  ): Result<SessionRecord | undefined, DebuggenError> {
    const skipped = new Set<SessionId>();
    for (;;) {
      const found = sessions.findLatestByDevServer({
        statuses,
        matches: (devServerUrl, candidate) =>
          !skipped.has(candidate) && serializedOriginOf(devServerUrl) === origin,
      });
      if (isErr(found)) {
        return found;
      }
      const candidate = found.value;
      if (candidate === undefined) {
        return ok(undefined);
      }
      const loaded = sessions.get(candidate);
      const record = loaded.ok ? loaded.value : undefined;
      if (
        record !== undefined &&
        statuses.includes(record.status) &&
        serializedOriginOf(record.devServerUrl) === origin
      ) {
        return ok(record);
      }
      // Unreadable, gone, or no longer what its projections said: excluded, so
      // the next lookup answers with the next-newest match.
      log.warn(
        'A session matching a tab origin could not be read or no longer matches; skipped',
        sessionFields(
          candidate,
          loaded.ok ? { present: record !== undefined } : errorFields(loaded.error),
        ),
      );
      skipped.add(candidate);
    }
  }

  /**
   * The newest open session whose dev server serves `origin`, or `undefined`
   * when none does: the most recently updated **live** session — any status
   * but `ended` and `failed` — and only when no live session serves it, the
   * most recently updated failed one, so the panel can still show that
   * failure and its retry. A failed second session on the same project
   * therefore never takes a tab from the ready or capturing session beside
   * it, however recently it was updated. Each pass is
   * {@link latestServingOrigin}, in the order of {@link ORIGIN_LOOKUP_PASSES};
   * a store refusal in either pass is returned as it is.
   *
   * It is the lookup {@link resolveByOrigin} refuses a bind on, and the one
   * that offers a session to a tab starting to await `origin`.
   */
  function findOpenSessionByOrigin(
    origin: string,
  ): Result<SessionRecord | undefined, DebuggenError> {
    for (const statuses of ORIGIN_LOOKUP_PASSES) {
      const found = latestServingOrigin(origin, statuses);
      if (isErr(found)) {
        return found;
      }
      const record = found.value;
      if (record !== undefined) {
        if (statuses === FAILED_SESSION_STATUSES) {
          log.info(
            'A lookup by origin found no live session; it matched a failed session',
            sessionFields(record.id),
          );
        }
        return ok(record);
      }
    }
    return ok(undefined);
  }

  /**
   * The session a bind without a `sessionId` goes to: the one
   * {@link findOpenSessionByOrigin} answers, or a `SESSION_NOT_FOUND` refusal
   * when no open session serves `origin`.
   */
  function resolveByOrigin(origin: string): Result<ResolvedSession, DebuggenError> {
    const found = findOpenSessionByOrigin(origin);
    if (isErr(found)) {
      return found;
    }
    if (found.value !== undefined) {
      return ok({ record: found.value, matchedBy: 'origin' });
    }
    log.info('A bind matched no active session by origin');
    return refusal('SESSION_NOT_FOUND', NO_SESSION_FOR_ORIGIN_MESSAGE, NO_SESSION_FOR_ORIGIN_HINT, {
      reason: 'no-session-for-origin',
    });
  }

  /* ---- tabs awaiting a session ---- */

  /**
   * Records that `tabId`, announced on `connection`, awaits a session for
   * `origin` (or forgets it when the document has no HTTP(S) origin). A
   * refusal is logged by code and never changes the frame's own answer: the
   * worker's next announcement records the tab again.
   *
   * @param offerOpen Whether to offer, at once, the newest open session that
   *   already serves `origin` and holds no tab — `false` only where a bind has
   *   just found none.
   */
  function awaitSessionFor(
    tabId: number,
    origin: string | undefined,
    connection: BindingConnection,
    offerOpen = true,
  ): void {
    if (origin === undefined) {
      clients.forgetAwaitingTab(tabId, connection.principal);
      return;
    }
    const recorded = clients.awaitSession({
      tabId,
      origin,
      principal: connection.principal,
      clientId: connection.clientId,
    });
    if (isErr(recorded)) {
      log.warn('The tab could not be recorded as awaiting a session', {
        tabId,
        ...errorFields(recorded.error),
      });
      return;
    }
    if (offerOpen) {
      offerOpenSession(tabId, origin, connection.principal);
    }
  }

  /**
   * Offers a tab that has just started awaiting `origin` the newest open
   * session already serving it, when that session holds no tab: it was
   * created while the tab was still bound elsewhere (typically to the session
   * whose end the worker is unbinding), so its `session.created` could not
   * reach the tab. A session another tab holds is never offered — the bind it
   * would prompt replaces that tab's binding.
   *
   * @param principal The credential that announced the tab: the awaiting
   *   record is its own, never another browser's tab with the same id.
   */
  function offerOpenSession(tabId: number, origin: string, principal: Principal): void {
    const found = findOpenSessionByOrigin(origin);
    if (isErr(found)) {
      log.warn('No open session could be looked up for a tab awaiting its origin', {
        tabId,
        ...errorFields(found.error),
      });
      return;
    }
    const record = found.value;
    if (record === undefined || clients.bindingForSession(record.id) !== undefined) {
      return;
    }
    const message = createEnvelope(SESSION_CREATED_TYPE, { session: record }, { ts: clock() });
    const offered = clients.offerSessionToAwaitingTab(tabId, principal, message);
    if (isErr(offered)) {
      log.debug(
        'An open session could not be offered to a tab awaiting its origin',
        sessionFields(record.id, { tabId, ...errorFields(offered.error) }),
      );
      return;
    }
    log.info(
      'Offered an open session to a tab awaiting its origin',
      sessionFields(record.id, { tabId }),
    );
  }

  /**
   * After an unbind dropped `binding`: a binding whose session has ended (or
   * vanished) was ended by the Chrome worker's cleanup after `session.end`,
   * while the tab's DevTools stays open, so the tab awaits the next session for
   * its document's origin; any other unbind is its DevTools or tab closing.
   */
  function settleAwaitingAfterUnbind(binding: TabBindingView, connection: BindingConnection): void {
    const loaded = sessions.get(binding.sessionId);
    const ended = loaded.ok && isClosedSession(loaded.value);
    if (ended) {
      awaitSessionFor(binding.tabId, serializedOriginOf(binding.url), connection);
    } else {
      clients.forgetAwaitingTab(binding.tabId, connection.principal);
    }
  }

  /**
   * Tells {@link BindingRoutesDeps.endedSessions} that a bind naming
   * `sessionId` was refused because that session is over — ended or failed
   * (`SESSION_INVALID_STATE`), or gone (`SESSION_NOT_FOUND`) — so the page
   * disarm it still owes is settled: the DevTools worker answers exactly this
   * refusal by returning the tab's page agent to dormant (see
   * {@link EndedSessionAgentPort}). An origin bind (no `sessionId`) and every
   * other refusal code are left alone. Best effort: a port that refuses or
   * throws is logged, and the bind's refusal is returned unchanged.
   */
  function releaseEndedSessionAgent(
    sessionId: SessionId | undefined,
    refused: DebuggenError,
  ): void {
    const port = deps.endedSessions;
    if (
      port === undefined ||
      sessionId === undefined ||
      (refused.code !== 'SESSION_INVALID_STATE' && refused.code !== 'SESSION_NOT_FOUND')
    ) {
      return;
    }
    try {
      const released = port.pageAgentReleased(sessionId);
      if (isErr(released)) {
        log.warn(
          'The owed page disarm of a refused ended session could not be settled',
          sessionFields(sessionId, errorFields(released.error)),
        );
        return;
      }
      log.info(
        'A bind naming an ended session was refused; its page agent is released',
        sessionFields(sessionId, { code: refused.code, owedDisarm: released.value }),
      );
    } catch (thrown) {
      log.error(
        'Settling the owed page disarm of a refused ended session threw',
        sessionFields(sessionId, { errorName: thrownName(thrown) }),
      );
    }
  }

  /* ---- session.bind ---- */

  async function bind(
    payload: SessionBindPayload,
    connection: BindingConnection,
  ): Promise<Result<SessionBindOutcome, DebuggenError>> {
    const { principal } = connection;
    const allowed = requireRole(principal, BINDING_ROLE);
    if (isErr(allowed)) {
      return allowed;
    }
    const parsed = parseSessionBindPayload(payload);
    if (isErr(parsed)) {
      return parsed;
    }
    const request = parsed.value;
    const origin = serializedOriginOf(request.url);
    if (origin === undefined || origin !== request.origin) {
      return refusal('PROTOCOL_INVALID_MESSAGE', ORIGIN_DISAGREES_MESSAGE, ORIGIN_DISAGREES_HINT);
    }

    const resolved =
      request.sessionId === undefined
        ? resolveByOrigin(origin)
        : resolveNamed(request.sessionId, origin);
    if (isErr(resolved)) {
      if (request.sessionId === undefined && resolved.error.code === 'SESSION_NOT_FOUND') {
        // The panel was opened before the question: the next session created
        // for this origin reaches the tab (see the module overview).
        awaitSessionFor(request.tabId, origin, connection, false);
      }
      releaseEndedSessionAgent(request.sessionId, resolved.error);
      return resolved;
    }
    const { record, matchedBy } = resolved.value;
    const sessionId = record.id;
    const { tabId } = request;
    // The raw URL decided the origin above and goes no further: every store,
    // the registry and every announcement hold the redacted form.
    const url = redactBoundUrl(request.url, origin);
    const boundAt = clock();

    // 0. What the tab is bound to now, in both stores, in the binder's view: a
    //    tab id is unique only within one browser, so another credential's
    //    binding of the same id is another browser's tab and is no prior of
    //    this one. A re-bind of the same tab to the same session replaces that
    //    binding unreported (see PriorBinding), so a refusal below needs this
    //    snapshot to put it back. A row that cannot be read would refuse the
    //    upsert anyway.
    const holder = principal.tokenHash;
    const priorRow = sessions.getBindingByTab(tabId, holder);
    if (isErr(priorRow)) {
      log.error(
        "The tab's current binding row could not be read; the bind was refused",
        sessionFields(sessionId, { tabId, ...errorFields(priorRow.error) }),
      );
      return priorRow;
    }
    const prior: PriorBinding = {
      row: priorRow.value,
      live: clients.bindingForTab(tabId, principal),
    };

    // 1. The durable row, recorded against the binding credential: what a
    //    restart rebuilds from.
    const stored = sessions.upsertBinding({ tabId, sessionId, url, boundAt, boundBy: holder });
    if (isErr(stored)) {
      log.error(
        'The binding could not be persisted',
        sessionFields(sessionId, { tabId, ...errorFields(stored.error) }),
      );
      return stored;
    }

    // 2. The live view: what a push finds the socket through. A refusal here
    //    left the registry untouched, so only the row is rolled back.
    const live = clients.bindTab({
      tabId,
      sessionId,
      url,
      principal,
      clientId: connection.clientId,
      boundAt,
    });
    if (isErr(live)) {
      rollbackUpsert(stored.value, prior.row);
      log.warn(
        'The live binding was refused; the persisted row was rolled back',
        sessionFields(sessionId, { tabId, ...errorFields(live.error) }),
      );
      return live;
    }

    // 3. Mirror the change onto the session records: clear each other session
    //    that lost its tab, then show the tab on the bound one. Should any
    //    write refuse (or throw), every write of steps 1–3 is compensated in
    //    reverse and the refusal returned; nothing has been announced yet.
    const released = mergeDisplaced(live.value.displaced, stored.value, {
      sessionId,
      tabId,
      boundBy: holder,
    });
    const mirrored: MirrorWrite[] = [];
    const undo: BindUndo = {
      stored: stored.value,
      live: live.value,
      mirrored,
      prior,
      tabId,
      principal,
    };
    let written: Result<void, DebuggenError>;
    try {
      written = await mirrorBind(record, released, { tabId, url }, mirrored);
    } catch (thrown) {
      await compensateBind(undo);
      throw thrown;
    }
    if (isErr(written)) {
      await compensateBind(undo);
      log.warn(
        'A session record refused the binding; every write of the bind was undone',
        sessionFields(sessionId, {
          tabId,
          displaced: released.length,
          mirrored: mirrored.length,
          ...errorFields(written.error),
        }),
      );
      // A named session `session.end` closed while the mirror was awaited is
      // refused as ended too, and answered by the worker the same way — but a
      // refusal about a session the bind displaced says nothing of this one.
      if (written.error.details?.['sessionId'] === sessionId) {
        releaseEndedSessionAgent(request.sessionId, written.error);
      }
      return written;
    }

    // 4. Every write stands: tell each displaced binding it was replaced …
    const displaced: BindingAnnouncement[] = [];
    for (const previous of released) {
      const replaced = announce({
        sessionId: previous.sessionId,
        tabId: previous.tabId,
        url: previous.url,
        reason: REASON_REPLACED,
      });
      if (replaced.ok) {
        displaced.push(replaced.value);
      }
    }

    // 5. … then announce the establishment to the panel and the session's editors.
    const announced = announce({
      sessionId,
      tabId,
      url: live.value.binding.url,
      reason: live.value.reason,
    });
    if (isErr(announced)) {
      return announced;
    }

    // 6. Replay stored state to the panel alone, so it re-renders from the store.
    const replay = await reopener.reopen(sessionId, { kinds: REPLAY_KINDS });
    if (isErr(replay)) {
      log.warn(
        'The reopen replay to the bound panel failed',
        sessionFields(sessionId, errorFields(replay.error)),
      );
    }
    const replayed = replay.ok && replay.value.replayed.length > 0;
    // … and the latest signal report, which the stored replay does not carry,
    // so the panel's signal list shows what the session's instrumentation
    // enabled. Named before the re-arm so the driver knows the tab it arms.
    const signalsReplayed = replaySignalReport(sessionId, {
      tabId,
      url: live.value.binding.url,
    });

    // 7. An open capture continues in the newly bound tab.
    const rearm = rearmAgent(record);

    log.info(
      'Tab bound to session',
      sessionFields(sessionId, {
        tabId,
        matchedBy,
        displaced: displaced.length,
        rearm: rearm.status,
        signalsReplayed,
      }),
    );
    return ok({
      sessionId,
      tabId,
      url: live.value.binding.url,
      matchedBy,
      announced: announced.value,
      displaced,
      replayed,
      rearm,
    });
  }

  /* ---- ending a binding ---- */

  /**
   * Puts back a binding {@link dropBinding} removed from both routing stores
   * once the session record refused to clear its tab (or the write threw) —
   * unless the session has ended or vanished meanwhile.
   *
   * The drop awaited the record mirror, and `SessionManager.end` may have
   * committed `ended` in that window, removing the session's `bindings` row in
   * the same transaction (it found none: the drop had already deleted it). The
   * binding queue and the manager's end do not serialize with each other, so
   * restoring either store then would leave an ended session durably and
   * live-bound after `session.end` answered success, although an ended
   * session is no recipient of tab-bound messages. The session is therefore
   * read first: ended or vanished, neither the live binding nor the row is
   * restored and `session-closed` is answered — the end's outcome stands.
   * Otherwise the live binding is re-established — under the credential that
   * made it, with its URL and bound-at stamp — and then the durable row
   * exactly as it was read before the drop (none is written when the tab had
   * none), through {@link restoreRow}, whose transaction checks its session
   * again. The status read and both restorations run in one synchronous turn:
   * the service is single-threaded and one process owns the store, so no end
   * can commit between the check and the writes.
   *
   * When the status read itself fails, the live binding is still restored —
   * `session.end` removes only the durable row, never a live binding, so this
   * keeps the drop retryable — and {@link restoreRow}'s transaction decides
   * the row. The record was never changed and nothing was announced, so
   * nothing else is undone. Failures are logged by ids and codes, never
   * propagated: the caller returns the record's refusal, or — for
   * `session-closed` — answers the drop as done.
   *
   * @param released The live binding the drop released.
   * @param priorRow The tab's durable row before the drop, if it had one.
   * @returns `session-closed` when the session was confirmed ended or vanished
   * before anything was written; `restored` otherwise.
   */
  function restoreDroppedBinding(
    released: TabBindingView,
    priorRow: StoredTabBinding | undefined,
  ): DropRestoration {
    const fields = sessionFields(released.sessionId, { tabId: released.tabId });
    const loaded = sessions.get(released.sessionId);
    if (isErr(loaded)) {
      log.warn(
        "The session could not be read before restoring its dropped binding; the live binding is restored and the row's own transaction decides",
        { ...fields, ...errorFields(loaded.error) },
      );
    } else if (isClosedSession(loaded.value)) {
      log.info(
        'The session ended while its binding was being dropped; neither the live binding nor its row was restored',
        fields,
      );
      return 'session-closed';
    }
    restoreLiveBinding(released);
    if (priorRow !== undefined) {
      restoreRow(priorRow);
    }
    return 'restored';
  }

  /**
   * Drops a live binding: the durable row first, the live view second (the row
   * is written back should the registry refuse), then — when the session still
   * has a record — the record mirror, and the announcement only once every
   * write stands. Should the record refuse to clear its bound tab (or the write
   * throw), both routing stores are put back exactly as they were by
   * {@link restoreDroppedBinding}, nothing is announced, and the refusal is
   * returned (a throw is rethrown after the restoration), so the caller answers
   * with protocol's `error` and a retried `session.unbind`, or the tab's next
   * navigation, finds the binding and drops it again. A record that has
   * vanished meanwhile (`SESSION_NOT_FOUND`) has no tab to clear and does not
   * hold the drop back. Never touches the session's status, capture or
   * instrumentation.
   *
   * A `session.end` that committed while the mirror was awaited has already
   * done what the drop set out to do: its transaction removed the session's
   * row and stored the record without a bound tab. The restoration then puts
   * nothing back, and a refused mirror is answered as `ok(undefined)` — the
   * handlers' `ignored` — with nothing announced: the binding is gone
   * everywhere and the ended record shows no tab, so there is nothing to retry
   * and nothing to tell. A throw is still rethrown after that restoration.
   *
   * @param binding The live binding, already authorized for `principal`.
   * @param reason Why it ends.
   * @param announcedUrl The URL the announcement carries: the new document for
   * an origin change, the last known one otherwise.
   * @param clearRecord Whether the session still has a record to clear.
   * @returns The drop's announcement; `undefined` when there was nothing left
   * to drop or announce (the tab was no longer live-bound, or its session ended
   * during the drop); the refusal otherwise.
   */
  async function dropBinding(
    binding: TabBindingView,
    principal: Principal,
    reason: DropReason,
    announcedUrl: string,
    clearRecord: boolean,
  ): Promise<Result<BindingAnnouncement | undefined, DebuggenError>> {
    const { tabId, sessionId, boundBy } = binding;
    // The tab's row as it stands in its holder's view, so a refused record
    // mirror below can have it back exactly: a redundant re-bind renews the
    // row's bound-at stamp but not the live view's, and the row may already be
    // gone. A row that cannot be read would refuse the delete anyway. Only the
    // holder's view is read and removed: another browser's binding of the same
    // tab id is its own row.
    const priorRow = sessions.getBindingByTab(tabId, boundBy);
    if (isErr(priorRow)) {
      log.error(
        "The tab's binding row could not be read; the binding was kept",
        sessionFields(sessionId, { tabId, ...errorFields(priorRow.error) }),
      );
      return priorRow;
    }
    const removed = sessions.deleteBinding(tabId, boundBy);
    if (isErr(removed)) {
      log.error(
        'The binding row could not be removed',
        sessionFields(sessionId, { tabId, ...errorFields(removed.error) }),
      );
      return removed;
    }
    const change = clients.unbindTab(tabId, { reason, principal });
    if (isErr(change)) {
      // Written back through the status-aware restoration, so a session that
      // ended before this frame arrived (its live binding outlives the end)
      // is not given a durable row again.
      const restored = restoreRow({
        sessionId,
        tab: { tabId, url: binding.url },
        boundAt: binding.boundAt,
        boundBy,
      });
      log.warn(
        'The live binding refused the unbind; the binding row was written back unless its session has closed',
        sessionFields(sessionId, { tabId, restored, ...errorFields(change.error) }),
      );
      return change;
    }
    // The live binding is gone, and with it any navigation of the tab that
    // awaited a new document: a binding a refused mirror restores below
    // starts with none awaiting.
    awaitingDocument.delete(heldTabKey(boundBy, tabId));
    if (change.value === undefined) {
      return ok(undefined);
    }
    if (clearRecord) {
      const released = change.value.binding;
      let mirrored: Result<void, DebuggenError>;
      try {
        mirrored = await mirrorBoundTab(sessionId, undefined);
      } catch (thrown) {
        restoreDroppedBinding(released, priorRow.value);
        throw thrown;
      }
      if (isErr(mirrored) && mirrored.error.code !== 'SESSION_NOT_FOUND') {
        if (restoreDroppedBinding(released, priorRow.value) === 'session-closed') {
          // `session.end` committed during the mirror and already removed the
          // row and the record's tab: the drop stands, unannounced.
          return ok(undefined);
        }
        log.warn(
          'The session record refused to clear its bound tab; the binding was restored and nothing was announced',
          sessionFields(sessionId, {
            tabId,
            reason: change.value.reason,
            ...errorFields(mirrored.error),
          }),
        );
        return mirrored;
      }
    }
    const announced = announce({
      sessionId,
      tabId,
      url: announcedUrl,
      reason: change.value.reason,
    });
    if (isErr(announced)) {
      return announced;
    }
    log.info(
      'Tab binding dropped',
      sessionFields(sessionId, { tabId, reason: change.value.reason }),
    );
    return ok(announced.value);
  }

  /**
   * The principal's own live binding of a tab, authorized for it:
   * `undefined` when its credential holds no binding of the tab. A tab id is
   * unique only within one browser, so another credential's binding of the
   * same id — another browser's tab — is never answered, and never changed by
   * this principal's frames.
   *
   * A binding frame is about the one tab its payload names, so that tab is the
   * acting tab `requireBoundSession` checks the binding against — a check the
   * holder-keyed lookup already satisfies, kept so authorization never rests
   * on how the registry indexes. Two rules upstream keep that tab the sender's
   * own: protocol refuses a frame whose envelope names a different tab, and
   * `../ws.ts` refuses a payload tab other than the one a single-tab
   * connection announced in its hello before this handler runs.
   */
  function authorizedBinding(
    tabId: number,
    principal: Principal,
  ): Result<TabBindingView | undefined, DebuggenError> {
    const binding = clients.bindingForTab(tabId, principal);
    if (binding === undefined) {
      return ok(undefined);
    }
    const access = requireBoundSession(principal, binding.sessionId, binding, tabId);
    return isErr(access) ? access : ok(binding);
  }

  /**
   * The refusal of a navigation of a tab id that only other credentials hold
   * a binding of: the access boundary's own `session-not-bound` refusal
   * (`../auth.ts`), exactly as it answered such a frame before bindings were
   * keyed by holder.
   */
  function foreignTabRefusal(): Result<never, DebuggenError> {
    const descriptor = AUTH_FAILURE_REASONS['session-not-bound'];
    return refusal(descriptor.code, descriptor.message, descriptor.hint, {
      reason: 'session-not-bound',
    });
  }

  /* ---- tab.navigated ---- */

  /**
   * Keeps a binding across a same-origin navigation: records the new URL in
   * the durable row, the live view and the session record, announces it and
   * re-arms the agent the new document started dormant.
   *
   * The announcement and the re-arm follow only once all three writes stand.
   * Should the live view or the session record refuse the new URL (or the
   * record write throw), the writes already made are reverted — the live view
   * and the row get the previous URL back — and the refusal is returned, so no
   * surface is told of a URL the record does not hold.
   *
   * @param url The new document's URL, already redacted by {@link redactBoundUrl}.
   */
  async function keepBinding(
    binding: TabBindingView,
    record: SessionRecord,
    url: string,
    principal: Principal,
  ): Promise<Result<TabNavigatedOutcome, DebuggenError>> {
    const { tabId, sessionId, boundBy } = binding;
    // The binding's own row, under the holder that made it; `previousRow` is
    // what a refusal below writes back.
    const previousRow: StoredTabBinding = {
      sessionId,
      tab: { tabId, url: binding.url },
      boundAt: binding.boundAt,
      boundBy,
    };
    const stored = sessions.upsertBinding({
      tabId,
      sessionId,
      url,
      boundAt: binding.boundAt,
      boundBy,
    });
    if (isErr(stored)) {
      log.error(
        'The navigated URL could not be persisted',
        sessionFields(sessionId, { tabId, ...errorFields(stored.error) }),
      );
      return stored;
    }
    if (stored.value.displacedTab !== undefined || stored.value.displacedSession !== undefined) {
      // A row that disagreed with the live view (written before a restart) was
      // replaced; the live view is authoritative for routing.
      log.debug(
        'A stale binding row was replaced by the live binding',
        sessionFields(sessionId, { tabId }),
      );
    }
    const updated = clients.updateTabUrl({ tabId, url, principal });
    if (isErr(updated)) {
      restoreRow(previousRow);
      log.warn(
        'The live binding refused the navigation; the binding row was restored',
        sessionFields(sessionId, { tabId, ...errorFields(updated.error) }),
      );
      return updated;
    }
    if (!recordShowsTab(record, tabId, url)) {
      /**
       * Puts the live view, then the row, back on the URL the record still
       * holds; the row through {@link restoreRow}, so only while the session
       * is open.
       */
      const revertNavigation = (): void => {
        const reverted = clients.updateTabUrl({ tabId, url: binding.url, principal });
        if (isErr(reverted)) {
          log.error(
            'The live binding could not be returned to its previous URL',
            sessionFields(sessionId, { tabId, ...errorFields(reverted.error) }),
          );
        }
        restoreRow(previousRow);
      };
      let mirrored: Result<void, DebuggenError>;
      try {
        mirrored = await mirrorBoundTab(sessionId, { tabId, url });
      } catch (thrown) {
        revertNavigation();
        throw thrown;
      }
      if (isErr(mirrored)) {
        revertNavigation();
        log.warn(
          'The session record refused the navigated URL; the binding keeps its previous URL and nothing was announced',
          sessionFields(sessionId, { tabId, ...errorFields(mirrored.error) }),
        );
        return mirrored;
      }
    }
    // Announced as the binding now stands, not as a reload: the navigation may
    // be a same-document URL change, and only a new page-agent document —
    // reported through `documentReported` — proves a reload.
    const announced = announce({
      sessionId,
      tabId,
      url: updated.value.binding.url,
      reason: REASON_BOUND,
    });
    if (isErr(announced)) {
      return announced;
    }
    const rearm = rearmAgent(record);
    // Keyed by the binding's holder and tab: the next report of *this*
    // browser's tab proves the reload, never one of another browser's tab
    // with the same id.
    const documentKey = heldTabKey(boundBy, tabId);
    rememberBounded(awaitingDocument, documentKey, {
      sessionId,
      rearm,
      previousDocumentId: reportedDocuments.get(documentKey),
    });
    log.info(
      'Bound tab navigated within its origin',
      sessionFields(sessionId, { tabId, rearm: rearm.status }),
    );
    return ok({ kind: 'kept', announced: announced.value, rearm });
  }

  /**
   * Tells the {@link NavigationRecorder} that `tabId` committed a navigation.
   *
   * Called once the frame is accepted and before either store is touched,
   * whatever the stores then make of it: the tab left its document even when
   * the binding cannot follow. A recorder that throws is logged by the
   * thrown value's name alone — never its message, never a URL — and the
   * navigation proceeds; readiness then merely lacks this one sign.
   */
  function recordCommittedNavigation(tabId: number): void {
    try {
      navigations.recordNavigation(tabId);
    } catch (thrown) {
      log.warn('The navigation could not be recorded for readiness', {
        tabId,
        errorName: thrownName(thrown),
      });
    }
  }

  async function navigated(
    payload: TabNavigatedPayload,
    connection: BindingConnection,
  ): Promise<Result<TabNavigatedOutcome, DebuggenError>> {
    const { principal } = connection;
    const allowed = requireRole(principal, BINDING_ROLE);
    if (isErr(allowed)) {
      return allowed;
    }
    const parsed = parseTabNavigatedPayload(payload);
    if (isErr(parsed)) {
      return parsed;
    }
    const { tabId, url } = parsed.value;
    const authorized = authorizedBinding(tabId, principal);
    if (isErr(authorized)) {
      return authorized;
    }
    const binding = authorized.value;
    if (binding === undefined && clients.tabHeldByAnotherCredential(tabId, principal)) {
      // The credential holds no binding of this tab id while another browser's
      // tab with the same id is bound. The navigation recorder keys readiness
      // by tab id alone, so accepting it would let this browser's navigation
      // make readiness distrust the other browser's bound tab: refused, and
      // nothing is recorded.
      log.debug('A navigation of a tab id only another credential holds was refused', { tabId });
      return foreignTabRefusal();
    }
    // Accepted: the tab is unbound or bound by this credential. A refused frame
    // — another role, a malformed payload, another credential's tab — records
    // nothing, so it cannot make readiness distrust a report it has no say in.
    recordCommittedNavigation(tabId);
    if (binding === undefined) {
      log.debug('A navigation of an unbound tab was ignored', { tabId });
      return ok({ kind: 'ignored' });
    }
    const loaded = sessions.get(binding.sessionId);
    if (isErr(loaded)) {
      return loaded;
    }
    const record = loaded.value;
    // The origin is decided on the raw URL; only its redacted form is recorded
    // or announced, whichever way the navigation goes.
    const documentUrl = redactBoundUrl(url, serializedOriginOf(url));
    if (record !== undefined && isSessionOrigin(record.devServerUrl, url)) {
      return keepBinding(binding, record, documentUrl, principal);
    }
    // Another origin — or a session that no longer exists, which no document can
    // belong to: the binding ends. The announcement carries the new document for
    // an origin change and the last known one for a vanished session.
    const dropped =
      record === undefined
        ? await dropBinding(binding, principal, REASON_UNBOUND, binding.url, false)
        : await dropBinding(binding, principal, REASON_ORIGIN_CHANGED, documentUrl, true);
    if (isErr(dropped)) {
      return dropped;
    }
    // The tab's DevTools stays open on the new document: a session serving its
    // origin — one already open and held by no tab, or one created later —
    // reaches it, as it would reach a panel opened there.
    awaitSessionFor(tabId, serializedOriginOf(url), connection);
    return ok(
      dropped.value === undefined
        ? { kind: 'ignored' }
        : { kind: 'dropped', announced: dropped.value },
    );
  }

  /* ---- session.unbind ---- */

  async function unbind(
    payload: SessionUnbindPayload,
    connection: BindingConnection,
  ): Promise<Result<SessionUnbindOutcome, DebuggenError>> {
    const { principal } = connection;
    const allowed = requireRole(principal, BINDING_ROLE);
    if (isErr(allowed)) {
      return allowed;
    }
    const parsed = parseSessionUnbindPayload(payload);
    if (isErr(parsed)) {
      return parsed;
    }
    const authorized = authorizedBinding(parsed.value.tabId, principal);
    if (isErr(authorized)) {
      return authorized;
    }
    const binding = authorized.value;
    if (binding === undefined) {
      // DevTools closed on a tab that had no session: it awaits none any more.
      clients.forgetAwaitingTab(parsed.value.tabId, principal);
      log.debug('An unbind of an unbound tab was ignored', { tabId: parsed.value.tabId });
      return ok({ kind: 'ignored' });
    }
    const dropped = await dropBinding(binding, principal, REASON_UNBOUND, binding.url, true);
    if (isErr(dropped)) {
      return dropped;
    }
    settleAwaitingAfterUnbind(binding, connection);
    return ok(
      dropped.value === undefined
        ? { kind: 'ignored' }
        : { kind: 'dropped', announced: dropped.value },
    );
  }

  return Object.freeze({
    handleSessionBind: (payload, connection) =>
      exclusive('session-bind', () => bind(payload, connection)),
    handleTabNavigated: (payload, connection) =>
      exclusive('tab-navigated', () => navigated(payload, connection)),
    handleSessionUnbind: (payload, connection) =>
      exclusive('session-unbind', () => unbind(payload, connection)),
    // On the binding queue, so a report is applied in order with the
    // navigation that preceded it on the connection.
    documentReported: (report) =>
      exclusive('document-reported', () => Promise.resolve(applyDocumentReport(report))).then(
        (applied) => {
          if (isErr(applied)) {
            log.warn('A page-agent document report could not be applied', {
              tabId: report.tabId,
              ...errorFields(applied.error),
            });
          }
        },
      ),
  } satisfies BindingRoutes & BindingDocumentObserver);
}
