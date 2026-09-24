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
 * | `tab.navigated` | Same origin keeps the binding, records the new URL and re-arms the agent the new document started dormant; a different origin drops the binding. A navigation of an unbound tab is a no-op. |
 * | `session.unbind` | Drops the binding. Idempotent: an unbound tab is a no-op. It never ends the session, cancels a capture or disarms instrumentation. |
 *
 * **Cardinality** (AAP §0.2.3): one tab binds to at most one session and one
 * session accepts one tab at a time. A second bind replaces the first and is
 * announced: every displaced binding is told with `session.bound` carrying the
 * displaced session, tab and URL and `reason: 'replaced'`, before the new
 * binding is announced — the order the Chrome service worker's tab registry
 * relies on (it drops a record only when a drop names that record's tab *and*
 * session). A redundant re-bind of the same pair by the same credential — a
 * service-worker reconnect re-announcing its bindings — displaces nothing and
 * announces no replacement.
 *
 * **Two stores, one truth.** The durable `bindings` row
 * (`../../store/sessions-repo.ts`) survives a restart; the live
 * {@link ClientRegistry} view finds the socket. Every mutation writes the store
 * first and the registry second, then mirrors the tab onto the session record
 * through {@link SessionManager.setBoundTab} — the manager is the only writer of
 * the record and the only broadcaster of `session.updated`. A failure between
 * the two writes restores the store to what it held, so the two never disagree.
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
 * credential that made them with `requireBoundSession`.
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
 *   logger,
 * });
 * // inside ws.ts's exhaustive switch over the parsed message type:
 * //   const outcome = await binding.handleSessionBind(message.payload, { principal, clientId });
 * //   if (!outcome.ok) reply with protocol's error frame, ref = message.id
 * ```
 *
 * @module
 */

import {
  MESSAGE_PAYLOAD_SCHEMAS,
  MESSAGE_TYPES,
  bindingReasonSchema,
  clientKindSchema,
  createEnvelope,
  parseSessionBindPayload,
  parseSessionBoundPayload,
  parseSessionUnbindPayload,
  parseTabNavigatedPayload,
  sessionBoundPayloadSchema,
} from '@debuggen/protocol';
import type {
  BoundTab,
  ClientKind,
  MessagePayload,
  MessageType,
  SessionBindPayload,
  SessionBoundPayload,
  SessionRecord,
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

import type { InstrumentationService } from '../../instrumentation/service.js';
import { LOG_BINDING_KEYS, subsystemLogger } from '../../logging.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { SessionReopener } from '../../sessions/reopen.js';
import { MAX_SESSION_LIST_LIMIT } from '../../store/sessions-repo.js';
import type {
  BindingUpsert,
  SessionsRepo,
  TabBinding as StoredTabBinding,
} from '../../store/sessions-repo.js';
import { requireBoundSession, requireRole } from '../auth.js';
import type { Principal } from '../auth.js';
import type { ClientRegistry, TabBindingView } from '../clients.js';

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

/** Who receives the reopen replay after a bind: only the panel that just bound; the editor already holds it. */
const REPLAY_KINDS: readonly ClientKind[] = Object.freeze([KINDS.devtools]);

/** The two URL schemes a document a session can bind to is served over. */
const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

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
 * Everything {@link createBindingRoutes} is given; all of it is injected and
 * each field is narrowed to the members this module calls.
 */
export interface BindingRoutesDeps {
  /** The live bindings and the fan-out; the client registry in production. */
  readonly clients: Pick<
    ClientRegistry,
    'bindTab' | 'updateTabUrl' | 'unbindTab' | 'bindingForTab' | 'broadcastToKinds'
  >;
  /** The durable `bindings` rows, session records and open captures. */
  readonly sessions: Pick<
    SessionsRepo,
    'get' | 'list' | 'upsertBinding' | 'deleteBinding' | 'getActiveCapture'
  >;
  /** The one writer of the session record, which mirrors the bound tab and broadcasts `session.updated`. */
  readonly manager: Pick<SessionManager, 'setBoundTab'>;
  /** Replays stored state to a panel that just bound, and answers whether a session is read-only. */
  readonly reopener: Pick<SessionReopener, 'reopen'>;
  /** Re-sends `agent.config` for an open capture. */
  readonly arming: AgentArmingPort;
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
  /** The tab is not bound: nothing to do. */
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
   * `tab.navigated`: keep and re-arm on the same origin, drop on another.
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

/**
 * Builds the binding route over its injected collaborators.
 *
 * Constructing it has no side effect: no timer, no socket, no store access.
 *
 * @param deps The registry, the repository, the manager, the reopener, the
 * arming port and the optional logger and clock.
 * @returns The three handlers `../ws.ts` dispatches to.
 */
export function createBindingRoutes(deps: BindingRoutesDeps): BindingRoutes {
  const { clients, sessions, manager, reopener, arming } = deps;
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

  /* ---- store restoration ---- */

  /** Writes a displaced durable row back, logging (not propagating) a failure. */
  function restoreRow(row: StoredTabBinding): void {
    const restored = sessions.upsertBinding({
      tabId: row.tab.tabId,
      sessionId: row.sessionId,
      url: row.tab.url,
      boundAt: row.boundAt,
    });
    if (isErr(restored)) {
      log.error(
        'A displaced binding row could not be restored',
        sessionFields(row.sessionId, { tabId: row.tab.tabId, ...errorFields(restored.error) }),
      );
    }
  }

  /** Undoes one `upsertBinding`: removes the new row and writes back what it displaced. */
  function rollbackUpsert(upsert: BindingUpsert): void {
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
    for (const row of [upsert.displacedTab, upsert.displacedSession]) {
      if (row !== undefined) {
        restoreRow(row);
      }
    }
  }

  /* ---- session resolution ---- */

  /**
   * Whether a session has ended, answered by the reopener's pure read
   * (`readOnly` is exactly "terminal" there) so the terminal-status rule stays
   * the state machine's.
   */
  async function isReadOnly(sessionId: SessionId): Promise<Result<boolean, DebuggenError>> {
    const read = await reopener.reopen(sessionId, { replay: false });
    return isErr(read) ? read : ok(read.value.readOnly);
  }

  /** The named session, provided its dev server serves the tab's origin and it has not ended. */
  async function resolveNamed(
    sessionId: SessionId,
    origin: string,
  ): Promise<Result<ResolvedSession, DebuggenError>> {
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
    const readOnly = await isReadOnly(record.id);
    if (isErr(readOnly)) {
      return readOnly;
    }
    if (readOnly.value) {
      return refusal('SESSION_INVALID_STATE', SESSION_ENDED_MESSAGE, SESSION_ENDED_HINT, {
        reason: 'session-ended',
      });
    }
    return ok({ record, matchedBy: 'session-id' });
  }

  /**
   * The most recently updated session that has not ended and whose dev server
   * serves `origin`. Sessions are walked newest first, a page at a time; a
   * session whose record cannot be read is skipped rather than allowed to hide
   * every older one.
   */
  async function resolveByOrigin(origin: string): Promise<Result<ResolvedSession, DebuggenError>> {
    let offset = 0;
    for (;;) {
      const page = sessions.list({ limit: MAX_SESSION_LIST_LIMIT, offset });
      if (isErr(page)) {
        return page;
      }
      const { items, total } = page.value;
      for (const item of items) {
        const loaded = sessions.get(item.id);
        if (isErr(loaded)) {
          log.warn(
            'A session record could not be read while matching a tab origin; skipped',
            sessionFields(item.id, errorFields(loaded.error)),
          );
          continue;
        }
        const record = loaded.value;
        if (record === undefined || serializedOriginOf(record.devServerUrl) !== origin) {
          continue;
        }
        const readOnly = await isReadOnly(record.id);
        if (isErr(readOnly)) {
          log.warn(
            'A session matching a tab origin could not be read; skipped',
            sessionFields(record.id, errorFields(readOnly.error)),
          );
          continue;
        }
        if (!readOnly.value) {
          return ok({ record, matchedBy: 'origin' });
        }
      }
      offset += items.length;
      if (items.length === 0 || offset >= total) {
        break;
      }
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
        ? await resolveByOrigin(origin)
        : await resolveNamed(request.sessionId, origin);
    if (isErr(resolved)) {
      return resolved;
    }
    const { record, matchedBy } = resolved.value;
    const sessionId = record.id;
    const { tabId, url } = request;
    const boundAt = clock();

    // 1. The durable row: what a restart rebuilds from.
    const stored = sessions.upsertBinding({ tabId, sessionId, url, boundAt });
    if (isErr(stored)) {
      log.error(
        'The binding could not be persisted',
        sessionFields(sessionId, { tabId, ...errorFields(stored.error) }),
      );
      return stored;
    }

    // 2. The live view: what a push finds the socket through.
    const live = clients.bindTab({
      tabId,
      sessionId,
      url,
      principal,
      clientId: connection.clientId,
      boundAt,
    });
    if (isErr(live)) {
      rollbackUpsert(stored.value);
      log.warn(
        'The live binding was refused; the persisted row was rolled back',
        sessionFields(sessionId, { tabId, ...errorFields(live.error) }),
      );
      return live;
    }

    // 3. Tell every displaced binding it was replaced, then clear the record of
    //    each other session that lost its tab.
    const displaced: BindingAnnouncement[] = [];
    const released = mergeDisplaced(live.value.displaced, stored.value, { sessionId, tabId });
    for (const previous of released) {
      const announced = announce({
        sessionId: previous.sessionId,
        tabId: previous.tabId,
        url: previous.url,
        reason: REASON_REPLACED,
      });
      if (announced.ok) {
        displaced.push(announced.value);
      }
    }
    const orphanedSessions = new Set(
      released.map((previous) => previous.sessionId).filter((id) => id !== sessionId),
    );
    for (const orphaned of orphanedSessions) {
      await mirrorBoundTab(orphaned, undefined);
    }

    // 4. Mirror the new tab onto the session record. Should the manager refuse,
    //    the new binding is undone in both stores so they keep agreeing.
    if (!recordShowsTab(record, tabId, url)) {
      const mirrored = await mirrorBoundTab(sessionId, { tabId, url });
      if (isErr(mirrored)) {
        const undone = clients.unbindTab(tabId, { principal });
        const removed = sessions.deleteBinding(tabId);
        log.warn(
          'The session record refused the bound tab; the new binding was undone',
          sessionFields(sessionId, {
            tabId,
            liveUndone: undone.ok,
            storeUndone: removed.ok,
          }),
        );
        return mirrored;
      }
    }

    // 5. Announce the establishment to the panel and the session's editors.
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
   * Drops a live binding: the durable row first, the live view second (the row
   * is written back should the registry refuse), then the record mirror and the
   * announcement. Never touches the session's status, capture or
   * instrumentation.
   *
   * @param binding The live binding, already authorized for `principal`.
   * @param reason Why it ends.
   * @param announcedUrl The URL the announcement carries: the new document for
   * an origin change, the last known one otherwise.
   * @param clearRecord Whether the session still has a record to clear.
   */
  async function dropBinding(
    binding: TabBindingView,
    principal: Principal,
    reason: DropReason,
    announcedUrl: string,
    clearRecord: boolean,
  ): Promise<Result<BindingAnnouncement | undefined, DebuggenError>> {
    const { tabId, sessionId } = binding;
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
      const restored = sessions.upsertBinding({
        tabId,
        sessionId,
        url: binding.url,
        boundAt: binding.boundAt,
      });
      log.warn(
        'The live binding refused the unbind; the binding row was restored',
        sessionFields(sessionId, { tabId, restored: restored.ok, ...errorFields(change.error) }),
      );
      return change;
    }
    if (change.value === undefined) {
      return ok(undefined);
    }
    if (clearRecord) {
      await mirrorBoundTab(sessionId, undefined);
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
   */
  function authorizedBinding(
    tabId: number,
    principal: Principal,
  ): Result<TabBindingView | undefined, DebuggenError> {
    const binding = clients.bindingForTab(tabId);
    if (binding === undefined) {
      return ok(undefined);
    }
    const access = requireBoundSession(principal, binding.sessionId, binding);
    return isErr(access) ? access : ok(binding);
  }

  /* ---- tab.navigated ---- */

  /**
   * Keeps a binding across a same-origin navigation: records the new URL in
   * the durable row, the live view and the session record, announces it and
   * re-arms the agent the new document started dormant.
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
      await mirrorBoundTab(sessionId, { tabId, url });
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
    log.info(
      'Bound tab navigated within its origin',
      sessionFields(sessionId, { tabId, rearm: rearm.status }),
    );
    return ok({ kind: 'kept', announced: announced.value, rearm });
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
    if (binding === undefined) {
      log.debug('A navigation of an unbound tab was ignored', { tabId });
      return ok({ kind: 'ignored' });
    }
    const loaded = sessions.get(binding.sessionId);
    if (isErr(loaded)) {
      return loaded;
    }
    const record = loaded.value;
    if (record !== undefined && isSessionOrigin(record.devServerUrl, url)) {
      return keepBinding(binding, record, url, principal);
    }
    // Another origin — or a session that no longer exists, which no document can
    // belong to: the binding ends. The announcement carries the new document for
    // an origin change and the last known one for a vanished session.
    const dropped =
      record === undefined
        ? await dropBinding(binding, principal, REASON_UNBOUND, binding.url, false)
        : await dropBinding(binding, principal, REASON_ORIGIN_CHANGED, url, true);
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
