/**
 * `ws-protocol` — the WebSocket protocol surface of the local service, driven
 * through real sockets against the in-process service (AAP §0.8.3, §0.4.2).
 *
 * ## What this suite proves, and what it leaves to others
 *
 * Its unique value is **routing across a live multi-client topology** and
 * **process survival under malformed input**:
 *
 * - every inbound message type the service dispatches is driven through a real
 *   socket and asserted by its observable effect (a push, a stored record, a
 *   persisted event), never by a spy;
 * - every service push is asserted to reach exactly the client kinds the AAP
 *   §0.4.2 message table names **and no other connection** — a foreign
 *   project's editor and server agent, an unbound DevTools tab and a
 *   disallowed kind all stay silent;
 * - a malformed frame is answered with protocol's `error` message on the same
 *   connection, which stays open, and the process keeps serving;
 * - every refusal's `ref` — the frame's own id where it is readable and spelled
 *   exactly as the product mints message ids (`msg_` and sixteen characters of
 *   `[0-9a-z]`), a service-minted one otherwise — is the ref of the service's
 *   own log records of it, so concurrent failures of one code stay apart on
 *   the wire and in the log, and no id a client chose (a URL, a statement, an
 *   upper-case or foreign-prefix id) is ever filed in a `server.ws` record; a
 *   handler that throws is filed at `error` in the closed exception shape and
 *   again, under the same ref, in a `debug` twin that alone carries the
 *   redacted message (read through the harness's capturing logger, which
 *   records at `debug`);
 * - a DevTools socket that drops mid-capture keeps its session, binding and
 *   capture, and a reconnect with the same credential carries the traffic
 *   again without a re-bind (an MV3 service worker suspends when idle);
 * - the upgrade gate admits unauthenticated sockets only within its per-peer,
 *   global and open-socket quotas — past them an upgrade is answered 429 or
 *   503 over bare HTTP, with `Retry-After`, and no WebSocket is created — and
 *   every reservation is given back when a hello authenticates, a socket
 *   closes or times out, or `ws` aborts a handshake, so the counters read zero
 *   after `close()`;
 * - one connection's backlog starves nothing: while a DevTools socket's flood
 *   of CPU-bound `telemetry.event` frames drains, a fresh connection's hello
 *   and `client.ping`, and the service's `GET /health`, are answered within a
 *   bound; a ping written behind the flood is answered on arrival, before the
 *   flood's last frames; the flood is still handled in order, in full, with
 *   read flow control engaged and no 1013 close; and `close()` ends a socket
 *   whose reads are paused at once, leaving no queued frame to run after it.
 *
 * It deliberately does not restate what other suites pin: the envelope and
 * payload schemas are `packages/protocol/src/__tests__/*`, the handshake's
 * credential matrix is `auth`, the full binding matrix is `binding`, path
 * containment is `source-open`, the redaction order is `telemetry-ingest`, and
 * the registry and router internals are the colocated `src/server/*.test.ts`.
 *
 * ## The vocabulary is derived, never restated
 *
 * {@link ROUTES} is keyed by protocol's closed `MessageType` union and checked
 * against `MESSAGE_TYPES` both by the compiler (`satisfies`) and at run time,
 * so a twenty-ninth message type fails this suite until it is classified. The
 * inbound set is `MESSAGE_TYPES` filtered through that table, and the final
 * describe block fails unless every inbound type was proved dispatched by a
 * live test and every service-only push — and the two sender-only replies,
 * `error` and `service.pong` — was proved refused when a client sends it. Each message name and client kind is
 * written exactly once, in {@link T} and {@link KIND}, compile-checked against
 * protocol's vocabulary.
 *
 * ## Rules ruling
 *
 * No user rules govern this file (`review_rules`: "No user rules provided."),
 * so the AAP §0.10 baseline applies: the suite is part of
 * `pnpm test:integration` inside `pnpm verify` and passes `tsc -b`,
 * `eslint --max-warnings 0` and `prettier --check .`; every credential is
 * minted by the harness through the real auth service or assembled by
 * `randomSecretLike` at run time, and every malformed frame is built at run
 * time from strings and bytes — nothing credential-shaped or binary is
 * committed; imports stay inside the workspace's dependency set (`@debuggen/*`
 * except the panel renderer, `ws` — its types, and the bare client the
 * admission block opens sockets with — and `node:*`), with no `zod` and no DOM
 * types.
 */

import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { isDeepStrictEqual } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import type { RawData } from 'ws';

import {
  BINDING_REASONS,
  CLIENT_HELLO_TIMEOUT_MS,
  CLIENT_KINDS,
  HTTP_ONLY_PAYLOAD_NAMES,
  MESSAGE_TYPES,
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  PROTOCOL_VERSION,
  SESSION_STATUSES,
  TELEMETRY_TIERS,
  createEnvelope,
  decodeMessage,
  encodeMessage,
  envelopeBaseShape,
  errorPayloadSchema,
  isMessageOfType,
  parseMessage,
  resolveWsUrl,
  telemetryEventPayloadSchema,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
} from '@debuggen/protocol';
import type {
  BindingReason,
  ClientKind,
  ConnectionState,
  ErrorPayload,
  HttpOperationId,
  HttpResponseBody,
  MessageByType,
  MessagePayload,
  MessageType,
  ProgressStage,
  ProgressStatus,
  ProtocolMessage,
  SelectedTarget,
  SendOutcome,
  SessionRecord,
  SessionStatus,
  SourceLocation,
  TelemetryEventIngress,
  TelemetryTier,
} from '@debuggen/protocol';
import {
  DebuggenError,
  ID_PREFIXES,
  err,
  isErr,
  newEventId,
  newId,
  newMessageId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Result } from '@debuggen/shared';

import {
  DEFAULT_MAX_CLIENTS,
  WS_CLOSE_GOING_AWAY,
  createClientRegistry,
} from '../../src/server/clients.js';
import type { ClientRegistry } from '../../src/server/clients.js';
import {
  CLOSE_HANDSHAKE_GRACE_MS,
  DEFAULT_MAX_OPEN_CONNECTIONS,
  DEFAULT_MAX_PENDING_HANDSHAKES,
  DEFAULT_MAX_PENDING_HANDSHAKES_PER_PEER,
  EARLY_PING_MAX_FRAME_BYTES,
  MAX_WS_MESSAGE_BYTES,
  createWsServer,
} from '../../src/server/ws.js';
import type {
  UpgradeListener,
  UpgradeSource,
  WsServer,
  WsServerDeps,
  WsServerStats,
} from '../../src/server/ws.js';
import {
  HARNESS_TIMEOUTS,
  createHarnessClock,
  createScriptedProvider,
  isUnauthorizedClose,
  randomSecretLike,
  readTelemetryBatch,
  startHarness,
  waitFor,
  waitUntil,
} from './harness.js';
import type {
  CapturedLogRecord,
  DevtoolsCredential,
  FixtureProjectCopy,
  Harness,
  HarnessMessage,
  HarnessOptions,
  HarnessWsClient,
  ScriptedProvider,
} from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * The protocol vocabulary this suite names — each literal once, checked by the compiler
 * ---------------------------------------------------------------------------------------------- */

/** Accepts only `true`, so an assertion that evaluates to `false` fails to compile. */
type AssertTrue<Condition extends true> = Condition;

/**
 * Every WebSocket message type, under a short name. `satisfies` checks each
 * literal against protocol's `MessageType` (derived from `MESSAGE_TYPES`), and
 * {@link VocabularyIsComplete} proves no member of the union is missing.
 */
const T = Object.freeze({
  hello: 'client.hello',
  ping: 'client.ping',
  pong: 'service.pong',
  agentReady: 'agent.ready',
  agentConfig: 'agent.config',
  serverAgentConfig: 'server-agent.config',
  bind: 'session.bind',
  bound: 'session.bound',
  navigated: 'tab.navigated',
  unbind: 'session.unbind',
  created: 'session.created',
  updated: 'session.updated',
  progress: 'session.progress',
  analysis: 'analysis.completed',
  captureStarted: 'capture.started',
  captureStopped: 'capture.stopped',
  plan: 'instrumentation.plan',
  ready: 'instrumentation.ready',
  failed: 'instrumentation.failed',
  telemetry: 'telemetry.event',
  tail: 'telemetry.tail',
  panel: 'panel.generated',
  sourceOpen: 'source.open',
  sourceResult: 'source.result',
  targetRequest: 'target.request',
  targetSelected: 'target.selected',
  cleanup: 'cleanup.completed',
  error: 'error',
} as const satisfies Readonly<Record<string, MessageType>>);

/** Compile-time proof that {@link T} names every member of `MessageType`. */
type VocabularyIsComplete = AssertTrue<
  MessageType extends (typeof T)[keyof typeof T] ? true : false
>;

/** The four client kinds, checked against protocol's `ClientKind` (derived from `CLIENT_KINDS`). */
const KIND = Object.freeze({
  editor: 'vscode',
  devtools: 'devtools',
  agent: 'agent',
  serverAgent: 'server-agent',
} as const satisfies Readonly<Record<string, ClientKind>>);

/** Compile-time proof that {@link KIND} names every member of `ClientKind`. */
type ClientKindsAreComplete = AssertTrue<
  ClientKind extends (typeof KIND)[keyof typeof KIND] ? true : false
>;

/**
 * The two compile-time proofs as values, so the vocabulary test reads them:
 * either alias failing to resolve to `true` makes these lines a type error.
 */
const VOCABULARY_PROOFS: readonly [VocabularyIsComplete, ClientKindsAreComplete] = [true, true];

/** The session statuses this suite waits for, checked against `SessionStatus`. */
const STATUS = Object.freeze({
  instrumenting: 'instrumenting',
  ready: 'ready',
  capturing: 'capturing',
  generated: 'generated',
  ended: 'ended',
  failed: 'failed',
} as const satisfies Readonly<Record<string, SessionStatus>>);

/** The binding transitions this suite observes, checked against `BindingReason`. */
const REASON = Object.freeze({
  bound: 'bound',
  navigated: 'navigated',
  originChanged: 'origin-changed',
  unbound: 'unbound',
} as const satisfies Readonly<Record<string, BindingReason>>);

/** The progress stage the readiness gate reports under, and the row statuses it uses. */
const INSTRUMENT_STAGE = 'instrument' satisfies ProgressStage;
const ROW_DONE = 'done' satisfies ProgressStatus;
const ROW_FAILED = 'failed' satisfies ProgressStatus;
const ROW_RUNNING = 'running' satisfies ProgressStatus;

/** The telemetry tier a relayed page-agent batch belongs to. */
const BROWSER_TIER = 'browser' satisfies TelemetryTier;

/** How a source location in a probe was resolved, checked against `SourceLocation`. */
const PROBE_RESOLVED_BY = 'code-graph' satisfies SourceLocation['resolvedBy'];

/**
 * RFC 6455 §7.4.1 close code 1009, "message too big": what the `ws` transport
 * closes a connection with when one frame exceeds the service's
 * `MAX_WS_MESSAGE_BYTES`, before any byte of it is buffered.
 */
const WS_CLOSE_MESSAGE_TOO_BIG = 1009;

/** The error codes this suite expects, checked against shared's closed `DebuggenErrorCode` set. */
const CODE = Object.freeze({
  invalidMessage: 'PROTOCOL_INVALID_MESSAGE',
  invalidState: 'SESSION_INVALID_STATE',
  tabNotBound: 'TAB_NOT_BOUND',
  installFailed: 'INSTRUMENTATION_INSTALL_FAILED',
  unauthorized: 'UNAUTHORIZED',
  transportDisconnected: 'TRANSPORT_DISCONNECTED',
  internal: 'INTERNAL',
  configInvalid: 'CONFIG_INVALID',
} as const satisfies Readonly<Record<string, DebuggenErrorCode>>);

/**
 * The HTTP statuses this suite reads: a healthy `GET /health`, a refused body,
 * a refused role, a refused capture or target request, and a bound tab whose
 * connection is offline — and on the upgrade gate, an admitted upgrade, an
 * off-route one and the two admission refusals (429 for the unauthenticated
 * share, 503 for the open-socket cap).
 */
const HTTP_SWITCHING_PROTOCOLS = 101;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAVAILABLE = 503;

/**
 * The editor's HTTP operation that makes the service push `target.request` to
 * a session's bound tab. Protocol names the HTTP leg after the push it
 * produces; `satisfies` checks the literal against the route table's own
 * operation vocabulary rather than the message vocabulary {@link T} holds.
 */
const TARGET_REQUEST_OPERATION = 'target.request' satisfies HttpOperationId;

/** The client state a reconnected socket reaches once its hello is written and its queue drained. */
const CONNECTION_OPEN = 'open' satisfies ConnectionState;

/** What `ReconnectingWsClient.send` answers for a frame held for the next connection. */
const SEND_QUEUED = 'queued' satisfies SendOutcome;

/**
 * The debug record the client registry (`src/server/clients.ts`) writes when a
 * closed connection's registration is marked offline — kept, with its sessions
 * and bindings, rather than removed. The service exposes the registry to no
 * other observer, so this record (captured at `debug` by the harness) is how
 * the suite tells "offline" from "gone".
 */
const CLIENT_OFFLINE_LOG = 'Client marked offline; its sessions and bindings are kept';

/**
 * The `subsystem` binding of `src/server/ws.ts`'s records. Every refusal of a
 * frame is filed there under the very `ref` its `error` reply carries, so a
 * reply is matched to its diagnostic by `ref` alone — never by message text,
 * which is the service's to reword.
 */
const WS_LOG_SUBSYSTEM = 'server.ws';

/**
 * Longer than protocol's `error.ref` bound (64) yet inside the envelope's own
 * `id` bound (128): a frame carrying such an id decodes, but its reply cannot
 * echo the id and must carry a service-minted ref instead.
 */
const OVER_REF_BOUND_ID_LENGTH = 100;

/**
 * The spelling of every message id the product mints — `newMessageId`'s
 * contract in `packages/shared/src/ids.ts`: the `msg` prefix, one underscore
 * and sixteen characters of `[0-9a-z]` (the module keeps the alphabet and the
 * length private, so the pattern is written from its documented contract).
 * Every ref the service files a frame failure under has this spelling, and a
 * client id is echoed as the ref only when it has it too.
 */
const MINTED_MESSAGE_ID = new RegExp(`^${ID_PREFIXES.message}_[0-9a-z]{16}$`, 'u');

/** The four keys of the envelope protocol builds every frame from, plus the discriminant and body. */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(envelopeBaseShape),
  'type',
  'payload',
]);

/* -------------------------------------------------------------------------------------------------
 * The routing table of AAP §0.4.2
 * ---------------------------------------------------------------------------------------------- */

/** How one message type travels. */
interface MessageRoute {
  /** Whether a client sends it and the service dispatches it to a handler. */
  readonly inbound: boolean;
  /**
   * The client kinds a service push of this type may reach. `'sender'` means
   * only the connection whose frame it answers; an empty list means the service
   * never pushes it.
   */
  readonly pushedTo: readonly ClientKind[] | 'sender';
  /**
   * The kinds that must receive it during the lifecycle drive of the topology
   * suite. A kind is absent when the drive cannot reach it there: the DevTools
   * panel binds after `session.created`, and `instrumentation.failed` needs a
   * failed install (its own suite). `target.request` must reach the bound
   * DevTools tab, because the drive calls the editor's real
   * `POST /sessions/:id/target/request`; the unbound tab's silence, and every
   * other connection's, is still asserted.
   */
  readonly mustReach: readonly ClientKind[];
}

/** The two user interfaces: the editor and the DevTools panel. */
const INTERFACES: readonly ClientKind[] = Object.freeze([KIND.editor, KIND.devtools]);

/** A type only a client sends; the service never pushes it. */
const INBOUND_ONLY: MessageRoute = Object.freeze({ inbound: true, pushedTo: [], mustReach: [] });

/** A session fan-out to both user interfaces, which the drive reaches at both. */
const TO_INTERFACES: MessageRoute = Object.freeze({
  inbound: false,
  pushedTo: INTERFACES,
  mustReach: INTERFACES,
});

/**
 * Every message type, classified. Page-agent frames (`agent.config`) ride the
 * bound tab's DevTools connection — the agent owns no socket (AAP §0.4.2) — so
 * their recipient kind is `devtools`, restricted to the bound tab. "All
 * clients of the session" (`capture.started`/`capture.stopped`) means the two
 * user interfaces attached to it: the server agent is a client of a
 * *project*, not of a session, and is armed and disarmed through its own
 * `server-agent.config` instead.
 */
const ROUTES = Object.freeze({
  [T.hello]: INBOUND_ONLY,
  // Any authenticated connection may ping; the answer goes to it alone.
  [T.ping]: INBOUND_ONLY,
  [T.pong]: { inbound: false, pushedTo: 'sender', mustReach: [] },
  [T.agentReady]: INBOUND_ONLY,
  [T.agentConfig]: { inbound: false, pushedTo: [KIND.devtools], mustReach: [KIND.devtools] },
  [T.serverAgentConfig]: {
    inbound: false,
    pushedTo: [KIND.serverAgent],
    mustReach: [KIND.serverAgent],
  },
  [T.bind]: INBOUND_ONLY,
  [T.bound]: TO_INTERFACES,
  [T.navigated]: INBOUND_ONLY,
  [T.unbind]: INBOUND_ONLY,
  [T.created]: { inbound: false, pushedTo: INTERFACES, mustReach: [KIND.editor] },
  [T.updated]: TO_INTERFACES,
  [T.progress]: TO_INTERFACES,
  [T.analysis]: TO_INTERFACES,
  [T.captureStarted]: TO_INTERFACES,
  [T.captureStopped]: TO_INTERFACES,
  [T.plan]: TO_INTERFACES,
  [T.ready]: TO_INTERFACES,
  [T.failed]: { inbound: false, pushedTo: INTERFACES, mustReach: [] },
  [T.telemetry]: INBOUND_ONLY,
  [T.tail]: { inbound: false, pushedTo: [KIND.devtools], mustReach: [KIND.devtools] },
  [T.panel]: TO_INTERFACES,
  [T.sourceOpen]: { inbound: true, pushedTo: [KIND.editor], mustReach: [KIND.editor] },
  // Sent by the editor answering a forwarded `source.open`, and relayed by the
  // service to the `source.open`'s sender alone, under that sender's own `ref`.
  [T.sourceResult]: { inbound: true, pushedTo: 'sender', mustReach: [] },
  [T.targetRequest]: { inbound: false, pushedTo: [KIND.devtools], mustReach: [KIND.devtools] },
  [T.targetSelected]: INBOUND_ONLY,
  [T.cleanup]: TO_INTERFACES,
  [T.error]: { inbound: false, pushedTo: 'sender', mustReach: [] },
} as const satisfies Readonly<Record<MessageType, MessageRoute>>);

/** The route of one type, widened to the interface. */
function routeOf(type: MessageType): MessageRoute {
  return ROUTES[type];
}

/** The kinds a push of `type` may reach — none for the sender-only `error` and `service.pong`. */
function allowedKinds(type: MessageType): readonly ClientKind[] {
  const { pushedTo } = routeOf(type);
  return pushedTo === 'sender' ? [] : pushedTo;
}

/** The types the service dispatches: `MESSAGE_TYPES` filtered through {@link ROUTES}. */
const INBOUND_TYPES: readonly MessageType[] = MESSAGE_TYPES.filter((type) => routeOf(type).inbound);

/** The types the service pushes to a kind (the sender-only replies excluded). */
const PUSHED_TYPES: readonly MessageType[] = MESSAGE_TYPES.filter(
  (type) => allowedKinds(type).length > 0,
);

/** The pushes a client may never send: every pushed type that is not also inbound. */
const SERVICE_ONLY_TYPES: readonly MessageType[] = PUSHED_TYPES.filter(
  (type) => !routeOf(type).inbound,
);

/**
 * The replies the service sends only to the connection whose frame they
 * answer, and that no client may send: the `error` refusal and the
 * `service.pong` liveness answer.
 */
const REPLY_ONLY_TYPES: readonly MessageType[] = MESSAGE_TYPES.filter((type) => {
  const route = routeOf(type);
  return !route.inbound && route.pushedTo === 'sender';
});

/**
 * The facets an inbound type must be proved on. `tab.navigated` has two
 * outcomes that are different routes through the service, and `client.hello`
 * both registers a connection and refuses a second hello on it.
 */
const REQUIRED_FACETS: Readonly<Partial<Record<MessageType, readonly string[]>>> = Object.freeze({
  [T.hello]: ['registered', 'second-hello-refused'],
  [T.navigated]: ['same-origin', 'cross-origin'],
});

/** The facet every other inbound type is proved on. */
const DISPATCHED = 'dispatched';

/** What the live tests proved, collected across the describe blocks of this file. */
const proved = {
  inbound: new Map<MessageType, Set<string>>(),
  refusedWhenSentByClient: new Set<MessageType>(),
  clientErrorFrameRefused: false,
  clientPongFrameRefused: false,
};

/** Records that an inbound type's facet was proved by a live test. */
function proveInbound(type: MessageType, facet: string = DISPATCHED): void {
  const facets = proved.inbound.get(type) ?? new Set<string>();
  facets.add(facet);
  proved.inbound.set(type, facets);
}

/* -------------------------------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------------------------------- */

/** The inspected tabs of the five scenarios, one block each so no two suites share a tab id. */
const TAB = Object.freeze({
  bound: 101,
  unbound: 102,
  absent: 201,
  offline: 202,
  malformed: 301,
  reconnecting: 401,
  failedInstall: 501,
  failureRefs: 601,
  flood: 701,
});

/** The question every session asks; the pipeline never branches on it (AAP §0.5.4). */
const QUESTION = 'Why does the report take so long to appear after the button is pressed?';

/** The bytes of padding that make the within-ceiling oversized probe frame roughly a mebibyte. */
const OVERSIZED_PADDING_BYTES = 1024 * 1024;

/** A fresh value no service code path could produce, to prove a rejected value is never echoed. */
function newMarker(): string {
  return `probe-${randomBytes(12).toString('hex')}`;
}

/** Unwraps a `Result`, failing the test with the operation's name and the refusal's message. */
function unwrap<V, E extends { readonly message: string }>(result: Result<V, E>, what: string): V {
  if (isErr(result)) {
    throw new Error(`${what} was refused: ${result.error.message}`);
  }
  return result.value;
}

/** The messages of one type a client received, narrowed, in arrival order. */
function messagesOf<K extends MessageType>(
  client: HarnessWsClient,
  type: K,
  from = 0,
): HarnessMessage<K>[] {
  return client.received
    .slice(from)
    .filter((message): message is HarnessMessage<K> => isMessageOfType(message, type));
}

/**
 * The `server.ws` records filed under `ref` at index `from` or later: the
 * service's diagnostics of the failure an `error` reply carrying that `ref`
 * answered. The harness captures at `debug`, where every frame refusal is
 * logged, and a record is written before its reply is sent, so a reply that
 * has arrived always has its records captured.
 */
function wsRecordsFor(h: Harness, ref: string, from = 0): readonly CapturedLogRecord[] {
  return h.logger.records
    .slice(from)
    .filter(
      (record) => record.fields['subsystem'] === WS_LOG_SUBSYSTEM && record.fields['ref'] === ref,
    );
}

/**
 * The session a frame belongs to: its envelope routing key, or — for a frame
 * whose payload carries a whole record — that record's id.
 */
function sessionOf(message: ProtocolMessage): string | undefined {
  if (message.sessionId !== undefined) {
    return message.sessionId;
  }
  if (isMessageOfType(message, T.created) || isMessageOfType(message, T.updated)) {
    return message.payload.session.id;
  }
  return undefined;
}

/** Waits for a message of `type` that arrived at index `from` or later and belongs to `sessionId`. */
function waitForSessionMessage<K extends MessageType>(
  client: HarnessWsClient,
  type: K,
  sessionId: string,
  from = 0,
  predicate: (message: HarnessMessage<K>) => boolean = () => true,
  timeoutMs: number = HARNESS_TIMEOUTS.pipeline,
): Promise<HarnessMessage<K>> {
  return waitFor(
    client,
    type,
    (message, index) => index >= from && sessionOf(message) === sessionId && predicate(message),
    timeoutMs,
  );
}

/** Reads a session through `GET /sessions/:id` with the editor credential. */
async function fetchSession(harness: Harness, sessionId: string): Promise<SessionRecord> {
  return unwrap(
    await harness.http().request('session.get', { params: { id: sessionId } }),
    'reading the session',
  );
}

/**
 * Calls the editor's real `POST /sessions/:id/target/request` through
 * protocol's own HTTP client — with the editor credential, or with `presenting`
 * from the extension origin it was issued to — and answers the client's
 * verdict unchanged.
 */
function requestTarget(
  harness: Harness,
  sessionId: string,
  presenting?: DevtoolsCredential,
): Promise<Result<HttpResponseBody<typeof TARGET_REQUEST_OPERATION>, DebuggenError>> {
  const client =
    presenting === undefined
      ? harness.http()
      : harness.http(presenting.token, { origin: presenting.origin });
  return client.request(TARGET_REQUEST_OPERATION, { params: { id: sessionId }, body: {} });
}

/**
 * The one `target.request` frame with envelope `id` among the verbatim text a
 * connection's socket delivered, parsed by protocol's `parseMessage` — proof
 * of what the service wrote, independent of the transcript the client built.
 */
function wireFrameWithId(tap: WireTap, id: string): ProtocolMessage | undefined {
  for (const frame of tap.frames) {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      continue;
    }
    const parsed = parseMessage(value);
    if (!isErr(parsed) && parsed.value.id === id) {
      return parsed.value;
    }
  }
  return undefined;
}

/** The live dev server of a session, as the DevTools panel would see its inspected tab. */
function tabOf(session: SessionRecord): { readonly url: string; readonly origin: string } {
  const url = new URL('/', session.devServerUrl);
  return { url: url.toString(), origin: url.origin };
}

/** What the page agent reports when it initialises in a document before React loaded. */
function agentReadyFor(tabId: number, url: string): MessagePayload<typeof T.agentReady> {
  return {
    tabId,
    documentId: newId('doc'),
    producerId: newProducerId(),
    url,
    installedBeforeReact: true,
    reactDetected: true,
  };
}

/** A selected-element descriptor whose selector carries `marker`, so its arrival is attributable. */
function selectedTarget(url: string, marker: string): SelectedTarget {
  return { selector: `[data-probe="${marker}"]`, tagName: 'button', componentChain: [], url };
}

/**
 * `count` page-agent events of one fresh trace and producer, built from the
 * committed cross-tier fixture's root browser interaction with every identity
 * field minted anew — so a batch never collides with another suite's rows.
 */
function browserEvents(count: number): TelemetryEventIngress[] {
  const template = readTelemetryBatch('telemetry-trace-cross-tier.json').find(
    (event) => event.tier === BROWSER_TIER && event.parentSpanId === undefined,
  );
  if (template === undefined) {
    throw new Error('The cross-tier fixture no longer holds a root browser event.');
  }
  const traceId = newTraceId();
  const producerId = newProducerId();
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    id: newEventId(),
    traceId,
    spanId: newSpanId(),
    producerId,
    seq: index + 1,
  }));
}

/**
 * The per-batch event bound of `telemetry.event`, read from protocol's own
 * payload schema. Protocol keeps the constant module-local (the telemetry
 * package exports a different number under the same name), so it is read from
 * the `max_length` check the `events` array declares rather than restated.
 */
function protocolBatchBound(): number {
  const readProperty = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null
      ? (value as Readonly<Record<string, unknown>>)[key]
      : undefined;
  const checks = readProperty(
    readProperty(telemetryEventPayloadSchema.shape.events, 'def'),
    'checks',
  );
  const bounds = (Array.isArray(checks) ? (checks as readonly unknown[]) : [])
    .map((check) => readProperty(readProperty(check, '_zod'), 'def'))
    .filter((definition) => readProperty(definition, 'check') === 'max_length')
    .map((definition) => readProperty(definition, 'maximum'))
    .filter((maximum): maximum is number => typeof maximum === 'number' && maximum > 0);
  const bound = bounds.length === 0 ? undefined : Math.min(...bounds);
  if (bound === undefined || !Number.isSafeInteger(bound)) {
    throw new Error('The telemetry.event payload schema declares no readable batch bound.');
  }
  return bound;
}

/** A received `ws` frame as text. */
function rawDataToText(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

/** The verbatim text frames one socket delivered since the tap was attached. */
interface WireTap {
  readonly frames: readonly string[];
}

/**
 * Taps a client's current socket for its verbatim inbound text, so envelope
 * integrity is asserted on the bytes the service wrote rather than on the
 * transcript the client already parsed.
 */
function tapWire(client: HarnessWsClient): WireTap {
  const socket = client.sockets[client.sockets.length - 1];
  if (socket === undefined) {
    throw new Error(`No socket to tap: ${client.describe()}`);
  }
  const frames: string[] = [];
  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      frames.push(rawDataToText(data));
    }
  });
  return { frames };
}

/** One connection's wire tap reduced to the defects the envelope audit fails on, plus two counts. */
interface WireAudit {
  /** How many text frames the tap saw. */
  readonly frames: number;
  /** The decode failure of every frame that is not a valid protocol envelope. */
  readonly undecodable: readonly string[];
  /** `type.key` for every top-level key outside the envelope's five. */
  readonly strayKeys: readonly string[];
  /** The id of every frame `decodeMessage` and `parseMessage` disagree about. */
  readonly disagreeing: readonly string[];
  /** Every envelope id the connection received more than once. */
  readonly duplicateIds: readonly string[];
  /** `type id` of every transcript message no wire frame carried. */
  readonly unrecorded: readonly string[];
  /** How many `session.updated` frames of the session the tap saw. */
  readonly updates: number;
  /** Every `session.updated` whose `ts` or record `updatedAt` went backwards. */
  readonly updateRegressions: readonly string[];
}

/**
 * Audits the verbatim frames one connection received against the envelope
 * contract: each is JSON that `parseMessage` accepts (and `decodeMessage`
 * reads identically) with no key outside `{ id, type, sessionId?, ts,
 * payload }`; no id repeats; every message the client recorded was on the
 * wire; and the session's `session.updated` stream never moves backwards in
 * either its envelope `ts` or its record's `updatedAt`.
 *
 * Monotonicity is audited on `session.updated` because that is the one stream
 * the service stamps from its injected clock at emission. Two other kinds of
 * frame make a global ordering over every frame a non-contract: a replay (on
 * `session.bind`, and on every `GET /sessions/:id`) re-sends stored progress
 * rows under the `ts` they were recorded with, and `error` replies,
 * `analysis.completed`, `panel.generated` and `telemetry.tail` take
 * `createEnvelope`'s wall-clock default rather than the injected clock.
 */
function auditWire(
  tap: WireTap,
  recorded: readonly ProtocolMessage[],
  sessionId: string,
): WireAudit {
  const undecodable: string[] = [];
  const strayKeys: string[] = [];
  const disagreeing: string[] = [];
  const messages: ProtocolMessage[] = [];

  for (const frame of tap.frames) {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch (cause) {
      undecodable.push(cause instanceof Error ? cause.message : String(cause));
      continue;
    }
    const parsed = parseMessage(value);
    if (isErr(parsed)) {
      undecodable.push(parsed.error.message);
      continue;
    }
    const decoded = decodeMessage(frame);
    if (isErr(decoded) || !isDeepStrictEqual(decoded.value, parsed.value)) {
      disagreeing.push(parsed.value.id);
    }
    for (const key of Object.keys(value as object)) {
      if (!ENVELOPE_KEYS.has(key)) {
        strayKeys.push(`${parsed.value.type}.${key}`);
      }
    }
    messages.push(parsed.value);
  }

  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) {
      duplicateIds.push(message.id);
    }
    seen.add(message.id);
  }
  const unrecorded = recorded
    .filter((message) => !seen.has(message.id))
    .map((message) => `${message.type} ${message.id}`);

  const updates = messages.filter(
    (message): message is MessageByType<typeof T.updated> =>
      isMessageOfType(message, T.updated) && sessionOf(message) === sessionId,
  );
  const updateRegressions: string[] = [];
  updates.forEach((update, index) => {
    const previous = updates[index - 1];
    if (
      previous !== undefined &&
      (update.ts < previous.ts ||
        update.payload.session.updatedAt < previous.payload.session.updatedAt)
    ) {
      updateRegressions.push(
        `#${String(index)}: ts ${String(previous.ts)} → ${String(update.ts)}, updatedAt ${String(
          previous.payload.session.updatedAt,
        )} → ${String(update.payload.session.updatedAt)}`,
      );
    }
  });

  return {
    frames: tap.frames.length,
    undecodable,
    strayKeys,
    disagreeing,
    duplicateIds,
    unrecorded,
    updates: updates.length,
    updateRegressions,
  };
}

/** What a malformed probe frame is built from, all minted fresh for the probe at run time. */
interface ProbeContext {
  /** A value no service path produces; its absence from the reply proves nothing was echoed. */
  readonly marker: string;
  /** A credential-shaped value assembled at run time, which must not be echoed either. */
  readonly secret: string;
  /**
   * The envelope id the reply's `ref` must name, where the frame's id is
   * readable. Minted with `newMessageId`, so it has the product's own spelling
   * ({@link MINTED_MESSAGE_ID}) — the only spelling the service echoes.
   */
  readonly id: string;
  /** A valid envelope timestamp. */
  readonly ts: number;
}

/** One malformed frame and what its `error` reply must reference. */
interface MalformedProbe {
  readonly name: string;
  /** Builds the frame — text by string concatenation or `JSON.stringify`, bytes as a `Uint8Array`. */
  readonly build: (context: ProbeContext) => string | Uint8Array;
  /**
   * Whether the frame's conforming id is readable, so the reply must carry it
   * as `ref`; otherwise the reply carries a ref the service minted instead.
   */
  readonly referenced: boolean;
}

/**
 * Every malformed frame the suite sends. Nothing here is a committed blob:
 * each frame is assembled when its test runs, around a fresh marker and a
 * `randomSecretLike` value.
 */
const MALFORMED_PROBES: readonly MalformedProbe[] = [
  {
    name: 'a text frame that is not JSON',
    build: ({ marker }) => `{"id":"${marker}"`,
    referenced: false,
  },
  {
    name: 'JSON that is not an object',
    build: ({ marker, secret }) => JSON.stringify([marker, secret]),
    referenced: false,
  },
  {
    name: 'an envelope without a type',
    build: ({ marker, secret, id, ts }) => JSON.stringify({ id, ts, payload: { marker, secret } }),
    referenced: true,
  },
  {
    name: 'an envelope with an unknown type',
    build: ({ marker, secret, id, ts }) =>
      JSON.stringify({ id, type: `${marker}.probe`, ts, payload: { secret } }),
    referenced: true,
  },
  ...HTTP_ONLY_PAYLOAD_NAMES.map((name): MalformedProbe => ({
    name: `the HTTP-only operation name ${name}`,
    build: ({ marker, secret, id, ts }) =>
      JSON.stringify({ id, type: name, ts, payload: { marker, secret } }),
    referenced: true,
  })),
  {
    name: 'an envelope whose payload fails its own schema',
    build: ({ marker, secret, id, ts }) =>
      JSON.stringify({ id, type: T.navigated, ts, payload: { tabId: marker, url: secret } }),
    referenced: true,
  },
  {
    name: 'an envelope with a wrong-typed ts',
    build: ({ marker, id }) =>
      JSON.stringify({ id, type: T.unbind, ts: marker, payload: { tabId: TAB.malformed } }),
    referenced: true,
  },
  {
    name: 'an oversized frame inside the transport ceiling',
    build: ({ marker, id, ts }) =>
      JSON.stringify({
        id,
        type: T.unbind,
        ts,
        payload: { tabId: TAB.malformed, pad: marker + 'x'.repeat(OVERSIZED_PADDING_BYTES) },
      }),
    referenced: true,
  },
  {
    name: 'a binary frame',
    build: ({ marker, secret, id, ts }) =>
      new Uint8Array(
        Buffer.from(
          JSON.stringify({
            id,
            type: T.unbind,
            ts,
            payload: { tabId: TAB.malformed, marker, secret },
          }),
          'utf8',
        ),
      ),
    referenced: false,
  },
];

/** A provider handle whose calls wait until the suite opens the gate. */
type Provider = ScriptedProvider['provider'];

/** A model provider that holds the pipeline at its first model call until {@link open} is called. */
interface PipelineGate {
  readonly provider: Provider;
  readonly open: () => void;
}

/**
 * Wraps the real deterministic provider (the scripted provider's fallback,
 * with no script) so every call first awaits a gate. Holding the pipeline at
 * its first stage is what lets a suite bind the DevTools tab **before** the
 * install stage broadcasts `instrumentation.plan`/`ready`/`failed`, so those
 * pushes deterministically reach both user interfaces. Nothing else changes:
 * once open, every call is the deterministic provider's own answer.
 */
function createPipelineGate(): PipelineGate {
  const base = createScriptedProvider([]).provider;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: Provider = {
    id: base.id,
    async generateText(request) {
      await gate;
      return base.generateText(request);
    },
    async generateStructured(schema, request) {
      await gate;
      return base.generateStructured(schema, request);
    },
    async callTools(request, tools) {
      await gate;
      return base.callTools(request, tools);
    },
  };
  return { provider, open: () => release() };
}

/**
 * Registers one harness per describe block, booted before its tests and
 * torn down after them with a leak audit, and returns its accessor.
 */
function useHarness(options: HarnessOptions = {}): () => Harness {
  let harness: Harness | undefined;
  beforeAll(async () => {
    harness = await startHarness(options);
  });
  afterAll(async () => {
    if (harness !== undefined) {
      await harness.assertNoLeaks();
    }
  });
  return () => {
    if (harness === undefined) {
      throw new Error('The harness did not start.');
    }
    return harness;
  };
}

/** Launches the stand-in dev server of the harness's project, which `session.create` requires. */
async function launchDevServer(harness: Harness): Promise<FixtureProjectCopy> {
  const project = harness.requireProject();
  unwrap(await harness.launchDevServer(project.root), 'devServer.launch');
  return project;
}

/** Opens a server-agent connection holding a credential scoped to `projectRoot`. */
function connectServerAgent(harness: Harness, projectRoot: string): Promise<HarnessWsClient> {
  return harness.ws({
    client: KIND.serverAgent,
    projectRoot,
    token: harness.issueServerAgentCredential(projectRoot).token,
  });
}

/**
 * Binds `client`'s tab to `session`, relays the page agent's `agent.ready`
 * for it and waits until the session is `ready` to capture.
 */
async function bindAndReady(
  harness: Harness,
  client: HarnessWsClient,
  tabId: number,
  session: SessionRecord,
): Promise<void> {
  const tab = tabOf(session);
  unwrap(
    await harness.bindTab(client, {
      tabId,
      url: tab.url,
      origin: tab.origin,
      sessionId: session.id,
    }),
    'binding the tab',
  );
  client.send(T.agentReady, agentReadyFor(tabId, tab.url));
  expect(await client.flush()).toBe(true);
  await harness.waitForSession(session.id, (record) => record.status === STATUS.ready);
}

/** Asserts that `client` received no `error` reply from `from` on. */
function expectNoErrors(client: HarnessWsClient, from = 0): void {
  expect(messagesOf(client, T.error, from).map((message) => message.payload)).toEqual([]);
}

/* -------------------------------------------------------------------------------------------------
 * 1. The vocabulary
 * ---------------------------------------------------------------------------------------------- */

describe('the protocol vocabulary this suite classifies', () => {
  it('names every message type and client kind protocol defines, once each', () => {
    expect(VOCABULARY_PROOFS).toEqual([true, true]);
    expect(Object.values(T)).toHaveLength(MESSAGE_TYPES.length);
    expect(new Set(Object.values(T))).toEqual(new Set(MESSAGE_TYPES));
    expect(new Set(Object.keys(ROUTES))).toEqual(new Set(MESSAGE_TYPES));
    expect(Object.values(KIND)).toHaveLength(CLIENT_KINDS.length);
    expect(new Set(Object.values(KIND))).toEqual(new Set(CLIENT_KINDS));
  });

  it('keeps the HTTP-only operation names out of the WebSocket vocabulary', () => {
    const wsTypes: ReadonlySet<string> = new Set(MESSAGE_TYPES);
    expect(HTTP_ONLY_PAYLOAD_NAMES.length).toBeGreaterThan(0);
    expect(HTTP_ONLY_PAYLOAD_NAMES.filter((name) => wsTypes.has(name))).toEqual([]);
  });

  it('waits only for statuses, reasons, stages and tiers protocol defines', () => {
    expect(SESSION_STATUSES).toEqual(expect.arrayContaining(Object.values(STATUS)));
    expect(BINDING_REASONS).toEqual(expect.arrayContaining(Object.values(REASON)));
    expect(PROGRESS_STAGES).toContain(INSTRUMENT_STAGE);
    expect(PROGRESS_STATUSES).toEqual(expect.arrayContaining([ROW_DONE, ROW_FAILED]));
    expect(TELEMETRY_TIERS).toContain(BROWSER_TIER);
  });

  it('partitions the vocabulary into inbound types, service-only pushes and the sender-only replies', () => {
    expect(REPLY_ONLY_TYPES).toEqual([T.pong, T.error]);
    const classified = [...INBOUND_TYPES, ...SERVICE_ONLY_TYPES, ...REPLY_ONLY_TYPES];
    expect(classified).toHaveLength(MESSAGE_TYPES.length);
    expect(new Set(classified)).toEqual(new Set(MESSAGE_TYPES));
    expect(
      Object.keys(REQUIRED_FACETS).filter((type) => !INBOUND_TYPES.some((t) => t === type)),
    ).toEqual([]);
  });

  it('dispatches exactly the ten inbound kinds, so neither sender-only reply is ever inbound', () => {
    // The eight specified client-to-service kinds, plus `source.result` — the
    // editor's answer to a forwarded `source.open`, which the service relays to
    // that `source.open`'s sender alone — and `client.ping`, the liveness probe
    // any authenticated connection may send.
    const specified: readonly MessageType[] = [
      T.hello,
      T.ping,
      T.agentReady,
      T.bind,
      T.navigated,
      T.unbind,
      T.telemetry,
      T.sourceOpen,
      T.sourceResult,
      T.targetSelected,
    ];
    expect(INBOUND_TYPES).toHaveLength(specified.length);
    expect(new Set(INBOUND_TYPES)).toEqual(new Set(specified));
    expect(INBOUND_TYPES).not.toContain(T.error);
    expect(INBOUND_TYPES).not.toContain(T.pong);
  });

  it('routes nothing to the page-agent kind and requires no kind a route may not reach', () => {
    // The agent owns no socket; its frames ride the bound tab's DevTools connection.
    expect(PUSHED_TYPES.filter((type) => allowedKinds(type).includes(KIND.agent))).toEqual([]);
    const overreach = MESSAGE_TYPES.flatMap((type) =>
      routeOf(type)
        .mustReach.filter((kind) => !allowedKinds(type).includes(kind))
        .map((kind) => `${type} → ${kind}`),
    );
    expect(overreach).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 2. Routing across a live multi-client topology
 * ---------------------------------------------------------------------------------------------- */

describe('routing across a live multi-client topology', () => {
  // Held at the first model call, so the DevTools tab binds before the install
  // stage broadcasts: every interface push of the lifecycle then reaches both.
  const gate = createPipelineGate();
  const harness = useHarness({ provider: gate.provider });

  let project: FixtureProjectCopy;
  let editor: HarnessWsClient;
  let devtools: HarnessWsClient;
  let devtoolsCredential: DevtoolsCredential;
  let idleDevtools: HarnessWsClient;
  let serverAgent: HarnessWsClient;
  let foreignEditor: HarnessWsClient;
  let foreignServerAgent: HarnessWsClient;
  let session: SessionRecord;
  let captureId: string;
  /** The wire tap of each audited connection, with its transcript length when the tap began. */
  const wire = new Map<HarnessWsClient, { readonly tap: WireTap; readonly from: number }>();

  beforeAll(async () => {
    const h = harness();
    project = await launchDevServer(h);
    editor = await h.editor(project.root);
    const bound = await h.connectDevtools({ tabId: TAB.bound });
    devtools = bound.client;
    devtoolsCredential = bound.credential;
    idleDevtools = (await h.connectDevtools({ tabId: TAB.unbound })).client;
    serverAgent = await connectServerAgent(h, project.root);
    // A second project, with its own editor and server agent: neither may hear
    // anything about a session of the first.
    const foreign = await h.copyFixtureProject();
    foreignEditor = await h.editor(foreign.root);
    foreignServerAgent = await connectServerAgent(h, foreign.root);
    for (const client of [editor, devtools, serverAgent]) {
      wire.set(client, { tap: tapWire(client), from: client.received.length });
    }
  });

  it('authenticates every kind that owns a socket and refuses a page-agent hello', async () => {
    const h = harness();
    for (const client of [
      editor,
      devtools,
      idleDevtools,
      serverAgent,
      foreignEditor,
      foreignServerAgent,
    ]) {
      expect(client.authenticated, client.describe()).toBe(true);
    }

    // The page agent has no credential of its own: a hello claiming the agent
    // kind is refused even with a valid DevTools credential from its origin.
    const agent = await h.ws({
      client: KIND.agent,
      tabId: TAB.bound,
      token: devtoolsCredential.token,
      origin: devtoolsCredential.origin,
      awaitAuthentication: false,
    });
    const refusal = await agent.waitForClose(HARNESS_TIMEOUTS.message);
    expect(isUnauthorizedClose(refusal), agent.describe()).toBe(true);
    expect(agent.received).toEqual([]);
    await agent.close();
  });

  it('answers client.ping from the editor, the DevTools worker and the server agent with one service.pong to that sender alone', async () => {
    const listeners = Object.freeze({
      editor,
      devtools,
      idleDevtools,
      serverAgent,
      foreignEditor,
      foreignServerAgent,
    });
    const labelled = Object.entries(listeners);
    const senders = [
      ['editor', editor],
      ['devtools', devtools],
      ['serverAgent', serverAgent],
    ] as const;

    for (const [label, sender] of senders) {
      const from = new Map(
        labelled.map(([, client]): [HarnessWsClient, number] => [client, client.received.length]),
      );
      const closes = sender.closes.length;

      const ping = sender.send(T.ping, {});
      expect(isErr(ping.result), `${label} wrote its ping`).toBe(false);
      // Every connection has drained what the service wrote before its
      // barrier, the pong included: a ping is answered on arrival, so its pong
      // precedes the reply to the barrier frame written after it.
      for (const [, client] of labelled) {
        expect(await client.flush(), client.describe()).toBe(true);
      }

      const pongs = messagesOf(sender, T.pong, from.get(sender) ?? 0);
      expect(
        pongs.map((pong) => pong.payload),
        `${label}'s pong`,
      ).toEqual([{ ref: ping.id }]);
      // Session-less, so it names nothing about any session.
      expect(Object.hasOwn(pongs[0] ?? {}, 'sessionId'), `${label}'s pong`).toBe(false);
      expect(sender.errorsFor(ping.id), `${label}'s ping was refused`).toEqual([]);

      // The pong is the ping's whole effect: the sender heard nothing else, and
      // no other connection — the unbound tab, the other project's editor and
      // server agent included — heard anything at all.
      expect(
        Object.fromEntries(
          labelled.map(([other, client]) => [
            other,
            client.received.slice(from.get(client) ?? 0).map((message) => message.type),
          ]),
        ),
        `after ${label}'s ping`,
      ).toEqual(
        Object.fromEntries(
          labelled.map(([other, client]) => [other, client === sender ? [T.pong] : []]),
        ),
      );
      expect(sender.closes, sender.describe()).toHaveLength(closes);
    }
    proveInbound(T.ping);
  });

  it('announces session.create to the project’s editor, which the hello registered', async () => {
    const h = harness();
    session = await h.createSession({ projectRoot: project.root, question: QUESTION });
    const created = await waitForSessionMessage(editor, T.created, session.id);
    expect(created.payload.session.question).toBe(QUESTION);
    // A session-scoped push found the connection: its hello registered it.
    proveInbound(T.hello, 'registered');
  });

  it('answers session.bind with session.bound on both interfaces and records the binding', async () => {
    const h = harness();
    const tab = tabOf(session);
    const editorFrom = editor.received.length;
    const bound = unwrap(
      await h.bindTab(devtools, {
        tabId: TAB.bound,
        url: tab.url,
        origin: tab.origin,
        sessionId: session.id,
      }),
      'binding the tab',
    );
    expect(bound.payload).toEqual({
      sessionId: session.id,
      tabId: TAB.bound,
      url: tab.url,
      reason: REASON.bound,
    });
    await waitForSessionMessage(editor, T.bound, session.id, editorFrom, (message) =>
      isDeepStrictEqual(message.payload, bound.payload),
    );
    const binding = unwrap(h.repos.sessions.getBindingBySession(session.id), 'binding lookup');
    expect(binding?.tab).toEqual({ tabId: TAB.bound, url: tab.url });
    proveInbound(T.bind);
  });

  it('relays agent.ready into readiness, so the released pipeline reaches ready', async () => {
    const h = harness();
    const editorFrom = editor.received.length;
    const devtoolsFrom = devtools.received.length;
    const receipt = devtools.send(T.agentReady, agentReadyFor(TAB.bound, tabOf(session).url));
    expect(await devtools.flush()).toBe(true);
    expect(devtools.errorsFor(receipt.id)).toEqual([]);

    gate.open();
    await h.waitForSession(session.id, (record) => record.status === STATUS.ready);

    // The readiness rows reach both interfaces as ✓ rows; a session no tab is
    // bound to gets waiting rows that name what is missing (the
    // absent-recipient suite below), never ✗ rows.
    for (const [client, from] of [
      [editor, editorFrom],
      [devtools, devtoolsFrom],
    ] as const) {
      await waitForSessionMessage(
        client,
        T.progress,
        session.id,
        from,
        (message) =>
          message.payload.stage === INSTRUMENT_STAGE && message.payload.status === ROW_DONE,
      );
      const failedRows = messagesOf(client, T.progress, from)
        .filter(
          (message) =>
            message.payload.sessionId === session.id &&
            message.payload.stage === INSTRUMENT_STAGE &&
            message.payload.status === ROW_FAILED,
        )
        .map((message) => message.payload.message);
      expect(failedRows).toEqual([]);
    }
    proveInbound(T.agentReady);
  });

  it('records target.selected sent as a createEnvelope frame that round-trips through the codec', async () => {
    const h = harness();
    const marker = newMarker();
    const frame = createEnvelope(T.targetSelected, {
      sessionId: session.id,
      target: selectedTarget(tabOf(session).url, marker),
    });
    expect(frame.sessionId).toBe(session.id);
    expect(unwrap(decodeMessage(encodeMessage(frame)), 'decodeMessage')).toEqual(frame);

    devtools.sendRaw(encodeMessage(frame));
    expect(await devtools.flush()).toBe(true);
    expect(devtools.errorsFor(frame.id)).toEqual([]);
    const record = await h.waitForSession(
      session.id,
      (candidate) => candidate.target?.selector.includes(marker) === true,
    );
    expect(record.target).toEqual(frame.payload.target);
    proveInbound(T.targetSelected);
  });

  it('pushes the editor’s target.request to the bound DevTools tab alone, as a frame the service built', async () => {
    const h = harness();
    const listeners = Object.freeze({
      editor,
      devtools,
      idleDevtools,
      serverAgent,
      foreignEditor,
      foreignServerAgent,
    });
    const labelled = Object.entries(listeners);
    const from = new Map(
      labelled.map(([, client]): [HarnessWsClient, number] => [client, client.received.length]),
    );
    const tap = wire.get(devtools)?.tap;
    expect(tap, 'the bound DevTools connection is tapped').toBeDefined();

    // Only the editor may ask: the bound tab's own credential is refused …
    expect(refusalOf(await requestTarget(h, session.id, devtoolsCredential))).toEqual({
      code: CODE.unauthorized,
      status: HTTP_FORBIDDEN,
    });
    // … and so is a body that names a tab: the binding, not the caller, picks the recipient.
    const namingATab = await h.rawFetch(
      { operation: TARGET_REQUEST_OPERATION, params: { id: session.id } },
      { body: { tabId: TAB.unbound } },
    );
    expect(namingATab.status).toBe(HTTP_BAD_REQUEST);
    expect(namingATab.json).toMatchObject({ code: CODE.invalidMessage });

    const reply = unwrap(await requestTarget(h, session.id), 'requesting a target');
    expect(reply).toEqual({ sessionId: session.id, tabId: TAB.bound });

    const pushed = await waitForSessionMessage(
      devtools,
      T.targetRequest,
      session.id,
      from.get(devtools),
      () => true,
      HARNESS_TIMEOUTS.message,
    );
    expect(pushed.sessionId).toBe(session.id);
    expect(pushed.payload).toEqual({ sessionId: session.id });
    expect(wireFrameWithId(tap!, pushed.id)).toEqual({
      id: pushed.id,
      type: T.targetRequest,
      sessionId: session.id,
      ts: pushed.ts,
      payload: { sessionId: session.id },
    });

    // Every connection has drained what the service wrote before the reply:
    // exactly one frame reached the bound tab, and none reached anyone else.
    for (const [, client] of labelled) {
      expect(await client.flush(), client.describe()).toBe(true);
    }
    expect(
      Object.fromEntries(
        labelled.map(([label, client]) => [
          label,
          messagesOf(client, T.targetRequest, from.get(client)).length,
        ]),
      ),
    ).toEqual({
      editor: 0,
      devtools: 1,
      idleDevtools: 0,
      serverAgent: 0,
      foreignEditor: 0,
      foreignServerAgent: 0,
    });
  });

  it('forwards source.open from the bound DevTools tab to the project’s editor alone', async () => {
    const h = harness();
    const record = await fetchSession(h, session.id);
    const file = record.relevantFiles[0]?.file;
    expect(file, 'the investigation found no relevant file to link to').toBeDefined();
    const location: SourceLocation = {
      file: file!,
      line: 1,
      column: 1,
      resolvedBy: PROBE_RESOLVED_BY,
      confidence: 0.5,
    };
    const editorFrom = editor.received.length;
    const receipt = devtools.send(T.sourceOpen, { sessionId: session.id, location });
    expect(await devtools.flush()).toBe(true);
    expect(devtools.errorsFor(receipt.id)).toEqual([]);

    const forwarded = await waitForSessionMessage(editor, T.sourceOpen, session.id, editorFrom);
    expect(forwarded.payload.location).toMatchObject({ file: location.file, line: 1, column: 1 });
    for (const other of [devtools, idleDevtools, serverAgent, foreignEditor, foreignServerAgent]) {
      expect(messagesOf(other, T.sourceOpen), other.describe()).toEqual([]);
    }
    proveInbound(T.sourceOpen);

    // The editor's answer to the forwarded frame reaches the sender alone, under
    // the sender's own frame id.
    const answer = editor.send(T.sourceResult, {
      sessionId: session.id,
      ref: forwarded.id,
      status: 'opened',
    });
    expect(await editor.flush()).toBe(true);
    expect(editor.errorsFor(answer.id)).toEqual([]);
    const relayed = await waitForSessionMessage(
      devtools,
      T.sourceResult,
      session.id,
      0,
      (message) => message.payload.ref === receipt.id,
      HARNESS_TIMEOUTS.message,
    );
    expect(relayed.payload).toEqual({ sessionId: session.id, ref: receipt.id, status: 'opened' });
    for (const other of [editor, idleDevtools, serverAgent, foreignEditor, foreignServerAgent]) {
      expect(messagesOf(other, T.sourceResult), other.describe()).toEqual([]);
    }
    proveInbound(T.sourceResult);
  });

  it('keeps the binding across a same-origin tab.navigated and announces the new URL', async () => {
    const h = harness();
    const url = new URL(`/${newMarker()}`, tabOf(session).origin).toString();
    const editorFrom = editor.received.length;
    const devtoolsFrom = devtools.received.length;
    const receipt = devtools.send(T.navigated, { tabId: TAB.bound, url });
    // Announced as the binding now stands: the navigation alone cannot tell a
    // reload from a same-document URL change, and only a new page-agent
    // document reported after it is announced as `navigated`.
    for (const [client, from] of [
      [editor, editorFrom],
      [devtools, devtoolsFrom],
    ] as const) {
      await waitForSessionMessage(
        client,
        T.bound,
        session.id,
        from,
        (message) => message.payload.reason === REASON.bound && message.payload.url === url,
      );
    }
    expect(devtools.errorsFor(receipt.id)).toEqual([]);
    const binding = unwrap(h.repos.sessions.getBindingBySession(session.id), 'binding lookup');
    expect(binding?.tab).toEqual({ tabId: TAB.bound, url });
    expect((await fetchSession(h, session.id)).status).toBe(STATUS.ready);
    proveInbound(T.navigated, 'same-origin');
  });

  it('fans capture.start out to both interfaces and arms the bound tab and the project’s server agent', async () => {
    const h = harness();
    const editorFrom = editor.received.length;
    const devtoolsFrom = devtools.received.length;
    const serverAgentFrom = serverAgent.received.length;
    captureId = unwrap(await h.startCapture(session.id), 'starting the capture').captureId;

    for (const [client, from] of [
      [editor, editorFrom],
      [devtools, devtoolsFrom],
    ] as const) {
      await waitForSessionMessage(
        client,
        T.captureStarted,
        session.id,
        from,
        (message) => message.payload.captureId === captureId,
      );
    }
    await waitForSessionMessage(
      devtools,
      T.agentConfig,
      session.id,
      devtoolsFrom,
      (message) => message.payload.captureId === captureId,
    );
    await waitFor(
      serverAgent,
      T.serverAgentConfig,
      (message, index) => index >= serverAgentFrom && message.payload.captureId === captureId,
      HARNESS_TIMEOUTS.pipeline,
    );
  });

  it('persists a relayed telemetry.event batch and tails it to the bound DevTools tab alone', async () => {
    const h = harness();
    const before = unwrap(h.repos.telemetry.countBySession(session.id), 'telemetry count');
    const events = browserEvents(3);
    const outcome = await h.ingestFromAgent(devtools, events);
    expect(outcome.settled).toBe(true);
    expect(outcome.errors).toEqual([]);
    expect(unwrap(h.repos.telemetry.countBySession(session.id), 'telemetry count')).toBe(
      before + events.length,
    );

    const ids: ReadonlySet<string> = new Set(events.map((event) => event.id));
    await waitForSessionMessage(devtools, T.tail, session.id, 0, (message) =>
      message.payload.events.some((event) => ids.has(event.id)),
    );
    proveInbound(T.telemetry);
  });

  it('fans capture.stop, the analysis and the generated panel out to both interfaces', async () => {
    const h = harness();
    const editorFrom = editor.received.length;
    const devtoolsFrom = devtools.received.length;
    unwrap(await h.stopCapture(session.id), 'stopping the capture');
    await h.waitForSession(session.id, (record) => record.status === STATUS.generated);

    for (const [client, from] of [
      [editor, editorFrom],
      [devtools, devtoolsFrom],
    ] as const) {
      await waitForSessionMessage(
        client,
        T.captureStopped,
        session.id,
        from,
        (message) => message.payload.captureId === captureId,
      );
      await waitForSessionMessage(client, T.analysis, session.id, from);
      await waitForSessionMessage(client, T.panel, session.id, from);
    }
  });

  it('announces cleanup.completed to both interfaces when session.end runs cleanup', async () => {
    const h = harness();
    const editorFrom = editor.received.length;
    const devtoolsFrom = devtools.received.length;
    unwrap(await h.endSession(session.id), 'ending the session');
    for (const [client, from] of [
      [editor, editorFrom],
      [devtools, devtoolsFrom],
    ] as const) {
      await waitForSessionMessage(client, T.cleanup, session.id, from);
    }
    await h.waitForSession(session.id, (record) => record.status === STATUS.ended);
  });

  it('delivered every push to exactly the kinds AAP §0.4.2 names, and to no other connection', () => {
    // A kind a route must reach received the type; a kind outside the route
    // never did; a kind the route allows but this drive cannot reach may go
    // either way (see `MessageRoute.mustReach`).
    const eitherWay: unknown = expect.any(Boolean);
    const monitored = [
      [KIND.editor, editor],
      [KIND.devtools, devtools],
      [KIND.serverAgent, serverAgent],
    ] as const;
    const delivered = Object.fromEntries(
      PUSHED_TYPES.map((type) => [
        type,
        Object.fromEntries(
          monitored.map(([kind, client]) => [kind, messagesOf(client, type).length > 0]),
        ),
      ]),
    );
    const expected = Object.fromEntries(
      PUSHED_TYPES.map((type) => [
        type,
        Object.fromEntries(
          monitored.map(([kind]) => [
            kind,
            routeOf(type).mustReach.includes(kind)
              ? true
              : allowedKinds(type).includes(kind)
                ? eitherWay
                : false,
          ]),
        ),
      ]),
    );
    expect(delivered).toEqual(expected);

    // The unbound tab and the other project's clients heard nothing at all.
    expect({
      idleDevtools: idleDevtools.received.map((message) => message.type),
      foreignEditor: foreignEditor.received.map((message) => message.type),
      foreignServerAgent: foreignServerAgent.received.map((message) => message.type),
    }).toEqual({ idleDevtools: [], foreignEditor: [], foreignServerAgent: [] });

    // No frame of the drive was refused anywhere.
    for (const [, client] of monitored) {
      expectNoErrors(client);
    }
  });

  it('wrote every frame as a well-formed envelope that decodes to what each client recorded', () => {
    for (const [client, { tap, from }] of wire) {
      const audit = auditWire(tap, client.received.slice(from), session.id);
      expect(audit, client.describe()).toMatchObject({
        undecodable: [],
        strayKeys: [],
        disagreeing: [],
        duplicateIds: [],
        unrecorded: [],
        updateRegressions: [],
      });
      expect(audit.frames).toBeGreaterThan(0);
    }
    for (const client of [editor, devtools]) {
      const entry = wire.get(client);
      expect(entry).toBeDefined();
      expect(auditWire(entry!.tap, [], session.id).updates).toBeGreaterThan(1);
    }
  });

  it('refuses every service push a client sends back, and a second hello, on connections that stay open', async () => {
    const h = harness();
    const serviceOnly: ReadonlySet<MessageType> = new Set(SERVICE_ONLY_TYPES);

    // Each push the drive delivered, echoed by the connection that received it
    // under a fresh id: valid by construction, so only its direction is wrong.
    // That includes the `target.request` the editor's route made the service
    // push to the bound tab: a panel may not put another panel into picker mode.
    const echoes = new Map<
      MessageType,
      { readonly client: HarnessWsClient; readonly frame: ProtocolMessage }
    >();
    for (const client of [editor, devtools, serverAgent]) {
      for (const message of client.received) {
        if (serviceOnly.has(message.type) && !echoes.has(message.type)) {
          echoes.set(message.type, { client, frame: { ...message, id: newMessageId() } });
        }
      }
    }
    // Everything but the failed install (its own suite below) was observed on the wire.
    expect(SERVICE_ONLY_TYPES.filter((type) => !echoes.has(type))).toEqual([T.failed]);
    expect(echoes.get(T.targetRequest)?.client).toBe(devtools);

    const closesBefore = new Map(
      [editor, devtools, serverAgent].map((client): [HarnessWsClient, number] => [
        client,
        client.closes.length,
      ]),
    );
    for (const { client, frame } of echoes.values()) {
      client.sendRaw(encodeMessage(frame));
    }
    for (const client of [editor, devtools, serverAgent]) {
      expect(await client.flush(), client.describe()).toBe(true);
    }
    for (const [type, { client, frame }] of echoes) {
      expect(
        client.errorsFor(frame.id).map((error) => error.code),
        `${type} echoed by ${client.identity.client}`,
      ).toEqual([CODE.invalidMessage]);
      proved.refusedWhenSentByClient.add(type);
    }

    // A second hello on an authenticated connection is not a re-authentication.
    const hello = createEnvelope(T.hello, {
      client: KIND.editor,
      projectRoot: project.root,
      version: PROTOCOL_VERSION,
      token: h.editorToken,
    });
    editor.sendRaw(encodeMessage(hello));
    expect(await editor.flush()).toBe(true);
    const helloErrors = editor.errorsFor(hello.id);
    expect(helloErrors.map((error) => error.code)).toEqual([CODE.invalidMessage]);
    expect(JSON.stringify(helloErrors)).not.toContain(h.editorToken);
    proveInbound(T.hello, 'second-hello-refused');

    for (const [client, closes] of closesBefore) {
      expect(client.closes, client.describe()).toHaveLength(closes);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * 3. A single-recipient push whose recipient is absent
 * ---------------------------------------------------------------------------------------------- */

/** The code and HTTP status of a refused call, or `'accepted'` when it was not refused. */
function refusalOf<V>(
  result: Result<
    V,
    { readonly code: string; readonly details?: Readonly<Record<string, unknown>> }
  >,
): { readonly code: string; readonly status: unknown } | 'accepted' {
  return isErr(result)
    ? { code: result.error.code, status: result.error.details?.['status'] }
    : 'accepted';
}

describe('a single-recipient push whose recipient is absent', () => {
  const harness = useHarness();

  let project: FixtureProjectCopy;
  let editor: HarnessWsClient;
  let devtools: HarnessWsClient;

  beforeAll(async () => {
    const h = harness();
    project = await launchDevServer(h);
    editor = await h.editor(project.root);
    devtools = (await h.connectDevtools({ tabId: TAB.absent })).client;
    await connectServerAgent(h, project.root);
  });

  it('arms no page agent for a session no tab is bound to, and names what is missing', async () => {
    const h = harness();
    const session = await h.createSession({ projectRoot: project.root, question: QUESTION });

    // The readiness gate answers the missing tab with waiting rows that say
    // what to do — open the panel on the application's tab — rather than
    // holding the session silently, and never presents the wait as a failure.
    const waitingRow = await waitForSessionMessage(
      editor,
      T.progress,
      session.id,
      0,
      (message) =>
        message.payload.stage === INSTRUMENT_STAGE &&
        message.payload.status === ROW_RUNNING &&
        (message.payload.detail ?? '').includes('"Debug Generator" panel'),
    );
    expect(waitingRow.payload.message.length).toBeGreaterThan(0);
    expect(waitingRow.payload.detail).toMatch(
      /^Waiting: no Chrome tab is bound to this session\./u,
    );
    expect((await fetchSession(h, session.id)).status).toBe(STATUS.instrumenting);
    expect(
      messagesOf(editor, T.progress).filter(
        (message) =>
          message.payload.sessionId === session.id &&
          message.payload.stage === INSTRUMENT_STAGE &&
          message.payload.status === ROW_FAILED &&
          message.payload.message.startsWith(`Could not enable ${waitingRow.payload.message}`),
      ),
    ).toEqual([]);

    // A capture cannot be armed: the refusal is typed and named, not a drop.
    expect(refusalOf(await h.startCapture(session.id))).toEqual({
      code: CODE.invalidState,
      status: HTTP_CONFLICT,
    });
    expect(messagesOf(devtools, T.agentConfig)).toEqual([]);
    expect(devtools.received.filter((message) => sessionOf(message) === session.id)).toEqual([]);
    expectNoErrors(devtools);
    unwrap(await h.endSession(session.id), 'ending the session');
  });

  it('refuses capture.start with a named TAB_NOT_BOUND conflict once the bound tab is released', async () => {
    const h = harness();
    const session = await h.createSession({ projectRoot: project.root, question: QUESTION });
    await bindAndReady(h, devtools, TAB.absent, session);

    const unbindFrom = devtools.received.length;
    const receipt = devtools.send(T.unbind, { tabId: TAB.absent });
    await waitForSessionMessage(
      devtools,
      T.bound,
      session.id,
      unbindFrom,
      (message) => message.payload.reason === REASON.unbound,
    );
    expect(devtools.errorsFor(receipt.id)).toEqual([]);

    const devtoolsFrom = devtools.received.length;
    const editorFrom = editor.received.length;
    expect(refusalOf(await h.startCapture(session.id))).toEqual({
      code: CODE.tabNotBound,
      status: HTTP_CONFLICT,
    });
    expect(devtools.received.slice(devtoolsFrom).map((message) => message.type)).not.toContain(
      T.agentConfig,
    );
    expect(messagesOf(editor, T.captureStarted, editorFrom)).toEqual([]);
    expect((await fetchSession(h, session.id)).status).toBe(STATUS.ready);
    unwrap(await h.endSession(session.id), 'ending the session');
  });

  it('refuses target.request with a named TAB_NOT_BOUND conflict when no tab is bound, sending nothing', async () => {
    const h = harness();
    const session = await h.createSession({ projectRoot: project.root, question: QUESTION });
    const devtoolsFrom = devtools.received.length;

    // The DevTools client is connected, but no tab is bound to this session.
    expect(refusalOf(await requestTarget(h, session.id))).toEqual({
      code: CODE.tabNotBound,
      status: HTTP_CONFLICT,
    });
    expect(await devtools.flush()).toBe(true);
    expect(messagesOf(devtools, T.targetRequest, devtoolsFrom)).toEqual([]);
    expectNoErrors(devtools, devtoolsFrom);

    // An ended session takes no element at all: its state is refused first.
    unwrap(await h.endSession(session.id), 'ending the session');
    expect(refusalOf(await requestTarget(h, session.id))).toEqual({
      code: CODE.invalidState,
      status: HTTP_CONFLICT,
    });
    expect(messagesOf(devtools, T.targetRequest, devtoolsFrom)).toEqual([]);
  });

  it('answers target.request with TRANSPORT_DISCONNECTED while the bound tab’s connection is offline, and pushes it once it is back', async () => {
    const h = harness();
    const session = await h.createSession({ projectRoot: project.root, question: QUESTION });
    const offline = await h.connectDevtools({ tabId: TAB.offline });
    const tab = tabOf(session);
    unwrap(
      await h.bindTab(offline.client, {
        tabId: TAB.offline,
        url: tab.url,
        origin: tab.origin,
        sessionId: session.id,
      }),
      'binding the tab',
    );

    const logFrom = h.logger.records.length;
    await offline.client.close();
    await waitUntil(
      () =>
        h.logger.records
          .slice(logFrom)
          .find(
            (record) =>
              record.message === CLIENT_OFFLINE_LOG && record.fields['tabId'] === TAB.offline,
          ),
      'the registry marking the closed DevTools connection offline',
    );
    expect(refusalOf(await requestTarget(h, session.id))).toEqual({
      code: CODE.transportDisconnected,
      status: HTTP_UNAVAILABLE,
    });

    // The binding belongs to the credential: its reconnected tab is the recipient again.
    const back = (await h.connectDevtools({ tabId: TAB.offline, credential: offline.credential }))
      .client;
    const from = back.received.length;
    expect(unwrap(await requestTarget(h, session.id), 'requesting a target')).toEqual({
      sessionId: session.id,
      tabId: TAB.offline,
    });
    const pushed = await waitForSessionMessage(
      back,
      T.targetRequest,
      session.id,
      from,
      () => true,
      HARNESS_TIMEOUTS.message,
    );
    expect(pushed.payload).toEqual({ sessionId: session.id });
    expect(offline.client.received.filter((message) => message.id === pushed.id)).toEqual([]);
    expect(messagesOf(devtools, T.targetRequest)).toEqual([]);

    unwrap(await h.endSession(session.id), 'ending the session');
    await back.close();
  });
});

/* -------------------------------------------------------------------------------------------------
 * 4. Malformed input on a live connection
 * ---------------------------------------------------------------------------------------------- */

describe('malformed input on a live connection', () => {
  const harness = useHarness();

  let editor: HarnessWsClient;
  let devtools: HarnessWsClient;
  let session: SessionRecord;

  beforeAll(async () => {
    const h = harness();
    const project = await launchDevServer(h);
    editor = await h.editor(project.root);
    devtools = (await h.connectDevtools({ tabId: TAB.malformed })).client;
    await connectServerAgent(h, project.root);
    session = await h.createSession({ projectRoot: project.root, question: QUESTION });
    await bindAndReady(h, devtools, TAB.malformed, session);
    unwrap(await h.startCapture(session.id), 'starting the capture');
  });

  it.each(MALFORMED_PROBES)(
    'answers $name with an error on a connection that stays open and a service that stays healthy',
    async (probe) => {
      const h = harness();
      const context: ProbeContext = {
        marker: newMarker(),
        secret: randomSecretLike('bearer'),
        id: newMessageId(),
        ts: h.now(),
      };
      const from = devtools.received.length;
      const closes = devtools.closes.length;
      const logFrom = h.logger.records.length;

      devtools.sendRaw(probe.build(context));
      // The barrier behind the probe is a valid frame: its answer proves the
      // connection is open and still served after the probe was handled.
      expect(await devtools.flush(), devtools.describe()).toBe(true);

      const replies: readonly ErrorPayload[] = messagesOf(devtools, T.error, from).map(
        (message) => message.payload,
      );
      expect(replies).toHaveLength(1);
      const [reply] = replies;
      expect(errorPayloadSchema.safeParse(reply).success).toBe(true);
      expect(reply?.code).toBe(CODE.invalidMessage);
      expect(reply?.message.length).toBeGreaterThan(0);
      const text = JSON.stringify(reply);
      expect(text).not.toContain(context.marker);
      expect(text).not.toContain(context.secret);

      // Every reply carries a ref in the product's own message-id spelling:
      // the frame's own (conforming) id where it was readable, and a ref the
      // service minted where it was not — never nothing.
      const ref = reply?.ref ?? '';
      expect(ref, 'the reply carries a ref the service may file').toMatch(MINTED_MESSAGE_ID);
      expect(ref === context.id, 'the ref is the frame’s id exactly when it was readable').toBe(
        probe.referenced,
      );
      // That ref names the service's one record of this refusal, which quotes
      // nothing the frame carried.
      const records = wsRecordsFor(h, ref, logFrom);
      expect(records.map((record) => record.fields['code'])).toEqual([reply?.code]);
      expect(records[0]?.line).not.toContain(context.marker);
      expect(records[0]?.line).not.toContain(context.secret);

      expect(devtools.closes).toHaveLength(closes);
      expect((await h.rawFetch('health')).status).toBe(HTTP_OK);
    },
  );

  it('answers every refusal to its sender alone', () => {
    expect(messagesOf(devtools, T.error).length).toBeGreaterThanOrEqual(MALFORMED_PROBES.length);
    expectNoErrors(editor);
  });

  it('refuses an error frame a client sends with one error naming it, on a connection that stays open', async () => {
    // A well-formed `error` frame built by protocol's own constructor and
    // carrying a fresh marker: valid by construction, so only its direction is
    // wrong — and independent of what any earlier case in this block sent.
    const marker = newMarker();
    const frame = createEnvelope(T.error, { code: CODE.invalidMessage, message: marker });
    const from = devtools.received.length;
    const closes = devtools.closes.length;

    devtools.sendRaw(encodeMessage(frame));
    expect(await devtools.flush(), devtools.describe()).toBe(true);

    const replies: readonly ErrorPayload[] = messagesOf(devtools, T.error, from).map(
      (message) => message.payload,
    );
    expect(replies).toHaveLength(1);
    const [reply] = replies;
    expect(errorPayloadSchema.safeParse(reply).success).toBe(true);
    expect(reply?.code).toBe(CODE.invalidMessage);
    expect(reply?.ref).toBe(frame.id);
    expect(JSON.stringify(reply)).not.toContain(marker);

    // No cascade, and the connection is still served: a later barrier is
    // answered with nothing further behind the one reply, and only the
    // sender heard it.
    expect(await devtools.flush(), devtools.describe()).toBe(true);
    expect(messagesOf(devtools, T.error, from)).toHaveLength(1);
    expect(devtools.closes).toHaveLength(closes);
    expectNoErrors(editor);
    proved.clientErrorFrameRefused = true;
  });

  it('refuses a service.pong a client sends back with one error naming it, on a connection that stays open', async () => {
    // A pong the service really sent this connection, echoed under a fresh id:
    // valid by construction, so only its direction is wrong.
    const pongFrom = devtools.received.length;
    const ping = devtools.send(T.ping, {});
    expect(await devtools.flush(), devtools.describe()).toBe(true);
    const [pong] = messagesOf(devtools, T.pong, pongFrom);
    expect(pong?.payload).toEqual({ ref: ping.id });
    const echoed = createEnvelope(T.pong, pong?.payload ?? { ref: ping.id });
    const from = devtools.received.length;
    const closes = devtools.closes.length;

    devtools.sendRaw(encodeMessage(echoed));
    expect(await devtools.flush(), devtools.describe()).toBe(true);

    const replies: readonly ErrorPayload[] = messagesOf(devtools, T.error, from).map(
      (message) => message.payload,
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.code).toBe(CODE.invalidMessage);
    expect(replies[0]?.ref).toBe(echoed.id);
    // Refused, not answered: no pong answers a pong, and nothing cascades.
    expect(messagesOf(devtools, T.pong, from)).toEqual([]);
    expect(await devtools.flush(), devtools.describe()).toBe(true);
    expect(messagesOf(devtools, T.error, from)).toHaveLength(1);
    expect(devtools.closes).toHaveLength(closes);
    expectNoErrors(editor);
    proved.clientPongFrameRefused = true;
  });

  it('refuses a client.ping whose id is too long to be a pong ref with one error under a minted ref, and answers the next ping', async () => {
    const h = harness();
    const from = devtools.received.length;
    const closes = devtools.closes.length;
    const logFrom = h.logger.records.length;
    // Inside the envelope's own id bound, beyond the one a pong's `ref` has.
    const overBound = createEnvelope(
      T.ping,
      {},
      { id: `msg_${'x'.repeat(OVER_REF_BOUND_ID_LENGTH)}` },
    );

    devtools.sendRaw(encodeMessage(overBound));
    expect(await devtools.flush(), devtools.describe()).toBe(true);

    const replies: readonly ErrorPayload[] = messagesOf(devtools, T.error, from).map(
      (message) => message.payload,
    );
    expect(replies.map((reply) => reply.code)).toEqual([CODE.invalidMessage]);
    const ref = replies[0]?.ref ?? '';
    // The id cannot be echoed, so the reply names the service's own record of
    // the refusal instead — and no pong was sent that its sender would refuse.
    expect(ref).toMatch(MINTED_MESSAGE_ID);
    expect(ref).not.toBe(overBound.id);
    expect(messagesOf(devtools, T.pong, from)).toEqual([]);
    expect(
      wsRecordsFor(h, ref, logFrom).map((record) => [record.level, record.fields['code']]),
    ).toEqual([['debug', CODE.invalidMessage]]);

    // The connection is still served, and a ping under a protocol id is answered.
    const ping = devtools.send(T.ping, {});
    expect(await devtools.flush(), devtools.describe()).toBe(true);
    expect(messagesOf(devtools, T.pong, from).map((pong) => pong.payload)).toEqual([
      { ref: ping.id },
    ]);
    expect(devtools.errorsFor(ping.id)).toEqual([]);
    expect(devtools.closes).toHaveLength(closes);
  });

  it('files concurrent same-code failures under distinct refs, each shared by its reply and its log record', async () => {
    const h = harness();
    const from = devtools.received.length;
    const closes = devtools.closes.length;
    const logFrom = h.logger.records.length;

    // Six refusals of one code, written back to back so they queue together
    // on the connection: two service pushes a client may not send (readable
    // ids in the product's own spelling, as `createEnvelope` mints them), one
    // with an id the envelope accepts but protocol's `ref` bound does not, one
    // with a readable, bounded id of another spelling (a URL carrying a
    // marker), and two text frames that are not JSON (no readable id).
    const pushes = [
      createEnvelope(T.targetRequest, { sessionId: session.id }),
      createEnvelope(T.targetRequest, { sessionId: session.id }),
    ];
    const overBound = createEnvelope(
      T.targetRequest,
      { sessionId: session.id },
      { id: `msg_${'x'.repeat(OVER_REF_BOUND_ID_LENGTH)}` },
    );
    const foreignMarker = newMarker();
    const foreignSpelling = createEnvelope(
      T.targetRequest,
      { sessionId: session.id },
      { id: `/api/items?probe=${foreignMarker}` },
    );
    const unreadable = [newMarker(), newMarker()];
    const markers = [foreignMarker, ...unreadable];
    const envelopes = [...pushes, overBound, foreignSpelling];
    for (const frame of envelopes) {
      devtools.sendRaw(encodeMessage(frame));
    }
    for (const marker of unreadable) {
      devtools.sendRaw(`{"id":"${marker}"`);
    }
    expect(await devtools.flush(), devtools.describe()).toBe(true);

    // Frames are answered in arrival order, one reply each, all of one code.
    const replies: readonly ErrorPayload[] = messagesOf(devtools, T.error, from).map(
      (message) => message.payload,
    );
    expect(replies.map((reply) => reply.code)).toEqual(
      Array.from({ length: envelopes.length + unreadable.length }, () => CODE.invalidMessage),
    );
    for (const reply of replies) {
      expect(errorPayloadSchema.safeParse(reply).success, JSON.stringify(reply)).toBe(true);
    }
    const refs = replies.map((reply) => reply.ref ?? '');

    // An id in the product's own spelling is echoed: each sender matches its
    // own reply.
    expect(refs.slice(0, 2)).toEqual(pushes.map((frame) => frame.id));
    for (const frame of pushes) {
      expect(devtools.errorsFor(frame.id).map((reply) => reply.code)).toEqual([
        CODE.invalidMessage,
      ]);
    }
    // Anything else — the over-long id and the readable id of another
    // spelling included — is answered under a minted ref rather than none at
    // all, and a minted ref quotes nothing the frame carried.
    const minted = refs.slice(pushes.length);
    expect(minted).not.toContain(overBound.id);
    expect(minted).not.toContain(foreignSpelling.id);
    expect(devtools.errorsFor(foreignSpelling.id)).toEqual([]);
    for (const ref of minted) {
      expect(ref).toMatch(MINTED_MESSAGE_ID);
      for (const marker of markers) {
        expect(ref).not.toContain(marker);
      }
    }
    // No two failures share a ref, however alike their codes.
    expect(new Set(refs).size).toBe(refs.length);

    // Each ref names exactly one service record, of the code its reply
    // answered with, and the record quotes nothing the frame carried.
    for (const [index, reply] of replies.entries()) {
      const records = wsRecordsFor(h, refs[index] ?? '', logFrom);
      expect(
        records.map((record) => [record.level, record.fields['code']]),
        `the records filed under reply #${String(index)}'s ref`,
      ).toEqual([['debug', reply.code]]);
      for (const marker of markers) {
        expect(records[0]?.line).not.toContain(marker);
      }
    }
    expect(devtools.closes, devtools.describe()).toHaveLength(closes);
  });

  it('refuses a telemetry.event batch one event over protocol’s bound, persisting none of it', async () => {
    const h = harness();
    const count = (): number =>
      unwrap(h.repos.telemetry.countBySession(session.id), 'telemetry count');

    // A batch inside the bound is accepted, so the refusal below is not vacuous.
    const before = count();
    const accepted = await h.ingestFromAgent(devtools, browserEvents(3));
    expect(accepted.errors).toEqual([]);
    const persisted = count();
    expect(persisted).toBe(before + 3);

    const bound = protocolBatchBound();
    const outcome = await h.ingestFromAgent(devtools, browserEvents(bound + 1));
    expect(outcome.settled).toBe(true);
    expect(outcome.errors.map((error) => error.code)).toEqual([CODE.invalidMessage]);
    expect(outcome.errors[0]?.message).toMatch(/\bevents\b/u);
    expect(count()).toBe(persisted);
  });

  it('closes a frame above MAX_WS_MESSAGE_BYTES at the transport, and the client reconnects to a healthy service', async () => {
    const h = harness();
    const closes = devtools.closes.length;
    const sockets = devtools.sockets.length;

    // Above the ceiling `ws` refuses the frame before buffering it and closes
    // with 1009; there is no connection left to answer on, so no `error` frame.
    devtools.sendRaw('x'.repeat(MAX_WS_MESSAGE_BYTES + 1));
    const close = await devtools.waitForClose(HARNESS_TIMEOUTS.message, closes);
    expect(close.code).toBe(WS_CLOSE_MESSAGE_TOO_BIG);

    await devtools.until(
      () =>
        devtools.state === CONNECTION_OPEN && devtools.sockets.length > sockets ? true : undefined,
      HARNESS_TIMEOUTS.message,
      () => `The DevTools client did not reconnect: ${devtools.describe()}`,
    );
    expect(await devtools.flush()).toBe(true);
    expect((await h.rawFetch('health')).status).toBe(HTTP_OK);

    // The binding belongs to the credential: the reconnected tab still relays.
    const outcome = await h.ingestFromAgent(devtools, browserEvents(1));
    expect(outcome.errors).toEqual([]);
    expect((await fetchSession(h, session.id)).status).toBe(STATUS.capturing);
    unwrap(await h.endSession(session.id), 'ending the session');
  });
});

/* -------------------------------------------------------------------------------------------------
 * 4a. Failure refs a client cannot choose
 * ---------------------------------------------------------------------------------------------- */

/**
 * A client frame `id` the envelope accepts — a non-empty string inside its
 * bound — but not spelled as the product mints message ids, with the text in
 * it no log record may hold.
 */
interface NonConformingId {
  readonly name: string;
  readonly id: string;
  readonly sentinel: string;
}

/**
 * Short, peer-chosen ids a logger's credential scrubbing would let through as
 * ordinary text. Each fits protocol's `error.ref` bound, so only the id
 * grammar keeps it out of the `ref` the service files and replies with.
 */
const NON_CONFORMING_IDS: readonly NonConformingId[] = [
  {
    name: 'a URL whose query carries a private value',
    id: '/api/items?email=zz-private',
    sentinel: 'zz-private',
  },
  { name: 'an inline SQL literal', id: "SELECT 'zz-sql-literal'", sentinel: 'zz-sql-literal' },
  { name: 'an upper-case message id', id: 'msg_ZZPRIVATE0000000', sentinel: 'ZZPRIVATE' },
  {
    name: 'a message id with a seventeen-character suffix',
    id: 'msg_zzseventeenchars0',
    sentinel: 'zzseventeenchars',
  },
  {
    name: 'an id with another kind’s prefix',
    id: 'ses_0123456789abcdef',
    sentinel: '0123456789abcdef',
  },
];

/**
 * The texts the handler fault's exception carries — a query value and an
 * inline SQL literal, as a driver's error would quote them. Neither may reach
 * a `server.ws` record at any level: the `error` record holds the closed
 * exception shape only, and the `debug` twin holds the message after the
 * service's diagnostic redaction.
 */
const THROWN_SENTINELS = Object.freeze({ query: 'zz-thrown-private', sql: 'zz-thrown-sql' });

/** The message of the exception the handler fault throws. */
const THROWN_FAULT_MESSAGE = `lookup failed for /api/orders?email=${THROWN_SENTINELS.query} while running SELECT * FROM orders WHERE note = '${THROWN_SENTINELS.sql}'`;

/**
 * The stack frame of the page-agent readiness ledger's `agentReady`
 * (`src/main.ts`), which stamps the report it records with the injected clock
 * before anything is stored or logged. The relayed `agent.ready` route awaits
 * it without a guard of its own, so a clock read that throws there is a
 * handler failure the WebSocket router itself must catch.
 */
const AGENT_READY_LEDGER_FRAME = /\bagentReady \([^)]*[\\/]src[\\/]main\.[cm]?[jt]s\b/u;

/** The tab the page agent of the suite below reports from. */
const FAILURE_REFS_TAB_URL = 'http://127.0.0.1/';

/**
 * The service clock of the suite below, able to make one frame's handler
 * throw.
 *
 * No well-formed frame reaches the router's handler-failure path on a healthy
 * service, so the fault is the clock the harness boots the service with: it
 * throws once, only while armed, and only for a read whose direct caller is
 * {@link AGENT_READY_LEDGER_FRAME}. Every other read — the client registry
 * refreshing the connection as the frame arrives, the pipeline, the harness —
 * is answered by an ordinary harness clock, so nothing else fails.
 */
interface HandlerFault {
  /** The clock handed to the service. */
  readonly now: () => number;
  /** Makes the next matching read throw. */
  readonly arm: () => void;
  /** Cancels an armed fault that has not fired. */
  readonly disarm: () => void;
  /** How many times the fault has fired. */
  readonly fired: () => number;
}

/**
 * The direct caller's frame of `callee`, read without throwing: V8's
 * `Error.captureStackTrace` omits `callee` and every frame above it, so the
 * first frame left is the one that called it.
 */
function callerFrameOf(callee: () => number): string {
  const probe: { stack?: string } = {};
  Error.captureStackTrace(probe, callee);
  return probe.stack?.split('\n')[1] ?? '';
}

/** Builds the {@link HandlerFault} clock over a fresh harness clock. */
function createHandlerFault(): HandlerFault {
  const clock = createHarnessClock();
  let armed = false;
  let fired = 0;
  const now = (): number => {
    if (armed && AGENT_READY_LEDGER_FRAME.test(callerFrameOf(now))) {
      armed = false;
      fired += 1;
      throw new Error(THROWN_FAULT_MESSAGE);
    }
    return clock.now();
  };
  return Object.freeze({
    now,
    arm: () => {
      armed = true;
    },
    disarm: () => {
      armed = false;
    },
    fired: () => fired,
  });
}

/** One way a frame fails after its id was read, and what the service files it as. */
interface FailureKind {
  readonly name: string;
  /** Builds the frame under `id`, stamped `ts`. */
  readonly build: (id: string, ts: number) => string;
  /** Whether the frame is sent with the handler fault armed. */
  readonly throws: boolean;
  /** The code of the `error` reply. */
  readonly code: DebuggenErrorCode;
}

/**
 * The three failures that read a frame's id first: a handler that throws
 * (filed at `error`, then as its `debug` twin, then as the `debug` refusal
 * the `INTERNAL` reply answers), a route refusal (a service push sent by a
 * client) and a decode refusal (a payload that fails its schema), each filed
 * once at `debug`.
 */
const FAILURE_KINDS: readonly FailureKind[] = [
  {
    name: 'a handler that throws',
    build: (id) =>
      encodeMessage(
        createEnvelope(T.agentReady, agentReadyFor(TAB.failureRefs, FAILURE_REFS_TAB_URL), { id }),
      ),
    throws: true,
    code: CODE.internal,
  },
  {
    name: 'a route refusal',
    build: (id) =>
      encodeMessage(createEnvelope(T.targetRequest, { sessionId: newSessionId() }, { id })),
    throws: false,
    code: CODE.invalidMessage,
  },
  {
    name: 'a decode refusal',
    build: (id, ts) =>
      JSON.stringify({ id, type: T.navigated, ts, payload: { tabId: 'not-a-tab', url: 'x' } }),
    throws: false,
    code: CODE.invalidMessage,
  },
];

/** A record field read as a plain object, or `undefined` when it is not one. */
function recordField(
  record: CapturedLogRecord | undefined,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = record?.fields[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

describe('failure refs a client cannot choose', () => {
  const fault = createHandlerFault();
  const harness = useHarness({ now: fault.now, fixtureProject: false });

  let devtools: HarnessWsClient;

  beforeAll(async () => {
    devtools = (await harness().connectDevtools({ tabId: TAB.failureRefs })).client;
  });

  afterAll(() => {
    fault.disarm();
  });

  /** What one failing frame produced: its one reply, and the `server.ws` records since it was sent. */
  interface FailedFrame {
    readonly reply: ErrorPayload;
    readonly wsRecords: readonly CapturedLogRecord[];
    readonly logFrom: number;
  }

  /**
   * Sends `kind`'s frame under `id` — with the handler fault armed when the
   * kind throws — waits until the connection has provably handled it, and
   * returns the one `error` reply it drew.
   */
  async function sendFailing(kind: FailureKind, id: string): Promise<FailedFrame> {
    const h = harness();
    const from = devtools.received.length;
    const closes = devtools.closes.length;
    const logFrom = h.logger.records.length;
    const firedBefore = fault.fired();
    const frame = kind.build(id, h.now());
    if (kind.throws) {
      fault.arm();
    }
    try {
      devtools.sendRaw(frame);
      expect(await devtools.flush(), devtools.describe()).toBe(true);
    } finally {
      fault.disarm();
    }
    expect(fault.fired() - firedBefore, 'the handler fault fired for this frame only').toBe(
      kind.throws ? 1 : 0,
    );
    expect(devtools.closes, devtools.describe()).toHaveLength(closes);

    const replies = messagesOf(devtools, T.error, from).map((message) => message.payload);
    expect(replies.map((reply) => reply.code)).toEqual([kind.code]);
    const [reply] = replies;
    if (reply === undefined) {
      throw new Error('An error reply was asserted and is missing.');
    }
    expect(errorPayloadSchema.safeParse(reply).success, JSON.stringify(reply)).toBe(true);
    const wsRecords = h.logger.records
      .slice(logFrom)
      .filter((record) => record.fields['subsystem'] === WS_LOG_SUBSYSTEM);
    return { reply, wsRecords, logFrom };
  }

  /**
   * Asserts the records filed under the reply's ref are exactly the ones the
   * kind's failure writes, and that none of them — nor the reply — quotes the
   * handler fault's exception text.
   */
  function expectFiledUnderReplyRef(kind: FailureKind, failed: FailedFrame): void {
    const ref = failed.reply.ref ?? '';
    const records = wsRecordsFor(harness(), ref, failed.logFrom);
    const text = [JSON.stringify(failed.reply), ...failed.wsRecords.map((record) => record.line)];
    for (const sentinel of Object.values(THROWN_SENTINELS)) {
      for (const line of text) {
        expect(line).not.toContain(sentinel);
      }
    }

    if (!kind.throws) {
      expect(records.map((record) => [record.level, record.fields['code']])).toEqual([
        ['debug', kind.code],
      ]);
      return;
    }

    // The failure at `error`, its `debug` twin, then the refusal the
    // `INTERNAL` reply answers — all under the one ref the reply carries.
    expect(records.map((record) => record.level)).toEqual(['error', 'debug', 'debug']);
    const [failure, twin, refusal] = records;
    expect(refusal?.fields['code']).toBe(kind.code);

    // At `error` the exception is its closed shape only: a class from the
    // fixed taxonomy, never a message or a stack.
    expect(failure?.fields['errorClass']).toBe('Error');
    const failureError = recordField(failure, 'err');
    expect(failureError?.['type']).toBe('Error');
    expect(failureError).not.toHaveProperty('message');
    expect(failureError).not.toHaveProperty('stack');

    // The `debug` twin carries the same classification under the same ref,
    // plus the message the serializer adds only at a diagnostic level —
    // redacted, as the sentinel loop above proves.
    expect(twin?.fields['errorClass']).toBe(failure?.fields['errorClass']);
    expect(twin?.fields['type']).toBe(T.agentReady);
    const twinError = recordField(twin, 'err');
    expect(twinError?.['type']).toBe('Error');
    expect(typeof twinError?.['message']).toBe('string');
    expect(String(twinError?.['message'])).toContain('lookup failed');
  }

  describe.each(FAILURE_KINDS)('$name', (kind) => {
    it.each(NON_CONFORMING_IDS)(
      'files a frame whose id is $name under a minted ref, never under the id',
      async (candidate) => {
        const failed = await sendFailing(kind, candidate.id);

        // The reply's ref is one the service minted, not the client's id.
        const ref = failed.reply.ref ?? '';
        expect(ref).toMatch(MINTED_MESSAGE_ID);
        expect(ref).not.toBe(candidate.id);
        expect(ref).not.toContain(candidate.sentinel);
        expect(devtools.errorsFor(candidate.id)).toEqual([]);

        // That minted ref is the ref of the records of this failure, and no
        // `server.ws` record written since the frame quotes the id.
        expectFiledUnderReplyRef(kind, failed);
        for (const record of failed.wsRecords) {
          expect(record.line).not.toContain(candidate.sentinel);
          expect(record.line).not.toContain(candidate.id);
        }
      },
    );

    it('echoes an id in the product’s own spelling and files the failure under it', async () => {
      const id = newMessageId();
      expect(id).toMatch(MINTED_MESSAGE_ID);
      const failed = await sendFailing(kind, id);

      expect(failed.reply.ref).toBe(id);
      expect(devtools.errorsFor(id).map((reply) => reply.code)).toEqual([kind.code]);
      expectFiledUnderReplyRef(kind, failed);
    });
  });

  it('keeps serving the connection and the service after every failure', async () => {
    expect(devtools.authenticated, devtools.describe()).toBe(true);
    expect(await devtools.flush()).toBe(true);
    expect((await harness().rawFetch('health')).status).toBe(HTTP_OK);
    expect(fault.fired()).toBe(NON_CONFORMING_IDS.length + 1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 5. Disconnect tolerance, unbinding and a cross-origin navigation
 * ---------------------------------------------------------------------------------------------- */

describe('a DevTools connection that drops mid-capture', () => {
  const harness = useHarness();

  let editor: HarnessWsClient;
  let original: HarnessWsClient;
  let credential: DevtoolsCredential;
  let reconnected: HarnessWsClient;
  let session: SessionRecord;
  let captureId: string;

  const count = (): number =>
    unwrap(harness().repos.telemetry.countBySession(session.id), 'telemetry count');

  beforeAll(async () => {
    const h = harness();
    const project = await launchDevServer(h);
    editor = await h.editor(project.root);
    const connection = await h.connectDevtools({ tabId: TAB.reconnecting });
    original = connection.client;
    credential = connection.credential;
    await connectServerAgent(h, project.root);
    session = await h.createSession({ projectRoot: project.root, question: QUESTION });
    await bindAndReady(h, original, TAB.reconnecting, session);
    captureId = unwrap(await h.startCapture(session.id), 'starting the capture').captureId;
    await waitForSessionMessage(
      original,
      T.agentConfig,
      session.id,
      0,
      (message) => message.payload.captureId === captureId,
    );
  });

  it('keeps the session, its binding and its capture, and marks the client offline rather than removing it', async () => {
    const h = harness();
    const logFrom = h.logger.records.length;
    await original.close();

    const offline = await waitUntil(
      () =>
        h.logger.records
          .slice(logFrom)
          .find(
            (record) =>
              record.message === CLIENT_OFFLINE_LOG && record.fields['tabId'] === TAB.reconnecting,
          ),
      'the registry marking the closed DevTools connection offline',
    );
    expect(offline.fields['tabId']).toBe(TAB.reconnecting);

    const record = await fetchSession(h, session.id);
    expect(record.status).toBe(STATUS.capturing);
    expect(record.boundTab?.tabId).toBe(TAB.reconnecting);
    const binding = unwrap(h.repos.sessions.getBindingBySession(session.id), 'binding lookup');
    expect(binding?.tab.tabId).toBe(TAB.reconnecting);
  });

  it('carries the binding’s traffic again after a reconnect with the same credential and tab', async () => {
    const h = harness();
    reconnected = (await h.connectDevtools({ tabId: TAB.reconnecting, credential })).client;
    expect(reconnected.authenticated).toBe(true);

    // No session.bind is sent: relayed telemetry is accepted on the binding alone.
    const before = count();
    const outcome = await h.ingestFromAgent(reconnected, browserEvents(2));
    expect(outcome.errors).toEqual([]);
    expect(count()).toBe(before + 2);
  });

  it('queues a frame sent while the socket is down and delivers it once the client reconnects', async () => {
    const sockets = reconnected.sockets.length;
    const before = count();
    // An abrupt drop, as a suspended MV3 service worker's socket would see.
    reconnected.sockets[sockets - 1]!.terminate();

    const events = browserEvents(2);
    const receipt = reconnected.send(T.telemetry, { events });
    expect(unwrap(receipt.result, 'telemetry.event send')).toBe(SEND_QUEUED);

    await reconnected.until(
      () =>
        reconnected.state === CONNECTION_OPEN && reconnected.sockets.length > sockets
          ? true
          : undefined,
      HARNESS_TIMEOUTS.message,
      () => `The DevTools client did not reconnect: ${reconnected.describe()}`,
    );
    expect(reconnected.client.queuedCount).toBe(0);
    expect(await reconnected.flush()).toBe(true);
    expect(reconnected.errorsFor(receipt.id)).toEqual([]);
    expect(count()).toBe(before + events.length);
  });

  it('delivers the rest of the capture’s pushes to the reconnected tab and none to the closed one', async () => {
    const h = harness();
    const from = reconnected.received.length;
    const closedFrom = original.received.length;
    unwrap(await h.stopCapture(session.id), 'stopping the capture');
    await waitForSessionMessage(
      reconnected,
      T.captureStopped,
      session.id,
      from,
      (message) => message.payload.captureId === captureId,
    );
    await waitForSessionMessage(reconnected, T.agentConfig, session.id, from);
    await h.waitForSession(session.id, (record) => record.status === STATUS.generated);
    expect(original.received.slice(closedFrom)).toEqual([]);
  });

  it('removes the binding on session.unbind without ending the session', async () => {
    const h = harness();
    const from = reconnected.received.length;
    const editorFrom = editor.received.length;
    const receipt = reconnected.send(T.unbind, { tabId: TAB.reconnecting });
    for (const [client, index] of [
      [reconnected, from],
      [editor, editorFrom],
    ] as const) {
      await waitForSessionMessage(
        client,
        T.bound,
        session.id,
        index,
        (message) => message.payload.reason === REASON.unbound,
      );
    }
    expect(reconnected.errorsFor(receipt.id)).toEqual([]);
    expect(
      unwrap(h.repos.sessions.getBindingBySession(session.id), 'binding lookup'),
    ).toBeUndefined();
    const record = await fetchSession(h, session.id);
    expect(record.status).toBe(STATUS.generated);
    expect(record.boundTab).toBeUndefined();
    proveInbound(T.unbind);
  });

  it('releases a binding whose tab navigates to another origin and announces origin-changed', async () => {
    const h = harness();
    const tab = tabOf(session);
    unwrap(
      await h.bindTab(reconnected, {
        tabId: TAB.reconnecting,
        url: tab.url,
        origin: tab.origin,
        sessionId: session.id,
      }),
      'binding the tab',
    );

    const from = reconnected.received.length;
    const url = new URL(`https://${newMarker()}.invalid/`).toString();
    const receipt = reconnected.send(T.navigated, { tabId: TAB.reconnecting, url });
    await waitForSessionMessage(
      reconnected,
      T.bound,
      session.id,
      from,
      (message) => message.payload.reason === REASON.originChanged && message.payload.url === url,
    );
    expect(reconnected.errorsFor(receipt.id)).toEqual([]);
    expect(
      unwrap(h.repos.sessions.getBindingBySession(session.id), 'binding lookup'),
    ).toBeUndefined();
    expect((await fetchSession(h, session.id)).status).toBe(STATUS.generated);
    proveInbound(T.navigated, 'cross-origin');
    unwrap(await h.endSession(session.id), 'ending the session');
  });
});

/* -------------------------------------------------------------------------------------------------
 * 6. An install that fails outright
 * ---------------------------------------------------------------------------------------------- */

describe('an install that fails outright', () => {
  const gate = createPipelineGate();
  const harness = useHarness({ provider: gate.provider });

  let editor: HarnessWsClient;
  let devtools: HarnessWsClient;
  let serverAgent: HarnessWsClient;
  let session: SessionRecord;
  let announced: readonly HarnessMessage<typeof T.failed>[];

  beforeAll(async () => {
    const h = harness();
    const project = await launchDevServer(h);
    editor = await h.editor(project.root);
    devtools = (await h.connectDevtools({ tabId: TAB.failedInstall })).client;
    serverAgent = await connectServerAgent(h, project.root);
    session = await h.createSession({ projectRoot: project.root, question: QUESTION });
    const tab = tabOf(session);
    unwrap(
      await h.bindTab(devtools, {
        tabId: TAB.failedInstall,
        url: tab.url,
        origin: tab.origin,
        sessionId: session.id,
      }),
      'binding the tab',
    );
    // With the backups directory replaced by a file, the patch adapter cannot
    // save an original and refuses to write — before any project file changes.
    await rm(h.config.backupsDir, { recursive: true, force: true });
    await writeFile(h.config.backupsDir, newMarker());
    gate.open();
    announced = await Promise.all(
      [editor, devtools].map((client) => waitForSessionMessage(client, T.failed, session.id)),
    );
  });

  it('announces instrumentation.failed to both interfaces and never to the server agent', async () => {
    const h = harness();
    expect(announced.map((message) => message.payload.error.code)).toEqual([
      CODE.installFailed,
      CODE.installFailed,
    ]);
    expect(announced[0]?.payload).toEqual(announced[1]?.payload);
    await h.waitForSession(session.id, (record) => record.status === STATUS.failed);
    expect(messagesOf(serverAgent, T.failed)).toEqual([]);
    for (const client of [editor, devtools]) {
      expect(
        messagesOf(client, T.ready).filter((message) => sessionOf(message) === session.id),
      ).toEqual([]);
    }
  });

  it('refuses the failed-install push when a client sends it back', async () => {
    const [received] = announced;
    expect(received).toBeDefined();
    const frame = { ...received!, id: newMessageId() };
    editor.sendRaw(encodeMessage(frame));
    expect(await editor.flush()).toBe(true);
    expect(editor.errorsFor(frame.id).map((error) => error.code)).toEqual([CODE.invalidMessage]);
    proved.refusedWhenSentByClient.add(T.failed);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 6a. Admission before the hello
 *
 * The quotas are proved on a WebSocket server of their own, built with
 * `createWsServer` over the harness's real access boundary and a fresh client
 * registry, because the bounds that make a quota observable in a few sockets
 * (and a hello window short enough to wait out) are injected options the
 * service's composition root leaves at their defaults. The last test drives
 * the harness's own service, so the refusal headers are proved on the
 * production wiring as well.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The upgrade header the admission rig's relay reads to present an upgrade
 * under another peer address. Only the rig's relay honours it; the service's
 * gate reads nothing but the TCP remote address.
 */
const PEER_HEADER = 'x-debuggen-admission-peer';

/**
 * The peers the rig presents upgrades under, besides the real loopback
 * address every test socket connects from. Real loopback aliases cannot stand
 * in portably — IPv6 is disabled on some CI hosts and `127.0.0.2` does not
 * exist on others — so the relay presents these instead. The IPv4-mapped
 * spelling of the real address proves the gate folds it into the same bucket.
 */
const PEER = Object.freeze({
  ipv6Loopback: '::1',
  mappedLoopback: '::FFFF:127.0.0.1',
  third: '127.0.0.2',
});

/**
 * The record message of an admission refusal (`src/server/ws.ts`). The suite
 * matches it to read the record's fields — counts, limits and the closed
 * refusal category — and to prove no peer address reached it.
 */
const ADMISSION_REFUSED_LOG = 'refused a WebSocket upgrade past its admission quota';

/** The refusal categories those records carry, in the gate's order of checking. */
const REFUSAL = Object.freeze({
  peer: 'peer-quota',
  pending: 'pending-quota',
  capacity: 'capacity',
});

/** The constant refusal of every inbound frame port the admission rig never routes a frame to. */
const UNROUTED_MESSAGE = 'The admission rig routes no frame past the hello.';

/** The ports of the admission rig: every frame after the hello is refused, since none is sent. */
function unrouted(): Promise<Result<never, DebuggenError>> {
  return Promise.resolve(err(new DebuggenError('INTERNAL', UNROUTED_MESSAGE)));
}

/**
 * The `Retry-After` an admission refusal carries for a hello window: the
 * window plus the closing grace, in whole seconds rounded up — the longest a
 * pending reservation can be held.
 */
function retryAfterFor(helloTimeoutMs: number): string {
  return String(Math.ceil((helloTimeoutMs + CLOSE_HANDSHAKE_GRACE_MS) / 1_000));
}

/** What {@link rawUpgrade} sends. */
interface RawUpgradeOptions {
  /** The request target; defaults to protocol's `WS_PATH`. */
  readonly path?: string | undefined;
  /** An `Origin` header; omitted, none — a Node client's upgrade. */
  readonly origin?: string | undefined;
  /** The `Sec-WebSocket-Key`; omitted, a valid random one. */
  readonly key?: string | undefined;
  /** The peer the admission rig's relay presents the upgrade under. */
  readonly peer?: string | undefined;
}

/** The head of the service's answer to one bare upgrade. */
interface RawUpgradeResponse {
  readonly status: number;
  /** Header values by lower-cased name. */
  readonly headers: ReadonlyMap<string, string>;
  /** The response head verbatim, for "nothing the client sent" assertions. */
  readonly head: string;
  /** Whether the service hung up after answering, as every refusal does. */
  readonly closedByService: boolean;
}

/** Parses an HTTP/1.1 response head (the bytes before the blank line). */
function parseResponseHead(head: string): Omit<RawUpgradeResponse, 'closedByService'> {
  const [statusLine = '', ...lines] = head.split('\r\n');
  const status = Number(statusLine.split(' ')[1]);
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  return { status, headers, head };
}

/**
 * Sends one WebSocket upgrade over bare TCP and reads the answer's head — the
 * view of a refusal a WebSocket client does not give, and the only way to send
 * a handshake `ws` itself refuses. An upgrade that is admitted (101) is hung
 * up on at once: this helper never holds a WebSocket.
 */
function rawUpgrade(
  host: string,
  port: number,
  options: RawUpgradeOptions = {},
): Promise<RawUpgradeResponse> {
  return new Promise<RawUpgradeResponse>((resolve, reject) => {
    const socket = connectTcp({ host, port });
    const failures: string[] = [];
    let received = Buffer.alloc(0);
    let answer: Omit<RawUpgradeResponse, 'closedByService'> | undefined;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `No answer to a bare upgrade within ${String(HARNESS_TIMEOUTS.message)} ms (${failures.join('; ')}).`,
        ),
      );
    }, HARNESS_TIMEOUTS.message);
    socket.on('connect', () => {
      const lines = [
        `GET ${options.path ?? WS_PATH} HTTP/1.1`,
        `Host: ${host}:${String(port)}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${options.key ?? randomBytes(16).toString('base64')}`,
        ...(options.origin === undefined ? [] : [`Origin: ${options.origin}`]),
        ...(options.peer === undefined ? [] : [`${PEER_HEADER}: ${options.peer}`]),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      if (answer !== undefined) {
        return;
      }
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) {
        return;
      }
      answer = parseResponseHead(received.subarray(0, end).toString('latin1'));
      if (answer.status === HTTP_SWITCHING_PROTOCOLS) {
        clearTimeout(timer);
        socket.destroy();
        resolve({ ...answer, closedByService: false });
      }
    });
    socket.on('error', (error: Error) => {
      failures.push(error.message);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (answer === undefined) {
        reject(
          new Error(
            `The service hung up without answering a bare upgrade (${failures.join('; ')}).`,
          ),
        );
        return;
      }
      resolve({ ...answer, closedByService: true });
    });
  });
}

/**
 * Asserts a bare refusal of the upgrade gate: the status, a closed
 * connection, and exactly the constant headers — `nosniff`, `no-store`, an
 * empty body and, for an admission refusal, `Retry-After` — so nothing else,
 * and nothing the client sent, is in the answer.
 */
function expectBareRefusal(
  response: RawUpgradeResponse,
  status: number,
  retryAfter: string | undefined,
): void {
  expect(response.status, response.head).toBe(status);
  expect(response.closedByService).toBe(true);
  expect(Object.fromEntries(response.headers)).toEqual({
    connection: 'close',
    'content-length': '0',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
  });
}

/** A bare WebSocket to the admission rig that sends nothing until a test tells it to. */
interface AdmissionSocket {
  readonly socket: NodeWebSocket;
  /** `true` once upgraded; `false` when the upgrade was refused or the socket closed first. */
  readonly opened: Promise<boolean>;
  /** The close code, once the socket has closed. */
  readonly closed: Promise<number>;
  /** Transport failures, verbatim — a refused upgrade's `Unexpected server response`. */
  readonly errors: readonly string[];
}

/**
 * An {@link UpgradeSource} over a real `node:http` server that presents each
 * upgrade carrying {@link PEER_HEADER} under that peer address, by shadowing
 * the TCP socket's `remoteAddress` before the gate reads it. Everything else —
 * the socket, the head, the handshake — is the real server's.
 */
function createPeerRelay(server: Server): UpgradeSource {
  const relays = new Map<UpgradeListener, UpgradeListener>();
  return {
    on(event, listener) {
      const relay: UpgradeListener = (request, socket, head) => {
        const peer = request.headers[PEER_HEADER];
        if (typeof peer === 'string') {
          Object.defineProperty(request.socket, 'remoteAddress', {
            value: peer,
            configurable: true,
          });
        }
        listener(request, socket, head);
      };
      relays.set(listener, relay);
      return server.on(event, relay);
    },
    off(event, listener) {
      const relay = relays.get(listener);
      if (relay === undefined) {
        return server;
      }
      relays.delete(listener);
      return server.off(event, relay);
    },
  };
}

/** The admission bounds and hello window one rig's server is built with. */
type AdmissionOptions = Pick<
  WsServerDeps,
  'maxOpenConnections' | 'maxPendingHandshakes' | 'maxPendingHandshakesPerPeer' | 'helloTimeoutMs'
>;

/** A WebSocket server of the admission block's own, on a listener of its own. */
interface AdmissionRig {
  /** The listener's host, the harness service's own. */
  readonly host: string;
  readonly port: number;
  readonly ws: WsServer;
  /** Opens a bare WebSocket, presented under `peer` when one is named. */
  open(peer?: string): AdmissionSocket;
  /** Sends one bare upgrade to the rig; see {@link rawUpgrade}. */
  upgrade(options?: RawUpgradeOptions): Promise<RawUpgradeResponse>;
  /** Sends an editor hello on `client` and waits until the server counts it authenticated. */
  authenticate(client: AdmissionSocket): Promise<void>;
  /** Waits until the server's counters satisfy `predicate`. */
  until(predicate: (stats: WsServerStats) => boolean, description: string): Promise<WsServerStats>;
  /**
   * Closes the WebSocket server, the registry and the listener, then asserts
   * every counter read zero once `close()` resolved and the server closed its
   * source-navigation port exactly once.
   */
  close(): Promise<void>;
}

/** Everything but the admission tuning: the harness's access boundary, a fresh registry, refusing ports. */
function admissionDeps(
  h: Harness,
  clients: ClientRegistry,
  onSourceClose: () => void,
): WsServerDeps {
  return {
    auth: h.auth,
    clients,
    binding: {
      handleSessionBind: unrouted,
      handleTabNavigated: unrouted,
      handleSessionUnbind: unrouted,
    },
    telemetry: { handleTelemetryEventFrame: unrouted },
    readiness: { agentReady: unrouted },
    targets: { selected: unrouted },
    sourceOpen: { handle: unrouted, acceptEditorResult: unrouted, close: onSourceClose },
    logger: h.logger.root,
    heartbeatIntervalMs: 0,
    offlineGraceMs: 0,
  };
}

/** Builds and starts an {@link AdmissionRig} on the harness service's host. */
async function startAdmissionRig(h: Harness, options: AdmissionOptions): Promise<AdmissionRig> {
  const host = new URL(h.url).hostname;
  const clients = createClientRegistry({ logger: h.logger.root });
  let sourceCloses = 0;
  const ws = unwrap(
    createWsServer({
      ...admissionDeps(h, clients, () => {
        sourceCloses += 1;
      }),
      ...options,
    }),
    'creating the admission server',
  );
  const listener = createServer((_request, response) => {
    response.statusCode = HTTP_NOT_FOUND;
    response.end();
  });
  unwrap(ws.attach(createPeerRelay(listener)), 'attaching the admission server');
  await new Promise<void>((resolveListen, rejectListen) => {
    listener.once('error', rejectListen);
    listener.listen(0, host, () => {
      resolveListen();
    });
  });
  const address = listener.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The admission rig listener has no TCP port.');
  }
  const port = address.port;
  const wsUrl = unwrap(resolveWsUrl(`http://${host}:${String(port)}`), 'resolving the rig URL');
  const sockets: AdmissionSocket[] = [];

  const until = async (
    predicate: (stats: WsServerStats) => boolean,
    description: string,
  ): Promise<WsServerStats> => {
    try {
      return await waitUntil(() => {
        const stats = ws.stats();
        return predicate(stats) ? stats : undefined;
      }, description);
    } catch (cause) {
      // The counters when the wait gave up, which is what a failure needs.
      throw new Error(`${description}; last counters ${JSON.stringify(ws.stats())}`, { cause });
    }
  };

  return {
    host,
    port,
    ws,
    open(peer) {
      const socket = new NodeWebSocket(wsUrl, [], {
        handshakeTimeout: HARNESS_TIMEOUTS.message,
        headers: peer === undefined ? {} : { [PEER_HEADER]: peer },
      });
      const errors: string[] = [];
      socket.on('error', (error: Error) => {
        errors.push(error.message);
      });
      const opened = new Promise<boolean>((resolveOpen) => {
        socket.once('open', () => {
          resolveOpen(true);
        });
        socket.once('close', () => {
          resolveOpen(false);
        });
      });
      const closed = new Promise<number>((resolveClose) => {
        socket.once('close', (code: number) => {
          resolveClose(code);
        });
      });
      const client: AdmissionSocket = { socket, opened, closed, errors };
      sockets.push(client);
      return client;
    },
    upgrade: (upgradeOptions) => rawUpgrade(host, port, upgradeOptions),
    async authenticate(client) {
      const before = ws.stats().authenticated;
      const hello = createEnvelope(T.hello, {
        client: KIND.editor,
        projectRoot: h.requireProject().root,
        version: PROTOCOL_VERSION,
        token: h.editorToken,
      });
      client.socket.send(encodeMessage(hello));
      await until(
        (stats) => stats.authenticated === before + 1,
        'the hello authenticated the connection',
      );
    },
    until,
    async close() {
      await ws.close();
      const after = ws.stats();
      clients.closeAll();
      listener.closeAllConnections();
      await new Promise<void>((resolveClose) => {
        listener.close(() => {
          resolveClose();
        });
      });
      await Promise.all(sockets.map((client) => client.closed));
      expect(after).toMatchObject({
        open: 0,
        awaitingHello: 0,
        authenticated: 0,
        pendingFrames: 0,
        offlineRetained: 0,
        admitted: 0,
        pendingHandshakes: 0,
        pendingPeers: 0,
        attached: 0,
        heartbeatActive: false,
        closed: true,
      });
      expect(sourceCloses).toBe(1);
    },
  };
}

describe('admission before the hello', () => {
  const harness = useHarness();

  it('keeps its default bounds generous, nested, and inside the HTTP server’s connection share', () => {
    expect(DEFAULT_MAX_OPEN_CONNECTIONS).toBe(DEFAULT_MAX_CLIENTS + DEFAULT_MAX_PENDING_HANDSHAKES);
    // The composition root sizes the HTTP server's own connection limit above
    // this cap, so the total WebSocket share must stay within it.
    expect(DEFAULT_MAX_OPEN_CONNECTIONS).toBeLessThanOrEqual(320);
    expect(DEFAULT_MAX_PENDING_HANDSHAKES_PER_PEER).toBeLessThanOrEqual(
      DEFAULT_MAX_PENDING_HANDSHAKES,
    );
    expect(DEFAULT_MAX_PENDING_HANDSHAKES).toBeLessThan(DEFAULT_MAX_OPEN_CONNECTIONS);
  });

  it('refuses admission bounds that are not nested integers within the ceiling', async () => {
    const h = harness();
    const clients = createClientRegistry();
    const invalid: readonly AdmissionOptions[] = [
      { maxOpenConnections: DEFAULT_MAX_OPEN_CONNECTIONS + 1 },
      { maxOpenConnections: 0 },
      { maxOpenConnections: 3, maxPendingHandshakes: 4 },
      { maxPendingHandshakes: 2, maxPendingHandshakesPerPeer: 3 },
      { maxPendingHandshakes: 1.5 },
      { maxPendingHandshakesPerPeer: 0 },
    ];
    for (const options of invalid) {
      const created = createWsServer({ ...admissionDeps(h, clients, () => undefined), ...options });
      expect(isErr(created) && created.error.code, JSON.stringify(options)).toBe(
        CODE.configInvalid,
      );
    }
    // A smaller open-socket cap pulls the pending defaults down with it
    // rather than being refused for sitting below them.
    const lowered = createWsServer({
      ...admissionDeps(h, clients, () => undefined),
      maxOpenConnections: 2,
    });
    expect(isErr(lowered)).toBe(false);
    if (!isErr(lowered)) {
      await lowered.value.close();
    }
    clients.closeAll();
  });

  it('answers 429 over bare HTTP once a peer holds its unauthenticated share, admitting another peer meanwhile', async () => {
    const rig = await startAdmissionRig(harness(), {
      maxOpenConnections: 8,
      maxPendingHandshakes: 3,
      maxPendingHandshakesPerPeer: 2,
    });
    try {
      // The IPv4-mapped spelling of the loopback address is the same peer.
      const first = rig.open();
      const second = rig.open(PEER.mappedLoopback);
      expect(await Promise.all([first.opened, second.opened])).toEqual([true, true]);
      expect(rig.ws.stats()).toMatchObject({
        open: 2,
        awaitingHello: 2,
        admitted: 2,
        pendingHandshakes: 2,
        pendingPeers: 1,
        refusedUpgrades: 0,
      });

      const refused = await rig.upgrade();
      expectBareRefusal(refused, HTTP_TOO_MANY_REQUESTS, retryAfterFor(CLIENT_HELLO_TIMEOUT_MS));
      // Refused before `ws` saw it: no connection, no reservation.
      expect(rig.ws.stats()).toMatchObject({
        open: 2,
        admitted: 2,
        pendingHandshakes: 2,
        refusedUpgrades: 1,
      });

      // The same refusal reaches a WebSocket client as a failed upgrade.
      const turnedAway = rig.open();
      expect(await turnedAway.opened).toBe(false);
      expect(turnedAway.errors.join(' ')).toContain(String(HTTP_TOO_MANY_REQUESTS));

      const other = rig.open(PEER.ipv6Loopback);
      expect(await other.opened).toBe(true);
      expect(rig.ws.stats()).toMatchObject({
        open: 3,
        admitted: 3,
        pendingHandshakes: 3,
        pendingPeers: 2,
        refusedUpgrades: 2,
      });
    } finally {
      await rig.close();
    }
  });

  it('answers 429 once every peer together holds the unauthenticated share, and files counts only', async () => {
    const h = harness();
    const rig = await startAdmissionRig(h, {
      maxOpenConnections: 8,
      maxPendingHandshakes: 3,
      maxPendingHandshakesPerPeer: 2,
    });
    const from = h.logger.records.length;
    try {
      const held = [rig.open(), rig.open(), rig.open(PEER.ipv6Loopback)];
      expect(await Promise.all(held.map((client) => client.opened))).toEqual([true, true, true]);
      expect(rig.ws.stats()).toMatchObject({ pendingHandshakes: 3, pendingPeers: 2 });

      // A peer holding nothing is refused for the global share …
      const global = await rig.upgrade({ peer: PEER.third });
      expectBareRefusal(global, HTTP_TOO_MANY_REQUESTS, retryAfterFor(CLIENT_HELLO_TIMEOUT_MS));
      // … and a peer at its own share for that, which the gate checks first.
      const perPeer = await rig.upgrade();
      expectBareRefusal(perPeer, HTTP_TOO_MANY_REQUESTS, retryAfterFor(CLIENT_HELLO_TIMEOUT_MS));
      expect(rig.ws.stats()).toMatchObject({
        admitted: 3,
        pendingHandshakes: 3,
        refusedUpgrades: 2,
      });

      const refusals = h.logger.records
        .slice(from)
        .filter((record) => record.message === ADMISSION_REFUSED_LOG);
      // The first refusal of the interval is a warning; the next is filed at
      // debug and counted into the warning after it.
      expect(refusals.map((record) => [record.level, record.fields['refusal']])).toEqual([
        ['warn', REFUSAL.pending],
        ['debug', REFUSAL.peer],
      ]);
      expect(refusals[0]?.fields).toMatchObject({
        subsystem: WS_LOG_SUBSYSTEM,
        status: HTTP_TOO_MANY_REQUESTS,
        admitted: 3,
        pendingHandshakes: 3,
        peerPendingHandshakes: 0,
        maxOpenConnections: 8,
        maxPendingHandshakes: 3,
        maxPendingHandshakesPerPeer: 2,
        suppressed: 0,
      });
      expect(refusals[1]?.fields).toMatchObject({ peerPendingHandshakes: 2 });
      for (const record of refusals) {
        for (const leaked of [PEER.third, PEER.ipv6Loopback, rig.host, PEER_HEADER, WS_PATH]) {
          expect(record.line).not.toContain(leaked);
        }
      }
    } finally {
      await rig.close();
    }
  });

  it('answers 503 once the service holds its most sockets in any phase, and admits again when one closes', async () => {
    const rig = await startAdmissionRig(harness(), {
      maxOpenConnections: 3,
      maxPendingHandshakes: 2,
      maxPendingHandshakesPerPeer: 2,
    });
    try {
      const editors = [rig.open(), rig.open()];
      expect(await Promise.all(editors.map((client) => client.opened))).toEqual([true, true]);
      for (const editor of editors) {
        await rig.authenticate(editor);
      }
      const pending = rig.open(PEER.ipv6Loopback);
      expect(await pending.opened).toBe(true);
      expect(rig.ws.stats()).toMatchObject({
        open: 3,
        authenticated: 2,
        awaitingHello: 1,
        admitted: 3,
        pendingHandshakes: 1,
      });

      const refused = await rig.upgrade({ peer: PEER.third });
      expectBareRefusal(refused, HTTP_UNAVAILABLE, retryAfterFor(CLIENT_HELLO_TIMEOUT_MS));
      expect(rig.ws.stats()).toMatchObject({ open: 3, admitted: 3, refusedUpgrades: 1 });

      // An authenticated socket closing gives its slot back.
      editors[0]?.socket.close();
      await editors[0]?.closed;
      await rig.until((stats) => stats.admitted === 2, 'the closed editor gave its slot back');
      const next = rig.open(PEER.third);
      expect(await next.opened).toBe(true);
      expect(rig.ws.stats()).toMatchObject({ admitted: 3, pendingHandshakes: 2 });
    } finally {
      await rig.close();
    }
  });

  it('gives the pending share back when a hello authenticates, so the next upgrade is admitted', async () => {
    const rig = await startAdmissionRig(harness(), {
      maxOpenConnections: 8,
      maxPendingHandshakes: 2,
      maxPendingHandshakesPerPeer: 2,
    });
    try {
      const [first, second] = [rig.open(), rig.open()];
      expect(await Promise.all([first.opened, second.opened])).toEqual([true, true]);
      expectBareRefusal(
        await rig.upgrade(),
        HTTP_TOO_MANY_REQUESTS,
        retryAfterFor(CLIENT_HELLO_TIMEOUT_MS),
      );

      await rig.authenticate(first);
      expect(rig.ws.stats()).toMatchObject({
        authenticated: 1,
        awaitingHello: 1,
        admitted: 2,
        pendingHandshakes: 1,
      });
      const third = rig.open();
      expect(await third.opened).toBe(true);
      expect(rig.ws.stats()).toMatchObject({ admitted: 3, pendingHandshakes: 2 });
    } finally {
      await rig.close();
    }
  });

  it('gives the slot back when an unauthenticated socket times out or drops', async () => {
    const helloTimeoutMs = 1_000;
    const rig = await startAdmissionRig(harness(), {
      maxOpenConnections: 8,
      maxPendingHandshakes: 1,
      maxPendingHandshakesPerPeer: 1,
      helloTimeoutMs,
    });
    try {
      const silent = rig.open();
      expect(await silent.opened).toBe(true);
      expectBareRefusal(
        await rig.upgrade({ peer: PEER.third }),
        HTTP_TOO_MANY_REQUESTS,
        retryAfterFor(helloTimeoutMs),
      );

      expect(await silent.closed).toBe(WS_CLOSE_UNAUTHORIZED);
      await rig.until(
        (stats) =>
          stats.admitted === 0 && stats.pendingHandshakes === 0 && stats.pendingPeers === 0,
        'the timed-out socket gave its slot back',
      );

      const dropped = rig.open();
      expect(await dropped.opened).toBe(true);
      dropped.socket.terminate();
      await dropped.closed;
      await rig.until(
        (stats) => stats.admitted === 0 && stats.pendingHandshakes === 0,
        'the dropped socket gave its slot back',
      );

      const next = rig.open();
      expect(await next.opened).toBe(true);
    } finally {
      await rig.close();
    }
  });

  it('gives the slot back when ws aborts a handshake the gate admitted', async () => {
    const rig = await startAdmissionRig(harness(), {
      maxOpenConnections: 8,
      maxPendingHandshakes: 1,
      maxPendingHandshakesPerPeer: 1,
    });
    try {
      // The gate admits it; `ws` then refuses the malformed key itself and
      // never creates a WebSocket, so only the TCP close can free the slot.
      const aborted = await rig.upgrade({ key: 'not-a-websocket-key' });
      expect(aborted.status).toBe(HTTP_BAD_REQUEST);
      expect(aborted.closedByService).toBe(true);
      await rig.until(
        (stats) =>
          stats.admitted === 0 && stats.pendingHandshakes === 0 && stats.pendingPeers === 0,
        'the aborted handshake gave its slot back',
      );
      expect(rig.ws.stats()).toMatchObject({ open: 0, refusedUpgrades: 0 });

      // With a quota of one, a leaked reservation would refuse this.
      const next = rig.open();
      expect(await next.opened).toBe(true);
      expect(rig.ws.stats()).toMatchObject({ admitted: 1, pendingHandshakes: 1 });
    } finally {
      await rig.close();
    }
  });

  it('reads zero on every admission counter once close() resolves, whatever phase its sockets were in', async () => {
    const rig = await startAdmissionRig(harness(), {
      maxOpenConnections: 8,
      maxPendingHandshakes: 4,
      maxPendingHandshakesPerPeer: 4,
    });
    const authenticated = rig.open();
    const awaiting = rig.open(PEER.ipv6Loopback);
    expect(await Promise.all([authenticated.opened, awaiting.opened])).toEqual([true, true]);
    await rig.authenticate(authenticated);
    expect(rig.ws.stats()).toMatchObject({
      admitted: 2,
      pendingHandshakes: 1,
      pendingPeers: 1,
      authenticated: 1,
      awaitingHello: 1,
    });

    // `close` asserts every counter read zero once `ws.close()` resolved.
    await rig.close();
    expect(await Promise.all([authenticated.closed, awaiting.closed])).toEqual([
      WS_CLOSE_GOING_AWAY,
      WS_CLOSE_GOING_AWAY,
    ]);
  });

  it('answers the running service’s refused upgrades with nosniff and no-store, and nothing the client sent', async () => {
    const h = harness();
    const host = new URL(h.url).hostname;
    const marker = newMarker();

    const offRoute = await rawUpgrade(host, h.port, { path: `/elsewhere?probe=${marker}` });
    expectBareRefusal(offRoute, HTTP_NOT_FOUND, undefined);
    const webOrigin = await rawUpgrade(host, h.port, { origin: `https://${marker}.example` });
    expectBareRefusal(webOrigin, HTTP_FORBIDDEN, undefined);
    for (const response of [offRoute, webOrigin]) {
      expect(response.head).not.toContain(marker);
    }

    // The service's defaults admit an ordinary upgrade.
    const admitted = await rawUpgrade(host, h.port);
    expect(admitted.status).toBe(HTTP_SWITCHING_PROTOCOLS);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 6b. One flooded connection starves nothing
 *
 * The fairness contract of `src/server/ws.ts` — "One connection cannot starve
 * the others" and "Liveness" in its module notes — proved on a WebSocket
 * server of its own, built like the admission rig's over the harness's real
 * access boundary and a fresh registry, but with a telemetry port that costs
 * a fixed number of CPU-bound milliseconds per frame: the synchronous share
 * of the real ingest path, which is what turned a service worker's pre-stall
 * backlog into a service that answered nothing. Every socket is a real `ws`
 * client over loopback, and the harness's own service shares this process —
 * and so its event loop — with the rig, which is what makes its `GET /health`
 * a probe of starvation rather than of a second process.
 * ---------------------------------------------------------------------------------------------- */

/** The CPU each flooded frame costs the rig's telemetry port, in milliseconds. */
const FLOOD_FRAME_COST_MS = 40;

/**
 * The frames of one flood: a backlog of {@link FLOOD_FRAMES} ×
 * {@link FLOOD_FRAME_COST_MS} = 4 s of handling, written in one burst.
 */
const FLOOD_FRAMES = 100;

/**
 * The page-agent events of each flood frame: small frames, so one 64 KiB read
 * holds dozens of them, as a service worker's buffered backlog does — and each
 * still above the size a ping is decoded on arrival at.
 */
const FLOOD_EVENTS_PER_FRAME = 2;

/**
 * What a fresh connection's hello-and-ping round trip, and `GET /health`, may
 * take while the flood drains, in milliseconds: a quarter of the backlog, and
 * several times the few frame-costs a fair server adds to each.
 */
const FAIR_LATENCY_BOUND_MS = 1_000;

/** How long the whole flood may take to drain, with the harness's message allowance on top. */
const FLOOD_DRAIN_TIMEOUT_MS = FLOOD_FRAMES * FLOOD_FRAME_COST_MS + HARNESS_TIMEOUTS.message;

/**
 * The refusal the rig's telemetry port answers every frame with — the code the
 * real route answers a batch for a tab no session is bound to with — so each
 * frame is answered by exactly one `error` naming it, in handling order.
 */
const FLOOD_REFUSAL_MESSAGE = 'The flood rig binds no tab; every batch is refused after its cost.';

/** The `server.ws` record messages of read flow control and of a backlog overflow (`src/server/ws.ts`). */
const READS_PAUSED_LOG =
  'paused reading a connection whose frame backlog reached its high-water mark';
const READS_RESUMED_LOG = 'resumed reading a connection whose frame backlog drained';
const BACKLOG_OVERFLOW_LOG = 'closed a connection whose frame backlog overflowed';

/** Spins for `ms` milliseconds: a frame handler's synchronous cost, which no `await` can hide. */
function burnCpu(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Deliberately empty: the loop's condition is the work.
  }
}

/** One frame a rig socket received, with what the rig had handled when it arrived. */
interface RigArrival {
  readonly message: ProtocolMessage;
  /** `performance.now()` when the socket delivered it. */
  readonly at: number;
  /** How many flood frames the rig's port had handled by then. */
  readonly handled: number;
}

/** A bare DevTools WebSocket to the flood rig, presenting the rig's credential from its origin. */
interface RigSocket {
  readonly socket: NodeWebSocket;
  /** Every protocol frame received, in arrival order. */
  readonly received: readonly RigArrival[];
  /** The close code, once the socket has closed. */
  readonly closed: Promise<number>;
  /** Whether the socket has closed. */
  readonly isClosed: () => boolean;
  /** Writes one envelope. */
  send(message: ProtocolMessage): void;
  /** Resolves with the first frame received that satisfies `predicate`. */
  next(
    predicate: (message: ProtocolMessage) => boolean,
    description: string,
    timeoutMs?: number,
  ): Promise<RigArrival>;
}

/** The flood rig: a WebSocket server of its own with a CPU-bound telemetry port. */
interface FloodRig {
  readonly ws: WsServer;
  /** The ids of the `telemetry.event` frames the port handled, in handling order. */
  readonly handled: readonly string[];
  /** Opens a socket and resolves once it is upgraded; nothing is sent yet. */
  open(): Promise<RigSocket>;
  /** A `client.hello` presenting the rig's DevTools credential. */
  hello(): ProtocolMessage;
  /** Waits until the server's counters satisfy `predicate`. */
  until(predicate: (stats: WsServerStats) => boolean, description: string): Promise<WsServerStats>;
  /** Closes the server, the registry and the listener; answers the counters `close()` left. */
  close(): Promise<WsServerStats>;
}

/** Builds and starts a {@link FloodRig} on the harness service's host. */
async function startFloodRig(h: Harness): Promise<FloodRig> {
  const host = new URL(h.url).hostname;
  const clients = createClientRegistry({ logger: h.logger.root });
  const credential = h.issueDevtoolsCredential();
  const handled: string[] = [];
  let closedRig = false;
  const ws = unwrap(
    createWsServer({
      ...admissionDeps(h, clients, () => undefined),
      telemetry: {
        handleTelemetryEventFrame: ({ message }) => {
          burnCpu(FLOOD_FRAME_COST_MS);
          handled.push(message.id);
          return Promise.resolve(err(new DebuggenError(CODE.tabNotBound, FLOOD_REFUSAL_MESSAGE)));
        },
      },
    }),
    'creating the flood server',
  );
  const listener = createServer((_request, response) => {
    response.statusCode = HTTP_NOT_FOUND;
    response.end();
  });
  unwrap(ws.attach(listener), 'attaching the flood server');
  await new Promise<void>((resolveListen, rejectListen) => {
    listener.once('error', rejectListen);
    listener.listen(0, host, () => {
      resolveListen();
    });
  });
  const address = listener.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The flood rig listener has no TCP port.');
  }
  const wsUrl = unwrap(
    resolveWsUrl(`http://${host}:${String(address.port)}`),
    'resolving the flood rig URL',
  );
  const sockets: RigSocket[] = [];

  const until = async (
    predicate: (stats: WsServerStats) => boolean,
    description: string,
  ): Promise<WsServerStats> => {
    try {
      return await waitUntil(() => {
        const stats = ws.stats();
        return predicate(stats) ? stats : undefined;
      }, description);
    } catch (cause) {
      throw new Error(`${description}; last counters ${JSON.stringify(ws.stats())}`, { cause });
    }
  };

  const open = async (): Promise<RigSocket> => {
    const socket = new NodeWebSocket(wsUrl, [], {
      origin: credential.origin,
      handshakeTimeout: HARNESS_TIMEOUTS.message,
    });
    const received: RigArrival[] = [];
    const errors: string[] = [];
    let isClosed = false;
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        return;
      }
      const decoded = decodeMessage(rawDataToText(data));
      if (!isErr(decoded)) {
        received.push({ message: decoded.value, at: performance.now(), handled: handled.length });
      }
    });
    socket.on('error', (error: Error) => {
      errors.push(error.message);
    });
    const closed = new Promise<number>((resolveClose) => {
      socket.once('close', (code: number) => {
        isClosed = true;
        resolveClose(code);
      });
    });
    const rigSocket: RigSocket = {
      socket,
      received,
      closed,
      isClosed: () => isClosed,
      send(message) {
        socket.send(encodeMessage(message));
      },
      // The arrival time is stamped by the socket's own listener, so the
      // poll's interval never enters a measured latency.
      next: (predicate, description, timeoutMs = HARNESS_TIMEOUTS.message) =>
        waitUntil(
          () => received.find((arrival) => predicate(arrival.message)),
          `${description} (errors: ${errors.join('; ') || 'none'})`,
          timeoutMs,
        ),
    };
    sockets.push(rigSocket);
    const opened = await new Promise<boolean>((resolveOpen) => {
      socket.once('open', () => {
        resolveOpen(true);
      });
      socket.once('close', () => {
        resolveOpen(false);
      });
    });
    if (!opened) {
      throw new Error(`The flood rig refused an upgrade: ${errors.join('; ') || 'no error'}`);
    }
    return rigSocket;
  };

  return {
    ws,
    handled,
    open,
    hello: () =>
      createEnvelope(T.hello, {
        client: KIND.devtools,
        version: PROTOCOL_VERSION,
        token: credential.token,
      }),
    until,
    async close() {
      if (closedRig) {
        return ws.stats();
      }
      closedRig = true;
      await ws.close();
      const after = ws.stats();
      clients.closeAll();
      listener.closeAllConnections();
      await new Promise<void>((resolveClose) => {
        listener.close(() => {
          resolveClose();
        });
      });
      await Promise.all(sockets.map((client) => client.closed));
      return after;
    },
  };
}

/** A burst of {@link FLOOD_FRAMES} `telemetry.event` frames for the flood tab, each a fresh batch. */
function floodFrames(): ProtocolMessage[] {
  return Array.from({ length: FLOOD_FRAMES }, () =>
    createEnvelope(
      T.telemetry,
      { events: browserEvents(FLOOD_EVENTS_PER_FRAME) },
      { tabId: TAB.flood },
    ),
  );
}

/** Opens the rig's flooded connection: upgraded, hello sent, and counted authenticated. */
async function openAuthenticated(rig: FloodRig): Promise<RigSocket> {
  const before = rig.ws.stats().authenticated;
  const socket = await rig.open();
  socket.send(rig.hello());
  await rig.until(
    (stats) => stats.authenticated === before + 1,
    'the hello authenticated the connection',
  );
  return socket;
}

/** Whether `message` is the `service.pong` answering the ping whose id is `pingId`. */
function isPongFor(message: ProtocolMessage, pingId: string): boolean {
  return isMessageOfType(message, T.pong) && message.payload.ref === pingId;
}

describe('one flooded connection starves nothing', () => {
  const harness = useHarness();

  it('answers a fresh connection, GET /health and a ping written behind the flood while it drains, and still handles the flood in order, in full', async () => {
    const h = harness();
    const rig = await startFloodRig(h);
    try {
      const flooded = await openAuthenticated(rig);
      const logFrom = h.logger.records.length;
      const frames = floodFrames();
      // Each frame is a queued frame, never one decoded on arrival.
      for (const frame of frames) {
        expect(Buffer.byteLength(encodeMessage(frame), 'utf8')).toBeGreaterThan(
          EARLY_PING_MAX_FRAME_BYTES,
        );
      }
      const behindFlood = createEnvelope(T.ping, {});
      for (const frame of frames) {
        flooded.send(frame);
      }
      flooded.send(behindFlood);

      // (a) While the backlog drains: a fresh connection upgrades,
      // authenticates and has its ping answered, and the service's own
      // `GET /health` answers — each within the bound, and each before the
      // flood has been handled.
      const healthStart = performance.now();
      const health = h.rawFetch('health').then((response) => ({
        status: response.status,
        at: performance.now(),
        handled: rig.handled.length,
      }));
      const freshStart = performance.now();
      const fresh = await rig.open();
      const freshPing = createEnvelope(T.ping, {});
      fresh.send(rig.hello());
      fresh.send(freshPing);
      const freshPong = await fresh.next(
        (message) => isPongFor(message, freshPing.id),
        'the fresh connection’s ping was answered',
      );
      const healthAnswer = await health;

      expect(freshPong.at - freshStart, 'fresh hello + ping round trip, ms').toBeLessThan(
        FAIR_LATENCY_BOUND_MS,
      );
      expect(freshPong.handled, 'flood frames handled before the fresh pong').toBeLessThan(
        FLOOD_FRAMES,
      );
      expect(healthAnswer.status).toBe(HTTP_OK);
      expect(healthAnswer.at - healthStart, 'GET /health, ms').toBeLessThan(FAIR_LATENCY_BOUND_MS);
      expect(healthAnswer.handled, 'flood frames handled before /health answered').toBeLessThan(
        FLOOD_FRAMES,
      );

      // (b) The ping written after the whole flood is answered on arrival,
      // before the flood's last frames are handled — and on the wire, before
      // their refusals.
      const behindPong = await flooded.next(
        (message) => isPongFor(message, behindFlood.id),
        'the ping behind the flood was answered',
        FLOOD_DRAIN_TIMEOUT_MS,
      );
      expect(behindPong.handled, 'flood frames handled before the pong').toBeLessThan(FLOOD_FRAMES);
      const lastFrameId = frames[frames.length - 1]?.id ?? '';
      const lastRefusal = await flooded.next(
        (message) => isMessageOfType(message, T.error) && message.payload.ref === lastFrameId,
        'the last flood frame was answered',
        FLOOD_DRAIN_TIMEOUT_MS,
      );
      expect(flooded.received.indexOf(behindPong)).toBeLessThan(
        flooded.received.indexOf(lastRefusal),
      );

      // (c) Every frame was handled, once, in the order it was written, and
      // answered in that order; flow control paused and resumed the socket;
      // nothing overflowed and the connection is still open.
      expect(rig.handled).toEqual(frames.map((frame) => frame.id));
      const refusals = flooded.received.flatMap(({ message }) =>
        isMessageOfType(message, T.error) ? [message.payload] : [],
      );
      expect(refusals.map((refusal) => refusal.ref)).toEqual(frames.map((frame) => frame.id));
      expect(new Set(refusals.map((refusal) => refusal.code))).toEqual(new Set([CODE.tabNotBound]));
      const wsMessages = h.logger.records
        .slice(logFrom)
        .filter((record) => record.fields['subsystem'] === WS_LOG_SUBSYSTEM)
        .map((record) => record.message);
      expect(wsMessages).toContain(READS_PAUSED_LOG);
      expect(wsMessages).toContain(READS_RESUMED_LOG);
      expect(wsMessages).not.toContain(BACKLOG_OVERFLOW_LOG);
      expect(flooded.isClosed()).toBe(false);
      expect(flooded.socket.readyState).toBe(NodeWebSocket.OPEN);
      expect(rig.ws.stats()).toMatchObject({ authenticated: 2, pendingFrames: 0, readPaused: 0 });
    } finally {
      await rig.close();
    }
  });

  it('closes a connection whose reads flow control paused at once, leaving no queued frame to run after close()', async () => {
    const h = harness();
    const rig = await startFloodRig(h);
    try {
      const flooded = await openAuthenticated(rig);
      for (const frame of floodFrames()) {
        flooded.send(frame);
      }
      await rig.until(
        (stats) => stats.readPaused === 1,
        'flow control paused the flooded connection',
      );

      const closeStart = performance.now();
      const after = await rig.close();
      const closeMs = performance.now() - closeStart;
      const handledAtClose = rig.handled.length;

      // `close()` ended the paused socket within its closing grace — it did
      // not wait for the backlog, most of which was never handled.
      expect(closeMs, 'close() of a paused connection, ms').toBeLessThan(
        3 * CLOSE_HANDSHAKE_GRACE_MS,
      );
      expect(handledAtClose).toBeLessThan(FLOOD_FRAMES);
      expect(await flooded.closed).toBe(WS_CLOSE_GOING_AWAY);
      expect(after).toMatchObject({
        open: 0,
        authenticated: 0,
        pendingFrames: 0,
        readPaused: 0,
        heartbeatActive: false,
        closed: true,
      });
      // No frame the queue still held runs after `close()` resolved.
      await new Promise<void>((resolveLater) => {
        setTimeout(resolveLater, 5 * FLOOD_FRAME_COST_MS);
      });
      expect(rig.handled).toHaveLength(handledAtClose);
    } finally {
      // Idempotent: answers the same counters when the case already closed it.
      await rig.close();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * 7. Coverage of the protocol surface — runs last, over what the suites above proved
 * ---------------------------------------------------------------------------------------------- */

describe('coverage of the protocol surface', () => {
  it('drove every inbound message type through a live socket, on every facet it has', () => {
    const missing = INBOUND_TYPES.flatMap((type) =>
      (REQUIRED_FACETS[type] ?? [DISPATCHED])
        .filter((facet) => proved.inbound.get(type)?.has(facet) !== true)
        .map((facet) => `${type} (${facet})`),
    );
    expect(missing).toEqual([]);
  });

  it('proved every service-only push refused when a client sends it', () => {
    expect(SERVICE_ONLY_TYPES.filter((type) => !proved.refusedWhenSentByClient.has(type))).toEqual(
      [],
    );
  });

  it('proved a client-sent error frame is refused with an error that names it', () => {
    expect(proved.clientErrorFrameRefused).toBe(true);
  });

  it('proved a client-sent service.pong is refused with an error that names it', () => {
    expect(proved.clientPongFrameRefused).toBe(true);
  });
});
