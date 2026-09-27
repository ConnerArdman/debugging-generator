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
 * | `session.bind` | Only a `devtools` principal binds. The payload's `origin` must be the origin of its `url`. Without `sessionId` the tab binds to the most recently updated non-ended session whose dev-server origin equals the tab's origin; with `sessionId` it binds to that session only if its dev-server origin matches — a mismatch is a refusal, never a silent bind. |
 * | `tab.navigated` | Every accepted navigation — kept, dropped, or of a tab not yet bound — is first recorded with the injected {@link NavigationRecorder}, so readiness can tell a page-agent report a reload or a same-URL load left behind. Same origin then keeps the binding, records the new URL and re-arms the agent the new document started dormant — reporting `Page reloaded during capture` when a capture is open; a different origin drops the binding. A navigation of an unbound tab changes no binding. |
 * | `session.unbind` | Drops the binding. Idempotent: an unbound tab is a no-op. It never ends the session, cancels a capture or disarms instrumentation. |
 *
 * **Cardinality** (AAP §0.2.3): one tab binds to at most one session and one
 * session accepts one tab at a time. A second bind replaces the first and is
 * announced: once the bind's writes stand, every displaced binding is told with
 * `session.bound` carrying the displaced session, tab and URL and
 * `reason: 'replaced'`, before the new binding is announced — the order the
 * Chrome service worker's tab registry relies on (it drops a record only when
 * a drop names that record's tab *and* session). A redundant re-bind of the
 * same pair by the same credential — a service-worker reconnect re-announcing
 * its bindings — displaces nothing and announces no replacement.
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
 * released binding's connection eligible for binding announcements for a short
 * window, which is how a displaced or unbound panel still hears that it lost
 * its binding.
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
 * **The reload is reported, once.** A same-origin navigation kept while the
 * session has an open capture is also told to the developer: exactly one
 * `Page reloaded during capture` progress row of the capture stage, emitted
 * through the injected progress port (`../../sessions/progress.ts`, which
 * persists it for replay and sends it to the session's editor and panel), its
 * detail saying whether the agent resumed. A navigation without an open
 * capture, a refused navigation and a bind report nothing; the INFO log line
 * stays.
 *
 * **Explicit unbind versus a dropped socket.** A socket that closes is marked
 * offline by `../ws.ts` and `../clients.ts` and keeps its bindings, because the
 * MV3 service worker suspends after about 30 s of idleness and reconnects with
 * the same credential (AAP §0.5.5). Only `session.unbind` and a cross-origin
 * `tab.navigated` end a binding, and neither touches the session's status, its
 * capture or its instrumentation.
 *
 * **Stale store rows.** After a restart the registry is empty while the store
 * still holds rows, which carry no credential and so cannot authorize a change.
 * Such a row is left until the panel re-binds (the reconnecting service worker
 * re-announces its tabs, and `upsertBinding` replaces the row) or the session
 * ends. Navigation and unbind act only on live bindings, authorized against the
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
} from '@debuggen/protocol';
import type {
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

import type { InstrumentationService } from '../../instrumentation/service.js';
import { LOG_BINDING_KEYS, subsystemLogger } from '../../logging.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { SessionProgress } from '../../sessions/progress.js';
import type { SessionReopener } from '../../sessions/reopen.js';
import { isTerminalSessionStatus } from '../../sessions/state-machine.js';
import type {
  BindingUpsert,
  SessionsRepo,
  TabBinding as StoredTabBinding,
} from '../../store/sessions-repo.js';
import { requireBoundSession, requireRole } from '../auth.js';
import type { Principal } from '../auth.js';
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

/** The one message type this module sends. */
const SESSION_BOUND_TYPE = resolveSessionBoundType();

/** Protocol's binding-reason vocabulary, keyed by member. */
const REASONS = bindingReasonSchema.enum;

/** A binding ended because its tab navigated to another origin. */
const REASON_ORIGIN_CHANGED = REASONS['origin-changed'];

/** A binding ended without a navigation: DevTools closed, the tab closed or the session ended. */
const REASON_UNBOUND = REASONS.unbound;

/** A binding was taken over by another bind. */
const REASON_REPLACED = REASONS.replaced;

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
 */
export type AgentArmingPort = Pick<InstrumentationService, 'armCapture'>;

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
   */
  readonly clients: Pick<
    ClientRegistry,
    'bindTab' | 'updateTabUrl' | 'unbindTab' | 'bindingForTab' | 'broadcastToKinds' | 'get' | 'list'
  >;
  /**
   * The durable `bindings` rows, session records, the indexed origin lookup
   * and open captures. `getBindingByTab` reads a tab's row before a bind
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
   * `TAB_NOT_BOUND` when the tab is bound by another credential;
   * `PROTOCOL_INVALID_MESSAGE` for a malformed payload; `STORE_ERROR`.
   */
  handleTabNavigated(
    payload: TabNavigatedPayload,
    connection: BindingConnection,
  ): Promise<Result<TabNavigatedOutcome, DebuggenError>>;

  /**
   * `session.unbind`: drop the tab's binding, idempotently.
   *
   * @returns What was done; `UNAUTHORIZED` for a non-DevTools principal;
   * `TAB_NOT_BOUND` when the tab is bound by another credential;
   * `PROTOCOL_INVALID_MESSAGE` for a malformed payload; `STORE_ERROR`.
   */
  handleSessionUnbind(
    payload: SessionUnbindPayload,
    connection: BindingConnection,
  ): Promise<Result<SessionUnbindOutcome, DebuggenError>>;
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
}

/**
 * The bindings a bind displaced, from the live view and the durable store,
 * each once, the live view first. The store can report a binding the live view
 * no longer holds (a row written before a restart); that session lost its tab
 * too and is told the same way.
 */
function mergeDisplaced(
  live: readonly { readonly binding: TabBindingView }[],
  stored: BindingUpsert,
  bound: { readonly sessionId: SessionId; readonly tabId: number },
): readonly DisplacedBinding[] {
  const merged = new Map<string, DisplacedBinding>();
  const add = (entry: DisplacedBinding): void => {
    if (entry.sessionId === bound.sessionId && entry.tabId === bound.tabId) {
      return;
    }
    const key = `${entry.tabId}\u0000${entry.sessionId}`;
    if (!merged.has(key)) {
      merged.set(key, entry);
    }
  };
  for (const change of live) {
    add({
      sessionId: change.binding.sessionId,
      tabId: change.binding.tabId,
      url: change.binding.url,
    });
  }
  for (const row of [stored.displacedTab, stored.displacedSession]) {
    if (row !== undefined) {
      add({ sessionId: row.sessionId, tabId: row.tab.tabId, url: row.tab.url });
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
  /** The tab's durable row, or `undefined` when it had none. */
  readonly row: StoredTabBinding | undefined;
  /** The tab's live binding, or `undefined` when it had none. */
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

/** Whether two bindings pair the same tab with the same session. */
function samePair(
  left: { readonly tabId: number; readonly sessionId: string },
  right: { readonly tabId: number; readonly sessionId: string },
): boolean {
  return left.tabId === right.tabId && left.sessionId === right.sessionId;
}

/** The tab and session a durable row pairs, in the shape {@link samePair} compares. */
function pairOfRow(row: StoredTabBinding): { readonly tabId: number; readonly sessionId: string } {
  return { tabId: row.tab.tabId, sessionId: row.sessionId };
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
 * arming port, the navigation recorder, and the optional progress port,
 * logger and clock.
 * @returns The three handlers `../ws.ts` dispatches to.
 */
export function createBindingRoutes(deps: BindingRoutesDeps): BindingRoutes {
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
   * @param upsert What the bind's `upsertBinding` answered.
   * @param priorRow The tab's row before the bind, from {@link PriorBinding}.
   */
  function rollbackUpsert(upsert: BindingUpsert, priorRow: StoredTabBinding | undefined): void {
    const removed = sessions.deleteBinding(upsert.binding.tab.tabId);
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
      !reported.some((row) => samePair(pairOfRow(row), pairOfRow(priorRow)))
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
        !undo.live.displaced.some((change) => samePair(change.binding, priorLive))
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
   * The most recently updated session that has not ended and whose dev server
   * serves `origin`.
   *
   * The store answers from its projections alone —
   * {@link SessionsRepo.findLatestByDevServer} reads only the `id`,
   * `dev_server_url` and `updated_at` columns of the active sessions
   * `idx_sessions_status` narrows the read to, newest first, and stops at the
   * first whose URL
   * canonicalises to `origin` through {@link serializedOriginOf} — so the
   * record of the winner is the only one read and parsed, and an ended
   * session's history is never touched. A winner whose record cannot be read is
   * skipped, and the lookup continues past it, rather than allowed to hide
   * every older match.
   */
  function resolveByOrigin(origin: string): Result<ResolvedSession, DebuggenError> {
    const unreadable = new Set<SessionId>();
    for (;;) {
      const found = sessions.findLatestByDevServer({
        statuses: ACTIVE_SESSION_STATUSES,
        matches: (devServerUrl, candidate) =>
          !unreadable.has(candidate) && serializedOriginOf(devServerUrl) === origin,
      });
      if (isErr(found)) {
        return found;
      }
      const candidate = found.value;
      if (candidate === undefined) {
        break;
      }
      const loaded = sessions.get(candidate);
      const record = loaded.ok ? loaded.value : undefined;
      if (
        record !== undefined &&
        !isTerminalSessionStatus(record.status) &&
        serializedOriginOf(record.devServerUrl) === origin
      ) {
        return ok({ record, matchedBy: 'origin' });
      }
      // Unreadable, gone, or no longer what its projections said: excluded, so
      // the next lookup answers with the next-newest match.
      log.warn(
        'A session matching a tab origin could not be read; skipped',
        sessionFields(
          candidate,
          loaded.ok ? { present: record !== undefined } : errorFields(loaded.error),
        ),
      );
      unreadable.add(candidate);
    }
    log.info('A bind matched no active session by origin');
    return refusal('SESSION_NOT_FOUND', NO_SESSION_FOR_ORIGIN_MESSAGE, NO_SESSION_FOR_ORIGIN_HINT, {
      reason: 'no-session-for-origin',
    });
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
      return resolved;
    }
    const { record, matchedBy } = resolved.value;
    const sessionId = record.id;
    const { tabId } = request;
    // The raw URL decided the origin above and goes no further: every store,
    // the registry and every announcement hold the redacted form.
    const url = redactBoundUrl(request.url, origin);
    const boundAt = clock();

    // 0. What the tab is bound to now, in both stores. A re-bind of the same
    //    tab to the same session replaces that binding unreported (see
    //    PriorBinding), so a refusal below needs this snapshot to put it back.
    //    A row that cannot be read would refuse the upsert anyway.
    const priorRow = sessions.getBindingByTab(tabId);
    if (isErr(priorRow)) {
      log.error(
        "The tab's current binding row could not be read; the bind was refused",
        sessionFields(sessionId, { tabId, ...errorFields(priorRow.error) }),
      );
      return priorRow;
    }
    const prior: PriorBinding = { row: priorRow.value, live: clients.bindingForTab(tabId) };

    // 1. The durable row: what a restart rebuilds from.
    const stored = sessions.upsertBinding({ tabId, sessionId, url, boundAt });
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
    const released = mergeDisplaced(live.value.displaced, stored.value, { sessionId, tabId });
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

    // 7. An open capture continues in the newly bound tab.
    const rearm = rearmAgent(record);

    log.info(
      'Tab bound to session',
      sessionFields(sessionId, {
        tabId,
        matchedBy,
        displaced: displaced.length,
        rearm: rearm.status,
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
    const { tabId, sessionId } = binding;
    // The tab's row as it stands, so a refused record mirror below can have it
    // back exactly: a redundant re-bind renews the row's bound-at stamp but not
    // the live view's, and the row may already be gone. A row that cannot be
    // read would refuse the delete anyway.
    const priorRow = sessions.getBindingByTab(tabId);
    if (isErr(priorRow)) {
      log.error(
        "The tab's binding row could not be read; the binding was kept",
        sessionFields(sessionId, { tabId, ...errorFields(priorRow.error) }),
      );
      return priorRow;
    }
    const removed = sessions.deleteBinding(tabId);
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
      });
      log.warn(
        'The live binding refused the unbind; the binding row was written back unless its session has closed',
        sessionFields(sessionId, { tabId, restored, ...errorFields(change.error) }),
      );
      return change;
    }
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
   * The live binding of a tab, authorized for the principal: `undefined` when
   * the tab is not bound, `TAB_NOT_BOUND` when another credential bound it.
   *
   * A binding frame is about the one tab its payload names, so that tab is the
   * acting tab `requireBoundSession` checks the binding against. Two rules
   * upstream keep that tab the sender's own: protocol refuses a frame whose
   * envelope names a different tab, and `../ws.ts` refuses a payload tab other
   * than the one a single-tab connection announced in its hello before this
   * handler runs.
   */
  function authorizedBinding(
    tabId: number,
    principal: Principal,
  ): Result<TabBindingView | undefined, DebuggenError> {
    const binding = clients.bindingForTab(tabId);
    if (binding === undefined) {
      return ok(undefined);
    }
    const access = requireBoundSession(principal, binding.sessionId, binding, tabId);
    return isErr(access) ? access : ok(binding);
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
    const { tabId, sessionId } = binding;
    const stored = sessions.upsertBinding({ tabId, sessionId, url, boundAt: binding.boundAt });
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
      restoreRow({ sessionId, tab: { tabId, url: binding.url }, boundAt: binding.boundAt });
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
        restoreRow({ sessionId, tab: { tabId, url: binding.url }, boundAt: binding.boundAt });
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
    const announced = announce({
      sessionId,
      tabId,
      url: updated.value.binding.url,
      reason: updated.value.reason,
    });
    if (isErr(announced)) {
      return announced;
    }
    const rearm = rearmAgent(record);
    const reloadNotice = reportReloadDuringCapture(sessionId, rearm);
    log.info(
      'Bound tab navigated within its origin',
      sessionFields(sessionId, { tabId, rearm: rearm.status, reloadNotice }),
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
    // Accepted: the tab is unbound or bound by this credential. A refused frame
    // — another role, a malformed payload, another credential's tab — records
    // nothing, so it cannot make readiness distrust a report it has no say in.
    recordCommittedNavigation(tabId);
    const binding = authorized.value;
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
      log.debug('An unbind of an unbound tab was ignored', { tabId: parsed.value.tabId });
      return ok({ kind: 'ignored' });
    }
    const dropped = await dropBinding(binding, principal, REASON_UNBOUND, binding.url, true);
    if (isErr(dropped)) {
      return dropped;
    }
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
  } satisfies BindingRoutes);
}
