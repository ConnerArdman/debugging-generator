/**
 * Unit suite for `./query.ts`'s `findSymbol`/`hasSymbol` — the two queries the
 * rest of the product asks before it acts on a `(file, symbol)` pair.
 *
 * The property under test is an **equivalence with the patcher**, not a lookup:
 * `packages/instrumentation/src/feasibility.ts` rejects a plan action whose
 * file or symbol the graph does not hold, so `hasSymbol(file, symbol)` must be
 * true exactly when `FunctionTimingPatcher` can resolve `(file, symbol)` to a
 * declaration. Anything the graph affirms and the patcher refuses is a plan
 * that passes feasibility and then fails at install, which is what happened for
 * every React handler in the demo application: a `handler` node carries the
 * referenced function's name, so it answered for names that were parameters,
 * destructured props or declarations in another file entirely.
 *
 * The cases below therefore split into three groups:
 *
 * 1. **Who may answer.** Only a node that *declares* the name — `symbol`,
 *    `component`, `server-function` — and only through its own `name`. A
 *    `handler` node (a binding site) and an `api-call` or `db-call` node (a
 *    call site inside a function of that name) never answer, whatever their
 *    `symbol` field carries.
 * 2. **What a declaration answers with.** The facts a patch needs: `exported`,
 *    `isAsync` for a server function, and `enclosing` for a nested declaration
 *    — which a planner needs in order to qualify an ambiguous bare name.
 * 3. **What has not changed.** The kind preference and position ordering among
 *    several declarations, the path and name guards, and the agreement between
 *    the predicate and the lookup.
 *
 * ## Purity
 *
 * Fixture-free: every case builds a small hand-authored `CodeIndex` in memory
 * and reads it through the real `CodeGraph.fromIndex`, so no filesystem, no
 * ts-morph project and no corpus is involved, and nothing here can be affected
 * by another suite's fixtures. Node ids are derived through the real
 * {@link makeNodeId} rather than spelled out, because `./graph.ts` documents
 * that no consumer may parse an id and a test that hard-coded one would be the
 * first to do so. Identifiers are neutral placeholders (`Panel`,
 * `submitPanel`, `loadItems`).
 */

import { describe, expect, it } from 'vitest';

import { CODE_QUERY_LIMITS, createCodeQueries } from './query.js';
import { CodeGraph, makeNodeId } from './graph.js';
import { CODE_INDEX_SCHEMA_VERSION } from './types.js';
import type { CodeIndex, CodeNode, CodeNodeKind, CodeNodeOf } from './types.js';
import type { CodeQueries } from './query.js';

/* -------------------------------------------------------------------------------------------------
 * Builders
 * ---------------------------------------------------------------------------------------------- */

/** The absolute POSIX project root every index in this file declares. */
const PROJECT_ROOT = '/tmp/project';

/** The file the declarations under test live in. */
const PANEL_FILE = 'src/components/Panel.tsx';

/** What a case varies about a built node. */
interface NodeSpec<K extends CodeNodeKind> {
  /** Project-relative POSIX path; defaults to {@link PANEL_FILE}. */
  readonly file?: string;

  /** The node's source-spelled name. */
  readonly name: string;

  /** 1-based line; defaults to `1`. */
  readonly line?: number;

  /** 1-based column; defaults to `1`. */
  readonly column?: number;

  /**
   * The enclosing or declared symbol name, when the case needs one.
   *
   * Spelled only where it matters, because this is the field whose match used
   * to make a call site answer a declaration question.
   */
  readonly symbol?: string;

  /** Whether the declaration leaves its module, when the case states it. */
  readonly exported?: boolean;

  /** The kind's payload. */
  readonly data: CodeNodeOf<K>['data'];
}

/**
 * Builds one {@link CodeNode}, with its id derived through the **real**
 * {@link makeNodeId} and only the optional fields the spec carries.
 *
 * Each optional field is added by building a *new* object rather than by
 * assigning into a draft: `exactOptionalPropertyTypes` makes "present and
 * `undefined`" a different thing from "absent", and `symbol`'s absence is
 * exactly what several cases below are about.
 *
 * The one assertion is the same narrow one `./graph.test.ts` makes and for the
 * same reason: the literal carries every field of the kind it names — `data`
 * comes from `CodeNodeOf<K>` — but the compiler cannot verify that an object
 * whose `kind` is the type parameter `K` inhabits the union member
 * `CodeNodeOf<K>` while `K` is still generic. Each subsequent step is an
 * intersection with that member, which needs no assertion at all.
 *
 * @typeParam K The node kind to build.
 * @param kind The node's kind.
 * @param spec The node's name, position, payload and optional fields.
 * @returns The node.
 */
function node<K extends CodeNodeKind>(kind: K, spec: NodeSpec<K>): CodeNodeOf<K> {
  const file = spec.file ?? PANEL_FILE;
  const line = spec.line ?? 1;
  const column = spec.column ?? 1;
  const base = {
    id: makeNodeId({ kind, file, name: spec.name, line, column }),
    kind,
    name: spec.name,
    file,
    line,
    column,
    data: spec.data,
  } as CodeNodeOf<K>;
  const withSymbol = spec.symbol === undefined ? base : { ...base, symbol: spec.symbol };

  return spec.exported === undefined ? withSymbol : { ...withSymbol, exported: spec.exported };
}

/**
 * The queries over a graph holding exactly the given nodes.
 *
 * No edges and no file fingerprints: `findSymbol` reads the per-file node index
 * and nothing else, and an edge would only introduce a `dangling-edge`
 * diagnostic to explain.
 *
 * @param nodes The nodes to build the graph from.
 * @returns The query surface.
 */
function queriesOver(nodes: readonly CodeNode[]): CodeQueries {
  const index: CodeIndex = {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot: PROJECT_ROOT,
    indexerVersion: 'test',
    generatedAt: 0,
    nodes,
    edges: [],
    files: [],
  };

  return createCodeQueries(CodeGraph.fromIndex(index));
}

/* -------------------------------------------------------------------------------------------------
 * Fixtures: one declaration per shape, plus the three non-declarations
 * ---------------------------------------------------------------------------------------------- */

/** A nested declaration: `function submitPanel()` inside `Panel`. */
const NESTED_SYMBOL = node('symbol', {
  name: 'submitPanel',
  line: 40,
  exported: false,
  data: { declaration: 'function', isDefaultExport: false, enclosing: ['Panel'] },
});

/** A module-level declaration in the same file. */
const MODULE_SYMBOL = node('symbol', {
  name: 'Panel',
  line: 10,
  exported: true,
  data: { declaration: 'function', isDefaultExport: false },
});

/**
 * A `handler` node for a prop whose function is declared in the *caller*.
 *
 * Both fields carry the name, which is what the extractor records for a
 * resolvable reference — and what used to make this node answer a question
 * about a declaration this file does not hold.
 */
const HANDLER_NODE = node('handler', {
  name: 'onPick',
  line: 20,
  symbol: 'onPick',
  data: { event: 'click', boundTo: 'button', inline: false },
});

/** An `api-call` node carrying the name of the function it sits inside. */
const API_CALL_NODE = node('api-call', {
  name: 'fetchItems',
  line: 30,
  symbol: 'submitPanel',
  data: { url: '/api/items', dynamic: false, method: 'POST' },
});

/** A `db-call` node carrying the name of the function it sits inside. */
const DB_CALL_NODE = node('db-call', {
  file: 'src/server/items.ts',
  name: 'findMany',
  line: 30,
  symbol: 'loadItems',
  data: { driver: 'prisma', model: 'Item', operation: 'findMany', dynamic: false },
});

/* -------------------------------------------------------------------------------------------------
 * Group 1: who may answer
 * ---------------------------------------------------------------------------------------------- */

describe('findSymbol/hasSymbol: only a declaration answers', () => {
  it('is not answered by a handler node alone', () => {
    const queries = queriesOver([HANDLER_NODE]);

    expect(queries.hasSymbol(PANEL_FILE, 'onPick')).toBe(false);
    expect(queries.findSymbol(PANEL_FILE, 'onPick')).toBeUndefined();
  });

  it('is not answered by a handler node that carries no symbol field either', () => {
    const queries = queriesOver([
      node('handler', {
        name: 'onClose',
        line: 21,
        data: { event: 'click', boundTo: 'button', inline: false },
      }),
    ]);

    // The name alone is no weaker a claim than the `symbol` field was: a
    // handler node is a record of a binding in either shape.
    expect(queries.hasSymbol(PANEL_FILE, 'onClose')).toBe(false);
  });

  it('is not answered by an api-call node whose symbol field carries the name', () => {
    const queries = queriesOver([API_CALL_NODE]);

    expect(queries.hasSymbol(PANEL_FILE, 'submitPanel')).toBe(false);
    expect(queries.findSymbol(PANEL_FILE, 'submitPanel')).toBeUndefined();
  });

  it('is not answered by a db-call node whose symbol field carries the name', () => {
    const queries = queriesOver([DB_CALL_NODE]);

    expect(queries.hasSymbol('src/server/items.ts', 'loadItems')).toBe(false);
  });

  it('is not answered by a symbol node of a type-level or unclassifiable kind', () => {
    for (const declaration of ['type', 'interface', 'enum', 'unknown'] as const) {
      const queries = queriesOver([
        node('symbol', {
          name: 'Shape',
          line: 5,
          exported: true,
          data: { declaration, isDefaultExport: false },
        }),
      ]);

      expect(queries.hasSymbol(PANEL_FILE, 'Shape')).toBe(false);
    }
  });

  it('is answered by a module-level variable, which the patcher refuses on shape instead', () => {
    const queries = queriesOver([
      node('symbol', {
        name: 'rows',
        line: 6,
        exported: true,
        data: { declaration: 'variable', isDefaultExport: false },
      }),
    ]);

    // "Declared here, and it holds no function" is a different and more useful
    // answer than "no such symbol", and it is the patcher's to give.
    expect(queries.hasSymbol(PANEL_FILE, 'rows')).toBe(true);
  });

  it('is answered by a symbol node with no payload at all', () => {
    const queries = queriesOver([
      {
        id: makeNodeId({ kind: 'symbol', file: PANEL_FILE, name: 'legacy', line: 7, column: 1 }),
        kind: 'symbol',
        name: 'legacy',
        file: PANEL_FILE,
        line: 7,
        column: 1,
      },
    ]);

    // Unclassified is not the same as known to be type-level: the file still
    // declares the name, and the shape question belongs to the patcher.
    expect(queries.hasSymbol(PANEL_FILE, 'legacy')).toBe(true);
  });

  it('prefers the declaration over a handler node of the same name in the same file', () => {
    const declaration = node('symbol', {
      name: 'onPick',
      line: 50,
      exported: false,
      data: { declaration: 'function', isDefaultExport: false, enclosing: ['Panel'] },
    });
    const match = queriesOver([HANDLER_NODE, declaration]).findSymbol(PANEL_FILE, 'onPick');

    expect(match?.kind).toBe('symbol');
    expect(match?.nodeId).toBe(declaration.id);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Group 2: what a declaration answers with
 * ---------------------------------------------------------------------------------------------- */

describe('findSymbol: the facts a patch needs', () => {
  it('affirms a nested declaration and reports its enclosing chain', () => {
    const match = queriesOver([MODULE_SYMBOL, NESTED_SYMBOL]).findSymbol(PANEL_FILE, 'submitPanel');

    expect(match?.kind).toBe('symbol');
    expect(match?.enclosing).toStrictEqual(['Panel']);
    expect(match?.exported).toBe(false);
    expect(match?.location.line).toBe(40);
    expect(match?.location.resolvedBy).toBe('code-graph');
  });

  it('forwards an empty enclosing chain as present, not as absence', () => {
    const match = queriesOver([
      node('symbol', {
        name: 'tally',
        line: 60,
        exported: false,
        data: { declaration: 'function', isDefaultExport: false, enclosing: [] },
      }),
    ]).findSymbol(PANEL_FILE, 'tally');

    expect(match).toHaveProperty('enclosing');
    expect(match?.enclosing).toStrictEqual([]);
  });

  it('reports no enclosing chain for a module-level declaration', () => {
    const match = queriesOver([MODULE_SYMBOL]).findSymbol(PANEL_FILE, 'Panel');

    expect(match).not.toHaveProperty('enclosing');
    expect(match?.exported).toBe(true);
  });

  it('still reports isAsync for a server-function match', () => {
    const match = queriesOver([
      node('server-function', {
        file: 'src/server/items.ts',
        name: 'loadItems',
        line: 12,
        data: { isAsync: true, exported: true },
      }),
    ]).findSymbol('src/server/items.ts', 'loadItems');

    expect(match?.kind).toBe('server-function');
    expect(match?.isAsync).toBe(true);
    expect(match?.exported).toBe(true);
    expect(match).not.toHaveProperty('enclosing');
  });

  it('still answers from a component node', () => {
    const match = queriesOver([
      node('component', {
        name: 'Panel',
        line: 10,
        data: { isClient: true, isDefaultExport: true, displayName: 'Panel' },
      }),
    ]).findSymbol(PANEL_FILE, 'Panel');

    expect(match?.kind).toBe('component');
    expect(match?.exported).toBe(true);
    expect(match).not.toHaveProperty('isAsync');
  });
});

/* -------------------------------------------------------------------------------------------------
 * Group 3: what has not changed
 * ---------------------------------------------------------------------------------------------- */

describe('findSymbol: ordering and guards are unchanged', () => {
  it('prefers server-function, then component, then symbol', () => {
    const serverFunction = node('server-function', {
      name: 'Panel',
      line: 70,
      data: { isAsync: false, exported: true },
    });
    const component = node('component', {
      name: 'Panel',
      line: 71,
      data: { isClient: false, isDefaultExport: false, displayName: 'Panel' },
    });
    const symbol = node('symbol', {
      name: 'Panel',
      line: 72,
      exported: true,
      data: { declaration: 'function', isDefaultExport: false },
    });

    expect(
      queriesOver([symbol, component, serverFunction]).findSymbol(PANEL_FILE, 'Panel')?.kind,
    ).toBe('server-function');
    expect(queriesOver([symbol, component]).findSymbol(PANEL_FILE, 'Panel')?.kind).toBe(
      'component',
    );
    expect(queriesOver([symbol]).findSymbol(PANEL_FILE, 'Panel')?.kind).toBe('symbol');
  });

  it('breaks a tie between two declarations of one kind on position', () => {
    const later = node('symbol', {
      name: 'apply',
      line: 90,
      exported: false,
      data: { declaration: 'function', isDefaultExport: false, enclosing: ['Sidebar'] },
    });
    const earlier = node('symbol', {
      name: 'apply',
      line: 80,
      exported: false,
      data: { declaration: 'function', isDefaultExport: false, enclosing: ['Panel'] },
    });
    const match = queriesOver([later, earlier]).findSymbol(PANEL_FILE, 'apply');

    expect(match?.nodeId).toBe(earlier.id);
    expect(match?.enclosing).toStrictEqual(['Panel']);
  });

  it('answers with the module-scope declaration when a nested one shadows its name', () => {
    // The declaration the function-timing patcher wraps for a bare
    // `(file, symbol)` action: it resolves module scope first and descends into
    // function bodies only when module scope yields nothing. Position alone
    // would report the nested one here, since it is written first.
    const nested = node('symbol', {
      name: 'apply',
      line: 30,
      exported: false,
      data: { declaration: 'function', isDefaultExport: false, enclosing: ['Panel'] },
    });
    const moduleScope = node('symbol', {
      name: 'apply',
      line: 90,
      exported: true,
      data: { declaration: 'function', isDefaultExport: false },
    });
    const match = queriesOver([nested, moduleScope]).findSymbol(PANEL_FILE, 'apply');

    expect(match?.nodeId).toBe(moduleScope.id);
    expect(match?.location.line).toBe(90);
    expect(match?.enclosing).toBeUndefined();
    expect(match?.exported).toBe(true);
  });

  it('refuses a file argument that is not a safe project-relative path', () => {
    const queries = queriesOver([MODULE_SYMBOL]);

    for (const file of ['../../etc/passwd', '/etc/passwd', 'src\\components\\Panel.tsx', '']) {
      expect(queries.findSymbol(file, 'Panel')).toBeUndefined();
      expect(queries.hasSymbol(file, 'Panel')).toBe(false);
    }
  });

  it('accepts a redundant but safe spelling of the file, as normalisation implies', () => {
    const queries = queriesOver([MODULE_SYMBOL]);

    expect(queries.hasSymbol('./src/components/Panel.tsx', 'Panel')).toBe(true);
    expect(queries.hasSymbol('src/components/../components/Panel.tsx', 'Panel')).toBe(true);
  });

  it('refuses a symbol argument outside the length bound', () => {
    const queries = queriesOver([MODULE_SYMBOL]);

    expect(queries.hasSymbol(PANEL_FILE, '')).toBe(false);
    expect(queries.hasSymbol(PANEL_FILE, 'x'.repeat(CODE_QUERY_LIMITS.maxNameLength + 1))).toBe(
      false,
    );
  });

  it('keeps hasSymbol exactly equivalent to findSymbol !== undefined', () => {
    const queries = queriesOver([MODULE_SYMBOL, NESTED_SYMBOL, HANDLER_NODE, API_CALL_NODE]);

    for (const symbol of ['Panel', 'submitPanel', 'onPick', 'fetchItems', 'absent']) {
      expect(queries.hasSymbol(PANEL_FILE, symbol)).toBe(
        queries.findSymbol(PANEL_FILE, symbol) !== undefined,
      );
    }
  });

  it('leaves whoCalls able to reach a call site through its symbol field', () => {
    const queries = queriesOver([NESTED_SYMBOL, API_CALL_NODE]);

    // The narrowed candidate filter belongs to findSymbol/hasSymbol alone: the
    // wider question "what refers to this name here" still sees the call site,
    // which is why `symbolCandidates` was left as it was.
    expect(queries.findByName('fetchItems').map((match) => match.kind)).toStrictEqual(['api-call']);
    expect(queries.whoCalls({ file: PANEL_FILE, symbol: 'submitPanel' })).toStrictEqual([]);
  });
});
