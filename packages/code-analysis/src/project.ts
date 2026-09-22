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
 * 1. **The file set is this module's, not the target's.** The target's
 *    configuration is parsed here for its `compilerOptions` alone, with a
 *    parser that is given no filesystem to expand against, and the `Project` is
 *    constructed from those options rather than from the configuration's path.
 *    So however permissive the target's `include`/`files` are — `["**\/*"]` is
 *    legal and not rare — neither the compiler nor its configuration parser
 *    contributes a single file. Every file the project holds was added by
 *    {@link openProject} from the traversal below.
 * 2. **The traversal excludes by construction, and never follows a directory
 *    link.** {@link discoverCandidatePaths} walks the project itself with
 *    `readdir`, descending only into an entry whose own directory entry says it
 *    *is* a directory — which a symbolic link's entry never does. An
 *    {@link EXCLUDED_DIRECTORY_NAMES} tree, an `extraExcludes` tree and every
 *    hidden (dot-prefixed) entry are recognised at their own entry and are
 *    never enumerated, so a large `node_modules` costs one rejected entry
 *    rather than a hundred thousand paths.
 * 3. **Nothing is read until it has been screened.** Discovery and loading are
 *    two steps rather than one: the traversal produces candidate *paths* and
 *    reads no content, every candidate is then judged by a single screen
 *    ({@link screenCandidatePath}), and only a candidate the screen calls
 *    indexable is handed to the compiler. A mistake upstream is therefore a
 *    logged refusal rather than a leak, because the refusal happens before the
 *    bytes are touched.
 *
 * ## Why the traversal is this module's, and why the screen still resolves
 *
 * A path that is lexically inside the project can read from anywhere the
 * developer's account can. A symlinked *directory* (`<root>/vendor -> /etc`)
 * presents an entire external tree under the root, every one of whose files has
 * an ordinary final component; a symlinked *file*
 * (`<root>/src/config.ts -> <root>/.env`) carries an indexable basename while
 * its content is an environment file. Neither is visible to a string
 * containment test, and neither is visible to a check that only asks whether
 * the final component is itself a link.
 *
 * Handing the traversal to a glob layer does not avoid the first case, it
 * merely hides where it happens — measured on the supported runtime, not
 * assumed: ts-morph's file-system host globs through `tinyglobby` with symlink
 * following at its default and descends into a linked directory outright,
 * while Node's built-in `fs.globSync` descends into one whose own name matches
 * a pattern component. By the time either has answered, the external tree has
 * been enumerated. So this module walks the project, and the no-follow
 * guarantee is structural rather than a matcher's option.
 *
 * The screen then resolves **every component** of each candidate with
 * `realpath` and judges the resolved path as well as the candidate: the real
 * path must sit under the *canonical* project root, must be a regular file, and
 * must pass {@link isEnvFilePath}, {@link shouldExcludePath} and
 * {@link isIndexableFile} in its own right. Resolution failure — a dangling
 * link, a link cycle, a directory this account may not traverse — is a
 * refusal, not an acceptance: a file whose provenance cannot be established is
 * not indexed. A link whose target is an ordinary source file *inside* the
 * project stays indexed, which is what keeps the screen from refusing the
 * legitimate case.
 *
 * The same screen runs a second time over what the compiler actually holds
 * (see {@link retainIndexableSourceFiles}), so the guarantee does not depend on
 * every future call site remembering to ask.
 *
 * The sibling `project.test.ts` exercises all three mechanisms, including a
 * target whose `tsconfig.json` has been widened to `include: ["**\/*"]`, a
 * directory link whose contents are proven never to be enumerated, a regular
 * file reached through a symlinked directory outside the root, and a link to
 * the project's own `.env`. Treat a failure there as a security regression, not
 * a broken unit test.
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
 * "Rejecting the file list" is meant literally: the list is never computed.
 * Handing a configuration path to the `Project` constructor would have
 * TypeScript expand the configuration's globs across the tree — following
 * directory links while it does — and only then discard the result, so
 * {@link readCompilerOptions} parses the configuration with a host whose
 * `readDirectory` answers nothing at all. See that function for what the
 * expansion costs when a directory link is in the way.
 *
 * ## Behaviour worth knowing before you call this
 *
 * - **Failures are values.** `openProject` returns `Result<LoadedProject>` and
 *   throws for nothing a caller can provoke: a relative root, a missing root, a
 *   root that is a file, a malformed or absent `tsconfig.json`, an unreadable
 *   file, a root whose own real location cannot be established — each comes
 *   back as an `Err` carrying a `DebuggenError` with one of
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
 * - **Hidden entries are not indexed.** The traversal skips any entry whose
 *   name begins with a dot, at any depth, which is why `.next`, `.turbo`,
 *   `.cache`, `.git` and every `.env*` are excluded twice over — and why a
 *   source file parked under any other hidden directory is invisible to the
 *   indexer. This used to be a glob matcher's `dot: false` default; it is now
 *   a rule of this module ({@link HIDDEN_PREFIX}), so the behaviour no longer
 *   depends on a third-party default.
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

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';

import {
  DebuggenError,
  basenamePosix,
  dirnamePosix,
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

/**
 * The prefix of a hidden filesystem entry, which is never indexed at any depth.
 *
 * This is a rule rather than a side effect. It used to arrive from a glob
 * matcher's `dot: false` default — a pattern that does not ask for a
 * dot-prefixed segment does not match one — and the module's documentation has
 * always stated the resulting behaviour: `.git`, `.next`, `.turbo` and `.cache`
 * are excluded twice over, and a source file parked under any other hidden
 * directory is invisible to the indexer. Now that {@link discoverCandidatePaths}
 * owns the traversal, the rule is stated here so the behaviour does not depend
 * on a third-party default, and so every `.env*` file is skipped before its
 * name is even judged.
 */
const HIDDEN_PREFIX = '.';

/** The configuration file {@link openProject} probes for when none is named. */
const TSCONFIG_BASENAME = 'tsconfig.json';

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

  /**
   * A discovery of this project's files from {@link discoverProjectFiles}, so
   * the tree is walked once rather than twice.
   *
   * The path `./indexer.ts` takes: it discovers the file set first in order to
   * fingerprint it and look the result up in the index cache, and on a miss it
   * hands the discovery it already holds to this function instead of paying
   * for a second `readdir` of every directory in the project.
   *
   * Used **only when it describes the same discovery inputs** as this call —
   * the same normalised root, the same canonical root, the same resolved
   * configuration path and the same {@link OpenProjectOptions.extraExcludes} —
   * and otherwise ignored with one `warn` and replaced by a fresh walk. It is
   * an optimisation and never a widening: every path it names is screened again
   * — by {@link screenCandidatePath}, against the canonical root *this* call
   * resolved — before a single one of them is read, which is the module
   * documentation's third mechanism and is not weakened here. So a stale or
   * hand-built discovery can make this function slower, or its file set
   * smaller, and never less safe.
   */
  readonly discovered?: DiscoveredProject | undefined;
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
 * 5. The root's canonical form is resolved once, and becomes the base every
 *    containment decision is made against.
 * 6. Candidate paths are discovered by walking the project without following a
 *    directory link and without descending into an excluded or hidden entry.
 *    The traversal reads no file content.
 * 7. Every candidate is screened (lexically, then through `realpath`), and only
 *    a candidate that survives is loaded into the compiler.
 * 8. What the compiler holds is screened again, environment files and files
 *    whose real path leaves the project are unloaded from it, and what remains
 *    is sorted and frozen.
 *
 * Steps 6 and 7's first half are exactly {@link discoverProjectFiles}, and a
 * caller that has already run it — `./indexer.ts` does, to fingerprint the file
 * set for the index cache before anything is parsed — passes the result as
 * {@link OpenProjectOptions.discovered} and the walk is not repeated. Steps 1
 * to 5 still run here, in this order, so a malformed configuration is still
 * refused before the tree is touched and containment is still decided against a
 * root resolved by *this* call; the supplied discovery is used only when it
 * agrees with all of that, and every path in it is screened again before it is
 * read.
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

  const identity = resolveProjectIdentity(options.projectRoot, options.tsConfigFilePath);
  if (isErr(identity)) {
    return identity;
  }
  const { projectRoot, tsConfigFilePath } = identity.value;

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

  // Resolved once, before anything is discovered, and the base every
  // containment decision below is made against. A root reached through a
  // symbolic link (a checkout under a linked home directory, a temporary
  // directory on a platform that links its temporary path) is ordinary, so the
  // *canonical* root is what files are required to sit under while the handle
  // keeps speaking of the path the caller passed.
  const canonicalRoot = resolveCanonicalRoot(projectRoot);
  if (isErr(canonicalRoot)) {
    return canonicalRoot;
  }
  const canonicalProjectRoot = canonicalRoot.value;

  // Discovery yields candidate *paths* only and never follows a directory
  // link, so a tree outside the project is not even enumerated, let alone
  // read. A caller that has already discovered this project supplies the
  // result and the walk is skipped; the paths are screened again below either
  // way.
  const discovered = discoveredCandidatePaths({
    discovered: options.discovered,
    projectRoot,
    canonicalProjectRoot,
    tsConfigFilePath,
    extraExcludes,
    logger,
  });
  if (isErr(discovered)) {
    return discovered;
  }

  const admitted = admitScreenedSourceFiles({
    project,
    candidatePaths: discovered.value,
    projectRoot,
    canonicalProjectRoot,
    extraExcludes,
    logger,
  });
  if (isErr(admitted)) {
    return admitted;
  }

  const sourceFiles = retainIndexableSourceFiles({
    project,
    projectRoot,
    canonicalProjectRoot,
    extraExcludes,
    logger,
  });

  logger.debug('project opened', {
    projectRoot,
    tsConfigFilePath,
    candidateFileCount: discovered.value.length,
    loadedFileCount: admitted.value,
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

/**
 * What a project looks like before a single byte of it has been read: its
 * identity, and the indexable files this module is willing to read.
 *
 * The cheap half of {@link openProject}, split out so that a caller which only
 * needs to know *which files there are* — `./indexer.ts`, fingerprinting the
 * file set to look an index up in the cache — does not have to pay for the
 * expensive half, which is constructing a ts-morph program and parsing every
 * one of those files. Produced by {@link discoverProjectFiles} and accepted
 * back by {@link OpenProjectOptions.discovered}, so the walk that produced it
 * is not repeated when the project does have to be opened after all.
 *
 * Immutable: the record and both path lists are frozen, and `extraExcludes` is
 * a frozen copy rather than the caller's array, so a discovery cannot change
 * under a consumer that is still fingerprinting it.
 */
export interface DiscoveredProject {
  /**
   * The project root as this module normalised it: absolute, POSIX
   * separators, no trailing separator.
   *
   * The same value {@link LoadedProject.projectRoot} would carry for this
   * root, which is what makes a cache key computed from a discovery and one
   * computed from an opened project agree.
   */
  readonly projectRoot: string;

  /**
   * The project root with every symbolic link resolved — the base containment
   * was decided against; see {@link resolveCanonicalRoot}.
   */
  readonly canonicalProjectRoot: string;

  /**
   * The configuration whose `compilerOptions` *would* apply, or `undefined`
   * when the project has none.
   *
   * Resolved — the named file, or `tsconfig.json` in the root when it exists —
   * but deliberately **not parsed**: parsing it is the first step of building a
   * program, and a discovery builds no program. So a configuration that exists
   * but is malformed is reported by {@link openProject} and not here.
   */
  readonly tsConfigFilePath: string | undefined;

  /**
   * The exclusions the walk was performed with, beyond
   * {@link EXCLUDED_DIRECTORY_NAMES}.
   *
   * Carried so that {@link openProject} can tell whether a discovery it was
   * handed describes the file set it is about to load; a different exclusion
   * list is a different file set.
   */
  readonly extraExcludes: readonly string[];

  /**
   * The indexable files, absolute and POSIX, sorted ascending by
   * project-relative path.
   *
   * Every one of them has passed {@link screenCandidatePath} — so no
   * environment file, no path whose real location leaves the project and no
   * path whose real location could not be established is in this list — and
   * none of them has been opened. Same length and same order as
   * {@link DiscoveredProject.relativeFiles}, and the same order
   * {@link LoadedProject.sourceFiles} would return them in.
   */
  readonly files: readonly string[];

  /**
   * The same files in project-relative POSIX form, in the same order.
   *
   * The form every fingerprint, graph node and `SourceLocation` spells a file
   * in, so a consumer that is building a cache key needs no path arithmetic of
   * its own — and never has to handle an absolute developer path, which is the
   * one form this package does not export.
   */
  readonly relativeFiles: readonly string[];
}

/** How {@link discoverProjectFiles} should walk a project. */
export interface DiscoverProjectFilesOptions {
  /** The absolute path of the project, as {@link OpenProjectOptions.projectRoot}. */
  readonly projectRoot: string;

  /**
   * The configuration to resolve, as {@link OpenProjectOptions.tsConfigFilePath}.
   *
   * Resolved and required to exist exactly as it is there, because a caller
   * that named a configuration which is not present has an error to be told
   * about whether or not a program is going to be built from it.
   */
  readonly tsConfigFilePath?: string | undefined;

  /** Extra exclusions, as {@link OpenProjectOptions.extraExcludes}. */
  readonly extraExcludes?: readonly string[] | undefined;

  /** Where the walk's refusals and counts go; defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;
}

/**
 * Establishes a project's identity and its indexable file set **without
 * constructing a program or reading a file**.
 *
 * ## Why this exists
 *
 * The index cache's key is derived from the project's identity and one
 * fingerprint — path, modification time, size — per indexable file, and none of
 * that needs a parsed program. Before this function existed, the only way to
 * get the file set was {@link openProject}, so `./indexer.ts` had to build the
 * whole ts-morph program before it could compute the key it was going to use to
 * decide whether it needed the program at all. A cache hit paid for everything
 * the cache exists to avoid. Now the indexer discovers, fingerprints, looks up,
 * and only opens the project when the lookup misses.
 *
 * ## What it does, and what it deliberately does not
 *
 * It runs {@link openProject}'s steps 1, 2, 3, 5, 6 and 7 — normalise the root,
 * require a directory, resolve the configuration path, resolve the canonical
 * root, walk the tree without following a directory link, and screen every
 * candidate through {@link screenCandidatePath} with the same refusal tally and
 * the same log records. It does **not** construct a `Project`, does not parse
 * the configuration, and does not read one byte of any file's content: the only
 * syscalls are `readdir`, `realpath` and `stat`.
 *
 * Because it now runs *first*, it is also the first thing that touches the
 * developer's tree, and the privacy guarantee this module exists for is
 * therefore enforced here as well as in the loading path: an environment file,
 * a path whose real location leaves the project and a path whose real location
 * cannot be established are refused before anything downstream can ask for
 * their contents.
 *
 * ## Failures
 *
 * Exactly the ones {@link openProject} reports for the same inputs, with the
 * same codes, the same `details.reason` and the same hints: a relative or
 * network-share root, a root that is absent, unreadable or not a directory, a
 * named configuration that does not exist, a root whose real location cannot be
 * established, and a root whose top level cannot be listed. A caller that
 * propagates this `Err` is indistinguishable from one that propagated
 * `openProject`'s, which is what lets the indexer consult the cache first
 * without changing the failures it reports.
 *
 * @param options The root to walk, and how to walk it.
 * @returns `Ok` with the discovery — including for a project with no indexable
 * file — or `Err` with a `DebuggenError`.
 *
 * @example
 * ```ts
 * const discovered = discoverProjectFiles({ projectRoot, logger });
 * if (isErr(discovered)) {
 *   return discovered; // propagate unchanged; openProject would have said the same
 * }
 * // …fingerprint discovered.value.relativeFiles, consult the cache, and only
 * // then: openProject({ projectRoot, logger, discovered: discovered.value })
 * ```
 */
export function discoverProjectFiles(
  options: DiscoverProjectFilesOptions,
): Result<DiscoveredProject> {
  const logger = options.logger ?? noopLogger;
  const extraExcludes = options.extraExcludes ?? EMPTY_EXCLUDES;

  const identity = resolveProjectIdentity(options.projectRoot, options.tsConfigFilePath);
  if (isErr(identity)) {
    return identity;
  }
  const { projectRoot, tsConfigFilePath } = identity.value;

  const canonicalRoot = resolveCanonicalRoot(projectRoot);
  if (isErr(canonicalRoot)) {
    return canonicalRoot;
  }

  return walkAndScreenProject({
    projectRoot,
    canonicalProjectRoot: canonicalRoot.value,
    tsConfigFilePath,
    extraExcludes,
    logger,
  });
}

/** The shared empty list, so the common call site allocates nothing. */
const EMPTY_EXCLUDES: readonly string[] = Object.freeze([]);

/** A project's two decided identity values: where it is, and what configures it. */
interface ProjectIdentity {
  /** The normalised absolute project root. */
  readonly projectRoot: string;

  /** The resolved configuration path, or `undefined` when the project has none. */
  readonly tsConfigFilePath: string | undefined;
}

/**
 * The first three steps of opening a project: normalise the root, require it to
 * be a directory, resolve the configuration path.
 *
 * One function rather than three inline calls in two places, so
 * {@link openProject} and {@link discoverProjectFiles} ask the same questions
 * in the same order and report the same three failures — a relative or
 * network-share root, a root that is absent, unreadable or not a directory, and
 * a named configuration that does not exist — in the same precedence. A second
 * spelling of this sequence is exactly how the two entry points would come to
 * disagree about which error a caller sees.
 *
 * Nothing here reads a file's contents or walks the tree: two `stat` calls at
 * most.
 *
 * @param projectRoot The root as the caller spelled it.
 * @param requestedTsConfig The configuration the caller named, if any.
 * @returns The identity, or the first step's `Err`.
 */
function resolveProjectIdentity(
  projectRoot: string,
  requestedTsConfig: string | undefined,
): Result<ProjectIdentity> {
  const normalizedRoot = normalizeProjectRoot(projectRoot);
  if (isErr(normalizedRoot)) {
    return normalizedRoot;
  }

  const directory = requireDirectory(normalizedRoot.value);
  if (isErr(directory)) {
    return directory;
  }

  const resolvedTsConfig = resolveTsConfigFilePath(normalizedRoot.value, requestedTsConfig);
  if (isErr(resolvedTsConfig)) {
    return resolvedTsConfig;
  }

  return ok({ projectRoot: normalizedRoot.value, tsConfigFilePath: resolvedTsConfig.value });
}

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
 *   control**. It is stated even though no configuration is handed to the
 *   constructor any more (see below), so that a change which reintroduces one
 *   cannot silently hand the file set back to the target.
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
 * ## Why the options are read here instead of by the constructor
 *
 * `new Project({ tsConfigFilePath })` hands the path to TypeScript's
 * configuration parser, which **expands the configuration's `include` globs
 * across the project tree** — following directory links as it goes — before
 * `skipAddingFilesFromTsConfig` throws the resulting file list away. That
 * expansion is both the traversal this module exists to own and a real hazard:
 * measured on this runtime, a single directory link to a large pseudo-filesystem
 * turned a 15-millisecond open into a 7-second one, and a link to a big tree
 * scales with the tree rather than with the project.
 *
 * So the options are parsed here with a host whose `readDirectory` returns
 * nothing. The parser still resolves `extends` chains, still makes `paths` and
 * `baseUrl` absolute against the configuration's own directory, and still
 * reports a malformed file — it simply never asks the filesystem what the
 * configuration matches, because this module already knows what it is willing
 * to read.
 *
 * A configuration whose JSON is malformed is an `Err` rather than a fallback,
 * for the reason given on {@link resolveTsConfigFilePath}. Diagnostics about
 * the *options themselves* are deliberately not fatal: a target written for a
 * newer compiler may name an option this one does not know, and refusing to
 * index a project over an unknown option would be a fault of ours rather than
 * theirs.
 */
function createProject(tsConfigFilePath: string | undefined): Result<Project> {
  const compilerOptions =
    tsConfigFilePath === undefined
      ? ok(defaultCompilerOptions())
      : readCompilerOptions(tsConfigFilePath);
  if (isErr(compilerOptions)) {
    return compilerOptions;
  }

  const created = tryCatch(
    () =>
      new Project({
        compilerOptions: compilerOptions.value,
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true,
      }),
    'CODE_INDEX_FAILED',
  );

  if (isErr(created)) {
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

  return created;
}

/**
 * Reads a target configuration's `compilerOptions` without letting it enumerate
 * anything.
 *
 * The host below is the whole point: `readDirectory` answers with an empty list,
 * so the parser resolves options, `extends` chains and relative paths while the
 * filesystem is never walked on the configuration's behalf. `fileExists` and
 * `readFile` are real, because an `extends` chain has to be followed to know
 * what the options are, and a configuration that extends a file it cannot read
 * is a configuration this module must report rather than guess at.
 *
 * Failure is reported exactly as the previous constructor-driven path reported
 * it — `CODE_INDEX_FAILED` with `details.reason` `tsconfig-unreadable` — so a
 * caller branching on the reason is unaffected.
 *
 * @param tsConfigFilePath The absolute path of the configuration to read.
 * @returns `Ok` with the resolved options, or `Err` when the file cannot be
 * read or parsed.
 */
function readCompilerOptions(tsConfigFilePath: string): Result<CompilerOptions> {
  const unreadable = (detail: string, cause?: unknown): Result<CompilerOptions> =>
    err(
      failure(
        'CODE_INDEX_FAILED',
        `The TypeScript configuration at '${tsConfigFilePath}' could not be read: ${detail}`,
        'tsconfig-unreadable',
        'Fix the JSON in that configuration file, then start the session again.',
        cause,
      ),
    );

  const readFile = (path: string): string | undefined => {
    const contents = tryCatch(() => readFileSync(path, 'utf8'));
    return isErr(contents) ? undefined : contents.value;
  };

  const read = tryCatch(() => ts.readConfigFile(tsConfigFilePath, readFile), 'CODE_INDEX_FAILED');
  if (isErr(read)) {
    return unreadable(read.error.message, read.error);
  }
  if (read.value.error !== undefined) {
    return unreadable(ts.flattenDiagnosticMessageText(read.value.error.messageText, ' '));
  }

  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    // The mechanism this function exists for: the configuration's `include`,
    // `files` and `exclude` are resolved against nothing, so no directory is
    // read and no directory link is followed on its behalf.
    readDirectory: () => [],
    fileExists: (path: string) => isReadableFile(path),
    readFile,
  };

  const parsed = tryCatch(
    () =>
      ts.parseJsonConfigFileContent(
        read.value.config,
        host,
        dirnamePosix(tsConfigFilePath),
        undefined,
        tsConfigFilePath,
      ),
    'CODE_INDEX_FAILED',
  );
  if (isErr(parsed)) {
    return unreadable(parsed.error.message, parsed.error);
  }

  return ok(parsed.value.options);
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

/** What {@link discoverCandidatePaths} needs to enumerate a project. */
interface DiscoverOptions {
  /** The normalised absolute project root, as the caller spelled it. */
  readonly projectRoot: string;

  /** The project root with every symbolic link resolved — the containment base. */
  readonly canonicalProjectRoot: string;

  /** Caller-supplied exclusions, already defaulted. */
  readonly extraExcludes: readonly string[];

  /** Where pruned links and unreadable directories are reported. */
  readonly logger: Logger;
}

/**
 * Enumerates the project's candidate files without ever following a directory
 * link, and without reading a single byte of any of them.
 *
 * ## Why this module owns the traversal
 *
 * Every glob layer available here follows a symbolic link somewhere, and a
 * followed directory link is not a cosmetic difference: the entries of an
 * arbitrary external tree — another checkout, a home directory, a mount — are
 * enumerated into a candidate list, and whatever screens that list afterwards
 * is already too late to have prevented the traversal. Both mechanisms were
 * measured on the supported runtime rather than assumed:
 *
 * - ts-morph's file-system host globs through `tinyglobby` with
 *   `followSymbolicLinks` at its default, which descends into a linked
 *   directory outright.
 * - Node's built-in `fs.globSync` does not descend into a link reached by
 *   `**`, but *does* descend into one whose own name matches a pattern
 *   component — a directory link named `<name>.ts` is crawled — and it returns
 *   matching directories as results alongside files.
 *
 * Neither can be configured out of that behaviour from here, and adding a
 * third-party matcher to this package is not available to it. So the walk is
 * this module's, and the no-follow guarantee is structural: a directory is
 * descended into only when its own directory entry says it *is* a directory,
 * which a symbolic link's entry never does, whatever it points at and whatever
 * it is named.
 *
 * ## What it costs, and what it keeps
 *
 * One `readdir` per real directory, which is what any traversal costs, and the
 * property the previous negative globs existed for is kept: an excluded tree is
 * recognised at its own directory entry and is never enumerated, so
 * `node_modules` of a large project costs one rejected entry rather than a
 * hundred thousand paths. Exclusion is decided by the same predicates the
 * screen uses ({@link shouldExcludePath}, {@link isIndexableFile},
 * {@link isEnvFilePath}) rather than by a parallel list of patterns, so there
 * is no second spelling of the rule to drift.
 *
 * A dot-prefixed entry is skipped at any depth. That is not incidental
 * tidiness: it is the behaviour the glob layer's `dot: false` default used to
 * supply, which this module's documentation states and which keeps `.git`,
 * `.next`, `.turbo` and every `.env*` out of the candidate list a second time
 * over.
 *
 * ## Failures
 *
 * The root must be readable — a project whose top level cannot be listed is an
 * `Err`, as it was when the glob layer failed. A directory *below* the root
 * that cannot be listed is counted and reported rather than fatal: one
 * unreadable subdirectory in a large tree is a reason to index the rest, and
 * the report names it.
 *
 * @param options The project's two roots, the exclusions and where to report.
 * @returns `Ok` with absolute candidate paths spelled under
 * {@link DiscoverOptions.projectRoot}, or `Err` when the root is unreadable.
 */
function discoverCandidatePaths(options: DiscoverOptions): Result<readonly string[]> {
  const { projectRoot, canonicalProjectRoot, extraExcludes, logger } = options;

  const candidates: string[] = [];
  const directoryLinks: string[] = [];
  const prunedLinks: string[] = [];
  const unreadable: string[] = [];
  let prunedDirectoryCount = 0;
  let visitedDirectoryCount = 0;

  // Canonical paths of the directories already walked. A real directory tree
  // cannot contain a cycle, but a bind mount can present the same directory at
  // two places, and the set makes the walk terminate regardless while doubling
  // as the per-directory containment proof.
  const visited = new Set<string>([canonicalProjectRoot]);
  const pending: string[] = [projectRoot];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }

    const entries = tryCatch(
      () => readdirSync(directory, { withFileTypes: true }),
      'CODE_INDEX_FAILED',
    );
    if (isErr(entries)) {
      if (directory === projectRoot) {
        return err(
          failure(
            'CODE_INDEX_FAILED',
            `The source files of the project at '${projectRoot}' could not be read: ${entries.error.message}`,
            'source-files-unreadable',
            'Check that the project directory and its files are readable, then try again.',
            entries.error,
          ),
        );
      }
      unreadable.push(projectRelativeOrUndefined(projectRoot, directory) ?? directory);
      continue;
    }

    visitedDirectoryCount += 1;

    for (const entry of entries.value) {
      // Hidden entries are not indexed, at any depth — see the note above.
      if (entry.name.startsWith(HIDDEN_PREFIX)) {
        continue;
      }

      const entryPath = joinPosix(directory, entry.name);

      if (entry.isDirectory()) {
        if (shouldExcludePath(projectRoot, entryPath, extraExcludes)) {
          prunedDirectoryCount += 1;
          continue;
        }

        // The entry says "directory", so this cannot be a link; resolving it
        // anyway is what keeps the walk inside the project even if a component
        // above it was replaced while the walk was in progress, and what makes
        // the visited set canonical.
        const canonicalDirectory = tryCatch(() => realpathSync(entryPath));
        if (isErr(canonicalDirectory)) {
          unreadable.push(projectRelativeOrUndefined(projectRoot, entryPath) ?? entryPath);
          continue;
        }

        const canonical = normalizePosix(toPosix(canonicalDirectory.value));
        if (!isWithin(canonicalProjectRoot, canonical) || visited.has(canonical)) {
          prunedDirectoryCount += 1;
          continue;
        }

        visited.add(canonical);
        pending.push(entryPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        // A link is never descended into, whatever it points at and whatever
        // it is named: its directory entry is not a directory entry, so the
        // branch above cannot have queued it. What remains is to say which
        // kind of link it was, which needs the one `stat` in this loop — links
        // are rare, and the answer decides whether the developer is told.
        const target = tryCatch(() => statSync(entryPath, { throwIfNoEntry: false }));
        const targetStats = isErr(target) ? undefined : target.value;

        if (targetStats?.isDirectory() === true) {
          // The case a following glob layer turns into an external tree in the
          // candidate list. Reported at `warn` rather than counted quietly:
          // source reachable only through this link is deliberately not
          // indexed, and a developer who expected it indexed has to be able to
          // find out why.
          directoryLinks.push(projectRelativeOrUndefined(projectRoot, entryPath) ?? entryPath);
          continue;
        }

        // A link to a file is a candidate when its name is indexable, because
        // a link to a source file inside the project is legitimate;
        // {@link screenCandidatePath} resolves it and decides. A dangling or
        // cyclic link resolves to nothing and is refused here, which is the
        // fail-closed direction.
        if (
          targetStats?.isFile() === true &&
          isIndexableFile(entryPath) &&
          !shouldExcludePath(projectRoot, entryPath, extraExcludes)
        ) {
          candidates.push(entryPath);
          continue;
        }

        prunedLinks.push(projectRelativeOrUndefined(projectRoot, entryPath) ?? entryPath);
        continue;
      }

      // A regular file is a candidate; a socket, a pipe or a device node is
      // not a source file and is skipped without a stat.
      if (
        entry.isFile() &&
        isIndexableFile(entryPath) &&
        !shouldExcludePath(projectRoot, entryPath, extraExcludes)
      ) {
        candidates.push(entryPath);
      }
    }
  }

  if (directoryLinks.length > 0) {
    logger.warn('directory links were not followed, so nothing below them was enumerated', {
      projectRoot,
      count: directoryLinks.length,
      files: directoryLinks.slice(0, MAX_REPORTED_REFUSAL_PATHS),
    });
  }

  if (prunedLinks.length > 0) {
    logger.debug('links that name nothing indexable were skipped during discovery', {
      projectRoot,
      count: prunedLinks.length,
      files: prunedLinks.slice(0, MAX_REPORTED_REFUSAL_PATHS),
    });
  }

  if (unreadable.length > 0) {
    logger.warn('directories inside the project could not be read and were skipped', {
      projectRoot,
      count: unreadable.length,
      files: unreadable.slice(0, MAX_REPORTED_REFUSAL_PATHS),
    });
  }

  logger.debug('project discovered', {
    projectRoot,
    visitedDirectoryCount,
    prunedDirectoryCount,
    candidateFileCount: candidates.length,
  });

  return ok(candidates);
}

/**
 * What the screen decided about one candidate file.
 *
 * A discriminated verdict rather than a boolean, because the four ways a file
 * can be refused are not interchangeable: two of them are privacy or
 * containment failures that must be reported and, where the file is already
 * loaded, unloaded; one is an ordinary exclusion that is expected and quiet;
 * and one is the fail-closed answer for a path whose provenance could not be
 * established. Keeping them distinct is what lets the two call sites count and
 * log them differently, and what lets a reader see every refusal reason in one
 * place.
 *
 * - `indexable` — judged safe to read and to keep in the file set.
 * - `excluded` — a declaration file, a minified bundle, a non-indexable
 *   extension, or a path under an excluded tree. Not a privacy matter: absent
 *   from the file set, counted at `debug`.
 * - `env` — the candidate *or its resolved path* names an environment file.
 *   The privacy guarantee of this package; reported at `warn`.
 * - `escaping` — the resolved path lies outside the project, which is what a
 *   symlinked directory or a symlinked file achieves; reported at `warn`.
 * - `unresolvable` — `realpath` failed (a dangling link, a link cycle, a
 *   directory this account may not traverse). Refused rather than accepted: a
 *   path whose real location cannot be established is not indexed.
 */
type ScreenVerdict = 'indexable' | 'excluded' | 'env' | 'escaping' | 'unresolvable';

/** The verdicts that refuse a candidate — every {@link ScreenVerdict} but one. */
type RefusalVerdict = Exclude<ScreenVerdict, 'indexable'>;

/** Everything {@link screenCandidatePath} needs to judge one path. */
interface ScreenOptions {
  /**
   * The path being judged: absolute, POSIX separators, already normalised.
   *
   * For the discovery pass this is a path the traversal produced; for the
   * defence-in-depth pass it is a path the compiler holds. The screen makes no
   * distinction, which is the point of there being one screen.
   */
  readonly candidatePath: string;

  /** The normalised absolute project root, as the caller spelled it. */
  readonly projectRoot: string;

  /**
   * The project root with every symbolic link resolved — see
   * {@link resolveCanonicalRoot}. The one base containment is decided against.
   */
  readonly canonicalProjectRoot: string;

  /** Caller-supplied exclusions, already defaulted. */
  readonly extraExcludes: readonly string[];
}

/**
 * The single path screen: the one place that decides whether a file may be
 * read and indexed.
 *
 * Both call sites use it — {@link admitScreenedSourceFiles} before a file is
 * loaded and {@link retainIndexableSourceFiles} over what the compiler holds —
 * so there is exactly one rule about containment in this module rather than a
 * strong one and a weak one that can drift apart.
 *
 * ## The order of the questions is deliberate
 *
 * The lexical judgements come first, so the common case — an ordinary source
 * file — costs no syscall beyond the one `realpath` below, and a path that is
 * excluded by its own name never causes a filesystem operation at all.
 *
 * Then the whole path is resolved. `realpath` resolves **every component**,
 * not just the last, which is what reveals a regular file reached through a
 * symlinked directory — the case a final-component `lstat` cannot see. The
 * resolved path is required to be inside the project and is re-judged by the
 * same predicates, because a link's own basename says nothing about what it
 * reads: `src/config.ts -> ../.env` is indexable by name and an environment
 * file in fact.
 *
 * ## Containment is decided against the canonical root, and nothing else
 *
 * Two spellings of the root exist and they do different jobs. The path the
 * caller passed is what the handle reports and what every loaded file is
 * spelled under, because a consumer's cache key and its `SourceLocation`s have
 * to match what it asked for. The *canonical* root — the same directory with
 * every symbolic link resolved — is the only base a resolved path is required
 * to sit under, and a resolved path is by construction free of links, so the
 * comparison is between two canonical paths and has one answer. Accepting the
 * lexical root as a second base, as an earlier version of this screen did,
 * widens that answer for no gain: a resolved path can only match the lexical
 * root when the two are the same string.
 *
 * ## And the resolved path must be a regular file
 *
 * A *directory* can carry a name this module calls indexable — a link named
 * `<name>.ts` pointing at a directory is the shape a following glob layer
 * yields, and a real directory so named is legal — and handing one to the
 * compiler turns an ordinary project into a failed open. It is refused as an
 * exclusion, quietly, because it is a naming accident rather than a breach.
 *
 * @param options The path to judge, the project's two roots and the exclusions.
 * @returns The verdict; only `indexable` permits the file to be read.
 */
function screenCandidatePath(options: ScreenOptions): ScreenVerdict {
  const { candidatePath, projectRoot, canonicalProjectRoot, extraExcludes } = options;

  if (isEnvFilePath(candidatePath)) {
    return 'env';
  }

  if (
    !isIndexableFile(candidatePath) ||
    shouldExcludePath(projectRoot, candidatePath, extraExcludes)
  ) {
    return 'excluded';
  }

  const real = tryCatch(() => realpathSync(candidatePath));
  if (isErr(real)) {
    return 'unresolvable';
  }
  const resolvedPath = normalizePosix(toPosix(real.value));

  if (!isWithin(canonicalProjectRoot, resolvedPath)) {
    return 'escaping';
  }

  const resolvedStats = tryCatch(() => statSync(resolvedPath, { throwIfNoEntry: false }));
  if (isErr(resolvedStats) || resolvedStats.value === undefined) {
    return 'unresolvable';
  }
  if (!resolvedStats.value.isFile()) {
    return 'excluded';
  }

  if (isEnvFilePath(resolvedPath)) {
    return 'env';
  }

  if (
    !isIndexableFile(resolvedPath) ||
    shouldExcludePath(canonicalProjectRoot, resolvedPath, extraExcludes)
  ) {
    return 'excluded';
  }

  return 'indexable';
}

/**
 * How many refused paths a single log record names.
 *
 * Counts are always exact; the *paths* are a bounded sample, because a
 * pathological tree — a directory of dangling links, a vendored copy of a
 * project — can refuse thousands of files and a log record that grows with the
 * filesystem is a denial of service against whoever reads the log. Twenty is
 * enough for a developer to recognise the pattern and small enough to print.
 */
const MAX_REPORTED_REFUSAL_PATHS = 20;

/** The tally of one refusal class: every occurrence counted, a sample named. */
interface RefusalRecord {
  /** How many candidates this class refused. Exact. */
  count: number;

  /**
   * Up to {@link MAX_REPORTED_REFUSAL_PATHS} of the refused paths, in
   * project-relative form.
   *
   * Project-relative on purpose. For an escaping file this is the *link's*
   * path, never its resolved target: the target names a location on the
   * developer's filesystem, and reporting it would disclose the layout a
   * refusal exists to keep out of the product.
   */
  readonly reported: string[];
}

/** The tally of every refusal class from one screening pass. */
type RefusalTally = Readonly<Record<RefusalVerdict, RefusalRecord>>;

/**
 * How the refused files of a pass were disposed of, as the phrase the log
 * record uses.
 *
 * Both call sites report the same four classes and differ only here, so the
 * difference is a word rather than a second set of messages: discovery refuses
 * a candidate *before* it is read, and the defence-in-depth pass unloads a file
 * that had already been read.
 */
type RefusalDisposition = 'refused before being read' | 'refused and unloaded';

/** A fresh, zeroed tally. */
function createRefusalTally(): RefusalTally {
  return {
    excluded: { count: 0, reported: [] },
    env: { count: 0, reported: [] },
    escaping: { count: 0, reported: [] },
    unresolvable: { count: 0, reported: [] },
  };
}

/**
 * Counts one refusal and, while there is room in the sample, names it.
 *
 * @param tally The pass's tally, mutated in place.
 * @param verdict The class the candidate was refused under.
 * @param reportablePath The refused path in project-relative form.
 */
function recordRefusal(tally: RefusalTally, verdict: RefusalVerdict, reportablePath: string): void {
  const record = tally[verdict];
  record.count += 1;
  if (record.reported.length < MAX_REPORTED_REFUSAL_PATHS) {
    record.reported.push(reportablePath);
  }
}

/**
 * Reports a pass's refusals: one record per non-empty class, counts and paths
 * only.
 *
 * Nothing about a file's *content* is logged here or anywhere else in this
 * module — that is the whole point of refusing the file — and an escaping
 * link's resolved target is deliberately absent for the reason given on
 * {@link RefusalRecord.reported}.
 *
 * The three privacy and containment classes are `warn`: reaching one of them
 * means either that {@link discoverCandidatePaths} let something through or
 * that the project holds a link which reads from outside itself, and both
 * deserve a developer's attention. Ordinary exclusions are `debug`, because
 * they are the expected outcome for most of a real project's tree.
 *
 * @param tally The pass's tally.
 * @param projectRoot The root the pass ran over, for the log fields.
 * @param disposition What happened to the refused files.
 * @param logger Where the records go.
 */
function reportRefusals(
  tally: RefusalTally,
  projectRoot: string,
  disposition: RefusalDisposition,
  logger: Logger,
): void {
  if (tally.env.count > 0) {
    logger.warn(
      `environment files were ${disposition}: the indexer never reads them (privacy model)`,
      { projectRoot, count: tally.env.count, files: tally.env.reported },
    );
  }

  if (tally.escaping.count > 0) {
    logger.warn(`files whose real path leaves the project were ${disposition}`, {
      projectRoot,
      count: tally.escaping.count,
      files: tally.escaping.reported,
    });
  }

  if (tally.unresolvable.count > 0) {
    logger.warn(`files whose real path could not be established were ${disposition}`, {
      projectRoot,
      count: tally.unresolvable.count,
      files: tally.unresolvable.reported,
    });
  }

  if (tally.excluded.count > 0) {
    logger.debug('files were excluded from the code index', {
      projectRoot,
      count: tally.excluded.count,
    });
  }
}

/** Everything {@link walkAndScreenProject} needs to enumerate and judge a project. */
interface WalkOptions {
  /** The normalised absolute project root. */
  readonly projectRoot: string;

  /** The project root with every symbolic link resolved — the containment base. */
  readonly canonicalProjectRoot: string;

  /** The resolved configuration path, recorded on the discovery unparsed. */
  readonly tsConfigFilePath: string | undefined;

  /** Caller-supplied exclusions, already defaulted. */
  readonly extraExcludes: readonly string[];

  /** Where the walk's refusals and counts go. */
  readonly logger: Logger;
}

/**
 * Walks the project and screens every candidate, producing the file set
 * without opening a single file.
 *
 * The shared body behind {@link discoverProjectFiles} and
 * {@link openProject}'s own discovery: both reach the file set through this
 * function, so there is one traversal and one screening rule in this module
 * rather than a cheap one for the cache path and a thorough one for the
 * loading path.
 *
 * The refusals are reported here, under the same disposition
 * ({@link RefusalDisposition}) the loading path used to report them with,
 * because they still describe candidates refused *before being read*. What
 * {@link admitScreenedSourceFiles} then does with the survivors is screen them
 * again — which is defence in depth and not redundancy, since a file can change
 * between the two passes and since a future call site may hand it paths this
 * function never saw.
 *
 * The result is sorted by project-relative path with {@link comparePaths} —
 * byte-wise, never locale-aware, for the reason that function gives — so the
 * order is the one {@link LoadedProject.sourceFiles} guarantees and a
 * fingerprint list taken from it is identical on every machine.
 *
 * @param options The project's two roots, the configuration path, the
 * exclusions and where to report.
 * @returns `Ok` with the discovery, or `Err` when the root cannot be listed.
 */
function walkAndScreenProject(options: WalkOptions): Result<DiscoveredProject> {
  const { projectRoot, canonicalProjectRoot, tsConfigFilePath, extraExcludes, logger } = options;

  const candidates = discoverCandidatePaths({
    projectRoot,
    canonicalProjectRoot,
    extraExcludes,
    logger,
  });
  if (isErr(candidates)) {
    return candidates;
  }

  const tally = createRefusalTally();
  const kept: { readonly relativePath: string; readonly absolutePath: string }[] = [];

  for (const candidate of candidates.value) {
    const candidatePath = normalizePosix(toPosix(candidate));

    const verdict = screenCandidatePath({
      candidatePath,
      projectRoot,
      canonicalProjectRoot,
      extraExcludes,
    });

    if (verdict !== 'indexable') {
      recordRefusal(
        tally,
        verdict,
        projectRelativeOrUndefined(projectRoot, candidatePath) ?? candidatePath,
      );
      continue;
    }

    const relative = toProjectRelative(projectRoot, candidatePath);
    if (isErr(relative)) {
      // Unreachable through the screen above — a path it calls indexable is
      // inside the project — and handled rather than asserted, because the
      // alternative is a non-null assertion on a value the compiler cannot
      // narrow. Counted as the ordinary exclusion it would be, which reports a
      // count and no path.
      recordRefusal(tally, 'excluded', candidatePath);
      continue;
    }

    kept.push({ relativePath: relative.value, absolutePath: candidatePath });
  }

  reportRefusals(tally, projectRoot, 'refused before being read', logger);

  kept.sort((left, right) => comparePaths(left.relativePath, right.relativePath));

  return ok(
    Object.freeze({
      projectRoot,
      canonicalProjectRoot,
      tsConfigFilePath,
      // A frozen copy, not the caller's array: a discovery that could change
      // under the consumer fingerprinting it would be a discovery nothing could
      // be keyed on.
      extraExcludes: Object.freeze([...extraExcludes]),
      files: Object.freeze(kept.map((entry) => entry.absolutePath)),
      relativeFiles: Object.freeze(kept.map((entry) => entry.relativePath)),
    }),
  );
}

/** What {@link discoveredCandidatePaths} needs to decide between reuse and a walk. */
interface ReuseOptions extends WalkOptions {
  /** The discovery the caller supplied, if any. */
  readonly discovered: DiscoveredProject | undefined;
}

/**
 * The candidate paths {@link openProject} will screen and load: the supplied
 * discovery's, or a fresh walk's.
 *
 * A supplied discovery is used only when it describes **the same discovery
 * inputs** as this open: the same normalised root, the same canonical root, the
 * same resolved configuration path and the same exclusions. Anything else is a
 * discovery of a different file set — a sibling directory, a run with
 * `extraExcludes`, a root that has been relinked since — and reusing it would
 * make the opened project's file set answer a question nobody asked. A
 * disagreement costs one `warn` and a fresh walk rather than a failure, because
 * the walk is always available and a slower open is better than a wrong one.
 *
 * Note what reuse does *not* skip: every path returned here is screened again
 * by {@link admitScreenedSourceFiles} before it is read, against the canonical
 * root *this* call resolved. So the discovery decides how much work is done and
 * never what may be read.
 *
 * @param options The supplied discovery, the project's two roots, the
 * configuration path, the exclusions and where to report.
 * @returns `Ok` with the candidate paths, or the walk's `Err`.
 */
function discoveredCandidatePaths(options: ReuseOptions): Result<readonly string[]> {
  const { discovered, projectRoot, canonicalProjectRoot, tsConfigFilePath, extraExcludes, logger } =
    options;

  if (discovered !== undefined) {
    if (
      discovered.projectRoot === projectRoot &&
      discovered.canonicalProjectRoot === canonicalProjectRoot &&
      discovered.tsConfigFilePath === tsConfigFilePath &&
      sameExcludes(discovered.extraExcludes, extraExcludes)
    ) {
      return ok(discovered.files);
    }

    logger.warn(
      'the supplied project discovery was taken over a different root, configuration or exclusion set; it was ignored and the project was walked again',
      { projectRoot },
    );
  }

  const screened = walkAndScreenProject({
    projectRoot,
    canonicalProjectRoot,
    tsConfigFilePath,
    extraExcludes,
    logger,
  });

  return isErr(screened) ? screened : ok(screened.value.files);
}

/**
 * Whether two exclusion lists are the same list.
 *
 * Compared element by element in order rather than as sets: the entries are
 * matched as written (see {@link shouldExcludePath}), so two lists that differ
 * only in order describe the same exclusions today — but treating order as
 * significant is the conservative answer, and the cost of being wrong in this
 * direction is one extra directory walk rather than a file set that does not
 * match what was asked for.
 *
 * @param left The discovery's exclusions.
 * @param right The exclusions this open was asked for.
 * @returns `true` when they are element-wise equal.
 */
function sameExcludes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** Everything {@link admitScreenedSourceFiles} needs to load a project's files. */
interface AdmitOptions {
  /** The project the surviving candidates are loaded into. */
  readonly project: Project;

  /**
   * The paths {@link discoverCandidatePaths} produced.
   *
   * Each one is converted to POSIX separators and normalised here, so the path
   * the screen judges is the path the compiler is given and the path a later
   * pass re-judges.
   */
  readonly candidatePaths: readonly string[];

  /** The normalised absolute project root. */
  readonly projectRoot: string;

  /** The project root with every symbolic link resolved — the containment base. */
  readonly canonicalProjectRoot: string;

  /** Caller-supplied exclusions, already defaulted. */
  readonly extraExcludes: readonly string[];

  /** Where refusals are reported. */
  readonly logger: Logger;
}

/**
 * Screens every discovered candidate and loads only the ones that survive.
 *
 * This is the step that makes the privacy guarantee mechanical rather than
 * hopeful: a refused candidate is never opened, so its bytes never enter the
 * compiler's memory, a graph node, a summary or a prompt — there is nothing to
 * unload afterwards, and no window in which another stage could have read it.
 *
 * A candidate that vanished between discovery and loading is skipped:
 * `addSourceFileAtPathIfExists` answers `undefined` for it rather than
 * throwing, which is exactly the case a concurrent build or a dev-server cache
 * sweep produces. A candidate that exists but cannot be *read* is a different
 * matter and fails the whole open with `CODE_INDEX_FAILED` — the behaviour
 * documented on {@link openProject}, where an unreadable file is an `Err`
 * rather than a silently smaller index.
 *
 * @param options The project, the candidates, the project's two roots and where
 * to report.
 * @returns `Ok` with the number of files loaded, or `Err` when a candidate
 * could not be read.
 */
function admitScreenedSourceFiles(options: AdmitOptions): Result<number> {
  const { project, candidatePaths, projectRoot, canonicalProjectRoot, extraExcludes, logger } =
    options;

  const tally = createRefusalTally();
  let loadedCount = 0;
  let vanishedCount = 0;

  for (const discoveredPath of candidatePaths) {
    const candidatePath = normalizePosix(toPosix(discoveredPath));

    const verdict = screenCandidatePath({
      candidatePath,
      projectRoot,
      canonicalProjectRoot,
      extraExcludes,
    });

    if (verdict !== 'indexable') {
      recordRefusal(
        tally,
        verdict,
        projectRelativeOrUndefined(projectRoot, candidatePath) ?? candidatePath,
      );
      continue;
    }

    const added = tryCatch(
      () => project.addSourceFileAtPathIfExists(candidatePath),
      'CODE_INDEX_FAILED',
    );
    if (isErr(added)) {
      return err(
        failure(
          'CODE_INDEX_FAILED',
          `The source files of the project at '${projectRoot}' could not be read: ${added.error.message}`,
          'source-files-unreadable',
          'Check that the project directory and its files are readable, then try again.',
          added.error,
        ),
      );
    }

    if (added.value === undefined) {
      vanishedCount += 1;
      continue;
    }

    loadedCount += 1;
  }

  reportRefusals(tally, projectRoot, 'refused before being read', logger);

  if (vanishedCount > 0) {
    logger.debug('files disappeared between discovery and loading and were skipped', {
      projectRoot,
      count: vanishedCount,
    });
  }

  return ok(loadedCount);
}

/** Everything {@link retainIndexableSourceFiles} needs to judge a file. */
interface RetainOptions {
  /** The project whose loaded files are being judged. */
  readonly project: Project;

  /** The normalised absolute project root. */
  readonly projectRoot: string;

  /**
   * The project root with every symbolic link resolved — the one base a
   * resolved path is required to sit under.
   *
   * A root may legitimately be reached through a link (a checkout under a
   * linked home directory, or a temporary directory on a platform that links
   * its temporary path), and a file's resolved path then sits under the *real*
   * root while the project speaks of the link. Resolving the root once, in
   * {@link resolveCanonicalRoot}, is what lets containment be a single
   * canonical comparison instead of a choice between two bases.
   */
  readonly canonicalProjectRoot: string;

  /** Caller-supplied exclusions, already defaulted. */
  readonly extraExcludes: readonly string[];

  /** Where refusals are reported. */
  readonly logger: Logger;
}

/**
 * The defence-in-depth filter: re-judges every file the compiler actually
 * holds and returns the deterministic, frozen file set the handle exposes.
 *
 * Why it exists even though {@link admitScreenedSourceFiles} already screened
 * every candidate: the compiler's program is not only what this module put
 * there. A traversal is code and code can be wrong; a future call site may add
 * a file; module resolution may pull one in. This
 * pass therefore asks {@link screenCandidatePath} — the *same* screen, not a
 * weaker second rule — of every path `project.getSourceFiles()` reports, so a
 * mistake anywhere upstream costs an entry in the log instead of a leak.
 *
 * Three classes of refusal go further than dropping the file from the set, and
 * are *unloaded from the compiler* with `removeSourceFile`, which also releases
 * the content ts-morph read:
 *
 * - **Environment files** (`env`), by name or by resolved path. The privacy
 *   guarantee of this package.
 * - **Files whose real path leaves the project** (`escaping`) — what a
 *   symlinked directory or a symlinked file achieves, and what a string-level
 *   containment check cannot see.
 * - **Files whose real path could not be established** (`unresolvable`), which
 *   is the fail-closed direction: an unverifiable provenance is not indexed.
 *
 * All three are reported at `warn`, because reaching any of them here means a
 * file was read before it was judged and somebody should look.
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
  const { project, projectRoot, canonicalProjectRoot, extraExcludes, logger } = options;

  const kept: { readonly relativePath: string; readonly sourceFile: SourceFile }[] = [];
  const unload: SourceFile[] = [];
  const tally = createRefusalTally();

  for (const sourceFile of project.getSourceFiles()) {
    const filePath: string = normalizePosix(toPosix(sourceFile.getFilePath()));

    const verdict = screenCandidatePath({
      candidatePath: filePath,
      projectRoot,
      canonicalProjectRoot,
      extraExcludes,
    });

    if (verdict !== 'indexable') {
      recordRefusal(tally, verdict, projectRelativeOrUndefined(projectRoot, filePath) ?? filePath);
      // An ordinary exclusion is merely absent from the set; a privacy or
      // containment refusal has its content taken out of memory as well.
      if (verdict !== 'excluded') {
        unload.push(sourceFile);
      }
      continue;
    }

    const relative = toProjectRelative(projectRoot, filePath);
    if (isErr(relative)) {
      // Unreachable through the screen above — a file it calls indexable is
      // inside the project — and handled rather than asserted, because the
      // alternative is a non-null assertion on a value the compiler cannot
      // narrow. Counted as the ordinary exclusion it would be.
      recordRefusal(tally, 'excluded', filePath);
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

  reportRefusals(tally, projectRoot, 'refused and unloaded', logger);

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
 * The project root with every symbolic link resolved: the base every
 * containment decision in this module is made against.
 *
 * Resolved once per opened project, and a failure is an `Err` rather than a
 * fallback to the unresolved path. That is the fail-closed direction and it is
 * the only honest one: if the root's own real location cannot be established,
 * no file's real location can be judged against it, and quietly using the
 * unresolved spelling would either refuse every file in the project — a
 * silently empty index, the outcome this module documents as never acceptable
 * without a reason — or accept a path whose containment was never actually
 * proven. The root has already been confirmed to exist and to be a directory
 * by {@link requireDirectory}, so reaching here means a link cycle above the
 * root or a directory this account may not traverse, and the developer is told
 * which.
 *
 * @param projectRoot The normalised absolute project root.
 * @returns `Ok` with the canonical root, or `Err` carrying `PROJECT_NOT_FOUND`.
 */
function resolveCanonicalRoot(projectRoot: string): Result<string> {
  const real = tryCatch(() => realpathSync(projectRoot), 'PROJECT_NOT_FOUND');
  if (isErr(real)) {
    return err(
      failure(
        'PROJECT_NOT_FOUND',
        `The real location of the project root '${projectRoot}' could not be established: ${real.error.message}`,
        'project-root-unresolvable',
        'Check that every directory on the way to the project can be read by this user, then try again.',
        real.error,
      ),
    );
  }

  return ok(normalizePosix(toPosix(real.value)));
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
