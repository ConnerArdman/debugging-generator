/**
 * Unit suite for {@link searchText} — the folder's two non-negotiable
 * properties, made mechanical rather than merely documented.
 *
 * **Boundedness.** Every cap the module publishes is *applied*, and every cap
 * that clipped anything is *reported*. A result from this function can be
 * serialised into a model prompt, so an unbounded answer is a correctness
 * problem one layer up rather than untidiness. The cases below reach each cap
 * in turn — the result quota, the per-file quota, the excerpt budget, the
 * scanned-bytes ceiling — and assert both the clipping and the
 * `truncated` flag that announces it, plus a control run with generous caps
 * that proves the flag is not stuck on.
 *
 * **Privacy.** The searched file set is inherited from `../project.ts` and can
 * only ever be narrowed. The privacy group plants, in a throwaway copy of the
 * corpus, one file of every kind the indexer must never read — `.env`,
 * `.env.local`, a `node_modules` module, a `dist` bundle, a `.next` artifact —
 * and asserts not only that no hit names them but that a string occurring
 * *only* in them is not found at all, which is the difference between "never
 * reported" and "never read" (AAP 0.5.2).
 *
 * Alongside those two: the fixture's marker invariant (the corpus carries
 * `// fixture-marker: basin-drift` exactly twice, in two named files), case and
 * whole-word semantics, `SourceLocation` validity, the empty and refused
 * envelopes, glob filtering over paths containing regular-expression
 * punctuation, and determinism and purity.
 *
 * ## Conventions this suite holds itself to
 *
 * - The corpus at `../../test/fixtures/sample-next-app` is **read only**. It is
 *   opened in place for every read-only case and *copied* into an
 *   `os.tmpdir()` sandbox whenever a case needs to plant a file, so
 *   `git status --porcelain packages/code-analysis` is empty after a run.
 * - File text is read **through the handle** (`sourceFiles()`,
 *   `getFullText()`), never through `node:fs`. Reaching around the handle to
 *   the filesystem would assert against a file set the module never searched.
 * - Planted payloads are transparently synthetic (`PLANTED_VALUE=…`), because
 *   a realistic-looking credential in a committed test is a credential in the
 *   repository whatever directory it is written to.
 * - Counts that could change when the corpus grows are **derived** — from
 *   `sourceFiles()`, from the loaded text — rather than written out. The one
 *   deliberate exception is the marker invariant itself, which the fixture
 *   files declare and this suite is the asserting party for; it is written out
 *   so that an edit to the corpus fails here, loudly, with the expected count
 *   and both expected paths in the message.
 * - The marker literal appears in this file and must never appear in
 *   `./text-search.ts`: `scripts/check-no-hardcoding.mjs` scans product source
 *   and excludes tests, which is exactly why the literal belongs on this side
 *   of the boundary.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEBUGGEN_ERROR_CODES,
  DEFAULT_RESOLUTION_CONFIDENCE,
  DebuggenError,
  isErr,
  isOk,
  parseSourceLocation,
} from '@debuggen/shared';
import type { LogFields, LogLevel, Logger } from '@debuggen/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openProject } from '../project.js';
import type { LoadedProject, OpenProjectOptions } from '../project.js';
import { TEXT_SEARCH_LIMITS, searchText } from './text-search.js';
import type { TextSearchHit, TextSearchOptions, TextSearchResult } from './text-search.js';

/*
 * ---------------------------------------------------------------------------
 * The corpus, its invariants and the synthetic payloads
 * ---------------------------------------------------------------------------
 */

/**
 * The read-only indexing corpus: a generic Next.js application that exists to
 * be indexed.
 *
 * Resolved from `import.meta.url` rather than from `process.cwd()`, because
 * this suite runs both as `pnpm test` from the repository root and as
 * `vitest run --root ../.. --project code-analysis` from the workspace, and a
 * relative path would mean two different directories.
 */
const FIXTURE_ROOT = fileURLToPath(new URL('../../test/fixtures/sample-next-app', import.meta.url));

/**
 * The exact text the corpus carries **twice**, written as a standalone comment
 * in each of {@link MARKER_FILES}.
 *
 * A fixture invariant the corpus files declare about themselves and this suite
 * is the asserting party for.
 */
const MARKER = '// fixture-marker: basin-drift';

/** The marker's distinctive middle, used for the substring and whole-word cases. */
const MARKER_TAG = 'fixture-marker';

/**
 * {@link MARKER_TAG} with its last character removed.
 *
 * Its whole point is that it never stands alone: every occurrence is followed
 * by `r`, so `wholeWord` must reject all of them while a plain search finds
 * them.
 */
const MARKER_TAG_PREFIX = 'fixture-marke';

/**
 * The two files carrying the marker, in the order `searchText` must report them.
 *
 * `'app/…' < 'src/…'` under the module's byte-wise path comparison, so this
 * order is the deterministic one and is asserted as a sequence rather than as a
 * set.
 */
const MARKER_FILES: readonly string[] = [
  'app/(observatory)/basins/[id]/page.tsx',
  'src/lib/station-service.ts',
];

/** How many times {@link MARKER} occurs in the whole corpus. */
const MARKER_OCCURRENCES = 2;

/**
 * A token that occurs many times, several times over in several files.
 *
 * The per-file and scanned-bytes cases need a query with far more matches than
 * any cap admits; a one-occurrence query cannot exercise a quota.
 */
const REPEATED_TOKEN = 'basin';

/** A token that begins a line in the corpus, for the line-edge boundary case. */
const LINE_LEADING_TOKEN = 'export';

/**
 * A query that occurs nowhere in the corpus.
 *
 * Deliberately not identifier-shaped: a plausible name is exactly the thing a
 * future fixture might grow, and this constant's whole value is that it cannot.
 */
const ABSENT_QUERY = 'zzq-absent-from-every-fixture-file-4f8c1d2e';

/**
 * The value planted **only** into the files that must never be searched.
 *
 * Finding it would prove their contents were read, which is a stronger failure
 * than finding their paths in a hit.
 */
const PLANTED_ONLY_VALUE = 'PLANTED_ONLY_VALUE_NOT_IN_THE_CORPUS_4f8c1d2e';

/** Path segments that must never appear in a hit's `location.file`. */
const FORBIDDEN_SEGMENTS: readonly string[] = [
  'node_modules',
  'dist',
  '.next',
  'out',
  'build',
  'coverage',
];

/**
 * The budget every case starts from: the module's own ceilings, stated
 * explicitly because `query`, `maxResults` and `maxExcerptChars` have no
 * defaults.
 */
const BUDGET = {
  maxResults: TEXT_SEARCH_LIMITS.maxResults,
  maxExcerptChars: TEXT_SEARCH_LIMITS.maxExcerptChars,
} satisfies Pick<TextSearchOptions, 'maxResults' | 'maxExcerptChars'>;

/*
 * ---------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------
 */

/**
 * The corpus, opened once.
 *
 * Opening a ts-morph project is the expensive step of this suite and the module
 * under test neither mutates the handle nor caches anything, so one open serves
 * every read-only case. `undefined` until `beforeAll` runs, so a case that
 * somehow ran without it fails with a sentence instead of a `TypeError`.
 */
let corpus: LoadedProject | undefined;

/** Every sandbox directory created by this suite, removed in `afterAll`. */
const sandboxes: string[] = [];

beforeAll(() => {
  corpus = openOrFail({ projectRoot: FIXTURE_ROOT });
}, 30_000);

afterAll(() => {
  for (const sandbox of sandboxes.splice(0, sandboxes.length)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/** One file of an opened project, named without importing ts-morph's own type. */
type LoadedSourceFile = ReturnType<LoadedProject['sourceFiles']>[number];

/**
 * Opens a project this suite expects to open, or fails the case with the
 * reason it did not.
 *
 * Every failure of the loader is a value rather than an exception, so a case
 * that dereferenced the result would report "cannot read property of
 * undefined" instead of the refusal.
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

/** The corpus handle, or a failure naming the missing `beforeAll`. */
function corpusProject(): LoadedProject {
  if (corpus === undefined) {
    return expect.unreachable('the corpus was not opened: beforeAll did not run');
  }
  return corpus;
}

/** A search this suite expects to succeed, or a failure naming the refusal. */
function searchOrFail(loaded: LoadedProject, options: TextSearchOptions): TextSearchResult {
  const found = searchText(loaded, options);
  if (isErr(found)) {
    return expect.unreachable(
      `searchText was expected to succeed and failed with ${found.error.code} (${reasonOf(found.error)}): ${found.error.message}`,
    );
  }
  return found.value;
}

/** A search of the corpus this suite expects to succeed. */
function findInCorpus(options: TextSearchOptions): TextSearchResult {
  return searchOrFail(corpusProject(), options);
}

/** The error of a case that expects `searchText` to refuse, never a partial `Ok`. */
function refusalFrom(options: TextSearchOptions): DebuggenError {
  const loaded = corpusProject();
  const found = searchText(loaded, options);
  if (isOk(found)) {
    return expect.unreachable(
      `searchText was expected to refuse and returned ${String(found.value.hits.length)} hits instead`,
    );
  }
  return found.error;
}

/** The `details.reason` discriminator of one of the module's errors. */
function reasonOf(error: DebuggenError): string {
  const reason = error.details?.reason;
  return typeof reason === 'string' ? reason : 'unknown';
}

/**
 * An element of an array, or a failure naming the index.
 *
 * `noUncheckedIndexedAccess` is in force for this file, and a `!` assertion
 * would turn a missing hit into an unrelated `TypeError` several assertions
 * later.
 */
function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) {
    return expect.unreachable(
      `expected ${what} at index ${String(index)}, and the list holds ${String(items.length)} item(s)`,
    );
  }
  return item;
}

/** The project-relative paths of a handle's file set, in its own order. */
function relativePathsOf(loaded: LoadedProject): string[] {
  return loaded
    .sourceFiles()
    .map((file) => loaded.projectRelative(file.getFilePath()) ?? file.getFilePath());
}

/** The loaded file at a project-relative path, or a failure naming the whole set. */
function sourceFileAt(loaded: LoadedProject, relativePath: string): LoadedSourceFile {
  const found = loaded
    .sourceFiles()
    .find((file) => loaded.projectRelative(file.getFilePath()) === relativePath);
  if (found === undefined) {
    return expect.unreachable(
      `the corpus was expected to hold '${relativePath}' and holds: ${relativePathsOf(loaded).join(', ')}`,
    );
  }
  return found;
}

/** A loaded file's whole text, read through the handle rather than from disk. */
function fileTextOf(loaded: LoadedProject, relativePath: string): string {
  return sourceFileAt(loaded, relativePath).getFullText();
}

/** One 1-based line of a loaded file, without its terminator. */
function lineTextOf(loaded: LoadedProject, relativePath: string, line: number): string {
  const lines = fileTextOf(loaded, relativePath).split(/\r\n|\r|\n/);
  return at(lines, line - 1, `line ${String(line)} of '${relativePath}'`);
}

/** Every hit as `file:line:column`, for an ordering assertion or a message. */
function locationsOf(result: TextSearchResult): string[] {
  return result.hits.map(
    (hit) => `${hit.location.file}:${String(hit.location.line)}:${String(hit.location.column)}`,
  );
}

/** The file of every hit, in hit order. */
function filesOf(result: TextSearchResult): string[] {
  return result.hits.map((hit) => hit.location.file);
}

/**
 * The matched text as the hit itself describes it.
 *
 * This is the module's published invariant, and expressing it as a helper is
 * what lets every case assert it rather than only the one that documents it.
 */
function matchedTextOf(hit: TextSearchHit): string {
  return hit.excerpt.slice(hit.matchOffsetInExcerpt, hit.matchOffsetInExcerpt + hit.matchLength);
}

/**
 * How many non-overlapping, case-insensitive occurrences of `needle` are in
 * `text`.
 *
 * A reference count computed with `indexOf` rather than with a regular
 * expression, so a derived expectation does not lean on the same mechanism the
 * module under test uses. Advancing by the needle's length matches the
 * module's own non-overlapping scan.
 */
function occurrencesOf(text: string, needle: string): number {
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  let count = 0;
  let index = haystack.indexOf(target);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(target, index + target.length);
  }
  return count;
}

/** The occurrence count of `needle` in each file that holds it, keyed by path. */
function occurrencesPerFile(loaded: LoadedProject, needle: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of loaded.sourceFiles()) {
    const relativePath = loaded.projectRelative(file.getFilePath());
    if (relativePath === undefined) {
      continue;
    }
    const count = occurrencesOf(file.getFullText(), needle);
    if (count > 0) {
      counts.set(relativePath, count);
    }
  }
  return counts;
}

/** The total volume of the handle's file text, in characters. */
function totalCharsOf(loaded: LoadedProject): number {
  return loaded.sourceFiles().reduce((sum, file) => sum + file.getFullText().length, 0);
}

/**
 * The project-relative path of the file the module examines **first**.
 *
 * Derived rather than written out: files are scanned in ascending
 * project-relative POSIX path order under a UTF-16 code-unit comparison, which
 * is exactly what `Array#sort` gives for strings, so a corpus that grows a file
 * sorting before today's first one does not silently invalidate the
 * scanned-bytes cases that start from it.
 */
function firstScannedPathOf(loaded: LoadedProject): string {
  const paths = [...relativePathsOf(loaded)].sort();
  return at(paths, 0, 'the first file in the scan order');
}

/**
 * The 0-based offset of the first case-insensitive occurrence of `needle` in
 * `text`, or `-1`.
 *
 * Computed with `indexOf` rather than with a regular expression, for the same
 * reason as {@link occurrencesOf}: a derived expectation must not lean on the
 * mechanism the module under test uses.
 */
function firstOffsetOf(text: string, needle: string): number {
  return text.toLowerCase().indexOf(needle.toLowerCase());
}

/**
 * `literal` as a regular-expression pattern that matches exactly itself.
 *
 * The test's own escaper rather than the module's: a case that asserts what a
 * *pattern* does must be able to build one out of the corpus' real text without
 * borrowing the mechanism under test to do it.
 */
function escapeForPattern(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/-]/g, (character) => `\\${character}`);
}

/** One record a {@link createRecordingLogger} logger captured. */
interface RecordedLog {
  /** The severity it was emitted at. */
  readonly level: LogLevel;

  /** The message text. */
  readonly message: string;

  /** The structured fields, or `undefined` when the call passed none. */
  readonly fields: LogFields | undefined;
}

/** A logger that records instead of printing, and the list it records into. */
interface RecordingLogger {
  /** Pass this as `options.logger`. */
  readonly logger: Logger;

  /** Everything the logger was asked to emit, in order. */
  readonly records: readonly RecordedLog[];
}

/**
 * A logger that records instead of printing.
 *
 * `level` is `trace` so nothing is filtered before it is recorded — the privacy
 * assertion has to see *everything* the module tried to emit, not what a
 * threshold let through — and `child` returns the same logger, because one flat
 * list is what the assertions search.
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

/** A fresh sandbox directory, registered for removal in `afterAll`. */
function makeSandbox(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'debuggen-text-search-'));
  sandboxes.push(sandbox);
  return sandbox;
}

/** Writes a file inside a sandbox, creating its directory chain first. */
function plantFile(pathAbs: string, contents: string): void {
  mkdirSync(dirname(pathAbs), { recursive: true });
  writeFileSync(pathAbs, contents);
}

/*
 * ---------------------------------------------------------------------------
 * The marker invariant
 *
 * The corpus declares that it carries the marker exactly twice, in two named
 * files, and that two other files must not carry it. This group is the party
 * that asserts it: an edit to the corpus that adds, moves or removes an
 * occurrence fails here with the expected count and both expected paths in the
 * message.
 * ---------------------------------------------------------------------------
 */

describe('searchText: the corpus carries the fixture marker exactly twice', () => {
  it('finds both occurrences, in path order, and reports an exhaustive scan', () => {
    const loaded = corpusProject();
    const found = findInCorpus({ ...BUDGET, query: MARKER });

    expect(
      found.hits.length,
      `the corpus must carry the marker exactly ${String(MARKER_OCCURRENCES)} time(s), in '${MARKER_FILES.join("' and '")}', and the search reported: ${locationsOf(found).join(', ')}`,
    ).toBe(MARKER_OCCURRENCES);

    expect(found.totalMatches).toBe(MARKER_OCCURRENCES);
    expect(found.truncated).toBe(false);
    expect(found.filesSearched).toBe(loaded.sourceFiles().length);
    expect(found.bytesScanned).toBe(totalCharsOf(loaded));
    expect(found.query).toBe(MARKER);

    // A sequence, not a set: the order is the module's deterministic one.
    expect(filesOf(found)).toEqual(MARKER_FILES);
  });

  it('reports a 1-based line and column that really index the match', () => {
    const loaded = corpusProject();
    const found = findInCorpus({ ...BUDGET, query: MARKER });

    for (const [index, relativePath] of MARKER_FILES.entries()) {
      const hit = at(found.hits, index, `a hit in '${relativePath}'`);
      expect(hit.location.file).toBe(relativePath);

      const line = lineTextOf(loaded, relativePath, hit.location.line);
      const columnIndex = hit.location.column - 1;
      expect(
        line.slice(columnIndex, columnIndex + MARKER.length),
        `'${relativePath}' line ${String(hit.location.line)} must hold the marker at column ${String(hit.location.column)}, and holds: ${line}`,
      ).toBe(MARKER);
    }
  });

  it('excerpts the matched line whole and points at the match inside it', () => {
    const loaded = corpusProject();
    const found = findInCorpus({ ...BUDGET, query: MARKER });

    for (const hit of found.hits) {
      expect(hit.excerpt).toContain(MARKER);
      expect(hit.excerpt).not.toContain('\n');
      expect(hit.excerpt).not.toContain('\r');
      expect(hit.excerpt).toBe(lineTextOf(loaded, hit.location.file, hit.location.line));

      expect(matchedTextOf(hit)).toBe(MARKER);
      expect(hit.matchLength).toBe(MARKER.length);
      expect(hit.truncated).toBe(false);
    }
  });

  it('finds the same two files for a substring of the marker', () => {
    const found = findInCorpus({ ...BUDGET, query: MARKER_TAG });

    expect(found.hits.length).toBe(MARKER_OCCURRENCES);
    expect(filesOf(found)).toEqual(MARKER_FILES);

    for (const hit of found.hits) {
      // The shorter query must land on the tag itself rather than one character
      // before or after it, which is the off-by-one this case exists to catch.
      expect(matchedTextOf(hit)).toBe(MARKER_TAG);
      expect(hit.matchLength).toBe(MARKER_TAG.length);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Case sensitivity
 * ---------------------------------------------------------------------------
 */

describe('searchText: case sensitivity', () => {
  it('finds nothing for an upper-case query when case must match exactly', () => {
    const found = findInCorpus({ ...BUDGET, query: MARKER_TAG.toUpperCase(), caseSensitive: true });

    expect(found.hits).toEqual([]);
    expect(found.totalMatches).toBe(0);
    expect(found.truncated).toBe(false);
    expect(found.filesSearched).toBe(corpusProject().sourceFiles().length);
  });

  it('finds both occurrences for the same query when case is ignored', () => {
    const asked = findInCorpus({
      ...BUDGET,
      query: MARKER_TAG.toUpperCase(),
      caseSensitive: false,
    });
    expect(filesOf(asked)).toEqual(MARKER_FILES);

    // The documented default is case-insensitive, so omitting the option must
    // behave exactly as passing `false`.
    const defaulted = findInCorpus({ ...BUDGET, query: MARKER_TAG.toUpperCase() });
    expect(defaulted).toEqual(asked);
  });

  it("reports the file's casing rather than the query's", () => {
    const mixedCaseQuery = 'Fixture-Marker';
    const found = findInCorpus({ ...BUDGET, query: mixedCaseQuery });

    expect(filesOf(found)).toEqual(MARKER_FILES);

    for (const hit of found.hits) {
      expect(matchedTextOf(hit)).toBe(MARKER_TAG);
      expect(matchedTextOf(hit)).not.toBe(mixedCaseQuery);
      expect(hit.matchLength).toBe(MARKER_TAG.length);
      expect(hit.excerpt).toContain(MARKER_TAG);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Whole-word matching
 * ---------------------------------------------------------------------------
 */

describe('searchText: whole-word matching', () => {
  it('matches a substring of a word when whole-word matching is not asked for', () => {
    const found = findInCorpus({ ...BUDGET, query: MARKER_TAG_PREFIX });

    expect(found.hits.length).toBe(MARKER_OCCURRENCES);
    expect(filesOf(found)).toEqual(MARKER_FILES);
    expect(found.truncated).toBe(false);
  });

  it('rejects that same substring when it must stand alone as a word', () => {
    const found = findInCorpus({ ...BUDGET, query: MARKER_TAG_PREFIX, wholeWord: true });

    expect(
      found.hits,
      `'${MARKER_TAG_PREFIX}' is always followed by a word character in the corpus, so no occurrence stands alone; the search reported: ${locationsOf(found).join(', ')}`,
    ).toEqual([]);
    expect(found.totalMatches).toBe(0);
  });

  it('keeps a match bounded by punctuation rather than by whitespace', () => {
    // On `// fixture-marker: basin-drift` the tag is bounded by a space and a
    // colon — neither a word character — so whole-word matching keeps it.
    const found = findInCorpus({ ...BUDGET, query: MARKER_TAG, wholeWord: true });

    expect(found.hits.length).toBe(MARKER_OCCURRENCES);
    expect(filesOf(found)).toEqual(MARKER_FILES);
  });

  it('narrows rather than widens the unrestricted result set', () => {
    const plain = findInCorpus({ ...BUDGET, query: 'marker' });
    const bounded = findInCorpus({ ...BUDGET, query: 'marker', wholeWord: true });

    const plainLocations = locationsOf(plain);
    for (const location of locationsOf(bounded)) {
      expect(plainLocations).toContain(location);
    }
    expect(bounded.hits.length).toBeLessThanOrEqual(plain.hits.length);

    // The rule stated on the option, applied to the whole match: the character
    // on each side is absent (a text edge) or a non-word ASCII character.
    const wordCharacter = /[0-9A-Za-z_]/;
    for (const hit of bounded.hits) {
      const where = `${hit.location.file}:${String(hit.location.line)}:${String(hit.location.column)}`;
      const line = lineTextOf(corpusProject(), hit.location.file, hit.location.line);
      const before = line.charAt(hit.location.column - 2);
      const after = line.charAt(hit.location.column - 1 + hit.matchLength);

      expect(
        before === '' || !wordCharacter.test(before),
        `the character before the match at ${where} must not be a word character, and is '${before}'`,
      ).toBe(true);
      expect(
        after === '' || !wordCharacter.test(after),
        `the character after the match at ${where} must not be a word character, and is '${after}'`,
      ).toBe(true);
    }
  });

  it('treats the start of a line as a boundary', () => {
    const found = findInCorpus({
      ...BUDGET,
      query: LINE_LEADING_TOKEN,
      wholeWord: true,
      maxResults: 5,
    });

    const atLineStart = found.hits.filter((hit) => hit.location.column === 1);
    expect(
      atLineStart.length,
      `a match at column 1 must survive whole-word matching, and the search reported: ${locationsOf(found).join(', ')}`,
    ).toBeGreaterThan(0);

    const hit = at(atLineStart, 0, 'a hit at the start of a line');
    expect(matchedTextOf(hit).toLowerCase()).toBe(LINE_LEADING_TOKEN.toLowerCase());
    expect(hit.matchOffsetInExcerpt).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Boundedness: every cap is applied, and every cap that clipped is reported
 *
 * The headline property of this module. A result can be serialised into a
 * model prompt, so a cap that were merely documented would be a correctness
 * problem one layer up. Each case below reaches one cap and asserts both the
 * clipping and the flag, and the last case proves the flag is not stuck on.
 * ---------------------------------------------------------------------------
 */

describe('searchText: the result cap', () => {
  it('returns the first hit only and reports that input remained', () => {
    const loaded = corpusProject();
    const found = findInCorpus({ ...BUDGET, query: MARKER, maxResults: 1 });

    expect(found.hits.length).toBe(1);

    // Deterministic order makes "the first hit" a fact rather than a race: the
    // `app/…` path sorts before the `src/…` one.
    const hit = at(found.hits, 0, 'the single hit');
    expect(hit.location.file).toBe(at(MARKER_FILES, 0, 'the first marker file'));

    expect(found.truncated).toBe(true);
    expect(found.totalMatches).toBeGreaterThanOrEqual(1);
    expect(found.totalMatches).toBeGreaterThanOrEqual(found.hits.length);
    expect(found.filesSearched).toBeLessThan(loaded.sourceFiles().length);
  });

  it('clamps a caller that asks for more hits than the module allows', () => {
    const found = findInCorpus({
      ...BUDGET,
      query: REPEATED_TOKEN,
      maxResults: Number.MAX_SAFE_INTEGER,
      maxExcerptChars: Number.MAX_SAFE_INTEGER,
    });

    expect(found.hits.length).toBeLessThanOrEqual(TEXT_SEARCH_LIMITS.maxResults);
    for (const hit of found.hits) {
      expect(hit.excerpt.length).toBeLessThanOrEqual(TEXT_SEARCH_LIMITS.maxExcerptChars);
    }
  });
});

describe('searchText: the excerpt cap', () => {
  it('clips a line that does not fit and marks that hit truncated', () => {
    const loaded = corpusProject();
    const whole = findInCorpus({ ...BUDGET, query: MARKER });
    const reference = at(whole.hits, 0, 'the first marker hit');
    const line = lineTextOf(loaded, reference.location.file, reference.location.line);

    // One character short of the line, which is the smallest budget that still
    // clips it — derived from the corpus rather than written out, so the case
    // survives a reformatting of the fixture.
    const cap = line.length - 1;
    expect(cap).toBeGreaterThan(MARKER.length);

    const found = findInCorpus({ ...BUDGET, query: MARKER, maxExcerptChars: cap });
    expect(found.truncated).toBe(true);

    for (const hit of found.hits) {
      expect(hit.truncated).toBe(true);
      expect(hit.excerpt.length).toBeLessThanOrEqual(cap);
      // A contiguous slice of the line, with nothing inserted to mark the clip.
      expect(lineTextOf(loaded, hit.location.file, hit.location.line)).toContain(hit.excerpt);
      expect(matchedTextOf(hit)).toBe(MARKER);
      expect(hit.matchOffsetInExcerpt + hit.matchLength).toBeLessThanOrEqual(hit.excerpt.length);
    }
  });

  it('clips the match itself when the budget is smaller than the match', () => {
    const cap = Math.max(1, Math.floor(MARKER.length / 2));
    expect(cap).toBeLessThan(MARKER.length);

    const found = findInCorpus({ ...BUDGET, query: MARKER, maxExcerptChars: cap });
    expect(found.truncated).toBe(true);
    expect(found.hits.length).toBe(MARKER_OCCURRENCES);

    for (const hit of found.hits) {
      expect(hit.truncated).toBe(true);
      expect(hit.excerpt.length).toBeLessThanOrEqual(cap);
      expect(hit.matchLength).toBeLessThan(MARKER.length);
      expect(hit.matchOffsetInExcerpt + hit.matchLength).toBeLessThanOrEqual(hit.excerpt.length);
      // The published invariant, in its clipped form: the visible match is the
      // leading portion of the matched text.
      expect(matchedTextOf(hit)).toBe(MARKER.slice(0, hit.matchLength));
    }
  });
});

describe('searchText: the per-file cap', () => {
  it('takes at most the quota from any one file', () => {
    const loaded = corpusProject();
    const counts = occurrencesPerFile(loaded, REPEATED_TOKEN);

    const crowded = [...counts.entries()].filter(([, count]) => count > 1);
    expect(
      crowded.length,
      `the corpus must hold '${REPEATED_TOKEN}' more than once in at least one file for this case to mean anything, and holds: ${[...counts.entries()].map(([file, count]) => `${file}=${String(count)}`).join(', ')}`,
    ).toBeGreaterThan(0);

    const found = findInCorpus({ ...BUDGET, query: REPEATED_TOKEN, maxMatchesPerFile: 1 });

    const perFile = new Map<string, number>();
    for (const file of filesOf(found)) {
      perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }
    for (const [file, taken] of perFile) {
      expect(taken, `'${file}' contributed ${String(taken)} hits under a per-file cap of 1`).toBe(
        1,
      );
    }

    // One hit per file that holds the token at all, which is the quota applied
    // rather than the result cap cutting the scan short.
    expect(found.hits.length).toBe(counts.size);
    expect(found.truncated).toBe(true);
  });

  it('takes the default quota from a single crowded file', () => {
    const loaded = corpusProject();
    const crowded = [...occurrencesPerFile(loaded, REPEATED_TOKEN).entries()].filter(
      ([, count]) => count > TEXT_SEARCH_LIMITS.maxMatchesPerFile,
    );
    const [file, count] = at(crowded, 0, 'a file holding the token more often than the quota');

    // The path carries route-group parentheses and a catch-all segment, so this
    // is also a glob case: every character that is not `**`, `*` or `?` has to
    // match literally.
    const found = findInCorpus({ ...BUDGET, query: REPEATED_TOKEN, includeGlobs: [file] });

    expect(found.filesSearched).toBe(1);
    expect(found.hits.length).toBe(Math.min(count, TEXT_SEARCH_LIMITS.maxMatchesPerFile));
    expect(found.truncated).toBe(true);
    expect(new Set(filesOf(found))).toEqual(new Set([file]));

    const capped = findInCorpus({
      ...BUDGET,
      query: REPEATED_TOKEN,
      includeGlobs: [file],
      maxMatchesPerFile: 1,
    });
    expect(capped.hits.length).toBe(1);
    expect(capped.truncated).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The scanned-bytes ceiling
 *
 * The one cap that spans files, and therefore the one that bounds the cost of
 * a query matching nothing. It is a *hard* total: the file the budget runs out
 * in is examined only as far as the budget reaches, so `bytesScanned` lands on
 * the ceiling rather than up to one whole file past it — an overrun of almost
 * a megabyte, since `maxFileBytes` admits a million characters. These cases
 * guard that the ceiling is enforced (not merely documented), that a budget
 * smaller than the first file is *spent* rather than abandoned, that a match
 * touching the cut is not reported from characters that were never read, and
 * that clipping the text a scan reads corrupts no hit's location or excerpt.
 * ---------------------------------------------------------------------------
 */

describe('searchText: the scanned-bytes ceiling', () => {
  it('stops exactly on the ceiling instead of treating it as advisory', () => {
    const loaded = corpusProject();
    const ceiling = 100;
    expect(ceiling).toBeLessThan(totalCharsOf(loaded));

    const found = findInCorpus({
      ...BUDGET,
      query: REPEATED_TOKEN,
      maxScannedBytes: ceiling,
    });

    expect(found.truncated).toBe(true);
    expect(found.filesSearched).toBeGreaterThanOrEqual(1);
    // Files left unexamined, which is what proves the scan stopped early.
    expect(found.filesSearched).toBeLessThan(loaded.sourceFiles().length);

    // The accounting lands ON the ceiling: the accumulated total is checked
    // against the budget *before* a file's text is scanned, and a file that
    // does not fit contributes only the characters the budget had left.
    expect(found.bytesScanned).toBe(ceiling);
    expect(found.bytesScanned).toBeLessThan(totalCharsOf(loaded));
  });

  it('reports the partially examined file to the logger as counts and a path', () => {
    const loaded = corpusProject();
    const { logger, records } = createRecordingLogger();
    const ceiling = 100;

    const found = searchOrFail(loaded, {
      ...BUDGET,
      query: REPEATED_TOKEN,
      maxScannedBytes: ceiling,
      logger,
    });
    expect(found.bytesScanned).toBe(ceiling);

    // A partial examination is invisible in the envelope beyond `truncated`, so
    // the diagnostic record is the only thing that says *which* file was cut
    // and how far the scan got into it — and it has to say it in counts and a
    // project-relative path, never in the file's text.
    const clipEvents = records.filter((record) => record.fields?.['scannedLength'] === ceiling);
    expect(
      clipEvents.length,
      `the scan must report the file it examined only in part, and logged: ${records.map((record) => record.message).join(' | ')}`,
    ).toBe(1);

    const event = at(clipEvents, 0, 'the record naming the partially examined file');
    expect(event.level).toBe('debug');
    expect(event.fields?.['maxScannedBytes']).toBe(ceiling);
    expect(relativePathsOf(loaded)).toContain(event.fields?.['file']);
    for (const [key, value] of Object.entries(event.fields ?? {})) {
      expect(
        typeof value,
        `field '${key}' of the partial-examination record must be a count or a path`,
      ).toMatch(/^(?:number|string)$/);
    }
  });

  it('examines the head of the first file when the ceiling is smaller than it', () => {
    const loaded = corpusProject();
    const firstPath = firstScannedPathOf(loaded);
    const firstText = fileTextOf(loaded, firstPath);
    const offset = firstOffsetOf(firstText, REPEATED_TOKEN);
    expect(
      offset,
      `the first file in the scan order, '${firstPath}', must hold '${REPEATED_TOKEN}' for this case to mean anything`,
    ).toBeGreaterThanOrEqual(0);

    // One character past the end of that first occurrence: the match sits
    // strictly inside the prefix rather than touching the cut, and the budget
    // cannot even finish the first candidate file.
    const ceiling = offset + REPEATED_TOKEN.length + 1;
    expect(ceiling).toBeLessThan(firstText.length);

    const found = findInCorpus({ ...BUDGET, query: REPEATED_TOKEN, maxScannedBytes: ceiling });

    // The budget is *spent*, not abandoned. Skipping a file that does not fit
    // would make any ceiling below the first file scan nothing at all, which
    // would leave the cap untestable at a small value and hide a hit the
    // caller's budget did pay to read.
    expect(found.bytesScanned).toBe(ceiling);
    expect(found.filesSearched).toBe(1);
    expect(found.truncated).toBe(true);
    expect(found.hits.length).toBeGreaterThanOrEqual(1);
    expect(new Set(filesOf(found))).toEqual(new Set([firstPath]));

    const hit = at(found.hits, 0, `a hit inside the examined head of '${firstPath}'`);
    expect(matchedTextOf(hit).toLowerCase()).toBe(REPEATED_TOKEN.toLowerCase());

    // The location comes from the whole file, never from the prefix, so it
    // names the same place a complete scan would have named.
    const line = lineTextOf(loaded, firstPath, hit.location.line);
    const columnIndex = hit.location.column - 1;
    expect(
      line.slice(columnIndex, columnIndex + REPEATED_TOKEN.length).toLowerCase(),
      `'${firstPath}' line ${String(hit.location.line)} must hold the token at column ${String(hit.location.column)}, and holds: ${line}`,
    ).toBe(REPEATED_TOKEN.toLowerCase());
  });

  it('reports no match that reaches the cut, because its extent was never read', () => {
    const loaded = corpusProject();
    const firstPath = firstScannedPathOf(loaded);
    const firstText = fileTextOf(loaded, firstPath);
    const offset = firstOffsetOf(firstText, REPEATED_TOKEN);
    expect(offset).toBeGreaterThanOrEqual(0);

    // The cut falls exactly at the end of the only occurrence inside the
    // prefix. Its trailing `wholeWord` boundary — and, for a pattern, its own
    // greedy extent — would be decided by characters the ceiling forbade
    // reading, so it is neither reported nor counted as observed.
    const ceiling = offset + REPEATED_TOKEN.length;
    expect(ceiling).toBeLessThan(firstText.length);

    const found = findInCorpus({ ...BUDGET, query: REPEATED_TOKEN, maxScannedBytes: ceiling });

    expect(found.hits).toEqual([]);
    expect(found.totalMatches).toBe(0);
    expect(found.bytesScanned).toBe(ceiling);
    expect(found.filesSearched).toBe(1);
    expect(found.truncated).toBe(true);
  });

  it('reports an exhaustive scan when the ceiling covers the whole corpus', () => {
    const loaded = corpusProject();
    const total = totalCharsOf(loaded);

    // A ceiling exactly equal to the corpus clips nothing: the last file fits
    // the budget that remains, so `truncated` must stay `false` — a cap that
    // reported truncation at its own boundary would make an exhaustive result
    // indistinguishable from a partial one.
    const exact = findInCorpus({ ...BUDGET, query: MARKER, maxScannedBytes: total });
    expect(exact.truncated).toBe(false);
    expect(exact.bytesScanned).toBe(total);
    expect(exact.filesSearched).toBe(loaded.sourceFiles().length);
    expect(exact.hits.length).toBe(MARKER_OCCURRENCES);

    const generous = findInCorpus({ ...BUDGET, query: MARKER, maxScannedBytes: total + 1 });
    expect(generous.truncated).toBe(false);
    expect(generous.bytesScanned).toBe(total);
    expect(generous.filesSearched).toBe(loaded.sourceFiles().length);
    expect(generous.hits.length).toBe(MARKER_OCCURRENCES);
  });

  it('keeps every location valid and every excerpt intact under a clipped scan', () => {
    const loaded = corpusProject();
    const known = relativePathsOf(loaded);
    // A third of the corpus: several files whole, and one examined only as far
    // as the budget reached.
    const ceiling = Math.floor(totalCharsOf(loaded) / 3);
    expect(ceiling).toBeGreaterThan(0);

    const found = findInCorpus({ ...BUDGET, query: REPEATED_TOKEN, maxScannedBytes: ceiling });

    expect(found.bytesScanned).toBe(ceiling);
    expect(found.truncated).toBe(true);
    expect(found.hits.length).toBeGreaterThan(1);

    for (const hit of found.hits) {
      // The bounded prefix bounds the excerpt window and nothing else. If it
      // had been mistaken for the file's text anywhere else — in the line and
      // column, or in the match offset — these are the invariants that would
      // break, one process away from where the mistake was made.
      const parsed = parseSourceLocation(hit.location);
      expect(
        isOk(parsed),
        `the location of ${hit.location.file}:${String(hit.location.line)} must satisfy the shared schema under a clipped scan`,
      ).toBe(true);
      expect(known).toContain(hit.location.file);

      expect(matchedTextOf(hit).toLowerCase()).toBe(REPEATED_TOKEN.toLowerCase());
      expect(hit.matchOffsetInExcerpt + hit.matchLength).toBeLessThanOrEqual(hit.excerpt.length);
      expect(hit.excerpt).not.toContain('\n');
      expect(hit.excerpt).not.toContain('\r');

      const line = lineTextOf(loaded, hit.location.file, hit.location.line);
      const columnIndex = hit.location.column - 1;
      expect(
        line.slice(columnIndex, columnIndex + REPEATED_TOKEN.length).toLowerCase(),
        `'${hit.location.file}' line ${String(hit.location.line)} must hold the token at column ${String(hit.location.column)}, and holds: ${line}`,
      ).toBe(REPEATED_TOKEN.toLowerCase());
      // A contiguous slice of the real line, even when the prefix ended inside
      // that line.
      expect(line).toContain(hit.excerpt);
    }
  });

  it('never runs a pattern against a file it could only examine in part', () => {
    // The reason a *pattern* may not be handed the leading characters of a file
    // the way a literal may. A regular expression is evaluated against the
    // string it is executed over, so a budget cut would present itself as the
    // end of the file: `$`, `\b` and every lookahead would answer about the cut
    // rather than about the file. The two patterns below are built to match at
    // the cut and *not* in the real file, so a partial examination would return
    // them as evidence for something that is not in the developer's code —
    // which is worse than an incomplete answer, because this module's output is
    // what an investigation reasons over.
    const loaded = corpusProject();
    const firstPath = firstScannedPathOf(loaded);
    const firstText = fileTextOf(loaded, firstPath);
    const offset = firstOffsetOf(firstText, REPEATED_TOKEN);
    expect(offset).toBeGreaterThanOrEqual(0);

    const cut = offset + REPEATED_TOKEN.length;
    expect(cut).toBeLessThan(firstText.length);

    // Taken from the file's own text rather than from the token, so the case
    // does not depend on how the corpus capitalises it.
    const occurrence = firstText.slice(offset, cut);
    const head = escapeForPattern(occurrence.slice(0, -1));
    const tail = escapeForPattern(occurrence.slice(-1));
    expect(occurrence).toHaveLength(REPEATED_TOKEN.length);

    // Each pattern consumes only `head`, so its consumed extent ends *before*
    // the cut and the rule that drops a match touching the cut cannot catch it;
    // what reaches the cut is the assertion.
    const anchored = `${head}(?=${tail}$)`;
    const negated = `${head}(?!${tail}[\\s\\S])`;

    for (const pattern of [anchored, negated]) {
      // Full-file truth first: the token is not at the end of the file, so
      // neither pattern matches anything when every file is examined whole.
      const whole = findInCorpus({ ...BUDGET, query: pattern, regex: true });
      expect(
        whole.hits,
        `'${pattern}' must match nothing in the whole corpus for this case to mean anything`,
      ).toEqual([]);
      expect(whole.totalMatches).toBe(0);

      // And the same truth under a budget that stops inside the first file.
      const clipped = findInCorpus({
        ...BUDGET,
        query: pattern,
        regex: true,
        maxScannedBytes: cut,
      });

      expect(clipped.hits).toEqual([]);
      expect(clipped.totalMatches).toBe(0);
      // Skipping is still a cap clipping something, and the caller has to know.
      expect(clipped.truncated).toBe(true);
      // A file the budget cannot hold whole is skipped rather than examined in
      // part, so it contributes to neither total — exactly as a file over the
      // single-file size cap does. The counts are not zero, because the scan
      // goes on to the smaller files that *do* still fit the budget whole, and
      // a pattern run over a whole file is answering about that file.
      expect(clipped.bytesScanned).toBeLessThanOrEqual(cut);
      expect(clipped.filesSearched).toBeLessThan(loaded.sourceFiles().length);
    }
  });

  it('reports the file a pattern could not be run against in part', () => {
    const loaded = corpusProject();
    const { logger, records } = createRecordingLogger();
    const firstPath = firstScannedPathOf(loaded);

    const found = searchOrFail(loaded, {
      ...BUDGET,
      query: escapeForPattern(REPEATED_TOKEN),
      regex: true,
      maxScannedBytes: 10,
      logger,
    });

    expect(found.truncated).toBe(true);
    expect(found.bytesScanned).toBe(0);

    // One record per skipped file, and the first candidate must be among them.
    const skipped = records.filter((record) => record.fields?.['remaining'] !== undefined);
    expect(
      skipped.length,
      `the scan must say which files a pattern could not be run against, and logged: ${records.map((record) => record.message).join(' | ')}`,
    ).toBeGreaterThanOrEqual(1);
    expect(skipped.map((record) => record.fields?.['file'])).toContain(firstPath);
    for (const record of skipped) {
      expect(record.level).toBe('debug');
      for (const [key, value] of Object.entries(record.fields ?? {})) {
        expect(
          typeof value,
          `field '${key}' of the skipped-file record must be a count or a path`,
        ).toMatch(/^(?:number|string)$/);
      }
    }
  });
});

describe('searchText: an unclipped search', () => {
  it('reports truncated as false when no cap clipped anything', () => {
    const found = findInCorpus({ ...BUDGET, query: MARKER });

    expect(found.truncated).toBe(false);
    for (const hit of found.hits) {
      expect(hit.truncated).toBe(false);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The SourceLocation on every hit
 *
 * A hit's location is what opens in an editor two processes away, so it has to
 * satisfy the shared schema rather than merely look right here.
 * ---------------------------------------------------------------------------
 */

describe('searchText: every hit carries a valid SourceLocation', () => {
  it('produces locations the shared schema accepts', () => {
    const loaded = corpusProject();
    const known = relativePathsOf(loaded);
    const found = findInCorpus({ ...BUDGET, query: REPEATED_TOKEN, maxMatchesPerFile: 1 });

    expect(found.hits.length).toBeGreaterThan(1);

    for (const hit of found.hits) {
      const parsed = parseSourceLocation(hit.location);
      expect(
        isOk(parsed),
        `the location of ${hit.location.file}:${String(hit.location.line)} must satisfy the shared schema`,
      ).toBe(true);

      expect(hit.location.resolvedBy).toBe('code-graph');
      expect(hit.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);

      expect(Number.isInteger(hit.location.line)).toBe(true);
      expect(Number.isInteger(hit.location.column)).toBe(true);
      expect(hit.location.line).toBeGreaterThanOrEqual(1);
      expect(hit.location.column).toBeGreaterThanOrEqual(1);

      // Project-relative POSIX, and therefore independent of where this
      // repository is checked out.
      expect(known).toContain(hit.location.file);
      expect(hit.location.file.startsWith('/')).toBe(false);
      expect(hit.location.file.startsWith('./')).toBe(false);
      expect(hit.location.file.startsWith('..')).toBe(false);
      expect(hit.location.file).not.toContain('\\');
      expect(hit.location.file).not.toContain(FIXTURE_ROOT);
    }
  });

  it('names no symbol and no end line', () => {
    const found = findInCorpus({ ...BUDGET, query: MARKER });

    for (const hit of found.hits) {
      // Naming the enclosing symbol is the abstract-syntax-tree layer's job,
      // and a text match need not be inside one at all; a hit never spans more
      // than the line it starts on, so an end line would always repeat `line`.
      expect(hit.location.symbol).toBeUndefined();
      expect(hit.location.endLine).toBeUndefined();
      expect(Object.keys(hit.location).sort()).toEqual([
        'column',
        'confidence',
        'file',
        'line',
        'resolvedBy',
      ]);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Empty and refused searches
 *
 * The module never throws: a query it cannot run comes back as an `Err` with a
 * code from the shared vocabulary and a `details.reason` a caller can branch
 * on. A search that simply found nothing is a *success*, and the difference
 * between the two is what these cases pin.
 * ---------------------------------------------------------------------------
 */

/** Asserts an error is this module's one error shape, carrying `reason`. */
function expectModuleError(error: DebuggenError, reason: string): void {
  expect(DebuggenError.is(error)).toBe(true);
  expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
  expect(reasonOf(error)).toBe(reason);
  expect(error.details?.operation).toBe('text-search');
  expect(error.message.length).toBeGreaterThan(0);
  expect(typeof error.hint).toBe('string');
}

describe('searchText: a search that finds nothing', () => {
  it('succeeds with a complete, well-formed empty envelope', () => {
    const loaded = corpusProject();
    const found = findInCorpus({ ...BUDGET, query: ABSENT_QUERY });

    expect(found.hits).toEqual([]);
    expect(found.totalMatches).toBe(0);
    expect(found.truncated).toBe(false);
    expect(found.filesSearched).toBe(loaded.sourceFiles().length);
    expect(found.bytesScanned).toBe(totalCharsOf(loaded));
    expect(found.query).toBe(ABSENT_QUERY);
  });
});

describe('searchText: a query it refuses to run', () => {
  it('refuses an empty query as a value rather than an exception', () => {
    const loaded = corpusProject();
    const options: TextSearchOptions = { ...BUDGET, query: '' };

    expect(() => searchText(loaded, options)).not.toThrow();
    expectModuleError(refusalFrom(options), 'query-empty');
  });

  it('refuses a whitespace-only query', () => {
    expectModuleError(refusalFrom({ ...BUDGET, query: ' \t\n ' }), 'query-empty');
  });

  it('refuses a query longer than the module allows and accepts one at the limit', () => {
    const tooLong = 'x'.repeat(TEXT_SEARCH_LIMITS.maxQueryLength + 1);
    const error = refusalFrom({ ...BUDGET, query: tooLong });
    expectModuleError(error, 'query-too-long');
    expect(error.details?.maxQueryLength).toBe(TEXT_SEARCH_LIMITS.maxQueryLength);

    // The boundary itself is accepted: the cap is "longer than", not "as long as".
    const atLimit = findInCorpus({
      ...BUDGET,
      query: 'x'.repeat(TEXT_SEARCH_LIMITS.maxQueryLength),
    });
    expect(atLimit.hits).toEqual([]);
    expect(atLimit.query.length).toBe(TEXT_SEARCH_LIMITS.maxQueryLength);
  });

  it('reports an invalid regular expression instead of throwing', () => {
    const loaded = corpusProject();
    const options: TextSearchOptions = { ...BUDGET, query: '(unclosed', regex: true };

    expect(() => searchText(loaded, options)).not.toThrow();
    expectModuleError(refusalFrom(options), 'pattern-invalid');
  });

  it('refuses a pre-aborted search rather than returning a partial success', () => {
    const loaded = corpusProject();
    const options: TextSearchOptions = { ...BUDGET, query: MARKER, signal: AbortSignal.abort() };

    const found = searchText(loaded, options);
    expect(isErr(found)).toBe(true);
    expectModuleError(refusalFrom(options), 'aborted');
  });
});

describe('searchText: arguments of unknown provenance', () => {
  /*
   * This module is the fallback retrieval route for a name the code graph does
   * not hold (AAP 0.4.2), so a call reaching it is assembled from a model's
   * output by `apps/local-service/src/pipeline/tools/code-tools.ts`. An
   * `options` argument that is not an object at all is therefore an ordinary
   * input rather than a programming error, and AAP 0.5.5 requires the stage to
   * degrade: one refused query, not a crashed investigation.
   *
   * Both arguments are admitted before either is read, which is the whole
   * property — `options.logger` off a `null` was the one way this function
   * could raise a `TypeError` instead of returning a `Result`.
   */
  const hostile: readonly unknown[] = [undefined, null, 0, 42, 'query', [], true, () => 1];

  /**
   * The type description this module puts in `details.received`, restated here
   * so a case can assert it without importing the module's private helper.
   *
   * @param value The refused argument.
   * @returns Its type description.
   */
  function describeValue(value: unknown): string {
    if (value === null) {
      return 'null';
    }

    return Array.isArray(value) ? 'array' : typeof value;
  }

  it('refuses an options argument that is not an object, as a value', () => {
    const loaded = corpusProject();

    for (const value of hostile) {
      const options = value as TextSearchOptions;

      expect(() => searchText(loaded, options)).not.toThrow();

      const found = searchText(loaded, options);

      expect(isErr(found)).toBe(true);
      expectModuleError(refusalFrom(options), 'options-invalid');
    }
  });

  it('names the kind of value it refused, and never the value', () => {
    const refusal = refusalFrom(null as unknown as TextSearchOptions);

    expect(refusal.details?.received).toBe('null');
    expect(reasonOf(refusalFrom([] as unknown as TextSearchOptions))).toBe('options-invalid');
    expect(refusalFrom(['secret-value'] as unknown as TextSearchOptions).details?.received).toBe(
      'array',
    );
    // An array is refused rather than read as an object with numeric keys,
    // because a list of terms is a plausible thing for a tool call to send and
    // it names no query.
    expect(
      JSON.stringify(refusalFrom(['secret-value'] as unknown as TextSearchOptions).details),
    ).not.toContain('secret-value');
  });

  it('refuses a project argument that is not the handle openProject returns', () => {
    const options: TextSearchOptions = { ...BUDGET, query: MARKER };

    for (const value of hostile) {
      const loaded = value as LoadedProject;

      expect(() => searchText(loaded, options)).not.toThrow();

      const found = searchText(loaded, options);

      if (isOk(found)) {
        expect.unreachable('a search without a project handle cannot succeed');
      } else {
        expectModuleError(found.error, 'project-invalid');
        expect(found.error.details?.received).toBe(describeValue(value));
      }
    }
  });

  it('accepts any handle carrying the three members it reads, and searches through it', () => {
    // Structural rather than nominal on purpose: the handle crosses a package
    // boundary, so the guard asks for the members this module uses and nothing
    // more. A handle reporting no files is a search of nothing, not a refusal.
    const empty: LoadedProject = {
      ...corpusProject(),
      sourceFiles: () => [],
    };

    const found = searchOrFail(empty, { ...BUDGET, query: MARKER });

    expect(found.hits).toEqual([]);
    expect(found.filesSearched).toBe(0);
    expect(found.bytesScanned).toBe(0);
  });

  it('refuses the options argument before the project argument', () => {
    // Order is part of the contract: the message a developer sees for a call
    // that is wrong in both places names the argument they control.
    const found = searchText(
      undefined as unknown as LoadedProject,
      undefined as unknown as TextSearchOptions,
    );

    expect(isErr(found)).toBe(true);
    if (isErr(found)) {
      expectModuleError(found.error, 'options-invalid');
    }
  });
});

describe('searchText: regular-expression mode', () => {
  it('finds the marker through a pattern and agrees with the literal search', () => {
    const literal = findInCorpus({ ...BUDGET, query: MARKER });
    const pattern = findInCorpus({
      ...BUDGET,
      // `\s+` for the run of spaces and a one-character class for each literal
      // hyphen, so the pattern exercises the engine without tripping the
      // backtracking screen.
      query: '//\\s+fixture[-]marker:\\s+basin[-]drift',
      regex: true,
    });

    expect(pattern.hits.length).toBe(MARKER_OCCURRENCES);
    expect(filesOf(pattern)).toEqual(MARKER_FILES);
    expect(locationsOf(pattern)).toEqual(locationsOf(literal));
  });

  it('never hangs on a pattern that could backtrack catastrophically', () => {
    const loaded = corpusProject();
    // A repeated group whose body is itself quantified: the shape the static
    // screen exists to refuse. Either it is refused outright, or it completes
    // within the time budget and says the scan was cut short — never a hang,
    // which is what the explicit per-case timeout turns into a fast failure.
    const found = searchText(loaded, { ...BUDGET, query: '(a+)+b', regex: true });

    if (isErr(found)) {
      expect(DebuggenError.is(found.error)).toBe(true);
      expect(DEBUGGEN_ERROR_CODES).toContain(found.error.code);
      expect(reasonOf(found.error)).toBe('pattern-backtracking-risk');
      return;
    }

    expect(found.value.truncated).toBe(true);
  }, 5_000);
});

/*
 * ---------------------------------------------------------------------------
 * Glob filters over paths that contain regular-expression punctuation
 *
 * The corpus has `app/(observatory)/…`, `[id]` and `[...segments]` in real
 * paths, so a glob engine that read them as a group and a character class
 * would silently filter the wrong files. Every character that is not `**`, `*`
 * or `?` has to match literally.
 * ---------------------------------------------------------------------------
 */

describe('searchText: glob filters', () => {
  it('keeps only the files an include glob names', () => {
    const unfiltered = findInCorpus({ ...BUDGET, query: MARKER });
    const found = findInCorpus({ ...BUDGET, query: MARKER, includeGlobs: ['app/**'] });

    expect(found.hits.length).toBe(1);
    expect(at(found.hits, 0, 'the one hit under app/').location.file).toBe(
      at(MARKER_FILES, 0, 'the first marker file'),
    );

    // Applied before scanning rather than after: fewer files were read, not
    // merely fewer hits reported.
    expect(found.filesSearched).toBeLessThan(unfiltered.filesSearched);
    expect(found.filesSearched).toBeGreaterThan(0);
    expect(found.bytesScanned).toBeLessThan(unfiltered.bytesScanned);
    expect(found.truncated).toBe(false);
  });

  it('drops a route group named with parentheses through an exclude glob', () => {
    const found = findInCorpus({
      ...BUDGET,
      query: MARKER,
      excludeGlobs: ['app/(observatory)/**'],
    });

    expect(found.hits.length).toBe(1);
    expect(at(found.hits, 0, 'the remaining hit').location.file).toBe(
      at(MARKER_FILES, 1, 'the second marker file'),
    );
    expect(found.filesSearched).toBeLessThan(corpusProject().sourceFiles().length);
  });

  it('matches a single segment with * without crossing a separator', () => {
    const flat = findInCorpus({ ...BUDGET, query: MARKER, includeGlobs: ['src/lib/*.ts'] });
    expect(filesOf(flat)).toEqual([at(MARKER_FILES, 1, 'the second marker file')]);
    expect(flat.truncated).toBe(false);

    // `**` reaches the nested `src/lib/stubs` modules that a single-segment `*`
    // cannot, so the recursive pattern must read strictly more files — which is
    // the assertion that `*` stops at a separator.
    const recursive = findInCorpus({ ...BUDGET, query: MARKER, includeGlobs: ['src/lib/**'] });
    expect(flat.filesSearched).toBeGreaterThan(0);
    expect(flat.filesSearched).toBeLessThan(recursive.filesSearched);
    expect(filesOf(recursive)).toEqual(filesOf(flat));
  });

  it('lets exclude win when both filters name the same file', () => {
    const found = findInCorpus({
      ...BUDGET,
      query: MARKER,
      includeGlobs: ['app/**'],
      excludeGlobs: ['app/**'],
    });

    expect(found.hits).toEqual([]);
    expect(found.filesSearched).toBe(0);
    expect(found.bytesScanned).toBe(0);
    expect(found.truncated).toBe(false);
  });

  it('returns a well-formed empty envelope for a glob that matches nothing', () => {
    const found = findInCorpus({
      ...BUDGET,
      query: MARKER,
      includeGlobs: ['no-such-directory/**'],
    });

    expect(found.hits).toEqual([]);
    expect(found.totalMatches).toBe(0);
    expect(found.filesSearched).toBe(0);
    expect(found.bytesScanned).toBe(0);
    expect(found.truncated).toBe(false);
    expect(found.query).toBe(MARKER);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Privacy: a file the loader excluded is never searched
 *
 * This is the AAP 0.5.2 privacy guarantee expressed at the search layer. The
 * control itself lives in `../project.ts` — `.env` and every `.env.*` variant,
 * `node_modules`, `.next`, `dist`, `out`, `build`, `coverage`, minified bundles
 * and hidden trees are excluded before a byte is read — and
 * `packages/code-analysis/src/project.test.ts` is where the loader-layer tables
 * are asserted. This group deliberately does not repeat them: it asserts the
 * *consequence* for a search, which is the one thing the loader suite cannot
 * see.
 *
 * The payloads are transparently synthetic (`PLANTED_VALUE=…`), and they live
 * only inside an `os.tmpdir()` sandbox, so `scripts/check-secrets.mjs` never
 * sees them as tracked content and the committed corpus stays untouched.
 * ---------------------------------------------------------------------------
 */

describe('searchText: excluded files are never searched', () => {
  /** The sandbox copy of the corpus, with the forbidden files planted into it. */
  let planted: LoadedProject | undefined;

  /** The project-relative paths planted, for a message that names them. */
  const plantedPaths: readonly string[] = [
    '.env',
    '.env.local',
    'node_modules/planted-pkg/index.ts',
    'node_modules/planted-pkg/index.js',
    'dist/bundle.ts',
    'dist/bundle.js',
    '.next/server/app/page.js',
  ];

  beforeAll(() => {
    const root = join(makeSandbox(), 'corpus-copy');
    cpSync(FIXTURE_ROOT, root, { recursive: true });

    // Every planted file carries the marker — the query the legitimate corpus
    // also answers — so a search that read one of them would report a hit
    // rather than silently agreeing with the expected set. Each also carries a
    // value that exists nowhere else, for the stronger assertion below.
    const envBody = `PLANTED_VALUE=${MARKER}\nPLANTED_ONLY=${PLANTED_ONLY_VALUE}\n`;
    const moduleBody = `export const PLANTED_VALUE = '${MARKER}';\nexport const PLANTED_ONLY = '${PLANTED_ONLY_VALUE}';\n`;

    plantFile(join(root, '.env'), envBody);
    plantFile(join(root, '.env.local'), envBody);
    plantFile(join(root, 'node_modules', 'planted-pkg', 'index.ts'), moduleBody);
    plantFile(join(root, 'node_modules', 'planted-pkg', 'index.js'), moduleBody);
    plantFile(join(root, 'dist', 'bundle.ts'), moduleBody);
    plantFile(join(root, 'dist', 'bundle.js'), moduleBody);
    plantFile(join(root, '.next', 'server', 'app', 'page.js'), moduleBody);

    // The positive control, and the reason the zero-hit assertions below mean
    // anything: every payload really is on disk, inside the project, carrying
    // both the marker and the planted-only value. Without this a helper that
    // silently wrote nothing would make this whole group pass for the wrong
    // reason. Read with `node:fs` deliberately — the point is exactly that the
    // bytes exist where the handle refuses to look.
    for (const path of plantedPaths) {
      const body = readFileSync(join(root, path), 'utf8');
      expect(body, `the planted '${path}' must carry the marker`).toContain(MARKER);
      expect(body, `the planted '${path}' must carry the planted-only value`).toContain(
        PLANTED_ONLY_VALUE,
      );
    }

    planted = openOrFail({ projectRoot: root });
  }, 30_000);

  /** The planted copy's handle, or a failure naming the missing `beforeAll`. */
  function plantedProject(): LoadedProject {
    if (planted === undefined) {
      return expect.unreachable('the planted copy was not opened: beforeAll did not run');
    }
    return planted;
  }

  it('answers the marker query with the two legitimate files only', () => {
    const loaded = plantedProject();
    const found = searchOrFail(loaded, { ...BUDGET, query: MARKER });

    expect(
      filesOf(found),
      `a search of a corpus with planted '${plantedPaths.join("', '")}' must report only the corpus' own marker files, and reported: ${locationsOf(found).join(', ')}`,
    ).toEqual(MARKER_FILES);

    for (const hit of found.hits) {
      const segments = hit.location.file.split('/');
      expect(segments.some((segment) => segment === '.env' || segment.startsWith('.env.'))).toBe(
        false,
      );
      for (const forbidden of FORBIDDEN_SEGMENTS) {
        expect(
          segments,
          `no hit may name a '${forbidden}' segment, and '${hit.location.file}' does`,
        ).not.toContain(forbidden);
      }
    }
  });

  it('searches exactly the loaded set, which holds none of the planted files', () => {
    const loaded = plantedProject();
    const found = searchOrFail(loaded, { ...BUDGET, query: MARKER });

    expect(found.filesSearched).toBe(loaded.sourceFiles().length);
    expect(found.bytesScanned).toBe(totalCharsOf(loaded));

    const searchable = relativePathsOf(loaded);
    for (const path of plantedPaths) {
      expect(searchable, `'${path}' must not be in the searchable set`).not.toContain(path);
    }
  });

  it('cannot find a value that exists only in the planted files', () => {
    // The strongest form available without mocking the filesystem: the value
    // is present on disk, inside the project, in files with indexable
    // extensions — so a zero-hit result proves their contents were never read,
    // not merely never reported.
    const found = searchOrFail(plantedProject(), { ...BUDGET, query: PLANTED_ONLY_VALUE });

    expect(
      found.hits,
      `a value planted only in '${plantedPaths.join("', '")}' must be unfindable, and the search reported: ${locationsOf(found).join(', ')}`,
    ).toEqual([]);
    expect(found.totalMatches).toBe(0);
    expect(found.truncated).toBe(false);
  });

  it('cannot be widened by a glob that names an excluded tree', () => {
    // A caller's globs can only ever remove a file from the inherited set, so
    // pointing one straight at `node_modules` finds nothing rather than
    // re-admitting it.
    const found = searchOrFail(plantedProject(), {
      ...BUDGET,
      query: MARKER,
      includeGlobs: ['node_modules/**', 'dist/**', '.next/**'],
    });

    expect(found.hits).toEqual([]);
    expect(found.filesSearched).toBe(0);
    expect(found.bytesScanned).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Determinism, purity, and what may be logged
 * ---------------------------------------------------------------------------
 */

describe('searchText: determinism and purity', () => {
  it('returns deeply equal results for two identical calls', () => {
    const first = findInCorpus({ ...BUDGET, query: REPEATED_TOKEN, maxMatchesPerFile: 2 });
    const second = findInCorpus({ ...BUDGET, query: REPEATED_TOKEN, maxMatchesPerFile: 2 });

    expect(second).toEqual(first);
    expect(locationsOf(second)).toEqual(locationsOf(first));
  });

  it('orders hits by file, then line, then column', () => {
    const found = findInCorpus({ ...BUDGET, query: REPEATED_TOKEN, maxMatchesPerFile: 3 });
    expect(found.hits.length).toBeGreaterThan(1);

    const tuples = found.hits.map(
      (hit) => [hit.location.file, hit.location.line, hit.location.column] as const,
    );
    const sorted = [...tuples].sort((left, right) => {
      if (left[0] !== right[0]) {
        // Byte-wise, as the module compares them: not a locale comparison, so
        // the expectation is the same on every machine.
        return left[0] < right[0] ? -1 : 1;
      }
      if (left[1] !== right[1]) {
        return left[1] - right[1];
      }
      return left[2] - right[2];
    });

    expect(tuples).toEqual(sorted);
  });

  it("mutates neither the caller's options nor the project", () => {
    const loaded = corpusProject();
    const options: TextSearchOptions = Object.freeze({
      ...BUDGET,
      query: MARKER,
      caseSensitive: false,
      wholeWord: false,
      includeGlobs: Object.freeze(['app/**', 'src/**']),
    });
    const optionsBefore = JSON.stringify(options);

    const filesBefore = loaded.sourceFiles();
    const compilerFilesBefore = loaded.project.getSourceFiles().length;

    const found = searchOrFail(loaded, options);
    expect(found.hits.length).toBe(MARKER_OCCURRENCES);

    expect(JSON.stringify(options)).toBe(optionsBefore);
    // The same frozen array instance, and no file added to the compiler behind
    // it: a search reads the project, it never loads into it.
    expect(loaded.sourceFiles()).toBe(filesBefore);
    expect(loaded.sourceFiles().length).toBe(filesBefore.length);
    expect(loaded.project.getSourceFiles().length).toBe(compilerFilesBefore);
  });

  it('logs counts, paths and cap events, and never what it matched', () => {
    const loaded = corpusProject();
    const searchable = relativePathsOf(loaded);
    const { logger, records } = createRecordingLogger();

    // A query with many matches, an excerpt budget that clips, a per-file quota
    // of one and a byte ceiling the corpus exceeds, so every cap event this
    // module can emit has a chance to be emitted.
    const found = searchOrFail(loaded, {
      ...BUDGET,
      query: 'fixture',
      maxExcerptChars: 24,
      maxMatchesPerFile: 1,
      maxScannedBytes: 12_000,
      logger,
    });

    expect(found.hits.length).toBeGreaterThan(0);
    expect(found.truncated).toBe(true);
    expect(records.length).toBeGreaterThan(1);

    const forbidden = [
      found.query,
      ...found.hits.map((hit) => hit.excerpt),
      ...found.hits.map((hit) => matchedTextOf(hit)),
      ...found.hits.map((hit) => lineTextOf(loaded, hit.location.file, hit.location.line)),
    ];

    for (const record of records) {
      // Diagnostic detail only: a log at info level or above would put the
      // search in a developer's ordinary output on every stage run.
      expect(record.level).toBe('debug');

      const serialised = JSON.stringify(record);
      for (const secret of forbidden) {
        expect(
          serialised,
          `a log record must carry no matched text, excerpt or line of source, and this one carries '${secret}': ${serialised}`,
        ).not.toContain(secret);
      }

      // Structural, not textual: every field is a count, a flag, or the
      // project-relative path of a file that was searched. Nothing else is
      // admissible, which is what keeps a future field from smuggling content
      // into a log line.
      for (const [key, value] of Object.entries(record.fields ?? {})) {
        if (typeof value === 'string') {
          expect(
            searchable,
            `the only string a log field may carry is a searched file's path, and '${key}' carries '${value}'`,
          ).toContain(value);
          continue;
        }
        expect(
          typeof value,
          `log field '${key}' must be a count, a flag or a path, and is a ${typeof value}`,
        ).toMatch(/^(?:number|boolean)$/);
      }
    }
  });
});
