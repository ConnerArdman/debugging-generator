/**
 * Unit suite for `./symbols.ts`, and specifically for the boundary it draws
 * around **nested** declarations.
 *
 * The extractor is the sole producer of `symbol` nodes, and
 * `../graph/query.ts`'s `findSymbol`/`hasSymbol` — which
 * `packages/instrumentation`'s feasibility check acts on — answer from those
 * nodes alone. So the two failure modes are symmetric and both are expensive:
 *
 * - **A missing node** makes a legitimate plan action unfeasible. The case that
 *   mattered in practice is AAP §6's canonical plan, which names a React submit
 *   handler declared *inside* its component; before this file existed the graph
 *   held no node for it at all.
 * - **A fabricated node** makes the graph promise a `(file, symbol)` pair the
 *   function-timing patcher then refuses. A parameter, a destructured prop and
 *   a `useCallback` result all look like named functions at a binding site and
 *   are not declarations this file holds a body for.
 *
 * Every case below is therefore an assertion about one of those two lists, plus
 * the properties the whole index depends on: a nested node must never be
 * reported as exported, two nested declarations sharing a name must have
 * distinct ids, the walk must stop at a documented depth, and two runs over
 * unchanged source must emit identical nodes.
 *
 * ## How the cases are driven
 *
 * Each case builds a ts-morph `Project` on an **in-memory filesystem** and
 * hands the extractor a hand-made {@link ExtractorContext}. That is the whole
 * dependency: the extractor is pure, synchronous and reads nothing but the
 * syntax tree of `ctx.sourceFile`, so there is no corpus to copy, nothing to
 * clean up afterwards, and no shared fixture for another suite's expectations
 * to collide with.
 *
 * The sources are written as the smallest thing that has the shape under test,
 * with neutral identifiers (`Panel`, `handleApply`, `readValue`): the syntax is
 * the subject, and a name borrowed from an application under test would suggest
 * otherwise.
 */

import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { noopLogger } from '@debuggen/shared';

import { makeNodeId } from '../graph/graph.js';
import type { CodeEdge, CodeNode, CodeNodeOf, ExtractorContext } from '../graph/types.js';
import type { LoadedProject } from '../project.js';
import { symbolsExtractor } from './symbols.js';

/* -------------------------------------------------------------------------------------------------
 * Harness
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
