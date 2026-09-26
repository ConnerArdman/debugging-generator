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
 *
 * Every start passes `env: {}` and explicit overrides, so nothing here reads the
 * developer's environment or `.env`: a fresh `mkdtemp` state root, `port: 0` and
 * `logLevel: 'silent'` (or a capturing destination where a case reads the log).
 * `realpathSync` is applied to the temporary root because `ensureSecureDir`
 * refuses a path whose existing prefix contains a symbolic link, which
 * `os.tmpdir()` is on macOS.
 */

import { afterEach, describe, expect, it } from 'vitest';
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
import type { LogRecord, Result } from '@debuggen/shared';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { AUTH_FILE_NAME, SESSIONS_DATABASE_FILE_NAME, loadServiceConfig } from './config.js';
import { createDevServerLauncher } from './dev-server/launcher.js';
import type { DevServerLauncher, DevServerTerminationReport } from './dev-server/launcher.js';
import { fingerprintDocumentId } from './instrumentation/document-fingerprint.js';
import type { ArmingSnapshot } from './instrumentation/service.js';
import { createServiceLogger } from './logging.js';
import {
  DEV_SERVER_STOP_GRACE_MS,
  EXIT_BACKSTOP_MS,
  LAUNCHER_KILL_CONFIRM_MS,
  LAUNCHER_REVOCATION_SLACK_MS,
  SERVICE_VERSION,
  SHUTDOWN_BUDGET,
  createAgentReadyLedger,
  createIngestSourceLocator,
  endLiveSessions,
  isProcessEntry,
  regatingBindingRoutes,
  regatingReadinessPort,
  releaseParts,
  startService,
  type ServiceHandle,
  type ServiceLoggers,
  type ServiceParts,
  type ShutdownBudget,
  type StartServiceOptions,
} from './main.js';
import type { PipelineCodeHandles } from './pipeline/context-builder.js';
import type { RegateRequest } from './pipeline/orchestrator.js';
import { createAuthService } from './server/auth.js';
import { WS_CLOSE_GOING_AWAY } from './server/clients.js';
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

/** Temporary roots and open handles this suite cleans up after itself. */
const roots: string[] = [];
const handles: ServiceHandle[] = [];
const sockets: WebSocket[] = [];

/**
 * A fresh, symlink-free temporary directory and the state root inside it. The
 * state root is a *child* of the `mkdtemp` directory so `ensureSecureDir` is
 * exercised on a component it creates, as on a developer's first run.
 */
function makeStateRoot(): { readonly container: string; readonly stateRoot: string } {
  const container = mkdtempSync(join(realpathSync(tmpdir()), 'debuggen-main-test-'));
  roots.push(container);
  return { container, stateRoot: join(container, 'home') };
}

/** Starts the service against `stateRoot` on an ephemeral port. */
async function start(
  stateRoot: string,
  extra: Omit<StartServiceOptions, 'env'> = {},
): ReturnType<typeof startService> {
  const started = await startService({
    env: {},
    ...extra,
    overrides: { debuggenHome: stateRoot, port: 0, logLevel: 'silent', ...extra.overrides },
  });
  if (isOk(started)) {
    handles.push(started.value);
  }
  return started;
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

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
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
    expect(handle.startup.retention).toBeDefined();

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

  it('refuses a broken prompt tree and releases the store it had opened', async () => {
    const { container, stateRoot } = makeStateRoot();
    const emptyPrompts = join(container, 'prompts');
    mkdirSync(emptyPrompts, { recursive: true });

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

describe('releaseParts — one deadline for the whole stop', () => {
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
