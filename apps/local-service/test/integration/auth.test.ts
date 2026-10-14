/**
 * The service's access boundary (AAP §0.5.6), asserted **through the real
 * transport**: Node's `fetch` against the harness's ephemeral port, real `ws`
 * sockets whose close codes and upgrade statuses are read off the wire, and
 * sessions created, bound and captured through the HTTP routes and WebSocket
 * frames the extensions use.
 *
 * ## Rules ruling
 *
 * - **User rules (AAP §0.10).** `review_rules` answers "No user rules
 *   provided.", so no user rule governs this file; the §0.10 baseline does.
 * - **Gate membership.** This suite belongs to `pnpm test:integration`
 *   (`vitest run --project local-service-integration`), a blocking step of
 *   `pnpm verify`, and is held to `tsc -b`, `eslint . --max-warnings 0` and
 *   `prettier --check .` like any source file.
 * - **No committed secrets.** Every token-, code- and credential-shaped value
 *   here is assembled at run time — by the harness's `randomSecretLike`, by
 *   `node:crypto`, or minted by the real auth service — and is never printed:
 *   a leak check reports *which* value leaked by label, never the value.
 * - **Closed dependency set.** Only `@debuggen/*` packages, `node:*`, the
 *   workspace's own `src/**` modules and the harness are imported. No `zod`:
 *   every schema used here is the one protocol (or the owning module) exports.
 *
 * ## What this suite owns, and what it leaves to others
 *
 * `src/server/auth.test.ts` pins `createAuthService`'s internals against a bare
 * store — racing redemptions, a failing random source, every re-spelling of a
 * code the exact comparison refuses and how each counts toward the lockout, the
 * exact edges of the one service-wide lockout. None of that is repeated here:
 * every assertion below needs a running server, because what it pins is that
 * the HTTP middleware, the route modules, the WebSocket upgrade gate and the
 * hello handshake actually *apply* those rules to real requests — for pairing,
 * that `POST /pair/complete` hands the code to the service exactly as it
 * arrived, and that failures under any number of forged `Origin`s share one
 * lockout. The
 * exhaustive traversal table of click-to-source belongs to `source-open.test.ts`;
 * this file asserts only its role-and-scope half.
 *
 * The editor's administrative operations are driven here too, because each is
 * an access-boundary event: `POST /credentials/rotate` (what
 * `debuggen.rotateServiceToken` calls) revokes every credential and closes every
 * socket, `POST /dev-server/credential` mints a server-agent credential,
 * `POST /credentials/release` (what `scripts/dev-instrumented.mjs` calls once
 * its dev server has exited) revokes one such credential and its sockets, and
 * `POST /sessions/purge` (what `debuggen.purgeSessions` calls) runs the
 * retention sweep. All four are rows of the route table, reachable by the
 * editor credential alone. The launcher's lease bookkeeping behind a release —
 * which supervised lease ends, why a launched child's own credential is never
 * released — belongs to `src/dev-server/launcher.test.ts`, and the retention
 * sweep's own rules — which aged session goes, which conflict keeps one — to
 * `src/store/retention.test.ts`.
 *
 * The revocation fence is driven over a raw `node:http` connection, because
 * what it closes is a timing window no whole-request client can open: a
 * request authenticated by the middleware whose body is held back part-way
 * while a rotation, or a release, lands on another connection. The body is
 * released only once the middleware has provably authenticated the request,
 * observed by a call-through spy on the service's own `authorizeHttpRequest`
 * that changes nothing it does. It is proven on every state-changing route
 * whose effect follows a body read: the credential request, purge, rotation,
 * pairing and release of the editor, and the server agent's ingest.
 *
 * ## Conventions
 *
 * Paths, operation ids, close codes, windows and statuses come from protocol's
 * route table and constants and from the access boundary's own reason table
 * (`AUTH_FAILURE_REASONS`), never from literals, so a route added to
 * `HTTP_ROUTES` is swept by the table-driven checks the moment it exists. One
 * harness serves the whole file (the project runs serialized in one fork); the
 * `afterAll` hook stops it and proves that no socket, listener or temporary
 * directory survives.
 */

import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo, Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACTING_TAB_HEADER,
  AUTHORIZATION_HEADER,
  AUTH_EXEMPT_OPERATIONS,
  CLIENT_HELLO_TIMEOUT_MS,
  HTTP_OPERATIONS,
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MAJOR,
  READ_PROOF_BYTES,
  READ_PROOF_HEADER,
  SESSION_PURGE_MAX_REPORTED_SESSIONS,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  buildPath,
  clientHelloPayloadSchema,
  errorCodeSchema,
  formatBearer,
  healthResponseSchema,
  httpErrorResponseSchema,
  isCompatibleProtocolVersion,
  isMessageOfType,
  pairCompleteResponseSchema,
  pairStartResponseSchema,
  telemetryIngestResponseSchema,
} from '@debuggen/protocol';
import type {
  ClientHelloPayload,
  ClientKind,
  ErrorPayload,
  HttpErrorResponse,
  HttpOperationId,
  MessagePayload,
  ProtocolMessage,
  SessionPurgeResponse,
  SessionRecord,
} from '@debuggen/protocol';
import { createDeterministicProvider } from '@debuggen/model-provider';
import type { ModelProvider, PromptStage } from '@debuggen/model-provider';
import { isErr, newId, newPanelId, newProducerId, newSessionId } from '@debuggen/shared';
import { SECURE_FILE_MODE, sha256Hex, sha256OfFile } from '@debuggen/shared/node';
import type { TelemetryEventIngress } from '@debuggen/telemetry';

import { startService } from '../../src/main.js';
import type { ServiceHandle } from '../../src/main.js';
import {
  AUTH_FAILURE_REASONS,
  AUTH_FILE_STAGE_SUFFIX,
  CREDENTIAL_ROLES,
  OPERATION_ROLES,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_LOCKOUT_MS,
  PAIRING_MAX_FAILURES,
  REFUSAL_LOG_BURST,
  identifyProjectRoot,
} from '../../src/server/auth.js';
import type {
  AuthFailureReason,
  AuthenticatedOperation,
  PrincipalRole,
} from '../../src/server/auth.js';
import { DEFAULT_OFFLINE_GRACE_MS } from '../../src/server/clients.js';
import { UNIFORM_PAIRING_REFUSAL_REASONS } from '../../src/server/routes/pair.js';
import { createSessionsRepo } from '../../src/store/sessions-repo.js';
import type { ProgressEntry, TabBinding } from '../../src/store/sessions-repo.js';

import {
  HARNESS_TIMEOUTS,
  assertTreeUnchanged,
  chromeExtensionOrigin,
  newExtensionId,
  randomSecretLike,
  readTelemetryBatch,
  snapshotTree,
  standInDevServerCommand,
  startHarness,
  waitFor,
  waitUntil,
  type CapturedLogRecord,
  type DevtoolsConnection,
  type DevtoolsCredential,
  type Harness,
  type HarnessClock,
  type HarnessRawSocket,
  type HarnessWsClient,
  type RawFetchInit,
  type RawFetchResponse,
  type RawFetchTarget,
  type WsCloseRecord,
} from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** A question with no bearing on any rule here; sessions only need one. */
const QUESTION = 'Why does the list take so long to appear after the page loads?';

/**
 * The web origins every refusal is proven against that do not depend on the
 * running system. `http://localhost:3000` is the conventional `next dev`
 * address — the page most likely to be open next to the service (the port is
 * an origin's, not a timeout). The origins that do depend on the running
 * system — the target app's own dev server under both loopback spellings, and
 * the service's own origin — are added by {@link webOrigins} once the fixture
 * is up.
 */
const STATIC_WEB_ORIGINS = Object.freeze([
  'http://evil.example',
  'https://evil.example',
  'http://localhost:3000',
  'https://127.0.0.1',
] as const);

/** The response headers that would grant a web page a cross-origin read. */
const CORS_GRANT_HEADERS = Object.freeze([
  'access-control-allow-origin',
  'access-control-allow-credentials',
]);

/** The CORS preflight request headers a browser sends before a credentialed `POST`. */
const PREFLIGHT_METHOD_HEADER = 'access-control-request-method';
const PREFLIGHT_HEADERS_HEADER = 'access-control-request-headers';

/** The method of a CORS preflight request. */
const PREFLIGHT_METHOD = 'OPTIONS';

/** The response header that keeps a freshly issued code or credential out of every cache. */
const CACHE_CONTROL_HEADER = 'cache-control';
const NO_STORE_DIRECTIVE = 'no-store';

/** The error code of a request body the route's schema refuses — protocol's, not a literal. */
const INVALID_BODY_CODE = errorCodeSchema.enum.PROTOCOL_INVALID_MESSAGE;

/** The status of a request body the route's schema refuses. */
const INVALID_BODY_STATUS = 400;

/** A SHA-256 digest as the store keeps it: 64 lower-case hex characters. */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** The file SQLite's write-ahead log lives in, beside the database file. */
const WAL_SUFFIX = '-wal';

/** The permission bits of a file mode. */
const PERMISSION_BITS = 0o777;

/**
 * How far before the service's own hello deadline the client-observed close may
 * land: the service arms its timer at the upgrade, a moment before the client
 * sees `open`.
 */
const HELLO_WINDOW_TOLERANCE_MS = CLIENT_HELLO_TIMEOUT_MS / 10;

/** A file every copy of the `sample-project` fixture holds. */
const PROJECT_FILE = 'src/components/TrailCard.tsx';

/**
 * The debug record `src/server/ws.ts` writes once it has processed a socket's
 * close — the point after which a closed editor connection's workspace is on
 * its lease, which the scope test waits for before it looks.
 */
const CONNECTION_CLOSED_LOG = 'a WebSocket connection closed';

/**
 * The record `src/server/ws.ts` files for every upgrade it refuses for its
 * `Origin`: at `warn` with the origin's `scheme://host` for the first
 * `REFUSAL_LOG_BURST` of a minute, at `debug` past them.
 */
const UPGRADE_ORIGIN_REFUSED_LOG = 'refused a WebSocket upgrade from a refused origin';

/**
 * The debug record the service's agent-readiness ledger (`src/main.ts`) writes,
 * with the report's `tabId`, for every relayed `agent.ready` the WebSocket
 * router accepted — the observable sign that a report reached the readiness
 * gate, which the single-tab test counts per tab.
 */
const AGENT_READY_RECORDED_LOG = 'recorded a page-agent readiness report';

/** The inspected tabs this suite speaks for, one per scenario so no binding is shared by accident. */
const TABS = Object.freeze({
  acceptedOrigin: 111,
  paired: 121,
  own: 101,
  other: 202,
  opener: 151,
  rotation: 131,
  repaired: 141,
  /** The two tabs one credential multiplexes over one connection whose hello names no tab. */
  muxFirst: 161,
  muxSecond: 171,
  /** A single-tab connection's hello tab, and another tab of the same credential it may not speak for. */
  singleOwn: 181,
  singleOther: 191,
});

/** The statements the at-rest checks read, over the two tables only the access boundary writes. */
const SELECT_CREDENTIALS = 'SELECT token_hash, role, scope, issued_at, expires_at FROM credentials';
const SELECT_PAIRING_CODES = 'SELECT code_hash, expires_at, used FROM pairing_codes';

/**
 * The fixed sentences a bearer refusal may carry: one per verdict of the
 * service's refusal table that a presented (or absent) bearer value can reach.
 * Each is a constant, so none can carry anything the request supplied.
 */
const CREDENTIAL_REFUSAL_MESSAGES: readonly string[] = (
  ['missing-credential', 'malformed-credential', 'unknown-credential'] as const
).map((reason) => AUTH_FAILURE_REASONS[reason].message);

/* -------------------------------------------------------------------------------------------------
 * The route table, split the way the access boundary splits it
 * ---------------------------------------------------------------------------------------------- */

/** Protocol's exempt set, as a lookup. */
const EXEMPT_OPERATIONS: ReadonlySet<HttpOperationId> = new Set<HttpOperationId>(
  AUTH_EXEMPT_OPERATIONS,
);

/** Whether an operation requires a bearer credential. */
function isAuthenticatedOperation(operation: HttpOperationId): operation is AuthenticatedOperation {
  return !EXEMPT_OPERATIONS.has(operation);
}

/** Every operation of the route table that requires a credential, in the table's order. */
const AUTHENTICATED_OPERATIONS: readonly AuthenticatedOperation[] =
  HTTP_OPERATIONS.filter(isAuthenticatedOperation);

/** The roles the access boundary admits to an operation. */
function rolesFor(operation: AuthenticatedOperation): readonly PrincipalRole[] {
  return OPERATION_ROLES[operation];
}

/** The credentialed operations a DevTools client may call — every one of them session-scoped. */
const DEVTOOLS_OPERATIONS: readonly AuthenticatedOperation[] = AUTHENTICATED_OPERATIONS.filter(
  (operation) => rolesFor(operation).includes('devtools'),
);

/**
 * The path parameters an operation's route declares: the session under test
 * for `:id`, and a well-formed but unknown panel for `:panelId`.
 */
function paramsFor(operation: HttpOperationId, sessionId: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const name of HTTP_ROUTES[operation].params) {
    params[name] = name === 'panelId' ? newPanelId() : sessionId;
  }
  return params;
}

/**
 * A `POST /credentials/release` body naming a well-formed credential this
 * service never issued — tracked, so no reply, record or row may echo it.
 */
function unissuedReleaseBody(): { readonly token: string } {
  const token = randomSecretLike('bearer').slice(formatBearer('').length);
  return { token: track('unissued release token', token) };
}

/**
 * A body the operation's route accepts for its method: none for a `GET`, a
 * `DataQuery` for `panel.data`, the harness's own workspace folder for
 * `devServer.credential`, a well-formed but unissued token for
 * `credentials.release`, and `{}` for every other `POST` (the access boundary
 * answers before any body is read, so the body only matters where a request is
 * admitted). Called at test time, after `beforeAll` has set {@link projectA}.
 */
function requestBodyFor(operation: HttpOperationId): unknown {
  if (HTTP_ROUTES[operation].method !== 'POST') {
    return undefined;
  }
  switch (operation) {
    case 'panel.data':
      return { source: 'events' };
    case 'devServer.credential':
      return { projectRoot: projectA };
    case 'credentials.release':
      return unissuedReleaseBody();
    default:
      return {};
  }
}

/** A raw-fetch target for an operation, with its path parameters filled in. */
function targetFor(operation: HttpOperationId, sessionId: string): RawFetchTarget {
  return { operation, params: paramsFor(operation, sessionId) };
}

/* -------------------------------------------------------------------------------------------------
 * The shared fixture
 * ---------------------------------------------------------------------------------------------- */

let harness: Harness;
/** The harness's own fixture copy, announced by the editor connection `startHarness` opened. */
let projectA: string;
/** A second, independent copy of the same fixture. */
let projectB: string;
let sessionA: SessionRecord;
let sessionB: SessionRecord;
/** A telemetry batch as the Node preload would post it. */
let serverEvents: readonly TelemetryEventIngress[];

/**
 * Every plaintext credential, pairing code and credential-shaped probe this
 * suite has seen, labelled. {@link leaksIn} searches a haystack for each and
 * reports labels, so a failure never prints a secret.
 */
const secrets = new Map<string, string>();

/** How many raw responses {@link fetchRaw} has inspected for a CORS grant. */
let inspectedResponses = 0;

/* -------------------------------------------------------------------------------------------------
 * Secrets: tracked by label, searched for without ever being printed
 * ---------------------------------------------------------------------------------------------- */

/** Records a plaintext value that must never surface in a response, a log record or the store. */
function track(label: string, value: string): string {
  secrets.set(value, `${label} #${String(secrets.size + 1)}`);
  return value;
}

/** The labels of every tracked secret that occurs in `haystack`. */
function leaksIn(haystack: string | Buffer): string[] {
  const found: string[] = [];
  for (const [value, label] of secrets) {
    const present =
      typeof haystack === 'string' ? haystack.includes(value) : haystack.includes(value, 0, 'utf8');
    if (present) {
      found.push(label);
    }
  }
  return found;
}

/** Tracks the credential inside an `Authorization` header value and returns the whole value. */
function trackBearer(headerValue: string): string {
  track('unissued bearer credential', headerValue.slice(formatBearer('').length));
  return headerValue;
}

/** A well-formed pairing code this service never issued, from the service's own alphabet. */
function randomPairingCode(): string {
  let code = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_CODE_ALPHABET.charAt(randomInt(PAIRING_CODE_ALPHABET.length));
  }
  return track('unissued pairing code', code);
}

/** A `vscode-webview://<id>` origin, as a VS Code webview presents it. */
function webviewOrigin(): string {
  return `vscode-webview://${randomUUID()}`;
}

/** The harness clock; the pairing expiry and lockout windows are crossed with it. */
function requireClock(): HarnessClock {
  if (harness.clock === undefined) {
    throw new Error('This suite needs the harness clock to cross pairing windows.');
  }
  return harness.clock;
}

/**
 * Every web origin a refusal is proven against: the static ones, the target
 * app's own dev server under both loopback spellings (the page a developer is
 * debugging is exactly the page that must not reach the service), and the
 * service's own origin.
 */
function webOrigins(): readonly string[] {
  const devServer = new URL(sessionA.devServerUrl);
  return [
    ...STATIC_WEB_ORIGINS,
    `http://localhost:${devServer.port}`,
    devServer.origin,
    new URL(harness.url).origin,
  ];
}

/* -------------------------------------------------------------------------------------------------
 * HTTP helpers
 * ---------------------------------------------------------------------------------------------- */

/** Asserts that a response grants no cross-origin read — the CSRF closure of AAP §0.5.6. */
function expectNoCorsGrant(response: RawFetchResponse): void {
  for (const header of CORS_GRANT_HEADERS) {
    expect(
      response.headers.get(header),
      `a ${header} header on a ${String(response.status)} reply`,
    ).toBeNull();
  }
}

/**
 * {@link RawFetchInit} plus the read proof a DevTools client holds. Like the
 * extension's HTTP client, {@link fetchRaw} sends it as the read-proof header
 * only on a `GET`: a DevTools write is bound by its `Origin` and refuses the
 * header, so one init can present a credential to both kinds of operation.
 */
interface SuiteFetchInit extends RawFetchInit {
  readonly readProof?: string | undefined;
}

/** The method a raw-fetch target is sent with, as the harness resolves it. */
function methodOf(target: RawFetchTarget, init: RawFetchInit): string {
  if (init.method !== undefined) {
    return init.method;
  }
  if (typeof target === 'string') {
    return HTTP_ROUTES[target].method;
  }
  return 'operation' in target ? HTTP_ROUTES[target.operation].method : 'GET';
}

/**
 * The harness's raw fetch, with two checks applied to **every** response this
 * suite reads: no CORS grant header, and no tracked secret echoed in the body.
 * (A success that issues a code or a credential carries a *new* value, which is
 * tracked only after it has been read.)
 */
async function fetchRaw(
  target: RawFetchTarget,
  init: SuiteFetchInit = {},
): Promise<RawFetchResponse> {
  const { readProof, ...rest } = init;
  const sent: RawFetchInit =
    readProof !== undefined && methodOf(target, rest) === 'GET'
      ? { ...rest, headers: { ...rest.headers, [READ_PROOF_HEADER]: readProof } }
      : rest;
  const response = await harness.rawFetch(target, sent);
  expectNoCorsGrant(response);
  expect(leaksIn(response.text), `a ${String(response.status)} reply echoes a secret`).toEqual([]);
  inspectedResponses += 1;
  return response;
}

/**
 * Asserts that a response is the access boundary's refusal for `reason` — its
 * status and error code from `AUTH_FAILURE_REASONS`, its body protocol's error
 * shape — and returns the parsed body.
 */
function expectRefusal(
  response: RawFetchResponse,
  reason: AuthFailureReason,
  label: string = reason,
): HttpErrorResponse {
  const expected = AUTH_FAILURE_REASONS[reason];
  expect(response.status, `${label}: status`).toBe(expected.status);
  const parsed = httpErrorResponseSchema.safeParse(response.json);
  if (!parsed.success) {
    throw new Error(`${label}: the refusal body is not protocol's error shape.`);
  }
  expect(parsed.data.code, `${label}: code`).toBe(expected.code);
  return parsed.data;
}

/** What a caller can observe about a refusal, without its per-request `ref`. */
interface RefusalShape {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** The observable shape of an error response. */
function refusalShape(response: RawFetchResponse): RefusalShape {
  const parsed = httpErrorResponseSchema.safeParse(response.json);
  if (!parsed.success) {
    throw new Error(`A ${String(response.status)} reply is not protocol's error shape.`);
  }
  return { status: response.status, code: parsed.data.code, message: parsed.data.message };
}

/** The top-level fields of a JSON reply, sorted, so two replies' shapes compare directly. */
function bodyKeys(response: RawFetchResponse): readonly string[] {
  const { json } = response;
  return typeof json === 'object' && json !== null ? Object.keys(json).sort() : [];
}

/** Parses a success body with the operation's own response schema from the route table. */
function expectSuccess(response: RawFetchResponse, operation: HttpOperationId, status = 200): void {
  expect(response.status, `${operation}: status`).toBe(status);
  expect(
    HTTP_ROUTES[operation].response.safeParse(response.json).success,
    `${operation}: the body satisfies the route's response schema`,
  ).toBe(true);
}

/**
 * The request options that present a DevTools credential as the extension does:
 * from the extension it was issued to, with the read proof issued with it on
 * every read ({@link SuiteFetchInit}) — acting for `tabId` when one is given,
 * as the service worker names the inspected tab on every session request.
 */
function presenting(
  credential: DevtoolsCredential,
  tabId?: number,
): Pick<SuiteFetchInit, 'token' | 'origin' | 'headers' | 'readProof'> {
  return {
    token: credential.token,
    origin: credential.origin,
    readProof: credential.readProof,
    ...(tabId === undefined ? {} : { headers: { [ACTING_TAB_HEADER]: String(tabId) } }),
  };
}

/** Every session the editor credential currently sees. */
async function listSessionIds(): Promise<readonly string[]> {
  const response = await fetchRaw('session.list');
  const parsed = HTTP_ROUTES['session.list'].response.safeParse(response.json);
  if (response.status !== 200 || !parsed.success) {
    throw new Error(`session.list answered ${String(response.status)}.`);
  }
  return parsed.data.sessions.map((session) => session.id);
}

/** `POST /telemetry/ingest` for a project, presenting `token`. */
function ingest(token: string, projectRoot: string, origin?: string): Promise<RawFetchResponse> {
  return fetchRaw('telemetry.event', {
    token,
    origin,
    body: { projectRoot, events: [...serverEvents] },
  });
}

/**
 * Mints a server-agent credential through the route table's
 * `devServer.credential` row — the credential a dev server started without the
 * launcher runs with (`scripts/dev-instrumented.mjs` requests it with the editor
 * credential). The reply is a fresh secret, so it must not be cached.
 */
async function mintDevServerCredential(projectRoot: string): Promise<string> {
  const response = await fetchRaw('devServer.credential', { body: { projectRoot } });
  expectSuccess(response, 'devServer.credential');
  expect(response.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
  const parsed = HTTP_ROUTES['devServer.credential'].response.safeParse(response.json);
  if (!parsed.success) {
    throw new Error('The dev-server credential reply does not satisfy its schema.');
  }
  return track('dev-server credential', parsed.data.token);
}

/* -------------------------------------------------------------------------------------------------
 * WebSocket helpers
 * ---------------------------------------------------------------------------------------------- */

/** The optional announcements of a `client.hello`. */
interface HelloClaims {
  readonly projectRoot?: string;
  readonly tabId?: number;
  readonly version?: string;
}

/** A `client.hello` payload; absent claims are absent keys, as `exactOptionalPropertyTypes` requires. */
function hello(client: ClientKind, token: string, claims: HelloClaims = {}): ClientHelloPayload {
  return {
    client,
    ...(claims.projectRoot === undefined ? {} : { projectRoot: claims.projectRoot }),
    ...(claims.tabId === undefined ? {} : { tabId: claims.tabId }),
    version: claims.version ?? PROTOCOL_VERSION,
    token,
  };
}

/** Opens a bare socket (optionally from `origin`) and sends `payload` as its first frame. */
async function sendHello(payload: ClientHelloPayload, origin?: string): Promise<HarnessRawSocket> {
  const raw = harness.rawSocket(origin === undefined ? {} : { origin });
  expect(await raw.waitForOpen(), 'the upgrade was accepted').toBe(true);
  raw.sendMessage('client.hello', payload);
  return raw;
}

/**
 * Asserts that the service closes a socket whose first frame is `payload` with
 * `WS_CLOSE_UNAUTHORIZED`, having sent nothing before it — no `error` frame is
 * ever sent to an unauthenticated socket — and without echoing the credential
 * in the close reason.
 */
async function expectHelloRefused(
  payload: ClientHelloPayload,
  origin?: string,
): Promise<WsCloseRecord> {
  const raw = await sendHello(payload, origin);
  const closed = await raw.waitForClose();
  expect(closed.code, `a ${payload.client} hello`).toBe(WS_CLOSE_UNAUTHORIZED);
  expect(raw.frames, 'frames sent before authentication').toEqual([]);
  if (payload.token.length > 0) {
    expect(closed.reason.includes(payload.token), 'the close reason echoes the credential').toBe(
      false,
    );
  }
  return closed;
}

/** A source location at the first line of a project-relative `file`, as a panel's link carries it. */
function locationOf(file: string): MessagePayload<'source.open'>['location'] {
  return { file, line: 1, column: 1, resolvedBy: 'code-graph', confidence: 1 };
}

/** A selected-element descriptor on a session's page. */
function targetOn(session: SessionRecord): MessagePayload<'target.selected'>['target'] {
  return {
    selector: '#trail-list',
    tagName: 'button',
    componentChain: [],
    url: session.devServerUrl,
  };
}

/** The `source.open` frames a client received from transcript index `mark` on. */
function sourceOpensSince(client: HarnessWsClient, mark: number): readonly ProtocolMessage[] {
  return client.received.slice(mark).filter((message) => isMessageOfType(message, 'source.open'));
}

/** The error codes of a set of `error` replies. */
function codesOf(errors: readonly ErrorPayload[]): readonly string[] {
  return errors.map((error) => error.code);
}

/**
 * Sends `source.open` for `sessionA` as an editor from a bare socket and waits
 * for the service to forward it back to the session's editors — this socket
 * among them. Forwarding is proof that the hello authenticated the connection
 * and that it is registered as an editor of the session.
 */
async function expectEditorRegistered(raw: HarnessRawSocket): Promise<void> {
  const frameId = raw.sendMessage('source.open', {
    sessionId: sessionA.id,
    location: locationOf(PROJECT_FILE),
  });
  const forwarded = await raw.waitForMessage(
    (message) =>
      isMessageOfType(message, 'source.open') && message.payload.sessionId === sessionA.id,
  );
  expect(forwarded.type).toBe('source.open');
  const refusals = raw.messages.filter(
    (message) => isMessageOfType(message, 'error') && message.payload.ref === frameId,
  );
  expect(refusals).toEqual([]);
  expect(raw.closes).toEqual([]);
}

/** Opens a bare editor socket with `token` announcing `projectA`, proven registered. */
async function openRegisteredEditor(token: string, version?: string): Promise<HarnessRawSocket> {
  const raw = await sendHello(
    hello(
      'vscode',
      token,
      version === undefined ? { projectRoot: projectA } : { projectRoot: projectA, version },
    ),
  );
  await expectEditorRegistered(raw);
  return raw;
}

/* -------------------------------------------------------------------------------------------------
 * DevTools helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Connects a DevTools client for `tabId` (with a fresh credential unless one is
 * given), binds its tab to `session` explicitly, as the panel does on open, and
 * relays the page agent's `agent.ready` for the tab, as the service worker does
 * once the MAIN-world agent has installed before React. A bound tab whose agent
 * never reports would leave the readiness gate waiting on it; the real
 * extension never produces that state, so neither does this suite.
 */
async function bindDevtools(
  tabId: number,
  session: SessionRecord,
  credential?: DevtoolsCredential,
): Promise<DevtoolsConnection> {
  const connection = await harness.connectDevtools(
    credential === undefined ? { tabId } : { tabId, credential },
  );
  track('devtools credential', connection.credential.token);
  const bound = await harness.bindTab(connection.client, {
    tabId,
    url: session.devServerUrl,
    origin: new URL(session.devServerUrl).origin,
    sessionId: session.id,
  });
  if (isErr(bound)) {
    throw new Error(`session.bind was refused with ${bound.error.code}.`);
  }
  expect(bound.value.payload.sessionId).toBe(session.id);

  const receipt = connection.client.send(
    'agent.ready',
    {
      tabId,
      documentId: newId('doc'),
      producerId: newProducerId(),
      url: session.devServerUrl,
      installedBeforeReact: true,
      reactDetected: true,
    },
    { sessionId: session.id },
  );
  expect(isErr(receipt.result)).toBe(false);
  expect(await connection.client.flush()).toBe(true);
  expect(connection.client.errorsFor(receipt.id)).toEqual([]);
  return connection;
}

/** Drops a tab's binding, as closing the panel does. */
async function unbind(connection: DevtoolsConnection, tabId: number): Promise<void> {
  const receipt = connection.client.send('session.unbind', { tabId });
  expect(isErr(receipt.result)).toBe(false);
  expect(await connection.client.flush()).toBe(true);
  expect(connection.client.errorsFor(receipt.id)).toEqual([]);
}

/**
 * Binds `tabId` to `session` over an already-open connection and relays the
 * tab's `agent.ready`, each frame naming the tab it acts for — what the MV3
 * service worker does for every inspected tab over its single connection.
 */
async function bindOver(
  client: HarnessWsClient,
  tabId: number,
  session: SessionRecord,
): Promise<void> {
  const bound = await harness.bindTab(client, {
    tabId,
    url: session.devServerUrl,
    origin: new URL(session.devServerUrl).origin,
    sessionId: session.id,
  });
  if (isErr(bound)) {
    throw new Error(`session.bind was refused with ${bound.error.code}.`);
  }
  expect(bound.value.payload.sessionId).toBe(session.id);

  const receipt = client.send(
    'agent.ready',
    {
      tabId,
      documentId: newId('doc'),
      producerId: newProducerId(),
      url: session.devServerUrl,
      installedBeforeReact: true,
      reactDetected: true,
    },
    { sessionId: session.id, tabId },
  );
  expect(isErr(receipt.result)).toBe(false);
  expect(await client.flush()).toBe(true);
  expect(client.errorsFor(receipt.id)).toEqual([]);
}

/**
 * A session of a fresh copy of the fixture, its dev server launched and its
 * pipeline settled at the readiness gate — so a capture can open on it without
 * contending with any other session for its project.
 */
async function sessionOfFreshProject(): Promise<SessionRecord> {
  const projectRoot = (await harness.copyFixtureProject()).root;
  const launched = await harness.launchDevServer(projectRoot);
  if (isErr(launched)) {
    throw new Error(`The stand-in dev server did not launch (${launched.error.code}).`);
  }
  const session = await harness.createSession({ projectRoot, question: QUESTION });
  await harness.waitForSession(
    session.id,
    (record) => record.status === 'instrumenting' || record.status === 'ready',
  );
  return session;
}

/** Waits for the readiness gate to admit a session: "Ready to capture". */
async function waitUntilReady(session: SessionRecord): Promise<void> {
  await harness.waitForSession(session.id, (record) => record.status === 'ready');
}

/* -------------------------------------------------------------------------------------------------
 * Pairing helpers
 * ---------------------------------------------------------------------------------------------- */

/** `POST /pair/start` with the editor credential; returns the code, tracked. */
async function pairStart(): Promise<string> {
  const response = await fetchRaw('pair.start', { body: {} });
  expect(response.status).toBe(200);
  const parsed = pairStartResponseSchema.safeParse(response.json);
  if (!parsed.success) {
    throw new Error('The pair.start reply does not satisfy its schema.');
  }
  return track('pairing code', parsed.data.code);
}

/** `POST /pair/complete` without a bearer credential, from `origin`. */
async function redeem(code: string, origin?: string): Promise<RawFetchResponse> {
  const response = await fetchRaw('pair.complete', { token: null, origin, body: { code } });
  expect(response.text.includes(code), 'the pair.complete reply echoes the code').toBe(false);
  return response;
}

/**
 * Asserts a successful redemption and returns the DevTools credential and the
 * read proof issued with it, both tracked.
 */
function redeemedCredential(response: RawFetchResponse): {
  readonly token: string;
  readonly readProof: string;
} {
  expect(response.status, 'pair.complete: status').toBe(200);
  const parsed = pairCompleteResponseSchema.safeParse(response.json);
  if (!parsed.success) {
    throw new Error('The pair.complete reply does not satisfy its schema.');
  }
  expect(response.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
  return {
    token: track('paired devtools credential', parsed.data.token),
    readProof: track('paired read proof', parsed.data.readProof),
  };
}

/** Asserts a successful redemption and returns its DevTools credential, tracked. */
function redeemedToken(response: RawFetchResponse): string {
  return redeemedCredential(response).token;
}

/** The whole pairing flow over HTTP: the editor starts it, the extension's origin redeems it. */
async function pairExtension(extensionId: string = newExtensionId()): Promise<DevtoolsCredential> {
  const code = await pairStart();
  const origin = chromeExtensionOrigin(extensionId);
  return { extensionId, origin, ...redeemedCredential(await redeem(code, origin)) };
}

/* -------------------------------------------------------------------------------------------------
 * At-rest checks
 * ---------------------------------------------------------------------------------------------- */

/** The rows a statement returns, as plain records. */
function readRows(sql: string): readonly Readonly<Record<string, unknown>>[] {
  return harness.store.statement(sql).all();
}

/** The `credentials` rows of one role. */
function credentialRowsOf(role: PrincipalRole): readonly Readonly<Record<string, unknown>>[] {
  return readRows(SELECT_CREDENTIALS).filter((row) => row['role'] === role);
}

/** The digests a set of `credentials` rows key on. */
function digestsOf(rows: readonly Readonly<Record<string, unknown>>[]): string[] {
  const digests: string[] = [];
  for (const row of rows) {
    const digest = row['token_hash'];
    if (typeof digest === 'string') {
      digests.push(digest);
    }
  }
  return digests;
}

/** The digests the `credentials` table currently keys on. */
function storedDigests(): ReadonlySet<string> {
  return new Set(digestsOf(readRows(SELECT_CREDENTIALS)));
}

/**
 * Proves that no plaintext credential or pairing code is at rest: every row of
 * `credentials` and `pairing_codes` keys on a SHA-256 digest, no row holds a
 * tracked secret, and neither the database file nor its write-ahead log
 * contains one.
 */
async function assertNoPlaintextAtRest(): Promise<void> {
  const credentialRows = readRows(SELECT_CREDENTIALS);
  const codeRows = readRows(SELECT_PAIRING_CODES);
  for (const row of credentialRows) {
    const digest = row['token_hash'];
    expect(typeof digest === 'string' && DIGEST_PATTERN.test(digest), 'a credentials key').toBe(
      true,
    );
  }
  for (const row of codeRows) {
    const digest = row['code_hash'];
    expect(typeof digest === 'string' && DIGEST_PATTERN.test(digest), 'a pairing_codes key').toBe(
      true,
    );
  }
  expect(leaksIn(JSON.stringify([credentialRows, codeRows])), 'secrets in the auth tables').toEqual(
    [],
  );
  for (const file of [harness.store.path, `${harness.store.path}${WAL_SUFFIX}`]) {
    const bytes = await readFile(file).catch((cause: unknown) => {
      if (
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        cause.code === 'ENOENT'
      ) {
        return undefined;
      }
      throw cause;
    });
    if (bytes !== undefined) {
      expect(leaksIn(bytes), 'secrets in the database files').toEqual([]);
    }
  }
}

/** Proves that no tracked secret reached any record the service's logger wrote. */
function assertNothingLogged(): void {
  expect(leaksIn(harness.logger.text()), 'secrets in the service log').toEqual([]);
}

/* -------------------------------------------------------------------------------------------------
 * The plan-stage gate
 * ---------------------------------------------------------------------------------------------- */

/** The pipeline stage whose provider call {@link PlanGate} can hold. */
const PLAN_STAGE: PromptStage = 'plan';

/** A plan-stage provider call {@link PlanGate} is holding. */
interface HeldPlanCall {
  /** The session the call plans for, as the orchestrator names it in the request. */
  readonly sessionId: string | undefined;
  /** Lets the call through to the deterministic planner. */
  readonly release: () => void;
}

/**
 * The real deterministic provider the suite runs on, with a gate in front of
 * its plan stage. The gate is open unless a test holds it, so every session
 * plans exactly as the deterministic provider plans. While it is held, each
 * plan-stage call waits at the gate: the pipeline has indexed its project and
 * has not yet installed anything, which is the window a test relinks a root in
 * to prove the install refuses it.
 *
 * Honours the provider contract: one attempt per call, and never a throw or a
 * rejection — a held call only resolves later, with the deterministic answer.
 */
interface PlanGate {
  /** The provider handed to {@link startHarness}. */
  readonly provider: ModelProvider;
  /** Holds every plan-stage call from now until {@link PlanGate.release}. */
  hold(): void;
  /** The calls held since {@link PlanGate.hold}, oldest first. */
  held(): readonly HeldPlanCall[];
  /** Lets every held call through and opens the gate again. */
  release(): void;
}

/** Builds the {@link PlanGate} around a fresh deterministic provider. */
function createPlanGate(): PlanGate {
  const created = createDeterministicProvider();
  if (isErr(created)) {
    throw new Error(`The deterministic provider could not be built: ${created.error.message}`, {
      cause: created.error,
    });
  }
  const base = created.value;
  let holding = false;
  const calls: HeldPlanCall[] = [];

  const provider: ModelProvider = {
    id: base.id,
    generateText: (request) => base.generateText(request),
    generateStructured: (schema, request) => {
      if (!holding || request.metadata.stage !== PLAN_STAGE) {
        return base.generateStructured(schema, request);
      }
      return new Promise<void>((resolve) => {
        calls.push({ sessionId: request.metadata.sessionId, release: resolve });
      }).then(() => base.generateStructured(schema, request));
    },
    callTools: (request, tools) => base.callTools(request, tools),
  };

  return {
    provider,
    hold: () => {
      holding = true;
    },
    held: () => [...calls],
    release: () => {
      holding = false;
      for (const call of calls.splice(0)) {
        call.release();
      }
    },
  };
}

/** The suite's plan-stage gate; open except inside the test that holds it. */
const planGate = createPlanGate();

/* -------------------------------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------------------------- */

beforeAll(async () => {
  harness = await startHarness({ provider: planGate.provider });
  track('editor credential', harness.editorToken);
  projectA = harness.requireProject().root;
  projectB = (await harness.copyFixtureProject()).root;
  serverEvents = readTelemetryBatch('telemetry-trace-cross-tier.json');

  for (const projectRoot of [projectA, projectB]) {
    const launched = await harness.launchDevServer(projectRoot);
    if (isErr(launched)) {
      throw new Error(`The stand-in dev server did not launch (${launched.error.code}).`);
    }
  }
  sessionA = await harness.createSession({ projectRoot: projectA, question: QUESTION });
  sessionB = await harness.createSession({ projectRoot: projectB, question: QUESTION });
  // Both pipelines settle at the readiness gate, waiting for a bound tab.
  for (const session of [sessionA, sessionB]) {
    await harness.waitForSession(
      session.id,
      (record) => record.status === 'instrumenting' || record.status === 'ready',
    );
  }
});

afterAll(async () => {
  // `harness` stays unset when `startHarness` itself failed; there is nothing to stop then.
  if (harness === undefined) {
    return;
  }
  const report = await harness.stop();
  expect(report.problems).toEqual([]);
  await harness.assertNoLeaks();
});

/* -------------------------------------------------------------------------------------------------
 * HTTP authentication
 * ---------------------------------------------------------------------------------------------- */

describe('HTTP authentication', () => {
  it('refuses every credentialed operation of the route table when no credential is presented', async () => {
    for (const operation of AUTHENTICATED_OPERATIONS) {
      // The request is built from the route table row itself: its method and its
      // pattern with every declared parameter filled in.
      const { method } = HTTP_ROUTES[operation];
      const path = buildPath(operation, paramsFor(operation, newSessionId()));
      const response = await fetchRaw(
        { path },
        { method, token: null, body: requestBodyFor(operation) },
      );
      expectRefusal(
        response,
        'missing-credential',
        `${operation} (${method}) without a credential`,
      );
    }
    // The table is the service's whole surface: the credential, release,
    // rotation and purge operations are rows of it, swept above like every other.
    for (const administrative of [
      'devServer.credential',
      'credentials.release',
      'credentials.rotate',
      'session.purge',
    ] as const) {
      expect(AUTHENTICATED_OPERATIONS, `${administrative} is a credentialed row`).toContain(
        administrative,
      );
    }
  });

  it('refuses a malformed or unknown bearer value exactly as it refuses a missing one', async () => {
    const editorToken = harness.editorToken;
    const oversized = randomBytes(clientHelloPayloadSchema.shape.token.maxLength ?? 0).toString(
      'base64url',
    );
    const unknownBearer = trackBearer(randomSecretLike('bearer'));
    const variants: readonly (readonly [string, string])[] = [
      ['an unknown, well-formed credential', unknownBearer],
      [
        'an unknown JWT-shaped credential',
        formatBearer(track('unknown jwt', randomSecretLike('jwt'))),
      ],
      [
        'a truncated editor credential',
        formatBearer(track('truncated editor credential', editorToken.slice(0, -1))),
      ],
      ['an over-long credential', formatBearer(track('over-long credential', oversized))],
      ['two credentials in one header', `${unknownBearer}, ${formatBearer(editorToken)}`],
      ['another scheme', `Basic ${track('basic credential', randomBytes(24).toString('base64'))}`],
      ['the scheme alone', formatBearer('')],
    ];

    for (const operation of AUTHENTICATED_OPERATIONS) {
      const absentResponse = await fetchRaw(targetFor(operation, sessionA.id), {
        token: null,
        body: requestBodyFor(operation),
      });
      const absent = refusalShape(absentResponse);
      const absentKeys = bodyKeys(absentResponse);
      for (const [label, value] of variants) {
        const response = await fetchRaw(targetFor(operation, sessionA.id), {
          token: null,
          headers: { [AUTHORIZATION_HEADER]: value },
          body: requestBodyFor(operation),
        });
        // Status, code and body shape — everything a client can branch on — are
        // identical, so no probe tells "no credential" from "a wrong one". The
        // message is the service's fixed troubleshooting sentence for the
        // verdict, chosen from its refusal table and never built from the
        // request; `fetchRaw` has already proven that no presented value is
        // echoed.
        const shape = refusalShape(response);
        expect({ status: shape.status, code: shape.code }, `${operation}: ${label}`).toEqual({
          status: absent.status,
          code: absent.code,
        });
        expect(bodyKeys(response), `${operation}: ${label}: body fields`).toEqual(absentKeys);
        expect(CREDENTIAL_REFUSAL_MESSAGES, `${operation}: ${label}: message`).toContain(
          shape.message,
        );
      }
    }
  });

  it('accepts the editor credential that the service wrote to auth.json at 0600', async () => {
    const authFile = await stat(harness.config.authFilePath);
    expect(authFile.mode & PERMISSION_BITS).toBe(SECURE_FILE_MODE);

    const listed = await listSessionIds();
    expect(listed).toEqual(expect.arrayContaining([sessionA.id, sessionB.id]));
    for (const operation of ['session.get', 'panel.get', 'modifications.list'] as const) {
      expectSuccess(await fetchRaw(targetFor(operation, sessionA.id)), operation);
    }
  });

  it('answers GET /health without a credential, with nothing but version and pairing availability', async () => {
    const response = await fetchRaw('health', { token: null });
    expect(response.status).toBe(200);
    const parsed = healthResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new Error('The health reply does not satisfy its schema.');
    }
    expect(Object.keys(parsed.data).sort()).toEqual(Object.keys(healthResponseSchema.shape).sort());
    expect(parsed.data.protocolVersion).toBe(PROTOCOL_VERSION);
    // An editor connection is live, so a code could be shown to the developer.
    expect(parsed.data.pairingAvailable).toBe(true);
    for (const fact of [harness.home, projectA, projectB, sessionA.id, sessionB.id]) {
      expect(response.text.includes(fact), 'the health body names local state').toBe(false);
    }
    expect(response.text.includes(sha256Hex(harness.editorToken))).toBe(false);

    // Exempt means the bearer check is skipped, not that a bad bearer is judged.
    const withBogusBearer = await fetchRaw('health', {
      token: null,
      headers: { [AUTHORIZATION_HEADER]: trackBearer(randomSecretLike('bearer')) },
    });
    expect(withBogusBearer.status).toBe(200);
  });

  it('lets POST /pair/complete through without a credential: the one-time code is the capability', async () => {
    const response = await redeem(randomPairingCode(), chromeExtensionOrigin(newExtensionId()));
    // The pairing handler answered — not the bearer gate, which would say "missing credential".
    const body = expectRefusal(response, 'pairing-invalid', 'an unissued code');
    expect(body.code).not.toBe(AUTH_FAILURE_REASONS['missing-credential'].code);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Origin policy
 * ---------------------------------------------------------------------------------------------- */

describe('origin policy', () => {
  it('refuses every web origin even when it carries a valid editor credential', async () => {
    const before = await listSessionIds();
    for (const origin of webOrigins()) {
      expectRefusal(await fetchRaw('session.list', { origin }), 'forbidden-origin', origin);
      expectRefusal(
        await fetchRaw('session.create', {
          origin,
          body: { projectRoot: projectA, question: QUESTION },
        }),
        'forbidden-origin',
        `session.create from ${origin}`,
      );
      expectRefusal(
        await fetchRaw(targetFor('capture.start', sessionA.id), { origin, body: {} }),
        'forbidden-origin',
        `capture.start from ${origin}`,
      );
    }
    // Nothing a refused request asked for happened.
    expect(await listSessionIds()).toEqual(before);
  });

  it('refuses web origins on both exempt operations too, before a pairing code is looked at', async () => {
    const code = track('pairing code', harness.startPairing().code);
    for (const origin of webOrigins()) {
      expectRefusal(await fetchRaw('health', { token: null, origin }), 'forbidden-origin', origin);
      expectRefusal(await redeem(code, origin), 'forbidden-origin', `pair.complete from ${origin}`);
    }
    // The code survived every refused attempt: the origin gate burnt nothing.
    redeemedToken(await redeem(code, chromeExtensionOrigin(newExtensionId())));
  });

  it('accepts exactly the three client origins, each only for the credential its client holds', async () => {
    const extension = chromeExtensionOrigin(newExtensionId());
    const webview = webviewOrigin();

    // Absent (a Node client), a Chrome extension and a VS Code webview.
    for (const origin of [undefined, extension, webview]) {
      expect((await fetchRaw('health', { token: null, origin })).status).toBe(200);
    }

    // The editor credential: from Node and from its webview, never from an extension.
    expectSuccess(await fetchRaw('session.list'), 'session.list');
    expectSuccess(await fetchRaw('session.list', { origin: webview }), 'session.list');
    expectRefusal(
      await fetchRaw('session.list', { origin: extension }),
      'origin-not-permitted-for-role',
      'the editor credential from an extension',
    );

    // A DevTools credential: from the extension it was issued to …
    const devtools = await bindDevtools(TABS.acceptedOrigin, sessionB);
    const target = targetFor('session.get', sessionB.id);
    expectSuccess(
      await fetchRaw(target, presenting(devtools.credential, TABS.acceptedOrigin)),
      'session.get',
    );

    // … and, on a GET — which Chrome sends without an `Origin` — from no origin
    // as well, but only with the read proof pairing issued with the credential.
    // A stolen copy of the credential and the bound tab reads nothing without
    // it, whether it sends no origin or writes the issuing extension's itself.
    const originless = {
      ...presenting(devtools.credential, TABS.acceptedOrigin),
      origin: undefined,
    };
    expectSuccess(await fetchRaw(target, originless), 'session.get');
    for (const origin of [undefined, devtools.credential.origin]) {
      const refused = expectRefusal(
        await fetchRaw(target, { ...originless, origin, readProof: undefined }),
        'missing-credential',
        `a DevTools session.get from ${origin ?? 'no origin'} without the read proof`,
      );
      expect(refused.code).toBe('UNAUTHORIZED');
    }

    // A proof of the holder's own choosing is not the one pairing issued …
    const chosen = track('read proof', randomBytes(READ_PROOF_BYTES).toString('base64url'));
    const guessing = { ...originless, readProof: chosen };
    expectRefusal(
      await fetchRaw(target, guessing),
      'unknown-credential',
      'a DevTools session.get with a read proof pairing did not issue',
    );

    // … and no socket can make it one. A Node process holding the credential
    // writes the issuing extension's origin on its own upgrade: its hello is
    // admitted — an origin is all a hello can be judged by — but a hello
    // carries no proof, and one that tries is refused outright.
    const hostile = await harness.ws({
      client: 'devtools',
      token: devtools.credential.token,
      origin: devtools.credential.origin,
    });
    expect(hostile.authenticated, hostile.describe()).toBe(true);
    await expectHelloRefused(
      { ...hello('devtools', devtools.credential.token), readProof: chosen } as ClientHelloPayload,
      devtools.credential.origin,
    );
    for (const origin of [undefined, devtools.credential.origin]) {
      expectRefusal(
        await fetchRaw(target, { ...guessing, origin }),
        'unknown-credential',
        `a chosen read proof from ${origin ?? 'no origin'} after a forged-origin hello`,
      );
    }
    await hostile.close();
    // The proof pairing issued reads, with or without the extension's origin.
    expectSuccess(
      await fetchRaw(target, presenting(devtools.credential, TABS.acceptedOrigin)),
      'session.get',
    );
    expectSuccess(await fetchRaw(target, originless), 'session.get');

    for (const origin of [webview, extension]) {
      expectRefusal(
        await fetchRaw(target, { token: devtools.credential.token, origin }),
        'origin-not-permitted-for-role',
        `a DevTools credential from ${origin}`,
      );
    }
    // A state-changing DevTools request still has to name the extension.
    expectRefusal(
      await fetchRaw(targetFor('capture.stop', sessionB.id), {
        ...presenting(devtools.credential, TABS.acceptedOrigin),
        origin: undefined,
        body: {},
      }),
      'origin-not-permitted-for-role',
      'a DevTools capture.stop from no origin',
    );
    await unbind(devtools, TABS.acceptedOrigin);
  });

  it('grants no cross-origin read: no Access-Control-Allow-Origin on any kind of response', async () => {
    const webOrigin = STATIC_WEB_ORIGINS[0];
    const samples: readonly (readonly [string, RawFetchResponse, number])[] = [
      ['exempt, answered', await fetchRaw('health', { token: null }), 200],
      [
        'exempt, web origin',
        await fetchRaw('health', { token: null, origin: webOrigin }),
        AUTH_FAILURE_REASONS['forbidden-origin'].status,
      ],
      [
        'exempt, refused by its handler',
        await redeem(randomPairingCode(), chromeExtensionOrigin(newExtensionId())),
        AUTH_FAILURE_REASONS['pairing-invalid'].status,
      ],
      ['credentialed, answered', await fetchRaw('session.list'), 200],
      [
        'credentialed, no credential',
        await fetchRaw('session.list', { token: null }),
        AUTH_FAILURE_REASONS['missing-credential'].status,
      ],
      [
        'credentialed, web origin',
        await fetchRaw('session.list', { origin: webOrigin }),
        AUTH_FAILURE_REASONS['forbidden-origin'].status,
      ],
      [
        'a CORS preflight from a web origin',
        await fetchRaw('session.create', {
          method: PREFLIGHT_METHOD,
          token: null,
          origin: webOrigin,
          headers: {
            [PREFLIGHT_METHOD_HEADER]: HTTP_ROUTES['session.create'].method,
            [PREFLIGHT_HEADERS_HEADER]: AUTHORIZATION_HEADER,
          },
        }),
        AUTH_FAILURE_REASONS['forbidden-origin'].status,
      ],
      [
        'a path no route answers',
        await fetchRaw({
          path: `${buildPath('session.get', { id: sessionA.id })}/${randomUUID()}`,
        }),
        404,
      ],
    ];
    for (const [label, response, status] of samples) {
      expect(response.status, label).toBe(status);
      expectNoCorsGrant(response);
    }
    // And every other response this suite has read so far was checked the same way.
    expect(inspectedResponses).toBeGreaterThan(samples.length);
  });
});

/* -------------------------------------------------------------------------------------------------
 * WebSocket handshake
 * ---------------------------------------------------------------------------------------------- */

describe('WebSocket handshake', () => {
  it('refuses an upgrade from a web origin before any WebSocket exists, and files it naming the origin', async () => {
    // The first web-origin upgrades this service refuses, so the whole burst
    // of the upgrade gate's refusal log is still unspent.
    expect(harness.logger.withMessage(UPGRADE_ORIGIN_REFUSED_LOG)).toEqual([]);
    const mark = harness.logger.records.length;
    const origins = webOrigins();
    for (const origin of origins) {
      const raw = harness.rawSocket({ origin });
      expect(await raw.waitForOpen(), `an upgrade from ${origin} opened`).toBe(false);
      expect(raw.upgradeStatus, origin).toBe(AUTH_FAILURE_REASONS['forbidden-origin'].status);
      expect(raw.frames).toEqual([]);
      // No socket ever existed, so there was no WebSocket close handshake to carry a code.
      expect(raw.closes.map((record) => record.code)).not.toContain(WS_CLOSE_UNAUTHORIZED);
    }

    // Each refusal is filed with its origin — `http://evil.example` first, at
    // `warn` — the first burst at `warn` and the rest at `debug`, never with
    // the request target.
    expect(origins[0]).toBe('http://evil.example');
    const filed = logsSince(mark, UPGRADE_ORIGIN_REFUSED_LOG);
    expect(filed.map((record) => record.fields['origin'])).toEqual(origins);
    expect(filed.map((record) => record.level)).toEqual(
      origins.map((_origin, index) => (index < REFUSAL_LOG_BURST ? 'warn' : 'debug')),
    );
    expect(filed[0]?.fields).toMatchObject({ status: 403, suppressed: 0 });
    for (const record of filed) {
      expect(record.line.includes(WS_PATH), 'a refusal record names the request target').toBe(
        false,
      );
    }
  });

  it('closes a socket that never sends client.hello with WS_CLOSE_UNAUTHORIZED after the handshake window', async () => {
    const raw = harness.rawSocket();
    expect(await raw.waitForOpen()).toBe(true);
    const openedAt = Date.now();
    const closed = await raw.waitForClose(CLIENT_HELLO_TIMEOUT_MS + HARNESS_TIMEOUTS.message);
    const elapsed = Date.now() - openedAt;
    expect(closed.code).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(elapsed).toBeGreaterThanOrEqual(CLIENT_HELLO_TIMEOUT_MS - HELLO_WINDOW_TOLERANCE_MS);
    expect(elapsed).toBeLessThan(CLIENT_HELLO_TIMEOUT_MS + HARNESS_TIMEOUTS.message);
    expect(raw.frames).toEqual([]);
  });

  it('closes a connection whose first frame is not a hello its credential satisfies', async () => {
    const unknown = track('unknown jwt', randomSecretLike('jwt'));
    expect(clientHelloPayloadSchema.safeParse(hello('vscode', unknown)).success).toBe(true);
    await expectHelloRefused(hello('vscode', unknown, { projectRoot: projectA }));
    await expectHelloRefused(
      hello('devtools', unknown, { tabId: TABS.own }),
      chromeExtensionOrigin(newExtensionId()),
    );
    // An empty credential fails protocol's hello schema itself.
    await expectHelloRefused(hello('vscode', '', { projectRoot: projectA }));

    // A first frame that is some other message, or not a message at all.
    const notHello = harness.rawSocket();
    expect(await notHello.waitForOpen()).toBe(true);
    notHello.sendMessage('source.open', {
      sessionId: sessionA.id,
      location: locationOf(PROJECT_FILE),
    });
    expect((await notHello.waitForClose()).code).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(notHello.frames).toEqual([]);

    const garbage = harness.rawSocket();
    expect(await garbage.waitForOpen()).toBe(true);
    garbage.send(randomUUID());
    expect((await garbage.waitForClose()).code).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(garbage.frames).toEqual([]);
  });

  it('accepts a valid hello and registers the connection for its session traffic', async () => {
    const raw = await openRegisteredEditor(harness.editorToken);
    expect(raw.socket.readyState).toBe(raw.socket.OPEN);
    await raw.close();
  });

  it('refuses a hello of another protocol major and accepts one of the same major', async () => {
    const [, minor = '0'] = PROTOCOL_VERSION.split('.');
    const incompatible = `${String(PROTOCOL_VERSION_MAJOR + 1)}.0.0`;
    const compatible = `${String(PROTOCOL_VERSION_MAJOR)}.${String(Number(minor) + 1)}.0`;
    expect(isCompatibleProtocolVersion(incompatible)).toBe(false);
    expect(isCompatibleProtocolVersion(compatible)).toBe(true);

    const refused = await expectHelloRefused(
      hello('vscode', harness.editorToken, { projectRoot: projectA, version: incompatible }),
    );
    // The close reason tells the client which version to update to.
    expect(refused.reason).toContain(PROTOCOL_VERSION);

    const accepted = await openRegisteredEditor(harness.editorToken, compatible);
    await accepted.close();
  });

  it('authorizes from the resolved principal, never from the client kind a hello announces', async () => {
    const devtools = harness.issueDevtoolsCredential();
    track('devtools credential', devtools.token);
    const serverAgent = harness.issueServerAgentCredential(projectA);
    track('server-agent credential', serverAgent.token);

    // A DevTools credential announcing itself as the editor, from its own extension.
    await expectHelloRefused(
      hello('vscode', devtools.token, { projectRoot: projectA }),
      devtools.origin,
    );
    // The editor credential announcing a DevTools client, and the page agent that holds none.
    await expectHelloRefused(hello('devtools', harness.editorToken, { tabId: TABS.own }));
    await expectHelloRefused(hello('agent', harness.editorToken, { tabId: TABS.own }));
    // A dev server's credential announcing the editor.
    await expectHelloRefused(hello('vscode', serverAgent.token, { projectRoot: projectA }));

    // And the DevTools credential gains no editor privilege over HTTP either.
    const before = await listSessionIds();
    expectRefusal(
      await fetchRaw('session.create', {
        ...presenting(devtools),
        body: { projectRoot: projectA, question: QUESTION },
      }),
      'role-not-permitted',
      'session.create with a DevTools credential',
    );
    expectRefusal(
      await fetchRaw('session.list', presenting(devtools)),
      'role-not-permitted',
      'session.list with a DevTools credential',
    );
    expect(await listSessionIds()).toEqual(before);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Pairing
 * ---------------------------------------------------------------------------------------------- */

describe('pairing', () => {
  beforeEach(() => {
    // A quiet lockout window before every case, so no case inherits another's failures.
    requireClock().advance(PAIRING_LOCKOUT_MS + 1);
  });

  it('mints a code for the editor role only', async () => {
    expectRefusal(
      await fetchRaw('pair.start', { token: null, body: {} }),
      'missing-credential',
      'pair.start without a credential',
    );
    const devtools = harness.issueDevtoolsCredential();
    track('devtools credential', devtools.token);
    expectRefusal(
      await fetchRaw('pair.start', { ...presenting(devtools), body: {} }),
      'role-not-permitted',
      'pair.start with a DevTools credential',
    );
    const serverAgent = harness.issueServerAgentCredential(projectA);
    track('server-agent credential', serverAgent.token);
    expectRefusal(
      await fetchRaw('pair.start', { token: serverAgent.token, body: {} }),
      'role-not-permitted',
      'pair.start with a server-agent credential',
    );

    const before = requireClock().peek();
    const response = await fetchRaw('pair.start', { body: {} });
    const after = requireClock().peek();
    expect(response.status).toBe(200);
    expect(response.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
    const parsed = pairStartResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new Error('The pair.start reply does not satisfy its schema.');
    }
    track('pairing code', parsed.data.code);
    expect(parsed.data.code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(parsed.data.expiresAt).toBeGreaterThanOrEqual(before + PAIRING_CODE_TTL_MS);
    expect(parsed.data.expiresAt).toBeLessThanOrEqual(after + PAIRING_CODE_TTL_MS);
  });

  it('redeems a code once, from the extension origin, for a credential scoped to that extension', async () => {
    const extensionId = newExtensionId();
    const origin = chromeExtensionOrigin(extensionId);
    const code = await pairStart();
    const redeemed = redeemedCredential(await redeem(code, origin));
    const { token } = redeemed;
    const credential: DevtoolsCredential = { extensionId, origin, ...redeemed };

    // The credential works on a DevTools operation: it authenticates, binds its
    // tab and reads the session that tab is bound to.
    const devtools = await bindDevtools(TABS.paired, sessionB, credential);
    expect(devtools.client.authenticated).toBe(true);
    expectSuccess(
      await fetchRaw(targetFor('session.get', sessionB.id), presenting(credential, TABS.paired)),
      'session.get',
    );

    // Single use.
    expectRefusal(await redeem(code, origin), 'pairing-invalid', 'a code redeemed twice');

    // Scoped to the extension that paired: another extension's origin is refused.
    const otherOrigin = chromeExtensionOrigin(newExtensionId());
    expectRefusal(
      await fetchRaw(targetFor('session.get', sessionB.id), { token, origin: otherOrigin }),
      'origin-not-permitted-for-role',
      'a paired credential from another extension',
    );
    await expectHelloRefused(hello('devtools', token, { tabId: TABS.paired }), otherOrigin);

    await unbind(devtools, TABS.paired);
  });

  it('refuses a code once its validity window has passed', async () => {
    const code = await pairStart();
    requireClock().advance(PAIRING_CODE_TTL_MS + 1);
    expectRefusal(
      await redeem(code, chromeExtensionOrigin(newExtensionId())),
      'pairing-invalid',
      'an expired code',
    );
  });

  it('compares the code exactly: a padded or lower-case code is a wrong code over HTTP, and the exact code then redeems', async () => {
    const origin = chromeExtensionOrigin(newExtensionId());
    // A code of digits alone has no lower-case spelling; the CSPRNG draws one
    // about once in 65 000 codes, so a bounded redraw keeps the case exact.
    let code = await pairStart();
    for (let draw = 0; draw < 4 && code.toLowerCase() === code; draw += 1) {
      code = await pairStart();
    }
    expect(code.toLowerCase(), 'the code has a letter to fold').not.toBe(code);
    const logMark = harness.logger.records.length;

    const respelled = [
      [` ${code}\t`, 'a whitespace-padded code'],
      [`${code}\n`, 'a code with a trailing newline'],
      [code.toLowerCase(), 'a lower-case code'],
    ] as const;
    const invalid = AUTH_FAILURE_REASONS['pairing-invalid'];
    for (const [variant, label] of respelled) {
      const response = await redeem(variant, origin);
      expectRefusal(response, 'pairing-invalid', label);
      // The very reply a wrong code gets: nothing tells a re-spelling apart.
      expect(refusalShape(response), label).toEqual({
        status: invalid.status,
        code: invalid.code,
        message: invalid.message,
      });
    }
    // Each re-spelling was judged, and counted, as a wrong code.
    const verdicts = harness.logger.records
      .slice(logMark)
      .filter((record) => record.fields['reason'] === 'pairing-invalid');
    expect(verdicts).toHaveLength(respelled.length);

    redeemedToken(await redeem(code, origin));
  });

  it('locks pairing for every origin after repeated failures, refusing even a valid code, then recovers', async () => {
    const failingOrigin = chromeExtensionOrigin(newExtensionId());
    const code = await pairStart();
    // A code some other extension has already redeemed.
    const spent = await pairStart();
    redeemedToken(await redeem(spent, chromeExtensionOrigin(newExtensionId())));

    for (let attempt = 1; attempt <= PAIRING_MAX_FAILURES; attempt += 1) {
      expectRefusal(
        await redeem(randomPairingCode(), failingOrigin),
        'pairing-invalid',
        `failed attempt ${String(attempt)}`,
      );
    }

    // Locked: a valid, a wrong and a spent code get the very same answer, so a
    // lockout reveals nothing about any code. The lockout is its own verdict —
    // a rate limit the failures earned, decided before the code is looked at —
    // which is why it is the one pairing refusal that differs from the uniform
    // "invalid code" reply the next case pins. And it is the service's, not
    // the failing origin's: an origin that never failed gets it too.
    const withValid = await redeem(code, failingOrigin);
    const withWrong = await redeem(randomPairingCode(), failingOrigin);
    const withSpent = await redeem(spent, failingOrigin);
    const fromAnother = await redeem(code, chromeExtensionOrigin(newExtensionId()));
    expectRefusal(withValid, 'pairing-locked', 'the valid code during a lockout');
    expectRefusal(fromAnother, 'pairing-locked', 'another origin during the lockout');
    const locked = AUTH_FAILURE_REASONS['pairing-locked'];
    for (const response of [withValid, withWrong, withSpent, fromAnother]) {
      expect(refusalShape(response)).toEqual({
        status: locked.status,
        code: locked.code,
        message: locked.message,
      });
    }

    // Once the window passes, the still-valid code redeems.
    requireClock().advance(PAIRING_LOCKOUT_MS + 1);
    redeemedToken(await redeem(code, failingOrigin));
  });

  it('counts failures under rotating forged Origins as one caller: five forged ids lock the genuine extension out', async () => {
    const genuine = newExtensionId();
    const genuineOrigin = chromeExtensionOrigin(genuine);
    const code = await pairStart();

    // One wrong guess per invented extension id — the most a per-origin ledger
    // would ever have seen from any single caller.
    const forgedOrigins = Array.from({ length: PAIRING_MAX_FAILURES }, () =>
      chromeExtensionOrigin(newExtensionId()),
    );
    expect(new Set([genuineOrigin, ...forgedOrigins]).size).toBe(PAIRING_MAX_FAILURES + 1);
    for (const [index, forged] of forgedOrigins.entries()) {
      expectRefusal(
        await redeem(randomPairingCode(), forged),
        'pairing-invalid',
        `a guess from forged id ${String(index + 1)}`,
      );
    }

    // The genuine extension's right code is refused, and so is a guess from
    // yet another invented id.
    expectRefusal(await redeem(code, genuineOrigin), 'pairing-locked', 'the genuine extension');
    expectRefusal(
      await redeem(randomPairingCode(), chromeExtensionOrigin(newExtensionId())),
      'pairing-locked',
      'a fresh forged id',
    );

    // Every read of the harness clock moves it one step, so the lock's exact
    // edge is pinned by `src/server/auth.test.ts`; here it is crossed from well
    // inside — still locked half a window later, however hard it was hammered
    // meanwhile — to just past it, where the code it held back still redeems,
    // for a credential scoped to the genuine extension alone.
    requireClock().advance(PAIRING_LOCKOUT_MS / 2);
    for (const forged of forgedOrigins) {
      expectRefusal(await redeem(randomPairingCode(), forged), 'pairing-locked', 'mid-lock guess');
    }
    expectRefusal(await redeem(code, genuineOrigin), 'pairing-locked', 'half a window later');
    requireClock().advance(PAIRING_LOCKOUT_MS / 2 + 1);
    const token = redeemedToken(await redeem(code, genuineOrigin));
    // From the genuine origin the credential authenticates, and is then held to
    // its role (DevTools may not list sessions); from a forged id it does not
    // get that far.
    expectRefusal(
      await fetchRaw('session.list', { token, origin: genuineOrigin }),
      'role-not-permitted',
      'the paired credential from its own extension',
    );
    expectRefusal(
      await fetchRaw('session.list', { token, origin: forgedOrigins[0] }),
      'origin-not-permitted-for-role',
      'the paired credential from a forged id',
    );
  });

  it('answers a wrong, a used and an expired code with one uniform refusal', async () => {
    const origin = chromeExtensionOrigin(newExtensionId());
    const logMark = harness.logger.records.length;

    const wrong = await redeem(randomPairingCode(), origin);

    const used = await pairStart();
    redeemedToken(await redeem(used, origin));
    const reused = await redeem(used, origin);

    const expiring = await pairStart();
    requireClock().advance(PAIRING_CODE_TTL_MS + 1);
    const expired = await redeem(expiring, origin);

    const invalid = AUTH_FAILURE_REASONS['pairing-invalid'];
    const expected: RefusalShape = {
      status: invalid.status,
      code: invalid.code,
      message: invalid.message,
    };
    for (const response of [wrong, reused, expired]) {
      expect(refusalShape(response)).toEqual(expected);
    }

    // The three verdicts genuinely differed inside the service — its own log
    // tells them apart — while the wire could not.
    const reasons = new Set(
      harness.logger.records.slice(logMark).map((record) => record.fields['reason']),
    );
    for (const reason of UNIFORM_PAIRING_REFUSAL_REASONS) {
      expect(reasons, `the service recorded a ${reason} verdict`).toContain(reason);
    }
  });

  it('keeps every code and credential out of responses, the log and the store', async () => {
    assertNothingLogged();
    await assertNoPlaintextAtRest();
  });
});

/* -------------------------------------------------------------------------------------------------
 * Authorization by role and scope
 * ---------------------------------------------------------------------------------------------- */

describe('authorization by role and scope', () => {
  it('refuses every role on every operation the role table withholds from it', async () => {
    const devtools = harness.issueDevtoolsCredential();
    track('devtools credential', devtools.token);
    const serverAgent = harness.issueServerAgentCredential(projectA);
    track('server-agent credential', serverAgent.token);
    const presenters: Readonly<Record<PrincipalRole, Pick<RawFetchInit, 'token' | 'origin'>>> = {
      vscode: { token: harness.editorToken },
      devtools: presenting(devtools),
      'server-agent': { token: serverAgent.token },
    };

    const before = await listSessionIds();
    const refused = new Set<PrincipalRole>();
    for (const role of CREDENTIAL_ROLES) {
      for (const operation of AUTHENTICATED_OPERATIONS) {
        if (rolesFor(operation).includes(role)) {
          continue;
        }
        const response = await fetchRaw(targetFor(operation, sessionA.id), {
          ...presenters[role],
          body: requestBodyFor(operation),
        });
        expectRefusal(response, 'role-not-permitted', `${role} → ${operation}`);
        refused.add(role);
      }
    }
    // Each role is withheld something, and no refused call had an effect.
    expect([...refused].sort()).toEqual([...CREDENTIAL_ROLES].sort());
    expect(await listSessionIds()).toEqual(before);
  });

  it('confines a DevTools client to the session its own tab is bound to', async () => {
    const own = await bindDevtools(TABS.own, sessionA);
    const other = await bindDevtools(TABS.other, sessionB);
    await waitUntilReady(sessionA);
    const notBound = AUTH_FAILURE_REASONS['session-not-bound'].code;

    // Another tab's credential, bound to a different session, acts on nothing of
    // sessionA — whether it names its own tab or the tab sessionA is bound to.
    for (const operation of DEVTOOLS_OPERATIONS) {
      for (const tabId of [TABS.other, TABS.own]) {
        expectRefusal(
          await fetchRaw(targetFor(operation, sessionA.id), {
            ...presenting(other.credential, tabId),
            body: requestBodyFor(operation),
          }),
          'session-not-bound',
          `another tab (acting as ${String(tabId)}) → ${operation}`,
        );
      }
    }
    const openElsewhere = other.client.send('source.open', {
      sessionId: sessionA.id,
      location: locationOf(PROJECT_FILE),
    });
    const selectElsewhere = other.client.send('target.selected', {
      sessionId: sessionA.id,
      target: targetOn(sessionA),
    });
    expect(await other.client.flush()).toBe(true);
    expect(codesOf(other.client.errorsFor(openElsewhere.id))).toEqual([notBound]);
    expect(codesOf(other.client.errorsFor(selectElsewhere.id))).toEqual([notBound]);

    // The bound tab's own credential may do each of those things to its own session.
    const ownInit = presenting(own.credential, TABS.own);
    const editorA = await harness.editor(projectA);
    const mark = editorA.received.length;

    const started = await fetchRaw(targetFor('capture.start', sessionA.id), {
      ...ownInit,
      body: {},
    });
    expectSuccess(started, 'capture.start');
    const select = own.client.send('target.selected', {
      sessionId: sessionA.id,
      target: targetOn(sessionA),
    });
    const open = own.client.send('source.open', {
      sessionId: sessionA.id,
      location: locationOf(PROJECT_FILE),
    });
    expect(await own.client.flush()).toBe(true);
    expect(own.client.errorsFor(select.id)).toEqual([]);
    expect(own.client.errorsFor(open.id)).toEqual([]);
    await waitFor(
      editorA,
      'source.open',
      (message, index) => index >= mark && message.payload.sessionId === sessionA.id,
    );
    for (const operation of DEVTOOLS_OPERATIONS) {
      if (
        operation === 'capture.start' ||
        operation === 'capture.stop' ||
        operation === 'panel.getById'
      ) {
        continue;
      }
      expectSuccess(
        await fetchRaw(targetFor(operation, sessionA.id), {
          ...ownInit,
          body: requestBodyFor(operation),
        }),
        operation,
      );
    }
    const stopped = await fetchRaw(targetFor('capture.stop', sessionA.id), {
      ...ownInit,
      body: {},
    });
    expectSuccess(stopped, 'capture.stop');

    // And the other tab is equally at home on the session it is bound to.
    expectSuccess(
      await fetchRaw(targetFor('panel.data', sessionB.id), {
        ...presenting(other.credential, TABS.other),
        body: requestBodyFor('panel.data'),
      }),
      'panel.data',
    );
  });

  it('tells apart the tabs one credential multiplexes over one connection, over HTTP and WebSocket', async () => {
    const first = await sessionOfFreshProject();
    const second = await sessionOfFreshProject();
    const notBound = AUTH_FAILURE_REASONS['session-not-bound'].code;
    const operations = ['capture.start', 'panel.data', 'session.get'] as const;

    // Exactly like the MV3 service worker: one credential, one connection, a
    // hello naming no tab — every request and frame names the tab it acts for.
    const credential = harness.issueDevtoolsCredential();
    track('multiplexed devtools credential', credential.token);
    const mux = await harness.ws({
      client: 'devtools',
      token: credential.token,
      origin: credential.origin,
    });
    expect(mux.authenticated, mux.describe()).toBe(true);
    expect(mux.identity.tabId).toBeUndefined();
    await bindOver(mux, TABS.muxFirst, first);
    await bindOver(mux, TABS.muxSecond, second);
    await waitUntilReady(first);
    await waitUntilReady(second);
    const editorFirst = await harness.editor(first.projectRoot);

    /** Sends `target.selected` and `source.open` for `session` acting as `tabId`; returns each frame's codes. */
    const actOver = async (
      client: HarnessWsClient,
      session: SessionRecord,
      tabId: number | undefined,
    ): Promise<readonly (readonly string[])[]> => {
      const options = tabId === undefined ? undefined : { tabId };
      const select = client.send(
        'target.selected',
        { sessionId: session.id, target: targetOn(session) },
        options,
      );
      const open = client.send(
        'source.open',
        { sessionId: session.id, location: locationOf(PROJECT_FILE) },
        options,
      );
      expect(await client.flush()).toBe(true);
      return [codesOf(client.errorsFor(select.id)), codesOf(client.errorsFor(open.id))];
    };

    // 1. The credential's other tab, and a request naming no tab at all, act on
    //    nothing of the first tab's session — the credential alone is no tab.
    const markBefore = editorFirst.received.length;
    for (const operation of operations) {
      expectRefusal(
        await fetchRaw(targetFor(operation, first.id), {
          ...presenting(credential, TABS.muxSecond),
          body: requestBodyFor(operation),
        }),
        'session-not-bound',
        `the second tab → ${operation} on the first tab's session`,
      );
      const unnamed = expectRefusal(
        await fetchRaw(targetFor(operation, first.id), {
          ...presenting(credential),
          body: requestBodyFor(operation),
        }),
        'acting-tab-required',
        `no acting tab → ${operation}`,
      );
      expect(unnamed.message).toBe(AUTH_FAILURE_REASONS['acting-tab-required'].message);
    }
    expect(await actOver(mux, first, TABS.muxSecond)).toEqual([[notBound], [notBound]]);
    expect(await actOver(mux, first, undefined)).toEqual([[notBound], [notBound]]);
    expect(sourceOpensSince(editorFirst, markBefore), 'nothing reached the editor').toEqual([]);

    // A malformed acting tab is a malformed request, and only a DevTools
    // principal may name a tab at all.
    expectRefusal(
      await fetchRaw(targetFor('session.get', first.id), {
        ...presenting(credential),
        headers: { [ACTING_TAB_HEADER]: `${String(TABS.muxFirst)}.5` },
      }),
      'acting-tab-invalid',
    );
    expectRefusal(
      await fetchRaw(targetFor('session.get', first.id), {
        headers: { [ACTING_TAB_HEADER]: String(TABS.muxFirst) },
      }),
      'acting-tab-not-permitted',
      'the editor credential naming a tab',
    );

    // 2. The first tab may do each of those things to its own session, and the
    //    second tab to its own.
    const firstInit = presenting(credential, TABS.muxFirst);
    expectSuccess(await fetchRaw(targetFor('session.get', first.id), firstInit), 'session.get');
    expectSuccess(
      await fetchRaw(targetFor('panel.data', first.id), {
        ...firstInit,
        body: requestBodyFor('panel.data'),
      }),
      'panel.data',
    );
    expectSuccess(
      await fetchRaw(targetFor('capture.start', first.id), { ...firstInit, body: {} }),
      'capture.start',
    );
    const markOwn = editorFirst.received.length;
    expect(await actOver(mux, first, TABS.muxFirst)).toEqual([[], []]);
    await waitFor(
      editorFirst,
      'source.open',
      (message, index) => index >= markOwn && message.payload.sessionId === first.id,
    );
    expectSuccess(
      await fetchRaw(targetFor('session.get', second.id), presenting(credential, TABS.muxSecond)),
      'session.get',
    );

    // 3. A connection of the same credential that announced a tab in its hello
    //    is a single-tab connection: it acts for that tab only.
    const single = await harness.connectDevtools({ tabId: TABS.muxSecond, credential });
    expect(await actOver(single.client, first, TABS.muxFirst)).toEqual([[notBound], [notBound]]);
    await single.client.close();

    // 4. Replacement: the second tab takes the first session over, after which
    //    the displaced tab may act on it neither over HTTP nor over WebSocket.
    // The tab's own former binding is announced as displaced first, so the wait
    // is for the announcement of the new pair specifically.
    const markRebind = mux.received.length;
    const rebind = mux.send('session.bind', {
      tabId: TABS.muxSecond,
      url: first.devServerUrl,
      origin: new URL(first.devServerUrl).origin,
      sessionId: first.id,
    });
    await waitFor(
      mux,
      'session.bound',
      (message, index) =>
        index >= markRebind &&
        message.payload.tabId === TABS.muxSecond &&
        message.payload.sessionId === first.id &&
        (message.payload.reason ?? 'bound') === 'bound',
    );
    expect(mux.errorsFor(rebind.id)).toEqual([]);
    for (const operation of ['capture.stop', 'panel.data', 'session.get'] as const) {
      expectRefusal(
        await fetchRaw(targetFor(operation, first.id), {
          ...firstInit,
          body: requestBodyFor(operation),
        }),
        'session-not-bound',
        `the displaced tab → ${operation}`,
      );
    }
    expect(await actOver(mux, first, TABS.muxFirst)).toEqual([[notBound], [notBound]]);
    const takeover = presenting(credential, TABS.muxSecond);
    expectSuccess(await fetchRaw(targetFor('session.get', first.id), takeover), 'session.get');
    expectSuccess(
      await fetchRaw(targetFor('capture.stop', first.id), { ...takeover, body: {} }),
      'capture.stop',
    );
    await mux.close();
  });

  it('holds a single-tab connection to its hello tab on every frame whose payload names a tab', async () => {
    const ownSession = await sessionOfFreshProject();
    const otherSession = await sessionOfFreshProject();
    const notBound = AUTH_FAILURE_REASONS['session-not-bound'].code;
    const own = TABS.singleOwn;
    const other = TABS.singleOther;

    /** The durable binding row of a tab. */
    const storedBinding = (tabId: number): TabBinding | undefined => {
      const read = harness.repos.sessions.getBindingByTab(tabId);
      if (isErr(read)) {
        throw new Error(`Reading the binding of tab ${String(tabId)} failed (${read.error.code}).`);
      }
      return read.value;
    };
    /** The bound tab a session's record mirrors. */
    const boundTabOf = (session: SessionRecord): SessionRecord['boundTab'] => {
      const read = harness.manager.get(session.id);
      if (isErr(read)) {
        throw new Error(`Reading session ${session.id} failed (${read.error.code}).`);
      }
      return read.value?.boundTab;
    };
    /** How many relayed readiness reports the ledger accepted for a tab. */
    const reportsFor = (tabId: number): number =>
      harness.logger
        .withMessage(AGENT_READY_RECORDED_LOG)
        .filter((record) => record.fields['tabId'] === tabId).length;
    /** A page agent's `agent.ready` for `tabId`, from a fresh document of `session`'s page. */
    const readyFor = (tabId: number, session: SessionRecord): MessagePayload<'agent.ready'> => ({
      tabId,
      documentId: newId('doc'),
      producerId: newProducerId(),
      url: session.devServerUrl,
      installedBeforeReact: true,
      reactDetected: true,
    });

    // The credential's other tab is bound, and its agent reported, over the
    // multiplexing service-worker connection, whose hello names no tab.
    const credential = harness.issueDevtoolsCredential();
    track('single-tab devtools credential', credential.token);
    const mux = await harness.ws({
      client: 'devtools',
      token: credential.token,
      origin: credential.origin,
    });
    expect(mux.authenticated, mux.describe()).toBe(true);
    await bindOver(mux, other, otherSession);
    const otherBinding = storedBinding(other);
    expect(otherBinding).toMatchObject({ sessionId: otherSession.id, tab: { tabId: other } });
    const otherBoundTab = boundTabOf(otherSession);
    expect(otherBoundTab).toMatchObject({ tabId: other });

    // A connection of the same credential whose hello announced its own tab.
    const single = await harness.connectDevtools({ tabId: own, credential });
    expect(single.client.identity.tabId).toBe(own);
    const muxMark = mux.received.length;
    const otherReportsBefore = reportsFor(other);

    // 1. It may not bind, navigate, unbind or report ready the other tab — not
    //    by default, and not by also naming that tab on the envelope.
    for (const envelope of [undefined, { tabId: other }]) {
      const attempts = [
        single.client.send(
          'session.bind',
          {
            tabId: other,
            url: ownSession.devServerUrl,
            origin: new URL(ownSession.devServerUrl).origin,
            sessionId: ownSession.id,
          },
          envelope,
        ),
        single.client.send(
          'tab.navigated',
          { tabId: other, url: ownSession.devServerUrl },
          envelope,
        ),
        single.client.send('session.unbind', { tabId: other }, envelope),
        single.client.send('agent.ready', readyFor(other, otherSession), envelope),
        single.client.send('agent.ready', readyFor(other, otherSession), {
          ...envelope,
          sessionId: otherSession.id,
        }),
      ];
      expect(await single.client.flush()).toBe(true);
      for (const attempt of attempts) {
        expect(isErr(attempt.result)).toBe(false);
        expect(codesOf(single.client.errorsFor(attempt.id))).toEqual([notBound]);
      }
    }

    // 2. None of it changed anything: the other tab's row, its record mirror,
    //    its live binding and its readiness are exactly as they were, the own
    //    session gained no tab, and no binding change was announced.
    expect(storedBinding(other)).toEqual(otherBinding);
    expect(boundTabOf(otherSession)).toEqual(otherBoundTab);
    expect(boundTabOf(ownSession)).toBeUndefined();
    expect(reportsFor(other)).toBe(otherReportsBefore);
    expect(await mux.flush()).toBe(true);
    expect(
      mux.received.slice(muxMark).filter((message) => isMessageOfType(message, 'session.bound')),
    ).toEqual([]);
    expectSuccess(
      await fetchRaw(targetFor('session.get', otherSession.id), presenting(credential, other)),
      'session.get',
    );
    expectRefusal(
      await fetchRaw(targetFor('session.get', ownSession.id), presenting(credential, other)),
      'session-not-bound',
      'the other tab → session.get on the own session',
    );

    // 3. The same frames for its own tab are accepted.
    const bound = await harness.bindTab(single.client, {
      tabId: own,
      url: ownSession.devServerUrl,
      origin: new URL(ownSession.devServerUrl).origin,
      sessionId: ownSession.id,
    });
    if (isErr(bound)) {
      throw new Error(
        `session.bind of the connection's own tab was refused with ${bound.error.code}.`,
      );
    }
    expect(bound.value.payload.sessionId).toBe(ownSession.id);
    const ownReportsBefore = reportsFor(own);
    const nextPage = new URL('/orders', ownSession.devServerUrl).toString();
    const accepted = [
      single.client.send('agent.ready', readyFor(own, ownSession), { sessionId: ownSession.id }),
      single.client.send('tab.navigated', { tabId: own, url: nextPage }, { tabId: own }),
    ];
    expect(await single.client.flush()).toBe(true);
    for (const receipt of accepted) {
      expect(isErr(receipt.result)).toBe(false);
      expect(single.client.errorsFor(receipt.id)).toEqual([]);
    }
    expect(reportsFor(own)).toBe(ownReportsBefore + 1);
    expect(storedBinding(own)).toMatchObject({
      sessionId: ownSession.id,
      tab: { tabId: own, url: nextPage },
    });
    const unbound = single.client.send('session.unbind', { tabId: own });
    expect(await single.client.flush()).toBe(true);
    expect(single.client.errorsFor(unbound.id)).toEqual([]);
    expect(storedBinding(own)).toBeUndefined();
    expect(boundTabOf(ownSession)).toBeUndefined();

    // The other tab's binding survived every one of those frames.
    expect(storedBinding(other)).toEqual(otherBinding);
    await single.client.close();
    await mux.close();
  });

  it('confines a server-agent credential to exactly its own project', async () => {
    const scoped = harness.issueServerAgentCredential(projectA);
    track('server-agent credential', scoped.token);

    const outOfScope = [
      projectB,
      join(projectB, 'app'),
      // A descendant of its own project is another project: the scope is one root, not a subtree.
      join(projectA, 'app'),
      `${projectA}-evil`,
    ];
    for (const projectRoot of outOfScope) {
      expectRefusal(
        await ingest(scoped.token, projectRoot),
        'project-out-of-scope',
        'ingest for a project the credential is not scoped to',
      );
    }
    // The credential is presented only by a Node process, never from an origin.
    expectRefusal(
      await ingest(scoped.token, projectA, chromeExtensionOrigin(newExtensionId())),
      'origin-not-permitted-for-role',
      'a server-agent credential from an extension',
    );

    const accepted = await ingest(scoped.token, projectA);
    expect(accepted.status).toBe(202);
    expect(telemetryIngestResponseSchema.safeParse(accepted.json).success).toBe(true);

    // Its socket authenticates, receives its configuration, and may send nothing.
    const socket = await harness.ws({
      client: 'server-agent',
      projectRoot: projectA,
      token: scoped.token,
    });
    expect(socket.authenticated).toBe(true);
    const frame = socket.send('source.open', {
      sessionId: sessionA.id,
      location: locationOf(PROJECT_FILE),
    });
    expect(await socket.flush()).toBe(true);
    expect(codesOf(socket.errorsFor(frame.id))).toEqual([
      AUTH_FAILURE_REASONS['role-not-permitted'].code,
    ]);
    await socket.close();
  });

  it('confines the editor credential to the workspace folders its live connections announce', async () => {
    const outOfScope = [
      // A prefix sibling, which a naive startsWith check would accept.
      `${projectA}-evil`,
      `${projectB}-evil`,
      // The directory that holds the workspace folder.
      dirname(projectA),
    ];
    for (const projectRoot of outOfScope) {
      expectRefusal(
        await fetchRaw('session.create', { body: { projectRoot, question: QUESTION } }),
        'project-out-of-scope',
        'session.create outside the announced workspace',
      );
      expectRefusal(
        await fetchRaw('devServer.launch', { body: { projectRoot } }),
        'project-out-of-scope',
        'devServer.launch outside the announced workspace',
      );
      expectRefusal(
        await fetchRaw('devServer.credential', { body: { projectRoot } }),
        'project-out-of-scope',
        'a dev-server credential outside the announced workspace',
      );
    }

    // A traversal that starts inside the workspace folder and climbs back out of
    // it. Session creation normalises the root and judges the result against the
    // scope; the dev-server routes refuse a `..` spelling before they get that far.
    // Either way the refusal names the project boundary and nothing is created.
    // The protocol row of `devServer.credential` checks only the shape of its
    // root; the service still refuses a relative one, which names no folder.
    const climbing = `${projectA}/../${basename(projectA)}-evil`;
    expectRefusal(
      await fetchRaw('session.create', { body: { projectRoot: climbing, question: QUESTION } }),
      'project-out-of-scope',
      'session.create through a traversal',
    );
    const serverAgentRowsBefore = credentialRowsOf('server-agent').length;
    for (const refused of [
      await fetchRaw('devServer.launch', { body: { projectRoot: climbing } }),
      await fetchRaw('devServer.credential', { body: { projectRoot: climbing } }),
      await fetchRaw('devServer.credential', { body: { projectRoot: basename(projectA) } }),
    ]) {
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      expect(refusalShape(refused).code).toBe(AUTH_FAILURE_REASONS['project-out-of-scope'].code);
    }
    expect(credentialRowsOf('server-agent'), 'a refused root minted a credential').toHaveLength(
      serverAgentRowsBefore,
    );

    // A folder no live connection announces is out of scope …
    const projectC = (await harness.copyFixtureProject()).root;
    expectRefusal(
      await fetchRaw('session.create', { body: { projectRoot: projectC, question: QUESTION } }),
      'project-out-of-scope',
      'session.create before the folder is announced',
    );

    // … until an editor connection announces it in its hello …
    const announcing = await harness.ws({ client: 'vscode', projectRoot: projectC });
    expect(announcing.authenticated).toBe(true);
    const launched = await harness.launchDevServer(projectC);
    expect(isErr(launched)).toBe(false);
    const created = await harness.createSession({ projectRoot: projectC, question: QUESTION });
    expect(created.projectRoot).toBe(projectC);

    // … for as long as that connection lives, and for the offline-grace lease
    // once it drops: VS Code's deactivate() ends its sessions over HTTP after
    // its socket has gone, and that request must still reach its own project …
    const closesBefore = harness.logger.withMessage(CONNECTION_CLOSED_LOG).length;
    await announcing.close();
    await waitUntil(
      () =>
        harness.logger.withMessage(CONNECTION_CLOSED_LOG).length > closesBefore ? true : undefined,
      'the service has processed the editor socket close',
    );
    requireClock().advance(DEFAULT_OFFLINE_GRACE_MS / 2);
    expectSuccess(await fetchRaw(targetFor('session.get', created.id)), 'session.get');
    expectSuccess(
      await fetchRaw(targetFor('session.end', created.id), { body: {} }),
      'session.end',
    );

    // … and no longer: once the lease has passed, the folder is out of scope.
    requireClock().advance(DEFAULT_OFFLINE_GRACE_MS);
    expectRefusal(
      await fetchRaw(targetFor('session.get', created.id)),
      'project-out-of-scope',
      'session.get after the lease of the closed connection passed',
    );
    expectRefusal(
      await fetchRaw('session.create', { body: { projectRoot: projectC, question: QUESTION } }),
      'project-out-of-scope',
      'session.create after the lease of the closed connection passed',
    );
  });

  it('refuses a root that a link inside an announced folder carries out of it', async () => {
    // A fresh copy announced by its own editor connection, so no pipeline of
    // this suite ever walks the link. The link's target is a sibling of the
    // copy inside its own temporary container: outside the workspace, and
    // removed with the copy at teardown.
    const copy = await harness.copyFixtureProject();
    const workspace = copy.root;
    const outside = join(copy.container, 'private');
    const escape = join(workspace, 'external');
    await mkdir(join(outside, 'app'), { recursive: true });
    await symlink(outside, escape, 'dir');

    const announcing = await harness.ws({ client: 'vscode', projectRoot: workspace });
    try {
      expect(announcing.authenticated).toBe(true);
      // The workspace itself is in scope, so each refusal below is the link's.
      await mintDevServerCredential(workspace);

      const serverAgentRowsBefore = credentialRowsOf('server-agent').length;
      for (const projectRoot of [escape, join(escape, 'app'), join(escape, 'not-created-yet')]) {
        expectRefusal(
          await fetchRaw('session.create', { body: { projectRoot, question: QUESTION } }),
          'project-out-of-scope',
          'session.create through a link out of the announced workspace',
        );
        expectRefusal(
          await fetchRaw('devServer.credential', { body: { projectRoot } }),
          'project-out-of-scope',
          'a dev-server credential through a link out of the announced workspace',
        );
      }
      expect(credentialRowsOf('server-agent'), 'a refused root minted a credential').toHaveLength(
        serverAgentRowsBefore,
      );
    } finally {
      await announcing.close();
      await rm(escape, { force: true });
    }
  });

  it('checks source.open against the stored project root of the session bound to the tab', async () => {
    const opener = await bindDevtools(TABS.opener, sessionA);
    const editorA = await harness.editor(projectA);
    const editorB = await harness.editor(projectB);
    const markA = editorA.received.length;
    const markB = editorB.received.length;

    // A file of the other project, requested through the other project's session.
    const viaOtherSession = opener.client.send('source.open', {
      sessionId: sessionB.id,
      location: locationOf(PROJECT_FILE),
    });
    // The same file, reached by climbing out of the bound session's project root.
    const climbingOut = opener.client.send('source.open', {
      sessionId: sessionA.id,
      location: locationOf(relative(projectA, join(projectB, PROJECT_FILE))),
    });
    expect(await opener.client.flush()).toBe(true);
    expect(codesOf(opener.client.errorsFor(viaOtherSession.id))).toEqual([
      AUTH_FAILURE_REASONS['session-not-bound'].code,
    ]);
    expect(opener.client.errorsFor(climbingOut.id)).toHaveLength(1);
    expect(sourceOpensSince(editorA, markA)).toEqual([]);
    expect(sourceOpensSince(editorB, markB)).toEqual([]);

    // Inside the stored root, the location is forwarded to that session's editor only.
    const inside = opener.client.send('source.open', {
      sessionId: sessionA.id,
      location: locationOf(PROJECT_FILE),
    });
    await waitFor(
      editorA,
      'source.open',
      (message, index) => index >= markA && message.payload.sessionId === sessionA.id,
    );
    expect(opener.client.errorsFor(inside.id)).toEqual([]);
    expect(sourceOpensSince(editorB, markB)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The project root, re-proved where it is acted on
 * ---------------------------------------------------------------------------------------------- */

/**
 * The refusal of a root that is still in scope but no longer resolves to the
 * directory it was admitted as: `reconfirmProjectRoot`'s and
 * `reconfirmRootIdentity`'s constant sentence in `src/server/auth.ts`.
 */
const PROJECT_ROOT_MOVED_MESSAGE =
  'The project root no longer resolves to the directory it was admitted as.';

/** The warn record the launcher writes when a launch's confirmation refuses its root. */
const LAUNCH_ROOT_UNCONFIRMED_LOG =
  'The project root was not confirmed; no dev server was launched';

/** The warn record the instrumentation service writes when an install's confirmation refuses its root. */
const INSTALL_ROOT_UNCONFIRMED_LOG =
  'The project root was not confirmed; no instrumentation was installed';

/**
 * The info record an earlier session manager wrote when it identified, at a
 * session's first sink, a root no admission proof was handed over for. The
 * manager now refuses such a sink instead (fail closed) and never writes it,
 * so a session created over HTTP must never produce it.
 */
const ROOT_IDENTIFIED_WITHOUT_PROOF_LOG =
  'the project root identity was established for a session this process did not admit';

/**
 * A fresh fixture copy reached through a symbolic link beside it. The editor
 * announces and names the link, as a workspace opened through a link is, so
 * the link can later be pointed at another directory without leaving the
 * announced folder: scope alone would still admit it, and only the identity
 * the root was admitted under tells the two directories apart.
 */
interface LinkedProject {
  /** The link the editor announces and every request names. */
  readonly link: string;
  /** The fixture copy the link points at when the suite admits it. */
  readonly root: string;
  /** That copy's canonical path, by the native resolver the service uses. */
  readonly canonicalRoot: string;
}

/**
 * Copies the fixture and links it from inside the copy's own temporary
 * container, so the harness removes the link with the copy.
 */
async function linkedProject(): Promise<LinkedProject> {
  const copy = await harness.copyFixtureProject();
  const link = join(copy.container, 'linked-project');
  await symlink(copy.root, link, 'dir');
  return { link, root: copy.root, canonicalRoot: await realpath(copy.root) };
}

/** Points `link` at `target`: the relink any process that can write beside the project can make. */
async function relink(link: string, target: string): Promise<void> {
  await rm(link, { force: true });
  await symlink(target, link, 'dir');
}

/** Starts a TCP listener on an ephemeral loopback port and answers its address. */
async function listenOnLoopback(server: TcpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The loopback listener has no TCP address.');
  }
  return address.port;
}

/** The dev-server address the restart case's sessions record; nothing listens on it. */
const RESTART_DEV_SERVER_URL = 'http://127.0.0.1:3000';

/**
 * Starts a standalone service over `stateRoot` on an ephemeral port, with the
 * real clock: the process the restart case stops and starts again over one
 * `$DEBUGGEN_HOME`, as `producer-replay.test.ts` does. Separate from the
 * file's harness, whose service keeps running throughout.
 */
async function startStandaloneService(stateRoot: string): Promise<ServiceHandle> {
  const started = await startService({
    env: { DEBUGGEN_PROVIDER: 'deterministic' },
    overrides: { debuggenHome: stateRoot, port: 0, logLevel: 'silent' },
  });
  if (isErr(started)) {
    throw new Error(`startService failed: ${started.error.code}: ${started.error.message}`);
  }
  return started.value;
}

describe('the project root, re-proved where it is acted on (CWE-367)', () => {
  it('refuses a launch whose root is relinked while the launcher reads the project, and spawns nothing', async () => {
    const project = await linkedProject();
    const elsewhere = await harness.copyFixtureProject();
    const announcing = await harness.ws({ client: 'vscode', projectRoot: project.link });

    // An address that never answers. The launcher's detection probes the
    // requested address before it resolves the command, mints the child's
    // credential and spawns; while that probe waits, the link is pointed at
    // another copy of the project — the window between the route's checks and
    // the spawn that a link swap would otherwise use.
    let probes = 0;
    const silent = createTcpServer((socket) => {
      probes += 1;
      void relink(project.link, elsewhere.root).finally(() => {
        socket.destroy();
      });
    });
    const port = await listenOnLoopback(silent);
    try {
      expect(announcing.authenticated).toBe(true);
      const agentCredentialsBefore = digestsOf(credentialRowsOf('server-agent')).sort();
      const unconfirmedBefore = harness.logger.withMessage(LAUNCH_ROOT_UNCONFIRMED_LOG).length;

      const refusal = expectRefusal(
        await fetchRaw('devServer.launch', {
          body: {
            projectRoot: project.link,
            command: standInDevServerCommand(),
            devServerUrl: `http://127.0.0.1:${String(port)}/`,
          },
        }),
        'project-out-of-scope',
        'a launch whose root was relinked while it was under way',
      );
      expect(refusal.message).toBe(PROJECT_ROOT_MOVED_MESSAGE);
      expect(probes, 'the launcher probed the requested address').toBeGreaterThan(0);

      // Refused by the launcher's last confirmation, immediately before the
      // spawn: the credential minted for the child is revoked again, and no
      // child was ever registered for the project.
      const unconfirmed = harness.logger
        .withMessage(LAUNCH_ROOT_UNCONFIRMED_LOG)
        .slice(unconfirmedBefore);
      expect(unconfirmed.map((record) => record.fields['stage'])).toEqual(['before-spawn']);
      expect(digestsOf(credentialRowsOf('server-agent')).sort()).toEqual(agentCredentialsBefore);
      const stopped = await fetchRaw('devServer.stop', { body: { projectRoot: project.link } });
      expectSuccess(stopped, 'devServer.stop');
      expect(stopped.json).toStrictEqual({ stopped: false });
    } finally {
      await new Promise<void>((resolve) => {
        silent.close(() => {
          resolve();
        });
      });
      await announcing.close();
    }
  });

  it('holds a session created through a link to the directory it was admitted as, and refuses the root once relinked', async () => {
    const project = await linkedProject();
    const elsewhere = await harness.copyFixtureProject();
    const identifiedBefore = harness.logger.withMessage(ROOT_IDENTIFIED_WITHOUT_PROOF_LOG).length;

    // Launched through the link: admitted, confirmed before detection and
    // before the spawn, and spawned — the checks refuse nothing that did not move.
    const launched = await harness.launchDevServer(project.link);
    expect(isErr(launched), 'the launch through an unmoved link').toBe(false);
    const session = await harness.createSession({ projectRoot: project.link, question: QUESTION });

    // The session keeps the root as the editor spells it, while the canonical
    // directory it was admitted as travels with it from the create request —
    // handed over, not identified afterwards by the first sink.
    expect(session.projectRoot).toBe(project.link);
    const admitted = harness.manager.confirmProjectRoot(session.id);
    if (isErr(admitted)) {
      throw new Error(`The admitted root was refused (${admitted.error.code}).`);
    }
    expect(admitted.value).toStrictEqual({
      projectRoot: project.link,
      canonicalRoot: project.canonicalRoot,
    });

    // The pipeline indexed and installed in that directory: both sinks confirmed
    // it and the session reached the readiness gate.
    const settled = await harness.waitForSession(session.id, (record) =>
      ['instrumenting', 'ready', 'failed'].includes(record.status),
    );
    expect(settled.status, 'the pipeline ran through its confirmed sinks').not.toBe('failed');
    expect(harness.logger.withMessage(ROOT_IDENTIFIED_WITHOUT_PROOF_LOG)).toHaveLength(
      identifiedBefore,
    );

    await relink(project.link, elsewhere.root);
    try {
      // The link still names the announced folder, so scope alone admits the
      // session's requests …
      expectSuccess(await fetchRaw(targetFor('session.get', session.id)), 'session.get');
      // … but the root is no longer the directory the session was admitted
      // as, so every sink that would act on it is refused.
      const moved = harness.manager.confirmProjectRoot(session.id);
      if (!isErr(moved)) {
        throw new Error('A relinked project root was confirmed for a sink.');
      }
      expect(moved.error.code).toBe(AUTH_FAILURE_REASONS['project-out-of-scope'].code);
      expect(moved.error.message).toBe(PROJECT_ROOT_MOVED_MESSAGE);
    } finally {
      // Pointed back before the session ends, so cleanup restores the
      // directory that was instrumented.
      await relink(project.link, project.root);
    }
    expectSuccess(
      await fetchRaw(targetFor('session.end', session.id), { body: {} }),
      'session.end',
    );
  });

  it('fails a session whose root is relinked while its pipeline plans, at the install, and writes to neither directory', async () => {
    const project = await linkedProject();
    const elsewhere = await harness.copyFixtureProject();
    const launched = await harness.launchDevServer(project.link);
    expect(isErr(launched), 'the launch through an unmoved link').toBe(false);
    const admittedBefore = await snapshotTree(project.root);
    const elsewhereBefore = await snapshotTree(elsewhere.root);
    const refusedBefore = harness.logger.withMessage(INSTALL_ROOT_UNCONFIRMED_LOG).length;

    // The pipeline indexes the directory the session was admitted as, then
    // waits at the gate in its plan stage — before anything is installed. The
    // link is pointed at another copy of the project there: still inside the
    // announced folder, so only the admitted identity tells the two apart.
    let session: SessionRecord;
    planGate.hold();
    try {
      session = await harness.createSession({ projectRoot: project.link, question: QUESTION });
      const planning = session.id;
      await waitUntil(
        () => (planGate.held().some((call) => call.sessionId === planning) ? true : undefined),
        'the session’s plan-stage call reached the gate',
        HARNESS_TIMEOUTS.pipeline,
      );
      await relink(project.link, elsewhere.root);
    } finally {
      planGate.release();
    }

    // The install re-proves the root before its first act on it, and the
    // session fails at the instrument stage with the manager's refusal: a
    // stage-failure row, the only kind whose detail carries an error code. An
    // install that went ahead instead reports each signal as an instrument-stage
    // row — `done`, or `failed` without an error code for a signal that is
    // unavailable with no bound tab — so the wait ends on either outcome.
    const created = session.id;
    const movedCode = `error code: ${AUTH_FAILURE_REASONS['project-out-of-scope'].code}`;
    const progressRowsOf = (): readonly ProgressEntry[] => {
      const listed = harness.repos.sessions.listProgress(created);
      if (isErr(listed)) {
        throw new Error(`listProgress failed (${listed.error.code})`);
      }
      return listed.value;
    };
    const detailOf = (entry: ProgressEntry): string => JSON.stringify(entry.detail ?? '');
    const outcome = await waitUntil(
      () => {
        const rows = progressRowsOf();
        if (
          rows.some((entry) => entry.status === 'failed' && detailOf(entry).includes(movedCode))
        ) {
          return 'refused';
        }
        const installed = rows.some(
          (entry) =>
            entry.stage === 'instrument' &&
            (entry.status === 'done' ||
              (entry.status === 'failed' && !detailOf(entry).includes('error code:'))),
        );
        return installed ? 'installed' : undefined;
      },
      'the install settled',
      HARNESS_TIMEOUTS.pipeline,
    );
    expect(outcome, 'the install of a session whose root was relinked').toBe('refused');
    const settled = await harness.waitForSession(created, (record) => record.status === 'failed');
    expect(settled.status).toBe('failed');
    const failedRows = progressRowsOf().filter((entry) => entry.status === 'failed');
    expect(new Set(failedRows.map((entry) => entry.stage))).toEqual(new Set(['instrument']));
    expect(failedRows.every((entry) => detailOf(entry).includes(movedCode))).toBe(true);
    const refused = harness.logger.withMessage(INSTALL_ROOT_UNCONFIRMED_LOG).slice(refusedBefore);
    expect(refused.map((record) => record.fields['stage'])).toEqual(['before-state-root-check']);
    expect(refused.map((record) => record.fields['code'])).toEqual([
      AUTH_FAILURE_REASONS['project-out-of-scope'].code,
    ]);

    // Nothing was journaled, and neither directory was written: not the one
    // the session was admitted as, nor the one the link leads to now.
    const journaled = await harness.repos.modifications.listBySession(session.id);
    if (isErr(journaled)) {
      throw new Error(`listBySession failed (${journaled.error.code})`);
    }
    expect(journaled.value).toEqual([]);
    await assertTreeUnchanged(project.root, admittedBefore);
    await assertTreeUnchanged(elsewhere.root, elsewhereBefore);

    await relink(project.link, project.root);
    expectSuccess(
      await fetchRaw(targetFor('session.end', session.id), { body: {} }),
      'session.end',
    );
  });

  it('holds a session to the identity stored with it across a restart, and refuses a root relinked while the service was down', async () => {
    const container = await mkdtemp(join(await realpath(tmpdir()), 'debuggen-auth-restart-'));
    const running: ServiceHandle[] = [];
    try {
      const stateRoot = join(container, 'home');
      const project = join(container, 'project');
      const elsewhere = join(container, 'elsewhere');
      await mkdir(project);
      await mkdir(elsewhere);
      const canonicalProject = await realpath(project);
      // Two links to one project: one stays put across the restart, the other
      // is relinked while no service is running to see it.
      const steady = join(container, 'linked-steady');
      const relinked = join(container, 'linked-relinked');
      await symlink(project, steady, 'dir');
      await symlink(project, relinked, 'dir');

      // The first process stores both sessions with the proof the create
      // route hands over: the link's identity, taken where it leads now.
      const first = await startStandaloneService(stateRoot);
      running.push(first);
      const createThrough = async (link: string): Promise<SessionRecord> => {
        const admitted = identifyProjectRoot(link);
        if (isErr(admitted)) {
          throw new Error(`The linked project could not be identified (${admitted.error.code}).`);
        }
        const created = await first.manager.create({
          projectRoot: link,
          question: QUESTION,
          devServerUrl: RESTART_DEV_SERVER_URL,
          admittedRoot: admitted.value,
        });
        if (isErr(created)) {
          throw new Error(`The session was refused (${created.error.code}).`);
        }
        return created.value;
      };
      const steadySession = await createThrough(steady);
      const relinkedSession = await createThrough(relinked);

      // Stopped as a killed process leaves it: `retain` keeps both sessions
      // live for the next start. The link is pointed elsewhere while down.
      running.splice(running.indexOf(first), 1);
      await first.close({ liveSessions: 'retain' });
      await relink(relinked, elsewhere);

      const second = await startStandaloneService(stateRoot);
      running.push(second);
      const stored = createSessionsRepo({ store: second.store });

      // Unmoved: confirmed as the canonical path stored with the session.
      const confirmed = second.manager.confirmProjectRoot(steadySession.id);
      if (isErr(confirmed)) {
        throw new Error(`An unmoved root was refused after the restart (${confirmed.error.code}).`);
      }
      expect(confirmed.value).toStrictEqual({
        projectRoot: steady,
        canonicalRoot: canonicalProject,
      });
      const steadyIdentity = stored.getRootIdentity(steadySession.id);
      expect(isErr(steadyIdentity) ? steadyIdentity.error.code : steadyIdentity.value).toBe(
        canonicalProject,
      );

      // Relinked while the service was down: the restarted process holds the
      // session to the stored identity, not to where the link leads now.
      const moved = second.manager.confirmProjectRoot(relinkedSession.id);
      if (!isErr(moved)) {
        throw new Error('A root relinked while the service was down was confirmed for a sink.');
      }
      expect(moved.error.code).toBe(AUTH_FAILURE_REASONS['project-out-of-scope'].code);
      expect(moved.error.message).toBe(PROJECT_ROOT_MOVED_MESSAGE);
      const relinkedIdentity = stored.getRootIdentity(relinkedSession.id);
      expect(isErr(relinkedIdentity) ? relinkedIdentity.error.code : relinkedIdentity.value).toBe(
        canonicalProject,
      );

      // Relinked after the restart, the unmoved session is refused the same way.
      await relink(steady, elsewhere);
      const movedLater = second.manager.confirmProjectRoot(steadySession.id);
      if (!isErr(movedLater)) {
        throw new Error('A root relinked after the restart was confirmed for a sink.');
      }
      expect(movedLater.error.message).toBe(PROJECT_ROOT_MOVED_MESSAGE);
    } finally {
      for (const handle of running.splice(0)) {
        await handle.close();
      }
      await rm(container, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Retention on request
 * ---------------------------------------------------------------------------------------------- */

/** The record the sessions module writes once per answered `POST /sessions/purge`. */
const PURGE_REQUEST_LOG = 'Ran the retention sweep on request';

/** The record the retention sweep itself writes once per run. */
const RETENTION_SWEEP_LOG = 'retention sweep finished';

/** How many purge requests the single-flight check sends at once. */
const CONCURRENT_PURGES = 4;

/** One day of the retention window, in the milliseconds the sweep's cutoff is measured in. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every session the editor sees, sorted by id: a purge must leave the set
 * unchanged, while the list's own order follows `updatedAt`, which a pipeline
 * still settling may move.
 */
async function heldSessionIds(): Promise<readonly string[]> {
  return [...(await listSessionIds())].sort();
}

/** The records with `message` the service's logger wrote after `mark` records. */
function logsSince(mark: number, message: string): readonly CapturedLogRecord[] {
  return harness.logger.records.slice(mark).filter((record) => record.message === message);
}

/**
 * Parses a purge reply with the route table's own response schema, after the
 * shared success checks, and proves the conflict list is the bounded,
 * de-duplicated one protocol promises.
 */
function purgeReportOf(response: RawFetchResponse): SessionPurgeResponse {
  expectSuccess(response, 'session.purge');
  expect(response.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
  const parsed = HTTP_ROUTES['session.purge'].response.safeParse(response.json);
  if (!parsed.success) {
    throw new Error('The purge reply does not satisfy its schema.');
  }
  const report = parsed.data;
  expect(report.sessionsRetainedForConflicts).toHaveLength(
    Math.min(report.sessionsRetainedForConflictsTotal, SESSION_PURGE_MAX_REPORTED_SESSIONS),
  );
  expect(new Set(report.sessionsRetainedForConflicts).size).toBe(
    report.sessionsRetainedForConflicts.length,
  );
  return report;
}

/** The counts of everything a purge deletes along with an aged session. */
function sessionContentDeleted(report: SessionPurgeResponse): Readonly<Record<string, number>> {
  return {
    sessionsDeleted: report.sessionsDeleted,
    telemetryEventsDeleted: report.telemetryEventsDeleted,
    panelsDeleted: report.panelsDeleted,
    analysesDeleted: report.analysesDeleted,
    modificationsDeleted: report.modificationsDeleted,
    backupDirsDeleted: report.backupDirsDeleted,
  };
}

/** What {@link sessionContentDeleted} reads when a purge found nothing aged. */
const NOTHING_DELETED = Object.freeze({
  sessionsDeleted: 0,
  telemetryEventsDeleted: 0,
  panelsDeleted: 0,
  analysesDeleted: 0,
  modificationsDeleted: 0,
  backupDirsDeleted: 0,
});

describe('retention on request', () => {
  it('runs the retention sweep for the editor and deletes nothing inside the retention window', async () => {
    const before = await heldSessionIds();
    const windowMs = harness.config.retentionDays * MS_PER_DAY;
    const logMark = harness.logger.records.length;
    const startedAt = harness.now();

    // No body at all reads as the empty request the row declares.
    const response = await fetchRaw('session.purge');
    const endedAt = harness.now();
    const report = purgeReportOf(response);

    // The cutoff is the configured window measured back from the service's clock …
    expect(report.cutoff).toBeGreaterThanOrEqual(startedAt - windowMs);
    expect(report.cutoff).toBeLessThanOrEqual(endedAt - windowMs);
    // … and every session this suite holds is newer than it, so each one survived.
    expect(sessionContentDeleted(report)).toEqual(NOTHING_DELETED);
    expect(await heldSessionIds()).toEqual(before);
    // The reply is counts and session ids: it names no path on this machine.
    for (const fact of [harness.home, projectA, projectB]) {
      expect(response.text.includes(fact), 'the purge reply names local state').toBe(false);
    }

    // One request ran exactly one sweep of its own.
    const answered = logsSince(logMark, PURGE_REQUEST_LOG);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.fields['joinedRunningSweep']).toBe(false);
    expect(logsSince(logMark, RETENTION_SWEEP_LOG)).toHaveLength(1);
  });

  it('answers concurrent purge requests from one running sweep instead of starting one each', async () => {
    const before = await heldSessionIds();
    const logMark = harness.logger.records.length;

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_PURGES }, () => fetchRaw('session.purge', { body: {} })),
    );
    for (const response of responses) {
      expect(sessionContentDeleted(purgeReportOf(response))).toEqual(NOTHING_DELETED);
    }

    // Every request is answered and says whether it joined a sweep already
    // running. Only the ones that did not started a sweep, so the sweeps run
    // are exactly the requests that ran their own: a joiner never starts another.
    const answered = logsSince(logMark, PURGE_REQUEST_LOG);
    expect(answered).toHaveLength(CONCURRENT_PURGES);
    const joined = answered.map((record) => record.fields['joinedRunningSweep']);
    for (const flag of joined) {
      expect(typeof flag).toBe('boolean');
    }
    const ranOwn = joined.filter((flag) => flag === false).length;
    expect(ranOwn).toBeGreaterThanOrEqual(1);
    expect(logsSince(logMark, RETENTION_SWEEP_LOG)).toHaveLength(ranOwn);
    expect(await heldSessionIds()).toEqual(before);
  });

  it('refuses a purge from every credential but the editor’s, and any body with content, before a sweep runs', async () => {
    const devtools = harness.issueDevtoolsCredential();
    track('devtools credential', devtools.token);
    const serverAgent = harness.issueServerAgentCredential(projectA);
    track('server-agent credential', serverAgent.token);
    const before = await heldSessionIds();
    const logMark = harness.logger.records.length;

    expectRefusal(
      await fetchRaw('session.purge', { ...presenting(devtools), body: {} }),
      'role-not-permitted',
      'devtools → session.purge',
    );
    expectRefusal(
      await fetchRaw('session.purge', { token: serverAgent.token, body: {} }),
      'role-not-permitted',
      'server-agent → session.purge',
    );
    // The operation has no parameters: a body naming a window or a session is refused whole.
    for (const body of [{ retentionDays: 0 }, { sessionIds: [sessionA.id] }, 'not json']) {
      const response = await fetchRaw('session.purge', { body });
      expect(response.status, 'a purge body with content').toBe(INVALID_BODY_STATUS);
      expect(refusalShape(response).code).toBe(INVALID_BODY_CODE);
    }

    expect(logsSince(logMark, PURGE_REQUEST_LOG)).toEqual([]);
    expect(logsSince(logMark, RETENTION_SWEEP_LOG)).toEqual([]);
    expect(await heldSessionIds()).toEqual(before);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Rotation and revocation
 * ---------------------------------------------------------------------------------------------- */

describe('rotation and revocation', () => {
  it('rotates nothing for another role, or for a body that is not the empty request the row declares', async () => {
    const devtools = harness.issueDevtoolsCredential();
    track('devtools credential', devtools.token);
    const serverAgent = harness.issueServerAgentCredential(projectA);
    track('server-agent credential', serverAgent.token);
    const digestsBefore = storedDigests();
    const authFileBefore = await sha256OfFile(harness.config.authFilePath);

    // Only the editor may rotate; the role is judged before a body is read.
    expectRefusal(
      await fetchRaw('credentials.rotate', { ...presenting(devtools), body: {} }),
      'role-not-permitted',
      'devtools → credentials.rotate',
    );
    expectRefusal(
      await fetchRaw('credentials.rotate', { token: serverAgent.token, body: {} }),
      'role-not-permitted',
      'server-agent → credentials.rotate',
    );
    // The editor's request must be exactly `{}`: an absent, extended or
    // unparseable body is refused, so no stray request rotates by accident.
    for (const body of [undefined, { force: true }, 'not json']) {
      const response = await fetchRaw('credentials.rotate', { body });
      expect(response.status, 'a rotation body that is not {}').toBe(INVALID_BODY_STATUS);
      expect(refusalShape(response).code).toBe(INVALID_BODY_CODE);
    }

    // Every credential, auth.json and the editor's access are as they were.
    expect(storedDigests()).toEqual(digestsBefore);
    expect(await sha256OfFile(harness.config.authFilePath)).toBe(authFileBefore);
    expectSuccess(await fetchRaw('session.list'), 'session.list');
  });

  it('revokes every credential through POST /credentials/rotate, closes every socket with WS_CLOSE_UNAUTHORIZED and regenerates auth.json', async () => {
    // What a running system holds when the developer rotates: an editor HTTP
    // client, the editor's socket, a paired DevTools socket, a dev server's
    // socket and credentials, an editor socket that is not a harness client at
    // all, and a pairing code nobody has redeemed yet.
    const oldEditorToken = harness.editorToken;
    const editorHttp = harness.http();
    const editorSocket = await harness.editor(projectA);
    const paired = await pairExtension();
    const devtools = await harness.connectDevtools({ tabId: TABS.rotation, credential: paired });
    const serverAgent = harness.issueServerAgentCredential(projectA);
    track('server-agent credential', serverAgent.token);
    const serverAgentSocket = await harness.ws({
      client: 'server-agent',
      projectRoot: projectA,
      token: serverAgent.token,
    });
    const devServerToken = await mintDevServerCredential(projectA);
    const rawEditor = await openRegisteredEditor(oldEditorToken);
    const outstandingCode = track('pairing code', harness.startPairing().code);

    // The dev servers the launcher started hold server-agent credentials of their own.
    const issuedHere = new Set([sha256Hex(serverAgent.token), sha256Hex(devServerToken)]);
    const launched = digestsOf(credentialRowsOf('server-agent')).filter(
      (digest) => !issuedHere.has(digest),
    );
    expect(launched.length, 'credentials held by launched dev servers').toBeGreaterThan(0);

    const held: readonly HarnessWsClient[] = [editorSocket, devtools.client, serverAgentSocket];
    for (const client of held) {
      expect(client.authenticated, client.describe()).toBe(true);
    }
    const closesBefore = held.map((client) => client.closes.length);
    const rowsBefore = readRows(SELECT_CREDENTIALS).length;
    const authFileBefore = await sha256OfFile(harness.config.authFilePath);
    await assertNoPlaintextAtRest();

    // The editor asks, as `debuggen.rotateServiceToken` does. The service closes
    // every socket (this caller's own editor socket included) before it
    // answers; the answer still arrives, on this request's own HTTP connection.
    const rotation = await fetchRaw('credentials.rotate', { body: {} });
    expectSuccess(rotation, 'credentials.rotate');
    expect(rotation.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
    const parsedOutcome = HTTP_ROUTES['credentials.rotate'].response.safeParse(rotation.json);
    if (!parsedOutcome.success) {
      throw new Error('The rotation reply does not satisfy its schema.');
    }
    const outcome = parsedOutcome.data;
    expect(outcome.credentialsDeleted).toBe(rowsBefore);
    expect(outcome.socketsClosed).toBeGreaterThanOrEqual(held.length + 1);

    // Every open socket is closed with the credential-refusal code.
    for (const [index, client] of held.entries()) {
      const record = await client.waitForClose(HARNESS_TIMEOUTS.message, closesBefore[index]);
      expect(record.code, client.describe()).toBe(WS_CLOSE_UNAUTHORIZED);
    }
    expect((await rawEditor.waitForClose()).code).toBe(WS_CLOSE_UNAUTHORIZED);

    // Every previously issued credential is refused, on either transport.
    expectRefusal(
      await fetchRaw('session.list', { token: oldEditorToken }),
      'unknown-credential',
      'the retired editor credential',
    );
    const viaClient = await editorHttp.request('session.list');
    if (!isErr(viaClient)) {
      throw new Error('An HTTP client holding the retired editor credential was still answered.');
    }
    expect(viaClient.error.code).toBe(AUTH_FAILURE_REASONS['unknown-credential'].code);
    await expectHelloRefused(hello('vscode', oldEditorToken, { projectRoot: projectA }));
    expectRefusal(
      await fetchRaw(targetFor('session.get', sessionA.id), presenting(paired)),
      'unknown-credential',
      'the retired DevTools credential',
    );
    await expectHelloRefused(
      hello('devtools', paired.token, { tabId: TABS.rotation }),
      paired.origin,
    );
    for (const token of [serverAgent.token, devServerToken]) {
      expectRefusal(
        await ingest(token, projectA),
        'unknown-credential',
        'a retired server-agent credential',
      );
    }
    await expectHelloRefused(hello('server-agent', serverAgent.token, { projectRoot: projectA }));

    // The launched dev servers' credentials went with the rest, and so did the outstanding code.
    const remaining = storedDigests();
    for (const digest of launched) {
      expect(remaining.has(digest), 'a launched dev server credential survived').toBe(false);
    }
    expect(credentialRowsOf('server-agent')).toEqual([]);
    expectRefusal(
      await redeem(outstandingCode, chromeExtensionOrigin(newExtensionId())),
      'pairing-invalid',
      'a code issued before the rotation',
    );

    // auth.json was regenerated, privately, with a different credential.
    const authFile = await stat(harness.config.authFilePath);
    expect(authFile.mode & PERMISSION_BITS).toBe(SECURE_FILE_MODE);
    expect(await sha256OfFile(harness.config.authFilePath)).not.toBe(authFileBefore);
    // The journal that staged the new credential was removed once auth.json was published.
    await expect(
      stat(`${harness.config.authFilePath}${AUTH_FILE_STAGE_SUFFIX}`),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // The new credential reaches the editor only through that file, never through the reply.
    const newEditorToken = track('editor credential', harness.refreshEditorToken());
    expect(sha256Hex(newEditorToken)).not.toBe(sha256Hex(oldEditorToken));
    expect(remaining.has(sha256Hex(newEditorToken))).toBe(true);
    expect(leaksIn(rotation.text), 'the rotation reply carries a credential').toEqual([]);

    // No workspace lease survives the rotation: until a folder is announced
    // again, the new credential reaches no project a revoked socket announced.
    for (const session of [sessionA, sessionB]) {
      expectRefusal(
        await fetchRaw(targetFor('session.get', session.id), { token: newEditorToken }),
        'project-out-of-scope',
        'a folder only a revoked editor socket announced',
      );
    }

    // The re-read editor credential works, once its folder is announced again.
    expectSuccess(await fetchRaw('session.list', { token: newEditorToken }), 'session.list');
    const reannounced = await harness.editor(projectA);
    expect(reannounced.authenticated).toBe(true);
    expectSuccess(await fetchRaw(targetFor('session.get', sessionA.id)), 'session.get');

    // The paired extension must pair again; its new credential works.
    expect(credentialRowsOf('devtools')).toEqual([]);
    const repaired = await pairExtension(paired.extensionId);
    const reconnected = await harness.connectDevtools({
      tabId: TABS.repaired,
      credential: repaired,
    });
    expect(reconnected.client.authenticated).toBe(true);

    // What is left is exactly the new editor credential and the re-paired extension.
    expect(storedDigests()).toEqual(
      new Set([sha256Hex(newEditorToken), sha256Hex(repaired.token)]),
    );
  });

  it('never holds a plaintext credential at rest or in a log record', async () => {
    expect(secrets.size).toBeGreaterThan(0);
    await assertNoPlaintextAtRest();
    assertNothingLogged();
  });
});

/* -------------------------------------------------------------------------------------------------
 * Releasing a dev-server credential
 * ---------------------------------------------------------------------------------------------- */

/**
 * The record the launcher writes when a `devServer.credential` lease it
 * supervises is revoked at its holder's request.
 */
const CLI_LEASE_RELEASED_LOG =
  "The server-agent credential of a dev server started outside the service is revoked at its holder's request";

/**
 * The record the launcher writes when a release reached the access boundary's
 * own `releaseServerAgentCredential` — a token it does not supervise — and
 * that revoked one.
 */
const UNSUPERVISED_RELEASED_LOG = "Released a server-agent credential at its holder's request";

/** The record the access boundary writes for every server-agent credential it revokes. */
const SERVER_AGENT_REVOKED_LOG = 'revoked a server-agent credential';

/**
 * The record the launcher writes when the holder of a `devServer.credential`
 * lease it supervises released it, but the revocation removed nothing — a
 * rotation had already deleted the credential, or its lease had lapsed — so
 * the release answered `released: false`.
 */
const CLI_LEASE_NOT_LIVE_LOG =
  'The server-agent credential of a dev server started outside the service was no longer live when its holder released it; its supervision is over';

/**
 * The records a release that got past the revocation fence writes for what it
 * found — a supervised lease, live or not, a launched child's own credential,
 * a credential the access boundary released, or none it may release — so
 * their absence proves the fence refused it first.
 */
const RELEASE_ACTION_LOGS: readonly string[] = [
  CLI_LEASE_RELEASED_LOG,
  CLI_LEASE_NOT_LIVE_LOG,
  "A credential release named a launched dev server's own credential; it is left to that dev server's stop",
  UNSUPERVISED_RELEASED_LOG,
  "released a server-agent credential at its holder's request",
  'a server-agent credential release found no releasable credential',
];

/**
 * The records with any of the {@link RELEASE_ACTION_LOGS} messages the
 * service's logger wrote after `mark` records.
 */
function releaseActionsSince(mark: number): readonly CapturedLogRecord[] {
  return harness.logger.records
    .slice(mark)
    .filter((record) => RELEASE_ACTION_LOGS.includes(record.message));
}

/** How many rows the whole `telemetry_events` table holds, across every session. */
function telemetryRowCount(): number {
  const count = readRows('SELECT COUNT(*) AS count FROM telemetry_events')[0]?.['count'];
  if (typeof count !== 'number') {
    throw new Error('The telemetry_events row count could not be read.');
  }
  return count;
}

/**
 * The `released` flag of a successful `POST /credentials/release` reply,
 * after the shared success checks: the route's own strict response schema,
 * `Cache-Control: no-store`, and nothing but that one flag in the body.
 */
function releasedFlagOf(response: RawFetchResponse): boolean {
  expectSuccess(response, 'credentials.release');
  expect(response.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
  expect(bodyKeys(response)).toEqual(['released']);
  const parsed = HTTP_ROUTES['credentials.release'].response.safeParse(response.json);
  if (!parsed.success) {
    throw new Error('The credential release reply does not satisfy its schema.');
  }
  return parsed.data.released;
}

/**
 * How long the stand-in for a launched child's lease that the release suite
 * issues stays valid: long enough to outlast the test on the harness clock,
 * which moves only as the service reads it.
 */
const STAND_IN_LEASE_MS = 60_000;

describe('releasing a dev-server credential', () => {
  it('revokes a dev-server credential for the editor at once: its row, its socket and its ingest', async () => {
    await harness.editor(projectA);
    const token = await mintDevServerCredential(projectA);

    // Live before the release: it ingests, and its control connection authenticates.
    expect((await ingest(token, projectA)).status).toBe(202);
    const socket = await harness.ws({ client: 'server-agent', projectRoot: projectA, token });
    expect(socket.authenticated).toBe(true);
    const closesBefore = socket.closes.length;
    const logMark = harness.logger.records.length;

    // The editor releases it, as `scripts/dev-instrumented.mjs` does once its dev server has exited.
    expect(releasedFlagOf(await fetchRaw('credentials.release', { body: { token } }))).toBe(true);

    // The row is gone, its socket was closed with the credential-refusal code,
    // and it authenticates nothing more on either transport.
    expect(storedDigests().has(sha256Hex(token))).toBe(false);
    const closed = await socket.waitForClose(HARNESS_TIMEOUTS.message, closesBefore);
    expect(closed.code).toBe(WS_CLOSE_UNAUTHORIZED);
    expectRefusal(
      await ingest(token, projectA),
      'unknown-credential',
      'ingest with a released credential',
    );
    await expectHelloRefused(hello('server-agent', token, { projectRoot: projectA }));

    // The launcher ended its supervision and revoked it through the access
    // boundary, which closed the one socket authenticated with it.
    expect(logsSince(logMark, CLI_LEASE_RELEASED_LOG)).toHaveLength(1);
    const revoked = logsSince(logMark, SERVER_AGENT_REVOKED_LOG);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.fields['revoked']).toBe(true);
    expect(revoked[0]?.fields['socketsClosed']).toBe(1);

    // Releasing it again finds nothing live: the same success, `released: false`.
    expect(releasedFlagOf(await fetchRaw('credentials.release', { body: { token } }))).toBe(false);
    // One credential was released, and only that one: the editor still acts.
    expectSuccess(await fetchRaw('session.list'), 'session.list');
    await socket.close();
  });

  it('answers released: false for a supervised dev-server credential a rotation already removed', async () => {
    const held = await announcedEditors();
    const token = await mintDevServerCredential(projectA);
    expect((await ingest(token, projectA)).status).toBe(202);

    // The editor rotates every credential while the service still supervises
    // this one: its row is gone, and nothing has told the launcher, whose
    // lease for it runs on (no preload ever connected with it).
    await rotateThroughRoute(harness.editorToken, held);
    expect(storedDigests().has(sha256Hex(token))).toBe(false);
    await adoptRotatedEditor();
    const logMark = harness.logger.records.length;

    // Its holder releases it with the replacement editor credential. The
    // supervised lease is found and revoked, but the store no longer held the
    // credential: this request removed nothing, and the reply says exactly that.
    expect(releasedFlagOf(await fetchRaw('credentials.release', { body: { token } }))).toBe(false);
    expect(logsSince(logMark, CLI_LEASE_RELEASED_LOG)).toEqual([]);
    const notLive = logsSince(logMark, CLI_LEASE_NOT_LIVE_LOG);
    expect(notLive).toHaveLength(1);
    expect(notLive[0]?.fields['removed']).toBe(false);
    expect(notLive[0]?.fields['lapsed']).toBe(false);
    const revoked = logsSince(logMark, SERVER_AGENT_REVOKED_LOG);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.fields['revoked']).toBe(false);
    expectRefusal(
      await ingest(token, projectA),
      'unknown-credential',
      'ingest with a credential a rotation removed before its release',
    );

    // The release ended its supervision: a repeat is answered by the access
    // boundary's own release, which finds nothing either.
    expect(releasedFlagOf(await fetchRaw('credentials.release', { body: { token } }))).toBe(false);
    expect(logsSince(logMark, CLI_LEASE_NOT_LIVE_LOG)).toHaveLength(1);
    expect(logsSince(logMark, UNSUPERVISED_RELEASED_LOG)).toEqual([]);
    expectSuccess(await fetchRaw('session.list'), 'session.list');
  });

  it('answers released: false, and revokes nothing, for a token that names no live dev-server credential', async () => {
    const devtools = harness.issueDevtoolsCredential();
    track('devtools credential', devtools.token);
    // A lease as the launcher issues one to a dev server it starts itself: only
    // that dev server's exit or stop revokes it, never a caller naming its token.
    const lease = harness.auth.issueServerAgentCredential({
      projectRoot: projectA,
      expiresAt: requireClock().peek() + STAND_IN_LEASE_MS,
      lease: true,
    });
    if (isErr(lease)) {
      throw new Error(`The stand-in lease was not issued (${lease.error.code}).`);
    }
    const leased = track('launched dev server lease', lease.value.token);
    const digestsBefore = storedDigests();
    const logMark = harness.logger.records.length;

    const cases: readonly (readonly [string, { readonly token: string }])[] = [
      ['an unissued credential', unissuedReleaseBody()],
      ['a DevTools credential', { token: devtools.token }],
      ['the editor credential itself', { token: harness.editorToken }],
      ["a launched dev server's lease", { token: leased }],
    ];
    for (const [label, body] of cases) {
      const response = await fetchRaw('credentials.release', { body });
      expect(releasedFlagOf(response), label).toBe(false);
    }

    // Every credential stands and still authenticates; nothing was revoked.
    expect(storedDigests()).toEqual(digestsBefore);
    expectSuccess(await fetchRaw('session.list'), 'session.list');
    expect((await ingest(leased, projectA)).status).toBe(202);
    expect(logsSince(logMark, SERVER_AGENT_REVOKED_LOG)).toEqual([]);
    expect(logsSince(logMark, CLI_LEASE_RELEASED_LOG)).toEqual([]);
    expect(logsSince(logMark, UNSUPERVISED_RELEASED_LOG)).toEqual([]);
  });

  it('refuses a release from every credential but the editor’s, before its body is read', async () => {
    const token = await mintDevServerCredential(projectA);
    const devtools = harness.issueDevtoolsCredential();
    track('devtools credential', devtools.token);
    const logMark = harness.logger.records.length;

    expectRefusal(
      await fetchRaw('credentials.release', { token: null, body: { token } }),
      'missing-credential',
      'credentials.release without a credential',
    );
    expectRefusal(
      await fetchRaw('credentials.release', { ...presenting(devtools), body: { token } }),
      'role-not-permitted',
      'devtools → credentials.release',
    );
    // A server agent cannot release even its own credential: its lifetime is
    // its process's, ended by whoever started that process.
    expectRefusal(
      await fetchRaw('credentials.release', { token, body: { token } }),
      'role-not-permitted',
      'server-agent → credentials.release of its own credential',
    );

    // Nothing was released: the credential is stored, still ingests, and no release ran.
    expect(storedDigests().has(sha256Hex(token))).toBe(true);
    expect((await ingest(token, projectA)).status).toBe(202);
    expect(releaseActionsSince(logMark)).toEqual([]);

    expect(releasedFlagOf(await fetchRaw('credentials.release', { body: { token } }))).toBe(true);
  });

  it('refuses a release body that is not exactly { token }, in words that never carry the token', async () => {
    const token = await mintDevServerCredential(projectA);
    const logMark = harness.logger.records.length;

    const bodies: readonly (readonly [string, unknown])[] = [
      ['no body', undefined],
      ['a body that is not JSON', 'not json'],
      ['an empty object', {}],
      ['the token beside an extra key', { token, projectRoot: projectA }],
      ['the token beside a widening flag', { token, all: true }],
      ['the token as a key', { [token]: true }],
      ['the token under another name', { credential: token }],
      ['the token inside an array', { token: [token] }],
    ];
    for (const [label, body] of bodies) {
      const response = await fetchRaw('credentials.release', { body });
      expect(response.status, label).toBe(INVALID_BODY_STATUS);
      expect(refusalShape(response).code, label).toBe(INVALID_BODY_CODE);
      expect(response.text.includes(token), `${label}: the refusal echoes the token`).toBe(false);
      expect(response.headers.get(CACHE_CONTROL_HEADER), label).toContain(NO_STORE_DIRECTIVE);
    }

    // Nothing was released, and no record names the token.
    expect(storedDigests().has(sha256Hex(token))).toBe(true);
    expect(releaseActionsSince(logMark)).toEqual([]);
    assertNothingLogged();

    expect(releasedFlagOf(await fetchRaw('credentials.release', { body: { token } }))).toBe(true);
  });

  it('keeps every released credential out of replies, the log and the store', async () => {
    await assertNoPlaintextAtRest();
    assertNothingLogged();
  });
});

/* -------------------------------------------------------------------------------------------------
 * The revocation fence across a stalled request body
 * ---------------------------------------------------------------------------------------------- */

/** The record the access boundary writes when its revocation fence refuses a request. */
const FENCE_REFUSAL_LOG =
  'refused a request whose credential was retired after it was authenticated';

/** The record the access boundary writes for every server-agent credential it mints. */
const SERVER_AGENT_ISSUED_LOG = 'issued a server-agent credential';

/** The record the access boundary writes once per completed rotation. */
const ROTATION_LOG = 'rotated every service credential';

/** The record the access boundary writes for every pairing code it mints. */
const PAIRING_CODE_ISSUED_LOG = 'issued a pairing code';

/** The debug record the ingest route writes for every batch it answered `202`. */
const INGEST_ANSWERED_LOG = 'telemetry ingest request answered';

/** The debug record the ingest route writes when the fence refused a batch's credential. */
const INGEST_FENCED_LOG =
  'refused telemetry ingest for a credential retired while its body was read';

/**
 * The operations whose side effect the fence is proven on across a stalled
 * body: the editor's credential request, purge, rotation, pairing and release,
 * and the server agent's ingest (`telemetry.event`, `POST /telemetry/ingest`).
 */
type StalledOperation =
  | 'devServer.credential'
  | 'session.purge'
  | 'credentials.rotate'
  | 'credentials.release'
  | 'pair.start'
  | 'telemetry.event';

/** A request whose body is held back part-way after the middleware authenticated it. */
interface StalledRequest {
  /** Sends the rest of the body and resolves with the whole response. */
  resume(): Promise<RawFetchResponse>;
}

/** A Node response's headers as a WHATWG `Headers`, the shape {@link RawFetchResponse} carries. */
function headersOf(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

/**
 * Opens `operation` over a raw `node:http` connection presenting `token`,
 * declares the whole body's `Content-Length`, writes only its first half, and
 * resolves once the service's middleware has **authenticated** the request —
 * so the credential was live when the principal was resolved, and the handler
 * is now awaiting the rest of the body.
 *
 * Authentication is observed with a call-through spy on the service's own
 * `authorizeHttpRequest` (the instance its middleware calls), restored before
 * this returns: it records the verdict for this operation and digest and
 * changes nothing the service does. The response, once {@link
 * StalledRequest.resume} releases the body, passes the same CORS and leak
 * checks as every {@link fetchRaw} reply.
 */
async function stallRequest(
  operation: StalledOperation,
  body: object,
  token: string,
): Promise<StalledRequest> {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  const split = Math.max(1, Math.floor(bytes.length / 2));
  expect(bytes.length, 'a body long enough to hold part of it back').toBeGreaterThan(split);
  const digest = sha256Hex(token);
  const target = new URL(buildPath(operation), harness.url);
  const spy = vi.spyOn(harness.auth, 'authorizeHttpRequest');
  try {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: HTTP_ROUTES[operation].method,
      // One connection of its own, closed after the reply, so teardown finds no socket.
      agent: false,
      headers: {
        [AUTHORIZATION_HEADER]: formatBearer(token),
        'content-type': 'application/json',
        'content-length': String(bytes.length),
        connection: 'close',
      },
    });
    const response = new Promise<RawFetchResponse>((resolve, reject) => {
      request.on('error', reject);
      request.on('response', (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = text.length === 0 ? undefined : JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({
            status: incoming.statusCode ?? 0,
            headers: headersOf(incoming.headers),
            text,
            json,
          });
        });
      });
    });
    // A failure before `resume()` is awaited surfaces there; this keeps it
    // from escaping as an unhandled rejection meanwhile.
    void response.catch(() => undefined);
    request.setTimeout(HARNESS_TIMEOUTS.request, () => {
      request.destroy(new Error(`The stalled ${operation} request was not answered in time.`));
    });
    request.write(bytes.subarray(0, split));

    await waitUntil(() => {
      for (const [index, [authorization]] of spy.mock.calls.entries()) {
        const outcome = spy.mock.results[index];
        if (
          authorization.operation === operation &&
          outcome?.type === 'return' &&
          !isErr(outcome.value) &&
          outcome.value.value?.tokenHash === digest
        ) {
          return true;
        }
      }
      return undefined;
    }, `the middleware authenticated the stalled ${operation} request`);

    return {
      resume: async () => {
        request.end(bytes.subarray(split));
        const answered = await response;
        expectNoCorsGrant(answered);
        expect(
          leaksIn(answered.text),
          `a ${String(answered.status)} reply echoes a secret`,
        ).toEqual([]);
        inspectedResponses += 1;
        return answered;
      },
    };
  } finally {
    spy.mockRestore();
  }
}

/**
 * Runs `rotate` and waits until each of the `held` editor connections was
 * closed with `WS_CLOSE_UNAUTHORIZED`, so none of them is mistaken for a live
 * announcement afterwards.
 */
async function rotateClosing(
  held: readonly HarnessWsClient[],
  rotate: () => Promise<void> | void,
): Promise<void> {
  const closesBefore = held.map((client) => client.closes.length);
  await rotate();
  for (const [index, client] of held.entries()) {
    const record = await client.waitForClose(HARNESS_TIMEOUTS.message, closesBefore[index]);
    expect(record.code, client.describe()).toBe(WS_CLOSE_UNAUTHORIZED);
  }
}

/** Rotates every credential through `POST /credentials/rotate`, presenting `token`. */
async function rotateThroughRoute(token: string, held: readonly HarnessWsClient[]): Promise<void> {
  await rotateClosing(held, async () => {
    expectSuccess(await fetchRaw('credentials.rotate', { token, body: {} }), 'credentials.rotate');
  });
}

/**
 * Re-establishes the editor after a rotation, as the extension does on 4401:
 * re-reads `auth.json`, announces both fixture projects again, and proves the
 * new credential is answered — so every later test finds the editor as it was.
 */
async function adoptRotatedEditor(): Promise<void> {
  track('editor credential', harness.refreshEditorToken());
  for (const projectRoot of [projectA, projectB]) {
    expect((await harness.editor(projectRoot)).authenticated).toBe(true);
  }
  expectSuccess(await fetchRaw('session.list'), 'session.list');
}

/** Both fixture projects' live editor connections, opening one where none is authenticated. */
async function announcedEditors(): Promise<readonly HarnessWsClient[]> {
  return [await harness.editor(projectA), await harness.editor(projectB)];
}

/** The body a stalled `POST /telemetry/ingest` carries: the preload's batch, for `projectRoot`. */
function ingestBodyFor(projectRoot: string): object {
  return { projectRoot, events: [...serverEvents] };
}

/**
 * Asserts that the fence — not the middleware, which had authenticated the
 * request before its credential was retired — refused exactly one request
 * after `mark` records: a `role` credential's, as no longer known.
 */
function expectOneFenceRefusal(mark: number, role: PrincipalRole): void {
  const fenced = logsSince(mark, FENCE_REFUSAL_LOG);
  expect(fenced).toHaveLength(1);
  expect(fenced[0]?.fields['reason']).toBe('unknown-credential');
  expect(fenced[0]?.fields['role']).toBe(role);
}

/** Whether a `pairing_codes` row keys on `code`'s digest — the code was minted and stored. */
function pairingCodeStored(code: string): boolean {
  const digest = sha256Hex(code);
  return readRows(SELECT_PAIRING_CODES).some((row) => row['code_hash'] === digest);
}

describe('the revocation fence across a stalled request body', () => {
  it('completes a stalled credential request and a stalled purge whose credential stayed live', async () => {
    await announcedEditors();
    const serverAgentBefore = digestsOf(credentialRowsOf('server-agent'));

    const minting = await stallRequest(
      'devServer.credential',
      { projectRoot: projectA },
      harness.editorToken,
    );
    const minted = await minting.resume();
    expectSuccess(minted, 'devServer.credential');
    expect(minted.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
    const parsed = HTTP_ROUTES['devServer.credential'].response.safeParse(minted.json);
    if (!parsed.success) {
      throw new Error('The dev-server credential reply does not satisfy its schema.');
    }
    const token = track('dev-server credential', parsed.data.token);
    const serverAgentAfter = digestsOf(credentialRowsOf('server-agent'));
    expect(serverAgentAfter).toHaveLength(serverAgentBefore.length + 1);
    expect(serverAgentAfter).toContain(sha256Hex(token));

    const logMark = harness.logger.records.length;
    const purging = await stallRequest('session.purge', {}, harness.editorToken);
    const purged = await purging.resume();
    expect(sessionContentDeleted(purgeReportOf(purged))).toEqual(NOTHING_DELETED);
    expect(logsSince(logMark, PURGE_REQUEST_LOG)).toHaveLength(1);
    expect(logsSince(logMark, RETENTION_SWEEP_LOG)).toHaveLength(1);
    expect(logsSince(logMark, FENCE_REFUSAL_LOG)).toEqual([]);
  });

  it('completes a stalled pairing request, ingest batch and release whose credential stayed live', async () => {
    await announcedEditors();
    const logMark = harness.logger.records.length;

    // pair.start: a code is minted, stored as its digest, and handed back once.
    const pairing = await stallRequest('pair.start', {}, harness.editorToken);
    const paired = await pairing.resume();
    expect(paired.status, 'pair.start: status').toBe(200);
    expect(paired.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
    const issued = pairStartResponseSchema.safeParse(paired.json);
    if (!issued.success) {
      throw new Error('The pair.start reply does not satisfy its schema.');
    }
    const code = track('pairing code', issued.data.code);
    expect(pairingCodeStored(code)).toBe(true);
    expect(logsSince(logMark, PAIRING_CODE_ISSUED_LOG)).toHaveLength(1);

    // telemetry.event: the batch reaches ingest, which stores exactly what it reports accepting.
    const agentToken = await mintDevServerCredential(projectA);
    const rowsBefore = telemetryRowCount();
    const ingesting = await stallRequest('telemetry.event', ingestBodyFor(projectA), agentToken);
    const ingested = await ingesting.resume();
    expect(ingested.status, 'telemetry.event: status').toBe(202);
    const report = telemetryIngestResponseSchema.safeParse(ingested.json);
    if (!report.success) {
      throw new Error('The ingest reply does not satisfy its schema.');
    }
    expect(telemetryRowCount() - rowsBefore).toBe(report.data.accepted);
    expect(logsSince(logMark, INGEST_ANSWERED_LOG)).toHaveLength(1);

    // credentials.release: the same credential is revoked by its holder's editor.
    const releasing = await stallRequest(
      'credentials.release',
      { token: agentToken },
      harness.editorToken,
    );
    expect(releasedFlagOf(await releasing.resume())).toBe(true);
    expect(storedDigests().has(sha256Hex(agentToken))).toBe(false);
    expect(logsSince(logMark, CLI_LEASE_RELEASED_LOG)).toHaveLength(1);

    expect(logsSince(logMark, FENCE_REFUSAL_LOG)).toEqual([]);
    expect(logsSince(logMark, INGEST_FENCED_LOG)).toEqual([]);
  });

  it('refuses a stalled credential request whose editor credential a rotation retired, and mints nothing', async () => {
    const held = await announcedEditors();
    const retired = harness.editorToken;
    const stalled = await stallRequest('devServer.credential', { projectRoot: projectA }, retired);

    // The rotation lands while the handler awaits the rest of the body. It
    // deletes every credential, the one that authorized the stalled request included.
    await rotateThroughRoute(retired, held);
    expect(credentialRowsOf('server-agent')).toEqual([]);
    const rowsAfterRotation = readRows(SELECT_CREDENTIALS);
    const logMark = harness.logger.records.length;

    const response = await stalled.resume();
    const refusal = expectRefusal(
      response,
      'unknown-credential',
      'a credential request resumed after its credential was rotated',
    );
    expect(refusal.message).toBe(AUTH_FAILURE_REASONS['unknown-credential'].message);
    expect(response.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
    // No token in the reply, and no server-agent row behind it.
    expect(bodyKeys(response)).not.toContain('token');
    expect(HTTP_ROUTES['devServer.credential'].response.safeParse(response.json).success).toBe(
      false,
    );
    expect(credentialRowsOf('server-agent')).toEqual([]);
    expect(readRows(SELECT_CREDENTIALS)).toEqual(rowsAfterRotation);
    expect(logsSince(logMark, SERVER_AGENT_ISSUED_LOG)).toEqual([]);
    // The fence refused it, not the middleware: the middleware authenticated it before the rotation.
    const fenced = logsSince(logMark, FENCE_REFUSAL_LOG);
    expect(fenced).toHaveLength(1);
    expect(fenced[0]?.fields['reason']).toBe('unknown-credential');
    expect(fenced[0]?.fields['role']).toBe('vscode');

    await adoptRotatedEditor();
  });

  it('refuses a stalled purge whose editor credential a rotation retired, before any sweep runs', async () => {
    const held = await announcedEditors();
    const before = await heldSessionIds();
    const retired = harness.editorToken;
    const stalled = await stallRequest('session.purge', {}, retired);

    await rotateThroughRoute(retired, held);
    const logMark = harness.logger.records.length;

    const response = await stalled.resume();
    expectRefusal(
      response,
      'unknown-credential',
      'a purge resumed after its credential was rotated',
    );
    expect(bodyKeys(response)).not.toContain('sessionsDeleted');
    expect(logsSince(logMark, PURGE_REQUEST_LOG)).toEqual([]);
    expect(logsSince(logMark, RETENTION_SWEEP_LOG)).toEqual([]);
    expect(logsSince(logMark, FENCE_REFUSAL_LOG)).toHaveLength(1);

    await adoptRotatedEditor();
    expect(await heldSessionIds()).toEqual(before);
  });

  it('refuses a stalled rotation whose credential a rotation outside the route retired, and rotates nothing more', async () => {
    const held = await announcedEditors();
    const retired = harness.editorToken;
    const stalled = await stallRequest('credentials.rotate', {}, retired);

    // The service's own rotateAll, called directly rather than through the
    // route: the fence reads the store, so it sees a rotation whichever caller ran it.
    await rotateClosing(held, () => {
      harness.rotateAll();
    });
    const digestsAfterRotation = storedDigests();
    const authFileAfterRotation = await sha256OfFile(harness.config.authFilePath);
    const logMark = harness.logger.records.length;

    const response = await stalled.resume();
    expectRefusal(
      response,
      'unknown-credential',
      'a rotation resumed after its credential was rotated',
    );
    // Nothing more was revoked: the credentials and auth.json the rotation left stand.
    expect(storedDigests()).toEqual(digestsAfterRotation);
    expect(await sha256OfFile(harness.config.authFilePath)).toBe(authFileAfterRotation);
    expect(logsSince(logMark, ROTATION_LOG)).toEqual([]);
    expect(logsSince(logMark, FENCE_REFUSAL_LOG)).toHaveLength(1);

    await adoptRotatedEditor();
  });

  it('refuses a stalled pairing request whose editor credential a rotation retired, and mints no code', async () => {
    const held = await announcedEditors();
    const retired = harness.editorToken;
    const stalled = await stallRequest('pair.start', {}, retired);

    // The rotation deletes every credential and every outstanding pairing code.
    await rotateThroughRoute(retired, held);
    const codesAfterRotation = readRows(SELECT_PAIRING_CODES);
    const logMark = harness.logger.records.length;

    const response = await stalled.resume();
    const refusal = expectRefusal(
      response,
      'unknown-credential',
      'a pairing request resumed after its credential was rotated',
    );
    expect(refusal.message).toBe(AUTH_FAILURE_REASONS['unknown-credential'].message);
    expect(response.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
    // No code in the reply, none stored behind it, and the minting never ran.
    expect(pairStartResponseSchema.safeParse(response.json).success).toBe(false);
    expect(bodyKeys(response)).not.toContain('expiresAt');
    expect(readRows(SELECT_PAIRING_CODES)).toEqual(codesAfterRotation);
    expect(logsSince(logMark, PAIRING_CODE_ISSUED_LOG)).toEqual([]);
    expectOneFenceRefusal(logMark, 'vscode');

    await adoptRotatedEditor();
  });

  it('refuses a stalled ingest batch whose server-agent credential a rotation retired, and stores nothing', async () => {
    const held = await announcedEditors();
    const agentToken = await mintDevServerCredential(projectA);
    const stalled = await stallRequest('telemetry.event', ingestBodyFor(projectA), agentToken);
    const rowsBefore = telemetryRowCount();

    await rotateThroughRoute(harness.editorToken, held);
    expect(storedDigests().has(sha256Hex(agentToken))).toBe(false);
    const logMark = harness.logger.records.length;

    const response = await stalled.resume();
    expectRefusal(
      response,
      'unknown-credential',
      'an ingest batch resumed after its credential was rotated',
    );
    // Nothing reached ingest: no count in the reply, no row stored, no batch answered.
    expect(telemetryIngestResponseSchema.safeParse(response.json).success).toBe(false);
    expect(telemetryRowCount()).toBe(rowsBefore);
    expect(logsSince(logMark, INGEST_ANSWERED_LOG)).toEqual([]);
    expect(logsSince(logMark, INGEST_FENCED_LOG)).toHaveLength(1);
    expectOneFenceRefusal(logMark, 'server-agent');

    await adoptRotatedEditor();
  });

  it('refuses a stalled ingest batch whose server-agent credential its holder released, and stores nothing', async () => {
    await announcedEditors();
    const agentToken = await mintDevServerCredential(projectA);
    const stalled = await stallRequest('telemetry.event', ingestBodyFor(projectA), agentToken);
    const rowsBefore = telemetryRowCount();

    // The editor releases the credential, as `scripts/dev-instrumented.mjs` does
    // once its dev server has exited, while the batch's body is still arriving.
    expect(
      releasedFlagOf(await fetchRaw('credentials.release', { body: { token: agentToken } })),
    ).toBe(true);
    expect(storedDigests().has(sha256Hex(agentToken))).toBe(false);
    const logMark = harness.logger.records.length;

    const response = await stalled.resume();
    expectRefusal(
      response,
      'unknown-credential',
      'an ingest batch resumed after its credential was released',
    );
    expect(telemetryIngestResponseSchema.safeParse(response.json).success).toBe(false);
    expect(telemetryRowCount()).toBe(rowsBefore);
    expect(logsSince(logMark, INGEST_ANSWERED_LOG)).toEqual([]);
    expect(logsSince(logMark, INGEST_FENCED_LOG)).toHaveLength(1);
    expectOneFenceRefusal(logMark, 'server-agent');

    // A release retires one credential only: the editor that asked for it still acts.
    expectSuccess(await fetchRaw('session.list'), 'session.list');
  });

  it('refuses a stalled release whose editor credential a rotation retired, and revokes nothing more', async () => {
    const held = await announcedEditors();
    const retired = harness.editorToken;
    const target = await mintDevServerCredential(projectA);
    const stalled = await stallRequest('credentials.release', { token: target }, retired);

    await rotateThroughRoute(retired, held);
    const digestsAfterRotation = storedDigests();
    const logMark = harness.logger.records.length;

    const response = await stalled.resume();
    expectRefusal(
      response,
      'unknown-credential',
      'a release resumed after its credential was rotated',
    );
    expect(response.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
    expect(bodyKeys(response)).not.toContain('released');
    // The launcher was never asked: no release ran, and nothing more was revoked.
    expect(storedDigests()).toEqual(digestsAfterRotation);
    expect(releaseActionsSince(logMark)).toEqual([]);
    expect(logsSince(logMark, SERVER_AGENT_REVOKED_LOG)).toEqual([]);
    expectOneFenceRefusal(logMark, 'vscode');

    await adoptRotatedEditor();
  });

  it('keeps every credential the fence saw out of the store and the log', async () => {
    await assertNoPlaintextAtRest();
    assertNothingLogged();
  });
});

/* -------------------------------------------------------------------------------------------------
 * The request media type
 * ---------------------------------------------------------------------------------------------- */

/** The status of a body sent under a media type other than JSON. */
const UNSUPPORTED_MEDIA_TYPE_STATUS = 415;

/** The two editor operations the media-type rule is proven on over the wire. */
type MediaTypeOperation = 'pair.start' | 'session.purge';

/** The empty JSON object both operations declare, as the bytes a client sends. */
const EMPTY_OBJECT_BYTES = new TextEncoder().encode('{}');

/**
 * Sends `operation` with the editor credential, carrying exactly the
 * `Content-Type` named — none at all when `undefined` — and `body` as bytes,
 * so the platform adds no media type of its own (a string body would be sent
 * as `text/plain`). {@link Harness.rawFetch} cannot express the header's
 * absence: it labels every body JSON. The reply passes the same CORS and leak
 * checks as every {@link fetchRaw} reply.
 */
async function sendWithMediaType(
  operation: MediaTypeOperation,
  contentType: string | undefined,
  body: Uint8Array | undefined,
): Promise<RawFetchResponse> {
  const headers: Record<string, string> = {
    [AUTHORIZATION_HEADER]: formatBearer(harness.editorToken),
  };
  if (contentType !== undefined) {
    headers['content-type'] = contentType;
  }
  const response = await fetch(new URL(buildPath(operation), harness.url), {
    method: HTTP_ROUTES[operation].method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(HARNESS_TIMEOUTS.request),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  const reply: RawFetchResponse = {
    status: response.status,
    headers: response.headers,
    text,
    json,
  };
  expectNoCorsGrant(reply);
  expect(leaksIn(reply.text), `a ${String(reply.status)} reply echoes a secret`).toEqual([]);
  inspectedResponses += 1;
  return reply;
}

/** The media types a JSON body is refused under, the header's absence included. */
const REFUSED_MEDIA_TYPES: readonly (readonly [string, string | undefined])[] = [
  ['text/plain', 'text/plain'],
  ['a form encoding', 'application/x-www-form-urlencoded'],
  ['no Content-Type at all', undefined],
];

/** The media types a JSON body is read under. */
const ACCEPTED_MEDIA_TYPES: readonly string[] = [
  'application/json',
  'application/json; charset=utf-8',
];

/** Asserts the guard's `415`: protocol's error body, the transport's code, no-store. */
function expectUnsupportedMediaType(response: RawFetchResponse, label: string): void {
  expect(response.status, `${label}: status`).toBe(UNSUPPORTED_MEDIA_TYPE_STATUS);
  const parsed = httpErrorResponseSchema.safeParse(response.json);
  if (!parsed.success) {
    throw new Error(`${label}: the 415 body is not protocol's error shape.`);
  }
  expect(parsed.data.code, `${label}: code`).toBe(INVALID_BODY_CODE);
  expect(response.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
}

describe('the request media type', () => {
  it('refuses a pairing request whose JSON body is not sent as JSON with 415, and mints no code', async () => {
    for (const [label, contentType] of REFUSED_MEDIA_TYPES) {
      const codesBefore = readRows(SELECT_PAIRING_CODES);
      const logMark = harness.logger.records.length;

      const response = await sendWithMediaType('pair.start', contentType, EMPTY_OBJECT_BYTES);

      expectUnsupportedMediaType(response, `pair.start as ${label}`);
      expect(pairStartResponseSchema.safeParse(response.json).success).toBe(false);
      expect(readRows(SELECT_PAIRING_CODES)).toEqual(codesBefore);
      expect(logsSince(logMark, PAIRING_CODE_ISSUED_LOG)).toEqual([]);
    }
  });

  it('mints a code for the same body sent as JSON', async () => {
    for (const contentType of ACCEPTED_MEDIA_TYPES) {
      const logMark = harness.logger.records.length;

      const response = await sendWithMediaType('pair.start', contentType, EMPTY_OBJECT_BYTES);

      expect(response.status, contentType).toBe(200);
      const parsed = pairStartResponseSchema.safeParse(response.json);
      if (!parsed.success) {
        throw new Error(`pair.start as ${contentType}: the reply does not satisfy its schema.`);
      }
      track('pairing code', parsed.data.code);
      expect(pairingCodeStored(parsed.data.code)).toBe(true);
      expect(logsSince(logMark, PAIRING_CODE_ISSUED_LOG)).toHaveLength(1);
    }
  });

  it('refuses a purge whose body is not sent as JSON with 415, before a sweep runs', async () => {
    const before = await heldSessionIds();
    for (const [label, contentType] of REFUSED_MEDIA_TYPES) {
      const logMark = harness.logger.records.length;

      const response = await sendWithMediaType('session.purge', contentType, EMPTY_OBJECT_BYTES);

      expectUnsupportedMediaType(response, `session.purge as ${label}`);
      expect(logsSince(logMark, PURGE_REQUEST_LOG)).toEqual([]);
      expect(logsSince(logMark, RETENTION_SWEEP_LOG)).toEqual([]);
    }
    expect(await heldSessionIds()).toEqual(before);
  });

  it('runs a purge sent as JSON, and a bodiless purge that carries no Content-Type', async () => {
    const requests: readonly (readonly [string, string | undefined, Uint8Array | undefined])[] = [
      ...ACCEPTED_MEDIA_TYPES.map(
        (contentType) => [contentType, contentType, EMPTY_OBJECT_BYTES] as const,
      ),
      ['no body and no Content-Type', undefined, undefined],
    ];
    for (const [label, contentType, body] of requests) {
      const logMark = harness.logger.records.length;

      const response = await sendWithMediaType('session.purge', contentType, body);

      expect(response.status, label).toBe(200);
      expect(sessionContentDeleted(purgeReportOf(response))).toEqual(NOTHING_DELETED);
      expect(logsSince(logMark, PURGE_REQUEST_LOG)).toHaveLength(1);
    }
  });

  it('keeps every code the media-type checks minted out of the store and the log', async () => {
    await assertNoPlaintextAtRest();
    assertNothingLogged();
  });
});

/* -------------------------------------------------------------------------------------------------
 * What a refused request tells the developer
 * ---------------------------------------------------------------------------------------------- */

/** The response header every reply carries its correlation ref in. */
const REF_HEADER = 'x-debuggen-ref';

/** The `info` record the HTTP surface files for every request it answered with a failure. */
const FAILURE_ANSWERED_LOG = 'Answered an HTTP request with a failure';

/** The `warn` record the access boundary files for every HTTP request it refuses. */
const HTTP_REFUSAL_LOG = 'refused an HTTP request';

/** The record the HTTP surface's origin guard files for every web origin it refuses. */
const ORIGIN_REFUSED_LOG = 'Refused a request from an origin this service never serves';

/** A well-formed session id no session of this service holds. */
const UNKNOWN_SESSION_ID = 'ses_doesnotexist0000';

/**
 * Asserts that a failure reply names one ref in its body and its header, and
 * that the HTTP surface filed exactly one `info` failure record under it since
 * `mark`, with the reply's status and code. Returns the ref.
 */
function expectCorrelatedFailure(response: RawFetchResponse, mark: number, label: string): string {
  const parsed = httpErrorResponseSchema.safeParse(response.json);
  if (!parsed.success) {
    throw new Error(`${label}: the failure body is not protocol's error shape.`);
  }
  const { ref } = parsed.data;
  if (ref === undefined) {
    throw new Error(`${label}: the failure body names no ref.`);
  }
  expect(response.headers.get(REF_HEADER), `${label}: the ref header`).toBe(ref);
  const filed = logsSince(mark, FAILURE_ANSWERED_LOG).filter(
    (record) => record.fields['ref'] === ref,
  );
  expect(filed, `${label}: the failure record`).toHaveLength(1);
  expect(filed[0]?.level).toBe('info');
  expect(filed[0]?.fields['status']).toBe(response.status);
  expect(filed[0]?.fields['errorCode']).toBe(parsed.data.code);
  return ref;
}

describe('what a refused request tells the developer', () => {
  it('names one ref in the body, the header and the records of every kind of HTTP failure', async () => {
    let mark = harness.logger.records.length;
    const unauthenticated = await fetchRaw('session.list', { token: null });
    expect(unauthenticated.status).toBe(AUTH_FAILURE_REASONS['missing-credential'].status);
    const refusalRef = expectCorrelatedFailure(unauthenticated, mark, 'a missing credential');
    // The access boundary's own warn record is filed under the same ref.
    const refusals = logsSince(mark, HTTP_REFUSAL_LOG);
    expect(refusals.map((record) => [record.level, record.fields['ref']])).toEqual([
      ['warn', refusalRef],
    ]);

    mark = harness.logger.records.length;
    const unknown = await fetchRaw(targetFor('session.get', UNKNOWN_SESSION_ID));
    expect(unknown.status).toBe(404);
    expect(refusalShape(unknown).code).toBe('SESSION_NOT_FOUND');
    expectCorrelatedFailure(unknown, mark, 'an unknown session');

    mark = harness.logger.records.length;
    const malformed = await fetchRaw('session.create', { body: '{bad' });
    expect(malformed.status).toBe(INVALID_BODY_STATUS);
    expectCorrelatedFailure(malformed, mark, 'a body that is not JSON');

    mark = harness.logger.records.length;
    const incomplete = await fetchRaw('session.create', { body: {} });
    expect(incomplete.status).toBe(INVALID_BODY_STATUS);
    expectCorrelatedFailure(incomplete, mark, 'a body missing its fields');

    // A success names its ref in the header only.
    const answered = await fetchRaw('health', { token: null });
    expect(answered.status).toBe(200);
    expect(answered.headers.get(REF_HEADER)).toMatch(/^msg_[0-9a-z]{16}$/u);
  });

  it("names the web origin it refused, and the ref of the refusal, in the origin guard's record", async () => {
    const origin = STATIC_WEB_ORIGINS[0];
    const mark = harness.logger.records.length;

    const response = await fetchRaw('health', {
      token: null,
      origin: `${origin}/zz-page?zz-query=1`,
    });
    const refused = expectRefusal(response, 'forbidden-origin');

    expect(refused.ref).toMatch(/^msg_[0-9a-z]{16}$/u);
    // The guard mints the ref of its own refusal: body and header agree.
    expect(response.headers.get(REF_HEADER)).toBe(refused.ref);
    const filed = logsSince(mark, ORIGIN_REFUSED_LOG);
    expect(filed).toHaveLength(1);
    // Filed at `warn` within the burst of a minute, at `debug` past it (the
    // origin-policy suite refused many before this); the record is the same.
    expect(['warn', 'debug']).toContain(filed[0]?.level);
    expect(filed[0]?.fields).toMatchObject({ origin, ref: refused.ref, status: 403 });
    expect(filed[0]?.line.includes('zz-page')).toBe(false);
    expect(filed[0]?.line.includes('zz-query')).toBe(false);
  });
});
