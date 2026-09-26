/**
 * `fixture-lifecycle` — the browser suite's own lifecycle helpers, exercised
 * without a browser.
 *
 * `tests/browser/fixtures.ts` serves the fixture app from a private per-worker
 * copy, decides who serves the fixture origin before anything is launched, and
 * turns every teardown problem into a failure. This file proves those
 * decisions on the pure helpers the module exports:
 *
 * - `allocateFixtureBoundary` / `removeFixtureBoundary` — a fresh, canonical,
 *   `0700`, uid-owned `mkdtemp` boundary per call, removed and verified gone;
 * - `copyFixtureTree` — the tracked fixture copied byte for byte with no link
 *   and no generated entry, and every **planted symbolic link** refused with its
 *   sentinel target left byte-for-byte untouched: a linked directory inside the
 *   target, a linked file at a path the copy writes, a linked target root, and
 *   a link inside the source tree — each also planted through the copy's
 *   `afterPin` seam, after the parent was pinned and before the create; and a
 *   **directory swapped for a link** in that same window (`<target>/app` moved
 *   aside and replaced by a link to an outside directory, before a file write
 *   and before a directory creation below it) writes nothing outside: the
 *   entry lands in the pinned inode and the copy is refused;
 * - `planFixtureServing` — every combination of what answers the configured
 *   origin (`none`, `fixture`, `foreign`) and whether the service has the
 *   launcher routes (`unknown`, `present`, `missing`): a free origin is served
 *   itself, an occupied one never — the copy goes to an alternate origin of
 *   this worker's own — and the action is always probe, launch or spawn
 *   (`tests/browser/fixture-serving.spec.ts` drives both paths for real);
 * - `identifyFixtureOrigin` / `waitForFixtureApp` / `describeMediaType` —
 *   every diagnostic built from a server's answer names only its status, its
 *   media type and whether the ping honoured the fixture contract: a random
 *   secret in a `node:http` server's bodies, an `x-api-token` header and its
 *   `Content-Type` parameters never appears in an identity or an error;
 * - `settleTestTeardown` — a teardown problem fails a passing test and
 *   annotates an already failing one, bounded either way.
 *
 * `test` and `expect` come from `@playwright/test` directly, NOT from
 * `./fixtures`: that module's automatic `_hygiene` fixture depends on the
 * worker-scoped Chromium harness, so importing its `test` would launch the
 * browser (and the fixture app) for checks that need neither. Only the pure
 * helpers are imported from it. Every temporary directory created here is
 * removed after each test.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { renameSync, symlinkSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  allocateFixtureBoundary,
  copyFixtureTree,
  describeMediaType,
  identifyFixtureOrigin,
  planFixtureServing,
  removeFixtureBoundary,
  settleTestTeardown,
  waitForFixtureApp,
} from './fixtures';
import type { FixtureOriginIdentity, LauncherRoutes, TeardownTestInfo } from './fixtures';

/** Repository root, from this file's own location. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The tracked fixture app, relative to the repository root (POSIX, as `git ls-files` prints it). */
const FIXTURE_RELATIVE_ROOT = 'tests/fixtures/sample-next-app';

/** The tracked fixture app. */
const FIXTURE_SOURCE_ROOT = path.join(REPO_ROOT, ...FIXTURE_RELATIVE_ROOT.split('/'));

/** The copy's directory name inside a boundary, as `prepareFixtureAppCopy` uses it. */
const COPY_DIR_NAME = 'sample-next-app';

/** The prefix `allocateFixtureBoundary` names its directories with. */
const BOUNDARY_PREFIX = 'debuggen-browser-fixture-';

/** Entries the copy must never carry, whatever the source holds. */
const GENERATED_ENTRIES = ['node_modules', '.next', 'next-env.d.ts', 'app.tsbuildinfo'];

/** Directories this file created and removes after each test. */
const scratch: string[] = [];
/** Boundaries this file allocated and removes (verified) after each test. */
const boundaries: string[] = [];

test.afterEach(async () => {
  const failures: string[] = [];
  for (const boundary of boundaries.splice(0)) {
    try {
      await removeFixtureBoundary(boundary);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
    await expect(lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(failures).toEqual([]);
});

/** A scratch directory outside any boundary, removed after the test. */
async function scratchDir(label: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), `debuggen-lifecycle-${label}-`)));
  scratch.push(dir);
  return dir;
}

/** A boundary allocated through the module under test, removed after the test. */
async function boundary(): Promise<string> {
  const allocated = await allocateFixtureBoundary();
  boundaries.push(allocated);
  return allocated;
}

/** Every entry below `root`, relative and POSIX, with its kind, from `lstat`. */
async function walk(
  root: string,
): Promise<Map<string, 'file' | 'directory' | 'symlink' | 'other'>> {
  const found = new Map<string, 'file' | 'directory' | 'symlink' | 'other'>();
  const visit = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        found.set(relative, 'symlink');
      } else if (entry.isDirectory()) {
        found.set(relative, 'directory');
        await visit(path.join(dir, entry.name), relative);
      } else {
        found.set(relative, entry.isFile() ? 'file' : 'other');
      }
    }
  };
  await visit(root, '');
  return found;
}

/** A byte-for-byte snapshot of every entry below `root`, for "left untouched" assertions. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [relative, kind] of await walk(root)) {
    result[relative] =
      kind === 'file'
        ? `file:${(await readFile(path.join(root, ...relative.split('/')))).toString('base64')}`
        : kind;
  }
  return result;
}

/** A sentinel tree outside every boundary: a directory with one file, and a lone file. */
async function sentinel(): Promise<{
  readonly root: string;
  readonly dir: string;
  readonly file: string;
  readonly before: Record<string, string>;
}> {
  const root = await scratchDir('sentinel');
  const dir = path.join(root, 'sentinel-dir');
  const file = path.join(root, 'sentinel-file.txt');
  await mkdir(dir);
  await writeFile(path.join(dir, 'keep.txt'), 'sentinel directory content\n');
  await writeFile(file, 'sentinel file content\n');
  return { root, dir, file, before: await snapshot(root) };
}

/**
 * How a promise settled, so a spec can assert what reached the disk before it
 * asserts how the operation reported it.
 */
async function settle(
  promise: Promise<unknown>,
): Promise<{ readonly rejected: boolean; readonly message: string }> {
  try {
    await promise;
    return { rejected: false, message: '' };
  } catch (error) {
    return { rejected: true, message: error instanceof Error ? error.message : String(error) };
  }
}

/** The fixture files `git` tracks, relative to the fixture root. */
function trackedFixtureFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--', FIXTURE_RELATIVE_ROOT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return output
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => path.posix.relative(FIXTURE_RELATIVE_ROOT, entry))
    .sort();
}

test.describe('private fixture boundary', () => {
  test('each allocation is a fresh, canonical, 0700 directory owned by this account', async () => {
    const first = await boundary();
    const second = await boundary();
    expect(first).not.toBe(second);
    const tmp = await realpath(os.tmpdir());
    for (const allocated of [first, second]) {
      expect(path.isAbsolute(allocated)).toBe(true);
      expect(await realpath(allocated)).toBe(allocated);
      expect(path.dirname(allocated)).toBe(tmp);
      expect(path.basename(allocated).startsWith(BOUNDARY_PREFIX)).toBe(true);
      const stats = await lstat(allocated);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o700);
      if (typeof process.getuid === 'function') {
        expect(stats.uid).toBe(process.getuid());
      }
    }
  });

  test('removal deletes the whole boundary, verifies it, and refuses any other path', async () => {
    const allocated = await allocateFixtureBoundary();
    await writeFile(path.join(allocated, 'leftover.txt'), 'left behind by a run\n');
    await removeFixtureBoundary(allocated);
    await expect(lstat(allocated)).rejects.toMatchObject({ code: 'ENOENT' });

    const other = await sentinel();
    await expect(removeFixtureBoundary(other.root)).rejects.toThrow(/refuses/);
    expect(await snapshot(other.root)).toEqual(other.before);
  });
});

test.describe('copyFixtureTree', () => {
  test('copies every tracked fixture file byte for byte, with no link and no generated entry', async () => {
    const tracked = trackedFixtureFiles();
    expect(tracked).toContain('app/page.tsx');
    expect(tracked).toContain('package.json');

    const owner = await boundary();
    const target = path.join(owner, COPY_DIR_NAME);
    await copyFixtureTree(FIXTURE_SOURCE_ROOT, target, owner);

    const entries = await walk(target);
    const files = [...entries].filter(([, kind]) => kind === 'file').map(([name]) => name);
    // The root manifest is written separately, from the rewritten `copyManifest()`.
    expect(files.sort()).toEqual(tracked.filter((name) => name !== 'package.json'));
    expect([...entries.values()].filter((kind) => kind === 'symlink' || kind === 'other')).toEqual(
      [],
    );
    for (const name of files) {
      const copied = await readFile(path.join(target, ...name.split('/')));
      const original = await readFile(path.join(FIXTURE_SOURCE_ROOT, ...name.split('/')));
      expect(copied.equals(original), `${name} is byte-identical`).toBe(true);
    }
    for (const [name, kind] of entries) {
      const mode = (await lstat(path.join(target, ...name.split('/')))).mode;
      expect(mode & 0o077, `${name} (${kind}) grants no group or other access`).toBe(0);
    }
    for (const generated of GENERATED_ENTRIES) {
      expect(entries.has(generated)).toBe(false);
    }
  });

  test('skips generated entries at any depth and only the root package.json', async () => {
    const source = await scratchDir('source');
    await mkdir(path.join(source, 'node_modules', 'next'), { recursive: true });
    await writeFile(path.join(source, 'node_modules', 'next', 'package.json'), '{}\n');
    await mkdir(path.join(source, '.next'));
    await writeFile(path.join(source, '.next', 'build-manifest.json'), '{}\n');
    await writeFile(path.join(source, 'next-env.d.ts'), '// generated\n');
    await writeFile(path.join(source, 'app.tsbuildinfo'), '{}\n');
    await writeFile(path.join(source, 'package.json'), '{"name":"root"}\n');
    await mkdir(path.join(source, 'packages', 'inner', '.next'), { recursive: true });
    await writeFile(path.join(source, 'packages', 'inner', 'package.json'), '{"name":"inner"}\n');
    await writeFile(path.join(source, 'packages', 'inner', 'index.ts'), 'export {};\n');

    const owner = await boundary();
    const target = path.join(owner, COPY_DIR_NAME);
    await copyFixtureTree(source, target, owner);

    expect([...(await walk(target))].sort()).toEqual([
      ['packages', 'directory'],
      ['packages/inner', 'directory'],
      ['packages/inner/index.ts', 'file'],
      ['packages/inner/package.json', 'file'],
    ]);
  });

  test('refuses a symbolic link planted at a directory the copy creates', async () => {
    const guard = await sentinel();
    const owner = await boundary();
    const target = path.join(owner, COPY_DIR_NAME);
    await mkdir(target, { mode: 0o700 });
    await symlink(guard.dir, path.join(target, 'app'));

    await expect(copyFixtureTree(FIXTURE_SOURCE_ROOT, target, owner)).rejects.toThrow();
    expect(await snapshot(guard.root)).toEqual(guard.before);
  });

  test('refuses a symbolic link planted at a file path the copy writes', async () => {
    const guard = await sentinel();
    const owner = await boundary();
    const target = path.join(owner, COPY_DIR_NAME);
    await mkdir(target, { mode: 0o700 });
    await symlink(guard.file, path.join(target, 'tsconfig.json'));

    await expect(copyFixtureTree(FIXTURE_SOURCE_ROOT, target, owner)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await snapshot(guard.root)).toEqual(guard.before);
  });

  test('refuses a target root that is a symbolic link', async () => {
    const guard = await sentinel();
    const owner = await boundary();
    const target = path.join(owner, COPY_DIR_NAME);
    await symlink(guard.dir, target);

    await expect(copyFixtureTree(FIXTURE_SOURCE_ROOT, target, owner)).rejects.toThrow();
    expect(await snapshot(guard.root)).toEqual(guard.before);
  });

  test('refuses a source tree that contains a symbolic link', async () => {
    const guard = await sentinel();
    const source = await scratchDir('source');
    await writeFile(path.join(source, 'page.tsx'), 'export default function Page() {}\n');
    await mkdir(path.join(source, 'src'));
    await symlink(guard.file, path.join(source, 'src', 'linked.ts'));

    const owner = await boundary();
    const target = path.join(owner, COPY_DIR_NAME);
    await expect(copyFixtureTree(source, target, owner)).rejects.toThrow(/symbolic link/);
    expect(await snapshot(guard.root)).toEqual(guard.before);
    expect([...(await walk(target))].some(([name]) => name.endsWith('linked.ts'))).toBe(false);
  });

  test('pins the parent of every entry, the root first, before creating it', async () => {
    const owner = await boundary();
    const target = path.join(owner, COPY_DIR_NAME);
    const pinned: string[] = [];
    await copyFixtureTree(FIXTURE_SOURCE_ROOT, target, owner, {
      afterPin: (relativePath, kind) => {
        pinned.push(`${kind}:${relativePath}`);
      },
    });
    expect(pinned[0]).toBe('directory:.');
    const expected = [...(await walk(target))].map(
      ([name, kind]) => `${kind === 'directory' ? 'directory' : 'file'}:${name}`,
    );
    expect(pinned.slice(1).sort()).toEqual(expected.sort());
  });

  test('refuses a symbolic link planted, after the pin, where the copy creates a directory', async () => {
    const guard = await sentinel();
    const owner = await boundary();
    const target = path.join(owner, COPY_DIR_NAME);
    await expect(
      copyFixtureTree(FIXTURE_SOURCE_ROOT, target, owner, {
        afterPin: (relativePath) => {
          if (relativePath === 'app') {
            symlinkSync(guard.dir, path.join(target, 'app'));
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await snapshot(guard.root)).toEqual(guard.before);
  });

  test('refuses a symbolic link planted, after the pin, where the copy writes a file', async () => {
    const guard = await sentinel();
    const owner = await boundary();
    const target = path.join(owner, COPY_DIR_NAME);
    await expect(
      copyFixtureTree(FIXTURE_SOURCE_ROOT, target, owner, {
        afterPin: (relativePath) => {
          if (relativePath === 'tsconfig.json') {
            symlinkSync(guard.file, path.join(target, 'tsconfig.json'));
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await snapshot(guard.root)).toEqual(guard.before);
  });

  /**
   * Between the pin and the create: move `<target>/app` aside (inside the
   * boundary) and put a link to an outside directory in its place — the swap
   * a path-based copy follows. Returns what the assertions need.
   */
  async function swapAppDirectory(
    owner: string,
    target: string,
  ): Promise<{
    readonly outside: string;
    readonly moved: string;
    readonly guard: Awaited<ReturnType<typeof sentinel>>;
    readonly swap: () => void;
  }> {
    const guard = await sentinel();
    const outside = path.join(guard.root, 'outside');
    await mkdir(outside);
    const before = await snapshot(guard.root);
    const moved = path.join(owner, 'app-moved');
    return {
      outside,
      moved,
      guard: { ...guard, before },
      swap: () => {
        renameSync(path.join(target, 'app'), moved);
        symlinkSync(outside, path.join(target, 'app'));
      },
    };
  }

  test('a directory swapped for a link between the pin and a file write receives nothing outside', async () => {
    const owner = await boundary();
    const target = path.join(owner, COPY_DIR_NAME);
    const attack = await swapAppDirectory(owner, target);
    let written: string | undefined;
    const outcome = await settle(
      copyFixtureTree(FIXTURE_SOURCE_ROOT, target, owner, {
        afterPin: (relativePath, kind) => {
          if (written === undefined && kind === 'file' && /^app\/[^/]+$/.test(relativePath)) {
            written = relativePath;
            attack.swap();
          }
        },
      }),
    );
    expect(written).toBeDefined();
    // Nothing reached the outside directory, whatever the copy reported.
    expect(await readdir(attack.outside)).toEqual([]);
    expect(await snapshot(attack.guard.root)).toEqual(attack.guard.before);
    expect(outcome.rejected).toBe(true);
    expect(outcome.message).toMatch(/moved or replaced/);
    // The write landed in the pinned directory inode, which now sits at app-moved.
    const name = path.posix.basename(written ?? '');
    expect((await lstat(path.join(attack.moved, name))).isFile()).toBe(true);
  });

  test('a directory swapped for a link between the pin and a directory creation receives nothing outside', async () => {
    const owner = await boundary();
    const target = path.join(owner, COPY_DIR_NAME);
    const attack = await swapAppDirectory(owner, target);
    let swapped = false;
    const outcome = await settle(
      copyFixtureTree(FIXTURE_SOURCE_ROOT, target, owner, {
        afterPin: (relativePath, kind) => {
          if (kind === 'directory' && relativePath === 'app/api') {
            swapped = true;
            attack.swap();
          }
        },
      }),
    );
    expect(swapped).toBe(true);
    // Nothing reached the outside directory, whatever the copy reported.
    expect(await readdir(attack.outside)).toEqual([]);
    expect(await snapshot(attack.guard.root)).toEqual(attack.guard.before);
    expect(outcome.rejected).toBe(true);
    expect(outcome.message).toMatch(/moved or replaced/);
    // The directory was created in the pinned inode, which now sits at app-moved.
    expect((await lstat(path.join(attack.moved, 'api'))).isDirectory()).toBe(true);
  });

  test('refuses a target outside its boundary', async () => {
    const owner = await boundary();
    const elsewhere = await scratchDir('elsewhere');
    await expect(
      copyFixtureTree(FIXTURE_SOURCE_ROOT, path.join(elsewhere, COPY_DIR_NAME), owner),
    ).rejects.toThrow(/does not lie inside its boundary/);
    await expect(copyFixtureTree(FIXTURE_SOURCE_ROOT, owner, owner)).rejects.toThrow(
      /does not lie inside its boundary/,
    );
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await readdir(owner)).toEqual([]);
  });
});

test.describe('planFixtureServing', () => {
  const none: FixtureOriginIdentity = { kind: 'none' };
  const fixture: FixtureOriginIdentity = {
    kind: 'fixture',
    description:
      'GET / answered 200 (text/html); GET /api/ping answered 200 (application/json), which honours the fixture contract { reply: string }',
  };
  const foreign: FixtureOriginIdentity = {
    kind: 'foreign',
    description:
      'GET / answered 200 (text/html); GET /api/ping answered 404 (text/html), which does not honour the fixture contract { reply: string }',
  };
  const routes: readonly LauncherRoutes[] = ['unknown', 'present', 'missing'];
  /** The action each launcher-route state leads to, whatever the target. */
  const actionFor = {
    unknown: { action: 'probe-launcher-routes' },
    present: { action: 'launch', servedBy: 'service-launcher' },
    missing: { action: 'spawn', servedBy: 'fixture-process' },
  } as const;

  test('a free configured origin is served itself: routes probed, then launch, or spawn without a launcher', () => {
    for (const launcherRoutes of routes) {
      expect(planFixtureServing(none, launcherRoutes), launcherRoutes).toEqual({
        target: { origin: 'configured' },
        ...actionFor[launcherRoutes],
      });
    }
  });

  test('an origin a fixture app occupies is never reused: the copy is served on an alternate origin', () => {
    for (const launcherRoutes of routes) {
      expect(planFixtureServing(fixture, launcherRoutes), launcherRoutes).toEqual({
        target: { origin: 'alternate', occupant: 'fixture' },
        ...actionFor[launcherRoutes],
      });
    }
  });

  test('an origin a foreign server occupies is never touched: the copy is served on an alternate origin', () => {
    for (const launcherRoutes of routes) {
      expect(planFixtureServing(foreign, launcherRoutes), launcherRoutes).toEqual({
        target: { origin: 'alternate', occupant: 'foreign' },
        ...actionFor[launcherRoutes],
      });
    }
  });
});

/** A `node:http` server on a free loopback port answering every request with `respond(url)`. */
async function serve(
  respond: (url: string) => {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const answer = respond(request.url ?? '');
    response.writeHead(answer.status, answer.headers);
    response.end(answer.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}

test.describe('body-free diagnostics', () => {
  /** A fresh 48-character secret per test, so a match can only come from the server's answer. */
  const secret = (): string => randomBytes(24).toString('hex');

  test('describeMediaType prints only a well-formed media type, never its parameters', () => {
    const token = secret();
    expect(describeMediaType('Text/HTML; charset=utf-8')).toBe('text/html');
    expect(describeMediaType('application/json')).toBe('application/json');
    expect(describeMediaType(`text/html; charset=utf-8; token=${token}`)).toBe('text/html');
    expect(describeMediaType(null)).toBe('no content type');
    expect(describeMediaType('  ')).toBe('no content type');
    expect(describeMediaType('not a media type')).toBe('an unrecognised content type');
    expect(describeMediaType(`text/<p>${token}</p>`)).toBe('an unrecognised content type');
    expect(describeMediaType(`application/${'x'.repeat(100)}`)).toBe(
      'an unrecognised content type',
    );
  });

  test('a foreign answer carrying a secret in its bodies, a header and its Content-Type parameters is never quoted', async () => {
    const token = secret();
    const foreign = await serve((url) => ({
      status: 200,
      headers: {
        'content-type':
          url === '/api/ping'
            ? `application/json; token=${token}`
            : `text/html; charset=utf-8; token=${token}`,
        'x-api-token': token,
      },
      body:
        url === '/api/ping'
          ? JSON.stringify({ error: `invalid credential ${token}` })
          : `<!doctype html><pre>API_TOKEN=${token}</pre>`,
    }));
    try {
      const identity = await identifyFixtureOrigin(foreign.origin);
      expect(identity.kind).toBe('foreign');
      const description = identity.kind === 'none' ? '' : identity.description;
      expect(description).toBe(
        'GET / answered 200 (text/html); GET /api/ping answered 200 (application/json), which does not honour the fixture contract { reply: string }',
      );
      expect(description).not.toContain(token);

      // The same origin as the one a worker serves on: `/` answers 200, the ping breaks the contract.
      const waited = await settle(waitForFixtureApp(foreign.origin, () => 'no child output'));
      expect(waited.rejected).toBe(true);
      expect(waited.message).toContain(
        'GET /api/ping answered 200 (application/json), which does not honour the fixture contract',
      );
      expect(waited.message).not.toContain(token);
    } finally {
      await foreign.close();
    }
  });

  test('a failing foreign ping is described by status and media type alone', async () => {
    const token = secret();
    const foreign = await serve((url) => ({
      status: url === '/api/ping' ? 500 : 200,
      headers: { 'content-type': `text/plain; secret=${token}`, 'x-api-token': token },
      body: `stack trace mentioning ${token}`,
    }));
    try {
      const identity = await identifyFixtureOrigin(foreign.origin);
      expect(identity).toEqual({
        kind: 'foreign',
        description:
          'GET / answered 200 (text/plain); GET /api/ping answered 500 (text/plain), which does not honour the fixture contract { reply: string }',
      });
      const waited = await settle(waitForFixtureApp(foreign.origin, () => 'no child output'));
      expect(waited.message).toContain('GET /api/ping answered 500 (text/plain)');
      expect(waited.message).not.toContain(token);
    } finally {
      await foreign.close();
    }
  });

  test('a server honouring the contract is the fixture, described the same body-free way', async () => {
    const token = secret();
    const fixture = await serve((url) => ({
      status: 200,
      headers: {
        'content-type': url === '/api/ping' ? 'application/json' : 'text/html; charset=utf-8',
        'x-api-token': token,
      },
      body: url === '/api/ping' ? JSON.stringify({ reply: token }) : `<p>${token}</p>`,
    }));
    try {
      expect(await identifyFixtureOrigin(fixture.origin)).toEqual({
        kind: 'fixture',
        description:
          'GET / answered 200 (text/html); GET /api/ping answered 200 (application/json), which honours the fixture contract { reply: string }',
      });
      await expect(waitForFixtureApp(fixture.origin, () => '')).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  test('an origin nothing listens on is none, with no request answered', async () => {
    const vacated = await serve(() => ({ status: 200, headers: {}, body: '' }));
    await vacated.close();
    expect(await identifyFixtureOrigin(vacated.origin)).toEqual({ kind: 'none' });
  });
});

test.describe('settleTestTeardown', () => {
  const info = (status: NonNullable<TeardownTestInfo['status']>): TeardownTestInfo => ({
    status,
    expectedStatus: 'passed',
    annotations: [],
  });

  test('does nothing when teardown found no problem', () => {
    const passed = info('passed');
    expect(() => {
      settleTestTeardown(passed, 'sessions', []);
    }).not.toThrow();
    expect(passed.annotations).toEqual([]);
  });

  test('fails a test that passed, listing every problem', () => {
    const passed = info('passed');
    expect(() => {
      settleTestTeardown(passed, 'sessions', [
        'session a ended with cleanup "partial"',
        'session b could not be ended in teardown',
      ]);
    }).toThrow(/sessions teardown found 2 problem\(s\):\n- session a .*\n- session b/);
    expect(passed.annotations).toEqual([]);
  });

  test('annotates a test that already failed instead of masking its error', () => {
    const failed = info('failed');
    expect(() => {
      settleTestTeardown(failed, 'openPanelPage', ['closing a panel page failed']);
    }).not.toThrow();
    expect(failed.annotations).toEqual([
      { type: 'fixture-teardown', description: 'openPanelPage: closing a panel page failed' },
    ]);
  });

  test('keeps the report bounded', () => {
    const many = Array.from({ length: 25 }, (_, index) => `problem ${String(index)}`);
    const failed = info('failed');
    settleTestTeardown(failed, 'appPage', many);
    expect(failed.annotations).toHaveLength(21);
    expect(failed.annotations.at(-1)?.description).toBe('appPage: (+5 more problem(s))');

    const passed = info('passed');
    let message = '';
    try {
      settleTestTeardown(passed, 'appPage', ['y'.repeat(50_000), ...many]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('(+6 more)');
    expect(message).toContain('more characters]');
    expect(message.length).toBeLessThan(5_000);
  });
});
