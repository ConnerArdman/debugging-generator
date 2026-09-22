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
 * only other check of those is the Playwright `webServer` block, which runs in
 * the end-to-end job rather than in `pnpm test`.
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

import { afterEach, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '@debuggen/protocol';
import { isErr, isOk } from '@debuggen/shared';

import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startService, type ServiceHandle } from './main.js';
import { SESSIONS_DATABASE_FILE_NAME } from './config.js';

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
      expect(db.prepare('PRAGMA user_version').get()?.['user_version']).toBe(1);
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
  it('answers the unauthenticated health route with the protocol version and nothing else', async () => {
    const { stateRoot } = makeStateRoot();
    const started = await start(stateRoot);
    expect(isOk(started)).toBe(true);
    if (!isOk(started)) {
      return;
    }

    const response = await fetch(`${started.value.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', protocolVersion: PROTOCOL_VERSION });
    // No CORS header is ever set, so a web page cannot read a response even if
    // one were answered to it (AAP 0.5.6).
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
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
