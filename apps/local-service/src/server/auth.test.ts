/**
 * Colocated unit suite for `./auth.ts` — the local service's access boundary
 * (AAP §0.5.6): the credential rules, the origin policy and the role and scope
 * matrix that every route and every socket of the service consumes.
 *
 * This suite pins the **decisions**. The transport versions of the same rules —
 * an unauthenticated request refused over the wire, pairing across real
 * sockets, rotation closing live connections — belong to
 * `test/integration/auth.test.ts`; nothing here starts an HTTP server or opens a
 * socket.
 *
 * Five habits are deliberate, and each one exists because a gap here becomes a
 * false claim in `docs/SECURITY.md`.
 *
 * 1. **The real store and the real schema.** Every test opens `openStore`
 *    against an `mkdtemp` sandbox that is also the test's `$DEBUGGEN_HOME`, so
 *    the `credentials` and `pairing_codes` tables are the ones `schema.sql`
 *    declares and the migration ladder applies. Rows are read back raw, with
 *    SQL, precisely so that the "stored only as a hash" rule is checked against
 *    what is actually on disk rather than against what a repository reports.
 * 2. **Injected seams, never patched globals.** The clock, the randomness
 *    source, the revoker and the logger are the module's own `createAuthService`
 *    dependencies. The clock is a manual counter; the randomness is a
 *    counter-seeded SHA-256 stream, which makes every token and pairing code
 *    reproducible and also lets one test step *inside* a redemption to stage a
 *    genuine double-redemption race. Two tests keep the real CSPRNG.
 * 3. **Protocol is imported, never restated.** The exempt operations, the
 *    close code, the hello deadline, the protocol version and the hello schema
 *    come from `@debuggen/protocol`; the failure table, the pairing constants
 *    and the role table come from `./auth.js`. Assertions are made against
 *    those imports, so a changed constant changes the expectation with it.
 * 4. **No secret is written in this file.** `scripts/check-secrets.mjs` scans
 *    it, so every token, digest and pairing code is generated at run time — by
 *    the module under test or by the injected source — and every negative case
 *    is assembled from innocuous parts.
 * 5. **Nothing presented or issued leaks.** Every plaintext credential, pairing
 *    code and `auth.json` body the suite sees is remembered. Every refusal is
 *    checked for all of them in each of its serialised forms, and after the
 *    last test every log record the suite captured is scanned for them too.
 */

import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_HEADER,
  AUTH_EXEMPT_OPERATIONS,
  CLIENT_HELLO_TIMEOUT_MS,
  HTTP_OPERATIONS,
  PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  clientHelloPayloadSchema,
  formatBearer,
  isAuthExemptOperation,
  isCompatibleProtocolVersion,
} from '@debuggen/protocol';
import type { ClientKind, HttpOperationId } from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  createConsoleLogger,
  isErr,
  isOk,
  newSessionId,
  unwrap,
} from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';

import { loadServiceConfig } from '../config.js';
import type { ServiceConfig } from '../config.js';
import { openStore } from '../store/db.js';
import type { Store } from '../store/db.js';
import {
  AUTH_FAILURE_REASONS,
  CREDENTIAL_ROLES,
  CREDENTIAL_TOKEN_BYTES,
  OPERATION_ROLES,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_MAX_REDEMPTIONS,
  PAIRING_CODE_TTL_MS,
  PAIRING_GLOBAL_MAX_FAILURES,
  PAIRING_LOCKOUT_MS,
  PAIRING_MAX_FAILURES,
  authErrorResponse,
  authFailureReasonOf,
  authFailureStatus,
  authFileSchema,
  classifyOrigin,
  createAuthService,
  isAllowedOrigin,
  requireBoundSession,
  requireProjectScope,
  requireRole,
  requireSessionAccess,
  roleForClientKind,
} from './auth.js';
import type {
  AuthFailureReason,
  AuthFileRecord,
  AuthService,
  AuthenticatedOperation,
  ConnectionRevoker,
  DevtoolsPrincipal,
  EditorPrincipal,
  HeaderSource,
  IssuedCredential,
  Principal,
  PrincipalRole,
  ServerAgentPrincipal,
  TabBinding,
} from './auth.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures that are not secrets
 * ---------------------------------------------------------------------------------------------- */

/** An arbitrary fixed instant the injected clock starts from, in epoch milliseconds. */
const START_TIME = Date.UTC(2026, 0, 15, 9, 30);

/** The Chrome extension id the suite pairs as. Hyphenated ids are what development builds use. */
const EXTENSION_ID = 'debuggen-panel-under-test';

/** A second, unrelated extension id. */
const OTHER_EXTENSION_ID = 'another-panel-under-test';

/** A VS Code webview origin. */
const WEBVIEW_ORIGIN = 'vscode-webview://debuggen-webview-under-test';

/** The host every near-miss origin is really served from. */
const ATTACKER_HOST = 'attacker.example';

/** The `chrome-extension://<id>` origin of an extension id. */
function extensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}`;
}

/* -------------------------------------------------------------------------------------------------
 * Suite-wide leak bookkeeping
 * ---------------------------------------------------------------------------------------------- */

/** Every plaintext credential, pairing code and `auth.json` body the suite has seen. */
const secrets = new Set<string>();

/** Every log record any service in the suite emitted, serialised at the moment it was emitted. */
const capturedLogLines: string[] = [];

/** Remembers a plaintext secret so every later leak check looks for it, and returns it. */
function remember(secret: string): string {
  secrets.add(secret);
  return secret;
}

/** A logger that records everything at every level, as the service would emit it. */
function captureLogger(): Logger {
  return createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      capturedLogLines.push(JSON.stringify(record));
    },
  });
}

/**
 * Every textual surface a refusal can reach: its message, hint and stack, the
 * error itself through `JSON.stringify`, its wire payload, its diagnostic
 * details and the HTTP response the middleware would send for it.
 */
function serializedForms(error: DebuggenError): readonly string[] {
  return [
    error.message,
    error.hint ?? '',
    error.stack ?? '',
    JSON.stringify(error),
    JSON.stringify(error.toPayload()),
    JSON.stringify(error.details ?? {}),
    JSON.stringify(authErrorResponse(error)),
  ];
}

/**
 * Asserts that none of `texts` contains any presented value or any secret the
 * suite has seen. The failure names only counts, so a leak is reported without
 * being repeated into the test output.
 */
function expectNoLeak(texts: readonly string[], presented: readonly string[] = []): void {
  const needles = [...presented.filter((value) => value.length > 0), ...secrets];
  let leaks = 0;
  for (const text of texts) {
    for (const needle of needles) {
      if (text.includes(needle)) {
        leaks += 1;
      }
    }
  }
  expect(leaks, 'a serialised surface carried a presented or issued secret').toBe(0);
}

/** Three distinct twelve-character windows of a credential, for "no part of it" checks. */
function fragmentsOf(token: string): readonly string[] {
  const window = 12;
  const middle = Math.max(0, Math.floor(token.length / 2) - window / 2);
  return [
    token,
    token.slice(0, window),
    token.slice(middle, middle + window),
    token.slice(-window),
  ];
}

/* -------------------------------------------------------------------------------------------------
 * Result helpers
 * ---------------------------------------------------------------------------------------------- */

/** Unwraps an `Ok`, failing the test with the refusal's code and reason (never its message). */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (isErr(result)) {
    throw new Error(
      `expected Ok, got ${result.error.code} (${authFailureReasonOf(result.error) ?? 'not a refusal'})`,
    );
  }
  return result.value;
}

/**
 * Asserts that `result` is the refusal for `reason` and returns its error.
 *
 * Checks, for every refusal in the suite: it is an `Err` carrying a genuine
 * `DebuggenError`; its code is in the closed `DEBUGGEN_ERROR_CODES` set and is
 * the one `AUTH_FAILURE_REASONS` assigns to the reason; its status maps back
 * from the error alone; and no serialised surface carries the presented values
 * or any secret the suite has seen.
 */
function expectRefusal<T>(
  result: Result<T, DebuggenError>,
  reason: AuthFailureReason,
  presented: readonly string[] = [],
): DebuggenError {
  if (!isErr(result)) {
    throw new Error(`expected the "${reason}" refusal, got Ok`);
  }
  const { error } = result;
  expect(DebuggenError.is(error)).toBe(true);
  expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
  expect(authFailureReasonOf(error)).toBe(reason);
  expect(error.code).toBe(AUTH_FAILURE_REASONS[reason].code);
  expect(authFailureStatus(error)).toBe(AUTH_FAILURE_REASONS[reason].status);
  expect(authErrorResponse(error).status).toBe(AUTH_FAILURE_REASONS[reason].status);
  expectNoLeak(serializedForms(error), presented);
  return error;
}

/**
 * Asserts that `result` is a failure that is not an access-boundary refusal —
 * a store, filesystem or randomness failure — with the given code.
 */
function expectFailure<T>(
  result: Result<T, DebuggenError>,
  code: DebuggenError['code'],
): DebuggenError {
  if (!isErr(result)) {
    throw new Error(`expected a ${code} failure, got Ok`);
  }
  const { error } = result;
  expect(DebuggenError.is(error)).toBe(true);
  expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
  expect(error.code).toBe(code);
  expect(authFailureReasonOf(error)).toBeUndefined();
  expect(authErrorResponse(error).status).toBe(500);
  expectNoLeak(serializedForms(error));
  return error;
}

/* -------------------------------------------------------------------------------------------------
 * Injected seams
 * ---------------------------------------------------------------------------------------------- */

/** A clock that moves only when a test says so. */
class ManualClock {
  #now = START_TIME;

  /** The current instant, in epoch milliseconds. */
  get now(): number {
    return this.#now;
  }

  /** The clock as the module consumes it. */
  readonly read = (): number => this.#now;

  /** Moves the clock forward by `ms`. */
  advance(ms: number): void {
    this.#now += ms;
  }
}

/** A deterministic randomness source with one scripted interruption point. */
interface ScriptedRandom {
  /** The source handed to `createAuthService`. */
  readonly source: (size: number) => Uint8Array;
  /**
   * Runs `hook` once, at the start of the next draw of exactly `size` bytes,
   * before those bytes are produced.
   */
  armOnce(size: number, hook: () => void): void;
}

/**
 * A counter-seeded SHA-256 byte stream: reproducible across runs, distinct on
 * every draw, and different per `label`, so two services never mint the same
 * token even when they share a sandbox.
 */
function scriptedRandom(label: string): ScriptedRandom {
  let counter = 0;
  let armed: { readonly size: number; readonly hook: () => void } | undefined;
  const source = (size: number): Uint8Array => {
    const pending = armed;
    if (pending?.size === size) {
      armed = undefined;
      pending.hook();
    }
    const bytes = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const block = createHash('sha256')
        .update(`${label}:${String(counter)}`)
        .digest();
      counter += 1;
      const take = Math.min(block.length, size - filled);
      bytes.set(block.subarray(0, take), filled);
      filled += take;
    }
    return bytes;
  };
  return {
    source,
    armOnce(size, hook) {
      armed = { size, hook };
    },
  };
}

/** One call the service made on its revoker. */
interface RevocationCall {
  readonly code: number;
  readonly reason: string | undefined;
}

/** A `ConnectionRevoker` that records every call and reports a fixed number of closed sockets. */
class RecordingRevoker implements ConnectionRevoker {
  readonly calls: RevocationCall[] = [];

  readonly #closes: number;

  constructor(closes: number) {
    this.#closes = closes;
  }

  revokeAll(code: number, reason?: string): number {
    this.calls.push({ code, reason });
    return this.#closes;
  }
}

/* -------------------------------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------------------------------- */

/** Everything one test's primary service is built from. */
interface Harness {
  /** The per-test `mkdtemp` directory, which is also `$DEBUGGEN_HOME`. */
  readonly sandbox: string;
  readonly config: ServiceConfig;
  readonly store: Store;
  readonly clock: ManualClock;
  readonly random: ScriptedRandom;
  readonly revoker: RecordingRevoker;
  readonly auth: AuthService;
}

/** How many sockets the recording revoker claims to close on each call. */
const OPEN_SOCKETS = 3;

/** Closers for every store and service a test opened, run in reverse order after it. */
const cleanups: (() => void)[] = [];

/** Every sandbox a test created, removed (and proved removed) after it. */
const sandboxes: string[] = [];

/** Creates a private sandbox directory; `mkdtemp` creates it `0700`. */
function openSandbox(): string {
  const directory = mkdtempSync(join(tmpdir(), 'debuggen-auth-'));
  sandboxes.push(directory);
  return directory;
}

/**
 * The service configuration for a sandbox, built through the real loader with
 * an injected environment — it never reads `process.env` — so the derived
 * `authFilePath` and `databasePath` are the product's own spelling.
 */
function configFor(home: string): ServiceConfig {
  const config = unwrap(loadServiceConfig({}, { homeDir: home, debuggenHome: home }));
  expect(config.debuggenHome).toBe(home);
  expect(config.authFilePath.startsWith(`${home}/`)).toBe(true);
  expect(config.databasePath.startsWith(`${home}/`)).toBe(true);
  return config;
}

/** Opens a store and registers it for closing. */
function openTrackedStore(options: Parameters<typeof openStore>[0]): Store {
  const store = unwrap(openStore(options));
  cleanups.push(() => {
    store.close();
  });
  return store;
}

/** What {@link createService} may vary. */
interface ServiceOptions {
  readonly store: Store;
  readonly config: Pick<ServiceConfig, 'authFilePath' | 'debuggenHome'>;
  readonly clock?: ManualClock;
  /** A scripted source, or `'csprng'` to leave the module's default in place. */
  readonly random?: ScriptedRandom | 'csprng';
  readonly revoker?: ConnectionRevoker;
}

/** How many services have been built without an explicit source, so each gets its own stream. */
let unlabelledServices = 0;

/** Builds a service over the given store, registers it for closing, and returns it. */
function createService(options: ServiceOptions): AuthService {
  const clock = options.clock ?? new ManualClock();
  unlabelledServices += 1;
  const random = options.random ?? scriptedRandom(`service-${String(unlabelledServices)}`);
  const auth = expectOk(
    createAuthService({
      store: options.store,
      config: options.config,
      logger: captureLogger(),
      revoker: options.revoker,
      now: clock.read,
      randomBytes: random === 'csprng' ? undefined : random.source,
    }),
  );
  cleanups.push(() => {
    auth.close();
  });
  return auth;
}

/** Builds a complete, isolated harness: sandbox, configuration, real store and service. */
function createHarness(label: string, random: 'scripted' | 'csprng' = 'scripted'): Harness {
  const sandbox = openSandbox();
  const config = configFor(sandbox);
  const store = openTrackedStore({ config, logger: captureLogger() });
  const clock = new ManualClock();
  const scripted = scriptedRandom(label);
  const revoker = new RecordingRevoker(OPEN_SOCKETS);
  const auth = createService({
    store,
    config,
    clock,
    random: random === 'csprng' ? 'csprng' : scripted,
    revoker,
  });
  return { sandbox, config, store, clock, random: scripted, revoker, auth };
}

let harness: Harness;

beforeEach(() => {
  harness = createHarness('primary');
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  for (const directory of sandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
    expect(existsSync(directory)).toBe(false);
  }
});

afterAll(() => {
  // The single end-of-suite scan: no record any service emitted, at any level,
  // carries a plaintext credential, an Authorization value or a pairing code.
  // The two non-empty checks keep the scan from passing vacuously.
  expect(capturedLogLines.length).toBeGreaterThan(0);
  expect(secrets.size).toBeGreaterThan(0);
  const authorizationValues = [...secrets].map((secret) => formatBearer(secret));
  expectNoLeak(capturedLogLines, authorizationValues);
});

/* -------------------------------------------------------------------------------------------------
 * Credential, request and row helpers
 * ---------------------------------------------------------------------------------------------- */

/** Reads `auth.json` through the module's own schema, remembering its body and token. */
function readAuthFile(config: Pick<ServiceConfig, 'authFilePath'>): AuthFileRecord {
  const text = remember(readFileSync(config.authFilePath, 'utf8'));
  const json: unknown = JSON.parse(text);
  const record = authFileSchema.parse(json);
  remember(record.token);
  return record;
}

/** The permission bits of a file. */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Ensures the editor credential and returns its plaintext, read from `auth.json`. */
function editorToken(h: Harness = harness): string {
  expectOk(h.auth.ensureEditorCredential());
  return readAuthFile(h.config).token;
}

/** Pairs a DevTools client through the real pairing flow and returns its credential. */
function pairDevtools(h: Harness = harness, extensionId: string = EXTENSION_ID): string {
  const { code } = expectOk(h.auth.startPairing());
  remember(code);
  const issued = expectOk(h.auth.completePairing({ code, origin: extensionOrigin(extensionId) }));
  return remember(issued.token);
}

/** Issues a server-agent credential scoped to `projectRoot` and returns its plaintext. */
function serverAgentToken(projectRoot: string, expiresAt?: number, h: Harness = harness): string {
  const issued = expectOk(h.auth.issueServerAgentCredential({ projectRoot, expiresAt }));
  return remember(issued.token);
}

/** A `Headers` object carrying one bearer credential. */
function bearerHeaders(token: string): Headers {
  return new Headers({ [AUTHORIZATION_HEADER]: formatBearer(token) });
}

/** Authorises one HTTP operation with an optional bearer credential and origin. */
function authorize(
  operation: HttpOperationId,
  token: string | undefined,
  origin?: string,
  auth: AuthService = harness.auth,
): Result<Principal | null, DebuggenError> {
  return auth.authorizeHttpRequest({
    headers: token === undefined ? new Headers() : bearerHeaders(token),
    origin,
    operation,
  });
}

/** The optional claims a `client.hello` may make. */
interface HelloClaims {
  readonly projectRoot?: string;
  readonly tabId?: number;
  readonly version?: string;
}

/** A `client.hello` payload, typed on the protocol's client vocabulary. */
function helloPayload(
  client: ClientKind,
  token: string,
  claims: HelloClaims = {},
): Record<string, unknown> {
  return {
    client,
    version: claims.version ?? PROTOCOL_VERSION,
    token,
    ...(claims.projectRoot === undefined ? {} : { projectRoot: claims.projectRoot }),
    ...(claims.tabId === undefined ? {} : { tabId: claims.tabId }),
  };
}

/** Narrows a principal to the editor role, failing the test otherwise. */
function asEditor(principal: Principal | null): EditorPrincipal {
  if (principal?.role !== 'vscode') {
    throw new Error('expected an editor principal');
  }
  return principal;
}

/** Narrows a principal to the DevTools role, failing the test otherwise. */
function asDevtools(principal: Principal | null): DevtoolsPrincipal {
  if (principal?.role !== 'devtools') {
    throw new Error('expected a DevTools principal');
  }
  return principal;
}

/** Narrows a principal to the server-agent role, failing the test otherwise. */
function asServerAgent(principal: Principal | null): ServerAgentPrincipal {
  if (principal?.role !== 'server-agent') {
    throw new Error('expected a server-agent principal');
  }
  return principal;
}

/** Every `credentials` row, raw, exactly as `node:sqlite` stores it. */
function credentialRows(store: Store = harness.store): Record<string, unknown>[] {
  return store.db
    .prepare(
      'SELECT token_hash, role, scope, issued_at, expires_at FROM credentials ORDER BY issued_at, token_hash',
    )
    .all();
}

/** Every `pairing_codes` row, raw. */
function pairingRows(store: Store = harness.store): Record<string, unknown>[] {
  return store.db
    .prepare('SELECT code_hash, expires_at, used FROM pairing_codes ORDER BY expires_at, code_hash')
    .all();
}

/** The one `credentials` row whose digest is `sha256Hex(token)`. */
function rowFor(token: string, store: Store = harness.store): Record<string, unknown> {
  const digest = sha256Hex(token);
  const row = credentialRows(store).find((candidate) => candidate['token_hash'] === digest);
  if (row === undefined) {
    throw new Error('no credentials row holds the digest of this credential');
  }
  return row;
}

/** The stored `scope` column of a row, parsed. */
function storedScope(row: Record<string, unknown>): unknown {
  return JSON.parse(String(row['scope']));
}

/** Absolute project roots inside the sandbox; nothing needs to exist on disk. */
function projectPath(...segments: string[]): string {
  return join(harness.sandbox, 'projects', ...segments);
}

/** The Node timers currently keeping the event loop alive. */
function activeTimerCount(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
}

/* =================================================================================================
 * Construction and lifetime
 * ============================================================================================== */

describe('createAuthService', () => {
  it('refuses an editor credential file that would sit outside the state root', () => {
    const elsewhere = openSandbox();
    const result = createAuthService({
      store: harness.store,
      config: {
        debuggenHome: harness.config.debuggenHome,
        authFilePath: join(elsewhere, 'auth.json'),
      },
      logger: captureLogger(),
    });
    expectFailure(result, 'CONFIG_INVALID');
  });

  it('refuses a credential file that is the state root itself', () => {
    const result = createAuthService({
      store: harness.store,
      config: {
        debuggenHome: harness.config.debuggenHome,
        authFilePath: harness.config.debuggenHome,
      },
      logger: captureLogger(),
    });
    expectFailure(result, 'CONFIG_INVALID');
  });

  it('refuses a store that is already closed', () => {
    const sandbox = openSandbox();
    const store = unwrap(openStore({ config: configFor(sandbox) }));
    store.close();
    const result = createAuthService({
      store,
      config: configFor(sandbox),
      logger: captureLogger(),
    });
    expectFailure(result, 'STORE_ERROR');
  });

  it('starts no timer and keeps no handle alive, even through a lockout and a rotation', () => {
    // Everything below is synchronous, so nothing the runner schedules can
    // change the count between the two readings: any difference is the
    // module's own.
    const timersBefore = activeTimerCount();
    const auth = createService({
      store: harness.store,
      config: harness.config,
      clock: harness.clock,
    });
    expectOk(auth.ensureEditorCredential());
    remember(readAuthFile(harness.config).token);
    remember(expectOk(auth.startPairing()).code);
    for (let attempt = 0; attempt < PAIRING_MAX_FAILURES + 1; attempt += 1) {
      expect(isErr(auth.completePairing({ code: '', origin: extensionOrigin(EXTENSION_ID) }))).toBe(
        true,
      );
    }
    expectOk(auth.rotateAll());
    remember(readAuthFile(harness.config).token);
    auth.close();
    expect(activeTimerCount()).toBe(timersBefore);
  });

  it('reports every store failure as an Err, never as a throw and never as a refusal', () => {
    const token = editorToken();
    const { code } = expectOk(harness.auth.startPairing());
    remember(code);
    harness.store.close();

    expectFailure(harness.auth.ensureEditorCredential(), 'STORE_ERROR');
    expectFailure(authorize('session.list', token), 'STORE_ERROR');
    expectFailure(
      harness.auth.authorizeHello({ payload: helloPayload('vscode', token), origin: undefined }),
      'STORE_ERROR',
    );
    expectFailure(harness.auth.startPairing(), 'STORE_ERROR');
    expectFailure(
      harness.auth.completePairing({ code, origin: extensionOrigin(EXTENSION_ID) }),
      'STORE_ERROR',
    );
    expectFailure(harness.auth.issueDevtoolsCredential(EXTENSION_ID), 'STORE_ERROR');
    expectFailure(
      harness.auth.issueServerAgentCredential({ projectRoot: projectPath('alpha') }),
      'STORE_ERROR',
    );
    expectFailure(harness.auth.revokeServerAgentCredentials(projectPath('alpha')), 'STORE_ERROR');
    expectFailure(harness.auth.rotateAll(), 'STORE_ERROR');
  });

  it('reports a failing or short randomness source as an Err rather than minting a weak credential', () => {
    const throwing = createService({
      store: harness.store,
      config: harness.config,
      random: {
        source: () => {
          throw new Error('entropy unavailable');
        },
        armOnce: () => undefined,
      },
    });
    expectFailure(throwing.ensureEditorCredential(), 'INTERNAL');
    expectFailure(throwing.startPairing(), 'INTERNAL');

    const short = createService({
      store: harness.store,
      config: harness.config,
      random: { source: () => new Uint8Array(1), armOnce: () => undefined },
    });
    expectFailure(short.ensureEditorCredential(), 'INTERNAL');
    expectFailure(short.issueDevtoolsCredential(EXTENSION_ID), 'INTERNAL');
    expect(credentialRows()).toHaveLength(0);
    expect(existsSync(harness.config.authFilePath)).toBe(false);
  });
});

/* =================================================================================================
 * The editor credential and auth.json
 * ============================================================================================== */

describe('the editor credential and auth.json', () => {
  it('mints a 32-byte credential on first start, writes auth.json 0600 and stores only its digest', () => {
    expect(existsSync(harness.config.authFilePath)).toBe(false);
    const state = expectOk(harness.auth.ensureEditorCredential());

    expect(state.created).toBe(true);
    expect(state.principal.role).toBe(roleForClientKind('vscode'));
    expect(CREDENTIAL_ROLES).toContain(state.principal.role);
    expect(state.principal.scope).toEqual({ kind: 'machine-user', workspaceFolders: [] });
    expect(state.principal.issuedAt).toBe(harness.clock.now);
    expect(state.principal).not.toHaveProperty('expiresAt');
    expect(modeOf(harness.config.authFilePath)).toBe(0o600);

    const record = readAuthFile(harness.config);
    expect(record.issuedAt).toBe(harness.clock.now);
    const decoded = Buffer.from(record.token, 'base64url');
    expect(decoded).toHaveLength(CREDENTIAL_TOKEN_BYTES);
    expect(decoded.toString('base64url')).toBe(record.token);
    expect(state.principal.tokenHash).toBe(sha256Hex(record.token));

    const rows = credentialRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.['role']).toBe(state.principal.role);
    expect(row?.['token_hash']).toBe(sha256Hex(record.token));
    expect(row?.['issued_at']).toBe(harness.clock.now);
    expect(row?.['expires_at']).toBeNull();
    expect(row === undefined ? undefined : storedScope(row)).toEqual({ kind: 'machine-user' });
  });

  it('is idempotent: a second start adopts the same credential and rewrites nothing', () => {
    const first = expectOk(harness.auth.ensureEditorCredential());
    const textBefore = readFileSync(harness.config.authFilePath, 'utf8');
    const mtimeBefore = statSync(harness.config.authFilePath).mtimeMs;
    harness.clock.advance(60_000);

    const second = expectOk(harness.auth.ensureEditorCredential());
    expect(second.created).toBe(false);
    expect(second.principal.tokenHash).toBe(first.principal.tokenHash);
    expect(second.principal.issuedAt).toBe(first.principal.issuedAt);
    expect(credentialRows()).toHaveLength(1);
    expect(readFileSync(harness.config.authFilePath, 'utf8')).toBe(textBefore);
    expect(statSync(harness.config.authFilePath).mtimeMs).toBe(mtimeBefore);
    expect(modeOf(harness.config.authFilePath)).toBe(0o600);
    remember(textBefore);
  });

  it('re-registers a stale auth.json whose credential has no live row instead of failing', () => {
    const token = editorToken();
    const fileBefore = readFileSync(harness.config.authFilePath, 'utf8');

    // The store is replaced under the file: a fresh database in the same state
    // root, as a purge or a deleted sessions.sqlite would leave it.
    const replacement = openTrackedStore({
      databasePath: join(harness.sandbox, 'replacement.sqlite'),
      logger: captureLogger(),
    });
    expect(credentialRows(replacement)).toHaveLength(0);
    const restarted = createService({ store: replacement, config: harness.config });

    const state = expectOk(restarted.ensureEditorCredential());
    expect(state.created).toBe(false);
    expect(state.principal.tokenHash).toBe(sha256Hex(token));
    expect(readFileSync(harness.config.authFilePath, 'utf8')).toBe(fileBefore);
    const rows = credentialRows(replacement);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['token_hash']).toBe(sha256Hex(token));
    expect(rows[0]?.['role']).toBe(state.principal.role);
    expect(
      asEditor(expectOk(authorize('session.list', token, undefined, restarted))).tokenHash,
    ).toBe(sha256Hex(token));
  });

  it('discards an auth.json another account could read and issues a new credential', () => {
    const exposed = editorToken();
    chmodSync(harness.config.authFilePath, 0o640);

    const state = expectOk(harness.auth.ensureEditorCredential());
    expect(state.created).toBe(true);
    const fresh = readAuthFile(harness.config).token;
    expect(fresh).not.toBe(exposed);
    expect(modeOf(harness.config.authFilePath)).toBe(0o600);
    expect(credentialRows()).toHaveLength(1);
    expectRefusal(authorize('session.list', exposed), 'unknown-credential', [exposed]);
    expectOk(authorize('session.list', fresh));
  });

  it('replaces an auth.json that is not a record this service wrote', () => {
    writeFileSync(harness.config.authFilePath, '{ "version": "not-a-record" ', { mode: 0o600 });
    const state = expectOk(harness.auth.ensureEditorCredential());
    expect(state.created).toBe(true);
    expect(
      authFileSchema.safeParse(JSON.parse(readFileSync(harness.config.authFilePath, 'utf8')))
        .success,
    ).toBe(true);
    remember(readAuthFile(harness.config).token);
    expect(modeOf(harness.config.authFilePath)).toBe(0o600);
  });

  it('draws from the real CSPRNG by default, so two services mint different credentials', () => {
    const left = createHarness('left', 'csprng');
    const right = createHarness('right', 'csprng');
    const leftToken = editorToken(left);
    const rightToken = editorToken(right);

    expect(leftToken).not.toBe(rightToken);
    expect(Buffer.from(leftToken, 'base64url')).toHaveLength(CREDENTIAL_TOKEN_BYTES);
    expect(Buffer.from(rightToken, 'base64url')).toHaveLength(CREDENTIAL_TOKEN_BYTES);
    expect(sha256Hex(leftToken)).not.toBe(sha256Hex(rightToken));
    // A credential of one service means nothing to another.
    expectRefusal(
      authorize('session.list', leftToken, undefined, right.auth),
      'unknown-credential',
      [leftToken],
    );
  });

  it('mints a distinct credential for every issuance on the real CSPRNG', () => {
    const csprng = createHarness('csprng-issuance', 'csprng');
    const issued = new Set<string>();
    for (let index = 0; index < 8; index += 1) {
      issued.add(remember(expectOk(csprng.auth.issueDevtoolsCredential(EXTENSION_ID)).token));
    }
    expect(issued.size).toBe(8);
    expect(credentialRows(csprng.store)).toHaveLength(8);
  });
});

/* =================================================================================================
 * The origin policy
 * ============================================================================================== */

/** One labelled `Origin` value. */
interface OriginCase {
  readonly label: string;
  readonly origin: string | undefined;
}

/** Origins the policy accepts, with the class each is judged to be. */
const ACCEPTED_ORIGINS: readonly (OriginCase & { readonly kind: string })[] = [
  { label: 'no Origin header (a Node client)', origin: undefined, kind: 'absent' },
  { label: 'an empty Origin header', origin: '', kind: 'absent' },
  {
    label: 'the Chrome extension',
    origin: extensionOrigin(EXTENSION_ID),
    kind: 'chrome-extension',
  },
  { label: 'a VS Code webview', origin: WEBVIEW_ORIGIN, kind: 'vscode-webview' },
];

/** Origins the policy refuses outright. */
const REFUSED_ORIGINS: readonly OriginCase[] = [
  { label: 'a local dev server', origin: 'http://localhost:3000' },
  { label: 'the service port on loopback', origin: 'http://127.0.0.1:43117' },
  { label: 'a public web page', origin: 'https://example.com' },
  { label: 'a file: document', origin: 'file:///tmp/page.html' },
  { label: 'a data: document', origin: 'data:text/html,hello' },
  { label: 'the opaque origin "null"', origin: 'null' },
  { label: 'an unparseable value', origin: 'not an origin' },
  { label: 'an extension scheme with no id', origin: 'chrome-extension://' },
];

/**
 * Origins a prefix or substring check would wrongly accept. Each is built from
 * the text of an accepted origin — its scheme or the whole value — plus a host
 * the attacker controls, so the list tracks the accepted shapes rather than a
 * second spelling of them.
 */
function nearMissOrigins(): readonly OriginCase[] {
  const accepted = extensionOrigin(EXTENSION_ID);
  const extensionScheme = new URL(accepted).protocol.replace(/:$/, '');
  const webviewScheme = new URL(WEBVIEW_ORIGIN).protocol.replace(/:$/, '');
  return [
    {
      label: 'an https host named after the extension scheme',
      origin: `https://${extensionScheme}.${ATTACKER_HOST}`,
    },
    {
      label: 'an https host embedding the extension id and scheme',
      origin: `https://${EXTENSION_ID}.${extensionScheme}.${ATTACKER_HOST}`,
    },
    {
      label: 'an http host named after the webview scheme',
      origin: `http://${webviewScheme}.${ATTACKER_HOST}`,
    },
    {
      label: 'a web origin whose path spells the extension origin',
      origin: `https://${ATTACKER_HOST}/${accepted}`,
    },
    {
      label: 'the extension origin used as credentials for another host',
      origin: `${accepted}@${ATTACKER_HOST}`,
    },
    {
      label: 'the extension origin extended into another host',
      origin: `${accepted}.${ATTACKER_HOST}`,
    },
    { label: 'the extension origin with a port', origin: `${accepted}:8443` },
    { label: 'the extension origin with a path', origin: `${accepted}/panel.html` },
    { label: 'the extension origin with a fragment', origin: `${accepted}#${ATTACKER_HOST}` },
    { label: 'the webview origin with a query', origin: `${WEBVIEW_ORIGIN}?next=${ATTACKER_HOST}` },
    { label: 'the extension origin behind leading whitespace', origin: ` ${accepted}` },
  ];
}

describe('the origin policy', () => {
  for (const { label, origin, kind } of ACCEPTED_ORIGINS) {
    it(`accepts ${label}`, () => {
      expect(isAllowedOrigin(origin)).toBe(true);
      expect(harness.auth.isAllowedOrigin(origin)).toBe(true);
      expect(classifyOrigin(origin).kind).toBe(kind);
    });
  }

  it('reads the extension id of an accepted extension origin from the parsed host', () => {
    expect(classifyOrigin(extensionOrigin(EXTENSION_ID))).toEqual({
      kind: 'chrome-extension',
      extensionId: EXTENSION_ID,
    });
  });

  for (const { label, origin } of REFUSED_ORIGINS) {
    it(`refuses ${label}, before any credential is looked at`, () => {
      const token = editorToken();
      expect(isAllowedOrigin(origin)).toBe(false);
      expect(harness.auth.isAllowedOrigin(origin)).toBe(false);
      expect(classifyOrigin(origin).kind).toBe('refused');
      expectRefusal(authorize('session.list', token, origin), 'forbidden-origin', [token]);
      expectRefusal(
        harness.auth.authorizeHello({ payload: helloPayload('vscode', token), origin }),
        'forbidden-origin',
        [token],
      );
    });
  }

  for (const { label, origin } of nearMissOrigins()) {
    it(`refuses ${label}, which only a substring comparison would accept`, () => {
      const extensionScheme = new URL(extensionOrigin(EXTENSION_ID)).protocol.replace(/:$/, '');
      const webviewScheme = new URL(WEBVIEW_ORIGIN).protocol.replace(/:$/, '');
      const value = origin ?? '';
      expect(value.includes(extensionScheme) || value.includes(webviewScheme)).toBe(true);
      expect(isAllowedOrigin(origin)).toBe(false);
      expect(classifyOrigin(origin).kind).toBe('refused');

      const token = pairDevtools();
      expectRefusal(authorize('panel.data', token, origin), 'forbidden-origin', [token]);
      const { code } = expectOk(harness.auth.startPairing());
      remember(code);
      expectRefusal(harness.auth.completePairing({ code, origin }), 'forbidden-origin', [code]);
    });
  }

  for (const operation of AUTH_EXEMPT_OPERATIONS) {
    it(`refuses web origins on the auth-exempt operation "${operation}" too`, () => {
      for (const { origin } of [...REFUSED_ORIGINS, ...nearMissOrigins()]) {
        expectRefusal(authorize(operation, undefined, origin), 'forbidden-origin');
      }
      // A credential buys a web origin nothing either.
      const token = editorToken();
      expectRefusal(authorize(operation, token, 'https://example.com'), 'forbidden-origin', [
        token,
      ]);
      // From an accepted origin the same operation needs no credential at all.
      for (const { origin } of ACCEPTED_ORIGINS) {
        expect(expectOk(authorize(operation, undefined, origin))).toBeNull();
      }
    });
  }

  it('refuses a pairing redemption from a web origin before the code is looked at, so it burns nothing', () => {
    const { code } = expectOk(harness.auth.startPairing());
    remember(code);
    for (const { origin } of REFUSED_ORIGINS) {
      expectRefusal(harness.auth.completePairing({ code, origin }), 'forbidden-origin', [code]);
    }
    // More refusals than the lockout threshold, and the code is still unused and
    // the extension is not locked out: a web origin never reaches the ledger.
    expect(REFUSED_ORIGINS.length).toBeGreaterThan(PAIRING_MAX_FAILURES);
    expect(pairingRows()[0]?.['used']).toBe(0);
    const issued = expectOk(
      harness.auth.completePairing({ code, origin: extensionOrigin(EXTENSION_ID) }),
    );
    remember(issued.token);
  });

  it('lets each credential be presented only from the origins its client can have', () => {
    const editor = editorToken();
    const devtools = pairDevtools();
    const agent = serverAgentToken(projectPath('alpha'));

    asEditor(expectOk(authorize('session.list', editor)));
    asEditor(expectOk(authorize('session.list', editor, WEBVIEW_ORIGIN)));
    expectRefusal(
      authorize('session.list', editor, extensionOrigin(EXTENSION_ID)),
      'origin-not-permitted-for-role',
      [editor],
    );

    asDevtools(expectOk(authorize('panel.data', devtools, extensionOrigin(EXTENSION_ID))));
    for (const origin of [undefined, WEBVIEW_ORIGIN, extensionOrigin(OTHER_EXTENSION_ID)]) {
      expectRefusal(authorize('panel.data', devtools, origin), 'origin-not-permitted-for-role', [
        devtools,
      ]);
    }

    asServerAgent(expectOk(authorize('telemetry.event', agent)));
    for (const origin of [WEBVIEW_ORIGIN, extensionOrigin(EXTENSION_ID)]) {
      expectRefusal(authorize('telemetry.event', agent, origin), 'origin-not-permitted-for-role', [
        agent,
      ]);
    }
  });
});

/* =================================================================================================
 * Bearer enforcement
 * ============================================================================================== */

/** Every operation that requires a credential, typed as the role table's keys. */
const AUTHENTICATED_OPERATIONS: readonly AuthenticatedOperation[] = HTTP_OPERATIONS.filter(
  (operation): operation is AuthenticatedOperation => !isAuthExemptOperation(operation),
);

describe('bearer enforcement', () => {
  it('refuses every non-exempt operation that carries no Authorization header', () => {
    expect(AUTHENTICATED_OPERATIONS.length).toBeGreaterThan(0);
    for (const operation of AUTHENTICATED_OPERATIONS) {
      expectRefusal(authorize(operation, undefined), 'missing-credential');
    }
  });

  it('refuses every Authorization header that is not exactly one well-formed bearer credential', () => {
    const token = editorToken();
    const prefix = formatBearer('');
    const repeated = new Headers();
    repeated.append(AUTHORIZATION_HEADER, formatBearer(token));
    repeated.append(AUTHORIZATION_HEADER, formatBearer(token));
    const cases: readonly { readonly label: string; readonly headers: HeaderSource }[] = [
      {
        label: 'another scheme',
        headers: new Headers({ [AUTHORIZATION_HEADER]: `Basic ${token}` }),
      },
      { label: 'the scheme alone', headers: { [AUTHORIZATION_HEADER]: prefix.trim() } },
      { label: 'the scheme and an empty credential', headers: { [AUTHORIZATION_HEADER]: prefix } },
      { label: 'a credential with no scheme', headers: { [AUTHORIZATION_HEADER]: token } },
      {
        label: 'two credentials in one value',
        headers: { [AUTHORIZATION_HEADER]: `${formatBearer(token)} ${token}` },
      },
      {
        label: 'a comma-joined list',
        headers: { [AUTHORIZATION_HEADER]: `${formatBearer(token)},${token}` },
      },
      { label: 'a header sent twice', headers: repeated },
      {
        label: 'two record keys differing only in case',
        headers: {
          [AUTHORIZATION_HEADER]: formatBearer(token),
          [AUTHORIZATION_HEADER.toUpperCase()]: formatBearer(token),
        },
      },
      {
        label: 'an array of values',
        headers: { [AUTHORIZATION_HEADER]: [formatBearer(token), formatBearer(token)] },
      },
      {
        label: "a credential beyond the protocol's length bound",
        headers: { [AUTHORIZATION_HEADER]: formatBearer(token.repeat(16)) },
      },
    ];
    for (const { label, headers } of cases) {
      const result = harness.auth.authorizeHttpRequest({
        headers,
        origin: undefined,
        operation: 'session.list',
      });
      expect(isErr(result), label).toBe(true);
      expectRefusal(result, 'malformed-credential', fragmentsOf(token));
    }
  });

  it('reads the bearer scheme case-insensitively, as RFC 9110 requires', () => {
    const token = editorToken();
    const shouted = `${formatBearer('').toUpperCase()}${token}`;
    const principal = expectOk(
      harness.auth.authorizeHttpRequest({
        headers: { [AUTHORIZATION_HEADER]: shouted },
        origin: undefined,
        operation: 'session.list',
      }),
    );
    expect(asEditor(principal).tokenHash).toBe(sha256Hex(token));
  });

  it('refuses a well-formed credential this service never issued', () => {
    editorToken();
    const forged = remember(cryptoRandomBytes(CREDENTIAL_TOKEN_BYTES).toString('base64url'));
    expectRefusal(authorize('session.list', forged), 'unknown-credential', [forged]);
    expectRefusal(
      harness.auth.authorizeHello({ payload: helloPayload('vscode', forged), origin: undefined }),
      'unknown-credential',
      [forged],
    );
  });

  it('resolves each valid credential to the role and scope of its stored row', () => {
    const root = projectPath('alpha');
    const editor = editorToken();
    const devtools = pairDevtools();
    const agent = serverAgentToken(root);

    const editorPrincipal = asEditor(expectOk(authorize('session.list', editor)));
    const editorRow = rowFor(editor);
    expect(editorPrincipal.role).toBe(editorRow['role']);
    expect(editorPrincipal.tokenHash).toBe(editorRow['token_hash']);
    expect(editorPrincipal.issuedAt).toBe(editorRow['issued_at']);
    expect(storedScope(editorRow)).toEqual({ kind: editorPrincipal.scope.kind });

    const devtoolsPrincipal = asDevtools(
      expectOk(authorize('panel.data', devtools, extensionOrigin(EXTENSION_ID))),
    );
    const devtoolsRow = rowFor(devtools);
    expect(devtoolsPrincipal.role).toBe(devtoolsRow['role']);
    expect(devtoolsPrincipal.tokenHash).toBe(devtoolsRow['token_hash']);
    expect(storedScope(devtoolsRow)).toEqual(devtoolsPrincipal.scope);
    expect(devtoolsPrincipal.scope.extensionId).toBe(EXTENSION_ID);

    const agentPrincipal = asServerAgent(expectOk(authorize('telemetry.event', agent)));
    const agentRow = rowFor(agent);
    expect(agentPrincipal.role).toBe(agentRow['role']);
    expect(agentPrincipal.tokenHash).toBe(agentRow['token_hash']);
    expect(storedScope(agentRow)).toEqual(agentPrincipal.scope);
    expect(agentPrincipal.scope.projectRoot).toBe(root);

    expect(new Set([editorPrincipal.role, devtoolsPrincipal.role, agentPrincipal.role])).toEqual(
      new Set(CREDENTIAL_ROLES),
    );
  });

  it('follows the stored row when it changes, and refuses a row whose role and scope disagree', () => {
    const devtools = pairDevtools();
    const digest = sha256Hex(devtools);
    const rescope = harness.store.db.prepare(
      'UPDATE credentials SET scope = ? WHERE token_hash = ?',
    );
    const rerole = harness.store.db.prepare('UPDATE credentials SET role = ? WHERE token_hash = ?');

    rescope.run(JSON.stringify({ kind: 'extension', extensionId: OTHER_EXTENSION_ID }), digest);
    expectRefusal(
      authorize('panel.data', devtools, extensionOrigin(EXTENSION_ID)),
      'origin-not-permitted-for-role',
      [devtools],
    );
    const moved = asDevtools(
      expectOk(authorize('panel.data', devtools, extensionOrigin(OTHER_EXTENSION_ID))),
    );
    expect(moved.scope.extensionId).toBe(OTHER_EXTENSION_ID);

    rerole.run('server-agent', digest);
    expectRefusal(authorize('telemetry.event', devtools), 'corrupt-credential', [devtools]);

    rerole.run('administrator', digest);
    expectRefusal(authorize('telemetry.event', devtools), 'corrupt-credential', [devtools]);

    rerole.run('devtools', digest);
    rescope.run('not json', digest);
    expectRefusal(
      authorize('panel.data', devtools, extensionOrigin(OTHER_EXTENSION_ID)),
      'corrupt-credential',
      [devtools],
    );
  });

  it('passes exactly the operations of AUTH_EXEMPT_OPERATIONS without a credential, and never with a principal', () => {
    expect(AUTH_EXEMPT_OPERATIONS).toHaveLength(2);
    const exempt = new Set<HttpOperationId>(AUTH_EXEMPT_OPERATIONS);
    const passing = HTTP_OPERATIONS.filter((operation) => isOk(authorize(operation, undefined)));
    expect(new Set(passing)).toEqual(exempt);
    expect(passing).toHaveLength(exempt.size);

    const token = editorToken();
    for (const operation of AUTH_EXEMPT_OPERATIONS) {
      expect(isAuthExemptOperation(operation)).toBe(true);
      expect(expectOk(authorize(operation, undefined))).toBeNull();
      // Presenting a credential anyway resolves nothing: an exempt handler never sees a principal.
      expect(expectOk(authorize(operation, token))).toBeNull();
      expect(Object.hasOwn(OPERATION_ROLES, operation)).toBe(false);
    }

    // The role table and the exemption partition the operation vocabulary.
    for (const operation of HTTP_OPERATIONS) {
      expect(isAuthExemptOperation(operation)).toBe(exempt.has(operation));
      expect(Object.hasOwn(OPERATION_ROLES, operation)).toBe(!exempt.has(operation));
    }
    expect(Object.keys(OPERATION_ROLES)).toHaveLength(HTTP_OPERATIONS.length - exempt.size);
  });

  it('admits each role to exactly the operations OPERATION_ROLES grants it', () => {
    const presented: Readonly<
      Record<PrincipalRole, { token: string; origin: string | undefined }>
    > = {
      vscode: { token: editorToken(), origin: undefined },
      devtools: { token: pairDevtools(), origin: extensionOrigin(EXTENSION_ID) },
      'server-agent': { token: serverAgentToken(projectPath('alpha')), origin: undefined },
    };
    const admitted = new Map<PrincipalRole, number>();
    for (const operation of AUTHENTICATED_OPERATIONS) {
      const permitted: readonly PrincipalRole[] = OPERATION_ROLES[operation];
      for (const role of CREDENTIAL_ROLES) {
        const { token, origin } = presented[role];
        const result = authorize(operation, token, origin);
        if (permitted.includes(role)) {
          expect(expectOk(result)?.role).toBe(role);
          admitted.set(role, (admitted.get(role) ?? 0) + 1);
        } else {
          expectRefusal(result, 'role-not-permitted', [token]);
        }
      }
    }
    for (const role of CREDENTIAL_ROLES) {
      expect(admitted.get(role) ?? 0).toBeGreaterThan(0);
    }
  });

  it('refuses an expiring credential from the instant its expiry is reached', () => {
    const root = projectPath('alpha');
    const expiresAt = harness.clock.now + 1_000;
    const token = serverAgentToken(root, expiresAt);
    expect(rowFor(token)['expires_at']).toBe(expiresAt);

    expect(asServerAgent(expectOk(authorize('telemetry.event', token))).expiresAt).toBe(expiresAt);
    harness.clock.advance(999);
    expectOk(authorize('telemetry.event', token));
    harness.clock.advance(1);
    expectRefusal(authorize('telemetry.event', token), 'expired-credential', [token]);
    expectRefusal(
      harness.auth.authorizeHello({
        payload: helloPayload('server-agent', token),
        origin: undefined,
      }),
      'expired-credential',
      [token],
    );

    // The next start-up sweeps it, after which it is simply unknown.
    editorToken();
    expect(credentialRows().some((row) => row['token_hash'] === sha256Hex(token))).toBe(false);
    expectRefusal(authorize('telemetry.event', token), 'unknown-credential', [token]);
  });

  it('refuses to issue a server-agent credential without an absolute root or with a past expiry', () => {
    expectFailure(
      harness.auth.issueServerAgentCredential({ projectRoot: 'relative/project' }),
      'PROJECT_NOT_FOUND',
    );
    expectFailure(
      harness.auth.issueServerAgentCredential({
        projectRoot: projectPath('alpha'),
        expiresAt: harness.clock.now,
      }),
      'INTERNAL',
    );
    expect(credentialRows()).toHaveLength(0);
  });
});

/* =================================================================================================
 * client.hello
 * ============================================================================================== */

/** The three numeric components of the imported `PROTOCOL_VERSION`. */
function protocolVersionParts(): readonly [number, number, number] {
  const parts = PROTOCOL_VERSION.split('.').map((part) => Number.parseInt(part, 10));
  const [major, minor, patch] = parts;
  if (
    parts.length !== 3 ||
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    parts.some((part) => Number.isNaN(part))
  ) {
    throw new Error('PROTOCOL_VERSION is not a major.minor.patch version');
  }
  return [major, minor, patch];
}

/** A version string from three components. */
function versionOf(major: number, minor: number, patch: number): string {
  return [major, minor, patch].map((part) => String(part)).join('.');
}

describe('client.hello', () => {
  it('authenticates a valid hello for each credential role, with the role its stored row holds', () => {
    const root = projectPath('alpha');
    const workspace = projectPath('workspace');
    const editor = editorToken();
    const devtools = pairDevtools();
    const agent = serverAgentToken(root);

    const editorPrincipal = asEditor(
      expectOk(
        harness.auth.authorizeHello({
          payload: helloPayload('vscode', editor, { projectRoot: workspace }),
          origin: undefined,
        }),
      ),
    );
    expect(editorPrincipal.role).toBe(rowFor(editor)['role']);
    expect(editorPrincipal.tokenHash).toBe(sha256Hex(editor));
    expect(editorPrincipal.scope.workspaceFolders).toEqual([workspace]);
    const fromWebview = asEditor(
      expectOk(
        harness.auth.authorizeHello({
          payload: helloPayload('vscode', editor),
          origin: WEBVIEW_ORIGIN,
        }),
      ),
    );
    expect(fromWebview.scope.workspaceFolders).toEqual([]);

    const devtoolsPrincipal = asDevtools(
      expectOk(
        harness.auth.authorizeHello({
          payload: helloPayload('devtools', devtools, { tabId: 7 }),
          origin: extensionOrigin(EXTENSION_ID),
        }),
      ),
    );
    expect(devtoolsPrincipal.role).toBe(rowFor(devtools)['role']);
    expect(devtoolsPrincipal.tokenHash).toBe(sha256Hex(devtools));
    expect(devtoolsPrincipal.scope.extensionId).toBe(EXTENSION_ID);

    const agentPrincipal = asServerAgent(
      expectOk(
        harness.auth.authorizeHello({
          payload: helloPayload('server-agent', agent, { projectRoot: root }),
          origin: undefined,
        }),
      ),
    );
    expect(agentPrincipal.role).toBe(rowFor(agent)['role']);
    expect(agentPrincipal.scope.projectRoot).toBe(root);
    // The same root in another spelling is the same root; announcing none is allowed.
    expectOk(
      harness.auth.authorizeHello({
        payload: helloPayload('server-agent', agent, { projectRoot: join(root, 'nested', '..') }),
        origin: undefined,
      }),
    );
    expectOk(
      harness.auth.authorizeHello({
        payload: helloPayload('server-agent', agent),
        origin: undefined,
      }),
    );
  });

  it('refuses a hello whose claimed client kind contradicts the role of the credential', () => {
    const editor = editorToken();
    const devtools = pairDevtools();
    const agent = serverAgentToken(projectPath('alpha'));
    const devtoolsOrigin = extensionOrigin(EXTENSION_ID);
    const cases: readonly {
      readonly client: ClientKind;
      readonly token: string;
      readonly origin: string | undefined;
    }[] = [
      { client: 'devtools', token: editor, origin: undefined },
      { client: 'server-agent', token: editor, origin: undefined },
      { client: 'vscode', token: devtools, origin: devtoolsOrigin },
      { client: 'server-agent', token: devtools, origin: devtoolsOrigin },
      { client: 'vscode', token: agent, origin: undefined },
      { client: 'devtools', token: agent, origin: undefined },
      // The page agent holds no credential at all: every credential is refused for it.
      { client: 'agent', token: editor, origin: undefined },
      { client: 'agent', token: devtools, origin: devtoolsOrigin },
      { client: 'agent', token: agent, origin: undefined },
    ];
    expect(roleForClientKind('agent')).toBeUndefined();
    for (const { client, token, origin } of cases) {
      expectRefusal(
        harness.auth.authorizeHello({ payload: helloPayload(client, token), origin }),
        'client-kind-mismatch',
        [token],
      );
    }
  });

  it('refuses a hello whose announcements contradict the scope of the credential', () => {
    const root = projectPath('alpha');
    const editor = editorToken();
    const devtools = pairDevtools();
    const agent = serverAgentToken(root);
    const cases: readonly {
      readonly label: string;
      readonly payload: Record<string, unknown>;
      readonly origin: string | undefined;
    }[] = [
      {
        label: 'a dev server announcing another project',
        payload: helloPayload('server-agent', agent, { projectRoot: projectPath('beta') }),
        origin: undefined,
      },
      {
        label: 'a dev server announcing a sibling that shares its prefix',
        payload: helloPayload('server-agent', agent, { projectRoot: `${root}-sibling` }),
        origin: undefined,
      },
      {
        label: 'a dev server naming a tab',
        payload: helloPayload('server-agent', agent, { tabId: 3 }),
        origin: undefined,
      },
      {
        label: 'an editor naming a tab',
        payload: helloPayload('vscode', editor, { tabId: 3 }),
        origin: undefined,
      },
      {
        label: 'an editor announcing a relative folder',
        payload: helloPayload('vscode', editor, { projectRoot: 'relative/workspace' }),
        origin: undefined,
      },
      {
        label: 'a DevTools client announcing a project root',
        payload: helloPayload('devtools', devtools, { projectRoot: root, tabId: 3 }),
        origin: extensionOrigin(EXTENSION_ID),
      },
    ];
    for (const { label, payload, origin } of cases) {
      const result = harness.auth.authorizeHello({ payload, origin });
      expect(isErr(result), label).toBe(true);
      expectRefusal(result, 'hello-claim-mismatch', [editor, devtools, agent]);
    }
  });

  it('accepts a hello of the same protocol major and refuses one of another major', () => {
    const token = editorToken();
    const [major, minor, patch] = protocolVersionParts();
    const compatible = [
      versionOf(major, minor + 1, patch),
      versionOf(major, minor, patch + 1),
      versionOf(major, minor + 3, 0),
    ];
    const incompatible = [
      versionOf(major + 1, 0, 0),
      versionOf(major + 1, minor, patch),
      ...(major > 0 ? [versionOf(major - 1, minor, patch)] : []),
    ];

    for (const version of compatible) {
      expect(isCompatibleProtocolVersion(version)).toBe(true);
      asEditor(
        expectOk(
          harness.auth.authorizeHello({
            payload: helloPayload('vscode', token, { version }),
            origin: undefined,
          }),
        ),
      );
    }
    for (const version of incompatible) {
      const payload = helloPayload('vscode', token, { version });
      // The frame is well-formed; only the version rule refuses it.
      expect(isCompatibleProtocolVersion(version)).toBe(false);
      expect(clientHelloPayloadSchema.safeParse(payload).success).toBe(true);
      expectRefusal(
        harness.auth.authorizeHello({ payload, origin: undefined }),
        'protocol-incompatible',
        [token],
      );
    }
  });

  it('refuses a malformed hello through the protocol schema without echoing any part of the credential', () => {
    const token = editorToken();
    const valid = helloPayload('vscode', token);
    const cases: readonly { readonly label: string; readonly payload: unknown }[] = [
      { label: 'a sixth key', payload: { ...valid, sessionId: newSessionId() } },
      { label: 'a sixth key named by the credential itself', payload: { ...valid, [token]: true } },
      { label: 'a missing version', payload: { client: 'vscode', token } },
      { label: 'an unknown client kind', payload: { ...valid, client: 'browser' } },
      {
        label: 'a version built around the credential',
        payload: { ...valid, version: `v${token}` },
      },
      { label: 'an oversized credential', payload: { ...valid, token: token.repeat(16) } },
      { label: 'an empty credential', payload: { ...valid, token: '' } },
      { label: 'a credential of the wrong type', payload: { ...valid, token: [token] } },
      { label: 'a tab id that is no tab', payload: { ...valid, tabId: -1 } },
      { label: 'the credential alone', payload: token },
      { label: 'nothing at all', payload: null },
    ];
    for (const { label, payload } of cases) {
      expect(clientHelloPayloadSchema.safeParse(payload).success, label).toBe(false);
      const result = harness.auth.authorizeHello({ payload, origin: undefined });
      expect(isErr(result), label).toBe(true);
      expectRefusal(result, 'hello-invalid', fragmentsOf(token));
    }
  });

  it('judges a credential at the instant its hello is authorised, anywhere inside the hello deadline', () => {
    // A socket upgraded now has CLIENT_HELLO_TIMEOUT_MS to authenticate. A
    // credential that expires inside that window is refused when its hello
    // arrives after the expiry, even though the upgrade happened before it.
    const expiresAt = harness.clock.now + Math.floor(CLIENT_HELLO_TIMEOUT_MS / 2);
    const agent = serverAgentToken(projectPath('alpha'), expiresAt);
    const payload = helloPayload('server-agent', agent);

    expectOk(harness.auth.authorizeHello({ payload, origin: undefined }));
    harness.clock.advance(CLIENT_HELLO_TIMEOUT_MS - 1);
    expect(harness.clock.now).toBeGreaterThanOrEqual(expiresAt);
    expectRefusal(
      harness.auth.authorizeHello({ payload, origin: undefined }),
      'expired-credential',
      [agent],
    );
  });
});

/* =================================================================================================
 * Role and scope authorization
 * ============================================================================================== */

describe('role and scope authorization', () => {
  it('lets a DevTools client act only on the session its own binding points at', () => {
    const first = pairDevtools();
    const second = pairDevtools();
    const origin = extensionOrigin(EXTENSION_ID);
    const firstPrincipal = asDevtools(expectOk(authorize('panel.data', first, origin)));
    const secondPrincipal = asDevtools(expectOk(authorize('panel.data', second, origin)));
    const ownSession = { id: newSessionId(), projectRoot: projectPath('alpha') };
    const otherSession = { id: newSessionId(), projectRoot: projectPath('alpha') };
    const ownBinding: TabBinding = {
      tabId: 11,
      sessionId: ownSession.id,
      boundBy: firstPrincipal.tokenHash,
    };
    const otherBinding: TabBinding = {
      tabId: 12,
      sessionId: otherSession.id,
      boundBy: secondPrincipal.tokenHash,
    };

    expectOk(requireBoundSession(firstPrincipal, ownSession.id, ownBinding));
    expectOk(requireSessionAccess(firstPrincipal, ownSession, ownBinding));

    // A session bound to another tab, by another credential.
    expectRefusal(
      requireBoundSession(firstPrincipal, otherSession.id, otherBinding),
      'session-not-bound',
    );
    expectRefusal(
      requireSessionAccess(firstPrincipal, otherSession, otherBinding),
      'session-not-bound',
    );
    // Its own binding presented for a session it is not bound to.
    expectRefusal(
      requireBoundSession(firstPrincipal, otherSession.id, ownBinding),
      'session-not-bound',
    );
    // A binding to the right session that another credential made.
    expectRefusal(
      requireBoundSession(firstPrincipal, ownSession.id, {
        ...ownBinding,
        boundBy: secondPrincipal.tokenHash,
      }),
      'session-not-bound',
    );
    // No binding at all.
    expectRefusal(
      requireBoundSession(firstPrincipal, ownSession.id, undefined),
      'session-not-bound',
    );
    expectRefusal(requireSessionAccess(firstPrincipal, ownSession), 'session-not-bound');
  });

  it('never lets a DevTools client create or steer a session, or claim a project', () => {
    const devtools = pairDevtools();
    const origin = extensionOrigin(EXTENSION_ID);
    for (const operation of [
      'session.create',
      'session.list',
      'session.question',
      'session.end',
    ] as const) {
      expectRefusal(authorize(operation, devtools, origin), 'role-not-permitted', [devtools]);
    }
    const principal = asDevtools(expectOk(authorize('panel.data', devtools, origin)));
    expectRefusal(requireProjectScope(principal, projectPath('alpha')), 'project-out-of-scope');
    expectRefusal(requireRole(principal, 'vscode'), 'role-not-permitted');
    expectRefusal(harness.auth.announceWorkspace(principal), 'role-not-permitted');
  });

  it('refuses a DevTools credential presented from an extension other than the one that paired', () => {
    const devtools = pairDevtools(harness, EXTENSION_ID);
    expectRefusal(
      authorize('panel.data', devtools, extensionOrigin(OTHER_EXTENSION_ID)),
      'origin-not-permitted-for-role',
      [devtools],
    );
    expectRefusal(
      harness.auth.authorizeHello({
        payload: helloPayload('devtools', devtools, { tabId: 5 }),
        origin: extensionOrigin(OTHER_EXTENSION_ID),
      }),
      'origin-not-permitted-for-role',
      [devtools],
    );
  });

  it('confines a server agent to ingesting for its one project', () => {
    const root = projectPath('alpha');
    const agent = serverAgentToken(root);
    const principal = asServerAgent(expectOk(authorize('telemetry.event', agent)));

    expectOk(requireProjectScope(principal, root));
    expectOk(requireProjectScope(principal, join(root, 'nested', '..')));
    expectOk(requireRole(principal, 'server-agent'));
    for (const outside of [
      projectPath('beta'),
      `${root}-sibling`,
      join(root, 'packages', 'web'),
      join(root, '..', 'beta'),
      'relative/alpha',
    ]) {
      expectRefusal(requireProjectScope(principal, outside), 'project-out-of-scope');
    }

    for (const operation of [
      'session.create',
      'session.get',
      'panel.data',
      'pair.start',
    ] as const) {
      expectRefusal(authorize(operation, agent), 'role-not-permitted', [agent]);
    }
    expectRefusal(
      requireSessionAccess(principal, { id: newSessionId(), projectRoot: root }),
      'role-not-permitted',
    );
  });

  it('confines an editor to the workspace folders its live connection announced, by path containment', () => {
    const editor = editorToken();
    const workspace = projectPath('workspace', 'alpha');
    const hello = asEditor(
      expectOk(
        harness.auth.authorizeHello({
          payload: helloPayload('vscode', editor, { projectRoot: workspace }),
          origin: undefined,
        }),
      ),
    );

    // Before the announcement is recorded, an HTTP request presenting the same
    // credential may act on no project at all.
    const unannounced = asEditor(expectOk(authorize('session.create', editor)));
    expect(unannounced.scope.workspaceFolders).toEqual([]);
    expectRefusal(requireProjectScope(unannounced, workspace), 'project-out-of-scope');

    const announcement = expectOk(harness.auth.announceWorkspace(hello));
    const principal = asEditor(expectOk(authorize('session.create', editor)));
    expect(principal.scope.workspaceFolders).toEqual([workspace]);

    for (const inside of [
      workspace,
      join(workspace, 'packages', 'web'),
      join(workspace, 'packages', '..', 'app'),
      `${workspace}/`,
    ]) {
      expectOk(requireProjectScope(principal, inside));
      expectOk(requireSessionAccess(principal, { id: newSessionId(), projectRoot: inside }));
    }
    for (const outside of [
      projectPath('elsewhere'),
      `${workspace}/../beta`,
      `${workspace}/nested/../../beta`,
      `${workspace}-sibling`,
      `${workspace}sibling`,
      join(workspace, '..'),
      '/',
      'relative/alpha',
      '',
    ]) {
      expectRefusal(requireProjectScope(principal, outside), 'project-out-of-scope');
      expectRefusal(
        requireSessionAccess(principal, { id: newSessionId(), projectRoot: outside }),
        'project-out-of-scope',
      );
    }

    // The announcement lives exactly as long as the connection that made it.
    announcement.release();
    announcement.release();
    const released = asEditor(expectOk(authorize('session.create', editor)));
    expect(released.scope.workspaceFolders).toEqual([]);
    expectRefusal(requireProjectScope(released, workspace), 'project-out-of-scope');
  });

  it('keeps an announced folder while any connection announcing it is still open', () => {
    const editor = editorToken();
    const workspace = projectPath('workspace', 'alpha');
    const hello = asEditor(
      expectOk(
        harness.auth.authorizeHello({
          payload: helloPayload('vscode', editor, { projectRoot: workspace }),
          origin: undefined,
        }),
      ),
    );
    const first = expectOk(harness.auth.announceWorkspace(hello));
    const second = expectOk(harness.auth.announceWorkspace(hello));
    first.release();
    expect(asEditor(expectOk(authorize('session.create', editor))).scope.workspaceFolders).toEqual([
      workspace,
    ]);
    second.release();
    expect(asEditor(expectOk(authorize('session.create', editor))).scope.workspaceFolders).toEqual(
      [],
    );
  });

  it('revokes the server-agent credentials of one project when its dev server exits', () => {
    const alpha = serverAgentToken(projectPath('alpha'));
    const alphaAgain = serverAgentToken(projectPath('alpha'));
    const beta = serverAgentToken(projectPath('beta'));

    expect(
      expectOk(harness.auth.revokeServerAgentCredentials(join(projectPath('alpha'), 'x', '..'))),
    ).toBe(2);
    expectRefusal(authorize('telemetry.event', alpha), 'unknown-credential', [alpha]);
    expectRefusal(authorize('telemetry.event', alphaAgain), 'unknown-credential', [alphaAgain]);
    expectOk(authorize('telemetry.event', beta));
    expectFailure(harness.auth.revokeServerAgentCredentials('relative/alpha'), 'PROJECT_NOT_FOUND');
  });
});

/* =================================================================================================
 * Pairing
 * ============================================================================================== */

/** A well-formed pairing code that differs from `code` in every position. */
function anotherCodeThan(code: string): string {
  return [...code]
    .map((character) =>
      PAIRING_CODE_ALPHABET.charAt(
        (PAIRING_CODE_ALPHABET.indexOf(character) + 1) % PAIRING_CODE_ALPHABET.length,
      ),
    )
    .join('');
}

/** Starts pairing on the primary service and remembers the code. */
function startCode(): string {
  return remember(expectOk(harness.auth.startPairing()).code);
}

describe('pairing', () => {
  const origin = extensionOrigin(EXTENSION_ID);

  it('issues a code of the exported length and alphabet, valid for the exported window, stored only as a digest', () => {
    const issued = expectOk(harness.auth.startPairing());
    const code = remember(issued.code);
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    for (const character of code) {
      expect(PAIRING_CODE_ALPHABET).toContain(character);
    }
    expect(issued.expiresAt).toBe(harness.clock.now + PAIRING_CODE_TTL_MS);

    const rows = pairingRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.['code_hash']).toBe(sha256Hex(code));
    expect(row?.['expires_at']).toBe(issued.expiresAt);
    expect(row?.['used']).toBe(0);
    expectNoLeak([JSON.stringify(rows)], [code]);

    const more = Array.from({ length: 16 }, () => startCode());
    expect(new Set([code, ...more]).size).toBe(more.length + 1);
    for (const next of more) {
      expect(next).toHaveLength(PAIRING_CODE_LENGTH);
      expect([...next].every((character) => PAIRING_CODE_ALPHABET.includes(character))).toBe(true);
    }
  });

  it('redeems a code exactly once, for a DevTools credential scoped to the redeeming extension', () => {
    const code = startCode();
    const issued = expectOk(harness.auth.completePairing({ code, origin }));
    remember(issued.token);
    expect(issued).not.toHaveProperty('expiresAt');
    expect(Buffer.from(issued.token, 'base64url')).toHaveLength(CREDENTIAL_TOKEN_BYTES);

    const principal = asDevtools(expectOk(authorize('panel.data', issued.token, origin)));
    expect(principal.scope).toEqual({ kind: 'extension', extensionId: EXTENSION_ID });
    expect(storedScope(rowFor(issued.token))).toEqual(principal.scope);
    expect(pairingRows()[0]?.['used']).toBe(PAIRING_CODE_MAX_REDEMPTIONS);

    expectRefusal(harness.auth.completePairing({ code, origin }), 'pairing-used', [code]);
    expectRefusal(
      harness.auth.completePairing({ code, origin: extensionOrigin(OTHER_EXTENSION_ID) }),
      'pairing-used',
      [code],
    );
    expect(credentialRows().filter((row) => row['role'] === principal.role)).toHaveLength(1);
  });

  it('accepts the code the way a developer types it: lower case, with surrounding whitespace', () => {
    const code = startCode();
    const issued = expectOk(
      harness.auth.completePairing({ code: `  ${code.toLowerCase()}\t`, origin }),
    );
    asDevtools(expectOk(authorize('panel.data', remember(issued.token), origin)));
  });

  it('refuses a code from the instant its validity window closes', () => {
    const early = startCode();
    const late = startCode();
    const expiresAt = harness.clock.now + PAIRING_CODE_TTL_MS;

    harness.clock.advance(PAIRING_CODE_TTL_MS - 1);
    remember(expectOk(harness.auth.completePairing({ code: early, origin })).token);
    harness.clock.advance(1);
    expect(harness.clock.now).toBe(expiresAt);
    expectRefusal(harness.auth.completePairing({ code: late, origin }), 'pairing-expired', [late]);
    expect(pairingRows().find((row) => row['code_hash'] === sha256Hex(late))?.['used']).toBe(0);
  });

  it('refuses an unknown or malformed code, and below the threshold still accepts the right one', () => {
    const code = startCode();
    const unknown = anotherCodeThan(code);
    expect(unknown).not.toBe(code);
    const malformed = [code.slice(1), `${code}${code.charAt(0)}`, `${code.slice(0, -1)}!`];
    const attempts = [unknown, ...malformed];
    expect(attempts.length).toBeLessThan(PAIRING_MAX_FAILURES);

    for (const attempt of attempts) {
      expectRefusal(harness.auth.completePairing({ code: attempt, origin }), 'pairing-invalid', [
        attempt,
        code,
      ]);
    }
    remember(expectOk(harness.auth.completePairing({ code, origin })).token);
  });

  it('redeems only from the Chrome extension, whose id becomes the credential scope', () => {
    const code = startCode();
    for (const other of [undefined, '', WEBVIEW_ORIGIN]) {
      expectRefusal(
        harness.auth.completePairing({ code, origin: other }),
        'pairing-origin-required',
        [code],
      );
    }
    expect(pairingRows()[0]?.['used']).toBe(0);
    const issued = expectOk(
      harness.auth.completePairing({ code, origin: extensionOrigin(OTHER_EXTENSION_ID) }),
    );
    remember(issued.token);
    expect(
      asDevtools(
        expectOk(authorize('panel.data', issued.token, extensionOrigin(OTHER_EXTENSION_ID))),
      ).scope.extensionId,
    ).toBe(OTHER_EXTENSION_ID);
  });

  it('locks an extension out after consecutive failures, refuses even the right code, then lifts the lock', () => {
    const code = startCode();
    const wrong = anotherCodeThan(code);
    for (let attempt = 0; attempt < PAIRING_MAX_FAILURES; attempt += 1) {
      expectRefusal(harness.auth.completePairing({ code: wrong, origin }), 'pairing-invalid', [
        wrong,
        code,
      ]);
    }

    const locked = expectRefusal(harness.auth.completePairing({ code, origin }), 'pairing-locked', [
      code,
    ]);
    expect(authErrorResponse(locked).status).toBe(AUTH_FAILURE_REASONS['pairing-locked'].status);
    // The lockout burned nothing: the code is still unused.
    expect(pairingRows()[0]?.['used']).toBe(0);

    // Another extension is not affected by this one's lockout.
    const otherCode = startCode();
    remember(
      expectOk(
        harness.auth.completePairing({
          code: otherCode,
          origin: extensionOrigin(OTHER_EXTENSION_ID),
        }),
      ).token,
    );

    harness.clock.advance(PAIRING_LOCKOUT_MS - 1);
    expectRefusal(harness.auth.completePairing({ code, origin }), 'pairing-locked', [code]);
    harness.clock.advance(1);
    remember(expectOk(harness.auth.completePairing({ code, origin })).token);
  });

  it('forgets failures after a success and after a quiet window', () => {
    const below = PAIRING_MAX_FAILURES - 1;
    const failBelowThreshold = (wrong: string): void => {
      for (let attempt = 0; attempt < below; attempt += 1) {
        expectRefusal(harness.auth.completePairing({ code: wrong, origin }), 'pairing-invalid', [
          wrong,
        ]);
      }
    };

    const first = startCode();
    failBelowThreshold(anotherCodeThan(first));
    remember(expectOk(harness.auth.completePairing({ code: first, origin })).token);

    const second = startCode();
    failBelowThreshold(anotherCodeThan(second));
    harness.clock.advance(PAIRING_LOCKOUT_MS + 1);
    failBelowThreshold(anotherCodeThan(second));
    remember(expectOk(harness.auth.completePairing({ code: second, origin })).token);
  });

  it('locks pairing for every origin once failures across forged extension ids reach the global ceiling', () => {
    const code = startCode();
    const wrong = anotherCodeThan(code);
    const perOrigin = PAIRING_MAX_FAILURES - 1;
    let failures = 0;
    let forgedIndex = 0;
    while (failures < PAIRING_GLOBAL_MAX_FAILURES) {
      const forged = extensionOrigin(`forged-panel-${String(forgedIndex)}`);
      for (
        let attempt = 0;
        attempt < perOrigin && failures < PAIRING_GLOBAL_MAX_FAILURES;
        attempt += 1
      ) {
        expectRefusal(
          harness.auth.completePairing({ code: wrong, origin: forged }),
          'pairing-invalid',
          [wrong],
        );
        failures += 1;
      }
      forgedIndex += 1;
    }
    // No forged origin reached its own threshold; the ceiling is what locked.
    expect(forgedIndex).toBeGreaterThan(1);

    expectRefusal(harness.auth.completePairing({ code, origin }), 'pairing-locked', [code]);
    harness.clock.advance(PAIRING_LOCKOUT_MS);
    remember(expectOk(harness.auth.completePairing({ code, origin })).token);
  });

  it('lets exactly one of two racing redemptions of one code win', () => {
    const code = startCode();
    const raced: Result<IssuedCredential, DebuggenError>[] = [];
    // The competing redemption runs inside the first one, after the first has
    // read the code as unused and before it marks the code used: the window a
    // check-then-act implementation would lose.
    harness.random.armOnce(CREDENTIAL_TOKEN_BYTES, () => {
      raced.push(harness.auth.completePairing({ code, origin }));
    });
    raced.push(harness.auth.completePairing({ code, origin }));

    expect(raced).toHaveLength(2);
    const winners = raced.filter((result) => isOk(result));
    expect(winners).toHaveLength(1);
    for (const result of raced) {
      if (isOk(result)) {
        remember(result.value.token);
      } else {
        expectRefusal(result, 'pairing-used', [code]);
      }
    }
    expect(credentialRows().filter((row) => row['role'] === 'devtools')).toHaveLength(1);
    expect(pairingRows()[0]?.['used']).toBe(PAIRING_CODE_MAX_REDEMPTIONS);
  });

  it('lets exactly one redemption win when two store connections share the database', () => {
    const code = startCode();
    const secondStore = openTrackedStore({
      databasePath: harness.config.databasePath,
      logger: captureLogger(),
    });
    const secondProcess = createService({
      store: secondStore,
      config: harness.config,
      random: scriptedRandom('second-process'),
    });
    const raced: Result<IssuedCredential, DebuggenError>[] = [];
    harness.random.armOnce(CREDENTIAL_TOKEN_BYTES, () => {
      raced.push(secondProcess.completePairing({ code, origin }));
    });
    raced.push(harness.auth.completePairing({ code, origin }));

    expect(raced.filter((result) => isOk(result))).toHaveLength(1);
    const [inner, outer] = raced;
    expect(inner !== undefined && isOk(inner)).toBe(true);
    if (inner !== undefined && isOk(inner)) {
      remember(inner.value.token);
      asDevtools(expectOk(authorize('panel.data', inner.value.token, origin)));
    }
    if (outer === undefined) {
      throw new Error('the outer redemption produced no result');
    }
    expectRefusal(outer, 'pairing-used', [code]);
    expect(credentialRows(secondStore).filter((row) => row['role'] === 'devtools')).toHaveLength(1);
  });
});

/* =================================================================================================
 * Rotation
 * ============================================================================================== */

describe('rotation', () => {
  const origin = extensionOrigin(EXTENSION_ID);

  it('deletes every credential, rewrites auth.json 0600 and closes every socket once with WS_CLOSE_UNAUTHORIZED', () => {
    const editor = editorToken();
    const devtools = pairDevtools();
    const agent = serverAgentToken(projectPath('alpha'));
    const pending = startCode();
    const rowsBefore = credentialRows().length;
    expect(rowsBefore).toBe(CREDENTIAL_ROLES.length);
    harness.clock.advance(1_000);

    const outcome = expectOk(harness.auth.rotateAll());
    expect(outcome.credentialsDeleted).toBe(rowsBefore);
    expect(outcome.socketsClosed).toBe(OPEN_SOCKETS);
    expect(harness.revoker.calls).toHaveLength(1);
    expect(harness.revoker.calls[0]?.code).toBe(WS_CLOSE_UNAUTHORIZED);

    const record = readAuthFile(harness.config);
    expect(record.token).not.toBe(editor);
    expect(record.issuedAt).toBe(harness.clock.now);
    expect(Buffer.from(record.token, 'base64url')).toHaveLength(CREDENTIAL_TOKEN_BYTES);
    expect(modeOf(harness.config.authFilePath)).toBe(0o600);

    const rows = credentialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['token_hash']).toBe(sha256Hex(record.token));
    expect(rows[0]?.['role']).toBe(roleForClientKind('vscode'));
    expect(pairingRows()).toHaveLength(0);

    const retired: readonly {
      readonly client: ClientKind;
      readonly token: string;
      readonly operation: HttpOperationId;
      readonly origin: string | undefined;
    }[] = [
      { client: 'vscode', token: editor, operation: 'session.list', origin: undefined },
      { client: 'devtools', token: devtools, operation: 'panel.data', origin },
      { client: 'server-agent', token: agent, operation: 'telemetry.event', origin: undefined },
    ];
    for (const { client, token, operation, origin: presentedFrom } of retired) {
      expectRefusal(authorize(operation, token, presentedFrom), 'unknown-credential', [token]);
      expectRefusal(
        harness.auth.authorizeHello({
          payload: helloPayload(client, token),
          origin: presentedFrom,
        }),
        'unknown-credential',
        [token],
      );
    }
    expectRefusal(harness.auth.completePairing({ code: pending, origin }), 'pairing-invalid', [
      pending,
    ]);

    asEditor(expectOk(authorize('session.list', record.token)));
    const restarted = expectOk(harness.auth.ensureEditorCredential());
    expect(restarted.created).toBe(false);
    expect(restarted.principal.tokenHash).toBe(sha256Hex(record.token));
  });

  it('forces a paired DevTools client to pair again', () => {
    const before = pairDevtools();
    expectOk(harness.auth.rotateAll());
    remember(readAuthFile(harness.config).token);
    expectRefusal(authorize('panel.data', before, origin), 'unknown-credential', [before]);

    const after = pairDevtools();
    expect(after).not.toBe(before);
    asDevtools(expectOk(authorize('panel.data', after, origin)));
  });

  it('drops the workspace announcements of the retired editor credential', () => {
    const editor = editorToken();
    const workspace = projectPath('workspace');
    const hello = asEditor(
      expectOk(
        harness.auth.authorizeHello({
          payload: helloPayload('vscode', editor, { projectRoot: workspace }),
          origin: undefined,
        }),
      ),
    );
    expectOk(harness.auth.announceWorkspace(hello));
    expectOk(harness.auth.rotateAll());
    const rotated = readAuthFile(harness.config).token;
    expect(asEditor(expectOk(authorize('session.create', rotated))).scope.workspaceFolders).toEqual(
      [],
    );
  });

  it('rotates without a revoker, and reports a revoker that fails after the credentials were rotated', () => {
    const editor = editorToken();
    const unwired = createService({
      store: harness.store,
      config: harness.config,
      clock: harness.clock,
    });
    expect(expectOk(unwired.rotateAll()).socketsClosed).toBe(0);
    const afterUnwired = readAuthFile(harness.config).token;
    expectRefusal(authorize('session.list', editor), 'unknown-credential', [editor]);

    const failing = createService({
      store: harness.store,
      config: harness.config,
      clock: harness.clock,
      revoker: {
        revokeAll: () => {
          throw new Error('the socket registry is unavailable');
        },
      },
    });
    expectFailure(failing.rotateAll(), 'INTERNAL');
    const afterFailing = readAuthFile(harness.config).token;
    expect(afterFailing).not.toBe(afterUnwired);
    expectRefusal(authorize('session.list', afterUnwired), 'unknown-credential', [afterUnwired]);
    asEditor(expectOk(authorize('session.list', afterFailing)));
  });
});

/* =================================================================================================
 * What the boundary keeps to itself
 * ============================================================================================== */

describe('what the boundary keeps to itself', () => {
  it('stores credentials and pairing codes only as their SHA-256 digests, in the rows and in the files', () => {
    const tokens = [editorToken(), pairDevtools(), serverAgentToken(projectPath('alpha'))];
    const code = startCode();

    const rows = credentialRows();
    expect(new Set(rows.map((row) => row['token_hash']))).toEqual(
      new Set(tokens.map((token) => sha256Hex(token))),
    );
    const codeRows = pairingRows();
    expect(codeRows.map((row) => row['code_hash'])).toContain(sha256Hex(code));
    expectNoLeak([JSON.stringify(rows), JSON.stringify(codeRows)], [...tokens, code]);

    // Nothing the store wrote to disk — the database and its write-ahead log —
    // holds a plaintext credential or code.
    const files = [harness.config.databasePath, `${harness.config.databasePath}-wal`].filter(
      (path) => existsSync(path),
    );
    expect(files.length).toBeGreaterThan(0);
    expectNoLeak(
      files.map((path) => readFileSync(path).toString('latin1')),
      [...tokens, code],
    );
  });

  it('draws every refusal code from the closed error-code set, answered with 401, 403 or 429', () => {
    const reasons = Object.keys(AUTH_FAILURE_REASONS);
    expect(reasons.length).toBeGreaterThan(0);
    for (const descriptor of Object.values(AUTH_FAILURE_REASONS)) {
      expect(DEBUGGEN_ERROR_CODES).toContain(descriptor.code);
      expect([401, 403, 429]).toContain(descriptor.status);
    }
  });

  it('answers any failure that is not a refusal with a fixed 500 body that echoes nothing', () => {
    const token = editorToken();
    const leaky = new DebuggenError('STORE_ERROR', `a failure quoting ${token}`, { hint: token });
    const response = authErrorResponse(leaky);
    expect(response.status).toBe(500);
    expect(response.body.code).toBe(leaky.code);
    expectNoLeak([JSON.stringify(response)], [token]);
    expect(authFailureStatus(leaky)).toBeUndefined();
  });

  it('logs refusals by their reason, through the auth subsystem, and never by what was presented', () => {
    const firstLine = capturedLogLines.length;
    editorToken();
    const forged = remember(cryptoRandomBytes(CREDENTIAL_TOKEN_BYTES).toString('base64url'));
    expectRefusal(authorize('session.list', forged), 'unknown-credential', [forged]);
    expectRefusal(
      harness.auth.authorizeHello({ payload: helloPayload('vscode', forged), origin: undefined }),
      'unknown-credential',
      [forged],
    );
    const wrongCode = anotherCodeThan(startCode());
    expectRefusal(
      harness.auth.completePairing({ code: wrongCode, origin: extensionOrigin(EXTENSION_ID) }),
      'pairing-invalid',
      [wrongCode],
    );

    const lines = capturedLogLines.slice(firstLine);
    expect(lines.some((line) => line.includes('"reason":"unknown-credential"'))).toBe(true);
    expect(lines.some((line) => line.includes('"reason":"pairing-invalid"'))).toBe(true);
    expect(lines.some((line) => line.includes('"subsystem":"auth"'))).toBe(true);
    expectNoLeak(lines, [forged, formatBearer(forged), wrongCode]);
  });
});
