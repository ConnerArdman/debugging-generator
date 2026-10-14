/**
 * The project summary: what the pipeline's first stage is told about a target
 * project, and nothing more.
 *
 * ## What Stage 1 uses this for
 *
 * Problem understanding (AAP 0.4.2) receives four things — the developer's
 * question, the element they selected, the URL they were on, and the
 * `ProjectSummary` this module builds. Its job is to decide *what kind of
 * project this is* and *what to ask the code graph for next*: whether there is
 * a server tier at all, which router convention the URL in the question belongs
 * to, whether a database is reached through a generated client or a driver, and
 * where the modules a developer would recognise as entry points live. Every
 * later stage works from targeted queries (`./graph/query.ts`) and bounded
 * excerpts requested per file; none of them re-reads this object.
 *
 * ## Two properties govern every line below
 *
 * **It is bounded.** This object is embedded verbatim in a prompt, so its size
 * is a cost paid on every session and its growth is invisible until a request
 * is refused. {@link PROJECT_SUMMARY_LIMITS} caps every list, a final pass
 * enforces a serialised byte budget, and {@link ProjectSummary.truncated} says
 * when a cap bit. The counts in {@link ProjectSummary.counts} are deliberately
 * *not* capped: a consumer must always be able to tell how much of the project
 * it is *not* being shown, because "there are three routes" and "you have been
 * shown three of two hundred routes" lead to opposite conclusions.
 *
 * **It is honest.** Every value is derived from something actually present in
 * the target project — a declaration in its manifest, a file on its disk, a
 * node in its graph — and where nothing settles a question the answer is the
 * explicit `'unknown'` or `'none'` member of the relevant vocabulary rather
 * than a plausible default. A wrong framework, a wrong package manager or an
 * optimistic database style is worse for the stage that reads them than an
 * absent one: each of the three is acted upon (a relaunch command is suggested
 * from the package manager, the Prisma and Postgres adapters decide their own
 * relevance from the database style), and a confident wrong answer produces a
 * suggestion that fails on the developer's machine.
 *
 * ## Privacy contract
 *
 * This summary is **the first thing that leaves the machine** when a real model
 * provider is configured, which makes the boundary below a security control
 * rather than a style preference (AAP 0.5.2):
 *
 * - **No environment values, ever.** This module reads no environment
 *   variable, and reads no `.env` file: the only file it opens is a
 *   `package.json` — the target project's, and, when the target is a member of
 *   a workspace, that workspace root's, for the one field
 *   {@link detectPackageManager} falls back to — and every existence probe it
 *   makes runs through `./project.ts`'s {@link isEnvFilePath} and
 *   {@link shouldExcludePath} first, so an environment file cannot be probed,
 *   let alone read. Locating the workspace root belongs to `./project.ts`
 *   ({@link findWorkspaceRoot}), which applies the same environment-file
 *   refusal to every file it reads.
 * - **No file contents.** Nothing here carries a source excerpt, a statement, a
 *   connection string or a configuration value. From the manifest it takes
 *   *names* and declared *version range strings* and nothing else — not
 *   `scripts`, not `config`, not a resolution field.
 * - **No host paths.** {@link ProjectSummary.projectRoot} is the single
 *   absolute path in the object; every other path is project-relative POSIX,
 *   and a path that fails `isSafeRelativePath` is dropped rather than repaired.
 *   A workspace root found above the project is *not* a field of the summary:
 *   it exists only as an argument to the package-manager detector and as a
 *   `debug` log line.
 * - **No excluded tree is inspected.** `node_modules`, `.next`, `dist` and
 *   their siblings are refused by the same predicate the indexer uses, so an
 *   installed dependency's own layout can never appear here.
 *
 * ## Determinism
 *
 * Two runs over an unchanged project produce byte-identical JSON except for
 * {@link ProjectSummary.generatedAt}, which is the same single exemption
 * `CodeIndex` documents for its own timestamp. Every list has a documented
 * total order — a route by path, a file by path, a directory by file count then
 * path, a dependency by category then name — so no list inherits the order a
 * filesystem walk or a `Map` iteration happened to produce.
 *
 * ## What this module does *not* do
 *
 * It does not index (`./indexer.ts`), it does not derive routes
 * (`./route-map.ts` owns that, and this module reports what it derived), it
 * does not cache (`./cache.ts`), and it holds no state: `summarizeProject` is a
 * pure function of its input plus a bounded set of filesystem reads — the
 * target's manifest, its existence probes, and the workspace-root lookup and
 * that root's manifest behind {@link detectPackageManager}'s fallback — it
 * mutates nothing it is given, and calling it twice costs exactly twice as much
 * as calling it once.
 *
 * @packageDocumentation
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';

import {
  basenamePosix,
  dirnamePosix,
  extnamePosix,
  isErr,
  isSafeRelativePath,
  isWithin,
  joinPosix,
  noopLogger,
  nowEpochMs,
  resolveWithinProject,
  toPosix,
} from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';

import { CodeGraph } from './graph/graph.js';
import type {
  ApiRouteKind,
  CodeIndex,
  DatabaseAccessInfo,
  DatabaseAccessStyle,
  FrameworkInfo,
  HttpMethodName,
  PackageManagerName,
  ProjectDependencyRef,
  ProjectSummary,
  ProjectSummaryCounts,
  ProjectSummaryRouteRef,
  RouterKind,
  RouterStyle,
  TypeScriptInfo,
} from './graph/types.js';
import { findWorkspaceRoot, isEnvFilePath, shouldExcludePath } from './project.js';
import type { LoadedProject } from './project.js';
import type { RouteMap } from './route-map.js';

/* -------------------------------------------------------------------------------------------------
 * Limits
 * ---------------------------------------------------------------------------------------------- */

/**
 * The caps a {@link ProjectSummary} is built under.
 *
 * Every field is a hard ceiling rather than a target: a project with four
 * hundred routes produces a summary with {@link ProjectSummaryLimits.maxRoutes}
 * of them and `truncated: true`, never four hundred.
 */
export interface ProjectSummaryLimits {
  /**
   * How many entry-point paths {@link ProjectSummary.entryPoints} may hold.
   */
  readonly maxEntryPoints: number;

  /**
   * How many routes {@link ProjectSummary.routes} may hold.
   */
  readonly maxRoutes: number;

  /**
   * How many directory paths {@link ProjectSummary.notableDirectories} may
   * hold.
   */
  readonly maxDirectories: number;

  /**
   * How many dependency entries {@link ProjectSummary.dependencies} may hold.
   */
  readonly maxDependencies: number;

  /**
   * How long any single string in the summary may be, in UTF-16 code units.
   *
   * Applies to every string except {@link ProjectSummary.projectRoot} — see
   * {@link summarizeProject} for why that one field is exempt — and is applied
   * two ways depending on what the string is. Free text (a project name, a
   * declared version range, a package name) is truncated with a trailing
   * ellipsis, because a shortened label is still a usable label. A **path** is
   * never truncated: a shortened path names a file that does not exist, so an
   * item whose path would exceed this length is dropped from its list instead,
   * which keeps every path in the summary one a consumer can act on.
   */
  readonly maxStringLength: number;

  /**
   * The serialised budget for the whole summary, in UTF-16 code units of
   * `JSON.stringify(summary)`.
   *
   * ## Why there is a byte budget at all, on top of the per-list caps
   *
   * The caps bound the number of *items*; they cannot bound their size. One
   * project's forty routes are forty short paths and another's are forty deeply
   * nested dynamic segments, and the difference between those two summaries is
   * an order of magnitude of prompt input. The budget is what makes the cost of
   * this object predictable regardless of how the target project is laid out.
   *
   * ## Why this number
   *
   * Roughly 8 KiB, which is a few thousand tokens once serialised — a small
   * share of a stage prompt that also carries the developer's question, the
   * selected element, the stage instructions and the output schema, and leaves
   * the model's attention for the parts of the prompt that vary per session.
   * It comfortably fits a complete summary of an ordinary application (an
   * identity block, a dozen entry points, a few dozen routes, a handful of
   * recognised dependencies and the counts), so the trimming pass is the
   * exception rather than the rule.
   */
  readonly maxTotalBytes: number;
}

/**
 * The default caps, and the values every consumer that does not override them
 * gets.
 *
 * Deliberately conservative: each list is large enough to describe an ordinary
 * application completely and small enough that a pathological one cannot
 * dominate a prompt. Frozen, so a consumer cannot mutate the defaults for
 * everybody else.
 */
export const PROJECT_SUMMARY_LIMITS: ProjectSummaryLimits = Object.freeze({
  maxEntryPoints: 25,
  maxRoutes: 40,
  maxDirectories: 25,
  maxDependencies: 40,
  maxStringLength: 200,
  maxTotalBytes: 8192,
});

/* -------------------------------------------------------------------------------------------------
 * Detection vocabulary
 *
 * Every literal a detector compares against lives here, spelled once. They are
 * the names of *published libraries and framework conventions* — a package name
 * a manifest declares, a configuration basename a framework looks for, a
 * lockfile a package manager writes — and never the vocabulary of any
 * particular application: nothing in this module knows a component, a service,
 * a hook or a route path of any project it summarises, which is the property
 * `scripts/check-no-hardcoding.mjs` enforces over this package.
 * ---------------------------------------------------------------------------------------------- */

/** The manifest basename, and the only file this module opens. */
const MANIFEST_BASENAME = 'package.json';

/**
 * The largest manifest this module will read, in bytes (1 MiB).
 *
 * An ordinary manifest is a few kilobytes. The ceiling exists so that a
 * pathological or hostile file cannot be pulled into memory by a function whose
 * whole purpose is to read four fields out of it.
 */
const MAX_MANIFEST_BYTES = 1_048_576;

/**
 * The framework's configuration module, in the extensions it accepts.
 *
 * Presence of any one of them is the *on-disk* framework signal, independent of
 * what the manifest declares: a project whose dependencies were pruned still
 * has its configuration.
 */
const FRAMEWORK_CONFIG_FILES: readonly string[] = Object.freeze([
  'next.config.ts',
  'next.config.mts',
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
]);

/** Where an App Router tree may live, in the order a project may nest it. */
const APP_ROUTER_DIRECTORIES: readonly string[] = Object.freeze(['app', 'src/app']);

/** Where a Pages Router tree may live. */
const PAGES_ROUTER_DIRECTORIES: readonly string[] = Object.freeze(['pages', 'src/pages']);

/** The generated client's schema file: the corroborating on-disk data signal. */
const PRISMA_SCHEMA_FILE = 'prisma/schema.prisma';

/**
 * Lockfiles and the manager each one identifies, checked only when the manifest
 * declares nothing.
 *
 * Order is irrelevant to the result — {@link detectPackageManager} refuses to
 * choose when more than one is present — and exists only to make the scan
 * deterministic.
 */
const LOCKFILES: readonly { readonly file: string; readonly manager: PackageManagerName }[] =
  Object.freeze([
    { file: 'pnpm-lock.yaml', manager: 'pnpm' },
    { file: 'package-lock.json', manager: 'npm' },
    { file: 'npm-shrinkwrap.json', manager: 'npm' },
    { file: 'yarn.lock', manager: 'yarn' },
    { file: 'bun.lockb', manager: 'bun' },
    { file: 'bun.lock', manager: 'bun' },
  ]);

/** The framework package whose declaration names the framework. */
const FRAMEWORK_PACKAGE = 'next';

/** The view library, in declaration order of preference for a version range. */
const VIEW_PACKAGES: readonly string[] = Object.freeze(['react', 'react-dom']);

/** The compiler package, whose declared range is reported on the TypeScript info. */
const TYPESCRIPT_PACKAGE = 'typescript';

/** The generated client's published package, and the specifier a construction site imports. */
const PRISMA_CLIENT_PACKAGE = '@prisma/client';

/**
 * The path segment a client generated into a project's own tree carries.
 *
 * A specifier such as a relative or aliased path into a generated directory
 * resolves to nothing outside that project, so the segment is the only signal
 * an importer leaves behind.
 */
const PRISMA_PATH_SEGMENT = 'prisma';

/** Package names that corroborate generated-client access. */
const PRISMA_PACKAGES: readonly string[] = Object.freeze([
  PRISMA_PATH_SEGMENT,
  PRISMA_CLIENT_PACKAGE,
]);

/** The driver's published package name, and the final segment of a wrapped specifier for it. */
const PG_PACKAGE = 'pg';

/** Package names that corroborate driver access. */
const PG_PACKAGES: readonly string[] = Object.freeze([PG_PACKAGE, 'pg-pool']);

/**
 * The binding a module imports when it *constructs* the generated client, and
 * the module specifiers that binding can come from.
 *
 * A specifier is recognised either exactly (`'@prisma/client'`) or by carrying a
 * `prisma` path segment, which is what a client generated into the project's own
 * tree looks like to an importer.
 */
const PRISMA_CLIENT_BINDING = 'PrismaClient';

/** The binding a module imports when it constructs a connection pool. */
const PG_POOL_BINDING = 'Pool';

/*
 * The tooling-path vocabulary behind {@link isToolingModulePath}. Every entry is
 * a published convention of a common tool — the ORM's default seed module and
 * migrations directory, the test runners' colocated directories and filename
 * markers, a framework's `*.config.*` module — and none names anything a
 * particular project chose. Product source holds no knowledge of any one
 * project; `scripts/check-no-hardcoding.mjs` enforces that rule.
 */

/**
 * Basename stems of a data-seeding module, and directory names that hold them.
 *
 * `seed` is the ORM's default seed entry (`prisma db seed` runs `prisma/seed.ts`
 * by convention) and `seeds` is the query builders' directory convention.
 * Matched exactly: `seedling.ts` or `seed-utils.ts` is application code that
 * happens to share a prefix.
 */
const SEED_NAMES: readonly string[] = Object.freeze(['seed', 'seeds']);

/**
 * Directory names that hold tooling modules wherever they sit in the tree:
 * schema migrations, and the test runners' colocated test, mock and fixture
 * directories.
 */
const TOOLING_DIRECTORY_NAMES: readonly string[] = Object.freeze([
  'migrations',
  '__tests__',
  '__mocks__',
  '__fixtures__',
]);

/**
 * Directory names that hold tooling modules only as the project's **top-level**
 * directory: operational scripts and out-of-tree test suites.
 *
 * Deliberately not matched deeper: `src/test/` or `src/scripts/` can be an
 * application feature, while a top-level `scripts/` or `test/` is by convention
 * run by the project's own tooling.
 */
const TOP_LEVEL_TOOLING_DIRECTORIES: readonly string[] = Object.freeze([
  'scripts',
  'script',
  'test',
  'tests',
  'e2e',
]);

/**
 * Inner basename markers of a tooling module: `*.test.*`, `*.spec.*`,
 * `*.stories.*` and `*.config.*`.
 *
 * Matched only as an inner dot-separated part — never the stem and never the
 * extension — so `config.ts` or `test.ts` alone is not classified by this rule.
 */
const TOOLING_BASENAME_MARKERS: readonly string[] = Object.freeze([
  'test',
  'spec',
  'stories',
  'config',
]);

/**
 * How a module qualifying as a handle's construction site is ranked, lowest
 * first; see {@link findConstructionModule}.
 */
const CONSTRUCTION_MODULE_RANKS = Object.freeze({
  /** An application module at least one other application module imports. */
  sharedApplicationModule: 0,
  /** An application module nothing else in the application imports. */
  applicationModule: 1,
  /** A module the project runs from its own tooling ({@link isToolingModulePath}). */
  toolingModule: 2,
});

/** File stems that mark a framework document module at the root of a router tree. */
const ROOT_DOCUMENT_STEMS: readonly string[] = Object.freeze(['layout', 'template']);

/** File stems that mark the landing module of a router tree. */
const ROOT_PAGE_STEMS: readonly string[] = Object.freeze(['page', 'index']);

/** File stems the legacy router treats as the application and document shells. */
const LEGACY_SHELL_STEMS: readonly string[] = Object.freeze(['_app', '_document']);

/** File stems a client application mounts itself from. */
const MOUNT_STEMS: readonly string[] = Object.freeze(['main', 'index']);

/** File stems that mark a process entry a server tier starts from. */
const SERVER_ENTRY_STEMS: readonly string[] = Object.freeze(['server', 'instrumentation']);

/** Stems whose presence in a directory marks it as an App Router tree. */
const APP_TREE_MARKER_STEMS: readonly string[] = Object.freeze([...ROOT_DOCUMENT_STEMS, 'page']);

/** Stems whose presence in a directory marks it as a Pages Router tree. */
const PAGES_TREE_MARKER_STEMS: readonly string[] = Object.freeze([...LEGACY_SHELL_STEMS, 'index']);

/** The extensions a router-convention module can carry, for the tree probes. */
const ROUTER_MODULE_EXTENSIONS: readonly string[] = Object.freeze(['.tsx', '.ts', '.jsx', '.js']);

/** The subtree a router convention nests its request handlers under. */
const ROUTER_REQUEST_DIRECTORY = 'api';

/**
 * The managers a `packageManager` declaration may name, keyed by the name it
 * spells.
 *
 * `'unknown'` is deliberately absent: it is an answer this module reaches by
 * finding nothing, never a value a project can declare.
 */
const DECLARABLE_MANAGERS: Readonly<Record<string, PackageManagerName>> = Object.freeze({
  pnpm: 'pnpm',
  npm: 'npm',
  yarn: 'yarn',
  bun: 'bun',
});

/** What a clamped string ends with, so a reader can see that it was clamped. */
const ELLIPSIS = '…';

/**
 * How an entry point is ranked, lowest first.
 *
 * The order is the order a developer would read them in: the document that
 * wraps everything, then the module the landing URL renders, then the mount
 * point of a client application, then the modules that answer requests, then a
 * server process entry. It is also the order in which they survive the byte
 * budget, since trimming takes from the end.
 */
const ENTRY_POINT_RANKS = Object.freeze({
  document: 0,
  landing: 1,
  mount: 2,
  requestHandler: 3,
  serverEntry: 4,
});

/**
 * The categories a recognised dependency falls into, and their reporting order.
 *
 * Only these four kinds of dependency reach the summary. A target project's
 * manifest holds tens to hundreds of entries, almost all of which say nothing
 * about how it behaves at runtime — a linter, a formatter, a type package, a
 * bundler plugin — and a list of them would spend the byte budget on noise. A
 * framework, a data client, an observability library and the compiler are the
 * four that change what the pipeline can instrument and what a captured trace
 * will contain.
 */
const DEPENDENCY_CATEGORY_ORDER = Object.freeze({
  framework: 0,
  data: 1,
  observability: 2,
  language: 3,
});

/** One category of recognised dependency. */
type DependencyCategory = keyof typeof DEPENDENCY_CATEGORY_ORDER;

/**
 * Dependencies recognised by exact name.
 *
 * Published library names, chosen for what their presence tells the
 * understanding stage: which framework serves the request, which client reaches
 * the data tier, whether the project already produces spans, and whether there
 * is a compiler in the loop.
 */
const RECOGNISED_DEPENDENCIES: Readonly<Record<string, DependencyCategory>> = Object.freeze({
  next: 'framework',
  react: 'framework',
  'react-dom': 'framework',
  'react-native': 'framework',
  preact: 'framework',
  vue: 'framework',
  nuxt: 'framework',
  svelte: 'framework',
  'solid-js': 'framework',
  astro: 'framework',
  gatsby: 'framework',
  express: 'framework',
  fastify: 'framework',
  koa: 'framework',
  hapi: 'framework',
  hono: 'framework',
  prisma: 'data',
  pg: 'data',
  'pg-pool': 'data',
  postgres: 'data',
  mysql: 'data',
  mysql2: 'data',
  sqlite3: 'data',
  'better-sqlite3': 'data',
  mongodb: 'data',
  mongoose: 'data',
  redis: 'data',
  ioredis: 'data',
  knex: 'data',
  kysely: 'data',
  sequelize: 'data',
  typeorm: 'data',
  'drizzle-orm': 'data',
  typescript: 'language',
});

/**
 * Dependencies recognised by scope prefix, for the libraries published as a
 * family of packages.
 */
const RECOGNISED_DEPENDENCY_SCOPES: readonly {
  readonly prefix: string;
  readonly category: DependencyCategory;
}[] = Object.freeze([
  { prefix: '@prisma/', category: 'data' },
  { prefix: '@opentelemetry/', category: 'observability' },
  { prefix: '@remix-run/', category: 'framework' },
  { prefix: '@nestjs/', category: 'framework' },
  { prefix: '@sveltejs/', category: 'framework' },
  { prefix: '@angular/', category: 'framework' },
]);

/** The extensions that make a module a TypeScript module. */
const TYPESCRIPT_EXTENSIONS: readonly string[] = Object.freeze(['.ts', '.tsx', '.mts', '.cts']);

/* -------------------------------------------------------------------------------------------------
 * Manifest view
 * ---------------------------------------------------------------------------------------------- */

/**
 * The part of a target project's `package.json` this module is willing to look
 * at.
 *
 * A **narrow view**, not a manifest type: the fields below are the only ones
 * read, and the fields that are absent are absent on purpose. `scripts` would
 * carry a command line a developer may have put a credential in; `config`,
 * `publishConfig` and `resolutions` carry arbitrary values; `bin` and `exports`
 * carry paths that say nothing about the project's shape. None of them can
 * reach a prompt through a shape that cannot represent them.
 *
 * Every field is optional because every field is optional in a real manifest,
 * and the object as a whole is optional upstream because a project may have no
 * manifest at all — or an unparseable one, which is treated identically.
 */
export interface TargetManifest {
  /**
   * The declared package name, when it is a string.
   */
  readonly name?: string;

  /**
   * The `packageManager` field verbatim, when it is a string: a Corepack
   * specifier such as `'<manager>@1.2.3'`, or a bare manager name.
   *
   * The **target project's** declaration, which is the only authority on the
   * question — the repository the tool itself ships from has its own pin and it
   * is irrelevant to a developer's project.
   */
  readonly packageManager?: string;

  /**
   * Runtime dependencies, name to declared range, with every non-string value
   * dropped.
   */
  readonly dependencies?: Readonly<Record<string, string>>;

  /**
   * Development dependencies, on the same terms as
   * {@link TargetManifest.dependencies}.
   */
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/**
 * Reduces freshly parsed JSON to the narrow {@link TargetManifest} view.
 *
 * Total and structural: it accepts `unknown`, asserts nothing about it, and
 * answers `undefined` for anything that is not a JSON object — an array, a
 * string, `null`, a number. Within an object every field is checked
 * individually, so a manifest whose `name` is a number and whose
 * `dependencies` are well formed yields a view with the dependencies and no
 * name, rather than nothing. Dependency records keep only their string-valued
 * entries, which is what a declared range is.
 *
 * Exported because it is the seam the detectors are tested through: a test
 * builds the manifest object it wants and calls a detector directly, with no
 * project on disk.
 *
 * @param raw Any value, typically the result of `JSON.parse`.
 * @returns The narrow view, or `undefined` when `raw` is not a JSON object.
 */
export function parseManifest(raw: unknown): TargetManifest | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }

  const record: Readonly<Record<string, unknown>> = raw as Readonly<Record<string, unknown>>;
  const view: {
    name?: string;
    packageManager?: string;
    dependencies?: Readonly<Record<string, string>>;
    devDependencies?: Readonly<Record<string, string>>;
  } = {};

  const name = record['name'];
  if (typeof name === 'string' && name.length > 0) {
    view.name = name;
  }

  const packageManager = record['packageManager'];
  if (typeof packageManager === 'string' && packageManager.length > 0) {
    view.packageManager = packageManager;
  }

  const dependencies = stringRecord(record['dependencies']);
  if (dependencies !== undefined) {
    view.dependencies = dependencies;
  }

  const devDependencies = stringRecord(record['devDependencies']);
  if (devDependencies !== undefined) {
    view.devDependencies = devDependencies;
  }

  return view;
}

/**
 * Reads and parses the target project's `package.json`.
 *
 * The **only** file this module opens, and it is opened defensively: the path is
 * resolved inside the project root, screened by `./project.ts`'s exclusion
 * predicates, required to be a regular file whose real path is still inside the
 * root (so a link planted at `package.json` cannot make this function read
 * somewhere else), and required to be smaller than a sane ceiling before a
 * single byte is read. Every failure — absent, unreadable, oversized, not an
 * object, malformed JSON — degrades to `undefined`, is logged at `debug` with
 * the *reason* and never the content, and never throws: a project without a
 * readable manifest is a project this module describes from its disk layout and
 * its graph alone.
 *
 * @param projectRoot The absolute POSIX project root, as
 * `LoadedProject.projectRoot` normalised it.
 * @param logger Where the one diagnostic line goes; defaults to no logging.
 * @returns The narrow view, or `undefined` when no manifest could be read.
 */
export function readTargetManifest(
  projectRoot: string,
  logger: Logger = noopLogger,
): TargetManifest | undefined {
  const resolved = resolveProjectPath(projectRoot, canonicalRootOf(projectRoot), MANIFEST_BASENAME);
  if (resolved === undefined) {
    logger.debug('project manifest was not resolvable inside the project root', { projectRoot });
    return undefined;
  }

  let text: string;
  try {
    const stats = statSync(resolved, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile()) {
      logger.debug('project declares no manifest', { projectRoot });
      return undefined;
    }
    if (stats.size > MAX_MANIFEST_BYTES) {
      logger.debug('project manifest is larger than this module will read', {
        projectRoot,
        size: stats.size,
        limit: MAX_MANIFEST_BYTES,
      });
      return undefined;
    }
    text = readFileSync(resolved, 'utf8');
  } catch {
    // An unreadable manifest is an answer, not a fault: a permission error, a
    // file replaced between the stat and the read, a directory where a file was
    // expected. The summary degrades to what the disk and the graph say.
    logger.debug('project manifest could not be read', { projectRoot });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.debug('project manifest is not valid JSON', { projectRoot });
    return undefined;
  }

  const view = parseManifest(parsed);
  if (view === undefined) {
    logger.debug('project manifest is not a JSON object', { projectRoot });
  }
  return view;
}

/* -------------------------------------------------------------------------------------------------
 * Existence probing
 * ---------------------------------------------------------------------------------------------- */

/**
 * The two existence questions the detectors ask about a project's disk layout.
 *
 * An interface rather than two loose predicates so that a test can drive a
 * detector with a fake layout in three lines, and so that the *only* place this
 * module touches the filesystem for anything other than the manifest is
 * {@link createProjectProbe}.
 *
 * Both members take a **project-relative POSIX path** and answer a boolean.
 * Neither ever throws, and neither reveals anything beyond existence: no size,
 * no time, no content, no absolute path.
 */
export interface ProjectProbe {
  /**
   * Whether a regular file exists at `path`, relative to the project root.
   *
   * @param path A project-relative POSIX path.
   * @returns `true` only for an existing regular file this module is allowed to
   * look at.
   */
  fileExists(path: string): boolean;

  /**
   * Whether a directory exists at `path`, relative to the project root.
   *
   * @param path A project-relative POSIX path.
   * @returns `true` only for an existing directory this module is allowed to
   * look at.
   */
  directoryExists(path: string): boolean;
}

/**
 * The filesystem-backed probe for one project.
 *
 * Four refusals are built in, and each is a boundary this module is not allowed
 * to cross:
 *
 * 1. A path that is not a safe project-relative path — absolute (in either
 *    slash direction), a traversal, a control character — is refused without a
 *    system call. Separators are converted with `toPosix` first, exactly as
 *    `@debuggen/shared`'s `isSafeRelativePath` requires of its callers, so a
 *    path written with the other separator names the same file while a
 *    traversal written that way is still a traversal and still refused.
 * 2. A path that does not resolve inside the project root is refused.
 * 3. An environment file is refused ({@link isEnvFilePath}), so `.env` and
 *    every qualified variant cannot even be probed for.
 * 4. A path inside an excluded tree is refused ({@link shouldExcludePath}), so
 *    an installed dependency's or a build output's layout is never inspected.
 *
 * A refusal and a genuine absence are both `false`: a caller of a probe is
 * asking about the project's shape, not auditing it, and the distinction is
 * logged at `trace` for the one case where it matters to a developer debugging
 * detection.
 *
 * @param projectRoot The absolute POSIX project root.
 * @param logger Where refusals are traced; defaults to no logging.
 * @returns A probe bound to that root.
 */
export function createProjectProbe(projectRoot: string, logger: Logger = noopLogger): ProjectProbe {
  const canonicalRoot = canonicalRootOf(projectRoot);

  const entryMatches = (path: string, wantDirectory: boolean): boolean => {
    const resolved = resolveProjectPath(projectRoot, canonicalRoot, path);
    if (resolved === undefined) {
      logger.trace('probe refused a path outside what this module may inspect', { path });
      return false;
    }

    try {
      const stats = statSync(resolved, { throwIfNoEntry: false });
      if (stats === undefined) {
        return false;
      }
      return wantDirectory ? stats.isDirectory() : stats.isFile();
    } catch {
      return false;
    }
  };

  return Object.freeze({
    fileExists: (path: string): boolean => entryMatches(path, false),
    directoryExists: (path: string): boolean => entryMatches(path, true),
  });
}

/* -------------------------------------------------------------------------------------------------
 * Detectors
 *
 * Four independently testable functions, each taking the narrowest input that
 * can answer its question — a parsed manifest, an existence probe, the route
 * map, the graph — and each returning the explicit "nothing settled this"
 * member of its vocabulary rather than a guess.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Which framework the project uses, and the version range it declares.
 *
 * Three signals, checked in this order, and the first one that fires decides:
 *
 * 1. **The manifest declares the framework.** The strongest signal and the only
 *    one that also yields a version, which is reported as the **declared range
 *    string** and never as an installed version — resolving into
 *    `node_modules` would read a tree that may be absent, stale or pruned, and
 *    the range is what the project actually claims.
 * 2. **A framework configuration module exists on disk.** What a project whose
 *    dependencies were never installed still has.
 * 3. **A router tree exists, holding the framework's own conventional module.**
 *    The directory alone is deliberately not enough: a directory named `app` or
 *    `pages` is ordinary in applications that have nothing to do with this
 *    framework, and reporting one of those as a framework project would send
 *    the understanding stage looking for route modules that do not exist. A
 *    directory that holds a document, landing or shell module of the
 *    convention is a different matter.
 *
 * Only then is the view library considered, which reports a client application
 * with no framework around it. When nothing fires the answer is `'unknown'`:
 * the vocabulary in `./graph/types.ts` has three members and no member for
 * "plain runtime project", and its own documentation prescribes the honest
 * `'unknown'` over a guess, because a wrong framework is worse for the stage
 * that reads this field than an absent one.
 *
 * @param manifest The parsed manifest view, or `undefined` when there is none.
 * @param probe The project's existence probe.
 * @returns The framework and, when a manifest declared it, its version range.
 */
export function detectFramework(
  manifest: TargetManifest | undefined,
  probe: ProjectProbe,
): FrameworkInfo {
  const declared = declaredRange(manifest, FRAMEWORK_PACKAGE);
  if (declared !== undefined) {
    return { name: 'next', version: declared };
  }

  for (const config of FRAMEWORK_CONFIG_FILES) {
    if (probe.fileExists(config)) {
      return { name: 'next' };
    }
  }

  const trees = routerTreeSignal(probe);
  if (trees.app || trees.pages) {
    return { name: 'next' };
  }

  for (const viewPackage of VIEW_PACKAGES) {
    const viewRange = declaredRange(manifest, viewPackage);
    if (viewRange !== undefined) {
      return { name: 'react', version: viewRange };
    }
  }

  return { name: 'unknown' };
}

/**
 * Which router conventions the project uses.
 *
 * The union of two independent signals, because either one alone can be right
 * and wrong in a different way:
 *
 * - **The route map.** Authoritative about routes that exist: every entry
 *   carries the convention its module belongs to, derived by the one algorithm
 *   in `./route-map.ts`. It is silent about a tree that holds no routable
 *   module yet — a migration that has moved the document but not the pages.
 * - **The trees on disk.** A router directory holding that convention's own
 *   conventional module, checked exactly as {@link detectFramework} checks it.
 *   Present before the first route is written, and independent of whether the
 *   caller supplied a route map at all.
 *
 * A project where both conventions appear is `'hybrid'`, which is the normal
 * state of a codebase mid-migration rather than an edge case, and reporting it
 * as either pure flavour would hide half of its request surface from the
 * investigation.
 *
 * @param routeMap The project's route map, or `undefined` when none was built.
 * @param probe The project's existence probe.
 * @returns The router style; `'none'` when neither signal fires.
 */
export function detectRouterStyle(
  routeMap: RouteMap | undefined,
  probe: ProjectProbe,
): RouterStyle {
  const trees = routerTreeSignal(probe);
  let app = trees.app;
  let pages = trees.pages;

  for (const entry of routeMap?.entries ?? []) {
    if (entry.router === 'app') {
      app = true;
    } else {
      pages = true;
    }
    if (app && pages) {
      break;
    }
  }

  if (app && pages) {
    return 'hybrid';
  }
  if (app) {
    return 'app';
  }
  if (pages) {
    return 'pages';
  }
  return 'none';
}

/**
 * The workspace root's manifest and probe, for
 * {@link detectPackageManager}'s fallback.
 *
 * The pair rather than a root path, because this detector — like every other
 * one in this module — performs no filesystem access of its own: a caller that
 * has established a workspace root with `./project.ts`'s `findWorkspaceRoot`
 * builds the same two inputs it already builds for the target
 * ({@link readTargetManifest}, {@link createProjectProbe}) against that root
 * and passes them here, and a test builds them from a literal object and a
 * three-line fake probe.
 */
export interface WorkspacePackageManagerFallback {
  /**
   * The workspace root's parsed manifest, or `undefined` when it has none that
   * could be read.
   *
   * **Only its `packageManager` field is consulted.** Nothing else from a
   * workspace root may reach the summary: its dependencies are not the target's
   * dependencies, its name is not the target's name, and neither is offered to
   * {@link detectFramework}, `collectDependencies` or the project name.
   */
  readonly manifest?: TargetManifest | undefined;

  /** An existence probe bound to the workspace root, for its lockfiles. */
  readonly probe: ProjectProbe;
}

/**
 * Which package manager the project uses.
 *
 * **The target project's own declaration wins over everything else**, which is
 * the whole point of this detector: the repository this tool ships from pins a
 * manager of its own, and it says nothing about a developer's project. A
 * Corepack specifier (`'<manager>@1.2.3'`) and a bare manager name are both
 * read; the version part is discarded, since the vocabulary names managers
 * rather than releases.
 *
 * A declaration this module does not recognise is *not* evidence for any of the
 * four managers, so detection falls through to the lockfiles exactly as if the
 * field were absent.
 *
 * Lockfiles are then counted rather than ranked. One lockfile identifies its
 * manager; **two or more identify nothing** and the answer is `'unknown'`,
 * because a tree carrying the lockfiles of two managers is genuinely ambiguous
 * — a migration that left the old one behind — and the parts of the product
 * that read this field *suggest a command line* to the developer. An honest
 * `'unknown'` costs a prompt; a wrong guess costs a failed command.
 *
 * ## Resolution order
 *
 * 1. The **target's own** `packageManager` declaration.
 * 2. The **target's own** lockfiles, under the counting rule above.
 * 3. The **workspace root's** `packageManager` declaration, when `workspace` is
 *    supplied.
 * 4. The **workspace root's** lockfiles, under the same counting rule.
 * 5. `'unknown'`.
 *
 * Steps 3 and 4 exist because a monorepo keeps its lockfile and its pin at the
 * repository root: a target that is one workspace member — `apps/<name>`,
 * which is the shape of this product's own demo target and of most projects a
 * developer opens in a monorepo — declares neither of its own, and answering
 * `'unknown'` for it leaves the dev-server launcher (AAP 0.7.1 Group 2) with no
 * manager to form a relaunch command from and hands Stage 1 a project summary
 * that knows less than the repository does.
 *
 * The target's own declaration still wins over its workspace root's, and the
 * order is not a preference for the nearer file: a member that pins its own
 * manager is stating something *about itself*, deliberately and against the
 * root's default, and a tool that overrode it would break the one project that
 * took the trouble to say so. The root is consulted only where the member is
 * silent, which is what "fallback" means here.
 *
 * ## Why this cannot report an unrelated repository's manager
 *
 * The `workspace` pair is only ever built for a root that `findWorkspaceRoot`
 * accepted, and that function accepts an ancestor **only when the project
 * matches one of the member patterns that ancestor declares**. A project merely
 * nested beneath a monorepo — a fixture application under
 * `packages/<name>/test/fixtures/<app>`, or a developer's own project inside a
 * checkout of this very repository — matches no pattern, so no pair is built
 * and the answer stays `'unknown'`. That membership check is what keeps this
 * fallback from becoming "the nearest lockfile upwards", which would report
 * this tool's own pin for a project it has nothing to do with.
 *
 * @param manifest The parsed manifest view, or `undefined` when there is none.
 * @param probe The project's existence probe.
 * @param workspace The workspace root's manifest and probe, when the project is
 * a member of one. Omitted — as every two-argument call omits it — detection
 * stops at step 2 and behaves exactly as it always has.
 * @returns The manager, or `'unknown'` when nothing settles it.
 *
 * @example
 * ```ts
 * // A workspace member with no pin and no lockfile of its own.
 * detectPackageManager(memberManifest, memberProbe); // 'unknown'
 * detectPackageManager(memberManifest, memberProbe, {
 *   manifest: rootManifest, // { packageManager: 'pnpm@12.4.2' }
 *   probe: rootProbe,
 * }); // 'pnpm'
 * ```
 */
export function detectPackageManager(
  manifest: TargetManifest | undefined,
  probe: ProjectProbe,
  workspace?: WorkspacePackageManagerFallback,
): PackageManagerName {
  const declared = declaredPackageManager(manifest?.packageManager);
  if (declared !== undefined) {
    return declared;
  }

  const ownLockfile = lockfileManager(probe);
  if (ownLockfile !== undefined) {
    return ownLockfile;
  }

  if (workspace === undefined) {
    return 'unknown';
  }

  const declaredByWorkspace = declaredPackageManager(workspace.manifest?.packageManager);
  if (declaredByWorkspace !== undefined) {
    return declaredByWorkspace;
  }

  return lockfileManager(workspace.probe) ?? 'unknown';
}

/**
 * How the project reaches its database.
 *
 * ## The style comes from call sites, and only from call sites
 *
 * {@link DatabaseAccessInfo} documents that its `callSiteCount` is `0` exactly
 * when its `style` is `'none'`, which makes the two fields one fact and settles
 * where that fact may come from: the graph's `db-call` nodes and their recorded
 * driver. A declared dependency is not access — a project can declare a client
 * it no longer calls — and neither is a schema file on disk. Raising the style
 * from either would produce `style: 'prisma'` with no call sites, contradicting
 * the type, and would make the Prisma and Postgres adapters require a
 * dev-server preload for a session whose capture could never contain a database
 * span (AAP 0.7.1 Group 1). Without a graph, therefore, the answer is `'none'`
 * with a count of zero: "no database call sites were found" is exactly what a
 * summary built from a manifest alone knows.
 *
 * ## What the manifest and the schema file are for
 *
 * They corroborate the *module identification*, not the style. A module is
 * named as constructing the client or the pool when it imports the library's
 * construction binding from a recognised specifier; when the import's bindings
 * could not be read but the project declares the library — or carries its
 * schema file — the import alone is accepted. Neither signal can name a module
 * on its own, and a driver with no call sites is never given a module at all.
 *
 * ## Which module is reported when several qualify
 *
 * A project routinely constructs the same handle more than once: the shared
 * module the application imports, and a seed or maintenance script that builds
 * its own. Only the first is the module a developer means by "where the client
 * lives" — the script runs in a process of its own, never inside the dev server
 * whose queries an investigation observes — so qualifying modules are ranked:
 * an application module that another application module imports, then any
 * other application module, then a module the project runs from its own tooling
 * ({@link isToolingModulePath}). Within a rank the lexicographically first
 * project-relative path wins, so the answer is stable across runs, and a project
 * whose only construction site is a tooling module still reports it. A path
 * that is not a safe project-relative path is skipped.
 *
 * @param graph The project's code graph, or `undefined` when none was built.
 * @param manifest The parsed manifest view, or `undefined` when there is none.
 * @param probe The project's existence probe.
 * @returns The access description; `{ style: 'none', callSiteCount: 0 }` when
 * no call site was found.
 */
export function detectDatabaseAccess(
  graph: CodeGraph | undefined,
  manifest: TargetManifest | undefined,
  probe: ProjectProbe,
): DatabaseAccessInfo {
  if (graph === undefined) {
    return { style: 'none', callSiteCount: 0 };
  }

  const calls = graph.nodesByKind('db-call');
  let prismaCalls = 0;
  let pgCalls = 0;
  for (const call of calls) {
    if (call.data.driver === 'prisma') {
      prismaCalls += 1;
    } else {
      pgCalls += 1;
    }
  }

  const style: DatabaseAccessStyle =
    prismaCalls > 0 && pgCalls > 0
      ? 'both'
      : prismaCalls > 0
        ? 'prisma'
        : pgCalls > 0
          ? 'pg'
          : 'none';

  const info: {
    style: DatabaseAccessStyle;
    prismaClientModule?: string;
    pgPoolModule?: string;
    callSiteCount: number;
  } = { style, callSiteCount: calls.length };

  if (prismaCalls > 0) {
    const corroborated =
      declaresAnyOf(manifest, PRISMA_PACKAGES) || probe.fileExists(PRISMA_SCHEMA_FILE);
    const module = findConstructionModule(graph, 'prisma', corroborated);
    if (module !== undefined) {
      info.prismaClientModule = module;
    }
  }

  if (pgCalls > 0) {
    const corroborated = declaresAnyOf(manifest, PG_PACKAGES);
    const module = findConstructionModule(graph, 'pg', corroborated);
    if (module !== undefined) {
      info.pgPoolModule = module;
    }
  }

  return info;
}

/**
 * Whether a project-relative POSIX path names a module the project runs from
 * its own tooling rather than inside the application.
 *
 * ## Why the distinction matters
 *
 * Database query spans are runtime hooks the Node preload installs inside the
 * **dev-server process** only. A seed, migration, operational script, test or
 * configuration module runs in a process of its own — the ORM's seed command,
 * a test runner, a command-line tool reading its configuration — so no query
 * it issues can ever be observed by a capture, and an instrumentation plan
 * anchored on one promises evidence that never arrives.
 * {@link detectDatabaseAccess} uses this classifier to prefer the application's
 * shared handle module over a script that builds its own, and the Prisma and
 * Postgres adapters of `@debuggen/instrumentation` use it to leave such modules
 * out of the query sites they anchor on.
 *
 * ## The rule
 *
 * Conservative on purpose, and built from published tool conventions only —
 * never from anything a particular project chose. A path is a tooling module
 * when any of these holds:
 *
 * | Signal | Examples |
 * | --- | --- |
 * | the basename, up to its first dot, is exactly `seed` or `seeds` | `prisma/seed.ts`, `db/seeds.mjs` |
 * | a directory segment is `seed`, `seeds`, `migrations`, `__tests__`, `__mocks__` or `__fixtures__` | `db/seeds/accounts.ts`, `db/migrations/0001.ts`, `src/__tests__/cart.ts` |
 * | the top-level directory is `scripts`, `script`, `test`, `tests` or `e2e` | `scripts/load.ts`, `tests/cart.ts` |
 * | an inner basename part is `test`, `spec`, `stories` or `config` | `cart.test.ts`, `next.config.ts` |
 *
 * Everything else is application code, including names that merely share a
 * prefix (`src/seedling.ts`, `src/lib/seed-utils.ts`), a stem or extension that
 * happens to be a marker word (`src/config.ts`, `src/test.ts`) and a nested
 * directory whose top-level meaning does not carry (`src/scripts/editor.ts`).
 * Matching is case-sensitive, because every convention is spelled in lower case
 * by the tool that defines it, and a component module named `Seed.tsx` is
 * application code.
 *
 * The one trade-off the rule accepts: a module the dev server itself serves
 * from a seed-named path — a request handler under a `seed` directory — is
 * classified as tooling too. Telling it apart would need the router's view of
 * the tree, which a path classifier does not have, and the cost is bounded:
 * the database instrumentation is process-wide, so that handler's queries are
 * still captured whenever any other anchor arms the signal.
 *
 * Total over strings and never throws: backslash separators are converted,
 * empty and `.` segments are ignored, and an empty path is not a tooling
 * module.
 *
 * @param file A project-relative POSIX path, as graph nodes carry it.
 * @returns `true` when the module is run by the project's own tooling.
 *
 * @example
 * ```ts
 * isToolingModulePath('prisma/seed.ts'); // true
 * isToolingModulePath('scripts/load.ts'); // true
 * isToolingModulePath('src/server/db/client.ts'); // false
 * ```
 */
export function isToolingModulePath(file: string): boolean {
  const segments = toPosix(file)
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
  const basename = segments.at(-1);
  if (basename === undefined) {
    return false;
  }

  const directories = segments.slice(0, -1);
  const [topLevel] = directories;
  if (topLevel !== undefined && TOP_LEVEL_TOOLING_DIRECTORIES.includes(topLevel)) {
    return true;
  }
  if (
    directories.some(
      (directory) => SEED_NAMES.includes(directory) || TOOLING_DIRECTORY_NAMES.includes(directory),
    )
  ) {
    return true;
  }

  const parts = basename.split('.');
  const [stem] = parts;
  if (stem !== undefined && SEED_NAMES.includes(stem)) {
    return true;
  }
  return parts.slice(1, -1).some((part) => TOOLING_BASENAME_MARKERS.includes(part));
}

/* -------------------------------------------------------------------------------------------------
 * The summary
 * ---------------------------------------------------------------------------------------------- */

/**
 * Everything {@link summarizeProject} works from.
 *
 * Only {@link SummarizeProjectInput.loaded} is required, and the summary
 * degrades gracefully as the optional inputs are withheld: without a graph the
 * counts are what the loaded file set supports and the database style is
 * `'none'`; without a route map the routes are read from the graph's route
 * nodes, or are empty when there is neither. Every optional member spells
 * `| undefined` explicitly because the repository compiles with
 * `exactOptionalPropertyTypes`, so a caller forwarding a value it received as
 * possibly-undefined can pass it without branching first.
 */
export interface SummarizeProjectInput {
  /**
   * The opened target project: the root, the configuration in force and the
   * indexable file set.
   *
   * The identity and the disk-layout signals come from here, and
   * `LoadedProject.projectRelative` is what every path in the summary is
   * reduced with.
   */
  readonly loaded: LoadedProject;

  /**
   * The project's index, when one is at hand.
   *
   * Used only when {@link SummarizeProjectInput.graph} is absent, in which case
   * a graph is built from it. Supplying the graph instead avoids that work; a
   * caller that has just persisted an index and holds no graph supplies this.
   */
  readonly index?: CodeIndex | undefined;

  /**
   * The project's graph, when one is at hand.
   *
   * The source of every count, of the database style, and of the routes when no
   * route map is supplied. Takes precedence over
   * {@link SummarizeProjectInput.index}.
   */
  readonly graph?: CodeGraph | undefined;

  /**
   * The project's route map, when one is at hand.
   *
   * The authoritative route inventory and the primary router-style signal.
   */
  readonly routeMap?: RouteMap | undefined;

  /**
   * Caps to apply instead of {@link PROJECT_SUMMARY_LIMITS}.
   *
   * Merged field by field; an entry that is not a non-negative finite number is
   * ignored in favour of the default, so a caller cannot accidentally disable
   * the budget with a `NaN`.
   */
  readonly limits?: Partial<ProjectSummaryLimits> | undefined;

  /**
   * Where this module's diagnostics go; defaults to no logging.
   *
   * Only shapes and magnitudes are logged — a count, a limit, a reason — never
   * a file's content and never a value read out of the manifest beyond what the
   * summary itself carries.
   */
  readonly logger?: Logger | undefined;
}

/**
 * Builds the bounded, honest description of a target project that the
 * problem-understanding stage reasons about.
 *
 * ## What it does, in order
 *
 * 1. Resolves the caps, and builds the existence probe and the manifest view —
 *    the two filesystem touches every summary makes.
 * 2. Runs the four detectors over those two inputs plus the graph and the route
 *    map. One of them, {@link detectPackageManager}, is additionally given the
 *    project's workspace root when it has one (`./project.ts`'s
 *    {@link findWorkspaceRoot}, then that root's own manifest and probe), which
 *    is the only work in this function that looks *above* the project root and
 *    the only reason it is done: a workspace member declares neither a
 *    `packageManager` pin nor a lockfile of its own.
 * 3. Projects the four capped lists — entry points, routes, notable
 *    directories, recognised dependencies — each with a documented total order,
 *    each path validated as a safe project-relative path.
 * 4. Counts what the graph holds, uncapped.
 * 5. Enforces the serialised byte budget by trimming the lowest-value lists
 *    first, and reports the result in `truncated`.
 *
 * ## Purity
 *
 * Nothing is cached, nothing is memoised and no input is mutated: the loaded
 * project, the graph, the route map and the limits object are read only, and
 * every array in the result is a fresh frozen array. Two calls therefore cost
 * twice as much as one and agree on every field except `generatedAt` — the same
 * single determinism exemption `CodeIndex` documents for its own timestamp,
 * which is why a test that pins the summary byte for byte normalises that one
 * field.
 *
 * ## Why `projectRoot` is exempt from the string clamp
 *
 * It is the anchor every relative path in the object is resolved against, and a
 * truncated anchor names a directory that does not exist. Clamping it would
 * turn an oversized path into a silently wrong one, so it is carried verbatim
 * from `LoadedProject.projectRoot`, exactly as `CodeIndex.projectRoot` is.
 *
 * @param input The project and the optional artefacts to describe it from.
 * @returns The summary. Never throws for any project it can be given: an
 * unreadable manifest, an empty file set, a graph with no nodes and a project
 * with no routes all produce a valid summary that says so.
 */
export function summarizeProject(input: SummarizeProjectInput): ProjectSummary {
  const logger = input.logger ?? noopLogger;
  const limits = resolveLimits(input.limits);
  const { loaded } = input;
  const projectRoot = loaded.projectRoot;

  const probe = createProjectProbe(projectRoot, logger);
  const manifest = readTargetManifest(projectRoot, logger);
  const graph = resolveGraph(input, logger);
  const routeMap = input.routeMap;
  const files = projectFiles(loaded, graph);

  const framework = detectFramework(manifest, probe);
  const routerStyle = detectRouterStyle(routeMap, probe);
  const packageManager = detectPackageManager(
    manifest,
    probe,
    workspacePackageManagerFallback(projectRoot, logger),
  );
  const databaseAccess = withinPathBudget(
    detectDatabaseAccess(graph, manifest, probe),
    limits.maxStringLength,
  );
  const typescript = describeTypeScript(loaded, manifest, files, limits);
  const counts = describeCounts(graph, routeMap, files);

  const routeCandidates = collectRoutes(routeMap, graph, limits);
  const entryPointCandidates = collectEntryPoints(files, routeCandidates, limits);
  const directoryCandidates = collectDirectories(files, limits);
  const dependencyCandidates = collectDependencies(manifest, limits);

  const entryPoints = entryPointCandidates.slice(0, limits.maxEntryPoints);
  const routes = routeCandidates.slice(0, limits.maxRoutes);
  const notableDirectories = directoryCandidates.slice(0, limits.maxDirectories);
  const dependencies = dependencyCandidates.slice(0, limits.maxDependencies);

  let truncated =
    entryPoints.length < entryPointCandidates.length ||
    routes.length < routeCandidates.length ||
    notableDirectories.length < directoryCandidates.length ||
    dependencies.length < dependencyCandidates.length;

  const lists: MutableLists = { entryPoints, routes, notableDirectories, dependencies };
  const name = projectName(manifest, projectRoot, limits);

  const build = (): ProjectSummary => ({
    projectRoot,
    projectName: name,
    framework,
    routerStyle,
    typescript,
    packageManager,
    databaseAccess,
    entryPoints: Object.freeze([...lists.entryPoints]),
    routes: Object.freeze([...lists.routes]),
    notableDirectories: Object.freeze([...lists.notableDirectories]),
    dependencies: Object.freeze([...lists.dependencies]),
    counts,
    truncated,
    generatedAt: nowEpochMs(),
  });

  let summary = build();

  // The byte budget is the last word: the per-list caps bound how many items a
  // summary holds, and only a measurement of the serialised object bounds how
  // large it is. Items are given up from the lowest-value list first (see
  // `dropLowestValueItem`), one at a time so that no more is discarded than the
  // budget actually requires.
  while (serializedLength(summary) > limits.maxTotalBytes) {
    const droppedFrom = dropLowestValueItem(lists);
    if (droppedFrom === undefined) {
      logger.warn('project summary exceeds its byte budget with every list already empty', {
        bytes: serializedLength(summary),
        limit: limits.maxTotalBytes,
      });
      break;
    }
    truncated = true;
    summary = build();
  }

  logger.debug('project summary built', {
    framework: framework.name,
    routerStyle,
    packageManager,
    databaseStyle: databaseAccess.style,
    entryPoints: summary.entryPoints.length,
    routes: summary.routes.length,
    notableDirectories: summary.notableDirectories.length,
    dependencies: summary.dependencies.length,
    bytes: serializedLength(summary),
    truncated: summary.truncated,
  });

  return Object.freeze(summary);
}

/* -------------------------------------------------------------------------------------------------
 * Internals
 * ---------------------------------------------------------------------------------------------- */

/** The empty dependency list, shared so that the common case allocates nothing. */
const EMPTY_DEPENDENCIES: readonly ProjectDependencyRef[] = Object.freeze([]);

/**
 * The four capped lists while the byte budget is being enforced.
 *
 * Mutable by design and scoped to one call of {@link summarizeProject}: the
 * arrays are the ones that call sliced from its own candidates, never anything
 * a caller passed in, and the frozen copies handed out in the result are taken
 * from them afresh on every rebuild.
 */
interface MutableLists {
  entryPoints: string[];
  routes: ProjectSummaryRouteRef[];
  notableDirectories: string[];
  dependencies: ProjectDependencyRef[];
}

/**
 * Merges caller overrides onto {@link PROJECT_SUMMARY_LIMITS}.
 *
 * An override that is not a finite number is ignored in favour of the default,
 * and every value is floored to an integer and held at or above its minimum, so
 * no combination of inputs can disable a cap: a `NaN`, an `Infinity` or a
 * negative count would otherwise turn a bounded summary into an unbounded one,
 * which is the single failure this module exists to prevent.
 *
 * @param overrides The caller's partial limits, or `undefined`.
 * @returns The effective limits.
 */
function resolveLimits(overrides: Partial<ProjectSummaryLimits> | undefined): ProjectSummaryLimits {
  if (overrides === undefined) {
    return PROJECT_SUMMARY_LIMITS;
  }

  return Object.freeze({
    maxEntryPoints: limitOr(overrides.maxEntryPoints, PROJECT_SUMMARY_LIMITS.maxEntryPoints, 0),
    maxRoutes: limitOr(overrides.maxRoutes, PROJECT_SUMMARY_LIMITS.maxRoutes, 0),
    maxDirectories: limitOr(overrides.maxDirectories, PROJECT_SUMMARY_LIMITS.maxDirectories, 0),
    maxDependencies: limitOr(overrides.maxDependencies, PROJECT_SUMMARY_LIMITS.maxDependencies, 0),
    maxStringLength: limitOr(overrides.maxStringLength, PROJECT_SUMMARY_LIMITS.maxStringLength, 1),
    maxTotalBytes: limitOr(overrides.maxTotalBytes, PROJECT_SUMMARY_LIMITS.maxTotalBytes, 1),
  });
}

/**
 * One limit, forced onto the integer domain at or above its minimum.
 *
 * @param value The caller's value, possibly absent or unusable.
 * @param fallback The default to use when it is unusable.
 * @param minimum The smallest value that keeps the summary well formed.
 * @returns The effective value.
 */
function limitOr(value: number | undefined, fallback: number, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored < minimum ? minimum : floored;
}

/**
 * The graph to describe: the supplied one, one built from the supplied index, or
 * none.
 *
 * @param input The summarisation input.
 * @param logger Where graph construction reports its own findings.
 * @returns The graph, or `undefined` when neither a graph nor an index was
 * supplied.
 */
function resolveGraph(input: SummarizeProjectInput, logger: Logger): CodeGraph | undefined {
  if (input.graph !== undefined) {
    return input.graph;
  }
  if (input.index === undefined) {
    return undefined;
  }
  return CodeGraph.fromIndex(input.index, { logger });
}

/**
 * The project's file set as project-relative POSIX paths, sorted and unique.
 *
 * The **union** of the opened project's own file set — reduced through
 * `LoadedProject.projectRelative` — and the graph's `file` nodes, which are
 * project-relative already. The union rather than either source alone, because
 * each can legitimately hold what the other does not: a graph may be *partial*
 * (an index built for a subset, or one whose extractors emitted a node only for
 * the files they had something to say about), and taking it as the file set
 * would shrink the layout the summary describes to whatever the index happened
 * to cover; the opened project, conversely, is authoritative about what exists
 * on disk but knows nothing of an index read back from the cache without a
 * compiler.
 *
 * A path that is not a safe project-relative path is dropped, which is the last
 * place such a path could enter the summary.
 *
 * @param loaded The opened project.
 * @param graph The graph, when there is one.
 * @returns The sorted, unique file set.
 */
function projectFiles(loaded: LoadedProject, graph: CodeGraph | undefined): readonly string[] {
  const unique = new Set<string>();

  for (const sourceFile of loaded.sourceFiles()) {
    const relative = loaded.projectRelative(toPosix(sourceFile.getFilePath()));
    if (relative !== undefined && isSafeRelativePath(relative)) {
      unique.add(relative);
    }
  }

  for (const node of graph?.nodesByKind('file') ?? []) {
    if (isSafeRelativePath(node.file)) {
      unique.add(node.file);
    }
  }

  return Object.freeze([...unique].sort(compareStrings));
}

/**
 * The project's label: its declared name, else its root directory's name.
 *
 * @param manifest The manifest view, when one was read.
 * @param projectRoot The absolute project root.
 * @param limits The effective limits.
 * @returns A non-empty clamped label.
 */
function projectName(
  manifest: TargetManifest | undefined,
  projectRoot: string,
  limits: ProjectSummaryLimits,
): string {
  const declared = manifest?.name?.trim();
  if (declared !== undefined && declared.length > 0) {
    return clampText(declared, limits.maxStringLength);
  }

  const directory = basenamePosix(projectRoot);
  return clampText(directory.length > 0 ? directory : projectRoot, limits.maxStringLength);
}

/**
 * What the project's TypeScript setup looks like.
 *
 * `enabled` is true when a configuration was found *or* the file set holds a
 * TypeScript module, so a project compiled by a bundler with no `tsconfig.json`
 * of its own is still reported as using TypeScript. `strict` and `tsConfigFile`
 * are reported only when a configuration was actually read — the condition
 * `LoadedProject.tsConfigFilePath` reports — because without one there is
 * nothing to describe, and `strict` is read from the compiler options in force
 * rather than from the configuration file's text, so an inherited value is
 * reported as what it resolves to.
 *
 * @param loaded The opened project.
 * @param manifest The manifest view, when one was read.
 * @param files The project's file set.
 * @param limits The effective limits.
 * @returns The TypeScript description.
 */
function describeTypeScript(
  loaded: LoadedProject,
  manifest: TargetManifest | undefined,
  files: readonly string[],
  limits: ProjectSummaryLimits,
): TypeScriptInfo {
  const configPath = loaded.tsConfigFilePath;
  const hasTypeScriptModule = files.some((file) =>
    TYPESCRIPT_EXTENSIONS.includes(extnamePosix(file).toLowerCase()),
  );

  const info: { enabled: boolean; version?: string; strict?: boolean; tsConfigFile?: string } = {
    enabled: configPath !== undefined || hasTypeScriptModule,
  };

  const declared = declaredRange(manifest, TYPESCRIPT_PACKAGE);
  if (declared !== undefined) {
    info.version = clampText(declared, limits.maxStringLength);
  }

  if (configPath !== undefined) {
    info.strict = loaded.project.getCompilerOptions().strict === true;

    const relativeConfig = safePath(
      loaded.projectRelative(toPosix(configPath)),
      limits.maxStringLength,
    );
    if (relativeConfig !== undefined) {
      info.tsConfigFile = relativeConfig;
    }
  }

  return info;
}

/**
 * How many nodes of each kind the index holds.
 *
 * Never capped: these magnitudes are how a consumer knows the size of what the
 * capped lists are a sample of. With a graph they are its per-kind bucket
 * sizes. Without one they are what the summary can still say honestly — the
 * loaded file set's size, and the route inventory's size when a route map was
 * supplied — and `0` everywhere else, which is the true count of nodes held by
 * an index that does not exist rather than a stand-in for "unknown".
 *
 * @param graph The graph, when there is one.
 * @param routeMap The route map, when there is one.
 * @param files The project's file set.
 * @returns The counts.
 */
function describeCounts(
  graph: CodeGraph | undefined,
  routeMap: RouteMap | undefined,
  files: readonly string[],
): ProjectSummaryCounts {
  if (graph === undefined) {
    return {
      files: files.length,
      symbols: 0,
      components: 0,
      handlers: 0,
      apiCalls: 0,
      apiRoutes: routeMap?.entries.length ?? 0,
      serverFunctions: 0,
      dbCalls: 0,
    };
  }

  return {
    files: graph.nodesByKind('file').length,
    symbols: graph.nodesByKind('symbol').length,
    components: graph.nodesByKind('component').length,
    handlers: graph.nodesByKind('handler').length,
    apiCalls: graph.nodesByKind('api-call').length,
    apiRoutes: graph.nodesByKind('api-route').length,
    serverFunctions: graph.nodesByKind('server-function').length,
    dbCalls: graph.nodesByKind('db-call').length,
  };
}

/**
 * The modules a developer would recognise as ways into the project, ranked.
 *
 * Two sources, and both are evidence rather than convention-by-name-alone: the
 * project's own file set, classified against the framework conventions by
 * {@link conventionalEntryRank}, and the route inventory, whose request
 * handlers are entry points by definition. A file is listed once, at its
 * strongest rank, and the order is `(rank, path)` — which is both the order a
 * reader wants and the order in which entries survive the byte budget, since
 * trimming takes from the end.
 *
 * @param files The project's file set.
 * @param routes The route inventory, already ordered and validated.
 * @param limits The effective limits.
 * @returns The ranked, deduplicated candidate list, uncapped.
 */
function collectEntryPoints(
  files: readonly string[],
  routes: readonly ProjectSummaryRouteRef[],
  limits: ProjectSummaryLimits,
): readonly string[] {
  const ranked = new Map<string, number>();

  const consider = (file: string, rank: number): void => {
    if (!isSafeRelativePath(file) || file.length > limits.maxStringLength) {
      return;
    }
    const existing = ranked.get(file);
    if (existing === undefined || rank < existing) {
      ranked.set(file, rank);
    }
  };

  for (const file of files) {
    const rank = conventionalEntryRank(file);
    if (rank !== undefined) {
      consider(file, rank);
    }
  }

  for (const route of routes) {
    if (route.kind === 'route-handler') {
      consider(route.file, ENTRY_POINT_RANKS.requestHandler);
    }
  }

  return Object.freeze(
    [...ranked.entries()]
      .sort(([leftFile, leftRank], [rightFile, rightRank]) =>
        leftRank !== rightRank ? leftRank - rightRank : compareStrings(leftFile, rightFile),
      )
      .map(([file]) => file),
  );
}

/**
 * The project's routes, flattened to what a prompt can use.
 *
 * The route map is authoritative when one was supplied; otherwise the graph's
 * `api-route` nodes carry the same four facts and are used instead, which is
 * the path a session reopened from a persisted index takes. Ordered by
 * `(routePath, router, file)` so that a project with a hybrid tree lists the
 * two modules serving one path adjacently and in a fixed order, and
 * deduplicated on that same key.
 *
 * A route whose module path is not a safe project-relative path, or whose path
 * or module exceeds the string clamp, is dropped rather than truncated: a
 * shortened path would name a module that does not exist, and a route a
 * consumer cannot open is worse than a route it was never shown.
 *
 * @param routeMap The route map, when there is one.
 * @param graph The graph, when there is one.
 * @param limits The effective limits.
 * @returns The ordered, deduplicated candidate list, uncapped.
 */
function collectRoutes(
  routeMap: RouteMap | undefined,
  graph: CodeGraph | undefined,
  limits: ProjectSummaryLimits,
): readonly ProjectSummaryRouteRef[] {
  const refs = new Map<string, ProjectSummaryRouteRef>();

  const consider = (
    routePath: string,
    router: RouterKind,
    kind: ApiRouteKind,
    file: string,
    methods: readonly HttpMethodName[],
  ): void => {
    if (routePath.length === 0 || routePath.length > limits.maxStringLength) {
      return;
    }
    if (!isSafeRelativePath(file) || file.length > limits.maxStringLength) {
      return;
    }
    const key = [router, routePath, file].join('\u0000');
    if (refs.has(key)) {
      return;
    }
    refs.set(key, { routePath, router, kind, file, methods: Object.freeze([...methods]) });
  };

  if (routeMap !== undefined) {
    for (const entry of routeMap.entries) {
      consider(entry.routePath, entry.router, entry.kind, entry.file, entry.methods);
    }
  } else if (graph !== undefined) {
    for (const node of graph.nodesByKind('api-route')) {
      consider(node.data.routePath, node.data.router, node.data.kind, node.file, node.data.methods);
    }
  }

  return Object.freeze([...refs.values()].sort(compareRoutes));
}

/**
 * Directories worth knowing about, most populated first.
 *
 * Derived from where the files actually are rather than from a list of
 * conventional names, so it describes *this* project's layout: every file
 * contributes to its first and second path segment, and the result is ordered by
 * file count descending then path ascending. Counts are the *ordering key* and
 * are deliberately not reported — {@link ProjectSummary.notableDirectories} is a
 * list of paths, and a per-directory census would spend the byte budget on
 * detail the understanding stage does not act on.
 *
 * No contents, ever: a directory appears as a path and a magnitude, and nothing
 * here opens it.
 *
 * @param files The project's file set.
 * @param limits The effective limits.
 * @returns The ordered candidate list, uncapped.
 */
function collectDirectories(
  files: readonly string[],
  limits: ProjectSummaryLimits,
): readonly string[] {
  const counts = new Map<string, number>();

  for (const file of files) {
    const segments = file.split('/');
    // The last segment is the basename; only the directory segments above it
    // count, and only the first two levels of them.
    const depth = Math.min(segments.length - 1, 2);
    for (let level = 1; level <= depth; level += 1) {
      const directory = segments.slice(0, level).join('/');
      if (directory.length === 0 || directory.length > limits.maxStringLength) {
        continue;
      }
      counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
  }

  return Object.freeze(
    [...counts.entries()]
      .sort(([leftPath, leftCount], [rightPath, rightCount]) =>
        leftCount !== rightCount ? rightCount - leftCount : compareStrings(leftPath, rightPath),
      )
      .map(([directory]) => directory),
  );
}

/**
 * The declared dependencies that say something about how the project behaves.
 *
 * Recognition is by name against {@link RECOGNISED_DEPENDENCIES} and
 * {@link RECOGNISED_DEPENDENCY_SCOPES}, so an unrecognised package is simply
 * absent: the manifest of a real project holds tens to hundreds of entries and
 * a full list would spend the whole byte budget on tooling that cannot appear in
 * a captured trace. Runtime declarations are read first, so a package declared
 * in both sections is reported as a runtime dependency — the section that
 * decides whether it can appear at runtime at all.
 *
 * Ordered by `(category, name)`: the framework first, because it is what tells a
 * reader what kind of project this is, then the data clients, then observability,
 * then the compiler.
 *
 * @param manifest The manifest view, when one was read.
 * @param limits The effective limits.
 * @returns The ordered candidate list, uncapped.
 */
function collectDependencies(
  manifest: TargetManifest | undefined,
  limits: ProjectSummaryLimits,
): readonly ProjectDependencyRef[] {
  if (manifest === undefined) {
    return EMPTY_DEPENDENCIES;
  }

  const chosen = new Map<string, { category: DependencyCategory; ref: ProjectDependencyRef }>();

  const consider = (name: string, versionRange: string, dev: boolean): void => {
    const category = recogniseDependency(name);
    if (category === undefined || chosen.has(name)) {
      return;
    }
    chosen.set(name, {
      category,
      ref: {
        name: clampText(name, limits.maxStringLength),
        versionRange: clampText(versionRange, limits.maxStringLength),
        dev,
      },
    });
  };

  for (const [name, versionRange] of Object.entries(manifest.dependencies ?? {})) {
    consider(name, versionRange, false);
  }
  for (const [name, versionRange] of Object.entries(manifest.devDependencies ?? {})) {
    consider(name, versionRange, true);
  }

  return Object.freeze(
    [...chosen.values()]
      .sort((left, right) => {
        const byCategory =
          DEPENDENCY_CATEGORY_ORDER[left.category] - DEPENDENCY_CATEGORY_ORDER[right.category];
        return byCategory !== 0 ? byCategory : compareStrings(left.ref.name, right.ref.name);
      })
      .map((entry) => entry.ref),
  );
}

/**
 * Which category a dependency name falls into, or `undefined` when it is not
 * one this summary reports.
 *
 * @param name The declared package name.
 * @returns The category, or `undefined`.
 */
function recogniseDependency(name: string): DependencyCategory | undefined {
  const exact = RECOGNISED_DEPENDENCIES[name];
  if (exact !== undefined) {
    return exact;
  }

  for (const scope of RECOGNISED_DEPENDENCY_SCOPES) {
    if (name.startsWith(scope.prefix) && name.length > scope.prefix.length) {
      return scope.category;
    }
  }

  return undefined;
}

/**
 * The rank a file earns as an entry point, or `undefined` when it is not one.
 *
 * Classification is structural — the directory a module sits in and its stem,
 * with an optional `src/` prefix removed first so that both conventional
 * layouts are recognised — and it never looks at a file's content. The stems
 * are framework conventions, spelled once in this module's detection
 * vocabulary.
 *
 * @param file A project-relative POSIX path from the file set.
 * @returns The rank, or `undefined`.
 */
function conventionalEntryRank(file: string): number | undefined {
  const base = file.startsWith('src/') ? file.slice('src/'.length) : file;
  const directory = dirnamePosix(base);
  const stem = stemOf(basenamePosix(base));
  const inAppTree = directory === 'app';
  const inPagesTree = directory === 'pages';
  const atRoot = directory === '.' || directory.length === 0;

  if (inAppTree && ROOT_DOCUMENT_STEMS.includes(stem)) {
    return ENTRY_POINT_RANKS.document;
  }
  if (inPagesTree && LEGACY_SHELL_STEMS.includes(stem)) {
    return ENTRY_POINT_RANKS.document;
  }
  if ((inAppTree || inPagesTree) && ROOT_PAGE_STEMS.includes(stem)) {
    return ENTRY_POINT_RANKS.landing;
  }
  if (atRoot && SERVER_ENTRY_STEMS.includes(stem)) {
    return ENTRY_POINT_RANKS.serverEntry;
  }
  if (directory === 'server' && MOUNT_STEMS.includes(stem)) {
    return ENTRY_POINT_RANKS.serverEntry;
  }
  if (atRoot && MOUNT_STEMS.includes(stem)) {
    return ENTRY_POINT_RANKS.mount;
  }

  return undefined;
}

/**
 * Whether each router convention's tree is present on disk.
 *
 * A directory named `app` or `pages` proves nothing on its own — both names are
 * ordinary in applications with no framework router at all — so a tree counts
 * only when it holds one of that convention's own modules (a document, a
 * landing page or a legacy shell) or its request subtree. That is the difference
 * between a layout signal and a guess.
 *
 * @param probe The project's existence probe.
 * @returns Which trees are present.
 */
function routerTreeSignal(probe: ProjectProbe): { readonly app: boolean; readonly pages: boolean } {
  return {
    app: treeIsPresent(probe, APP_ROUTER_DIRECTORIES, APP_TREE_MARKER_STEMS),
    pages: treeIsPresent(probe, PAGES_ROUTER_DIRECTORIES, PAGES_TREE_MARKER_STEMS),
  };
}

/**
 * Whether one convention's tree is present in any of its permitted locations.
 *
 * @param probe The project's existence probe.
 * @param directories Where the tree may live.
 * @param stems The stems whose presence marks the tree.
 * @returns `true` when a marker module or the request subtree exists.
 */
function treeIsPresent(
  probe: ProjectProbe,
  directories: readonly string[],
  stems: readonly string[],
): boolean {
  for (const directory of directories) {
    if (!probe.directoryExists(directory)) {
      continue;
    }
    if (probe.directoryExists(joinPosix(directory, ROUTER_REQUEST_DIRECTORY))) {
      return true;
    }
    for (const stem of stems) {
      for (const extension of ROUTER_MODULE_EXTENSIONS) {
        if (probe.fileExists(joinPosix(directory, `${stem}${extension}`))) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * The declared range for one package name, runtime section first.
 *
 * @param manifest The manifest view, when one was read.
 * @param name The package name to look up.
 * @returns The declared range string, or `undefined` when it is not declared.
 */
function declaredRange(manifest: TargetManifest | undefined, name: string): string | undefined {
  const runtime = manifest?.dependencies?.[name];
  if (runtime !== undefined && runtime.length > 0) {
    return runtime;
  }
  const development = manifest?.devDependencies?.[name];
  if (development !== undefined && development.length > 0) {
    return development;
  }
  return undefined;
}

/**
 * Whether the manifest declares any of the given packages, in either section.
 *
 * @param manifest The manifest view, when one was read.
 * @param names The package names to look for.
 * @returns `true` when at least one is declared.
 */
function declaresAnyOf(manifest: TargetManifest | undefined, names: readonly string[]): boolean {
  return names.some((name) => declaredRange(manifest, name) !== undefined);
}

/**
 * The manager a `packageManager` field names, or `undefined` when it names none
 * this vocabulary knows.
 *
 * Accepts a Corepack specifier and a bare name, and discards the version: the
 * `'@'` is searched from index 1 so that a value beginning with `'@'` is not
 * split at its own first character.
 *
 * @param declaration The manifest's `packageManager` value, when present.
 * @returns The manager, or `undefined`.
 */
function declaredPackageManager(declaration: string | undefined): PackageManagerName | undefined {
  if (declaration === undefined) {
    return undefined;
  }

  const trimmed = declaration.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const separator = trimmed.indexOf('@', 1);
  const named = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
  return DECLARABLE_MANAGERS[named];
}

/**
 * The manager one directory's lockfiles identify, or `undefined` when they
 * identify none.
 *
 * The counting rule of {@link detectPackageManager}, in one place because it is
 * applied twice — to the target and to its workspace root — and the two must
 * agree: exactly one manager's lockfiles present identifies it, none or two or
 * more identifies nothing. Two lockfiles of the *same* manager
 * (`package-lock.json` beside `npm-shrinkwrap.json`) are one answer, which is
 * why the managers are collected into a set rather than counted as files.
 *
 * @param probe An existence probe bound to the directory being judged.
 * @returns The manager, or `undefined` when the lockfiles settle nothing.
 */
function lockfileManager(probe: ProjectProbe): PackageManagerName | undefined {
  const found = new Set<PackageManagerName>();
  for (const lockfile of LOCKFILES) {
    if (probe.fileExists(lockfile.file)) {
      found.add(lockfile.manager);
    }
  }

  if (found.size !== 1) {
    return undefined;
  }

  // Exactly one member, so the iterator's first value exists; the `?? undefined`
  // satisfies `noUncheckedIndexedAccess` without asserting anything.
  return [...found][0] ?? undefined;
}

/**
 * The workspace fallback for {@link detectPackageManager}, or `undefined` when
 * the project is not a member of a workspace.
 *
 * Three steps, none of which reaches further than the workspace root's own
 * manifest and lockfiles: locate the root (`./project.ts`'s
 * {@link findWorkspaceRoot}, which accepts an ancestor only when the project
 * matches one of its declared member patterns), then build against that root
 * the same two inputs this module builds against the target —
 * {@link readTargetManifest} and {@link createProjectProbe}, both already
 * parameterised by root, so there is no second spelling of either read.
 *
 * The manifest that comes back is handed to the package-manager detector and to
 * nothing else. That is the whole privacy constraint of this fallback: the
 * workspace root's `dependencies` are not the target's, its `name` is not the
 * target's, and neither may reach `collectDependencies`,
 * {@link detectFramework} or `projectName`. The root path itself does not enter
 * the summary either — it appears in one `debug` line, which is where a
 * developer debugging detection needs it and where a prompt never sees it.
 *
 * @param projectRoot The target project's normalised absolute root.
 * @param logger Where the one `debug` line goes, and the logger the lookup
 * itself reports through.
 * @returns The fallback pair, or `undefined` when there is no workspace root.
 */
function workspacePackageManagerFallback(
  projectRoot: string,
  logger: Logger,
): WorkspacePackageManagerFallback | undefined {
  const workspace = findWorkspaceRoot(projectRoot, { logger });
  if (workspace === undefined) {
    return undefined;
  }

  logger.debug('project summary consults its workspace root for the package manager', {
    root: workspace.root,
    declaredBy: workspace.declaredBy,
    memberPattern: workspace.memberPattern,
  });

  return {
    manifest: readTargetManifest(workspace.root, logger),
    probe: createProjectProbe(workspace.root, logger),
  };
}

/**
 * The module that constructs one driver's handle, when the graph identifies one.
 *
 * Looks for a `file` node whose external imports include a specifier recognised
 * for that driver, bound to the library's construction binding — or, when the
 * import's bindings could not be read and the project corroborates the library,
 * the recognised specifier alone. Type-only imports are ignored: a module that
 * imports a client's *types* constructs nothing.
 *
 * Where more than one module qualifies they are ranked by
 * {@link CONSTRUCTION_MODULE_RANKS} — an application module another
 * application module imports, then any other application module, then a
 * tooling module ({@link isToolingModulePath}) — and the lexicographically
 * first project-relative path wins within a rank, so the answer is the same on
 * every run. The rank is what keeps a seed script that constructs its own
 * client from being reported ahead of the shared module the application's
 * services import: the path order alone favours whichever directory name sorts
 * first, which says nothing about where the application's handle lives.
 *
 * @param graph The project's graph.
 * @param driver Which driver's construction site to look for.
 * @param corroborated Whether the manifest or an on-disk schema corroborates the
 * library.
 * @returns The module's project-relative POSIX path, or `undefined`.
 */
function findConstructionModule(
  graph: CodeGraph,
  driver: 'prisma' | 'pg',
  corroborated: boolean,
): string | undefined {
  const binding = driver === 'prisma' ? PRISMA_CLIENT_BINDING : PG_POOL_BINDING;
  const candidates: { readonly file: string; readonly rank: number }[] = [];

  for (const node of graph.nodesByKind('file')) {
    const data = node.data;
    if (data === undefined || !isSafeRelativePath(node.file)) {
      continue;
    }

    for (const imported of data.externalImports) {
      if (imported.typeOnly) {
        continue;
      }
      const recognised =
        driver === 'prisma'
          ? isPrismaClientSpecifier(imported.specifier)
          : isDriverSpecifier(imported.specifier);
      if (!recognised) {
        continue;
      }
      if (imported.names.includes(binding) || (corroborated && imported.names.length === 0)) {
        candidates.push({ file: node.file, rank: constructionModuleRank(graph, node) });
        break;
      }
    }
  }

  candidates.sort((left, right) => left.rank - right.rank || compareStrings(left.file, right.file));
  return candidates[0]?.file;
}

/**
 * How strongly a qualifying construction module is the application's own
 * handle module; see {@link CONSTRUCTION_MODULE_RANKS}.
 *
 * An importer counts only when it is itself an application module: a handle
 * module that nothing but a test or a seed script imports is not what the
 * application's services reach the database through. The `imports` edges are
 * file-to-file and resolved by the indexer, so this is one adjacency lookup per
 * candidate rather than a scan of the graph.
 *
 * @param graph The project's graph.
 * @param module The qualifying module's `file` node.
 * @returns The module's rank, lowest first.
 */
function constructionModuleRank(
  graph: CodeGraph,
  module: { readonly id: string; readonly file: string },
): number {
  if (isToolingModulePath(module.file)) {
    return CONSTRUCTION_MODULE_RANKS.toolingModule;
  }

  for (const edge of graph.incoming(module.id, 'imports')) {
    if (edge.from === module.id) {
      continue;
    }
    const importer = graph.nodeById(edge.from);
    if (importer !== undefined && !isToolingModulePath(importer.file)) {
      return CONSTRUCTION_MODULE_RANKS.sharedApplicationModule;
    }
  }

  return CONSTRUCTION_MODULE_RANKS.applicationModule;
}

/**
 * Whether a module specifier names the generated client.
 *
 * Three accepted forms: the published package, a sub-path of it, and any
 * specifier carrying a `prisma` path segment — which is what a client generated
 * into the project's own tree looks like to the module that imports it. A
 * sibling package in the same scope is *not* matched, because its scope segment
 * is not the segment being looked for.
 *
 * @param specifier The import specifier as written.
 * @returns `true` when it names the generated client.
 */
function isPrismaClientSpecifier(specifier: string): boolean {
  const normalized = toPosix(specifier);
  if (normalized === PRISMA_CLIENT_PACKAGE || normalized.startsWith(`${PRISMA_CLIENT_PACKAGE}/`)) {
    return true;
  }
  return normalized.split('/').includes(PRISMA_PATH_SEGMENT);
}

/**
 * Whether a module specifier names the driver.
 *
 * The published package names, and any specifier whose final segment is the
 * driver's own name, which covers a project that re-exports it through a module
 * of its own.
 *
 * @param specifier The import specifier as written.
 * @returns `true` when it names the driver.
 */
function isDriverSpecifier(specifier: string): boolean {
  const normalized = toPosix(specifier);
  if (PG_PACKAGES.includes(normalized)) {
    return true;
  }
  return normalized.split('/').at(-1) === PG_PACKAGE;
}

/**
 * The database description with any module path that breaks the path rules
 * dropped.
 *
 * The detector works from the graph alone and knows nothing about the caller's
 * limits, so this is where a module path that is not a safe project-relative
 * path, or that exceeds the string clamp, is removed. Dropping the field is the
 * only honest option: the style and the call-site count remain true, and a
 * truncated path would name a module that does not exist.
 *
 * @param info The detector's result.
 * @param maxStringLength The effective string clamp.
 * @returns The same description, or a copy without the offending fields.
 */
function withinPathBudget(info: DatabaseAccessInfo, maxStringLength: number): DatabaseAccessInfo {
  const prismaClientModule = safePath(info.prismaClientModule, maxStringLength);
  const pgPoolModule = safePath(info.pgPoolModule, maxStringLength);

  if (prismaClientModule === info.prismaClientModule && pgPoolModule === info.pgPoolModule) {
    return info;
  }

  const bounded: {
    style: DatabaseAccessStyle;
    prismaClientModule?: string;
    pgPoolModule?: string;
    callSiteCount: number;
  } = { style: info.style, callSiteCount: info.callSiteCount };

  if (prismaClientModule !== undefined) {
    bounded.prismaClientModule = prismaClientModule;
  }
  if (pgPoolModule !== undefined) {
    bounded.pgPoolModule = pgPoolModule;
  }
  return bounded;
}

/**
 * Gives up one item from the lowest-value list, in place.
 *
 * The value order is fixed and is the answer to "if the prompt can only carry
 * one more thing, what should it be": **dependencies** are corroborating detail
 * a consumer can live without, **directories** are orientation, **routes** are
 * the list most directly matched against a captured request, and **entry
 * points** are where an investigation starts when nothing more specific is
 * known. Items are taken from the end of each list, which is why every list is
 * ordered most-valuable-first.
 *
 * @param lists The four lists, mutated in place.
 * @returns Which list gave up an item, or `undefined` when all four are empty.
 */
function dropLowestValueItem(lists: MutableLists): keyof MutableLists | undefined {
  if (lists.dependencies.length > 0) {
    lists.dependencies.pop();
    return 'dependencies';
  }
  if (lists.notableDirectories.length > 0) {
    lists.notableDirectories.pop();
    return 'notableDirectories';
  }
  if (lists.routes.length > 0) {
    lists.routes.pop();
    return 'routes';
  }
  if (lists.entryPoints.length > 0) {
    lists.entryPoints.pop();
    return 'entryPoints';
  }
  return undefined;
}

/**
 * The serialised size of a summary, in the same units as
 * {@link ProjectSummaryLimits.maxTotalBytes}.
 *
 * Measured rather than estimated, and measured on the object that will actually
 * be sent: an estimate from field lengths would miss the JSON syntax, which is
 * a third of a small object's size.
 *
 * @param summary The summary to measure.
 * @returns Its length as JSON.
 */
function serializedLength(summary: ProjectSummary): number {
  return JSON.stringify(summary).length;
}

/**
 * Reduces freshly parsed JSON to a record of string values.
 *
 * @param value Any value, typically a manifest section.
 * @returns The string-valued entries, frozen, or `undefined` when there are
 * none or the value is not a JSON object.
 */
function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  // A narrowing of `object` to an index signature, not an assertion about the
  // values: every entry below is checked before it is kept.
  const source: Readonly<Record<string, unknown>> = value as Readonly<Record<string, unknown>>;
  const result: Record<string, string> = {};
  let kept = 0;

  for (const key of Object.keys(source)) {
    const entry = source[key];
    if (key.length > 0 && typeof entry === 'string') {
      result[key] = entry;
      kept += 1;
    }
  }

  return kept === 0 ? undefined : Object.freeze(result);
}

/**
 * The project root's canonical form, for the containment check a probe makes.
 *
 * A project may legitimately be reached through a link — a temporary directory
 * on some platforms is exactly that — so comparing a resolved real path against
 * the *given* root would refuse every path in such a project. Comparing it
 * against the root's own real path is what makes the check correct in both
 * cases. A root that cannot be resolved is used as given, and the probe then
 * simply finds nothing.
 *
 * @param projectRoot The absolute POSIX project root.
 * @returns Its real path, or the input when it cannot be resolved.
 */
function canonicalRootOf(projectRoot: string): string {
  try {
    return toPosix(realpathSync(projectRoot));
  } catch {
    return projectRoot;
  }
}

/**
 * Resolves a project-relative path to an absolute one this module may look at,
 * or `undefined` when it may not.
 *
 * The four refusals of {@link createProjectProbe}, plus the link check: a path
 * whose real form leaves the project — a link planted at the final component —
 * is refused even though its lexical form was inside. A path that does not
 * exist yet cannot be resolved and is returned as it is, so the caller's `stat`
 * answers the existence question rather than this function pre-empting it.
 *
 * @param projectRoot The absolute POSIX project root.
 * @param canonicalRoot The root's real path, from {@link canonicalRootOf}.
 * @param relativePath The project-relative POSIX path to resolve.
 * @returns The absolute POSIX path, or `undefined` when it is out of bounds.
 */
function resolveProjectPath(
  projectRoot: string,
  canonicalRoot: string,
  relativePath: string,
): string | undefined {
  const candidate = toPosix(relativePath);
  if (!isSafeRelativePath(candidate) || isEnvFilePath(candidate)) {
    return undefined;
  }

  const resolved = resolveWithinProject(projectRoot, candidate);
  if (isErr(resolved)) {
    return undefined;
  }

  const absolute = resolved.value;
  if (shouldExcludePath(projectRoot, absolute)) {
    return undefined;
  }

  let real: string;
  try {
    real = toPosix(realpathSync(absolute));
  } catch {
    return absolute;
  }

  return isWithin(canonicalRoot, real) ? absolute : undefined;
}

/**
 * A project-relative path that is safe and within the string clamp, or
 * `undefined`.
 *
 * @param path The candidate path, possibly absent.
 * @param maxStringLength The effective string clamp.
 * @returns The path unchanged, or `undefined` when it must not be reported.
 */
function safePath(path: string | undefined, maxStringLength: number): string | undefined {
  if (path === undefined || path.length > maxStringLength || !isSafeRelativePath(path)) {
    return undefined;
  }
  return path;
}

/**
 * Clamps free text to the string limit, marking it when it was clamped.
 *
 * Applied to labels and declared ranges only. Paths are never clamped — see
 * {@link ProjectSummaryLimits.maxStringLength}.
 *
 * @param value The text to clamp.
 * @param maxStringLength The effective string clamp, at least 1.
 * @returns The text, or its clamped form ending in an ellipsis.
 */
function clampText(value: string, maxStringLength: number): string {
  if (value.length <= maxStringLength) {
    return value;
  }
  if (maxStringLength <= ELLIPSIS.length) {
    return ELLIPSIS.slice(0, maxStringLength);
  }
  return `${value.slice(0, maxStringLength - ELLIPSIS.length)}${ELLIPSIS}`;
}

/**
 * A basename without its final extension.
 *
 * @param basename The file's basename.
 * @returns The stem, which is the basename itself when it has no extension.
 */
function stemOf(basename: string): string {
  const extension = extnamePosix(basename);
  return extension.length === 0 ? basename : basename.slice(0, basename.length - extension.length);
}

/**
 * Byte-wise string comparison, so every order in this module is identical on
 * every machine and in every locale.
 *
 * @param left The first string.
 * @param right The second string.
 * @returns A negative number, zero, or a positive number.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * Route order: path, then convention, then module.
 *
 * @param left The first route.
 * @param right The second route.
 * @returns A negative number, zero, or a positive number.
 */
function compareRoutes(left: ProjectSummaryRouteRef, right: ProjectSummaryRouteRef): number {
  const byPath = compareStrings(left.routePath, right.routePath);
  if (byPath !== 0) {
    return byPath;
  }
  const byRouter = compareStrings(left.router, right.router);
  return byRouter !== 0 ? byRouter : compareStrings(left.file, right.file);
}
