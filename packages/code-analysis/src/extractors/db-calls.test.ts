/**
 * Unit suite for `./db-calls.ts` — the extractor that turns a module's database
 * call sites into `db-call` nodes and the `queries` edge from each call's owner
 * into it.
 *
 * Three consumers read this extractor's output and none of them can tell a
 * misclassification from a fact, which is what makes every invariant below
 * worth a case of its own:
 *
 * - `packages/instrumentation`'s Prisma and Postgres adapter detection decides
 *   from `DbCallNodeData.driver` whether a session must require the dev-server
 *   Node preload. A driver read wrongly installs the wrong runtime adapter.
 * - `../summary.ts`'s `detectDatabaseAccess` folds the same field into
 *   `DatabaseAccessInfo.style`, so a corpus calling both mechanisms must report
 *   `'both'` — a user-visible statement in the problem-understanding stage that
 *   is wrong the moment a borrowed pooled connection is misread or dropped.
 * - `../graph/query.ts`'s `pathBetween` terminates on a `db-call` node reached
 *   through a `queries` edge, so an edge whose origin is a node no extractor
 *   emitted is not a slightly wrong edge: graph assembly drops it and reports
 *   `dangling-edge`, and the data-access tier disappears from the answer.
 *
 * ## The invariants this file pins
 *
 * 1. **Both driver styles, confined to the one module that calls them.** The
 *    corpus yields exactly four call sites — two generated-client delegate
 *    calls and two pooled-driver statements, one of them on a connection
 *    borrowed with `connect()` and handed back with `release()` — and no other
 *    module of the corpus yields one, in particular neither the module that
 *    *constructs* the handles nor the driver stubs that *declare* the methods.
 * 2. **Handle discovery is structural, not name-shaped.** The corpus declares
 *    both handles in a separate module and imports them, so discovery has to
 *    resolve an import to succeed; and a scratch project names its handles
 *    `alpha` and `beta`, which no name list contains, so a name-matching
 *    implementation fails there. The documented generic-name fallback stays
 *    reachable but is always marked (`isHeuristicDbCall`), and the four corpus
 *    sites are never marked.
 * 3. **Statement shape, never statement data.** Literals become `?`, `$n`
 *    placeholders survive, whitespace collapses, the text is capped, and the
 *    values array — the call's second argument — is not read at all. Nothing in
 *    a node, and nothing in a diagnostic, carries source text.
 * 4. **One `queries` edge per call site, from the owner a developer looks
 *    for.** All four corpus edges start at the enclosing exported service
 *    function's `server-function` node, every id is unique, and graph assembly
 *    drops none of them. No `references` edge is emitted.
 * 5. **Tolerant, pure and deterministic.** A module that cannot be read
 *    contributes a diagnostic rather than a throw, a syntactically broken module
 *    still yields the call sites the parse recovered, two runs agree exactly, and
 *    `extract` writes nothing.
 * 6. **A handle an instance holds is found by its declaration.** A property
 *    constructed in its initialiser, a property that is only annotated and a
 *    constructor parameter property all prove a `this.<member>` receiver, in a
 *    class declaration or a class expression; a property of a non-driver class,
 *    a plain constructor parameter and the instance itself prove nothing, and a
 *    handle assigned in a constructor body without a declaration is reachable
 *    only through the marked generic-name fallback.
 * 7. **A dollar-quoted literal is a value.** `$$…$$`, `$tag$…$tag$` (the same
 *    tag closing it, whatever it contains) and an unterminated quote each become
 *    one placeholder, while a `$n` placeholder and a `$` that opens no quote are
 *    kept, and no dollar-quoted body reaches a node.
 * 8. **Every export form and module kind has the owner the graph holds.** A
 *    default-exported arrow, a nameless default function, a function exported
 *    by `export default <name>` or by an aliased clause, a route or page
 *    module's handler, a component module's function and a class member each
 *    start their `queries` edge at a node the assembled graph contains; a
 *    wrapped default export falls back to its module.
 * 9. **One unreadable call site costs only itself**, as a `warning` diagnostic
 *    naming a position and an error class, and a module whose path is not a safe
 *    project-relative path is declined outright.
 *
 * ## How the cases are driven
 *
 * The committed corpus at `../../test/fixtures/sample-next-app` is opened once
 * with the real `openProject` and is **read only**: nothing under
 * `test/fixtures` is written, and a case asserts the directory's file set,
 * sizes and modification times are unchanged afterwards, so a run leaves
 * `git status` clean. The extractor is invoked directly with a per-file
 * `ExtractorContext` built exactly as `../indexer.ts` builds one, and the whole
 * index is built once beside it (`buildIndex` + `CodeGraph.fromIndex`) so that
 * each edge's origin can be resolved to a real node and the assembled graph's
 * freedom from `dangling-edge` can be asserted rather than assumed.
 *
 * Shapes the corpus does not carry — arbitrary handle names, type-annotated
 * handles, a borrow taken without `await`, an unresolvable handle module, the
 * statement-shaping rules, the generated client's raw escape hatches, a broken
 * module — live in **one scratch project** created under `os.mkdtemp` in
 * `beforeAll` and removed in `afterAll`. Its driver stand-ins are hand-written
 * local classes, like the corpus's: nothing is installed, no database is
 * reached, and no network or `$DEBUGGEN_HOME` access happens anywhere in this
 * file.
 *
 * Fixture and scratch identifiers (`gauge`, `basin`, `widget_log`, `alpha`,
 * `beta`) are test data invented for these corpora. The extractor recognises
 * *shapes*, never names, which is exactly what the scratch cases prove.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  isOk,
  isSafeRelativePath,
  noopLogger,
  parseSourceLocation,
} from '@debuggen/shared';
import type { LogFields, LogLevel, Logger } from '@debuggen/shared';
import { Project } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CodeGraph } from '../graph/graph.js';
import { DB_DRIVERS } from '../graph/types.js';
import type {
  CodeEdge,
  CodeNode,
  CodeNodeOf,
  DbCallNodeData,
  DbDriver,
  ExtractorContext,
  ExtractorResult,
  IndexDiagnostic,
} from '../graph/types.js';
import { buildIndex } from '../indexer.js';
import { openProject } from '../project.js';
import type { LoadedProject } from '../project.js';
import { DB_CALLS_EXTRACTOR_ID, dbCallsExtractor, isHeuristicDbCall } from './db-calls.js';

/* -------------------------------------------------------------------------------------------------
 * Constants restated from the unit under test
 * ---------------------------------------------------------------------------------------------- */

/** The read-only indexing corpus, opened where it lives and never written. */
const FIXTURE_ROOT = fileURLToPath(new URL('../../test/fixtures/sample-next-app', import.meta.url));

/** The one corpus module that holds database call sites. */
const SERVICE_MODULE = 'src/lib/station-service.ts';

/** The corpus module that constructs the two handles and calls nothing. */
const DATASTORE_MODULE = 'src/lib/datastore.ts';

/**
 * The hard cap on `DbCallNodeData.statementShape`, in characters.
 *
 * Restated rather than imported, because the constant
 * (`MAX_STATEMENT_SHAPE_LENGTH`) is internal to `./db-calls.ts` while the cap
 * itself is a *documented contract* of the payload field — the text reaches
 * prompt context and a user interface (AAP 0.5.2), so a silent widening has to
 * fail here instead of passing unnoticed.
 */
const STATEMENT_SHAPE_CAP = 512;

/** The neutral placeholder every inline literal and substitution collapses to. */
const VALUE_PLACEHOLDER = '?';

/** The absolute POSIX root of the one in-memory project this file builds. */
const MEMORY_ROOT = '/project';

/* -------------------------------------------------------------------------------------------------
 * Position helpers — expected positions are derived from the source, never written down
 * ---------------------------------------------------------------------------------------------- */

/** A 1-based source position, on the convention `CodeNodeBase.line` fixes. */
interface Position {
  /** The 1-based line. */
  readonly line: number;

  /** The 1-based column. */
  readonly column: number;
}

/**
 * The text with every comment replaced by spaces of the same length.
 *
 * Needed because the corpus module's own header comment *names* the call sites
 * it contains (`prisma.gauge.findMany`, `client.query(...)`, `pool.connect()`),
 * so a plain search for one finds the prose before the code. Blanking rather
 * than removing keeps every offset — and therefore every line and column —
 * identical to the real file, which is what lets a position be derived from the
 * source instead of written down as a line number that a corpus edit would
 * silently invalidate.
 *
 * String and template literals are copied verbatim, so the statements stay
 * searchable; substitutions inside a template are not parsed, which the corpora
 * this helper is applied to do not require.
 *
 * @param text The source text.
 * @returns The same text with comment bytes blanked, newlines preserved.
 */
function blankComments(text: string): string {
  const out: string[] = [];
  let index = 0;

  /** Copies `text[index]` and advances, so the loop body stays one statement. */
  const copy = (): void => {
    out.push(text.charAt(index));
    index += 1;
  };

  /** Blanks one byte, keeping a line break so line numbering is unaffected. */
  const blank = (): void => {
    const char = text.charAt(index);

    out.push(char === '\n' || char === '\r' ? char : ' ');
    index += 1;
  };

  while (index < text.length) {
    const char = text.charAt(index);

    if (char === '/' && text.startsWith('//', index)) {
      while (index < text.length && text.charAt(index) !== '\n') {
        blank();
      }

      continue;
    }

    if (char === '/' && text.startsWith('/*', index)) {
      const close = text.indexOf('*/', index + 2);
      const end = close === -1 ? text.length : close + 2;

      while (index < end) {
        blank();
      }

      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;

      copy();

      while (index < text.length) {
        const inner = text.charAt(index);

        if (inner === '\\') {
          copy();
          copy();

          continue;
        }

        copy();

        if (inner === quote) {
          break;
        }
      }

      continue;
    }

    copy();
  }

  return out.join('');
}

/**
 * The 1-based line and column of a character offset.
 *
 * @param text The source text the offset indexes.
 * @param offset The 0-based character offset.
 * @returns The position.
 */
function lineColumnAt(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');

  return { line: before.split('\n').length, column: offset - lastBreak };
}

/**
 * The position of the single **code** occurrence of `needle`.
 *
 * Asserts the uniqueness rather than assuming it, so a corpus edit that
 * introduced a second call of the same shape fails here — where the reason is
 * stated — instead of making a position assertion silently ambiguous.
 *
 * @param text The source text, comments included.
 * @param needle The exact source spelling to locate.
 * @returns The 1-based position of the occurrence's first character.
 */
function soleCodeOccurrence(text: string, needle: string): Position {
  const code = blankComments(text);
  const offsets: number[] = [];

  for (let at = code.indexOf(needle); at !== -1; at = code.indexOf(needle, at + 1)) {
    offsets.push(at);
  }

  expect(offsets.map((offset) => lineColumnAt(code, offset))).toHaveLength(1);

  const [only] = offsets;

  if (only === undefined) {
    throw new Error(`the corpus no longer contains exactly one code occurrence of ${needle}`);
  }

  return lineColumnAt(code, only);
}

/* -------------------------------------------------------------------------------------------------
 * Extraction helpers — the context is built exactly as ../indexer.ts builds it
 * ---------------------------------------------------------------------------------------------- */

/** One log record a {@link recordingLogger} captured. */
interface RecordedLog {
  /** The severity the record was emitted at. */
  readonly level: LogLevel;

  /** The message text. */
  readonly message: string;

  /** The structured fields, or `undefined` when the call passed none. */
  readonly fields: LogFields | undefined;
}

/**
 * A logger that records instead of printing, plus the list it records into.
 *
 * Used only where a case asserts about a log line — the cascade's last resort
 * reports its choice at `debug` rather than as a diagnostic — and so that the
 * privacy rule can be checked on log fields as well as on diagnostics.
 *
 * @returns The logger and the records it appends to.
 */
function recordingLogger(): { readonly logger: Logger; readonly records: RecordedLog[] } {
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

/**
 * The {@link ExtractorContext} for one file of an opened project.
 *
 * Assembled field for field as `../indexer.ts` assembles it — the loaded
 * project, the file's `SourceFile`, its project-relative path, the project root
 * and the scoped logger — so a case exercises the extractor through exactly the
 * contract the indexer passes it and not through a convenience shape.
 *
 * @param project The opened project.
 * @param file The project-relative POSIX path of the module to visit.
 * @param logger The logger to hand the extractor; defaults to `noopLogger`,
 * which is the indexer's own default.
 * @returns The context.
 */
function contextFor(
  project: LoadedProject,
  file: string,
  logger: Logger = noopLogger,
): ExtractorContext {
  const sourceFile = project
    .sourceFiles()
    .find((candidate) => project.projectRelative(candidate.getFilePath()) === file);

  if (sourceFile === undefined) {
    throw new Error(`the opened project holds no file at ${file}`);
  }

  return { loaded: project, sourceFile, file, projectRoot: project.projectRoot, logger };
}

/**
 * One module's whole extraction result.
 *
 * @param project The opened project.
 * @param file The project-relative POSIX path.
 * @param logger An optional recording logger.
 * @returns The nodes, edges and diagnostics.
 */
function resultOf(project: LoadedProject, file: string, logger?: Logger): ExtractorResult {
  return dbCallsExtractor.extract(contextFor(project, file, logger));
}

/**
 * One module's `db-call` nodes, narrowed to that kind.
 *
 * `ExtractorResult.nodes` is typed as the whole `CodeNode` union, so the kind is
 * narrowed here once rather than at every assertion — every node this extractor
 * emits is a `db-call`, and the filter is what tells the compiler so.
 *
 * @param project The opened project.
 * @param file The project-relative POSIX path.
 * @returns The nodes, in the order the extractor emitted them.
 */
function dbCallsOf(project: LoadedProject, file: string): readonly CodeNodeOf<'db-call'>[] {
  return resultOf(project, file).nodes.filter(
    (node): node is CodeNodeOf<'db-call'> => node.kind === 'db-call',
  );
}

/** Every project-relative file of an opened project, in the project's own order. */
function filesOf(project: LoadedProject): readonly string[] {
  return project
    .sourceFiles()
    .map((sourceFile) => project.projectRelative(sourceFile.getFilePath()))
    .filter((file): file is string => file !== undefined);
}

/**
 * The sole node of a given name, or a readable failure naming what was found.
 *
 * @param nodes The extracted nodes.
 * @param name The call's source spelling, as the node records it.
 * @returns The single matching node.
 */
function nodeNamed(nodes: readonly CodeNodeOf<'db-call'>[], name: string): CodeNodeOf<'db-call'> {
  const matched = nodes.filter((node) => node.name === name);

  expect(
    matched.map((node) => `${node.name}@${String(node.line)}:${String(node.column)}`),
  ).toHaveLength(1);

  const [first] = matched;

  if (first === undefined) {
    throw new Error(`no db-call node named ${name} was extracted`);
  }

  return first;
}

/**
 * The item at an index, or a failure naming the shortfall.
 *
 * `noUncheckedIndexedAccess` is in force for this package, so an indexed read is
 * `T | undefined`; this keeps the narrowing in one place instead of scattering
 * assertions about it.
 *
 * @param items The list to read.
 * @param index The 0-based index.
 * @param what What the caller expected to be there.
 * @returns The item.
 */
function itemAt<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error(
      `expected ${what} at index ${String(index)}, but only ${String(items.length)} item(s) were produced`,
    );
  }

  return item;
}

/* -------------------------------------------------------------------------------------------------
 * Read-only guarantees — a directory's shape, so a run can prove it wrote nothing
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every file under a directory with its size and modification time, sorted.
 *
 * The evidence for two promises: the committed corpus is read only, and
 * `extract` writes nothing. Sizes and modification times are what a write would
 * change, and they are the same two fields `FileFingerprint` invalidates a
 * cached index on.
 *
 * @param root The absolute directory to walk.
 * @returns One `path|size|mtime` line per file, in ascending path order.
 */
function directorySnapshot(root: string): readonly string[] {
  const lines: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolute);

        continue;
      }

      const stats = statSync(absolute);

      lines.push(
        `${absolute.slice(root.length + 1)}|${String(stats.size)}|${String(stats.mtimeMs)}`,
      );
    }
  };

  walk(root);

  return lines.sort((left, right) => (left < right ? -1 : 1));
}

/* -------------------------------------------------------------------------------------------------
 * The scratch project — every shape the committed corpus deliberately does not carry
 * ---------------------------------------------------------------------------------------------- */

/** The column prefix the over-long statement repeats, so the cap can be asserted. */
const LONG_STATEMENT_COLUMNS = 120;

/**
 * A statement far longer than {@link STATEMENT_SHAPE_CAP}, built rather than
 * written so the case cannot drift below the cap.
 */
const LONG_STATEMENT = `SELECT ${Array.from(
  { length: LONG_STATEMENT_COLUMNS },
  (_unused, index) => `column_${String(index)}`,
).join(', ')} FROM widget_log WHERE kind = $1`;

/**
 * A column name shaped like a credential's, assembled from fragments.
 *
 * The next three constants exist so a case can prove a credential-shaped
 * literal is reduced to a placeholder rather than stored. The shape therefore
 * has to be produced *somewhere*, and `scripts/check-secrets.mjs` scans every
 * tracked file for exactly it — so the pieces are joined at run time, the value
 * is an obvious dummy, and the only place the assembled statement ever exists is
 * a module inside an `os.mkdtemp` directory this suite deletes.
 */
const LOOKALIKE_COLUMN = ['api', 'key'].join('_');

/** An obviously fake value in the shape a credential literal would take. */
const LOOKALIKE_VALUE = ['dummy', 'not', 'a', 'real', 'value', '0000'].join('-');

/** The statement whose literal must never reach a node. */
const LOOKALIKE_STATEMENT = `SELECT id FROM account WHERE ${LOOKALIKE_COLUMN} = '${LOOKALIKE_VALUE}'`;

/** The two literals a values array carries, which must appear nowhere in a node. */
const VALUES_SENTINELS = ['sentinel-values-first', 'sentinel-values-second'] as const;

/** A key of a generated-client argument object, which must appear nowhere in a node. */
const ARGUMENT_SENTINEL = 'sentinelSelector';

/**
 * The bodies of the dollar-quoted literals in `src/dollar-quoted.ts`, one per
 * form. A dollar-quoted body is a value, so none of these may appear anywhere
 * in a node — which is a substring search over the serialised nodes rather than
 * an inference from the shape.
 */
const DOLLAR_SENTINELS = {
  empty: 'dollar-sentinel-empty-tag',
  tagged: 'dollar-sentinel-named-tag',
  digits: 'dollar-sentinel-digit-tag',
  nested: 'dollar-sentinel-nested-tag',
  mismatched: 'dollar-sentinel-mismatched-tag',
  unterminated: 'dollar-sentinel-unterminated-tag',
  bare: 'dollar-sentinel-bare-literal',
} as const;

/**
 * The bodies of the escaped and unterminated single-quoted literals in
 * `src/literal-escapes.ts`: a tokeniser that ended one of them early would emit
 * the rest as statement text, so none may appear anywhere in a node.
 */
const ESCAPE_SENTINELS = {
  doubled: 'escape-sentinel-doubled-quote',
  backslash: 'escape-sentinel-backslash-quote',
  unclosed: 'escape-sentinel-unclosed-quote',
} as const;

/**
 * The scratch project's modules, keyed by project-relative POSIX path.
 *
 * Written as line arrays rather than template literals so that a line holding a
 * template literal, a `$n` placeholder or a `${…}` substitution needs no
 * escaping and reads as the source it becomes. Every driver stand-in is a local
 * hand-written class, so the project parses with nothing installed — the same
 * property the committed corpus has, and the reason this extractor's
 * abstract-syntax-tree-first contract matters.
 */
const SCRATCH_MODULES: Readonly<Record<string, string>> = {
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        // The component-module cases are `.tsx`; markup is parsed, never built.
        jsx: 'preserve',
      },
      include: ['**/*.ts', '**/*.tsx'],
      exclude: ['node_modules'],
    },
    null,
    2,
  ),

  // The driver stand-ins: the two classes and the borrowed-connection type the
  // extractor's construction and annotation steps read, and nothing else.
  'src/drivers.ts': [
    'export interface QueryOutcome {',
    '  rows: unknown[];',
    '}',
    '',
    'export interface PoolClient {',
    '  query(text: unknown, values?: unknown[]): Promise<QueryOutcome>;',
    '  release(): void;',
    '}',
    '',
    'export class Pool {',
    '  query(text: unknown, values?: unknown[]): Promise<QueryOutcome> {',
    '    void text;',
    '    void values;',
    '    return Promise.resolve({ rows: [] });',
    '  }',
    '',
    '  connect(): Promise<PoolClient> {',
    '    return Promise.resolve({',
    '      query: (text: unknown) => {',
    '        void text;',
    '        return Promise.resolve({ rows: [] });',
    '      },',
    '      release: () => {},',
    '    });',
    '  }',
    '',
    '  end(): Promise<void> {',
    '    return Promise.resolve();',
    '  }',
    '}',
    '',
    'export class PrismaClient {',
    '  readonly widget = {',
    '    findMany: (args?: unknown) => {',
    '      void args;',
    '      return Promise.resolve([]);',
    '    },',
    '  };',
    '',
    '  readonly gadget = {',
    '    create: (args?: unknown) => {',
    '      void args;',
    '      return Promise.resolve({});',
    '    },',
    '  };',
    '',
    '  $queryRaw(statement: unknown, ...values: unknown[]): Promise<unknown[]> {',
    '    void statement;',
    '    void values;',
    '    return Promise.resolve([]);',
    '  }',
    '',
    '  $queryRawUnsafe(statement: string, ...values: unknown[]): Promise<unknown[]> {',
    '    void statement;',
    '    void values;',
    '    return Promise.resolve([]);',
    '  }',
    '',
    '  $executeRaw(statement: unknown, ...values: unknown[]): Promise<number> {',
    '    void statement;',
    '    void values;',
    '    return Promise.resolve(0);',
    '  }',
    '',
    '  $executeRawUnsafe(statement: string, ...values: unknown[]): Promise<number> {',
    '    void statement;',
    '    void values;',
    '    return Promise.resolve(0);',
    '  }',
    '',
    '  $transaction(work: unknown): Promise<unknown> {',
    '    void work;',
    '    return Promise.resolve(undefined);',
    '  }',
    '',
    '  $connect(): Promise<void> {',
    '    return Promise.resolve();',
    '  }',
    '}',
    '',
  ].join('\n'),

  // The handle module, whose identifiers are deliberately outside every name
  // list: a name-matching implementation cannot see these as driver handles.
  'src/handles.ts': [
    "import { Pool, PrismaClient } from './drivers';",
    '',
    'export const alpha = new PrismaClient();',
    '',
    'export const beta = new Pool();',
    '',
  ].join('\n'),

  // Both driver styles reached only through the resolved import above.
  'src/cross-module.ts': [
    "import { alpha, beta } from './handles';",
    '',
    'export async function readWidgets(): Promise<unknown[]> {',
    `  return (await alpha.widget.findMany({ where: { ${ARGUMENT_SENTINEL}: true }, take: 7 })) as unknown[];`,
    '}',
    '',
    'export async function appendEntry(kind: string): Promise<void> {',
    '  const borrowed = await beta.connect();',
    '  try {',
    "    await borrowed.query('INSERT INTO widget_log (kind, note) VALUES ($1, $2)', [",
    `      '${VALUES_SENTINELS[0]}',`,
    `      '${VALUES_SENTINELS[1]}',`,
    '    ]);',
    '  } finally {',
    '    borrowed.release();',
    '  }',
    '  void kind;',
    '}',
    '',
    'export async function purgeEntries(kind: string): Promise<void> {',
    "  await beta.query('DELETE FROM widget_log WHERE kind = $1', [kind]);",
    '}',
    '',
  ].join('\n'),

  // Handles that arrive as annotated parameters and are constructed nowhere.
  'src/annotated.ts': [
    "import type { Pool, PoolClient, PrismaClient } from './drivers';",
    '',
    'export async function viaGeneratedClient(handle: PrismaClient): Promise<unknown[]> {',
    '  return (await handle.widget.findMany({})) as unknown[];',
    '}',
    '',
    'export async function viaPool(handle: Pool): Promise<void> {',
    "  await handle.query('UPDATE widget_log SET note = $1', ['note']);",
    '}',
    '',
    'export async function viaBorrowedClient(handle: PoolClient): Promise<void> {',
    "  await handle.query('WITH recent AS (SELECT 1) SELECT * FROM recent');",
    '}',
    '',
  ].join('\n'),

  // A borrow taken without `await`, so the callback parameter carries no
  // annotation and no structural step can reach the pool.
  'src/not-awaited.ts': [
    "import { beta } from './handles';",
    '',
    'export function borrowThenQuery(): Promise<unknown> {',
    "  return beta.connect().then((client) => client.query('SELECT note FROM widget_log'));",
    '}',
    '',
  ].join('\n'),

  // A handle whose module cannot be resolved, which is the one state the
  // documented generic-name fallback exists for.
  'src/unresolved-handle.ts': [
    "import { db } from 'debuggen-fixture-absent-driver';",
    '',
    'export async function throughGenericName(kind: string): Promise<void> {',
    '  await db.widget.findMany({});',
    "  await db.query('SELECT note FROM widget_log WHERE kind = $1', [kind]);",
    "  await db.things.insertOne({ note: 'not a delegate operation' });",
    '}',
    '',
  ].join('\n'),

  // Every statement-shaping rule, one call per rule, in source order: the
  // assertions below index this list, so a call added here belongs at the end.
  'src/shapes.ts': [
    "import { beta } from './handles';",
    '',
    'export async function shaped(kind: string): Promise<void> {',
    '  await beta.query(',
    '    `SELECT   note,',
    '        kind',
    '     FROM widget_log',
    "     WHERE kind = $1 AND size > 10 AND label = 'literal text' -- trailing note",
    '       /* a block',
    '          note */ AND flag = TRUE`,',
    '    [kind],',
    '  );',
    `  await beta.query('${LONG_STATEMENT}', [kind]);`,
    `  await beta.query("${LOOKALIKE_STATEMENT}");`,
    '  const assembled = buildStatement();',
    '  await beta.query(assembled, [kind]);',
    '  await beta.query(`SELECT * FROM widget_log WHERE kind = ${kind}`);',
    "  await beta.query({ text: 'SELECT 1 FROM widget_log WHERE kind = $1', values: [kind] });",
    '  await beta.query(\'SELECT "Quoted Ident" FROM widget_log\');',
    "  await beta.query('VACUUM widget_log');",
    '  await beta.query();',
    '}',
    '',
    'function buildStatement(): string {',
    "  return 'SELECT note FROM widget_log';",
    '}',
    '',
  ].join('\n'),

  // The generated client's raw escape hatches and its transaction entry point,
  // plus one lifecycle member that is not a call site.
  'src/raw.ts': [
    "import { alpha } from './handles';",
    '',
    'export async function raws(kind: string): Promise<void> {',
    '  await alpha.$queryRaw`SELECT note FROM widget_log WHERE kind = ${kind}`;',
    "  await alpha.$queryRawUnsafe('SELECT note FROM widget_log WHERE kind = $1', kind);",
    '  await alpha.$executeRaw`UPDATE widget_log SET note = ${kind}`;',
    "  await alpha.$executeRawUnsafe('DELETE FROM widget_log WHERE kind = $1', kind);",
    '  await alpha.$transaction([alpha.gadget.create({ data: { kind } })]);',
    '  await alpha.$connect();',
    '}',
    '',
  ].join('\n'),

  // Deliberately unparseable after the first declaration.
  'src/broken.ts': [
    "import { beta } from './handles';",
    '',
    'export async function readable(): Promise<void> {',
    "  await beta.query('SELECT note FROM widget_log');",
    '}',
    '',
    'export function unreadable(: {',
    '',
  ].join('\n'),

  // A call written outside every declaration, which is the cascade's last
  // resort, with a locally constructed handle so no import is involved.
  'src/module-scope.ts': [
    "import { Pool } from './drivers';",
    '',
    'const gamma = new Pool();',
    '',
    "void gamma.query('SELECT note FROM widget_log');",
    '',
  ].join('\n'),

  // Handles held by an instance: a property constructed in its initialiser, a
  // property only annotated, a parameter property of each driver, and three
  // `this` receivers that hold no handle — a property of a non-driver class, a
  // plain constructor parameter, and the instance itself. The calls sit in a
  // property arrow, the constructor and a method, so each member kind owns one.
  'src/class-handles.ts': [
    "import { Pool, PrismaClient } from './drivers';",
    "import type { PoolClient } from './drivers';",
    '',
    'class QueryHelper {',
    '  query(text: string): Promise<void> {',
    '    void text;',
    '    return Promise.resolve();',
    '  }',
    '}',
    '',
    'export class WidgetRepository {',
    '  private readonly pool = new Pool();',
    '',
    '  readonly archive: PrismaClient;',
    '',
    '  private readonly helper = new QueryHelper();',
    '',
    '  readonly refresh = async (): Promise<void> => {',
    "    await this.pool.query('SELECT note FROM widget_log');",
    '  };',
    '',
    '  constructor(',
    '    private readonly store: PrismaClient,',
    '    protected lease: PoolClient,',
    '    plain: Pool,',
    '  ) {',
    '    this.archive = new PrismaClient();',
    '    void this.store.widget.findFirst({});',
    '    void plain;',
    '  }',
    '',
    '  async list(kind: string): Promise<void> {',
    "    await this.pool.query('SELECT id, note FROM widget_log WHERE kind = $1', [kind]);",
    '    await this.archive.gadget.create({});',
    "    await this.lease.query('DELETE FROM widget_log WHERE kind = $1', [kind]);",
    "    await this.helper.query('SELECT kind FROM widget_log');",
    "    await this.plain.query('SELECT size FROM widget_log');",
    "    await this.query('SELECT label FROM widget_log');",
    '  }',
    '',
    '  query(text: string): Promise<void> {',
    '    void text;',
    '    return Promise.resolve();',
    '  }',
    '}',
    '',
  ].join('\n'),

  // A class expression holding a constructed handle, and a class that assigns
  // its handles in the constructor body without declaring them — which binds
  // nothing structural, so only a generic name can still be matched.
  'src/class-expression.ts': [
    "import { Pool } from './drivers';",
    '',
    'export const makeRecorder = () =>',
    '  new (class {',
    '    private readonly pool = new Pool();',
    '',
    '    record(note: string): Promise<unknown> {',
    "      return this.pool.query('INSERT INTO widget_log (note) VALUES ($1)', [note]);",
    '    }',
    '  })();',
    '',
    'export class LooseRepository {',
    '  constructor() {',
    '    this.db = new Pool();',
    '    this.archive = new Pool();',
    '  }',
    '',
    '  run(): Promise<unknown> {',
    "    void this.archive.query('SELECT note FROM widget_log');",
    "    return this.db.query('UPDATE widget_log SET note = $1', ['x']);",
    '  }',
    '}',
    '',
  ].join('\n'),

  // Every dollar-quoting form, one call per form, in source order: the
  // assertions below index this list, so a call added here belongs at the end.
  'src/dollar-quoted.ts': [
    "import { beta } from './handles';",
    '',
    'export async function dollarQuoted(kind: string): Promise<void> {',
    `  await beta.query('SELECT $$${DOLLAR_SENTINELS.empty}$$ AS body FROM widget_log WHERE kind = $1', [kind]);`,
    `  await beta.query("UPDATE widget_log SET note = $body$ it's ${DOLLAR_SENTINELS.tagged} -- not a comment /* nor this */ $body$ WHERE kind = $2", [kind]);`,
    `  await beta.query('SELECT $q_1$ ${DOLLAR_SENTINELS.digits} $q_1$ AS body, $1 AS kind FROM widget_log');`,
    `  await beta.query('SELECT $outer$ holds $$ ${DOLLAR_SENTINELS.nested} $$ inside $outer$ AS body FROM widget_log');`,
    `  await beta.query('SELECT $a$ ${DOLLAR_SENTINELS.mismatched} $b$ still inside $a$ AS body FROM widget_log');`,
    `  await beta.query('SELECT $open$ ${DOLLAR_SENTINELS.unterminated} FROM widget_log');`,
    "  await beta.query('SELECT note FROM widget_log WHERE kind = $1 AND size > $12');",
    "  await beta.query('SELECT note FROM widget_log WHERE note = $ AND label = $tag');",
    `  await beta.query('$$${DOLLAR_SENTINELS.bare}$$');`,
    '}',
    '',
  ].join('\n'),

  // `export default <arrow>`: the export statement is the only declaration.
  'src/default-arrow.ts': [
    "import { beta } from './handles';",
    '',
    'export default async (kind: string): Promise<void> => {',
    "  await beta.query('DELETE FROM widget_log WHERE kind = $1', [kind]);",
    '};',
    '',
  ].join('\n'),

  // `export default function () {}`: a declaration with no name of its own.
  'src/default-function.ts': [
    "import { alpha } from './handles';",
    '',
    'export default async function (): Promise<unknown[]> {',
    '  return (await alpha.widget.findMany({})) as unknown[];',
    '}',
    '',
  ].join('\n'),

  // A function that leaves the module only through `export default <name>`,
  // one that leaves only through an aliased export clause, one that does not
  // leave at all, and a re-export clause naming another module's binding.
  'src/default-named.ts': [
    "import { beta } from './handles';",
    '',
    'async function purge(kind: string): Promise<void> {',
    "  await beta.query('DELETE FROM widget_log WHERE kind = $1', [kind]);",
    '}',
    '',
    "const load = async (): Promise<unknown> => beta.query('SELECT note FROM widget_log');",
    '',
    'function helper(): Promise<unknown> {',
    "  return beta.query('SELECT kind FROM widget_log');",
    '}',
    '',
    'void helper;',
    '',
    'export { load as read };',
    "export { alpha } from './handles';",
    'export default purge;',
    '',
  ].join('\n'),

  // A default export wrapped in an assertion, which the two extractors whose
  // node ids this one spells anchor differently — so it owns nothing.
  'src/default-wrapped.ts': [
    "import { beta } from './handles';",
    '',
    'export default ((async (): Promise<void> => {',
    "  await beta.query('SELECT note FROM widget_log');",
    '}) as () => Promise<void>);',
    '',
  ].join('\n'),

  // Handles that leave their modules only as the default export: one
  // constructed in the export statement, one re-bound from an import.
  'src/default-handle.ts': [
    "import { Pool } from './drivers';",
    '',
    'export default new Pool();',
    '',
  ].join('\n'),

  'src/default-alias.ts': [
    "import { beta } from './handles';",
    '',
    'export default beta;',
    '',
  ].join('\n'),

  'src/default-handle-use.ts': [
    "import keeper from './default-alias';",
    "import store from './default-handle';",
    '',
    'export async function viaDefaultExports(): Promise<void> {',
    "  await store.query('SELECT note FROM widget_log');",
    "  await keeper.query('SELECT kind FROM widget_log');",
    '}',
    '',
  ].join('\n'),

  // An App Router route module, a module beside it that is not one, and a
  // Pages Router module: only the first and last are framework entry points.
  'src/app/widgets/route.ts': [
    "import { beta } from '../../handles';",
    '',
    'export async function GET(): Promise<unknown> {',
    "  return beta.query('SELECT note FROM widget_log');",
    '}',
    '',
  ].join('\n'),

  'src/app/widgets/format.ts': [
    "import { beta } from '../../handles';",
    '',
    'export async function formatWidgets(): Promise<unknown> {',
    "  return beta.query('SELECT kind FROM widget_log');",
    '}',
    '',
  ].join('\n'),

  'src/pages/api/widgets.ts': [
    "import { beta } from '../../handles';",
    '',
    'export default async function handler(): Promise<unknown> {',
    "  return beta.query('SELECT label FROM widget_log');",
    '}',
    '',
  ].join('\n'),

  // Markup with a component-shaped function name, markup whose names are all
  // lower-case, and markup beside a component-shaped variable.
  'src/components/WidgetPanel.tsx': [
    "import { beta } from '../handles';",
    '',
    'export function WidgetPanel(): unknown {',
    "  void beta.query('SELECT note FROM widget_log');",
    '  return <section />;',
    '}',
    '',
  ].join('\n'),

  'src/components/render-rows.tsx': [
    "import { beta } from '../handles';",
    '',
    'export function renderRows(): unknown {',
    "  void beta.query('SELECT kind FROM widget_log');",
    '  return <ul />;',
    '}',
    '',
  ].join('\n'),

  'src/components/panel-exports.tsx': [
    "import { beta } from '../handles';",
    '',
    'const Summary = (): unknown => <p />;',
    '',
    'export const summarize = async (): Promise<unknown> => {',
    '  void Summary;',
    "  return beta.query('SELECT label FROM widget_log');",
    '};',
    '',
  ].join('\n'),

  // Members a class names without an identifier: a computed name, which no
  // lookup can match, and string-literal names, which read as their value.
  'src/class-computed.ts': [
    "import { Pool } from './drivers';",
    '',
    'export class ComputedMembers {',
    "  private readonly 'archive' = new Pool();",
    '',
    "  ['refresh' + 'All'](): Promise<unknown> {",
    "    return this.archive.query('SELECT note FROM widget_log');",
    '  }',
    '',
    "  'quoted-name'(): Promise<unknown> {",
    "    return this.archive.query('SELECT kind FROM widget_log');",
    '  }',
    '}',
    '',
  ].join('\n'),

  // The single-quote and number rules the tokeniser applies, one call per rule,
  // in source order: the assertions below index this list.
  'src/literal-escapes.ts': [
    "import { beta } from './handles';",
    '',
    'export async function escapes(kind: string): Promise<void> {',
    `  await beta.query("SELECT note FROM widget_log WHERE note = 'it''s ${ESCAPE_SENTINELS.doubled}' AND kind = $1");`,
    `  await beta.query("SELECT note FROM widget_log WHERE note = 'a\\\\'${ESCAPE_SENTINELS.backslash}' AND kind = $1");`,
    "  await beta.query('SELECT note FROM widget_log WHERE size > 1.5 AND ratio < 2e10 AND delta = 3E-4 AND step = 7.25e+2');",
    '  await beta.query(\'SELECT "Odd ""Quoted"" Name" FROM widget_log\');',
    `  await beta.query("SELECT note FROM widget_log WHERE note = 'never closed ${ESCAPE_SENTINELS.unclosed}");`,
    "  await beta.query('-- only a comment');",
    "  await beta.query('SELECT note FROM widget_log WHERE col1 = t2.c3');",
    "  await beta.query('SELECT note FROM ' + 'widget_log WHERE kind = $1');",
    "  await beta.query('SELECT note FROM widget_log WHERE kind = ' + kind);",
    '}',
    '',
  ].join('\n'),

  // Barrels: a renamed re-export clause and a star re-export of the handle
  // module, each one resolution hop away from the construction.
  'src/handles-barrel.ts': ["export { beta as ledger } from './handles';", ''].join('\n'),

  'src/handles-star.ts': ["export * from './handles';", ''].join('\n'),

  // Receivers reached through a namespace import and through barrels, a local
  // that shadows the namespace, and the receiver shapes discovery refuses: an
  // element access, a call at the root, and delegate chains that are not the
  // generated client's shape.
  'src/receivers.ts': [
    "import * as handles from './handles';",
    "import { ledger } from './handles-barrel';",
    "import { beta as starred } from './handles-star';",
    "import { alpha, beta } from './handles';",
    '',
    'function currentPool(): typeof beta {',
    '  return beta;',
    '}',
    '',
    'export async function receivers(): Promise<void> {',
    "  await handles.beta.query('SELECT note FROM widget_log');",
    '  await handles.alpha.widget.findMany({});',
    "  await ledger.query('SELECT kind FROM widget_log');",
    "  await starred.query('SELECT size FROM widget_log');",
    "  await beta['query']('SELECT label FROM widget_log');",
    "  await currentPool().query('SELECT note, kind FROM widget_log');",
    '  await alpha.widget.nested.findMany({});',
    '  await alpha.$extends.widget();',
    '  await alpha.widget.$call();',
    '}',
    '',
    'export async function shadowed(): Promise<void> {',
    '  const handles = { beta: { query: (text: string) => text } };',
    "  await handles.beta.query('SELECT note, size FROM widget_log');",
    '}',
    '',
  ].join('\n'),

  // Alias chains: one inside the documented resolution-hop bound and one far
  // past it. Neither name is generic, so only resolution can produce a node.
  'src/alias-chain.ts': [
    "import { beta } from './handles';",
    '',
    'const near1 = beta;',
    'const near2 = near1;',
    '',
    'const far1 = beta;',
    'const far2 = far1;',
    'const far3 = far2;',
    'const far4 = far3;',
    'const far5 = far4;',
    'const far6 = far5;',
    'const far7 = far6;',
    'const far8 = far7;',
    '',
    'export async function viaAliases(): Promise<void> {',
    "  await near2.query('SELECT note FROM widget_log');",
    "  await far8.query('SELECT kind FROM widget_log');",
    '}',
    '',
  ].join('\n'),
};

/** Where every scratch module is rooted inside the project. */
const SCRATCH_SOURCE_DIRECTORY = 'src';

/**
 * Writes {@link SCRATCH_MODULES} into a fresh `os.mkdtemp` directory and opens
 * it with the real `openProject`.
 *
 * A temporary directory rather than an in-memory filesystem, because discovery
 * step 2 resolves a module *specifier* through the target project's own
 * configuration: the scratch project therefore needs a real `tsconfig.json` on
 * disk for `./handles` to resolve the way the developer's tooling resolves it,
 * which is the whole point of the cross-module cases.
 *
 * @returns The absolute root and the opened project.
 */
function createScratchProject(): { readonly root: string; readonly project: LoadedProject } {
  const root = mkdtempSync(join(tmpdir(), 'debuggen-db-calls-'));

  for (const [file, text] of Object.entries(SCRATCH_MODULES)) {
    const absolute = join(root, file);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
  }

  const opened = openProject({ projectRoot: root });

  if (!isOk(opened)) {
    throw new Error(`the scratch project did not open: ${opened.error.message}`);
  }

  return { root, project: opened.value };
}

/**
 * An {@link ExtractorContext} over a single in-memory module.
 *
 * The one case that needs it is the module-level diagnostic: the only way to
 * make reading a module fail deterministically is to detach its syntax tree,
 * and doing that to a file of a shared opened project would corrupt every other
 * case. `openProject` is not used because nothing here is resolved across
 * modules.
 *
 * @param file The project-relative POSIX path.
 * @param code The source text.
 * @returns The context.
 */
function inMemoryContext(file: string, code: string): ExtractorContext {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(`${MEMORY_ROOT}/${file}`, code);
  const loaded: LoadedProject = {
    project,
    projectRoot: MEMORY_ROOT,
    tsConfigFilePath: undefined,
    sourceFiles: () => project.getSourceFiles(),
    projectRelative: (absolutePath: string) =>
      absolutePath.startsWith(`${MEMORY_ROOT}/`)
        ? absolutePath.slice(MEMORY_ROOT.length + 1)
        : undefined,
  };

  return { loaded, sourceFile, file, projectRoot: MEMORY_ROOT, logger: noopLogger };
}

/* -------------------------------------------------------------------------------------------------
 * Shared state — the corpus is opened once, the scratch project written once
 * ---------------------------------------------------------------------------------------------- */

/** Everything the corpus cases read. */
interface Corpus {
  /** The opened corpus. */
  readonly project: LoadedProject;

  /** The service module's source text, comments included. */
  readonly serviceText: string;

  /** The service module's whole extraction result. */
  readonly result: ExtractorResult;

  /** The service module's `db-call` nodes, in emission order. */
  readonly nodes: readonly CodeNodeOf<'db-call'>[];

  /** Every module's node count, so "no other module yields one" is one assertion. */
  readonly countsByFile: Readonly<Record<string, number>>;

  /** The assembled graph over the whole index, for edge-origin resolution. */
  readonly graph: CodeGraph;
}

/** The corpus, once `beforeAll` has opened it. */
let corpus: Corpus | undefined;

/** The scratch project, once `beforeAll` has written it. */
let scratch: { readonly root: string; readonly project: LoadedProject } | undefined;

/** The corpus directory's shape before anything in this file ran. */
let corpusSnapshot: readonly string[] | undefined;

/** The scratch directory's shape before any extraction ran over it. */
let scratchSnapshot: readonly string[] | undefined;

// A 30 s ceiling, not a budget: this hook parses a program, which a loaded
// machine can push past the 10 s hook default and so fail every case below.
beforeAll(async () => {
  // Taken first, so the comparison at the end of this file covers every read
  // this suite performs, the index build included.
  corpusSnapshot = directorySnapshot(FIXTURE_ROOT);

  const opened = openProject({ projectRoot: FIXTURE_ROOT });

  if (!isOk(opened)) {
    throw new Error(`the corpus did not open: ${opened.error.message}`);
  }

  const project = opened.value;
  const countsByFile: Record<string, number> = {};

  for (const file of filesOf(project)) {
    const found = dbCallsOf(project, file).length;

    if (found > 0) {
      countsByFile[file] = found;
    }
  }

  // The whole index, built beside the direct invocation: an edge's origin is a
  // node another extractor emits, so only the assembled graph can say whether
  // the cascade named a node that exists.
  const built = await buildIndex(project, { logger: noopLogger });

  if (!isOk(built)) {
    throw new Error(`indexing the corpus failed: ${built.error.message}`);
  }

  const result = resultOf(project, SERVICE_MODULE);

  corpus = {
    project,
    serviceText: readFileSync(join(FIXTURE_ROOT, SERVICE_MODULE), 'utf8'),
    result,
    nodes: result.nodes.filter((node): node is CodeNodeOf<'db-call'> => node.kind === 'db-call'),
    countsByFile,
    graph: CodeGraph.fromIndex(built.value, { logger: noopLogger }),
  };

  scratch = createScratchProject();
  scratchSnapshot = directorySnapshot(scratch.root);
}, 30_000);

afterAll(() => {
  if (scratch !== undefined) {
    rmSync(scratch.root, { recursive: true, force: true });
    scratch = undefined;
  }
});

/**
 * The opened corpus, or a failure naming the missing `beforeAll`.
 *
 * @returns The corpus.
 */
function openedCorpus(): Corpus {
  if (corpus === undefined) {
    throw new Error('the corpus was not opened: beforeAll did not run');
  }

  return corpus;
}

/**
 * The scratch project, or a failure naming the missing `beforeAll`.
 *
 * @returns The scratch root and project.
 */
function openedScratch(): { readonly root: string; readonly project: LoadedProject } {
  if (scratch === undefined) {
    throw new Error('the scratch project was not created: beforeAll did not run');
  }

  return scratch;
}

/**
 * One scratch module's `db-call` nodes.
 *
 * @param stem The module's file stem under `src/`.
 * @returns The nodes, in emission order.
 */
function scratchNodes(stem: string): readonly CodeNodeOf<'db-call'>[] {
  return dbCallsOf(openedScratch().project, `${SCRATCH_SOURCE_DIRECTORY}/${stem}.ts`);
}

/**
 * One scratch module's whole result.
 *
 * @param stem The module's file stem under `src/`.
 * @param logger An optional recording logger.
 * @returns The nodes, edges and diagnostics.
 */
function scratchResult(stem: string, logger?: Logger): ExtractorResult {
  return resultOf(openedScratch().project, `${SCRATCH_SOURCE_DIRECTORY}/${stem}.ts`, logger);
}

/**
 * Every `db-call` node of the whole scratch project.
 *
 * For the invariants that hold of *any* node rather than of one case's node —
 * the statement-shape rules among them — so a module added to the scratch set
 * is covered by them without a second edit.
 *
 * @returns The nodes, module by module in the project's own file order.
 */
function allScratchNodes(): readonly CodeNodeOf<'db-call'>[] {
  const { project } = openedScratch();

  return filesOf(project).flatMap((file) => dbCallsOf(project, file));
}

/* -------------------------------------------------------------------------------------------------
 * 1. Both driver styles, confined to the one module that calls them
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: the corpus inventory', () => {
  it('yields a db-call node in the service module and in no other corpus module', () => {
    const { countsByFile } = openedCorpus();

    // Exhaustive rather than a spot check: the handle module's two
    // constructions are not call sites, and the driver stubs' own `query`,
    // `connect` and `release` *declarations* are not either. Both would be
    // plausible false positives for an implementation that matched on member
    // names, and both are in this corpus.
    expect(countsByFile).toStrictEqual({ [SERVICE_MODULE]: 4 });
  });

  it('contributes nothing at all for the module that constructs the handles', () => {
    const { project } = openedCorpus();
    const result = resultOf(project, DATASTORE_MODULE);

    expect(result.nodes).toStrictEqual([]);
    expect(result.edges).toStrictEqual([]);
    // Absent rather than empty, which is what `ExtractorResult` requires of a
    // clean extraction.
    expect(result.diagnostics).toBeUndefined();
  });

  it('records four call sites in source order, two per driver', () => {
    const { nodes } = openedCorpus();

    expect(
      nodes.map((node) => ({ name: node.name, file: node.file, driver: node.data.driver })),
    ).toStrictEqual([
      { name: 'prisma.gauge.findMany', file: SERVICE_MODULE, driver: 'prisma' },
      { name: 'prisma.reading.create', file: SERVICE_MODULE, driver: 'prisma' },
      { name: 'client.query', file: SERVICE_MODULE, driver: 'pg' },
      { name: 'pool.query', file: SERVICE_MODULE, driver: 'pg' },
    ]);
  });

  it('records the generated client delegate calls with model and operation as written', () => {
    const { nodes } = openedCorpus();

    // `toStrictEqual` on the whole payload, not a field at a time: it is also
    // what proves nothing else was recorded — no statement shape for a call
    // that has no statement, and no heuristic marker on a structural match.
    expect(nodeNamed(nodes, 'prisma.gauge.findMany').data).toStrictEqual({
      driver: 'prisma',
      model: 'gauge',
      operation: 'findMany',
      dynamic: false,
    });

    expect(nodeNamed(nodes, 'prisma.reading.create').data).toStrictEqual({
      driver: 'prisma',
      model: 'reading',
      operation: 'create',
      dynamic: false,
    });
  });

  it('records both pooled shapes as the same driver, with the statement as written', () => {
    const { nodes, serviceText } = openedCorpus();
    const borrowed = nodeNamed(nodes, 'client.query');
    const direct = nodeNamed(nodes, 'pool.query');

    // The borrowed connection and the pool itself: one driver, because they are
    // the same access from the graph's point of view, and misreading the
    // borrowed form would drop exactly the statements a developer hand-wrote
    // for transactional work.
    const pooled: DbDriver = 'pg';

    for (const node of [borrowed, direct]) {
      expect(node.data.driver).toBe(pooled);
      expect(node.data.model).toBeUndefined();
      expect(node.data.dynamic).toBe(false);
      expect(Object.keys(node.data).sort((left, right) => (left < right ? -1 : 1))).toStrictEqual([
        'driver',
        'dynamic',
        'operation',
        'statementShape',
      ]);

      // Both corpus statements are single-line, fully parameterised literals,
      // so the recorded shape must be the literal itself — asserted against the
      // source rather than against a copy of the statement, which is what keeps
      // the case honest if the corpus is ever re-worded.
      expect(serviceText).toContain(`'${String(node.data.statementShape)}'`);
    }

    expect(borrowed.data.operation).toBe('update');
    expect(direct.data.operation).toBe('select');
    expect(borrowed.data.statementShape).toContain('$1');
    expect(direct.data.statementShape).toContain('$2');
  });

  it('reports only drivers DB_DRIVERS declares, and both of them', () => {
    const { nodes } = openedCorpus();

    for (const node of nodes) {
      expect(DB_DRIVERS).toContain(node.data.driver);
    }

    // Both present is the condition that makes `../summary.ts` report
    // `databaseAccess.style === 'both'` for this corpus.
    expect([...new Set(nodes.map((node) => node.data.driver))].sort()).toStrictEqual(
      [...DB_DRIVERS].sort(),
    );
  });

  it('treats borrowing and releasing a connection as members that are not call sites', () => {
    const { nodes, serviceText } = openedCorpus();

    // Non-vacuous: the corpus really does write both, once each in code.
    expect(soleCodeOccurrence(serviceText, 'pool.connect()').line).toBeGreaterThan(0);
    expect(soleCodeOccurrence(serviceText, 'client.release()').line).toBeGreaterThan(0);

    expect(nodes.map((node) => node.name)).not.toContain('pool.connect');
    expect(nodes.map((node) => node.name)).not.toContain('client.release');
  });

  it('positions every node at its callee, 1-based, derived from the source', () => {
    const { nodes, serviceText } = openedCorpus();

    for (const node of nodes) {
      const expected = soleCodeOccurrence(serviceText, node.name);

      expect({ name: node.name, line: node.line, column: node.column }).toStrictEqual({
        name: node.name,
        ...expected,
      });

      // `endLine` covers the whole call expression, so a multi-line statement
      // reveals as a unit in an editor.
      expect(node.endLine ?? node.line).toBeGreaterThanOrEqual(node.line);
    }
  });

  it('carries a position a code-graph source location can be built from', () => {
    const { nodes } = openedCorpus();

    for (const node of nodes) {
      expect(isSafeRelativePath(node.file)).toBe(true);
      expect(node.file).toBe(SERVICE_MODULE);

      // No location is minted here — the node vocabulary carries none, and
      // `../graph/query.ts` is the one place that stamps a route and its
      // confidence. What this extractor owes that consumer is a position a
      // location can be built from, which is exactly what is asserted.
      const location = parseSourceLocation({
        file: node.file,
        line: node.line,
        column: node.column,
        symbol: node.symbol,
        endLine: node.endLine,
        resolvedBy: 'code-graph',
        confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
      });

      if (!isOk(location)) {
        throw new Error(`${node.name} does not yield a valid source location`);
      }

      expect(location.value.resolvedBy).toBe('code-graph');
      expect(location.value.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
      expect(location.value.file).toBe(node.file);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * 2. Handle discovery is structural, not name-shaped
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: handle discovery across modules', () => {
  it('resolves both corpus handles through the import that brings them in', () => {
    const { nodes, serviceText, project } = openedCorpus();

    // The premise, asserted rather than assumed: the calling module constructs
    // neither handle, so discovery cannot succeed here without resolving the
    // import — which is what makes cross-file structural discovery mandatory
    // rather than a nicety.
    expect(serviceText).not.toContain('new PrismaClient');
    expect(serviceText).not.toContain('new Pool');
    expect(serviceText).toContain("from './datastore'");

    // And the constructions really are in the other module, so the corpus is
    // exercising the import route and not an absence of handles.
    const datastoreText = readFileSync(join(FIXTURE_ROOT, DATASTORE_MODULE), 'utf8');

    expect(datastoreText).toContain('new PrismaClient()');
    expect(datastoreText).toContain('new Pool(');
    expect(filesOf(project)).toContain(DATASTORE_MODULE);

    expect(nodes).toHaveLength(4);
  });

  it('marks none of the four corpus sites as a name match', () => {
    const { nodes } = openedCorpus();

    // The corpus handles are spelled with words the documented fallback would
    // also accept (`prisma`, `pool`, `client`), so this is the assertion that
    // separates "discovered structurally" from "guessed and happened to be
    // right": the marker is present *only* on the fallback path.
    for (const node of nodes) {
      expect(isHeuristicDbCall(node.data)).toBe(false);
      expect(Object.keys(node.data)).not.toContain('heuristicHandle');
    }
  });

  it('detects handles whose names no list contains', () => {
    // `alpha` and `beta` are not driver vocabulary, they are declared in
    // another module, and nothing in the calling module constructs them: an
    // implementation that matched on names fails here, which is the point of
    // the case.
    expect(
      scratchNodes('cross-module').map((node) => ({
        name: node.name,
        driver: node.data.driver,
        heuristic: isHeuristicDbCall(node.data),
      })),
    ).toStrictEqual([
      { name: 'alpha.widget.findMany', driver: 'prisma', heuristic: false },
      { name: 'borrowed.query', driver: 'pg', heuristic: false },
      { name: 'beta.query', driver: 'pg', heuristic: false },
    ]);
  });

  it('distinguishes a borrowed connection from the pool while keeping one driver', () => {
    const nodes = scratchNodes('cross-module');
    const borrowed = nodeNamed(nodes, 'borrowed.query');
    const direct = nodeNamed(nodes, 'beta.query');

    expect(borrowed.data.driver).toBe(direct.data.driver);
    expect(borrowed.data.operation).toBe('insert');
    expect(direct.data.operation).toBe('delete');

    // `connect` and `release` are members of the pooled surface that are never
    // call sites, so the borrow sequence contributes exactly one node.
    expect(nodes.map((node) => node.name)).not.toContain('beta.connect');
    expect(nodes.map((node) => node.name)).not.toContain('borrowed.release');
  });

  it('accepts a handle that arrives as an annotated parameter', () => {
    // Construction is unavailable by construction here: the module imports the
    // driver types only, so the annotation is the sole evidence — read as
    // abstract-syntax-tree text, with no type resolved.
    expect(
      scratchNodes('annotated').map((node) => ({
        name: node.name,
        driver: node.data.driver,
        operation: node.data.operation,
        heuristic: isHeuristicDbCall(node.data),
      })),
    ).toStrictEqual([
      { name: 'handle.widget.findMany', driver: 'prisma', operation: 'findMany', heuristic: false },
      { name: 'handle.query', driver: 'pg', operation: 'update', heuristic: false },
      { name: 'handle.query', driver: 'pg', operation: 'with', heuristic: false },
    ]);
  });

  it('falls back to the marked name heuristic for a borrow taken without await', () => {
    const nodes = scratchNodes('not-awaited');

    // Documented behaviour, asserted as documented: the callback parameter
    // carries no annotation, so no structural step reaches the pool. The call
    // is still recorded — a query is a query — but as the weaker statement the
    // marker exists to express, and nothing throws.
    expect(nodes).toHaveLength(1);

    const node = itemAt(nodes, 0, 'the query on the non-awaited borrow');

    expect(node.name).toBe('client.query');
    expect(node.data.driver).toBe('pg');
    expect(isHeuristicDbCall(node.data)).toBe(true);
    expect(node.data.statementShape).toBe('SELECT note FROM widget_log');
  });

  it('marks every call whose handle module cannot be resolved as heuristic', () => {
    const nodes = scratchNodes('unresolved-handle');

    expect(
      nodes.map((node) => ({
        name: node.name,
        driver: node.data.driver,
        heuristic: isHeuristicDbCall(node.data),
      })),
    ).toStrictEqual([
      { name: 'db.widget.findMany', driver: 'prisma', heuristic: true },
      { name: 'db.query', driver: 'pg', heuristic: true },
    ]);

    // The third call in that module is the narrowing that keeps the fallback
    // honest: a generically named handle plus an operation that is not spelled
    // with one of the driver's own verbs is not a database call, so an
    // unrelated document store's member never becomes one.
    expect(nodes.map((node) => node.name)).not.toContain('db.things.insertOne');
  });

  it('narrows the heuristic to payloads that still declare a driver', () => {
    const nodes = [...scratchNodes('unresolved-handle'), ...scratchNodes('not-awaited')];

    for (const node of nodes) {
      // The marker is additive and the payload is still a `DbCallNodeData`:
      // every consumer reading the declared fields is unaffected, and the
      // marker is plain JSON so a serialised index round-trips unchanged.
      expect(DB_DRIVERS).toContain(node.data.driver);
      expect(JSON.parse(JSON.stringify(node.data)) as unknown).toStrictEqual(node.data);
      expect(isHeuristicDbCall(node.data)).toBe(true);
    }
  });

  it('reads a missing, false or malformed marker as not heuristic', () => {
    /**
     * A payload carrying an arbitrary value where the marker would be.
     *
     * The double assertion is deliberate: the shapes below are exactly the ones
     * the declared type forbids, and they are what a serialised index or an
     * older version of this package could hand the predicate.
     *
     * @param marker The value to put at `heuristicHandle`.
     * @returns The payload.
     */
    const withMarker = (marker: unknown): DbCallNodeData =>
      ({ driver: 'pg', dynamic: false, heuristicHandle: marker }) as unknown as DbCallNodeData;

    expect(isHeuristicDbCall({ driver: 'pg', dynamic: false })).toBe(false);

    for (const marker of [false, 'yes', 0, 1, null, undefined, {}]) {
      expect(isHeuristicDbCall(withMarker(marker))).toBe(false);
    }

    expect(isHeuristicDbCall(withMarker(true))).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 3. Statement shape, never statement data
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: what a statement contributes', () => {
  /**
   * The shaped module's nodes, with the call order the source declares.
   *
   * @returns The nodes, in emission order.
   */
  function shapedNodes(): readonly CodeNodeOf<'db-call'>[] {
    const nodes = scratchNodes('shapes');

    // Nine calls, nine nodes: the indices below name them, so a drift in the
    // module fails here rather than shifting every expectation by one.
    expect(nodes).toHaveLength(9);

    return nodes;
  }

  it('records a shape: comments dropped, whitespace collapsed, literals neutralised', () => {
    const node = itemAt(shapedNodes(), 0, 'the multi-line statement');

    expect(node.data.statementShape).toBe(
      'SELECT note, kind FROM widget_log WHERE kind = $1 AND size > ? AND label = ? AND flag = TRUE',
    );

    // Each half of the rule, named: the placeholder survives because it *is*
    // the shape and is what proves the statement is parameterised, while the
    // inline literal and the standalone number are values and go.
    expect(node.data.statementShape).toContain('$1');
    expect(node.data.statementShape).not.toContain('literal text');
    expect(node.data.statementShape).not.toContain('10');
    expect(node.data.statementShape).not.toContain('--');
    expect(node.data.statementShape).not.toContain('/*');
    expect(node.data.statementShape).not.toMatch(/\s{2}/);
    expect(node.data.statementShape).not.toMatch(/\n/);
    expect(node.data.dynamic).toBe(false);
  });

  it('caps the shape at the documented length, silently', () => {
    const node = itemAt(shapedNodes(), 1, 'the over-long statement');

    expect(LONG_STATEMENT.length).toBeGreaterThan(STATEMENT_SHAPE_CAP);
    expect(node.data.statementShape).toHaveLength(STATEMENT_SHAPE_CAP);
    expect(LONG_STATEMENT.startsWith(String(node.data.statementShape))).toBe(true);
  });

  it('reduces a credential-shaped literal to a placeholder instead of storing it', () => {
    const node = itemAt(shapedNodes(), 2, 'the credential-shaped statement');

    // The rule the redaction layer applies to a runtime statement, applied here
    // because this text reaches prompt context and a user interface: a secret
    // pasted into a query string in a developer's project must not be the thing
    // that leaves the machine.
    expect(node.data.statementShape).toBe(
      `SELECT id FROM account WHERE ${LOOKALIKE_COLUMN} = ${VALUE_PLACEHOLDER}`,
    );
    expect(JSON.stringify(node)).not.toContain(LOOKALIKE_VALUE);
  });

  it('records no shape for a statement built from a variable, and says so', () => {
    const node = itemAt(shapedNodes(), 3, 'the statement held in a variable');

    // `dynamic` without a shape is the honest answer — the source does not
    // state the statement — and the node is still worth having, because a
    // dynamically built query is a call site like any other.
    expect(node.data).toStrictEqual({ driver: 'pg', dynamic: true });
    expect(node.data.statementShape).toBeUndefined();
    expect(node.data.operation).toBeUndefined();
  });

  it('replaces every template substitution with a placeholder', () => {
    const node = itemAt(shapedNodes(), 4, 'the interpolated statement');

    expect(node.data.statementShape).toBe(
      `SELECT * FROM widget_log WHERE kind = ${VALUE_PLACEHOLDER}`,
    );
    expect(node.data.dynamic).toBe(true);
  });

  it('reads the configuration form’s text property and never its values property', () => {
    const node = itemAt(shapedNodes(), 5, 'the configuration-object statement');

    expect(node.data.statementShape).toBe(
      `SELECT ${VALUE_PLACEHOLDER} FROM widget_log WHERE kind = $1`,
    );
    expect(JSON.stringify(node)).not.toContain('values');
  });

  it('keeps a delimited identifier, which names a column rather than a value', () => {
    const node = itemAt(shapedNodes(), 6, 'the delimited-identifier statement');

    expect(node.data.statementShape).toBe('SELECT "Quoted Ident" FROM widget_log');
  });

  it('leaves the operation unset when the leading keyword is not one it reports', () => {
    const node = itemAt(shapedNodes(), 7, 'the maintenance statement');

    expect(node.data.statementShape).toBe('VACUUM widget_log');
    expect(node.data.operation).toBeUndefined();
  });

  it('records a statement-less call on a proven handle without inventing a shape', () => {
    const node = itemAt(shapedNodes(), 8, 'the argument-less call');

    expect(node.data).toStrictEqual({ driver: 'pg', dynamic: true });
  });

  it('holds every recorded shape to the same rules, across both corpora', () => {
    const shapes = [...openedCorpus().nodes, ...allScratchNodes()]
      .map((node) => node.data.statementShape)
      .filter((shape): shape is string => shape !== undefined);

    // Non-vacuous: the corpora really do carry a statement per pooled call and
    // per raw form.
    expect(shapes.length).toBeGreaterThan(10);

    for (const shape of shapes) {
      expect(shape.length).toBeLessThanOrEqual(STATEMENT_SHAPE_CAP);
      expect(shape.length).toBeGreaterThan(0);
      // Collapsed and trimmed: one space per whitespace run, and no line
      // structure, which is what makes two call sites comparable.
      expect(shape).not.toMatch(/\s\s|\n|\r|\t/);
      expect(shape.trim()).toBe(shape);
      // No comment survives, and no single-quoted literal does either — the
      // only quoting a shape may contain is a delimited identifier's.
      expect(shape).not.toContain('--');
      expect(shape).not.toContain('/*');
      expect(shape).not.toContain("'");
    }
  });

  it('never records the values array, anywhere in the node', () => {
    const nodes = [...scratchNodes('cross-module'), ...openedCorpus().nodes];

    // The second argument is not read at all, which is the only way to
    // guarantee this: row data, request values and anything a developer passed
    // as a parameter are absent by construction rather than by filtering.
    for (const node of nodes) {
      const serialised = JSON.stringify(node);

      for (const sentinel of VALUES_SENTINELS) {
        expect(serialised).not.toContain(sentinel);
      }
    }
  });

  it('never records a generated-client argument object’s contents', () => {
    const scratchCall = nodeNamed(scratchNodes('cross-module'), 'alpha.widget.findMany');
    const corpusCall = nodeNamed(openedCorpus().nodes, 'prisma.gauge.findMany');

    // Model and operation are the only things a delegate call contributes:
    // nothing in the payload describes the filter, the page window or the
    // projection, because nothing in the payload may describe data.
    expect(JSON.stringify(scratchCall)).not.toContain(ARGUMENT_SENTINEL);
    expect(JSON.stringify(scratchCall)).not.toContain('take');
    expect(JSON.stringify(corpusCall)).not.toContain('basinId');
    expect(scratchCall.data).toStrictEqual({
      driver: 'prisma',
      model: 'widget',
      operation: 'findMany',
      dynamic: false,
    });
  });

  it('keeps source text and statement text out of every diagnostic', () => {
    // The module-level failure is the one diagnostic this extractor can be made
    // to emit deterministically, and it is the one that would carry source text
    // if the rule were not enforced: an abstract-syntax-tree library routinely
    // embeds the offending text in an error message.
    const context = inMemoryContext(
      'src/detached.ts',
      [
        'import { Pool } from "./drivers";',
        'const handle = new Pool();',
        `void handle.query('SELECT secret_column FROM ${LOOKALIKE_COLUMN}_store');`,
      ].join('\n'),
    );

    context.sourceFile.forget();

    const result = dbCallsExtractor.extract(context);
    const diagnostics: readonly IndexDiagnostic[] = result.diagnostics ?? [];

    expect(result.nodes).toStrictEqual([]);
    expect(result.edges).toStrictEqual([]);
    expect(diagnostics).toHaveLength(1);

    const diagnostic = itemAt(diagnostics, 0, 'the module-level diagnostic');

    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.code).toBe('extractor-failed');
    expect(diagnostic.file).toBe('src/detached.ts');
    expect(diagnostic.extractorId).toBe(DB_CALLS_EXTRACTOR_ID);

    for (const text of [diagnostic.message, diagnostic.detail ?? '']) {
      expect(text).not.toContain('SELECT');
      expect(text).not.toContain('secret_column');
      expect(text).not.toContain('new Pool');
      expect(text).not.toContain(LOOKALIKE_COLUMN);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * 4. One queries edge per call site, from the owner a developer looks for
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: the queries edges', () => {
  /**
   * The corpus edges, paired with the node each points at.
   *
   * @returns One entry per edge, in emission order.
   */
  function corpusEdges(): readonly {
    readonly edge: CodeEdge;
    readonly target: CodeNodeOf<'db-call'>;
  }[] {
    const { result, nodes } = openedCorpus();

    return result.edges.map((edge) => {
      const target = nodes.find((node) => node.id === edge.to);

      if (target === undefined) {
        throw new Error(`the edge ${edge.id} points at no node this extractor emitted`);
      }

      return { edge, target };
    });
  }

  it('emits one queries edge per db-call node and nothing else', () => {
    const { result, nodes } = openedCorpus();

    expect(result.edges).toHaveLength(nodes.length);
    expect([...new Set(result.edges.map((edge) => edge.kind))]).toStrictEqual(['queries']);

    // Reference resolution is deliberately lazy and belongs to
    // `../indexer.ts`'s resolver: emitting references at index time would force
    // full type resolution over the whole program.
    expect(result.edges.map((edge) => edge.kind)).not.toContain('references');
    expect(result.edges.map((edge) => edge.kind)).not.toContain('calls');
    expect(result.edges.map((edge) => edge.kind)).not.toContain('routes-to');
  });

  it('starts each edge at the enclosing exported service function', () => {
    const { graph } = openedCorpus();

    expect(
      corpusEdges().map(({ edge, target }) => {
        const origin: CodeNode | undefined = graph.nodeById(edge.from);

        if (origin === undefined) {
          throw new Error(`the edge from ${edge.from} has no node in the assembled graph`);
        }

        return { call: target.name, ownerKind: origin.kind, owner: origin.name };
      }),
    ).toStrictEqual([
      {
        call: 'prisma.gauge.findMany',
        ownerKind: 'server-function',
        owner: 'listBasinGauges',
      },
      {
        call: 'prisma.reading.create',
        ownerKind: 'server-function',
        owner: 'recordGaugeReading',
      },
      // The borrowed-connection statement belongs to the same function as the
      // delegate write above it: the cascade takes the innermost addressable
      // owner, so a call inside a `try` block still belongs to its function.
      { call: 'client.query', ownerKind: 'server-function', owner: 'recordGaugeReading' },
      { call: 'pool.query', ownerKind: 'server-function', owner: 'summarizeBasin' },
    ]);
  });

  it('records the edge site at the call, and the owner name on the node', () => {
    for (const { edge, target } of corpusEdges()) {
      // The site is where the relationship is written, which is the position a
      // developer wants when they ask why a function and a query are connected.
      expect({ file: edge.file, line: edge.line, column: edge.column }).toStrictEqual({
        file: target.file,
        line: target.line,
        column: target.column,
      });

      const origin = openedCorpus().graph.nodeById(edge.from);

      expect(target.symbol).toBe(origin?.name);
    }
  });

  it('gives every node and every edge a distinct identity', () => {
    const { result } = openedCorpus();
    const nodeIds = result.nodes.map((node) => node.id);
    const edgeIds = result.edges.map((edge) => edge.id);

    expect([...new Set(nodeIds)]).toHaveLength(nodeIds.length);
    expect([...new Set(edgeIds)]).toHaveLength(edgeIds.length);
  });

  it('loses no edge to graph assembly, and reports no dangling edge', () => {
    const { graph, nodes } = openedCorpus();
    const assembled = graph.edges().filter((edge) => edge.kind === 'queries');

    expect(assembled.map((edge) => edge.id).sort((left, right) => (left < right ? -1 : 1))).toEqual(
      openedCorpus()
        .result.edges.map((edge) => edge.id)
        .sort((left, right) => (left < right ? -1 : 1)),
    );

    // A dropped endpoint is the failure mode the cascade exists to avoid, and
    // it is reported rather than thrown, so the diagnostics of the assembled
    // graph are the only place it would show.
    expect(graph.diagnostics.filter((finding) => finding.code === 'dangling-edge')).toStrictEqual(
      [],
    );
    expect(graph.diagnostics).toStrictEqual([]);

    // Every db-call node is reachable through exactly one queries edge, which
    // is what `pathBetween`'s terminal hop walks.
    for (const node of nodes) {
      expect(graph.incoming(node.id, 'queries')).toHaveLength(1);
      expect(graph.outgoing(node.id)).toStrictEqual([]);
    }
  });

  it('falls back to the module when no enclosing declaration can own the call', () => {
    const { records, logger } = recordingLogger();
    const result = scratchResult('module-scope', logger);
    const nodes = result.nodes.filter(
      (node): node is CodeNodeOf<'db-call'> => node.kind === 'db-call',
    );

    expect(nodes).toHaveLength(1);

    const node = itemAt(nodes, 0, 'the module-scope call');
    const edge = itemAt(result.edges, 0, 'the module-scope edge');

    // The file node's id is spelled by the convention `CodeNodeBase.name`
    // documents — the name *is* the project-relative path, at line 1, column 1
    // — so the last-resort edge still has a real endpoint. The node carries no
    // `symbol`, because there is no function to name.
    expect(edge.from).toContain('file:');
    expect(edge.to).toBe(node.id);
    expect(node.symbol).toBeUndefined();
    expect(Object.keys(node)).not.toContain('symbol');

    // Reported at `debug` rather than as a diagnostic: the attribution is
    // correct, simply the least specific one available. The fields name a file,
    // a position and a vocabulary word, never source text.
    expect(result.diagnostics).toBeUndefined();
    expect(records.map((record) => record.level)).toStrictEqual(['debug']);
    expect(itemAt(records, 0, 'the debug record').fields).toStrictEqual({
      extractorId: DB_CALLS_EXTRACTOR_ID,
      file: `${SCRATCH_SOURCE_DIRECTORY}/module-scope.ts`,
      line: node.line,
      column: node.column,
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * 5. The generated client's escape hatches, and the pooled operation vocabulary
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: raw statements and operation vocabulary', () => {
  it('records every raw escape hatch and the transaction entry point', () => {
    const nodes = scratchNodes('raw');

    expect(
      nodes.map((node) => ({
        name: node.name,
        driver: node.data.driver,
        model: node.data.model,
        operation: node.data.operation,
        dynamic: node.data.dynamic,
      })),
    ).toStrictEqual([
      // A tagged template is the raw *statement* forms' shape, and every
      // substitution is a value, so the call is dynamic.
      {
        name: 'alpha.$queryRaw',
        driver: 'prisma',
        model: undefined,
        operation: '$queryRaw',
        dynamic: true,
      },
      {
        name: 'alpha.$queryRawUnsafe',
        driver: 'prisma',
        model: undefined,
        operation: '$queryRawUnsafe',
        dynamic: false,
      },
      {
        name: 'alpha.$executeRaw',
        driver: 'prisma',
        model: undefined,
        operation: '$executeRaw',
        dynamic: true,
      },
      {
        name: 'alpha.$executeRawUnsafe',
        driver: 'prisma',
        model: undefined,
        operation: '$executeRawUnsafe',
        dynamic: false,
      },
      // The transaction entry point bears no statement — its argument is an
      // array of promises or a callback — so no shape is read from it.
      {
        name: 'alpha.$transaction',
        driver: 'prisma',
        model: undefined,
        operation: '$transaction',
        dynamic: false,
      },
      // The delegate call written inside that argument array is a call site of
      // its own, reached by the same walk.
      {
        name: 'alpha.gadget.create',
        driver: 'prisma',
        model: 'gadget',
        operation: 'create',
        dynamic: false,
      },
    ]);

    // Lifecycle members are not access: the `$` prefix alone cannot decide the
    // question, which is why the module carries a closed list.
    expect(nodes.map((node) => node.name)).not.toContain('alpha.$connect');
  });

  it('reduces a tagged template’s substitutions to placeholders', () => {
    const node = nodeNamed(scratchNodes('raw'), 'alpha.$queryRaw');

    expect(node.data.statementShape).toBe(
      `SELECT note FROM widget_log WHERE kind = ${VALUE_PLACEHOLDER}`,
    );
    expect(node.data.dynamic).toBe(true);
  });

  it('records a shape for the raw statement forms and none for the transaction form', () => {
    const nodes = scratchNodes('raw');

    for (const name of [
      'alpha.$queryRaw',
      'alpha.$queryRawUnsafe',
      'alpha.$executeRaw',
      'alpha.$executeRawUnsafe',
    ]) {
      expect(nodeNamed(nodes, name).data.statementShape).toBeTypeOf('string');
    }

    expect(nodeNamed(nodes, 'alpha.$transaction').data.statementShape).toBeUndefined();
  });

  it('derives the pooled operation from the statement’s leading keyword', () => {
    // One case per keyword the module reports, gathered from the scratch
    // modules that carry them, so the closed set is asserted as a set.
    const observed = new Map(
      [...scratchNodes('cross-module'), ...scratchNodes('annotated'), ...scratchNodes('shapes')]
        .filter((node) => node.data.driver === 'pg')
        .map((node) => [String(node.data.statementShape).split(' ')[0], node.data.operation]),
    );

    expect(observed.get('INSERT')).toBe('insert');
    expect(observed.get('DELETE')).toBe('delete');
    expect(observed.get('UPDATE')).toBe('update');
    expect(observed.get('WITH')).toBe('with');
    expect(observed.get('SELECT')).toBe('select');

    // Present as a statement, absent as an operation: a keyword outside the
    // closed set leaves the field unset rather than reporting a guess, because
    // `../summary.ts` and the panel's query table both read it as a fact.
    expect(observed.has('VACUUM')).toBe(true);
    expect(observed.get('VACUUM')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------------------------------
 * 6. Tolerance, purity and determinism
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: tolerance, purity and determinism', () => {
  it('names itself stably, and exposes a frozen extractor', () => {
    expect(dbCallsExtractor.id).toBe(DB_CALLS_EXTRACTOR_ID);
    expect(DB_CALLS_EXTRACTOR_ID).toBe('db-calls');
    expect(Object.isFrozen(dbCallsExtractor)).toBe(true);
  });

  it('keeps indexing a syntactically broken module, and its siblings with it', () => {
    // The observable contract is "never throws, and one unreadable construct
    // costs at most that construct". ts-morph's parse recovery is tolerant
    // enough that the declaration before the damage is still a complete tree,
    // so the extractor still reports its call site rather than abandoning the
    // file — which is the stronger half of the same promise.
    const result = scratchResult('broken');
    const nodes = result.nodes.filter(
      (node): node is CodeNodeOf<'db-call'> => node.kind === 'db-call',
    );

    expect(nodes.map((node) => node.name)).toStrictEqual(['beta.query']);
    expect(itemAt(nodes, 0, 'the readable call').data.statementShape).toBe(
      'SELECT note FROM widget_log',
    );
    expect(result.edges).toHaveLength(1);

    // Nothing is reported, because nothing was lost: a diagnostic is the
    // channel for an index that is *missing* something, and the failure that
    // does reach a whole module is asserted in the privacy case above.
    expect(result.diagnostics).toBeUndefined();

    // A sibling module of the same project is unaffected, which is what makes
    // the tolerance worth having.
    expect(scratchNodes('cross-module')).toHaveLength(3);
  });

  it('produces deeply equal, identically ordered output on two consecutive runs', () => {
    const { project } = openedScratch();

    for (const file of filesOf(project)) {
      const first = resultOf(project, file);
      const second = resultOf(project, file);

      expect(second).toStrictEqual(first);
      expect(second.nodes.map((node) => node.id)).toStrictEqual(first.nodes.map((node) => node.id));
      expect(second.edges.map((edge) => edge.id)).toStrictEqual(first.edges.map((edge) => edge.id));
    }
  });

  it('writes nothing while extracting', () => {
    const { root, project } = openedScratch();

    for (const file of filesOf(project)) {
      resultOf(project, file);
    }

    expect(scratchSnapshot).toBeDefined();
    expect(directorySnapshot(root)).toStrictEqual(scratchSnapshot);
  });

  it('adds no source file to the project it was handed', () => {
    const { project } = openedScratch();
    const before = filesOf(project);

    for (const file of before) {
      resultOf(project, file);
    }

    // Module resolution reads other modules; it must never *add* one, because
    // every extractor is handed the same context and an added file would
    // silently change what the extractors after it see.
    expect(filesOf(project)).toStrictEqual(before);
  });

  it('leaves the committed corpus byte-for-byte as it found it', () => {
    // The whole suite has now opened the corpus, indexed it, read its text and
    // extracted from every one of its modules. The corpus is an input: a run
    // that changed it would leave `git status` dirty for every later suite.
    expect(corpusSnapshot).toBeDefined();
    expect(directorySnapshot(FIXTURE_ROOT)).toStrictEqual(corpusSnapshot);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Scratch helpers for the cases below
 * ---------------------------------------------------------------------------------------------- */

/**
 * One scratch module's source text, as written into the project.
 *
 * @param file The project-relative POSIX path, a key of {@link SCRATCH_MODULES}.
 * @returns The text.
 */
function scratchText(file: string): string {
  const text = SCRATCH_MODULES[file];

  if (text === undefined) {
    throw new Error(`the scratch project declares no module at ${file}`);
  }

  return text;
}

/**
 * One scratch module's whole result and its `db-call` nodes, by path.
 *
 * @param file The project-relative POSIX path, `.ts` or `.tsx`.
 * @param logger An optional recording logger.
 * @returns The result and its nodes, in emission order.
 */
function scratchFile(
  file: string,
  logger?: Logger,
): { readonly result: ExtractorResult; readonly nodes: readonly CodeNodeOf<'db-call'>[] } {
  const result = resultOf(openedScratch().project, file, logger);

  return {
    result,
    nodes: result.nodes.filter((node): node is CodeNodeOf<'db-call'> => node.kind === 'db-call'),
  };
}

/**
 * The fields of a node a case asserts, in one comparable value: the call as
 * written, where it is, what it records, and whether its handle was matched by
 * name.
 *
 * @param node The node.
 * @returns Its summary.
 */
function summaryOf(node: CodeNodeOf<'db-call'>): {
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly data: DbCallNodeData;
  readonly heuristic: boolean;
} {
  return {
    name: node.name,
    line: node.line,
    column: node.column,
    data: node.data,
    heuristic: isHeuristicDbCall(node.data),
  };
}

/* -------------------------------------------------------------------------------------------------
 * 7. Handles held by a class instance
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: handles held by a class instance', () => {
  const CLASS_MODULE = `${SCRATCH_SOURCE_DIRECTORY}/class-handles.ts`;
  const EXPRESSION_MODULE = `${SCRATCH_SOURCE_DIRECTORY}/class-expression.ts`;

  it('proves a constructed property, an annotated property and both parameter properties', () => {
    const text = scratchText(CLASS_MODULE);
    const at = (needle: string): { readonly line: number; readonly column: number } =>
      soleCodeOccurrence(text, needle);

    // Five instance calls in source order — the property arrow's, the
    // constructor's and the method's three — each resolved through the member
    // declaration the class holds, so none is marked as a name match.
    expect(scratchFile(CLASS_MODULE).nodes.map(summaryOf)).toStrictEqual([
      {
        name: 'this.pool.query',
        ...at("this.pool.query('SELECT note"),
        data: {
          driver: 'pg',
          operation: 'select',
          statementShape: 'SELECT note FROM widget_log',
          dynamic: false,
        },
        heuristic: false,
      },
      {
        name: 'this.store.widget.findFirst',
        ...at('this.store.widget.findFirst('),
        data: { driver: 'prisma', model: 'widget', operation: 'findFirst', dynamic: false },
        heuristic: false,
      },
      {
        name: 'this.pool.query',
        ...at("this.pool.query('SELECT id"),
        data: {
          driver: 'pg',
          operation: 'select',
          statementShape: 'SELECT id, note FROM widget_log WHERE kind = $1',
          dynamic: false,
        },
        heuristic: false,
      },
      {
        // Declared with only a type annotation and assigned in the
        // constructor: the annotation is the evidence.
        name: 'this.archive.gadget.create',
        ...at('this.archive.gadget.create('),
        data: { driver: 'prisma', model: 'gadget', operation: 'create', dynamic: false },
        heuristic: false,
      },
      {
        // A `protected` parameter property annotated as a borrowed connection.
        name: 'this.lease.query',
        ...at('this.lease.query('),
        data: {
          driver: 'pg',
          operation: 'delete',
          statementShape: 'DELETE FROM widget_log WHERE kind = $1',
          dynamic: false,
        },
        heuristic: false,
      },
    ]);
  });

  it('records nothing for a non-driver property, a plain parameter or the instance itself', () => {
    const names = scratchFile(CLASS_MODULE).nodes.map((node) => node.name);

    // `helper` is constructed from a class that is not a driver, `plain` is a
    // constructor parameter without a modifier — local to the constructor, so
    // no member — and `this.query` has the instance itself as its receiver.
    // None of the three names is generic, so no fallback applies either.
    expect(names).not.toContain('this.helper.query');
    expect(names).not.toContain('this.plain.query');
    expect(names).not.toContain('this.query');
    expect(names).toHaveLength(5);
  });

  it('names each member kind as the owner of the calls written inside it', () => {
    const { result, nodes } = scratchFile(CLASS_MODULE);

    // A property arrow, the constructor and a method of a module-level class
    // are symbols in the class's name space, never server functions.
    expect(nodes.map((node) => node.symbol)).toStrictEqual([
      'refresh',
      'constructor',
      'list',
      'list',
      'list',
    ]);
    expect(result.edges.map((edge) => edge.from.split('#')[0])).toStrictEqual(
      Array.from({ length: 5 }, () => `symbol:${CLASS_MODULE}`),
    );
  });

  it('resolves a handle a class expression holds, owned by the export that builds it', () => {
    const text = scratchText(EXPRESSION_MODULE);
    const node = itemAt(scratchFile(EXPRESSION_MODULE).nodes, 0, 'the class-expression call');

    expect(summaryOf(node)).toStrictEqual({
      name: 'this.pool.query',
      ...soleCodeOccurrence(text, 'this.pool.query('),
      data: {
        driver: 'pg',
        operation: 'insert',
        statementShape: 'INSERT INTO widget_log (note) VALUES ($1)',
        dynamic: false,
      },
      heuristic: false,
    });
    // A class expression's members are not addressable, so the walk continues
    // outward to the exported arrow that constructs the instance.
    expect(node.symbol).toBe('makeRecorder');
  });

  it('reaches an undeclared, constructor-assigned handle only by a generic name, and marks it', () => {
    const text = scratchText(EXPRESSION_MODULE);
    const nodes = scratchFile(EXPRESSION_MODULE).nodes;

    // `this.db = new Pool()` in a constructor body declares no member, so no
    // structural step applies: `db` is a generic driver word and is matched —
    // marked — while `archive`, assigned the same way, is not a generic word
    // and yields nothing.
    expect(nodes.map((node) => node.name)).toStrictEqual(['this.pool.query', 'this.db.query']);
    expect(summaryOf(itemAt(nodes, 1, 'the generic-name call'))).toStrictEqual({
      name: 'this.db.query',
      ...soleCodeOccurrence(text, 'this.db.query('),
      data: {
        driver: 'pg',
        operation: 'update',
        statementShape: 'UPDATE widget_log SET note = $1',
        dynamic: false,
        heuristicHandle: true,
      },
      heuristic: true,
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * 8. Dollar-quoted statement literals
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: dollar-quoted statement literals', () => {
  const DOLLAR_MODULE = `${SCRATCH_SOURCE_DIRECTORY}/dollar-quoted.ts`;

  /**
   * The dollar-quoting module's nodes, count-checked so the indices below name
   * the calls they mean.
   *
   * @returns The nine nodes, in source order.
   */
  function dollarNodes(): readonly CodeNodeOf<'db-call'>[] {
    const { nodes } = scratchFile(DOLLAR_MODULE);

    expect(nodes).toHaveLength(9);

    return nodes;
  }

  /** The shape at an index of {@link dollarNodes}. */
  function shapeAt(index: number): string | undefined {
    return itemAt(dollarNodes(), index, `dollar-quoted call ${String(index)}`).data.statementShape;
  }

  it('reduces an empty-tag quote and a named-tag quote to one placeholder each', () => {
    expect(shapeAt(0)).toBe('SELECT ? AS body FROM widget_log WHERE kind = $1');
    // The body holds an apostrophe, a line-comment marker and a block-comment
    // opener; inside a dollar quote all three are value text, not syntax.
    expect(shapeAt(1)).toBe('UPDATE widget_log SET note = ? WHERE kind = $2');
  });

  it('reads a tag of letters, digits and underscores, closed only by the same tag', () => {
    expect(shapeAt(2)).toBe('SELECT ? AS body, $1 AS kind FROM widget_log');
    // `$$` inside `$outer$` does not close it, and neither does `$b$` inside
    // `$a$`: the quote ends only where its own tag appears again.
    expect(shapeAt(3)).toBe('SELECT ? AS body FROM widget_log');
    expect(shapeAt(4)).toBe('SELECT ? AS body FROM widget_log');
  });

  it('consumes an unterminated dollar quote to the end of the statement', () => {
    // Everything after an opening tag that never closes is the literal's body,
    // so nothing of it — not even the table name — survives.
    expect(shapeAt(5)).toBe('SELECT ?');
  });

  it('keeps $n placeholders, which are never read as the opening of a quote', () => {
    expect(shapeAt(6)).toBe('SELECT note FROM widget_log WHERE kind = $1 AND size > $12');
  });

  it('emits a dollar that opens no quote as written', () => {
    // A `$` before a space opens nothing, and `$tag` with no closing `$` before
    // the statement ends is not a tag: both are kept literally.
    expect(shapeAt(7)).toBe('SELECT note FROM widget_log WHERE note = $ AND label = $tag');
  });

  it('derives no operation from a statement that is only a literal', () => {
    const node = itemAt(dollarNodes(), 8, 'the bare literal');

    expect(node.data).toStrictEqual({ driver: 'pg', statementShape: '?', dynamic: false });
    expect(Object.keys(node.data)).not.toContain('operation');
  });

  it('records the leading keyword of every other dollar-quoted statement', () => {
    expect(dollarNodes().map((node) => node.data.operation)).toStrictEqual([
      'select',
      'update',
      'select',
      'select',
      'select',
      'select',
      'select',
      'select',
      undefined,
    ]);
  });

  it('never records a dollar-quoted body anywhere in a node', () => {
    const serialised = JSON.stringify(dollarNodes());

    for (const sentinel of Object.values(DOLLAR_SENTINELS)) {
      expect(serialised).not.toContain(sentinel);
    }

    expect(serialised).not.toContain("it's");
    expect(serialised).not.toContain('not a comment');
    expect(serialised).not.toContain('nor this');
  });
});

/* -------------------------------------------------------------------------------------------------
 * 9. Owners across export forms and module kinds
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: owners across export forms and module kinds', () => {
  /** The assembled graph over the whole scratch project, for resolving edge origins. */
  let scratchGraph: CodeGraph | undefined;

  // A 30 s ceiling, not a budget: this hook parses a program, which a loaded
  // machine can push past the 10 s hook default and so fail every case below.
  beforeAll(async () => {
    const built = await buildIndex(openedScratch().project, { logger: noopLogger });

    if (!isOk(built)) {
      throw new Error(`indexing the scratch project failed: ${built.error.message}`);
    }

    scratchGraph = CodeGraph.fromIndex(built.value, { logger: noopLogger });
  }, 30_000);

  /**
   * The assembled graph, or a failure naming the missing `beforeAll`.
   *
   * @returns The graph.
   */
  function graph(): CodeGraph {
    if (scratchGraph === undefined) {
      throw new Error('the scratch graph was not built: beforeAll did not run');
    }

    return scratchGraph;
  }

  /**
   * Each call of a module with the node its `queries` edge starts at, as the
   * assembled graph holds it.
   *
   * @param file The project-relative POSIX path.
   * @returns One entry per node, in emission order.
   */
  function ownersIn(file: string): readonly {
    readonly call: string;
    readonly symbol: string | undefined;
    readonly ownerKind: string | undefined;
    readonly owner: string | undefined;
  }[] {
    const { result, nodes } = scratchFile(file);

    expect(result.edges).toHaveLength(nodes.length);

    return nodes.map((node) => {
      const edge = result.edges.find((candidate) => candidate.to === node.id);
      const origin = edge === undefined ? undefined : graph().nodeById(edge.from);

      return {
        call: node.name,
        symbol: node.symbol,
        ownerKind: origin?.kind,
        owner: origin?.name,
      };
    });
  }

  it.each([
    ['a default-exported arrow', 'default-arrow.ts', 'beta.query', 'server-function', 'default'],
    [
      'a nameless default function',
      'default-function.ts',
      'alpha.widget.findMany',
      'server-function',
      'default',
    ],
    [
      'an App Router module that is not a route',
      'app/widgets/format.ts',
      'beta.query',
      'server-function',
      'formatWidgets',
    ],
    ['an App Router route handler', 'app/widgets/route.ts', 'beta.query', 'symbol', 'GET'],
    ['a Pages Router default handler', 'pages/api/widgets.ts', 'beta.query', 'symbol', 'handler'],
    [
      'a component-named function in a markup module',
      'components/WidgetPanel.tsx',
      'beta.query',
      'symbol',
      'WidgetPanel',
    ],
    [
      'a lower-case function in a markup module',
      'components/render-rows.tsx',
      'beta.query',
      'server-function',
      'renderRows',
    ],
    [
      'a function beside a component-named variable',
      'components/panel-exports.tsx',
      'beta.query',
      'symbol',
      'summarize',
    ],
  ])(
    'starts the edge for %s at the node the graph holds',
    (_label, stem, call, ownerKind, owner) => {
      // The node's `symbol` names the owner, and the owner is a node the
      // assembled graph holds, of the kind the module's shape calls for.
      expect(ownersIn(`${SCRATCH_SOURCE_DIRECTORY}/${stem}`)).toStrictEqual([
        { call, symbol: owner, ownerKind, owner },
      ]);
    },
  );

  it('follows export default <name> and an aliased export clause to the declaration they export', () => {
    // `purge` leaves only as the default export and `load` only as `read`; both
    // are still the declaration a call inside them belongs to, and both are
    // service functions. `helper`, which does not leave the module, is a symbol,
    // and the re-export clause naming another module's binding marks nothing.
    expect(ownersIn(`${SCRATCH_SOURCE_DIRECTORY}/default-named.ts`)).toStrictEqual([
      { call: 'beta.query', symbol: 'purge', ownerKind: 'server-function', owner: 'purge' },
      { call: 'beta.query', symbol: 'load', ownerKind: 'server-function', owner: 'load' },
      { call: 'beta.query', symbol: 'helper', ownerKind: 'symbol', owner: 'helper' },
    ]);
  });

  it('falls back to the module for a call inside a wrapped default export, and says so at debug', () => {
    const file = `${SCRATCH_SOURCE_DIRECTORY}/default-wrapped.ts`;
    const { records, logger } = recordingLogger();
    const { result, nodes } = scratchFile(file, logger);
    const node = itemAt(nodes, 0, 'the wrapped call');

    expect(ownersIn(file)).toStrictEqual([
      { call: 'beta.query', symbol: undefined, ownerKind: 'file', owner: file },
    ]);
    expect(Object.keys(node)).not.toContain('symbol');
    expect(result.diagnostics).toBeUndefined();
    expect(records.map((record) => record.fields)).toStrictEqual([
      { extractorId: DB_CALLS_EXTRACTOR_ID, file, line: node.line, column: node.column },
    ]);
  });

  it('proves a handle that leaves its module only as the default export', () => {
    const file = `${SCRATCH_SOURCE_DIRECTORY}/default-handle-use.ts`;
    const text = scratchText(file);

    // `store` is `export default new Pool()` and `keeper` is
    // `export default beta`, a re-binding of an imported handle. Neither name is
    // generic, so a node for either proves the default export was followed.
    expect(scratchFile(file).nodes.map(summaryOf)).toStrictEqual([
      {
        name: 'store.query',
        ...soleCodeOccurrence(text, 'store.query('),
        data: {
          driver: 'pg',
          operation: 'select',
          statementShape: 'SELECT note FROM widget_log',
          dynamic: false,
        },
        heuristic: false,
      },
      {
        name: 'keeper.query',
        ...soleCodeOccurrence(text, 'keeper.query('),
        data: {
          driver: 'pg',
          operation: 'select',
          statementShape: 'SELECT kind FROM widget_log',
          dynamic: false,
        },
        heuristic: false,
      },
    ]);
  });

  it('owns a computed-name member’s call by its class, and a string-named member’s by its name', () => {
    const file = `${SCRATCH_SOURCE_DIRECTORY}/class-computed.ts`;
    const text = scratchText(file);
    const nodes = scratchFile(file).nodes;

    // No lookup can match a computed name, so the walk continues to the
    // module-level class itself; a string-literal name reads as its value, for
    // the member that owns a call and for the member that holds the handle.
    expect(ownersIn(file)).toStrictEqual([
      {
        call: 'this.archive.query',
        symbol: 'ComputedMembers',
        ownerKind: 'symbol',
        owner: 'ComputedMembers',
      },
      {
        call: 'this.archive.query',
        symbol: 'quoted-name',
        ownerKind: 'symbol',
        owner: 'quoted-name',
      },
    ]);
    expect(nodes.map((node) => ({ line: node.line, column: node.column }))).toStrictEqual([
      soleCodeOccurrence(text, "this.archive.query('SELECT note"),
      soleCodeOccurrence(text, "this.archive.query('SELECT kind"),
    ]);
    expect(nodes.every((node) => !isHeuristicDbCall(node.data))).toBe(true);
  });

  it('starts every edge of these modules at a node the graph holds, and drops none', () => {
    const files = Object.keys(SCRATCH_MODULES).filter(
      (file) =>
        file.startsWith(`${SCRATCH_SOURCE_DIRECTORY}/class-`) ||
        file.startsWith(`${SCRATCH_SOURCE_DIRECTORY}/default-`) ||
        file.startsWith(`${SCRATCH_SOURCE_DIRECTORY}/dollar-`) ||
        file.startsWith(`${SCRATCH_SOURCE_DIRECTORY}/app/`) ||
        file.startsWith(`${SCRATCH_SOURCE_DIRECTORY}/pages/`) ||
        file.startsWith(`${SCRATCH_SOURCE_DIRECTORY}/components/`),
    );
    const edges = files.flatMap((file) => scratchFile(file).result.edges);

    // Seventeen modules — two of them handle modules with no call site — and
    // one edge per call site: 5 + 2 + 2 + 9 + 1 + 1 + 3 + 1 + 2 + 1 + 1 + 1 + 3.
    expect(files).toHaveLength(17);
    expect(edges).toHaveLength(32);

    for (const edge of edges) {
      expect(graph().nodeById(edge.from), edge.from).toBeDefined();
      expect(
        graph()
          .incoming(edge.to, 'queries')
          .map((found) => found.id),
      ).toStrictEqual([edge.id]);
    }

    expect(
      graph().diagnostics.filter(
        (finding) => finding.code === 'dangling-edge' && files.includes(finding.file ?? ''),
      ),
    ).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 10. A call site or a module it cannot read
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: a call site or a module path it cannot read', () => {
  /** A module with one call inside a function and one at module scope. */
  const TWO_SITES = [
    'class Pool {',
    '  query(text: string): string {',
    '    return text;',
    '  }',
    '}',
    '',
    'const pool = new Pool();',
    '',
    'export function kept(): string {',
    "  return pool.query('SELECT note FROM widget_log');",
    '}',
    '',
    "void pool.query('SELECT kind FROM widget_log');",
    '',
  ].join('\n');

  /**
   * A logger whose `debug` throws, which is the one call the owner cascade makes
   * for a module-scope call site — so that site, and only that site, fails.
   *
   * @param thrown What `debug` throws.
   * @returns The logger.
   */
  function loggerThrowingOnDebug(thrown: unknown): Logger {
    const logger: Logger = {
      ...noopLogger,
      debug: () => {
        throw thrown;
      },
      child: () => logger,
    };

    return logger;
  }

  it('reports one unreadable call site as a warning and still indexes the rest', () => {
    const context = {
      ...inMemoryContext('src/two-sites.ts', TWO_SITES),
      logger: loggerThrowingOnDebug(new TypeError(`refused ${VALUES_SENTINELS[0]}`)),
    };
    const result = dbCallsExtractor.extract(context);
    const failed = soleCodeOccurrence(TWO_SITES, "pool.query('SELECT kind");

    expect(result.nodes.map((node) => node.name)).toStrictEqual(['pool.query']);
    expect(result.nodes.map((node) => node.symbol)).toStrictEqual(['kept']);
    expect(result.edges).toHaveLength(1);
    expect(result.diagnostics).toStrictEqual([
      {
        severity: 'warning',
        code: 'extractor-failed',
        message:
          'A database call site could not be read; it contributes no db-call node (TypeError).',
        file: 'src/two-sites.ts',
        extractorId: DB_CALLS_EXTRACTOR_ID,
        detail: `line ${String(failed.line)}, column ${String(failed.column)}`,
      },
    ]);
    // The error's class, never its message: a message can quote source text.
    expect(JSON.stringify(result.diagnostics)).not.toContain(VALUES_SENTINELS[0]);
  });

  it('names a thrown value that is not an Error by its type', () => {
    const context = {
      ...inMemoryContext('src/two-sites.ts', TWO_SITES),
      logger: loggerThrowingOnDebug('a bare string'),
    };
    const [diagnostic] = dbCallsExtractor.extract(context).diagnostics ?? [];

    expect(diagnostic?.message).toBe(
      'A database call site could not be read; it contributes no db-call node (string).',
    );
    expect(diagnostic?.message).not.toContain('a bare string');
  });

  it.each([
    ['a traversal', '../outside.ts'],
    ['an absolute path', '/elsewhere/module.ts'],
  ])('declines a module whose path is %s, and says so', (_label, file) => {
    const { records, logger } = recordingLogger();
    const result = dbCallsExtractor.extract({
      ...inMemoryContext('src/two-sites.ts', TWO_SITES),
      file,
      logger,
    });

    expect(result).toStrictEqual({ nodes: [], edges: [] });
    expect(records.map((record) => [record.level, record.fields])).toStrictEqual([
      ['warn', { extractorId: DB_CALLS_EXTRACTOR_ID, file }],
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 11. Escaped literals, numbers and concatenated statements
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: escaped literals, numbers and concatenated statements', () => {
  const ESCAPES_MODULE = `${SCRATCH_SOURCE_DIRECTORY}/literal-escapes.ts`;

  /**
   * The escape module's nodes, count-checked so the indices below name the calls
   * they mean.
   *
   * @returns The nine nodes, in source order.
   */
  function escapeNodes(): readonly CodeNodeOf<'db-call'>[] {
    const { nodes } = scratchFile(ESCAPES_MODULE);

    expect(nodes).toHaveLength(9);

    return nodes;
  }

  /** The payload at an index of {@link escapeNodes}. */
  function dataAt(index: number): DbCallNodeData {
    return itemAt(escapeNodes(), index, `escape call ${String(index)}`).data;
  }

  it('ends a literal only at an unescaped quote, under both escape conventions', () => {
    // A doubled quote and a backslash-escaped quote both continue the literal;
    // ending it at either would emit the rest of the value as statement text.
    expect(dataAt(0).statementShape).toBe(
      'SELECT note FROM widget_log WHERE note = ? AND kind = $1',
    );
    expect(dataAt(1).statementShape).toBe(
      'SELECT note FROM widget_log WHERE note = ? AND kind = $1',
    );
  });

  it('consumes an unterminated literal to the end of the statement', () => {
    expect(dataAt(4).statementShape).toBe('SELECT note FROM widget_log WHERE note = ?');
  });

  it('reduces decimals and exponents whole, and leaves digits inside names alone', () => {
    expect(dataAt(2).statementShape).toBe(
      'SELECT note FROM widget_log WHERE size > ? AND ratio < ? AND delta = ? AND step = ?',
    );
    expect(dataAt(6).statementShape).toBe('SELECT note FROM widget_log WHERE col1 = t2.c3');
  });

  it('keeps a delimited identifier with doubled quotes inside it as one identifier', () => {
    expect(dataAt(3).statementShape).toBe('SELECT "Odd ""Quoted"" Name" FROM widget_log');
  });

  it('records no shape and no operation for a statement that is only a comment', () => {
    // The pooled handle is proved, so the call is still a node; the source
    // states no statement, which `dynamic` reports.
    expect(dataAt(5)).toStrictEqual({ driver: 'pg', dynamic: true });
  });

  it('joins a concatenation of literals, and marks one with a computed part as dynamic', () => {
    expect(dataAt(7)).toStrictEqual({
      driver: 'pg',
      operation: 'select',
      statementShape: 'SELECT note FROM widget_log WHERE kind = $1',
      dynamic: false,
    });
    expect(dataAt(8)).toStrictEqual({
      driver: 'pg',
      operation: 'select',
      statementShape: `SELECT note FROM widget_log WHERE kind = ${VALUE_PLACEHOLDER}`,
      dynamic: true,
    });
  });

  it('never records the body of an escaped or unterminated literal anywhere in a node', () => {
    const serialised = JSON.stringify(escapeNodes());

    for (const sentinel of Object.values(ESCAPE_SENTINELS)) {
      expect(serialised).not.toContain(sentinel);
    }

    expect(serialised).not.toContain('only a comment');
    expect(serialised).not.toContain('never closed');
  });
});

/* -------------------------------------------------------------------------------------------------
 * 12. Receivers through namespaces, barrels and alias chains
 * ---------------------------------------------------------------------------------------------- */

describe('dbCallsExtractor: receivers through namespaces, barrels and alias chains', () => {
  const RECEIVERS_MODULE = `${SCRATCH_SOURCE_DIRECTORY}/receivers.ts`;
  const ALIAS_MODULE = `${SCRATCH_SOURCE_DIRECTORY}/alias-chain.ts`;

  it('resolves a handle through a namespace import, a renamed re-export and a star re-export', () => {
    const text = scratchText(RECEIVERS_MODULE);

    // None of `handles`, `ledger` or `starred` is a generic driver word, so a
    // node — unmarked — proves each route was followed to the construction.
    expect(scratchFile(RECEIVERS_MODULE).nodes.map(summaryOf)).toStrictEqual([
      {
        name: 'handles.beta.query',
        ...soleCodeOccurrence(text, "handles.beta.query('SELECT note FROM"),
        data: {
          driver: 'pg',
          operation: 'select',
          statementShape: 'SELECT note FROM widget_log',
          dynamic: false,
        },
        heuristic: false,
      },
      {
        name: 'handles.alpha.widget.findMany',
        ...soleCodeOccurrence(text, 'handles.alpha.widget.findMany('),
        data: { driver: 'prisma', model: 'widget', operation: 'findMany', dynamic: false },
        heuristic: false,
      },
      {
        name: 'ledger.query',
        ...soleCodeOccurrence(text, 'ledger.query('),
        data: {
          driver: 'pg',
          operation: 'select',
          statementShape: 'SELECT kind FROM widget_log',
          dynamic: false,
        },
        heuristic: false,
      },
      {
        name: 'starred.query',
        ...soleCodeOccurrence(text, 'starred.query('),
        data: {
          driver: 'pg',
          operation: 'select',
          statementShape: 'SELECT size FROM widget_log',
          dynamic: false,
        },
        heuristic: false,
      },
    ]);
  });

  it('refuses receivers whose handle or member is not statically known', () => {
    const names = scratchFile(RECEIVERS_MODULE).nodes.map((node) => node.name);
    const serialised = JSON.stringify(scratchFile(RECEIVERS_MODULE).nodes);

    // An element access, a call at the root, a delegate chain one segment too
    // deep, a `$`-prefixed model and a `$`-prefixed delegate operation: each is
    // either not statically known or not the generated client's shape, and a
    // guess is worse than a miss.
    for (const refusedStatement of ['SELECT label', 'SELECT note, kind']) {
      expect(serialised).not.toContain(refusedStatement);
    }

    expect(names).not.toContain('beta.query');
    expect(names).not.toContain('alpha.widget.nested.findMany');
    expect(names).not.toContain('alpha.$extends.widget');
    expect(names).not.toContain('alpha.widget.$call');
  });

  it('lets a local binding shadow a namespace import of the same name', () => {
    // `handles` in `shadowed` is a local object literal: the namespace route is
    // closed, and nothing structural or generic remains.
    const serialised = JSON.stringify(scratchFile(RECEIVERS_MODULE).nodes);

    expect(serialised).not.toContain('SELECT note, size');
    expect(scratchFile(RECEIVERS_MODULE).nodes.map((node) => node.symbol)).toStrictEqual([
      'receivers',
      'receivers',
      'receivers',
      'receivers',
    ]);
  });

  it('follows an alias chain inside the resolution bound and gives up on one far past it', () => {
    const text = scratchText(ALIAS_MODULE);

    // Two re-bindings from the import resolve; eight exceed the bound on
    // resolution hops, and the call is left out rather than guessed at.
    expect(scratchFile(ALIAS_MODULE).nodes.map(summaryOf)).toStrictEqual([
      {
        name: 'near2.query',
        ...soleCodeOccurrence(text, 'near2.query('),
        data: {
          driver: 'pg',
          operation: 'select',
          statementShape: 'SELECT note FROM widget_log',
          dynamic: false,
        },
        heuristic: false,
      },
    ]);
  });
});
