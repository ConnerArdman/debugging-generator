/**
 * Tests for `./main.ts`, the service's composition root.
 *
 * They cover what only the composed process can show — properties of the
 * filesystem, of the listening socket and of process state rather than of any
 * one subsystem's return value:
 *
 * 1. **The state tree, the store and the editor credential.** `$DEBUGGEN_HOME`
 *    and its subdirectories are `0700`, every file in it — the database, its
 *    write-ahead sidecars and `auth.json` — is `0600` (AAP 0.4.2, 0.5.6), a
 *    planted link is refused without its target being touched, and the editor
 *    token is adopted across restarts and never reaches a log record.
 * 2. **A refused start leaves nothing behind.** Every step reports a typed `Err`
 *    and releases what earlier steps acquired, so a retry on the same state root
 *    meets a clean tree rather than its own predecessor.
 * 3. **Crash recovery runs before serving** (AAP 0.5.1). A file a previous
 *    process left instrumented is restored byte-for-byte by the next start,
 *    before the handle — and therefore any client — exists.
 * 4. **One server, two protocols.** The health route, the origin policy and
 *    the bearer requirement on the HTTP side; the `client.hello` handshake on the
 *    WebSocket side, observed through `pairingAvailable`, which reports whether
 *    an editor is connected to display a pairing code.
 * 5. **Shutdown** is idempotent, closes sockets with the going-away code and
 *    folds the write-ahead log back into the database.
 * 6. The composition adapters this file owns — the agent-readiness ledger and
 *    the entry guard — directly.
 * 7. **The state root stays outside every project.** A start whose stored
 *    sessions' projects contain `$DEBUGGEN_HOME` or lie inside it is refused
 *    after crash recovery restored their files, so is one whose stored
 *    project cannot be resolved on disk (fail-closed), and the served session
 *    and dev-server routes refuse such a project.
 * 8. **Every connection is bounded** (CWE-400): the header deadline closes a
 *    stalled or silent connection with a raw `408`, a malformed or oversized
 *    request is answered and closed, an upgraded WebSocket outlives the request
 *    deadline, and a connection past the cap is refused and reported. The
 *    pre-auth admission budget holds too: a flood of stalled connections is
 *    evicted oldest first so an authenticated request, a slow handler and a
 *    WebSocket are all still served, connections past the admission rate are
 *    closed unanswered until the bucket refills, and a newcomer is refused at
 *    the soft cap only when every connection held is serving a request.
 *
 * Every start passes `env: {}` and explicit overrides, so nothing here reads the
 * developer's environment or `.env`: a fresh `mkdtemp` state root, `port: 0` and
 * `logLevel: 'silent'` (or a capturing destination where a case reads the log).
 * `realpathSync` is applied to the temporary root because `ensureSecureDir`
 * refuses a path whose existing prefix contains a symbolic link, which
 * `os.tmpdir()` is on macOS.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createBackupStore, createModificationRecord } from '@debuggen/instrumentation';
import type { ModificationRecord } from '@debuggen/instrumentation';
import {
  AUTHORIZATION_HEADER,
  HttpClient,
  PROTOCOL_VERSION,
  SESSION_STATUSES,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  createEnvelope,
  encodeMessage,
  formatBearer,
  healthResponseSchema,
  type AgentReadyPayload,
  type SessionStatus,
} from '@debuggen/protocol';
import {
  DebuggenError,
  createConsoleLogger,
  err,
  isErr,
  isOk,
  newEventId,
  newProducerId,
  newSpanId,
  newTraceId,
  noopLogger,
  ok,
  unwrap,
} from '@debuggen/shared';
import type { LogRecord, Logger, Result } from '@debuggen/shared';
import { MIN_EPOCH_MS } from '@debuggen/telemetry';
import type { SessionRecord } from '@debuggen/protocol';
import { sha256Hex } from '@debuggen/shared/node';

import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { connect as connectTcp, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  AUTH_FILE_NAME,
  PROJECT_ROOT_UNRESOLVABLE_REASON,
  SESSIONS_DATABASE_FILE_NAME,
  STATE_HOME_OVERLAP_HINT,
  STATE_HOME_OVERLAP_MESSAGE,
  STATE_HOME_OVERLAP_REASON,
  loadServiceConfig,
} from './config.js';
import { createDevServerLauncher } from './dev-server/launcher.js';
import type { DevServerLauncher, DevServerTerminationReport } from './dev-server/launcher.js';
import { fingerprintDocumentId } from './instrumentation/document-fingerprint.js';
import type { ArmingSnapshot } from './instrumentation/service.js';
import { LOG_BINDING_KEYS, createServiceLogger } from './logging.js';
import {
  DEV_SERVER_STOP_GRACE_MS,
  DROPPED_CONNECTIONS_REPORT_INTERVAL_MS,
  EXIT_BACKSTOP_MS,
  HTTP_SERVER_LIMITS,
  LAUNCHER_KILL_CONFIRM_MS,
  LAUNCHER_REVOCATION_SLACK_MS,
  SERVICE_VERSION,
  SHUTDOWN_BUDGET,
  STORED_PROJECT_UNRESOLVABLE_STARTUP_HINT,
  STORED_PROJECT_UNRESOLVABLE_STARTUP_MESSAGE,
  createAgentReadyLedger,
  createIngestSourceLocator,
  createLimitedServer,
  endLiveSessions,
  isProcessEntry,
  regatingBindingRoutes,
  regatingReadinessPort,
  releaseParts,
  startService,
  type HttpServerLimits,
  type ServiceHandle,
  type ServiceLoggers,
  type ServiceParts,
  type ShutdownBudget,
  type StartServiceOptions,
} from './main.js';
import type { PipelineCodeHandles } from './pipeline/context-builder.js';
import type { RegateRequest } from './pipeline/orchestrator.js';
import { createAuthService } from './server/auth.js';
import { DEFAULT_MAX_CLIENTS, WS_CLOSE_GOING_AWAY } from './server/clients.js';
import { DEFAULT_REQUEST_BODY_TIMEOUT_MS } from './server/http.js';
import type {
  BindingConnection,
  BindingRoutes,
  SessionBindOutcome,
} from './server/routes/binding.js';
import type { WsConnectionFacts } from './server/ws.js';
import type { SessionEndResult } from './sessions/manager.js';
import type { AttributedEvent, IngestAttribution } from './telemetry/attribute.js';
import { openStore } from './store/db.js';
import { createModificationsRepo } from './store/modifications-repo.js';
import { STORE_SCHEMA_VERSION } from './store/migrations.js';
import { MAX_SESSION_LIST_LIMIT } from './store/sessions-repo.js';
import type { SessionListItem } from './store/sessions-repo.js';

/** The permission bits of a mode, masked out of the file-type bits. */
const PERMISSION_BITS = 0o777;

/** What AAP 0.4.2 requires of every file under `$DEBUGGEN_HOME`. */
const OWNER_ONLY_FILE = 0o600;

/** What AAP 0.4.2 requires of every directory under `$DEBUGGEN_HOME`. */
const OWNER_ONLY_DIR = 0o700;

/** How long a polling assertion waits before failing. */
const POLL_TIMEOUT_MS = 5_000;

/** The constant `msg` of the record a refused start writes (`STARTUP_REFUSED_MESSAGE`). */
const STARTUP_REFUSED_MSG = 'the Debug Generator service could not start';

/**
 * Whether a mode of `0o000` denies this process a directory search: never for
 * uid 0, which bypasses permission bits, nor where POSIX ids are unavailable.
 */
const CAN_DENY_SEARCH = typeof process.getuid === 'function' && process.getuid() !== 0;

/** Temporary roots and open handles this suite cleans up after itself. */
const roots: string[] = [];
const handles: ServiceHandle[] = [];
const sockets: WebSocket[] = [];

/**
 * Every container {@link makeStateRoot} ever created in this file — unlike
 * `roots`, never spliced by `afterEach`.
 *
 * A test that exceeds its timeout keeps running after Vitest has moved on: its
 * `afterEach` has already spliced and removed `roots`, and a `startService` the
 * late body calls afterwards re-creates the removed container — its state root
 * is created with every missing ancestor — and holds it open. Only this record
 * still names that container when the file-level `afterAll` runs, so it is what
 * lets the file remove every temporary directory it created, whatever its
 * tests did after their deadline.
 */
const createdContainers: string[] = [];

/**
 * The {@link start} calls still in flight, so the file-level `afterAll` can
 * wait for a late test body's start to settle — and its handle to be
 * registered — before it releases the handles and removes the containers.
 */
const pendingStarts = new Set<Promise<unknown>>();

/**
 * A fresh, symlink-free temporary directory and the state root inside it. The
 * state root is a *child* of the `mkdtemp` directory so `ensureSecureDir` is
 * exercised on a component it creates, as on a developer's first run.
 */
function makeStateRoot(): { readonly container: string; readonly stateRoot: string } {
  const container = mkdtempSync(join(realpathSync(tmpdir()), 'debuggen-main-test-'));
  roots.push(container);
  createdContainers.push(container);
  return { container, stateRoot: join(container, 'home') };
}

/** Starts the service against `stateRoot` on an ephemeral port. */
function start(
  stateRoot: string,
  extra: Omit<StartServiceOptions, 'env'> = {},
): ReturnType<typeof startService> {
  const starting = (async () => {
    const started = await startService({
      env: {},
      ...extra,
      overrides: { debuggenHome: stateRoot, port: 0, logLevel: 'silent', ...extra.overrides },
    });
    if (isOk(started)) {
      handles.push(started.value);
    }
    return started;
  })();
  pendingStarts.add(starting);
  // Both reactions only deregister, so this derived promise always fulfils;
  // the caller still observes a rejection through `starting` itself.
  const settled = (): void => {
    pendingStarts.delete(starting);
  };
  void starting.then(settled, settled);
  return starting;
}

/** Starts the service and fails the test when it does not start. */
async function started(stateRoot: string): Promise<ServiceHandle> {
  const result = await start(stateRoot);
  if (isErr(result)) {
    expect.unreachable(`startService failed: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** The permission bits of the entry *at* `path`, never of a link's target. */
function modeOf(path: string): number {
  return lstatSync(path).mode & PERMISSION_BITS;
}

/** The editor token `auth.json` holds. */
function editorToken(stateRoot: string): string {
  const record: unknown = JSON.parse(readFileSync(join(stateRoot, AUTH_FILE_NAME), 'utf8'));
  if (
    typeof record !== 'object' ||
    record === null ||
    !('token' in record) ||
    typeof record.token !== 'string'
  ) {
    throw new Error('auth.json does not hold a string token');
  }
  return record.token;
}

/** The `version` this workspace's `package.json` declares. */
function manifestVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error('apps/local-service/package.json does not declare a string "version"');
  }
  return manifest.version;
}

/** Reads the health body. */
async function health(url: string): Promise<unknown> {
  return (await fetch(`${url}/health`)).json();
}

/** Polls `probe` until it returns `true` or the timeout elapses. */
async function eventually(probe: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return probe();
}

/** Opens a WebSocket to the service and resolves once it is open. */
function connect(handle: ServiceHandle): Promise<WebSocket> {
  const socket = new WebSocket(`${handle.url.replace(/^http/u, 'ws')}${handle.wsPath}`);
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/** Resolves with the close code once `socket` closes. */
function closeCodeOf(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once('close', (code: number) => {
      resolve(code);
    });
  });
}

/** Sends the editor's `client.hello`, announcing `projectRoot` as its workspace. */
function helloAsEditor(socket: WebSocket, token: string, projectRoot: string): void {
  socket.send(
    encodeMessage(
      createEnvelope('client.hello', {
        client: 'vscode',
        projectRoot,
        version: PROTOCOL_VERSION,
        token,
      }),
    ),
  );
}

/** Sends a dev-server preload's `client.hello`, scoped to `projectRoot`. */
function helloAsServerAgent(socket: WebSocket, token: string, projectRoot: string): void {
  socket.send(
    encodeMessage(
      createEnvelope('client.hello', {
        client: 'server-agent',
        projectRoot,
        version: PROTOCOL_VERSION,
        token,
      }),
    ),
  );
}

/** One frame a test socket received: its type and payload. */
interface ReceivedFrame {
  readonly type: string;
  readonly payload: unknown;
}

/** Records every frame `socket` receives, in arrival order. */
function framesOf(socket: WebSocket): ReceivedFrame[] {
  const frames: ReceivedFrame[] = [];
  socket.on('message', (data: Buffer) => {
    const parsed: unknown = JSON.parse(data.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      frames.push({
        type: String(parsed.type),
        payload: 'payload' in parsed ? parsed.payload : undefined,
      });
    }
  });
  return frames;
}

/** A log destination that keeps every JSON record it is handed. */
function capturingDestination(): { readonly records: string[]; write(record: string): void } {
  const records: string[] = [];
  return {
    records,
    write(record: string): void {
      records.push(record);
    },
  };
}

/** What {@link instrumentFileOf} left behind. */
interface PatchedFile {
  readonly session: SessionRecord;
  readonly record: ModificationRecord;
  readonly file: string;
  readonly originalBytes: string;
  readonly instrumentedBytes: string;
}

/**
 * Leaves `projectRoot` the way an install does: a new session, the original
 * bytes in its backup store, an `applied` journal record carrying both hashes,
 * and the instrumented bytes on disk.
 */
async function instrumentFileOf(
  handle: ServiceHandle,
  stateRoot: string,
  projectRoot: string,
): Promise<PatchedFile> {
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  const file = 'src/checkout.ts';
  const originalBytes = 'export function total(): number {\n  return 1;\n}\n';
  const instrumentedBytes =
    'export function total(): number {\n  return (globalThis as never, 1);\n}\n';
  const session = unwrap(
    await handle.manager.create({
      projectRoot,
      question: 'Why is it slow?',
      devServerUrl: 'http://127.0.0.1:3000',
    }),
  );
  const originalHash = sha256Hex(originalBytes);
  const backups = createBackupStore({ debuggenHome: stateRoot, sessionId: session.id });
  unwrap(await backups.put(originalHash, Buffer.from(originalBytes, 'utf8')));
  const record = unwrap(
    createModificationRecord({
      sessionId: session.id,
      planVersion: 1,
      file,
      originalHash,
      backupPath: unwrap(backups.locate(originalHash)),
      instrumentedHash: sha256Hex(instrumentedBytes),
      // The exact unified diff of the two texts, as the patcher records it: a
      // conflict's three-way view is reconstructed from it.
      diff: [
        `--- a/${file}`,
        `+++ b/${file}`,
        '@@ -1,3 +1,3 @@',
        ' export function total(): number {',
        '-  return 1;',
        '+  return (globalThis as never, 1);',
        ' }',
        '',
      ].join('\n'),
      status: 'applied',
    }),
  );
  unwrap(await createModificationsRepo({ store: handle.store }).append(record));
  writeFileSync(join(projectRoot, file), instrumentedBytes);
  return { session, record, file, originalBytes, instrumentedBytes };
}

/** Connects an editor announcing `projectRoot` and waits until the service has registered it. */
async function connectEditor(
  handle: ServiceHandle,
  stateRoot: string,
  projectRoot: string,
): Promise<{ readonly frames: ReceivedFrame[]; readonly closed: Promise<number> }> {
  const socket = await connect(handle);
  const frames = framesOf(socket);
  const closed = closeCodeOf(socket);
  helloAsEditor(socket, editorToken(stateRoot), projectRoot);
  const registered = await eventually(async () => {
    const body = await health(handle.url);
    return (body as { pairingAvailable?: unknown }).pairingAvailable === true;
  });
  expect(registered).toBe(true);
  return { frames, closed };
}

/**
 * Terminates every registered socket, closes every registered handle, then
 * removes `containers` — in that order, because a closing service still writes
 * into its state root (the store folds its write-ahead log back on close). The
 * containers are removed even if a close rejects, which `ServiceHandle.close`
 * promises never to do; the rejection would still fail the hook.
 */
async function releaseRegistered(containers: readonly string[]): Promise<void> {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  try {
    for (const handle of handles.splice(0)) {
      await handle.close();
    }
  } finally {
    for (const container of containers) {
      rmSync(container, { recursive: true, force: true });
    }
  }
}

afterEach(async () => {
  await releaseRegistered(roots.splice(0));
});

/**
 * The file-level backstop behind `afterEach`: a test body that outlives its
 * timeout keeps registering sockets, handles and containers after its
 * `afterEach` has run, and nothing else would release what it registers once
 * the file's last test is done. Starts still in flight are awaited first, so
 * their handles are registered and closed too; then every container this file
 * ever created is removed — `force` makes the ones `afterEach` already removed
 * a no-op.
 */
afterAll(async () => {
  await Promise.allSettled(pendingStarts);
  roots.splice(0);
  await releaseRegistered(createdContainers.splice(0));
});

describe('startService — the state tree, the store and the editor credential', () => {
  it('creates the tree 0700 and every file 0600, migrates the schema and mints the credential', async () => {
    const { stateRoot } = makeStateRoot();
    const handle = await started(stateRoot);

    expect(modeOf(stateRoot)).toBe(OWNER_ONLY_DIR);
    expect(modeOf(join(stateRoot, 'backups'))).toBe(OWNER_ONLY_DIR);
    expect(modeOf(join(stateRoot, 'index'))).toBe(OWNER_ONLY_DIR);

    const databasePath = join(stateRoot, SESSIONS_DATABASE_FILE_NAME);
    expect(lstatSync(databasePath).isFile()).toBe(true);
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      expect(modeOf(path)).toBe(OWNER_ONLY_FILE);
    }

    const authPath = join(stateRoot, AUTH_FILE_NAME);
    expect(lstatSync(authPath).isFile()).toBe(true);
    expect(modeOf(authPath)).toBe(OWNER_ONLY_FILE);
    expect(editorToken(stateRoot).length).toBeGreaterThan(0);
    expect(handle.startup.editorCredentialCreated).toBe(true);
    expect(handle.startup.reconciliation.status).toBe('clean');
    // The start-up sweep runs in the background once the service listens.
    expect(await handle.startup.retention).toBeDefined();

    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()?.['user_version']).toBe(STORE_SCHEMA_VERSION);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row['name']);
      expect(tables).toEqual(
        expect.arrayContaining(['sessions', 'modifications', 'telemetry_events', 'credentials']),
      );
      // The store keeps a digest of the editor credential, never the token.
      const token = editorToken(stateRoot);
      const stored = JSON.stringify(db.prepare('SELECT * FROM credentials').all());
      expect(stored).not.toContain(token);
      expect(stored).toContain(sha256Hex(token));
    } finally {
      db.close();
    }
  });

  it('adopts the credential on the next start and never logs the token', async () => {
    const { stateRoot } = makeStateRoot();
    const records: string[] = [];
    const destination = {
      write(record: string): void {
        records.push(record);
      },
    };

    const first = await start(stateRoot, {
      overrides: { logLevel: 'debug' },
      loggerOptions: { destination },
    });
    expect(isOk(first)).toBe(true);
    const token = editorToken(stateRoot);
    for (const handle of handles.splice(0)) {
      await handle.close();
    }

    const second = await start(stateRoot, {
      overrides: { logLevel: 'debug' },
      loggerOptions: { destination },
    });
    expect(isOk(second)).toBe(true);
    if (isOk(second)) {
      expect(second.value.startup.editorCredentialCreated).toBe(false);
    }
    expect(editorToken(stateRoot)).toBe(token);

    const logged = records.join('');
    expect(logged).toContain('the Debug Generator service has stopped');
    expect(logged).not.toContain(token);
  });

  it('restricts a database it adopts, rather than only one it creates', async () => {
    const { stateRoot } = makeStateRoot();
    const databasePath = join(stateRoot, SESSIONS_DATABASE_FILE_NAME);
    mkdirSync(stateRoot, { recursive: true, mode: OWNER_ONLY_DIR });
    writeFileSync(databasePath, '');
    chmodSync(databasePath, 0o666);

    const result = await start(stateRoot);
    expect(isOk(result)).toBe(true);
    expect(modeOf(databasePath)).toBe(OWNER_ONLY_FILE);
  });

  it('refuses a symbolic link planted at the database path, leaving its target untouched', async () => {
    const { container, stateRoot } = makeStateRoot();
    const decoy = join(container, 'decoy.txt');
    const decoyContent = 'bytes that belong to another file\n';
    writeFileSync(decoy, decoyContent);
    mkdirSync(stateRoot, { recursive: true, mode: OWNER_ONLY_DIR });
    symlinkSync(decoy, join(stateRoot, SESSIONS_DATABASE_FILE_NAME));

    const result = await start(stateRoot);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('FS_UNSAFE_PATH');
      expect(result.error.message).not.toContain(decoyContent.trim());
    }
    expect(readFileSync(decoy, 'utf8')).toBe(decoyContent);
  });

  it('accepts a start on the same state root once the planted link is removed', async () => {
    const { container, stateRoot } = makeStateRoot();
    const databasePath = join(stateRoot, SESSIONS_DATABASE_FILE_NAME);
    writeFileSync(join(container, 'decoy.txt'), 'decoy\n');
    mkdirSync(stateRoot, { recursive: true, mode: OWNER_ONLY_DIR });
    symlinkSync(join(container, 'decoy.txt'), databasePath);

    expect(isErr(await start(stateRoot))).toBe(true);

    rmSync(databasePath);
    expect(isOk(await start(stateRoot))).toBe(true);
    expect(modeOf(databasePath)).toBe(OWNER_ONLY_FILE);
  });

  it('refuses a non-regular entry at the database path', async () => {
    const { stateRoot } = makeStateRoot();
    mkdirSync(join(stateRoot, SESSIONS_DATABASE_FILE_NAME), { recursive: true, mode: 0o700 });

    const result = await start(stateRoot);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(['FS_UNSAFE_PATH', 'STORE_ERROR']).toContain(result.error.code);
    }
  });

  it('refuses an invalid configuration before touching the filesystem', async () => {
    const { stateRoot } = makeStateRoot();

    const result = await start(stateRoot, { overrides: { port: 70_000 } });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('CONFIG_INVALID');
    }
    expect(() => lstatSync(stateRoot)).toThrow();
  });

  it('refuses a missing prompts directory before touching the filesystem, naming DEBUGGEN_PROMPTS_DIR', async () => {
    const { container, stateRoot } = makeStateRoot();

    for (const promptsDir of [join(container, 'absent-prompts'), container]) {
      const refused = await start(stateRoot, { overrides: { promptsDir } });
      expect(isErr(refused)).toBe(true);
      if (isErr(refused)) {
        expect(refused.error.code).toBe('CONFIG_INVALID');
        expect(refused.error.message).toContain('DEBUGGEN_PROMPTS_DIR');
        expect(`${refused.error.message} ${refused.error.hint ?? ''}`).not.toContain(
          'createPromptLoader',
        );
      }
      // Refused like any other configuration key: no state root, no
      // credential, no store.
      expect(() => lstatSync(stateRoot)).toThrow();
    }
  });

  it('refuses a broken prompt tree and releases the store it had opened', async () => {
    const { container, stateRoot } = makeStateRoot();
    const emptyPrompts = join(container, 'prompts');
    mkdirSync(emptyPrompts, { recursive: true });
    // A manifest is present, so the read-only check of step 1 passes and the
    // tree's contents are refused at step 9, after the store has opened.
    writeFileSync(join(emptyPrompts, 'manifest.json'), '{}');

    const refused = await start(stateRoot, { overrides: { promptsDir: emptyPrompts } });
    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.code).toBe('CONFIG_INVALID');
    }

    // The store, the credential and everything else were released: the same
    // state root starts cleanly and the refused start's sidecars are folded in.
    expect(() => lstatSync(join(stateRoot, `${SESSIONS_DATABASE_FILE_NAME}-wal`))).toThrow();
    expect(isOk(await start(stateRoot))).toBe(true);
  });

  it("names a refusal by step and code, never copying a collaborator's hint or details into ordinary fields", async () => {
    const { container, stateRoot } = makeStateRoot();
    // Low-entropy sentinels a collaborator's error quotes: the prompt loader
    // names the directory it could not read in its hint and details, and this
    // directory's name carries a URL query value and an inline SQL literal.
    const urlSentinel = 'urlq7c1f';
    const sqlSentinel = 'sqllit9d4e';
    const promptsDir = join(
      container,
      `prompts?access_token=${urlSentinel} WHERE card = '${sqlSentinel}'`,
    );
    mkdirSync(promptsDir, { recursive: true });
    // Present but invalid, so the refusal comes from the prompt loader at step
    // 9, after the logger exists.
    writeFileSync(join(promptsDir, 'manifest.json'), '{}');
    const records: string[] = [];
    const destination = {
      write(record: string): void {
        records.push(record);
      },
    };

    const refused = await start(stateRoot, {
      overrides: { promptsDir, logLevel: 'info' },
      loggerOptions: { destination },
    });

    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      // The collaborator's own error does carry the sentinels, so the
      // assertions below are about the record, not about an empty error.
      const collaboratorText = JSON.stringify([refused.error.hint, refused.error.details]);
      expect(collaboratorText).toContain(urlSentinel);
      expect(collaboratorText).toContain(sqlSentinel);
    }
    const parsed = records
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const refusal = parsed.find((record) => record['msg'] === STARTUP_REFUSED_MSG);
    expect(refusal).toMatchObject({
      // pino's numeric `error` level.
      level: 50,
      step: 'prompts',
      code: 'CONFIG_INVALID',
      err: { type: 'DebuggenError', code: 'CONFIG_INVALID' },
    });
    expect(refusal).not.toHaveProperty('hint');
    expect(refusal).not.toHaveProperty('details');
    // Everything outside the error key — the ordinary fields the logger only
    // credential-scrubs — is free of the collaborator's text.
    const ordinaryText = JSON.stringify(
      Object.entries(refusal ?? {}).filter(([key]) => key !== 'err'),
    );
    expect(ordinaryText).not.toContain(urlSentinel);
    expect(ordinaryText).not.toContain(sqlSentinel);
  });
});

describe('startService — the state tree refusal names the directory and its fix', () => {
  it('names the mode of a too-open state root, the required 0700 and chmod 700, and leaves it as it was', async () => {
    const { stateRoot } = makeStateRoot();
    mkdirSync(stateRoot);
    chmodSync(stateRoot, 0o755);

    const refused = await start(stateRoot);

    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.code).toBe('FS_UNSAFE_PATH');
      expect(refused.error.message).toContain(stateRoot);
      expect(refused.error.message).toContain('0755');
      expect(refused.error.message).toContain('0700');
      expect(refused.error.hint).toContain(`chmod 700 ${stateRoot}`);
      expect(refused.error.hint).toContain('DEBUGGEN_HOME');
      expect(refused.error.hint).not.toContain('allow this account to write');
      expect(refused.error.details?.['reason']).toBe('group-or-other-permissions');
    }
    // Refused, never repaired: the developer decides what the directory holds.
    expect(modeOf(stateRoot)).toBe(0o755);
    expect(() => lstatSync(join(stateRoot, SESSIONS_DATABASE_FILE_NAME))).toThrow();
  });
});

/** Sixty days, well past the default thirty-day retention window. */
const AGED_BY_MS = 60 * 86_400_000;

describe('startService — the start-up retention sweep runs once the service listens', () => {
  it('serves before the sweep starts and purges an aged session in the background', async () => {
    const { container, stateRoot } = makeStateRoot();
    const projectRoot = join(container, 'project');
    mkdirSync(projectRoot);

    // A previous process left one resting session behind, last touched long ago.
    const first = await started(stateRoot);
    const aged = await storeSessionOf(first, projectRoot);
    for (const handle of handles.splice(0)) {
      await handle.close();
    }
    const db = new DatabaseSync(join(stateRoot, SESSIONS_DATABASE_FILE_NAME));
    try {
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(
        Date.now() - AGED_BY_MS,
        aged.id,
      );
    } finally {
      db.close();
    }

    const destination = capturingDestination();
    const second = unwrap(
      await start(stateRoot, { overrides: { logLevel: 'info' }, loggerOptions: { destination } }),
    );

    // The handle exists — the port is open — before any purge work ran.
    expect(
      parsedRecords(destination.records).some((r) => r['msg'] === 'retention sweep finished'),
    ).toBe(false);
    const answered = (await health(second.url)) as Record<string, unknown>;
    expect(typeof answered['protocolVersion']).toBe('string');

    const report = await second.startup.retention;
    expect(report?.sessionIdsDeleted).toEqual([aged.id]);
    expect(report?.interrupted).toBe(false);
    expect(unwrap(second.manager.get(aged.id))).toBeUndefined();
  });

  it('stops the sweep when the service stops, and settles it before the store closes', async () => {
    const { stateRoot } = makeStateRoot();
    const destination = capturingDestination();
    const handle = unwrap(
      await start(stateRoot, { overrides: { logLevel: 'info' }, loggerOptions: { destination } }),
    );

    await handle.close();

    const report = await handle.startup.retention;
    expect(report?.interrupted).toBe(true);
    expect(report?.errors).toEqual([]);
    const messages = parsedRecords(destination.records).map((r) => r['msg']);
    const stopped = messages.indexOf(
      'the start-up retention sweep was stopped by the shutdown; the next start sweeps again',
    );
    const closed = messages.indexOf(
      'the session store checkpointed its write-ahead log and closed',
    );
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(closed).toBeGreaterThan(stopped);
  });
});

describe('startService — crash recovery before serving', () => {
  it('restores a file an earlier process left instrumented, before the handle exists', async () => {
    const { container, stateRoot } = makeStateRoot();
    const projectRoot = join(container, 'project');

    // A first process: a session instruments one file and the process then
    // crashes — `retain` is exactly what a crash leaves: its journal says
    // `applied`, the file holds the patched bytes, and no cleanup ever ran.
    const first = await started(stateRoot);
    const { record, file, originalBytes, instrumentedBytes } = await instrumentFileOf(
      first,
      stateRoot,
      projectRoot,
    );
    for (const handle of handles.splice(0)) {
      await handle.close({ liveSessions: 'retain' });
    }
    expect(readFileSync(join(projectRoot, file), 'utf8')).toBe(instrumentedBytes);

    const second = await started(stateRoot);

    expect(readFileSync(join(projectRoot, file), 'utf8')).toBe(originalBytes);
    expect(second.startup.reconciliation.restored).toBe(1);
    expect(second.startup.reconciliation.conflicts).toBe(0);
    const journaled = unwrap(await createModificationsRepo({ store: second.store }).get(record.id));
    expect(journaled?.status).toBe('reverted');
  });
});

/**
 * The JSON records a capturing destination received, parsed.
 *
 * @param records The raw records.
 * @returns One object per record.
 */
function parsedRecords(records: readonly string[]): Record<string, unknown>[] {
  return records
    .join('')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Stores a session of `projectRoot` through the manager, bypassing the routes'
 * checks, the way a previous process's session is found by the next start.
 */
async function storeSessionOf(handle: ServiceHandle, projectRoot: string): Promise<SessionRecord> {
  return unwrap(
    await handle.manager.create({
      projectRoot,
      question: 'Why is it slow?',
      devServerUrl: 'http://127.0.0.1:3000',
    }),
  );
}

describe('startService — the state root stays outside every project', () => {
  it("restores an overlapping project's instrumented file first, then refuses to start and releases the store", async () => {
    const { container, stateRoot } = makeStateRoot();
    // The project is the directory that holds the state root.
    const first = await started(stateRoot);
    const { file, originalBytes, instrumentedBytes } = await instrumentFileOf(
      first,
      stateRoot,
      container,
    );
    for (const handle of handles.splice(0)) {
      await handle.close({ liveSessions: 'retain' });
    }
    expect(readFileSync(join(container, file), 'utf8')).toBe(instrumentedBytes);
    const destination = capturingDestination();

    const refused = await start(stateRoot, {
      overrides: { logLevel: 'info' },
      loggerOptions: { destination },
    });

    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.code).toBe('FS_UNSAFE_PATH');
      expect(refused.error.hint).toBe(STATE_HOME_OVERLAP_HINT);
      expect(refused.error.details).toMatchObject({
        reason: STATE_HOME_OVERLAP_REASON,
        relation: 'home-inside-project',
        overlappingProjects: 1,
      });
      expect(
        JSON.stringify([refused.error.message, refused.error.hint, refused.error.details]),
      ).not.toContain(container);
    }
    // The reconciliation ran before the refusal: the file is the developer's again.
    expect(readFileSync(join(container, file), 'utf8')).toBe(originalBytes);
    const refusal = parsedRecords(destination.records).find(
      (record) => record['msg'] === STARTUP_REFUSED_MSG,
    );
    expect(refusal).toMatchObject({
      level: 50,
      step: 'state-home-overlap',
      code: 'FS_UNSAFE_PATH',
    });
    expect(JSON.stringify(refusal)).not.toContain(container);
    // Everything the refused start acquired was released.
    expect(() => lstatSync(join(stateRoot, `${SESSIONS_DATABASE_FILE_NAME}-wal`))).toThrow();
  });

  it('refuses stored projects inside the state root: one not created yet, one reached through a link', async () => {
    const { container, stateRoot } = makeStateRoot();
    const first = await started(stateRoot);
    const inside = join(stateRoot, 'projects', 'shop');
    mkdirSync(inside, { recursive: true });
    const link = join(container, 'linked-shop');
    symlinkSync(inside, link);
    await storeSessionOf(first, join(stateRoot, 'not-yet', 'created'));
    await storeSessionOf(first, link);
    for (const handle of handles.splice(0)) {
      await handle.close();
    }

    const refused = await start(stateRoot);

    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.code).toBe('FS_UNSAFE_PATH');
      expect(refused.error.details).toMatchObject({
        reason: STATE_HOME_OVERLAP_REASON,
        relation: 'project-inside-home',
        overlappingProjects: 2,
      });
    }
  });

  it("starts when every stored project lies apart, including a sibling whose name extends the state root's", async () => {
    const { container, stateRoot } = makeStateRoot();
    const first = await started(stateRoot);
    const sibling = `${stateRoot}-shop`;
    mkdirSync(sibling, { recursive: true });
    await storeSessionOf(first, sibling);
    await storeSessionOf(first, join(container, 'project'));
    for (const handle of handles.splice(0)) {
      await handle.close();
    }

    expect(isOk(await start(stateRoot))).toBe(true);
  });

  it('refuses to start, fail-closed, when a stored project cannot be resolved on disk, then starts once it can', async () => {
    const { container, stateRoot } = makeStateRoot();
    const first = await started(stateRoot);
    // Two links naming each other: `realpath` answers ELOOP, whoever runs it.
    const loopA = join(container, 'loop-a');
    const loopB = join(container, 'loop-b');
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);
    await storeSessionOf(first, join(loopA, 'shop'));
    await storeSessionOf(first, join(container, 'project'));
    for (const handle of handles.splice(0)) {
      await handle.close();
    }
    const destination = capturingDestination();

    const refused = await start(stateRoot, {
      overrides: { logLevel: 'info' },
      loggerOptions: { destination },
    });

    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.code).toBe('FS_UNSAFE_PATH');
      expect(refused.error.message).toBe(STORED_PROJECT_UNRESOLVABLE_STARTUP_MESSAGE);
      expect(refused.error.hint).toBe(STORED_PROJECT_UNRESOLVABLE_STARTUP_HINT);
      expect(refused.error.details).toMatchObject({
        reason: PROJECT_ROOT_UNRESOLVABLE_REASON,
        unresolvedProjects: 1,
        storedProjects: 2,
      });
      expect(
        JSON.stringify([refused.error.message, refused.error.hint, refused.error.details]),
      ).not.toContain(container);
    }
    const refusal = parsedRecords(destination.records).find(
      (record) => record['msg'] === STARTUP_REFUSED_MSG,
    );
    expect(refusal).toMatchObject({
      level: 50,
      step: 'state-home-overlap',
      code: 'FS_UNSAFE_PATH',
    });
    expect(JSON.stringify(refusal)).not.toContain(container);
    // Everything the refused start acquired was released.
    expect(() => lstatSync(join(stateRoot, `${SESSIONS_DATABASE_FILE_NAME}-wal`))).toThrow();

    // Breaking the loop is the recovery: the missing root resolves through its
    // nearest existing ancestor, apart from the state root.
    rmSync(loopA);
    rmSync(loopB);
    expect(isOk(await start(stateRoot))).toBe(true);
  });

  it('reports a proven overlap in preference to a stored project it could not resolve', async () => {
    const { container, stateRoot } = makeStateRoot();
    const first = await started(stateRoot);
    const loop = join(container, 'loop');
    symlinkSync(loop, loop);
    await storeSessionOf(first, join(loop, 'shop'));
    await storeSessionOf(first, container);
    for (const handle of handles.splice(0)) {
      await handle.close();
    }

    const refused = await start(stateRoot);

    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.hint).toBe(STATE_HOME_OVERLAP_HINT);
      expect(refused.error.details).toMatchObject({
        reason: STATE_HOME_OVERLAP_REASON,
        relation: 'home-inside-project',
        overlappingProjects: 1,
      });
    }
  });

  it.skipIf(!CAN_DENY_SEARCH)(
    'refuses to start when a folder above a stored project is no longer searchable',
    async () => {
      const { container, stateRoot } = makeStateRoot();
      const first = await started(stateRoot);
      const locked = join(container, 'locked');
      mkdirSync(join(locked, 'shop'), { recursive: true });
      await storeSessionOf(first, join(locked, 'shop'));
      for (const handle of handles.splice(0)) {
        await handle.close();
      }

      chmodSync(locked, 0o000);
      let refused: Awaited<ReturnType<typeof start>>;
      try {
        refused = await start(stateRoot);
      } finally {
        chmodSync(locked, OWNER_ONLY_DIR);
      }

      expect(isErr(refused)).toBe(true);
      if (isErr(refused)) {
        expect(refused.error.message).toBe(STORED_PROJECT_UNRESOLVABLE_STARTUP_MESSAGE);
        expect(refused.error.details).toMatchObject({
          reason: PROJECT_ROOT_UNRESOLVABLE_REASON,
          unresolvedProjects: 1,
          storedProjects: 1,
        });
      }
      // Access restored, the same state root starts.
      expect(isOk(await start(stateRoot))).toBe(true);
    },
  );

  it('refuses a session, a follow-up, a launch and a credential for an overlapping project, and still stops', async () => {
    const { container, stateRoot } = makeStateRoot();
    const handle = await started(stateRoot);
    // The editor announces the folder that holds the state root.
    await connectEditor(handle, stateRoot, container);
    const headers = {
      [AUTHORIZATION_HEADER]: formatBearer(editorToken(stateRoot)),
      'content-type': 'application/json',
    };
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${handle.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const sessionRefusal = { code: 'FS_UNSAFE_PATH', message: STATE_HOME_OVERLAP_MESSAGE };
    // Every refusal also names the correlation ref its log record carries —
    // the same value the `x-debuggen-ref` header announces — so the body is
    // the refusal plus exactly that ref and nothing else.
    const refusalOf = async (response: Response): Promise<unknown> => {
      const ref = response.headers.get('x-debuggen-ref');
      expect(ref).toEqual(expect.stringMatching(/\S/));
      const body: unknown = await response.json();
      expect(body).toMatchObject({ ref });
      return body;
    };

    const created = await post('/sessions', {
      projectRoot: container,
      question: 'Why is it slow?',
    });
    expect(created.status).toBe(400);
    expect(await refusalOf(created)).toEqual({
      ...sessionRefusal,
      ref: created.headers.get('x-debuggen-ref'),
    });

    const stored = await storeSessionOf(handle, container);
    const asked = await post(`/sessions/${stored.id}/question`, {
      question: 'And the second render?',
    });
    expect(asked.status).toBe(400);
    expect(await refusalOf(asked)).toEqual({
      ...sessionRefusal,
      ref: asked.headers.get('x-debuggen-ref'),
    });

    for (const path of ['/dev-server/launch', '/dev-server/credential']) {
      const refused = await post(path, { projectRoot: container });
      expect(refused.status).toBe(400);
      expect(await refusalOf(refused)).toEqual({
        code: 'FS_UNSAFE_PATH',
        message: `${STATE_HOME_OVERLAP_MESSAGE} ${STATE_HOME_OVERLAP_HINT}`,
        ref: refused.headers.get('x-debuggen-ref'),
      });
    }

    const stopped = await post('/dev-server/stop', { projectRoot: container });
    expect(stopped.status).toBe(200);
  });
});

/** A three-line source file whose one function returns `expression`. */
function totalReturning(expression: string): string {
  return `export function total(): number {\n  return ${expression};\n}\n`;
}

/**
 * Journals and applies, for `sessionId`, a patch of `file` from
 * `totalReturning(fromExpression)` to `totalReturning(toExpression)`, the way an
 * install does: the pre-patch bytes in the session's backup store, an `applied`
 * record carrying both hashes and the exact unified diff, then the new bytes.
 */
async function layerPatchOf(
  handle: ServiceHandle,
  stateRoot: string,
  target: { readonly sessionId: string; readonly projectRoot: string; readonly file: string },
  fromExpression: string,
  toExpression: string,
): Promise<ModificationRecord> {
  const fromBytes = totalReturning(fromExpression);
  const toBytes = totalReturning(toExpression);
  const originalHash = sha256Hex(fromBytes);
  const backups = createBackupStore({ debuggenHome: stateRoot, sessionId: target.sessionId });
  unwrap(await backups.put(originalHash, Buffer.from(fromBytes, 'utf8')));
  const record = unwrap(
    createModificationRecord({
      sessionId: target.sessionId,
      planVersion: 1,
      file: target.file,
      originalHash,
      backupPath: unwrap(backups.locate(originalHash)),
      instrumentedHash: sha256Hex(toBytes),
      diff: [
        `--- a/${target.file}`,
        `+++ b/${target.file}`,
        '@@ -1,3 +1,3 @@',
        ' export function total(): number {',
        `-  return ${fromExpression};`,
        `+  return ${toExpression};`,
        ' }',
        '',
      ].join('\n'),
      status: 'applied',
    }),
  );
  unwrap(await createModificationsRepo({ store: handle.store }).append(record));
  writeFileSync(join(target.projectRoot, target.file), toBytes);
  return record;
}

describe('ServiceHandle.close — a graceful stop ends the live sessions (AAP 0.5.1)', () => {
  it('unwinds two sessions’ patches of one file last-applied first, even when the lower one was updated last', async () => {
    const { container, stateRoot } = makeStateRoot();
    const projectRoot = join(container, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    const file = 'src/checkout.ts';
    const originalBytes = totalReturning('1');
    writeFileSync(join(projectRoot, file), originalBytes);
    const handle = await started(stateRoot);
    const editor = await connectEditor(handle, stateRoot, projectRoot);

    // `upper` is created first, `lower` second, so the session index — most
    // recently updated first — lists `lower` first. But `lower` patched the
    // file first and `upper` patched `lower`'s bytes: `upper` must be undone first.
    const create = async (): Promise<SessionRecord> =>
      unwrap(
        await handle.manager.create({
          projectRoot,
          question: 'Why is it slow?',
          devServerUrl: 'http://127.0.0.1:3000',
        }),
      );
    const upper = await create();
    const lower = await create();
    const lowerRecord = await layerPatchOf(
      handle,
      stateRoot,
      { sessionId: lower.id, projectRoot, file },
      '1',
      '(globalThis as never, 1)',
    );
    const upperRecord = await layerPatchOf(
      handle,
      stateRoot,
      { sessionId: upper.id, projectRoot, file },
      '(globalThis as never, 1)',
      '(globalThis as never, (globalThis as never, 1))',
    );

    await handle.close();

    // The original is back, with no conflict from the ordering itself.
    expect(readFileSync(join(projectRoot, file), 'utf8')).toBe(originalBytes);
    expect(await editor.closed).toBe(WS_CLOSE_GOING_AWAY);
    const reports = editor.frames.filter((frame) => frame.type === 'cleanup.completed');
    expect(reports.map((frame) => frame.payload)).toStrictEqual([
      { sessionId: upper.id, status: 'clean', conflicts: [] },
      { sessionId: lower.id, status: 'clean', conflicts: [] },
    ]);

    const second = await started(stateRoot);
    expect(second.startup.reconciliation.restored).toBe(0);
    expect(second.startup.reconciliation.conflicts).toBe(0);
    const journal = createModificationsRepo({ store: second.store });
    for (const [session, record] of [
      [upper, upperRecord],
      [lower, lowerRecord],
    ] as const) {
      const stored = unwrap(second.manager.get(session.id));
      expect(stored?.status).toBe('ended');
      expect(stored?.cleanup.status).toBe('clean');
      expect(unwrap(await journal.get(record.id))?.status).toBe('reverted');
    }
  });

  it('restores the patched file, disarms the preload and tells the editor before the sockets close', async () => {
    const { container, stateRoot } = makeStateRoot();
    const projectRoot = join(container, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const log = capturingDestination();
    const handle = unwrap(
      await start(stateRoot, {
        overrides: { logLevel: 'debug' },
        loggerOptions: { destination: log },
      }),
    );

    const editor = await connectEditor(handle, stateRoot, projectRoot);
    const agentSocket = await connect(handle);
    const agentFrames = framesOf(agentSocket);
    const agentClosed = closeCodeOf(agentSocket);
    const agentToken = unwrap(handle.auth.issueServerAgentCredential({ projectRoot })).token;
    helloAsServerAgent(agentSocket, agentToken, projectRoot);
    const agentRegistered = await eventually(() =>
      Promise.resolve(
        log.records.some(
          (line) => line.includes('Client connected') && line.includes('"role":"server-agent"'),
        ),
      ),
    );
    expect(agentRegistered).toBe(true);
    const patched = await instrumentFileOf(handle, stateRoot, projectRoot);

    await handle.close();

    // The developer's file is back, byte for byte, before the process is gone.
    expect(readFileSync(join(projectRoot, patched.file), 'utf8')).toBe(patched.originalBytes);

    // The editor heard the one cleanup report before its socket was closed as going away.
    expect(await editor.closed).toBe(WS_CLOSE_GOING_AWAY);
    const reports = editor.frames.filter((frame) => frame.type === 'cleanup.completed');
    expect(reports.map((frame) => frame.payload)).toStrictEqual([
      { sessionId: patched.session.id, status: 'clean', conflicts: [] },
    ]);

    // The preload was sent its capture-less configuration — every signal off — first.
    expect(await agentClosed).toBe(WS_CLOSE_GOING_AWAY);
    const configs = agentFrames.filter((frame) => frame.type === 'server-agent.config');
    expect(configs.length).toBeGreaterThanOrEqual(1);
    const disarm = configs.at(-1)?.payload as { captureId?: unknown; signals?: unknown };
    expect(disarm.captureId).toBeUndefined();
    expect(disarm.signals).toMatchObject({
      http: false,
      routeHandlers: false,
      fetch: false,
      prisma: false,
      pg: false,
      functions: [],
    });

    // The next start has nothing left to restore: the stop did it.
    const second = await started(stateRoot);
    expect(second.startup.reconciliation.restored).toBe(0);
    expect(second.startup.reconciliation.conflicts).toBe(0);
    const stored = unwrap(second.manager.get(patched.session.id));
    expect(stored?.status).toBe('ended');
    expect(stored?.cleanup.status).toBe('clean');
    const journaled = unwrap(
      await createModificationsRepo({ store: second.store }).get(patched.record.id),
    );
    expect(journaled?.status).toBe('reverted');
  });

  it('leaves a file the developer edited untouched, keeps its original and reports the conflict', async () => {
    const { container, stateRoot } = makeStateRoot();
    const projectRoot = join(container, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const log = capturingDestination();
    const handle = unwrap(
      await start(stateRoot, {
        overrides: { logLevel: 'info' },
        loggerOptions: { destination: log },
      }),
    );
    const editor = await connectEditor(handle, stateRoot, projectRoot);
    const patched = await instrumentFileOf(handle, stateRoot, projectRoot);
    const editedBytes = `${patched.instrumentedBytes}// the developer kept working\n`;
    writeFileSync(join(projectRoot, patched.file), editedBytes);

    await handle.close();

    expect(readFileSync(join(projectRoot, patched.file), 'utf8')).toBe(editedBytes);
    expect(readFileSync(patched.record.backupPath, 'utf8')).toBe(patched.originalBytes);
    await editor.closed;
    const report = editor.frames.find((frame) => frame.type === 'cleanup.completed')?.payload as {
      status?: unknown;
      conflicts?: readonly { file?: unknown; recordId?: unknown }[];
    };
    expect(report.status).toBe('conflict');
    expect(report.conflicts?.map((conflict) => [conflict.recordId, conflict.file])).toStrictEqual([
      [patched.record.id, patched.file],
    ]);
    expect(log.records.join('')).toContain(
      'files edited while instrumented were not overwritten; their originals are kept in the backup directory',
    );

    const second = await started(stateRoot);
    const stored = unwrap(second.manager.get(patched.session.id));
    expect(stored?.status).toBe('ended');
    expect(stored?.cleanup.status).toBe('conflict');
    const journaled = unwrap(
      await createModificationsRepo({ store: second.store }).get(patched.record.id),
    );
    expect(journaled?.status).toBe('conflict');
    expect(readFileSync(join(projectRoot, patched.file), 'utf8')).toBe(editedBytes);
  });

  it('leaves a session that holds no instrumentation open, so it can continue after the restart', async () => {
    const { container, stateRoot } = makeStateRoot();
    const handle = await started(stateRoot);
    const session = unwrap(
      await handle.manager.create({
        projectRoot: join(container, 'project'),
        question: 'Why is it slow?',
        devServerUrl: 'http://127.0.0.1:3000',
      }),
    );

    await handle.close();

    const second = await started(stateRoot);
    const stored = unwrap(second.manager.get(session.id));
    expect(stored?.status).toBe('created');
    expect(stored?.cleanup.status).toBe('pending');
  });
});

describe('startService — one server, two protocols', () => {
  it('answers the unauthenticated health route with exactly the protocol health body', async () => {
    const { stateRoot } = makeStateRoot();
    const handle = await started(stateRoot);

    const response = await fetch(`${handle.url}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/u);
    // No CORS header is ever set, so a web page cannot read a response (AAP 0.5.6).
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const body: unknown = await response.json();
    expect(healthResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toStrictEqual({
      version: manifestVersion(),
      protocolVersion: PROTOCOL_VERSION,
      pairingAvailable: false,
    });

    const read = await new HttpClient({ baseUrl: handle.url }).health();
    expect(isOk(read) ? read.value : read.error.message).toStrictEqual(body);
  });

  it('refuses web origins on every route and admits the two extension origins', async () => {
    const { stateRoot } = makeStateRoot();
    const handle = await started(stateRoot);

    for (const origin of ['http://evil.example', 'https://evil.example', 'null']) {
      const refused = await fetch(`${handle.url}/health`, { headers: { Origin: origin } });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'FORBIDDEN_ORIGIN' });
    }
    for (const origin of [
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      'vscode-webview://x',
    ]) {
      const allowed = await fetch(`${handle.url}/health`, { headers: { Origin: origin } });
      expect(allowed.status).toBe(200);
    }
  });

  it('requires the editor credential on session routes', async () => {
    const { stateRoot } = makeStateRoot();
    const handle = await started(stateRoot);

    const anonymous = await fetch(`${handle.url}/sessions`);
    expect(anonymous.status).toBe(401);

    const authorized = await fetch(`${handle.url}/sessions`, {
      headers: { [AUTHORIZATION_HEADER]: formatBearer(editorToken(stateRoot)) },
    });
    expect(authorized.status).toBe(200);
  });

  it('reports pairing available while an authenticated editor is connected over WebSocket', async () => {
    const { container, stateRoot } = makeStateRoot();
    const handle = await started(stateRoot);
    expect(handle.wsPath).toBe(WS_PATH);

    const socket = await connect(handle);
    helloAsEditor(socket, editorToken(stateRoot), join(container, 'workspace'));
    const available = await eventually(async () => {
      const body = await health(handle.url);
      return (body as { pairingAvailable?: unknown }).pairingAvailable === true;
    });
    expect(available).toBe(true);

    socket.close();
    const released = await eventually(async () => {
      const body = await health(handle.url);
      return (body as { pairingAvailable?: unknown }).pairingAvailable === false;
    });
    expect(released).toBe(true);
  });

  it('closes a WebSocket that presents no valid credential with the unauthorized code', async () => {
    const { container, stateRoot } = makeStateRoot();
    const handle = await started(stateRoot);

    const socket = await connect(handle);
    const closed = closeCodeOf(socket);
    helloAsEditor(socket, 'not-a-credential-of-this-service-at-all-000', container);
    expect(await closed).toBe(4401);
  });

  it('binds an ephemeral port and hands every subsystem the bound one', async () => {
    const { stateRoot } = makeStateRoot();
    const handle = await started(stateRoot);

    expect(handle.port).toBeGreaterThan(0);
    expect(handle.config.port).toBe(handle.port);
    expect(handle.url).toBe(`http://${handle.host}:${handle.port}`);
  });

  it('closes once however often close() is called, closing sockets with the going-away code', async () => {
    const { container, stateRoot } = makeStateRoot();
    const handle = await started(stateRoot);
    const socket = await connect(handle);
    helloAsEditor(socket, editorToken(stateRoot), join(container, 'workspace'));
    await eventually(async () => {
      const body = await health(handle.url);
      return (body as { pairingAvailable?: unknown }).pairingAvailable === true;
    });
    const closed = closeCodeOf(socket);

    await Promise.all([handle.close(), handle.close()]);
    await handle.close();

    expect(await closed).toBe(WS_CLOSE_GOING_AWAY);
    await expect(fetch(`${handle.url}/health`)).rejects.toThrow();
    const databasePath = join(stateRoot, SESSIONS_DATABASE_FILE_NAME);
    expect(lstatSync(databasePath).isFile()).toBe(true);
    expect(() => lstatSync(`${databasePath}-wal`)).toThrow();
  });
});

/** One raw TCP connection to the service, and what it received until it closed. */
interface RawConnection {
  readonly socket: Socket;
  /** Everything received so far, as Latin-1 text (an HTTP response head is ASCII). */
  received(): string;
  /** Resolves, once the connection has closed, with its lifetime in milliseconds. */
  readonly closed: Promise<number>;
}

/** Raw connections the running test opened; destroyed after it. */
const rawConnections: Socket[] = [];

/**
 * Opens a raw TCP connection to the service and resolves once it is
 * established, so a test can send an incomplete or malformed request — or
 * nothing at all.
 */
function rawConnection(handle: Pick<ServiceHandle, 'host' | 'port'>): Promise<RawConnection> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: handle.host, port: handle.port });
    rawConnections.push(socket);
    const chunks: Buffer[] = [];
    let openedAt = performance.now();
    const closed = new Promise<number>((resolveClosed) => {
      socket.once('close', () => {
        resolveClosed(performance.now() - openedAt);
      });
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.once('connect', () => {
      openedAt = performance.now();
      // A reset by the server is an outcome here, observed through `closed`.
      socket.off('error', reject);
      socket.on('error', () => undefined);
      resolve({ socket, received: () => Buffer.concat(chunks).toString('latin1'), closed });
    });
    socket.once('error', reject);
  });
}

/**
 * Asserts that `head` is exactly one raw refusal of the server's
 * `clientError` answer: `status` with no body, not cached, not sniffed, not
 * frameable (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`), inert
 * as a document (CSP `default-src 'none'`), and the connection closed. The
 * lines are literals, so the raw head is held to the same values the
 * application's replies are.
 */
function expectRawRefusal(head: string, status: string): void {
  expect(head.startsWith(`HTTP/1.1 ${status}\r\n`)).toBe(true);
  expect(head.endsWith('\r\n\r\n')).toBe(true);
  const fields = head.slice(0, -4).split('\r\n').slice(1);
  expect(fields.sort()).toEqual([
    'Cache-Control: no-store',
    'Connection: close',
    'Content-Length: 0',
    "Content-Security-Policy: default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options: nosniff',
    'X-Frame-Options: DENY',
  ]);
}

describe('startService — the HTTP server bounds every connection (CWE-400)', () => {
  afterEach(() => {
    for (const socket of rawConnections.splice(0)) {
      socket.destroy();
    }
  });

  /** Short limits a suite can observe; the check interval keeps the close prompt. */
  const SHORT_LIMITS = {
    headersTimeoutMs: 400,
    requestTimeoutMs: 800,
    connectionsCheckingIntervalMs: 50,
  } as const;

  /** How far past a deadline a close may come on a loaded host, in milliseconds. */
  const DEADLINE_SLACK_MS = 1_500;

  /** Starts the service with `httpLimits`, failing the test when it does not start. */
  async function startedWith(
    stateRoot: string,
    extra: Omit<StartServiceOptions, 'env'>,
  ): Promise<ServiceHandle> {
    const result = await start(stateRoot, extra);
    if (isErr(result)) {
      expect.unreachable(`startService failed: ${result.error.code}: ${result.error.message}`);
    }
    return result.value;
  }

  it('keeps the request deadline above the header deadline plus the body guard, and the cap above the WebSocket surface', () => {
    expect(Object.isFrozen(HTTP_SERVER_LIMITS)).toBe(true);
    expect(HTTP_SERVER_LIMITS.headersTimeoutMs).toBeLessThanOrEqual(10_000);
    // A trickling body meets `./server/http.ts`'s own `408` before the server's.
    expect(HTTP_SERVER_LIMITS.requestTimeoutMs).toBeGreaterThan(
      HTTP_SERVER_LIMITS.headersTimeoutMs + DEFAULT_REQUEST_BODY_TIMEOUT_MS,
    );
    expect(HTTP_SERVER_LIMITS.connectionsCheckingIntervalMs).toBeLessThanOrEqual(
      HTTP_SERVER_LIMITS.headersTimeoutMs / 10,
    );
    expect(HTTP_SERVER_LIMITS.keepAliveTimeoutMs).toBeGreaterThan(0);
    // Every registered WebSocket client, as many again awaiting `client.hello`,
    // and HTTP connections beyond both.
    expect(HTTP_SERVER_LIMITS.maxConnections).toBeGreaterThanOrEqual(2 * DEFAULT_MAX_CLIENTS + 512);
    expect(DROPPED_CONNECTIONS_REPORT_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('listens with the documented limits in force, as read back from the server', async () => {
    const { stateRoot } = makeStateRoot();
    const destination = capturingDestination();
    await startedWith(stateRoot, {
      overrides: { logLevel: 'info' },
      loggerOptions: { destination },
    });

    const record = parsedRecords(destination.records).find(
      (entry) => entry['msg'] === 'the HTTP server enforces its connection limits',
    );
    expect(record).toMatchObject({ ...HTTP_SERVER_LIMITS });
  });

  it('closes a connection that stalls in its header block, or sends nothing, at the header deadline', async () => {
    const { stateRoot } = makeStateRoot();
    const handle = await startedWith(stateRoot, { httpLimits: SHORT_LIMITS });
    const stalled = await rawConnection(handle);
    stalled.socket.write('GET /sessions HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    const silent = await rawConnection(handle);

    // While both hold their connections, an authenticated request is answered.
    const authorized = await fetch(`${handle.url}/sessions`, {
      headers: { [AUTHORIZATION_HEADER]: formatBearer(editorToken(stateRoot)) },
    });
    expect(authorized.status).toBe(200);

    for (const connection of [stalled, silent]) {
      const lifetime = await connection.closed;
      expect(lifetime).toBeGreaterThanOrEqual(SHORT_LIMITS.headersTimeoutMs * 0.75);
      expect(lifetime).toBeLessThan(
        SHORT_LIMITS.headersTimeoutMs +
          SHORT_LIMITS.connectionsCheckingIntervalMs +
          DEADLINE_SLACK_MS,
      );
      expectRawRefusal(connection.received(), '408 Request Timeout');
    }
  });

  it('answers a malformed request 400 and an oversized header block 431, then closes them', async () => {
    const { stateRoot } = makeStateRoot();
    const handle = await startedWith(stateRoot, { httpLimits: SHORT_LIMITS });

    const malformed = await rawConnection(handle);
    malformed.socket.write('NOT A REQUEST\r\n\r\n');
    const oversized = await rawConnection(handle);
    oversized.socket.write(
      `GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Padding: ${'a'.repeat(32 * 1024)}\r\n\r\n`,
    );

    await Promise.all([malformed.closed, oversized.closed]);
    expectRawRefusal(malformed.received(), '400 Bad Request');
    expectRawRefusal(oversized.received(), '431 Request Header Fields Too Large');
    expect((await fetch(`${handle.url}/health`)).status).toBe(200);
  });

  it("answers the replies Node writes itself — an unmet Expect's 417, a Host-less request's 400 — with the response-header policy", async () => {
    const { stateRoot } = makeStateRoot();
    const handle = await startedWith(stateRoot, { httpLimits: SHORT_LIMITS });

    // Neither request reaches the application: Node answers both before any
    // `request` listener runs.
    const unmet = await rawConnection(handle);
    unmet.socket.write(
      'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: unmet-expectation\r\nConnection: close\r\n\r\n',
    );
    const hostless = await rawConnection(handle);
    hostless.socket.write('GET /health HTTP/1.1\r\nConnection: close\r\n\r\n');

    await Promise.all([unmet.closed, hostless.closed]);
    for (const [connection, status] of [
      [unmet, '417 Expectation Failed'],
      [hostless, '400 Bad Request'],
    ] as const) {
      const [head = ''] = connection.received().split('\r\n\r\n');
      expect(head.startsWith(`HTTP/1.1 ${status}\r\n`), head).toBe(true);
      const fields = head
        .split('\r\n')
        .slice(1)
        .map((field) => {
          const colon = field.indexOf(':');
          return `${field.slice(0, colon).toLowerCase()}:${field.slice(colon + 1)}`;
        });
      expect(fields, head).toEqual(
        expect.arrayContaining([
          'cache-control: no-store',
          'x-content-type-options: nosniff',
          'x-frame-options: DENY',
          "content-security-policy: default-src 'none'; frame-ancestors 'none'",
        ]),
      );
      expect(head.toLowerCase()).not.toContain('access-control-allow-origin');
    }
    expect((await fetch(`${handle.url}/health`)).status).toBe(200);
  });

  it('keeps an upgraded WebSocket open well past the request deadline', async () => {
    const { container, stateRoot } = makeStateRoot();
    const handle = await startedWith(stateRoot, { httpLimits: SHORT_LIMITS });
    const { closed } = await connectEditor(handle, stateRoot, join(container, 'workspace'));
    let closedEarly = false;
    void closed.then(() => {
      closedEarly = true;
    });

    // Three request deadlines and many deadline checks.
    await sleep(SHORT_LIMITS.requestTimeoutMs * 3);

    expect(closedEarly).toBe(false);
    expect(sockets.at(-1)?.readyState).toBe(WebSocket.OPEN);
    expect(await health(handle.url)).toMatchObject({ pairingAvailable: true });
  });

  it('refuses a connection past maxConnections, reports it, and serves again once one closes', async () => {
    const { stateRoot } = makeStateRoot();
    const destination = capturingDestination();
    const handle = await startedWith(stateRoot, {
      httpLimits: { maxConnections: 2 },
      overrides: { logLevel: 'info' },
      loggerOptions: { destination },
    });
    // Two keep-alive connections, each proven accepted by its answer.
    const held: RawConnection[] = [];
    for (let index = 0; index < 2; index += 1) {
      const connection = await rawConnection(handle);
      connection.socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      expect(
        await eventually(() => Promise.resolve(connection.received().includes('\r\n\r\n'))),
      ).toBe(true);
      held.push(connection);
    }

    const refused = await rawConnection(handle);
    await refused.closed;
    expect(refused.received()).toBe('');
    const reported = await eventually(() =>
      Promise.resolve(
        parsedRecords(destination.records).some(
          (entry) =>
            entry['msg'] ===
              'refused connections: the HTTP server holds its maximum number of connections' &&
            entry['maxConnections'] === 2 &&
            entry['droppedConnections'] === 1,
        ),
      ),
    );
    expect(reported).toBe(true);

    held[0]?.socket.destroy();
    const served = await eventually(async () => {
      try {
        return (await fetch(`${handle.url}/health`)).status === 200;
      } catch {
        return false;
      }
    });
    expect(served).toBe(true);
  });

  it('refuses limits that are not positive whole numbers, or a header deadline above the request deadline, before touching the filesystem', async () => {
    const { stateRoot } = makeStateRoot();

    for (const httpLimits of [
      { headersTimeoutMs: 0 },
      { maxConnections: 1.5 },
      { keepAliveTimeoutMs: Number.POSITIVE_INFINITY },
      { headersTimeoutMs: 2_000, requestTimeoutMs: 1_000 },
    ]) {
      const refused = await start(stateRoot, { httpLimits });
      expect(isErr(refused)).toBe(true);
      if (isErr(refused)) {
        expect(refused.error.code).toBe('CONFIG_INVALID');
      }
    }
    expect(() => lstatSync(stateRoot)).toThrow();
  });
});

describe('startService — the HTTP server budgets pre-auth connections (CWE-400)', () => {
  /** Servers `createLimitedServer` built for the running test; closed after it. */
  const limitedServers: Server[] = [];

  afterEach(async () => {
    for (const socket of rawConnections.splice(0)) {
      socket.destroy();
    }
    for (const server of limitedServers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  /** The request line and host of a request whose header block never ends. */
  const PARTIAL_HEAD = 'GET /sessions HTTP/1.1\r\nHost: 127.0.0.1\r\n';

  /** Starts the service with `extra`, failing the test when it does not start. */
  async function startedWith(
    stateRoot: string,
    extra: Omit<StartServiceOptions, 'env'>,
  ): Promise<ServiceHandle> {
    const result = await start(stateRoot, extra);
    if (isErr(result)) {
      expect.unreachable(`startService failed: ${result.error.code}: ${result.error.message}`);
    }
    return result.value;
  }

  /** Opens `count` connections that each send a header block they never finish, in order. */
  async function stalledFlood(
    target: Pick<ServiceHandle, 'host' | 'port'>,
    count: number,
  ): Promise<RawConnection[]> {
    const flood: RawConnection[] = [];
    for (let index = 0; index < count; index += 1) {
      const connection = await rawConnection(target);
      connection.socket.write(PARTIAL_HEAD);
      flood.push(connection);
    }
    return flood;
  }

  /** Whether each connection has closed, read without waiting. */
  function closedFlags(connections: readonly RawConnection[]): { closed: boolean }[] {
    return connections.map((connection) => {
      const flag = { closed: false };
      void connection.closed.then(() => {
        flag.closed = true;
      });
      return flag;
    });
  }

  /** A logger that keeps every JSON record, and those records. */
  function capturingLogger(): { readonly logger: Logger; readonly records: string[] } {
    const destination = capturingDestination();
    const logger = createServiceLogger(
      unwrap(loadServiceConfig({}, { debuggenHome: makeStateRoot().stateRoot, logLevel: 'info' })),
      { destination },
    );
    return { logger, records: destination.records };
  }

  /**
   * A server built by `createLimitedServer` whose handler holds every
   * `/slow` request until `release()` is called and answers anything else at
   * once, listening on an ephemeral loopback port.
   */
  async function slowServer(
    limits: HttpServerLimits,
    logger: Logger,
  ): Promise<{
    readonly target: Pick<ServiceHandle, 'host' | 'port'>;
    readonly entered: () => number;
    release(): void;
  }> {
    let entered = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = createLimitedServer(
      (request, response) => {
        const answer = (): void => {
          response.writeHead(200, { 'content-length': '0' });
          response.end();
        };
        if (request.url === '/slow') {
          entered += 1;
          void released.then(answer);
          return;
        }
        answer();
      },
      limits,
      logger,
    );
    limitedServers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return { target: { host: '127.0.0.1', port }, entered: () => entered, release };
  }

  /** The fields of `record` beside the logger's own. */
  function ownFields(record: Record<string, unknown> | undefined): string[] {
    return Object.keys(record ?? {})
      .filter((key) => !['level', 'time', 'subsystem', 'msg'].includes(key))
      .sort();
  }

  it('admits a reconnect storm of a full registry at once and keeps the unengaged share below the soft cap', () => {
    expect(HTTP_SERVER_LIMITS.connectionBurst).toBeGreaterThanOrEqual(2 * DEFAULT_MAX_CLIENTS);
    expect(HTTP_SERVER_LIMITS.connectionsPerSecond).toBeGreaterThan(0);
    expect(HTTP_SERVER_LIMITS.reservedConnections).toBeLessThan(HTTP_SERVER_LIMITS.maxConnections);
    expect(HTTP_SERVER_LIMITS.maxUnengagedConnections).toBeLessThan(
      HTTP_SERVER_LIMITS.maxConnections - HTTP_SERVER_LIMITS.reservedConnections,
    );
  });

  it('evicts the oldest stalled connection, so an authenticated request is served through a flood of partial headers', async () => {
    const { stateRoot } = makeStateRoot();
    const destination = capturingDestination();
    const handle = await startedWith(stateRoot, {
      httpLimits: { maxUnengagedConnections: 4 },
      overrides: { logLevel: 'info' },
      loggerOptions: { destination },
    });
    const flood = await stalledFlood(handle, 4);
    const closed = closedFlags(flood);

    const authorized = await fetch(`${handle.url}/sessions`, {
      headers: { [AUTHORIZATION_HEADER]: formatBearer(editorToken(stateRoot)) },
    });

    expect(authorized.status).toBe(200);
    await flood[0]?.closed;
    // Evicted without an answer: nothing of it was ever parsed as a request.
    expect(flood[0]?.received()).toBe('');
    expect(closed.slice(1).map((flag) => flag.closed)).toEqual([false, false, false]);
    const evicted = await eventually(() =>
      Promise.resolve(
        parsedRecords(destination.records).some(
          (entry) =>
            entry['msg'] === 'closed stalled or idle connections to admit new ones' &&
            entry['evictedConnections'] === 1 &&
            entry['maxUnengagedConnections'] === 4,
        ),
      ),
    );
    expect(evicted).toBe(true);
    const record = parsedRecords(destination.records).find(
      (entry) => entry['msg'] === 'closed stalled or idle connections to admit new ones',
    );
    // Counts and limits only: never an address or a port.
    expect(ownFields(record)).toEqual(
      [
        'evictedConnections',
        'maxConnections',
        'maxUnengagedConnections',
        'openConnections',
        'reservedConnections',
        'unengagedConnections',
      ].sort(),
    );
  });

  it('closes connections past the admission rate before answering a byte, and admits again once the bucket refills', async () => {
    const { stateRoot } = makeStateRoot();
    const destination = capturingDestination();
    const handle = await startedWith(stateRoot, {
      httpLimits: { connectionBurst: 2, connectionsPerSecond: 2 },
      overrides: { logLevel: 'info' },
      loggerOptions: { destination },
    });
    const admitted = [await rawConnection(handle), await rawConnection(handle)];

    const refused = await rawConnection(handle);
    await refused.closed;

    expect(refused.received()).toBe('');
    for (const connection of admitted) {
      connection.socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    }
    expect(
      await eventually(() =>
        Promise.resolve(
          admitted.every((connection) => connection.received().startsWith('HTTP/1.1 200')),
        ),
      ),
    ).toBe(true);
    const record = parsedRecords(destination.records).find(
      (entry) =>
        entry['msg'] ===
        'refused connections: new connections arrived faster than the HTTP server admits them',
    );
    expect(record).toMatchObject({
      level: 40,
      connectionBurst: 2,
      connectionsPerSecond: 2,
      refusedConnections: 1,
    });
    expect(ownFields(record)).toEqual(
      ['connectionBurst', 'connectionsPerSecond', 'refusedConnections'].sort(),
    );

    // Half a second regains one admission; until then every attempt is refused.
    const served = await eventually(async () => {
      try {
        return (await fetch(`${handle.url}/health`)).status === 200;
      } catch {
        return false;
      }
    });
    expect(served).toBe(true);
  });

  it('never evicts a connection whose handler is still answering, however many stalled connections follow it', async () => {
    const { logger } = capturingLogger();
    const server = await slowServer({ ...HTTP_SERVER_LIMITS, maxUnengagedConnections: 2 }, logger);
    const slow = await rawConnection(server.target);
    slow.socket.write('GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    expect(await eventually(() => Promise.resolve(server.entered() === 1))).toBe(true);
    const [slowClosed] = closedFlags([slow]);

    const flood = await stalledFlood(server.target, 6);

    // Each newcomer past the budget of two displaced the oldest stalled one.
    await Promise.all(flood.slice(0, 4).map((connection) => connection.closed));
    const survivors = closedFlags(flood.slice(4));
    server.release();
    expect(
      await eventually(() => Promise.resolve(slow.received().startsWith('HTTP/1.1 200'))),
    ).toBe(true);
    expect(slowClosed?.closed).toBe(false);
    expect(survivors.map((flag) => flag.closed)).toEqual([false, false]);
  });

  it('evicts at the soft cap, and refuses a newcomer only when every connection held is serving a request', async () => {
    const { logger, records } = capturingLogger();
    // A soft cap of three connections of any kind.
    const server = await slowServer(
      { ...HTTP_SERVER_LIMITS, maxConnections: 8, reservedConnections: 5 },
      logger,
    );
    const engaged: RawConnection[] = [];
    for (let index = 0; index < 2; index += 1) {
      const connection = await rawConnection(server.target);
      connection.socket.write('GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      engaged.push(connection);
    }
    expect(await eventually(() => Promise.resolve(server.entered() === 2))).toBe(true);
    const [stalled] = await stalledFlood(server.target, 1);

    // The third slot is taken: a newcomer evicts the one unengaged connection.
    const newcomer = await rawConnection(server.target);
    await stalled?.closed;
    expect(stalled?.received()).toBe('');
    newcomer.socket.write('GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    engaged.push(newcomer);
    expect(await eventually(() => Promise.resolve(server.entered() === 3))).toBe(true);

    // Every connection held is serving a request: nothing can be evicted.
    const refused = await rawConnection(server.target);
    await refused.closed;
    expect(refused.received()).toBe('');
    const record = parsedRecords(records).find(
      (entry) =>
        entry['msg'] ===
        'refused connections: every connection the HTTP server holds is serving a request',
    );
    expect(record).toMatchObject({
      level: 40,
      refusedConnections: 1,
      openConnections: 3,
      unengagedConnections: 0,
      maxConnections: 8,
      reservedConnections: 5,
    });

    server.release();
    expect(
      await eventually(() =>
        Promise.resolve(
          engaged.every((connection) => connection.received().startsWith('HTTP/1.1 200')),
        ),
      ),
    ).toBe(true);
  });

  it('keeps an authenticated WebSocket open through a flood of stalled connections', async () => {
    const { container, stateRoot } = makeStateRoot();
    const handle = await startedWith(stateRoot, { httpLimits: { maxUnengagedConnections: 2 } });
    const { closed } = await connectEditor(handle, stateRoot, join(container, 'workspace'));
    let closedEarly = false;
    void closed.then(() => {
      closedEarly = true;
    });

    const flood = await stalledFlood(handle, 6);
    await Promise.all(flood.slice(0, 4).map((connection) => connection.closed));

    expect(closedEarly).toBe(false);
    expect(sockets.at(-1)?.readyState).toBe(WebSocket.OPEN);
    expect(await health(handle.url)).toMatchObject({ pairingAvailable: true });
  });

  it('refuses an admission budget that is not a positive whole number, before touching the filesystem', async () => {
    const { stateRoot } = makeStateRoot();

    for (const [limit, value] of [
      ['connectionBurst', 0],
      ['connectionsPerSecond', 2.5],
      ['maxUnengagedConnections', -1],
      ['reservedConnections', Number.NaN],
      ['connectionBurst', Number.POSITIVE_INFINITY],
    ] as const) {
      const refused = await start(stateRoot, { httpLimits: { [limit]: value } });
      expect(isErr(refused)).toBe(true);
      if (isErr(refused)) {
        expect(refused.error.code).toBe('CONFIG_INVALID');
        expect(refused.error.details).toMatchObject({ invalid: [limit] });
      }
    }
    expect(() => lstatSync(stateRoot)).toThrow();
  });
});

describe('startService — shutdown reports launched dev servers still running', () => {
  /** A dev server the launcher's report says outlived its termination. */
  const SURVIVOR = Object.freeze({
    projectRoot: '/work/atlas-console',
    pid: 424_242,
    signalFailures: 2,
  });

  /**
   * The real launcher, except that `dispose` — after really disposing it —
   * resolves `report`: the shutdown path is exercised without a process that
   * refuses to die.
   */
  function launcherReporting(
    report: DevServerTerminationReport,
  ): NonNullable<StartServiceOptions['createLauncher']> {
    return (deps): DevServerLauncher => {
      const real = createDevServerLauncher(deps);
      return Object.freeze({
        launch: (request) => real.launch(request),
        stop: (input) => real.stop(input),
        issueCredential: (input) => real.issueCredential(input),
        releaseCredential: (input) => real.releaseCredential(input),
        stopForSession: (sessionId) => real.stopForSession(sessionId),
        whenReleased: (sessionId) => real.whenReleased(sessionId),
        acquireForSession: (projectRoot) => real.acquireForSession(projectRoot),
        preloadServesAt: (projectRoot, devServerUrl) =>
          real.preloadServesAt(projectRoot, devServerUrl),
        addressOfCredential: (tokenHash) => real.addressOfCredential(tokenHash),
        stopAll: () => real.stopAll(),
        list: () => real.list(),
        dispose: async () => {
          await real.dispose();
          return report;
        },
      } satisfies DevServerLauncher);
    };
  }

  /** Starts, closes and returns every record the service wrote, parsed. */
  async function recordsOfShutdown(
    createLauncher: NonNullable<StartServiceOptions['createLauncher']>,
  ): Promise<Record<string, unknown>[]> {
    const { stateRoot } = makeStateRoot();
    const lines: string[] = [];
    const destination = {
      write(record: string): void {
        lines.push(record);
      },
    };
    const result = await start(stateRoot, {
      overrides: { logLevel: 'info' },
      loggerOptions: { destination },
      createLauncher,
    });
    const handle = unwrap(result);
    await handle.close();
    return lines
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("names a survivor at error under step 'dev-servers', and does not call the stop clean", async () => {
    const records = await recordsOfShutdown(launcherReporting({ survivors: [SURVIVOR] }));

    const survivors = records.find(
      (record) => record['msg'] === 'launched dev servers are still running after shutdown',
    );
    expect(survivors).toMatchObject({
      // pino's numeric `error` level.
      level: 50,
      step: 'dev-servers',
      survivors: 1,
      pids: [SURVIVOR.pid],
      projectRoots: [SURVIVOR.projectRoot],
    });
    const stopped = records.find(
      (record) => record['msg'] === 'the Debug Generator service has stopped',
    );
    // pino's numeric `warn` level: the final record names what is still running.
    expect(stopped).toMatchObject({
      level: 40,
      devServers: 'running',
      devServerPids: [SURVIVOR.pid],
    });
  });

  it('writes a clean final record when the launcher reports no survivor', async () => {
    const records = await recordsOfShutdown(launcherReporting({ survivors: [] }));

    expect(
      records.find(
        (record) => record['msg'] === 'launched dev servers are still running after shutdown',
      ),
    ).toBeUndefined();
    const stopped = records.find(
      (record) => record['msg'] === 'the Debug Generator service has stopped',
    );
    // pino's numeric `info` level, with no dev-server fields.
    expect(stopped).toMatchObject({ level: 30 });
    expect(stopped).not.toHaveProperty('devServers');
  });
});

describe('SERVICE_VERSION', () => {
  it('is the version apps/local-service/package.json declares', () => {
    expect(SERVICE_VERSION).toBe(manifestVersion());
  });
});

describe('createAgentReadyLedger', () => {
  const connection: WsConnectionFacts = {
    id: 'cli_test',
    kind: 'devtools',
    principal: {
      role: 'devtools',
      tokenHash: 'f'.repeat(64),
      scope: { kind: 'extension', extensionId: 'abcdefghijklmnopabcdefghijklmnop' },
      issuedAt: 0,
    },
  };

  function report(tabId: number, documentId: string): AgentReadyPayload {
    return {
      tabId,
      documentId,
      producerId: `producer-${documentId}`,
      url: 'http://127.0.0.1:3000/',
      installedBeforeReact: true,
      reactDetected: true,
    };
  }

  function silentLedger(now = (): number => 1_000): ReturnType<typeof createAgentReadyLedger> {
    return createAgentReadyLedger({ logger: noopLogger, now });
  }

  it('keeps the newest report per tab and stamps when it arrived', () => {
    let clock = 1_000;
    const ledger = silentLedger(() => clock);
    expect(ledger.latestAgentReady(7)).toBeUndefined();

    expect(isOk(ledger.agentReady(report(7, 'doc-a'), connection))).toBe(true);
    clock = 2_000;
    expect(isOk(ledger.agentReady(report(7, 'doc-b'), connection))).toBe(true);

    expect(ledger.latestAgentReady(7)?.documentId).toBe('doc-b');
    expect(ledger.latestAgentReadyAt(7)).toBe(2_000);
    expect(ledger.latestAgentReady(8)).toBeUndefined();
    ledger.close();
  });

  it('resolves a wait with the next document and ignores a repeat of the known one', async () => {
    const ledger = silentLedger();
    ledger.agentReady(report(3, 'doc-a'), connection);

    const waiting = ledger.waitForAgentReady(3, { timeoutMs: 1_000, afterDocumentId: 'doc-a' });
    ledger.agentReady(report(3, 'doc-a'), connection);
    ledger.agentReady(report(3, 'doc-b'), connection);

    expect((await waiting)?.documentId).toBe('doc-b');
    ledger.close();
  });

  it('answers at once when a different document has already reported', async () => {
    const ledger = silentLedger();
    ledger.agentReady(report(4, 'doc-new'), connection);

    const answered = await ledger.waitForAgentReady(4, {
      timeoutMs: 1_000,
      afterDocumentId: 'doc-old',
    });
    expect(answered?.documentId).toBe('doc-new');
    ledger.close();
  });

  it('resolves undefined on timeout, on abort and on close, and refuses reports after close', async () => {
    const ledger = silentLedger();

    expect(await ledger.waitForAgentReady(5, { timeoutMs: 10 })).toBeUndefined();

    const controller = new AbortController();
    const aborted = ledger.waitForAgentReady(5, { timeoutMs: 1_000, signal: controller.signal });
    controller.abort();
    expect(await aborted).toBeUndefined();

    const pending = ledger.waitForAgentReady(5, { timeoutMs: 1_000 });
    ledger.close();
    expect(await pending).toBeUndefined();

    const refused = ledger.agentReady(report(5, 'doc-late'), connection);
    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.code).toBe('TRANSPORT_DISCONNECTED');
    }
    expect(ledger.latestAgentReady(5)).toBeUndefined();
  });

  it('logs a forged document id only as its fingerprint, and still matches on the raw id', async () => {
    const forged = '/account/PRIVATE-SENTINEL?token=forged';
    const records: LogRecord[] = [];
    const ledger = createAgentReadyLedger({
      logger: createConsoleLogger({
        level: 'trace',
        sink: (record) => {
          records.push(record);
        },
      }),
      now: () => 1_000,
    });

    const waiting = ledger.waitForAgentReady(9, { timeoutMs: 1_000, afterDocumentId: 'doc-old' });
    const recorded = ledger.agentReady(report(9, forged), connection);

    expect(isOk(recorded) ? recorded.value.documentId : undefined).toBe(forged);
    expect((await waiting)?.documentId).toBe(forged);
    expect(ledger.latestAgentReady(9)?.documentId).toBe(forged);

    const noted = records.filter(
      (record) => record.message === 'recorded a page-agent readiness report',
    );
    expect(noted).toHaveLength(1);
    expect(noted[0]?.level).toBe('debug');
    expect(noted[0]?.fields).toMatchObject({
      tabId: 9,
      document: fingerprintDocumentId(forged),
      documentIdCanonical: false,
      clientId: connection.id,
    });
    for (const record of records) {
      expect(Object.keys(record.fields)).not.toContain('documentId');
    }
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('PRIVATE-SENTINEL');
    expect(serialized).not.toContain('token=');
    ledger.close();
  });

  it('knows no navigation until the binding route records one, then stamps it with the clock, per tab', () => {
    let clock = 5_000;
    const ledger = silentLedger(() => clock);
    expect(ledger.latestNavigationAt(7)).toBeUndefined();

    ledger.recordNavigation(7);
    expect(ledger.latestNavigationAt(7)).toBe(5_000);
    expect(ledger.latestNavigationAt(8)).toBeUndefined();

    clock = 6_000;
    ledger.recordNavigation(8);
    clock = 7_000;
    ledger.recordNavigation(7);
    expect(ledger.latestNavigationAt(7)).toBe(7_000);
    expect(ledger.latestNavigationAt(8)).toBe(6_000);
    // A navigation replaces no report: readiness judges the pair.
    expect(ledger.latestAgentReady(7)).toBeUndefined();
    ledger.close();
  });

  it('orders a report and a navigation that share one millisecond: the navigation after the report it follows, the next report no earlier than the navigation', () => {
    const ledger = silentLedger(() => 1_000);

    ledger.agentReady(report(7, 'doc-a'), connection);
    expect(ledger.latestAgentReadyAt(7)).toBe(1_000);

    // A reload in the same tick: stamped strictly after the report it leaves,
    // so readiness's `navigatedAt > observedAt` distrusts doc-a.
    ledger.recordNavigation(7);
    const navigatedAt = ledger.latestNavigationAt(7);
    expect(navigatedAt).toBe(1_001);
    expect(navigatedAt).toBeGreaterThan(1_000);

    // The reloaded document reports in that same tick: never dated before the
    // navigation, so readiness trusts doc-b on sight.
    ledger.agentReady(report(7, 'doc-b'), connection);
    expect(ledger.latestAgentReady(7)?.documentId).toBe('doc-b');
    expect(ledger.latestAgentReadyAt(7)).toBe(1_001);
    expect(ledger.latestNavigationAt(7)).toBe(1_001);

    // A second reload in the tick again lands after the report it leaves.
    ledger.recordNavigation(7);
    expect(ledger.latestNavigationAt(7)).toBe(1_002);
    ledger.close();
  });

  it('stamps both with the clock once it has moved past the other', () => {
    let clock = 1_000;
    const ledger = silentLedger(() => clock);

    ledger.agentReady(report(7, 'doc-a'), connection);
    clock = 1_500;
    ledger.recordNavigation(7);
    expect(ledger.latestNavigationAt(7)).toBe(1_500);
    clock = 1_800;
    ledger.agentReady(report(7, 'doc-b'), connection);
    expect(ledger.latestAgentReadyAt(7)).toBe(1_800);
    ledger.close();
  });

  /**
   * The clocks the replay cases run under: one that never moves, so every
   * write shares a millisecond, and one that moves between writes.
   */
  const REPLAY_CLOCKS = [
    { label: 'a constant clock', step: 0 },
    { label: 'an advancing clock', step: 500 },
  ] as const;

  it.each(REPLAY_CLOCKS)(
    'keeps the pre-navigation receipt of a replay of the stored document, under $label, storing the newest payload',
    async ({ step }) => {
      let clock = 1_000;
      const ledger = silentLedger(() => clock);

      ledger.agentReady(report(7, 'doc-a'), connection);
      clock += step;
      ledger.recordNavigation(7);
      const navigatedAt = ledger.latestNavigationAt(7);
      const waiting = ledger.waitForAgentReady(7, { timeoutMs: 1_000, afterDocumentId: 'doc-a' });

      // The Chrome side re-relays the report it retained for the tab; the
      // reload may already have replaced that document.
      clock += step;
      const replayed: AgentReadyPayload = { ...report(7, 'doc-a'), installedBeforeReact: false };
      expect(isOk(ledger.agentReady(replayed, connection))).toBe(true);

      expect(ledger.latestAgentReady(7)).toEqual(replayed);
      expect(ledger.latestAgentReadyAt(7)).toBe(1_000);
      expect(ledger.latestNavigationAt(7)).toBe(navigatedAt);
      expect(navigatedAt).toBeGreaterThan(1_000);

      // A second replay confirms no more than the first.
      clock += step;
      ledger.agentReady(report(7, 'doc-a'), connection);
      expect(ledger.latestAgentReadyAt(7)).toBe(1_000);

      // Neither answered the wait for a document other than doc-a.
      ledger.agentReady(report(7, 'doc-b'), connection);
      expect((await waiting)?.documentId).toBe('doc-b');
      ledger.close();
    },
  );

  it.each(REPLAY_CLOCKS)(
    'stamps a different document that follows a replay no earlier than the navigation, under $label',
    ({ step }) => {
      let clock = 1_000;
      const ledger = silentLedger(() => clock);

      ledger.agentReady(report(7, 'doc-a'), connection);
      clock += step;
      ledger.recordNavigation(7);
      clock += step;
      ledger.agentReady(report(7, 'doc-a'), connection);
      clock += step;
      ledger.agentReady(report(7, 'doc-b'), connection);

      const navigatedAt = ledger.latestNavigationAt(7);
      const receivedAt = ledger.latestAgentReadyAt(7);
      if (navigatedAt === undefined || receivedAt === undefined) {
        throw new Error('The ledger holds no navigation or no report for tab 7.');
      }
      expect(ledger.latestAgentReady(7)?.documentId).toBe('doc-b');
      expect(receivedAt).toBeGreaterThanOrEqual(navigatedAt);
      expect(receivedAt).toBe(Math.max(clock, navigatedAt));
      ledger.close();
    },
  );

  it('refreshes the receipt of a same-document replay that no navigation preceded', () => {
    let clock = 1_000;
    const ledger = silentLedger(() => clock);

    // A navigation recorded before the stored report is not "in between".
    ledger.recordNavigation(7);
    clock = 1_200;
    ledger.agentReady(report(7, 'doc-a'), connection);
    expect(ledger.latestAgentReadyAt(7)).toBe(1_200);
    clock = 2_000;
    ledger.agentReady(report(7, 'doc-a'), connection);
    expect(ledger.latestAgentReadyAt(7)).toBe(2_000);
    ledger.close();
  });

  it('keeps the navigation’s stamp on the replay of a report that was lent it in the same millisecond', () => {
    const ledger = silentLedger(() => 3_000);

    ledger.agentReady(report(8, 'doc-a'), connection);
    ledger.recordNavigation(8);
    ledger.agentReady(report(8, 'doc-b'), connection);
    expect(ledger.latestAgentReadyAt(8)).toBe(3_001);

    // doc-b arrived after the navigation, so its replay is not left behind by
    // it: the receipt is refreshed, never dated back before the navigation.
    ledger.agentReady(report(8, 'doc-b'), connection);
    expect(ledger.latestAgentReadyAt(8)).toBe(3_001);
    expect(ledger.latestNavigationAt(8)).toBe(3_001);
    ledger.close();
  });

  it('remembers navigations for at most maxTabs tabs, forgetting the least recently navigated first', () => {
    let clock = 1_000;
    const ledger = createAgentReadyLedger({ logger: noopLogger, now: () => clock, maxTabs: 2 });

    ledger.recordNavigation(1);
    clock += 1;
    ledger.recordNavigation(2);
    clock += 1;
    // Refreshing tab 1 makes tab 2 the oldest.
    ledger.recordNavigation(1);
    clock += 1;
    ledger.recordNavigation(3);

    expect(ledger.latestNavigationAt(2)).toBeUndefined();
    expect(ledger.latestNavigationAt(1)).toBe(1_002);
    expect(ledger.latestNavigationAt(3)).toBe(1_003);
    ledger.close();
  });

  it('forgets a report together with its navigation when navigations of other tabs churn the bound', () => {
    let clock = 1_000;
    const ledger = createAgentReadyLedger({ logger: noopLogger, now: () => clock, maxTabs: 2 });

    ledger.agentReady(report(1, 'doc-a'), connection);
    clock += 1;
    ledger.recordNavigation(1);
    clock += 1;
    // Navigations of unrelated (even unbound) tabs: tab 1 is the oldest entry.
    ledger.recordNavigation(2);
    clock += 1;
    ledger.recordNavigation(3);

    // Neither half outlives the other: a surviving report with its
    // navigation forgotten would read as current on sight.
    expect(ledger.latestAgentReady(1)).toBeUndefined();
    expect(ledger.latestAgentReadyAt(1)).toBeUndefined();
    expect(ledger.latestNavigationAt(1)).toBeUndefined();
    expect(ledger.latestNavigationAt(2)).toBe(1_002);
    expect(ledger.latestNavigationAt(3)).toBe(1_003);
    ledger.close();
  });

  it('forgets a navigation together with its report when reports of other tabs churn the bound', () => {
    let clock = 1_000;
    const ledger = createAgentReadyLedger({ logger: noopLogger, now: () => clock, maxTabs: 2 });

    ledger.agentReady(report(1, 'doc-a'), connection);
    clock += 1;
    ledger.recordNavigation(1);
    clock += 1;
    ledger.agentReady(report(2, 'doc-b'), connection);
    clock += 1;
    ledger.agentReady(report(3, 'doc-c'), connection);

    expect(ledger.latestAgentReady(1)).toBeUndefined();
    expect(ledger.latestAgentReadyAt(1)).toBeUndefined();
    expect(ledger.latestNavigationAt(1)).toBeUndefined();
    expect(ledger.latestAgentReady(2)?.documentId).toBe('doc-b');
    expect(ledger.latestAgentReady(3)?.documentId).toBe('doc-c');
    ledger.close();
  });

  it.each([
    {
      label: 'a navigation',
      write: (ledger: ReturnType<typeof createAgentReadyLedger>): void => {
        ledger.recordNavigation(1);
      },
      kept: { documentId: 'doc-a', receivedAt: 1_000, navigatedAt: 1_004 },
    },
    {
      label: 'a report',
      write: (ledger: ReturnType<typeof createAgentReadyLedger>): void => {
        ledger.agentReady(report(1, 'doc-a2'), connection);
      },
      kept: { documentId: 'doc-a2', receivedAt: 1_004, navigatedAt: 1_001 },
    },
  ])(
    'refreshes a tab’s recency on $label, forgetting the oldest other tab whole',
    ({ write, kept }) => {
      let clock = 1_000;
      const ledger = createAgentReadyLedger({ logger: noopLogger, now: () => clock, maxTabs: 2 });

      ledger.agentReady(report(1, 'doc-a'), connection);
      clock += 1;
      ledger.recordNavigation(1);
      clock += 1;
      ledger.agentReady(report(2, 'doc-b'), connection);
      clock += 1;
      ledger.recordNavigation(2);
      clock += 1;
      // Tab 1 is the oldest entry until this write makes it the newest.
      write(ledger);
      clock += 1;
      ledger.recordNavigation(3);

      expect(ledger.latestAgentReady(2)).toBeUndefined();
      expect(ledger.latestAgentReadyAt(2)).toBeUndefined();
      expect(ledger.latestNavigationAt(2)).toBeUndefined();
      expect(ledger.latestAgentReady(1)?.documentId).toBe(kept.documentId);
      expect(ledger.latestAgentReadyAt(1)).toBe(kept.receivedAt);
      expect(ledger.latestNavigationAt(1)).toBe(kept.navigatedAt);
      expect(ledger.latestNavigationAt(3)).toBe(1_005);
      ledger.close();
    },
  );

  it('forgets every navigation on close and ignores one recorded after it', () => {
    const ledger = silentLedger();
    ledger.recordNavigation(7);
    expect(ledger.latestNavigationAt(7)).toBe(1_000);

    ledger.close();
    expect(ledger.latestNavigationAt(7)).toBeUndefined();
    ledger.recordNavigation(7);
    expect(ledger.latestNavigationAt(7)).toBeUndefined();
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
    ['beyond the safe integers', Number.MAX_SAFE_INTEGER + 1],
  ])('ignores a navigation of a tab id that is %s', (_label, tabId) => {
    const records: LogRecord[] = [];
    const ledger = createAgentReadyLedger({
      logger: createConsoleLogger({
        level: 'trace',
        sink: (record) => {
          records.push(record);
        },
      }),
      now: () => 1_000,
    });

    ledger.recordNavigation(tabId);

    expect(ledger.latestNavigationAt(tabId)).toBeUndefined();
    expect(records).toEqual([]);
    ledger.close();
  });

  it('notes a navigation at debug by tab id alone', () => {
    const records: LogRecord[] = [];
    const ledger = createAgentReadyLedger({
      logger: createConsoleLogger({
        level: 'trace',
        sink: (record) => {
          records.push(record);
        },
      }),
      now: () => 1_000,
    });

    ledger.recordNavigation(9);

    const noted = records.filter(
      (record) => record.message === 'recorded a committed navigation of a tab',
    );
    expect(noted).toHaveLength(1);
    expect(noted[0]?.level).toBe('debug');
    // Beside the subsystem binding every ledger record carries, the tab id is
    // the one field: no URL, no document id, no connection.
    const { [LOG_BINDING_KEYS.subsystem]: subsystem, ...fields } = noted[0]?.fields ?? {};
    expect(typeof subsystem).toBe('string');
    expect(fields).toEqual({ tabId: 9 });
    ledger.close();
  });
});

describe('regatingReadinessPort', () => {
  const connection: WsConnectionFacts = {
    id: 'cli_test',
    kind: 'devtools',
    principal: {
      role: 'devtools',
      tokenHash: 'f'.repeat(64),
      scope: { kind: 'extension', extensionId: 'abcdefghijklmnopabcdefghijklmnop' },
      issuedAt: 0,
    },
  };
  const report: AgentReadyPayload = {
    tabId: 7,
    documentId: 'doc-1',
    producerId: 'producer-doc-1',
    url: 'http://127.0.0.1:3000/',
    installedBeforeReact: true,
    reactDetected: true,
  };

  function portWith(
    boundSessionId: string | undefined,
    refuse = false,
  ): { port: ReturnType<typeof regatingReadinessPort>; regated: string[]; recorded: number[] } {
    const regated: string[] = [];
    const recorded: number[] = [];
    const ledger = createAgentReadyLedger({ logger: noopLogger, now: () => 1_000 });
    const port = regatingReadinessPort(
      {
        agentReady: (payload, client) => {
          recorded.push(payload.tabId);
          return refuse
            ? {
                ok: false,
                error: new DebuggenError('TRANSPORT_DISCONNECTED', 'The service is closing.'),
              }
            : ledger.agentReady(payload, client);
        },
      },
      {
        bindingForTab: (tabId) =>
          boundSessionId === undefined
            ? undefined
            : {
                tabId,
                sessionId: boundSessionId,
                url: 'http://127.0.0.1:3000/',
                boundBy: 'cli_test',
                boundAt: 1_000,
                online: true,
              },
      },
      {
        regate: (request) => {
          regated.push(request.sessionId);
          return Promise.resolve({
            ok: true,
            value: {
              sessionId: request.sessionId,
              outcome: 'regated',
              status: 'ready',
              ready: true,
            },
          });
        },
      },
      noopLogger,
    );
    return { port, regated, recorded };
  }

  it('records the report, then re-gates the session bound to the reporting tab', async () => {
    const { port, regated, recorded } = portWith('ses_bound');

    const answer = await port.agentReady(report, connection);

    expect(isOk(answer)).toBe(true);
    expect(recorded).toEqual([7]);
    expect(regated).toEqual(['ses_bound']);
  });

  it('re-gates nothing for a tab no session has bound', async () => {
    const { port, regated } = portWith(undefined);

    expect(isOk(await port.agentReady(report, connection))).toBe(true);
    expect(regated).toEqual([]);
  });

  it('returns a refused report unchanged and re-gates nothing', async () => {
    const { port, regated } = portWith('ses_bound', true);

    const answer = await port.agentReady(report, connection);

    expect(isErr(answer)).toBe(true);
    expect(regated).toEqual([]);
  });
});

describe('regatingBindingRoutes', () => {
  const connection: BindingConnection = {
    clientId: 'cli_test',
    principal: {
      role: 'devtools',
      tokenHash: 'f'.repeat(64),
      scope: { kind: 'extension', extensionId: 'abcdefghijklmnopabcdefghijklmnop' },
      issuedAt: 0,
    },
  };
  const bindRequest = { tabId: 7, url: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' };
  const bindOutcome: SessionBindOutcome = {
    sessionId: 'ses_bound',
    tabId: 7,
    url: 'http://127.0.0.1:3000/',
    matchedBy: 'origin',
    announced: {
      payload: { sessionId: 'ses_bound', tabId: 7, url: 'http://127.0.0.1:3000/' },
      delivered: 1,
    },
    displaced: [],
    replayed: false,
    rearm: { status: 'no-active-capture' },
  };

  function routesWith(refuse = false): {
    routes: BindingRoutes;
    regated: RegateRequest[];
    delegated: string[];
  } {
    const regated: RegateRequest[] = [];
    const delegated: string[] = [];
    const inner: BindingRoutes = {
      handleSessionBind: () => {
        delegated.push('bind');
        return Promise.resolve(
          refuse
            ? {
                ok: false,
                error: new DebuggenError('SESSION_NOT_FOUND', 'No session serves this origin.'),
              }
            : { ok: true, value: bindOutcome },
        );
      },
      handleTabNavigated: () => {
        delegated.push('navigated');
        return Promise.resolve({ ok: true, value: { kind: 'ignored' } });
      },
      handleSessionUnbind: () => {
        delegated.push('unbind');
        return Promise.resolve({ ok: true, value: { kind: 'ignored' } });
      },
    };
    const routes = regatingBindingRoutes(
      inner,
      {
        regate: (request) => {
          regated.push(request);
          return Promise.resolve({
            ok: true,
            value: {
              sessionId: request.sessionId,
              outcome: 'regated',
              status: 'instrumenting',
              ready: false,
            },
          });
        },
      },
      noopLogger,
    );
    return { routes, regated, delegated };
  }

  it('returns the bind unchanged, then re-gates the session the tab was bound to', async () => {
    const { routes, regated, delegated } = routesWith();

    const answer = await routes.handleSessionBind(bindRequest, connection);

    expect(answer).toStrictEqual({ ok: true, value: bindOutcome });
    expect(delegated).toEqual(['bind']);
    expect(regated).toEqual([{ sessionId: 'ses_bound' }]);
  });

  it('returns a refused bind unchanged and re-gates nothing', async () => {
    const { routes, regated } = routesWith(true);

    const answer = await routes.handleSessionBind(bindRequest, connection);

    expect(isErr(answer)).toBe(true);
    expect(regated).toEqual([]);
  });

  it('delegates navigation and unbinding without re-gating', async () => {
    const { routes, regated, delegated } = routesWith();

    expect(
      isOk(await routes.handleTabNavigated({ tabId: 7, url: bindRequest.url }, connection)),
    ).toBe(true);
    expect(isOk(await routes.handleSessionUnbind({ tabId: 7 }, connection))).toBe(true);
    expect(delegated).toEqual(['navigated', 'unbind']);
    expect(regated).toEqual([]);
  });
});

describe('createIngestSourceLocator', () => {
  const PROJECT_ROOT = '/workspace/ledger-tool';
  const attribution: IngestAttribution = {
    sessionId: 'ses_located',
    captureId: 'cap_located',
    origin: 'browser-agent',
  };
  /** A render nothing in an empty project declares: resolvable by no route. */
  const render: AttributedEvent = {
    id: newEventId(),
    traceId: newTraceId(),
    spanId: newSpanId(),
    kind: 'render',
    name: 'render',
    startTime: MIN_EPOCH_MS + 1_000,
    duration: 1,
    tier: 'browser',
    attributes: {},
    status: 'ok',
    producerId: newProducerId(),
    seq: 0,
    sessionId: attribution.sessionId,
    captureId: attribution.captureId,
  };
  const session = {
    id: attribution.sessionId,
    projectRoot: PROJECT_ROOT,
    devServerUrl: 'http://127.0.0.1:3100/',
  } as unknown as SessionRecord;

  function locatorWith(options: {
    readonly record?: SessionRecord | undefined;
    readonly storeFails?: boolean;
    readonly load?: () => Promise<Result<PipelineCodeHandles, DebuggenError>>;
  }) {
    const loads: string[] = [];
    const locator = createIngestSourceLocator({
      sessions: {
        get: () =>
          options.storeFails === true
            ? err(new DebuggenError('STORE_ERROR', 'The store is closed.'))
            : ok(options.record),
      },
      codeIndex: {
        load: (projectRoot) => {
          loads.push(projectRoot);
          return (
            options.load?.() ??
            Promise.resolve(
              err(new DebuggenError('CODE_INDEX_FAILED', 'The project could not be indexed.')),
            )
          );
        },
      },
      modifications: { listBySession: () => ok([]), listPatchEvidence: () => ok([]) },
      events: { getBySpanId: () => ok(undefined) },
      logger: noopLogger,
    });
    return { locator, loads };
  }

  it('places nothing and loads no index for a session the store does not hold', async () => {
    const { locator, loads } = locatorWith({ record: undefined });

    const located = await locator.locate([render], attribution);

    expect(isOk(located) && located.value.size).toBe(0);
    expect(loads).toEqual([]);
  });

  it('answers with the routes that need no index when the index cannot be loaded', async () => {
    const { locator, loads } = locatorWith({ record: session });

    const located = await locator.locate([render], attribution);

    expect(isOk(located) && located.value.size).toBe(0);
    expect(loads).toEqual([PROJECT_ROOT]);
  });

  it('shares one in-flight index load across the batches of a burst', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { locator, loads } = locatorWith({
      record: session,
      load: () =>
        gate.then(() =>
          err(new DebuggenError('CODE_INDEX_FAILED', 'The project could not be indexed.')),
        ),
    });

    const first = locator.locate([render], attribution);
    const second = locator.locate([render], attribution);
    release?.();
    const answers = await Promise.all([first, second]);

    expect(answers.every((answer) => isOk(answer))).toBe(true);
    expect(loads).toEqual([PROJECT_ROOT]);
  });

  it('returns a store failure to ingest, which counts it', async () => {
    const { locator } = locatorWith({ storeFails: true });

    const located = await locator.locate([render], attribution);

    expect(isErr(located) && located.error.code).toBe('STORE_ERROR');
  });
});

/** A promise that never settles: a collaborator that hangs. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One row of the session index, as `SessionsRepo.list` returns it. */
function listItem(id: string, status: SessionStatus, updatedAt = 1_000): SessionListItem {
  return {
    id,
    projectRoot: '/workspace/ledger-tool',
    projectName: 'ledger-tool',
    status,
    question: 'Why is it slow?',
    createdAt: 1_000,
    updatedAt,
  };
}

/** A `SessionManager.end` answer carrying `cleanup`. */
function endedWith(cleanup: SessionEndResult['cleanup']): Result<SessionEndResult, DebuggenError> {
  return ok({ session: {} as unknown as SessionRecord, cleanup });
}

/** Loggers that discard everything. */
const QUIET_LOGGERS: ServiceLoggers = {
  root: noopLogger,
  service: noopLogger,
  server: noopLogger,
};

// An explicit 30 s per test, above the project's 20 s. The tests here run
// `releaseParts` under a 1.2 s stop budget, and 'leaves no credential of an
// unresponsive launched child valid for the next start' also boots the composed
// service twice — HTTP, WebSocket, store migration and crash recovery each
// time — and stops the first boot through a real `ServiceHandle.close`, whose
// own budget is `SHUTDOWN_BUDGET.totalMs` (8 s). That test normally takes
// about 1.1 s but took 5.25 s at a load average of 7-9, failing the 5 s
// default; 30 s keeps that headroom under heavier contention while a genuinely
// hung start or stop still fails.
describe('releaseParts — one deadline for the whole stop', { timeout: 30_000 }, () => {
  // A scaled-down budget with the production shape: the reserves are held back
  // for the launcher and the final steps, the pipeline is capped.
  const budget: ShutdownBudget = {
    totalMs: 1_200,
    pipelineMs: 200,
    launcherReserveMs: 400,
    finalReserveMs: 200,
  };
  /** How much later than its slice a step may be observed on a loaded host. */
  const SLACK_MS = 150;

  it('bounds the stop, and still stops the dev servers and closes the store, when earlier steps hang', async () => {
    const t0 = performance.now();
    const steps: { readonly step: string; readonly at: number }[] = [];
    const mark = (step: string): void => {
      steps.push({ step, at: performance.now() - t0 });
    };
    const parts: ServiceParts = {
      http: { close: () => mark('http') },
      ledger: { close: () => mark('ledger') },
      orchestrator: {
        dispose: () => {
          mark('pipeline');
          return never();
        },
      },
      liveSessions: {
        manager: {
          end: (sessionId) => {
            mark(`end:${sessionId}`);
            return never();
          },
        },
        sessions: {
          list: () =>
            ok({
              items: [listItem('ses_a', 'capturing'), listItem('ses_b', 'capturing')],
              total: 2,
            }),
        },
        modifications: { listAllOpen: () => Promise.resolve(ok([])) },
      },
      cleanup: { dispose: () => mark('cleanup') },
      launcher: {
        list: () => [],
        dispose: async () => {
          mark('launcher');
          await sleep(50);
          mark('launcher-done');
          return { survivors: [] };
        },
      },
      liveTail: {
        flush: () => {
          mark('flush');
          return Promise.resolve(ok(0));
        },
        close: () => mark('tail-close'),
      },
      ws: {
        close: () => {
          mark('ws');
          return Promise.resolve();
        },
      },
      instrumentation: { dispose: () => never() },
      store: { close: () => mark('store') },
    };

    await releaseParts(parts, QUIET_LOGGERS, { budget });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(budget.totalMs + SLACK_MS);
    expect(steps.map((entry) => entry.step)).toStrictEqual([
      'http',
      'ledger',
      'pipeline',
      'end:ses_a',
      'end:ses_b',
      'cleanup',
      'launcher',
      'launcher-done',
      'flush',
      'ws',
      'tail-close',
      'store',
    ]);
    // The hung pipeline had only its cap; each hung session end only its share
    // of what the reserves left — so the second session was still attempted —
    // and the launcher started no later than its reserve began.
    const at = (step: string): number => steps.find((entry) => entry.step === step)?.at ?? -1;
    const sessionsSlice =
      budget.totalMs - budget.pipelineMs - budget.launcherReserveMs - budget.finalReserveMs;
    expect(at('end:ses_a')).toBeLessThan(budget.pipelineMs + SLACK_MS);
    expect(at('end:ses_b')).toBeLessThan(budget.pipelineMs + sessionsSlice / 2 + SLACK_MS);
    expect(at('launcher')).toBeLessThan(
      budget.totalMs - budget.launcherReserveMs - budget.finalReserveMs + SLACK_MS,
    );
  });

  it('abandons a launcher that never finishes, revokes its projects’ credentials, then closes the store', async () => {
    const t0 = performance.now();
    const steps: string[] = [];
    const parts: ServiceParts = {
      launcher: {
        list: () =>
          [
            { projectRoot: '/workspace/ledger-tool' },
            { projectRoot: '/workspace/ledger-tool' },
          ] as unknown as ReturnType<NonNullable<ServiceParts['launcher']>['list']>,
        dispose: () => never(),
      },
      auth: {
        revokeServerAgentCredentials: (projectRoot) => {
          steps.push(`revoke:${projectRoot}`);
          return ok(1);
        },
        close: () => steps.push('auth-close'),
      },
      ws: { close: () => never() },
      store: { close: () => steps.push('store') },
    };

    await releaseParts(parts, QUIET_LOGGERS, { budget });

    expect(performance.now() - t0).toBeLessThan(budget.totalMs + SLACK_MS);
    expect(steps).toStrictEqual(['revoke:/workspace/ledger-tool', 'auth-close', 'store']);
  });

  it('revokes nothing itself when the launcher stopped every child, which revokes their credentials', async () => {
    const revoked: string[] = [];
    const parts: ServiceParts = {
      launcher: {
        list: () =>
          [{ projectRoot: '/workspace/ledger-tool' }] as unknown as ReturnType<
            NonNullable<ServiceParts['launcher']>['list']
          >,
        dispose: () => Promise.resolve({ survivors: [] }),
      },
      auth: {
        revokeServerAgentCredentials: (projectRoot) => {
          revoked.push(projectRoot);
          return ok(0);
        },
        close: () => undefined,
      },
    };

    await releaseParts(parts, QUIET_LOGGERS, { budget });

    expect(revoked).toStrictEqual([]);
  });

  it('leaves no credential of an unresponsive launched child valid for the next start', async () => {
    const { container, stateRoot } = makeStateRoot();
    const projectRoot = join(container, 'project');
    mkdirSync(projectRoot, { recursive: true });
    // A first start lays out the state tree and the store the stop will close.
    await (await started(stateRoot)).close();

    const config = unwrap(loadServiceConfig({}, { debuggenHome: stateRoot }));
    const store = unwrap(openStore({ config, logger: noopLogger }));
    const auth = unwrap(createAuthService({ store, config, logger: noopLogger }));
    // What a managed launch mints: scoped to the project, with no expiry.
    const { token } = unwrap(auth.issueServerAgentCredential({ projectRoot }));
    const hello = { client: 'server-agent', projectRoot, version: PROTOCOL_VERSION, token };
    expect(isOk(auth.authorizeHello({ payload: hello, origin: undefined }))).toBe(true);

    await releaseParts(
      {
        auth,
        store,
        launcher: {
          // The child never reports its exit, so the launcher never revokes.
          list: () =>
            [{ projectRoot }] as unknown as ReturnType<
              NonNullable<ServiceParts['launcher']>['list']
            >,
          dispose: never,
        },
      },
      QUIET_LOGGERS,
      { budget },
    );

    const next = await started(stateRoot);
    const socket = await connect(next);
    const closed = closeCodeOf(socket);
    helloAsServerAgent(socket, token, projectRoot);
    expect(await closed).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('never reads or ends a session when the live sessions are retained', async () => {
    const touched: string[] = [];
    const parts: ServiceParts = {
      liveSessions: {
        manager: {
          end: (sessionId) => {
            touched.push(`end:${sessionId}`);
            return Promise.resolve(endedWith({ status: 'clean', conflicts: [], completedAt: 1 }));
          },
        },
        sessions: {
          list: () => {
            touched.push('list');
            return ok({ items: [listItem('ses_a', 'capturing')], total: 1 });
          },
        },
        modifications: {
          listAllOpen: () => {
            touched.push('journal');
            return Promise.resolve(ok([]));
          },
        },
      },
      cleanup: { dispose: () => touched.push('cleanup') },
      store: { close: () => touched.push('store') },
    };

    await releaseParts(parts, QUIET_LOGGERS, { budget, liveSessions: 'retain' });

    expect(touched).toStrictEqual(['cleanup', 'store']);
  });
});

describe('endLiveSessions', () => {
  /** A journal record of `sessionId` that is still open. */
  function openRecordOf(sessionId: string): ModificationRecord {
    return { sessionId } as unknown as ModificationRecord;
  }

  it('ends exactly the sessions that hold instrumentation, most recently updated first', async () => {
    const listed: unknown[] = [];
    const ended: string[] = [];
    const report = await endLiveSessions(
      {
        manager: {
          end: (sessionId) => {
            ended.push(sessionId);
            return Promise.resolve(endedWith({ status: 'clean', conflicts: [], completedAt: 1 }));
          },
        },
        sessions: {
          list: (options) => {
            listed.push(options?.statuses);
            return ok({
              items: [
                listItem('ses_capturing', 'capturing', 5),
                listItem('ses_idle', 'generated', 4),
                listItem('ses_patched', 'generated', 3),
                listItem('ses_armed', 'ready', 2),
                listItem('ses_ready', 'ready', 1),
                listItem('ses_installing', 'instrumenting', 0),
              ],
              total: 6,
            });
          },
        },
        modifications: { listAllOpen: () => Promise.resolve(ok([openRecordOf('ses_patched')])) },
        instrumentation: {
          arming: (sessionId) =>
            sessionId === 'ses_armed' || sessionId === 'ses_ready'
              ? ({
                  sessionId,
                  ...(sessionId === 'ses_armed' ? { armedCaptureId: 'cap_armed' } : {}),
                } as unknown as ArmingSnapshot)
              : undefined,
        },
      },
      { timeoutMs: 1_000, logger: noopLogger },
    );

    const expected = ['ses_capturing', 'ses_patched', 'ses_armed', 'ses_installing'];
    expect(ended).toStrictEqual(expected);
    expect(report.live).toStrictEqual(expected);
    expect(report.ended.map((session) => session.sessionId)).toStrictEqual(expected);
    expect(report.unfinished).toStrictEqual([]);
    expect(report.timedOut).toBe(false);
    // Every status is asked for except the terminal one.
    expect(listed).toStrictEqual([SESSION_STATUSES.filter((status) => status !== 'ended')]);
  });

  it('pages through the whole session index', async () => {
    const pages: number[] = [];
    const idle = Array.from({ length: MAX_SESSION_LIST_LIMIT }, (_, index) =>
      listItem(`ses_idle_${String(index)}`, 'generated'),
    );
    const report = await endLiveSessions(
      {
        manager: {
          end: () => Promise.resolve(endedWith({ status: 'clean', conflicts: [], completedAt: 1 })),
        },
        sessions: {
          list: (options) => {
            const offset = options?.offset ?? 0;
            pages.push(offset);
            return ok(
              offset === 0
                ? { items: idle, total: MAX_SESSION_LIST_LIMIT + 1 }
                : { items: [listItem('ses_last', 'capturing')], total: MAX_SESSION_LIST_LIMIT + 1 },
            );
          },
        },
        modifications: { listAllOpen: () => Promise.resolve(ok([])) },
      },
      { timeoutMs: 1_000, logger: noopLogger },
    );

    expect(pages).toStrictEqual([0, MAX_SESSION_LIST_LIMIT]);
    expect(report.live).toStrictEqual(['ses_last']);
  });

  it('reports conflicts, and leaves a session whose end failed for the next start', async () => {
    const records = capturingDestination();
    const logger = createServiceLogger(
      unwrap(loadServiceConfig({}, { debuggenHome: makeStateRoot().stateRoot, logLevel: 'info' })),
      { destination: records },
    );
    const report = await endLiveSessions(
      {
        manager: {
          end: (sessionId) => {
            if (sessionId === 'ses_refused') {
              return Promise.resolve(
                err(new DebuggenError('SESSION_INVALID_STATE', 'An install is in progress.')),
              );
            }
            if (sessionId === 'ses_threw') {
              return Promise.reject(new Error('the store is closed'));
            }
            return Promise.resolve(
              endedWith({
                status: 'conflict',
                conflicts: [
                  {
                    recordId: 'mod_edited',
                    sessionId,
                    file: 'src/cart.ts',
                  } as unknown as SessionEndResult['cleanup']['conflicts'][number],
                ],
                completedAt: 1,
              }),
            );
          },
        },
        sessions: {
          list: () =>
            ok({
              items: [
                listItem('ses_conflict', 'capturing'),
                listItem('ses_refused', 'capturing'),
                listItem('ses_threw', 'capturing'),
              ],
              total: 3,
            }),
        },
        modifications: { listAllOpen: () => Promise.resolve(ok([])) },
      },
      { timeoutMs: 1_000, logger },
    );

    expect(report.ended).toStrictEqual([
      { sessionId: 'ses_conflict', cleanup: 'conflict', conflictFiles: ['src/cart.ts'] },
    ]);
    expect(report.unfinished).toStrictEqual(['ses_refused', 'ses_threw']);
    expect(report.timedOut).toBe(false);
    const logged = records.records.join('');
    expect(logged).toContain('files edited while instrumented were not overwritten');
    expect(logged).toContain('src/cart.ts');
    expect(logged).toContain('a live session could not be ended');
  });

  it('gives a stalled end only its share of the slice, still ends the sessions after it and disarms it', async () => {
    const t0 = performance.now();
    const disarmed: { readonly sessionId: string; readonly projectRoot?: string | undefined }[] =
      [];
    const report = await endLiveSessions(
      {
        manager: {
          end: (sessionId) =>
            sessionId === 'ses_stuck'
              ? never()
              : sleep(20).then(() => endedWith({ status: 'clean', conflicts: [], completedAt: 1 })),
        },
        sessions: {
          list: () =>
            ok({
              items: [
                listItem('ses_quick', 'capturing'),
                listItem('ses_stuck', 'capturing'),
                listItem('ses_after', 'capturing'),
              ],
              total: 3,
            }),
        },
        modifications: { listAllOpen: () => Promise.resolve(ok([])) },
        instrumentation: {
          arming: () => undefined,
          disarmCapture: (request) => {
            disarmed.push({ sessionId: request.sessionId, projectRoot: request.projectRoot });
            return ok({
              sessionId: request.sessionId,
              agentDisarmed: true,
              serverAgent: 'delivered',
            });
          },
        },
      },
      { timeoutMs: 300, logger: noopLogger },
    );

    expect(performance.now() - t0).toBeLessThan(300 + 150);
    expect(report.ended.map((session) => session.sessionId)).toStrictEqual([
      'ses_quick',
      'ses_after',
    ]);
    expect(report.unfinished).toStrictEqual(['ses_stuck']);
    expect(report.timedOut).toBe(true);
    // The stalled session's producers are disarmed anyway, for its own project.
    expect(disarmed).toStrictEqual([
      { sessionId: 'ses_stuck', projectRoot: '/workspace/ledger-tool' },
    ]);
  });

  it('disarms a session whose end was refused, so its producers do not outlive the stop', async () => {
    const disarmed: string[] = [];
    const report = await endLiveSessions(
      {
        manager: {
          end: () =>
            Promise.resolve(
              err(new DebuggenError('SESSION_INVALID_STATE', 'An install is in progress.')),
            ),
        },
        sessions: {
          list: () => ok({ items: [listItem('ses_installing', 'instrumenting')], total: 1 }),
        },
        modifications: { listAllOpen: () => Promise.resolve(ok([])) },
        instrumentation: {
          arming: () => undefined,
          disarmCapture: (request) => {
            disarmed.push(request.sessionId);
            return ok({
              sessionId: request.sessionId,
              agentDisarmed: false,
              serverAgent: 'delivered',
            });
          },
        },
      },
      { timeoutMs: 1_000, logger: noopLogger },
    );

    expect(report.unfinished).toStrictEqual(['ses_installing']);
    expect(report.timedOut).toBe(false);
    expect(disarmed).toStrictEqual(['ses_installing']);
  });

  it('still ends the capturing sessions when the journal cannot be read', async () => {
    const report = await endLiveSessions(
      {
        manager: {
          end: () => Promise.resolve(endedWith({ status: 'clean', conflicts: [], completedAt: 1 })),
        },
        sessions: {
          list: () =>
            ok({
              items: [listItem('ses_capturing', 'capturing'), listItem('ses_idle', 'generated')],
              total: 2,
            }),
        },
        modifications: {
          listAllOpen: () =>
            Promise.resolve(err(new DebuggenError('STORE_ERROR', 'The journal is locked.'))),
        },
      },
      { timeoutMs: 1_000, logger: noopLogger },
    );

    expect(report.live).toStrictEqual(['ses_capturing']);
  });

  /** An open record of `sessionId` on `file`, taking the file from `from` to `to`. */
  function patchRecord(
    sessionId: string,
    file: string,
    from: string,
    to: string,
    appliedAt: number,
  ): ModificationRecord {
    return {
      sessionId,
      file,
      originalHash: sha256Hex(from),
      instrumentedHash: sha256Hex(to),
      appliedAt,
    } as unknown as ModificationRecord;
  }

  /** Ends `items` over `records` and answers the order the sessions were ended in. */
  async function endOrder(
    items: readonly SessionListItem[],
    records: readonly ModificationRecord[],
    logger = noopLogger,
  ): Promise<string[]> {
    const ended: string[] = [];
    await endLiveSessions(
      {
        manager: {
          end: (sessionId) => {
            ended.push(sessionId);
            return Promise.resolve(endedWith({ status: 'clean', conflicts: [], completedAt: 1 }));
          },
        },
        sessions: { list: () => ok({ items, total: items.length }) },
        modifications: { listAllOpen: () => Promise.resolve(ok([...records])) },
      },
      { timeoutMs: 1_000, logger },
    );
    return ended;
  }

  it('unwinds a patch applied on top of another session’s first, whatever the update order', async () => {
    // A patched the file, B patched A's bytes, then A was updated more recently
    // (it started a capture, say): the index lists A first, but B must go first.
    const order = await endOrder(
      [listItem('ses_a', 'capturing', 9), listItem('ses_b', 'ready', 1)],
      [
        patchRecord('ses_a', 'src/cart.ts', 'original', 'patched-by-a', 100),
        patchRecord('ses_b', 'src/cart.ts', 'patched-by-a', 'patched-by-a-and-b', 100),
      ],
    );

    expect(order).toStrictEqual(['ses_b', 'ses_a']);
  });

  it('falls back to the application times when the hashes do not chain', async () => {
    const order = await endOrder(
      [listItem('ses_a', 'capturing', 9), listItem('ses_b', 'ready', 1)],
      [
        patchRecord('ses_a', 'src/cart.ts', 'original', 'patched-by-a', 100),
        patchRecord('ses_b', 'src/cart.ts', 'edited-in-between', 'patched-by-b', 200),
      ],
    );

    expect(order).toStrictEqual(['ses_b', 'ses_a']);
  });

  it('keeps the index order for sessions that share no file, including one path in two projects', async () => {
    const otherProject = { ...listItem('ses_other', 'ready', 1), projectRoot: '/workspace/other' };
    const order = await endOrder(
      [listItem('ses_a', 'capturing', 9), listItem('ses_c', 'capturing', 5), otherProject],
      [
        patchRecord('ses_a', 'src/cart.ts', 'original', 'patched-by-a', 100),
        patchRecord('ses_c', 'src/orders.ts', 'original', 'patched-by-c', 300),
        patchRecord('ses_other', 'src/cart.ts', 'patched-by-a', 'patched-elsewhere', 400),
      ],
    );

    expect(order).toStrictEqual(['ses_a', 'ses_c', 'ses_other']);
  });

  it('leaves a session under an unfinished one for the next start instead of recording a false conflict', async () => {
    const attempted: string[] = [];
    const disarmed: string[] = [];
    const report = await endLiveSessions(
      {
        manager: {
          end: (sessionId) => {
            attempted.push(sessionId);
            return sessionId === 'ses_upper'
              ? never()
              : Promise.resolve(endedWith({ status: 'clean', conflicts: [], completedAt: 1 }));
          },
        },
        sessions: {
          list: () =>
            ok({
              items: [
                listItem('ses_lower', 'capturing', 9),
                listItem('ses_upper', 'ready', 5),
                listItem('ses_elsewhere', 'ready', 1),
              ],
              total: 3,
            }),
        },
        modifications: {
          listAllOpen: () =>
            Promise.resolve(
              ok([
                patchRecord('ses_lower', 'src/cart.ts', 'original', 'patched-by-lower', 100),
                patchRecord('ses_upper', 'src/cart.ts', 'patched-by-lower', 'both', 200),
                patchRecord('ses_elsewhere', 'src/orders.ts', 'original', 'patched', 300),
              ]),
            ),
        },
        instrumentation: {
          arming: () => undefined,
          disarmCapture: (request) => {
            disarmed.push(request.sessionId);
            return ok({
              sessionId: request.sessionId,
              agentDisarmed: true,
              serverAgent: 'delivered',
            });
          },
        },
      },
      { timeoutMs: 300, logger: noopLogger },
    );

    // The upper session is attempted first and stalls; the lower one is not
    // attempted at all; the independent one is still ended.
    expect(report.live).toStrictEqual(['ses_upper', 'ses_lower', 'ses_elsewhere']);
    expect(attempted).toStrictEqual(['ses_upper', 'ses_elsewhere']);
    expect(report.ended.map((session) => session.sessionId)).toStrictEqual(['ses_elsewhere']);
    expect(report.unfinished).toStrictEqual(['ses_upper', 'ses_lower']);
    expect(disarmed).toStrictEqual(['ses_upper', 'ses_lower']);
  });

  it('ends every session of an interleaved cycle once, and says so', async () => {
    const records = capturingDestination();
    const logger = createServiceLogger(
      unwrap(loadServiceConfig({}, { debuggenHome: makeStateRoot().stateRoot, logLevel: 'warn' })),
      { destination: records },
    );
    const order = await endOrder(
      [listItem('ses_a', 'capturing', 9), listItem('ses_b', 'ready', 1)],
      [
        patchRecord('ses_a', 'src/cart.ts', 'original', 'a-on-cart', 100),
        patchRecord('ses_b', 'src/cart.ts', 'a-on-cart', 'b-on-cart', 200),
        patchRecord('ses_b', 'src/orders.ts', 'original', 'b-on-orders', 300),
        patchRecord('ses_a', 'src/orders.ts', 'b-on-orders', 'a-on-orders', 400),
      ],
      logger,
    );

    expect([...order].sort()).toStrictEqual(['ses_a', 'ses_b']);
    expect(records.records.join('')).toContain('patched the same files in an interleaved order');
  });
});

describe('releaseParts — the stop keeps its own process alive', () => {
  /** The repository root, the directory `tsx` resolves from. */
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const mainUrl = new URL('./main.ts', import.meta.url).href;

  it('finishes every step in a child process whose last handle was the listener it closed', async () => {
    // A step that waits on a promise nothing references, after the listener —
    // the process's only handle — has closed: without a referenced watchdog,
    // Node would exit mid-sequence and the store would never be closed.
    const { container } = makeStateRoot();
    mkdirSync(container, { recursive: true });
    const script = join(container, 'release-in-child.mts');
    writeFileSync(
      script,
      [
        "import { createServer } from 'node:http';",
        `const { releaseParts } = await import(${JSON.stringify(mainUrl)});`,
        "const quiet = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return quiet; } };",
        'const server = createServer();',
        "await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));",
        'await releaseParts(',
        "  { server, instrumentation: { dispose: () => new Promise(() => {}) }, store: { close: () => process.stdout.write('store-closed\\n') } },",
        '  { root: quiet, service: quiet, server: quiet },',
        '  { budget: { totalMs: 600, pipelineMs: 50, launcherReserveMs: 100, finalReserveMs: 100 } },',
        ');',
        "process.stdout.write('released\\n');",
        '',
      ].join('\n'),
    );

    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: repoRoot,
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', resolve);
    });

    expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: 'store-closed\nreleased\n' });
  }, 60_000);
});

describe('SHUTDOWN_BUDGET — the stop fits every process that stops the service', () => {
  /** The service's whole lifetime after `SIGTERM`: the deadline plus the exit backstop. */
  const lifetimeMs = SHUTDOWN_BUDGET.totalMs + EXIT_BACKSTOP_MS;

  /** Reads a numeric literal (`12_000`) captured by `pattern` from a repository file. */
  function numberIn(relativeToHere: string, pattern: RegExp): number {
    const text = readFileSync(fileURLToPath(new URL(relativeToHere, import.meta.url)), 'utf8');
    const match = pattern.exec(text);
    expect(match, `${relativeToHere} no longer matches ${String(pattern)}`).not.toBeNull();
    return Number((match?.[1] ?? '').replaceAll('_', ''));
  }

  it("exits inside Playwright's webServer grace", () => {
    const grace = numberIn(
      '../../../playwright.config.ts',
      /gracefulShutdown:\s*\{\s*signal:\s*'SIGTERM',\s*timeout:\s*([\d_]+)\s*\}/u,
    );
    expect(grace).toBeGreaterThan(lifetimeMs);
  });

  it("exits inside the VS Code extension's service-supervisor grace", () => {
    const grace = numberIn(
      '../../vscode-extension/src/service/process.ts',
      /export const DEFAULT_STOP_GRACE_MS = ([\d_]+);/u,
    );
    expect(grace).toBeGreaterThan(lifetimeMs);
  });

  it("reserves the launcher's worst case, with time left to revoke, and leaves the live sessions a real slice", () => {
    const killConfirmMs = numberIn(
      './dev-server/launcher.ts',
      /const KILL_CONFIRM_MS = ([\d_]+);/u,
    );
    // The mirror the budget is derived from must track the launcher's private value.
    expect(LAUNCHER_KILL_CONFIRM_MS).toBe(killConfirmMs);
    // The launcher revokes a child's credential only after both waits, so the
    // reserve needs strictly more than their sum for the revocation to land.
    expect(LAUNCHER_REVOCATION_SLACK_MS).toBeGreaterThan(0);
    expect(SHUTDOWN_BUDGET.launcherReserveMs).toBeGreaterThanOrEqual(
      DEV_SERVER_STOP_GRACE_MS + killConfirmMs + LAUNCHER_REVOCATION_SLACK_MS,
    );
    const leastForSessions =
      SHUTDOWN_BUDGET.totalMs -
      SHUTDOWN_BUDGET.pipelineMs -
      SHUTDOWN_BUDGET.launcherReserveMs -
      SHUTDOWN_BUDGET.finalReserveMs;
    expect(leastForSessions).toBeGreaterThanOrEqual(1_000);
  });
});

describe('isProcessEntry — importing the module starts nothing', () => {
  const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));
  const mainUrl = new URL('./main.ts', import.meta.url).href;

  it('is false under the test runner, which is why importing this module bound no socket', () => {
    expect(isProcessEntry()).toBe(false);
  });

  it('is false without an entry script and for another script', () => {
    expect(isProcessEntry(['node'], mainUrl)).toBe(false);
    expect(isProcessEntry(['node', ''], mainUrl)).toBe(false);
    expect(isProcessEntry(['node', fileURLToPath(import.meta.url)], mainUrl)).toBe(false);
  });

  it('is false, and does not throw, for a module URL a bundler rewrote away from file:', () => {
    expect(() => isProcessEntry(['node', mainPath], 'data:text/javascript,')).not.toThrow();
    expect(isProcessEntry(['node', mainPath], 'data:text/javascript,')).toBe(false);
    expect(isProcessEntry(['node', mainPath], '')).toBe(false);
  });

  it('is true for this module, directly and through a symbolic link', () => {
    expect(isProcessEntry(['node', mainPath], mainUrl)).toBe(true);

    const { container } = makeStateRoot();
    const link = join(container, 'main-link.ts');
    symlinkSync(mainPath, link);
    expect(isProcessEntry(['node', link], mainUrl)).toBe(true);
  });
});
