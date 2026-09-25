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
 * store — racing redemptions, a failing random source, the lower-case code a
 * developer types, the global forged-origin ceiling. None of that is repeated
 * here: every assertion below needs a running server, because what it pins is
 * that the HTTP middleware, the route modules, the WebSocket upgrade gate and
 * the hello handshake actually *apply* those rules to real requests. The
 * exhaustive traversal table of click-to-source belongs to `source-open.test.ts`;
 * this file asserts only its role-and-scope half.
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
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_HEADER,
  AUTH_EXEMPT_OPERATIONS,
  CLIENT_HELLO_TIMEOUT_MS,
  HTTP_OPERATIONS,
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MAJOR,
  WS_CLOSE_UNAUTHORIZED,
  buildPath,
  clientHelloPayloadSchema,
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
  SessionRecord,
} from '@debuggen/protocol';
import { isErr, newId, newPanelId, newProducerId, newSessionId } from '@debuggen/shared';
import { SECURE_FILE_MODE, sha256Hex, sha256OfFile } from '@debuggen/shared/node';
import type { TelemetryEventIngress } from '@debuggen/telemetry';

import {
  DEV_SERVER_CREDENTIAL_METHOD,
  DEV_SERVER_CREDENTIAL_PATH,
  devServerCredentialResponseSchema,
} from '../../src/dev-server/launcher.js';
import {
  AUTH_FAILURE_REASONS,
  CREDENTIAL_ROLES,
  OPERATION_ROLES,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_LOCKOUT_MS,
  PAIRING_MAX_FAILURES,
} from '../../src/server/auth.js';
import type {
  AuthFailureReason,
  AuthenticatedOperation,
  PrincipalRole,
} from '../../src/server/auth.js';
import { UNIFORM_PAIRING_REFUSAL_REASONS } from '../../src/server/routes/pair.js';

import {
  HARNESS_TIMEOUTS,
  chromeExtensionOrigin,
  newExtensionId,
  randomSecretLike,
  readTelemetryBatch,
  startHarness,
  waitFor,
  waitUntil,
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

/** The inspected tabs this suite speaks for, one per scenario so no binding is shared by accident. */
const TABS = Object.freeze({
  acceptedOrigin: 111,
  paired: 121,
  own: 101,
  other: 202,
  opener: 151,
  rotation: 131,
  repaired: 141,
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
 * A body the operation's route accepts for its method: none for a `GET`, a
 * `DataQuery` for `panel.data`, and `{}` for every other `POST` (the access
 * boundary answers before any body is read, so the body only matters where a
 * request is admitted).
 */
function requestBodyFor(operation: HttpOperationId): unknown {
  if (HTTP_ROUTES[operation].method !== 'POST') {
    return undefined;
  }
  return operation === 'panel.data' ? { source: 'events' } : {};
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
 * The harness's raw fetch, with two checks applied to **every** response this
 * suite reads: no CORS grant header, and no tracked secret echoed in the body.
 * (A success that issues a code or a credential carries a *new* value, which is
 * tracked only after it has been read.)
 */
async function fetchRaw(
  target: RawFetchTarget,
  init: RawFetchInit = {},
): Promise<RawFetchResponse> {
  const response = await harness.rawFetch(target, init);
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

/** The request options that present a DevTools credential from the extension it was issued to. */
function presenting(credential: DevtoolsCredential): Pick<RawFetchInit, 'token' | 'origin'> {
  return { token: credential.token, origin: credential.origin };
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
 * Mints a server-agent credential through the folder-owned
 * `POST /dev-server/credential` route — the credential a dev server started
 * without the launcher runs with.
 */
async function mintDevServerCredential(projectRoot: string): Promise<string> {
  const response = await fetchRaw(
    { path: DEV_SERVER_CREDENTIAL_PATH },
    { method: DEV_SERVER_CREDENTIAL_METHOD, body: { projectRoot } },
  );
  expect(response.status).toBe(200);
  const parsed = devServerCredentialResponseSchema.safeParse(response.json);
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

/** Asserts a successful redemption and returns its DevTools credential, tracked. */
function redeemedToken(response: RawFetchResponse): string {
  expect(response.status, 'pair.complete: status').toBe(200);
  const parsed = pairCompleteResponseSchema.safeParse(response.json);
  if (!parsed.success) {
    throw new Error('The pair.complete reply does not satisfy its schema.');
  }
  expect(response.headers.get(CACHE_CONTROL_HEADER)).toContain(NO_STORE_DIRECTIVE);
  return track('paired devtools credential', parsed.data.token);
}

/** The whole pairing flow over HTTP: the editor starts it, the extension's origin redeems it. */
async function pairExtension(extensionId: string = newExtensionId()): Promise<DevtoolsCredential> {
  const code = await pairStart();
  const origin = chromeExtensionOrigin(extensionId);
  const token = redeemedToken(await redeem(code, origin));
  return { extensionId, origin, token };
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
 * Lifecycle
 * ---------------------------------------------------------------------------------------------- */

beforeAll(async () => {
  harness = await startHarness();
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
    // The folder-owned credential route sits beside the table and behind the same gate.
    const credentialRoute = await fetchRaw(
      { path: DEV_SERVER_CREDENTIAL_PATH },
      { method: DEV_SERVER_CREDENTIAL_METHOD, token: null, body: { projectRoot: projectA } },
    );
    expectRefusal(credentialRoute, 'missing-credential', 'the dev-server credential route');
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

    // A DevTools credential: only from the extension it was issued to.
    const devtools = await bindDevtools(TABS.acceptedOrigin, sessionB);
    const target = targetFor('session.get', sessionB.id);
    expectSuccess(await fetchRaw(target, presenting(devtools.credential)), 'session.get');
    for (const origin of [undefined, webview, extension]) {
      expectRefusal(
        await fetchRaw(target, { token: devtools.credential.token, origin }),
        'origin-not-permitted-for-role',
        `a DevTools credential from ${origin ?? 'no origin'}`,
      );
    }
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
  it('refuses an upgrade from a web origin before any WebSocket exists', async () => {
    for (const origin of webOrigins()) {
      const raw = harness.rawSocket({ origin });
      expect(await raw.waitForOpen(), `an upgrade from ${origin} opened`).toBe(false);
      expect(raw.upgradeStatus, origin).toBe(AUTH_FAILURE_REASONS['forbidden-origin'].status);
      expect(raw.frames).toEqual([]);
      // No socket ever existed, so there was no WebSocket close handshake to carry a code.
      expect(raw.closes.map((record) => record.code)).not.toContain(WS_CLOSE_UNAUTHORIZED);
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
    const token = redeemedToken(await redeem(code, origin));
    const credential: DevtoolsCredential = { extensionId, origin, token };

    // The credential works on a DevTools operation: it authenticates, binds its
    // tab and reads the session that tab is bound to.
    const devtools = await bindDevtools(TABS.paired, sessionB, credential);
    expect(devtools.client.authenticated).toBe(true);
    expectSuccess(
      await fetchRaw(targetFor('session.get', sessionB.id), presenting(credential)),
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

  it('locks an origin out after repeated failures, refusing even a valid code, then recovers', async () => {
    const lockedOrigin = chromeExtensionOrigin(newExtensionId());
    const code = await pairStart();
    // A code some other extension has already redeemed.
    const spent = await pairStart();
    redeemedToken(await redeem(spent, chromeExtensionOrigin(newExtensionId())));

    for (let attempt = 1; attempt <= PAIRING_MAX_FAILURES; attempt += 1) {
      expectRefusal(
        await redeem(randomPairingCode(), lockedOrigin),
        'pairing-invalid',
        `failed attempt ${String(attempt)}`,
      );
    }

    // Locked: a valid, a wrong and a spent code get the very same answer, so a
    // lockout reveals nothing about any code. The lockout is its own verdict —
    // a rate limit the caller's own failures earned, decided before the code is
    // looked at — which is why it is the one pairing refusal that differs from
    // the uniform "invalid code" reply the next case pins.
    const withValid = await redeem(code, lockedOrigin);
    const withWrong = await redeem(randomPairingCode(), lockedOrigin);
    const withSpent = await redeem(spent, lockedOrigin);
    expectRefusal(withValid, 'pairing-locked', 'the valid code during a lockout');
    const locked = AUTH_FAILURE_REASONS['pairing-locked'];
    for (const response of [withValid, withWrong, withSpent]) {
      expect(refusalShape(response)).toEqual({
        status: locked.status,
        code: locked.code,
        message: locked.message,
      });
    }

    // The lockout is the origin's, not everyone's.
    expectRefusal(
      await redeem(randomPairingCode(), chromeExtensionOrigin(newExtensionId())),
      'pairing-invalid',
      'another origin during the lockout',
    );

    // Once the window passes, the still-valid code redeems.
    requireClock().advance(PAIRING_LOCKOUT_MS + 1);
    redeemedToken(await redeem(code, lockedOrigin));
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

    // Another tab's credential, bound to a different session, acts on nothing of sessionA.
    for (const operation of DEVTOOLS_OPERATIONS) {
      expectRefusal(
        await fetchRaw(targetFor(operation, sessionA.id), {
          ...presenting(other.credential),
          body: requestBodyFor(operation),
        }),
        'session-not-bound',
        `another tab → ${operation}`,
      );
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
    const ownInit = presenting(own.credential);
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
        ...presenting(other.credential),
        body: requestBodyFor('panel.data'),
      }),
      'panel.data',
    );
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
        await fetchRaw(
          { path: DEV_SERVER_CREDENTIAL_PATH },
          { method: DEV_SERVER_CREDENTIAL_METHOD, body: { projectRoot } },
        ),
        'project-out-of-scope',
        'a dev-server credential outside the announced workspace',
      );
    }

    // A traversal that starts inside the workspace folder and climbs back out of
    // it. Session creation normalises the root and judges the result against the
    // scope; the dev-server routes refuse a `..` spelling before they get that far.
    // Either way the refusal names the project boundary and nothing is created.
    const climbing = `${projectA}/../${basename(projectA)}-evil`;
    expectRefusal(
      await fetchRaw('session.create', { body: { projectRoot: climbing, question: QUESTION } }),
      'project-out-of-scope',
      'session.create through a traversal',
    );
    for (const refused of [
      await fetchRaw('devServer.launch', { body: { projectRoot: climbing } }),
      await fetchRaw(
        { path: DEV_SERVER_CREDENTIAL_PATH },
        { method: DEV_SERVER_CREDENTIAL_METHOD, body: { projectRoot: climbing } },
      ),
    ]) {
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      expect(refusalShape(refused).code).toBe(AUTH_FAILURE_REASONS['project-out-of-scope'].code);
    }

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

    // … and only for as long as that connection lives.
    await announcing.close();
    await waitUntil(async () => {
      const response = await fetchRaw(targetFor('session.get', created.id));
      return response.status === AUTH_FAILURE_REASONS['project-out-of-scope'].status
        ? response
        : undefined;
    }, 'the closed connection no longer lends its folder to the editor credential');
    expectRefusal(
      await fetchRaw('session.create', { body: { projectRoot: projectC, question: QUESTION } }),
      'project-out-of-scope',
      'session.create after the announcing connection closed',
    );
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
 * Rotation and revocation
 * ---------------------------------------------------------------------------------------------- */

describe('rotation and revocation', () => {
  it('revokes every credential, closes every socket with WS_CLOSE_UNAUTHORIZED and regenerates auth.json', async () => {
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

    const outcome = harness.rotateAll();
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
    const newEditorToken = track('editor credential', harness.refreshEditorToken());
    expect(sha256Hex(newEditorToken)).not.toBe(sha256Hex(oldEditorToken));
    expect(remaining.has(sha256Hex(newEditorToken))).toBe(true);

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
