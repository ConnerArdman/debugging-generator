/**
 * Tests for `./cache.ts`: the key derivation, and the promise that every
 * problem is a miss.
 *
 * Two things are on trial, and they fail in different ways.
 *
 * The **key** is where invalidation lives. Nothing is compared field by field
 * at read time, so if the key is insensitive to something it should notice — a
 * file's modification time, its size, a file appearing, a different TypeScript
 * configuration, a different indexer version — the cache serves a stale index
 * and every later answer in the session is wrong about the tree on disk. The
 * assertions are therefore paired: each input that must change the key has a
 * case, and the one thing that must *not* change it — the order the caller
 * happened to hold the file list in — has one too.
 *
 * The **miss contract** is a negative guarantee, which is why these cases plant
 * damage rather than mock it. A corrupt entry is written as real bytes, a
 * wrong-version envelope as real JSON, a symbolic link as a real link, and each
 * case asserts both halves of the outcome: `load` answered `undefined`, and the
 * offending file is *gone*, because an entry that is rejected but left in place
 * is re-read on every run for as long as it sits there. `load` is never allowed
 * to reject for any of them — the only rejection the module admits is a
 * malformed key, which is a programmer error and is asserted as one.
 *
 * Three habits here are deliberate.
 *
 * 1. **Every filesystem assertion runs in an `mkdtemp` sandbox**, resolved
 *    through `realpath` so a temporary directory reached through a link does
 *    not trip the hardened creators' link policy. Nothing touches the
 *    repository, the fixture corpus or a real `~/.debuggen`: the state root is
 *    injected in every case, and the two cases that must exercise the
 *    environment fallback save and restore `DEBUGGEN_HOME` themselves.
 * 2. **Permissions are asserted, not assumed.** `0700` on the directory and
 *    `0600` on the entry are the reason this module uses the hardened creators
 *    at all, and a regression to `fs.writeFile` would pass every behavioural
 *    case in this file while silently widening a directory that also holds
 *    credentials.
 * 3. **Failures are read through the module's own vocabulary** — `isErr`,
 *    `DebuggenError.is`, `error.code`, `error.details.reason` — rather than by
 *    matching message text, which is documentation and free to change.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { DebuggenError, isErr, isOk } from '@debuggen/shared';
import type { LogFields, LogLevel, Logger } from '@debuggen/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  INDEX_CACHE_SCHEMA_VERSION,
  computeIndexCacheKey,
  createIndexCache,
  isCodeIndex,
  resolveIndexCacheDir,
} from './cache.js';
import type { IndexCache, IndexCacheKeyInput } from './cache.js';
import { CODE_INDEX_SCHEMA_VERSION } from './graph/types.js';
import type { CodeEdge, CodeIndex, CodeNode, FileFingerprint } from './graph/types.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** The permission bits of a mode, which is all these tests assert about one. */
const PERMISSION_BITS = 0o777;

/** The mode the state tree's directories must carry. */
const SECURE_DIR_MODE = 0o700;

/** The mode a state file must carry. */
const SECURE_FILE_MODE = 0o600;

/** A plausible project root for a key input. Never touched on disk. */
const PROJECT_ROOT = '/home/dev/workspace/target';

/** The indexer version every fixture key is derived under. */
const INDEXER_VERSION = 'indexer/2026.09.1';

/** A fixed build time, so a round-tripped index compares equal. */
const GENERATED_AT = 1_777_000_000_000;

/** Two fingerprints in a deliberately unsorted order. */
const FINGERPRINTS: readonly FileFingerprint[] = Object.freeze([
  Object.freeze({ file: 'src/second.ts', mtimeMs: 1_776_000_000_500.25, size: 2048 }),
  Object.freeze({
    file: 'src/first.ts',
    mtimeMs: 1_776_000_000_000,
    size: 1024,
    hash: 'a'.repeat(64),
  }),
]);

/** Nodes for a minimal but structurally complete index. */
const NODES: readonly CodeNode[] = Object.freeze<CodeNode[]>([
  {
    id: 'file:src/first.ts',
    kind: 'file',
    name: 'first.ts',
    file: 'src/first.ts',
    line: 1,
    column: 1,
  },
  {
    id: 'symbol:src/first.ts#loadThings',
    kind: 'symbol',
    name: 'loadThings',
    file: 'src/first.ts',
    line: 12,
    column: 3,
    exported: true,
    data: { declaration: 'function', isDefaultExport: false },
  },
]);

/** One edge joining the two nodes above. */
const EDGES: readonly CodeEdge[] = Object.freeze<CodeEdge[]>([
  {
    id: 'declares:src/first.ts#loadThings',
    kind: 'declares',
    from: 'file:src/first.ts',
    to: 'symbol:src/first.ts#loadThings',
    file: 'src/first.ts',
    line: 12,
    column: 3,
  },
]);

/** The parts of an index a case may vary. */
interface MakeIndexOptions {
  readonly schemaVersion?: number;
  readonly projectRoot?: string;
  readonly indexerVersion?: string;
  readonly files?: readonly FileFingerprint[];
}

/**
 * A structurally valid {@link CodeIndex}.
 *
 * Built field by field rather than by spreading a partial, because
 * `exactOptionalPropertyTypes` makes "present and undefined" a different thing
 * from "absent" and an index is required to be plain JSON with no
 * present-but-undefined field anywhere in it.
 */
function makeIndex(options: MakeIndexOptions = {}): CodeIndex {
  return {
    schemaVersion: options.schemaVersion ?? CODE_INDEX_SCHEMA_VERSION,
    projectRoot: options.projectRoot ?? PROJECT_ROOT,
    indexerVersion: options.indexerVersion ?? INDEXER_VERSION,
    generatedAt: GENERATED_AT,
    nodes: NODES,
    edges: EDGES,
    files:
      options.files ?? [...FINGERPRINTS].sort((left, right) => (left.file < right.file ? -1 : 1)),
  };
}

/** The key input every case derives a key from unless it varies one field. */
function makeKeyInput(overrides: Partial<IndexCacheKeyInput> = {}): IndexCacheKeyInput {
  return {
    projectRoot: overrides.projectRoot ?? PROJECT_ROOT,
    tsConfigFilePath: overrides.tsConfigFilePath,
    indexerVersion: overrides.indexerVersion ?? INDEXER_VERSION,
    schemaVersion: overrides.schemaVersion,
    files: overrides.files ?? FINGERPRINTS,
  };
}

/** One line a {@link Logger} was asked to emit. */
interface RecordedLine {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * A logger that records instead of printing, so a case can assert the *reason*
 * a miss was classified with rather than only that it missed.
 */
function createRecordingLogger(): { readonly logger: Logger; readonly lines: RecordedLine[] } {
  const lines: RecordedLine[] = [];
  const record =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields: fields ?? {} });
    };

  const logger: Logger = {
    level: 'trace',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: (): Logger => logger,
  };

  return { logger, lines };
}

/** The `reason` fields of every recorded line, for a miss-classification assertion. */
function reasonsOf(lines: readonly RecordedLine[]): readonly unknown[] {
  return lines.map((line) => line.fields.reason).filter((reason) => reason !== undefined);
}

/** The value a promise rejected with, as `unknown`. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

/** The permission bits of a path, or `undefined` when it does not exist. */
function modeOf(path: string): number | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return statSync(path).mode & PERMISSION_BITS;
}

// ---------------------------------------------------------------------------
// Sandbox.
// ---------------------------------------------------------------------------

/** A fresh temporary state root per case, resolved through `realpath`. */
let stateRoot = '';

/** `<stateRoot>/index`, deliberately not created: `save` must create it. */
let cacheDir = '';

/** The cache under test, and the lines it emitted. */
let cache: IndexCache;
let lines: RecordedLine[];

beforeEach(() => {
  stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-index-cache-')));
  cacheDir = join(stateRoot, 'index');

  const recording = createRecordingLogger();
  lines = recording.lines;
  cache = createIndexCache({ cacheDir, logger: recording.logger });
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
  stateRoot = '';
  cacheDir = '';
});

/** Writes raw bytes at an entry path, creating the cache directory first. */
function writeRawEntry(key: string, contents: string): string {
  mkdirSync(cacheDir, { recursive: true, mode: SECURE_DIR_MODE });
  const path = join(cacheDir, `${key}.json`);
  writeFileSync(path, contents, { mode: SECURE_FILE_MODE });
  return path;
}

// ---------------------------------------------------------------------------
// Key derivation.
// ---------------------------------------------------------------------------

describe('computeIndexCacheKey', () => {
  it('produces 64 lowercase hexadecimal characters', () => {
    expect(computeIndexCacheKey(makeKeyInput())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same input', () => {
    expect(computeIndexCacheKey(makeKeyInput())).toBe(computeIndexCacheKey(makeKeyInput()));
  });

  it('ignores the order the fingerprints were supplied in', () => {
    const forwards = computeIndexCacheKey(makeKeyInput({ files: FINGERPRINTS }));
    const backwards = computeIndexCacheKey(makeKeyInput({ files: [...FINGERPRINTS].reverse() }));

    expect(backwards).toBe(forwards);
  });

  it('leaves the file list the caller passed untouched', () => {
    const files = [...FINGERPRINTS];
    computeIndexCacheKey(makeKeyInput({ files }));

    expect(files).toEqual([...FINGERPRINTS]);
  });

  it('changes when a modification time changes', () => {
    const [second, first] = FINGERPRINTS;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      throw new Error('The fingerprint fixture must hold two entries.');
    }

    const moved: readonly FileFingerprint[] = [second, { ...first, mtimeMs: first.mtimeMs + 1 }];

    expect(computeIndexCacheKey(makeKeyInput({ files: moved }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('changes when a size changes', () => {
    const resized = FINGERPRINTS.map((fingerprint) => ({
      ...fingerprint,
      size: fingerprint.size + 1,
    }));

    expect(computeIndexCacheKey(makeKeyInput({ files: resized }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('changes when a file is added', () => {
    const added: readonly FileFingerprint[] = [
      ...FINGERPRINTS,
      { file: 'src/third.ts', mtimeMs: 1_776_000_001_000, size: 64 },
    ];

    expect(computeIndexCacheKey(makeKeyInput({ files: added }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('changes when a content hash appears', () => {
    const hashed = FINGERPRINTS.map((fingerprint) => ({ ...fingerprint, hash: 'b'.repeat(64) }));

    expect(computeIndexCacheKey(makeKeyInput({ files: hashed }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('changes with the TypeScript configuration path', () => {
    const none = computeIndexCacheKey(makeKeyInput());
    const configured = computeIndexCacheKey(
      makeKeyInput({ tsConfigFilePath: `${PROJECT_ROOT}/tsconfig.json` }),
    );
    const other = computeIndexCacheKey(
      makeKeyInput({ tsConfigFilePath: `${PROJECT_ROOT}/tsconfig.build.json` }),
    );

    expect(configured).not.toBe(none);
    expect(other).not.toBe(configured);
  });

  it('changes with the indexer version', () => {
    expect(computeIndexCacheKey(makeKeyInput({ indexerVersion: 'indexer/next' }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('changes with the envelope schema version', () => {
    expect(
      computeIndexCacheKey(makeKeyInput({ schemaVersion: INDEX_CACHE_SCHEMA_VERSION + 1 })),
    ).not.toBe(computeIndexCacheKey(makeKeyInput()));
  });

  it('changes with the project root', () => {
    expect(computeIndexCacheKey(makeKeyInput({ projectRoot: '/home/dev/other' }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('normalises separators, so one directory has one key', () => {
    expect(computeIndexCacheKey(makeKeyInput({ projectRoot: 'C:\\work\\target' }))).toBe(
      computeIndexCacheKey(makeKeyInput({ projectRoot: 'C:/work/target' })),
    );
  });

  it('stays total when a fingerprint carries a non-finite number', () => {
    const broken: readonly FileFingerprint[] = [
      { file: 'src/first.ts', mtimeMs: Number.NaN, size: 1 },
    ];
    const infinite: readonly FileFingerprint[] = [
      { file: 'src/first.ts', mtimeMs: Number.POSITIVE_INFINITY, size: 1 },
    ];

    const brokenKey = computeIndexCacheKey(makeKeyInput({ files: broken }));

    expect(brokenKey).toMatch(/^[0-9a-f]{64}$/);
    expect(computeIndexCacheKey(makeKeyInput({ files: infinite }))).not.toBe(brokenKey);
  });
});

// ---------------------------------------------------------------------------
// Directory resolution.
// ---------------------------------------------------------------------------

describe('resolveIndexCacheDir', () => {
  const previousHome = process.env.DEBUGGEN_HOME;

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.DEBUGGEN_HOME;
      return;
    }
    process.env.DEBUGGEN_HOME = previousHome;
  });

  it('prefers the injected state root', () => {
    process.env.DEBUGGEN_HOME = '/from/environment';

    expect(resolveIndexCacheDir({ debuggenHome: '/injected/state' })).toBe('/injected/state/index');
  });

  it('falls back to DEBUGGEN_HOME', () => {
    process.env.DEBUGGEN_HOME = '/from/environment';

    expect(resolveIndexCacheDir()).toBe('/from/environment/index');
  });

  it('treats an empty value as unset', () => {
    process.env.DEBUGGEN_HOME = '';

    expect(resolveIndexCacheDir({ debuggenHome: '' })).toBe(
      join(homedir(), '.debuggen', 'index').replaceAll('\\', '/'),
    );
  });

  it('expands a leading tilde', () => {
    const expected = `${homedir().replaceAll('\\', '/')}/state/index`;

    expect(resolveIndexCacheDir({ debuggenHome: '~/state' })).toBe(expected);
    expect(resolveIndexCacheDir({ debuggenHome: '~' })).toBe(
      `${homedir().replaceAll('\\', '/')}/index`,
    );
  });

  it('normalises the result', () => {
    expect(resolveIndexCacheDir({ debuggenHome: '/state//root/./nested/..' })).toBe(
      '/state/root/index',
    );
  });
});

// ---------------------------------------------------------------------------
// Construction.
// ---------------------------------------------------------------------------

describe('createIndexCache', () => {
  it('exposes the configured directory and creates nothing', () => {
    expect(cache.cacheDir).toBe(cacheDir);
    expect(existsSync(cacheDir)).toBe(false);
  });

  it('refuses an empty cache directory', () => {
    let caught: unknown;
    try {
      createIndexCache({ cacheDir: '' });
    } catch (error: unknown) {
      caught = error;
    }

    expect(DebuggenError.is(caught)).toBe(true);
    if (!DebuggenError.is(caught)) {
      throw new Error('Expected a DebuggenError.');
    }
    expect(caught.code).toBe('CONFIG_INVALID');
  });
});

// ---------------------------------------------------------------------------
// Round trip.
// ---------------------------------------------------------------------------

describe('save and load', () => {
  it('round-trips an index through the filesystem', async () => {
    const key = computeIndexCacheKey(makeKeyInput());
    const index = makeIndex();

    const saved = await cache.save(key, index);
    expect(isOk(saved)).toBe(true);

    await expect(cache.load(key)).resolves.toEqual(index);
  });

  it('creates the cache directory 0700 and the entry 0600', async () => {
    const key = computeIndexCacheKey(makeKeyInput());

    expect(isOk(await cache.save(key, makeIndex()))).toBe(true);

    expect(modeOf(cacheDir)).toBe(SECURE_DIR_MODE);
    expect(modeOf(join(cacheDir, `${key}.json`))).toBe(SECURE_FILE_MODE);
  });

  it('recreates the cache directory when it was deleted between runs', async () => {
    const key = computeIndexCacheKey(makeKeyInput());
    expect(isOk(await cache.save(key, makeIndex()))).toBe(true);

    // What the service's retention job does to the index cache of a project
    // that has not been opened lately.
    rmSync(cacheDir, { recursive: true, force: true });
    expect(existsSync(cacheDir)).toBe(false);

    expect(isOk(await cache.save(key, makeIndex()))).toBe(true);
    expect(modeOf(cacheDir)).toBe(SECURE_DIR_MODE);
    expect(modeOf(join(cacheDir, `${key}.json`))).toBe(SECURE_FILE_MODE);
    await expect(cache.load(key)).resolves.toBeDefined();
  });

  it('tightens a cache directory that was left over-permissive', async () => {
    mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
    expect(modeOf(cacheDir)).toBe(0o755);

    const key = computeIndexCacheKey(makeKeyInput());
    expect(isOk(await cache.save(key, makeIndex()))).toBe(true);

    expect(modeOf(cacheDir)).toBe(SECURE_DIR_MODE);
  });

  it('lets the last writer win for one key', async () => {
    const key = computeIndexCacheKey(makeKeyInput());
    const first = makeIndex({ projectRoot: '/home/dev/first' });
    const second = makeIndex({ projectRoot: '/home/dev/second' });

    await cache.save(key, first);
    await cache.save(key, second);

    const loaded = await cache.load(key);
    expect(loaded?.projectRoot).toBe('/home/dev/second');
    expect(readdirSync(cacheDir)).toEqual([`${key}.json`]);
  });

  it('keys two projects independently', async () => {
    const keyA = computeIndexCacheKey(makeKeyInput());
    const keyB = computeIndexCacheKey(makeKeyInput({ indexerVersion: 'indexer/other' }));

    await cache.save(keyA, makeIndex({ projectRoot: '/home/dev/a' }));
    await cache.save(keyB, makeIndex({ projectRoot: '/home/dev/b' }));

    expect((await cache.load(keyA))?.projectRoot).toBe('/home/dev/a');
    expect((await cache.load(keyB))?.projectRoot).toBe('/home/dev/b');
  });
});

// ---------------------------------------------------------------------------
// Every problem is a miss.
// ---------------------------------------------------------------------------

describe('load misses', () => {
  const key = computeIndexCacheKey(makeKeyInput());

  it('misses when the cache directory does not exist', async () => {
    expect(existsSync(cacheDir)).toBe(false);

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('absent');
  });

  it('misses when the entry does not exist', async () => {
    mkdirSync(cacheDir, { recursive: true, mode: SECURE_DIR_MODE });

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('absent');
  });

  it('misses on unparsable JSON and removes the entry', async () => {
    const path = writeRawEntry(key, '{ "schemaVersion": 1, "index": ');

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('unparsable');
    expect(existsSync(path)).toBe(false);
  });

  it('misses on a wrong envelope schema version and removes the entry', async () => {
    const path = writeRawEntry(
      key,
      JSON.stringify({
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION + 1,
        key,
        writtenAt: GENERATED_AT,
        index: makeIndex(),
      }),
    );

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('schema-version');
    expect(existsSync(path)).toBe(false);
  });

  it('misses on a structurally invalid index and removes the entry', async () => {
    const path = writeRawEntry(
      key,
      JSON.stringify({
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
        key,
        writtenAt: GENERATED_AT,
        index: { schemaVersion: CODE_INDEX_SCHEMA_VERSION, projectRoot: PROJECT_ROOT },
      }),
    );

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('malformed-index');
    expect(existsSync(path)).toBe(false);
  });

  it('misses on a document that is not an envelope at all', async () => {
    const path = writeRawEntry(key, JSON.stringify([1, 2, 3]));

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('malformed');
    expect(existsSync(path)).toBe(false);
  });

  it('misses when the envelope names another key', async () => {
    const otherKey = computeIndexCacheKey(makeKeyInput({ indexerVersion: 'indexer/other' }));
    const path = writeRawEntry(
      key,
      JSON.stringify({
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
        key: otherKey,
        writtenAt: GENERATED_AT,
        index: makeIndex(),
      }),
    );

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('key-mismatch');
    expect(existsSync(path)).toBe(false);
  });

  it('misses when the graph vocabulary has moved on', async () => {
    const path = writeRawEntry(
      key,
      JSON.stringify({
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
        key,
        writtenAt: GENERATED_AT,
        index: makeIndex({ schemaVersion: CODE_INDEX_SCHEMA_VERSION + 1 }),
      }),
    );

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('stale-vocabulary');
    expect(existsSync(path)).toBe(false);
  });

  it('misses rather than following a symbolic link planted at the entry path', async () => {
    const secret = join(stateRoot, 'elsewhere.json');
    writeFileSync(
      secret,
      JSON.stringify({
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
        key,
        writtenAt: GENERATED_AT,
        index: makeIndex(),
      }),
      { mode: SECURE_FILE_MODE },
    );

    mkdirSync(cacheDir, { recursive: true, mode: SECURE_DIR_MODE });
    const link = join(cacheDir, `${key}.json`);
    symlinkSync(secret, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    // A miss, not a throw, and not a read of the link's target.
    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('unreadable');

    // The link is removed; what it pointed at is not.
    expect(existsSync(link)).toBe(false);
    expect(existsSync(secret)).toBe(true);
  });

  it('misses when the entry path is a directory', async () => {
    mkdirSync(join(cacheDir, `${key}.json`), { recursive: true, mode: SECURE_DIR_MODE });

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('unreadable');
  });
});

// ---------------------------------------------------------------------------
// Write failures are values, not exceptions.
// ---------------------------------------------------------------------------

describe('save failures', () => {
  it('reports an Err when the cache directory cannot be created', async () => {
    // A regular file occupies the directory's path, so the directory cannot be
    // created at all — the kind of failure that must never escape as a throw.
    writeFileSync(cacheDir, 'not a directory', { mode: SECURE_FILE_MODE });

    const result = await cache.save(computeIndexCacheKey(makeKeyInput()), makeIndex());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) {
      throw new Error('Expected an Err.');
    }
    expect(result.error.code).toBe('CODE_INDEX_FAILED');
    expect(result.error.details?.reason).toBe('cache-write-failed');
    expect(result.error.hint).toBeDefined();
  });

  it('refuses a cache directory reached through a symbolic link', async () => {
    const real = join(stateRoot, 'real-index');
    mkdirSync(real, { mode: SECURE_DIR_MODE });
    symlinkSync(real, cacheDir);

    const result = await cache.save(computeIndexCacheKey(makeKeyInput()), makeIndex());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) {
      throw new Error('Expected an Err.');
    }
    // The policy failure keeps its own code rather than being flattened into a
    // generic write failure: a state directory reached through a link is a
    // different problem from a full disk.
    expect(result.error.code).toBe('FS_UNSAFE_PATH');
    // Nothing was written through the link.
    expect(readdirSync(real)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Eviction and clearing.
// ---------------------------------------------------------------------------

describe('evict and clear', () => {
  it('evicts an entry and is idempotent', async () => {
    const key = computeIndexCacheKey(makeKeyInput());
    await cache.save(key, makeIndex());
    expect(existsSync(join(cacheDir, `${key}.json`))).toBe(true);

    await cache.evict(key);
    expect(existsSync(join(cacheDir, `${key}.json`))).toBe(false);

    // A second eviction, and one against a directory that is not there, are
    // both successes: the caller is telling the cache what it must not serve,
    // not asking it to delete a file.
    await expect(cache.evict(key)).resolves.toBeUndefined();
    rmSync(cacheDir, { recursive: true, force: true });
    await expect(cache.evict(key)).resolves.toBeUndefined();
  });

  it('clears only its own entries', async () => {
    const keyA = computeIndexCacheKey(makeKeyInput());
    const keyB = computeIndexCacheKey(makeKeyInput({ indexerVersion: 'indexer/other' }));
    await cache.save(keyA, makeIndex());
    await cache.save(keyB, makeIndex());

    // Two things that must survive: a file that is not an entry, and a
    // subdirectory, which `clear` must not descend into.
    const stranger = join(cacheDir, 'notes.txt');
    writeFileSync(stranger, 'keep me', { mode: SECURE_FILE_MODE });
    const nested = join(cacheDir, 'nested');
    mkdirSync(nested, { mode: SECURE_DIR_MODE });
    const nestedEntry = join(nested, `${keyA}.json`);
    writeFileSync(nestedEntry, '{}', { mode: SECURE_FILE_MODE });

    // And one thing outside the cache directory entirely.
    const sibling = join(stateRoot, 'sessions.sqlite');
    writeFileSync(sibling, 'untouched', { mode: SECURE_FILE_MODE });

    await cache.clear();

    expect(existsSync(join(cacheDir, `${keyA}.json`))).toBe(false);
    expect(existsSync(join(cacheDir, `${keyB}.json`))).toBe(false);
    expect(readFileSync(stranger, 'utf8')).toBe('keep me');
    expect(existsSync(nestedEntry)).toBe(true);
    expect(readFileSync(sibling, 'utf8')).toBe('untouched');
    expect(existsSync(cacheDir)).toBe(true);
  });

  it('clears a cache directory that does not exist', async () => {
    await expect(cache.clear()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A malformed key is a programmer error.
// ---------------------------------------------------------------------------

describe('key validation', () => {
  const malformed = [
    '',
    'not-a-key',
    'A'.repeat(64),
    '0'.repeat(63),
    '0'.repeat(65),
    `../../${'0'.repeat(58)}`,
    `${'0'.repeat(63)}/`,
  ];

  it('rejects a malformed key from every operation', async () => {
    for (const key of malformed) {
      // Created lazily: a promise built before it is awaited would sit
      // rejected in the meantime.
      const operations: readonly (() => Promise<unknown>)[] = [
        () => cache.load(key),
        () => cache.save(key, makeIndex()),
        () => cache.evict(key),
      ];

      for (const operation of operations) {
        const failure = await rejectionOf(operation());

        expect(DebuggenError.is(failure)).toBe(true);
        if (!DebuggenError.is(failure)) {
          throw new Error('Expected a DebuggenError.');
        }
        expect(failure.code).toBe('INTERNAL');
        // The offending value is never echoed: a hand-built key is exactly the
        // kind of value that might carry a path or a token.
        if (key.length > 0) {
          expect(failure.message).not.toContain(key);
        }
      }
    }
  });

  it('touches nothing on disk for a malformed key', async () => {
    await rejectionOf(cache.save('nope', makeIndex()));

    expect(existsSync(cacheDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The structural guard.
// ---------------------------------------------------------------------------

describe('isCodeIndex', () => {
  it('accepts an index that has been through JSON', () => {
    const revived = JSON.parse(JSON.stringify(makeIndex())) as unknown;

    expect(isCodeIndex(revived)).toBe(true);
  });

  it('rejects values that are not documents', () => {
    for (const value of [undefined, null, 0, 'index', [], true]) {
      expect(isCodeIndex(value)).toBe(false);
    }
  });

  it('rejects a missing or non-array collection', () => {
    const index = makeIndex();

    expect(isCodeIndex({ ...index, nodes: undefined })).toBe(false);
    expect(isCodeIndex({ ...index, edges: 'none' })).toBe(false);
    expect(isCodeIndex({ ...index, files: {} })).toBe(false);
  });

  it('rejects an empty project root and a missing indexer version', () => {
    const index = makeIndex();

    expect(isCodeIndex({ ...index, projectRoot: '' })).toBe(false);
    expect(isCodeIndex({ ...index, indexerVersion: undefined })).toBe(false);
  });

  it('rejects a node whose kind is outside the vocabulary', () => {
    const index = makeIndex();
    const broken = {
      ...index,
      nodes: [{ id: 'x', kind: 'widget', name: 'x', file: 'src/a.ts', line: 1, column: 1 }],
    };

    expect(isCodeIndex(broken)).toBe(false);
  });

  it('rejects a node that is missing a payload its kind requires', () => {
    const index = makeIndex();
    const broken = {
      ...index,
      nodes: [
        {
          id: 'component:src/a.tsx#Thing',
          kind: 'component',
          name: 'Thing',
          file: 'src/a.tsx',
          line: 1,
          column: 1,
        },
      ],
    };

    expect(isCodeIndex(broken)).toBe(false);
  });

  it('rejects an edge that is missing an endpoint', () => {
    const index = makeIndex();
    const broken = { ...index, edges: [{ id: 'e', kind: 'imports', from: 'a' }] };

    expect(isCodeIndex(broken)).toBe(false);
  });

  it('rejects a fingerprint without a modification time', () => {
    const index = makeIndex();
    const broken = { ...index, files: [{ file: 'src/a.ts', size: 1 }] };

    expect(isCodeIndex(broken)).toBe(false);
  });

  it('accepts absent diagnostics and rejects an invalid one', () => {
    const index = makeIndex();

    expect(isCodeIndex({ ...index, diagnostics: [] })).toBe(true);
    expect(
      isCodeIndex({
        ...index,
        diagnostics: [{ severity: 'warning', code: 'file-skipped', message: 'skipped' }],
      }),
    ).toBe(true);
    expect(
      isCodeIndex({
        ...index,
        diagnostics: [{ severity: 'catastrophe', code: 'file-skipped', message: 'skipped' }],
      }),
    ).toBe(false);
    expect(
      isCodeIndex({ ...index, diagnostics: [{ severity: 'info', code: 'nope', message: 'x' }] }),
    ).toBe(false);
  });
});
