/**
 * The code-index cache: one JSON entry per indexed project, stored under
 * `$DEBUGGEN_HOME/index`, named by the project's identity and kept fresh by a
 * fingerprint of every file that was read — the project hash plus each file's
 * modification time, with a content digest behind it.
 *
 * Indexing a real application with ts-morph costs seconds, and a session asks
 * for the index several times — once to understand the question, again to
 * investigate, again to resolve a runtime item back to a declaration. This
 * module is what makes the second and later answers immediate, and it is
 * deliberately the least clever module in the package.
 *
 * ## Where the entries live, and why it is not the project
 *
 * Nowhere inside the developer's checkout. The whole product keeps its state
 * under `$DEBUGGEN_HOME` (`~/.debuggen` by default) precisely so that using it
 * never shows up in `git status`: a cache file written beside a developer's
 * source would be an untracked file they have to notice, decide about and
 * ignore, which is exactly the kind of residue the reversibility guarantee
 * exists to avoid. The directory is created `0700` and every entry `0600`
 * through the hardened creators in `@debuggen/shared/node`, because the tree it
 * sits in also holds credentials and file backups, and one over-permissive
 * directory in it is a hole in all of them.
 *
 * The consequence for this module is that the cache directory may legitimately
 * be **absent at any moment**: the service's retention job
 * (`apps/local-service/src/store/retention.ts`) deletes the index cache of a
 * project that has not been opened within the retention window, and a developer
 * may remove `~/.debuggen` whenever they like. Every operation here therefore
 * treats a missing directory as an ordinary state rather than a failure, and
 * {@link IndexCache.save} recreates it.
 *
 * ## The one behavioural promise
 *
 * **The cache is a pure optimisation, so every problem is a miss.** A missing
 * entry, a directory that is not there, an unparsable file, an entry written by
 * an older version of this package, a structurally invalid document, a symbolic
 * link planted where an entry belongs, a permission error — all of them make
 * {@link IndexCache.load} return `undefined`, and none of them becomes an error
 * a caller has to handle. `./indexer.ts` must always be able to rebuild from
 * scratch, and this module's contract is what lets it treat a hit as a bonus
 * rather than a dependency.
 *
 * {@link IndexCache.save} is the one operation that reports a failure, as a
 * `Result` rather than a throw, and even that is advisory: the indexer logs it
 * and continues, because an index that was built but not cached is a slow
 * success and never a failure.
 *
 * One kind of failure is deliberately *not* a miss, because it is not a state
 * of the filesystem: an empty cache directory passed to
 * {@link createIndexCache}. A cache with nowhere to put its entries is a
 * misconfiguration, not a miss.
 *
 * Callers never compose a key. Every operation takes the
 * {@link IndexCacheKeyInput} — the project's identity and its file
 * fingerprints — and derives both keys below itself, so an entry's name and
 * its freshness key can never be computed two ways and drift apart. Every key
 * is a `stableHash` digest of 64 lowercase hexadecimal characters, so an entry
 * path can never contain a separator and nothing a project root spells can
 * traverse out of the cache directory.
 *
 * ## One entry per project
 *
 * The entry's **file name** is {@link computeIndexCacheEntryKey}: a digest of
 * the project's identity alone — its root, the TypeScript configuration in
 * force, the indexer's version, the identities of the extractors that ran and
 * the order they ran in, this module's envelope version and the graph
 * vocabulary version. No per-file state reaches it, so every index of one
 * project is written to the same file and a save **overwrites** it atomically
 * rather than adding a sibling. The cache directory therefore holds one entry
 * per project however often the project is edited, patched and restored,
 * instead of one per state the tree has ever been in.
 *
 * ## What decides that an entry is fresh
 *
 * Three layers, cheapest first. Each one only runs when the one before it
 * could not answer.
 *
 * 1. **The state key — the fast path.** The envelope records
 *    {@link computeIndexCacheKey} as it stood when the index was saved: the
 *    project hash plus the modification time, size and optional digest of
 *    every indexed file. A lookup whose own state key equals it, and whose
 *    per-file stamps all equal the recorded ones, is a hit after one `stat`
 *    per file. Nothing is read and nothing is hashed, which is what keeps an
 *    ordinary hit microseconds against the seconds a rebuild costs.
 * 2. **The stamps — what metadata can prove.** `mtimeMs` and `size` can both
 *    survive a content substitution: `tar -x`, `cp -p`, `rsync --times`,
 *    `touch -r` and a hermetic build-cache restore all write new bytes under an
 *    old modification time, and a body of the same byte length keeps the size.
 *    So {@link IndexCache.save} records a {@link FileStamp} per indexed file
 *    that also carries the inode's change time, `ctimeMs`, which the kernel
 *    moves on every write and no process can set, and the inode number, which
 *    catches a file swapped in by `rename`. A file whose stamp still equals the
 *    recorded one is proven unchanged without being read.
 * 3. **The content digest — what metadata cannot prove.** The envelope also
 *    records the SHA-256 digest of every file's bytes as they were when the
 *    entry was written. A file whose stamp moved — a rewrite with identical
 *    content, a `chmod`, a checkout, or the product's own reversible patch and
 *    its byte-for-byte restore — is read once and its digest compared. When the
 *    file set is the same and every file whose stamp moved still holds the
 *    recorded bytes, the entry is a **hit**: the index describes exactly this
 *    content. The entry is then re-saved with the current fingerprints, stamps
 *    and state key, so the next lookup takes the fast path again instead of
 *    re-reading the same files.
 *
 * Anything else is an ordinary miss, and the rebuild that follows overwrites
 * the same per-project file: a file added or removed, a file whose bytes
 * differ from the recorded digest (so a substitution under preserved metadata
 * is still caught), a file that changed while it was being read, and a file
 * whose digest was never established.
 *
 * Three consequences worth stating:
 *
 * - **The cost follows what moved.** An untouched tree costs one `stat` per
 *   file; a tree whose metadata moved costs one read of each file that moved,
 *   stopping at the first one whose content differs; only a real content
 *   change costs a rebuild.
 * - **It fails closed.** A digest that cannot be computed, a read that races a
 *   write, a fingerprint that no longer describes the file it names — each is a
 *   miss, never a guess. A spurious miss is slow; a spurious hit is wrong.
 * - **A synthesised index still round-trips.** A caller may cache an index
 *   over files that do not exist on disk — a fixture, a projection, a tree that
 *   has since been removed — and an absent stamp compares equal to an absent
 *   stamp, so such an entry is stored and served on the fast path exactly as
 *   before.
 *
 * Retention and pruning are **not** this module's responsibility. It never
 * enumerates the directory except when explicitly asked to
 * ({@link IndexCache.clear}), never deletes an entry other than the one it was
 * asked about or one it has just rejected, and imposes no size or age bound.
 * The service owns that policy — including removing entries an older envelope
 * version wrote under another naming scheme, and entries of one project that a
 * newer one superseded — and keeping it there is what stops two components
 * from deleting each other's state on different schedules.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DebuggenError,
  assert,
  err,
  isErr,
  isSafeRelativePath,
  joinPosix,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  resolveWithinProject,
  toPosix,
  tryCatch,
} from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';
import {
  ensureSecureDir,
  readFileNoFollow,
  stableHash,
  writeSecureFileAtomic,
} from '@debuggen/shared/node';

import {
  CODE_INDEX_SCHEMA_VERSION,
  INDEX_DIAGNOSTIC_SEVERITIES,
  isCodeEdgeKind,
  isCodeNodeKind,
  isIndexDiagnosticCode,
} from './graph/types.js';
import type { CodeIndex, CodeNodeKind, FileFingerprint } from './graph/types.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The version of the **on-disk cache entry** this module reads and writes.
 *
 * Bump it whenever the persisted document changes shape: a new envelope field,
 * a different key derivation, a different file layout under
 * `$DEBUGGEN_HOME/index`. An entry whose envelope version is not this value is
 * a **silent miss** — it is logged at `debug`, dropped from the directory so it
 * cannot be re-read on every run, and the index is rebuilt. That is the whole
 * migration story on purpose: a cache is derived data, and code that migrates
 * derived data is code that can be wrong about it.
 *
 * Deliberately distinct from `CODE_INDEX_SCHEMA_VERSION` in
 * `./graph/types.ts`, which versions the *contents* of an index — the node and
 * edge vocabularies. Either version moving invalidates an entry, and each has
 * to be able to move without the other, which is why both are folded into
 * both keys — {@link computeIndexCacheEntryKey} and
 * {@link computeIndexCacheKey} — and why this one is also recorded in the
 * envelope. The service's retention sweep reads it back from the envelope too:
 * an entry of an older version sits under a name this version never asks for,
 * so the sweep is what removes it.
 *
 * Annotated `number` rather than left as a literal type so that comparing it
 * with a version *read back from disk* is a real runtime question rather than a
 * comparison the compiler could narrow away, and so that bumping it is a
 * one-character change no consumer's types depend on.
 *
 * History, so that the reason for the current value is on the record:
 *
 * - `1` — the original envelope: version, key, write time and index.
 * - `2` — added `stamps`, the per-file change stamps
 *   {@link IndexCache.load} verifies. The persisted document changed shape, so
 *   a version-1 entry is missing a field this version requires; because the
 *   version is folded into the key as well as into the envelope, those entries
 *   are both unreachable and rejected, which is the whole migration.
 * - `3` — one entry per project. The file name became the project-identity key
 *   ({@link computeIndexCacheEntryKey}) instead of a key over every file's
 *   metadata, the envelope gained `stateKey` (the former key, now the fast
 *   path's comparison value) and every stamp gained `contentHash`, the digest
 *   that lets a file whose metadata moved but whose bytes did not keep its
 *   entry (see "What decides that an entry is fresh"). Version-2 entries sit
 *   under names this version never derives, so they are unreachable; the
 *   service's retention sweep removes them by the version their envelope
 *   records.
 */
export const INDEX_CACHE_SCHEMA_VERSION: number = 3;

/**
 * The shape of a cache key, and the gate every filesystem operation here passes
 * through.
 *
 * 64 lowercase hexadecimal characters: exactly what `stableHash` produces. The
 * pattern is anchored at both ends, so a key can hold no separator, no dot, no
 * `..` and no whitespace, which is what reduces "validate the key" and "prevent
 * a path traversal" to the same single test.
 */
const CACHE_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** The extension every entry file carries, and the only one {@link IndexCache.clear} removes. */
const ENTRY_FILE_EXTENSION = '.json';

/**
 * The first part of every state key, so a digest produced here can never equal
 * one produced by another part of the product over coincidentally similar
 * inputs.
 *
 * Cheap domain separation: `stableHash` frames each part, so this prefix makes
 * the key space of this module disjoint from every other `stableHash` caller's
 * by construction rather than by naming discipline.
 */
const KEY_DOMAIN = 'debuggen/code-index-cache';

/**
 * The first part of every entry key: distinct from {@link KEY_DOMAIN}, so an
 * entry's name and a state key can never be the same digest even for a
 * project with no files, where the two would otherwise hash nearly the same
 * parts.
 */
const ENTRY_KEY_DOMAIN = 'debuggen/code-index-cache/entry';

/**
 * The `contentHash` of a stamp whose file's bytes were not established when the
 * entry was written — an absent file, an unreadable one, one that changed while
 * it was being read.
 *
 * Empty, because a SHA-256 digest never is, so it can never equal a digest
 * computed at load time: a file recorded with it can be proven unchanged by its
 * stamp alone, never by its content, which is the fail-closed direction.
 */
const UNVERIFIED_CONTENT_HASH = '';

/** The shape of a recorded content digest: SHA-256 as 64 lowercase hexadecimal characters. */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The size of the buffer a file is hashed through: 64 KiB.
 *
 * Hashing streams through one reused buffer rather than reading a file whole,
 * so a large generated module in the indexed set costs a bounded amount of
 * memory; the value matches the chunk size Node's own read streams use.
 */
const HASH_CHUNK_BYTES = 64 * 1024;

/**
 * The flags a file is opened with to be hashed: read-only and non-blocking.
 *
 * `O_NONBLOCK` has no effect on a regular file and is there for the file that
 * is not one: a FIFO planted where a source file was would otherwise block the
 * open — and the service with it — until a writer appeared. The descriptor is
 * checked with `fstat` right after opening and anything but a regular file is
 * refused before a byte is read. `O_NONBLOCK` is absent on Windows, where no
 * such file type exists, and contributes nothing there.
 */
const HASH_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

/**
 * The value that occupies a key slot whose input is absent.
 *
 * Each fingerprint contributes a **fixed number of parts** and so does the
 * project header, so a missing TypeScript configuration or a missing content
 * hash cannot shift the following parts into another slot. Within a
 * fixed-arity layout an empty string is therefore an unambiguous "absent"
 * marker: neither a path nor a digest can legitimately be empty.
 */
const ABSENT_SLOT = '';

/**
 * Separates the fields of a composite key built from a path and some numbers —
 * a fingerprint's ordering key ({@link fingerprintSortKey}) and a stamp's
 * comparison key ({@link stampKey}).
 */
const SORT_KEY_SEPARATOR = '\u0000';

/** The environment variable naming the product's state root, for standalone use. */
const DEBUGGEN_HOME_ENV = 'DEBUGGEN_HOME';

/** The state-root directory created inside the user's home when nothing names one. */
const DEFAULT_STATE_DIRECTORY_NAME = '.debuggen';

/** The subdirectory of the state root that holds this module's entries. */
const INDEX_DIRECTORY_NAME = 'index';

/** A path of exactly `~`, which {@link resolveIndexCacheDir} expands to the home directory. */
const HOME_MARKER = '~';

/** The prefix {@link resolveIndexCacheDir} expands to the home directory. */
const HOME_PREFIX = '~/';

/** The single message every miss is logged under, so one filter finds them all. */
const MISS_MESSAGE = 'code index cache miss';

/** The single message every hit is logged under, on either path to it. */
const HIT_MESSAGE = 'code index cache hit';

/** What a developer can do about a cache that cannot be written. */
const WRITE_FAILURE_HINT =
  'The index will be rebuilt on the next run; if this keeps happening, check that the Debug Generator state directory is writable and owned by you.';

/* -------------------------------------------------------------------------------------------------
 * Key derivation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Everything both cache keys are derived from.
 *
 * The caller assembles this from the loaded project and the file list it is
 * about to index — or has just indexed — and passes the same input to
 * {@link IndexCache.load} and to {@link IndexCache.save}, which derive the
 * entry's name ({@link computeIndexCacheEntryKey}, identity only) and its
 * freshness key ({@link computeIndexCacheKey}, identity plus files) from it.
 * Passing one input rather than two keys is what makes the two agree.
 */
export interface IndexCacheKeyInput {
  /**
   * The indexed project's root, as `LoadedProject.projectRoot` normalised it.
   *
   * Absolute, which is the one absolute path a {@link CodeIndex} carries: two
   * checkouts of the same repository are different projects to the cache, and
   * an index is keyed to the tree it describes rather than to its contents
   * alone. Separators are normalised here, so a caller that spells the same
   * directory with backslashes gets the same key.
   */
  readonly projectRoot: string;

  /**
   * The TypeScript configuration the project was opened with, when one was
   * found.
   *
   * Part of the key because it decides the compiler options — `paths` aliases
   * above all — and therefore which specifiers resolve and which edges the
   * graph ends up holding. An index built with a configuration and one built
   * with the indexer's defaults are different answers over the same files, so
   * they must not share a key. Absent (or empty) means "none was found".
   */
  readonly tsConfigFilePath?: string | undefined;

  /**
   * The version of the indexer that produced — or is about to produce — the
   * index.
   *
   * This is what invalidates every entry when the extraction logic changes
   * without the vocabulary changing: a new extractor, a corrected
   * classification, a different traversal. Because it is folded into the key,
   * an entry written by another indexer version is **unreachable** rather than
   * merely rejected, which is the cheapest correct form of invalidation.
   */
  readonly indexerVersion: string;

  /**
   * The identifiers of the extractors the index was built from — or is about to
   * be built from — **in the order they run in**.
   *
   * The second half of "how was this built", beside
   * {@link IndexCacheKeyInput.indexerVersion}: the version says which
   * implementations ran, this says *which extractors* ran. An index built from
   * a narrowed set covers less than a full one, so the two must not share a
   * key — otherwise a caller that deliberately narrowed its run would write an
   * incomplete graph under the full run's key and a later full request would be
   * served it as if it were whole. With the set in the key, a narrowed run
   * simply gets its own entry.
   *
   * **Order is significant and the list is not sorted.** Extraction order
   * decides the order nodes and edges are appended in, and therefore which
   * claimant of a duplicate id graph construction keeps, so two orders of the
   * same identifiers are two different indexes and get two different keys. A
   * caller passes the ids exactly as its extractor array holds them.
   *
   * An extractor's `id` is an **identity contract**, not a label: two different
   * implementations that share an id share a key, and the key cannot tell them
   * apart. For extractors that ship with this package that is covered by
   * `INDEXER_VERSION`, which every change to their output is required to bump;
   * a caller supplying an extractor of its own owns the same obligation for
   * that id.
   */
  readonly extractors: readonly string[];

  /**
   * The envelope version to key against. Defaults to
   * {@link INDEX_CACHE_SCHEMA_VERSION}.
   *
   * Overridable for tests, which need to prove that an entry written under one
   * envelope version is not served under another without waiting for a real
   * bump.
   */
  readonly schemaVersion?: number | undefined;

  /**
   * What every file to be indexed looked like when it was read.
   *
   * The unit of freshness, and deliberately **not** part of the entry's name: a
   * changed modification time or size anywhere in this list is a different
   * state key, which sends {@link IndexCache.load} from its stat-only fast path
   * to the content check, never to a different file. **Order does not
   * matter** — the list is sorted inside {@link computeIndexCacheKey} — so a
   * caller may pass files in traversal order, in the order a `Map` happened to
   * hold them, or sorted, and get the same key from all three.
   *
   * On a hit whose files' metadata moved while their content did not, these
   * are the fingerprints the returned index carries, because they are the ones
   * a rebuild of the same tree would record.
   */
  readonly files: readonly FileFingerprint[];
}

/**
 * The name of a project's cache entry: 64 lowercase hexadecimal characters,
 * derived from the project's **identity** and nothing that changes when a file
 * is edited.
 *
 * In order: a domain tag distinct from the state key's, the envelope version,
 * the graph vocabulary version, the indexer version, the number of extractors
 * followed by each extractor's identifier in run order, the project root and
 * the TypeScript configuration path — exactly the identity half of
 * {@link computeIndexCacheKey}, framed the same way. `input.files` is ignored,
 * which is the point: every state of one project is stored under this one
 * name, so a save replaces the project's previous entry instead of adding a
 * sibling, and the cache directory holds one entry per project.
 *
 * Everything that *does* distinguish two indexes of one project — a narrowed
 * extractor set, another configuration, another indexer or envelope version —
 * is still here, so those get their own entry and can never be served for each
 * other.
 *
 * Total: it never throws.
 *
 * @param input The project identity and extractor set; the file list is not
 * read.
 * @returns The entry key, matching {@link CACHE_KEY_PATTERN}.
 *
 * @example
 * ```ts
 * // `<cacheDir>/<entryKey>.json` is where this project's index lives.
 * const entryKey = computeIndexCacheEntryKey(keyInput);
 * ```
 */
export function computeIndexCacheEntryKey(input: IndexCacheKeyInput): string {
  return stableHash([ENTRY_KEY_DOMAIN, ...identityParts(input)]);
}

/**
 * The state key for one project state: 64 lowercase hexadecimal characters —
 * "the project hash plus every file's modification time". The envelope records
 * it, and {@link IndexCache.load} compares it first: equal keys and equal
 * stamps are a hit without reading a single file.
 *
 * ## What the key covers
 *
 * In order: a domain tag, the envelope version, the graph vocabulary version,
 * the indexer version, the number of extractors followed by each extractor's
 * identifier in run order, the project root, the TypeScript configuration path,
 * the number of files, and then four parts per file — its project-relative
 * path, its modification time, its size and its content hash where one was
 * computed. A difference in the identity half names a different entry (see
 * {@link computeIndexCacheEntryKey}); a difference in the file half means the
 * fast path cannot answer and the recorded content digests are consulted.
 *
 * ## Why it cannot collide by accident
 *
 * `stableHash` does not concatenate the parts; it frames each one with a type
 * tag and a byte length, so `['a', 'bc']` and `['ab', 'c']` are different
 * streams and a string part can never be mistaken for a number part. That is
 * what lets paths, timestamps and digests share one flat list without a
 * separator convention that a path could contain. The layout above is also
 * fixed-arity per file, so an absent configuration path or an absent content
 * hash occupies its slot as {@link ABSENT_SLOT} rather than shifting the
 * following parts. The two variable-length runs — the extractor identifiers
 * and the files — are each preceded by their own count for the same reason: a
 * reader of the stream always knows how many parts the run holds, so no
 * identifier can be read as a path and no shorter list of extractors can align
 * with a longer one.
 *
 * ## Order-insensitivity, and the total order behind it
 *
 * The file list is sorted on a copy — the caller's array is never mutated —
 * with a byte-wise comparison of a composite sort key, so the ordering is
 * identical on every machine and locale, and two fingerprints for the same path
 * (which a well-formed {@link CodeIndex} does not contain, and which a caller
 * assembling a list might) still order deterministically.
 *
 * The **extractor list is the deliberate exception**: it is contributed in the
 * caller's order and is never sorted, because extraction order decides which
 * claimant of a duplicate id graph construction keeps and two orders therefore
 * describe two different indexes. See
 * {@link IndexCacheKeyInput.extractors}.
 *
 * Total: it never throws. A non-finite modification time or size — which a real
 * filesystem does not produce, but a synthesised fingerprint might — is
 * contributed as its textual form instead of as a number, so `NaN` and
 * `Infinity` stay distinguishable from each other and from any finite value
 * rather than making the key derivation fail.
 *
 * @param input The project identity, the extractor set and the file
 * fingerprints to key.
 * @returns The key, matching {@link CACHE_KEY_PATTERN}.
 *
 * @example
 * ```ts
 * const keyInput: IndexCacheKeyInput = {
 *   projectRoot: project.projectRoot,
 *   tsConfigFilePath: project.tsConfigFilePath,
 *   indexerVersion: INDEXER_VERSION,
 *   extractors: extractors.map((extractor) => extractor.id),
 *   files: fingerprints,
 * };
 * const stateKey = computeIndexCacheKey(keyInput);
 * const cached = await cache.load(keyInput);
 * ```
 */
export function computeIndexCacheKey(input: IndexCacheKeyInput): string {
  const sorted = [...input.files].sort(compareFingerprints);

  const parts: (string | number)[] = [KEY_DOMAIN, ...identityParts(input), sorted.length];

  for (const fingerprint of sorted) {
    parts.push(
      fingerprint.file,
      numberPart(fingerprint.mtimeMs),
      numberPart(fingerprint.size),
      fingerprint.hash ?? ABSENT_SLOT,
    );
  }

  return stableHash(parts);
}

/**
 * The identity half both keys share, in the order both contribute it.
 *
 * One definition, so the entry's name and the state key can never disagree
 * about what "the same project" means — a project whose state key could only
 * ever be found under another project's name would never hit.
 *
 * @param input The key input.
 * @returns The envelope version, vocabulary version, indexer version, the
 * extractor count and ids in run order, the project root and the configuration
 * path, as `stableHash` parts.
 */
function identityParts(input: IndexCacheKeyInput): (string | number)[] {
  return [
    input.schemaVersion ?? INDEX_CACHE_SCHEMA_VERSION,
    CODE_INDEX_SCHEMA_VERSION,
    input.indexerVersion,
    input.extractors.length,
    // In the caller's order, deliberately unsorted: see
    // `IndexCacheKeyInput.extractors`.
    ...input.extractors,
    toPosix(input.projectRoot),
    input.tsConfigFilePath === undefined ? ABSENT_SLOT : toPosix(input.tsConfigFilePath),
  ];
}

/**
 * The directory this module's entries belong in: `<state root>/index`.
 *
 * The state root is resolved from the first of these that names something:
 * `options.debuggenHome`, the `DEBUGGEN_HOME` environment variable, or
 * `<home>/.debuggen`. A leading `~/` — or a bare `~` — is expanded, because a
 * value that arrived from a shell profile or a settings file often carries one
 * and no filesystem call expands it. An empty value counts as absent. The
 * result is normalised POSIX, which is what the rest of the product speaks.
 *
 * ## Injection is the intended path
 *
 * `@debuggen/shared/node`'s filesystem helpers deliberately touch neither
 * `node:os` nor `process.env`: deciding where the product's state lives belongs
 * to the service's configuration module
 * (`apps/local-service/src/config.ts`), which reads the environment once,
 * validates it, creates the tree and passes resolved directories down. So in
 * the running product this function's *argument* is what is used, the
 * environment fallback exists for standalone and command-line use where no
 * service has resolved anything, and tests always inject a temporary directory
 * so that nothing they do can reach a real `~/.debuggen`.
 *
 * Pure: it creates nothing and reads nothing from the filesystem. Creating the
 * directory — `0700`, verified — is {@link IndexCache.save}'s job.
 *
 * @param options `debuggenHome` to resolve against an explicit state root.
 * @returns The cache directory, normalised POSIX.
 *
 * @example
 * ```ts
 * const cache = createIndexCache({ cacheDir: resolveIndexCacheDir({ debuggenHome }) });
 * ```
 */
export function resolveIndexCacheDir(options?: {
  readonly debuggenHome?: string | undefined;
}): string {
  const injected = nonEmptyOrUndefined(options?.debuggenHome);
  const fromEnvironment = nonEmptyOrUndefined(process.env[DEBUGGEN_HOME_ENV]);
  const stateRoot =
    injected ?? fromEnvironment ?? joinPosix(toPosix(homedir()), DEFAULT_STATE_DIRECTORY_NAME);

  return joinPosix(expandLeadingHome(stateRoot), INDEX_DIRECTORY_NAME);
}

/* -------------------------------------------------------------------------------------------------
 * The cache
 * ---------------------------------------------------------------------------------------------- */

/** How a {@link IndexCache} is configured. */
export interface IndexCacheOptions {
  /**
   * The directory entries are read from and written to, conventionally
   * {@link resolveIndexCacheDir}'s result.
   *
   * It need not exist: {@link IndexCache.save} creates it `0700`, which is what
   * makes a cache survive the service's retention job deleting it between runs.
   * Passing an empty string is a misconfiguration and throws.
   */
  readonly cacheDir: string;

  /**
   * Where this module's diagnostics go. Defaults to `noopLogger`, so a caller
   * that does not care sees nothing.
   *
   * Every line is either a hit or a miss with a machine-readable `reason`, and
   * carries the key and a count or two. **Never a file's content, a project
   * path or any part of the indexed source** — a cache log line is the one
   * place where "log the whole document for debugging" would quietly export a
   * developer's code into a log file.
   */
  readonly logger?: Logger | undefined;
}

/**
 * A code-index cache over one directory.
 *
 * Every method is asynchronous, which is the interface the callers of a cache
 * want and what keeps a future out-of-process or worker-backed implementation a
 * drop-in replacement. Under the hood the *entry* operations are synchronous:
 * the hardened creators in `@debuggen/shared/node` work at the descriptor level
 * — `O_NOFOLLOW`, `fsync`, `rename` — and that is what makes their guarantees
 * hold, so they have no asynchronous form to call. Removal and enumeration,
 * which need no such guarantee, use the promise API.
 *
 * Safe to share: an instance holds nothing but its directory and its logger, so
 * concurrent operations cannot interfere through it. Two processes writing one
 * project's entry at once is equally safe — see {@link IndexCache.save}.
 */
export interface IndexCache {
  /** The directory entries live in, exactly as it was configured. */
  readonly cacheDir: string;

  /**
   * The index of the project `input` identifies, when its entry still
   * describes the files `input` fingerprints; `undefined` otherwise.
   *
   * **Never rejects for a filesystem or content problem**, which is the
   * contract the rest of the package is written against. An absent entry, an
   * absent directory, an unparsable document, a stale envelope or vocabulary
   * version, a document that does not have the shape of an index, a file set
   * that changed, a file whose bytes no longer match the digest the entry
   * recorded, a symbolic link planted at the entry path, a permission error —
   * each is logged and returns `undefined`.
   *
   * Freshness is decided in the three layers "What decides that an entry is
   * fresh" describes: an equal state key and equal stamps are a hit after one
   * `stat` per file; otherwise each file whose stamp moved is read once and
   * its digest compared with the recorded one. A hit reached through the
   * second layer returns the index with `input.files` as its fingerprints and
   * re-saves the entry, best effort, so the next lookup is stat-only again.
   *
   * An entry that is rejected for anything other than being absent is also
   * **removed**, so a corrupt or stale file costs one read once rather than one
   * read on every run for as long as it sits there.
   *
   * @param input The project identity and the current fingerprints of its
   * files — the same value the matching {@link IndexCache.save} received for
   * an unchanged tree.
   * @returns The cached index, or `undefined` on any kind of miss.
   */
  load(input: IndexCacheKeyInput): Promise<CodeIndex | undefined>;

  /**
   * Stores `index` as the entry of the project `input` identifies, replacing
   * whatever that project's entry held and creating the cache directory when it
   * is absent.
   *
   * The envelope records the state key of `input`, and one stamp per file of
   * `index.files` with the SHA-256 digest of its bytes. A file whose metadata
   * no longer agrees with the fingerprint the index was built from, or that
   * changes while it is being hashed, is recorded without a usable stamp, so the
   * entry is never served for it on the strength of metadata that describes
   * other bytes.
   *
   * The write is atomic — a temporary sibling is created `0600`, written,
   * flushed and renamed over the entry path — so a reader never observes a
   * partial document and two processes racing on one project leave the last
   * writer's bytes in full rather than a mixture of both. A symbolic link
   * planted at the entry path is *replaced* by a real file rather than written
   * through.
   *
   * The returned `Result` is **advisory**: a caller logs an `Err` and carries on
   * with the index it already has in memory, because failing to cache an index
   * is not failing to build one. It is returned rather than thrown so that
   * "could not cache" is a value a caller may ignore deliberately instead of an
   * exception it must wrap every call in.
   *
   * @param input The project identity and the fingerprints the lookup that
   * preceded the build was made with.
   * @param index The index to store.
   * @returns `ok(undefined)` when the entry is on disk; `err(DebuggenError)`
   * carrying `FS_UNSAFE_PATH` when the directory fails its privacy policy and
   * `CODE_INDEX_FAILED` for any other write failure.
   */
  save(input: IndexCacheKeyInput, index: CodeIndex): Promise<Result<void>>;

  /**
   * Removes the entry of the project `input` identifies, if there is one.
   *
   * Best effort and idempotent: an entry that is not there is success, and a
   * removal that cannot be performed is logged at `debug` and swallowed. Used
   * by {@link IndexCache.load} on every rejected entry, and available to a
   * caller that knows an index is no longer trustworthy. `input.files` is not
   * consulted: the project's one entry goes, whatever state it describes.
   *
   * @param input The project identity.
   */
  evict(input: IndexCacheKeyInput): Promise<void>;

  /**
   * Removes every entry in the cache directory.
   *
   * Scoped deliberately narrowly: the directory is enumerated one level deep
   * and only its own `*.json` files are removed, so a subdirectory, a sibling
   * of the cache directory and anything the product keeps elsewhere under the
   * state root are all untouched. The directory itself is left in place, and a
   * directory that is not there is success.
   *
   * This is the caller's tool — a command that clears the cache, a test's
   * teardown — and not a retention policy: age and size bounds belong to the
   * service.
   */
  clear(): Promise<void>;
}

/**
 * Creates a cache over `options.cacheDir`.
 *
 * Creates nothing on disk and performs no I/O: the directory is created by the
 * first {@link IndexCache.save}, so constructing a cache for a project that is
 * never indexed leaves no trace.
 *
 * @param options The directory and the optional logger.
 * @returns The cache.
 * @throws {DebuggenError} With code `CONFIG_INVALID` when `cacheDir` is empty.
 *
 * @example
 * ```ts
 * const cache = createIndexCache({ cacheDir: resolveIndexCacheDir(), logger });
 * const index = (await cache.load(keyInput)) ?? buildIndex();
 * ```
 */
export function createIndexCache(options: IndexCacheOptions): IndexCache {
  const { cacheDir } = options;
  assert(
    cacheDir.length > 0,
    'An index cache needs a cache directory; pass resolveIndexCacheDir() or an explicit path.',
    'CONFIG_INVALID',
  );
  const logger = options.logger ?? noopLogger;

  /**
   * Removes one entry, swallowing every failure. Shared by `evict` and by every
   * rejection path of `load`, so a rejected entry is dropped by exactly the
   * same code a caller's explicit eviction uses.
   */
  const removeEntry = async (key: string): Promise<void> => {
    try {
      await unlink(entryPath(cacheDir, key));
    } catch (error) {
      const errno = errnoCodeOf(error);
      if (errno === 'ENOENT') {
        return;
      }
      // Nothing to recover: the entry is already treated as unusable, and a
      // failure to remove it costs one wasted read on the next run.
      logger.debug('code index cache entry could not be removed', {
        key,
        errno: errno ?? 'unknown',
      });
    }
  };

  /**
   * The `*.json` basenames directly inside the cache directory, or `undefined`
   * when the directory cannot be enumerated. Directories are filtered out here
   * rather than at the call site so `clear` can never descend.
   */
  const listEntryFileNames = async (): Promise<readonly string[] | undefined> => {
    try {
      const entries = await readdir(cacheDir, { withFileTypes: true });
      return entries
        .filter((entry) => !entry.isDirectory() && entry.name.endsWith(ENTRY_FILE_EXTENSION))
        .map((entry) => entry.name);
    } catch (error) {
      const errno = errnoCodeOf(error);
      if (errno !== 'ENOENT') {
        logger.debug('code index cache directory could not be listed', {
          errno: errno ?? 'unknown',
        });
      }
      return undefined;
    }
  };

  /**
   * Serialises one envelope and writes it atomically over its entry path: the
   * one writer behind both `save` and the refresh a content-verified `load`
   * performs, so the two can never lay a document out differently.
   *
   * @returns The number of characters written, or the write failure as
   * `tryCatch` normalised it.
   */
  const writeDocument = (entry: IndexCacheEntry): Result<number> =>
    tryCatch(() => {
      // Serialised first, so a document that cannot be represented fails
      // before anything on disk is touched. A `CodeIndex` is plain JSON by
      // contract — no `Date`, no `Map`, no cycle — and this is where a
      // producer that broke that contract is caught.
      const serialized = JSON.stringify(entry);

      // The directory may have been removed since the cache was created, by
      // the service's retention job or by hand, so it is (re)created at
      // `0700` on every write rather than once at construction. An existing
      // directory is judged as it stands and never has its mode changed: one
      // that grants group or other access, is a link or belongs to another
      // account throws `FS_UNSAFE_PATH`, which becomes this call's `Err`
      // instead of an exception, and nothing is written into it.
      ensureSecureDir(cacheDir);

      // Temporary sibling, `0600`, flushed, then renamed over the entry path:
      // atomic for a reader, last-writer-wins for two concurrent writers,
      // never a write through a link — and, because the path is the project's
      // one entry, a replacement of its previous index rather than a sibling.
      writeSecureFileAtomic(entryPath(cacheDir, entry.key), serialized);

      return serialized.length;
    }, 'CODE_INDEX_FAILED');

  /**
   * The synchronous body of `save`. Separated so the promise-returning method
   * stays one line and the sequence below reads as what it is: derive the two
   * keys, record the files, write atomically.
   */
  const writeEntry = (input: IndexCacheKeyInput, index: CodeIndex): Result<void> => {
    const key = computeIndexCacheEntryKey(input);
    assertCacheKey(key);

    // Taken before the document is serialised, and total: `recordFiles`
    // answers with an unverified stamp for every path it cannot screen, stat,
    // read or trust, so a project whose files have already been removed is
    // cached rather than failing to cache. One `stat` and one read per indexed
    // file, which the build that produced `index` has just outweighed many
    // times over.
    const entry: IndexCacheEntry = {
      schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
      key,
      stateKey: computeIndexCacheKey(input),
      writtenAt: nowEpochMs(),
      index,
      stamps: recordFiles(index),
    };

    const written = writeDocument(entry);
    if (isErr(written)) {
      logger.warn('code index could not be cached; it will be rebuilt next time', {
        key,
        code: written.error.code,
        message: written.error.message,
      });
      return err(writeFailure(written.error, key));
    }

    logger.debug('code index cached', {
      key,
      nodes: index.nodes.length,
      edges: index.edges.length,
      files: index.files.length,
      characters: written.value,
    });
    return ok(undefined);
  };

  /**
   * Reads, parses and structurally trusts the entry under `key`, or answers
   * `undefined` for anything that is not a usable envelope of this version for
   * this key. Every rejection but absence is logged and removes the file, so
   * `load` below only has freshness left to decide.
   */
  const readEntry = async (key: string): Promise<IndexCacheEntry | undefined> => {
    // Read with a refusal to follow a symbolic link at the final component:
    // the entry path is inside a `0700` directory, but a link planted there by
    // an earlier, differently configured run must not become a read of
    // whatever it points at.
    let bytes: Uint8Array;
    try {
      bytes = readFileNoFollow(entryPath(cacheDir, key));
    } catch (error) {
      const errno = errnoCodeOf(error);
      if (errno === 'ENOENT') {
        // The ordinary miss: no entry, or no cache directory at all after the
        // service's retention job removed it. Not worth a warning.
        logger.debug(MISS_MESSAGE, { key, reason: 'absent' });
        return undefined;
      }

      // `ELOOP` (a planted symlink), `EACCES`, `EISDIR`, `ENOTDIR`, `EIO`: each
      // is a miss, and each would recur on every run, so the entry goes.
      // Removing a symbolic link unlinks the link and not its target.
      logger.warn(MISS_MESSAGE, { key, reason: 'unreadable', errno: errno ?? 'unknown' });
      await removeEntry(key);
      return undefined;
    }

    const parsed = tryCatch<unknown>(
      () => JSON.parse(decodeUtf8(bytes)) as unknown,
      'CODE_INDEX_FAILED',
    );
    if (isErr(parsed)) {
      logger.warn(MISS_MESSAGE, { key, reason: 'unparsable', bytes: bytes.byteLength });
      await removeEntry(key);
      return undefined;
    }

    const document = parsed.value;
    if (!isIndexCacheEntry(document)) {
      logger.warn(MISS_MESSAGE, { key, reason: rejectionReason(document) });
      await removeEntry(key);
      return undefined;
    }

    // The key is folded into the envelope as well as into the filename, so an
    // entry that was copied, renamed or hand-written under another project's
    // name is refused. This is also what makes the indexer-version guarantee
    // hold at read time: the version is part of the key, and the key is part
    // of the document.
    if (document.key !== key) {
      logger.warn(MISS_MESSAGE, { key, reason: 'key-mismatch' });
      await removeEntry(key);
      return undefined;
    }

    // The graph vocabulary moved since this entry was written, so its nodes and
    // edges may mean something this version does not know. A different
    // vocabulary version also produces a different key, so reaching here at
    // all means the file is older than its name claims.
    if (document.index.schemaVersion !== CODE_INDEX_SCHEMA_VERSION) {
      logger.debug(MISS_MESSAGE, { key, reason: 'stale-vocabulary' });
      await removeEntry(key);
      return undefined;
    }

    return document;
  };

  return {
    cacheDir,

    async load(input: IndexCacheKeyInput): Promise<CodeIndex | undefined> {
      const key = computeIndexCacheEntryKey(input);
      assertCacheKey(key);

      const document = await readEntry(key);
      if (document === undefined) {
        return undefined;
      }

      // The stamps must describe exactly the files the index names, position
      // by position, as `save` writes them. A shorter, longer or reordered list
      // is a truncated or hand-assembled document: there is nothing to compare
      // an uncovered file against, so the entry goes.
      const { index } = document;
      if (!stampsCoverFiles(index, document.stamps)) {
        logger.debug(MISS_MESSAGE, {
          key,
          reason: 'stale-file',
          files: index.files.length,
          stamps: document.stamps.length,
        });
        await removeEntry(key);
        return undefined;
      }

      // Layers 1 and 2 of "What decides that an entry is fresh": the state key
      // the lookup asks for is the one the entry was written under, and every
      // file's change stamp is the one recorded. One `stat` per file, and no
      // file is read.
      const current = stampFiles(index);
      const stateKey = computeIndexCacheKey(input);
      if (document.stateKey === stateKey && everyStampUnchanged(index, document.stamps, current)) {
        logger.debug(HIT_MESSAGE, {
          key,
          nodes: index.nodes.length,
          edges: index.edges.length,
          files: index.files.length,
          revalidatedFiles: 0,
          ageMs: Math.max(0, nowEpochMs() - document.writtenAt),
        });
        return index;
      }

      // Layer 3: something moved. Each file whose stamp moved is read once and
      // compared with the digest recorded for it; a different file set, a
      // different byte or a file that cannot be proven is a miss.
      const revalidated = revalidateContent(index, document.stamps, current, input.files);
      if (revalidated.kind === 'stale') {
        logger.debug(MISS_MESSAGE, {
          key,
          reason: revalidated.reason,
          files: index.files.length,
          fingerprints: input.files.length,
        });
        await removeEntry(key);
        return undefined;
      }

      // The same bytes under new metadata — the product's own patch and its
      // byte-for-byte restore, a `touch`, a checkout that rewrote identical
      // files. The index still describes this tree exactly, so it is served
      // with the fingerprints a rebuild would record, and the entry is
      // rewritten with the current state key and stamps so the next lookup is
      // stat-only again. The rewrite is best effort for the reason `save` is:
      // an index that could not be re-cached is still a correct index.
      const refreshedIndex: CodeIndex = { ...index, files: revalidated.files };
      const refreshed = writeDocument({
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
        key,
        stateKey,
        writtenAt: nowEpochMs(),
        index: refreshedIndex,
        stamps: revalidated.stamps,
      });
      if (isErr(refreshed)) {
        logger.warn('code index cache entry could not be refreshed; it will be verified again', {
          key,
          code: refreshed.error.code,
        });
      }

      logger.debug(HIT_MESSAGE, {
        key,
        nodes: index.nodes.length,
        edges: index.edges.length,
        files: index.files.length,
        revalidatedFiles: revalidated.reread,
        refreshed: !isErr(refreshed),
        ageMs: Math.max(0, nowEpochMs() - document.writtenAt),
      });
      return refreshedIndex;
    },

    // Deliberately not `async`: everything the write does is synchronous by
    // necessity (see `IndexCache` on why the hardened writers have no promise
    // form). It is still wrapped in a promise chain rather than run inline, so
    // that an unexpected throw arrives as a *rejection* here exactly as it
    // would from `load` and `evict` — one interface, one way of failing, and no
    // caller that reaches for `.catch()` instead of `await` is surprised by a
    // synchronous throw.
    save(input: IndexCacheKeyInput, index: CodeIndex): Promise<Result<void>> {
      return Promise.resolve().then(() => writeEntry(input, index));
    },

    async evict(input: IndexCacheKeyInput): Promise<void> {
      const key = computeIndexCacheEntryKey(input);
      assertCacheKey(key);
      await removeEntry(key);
    },

    async clear(): Promise<void> {
      const names = await listEntryFileNames();
      if (names === undefined) {
        return;
      }

      let removed = 0;
      for (const name of names) {
        try {
          // `name` is a basename from `readdir`, so it can hold no separator
          // and the join cannot leave the cache directory.
          await unlink(join(cacheDir, name));
          removed += 1;
        } catch (error) {
          const errno = errnoCodeOf(error);
          if (errno !== 'ENOENT') {
            logger.debug('code index cache entry could not be removed', {
              errno: errno ?? 'unknown',
            });
          }
        }
      }

      logger.debug('code index cache cleared', { removed, found: names.length });
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The persisted document, and the guard that trusts it
 * ---------------------------------------------------------------------------------------------- */

/**
 * What one indexed file looked like to the kernel when the entry was written.
 *
 * This module's own private storage shape, deliberately **not**
 * `FileFingerprint` from `./graph/types.ts`: a fingerprint is part of the
 * index's public contract and of the cache key, and it carries what the indexer
 * observed while reading the file. A stamp is the cache's read-time freshness
 * evidence, it is never hashed into a key, and it carries two fields a
 * fingerprint has no business holding:
 *
 * - `ctimeMs` — the inode's change time. The reason the shape exists: a process
 *   can set `mtimeMs` to anything (`utimes`, and therefore `tar -x`, `cp -p`,
 *   `rsync --times`, `touch -r`), and a replacement body of the same byte
 *   length leaves `size` alone, but nothing in userspace can hold `ctimeMs`
 *   still across a write. So it is what distinguishes "this file is untouched"
 *   from "this file was rewritten under its old timestamp".
 * - `ino` — the inode number, which catches the substitution performed by
 *   `rename` rather than by writing in place, where the replacement carries its
 *   own change time that may happen to precede the one recorded here.
 *
 * `present` is a field rather than an absent entry so that "the file was not
 * there when the entry was written" is a state that can compare equal to
 * itself: an index over files that do not exist on disk must still round-trip
 * (see "What decides that an entry is fresh"). When it is `false` the four
 * numbers are zero, so an unreadable file cannot be told apart from a missing
 * one — which is intentional, because neither is evidence of anything and any
 * *change* in that state shows up as `present` moving.
 *
 * Internal: a version bump is free to change it, and
 * {@link INDEX_CACHE_SCHEMA_VERSION} is what makes that safe.
 */
interface FileStamp {
  /** The file, project-relative POSIX, exactly as `FileFingerprint.file` spells it. */
  readonly file: string;

  /** Whether the path resolved inside the project and named a regular file. */
  readonly present: boolean;

  /** Last-modification time in epoch milliseconds, or `0` when absent. */
  readonly mtimeMs: number;

  /** Size in bytes, or `0` when absent. */
  readonly size: number;

  /** Inode change time in epoch milliseconds, or `0` when absent. */
  readonly ctimeMs: number;

  /** Inode number, or `0` when absent. */
  readonly ino: number;
}

/**
 * A {@link FileStamp} as the envelope records it: the stamp, plus the digest of
 * the bytes the stamp described when the entry was written.
 *
 * `contentHash` is the SHA-256 of the file's bytes, 64 lowercase hexadecimal
 * characters — the same digest `sha256OfFile` produces, so it compares directly
 * with a fingerprint the indexer took in `hashContents` mode — or
 * {@link UNVERIFIED_CONTENT_HASH} when the bytes were not established. It is
 * what lets a file whose stamp moved keep its entry: the stamp says "something
 * touched this file", the digest answers "and it still says the same thing".
 * It is never hashed into a key and never logged.
 */
interface RecordedStamp extends FileStamp {
  /** The SHA-256 of the file's bytes at write time, or empty when not established. */
  readonly contentHash: string;
}

/**
 * The document one entry file holds.
 *
 * Six fields, and each is here because reading the file back needs it:
 *
 * - `schemaVersion` — the **envelope** version
 *   ({@link INDEX_CACHE_SCHEMA_VERSION}), so a document written by another
 *   layout of this file is refused rather than misread, and so the service's
 *   retention sweep can recognise an entry an older version left behind. The
 *   index's own vocabulary version lives on `index.schemaVersion`, which is a
 *   different question and is checked separately.
 * - `key` — the entry key ({@link computeIndexCacheEntryKey}) the file is named
 *   by, so a file that was copied or renamed cannot be served as another
 *   project's entry.
 * - `stateKey` — {@link computeIndexCacheKey} of the lookup the entry answers:
 *   the project hash plus every file's modification time and size. Equal state
 *   keys and equal stamps are the fast path; a different one sends a lookup to
 *   the content digests.
 * - `writtenAt` — epoch milliseconds, for the age a hit is logged with. Named
 *   for the write rather than a "creation" because `createdAt` is demo
 *   application vocabulary that `scripts/check-no-hardcoding.mjs` refuses in a
 *   product module, and the field is internal, so the name costs nothing.
 * - `index` — the index itself.
 * - `stamps` — one {@link RecordedStamp} per entry of `index.files`, in that
 *   order: the change stamp that proves a file untouched without reading it,
 *   and the digest that proves a touched file unchanged by reading it once.
 *   They live in the envelope rather than in a key because they must be
 *   *compared*: folding a change time into a key would make every `chmod`
 *   derive a new key, and would leave the entry already on disk unexaminable.
 *
 * `indexerVersion` is deliberately **not** repeated here: a
 * {@link CodeIndex} owns that field, and duplicating it would create two
 * places that could disagree. The version is folded into the entry key, so an
 * entry from another indexer version is unreachable, and the `key` check is
 * what closes the copied-file case.
 *
 * Internal: the document is this module's private storage format, and nothing
 * outside it should be written against a shape that a version bump is free to
 * change — the retention sweep reads only `schemaVersion` and
 * `index.projectRoot`, which every version has carried.
 */
interface IndexCacheEntry {
  readonly schemaVersion: number;
  readonly key: string;
  readonly stateKey: string;
  readonly writtenAt: number;
  readonly index: CodeIndex;
  readonly stamps: readonly RecordedStamp[];
}

/**
 * Whether `value` has the shape of a {@link CodeIndex}.
 *
 * The structural guard for a **deserialised** index, which is untrusted input:
 * a cache entry may have been written by an older version of this package,
 * truncated by a full disk or edited by hand, and a traversal that walked it
 * without checking would fail somewhere far from the cause. `./graph/types.ts`
 * names this module as the owner of that check, and this is it.
 *
 * ## What it verifies
 *
 * The envelope — a finite `schemaVersion` and `generatedAt`, a non-empty
 * `projectRoot` and `indexerVersion`, and `nodes`, `edges` and `files` that are
 * genuinely arrays — and then, for every element, the fields any consumer
 * reads: a node's `id`, its `kind` (through `isCodeNodeKind`, so the
 * vocabulary is spelled once), `name`, `file`, `line`, `column` and the
 * presence of `data` for the kinds that require it; an edge's `id`, `kind`
 * (through `isCodeEdgeKind`), `from` and `to`; a fingerprint's `file`,
 * `mtimeMs` and `size`; and, when present, each diagnostic's severity, code and
 * message. Optional fields are checked only when they are there, so a document
 * that travelled light is not rejected for it.
 *
 * ## What it deliberately does not verify
 *
 * The per-kind `data` payloads beyond their presence. Validating eight payload
 * shapes here would duplicate the vocabulary a third time, and there is already
 * a place that handles a malformed payload well: `./graph/graph.ts` drops an
 * entry it cannot interpret with a diagnostic, so a partial graph is the
 * outcome rather than a crash. This guard's job is to decide whether the
 * document is an index at all.
 *
 * It also says nothing about *freshness*: whether an index still describes the
 * tree on disk is not a property of the document at all. Reachability is
 * answered by the entry key, and freshness by comparing the envelope's state
 * key, stamps and content digests with the filesystem — a separate step in
 * {@link IndexCache.load}, because `mtimeMs` and `size` can both survive a
 * content substitution and can both move without the content changing.
 *
 * Total: it never throws, and any value — `null`, an array, a string, a
 * revived object with the wrong fields — is simply `false`.
 *
 * @param value Any value, typically the `index` field of freshly parsed JSON.
 * @returns `true` when `value` can be used as a {@link CodeIndex}.
 */
export function isCodeIndex(value: unknown): value is CodeIndex {
  if (!isRecord(value)) {
    return false;
  }

  const { schemaVersion, projectRoot, indexerVersion, generatedAt, nodes, edges, files } = value;
  const { diagnostics } = value;

  return (
    isFiniteNumber(schemaVersion) &&
    isNonEmptyString(projectRoot) &&
    isNonEmptyString(indexerVersion) &&
    isFiniteNumber(generatedAt) &&
    isUnknownArray(nodes) &&
    nodes.every(isCodeNodeShape) &&
    isUnknownArray(edges) &&
    edges.every(isCodeEdgeShape) &&
    isUnknownArray(files) &&
    files.every(isFileFingerprintShape) &&
    (diagnostics === undefined ||
      (isUnknownArray(diagnostics) && diagnostics.every(isIndexDiagnosticShape)))
  );
}

/**
 * Whether `value` is a well-formed entry document of **this** envelope version.
 *
 * The version equality is part of the guard rather than a separate step,
 * because a document of another envelope version is not an
 * {@link IndexCacheEntry} — its fields may mean something else.
 * {@link rejectionReason} is what turns a `false` from here into a log line
 * that distinguishes "written by another version" from "not an entry at all".
 *
 * @param value Any value, typically the result of `JSON.parse`.
 * @returns `true` when `value` is an entry this version can read.
 */
function isIndexCacheEntry(value: unknown): value is IndexCacheEntry {
  if (!isRecord(value)) {
    return false;
  }

  const { schemaVersion, key, stateKey, writtenAt, index, stamps } = value;

  return (
    isFiniteNumber(schemaVersion) &&
    schemaVersion === INDEX_CACHE_SCHEMA_VERSION &&
    isNonEmptyString(key) &&
    // The fast path compares it for equality, so anything but a key-shaped
    // digest is a document this version did not write.
    typeof stateKey === 'string' &&
    CACHE_KEY_PATTERN.test(stateKey) &&
    isFiniteNumber(writtenAt) &&
    isCodeIndex(index) &&
    // An entry without a well-formed stamp list is not an entry of this
    // version: the freshness check has nothing to compare against, and serving
    // the index anyway would be the very behaviour the stamps exist to end.
    isUnknownArray(stamps) &&
    stamps.every(isRecordedStampShape)
  );
}

/**
 * The machine-readable reason a parsed document was refused, for the miss log.
 *
 * Five answers, and the distinction is worth the few lines: `schema-version`
 * is an expected consequence of a version bump and tells a reader nothing is
 * wrong, `malformed-index` points at the index inside the envelope,
 * `malformed-stamps` at the freshness evidence beside it — the one part of the
 * envelope a hand-edited or truncated document tends to lose while the index
 * still parses — `malformed-state-key` at the fast path's comparison value,
 * and `malformed` at the envelope itself. A single "invalid" would leave all
 * five looking like corruption.
 *
 * @param value The document `isIndexCacheEntry` rejected.
 * @returns The reason, for the log's `reason` field.
 */
function rejectionReason(value: unknown): string {
  if (!isRecord(value)) {
    return 'malformed';
  }

  const { schemaVersion, stateKey, index, stamps } = value;
  if (isFiniteNumber(schemaVersion) && schemaVersion !== INDEX_CACHE_SCHEMA_VERSION) {
    return 'schema-version';
  }
  if (!isCodeIndex(index)) {
    return 'malformed-index';
  }
  if (!isUnknownArray(stamps) || !stamps.every(isRecordedStampShape)) {
    return 'malformed-stamps';
  }
  if (typeof stateKey !== 'string' || !CACHE_KEY_PATTERN.test(stateKey)) {
    return 'malformed-state-key';
  }
  return 'malformed';
}

/* -------------------------------------------------------------------------------------------------
 * Element guards
 * ---------------------------------------------------------------------------------------------- */

/**
 * The node kinds whose `data` payload is optional, per the `CodeNode` union.
 *
 * Every other kind carries a required payload, so its absence is a malformed
 * node rather than a node that travelled light.
 */
const KINDS_WITH_OPTIONAL_DATA: readonly CodeNodeKind[] = Object.freeze<CodeNodeKind[]>([
  'file',
  'symbol',
]);

/**
 * Widened view of the diagnostic severity vocabulary, so an untrusted string
 * can be tested for membership without asserting anything about it — the idiom
 * `./graph/types.ts` uses for its own vocabularies.
 */
const DIAGNOSTIC_SEVERITY_VALUES: readonly string[] = INDEX_DIAGNOSTIC_SEVERITIES;

/**
 * Whether `value` has the fields every consumer of a code node reads.
 *
 * @param value One element of a parsed `nodes` array.
 * @returns `true` when the node is usable.
 */
function isCodeNodeShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const { id, kind, name, file, line, column, endLine, exported, symbol, data } = value;

  return (
    isNonEmptyString(id) &&
    isCodeNodeKind(kind) &&
    typeof name === 'string' &&
    isNonEmptyString(file) &&
    isFiniteNumber(line) &&
    isFiniteNumber(column) &&
    isOptionalFiniteNumber(endLine) &&
    (exported === undefined || typeof exported === 'boolean') &&
    isOptionalNonEmptyString(symbol) &&
    hasExpectedNodeData(kind, data)
  );
}

/**
 * Whether a node's `data` is present when its kind requires it.
 *
 * Presence and object-ness only: the payload's own fields are validated where a
 * malformed one can be handled gracefully (see {@link isCodeIndex}).
 *
 * @param kind The node's kind, already known to be a member of the vocabulary.
 * @param data The node's `data` field, as parsed.
 * @returns `true` when the payload satisfies the union's requirement.
 */
function hasExpectedNodeData(kind: CodeNodeKind, data: unknown): boolean {
  if (KINDS_WITH_OPTIONAL_DATA.includes(kind)) {
    return data === undefined || isRecord(data);
  }
  return isRecord(data);
}

/**
 * Whether `value` has the fields a traversal reads off an edge.
 *
 * @param value One element of a parsed `edges` array.
 * @returns `true` when the edge is usable.
 */
function isCodeEdgeShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const { id, kind, from, to, file, line, column, specifier } = value;

  return (
    isNonEmptyString(id) &&
    isCodeEdgeKind(kind) &&
    isNonEmptyString(from) &&
    isNonEmptyString(to) &&
    isOptionalNonEmptyString(file) &&
    isOptionalFiniteNumber(line) &&
    isOptionalFiniteNumber(column) &&
    isOptionalString(specifier)
  );
}

/**
 * Whether `value` is a usable file fingerprint.
 *
 * @param value One element of a parsed `files` array.
 * @returns `true` when the fingerprint carries a path, a modification time and
 * a size.
 */
function isFileFingerprintShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const { file, mtimeMs, size, hash } = value;

  return (
    isNonEmptyString(file) &&
    isFiniteNumber(mtimeMs) &&
    isFiniteNumber(size) &&
    isOptionalNonEmptyString(hash)
  );
}

/**
 * Whether `value` is a usable {@link FileStamp}.
 *
 * Every field is required, including the three numbers a stamp for an absent
 * file carries as zero: a stamp with a field missing cannot be compared, and a
 * comparison that treated `undefined` as "equal to whatever is there" would
 * reintroduce exactly the silent hit the stamps exist to prevent.
 *
 * @param value One element of a parsed `stamps` array.
 * @returns `true` when the stamp is comparable.
 */
function isFileStampShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const { file, present, mtimeMs, size, ctimeMs, ino } = value;

  return (
    isNonEmptyString(file) &&
    typeof present === 'boolean' &&
    isFiniteNumber(mtimeMs) &&
    isFiniteNumber(size) &&
    isFiniteNumber(ctimeMs) &&
    isFiniteNumber(ino)
  );
}

/**
 * Whether `value` is a usable {@link RecordedStamp}: a comparable
 * {@link FileStamp} whose `contentHash` is either a SHA-256 digest or the
 * explicit "not established" marker.
 *
 * Required rather than optional for the reason the stamp's own fields are: an
 * entry whose digests went missing must not be read as one whose files were
 * all unverifiable, because the two lead to different answers once a file's
 * stamp moves.
 *
 * @param value One element of a parsed `stamps` array.
 * @returns `true` when the stamp can be compared and its digest trusted.
 */
function isRecordedStampShape(value: unknown): boolean {
  if (!isFileStampShape(value) || !isRecord(value)) {
    return false;
  }

  const { contentHash } = value;
  return (
    typeof contentHash === 'string' &&
    (contentHash === UNVERIFIED_CONTENT_HASH || CONTENT_HASH_PATTERN.test(contentHash))
  );
}

/**
 * Whether `value` is a usable indexing diagnostic.
 *
 * Both vocabularies are checked against their own definitions — severity
 * against the frozen list, code through `isIndexDiagnosticCode` — because a
 * diagnostic is rendered by severity and branched on by code.
 *
 * @param value One element of a parsed `diagnostics` array.
 * @returns `true` when the diagnostic is usable.
 */
function isIndexDiagnosticShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const { severity, code, message, file, extractorId, detail } = value;

  return (
    typeof severity === 'string' &&
    DIAGNOSTIC_SEVERITY_VALUES.includes(severity) &&
    isIndexDiagnosticCode(code) &&
    typeof message === 'string' &&
    isOptionalNonEmptyString(file) &&
    isOptionalNonEmptyString(extractorId) &&
    isOptionalString(detail)
  );
}

/* -------------------------------------------------------------------------------------------------
 * File change stamps
 * ---------------------------------------------------------------------------------------------- */

/** The value every numeric field of a stamp for an absent file carries. */
const ABSENT_STAMP_NUMBER = 0;

/**
 * One stamp per entry of `index.files`, in that order.
 *
 * What {@link IndexCache.load} takes again to compare with the recorded
 * stamps. {@link recordFiles} records through {@link readContent}, which
 * screens, resolves and stats a path exactly as {@link stampFile} does and
 * builds the stamp through the same {@link stampOf} — which is what makes the
 * comparison meaningful: two implementations of "stamp this file" that differed
 * in one detail (`lstat` on one side, a rejected path treated as absent on only
 * the other) would either miss forever or hit when they should not.
 *
 * Total by construction: every path that cannot be screened, resolved or
 * stat'ed becomes an absent stamp rather than an error, because a file that has
 * been removed since the index was built is an ordinary state of a working tree
 * and a cache is never allowed to turn one into a failure.
 *
 * Cost: one `stat` per indexed file, and **no file is read**. That is what
 * keeps a hit cheap next to a rebuild that constructs a program and runs every
 * extractor.
 *
 * @param index The index whose `files` are to be stamped, supplying the project
 * root each project-relative path is resolved inside.
 * @returns The stamps, positionally matching `index.files`.
 */
function stampFiles(index: CodeIndex): readonly FileStamp[] {
  return index.files.map((fingerprint) => stampFile(index.projectRoot, fingerprint.file));
}

/**
 * One file's change stamp, or an absent stamp when there is nothing to stamp.
 *
 * The path is screened before the filesystem is touched, in the order
 * `./summary.ts` screens a path it is about to read: `isSafeRelativePath`
 * refuses traversal, control characters, the empty string and a disguised
 * absolute form, and `resolveWithinProject` then establishes containment and
 * produces the absolute path. A refused path is reported absent rather than
 * repaired — an index whose file list holds one is not an index this module
 * will stat on behalf of, and treating it as absent keeps the answer stable
 * across a save and a load instead of making it depend on what is on disk.
 *
 * `stat` and not `lstat`: the indexer's own fingerprints are taken with `stat`
 * (`./indexer.ts`, `fingerprintOf`), so a symbolic link's target is what was
 * indexed and the target is therefore what has to be compared. Anything that is
 * not a regular file — a directory, a socket, a dangling link — is absent for
 * the same reason the indexer skips it.
 *
 * @param projectRoot The index's project root, absolute POSIX.
 * @param file The project-relative POSIX path to stamp.
 * @returns The stamp.
 */
function stampFile(projectRoot: string, file: string): FileStamp {
  if (!isSafeRelativePath(file)) {
    return absentStamp(file);
  }

  const resolved = resolveWithinProject(projectRoot, file);
  if (isErr(resolved)) {
    return absentStamp(file);
  }

  try {
    const stats = statSync(resolved.value);
    return stats.isFile() ? stampOf(file, stats) : absentStamp(file);
  } catch {
    // `ENOENT`, `EACCES`, `ELOOP`, `ENOTDIR`, `EIO`: none of them is evidence
    // about the file's contents, and none of them may become an exception —
    // `load` and `save` both promise never to fail for a filesystem problem.
    return absentStamp(file);
  }
}

/**
 * The stamp of a regular file, from its `stat` or `fstat` result.
 *
 * The one place a stamp is built from filesystem metadata, shared by the
 * stat-only path and the reading path, so the two describe one file the same
 * way to the last field.
 *
 * @param file The project-relative POSIX path.
 * @param stats The file's metadata.
 * @returns Its stamp, with `present` set.
 */
function stampOf(file: string, stats: Stats): FileStamp {
  return {
    file,
    present: true,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    ctimeMs: stats.ctimeMs,
    ino: stats.ino,
  };
}

/**
 * The stamp of a file this module has nothing to say about.
 *
 * Zeroed rather than left partly absent so that the shape is uniform and the
 * comparison needs no special case: an absent stamp compares equal to an absent
 * stamp, which is what lets an index over files that do not exist on disk
 * round-trip through the cache unchanged.
 *
 * @param file The project-relative POSIX path.
 * @returns The absent stamp for it.
 */
function absentStamp(file: string): FileStamp {
  return {
    file,
    present: false,
    mtimeMs: ABSENT_STAMP_NUMBER,
    size: ABSENT_STAMP_NUMBER,
    ctimeMs: ABSENT_STAMP_NUMBER,
    ino: ABSENT_STAMP_NUMBER,
  };
}

/**
 * The recorded stamp of a file whose bytes were not established: absent,
 * zeroed, with no digest.
 *
 * Used both for a file that genuinely was not there — so an index over files
 * that do not exist on disk still round-trips — and for one that was there but
 * cannot be trusted: its metadata no longer matched the fingerprint the index
 * was built from, it changed while it was being read, or its digest disagreed
 * with the one the indexer took. For an existing file this record can never
 * equal the stamp a later `stat` takes (that one is `present`), and it offers
 * no digest to fall back on, so the entry is never served for it: the file has
 * to be indexed again.
 *
 * @param file The project-relative POSIX path.
 * @returns The record.
 */
function unverifiedStamp(file: string): RecordedStamp {
  return { ...absentStamp(file), contentHash: UNVERIFIED_CONTENT_HASH };
}

/**
 * What reading one indexed file for its digest established.
 *
 * - `read` — a regular file whose bytes were hashed while its stamp held
 *   still, so `digest` describes exactly the bytes `stamp` describes.
 * - `absent` — the path could not be screened or resolved, did not exist, or
 *   was not a regular file.
 * - `unreadable` — a regular file whose stamp could be taken but whose bytes
 *   could not be read (a permission, an I/O error).
 * - `unstable` — the file changed, or was replaced, while it was being read,
 *   so no digest describes a single state of it.
 */
type ContentRead =
  | { readonly kind: 'read'; readonly stamp: FileStamp; readonly digest: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly stamp: FileStamp }
  | { readonly kind: 'unstable' };

/** The shared answer for a path with nothing to read. */
const ABSENT_READ: ContentRead = Object.freeze({ kind: 'absent' });

/** The shared answer for a file that moved while it was being read. */
const UNSTABLE_READ: ContentRead = Object.freeze({ kind: 'unstable' });

/**
 * Hashes one indexed file's bytes, together with the stamp they belong to.
 *
 * The path is screened and resolved exactly as {@link stampFile} does, and
 * `stat` — not `lstat` — is taken first for the reason given there. The file
 * is then opened read-only and non-blocking ({@link HASH_OPEN_FLAGS}), and the
 * descriptor is `fstat`ed before and after the bytes are hashed: the digest is
 * only reported when both describe the same inode in the same state as the
 * path's own `stat`, so a write, a truncation or a `rename` that lands during
 * the read makes the result `unstable` instead of a digest of half of two
 * files. The bytes stream through `buffer`; nothing is held whole.
 *
 * Total: every failure is one of the non-`read` answers, never a throw, and
 * the descriptor is always closed.
 *
 * @param projectRoot The index's project root, absolute POSIX.
 * @param file The project-relative POSIX path.
 * @param buffer The reusable chunk buffer.
 * @returns What could be established about the file.
 */
function readContent(projectRoot: string, file: string, buffer: Buffer): ContentRead {
  if (!isSafeRelativePath(file)) {
    return ABSENT_READ;
  }
  const resolved = resolveWithinProject(projectRoot, file);
  if (isErr(resolved)) {
    return ABSENT_READ;
  }

  let stamp: FileStamp;
  try {
    const stats = statSync(resolved.value);
    if (!stats.isFile()) {
      return ABSENT_READ;
    }
    stamp = stampOf(file, stats);
  } catch {
    // The same "no evidence, no exception" rule as `stampFile`.
    return ABSENT_READ;
  }

  let descriptor: number;
  try {
    descriptor = openSync(resolved.value, HASH_OPEN_FLAGS);
  } catch {
    return { kind: 'unreadable', stamp };
  }

  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || stampKey(stampOf(file, before)) !== stampKey(stamp)) {
      // Replaced between the `stat` and the `open`: the descriptor names
      // another file than the stamp does.
      return UNSTABLE_READ;
    }

    const digest = digestDescriptor(descriptor, buffer);

    const after = fstatSync(descriptor);
    if (stampKey(stampOf(file, after)) !== stampKey(stamp)) {
      return UNSTABLE_READ;
    }
    return { kind: 'read', stamp, digest };
  } catch {
    // `EIO`, `EISDIR` from an exotic mount, a descriptor revoked under us:
    // the bytes are unknown, and the stamp taken before is still true.
    return { kind: 'unreadable', stamp };
  } finally {
    closeDescriptor(descriptor);
  }
}

/**
 * The SHA-256 of everything readable from `descriptor`, as 64 lowercase
 * hexadecimal characters — byte-for-byte the digest `sha256OfFile` computes,
 * so a recorded digest compares directly with a `hashContents` fingerprint.
 *
 * Reads positionally from offset zero through the one `buffer`, so memory stays
 * bounded by {@link HASH_CHUNK_BYTES} whatever the file's size.
 *
 * @param descriptor An open, readable descriptor of a regular file.
 * @param buffer The reusable chunk buffer.
 * @returns The digest.
 * @throws The runtime's own read error, which {@link readContent} turns into
 * `unreadable`.
 */
function digestDescriptor(descriptor: number, buffer: Buffer): string {
  const hash = createHash('sha256');
  let position = 0;
  for (;;) {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      return hash.digest('hex');
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

/**
 * Closes a descriptor this module opened, reporting whether the close
 * succeeded.
 *
 * A failed close of a read-only descriptor loses nothing — no buffered write
 * can be pending on it — and the digest it was opened for is already decided,
 * so the result is informational and every caller may ignore it.
 *
 * @param descriptor The descriptor to close.
 * @returns `true` when it was closed, `false` when the runtime refused.
 */
function closeDescriptor(descriptor: number): boolean {
  try {
    closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

/**
 * One {@link RecordedStamp} per entry of `index.files`, in that order: what
 * {@link IndexCache.save} writes into the envelope.
 *
 * Every file is stamped and hashed in one read (see {@link readContent}), and
 * the result is only trusted when it describes the bytes the index was built
 * from:
 *
 * - The stamp's `mtimeMs` and `size` must equal the file's
 *   {@link FileFingerprint} in the index — the metadata the indexer observed
 *   when it read the file. A file edited between the build and this write no
 *   longer holds the bytes the index describes, so it is recorded as
 *   {@link unverifiedStamp} and the entry will not be served for it.
 * - A fingerprint that carries a digest (`hashContents`) must carry this one,
 *   for the same reason.
 * - A file that moved while it was read is recorded as unverified; a file that
 *   is absent is recorded as absent, which round-trips; a file whose bytes
 *   cannot be read keeps its honest stamp without a digest, so it can still be
 *   proven unchanged by its stamp alone, never by its content.
 *
 * Total: never throws.
 *
 * @param index The index about to be written.
 * @returns The records, positionally matching `index.files`.
 */
function recordFiles(index: CodeIndex): readonly RecordedStamp[] {
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);

  return index.files.map((fingerprint): RecordedStamp => {
    const read = readContent(index.projectRoot, fingerprint.file, buffer);
    switch (read.kind) {
      case 'absent':
      case 'unstable':
        return unverifiedStamp(fingerprint.file);
      case 'unreadable':
        return fingerprintDescribes(fingerprint, read.stamp)
          ? { ...read.stamp, contentHash: UNVERIFIED_CONTENT_HASH }
          : unverifiedStamp(fingerprint.file);
      case 'read':
        return fingerprintDescribes(fingerprint, read.stamp) &&
          (fingerprint.hash === undefined || fingerprint.hash === read.digest)
          ? { ...read.stamp, contentHash: read.digest }
          : unverifiedStamp(fingerprint.file);
    }
  });
}

/**
 * Whether a fingerprint's metadata is the metadata of `stamp`: the same
 * modification time and size, on a file that exists.
 *
 * @param fingerprint What the indexer, or a lookup, observed.
 * @param stamp What the filesystem says now.
 * @returns `true` when the two describe one state of the file.
 */
function fingerprintDescribes(fingerprint: FileFingerprint, stamp: FileStamp): boolean {
  return stamp.present && fingerprint.mtimeMs === stamp.mtimeMs && fingerprint.size === stamp.size;
}

/**
 * Whether the recorded stamps name exactly the files the index names, one per
 * file and in the same order — the layout {@link recordFiles} writes.
 *
 * Positional rather than by lookup, because the writer is positional and a
 * document that is not is not one this module wrote. Total: never throws.
 *
 * @param index The stored index.
 * @param recorded Its stored stamps.
 * @returns `true` when every file has its own stamp and no stamp is spare.
 */
function stampsCoverFiles(index: CodeIndex, recorded: readonly RecordedStamp[]): boolean {
  return (
    recorded.length === index.files.length &&
    index.files.every((fingerprint, position) => recorded[position]?.file === fingerprint.file)
  );
}

/**
 * Whether one file is proven unchanged since the entry was written by its
 * stamp alone: the stamp taken now equals the recorded one field for field,
 * and — for a file that was present — the recorded stamp is the one the
 * index's own fingerprint describes.
 *
 * The second half is what keeps a record that {@link recordFiles} could not
 * have trusted from being trusted here: a stamp can only prove a file is still
 * the file the index was *built from* when it was that file to begin with. An
 * absent record compares with an absent stamp and nothing else, which is the
 * round trip for files that never existed on disk.
 *
 * @param fingerprint The file's fingerprint in the stored index.
 * @param recorded The stamp recorded for it.
 * @param current The stamp taken just now.
 * @returns `true` when metadata alone proves the file unchanged.
 */
function stampUnchanged(
  fingerprint: FileFingerprint,
  recorded: FileStamp,
  current: FileStamp,
): boolean {
  if (stampKey(recorded) !== stampKey(current)) {
    return false;
  }
  return !recorded.present || fingerprintDescribes(fingerprint, recorded);
}

/**
 * The fast path's per-file test over a whole index: every file is proven
 * unchanged by {@link stampUnchanged}.
 *
 * Reads no file and never throws; `recorded` and `current` are positional with
 * `index.files`, which {@link stampsCoverFiles} and {@link stampFiles}
 * guarantee.
 *
 * @param index The stored index.
 * @param recorded Its stored stamps.
 * @param current The stamps taken just now.
 * @returns `true` when no file's metadata moved.
 */
function everyStampUnchanged(
  index: CodeIndex,
  recorded: readonly RecordedStamp[],
  current: readonly FileStamp[],
): boolean {
  return index.files.every((fingerprint, position) => {
    const was = recorded[position];
    const now = current[position];
    return was !== undefined && now !== undefined && stampUnchanged(fingerprint, was, now);
  });
}

/**
 * Why the content check refused an entry, for the miss log.
 *
 * - `file-set-changed` — the lookup fingerprints a file the index does not
 *   name, or the index names one the lookup does not; either way the tree has
 *   a different shape and needs indexing.
 * - `content-changed` — a file's bytes differ from the digest recorded for it:
 *   a real edit, including a substitution that preserved every piece of
 *   metadata.
 * - `stale-file` — a file whose stamp moved cannot be proven either way: it has
 *   no recorded digest, it is gone or unreadable, it changed while it was
 *   being read, or the lookup's fingerprint no longer describes it.
 */
type StaleReason = 'file-set-changed' | 'content-changed' | 'stale-file';

/**
 * The outcome of {@link revalidateContent}: the fingerprints and stamps to
 * serve and re-record, or why the entry is stale.
 */
type ContentRevalidation =
  | {
      readonly kind: 'fresh';
      /** The lookup's fingerprints, in `index.files` order: what a rebuild would record. */
      readonly files: readonly FileFingerprint[];
      /** The stamps to re-record: unchanged ones as they were, re-read ones as read. */
      readonly stamps: readonly RecordedStamp[];
      /** How many files had to be read to prove them unchanged. */
      readonly reread: number;
    }
  | { readonly kind: 'stale'; readonly reason: StaleReason };

/**
 * Layer 3 of "What decides that an entry is fresh": proves, file by file, that
 * a tree whose metadata moved still holds the bytes the entry describes.
 *
 * Two steps, each stopping at the first failure so a real edit costs as little
 * as possible:
 *
 * 1. **The file set.** The lookup's fingerprints must name exactly the files
 *    the index names, each once. A file added or removed is a different
 *    project shape, whatever its bytes.
 * 2. **Every file.** A file proven unchanged by {@link stampUnchanged}, and
 *    still described by the lookup's own fingerprint, keeps its recorded stamp
 *    unread. Any other file is read once ({@link readContent}); it is proven
 *    unchanged only when its digest equals the recorded one and the lookup's
 *    fingerprint describes the stamp it was read under — so a file that changed
 *    between the lookup's `stat` and this read is refused rather than paired
 *    with metadata from another moment.
 *
 * A fingerprint that carries its own digest (`hashContents`) must agree with
 * the recorded or re-read one as well: two digests of the same bytes are equal
 * by construction, and disagreement is an edit.
 *
 * Total: never throws.
 *
 * @param index The stored index.
 * @param recorded Its stored stamps, positional with `index.files`.
 * @param current The stamps taken just now, positional with `index.files`.
 * @param lookup The fingerprints the caller took of the tree it is asking about.
 * @returns The refreshed fingerprints and stamps, or the reason the entry is
 * stale.
 */
function revalidateContent(
  index: CodeIndex,
  recorded: readonly RecordedStamp[],
  current: readonly FileStamp[],
  lookup: readonly FileFingerprint[],
): ContentRevalidation {
  const lookupByFile = new Map<string, FileFingerprint>();
  for (const fingerprint of lookup) {
    if (lookupByFile.has(fingerprint.file)) {
      return { kind: 'stale', reason: 'file-set-changed' };
    }
    lookupByFile.set(fingerprint.file, fingerprint);
  }
  if (lookupByFile.size !== index.files.length) {
    return { kind: 'stale', reason: 'file-set-changed' };
  }

  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const named = new Set<string>();
  const files: FileFingerprint[] = [];
  const stamps: RecordedStamp[] = [];
  let reread = 0;

  for (const [position, fingerprint] of index.files.entries()) {
    const live = lookupByFile.get(fingerprint.file);
    if (live === undefined || named.has(fingerprint.file)) {
      return { kind: 'stale', reason: 'file-set-changed' };
    }
    named.add(fingerprint.file);

    const was = recorded[position];
    const now = current[position];
    if (was === undefined || now === undefined) {
      return { kind: 'stale', reason: 'stale-file' };
    }

    if (
      stampUnchanged(fingerprint, was, now) &&
      fingerprintDescribes(live, now) &&
      (live.hash === undefined || live.hash === was.contentHash)
    ) {
      files.push(live);
      stamps.push(was);
      continue;
    }

    if (was.contentHash === UNVERIFIED_CONTENT_HASH) {
      return { kind: 'stale', reason: 'stale-file' };
    }

    const read = readContent(index.projectRoot, fingerprint.file, buffer);
    if (read.kind !== 'read') {
      return { kind: 'stale', reason: 'stale-file' };
    }
    if (read.digest !== was.contentHash || (live.hash !== undefined && live.hash !== read.digest)) {
      return { kind: 'stale', reason: 'content-changed' };
    }
    if (!fingerprintDescribes(live, read.stamp)) {
      return { kind: 'stale', reason: 'stale-file' };
    }

    files.push(live);
    stamps.push({ ...read.stamp, contentHash: read.digest });
    reread += 1;
  }

  return { kind: 'fresh', files, stamps, reread };
}

/**
 * A stamp's identity as one string: every field, joined by a character no path
 * or number can contain.
 *
 * Used only to compare stamps with each other, never hashed into a cache key,
 * which is why a plain join is enough here where the key needs `stableHash`'s
 * framing. Every field participates, because every field is part of "unchanged"
 * — including `present`, so a file that has since been removed differs from the
 * one that was stamped.
 *
 * @param stamp The stamp to key.
 * @returns Its comparison key.
 */
function stampKey(stamp: FileStamp): string {
  return [
    stamp.file,
    stamp.present ? '1' : '0',
    String(stamp.mtimeMs),
    String(stamp.size),
    String(stamp.ctimeMs),
    String(stamp.ino),
  ].join(SORT_KEY_SEPARATOR);
}

/* -------------------------------------------------------------------------------------------------
 * Primitive guards and small helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether `value` is a non-null, non-array object whose properties can be read
 * as `unknown`.
 *
 * Arrays are excluded deliberately: every use here asks "is this a keyed
 * document", and an array would pass a bare `typeof value === 'object'` test
 * and then present numeric keys as fields.
 *
 * @param value Any value.
 * @returns `true` when `value` is a keyed object.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` is an array, narrowed to `readonly unknown[]` rather than to
 * `any[]`.
 *
 * `Array.isArray` narrows an `unknown` to `any[]`, which would let every
 * element read that follows escape type checking. This wrapper is what keeps
 * the element guards honest.
 *
 * @param value Any value.
 * @returns `true` when `value` is an array.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Whether `value` is a string with at least one character.
 *
 * @param value Any value.
 * @returns `true` for a non-empty string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Whether `value` is absent or a non-empty string.
 *
 * @param value Any value, typically an optional field.
 * @returns `true` when the field is absent or carries text.
 */
function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

/**
 * Whether `value` is absent or a string, empty or not.
 *
 * For a field whose empty value is meaningful rather than malformed — a module
 * specifier or a diagnostic detail.
 *
 * @param value Any value, typically an optional field.
 * @returns `true` when the field is absent or a string.
 */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/**
 * Whether `value` is a finite number.
 *
 * `NaN` and the infinities are refused: every number in an index is a
 * timestamp, a position, a size or a version, and none of them has a
 * non-finite value that means anything.
 *
 * @param value Any value.
 * @returns `true` for a finite number.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Whether `value` is absent or a finite number.
 *
 * @param value Any value, typically an optional field.
 * @returns `true` when the field is absent or finite.
 */
function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

/**
 * A key part for a number that `stableHash` will accept.
 *
 * A finite number goes in as a number, which is what keeps `1` and `'1'`
 * different keys. A non-finite one — which no filesystem produces, but a
 * synthesised fingerprint might — goes in as its textual form, so
 * {@link computeIndexCacheKey} stays total instead of throwing on it, and
 * `NaN` and `Infinity` remain distinguishable from each other and from every
 * finite value.
 *
 * @param value The number to contribute.
 * @returns The part to hash.
 */
function numberPart(value: number): string | number {
  return Number.isFinite(value) ? value : String(value);
}

/**
 * A fingerprint's ordering key: its fields joined by a character no path,
 * digest or number can contain.
 *
 * Used only to order the list before hashing, never hashed itself — the hashed
 * parts stay individually type-tagged. Joining the three remaining fields after
 * the path makes the order total, so two fingerprints naming the same file
 * (which a well-formed index never holds) still sort deterministically instead
 * of leaving the key dependent on the input order.
 *
 * @param fingerprint The fingerprint to key.
 * @returns Its ordering key.
 */
function fingerprintSortKey(fingerprint: FileFingerprint): string {
  return [
    fingerprint.file,
    String(fingerprint.mtimeMs),
    String(fingerprint.size),
    fingerprint.hash ?? ABSENT_SLOT,
  ].join(SORT_KEY_SEPARATOR);
}

/**
 * Orders two fingerprints byte-wise by {@link fingerprintSortKey}.
 *
 * Byte-wise rather than locale-aware, so the ordering — and therefore the key —
 * is identical on every machine, whatever the process locale.
 *
 * @param left The first fingerprint.
 * @param right The second fingerprint.
 * @returns A negative number, zero or a positive number, as `Array.sort` wants.
 */
function compareFingerprints(left: FileFingerprint, right: FileFingerprint): number {
  const leftKey = fingerprintSortKey(left);
  const rightKey = fingerprintSortKey(right);

  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
}

/**
 * `value` when it holds at least one character, `undefined` otherwise.
 *
 * An environment variable set to the empty string, and an option passed as one,
 * both mean "nothing was configured" rather than "the root is the current
 * directory", so both fall through to the next candidate in
 * {@link resolveIndexCacheDir}.
 *
 * @param value A candidate path, possibly absent or empty.
 * @returns The value, or `undefined`.
 */
function nonEmptyOrUndefined(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Expands a leading `~` or `~/` to the user's home directory and normalises the
 * result.
 *
 * No filesystem call expands a tilde — it is a shell convention — so a value
 * that arrived from a shell profile, a settings file or an environment variable
 * has to be expanded here or it becomes a literal directory named `~` in the
 * working directory. Only a *leading* tilde is expanded: `a/~/b` is a
 * directory called `~`.
 *
 * @param path A path, possibly tilde-prefixed, possibly with Windows
 * separators.
 * @returns The expanded, normalised POSIX path.
 */
function expandLeadingHome(path: string): string {
  const posix = toPosix(path);

  if (posix === HOME_MARKER) {
    return normalizePosix(toPosix(homedir()));
  }
  if (posix.startsWith(HOME_PREFIX)) {
    return joinPosix(toPosix(homedir()), posix.slice(HOME_PREFIX.length));
  }
  return normalizePosix(posix);
}

/**
 * The path of one entry file.
 *
 * Built with the platform's `join` rather than a POSIX one, because this value
 * is handed to the filesystem rather than stored or displayed. `key` has passed
 * {@link assertCacheKey} at every call site, so it holds no separator and no
 * `..` and the result cannot leave `cacheDir`.
 *
 * @param cacheDir The cache directory.
 * @param key A validated cache key.
 * @returns The entry's path.
 */
function entryPath(cacheDir: string, key: string): string {
  return join(cacheDir, `${key}${ENTRY_FILE_EXTENSION}`);
}

/**
 * Asserts the invariant every entry path rests on: the entry key is a
 * `stableHash` digest.
 *
 * Keys are never supplied by a caller — every operation derives its entry key
 * with {@link computeIndexCacheEntryKey} — so this cannot fail for any input;
 * it is the containment check stated where the filesystem is reached, so a
 * future change to the key derivation that let a separator through would fail
 * loudly here instead of writing outside the cache directory. A key matching
 * {@link CACHE_KEY_PATTERN} cannot express a path.
 *
 * The message states the offending value's *length* and never its content: a
 * malformed key is exactly the kind of value that might carry a path, and a
 * path does not belong in an error message or a log.
 *
 * @param key The key to validate.
 * @throws {DebuggenError} With code `INTERNAL` when the key is malformed.
 */
function assertCacheKey(key: string): void {
  assert(
    CACHE_KEY_PATTERN.test(key),
    `An index cache entry key must be 64 lowercase hexadecimal characters as produced by computeIndexCacheEntryKey; received a ${String(key.length)}-character value that does not match.`,
    'INTERNAL',
  );
}

/**
 * The `code` of a caught value, when it carries one.
 *
 * Reads the field every Node filesystem error sets — `ENOENT`, `ELOOP`,
 * `EACCES` — off a value whose shape is unknown, because a `catch` binding is
 * `unknown` and a rejection reason need not be an `Error` at all. A
 * `DebuggenError` also has a string `code`, from the product's own vocabulary
 * rather than the platform's; the call sites here only catch platform errors,
 * and the value is used for a log field either way.
 *
 * @param error Any caught value.
 * @returns The code, or `undefined` when there is none.
 */
function errnoCodeOf(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Decodes an entry's bytes as UTF-8, replacing anything invalid.
 *
 * Lenient on purpose: a truncated or corrupted entry should reach `JSON.parse`
 * and be refused there as one "unparsable" miss, rather than throwing a
 * decoding error that a second `catch` would have to translate into the same
 * outcome.
 *
 * @param bytes The entry's bytes.
 * @returns The decoded text.
 */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * The error {@link IndexCache.save} reports a failed write with.
 *
 * Keeps the original `code` — `FS_UNSAFE_PATH` when the state directory failed
 * its privacy policy, `CODE_INDEX_FAILED` for any other write failure — so a
 * caller can tell a misconfigured state directory from a full disk, and adds
 * the two things a bare filesystem error lacks: a `details.reason` that can be
 * branched on without parsing a message, and a hint naming what the developer
 * should check. An underlying hint is preserved rather than replaced, because
 * the policy failures carry a more specific one than this module can write.
 *
 * @param error The failure as `tryCatch` normalised it.
 * @param key The key whose entry could not be written.
 * @returns The error to return in an `Err`.
 */
function writeFailure(error: DebuggenError, key: string): DebuggenError {
  return new DebuggenError(error.code, error.message, {
    hint: error.hint ?? WRITE_FAILURE_HINT,
    details: { reason: 'cache-write-failed', key },
    cause: error,
  });
}
