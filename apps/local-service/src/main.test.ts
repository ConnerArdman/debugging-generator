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
import {
  AUTHORIZATION_HEADER,
  HttpClient,
  PROTOCOL_VERSION,
  WS_PATH,
  createEnvelope,
  encodeMessage,
  formatBearer,
  healthResponseSchema,
  type AgentReadyPayload,
} from '@debuggen/protocol';
import {
  DebuggenError,
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
import type { Result } from '@debuggen/shared';
import { MIN_EPOCH_MS } from '@debuggen/telemetry';
import type { SessionRecord } from '@debuggen/protocol';
import { sha256Hex } from '@debuggen/shared/node';

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
import { fileURLToPath } from 'node:url';

import { AUTH_FILE_NAME, SESSIONS_DATABASE_FILE_NAME } from './config.js';
import {
  SERVICE_VERSION,
  createAgentReadyLedger,
  createIngestSourceLocator,
  isProcessEntry,
  regatingBindingRoutes,
  regatingReadinessPort,
  startService,
  type ServiceHandle,
  type StartServiceOptions,
} from './main.js';
import type { PipelineCodeHandles } from './pipeline/context-builder.js';
import type { RegateRequest } from './pipeline/orchestrator.js';
import { WS_CLOSE_GOING_AWAY } from './server/clients.js';
import type {
  BindingConnection,
  BindingRoutes,
  SessionBindOutcome,
} from './server/routes/binding.js';
import type { WsConnectionFacts } from './server/ws.js';
import type { AttributedEvent, IngestAttribution } from './telemetry/attribute.js';
import { createModificationsRepo } from './store/modifications-repo.js';
import { STORE_SCHEMA_VERSION } from './store/migrations.js';

/** The permission bits of a mode, masked out of the file-type bits. */
const PERMISSION_BITS = 0o777;

/** What AAP 0.4.2 requires of every file under `$DEBUGGEN_HOME`. */
const OWNER_ONLY_FILE = 0o600;

/** What AAP 0.4.2 requires of every directory under `$DEBUGGEN_HOME`. */
const OWNER_ONLY_DIR = 0o700;

/** How long a polling assertion waits before failing. */
const POLL_TIMEOUT_MS = 5_000;

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
});

describe('startService — crash recovery before serving', () => {
  it('restores a file an earlier process left instrumented, before the handle exists', async () => {
    const { container, stateRoot } = makeStateRoot();
    const projectRoot = join(container, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    const file = 'src/checkout.ts';
    const originalBytes = 'export function total(): number {\n  return 1;\n}\n';
    const instrumentedBytes =
      'export function total(): number {\n  return (globalThis as never, 1);\n}\n';

    // A first process: a session instruments one file and is then killed — its
    // journal says `applied`, the file holds the patched bytes, and no cleanup
    // ever ran.
    const first = await started(stateRoot);
    const session = unwrap(
      await first.manager.create({
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
        diff: `--- a/${file}\n+++ b/${file}\n@@ -2 +2 @@\n`,
        status: 'applied',
      }),
    );
    unwrap(await createModificationsRepo({ store: first.store }).append(record));
    writeFileSync(join(projectRoot, file), instrumentedBytes);
    for (const handle of handles.splice(0)) {
      await handle.close();
    }

    const second = await started(stateRoot);

    expect(readFileSync(join(projectRoot, file), 'utf8')).toBe(originalBytes);
    expect(second.startup.reconciliation.restored).toBe(1);
    expect(second.startup.reconciliation.conflicts).toBe(0);
    const journaled = unwrap(await createModificationsRepo({ store: second.store }).get(record.id));
    expect(journaled?.status).toBe('reverted');
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
      modifications: { listBySession: () => ok([]) },
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
