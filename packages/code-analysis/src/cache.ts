/**
 * The code-index cache: one JSON entry per indexed tree, stored under
 * `$DEBUGGEN_HOME/index` and keyed by the project's identity plus a fingerprint
 * of every file that was read.
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
 * Two kinds of failure are deliberately *not* misses, because neither is a
 * state of the filesystem:
 *
 * - A key that is not 64 lowercase hexadecimal characters. That can only come
 *   from a caller that composed a key by hand instead of asking
 *   {@link computeIndexCacheKey}, so it throws a `DebuggenError` — a programmer
 *   error reported where it was made. It also means an entry path can never
 *   contain a path separator, so no key can traverse out of the cache
 *   directory.
 * - An empty cache directory passed to {@link createIndexCache}. A cache with
 *   nowhere to put its entries is a misconfiguration, not a miss.
 *
 * ## What invalidates an entry
 *
 * Two mechanisms, and the division between them is deliberate.
 *
 * **The key decides what is reachable.** It folds in the project root, the
 * TypeScript configuration in force, the indexer's version, the identities of
 * the extractors that ran and the order they ran in, this module's envelope
 * version, the graph vocabulary version and the modification time and size of
 * every indexed file. A tree that has changed in any of those respects asks
 * for a different key, finds nothing and rebuilds — the cheapest correct form
 * of invalidation, because the stale entry is never even opened.
 *
 * **The envelope's stamps decide what is fresh.** `mtimeMs` and `size` are the
 * only file metadata the key can carry, and a content substitution can preserve
 * both: `tar -x`, `cp -p`, `rsync --times`, `touch -r` and a hermetic
 * build-cache restore all write new bytes under an old modification time, and a
 * replacement body of the same byte length leaves the size alone too. Such a
 * tree asks for the *same* key and would be served an index describing code
 * that no longer exists. So {@link IndexCache.save} records a
 * {@link FileStamp} per indexed file in the envelope and
 * {@link IndexCache.load} takes the same stamps again and compares them, which
 * adds the one thing a substitution cannot forge from userspace: the inode's
 * change time, `ctimeMs`, which the kernel moves on every write to the inode
 * and which no process can set (with the inode number beside it, so a file
 * swapped for another by `rename` is caught even where the change times happen
 * to agree). Any difference is an ordinary miss like every other.
 *
 * Three consequences worth stating, because they are what make the
 * verification affordable:
 *
 * - **It is stat-only.** No file is read and nothing is hashed, so the promise
 *   that a hit is cheap survives: the work is one `stat` per indexed file
 *   against a rebuild that constructs a ts-morph program and runs every
 *   extractor — microseconds against seconds.
 * - **It fails closed.** A `chmod`, a rewrite with identical content, or a
 *   checkout that changed only the change time all move `ctimeMs` without
 *   changing what the file says, and each costs one rebuild that produces the
 *   same index. That is the correct direction for a pure optimisation: a
 *   spurious miss is slow, a spurious hit is wrong.
 * - **A synthesised index still round-trips.** A caller may cache an index
 *   over files that do not exist on disk — a fixture, a projection, a tree that
 *   has since been removed — and an absent stamp compares equal to an absent
 *   stamp, so such an entry is stored and served exactly as before.
 *
 * Retention and pruning are **not** this module's responsibility. It never
 * enumerates the directory except when explicitly asked to
 * ({@link IndexCache.clear}), never deletes an entry other than the one it was
 * asked about or one it has just rejected, and imposes no size or age bound.
 * The service owns that policy, and keeping it there is what stops two
 * components from deleting each other's state on different schedules.
 *
 * @packageDocumentation
 */

import { statSync } from 'node:fs';
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
 * to be able to move without the other, which is why both are folded into the
 * key by {@link computeIndexCacheKey} and why this one is also recorded in the
 * envelope.
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
 *   {@link IndexCache.load} verifies (see "What invalidates an entry"). The
 *   persisted document changed shape, so a version-1 entry is missing a field
 *   this version requires; because the version is folded into the key as well
 *   as into the envelope, those entries are both unreachable and rejected,
 *   which is the whole migration.
 */
export const INDEX_CACHE_SCHEMA_VERSION: number = 2;

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
 * The first part of every key, so a digest produced here can never equal one
 * produced by another part of the product over coincidentally similar inputs.
 *
 * Cheap domain separation: `stableHash` frames each part, so this prefix makes
 * the key space of this module disjoint from every other `stableHash` caller's
 * by construction rather than by naming discipline.
 */
const KEY_DOMAIN = 'debuggen/code-index-cache';

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

/** What a developer can do about a cache that cannot be written. */
const WRITE_FAILURE_HINT =
  'The index will be rebuilt on the next run; if this keeps happening, check that the Debug Generator state directory is writable and owned by you.';

/* -------------------------------------------------------------------------------------------------
 * Key derivation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Everything a cache key is derived from.
 *
 * The caller assembles this from the loaded project and the file list it is
 * about to index — or has just indexed — and passes the same input to
 * {@link computeIndexCacheKey} before a {@link IndexCache.load} and before a
 * {@link IndexCache.save}, which is what makes the two agree.
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
   * The unit of invalidation: a changed modification time or size anywhere in
   * this list is a different key. **Order does not matter** — the list is
   * sorted inside {@link computeIndexCacheKey} — so a caller may pass files in
   * traversal order, in the order a `Map` happened to hold them, or sorted, and
   * get the same key from all three.
   */
  readonly files: readonly FileFingerprint[];
}

/**
 * The cache key for one project state: 64 lowercase hexadecimal characters.
 *
 * ## What the key covers
 *
 * In order: a domain tag, the envelope version, the graph vocabulary version,
 * the indexer version, the number of extractors followed by each extractor's
 * identifier in run order, the project root, the TypeScript configuration path,
 * the number of files, and then four parts per file — its project-relative
 * path, its modification time, its size and its content hash where one was
 * computed. Any difference in any of those is a different key and therefore a
 * rebuild.
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
 * const key = computeIndexCacheKey({
 *   projectRoot: project.projectRoot,
 *   tsConfigFilePath: project.tsConfigFilePath,
 *   indexerVersion: INDEXER_VERSION,
 *   extractors: extractors.map((extractor) => extractor.id),
 *   files: fingerprints,
 * });
 * const cached = await cache.load(key);
 * ```
 */
export function computeIndexCacheKey(input: IndexCacheKeyInput): string {
  const sorted = [...input.files].sort(compareFingerprints);

  const parts: (string | number)[] = [
    KEY_DOMAIN,
    input.schemaVersion ?? INDEX_CACHE_SCHEMA_VERSION,
    CODE_INDEX_SCHEMA_VERSION,
    input.indexerVersion,
    input.extractors.length,
    // In the caller's order, deliberately unsorted: see
    // `IndexCacheKeyInput.extractors`.
    ...input.extractors,
    toPosix(input.projectRoot),
    input.tsConfigFilePath === undefined ? ABSENT_SLOT : toPosix(input.tsConfigFilePath),
    sorted.length,
  ];

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
 * concurrent operations cannot interfere through it. Two processes writing the
 * same key at once is equally safe — see {@link IndexCache.save}.
 */
export interface IndexCache {
  /** The directory entries live in, exactly as it was configured. */
  readonly cacheDir: string;

  /**
   * The index stored under `key`, or `undefined` when there is not a valid one.
   *
   * **Never rejects for a filesystem or content problem**, which is the
   * contract the rest of the package is written against. An absent entry, an
   * absent directory, an unparsable document, a stale envelope or vocabulary
   * version, a document that does not have the shape of an index, a file whose
   * change stamp no longer matches the one the entry recorded, a symbolic link
   * planted at the entry path, a permission error — each is logged and returns
   * `undefined`. A rejection is only possible for a malformed `key`, which is a
   * programmer error rather than a state of the disk.
   *
   * The freshness half of that list costs one `stat` per indexed file and reads
   * no file's contents; "What invalidates an entry" in the module
   * documentation explains why it is there when the key already covers each
   * file's modification time and size.
   *
   * An entry that is rejected for anything other than being absent is also
   * **removed**, so a corrupt or stale file costs one read once rather than one
   * read on every run for as long as it sits there.
   *
   * @param key A key from {@link computeIndexCacheKey}.
   * @returns The cached index, or `undefined` on any kind of miss.
   * @throws {DebuggenError} Rejects with code `INTERNAL` when `key` is not 64
   * lowercase hexadecimal characters.
   */
  load(key: string): Promise<CodeIndex | undefined>;

  /**
   * Stores `index` under `key`, creating the cache directory when it is absent.
   *
   * The write is atomic — a temporary sibling is created `0600`, written,
   * flushed and renamed over the entry path — so a reader never observes a
   * partial document and two processes racing on one key leave the last
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
   * @param key A key from {@link computeIndexCacheKey}.
   * @param index The index to store.
   * @returns `ok(undefined)` when the entry is on disk; `err(DebuggenError)`
   * carrying `FS_UNSAFE_PATH` when the directory fails its privacy policy and
   * `CODE_INDEX_FAILED` for any other write failure.
   * @throws {DebuggenError} Rejects with code `INTERNAL` when `key` is not 64
   * lowercase hexadecimal characters — a rejection rather than a synchronous
   * throw, so every method of this interface fails the same way.
   */
  save(key: string, index: CodeIndex): Promise<Result<void>>;

  /**
   * Removes the entry under `key`, if there is one.
   *
   * Best effort and idempotent: an entry that is not there is success, and a
   * removal that cannot be performed is logged at `debug` and swallowed. Used
   * by {@link IndexCache.load} on every rejected entry, and available to a
   * caller that knows an index is no longer trustworthy.
   *
   * @param key A key from {@link computeIndexCacheKey}.
   * @throws {DebuggenError} Rejects with code `INTERNAL` when `key` is not 64
   * lowercase hexadecimal characters.
   */
  evict(key: string): Promise<void>;

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
 * const key = computeIndexCacheKey(keyInput);
 * const index = (await cache.load(key)) ?? buildIndex();
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
   * The synchronous body of `save`. Separated so the promise-returning method
   * stays one line and the sequence below reads as what it is: serialise,
   * secure the directory, write atomically.
   */
  const writeEntry = (key: string, index: CodeIndex): Result<void> => {
    assertCacheKey(key);

    // Taken before the document is serialised, and total: `stampFiles` answers
    // with an absent stamp for every path it cannot screen or cannot stat, so a
    // project whose files have already been removed is cached rather than
    // failing to cache. One `stat` per indexed file, no read.
    const entry: IndexCacheEntry = {
      schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
      key,
      writtenAt: nowEpochMs(),
      index,
      stamps: stampFiles(index),
    };

    const written = tryCatch(() => {
      // Serialised first, so a document that cannot be represented fails
      // before anything on disk is touched. A `CodeIndex` is plain JSON by
      // contract — no `Date`, no `Map`, no cycle — and this is where a
      // producer that broke that contract is caught.
      const serialized = JSON.stringify(entry);

      // The directory may have been removed since the cache was created, by
      // the service's retention job or by hand, so it is (re)created at
      // `0700` on every save rather than once at construction. An existing
      // directory is judged as it stands and never has its mode changed: one
      // that grants group or other access, is a link or belongs to another
      // account throws `FS_UNSAFE_PATH`, which becomes this call's `Err`
      // instead of an exception, and nothing is written into it.
      ensureSecureDir(cacheDir);

      // Temporary sibling, `0600`, flushed, then renamed over the entry path:
      // atomic for a reader, last-writer-wins for two concurrent writers, and
      // never a write through a link.
      writeSecureFileAtomic(entryPath(cacheDir, key), serialized);

      return serialized.length;
    }, 'CODE_INDEX_FAILED');

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

  return {
    cacheDir,

    async load(key: string): Promise<CodeIndex | undefined> {
      assertCacheKey(key);

      // Read with a refusal to follow a symbolic link at the final component:
      // the entry path is inside a `0700` directory, but a link planted there
      // by an earlier, differently configured run must not become a read of
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

        // `ELOOP` (a planted symlink), `EACCES`, `EISDIR`, `ENOTDIR`, `EIO`:
        // each is a miss, and each would recur on every run, so the entry goes.
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
      // entry that was copied, renamed or hand-written under another key is
      // refused. This is also what makes the indexer-version guarantee hold at
      // read time: the version is part of the key, and the key is part of the
      // document.
      if (document.key !== key) {
        logger.warn(MISS_MESSAGE, { key, reason: 'key-mismatch' });
        await removeEntry(key);
        return undefined;
      }

      // The graph vocabulary moved since this entry was written, so its nodes
      // and edges may mean something this version does not know. A different
      // vocabulary version also produces a different key, so reaching here at
      // all means the file is older than its name claims.
      if (document.index.schemaVersion !== CODE_INDEX_SCHEMA_VERSION) {
        logger.debug(MISS_MESSAGE, { key, reason: 'stale-vocabulary' });
        await removeEntry(key);
        return undefined;
      }

      // Freshness, and the one check the key cannot make: a content
      // substitution that preserved every file's modification time and size
      // asks for this very key, so the only way to notice it is to take each
      // file's change stamp again and compare it with the one the entry
      // recorded. Stat-only and fail-closed; see "What invalidates an entry".
      const { index } = document;
      const stamps = stampFiles(index);
      const differences = countStampDifferences(document.stamps, stamps);
      if (differences > 0) {
        logger.debug(MISS_MESSAGE, {
          key,
          reason: 'stale-file',
          files: index.files.length,
          stamps: document.stamps.length,
          differences,
        });
        await removeEntry(key);
        return undefined;
      }

      logger.debug('code index cache hit', {
        key,
        nodes: index.nodes.length,
        edges: index.edges.length,
        files: index.files.length,
        ageMs: Math.max(0, nowEpochMs() - document.writtenAt),
      });
      return index;
    },

    // Deliberately not `async`: everything the write does is synchronous by
    // necessity (see `IndexCache` on why the hardened writers have no promise
    // form). It is still wrapped in a promise chain rather than run inline, so
    // that a malformed key arrives as a *rejection* here exactly as it does
    // from `load` and `evict` — one interface, one way of failing, and no
    // caller that reaches for `.catch()` instead of `await` is surprised by a
    // synchronous throw.
    save(key: string, index: CodeIndex): Promise<Result<void>> {
      return Promise.resolve().then(() => writeEntry(key, index));
    },

    async evict(key: string): Promise<void> {
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
 * (see "What invalidates an entry"). When it is `false` the four numbers are
 * zero, so an unreadable file cannot be told apart from a missing one — which
 * is intentional, because neither is evidence of anything and any *change* in
 * that state shows up as `present` moving.
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
 * The document one entry file holds.
 *
 * Five fields, and each is here because reading the file back needs it:
 *
 * - `schemaVersion` — the **envelope** version
 *   ({@link INDEX_CACHE_SCHEMA_VERSION}), so a document written by another
 *   layout of this file is refused rather than misread. The index's own
 *   vocabulary version lives on `index.schemaVersion`, which is a different
 *   question and is checked separately.
 * - `key` — the key the entry was written under, so a file that was copied or
 *   renamed cannot be served under a key it was not derived from.
 * - `writtenAt` — epoch milliseconds, for the age a hit is logged with. Named
 *   for the write rather than a "creation" because `createdAt` is demo
 *   application vocabulary that `scripts/check-no-hardcoding.mjs` refuses in a
 *   product module, and the field is internal, so the name costs nothing.
 * - `index` — the index itself.
 * - `stamps` — one {@link FileStamp} per entry of `index.files`, in that order.
 *   The division of labour with the key: the key carries the project's identity
 *   and each file's metadata, and this carries the one thing a substitution
 *   cannot forge from userspace — the inode's change time, and its inode number
 *   beside it. Without it an entry whose files were rewritten under their old
 *   modification times and at their old sizes is indistinguishable from a fresh
 *   one, because those two fields are exactly what the key already agreed on.
 *   It lives in the envelope rather than in the key because it must be
 *   *compared*: folding a change time into the key would make every `chmod`
 *   derive a new key and orphan the old entry instead of replacing it, and
 *   would leave the entry that is already on disk unexaminable.
 *
 * `indexerVersion` is deliberately **not** repeated here: a
 * {@link CodeIndex} owns that field, and duplicating it would create two
 * places that could disagree. The version is folded into the key, so an entry
 * from another indexer version is unreachable, and the `key` check above is
 * what closes the copied-file case.
 *
 * Internal: the document is this module's private storage format, and nothing
 * outside it should be written against a shape that a version bump is free to
 * change.
 */
interface IndexCacheEntry {
  readonly schemaVersion: number;
  readonly key: string;
  readonly writtenAt: number;
  readonly index: CodeIndex;
  readonly stamps: readonly FileStamp[];
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
 * answered by the key, and freshness by comparing the envelope's
 * {@link FileStamp}s with the filesystem — a separate step in
 * {@link IndexCache.load}, because `mtimeMs` and `size` can both survive a
 * content substitution and are the only file metadata the key carries.
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

  const { schemaVersion, key, writtenAt, index, stamps } = value;

  return (
    isFiniteNumber(schemaVersion) &&
    schemaVersion === INDEX_CACHE_SCHEMA_VERSION &&
    isNonEmptyString(key) &&
    isFiniteNumber(writtenAt) &&
    isCodeIndex(index) &&
    // An entry without a well-formed stamp list is not an entry of this
    // version: the freshness check has nothing to compare against, and serving
    // the index anyway would be the very behaviour version 2 exists to end.
    isUnknownArray(stamps) &&
    stamps.every(isFileStampShape)
  );
}

/**
 * The machine-readable reason a parsed document was refused, for the miss log.
 *
 * Four answers, and the distinction is worth the few lines: `schema-version`
 * is an expected consequence of a version bump and tells a reader nothing is
 * wrong, `malformed-index` points at the index inside the envelope,
 * `malformed-stamps` at the freshness evidence beside it — the one part of the
 * envelope a hand-edited or truncated document tends to lose while the index
 * still parses — and `malformed` at the envelope itself. A single "invalid"
 * would leave all four looking like corruption.
 *
 * @param value The document `isIndexCacheEntry` rejected.
 * @returns The reason, for the log's `reason` field.
 */
function rejectionReason(value: unknown): string {
  if (!isRecord(value)) {
    return 'malformed';
  }

  const { schemaVersion, index, stamps } = value;
  if (isFiniteNumber(schemaVersion) && schemaVersion !== INDEX_CACHE_SCHEMA_VERSION) {
    return 'schema-version';
  }
  if (!isCodeIndex(index)) {
    return 'malformed-index';
  }
  if (!isUnknownArray(stamps) || !stamps.every(isFileStampShape)) {
    return 'malformed-stamps';
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
 * The single derivation both sides use — {@link IndexCache.save} to record the
 * stamps and {@link IndexCache.load} to take them again — which is what makes
 * the comparison meaningful: two implementations of "stamp this file" that
 * differed in one detail (`lstat` on one side, a rejected path treated as
 * absent on only the other) would either miss forever or hit when they should
 * not.
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
    if (!stats.isFile()) {
      return absentStamp(file);
    }

    return {
      file,
      present: true,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      ctimeMs: stats.ctimeMs,
      ino: stats.ino,
    };
  } catch {
    // `ENOENT`, `EACCES`, `ELOOP`, `ENOTDIR`, `EIO`: none of them is evidence
    // about the file's contents, and none of them may become an exception —
    // `load` and `save` both promise never to fail for a filesystem problem.
    return absentStamp(file);
  }
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
 * How far two stamp lists are apart: the size of the symmetric difference of
 * the two multisets, and therefore `0` exactly when they describe the same
 * files in the same state.
 *
 * Multiset rather than sequence equality, so the answer does not depend on the
 * order either list happens to be in — a well-formed {@link CodeIndex} sorts
 * its `files`, but an entry is untrusted input and a caller may synthesise one
 * in any order. Multiset rather than set, so a list that holds the same path
 * twice with two different stamps is not silently collapsed to one.
 *
 * A file that was *changed* therefore contributes two to the count — the stamp
 * that is gone and the stamp that is there now — and one that appeared or
 * disappeared contributes one. The number is a log field for a reader
 * estimating how much of a tree moved, never a threshold: any value above zero
 * is a miss.
 *
 * Total: it reads no filesystem and never throws.
 *
 * @param recorded The stamps the entry was written with.
 * @param current The stamps taken again just now.
 * @returns The number of stamps that differ, `0` when the two agree.
 */
function countStampDifferences(
  recorded: readonly FileStamp[],
  current: readonly FileStamp[],
): number {
  const balance = new Map<string, number>();

  for (const stamp of recorded) {
    const stampsKey = stampKey(stamp);
    balance.set(stampsKey, (balance.get(stampsKey) ?? 0) + 1);
  }
  for (const stamp of current) {
    const stampsKey = stampKey(stamp);
    balance.set(stampsKey, (balance.get(stampsKey) ?? 0) - 1);
  }

  let differences = 0;
  for (const count of balance.values()) {
    differences += Math.abs(count);
  }
  return differences;
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
 * Refuses a key that did not come from {@link computeIndexCacheKey}.
 *
 * A programmer error rather than a miss: a caller that composed a key by hand
 * has a bug, and serving it a miss would hide the bug behind a cache that never
 * hits. It is also the containment check — a key matching
 * {@link CACHE_KEY_PATTERN} cannot express a path — so it runs before any
 * filesystem call in every operation.
 *
 * The message states the offending value's *length* and never its content: a
 * hand-built key is exactly the kind of value that might carry a path or a
 * token, and neither belongs in an error message or a log.
 *
 * @param key The key to validate.
 * @throws {DebuggenError} With code `INTERNAL` when the key is malformed.
 */
function assertCacheKey(key: string): void {
  assert(
    CACHE_KEY_PATTERN.test(key),
    `An index cache key must be 64 lowercase hexadecimal characters as produced by computeIndexCacheKey; received a ${String(key.length)}-character value that does not match.`,
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
