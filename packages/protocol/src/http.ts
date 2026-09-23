/**
 * The local service's complete HTTP surface: every route, every request and
 * response body, which routes may be called without a credential, and the
 * `DataResult` union that answers a panel-data query.
 *
 * This module is the **only** definition of that surface (AAP §0.9.1). The
 * service registers its routes from the table below, the VS Code extension host
 * and the Chrome service worker call them through it, and a second copy of any
 * shape here — in an app, a test helper or a fetch wrapper — is a defect rather
 * than a convenience, because the two copies can only ever disagree at run
 * time, in the process that receives the body.
 *
 * ## Seventeen routes, and where their names come from
 *
 * Six of the operation keys are the user's own names for these operations
 * (prompt §16), preserved character for character: `session.create`,
 * `session.question`, `session.end`, `capture.start`, `capture.stop` and
 * `telemetry.event`. They are **HTTP operations, not WebSocket message types**.
 * Nothing in this file may enter the envelope's discriminated union, and the
 * twenty-five WebSocket message types — `client.hello`, `session.created`,
 * `session.updated`, `session.progress`, `session.bind`, `session.bound`,
 * `tab.navigated`, `session.unbind`, `target.request`, `target.selected`,
 * `instrumentation.plan`, `instrumentation.ready`, `instrumentation.failed`,
 * `capture.started`, `capture.stopped`, `agent.ready`, `agent.config`,
 * `server-agent.config`, `telemetry.event`, `telemetry.tail`,
 * `analysis.completed`, `panel.generated`, `source.open`, `cleanup.completed`
 * and `error` — live in `./messages/**` and are registered there. One name,
 * `telemetry.event`, is deliberately both: a batch reaches the service over the
 * WebSocket from the page agent's relay and over HTTP from the Node preload,
 * and the two transports carry the same events under the same operation name.
 *
 * The bodies those operations already own are **imported, never restated**:
 * `./messages/session.ts` owns the three session request bodies,
 * `./messages/capture.ts` the four capture bodies and the embedded capture
 * summary, `./messages/error.ts` the one error body both transports share, and
 * `./session-record.ts` the `SessionRecord` and the cleanup vocabulary. This
 * module adds what only a route can have: its method, its path, its parameters,
 * whether it is exempt from authentication, and its response.
 *
 * ## Patterns are for the server; `buildPath` is for the client
 *
 * Each `pattern` is written in hono's `:name` form — `/sessions/:id/capture/start`
 * — because the service registers it verbatim (`apps/local-service/src/server/http.ts`).
 * A client never interpolates a pattern by hand: {@link buildPath} and the named
 * builders beside it substitute each parameter and `encodeURIComponent` it, so a
 * session id that ever contains a path character cannot escape its segment.
 *
 * No base URL, host or port appears here, on purpose. AAP §0.3.4 puts
 * `DEBUGGEN_HOST` (`127.0.0.1`) and `DEBUGGEN_PORT` (`43117`) in the
 * environment; the service reads them at start-up and each client resolves its
 * base URL from configuration (`apps/vscode-extension/src/service/discovery.ts`,
 * `apps/chrome-extension/src/background/ws-bridge.ts`), which is what lets a
 * second service instance run on another port without a code change. The paths
 * below are relative, and {@link WS_PATH} is here for the same reason: so that
 * no client hardcodes it either.
 *
 * ## Two routes are unauthenticated, and only two
 *
 * {@link AUTH_EXEMPT_OPERATIONS} contains exactly `health` and `pair.complete`
 * (AAP §0.5.6). `GET /health` has to answer before a client holds any
 * credential — it is how the extension host decides whether to spawn the
 * service — so it reports the build version, the protocol version and whether
 * pairing is available, and nothing else: no session, no project, no path.
 * `POST /pair/complete` is unauthenticated because its one-time code **is** the
 * capability being presented. Every other route requires
 * `Authorization: Bearer <token>`; the per-route `authExempt` flag and that
 * tuple are proved consistent at compile time below, so they cannot drift.
 *
 * ## No schema here applies a default
 *
 * Not one schema in this package calls `.transform()`, `.coerce`, `.default()`
 * or `.catch()`. That is a contract property rather than a style: a body is
 * parsed on both sides of a boundary, and a schema that filled in a missing
 * value would make the two sides disagree about what was sent. Paging is the
 * case where it matters most — a `DataQuery` may omit `limit` and `offset`, and
 * `apps/local-service/src/panels/data.ts` applies
 * `DATA_QUERY_DEFAULT_LIMIT` / `DATA_QUERY_DEFAULT_OFFSET` when it does. Those
 * constants are imported here only to *document* the request and to bound the
 * echo a response carries; they never fill a request value in.
 *
 * ## Environment
 *
 * Node-neutral, like the rest of this package: `tsconfig.json` declares
 * `types: []` and `tsup.config.ts` builds with `platform: 'neutral'`, so no
 * `node:*` builtin, no `process` and no transport library may enter this graph.
 * This module declares no transport at all — it is schemas, a table and pure
 * functions; `./client/http-client.ts` is what performs a request. Importing it
 * has no side effect beyond building those objects, and every export is named.
 *
 * Consumed by `./client/http-client.ts`, `./index.ts`,
 * `apps/local-service/src/server/http.ts` and its
 * `routes/{sessions,binding,telemetry,panel-data,dev-server,pair,health}.ts`,
 * `apps/local-service/src/panels/data.ts`,
 * `apps/vscode-extension/src/service/{client,process,discovery}.ts`,
 * `apps/chrome-extension/src/background/ws-bridge.ts` and
 * `apps/chrome-extension/src/panel/data-provider.ts`.
 */

import { z } from 'zod';

import { modificationRecordSchema } from '@debuggen/instrumentation';
import type { ModificationRecord } from '@debuggen/instrumentation';
import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  dataQuerySchema,
  panelSpecSchema,
} from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySource, PanelSpec } from '@debuggen/panel-schema';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, Result } from '@debuggen/shared';
import { METRIC_IDS, telemetryEventIngressSchema, telemetryEventSchema } from '@debuggen/telemetry';
import type {
  ComponentTreeSnapshot,
  DependencyGraphData,
  MetricValue,
  QueryGroup,
  RenderStat,
  RequestGroup,
  StateTransition,
  TelemetryEventIngress,
  TraceTree,
} from '@debuggen/telemetry';

import {
  captureStartRequestSchema,
  captureStartResponseSchema,
  captureStopRequestSchema,
  captureStopResponseSchema,
} from './messages/capture.js';
import { errorPayloadSchema } from './messages/error.js';
import {
  sessionCreateRequestSchema,
  sessionEndRequestSchema,
  sessionQuestionRequestSchema,
} from './messages/session.js';
import { cleanupStatusSchema, sessionRecordSchema } from './session-record.js';
import type { SessionRecord } from './session-record.js';
import {
  epochMsSchema,
  opaqueArraySchema,
  opaqueSchema,
  protocolParseError,
  protocolVersionSchema,
  recordWithKeys,
} from './version.js';

// ---------------------------------------------------------------------------
// Section A — the transport facts these schemas are written against
//
// The service's middleware implements the rules below and both extensions have
// to hold the same picture of them, so they are recorded here beside the route
// table rather than left in one implementation's comments (AAP §0.5.6).
//
// AUTHENTICATION. Every route except the two in `AUTH_EXEMPT_OPERATIONS`
// carries `Authorization: Bearer <token>`. A credential is a 32-byte random
// token stored by the service only as a SHA-256 hash, together with its role
// and scope. The editor credential (role `vscode`) is written to
// `$DEBUGGEN_HOME/auth.json` with mode 0600 and read from disk by the extension
// host, which runs as the same user. The DevTools credential (role `devtools`)
// is issued by pairing and scoped to the pairing extension id. The server-agent
// credential (role `server-agent`) is minted per dev-server launch and scoped to
// one `projectRoot`, which is why `POST /telemetry/ingest` carries `projectRoot`
// in its body: the service accepts a batch only for the credential's project.
//
// PAIRING. `POST /pair/complete` is unauthenticated because the one-time code it
// presents *is* the capability: eight characters from a CSPRNG, valid for five
// minutes, single use, and rate-limited (five failures then a sixty-second
// lockout). The code's alphabet and lifetime are the service's generator detail
// and are deliberately not encoded in `pairCompleteRequestSchema` — a schema
// that pinned them would have to change in lockstep with the generator, and a
// stale code is answered by the pairing store, not by a parser.
//
// ROLES ARE NEVER SELF-DECLARED. The service resolves a request's role and
// scope from the presented credential, never from anything the client says
// about itself, so nothing in this file expresses a permission. A route
// definition is a contract — method, path, bodies — and authorization is
// applied on top of it by `apps/local-service/src/server/auth.ts`.
//
// ORIGIN POLICY AND CSRF. Any request or WebSocket upgrade whose `Origin` is an
// `http:` or `https:` web origin is refused. The accepted origins are absent
// (Node clients), `chrome-extension://<id>` and `vscode-webview://*`. No
// `Access-Control-Allow-Origin` header is ever set, so a browser page cannot
// read a response even if it managed to provoke one; that, together with the
// bearer requirement on every state-changing route, is what closes CSRF.
// ---------------------------------------------------------------------------

/**
 * The `Authorization` header's name, lowercase.
 *
 * Lowercase because that is how the web platform normalises a header name:
 * `Headers.get('Authorization')` and `Headers.get('authorization')` are the same
 * lookup, and hono's `c.req.header()` is case-insensitive too, so a single
 * lowercase constant is correct for reading on the service side and for writing
 * on every client side. Exported so no caller spells the name a second time.
 */
export const AUTHORIZATION_HEADER = 'authorization';

/**
 * Formats a credential as an `Authorization` header value.
 *
 * The one place the `Bearer ` prefix is written. `./client/http-client.ts` and
 * `apps/chrome-extension/src/background/ws-bridge.ts` both send it, and
 * `apps/local-service/src/server/auth.ts` strips it; a prefix spelled by hand in
 * three places is a rejection nobody can explain.
 *
 * @param token The bearer credential, as issued by the service.
 * @returns The header value, `Bearer <token>`.
 */
export function formatBearer(token: string): string {
  return `Bearer ${token}`;
}

/**
 * The WebSocket endpoint, on the same HTTP server as every route below.
 *
 * AAP §0.7.1 (Group 2) puts the `ws` server on the service's own HTTP server at
 * `/ws`, so it belongs with the route constants: a client that already resolved
 * its base URL from configuration builds its socket URL from this constant
 * rather than repeating the path. The first frame on that connection is
 * `client.hello`, whose schema is `./messages/agent.ts`'s.
 */
export const WS_PATH = '/ws';

/**
 * The longest an opaque identifier may be in a body here.
 *
 * Matches the bound the sibling payload modules apply. Every identifier this
 * product mints is twenty characters (`<prefix>_<sixteen alphanumerics>`,
 * `ID_PREFIXES` in `@debuggen/shared`), so sixty-four leaves room for a future
 * scheme while keeping a blob of page data out of a field the service uses as a
 * store key.
 */
const MAX_ID_LENGTH = 64;

/**
 * The longest a project root or dev-server command may be.
 *
 * The same bound `./messages/session.ts` applies to `projectRoot`, and a
 * generous one: paths on a developer's own machine are what these fields carry.
 */
const MAX_PATH_LENGTH = 4096;

/** The longest a URL may be, matching `./session-record.ts`'s bound. */
const MAX_URL_LENGTH = 2048;

/**
 * The longest a short opaque token — a pairing code, a credential, a version
 * string — may be.
 *
 * One bound for all three because none of them is inspected here: the service
 * generates them and compares them against its own store, and the only thing a
 * transport schema can usefully refuse is something that is not a short string.
 */
const MAX_OPAQUE_TOKEN_LENGTH = 512;

/**
 * The most events one ingest request may carry.
 *
 * Mirrors the ceiling `./messages/telemetry.ts` applies to the WebSocket batch,
 * and for the same reason: the page agent buffers at most five thousand events
 * while its bridge is away (AAP §0.5.5) and the Node preload's exporter caps its
 * own buffer at the same number, so no honest producer can assemble a larger
 * batch. It is therefore a ceiling on a malformed or hostile request rather
 * than a quota a working capture can reach — in practice the preload posts a
 * few hundred spans per request. The bound is hard because the body is parsed
 * before it is persisted and the parse walks every element: an unbounded array
 * turns one request into unbounded work in the ingest loop and unbounded rows in
 * `telemetry_events`, which is the one place a capture can hurt the machine it
 * is observing.
 */
const MAX_INGEST_EVENTS_PER_REQUEST = 5000;

/** What every identifier field in this module reports when it is refused. */
const ID_EXPECTATION = `expected a non-empty identifier of at most ${String(
  MAX_ID_LENGTH,
)} characters`;

/**
 * An opaque identifier as a body field: non-empty and bounded.
 *
 * Deliberately **not** the `ses_`/`cap_`/`pnl_` prefix grammar. The prefix
 * vocabulary belongs to `@debuggen/shared`'s `ids` module, which mints every id
 * in the product; re-deriving it here would be a second definition of a shape
 * this package does not own, and it would refuse a stored id from a build whose
 * prefixes differed. Identity is resolved where the row lives.
 *
 * @returns A string schema for an opaque product identifier.
 */
function idSchema(): z.ZodString {
  return z.string().min(1, { error: ID_EXPECTATION }).max(MAX_ID_LENGTH, { error: ID_EXPECTATION });
}

/**
 * A project root as a body field: a non-empty, bounded path string.
 *
 * Checked for exactly what a transport can check, matching
 * `./messages/session.ts`'s `projectRoot` field. No absolute-path refinement and
 * no shape grammar: the questions that matter about a path on the developer's own
 * machine — does it exist, is it a directory, does the presented credential's
 * scope cover it (AAP §0.5.6) — are answered by the service, which can resolve a
 * real path. Refusing a plausible path at the transport would only move the
 * failure away from the layer that can explain it.
 *
 * @returns A string schema for a project root path.
 */
function projectRootSchema(): z.ZodString {
  return z
    .string()
    .min(1, { error: 'expected a non-empty project root path' })
    .max(MAX_PATH_LENGTH, {
      error: `expected a project root path of at most ${String(MAX_PATH_LENGTH)} characters`,
    });
}

/**
 * A short opaque token as a body field: a pairing code, a credential or a
 * version string.
 *
 * Shape only, for the reason {@link MAX_OPAQUE_TOKEN_LENGTH} states. The value
 * is compared against the service's own store, never parsed.
 *
 * @returns A string schema for a short opaque token.
 */
function opaqueTokenSchema(): z.ZodString {
  return z
    .string()
    .min(1, { error: 'expected a non-empty value' })
    .max(MAX_OPAQUE_TOKEN_LENGTH, {
      error: `expected a value of at most ${String(MAX_OPAQUE_TOKEN_LENGTH)} characters`,
    });
}

/**
 * An absolute URL as a body field, bounded in length.
 *
 * Matches `./session-record.ts`'s bound and its reasoning: a dev-server URL may
 * arrive query-redacted (each parameter's value replaced, its key and the path
 * kept, AAP §0.5.2) and a redacted URL is still a valid absolute URL, so the
 * check is on shape alone. Not narrowed to `http:`/`https:` either — the origin
 * comparison that decides a tab binding is the service's.
 *
 * @returns A schema for an absolute URL.
 */
function urlSchema(): z.ZodType<string> {
  return z.url({ error: 'expected an absolute URL' }).max(MAX_URL_LENGTH, {
    error: `expected an absolute URL of at most ${String(MAX_URL_LENGTH)} characters`,
  });
}

// ---------------------------------------------------------------------------
// Section B — compile-time assertion helpers
//
// Type-level only: no runtime code, nothing emitted. They exist because several
// guarantees in this file are relationships between two declarations — the
// auth-exempt tuple and the per-route flags, the operation tuple and the route
// table's keys, a mapped body type and the upstream type it must resolve to —
// and a relationship that nothing checks is one that drifts silently.
// ---------------------------------------------------------------------------

/**
 * Fails to compile unless its argument is exactly `true`.
 *
 * A helper that computed `false` violates the `extends true` constraint, which
 * TypeScript reports at the declaration site whether or not anything reads the
 * result.
 */
type AssertTrue<TAssertion extends true> = TAssertion;

/**
 * Whether two types are identical, not merely mutually assignable.
 *
 * The conditional-signature trick: two deferred conditional types are related
 * only when their check types are identical, which is stricter than assignability
 * in both directions and is what catches an optional marker or a widened member
 * that a two-way `extends` test would accept.
 */
type Identical<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

/**
 * Whether every value of one type is a value of another.
 *
 * The weaker of the two tests, and the right one wherever a type reached this
 * file through `z.output` of a schema whose upstream owner also declares the
 * shape by hand — `@debuggen/panel-schema`'s `PanelSpec` is an interface that its
 * schema is asserted to parse *to*, not inferred *from*, so the two are
 * interchangeable in the direction a consumer relies on without being the same
 * type object. {@link Identical} would answer `false` there for a pair that is
 * in fact the contract.
 *
 * Non-distributive by construction: both sides are wrapped in a tuple, so a
 * union on the left is tested as one type instead of member by member, which is
 * what a nullable payload needs.
 */
type AssignableTo<TSource, TTarget> = [TSource] extends [TTarget] ? true : false;

// ---------------------------------------------------------------------------
// Section B2 — the shape of a route definition
// ---------------------------------------------------------------------------

/**
 * The HTTP methods this service uses — and only these two.
 *
 * Reads are `GET` and everything else is `POST`, including the operations that
 * change state on a named resource. No `PUT`, `PATCH` or `DELETE`: nothing here
 * replaces a resource wholesale or removes one, and the two verbs keep the
 * service's own middleware, the extension host's client and the service worker's
 * proxy simpler than a fuller vocabulary would make them. `session.end` is the
 * clearest case — it does not delete the session, it ends it and returns the
 * cleanup outcome, so it is a `POST` to `/sessions/:id/end` rather than a
 * `DELETE`.
 */
export const HTTP_METHODS = ['GET', 'POST'] as const;

/** One of {@link HTTP_METHODS}. */
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Everything the service and its clients need to know about one route.
 *
 * Deliberately data rather than code: the service iterates these definitions to
 * register handlers and to decide which requests its bearer middleware applies
 * to, and a client reads the same object to build a path and validate a body. A
 * route that existed only as a handler registration would be a route no client
 * could discover and no test could enumerate.
 *
 * @typeParam TRequest The request body's schema, or `undefined` for a `GET`,
 * which carries no body.
 * @typeParam TResponse The success response body's schema. Always present: every
 * route in this product answers with a body, and a route that answered with
 * nothing would give a client no way to tell success from a dropped reply.
 */
export interface HttpRouteDefinition<
  TRequest extends z.ZodType | undefined = z.ZodType | undefined,
  TResponse extends z.ZodType = z.ZodType,
> {
  /**
   * The operation's id: the key it is filed under in {@link HTTP_ROUTES},
   * repeated on the definition so a definition passed around on its own can
   * still name itself in a log line or an error.
   */
  readonly operation: string;

  /** The method. */
  readonly method: HttpMethod;

  /**
   * The path in hono's `:name` form, exactly as the service registers it —
   * `/sessions/:id/capture/start`.
   *
   * A client never interpolates this string itself; {@link buildPath} does, and
   * encodes each value.
   */
  readonly pattern: string;

  /**
   * The parameter names in {@link pattern}, in the order they appear.
   *
   * Stated rather than parsed out of the pattern at run time, so
   * {@link buildPath} can tell a missing parameter from a substituted one
   * without a regular expression, and so a test can enumerate what each path
   * needs.
   */
  readonly params: readonly string[];

  /**
   * Whether the route is reachable without `Authorization: Bearer <token>`.
   *
   * `true` for exactly two operations (Section A). The flag lives on the
   * definition because that is what the service's middleware reads, and
   * {@link AUTH_EXEMPT_OPERATIONS} is proved against it at compile time so the
   * two views cannot disagree.
   */
  readonly authExempt: boolean;

  /** The request body's schema, or `undefined` when the route has no body. */
  readonly request: TRequest;

  /** The success response body's schema. */
  readonly response: TResponse;
}

// ---------------------------------------------------------------------------
// Section C — the session routes
//
// `POST /sessions`, `GET /sessions`, `GET /sessions/:id`,
// `POST /sessions/:id/question`, `POST /sessions/:id/end`.
//
// The three request bodies are `./messages/session.ts`'s and are re-exported
// here under their own names so a caller that holds this module holds the whole
// route surface; they are not redeclared. The responses are this module's,
// because the session record and the cleanup vocabulary belong to
// `./session-record.ts` and a route is what binds them to a status code.
// ---------------------------------------------------------------------------

export {
  /**
   * The `session.create` request body, `{ projectRoot, question, target? }`.
   *
   * Defined by `./messages/session.ts` and re-exported unchanged: one schema
   * object, two import paths, no second definition. Bound below to
   * `POST /sessions`, whose response is the created {@link SessionRecord}.
   */
  sessionCreateRequestSchema,
  /**
   * The `session.question` request body, `{ question }` — a follow-up on an
   * existing session, which the route names.
   *
   * Defined by `./messages/session.ts`. Bound below to
   * `POST /sessions/:id/question`, whose response is the updated
   * {@link SessionRecord}: a client learns which follow-up path the service took
   * from the frames that follow, never from this reply.
   */
  sessionQuestionRequestSchema,
  /**
   * The `session.end` request body: `{}`, and strictly that.
   *
   * Defined by `./messages/session.ts`. Ending a session is not
   * parameterisable — cleanup restores every non-reverted modification of the
   * session in reverse order (AAP §0.5.1), and a body that could skip a step
   * would be a way for a client to leave a working tree instrumented.
   */
  sessionEndRequestSchema,
} from './messages/session.js';
export type {
  SessionCreateRequest,
  SessionEndRequest,
  SessionQuestionRequest,
} from './messages/session.js';

/**
 * The `GET /sessions` response: every session the service holds, for the editor's
 * Sessions tree.
 *
 * Wrapped in an object rather than returned as a bare array, so the reply can
 * grow a field — a retention cut-off, a count — without becoming a different
 * JSON type and breaking every client at once.
 *
 * Deliberately **unbounded**. Every other list in this package carries a
 * maximum, and the difference is who produces it: an ingest batch comes from a
 * page-side agent and needs a ceiling, while this array is assembled by the
 * service from its own store, whose size `store/retention.ts` already bounds by
 * `DEBUGGEN_RETENTION_DAYS`. A cap here would be a guess that refuses a
 * legitimate response and empties the Sessions tree of a developer who debugs a
 * lot.
 *
 * Consumed by `apps/vscode-extension/src/views/sessions-tree.ts` and
 * `apps/local-service/src/server/routes/sessions.ts`.
 */
export const sessionListResponseSchema = z.strictObject({
  /** The sessions, as the service's store holds them. */
  sessions: z.array(sessionRecordSchema),
});

/** The validated `GET /sessions` response body. */
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

/**
 * The `session.end` response: what cleanup concluded.
 *
 * One field, and it is a **status rather than the whole cleanup record**
 * (AAP §0.4.2: `{}` → `{ cleanup: CleanupStatus }`). The conflicts a partial or
 * conflicted cleanup produced arrive on the `cleanup.completed` frame
 * (`./messages/cleanup.ts`), which every client of the session receives, and the
 * session's own `cleanup` field keeps them for a reopened session; the caller
 * that pressed "End session" needs to know which of the four outcomes it got so
 * it can show the right thing immediately.
 *
 * `clean` and `conflict` are both successful replies. A conflict means the tool
 * refused to overwrite a file the developer edited while it was instrumented and
 * left the original in the backup directory (AAP §0.5.1) — the correct
 * behaviour, reported honestly, not a failed request.
 */
export const sessionEndResponseSchema = z.strictObject({
  /**
   * The session's cleanup state after the pass ran, over
   * `./session-record.ts`'s four-value vocabulary: `pending`, `clean`, `partial`
   * or `conflict`.
   */
  cleanup: cleanupStatusSchema,
});

/** The validated `session.end` response body. */
export type SessionEndResponse = z.infer<typeof sessionEndResponseSchema>;

// ---------------------------------------------------------------------------
// Section D — the capture routes
//
// `POST /sessions/:id/capture/start`, `POST /sessions/:id/capture/stop`.
//
// All four bodies are `./messages/capture.ts`'s and are re-exported here. What
// this module adds is the conflict reply: AAP §0.4.2 gives at most one session a
// capture on a project at a time, and a start for a project another session is
// already capturing answers `409` with the owning session's id.
// ---------------------------------------------------------------------------

export {
  /**
   * The `capture.start` request body: `{}`.
   *
   * Defined by `./messages/capture.ts`. The session comes from the route, the
   * armed hooks come from its record, and the capture's id is minted by the
   * service rather than proposed by the caller.
   */
  captureStartRequestSchema,
  /**
   * The `capture.start` response body: `{ captureId }`.
   *
   * Defined by `./messages/capture.ts` and re-exported here, as that module's
   * header directs. The caller gets the id in its own reply while every other
   * client of the session learns the same fact from the `capture.started` frame.
   */
  captureStartResponseSchema,
  /**
   * The `capture.stop` request body: `{}`.
   *
   * Defined by `./messages/capture.ts`. A session has at most one open capture,
   * so naming it would add a way for a caller to be wrong rather than a way to
   * be precise.
   */
  captureStopRequestSchema,
  /**
   * The `capture.stop` response body: `{ summary }`, carrying
   * `@debuggen/telemetry`'s `CaptureSummary`.
   *
   * Defined by `./messages/capture.ts`, where the summary field is the
   * sanctioned `opaqueSchema<CaptureSummary>` wrapper — telemetry owns the type
   * and ships no Zod schema for it, so the type keeps coming from its owner. A
   * capture that collected nothing answers here too, with a valid summary whose
   * `eventCount` is zero (AAP §0.5.5); the emptiness is a fact about the
   * capture, read off the summary rather than off an error.
   */
  captureStopResponseSchema,
} from './messages/capture.js';
export type {
  CaptureStartRequest,
  CaptureStartResponse,
  CaptureStopRequest,
  CaptureStopResponse,
} from './messages/capture.js';

/**
 * The error code a capture-ownership conflict is reported with.
 *
 * `CAPTURE_ALREADY_ACTIVE`, from `@debuggen/shared`'s closed vocabulary — named
 * once here so the service's route and every client's handling agree on it
 * without either inventing a string. `satisfies DebuggenErrorCode` is what makes
 * a typo a compile error rather than a code no user interface can switch on.
 */
export const CAPTURE_CONFLICT_ERROR_CODE = 'CAPTURE_ALREADY_ACTIVE' satisfies DebuggenErrorCode;

/**
 * The `409` body of `capture.start`: the shared error payload plus the id of the
 * session that already holds the capture.
 *
 * AAP §0.4.2 allows one capture per project's dev server at a time, enforced by
 * `apps/local-service/src/sessions/manager.ts`, and specifies this reply as
 * `409 { owningSessionId }`. Built by **extending** `./messages/error.ts`'s
 * payload rather than by writing a third error shape, so a client gets a
 * renderable `code` and `message` from the same field set it already handles for
 * every other failure, plus the one machine-readable field this case adds.
 *
 * `owningSessionId` — not `code` — is the distinguishing field. `code` is left
 * as the full vocabulary on purpose: a `409` that is *not* an ownership conflict
 * (a session asked to start a second capture of its own, reported as
 * `SESSION_INVALID_STATE`) carries no owning session and parses as a plain
 * {@link httpErrorResponseSchema}, so a client tries this schema first and falls
 * back to that one. Where the conflict *is* an ownership conflict, the code is
 * {@link CAPTURE_CONFLICT_ERROR_CODE}.
 *
 * The id lets both surfaces say something useful — "Another session is capturing
 * this project" with a link that reopens it — instead of showing a bare
 * conflict.
 */
export const captureStartConflictResponseSchema = errorPayloadSchema.extend({
  /** The session that currently holds the capture on this project. */
  owningSessionId: idSchema(),
});

/** The validated `409` body of `capture.start`. */
export type CaptureStartConflictResponse = z.infer<typeof captureStartConflictResponseSchema>;

// ---------------------------------------------------------------------------
// Section E — the panel routes
//
// `POST /sessions/:id/panel-data`, `GET /sessions/:id/panel`,
// `GET /sessions/:id/panels/:panelId`.
// ---------------------------------------------------------------------------

/**
 * The `POST /sessions/:id/panel-data` request body: a `DataQuery`, exactly as
 * `@debuggen/panel-schema` defines it.
 *
 * This is the imported schema **itself**, bound by identity rather than cloned
 * or wrapped: a panel node's `query` is what a client sends, so the body a
 * renderer's `DataProvider` posts is byte-identical to the node it came from
 * (`packages/panel-renderer/src/host/useQuery.ts` →
 * `apps/chrome-extension/src/panel/data-provider.ts`). Wrapping it in
 * `{ query: … }` would make the two shapes differ for no gain, and re-declaring
 * its fields would be the second definition AAP §0.9.1 forbids — the node
 * catalog's per-node source constraints are validated against *that* schema, and
 * a copy here would drift from them silently.
 *
 * Semantics the service implements (AAP §0.4.2), stated here because this schema
 * is the contract: `filter` narrows the source; `sort` orders with a stable
 * secondary key (each source's `id`) so equal keys never reorder between pages;
 * `limit` and `offset` page the array-valued sources, and the response echoes
 * `total` and `nextOffset` so a view never has to guess whether more remain.
 * **No default is applied by this schema.** An omitted `limit` means
 * `DATA_QUERY_DEFAULT_LIMIT` and an omitted `offset` means
 * `DATA_QUERY_DEFAULT_OFFSET`, both applied by
 * `apps/local-service/src/panels/data.ts`; `limit: 0` is a legitimate request
 * for no items and is not the same as an omitted one.
 */
export const panelDataRequestSchema = dataQuerySchema;

/**
 * The validated panel-data request body.
 *
 * An alias of `@debuggen/panel-schema`'s `DataQuery`, so a consumer can name the
 * role without acquiring a second type for one shape.
 */
export type PanelDataRequest = DataQuery;

/**
 * The `GET /sessions/:id/panel` response: the session's current panel, or `null`.
 *
 * `null` is a **success**, and the reason this route is not a 404: a session that
 * has not reached `generated` yet simply has no panel, and the DevTools panel
 * renders `EmptyPanel` for it rather than handling an error. `.nullable()` is a
 * validation constraint, not a transform, so it is permitted here.
 *
 * A panel whose `meta.fallback` is `true` is also a success (AAP §0.5.5): the
 * model's specification failed validation and the service assembled a
 * deterministic one from the capture's aggregates, which `PanelHost` renders
 * under a visible banner. Fallback is a rendering state, never an error reply.
 */
export const panelResponseSchema = z.strictObject({
  /** The current panel specification, or `null` when none has been generated. */
  panel: panelSpecSchema.nullable(),
});

/** The validated `GET /sessions/:id/panel` response body. */
export type PanelResponse = z.infer<typeof panelResponseSchema>;

/**
 * The `GET /sessions/:id/panels/:panelId` response: one specific panel.
 *
 * Not nullable, and that asymmetry with {@link panelResponseSchema} is the
 * point: a named panel that does not exist is a `404` with an error body, because
 * the caller asked for something by id and a `null` would let it believe the
 * panel exists and is empty. A session's panel ids are on its record, and every
 * version a follow-up produced stays fetchable — `supersedes` on the newer spec
 * is what orders them (AAP §0.4.2).
 */
export const panelByIdResponseSchema = z.strictObject({
  /** The requested panel specification. */
  panel: panelSpecSchema,
});

/** The validated `GET /sessions/:id/panels/:panelId` response body. */
export type PanelByIdResponse = z.infer<typeof panelByIdResponseSchema>;

/**
 * The `GET /sessions/:id/modifications` response: the session's modification
 * journal.
 *
 * `@debuggen/instrumentation`'s `modificationRecordSchema`, imported, so every
 * entry carries the original and instrumented SHA-256 hashes, the backup path,
 * the unified diff, its status and — on a follow-up chain — the
 * `previousRecordId` cleanup restores in strict reverse order. This is the list
 * the product's reversibility promise is made of, and the list both surfaces
 * render: the editor's `ModificationsList` with its `DiffView`, and the DevTools
 * `SessionSummary`.
 *
 * Unbounded for the reason {@link sessionListResponseSchema} is: the service
 * assembles it from its own journal, whose length the session record already
 * bounds, and a ceiling here would refuse the one reply a developer most needs
 * to see.
 */
export const modificationsResponseSchema = z.strictObject({
  /** Every modification this session recorded, in the order they were applied. */
  modifications: z.array(modificationRecordSchema),
});

/** The validated `GET /sessions/:id/modifications` response body. */
export type ModificationsResponse = z.infer<typeof modificationsResponseSchema>;

// ---------------------------------------------------------------------------
// Section F — the telemetry ingest route
//
// `POST /telemetry/ingest`.
//
// RECONCILIATION, recorded so a later reader does not "fix" it by deleting the
// route: this package's folder brief lists the HTTP surface and ends with
// "Nothing else.", omitting this route — but AAP §0.4.2 mandates it by name
// ("`telemetry.event` · HTTP `POST /telemetry/ingest` | Node preload
// (server-agent) → service | `{ projectRoot, events: TelemetryEventIngress[] }`"),
// its process edge appears in that section's architecture diagram, and
// `apps/local-service/src/server/routes/telemetry.ts` exists to serve it. The
// AAP has primary authority, so the table below has seventeen routes.
//
// Note which side of the wire reads this definition. `@debuggen/telemetry` sits
// BELOW this package in the layering (AAP §0.2.2) and may not import it, so the
// Node preload learns where to post from `DEBUGGEN_INGEST_URL` and validates
// nothing against this table; the table is the canonical definition for the
// SERVICE, which registers the route, and for any future client of it.
// ---------------------------------------------------------------------------

/**
 * The `telemetry.event` ingest body: which project the spans belong to, and the
 * spans.
 *
 * The **ingress** event schema, never the persisted one. `sessionId`, `captureId`
 * and `ingestSeq` are assigned by `apps/local-service/src/telemetry/ingest.ts`
 * when it attributes a batch to the active capture, and the strict ingress schema
 * refuses an element that carries them — so a producer cannot claim a session,
 * and a batch that tried to is rejected at the boundary rather than trusted into
 * the store. `packages/telemetry/src/schema/event.test.ts` proves those three
 * keys are the only difference between the two schemas; this route inherits the
 * guarantee by embedding the narrower one.
 *
 * `projectRoot` is in the body because the server-agent credential is scoped to
 * exactly one project (AAP §0.5.6): the service accepts the batch only when the
 * field matches the credential's scope, which is what stops one project's dev
 * server from posting spans into another project's session.
 */
export const telemetryIngestRequestSchema = z.strictObject({
  /** The project whose dev server produced these spans. */
  projectRoot: projectRootSchema(),

  /**
   * The batch, each element validated as a producer's event.
   *
   * Non-empty — an empty batch costs a request, a parse and a log line to say
   * nothing, which is a producer bug worth naming — and bounded by
   * {@link MAX_INGEST_EVENTS_PER_REQUEST}.
   */
  events: z
    .array(telemetryEventIngressSchema)
    .min(1, { error: 'expected at least one telemetry event: an empty batch is a no-op' })
    .max(MAX_INGEST_EVENTS_PER_REQUEST, {
      error: `expected at most ${String(
        MAX_INGEST_EVENTS_PER_REQUEST,
      )} telemetry events in one request`,
    }),
});

/** The validated `POST /telemetry/ingest` request body. */
export type TelemetryIngestRequest = z.infer<typeof telemetryIngestRequestSchema>;

/**
 * The ingest response: how many events the service took, and how many it
 * refused.
 *
 * A partial answer is the honest one. Ingest validates, keys, redacts and
 * attributes each element, and an event that fails one of those steps is dropped
 * rather than allowed to fail the whole batch — one malformed span must never
 * cost a capture (AAP §0.5.5) — so the producer is told the count instead of
 * receiving an error for a request that mostly worked. `rejected` is absent
 * when nothing was rejected, so the common reply says so by omission.
 */
export const telemetryIngestResponseSchema = z.strictObject({
  /** How many events were stored. */
  accepted: z.int().nonnegative({ error: 'expected a non-negative accepted count' }),

  /** How many events were dropped, when any were. */
  rejected: z.int().nonnegative({ error: 'expected a non-negative rejected count' }).optional(),
});

/** The validated `POST /telemetry/ingest` response body. */
export type TelemetryIngestResponse = z.infer<typeof telemetryIngestResponseSchema>;

// ---------------------------------------------------------------------------
// Section G — the dev-server routes
//
// `POST /dev-server/launch`, `POST /dev-server/stop`.
// ---------------------------------------------------------------------------

/**
 * The `POST /dev-server/launch` request: which project, and optionally how.
 *
 * The service probes for a dev server already serving the project and, failing
 * that, spawns one with the telemetry preload attached
 * (`apps/local-service/src/dev-server/{detect,launcher}.ts`) — which is how
 * server and database spans become available without the developer editing
 * their project. `command` overrides the command the launcher would otherwise
 * derive from the target's own `package.json` scripts; it is optional because
 * deriving it is the normal path and naming it is the escape hatch.
 */
export const devServerLaunchRequestSchema = z.strictObject({
  /** The project whose dev server should be running. */
  projectRoot: projectRootSchema(),

  /**
   * The command to run instead of the derived one, when the caller knows better.
   *
   * Bounded text. The launcher supplies the preload and the credential through
   * the child's environment, never through this string, so a command given here
   * does not have to know anything about instrumentation.
   */
  command: z
    .string()
    .min(1, { error: 'expected a non-empty command' })
    .max(MAX_PATH_LENGTH, {
      error: `expected a command of at most ${String(MAX_PATH_LENGTH)} characters`,
    })
    .optional(),
});

/** The validated `POST /dev-server/launch` request body. */
export type DevServerLaunchRequest = z.infer<typeof devServerLaunchRequestSchema>;

/**
 * The `POST /dev-server/launch` response: where the server is, and which process
 * it is.
 *
 * `devServerUrl` is what a session records and what a tab binding's origin is
 * compared against; `pid` is what ties the child's lifetime to the session and
 * what the stop route ends. A launch that failed is an error reply with a hint
 * carrying the exact relaunch command (AAP §0.5.5), not a success with a missing
 * field.
 */
export const devServerLaunchResponseSchema = z.strictObject({
  /** The base URL the dev server is serving on. */
  devServerUrl: urlSchema(),

  /** The launched process's id. */
  pid: z.int().positive({ error: 'expected a positive process id' }),
});

/** The validated `POST /dev-server/launch` response body. */
export type DevServerLaunchResponse = z.infer<typeof devServerLaunchResponseSchema>;

/**
 * The `POST /dev-server/stop` request: which project's launched server to stop.
 *
 * Keyed by project rather than by pid, because the service owns the child it
 * launched and a caller that named a pid could ask it to end a process it never
 * started. A dev server the developer started themselves is not the service's to
 * stop, and this route does not touch one.
 */
export const devServerStopRequestSchema = z.strictObject({
  /** The project whose launched dev server should stop. */
  projectRoot: projectRootSchema(),
});

/** The validated `POST /dev-server/stop` request body. */
export type DevServerStopRequest = z.infer<typeof devServerStopRequestSchema>;

/**
 * The `POST /dev-server/stop` response: whether there was one to stop.
 *
 * `false` is a success: it means the service had launched no dev server for that
 * project, which is the state the caller asked for. Idempotence matters here
 * because the editor calls this on deactivation, where a retry must not report a
 * failure.
 */
export const devServerStopResponseSchema = z.strictObject({
  /** Whether a launched dev server was found and stopped. */
  stopped: z.boolean({ error: 'expected a boolean stopped flag' }),
});

/** The validated `POST /dev-server/stop` response body. */
export type DevServerStopResponse = z.infer<typeof devServerStopResponseSchema>;

// ---------------------------------------------------------------------------
// Section H — health and pairing
//
// `GET /health`, `POST /pair/start`, `POST /pair/complete`. The first and the
// last are the only two unauthenticated routes in the product.
// ---------------------------------------------------------------------------

/**
 * The `GET /health` response: version and pairing availability, and nothing
 * else.
 *
 * The minimality is the contract. This is the one informational route that
 * answers without a credential — the extension host calls it to decide whether
 * to spawn the service, and the DevTools panel to decide whether to show "Service
 * not running" — so it must reveal nothing about the machine it runs on: no
 * session, no project root, no file path, no counts (AAP §0.5.6). `strictObject`
 * over exactly three fields is what keeps a later convenience field from being
 * added here without someone noticing, and `packages/protocol/src/__tests__/http.test.ts`
 * refuses a fourth field explicitly.
 */
export const healthResponseSchema = z.strictObject({
  /**
   * The service build's own version string, from its `package.json`.
   *
   * Shape only: a version a client displays and logs, never parses.
   */
  version: opaqueTokenSchema(),

  /**
   * The wire version this build speaks, validated by `./version.ts`'s schema.
   *
   * What a client compares against its own `PROTOCOL_VERSION` before it opens a
   * socket, so an incompatible pair fails at the handshake with something to say
   * rather than on the first frame neither side understands.
   */
  protocolVersion: protocolVersionSchema,

  /**
   * Whether a pairing code can be requested right now.
   *
   * `false` means no editor client has connected, so there is nobody to display
   * a code, and the DevTools panel says so instead of offering a dialog that
   * cannot be satisfied.
   */
  pairingAvailable: z.boolean({ error: 'expected a boolean pairingAvailable flag' }),
});

/** The validated `GET /health` response body. */
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * The `POST /pair/start` request body: `{}`.
 *
 * The editor credential the request carries is the whole input — the service
 * mints the code, and a caller that could propose one would be choosing its own
 * capability. Strict over an empty shape, so a body carrying a key is refused
 * rather than silently ignored.
 */
export const pairStartRequestSchema = z.strictObject({});

/** The validated `POST /pair/start` request body. */
export type PairStartRequest = z.infer<typeof pairStartRequestSchema>;

/**
 * The `POST /pair/start` response: the code to read out, and when it dies.
 *
 * The code is shown in the editor's `PairingCode` view and typed into the
 * DevTools panel's `PairDialog`. Its alphabet and length are the service's
 * generator detail (Section A) and are not pinned here; `expiresAt` is what lets
 * the editor count down and stop offering a code that no longer works.
 */
export const pairStartResponseSchema = z.strictObject({
  /** The one-time pairing code, to be shown to the developer. */
  code: opaqueTokenSchema(),

  /** When the code stops being accepted, in Unix epoch milliseconds. */
  expiresAt: epochMsSchema,
});

/** The validated `POST /pair/start` response body. */
export type PairStartResponse = z.infer<typeof pairStartResponseSchema>;

/**
 * The `POST /pair/complete` request: the code, presented from the extension's
 * own origin.
 *
 * Unauthenticated, because the code **is** the credential being exchanged.
 * Everything that makes that safe is the service's: single use, five-minute
 * validity, a rate limit of five failures then a sixty-second lockout, and the
 * same origin policy every other route applies — the `chrome-extension://<id>`
 * origin the request arrives from becomes the scope of the credential it
 * returns, so a code observed elsewhere cannot be redeemed into a usable one.
 */
export const pairCompleteRequestSchema = z.strictObject({
  /** The one-time code the developer copied from the editor. */
  code: opaqueTokenSchema(),
});

/** The validated `POST /pair/complete` request body. */
export type PairCompleteRequest = z.infer<typeof pairCompleteRequestSchema>;

/**
 * The `POST /pair/complete` response: the DevTools credential.
 *
 * Stored by `apps/chrome-extension/src/background/auth.ts` in
 * `chrome.storage.local` and sent on every subsequent request as
 * {@link formatBearer}'s output and in the socket's `client.hello`. It is scoped
 * to the extension id that redeemed the code and is refused from any other
 * origin.
 */
export const pairCompleteResponseSchema = z.strictObject({
  /** The bearer credential for the paired DevTools client. */
  token: opaqueTokenSchema(),
});

/** The validated `POST /pair/complete` response body. */
export type PairCompleteResponse = z.infer<typeof pairCompleteResponseSchema>;

/**
 * The body every non-2xx response carries: `./messages/error.ts`'s payload,
 * unchanged.
 *
 * One error shape for both transports is the point. A client that already knows
 * how to render an `error` frame — code, message, optional correlation `ref` —
 * renders a failed request the same way, and `DebuggenError.toPayload()` remains
 * the single producer path on the service side through `toErrorPayload`.
 *
 * Note what the shape does *not* carry: a `hint`. AAP §0.4.2 specifies the
 * generic error payload as exactly `{ code, message, ref? }`, and
 * `./messages/error.ts` holds that line with a compile-time drift guard; the
 * recovery hint travels on the messages that specify one of their own, such as
 * `instrumentation.failed`. Aliased rather than re-declared, so there is one
 * schema object and one type.
 */
export const httpErrorResponseSchema = errorPayloadSchema;

/** The validated error body of a non-2xx response. */
export type HttpErrorResponse = z.infer<typeof httpErrorResponseSchema>;

// ---------------------------------------------------------------------------
// Section I — `DataResult`: what a panel-data query answers
//
// The most consequential type in this file: every visualization component in
// `@debuggen/panel-renderer` ultimately renders one of these, resolved through
// `PanelHost`'s `DataProvider` from the `DataQuery` on its node. AAP §0.4.2
// fixes the mapping from source to payload, and `DATA_QUERY_SOURCES` in
// `@debuggen/panel-schema` states outright that its ten members are "exactly
// the discriminants of the `DataResult` union returned by
// `POST /sessions/:id/panel-data`". The union below is the other half of that
// promise, and `DataResultCoversQueryVocabulary` proves it at compile time.
//
// Eight of the ten payloads are shapes `@debuggen/telemetry` publishes as
// TypeScript interfaces with no Zod schema of their own — `TraceTree`,
// `RenderStat`, `ComponentTreeSnapshot`, `RequestGroup`, `QueryGroup`,
// `StateTransition`, `DependencyGraphData`, `MetricValue`. Their **types** keep
// coming from their owner through `import type` and `./version.ts`'s
// `opaqueSchema` / `opaqueArraySchema` supply a shallow runtime guard: a
// hand-written copy of each shape here would be the second definition AAP §0.2.3
// forbids, and would fork telemetry's aggregation logic at the same time. The
// guard is shallow on purpose — these values are computed inside the service by
// the package that defines them, and the failure a transport boundary actually
// sees is a missing field, an `undefined`, or a JSON round trip that dropped a
// value. It is never omitted, because `z.custom<T>()` with no check accepts
// `undefined` and would let an absent payload through as a valid `T`.
//
// The two remaining payloads carry the **persisted** `telemetryEventSchema`,
// which does have a schema and is therefore imported as one: stored events carry
// `sessionId`, `captureId` and `ingestSeq`, so the ingress schema would be the
// wrong one and `DataResultSpansCarryPersistedEvents` proves which is embedded.
// ---------------------------------------------------------------------------

/** What an oversized page is refused with. */
const PAGE_ITEMS_MAX_EXPECTATION = `expected at most ${String(
  DATA_QUERY_MAX_LIMIT,
)} items in one page`;

/**
 * Bounds an array-valued payload by the largest page a query may ask for.
 *
 * A page can never legitimately exceed the request's own `limit` ceiling, so the
 * bound is a statement of that rather than a new policy — and it keeps one
 * malformed response from becoming unbounded parse work in the DevTools panel,
 * which runs in the same process as the page being debugged.
 *
 * @typeParam S The element schema.
 * @param items The array schema to bound.
 * @returns The same array schema with the page ceiling applied.
 */
function boundedPage<S extends z.ZodType>(items: z.ZodArray<S>): z.ZodArray<S> {
  return items.max(DATA_QUERY_MAX_LIMIT, { error: PAGE_ITEMS_MAX_EXPECTATION });
}

/**
 * The paging echo every array-valued result carries, as a spreadable shape.
 *
 * Exported as a shape rather than only as a schema so
 * `apps/local-service/src/panels/data.ts` can build a page object against the
 * same four fields it will be validated by, and so the union members below share
 * one declaration instead of four repeated ones.
 *
 * What the four fields mean, and who computes them: `total` is how many items
 * the filtered source holds in full, which is what lets a view say "20 of 137";
 * `limit` and `offset` echo what the service actually applied, including the
 * defaults it filled in for an omitted field; `nextOffset` is the offset of the
 * following page, or `null` on the last one, so a caller pages without
 * arithmetic.
 */
export const dataPageShape = {
  /**
   * How many items the filtered source holds in total, before paging.
   *
   * A whole number, and zero is an ordinary answer: a capture with no renders
   * reports `total: 0` and the component renders its `EmptyState`.
   */
  total: z
    .int()
    .min(0, { error: 'expected a non-negative total' })
    .describe('How many items the filtered source holds in total, before limit and offset.'),

  /**
   * The page size the service applied.
   *
   * Bounded by `DATA_QUERY_MAX_LIMIT`, the same ceiling the request's own `limit`
   * carries. **Non-negative rather than positive**, deliberately:
   * `dataQuerySchema` accepts `limit: 0` as an explicit request for no items, and
   * an echo that could not report what was applied would refuse a response to a
   * legitimate request.
   */
  limit: z
    .int()
    .min(0, { error: 'expected a non-negative limit' })
    .max(DATA_QUERY_MAX_LIMIT, { error: PAGE_ITEMS_MAX_EXPECTATION })
    .describe(
      `The page size the service applied: the request's own limit, or the default of ${String(
        DATA_QUERY_DEFAULT_LIMIT,
      )} items when it omitted one.`,
    ),

  /**
   * The offset the service applied — how many items it skipped.
   *
   * Never negative. A request that omitted `offset` is answered with the default
   * the service filled in.
   */
  offset: z
    .int()
    .min(0, { error: 'expected a non-negative offset' })
    .describe(
      `How many items were skipped before this page: the request's own offset, or the default of ${String(
        DATA_QUERY_DEFAULT_OFFSET,
      )} when it omitted one.`,
    ),

  /**
   * The offset to ask for next, or `null` when this page is the last one.
   *
   * `null` rather than an absent key, because absence and "no more pages" would
   * otherwise be indistinguishable after a JSON round trip, and a paging loop
   * that guessed would either stop early or never stop.
   */
  nextOffset: z
    .int()
    .min(0, { error: 'expected a non-negative nextOffset' })
    .nullable()
    .describe('The offset of the following page, or null when this page is the last one.'),
};

/**
 * The paging echo as a schema of its own.
 *
 * Validated as part of each array-valued union member below; exported separately
 * so the service's resolver and the panel's data provider can check a page
 * object in isolation, and so a test can pin the bounds without building a whole
 * result.
 */
export const dataPageSchema = z.strictObject(dataPageShape);

/** The validated paging echo of an array-valued panel-data result. */
export type DataPage = z.infer<typeof dataPageSchema>;

/**
 * `source: 'trace'` — one correlated interaction as an ordered tree, spanning
 * every tier.
 *
 * Not paged: a tree is one value, and a caller that asked for a trace named it
 * with a `traceId` filter. `null` when no trace in the capture matched that
 * filter, which is an ordinary answer for a session whose capture collected
 * nothing correlated — the timeline renders its empty state instead of an error.
 */
const traceDataResultSchema = z.strictObject({
  source: z.literal('trace'),
  trace: opaqueSchema<TraceTree>('TraceTree', recordWithKeys('traceId', 'roots')).nullable(),
});

/**
 * `source: 'spans'` — the capture's span-shaped records, flat and paged.
 *
 * The view for ranking work by duration across tiers, which is what the
 * "slowest operations" table reads.
 */
const spansDataResultSchema = z.strictObject({
  source: z.literal('spans'),
  spans: boundedPage(z.array(telemetryEventSchema)),
  ...dataPageShape,
});

/**
 * `source: 'events'` — every captured record, flat, in capture order, paged.
 *
 * The same element schema as `spans` and a different intent: a chronological log
 * rather than a ranking, which is why the event log's rows carry `seq` and the
 * span table's carry `duration`.
 */
const eventsDataResultSchema = z.strictObject({
  source: z.literal('events'),
  events: boundedPage(z.array(telemetryEventSchema)),
  ...dataPageShape,
});

/**
 * `source: 'renders'` — per-component render statistics, paged.
 *
 * Counts, timing, the trigger histogram and the changed-prop keys behind a
 * re-render question, computed by `packages/telemetry/src/aggregate/renders.ts`.
 */
const rendersDataResultSchema = z.strictObject({
  source: z.literal('renders'),
  renders: boundedPage(
    opaqueArraySchema<RenderStat>('RenderStat', recordWithKeys('id', 'component', 'renderCount')),
  ),
  ...dataPageShape,
});

/**
 * `source: 'componentTree'` — the component tree at the capture's last commit.
 *
 * Not paged: a tree is one value. Nullable because
 * `buildComponentTreeSnapshot` returns `undefined` for a capture with no render
 * evidence and `undefined` does not survive a JSON round trip — so the wire
 * value for "no tree" is `null`, and the service converts. A component-tree node
 * that carried `undefined` here would reach the renderer as an absent key and
 * throw on the first property access, far from the cause.
 */
const componentTreeDataResultSchema = z.strictObject({
  source: z.literal('componentTree'),
  componentTree: opaqueSchema<ComponentTreeSnapshot>(
    'ComponentTreeSnapshot',
    recordWithKeys('capturedAt', 'roots'),
  ).nullable(),
});

/**
 * `source: 'requests'` — network calls grouped so that byte-identical requests
 * collide and differently parameterized ones do not, paged.
 *
 * The view duplicate detection reads. Grouping is by the pre-redaction
 * `request_key` computed at ingest (AAP §0.5.2), never by the redacted URL, which
 * is what keeps two requests for different parameters apart while making two
 * identical ones collide.
 */
const requestsDataResultSchema = z.strictObject({
  source: z.literal('requests'),
  requests: boundedPage(
    opaqueArraySchema<RequestGroup>('RequestGroup', recordWithKeys('id', 'method', 'url', 'count')),
  ),
  ...dataPageShape,
});

/**
 * `source: 'queries'` — database statements grouped by their normalised,
 * parameterized text, paged.
 *
 * Statements only. No row contents are ever captured, so none can be queried,
 * and the statement itself carries `$1` placeholders with inline literals
 * already replaced (AAP §0.5.2).
 */
const queriesDataResultSchema = z.strictObject({
  source: z.literal('queries'),
  queries: boundedPage(
    opaqueArraySchema<QueryGroup>(
      'QueryGroup',
      recordWithKeys('id', 'normalizedStatement', 'executionCount'),
    ),
  ),
  ...dataPageShape,
});

/**
 * `source: 'stateTransitions'` — hook state changes and what triggered each one,
 * paged.
 *
 * Values are summaries rather than values: a type, a change flag and a
 * truncated, pattern-filtered preview, because full React state is outside the
 * privacy model (AAP §0.5.2).
 */
const stateTransitionsDataResultSchema = z.strictObject({
  source: z.literal('stateTransitions'),
  stateTransitions: boundedPage(
    opaqueArraySchema<StateTransition>('StateTransition', recordWithKeys('id', 'eventId')),
  ),
  ...dataPageShape,
});

/**
 * `source: 'graph'` — the correlated flow as nodes and edges.
 *
 * Not paged, and **not nullable**: an empty graph is `{ nodes: [], edges: [] }`,
 * a real value the layout renders as an empty canvas, so there is no state that
 * needs `null` to express it. The guard is shallow and checks exactly the two
 * collections the renderer indexes.
 */
const graphDataResultSchema = z.strictObject({
  source: z.literal('graph'),
  graph: opaqueSchema<DependencyGraphData>('DependencyGraphData', recordWithKeys('nodes', 'edges')),
});

/**
 * `source: 'metrics'` — the capture's computed metric values.
 *
 * Carries the paging echo for uniformity, so one resolver and one client path
 * serve every array-valued source, but the service always returns the complete
 * set: `total` is the number of `METRIC_IDS` and `nextOffset` is `null`, because
 * the metric vocabulary is closed at fourteen ids and a metric card addresses a
 * value by id rather than by position. The array is bounded by that same count —
 * a longer one is a producer repeating itself — while a shorter one is accepted,
 * since the fallback path and a partially observed capture legitimately carry a
 * subset, each unmeasured metric reporting `available: false`.
 */
const metricsDataResultSchema = z.strictObject({
  source: z.literal('metrics'),
  metrics: opaqueArraySchema<MetricValue>('MetricValue', recordWithKeys('id', 'available')).max(
    METRIC_IDS.length,
    { error: `expected at most ${String(METRIC_IDS.length)} metric values` },
  ),
  ...dataPageShape,
});

/**
 * The `POST /sessions/:id/panel-data` response: one member per query source.
 *
 * A discriminated union on `source`, with the members declared in
 * `DATA_QUERY_SOURCES` order, each carrying one payload field named after its
 * source. Echoing the source back is what makes the reply self-describing: a
 * panel resolves several nodes' queries concurrently, and a client matches a
 * response to the node that asked for it by discriminant rather than by the
 * order replies happened to arrive in.
 *
 * `z.discriminatedUnion` rather than `z.union`, so a rejection names the one
 * member that should have matched instead of reporting ten sets of issues, and so
 * an unknown source fails on the discriminant with a message a producer can act
 * on.
 *
 * Served by `apps/local-service/src/panels/data.ts`; consumed by
 * `apps/chrome-extension/src/panel/data-provider.ts` and, through `PanelHost`'s
 * `DataProvider`, by every visualization component.
 */
export const dataResultSchema = z.discriminatedUnion('source', [
  traceDataResultSchema,
  spansDataResultSchema,
  eventsDataResultSchema,
  rendersDataResultSchema,
  componentTreeDataResultSchema,
  requestsDataResultSchema,
  queriesDataResultSchema,
  stateTransitionsDataResultSchema,
  graphDataResultSchema,
  metricsDataResultSchema,
]);

/**
 * What a panel-data query answers.
 *
 * Inferred from {@link dataResultSchema}, so the validator and the type are one
 * statement. Narrowing on `source` gives the payload its owner's type — a
 * `'renders'` result's `renders` is `RenderStat[]`, a `'trace'` result's `trace`
 * is `TraceTree | null` — with no cast at the boundary.
 */
export type DataResult = z.infer<typeof dataResultSchema>;

/**
 * The result for one specific query source.
 *
 * What gives a per-source caller a precise type without a narrowing branch:
 * `apps/local-service/src/panels/data.ts` declares each resolver as returning
 * `DataResultFor<'requests'>`, and
 * `apps/chrome-extension/src/panel/data-provider.ts` types its query method by
 * the source it was handed, so a resolver that built the wrong payload field
 * fails to compile rather than failing to render.
 *
 * @typeParam S The query source, from `@debuggen/panel-schema`'s vocabulary.
 */
export type DataResultFor<S extends DataQuerySource> = Extract<DataResult, { source: S }>;

/**
 * Validates an unknown value as a {@link DataResult}, without throwing.
 *
 * How a panel-data response becomes a typed value in the process that received
 * it. Total, like every parse helper in this package: a rejection is a returned
 * value, because a renderer resolving several nodes' queries is the last place
 * that should have to catch an exception, and one bad response must degrade one
 * node to its error state rather than blank the panel.
 *
 * The error carries issue paths and codes only (AAP §0.5.2) — a result body holds
 * redacted URLs, parameterized SQL and prop-name summaries, and none of it may
 * reach a message, a log line or a persisted row.
 *
 * @param value An unknown value, normally a parsed JSON response body.
 * @returns `ok(result)`, or `err(error)` naming the offending path.
 */
export function parseDataResult(value: unknown): Result<DataResult, DebuggenError> {
  const parsed = dataResultSchema.safeParse(value);

  if (!parsed.success) {
    return err(
      protocolParseError(
        'PROTOCOL_INVALID_MESSAGE',
        'Invalid panel data result',
        parsed.error.issues,
        'The response must carry a `source` from the data-query vocabulary and the payload field named after it.',
      ),
    );
  }

  return ok(parsed.data);
}

// ---------------------------------------------------------------------------
// Section J — the route table
//
// Seventeen entries, keyed by operation id, and the single definition of the
// service's HTTP surface (AAP §0.9.1). `as const satisfies` is load-bearing
// twice over: `as const` keeps every key, method, pattern and `authExempt` flag
// a literal type, which is what lets `HttpOperation`, the mapped body helpers
// and the auth-exempt proof be derived from this object rather than declared
// beside it; `satisfies` checks each entry against `HttpRouteDefinition` without
// widening what `as const` narrowed, which is what keeps `HTTP_ROUTES[operation]`
// an exact lookup under `noUncheckedIndexedAccess`.
// ---------------------------------------------------------------------------

/**
 * Every HTTP route the local service exposes.
 *
 * The keys are operation ids, six of them the user's own names for these
 * operations (prompt §16) preserved character for character. Grouped by resource
 * in the order the module documentation lists them: sessions, captures, panels,
 * modifications, telemetry ingest, dev server, health and pairing.
 *
 * Read by `apps/local-service/src/server/http.ts` to register handlers and to
 * apply its bearer and origin middleware, by `./client/http-client.ts` to build
 * and validate a call, and by `packages/protocol/src/__tests__/http.test.ts`,
 * which pins all seventeen `(operation, method, pattern)` triples literally so
 * that adding, renaming or re-pathing a route is a deliberate edit in two
 * places rather than an accident in one.
 */
export const HTTP_ROUTES = {
  /** `POST /sessions` — start a session on a project with a question. */
  'session.create': {
    operation: 'session.create',
    method: 'POST',
    pattern: '/sessions',
    params: [],
    authExempt: false,
    request: sessionCreateRequestSchema,
    response: sessionRecordSchema,
  },

  /** `GET /sessions` — every session, for the editor's Sessions tree. */
  'session.list': {
    operation: 'session.list',
    method: 'GET',
    pattern: '/sessions',
    params: [],
    authExempt: false,
    request: undefined,
    response: sessionListResponseSchema,
  },

  /** `GET /sessions/:id` — one session, which is also how a session is reopened. */
  'session.get': {
    operation: 'session.get',
    method: 'GET',
    pattern: '/sessions/:id',
    params: ['id'],
    authExempt: false,
    request: undefined,
    response: sessionRecordSchema,
  },

  /** `POST /sessions/:id/question` — ask a follow-up on an existing session. */
  'session.question': {
    operation: 'session.question',
    method: 'POST',
    pattern: '/sessions/:id/question',
    params: ['id'],
    authExempt: false,
    request: sessionQuestionRequestSchema,
    response: sessionRecordSchema,
  },

  /** `POST /sessions/:id/end` — end the session and run cleanup. */
  'session.end': {
    operation: 'session.end',
    method: 'POST',
    pattern: '/sessions/:id/end',
    params: ['id'],
    authExempt: false,
    request: sessionEndRequestSchema,
    response: sessionEndResponseSchema,
  },

  /**
   * `POST /sessions/:id/capture/start` — open a capture window.
   *
   * Answers `409` with {@link captureStartConflictResponseSchema} when another
   * session already holds the capture on this project.
   */
  'capture.start': {
    operation: 'capture.start',
    method: 'POST',
    pattern: '/sessions/:id/capture/start',
    params: ['id'],
    authExempt: false,
    request: captureStartRequestSchema,
    response: captureStartResponseSchema,
  },

  /** `POST /sessions/:id/capture/stop` — close the window and summarise it. */
  'capture.stop': {
    operation: 'capture.stop',
    method: 'POST',
    pattern: '/sessions/:id/capture/stop',
    params: ['id'],
    authExempt: false,
    request: captureStopRequestSchema,
    response: captureStopResponseSchema,
  },

  /**
   * `POST /sessions/:id/panel-data` — resolve one panel node's data query.
   *
   * A `POST` although it reads: the body is a structured `DataQuery` with a
   * nested filter, which a query string can carry only by encoding, and an
   * encoded query string is a second serialisation of a shape this product
   * already defines once.
   */
  'panel.data': {
    operation: 'panel.data',
    method: 'POST',
    pattern: '/sessions/:id/panel-data',
    params: ['id'],
    authExempt: false,
    request: panelDataRequestSchema,
    response: dataResultSchema,
  },

  /** `GET /sessions/:id/panel` — the session's current panel, or `null`. */
  'panel.get': {
    operation: 'panel.get',
    method: 'GET',
    pattern: '/sessions/:id/panel',
    params: ['id'],
    authExempt: false,
    request: undefined,
    response: panelResponseSchema,
  },

  /** `GET /sessions/:id/panels/:panelId` — one specific panel version. */
  'panel.getById': {
    operation: 'panel.getById',
    method: 'GET',
    pattern: '/sessions/:id/panels/:panelId',
    params: ['id', 'panelId'],
    authExempt: false,
    request: undefined,
    response: panelByIdResponseSchema,
  },

  /** `GET /sessions/:id/modifications` — the session's modification journal. */
  'modifications.list': {
    operation: 'modifications.list',
    method: 'GET',
    pattern: '/sessions/:id/modifications',
    params: ['id'],
    authExempt: false,
    request: undefined,
    response: modificationsResponseSchema,
  },

  /**
   * `POST /telemetry/ingest` — the Node preload posts server and database spans.
   *
   * The only route whose caller is neither an extension nor the editor, and the
   * only one scoped to a single `projectRoot` by its credential (Section F).
   */
  'telemetry.event': {
    operation: 'telemetry.event',
    method: 'POST',
    pattern: '/telemetry/ingest',
    params: [],
    authExempt: false,
    request: telemetryIngestRequestSchema,
    response: telemetryIngestResponseSchema,
  },

  /** `POST /dev-server/launch` — probe for, or start, the target's dev server. */
  'devServer.launch': {
    operation: 'devServer.launch',
    method: 'POST',
    pattern: '/dev-server/launch',
    params: [],
    authExempt: false,
    request: devServerLaunchRequestSchema,
    response: devServerLaunchResponseSchema,
  },

  /** `POST /dev-server/stop` — stop the dev server this service launched. */
  'devServer.stop': {
    operation: 'devServer.stop',
    method: 'POST',
    pattern: '/dev-server/stop',
    params: [],
    authExempt: false,
    request: devServerStopRequestSchema,
    response: devServerStopResponseSchema,
  },

  /**
   * `GET /health` — **unauthenticated**: version and pairing availability only.
   *
   * How a client discovers whether the service is running at all, which is why
   * it cannot require the credential a client may not yet hold.
   */
  health: {
    operation: 'health',
    method: 'GET',
    pattern: '/health',
    params: [],
    authExempt: true,
    request: undefined,
    response: healthResponseSchema,
  },

  /** `POST /pair/start` — mint a one-time pairing code (editor credential). */
  'pair.start': {
    operation: 'pair.start',
    method: 'POST',
    pattern: '/pair/start',
    params: [],
    authExempt: false,
    request: pairStartRequestSchema,
    response: pairStartResponseSchema,
  },

  /**
   * `POST /pair/complete` — **unauthenticated**: redeem a pairing code for a
   * DevTools credential.
   *
   * The code is the capability being presented, and the origin it is presented
   * from becomes the credential's scope (Section A).
   */
  'pair.complete': {
    operation: 'pair.complete',
    method: 'POST',
    pattern: '/pair/complete',
    params: [],
    authExempt: true,
    request: pairCompleteRequestSchema,
    response: pairCompleteResponseSchema,
  },
} as const satisfies Readonly<Record<string, HttpRouteDefinition>>;

// ---------------------------------------------------------------------------
// Section K — the operation vocabulary and the typed body helpers
// ---------------------------------------------------------------------------

/**
 * Every operation id, in the table's own order.
 *
 * Declared as a literal tuple rather than computed from `Object.keys`, because
 * `Object.keys` returns `string[]` and would throw away exactly the literal
 * types this vocabulary exists to provide. It cannot drift from the table: the
 * `satisfies` clause refuses a member that is not a key, and
 * {@link HttpOperationsCoverEveryRoute} refuses a key that is not a member, so
 * adding a route without listing it here is a compile error.
 *
 * Iterated by `apps/local-service/src/server/http.ts` to register every handler.
 */
export const HTTP_OPERATIONS = [
  'session.create',
  'session.list',
  'session.get',
  'session.question',
  'session.end',
  'capture.start',
  'capture.stop',
  'panel.data',
  'panel.get',
  'panel.getById',
  'modifications.list',
  'telemetry.event',
  'devServer.launch',
  'devServer.stop',
  'health',
  'pair.start',
  'pair.complete',
] as const satisfies readonly (keyof typeof HTTP_ROUTES)[];

/**
 * One of {@link HTTP_OPERATIONS}.
 *
 * The type every helper below is generic over, and the type a client's single
 * request method takes — which is what makes one method fully typed for
 * seventeen routes.
 */
export type HttpOperation = (typeof HTTP_OPERATIONS)[number];

/** The request schema bound to an operation, or `undefined` for a `GET`. */
type RequestSchemaOf<O extends HttpOperation> = (typeof HTTP_ROUTES)[O]['request'];

/** The response schema bound to an operation. */
type ResponseSchemaOf<O extends HttpOperation> = (typeof HTTP_ROUTES)[O]['response'];

/**
 * The request body type of an operation — `undefined` for a `GET`, which carries
 * none.
 *
 * Resolved from the table rather than declared per route, so a schema change is
 * a type change at every call site in the same edit. This and
 * {@link HttpResponseBody} are what let `./client/http-client.ts` expose one
 * generic `request(operation, body)` method whose body argument and return value
 * are both exact.
 *
 * @typeParam O The operation.
 */
export type HttpRequestBody<O extends HttpOperation> =
  RequestSchemaOf<O> extends infer TSchema extends z.ZodType ? z.output<TSchema> : undefined;

/**
 * The success response body type of an operation.
 *
 * @typeParam O The operation.
 */
export type HttpResponseBody<O extends HttpOperation> =
  ResponseSchemaOf<O> extends infer TSchema extends z.ZodType ? z.output<TSchema> : never;

/** Every table key the {@link HTTP_OPERATIONS} tuple failed to list. */
type UnlistedRouteKey = Exclude<keyof typeof HTTP_ROUTES, HttpOperation>;

/**
 * Compile-time proof that the operation tuple covers the whole table.
 *
 * Exported for a mechanical reason: the repository compiles with
 * `noUnusedLocals` and lints with `@typescript-eslint/no-unused-vars`, under
 * which an unreferenced local type alias is itself an error and a JSDoc
 * reference does not count as a use. It is a type, so nothing is emitted, and it
 * gives the assertion a name a reader can search for.
 */
export type HttpOperationsCoverEveryRoute = AssertTrue<Identical<UnlistedRouteKey, never>>;

// ---------------------------------------------------------------------------
// Section L — the authentication exemption
// ---------------------------------------------------------------------------

/** Every operation whose definition carries `authExempt: true`. */
type AuthExemptRouteKey = {
  [O in HttpOperation]: (typeof HTTP_ROUTES)[O]['authExempt'] extends true ? O : never;
}[HttpOperation];

/**
 * The operations reachable without a credential: exactly `health` and
 * `pair.complete` (AAP §0.5.6).
 *
 * A tuple as well as the per-route flags, because the two are used differently:
 * middleware asks about the operation in front of it, which is
 * {@link isAuthExemptOperation}, while a reviewer, a test and this
 * documentation need the whole set in one place. They cannot disagree — the
 * `satisfies` clause refuses a member whose route is not flagged exempt, and
 * {@link AuthExemptOperationsMatchRouteFlags} refuses a flagged route that is
 * not a member — so flipping a flag without editing this tuple, or the reverse,
 * fails to compile.
 *
 * Each of the two is documented where its route is defined: `GET /health` must
 * answer before a client holds a credential, and `POST /pair/complete`'s
 * one-time code *is* the credential being presented.
 */
export const AUTH_EXEMPT_OPERATIONS = [
  'health',
  'pair.complete',
] as const satisfies readonly AuthExemptRouteKey[];

/** One of {@link AUTH_EXEMPT_OPERATIONS}. */
export type AuthExemptOperation = (typeof AUTH_EXEMPT_OPERATIONS)[number];

/** Every exempt route the {@link AUTH_EXEMPT_OPERATIONS} tuple failed to list. */
type UnlistedAuthExemptRoute = Exclude<AuthExemptRouteKey, AuthExemptOperation>;

/**
 * Compile-time proof that the exempt tuple matches the per-route flags.
 *
 * Exported for the reason {@link HttpOperationsCoverEveryRoute} is.
 */
export type AuthExemptOperationsMatchRouteFlags = AssertTrue<
  Identical<UnlistedAuthExemptRoute, never>
>;

/**
 * Whether an operation may be called without `Authorization: Bearer <token>`.
 *
 * Reads the route's own `authExempt` flag, so there is one runtime source of
 * truth and the answer cannot depend on whether a caller consulted the flag or
 * the tuple. Used by `apps/local-service/src/server/auth.ts` to decide whether
 * to demand a credential, and by `./client/http-client.ts` to decide whether to
 * send one — which matters for `GET /health`, the call a client makes *before*
 * it has one.
 *
 * Note what the predicate does not say: an exempt route is still subject to the
 * origin policy and, for pairing, to the rate limit. Exempt means "no bearer
 * credential", never "unprotected".
 *
 * @param operation The operation being called.
 * @returns `true` for `health` and `pair.complete`, `false` for the other
 * fifteen.
 */
export function isAuthExemptOperation(operation: HttpOperation): boolean {
  return HTTP_ROUTES[operation].authExempt;
}

// ---------------------------------------------------------------------------
// Section M — path construction
//
// One generic builder and a named builder per operation. The named ones exist
// for the call sites: `sessionQuestionPath(id)` says at a glance what
// `buildPath('session.question', { id })` says only after a reader checks the
// table, and a mistyped parameter name becomes a compile error at the builder
// rather than a `DebuggenError` at run time.
// ---------------------------------------------------------------------------

/**
 * Builds a concrete path for an operation, substituting and encoding each
 * parameter.
 *
 * Every value is `encodeURIComponent`-encoded, which is the whole reason a
 * builder exists rather than a template literal at each call site: a session id
 * is opaque to this package, and a value containing `/`, `?`, `#` or `..` must
 * become one path segment rather than a different route.
 *
 * **Throws** a `DebuggenError` when the route declares a parameter the caller
 * did not supply, and that asymmetry with the rest of this package — where a
 * failure is a returned `Result` — is deliberate: a missing path parameter is a
 * programmer error in the calling code, not a condition a user can produce or a
 * caller can recover from, so it fails loudly at the call site instead of
 * becoming an error value that might be logged and ignored. The error names the
 * operation and the parameter, and carries no supplied value (AAP §0.5.2).
 *
 * @typeParam O The operation.
 * @param operation The operation whose path to build.
 * @param params The path parameters by name; omitted for a route that declares
 * none.
 * @returns The path, relative to the service's base URL.
 * @throws DebuggenError `INTERNAL` when a declared parameter is missing or empty.
 *
 * @example
 * ```ts
 * buildPath('panel.getById', { id: sessionId, panelId });
 * // → '/sessions/ses_.../panels/pnl_...'
 * ```
 */
export function buildPath<O extends HttpOperation>(
  operation: O,
  params?: Readonly<Record<string, string>>,
): string {
  const route = HTTP_ROUTES[operation];
  let path: string = route.pattern;

  for (const name of route.params) {
    const value = params?.[name];

    if (value === undefined || value === '') {
      throw new DebuggenError(
        'INTERNAL',
        `Cannot build the path for ${operation}: the required parameter "${name}" is missing`,
        {
          hint: `Pass { ${name}: … } to buildPath('${operation}', …).`,
          details: { operation, parameter: name },
        },
      );
    }

    path = path.replace(`:${name}`, encodeURIComponent(value));
  }

  return path;
}

/** `/sessions` — the collection, for `session.create` and `session.list` alike. */
export function sessionsPath(): string {
  return buildPath('session.list');
}

/** `/sessions/:id` — one session, for `session.get`. */
export function sessionPath(sessionId: string): string {
  return buildPath('session.get', { id: sessionId });
}

/** `/sessions/:id/question` — for `session.question`. */
export function sessionQuestionPath(sessionId: string): string {
  return buildPath('session.question', { id: sessionId });
}

/** `/sessions/:id/end` — for `session.end`. */
export function sessionEndPath(sessionId: string): string {
  return buildPath('session.end', { id: sessionId });
}

/** `/sessions/:id/capture/start` — for `capture.start`. */
export function captureStartPath(sessionId: string): string {
  return buildPath('capture.start', { id: sessionId });
}

/** `/sessions/:id/capture/stop` — for `capture.stop`. */
export function captureStopPath(sessionId: string): string {
  return buildPath('capture.stop', { id: sessionId });
}

/** `/sessions/:id/panel-data` — for `panel.data`. */
export function panelDataPath(sessionId: string): string {
  return buildPath('panel.data', { id: sessionId });
}

/** `/sessions/:id/panel` — for `panel.get`. */
export function panelPath(sessionId: string): string {
  return buildPath('panel.get', { id: sessionId });
}

/** `/sessions/:id/panels/:panelId` — for `panel.getById`. */
export function panelByIdPath(sessionId: string, panelId: string): string {
  return buildPath('panel.getById', { id: sessionId, panelId });
}

/** `/sessions/:id/modifications` — for `modifications.list`. */
export function modificationsPath(sessionId: string): string {
  return buildPath('modifications.list', { id: sessionId });
}

/** `/telemetry/ingest` — for `telemetry.event`, the Node preload's route. */
export function telemetryIngestPath(): string {
  return buildPath('telemetry.event');
}

/** `/dev-server/launch` — for `devServer.launch`. */
export function devServerLaunchPath(): string {
  return buildPath('devServer.launch');
}

/** `/dev-server/stop` — for `devServer.stop`. */
export function devServerStopPath(): string {
  return buildPath('devServer.stop');
}

/** `/health` — for `health`, the unauthenticated probe. */
export function healthPath(): string {
  return buildPath('health');
}

/** `/pair/start` — for `pair.start`. */
export function pairStartPath(): string {
  return buildPath('pair.start');
}

/** `/pair/complete` — for `pair.complete`. */
export function pairCompletePath(): string {
  return buildPath('pair.complete');
}

// ---------------------------------------------------------------------------
// Section N — validation over the table
//
// Two helpers, so a body is validated by the same code on both sides of the
// wire: the service's route handler parses a request through `parseHttpRequest`
// and a client parses the reply through `parseHttpResponse`. A second validation
// path is how a service starts accepting something no client can send.
// ---------------------------------------------------------------------------

/**
 * Validates an unknown value as an operation's request body, without throwing.
 *
 * For a route that declares no body — every `GET` — the only accepted input is
 * `undefined`, and anything else is refused: a caller that sent a body to a
 * `GET` is working from a contract this table replaced, and a silent acceptance
 * would leave it believing the body had an effect.
 *
 * The error carries issue paths and codes only (AAP §0.5.2). A request body holds
 * a project path and the developer's own question, neither of which may reach a
 * message, a log line or a persisted row.
 *
 * @typeParam O The operation.
 * @param operation The operation whose request body to validate.
 * @param value An unknown value, normally a parsed JSON request body.
 * @returns `ok(body)`, or `err(error)` naming the offending path.
 */
export function parseHttpRequest<O extends HttpOperation>(
  operation: O,
  value: unknown,
): Result<HttpRequestBody<O>, DebuggenError> {
  const schema: z.ZodType | undefined = HTTP_ROUTES[operation].request;

  if (schema === undefined) {
    if (value === undefined) {
      // The route's body type *is* `undefined`, so this is the validated value
      // rather than a placeholder. The assertion is what the generic signature
      // costs: the compiler cannot see that `HttpRequestBody<O>` is `undefined`
      // for the operations whose `request` is.
      return ok(undefined as HttpRequestBody<O>);
    }

    return err(
      new DebuggenError(
        'PROTOCOL_INVALID_MESSAGE',
        `The ${operation} route declares no request body`,
        { hint: `Send ${operation} with no body.`, details: { operation } },
      ),
    );
  }

  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    return err(
      protocolParseError(
        'PROTOCOL_INVALID_MESSAGE',
        `Invalid ${operation} request body`,
        parsed.error.issues,
      ),
    );
  }

  // `safeParse` on a `z.ZodType` yields `unknown`; the table guarantees the
  // schema is the one bound to this operation, which is what the mapped type
  // states and what this assertion carries across the generic boundary.
  return ok(parsed.data as HttpRequestBody<O>);
}

/**
 * Validates an unknown value as an operation's success response body, without
 * throwing.
 *
 * The client side of the same contract. A non-2xx reply is not passed here: its
 * body is {@link httpErrorResponseSchema}'s, parsed by
 * `./messages/error.ts`'s `parseErrorPayload`, so a failure keeps its own shape
 * instead of being reported as a malformed success.
 *
 * @typeParam O The operation.
 * @param operation The operation whose response body to validate.
 * @param value An unknown value, normally a parsed JSON response body.
 * @returns `ok(body)`, or `err(error)` naming the offending path.
 */
export function parseHttpResponse<O extends HttpOperation>(
  operation: O,
  value: unknown,
): Result<HttpResponseBody<O>, DebuggenError> {
  const schema: z.ZodType = HTTP_ROUTES[operation].response;
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    return err(
      protocolParseError(
        'PROTOCOL_INVALID_MESSAGE',
        `Invalid ${operation} response body`,
        parsed.error.issues,
      ),
    );
  }

  // Same reasoning as `parseHttpRequest`: the schema came from this operation's
  // own row, so the parsed value is this operation's response body.
  return ok(parsed.data as HttpResponseBody<O>);
}

// ---------------------------------------------------------------------------
// Section O — compile-time drift guards
//
// Each one states a relationship that would otherwise be a comment: that a
// mapped body type resolves to the upstream type its route carries, and that the
// two event-schema choices in this file are the intended ones. Everything here
// is type-level — no runtime code, nothing emitted — and each alias is exported
// for the `noUnusedLocals` reason {@link HttpOperationsCoverEveryRoute} states.
// ---------------------------------------------------------------------------

/**
 * `POST /sessions` answers with the session record, not a wrapper around it.
 *
 * Also proves the mapped response helper resolves through the table to an
 * upstream type, so a client needs no cast.
 */
export type SessionCreateResponseIsSessionRecord = AssertTrue<
  Identical<HttpResponseBody<'session.create'>, SessionRecord>
>;

/**
 * The panel-data request body is `@debuggen/panel-schema`'s `DataQuery` itself.
 *
 * The type-level half of the identity the table asserts by reference; the suite
 * asserts the other half, that `HTTP_ROUTES['panel.data'].request` is the very
 * same schema object.
 */
export type PanelDataRequestIsDataQuery = AssertTrue<
  Identical<HttpRequestBody<'panel.data'>, DataQuery>
>;

/** A `GET` route's request body type is `undefined`. */
export type GetRoutesCarryNoRequestBody = AssertTrue<
  Identical<HttpRequestBody<'session.list'>, undefined>
>;

/**
 * Both panel routes answer with a panel specification, and only `panel.get` may
 * answer `null`.
 *
 * The asymmetry both routes document, held at compile time so a later edit
 * cannot quietly make a missing panel indistinguishable from an empty one. The
 * first two members state that what each route returns is a `PanelSpec` (or
 * `null`), which is the direction a consumer depends on — it hands a parsed
 * response to code that takes a `PanelSpec` — and the last two state that `null`
 * is accepted by one route's type and refused by the other's.
 */
export type PanelResponsesDifferInNullability = [
  AssertTrue<AssignableTo<HttpResponseBody<'panel.get'>['panel'], PanelSpec | null>>,
  AssertTrue<AssignableTo<HttpResponseBody<'panel.getById'>['panel'], PanelSpec>>,
  AssertTrue<AssignableTo<null, HttpResponseBody<'panel.get'>['panel']>>,
  AssertTrue<Identical<AssignableTo<null, HttpResponseBody<'panel.getById'>['panel']>, false>>,
];

/** The modification journal carries `@debuggen/instrumentation`'s records. */
export type ModificationsResponseCarriesRecords = AssertTrue<
  Identical<ModificationsResponse['modifications'], ModificationRecord[]>
>;

/**
 * The ingest body carries **ingress** events, which cannot claim a session.
 *
 * If this file ever embedded the persisted schema instead, `sessionId`,
 * `captureId` and `ingestSeq` would become fields a producer could send, and the
 * service would be trusting attribution it is supposed to assign. That is the
 * single most consequential schema choice in this module, so it is proved rather
 * than described.
 */
export type TelemetryIngestCarriesIngressEvents = AssertTrue<
  Identical<TelemetryIngestRequest['events'], TelemetryEventIngress[]>
>;

/** The three fields the service assigns at ingest, which only a stored event has. */
type AttributionKeys = 'sessionId' | 'captureId' | 'ingestSeq';

/** The attribution fields present on a source's element type. */
type AttributionKeysOf<TElement> = Extract<keyof TElement, AttributionKeys>;

/**
 * The `spans` and `events` results carry **persisted** events.
 *
 * The mirror of the guard above: these are rows read back out of the store, so
 * they do carry attribution, and a panel that grouped by `captureId` would
 * silently see nothing if the ingress schema were used here.
 *
 * Asserted by the presence of the three attribution keys rather than by
 * comparing the element type with `TelemetryEvent` as a whole. Both would catch
 * the swap, but a whole-type comparison also fails for a reason that has nothing
 * to do with this contract: instantiating a member of a discriminated union
 * re-derives its optional properties as `p?: T | undefined`, which under
 * `exactOptionalPropertyTypes` is a different type from the upstream `p?: T`
 * even though every value of one is a value of the other. Keys are what the
 * ingress and persisted schemas actually differ by, so keys are what this
 * checks.
 */
export type DataResultSpansCarryPersistedEvents = [
  AssertTrue<
    Identical<AttributionKeysOf<DataResultFor<'spans'>['spans'][number]>, AttributionKeys>
  >,
  AssertTrue<
    Identical<AttributionKeysOf<DataResultFor<'events'>['events'][number]>, AttributionKeys>
  >,
];

/**
 * The union's discriminants are exactly `@debuggen/panel-schema`'s source
 * vocabulary.
 *
 * The promise `DATA_QUERY_SOURCES` makes on the other side — that its ten members
 * are "exactly the discriminants of the `DataResult` union" — kept here. A source
 * added to the vocabulary without a member added to the union fails to compile,
 * which is the intended way to find this file.
 */
export type DataResultCoversQueryVocabulary = AssertTrue<
  Identical<DataResult['source'], DataQuerySource>
>;
