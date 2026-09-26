/**
 * Unit suite for `./symbols.ts`, the sole producer of `symbol` nodes and of the
 * `declares` edges that anchor them to their file.
 *
 * `../graph/query.ts`'s `findSymbol`/`hasSymbol` — which
 * `packages/instrumentation/src/feasibility.ts` acts on when it decides whether
 * an instrumentation plan action naming a `(file, symbol)` pair is feasible —
 * answer from those nodes alone. So the two failure modes are symmetric and
 * both are expensive:
 *
 * - **A missing node** makes a legitimate plan action unfeasible. The case that
 *   mattered in practice is AAP §6's canonical plan, which names a React submit
 *   handler declared *inside* its component; before the nested cases below
 *   existed the graph held no node for it at all.
 * - **A fabricated node** makes the graph promise a `(file, symbol)` pair the
 *   function-timing patcher then refuses. A parameter, a destructured prop and
 *   a `useCallback` result all look like named functions at a binding site and
 *   are not declarations this file holds a body for.
 *
 * ## The two halves, and why both are needed
 *
 * **Part 1 — the boundary around nested declarations**, driven by ts-morph
 * `Project`s on an **in-memory filesystem** with hand-made
 * {@link ExtractorContext}s. That is the whole dependency: the extractor is
 * pure, synchronous and reads nothing but the syntax tree of `ctx.sourceFile`,
 * so a case about one syntactic shape needs no corpus, nothing to clean up and
 * no shared fixture for another suite's expectations to collide with. The
 * sources are written as the smallest thing that has the shape under test, with
 * neutral identifiers (`Panel`, `handleApply`, `readValue`): the syntax is the
 * subject, and a name borrowed from an application under test would suggest
 * otherwise.
 *
 * **Part 2 — the whole inventory of one real project**, driven by the committed
 * corpus `packages/code-analysis/test/fixtures/sample-next-app`, opened through
 * the real `openProject` and handed to the extractor through contexts built
 * exactly as `../indexer.ts` builds them. A shape-by-shape suite cannot catch
 * the two regressions that matter most at this level: a declaration form the
 * walk stops reporting *in combination* with others (a type alias beside an
 * exported literal object beside a default-exported component in one `.tsx`
 * file), and a declaration form it starts reporting that no consumer asked for.
 * Both are caught only by asserting **exact per-file sets** — set equality, not
 * containment — so an extra or a missing symbol fails with the file and the
 * name in the message. The same part pins what the rest of the index depends
 * on: one `declares` edge per symbol, from the file node id `./imports.ts`
 * spells, surviving `CodeGraph.fromIndex` without a `dangling-edge`
 * diagnostic; 1-based positions that land on the declaration's identifier;
 * coordinates that parse as a `SourceLocation` with `resolvedBy: 'code-graph'`;
 * and the negative case — a `(file, symbol)` pair the corpus does not hold
 * yields no node, because that is the answer feasibility must get.
 *
 * **Part 3 — an on-disk scratch project** under `os.mkdtemp`, written in
 * `beforeAll` and removed in `afterAll`, for the cases the committed corpus
 * cannot carry without being rewritten for a test: a module that does not
 * parse, an anonymous default export, `export { x as default }`, an overload
 * set beside a same-named method, and the proof that extraction writes nothing.
 * The committed corpus is **read-only** — its paths, sizes and modification
 * times are snapshotted before the first `openProject` and compared in
 * `afterAll`, so a case that ever wrote to it fails here rather than in
 * someone's `git status`.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Project } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  isSafeRelativePath,
  noopLogger,
  parseSourceLocation,
} from '@debuggen/shared';

import { CodeGraph, makeNodeId } from '../graph/graph.js';
import { SYMBOL_DECLARATION_KINDS } from '../graph/types.js';
import type {
  CodeEdge,
  CodeIndex,
  CodeNode,
  CodeNodeOf,
  ExtractorContext,
  IndexDiagnostic,
  SymbolDeclarationKind,
} from '../graph/types.js';
import { buildIndex } from '../indexer.js';
import { openProject } from '../project.js';
import type { LoadedProject } from '../project.js';
import { symbolsExtractor } from './symbols.js';

/* -------------------------------------------------------------------------------------------------
 * Part 1 — in-memory shape cases: harness
 * ---------------------------------------------------------------------------------------------- */

/** The absolute POSIX root every in-memory project in this file declares. */
const PROJECT_ROOT = '/project';

/**
 * The nesting depth `./symbols.ts` documents as its bound
 * (`MAX_DECLARATION_SCOPE_DEPTH`).
 *
 * Restated here rather than imported, because the constant is internal and the
 * bound is a *contract* this suite is the asserting party for: a case at the
 * bound must be recorded and a case one step past it must not, so a change to
 * the constant has to fail here rather than pass silently.
 */
const SCOPE_DEPTH_BOUND = 8;

/**
 * Builds the {@link ExtractorContext} for one in-memory source file.
 *
 * The `LoadedProject` is assembled by hand rather than through `openProject`:
 * that function reads a real directory, and the two members this extractor
 * could reach for (`projectRelative`, `sourceFiles`) are answerable exactly
 * from the one file under test. `tsConfigFilePath` is spelled as `undefined`
 * because the property is required on the interface and the package compiles
 * under `exactOptionalPropertyTypes`.
 *
 * @param file The project-relative POSIX path the node's `file` must carry.
 * @param code The source text.
 * @returns A context over a fresh project holding exactly that file.
 */
function contextFor(file: string, code: string): ExtractorContext {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(`${PROJECT_ROOT}/${file}`, code);
  const loaded: LoadedProject = {
    project,
    projectRoot: PROJECT_ROOT,
    tsConfigFilePath: undefined,
    sourceFiles: () => project.getSourceFiles(),
    projectRelative: (absolutePath: string) =>
      absolutePath.startsWith(`${PROJECT_ROOT}/`)
        ? absolutePath.slice(PROJECT_ROOT.length + 1)
        : undefined,
  };

  // `noopLogger` rather than a recording stub: the extractor never logs — it
  // reports findings as `IndexDiagnostic`s on its result, which is the contract
  // its header states — so there is no log output to assert on.
  return { loaded, sourceFile, file, projectRoot: PROJECT_ROOT, logger: noopLogger };
}

/**
 * Extracts one source file's `symbol` nodes.
 *
 * `ExtractorResult.nodes` is typed as the whole `CodeNode` union, so the kind
 * is narrowed here once instead of at every assertion — every node this
 * extractor emits is a `symbol`, and the filter is what tells the compiler so.
 *
 * @param file The project-relative POSIX path.
 * @param code The source text.
 * @returns The symbol nodes, in the order the extractor emitted them.
 */
function symbolsOf(file: string, code: string): readonly CodeNodeOf<'symbol'>[] {
  return symbolsExtractor
    .extract(contextFor(file, code))
    .nodes.filter((node): node is CodeNodeOf<'symbol'> => node.kind === 'symbol');
}

/**
 * Extracts one source file's whole result, for the cases that assert about
 * edges or diagnostics as well as nodes.
 *
 * @param file The project-relative POSIX path.
 * @param code The source text.
 * @returns The nodes, the edges and any diagnostics.
 */
function resultOf(
  file: string,
  code: string,
): { readonly nodes: readonly CodeNode[]; readonly edges: readonly CodeEdge[] } {
  const result = symbolsExtractor.extract(contextFor(file, code));

  return { nodes: result.nodes, edges: result.edges };
}

/**
 * The one node of a given name, or a readable failure naming what was found.
 *
 * Every case that reaches for a single node goes through here, so a case that
 * accidentally matches two declarations fails with both positions rather than
 * silently asserting about the first.
 *
 * @param nodes The extracted nodes.
 * @param name The declared name to look for.
 * @returns The single matching node.
 */
function only(nodes: readonly CodeNodeOf<'symbol'>[], name: string): CodeNodeOf<'symbol'> {
  const matched = nodes.filter((node) => node.name === name);

  expect(
    matched.map((node) => `${node.name}@${String(node.line)}:${String(node.column)}`),
  ).toHaveLength(1);

  const [first] = matched;

  if (first === undefined) {
    throw new Error(`no symbol node named ${name} was extracted`);
  }

  return first;
}

/** The names of every extracted node, for the "nothing was recorded" cases. */
function namesOf(nodes: readonly CodeNodeOf<'symbol'>[]): readonly string[] {
  return nodes.map((node) => node.name);
}

/**
 * Source for a declaration nested `depth` function bodies deep.
 *
 * Generated rather than written out because the depths that matter are the
 * documented bound and one past it, and eight or nine hand-written nested
 * functions would obscure the one line under test. The innermost body declares
 * `target`; every wrapper is a named function, so the enclosing chain is
 * predictable (`level1` … `levelN`).
 *
 * @param depth How many function bodies `target` sits inside; must be at least
 * `1`.
 * @returns The source text.
 */
function nestedToDepth(depth: number): string {
  const open = Array.from({ length: depth }, (_unused, index) =>
    index === 0 ? `export function level1() {` : `  function level${String(index + 1)}() {`,
  ).join('\n');
  const close = Array.from({ length: depth }, () => '}').join('\n');

  return `${open}\n  function target() { return 1; }\n${close}\n`;
}

/* -------------------------------------------------------------------------------------------------
 * What a nested declaration looks like in the graph
 * ---------------------------------------------------------------------------------------------- */

describe('symbolsExtractor: nested declarations that are recorded', () => {
  it('records a nested function declaration with its enclosing declaration named', () => {
    const nodes = symbolsOf(
      'src/components/Panel.tsx',
      [
        'export function Panel() {',
        '  async function submitPanel() {',
        '    return 1;',
        '  }',
        '',
        '  return submitPanel;',
        '}',
      ].join('\n'),
    );
    const nested = only(nodes, 'submitPanel');

    expect(nested.data?.declaration).toBe('function');
    expect(nested.data?.enclosing).toStrictEqual(['Panel']);
    expect(nested.line).toBe(2);
    expect(nested.file).toBe('src/components/Panel.tsx');
  });

  it('classifies a nested arrow declarator as a function, exactly as module scope does', () => {
    const nodes = symbolsOf(
      'src/components/Panel.tsx',
      [
        'export function Panel() {',
        '  const handleApply = (): void => {',
        '    return;',
        '  };',
        '',
        '  return handleApply;',
        '}',
      ].join('\n'),
    );
    const nested = only(nodes, 'handleApply');

    expect(nested.data?.declaration).toBe('function');
    expect(nested.data?.enclosing).toStrictEqual(['Panel']);
  });

  it('records a nested function expression declarator the same way', () => {
    const nodes = symbolsOf(
      'src/lib/panel.ts',
      [
        'export function panel() {',
        '  const readValue = function () {',
        '    return 2;',
        '  };',
        '',
        '  return readValue;',
        '}',
      ].join('\n'),
    );

    expect(only(nodes, 'readValue').data?.declaration).toBe('function');
  });

  it('unwraps an assertion around a nested initialiser, as the module-scope path does', () => {
    const nodes = symbolsOf(
      'src/lib/panel.ts',
      [
        'type Fn = () => number;',
        '',
        'export function panel() {',
        '  const readValue = ((): number => 3) satisfies Fn;',
        '',
        '  return readValue;',
        '}',
      ].join('\n'),
    );

    expect(only(nodes, 'readValue').data?.declaration).toBe('function');
  });

  it('names every enclosing declaration, outermost first, for a declaration two deep', () => {
    const nodes = symbolsOf(
      'src/components/Panel.tsx',
      [
        'export function Panel() {',
        '  function openRow() {',
        '    function measure() {',
        '      return 4;',
        '    }',
        '',
        '    return measure;',
        '  }',
        '',
        '  return openRow;',
        '}',
      ].join('\n'),
    );

    expect(only(nodes, 'openRow').data?.enclosing).toStrictEqual(['Panel']);
    expect(only(nodes, 'measure').data?.enclosing).toStrictEqual(['Panel', 'openRow']);
  });

  it('names a class and its member in the chain of a declaration inside a method', () => {
    const nodes = symbolsOf(
      'src/lib/store.ts',
      [
        'export class Store {',
        '  load() {',
        '    function decode() {',
        '      return 5;',
        '    }',
        '',
        '    return decode;',
        '  }',
        '}',
      ].join('\n'),
    );

    expect(only(nodes, 'decode').data?.enclosing).toStrictEqual(['Store', 'load']);
  });

  it('reports an empty chain for a declaration whose enclosing scopes are anonymous', () => {
    const nodes = symbolsOf(
      'src/lib/panel.ts',
      [
        'declare const items: readonly number[];',
        '',
        'items.forEach(function () {',
        '  function tally() {',
        '    return 6;',
        '  }',
        '',
        '  tally();',
        '});',
      ].join('\n'),
    );
    const nested = only(nodes, 'tally');

    // `[]` and absence are different answers: this declaration *is* nested, and
    // nothing enclosing it has a name to report.
    expect(nested.data?.enclosing).toStrictEqual([]);
    expect(nested.data).toHaveProperty('enclosing');
  });

  it('records a function declared in a class static block, under the class it belongs to', () => {
    // The instrumentation target resolver descends into a `static { … }` block
    // like any function body, so a declaration there is one it can patch; the
    // graph has to record it for the feasibility gate to agree.
    const nodes = symbolsOf(
      'src/lib/registry.ts',
      [
        'export class Registry {',
        '  static {',
        '    function boot() {',
        '      return 8;',
        '    }',
        '',
        '    boot();',
        '  }',
        '}',
      ].join('\n'),
    );

    // The block has no name of its own and nothing that holds it names it, so
    // the chain stops at the class.
    expect(only(nodes, 'boot').data?.enclosing).toStrictEqual(['Registry']);
  });

  it('records a nested declaration inside a block, not only at the top of a body', () => {
    const nodes = symbolsOf(
      'src/lib/panel.ts',
      [
        'export function panel(ready: boolean) {',
        '  if (ready) {',
        '    function commit() {',
        '      return 7;',
        '    }',
        '',
        '    return commit();',
        '  }',
        '',
        '  return 0;',
        '}',
      ].join('\n'),
    );

    expect(only(nodes, 'commit').data?.enclosing).toStrictEqual(['panel']);
  });

  it('carries no CodeNodeBase.symbol on a nested node, so it is never a call target', () => {
    const nodes = symbolsOf(
      'src/components/Panel.tsx',
      ['export function Panel() {', '  function submitPanel() {', '    return 8;', '  }', '}'].join(
        '\n',
      ),
    );
    const nested = only(nodes, 'submitPanel');

    // `../graph/query.ts`'s `nodeBearsSymbol` matches this field, and a nested
    // helper must not answer for the function it happens to sit inside.
    expect(nested).not.toHaveProperty('symbol');
  });

  it('anchors a nested node to its file with a declares edge, like every other symbol', () => {
    const file = 'src/components/Panel.tsx';
    const { nodes, edges } = resultOf(
      file,
      ['export function Panel() {', '  function submitPanel() {', '    return 9;', '  }', '}'].join(
        '\n',
      ),
    );
    const nested = nodes.find((node) => node.name === 'submitPanel');
    const fileNodeId = makeNodeId({ kind: 'file', file, name: file, line: 1, column: 1 });

    expect(nested).toBeDefined();
    expect(
      edges.some(
        (edge) => edge.kind === 'declares' && edge.from === fileNodeId && edge.to === nested?.id,
      ),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * What must never become a node
 * ---------------------------------------------------------------------------------------------- */

describe('symbolsExtractor: nested forms that declare no addressable function', () => {
  it('records nothing for a nested declarator initialised from a call', () => {
    const nodes = symbolsOf(
      'src/components/Panel.tsx',
      [
        'declare function useSomething<T>(value: T, deps: readonly unknown[]): T;',
        '',
        'export function Panel() {',
        '  const handleApply = useSomething(() => undefined, []);',
        '',
        '  return handleApply;',
        '}',
      ].join('\n'),
    );

    // The body the call returns is not written at this declarator, so there is
    // nothing here for a patch to wrap.
    expect(namesOf(nodes)).not.toContain('handleApply');
  });

  it('records nothing for a nested destructured binding', () => {
    const nodes = symbolsOf(
      'src/components/Panel.tsx',
      [
        'interface Props {',
        '  readonly open: boolean;',
        '  readonly onClose: () => void;',
        '}',
        '',
        'export function Panel(props: Props) {',
        '  const { open, onClose } = props;',
        '',
        '  return open ? onClose : undefined;',
        '}',
      ].join('\n'),
    );

    expect(namesOf(nodes)).not.toContain('onClose');
    expect(namesOf(nodes)).not.toContain('open');
  });

  it('records nothing for a nested array-pattern binding', () => {
    const nodes = symbolsOf(
      'src/components/Panel.tsx',
      [
        'declare function useState<T>(initial: T): readonly [T, (next: T) => void];',
        '',
        'export function Panel() {',
        '  const [draft, setDraft] = useState("");',
        '',
        '  return draft.length === 0 ? setDraft : undefined;',
        '}',
      ].join('\n'),
    );

    expect(namesOf(nodes)).not.toContain('setDraft');
    expect(namesOf(nodes)).not.toContain('draft');
  });

  it('records nothing for a parameter, including a destructured prop', () => {
    const nodes = symbolsOf(
      'src/components/Row.tsx',
      [
        'interface RowProps {',
        '  readonly onPick: () => void;',
        '}',
        '',
        'export function Row({ onPick }: RowProps) {',
        '  return onPick;',
        '}',
        '',
        'export function Cell(onDrop: () => void) {',
        '  return onDrop;',
        '}',
      ].join('\n'),
    );

    expect(namesOf(nodes)).not.toContain('onPick');
    expect(namesOf(nodes)).not.toContain('onDrop');
  });

  it('records nothing for an object-literal property or method', () => {
    const nodes = symbolsOf(
      'src/lib/panel.ts',
      [
        'export function panel() {',
        '  const handlers = {',
        '    onPick: () => undefined,',
        '    onDrop() {',
        '      return 10;',
        '    },',
        '  };',
        '',
        '  return handlers;',
        '}',
      ].join('\n'),
    );

    // `handlers` itself is nested and holds an object literal rather than a
    // written function, so it is not recorded either — only the module-level
    // declaration is.
    expect(namesOf(nodes)).toStrictEqual(['panel']);
  });

  it('records nothing for a member of a class declared inside a function body', () => {
    const nodes = symbolsOf(
      'src/lib/panel.ts',
      [
        'export function panel() {',
        '  class Local {',
        '    work() {',
        '      return 11;',
        '    }',
        '  }',
        '',
        '  return new Local();',
        '}',
      ].join('\n'),
    );

    // Neither the nested class nor its member is reachable from outside the
    // body, and neither is one of the two nested forms that declare a function.
    expect(namesOf(nodes)).toStrictEqual(['panel']);
  });

  it('records nothing for a nested type-level declaration', () => {
    const nodes = symbolsOf(
      'src/lib/panel.ts',
      [
        'export function panel() {',
        '  type Local = { readonly value: number };',
        '  interface Shape {',
        '    readonly value: number;',
        '  }',
        '',
        '  const shape: Local & Shape = { value: 12 };',
        '',
        '  return shape;',
        '}',
      ].join('\n'),
    );

    expect(namesOf(nodes)).toStrictEqual(['panel']);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Export status, identity, ordering and the depth bound
 * ---------------------------------------------------------------------------------------------- */

describe('symbolsExtractor: the properties the index depends on', () => {
  it('never lets an export clause mark a nested declaration exported', () => {
    const nodes = symbolsOf(
      'src/lib/panel.ts',
      [
        'export function panel() {',
        '  function submitPanel() {',
        '    return 13;',
        '  }',
        '',
        '  return submitPanel;',
        '}',
        '',
        'const submitPanel = 1;',
        '',
        'export { submitPanel };',
      ].join('\n'),
    );
    const nested = only(
      nodes.filter((node) => node.data?.enclosing !== undefined),
      'submitPanel',
    );
    const moduleLevel = only(
      nodes.filter((node) => node.data?.enclosing === undefined && node.name === 'submitPanel'),
      'submitPanel',
    );

    // The clause names the module-level binding; the nested declaration merely
    // shares its spelling and cannot leave the function it is in.
    expect(nested.exported).toBe(false);
    expect(moduleLevel.exported).toBe(true);
  });

  it('gives two nested declarations of one name two distinct node ids', () => {
    const nodes = symbolsOf(
      'src/components/Panel.tsx',
      [
        'export function Panel() {',
        '  function apply() {',
        '    return 14;',
        '  }',
        '',
        '  return apply;',
        '}',
        '',
        'export function Sidebar() {',
        '  function apply() {',
        '    return 15;',
        '  }',
        '',
        '  return apply;',
        '}',
      ].join('\n'),
    );
    const applies = nodes.filter((node) => node.name === 'apply');

    expect(applies).toHaveLength(2);
    expect(new Set(applies.map((node) => node.id)).size).toBe(2);
    expect(applies.map((node) => node.data?.enclosing)).toStrictEqual([['Panel'], ['Sidebar']]);
  });

  it('emits nodes in source order, nested declarations included', () => {
    const nodes = symbolsOf(
      'src/lib/panel.ts',
      [
        'export function panel() {',
        '  function first() {',
        '    return 16;',
        '  }',
        '',
        '  function second() {',
        '    return 17;',
        '  }',
        '',
        '  return [first, second];',
        '}',
        '',
        'export const tail = 1;',
      ].join('\n'),
    );

    expect(namesOf(nodes)).toStrictEqual(['panel', 'first', 'second', 'tail']);
  });

  it('emits identical nodes on two runs over unchanged source', () => {
    const file = 'src/components/Panel.tsx';
    const code = [
      'export function Panel() {',
      '  function submitPanel() {',
      '    return 18;',
      '  }',
      '',
      '  const handleApply = () => submitPanel();',
      '',
      '  return handleApply;',
      '}',
    ].join('\n');

    expect(JSON.stringify(symbolsOf(file, code))).toBe(JSON.stringify(symbolsOf(file, code)));
  });

  it('records a declaration at the documented depth bound', () => {
    const nodes = symbolsOf('src/lib/deep.ts', nestedToDepth(SCOPE_DEPTH_BOUND));
    const deepest = only(nodes, 'target');

    expect(deepest.data?.enclosing).toHaveLength(SCOPE_DEPTH_BOUND);
    expect(deepest.data?.enclosing?.[0]).toBe('level1');
  });

  it('records nothing past the documented depth bound', () => {
    const nodes = symbolsOf('src/lib/deep.ts', nestedToDepth(SCOPE_DEPTH_BOUND + 1));

    // The walk stops descending rather than recording a declaration nothing
    // would address; everything above the bound is still recorded.
    expect(namesOf(nodes)).not.toContain('target');
    expect(namesOf(nodes)).toContain(`level${String(SCOPE_DEPTH_BOUND)}`);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Module scope is unchanged
 * ---------------------------------------------------------------------------------------------- */

describe('symbolsExtractor: module-level and class-member behaviour is unchanged', () => {
  it('reports no enclosing chain for a module-level declaration', () => {
    const nodes = symbolsOf(
      'src/lib/panel.ts',
      [
        'export function panel() {',
        '  return 19;',
        '}',
        '',
        'export const rows = [1, 2];',
        '',
        'export const render = () => 20;',
      ].join('\n'),
    );

    for (const name of ['panel', 'rows', 'render']) {
      const node = only(nodes, name);

      expect(node.data).not.toHaveProperty('enclosing');
      expect(node.exported).toBe(true);
    }

    expect(only(nodes, 'rows').data?.declaration).toBe('variable');
    expect(only(nodes, 'render').data?.declaration).toBe('function');
  });

  it('keeps a class member on its class, with no enclosing chain', () => {
    const nodes = symbolsOf(
      'src/lib/store.ts',
      ['export class Store {', '  load() {', '    return 21;', '  }', '}'].join('\n'),
    );
    const member = only(nodes, 'load');

    expect(member.symbol).toBe('Store');
    expect(member.data).not.toHaveProperty('enclosing');
    expect(member.data?.declaration).toBe('method');
  });

  it('still records a module-level destructured binding, which another module can import', () => {
    const nodes = symbolsOf(
      'src/lib/config.ts',
      [
        'declare const source: { readonly a: number; readonly b: number };',
        '',
        'export const { a, b } = source;',
      ].join('\n'),
    );

    expect(namesOf(nodes)).toStrictEqual(['source', 'a', 'b']);
    expect(only(nodes, 'a').data).not.toHaveProperty('enclosing');
  });

  it('records a route module handler at module scope, as findSymbol(file, GET) needs', () => {
    const nodes = symbolsOf(
      'app/api/items/route.ts',
      [
        'export async function GET(): Promise<Response> {',
        '  return new Response("[]");',
        '}',
      ].join('\n'),
    );
    const handler = only(nodes, 'GET');

    expect(handler.exported).toBe(true);
    expect(handler.data?.declaration).toBe('function');
    expect(handler.data).not.toHaveProperty('enclosing');
  });
});

/* -------------------------------------------------------------------------------------------------
 * Part 2 — the committed corpus: harness
 * ---------------------------------------------------------------------------------------------- */

/**
 * The committed indexing corpus, resolved from this file rather than from the
 * working directory so the suite runs the same from the package and from the
 * workspace root.
 *
 * Read-only: nothing below opens it for writing, and
 * {@link expectCorpusUntouched} proves it.
 */
const FIXTURE_ROOT = fileURLToPath(new URL('../../test/fixtures/sample-next-app', import.meta.url));

/** The declaration facts this suite pins per symbol, and the whole of them. */
interface SymbolFacts {
  /** The declared identifier, or `'default'` for a truly anonymous default export. */
  readonly name: string;
  /** The classification, from `SYMBOL_DECLARATION_KINDS`. */
  readonly declaration: SymbolDeclarationKind;
  /** Whether the declaration leaves its module. */
  readonly exported: boolean;
  /** Whether it is the module's default export. */
  readonly isDefaultExport: boolean;
  /**
   * The owning class of a member, from `CodeNodeBase.symbol`, or `undefined`
   * for a module-level declaration.
   *
   * Always spelled, in expectations as well as in readings, because
   * `toStrictEqual` distinguishes an absent key from a present `undefined` one
   * and the two would otherwise disagree for every module-level symbol.
   */
  readonly container: string | undefined;
}

/** A module-level declaration this module keeps to itself. */
function localSymbol(name: string, declaration: SymbolDeclarationKind): SymbolFacts {
  return { name, declaration, exported: false, isDefaultExport: false, container: undefined };
}

/** A module-level declaration another module can import by name. */
function exportedSymbol(name: string, declaration: SymbolDeclarationKind): SymbolFacts {
  return { name, declaration, exported: true, isDefaultExport: false, container: undefined };
}

/**
 * The module's default export, under the name it declares.
 *
 * The shape an instrumentation `server-span` action names for a legacy
 * `pages/api` module: `(file, 'handler')`, not `(file, 'default')`.
 */
function defaultSymbol(name: string, declaration: SymbolDeclarationKind): SymbolFacts {
  return { name, declaration, exported: true, isDefaultExport: true, container: undefined };
}

/**
 * A class member, recorded under its own name with its class in `container`.
 *
 * `exported` follows the class: a member of an exported class is reachable from
 * outside the module, and the extractor records that rather than re-deriving it
 * per member.
 */
function memberSymbol(
  name: string,
  declaration: SymbolDeclarationKind,
  container: string,
): SymbolFacts {
  return { name, declaration, exported: true, isDefaultExport: false, container };
}

/**
 * The exact symbol inventory of every indexable module of the corpus, in the
 * order the extractor emits it (source order).
 *
 * Derived by reading the committed fixture, and asserted as **set equality per
 * file**: an extra symbol and a missing one both fail, which is what keeps the
 * deliberately mixed shapes of the corpus honest — two method exports in one
 * route module, a default-exported legacy handler, a component module with a
 * pure formatter beside it, a layout with an exported literal object and a
 * local type alias, and stub classes whose members are the driver surface
 * `./db-calls.ts` matches.
 *
 * Four absences are as load-bearing as the entries, and each is asserted by its
 * own case below as well as by this table: the barrel declares nothing; the
 * memoised widget's click handler is a `useCallback` result and not a
 * declaration; the awaited route parameters are binding-pattern elements; and
 * no parameter of any handler appears anywhere.
 *
 * `next.config.mjs` is in the table because `openProject` loads it — the corpus
 * is a project, not a source directory — and leaving it out would make the
 * file-set guard below fail for a reason that has nothing to do with symbols.
 */
const CORPUS_SYMBOLS: readonly (readonly [file: string, symbols: readonly SymbolFacts[]])[] = [
  // A route group and a catch-all parameter above one handler; the reply body
  // type stays local because nothing crosses the HTTP boundary as a type.
  [
    'app/(observatory)/api/basins/[...segments]/route.ts',
    [localSymbol('BasinDriftReport', 'interface'), exportedSymbol('GET', 'function')],
  ],
  // The grouped dynamic page: a default-exported component plus its local props
  // type, in a `.tsx` module.
  [
    'app/(observatory)/basins/[id]/page.tsx',
    [
      localSymbol('BasinDetailPageProps', 'interface'),
      defaultSymbol('BasinDetailPage', 'function'),
    ],
  ],
  // The dynamic-segment handler module: one exported method and its local
  // payload type.
  [
    'app/api/gauges/[id]/route.ts',
    [localSymbol('GaugeDetailPayload', 'interface'), exportedSymbol('GET', 'function')],
  ],
  // The corpus' only module exporting two HTTP methods. `findSymbol` must
  // answer for both, which is why neither may collapse into the other.
  //
  // Both are `async`, which this node kind deliberately does not record:
  // `SymbolNodeData` classifies by declaration *form*, and async-ness is
  // carried by `./server-functions.ts`'s richer node beside it (and read from
  // there by `CodeSymbolMatch.isAsync`). A `symbol` node that claimed it would
  // be a second, unsynchronised source of the same fact.
  [
    'app/api/gauges/route.ts',
    [
      localSymbol('GaugeReadingPayload', 'interface'),
      exportedSymbol('GET', 'function'),
      exportedSymbol('POST', 'function'),
    ],
  ],
  // One `.tsx` file yielding all three kinds: a local type alias, an exported
  // non-function const holding a literal object, and a default-exported
  // component.
  [
    'app/layout.tsx',
    [
      localSymbol('ObservatoryLayoutProps', 'type'),
      exportedSymbol('metadata', 'variable'),
      defaultSymbol('ObservatoryLayout', 'function'),
    ],
  ],
  ['app/page.tsx', [defaultSymbol('BasinIndexPage', 'function')]],
  // A configuration module is source too: the const is the default export, and
  // the name it declares is the name the node carries.
  ['next.config.mjs', [defaultSymbol('nextConfig', 'variable')]],
  // The legacy Pages Router shape: the default export *is* the route, and it is
  // findable by its declared name.
  ['pages/api/gauge-log.ts', [defaultSymbol('handler', 'function')]],
  // Two exported consts, each initialised from a construction: value consts,
  // not function consts, because no function body is written at either.
  [
    'src/lib/datastore.ts',
    [exportedSymbol('prisma', 'variable'), exportedSymbol('pool', 'variable')],
  ],
  [
    'src/lib/http.ts',
    [exportedSymbol('GaugeIndexEntry', 'interface'), exportedSymbol('fetchGaugeIndex', 'function')],
  ],
  // The server layer: three exported async functions, two local row types.
  [
    'src/lib/station-service.ts',
    [
      localSymbol('GaugeReadingInput', 'interface'),
      localSymbol('BasinDriftRow', 'interface'),
      exportedSymbol('listBasinGauges', 'function'),
      exportedSymbol('recordGaugeReading', 'function'),
      exportedSymbol('summarizeBasin', 'function'),
    ],
  ],
  // A driver stub: the exported class *and* its members as separate nodes, each
  // naming its owning class, plus the generic result type. The object literal
  // returned by `connect()` contributes nothing — its `query` and `release` are
  // properties of a nested literal, not declarations.
  [
    'src/lib/stubs/pg.ts',
    [
      exportedSymbol('QueryResult', 'interface'),
      exportedSymbol('PoolConfig', 'interface'),
      exportedSymbol('PoolClient', 'interface'),
      exportedSymbol('Pool', 'class'),
      memberSymbol('options', 'property', 'Pool'),
      memberSymbol('constructor', 'method', 'Pool'),
      memberSymbol('query', 'method', 'Pool'),
      memberSymbol('connect', 'method', 'Pool'),
      memberSymbol('end', 'method', 'Pool'),
    ],
  ],
  // The other driver stub: delegates are instance properties rather than
  // prototype methods, and the constructor's parameter property is a member in
  // its own right, recorded at the parameter's position.
  [
    'src/lib/stubs/prisma-client.ts',
    [
      exportedSymbol('GaugeRow', 'interface'),
      exportedSymbol('ReadingRow', 'interface'),
      exportedSymbol('FindManyArgs', 'interface'),
      exportedSymbol('CreateArgs', 'interface'),
      exportedSymbol('GaugeDelegate', 'interface'),
      exportedSymbol('ReadingDelegate', 'interface'),
      exportedSymbol('PrismaClientOptions', 'interface'),
      exportedSymbol('PrismaClient', 'class'),
      memberSymbol('gauge', 'property', 'PrismaClient'),
      memberSymbol('reading', 'property', 'PrismaClient'),
      memberSymbol('constructor', 'method', 'PrismaClient'),
      memberSymbol('options', 'property', 'PrismaClient'),
      memberSymbol('$disconnect', 'method', 'PrismaClient'),
    ],
  ],
  // The server half of the widget pair: a default-exported component, exactly
  // one named non-component export (a pure formatter), and the exported props
  // type.
  [
    'src/widgets/BasinSummary.tsx',
    [
      exportedSymbol('BasinSummaryProps', 'interface'),
      exportedSymbol('formatGaugeCount', 'function'),
      defaultSymbol('BasinSummary', 'function'),
    ],
  ],
  // The client half: a named component export with its exported props type,
  // then the memoised pair appended below it — an unexported implementation, an
  // exported const holding a `memo(...)` call (a value const, because the call
  // is not a written function), and the parent that renders it. The component
  // body's `useState` tuples and its `useCallback` handler contribute nothing.
  [
    'src/widgets/GaugeReadout.tsx',
    [
      exportedSymbol('GaugeReadoutProps', 'interface'),
      exportedSymbol('GaugeReadout', 'function'),
      localSymbol('GaugeTrendProps', 'interface'),
      localSymbol('GaugeTrendBody', 'function'),
      exportedSymbol('GaugeTrend', 'variable'),
      exportedSymbol('GaugeTrendPanel', 'function'),
    ],
  ],
  // The barrel declares nothing at all: its four re-exports are `./imports.ts`'s
  // finding, and a symbol node here would claim this module holds a body it
  // does not.
  ['src/widgets/index.ts', []],
];

/** One corpus module's extraction, kept by project-relative path. */
interface CorpusFile {
  /** The opened source file, for the position and identifier reads. */
  readonly sourceFile: SourceFile;
  /** Every `symbol` node the extractor emitted for it, in emission order. */
  readonly nodes: readonly CodeNodeOf<'symbol'>[];
  /** Every edge it emitted for it — all `declares`, by this extractor's contract. */
  readonly edges: readonly CodeEdge[];
  /** Anything the extractor reported about it; empty for a clean file. */
  readonly diagnostics: readonly IndexDiagnostic[];
}

/** What {@link beforeAll} prepares once for every corpus case. */
interface Corpus {
  /** The opened project. */
  readonly loaded: LoadedProject;
  /** Extraction, by project-relative POSIX path. */
  readonly files: ReadonlyMap<string, CorpusFile>;
  /** The whole index, built by the real pipeline over the same project. */
  readonly index: CodeIndex;
  /** The graph assembled from that index. */
  readonly graph: CodeGraph;
}

/** One entry of the corpus integrity snapshot. */
interface FileStamp {
  /** Path relative to {@link FIXTURE_ROOT}, POSIX separators. */
  readonly path: string;
  /** Size in bytes. */
  readonly size: number;
  /** Modification time in epoch milliseconds. */
  readonly modifiedAt: number;
}

/**
 * Every file of a tree with its size and modification time, sorted by path.
 *
 * Used twice: once over the committed corpus, to prove the suite never wrote to
 * it, and once over the scratch project of Part 3, to prove `extract` writes
 * nothing. `recursive: true` needs Node 20 or later, which the repository pins
 * well past.
 *
 * @param root The directory to stamp.
 * @returns The stamps, sorted by path.
 */
function stampTree(root: string): readonly FileStamp[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      const stats = statSync(absolute);

      return {
        path: absolute
          .slice(root.length + 1)
          .split('\\')
          .join('/'),
        size: stats.size,
        modifiedAt: stats.mtimeMs,
      };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Builds the {@link ExtractorContext} for one file of an opened project,
 * exactly as `../indexer.ts` does at its extraction loop: the same five fields,
 * the project-relative path from `LoadedProject.projectRelative`, and the
 * project's own root.
 *
 * Spelled out rather than routed through `buildIndex` because these cases are
 * about *this* extractor's output: `buildIndex` runs every extractor and hands
 * back the graph's canonical view, where another extractor's node could mask a
 * missing one of ours. The index is built too, once, for the assembly
 * assertions.
 *
 * @param loaded The opened project.
 * @param sourceFile One of its source files.
 * @param file The project-relative POSIX path of that file.
 * @returns The context to hand the extractor.
 */
function corpusContext(
  loaded: LoadedProject,
  sourceFile: SourceFile,
  file: string,
): ExtractorContext {
  return { loaded, sourceFile, file, projectRoot: loaded.projectRoot, logger: noopLogger };
}

/**
 * Opens the corpus, extracts every file and builds the index once.
 *
 * @returns The prepared corpus.
 */
async function prepareCorpus(): Promise<Corpus> {
  const opened = openProject({ projectRoot: FIXTURE_ROOT });

  if (!opened.ok) {
    throw new Error(`the committed corpus did not open: ${opened.error.message}`);
  }

  const loaded = opened.value;
  const files = new Map<string, CorpusFile>();

  for (const sourceFile of loaded.sourceFiles()) {
    const file = loaded.projectRelative(sourceFile.getFilePath().split('\\').join('/'));

    if (file === undefined) {
      throw new Error(`a corpus file resolved outside the project: ${sourceFile.getFilePath()}`);
    }

    const result = symbolsExtractor.extract(corpusContext(loaded, sourceFile, file));

    files.set(file, {
      sourceFile,
      nodes: result.nodes.filter((node): node is CodeNodeOf<'symbol'> => node.kind === 'symbol'),
      edges: result.edges,
      diagnostics: result.diagnostics ?? [],
    });
  }

  const built = await buildIndex(loaded);

  if (!built.ok) {
    throw new Error(`indexing the committed corpus failed: ${built.error.message}`);
  }

  return { loaded, files, index: built.value, graph: CodeGraph.fromIndex(built.value) };
}

/**
 * The extraction of one indexed module, or a failure naming the path and what
 * the project does hold.
 *
 * Takes the map holder rather than the whole {@link Corpus} so the scratch
 * project of Part 3 reads through the same helper: both prepare the same
 * per-file shape, and a second lookup helper would be a second place for the
 * "no such file" message to be worse.
 *
 * @param project A prepared project with its per-file extraction.
 * @param file The project-relative POSIX path.
 * @returns That file's extraction.
 */
function indexedFile(
  project: { readonly files: ReadonlyMap<string, CorpusFile> },
  file: string,
): CorpusFile {
  const found = project.files.get(file);

  if (found === undefined) {
    throw new Error(
      `no indexed file at ${file}; the project holds ${[...project.files.keys()].join(', ')}`,
    );
  }

  return found;
}

/**
 * Reads the facts this suite pins off one node.
 *
 * @param node The extracted node.
 * @returns Its declaration facts.
 */
function factsOf(node: CodeNodeOf<'symbol'>): SymbolFacts {
  return {
    name: node.name,
    declaration: node.data?.declaration ?? 'unknown',
    exported: node.exported ?? false,
    isDefaultExport: node.data?.isDefaultExport ?? false,
    container: node.symbol,
  };
}

/**
 * The 1-based position of one identifier, located in the file text rather than
 * written down.
 *
 * Line numbers are never hard-coded in this suite: the corpus' modules carry
 * long headers, and a hard-coded line would make an added comment look like an
 * extractor regression. So the identifier is found through an anchor — a short
 * span of source text that must occur exactly once — and the offset is
 * converted by the same `getLineAndColumnAtPos` the extractor's own position
 * reader uses, which is what makes the comparison a statement about the
 * extractor and not about ts-morph.
 *
 * @param sourceFile The file to read.
 * @param anchor A span of its text containing the identifier, unique in the file.
 * @param identifier The identifier inside that span.
 * @returns The identifier's 1-based line and column.
 */
function positionOfIdentifier(
  sourceFile: SourceFile,
  anchor: string,
  identifier: string,
): { readonly line: number; readonly column: number } {
  const text = sourceFile.getFullText();
  const first = text.indexOf(anchor);

  if (first === -1) {
    throw new Error(
      `the anchor ${JSON.stringify(anchor)} is absent from ${sourceFile.getBaseName()}`,
    );
  }

  if (text.indexOf(anchor, first + 1) !== -1) {
    throw new Error(
      `the anchor ${JSON.stringify(anchor)} occurs more than once in ${sourceFile.getBaseName()}`,
    );
  }

  const withinAnchor = anchor.indexOf(identifier);

  if (withinAnchor === -1) {
    throw new Error(`${identifier} is not part of the anchor ${JSON.stringify(anchor)}`);
  }

  return sourceFile.getLineAndColumnAtPos(first + withinAnchor);
}

/**
 * The id of a file node, derived exactly as `./symbols.ts` and `./imports.ts`
 * derive it.
 *
 * Derived rather than spelled out because `../graph/graph.ts` documents that no
 * consumer may parse or hand-write a node id, and a test that wrote one out
 * would be the first to do so — and would keep passing if the two extractors
 * ever disagreed about the convention, which is the failure this assertion
 * exists to catch.
 *
 * @param file The project-relative POSIX path.
 * @returns The file node's id.
 */
function fileNodeIdOf(file: string): string {
  return makeNodeId({ kind: 'file', file, name: file, line: 1, column: 1 });
}

/* -------------------------------------------------------------------------------------------------
 * Part 2 — the committed corpus: cases
 * ---------------------------------------------------------------------------------------------- */

describe('symbolsExtractor over the committed corpus', () => {
  let corpus: Corpus;
  let stampsBefore: readonly FileStamp[];

  // A 30 s ceiling, not a budget: this hook parses a program, which a loaded
  // machine can push past the 10 s hook default and so fail every case below.
  beforeAll(async () => {
    // Stamped before the project is opened, so anything the suite did to the
    // corpus — including anything `openProject` itself did — shows up.
    stampsBefore = stampTree(FIXTURE_ROOT);
    corpus = await prepareCorpus();
  }, 30_000);

  afterAll(() => {
    // The corpus is an input, not a workspace. A case that wrote to it would
    // otherwise surface as an unexplained `git status` entry in someone else's
    // run.
    expect(stampTree(FIXTURE_ROOT)).toStrictEqual(stampsBefore);
  });

  describe('per-file symbol inventories', () => {
    it('opens the corpus and indexes exactly the modules this table describes', () => {
      // A file-set guard rather than a formality: a module added to the corpus
      // for another suite's sake would otherwise silently escape the exact-set
      // assertions below, which are the only place an extra symbol is caught.
      expect([...corpus.files.keys()].sort()).toStrictEqual(
        CORPUS_SYMBOLS.map(([file]) => file).sort(),
      );
    });

    for (const [file, expected] of CORPUS_SYMBOLS) {
      it(`records exactly ${String(expected.length)} symbol(s) for ${file}`, () => {
        const { nodes, diagnostics } = indexedFile(corpus, file);

        // Names first: a missing or extra symbol is then reported as a
        // one-entry difference naming it, rather than as a diff over whole
        // records.
        expect(nodes.map((node) => node.name)).toStrictEqual(expected.map((symbol) => symbol.name));
        expect(nodes.map(factsOf)).toStrictEqual([...expected]);
        // Every module of the corpus is well-formed, so a finding here means
        // the extractor could not read a construct it is expected to classify.
        expect(diagnostics).toStrictEqual([]);
      });
    }

    it('classifies every symbol of the corpus within the declared vocabulary', () => {
      const kinds = [
        ...new Set(
          [...corpus.files.values()].flatMap((entry) =>
            entry.nodes.map((node) => node.data?.declaration),
          ),
        ),
      ].sort();

      // Not a tautology: `SymbolDeclarationKind` is a union of string literals,
      // so a classifier returning a value outside it type-checks wherever the
      // value is widened, and this is what fails when it does.
      for (const kind of kinds) {
        expect(SYMBOL_DECLARATION_KINDS).toContain(kind);
      }

      // The corpus is chosen to cover the seven kinds a supported project
      // produces; `enum` and `unknown` have no instance in it, which is why the
      // list is spelled rather than compared to the whole vocabulary.
      expect(kinds).toStrictEqual([
        'class',
        'function',
        'interface',
        'method',
        'property',
        'type',
        'variable',
      ]);
    });

    it('records no symbol for the barrel, whose re-exports belong to the imports extractor', () => {
      const barrel = indexedFile(corpus, 'src/widgets/index.ts');

      expect(barrel.nodes).toStrictEqual([]);
      expect(barrel.edges).toStrictEqual([]);
    });

    it('records no symbol for the memoised widget’s click handler, a useCallback result', () => {
      const widget = indexedFile(corpus, 'src/widgets/GaugeReadout.tsx');
      const names = widget.nodes.map((node) => node.name);

      // The committed fixture declares `handleReadoutClick` *inside* the
      // component body, initialised from a hook call. A nested declarator whose
      // initialiser is not a written function declares no body this file holds,
      // so it is `./event-handlers.ts`'s finding (a binding site) and never a
      // symbol the patcher could wrap. The state tuples are binding-pattern
      // elements, which are excluded for the same reason.
      expect(names).not.toContain('handleReadoutClick');
      expect(names).not.toContain('latestReading');
      expect(names).not.toContain('setLatestReading');
      expect(names).not.toContain('indexSize');
    });

    it('records no symbol for a route parameter or an awaited destructured segment', () => {
      const dynamicRoute = indexedFile(corpus, 'app/api/gauges/[id]/route.ts');
      const groupedPage = indexedFile(corpus, 'app/(observatory)/basins/[id]/page.tsx');
      const catchAll = indexedFile(corpus, 'app/(observatory)/api/basins/[...segments]/route.ts');

      for (const name of ['request', '_request', 'params', 'context', 'id', 'segments']) {
        expect(dynamicRoute.nodes.map((node) => node.name)).not.toContain(name);
        expect(groupedPage.nodes.map((node) => node.name)).not.toContain(name);
        expect(catchAll.nodes.map((node) => node.name)).not.toContain(name);
      }
    });

    it('keeps a default-exported handler findable by its declared name', () => {
      const legacy = indexedFile(corpus, 'pages/api/gauge-log.ts');
      const handler = only(legacy.nodes, 'handler');

      // This is the pair an instrumentation `server-span` action names for a
      // legacy API module. Recording it as `default` would make that action
      // unfeasible even though the declaration is right there.
      expect(handler.data?.isDefaultExport).toBe(true);
      expect(handler.exported).toBe(true);
      expect(handler.data?.declaration).toBe('function');
      expect(legacy.nodes.map((node) => node.name)).not.toContain('default');
    });

    it('records both driver-handle consts as value consts, not function consts', () => {
      const datastore = indexedFile(corpus, 'src/lib/datastore.ts');

      // Each is initialised from a construction. Classifying either as a
      // `function` would offer the patcher a body to wrap that is not written
      // here at all.
      expect(only(datastore.nodes, 'prisma').data?.declaration).toBe('variable');
      expect(only(datastore.nodes, 'pool').data?.declaration).toBe('variable');
    });

    it('records class methods as separate symbols naming their owning class', () => {
      const stub = indexedFile(corpus, 'src/lib/stubs/pg.ts');
      const query = only(stub.nodes, 'query');
      const release = stub.nodes.filter((node) => node.name === 'release');

      expect(query.symbol).toBe('Pool');
      expect(query.data?.declaration).toBe('method');
      // A class member is reachable through its class, so it carries no
      // enclosing chain — the field that marks a declaration as nested.
      expect(query.data).not.toHaveProperty('enclosing');
      // `release` exists only as a property of the object literal `connect()`
      // returns, which declares nothing addressable.
      expect(release).toStrictEqual([]);
    });
  });

  describe('positions and source locations', () => {
    it('points at the identifier of a function declaration, 1-based on both axes', () => {
      const route = indexedFile(corpus, 'app/api/gauges/route.ts');
      const post = only(route.nodes, 'POST');
      const expected = positionOfIdentifier(
        route.sourceFile,
        'export async function POST(request: Request)',
        'POST',
      );

      expect({ line: post.line, column: post.column }).toStrictEqual(expected);
      expect(post.endLine).toBeGreaterThanOrEqual(post.line);
    });

    it('points at the identifier of an exported const and of a local type alias', () => {
      const layout = indexedFile(corpus, 'app/layout.tsx');
      const metadata = only(layout.nodes, 'metadata');
      const props = only(layout.nodes, 'ObservatoryLayoutProps');

      expect({ line: metadata.line, column: metadata.column }).toStrictEqual(
        positionOfIdentifier(layout.sourceFile, 'export const metadata = {', 'metadata'),
      );
      expect({ line: props.line, column: props.column }).toStrictEqual(
        positionOfIdentifier(
          layout.sourceFile,
          'type ObservatoryLayoutProps = {',
          'ObservatoryLayoutProps',
        ),
      );
    });

    it('points at the identifier of a default-exported component and of a class member', () => {
      const widget = indexedFile(corpus, 'src/widgets/BasinSummary.tsx');
      const component = only(widget.nodes, 'BasinSummary');
      const stub = indexedFile(corpus, 'src/lib/stubs/prisma-client.ts');
      const disconnect = only(stub.nodes, '$disconnect');

      expect({ line: component.line, column: component.column }).toStrictEqual(
        positionOfIdentifier(
          widget.sourceFile,
          'export default function BasinSummary(props: BasinSummaryProps)',
          'BasinSummary',
        ),
      );
      expect({ line: disconnect.line, column: disconnect.column }).toStrictEqual(
        positionOfIdentifier(stub.sourceFile, '$disconnect(): Promise<void>', '$disconnect'),
      );
    });

    it('lands on its own name for every symbol of the corpus', () => {
      for (const [file, entry] of corpus.files) {
        for (const node of entry.nodes) {
          const offset = entry.sourceFile.compilerNode.getPositionOfLineAndCharacter(
            node.line - 1,
            node.column - 1,
          );

          // The general form of the three cases above, over all of it: convert
          // the recorded position back to an offset and read the name off the
          // text there. A position one token off — the `export` keyword, the
          // opening brace, the whole statement — fails here with the file, the
          // name and what was actually found.
          expect({
            file,
            name: node.name,
            at: entry.sourceFile.getFullText().slice(offset, offset + node.name.length),
          }).toStrictEqual({ file, name: node.name, at: node.name });
          expect(node.line).toBeGreaterThanOrEqual(1);
          expect(node.column).toBeGreaterThanOrEqual(1);
          expect(node.endLine ?? node.line).toBeGreaterThanOrEqual(node.line);
        }
      }
    });

    it('carries coordinates that parse as a code-graph SourceLocation', () => {
      for (const [file, entry] of corpus.files) {
        for (const node of entry.nodes) {
          // The shape `../indexer.ts`'s `locationOf` and `../graph/query.ts`'s
          // matches build from these fields, and the shape the panel's source
          // chip and `source.open` validate again. A node whose coordinates
          // cannot become one is a node no user interface can open.
          const parsed = parseSourceLocation({
            file: node.file,
            line: node.line,
            column: node.column,
            symbol: node.name,
            endLine: node.endLine,
            resolvedBy: 'code-graph',
            confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
          });

          expect(parsed.ok, `${file}#${node.name} did not parse as a SourceLocation`).toBe(true);

          if (parsed.ok) {
            expect(parsed.value.resolvedBy).toBe('code-graph');
            expect(parsed.value.confidence).toBe(0.85);
            expect(parsed.value.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
          }

          expect(isSafeRelativePath(node.file)).toBe(true);
          expect(node.file).toBe(file);
          expect(node.file).not.toContain('\\');
        }
      }
    });
  });

  describe('declares edges and graph assembly', () => {
    it('emits exactly one declares edge per symbol, from that file’s file node', () => {
      for (const [file, entry] of corpus.files) {
        const fileNodeId = fileNodeIdOf(file);

        expect({ file, edges: entry.edges.length }).toStrictEqual({
          file,
          edges: entry.nodes.length,
        });
        expect(entry.edges.map((edge) => edge.kind)).toStrictEqual(
          entry.nodes.map(() => 'declares'),
        );
        // Direction is fixed by the edge table on `CODE_EDGE_KINDS`: `file` →
        // `symbol`, never the reverse.
        expect(entry.edges.map((edge) => edge.from)).toStrictEqual(
          entry.nodes.map(() => fileNodeId),
        );
        expect(entry.edges.map((edge) => edge.to)).toStrictEqual(entry.nodes.map((n) => n.id));
        expect(entry.edges.map((edge) => edge.file)).toStrictEqual(entry.nodes.map((n) => n.file));
      }
    });

    it('gives every node and every edge of the corpus a unique id', () => {
      const nodeIds = [...corpus.files.values()].flatMap((entry) =>
        entry.nodes.map((node) => node.id),
      );
      const edgeIds = [...corpus.files.values()].flatMap((entry) =>
        entry.edges.map((edge) => edge.id),
      );

      // Uniqueness is what keeps graph assembly from dropping a node or an edge
      // as a duplicate: it keeps the first claimant and reports the rest.
      expect(new Set(nodeIds).size).toBe(nodeIds.length);
      expect(new Set(edgeIds).size).toBe(edgeIds.length);
    });

    it('loses no symbol node or declares edge to graph assembly', () => {
      const extracted = [...corpus.files.values()].flatMap((entry) => entry.nodes);
      const assembledSymbols = corpus.graph.nodesByKind('symbol');
      const assembledDeclares = corpus.graph.edges().filter((edge) => edge.kind === 'declares');

      expect(assembledSymbols.map((node) => node.id).sort()).toStrictEqual(
        extracted.map((node) => node.id).sort(),
      );
      expect(assembledDeclares).toHaveLength(extracted.length);
      // `CodeGraph.fromIndex` drops an edge whose endpoint names no node and
      // reports `dangling-edge`. This extractor derives the file node's id
      // rather than emitting the node, so that convention agreeing with
      // `./imports.ts` is exactly what this assertion pins.
      expect(
        corpus.graph.diagnostics.filter((diagnostic) => diagnostic.code === 'dangling-edge'),
      ).toStrictEqual([]);
      expect(corpus.index.diagnostics ?? []).toStrictEqual([]);
    });

    it('anchors every symbol to its file node in the assembled graph', () => {
      for (const [file, entry] of corpus.files) {
        if (entry.nodes.length === 0) {
          continue;
        }

        const declares = corpus.graph.outgoing(fileNodeIdOf(file), 'declares');
        const declared = new Set(declares.map((edge) => edge.to));

        for (const node of entry.nodes) {
          expect(
            declared.has(node.id),
            `${file} does not declare ${node.name} in the assembled graph`,
          ).toBe(true);
          expect(corpus.graph.nodeById(node.id)).toBeDefined();
        }
      }
    });

    it('emits deeply equal, identically ordered output on two consecutive runs', () => {
      for (const [file, entry] of corpus.files) {
        const again = symbolsExtractor.extract(
          corpusContext(corpus.loaded, entry.sourceFile, file),
        );

        // Byte-identical serialisation, not merely equal sets: `../indexer.ts`
        // promises reproducibility and `../cache.ts` keys an entry on it, so
        // re-ordered output would invalidate a cached index for no reason.
        expect(again.nodes).toStrictEqual([...entry.nodes]);
        expect(again.edges).toStrictEqual([...entry.edges]);
        expect(JSON.stringify(again.nodes)).toBe(JSON.stringify(entry.nodes));
      }
    });
  });

  describe('the negative existence case feasibility depends on', () => {
    it('yields no node for a symbol the corpus does not declare', () => {
      const absent = 'reconcileDriftTotals';

      // `packages/instrumentation/src/feasibility.ts` rejects a plan action
      // whose `(file, symbol)` pair is absent, so "absent" has to be answerable
      // — and has to stay absent. A fabricated node here is what makes the
      // patcher attempt an edit that cannot apply.
      for (const [file, entry] of corpus.files) {
        expect({ file, matches: entry.nodes.filter((node) => node.name === absent) }).toStrictEqual(
          { file, matches: [] },
        );
      }

      expect(corpus.graph.nodesByName(absent)).toStrictEqual([]);
    });

    it('yields no node for a real symbol named against the wrong file', () => {
      const service = indexedFile(corpus, 'src/lib/station-service.ts');
      const helper = indexedFile(corpus, 'src/lib/http.ts');

      // The pair that matters: the name exists in the corpus, and the file does
      // too, but this file does not declare it. A lookup that answered on the
      // name alone would make the plan action point at the wrong body.
      expect(service.nodes.map((node) => node.name)).toContain('summarizeBasin');
      expect(helper.nodes.map((node) => node.name)).not.toContain('summarizeBasin');
      expect(helper.nodes.filter((node) => node.name === 'summarizeBasin')).toStrictEqual([]);
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * Part 3 — an on-disk scratch project: harness
 * ---------------------------------------------------------------------------------------------- */

/**
 * The scratch project's sources, by project-relative POSIX path.
 *
 * Written to an `os.mkdtemp` directory in `beforeAll` and removed in
 * `afterAll`, because each of these shapes would have to be forced into the
 * committed corpus to be covered there — a module that does not parse, an
 * anonymous default export, an overload set — and the corpus is a *plausible
 * application*, read by six other suites, rather than a place to park syntax.
 *
 * On disk rather than in memory (which Part 1 uses) for two reasons the
 * in-memory path cannot give: these cases go through the real `openProject`, so
 * the file set, the configuration fallback and the project-relative paths are
 * the ones a developer's project produces; and "extraction writes nothing" is
 * only a claim worth asserting against a real filesystem.
 *
 * Identifiers are invented for this file (`readRow`, `measure`, `normalize`):
 * the syntax is the subject.
 */
const SCRATCH_SOURCES: readonly (readonly [file: string, code: string])[] = [
  // A default export with no identifier at all: the one case that is recorded
  // under the name `default`.
  ['src/anon.ts', ['export default function () {', '  return 1;', '}', ''].join('\n')],
  // The clause form: a local declaration promoted to the module's default.
  [
    'src/alias.ts',
    ['function readRow() {', '  return 2;', '}', '', 'export { readRow as default };', ''].join(
      '\n',
    ),
  ],
  // Collision pressure in one module: an overload set (three declarations of
  // one name), a class method of that same name, and an unrelated const.
  [
    'src/collide.ts',
    [
      'export function measure(value: string): number;',
      'export function measure(value: number): number;',
      'export function measure(value: string | number): number {',
      "  return typeof value === 'string' ? value.length : value;",
      '}',
      '',
      'export class Ledger {',
      '  measure(): number {',
      '    return 3;',
      '  }',
      '}',
      '',
      'export const ledgerLimit = 4;',
      '',
    ].join('\n'),
  ],
  // Two nested declarations of one name, in two different scopes of one module.
  [
    'src/shadow.ts',
    [
      'export function readBatch() {',
      '  function normalize(value: number) {',
      '    return value + 1;',
      '  }',
      '',
      '  return normalize(1);',
      '}',
      '',
      'export function writeBatch() {',
      '  function normalize(value: number) {',
      '    return value - 1;',
      '  }',
      '',
      '  return normalize(2);',
      '}',
      '',
    ].join('\n'),
  ],
  // The scope rule, on disk: a module-level exported function whose body
  // declares both an inner function and an inner const.
  [
    'src/scoped.ts',
    [
      'export function outerTask() {',
      '  function innerTask() {',
      '    return 5;',
      '  }',
      '',
      '  const innerValue = 6;',
      '',
      '  return innerTask() + innerValue;',
      '}',
      '',
    ].join('\n'),
  ],
  // A module that does not parse past its second declaration, with a sound
  // declaration above the damage.
  [
    'src/broken.ts',
    [
      'export function readIntact() {',
      '  return 7;',
      '}',
      '',
      'export function {{{ tallyOutcome(: =>',
      '',
    ].join('\n'),
  ],
  // The sibling that must be unaffected by the broken module beside it.
  ['src/intact.ts', ['export const intactValue = 8;', ''].join('\n')],
];

/** A distinctive token of the broken module's source text. */
const BROKEN_SOURCE_TOKENS: readonly string[] = ['tallyOutcome', '{{{', '=>', 'readIntact'];

/** What {@link beforeAll} prepares once for every scratch case. */
interface Scratch {
  /** The temporary directory the sources were written to. */
  readonly root: string;
  /** The opened project. */
  readonly loaded: LoadedProject;
  /** Extraction, by project-relative POSIX path. */
  readonly files: ReadonlyMap<string, CorpusFile>;
  /** The file stamps taken immediately after the sources were written. */
  readonly stamps: readonly FileStamp[];
}

/**
 * Writes the scratch sources, stamps them, opens the project and extracts every
 * file.
 *
 * @returns The prepared scratch project.
 */
function prepareScratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), 'debuggen-symbols-'));

  mkdirSync(join(root, 'src'), { recursive: true });

  for (const [file, code] of SCRATCH_SOURCES) {
    writeFileSync(join(root, file), code, 'utf8');
  }

  // Stamped before `openProject`, so both opening and extracting are covered by
  // the "writes nothing" case.
  const stamps = stampTree(root);
  const opened = openProject({ projectRoot: root });

  if (!opened.ok) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`the scratch project did not open: ${opened.error.message}`);
  }

  const loaded = opened.value;
  const files = new Map<string, CorpusFile>();

  for (const sourceFile of loaded.sourceFiles()) {
    const file = loaded.projectRelative(sourceFile.getFilePath().split('\\').join('/'));

    if (file === undefined) {
      continue;
    }

    const result = symbolsExtractor.extract(corpusContext(loaded, sourceFile, file));

    files.set(file, {
      sourceFile,
      nodes: result.nodes.filter((node): node is CodeNodeOf<'symbol'> => node.kind === 'symbol'),
      edges: result.edges,
      diagnostics: result.diagnostics ?? [],
    });
  }

  return { root, loaded, files, stamps };
}

/**
 * Re-opens the scratch project and extracts one file again, for the cases that
 * assert an id is stable across runs rather than merely unique within one.
 *
 * A second `openProject` rather than a second `extract` over the same handle:
 * an id derived from a position within one parse tree would be stable for the
 * wrong reason, and what `../cache.ts` depends on is stability across
 * *processes*.
 *
 * @param scratch The prepared scratch project.
 * @param file The project-relative POSIX path to re-extract.
 * @returns That file's symbol nodes from a freshly opened project.
 */
function reExtract(scratch: Scratch, file: string): readonly CodeNodeOf<'symbol'>[] {
  const reopened = openProject({ projectRoot: scratch.root });

  if (!reopened.ok) {
    throw new Error(`the scratch project did not re-open: ${reopened.error.message}`);
  }

  const loaded = reopened.value;
  const sourceFile = loaded.project.getSourceFile(join(scratch.root, file).split('\\').join('/'));

  if (sourceFile === undefined) {
    throw new Error(`the re-opened scratch project holds no ${file}`);
  }

  return symbolsExtractor
    .extract(corpusContext(loaded, sourceFile, file))
    .nodes.filter((node): node is CodeNodeOf<'symbol'> => node.kind === 'symbol');
}

/* -------------------------------------------------------------------------------------------------
 * Part 3 — an on-disk scratch project: cases
 * ---------------------------------------------------------------------------------------------- */

describe('symbolsExtractor over an on-disk scratch project', () => {
  let scratch: Scratch;

  // A 30 s ceiling, not a budget: this hook parses a program, which a loaded
  // machine can push past the 10 s hook default and so fail every case below.
  beforeAll(() => {
    scratch = prepareScratch();
  }, 30_000);

  afterAll(() => {
    rmSync(scratch.root, { recursive: true, force: true });
  });

  describe('how a default export is named', () => {
    it('records a truly anonymous default export under the name default', () => {
      const anon = indexedFile(scratch, 'src/anon.ts');
      const node = only(anon.nodes, 'default');

      // There is no identifier to keep, and the module's default export still
      // has to be findable, so the reserved spelling is used — and only here.
      expect(factsOf(node)).toStrictEqual(defaultSymbol('default', 'function'));
    });

    it('keeps the declared name when a clause exports a local binding as default', () => {
      const alias = indexedFile(scratch, 'src/alias.ts');

      // `export { readRow as default }` promotes an existing declaration: the
      // node keeps the name a plan action would spell and records that it is
      // the default.
      expect(alias.nodes.map(factsOf)).toStrictEqual([defaultSymbol('readRow', 'function')]);
      expect(alias.nodes.map((node) => node.name)).not.toContain('default');
    });
  });

  describe('identity under collision pressure', () => {
    it('gives an overload set, a same-named method and their ids no overlap', () => {
      const collide = indexedFile(scratch, 'src/collide.ts');
      const measures = collide.nodes.filter((node) => node.name === 'measure');
      const ids = new Set(measures.map((node) => node.id));

      // Three declarations of one name in one file plus a method of that name
      // on a class in the same file: four nodes, four ids. Collapsing any pair
      // would lose a declaration the patcher can resolve, and `makeNodeId`
      // separates them by position alone.
      expect(measures).toHaveLength(4);
      expect(ids.size).toBe(4);
      expect(measures.map((node) => node.data?.declaration)).toStrictEqual([
        'function',
        'function',
        'function',
        'method',
      ]);
      expect(measures.map((node) => node.symbol)).toStrictEqual([
        undefined,
        undefined,
        undefined,
        'Ledger',
      ]);
      expect(new Set(collide.edges.map((edge) => edge.id)).size).toBe(collide.edges.length);
    });

    it('gives two nested declarations of one name distinct ids and distinct chains', () => {
      const shadow = indexedFile(scratch, 'src/shadow.ts');
      const normalizers = shadow.nodes.filter((node) => node.name === 'normalize');

      expect(normalizers).toHaveLength(2);
      expect(new Set(normalizers.map((node) => node.id)).size).toBe(2);
      // The chain is what lets a planner qualify an otherwise ambiguous bare
      // name (`readBatch.normalize`), which is the answer feasibility needs
      // when one file declares the same helper twice.
      expect(normalizers.map((node) => node.data?.enclosing)).toStrictEqual([
        ['readBatch'],
        ['writeBatch'],
      ]);
    });

    it('produces the same ids from a second, independently opened project', () => {
      const first = indexedFile(scratch, 'src/collide.ts').nodes;
      const second = reExtract(scratch, 'src/collide.ts');

      // Stability across processes, not merely within one: `../cache.ts` keys a
      // stored index on the assumption, so an id that moved would silently make
      // every cached graph wrong rather than merely stale.
      expect(second.map((node) => node.id)).toStrictEqual(first.map((node) => node.id));
      expect(second).toStrictEqual([...first]);
    });
  });

  describe('scope, on a real project', () => {
    it('records the nested function and not the nested value const', () => {
      const scoped = indexedFile(scratch, 'src/scoped.ts');

      // The recorded pair is the contract `./symbols.ts` documents: a named
      // *function-valued* declaration nested in a body is addressable by a
      // `(file, symbol)` action — AAP §6's canonical plan names exactly that
      // shape — while a nested value const declares no body to wrap and is
      // deliberately absent.
      expect(scoped.nodes.map(factsOf)).toStrictEqual([
        exportedSymbol('outerTask', 'function'),
        localSymbol('innerTask', 'function'),
      ]);
      expect(scoped.nodes.map((node) => node.name)).not.toContain('innerValue');
      expect(only(scoped.nodes, 'innerTask').data?.enclosing).toStrictEqual(['outerTask']);
      // A nested declaration cannot leave its body, whatever the enclosing
      // declaration's export status is.
      expect(only(scoped.nodes, 'innerTask').exported).toBe(false);
      expect(only(scoped.nodes, 'outerTask').data).not.toHaveProperty('enclosing');
    });
  });

  describe('robustness and purity', () => {
    it('reports a module it cannot read as a diagnostic and indexes the rest of it', () => {
      const broken = indexedFile(scratch, 'src/broken.ts');
      const intact = indexedFile(scratch, 'src/intact.ts');

      // `extract` never throws: a construct it cannot read costs that one
      // declaration, and both the sound declaration above it and every other
      // file of the project still yield nodes (AAP 0.5.5 — degrade, never fail).
      expect(broken.nodes.map((node) => node.name)).toStrictEqual(['readIntact']);
      expect(intact.nodes.map(factsOf)).toStrictEqual([exportedSymbol('intactValue', 'variable')]);
      expect(broken.diagnostics).toHaveLength(1);

      const [diagnostic] = broken.diagnostics;

      expect(diagnostic?.severity).toBe('warning');
      expect(diagnostic?.code).toBe('extractor-failed');
      expect(diagnostic?.extractorId).toBe('symbols');
      expect(diagnostic?.file).toBe('src/broken.ts');
    });

    it('names no source text in what it reports about a module it cannot read', () => {
      const broken = indexedFile(scratch, 'src/broken.ts');
      const reported = broken.diagnostics
        .map((diagnostic) => `${diagnostic.message} ${diagnostic.detail ?? ''}`)
        .join('\n');

      // A diagnostic travels into logs and into the developer-facing progress
      // view, so it says *where* and *what kind*, never what the code says
      // (AAP 0.5.2). Node kinds and positions are fine; identifiers and
      // punctuation lifted from the file are not.
      for (const token of BROKEN_SOURCE_TOKENS) {
        expect(reported).not.toContain(token);
      }

      expect(reported).toContain('FunctionDeclaration');
      expect(reported).toContain('line 5');
    });

    it('writes nothing: the project’s file set, sizes and mtimes are unchanged', () => {
      // Every file was already extracted in `beforeAll`, and re-extracting here
      // means the assertion covers a second pass as well as the first.
      for (const [file, entry] of scratch.files) {
        symbolsExtractor.extract(corpusContext(scratch.loaded, entry.sourceFile, file));
      }

      expect(stampTree(scratch.root)).toStrictEqual(scratch.stamps);
    });
  });
});
