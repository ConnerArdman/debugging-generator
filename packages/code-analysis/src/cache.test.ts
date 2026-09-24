/**
 * Tests for `./cache.ts`: the key derivation, and the promise that every
 * problem is a miss.
 *
 * Three things are on trial, and they fail in different ways.
 *
 * The **key** is what decides which entry a project can reach. If it is
 * insensitive to something it should notice — a file's modification time, its
 * size, a file appearing, a different TypeScript configuration, a different
 * indexer version — the cache serves a stale index and every later answer in
 * the session is wrong about the tree on disk. The assertions are therefore
 * paired: each input that must change the key has a case, and the one thing
 * that must *not* change it — the order the caller happened to hold the file
 * list in — has one too.
 *
 * The **change stamps in the envelope** are what decides whether a reachable
 * entry is still fresh, and they exist because the two pieces of file metadata
 * the key can carry are both forgeable: a content substitution that preserves
 * `mtimeMs` and `size` asks for the same key. Those cases live in the last
 * section of this file, which states what they plant and why.
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
 *    credentials. Those cases run through `itPosix`, and the one failure that
 *    only an unprivileged account can provoke through `itUnprivileged`, so a
 *    platform or an account that cannot answer the question skips it instead of
 *    asserting its opposite.
 * 3. **Failures are read through the module's own vocabulary** — `isErr`,
 *    `DebuggenError.is`, `error.code`, `error.details.reason` — rather than by
 *    matching message text, which is documentation and free to change.
 * 4. **Every rejection is followed by a recovery.** A miss that leaves the
 *    cache unusable would be indistinguishable from a working one in a suite
 *    that only asserted the `undefined`, so each kind of damage is planted,
 *    missed, and then written and read back successfully under the same key.
 */
import {
  chmodSync,
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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { indexProject } from './indexer.js';
import { openProject } from './project.js';
import type { IndexResult } from './indexer.js';
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

/** An ordinary, world-readable directory mode: what a loose cache directory carries. */
const OVER_PERMISSIVE_DIR_MODE = 0o755;

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

/**
 * The extractor identities every fixture key is derived under, in run order.
 *
 * Deliberately neutral names rather than the real extractor ids: what the key
 * must notice is the *set and its order*, and a case that named the shipped
 * extractors would start failing for the unrelated reason that the package
 * gained or renamed one.
 */
const EXTRACTORS: readonly string[] = Object.freeze(['alpha', 'beta', 'gamma']);

/** The key input every case derives a key from unless it varies one field. */
function makeKeyInput(overrides: Partial<IndexCacheKeyInput> = {}): IndexCacheKeyInput {
  return {
    projectRoot: overrides.projectRoot ?? PROJECT_ROOT,
    tsConfigFilePath: overrides.tsConfigFilePath,
    indexerVersion: overrides.indexerVersion ?? INDEXER_VERSION,
    extractors: overrides.extractors ?? EXTRACTORS,
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

/**
 * `it`, skipped where the platform has no POSIX permission bits to assert.
 *
 * The `0700`/`0600` posture is the whole reason this module writes through the
 * hardened creators instead of `fs.writeFileSync`, so it is asserted rather
 * than assumed — but a mode is a POSIX concept, and `process.getuid` being
 * absent is the standard test for a platform that has none. Guarding the
 * assertion rather than dropping it keeps the posture enforced everywhere it
 * exists without turning a Windows run red for a question that has no answer
 * there.
 */
const itPosix = it.skipIf(process.getuid === undefined);

/**
 * `it`, skipped for the superuser and for a platform without permission bits.
 *
 * A permission-denied write is the one save failure that cannot be provoked as
 * root: `0500` on a directory does not stop uid 0 from creating inside it, so
 * the case would assert the opposite of what it was written for. The other
 * save failures in this file — a non-directory and a symbolic link at the
 * cache directory's path, and a parent that refuses the `mkdir` because a
 * regular file stands where it belongs — are provoked structurally and
 * therefore run for every account, which is what keeps the `Err`-not-throw
 * contract covered in CI, where tests run as root. The last of those is the
 * direct companion of the guarded case: same branch, same assertions, no
 * permission bit involved.
 */
const itUnprivileged = it.skipIf(process.getuid === undefined || process.getuid?.() === 0);

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

  it('changes when a file is removed', () => {
    const fewer = FINGERPRINTS.filter((fingerprint) => fingerprint.file !== 'src/second.ts');
    // Guards the case against a fixture change: a filter that matched nothing
    // would compare the baseline with itself and pass for the wrong reason.
    expect(fewer).toHaveLength(FINGERPRINTS.length - 1);

    expect(computeIndexCacheKey(makeKeyInput({ files: fewer }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('changes when a content hash appears', () => {
    const hashed = FINGERPRINTS.map((fingerprint) => ({ ...fingerprint, hash: 'b'.repeat(64) }));

    expect(computeIndexCacheKey(makeKeyInput({ files: hashed }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('changes when an existing content hash changes', () => {
    // Only the fingerprint that already carries a digest is rewritten, so this
    // is a *changed* hash rather than one appearing where there was none — the
    // case that catches a key which folds in the hash's presence but not its
    // value.
    const rewritten = 'c'.repeat(64);
    const rehashed = FINGERPRINTS.map((fingerprint) =>
      fingerprint.hash === undefined ? fingerprint : { ...fingerprint, hash: rewritten },
    );
    expect(rehashed.some((fingerprint) => fingerprint.hash === rewritten)).toBe(true);

    expect(computeIndexCacheKey(makeKeyInput({ files: rehashed }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('does not collide when the boundary between two parts moves', () => {
    // Both of these inputs join to the same text — `/work/a/b` + `/c/tsconfig.json`
    // and `/work/a` + `/b/c/tsconfig.json` are both `/work/a/b/c/tsconfig.json`
    // once concatenated — so a key derived by joining its parts would serve one
    // project's index to the other. `stableHash` frames every part with a type
    // tag and a byte length, which is what makes the two streams different.
    const deeperRoot = computeIndexCacheKey(
      makeKeyInput({ projectRoot: '/work/a/b', tsConfigFilePath: '/c/tsconfig.json' }),
    );
    const shallowerRoot = computeIndexCacheKey(
      makeKeyInput({ projectRoot: '/work/a', tsConfigFilePath: '/b/c/tsconfig.json' }),
    );

    expect(shallowerRoot).not.toBe(deeperRoot);

    // The same trap one field further in, where a path meets a number:
    // 'src/a.ts' + 12 + 3 and 'src/a.ts1' + 2 + 3 both join to 'src/a.ts123',
    // and the type tag additionally keeps the number 2 from reading as the
    // text '2'.
    const shortPath = computeIndexCacheKey(
      makeKeyInput({ files: [{ file: 'src/a.ts', mtimeMs: 12, size: 3 }] }),
    );
    const longPath = computeIndexCacheKey(
      makeKeyInput({ files: [{ file: 'src/a.ts1', mtimeMs: 2, size: 3 }] }),
    );

    expect(longPath).not.toBe(shortPath);
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

  it('changes when an extractor is dropped from the set', () => {
    // The assertion that stops a *narrowed* index being served to a later full
    // request: a run with fewer extractors covers less of the project, so it
    // must key to its own entry rather than to the full run's.
    const narrowed = EXTRACTORS.slice(0, EXTRACTORS.length - 1);
    expect(narrowed).toHaveLength(EXTRACTORS.length - 1);

    expect(computeIndexCacheKey(makeKeyInput({ extractors: narrowed }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('changes when an extractor is added to the set', () => {
    const extended: readonly string[] = [...EXTRACTORS, 'delta'];

    expect(computeIndexCacheKey(makeKeyInput({ extractors: extended }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('changes when the extractors run in a different order', () => {
    // Order is not cosmetic here: it decides which claimant of a duplicate id
    // graph construction keeps, so the same extractors in another order are a
    // different index. The extractor list is therefore the one part of the key
    // that is deliberately *not* sorted.
    const reordered = [...EXTRACTORS].reverse();
    expect(reordered).not.toEqual([...EXTRACTORS]);

    expect(computeIndexCacheKey(makeKeyInput({ extractors: reordered }))).not.toBe(
      computeIndexCacheKey(makeKeyInput()),
    );
  });

  it('does not collide when the boundary between two extractor ids moves', () => {
    // The same trap as the path/configuration case above, one field earlier:
    // ['ab', 'c'] and ['a', 'bc'] join to the same text, so a key derived by
    // concatenating the ids would serve a two-extractor index to a differently
    // partitioned pair. The count part additionally keeps a one-id list from
    // aligning with a two-id one.
    const split = computeIndexCacheKey(makeKeyInput({ extractors: ['ab', 'c'] }));
    const shifted = computeIndexCacheKey(makeKeyInput({ extractors: ['a', 'bc'] }));
    const joined = computeIndexCacheKey(makeKeyInput({ extractors: ['abc'] }));

    expect(shifted).not.toBe(split);
    expect(joined).not.toBe(split);
    expect(joined).not.toBe(shifted);
  });

  it('keeps the extractor list the caller passed untouched and in order', () => {
    const extractors = [...EXTRACTORS];
    computeIndexCacheKey(makeKeyInput({ extractors }));

    expect(extractors).toEqual([...EXTRACTORS]);
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

  it('always ends with the index segment, in POSIX form', () => {
    // Every path the product stores, logs or compares is POSIX, so a state root
    // that arrived with Windows separators must not leak them into a directory
    // the rest of the system will match against.
    const resolved = resolveIndexCacheDir({ debuggenHome: 'C:\\Users\\dev\\.debuggen' });

    expect(resolved).toBe('C:/Users/dev/.debuggen/index');
    expect(resolved.endsWith('/index')).toBe(true);
    expect(resolved).not.toContain('\\');
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

  it('leaves no temporary file behind after a successful save', async () => {
    const key = computeIndexCacheKey(makeKeyInput());

    expect(isOk(await cache.save(key, makeIndex()))).toBe(true);

    // The atomic write creates a dotted temporary sibling and renames it over
    // the entry path, so a survivor would show up here — `readdir` lists
    // dotfiles — and would accumulate one stray file per save.
    expect(readdirSync(cacheDir)).toEqual([`${key}.json`]);
  });

  itPosix('creates the cache directory 0700 and the entry 0600', async () => {
    const key = computeIndexCacheKey(makeKeyInput());

    expect(isOk(await cache.save(key, makeIndex()))).toBe(true);

    expect(modeOf(cacheDir)).toBe(SECURE_DIR_MODE);
    expect(modeOf(join(cacheDir, `${key}.json`))).toBe(SECURE_FILE_MODE);
  });

  itPosix('recreates the cache directory when it was deleted between runs', async () => {
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

  itPosix(
    'refuses a cache directory left over-permissive, and leaves its mode and contents alone',
    async () => {
      // AAP 0.4.2: every directory of the state tree must already be private,
      // and the write refuses to proceed otherwise. A cache directory another
      // account could read is refused as it stands, never tightened, because
      // the developer is the one who has to judge what it may have exposed.
      // The mode is set with `chmod` so the fixture does not depend on the
      // process umask.
      mkdirSync(cacheDir, { recursive: true });
      chmodSync(cacheDir, OVER_PERMISSIVE_DIR_MODE);
      expect(modeOf(cacheDir)).toBe(OVER_PERMISSIVE_DIR_MODE);

      const key = computeIndexCacheKey(makeKeyInput());
      const result = await cache.save(key, makeIndex());

      // A value, not an exception, and the policy code survives the wrapping,
      // as it does for a directory reached through a link.
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) {
        throw new Error('Expected an Err.');
      }
      expect(result.error.code).toBe('FS_UNSAFE_PATH');
      expect(result.error.details?.reason).toBe('cache-write-failed');
      expect(result.error.details?.key).toBe(key);
      // The hint is the refusal's own, naming the exact `chmod` to run.
      expect(result.error.hint).toContain(`chmod 700 ${cacheDir}`);

      // The finer diagnosis travels as the cause: which directory, why, and
      // with what mode.
      const { cause } = result.error;
      if (!DebuggenError.is(cause)) {
        throw new Error('Expected the refusal to carry the policy error as its cause.');
      }
      expect(cause.code).toBe('FS_UNSAFE_PATH');
      expect(cause.details?.reason).toBe('group-or-other-permissions');
      expect(cause.details?.path).toBe(cacheDir);
      expect(cause.details?.mode).toBe('755');

      // Refused means untouched: the mode is what the fixture set, and no entry
      // or temporary file was written into the directory.
      expect(modeOf(cacheDir)).toBe(OVER_PERMISSIVE_DIR_MODE);
      expect(readdirSync(cacheDir)).toEqual([]);
      expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1);
    },
  );

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

  it('misses when the cache directory was deleted after the entry was written', async () => {
    expect(isOk(await cache.save(key, makeIndex()))).toBe(true);
    await expect(cache.load(key)).resolves.toBeDefined();

    // Exactly what the service's retention job does to the index cache of a
    // project that has not been opened inside the retention window, and what a
    // developer does by removing `~/.debuggen`. The cache was constructed
    // against a directory that now does not exist, which is an ordinary state
    // rather than a failure.
    rmSync(cacheDir, { recursive: true, force: true });

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('absent');
  });

  it('cannot reach an entry written under another indexer version', async () => {
    const otherVersionKey = computeIndexCacheKey(
      makeKeyInput({ indexerVersion: 'indexer/2026.10.1' }),
    );
    expect(otherVersionKey).not.toBe(key);

    expect(isOk(await cache.save(key, makeIndex()))).toBe(true);

    // The indexer version is folded into the key, so an index built by another
    // version is *unreachable* rather than read and refused — the cheapest
    // correct form of invalidation. And an ordinary absent miss must not touch
    // the entry it never read: a session asking under this version's key still
    // finds its own entry afterwards.
    await expect(cache.load(otherVersionKey)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('absent');
    expect(existsSync(join(cacheDir, `${key}.json`))).toBe(true);
    await expect(cache.load(key)).resolves.toBeDefined();
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

  it('misses on every shape of structural damage and removes the entry', async () => {
    // Three documents that parse as JSON and claim the right envelope version,
    // and each of which a traversal would fail on somewhere far from the cause:
    // a collection that is not a collection, a missing envelope field, and an
    // element without the discriminant every consumer branches on.
    const damaged: readonly { readonly label: string; readonly index: unknown }[] = [
      { label: 'nodes is not an array', index: { ...makeIndex(), nodes: 'none' } },
      {
        label: 'the project root is missing',
        index: {
          schemaVersion: CODE_INDEX_SCHEMA_VERSION,
          indexerVersion: INDEXER_VERSION,
          generatedAt: GENERATED_AT,
          nodes: NODES,
          edges: EDGES,
          files: FINGERPRINTS,
        },
      },
      {
        label: 'a node carries no kind',
        index: {
          ...makeIndex(),
          nodes: [
            { id: 'file:src/first.ts', name: 'first.ts', file: 'src/first.ts', line: 1, column: 1 },
          ],
        },
      },
    ];

    for (const { label, index } of damaged) {
      const path = writeRawEntry(
        key,
        JSON.stringify({
          schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
          key,
          writtenAt: GENERATED_AT,
          index,
        }),
      );

      expect(await cache.load(key), label).toBeUndefined();
      expect(existsSync(path), label).toBe(false);
    }

    expect(reasonsOf(lines)).toContain('malformed-index');
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
        // An empty stamp list, which is well-formed and therefore gets this
        // document past the shape guard: the key check runs before the
        // freshness comparison, so this case still exercises the reason it was
        // written for rather than being refused a step earlier.
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
        key: otherKey,
        writtenAt: GENERATED_AT,
        index: makeIndex(),
        stamps: [],
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
        // Well-formed and empty for the same reason as the case above: the
        // vocabulary check also runs before the freshness comparison.
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
        key,
        writtenAt: GENERATED_AT,
        index: makeIndex({ schemaVersion: CODE_INDEX_SCHEMA_VERSION + 1 }),
        stamps: [],
      }),
    );

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('stale-vocabulary');
    expect(existsSync(path)).toBe(false);
  });

  it('misses rather than following a symbolic link planted at the entry path', async () => {
    const secret = join(stateRoot, 'elsewhere.json');
    const secretContents = JSON.stringify({
      schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
      key,
      writtenAt: GENERATED_AT,
      index: makeIndex(),
    });
    writeFileSync(secret, secretContents, { mode: SECURE_FILE_MODE });

    mkdirSync(cacheDir, { recursive: true, mode: SECURE_DIR_MODE });
    const link = join(cacheDir, `${key}.json`);
    symlinkSync(secret, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    // A miss, not a throw, and not a read of the link's target.
    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('unreadable');

    // The link is removed; what it pointed at survives byte for byte, which is
    // the half of the outcome that proves `unlink` took the link and not its
    // target — the target here stands for a credential file or a backup living
    // elsewhere under the same state root.
    expect(existsSync(link)).toBe(false);
    expect(existsSync(secret)).toBe(true);
    expect(readFileSync(secret, 'utf8')).toBe(secretContents);
  });

  it('misses when the entry path is a directory', async () => {
    mkdirSync(join(cacheDir, `${key}.json`), { recursive: true, mode: SECURE_DIR_MODE });

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('unreadable');
  });

  it('recovers from every kind of damage, so a miss is never terminal', async () => {
    const entryFile = join(cacheDir, `${key}.json`);
    const linkTarget = join(stateRoot, 'link-target.json');

    /**
     * One way the entry under `key` can be unusable, planted as real bytes on a
     * real filesystem. Each plant starts from whatever the previous iteration
     * left behind — a valid entry — which is why the link case unlinks first.
     */
    const damage: readonly { readonly label: string; readonly plant: () => void }[] = [
      {
        label: 'unparsable bytes',
        plant: (): void => {
          writeRawEntry(key, '{"index":');
        },
      },
      {
        label: 'a newer envelope version',
        plant: (): void => {
          writeRawEntry(
            key,
            JSON.stringify({
              schemaVersion: INDEX_CACHE_SCHEMA_VERSION + 1,
              key,
              writtenAt: GENERATED_AT,
              index: makeIndex(),
            }),
          );
        },
      },
      {
        label: 'a structurally invalid index',
        plant: (): void => {
          writeRawEntry(
            key,
            JSON.stringify({
              schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
              key,
              writtenAt: GENERATED_AT,
              index: { schemaVersion: CODE_INDEX_SCHEMA_VERSION },
            }),
          );
        },
      },
      {
        label: 'a deleted cache directory',
        plant: (): void => {
          rmSync(cacheDir, { recursive: true, force: true });
        },
      },
      {
        label: 'a planted symbolic link',
        plant: (): void => {
          writeFileSync(linkTarget, '{}', { mode: SECURE_FILE_MODE });
          mkdirSync(cacheDir, { recursive: true, mode: SECURE_DIR_MODE });
          rmSync(entryFile, { force: true });
          symlinkSync(linkTarget, entryFile);
        },
      },
    ];

    const index = makeIndex();
    for (const { label, plant } of damage) {
      plant();

      // Rejected, and then immediately usable again: the rejection removed the
      // offending file, `save` recreated whatever was missing, and the index
      // the indexer rebuilt is served from disk on the next ask. This is the
      // whole reason `./indexer.ts` may treat a hit as a bonus.
      expect(await cache.load(key), label).toBeUndefined();
      expect(isOk(await cache.save(key, index)), label).toBe(true);
      expect(existsSync(cacheDir), label).toBe(true);
      expect(await cache.load(key), label).toEqual(index);
    }
  });
});

// ---------------------------------------------------------------------------
// Write failures are values, not exceptions.
// ---------------------------------------------------------------------------

describe('save failures', () => {
  itUnprivileged('never fails an index for a state root it cannot write into', async () => {
    // `0500` on the parent rather than on the cache directory itself, and the
    // distinction is the point: this case is about the `mkdir` that creates
    // the cache directory being refused by the parent. `ensureSecureDir` never
    // changes the mode of a directory that already exists — an owner-only
    // `0500` cache directory would be accepted as it stands and the save would
    // fail later, at its temporary file, which is a different branch. Traversal
    // is left in place (`0500`, not `0000`) so the sandbox can still be
    // removed.
    chmodSync(stateRoot, 0o500);
    try {
      const result = await cache.save(computeIndexCacheKey(makeKeyInput()), makeIndex());

      // A value, not an exception: the caller logs it and carries on with the
      // index it already holds in memory, because an index that was built but
      // not cached is a slow success rather than a failure.
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) {
        throw new Error('Expected an Err.');
      }
      // `DebuggenError.is` checks the code against the product's own
      // vocabulary, so this also states that the code is one declared in
      // `@debuggen/shared` rather than an errno leaking through.
      expect(DebuggenError.is(result.error)).toBe(true);
      expect(result.error.code).toBe('CODE_INDEX_FAILED');
      expect(result.error.details?.reason).toBe('cache-write-failed');
      expect(result.error.hint).toBeDefined();
      expect(existsSync(cacheDir)).toBe(false);
    } finally {
      // Restored here rather than in `afterEach`: the teardown has to be able
      // to remove the sandbox whether or not the assertions above held.
      chmodSync(stateRoot, SECURE_DIR_MODE);
    }
  });

  it('never fails an index for a state root it cannot create, on any account', async () => {
    // The companion to the case above, and the one that runs everywhere: a
    // regular file stands where the cache directory's parent belongs, so the
    // `mkdir` inside `ensureSecureDir` fails with `ENOTDIR` for every account,
    // root included. A privileged process writes straight through the `0500`
    // the case above relies on, which would leave this branch — an index that
    // was built but could not be cached — asserted nowhere in CI.
    const occupied = join(stateRoot, 'occupied');
    writeFileSync(occupied, 'not a directory', { mode: SECURE_FILE_MODE });

    const recording = createRecordingLogger();
    const blocked = createIndexCache({
      cacheDir: join(occupied, 'index'),
      logger: recording.logger,
    });

    const result = await blocked.save(computeIndexCacheKey(makeKeyInput()), makeIndex());

    // A value, not an exception, exactly as in the guarded case: the caller
    // logs it and carries on with the index it holds in memory.
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) {
      throw new Error('Expected an Err.');
    }
    expect(DebuggenError.is(result.error)).toBe(true);
    expect(result.error.code).toBe('CODE_INDEX_FAILED');
    expect(result.error.details?.reason).toBe('cache-write-failed');
    expect(result.error.hint).toBeDefined();
    expect(existsSync(blocked.cacheDir)).toBe(false);

    // And it is reported once, at warning level, without the index in the line.
    expect(recording.lines.filter((line) => line.level === 'warn')).toHaveLength(1);
  });

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
// What a hit is worth: the pipeline's cache-first path.
//
// Every case above asserts what this module does with a key and an entry. This
// one asserts the thing those cases cannot see and the reason the module
// exists: that a hit is *cheap*. `./indexer.ts` promises a hit "having
// constructed no program, parsed nothing and run no extractor", and the only
// way to hold it to that from outside is to watch for the work itself —
// `./project.ts` logs `'project opened'` after, and only after, the ts-morph
// program has been built and its file set retained, so the absence of that
// record on the second run is the observable proof that the second run built no
// program. A regression that moved the lookup back behind the parse would keep
// every assertion in this file green except this one.
//
// Run against the committed corpus at `test/fixtures/sample-next-app`, which is
// READ ONLY: the cache lives in this file's temporary state root, the indexer
// writes nothing else, and nothing here touches the fixture.
// ---------------------------------------------------------------------------

describe('a cache hit through indexProject', () => {
  /** The corpus, resolved through `realpath` so it matches the indexer's own normalisation. */
  const FIXTURE_ROOT = realpathSync(
    fileURLToPath(new URL('../test/fixtures/sample-next-app', import.meta.url)),
  );

  /** Whether a run logged the message `./project.ts` emits once a program exists. */
  function builtAProgram(lines: readonly RecordedLine[]): boolean {
    return lines.some((line) => line.message === 'project opened');
  }

  /**
   * The per-case budget both runs here are given.
   *
   * The `code-analysis` Vitest project uses the default 5 s, and a cold run
   * parses the whole corpus — so the budget is stated rather than inherited,
   * and stated once for both cases.
   */
  const CORPUS_RUN_TIMEOUT_MS = 30_000;

  it(
    'serves the second run without opening the project, and the hit is usable',
    async () => {
      const first = createRecordingLogger();
      const cold = await indexProject({
        projectRoot: FIXTURE_ROOT,
        cache,
        logger: first.logger,
      });

      expect(isOk(cold)).toBe(true);
      if (!isOk(cold)) {
        throw new Error('The first indexing run must succeed.');
      }
      expect(cold.value.fromCache).toBe(false);
      // The control half of the assertion below: the message is one this corpus
      // really does produce, so its absence on the warm run means something.
      expect(builtAProgram(first.lines)).toBe(true);

      const second = createRecordingLogger();
      const warm = await indexProject({
        projectRoot: FIXTURE_ROOT,
        cache,
        logger: second.logger,
      });

      expect(isOk(warm)).toBe(true);
      if (!isOk(warm)) {
        throw new Error('The second indexing run must succeed.');
      }
      expect(warm.value.fromCache).toBe(true);
      expect(builtAProgram(second.lines)).toBe(false);

      // A hit that is not usable is not a hit. The graph, the route map and the
      // "no extractor ran" marker are what a caller acts on.
      expect(warm.value.graph.size.nodes).toBeGreaterThan(0);
      expect(warm.value.routeMap.entries.length).toBeGreaterThan(0);
      expect(Object.keys(warm.value.stats.extractorDurations)).toHaveLength(0);

      // And it describes the same project as the run that built it.
      expect(warm.value.index.projectRoot).toBe(cold.value.index.projectRoot);
      expect(warm.value.index.files.length).toBe(cold.value.index.files.length);
      expect(warm.value.graph.size.nodes).toBe(cold.value.graph.size.nodes);
    },
    CORPUS_RUN_TIMEOUT_MS,
  );

  it(
    'finds the entry a run that supplied its own project handle wrote',
    async () => {
      // The two paths into the cache reach the key from different places — one
      // from a discovery before anything is parsed, the other from an
      // already-opened program — and they are only useful to each other if they
      // agree. A key derived slightly differently on each path would leave both
      // runs green in isolation while the cache never hit in practice.
      const opened = openProject({ projectRoot: FIXTURE_ROOT });
      expect(isOk(opened)).toBe(true);
      if (!isOk(opened)) {
        throw new Error('The corpus must open.');
      }

      const written = await indexProject({
        projectRoot: FIXTURE_ROOT,
        loaded: opened.value,
        cache,
      });

      expect(isOk(written)).toBe(true);
      if (!isOk(written)) {
        throw new Error('The run over the supplied handle must succeed.');
      }
      expect(written.value.fromCache).toBe(false);

      const discovered = await indexProject({ projectRoot: FIXTURE_ROOT, cache });

      expect(isOk(discovered)).toBe(true);
      if (!isOk(discovered)) {
        throw new Error('The run that discovers for itself must succeed.');
      }
      expect(discovered.value.fromCache).toBe(true);
      expect(discovered.value.index.files.length).toBe(written.value.index.files.length);
    },
    CORPUS_RUN_TIMEOUT_MS,
  );
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

// ---------------------------------------------------------------------------
// Freshness: the change stamps in the envelope.
//
// The key folds in each file's modification time and size, and a content
// substitution can preserve both — `tar -x`, `cp -p`, `rsync --times`,
// `touch -r`, a hermetic build-cache restore — so a tree whose bytes were
// replaced under its old timestamps asks for the *same* key and would be served
// an index describing code that no longer exists. Every case below holds one
// half of the answer to that: `save` records a per-file change stamp in the
// envelope, `load` takes the stamps again, and a difference is an ordinary miss.
//
// The assertions are paired the way the key's are. The substitution must be a
// miss, and it must be a miss *for this reason* — the recorded `reason` is
// asserted, because a key that had accidentally changed would also produce a
// second cold run and would prove nothing. An unchanged tree, and an index over
// files that never existed on disk, must still be hits: a freshness check that
// disabled the cache would pass the first assertion and defeat the module.
//
// Every file these cases write lives inside the per-case `mkdtemp` state root
// that `afterEach` removes. The committed corpus at `test/fixtures` is read
// only and is deliberately not used here, because these cases have to *change*
// a file.
// ---------------------------------------------------------------------------

describe('freshness verification', () => {
  /**
   * The modification time every file written here carries, in whole seconds.
   *
   * Pinned *before* the first index, and the reason is exactness: `utimesSync`
   * takes seconds as a floating-point number, so restoring a timestamp that
   * carried a fractional millisecond can land a nanosecond away from where it
   * started — which would change the cache key and leave the case proving
   * nothing about freshness. An integer second round-trips bit for bit, so the
   * substitution below really does hold `mtimeMs` and `size` still and varies
   * nothing but the bytes.
   */
  const FIXED_MTIME_SECONDS = 1_777_000_000;

  /** The body the sandbox project starts with. */
  const ALPHA_BODY = 'export function alpha(): number {\n  return 1;\n}\n';

  /**
   * The replacement body: a different declaration of **exactly** the same byte
   * length, which is what makes `size` survive the substitution.
   */
  const BETA_BODY = 'export function beta_(): number {\n  return 1;\n}\n';

  /** The budget an indexing run here is given; a one-file project, but ts-morph still starts. */
  const RUN_TIMEOUT_MS = 30_000;

  /** Writes `contents` and pins the modification time, so a later restore is exact. */
  function writeWithFixedMtime(path: string, contents: string): void {
    writeFileSync(path, contents, { mode: SECURE_FILE_MODE });
    utimesSync(path, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
  }

  /**
   * A one-file project inside the state root.
   *
   * Inside the sandbox rather than beside the corpus, so the teardown removes
   * it however the case ends, and named per case so two cases cannot collide.
   *
   * @param name The directory to create it under.
   * @param body The contents of its single source file.
   * @returns The project root and the file's absolute path.
   */
  function createSandboxProject(
    name: string,
    body: string,
  ): { readonly root: string; readonly file: string } {
    const root = join(stateRoot, name);
    mkdirSync(join(root, 'src'), { recursive: true, mode: SECURE_DIR_MODE });
    const file = join(root, 'src', 'a.ts');
    writeWithFixedMtime(file, body);
    return { root, file };
  }

  /**
   * One indexing run over `root`, unwrapped.
   *
   * The cases below are sequences of three and four runs, and unwrapping each
   * `Result` in place would bury the sequence in assertions about something no
   * case here is testing.
   *
   * @param root The project to index.
   * @param label What this run is, for the failure message.
   * @returns The run's result.
   */
  async function indexOnce(root: string, label: string): Promise<IndexResult> {
    const result = await indexProject({ projectRoot: root, cache });

    expect(isOk(result), label).toBe(true);
    if (!isOk(result)) {
      throw new Error(`The ${label} indexing run must succeed.`);
    }
    return result.value;
  }

  /** Every name the index's nodes carry, which is where a declared symbol shows up. */
  function nodeNames(index: CodeIndex): readonly string[] {
    return index.nodes.map((node) => node.name);
  }

  /** A fingerprint of a real file, as the indexer would have taken it. */
  function fingerprintOnDisk(root: string, relative: string): FileFingerprint {
    const stats = statSync(join(root, relative));
    return { file: relative, mtimeMs: stats.mtimeMs, size: stats.size };
  }

  it(
    'sees a substitution that preserved the modification time and size',
    async () => {
      // The fixture guard: a replacement of a different length would be caught
      // by the key's `size` part, and the case would pass for the wrong reason.
      expect(BETA_BODY).toHaveLength(ALPHA_BODY.length);
      const { root, file } = createSandboxProject('substituted', ALPHA_BODY);

      const cold = await indexOnce(root, 'cold');
      expect(cold.fromCache).toBe(false);
      expect(nodeNames(cold.index)).toContain('alpha');

      // The cache still caches: without this the case would be satisfied by a
      // fix that simply stopped serving hits.
      const warm = await indexOnce(root, 'warm');
      expect(warm.fromCache).toBe(true);
      expect(nodeNames(warm.index)).toContain('alpha');

      // What `tar -x`, `cp -p`, `rsync --times` and `touch -r` all do: new
      // bytes under the old modification time. Same length, so the size is
      // unchanged too, and the tree therefore asks for the key the entry above
      // was written under.
      const before = statSync(file);
      writeWithFixedMtime(file, BETA_BODY);
      const after = statSync(file);

      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.size).toBe(before.size);
      // The one thing userspace could not hold still, and the whole basis of
      // the check: the kernel moved the inode's change time.
      expect(after.ctimeMs).not.toBe(before.ctimeMs);

      const third = await indexOnce(root, 'third');
      expect(third.fromCache).toBe(false);
      expect(nodeNames(third.index)).toContain('beta_');
      expect(nodeNames(third.index)).not.toContain('alpha');
      // And it missed for the right reason. A miss recorded as `absent` would
      // mean the key had changed after all — the same observable outcome,
      // reached without the stamps proving anything.
      expect(reasonsOf(lines)).toContain('stale-file');

      // A stale entry is replaced rather than left to miss forever: the third
      // run wrote its own index under the same key (the metadata the key
      // covers did not change), so the fourth run is a hit again.
      const fourth = await indexOnce(root, 'fourth');
      expect(fourth.fromCache).toBe(true);
      expect(nodeNames(fourth.index)).toContain('beta_');
    },
    RUN_TIMEOUT_MS,
  );

  it('hits when nothing under a real project root has changed', async () => {
    const { root } = createSandboxProject('unchanged', ALPHA_BODY);
    const files: readonly FileFingerprint[] = [fingerprintOnDisk(root, 'src/a.ts')];
    const index = makeIndex({ projectRoot: root, files });
    const key = computeIndexCacheKey(makeKeyInput({ projectRoot: root, files }));

    expect(isOk(await cache.save(key, index))).toBe(true);

    // The regression this guards: a verification that compared something a
    // second `stat` cannot reproduce — an access time, a read of the file, a
    // clock — would make every hit a miss and turn the cache off.
    await expect(cache.load(key)).resolves.toEqual(index);
    expect(reasonsOf(lines)).not.toContain('stale-file');
  });

  it('hits for an index over files that do not exist on disk', async () => {
    // A caller may cache an index it synthesised — a fixture, a projection, a
    // tree that has since been removed — and several cases in this file do
    // exactly that with `makeIndex()`, whose fingerprints name paths under a
    // project root that was never created. An absent stamp compares equal to
    // an absent stamp, so such an entry round-trips.
    const key = computeIndexCacheKey(makeKeyInput());
    const index = makeIndex();
    expect(existsSync(index.projectRoot)).toBe(false);

    expect(isOk(await cache.save(key, index))).toBe(true);

    await expect(cache.load(key)).resolves.toEqual(index);
    expect(reasonsOf(lines)).not.toContain('stale-file');
  });

  it('misses when a file changed only its change time, and removes the entry', async () => {
    const { root, file } = createSandboxProject('touched', ALPHA_BODY);
    const files: readonly FileFingerprint[] = [fingerprintOnDisk(root, 'src/a.ts')];
    const key = computeIndexCacheKey(makeKeyInput({ projectRoot: root, files }));

    expect(isOk(await cache.save(key, makeIndex({ projectRoot: root, files })))).toBe(true);

    // The same bytes rewritten, with the modification time restored: nothing a
    // reader of the file would notice, and nothing the key covers. The entry is
    // dropped anyway, and that is the intended direction — this check fails
    // *closed*, so a rewrite with identical content, a `chmod` or a checkout
    // that moved only the change time each cost one rebuild that produces the
    // same index. A spurious miss is slow; a spurious hit is wrong.
    const before = statSync(file);
    writeWithFixedMtime(file, ALPHA_BODY);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(file).size).toBe(before.size);

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('stale-file');
    expect(existsSync(join(cacheDir, `${key}.json`))).toBe(false);

    // And the cache is immediately usable again, because the miss removed the
    // entry rather than leaving it to be re-read on every run.
    const rebuilt = makeIndex({ projectRoot: root, files: [fingerprintOnDisk(root, 'src/a.ts')] });
    expect(isOk(await cache.save(key, rebuilt))).toBe(true);
    await expect(cache.load(key)).resolves.toEqual(rebuilt);
  });

  it('misses when a file that was stamped has since been removed', async () => {
    const { root, file } = createSandboxProject('deleted', ALPHA_BODY);
    const files: readonly FileFingerprint[] = [fingerprintOnDisk(root, 'src/a.ts')];
    const key = computeIndexCacheKey(makeKeyInput({ projectRoot: root, files }));

    expect(isOk(await cache.save(key, makeIndex({ projectRoot: root, files })))).toBe(true);

    // A file that was present when the entry was written and is not present
    // now: the asymmetric case, and the one an absent-compares-equal-to-absent
    // rule must not swallow.
    rmSync(file, { force: true });

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('stale-file');
    expect(existsSync(join(cacheDir, `${key}.json`))).toBe(false);
  });

  it('misses on an entry with no stamps at all and removes it', async () => {
    const key = computeIndexCacheKey(makeKeyInput());
    // Exactly what an entry written by envelope version 1 looks like, and what
    // a hand-edited or truncated document tends to look like: the index still
    // parses and the key still matches, and the freshness evidence is gone.
    const path = writeRawEntry(
      key,
      JSON.stringify({
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
        key,
        writtenAt: GENERATED_AT,
        index: makeIndex(),
      }),
    );

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('malformed-stamps');
    expect(existsSync(path)).toBe(false);

    // Recovered, like every other kind of damage in this file.
    const index = makeIndex();
    expect(isOk(await cache.save(key, index))).toBe(true);
    await expect(cache.load(key)).resolves.toEqual(index);
  });

  it('misses on malformed stamps and removes the entry', async () => {
    const key = computeIndexCacheKey(makeKeyInput());
    const damaged: readonly { readonly label: string; readonly stamps: unknown }[] = [
      { label: 'not a collection', stamps: 'none' },
      { label: 'an element that is not a document', stamps: [null] },
      { label: 'a stamp with no path', stamps: [{ present: false }] },
      {
        label: 'a stamp missing the change time',
        stamps: [{ file: 'src/first.ts', present: true, mtimeMs: 1, size: 2, ino: 3 }],
      },
      {
        label: 'a stamp whose numbers are not finite',
        stamps: [
          { file: 'src/first.ts', present: true, mtimeMs: null, size: 2, ctimeMs: 3, ino: 4 },
        ],
      },
    ];

    for (const { label, stamps } of damaged) {
      const path = writeRawEntry(
        key,
        JSON.stringify({
          schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
          key,
          writtenAt: GENERATED_AT,
          index: makeIndex(),
          stamps,
        }),
      );

      expect(await cache.load(key), label).toBeUndefined();
      expect(existsSync(path), label).toBe(false);
    }

    expect(reasonsOf(lines)).toContain('malformed-stamps');
  });

  it('misses when the stamps do not cover the files the index names', async () => {
    const key = computeIndexCacheKey(makeKeyInput());
    // Well-formed stamps, but not the ones this index's file list would
    // produce: a shorter list than `files`, which is what a truncated write or
    // a hand-assembled document looks like. There is nothing to compare the
    // uncovered file against, so the entry goes.
    const path = writeRawEntry(
      key,
      JSON.stringify({
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
        key,
        writtenAt: GENERATED_AT,
        index: makeIndex(),
        stamps: [{ file: 'src/first.ts', present: false, mtimeMs: 0, size: 0, ctimeMs: 0, ino: 0 }],
      }),
    );

    await expect(cache.load(key)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('stale-file');
    expect(existsSync(path)).toBe(false);
  });
});
