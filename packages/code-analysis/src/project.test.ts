/**
 * Tests for `./project.ts`: the module that decides which files of a
 * developer's project this package is allowed to read.
 *
 * Everything below protects one of two contracts, and the file is organised so
 * that a reader can tell which one a failing case belongs to.
 *
 * ## 1. Containment — the security contract
 *
 * The indexer's file set is built by walking the project root, and a path can
 * be *lexically* inside that root while the bytes behind it come from anywhere
 * the developer's account can read:
 *
 * - a symlinked **directory** (`<root>/vendored -> <outside>`) presents an
 *   entire external tree under the root, every file of which has an ordinary
 *   final component, so a check that asks only "is the last component a link?"
 *   sees nothing wrong;
 * - a symlinked **file** (`<root>/src/lib/settings.ts -> <root>/.env`) carries
 *   an indexable basename while its content is an environment file, which the
 *   product's privacy model says the indexer never reads.
 *
 * The first four groups are that regression, and each one asserts the file was
 * **never loaded** — absent from `sourceFiles()` *and* from
 * `loaded.project.getSourceFiles()`, with the planted marker text present in no
 * loaded file at all. Asserting only the first would pass against an
 * implementation that reads a file and then hides it, which is not the
 * guarantee: content that reached the compiler has reached memory, and from
 * there a summary, a prompt or a log.
 *
 * Three of those cases go further and assert the external tree was never
 * *enumerated*: the refusal record names the link, once, and no record anywhere
 * mentions a single entry from behind it. That is the difference between a
 * traversal that refuses a directory link before descending and one that
 * descends, lists an arbitrary tree and refuses each entry afterwards — the
 * second is what every available glob layer does, and it is why discovery is
 * this module's own walk.
 *
 * The fourth group is the other half of the same contract, and it is why the
 * screen resolves rather than refuses: a link whose target is an ordinary
 * source file *inside* the project stays indexed, and a project root that is
 * itself reached through a symbolic link — an ordinary checkout under a linked
 * home directory, and every `mkdtemp` sandbox on a platform that links its
 * temporary path — indexes normally instead of refusing every one of its files.
 *
 * One refusal class the screen implements has no fixture here, and the omission
 * is deliberate rather than an oversight: `unresolvable` (a candidate whose
 * `realpath` fails) covers the window between discovery and screening, and
 * discovery already refuses an entry whose target cannot be stat'ed — a
 * dangling link, a link cycle — so no plantable fixture reaches that branch
 * through `openProject` on a POSIX host. It is asserted indirectly: the
 * *reachable* cases below all refuse, and none of them depends on a resolution
 * error to do so.
 *
 * ## 2. The file-set contract — what every consumer of the handle relies on
 *
 * The remaining groups pin the behaviour the rest of the package is written
 * against: the exact file set of the fixture corpus and its deterministic
 * byte-wise order, `projectRelative` round-tripping, the target's `paths`
 * aliases resolving through the loaded project, generated and vendored trees
 * staying out even when the target's own `tsconfig.json` is widened to
 * `include: ["**\/*"]`, and each documented failure returning `Err` with the
 * documented code and `details.reason` rather than throwing.
 *
 * ## Three habits, each deliberate
 *
 * - **Every fixture is built in an OS temp directory at test time.** Nothing is
 *   created under `test/fixtures/**` and no symbolic link is ever committed: a
 *   committed link is a path that means something different in every checkout,
 *   and a committed `.env` is a committed secret however synthetic. Where a
 *   realistic project is needed, `test/fixtures/sample-next-app` is *copied*
 *   into the sandbox and planted into there.
 * - **The sandbox is resolved through `realpath`.** On a platform whose
 *   temporary directory is reached through a link, an unresolved sandbox path
 *   would make the symlinked-root case indistinguishable from the ordinary one
 *   and would hide a regression in exactly the code these tests cover.
 * - **The symlink groups are guarded by capability, not by platform name.**
 *   Creating a link can fail for want of privilege rather than for want of a
 *   POSIX kernel, so the guard *tries* it once and skips on the outcome.
 *
 * Planted payloads are obviously synthetic markers. The case that stands in for
 * a developer's environment file writes a name that says it is not a secret,
 * because a realistic-looking secret in a committed test is still a secret in
 * the repository.
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isErr, joinPosix, toPosix } from '@debuggen/shared';
import type { DebuggenError, LogFields, LogLevel, Logger } from '@debuggen/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXCLUDED_DIRECTORY_NAMES,
  INDEXABLE_EXTENSIONS,
  isEnvFilePath,
  isIndexableFile,
  openProject,
  shouldExcludePath,
} from './project.js';
import type { LoadedProject, OpenProjectOptions } from './project.js';

/*
 * ---------------------------------------------------------------------------
 * Capability guard
 * ---------------------------------------------------------------------------
 */

/**
 * Whether this host cannot create a symbolic link, and the symlink groups
 * therefore have nothing to assert.
 *
 * The capability form of the question, not the platform form: `symlink` fails
 * with `EPERM` on a Windows host without the privilege and with `EPERM` or
 * `ENOSYS` on some sandboxed filesystems, none of which is predictable from
 * `process.platform`. So the probe *creates* one in its own throwaway
 * directory and answers on the outcome.
 */
const SYMLINKS_UNAVAILABLE = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'debuggen-project-linkprobe-'));
  try {
    writeFileSync(join(probe, 'target.ts'), 'export const PROBE = 1;\n');
    symlinkSync(join(probe, 'target.ts'), join(probe, 'link.ts'));
    return false;
  } catch {
    return true;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/*
 * ---------------------------------------------------------------------------
 * The corpus and the planted payloads
 * ---------------------------------------------------------------------------
 */

/**
 * The read-only indexing corpus: a generic Next.js application that exists to
 * be indexed.
 *
 * Copied, never opened in place. A case that planted into the checkout would
 * leave the repository dirty and would make the next run's expectations depend
 * on the previous run's leftovers.
 */
const FIXTURE_ROOT = fileURLToPath(new URL('../test/fixtures/sample-next-app', import.meta.url));

/**
 * Every indexable file of the corpus, project-relative, in the order
 * `sourceFiles()` must return them.
 *
 * Written out in full rather than derived from a directory walk: a derived
 * expectation agrees with whatever the implementation does, including dropping
 * a file. The order is the module's byte-wise comparison of these same strings,
 * and one case below proves this literal is in that order rather than trusting
 * that it was typed correctly.
 */
const EXPECTED_FIXTURE_FILES: readonly string[] = [
  'app/(observatory)/api/basins/[...segments]/route.ts',
  'app/(observatory)/basins/[id]/page.tsx',
  'app/api/gauges/[id]/route.ts',
  'app/api/gauges/route.ts',
  'app/layout.tsx',
  'app/page.tsx',
  'next.config.mjs',
  'pages/api/gauge-log.ts',
  'src/lib/datastore.ts',
  'src/lib/http.ts',
  'src/lib/station-service.ts',
  'src/lib/stubs/pg.ts',
  'src/lib/stubs/prisma-client.ts',
  'src/widgets/BasinSummary.tsx',
  'src/widgets/GaugeReadout.tsx',
  'src/widgets/index.ts',
];

/**
 * The marker planted in a file that lives outside the project.
 *
 * Its only job is to be findable: every containment case asserts this string
 * appears in no loaded source file, which is a stronger statement than "the
 * path is absent from the list" — it fails even if the content arrived under
 * some other path.
 */
const OUTSIDE_MARKER = 'OUTSIDE_PROJECT_MARKER_MUST_NOT_BE_INDEXED';

/** The marker planted in the project's own environment file. Synthetic, and says so. */
const ENV_MARKER = 'SYNTHETIC_ENV_MARKER_NOT_A_SECRET';

/** The marker planted in a generated or vendored tree that must never be indexed. */
const GENERATED_MARKER = 'GENERATED_TREE_MARKER_MUST_NOT_BE_INDEXED';

/*
 * ---------------------------------------------------------------------------
 * Sandbox
 * ---------------------------------------------------------------------------
 */

/**
 * The current test's sandbox: an absolute, symlink-free path to an empty
 * directory.
 *
 * Initialised to the empty string rather than with a definite-assignment
 * assertion, so a case that somehow ran without `beforeEach` fails on an
 * obviously wrong path instead of on an undefined one.
 */
let sandbox = '';

beforeEach(() => {
  // `realpath` matters here for the same reason it matters in the module: a
  // temporary directory reached through a link would otherwise make every
  // project a "symlinked root" project, and the case that exists to cover that
  // shape would stop covering anything.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-project-')));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/** Creates a directory (and any missing parent) inside the sandbox. */
function makeDir(pathAbs: string): string {
  mkdirSync(pathAbs, { recursive: true });
  return pathAbs;
}

/** Writes a file inside the sandbox, creating its directory chain first. */
function plantFile(pathAbs: string, contents: string): string {
  mkdirSync(dirname(pathAbs), { recursive: true });
  writeFileSync(pathAbs, contents);
  return pathAbs;
}

/** A module whose only content is the given marker, so it is findable by text. */
function moduleNaming(marker: string): string {
  return `export const MARKER = '${marker}';\n`;
}

/** The absolute POSIX path of a project-relative path inside `rootAbs`. */
function absoluteIn(rootAbs: string, relativePath: string): string {
  return joinPosix(toPosix(rootAbs), relativePath);
}

/**
 * Copies the corpus into the sandbox and returns the copy's root.
 *
 * @param name The directory name to copy into, relative to the sandbox. Named
 * per case so a case that needs two projects — the symlinked-root case does —
 * can have them.
 */
function copyCorpusInto(name: string): string {
  const root = join(sandbox, name);
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return root;
}

/** One log record a {@link createRecordingLogger} logger captured. */
interface RecordedLog {
  /** The severity the record was emitted at. */
  readonly level: LogLevel;

  /** The message text, which is what the assertions match on. */
  readonly message: string;

  /** The structured fields, or `undefined` when the call passed none. */
  readonly fields: LogFields | undefined;
}

/** A logger that keeps every record, and the list it keeps them in. */
interface RecordingLogger {
  /** Pass this to {@link openProject}. */
  readonly logger: Logger;

  /** Everything the logger was asked to emit, in order. */
  readonly records: readonly RecordedLog[];
}

/**
 * A logger that records instead of printing.
 *
 * The refusals this module reports are part of its contract — a developer whose
 * link was refused has to be able to find out why — so several cases assert on
 * the record rather than only on the file set. `level` is `trace` so nothing is
 * filtered before it is recorded, and `child` returns the same logger because
 * no case asserts on bindings and one flat list is easier to search.
 */
function createRecordingLogger(): RecordingLogger {
  const records: RecordedLog[] = [];

  const capture =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields });
    };

  const logger: Logger = {
    level: 'trace',
    trace: capture('trace'),
    debug: capture('debug'),
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    fatal: capture('fatal'),
    child: () => logger,
  };

  return { logger, records };
}

/** The records of one severity whose message contains `fragment`. */
function recordsMatching(
  records: readonly RecordedLog[],
  level: LogLevel,
  fragment: string,
): readonly RecordedLog[] {
  return records.filter((record) => record.level === level && record.message.includes(fragment));
}

/**
 * The single record of one severity containing `fragment`, failing the case
 * when there is not exactly one.
 *
 * "Exactly one" is the assertion that matters for a refusal: a class reported
 * twice means the two screening passes both fired on the same file, which would
 * mean the first one did not prevent the read.
 */
function singleRecordMatching(
  records: readonly RecordedLog[],
  level: LogLevel,
  fragment: string,
): RecordedLog {
  const matches = recordsMatching(records, level, fragment);
  const first = matches[0];
  if (matches.length === 1 && first !== undefined) {
    return first;
  }
  return expect.unreachable(
    `expected exactly one ${level} record containing '${fragment}', found ${matches.length} in: ${records
      .map((record) => `${record.level}: ${record.message}`)
      .join(' | ')}`,
  );
}

/**
 * Opens a project the case expects to succeed, or fails the case with the
 * error's code and message.
 *
 * Every failure of this module is a value rather than an exception, so a case
 * that simply dereferenced the result would report "cannot read property of
 * undefined" instead of the reason the project did not open.
 */
function openOrFail(options: OpenProjectOptions): LoadedProject {
  const opened = openProject(options);
  if (isErr(opened)) {
    return expect.unreachable(
      `openProject was expected to succeed and failed with ${opened.error.code}: ${opened.error.message}`,
    );
  }
  return opened.value;
}

/** The `DebuggenError` of a case that expects `openProject` to refuse. */
function refusalFrom(options: OpenProjectOptions): DebuggenError {
  const opened = openProject(options);
  if (isErr(opened)) {
    return opened.error;
  }
  return expect.unreachable('openProject was expected to fail and returned a project instead');
}

/** The project-relative paths of the handle's file set, in the order it returns them. */
function relativePathsOf(loaded: LoadedProject): string[] {
  return loaded
    .sourceFiles()
    .map(
      (sourceFile) => loaded.projectRelative(sourceFile.getFilePath()) ?? sourceFile.getFilePath(),
    );
}

/**
 * Every path the *compiler* holds, which is the stronger question.
 *
 * `sourceFiles()` is this module's judged set; `project.getSourceFiles()` is
 * what was actually read. A containment case has to assert on both, because a
 * file that is in the second and not the first has still been read.
 */
function loadedPathsOf(loaded: LoadedProject): string[] {
  return loaded.project.getSourceFiles().map((sourceFile): string => sourceFile.getFilePath());
}

/** The text of every file the compiler holds, for a marker search. */
function loadedTextOf(loaded: LoadedProject): string {
  return loaded.project
    .getSourceFiles()
    .map((sourceFile) => sourceFile.getFullText())
    .join('\n');
}

/**
 * Asserts a path was never read: absent from the judged set, absent from the
 * compiler, and its marker present in no loaded file.
 *
 * @param loaded The opened project.
 * @param relativePath The project-relative path that must be absent.
 * @param marker The text planted in the file behind that path.
 */
function expectNeverLoaded(loaded: LoadedProject, relativePath: string, marker: string): void {
  expect(relativePathsOf(loaded)).not.toContain(relativePath);
  expect(loadedPathsOf(loaded)).not.toContain(absoluteIn(loaded.projectRoot, relativePath));
  expect(loadedTextOf(loaded)).not.toContain(marker);
}

/*
 * ---------------------------------------------------------------------------
 * Containment: a regular file reached through a symlinked directory
 *
 * The case the previous implementation could not see at all: the candidate's
 * final component is an ordinary file, so nothing about it is a link, and only
 * resolving the *whole* path reveals that the directory above it leaves the
 * project.
 * ---------------------------------------------------------------------------
 */

describe('openProject: a regular file reached through a symlinked directory', () => {
  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'never loads a file behind a link at the project root (requires symlink support)',
    () => {
      const root = copyCorpusInto('app');
      const outside = makeDir(join(sandbox, 'outside'));
      plantFile(join(outside, 'harvested.ts'), moduleNaming(OUTSIDE_MARKER));
      symlinkSync(outside, join(root, 'vendored'));

      const recorder = createRecordingLogger();
      const loaded = openOrFail({ projectRoot: root, logger: recorder.logger });

      expectNeverLoaded(loaded, 'vendored/harvested.ts', OUTSIDE_MARKER);
      // The corpus itself is unaffected: a containment refusal must cost one
      // file, not the index.
      expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);

      // The refusal is the *link*, reported once, and not the file behind it —
      // which is the observable difference between refusing a directory link
      // and enumerating what it points at and refusing each entry.
      const refusal = singleRecordMatching(recorder.records, 'warn', 'directory links were not');
      expect(refusal.fields?.count).toBe(1);
      expect(refusal.fields?.files).toEqual(['vendored']);
      // The link's own path is reportable; its resolved target is the
      // developer's filesystem layout and must not be logged.
      expect(JSON.stringify(refusal.fields)).not.toContain(outside);
    },
  );

  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'never enumerates what the link points at, whatever it holds (requires symlink support)',
    () => {
      // The strongest form of the property, and the reason discovery does not
      // go through a glob layer: the external tree is not merely refused after
      // being listed, it is never listed. Three files and a subdirectory
      // outside; a mechanism that descended and then refused would report
      // three refusals and name them, so asserting "one refusal, naming the
      // link" is what distinguishes the two.
      const root = copyCorpusInto('app');
      const outside = makeDir(join(sandbox, 'outside', 'nested'));
      plantFile(join(outside, '..', 'one.ts'), moduleNaming(OUTSIDE_MARKER));
      plantFile(join(outside, 'two.ts'), moduleNaming(OUTSIDE_MARKER));
      plantFile(join(outside, 'three.tsx'), moduleNaming(OUTSIDE_MARKER));
      symlinkSync(join(sandbox, 'outside'), join(root, 'src', 'vendored'));

      const recorder = createRecordingLogger();
      const loaded = openOrFail({ projectRoot: root, logger: recorder.logger });

      expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);
      expect(loadedTextOf(loaded)).not.toContain(OUTSIDE_MARKER);

      const refusal = singleRecordMatching(recorder.records, 'warn', 'directory links were not');
      expect(refusal.fields?.count).toBe(1);
      expect(refusal.fields?.files).toEqual(['src/vendored']);

      // No record anywhere mentions an entry from inside that tree, so nothing
      // in it was ever named, counted or judged.
      const everything = JSON.stringify(recorder.records);
      for (const name of ['one.ts', 'two.ts', 'three.tsx', 'nested']) {
        expect(everything).not.toContain(name);
      }
    },
  );

  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'never enumerates a directory link whose own name looks like a module (requires symlink support)',
    () => {
      // The shape that defeats a glob layer's "`**` does not cross links"
      // rule: the link's own name matches an indexable pattern, so a matcher
      // enters it. The traversal here decides on the directory *entry*, which
      // is not a directory entry for any link, whatever it is named.
      const root = copyCorpusInto('app');
      const outside = makeDir(join(sandbox, 'outside'));
      plantFile(join(outside, 'harvested.ts'), moduleNaming(OUTSIDE_MARKER));
      symlinkSync(outside, join(root, 'src', 'vendored.ts'));

      const recorder = createRecordingLogger();
      const loaded = openOrFail({ projectRoot: root, logger: recorder.logger });

      expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);
      expect(loadedTextOf(loaded)).not.toContain(OUTSIDE_MARKER);
      expect(JSON.stringify(recorder.records)).not.toContain('harvested');

      const refusal = singleRecordMatching(recorder.records, 'warn', 'directory links were not');
      expect(refusal.fields?.files).toEqual(['src/vendored.ts']);
    },
  );

  it('never hands a real directory named like a module to the compiler', () => {
    // No link involved, and no privacy question: a directory legitimately
    // named `<name>.ts` must be an ordinary exclusion rather than a failed
    // open, which is what reading a directory as a file would produce.
    const root = copyCorpusInto('app');
    makeDir(join(root, 'src', 'shipped.ts'));
    plantFile(join(root, 'src', 'shipped.ts', 'inner.ts'), 'export const INNER = 1;\n');

    const loaded = openOrFail({ projectRoot: root });

    // The file inside it is ordinary source and is indexed; the directory
    // itself never appears, and the set stays in byte-wise order.
    expect(relativePathsOf(loaded)).toEqual(
      [...EXPECTED_FIXTURE_FILES, 'src/shipped.ts/inner.ts'].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
    expect(relativePathsOf(loaded)).not.toContain('src/shipped.ts');
  });

  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'does not follow a directory link that points inside the project either, and loses nothing by it (requires symlink support)',
    () => {
      // A link to a directory *inside* the project is not a containment
      // failure, and it is still not followed — every file it reaches has a
      // real path of its own inside the project, which the traversal visits
      // directly. So the file set is the corpus exactly: nothing lost, and no
      // file counted twice under two spellings.
      const root = copyCorpusInto('app');
      symlinkSync(join(root, 'src', 'lib'), join(root, 'src', 'lib-alias'));

      const recorder = createRecordingLogger();
      const loaded = openOrFail({ projectRoot: root, logger: recorder.logger });

      expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);
      const refusal = singleRecordMatching(recorder.records, 'warn', 'directory links were not');
      expect(refusal.fields?.files).toEqual(['src/lib-alias']);
    },
  );

  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'never loads a file behind a link nested deep in the source tree (requires symlink support)',
    () => {
      const root = copyCorpusInto('app');
      const outside = makeDir(join(sandbox, 'elsewhere', 'shared'));
      plantFile(join(outside, 'borrowed.ts'), moduleNaming(OUTSIDE_MARKER));
      symlinkSync(outside, join(root, 'src', 'lib', 'shared'));

      const loaded = openOrFail({ projectRoot: root });

      expectNeverLoaded(loaded, 'src/lib/shared/borrowed.ts', OUTSIDE_MARKER);
      expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);
    },
  );

  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'never loads a file behind two chained links (requires symlink support)',
    () => {
      const root = copyCorpusInto('app');
      const outside = makeDir(join(sandbox, 'outside'));
      plantFile(join(outside, 'harvested.ts'), moduleNaming(OUTSIDE_MARKER));
      // `<root>/vendored -> <sandbox>/hop -> <sandbox>/outside`: resolution has
      // to follow the whole chain, not one hop of it.
      symlinkSync(outside, join(sandbox, 'hop'));
      symlinkSync(join(sandbox, 'hop'), join(root, 'vendored'));

      const loaded = openOrFail({ projectRoot: root });

      expectNeverLoaded(loaded, 'vendored/harvested.ts', OUTSIDE_MARKER);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * Containment: a symlinked file
 * ---------------------------------------------------------------------------
 */

describe('openProject: a symlinked file whose target leaves the project', () => {
  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'never loads it, whatever the link is named (requires symlink support)',
    () => {
      const root = copyCorpusInto('app');
      const outside = makeDir(join(sandbox, 'outside'));
      const target = plantFile(join(outside, 'secrets.ts'), moduleNaming(OUTSIDE_MARKER));
      // Named like an ordinary module of this project, which is the point: the
      // name is not evidence of anything.
      symlinkSync(target, join(root, 'src', 'lib', 'telemetry-client.ts'));

      const recorder = createRecordingLogger();
      const loaded = openOrFail({ projectRoot: root, logger: recorder.logger });

      expectNeverLoaded(loaded, 'src/lib/telemetry-client.ts', OUTSIDE_MARKER);
      expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);

      const refusal = singleRecordMatching(
        recorder.records,
        'warn',
        'real path leaves the project',
      );
      expect(refusal.fields?.files).toEqual(['src/lib/telemetry-client.ts']);
    },
  );

  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'refuses every escaping link and counts them all (requires symlink support)',
    () => {
      const root = copyCorpusInto('app');
      const outside = makeDir(join(sandbox, 'outside'));
      plantFile(join(outside, 'one.ts'), moduleNaming(OUTSIDE_MARKER));
      plantFile(join(outside, 'two.ts'), moduleNaming(OUTSIDE_MARKER));
      symlinkSync(join(outside, 'one.ts'), join(root, 'src', 'lib', 'one.ts'));
      symlinkSync(join(outside, 'two.ts'), join(root, 'src', 'lib', 'two.ts'));

      const recorder = createRecordingLogger();
      const loaded = openOrFail({ projectRoot: root, logger: recorder.logger });

      expectNeverLoaded(loaded, 'src/lib/one.ts', OUTSIDE_MARKER);
      expect(relativePathsOf(loaded)).not.toContain('src/lib/two.ts');

      const refusal = singleRecordMatching(
        recorder.records,
        'warn',
        'real path leaves the project',
      );
      expect(refusal.fields?.count).toBe(2);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * Containment: the privacy guarantee, reached through a link
 *
 * `.env` is excluded by name twice over, so the only way to it is a link whose
 * own name is innocent. The resolved path has to be judged for this to be
 * caught, which is why the screen asks `isEnvFilePath` twice.
 * ---------------------------------------------------------------------------
 */

describe("openProject: a link to the project's own environment file", () => {
  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'refuses it and reads none of its content (requires symlink support)',
    () => {
      const root = copyCorpusInto('app');
      plantFile(join(root, '.env'), `${ENV_MARKER}=not-a-real-value\n`);
      symlinkSync(join(root, '.env'), join(root, 'src', 'lib', 'settings.ts'));

      const recorder = createRecordingLogger();
      const loaded = openOrFail({ projectRoot: root, logger: recorder.logger });

      expectNeverLoaded(loaded, 'src/lib/settings.ts', ENV_MARKER);
      expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);

      const refusal = singleRecordMatching(recorder.records, 'warn', 'environment files were');
      expect(refusal.message).toContain('privacy model');
      expect(refusal.fields?.count).toBe(1);
      expect(refusal.fields?.files).toEqual(['src/lib/settings.ts']);
    },
  );

  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'refuses a link to a qualified environment file outside the project too (requires symlink support)',
    () => {
      const root = copyCorpusInto('app');
      const outside = makeDir(join(sandbox, 'outside'));
      plantFile(join(outside, '.env.production.local'), `${ENV_MARKER}=not-a-real-value\n`);
      symlinkSync(
        join(outside, '.env.production.local'),
        join(root, 'src', 'lib', 'runtime-config.ts'),
      );

      const loaded = openOrFail({ projectRoot: root });

      expectNeverLoaded(loaded, 'src/lib/runtime-config.ts', ENV_MARKER);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * Containment must not over-refuse
 *
 * A screen that answered "no" to everything would pass every case above and be
 * useless. These are the shapes that have to keep working.
 * ---------------------------------------------------------------------------
 */

describe('openProject: links and roots that must keep working', () => {
  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'indexes a link whose target is a source file inside the project (requires symlink support)',
    () => {
      const root = copyCorpusInto('app');
      symlinkSync(join(root, 'src', 'lib', 'http.ts'), join(root, 'src', 'lib', 'http-alias.ts'));

      const recorder = createRecordingLogger();
      const loaded = openOrFail({ projectRoot: root, logger: recorder.logger });

      expect(relativePathsOf(loaded)).toContain('src/lib/http-alias.ts');
      expect(loadedPathsOf(loaded)).toContain(absoluteIn(root, 'src/lib/http-alias.ts'));
      expect(
        recordsMatching(recorder.records, 'warn', 'real path leaves the project'),
      ).toHaveLength(0);
    },
  );

  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'indexes a project whose root is reached through a symlinked parent (requires symlink support)',
    () => {
      // The shape of a checkout under a linked home directory, and of every
      // sandbox on a platform that links its temporary directory. Containment
      // is judged against the resolved root as well as the given one, so these
      // files must not all be refused.
      const real = makeDir(join(sandbox, 'real'));
      const root = copyCorpusInto(join('real', 'app'));
      expect(root).toBe(join(real, 'app'));
      symlinkSync(real, join(sandbox, 'linked'));

      const linkedRoot = join(sandbox, 'linked', 'app');
      const loaded = openOrFail({ projectRoot: linkedRoot });

      expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);
      // The handle keeps speaking of the path the caller passed, not of the
      // resolved one, so a consumer's cache key and its `SourceLocation`s stay
      // consistent with what it asked for.
      expect(loaded.projectRoot).toBe(toPosix(linkedRoot));
      expect(loadedPathsOf(loaded)).toContain(absoluteIn(linkedRoot, 'src/lib/http.ts'));
    },
  );

  it.skipIf(SYMLINKS_UNAVAILABLE)(
    'still refuses an escaping link inside a project whose root is a link (requires symlink support)',
    () => {
      // The two-base containment test must not become a hole: accepting the
      // resolved root as a base cannot mean accepting anything outside it.
      const real = makeDir(join(sandbox, 'real'));
      copyCorpusInto(join('real', 'app'));
      const outside = makeDir(join(sandbox, 'outside'));
      plantFile(join(outside, 'harvested.ts'), moduleNaming(OUTSIDE_MARKER));
      symlinkSync(outside, join(real, 'app', 'vendored'));
      symlinkSync(real, join(sandbox, 'linked'));

      const loaded = openOrFail({ projectRoot: join(sandbox, 'linked', 'app') });

      expectNeverLoaded(loaded, 'vendored/harvested.ts', OUTSIDE_MARKER);
      expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * The file set of the corpus, and its order
 * ---------------------------------------------------------------------------
 */

describe('openProject: the file set', () => {
  it('holds exactly the corpus files, sorted byte-wise by project-relative path', () => {
    const root = copyCorpusInto('app');

    const loaded = openOrFail({ projectRoot: root });

    expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);
  });

  it('states the expected order as a byte-wise one', () => {
    // Guards the literal above against a hand-sorting mistake, and states the
    // ordering claim itself: a code-unit comparison, never `localeCompare`,
    // so two machines agree on the index and its cache key.
    const byteWise = [...EXPECTED_FIXTURE_FILES].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    expect(EXPECTED_FIXTURE_FILES).toEqual(byteWise);
  });

  it('returns the same frozen array on every call', () => {
    const root = copyCorpusInto('app');

    const loaded = openOrFail({ projectRoot: root });
    const first = loaded.sourceFiles();

    expect(loaded.sourceFiles()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('is not changed by a file added to the compiler afterwards', () => {
    const root = copyCorpusInto('app');

    const loaded = openOrFail({ projectRoot: root });
    const before = relativePathsOf(loaded);
    loaded.project.createSourceFile(
      absoluteIn(root, 'src/lib/added-later.ts'),
      'export const X = 1;\n',
    );

    expect(relativePathsOf(loaded)).toEqual(before);
  });

  it('finds every file of a root whose name contains glob metacharacters', () => {
    // `project (v2)` is the everyday shape, and it used to be a hazard: as the
    // literal prefix of a glob pattern, an unescaped `(` matched nothing at all
    // and the index was silently empty. The traversal has no pattern to escape,
    // and this case is what keeps that true of any future discovery layer.
    const root = copyCorpusInto('project (v2) [staging]');

    const loaded = openOrFail({ projectRoot: root });

    expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);
  });

  it('round-trips every file through projectRelative', () => {
    const root = copyCorpusInto('app');

    const loaded = openOrFail({ projectRoot: root });

    for (const sourceFile of loaded.sourceFiles()) {
      const absolutePath: string = sourceFile.getFilePath();
      const relativePath = loaded.projectRelative(absolutePath);
      expect(relativePath).toBeDefined();
      expect(relativePath?.startsWith('/')).toBe(false);
      expect(absoluteIn(loaded.projectRoot, relativePath ?? '')).toBe(absolutePath);
    }
  });

  it('answers undefined from projectRelative for a path outside the project', () => {
    const root = copyCorpusInto('app');
    const outside = plantFile(join(sandbox, 'outside', 'other.ts'), moduleNaming(OUTSIDE_MARKER));

    const loaded = openOrFail({ projectRoot: root });

    expect(loaded.projectRelative(outside)).toBeUndefined();
    expect(loaded.projectRelative(absoluteIn(root, '../escape.ts'))).toBeUndefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Paths that must never be indexed
 * ---------------------------------------------------------------------------
 */

describe('openProject: trees and files that are never indexed', () => {
  it('loads no generated tree, vendored tree or environment file, even with include ["**/*"]', () => {
    const root = copyCorpusInto('app');

    // The target's own configuration widened as far as it goes. The compiler
    // adds nothing from it (`skipAddingFilesFromTsConfig`), and the globs and
    // the screen exclude these trees independently — three mechanisms, each
    // sufficient, which is what the case is here to prove.
    writeFileSync(
      join(root, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            jsx: 'preserve',
            module: 'esnext',
            moduleResolution: 'bundler',
            allowJs: true,
            noEmit: true,
            paths: { '@/*': ['./src/*'] },
          },
          include: ['**/*'],
        },
        undefined,
        2,
      )}\n`,
    );

    // A directory link as well, because a widened `include` is exactly what
    // makes the target's own configuration try to expand across the tree: the
    // options are read with a parser that enumerates nothing, so neither the
    // link nor the excluded trees below are matched on its behalf.
    if (!SYMLINKS_UNAVAILABLE) {
      const outside = makeDir(join(sandbox, 'outside'));
      plantFile(join(outside, 'harvested.ts'), moduleNaming(OUTSIDE_MARKER));
      symlinkSync(outside, join(root, 'vendored'));
    }

    plantFile(join(root, 'node_modules', 'pkg', 'index.js'), moduleNaming(GENERATED_MARKER));
    plantFile(join(root, '.next', 'server', 'chunk.js'), moduleNaming(GENERATED_MARKER));
    plantFile(join(root, 'dist', 'bundle.js'), moduleNaming(GENERATED_MARKER));
    plantFile(join(root, 'coverage', 'report.js'), moduleNaming(GENERATED_MARKER));
    plantFile(join(root, 'src', 'vendor.min.js'), moduleNaming(GENERATED_MARKER));
    plantFile(join(root, 'src', 'types', 'generated.d.ts'), `declare const X: ${'string'};\n`);
    plantFile(join(root, '.env'), `${ENV_MARKER}=not-a-real-value\n`);
    plantFile(join(root, '.env.local'), `${ENV_MARKER}=not-a-real-value\n`);
    plantFile(join(root, 'src', 'lib', '.env.development'), `${ENV_MARKER}=not-a-real-value\n`);

    const loaded = openOrFail({ projectRoot: root });

    expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);
    expect(loadedTextOf(loaded)).not.toContain(GENERATED_MARKER);
    expect(loadedTextOf(loaded)).not.toContain(ENV_MARKER);
    expect(loadedTextOf(loaded)).not.toContain(OUTSIDE_MARKER);
  });

  it('honours extraExcludes as whole segments at any depth', () => {
    const root = copyCorpusInto('app');
    plantFile(join(root, 'src', 'generated', 'client.ts'), moduleNaming(GENERATED_MARKER));
    plantFile(join(root, 'src', 'generated-docs', 'index.ts'), 'export const DOCS = 1;\n');

    const loaded = openOrFail({ projectRoot: root, extraExcludes: ['src/generated'] });

    expect(relativePathsOf(loaded)).not.toContain('src/generated/client.ts');
    expect(loadedTextOf(loaded)).not.toContain(GENERATED_MARKER);
    // A partial segment is not a match: the neighbouring directory stays.
    expect(relativePathsOf(loaded)).toContain('src/generated-docs/index.ts');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Configuration and module resolution
 * ---------------------------------------------------------------------------
 */

describe('openProject: the target configuration', () => {
  it("resolves an aliased import through the target's paths mapping", () => {
    // The reason the configuration is read at all. Without `paths`, the
    // `@/widgets` edge of the corpus resolves to nothing and the import
    // extractor loses every aliased edge in the project.
    const root = copyCorpusInto('app');

    const loaded = openOrFail({ projectRoot: root });

    expect(loaded.tsConfigFilePath).toBe(absoluteIn(root, 'tsconfig.json'));

    const page = loaded
      .sourceFiles()
      .find((sourceFile) => loaded.projectRelative(sourceFile.getFilePath()) === 'app/page.tsx');
    expect(page).toBeDefined();

    const aliased = page
      ?.getImportDeclarations()
      .find((declaration) => declaration.getModuleSpecifierValue() === '@/widgets');
    expect(aliased).toBeDefined();
    expect(aliased?.getModuleSpecifierSourceFile()?.getFilePath()).toBe(
      absoluteIn(root, 'src/widgets/index.ts'),
    );
  });

  it('indexes a project that has no configuration at all, and says so', () => {
    const root = makeDir(join(sandbox, 'bare'));
    plantFile(join(root, 'src', 'thing.ts'), 'export const THING = 1;\n');

    const recorder = createRecordingLogger();
    const loaded = openOrFail({ projectRoot: root, logger: recorder.logger });

    expect(loaded.tsConfigFilePath).toBeUndefined();
    expect(relativePathsOf(loaded)).toEqual(['src/thing.ts']);
    expect(
      recordsMatching(recorder.records, 'debug', 'no TypeScript configuration found'),
    ).toHaveLength(1);
  });

  it('accepts a configuration named relative to the project root', () => {
    const root = copyCorpusInto('app');

    const loaded = openOrFail({ projectRoot: root, tsConfigFilePath: 'tsconfig.json' });

    expect(loaded.tsConfigFilePath).toBe(absoluteIn(root, 'tsconfig.json'));
    expect(relativePathsOf(loaded)).toEqual(EXPECTED_FIXTURE_FILES);
  });
});

/*
 * ---------------------------------------------------------------------------
 * An empty project is a success
 * ---------------------------------------------------------------------------
 */

describe('openProject: a project with no indexable file', () => {
  it('returns Ok with an empty file set and warns', () => {
    const root = makeDir(join(sandbox, 'empty'));
    plantFile(join(root, 'README.md'), '# nothing to index\n');

    const recorder = createRecordingLogger();
    const loaded = openOrFail({ projectRoot: root, logger: recorder.logger });

    expect(relativePathsOf(loaded)).toEqual([]);
    expect(
      recordsMatching(recorder.records, 'warn', 'holds no indexable source file'),
    ).toHaveLength(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The documented failures, each a value and never an exception
 * ---------------------------------------------------------------------------
 */

describe('openProject: documented failures', () => {
  it('refuses a relative project root', () => {
    const error = refusalFrom({ projectRoot: 'packages/code-analysis' });

    expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
    expect(error.details?.reason).toBe('project-root-not-absolute');
    expect(error.hint).toBeDefined();
  });

  it('refuses a network-share root', () => {
    const error = refusalFrom({ projectRoot: '//server/share/project' });

    expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
    expect(error.details?.reason).toBe('network-share-path');
  });

  it('refuses a root that does not exist', () => {
    const error = refusalFrom({ projectRoot: join(sandbox, 'absent') });

    expect(error.code).toBe('PROJECT_NOT_FOUND');
    expect(error.details?.reason).toBe('project-root-missing');
  });

  it('refuses a root that is a file', () => {
    const file = plantFile(join(sandbox, 'root.ts'), 'export const R = 1;\n');

    const error = refusalFrom({ projectRoot: file });

    expect(error.code).toBe('PROJECT_NOT_FOUND');
    expect(error.details?.reason).toBe('project-root-not-a-directory');
  });

  it('refuses a malformed tsconfig.json rather than indexing with defaults', () => {
    // Quietly falling back would drop the target's `paths` aliases and produce
    // a graph that is wrong with no message to explain it.
    const root = copyCorpusInto('app');
    writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { "target": "ES2022"\n');

    const error = refusalFrom({ projectRoot: root });

    expect(error.code).toBe('CODE_INDEX_FAILED');
    expect(error.details?.reason).toBe('tsconfig-unreadable');
  });

  it('refuses a named configuration that does not exist', () => {
    const root = copyCorpusInto('app');

    const error = refusalFrom({ projectRoot: root, tsConfigFilePath: 'tsconfig.build.json' });

    expect(error.code).toBe('CODE_INDEX_FAILED');
    expect(error.details?.reason).toBe('tsconfig-missing');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The exported predicates and constants
 *
 * `isEnvFilePath` is the privacy predicate of this package and the module says
 * it has its own test; these are it. The other two decide location and
 * parsability, and both are consulted by the screen above.
 * ---------------------------------------------------------------------------
 */

describe('isEnvFilePath', () => {
  for (const path of [
    '.env',
    '.env.local',
    '.env.production.local',
    'apps/service/.env',
    'C:\\projects\\app\\.env.development',
    '.env.ts',
  ]) {
    it(`is true for '${path}'`, () => {
      expect(isEnvFilePath(path)).toBe(true);
    });
  }

  for (const path of ['env.ts', 'src/lib/environment.ts', 'config.env.ts', '.environment']) {
    it(`is false for '${path}'`, () => {
      expect(isEnvFilePath(path)).toBe(false);
    });
  }
});

describe('isIndexableFile', () => {
  for (const extension of INDEXABLE_EXTENSIONS) {
    it(`is true for a '${extension}' module`, () => {
      expect(isIndexableFile(`src/lib/module${extension}`)).toBe(true);
    });
  }

  for (const path of [
    'src/types/generated.d.ts',
    'src/types/generated.d.mts',
    'src/types/generated.d.cts',
    'src/styles/base.css',
    'package.json',
    'src/lib/module',
  ]) {
    it(`is false for '${path}'`, () => {
      expect(isIndexableFile(path)).toBe(false);
    });
  }

  it('compares the extension case-insensitively', () => {
    // A case-insensitive filesystem hands back `Module.TS` for a file the
    // project calls `module.ts`; refusing it would be a silent hole.
    expect(isIndexableFile('src/lib/Module.TS')).toBe(true);
    expect(isIndexableFile('src/types/Generated.D.TS')).toBe(false);
  });
});

describe('shouldExcludePath', () => {
  for (const name of EXCLUDED_DIRECTORY_NAMES) {
    it(`excludes a path under '${name}'`, () => {
      expect(shouldExcludePath('/p', `/p/${name}/inner/module.ts`)).toBe(true);
    });
  }

  it('excludes an environment file, a minified bundle and a path outside the root', () => {
    expect(shouldExcludePath('/p', '/p/.env.local')).toBe(true);
    expect(shouldExcludePath('/p', '/p/src/vendor.min.js')).toBe(true);
    expect(shouldExcludePath('/p', '/elsewhere/module.ts')).toBe(true);
  });

  it('judges exclusions relative to the root, never against its own path', () => {
    // A developer may legitimately keep a project at `/home/dev/dist/app`.
    // Matching the absolute path would empty their index with no explanation.
    expect(shouldExcludePath('/home/dev/dist/app', '/home/dev/dist/app/src/module.ts')).toBe(false);
  });

  it('matches an extraExcludes entry as whole segments at any depth', () => {
    expect(shouldExcludePath('/p', '/p/src/generated/client.ts', ['src/generated'])).toBe(true);
    expect(
      shouldExcludePath('/p', '/p/packages/api/src/generated/client.ts', ['src/generated']),
    ).toBe(true);
    expect(shouldExcludePath('/p', '/p/src/generated-docs/index.ts', ['src/generated'])).toBe(
      false,
    );
    expect(shouldExcludePath('/p', '/p/src/module.ts', ['generated'])).toBe(false);
  });
});

describe('the exported vocabularies', () => {
  it('are frozen, so no consumer can widen what the indexer reads', () => {
    expect(Object.isFrozen(INDEXABLE_EXTENSIONS)).toBe(true);
    expect(Object.isFrozen(EXCLUDED_DIRECTORY_NAMES)).toBe(true);
  });

  it('name no declaration-file or environment-file extension', () => {
    expect(INDEXABLE_EXTENSIONS).not.toContain('.d.ts');
    expect(INDEXABLE_EXTENSIONS).not.toContain('.json');
    expect(EXCLUDED_DIRECTORY_NAMES).toContain('node_modules');
    expect(EXCLUDED_DIRECTORY_NAMES).toContain('.next');
    expect(EXCLUDED_DIRECTORY_NAMES).toContain('dist');
  });
});
