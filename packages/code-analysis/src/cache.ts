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
 * Nothing is compared field by field at read time: invalidation lives entirely
 * in the **key**, which folds in the project root, the TypeScript configuration
 * in force, the indexer's version, this module's envelope version, the graph
 * vocabulary version and the modification time and size of every indexed file.
 * A tree that has changed in any of those respects asks for a different key,
 * finds nothing and rebuilds. Reading an entry therefore only has to establish
 * that the document is what it claims to be, which is why the checks in
 * {@link IndexCache.load} are structural rather than semantic.
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

import { readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DebuggenError,
  assert,
  err,
  isErr,
  joinPosix,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
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
 */
export const INDEX_CACHE_SCHEMA_VERSION: number = 1;

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

/** Separates the fields of a fingerprint's sort key; see {@link fingerprintSortKey}. */
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
 * the indexer version, the project root, the TypeScript configuration path, the
 * number of files, and then four parts per file — its project-relative path,
 * its modification time, its size and its content hash where one was computed.
 * Any difference in any of those is a different key and therefore a rebuild.
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
 * following parts.
 *
 * ## Order-insensitivity, and the total order behind it
 *
 * The file list is sorted on a copy — the caller's array is never mutated —
 * with a byte-wise comparison of a composite sort key, so the ordering is
 * identical on every machine and locale, and two fingerprints for the same path
 * (which a well-formed {@link CodeIndex} does not contain, and which a caller
 * assembling a list might) still order deterministically.
 *
 * Total: it never throws. A non-finite modification time or size — which a real
 * filesystem does not produce, but a synthesised fingerprint might — is
 * contributed as its textual form instead of as a number, so `NaN` and
 * `Infinity` stay distinguishable from each other and from any finite value
 * rather than making the key derivation fail.
 *
 * @param input The project identity and file fingerprints to key.
 * @returns The key, matching {@link CACHE_KEY_PATTERN}.
 *
 * @example
 * ```ts
 * const key = computeIndexCacheKey({
 *   projectRoot: project.projectRoot,
 *   tsConfigFilePath: project.tsConfigFilePath,
 *   indexerVersion: INDEXER_VERSION,
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
   * version, a document that does not have the shape of an index, a symbolic
   * link planted at the entry path, a permission error — each is logged and
   * returns `undefined`. A rejection is only possible for a malformed `key`,
   * which is a programmer error rather than a state of the disk.
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

    const entry: IndexCacheEntry = {
      schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
      key,
      writtenAt: nowEpochMs(),
      index,
    };

    const written = tryCatch(() => {
      // Serialised first, so a document that cannot be represented fails
      // before anything on disk is touched. A `CodeIndex` is plain JSON by
      // contract — no `Date`, no `Map`, no cycle — and this is where a
      // producer that broke that contract is caught.
      const serialized = JSON.stringify(entry);

      // The directory may have been removed since the cache was created, by
      // the service's retention job or by hand, so it is (re)created and
      // tightened to `0700` on every save rather than once at construction.
      // An existing directory with looser permissions is repaired here; one
      // that cannot be made private throws `FS_UNSAFE_PATH`, which becomes
      // this call's `Err` instead of an exception.
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

      const { index } = document;
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
 * The document one entry file holds.
 *
 * Four fields, and each is here because reading the file back needs it:
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
 * tree on disk is answered by the key, not by the contents.
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

  const { schemaVersion, key, writtenAt, index } = value;

  return (
    isFiniteNumber(schemaVersion) &&
    schemaVersion === INDEX_CACHE_SCHEMA_VERSION &&
    isNonEmptyString(key) &&
    isFiniteNumber(writtenAt) &&
    isCodeIndex(index)
  );
}

/**
 * The machine-readable reason a parsed document was refused, for the miss log.
 *
 * Three answers, and the distinction is worth the few lines: `schema-version`
 * is an expected consequence of a version bump and tells a reader nothing is
 * wrong, `malformed-index` points at the index inside the envelope, and
 * `malformed` at the envelope itself. A single "invalid" would leave all three
 * looking like corruption.
 *
 * @param value The document `isIndexCacheEntry` rejected.
 * @returns The reason, for the log's `reason` field.
 */
function rejectionReason(value: unknown): string {
  if (!isRecord(value)) {
    return 'malformed';
  }

  const { schemaVersion, index } = value;
  if (isFiniteNumber(schemaVersion) && schemaVersion !== INDEX_CACHE_SCHEMA_VERSION) {
    return 'schema-version';
  }
  if (!isCodeIndex(index)) {
    return 'malformed-index';
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
