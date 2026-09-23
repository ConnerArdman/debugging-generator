/**
 * The suite for `./nextjs.ts` — the framework adapter, and the only adapter in
 * the product that installs `patch`-mode actions.
 *
 * It is therefore the only adapter suite that touches a filesystem, and five
 * claims are what make that adapter correct rather than merely present:
 *
 * 1. **Every target comes from the code graph.** A route handler is selected
 *    from an `api-route` node's declared method exports and the route map's
 *    per-method locations; a server function is selected from a
 *    `server-function` node reached along the graph's own call edges. No route
 *    path, handler name or service-function name is written here as an
 *    expectation — every one is computed from the graph a case indexed
 *    (AAP §0.5.4), which is why the scratch corpus below carries deliberately
 *    meaningless identifiers this product has never seen.
 * 2. **Every action is `patch`-mode, and a generator is never proposed.**
 *    `../installer.ts` reads the mode to install every runtime-mode group
 *    before any patch-mode group, so a wrong mode would silently change
 *    install ordering rather than fail; and a generator has no function-timing
 *    template, so proposing one would put a target in the plan a developer
 *    reads that the patcher is going to refuse (AAP §0.5.1).
 * 3. **With no preload attached, not one byte is written.** A file
 *    modification that cannot produce a span is pure risk to a developer's
 *    working tree, so the install applies nothing, journals nothing, and
 *    reports the gap with a relaunch instruction that names the project root
 *    (AAP §0.5.5). The cases that assert this run against a *copy* of the
 *    corpus with a real backup store, so a violation is detectable rather than
 *    merely improbable.
 * 4. **With a preload attached, the real patcher does the writing.** The
 *    records that come back are the ones the journal received, in the order
 *    that makes crash reconciliation decidable — a `pending` row carrying both
 *    hashes while the file still holds the original, then the transition to
 *    `applied` once it holds the patched bytes — and they land in
 *    `InstallResult.applied`, which is exactly what lets `../installer.ts`
 *    reverse-restore a failed plan (AAP §0.4.2).
 * 5. **The adapter restores nothing and invents nothing.** `remove` leaves
 *    every patched file patched (restoration is `../cleanup.ts`'s, chain-aware
 *    and in strict reverse order), no record in `applied` is hand-built, and
 *    the committed corpus is byte-for-byte as it was found when the suite ends.
 *
 * ## The corpora, and why there are four kinds
 *
 * The adapter's input contract is a real `CodeGraph`, so every corpus is
 * indexed through the product's own path — `openProject` → `buildIndex` →
 * `CodeGraph.fromIndex` → `buildRouteMap` → `createCodeQueries` →
 * `summarizeProject`. That pair is deliberately the **cache-free** build:
 * `indexProject` would consult and populate `$DEBUGGEN_HOME/index`, which a
 * unit suite must not touch.
 *
 * - `test/fixtures/project-a`, **read-only**, indexed once. It gives one
 *   unambiguous server chain (a single App Router module exporting exactly one
 *   method, whose handler awaits one named server function), one
 *   generator-only module whose every symbol must be refused, one module with
 *   two independently patchable exports, and more patchable functions than one
 *   proposal may contain — so the caps are exercised at a real ceiling.
 * - **A per-case copy of that corpus** in its own `mkdtemp` directory with its
 *   own `$DEBUGGEN_HOME`, for every case that can write. The committed tree is
 *   never the patcher's target: `git status --porcelain
 *   packages/instrumentation/test/fixtures` has to be empty after `pnpm test`,
 *   and the last group proves it with a SHA-256 snapshot taken before anything
 *   was indexed.
 * - **A scratch project** written into `mkdtemp`, carrying two route modules
 *   (one with two method exports) and a three-hop call chain the committed
 *   corpus cannot express — which is what makes the reachability depth bound
 *   and URL narrowing observable — with arbitrary identifiers that double as
 *   the behavioural half of AAP §0.5.4's no-hardcoding rule.
 * - **Hand-authored `CodeIndex` values** for the two capability edges: a
 *   project with no server tier at all, and one with server functions but no
 *   routes. Neither is expressible as a source tree without inventing a
 *   framework convention, and both are deliberate capability decisions.
 *
 * ## One reconciliation, recorded rather than worked around
 *
 * This file's brief speaks of the `routes-to` edge from a route into the
 * service layer. The vocabulary `@debuggen/code-analysis` owns says something
 * different and is followed: `CODE_EDGE_KINDS` fixes `routes-to` as `api-call`
 * → `api-route`, and `extractors/server-functions.ts` states that the
 * route-to-service linkage is a **`calls`** edge from the `api-route` node.
 * The committed corpus contains no `routes-to` edge at all, `./nextjs.ts`
 * traverses `calls`, and so does the expectation this suite computes — an
 * assertion written against the other spelling would be vacuous.
 *
 * Nothing here needs a network, a dev server, a database or the `next`
 * package: every readiness fact is injected on the context, and the preload
 * this adapter reports on is a fact the service observed, never a process this
 * suite starts.
 */

import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODE_INDEX_SCHEMA_VERSION,
  CodeGraph,
  HTTP_METHOD_NAMES,
  INDEXER_VERSION,
  buildIndex,
  buildRouteMap,
  createCodeQueries,
  makeNodeId,
  openProject,
  routeMapFromIndex,
  summarizeProject,
} from '@debuggen/code-analysis';
import type {
  CodeIndex,
  CodeNode,
  CodeNodeOf,
  CodeQueries,
  HttpMethodName,
  LoadedProject,
  ProjectSummary,
  RouteEntry,
  RouteMap,
} from '@debuggen/code-analysis';
import { noopLogger, ok, toPosix } from '@debuggen/shared';
import type { LogFields, Logger } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  InstrumentationContext,
  ObservedReadinessInputs,
  ObservedServerAgent,
  UnavailableSignal,
} from '../adapter.js';
import { createBackupStore } from '../patch/backup-store.js';
import type { Patcher, PatcherOptions } from '../patch/patcher.js';
import { modificationRecordSchema } from '../schema/modification.js';
import type {
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
  ModificationStatusPatch,
} from '../schema/modification.js';
import {
  ACTION_ID_PATTERN,
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_MODES,
  instrumentationActionSchema,
} from '../schema/plan.js';
import type { InstrumentationAction, InstrumentationActionType } from '../schema/plan.js';
import {
  CAPTURE_SIGNALS,
  DISABLED_SERVER_AGENT_SIGNALS,
  READINESS_STATUSES,
  SERVER_AGENT_SIGNAL_KEYS,
  readinessSchema,
  serverAgentSignalsSchema,
} from '../schema/readiness.js';
import { problemUnderstandingSchema } from '../schema/target.js';
import type { ProblemUnderstanding } from '../schema/target.js';

import {
  DEBUGGEN_NODE_PRELOAD_SPECIFIER,
  NEXTJS_ADAPTER_CLAIMS,
  NEXTJS_ADAPTER_ID,
  NEXTJS_ADAPTER_LIMITS,
  NEXTJS_RUNTIME_HOOKS,
  NEXTJS_SERVER_SIGNAL_KEYS,
  createNextJsAdapter,
} from './nextjs.js';

/* -------------------------------------------------------------------------------------------------
 * Paths and fixed values
 * ---------------------------------------------------------------------------------------------- */

/**
 * The committed, read-only corpus, resolved from this module's own URL.
 *
 * Two levels up from `src/adapters/`, and deliberately not from
 * `process.cwd()`: this package's Vitest project runs from the repository root,
 * where a relative path would resolve to something else entirely.
 */
const FIXTURE_ROOT = toPosix(
  fileURLToPath(new URL('../../test/fixtures/project-a', import.meta.url)),
);

/** The adapter's own source, for the static import-boundary and literal guards. */
const ADAPTER_SOURCE_PATH = fileURLToPath(new URL('./nextjs.ts', import.meta.url));

/** The session every context in this suite belongs to. */
const SESSION_ID = 'ses_nextjsadapter01';

/** The plan revision every context stamps. */
const PLAN_VERSION = 3;

/** A fixed moment, so every clock-dependent assertion is exact. */
const NOW = 1_700_000_000_000;

/** A clock frozen at {@link NOW}. */
const frozenClock = (): number => NOW;

/* -------------------------------------------------------------------------------------------------
 * The indexing harness
 * ---------------------------------------------------------------------------------------------- */

/** One indexed project, with every handle an `InstrumentationContext` needs. */
interface IndexedProject {
  /** Absolute POSIX project root, as `openProject` normalised it. */
  readonly root: string;

  /** The loaded ts-morph project, which is what `queries.excerpt` reads from. */
  readonly loaded: LoadedProject | undefined;

  /** The code graph built from a cache-free index. */
  readonly graph: CodeGraph;

  /** The bounded query surface, built over the graph and the route map. */
  readonly queries: CodeQueries;

  /** The route map — the product's only URL ↔ route-file algorithm. */
  readonly routeMap: RouteMap;

  /** The project summary, whose `packageManager` the relaunch hint is composed from. */
  readonly projectSummary: ProjectSummary;
}

/**
 * Indexes one project through the product's own path.
 *
 * The cache-free build (`openProject` + `buildIndex`) rather than
 * `indexProject`, which would read and write `$DEBUGGEN_HOME/index`.
 *
 * @param root The project root to index.
 * @returns Every handle a context is built from.
 */
async function indexProjectTree(root: string): Promise<IndexedProject> {
  const opened = openProject({ projectRoot: root });

  if (!opened.ok) {
    throw new Error(`the suite could not open ${root}: ${opened.error.message}`);
  }

  const built = await buildIndex(opened.value);

  if (!built.ok) {
    throw new Error(`the suite could not index ${root}: ${built.error.message}`);
  }

  const graph = CodeGraph.fromIndex(built.value);
  const routeMap = buildRouteMap(opened.value);

  return {
    root: opened.value.projectRoot,
    loaded: opened.value,
    graph,
    routeMap,
    queries: createCodeQueries(graph, { loaded: opened.value, routes: routeMap.entries }),
    projectSummary: summarizeProject({ loaded: opened.value, graph, routeMap }),
  };
}

/**
 * Wraps a hand-authored index as an indexed project.
 *
 * The graph, the queries and the route map all come from the index itself, so
 * the three agree with each other; the project summary is borrowed from a real
 * project, because `summarizeProject` needs a loaded ts-morph project and the
 * cases that use a hand-authored index are about the graph alone.
 *
 * @param index The hand-authored index.
 * @param summaryFrom The project whose summary to borrow.
 * @returns The project handles, with no loaded ts-morph project.
 */
function projectFromIndex(index: CodeIndex, summaryFrom: IndexedProject): IndexedProject {
  const graph = CodeGraph.fromIndex(index);
  const routeMap = routeMapFromIndex(index);

  return {
    root: index.projectRoot,
    loaded: undefined,
    graph,
    routeMap,
    queries: createCodeQueries(graph, { routes: routeMap.entries }),
    projectSummary: summaryFrom.projectSummary,
  };
}

/**
 * A hand-authored index around a node list.
 *
 * @param projectRoot The absolute POSIX root the index claims.
 * @param nodes The nodes the graph holds.
 * @returns The index.
 */
function handAuthoredIndex(projectRoot: string, nodes: readonly CodeNode[]): CodeIndex {
  return {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot,
    indexerVersion: INDEXER_VERSION,
    generatedAt: NOW,
    nodes,
    edges: [],
    files: [],
  };
}

/**
 * One `server-function` node, hand-authored.
 *
 * @param file The declaring file, project-relative POSIX.
 * @param name The exported function's name.
 * @returns The node.
 */
function serverFunctionNode(file: string, name: string): CodeNodeOf<'server-function'> {
  return {
    id: makeNodeId({ kind: 'server-function', file, name, line: 1, column: 1 }),
    kind: 'server-function',
    name,
    file,
    line: 1,
    column: 1,
    exported: true,
    data: { isAsync: false, exported: true },
  };
}

/**
 * One `component` node, hand-authored: a project with a page and nothing else.
 *
 * @param file The declaring file, project-relative POSIX.
 * @param name The component's display name.
 * @returns The node.
 */
function componentNode(file: string, name: string): CodeNodeOf<'component'> {
  return {
    id: makeNodeId({ kind: 'component', file, name, line: 1, column: 1 }),
    kind: 'component',
    name,
    file,
    line: 1,
    column: 1,
    exported: true,
    data: { isClient: true, isDefaultExport: true, displayName: name },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Temporary worlds: one per case that can write
 * ---------------------------------------------------------------------------------------------- */

/** One case's temporary world: a copy of the corpus and a private state root. */
interface Sandbox {
  /** The copied corpus, which is the adapter's `projectRoot`. */
  readonly project: IndexedProject;

  /** The absolute POSIX path of the copy, for direct filesystem assertions. */
  readonly projectRoot: string;

  /** The temporary `$DEBUGGEN_HOME` the real backup store writes under. */
  readonly debuggenHome: string;

  /** Where backups for {@link SESSION_ID} land. */
  readonly backupDirectory: string;

  /** Every file of the copy with its SHA-256, taken before the case ran. */
  readonly before: readonly string[];
}

/** The directory every sandbox of the current case lives in. */
let caseRoot = '';

beforeEach(() => {
  caseRoot = mkdtempSync(join(tmpdir(), 'debuggen-nextjs-case-'));
});

afterEach(() => {
  if (caseRoot !== '') {
    rmSync(caseRoot, { recursive: true, force: true });
    caseRoot = '';
  }

  // One case stubs the environment to prove nothing is read from it.
  // Restoring here rather than there keeps a failure inside that case from
  // leaking a stub into the rest of the run.
  vi.unstubAllEnvs();
});

/**
 * Copies the committed corpus into the current case's directory and indexes the
 * copy.
 *
 * A copy per case, never the committed corpus: the real patcher runs in the
 * cases below and writes real bytes, so a case working in place would leave the
 * repository modified. The state root is created `0700` because the backup
 * store verifies that its own directory is private and owned by this account
 * before it writes a single original into it.
 *
 * @param name A short name, so two sandboxes in one case do not collide.
 * @returns The sandbox.
 */
async function sandbox(name = 'project'): Promise<Sandbox> {
  const root = join(caseRoot, name);
  const projectRoot = join(root, 'project');
  const debuggenHome = join(root, 'home');

  cpSync(FIXTURE_ROOT, projectRoot, { recursive: true });
  mkdirSync(debuggenHome, { recursive: true, mode: 0o700 });
  chmodSync(debuggenHome, 0o700);

  const project = await indexProjectTree(toPosix(projectRoot));

  return {
    project,
    projectRoot: toPosix(projectRoot),
    debuggenHome: toPosix(debuggenHome),
    backupDirectory: toPosix(join(debuggenHome, 'backups', SESSION_ID)),
    before: treeSnapshot(projectRoot),
  };
}

/**
 * Every file under a directory, as `«project-relative path» «sha-256»` lines,
 * sorted.
 *
 * Content-addressed rather than size-and-time addressed: a patch that happened
 * to preserve a file's length would pass a size comparison, and this suite's
 * central claim is that specific bytes did or did not change.
 *
 * @param root The directory to walk.
 * @returns One sorted line per file.
 */
function treeSnapshot(root: string): readonly string[] {
  const lines: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolute);

        continue;
      }

      lines.push(`${toPosix(relative(root, absolute))} ${sha256Hex(readFileSync(absolute))}`);
    }
  };

  walk(root);

  return lines.sort();
}

/**
 * The project-relative paths whose content differs between two snapshots.
 *
 * @param before The snapshot taken first.
 * @param after The snapshot taken second.
 * @returns The changed (or added, or removed) paths, sorted.
 */
function changedPaths(before: readonly string[], after: readonly string[]): readonly string[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const changed = new Set<string>();

  for (const line of [
    ...before.filter((entry) => !afterSet.has(entry)),
    ...after.filter((entry) => !beforeSet.has(entry)),
  ]) {
    changed.add(line.slice(0, line.lastIndexOf(' ')));
  }

  return [...changed].sort();
}

/** Every scratch directory this suite created outside a case, for the teardown. */
const scratchRoots: string[] = [];

/**
 * Writes a source tree into its own `mkdtemp` directory and indexes it.
 *
 * A `package.json` is included because `ProjectSummary` reads the package
 * manager from it, which is what the relaunch hint of AAP §0.5.5 is composed
 * from; a `tsconfig.json` because a target project's configuration is what
 * `openProject` takes its compiler options from; and a `next.config.mjs`
 * because the router style is detected from the project's own shape.
 *
 * @param label A short, human-readable name for the temporary directory.
 * @param files Project-relative POSIX paths mapped to file contents.
 * @returns The indexed scratch project.
 */
async function scratchProject(
  label: string,
  files: Readonly<Record<string, string>>,
): Promise<IndexedProject> {
  const root = mkdtempSync(join(tmpdir(), `debuggen-nextjs-${label}-`));

  scratchRoots.push(root);

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: `scratch-${label}`,
        private: true,
        packageManager: 'pnpm@12.4.2',
        dependencies: { next: '16.3.5', react: '19.3.0' },
        scripts: { dev: 'next dev' },
      },
      undefined,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'esnext',
          moduleResolution: 'bundler',
          strict: true,
          noEmit: true,
          allowJs: true,
        },
        include: ['**/*.ts', '**/*.tsx'],
        exclude: ['node_modules'],
      },
      undefined,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(join(root, 'next.config.mjs'), 'export default {};\n', 'utf8');

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(root, relativePath);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
  }

  return indexProjectTree(toPosix(root));
}

/* -------------------------------------------------------------------------------------------------
 * The ports: a journal that records what the disk held, and doubles that refuse
 * ---------------------------------------------------------------------------------------------- */

/** One call made against a recording journal, with what the disk held at the time. */
interface JournalEvent {
  /** Which method was called. */
  readonly method: 'append' | 'updateStatus' | 'listBySession' | 'listOpen';

  /** The record the call was about, where there was one. */
  readonly recordId: string;

  /** The status the call carried: the appended row's, or the requested one. */
  readonly status: string;

  /** The record's project-relative file. */
  readonly file: string;

  /** The record's `originalHash`, as the journal received it. */
  readonly originalHash: string;

  /** The record's `instrumentedHash`, as the journal received it. */
  readonly instrumentedHash: string;

  /**
   * SHA-256 of the record's file **at the moment of the call**, or `undefined`
   * when the file could not be read.
   *
   * The witness that makes the write sequence checkable from the outside: at
   * `append` time the file must still hash to `originalHash`, and at the
   * transition to `applied` it must hash to `instrumentedHash`. That ordering
   * is what lets `../cleanup.ts` decide, after a crash, whether a row's write
   * landed — asserting it here needs no failure injection, which is
   * `patch/patcher.test.ts`'s territory rather than this suite's.
   */
  readonly onDiskHash: string | undefined;
}

/** A journal that records every call in order, and the rows it holds. */
interface RecordingJournal extends ModificationJournal {
  /** Every call, in call order. */
  readonly events: readonly JournalEvent[];

  /** Every row, by id, as it currently stands. */
  rowsById(): ReadonlyMap<string, ModificationRecord>;
}

/**
 * An in-memory journal that records rather than refuses.
 *
 * Recording instead of throwing is deliberate: a throwing journal proves only
 * that the adapter did not crash into it, while a recorder lets a case assert
 * the *stronger* statement — that `append` was never called, because there was
 * no modification to record (AAP §0.5.1) — and lets the write-order case above
 * read the disk at each call.
 *
 * @param projectRoot The absolute project root a record's file is resolved
 * against, for the on-disk witness. Omitted for a context with no real tree.
 * @returns The journal.
 */
function createRecordingJournal(projectRoot?: string): RecordingJournal {
  const events: JournalEvent[] = [];
  const rows = new Map<string, ModificationRecord>();

  const diskHash = (file: string): string | undefined => {
    if (projectRoot === undefined) {
      return undefined;
    }

    try {
      return sha256Hex(readFileSync(join(projectRoot, file)));
    } catch {
      return undefined;
    }
  };

  const note = (
    method: JournalEvent['method'],
    record: ModificationRecord,
    status: string,
  ): void => {
    events.push({
      method,
      recordId: record.id,
      status,
      file: record.file,
      originalHash: record.originalHash,
      instrumentedHash: record.instrumentedHash,
      onDiskHash: diskHash(record.file),
    });
  };

  return {
    events,
    rowsById: () => new Map(rows),
    append: (record: ModificationRecord) => {
      rows.set(record.id, record);
      note('append', record, record.status);

      return Promise.resolve(ok(record));
    },
    updateStatus: (id: string, status: ModificationStatus, patch?: ModificationStatusPatch) => {
      const existing = rows.get(id);

      if (existing === undefined) {
        throw new Error(`the suite's journal holds no record ${id}`);
      }

      const updated: ModificationRecord = { ...existing, ...patch, status };

      rows.set(id, updated);
      note('updateStatus', updated, status);

      return Promise.resolve(ok(updated));
    },
    listBySession: () => Promise.resolve(ok([...rows.values()])),
    listOpen: () =>
      Promise.resolve(ok([...rows.values()].filter((row) => row.status !== 'reverted'))),
  };
}

/**
 * A journal that fails the test if it is ever reached.
 *
 * Used by the cases that must prove a *read* — `canHandle`, `readiness` — asks
 * the store nothing at all: readiness is a statement about injected evidence,
 * and a journal round-trip there would be a side effect in a question.
 */
const forbiddenJournal: ModificationJournal = {
  append: () => {
    throw new Error('this call must never journal a modification');
  },
  updateStatus: () => {
    throw new Error('this call must never update a modification record');
  },
  listBySession: () => {
    throw new Error('this call must never read the journal');
  },
  listOpen: () => {
    throw new Error('this call must never read the journal');
  },
};

/**
 * A backup store that fails the test if it is ever reached.
 *
 * Typed as the context's own port rather than through a second import of the
 * store's module: the shape a context requires is the shape this double has to
 * satisfy, and reading it from `../adapter.ts` keeps that true if the port ever
 * moves.
 *
 * @param sessionDirectory The directory the double claims, for a message that
 * names something recognisable if it is ever reached.
 * @returns The double.
 */
function forbiddenBackups(sessionDirectory: string): InstrumentationContext['backups'] {
  const refuse = (what: string): never => {
    throw new Error(`this call must never ${what} a backup`);
  };

  return {
    sessionId: SESSION_ID,
    sessionDirectory,
    locate: () => refuse('locate'),
    put: () => refuse('write'),
    read: () => refuse('read'),
    has: () => refuse('query'),
    verify: () => refuse('verify'),
    remove: () => refuse('remove'),
    removeSessionDirectory: () => refuse('remove the directory of'),
  };
}

/** One captured log line. */
interface LogLine {
  /** The level it was written at. */
  readonly level: string;

  /** The message. */
  readonly message: string;

  /** The bound and per-call fields, merged. */
  readonly fields: LogFields;
}

/**
 * A logger that captures every line, at every level, with its bindings.
 *
 * Capturing all six levels rather than only `debug` is what lets a case assert
 * what was written *above* `debug` — this adapter warns exactly twice, for a
 * missing preload and for a target it could not wrap, and both are developer-
 * facing degradations rather than noise.
 *
 * @param lines Where to collect the captured lines.
 * @param bindings The fields already bound by a `child` call.
 * @returns A logger.
 */
function capturingLogger(lines: LogLine[], bindings: LogFields = {}): Logger {
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields: { ...bindings, ...fields } });
    };

  return {
    level: 'trace',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: (nested: LogFields) => capturingLogger(lines, { ...bindings, ...nested }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The observed readiness inputs, as named presets
 * ---------------------------------------------------------------------------------------------- */

/** The named preload states a case selects from. */
interface PreloadPresets {
  /** Nothing has ever announced itself: a dev server the developer started. */
  readonly notConnected: ObservedReadinessInputs;

  /** Attached to this project and heard from a moment ago. */
  readonly fresh: ObservedReadinessInputs;

  /** Attached to this project, and silent past the configured window. */
  readonly stale: ObservedReadinessInputs;

  /** Announced once, and its connection has since gone. */
  readonly disconnected: ObservedReadinessInputs;

  /** Attached — to a different project, so no preload for this one. */
  readonly otherProject: ObservedReadinessInputs;

  /** Connected, and has not reported yet: a freshly launched dev server. */
  readonly neverReported: ObservedReadinessInputs;
}

/**
 * Builds the presets for one project root.
 *
 * A function of the root rather than a constant, because every state except
 * the first names a project, and "attached to a different project" is only
 * expressible relative to this one. Staleness is expressed as a heartbeat
 * older than the configured window measured against {@link NOW}, so the
 * degraded verdict is driven by the injected clock rather than by waiting.
 *
 * @param projectRoot The project the presets are about.
 * @returns The six named states.
 */
function preloadPresets(projectRoot: string): PreloadPresets {
  const attached = (lastHeartbeatAt: number): ObservedServerAgent => ({
    connected: true,
    projectRoot,
    lastHeartbeatAt,
  });

  return {
    notConnected: {},
    fresh: { serverAgent: attached(NOW - 1_000) },
    stale: {
      serverAgent: attached(NOW - (NEXTJS_ADAPTER_LIMITS.heartbeatStalenessMs + 60_000)),
    },
    disconnected: { serverAgent: { connected: false, projectRoot, lastHeartbeatAt: NOW } },
    otherProject: {
      serverAgent: {
        connected: true,
        projectRoot: `${projectRoot}-elsewhere`,
        lastHeartbeatAt: NOW,
      },
    },
    neverReported: { serverAgent: { connected: true, projectRoot } },
  };
}

/** Every preset, with the name a failure message should carry. */
function presetEntries(
  projectRoot: string,
): readonly [keyof PreloadPresets, ObservedReadinessInputs][] {
  const presets = preloadPresets(projectRoot);

  return (Object.keys(presets) as (keyof PreloadPresets)[]).map((name) => [name, presets[name]]);
}

/* -------------------------------------------------------------------------------------------------
 * The context
 * ---------------------------------------------------------------------------------------------- */

/** What a case varies about the context. */
interface ContextInput {
  /** The indexed project the context describes. */
  readonly project: IndexedProject;

  /** What the service observed about the two producers. Defaults to nothing. */
  readonly readiness?: ObservedReadinessInputs | undefined;

  /** Where to log. Defaults to silence. */
  readonly logger?: Logger | undefined;

  /** The modification journal. Defaults to a journal that refuses every call. */
  readonly journal?: ModificationJournal | undefined;

  /** The backup store. Defaults to a store that refuses every call. */
  readonly backups?: InstrumentationContext['backups'] | undefined;

  /** The state root. Defaults to a path nothing may create. */
  readonly debuggenHome?: string | undefined;

  /** The plan revision. Defaults to {@link PLAN_VERSION}. */
  readonly planVersion?: number | undefined;

  /** The session clock. Defaults to {@link frozenClock}. */
  readonly now?: (() => number) | undefined;

  /** Cancellation, for the abort cases. */
  readonly signal?: AbortSignal | undefined;
}

/** The state root a non-writing case names but no case may create. */
const UNWRITABLE_STATE_ROOT = toPosix(join(tmpdir(), 'debuggen-nextjs-suite-state-never-written'));

/**
 * Builds an `InstrumentationContext` around an indexed project.
 *
 * The shape is read from `../adapter.ts` and never re-declared here. Optional
 * keys are *spread* rather than assigned, which `exactOptionalPropertyTypes`
 * requires: an explicitly `undefined` `loaded` or `signal` is a different thing
 * from an absent one.
 *
 * @param input What this case varies.
 * @returns The context.
 */
function contextFor(input: ContextInput): InstrumentationContext {
  const debuggenHome = input.debuggenHome ?? UNWRITABLE_STATE_ROOT;

  return {
    sessionId: SESSION_ID,
    projectRoot: input.project.root,
    planVersion: input.planVersion ?? PLAN_VERSION,
    debuggenHome,
    logger: input.logger ?? noopLogger,
    graph: input.project.graph,
    queries: input.project.queries,
    routeMap: input.project.routeMap,
    projectSummary: input.project.projectSummary,
    journal: input.journal ?? forbiddenJournal,
    backups: input.backups ?? forbiddenBackups(`${debuggenHome}/backups/${SESSION_ID}`),
    readiness: input.readiness ?? {},
    now: input.now ?? frozenClock,
    ...(input.project.loaded === undefined ? {} : { loaded: input.project.loaded }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

/**
 * Builds a context for a sandbox: the copied corpus, the real backup store and
 * a recording journal that reads the copy at every call.
 *
 * @param world The sandbox.
 * @param input What else this case varies.
 * @returns The context and the journal, so the case can assert on both.
 */
function writableContext(
  world: Sandbox,
  input: Omit<ContextInput, 'project' | 'journal' | 'backups' | 'debuggenHome'> = {},
): { readonly context: InstrumentationContext; readonly journal: RecordingJournal } {
  const journal = createRecordingJournal(world.projectRoot);

  return {
    journal,
    context: contextFor({
      ...input,
      project: world.project,
      journal,
      debuggenHome: world.debuggenHome,
      backups: createBackupStore({ debuggenHome: world.debuggenHome, sessionId: SESSION_ID }),
    }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Understandings — validated Stage 1 artifacts, never ad-hoc objects
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds a validated problem understanding.
 *
 * Parsed through the stage's own schema rather than cast, so a case cannot hand
 * this adapter an artifact the pipeline would have rejected — which would make
 * a passing assertion say nothing about production behaviour.
 *
 * @param signalsNeeded The signals the question asks for.
 * @param entities The entities it named.
 * @param searchHints The free-text hints it carried.
 * @returns The understanding.
 */
function understandingFor(
  signalsNeeded: readonly string[],
  entities: readonly { readonly kind: string; readonly name: string }[] = [],
  searchHints: readonly string[] = [],
): ProblemUnderstanding {
  return problemUnderstandingSchema.parse({
    category: 'performance',
    signalsNeeded: [...signalsNeeded],
    entities: entities.map((entity) => ({ ...entity })),
    searchHints: [...searchHints],
  });
}

/** A latency question that asks for the whole server tier. */
const serverQuestion = understandingFor([
  'interactions',
  'fetch',
  'http',
  'routeHandlers',
  'functions',
]);

/** A question that asks only for the route-handler boundary. */
const routeOnlyQuestion = understandingFor(['routeHandlers']);

/** A question that asks only for named function timing. */
const functionOnlyQuestion = understandingFor(['functions']);

/** A question about the page, which needs no server evidence at all. */
const browserQuestion = understandingFor(['react', 'state', 'componentTree']);

/* -------------------------------------------------------------------------------------------------
 * Reading the corpora — every expectation below is computed from the graph
 * ---------------------------------------------------------------------------------------------- */

/** The route modules of a project that answer requests, in graph order. */
function requestRoutes(project: IndexedProject): readonly CodeNodeOf<'api-route'>[] {
  return project.graph
    .nodesByKind('api-route')
    .filter((node) => node.data.kind === 'route-handler');
}

/** The route map's entry for a route file, where the map has one. */
function routeEntryFor(project: IndexedProject, file: string): RouteEntry | undefined {
  return project.routeMap.entries.find((entry) => entry.file === file);
}

/** One route-handler target the graph sanctions: a file, a method and its symbol. */
interface ExpectedMethodTarget {
  /** The HTTP method the route declares. */
  readonly method: HttpMethodName;

  /** The declaring file, project-relative POSIX. */
  readonly file: string;

  /** The symbol a patch would have to address. */
  readonly symbol: string;
}

/**
 * Every method export the graph and the route map agree on, for one project.
 *
 * The method names are the route node's own and the symbols are the route
 * map's per-method locations — the two places the product records them — so
 * nothing here restates a handler name. This is the expectation the
 * route-selection cases are measured against.
 *
 * @param project The indexed project.
 * @returns The targets, one per declared method.
 */
function expectedMethodTargets(project: IndexedProject): readonly ExpectedMethodTarget[] {
  const targets: ExpectedMethodTarget[] = [];

  for (const node of requestRoutes(project)) {
    const entry = routeEntryFor(project, node.file);

    for (const method of node.data.methods) {
      const symbol =
        entry?.methodLocations?.[method]?.symbol ?? entry?.location.symbol ?? node.symbol ?? method;

      targets.push({ method, file: node.file, symbol });
    }
  }

  return targets;
}

/** Every `server-function` node of a project, in graph order. */
function serverFunctions(project: IndexedProject): readonly CodeNodeOf<'server-function'>[] {
  return project.graph.nodesByKind('server-function');
}

/**
 * The server functions a route reaches along the graph's own call edges, with
 * the number of hops each is away.
 *
 * The traversal this suite computes is the one `extractors/server-functions.ts`
 * sanctions and `./nextjs.ts` performs: `calls` edges out of the `api-route`
 * node itself and out of the `symbol` nodes its module declares. `routes-to` is
 * deliberately not consulted — the vocabulary reserves it for `api-call` →
 * `api-route`, and this corpus holds none.
 *
 * @param project The indexed project.
 * @param depth How many hops to walk.
 * @returns Each reachable server function's name, mapped to its hop count.
 */
function reachableFunctions(project: IndexedProject, depth: number): ReadonlyMap<string, number> {
  const byId = new Map(serverFunctions(project).map((node) => [node.id, node]));
  const hopsByName = new Map<string, number>();

  for (const route of requestRoutes(project)) {
    const visited = new Set<string>([route.id]);
    let frontier: string[] = [route.id];

    for (const declaration of project.graph.nodesByFile(route.file)) {
      if (declaration.kind === 'symbol' && !visited.has(declaration.id)) {
        visited.add(declaration.id);
        frontier.push(declaration.id);
      }
    }

    for (let hop = 1; hop <= depth && frontier.length > 0; hop += 1) {
      const next: string[] = [];

      for (const id of frontier) {
        for (const edge of project.graph.outgoing(id, 'calls')) {
          if (visited.has(edge.to)) {
            continue;
          }

          visited.add(edge.to);
          next.push(edge.to);

          const called = byId.get(edge.to);

          if (called !== undefined) {
            const known = hopsByName.get(called.name);

            if (known === undefined || hop < known) {
              hopsByName.set(called.name, hop);
            }
          }
        }
      }

      frontier = next;
    }
  }

  return hopsByName;
}

/**
 * Whether the declaration at a position reads as a generator.
 *
 * Computed from the corpus's own text through the query surface's bounded
 * excerpt, so "the generator module" is a fact about the corpus rather than a
 * file name written here. Independent of the adapter's own check by
 * construction: a corpus that stopped carrying a generator would fail the
 * precondition guard instead of making the refusal case vacuous.
 *
 * @param project The indexed project.
 * @param file The declaring file, project-relative POSIX.
 * @param line The declaration's 1-based line.
 * @returns `true` when the declaration line carries a generator's asterisk.
 */
function declaresGenerator(project: IndexedProject, file: string, line: number): boolean {
  const excerpt = project.queries.excerpt({ file, line }, { contextLines: 0 });

  return excerpt !== undefined && /\bfunction\s*\*/u.test(excerpt.text);
}

/** Every file whose exported functions are, without exception, generators. */
function generatorOnlyModules(project: IndexedProject): ReadonlyMap<string, readonly string[]> {
  const byFile = new Map<string, CodeNodeOf<'server-function'>[]>();

  for (const node of serverFunctions(project)) {
    const bucket = byFile.get(node.file);

    if (bucket === undefined) {
      byFile.set(node.file, [node]);
    } else {
      bucket.push(node);
    }
  }

  const generatorOnly = new Map<string, readonly string[]>();

  for (const [file, nodes] of byFile) {
    if (nodes.every((node) => declaresGenerator(project, node.file, node.line))) {
      generatorOnly.set(file, nodes.map((node) => node.name).sort());
    }
  }

  return generatorOnly;
}

/** The exported server functions of a project a patch could actually wrap. */
function patchableFunctionNames(project: IndexedProject): readonly string[] {
  return serverFunctions(project)
    .filter((node) => !declaresGenerator(project, node.file, node.line))
    .map((node) => node.name)
    .sort();
}

/* -------------------------------------------------------------------------------------------------
 * Shared assertions
 * ---------------------------------------------------------------------------------------------- */

/**
 * Asserts that a developer-facing string is one bounded, non-blank line.
 *
 * The readiness schema refuses a blank, multi-line or over-long `reason` or
 * `hint` at the boundary, and a refusal there would drop the one sentence that
 * told the developer what to do.
 *
 * @param text The string to check.
 * @param label What the string is, for the failure message.
 */
function expectSingleLine(text: string, label: string): void {
  expect(text.length, `${label} must not be empty`).toBeGreaterThan(0);
  expect(text, `${label} must be trimmed`).toBe(text.trim());
  expect(text, `${label} must be one line`).not.toMatch(/[\r\n]/u);
  expect(text.length, `${label} must stay within the schema's bound`).toBeLessThanOrEqual(500);
}

/**
 * Asserts everything true of every action this adapter may emit.
 *
 * @param action The action.
 * @param project The project it was proposed for.
 */
function expectActionShape(action: InstrumentationAction, project: IndexedProject): void {
  const claimedTypes = NEXTJS_ADAPTER_CLAIMS.map((claim) => claim.type);

  // Parsed rather than eyeballed: the normalised plan schema is what
  // `normalizePlan` and `../feasibility.ts` will apply to it next.
  expect(instrumentationActionSchema.parse(action)).toEqual(action);
  expect(action.id).toMatch(ACTION_ID_PATTERN);
  expect(action.id.startsWith('act_'), `${action.id} must be an action id`).toBe(true);
  expect(action.adapter).toBe(NEXTJS_ADAPTER_ID);
  expect(action.mode).toBe('patch');
  expect(claimedTypes).toContain(action.type);
  expectSingleLine(action.rationale, `the rationale of ${action.file}#${action.symbol}`);
  expect(
    project.queries.hasSymbol(action.file, action.symbol),
    `${action.file}#${action.symbol} must be a symbol the code graph declares`,
  ).toBe(true);
}

/**
 * Asserts everything true of every gap this adapter may report.
 *
 * @param gap The entry.
 */
function expectGapShape(gap: UnavailableSignal): void {
  expect(CAPTURE_SIGNALS as readonly string[]).toContain(gap.signal);
  expectSingleLine(gap.reason, `the reason for ${String(gap.signal)}`);
  expectSingleLine(gap.hint, `the hint for ${String(gap.signal)}`);
}

/**
 * Asserts the equivalence `../installer.ts`'s reverse-restore depends on: the
 * files that changed on disk are exactly the files the reported records name.
 *
 * Never a record for a file that did not change, and never a changed file
 * without a record — in both directions, because the first would make cleanup
 * restore a file nobody touched and the second would leave a modification
 * nobody can undo.
 *
 * @param world The sandbox whose copy was patched.
 * @param applied The records the install reported.
 */
function expectRecordsMatchChanges(world: Sandbox, applied: readonly ModificationRecord[]): void {
  const changed = changedPaths(world.before, treeSnapshot(world.projectRoot));
  const reported = [...new Set(applied.map((record) => record.file))].sort();

  expect(changed).toEqual(reported);
}

/* -------------------------------------------------------------------------------------------------
 * The corpora, indexed once
 * ---------------------------------------------------------------------------------------------- */

/**
 * The scratch corpus: two route modules and a three-hop call chain.
 *
 * Every identifier is arbitrary and means nothing to this product — which is
 * the point. The committed corpus has one route with one method and a single
 * call hop, so it can prove the *rules* but not the *bounds*; this tree adds a
 * second route, a module with two method exports, and a chain deep enough for
 * the reachability depth bound to be observable. An adapter that recognised a
 * name rather than reading the graph would find nothing here.
 */
const CHAIN_SOURCES: Readonly<Record<string, string>> = {
  'app/api/zephyr-tallies/route.ts': [
    "import { gatherZephyrTally } from '../../../src/back/quoll-store';",
    '',
    'export async function POST(request: Request): Promise<Response> {',
    '  const body: unknown = await request.json();',
    '  const tally = await gatherZephyrTally(String(body));',
    '',
    '  return new Response(JSON.stringify(tally));',
    '}',
    '',
    'export async function GET(): Promise<Response> {',
    '  return new Response("[]");',
    '}',
    '',
  ].join('\n'),
  'app/api/brook-markers/route.ts': [
    'export async function PUT(): Promise<Response> {',
    '  return new Response("{}");',
    '}',
    '',
  ].join('\n'),
  'src/back/quoll-store.ts': [
    "import { widenMarkerSpan } from './marker-span';",
    '',
    'export async function gatherZephyrTally(markerId: string): Promise<unknown> {',
    '  return widenMarkerSpan(markerId);',
    '}',
    '',
  ].join('\n'),
  'src/back/marker-span.ts': [
    "import { settleDrift } from './drift';",
    '',
    'export async function widenMarkerSpan(markerId: string): Promise<unknown> {',
    '  return settleDrift(markerId);',
    '}',
    '',
  ].join('\n'),
  'src/back/drift.ts': [
    'export async function settleDrift(markerId: string): Promise<unknown> {',
    '  return { markerId };',
    '}',
    '',
  ].join('\n'),
};

/** The committed corpus, indexed once and never written to. */
let fixture: IndexedProject;

/** The scratch corpus of {@link CHAIN_SOURCES}. */
let chain: IndexedProject;

/** A project with no server tier at all: one page component and nothing else. */
let serverless: IndexedProject;

/** A project with exported server functions and no route module. */
let routeless: IndexedProject;

/** Every committed fixture file with its SHA-256, taken before anything ran. */
let fixtureSnapshotBefore: readonly string[];

beforeAll(async () => {
  fixtureSnapshotBefore = treeSnapshot(FIXTURE_ROOT);
  fixture = await indexProjectTree(FIXTURE_ROOT);
  chain = await scratchProject('chain', CHAIN_SOURCES);
  serverless = projectFromIndex(
    handAuthoredIndex('/tmp/debuggen-nextjs-serverless', [
      componentNode('src/ui/panel.tsx', 'QuiltPanel'),
    ]),
    fixture,
  );
  routeless = projectFromIndex(
    handAuthoredIndex('/tmp/debuggen-nextjs-routeless', [
      serverFunctionNode('src/back/ledger.ts', 'foldLedger'),
    ]),
    fixture,
  );

  assertCorpusInventory();
}, 180_000);

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  scratchRoots.length = 0;
});

/**
 * Fails the whole suite, immediately and with the reason, when a corpus does
 * not carry what the cases below assume.
 *
 * These are *preconditions*, not assertions about the adapter: if the committed
 * corpus stopped declaring a generator module, or stopped linking its route to
 * a service function, the cases that prove the refusal and the reachability
 * rules would pass vacuously. Throwing from `beforeAll` turns that into one
 * unambiguous failure instead of a suite that is quietly testing nothing.
 */
function assertCorpusInventory(): void {
  const routes = requestRoutes(fixture);

  if (routes.length !== 1) {
    throw new Error(
      `the corpus must declare exactly one request route module; found ${String(routes.length)}`,
    );
  }

  const [route] = routes;

  if (route === undefined || route.data.methods.length !== 1) {
    throw new Error(
      `the corpus's route must export exactly one HTTP method; found [${route?.data.methods.join(',') ?? ''}]`,
    );
  }

  const entry = routeEntryFor(fixture, route.file);

  if (
    entry === undefined ||
    entry.methodLocations?.[route.data.methods[0] as HttpMethodName] === undefined
  ) {
    throw new Error(
      `the route map must locate the corpus's ${String(route.data.methods[0])} export in ${route.file}`,
    );
  }

  const reachable = reachableFunctions(fixture, NEXTJS_ADAPTER_LIMITS.maxDepth);

  if (reachable.size !== 1) {
    throw new Error(
      `the corpus's handler must reach exactly one server function along call edges; found [${[...reachable.keys()].join(',')}]`,
    );
  }

  const generatorModules = generatorOnlyModules(fixture);

  if (generatorModules.size !== 1) {
    throw new Error(
      `the corpus must hold exactly one generator-only module; found [${[...generatorModules.keys()].join(',')}]`,
    );
  }

  const [generatorNames] = [...generatorModules.values()];

  if (generatorNames === undefined || generatorNames.length < 2) {
    throw new Error(
      'the generator-only module must declare at least two generators (one synchronous, one asynchronous)',
    );
  }

  if (patchableFunctionNames(fixture).length <= NEXTJS_ADAPTER_LIMITS.maxFunctionTargets) {
    throw new Error(
      `the corpus must declare more patchable server functions than one plan may time (${String(NEXTJS_ADAPTER_LIMITS.maxFunctionTargets)})`,
    );
  }

  const perFile = new Map<string, number>();

  for (const name of patchableFunctionNames(fixture)) {
    const node = serverFunctions(fixture).find((candidate) => candidate.name === name);

    if (node !== undefined) {
      perFile.set(node.file, (perFile.get(node.file) ?? 0) + 1);
    }
  }

  if (![...perFile.values()].some((count) => count >= 2)) {
    throw new Error(
      'the corpus must hold one module with two independently patchable exports (the follow-up chain case)',
    );
  }

  if (requestRoutes(chain).length < 2 || expectedMethodTargets(chain).length < 3) {
    throw new Error(
      `the scratch corpus must declare at least two routes and three method exports; found ${String(requestRoutes(chain).length)} and ${String(expectedMethodTargets(chain).length)}`,
    );
  }

  if (reachableFunctions(chain, 3).size !== 3) {
    throw new Error(
      `the scratch corpus must carry a three-hop call chain; found [${[...reachableFunctions(chain, 3).entries()].map(([name, hops]) => `${name}@${String(hops)}`).join(',')}]`,
    );
  }

  if (
    serverless.graph.nodesByKind('api-route').length +
      serverless.graph.nodesByKind('server-function').length >
    0
  ) {
    throw new Error(
      'the serverless corpus must carry neither an api-route nor a server-function node',
    );
  }

  if (
    routeless.graph.nodesByKind('api-route').length > 0 ||
    routeless.graph.nodesByKind('server-function').length !== 1
  ) {
    throw new Error('the routeless corpus must carry exactly one server function and no route');
  }
}

/* -------------------------------------------------------------------------------------------------
 * Identity, and the claim declaration the registry and the installer read
 * ---------------------------------------------------------------------------------------------- */

describe('identity and claims', () => {
  it('is registered under its own stable id', () => {
    // The id is stored on every plan and every modification record, so an id
    // that moved would orphan the rows read back after an upgrade.
    expect(NEXTJS_ADAPTER_ID).toBe('nextjs');
    expect(createNextJsAdapter().id).toBe(NEXTJS_ADAPTER_ID);
  });

  it('claims exactly the two patch-mode action types', () => {
    expect(NEXTJS_ADAPTER_CLAIMS.map((claim) => claim.type)).toEqual([
      'server-span',
      'function-timing',
    ]);

    for (const claim of NEXTJS_ADAPTER_CLAIMS) {
      // Asserted explicitly, and not as a detail: `../installer.ts` reads the
      // mode to install every runtime-mode group before any patch-mode group,
      // so a wrong mode here would silently change install ordering rather
      // than fail.
      expect(claim.mode, `${claim.type} must be installed as a patch`).toBe('patch');
      expect(INSTRUMENTATION_ACTION_TYPES as readonly string[]).toContain(claim.type);
      expect(INSTRUMENTATION_MODES as readonly string[]).toContain(claim.mode);
    }

    expect(createNextJsAdapter().claims).toBe(NEXTJS_ADAPTER_CLAIMS);
    expect(Object.isFrozen(NEXTJS_ADAPTER_CLAIMS)).toBe(true);
  });

  it('contributes server-agent keys that exist, including the function list', () => {
    for (const key of NEXTJS_SERVER_SIGNAL_KEYS) {
      expect(SERVER_AGENT_SIGNAL_KEYS as readonly string[]).toContain(key);
      // Each key doubles as a capture signal, which is what lets one tuple
      // drive the signal contribution, the readiness rows and the gaps.
      expect(CAPTURE_SIGNALS as readonly string[]).toContain(key);
      expect(Object.keys(DISABLED_SERVER_AGENT_SIGNALS)).toContain(key);
    }

    expect(NEXTJS_SERVER_SIGNAL_KEYS).toContain('functions');
    expect(new Set(NEXTJS_SERVER_SIGNAL_KEYS).size).toBe(NEXTJS_SERVER_SIGNAL_KEYS.length);
    // The database keys belong to the two database adapters; this one never
    // speaks for them.
    expect(NEXTJS_SERVER_SIGNAL_KEYS).not.toContain('prisma');
    expect(NEXTJS_SERVER_SIGNAL_KEYS).not.toContain('pg');
  });

  it('publishes hook labels and bounds a caller can assert against', () => {
    expect(NEXTJS_RUNTIME_HOOKS.length).toBeGreaterThan(0);
    expect([...NEXTJS_RUNTIME_HOOKS]).toEqual([...NEXTJS_RUNTIME_HOOKS].sort());
    expect(new Set(NEXTJS_RUNTIME_HOOKS).size).toBe(NEXTJS_RUNTIME_HOOKS.length);
    expect(Object.isFrozen(NEXTJS_RUNTIME_HOOKS)).toBe(true);

    expect(NEXTJS_ADAPTER_LIMITS.maxRouteTargets).toBeLessThanOrEqual(
      NEXTJS_ADAPTER_LIMITS.maxTargetsCeiling,
    );
    expect(NEXTJS_ADAPTER_LIMITS.maxFunctionTargets).toBeLessThanOrEqual(
      NEXTJS_ADAPTER_LIMITS.maxTargetsCeiling,
    );
    expect(NEXTJS_ADAPTER_LIMITS.maxDepth).toBeLessThanOrEqual(
      NEXTJS_ADAPTER_LIMITS.maxDepthCeiling,
    );
    expect(NEXTJS_ADAPTER_LIMITS.heartbeatStalenessMs).toBeGreaterThan(0);
    expect(DEBUGGEN_NODE_PRELOAD_SPECIFIER).toBe('@debuggen/telemetry/node/register');
  });

  it('constructs nothing at module load and keeps instances independent', () => {
    const first = createNextJsAdapter();
    const second = createNextJsAdapter({ maxRouteTargets: 0, maxFunctionTargets: 0 });

    expect(first).not.toBe(second);
    expect(first.id).toBe(second.id);

    // The patcher is built inside an install, from the injected factory, and
    // never at module scope: the package declares `sideEffects: false`, and
    // `createPatcher` appearing only as a default value is what keeps that
    // true. (The import-boundary group re-reads this source for the rest.)
    expect(adapterSourceWithoutComments()).not.toContain('createPatcher(');
  });
});

/* -------------------------------------------------------------------------------------------------
 * `canHandle`: cheap, synchronous, and about the graph alone
 * ---------------------------------------------------------------------------------------------- */

describe('canHandle', () => {
  it('answers synchronously with a boolean for a project that has a server tier', () => {
    const answer = createNextJsAdapter().canHandle(contextFor({ project: fixture }));

    expect(typeof answer).toBe('boolean');
    expect(answer).not.toBeInstanceOf(Promise);
    expect(answer).toBe(true);
  });

  it('declines a project with neither a route module nor a server function', () => {
    expect(createNextJsAdapter().canHandle(contextFor({ project: serverless }))).toBe(false);
  });

  it('accepts a project with server functions and no route module', () => {
    // A deliberate capability decision rather than an accident: a function a
    // question names is worth timing even when no route module reaches it, and
    // a project that reached its server tier through server actions alone
    // would otherwise be invisible to this adapter.
    expect(createNextJsAdapter().canHandle(contextFor({ project: routeless }))).toBe(true);
  });

  it('answers the same under every readiness preset', () => {
    const adapter = createNextJsAdapter();

    for (const [name, readiness] of presetEntries(fixture.root)) {
      // Capability is not readiness. Conflating them would make this adapter
      // invisible exactly when its relaunch hint is the thing a developer
      // needs (AAP §0.5.5).
      expect(
        adapter.canHandle(contextFor({ project: fixture, readiness })),
        `canHandle must not depend on the '${name}' preload state`,
      ).toBe(true);
    }
  });

  it('reaches neither the filesystem nor the journal', () => {
    // Both doubles throw on every method, so an answer at all is the evidence.
    const context = contextFor({
      project: fixture,
      journal: forbiddenJournal,
      backups: forbiddenBackups(`${UNWRITABLE_STATE_ROOT}/backups/${SESSION_ID}`),
    });

    expect(createNextJsAdapter().canHandle(context)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * `createPlan`: route methods, reachable functions, and the refusals
 * ---------------------------------------------------------------------------------------------- */

/** Every route path a project declares, read from its route nodes. */
function routePathsOf(project: IndexedProject): readonly string[] {
  return requestRoutes(project).map((node) => node.data.routePath);
}

/** Actions of one type, in the order the plan proposed them. */
function actionsOfType(
  actions: readonly InstrumentationAction[],
  type: InstrumentationActionType,
): readonly InstrumentationAction[] {
  return actions.filter((action) => action.type === type);
}

/**
 * A plan proposed with every cap wide open.
 *
 * The ceiling rather than the default, so a refusal is visible as an absence
 * rather than hidden behind a cap: the committed corpus declares more patchable
 * functions than one plan may time, and a case about generators has to be able
 * to see the whole candidate set.
 *
 * @param project The project to plan for.
 * @param understanding The question. Defaults to the whole server tier.
 * @param options Extra adapter options, for the depth cases.
 * @returns The proposed actions.
 */
async function wholePlan(
  project: IndexedProject,
  understanding: ProblemUnderstanding = serverQuestion,
  options: { readonly maxDepth?: number } = {},
): Promise<readonly InstrumentationAction[]> {
  return createNextJsAdapter({
    maxRouteTargets: NEXTJS_ADAPTER_LIMITS.maxTargetsCeiling,
    maxFunctionTargets: NEXTJS_ADAPTER_LIMITS.maxTargetsCeiling,
    ...options,
  }).createPlan(contextFor({ project }), understanding);
}

describe('createPlan', () => {
  it('proposes only well-formed patch actions', async () => {
    const actions = await wholePlan(fixture);

    expect(actions.length).toBeGreaterThan(0);

    for (const action of actions) {
      expectActionShape(action, fixture);
    }

    expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length);
    // The plan crosses a process boundary as `instrumentation.plan`, so
    // anything that does not survive JSON is a defect here rather than there.
    expect(JSON.parse(JSON.stringify(actions))).toEqual(actions);
  });

  it('wraps exactly the method exports the graph and the route map declare', async () => {
    const expected = expectedMethodTargets(fixture);
    const actions = await wholePlan(fixture);
    const serverSpans = actionsOfType(actions, 'server-span');

    expect(expected.length).toBeGreaterThan(0);
    expect(serverSpans.map((action) => `${action.file}#${action.symbol}`)).toEqual(
      expected.map((target) => `${target.file}#${target.symbol}`),
    );

    for (const action of serverSpans) {
      // The rationale states the evidence: the route the graph recorded, and
      // the method export it declares.
      const route = requestRoutes(fixture).find((node) => node.file === action.file);

      expect(route).toBeDefined();
      expect(action.rationale).toContain(route?.data.routePath ?? '');
      expect(action.rationale).toContain(action.symbol);
    }

    // The decisive negative: a method the module does not export is never
    // proposed, so a plan cannot name a handler that does not exist.
    const declared = new Set(expected.map((target) => target.method as string));
    const undeclared = HTTP_METHOD_NAMES.filter((method) => !declared.has(method));

    expect(undeclared.length).toBeGreaterThan(0);

    for (const action of actions) {
      expect(
        undeclared as readonly string[],
        `no action may name ${action.symbol}, which this module does not export`,
      ).not.toContain(action.symbol);
    }
  });

  it('times the server function the handler reaches, and says how far away it is', async () => {
    const reachable = reachableFunctions(fixture, NEXTJS_ADAPTER_LIMITS.maxDepth);
    const actions = await wholePlan(fixture);
    const timings = actionsOfType(actions, 'function-timing');
    const paths = routePathsOf(fixture);

    expect(reachable.size).toBeGreaterThan(0);

    for (const name of reachable.keys()) {
      expect(
        timings.map((action) => action.symbol),
        `the plan must time ${name}, which the handler reaches along a call edge`,
      ).toContain(name);
    }

    for (const action of timings) {
      if (reachable.has(action.symbol)) {
        // Reachability is the evidence, so the rationale names the route the
        // function sits behind rather than merely the file it lives in.
        expect(paths.some((path) => action.rationale.includes(path))).toBe(true);
      } else {
        expect(action.rationale).toContain(action.file);
        expect(paths.some((path) => action.rationale.includes(path))).toBe(false);
      }
    }
  });

  it('bounds reachability by the configured depth', async () => {
    const [path] = routePathsOf(chain);

    expect(path).toBeDefined();

    for (const maxDepth of [0, 1, 2, 3]) {
      const expected = reachableFunctions(chain, maxDepth);
      const actions = await wholePlan(chain, serverQuestion, { maxDepth });
      const named = actionsOfType(actions, 'function-timing')
        .filter((action) => routePathsOf(chain).some((route) => action.rationale.includes(route)))
        .map((action) => action.symbol)
        .sort();

      // The candidate set is the whole project at every depth — the cap is
      // wide open — so what the depth changes is which functions count as
      // *reachable evidence*, which the rationale states and this compares.
      expect(
        named,
        `depth ${String(maxDepth)} must attribute exactly the reachable functions`,
      ).toEqual([...expected.keys()].sort());
    }

    // And the bound is a real bound: the deepest hop of the chain is excluded
    // at the default depth and included past it.
    expect(reachableFunctions(chain, 3).size).toBeGreaterThan(
      reachableFunctions(chain, NEXTJS_ADAPTER_LIMITS.maxDepth).size,
    );
  });

  it('never proposes a symbol from the generator-only module', async () => {
    const generatorModules = generatorOnlyModules(fixture);
    const actions = await wholePlan(fixture);

    for (const [file, names] of generatorModules) {
      for (const name of names) {
        // Both the synchronous and the asynchronous generator, because the
        // module's whole symbol list is resolved from the graph rather than
        // named here. A generator has no function-timing template, so the
        // refusal belongs in the proposal — `../feasibility.ts` and the
        // patcher are a second line of defence, not a substitute (AAP §0.5.1).
        expect(
          actions.map((action) => `${action.file}#${action.symbol}`),
          `${file}#${name} is a generator and must never be proposed`,
        ).not.toContain(`${file}#${name}`);
      }
    }

    // Everything else the corpus exports is proposed, so the refusal is
    // specific rather than a blanket omission of the module's neighbours.
    for (const name of patchableFunctionNames(fixture)) {
      expect(actions.map((action) => action.symbol)).toContain(name);
    }
  });

  it('narrows to the route a request path resolves to', async () => {
    const entries = chain.routeMap.entries;
    const unnarrowed = await createNextJsAdapter({
      maxRouteTargets: 1,
      maxFunctionTargets: 0,
    }).createPlan(contextFor({ project: chain }), routeOnlyQuestion);
    const defaultFile = unnarrowed[0]?.file;

    expect(entries.length).toBeGreaterThan(1);
    expect(defaultFile).toBeDefined();

    let narrowingChangedTheAnswer = false;

    for (const entry of entries) {
      for (const understanding of [
        understandingFor(['routeHandlers'], [], [entry.routePath]),
        understandingFor(['routeHandlers'], [{ kind: 'url', name: entry.routePath }]),
      ]) {
        const actions = await createNextJsAdapter({
          maxRouteTargets: 1,
          maxFunctionTargets: 0,
        }).createPlan(contextFor({ project: chain }), understanding);

        // Verified independently against BOTH of the product's own resolvers,
        // which is what proves the adapter delegated to the single route
        // algorithm rather than re-deriving one of its own.
        expect(chain.queries.routeForUrl(entry.routePath)?.file).toBe(entry.file);
        expect(chain.routeMap.resolve(entry.routePath)?.entry.file).toBe(entry.file);
        expect(actions).toHaveLength(1);
        expect(actions[0]?.file).toBe(entry.file);

        if (entry.file !== defaultFile) {
          narrowingChangedTheAnswer = true;
        }
      }
    }

    // Without this the case would pass against an adapter that ignored the
    // question and always chose the first route.
    expect(narrowingChangedTheAnswer).toBe(true);
  });

  it('proposes nothing when the question asks for no server signal', async () => {
    const actions = await wholePlan(fixture, browserQuestion);

    expect(actions).toEqual([]);
  });

  it('keeps the two families on their own signals', async () => {
    const routeOnly = await wholePlan(fixture, routeOnlyQuestion);
    const functionOnly = await wholePlan(fixture, functionOnlyQuestion);

    expect(routeOnly.length).toBeGreaterThan(0);
    expect(actionsOfType(routeOnly, 'function-timing')).toEqual([]);

    expect(functionOnly.length).toBeGreaterThan(0);
    expect(actionsOfType(functionOnly, 'server-span')).toEqual([]);
  });

  it('honours each family cap independently, and a zero cap exactly', async () => {
    const defaults = await createNextJsAdapter().createPlan(
      contextFor({ project: fixture }),
      serverQuestion,
    );

    // The corpus declares more patchable functions than one plan may time —
    // the precondition guard insists on it — so the default cap is measured
    // against the exported constant at a real ceiling.
    expect(actionsOfType(defaults, 'function-timing')).toHaveLength(
      NEXTJS_ADAPTER_LIMITS.maxFunctionTargets,
    );

    const cappedRoutes = await createNextJsAdapter({
      maxRouteTargets: 2,
      maxFunctionTargets: 0,
    }).createPlan(contextFor({ project: chain }), serverQuestion);

    expect(expectedMethodTargets(chain).length).toBeGreaterThan(2);
    expect(cappedRoutes).toHaveLength(2);
    expect(actionsOfType(cappedRoutes, 'server-span')).toHaveLength(2);

    const noRoutes = await createNextJsAdapter({ maxRouteTargets: 0 }).createPlan(
      contextFor({ project: fixture }),
      serverQuestion,
    );

    // Zero is honoured rather than raised to one: a caller that asks for no
    // route targets is switching that family off, and proposing one anyway
    // would be the adapter deciding to touch a file it was told not to.
    expect(actionsOfType(noRoutes, 'server-span')).toEqual([]);
    expect(actionsOfType(noRoutes, 'function-timing').length).toBeGreaterThan(0);

    const nothing = await createNextJsAdapter({
      maxRouteTargets: 0,
      maxFunctionTargets: 0,
    }).createPlan(contextFor({ project: fixture }), serverQuestion);

    expect(nothing).toEqual([]);
  });

  it('proposes the same plan twice, in the same order', async () => {
    // Identity is deliberately excluded: ids are freshly minted per call, so
    // everything else is what has to match.
    const strip = (actions: readonly InstrumentationAction[]): unknown =>
      actions.map((action) => ({
        file: action.file,
        symbol: action.symbol,
        type: action.type,
        adapter: action.adapter,
        mode: action.mode,
        rationale: action.rationale,
      }));

    const first = await wholePlan(fixture);
    const second = await wholePlan(fixture);

    // Two runs of one session must propose one plan: the install order, the
    // journal sequence and the cleanup walk are all derived from it.
    expect(strip(second)).toEqual(strip(first));
    expect(second.map((action) => action.id)).not.toEqual(first.map((action) => action.id));
  });

  it('returns an empty plan, never a rejection, when there is nothing to propose', async () => {
    const adapter = createNextJsAdapter();
    const cancelled = new AbortController();

    cancelled.abort();

    await expect(
      adapter.createPlan(contextFor({ project: serverless }), serverQuestion),
    ).resolves.toEqual([]);
    await expect(
      adapter.createPlan(
        contextFor({ project: fixture, signal: cancelled.signal }),
        serverQuestion,
      ),
    ).resolves.toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * `install` with no preload attached: the no-write guarantee
 * ---------------------------------------------------------------------------------------------- */

/**
 * A small plan for one project: one route handler and two server functions.
 *
 * Small on purpose — the install cases below run the *real* patcher, and three
 * targets across three files already exercise the whole sequence (a route
 * module, a module the handler reaches, and a module it does not) without
 * rewriting twenty files per case.
 *
 * @param project The project to plan for.
 * @returns The proposed actions.
 */
async function smallPlan(project: IndexedProject): Promise<readonly InstrumentationAction[]> {
  return createNextJsAdapter({ maxRouteTargets: 1, maxFunctionTargets: 2 }).createPlan(
    contextFor({ project }),
    serverQuestion,
  );
}

/** The absolute path of a file inside a sandbox's copy. */
function inSandbox(world: Sandbox, file: string): string {
  return join(world.projectRoot, file);
}

/** Whether a backup directory holds anything at all. */
function backupEntries(world: Sandbox): readonly string[] {
  try {
    return readdirSync(world.backupDirectory).sort();
  } catch {
    // Absent is the stronger form of empty: nothing even created the
    // directory, which is what "no backup was taken" looks like on disk.
    return [];
  }
}

describe('install with no preload attached', () => {
  it('writes nothing, journals nothing, and backs up nothing', async () => {
    const world = await sandbox();
    const { context, journal } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).notConnected,
    });
    const actions = await smallPlan(world.project);

    expect(actions.length).toBeGreaterThan(0);

    // Degradation is data, never an exception: the session continues with a
    // narrower capture, so this must resolve.
    const result = await createNextJsAdapter().install(actions, context);

    expect(result.adapterId).toBe(NEXTJS_ADAPTER_ID);
    expect(result.applied).toEqual([]);
    expect(result.runtimeHooks).toEqual([]);
    expect(result.serverSignals).toBeUndefined();

    // A file modification that cannot produce a span is pure risk to a
    // developer's working tree (AAP §0.5.1), so the evidence is the disk.
    expect(changedPaths(world.before, treeSnapshot(world.projectRoot))).toEqual([]);
    expect(journal.events).toEqual([]);
    expect(backupEntries(world)).toEqual([]);
  });

  it('reports every server signal it speaks for, with an actionable relaunch hint', async () => {
    const world = await sandbox();
    const { context } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).notConnected,
    });
    const result = await createNextJsAdapter().install(await smallPlan(world.project), context);

    expect(result.unavailable.map((gap) => gap.signal)).toEqual([...NEXTJS_SERVER_SIGNAL_KEYS]);

    for (const gap of result.unavailable) {
      expectGapShape(gap);
      expect(gap.reason.toLowerCase()).toContain('preload');
      // The hint has to name WHICH project to relaunch: a developer with two
      // dev servers open cannot act on an instruction that names neither.
      expect(gap.hint, 'the hint must name the project root').toContain(world.projectRoot);
      expect(gap.hint).toContain(DEBUGGEN_NODE_PRELOAD_SPECIFIER);
      // One copy-pasteable instruction rather than a paragraph of advice.
      expect(gap.hint).toContain('NODE_OPTIONS');
    }

    // The patched-span signal says so explicitly, because its gap is the one
    // that also explains why no file was touched.
    const patched = result.unavailable.find((gap) => gap.signal === 'functions');

    expect(patched?.reason).toContain('no file was modified');
  });

  it('treats a lost connection and a sibling project as the same absence', async () => {
    const presetsFor = (world: Sandbox): readonly [string, ObservedReadinessInputs][] => {
      const presets = preloadPresets(world.projectRoot);

      return [
        ['disconnected', presets.disconnected],
        ['otherProject', presets.otherProject],
      ];
    };

    const world = await sandbox('equivalence');

    for (const [name, readiness] of presetsFor(world)) {
      const { context, journal } = writableContext(world, { readiness });
      const result = await createNextJsAdapter().install(await smallPlan(world.project), context);

      // All three "absent" states mean the same thing to a developer and are
      // fixed by the same relaunch, which is why the adapter does not split
      // them — and why none of them may write.
      expect(result.applied, `the '${name}' state must apply nothing`).toEqual([]);
      expect(result.unavailable.map((gap) => gap.signal)).toEqual([...NEXTJS_SERVER_SIGNAL_KEYS]);
      expect(changedPaths(world.before, treeSnapshot(world.projectRoot))).toEqual([]);
      expect(journal.events).toEqual([]);
    }
  });

  it('uses an injected relaunch descriptor verbatim and reads no environment variable', async () => {
    const relaunch = {
      preloadSpecifier: '/opt/debuggen/telemetry/register.mjs',
      devCommand: 'bun run start-dev',
      envVarNames: ['ZEPHYR_INGEST_URL', 'ALPHA_TOKEN_NAME'],
    } as const;

    // Both would be plausible sources for a hint composed from the ambient
    // process. Nothing this adapter emits may quote them.
    vi.stubEnv('NODE_OPTIONS', '--import /stubbed/from/the/environment.mjs');
    vi.stubEnv('DEBUGGEN_INGEST_URL', 'http://127.0.0.1:65535/stubbed-ingest');

    // A sandbox rather than the committed corpus, and not for the write: the
    // hint is one bounded line (the readiness schema refuses a longer one), so
    // a project root as deep as this repository's own checkout would legitimately
    // truncate the tail the descriptor contributes. The sandbox's root is short,
    // which is what lets the verbatim assertions below be about the composition
    // instead of about the bound.
    const world = await sandbox();
    const { context, journal } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).notConnected,
    });
    const result = await createNextJsAdapter({ relaunch }).install(
      await smallPlan(world.project),
      context,
    );

    expect(result.unavailable.length).toBeGreaterThan(0);

    for (const gap of result.unavailable) {
      expect(gap.hint).toContain(`--import ${relaunch.preloadSpecifier}`);
      expect(gap.hint).toContain(relaunch.devCommand);
      expect(gap.hint).toContain(world.projectRoot);

      for (const name of relaunch.envVarNames) {
        // Names only, never values: the ingest URL and the per-launch
        // credential are minted by the launcher (AAP §0.5.6), and a hint that
        // quoted one would be a credential in a user interface.
        expect(gap.hint).toContain(name);
      }

      expect(gap.hint).not.toContain(DEBUGGEN_NODE_PRELOAD_SPECIFIER);
      expect(gap.hint).not.toContain('/stubbed/from/the/environment.mjs');
      expect(gap.hint).not.toContain('stubbed-ingest');
    }

    // Still the no-write branch, descriptor or not.
    expect(result.applied).toEqual([]);
    expect(journal.events).toEqual([]);
    expect(changedPaths(world.before, treeSnapshot(world.projectRoot))).toEqual([]);
  });

  it('degrades in different words when the preload is connected but silent', async () => {
    const absent = await createNextJsAdapter().install(
      await smallPlan(fixture),
      contextFor({ project: fixture, readiness: preloadPresets(fixture.root).notConnected }),
    );

    const world = await sandbox();
    const { context, journal } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).stale,
    });
    const silent = await createNextJsAdapter().install(await smallPlan(world.project), context);

    // The transport exists, so a configuration still reaches the preload: the
    // patches are applied and the doubt is reported alongside them.
    expect(silent.applied.length).toBeGreaterThan(0);
    expect(journal.events.length).toBeGreaterThan(0);
    expect(silent.unavailable.map((gap) => gap.signal)).toEqual([...NEXTJS_SERVER_SIGNAL_KEYS]);

    for (const gap of silent.unavailable) {
      expectGapShape(gap);

      const sameSignal = absent.unavailable.find((other) => other.signal === gap.signal);

      // Driven by the injected clock rather than by waiting, and worded for
      // the state it describes: "has not reported for N seconds" is a
      // different instruction from "no preload is attached".
      expect(sameSignal).toBeDefined();
      expect(gap.reason).not.toBe(sameSignal?.reason);
      expect(gap.hint).not.toBe(sameSignal?.hint);
      expect(gap.hint).toContain(world.projectRoot);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * `install` with the preload attached: the real patcher, and accurate reporting
 * ---------------------------------------------------------------------------------------------- */

/** A patcher double, for the case that proves the factory seam is used. */
function stubPatcher(options: PatcherOptions, seen: InstrumentationAction[][]): Patcher {
  const refuse = (what: string): never => {
    throw new Error(`the adapter must not call ${what} on the patcher`);
  };

  return {
    sessionId: options.sessionId,
    planVersion: options.planVersion,
    projectRoot: options.projectRoot,
    patchAction: () => refuse('patchAction'),
    patchTarget: () => refuse('patchTarget'),
    patchActions: (actions: readonly InstrumentationAction[]) => {
      seen.push([...actions]);

      return Promise.resolve({ applied: [], journaled: [], failure: undefined });
    },
    journaledRecords: () => [],
    detectedConflicts: () => [],
  };
}

/**
 * A hand-written action, for the cases that hand this adapter something a plan
 * would not have proposed.
 *
 * @param file The declaring file, project-relative POSIX.
 * @param symbol The symbol to address.
 * @param type The action type. Defaults to `function-timing`.
 * @param adapter The owning adapter id. Defaults to this adapter's.
 * @returns The action, validated against the plan schema.
 */
function handWrittenAction(
  file: string,
  symbol: string,
  type: InstrumentationActionType = 'function-timing',
  adapter: string = NEXTJS_ADAPTER_ID,
): InstrumentationAction {
  return instrumentationActionSchema.parse({
    id: `act_${sha256Hex(`${file}#${symbol}`).slice(0, 16)}`,
    file,
    symbol,
    type,
    adapter,
    mode: adapter === NEXTJS_ADAPTER_ID ? 'patch' : 'runtime',
    rationale: 'Handed to the adapter by this suite, to be reported on rather than guessed at.',
  });
}

describe('install with the preload attached', () => {
  it('applies every planned target through the real patcher and reports it accurately', async () => {
    const world = await sandbox();
    const { context } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).fresh,
    });
    const actions = await smallPlan(world.project);
    const result = await createNextJsAdapter().install(actions, context);

    expect(actions.length).toBeGreaterThan(1);
    expect(result.applied).toHaveLength(actions.length);
    expect(result.unavailable).toEqual([]);

    for (const record of result.applied) {
      // The record is what `../cleanup.ts` will restore from, so it is parsed
      // rather than inspected: a field the store would reject is a defect
      // here, not there.
      expect(modificationRecordSchema.parse(record)).toEqual(record);
      expect(record.sessionId).toBe(SESSION_ID);
      expect(record.planVersion).toBe(PLAN_VERSION);
      expect(record.status).toBe('applied');
      expect(record.file).not.toMatch(/^[/\\]|\\|(?:^|\/)\.\.(?:\/|$)/u);
      expect(record.originalHash).not.toBe(record.instrumentedHash);
      expect(record.backupPath.startsWith(world.debuggenHome)).toBe(true);
      expect(record.diff.length).toBeGreaterThan(0);
      expect(record.diff).toContain(record.file);

      // The file now holds the patched bytes, and the backup holds exactly the
      // bytes it held before — which is the whole of the reversibility
      // promise, checked on disk rather than taken from the record.
      expect(sha256Hex(readFileSync(inSandbox(world, record.file)))).toBe(record.instrumentedHash);
      expect(sha256Hex(readFileSync(record.backupPath))).toBe(record.originalHash);
    }

    // Every file that changed is reported, and nothing else changed.
    expectRecordsMatchChanges(world, result.applied);
    expect(backupEntries(world)).toHaveLength(result.applied.length);
  });

  it('journals a pending row carrying both hashes before the file changes', async () => {
    const world = await sandbox();
    const { context, journal } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).fresh,
    });
    const result = await createNextJsAdapter().install(await smallPlan(world.project), context);

    expect(result.applied.length).toBeGreaterThan(0);

    for (const record of result.applied) {
      const events = journal.events.filter((event) => event.recordId === record.id);
      const [pending, applied] = events;

      // The ordering that makes crash reconciliation decidable: the row knows
      // the expected post-write hash before anything is written, so a file
      // found at either hash has an unambiguous verdict (AAP §0.5.1).
      // Failure injection is `patch/patcher.test.ts`'s territory; what this
      // suite pins is that the adapter drives the sequence rather than
      // reporting a record the store never saw.
      expect(events.map((event) => `${event.method}:${event.status}`)).toEqual([
        'append:pending',
        'updateStatus:applied',
      ]);
      expect(pending?.originalHash).toBe(record.originalHash);
      expect(pending?.instrumentedHash).toBe(record.instrumentedHash);
      expect(
        pending?.onDiskHash,
        'the file must still hold the original when the row appears',
      ).toBe(record.originalHash);
      expect(applied?.onDiskHash, 'the file must hold the patch when the row turns applied').toBe(
        record.instrumentedHash,
      );
    }

    // No record is hand-built: every one reported is a row the journal
    // actually received.
    const appended = new Set(
      journal.events.filter((event) => event.method === 'append').map((event) => event.recordId),
    );

    for (const record of result.applied) {
      expect(appended.has(record.id), `${record.id} must be a row the journal received`).toBe(true);
    }

    expect(appended.size).toBe(result.applied.length);
  });

  it('reports the hooks and the signal contribution the preload is told to arm', async () => {
    const world = await sandbox();
    const { context } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).fresh,
    });
    const actions = await smallPlan(world.project);
    const result = await createNextJsAdapter().install(actions, context);

    expect(result.runtimeHooks.length).toBeGreaterThan(0);
    expect([...result.runtimeHooks]).toEqual([...result.runtimeHooks].sort());
    expect(new Set(result.runtimeHooks).size).toBe(result.runtimeHooks.length);

    for (const hook of result.runtimeHooks) {
      expect(NEXTJS_RUNTIME_HOOKS).toContain(hook);
    }

    const contribution = result.serverSignals;

    expect(contribution).toBeDefined();
    // A contribution states what THIS adapter enabled, so a key it derived as
    // off is omitted rather than sent as `false` — which is why the parse is
    // of the merge with the disabled set rather than of the fragment alone.
    expect(
      serverAgentSignalsSchema.parse({
        ...DISABLED_SERVER_AGENT_SIGNALS,
        functions: [],
        ...contribution,
      }),
    ).toMatchObject({ http: true, routeHandlers: true });

    for (const key of Object.keys(contribution ?? {})) {
      expect(NEXTJS_SERVER_SIGNAL_KEYS as readonly string[]).toContain(key);
    }

    const functions = contribution?.functions ?? [];
    const expected = [...new Set(actions.map((action) => action.symbol))].sort();

    expect([...functions].sort()).toEqual(expected);
    expect(functions).toEqual([...functions].sort());
    expect(new Set(functions).size).toBe(functions.length);

    // The page agent's hooks are the React, fetch and performance adapters' to
    // contribute; this one never speaks for them.
    expect(result.agentHooks).toBeUndefined();
  });

  it('reports a target it cannot wrap as data, and applies the rest', async () => {
    const world = await sandbox();
    const { context, journal } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).fresh,
    });
    const [generatorFile] = [...generatorOnlyModules(world.project).keys()];
    const generatorNames = generatorOnlyModules(world.project).get(generatorFile ?? '') ?? [];
    const [generatorSymbol] = generatorNames;

    expect(generatorFile).toBeDefined();
    expect(generatorSymbol).toBeDefined();

    const planned = await smallPlan(world.project);
    const refused = handWrittenAction(generatorFile ?? '', generatorSymbol ?? '');
    const result = await createNextJsAdapter().install([refused, ...planned], context);

    // The batch stops at its first failure and the sequence continues after
    // it, so one unsupported declaration does not cost the capture every
    // target behind it.
    expect(result.applied.map((record) => record.file).sort()).toEqual(
      [...new Set(planned.map((action) => action.file))].sort(),
    );
    expect(result.unavailable).toHaveLength(1);

    for (const gap of result.unavailable) {
      expectGapShape(gap);
      // The signal that is lost is the span the wrapper would have emitted,
      // never the runtime spans the preload still produces on its own.
      expect(gap.signal).toBe('functions');
      expect(gap.reason).toContain(generatorSymbol ?? '');
      expect(gap.reason).toContain(generatorFile ?? '');
    }

    // The refused file is untouched, and the reported records still match the
    // files that changed.
    expect(changedPaths(world.before, treeSnapshot(world.projectRoot))).not.toContain(
      generatorFile,
    );
    expectRecordsMatchChanges(world, result.applied);
    expect(
      journal.events.filter((event) => event.file === generatorFile),
      'the refused target must never reach the journal',
    ).toEqual([]);
  });

  it('never reports a record for a file that did not change, even when cancelled', async () => {
    const world = await sandbox();
    const cancelled = new AbortController();

    cancelled.abort();

    const { context } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).fresh,
      signal: cancelled.signal,
    });
    const result = await createNextJsAdapter().install(await smallPlan(world.project), context);

    // Either nothing was applied or `applied` names exactly what was written:
    // that equivalence is what `../installer.ts`'s reverse-restore depends on,
    // and it is asserted in both directions.
    expectRecordsMatchChanges(world, result.applied);
    expect(result.unavailable.length).toBeGreaterThan(0);

    for (const gap of result.unavailable) {
      expectGapShape(gap);
    }
  });

  it('builds its patcher through the injected factory, and writes nothing through a double', async () => {
    const world = await sandbox();
    const { context, journal } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).fresh,
    });
    const batches: InstrumentationAction[][] = [];
    const factory = vi.fn((options: PatcherOptions): Patcher => stubPatcher(options, batches));
    const actions = await smallPlan(world.project);
    const result = await createNextJsAdapter({ patcherFactory: factory }).install(actions, context);

    // One patcher per install call: its duplicate-target guard is scoped to
    // this plan version, and chaining across plan versions is the patcher's
    // own business, resolved through the journal it is handed.
    expect(factory).toHaveBeenCalledTimes(1);

    const options = factory.mock.calls[0]?.[0];

    expect(options?.sessionId).toBe(SESSION_ID);
    expect(options?.planVersion).toBe(PLAN_VERSION);
    expect(options?.projectRoot).toBe(world.projectRoot);
    expect(options?.journal).toBe(journal);
    expect(options?.backups).toBe(context.backups);

    // The accepted actions reach the patcher once, in a file-then-declaration
    // order, so two runs of one plan journal the same sequence.
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((action) => action.id).sort()).toEqual(
      actions.map((action) => action.id).sort(),
    );
    expect(batches[0]?.map((action) => action.file)).toEqual(
      [...(batches[0] ?? [])].map((action) => action.file).sort(),
    );

    expect(result.applied).toEqual([]);
    expect(changedPaths(world.before, treeSnapshot(world.projectRoot))).toEqual([]);
    expect(journal.events).toEqual([]);
  });

  it('ignores actions it does not claim, and builds no patcher for them', async () => {
    const world = await sandbox();
    const { context, journal } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).fresh,
    });
    const [target] = await smallPlan(world.project);
    const factory = vi.fn((options: PatcherOptions): Patcher => stubPatcher(options, []));

    expect(target).toBeDefined();

    const result = await createNextJsAdapter({ patcherFactory: factory }).install(
      [
        handWrittenAction(
          target?.file ?? '',
          target?.symbol ?? '',
          'react-render-tracking',
          'react',
        ),
        handWrittenAction(target?.file ?? '', target?.symbol ?? '', 'db-query-tracking'),
      ],
      context,
    );

    expect(result).toEqual({
      adapterId: NEXTJS_ADAPTER_ID,
      applied: [],
      runtimeHooks: [],
      unavailable: [],
    });
    expect(factory).not.toHaveBeenCalled();
    expect(changedPaths(world.before, treeSnapshot(world.projectRoot))).toEqual([]);
    expect(journal.events).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * `readiness`: a statement about observed evidence, and nothing else
 * ---------------------------------------------------------------------------------------------- */

/** The readiness status each preset must produce. */
const EXPECTED_STATUS: Readonly<Record<keyof PreloadPresets, string>> = {
  notConnected: 'unavailable',
  disconnected: 'unavailable',
  otherProject: 'unavailable',
  stale: 'degraded',
  fresh: 'available',
  // A connection that has not spoken *yet* is not evidence of silence: the
  // preload announces itself on connect, so a missing heartbeat is a
  // service-side bookkeeping gap rather than a fact about the process.
  neverReported: 'available',
};

describe('readiness', () => {
  it('reports one valid row per signal, for every preset', async () => {
    const adapter = createNextJsAdapter();

    for (const [name, readiness] of presetEntries(fixture.root)) {
      const context = contextFor({ project: fixture, readiness });
      const report = await adapter.readiness(context);

      // Parsed against the schema the service aggregates, so a row the
      // session's readiness gate would reject is a defect here.
      expect(readinessSchema.parse(report)).toEqual(report);
      expect(report.adapter).toBe(NEXTJS_ADAPTER_ID);
      expect(report.checkedAt).toBe(NOW);
      expect(report.signals.map((signal) => signal.signal)).toEqual([...NEXTJS_SERVER_SIGNAL_KEYS]);
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);

      for (const signal of report.signals) {
        expect(READINESS_STATUSES as readonly string[]).toContain(signal.status);
        expect(signal.status, `the '${name}' preset must report its documented status`).toBe(
          EXPECTED_STATUS[name],
        );

        if (signal.status === 'available') {
          continue;
        }

        // A row a developer cannot act on is worse than no row: every
        // non-ready signal carries both halves.
        expect(signal.reason).toBeDefined();
        expect(signal.hint).toBeDefined();
        expectSingleLine(signal.reason ?? '', `the reason for ${signal.signal}`);
        expectSingleLine(signal.hint ?? '', `the hint for ${signal.signal}`);
        expect(signal.hint).toContain(fixture.root);
      }

      // `degraded` does not hold a capture back; `unavailable` does.
      expect(report.ready).toBe(EXPECTED_STATUS[name] !== 'unavailable');
    }
  });

  it('is a pure read: no journal, no backup store, no environment, no clock drift', async () => {
    vi.stubEnv('DEBUGGEN_INGEST_URL', 'http://127.0.0.1:65535/stubbed-ingest');

    const adapter = createNextJsAdapter();
    // Both ports throw on every method, so answering at all is the evidence
    // that readiness asked neither of them anything.
    const context = contextFor({
      project: fixture,
      readiness: preloadPresets(fixture.root).stale,
      journal: forbiddenJournal,
    });

    const first = await adapter.readiness(context);
    const second = await adapter.readiness(context);

    // Two identical calls under a fixed clock are deep-equal: nothing is
    // polled, retried or aged between them.
    expect(second).toEqual(first);

    for (const signal of first.signals) {
      expect(signal.hint).not.toContain('stubbed-ingest');
    }
  });

  it('holds no capture back for a project with no server tier', async () => {
    const report = await createNextJsAdapter().readiness(contextFor({ project: serverless }));

    // An adapter with nothing to claim cannot block a capture, and says so
    // with no rows rather than with rows it cannot substantiate.
    expect(report.signals).toEqual([]);
    expect(report.ready).toBe(true);
    expect(readinessSchema.parse(report)).toEqual(report);
  });
});

/* -------------------------------------------------------------------------------------------------
 * `remove`: relinquishes signals, restores nothing
 * ---------------------------------------------------------------------------------------------- */

describe('remove', () => {
  it('restores no file, deletes no backup and flips no record', async () => {
    const world = await sandbox();
    const { context, journal } = writableContext(world, {
      readiness: preloadPresets(world.projectRoot).fresh,
    });
    const installed = await createNextJsAdapter().install(await smallPlan(world.project), context);

    expect(installed.applied.length).toBeGreaterThan(0);

    const patched = treeSnapshot(world.projectRoot);
    const backupsAfterInstall = backupEntries(world);
    const eventsAfterInstall = journal.events.length;

    const result = await createNextJsAdapter().remove(
      {
        sessionId: SESSION_ID,
        planVersion: PLAN_VERSION,
        records: installed.applied,
        reason: 'session-end',
      },
      context,
    );

    // Restoration is `../cleanup.ts`'s: it holds the chain it intends to
    // unwind, walks it in strict reverse and verifies each file against its
    // record's `instrumentedHash` first, so a developer's later edit survives.
    // Writing here would race that walk (AAP §0.5.1).
    expect(result.restored).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.adapterId).toBe(NEXTJS_ADAPTER_ID);
    expect(result.runtimeHooksDisabled).toEqual([...NEXTJS_RUNTIME_HOOKS]);

    expect(treeSnapshot(world.projectRoot)).toEqual(patched);
    expect(backupEntries(world)).toEqual(backupsAfterInstall);
    expect(journal.events).toHaveLength(eventsAfterInstall);

    for (const record of journal.rowsById().values()) {
      expect(record.status, 'no row may be marked reverted by an adapter').not.toBe('reverted');
    }

    for (const record of installed.applied) {
      expect(sha256Hex(readFileSync(inSandbox(world, record.file)))).toBe(record.instrumentedHash);
    }
  });

  it('is idempotent, and safe for a session that installed nothing', async () => {
    const adapter = createNextJsAdapter();
    const context = contextFor({ project: fixture, readiness: preloadPresets(fixture.root).fresh });

    const first = await adapter.remove({ sessionId: SESSION_ID, reason: 'session-end' }, context);
    const second = await adapter.remove({ sessionId: SESSION_ID, reason: 'reconcile' }, context);

    expect(second).toEqual(first);
    expect(first.restored).toEqual([]);
    expect(first.runtimeHooksDisabled).toEqual([...NEXTJS_RUNTIME_HOOKS]);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);

    // A rollback for a plan version that installed nothing reports the same
    // thing rather than looking for records of its own.
    const rollback = await adapter.remove(
      { sessionId: SESSION_ID, planVersion: PLAN_VERSION + 1, records: [], reason: 'rollback' },
      context,
    );

    expect(rollback).toEqual(first);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The import boundary
 *
 * A static read of the adapter's own source. Everything above proves what the
 * adapter *does*; this group proves what it is *able* to do — an adapter that
 * imported the registry that constructs it, the installer that calls it, the
 * cleanup module that restores after it or the framework it adapts could route
 * itself, restore behind cleanup's back, or depend on a package the target
 * project owns.
 * ---------------------------------------------------------------------------------------------- */

/** The only module specifiers `./nextjs.ts` may import. */
const ALLOWED_SPECIFIERS: readonly string[] = [
  '../adapter.js',
  '../patch/patcher.js',
  '../schema/modification.js',
  '../schema/plan.js',
  '../schema/readiness.js',
  '../schema/target.js',
  '@debuggen/code-analysis',
  '@debuggen/shared',
];

/** One thing the adapter may not reach for, with the shape that would show it. */
interface ForbiddenSourcePattern {
  /** What a match would mean. */
  readonly label: string;

  /** The shape to look for in the comment-free source. */
  readonly pattern: RegExp;
}

/** Everything a match of which would break this adapter's boundary. */
const FORBIDDEN_SOURCE_PATTERNS: readonly ForbiddenSourcePattern[] = [
  { label: 'the message layer above it', pattern: /@debuggen\/protocol/u },
  { label: 'the panel packages above it', pattern: /@debuggen\/panel-(?:schema|renderer)/u },
  { label: 'the registry that constructs it', pattern: /\.\.\/registry\.js/u },
  { label: 'the installer that calls it', pattern: /\.\.\/installer\.js/u },
  { label: 'the cleanup module that restores after it', pattern: /\.\.\/cleanup\.js/u },
  { label: 'the feasibility gate that validates its plan', pattern: /\.\.\/feasibility\.js/u },
  { label: 'the framework it adapts', pattern: /(['"])next(?:\/[^'"]*)?\1/u },
  { label: 'the environment', pattern: /\bprocess\s*\.\s*env\b/u },
  { label: 'the console', pattern: /\bconsole\s*\./u },
  // The patch layer is the only writer of a working tree, and this adapter is
  // the one allowed to drive it — but it drives it through that layer, never
  // around it, so a direct builtin import would be a second writer.
  { label: 'a Node builtin', pattern: /(['"])node:[^'"]*\1|\bnode:[a-z]/u },
];

/**
 * The adapter's source with its comments removed.
 *
 * Comments have to go before anything is matched: this module's prose
 * *discusses* the registry, the installer, the cleanup module and the framework
 * by name, which is exactly why it must not import them — and a guard that
 * scanned the prose would report the explanation as the violation.
 *
 * @returns The comment-free source.
 */
function adapterSourceWithoutComments(): string {
  return readFileSync(ADAPTER_SOURCE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

/** Every string literal the comment-free source carries. */
function adapterStringLiterals(): readonly string[] {
  const literals = new Set<string>();

  for (const match of adapterSourceWithoutComments().matchAll(
    /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/gu,
  )) {
    const value = match[2];

    if (value !== undefined) {
      literals.add(value);
    }
  }

  return [...literals];
}

describe('the import boundary', () => {
  it('leaves code behind after the comments are stripped', () => {
    const stripped = adapterSourceWithoutComments();

    // Without this, a stripping accident would make every assertion below
    // pass against an empty string.
    expect(stripped).toContain('export function createNextJsAdapter');
    expect(stripped).toContain(`export const NEXTJS_ADAPTER_ID = '${NEXTJS_ADAPTER_ID}'`);
    expect(stripped).toContain('canHandle');
    expect(stripped).not.toContain('/*');
    // The only `//` the comment-free source may still hold are the two bare
    // scheme prefixes it compares a question's value against before handing it
    // to the route map; anything else would be a comment the stripper missed,
    // and the guards below would be reading prose instead of code. (A closing
    // `*/` legitimately survives inside the generator regex literal, which is
    // why the opener is what this asserts on.)
    expect(stripped.replace(/(['"])https?:\/\/[^'"]*\1/gu, '')).not.toContain('//');
  });

  it('imports exactly the specifiers its layer allows', () => {
    const stripped = adapterSourceWithoutComments();
    const specifiers = new Set<string>();

    for (const pattern of [
      /\bfrom\s*(['"])([^'"]+)\1/gu,
      /\bimport\s*(['"])([^'"]+)\1/gu,
      /\bimport\s*\(\s*(['"])([^'"]+)\1/gu,
      /\brequire\s*\(\s*(['"])([^'"]+)\1/gu,
    ]) {
      for (const match of stripped.matchAll(pattern)) {
        const specifier = match[2];

        if (specifier !== undefined) {
          specifiers.add(specifier);
        }
      }
    }

    expect([...specifiers].sort()).toEqual([...ALLOWED_SPECIFIERS]);
  });

  it('carries a .js extension on every relative import', () => {
    for (const match of adapterSourceWithoutComments().matchAll(/\bfrom\s*(['"])(\.[^'"]*)\1/gu)) {
      const specifier = match[2] ?? '';

      // NodeNext resolution, which is what this package is type-checked and
      // run under: an extensionless relative specifier is a compile error and
      // an unresolvable import at runtime.
      expect(specifier, `relative import '${specifier}' must name a .js file`).toMatch(/\.js$/u);
    }
  });

  it('reaches for nothing outside that boundary', () => {
    const stripped = adapterSourceWithoutComments();

    for (const { label, pattern } of FORBIDDEN_SOURCE_PATTERNS) {
      const match = pattern.exec(stripped);

      expect(
        match === null ? undefined : match[0],
        `./nextjs.ts must not reach for ${label}`,
      ).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * No route, no name and no knowledge of its own (AAP §0.5.4)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a string literal reads as a route, a URL or an absolute path.
 *
 * Three shapes, and two deliberate exemptions the adapter legitimately needs:
 * the single `'/'` and the bare scheme prefixes `'http://'` / `'https://'`,
 * which are how it decides whether a value from the question is worth handing
 * to the route map at all. Anything longer is a route this file would be
 * carrying knowledge of.
 *
 * @param literal The literal to judge.
 * @returns `true` when the literal is route-shaped.
 */
function looksLikeRouteKnowledge(literal: string): boolean {
  if (/\/api(?:\/|$)/u.test(literal)) {
    return true;
  }

  if (literal.startsWith('/') && literal.length > 1) {
    return true;
  }

  return /:\/\/./u.test(literal);
}

/**
 * The distinctive identifiers one corpus contributed.
 *
 * Route paths, method export symbols and server-function names, narrowed to the
 * ones that could only have come from a project: a name with an internal
 * capital, a dotted member access or a path separator. A single lower-case word
 * would be generic vocabulary, and testing for it would report this product's
 * own English as a leak.
 *
 * @param project The indexed project.
 * @returns The distinctive names, in a stable order.
 */
function distinctiveNames(project: IndexedProject): readonly string[] {
  const names = new Set<string>();

  for (const candidate of [
    ...routePathsOf(project),
    ...expectedMethodTargets(project).map((target) => target.file),
    ...serverFunctions(project).map((node) => node.name),
    ...serverFunctions(project).map((node) => node.file),
  ]) {
    if (/[a-z][A-Z]/u.test(candidate) || candidate.includes('/') || candidate.includes('.')) {
      names.add(candidate);
    }
  }

  return [...names].sort();
}

describe('no knowledge of its own', () => {
  it('carries no route path, URL or absolute path as a literal', () => {
    for (const literal of adapterStringLiterals()) {
      // The unit-level companion to `scripts/check-no-hardcoding.mjs`: the
      // repository-wide guard is AST-aware and policy-driven, and this is the
      // same rule asserted where the adapter lives.
      expect(
        looksLikeRouteKnowledge(literal) ? literal : undefined,
        `./nextjs.ts must not carry the route-shaped literal ${JSON.stringify(literal)}`,
      ).toBeUndefined();
    }
  });

  it('names nothing from any corpus in its own source', () => {
    const stripped = adapterSourceWithoutComments();
    const names = [fixture, chain].flatMap((project) => distinctiveNames(project));

    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      expect(stripped, `./nextjs.ts must not carry the project name '${name}'`).not.toContain(name);
    }
  });

  it('states only the names the graph gave it, on a corpus it has never seen', async () => {
    const actions = await wholePlan(chain);
    const permitted = new Set<string>([
      ...expectedMethodTargets(chain).map((target) => target.symbol),
      ...serverFunctions(chain).map((node) => node.name),
    ]);
    const foreign = distinctiveNames(fixture);

    expect(actions.length).toBeGreaterThan(0);
    expect(foreign.length).toBeGreaterThan(0);

    for (const action of actions) {
      expect(permitted.has(action.symbol)).toBe(true);
      expect(action.rationale).toContain(action.symbol);

      for (const name of foreign) {
        expect(
          action.rationale,
          `a rationale for one project must not name another's '${name}'`,
        ).not.toContain(name);
      }
    }
  });

  it('logs through the injected logger, with its id bound, and warns only about degradation', async () => {
    const lines: LogLine[] = [];
    const adapter = createNextJsAdapter({ logger: capturingLogger(lines) });
    const context = contextFor({ project: fixture, readiness: preloadPresets(fixture.root).fresh });

    await adapter.createPlan(context, serverQuestion);
    await adapter.readiness(context);
    await adapter.remove({ sessionId: SESSION_ID, reason: 'session-end' }, context);

    expect(lines.length).toBeGreaterThan(0);
    expect([...new Set(lines.map((line) => line.level))]).toEqual(['debug']);

    for (const line of lines) {
      // Bound as a field rather than formatted into the message, so a log
      // query can filter on it.
      expect(line.fields['adapter']).toBe(NEXTJS_ADAPTER_ID);
      expect(line.message.length).toBeGreaterThan(0);
    }

    const degraded: LogLine[] = [];

    await createNextJsAdapter({ logger: capturingLogger(degraded) }).install(
      await smallPlan(fixture),
      contextFor({ project: fixture, readiness: preloadPresets(fixture.root).notConnected }),
    );

    // A missing preload is a developer-facing degradation, so it is warned
    // about rather than logged at debug — and nothing else is.
    const warnings = degraded.filter((line) => line.level === 'warn');

    expect(warnings.length).toBe(1);
    expect(warnings[0]?.fields['adapter']).toBe(NEXTJS_ADAPTER_ID);
    expect(degraded.every((line) => line.level === 'debug' || line.level === 'warn')).toBe(true);
  });

  it('writes to the session logger when no logger is injected', async () => {
    const lines: LogLine[] = [];

    await createNextJsAdapter().createPlan(
      contextFor({ project: fixture, logger: capturingLogger(lines) }),
      serverQuestion,
    );

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.fields['adapter'] === NEXTJS_ADAPTER_ID)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The committed corpus is left exactly as it was found
 * ---------------------------------------------------------------------------------------------- */

describe('the committed corpus', () => {
  it('is byte-for-byte as it was before the suite ran', () => {
    // Every case above has run by now. This suite is the one most able to
    // dirty the repository — it drives the real patcher — so the claim that
    // every write went to a copy is asserted rather than assumed, and it is
    // what keeps `git status --porcelain packages/instrumentation/test/fixtures`
    // empty after `pnpm test` (AAP §0.5.1, §0.8.4 acceptance test 3).
    expect(treeSnapshot(FIXTURE_ROOT)).toEqual(fixtureSnapshotBefore);
  });
});
