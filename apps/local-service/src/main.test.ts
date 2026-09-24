/**
 * Tests for `./main.ts`, the service's composition root — specifically the two
 * guarantees that are properties of the *filesystem* and of *process state*
 * rather than of a return value, and which nothing else in the repository
 * establishes:
 *
 * 1. **The session store is a regular, owner-only file.** AAP 0.4.2 states that
 *    the `$DEBUGGEN_HOME` tree is created `0700` and every file in it `0600`.
 *    `node:sqlite`'s `DatabaseSync` accepts no mode and follows a symbolic link
 *    at the path it is given, so `main.ts` establishes the file before SQLite
 *    opens it: it creates a missing database with `O_EXCL | O_NOFOLLOW` at
 *    `0600`, adopts an existing regular file by restricting it through a
 *    no-follow descriptor, and refuses a link or a non-regular entry outright.
 *    The assertions below are `lstat` modes and the *bytes of a planted link's
 *    target*, because those are what an attacker or an accident would change.
 * 2. **A refused start leaves nothing behind, and a successful one can be shut
 *    down twice.** Every step of `startService` reports a typed `Err`, and a
 *    failure after a resource was acquired releases it — so a caller that
 *    retries meets a clean tree rather than its own predecessor. The retry case
 *    is asserted directly: the same state root that refused a start accepts one
 *    once the planted link is removed.
 *
 * The suite also covers the HTTP surface `main.ts` actually serves — the
 * unauthenticated health route and the origin guard of AAP 0.5.6 — because the
 * only other check of those is the Playwright `webServer` block, which reads the
 * health route's status code and nothing else, and runs in the end-to-end job
 * rather than in `pnpm test`. The health body is held to its one definition,
 * `healthResponseSchema` in `@debuggen/protocol`, both by parsing the live reply
 * and by reading it through the protocol's own `HttpClient.health()`, which is
 * what every client of the service does.
 *
 * ## How these tests bind
 *
 * Every case passes `env: {}` and an explicit `overrides` object, so nothing
 * here reads the developer's environment or `.env`: `debuggenHome` is a fresh
 * `mkdtemp` directory, `port: 0` asks the operating system for a free port (no
 * two workspaces and no two clones can collide on this host), and
 * `logLevel: 'silent'` makes `createServiceLogger` return the shared no-op
 * logger, so a passing run prints nothing and a failing one is not buried in
 * pino output.
 *
 * `realpathSync` is applied to the temporary root deliberately: `ensureSecureDir`
 * refuses a path whose existing prefix contains a symbolic link, and on macOS
 * `os.tmpdir()` is exactly that (`/var` → `/private/var`). Resolving it once
 * keeps the suite a test of this module rather than of the platform's temp
 * directory layout.
 */

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HttpClient,
  PROTOCOL_VERSION,
  healthResponseSchema,
  parseHttpResponse,
} from '@debuggen/protocol';
import type * as ProtocolModule from '@debuggen/protocol';
import { DebuggenError, err, isErr, isOk } from '@debuggen/shared';

import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { servesPairingFlow, startService, type ServiceHandle } from './main.js';
import { SESSIONS_DATABASE_FILE_NAME } from './config.js';
import { STORE_SCHEMA_VERSION } from './store/migrations.js';

// `parseHttpResponse` is the one seam through which `main.ts` validates its
// health body. It is wrapped in a spy that calls the real implementation, so
// every case below sees the protocol's own validation, and the one case that
// needs a refused body replaces a single call with `mockReturnValueOnce`.
// `HttpClient` reaches its parser inside the protocol bundle rather than through
// this export, so the client-side cases always parse for real.
vi.mock('@debuggen/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof ProtocolModule>();
  return { ...actual, parseHttpResponse: vi.fn(actual.parseHttpResponse) };
});

/** The permission bits of a mode, masked out of the file-type bits. */
const PERMISSION_BITS = 0o777;

/** What AAP 0.4.2 requires of every file under `$DEBUGGEN_HOME`. */
const OWNER_ONLY_FILE = 0o600;

/** What AAP 0.4.2 requires of every directory under `$DEBUGGEN_HOME`. */
const OWNER_ONLY_DIR = 0o700;

/** Temporary roots and open handles this suite has to clean up after itself. */
const roots: string[] = [];
const handles: ServiceHandle[] = [];

/**
 * A fresh, symlink-free temporary directory, plus the state root inside it that
 * a test hands to `startService`.
 *
 * The state root is a *child* of the `mkdtemp` directory rather than the
 * directory itself, so that `ensureSecureDir` is exercised on a component it
 * creates — which is the case a first run on a developer's machine takes.
 */
function makeStateRoot(): { readonly container: string; readonly stateRoot: string } {
  const container = mkdtempSync(join(realpathSync(tmpdir()), 'debuggen-main-test-'));
  roots.push(container);
  return { container, stateRoot: join(container, 'home') };
}

/** Starts the service against `stateRoot` on an ephemeral port, silently. */
async function start(stateRoot: string): ReturnType<typeof startService> {
  const started = await startService({
    env: {},
    overrides: { debuggenHome: stateRoot, port: 0, logLevel: 'silent' },
  });
  if (isOk(started)) {
    handles.push(started.value);
  }
  return started;
}

/** The permission bits of the entry *at* `path`, never of a link's target. */
function modeOf(path: string): number {
  return lstatSync(path).mode & PERMISSION_BITS;
}

/**
 * The `version` this workspace's `package.json` declares, read from disk.
 *
 * `main.ts` reports its build version from a literal it keeps in step with the
 * manifest by hand, because no way of reading the manifest holds in every
 * layout the service runs in. This is the other half of that arrangement: the
 * health tests compare the live body with it, so a version bump that misses
 * the literal fails here rather than reaching a client.
 */
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

/** A handler that answers, for the route-registry cases of `servesPairingFlow`. */
function answer(): Response {
  return new Response(null, { status: 204 });
}

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('startService — the state tree and the session store', () => {
  it('creates the state tree 0700 and every store file 0600, and migrates the schema', async () => {
    const { stateRoot } = makeStateRoot();

    const started = await start(stateRoot);
    expect(isOk(started)).toBe(true);
    if (!isOk(started)) {
      return;
    }

    expect(modeOf(stateRoot)).toBe(OWNER_ONLY_DIR);
    expect(modeOf(join(stateRoot, 'backups'))).toBe(OWNER_ONLY_DIR);
    expect(modeOf(join(stateRoot, 'index'))).toBe(OWNER_ONLY_DIR);

    const databasePath = join(stateRoot, SESSIONS_DATABASE_FILE_NAME);
    expect(lstatSync(databasePath).isFile()).toBe(true);
    // The write-ahead sidecars carry the same session data as the database, so
    // the rule applies to them too; they exist because the migration wrote.
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      expect(modeOf(path)).toBe(OWNER_ONLY_FILE);
    }

    const db = new DatabaseSync(databasePath);
    try {
      expect(db.prepare('PRAGMA user_version').get()?.['user_version']).toBe(STORE_SCHEMA_VERSION);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row['name']);
      expect(tables).toContain('sessions');
      expect(tables).toContain('modifications');
      expect(tables).toContain('telemetry_events');
    } finally {
      db.close();
    }
  });

  it('restricts a database it adopts, rather than only one it creates', async () => {
    const { stateRoot } = makeStateRoot();
    const databasePath = join(stateRoot, SESSIONS_DATABASE_FILE_NAME);

    // A database left behind by a build that created it under a permissive
    // umask: the file is genuine and must be kept, but its mode must not be.
    mkdirSync(stateRoot, { recursive: true, mode: OWNER_ONLY_DIR });
    writeFileSync(databasePath, '');
    chmodSync(databasePath, 0o666);
    expect(modeOf(databasePath)).toBe(0o666);

    const started = await start(stateRoot);
    expect(isOk(started)).toBe(true);
    expect(modeOf(databasePath)).toBe(OWNER_ONLY_FILE);
  });

  it('refuses a symbolic link planted at the database path, leaving its target untouched', async () => {
    const { container, stateRoot } = makeStateRoot();
    const decoy = join(container, 'decoy.txt');
    const decoyContent = 'bytes that belong to another file\n';
    writeFileSync(decoy, decoyContent);

    mkdirSync(stateRoot, { recursive: true, mode: OWNER_ONLY_DIR });
    symlinkSync(decoy, join(stateRoot, SESSIONS_DATABASE_FILE_NAME));

    const started = await start(stateRoot);
    expect(isErr(started)).toBe(true);
    if (isErr(started)) {
      expect(started.error.code).toBe('FS_UNSAFE_PATH');
      // The rejection names the schema-level problem and the path, never the
      // contents of anything it refused to read.
      expect(started.error.message).not.toContain(decoyContent.trim());
    }

    // The link was refused, not written through: the decoy still holds exactly
    // what it held, and SQLite never turned it into a database.
    expect(readFileSync(decoy, 'utf8')).toBe(decoyContent);
  });

  it('accepts a start on the same state root once the planted link is removed', async () => {
    const { container, stateRoot } = makeStateRoot();
    const databasePath = join(stateRoot, SESSIONS_DATABASE_FILE_NAME);
    writeFileSync(join(container, 'decoy.txt'), 'decoy\n');
    mkdirSync(stateRoot, { recursive: true, mode: OWNER_ONLY_DIR });
    symlinkSync(join(container, 'decoy.txt'), databasePath);

    expect(isErr(await start(stateRoot))).toBe(true);

    // A refused start releases everything it acquired, so the retry is a first
    // start rather than a second one competing with an open handle.
    rmSync(databasePath);
    const retried = await start(stateRoot);
    expect(isOk(retried)).toBe(true);
    expect(modeOf(databasePath)).toBe(OWNER_ONLY_FILE);
  });

  it('refuses a non-regular entry at the database path', async () => {
    const { stateRoot } = makeStateRoot();
    mkdirSync(join(stateRoot, SESSIONS_DATABASE_FILE_NAME), { recursive: true, mode: 0o700 });

    const started = await start(stateRoot);
    expect(isErr(started)).toBe(true);
    if (isErr(started)) {
      expect(started.error.code).toBe('STORE_ERROR');
    }
  });
});

describe('startService — the HTTP surface', () => {
  it('answers the unauthenticated health route with exactly the protocol health body', async () => {
    const { stateRoot } = makeStateRoot();
    const started = await start(stateRoot);
    expect(isOk(started)).toBe(true);
    if (!isOk(started)) {
      return;
    }

    const response = await fetch(`${started.value.url}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/u);
    const body: unknown = await response.json();

    // The one definition of the body (AAP 0.4.2), applied strictly: a missing
    // field fails it and so does an extra one.
    const parsed = healthResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    // "Version and pairing availability only" (AAP 0.5.6): exactly three keys.
    expect(Object.keys(body as object).sort()).toEqual([
      'pairingAvailable',
      'protocolVersion',
      'version',
    ]);
    expect(body).toStrictEqual({
      version: manifestVersion(),
      protocolVersion: PROTOCOL_VERSION,
      pairingAvailable: false,
    });
    // No CORS header is ever set, so a web page cannot read a response even if
    // one were answered to it (AAP 0.5.6).
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reports the service build version its package.json declares', async () => {
    const { stateRoot } = makeStateRoot();
    const started = await start(stateRoot);
    expect(isOk(started)).toBe(true);
    if (!isOk(started)) {
      return;
    }

    const body: unknown = await (await fetch(`${started.value.url}/health`)).json();
    const version = manifestVersion();
    expect(version.length).toBeGreaterThan(0);
    expect(body).toMatchObject({ version });
  });

  it('reports pairing unavailable while neither pairing route is served', async () => {
    const { stateRoot } = makeStateRoot();
    const started = await start(stateRoot);
    expect(isOk(started)).toBe(true);
    if (!isOk(started)) {
      return;
    }
    const { url } = started.value;

    // The flag and the routes agree: this composition answers both pairing
    // operations 404, so a client that read `true` would offer a pairing dialog
    // that cannot succeed.
    for (const path of ['/pair/start', '/pair/complete']) {
      const probe = await fetch(`${url}${path}`, { method: 'POST', body: '{}' });
      expect(probe.status).toBe(404);
    }
    const body: unknown = await (await fetch(`${url}/health`)).json();
    expect(body).toMatchObject({ pairingAvailable: false });
  });

  it('is read as a healthy service by the protocol HttpClient.health()', async () => {
    const { stateRoot } = makeStateRoot();
    const started = await start(stateRoot);
    expect(isOk(started)).toBe(true);
    if (!isOk(started)) {
      return;
    }

    // The consumer every client uses — VS Code service discovery, the DevTools
    // "Service not running" and pairing states — parsing the reply with the
    // same strict schema the handler validated it against.
    const health = await new HttpClient({ baseUrl: started.value.url }).health();
    if (isErr(health)) {
      expect.unreachable(
        `HttpClient.health() failed: ${health.error.code}: ${health.error.message}`,
      );
    }
    expect(isOk(health)).toBe(true);
    if (isOk(health)) {
      expect(health.value).toStrictEqual({
        version: manifestVersion(),
        protocolVersion: PROTOCOL_VERSION,
        pairingAvailable: false,
      });
    }
  });

  it('answers 500 rather than send a health body the protocol schema refuses', async () => {
    const { stateRoot } = makeStateRoot();
    const records: string[] = [];
    const started = await startService({
      env: {},
      overrides: { debuggenHome: stateRoot, port: 0 },
      loggerOptions: {
        level: 'error',
        destination: {
          write(record: string): void {
            records.push(record);
          },
        },
      },
    });
    expect(isOk(started)).toBe(true);
    if (!isOk(started)) {
      return;
    }
    handles.push(started.value);

    const refusal = 'Invalid health response body: version (too_small)';
    vi.mocked(parseHttpResponse).mockReturnValueOnce(
      err(new DebuggenError('PROTOCOL_INVALID_MESSAGE', refusal)),
    );

    const response = await fetch(`${started.value.url}/health`);
    expect(response.status).toBe(500);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ code: 'INTERNAL' });
    // The refusal is logged with its code and reason and is not reflected.
    expect(JSON.stringify(body)).not.toContain(refusal);
    const logged = records.join('');
    expect(logged).toContain('PROTOCOL_INVALID_MESSAGE');
    expect(logged).toContain(refusal);

    // The substitution was for one call: the next request is validated for real.
    const recovered = await fetch(`${started.value.url}/health`);
    expect(recovered.status).toBe(200);
    expect(healthResponseSchema.safeParse(await recovered.json()).success).toBe(true);
  });

  it('refuses a web origin and admits the two extension origins', async () => {
    const { stateRoot } = makeStateRoot();
    const started = await start(stateRoot);
    expect(isOk(started)).toBe(true);
    if (!isOk(started)) {
      return;
    }
    const url = `${started.value.url}/health`;

    for (const origin of ['http://evil.example', 'https://evil.example', 'null']) {
      const refused = await fetch(url, { headers: { Origin: origin } });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'FORBIDDEN_ORIGIN' });
    }

    for (const origin of [
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      'vscode-webview://x',
    ]) {
      const allowed = await fetch(url, { headers: { Origin: origin } });
      expect(allowed.status).toBe(200);
    }
  });

  it('closes once however often close() is called, and stops answering', async () => {
    const { stateRoot } = makeStateRoot();
    const started = await start(stateRoot);
    expect(isOk(started)).toBe(true);
    if (!isOk(started)) {
      return;
    }
    const handle = started.value;
    const url = `${handle.url}/health`;

    await Promise.all([handle.close(), handle.close()]);
    await handle.close();

    await expect(fetch(url)).rejects.toThrow();

    // The truncating checkpoint ran, so the sidecars are folded back into the
    // one file a developer can copy or delete.
    const databasePath = join(stateRoot, SESSIONS_DATABASE_FILE_NAME);
    expect(lstatSync(databasePath).isFile()).toBe(true);
    expect(() => lstatSync(`${databasePath}-wal`)).toThrow();
  });
});

describe('servesPairingFlow — the pairingAvailable derivation', () => {
  it('is false for an application that registers no pairing route', () => {
    const app = new Hono();
    app.get('/health', answer);
    expect(servesPairingFlow(app)).toBe(false);
  });

  it('is true once both pairing operations have a handler at their protocol method and path', () => {
    const app = new Hono();
    app.post('/pair/start', answer);
    app.post('/pair/complete', answer);
    expect(servesPairingFlow(app)).toBe(true);
  });

  it('is false while only one half of the flow is served', () => {
    const onlyStart = new Hono();
    onlyStart.post('/pair/start', answer);
    expect(servesPairingFlow(onlyStart)).toBe(false);

    const onlyComplete = new Hono();
    onlyComplete.post('/pair/complete', answer);
    expect(servesPairingFlow(onlyComplete)).toBe(false);
  });

  it('does not count a handler under another method, nor middleware at the path', () => {
    const wrongMethod = new Hono();
    wrongMethod.get('/pair/start', answer);
    wrongMethod.get('/pair/complete', answer);
    expect(servesPairingFlow(wrongMethod)).toBe(false);

    // `use` registers under the method `ALL`: middleware that passes a request
    // on, not a handler that answers it.
    const middlewareOnly = new Hono();
    middlewareOnly.use('/pair/start', async (_c, next) => {
      await next();
    });
    middlewareOnly.use('/pair/complete', async (_c, next) => {
      await next();
    });
    expect(servesPairingFlow(middlewareOnly)).toBe(false);
  });

  it('matches the full path of routes mounted under a base path', () => {
    const pairing = new Hono();
    pairing.post('/start', answer);
    pairing.post('/complete', answer);
    const app = new Hono();
    app.route('/pair', pairing);
    expect(servesPairingFlow(app)).toBe(true);
  });
});
