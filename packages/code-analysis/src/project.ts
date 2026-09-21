/**
 * The single construction site for the ts-morph `Project` this package reads a
 * target application with, and the module that mechanically enforces the one
 * privacy guarantee static analysis is capable of breaking: **the indexer never
 * reads a developer's environment files.**
 *
 * Everything else in `@debuggen/code-analysis` — the indexer, the route map,
 * the project summary, the text search and every extractor — receives its
 * files through the {@link LoadedProject} handle {@link openProject} returns,
 * and none of them opens a file of its own. That is deliberate: a guarantee
 * that lives in one module is a guarantee that can be tested, and a guarantee
 * spread across nine modules is a hope.
 *
 * ## The guarantee, and what enforces it
 *
 * A developer's project root holds source code, and beside it — in the same
 * tree, matched by the same permissive `include` globs their build uses — sit
 * `.env`, `.env.local`, a database URL, a password, an API token. The product's
 * privacy model states that those files are *never read* by the indexer, so
 * nothing in them can reach the session store, a prompt, a log line or a user
 * interface, whatever a later stage asks for.
 *
 * Three independent mechanisms hold that line, and each one is sufficient on
 * its own:
 *
 * 1. **The file set is this module's, not the target's.** The `Project` is
 *    always constructed with `skipAddingFilesFromTsConfig`, so however
 *    permissive the target's `include`/`files` are — `["**\/*"]` is legal and
 *    not rare — the compiler adds nothing by itself. Every file the project
 *    holds was added by {@link openProject} through a glob list built here.
 * 2. **The globs exclude by construction.** Positive globs name the
 *    {@link INDEXABLE_EXTENSIONS} and nothing else; negative globs remove every
 *    {@link EXCLUDED_DIRECTORY_NAMES} tree, declaration files, minified bundles
 *    and every `.env*` path at any depth.
 * 3. **A filter runs afterwards anyway.** Every file the glob layer returned is
 *    re-judged with {@link shouldExcludePath} and {@link isIndexableFile}, and
 *    an environment file that reached the project despite both mechanisms above
 *    is *unloaded from it* — `project.removeSourceFile`, so its content leaves
 *    memory too — and reported at `warn`. A mis-specified glob is then a
 *    logged anomaly rather than a leak.
 *
 * The sibling `project.test.ts` exercises all three, including a target whose
 * `tsconfig.json` has been widened to `include: ["**\/*"]`. Treat a failure
 * there as a security regression, not a broken unit test.
 *
 * ## Why the target's own tsconfig cannot own the file set
 *
 * The configuration is still read — that is what makes the target's own
 * `compilerOptions` apply, and in particular its `paths` aliases, without which
 * an import written `@/<segment>` resolves to nothing and the import extractor
 * loses every aliased edge in the project. What the configuration does *not*
 * get to decide is *which files exist*: its `include` is written for a build,
 * where reading an environment file is harmless because the bundler never
 * emits it, and for an indexer that reads to summarise, the same glob is a
 * disclosure. Taking the options and rejecting the file list is the only
 * combination that gives correct resolution and a bounded file set.
 *
 * ## Behaviour worth knowing before you call this
 *
 * - **Failures are values.** `openProject` returns `Result<LoadedProject>` and
 *   throws for nothing a caller can provoke: a relative root, a missing root, a
 *   root that is a file, a malformed or absent `tsconfig.json`, an unreadable
 *   file — each comes back as an `Err` carrying a `DebuggenError` with one of
 *   `PATH_OUTSIDE_PROJECT`, `PROJECT_NOT_FOUND` or `CODE_INDEX_FAILED`, a hint
 *   naming the developer's next step, and a `details.reason` a caller can
 *   branch on.
 * - **A malformed `tsconfig.json` is an `Err`, not a silent fallback.** The
 *   alternative — quietly indexing with default options — drops the target's
 *   `paths` aliases and produces a graph that is wrong in a way no message
 *   explains. An *absent* `tsconfig.json` is a different case and is fine: it
 *   is the documented fallback path below.
 * - **An empty project is a success.** A root with no indexable file returns
 *   `Ok` with an empty {@link LoadedProject.sourceFiles} and a `warn`. Whether
 *   that is a dead end is the indexer's decision, not this module's.
 * - **The handle is immutable for its lifetime.** The file list is computed
 *   once, sorted by project-relative path with a byte-wise comparison (never a
 *   locale-dependent one, so two machines agree), frozen, and returned by every
 *   call to `sourceFiles()`. Files added to `loaded.project` afterwards do not
 *   appear in it; re-open the project instead, which is what makes an index,
 *   its cache key and a test expectation reproducible.
 * - **Hidden directories are not indexed.** ts-morph's glob layer does not
 *   match a path segment beginning with a dot unless the pattern says so, which
 *   is why `.next`, `.turbo`, `.cache` and `.git` are excluded twice over — and
 *   why a source file parked under any other hidden directory is invisible to
 *   the indexer. The negative globs for those trees are kept regardless, so the
 *   exclusion does not depend on a third-party default.
 * - **Type resolution is not required.** A target whose dependencies are not
 *   installed indexes exactly as one whose dependencies are: unresolvable
 *   module specifiers, missing `lib` files and missing ambient types produce no
 *   failure here, because every consumer of this handle works from the abstract
 *   syntax tree first and reaches for a type only when one is available.
 *
 * @example
 * ```ts
 * const opened = openProject({ projectRoot: '/home/dev/project', logger });
 * if (isErr(opened)) {
 *   return opened; // propagate the DebuggenError unchanged
 * }
 * for (const sourceFile of opened.value.sourceFiles()) {
 *   const file = opened.value.projectRelative(sourceFile.getFilePath());
 *   // file is 'app/api/<segment>/route.ts', never an absolute path
 * }
 * ```
 */

import { lstatSync, realpathSync, statSync } from 'node:fs';

import {
  DebuggenError,
  basenamePosix,
  err,
  extnamePosix,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  isWithin,
  joinPosix,
  noopLogger,
  normalizePosix,
  ok,
  toPosix,
  toProjectRelative,
  tryCatch,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result } from '@debuggen/shared';
import { Project, ts } from 'ts-morph';
import type { CompilerOptions, SourceFile } from 'ts-morph';

/**
 * The POSIX path separator, spelled once.
 *
 * Every path this module handles has already been through `toPosix`, so a
 * backslash is a separator that has been converted rather than one that still
 * has to be considered.
 */
const SEPARATOR = '/';

/**
 * The file extensions the indexer reads.
 *
 * TypeScript and its two explicit module flavours (`.mts`, `.cts`), JSX, and
 * the JavaScript equivalents of all three. JavaScript is included because a
 * target project is not obliged to be written entirely in TypeScript — a
 * configuration module, a legacy helper or a whole JavaScript application is
 * ordinary, and an extractor that works from the abstract syntax tree reads it
 * with no loss. ts-morph parses a `.js` file even when the target's
 * `compilerOptions.allowJs` is `false`, which is why the option is not consulted
 * here.
 *
 * What is absent is as deliberate as what is present: no `.json`, `.css`,
 * `.scss`, `.md`, `.svg` or `.map`. None of them declares a symbol the pipeline
 * can instrument, and every one of them would enlarge the compiler's program
 * for nothing.
 */
export const INDEXABLE_EXTENSIONS: readonly string[] = Object.freeze([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/**
 * Directory names that are never indexed, at any depth below the project root.
 *
 * Each one is a *generated or vendored* tree — code the developer did not write
 * and that the product must not attribute to them, in volumes that would
 * dominate the index and the compiler's program:
 *
 * - `node_modules` — installed dependencies. By far the largest tree in a
 *   typical project, and the one whose accidental inclusion turns a
 *   two-second index into a minutes-long one.
 * - `.next` — a Next.js build and dev-server cache, holding generated server
 *   and client bundles of the very files that *are* indexed from source.
 * - `dist`, `out`, `build` — the conventional bundler and compiler output
 *   directories. Indexing them would double every symbol, once from source and
 *   once from its transpiled copy.
 * - `coverage` — instrumented copies and report assets from a test run.
 * - `.git` — repository internals: object and index files, never source.
 * - `.turbo`, `.tsbuild`, `.cache`, `.vercel` — task-runner, incremental
 *   compiler, tooling and platform caches.
 *
 * Matching is on a path segment *relative to the project root*, so a project
 * that happens to be checked out beneath a directory literally named `dist` is
 * indexed normally — see {@link shouldExcludePath}.
 */
export const EXCLUDED_DIRECTORY_NAMES: readonly string[] = Object.freeze([
  'node_modules',
  '.next',
  'dist',
  'out',
  'build',
  'coverage',
  '.git',
  '.turbo',
  '.tsbuild',
  '.cache',
  '.vercel',
]);

/**
 * Declaration-file suffixes, in every module flavour TypeScript emits.
 *
 * `.d.mts` and `.d.cts` are as much declaration files as `.d.ts`; a check that
 * knows only the last of the three lets two thirds of them into the index.
 */
const DECLARATION_FILE_SUFFIXES: readonly string[] = Object.freeze(['.d.ts', '.d.mts', '.d.cts']);

/** The suffix of a minified bundle, excluded by name — see {@link shouldExcludePath}. */
const MINIFIED_SUFFIX = '.min.js';

/** The basename of an environment file with no qualifier. */
const ENV_BASENAME = '.env';

/** The prefix every qualified environment file basename carries. */
const ENV_PREFIX = '.env.';

/** The configuration file {@link openProject} probes for when none is named. */
const TSCONFIG_BASENAME = 'tsconfig.json';

/**
 * The glob metacharacters that must be neutralised in a *literal* path before
 * it can be used as the prefix of a pattern.
 *
 * ts-morph's glob layer normalises backslashes to forward slashes before
 * matching, so backslash escaping is unavailable: an escaped `\(` arrives as
 * `/(`. A single-character class — `(` written `[(]` — is the form that
 * survives, and it is what {@link escapeGlobLiteral} produces.
 *
 * `!` and `^` are deliberately **not** in this set. `[!]` and `[^]` open a
 * *negated* class rather than matching the character, so escaping them breaks
 * the pattern outright, while leaving them literal matches correctly: the
 * leading `!` that marks a negative pattern is added by this module after the
 * prefix has been escaped, so a `!` inside a directory name is never mistaken
 * for one.
 */
const GLOB_METACHARACTERS = /[()[\]{}*?+@$|]/g;

/**
 * Whether a path names an environment file.
 *
 * **This is the privacy predicate of this package.** The product's privacy
 * model states that `.env*` files, a `DATABASE_URL` and passwords are never
 * read by the indexer: they are not parsed, not summarised, not hashed into a
 * cache key, never attached to a graph node, and consequently can never reach
 * the session store, a model prompt, a log line or a panel. Every other
 * exclusion in this module is a performance or correctness measure; this one is
 * a security control, and it has its own test.
 *
 * True for a basename that is exactly `.env`, and for every qualified variant,
 * which is any basename beginning `.env.` — `.env.local`,
 * `.env.development`, `.env.production.local`, and whatever convention a
 * project invents next, because the rule is the prefix rather than a list of
 * known suffixes.
 *
 * False for a name that merely mentions the word: `env.ts`, `environment.ts`,
 * `.environment`, `config.env.ts`. Those are ordinary modules and are indexed
 * normally.
 *
 * A basename of the form `.env.<anything>` is treated as an environment file
 * even when it carries a code extension (`.env.ts`). That is the fail-closed
 * direction, and a module with such a name is pathological in a way no target
 * project should depend on.
 *
 * Separators are converted before the basename is taken, so a Windows-style
 * path answers the same as its POSIX form, and the depth of the path is
 * irrelevant: a nested `packages/<name>/.env` is an environment file exactly as
 * a root-level one is.
 *
 * @param path Any path, absolute or relative, POSIX or Windows.
 * @returns `true` when the final path component names an environment file.
 *
 * @example
 * ```ts
 * isEnvFilePath('.env'); // true
 * isEnvFilePath('apps/<name>/.env.production.local'); // true
 * isEnvFilePath('src/lib/environment.ts'); // false
 * ```
 */
export function isEnvFilePath(path: string): boolean {
  const basename = basenamePosix(toPosix(path));
  return basename === ENV_BASENAME || basename.startsWith(ENV_PREFIX);
}

/**
 * Whether a path names a file this package is willing to parse.
 *
 * Two conditions, both required: the extension is one of
 * {@link INDEXABLE_EXTENSIONS}, and the file is not a TypeScript declaration
 * file.
 *
 * Declaration files are skipped because they carry no runtime symbol the
 * pipeline can act on. Their content is types — no function body to time, no
 * event handler to trace, no call to a database to find — so every graph node
 * derived from one would be a node no instrumentation plan could ever target.
 * They are also, in a project of any size, mostly *generated*: a framework
 * writes an ambient declaration file into the project root on every dev-server
 * start, and a build emits one beside each module it compiles. All three
 * flavours are recognised (`.d.ts`, `.d.mts`, `.d.cts`).
 *
 * The extension comparison is case-insensitive. A case-insensitive filesystem
 * will hand back `Module.TS` for a file the project refers to as `module.ts`,
 * and refusing to index it because of the case of its extension would be a
 * silent hole in the file set.
 *
 * This predicate says nothing about *where* the file is — a path inside
 * `node_modules` is perfectly indexable by this test. {@link shouldExcludePath}
 * is the question about location, and {@link openProject} asks both.
 *
 * @param path Any path, absolute or relative, POSIX or Windows.
 * @returns `true` when the file's extension is indexable and it is not a
 * declaration file.
 *
 * @example
 * ```ts
 * isIndexableFile('src/lib/thing.ts'); // true
 * isIndexableFile('next.config.mjs'); // true
 * isIndexableFile('src/types/generated.d.ts'); // false
 * isIndexableFile('src/styles/base.css'); // false
 * ```
 */
export function isIndexableFile(path: string): boolean {
  const basename = basenamePosix(toPosix(path)).toLowerCase();

  for (const suffix of DECLARATION_FILE_SUFFIXES) {
    if (basename.endsWith(suffix)) {
      return false;
    }
  }

  return INDEXABLE_EXTENSIONS.includes(extnamePosix(basename));
}

/**
 * Whether a path must be kept out of the index, judged against the project it
 * is supposed to belong to.
 *
 * The four reasons, checked in this order:
 *
 * 1. **It is not inside the project root.** Containment is decided by
 *    `toProjectRelative` from `@debuggen/shared`, so an absolute path outside
 *    the root, a traversal, a network-share prefix and a path with a control
 *    character are all refused — and refused *silently*, as a `true` here,
 *    because a caller of this predicate is filtering a list rather than
 *    reporting a fault.
 * 2. **It is an environment file** ({@link isEnvFilePath}).
 * 3. **It is a minified bundle** (`*.min.js`). Generated output whose single
 *    enormous line yields a useless graph and a slow parse.
 * 4. **A directory on the way to it is excluded** — an entry of
 *    {@link EXCLUDED_DIRECTORY_NAMES} or of `extraExcludes`.
 *
 * ## Exclusion is evaluated *relative to the project root*
 *
 * This is the trap the ordering above exists to avoid. A developer may
 * legitimately keep their project at `/home/dev/dist/my-project` or
 * `/var/build/workspace`, and matching directory names against the *absolute*
 * path would then exclude every file in it and produce an empty index with no
 * explanation. The path is therefore reduced to its project-relative form
 * first, and only the segments *below* the root are matched. The root's own
 * name is never considered.
 *
 * ## What `extraExcludes` accepts
 *
 * Either a bare directory name (`'generated'`) or a project-relative directory
 * path (`'src/generated'`), each matched at any depth as a whole run of
 * segments — `'src/generated'` excludes `src/generated/client.ts` and
 * `packages/<name>/src/generated/client.ts`, and does not exclude
 * `src/generated-docs/index.ts`. Entries are **not** globs: a `*` in an entry
 * matches a literal asterisk, because a caller that wants pattern matching is
 * better served by naming the directory.
 *
 * @param projectRoot The absolute path of the project root.
 * @param absolutePath The path being judged, normally absolute. A relative path
 * is taken to be project-relative already.
 * @param extraExcludes Additional directory names or project-relative
 * directory paths to exclude.
 * @returns `true` when the path must not be indexed.
 *
 * @example
 * ```ts
 * shouldExcludePath('/p', '/p/node_modules/<pkg>/index.ts'); // true
 * shouldExcludePath('/p', '/p/.env.local'); // true
 * shouldExcludePath('/p', '/elsewhere/thing.ts'); // true — outside the root
 * shouldExcludePath('/home/dev/dist/p', '/home/dev/dist/p/src/thing.ts'); // false
 * ```
 */
export function shouldExcludePath(
  projectRoot: string,
  absolutePath: string,
  extraExcludes?: readonly string[],
): boolean {
  const relative = toProjectRelative(projectRoot, absolutePath);
  if (isErr(relative)) {
    return true;
  }

  const relativePath = relative.value;

  if (isEnvFilePath(relativePath)) {
    return true;
  }

  if (basenamePosix(relativePath).toLowerCase().endsWith(MINIFIED_SUFFIX)) {
    return true;
  }

  if (matchesExcludedDirectory(relativePath, EXCLUDED_DIRECTORY_NAMES)) {
    return true;
  }

  return extraExcludes !== undefined && matchesExcludedDirectory(relativePath, extraExcludes);
}

/**
 * How {@link openProject} should open a project.
 *
 * Every member other than the root is optional, and every optional member
 * spells `| undefined` explicitly: the repository compiles with
 * `exactOptionalPropertyTypes`, so a caller forwarding a value it received as
 * `string | undefined` — which is exactly what the indexer does with its own
 * options — must be able to pass it without first branching on it.
 */
export interface OpenProjectOptions {
  /**
   * The absolute path of the project to index.
   *
   * Accepted in either separator style and in POSIX or Windows-rooted form; it
   * is converted to POSIX separators, normalised lexically and stripped of a
   * trailing separator before anything is done with it. A relative path is
   * refused: "inside the project" is not answerable without a root.
   */
  readonly projectRoot: string;

  /**
   * The TypeScript configuration whose `compilerOptions` should apply.
   *
   * Absolute, or relative to {@link OpenProjectOptions.projectRoot}. When
   * omitted, `<projectRoot>/tsconfig.json` is probed and used when it exists.
   * Naming a file that does not exist is an error rather than a fallback — a
   * caller that named it meant it — while omitting the option and having no
   * configuration at all is the documented fallback path.
   */
  readonly tsConfigFilePath?: string | undefined;

  /**
   * Directory names or project-relative directory paths to exclude in addition
   * to {@link EXCLUDED_DIRECTORY_NAMES}.
   *
   * Matched as described on {@link shouldExcludePath}: whole segments, at any
   * depth, never as globs.
   */
  readonly extraExcludes?: readonly string[] | undefined;

  /**
   * Where to report what was loaded and what was refused.
   *
   * Defaults to `noopLogger`, so a library caller that has not chosen a
   * logging backend gets silence rather than console output. Counts, paths of
   * refused environment files and the resolved configuration are logged;
   * file *contents* never are.
   */
  readonly logger?: Logger | undefined;
}

/**
 * An opened project: the ts-morph handle, the bounded file set, and the two
 * path operations every consumer needs.
 *
 * Immutable for its lifetime. The file list was computed when the project was
 * opened and is frozen, so two calls to {@link LoadedProject.sourceFiles}
 * return the same array in the same order — which is what makes an index, its
 * cache key and a test expectation reproducible. Adding a file to
 * {@link LoadedProject.project} afterwards does not change the set; opening the
 * project again is the supported way to pick up a new file.
 */
export interface LoadedProject {
  /**
   * The ts-morph project, for the abstract syntax tree, the type checker and
   * module-specifier resolution.
   *
   * Exposed because the extractors need it. Note that its
   * `getSourceFiles()` is *not* the file set to iterate — it is the raw
   * compiler view, which may hold files this module has judged unindexable —
   * so consumers iterate {@link LoadedProject.sourceFiles} instead.
   */
  readonly project: Project;

  /**
   * The project root as this module normalised it: absolute, POSIX separators,
   * no trailing separator.
   *
   * This is the value to pass back to `toProjectRelative`,
   * `resolveWithinProject` and {@link shouldExcludePath}, and the value to use
   * as part of a cache key — never the string the caller supplied, which may
   * differ from it character for character while naming the same directory.
   */
  readonly projectRoot: string;

  /**
   * The configuration whose `compilerOptions` are in force, or `undefined` when
   * the project was opened with this module's defaults.
   *
   * `undefined` is worth acting on: without a configuration there are no
   * `paths` aliases, so an aliased import resolves to nothing and a consumer
   * that depends on those edges should say so rather than report an empty
   * result.
   */
  readonly tsConfigFilePath: string | undefined;

  /**
   * The indexable files of this project, sorted ascending by project-relative
   * path.
   *
   * Frozen and shared: the same array instance on every call, safe to iterate
   * repeatedly and impossible to reorder from underneath a caller. The sort is
   * a byte-wise string comparison rather than a locale-aware one, so the order
   * is identical on every machine and in every environment.
   *
   * @returns The project's indexable source files, in deterministic order.
   */
  sourceFiles(): readonly SourceFile[];

  /**
   * The project-relative POSIX form of a path inside this project, or
   * `undefined` when the path does not belong to it.
   *
   * The canonical form the rest of the product stores, displays and sends: a
   * graph node's `file`, a `SourceLocation.file`, a cache key's file list. It
   * never throws and never returns an absolute path, so a leaked directory
   * layout is not a failure mode a consumer has to guard against.
   *
   * @param absolutePath The path to reduce.
   * @returns The project-relative path, or `undefined` when the path is outside
   * the project or is not a usable project-relative path.
   */
  projectRelative(absolutePath: string): string | undefined;
}

/**
 * Opens a target project for indexing: reads its configuration, loads the file
 * set this module judges indexable, and returns a handle over both.
 *
 * The sequence, each step a `Result` the next one only runs on success:
 *
 * 1. The root is converted to POSIX separators, normalised and required to be
 *    absolute.
 * 2. The root is required to exist and to be a directory.
 * 3. The configuration is resolved: the named one, or `tsconfig.json` in the
 *    root when it exists, or none.
 * 4. A ts-morph `Project` is constructed — with the configuration's
 *    `compilerOptions` and *without* its file list, or with this module's
 *    defaults when there is no configuration.
 * 5. Files are added from the glob list built here, positive globs for the
 *    indexable extensions and negative globs for every excluded tree,
 *    declaration file, minified bundle and environment file.
 * 6. The resulting set is filtered again, environment files and symbolic links
 *    leaving the project are unloaded from the compiler, and what remains is
 *    sorted and frozen.
 *
 * Nothing a caller can pass makes this function throw. The failures it reports
 * and the codes they carry are listed on the module documentation above; each
 * `DebuggenError` also carries a `details.reason` for a caller that wants to
 * branch, and a `hint` for one that wants to show the developer what to do.
 *
 * @param options The root to open, and how to open it.
 * @returns `Ok` with the handle — including for a project that holds no
 * indexable file — or `Err` with a `DebuggenError`.
 */
export function openProject(options: OpenProjectOptions): Result<LoadedProject> {
  const logger = options.logger ?? noopLogger;
  const extraExcludes = options.extraExcludes ?? EMPTY_EXCLUDES;

  const normalizedRoot = normalizeProjectRoot(options.projectRoot);
  if (isErr(normalizedRoot)) {
    return normalizedRoot;
  }
  const projectRoot = normalizedRoot.value;

  const directory = requireDirectory(projectRoot);
  if (isErr(directory)) {
    return directory;
  }

  const resolvedTsConfig = resolveTsConfigFilePath(projectRoot, options.tsConfigFilePath);
  if (isErr(resolvedTsConfig)) {
    return resolvedTsConfig;
  }
  const tsConfigFilePath = resolvedTsConfig.value;

  const created = createProject(tsConfigFilePath);
  if (isErr(created)) {
    return created;
  }
  const project = created.value;

  if (tsConfigFilePath === undefined) {
    // Worth a line of its own: every later surprise about an unresolved alias
    // import in this project follows from there being no configuration to take
    // `paths` from.
    logger.debug('no TypeScript configuration found; using indexer defaults', { projectRoot });
  }

  const globs = buildSourceFileGlobs(projectRoot, extraExcludes);
  const matched = tryCatch(() => project.addSourceFilesAtPaths(globs), 'CODE_INDEX_FAILED');
  if (isErr(matched)) {
    return err(
      failure(
        'CODE_INDEX_FAILED',
        `The source files of the project at '${projectRoot}' could not be read: ${matched.error.message}`,
        'source-files-unreadable',
        'Check that the project directory and its files are readable, then try again.',
        matched.error,
      ),
    );
  }

  const sourceFiles = retainIndexableSourceFiles({
    project,
    projectRoot,
    realProjectRoot: realPathOrSelf(projectRoot),
    extraExcludes,
    logger,
  });

  logger.debug('project opened', {
    projectRoot,
    tsConfigFilePath,
    matchedFileCount: matched.value.length,
    sourceFileCount: sourceFiles.length,
  });

  if (sourceFiles.length === 0) {
    // Not a failure: a directory a developer opened before writing any code,
    // or a root pointed one level too high, both reach here legitimately. The
    // indexer decides what an empty file set means for the session.
    logger.warn('the project holds no indexable source file', { projectRoot });
  }

  const loaded: LoadedProject = {
    project,
    projectRoot,
    tsConfigFilePath,
    sourceFiles: () => sourceFiles,
    projectRelative: (absolutePath: string) =>
      projectRelativeOrUndefined(projectRoot, absolutePath),
  };

  return ok(Object.freeze(loaded));
}

/** The shared empty list, so the common call site allocates nothing. */
const EMPTY_EXCLUDES: readonly string[] = Object.freeze([]);

/**
 * Converts, normalises and validates the project root.
 *
 * A two-separator prefix is refused rather than normalised: it names a network
 * share, not a local project directory, and collapsing it to one separator
 * would make an off-volume path appear to sit inside the root. Everything else
 * is a straightforward conversion, and the refusal of a relative root is what
 * makes every containment decision below meaningful.
 */
function normalizeProjectRoot(projectRoot: string): Result<string> {
  const posix = toPosix(projectRoot);

  if (posix.startsWith(`${SEPARATOR}${SEPARATOR}`)) {
    return err(
      failure(
        'PATH_OUTSIDE_PROJECT',
        `The project root '${projectRoot}' begins with two separators, which names a network share rather than a local project directory.`,
        'network-share-path',
        'Point the session at a project directory on this machine.',
      ),
    );
  }

  if (!isAbsolutePosix(posix) && !isWindowsAbsolute(posix)) {
    return err(
      failure(
        'PATH_OUTSIDE_PROJECT',
        `The project root '${projectRoot}' is not an absolute path, so the files that belong to the project cannot be established.`,
        'project-root-not-absolute',
        'Pass the absolute path of the project directory.',
      ),
    );
  }

  // Strips a trailing separator (except on the filesystem root), collapses
  // duplicate separators and resolves '.' and '..' lexically, so the value on
  // the handle is the one every later path decision and cache key uses.
  return ok(normalizePosix(posix));
}

/** Requires the root to exist and to be a directory, as a `Result`. */
function requireDirectory(projectRoot: string): Result<undefined> {
  const stats = tryCatch(
    () => statSync(projectRoot, { throwIfNoEntry: false }),
    'PROJECT_NOT_FOUND',
  );

  if (isErr(stats)) {
    return err(
      failure(
        'PROJECT_NOT_FOUND',
        `The project root '${projectRoot}' could not be read: ${stats.error.message}`,
        'project-root-unreadable',
        'Check that the path exists and that this user may read it, then try again.',
        stats.error,
      ),
    );
  }

  if (stats.value === undefined) {
    return err(
      failure(
        'PROJECT_NOT_FOUND',
        `There is no directory at the project root '${projectRoot}'.`,
        'project-root-missing',
        'Open the project folder, then start the session again.',
      ),
    );
  }

  if (!stats.value.isDirectory()) {
    return err(
      failure(
        'PROJECT_NOT_FOUND',
        `The project root '${projectRoot}' is a file rather than a directory.`,
        'project-root-not-a-directory',
        'Pass the directory that holds the project, not a file inside it.',
      ),
    );
  }

  return ok(undefined);
}

/**
 * Resolves which configuration file to take `compilerOptions` from.
 *
 * A named file is resolved against the root when it is relative and must exist:
 * a caller that named one meant it, and silently indexing with defaults instead
 * would drop the target's `paths` aliases and leave a graph that is wrong with
 * no message to explain it. An unnamed one is probed for, and its absence is a
 * success — see the fallback in {@link defaultCompilerOptions}.
 *
 * A named file outside the project root is accepted: sharing one base
 * configuration across a workspace is ordinary, and the file only ever
 * contributes compiler options. The file *set* stays bounded by the root's
 * globs regardless of where the configuration lives.
 */
function resolveTsConfigFilePath(
  projectRoot: string,
  requested: string | undefined,
): Result<string | undefined> {
  if (requested === undefined) {
    const probed = joinPosix(projectRoot, TSCONFIG_BASENAME);
    return ok(isReadableFile(probed) ? probed : undefined);
  }

  const posix = toPosix(requested);
  const resolved =
    isAbsolutePosix(posix) || isWindowsAbsolute(posix)
      ? normalizePosix(posix)
      : joinPosix(projectRoot, posix);

  if (!isReadableFile(resolved)) {
    return err(
      failure(
        'CODE_INDEX_FAILED',
        `The TypeScript configuration '${requested}' does not exist at '${resolved}'.`,
        'tsconfig-missing',
        'Name a configuration file that exists, or omit it to use the one in the project root.',
      ),
    );
  }

  return ok(resolved);
}

/** Whether a path exists and is a regular file, without throwing for either answer. */
function isReadableFile(path: string): boolean {
  const stats = tryCatch(() => statSync(path, { throwIfNoEntry: false }));
  return !isErr(stats) && stats.value !== undefined && stats.value.isFile();
}

/**
 * Constructs the ts-morph project, with the target's compiler options where
 * there are any.
 *
 * Both branches pass the same two options, and each one is load-bearing:
 *
 * - `skipAddingFilesFromTsConfig` keeps the **file set under this module's
 *   control**. Without it the compiler would add whatever the target's
 *   `include`/`files` name — which is written for a build and may be as wide as
 *   the whole directory — and an environment file would be in the program
 *   before any filter of ours ran.
 * - `skipFileDependencyResolution` stops the project from pulling in the files
 *   its sources import. Those live under `node_modules`, are declaration files,
 *   or both; admitting them would enlarge the program by orders of magnitude
 *   and put paths this module has excluded into `project.getSourceFiles()`.
 *
 * What the configuration *is* used for is its `compilerOptions`, and the
 * `paths` aliases in particular: they are what lets an import written
 * `@/<segment>` resolve to the module it names, which is how the import and
 * symbol extractors follow an aliased edge at all.
 *
 * A configuration whose JSON is malformed makes ts-morph throw, and that
 * surfaces as an `Err` rather than a fallback, for the reason given on
 * {@link resolveTsConfigFilePath}.
 */
function createProject(tsConfigFilePath: string | undefined): Result<Project> {
  const created = tryCatch(
    () =>
      tsConfigFilePath === undefined
        ? new Project({
            compilerOptions: defaultCompilerOptions(),
            skipAddingFilesFromTsConfig: true,
            skipFileDependencyResolution: true,
          })
        : new Project({
            tsConfigFilePath,
            skipAddingFilesFromTsConfig: true,
            skipFileDependencyResolution: true,
          }),
    'CODE_INDEX_FAILED',
  );

  if (isErr(created)) {
    if (tsConfigFilePath === undefined) {
      return err(
        failure(
          'CODE_INDEX_FAILED',
          `A TypeScript project could not be created for this directory: ${created.error.message}`,
          'project-creation-failed',
          'Check that the project directory is readable, then try again.',
          created.error,
        ),
      );
    }

    return err(
      failure(
        'CODE_INDEX_FAILED',
        `The TypeScript configuration at '${tsConfigFilePath}' could not be read: ${created.error.message}`,
        'tsconfig-unreadable',
        'Fix the JSON in that configuration file, then start the session again.',
        created.error,
      ),
    );
  }

  return created;
}

/**
 * The compiler options used when the target has no configuration of its own.
 *
 * Conservative and permissive in equal measure, because the project may be
 * anything: a JavaScript-only application, a directory a developer has only
 * begun, or a TypeScript project whose configuration lives somewhere this
 * module was not told about.
 *
 * - `allowJs` with `checkJs` off — JavaScript modules are parsed and indexed,
 *   and are not type-checked, which they would fail through no fault of
 *   anyone's.
 * - `jsx: Preserve` — a `.jsx`/`.tsx` file must parse, and nothing here emits,
 *   so the transform choice is irrelevant beyond keeping the tree intact.
 * - `ES2023` with `ESNext` modules and `Bundler` resolution — the most
 *   permissive combination for reading modern application code, and the one
 *   that resolves an extensionless relative import the way the target's
 *   bundler does.
 * - `skipLibCheck` and `noEmit` — this project exists to be read. Nothing is
 *   emitted, and third-party declaration drift must never turn an index into a
 *   failure.
 *
 * Returned fresh on every call rather than shared: ts-morph keeps the object it
 * is given in a mutable container, and a frozen or shared instance would make
 * one project's settings another's problem.
 */
function defaultCompilerOptions(): CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
  };
}

/**
 * Builds the glob list the project's files are added from.
 *
 * One positive pattern per {@link INDEXABLE_EXTENSIONS} entry, then a negative
 * pattern for every excluded tree, every declaration-file flavour, minified
 * bundles and environment files. Negative patterns matter beyond tidiness: the
 * glob layer never *descends* into an excluded directory, so `node_modules` of
 * a large project is not enumerated rather than enumerated and discarded —
 * which is the difference between an index that takes a second and one that
 * takes a minute.
 *
 * There is no hand-rolled directory walk here on purpose. The glob layer is
 * the part that knows how to traverse a large tree efficiently, and a
 * recursive walk written here would have to reimplement it — including the
 * exclusions, whose whole value is that they prevent traversal.
 *
 * Every pattern is anchored at the project root, and the root is passed through
 * {@link escapeGlobLiteral} first: a directory whose name contains a glob
 * metacharacter — `project (v2)` is the everyday example — otherwise matches
 * *nothing at all*, producing a silently empty index. Each excluded name is
 * escaped for the same reason.
 *
 * @param projectRoot The normalised absolute project root.
 * @param extraExcludes Caller-supplied directory names or project-relative
 * directory paths.
 * @returns The pattern list, positive patterns first.
 */
function buildSourceFileGlobs(
  projectRoot: string,
  extraExcludes: readonly string[],
): readonly string[] {
  const prefix = escapeGlobLiteral(projectRoot);
  const include = (pattern: string): string => joinPosix(prefix, pattern);
  const exclude = (pattern: string): string => `!${joinPosix(prefix, pattern)}`;

  const globs: string[] = [];

  for (const extension of INDEXABLE_EXTENSIONS) {
    globs.push(include(`**/*${extension}`));
  }

  for (const name of [...EXCLUDED_DIRECTORY_NAMES, ...extraExcludes]) {
    const normalized = normalizePosix(toPosix(name)).trim();
    if (normalized.length === 0 || normalized === '.') {
      continue;
    }
    globs.push(exclude(`**/${escapeGlobLiteral(normalized)}/**`));
  }

  for (const suffix of DECLARATION_FILE_SUFFIXES) {
    globs.push(exclude(`**/*${suffix}`));
  }

  globs.push(exclude(`**/*${MINIFIED_SUFFIX}`));

  // The positive patterns above cannot match an environment file — none of them
  // carries an indexable extension, and the glob layer does not match a
  // dot-prefixed segment against a pattern that does not ask for one. Both
  // patterns are stated anyway, because the guarantee this module exists to
  // hold must not rest on a third-party matcher's default.
  globs.push(exclude(`**/${ENV_BASENAME}`), exclude(`**/${ENV_PREFIX}*`));

  return globs;
}

/**
 * Neutralises the glob metacharacters of a literal path segment or path.
 *
 * Each metacharacter becomes a single-character class — `(` becomes `[(]` —
 * which is the only escaping form that survives the normalisation ts-morph's
 * glob layer applies to a pattern (see {@link GLOB_METACHARACTERS}, which also
 * records why `!` and `^` are left alone).
 *
 * @param literal A path or path fragment to be used literally inside a pattern.
 * @returns The same text, safe to concatenate into a glob.
 */
function escapeGlobLiteral(literal: string): string {
  return literal.replace(GLOB_METACHARACTERS, (character) => `[${character}]`);
}

/** Everything {@link retainIndexableSourceFiles} needs to judge a file. */
interface RetainOptions {
  /** The project whose loaded files are being judged. */
  readonly project: Project;

  /** The normalised absolute project root. */
  readonly projectRoot: string;

  /**
   * The project root with every symbolic link resolved, or the root itself when
   * it could not be resolved.
   *
   * Needed because a root may legitimately be reached through a link — a
   * checkout under a linked home directory, or a temporary directory on a
   * platform that links its temporary path — and a file's resolved path would
   * then sit under the *real* root while the project speaks of the link. A
   * containment test against the link alone would refuse every file in such a
   * project.
   */
  readonly realProjectRoot: string;

  /** Caller-supplied exclusions, already defaulted. */
  readonly extraExcludes: readonly string[];

  /** Where refusals are reported. */
  readonly logger: Logger;
}

/**
 * The defence-in-depth filter: re-judges every file the glob layer loaded and
 * returns the deterministic, frozen file set the handle exposes.
 *
 * Why it exists even though the globs already exclude: a glob list is a piece
 * of string-building, and string-building can be wrong. This pass asks the
 * predicates directly — {@link shouldExcludePath} and
 * {@link isIndexableFile} — of every path the compiler actually holds, so a
 * mistake in a pattern costs an entry in the log instead of a leak.
 *
 * Two classes of refusal go further than dropping the file from the set, and
 * are *unloaded from the compiler* with `removeSourceFile`, which also releases
 * the content ts-morph read:
 *
 * - **Environment files.** The privacy guarantee of this package. Reported at
 *   `warn`, because reaching this branch means a pattern failed and somebody
 *   should look.
 * - **Symbolic links whose target leaves the project.** A link inside the root
 *   is indistinguishable from an ordinary file to a string-level containment
 *   check, so a link named like a module can point anywhere on the filesystem.
 *   The link is resolved and required to stay inside the project; one that does
 *   not is unloaded and reported at `warn`.
 *
 * Everything else that is refused — a path under an excluded tree, a
 * declaration file, a minified bundle — is simply absent from the returned set
 * and counted at `debug`. Those files are not a privacy matter, and leaving
 * them in the compiler's program costs nothing while keeping the program
 * consistent with whatever module resolution already decided.
 *
 * @param options The project, its root and where to report.
 * @returns The frozen, sorted set of indexable source files.
 */
function retainIndexableSourceFiles(options: RetainOptions): readonly SourceFile[] {
  const { project, projectRoot, realProjectRoot, extraExcludes, logger } = options;

  const kept: { readonly relativePath: string; readonly sourceFile: SourceFile }[] = [];
  const unload: SourceFile[] = [];
  const envFiles: string[] = [];
  let escapingLinkCount = 0;
  let excludedCount = 0;

  for (const sourceFile of project.getSourceFiles()) {
    const filePath: string = sourceFile.getFilePath();

    if (isEnvFilePath(filePath)) {
      envFiles.push(projectRelativeOrUndefined(projectRoot, filePath) ?? filePath);
      unload.push(sourceFile);
      continue;
    }

    const relative = toProjectRelative(projectRoot, filePath);
    if (
      isErr(relative) ||
      shouldExcludePath(projectRoot, filePath, extraExcludes) ||
      !isIndexableFile(filePath)
    ) {
      excludedCount += 1;
      continue;
    }

    if (escapesProjectThroughSymlink(filePath, projectRoot, realProjectRoot)) {
      escapingLinkCount += 1;
      unload.push(sourceFile);
      continue;
    }

    kept.push({ relativePath: relative.value, sourceFile });
  }

  if (unload.length > 0) {
    // One guard for the whole loop: `removeSourceFile` is not expected to
    // throw, and an opened project must not become an exception if it ever
    // does. The files are absent from the returned set either way.
    const removed = tryCatch(() => {
      for (const sourceFile of unload) {
        project.removeSourceFile(sourceFile);
      }
    });
    if (isErr(removed)) {
      logger.warn('refused files could not be unloaded from the project', {
        projectRoot,
        count: unload.length,
        message: removed.error.message,
      });
    }
  }

  if (envFiles.length > 0) {
    logger.warn(
      'environment files were refused and unloaded: the indexer never reads them (privacy model)',
      { projectRoot, count: envFiles.length, files: envFiles },
    );
  }

  if (escapingLinkCount > 0) {
    logger.warn('symbolic links leaving the project were refused and unloaded', {
      projectRoot,
      count: escapingLinkCount,
    });
  }

  if (excludedCount > 0) {
    logger.debug('files were excluded from the code index', {
      projectRoot,
      count: excludedCount,
    });
  }

  kept.sort((left, right) => comparePaths(left.relativePath, right.relativePath));

  return Object.freeze(kept.map((entry) => entry.sourceFile));
}

/**
 * Whether a project-relative path passes through, or is, one of the named
 * directories.
 *
 * Matching is on whole segments, at any depth, which is what makes both forms
 * of entry work: a bare name (`'coverage'`) and a project-relative path
 * (`'src/generated'`). The path is padded with separators on both sides so that
 * a run of segments is found the same way wherever it sits, and so that a
 * partial segment never matches — `'src/generated'` does not exclude
 * `src/generated-docs/index.ts`.
 *
 * An entry is normalised before use, so `'./src/generated/'` and
 * `'src\\generated'` behave as `'src/generated'` does, and an entry that
 * normalises to nothing meaningful is ignored rather than matching everything.
 *
 * @param relativePath A project-relative POSIX path.
 * @param names Directory names or project-relative directory paths.
 * @returns `true` when the path lies under one of them.
 */
function matchesExcludedDirectory(relativePath: string, names: readonly string[]): boolean {
  if (names.length === 0) {
    return false;
  }

  const padded = `${SEPARATOR}${relativePath}${SEPARATOR}`;

  for (const name of names) {
    const normalized = normalizePosix(toPosix(name));
    if (normalized.length === 0 || normalized === '.') {
      continue;
    }
    if (padded.includes(`${SEPARATOR}${normalized}${SEPARATOR}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Compares two project-relative paths byte-wise.
 *
 * Deliberately not `localeCompare`: its order depends on the host's locale and
 * on the platform's collation data, so two machines — a developer's and a
 * continuous-integration runner's — would produce different file orders, and
 * with them different index envelopes, different cache keys and a test that
 * passes in one place and fails in the other. A code-unit comparison is the
 * same everywhere.
 *
 * @param left The first path.
 * @param right The second path.
 * @returns A negative number, zero or a positive number, as a sort comparator.
 */
function comparePaths(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * The project-relative form of a path, or `undefined` when it does not belong
 * to the project.
 *
 * The `Result`-to-`undefined` adapter behind
 * {@link LoadedProject.projectRelative}: a consumer asking "what is this file
 * called inside the project?" wants an answer or nothing, not an error value to
 * branch on, and the reasons a path is refused are already documented on
 * `toProjectRelative`.
 */
function projectRelativeOrUndefined(projectRoot: string, absolutePath: string): string | undefined {
  const relative = toProjectRelative(projectRoot, absolutePath);
  return isErr(relative) ? undefined : relative.value;
}

/**
 * The path with every symbolic link resolved, or the path itself when it cannot
 * be resolved.
 *
 * Used once per opened project, for the root. A failure here is not
 * interesting: the root has already been confirmed to be a directory, and the
 * unresolved value is a usable containment base on its own.
 */
function realPathOrSelf(path: string): string {
  const real = tryCatch(() => realpathSync(path));
  return isErr(real) ? path : normalizePosix(toPosix(real.value));
}

/**
 * Whether a file inside the project is a symbolic link whose target lies
 * outside it.
 *
 * The string-level containment gate cannot see this: a link at
 * `src/<name>.ts` is, as a path, inside the project, and only resolving it
 * reveals where it actually reads from. Indexing such a file would put content
 * from outside the project — potentially from anywhere the developer's user can
 * read — into the graph, the summary and, through a later stage, a prompt.
 *
 * The check is arranged so the common case costs a single `lstat` and nothing
 * else: a file that is not a link is accepted immediately, and only a link is
 * resolved. A link that cannot be resolved at all is refused, which is the
 * fail-closed direction — a broken or cyclic link has no content worth
 * indexing. A file that has vanished between the glob and this pass is
 * accepted: ts-morph already holds its content, and its path is inside the
 * project.
 *
 * Containment is tested against both the project root and its resolved form,
 * because a project reached through a link would otherwise have every one of
 * its files refused.
 */
function escapesProjectThroughSymlink(
  filePath: string,
  projectRoot: string,
  realProjectRoot: string,
): boolean {
  const link = tryCatch(() => lstatSync(filePath, { throwIfNoEntry: false }));
  if (isErr(link) || link.value === undefined || !link.value.isSymbolicLink()) {
    return false;
  }

  const real = tryCatch(() => realpathSync(filePath));
  if (isErr(real)) {
    return true;
  }

  const resolved = normalizePosix(toPosix(real.value));
  return !isWithin(projectRoot, resolved) && !isWithin(realProjectRoot, resolved);
}

/**
 * Builds the `DebuggenError` this module reports a refusal with.
 *
 * Every failure of this module goes through here, so all of them carry the same
 * three things: a code from the product's closed vocabulary — never an invented
 * string — a `details.reason` a caller can branch on without parsing the
 * message, and a hint that names the developer's next step rather than
 * restating the failure.
 *
 * @param code The failure being reported.
 * @param message A complete sentence describing what failed.
 * @param reason The machine-readable discriminator for this failure.
 * @param hint What the developer should do about it.
 * @param cause The underlying thrown value, where there was one.
 * @returns The error, ready to be wrapped in `err`.
 */
function failure(
  code: DebuggenErrorCode,
  message: string,
  reason: string,
  hint: string,
  cause?: unknown,
): DebuggenError {
  return new DebuggenError(code, message, { hint, details: { reason }, cause });
}
