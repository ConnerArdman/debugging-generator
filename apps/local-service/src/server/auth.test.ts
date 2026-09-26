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
 *    source, the revoker, the logger and the credential-file port are the
 *    module's own `createAuthService` dependencies. The clock is a manual
 *    counter; the randomness is a counter-seeded SHA-256 stream, which makes
 *    every token and pairing code reproducible and also lets one test step
 *    *inside* a redemption to stage a genuine double-redemption race. Two tests
 *    keep the real CSPRNG. The credential-file port wraps the real safe-fs
 *    writer and fails exactly the step of a replacement a test names, and a
 *    per-connection `TEMP` trigger fails a store commit, which is how the
 *    two-resource rotation is interrupted at every point without a mock.
 *    Workspace containment runs against real `mkdtemp` trees with real
 *    symlinks; `requireProjectScope`'s real-path resolver is its own argument,
 *    and a table or failing resolver is passed only for what a real tree cannot
 *    stage on this host (`EACCES` as root, a drive root, a relative answer).
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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTING_TAB_HEADER,
  AUTHORIZATION_HEADER,
  AUTH_EXEMPT_OPERATIONS,
  CLIENT_HELLO_TIMEOUT_MS,
  HTTP_OPERATIONS,
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  READ_PROOF_BYTES,
  READ_PROOF_HEADER,
  READ_PROOF_LENGTH,
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
import type { Logger, RealPathResolver, Result } from '@debuggen/shared';
import { sha256Hex, writeSecureFileAtomic } from '@debuggen/shared/node';

import { loadServiceConfig } from '../config.js';
import type { ServiceConfig } from '../config.js';
import { openStore } from '../store/db.js';
import type { Store } from '../store/db.js';
import {
  AUTH_FAILURE_REASONS,
  AUTH_FILE_STAGE_SUFFIX,
  CREDENTIAL_ROLES,
  CREDENTIAL_TOKEN_BYTES,
  MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS,
  OPERATION_ROLES,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_MAX_REDEMPTIONS,
  PAIRING_CODE_TTL_MS,
  PAIRING_LOCKOUT_MS,
  PAIRING_MAX_FAILURES,
  admitProjectRoot,
  authErrorResponse,
  authFailureReasonOf,
  authFailureStatus,
  authFileSchema,
  classifyOrigin,
  createAuthMiddleware,
  createAuthService,
  isAllowedOrigin,
  reconfirmProjectRoot,
  requireBoundSession,
  requireProjectScope,
  requireRole,
  requireSessionAccess,
  resolveActingTab,
  roleForClientKind,
} from './auth.js';
import type {
  AuthFailureReason,
  AuthFileRecord,
  AuthService,
  AuthenticatedOperation,
  ConnectionRevoker,
  CredentialFileSystem,
  DevtoolsPrincipal,
  EditorCredentialState,
  EditorPrincipal,
  HeaderSource,
  IssuedCredential,
  Principal,
  PrincipalRole,
  ServerAgentPrincipal,
  ServerEnv,
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
  /** A credential-file port; absent to leave the module's real safe-fs writer in place. */
  readonly fileSystem?: CredentialFileSystem;
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
      fileSystem: options.fileSystem,
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

/**
 * Reads an editor credential record — `auth.json` or its journal — through the
 * module's own schema, remembering its body and token.
 */
function readRecordAt(path: string): AuthFileRecord {
  const text = remember(readFileSync(path, 'utf8'));
  const json: unknown = JSON.parse(text);
  const record = authFileSchema.parse(json);
  remember(record.token);
  return record;
}

/** Reads `auth.json` through the module's own schema, remembering its body and token. */
function readAuthFile(config: Pick<ServiceConfig, 'authFilePath'>): AuthFileRecord {
  return readRecordAt(config.authFilePath);
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

/**
 * The read proof pairing issued with each DevTools credential of the suite,
 * keyed by the credential's plaintext. Both are remembered as secrets.
 */
const pairedReadProofs = new Map<string, string>();

/**
 * Pairs a DevTools client through the real pairing flow and returns its
 * credential; the read proof issued with it is kept for {@link readProofOf}.
 */
function pairDevtools(h: Harness = harness, extensionId: string = EXTENSION_ID): string {
  const { code } = expectOk(h.auth.startPairing());
  remember(code);
  const issued = expectOk(h.auth.completePairing({ code, origin: extensionOrigin(extensionId) }));
  pairedReadProofs.set(remember(issued.token), remember(issued.readProof));
  return issued.token;
}

/** The read proof pairing issued with a credential {@link pairDevtools} returned. */
function readProofOf(token: string): string {
  const proof = pairedReadProofs.get(token);
  if (proof === undefined) {
    throw new Error('this credential was not paired by pairDevtools');
  }
  return proof;
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

/**
 * {@link authorize} with extra request headers beside the bearer credential —
 * a `Headers` object, or Node's record form, which can carry one header twice.
 */
function authorizeWith(
  operation: HttpOperationId,
  token: string | undefined,
  extra: Readonly<Record<string, string | readonly string[]>>,
  origin?: string,
): Result<Principal | null, DebuggenError> {
  const record: Record<string, string | readonly string[]> = { ...extra };
  if (token !== undefined) {
    record[AUTHORIZATION_HEADER] = formatBearer(token);
  }
  const single = Object.values(record).every((value) => typeof value === 'string');
  return harness.auth.authorizeHttpRequest({
    headers: single ? new Headers(record as Record<string, string>) : record,
    origin,
    operation,
  });
}

/** A fresh, well-formed read proof, generated at run time and remembered as a secret. */
function newReadProof(): string {
  return remember(cryptoRandomBytes(READ_PROOF_BYTES).toString('base64url'));
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

  // Chrome sends no `Origin` on a `GET` the extension's service worker makes to a
  // host it holds a permission for, and an `Origin` is only a claim a local
  // process holding the credential can write. So every DevTools read carries
  // the read proof pairing issued with its credential — a secret nothing sent
  // later, on a socket or otherwise, can register or replace.
  describe('the read proof of a DevTools read', () => {
    const devtoolsOperations = (
      Object.keys(OPERATION_ROLES) as (keyof typeof OPERATION_ROLES)[]
    ).filter((operation) => (OPERATION_ROLES[operation] as readonly string[]).includes('devtools'));
    const reads = devtoolsOperations.filter((operation) => HTTP_ROUTES[operation].method === 'GET');
    const writes = devtoolsOperations.filter(
      (operation) => HTTP_ROUTES[operation].method !== 'GET',
    );
    /** The two origins a genuine DevTools read may arrive with: none, and its own extension's. */
    const readOrigins = [undefined, extensionOrigin(EXTENSION_ID)] as const;

    /** One read presenting `readProof`, from `origin` (none by default). */
    function readWith(
      operation: HttpOperationId,
      token: string,
      readProof: string,
      origin?: string,
    ): Result<Principal | null, DebuggenError> {
      return authorizeWith(operation, token, { [READ_PROOF_HEADER]: readProof }, origin);
    }

    it('covers exactly the four DevTools reads, and pairing issues a proof of the published shape', () => {
      expect(reads).toEqual(['session.get', 'panel.get', 'panel.getById', 'modifications.list']);
      expect(writes).toEqual(['capture.start', 'capture.stop', 'panel.data']);
      const proof = readProofOf(pairDevtools());
      expect(proof).toMatch(new RegExp(`^[A-Za-z0-9_-]{${String(READ_PROOF_LENGTH)}}$`));
      expect(Buffer.from(proof, 'base64url')).toHaveLength(READ_PROOF_BYTES);
    });

    it('stores only the proof digest, inside the credential record, and keeps it out of the principal', () => {
      const devtools = pairDevtools();
      const proof = readProofOf(devtools);
      const row = rowFor(devtools);

      expect(storedScope(row)).toEqual({
        kind: 'extension',
        extensionId: EXTENSION_ID,
        readProofDigest: sha256Hex(proof),
      });
      expect(JSON.stringify(credentialRows())).not.toContain(proof);
      const principal = asDevtools(expectOk(readWith('session.get', devtools, proof)));
      expect(principal.scope).toEqual({ kind: 'extension', extensionId: EXTENSION_ID });
    });

    it('issues a distinct proof with every credential, including one issued directly', () => {
      const first = pairDevtools();
      const second = pairDevtools(harness, OTHER_EXTENSION_ID);
      const direct = expectOk(harness.auth.issueDevtoolsCredential(EXTENSION_ID));
      remember(direct.token);
      remember(direct.readProof);

      const proofs = new Set([readProofOf(first), readProofOf(second), direct.readProof]);
      expect(proofs.size).toBe(3);
      expect(direct.readProof).toMatch(new RegExp(`^[A-Za-z0-9_-]{${String(READ_PROOF_LENGTH)}}$`));
      asDevtools(expectOk(readWith('panel.get', direct.token, direct.readProof)));
    });

    it('refuses a read that carries no proof, several, or a malformed one — with or without the extension origin', () => {
      const devtools = pairDevtools();
      const issued = readProofOf(devtools);

      const malformed = [
        '',
        'x',
        `${issued}=`,
        issued.slice(1),
        `${issued.slice(1)}+`,
        `${issued.slice(1)}/`,
        ` ${issued.slice(1)}`,
        `${issued}, ${issued}`,
      ];
      for (const operation of reads) {
        for (const origin of readOrigins) {
          const refused = expectRefusal(
            authorize(operation, devtools, origin),
            'missing-credential',
            [devtools, issued],
          );
          expect(refused.code).toBe('UNAUTHORIZED');
          expect(authFailureStatus(refused)).toBe(401);
          // The next step is a new pairing, not the reused reason's bearer-header hint.
          expect(refused.hint).toMatch(/^Pair the Debug Generator DevTools extension again/);
          expect(refused.hint).not.toBe(AUTH_FAILURE_REASONS['missing-credential'].hint);
          for (const value of malformed) {
            const garbled = expectRefusal(
              readWith(operation, devtools, value, origin),
              'malformed-credential',
              [devtools, issued],
            );
            expect(garbled.hint).toBe(refused.hint);
          }
          // The same header twice — Node's record form keeps both values.
          expectRefusal(
            authorizeWith(operation, devtools, { [READ_PROOF_HEADER]: [issued, issued] }, origin),
            'malformed-credential',
            [devtools, issued],
          );
        }
      }
    });

    it('refuses a well-formed proof other than the one issued with the credential, as unauthorized', () => {
      const devtools = pairDevtools();
      const other = pairDevtools(harness, OTHER_EXTENSION_ID);
      const invented = newReadProof();

      for (const operation of reads) {
        for (const origin of readOrigins) {
          for (const proof of [invented, readProofOf(other)]) {
            const refused = expectRefusal(
              readWith(operation, devtools, proof, origin),
              'unknown-credential',
              [devtools, proof, readProofOf(devtools)],
            );
            expect(refused.code).toBe('UNAUTHORIZED');
            expect(authFailureStatus(refused)).toBe(401);
            expect(refused.hint).toMatch(/^Pair the Debug Generator DevTools extension again/);
          }
        }
      }
    });

    it('admits every DevTools read carrying the issued proof, from no origin or the issuing extension only', () => {
      const devtools = pairDevtools();
      const proof = readProofOf(devtools);

      for (const operation of reads) {
        for (const origin of readOrigins) {
          asDevtools(expectOk(readWith(operation, devtools, proof, origin)));
        }
        for (const origin of [WEBVIEW_ORIGIN, extensionOrigin(OTHER_EXTENSION_ID)]) {
          expectRefusal(
            readWith(operation, devtools, proof, origin),
            'origin-not-permitted-for-role',
            [devtools, proof],
          );
        }
      }
      for (const operation of writes) {
        asDevtools(expectOk(authorize(operation, devtools, extensionOrigin(EXTENSION_ID))));
        // A proof makes no write acceptable from no origin …
        expectRefusal(readWith(operation, devtools, proof), 'origin-not-permitted-for-role', [
          devtools,
          proof,
        ]);
        // … and is refused on a write from the extension, which has no use for one.
        expectRefusal(
          readWith(operation, devtools, proof, extensionOrigin(EXTENSION_ID)),
          'role-not-permitted',
          [devtools, proof],
        );
      }
      // A hello still needs the issuing extension's origin.
      expectRefusal(
        harness.auth.authorizeHello({
          payload: helloPayload('devtools', devtools, { tabId: 5 }),
          origin: undefined,
        }),
        'origin-not-permitted-for-role',
        [devtools],
      );
    });

    it('gives a stolen credential nothing to read with, whatever Origin it writes or hello it sends', () => {
      const devtools = pairDevtools();
      const issued = readProofOf(devtools);
      const chosen = newReadProof();

      // The holder of the credential alone writes the issuing extension's origin
      // on the socket it opens: the hello is admitted — the origin is all a
      // hello can be judged by — but it cannot carry a proof, so it registers none.
      asDevtools(
        expectOk(
          harness.auth.authorizeHello({
            payload: helloPayload('devtools', devtools),
            origin: extensionOrigin(EXTENSION_ID),
          }),
        ),
      );
      expectRefusal(
        harness.auth.authorizeHello({
          payload: { ...helloPayload('devtools', devtools), readProof: chosen },
          origin: extensionOrigin(EXTENSION_ID),
        }),
        'hello-invalid',
        [devtools, chosen],
      );
      for (const operation of reads) {
        for (const origin of readOrigins) {
          // Neither a forged origin nor a proof of its own choosing reads anything …
          expectRefusal(authorize(operation, devtools, origin), 'missing-credential', [devtools]);
          expectRefusal(readWith(operation, devtools, chosen, origin), 'unknown-credential', [
            devtools,
            chosen,
          ]);
        }
      }
      // … while the proof pairing issued still does.
      asDevtools(expectOk(readWith('session.get', devtools, issued)));
    });

    it('refuses every read of a DevTools credential stored without a proof digest, and nothing else', () => {
      const devtools = pairDevtools();
      const proof = readProofOf(devtools);
      harness.store.db
        .prepare('UPDATE credentials SET scope = ? WHERE token_hash = ?')
        .run(JSON.stringify({ kind: 'extension', extensionId: EXTENSION_ID }), sha256Hex(devtools));

      for (const operation of reads) {
        for (const origin of readOrigins) {
          expectRefusal(readWith(operation, devtools, proof, origin), 'unknown-credential', [
            devtools,
            proof,
          ]);
        }
      }
      // It is still the extension's credential for everything that is not a read.
      asDevtools(expectOk(authorize('panel.data', devtools, extensionOrigin(EXTENSION_ID))));
    });

    it('refuses the header wherever it proves nothing: other roles, exempt operations', () => {
      const editor = editorToken();
      const agent = serverAgentToken(projectPath('alpha'));
      const proof = newReadProof();
      const header = { [READ_PROOF_HEADER]: proof };

      expectRefusal(authorizeWith('session.get', editor, header), 'role-not-permitted', [
        editor,
        proof,
      ]);
      expectRefusal(authorizeWith('session.list', editor, header), 'role-not-permitted', [
        editor,
        proof,
      ]);
      expectRefusal(authorizeWith('telemetry.event', agent, header), 'role-not-permitted', [
        agent,
        proof,
      ]);
      for (const operation of AUTH_EXEMPT_OPERATIONS) {
        expectRefusal(authorizeWith(operation, undefined, header), 'role-not-permitted', [proof]);
      }
    });

    it('keeps the proof across a service restart, and deletes it with the credential on rotation', () => {
      const devtools = pairDevtools();
      const proof = readProofOf(devtools);

      // Nothing in memory holds it: closing the service loses nothing.
      harness.auth.close();
      asDevtools(expectOk(readWith('session.get', devtools, proof)));

      expectOk(harness.auth.rotateAll());
      expectRefusal(readWith('session.get', devtools, proof), 'unknown-credential', [
        devtools,
        proof,
      ]);
      const repaired = pairDevtools();
      expectRefusal(readWith('session.get', repaired, proof), 'unknown-credential', [
        repaired,
        proof,
      ]);
      asDevtools(expectOk(readWith('session.get', repaired, readProofOf(repaired))));
    });
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
    // The stored scope adds only the digest of the read proof issued with the
    // credential, which never reaches the principal.
    expect(storedScope(devtoolsRow)).toEqual({
      ...devtoolsPrincipal.scope,
      readProofDigest: sha256Hex(readProofOf(devtools)),
    });
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
        // A DevTools client presents its read proof on the reads it may make,
        // as the extension does; the proof itself is judged elsewhere.
        const result =
          role === 'devtools' && HTTP_ROUTES[operation].method === 'GET' && permitted.includes(role)
            ? authorizeWith(operation, token, { [READ_PROOF_HEADER]: readProofOf(token) }, origin)
            : authorize(operation, token, origin);
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

    expectOk(requireBoundSession(firstPrincipal, ownSession.id, ownBinding, ownBinding.tabId));
    expectOk(requireSessionAccess(firstPrincipal, ownSession, ownBinding, ownBinding.tabId));

    // A session bound to another tab, by another credential.
    expectRefusal(
      requireBoundSession(firstPrincipal, otherSession.id, otherBinding, otherBinding.tabId),
      'session-not-bound',
    );
    expectRefusal(
      requireSessionAccess(firstPrincipal, otherSession, otherBinding, otherBinding.tabId),
      'session-not-bound',
    );
    // Its own binding presented for a session it is not bound to.
    expectRefusal(
      requireBoundSession(firstPrincipal, otherSession.id, ownBinding, ownBinding.tabId),
      'session-not-bound',
    );
    // A binding to the right session that another credential made.
    expectRefusal(
      requireBoundSession(
        firstPrincipal,
        ownSession.id,
        { ...ownBinding, boundBy: secondPrincipal.tokenHash },
        ownBinding.tabId,
      ),
      'session-not-bound',
    );
    // No binding at all.
    expectRefusal(
      requireBoundSession(firstPrincipal, ownSession.id, undefined, ownBinding.tabId),
      'session-not-bound',
    );
    expectRefusal(
      requireSessionAccess(firstPrincipal, ownSession, undefined, ownBinding.tabId),
      'session-not-bound',
    );
    // Neither guard accepts a DevTools action that names no tab, even with a binding.
    expectRefusal(requireSessionAccess(firstPrincipal, ownSession), 'acting-tab-required');
  });

  it('tells two tabs of one credential apart by the acting tab, never by the credential', () => {
    const shared = pairDevtools();
    const origin = extensionOrigin(EXTENSION_ID);
    const principal = asDevtools(expectOk(authorize('panel.data', shared, origin)));
    const sessionOfA = { id: newSessionId(), projectRoot: projectPath('alpha') };
    const sessionOfB = { id: newSessionId(), projectRoot: projectPath('beta') };
    const tabA = 31;
    const tabB = 32;
    // One credential bound both tabs, each to its own session.
    const bindingOfA: TabBinding = {
      tabId: tabA,
      sessionId: sessionOfA.id,
      boundBy: principal.tokenHash,
    };
    const bindingOfB: TabBinding = {
      tabId: tabB,
      sessionId: sessionOfB.id,
      boundBy: principal.tokenHash,
    };

    // Each tab acts on its own session.
    expectOk(requireBoundSession(principal, sessionOfA.id, bindingOfA, tabA));
    expectOk(requireBoundSession(principal, sessionOfB.id, bindingOfB, tabB));
    expectOk(requireSessionAccess(principal, sessionOfA, bindingOfA, tabA));

    // Tab B, presenting the very same credential, cannot reach tab A's session …
    expectRefusal(
      requireBoundSession(principal, sessionOfA.id, bindingOfA, tabB),
      'session-not-bound',
    );
    expectRefusal(
      requireSessionAccess(principal, sessionOfA, bindingOfA, tabB),
      'session-not-bound',
    );
    // … nor can a tab no binding names at all.
    expectRefusal(
      requireBoundSession(principal, sessionOfA.id, bindingOfA, 33),
      'session-not-bound',
    );
    // A request that names no tab is refused rather than attributed to either tab.
    expectRefusal(
      requireBoundSession(principal, sessionOfA.id, bindingOfA, undefined),
      'acting-tab-required',
    );
    expectRefusal(
      requireSessionAccess(principal, sessionOfA, bindingOfA, undefined),
      'acting-tab-required',
    );

    // Once tab B takes over session A (a second bind replaces the first), the
    // displaced tab A loses it and tab B gains it.
    const replaced: TabBinding = { ...bindingOfA, tabId: tabB };
    expectRefusal(
      requireBoundSession(principal, sessionOfA.id, replaced, tabA),
      'session-not-bound',
    );
    expectOk(requireBoundSession(principal, sessionOfA.id, replaced, tabB));

    // The acting tab never widens the role rule: an editor is still refused.
    const editor = asEditor(expectOk(authorize('panel.data', editorToken())));
    expectRefusal(
      requireBoundSession(editor, sessionOfA.id, bindingOfA, tabA),
      'role-not-permitted',
    );
  });

  it('accepts the acting-tab header only from a DevTools credential, and only as one tab id', () => {
    const devtools = pairDevtools();
    const origin = extensionOrigin(EXTENSION_ID);
    const editor = editorToken();
    const agent = serverAgentToken(projectPath('alpha'));
    const withTab = (token: string | undefined, value: string): Headers => {
      const headers = token === undefined ? new Headers() : bearerHeaders(token);
      headers.set(ACTING_TAB_HEADER, value);
      return headers;
    };
    const principal = asDevtools(expectOk(authorize('panel.data', devtools, origin)));

    // The pure rule the middleware extracts the value with.
    expect(expectOk(resolveActingTab(principal, '42'))).toBe(42);
    expect(expectOk(resolveActingTab(principal, '0'))).toBe(0);
    expect(expectOk(resolveActingTab(principal, undefined))).toBeUndefined();
    expect(expectOk(resolveActingTab(null, undefined))).toBeUndefined();
    for (const malformed of ['', '-1', '01', '4.2', '1, 2', ' 42']) {
      // Too short to search a stack trace for without false positives.
      expectRefusal(resolveActingTab(principal, malformed), 'acting-tab-invalid');
    }
    for (const distinctive of ['forty-two-tabs', '99999999999999999']) {
      expectRefusal(resolveActingTab(principal, distinctive), 'acting-tab-invalid', [distinctive]);
    }
    const editorPrincipal = asEditor(expectOk(authorize('panel.data', editor)));
    const agentPrincipal = asServerAgent(expectOk(authorize('telemetry.event', agent)));
    expectRefusal(resolveActingTab(editorPrincipal, '42'), 'acting-tab-not-permitted');
    expectRefusal(resolveActingTab(agentPrincipal, '42'), 'acting-tab-not-permitted');
    expectRefusal(resolveActingTab(null, '42'), 'acting-tab-not-permitted');
    // A malformed value from a caller that may send none is refused for sending one at all.
    expectRefusal(resolveActingTab(editorPrincipal, 'forty-two'), 'acting-tab-not-permitted');

    // The access boundary enforces the same rule on every request, after the
    // credential and the role table.
    asDevtools(
      expectOk(
        harness.auth.authorizeHttpRequest({
          headers: withTab(devtools, '42'),
          origin,
          operation: 'panel.data',
        }),
      ),
    );
    expectRefusal(
      harness.auth.authorizeHttpRequest({
        headers: withTab(devtools, 'not-a-tab'),
        origin,
        operation: 'panel.data',
      }),
      'acting-tab-invalid',
      [devtools],
    );
    expectRefusal(
      harness.auth.authorizeHttpRequest({
        headers: {
          [AUTHORIZATION_HEADER]: formatBearer(devtools),
          [ACTING_TAB_HEADER]: ['1', '2'],
        },
        origin,
        operation: 'panel.data',
      }),
      'acting-tab-invalid',
      [devtools],
    );
    expectRefusal(
      harness.auth.authorizeHttpRequest({
        headers: withTab(editor, '42'),
        origin: undefined,
        operation: 'session.get',
      }),
      'acting-tab-not-permitted',
      [editor],
    );
    expectRefusal(
      harness.auth.authorizeHttpRequest({
        headers: withTab(agent, '42'),
        origin: undefined,
        operation: 'telemetry.event',
      }),
      'acting-tab-not-permitted',
      [agent],
    );
    for (const operation of AUTH_EXEMPT_OPERATIONS) {
      expectRefusal(
        harness.auth.authorizeHttpRequest({
          headers: withTab(undefined, '42'),
          origin: undefined,
          operation,
        }),
        'acting-tab-not-permitted',
      );
    }
    // The credential and role checks still come first: an unknown credential
    // carrying a tab is refused as unknown, never judged by its tab.
    const forged = remember(cryptoRandomBytes(CREDENTIAL_TOKEN_BYTES).toString('base64url'));
    expectRefusal(
      harness.auth.authorizeHttpRequest({
        headers: withTab(forged, '42'),
        origin,
        operation: 'panel.data',
      }),
      'unknown-credential',
      [forged],
    );
  });

  it('hands routes the verified acting tab through the middleware, and refuses a bad header before them', async () => {
    const devtools = pairDevtools();
    const origin = extensionOrigin(EXTENSION_ID);
    const editor = editorToken();
    const seen: (number | undefined)[] = [];
    const app = new Hono<ServerEnv>();
    const authFor = createAuthMiddleware(harness.auth);
    app.get('/probe', authFor('session.get'), (c) => {
      seen.push(c.get('actingTabId'));
      return c.json({ ok: true }, 200);
    });
    app.get('/health-probe', authFor('health'), (c) => {
      seen.push(c.get('actingTabId'));
      return c.json({ ok: true }, 200);
    });
    const call = async (
      path: string,
      headers: Record<string, string>,
    ): Promise<{ readonly status: number; readonly code: unknown }> => {
      const response = await app.request(path, { headers });
      const body: unknown = await response.json();
      const code =
        typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined;
      return { status: response.status, code };
    };
    const devtoolsHeaders = (tab?: string): Record<string, string> => ({
      [AUTHORIZATION_HEADER]: formatBearer(devtools),
      [READ_PROOF_HEADER]: readProofOf(devtools),
      origin,
      ...(tab === undefined ? {} : { [ACTING_TAB_HEADER]: tab }),
    });

    expect(await call('/probe', devtoolsHeaders('7'))).toEqual({ status: 200, code: undefined });
    expect(await call('/probe', devtoolsHeaders())).toEqual({ status: 200, code: undefined });
    expect(await call('/probe', { [AUTHORIZATION_HEADER]: formatBearer(editor) })).toEqual({
      status: 200,
      code: undefined,
    });
    expect(await call('/health-probe', {})).toEqual({ status: 200, code: undefined });
    expect(seen).toEqual([7, undefined, undefined, undefined]);

    const invalid = AUTH_FAILURE_REASONS['acting-tab-invalid'];
    const notPermitted = AUTH_FAILURE_REASONS['acting-tab-not-permitted'];
    expect(await call('/probe', devtoolsHeaders('07'))).toEqual({
      status: invalid.status,
      code: invalid.code,
    });
    expect(
      await call('/probe', {
        [AUTHORIZATION_HEADER]: formatBearer(editor),
        [ACTING_TAB_HEADER]: '7',
      }),
    ).toEqual({ status: notPermitted.status, code: notPermitted.code });
    expect(await call('/health-probe', { [ACTING_TAB_HEADER]: '7' })).toEqual({
      status: notPermitted.status,
      code: notPermitted.code,
    });
    // No refused request reached a handler.
    expect(seen).toHaveLength(4);
  });

  it('never lets a DevTools client create or steer a session, or claim a project', () => {
    const devtools = pairDevtools();
    const origin = extensionOrigin(EXTENSION_ID);
    for (const operation of [
      'session.create',
      'session.list',
      'session.question',
      'session.end',
      // A panel enters picker mode on its own; only the editor asks the bound tab to.
      'target.request',
      // The administrative operations: purging history, minting a credential, rotating all.
      'session.purge',
      'devServer.credential',
      'credentials.rotate',
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
      // A server agent can neither mint another credential nor purge or rotate anything.
      'devServer.credential',
      'session.purge',
      'credentials.rotate',
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

    // Released without a lease, the announcement ends with the connection.
    announcement.release();
    announcement.release();
    announcement.releaseAfter(MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS);
    const released = asEditor(expectOk(authorize('session.create', editor)));
    expect(released.scope.workspaceFolders).toEqual([]);
    expectRefusal(requireProjectScope(released, workspace), 'project-out-of-scope');
  });

  describe('canonical workspace containment (links inside an announced folder)', () => {
    /**
     * An editor principal whose live connections announced exactly `folders`,
     * one `client.hello` each, all presenting the same credential.
     */
    function editorAnnouncing(...folders: readonly string[]): EditorPrincipal {
      const editor = editorToken();
      for (const folder of folders) {
        const hello = asEditor(
          expectOk(
            harness.auth.authorizeHello({
              payload: helloPayload('vscode', editor, { projectRoot: folder }),
              origin: undefined,
            }),
          ),
        );
        expectOk(harness.auth.announceWorkspace(hello));
      }
      const principal = asEditor(expectOk(authorize('session.create', editor)));
      expect([...principal.scope.workspaceFolders].sort()).toEqual([...folders].sort());
      return principal;
    }

    /**
     * A real tree in a fresh sandbox:
     *
     * - `shop/` — the workspace, holding `packages/web/src/` and a `web` link
     *   to `shop/packages/web` (a link that stays inside);
     * - `shop/external` — a link to `private/`, outside the workspace;
     * - `private/sub/` — the outside directory the link reaches;
     * - `linked-shop` — a link to `shop/`, for a workspace announced through one.
     */
    function linkedTree(): {
      readonly workspace: string;
      readonly outside: string;
      readonly linkedWorkspace: string;
    } {
      const base = openSandbox();
      const workspace = join(base, 'shop');
      const outside = join(base, 'private');
      const linkedWorkspace = join(base, 'linked-shop');
      mkdirSync(join(workspace, 'packages', 'web', 'src'), { recursive: true });
      mkdirSync(join(outside, 'sub'), { recursive: true });
      symlinkSync(join(workspace, 'packages', 'web'), join(workspace, 'web'), 'dir');
      symlinkSync(outside, join(workspace, 'external'), 'dir');
      symlinkSync(workspace, linkedWorkspace, 'dir');
      return { workspace, outside, linkedWorkspace };
    }

    /** A resolver that records what it was asked and fails every call with `code`. */
    function failingResolver(code: string): {
      readonly calls: string[];
      readonly resolve: RealPathResolver;
    } {
      const calls: string[] = [];
      return {
        calls,
        resolve: (absolutePath) => {
          calls.push(absolutePath);
          throw Object.assign(new Error(`${code}: the resolver failed`), { code });
        },
      };
    }

    /**
     * A resolver over a table of paths that exist and links between them,
     * walked component by component as `realpath` walks them; a missing
     * component fails with `ENOENT`.
     */
    function tableResolver(
      existing: readonly string[],
      links: Readonly<Record<string, string>> = {},
    ): { readonly calls: string[]; readonly resolve: RealPathResolver } {
      const present = new Set(['/', ...existing]);
      const calls: string[] = [];
      return {
        calls,
        resolve: (absolutePath) => {
          calls.push(absolutePath);
          let resolved = '/';
          for (const segment of absolutePath.split('/').filter((part) => part.length > 0)) {
            const joined = resolved === '/' ? `/${segment}` : `${resolved}/${segment}`;
            const target = links[joined] ?? joined;
            if (!present.has(target)) {
              throw Object.assign(new Error('ENOENT: no such file or directory'), {
                code: 'ENOENT',
              });
            }
            resolved = target;
          }
          return resolved;
        },
      };
    }

    it('refuses a root reached through a link that leaves the workspace, and everything beneath it', () => {
      const { workspace, outside } = linkedTree();
      const principal = editorAnnouncing(workspace);

      for (const escaped of [
        join(workspace, 'external'),
        join(workspace, 'external', 'sub'),
        // A tail that does not exist yet is re-appended beneath the link's target.
        join(workspace, 'external', 'not-created-yet'),
      ]) {
        expectRefusal(requireProjectScope(principal, escaped), 'project-out-of-scope');
        expectRefusal(
          requireSessionAccess(principal, { id: newSessionId(), projectRoot: escaped }),
          'project-out-of-scope',
        );
      }
      // The outside directory itself was never announced either.
      expectRefusal(requireProjectScope(principal, outside), 'project-out-of-scope');
    });

    it('refuses a dangling link inside the workspace, before and after its target appears', () => {
      const { workspace, outside } = linkedTree();
      const principal = editorAnnouncing(workspace);
      // `realpath` answers ENOENT for a link whose target does not exist yet,
      // exactly as for a missing component; the link must not be kept as spelled.
      const target = join(outside, 'created-later');
      const dangling = join(workspace, 'dangling');
      symlinkSync(target, dangling, 'dir');

      for (const root of [dangling, join(dangling, 'app'), join(dangling, 'app', 'web')]) {
        expectRefusal(requireProjectScope(principal, root), 'project-out-of-scope');
        expectRefusal(
          requireSessionAccess(principal, { id: newSessionId(), projectRoot: root }),
          'project-out-of-scope',
        );
      }

      // Once the target exists the link is an ordinary escape, refused as one.
      mkdirSync(join(target, 'app'), { recursive: true });
      expectRefusal(requireProjectScope(principal, dangling), 'project-out-of-scope');
      expectRefusal(requireProjectScope(principal, join(dangling, 'app')), 'project-out-of-scope');
    });

    it('re-judges a root on every call, so a link retargeted out of the workspace loses it', () => {
      const { workspace, outside } = linkedTree();
      const principal = editorAnnouncing(workspace);
      const root = join(workspace, 'web');
      const session = { id: newSessionId(), projectRoot: root };

      expectOk(requireProjectScope(principal, root));
      expectOk(requireSessionAccess(principal, session));

      // The link is pointed outside after the session was admitted.
      unlinkSync(root);
      symlinkSync(outside, root, 'dir');
      expectRefusal(requireProjectScope(principal, root), 'project-out-of-scope');
      expectRefusal(requireSessionAccess(principal, session), 'project-out-of-scope');

      // And pointed back inside, it is admitted again: nothing was cached.
      unlinkSync(root);
      symlinkSync(join(workspace, 'packages', 'web'), root, 'dir');
      expectOk(requireSessionAccess(principal, session));
    });

    it('admits a root with the canonical path it was judged on, and requireProjectScope agrees', () => {
      const { workspace, outside, linkedWorkspace } = linkedTree();
      const principal = editorAnnouncing(workspace);
      const packaged = realpathSync.native(join(workspace, 'packages', 'web'));

      const cases: readonly (readonly [string, string])[] = [
        [workspace, realpathSync.native(workspace)],
        [join(workspace, 'web'), packaged],
        [join(workspace, 'web', 'src'), join(packaged, 'src')],
        [join(workspace, 'web', 'not-created-yet'), join(packaged, 'not-created-yet')],
      ];
      for (const [root, canonical] of cases) {
        const admitted = expectOk(admitProjectRoot(principal, root));
        expect(admitted).toStrictEqual({ projectRoot: root, canonicalRoot: canonical });
        expect(Object.isFrozen(admitted)).toBe(true);
        expectOk(requireProjectScope(principal, root));
      }
      for (const refused of [
        join(workspace, 'external'),
        outside,
        join(linkedWorkspace, 'external'),
        'relative/root',
      ]) {
        expectRefusal(admitProjectRoot(principal, refused), 'project-out-of-scope');
        expectRefusal(requireProjectScope(principal, refused), 'project-out-of-scope');
      }
    });

    it('admits only an editor principal by its workspace folders', () => {
      const { workspace } = linkedTree();
      const agent = asServerAgent(
        expectOk(authorize('telemetry.event', serverAgentToken(workspace))),
      );
      const devtools = asDevtools(
        expectOk(authorize('panel.data', pairDevtools(), extensionOrigin(EXTENSION_ID))),
      );

      for (const principal of [agent, devtools]) {
        expectRefusal(admitProjectRoot(principal, workspace), 'project-out-of-scope');
      }
      // The server agent's own rule is unchanged: its one project, lexically.
      expectOk(requireProjectScope(agent, workspace));
    });

    it('reconfirms an admitted root only while it still resolves to the directory it was admitted as', () => {
      const { workspace, outside } = linkedTree();
      const principal = editorAnnouncing(workspace);
      const root = join(workspace, 'web');
      const elsewhereInside = join(workspace, 'packages', 'api');
      mkdirSync(elsewhereInside, { recursive: true });
      const admitted = expectOk(admitProjectRoot(principal, root));

      expect(expectOk(reconfirmProjectRoot(principal, admitted))).toBe(admitted);

      // Retargeted inside the workspace between admission and the act: still in
      // scope, but not the directory it was admitted as, so it is refused.
      unlinkSync(root);
      symlinkSync(elsewhereInside, root, 'dir');
      expectOk(requireProjectScope(principal, root));
      const moved = expectRefusal(
        reconfirmProjectRoot(principal, admitted),
        'project-out-of-scope',
      );
      expect(moved.message).toBe(
        'The project root no longer resolves to the directory it was admitted as.',
      );

      // Retargeted out of the workspace: refused by scope before identity.
      unlinkSync(root);
      symlinkSync(outside, root, 'dir');
      expectRefusal(reconfirmProjectRoot(principal, admitted), 'project-out-of-scope');

      // Pointed back where it was admitted, it is the same directory again.
      unlinkSync(root);
      symlinkSync(join(workspace, 'packages', 'web'), root, 'dir');
      expect(expectOk(reconfirmProjectRoot(principal, admitted))).toBe(admitted);
    });

    it('admits a link that stays inside the workspace, and a tail that does not exist yet', () => {
      const { workspace } = linkedTree();
      const principal = editorAnnouncing(workspace);

      for (const inside of [
        workspace,
        join(workspace, 'packages'),
        join(workspace, 'web'),
        join(workspace, 'web', 'src'),
        join(workspace, 'not', 'created', 'yet'),
        join(workspace, 'web', 'not-created-yet'),
      ]) {
        expectOk(requireProjectScope(principal, inside));
        expectOk(requireSessionAccess(principal, { id: newSessionId(), projectRoot: inside }));
      }
    });

    it('admits roots under a workspace announced through a link, and still refuses the escape', () => {
      const { workspace, linkedWorkspace } = linkedTree();
      const principal = editorAnnouncing(linkedWorkspace);

      expectOk(requireProjectScope(principal, linkedWorkspace));
      expectOk(requireProjectScope(principal, join(linkedWorkspace, 'packages', 'web')));
      expectOk(requireProjectScope(principal, join(linkedWorkspace, 'web')));
      expectOk(requireProjectScope(principal, join(linkedWorkspace, 'not-created-yet')));
      expectRefusal(
        requireProjectScope(principal, join(linkedWorkspace, 'external')),
        'project-out-of-scope',
      );
      // Canonical containment adds to the lexical check, never replaces it: the
      // link's target is the same directory on disk, but it is not what the
      // editor announced.
      expectRefusal(
        requireProjectScope(principal, join(workspace, 'packages')),
        'project-out-of-scope',
      );
    });

    it('requires both containments of the same announced folder, not one of each', () => {
      const { workspace, outside } = linkedTree();
      // The editor announced both directories. The root is inside `shop` by
      // spelling and inside `private` on disk, but inside neither by both.
      const principal = editorAnnouncing(workspace, outside);

      expectOk(requireProjectScope(principal, outside));
      expectOk(requireProjectScope(principal, join(outside, 'sub')));
      expectOk(requireProjectScope(principal, join(workspace, 'packages')));
      expectRefusal(
        requireProjectScope(principal, join(workspace, 'external', 'sub')),
        'project-out-of-scope',
      );
    });

    it('refuses when the canonical path cannot be established, and never resolves a path outside every folder', () => {
      const { workspace } = linkedTree();
      const principal = editorAnnouncing(workspace);

      for (const code of ['EACCES', 'ELOOP', 'ENOTDIR']) {
        const probe = failingResolver(code);
        expectRefusal(
          requireProjectScope(principal, join(workspace, 'packages'), probe.resolve),
          'project-out-of-scope',
        );
        // Refused on the first failure that is not a missing component: no walk.
        expect(probe.calls, code).toEqual([join(workspace, 'packages')]);
      }

      const untouched = failingResolver('EACCES');
      expectRefusal(
        requireProjectScope(principal, join(workspace, '..', 'private'), untouched.resolve),
        'project-out-of-scope',
      );
      expectRefusal(
        requireProjectScope(principal, `${workspace}-sibling`, untouched.resolve),
        'project-out-of-scope',
      );
      expect(untouched.calls, 'a root outside every announced folder is never resolved').toEqual(
        [],
      );
    });

    it('walks up only past missing components, and refuses when nothing up to the root exists', () => {
      const principal = editorAnnouncing('/work/shop');

      const tree = tableResolver(
        ['/work', '/work/shop', '/home', '/home/dev', '/home/dev/private'],
        {
          '/work/shop/external': '/home/dev/private',
        },
      );
      expectOk(requireProjectScope(principal, '/work/shop/app/web', tree.resolve));
      expect(tree.calls).toEqual([
        '/work/shop/app/web',
        '/work/shop/app',
        '/work/shop',
        // The folder's own canonical path.
        '/work/shop',
      ]);
      expectRefusal(
        requireProjectScope(principal, '/work/shop/external/app', tree.resolve),
        'project-out-of-scope',
      );

      // A tree with nothing in it still has `/`, so a wholly missing root is kept as spelled.
      expectOk(requireProjectScope(principal, '/work/shop/app', tableResolver([]).resolve));

      // A resolver that cannot even resolve `/` establishes nothing.
      const nothing = failingResolver('ENOENT');
      expectRefusal(
        requireProjectScope(principal, '/work/shop/app', nothing.resolve),
        'project-out-of-scope',
      );
      expect(nothing.calls).toEqual(['/work/shop/app', '/work/shop', '/work', '/']);
    });

    it('refuses a resolver answer that is not an absolute local path', () => {
      const principal = editorAnnouncing('/work/shop');

      for (const answer of ['work/shop', 'C:', 'C:work', '//server/share/work']) {
        expectRefusal(
          requireProjectScope(principal, '/work/shop', () => answer),
          'project-out-of-scope',
        );
      }
      expectOk(requireProjectScope(principal, '/work/shop', (path) => path));
    });

    it('asks about a drive root as `C:/`, never the drive-relative `C:`', () => {
      // Announced folders are stored in the one normalised spelling.
      const principal = editorAnnouncing('C:/work/shop');
      const calls: string[] = [];
      const windowsResolver: RealPathResolver = (absolutePath) => {
        calls.push(absolutePath);
        if (absolutePath === 'C:/') {
          return 'C:\\';
        }
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      };

      expectOk(requireProjectScope(principal, 'C:\\work\\shop\\app', windowsResolver));
      expect(calls).toEqual([
        'C:/work/shop/app',
        'C:/work/shop',
        'C:/work',
        'C:/',
        'C:/work/shop',
        'C:/work',
        'C:/',
      ]);
    });

    it('refuses a drive-relative folder, which names no fixed directory, without resolving it', () => {
      const principal = editorAnnouncing('C:work');
      const probe = tableResolver([]);

      expectRefusal(
        requireProjectScope(principal, 'C:work\\app', probe.resolve),
        'project-out-of-scope',
      );
      expect(probe.calls).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')(
      'refuses a drive-rooted root on a host that is not Windows, whatever the working directory holds',
      () => {
        const principal = editorAnnouncing('C:/work/shop');

        expectRefusal(
          requireProjectScope(principal, 'C:\\work\\shop\\app'),
          'project-out-of-scope',
        );
      },
    );
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

  describe('the workspace lease of a dropped editor connection', () => {
    /**
     * One editor credential's announcing hello principal, and readers of the
     * principal (and its folders) an HTTP request presenting it resolves to.
     */
    function announcingEditor(workspace: string): {
      readonly hello: EditorPrincipal;
      readonly principal: () => EditorPrincipal;
      readonly folders: () => readonly string[];
    } {
      const editor = editorToken();
      const hello = asEditor(
        expectOk(
          harness.auth.authorizeHello({
            payload: helloPayload('vscode', editor, { projectRoot: workspace }),
            origin: undefined,
          }),
        ),
      );
      const principal = (): EditorPrincipal => asEditor(expectOk(authorize('session.end', editor)));
      return { hello, principal, folders: () => principal().scope.workspaceFolders };
    }

    it('keeps the folders in scope until the injected clock passes the lease, then drops them', () => {
      const workspace = projectPath('workspace', 'leased');
      const { hello, principal, folders } = announcingEditor(workspace);
      const lease = 60_000;

      const announcement = expectOk(harness.auth.announceWorkspace(hello));
      announcement.releaseAfter(lease);
      expect(folders(), 'within the lease').toEqual([workspace]);
      // What VS Code's deactivate() needs after its socket closed: its own
      // project's session may still be ended.
      expectOk(requireSessionAccess(principal(), { id: newSessionId(), projectRoot: workspace }));

      harness.clock.advance(lease - 1);
      expect(folders(), 'one millisecond before it ends').toEqual([workspace]);
      harness.clock.advance(1);
      expect(folders(), 'once it has ended').toEqual([]);
      expectRefusal(
        requireSessionAccess(principal(), { id: newSessionId(), projectRoot: workspace }),
        'project-out-of-scope',
      );
      // Settled for good: neither method brings the folders back.
      announcement.releaseAfter(lease);
      announcement.release();
      expect(folders()).toEqual([]);
    });

    it('caps a lease at MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS and treats a non-finite or negative one as none', () => {
      const workspace = projectPath('workspace', 'capped');
      const { hello, folders } = announcingEditor(workspace);

      expectOk(harness.auth.announceWorkspace(hello)).releaseAfter(
        MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS * 10,
      );
      harness.clock.advance(MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS - 1);
      expect(folders(), 'inside the cap').toEqual([workspace]);
      harness.clock.advance(1);
      expect(folders(), 'the cap, not the request, ended it').toEqual([]);

      for (const leaseMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
        expectOk(harness.auth.announceWorkspace(hello)).releaseAfter(leaseMs);
        expect(folders(), `a lease of ${String(leaseMs)}`).toEqual([]);
      }
    });

    it('lets a new announcement take a leased folder over, and keeps the lease floor it had', () => {
      const workspace = projectPath('workspace', 'returning');
      const { hello, folders } = announcingEditor(workspace);
      const lease = 30_000;

      expectOk(harness.auth.announceWorkspace(hello)).releaseAfter(lease);
      // The editor reconnects inside the lease, then drops without one.
      const reconnected = expectOk(harness.auth.announceWorkspace(hello));
      harness.clock.advance(lease);
      expect(folders(), 'a live announcement outlasts the lease').toEqual([workspace]);
      reconnected.release();
      expect(folders(), 'no live announcement and no lease left').toEqual([]);

      // An immediate release does not cut short another announcement's lease.
      expectOk(harness.auth.announceWorkspace(hello)).releaseAfter(lease);
      expectOk(harness.auth.announceWorkspace(hello)).release();
      expect(folders(), 'the earlier lease still stands').toEqual([workspace]);
      harness.clock.advance(lease);
      expect(folders()).toEqual([]);
    });

    it('ends every lease on rotation, and a lease granted after it is a no-op', () => {
      const workspace = projectPath('workspace', 'rotated');
      const { hello } = announcingEditor(workspace);
      const leased = expectOk(harness.auth.announceWorkspace(hello));
      leased.releaseAfter(MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS);
      // The socket the revoker closes settles its announcement after the clear.
      const closedByRotation = expectOk(harness.auth.announceWorkspace(hello));

      expectOk(harness.auth.rotateAll());
      closedByRotation.releaseAfter(MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS);
      const rotated = readAuthFile(harness.config).token;
      remember(rotated);
      const scopeOfRotated = (): readonly string[] =>
        asEditor(expectOk(authorize('session.create', rotated))).scope.workspaceFolders;
      expect(scopeOfRotated(), 'the new credential inherits no lease').toEqual([]);

      // The new credential's own announcement is untouched by the old ones settling.
      const fresh = expectOk(
        harness.auth.announceWorkspace(
          asEditor(
            expectOk(
              harness.auth.authorizeHello({
                payload: helloPayload('vscode', rotated, { projectRoot: workspace }),
                origin: undefined,
              }),
            ),
          ),
        ),
      );
      leased.release();
      closedByRotation.release();
      expect(scopeOfRotated()).toEqual([workspace]);
      fresh.release();
      expect(scopeOfRotated()).toEqual([]);
    });
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

/**
 * `code` with its first, third, fifth… letter lower-cased and the rest left
 * upper-case: the same characters in a second, mixed spelling. Throws when the
 * code holds no letter at all, so a case can never silently compare a code
 * with itself.
 */
function mixedCase(code: string): string {
  let letters = 0;
  const respelled = [...code]
    .map((character) => {
      if (character.toLowerCase() === character) {
        return character;
      }
      letters += 1;
      return letters % 2 === 1 ? character.toLowerCase() : character;
    })
    .join('');
  if (respelled === code) {
    throw new Error('the pairing code holds no letter to re-spell');
  }
  return respelled;
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

    remember(issued.readProof);
    expect(Buffer.from(issued.readProof, 'base64url')).toHaveLength(READ_PROOF_BYTES);
    expect(issued.readProof).not.toBe(issued.token);

    const principal = asDevtools(expectOk(authorize('panel.data', issued.token, origin)));
    expect(principal.scope).toEqual({ kind: 'extension', extensionId: EXTENSION_ID });
    // The record keeps the proof's digest beside the scope, never the proof.
    expect(storedScope(rowFor(issued.token))).toEqual({
      ...principal.scope,
      readProofDigest: sha256Hex(issued.readProof),
    });
    asDevtools(
      expectOk(
        authorizeWith('session.get', issued.token, { [READ_PROOF_HEADER]: issued.readProof }),
      ),
    );
    expect(pairingRows()[0]?.['used']).toBe(PAIRING_CODE_MAX_REDEMPTIONS);

    expectRefusal(harness.auth.completePairing({ code, origin }), 'pairing-used', [code]);
    expectRefusal(
      harness.auth.completePairing({ code, origin: extensionOrigin(OTHER_EXTENSION_ID) }),
      'pairing-used',
      [code],
    );
    expect(credentialRows().filter((row) => row['role'] === principal.role)).toHaveLength(1);
  });

  it.each([
    ['lower case', (code: string) => code.toLowerCase()],
    ['mixed case', mixedCase],
    ['leading spaces', (code: string) => `  ${code}`],
    ['trailing spaces', (code: string) => `${code}  `],
    ['a leading tab', (code: string) => `\t${code}`],
    ['a trailing newline', (code: string) => `${code}\n`],
    ['lower case padded on both sides', (code: string) => `  ${code.toLowerCase()}\t`],
  ])('compares the code exactly: %s is a wrong code, and burns nothing', (_label, respell) => {
    const code = startCode();
    const variant = respell(code);
    expect(variant).not.toBe(code);

    expectRefusal(harness.auth.completePairing({ code: variant, origin }), 'pairing-invalid', [
      code,
      variant,
    ]);
    expect(pairingRows()[0]?.['used']).toBe(0);
    expect(credentialRows().filter((row) => row['role'] === 'devtools')).toHaveLength(0);

    remember(expectOk(harness.auth.completePairing({ code, origin })).token);
  });

  it('counts every re-spelled submission as a failure: below the threshold the exact code still redeems', () => {
    const code = startCode();
    const variants = [code.toLowerCase(), ` ${code} `, `\t${code}`, mixedCase(code)];
    expect(variants).toHaveLength(PAIRING_MAX_FAILURES - 1);

    for (const variant of variants) {
      expectRefusal(harness.auth.completePairing({ code: variant, origin }), 'pairing-invalid', [
        code,
      ]);
    }
    remember(expectOk(harness.auth.completePairing({ code, origin })).token);
  });

  it('locks pairing once re-spelled submissions reach the threshold, and refuses the exact code then', () => {
    const code = startCode();
    for (let attempt = 0; attempt < PAIRING_MAX_FAILURES; attempt += 1) {
      const variant = attempt % 2 === 0 ? code.toLowerCase() : ` ${code}`;
      expectRefusal(harness.auth.completePairing({ code: variant, origin }), 'pairing-invalid', [
        code,
      ]);
    }

    expectRefusal(harness.auth.completePairing({ code, origin }), 'pairing-locked', [code]);
    expect(pairingRows()[0]?.['used']).toBe(0);
    harness.clock.advance(PAIRING_LOCKOUT_MS);
    remember(expectOk(harness.auth.completePairing({ code, origin })).token);
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

  it('locks pairing for every extension after consecutive failures, refuses even the right code, then lifts the lock', () => {
    const code = startCode();
    const otherCode = startCode();
    const otherOrigin = extensionOrigin(OTHER_EXTENSION_ID);
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

    // The lockout is the service's, not the failing extension's: another
    // extension presenting its own right code is refused too.
    expectRefusal(
      harness.auth.completePairing({ code: otherCode, origin: otherOrigin }),
      'pairing-locked',
      [otherCode],
    );
    // The lockout burned nothing: both codes are still unused.
    expect(pairingRows().map((row) => row['used'])).toEqual([0, 0]);

    harness.clock.advance(PAIRING_LOCKOUT_MS - 1);
    expectRefusal(harness.auth.completePairing({ code, origin }), 'pairing-locked', [code]);
    harness.clock.advance(1);
    remember(expectOk(harness.auth.completePairing({ code, origin })).token);
    remember(
      expectOk(harness.auth.completePairing({ code: otherCode, origin: otherOrigin })).token,
    );
  });

  it('shares one count across origins, and forgets it after a success and after a quiet window', () => {
    const below = PAIRING_MAX_FAILURES - 1;
    let forgedIndex = 0;
    // Each failure from a different forged id, so only a shared count can add
    // them up.
    const failBelowThreshold = (wrong: string): void => {
      for (let attempt = 0; attempt < below; attempt += 1) {
        const forged = extensionOrigin(`forged-panel-${String(forgedIndex)}`);
        forgedIndex += 1;
        expectRefusal(
          harness.auth.completePairing({ code: wrong, origin: forged }),
          'pairing-invalid',
          [wrong],
        );
      }
    };

    // Below the threshold, the genuine extension redeems — and the success
    // clears the count.
    const first = startCode();
    failBelowThreshold(anotherCodeThan(first));
    remember(expectOk(harness.auth.completePairing({ code: first, origin })).token);

    // A fresh count of the same size, then a quiet window, then another: had
    // either been kept, the second batch would have locked.
    const second = startCode();
    failBelowThreshold(anotherCodeThan(second));
    harness.clock.advance(PAIRING_LOCKOUT_MS + 1);
    failBelowThreshold(anotherCodeThan(second));
    remember(expectOk(harness.auth.completePairing({ code: second, origin })).token);

    // Without the quiet window, one more failure from yet another id is the
    // one that locks.
    const third = startCode();
    failBelowThreshold(anotherCodeThan(third));
    harness.clock.advance(PAIRING_LOCKOUT_MS);
    expectRefusal(
      harness.auth.completePairing({
        code: anotherCodeThan(third),
        origin: extensionOrigin('forged-panel-last'),
      }),
      'pairing-invalid',
    );
    expectRefusal(harness.auth.completePairing({ code: third, origin }), 'pairing-locked', [third]);
  });

  it('locks pairing for the genuine extension once failures spread over forged extension ids reach the threshold', () => {
    const code = startCode();
    const wrong = anotherCodeThan(code);
    const forgedOrigins = Array.from({ length: PAIRING_MAX_FAILURES }, (_, index) =>
      extensionOrigin(`forged-panel-${String(index)}`),
    );
    expect(new Set(forgedOrigins).size).toBe(PAIRING_MAX_FAILURES);
    expect(forgedOrigins).not.toContain(origin);

    // One failure per forged id: no id ever failed twice.
    for (const forged of forgedOrigins) {
      expectRefusal(
        harness.auth.completePairing({ code: wrong, origin: forged }),
        'pairing-invalid',
        [wrong],
      );
    }
    const lockedAt = harness.clock.now;

    // Locked for the genuine extension's right code, and for a forged id never
    // seen before.
    expectRefusal(harness.auth.completePairing({ code, origin }), 'pairing-locked', [code]);
    expectRefusal(
      harness.auth.completePairing({ code: wrong, origin: extensionOrigin('forged-panel-fresh') }),
      'pairing-locked',
      [wrong],
    );
    expect(pairingRows()[0]?.['used']).toBe(0);

    // Attempts during the lock are refused before they are counted, so a
    // forger hammering it does not extend it: it lifts after exactly
    // PAIRING_LOCKOUT_MS.
    harness.clock.advance(PAIRING_LOCKOUT_MS - 1);
    for (const forged of forgedOrigins) {
      expectRefusal(
        harness.auth.completePairing({ code: wrong, origin: forged }),
        'pairing-locked',
        [wrong],
      );
    }
    expectRefusal(harness.auth.completePairing({ code, origin }), 'pairing-locked', [code]);
    harness.clock.advance(1);
    expect(harness.clock.now).toBe(lockedAt + PAIRING_LOCKOUT_MS);

    // The credential is still scoped to the extension that redeemed it.
    const issued = expectOk(harness.auth.completePairing({ code, origin }));
    remember(issued.token);
    expect(asDevtools(expectOk(authorize('panel.data', issued.token, origin))).scope).toEqual({
      kind: 'extension',
      extensionId: EXTENSION_ID,
    });
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
 * The revocation fence
 * ============================================================================================== */

/** The three principals a running service holds, one per role. */
interface LivePrincipals {
  readonly editor: EditorPrincipal;
  readonly devtools: DevtoolsPrincipal;
  readonly serverAgent: ServerAgentPrincipal;
}

describe('the revocation fence', () => {
  const origin = extensionOrigin(EXTENSION_ID);

  /**
   * One principal per role, each resolved exactly as the HTTP middleware
   * resolves it — the snapshot a handler holds while it reads its body.
   */
  function livePrincipals(projectRoot: string = projectPath('alpha')): LivePrincipals {
    return {
      editor: asEditor(expectOk(authorize('session.list', editorToken()))),
      devtools: asDevtools(expectOk(authorize('panel.data', pairDevtools(), origin))),
      serverAgent: asServerAgent(
        expectOk(authorize('telemetry.event', serverAgentToken(projectRoot))),
      ),
    };
  }

  /** The principals of a {@link LivePrincipals}, in role order. */
  function each(principals: LivePrincipals): readonly Principal[] {
    return [principals.editor, principals.devtools, principals.serverAgent];
  }

  it('accepts the principal of every credential that is still live, and retires nothing itself', () => {
    const principals = livePrincipals();
    const rowsBefore = credentialRows();
    for (const principal of each(principals)) {
      expectOk(harness.auth.requireLiveCredential(principal));
      // The fence only reads: it passes again, and the store is unchanged.
      expectOk(harness.auth.requireLiveCredential(principal));
    }
    expect(credentialRows()).toEqual(rowsBefore);
  });

  it('refuses every principal a rotation retired, and accepts the new editor principal', () => {
    const retired = livePrincipals();
    expectOk(harness.auth.rotateAll());

    for (const principal of each(retired)) {
      expectRefusal(harness.auth.requireLiveCredential(principal), 'unknown-credential');
    }
    const rotated = readAuthFile(harness.config).token;
    const current = asEditor(expectOk(authorize('session.list', rotated)));
    expect(current.tokenHash).not.toBe(retired.editor.tokenHash);
    expectOk(harness.auth.requireLiveCredential(current));
  });

  it('refuses a principal from the instant its credential expires', () => {
    const expiresAt = harness.clock.now + 1_000;
    const principal = asServerAgent(
      expectOk(authorize('telemetry.event', serverAgentToken(projectPath('alpha'), expiresAt))),
    );

    harness.clock.advance(999);
    expectOk(harness.auth.requireLiveCredential(principal));
    harness.clock.advance(1);
    expectRefusal(harness.auth.requireLiveCredential(principal), 'expired-credential');
  });

  it("refuses the server-agent principals of a project whose credentials were revoked, and only that project's", () => {
    const alpha = livePrincipals(projectPath('alpha'));
    const beta = asServerAgent(
      expectOk(authorize('telemetry.event', serverAgentToken(projectPath('beta')))),
    );

    expect(expectOk(harness.auth.revokeServerAgentCredentials(projectPath('alpha')))).toBe(1);
    expectRefusal(harness.auth.requireLiveCredential(alpha.serverAgent), 'unknown-credential');
    expectOk(harness.auth.requireLiveCredential(beta));
    expectOk(harness.auth.requireLiveCredential(alpha.editor));
    expectOk(harness.auth.requireLiveCredential(alpha.devtools));
  });

  it('refuses a principal whose stored row now holds another role or no longer validates', () => {
    const token = pairDevtools();
    const principal = asDevtools(expectOk(authorize('panel.data', token, origin)));
    const rerole = harness.store.db.prepare('UPDATE credentials SET role = ? WHERE token_hash = ?');

    rerole.run('server-agent', principal.tokenHash);
    expectRefusal(harness.auth.requireLiveCredential(principal), 'unknown-credential', [token]);
    rerole.run('administrator', principal.tokenHash);
    expectRefusal(harness.auth.requireLiveCredential(principal), 'corrupt-credential', [token]);
    rerole.run('devtools', principal.tokenHash);
    expectOk(harness.auth.requireLiveCredential(principal));
  });

  it('reports a store it cannot read as a failure, never as a live credential', () => {
    const principal = asEditor(expectOk(authorize('session.list', editorToken())));
    harness.store.close();

    expectFailure(harness.auth.requireLiveCredential(principal), 'STORE_ERROR');
  });

  it('keeps the digest it looks up out of every refusal and every log record', () => {
    const firstLine = capturedLogLines.length;
    const retired = livePrincipals();
    const digests = each(retired).map((principal) => principal.tokenHash);
    expectOk(harness.auth.rotateAll());
    readAuthFile(harness.config);

    for (const principal of each(retired)) {
      expectRefusal(harness.auth.requireLiveCredential(principal), 'unknown-credential', digests);
    }
    const lines = capturedLogLines.slice(firstLine);
    const refusalLines = lines.filter((line) =>
      line.includes('refused a request whose credential was retired after it was authenticated'),
    );
    expect(refusalLines).toHaveLength(digests.length);
    expectNoLeak(lines, digests);
  });
});

/* =================================================================================================
 * Rotation across auth.json and the store
 * ============================================================================================== */

/** The editor credential's journal: `auth.json` plus the module's stage suffix. */
function stagePath(config: Pick<ServiceConfig, 'authFilePath'> = harness.config): string {
  return `${config.authFilePath}${AUTH_FILE_STAGE_SUFFIX}`;
}

/** Which operation of the credential-file port a fault or a recorded call concerns. */
type FileOperation = 'write' | 'remove';

/** One call a service made on its credential-file port, with what was true at that instant. */
interface FileCall {
  readonly operation: FileOperation;
  readonly path: string;
  /** Whether a transaction was open on the harness store's connection. */
  readonly inTransaction: boolean;
  /** Every credential digest the harness store held, sorted. */
  readonly credentialHashes: readonly string[];
  /** How many times the harness revoker had been called. */
  readonly revocations: number;
}

/**
 * A `CredentialFileSystem` over the real safe-fs writer and `unlinkSync` that
 * records every call and throws an `EIO` failure for the calls a test scripted
 * — the only way to fail one step of a replacement for a suite running as root,
 * where no permission bit refuses a write.
 */
class ScriptedFileSystem implements CredentialFileSystem {
  readonly calls: FileCall[] = [];

  /** Remaining scripted failures per `operation:path`. */
  readonly #faults = new Map<string, number>();

  /** Makes the next `times` calls of `operation` on `path` fail; `Infinity` for every call. */
  fail(operation: FileOperation, path: string, times = 1): void {
    this.#faults.set(`${operation}:${path}`, times);
  }

  /** How many calls of `operation` were made on `path`, failed or not. */
  count(operation: FileOperation, path: string): number {
    return this.calls.filter((call) => call.operation === operation && call.path === path).length;
  }

  writeSecureFile(path: string, data: string, upTo: string): void {
    this.#enter('write', path);
    writeSecureFileAtomic(path, data, { upTo });
  }

  removeFile(path: string): void {
    this.#enter('remove', path);
    unlinkSync(path);
  }

  /** Records the call with the store and revoker state at this instant, then applies any fault. */
  #enter(operation: FileOperation, path: string): void {
    this.calls.push({
      operation,
      path,
      inTransaction: harness.store.db.isTransaction,
      credentialHashes: credentialRows()
        .map((row) => String(row['token_hash']))
        .sort(),
      revocations: harness.revoker.calls.length,
    });
    const key = `${operation}:${path}`;
    const remaining = this.#faults.get(key) ?? 0;
    if (remaining > 0) {
      this.#faults.set(key, remaining - 1);
      throw Object.assign(new Error(`injected ${operation} failure`), { code: 'EIO' });
    }
  }
}

/** A service over the harness store, clock and revoker whose credential files go through `files`. */
function serviceWithFiles(files: ScriptedFileSystem): AuthService {
  return createService({
    store: harness.store,
    config: harness.config,
    clock: harness.clock,
    revoker: harness.revoker,
    fileSystem: files,
  });
}

/** A `TEMP` trigger — this connection only — that aborts every insert of an editor credential. */
function refuseEditorInserts(store: Store = harness.store): () => void {
  store.db.exec(
    "CREATE TEMP TRIGGER refuse_editor_insert BEFORE INSERT ON main.credentials WHEN NEW.role = 'vscode' BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END;",
  );
  return () => {
    store.db.exec('DROP TRIGGER temp.refuse_editor_insert');
  };
}

/** One credential of every kind and an outstanding pairing code, issued through the real flows. */
interface IssuedSet {
  readonly editor: string;
  readonly devtools: string;
  readonly agent: string;
  readonly pending: string;
}

/** Issues one credential of every kind and starts one pairing code. */
function issueEveryCredential(): IssuedSet {
  return {
    editor: editorToken(),
    devtools: pairDevtools(),
    agent: serverAgentToken(projectPath('alpha')),
    pending: startCode(),
  };
}

/** Asserts `auth` still accepts every credential of `set`: what a rotation that never committed leaves. */
function expectStillValid(set: IssuedSet, auth: AuthService): void {
  asEditor(expectOk(authorize('session.list', set.editor, undefined, auth)));
  asDevtools(expectOk(authorize('panel.data', set.devtools, extensionOrigin(EXTENSION_ID), auth)));
  asServerAgent(expectOk(authorize('telemetry.event', set.agent, undefined, auth)));
}

/** Asserts `auth` refuses every credential of `set` and its pairing code: what a committed rotation leaves. */
function expectRetired(set: IssuedSet, auth: AuthService): void {
  const origin = extensionOrigin(EXTENSION_ID);
  expectRefusal(authorize('session.list', set.editor, undefined, auth), 'unknown-credential', [
    set.editor,
  ]);
  expectRefusal(authorize('panel.data', set.devtools, origin, auth), 'unknown-credential', [
    set.devtools,
  ]);
  expectRefusal(authorize('telemetry.event', set.agent, undefined, auth), 'unknown-credential', [
    set.agent,
  ]);
  expectRefusal(auth.completePairing({ code: set.pending, origin }), 'pairing-invalid', [
    set.pending,
  ]);
}

/** What a restarted process has: a new connection to the same database, and a started service. */
interface Restarted {
  readonly store: Store;
  readonly auth: AuthService;
  readonly state: EditorCredentialState;
}

/**
 * Starts the service again over the same state root, as a new process would: a
 * new connection to the same database file, a new service with the real
 * credential-file port, and its start-up call.
 */
function restartService(): Restarted {
  const store = openTrackedStore({
    databasePath: harness.config.databasePath,
    logger: captureLogger(),
  });
  const auth = createService({ store, config: harness.config, clock: harness.clock });
  const state = expectOk(auth.ensureEditorCredential());
  return { store, auth, state };
}

/**
 * Asserts what every start must leave, whatever it recovered from: no journal,
 * a private `auth.json` whose credential is the one editor row the store holds
 * and the principal the start reported, accepted from the editor's origin.
 *
 * @returns The editor credential `auth.json` holds.
 */
function expectConsistent(restarted: Restarted): string {
  expect(existsSync(stagePath())).toBe(false);
  expect(modeOf(harness.config.authFilePath)).toBe(0o600);
  const { token } = readAuthFile(harness.config);
  const editors = credentialRows(restarted.store).filter((row) => row['role'] === 'vscode');
  expect(editors).toHaveLength(1);
  expect(editors[0]?.['token_hash']).toBe(sha256Hex(token));
  expect(restarted.state.principal.tokenHash).toBe(sha256Hex(token));
  asEditor(expectOk(authorize('session.list', token, undefined, restarted.auth)));
  return token;
}

/** Asserts that none of the log records emitted since `firstLine` carries a secret the suite has seen. */
function expectQuietLogsSince(firstLine: number): readonly string[] {
  const lines = capturedLogLines.slice(firstLine);
  expect(lines.length).toBeGreaterThan(0);
  expectNoLeak(lines);
  return lines;
}

describe('rotation across auth.json and the store', () => {
  // Every test here also proves that nothing it logged — failures and
  // recoveries included — carries a plaintext credential, a credential file's
  // body or a pairing code.
  let firstLine = 0;
  beforeEach(() => {
    firstLine = capturedLogLines.length;
  });
  afterEach(() => {
    expectQuietLogsSince(firstLine);
  });

  it('stages the new credential before the transaction, publishes it after the commit, and closes sockets last', () => {
    const issued = issueEveryCredential();
    const hashesBefore = credentialRows()
      .map((row) => String(row['token_hash']))
      .sort();
    const files = new ScriptedFileSystem();

    expectOk(serviceWithFiles(files).rotateAll());
    const rotated = sha256Hex(readAuthFile(harness.config).token);

    expect(files.calls.map(({ operation, path }) => [operation, path])).toEqual([
      ['write', stagePath()],
      ['write', harness.config.authFilePath],
      ['remove', stagePath()],
    ]);
    const [stage, publish, unstage] = files.calls;
    // No file is touched inside the store transaction.
    expect(files.calls.map((call) => call.inTransaction)).toEqual([false, false, false]);
    // Staged while every old credential still existed; published only once the
    // commit had replaced them all; sockets closed only after both.
    expect(stage?.credentialHashes).toEqual(hashesBefore);
    expect(publish?.credentialHashes).toEqual([rotated]);
    expect([stage?.revocations, publish?.revocations, unstage?.revocations]).toEqual([0, 0, 0]);
    expect(harness.revoker.calls).toHaveLength(1);
    expect(existsSync(stagePath())).toBe(false);
    expectRetired(issued, harness.auth);
  });

  it('rotates nothing when the journal cannot be written, and leaves no journal behind', () => {
    const issued = issueEveryCredential();
    const fileBefore = readFileSync(harness.config.authFilePath);
    const files = new ScriptedFileSystem();
    files.fail('write', stagePath());

    const error = expectFailure(serviceWithFiles(files).rotateAll(), 'INTERNAL');
    expect(error.message).toMatch(/not rotated/);
    expect(error.details?.['rotated']).toBe(false);
    expect(files.count('write', harness.config.authFilePath)).toBe(0);
    expect(readFileSync(harness.config.authFilePath)).toEqual(fileBefore);
    expect(existsSync(stagePath())).toBe(false);
    expect(harness.revoker.calls).toHaveLength(0);
    expectStillValid(issued, harness.auth);

    const restarted = restartService();
    expect(restarted.state.created).toBe(false);
    expect(expectConsistent(restarted)).toBe(issued.editor);
    expectStillValid(issued, restarted.auth);
  });

  it('returns STORE_ERROR and rotates nothing when the store cannot commit, leaving auth.json byte-identical', () => {
    const issued = issueEveryCredential();
    const fileBefore = readFileSync(harness.config.authFilePath);
    const inodeBefore = statSync(harness.config.authFilePath).ino;
    const rowsBefore = credentialRows();
    const codesBefore = pairingRows();
    const allowEditorInserts = refuseEditorInserts();

    const refused = expectFailure(harness.auth.rotateAll(), 'STORE_ERROR');
    expect(refused.message).toMatch(/not rotated/);
    expect(readFileSync(harness.config.authFilePath)).toEqual(fileBefore);
    expect(statSync(harness.config.authFilePath).ino).toBe(inodeBefore);
    expect(existsSync(stagePath())).toBe(false);
    expect(harness.revoker.calls).toHaveLength(0);
    expect(credentialRows()).toEqual(rowsBefore);
    expect(pairingRows()).toEqual(codesBefore);
    expectStillValid(issued, harness.auth);
    allowEditorInserts();

    // A store that is closed under the service fails the same way.
    harness.store.close();
    expectFailure(harness.auth.rotateAll(), 'STORE_ERROR');
    expect(readFileSync(harness.config.authFilePath)).toEqual(fileBefore);
    expect(statSync(harness.config.authFilePath).ino).toBe(inodeBefore);
    expect(existsSync(stagePath())).toBe(false);

    const restarted = restartService();
    expect(restarted.state.created).toBe(false);
    expect(expectConsistent(restarted)).toBe(issued.editor);
    expect(readFileSync(harness.config.authFilePath)).toEqual(fileBefore);
    expectStillValid(issued, restarted.auth);
  });

  it('discards, at the next start, a journal whose rotation never committed, and every credential stays valid', () => {
    const issued = issueEveryCredential();
    const fileBefore = readFileSync(harness.config.authFilePath);
    // The commit fails and the journal cannot be removed afterwards: the state a
    // process killed between staging and committing leaves.
    const files = new ScriptedFileSystem();
    files.fail('remove', stagePath(), Number.POSITIVE_INFINITY);
    const allowEditorInserts = refuseEditorInserts();
    expectFailure(serviceWithFiles(files).rotateAll(), 'STORE_ERROR');
    allowEditorInserts();
    const staged = readRecordAt(stagePath());
    expect(staged.token).not.toBe(issued.editor);
    expect(credentialRows().map((row) => row['token_hash'])).not.toContain(sha256Hex(staged.token));

    const restarted = restartService();
    expect(restarted.state.created).toBe(false);
    expect(expectConsistent(restarted)).toBe(issued.editor);
    expect(readFileSync(harness.config.authFilePath)).toEqual(fileBefore);
    expectStillValid(issued, restarted.auth);
    expectRefusal(
      authorize('session.list', staged.token, undefined, restarted.auth),
      'unknown-credential',
      [staged.token],
    );
    const lines = expectQuietLogsSince(firstLine);
    expect(lines.some((line) => line.includes('discarded an uncommitted'))).toBe(true);
  });

  it('keeps a committed rotation when auth.json cannot be updated, closes every socket, and the next start publishes it', () => {
    const issued = issueEveryCredential();
    const fileBefore = readFileSync(harness.config.authFilePath);
    const files = new ScriptedFileSystem();
    files.fail('write', harness.config.authFilePath, Number.POSITIVE_INFINITY);

    const error = expectFailure(serviceWithFiles(files).rotateAll(), 'INTERNAL');
    expect(error.message).toMatch(/rotated, but auth\.json could not be updated/);
    expect(error.hint).toMatch(/Restart/);
    expect(error.details?.['rotated']).toBe(true);
    // The first write and one retry.
    expect(files.count('write', harness.config.authFilePath)).toBe(2);
    expect(files.count('remove', stagePath())).toBe(0);

    // The rotation is durable although the file is behind it: every old
    // credential is refused and every socket was closed.
    expect(readFileSync(harness.config.authFilePath)).toEqual(fileBefore);
    expect(modeOf(stagePath())).toBe(0o600);
    const staged = readRecordAt(stagePath());
    const rows = credentialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['token_hash']).toBe(sha256Hex(staged.token));
    expect(pairingRows()).toHaveLength(0);
    expect(harness.revoker.calls).toHaveLength(1);
    expect(harness.revoker.calls[0]?.code).toBe(WS_CLOSE_UNAUTHORIZED);
    expectRetired(issued, harness.auth);

    const restarted = restartService();
    expect(restarted.state.created).toBe(false);
    expect(expectConsistent(restarted)).toBe(staged.token);
    expectRetired(issued, restarted.auth);
    const lines = expectQuietLogsSince(firstLine);
    expect(lines.some((line) => line.includes('completed an interrupted'))).toBe(true);
  });

  it('retries a failed publish once, so a transient failure still completes the rotation', () => {
    const issued = issueEveryCredential();
    const files = new ScriptedFileSystem();
    files.fail('write', harness.config.authFilePath, 1);

    const outcome = expectOk(serviceWithFiles(files).rotateAll());
    expect(outcome.credentialsDeleted).toBe(CREDENTIAL_ROLES.length);
    expect(files.count('write', harness.config.authFilePath)).toBe(2);
    expect(existsSync(stagePath())).toBe(false);
    const { token } = readAuthFile(harness.config);
    expect(credentialRows().map((row) => row['token_hash'])).toEqual([sha256Hex(token)]);
    expectRetired(issued, harness.auth);
  });

  it('completes a rotation whose journal cannot be removed after auth.json was updated, and the next start clears it', () => {
    const issued = issueEveryCredential();
    const files = new ScriptedFileSystem();
    files.fail('remove', stagePath(), Number.POSITIVE_INFINITY);

    const outcome = expectOk(serviceWithFiles(files).rotateAll());
    expect(outcome.socketsClosed).toBe(OPEN_SOCKETS);
    const published = readAuthFile(harness.config);
    expect(readRecordAt(stagePath())).toEqual(published);
    const fileAfterRotation = readFileSync(harness.config.authFilePath);
    expectRetired(issued, harness.auth);

    const restarted = restartService();
    expect(restarted.state.created).toBe(false);
    expect(expectConsistent(restarted)).toBe(published.token);
    expect(readFileSync(harness.config.authFilePath)).toEqual(fileAfterRotation);
    expectRetired(issued, restarted.auth);
  });

  it('mints a new credential rather than reviving one a committed rotation retired, when the journal was lost', () => {
    const issued = issueEveryCredential();
    const files = new ScriptedFileSystem();
    files.fail('write', harness.config.authFilePath, Number.POSITIVE_INFINITY);
    expectFailure(serviceWithFiles(files).rotateAll(), 'INTERNAL');
    const staged = readRecordAt(stagePath());
    // The journal is lost: auth.json still names the retired editor credential,
    // and the store holds only the one it was replaced by.
    unlinkSync(stagePath());

    const restarted = restartService();
    expect(restarted.state.created).toBe(true);
    const token = expectConsistent(restarted);
    expect(token).not.toBe(issued.editor);
    expect(token).not.toBe(staged.token);
    expectRetired(issued, restarted.auth);
    expectRefusal(
      authorize('session.list', staged.token, undefined, restarted.auth),
      'unknown-credential',
      [staged.token],
    );
  });

  it('discards a journal another account could read and issues a new editor credential', () => {
    const issued = issueEveryCredential();
    const files = new ScriptedFileSystem();
    files.fail('remove', stagePath(), Number.POSITIVE_INFINITY);
    expectOk(serviceWithFiles(files).rotateAll());
    const exposed = readRecordAt(stagePath()).token;
    expect(readAuthFile(harness.config).token).toBe(exposed);
    chmodSync(stagePath(), 0o640);

    const restarted = restartService();
    expect(restarted.state.created).toBe(true);
    const token = expectConsistent(restarted);
    expect(token).not.toBe(exposed);
    expectRefusal(
      authorize('session.list', exposed, undefined, restarted.auth),
      'unknown-credential',
      [exposed],
    );
    expectRetired(issued, restarted.auth);
  });

  it('discards a journal that is not a record this service wrote, and adopts auth.json as it stands', () => {
    const editor = editorToken();
    writeFileSync(stagePath(), '{ "version": "not-a-record" ', { mode: 0o600 });

    const restarted = restartService();
    expect(restarted.state.created).toBe(false);
    expect(expectConsistent(restarted)).toBe(editor);
  });

  it('refuses a journal that is a symbolic link, at start and before a rotation, and follows it nowhere', () => {
    const issued = issueEveryCredential();
    const decoy = join(harness.sandbox, 'decoy.json');
    writeFileSync(decoy, 'decoy', { mode: 0o600 });
    symlinkSync(decoy, stagePath());

    expectFailure(harness.auth.ensureEditorCredential(), 'FS_UNSAFE_PATH');
    const refused = expectFailure(harness.auth.rotateAll(), 'FS_UNSAFE_PATH');
    expect(refused.message).toMatch(/not rotated/);
    expect(lstatSync(stagePath()).isSymbolicLink()).toBe(true);
    expect(readFileSync(decoy, 'utf8')).toBe('decoy');
    expect(harness.revoker.calls).toHaveLength(0);
    expectStillValid(issued, harness.auth);
  });

  it('finishes at the next start a first-start credential whose auth.json could not be written', () => {
    const files = new ScriptedFileSystem();
    files.fail('write', harness.config.authFilePath, Number.POSITIVE_INFINITY);

    expectFailure(serviceWithFiles(files).ensureEditorCredential(), 'INTERNAL');
    expect(existsSync(harness.config.authFilePath)).toBe(false);
    const staged = readRecordAt(stagePath());
    expect(credentialRows().map((row) => row['token_hash'])).toEqual([sha256Hex(staged.token)]);

    const restarted = restartService();
    expect(restarted.state.created).toBe(false);
    expect(expectConsistent(restarted)).toBe(staged.token);
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

  it('draws every refusal code from the closed error-code set, answered with 400, 401, 403 or 429', () => {
    const reasons = Object.keys(AUTH_FAILURE_REASONS);
    expect(reasons.length).toBeGreaterThan(0);
    for (const descriptor of Object.values(AUTH_FAILURE_REASONS)) {
      expect(DEBUGGEN_ERROR_CODES).toContain(descriptor.code);
      expect([400, 401, 403, 429]).toContain(descriptor.status);
    }
    // 400 is the malformed acting-tab header alone: every credential, origin
    // and scope refusal keeps its 401/403/429.
    expect(
      Object.entries(AUTH_FAILURE_REASONS)
        .filter(([, descriptor]) => descriptor.status === 400)
        .map(([reason]) => reason),
    ).toEqual(['acting-tab-invalid']);
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
