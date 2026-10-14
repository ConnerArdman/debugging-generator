/**
 * Tests for `./cache.ts`: the two key derivations, freshness, and the promise
 * that every problem is a miss.
 *
 * Four things are on trial, and they fail in different ways.
 *
 * The **entry key** names the one file a project's index lives in. If it
 * notices something it should not — a file's modification time, its size, a
 * file appearing — every state of the tree gets its own file and the cache
 * directory grows without bound; if it misses something it should notice — a
 * different TypeScript configuration, indexer version or extractor set — two
 * different indexes share a file. Both halves are asserted.
 *
 * The **state key** is the fast path's comparison value: the project hash plus
 * every file's modification time and size. Each input that must change it has
 * a case, and the one thing that must *not* change it — the order the caller
 * happened to hold the file list in — has one too.
 *
 * The **stamps and digests in the envelope** decide whether an entry is still
 * fresh: a stamp proves a file untouched without reading it, and a digest
 * proves a touched file unchanged by reading it once. Those cases live in the
 * last section of this file, which states what they plant and why — including
 * the one this design exists for, the product's own patch followed by its
 * byte-for-byte restore, which must be a hit.
 *
 * The **miss contract** is a negative guarantee, which is why these cases plant
 * damage rather than mock it. A corrupt entry is written as real bytes, a
 * wrong-version envelope as real JSON, a symbolic link as a real link, and each
 * case asserts both halves of the outcome: `load` answered `undefined`, and the
 * offending file is *gone*, because an entry that is rejected but left in place
 * is re-read on every run for as long as it sits there. `load` is never allowed
 * to reject for any of them.
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
 *    missed, and then written and read back successfully for the same project.
 */
import { createHash } from 'node:crypto';
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
  computeIndexCacheEntryKey,
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

/** The path the entry of the project `input` identifies lives at. */
function entryFileOf(input: IndexCacheKeyInput = makeKeyInput()): string {
  return join(cacheDir, `${computeIndexCacheEntryKey(input)}.json`);
}

/**
 * A well-formed envelope of the current version, as a plain object to plant.
 *
 * Every field defaults to what `save` would write for {@link makeKeyInput} and
 * {@link makeIndex} over files that do not exist, so a case overrides exactly
 * the one field whose rejection it is about and the document gets past every
 * other check.
 */
function makeEnvelope(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const index = makeIndex();
  return {
    schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
    key: computeIndexCacheEntryKey(makeKeyInput()),
    stateKey: computeIndexCacheKey(makeKeyInput()),
    writtenAt: GENERATED_AT,
    index,
    stamps: index.files.map((fingerprint) => ({
      file: fingerprint.file,
      present: false,
      mtimeMs: 0,
      size: 0,
      ctimeMs: 0,
      ino: 0,
      contentHash: '',
    })),
    ...overrides,
  };
}

/** The recorded stamps of the entry at `path`, read back from disk as JSON. */
function recordedStampsAt(path: string): readonly Readonly<Record<string, unknown>>[] {
  const document = JSON.parse(readFileSync(path, 'utf8')) as {
    readonly stamps: readonly Readonly<Record<string, unknown>>[];
  };
  return document.stamps;
}

/** The `revalidatedFiles` field of every hit line, in order: `0` is the stat-only path. */
function revalidatedCountsOf(lines: readonly RecordedLine[]): readonly unknown[] {
  return lines
    .filter((line) => line.message === 'code index cache hit')
    .map((line) => line.fields.revalidatedFiles);
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

describe('computeIndexCacheEntryKey', () => {
  const baseline = computeIndexCacheEntryKey(makeKeyInput());

  it('produces 64 lowercase hexadecimal characters, distinct from the state key', () => {
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
    expect(baseline).not.toBe(computeIndexCacheKey(makeKeyInput()));
    // Even for a project with no files, where the two keys hash nearly the
    // same parts: the domains keep them apart.
    expect(computeIndexCacheEntryKey(makeKeyInput({ files: [] }))).not.toBe(
      computeIndexCacheKey(makeKeyInput({ files: [] })),
    );
  });

  it('ignores every file-level change, so one project has one entry', () => {
    // The property the whole layout rests on: editing, patching, restoring,
    // adding or removing a file changes the *state* of the tree, never the
    // name of the file its index lives in.
    const [second, first] = FINGERPRINTS;
    if (first === undefined || second === undefined) {
      throw new Error('The fingerprint fixture must hold two entries.');
    }
    const states: readonly (readonly FileFingerprint[])[] = [
      [second, { ...first, mtimeMs: first.mtimeMs + 1 }],
      FINGERPRINTS.map((fingerprint) => ({ ...fingerprint, size: fingerprint.size + 1 })),
      FINGERPRINTS.map((fingerprint) => ({ ...fingerprint, hash: 'd'.repeat(64) })),
      [...FINGERPRINTS, { file: 'src/third.ts', mtimeMs: 1, size: 1 }],
      [second],
      [],
    ];

    for (const files of states) {
      expect(computeIndexCacheEntryKey(makeKeyInput({ files }))).toBe(baseline);
      // And the state key does notice each of them.
      expect(computeIndexCacheKey(makeKeyInput({ files }))).not.toBe(
        computeIndexCacheKey(makeKeyInput()),
      );
    }
  });

  it('changes with every part of the project identity', () => {
    const variants: readonly IndexCacheKeyInput[] = [
      makeKeyInput({ projectRoot: '/home/dev/other' }),
      makeKeyInput({ tsConfigFilePath: `${PROJECT_ROOT}/tsconfig.json` }),
      makeKeyInput({ indexerVersion: 'indexer/next' }),
      makeKeyInput({ extractors: EXTRACTORS.slice(0, EXTRACTORS.length - 1) }),
      makeKeyInput({ extractors: [...EXTRACTORS, 'delta'] }),
      makeKeyInput({ extractors: [...EXTRACTORS].reverse() }),
      makeKeyInput({ schemaVersion: INDEX_CACHE_SCHEMA_VERSION + 1 }),
    ];

    const keys = variants.map((variant) => computeIndexCacheEntryKey(variant));
    for (const key of keys) {
      expect(key).not.toBe(baseline);
    }
    // Pairwise distinct as well: no two identities share an entry.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not collide when the boundary between two identity parts moves', () => {
    expect(
      computeIndexCacheEntryKey(
        makeKeyInput({ projectRoot: '/work/a/b', tsConfigFilePath: '/c/tsconfig.json' }),
      ),
    ).not.toBe(
      computeIndexCacheEntryKey(
        makeKeyInput({ projectRoot: '/work/a', tsConfigFilePath: '/b/c/tsconfig.json' }),
      ),
    );
    expect(computeIndexCacheEntryKey(makeKeyInput({ extractors: ['ab', 'c'] }))).not.toBe(
      computeIndexCacheEntryKey(makeKeyInput({ extractors: ['a', 'bc'] })),
    );
  });

  it('normalises separators, so one directory has one entry', () => {
    expect(computeIndexCacheEntryKey(makeKeyInput({ projectRoot: 'C:\\work\\target' }))).toBe(
      computeIndexCacheEntryKey(makeKeyInput({ projectRoot: 'C:/work/target' })),
    );
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
    const index = makeIndex();

    const saved = await cache.save(makeKeyInput(), index);
    expect(isOk(saved)).toBe(true);

    await expect(cache.load(makeKeyInput())).resolves.toEqual(index);
  });

  it('leaves no temporary file behind after a successful save', async () => {
    expect(isOk(await cache.save(makeKeyInput(), makeIndex()))).toBe(true);

    // The atomic write creates a dotted temporary sibling and renames it over
    // the entry path, so a survivor would show up here — `readdir` lists
    // dotfiles — and would accumulate one stray file per save.
    expect(readdirSync(cacheDir)).toEqual([`${computeIndexCacheEntryKey(makeKeyInput())}.json`]);
  });

  it('keeps one entry per project across saves of different states', async () => {
    // Exactly what the product does to a project across sessions: its files
    // are edited, patched and restored, and every state is indexed and saved.
    // Each save replaces the project's one entry rather than adding a file
    // named after the state, so the directory holds one entry, and it answers
    // for the latest state.
    const [second, first] = FINGERPRINTS;
    if (first === undefined || second === undefined) {
      throw new Error('The fingerprint fixture must hold two entries.');
    }
    const states: readonly (readonly FileFingerprint[])[] = [
      FINGERPRINTS,
      [second, { ...first, mtimeMs: first.mtimeMs + 1_000 }],
      [second, { ...first, mtimeMs: first.mtimeMs + 2_000, size: first.size + 7 }],
      [...FINGERPRINTS, { file: 'src/third.ts', mtimeMs: 1_776_000_003_000, size: 64 }],
    ];

    for (const files of states) {
      const sorted = [...files].sort((left, right) => (left.file < right.file ? -1 : 1));
      const input = makeKeyInput({ files });
      expect(isOk(await cache.save(input, makeIndex({ files: sorted })))).toBe(true);
      expect(readdirSync(cacheDir)).toEqual([`${computeIndexCacheEntryKey(input)}.json`]);
      expect((await cache.load(input))?.files).toEqual(sorted);
    }
  });

  itPosix('creates the cache directory 0700 and the entry 0600', async () => {
    expect(isOk(await cache.save(makeKeyInput(), makeIndex()))).toBe(true);

    expect(modeOf(cacheDir)).toBe(SECURE_DIR_MODE);
    expect(modeOf(entryFileOf())).toBe(SECURE_FILE_MODE);
  });

  itPosix('recreates the cache directory when it was deleted between runs', async () => {
    expect(isOk(await cache.save(makeKeyInput(), makeIndex()))).toBe(true);

    // What the service's retention job does to the index cache of a project
    // that has not been opened lately.
    rmSync(cacheDir, { recursive: true, force: true });
    expect(existsSync(cacheDir)).toBe(false);

    expect(isOk(await cache.save(makeKeyInput(), makeIndex()))).toBe(true);
    expect(modeOf(cacheDir)).toBe(SECURE_DIR_MODE);
    expect(modeOf(entryFileOf())).toBe(SECURE_FILE_MODE);
    await expect(cache.load(makeKeyInput())).resolves.toBeDefined();
  });

  itPosix(
    'refuses a cache directory left over-permissive, and leaves its mode and contents alone',
    async () => {
      // Every directory of the state tree must already be private, and the
      // write refuses to proceed otherwise. A cache directory another account
      // could read is refused as it stands, never tightened, because the
      // developer is the one who has to judge what it may have exposed. The
      // mode is set with `chmod` so the fixture does not depend on the process
      // umask.
      mkdirSync(cacheDir, { recursive: true });
      chmodSync(cacheDir, OVER_PERMISSIVE_DIR_MODE);
      expect(modeOf(cacheDir)).toBe(OVER_PERMISSIVE_DIR_MODE);

      const result = await cache.save(makeKeyInput(), makeIndex());

      // A value, not an exception, and the policy code survives the wrapping,
      // as it does for a directory reached through a link.
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) {
        throw new Error('Expected an Err.');
      }
      expect(result.error.code).toBe('FS_UNSAFE_PATH');
      expect(result.error.details?.reason).toBe('cache-write-failed');
      expect(result.error.details?.key).toBe(computeIndexCacheEntryKey(makeKeyInput()));
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

  it('lets the last writer win for one project', async () => {
    const first = makeIndex({ projectRoot: '/home/dev/first' });
    const second = makeIndex({ projectRoot: '/home/dev/second' });

    await cache.save(makeKeyInput(), first);
    await cache.save(makeKeyInput(), second);

    const loaded = await cache.load(makeKeyInput());
    expect(loaded?.projectRoot).toBe('/home/dev/second');
    expect(readdirSync(cacheDir)).toEqual([`${computeIndexCacheEntryKey(makeKeyInput())}.json`]);
  });

  it('keys two project identities independently', async () => {
    const inputA = makeKeyInput();
    const inputB = makeKeyInput({ indexerVersion: 'indexer/other' });

    await cache.save(inputA, makeIndex({ projectRoot: '/home/dev/a' }));
    await cache.save(inputB, makeIndex({ projectRoot: '/home/dev/b' }));

    expect((await cache.load(inputA))?.projectRoot).toBe('/home/dev/a');
    expect((await cache.load(inputB))?.projectRoot).toBe('/home/dev/b');
    expect(readdirSync(cacheDir)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Every problem is a miss.
// ---------------------------------------------------------------------------

describe('load misses', () => {
  const input = makeKeyInput();
  const key = computeIndexCacheEntryKey(input);

  it('misses when the cache directory does not exist', async () => {
    expect(existsSync(cacheDir)).toBe(false);

    await expect(cache.load(input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('absent');
  });

  it('misses when the entry does not exist', async () => {
    mkdirSync(cacheDir, { recursive: true, mode: SECURE_DIR_MODE });

    await expect(cache.load(input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('absent');
  });

  it('misses when the cache directory was deleted after the entry was written', async () => {
    expect(isOk(await cache.save(input, makeIndex()))).toBe(true);
    await expect(cache.load(input)).resolves.toBeDefined();

    // Exactly what the service's retention job does to the index cache of a
    // project that has not been opened inside the retention window, and what a
    // developer does by removing `~/.debuggen`. The cache was constructed
    // against a directory that now does not exist, which is an ordinary state
    // rather than a failure.
    rmSync(cacheDir, { recursive: true, force: true });

    await expect(cache.load(input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('absent');
  });

  it('cannot reach an entry written under another indexer version', async () => {
    const otherVersion = makeKeyInput({ indexerVersion: 'indexer/2026.10.1' });
    expect(computeIndexCacheEntryKey(otherVersion)).not.toBe(key);

    expect(isOk(await cache.save(input, makeIndex()))).toBe(true);

    // The indexer version is folded into the entry key, so an index built by
    // another version is *unreachable* rather than read and refused — the
    // cheapest correct form of invalidation. And an ordinary absent miss must
    // not touch the entry it never read: a session asking under this
    // version's identity still finds its own entry afterwards.
    await expect(cache.load(otherVersion)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('absent');
    expect(existsSync(join(cacheDir, `${key}.json`))).toBe(true);
    await expect(cache.load(input)).resolves.toBeDefined();
  });

  it('never reads an entry an earlier envelope version named after its file state', async () => {
    // Version 2 named every entry after the state key, so each state of a
    // project left its own file behind. This version never derives such a
    // name, so those files are unreachable: `load` does not open them and does
    // not delete them either — removing them is the retention sweep's job, by
    // the version their envelope records.
    const legacy = writeRawEntry(
      computeIndexCacheKey(makeKeyInput({ schemaVersion: INDEX_CACHE_SCHEMA_VERSION - 1 })),
      JSON.stringify({
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION - 1,
        key: computeIndexCacheKey(makeKeyInput({ schemaVersion: INDEX_CACHE_SCHEMA_VERSION - 1 })),
        writtenAt: GENERATED_AT,
        index: makeIndex(),
        stamps: [],
      }),
    );

    await expect(cache.load(input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toEqual(['absent']);
    expect(existsSync(legacy)).toBe(true);

    // And the current version's entry sits beside it, under its own name.
    expect(isOk(await cache.save(input, makeIndex()))).toBe(true);
    await expect(cache.load(input)).resolves.toEqual(makeIndex());
  });

  it('misses on unparsable JSON and removes the entry', async () => {
    const path = writeRawEntry(key, '{ "schemaVersion": 1, "index": ');

    await expect(cache.load(input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('unparsable');
    expect(existsSync(path)).toBe(false);
  });

  it('misses on a wrong envelope schema version and removes the entry', async () => {
    for (const schemaVersion of [INDEX_CACHE_SCHEMA_VERSION - 1, INDEX_CACHE_SCHEMA_VERSION + 1]) {
      const path = writeRawEntry(key, JSON.stringify(makeEnvelope({ schemaVersion })));

      expect(await cache.load(input), String(schemaVersion)).toBeUndefined();
      expect(existsSync(path), String(schemaVersion)).toBe(false);
    }
    expect(reasonsOf(lines)).toEqual(['schema-version', 'schema-version']);
  });

  it('misses on a structurally invalid index and removes the entry', async () => {
    const path = writeRawEntry(
      key,
      JSON.stringify(
        makeEnvelope({
          index: { schemaVersion: CODE_INDEX_SCHEMA_VERSION, projectRoot: PROJECT_ROOT },
        }),
      ),
    );

    await expect(cache.load(input)).resolves.toBeUndefined();
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
      const path = writeRawEntry(key, JSON.stringify(makeEnvelope({ index })));

      expect(await cache.load(input), label).toBeUndefined();
      expect(existsSync(path), label).toBe(false);
    }

    expect(reasonsOf(lines)).toContain('malformed-index');
  });

  it('misses on a document that is not an envelope at all', async () => {
    const path = writeRawEntry(key, JSON.stringify([1, 2, 3]));

    await expect(cache.load(input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('malformed');
    expect(existsSync(path)).toBe(false);
  });

  it('misses when the envelope names another project', async () => {
    const otherKey = computeIndexCacheEntryKey(makeKeyInput({ indexerVersion: 'indexer/other' }));
    // Otherwise well-formed, so the document gets past the shape guard: the
    // key check runs before the freshness comparison, so this case exercises
    // the reason it was written for rather than being refused a step earlier.
    const path = writeRawEntry(key, JSON.stringify(makeEnvelope({ key: otherKey })));

    await expect(cache.load(input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('key-mismatch');
    expect(existsSync(path)).toBe(false);
  });

  it('misses on a state key that is not a digest and removes the entry', async () => {
    for (const stateKey of [undefined, '', 'not-a-key', 'A'.repeat(64), 42]) {
      const path = writeRawEntry(key, JSON.stringify(makeEnvelope({ stateKey })));

      expect(await cache.load(input), String(stateKey)).toBeUndefined();
      expect(existsSync(path), String(stateKey)).toBe(false);
    }
    expect(new Set(reasonsOf(lines))).toEqual(new Set(['malformed-state-key']));
  });

  it('misses when the graph vocabulary has moved on', async () => {
    // Well-formed for the same reason as the case above: the vocabulary check
    // also runs before the freshness comparison.
    const path = writeRawEntry(
      key,
      JSON.stringify(
        makeEnvelope({ index: makeIndex({ schemaVersion: CODE_INDEX_SCHEMA_VERSION + 1 }) }),
      ),
    );

    await expect(cache.load(input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('stale-vocabulary');
    expect(existsSync(path)).toBe(false);
  });

  it('misses rather than following a symbolic link planted at the entry path', async () => {
    const secret = join(stateRoot, 'elsewhere.json');
    const secretContents = JSON.stringify(makeEnvelope());
    writeFileSync(secret, secretContents, { mode: SECURE_FILE_MODE });

    mkdirSync(cacheDir, { recursive: true, mode: SECURE_DIR_MODE });
    const link = join(cacheDir, `${key}.json`);
    symlinkSync(secret, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    // A miss, not a throw, and not a read of the link's target.
    await expect(cache.load(input)).resolves.toBeUndefined();
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

    await expect(cache.load(input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('unreadable');
  });

  it('recovers from every kind of damage, so a miss is never terminal', async () => {
    const entryFile = join(cacheDir, `${key}.json`);
    const linkTarget = join(stateRoot, 'link-target.json');

    /**
     * One way the project's entry can be unusable, planted as real bytes on a
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
            JSON.stringify(makeEnvelope({ schemaVersion: INDEX_CACHE_SCHEMA_VERSION + 1 })),
          );
        },
      },
      {
        label: 'a structurally invalid index',
        plant: (): void => {
          writeRawEntry(
            key,
            JSON.stringify(makeEnvelope({ index: { schemaVersion: CODE_INDEX_SCHEMA_VERSION } })),
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
      expect(await cache.load(input), label).toBeUndefined();
      expect(isOk(await cache.save(input, index)), label).toBe(true);
      expect(existsSync(cacheDir), label).toBe(true);
      expect(await cache.load(input), label).toEqual(index);
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
      const result = await cache.save(makeKeyInput(), makeIndex());

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

    const result = await blocked.save(makeKeyInput(), makeIndex());

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

    const result = await cache.save(makeKeyInput(), makeIndex());

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

    const result = await cache.save(makeKeyInput(), makeIndex());

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
  it('evicts the entry of a project, whatever state it describes, and is idempotent', async () => {
    const saved = makeKeyInput();
    await cache.save(saved, makeIndex());
    expect(existsSync(entryFileOf(saved))).toBe(true);

    // Evicted through an input describing another state of the same project:
    // the file list is not consulted, because the project has one entry.
    await cache.evict(makeKeyInput({ files: [] }));
    expect(existsSync(entryFileOf(saved))).toBe(false);

    // A second eviction, and one against a directory that is not there, are
    // both successes: the caller is telling the cache what it must not serve,
    // not asking it to delete a file.
    await expect(cache.evict(saved)).resolves.toBeUndefined();
    rmSync(cacheDir, { recursive: true, force: true });
    await expect(cache.evict(saved)).resolves.toBeUndefined();
  });

  it('clears only its own entries', async () => {
    const inputA = makeKeyInput();
    const inputB = makeKeyInput({ indexerVersion: 'indexer/other' });
    await cache.save(inputA, makeIndex());
    await cache.save(inputB, makeIndex());

    // Two things that must survive: a file that is not an entry, and a
    // subdirectory, which `clear` must not descend into.
    const stranger = join(cacheDir, 'notes.txt');
    writeFileSync(stranger, 'keep me', { mode: SECURE_FILE_MODE });
    const nested = join(cacheDir, 'nested');
    mkdirSync(nested, { mode: SECURE_DIR_MODE });
    const nestedEntry = join(nested, `${computeIndexCacheEntryKey(inputA)}.json`);
    writeFileSync(nestedEntry, '{}', { mode: SECURE_FILE_MODE });

    // And one thing outside the cache directory entirely.
    const sibling = join(stateRoot, 'sessions.sqlite');
    writeFileSync(sibling, 'untouched', { mode: SECURE_FILE_MODE });

    await cache.clear();

    expect(existsSync(entryFileOf(inputA))).toBe(false);
    expect(existsSync(entryFileOf(inputB))).toBe(false);
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
// Entry names are digests, whatever the project spells.
// ---------------------------------------------------------------------------

describe('entry naming', () => {
  it('names every entry with a digest, so no project root can reach outside the directory', async () => {
    // Callers never compose a key: every operation derives the entry name from
    // the project identity, and that name is a `stableHash` digest. Roots that
    // spell traversal, separators of both kinds and a trailing slash all land
    // in the cache directory under a 64-character hexadecimal name.
    const roots = [
      '/work/../../etc',
      '..',
      'C:\\Users\\dev\\..\\..\\target',
      '/work/target/',
      `/${'x'.repeat(300)}`,
    ];

    for (const projectRoot of roots) {
      const input = makeKeyInput({ projectRoot });
      expect(isOk(await cache.save(input, makeIndex({ projectRoot })))).toBe(true);
      await expect(cache.load(input)).resolves.toBeDefined();
    }

    const names = readdirSync(cacheDir);
    expect(names).toHaveLength(roots.length);
    for (const name of names) {
      expect(name).toMatch(/^[0-9a-f]{64}\.json$/);
    }
    // Nothing was written beside the cache directory.
    expect(readdirSync(stateRoot)).toEqual(['index']);
  });

  it('touches nothing on disk until something is saved', async () => {
    await expect(cache.load(makeKeyInput())).resolves.toBeUndefined();
    await expect(cache.evict(makeKeyInput())).resolves.toBeUndefined();

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
// Freshness: the state key, the change stamps and the content digests.
//
// Two failure modes are on trial here, and they pull in opposite directions.
//
// A cache that trusts metadata too much serves stale code: `mtimeMs` and `size`
// can both survive a content substitution — `tar -x`, `cp -p`,
// `rsync --times`, `touch -r`, a hermetic build-cache restore — so a tree whose
// bytes were replaced under its old timestamps asks for the *same* state key.
// The recorded change stamp catches that (the kernel moves `ctimeMs` on every
// write), and the recorded digest then proves the bytes differ.
//
// A cache that trusts metadata too little never hits: the product's own
// reversible patch rewrites a file and its cleanup writes the original bytes
// back, which leaves every byte as it was and every timestamp moved. Such a
// tree asks for a *different* state key, and it must still be served — after
// one read of each touched file — with the entry refreshed so the next lookup
// is stat-only again.
//
// Misses are asserted *with their reason*, because a key that had accidentally
// changed would produce the same cold run for the wrong cause; hits are asserted
// with the number of files that had to be read, because a hit that re-read
// every file on every lookup would be correct and would defeat the module.
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
   * started — which would change the state key and leave the case proving
   * something other than what it names. An integer second round-trips bit for
   * bit, so a substitution really does hold `mtimeMs` and `size` still and
   * varies nothing but the bytes.
   */
  const FIXED_MTIME_SECONDS = 1_777_000_000;

  /** A later whole second, for the rewrites that must move the modification time. */
  const LATER_MTIME_SECONDS = FIXED_MTIME_SECONDS + 3_600;

  /** The body the sandbox project starts with. */
  const ALPHA_BODY = 'export function alpha(): number {\n  return 1;\n}\n';

  /**
   * The replacement body: a different declaration of **exactly** the same byte
   * length, which is what makes `size` survive the substitution.
   */
  const BETA_BODY = 'export function beta_(): number {\n  return 1;\n}\n';

  /** What the product's instrumentation might leave in a file while a session runs. */
  const PATCHED_BODY = `${ALPHA_BODY}// instrumented by a session\n`;

  /** The budget an indexing run here is given; a one-file project, but ts-morph still starts. */
  const RUN_TIMEOUT_MS = 30_000;

  /** Writes `contents` and pins the modification time to `seconds`. */
  function writeWithMtime(path: string, contents: string, seconds: number): void {
    writeFileSync(path, contents, { mode: SECURE_FILE_MODE });
    utimesSync(path, seconds, seconds);
  }

  /** Writes `contents` and pins the modification time, so a later restore is exact. */
  function writeWithFixedMtime(path: string, contents: string): void {
    writeWithMtime(path, contents, FIXED_MTIME_SECONDS);
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

  /** The key input and index for a one-file sandbox project, as they stand on disk now. */
  function describeOnDisk(root: string): {
    readonly input: IndexCacheKeyInput;
    readonly index: CodeIndex;
  } {
    const files: readonly FileFingerprint[] = [fingerprintOnDisk(root, 'src/a.ts')];
    return {
      input: makeKeyInput({ projectRoot: root, files }),
      index: makeIndex({ projectRoot: root, files }),
    };
  }

  it(
    'sees a substitution that preserved the modification time and size',
    async () => {
      // The fixture guard: a replacement of a different length would change
      // the state key's `size` part, and the case would miss for the wrong
      // reason.
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
      // unchanged too, and the tree therefore asks for the state key the entry
      // above was written under.
      const before = statSync(file);
      writeWithFixedMtime(file, BETA_BODY);
      const after = statSync(file);

      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.size).toBe(before.size);
      // The one thing userspace could not hold still: the kernel moved the
      // inode's change time, which sends the lookup to the digest.
      expect(after.ctimeMs).not.toBe(before.ctimeMs);

      const third = await indexOnce(root, 'third');
      expect(third.fromCache).toBe(false);
      expect(nodeNames(third.index)).toContain('beta_');
      expect(nodeNames(third.index)).not.toContain('alpha');
      // And it missed for the right reason. A miss recorded as `absent` would
      // mean the entry had moved after all — the same observable outcome,
      // reached without the digest proving anything.
      expect(reasonsOf(lines)).toContain('content-changed');

      // A stale entry is replaced rather than left to miss forever: the third
      // run wrote its own index over the project's one entry, so the fourth
      // run is a hit again.
      const fourth = await indexOnce(root, 'fourth');
      expect(fourth.fromCache).toBe(true);
      expect(nodeNames(fourth.index)).toContain('beta_');
      expect(readdirSync(cacheDir)).toHaveLength(1);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'serves a file that was patched and restored byte for byte, and refreshes the entry',
    async () => {
      // The case this design exists for, through the whole pipeline: a session
      // indexes the project, instrumentation patches a file, cleanup writes the
      // original bytes back. Nothing is indexed while the patch is in place —
      // the index is loaded when a session starts — so the next lookup sees the
      // original bytes under a new modification time and a new change time.
      const { root, file } = createSandboxProject('restored', ALPHA_BODY);

      const cold = await indexOnce(root, 'cold');
      expect(cold.fromCache).toBe(false);

      writeWithMtime(file, PATCHED_BODY, LATER_MTIME_SECONDS);
      writeWithMtime(file, ALPHA_BODY, LATER_MTIME_SECONDS + 1);
      expect(readFileSync(file, 'utf8')).toBe(ALPHA_BODY);
      expect(statSync(file).mtimeMs).not.toBe(FIXED_MTIME_SECONDS * 1000);

      const restored = await indexOnce(root, 'restored');
      expect(restored.fromCache).toBe(true);
      expect(nodeNames(restored.index)).toEqual(nodeNames(cold.index));
      // Served with the fingerprints of the tree as it is now — what a rebuild
      // of it would have recorded — rather than the ones it was built with.
      expect(restored.index.files).toEqual([fingerprintOnDisk(root, 'src/a.ts')]);
      // One file had to be read to prove it, and the entry was rewritten.
      expect(revalidatedCountsOf(lines)).toEqual([1]);

      // The refreshed entry answers the next lookup on the stat-only path.
      const next = await indexOnce(root, 'next');
      expect(next.fromCache).toBe(true);
      expect(revalidatedCountsOf(lines)).toEqual([1, 0]);
      expect(readdirSync(cacheDir)).toHaveLength(1);
    },
    RUN_TIMEOUT_MS,
  );

  it('hits when nothing under a real project root has changed', async () => {
    const { root } = createSandboxProject('unchanged', ALPHA_BODY);
    const { input, index } = describeOnDisk(root);

    expect(isOk(await cache.save(input, index))).toBe(true);

    // The regression this guards: a verification that compared something a
    // second `stat` cannot reproduce — an access time, a clock — would make
    // every hit a miss and turn the cache off. And an untouched tree must not
    // be read at all: the stat-only path answers it.
    await expect(cache.load(input)).resolves.toEqual(index);
    expect(reasonsOf(lines)).toEqual([]);
    expect(revalidatedCountsOf(lines)).toEqual([0]);
  });

  it('records the digest of every file it can read, and none for one it cannot', async () => {
    const { root } = createSandboxProject('recorded', ALPHA_BODY);
    const { input, index } = describeOnDisk(root);
    const withGhost = makeIndex({
      projectRoot: root,
      files: [...index.files, { file: 'src/ghost.ts', mtimeMs: 1, size: 1 }],
    });

    expect(isOk(await cache.save(input, withGhost))).toBe(true);

    const [real, ghost] = recordedStampsAt(entryFileOf(input));
    // The SHA-256 of the bytes on disk — what `sha256OfFile` computes, so a
    // `hashContents` fingerprint compares with it directly.
    expect(real?.contentHash).toBe(createHash('sha256').update(ALPHA_BODY).digest('hex'));
    expect(real?.present).toBe(true);
    // A file that is not there has nothing to hash: absent, no digest.
    expect(ghost).toEqual({
      file: 'src/ghost.ts',
      present: false,
      mtimeMs: 0,
      size: 0,
      ctimeMs: 0,
      ino: 0,
      contentHash: '',
    });
  });

  it('hits for an index over files that do not exist on disk', async () => {
    // A caller may cache an index it synthesised — a fixture, a projection, a
    // tree that has since been removed — and several cases in this file do
    // exactly that with `makeIndex()`, whose fingerprints name paths under a
    // project root that was never created. An absent stamp compares equal to
    // an absent stamp, so such an entry round-trips on the fast path.
    const index = makeIndex();
    expect(existsSync(index.projectRoot)).toBe(false);

    expect(isOk(await cache.save(makeKeyInput(), index))).toBe(true);

    await expect(cache.load(makeKeyInput())).resolves.toEqual(index);
    expect(reasonsOf(lines)).toEqual([]);
  });

  it('hits when a file was rewritten with identical bytes under its old timestamp', async () => {
    const { root, file } = createSandboxProject('touched', ALPHA_BODY);
    const { input, index } = describeOnDisk(root);

    expect(isOk(await cache.save(input, index))).toBe(true);
    const recordedCtime = recordedStampsAt(entryFileOf(input))[0]?.ctimeMs;

    // The same bytes rewritten, with the modification time restored: the
    // state key is unchanged and the change stamp is not. The digest proves
    // the file still says what the index describes, so this is a hit — where
    // a stat-only check would have failed closed and paid for a rebuild that
    // produces the same index.
    writeWithFixedMtime(file, ALPHA_BODY);
    expect(statSync(file).ctimeMs).not.toBe(recordedCtime);

    await expect(cache.load(input)).resolves.toEqual(index);
    expect(reasonsOf(lines)).toEqual([]);
    expect(revalidatedCountsOf(lines)).toEqual([1]);

    // The entry now records the stamp the file carries, so the next lookup
    // does not read it again.
    expect(recordedStampsAt(entryFileOf(input))[0]?.ctimeMs).toBe(statSync(file).ctimeMs);
    await expect(cache.load(input)).resolves.toEqual(index);
    expect(revalidatedCountsOf(lines)).toEqual([1, 0]);
  });

  it('hits when a file was rewritten with identical bytes under a new timestamp', async () => {
    const { root, file } = createSandboxProject('rewritten', ALPHA_BODY);
    const saved = describeOnDisk(root);
    expect(isOk(await cache.save(saved.input, saved.index))).toBe(true);

    // A patch and its byte-for-byte restore, at the cache's level: the lookup
    // now fingerprints the file under its new modification time, which is a
    // different state key, and the same project's one entry answers it.
    writeWithMtime(file, PATCHED_BODY, LATER_MTIME_SECONDS);
    writeWithMtime(file, ALPHA_BODY, LATER_MTIME_SECONDS + 1);
    const now = describeOnDisk(root);
    expect(computeIndexCacheKey(now.input)).not.toBe(computeIndexCacheKey(saved.input));
    expect(computeIndexCacheEntryKey(now.input)).toBe(computeIndexCacheEntryKey(saved.input));

    const served = await cache.load(now.input);
    expect(served).toEqual({ ...saved.index, files: now.input.files });
    expect(revalidatedCountsOf(lines)).toEqual([1]);

    // Refreshed: the recorded state key is the current one, so the next
    // lookup takes the fast path, and there is still exactly one entry.
    await expect(cache.load(now.input)).resolves.toEqual(served);
    expect(revalidatedCountsOf(lines)).toEqual([1, 0]);
    expect(readdirSync(cacheDir)).toEqual([`${computeIndexCacheEntryKey(now.input)}.json`]);
  });

  it('misses when a rewritten file holds different bytes, and removes the entry', async () => {
    const { root, file } = createSandboxProject('edited', ALPHA_BODY);
    const saved = describeOnDisk(root);
    expect(isOk(await cache.save(saved.input, saved.index))).toBe(true);

    writeWithMtime(file, BETA_BODY, LATER_MTIME_SECONDS);
    const now = describeOnDisk(root);

    await expect(cache.load(now.input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('content-changed');
    expect(existsSync(entryFileOf(now.input))).toBe(false);
  });

  it('misses while a patch is in place and serves the original again once it is restored', async () => {
    const { root, file } = createSandboxProject('patched', ALPHA_BODY);
    const saved = describeOnDisk(root);
    expect(isOk(await cache.save(saved.input, saved.index))).toBe(true);

    // Asked while patched: different bytes, so a miss. The miss removes the
    // entry, as every rejection does, and the caller would now rebuild.
    writeWithMtime(file, PATCHED_BODY, LATER_MTIME_SECONDS);
    await expect(cache.load(describeOnDisk(root).input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('content-changed');

    // Restored and re-saved from the rebuild of the restored tree: served.
    writeWithMtime(file, ALPHA_BODY, LATER_MTIME_SECONDS + 1);
    const restored = describeOnDisk(root);
    expect(isOk(await cache.save(restored.input, restored.index))).toBe(true);
    await expect(cache.load(restored.input)).resolves.toEqual(restored.index);
    expect(readdirSync(cacheDir)).toHaveLength(1);
  });

  it('misses when the file set changed, whatever the bytes of the files it kept', async () => {
    const { root } = createSandboxProject('grown', ALPHA_BODY);
    const saved = describeOnDisk(root);
    expect(isOk(await cache.save(saved.input, saved.index))).toBe(true);

    // A new file appeared: the index has never seen it, so no digest of the
    // old files can make the entry whole.
    writeWithFixedMtime(join(root, 'src', 'b.ts'), BETA_BODY);
    const grown = makeKeyInput({
      projectRoot: root,
      files: [fingerprintOnDisk(root, 'src/a.ts'), fingerprintOnDisk(root, 'src/b.ts')],
    });
    await expect(cache.load(grown)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('file-set-changed');

    // And a lookup that no longer lists a file the index names is the same
    // kind of miss.
    expect(isOk(await cache.save(saved.input, saved.index))).toBe(true);
    await expect(
      cache.load(makeKeyInput({ projectRoot: root, files: [] })),
    ).resolves.toBeUndefined();
    expect(reasonsOf(lines).filter((reason) => reason === 'file-set-changed')).toHaveLength(2);
  });

  it('misses when a file that was stamped has since been removed', async () => {
    const { root, file } = createSandboxProject('deleted', ALPHA_BODY);
    const { input, index } = describeOnDisk(root);

    expect(isOk(await cache.save(input, index))).toBe(true);

    // A file that was present when the entry was written and is not present
    // now: the asymmetric case, and the one an absent-compares-equal-to-absent
    // rule must not swallow. The lookup still names it, so the file set is the
    // same, and the file cannot be read to prove anything.
    rmSync(file, { force: true });

    await expect(cache.load(input)).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('stale-file');
    expect(existsSync(entryFileOf(input))).toBe(false);
  });

  it('never serves an index whose file changed between the build and the save', async () => {
    const { root, file } = createSandboxProject('raced', ALPHA_BODY);
    // The index — and the lookup before it — saw the original file, and the
    // developer saved a new version before the entry was written. The bytes
    // on disk are not the bytes the index describes, so `save` must not record
    // a stamp or a digest that would vouch for them.
    const built = describeOnDisk(root);
    writeWithMtime(file, BETA_BODY, LATER_MTIME_SECONDS);

    expect(isOk(await cache.save(built.input, built.index))).toBe(true);
    expect(recordedStampsAt(entryFileOf(built.input))[0]?.contentHash).toBe('');

    // Neither the lookup that matches the build nor one that matches the disk
    // is served the stale index.
    await expect(cache.load(built.input)).resolves.toBeUndefined();
    expect(isOk(await cache.save(built.input, built.index))).toBe(true);
    await expect(cache.load(describeOnDisk(root).input)).resolves.toBeUndefined();
    expect(reasonsOf(lines).filter((reason) => reason === 'stale-file')).toHaveLength(2);
  });

  it('misses on an entry with no stamps at all and removes it', async () => {
    const key = computeIndexCacheEntryKey(makeKeyInput());
    // What a hand-edited or truncated document tends to look like: the index
    // still parses and the key still matches, and the freshness evidence is
    // gone.
    const document = makeEnvelope();
    delete document.stamps;
    const path = writeRawEntry(key, JSON.stringify(document));

    await expect(cache.load(makeKeyInput())).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('malformed-stamps');
    expect(existsSync(path)).toBe(false);

    // Recovered, like every other kind of damage in this file.
    const index = makeIndex();
    expect(isOk(await cache.save(makeKeyInput(), index))).toBe(true);
    await expect(cache.load(makeKeyInput())).resolves.toEqual(index);
  });

  it('misses on malformed stamps and removes the entry', async () => {
    const key = computeIndexCacheEntryKey(makeKeyInput());
    const stamp = {
      file: 'src/first.ts',
      present: true,
      mtimeMs: 1,
      size: 2,
      ctimeMs: 3,
      ino: 4,
      contentHash: 'e'.repeat(64),
    };
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
        stamps: [{ ...stamp, mtimeMs: null }],
      },
      {
        // Exactly what a version-2 stamp looks like: comparable, but with no
        // digest to fall back on once its file is touched.
        label: 'a stamp without a content hash',
        stamps: [{ file: 'src/first.ts', present: true, mtimeMs: 1, size: 2, ctimeMs: 3, ino: 4 }],
      },
      { label: 'a content hash that is not a digest', stamps: [{ ...stamp, contentHash: 'x' }] },
      {
        label: 'a content hash in upper case',
        stamps: [{ ...stamp, contentHash: 'E'.repeat(64) }],
      },
    ];

    for (const { label, stamps } of damaged) {
      const path = writeRawEntry(key, JSON.stringify(makeEnvelope({ stamps })));

      expect(await cache.load(makeKeyInput()), label).toBeUndefined();
      expect(existsSync(path), label).toBe(false);
    }

    expect(new Set(reasonsOf(lines))).toEqual(new Set(['malformed-stamps']));
  });

  it('misses when the stamps do not cover the files the index names', async () => {
    const key = computeIndexCacheEntryKey(makeKeyInput());
    // Well-formed stamps, but not the ones this index's file list would
    // produce: a shorter list than `files`, which is what a truncated write or
    // a hand-assembled document looks like. There is nothing to compare the
    // uncovered file against, so the entry goes.
    const path = writeRawEntry(
      key,
      JSON.stringify(
        makeEnvelope({
          stamps: [
            {
              file: 'src/first.ts',
              present: false,
              mtimeMs: 0,
              size: 0,
              ctimeMs: 0,
              ino: 0,
              contentHash: '',
            },
          ],
        }),
      ),
    );

    await expect(cache.load(makeKeyInput())).resolves.toBeUndefined();
    expect(reasonsOf(lines)).toContain('stale-file');
    expect(existsSync(path)).toBe(false);
  });
});
