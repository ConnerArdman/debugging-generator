/**
 * The local service's complete HTTP surface: every route, every request and
 * response body, which routes may be called without a credential, and the
 * `DataResult` union that answers a panel-data query.
 *
 * This module is the **only** definition of that surface. The
 * service registers its routes from the table below, the VS Code extension host
 * and the Chrome service worker call them through it, and a second copy of any
 * shape here — in an app, a test helper or a fetch wrapper — is a defect rather
 * than a convenience, because the two copies can only ever disagree at run
 * time, in the process that receives the body.
 *
 * ## Twenty-two routes, and where their names come from
 *
 * Six of the operation keys are the documented operation names, preserved
 * character for character: `session.create`, `session.question`,
 * `session.end`, `capture.start`, `capture.stop` and `telemetry.event`. They
 * are **HTTP operations, not WebSocket message types**. Nothing in this file
 * may enter the envelope's discriminated union, and the
 * twenty-eight WebSocket message types — `client.hello`, `client.ping`,
 * `service.pong`, `session.created`, `session.updated`, `session.progress`,
 * `session.bind`, `session.bound`,
 * `tab.navigated`, `session.unbind`, `target.request`, `target.selected`,
 * `instrumentation.plan`, `instrumentation.ready`, `instrumentation.failed`,
 * `capture.started`, `capture.stopped`, `agent.ready`, `agent.config`,
 * `server-agent.config`, `telemetry.event`, `telemetry.tail`,
 * `analysis.completed`, `panel.generated`, `source.open`, `source.result`,
 * `cleanup.completed` and `error` — live in `./messages/**` and are registered
 * there. Two names are deliberately both, each because one instruction crosses
 * two transports on its way:
 *
 * - `telemetry.event`: a batch reaches the service over the WebSocket from the
 *   page agent's relay and over HTTP from the Node preload, and the two
 *   transports carry the same events under the same operation name.
 * - `target.request`: the editor asks over HTTP
 *   (`POST /sessions/:id/target/request`, Section D2) and the service pushes
 *   the same instruction over the WebSocket to the session's bound DevTools
 *   tab, and to it alone. The editor holds no connection to that tab, and the
 *   service is the one process that knows which tab is bound, so the request is
 *   a conventional HTTP call and the push stays the service-only message
 *   `./messages/target.ts` defines — the vocabulary keeps its twenty-eight types.
 *
 * Four routes serve administrative operations, and they are declared here so
 * that no process has to define a route of its own to reach them:
 * `devServer.credential` (`POST /dev-server/credential`, the server-agent
 * credential `scripts/dev-instrumented.mjs` requests with the editor
 * credential), `credentials.release` (`POST /credentials/release`, how that
 * script revokes the same credential when its dev server exits),
 * `credentials.rotate` (`POST /credentials/rotate`, the revocation
 * `debuggen.rotateServiceToken` performs) and `session.purge`
 * (`POST /sessions/purge`, the retention sweep `debuggen.purgeSessions` runs on
 * demand). A route the service registered outside this table would be a route
 * no client could discover and no test could enumerate, so none may exist.
 *
 * The bodies those operations already own are **imported, never restated**:
 * `./messages/session.ts` owns the three session request bodies,
 * `./messages/capture.ts` the four capture bodies and the embedded capture
 * summary, `./messages/binding.ts` the Chrome tab-id rule the target-request
 * reply carries, `./messages/error.ts` the one error body both transports
 * share, `./messages/telemetry.ts` the delivery context and loss-only rule the
 * ingest body shares with the WebSocket batch (with the identifier rule behind
 * the body's own `lossReportId`), and `./session-record.ts` the
 * `SessionRecord` and the cleanup vocabulary. This module adds what only a
 * route can have: its method, its path, its parameters, whether it is exempt
 * from authentication, and its response.
 *
 * ## Patterns are for the server; `buildPath` is for the client
 *
 * Each `pattern` is written in hono's `:name` form — `/sessions/:id/capture/start`
 * — because the service registers it verbatim (`apps/local-service/src/server/http.ts`).
 * A client never interpolates a pattern by hand: {@link buildPath} and the named
 * builders beside it substitute each parameter and `encodeURIComponent` it, so a
 * session id that ever contains a path character cannot escape its segment.
 *
 * No base URL, host or port appears here, on purpose. The environment supplies
 * `DEBUGGEN_HOST` (default `127.0.0.1`) and `DEBUGGEN_PORT` (default `43117`):
 * the service reads them at start-up and each client resolves its base URL from
 * configuration (`apps/vscode-extension/src/service/discovery.ts`,
 * `apps/chrome-extension/src/background/ws-bridge.ts`), which is what lets a
 * second service instance run on another port without a code change. The paths
 * below are relative, and {@link WS_PATH} is here for the same reason: so that
 * no client hardcodes it either.
 *
 * ## Two routes are unauthenticated, and only two
 *
 * {@link AUTH_EXEMPT_OPERATIONS} contains exactly `health` and `pair.complete`.
 * `GET /health` has to answer before a client holds any
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

import {
  MAX_MODIFICATION_DIFF_LENGTH,
  modificationRecordSchema,
} from '@debuggen/instrumentation/schema';
import type { ModificationRecord } from '@debuggen/instrumentation/schema';
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
import {
  MAX_EPOCH_MS,
  METRIC_IDS,
  telemetryEventIngressSchema,
  telemetryEventSchema,
} from '@debuggen/telemetry';
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

import { sessionBindPayloadSchema, tabIdSchema } from './messages/binding.js';
import type { SessionBindPayload } from './messages/binding.js';
import {
  captureStartRequestSchema,
  captureStartResponseSchema,
  captureStopRequestSchema,
  captureStopResponseSchema,
} from './messages/capture.js';
import { errorPayloadSchema } from './messages/error.js';
import {
  devServerUrlSchema,
  sessionCreateRequestSchema,
  sessionEndRequestSchema,
  sessionQuestionRequestSchema,
} from './messages/session.js';
import {
  armedCaptureIdSchema,
  droppedCountSchema,
  lossReportIdSchema,
  requireLossReportForEmptyBatch,
} from './messages/telemetry.js';
import {
  cleanupStatusSchema,
  sessionCleanupSchema,
  sessionRecordSchema,
} from './session-record.js';
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
// lockout, counted once for the whole service rather than per `Origin`, which
// the caller controls). The code's alphabet and lifetime are the service's
// generator detail and are deliberately not encoded in
// `pairCompleteRequestSchema` — a schema that pinned them would have to change
// in lockstep with the generator, and a stale code is answered by the pairing
// store, not by a parser. The service
// compares the submitted code exactly as sent, with no trimming and no case
// folding: a client that accepts what the developer typed tidies it before it
// submits, and any other spelling is a counted wrong guess.
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
//
// A DevTools credential's writes and socket must come from the origin of the
// extension it was issued to. Chrome omits `Origin` on the `GET`s an extension's service
// worker sends, so those four reads (`session.get`, `panel.get`,
// `panel.getById`, `modifications.list`) also carry `READ_PROOF_HEADER`: a
// second secret the service issued with the credential when the pairing code
// was redeemed. A DevTools read without the proof issued with its credential
// is refused, whether or not it claims the extension's origin.
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
 * The acting-tab request header's name, lowercase: the inspected Chrome tab a
 * DevTools request acts for.
 *
 * ## Why a request has to say which tab it is for
 *
 * One pairing issues one DevTools credential, and the Chrome service worker
 * presents it for every tab the developer inspects. The credential therefore
 * cannot say *which* tab a request comes from, and a DevTools principal may
 * bind, capture and query panel data only for the session bound to its tab. The
 * service worker fills this header from Chrome's own metadata for
 * the panel or page that asked — never from anything a page supplied — and the
 * service checks it against its live tab-to-session binding table:
 *
 * - **required** on every session-scoped request presented with a DevTools
 *   credential; a request without it, or for a session whose live binding is
 *   another tab's, is refused;
 * - **refused** from every other role: an editor or server-agent credential has
 *   no tab, so a request that claims one is a confused client rather than a
 *   narrower one.
 *
 * It is a claim the service verifies, never a capability: presenting a tab id
 * gains nothing without both the DevTools credential and a live binding for that
 * tab. The WebSocket counterpart is the envelope's `tabId` (`./envelope.ts`).
 *
 * The value is one tab id in canonical decimal — see
 * {@link parseActingTabHeader} for exactly what is accepted — written only by
 * {@link formatActingTabHeader}. Lowercase for the reason
 * {@link AUTHORIZATION_HEADER} is.
 */
export const ACTING_TAB_HEADER = 'x-debuggen-tab';

/**
 * The one spelling of a tab id {@link parseActingTabHeader} accepts: `0`, or a
 * non-zero digit followed by at most fifteen more — sixteen digits being the
 * width of `Number.MAX_SAFE_INTEGER` (`9007199254740991`).
 *
 * Anchored and bounded, so a hostile value costs a fixed amount of work
 * whatever its length. No sign, no leading zero, no fraction, no exponent and
 * no whitespace: a header that two parsers could read as two different numbers
 * is refused rather than normalised. A duplicated header, which the platform's
 * `Headers.get` joins as `"4, 5"`, fails this pattern too.
 */
const ACTING_TAB_HEADER_PATTERN = /^(0|[1-9][0-9]{0,15})$/;

/**
 * What {@link parseActingTabHeader} reports for a value that is not one tab id.
 *
 * Constant: the refused value is never interpolated, because a header this
 * service did not expect is unvalidated data from another process.
 */
const ACTING_TAB_HEADER_INVALID_MESSAGE =
  'Invalid x-debuggen-tab header: expected the decimal id of exactly one Chrome tab';

const ACTING_TAB_HEADER_INVALID_HINT =
  'Send x-debuggen-tab once, as the inspected tab’s non-negative integer id in canonical decimal (no sign, no leading zero, no whitespace), or omit it on a request that acts for no tab.';

/**
 * What {@link formatActingTabHeader} reports for a number that is not a tab id.
 *
 * Constant, like its parsing counterpart.
 */
const ACTING_TAB_FORMAT_INVALID_MESSAGE =
  'Cannot send the x-debuggen-tab header: the value is not a non-negative safe-integer Chrome tab id';

const ACTING_TAB_FORMAT_INVALID_HINT =
  'Pass the inspected tab’s id as Chrome reports it (a port sender’s tab.id, or chrome.devtools.inspectedWindow.tabId); -1 is chrome.tabs.TAB_ID_NONE, not a tab.';

/**
 * Formats a tab id as an {@link ACTING_TAB_HEADER} value, without throwing.
 *
 * The one place the header's value is written, so every sender produces the
 * spelling {@link parseActingTabHeader} accepts: the decimal string of a tab id
 * that passes `tabIdSchema` (`./messages/binding.ts`) — the same schema a
 * payload's `tabId` and the envelope's acting tab are held to. A safe integer's
 * decimal string never has a sign, a leading zero or an exponent, so what this
 * returns always parses back to the number it was given.
 *
 * @param tabId The inspected tab's id.
 * @returns `ok(value)` with the header value, or `err(error)` with code
 * `PROTOCOL_INVALID_MESSAGE` and a constant message when `tabId` is negative,
 * fractional, non-finite, beyond the safe-integer range or not a number.
 *
 * @example
 * ```ts
 * const header = formatActingTabHeader(tabId);
 * if (isOk(header)) {
 *   headers[ACTING_TAB_HEADER] = header.value; // '42'
 * }
 * ```
 */
export function formatActingTabHeader(tabId: number): Result<string, DebuggenError> {
  if (!tabIdSchema.safeParse(tabId).success) {
    return err(
      new DebuggenError('PROTOCOL_INVALID_MESSAGE', ACTING_TAB_FORMAT_INVALID_MESSAGE, {
        hint: ACTING_TAB_FORMAT_INVALID_HINT,
        details: { header: ACTING_TAB_HEADER },
      }),
    );
  }

  return ok(String(tabId));
}

/**
 * Parses an {@link ACTING_TAB_HEADER} value, without throwing.
 *
 * The service's half of the contract: it reads the header — hono's
 * `c.req.header()` answers `undefined` for an absent one, `Headers.get` answers
 * `null` — and hands the value here before any authorization decision.
 *
 * - `null` or `undefined` is **absent**, answered `ok(undefined)`: whether a
 *   request needed a tab is the service's decision, made with the principal in
 *   hand, not a shape rule.
 * - Anything else must be exactly one tab id in canonical decimal
 *   ({@link ACTING_TAB_HEADER_PATTERN}) that is a safe integer and passes
 *   `tabIdSchema`. An empty string is refused — a header that is present but
 *   names no tab is a client bug, not an absent header — and so are `-1`, `01`,
 *   `+3`, `1.5`, `1e3`, surrounding whitespace, a duplicated header joined as
 *   `4, 5`, and `9007199254740992`, the first integer a double cannot tell from
 *   its neighbour.
 *
 * The rejection is `PROTOCOL_INVALID_MESSAGE` with a constant message and hint
 * and `details: { header }`; the value is never quoted.
 *
 * @param value The raw header value, or `null` / `undefined` when absent.
 * @returns `ok(tabId)`, `ok(undefined)` when absent, or `err(error)`.
 *
 * @example
 * ```ts
 * const actingTab = parseActingTabHeader(c.req.header(ACTING_TAB_HEADER));
 * if (isErr(actingTab)) {
 *   return refuse(c, actingTab.error); // the service's own error responder
 * }
 * // actingTab.value: the tab id, or undefined when the header was absent.
 * ```
 */
export function parseActingTabHeader(
  value: string | null | undefined,
): Result<number | undefined, DebuggenError> {
  if (value === null || value === undefined) {
    return ok(undefined);
  }

  // The pattern first: it is what refuses every non-canonical spelling, and it
  // keeps `Number()` — which would accept ' 4', '0x4' and '1e3' — from ever
  // seeing one. The safe-integer and schema checks then refuse the sixteen-digit
  // values beyond `Number.MAX_SAFE_INTEGER`.
  if (ACTING_TAB_HEADER_PATTERN.test(value)) {
    const tabId = Number(value);

    if (Number.isSafeInteger(tabId) && tabIdSchema.safeParse(tabId).success) {
      return ok(tabId);
    }
  }

  return err(
    new DebuggenError('PROTOCOL_INVALID_MESSAGE', ACTING_TAB_HEADER_INVALID_MESSAGE, {
      hint: ACTING_TAB_HEADER_INVALID_HINT,
      details: { header: ACTING_TAB_HEADER },
    }),
  );
}

/**
 * The DevTools read-proof request header's name, lowercase: the second secret
 * a DevTools credential's reads carry, issued with the credential when the
 * pairing code was redeemed.
 *
 * ## Why a read carries a proof
 *
 * The service binds a DevTools credential to the extension it was issued to by
 * the `Origin` header, and Chrome sends that header on the extension's `POST`s
 * and on its WebSocket upgrade — but not on a `GET` its service worker sends to
 * a host the extension holds a permission for (`http://127.0.0.1/*`). And an
 * `Origin` header is only a claim: any local process holding the credential can
 * write the extension's origin itself. So the four DevTools reads —
 * `session.get`, `panel.get`, `panel.getById` and `modifications.list` — are
 * not admitted on the credential and a claimed origin alone.
 *
 * `POST /pair/complete` answers with the credential *and* a read proof
 * ({@link readProofSchema}): 32 CSPRNG bytes the service draws at the moment
 * the one-time code is redeemed, returned exactly once to the extension that
 * redeemed it, and kept by the service only as a SHA-256 digest in the
 * credential's own record. The extension stores the proof beside its
 * credential and sends it in this header on each of those reads; no hello, no
 * connection and no origin can register or replace it.
 *
 * - **required** on every DevTools read, whether or not it claims the issuing
 *   extension's origin: a read without it, with a malformed or repeated one, or
 *   with one other than the proof issued with its credential (including a
 *   credential issued before proofs existed) is refused as `UNAUTHORIZED`
 *   (401), which the extension answers by dropping its pairing so the developer
 *   pairs again;
 * - **refused** on every other request: a write (bound to the extension by its
 *   `Origin`), an auth-exempt operation, or any credential other than a DevTools
 *   one. `./client/http-client.ts` refuses such a request, and a malformed
 *   proof, locally as `PROTOCOL_INVALID_MESSAGE` before anything is sent.
 *
 * ⚠️ The value is a secret of the same class as the credential: never logged,
 * echoed or reported, and deleted with the credential on rotation. Lowercase
 * for the reason {@link AUTHORIZATION_HEADER} is.
 */
export const READ_PROOF_HEADER = 'x-debuggen-read-proof';

/**
 * How many CSPRNG bytes a DevTools read proof carries: 256 bits, the strength
 * of the credential it accompanies.
 */
export const READ_PROOF_BYTES = 32;

/**
 * The wire length of a read proof: {@link READ_PROOF_BYTES} bytes as unpadded
 * base64url, `ceil(32 * 4 / 3)` = 43 characters.
 */
export const READ_PROOF_LENGTH = 43;

/** Exactly {@link READ_PROOF_LENGTH} base64url characters, nothing else. */
const READ_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * A DevTools read proof as it travels: in `POST /pair/complete`'s response
 * ({@link pairCompleteResponseSchema}) and in {@link READ_PROOF_HEADER}.
 *
 * ## Shape
 *
 * Exactly {@link READ_PROOF_LENGTH} base64url characters (`A–Z`, `a–z`, `0–9`,
 * `-`, `_`), no padding and no whitespace: the unpadded encoding of
 * {@link READ_PROOF_BYTES} random bytes. The service mints it; a client only
 * stores and repeats it, so one spelling is the whole contract.
 *
 * ⚠️ A secret: a refusal names the rule it broke, never the value.
 *
 * @example
 * ```ts
 * readProofSchema.safeParse('x'.repeat(READ_PROOF_LENGTH)).success; // true
 * readProofSchema.safeParse(' padded ').success; // false
 * ```
 */
export const readProofSchema = z.string().regex(READ_PROOF_PATTERN, {
  error: `expected a read proof of exactly ${String(READ_PROOF_LENGTH)} base64url characters`,
});

/**
 * Whether a value is a well-formed read proof — exactly
 * {@link READ_PROOF_LENGTH} base64url characters, as {@link readProofSchema}
 * requires. A type guard that never throws and never reports the value.
 *
 * @param value Anything; typically a header value or a stored proof.
 * @returns `true` for a well-formed proof.
 *
 * @example
 * ```ts
 * if (!isReadProof(headers.get(READ_PROOF_HEADER))) {
 *   // refuse, with a constant message
 * }
 * ```
 */
export function isReadProof(value: unknown): value is string {
  return readProofSchema.safeParse(value).success;
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

/**
 * A count the service reports as a body field: a non-negative safe integer.
 *
 * Used for the tallies of the two administrative reports (`credentials.rotate`
 * and `session.purge`). The field's own name goes into the refusal so a
 * producer that sent `-1` learns which tally was wrong; no value is ever
 * echoed.
 *
 * @param field The body field the count is declared under.
 * @returns An integer schema refusing a negative, fractional or unsafe value.
 */
function countSchema(field: string): z.ZodInt {
  const expectation = `expected ${field} to be a non-negative integer count`;

  return z.int({ error: expectation }).nonnegative({ error: expectation });
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
// `POST /sessions/:id/question`, `POST /sessions/:id/end`,
// `POST /sessions/purge`.
//
// The three request bodies are `./messages/session.ts`'s and are re-exported
// here under their own names so a caller that holds this module holds the whole
// route surface; they are not redeclared. The responses are this module's,
// because the session record and the cleanup vocabulary belong to
// `./session-record.ts` and a route is what binds them to a status code. The
// purge bodies are this module's too: the retention sweep acts on the store as
// a whole rather than on one session, and no WebSocket message carries them.
// ---------------------------------------------------------------------------

export {
  /**
   * The `session.create` request body,
   * `{ projectRoot, question, target?, devServerUrl? }`.
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

// ---------------------------------------------------------------------------
// Section C.1 — paged listings: `GET /sessions` and
// `GET /sessions/:id/modifications`
//
// Both listings are assembled by the service from its own store and both used
// to answer with every stored item in one body. Neither may: a developer who
// debugs a lot accumulates sessions until retention removes them, and a
// modification journal holds up to 256 records whose diffs may each reach
// 2 MiB. Each listing therefore answers one **page**, echoes the window it
// applied in the same four fields the panel-data results carry (`total`,
// `limit`, `offset`, `nextOffset`), and reads its window from the store with
// one indexed query instead of hydrating whole documents.
//
// The page window is requested with two query-string parameters, `limit` and
// `offset`, parsed by {@link parseListPageQuery}. A `GET` carries no body, so
// the query string is where a window can travel; every parameter is optional,
// and — as everywhere in this package — **no default is applied by a schema**:
// the service fills an omitted `limit` with the listing's documented default
// and an omitted `offset` with `0`, and echoes both.
// ---------------------------------------------------------------------------

/**
 * The query-string parameters a paged listing accepts, and nothing else.
 *
 * A request carrying any other parameter is refused rather than ignored, for the
 * reason every body in this package is a strict object: a parameter the service
 * does not honour is a client that disagrees with this contract, and silently
 * answering an unfiltered page would hide that disagreement.
 */
export const LIST_PAGE_QUERY_KEYS = ['limit', 'offset'] as const;

/** One parameter name of {@link LIST_PAGE_QUERY_KEYS}. */
export type ListPageQueryKey = (typeof LIST_PAGE_QUERY_KEYS)[number];

/**
 * The largest `offset` a listing accepts.
 *
 * `Number.MAX_SAFE_INTEGER`, so the value survives the string-to-number step
 * exactly; no store holds anywhere near that many rows, and an offset past the
 * end is an ordinary empty last page.
 */
export const LIST_PAGE_MAX_OFFSET = Number.MAX_SAFE_INTEGER;

/**
 * A canonical non-negative decimal integer as it appears in a query string: `0`,
 * or a digit string with no leading zero, no sign, no exponent and no
 * whitespace. Anything else — `"1e3"`, `" 5"`, `"05"`, `"-1"` — is refused
 * rather than coerced, so one window has exactly one spelling.
 */
const DECIMAL_INTEGER_PATTERN = /^(?:0|[1-9]\d{0,15})$/;

/** A query-string integer, validated as text: the conversion happens after. */
const queryIntegerSchema = z
  .string()
  .regex(DECIMAL_INTEGER_PATTERN, { error: 'expected a non-negative decimal integer' });

/**
 * The raw query of a paged listing: at most the two {@link LIST_PAGE_QUERY_KEYS},
 * each a canonical decimal integer string.
 *
 * Validated as text because a query string is text; {@link parseListPageQuery}
 * converts the validated strings to numbers and applies the listing's ceiling,
 * which is how the conversion stays out of the schema (no `.transform()` or
 * `.coerce` anywhere in this package).
 */
export const listPageQuerySchema = z.strictObject({
  /** The page size requested, as a decimal string. */
  limit: queryIntegerSchema.optional(),
  /** How many items to skip, as a decimal string. */
  offset: queryIntegerSchema.optional(),
});

/** A validated, converted page window. Absent members were not requested. */
export interface ListPageQuery {
  /** The requested page size, within the listing's ceiling. */
  readonly limit?: number;
  /** The requested offset, at most {@link LIST_PAGE_MAX_OFFSET}. */
  readonly offset?: number;
}

/** The ceiling a listing enforces on its `limit` parameter. */
export interface ListPageBounds {
  /** The largest page the listing serves. */
  readonly maxLimit: number;
}

/**
 * Validates the query string of a paged listing, without throwing.
 *
 * Shared by both listings so their window vocabulary cannot drift: the service's
 * `GET /sessions` and `GET /sessions/:id/modifications` handlers pass hono's
 * `c.req.query()` record here, and a refusal is the same `400`-mapped
 * `PROTOCOL_INVALID_MESSAGE` a malformed body produces. The error carries issue
 * paths and codes only, never the rejected text.
 *
 * @param query The request's query parameters, one value per name.
 * @param bounds The listing's `limit` ceiling —
 * {@link SESSION_LIST_MAX_LIMIT} or {@link MODIFICATIONS_PAGE_MAX_LIMIT}.
 * @returns `ok(window)` with only the members the request named, or
 * `err(error)` naming the offending parameter.
 */
export function parseListPageQuery(
  query: Readonly<Record<string, string | undefined>>,
  bounds: ListPageBounds,
): Result<ListPageQuery, DebuggenError> {
  const parsed = listPageQuerySchema.safeParse(query);

  if (!parsed.success) {
    return err(
      protocolParseError(
        'PROTOCOL_INVALID_MESSAGE',
        'Invalid listing query',
        parsed.error.issues,
        `Page a listing with at most "limit" (0 to ${String(bounds.maxLimit)}) and "offset" (a non-negative integer).`,
      ),
    );
  }

  const limit = parsed.data.limit === undefined ? undefined : Number(parsed.data.limit);
  const offset = parsed.data.offset === undefined ? undefined : Number(parsed.data.offset);

  if (limit !== undefined && limit > bounds.maxLimit) {
    return err(
      new DebuggenError('PROTOCOL_INVALID_MESSAGE', 'Invalid listing query: limit is too large', {
        hint: `Ask for at most ${String(bounds.maxLimit)} items per page and follow nextOffset for the rest.`,
        details: { parameter: 'limit', maxLimit: bounds.maxLimit },
      }),
    );
  }

  if (offset !== undefined && offset > LIST_PAGE_MAX_OFFSET) {
    return err(
      new DebuggenError('PROTOCOL_INVALID_MESSAGE', 'Invalid listing query: offset is too large', {
        hint: 'Follow nextOffset from the previous page instead of computing an offset.',
        details: { parameter: 'offset' },
      }),
    );
  }

  return ok({
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  });
}

/**
 * The paging echo of a listing, for a listing whose pages hold at most
 * `maxLimit` items.
 *
 * The same four fields and meanings as the panel-data results' `dataPageShape`
 * (Section I): `total` counts every item the listing holds in full, `limit` and
 * `offset` echo the window the service applied (its defaults included), and
 * `nextOffset` is the offset of the following page or `null` on the last one.
 * A factory rather than a reuse of that shape because each listing has its own,
 * smaller ceiling.
 *
 * @param maxLimit The listing's page ceiling.
 * @returns A spreadable shape.
 */
function listPageShape(maxLimit: number) {
  return {
    /** How many items the listing holds in total, before paging. */
    total: z.int().min(0, { error: 'expected a non-negative total' }),
    /** The page size the service applied: `0` is a count-only request. */
    limit: z
      .int()
      .min(0, { error: 'expected a non-negative limit' })
      .max(maxLimit, { error: `expected a limit of at most ${String(maxLimit)}` }),
    /** How many items were skipped before this page. */
    offset: z
      .int()
      .min(0, { error: 'expected a non-negative offset' })
      .max(LIST_PAGE_MAX_OFFSET, { error: 'expected a safe-integer offset' }),
    /** The offset of the following page, or `null` when this page is the last. */
    nextOffset: z.int().min(0, { error: 'expected a non-negative nextOffset' }).nullable(),
  };
}

/** The fields {@link checkListPage} reads from a parsed listing page. */
interface ListPageWindow {
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly nextOffset: number | null;
}

/** A page never holds more items than the page size it echoes. */
const LIST_PAGE_LIMIT_RULE =
  'a listing page holds at most limit items: it never exceeds the page size it echoes.';

/** A page never holds more items than remain from its offset. */
const LIST_PAGE_REMAINDER_RULE =
  'a listing page holds at most total minus offset items: it cannot carry more than remains.';

/** A following page starts past this one and inside the listing. */
const LIST_PAGE_NEXT_OFFSET_RULE =
  'nextOffset must lie past every item of this page, at most offset plus limit, and below total — or be null.';

/** A full page with items left beyond its window is not the last page. */
const LIST_PAGE_EARLY_END_RULE =
  'nextOffset must not be null while a full page leaves items beyond offset plus limit.';

/**
 * Records one breach of a listing's paging rule on `payload`, with no input
 * attached.
 */
function reportListPageIssue(
  payload: z.core.ParsePayload<unknown>,
  path: (string | number)[],
  message: string,
): void {
  payload.issues.push({ code: 'custom', path, message, input: undefined });
}

/**
 * Rejects a listing page that breaks the listings' paging rule.
 *
 * The page holds at most `limit` items and at most `total - offset` items.
 * `nextOffset` is the offset just past the part of the listing this page
 * **consumed**, or `null` when nothing remains after it. That is usually
 * `offset + length`, but a page may consume more of the window than it returns
 * — the session list leaves out a stored row it cannot read rather than empty
 * the Sessions tree, and moves past it — and it may end before `limit` — the
 * journal's diff budget. So a non-null `nextOffset` must lie past every item
 * returned (and past `offset`, so a loop always advances), no further than
 * `offset + limit` (a page consumes at most its window), and below `total`
 * (something remains); and a full page whose window ends before `total` must
 * not claim to be the last. `limit: 0` is a count-only request, whose only valid
 * `nextOffset` is `null`. A paging loop that follows `nextOffset` therefore
 * always advances, never skips an unread item, and always stops.
 *
 * @param payload The parse payload of the page being checked.
 * @param window The page's echoed window.
 * @param items The page's items, under `field`.
 * @param field The items' field name, the path a producer has to change.
 */
function checkListPage(
  payload: z.core.ParsePayload<unknown>,
  window: ListPageWindow,
  items: readonly unknown[],
  field: string,
): void {
  const { total, limit, offset, nextOffset } = window;

  if (items.length > limit) {
    reportListPageIssue(payload, [field], LIST_PAGE_LIMIT_RULE);
  }

  if (items.length > Math.max(0, total - offset)) {
    reportListPageIssue(payload, [field], LIST_PAGE_REMAINDER_RULE);
  }

  if (nextOffset === null) {
    if (limit > 0 && items.length === limit && offset + limit < total) {
      reportListPageIssue(payload, ['nextOffset'], LIST_PAGE_EARLY_END_RULE);
    }
    return;
  }

  const lowest = offset + Math.max(items.length, 1);

  if (nextOffset < lowest || nextOffset > offset + limit || nextOffset >= total) {
    reportListPageIssue(payload, ['nextOffset'], LIST_PAGE_NEXT_OFFSET_RULE);
  }
}

/**
 * The page size `GET /sessions` applies when the request names none.
 *
 * One hundred sessions, most recently updated first: more than a Sessions tree
 * shows at a glance, far fewer than a developer can accumulate over the
 * retention window. The service fills it in; no schema applies it.
 */
export const SESSION_LIST_DEFAULT_LIMIT = 100;

/**
 * The largest page `GET /sessions` serves.
 *
 * A request above it is refused rather than truncated, so a client never
 * mistakes a clipped page for the whole window it asked for.
 */
export const SESSION_LIST_MAX_LIMIT = 500;

/**
 * The session record's ceiling on its modification list, 256 — and, since a
 * conflict names one modification record, on the conflicts its cleanup can
 * record (`./session-record.ts` bounds both by the same number).
 */
const RECORD_MODIFICATION_CEILING = 256;

/**
 * A session's cleanup outcome as its list row reports it: the status, when the
 * pass completed, and **how many** conflicts it preserved.
 *
 * A count rather than the conflicts themselves, because a conflict may carry a
 * three-way diff (`ModificationConflict.diffs`, up to 512 KiB per member) — the
 * one thing a list row must never carry. The conflicts stay on the whole record
 * (`GET /sessions/:id`) and on the `cleanup.completed` frame. `status` and
 * `completedAt` reuse the record's own member schemas.
 */
export const sessionListCleanupSchema = z.strictObject({
  /** The cleanup status, over the record's four-value vocabulary. */
  status: cleanupStatusSchema,
  /** When the cleanup pass completed; absent while it has not. */
  completedAt: sessionCleanupSchema.shape.completedAt,
  /** How many files cleanup refused to overwrite and preserved. */
  conflictCount: z
    .int()
    .min(0, { error: 'expected a non-negative conflict count' })
    .max(RECORD_MODIFICATION_CEILING, {
      error: `expected at most ${String(RECORD_MODIFICATION_CEILING)} conflicts`,
    }),
});

/** A validated cleanup summary of a session list row. */
export type SessionListCleanup = z.infer<typeof sessionListCleanupSchema>;

/**
 * One row of the session list: the fields the editor's Sessions tree renders,
 * and nothing it would have to hydrate a whole record for.
 *
 * Picked from the imported {@link sessionRecordSchema} — the single definition of
 * the record — rather than restated, so a member's constraints are the record's
 * own, and `.pick()`/`.extend()` keep the record's strictness: a row carrying
 * any other member (a plan, a diff, an analysis) is refused. `cleanup`
 * is the diff-free {@link sessionListCleanupSchema} summary.
 *
 * Consumed by `apps/vscode-extension/src/views/sessions-tree.ts`, the editor's
 * `debuggen.reopenSession` quick pick through `src/state.ts`, and
 * `apps/local-service/src/server/routes/sessions.ts`, which builds each row from
 * the store's indexed projection without parsing the stored document.
 */
export const sessionListItemSchema = sessionRecordSchema
  .pick({
    id: true,
    projectRoot: true,
    projectName: true,
    status: true,
    question: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    /** The cleanup outcome, summarised. */
    cleanup: sessionListCleanupSchema,
  });

/** One validated row of the `GET /sessions` page. */
export type SessionListItem = z.infer<typeof sessionListItemSchema>;

/**
 * Projects a whole session record onto its list row.
 *
 * What a holder of a full record — a `session.updated` push, a reopened
 * session — uses to refresh the row it lists, so a list never retains a whole
 * record (its plans, diffs, analyses and conflict diffs) for a row that shows
 * eight fields. Pure, and the result shares no structure with the record.
 *
 * @param record A validated session record.
 * @returns The record's list row.
 */
export function toSessionListItem(record: SessionRecord): SessionListItem {
  const { status, completedAt, conflicts } = record.cleanup;

  return {
    id: record.id,
    projectRoot: record.projectRoot,
    projectName: record.projectName,
    status: record.status,
    question: record.question,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cleanup: {
      status,
      ...(completedAt === undefined ? {} : { completedAt }),
      conflictCount: conflicts.length,
    },
  };
}

/**
 * The `GET /sessions` response: one page of the sessions the requesting editor's
 * announced workspace covers, most recently updated first.
 *
 * Each row is a {@link SessionListItem}, never a whole record — reopening a
 * session (`GET /sessions/:id`) is how a client obtains one. `total` counts the
 * in-scope sessions before paging, so the tree can say how many older sessions
 * the page left out, and `nextOffset` names the following page.
 *
 * The page window is requested with the `limit` and `offset` query parameters
 * ({@link parseListPageQuery}); the service applies
 * {@link SESSION_LIST_DEFAULT_LIMIT} and offset `0` when they are omitted and
 * refuses a `limit` above {@link SESSION_LIST_MAX_LIMIT}. The ordering is stable
 * — `updatedAt` descending, the id breaking ties — so consecutive pages neither
 * repeat nor skip a session.
 *
 * Consumed by `apps/vscode-extension/src/views/sessions-tree.ts` (through
 * `src/service/client.ts`) and produced by
 * `apps/local-service/src/server/routes/sessions.ts`.
 */
export const sessionListResponseSchema = z
  .strictObject({
    /** This page's rows, most recently updated first. */
    sessions: z.array(sessionListItemSchema).max(SESSION_LIST_MAX_LIMIT, {
      error: `expected at most ${String(SESSION_LIST_MAX_LIMIT)} sessions in one page`,
    }),
    ...listPageShape(SESSION_LIST_MAX_LIMIT),
  })
  .check((payload) => {
    checkListPage(payload, payload.value, payload.value.sessions, 'sessions');
  });

/** The validated `GET /sessions` response body. */
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

/**
 * The largest page `GET /sessions/:id/modifications` serves: 256 records, the
 * session record's own ceiling on its modification list
 * (`./session-record.ts`), so a journal the record can describe always fits a
 * single count-bounded page.
 */
export const MODIFICATIONS_PAGE_MAX_LIMIT = RECORD_MODIFICATION_CEILING;

/**
 * The page size `GET /sessions/:id/modifications` applies when the request
 * names none: the whole count ceiling, so an ordinary journal arrives in one
 * page and only the diff budget ever ends a page early.
 */
export const MODIFICATIONS_PAGE_DEFAULT_LIMIT = MODIFICATIONS_PAGE_MAX_LIMIT;

/**
 * The most UTF-8 bytes one recorded diff can occupy: three times
 * `MAX_MODIFICATION_DIFF_LENGTH`, 6 MiB.
 *
 * `@debuggen/instrumentation` caps a diff in UTF-16 code units
 * (`string.length`, 2 Mi units). UTF-8 spends at most three bytes on one code
 * unit — a surrogate pair is two units encoded in four bytes, and a lone
 * surrogate is written as the three-byte replacement character — so no diff
 * the journal accepts encodes to more than this.
 */
export const MODIFICATION_DIFF_MAX_BYTES = 3 * MAX_MODIFICATION_DIFF_LENGTH;

/**
 * How many bytes of diff text one journal page may carry, summed over its
 * records and measured in UTF-8 — the encoding the page travels in: 6 MiB,
 * {@link MODIFICATION_DIFF_MAX_BYTES}.
 *
 * Equal to the largest single diff, which is what keeps a paging loop from
 * stalling: the first record of a page always fits, however large its diff.
 * The service measures each record's diff before it reads it — the session
 * store answers `octet_length(diff)` from the row header — so a page is ended
 * at the budget without loading the diff that would have exceeded it.
 */
export const MODIFICATIONS_PAGE_DIFF_BUDGET = MODIFICATION_DIFF_MAX_BYTES;

/** A journal page never carries more diff text than its budget. */
const MODIFICATIONS_PAGE_BUDGET_RULE = `the page's diffs must hold at most ${String(
  MODIFICATIONS_PAGE_DIFF_BUDGET,
)} UTF-8 bytes together: a larger journal continues at nextOffset.`;

/**
 * The number of bytes `text` occupies encoded as UTF-8 — the unit
 * {@link MODIFICATIONS_PAGE_DIFF_BUDGET} is measured in, and the one the session
 * store's `octet_length()` reports for the text it holds.
 *
 * Counted over the UTF-16 code units rather than by encoding, so measuring a
 * diff allocates nothing. A lone surrogate counts three bytes: it has no UTF-8
 * form and is encoded as U+FFFD, which is what the store then holds.
 *
 * @param text Any string.
 * @returns Its UTF-8 byte length.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;

  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);

    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        // A surrogate pair: one code point beyond the BMP, four bytes.
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

/**
 * The diff text a set of journal records carries, in the unit
 * {@link MODIFICATIONS_PAGE_DIFF_BUDGET} is measured in: UTF-8 bytes.
 *
 * Exported so the service ends each page by the same arithmetic this module
 * validates it with.
 *
 * @param records Journal records, or anything carrying their `diff`.
 * @returns The summed UTF-8 byte length of the records' diffs.
 */
export function modificationsDiffBytes(
  records: readonly Pick<ModificationRecord, 'diff'>[],
): number {
  let bytes = 0;

  for (const record of records) {
    bytes += utf8ByteLength(record.diff);
  }

  return bytes;
}

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

/**
 * The most session ids one `session.purge` report lists.
 *
 * Unlike {@link sessionListResponseSchema}, whose purpose is completeness — the
 * Sessions tree shows every session — the purge report is a summary: counts of
 * what the sweep removed, plus enough ids to name what it kept. The number of
 * aged sessions an unresolved conflict holds back grows with every session a
 * developer leaves conflicted, so the list is bounded here and
 * `sessionsRetainedForConflictsTotal` carries the true count. A truncated list
 * is therefore never mistaken for a complete one, and a reply cannot grow with
 * the developer's history.
 */
export const SESSION_PURGE_MAX_REPORTED_SESSIONS = 100;

/**
 * The `POST /sessions/purge` request body: `{}`, and strictly that.
 *
 * The retention window is the service's configuration —
 * `DEBUGGEN_RETENTION_DAYS` — and never a caller's choice: a body that could
 * shorten the window would let one call delete sessions the developer's own
 * setting keeps.
 * Strict over an empty shape for the reason {@link pairStartRequestSchema} is,
 * so a body carrying a key is refused rather than silently ignored.
 */
export const sessionPurgeRequestSchema = z.strictObject({});

/** The validated `POST /sessions/purge` request body. */
export type SessionPurgeRequest = z.infer<typeof sessionPurgeRequestSchema>;

/**
 * The refusal a purge report whose conflict list disagrees with its total
 * carries. Names fields and the bound, never a value.
 */
const SESSION_PURGE_TRUNCATION_RULE = `sessionsRetainedForConflicts must list exactly min(sessionsRetainedForConflictsTotal, ${String(
  SESSION_PURGE_MAX_REPORTED_SESSIONS,
)}) ids: the list is truncated at the bound, never partial below it.`;

/** The refusal a purge report that names one retained session twice carries. */
const SESSION_PURGE_UNIQUE_ID_RULE =
  'sessionsRetainedForConflicts must not repeat an id: each retained session is listed once.';

/**
 * Records one breach of the purge report's list rule on `payload`.
 *
 * @param payload The parse payload of the purge report being checked.
 * @param path The field a producer has to change, as a Zod issue path.
 * @param message One of the `SESSION_PURGE_*_RULE` statements above.
 */
function reportSessionPurgeIssue(
  payload: z.core.ParsePayload<unknown>,
  path: (string | number)[],
  message: string,
): void {
  payload.issues.push({
    code: 'custom',
    path,
    message,
    // Left empty for the reason `reportMetricsPageIssue` states: a failure here
    // never carries the value that caused it.
    input: undefined,
  });
}

/**
 * Rejects a purge report whose retained-session list is not the truncation of
 * its total.
 *
 * Two checks, each on the path a producer has to change: the list holds exactly
 * `min(total, SESSION_PURGE_MAX_REPORTED_SESSIONS)` ids — every retained
 * session while there are at most that many, and the first that many of them
 * otherwise — and no id repeats, reported at the repeating index. A list past
 * its `.max` or a negative total is already an issue of its own and does not
 * abort the parse, so the comparison is written to hold for any integer.
 */
function checkSessionPurgeReport(
  payload: z.core.ParsePayload<{
    readonly sessionsRetainedForConflicts: readonly string[];
    readonly sessionsRetainedForConflictsTotal: number;
  }>,
): void {
  const { sessionsRetainedForConflicts: listed, sessionsRetainedForConflictsTotal: total } =
    payload.value;

  if (listed.length !== Math.max(0, Math.min(total, SESSION_PURGE_MAX_REPORTED_SESSIONS))) {
    reportSessionPurgeIssue(
      payload,
      ['sessionsRetainedForConflicts'],
      SESSION_PURGE_TRUNCATION_RULE,
    );
  }

  const seen = new Set<string>();

  for (const [index, sessionId] of listed.entries()) {
    if (seen.has(sessionId)) {
      reportSessionPurgeIssue(
        payload,
        ['sessionsRetainedForConflicts', index],
        SESSION_PURGE_UNIQUE_ID_RULE,
      );
    }

    seen.add(sessionId);
  }
}

/**
 * The `POST /sessions/purge` response: what one retention sweep removed, and
 * what it kept.
 *
 * The retention sweep runs at service start and, through this operation, on
 * demand from the editor command `debuggen.purgeSessions`. It
 * deletes the sessions last updated before the window `DEBUGGEN_RETENTION_DAYS`
 * sets, together with their telemetry, panels, analyses, modification records
 * and backup directories; code-index caches whose project was not opened
 * inside the same window; and backup files no modification record references
 * once they are older than seven days. Conflict backups are exempt until the
 * conflict is resolved: an aged session whose journal holds a `conflict`
 * record keeps its rows and its backups, and is named in
 * `sessionsRetainedForConflicts` instead of being counted as deleted.
 *
 * A successful reply means the sweep ran, not that every item went: a
 * per-item problem (a backup that could not be removed, a session another
 * operation touched mid-sweep) is stepped over and counted in `issueCount`,
 * and its detail stays with the service. The counts are therefore what the
 * sweep actually removed, so the editor can report exactly what went and then
 * refresh its Sessions tree. Paths and messages are deliberately absent — the
 * report is a count of what went, and the developer's file layout is not the
 * client's to read.
 *
 * `.check()` preserves `.shape`, so a consumer can still read one field's
 * schema from the object.
 */
export const sessionPurgeResponseSchema = z
  .strictObject({
    /**
     * The age threshold the sweep applied, in epoch milliseconds: a session
     * last updated strictly before this instant was a purge candidate.
     *
     * Deliberately **not** {@link epochMsSchema}. That schema's lower bound
     * (2020-01-01) exists to refuse a mis-scaled *event* timestamp, while this
     * value is computed as `now − DEBUGGEN_RETENTION_DAYS × 86 400 000`, and a
     * retention window configured in years — which the service accepts — puts
     * it legitimately before that bound. A finite number is required, and the
     * upper bound is kept, because a cutoff is never later than the moment the
     * sweep ran.
     */
    cutoff: z
      .number({ error: 'expected a finite cutoff instant in epoch milliseconds' })
      .max(MAX_EPOCH_MS, {
        error:
          'expected a cutoff instant in epoch milliseconds (a microsecond- or nanosecond-scale value is too large)',
      }),

    /** How many sessions were deleted. */
    sessionsDeleted: countSchema('sessionsDeleted'),

    /** How many telemetry events the deleted sessions held. */
    telemetryEventsDeleted: countSchema('telemetryEventsDeleted'),

    /** How many panels the deleted sessions held. */
    panelsDeleted: countSchema('panelsDeleted'),

    /** How many analyses the deleted sessions held. */
    analysesDeleted: countSchema('analysesDeleted'),

    /** How many modification-journal records the deleted sessions held. */
    modificationsDeleted: countSchema('modificationsDeleted'),

    /**
     * How many backup directories were removed: those of deleted sessions, and
     * session directories the orphan rule left empty.
     */
    backupDirsDeleted: countSchema('backupDirsDeleted'),

    /** How many unreferenced backup files past the seven-day grace were removed. */
    orphanBackupsDeleted: countSchema('orphanBackupsDeleted'),

    /** How many code-index cache entries were removed. */
    indexCachesDeleted: countSchema('indexCachesDeleted'),

    /**
     * The aged sessions kept because their journal holds a `conflict` record,
     * in the sweep's sorted order: all of them while there are at most
     * {@link SESSION_PURGE_MAX_REPORTED_SESSIONS}, and the first that many
     * otherwise.
     */
    sessionsRetainedForConflicts: z.array(idSchema()).max(SESSION_PURGE_MAX_REPORTED_SESSIONS, {
      error: `expected at most ${String(SESSION_PURGE_MAX_REPORTED_SESSIONS)} retained session ids`,
    }),

    /** How many aged sessions were kept for a conflict, whether or not all are listed. */
    sessionsRetainedForConflictsTotal: countSchema('sessionsRetainedForConflictsTotal'),

    /** How many per-item problems the sweep recorded and stepped over. */
    issueCount: countSchema('issueCount'),

    /** How long the sweep took, in milliseconds of monotonic time. */
    durationMs: z
      .number({ error: 'expected a finite durationMs' })
      .nonnegative({ error: 'expected a non-negative durationMs' }),
  })
  .check(checkSessionPurgeReport);

/** The validated `POST /sessions/purge` response body. */
export type SessionPurgeResponse = z.infer<typeof sessionPurgeResponseSchema>;

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
// Section D2 — the target-request route
//
// `POST /sessions/:id/target/request`.
//
// The editor's half of element selection. The VS Code view's
// element-request control has no DevTools connection of its own, so it asks the
// service, and the service — the one process that knows which tab is bound to
// the session — pushes `target.request { sessionId }` to that tab's connection
// alone (`./messages/target.ts`). The operation id is the message's own name,
// exactly as `telemetry.event` is both an ingest route and a frame: one
// instruction, carried editor→service over HTTP and service→panel over the
// WebSocket. The panel's answer is a `target.selected` frame, whose verdict the
// editor observes as the `session.updated` that carries the new target.
//
// ERROR CONTRACT, which the service implements and every client may switch on.
// Each failure is the shared error body (`httpErrorResponseSchema`), checked in
// this order:
//
//   401 `UNAUTHORIZED`              no valid credential.
//   403 `UNAUTHORIZED`              a credential of another role: the route is
//                                   for the editor (role `vscode`) alone — a
//                                   DevTools panel enters picker mode on its
//                                   own, and a server-agent has no panel to ask.
//   404 `SESSION_NOT_FOUND`         no such session.
//   409 `SESSION_INVALID_STATE`     the session has ended or failed terminally,
//                                   so a target could no longer be used.
//   409 `TAB_NOT_BOUND`             the session has no bound DevTools tab: the
//                                   developer opens the Debug Generator panel in
//                                   the app's tab first.
//   503 `TRANSPORT_DISCONNECTED`    a tab is bound but its connection is
//                                   offline, so no frame could be handed to it.
//
// Success means the frame was handed to the bound tab's live connection, never
// that an element was picked: picking is the developer's, and it may never
// happen, which costs the session nothing (a target is an input to the first
// stage, never a precondition).
// ---------------------------------------------------------------------------

/**
 * The `target.request` request body: `{}`, and strictly that.
 *
 * The session comes from the route and the recipient from the session's
 * binding, so there is nothing left to say. Strict, like every other empty
 * body here: a caller that sends `{ tabId }` believes it can choose which tab
 * enters picker mode, and silence would let it keep believing that — the
 * binding, not the caller, decides.
 */
export const targetRequestRequestSchema = z.strictObject({});

/** The validated `POST /sessions/:id/target/request` request body. */
export type TargetRequestRequest = z.infer<typeof targetRequestRequestSchema>;

/**
 * The `target.request` response: the session whose bound DevTools tab received
 * the `target.request` push, and that tab.
 *
 * The tab id is what lets the editor say *where* to pick — in the Debug
 * Generator panel of that tab — and correlate the push with the
 * `session.bound` state it already shows. Its rule is `./messages/binding.ts`'s
 * own tab-id schema, taken by identity from the `session.bind` payload rather
 * than restated: a non-negative safe integer, never `-1`
 * (`chrome.tabs.TAB_ID_NONE`).
 */
export const targetRequestResponseSchema = z.strictObject({
  /** The session whose bound tab was asked to enter element-picker mode. */
  sessionId: idSchema(),

  /** The bound DevTools tab the `target.request` frame was handed to. */
  tabId: sessionBindPayloadSchema.shape.tabId,
});

/** The validated `POST /sessions/:id/target/request` response body. */
export type TargetRequestResponse = z.infer<typeof targetRequestResponseSchema>;

// ---------------------------------------------------------------------------
// Section E — the panel routes
//
// `POST /sessions/:id/panel-data`, `GET /sessions/:id/panel`,
// `GET /sessions/:id/panels/:panelId`.
// ---------------------------------------------------------------------------

/**
 * The `POST /sessions/:id/panel-data` request body: the node's own `DataQuery`,
 * field for field, plus the optional `panelId` of the panel specification the
 * node was rendered from.
 *
 * ## The query half is panel-schema's, by identity
 *
 * Built by **extending** `@debuggen/panel-schema`'s `dataQuerySchema`, never by
 * restating it: `.extend` keeps every one of that schema's field schemas as the
 * very same object (`panelDataRequestSchema.shape.source` *is*
 * `dataQuerySchema.shape.source`), and it keeps the strict object, so an
 * unrecognised key is still a rejection. A panel node's `query` therefore
 * travels field for field as the node carries it
 * (`packages/panel-renderer/src/host/useQuery.ts` →
 * `apps/chrome-extension/src/panel/data-provider.ts`), and the node catalog's
 * per-node source constraints — validated against *that* schema — cannot drift
 * from what this route accepts. Re-declaring a query field here would give it a
 * second definition, and two definitions can only drift apart. The identity is
 * asserted field by field in `./__tests__/http.test.ts` and at compile time in
 * {@link PanelDataRequestIsDataQueryWithPanelId}.
 *
 * ## `panelId` says which evidence the node describes
 *
 * A session holds several captures and several panel versions (a follow-up
 * stores the next `panelVersion`, and each panel row keeps the capture it was
 * generated from), and the query alone names neither. With `panelId`, the
 * service answers from the capture that panel was generated from, so a panel
 * that is still on screen after a newer capture started keeps drawing the
 * evidence its own findings cite; a `panelId` the session does not hold is
 * refused rather than answered from some other capture. Without it, the service
 * reads **live** evidence: the session's open capture, else its most recent
 * one — which is what a view with no rendered panel behind it asks for.
 *
 * `panelId` is an opaque identifier checked for exactly what a transport can
 * check — present means non-empty and at most sixty-four characters, the bound
 * every other identifier in this module and `panel.generated`'s own `panelId`
 * carry — and resolved where the panel row lives. A stored specification's own
 * `id` may be longer (panel-schema bounds a stored document more generously);
 * such a panel cannot be named here, exactly as `panel.generated` cannot
 * announce it. The field sits beside the query fields rather than wrapping them
 * because the query must stay the node's own, unwrapped, for the identity above
 * to hold.
 *
 * ## Semantics the service implements
 *
 * Stated here because this schema is the contract: `filter` narrows the source;
 * `sort` orders with a stable secondary key (each source's `id`) so equal keys
 * never reorder between pages; `limit` and `offset` page the array-valued
 * sources, and the response echoes `total` and `nextOffset` so a view never has
 * to guess whether more remain. **No default is applied by this schema.** An
 * omitted `limit` means `DATA_QUERY_DEFAULT_LIMIT` and an omitted `offset` means
 * `DATA_QUERY_DEFAULT_OFFSET`, both applied by
 * `apps/local-service/src/panels/data.ts`; `limit: 0` is a legitimate request
 * for no items and is not the same as an omitted one; and an omitted `panelId`
 * stays omitted — it is never filled in with the session's current panel.
 */
export const panelDataRequestSchema = dataQuerySchema.extend({
  /**
   * The id of the panel specification the querying node belongs to — the
   * rendered `PanelSpec`'s own `id`. Present, the service answers from the
   * capture that panel was generated from and refuses a panel the session does
   * not hold; absent, it answers from the open capture, else the most recent.
   */
  panelId: idSchema()
    .optional()
    .describe(
      'The id of the panel specification the node was rendered from; the service answers from the capture that panel was generated from. Omitted, it reads the open capture, else the most recent one.',
    ),
});

/**
 * The validated panel-data request body: a `DataQuery`, plus the optional
 * `panelId` of the panel the node belongs to.
 *
 * Inferred from {@link panelDataRequestSchema}, so every query field keeps
 * `@debuggen/panel-schema`'s own type and a bare `DataQuery` is a valid body as
 * it stands — a consumer that sends live reads needs no second type.
 */
export type PanelDataRequest = z.infer<typeof panelDataRequestSchema>;

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
 * ## One page at a time, under a diff budget
 *
 * A journal holds at most {@link MODIFICATIONS_PAGE_MAX_LIMIT} records and each
 * diff may reach `MAX_MODIFICATION_DIFF_LENGTH` (2 MiB), so the whole journal in
 * one body could be hundreds of megabytes. The response is therefore one page
 * of the journal in application order, bounded twice:
 *
 * - by count — `limit` records at most, {@link MODIFICATIONS_PAGE_DEFAULT_LIMIT}
 *   when the request names none (the `limit` and `offset` query parameters,
 *   {@link parseListPageQuery}); and
 * - by size — the page's diffs together hold at most
 *   {@link MODIFICATIONS_PAGE_DIFF_BUDGET} UTF-8 bytes. The service ends a page
 *   early rather than exceed it and says so through `nextOffset`; because no
 *   single diff can exceed the budget, a page always carries at least one
 *   record while any remain.
 *
 * `total` is the journal's length, so a caller that only needs the count asks
 * for `limit=0` and receives no diff at all. Records keep the full
 * `modificationRecordSchema` shape — hashes, backup path and diff — because
 * this route answers with modification records, and the reversibility checks
 * and the diff views read exactly those fields.
 */
export const modificationsResponseSchema = z
  .strictObject({
    /** This page's records, in the order they were applied. */
    modifications: z.array(modificationRecordSchema).max(MODIFICATIONS_PAGE_MAX_LIMIT, {
      error: `expected at most ${String(MODIFICATIONS_PAGE_MAX_LIMIT)} modification records in one page`,
    }),
    ...listPageShape(MODIFICATIONS_PAGE_MAX_LIMIT),
  })
  .check((payload) => {
    const { modifications } = payload.value;
    checkListPage(payload, payload.value, modifications, 'modifications');

    if (modificationsDiffBytes(modifications) > MODIFICATIONS_PAGE_DIFF_BUDGET) {
      reportListPageIssue(payload, ['modifications'], MODIFICATIONS_PAGE_BUDGET_RULE);
    }
  });

/** The validated `GET /sessions/:id/modifications` response body. */
export type ModificationsResponse = z.infer<typeof modificationsResponseSchema>;

/**
 * The operations that answer one page of a listing and read the
 * {@link LIST_PAGE_QUERY_KEYS} window from the query string.
 *
 * The only operations a client may send a query to: every other route takes
 * its input from the path and the body alone.
 */
export const LIST_PAGE_OPERATIONS = ['session.list', 'modifications.list'] as const;

/** One of {@link LIST_PAGE_OPERATIONS}. */
export type ListPageOperation = (typeof LIST_PAGE_OPERATIONS)[number];

/**
 * Whether `operation` answers a page and accepts a window.
 *
 * @param operation Any operation id.
 * @returns `true` for a member of {@link LIST_PAGE_OPERATIONS}.
 */
export function isListPageOperation(operation: string): operation is ListPageOperation {
  return (LIST_PAGE_OPERATIONS as readonly string[]).includes(operation);
}

/**
 * The window a client asks a listing for. Both members are optional: the
 * service applies the listing's default `limit` and an `offset` of `0` to an
 * omitted one, and echoes both in the page.
 *
 * Declared with `| undefined` so a caller can forward its own optional window
 * without a conditional spread.
 */
export interface ListPageRequest {
  /** The page size, from `0` to the listing's ceiling. */
  readonly limit?: number | undefined;
  /** How many items to skip — a page's `nextOffset`, or `0`. */
  readonly offset?: number | undefined;
}

/**
 * The largest `limit` each listing serves — the ceiling
 * {@link parseListPageQuery} enforces on the service side.
 */
export const LIST_PAGE_MAX_LIMITS: Readonly<Record<ListPageOperation, number>> = Object.freeze({
  'session.list': SESSION_LIST_MAX_LIMIT,
  'modifications.list': MODIFICATIONS_PAGE_MAX_LIMIT,
});

/**
 * Encodes a window as the query string of a paged listing — the inverse of
 * {@link parseListPageQuery}, so what a client sends is exactly what the service
 * accepts: each present member as a canonical decimal integer, in
 * {@link LIST_PAGE_QUERY_KEYS} order, and nothing for an empty window.
 *
 * Refuses, rather than clamps, a member the service would refuse — a limit
 * above the listing's ceiling, a negative, fractional or unsafe number — and a
 * window sent to an operation that takes none, so a caller learns of the
 * mistake before a request is made. The error names the parameter, never its
 * value.
 *
 * @param operation The operation the window is for.
 * @param window The requested window.
 * @returns `ok("")` for an empty window, `ok("?limit=…&offset=…")` otherwise,
 * or `err(error)` with code `PROTOCOL_INVALID_MESSAGE`.
 */
export function formatListPageQuery(
  operation: HttpOperationId,
  window: ListPageRequest,
): Result<string, DebuggenError> {
  const requested: readonly (readonly [ListPageQueryKey, number | undefined])[] = [
    ['limit', window.limit],
    ['offset', window.offset],
  ];
  const present = requested.filter(
    (entry): entry is readonly [ListPageQueryKey, number] => entry[1] !== undefined,
  );

  if (present.length === 0) {
    return ok('');
  }

  if (!isListPageOperation(operation)) {
    return err(
      new DebuggenError(
        'PROTOCOL_INVALID_MESSAGE',
        `Invalid ${operation} request: the operation takes no page window`,
        {
          hint: `Only ${LIST_PAGE_OPERATIONS.join(' and ')} answer a page; send no limit or offset to any other route.`,
          details: { operation },
        },
      ),
    );
  }

  const ceilings: Readonly<Record<ListPageQueryKey, number>> = {
    limit: LIST_PAGE_MAX_LIMITS[operation],
    offset: LIST_PAGE_MAX_OFFSET,
  };
  const parts: string[] = [];

  for (const [parameter, value] of present) {
    const ceiling = ceilings[parameter];

    if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) {
      return err(
        new DebuggenError(
          'PROTOCOL_INVALID_MESSAGE',
          `Invalid ${operation} request: ${parameter} is out of range`,
          {
            hint: `Send ${parameter} as an integer from 0 to ${String(ceiling)}; follow nextOffset for the rest.`,
            details: { operation, parameter, maxValue: ceiling },
          },
        ),
      );
    }

    parts.push(`${parameter}=${String(value)}`);
  }

  return ok(`?${parts.join('&')}`);
}

// ---------------------------------------------------------------------------
// Section F — the telemetry ingest route
//
// `POST /telemetry/ingest`.
//
// A required route, not a stray one: the Node preload posts its server spans
// here as `telemetry.event`, with its server-agent credential and a
// `{ projectRoot, events: TelemetryEventIngress[], armedCaptureId?, droppedCount?,
// lossReportId? }` body; `apps/local-service/src/server/routes/telemetry.ts`
// serves it; and `docs/ARCHITECTURE.md` section 4.3 lists it among the HTTP
// routes. Deleting it would leave the preload nowhere to post, so the table
// below carries it.
//
// The first two optional fields are the same delivery context the WebSocket
// payload of `telemetry.event` carries, embedded from `./messages/telemetry.ts`
// rather than restated, so both transports refuse the same values in the same
// words:
//
// - `armedCaptureId` is the capture the preload was armed for
//   (`server-agent.config`) when it recorded the batch. It is refusal-only: the
//   service still attributes by the credential's project scope and that
//   project's open capture window, and reads the field solely to refuse a batch
//   naming a different capture — a batch retried across a capture stop and
//   start, whose spans belong to the window that has closed.
// - `droppedCount` is how many spans the preload discarded for that capture
//   since its previous loss report, which the service adds to the capture's
//   ledger so the summary can say its server evidence is incomplete.
//
// A third optional field is this transport's alone:
//
// - `lossReportId` is the producer-chosen identity of the body's loss report,
//   stable across every retry of the same report. The preload sends the same
//   serialized body again after a timeout or a retryable failure, so a report
//   the service recorded but whose reply was lost arrives again; the service
//   applies a report at most once per capture and `lossReportId`. It identifies
//   a report, never a session or a capture, and authorizes nothing. It is
//   accepted only beside a `droppedCount` above zero — a body reporting no
//   loss has no report to name — and its identifier rule is embedded from
//   `./messages/telemetry.ts` like the other two.
//
// `events` may be empty only beside a `droppedCount` above zero: a loss-only
// report, which is how a loss reaches the ledger when no later batch will carry
// it. Every other empty batch is refused, by the same object-level check the
// WebSocket payload applies.
//
// Note which side of the wire reads this definition. `@debuggen/telemetry` sits
// BELOW this package in the layering and may not import it, so the Node preload
// learns where to post from `DEBUGGEN_INGEST_URL` and validates nothing against
// this table; the table is the canonical definition for the SERVICE, which
// registers the route, and for any future client of it.
// ---------------------------------------------------------------------------

/**
 * What a `lossReportId` on a body that reports no loss is answered with.
 *
 * Constant, so the refusal states the rule and never the identifier received.
 */
const LOSS_REPORT_ID_RULE =
  'expected lossReportId only beside a droppedCount above zero: it names a loss report, and a body that reports no loss carries none';

/**
 * The label a `lossReportId` without a loss is refused under.
 *
 * Rendered by `describeZodIssues` as
 * `lossReportId (custom label=loss-report-id-requires-loss)`: the rule that
 * failed, and no received value. It passes the renderer's name gate, so it is
 * shown verbatim.
 */
const LOSS_REPORT_ID_LABEL = 'loss-report-id-requires-loss';

/**
 * Refuses an ingest body whose `lossReportId` names no loss.
 *
 * The identity exists so that the service applies a retried loss report once. A
 * body without a `droppedCount` above zero reports nothing to apply, so an
 * identity on it is a producer bug, refused rather than silently ignored.
 *
 * Whether the field is admissible depends on `droppedCount`, so this is a check
 * on the object: it keeps the `ZodObject` and its `.shape`, as
 * `requireLossReportForEmptyBatch` does. It runs only on an otherwise valid
 * body — a malformed `lossReportId` or `droppedCount` is reported by its own
 * issue, and an event-less body without a loss by the loss-only rule — so it
 * never piles a derived issue on top of another. The message is constant and
 * `input` is left empty, so the rejection never carries the identifier sent.
 *
 * @param parsed The body's parse state, whose `value` is the parsed body.
 */
function requireLossForLossReportId(
  parsed: z.core.ParsePayload<{
    readonly droppedCount?: number | undefined;
    readonly lossReportId?: string | undefined;
  }>,
): void {
  if (parsed.issues.length > 0) {
    return;
  }

  const { droppedCount, lossReportId } = parsed.value;

  if (lossReportId === undefined || (droppedCount !== undefined && droppedCount > 0)) {
    return;
  }

  parsed.issues.push({
    code: 'custom',
    path: ['lossReportId'],
    message: LOSS_REPORT_ID_RULE,
    params: { label: LOSS_REPORT_ID_LABEL },
    // Left empty on purpose: a rejection never carries what was received.
    input: undefined,
  });
}

/**
 * The `telemetry.event` ingest body: which project the spans belong to, the
 * spans, and optionally the capture they were recorded for, the spans lost on
 * the way, and the identity of that loss report.
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
 *
 * **`armedCaptureId` is refusal-only.** It names the capture the preload was
 * armed for by `server-agent.config` when it recorded the batch. The service
 * still attributes the batch by the credential's project scope and that
 * project's open capture window, and uses this value solely to refuse a batch
 * that names a *different* capture — one retried across a capture stop and
 * start, which would otherwise land in the next capture. Naming the open
 * capture adds no authority over omitting the field, and naming another can
 * only discard the preload's own batch, so the field can never choose a session
 * or a capture.
 *
 * **`droppedCount` is a loss report.** It counts the spans the preload
 * discarded for that capture since its previous loss report; absent means none
 * were reported. The service adds it to the capture's ledger, so a summary with
 * missing server evidence says so instead of looking whole.
 *
 * **`lossReportId` makes a retried loss report count once.** It is a
 * producer-chosen identity for this body's loss report, stable across every
 * retry of the same report: the preload sends the same serialized body again
 * after a timeout or a retryable failure, so a report the service recorded but
 * whose reply was lost arrives again, and the service applies a report at most
 * once per capture and `lossReportId`. It identifies a report — never a session
 * or a capture — and never authorizes anything. It is accepted only beside a
 * `droppedCount` above zero, by `requireLossForLossReportId` under the
 * `lossReportId` path; the WebSocket payload has no such field, because the
 * HTTP transport is the one that retries a body in place.
 *
 * **An event-less body is a loss-only report.** `events` may be empty only when
 * `droppedCount` is above zero — what the preload sends when no later batch
 * will carry its loss. Any other empty batch is refused under the `events` path
 * by `requireLossReportForEmptyBatch`, the check the WebSocket payload applies.
 * Both cross-field rules are checks on the object rather than field
 * constraints, so the schema stays a `ZodObject` whose `.shape` the service
 * reads structurally — the `events` bound, the `projectRoot` field schema and
 * each optional field.
 *
 * `armedCaptureId` and `droppedCount` are the WebSocket payload's own factories
 * (`armedCaptureIdSchema`, `droppedCountSchema` in `./messages/telemetry.ts`),
 * so a server batch is refused for exactly what a browser batch is, in the
 * same words; `lossReportId` is `lossReportIdSchema` from the same module, the
 * identifier rule `armedCaptureId` applies.
 */
export const telemetryIngestRequestSchema = z
  .strictObject({
    /** The project whose dev server produced these spans. */
    projectRoot: projectRootSchema(),

    /**
     * The batch, each element validated as a producer's event.
     *
     * Bounded by {@link MAX_INGEST_EVENTS_PER_REQUEST}, and empty only beside a
     * loss report — the first object-level check below, since whether it may be
     * empty depends on `droppedCount`.
     */
    events: z.array(telemetryEventIngressSchema).max(MAX_INGEST_EVENTS_PER_REQUEST, {
      error: `expected at most ${String(
        MAX_INGEST_EVENTS_PER_REQUEST,
      )} telemetry events in one request`,
    }),

    /**
     * The capture the preload was armed for when it recorded these spans.
     * Refusal-only context: never used to choose a session or a capture.
     */
    armedCaptureId: armedCaptureIdSchema().optional(),

    /** Spans the preload discarded for that capture since its previous loss report. */
    droppedCount: droppedCountSchema().optional(),

    /**
     * The identity of this body's loss report, stable across its retries; only
     * beside a `droppedCount` above zero. Identifies a report, never a session
     * or a capture, and authorizes nothing.
     */
    lossReportId: lossReportIdSchema().optional(),
  })
  .check(requireLossReportForEmptyBatch)
  .check(requireLossForLossReportId);

/**
 * The validated `POST /telemetry/ingest` request body: `projectRoot`, `events`,
 * and the optional `armedCaptureId`, `droppedCount` and `lossReportId`.
 */
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
// `POST /dev-server/launch`, `POST /dev-server/stop`,
// `POST /dev-server/credential`.
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
 *
 * `sessionId` decides who owns the process the service spawns. A launch that
 * names a session ties the child's lifetime to it: the child is stopped and its
 * `server-agent` credential revoked when the last session that launched or
 * joined it ends. A launch that names none is the developer's own dev server —
 * it keeps serving after any session ends, with the inert preload still
 * attached, until `POST /dev-server/stop`, the editor's deactivation or the
 * service's shutdown stops it.
 */
export const devServerLaunchRequestSchema = z.strictObject({
  /** The project whose dev server should be running. */
  projectRoot: projectRootSchema(),

  /**
   * The session this launch is for, when there is one.
   *
   * Shape only, like every id in this module. The service refuses an id that
   * names no session, a session of another project, or a session that has
   * already ended — a child tied to an ended session would have no owner left
   * to stop it.
   */
  sessionId: idSchema().optional(),

  /**
   * Where the project's dev server serves or is meant to serve, when the caller
   * knows: the editor's probed `debuggen.devServerUrl`, or — when the body
   * names a session and omits this — the service uses the URL that session
   * recorded. The launcher probes it first, so a second dev server is never
   * started on the port of one already answering there: a dev server the
   * service launched itself is reused, and any other — the service cannot
   * attribute a preload to a process it did not start — is reported with the
   * exact relaunch command. A child that prints no address is
   * polled at it. The same URL constraints as `session.create`'s.
   */
  devServerUrl: devServerUrlSchema.optional(),

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

/**
 * The `POST /dev-server/credential` request: which project the credential will
 * be scoped to.
 *
 * The route mints a server-agent credential for a dev server the caller starts
 * itself rather than through `devServer.launch` —
 * `scripts/dev-instrumented.mjs` requests one with the editor credential and
 * hands it to the Node preload as `DEBUGGEN_TOKEN`. The body is the same as
 * {@link devServerStopRequestSchema}'s, and checked for the same thing: a
 * non-empty, bounded path. Deliberately no absolute-path refinement: whether
 * the path is absolute, exists, and lies inside a workspace folder the
 * editor credential announced is answered by the service, which can resolve a
 * real path, and this package is Node-neutral (see `projectRootSchema`).
 */
export const devServerCredentialRequestSchema = z.strictObject({
  /** The project the minted credential may post ingest batches for. */
  projectRoot: projectRootSchema(),
});

/** The validated `POST /dev-server/credential` request body. */
export type DevServerCredentialRequest = z.infer<typeof devServerCredentialRequestSchema>;

/**
 * The `POST /dev-server/credential` response: the server-agent credential,
 * once, and when its first lease ends.
 *
 * One of exactly two HTTP responses in the product that carry a plaintext
 * credential — {@link pairCompleteResponseSchema} is the other — so the caller
 * treats `token` accordingly: it goes into the child's environment and nowhere
 * else, never into a log line, a message or a file. The credential is scoped
 * to the one `projectRoot` the request named, so `POST /telemetry/ingest` and
 * `client.hello` accept it only for that project. It is a lease, not a
 * fixed-term credential: the service renews it while a server-agent control
 * connection authenticated with it is online, revokes it shortly after that
 * connection is gone (the dev server exited) or when no preload connected
 * with it before `expiresAt`, and a lease nothing renews stops being accepted
 * at its end. The holder need not wait for any of that: it may release the
 * credential early through `credentials.release`
 * ({@link credentialsReleaseRequestSchema}), which is what
 * `scripts/dev-instrumented.mjs` does as its dev server exits. Nothing rides
 * along with the token: a role or a scope echoed here would be a client's word
 * for what it was granted.
 */
export const devServerCredentialResponseSchema = z.strictObject({
  /** The bearer credential for the Node preload, `DEBUGGEN_TOKEN`. */
  token: opaqueTokenSchema(),

  /**
   * When the credential's first lease ends, in Unix epoch milliseconds: the
   * instant it stops being accepted unless the service has renewed it for a
   * connected preload.
   */
  expiresAt: epochMsSchema,
});

/** The validated `POST /dev-server/credential` response body. */
export type DevServerCredentialResponse = z.infer<typeof devServerCredentialResponseSchema>;

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
 * validity, a service-wide rate limit of five failures then a sixty-second
 * lockout (never keyed by the caller-controlled `Origin`), and the same origin
 * policy every other route applies — the `chrome-extension://<id>`
 * origin the request arrives from becomes the scope of the credential it
 * returns, so a code observed elsewhere cannot be redeemed into a usable one.
 *
 * `code` is compared exactly as sent: the service neither trims it nor folds
 * its case, so a padded or lower-case submission is refused as a wrong code
 * and counts toward the lockout. The DevTools pair dialog normalises what the
 * developer typed before it submits.
 */
export const pairCompleteRequestSchema = z.strictObject({
  /**
   * The one-time code the developer copied from the editor, in the exact
   * spelling the editor showed.
   */
  code: opaqueTokenSchema(),
});

/** The validated `POST /pair/complete` request body. */
export type PairCompleteRequest = z.infer<typeof pairCompleteRequestSchema>;

/**
 * The `POST /pair/complete` response: the DevTools credential and the read
 * proof issued with it.
 *
 * Both are stored by `apps/chrome-extension/src/background/auth.ts` in
 * `chrome.storage.local`. The token is sent on every subsequent request as
 * {@link formatBearer}'s output and in the socket's `client.hello`; it is scoped
 * to the extension id that redeemed the code and is refused from any other
 * origin. The read proof is sent only as {@link READ_PROOF_HEADER} on the four
 * DevTools reads, which are refused without it. The service returns both
 * exactly once and keeps only their digests.
 */
export const pairCompleteResponseSchema = z.strictObject({
  /** The bearer credential for the paired DevTools client. */
  token: opaqueTokenSchema(),
  /** The read proof issued with {@link token}; see {@link READ_PROOF_HEADER}. */
  readProof: readProofSchema,
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
// Section H2 — credential rotation and release
//
// `POST /credentials/rotate` and `POST /credentials/release`. The revocation
// half of the access boundary: pairing (Section H) and the dev-server routes
// (Section G) mint credentials, the rotation withdraws every one of them at
// once, and the release withdraws the one server-agent credential its holder
// names.
// ---------------------------------------------------------------------------

/**
 * The `POST /credentials/rotate` request body: `{}`, and strictly that.
 *
 * Rotation is all or nothing: a body that could name one credential to keep
 * would be a way to survive the revocation the command exists to perform.
 * Which credential may call it — the editor's alone — is
 * the service's role table (Section A: no permission is expressed here), not
 * anything this body could say. Strict over an empty shape for the reason
 * {@link pairStartRequestSchema} is.
 */
export const credentialsRotateRequestSchema = z.strictObject({});

/** The validated `POST /credentials/rotate` request body. */
export type CredentialsRotateRequest = z.infer<typeof credentialsRotateRequestSchema>;

/**
 * The `POST /credentials/rotate` response: how much the rotation revoked.
 *
 * The route is what `debuggen.rotateServiceToken` calls, and it performs the
 * whole rotation: it deletes every row of the `credentials` table — the
 * DevTools credentials of paired extensions and the server-agent credentials of
 * launched dev servers among them — regenerates `$DEBUGGEN_HOME/auth.json` with
 * a new editor credential, and closes every open socket with
 * `WS_CLOSE_UNAUTHORIZED` (4401, `./messages/agent.ts`).
 * Paired Chrome extensions must pair again, and launched dev servers must be
 * relaunched to receive a fresh credential.
 *
 * The caller's own credential is among those deleted: this reply is the last
 * response it earns. The editor therefore reads the regenerated `auth.json`
 * before its next call and reconnects its socket with the new token. No
 * credential travels in this body — the new editor credential is written to
 * the `0600` file only, never onto the wire.
 */
export const credentialsRotateResponseSchema = z.strictObject({
  /** Credential rows deleted: every credential that existed before the call. */
  credentialsDeleted: countSchema('credentialsDeleted'),

  /** Open sockets closed with `WS_CLOSE_UNAUTHORIZED`. */
  socketsClosed: countSchema('socketsClosed'),
});

/** The validated `POST /credentials/rotate` response body. */
export type CredentialsRotateResponse = z.infer<typeof credentialsRotateResponseSchema>;

/**
 * The `POST /credentials/release` request: the one server-agent credential to
 * revoke now, named by its own plaintext token.
 *
 * The route exists for the holder of a {@link devServerCredentialResponseSchema}
 * credential — `scripts/dev-instrumented.mjs`, which requested it with the
 * editor credential for a dev server it started itself — to revoke it the
 * moment that dev server exits, instead of leaving it to authenticate until
 * the service's supervision notices the preload is gone (a
 * server-agent credential expires when its process exits). Which credential
 * may call it — the editor's alone — is the service's role table (Section A),
 * never anything this body says.
 *
 * The token is the only possible key. The service stores credentials only as
 * SHA-256 digests, and the plaintext is what the holder already has, so naming
 * it grants nothing new: a caller that does not hold a credential cannot name
 * it. Shape only, like every token field here ({@link MAX_OPAQUE_TOKEN_LENGTH});
 * the service hashes the value and compares digests, and never logs, echoes
 * or stores the plaintext. Strict, so a field that tried to widen the release
 * — a project, a role, "all" — is refused rather than ignored.
 *
 * @example
 * ```ts
 * const body: CredentialsReleaseRequest = { token: leasedToken };
 * await client.request('credentials.release', { body });
 * ```
 */
export const credentialsReleaseRequestSchema = z.strictObject({
  /** The plaintext server-agent credential `POST /dev-server/credential` handed out. */
  token: opaqueTokenSchema(),
});

/** The validated `POST /credentials/release` request body. */
export type CredentialsReleaseRequest = z.infer<typeof credentialsReleaseRequestSchema>;

/**
 * The `POST /credentials/release` response: whether **this call** revoked a
 * live credential. The flag reports what the request did, not the state the
 * named token is in afterwards.
 *
 * - `true` — this call found a live credential minted by
 *   `POST /dev-server/credential` under that token and removed it: it
 *   authenticates nothing more, and every socket opened with it was closed
 *   with `WS_CLOSE_UNAUTHORIZED` (4401, `./messages/agent.ts`).
 * - `false` — this call released nothing. Either no such credential was live
 *   for it to remove — already revoked by the service's supervision, lapsed,
 *   rotated away (even while the service still supervised it) or never
 *   issued — or the token names a credential this route never touches: the
 *   credential of a dev server the service launched itself, which stays live
 *   until the service revokes it when that dev server exits or is stopped.
 *   So `false` is not proof that the token no longer authenticates. Every one
 *   of those answers the same, so the reply is no oracle for which
 *   credentials exist. It is still a success, not an error: a holder
 *   releasing the credential its own dev server ran with, once that dev
 *   server has exited, asks for nothing more than the release this call
 *   either made or found already made.
 *
 * No credential, role or scope travels back: the reply is one flag.
 */
export const credentialsReleaseResponseSchema = z.strictObject({
  /** Whether a live `POST /dev-server/credential` credential was revoked by this call. */
  released: z.boolean({ error: 'expected a boolean released flag' }),
});

/** The validated `POST /credentials/release` response body. */
export type CredentialsReleaseResponse = z.infer<typeof credentialsReleaseResponseSchema>;

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
 * The vocabulary bound on a metrics `total`.
 *
 * Like every `METRICS_*_RULE` statement below, it names fields and no value,
 * which is the failure policy of this package (AAP §0.5.2).
 */
const METRICS_TOTAL_RULE = `total must not exceed ${String(
  METRIC_IDS.length,
)}: the metric vocabulary is closed and holds one value per id.`;

/** A page is never longer than the page size it echoes. */
const METRICS_PAGE_LIMIT_RULE =
  'metrics must hold at most limit values: a page never exceeds the page size it echoes.';

/** A page is never longer than what remains from its offset. */
const METRICS_PAGE_REMAINDER_RULE =
  'metrics must hold at most total minus offset values: a page cannot carry more than remains from its offset.';

/** A page never carries one metric twice. */
const METRICS_UNIQUE_ID_RULE =
  'metrics must not repeat an id within one page: each metric has exactly one value.';

/** `nextOffset` is derived from the window, never chosen. */
const METRICS_NEXT_OFFSET_RULE =
  'nextOffset must be offset plus the page length while the page holds a value and that is below total, and null otherwise.';

/**
 * Records one breach of the metrics paging rule on `payload`.
 *
 * @param payload The parse payload of the metrics result being checked.
 * @param path The field a producer has to change, as a Zod issue path.
 * @param message One of the `METRICS_*_RULE` statements above.
 */
function reportMetricsPageIssue(
  payload: z.core.ParsePayload<unknown>,
  path: (string | number)[],
  message: string,
): void {
  payload.issues.push({
    code: 'custom',
    path,
    message,
    // Left empty on purpose: zod strips a finalized issue's `input` unless a
    // parse context asks for it, and a failure here never carries the value
    // that caused it (AAP §0.5.2).
    input: undefined,
  });
}

/**
 * Rejects a metrics page that breaks the paging rule stated on
 * {@link metricsDataResultSchema}.
 *
 * Five checks, each on the path a producer has to change:
 *
 * - `total` is at most the number of `METRIC_IDS`, because the vocabulary is
 *   closed and holds one value per id;
 * - the page holds at most `limit` values — the check that refuses a producer
 *   returning the complete set whatever window the request asked for;
 * - the page holds at most `total - offset` values, so a page cannot claim more
 *   than remains from where it starts;
 * - no id repeats within the page, reported at the repeating index;
 * - `nextOffset` is `offset + metrics.length` while the page holds at least one
 *   value and that is below `total`, and `null` otherwise — the producer rule
 *   of `apps/local-service/src/store/telemetry-repo.ts`, under which a page
 *   that returned nothing is the last one.
 *
 * Every breach is reported rather than the first, since each names a different
 * field. Zod runs an object's checks only once its fields have parsed, and an
 * element that is not a `MetricValue` record aborts that parse, so every element
 * here is a record carrying `id`. A bound issue — a negative `total`, an array
 * past its `.max` — does not abort, which is why the arithmetic below is written
 * to hold for any integer rather than only for in-range ones.
 */
function checkMetricsPage(
  payload: z.core.ParsePayload<DataPage & { metrics: readonly MetricValue[] }>,
): void {
  const { metrics, total, limit, offset, nextOffset } = payload.value;

  if (total > METRIC_IDS.length) {
    reportMetricsPageIssue(payload, ['total'], METRICS_TOTAL_RULE);
  }

  if (metrics.length > limit) {
    reportMetricsPageIssue(payload, ['metrics'], METRICS_PAGE_LIMIT_RULE);
  }

  if (metrics.length > Math.max(0, total - offset)) {
    reportMetricsPageIssue(payload, ['metrics'], METRICS_PAGE_REMAINDER_RULE);
  }

  const seen = new Set<MetricValue['id']>();

  for (const [index, metric] of metrics.entries()) {
    if (seen.has(metric.id)) {
      reportMetricsPageIssue(payload, ['metrics', index], METRICS_UNIQUE_ID_RULE);
    }

    seen.add(metric.id);
  }

  const following = offset + metrics.length;
  const expectedNextOffset = metrics.length > 0 && following < total ? following : null;

  if (nextOffset !== expectedNextOffset) {
    reportMetricsPageIssue(payload, ['nextOffset'], METRICS_NEXT_OFFSET_RULE);
  }
}

/**
 * `source: 'metrics'` — the capture's computed metric values, paged.
 *
 * Paged by exactly the rule every array-valued source follows (AAP §0.4.2), with
 * no exception. `total` is how many metric values the filtered source holds: at
 * most the number of `METRIC_IDS`, one value per id, and fewer when the fallback
 * path or a partially observed capture computed a subset, a present but
 * unmeasured metric reporting `available: false`. The page is the window
 * `[offset, offset + limit)` of those values in one stable order, so consecutive
 * pages neither overlap nor skip a value; which order is
 * `apps/local-service/src/panels/data.ts`'s to choose. `nextOffset` is `offset`
 * plus the page's length while the page holds a value and that is below
 * `total`, and `null` otherwise, so a `nextOffset` that is present always lies
 * past the page it came from.
 *
 * Two edge cases follow from the rule rather than from exceptions to it.
 * `limit: 0` is a count-only request: an empty page, the real `total`, and
 * `nextOffset: null` — a page that returned nothing is the last page, so a
 * paging loop that follows `nextOffset` always advances. An `offset` at or past
 * `total` is likewise an empty page with `nextOffset: null`.
 *
 * A metric card addresses a value by id rather than by position, so a value
 * absent from one page is only *not on this page*; it is *not computed* only
 * when a complete read — from offset 0 until `nextOffset` is `null` — did not
 * carry it. `MetricCards` follows `nextOffset` for that reason.
 *
 * {@link checkMetricsPage} enforces the rule on the parsed object. The array
 * keeps its bound at the vocabulary's size as a cheap pre-bound ahead of that
 * check. `.check()` preserves `.shape`, so the discriminated union below still
 * reads this member's `source` literal.
 */
const metricsDataResultSchema = z
  .strictObject({
    source: z.literal('metrics'),
    metrics: opaqueArraySchema<MetricValue>('MetricValue', recordWithKeys('id', 'available')).max(
      METRIC_IDS.length,
      { error: `expected at most ${String(METRIC_IDS.length)} metric values` },
    ),
    ...dataPageShape,
  })
  .check(checkMetricsPage);

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
// Twenty-two entries, keyed by operation id, and the single definition of the
// service's HTTP surface (AAP §0.9.1). `as const satisfies` is load-bearing
// twice over: `as const` keeps every key, method, pattern and `authExempt` flag
// a literal type, which is what lets `HttpOperationId`, the mapped body helpers
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
 * in the order the sections above declare them: sessions (the retention purge
 * among them), captures, the target request, panels, modifications, telemetry
 * ingest, dev server (the server-agent credential among them), health and
 * pairing, and credential rotation and release.
 *
 * Read by `apps/local-service/src/server/http.ts` to register handlers and to
 * apply its bearer and origin middleware, by `./client/http-client.ts` to build
 * and validate a call, and by `packages/protocol/src/__tests__/http.test.ts`,
 * which pins all twenty-two `(operation, method, pattern)` triples literally so
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

  /** `GET /sessions` — one page of session list rows, for the editor's Sessions tree. */
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
   * `POST /sessions/purge` — run the retention sweep now, for
   * `debuggen.purgeSessions`.
   *
   * A static segment beside the `:id` routes, and unambiguous with them: no
   * `POST /sessions/:id` route exists — the one two-segment `:id` route is
   * `GET` and every `POST` under `:id` has a further segment — so a `POST` to
   * this path can reach no other route.
   */
  'session.purge': {
    operation: 'session.purge',
    method: 'POST',
    pattern: '/sessions/purge',
    params: [],
    authExempt: false,
    request: sessionPurgeRequestSchema,
    response: sessionPurgeResponseSchema,
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
   * `POST /sessions/:id/target/request` — ask the session's bound DevTools tab
   * to enter element-picker mode (editor credential only).
   *
   * The service answers by pushing `target.request { sessionId }` to that tab
   * alone; `409 TAB_NOT_BOUND` when no tab is bound and
   * `503 TRANSPORT_DISCONNECTED` when its connection is offline (Section D2).
   */
  'target.request': {
    operation: 'target.request',
    method: 'POST',
    pattern: '/sessions/:id/target/request',
    params: ['id'],
    authExempt: false,
    request: targetRequestRequestSchema,
    response: targetRequestResponseSchema,
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

  /** `GET /sessions/:id/modifications` — one diff-budgeted page of the modification journal. */
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
   * `POST /dev-server/credential` — mint a project-scoped server-agent
   * credential for a dev server the caller starts itself
   * (`scripts/dev-instrumented.mjs`, with the editor credential). The holder
   * may release it early through `credentials.release`.
   */
  'devServer.credential': {
    operation: 'devServer.credential',
    method: 'POST',
    pattern: '/dev-server/credential',
    params: [],
    authExempt: false,
    request: devServerCredentialRequestSchema,
    response: devServerCredentialResponseSchema,
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

  /**
   * `POST /credentials/rotate` — revoke every credential and socket, and
   * regenerate the editor credential, for `debuggen.rotateServiceToken`.
   */
  'credentials.rotate': {
    operation: 'credentials.rotate',
    method: 'POST',
    pattern: '/credentials/rotate',
    params: [],
    authExempt: false,
    request: credentialsRotateRequestSchema,
    response: credentialsRotateResponseSchema,
  },

  /**
   * `POST /credentials/release` — revoke one `devServer.credential`
   * credential now, named by its token (editor credential only): what
   * `scripts/dev-instrumented.mjs` calls as the dev server it started exits.
   *
   * `released` says what this call did: `true` when it removed a live
   * credential, and `{ released: false }`, never an error, when it released
   * nothing — no such credential was live under that token, or the token is a
   * launched child's own credential, which only the service revokes and which
   * stays live (Section H2).
   */
  'credentials.release': {
    operation: 'credentials.release',
    method: 'POST',
    pattern: '/credentials/release',
    params: [],
    authExempt: false,
    request: credentialsReleaseRequestSchema,
    response: credentialsReleaseResponseSchema,
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
  'session.purge',
  'capture.start',
  'capture.stop',
  'target.request',
  'panel.data',
  'panel.get',
  'panel.getById',
  'modifications.list',
  'telemetry.event',
  'devServer.launch',
  'devServer.stop',
  'devServer.credential',
  'health',
  'pair.start',
  'pair.complete',
  'credentials.rotate',
  'credentials.release',
] as const satisfies readonly (keyof typeof HTTP_ROUTES)[];

/**
 * One of {@link HTTP_OPERATIONS}: the canonical operation-id type of the HTTP
 * surface.
 *
 * Derived from the tuple, so it is exactly the twenty-two table keys and can
 * neither gain nor lose a member without the tuple and the table changing in
 * the same edit. It is the type every helper below is generic over, and the key
 * type of the one structure that must name every route:
 * `apps/local-service/src/server/http.ts` declares its handlers as
 * `Record<HttpOperationId, RouteHandler>` and takes this exact type from here
 * rather than declaring a local union, so a route added to the table without a
 * handler — or a handler left behind for a removed route — is a compile error in
 * the service rather than a 404 discovered at run time.
 *
 * @example
 * ```ts
 * import type { HttpOperationId } from '@debuggen/protocol';
 *
 * const handlers: Record<HttpOperationId, RouteHandler> = {
 *   'session.create': createSession,
 *   // …one entry per operation; omitting any is a type error.
 * };
 * ```
 */
export type HttpOperationId = (typeof HTTP_OPERATIONS)[number];

/**
 * The same type as {@link HttpOperationId}, under the name the client SDK
 * spells it.
 *
 * An alias, not a second derivation: both names denote one union, so a value of
 * either is assignable to the other in both directions and the suite proves the
 * two identical. `./client/http-client.ts`'s single `request(operation, …)`
 * method is generic over this name, which is what makes one method fully typed
 * for twenty-two routes; new code may use either spelling.
 */
export type HttpOperation = HttpOperationId;

/** The request schema bound to an operation, or `undefined` for a `GET`. */
type RequestSchemaOf<O extends HttpOperationId> = (typeof HTTP_ROUTES)[O]['request'];

/** The response schema bound to an operation. */
type ResponseSchemaOf<O extends HttpOperationId> = (typeof HTTP_ROUTES)[O]['response'];

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
export type HttpRequestBody<O extends HttpOperationId> =
  RequestSchemaOf<O> extends infer TSchema extends z.ZodType ? z.output<TSchema> : undefined;

/**
 * The success response body type of an operation.
 *
 * @typeParam O The operation.
 */
export type HttpResponseBody<O extends HttpOperationId> =
  ResponseSchemaOf<O> extends infer TSchema extends z.ZodType ? z.output<TSchema> : never;

/** Every table key the {@link HTTP_OPERATIONS} tuple failed to list. */
type UnlistedRouteKey = Exclude<keyof typeof HTTP_ROUTES, HttpOperationId>;

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
  [O in HttpOperationId]: (typeof HTTP_ROUTES)[O]['authExempt'] extends true ? O : never;
}[HttpOperationId];

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
 * nineteen.
 */
export function isAuthExemptOperation(operation: HttpOperationId): boolean {
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
export function buildPath<O extends HttpOperationId>(
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

/** `/sessions/purge` — for `session.purge`, the on-demand retention sweep. */
export function sessionPurgePath(): string {
  return buildPath('session.purge');
}

/** `/sessions/:id/capture/start` — for `capture.start`. */
export function captureStartPath(sessionId: string): string {
  return buildPath('capture.start', { id: sessionId });
}

/** `/sessions/:id/capture/stop` — for `capture.stop`. */
export function captureStopPath(sessionId: string): string {
  return buildPath('capture.stop', { id: sessionId });
}

/** `/sessions/:id/target/request` — for `target.request`, the editor's pick request. */
export function targetRequestPath(sessionId: string): string {
  return buildPath('target.request', { id: sessionId });
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

/** `/dev-server/credential` — for `devServer.credential`. */
export function devServerCredentialPath(): string {
  return buildPath('devServer.credential');
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

/** `/credentials/rotate` — for `credentials.rotate`. */
export function credentialsRotatePath(): string {
  return buildPath('credentials.rotate');
}

/** `/credentials/release` — for `credentials.release`. */
export function credentialsReleasePath(): string {
  return buildPath('credentials.release');
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
export function parseHttpRequest<O extends HttpOperationId>(
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
export function parseHttpResponse<O extends HttpOperationId>(
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
 * The panel-data request body is `@debuggen/panel-schema`'s `DataQuery`, field
 * for field, plus an optional string `panelId` — and nothing else.
 *
 * The type-level half of the identity the suite asserts by reference (each
 * query field schema of `HTTP_ROUTES['panel.data'].request` is panel-schema's
 * own object). The first member states that removing `panelId` leaves exactly
 * `DataQuery`, so no query field was restated, widened or dropped; the second
 * that a bare `DataQuery` is a valid body, which is what makes `panelId`
 * optional rather than merely nullable; the third that a present `panelId` is a
 * string.
 */
export type PanelDataRequestIsDataQueryWithPanelId = [
  AssertTrue<Identical<Omit<HttpRequestBody<'panel.data'>, 'panelId'>, DataQuery>>,
  AssertTrue<AssignableTo<DataQuery, HttpRequestBody<'panel.data'>>>,
  AssertTrue<Identical<Exclude<HttpRequestBody<'panel.data'>['panelId'], undefined>, string>>,
];

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

/**
 * The rotation and purge requests carry no field at all.
 *
 * Rotation is all or nothing and the retention window is configuration, so a
 * key added to either body would be a caller choosing what survives the
 * operation — the property both request schemas document, held at compile
 * time so it cannot be relaxed in one edit. `Record<string, never>` is what
 * zod infers for a strict object over an empty shape: no key may hold a value.
 */
export type AdministrativeRequestsCarryNoField = [
  AssertTrue<Identical<HttpRequestBody<'credentials.rotate'>, Record<string, never>>>,
  AssertTrue<Identical<HttpRequestBody<'session.purge'>, Record<string, never>>>,
];

/**
 * A release names exactly one credential, by its token, and nothing else — no
 * project, role or wildcard that could widen it past the one credential its
 * holder already has — and answers with one flag.
 */
export type CredentialsReleaseNamesOneCredential = [
  AssertTrue<Identical<keyof HttpRequestBody<'credentials.release'>, 'token'>>,
  AssertTrue<Identical<HttpResponseBody<'credentials.release'>, { released: boolean }>>,
];

/**
 * A server-agent credential is requested for a project exactly as a launched
 * dev server is stopped: by `projectRoot`, and by nothing else.
 */
export type DevServerCredentialRequestMatchesStop = AssertTrue<
  Identical<HttpRequestBody<'devServer.credential'>, HttpRequestBody<'devServer.stop'>>
>;

/** The modification journal carries `@debuggen/instrumentation`'s records. */
export type ModificationsResponseCarriesRecords = AssertTrue<
  Identical<ModificationsResponse['modifications'], ModificationRecord[]>
>;

/**
 * The target-request reply names exactly the session and the bound tab, and
 * its tab id is the one the binding messages carry.
 *
 * The run-time half — that the field's schema *is* the `session.bind` payload's
 * tab-id schema, not a copy of its rule — is asserted by identity in the suite.
 */
export type TargetRequestResponseNamesTheBoundTab = [
  AssertTrue<Identical<keyof HttpResponseBody<'target.request'>, 'sessionId' | 'tabId'>>,
  AssertTrue<Identical<HttpResponseBody<'target.request'>['tabId'], SessionBindPayload['tabId']>>,
];

/**
 * A session list row is a projection of the record: its members keep the
 * record's own types, so {@link toSessionListItem} can never need a field the
 * record lacks, and only `cleanup` is summarised.
 */
export type SessionListItemProjectsTheRecord = [
  AssertTrue<Identical<SessionListItem['id'], SessionRecord['id']>>,
  AssertTrue<Identical<SessionListItem['status'], SessionRecord['status']>>,
  AssertTrue<Identical<SessionListItem['cleanup']['status'], SessionRecord['cleanup']['status']>>,
  AssertTrue<
    Identical<SessionListItem['cleanup']['completedAt'], SessionRecord['cleanup']['completedAt']>
  >,
];

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
