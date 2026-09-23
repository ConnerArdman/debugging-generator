/**
 * Tests for `./graph.ts`: the container every consumer of a code index reads
 * through, and the two identity functions every producer of a node or an edge
 * calls.
 *
 * Four properties are pinned here, because the rest of the package is built on
 * them and each one fails somewhere other than where it is declared:
 *
 * 1. **Adjacency correctness.** `./query.ts` answers a model-facing question
 *    with many lookups, so every accessor has to return exactly the right set,
 *    in a deterministic order, and answer a miss with an empty array rather
 *    than `undefined` — {@link CodeGraph.nodeById} alone excepted. An accessor
 *    that quietly normalised its key, or that handed out a live array, would
 *    not fail here at all; it would fail as a wrong traversal three modules
 *    away.
 * 2. **The lossless `CodeIndex` round trip.** `../indexer.ts` persists
 *    `graph.toIndex()` rather than the envelope it assembled and `../cache.ts`
 *    byte-compares what it stored, so "deep-equal" is not enough: the two
 *    `JSON.stringify` results must be identical, which makes the field order of
 *    the envelope and the omission of an empty `diagnostics` part of the
 *    contract rather than an implementation detail.
 * 3. **Defensive handling of malformed input.** A cache entry read back from
 *    `$DEBUGGEN_HOME/index` is untrusted: it may carry a duplicate id, an edge
 *    whose endpoint is gone, a kind from an older vocabulary, or a cyclic
 *    payload no well-formed index would hold. Construction must drop what it
 *    cannot use, say so in an {@link IndexDiagnostic}, and never throw — a
 *    stale cache costs a caller some evidence, not a crashed investigation.
 * 4. **Id determinism.** `../indexer.test.ts` asserts that two indexing runs
 *    over unchanged source serialise byte-identically. That promise rests
 *    entirely on {@link makeNodeId}, {@link makeEdgeId} and the canonical sort,
 *    with `generatedAt` as the only field allowed to differ — which is why the
 *    determinism and injectivity suites below are the longest in the file, and
 *    why every index built here pins `generatedAt` to `0`.
 *
 * ## Purity
 *
 * The container's own suites are fixture-free and side-effect-free by design:
 * every case builds a small hand-authored {@link CodeIndex} in memory. No
 * filesystem, no ts-morph project, no network, no timers — the one measurement
 * in here is a loose wall-clock budget on a lookup loop, sized so that it can
 * only fail if a pre-computed index was replaced by a scan.
 *
 * ## The two suites at the end, and why they are not fixture-free
 *
 * The last four suites are about the *queries* this container is read through,
 * and two of them are about a property that does not exist in either half
 * alone: an extractor records a relationship and a query answers with it, so an
 * index nobody extracted cannot show that the two agree. Those two therefore
 * write a **miniature project of their own** into an `os.tmpdir()` sandbox,
 * index it through the real `openProject`/`indexProject` path, and query the
 * graph that comes out. They never touch the committed corpus under
 * `../../test/fixtures`, which is read-only input for other suites, and the
 * sandbox is removed afterwards — `git status --porcelain packages/code-analysis`
 * is empty after a run either way.
 *
 * The remaining two — the path-orientation suite and the argument-admission
 * suite — stay hand-authored, because a graph spelled out here is the only way
 * to state the exact adjacency an undirected traversal has to walk backwards
 * through.
 *
 * ## Two habits worth stating
 *
 * - **Ids in assertions are computed, never spelled out.** `./graph.ts`
 *   documents that no consumer may parse an id, and a test that hard-coded one
 *   would be the first consumer to do so. The only literal ids in this file are
 *   in {@link makeNodeId}'s and {@link makeEdgeId}'s own suites, where the
 *   grammar *is* the subject, and in the corrupt-entry cases, where a literal
 *   is the only way to express an id the current vocabulary cannot produce.
 * - **Order is asserted byte-wise.** Every ordering assertion below compares
 *   with `<` on the strings themselves, and the fixtures deliberately include a
 *   pair whose byte order differs from every locale's collation
 *   (`src/Beta.tsx` before `src/alpha.tsx`), so an implementation that reached
 *   for `localeCompare` fails here rather than on another machine's CI.
 *
 * Identifiers in the fixtures are neutral placeholders (`WidgetList`,
 * `handleSubmit`, `/api/items`, `loadItems`): the container is the subject, and
 * a name borrowed from an application under test would say otherwise.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertDefined, isOk } from '@debuggen/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { indexProject } from '../indexer.js';
import { CodeGraph, makeEdgeId, makeNodeId } from './graph.js';
import { createCodeQueries } from './query.js';
import { CODE_EDGE_KINDS, CODE_INDEX_SCHEMA_VERSION, CODE_NODE_KINDS } from './types.js';

import type { LogFields, Logger, LogLevel } from '@debuggen/shared';

import type { EdgeIdInput, NodeIdInput } from './graph.js';
import type { CodeMatch, CodePath, CodeQueries } from './query.js';

import type {
  CodeEdge,
  CodeEdgeKind,
  CodeIndex,
  CodeNode,
  CodeNodeKind,
  CodeNodeOf,
  FileFingerprint,
  IndexDiagnostic,
} from './types.js';

/* -------------------------------------------------------------------------------------------------
 * Envelope constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The absolute POSIX project root every index in this file declares.
 *
 * Absolute, because {@link CodeIndex.projectRoot} is the one absolute path an
 * index carries — and deliberately used by the id suites as the string an id
 * must *not* contain, which is what keeps a cached index valid across
 * checkouts.
 */
const PROJECT_ROOT = '/tmp/project';

/** The indexer version every index in this file declares. */
const INDEXER_VERSION = 'test';

/**
 * The build time every index in this file declares.
 *
 * Pinned to `0` rather than read from a clock: `generatedAt` is the only field
 * of an index that legitimately differs between two runs over unchanged
 * source, so a test that let it vary would be the one place a determinism
 * assertion could pass for the wrong reason.
 */
const GENERATED_AT = 0;

/* -------------------------------------------------------------------------------------------------
 * Builders
 * ---------------------------------------------------------------------------------------------- */

/** The per-kind defaults {@link node} fills a draft with. */
interface KindDefaults<K extends CodeNodeKind> {
  /** The project-relative POSIX file the node is declared in. */
  readonly file: string;

  /** The node's source-spelled name. */
  readonly name: string;

  /** The payload its kind calls for. */
  readonly data: CodeNodeOf<K>['data'];
}

/**
 * One neutral, fully populated default per node kind.
 *
 * Every kind gets a payload — including `file` and `symbol`, whose `data` is
 * optional — so that a node built here is always a complete, JSON-clean record.
 * The two cases that need a node *without* a payload (the plain-JSON walk and
 * the present-but-undefined check) spell that node out as a literal, which is
 * clearer than a builder flag that exists for two call sites.
 */
const KIND_DEFAULTS: { readonly [K in CodeNodeKind]: KindDefaults<K> } = {
  file: {
    file: 'src/WidgetList.tsx',
    name: 'WidgetList.tsx',
    data: { extension: '.tsx', isClientModule: true, externalImports: [] },
  },
  symbol: {
    file: 'src/lib/loaders.ts',
    name: 'loadItems',
    data: { declaration: 'function', isDefaultExport: false },
  },
  component: {
    file: 'src/WidgetList.tsx',
    name: 'WidgetList',
    data: { isClient: true, isDefaultExport: false, displayName: 'WidgetList' },
  },
  handler: {
    file: 'src/WidgetList.tsx',
    name: 'handleSubmit',
    data: { event: 'click', boundTo: 'button', inline: false },
  },
  'api-call': {
    file: 'src/WidgetList.tsx',
    name: 'fetchItems',
    data: { url: '/api/items', dynamic: false, method: 'GET' },
  },
  'api-route': {
    file: 'src/app/api/items/route.ts',
    name: 'GET',
    data: { routePath: '/api/items', router: 'app', kind: 'route-handler', methods: ['GET'] },
  },
  'server-function': {
    file: 'src/server/items.ts',
    name: 'loadItems',
    data: { isAsync: true, exported: true },
  },
  'db-call': {
    file: 'src/server/items.ts',
    name: 'findMany',
    data: { driver: 'prisma', model: 'Item', operation: 'findMany', dynamic: false },
  },
};

/** What a case may vary about a built node. */
interface NodeOverrides<K extends CodeNodeKind> {
  /** Project-relative POSIX path; defaults to the kind's default file. */
  readonly file?: string;

  /** Source-spelled name; defaults to the kind's default name. */
  readonly name?: string;

  /** 1-based line; defaults to `1`. */
  readonly line?: number;

  /** 1-based column; defaults to `1`. */
  readonly column?: number;

  /** The kind's payload; defaults to the kind's default payload. */
  readonly data?: CodeNodeOf<K>['data'];
}

/**
 * Builds one {@link CodeNode} of a given kind, with its id derived through the
 * **real** {@link makeNodeId}.
 *
 * Deriving rather than spelling the id is the point: every node in this file
 * therefore travels the production identity path, so a change to the id grammar
 * cannot leave this suite passing against ids no extractor would produce.
 *
 * The single assertion is unavoidable and narrow. The literal is checked
 * field-by-field against the concrete kind's requirements — `data` comes from
 * `KindDefaults<K>`, so a payload that does not match the kind is a compile
 * error at the defaults table above — but the compiler cannot verify that an
 * object whose `kind` is the *type parameter* `K` inhabits the union member
 * `CodeNodeOf<K>` while `K` is still generic. Nothing is widened: the
 * assertion's input already carries every field of the member it names.
 *
 * @typeParam K The node kind to build.
 * @param kind The node's kind.
 * @param overrides What to vary from the kind's defaults.
 * @returns The node.
 */
function node<K extends CodeNodeKind>(kind: K, overrides: NodeOverrides<K> = {}): CodeNodeOf<K> {
  const defaults = KIND_DEFAULTS[kind];
  const file = overrides.file ?? defaults.file;
  const name = overrides.name ?? defaults.name;
  const line = overrides.line ?? 1;
  const column = overrides.column ?? 1;
  const data = overrides.data ?? defaults.data;

  return {
    id: makeNodeId({ kind, file, name, line, column }),
    kind,
    name,
    file,
    line,
    column,
    data,
  } as CodeNodeOf<K>;
}

/** What a case states about a built edge; `line`, `column` and `file` are optional. */
interface EdgeSpec {
  /** The relationship's kind. */
  readonly kind: CodeEdgeKind;

  /** The {@link CodeNode.id} the relationship starts at. */
  readonly from: string;

  /** The {@link CodeNode.id} the relationship points at. */
  readonly to: string;

  /** The project-relative POSIX file of the edge site, when it has one. */
  readonly file?: string;

  /** The 1-based line of the edge site, when it has one. */
  readonly line?: number;

  /** The 1-based column of the edge site, when it has one. */
  readonly column?: number;
}

/**
 * Builds one {@link CodeEdge}, with its id derived through the **real**
 * {@link makeEdgeId}.
 *
 * Assembled by assigning only the optional fields the spec actually carries,
 * rather than by spreading a partial: `exactOptionalPropertyTypes` makes
 * "present and `undefined`" a different thing from "absent", and an index is
 * required to be plain JSON with no present-but-undefined field anywhere in it
 * — which is exactly what the round-trip assertions below would otherwise fail
 * on, for a reason that has nothing to do with the subject.
 *
 * @param spec The edge's kind, endpoints and optional site.
 * @returns The edge.
 */
function edge(spec: EdgeSpec): CodeEdge {
  const draft: {
    id: string;
    kind: CodeEdgeKind;
    from: string;
    to: string;
    file?: string;
    line?: number;
    column?: number;
  } = {
    id: makeEdgeId(spec),
    kind: spec.kind,
    from: spec.from,
    to: spec.to,
  };

  if (spec.file !== undefined) {
    draft.file = spec.file;
  }

  if (spec.line !== undefined) {
    draft.line = spec.line;
  }

  if (spec.column !== undefined) {
    draft.column = spec.column;
  }

  return draft;
}

/** What a case may vary about a built index. */
interface IndexOverrides {
  /** The declared vocabulary version; defaults to {@link CODE_INDEX_SCHEMA_VERSION}. */
  readonly schemaVersion?: number;

  /** The absolute POSIX project root; defaults to {@link PROJECT_ROOT}. */
  readonly projectRoot?: string;

  /** The producing indexer's version; defaults to {@link INDEXER_VERSION}. */
  readonly indexerVersion?: string;

  /** The build time; defaults to {@link GENERATED_AT}. */
  readonly generatedAt?: number;

  /** The nodes; defaults to none. */
  readonly nodes?: readonly CodeNode[];

  /** The edges; defaults to none. */
  readonly edges?: readonly CodeEdge[];

  /** The file fingerprints; defaults to none. */
  readonly files?: readonly FileFingerprint[];

  /** The index's own diagnostics. Omitted entirely when this is absent. */
  readonly diagnostics?: readonly IndexDiagnostic[];
}

/**
 * Builds a structurally valid {@link CodeIndex}.
 *
 * The property key order is the declaration order of {@link CodeIndex}, which
 * is what makes `JSON.stringify` of a round-tripped index comparable to
 * `JSON.stringify` of the original rather than merely deep-equal to it —
 * `../cache.ts` byte-compares persisted entries, so the field order is part of
 * what is under test.
 *
 * @param overrides What to vary from the defaults.
 * @returns The index.
 */
function index(overrides: IndexOverrides = {}): CodeIndex {
  const envelope: {
    schemaVersion: number;
    projectRoot: string;
    indexerVersion: string;
    generatedAt: number;
    nodes: readonly CodeNode[];
    edges: readonly CodeEdge[];
    files: readonly FileFingerprint[];
    diagnostics?: readonly IndexDiagnostic[];
  } = {
    schemaVersion: overrides.schemaVersion ?? CODE_INDEX_SCHEMA_VERSION,
    projectRoot: overrides.projectRoot ?? PROJECT_ROOT,
    indexerVersion: overrides.indexerVersion ?? INDEXER_VERSION,
    generatedAt: overrides.generatedAt ?? GENERATED_AT,
    nodes: overrides.nodes ?? [],
    edges: overrides.edges ?? [],
    files: overrides.files ?? [],
  };

  if (overrides.diagnostics !== undefined) {
    envelope.diagnostics = overrides.diagnostics;
  }

  return envelope;
}

/** One file fingerprint, with a neutral size and modification time. */
function fingerprint(file: string, size = 1_024): FileFingerprint {
  return { file, mtimeMs: 1_776_000_000_000, size, hash: 'a'.repeat(64) };
}

/**
 * Replaces a node's payload with an arbitrary value.
 *
 * The union forbids this statically, and rightly: no extractor can produce it.
 * A *cache entry* can, though — it is JSON that something else wrote — and the
 * duplicate-id comparison has to survive whatever is in there, so the widened
 * cast is how a case expresses an input the vocabulary itself rules out.
 *
 * @param target The node to re-payload.
 * @param payload Any value, including a cyclic or over-deep one.
 * @returns The node with that payload.
 */
function withPayload(target: CodeNode, payload: unknown): CodeNode {
  return { ...target, data: payload } as unknown as CodeNode;
}

/**
 * A plain object nested `depth` levels deep.
 *
 * Used to exceed the comparison's depth bound, whose documented behaviour is to
 * report "not equal" rather than descend further.
 *
 * @param depth How many wrapper levels to build.
 * @returns The nested value.
 */
function nest(depth: number): unknown {
  let value: unknown = { leaf: true };

  for (let level = 0; level < depth; level += 1) {
    value = { nested: value };
  }

  return value;
}

/** One line a {@link Logger} was asked to emit. */
interface RecordedLine {
  /** The severity the call was made at. */
  readonly level: LogLevel;

  /** The message the call carried. */
  readonly message: string;

  /** The structured fields the call carried, or `{}` when it carried none. */
  readonly fields: LogFields;
}

/**
 * A logger that records instead of printing.
 *
 * Needed for exactly one property: a schema-version mismatch is **reported and
 * never rejected**, and because `./types.ts`'s diagnostic vocabulary has no
 * code for it, the report is a log line rather than a diagnostic. Asserting on
 * a recorded line is the only way to tell "reported" apart from "ignored".
 *
 * @returns The logger and the list it appends to.
 */
function createRecordingLogger(): { readonly logger: Logger; readonly lines: RecordedLine[] } {
  const lines: RecordedLine[] = [];
  const record =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields: fields ?? {} });
    };

  const logger: Logger = {
    level: 'trace',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: (): Logger => logger,
  };

  return { logger, lines };
}

/**
 * Byte-wise lexicographic comparison, the order the graph promises.
 *
 * Spelled out here rather than imported, and deliberately **not**
 * `localeCompare`: the whole point of the ordering assertions is to fail when
 * the implementation's comparison is locale-dependent, which a comparator
 * shared with the implementation could never do.
 *
 * @param left The first string.
 * @param right The second string.
 * @returns A negative number, zero, or a positive number.
 */
function byteCompare(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

/** The ids of a list of nodes or edges, in the list's order. */
function idsOf(entries: readonly { readonly id: string }[]): string[] {
  return entries.map((entry) => entry.id);
}

/** The `code` of every diagnostic, in order. */
function codesOf(diagnostics: readonly IndexDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

/**
 * The one diagnostic with a given code, asserted to be unique.
 *
 * A helper rather than an inline `find`, because every malformed-input case
 * below asserts on a diagnostic's severity, message *and* file, and "exactly
 * one was recorded" is part of what each of them means.
 *
 * @param diagnostics The graph's diagnostics.
 * @param code The code to select.
 * @returns The single diagnostic with that code.
 */
function onlyDiagnostic(
  diagnostics: readonly IndexDiagnostic[],
  code: IndexDiagnostic['code'],
): IndexDiagnostic {
  const matched = diagnostics.filter((diagnostic) => diagnostic.code === code);

  expect(matched).toHaveLength(1);

  const first = matched[0];

  assertDefined(first, `expected one ${code} diagnostic`);

  return first;
}

/* -------------------------------------------------------------------------------------------------
 * The canonical sample graph
 * ---------------------------------------------------------------------------------------------- */

/**
 * The file that declares the interaction side of the sample.
 *
 * One node per kind follows, wired into the chain a real investigation walks —
 * interaction to render to request to route to service function to query — so
 * that a single fixture exercises every bucket of the per-kind index and every
 * edge kind the chain needs. The endpoint kinds follow the table on
 * `CODE_EDGE_KINDS` exactly; an edge with endpoints that table does not sanction
 * would make this fixture an argument for a graph nobody produces.
 */
const FILE_NODE = node('file');

/** The component the sample's interaction happens in. */
const LIST_COMPONENT = node('component', { line: 8, column: 1 });

/** A second component, so that a `renders` edge has somewhere to point. */
const ROW_COMPONENT = node('component', {
  file: 'src/WidgetRow.tsx',
  name: 'WidgetRow',
  line: 4,
  column: 1,
  data: { isClient: true, isDefaultExport: true, displayName: 'WidgetRow' },
});

/** The event handler the list component binds. */
const HANDLER_NODE = node('handler', { line: 12, column: 3 });

/** The request the handler issues. */
const API_CALL_NODE = node('api-call', { line: 14, column: 11 });

/** The route handler that request reaches. */
const API_ROUTE_NODE = node('api-route', { line: 6, column: 1 });

/** The service function the route delegates to. */
const SERVER_FUNCTION_NODE = node('server-function', { line: 20, column: 1 });

/** The database call the service function makes. */
const DB_CALL_NODE = node('db-call', { line: 24, column: 5 });

/** `declares`: the file declares the list component. */
const DECLARES_EDGE = edge({
  kind: 'declares',
  from: FILE_NODE.id,
  to: LIST_COMPONENT.id,
  file: 'src/WidgetList.tsx',
  line: 8,
  column: 1,
});

/** `handles`: the list component binds the handler. */
const HANDLES_EDGE = edge({
  kind: 'handles',
  from: LIST_COMPONENT.id,
  to: HANDLER_NODE.id,
  file: 'src/WidgetList.tsx',
  line: 12,
  column: 3,
});

/** `calls`: the handler issues the request. */
const CALLS_API_EDGE = edge({
  kind: 'calls',
  from: HANDLER_NODE.id,
  to: API_CALL_NODE.id,
  file: 'src/WidgetList.tsx',
  line: 14,
  column: 11,
});

/**
 * `routes-to`: the request's URL matched the route map.
 *
 * Deliberately sited nowhere — it is derived from two nodes rather than read
 * off a line of source, which is the case that makes `makeEdgeId`'s optional
 * position fields load-bearing.
 */
const ROUTES_TO_EDGE = edge({
  kind: 'routes-to',
  from: API_CALL_NODE.id,
  to: API_ROUTE_NODE.id,
});

/** `calls`: the route handler delegates to the service function. */
const CALLS_SERVER_EDGE = edge({
  kind: 'calls',
  from: API_ROUTE_NODE.id,
  to: SERVER_FUNCTION_NODE.id,
  file: 'src/app/api/items/route.ts',
  line: 7,
  column: 10,
});

/** `queries`: the service function reaches the database. */
const QUERIES_EDGE = edge({
  kind: 'queries',
  from: SERVER_FUNCTION_NODE.id,
  to: DB_CALL_NODE.id,
  file: 'src/server/items.ts',
  line: 24,
  column: 5,
});

/** `renders`: the list component renders the row component. */
const RENDERS_EDGE = edge({
  kind: 'renders',
  from: LIST_COMPONENT.id,
  to: ROW_COMPONENT.id,
  file: 'src/WidgetList.tsx',
  line: 30,
  column: 7,
});

/** Every node of the sample, in the arbitrary order an extractor might emit. */
const SAMPLE_NODES: readonly CodeNode[] = [
  DB_CALL_NODE,
  FILE_NODE,
  LIST_COMPONENT,
  SERVER_FUNCTION_NODE,
  API_ROUTE_NODE,
  HANDLER_NODE,
  ROW_COMPONENT,
  API_CALL_NODE,
];

/** Every edge of the sample, in the arbitrary order an extractor might emit. */
const SAMPLE_EDGES: readonly CodeEdge[] = [
  QUERIES_EDGE,
  DECLARES_EDGE,
  RENDERS_EDGE,
  CALLS_API_EDGE,
  ROUTES_TO_EDGE,
  HANDLES_EDGE,
  CALLS_SERVER_EDGE,
];

/**
 * The fingerprints of the sample's files.
 *
 * `src/Beta.tsx` and `src/alpha.tsx` are not part of the graph and are here
 * only for their collation: byte-wise `'B'` (0x42) precedes `'a'` (0x61), while
 * every locale's collation orders `alpha` first. They are the tripwire for a
 * `localeCompare` creeping into the canonical sort.
 */
const SAMPLE_FILES: readonly FileFingerprint[] = [
  fingerprint('src/server/items.ts', 2_048),
  fingerprint('src/alpha.tsx', 128),
  fingerprint('src/WidgetList.tsx', 4_096),
  fingerprint('src/Beta.tsx', 256),
];

/**
 * The sample as an index, arrays in extractor order.
 *
 * A fresh object on every call, because several cases below assert that
 * construction leaves its input untouched and a shared literal would let one
 * case's mutation pass the next one's assertion.
 *
 * @returns The sample index.
 */
function sampleIndex(): CodeIndex {
  return index({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES, files: SAMPLE_FILES });
}

/**
 * The sample graph.
 *
 * @returns A graph over {@link sampleIndex}.
 */
function sampleGraph(): CodeGraph {
  return CodeGraph.fromIndex(sampleIndex());
}

/* -------------------------------------------------------------------------------------------------
 * Corrupt entries
 * ---------------------------------------------------------------------------------------------- */

/**
 * A node whose kind belongs to no vocabulary this build knows.
 *
 * Spelled as a literal because that is the only way to express it: `node()`
 * derives its id through {@link makeNodeId}, which cannot be handed a kind the
 * union does not hold. This is what a cache entry written by a different —
 * older, newer or hand-edited — version of the package looks like from here,
 * and construction has to drop it rather than crash a traversal later.
 */
const CORRUPT_NODE: CodeNode = {
  id: 'module:src/legacy.ts#Legacy@1:1',
  kind: 'module',
  name: 'Legacy',
  file: 'src/legacy.ts',
  line: 1,
  column: 1,
} as unknown as CodeNode;

/**
 * An edge whose kind belongs to no vocabulary this build knows, between two
 * nodes that do exist — so that "dropped for its kind" cannot be confused with
 * "dropped for a missing endpoint".
 */
const CORRUPT_EDGE: CodeEdge = {
  id: `uses:${FILE_NODE.id}>${LIST_COMPONENT.id}@1:1`,
  kind: 'uses',
  from: FILE_NODE.id,
  to: LIST_COMPONENT.id,
  file: 'src/WidgetList.tsx',
  line: 1,
  column: 1,
} as unknown as CodeEdge;

/* -------------------------------------------------------------------------------------------------
 * Identity: makeNodeId
 * ---------------------------------------------------------------------------------------------- */

describe('makeNodeId', () => {
  /** The input every case below varies one component of. */
  const base: NodeIdInput = {
    kind: 'component',
    file: 'src/components/Widget.tsx',
    name: 'Widget',
    line: 12,
    column: 1,
  };

  it('produces the shape its own documentation states', () => {
    expect(makeNodeId(base)).toBe('component:src/components/Widget.tsx#Widget@12:1');
  });

  it('is deterministic across repeated calls with the same input', () => {
    const first = makeNodeId(base);
    const second = makeNodeId(base);
    const third = makeNodeId(base);

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('is deterministic across independently constructed, equal inputs', () => {
    const other: NodeIdInput = {
      column: 1,
      line: 12,
      name: 'Widget',
      file: 'src/components/Widget.tsx',
      kind: 'component',
    };

    // Property order differs; the identity must not.
    expect(makeNodeId(other)).toBe(makeNodeId(base));
  });

  it('distinguishes inputs that differ in any single component', () => {
    const variants: readonly NodeIdInput[] = [
      base,
      { ...base, kind: 'symbol' },
      { ...base, file: 'src/components/Other.tsx' },
      { ...base, name: 'Widgets' },
      { ...base, line: 13 },
      { ...base, column: 2 },
    ];

    const ids = variants.map(makeNodeId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('distinguishes every kind at one position', () => {
    const ids = CODE_NODE_KINDS.map((kind) => makeNodeId({ ...base, kind }));

    expect(new Set(ids).size).toBe(CODE_NODE_KINDS.length);
  });

  it('percent-escapes exactly the delimiter characters of its grammar', () => {
    const cases: readonly [name: string, expected: string][] = [
      ['a%b', 'a%25b'],
      ['a:b', 'a%3Ab'],
      ['a#b', 'a%23b'],
      ['a@b', 'a%40b'],
      ['a>b', 'a%3Eb'],
    ];

    for (const [name, expected] of cases) {
      expect(makeNodeId({ ...base, name })).toBe(
        `component:src/components/Widget.tsx#${expected}@12:1`,
      );
    }
  });

  it('leaves characters outside the grammar alone', () => {
    // Deliberately not `encodeURIComponent`: an accented path must stay
    // readable in a diagnostic.
    expect(makeNodeId({ ...base, file: 'src/café/Wîdget.tsx' })).toBe(
      'component:src/café/Wîdget.tsx#Widget@12:1',
    );
  });

  it('cannot be forged by moving a delimiter between components', () => {
    const inFile = makeNodeId({ ...base, file: 'src/a.ts#Widget', name: 'X' });
    const inName = makeNodeId({ ...base, file: 'src/a.ts', name: 'Widget#X' });
    const inFileColon = makeNodeId({ ...base, file: 'src/a.ts', name: ':Widget' });
    const kindShift = makeNodeId({ ...base, kind: 'symbol', name: 'Widget' });

    expect(new Set([inFile, inName, inFileColon, kindShift]).size).toBe(4);
  });

  it('cannot be forged by pre-escaping a delimiter', () => {
    // `%` is escaped first, so an already-escaped sequence encodes to `%253A`
    // and can never be read back as the literal delimiter.
    const preEscaped = makeNodeId({ ...base, name: 'a%3Ab' });
    const literal = makeNodeId({ ...base, name: 'a:b' });

    expect(preEscaped).toBe('component:src/components/Widget.tsx#a%253Ab@12:1');
    expect(preEscaped).not.toBe(literal);
  });

  it('cannot be forged by shifting the line and column boundary', () => {
    const inName = makeNodeId({ ...base, name: 'Widget@12', line: 1, column: 1 });
    const inPosition = makeNodeId({ ...base, name: 'Widget', line: 12, column: 1 });

    expect(inName).not.toBe(inPosition);
  });

  it('carries no absolute path for a project-relative file', () => {
    const id = makeNodeId({ ...base, file: 'src/x.ts' });

    expect(id).not.toContain(PROJECT_ROOT);
    expect(id).toContain('src/x.ts');
  });

  it('does not normalise an absolute file, so the caller bug stays visible', () => {
    // Documented behaviour: an absolute path yields a valid id that is not
    // stable across checkouts, rather than a silently rewritten one.
    const absolute = makeNodeId({ ...base, file: `${PROJECT_ROOT}/src/x.ts` });
    const relative = makeNodeId({ ...base, file: 'src/x.ts' });

    expect(absolute).toContain(PROJECT_ROOT);
    expect(absolute).not.toBe(relative);
  });

  it('gives every node of the sample graph a distinct id', () => {
    const ids = idsOf(SAMPLE_NODES);

    expect(new Set(ids).size).toBe(SAMPLE_NODES.length);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Identity: makeEdgeId
 * ---------------------------------------------------------------------------------------------- */

describe('makeEdgeId', () => {
  /** The input every case below varies one component of. */
  const base: EdgeIdInput = {
    kind: 'calls',
    from: HANDLER_NODE.id,
    to: API_CALL_NODE.id,
    line: 14,
    column: 11,
  };

  it('is deterministic across repeated calls with the same input', () => {
    const first = makeEdgeId(base);

    expect(makeEdgeId(base)).toBe(first);
    expect(makeEdgeId({ ...base })).toBe(first);
  });

  it('distinguishes inputs that differ in any single component', () => {
    const variants: readonly EdgeIdInput[] = [
      base,
      { ...base, kind: 'references' },
      { ...base, from: LIST_COMPONENT.id },
      { ...base, to: DB_CALL_NODE.id },
      { ...base, line: 15 },
      { ...base, column: 12 },
    ];

    const ids = variants.map(makeEdgeId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('distinguishes every kind at one position', () => {
    const ids = CODE_EDGE_KINDS.map((kind) => makeEdgeId({ ...base, kind }));

    expect(new Set(ids).size).toBe(CODE_EDGE_KINDS.length);
  });

  it('distinguishes a sited-nowhere edge from one sited at the origin', () => {
    const nowhere = makeEdgeId({ kind: 'routes-to', from: 'a', to: 'b' });
    const origin = makeEdgeId({ kind: 'routes-to', from: 'a', to: 'b', line: 0, column: 0 });

    expect(nowhere).toBe('routes-to:a>b@:');
    expect(origin).toBe('routes-to:a>b@0:0');
    expect(nowhere).not.toBe(origin);
  });

  it('distinguishes a missing line from a missing column', () => {
    const lineOnly = makeEdgeId({ kind: 'calls', from: 'a', to: 'b', line: 3 });
    const columnOnly = makeEdgeId({ kind: 'calls', from: 'a', to: 'b', column: 3 });

    expect(lineOnly).toBe('calls:a>b@3:');
    expect(columnOnly).toBe('calls:a>b@:3');
  });

  it('escapes both endpoints, so an endpoint cannot shift the separator', () => {
    const inFrom = makeEdgeId({ kind: 'calls', from: 'a>b', to: 'c' });
    const inTo = makeEdgeId({ kind: 'calls', from: 'a', to: 'b>c' });

    expect(inFrom).toBe('calls:a%3Eb>c@:');
    expect(inTo).toBe('calls:a>b%3Ec@:');
    expect(inFrom).not.toBe(inTo);
  });

  it('holds exactly one separator when its endpoints are real node ids', () => {
    const id = makeEdgeId(base);
    const separators = id.split('>').length - 1;

    expect(separators).toBe(1);
  });

  it('gives every edge of the sample graph a distinct id', () => {
    const ids = idsOf(SAMPLE_EDGES);

    expect(new Set(ids).size).toBe(SAMPLE_EDGES.length);
  });

  it('distinguishes two call sites of the same pair of nodes', () => {
    const first = makeEdgeId({ ...base, line: 14, column: 11 });
    const second = makeEdgeId({ ...base, line: 18, column: 11 });

    expect(first).not.toBe(second);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Construction: the envelope
 * ---------------------------------------------------------------------------------------------- */

describe('CodeGraph.fromIndex', () => {
  it('carries the envelope metadata through unchanged', () => {
    const graph = sampleGraph();

    expect(graph.schemaVersion).toBe(CODE_INDEX_SCHEMA_VERSION);
    expect(graph.projectRoot).toBe(PROJECT_ROOT);
    expect(graph.indexerVersion).toBe(INDEXER_VERSION);
    expect(graph.generatedAt).toBe(GENERATED_AT);
  });

  it('sorts file fingerprints byte-wise by project-relative path', () => {
    // Byte-wise, uppercase precedes lowercase; every locale's collation would
    // order `alpha` before `Beta` and `WidgetList`.
    expect(sampleGraph().files.map((entry) => entry.file)).toStrictEqual([
      'src/Beta.tsx',
      'src/WidgetList.tsx',
      'src/alpha.tsx',
      'src/server/items.ts',
    ]);
  });

  it('leaves the index it was given untouched', () => {
    const input = sampleIndex();
    const pristine = structuredClone(input);

    CodeGraph.fromIndex(input);

    expect(input).toStrictEqual(pristine);
    // Extractor order, specifically: a sort in place would have reordered these.
    expect(idsOf(input.nodes)).toStrictEqual(idsOf(SAMPLE_NODES));
    expect(idsOf(input.edges)).toStrictEqual(idsOf(SAMPLE_EDGES));
    expect(input.files.map((entry) => entry.file)).toStrictEqual(
      SAMPLE_FILES.map((entry) => entry.file),
    );
  });

  it('shares node and edge objects with the index rather than copying them', () => {
    const graph = sampleGraph();

    expect(graph.nodeById(FILE_NODE.id)).toBe(FILE_NODE);
    expect(graph.edges()).toContain(QUERIES_EDGE);
  });

  it('constructs an empty index and answers every lookup with an empty result', () => {
    const graph = CodeGraph.fromIndex(index());

    expect(graph.size).toStrictEqual({ nodes: 0, edges: 0 });
    expect(graph.nodes()).toStrictEqual([]);
    expect(graph.edges()).toStrictEqual([]);
    expect(graph.files).toStrictEqual([]);
    expect(graph.diagnostics).toStrictEqual([]);
    expect(graph.nodeById(FILE_NODE.id)).toBeUndefined();
    expect(graph.nodesByFile('src/WidgetList.tsx')).toStrictEqual([]);
    expect(graph.nodesByName('WidgetList')).toStrictEqual([]);
    expect(graph.outgoing(FILE_NODE.id)).toStrictEqual([]);
    expect(graph.incoming(FILE_NODE.id)).toStrictEqual([]);
    expect(graph.neighbors(FILE_NODE.id, { direction: 'both' })).toStrictEqual([]);

    for (const kind of CODE_NODE_KINDS) {
      expect(graph.nodesByKind(kind)).toStrictEqual([]);
    }
  });

  describe('duplicate node ids', () => {
    it('de-duplicates an identical restatement without a diagnostic', () => {
      // The same declaration seen twice by two extractor passes is not a
      // problem, and saying so would be noise.
      const restated = node('component', { line: 8, column: 1 });

      expect(restated.id).toBe(LIST_COMPONENT.id);

      const graph = CodeGraph.fromIndex(
        index({ nodes: [...SAMPLE_NODES, restated], edges: SAMPLE_EDGES, files: SAMPLE_FILES }),
      );

      expect(graph.size.nodes).toBe(SAMPLE_NODES.length);
      expect(graph.diagnostics).toStrictEqual([]);
    });

    it('keeps the first of two differing claimants and reports the conflict', () => {
      const conflicting = node('component', {
        line: 8,
        column: 1,
        data: { isClient: false, isDefaultExport: true, displayName: 'Something else' },
      });

      expect(conflicting.id).toBe(LIST_COMPONENT.id);

      const graph = CodeGraph.fromIndex(
        index({ nodes: [...SAMPLE_NODES, conflicting], edges: SAMPLE_EDGES, files: SAMPLE_FILES }),
      );

      expect(graph.size.nodes).toBe(SAMPLE_NODES.length);
      expect(graph.nodeById(LIST_COMPONENT.id)).toBe(LIST_COMPONENT);
      expect(graph.nodes()).not.toContain(conflicting);

      const diagnostic = onlyDiagnostic(graph.diagnostics, 'duplicate-node-id');

      expect(diagnostic.severity).toBe('warning');
      expect(diagnostic.message).toContain(LIST_COMPONENT.id);
      expect(diagnostic.file).toBe('src/WidgetList.tsx');
    });

    it('reports one finding when three nodes claim one id', () => {
      const second = node('component', {
        line: 8,
        column: 1,
        data: { isClient: false, isDefaultExport: false, displayName: 'Second' },
      });
      const third = node('component', {
        line: 8,
        column: 1,
        data: { isClient: false, isDefaultExport: false, displayName: 'Third' },
      });

      const graph = CodeGraph.fromIndex(index({ nodes: [LIST_COMPONENT, second, third] }));

      expect(graph.size.nodes).toBe(1);
      expect(graph.nodes()[0]).toBe(LIST_COMPONENT);
      // Both conflicts produce the identical sentence, and an identical
      // sentence repeated tells a reader nothing new.
      expect(codesOf(graph.diagnostics)).toStrictEqual(['duplicate-node-id']);
    });

    it('treats payloads nested deeper than the comparison bound as differing', () => {
      const first = withPayload(node('symbol'), nest(40));
      const second = withPayload(node('symbol'), nest(40));

      // The two payloads are structurally identical; the comparison gives up at
      // its depth bound and reports "not equal", which costs one diagnostic and
      // never a wrong result.
      const graph = CodeGraph.fromIndex(index({ nodes: [first, second] }));

      expect(graph.size.nodes).toBe(1);
      expect(codesOf(graph.diagnostics)).toStrictEqual(['duplicate-node-id']);
    });

    it('terminates on a cyclic payload instead of recursing forever', () => {
      const first: Record<string, unknown> = { declaration: 'function', isDefaultExport: false };
      first.self = first;

      const second: Record<string, unknown> = { declaration: 'function', isDefaultExport: false };
      second.self = second;

      const graph = CodeGraph.fromIndex(
        index({
          nodes: [withPayload(node('symbol'), first), withPayload(node('symbol'), second)],
        }),
      );

      expect(graph.size.nodes).toBe(1);
      expect(codesOf(graph.diagnostics)).toStrictEqual(['duplicate-node-id']);
    });
  });

  describe('duplicate edge ids', () => {
    it('de-duplicates an identical restatement without a diagnostic', () => {
      const restated = edge({
        kind: 'queries',
        from: SERVER_FUNCTION_NODE.id,
        to: DB_CALL_NODE.id,
        file: 'src/server/items.ts',
        line: 24,
        column: 5,
      });

      expect(restated.id).toBe(QUERIES_EDGE.id);

      const graph = CodeGraph.fromIndex(
        index({ nodes: SAMPLE_NODES, edges: [...SAMPLE_EDGES, restated], files: SAMPLE_FILES }),
      );

      expect(graph.size.edges).toBe(SAMPLE_EDGES.length);
      expect(graph.diagnostics).toStrictEqual([]);
    });

    it('keeps the first of two differing claimants and reports the conflict', () => {
      // `file` is provenance rather than identity, so two edges can differ in it
      // while claiming one id — exactly the case a reader has to be told about.
      const conflicting = edge({
        kind: 'queries',
        from: SERVER_FUNCTION_NODE.id,
        to: DB_CALL_NODE.id,
        file: 'src/server/other.ts',
        line: 24,
        column: 5,
      });

      expect(conflicting.id).toBe(QUERIES_EDGE.id);

      const graph = CodeGraph.fromIndex(
        index({ nodes: SAMPLE_NODES, edges: [...SAMPLE_EDGES, conflicting], files: SAMPLE_FILES }),
      );

      expect(graph.size.edges).toBe(SAMPLE_EDGES.length);
      expect(graph.edges()).toContain(QUERIES_EDGE);
      expect(graph.edges()).not.toContain(conflicting);

      const diagnostic = onlyDiagnostic(graph.diagnostics, 'duplicate-edge-id');

      expect(diagnostic.severity).toBe('warning');
      expect(diagnostic.message).toContain(QUERIES_EDGE.id);
      expect(diagnostic.file).toBe('src/server/other.ts');
    });
  });

  describe('dangling edges', () => {
    /** An id no node in the sample provides. */
    const absentFrom = makeNodeId({
      kind: 'symbol',
      file: 'src/gone.ts',
      name: 'gone',
      line: 1,
      column: 1,
    });

    /** A second absent id, for the case where both endpoints are missing. */
    const absentTo = makeNodeId({
      kind: 'symbol',
      file: 'src/gone.ts',
      name: 'alsoGone',
      line: 2,
      column: 1,
    });

    it('drops an edge whose `from` endpoint is absent and names the endpoint', () => {
      const dangling = edge({
        kind: 'queries',
        from: absentFrom,
        to: DB_CALL_NODE.id,
        file: 'src/gone.ts',
        line: 3,
        column: 1,
      });

      const graph = CodeGraph.fromIndex(
        index({ nodes: SAMPLE_NODES, edges: [...SAMPLE_EDGES, dangling], files: SAMPLE_FILES }),
      );

      expect(graph.size).toStrictEqual({ nodes: SAMPLE_NODES.length, edges: SAMPLE_EDGES.length });

      const diagnostic = onlyDiagnostic(graph.diagnostics, 'dangling-edge');

      expect(diagnostic.severity).toBe('warning');
      expect(diagnostic.message).toContain(dangling.id);
      expect(diagnostic.message).toContain('from endpoint');
      expect(diagnostic.file).toBe('src/gone.ts');
      expect(graph.incoming(DB_CALL_NODE.id)).not.toContain(dangling);
    });

    it('drops an edge whose `to` endpoint is absent and names the endpoint', () => {
      const dangling = edge({
        kind: 'calls',
        from: HANDLER_NODE.id,
        to: absentTo,
        file: 'src/WidgetList.tsx',
        line: 16,
        column: 5,
      });

      const graph = CodeGraph.fromIndex(
        index({ nodes: SAMPLE_NODES, edges: [...SAMPLE_EDGES, dangling], files: SAMPLE_FILES }),
      );

      expect(graph.size).toStrictEqual({ nodes: SAMPLE_NODES.length, edges: SAMPLE_EDGES.length });

      const diagnostic = onlyDiagnostic(graph.diagnostics, 'dangling-edge');

      expect(diagnostic.message).toContain('to endpoint');
      expect(idsOf(graph.outgoing(HANDLER_NODE.id))).not.toContain(dangling.id);
      expect(idsOf(graph.neighbors(HANDLER_NODE.id))).toStrictEqual([API_CALL_NODE.id]);
    });

    it('names both endpoints when neither is present', () => {
      const dangling = edge({ kind: 'references', from: absentFrom, to: absentTo });

      const graph = CodeGraph.fromIndex(
        index({ nodes: SAMPLE_NODES, edges: [...SAMPLE_EDGES, dangling], files: SAMPLE_FILES }),
      );

      const diagnostic = onlyDiagnostic(graph.diagnostics, 'dangling-edge');

      expect(diagnostic.message).toContain('from and to endpoint');
      // The edge carried no site, so there is no file to name.
      expect(diagnostic.file).toBeUndefined();
      expect(Object.hasOwn(diagnostic, 'file')).toBe(false);
    });
  });

  describe('unknown kinds', () => {
    it('drops a node whose kind is not in the live vocabulary', () => {
      const graph = CodeGraph.fromIndex(
        index({ nodes: [...SAMPLE_NODES, CORRUPT_NODE], edges: SAMPLE_EDGES, files: SAMPLE_FILES }),
      );

      expect(graph.size.nodes).toBe(SAMPLE_NODES.length);
      expect(graph.nodeById(CORRUPT_NODE.id)).toBeUndefined();

      const diagnostic = onlyDiagnostic(graph.diagnostics, 'unknown-node-kind');

      expect(diagnostic.severity).toBe('warning');
      expect(diagnostic.message).toContain(CORRUPT_NODE.id);
      expect(diagnostic.file).toBe('src/legacy.ts');
    });

    it('drops an edge whose kind is not in the live vocabulary', () => {
      const graph = CodeGraph.fromIndex(
        index({ nodes: SAMPLE_NODES, edges: [...SAMPLE_EDGES, CORRUPT_EDGE], files: SAMPLE_FILES }),
      );

      expect(graph.size.edges).toBe(SAMPLE_EDGES.length);
      expect(idsOf(graph.outgoing(FILE_NODE.id))).not.toContain(CORRUPT_EDGE.id);

      const diagnostic = onlyDiagnostic(graph.diagnostics, 'unknown-edge-kind');

      expect(diagnostic.severity).toBe('warning');
      expect(diagnostic.message).toContain(CORRUPT_EDGE.id);
      expect(diagnostic.file).toBe('src/WidgetList.tsx');
    });

    it('reports an edge into a dropped node as dangling, node findings first', () => {
      const intoDropped = edge({
        kind: 'declares',
        from: FILE_NODE.id,
        to: CORRUPT_NODE.id,
        file: 'src/WidgetList.tsx',
        line: 2,
        column: 1,
      });

      const graph = CodeGraph.fromIndex(
        index({
          nodes: [...SAMPLE_NODES, CORRUPT_NODE],
          edges: [...SAMPLE_EDGES, intoDropped],
          files: SAMPLE_FILES,
        }),
      );

      expect(graph.size).toStrictEqual({ nodes: SAMPLE_NODES.length, edges: SAMPLE_EDGES.length });
      // Nodes are selected before edges, so the node finding is recorded first.
      expect(codesOf(graph.diagnostics)).toStrictEqual(['unknown-node-kind', 'dangling-edge']);
      expect(onlyDiagnostic(graph.diagnostics, 'dangling-edge').message).toContain('to endpoint');
    });

    it('never throws on the shapes a corrupt cache entry can hold', () => {
      const corruptShapes: readonly CodeIndex[] = [
        index({ nodes: [{ ...FILE_NODE, kind: 'module' } as unknown as CodeNode] }),
        index({ nodes: [{ ...FILE_NODE, kind: 7 } as unknown as CodeNode] }),
        index({ nodes: [{ ...FILE_NODE, kind: null } as unknown as CodeNode] }),
        index({ nodes: [{ ...FILE_NODE, kind: { name: 'file' } } as unknown as CodeNode] }),
        // A kind the vocabulary knows, with the payload its kind promised
        // missing: dropped by no rule, and read by none either.
        index({ nodes: [{ ...LIST_COMPONENT, data: undefined } as unknown as CodeNode] }),
        index({ nodes: [{ ...FILE_NODE, id: undefined } as unknown as CodeNode] }),
        index({
          nodes: SAMPLE_NODES,
          edges: [{ ...QUERIES_EDGE, from: 42 } as unknown as CodeEdge],
        }),
        index({
          nodes: SAMPLE_NODES,
          edges: [{ ...QUERIES_EDGE, kind: 'uses' } as unknown as CodeEdge],
        }),
        index({ nodes: SAMPLE_NODES, edges: [CORRUPT_EDGE], files: SAMPLE_FILES }),
      ];

      for (const corrupt of corruptShapes) {
        expect(() => CodeGraph.fromIndex(corrupt)).not.toThrow();
        expect(CodeGraph.fromIndex(corrupt).size.nodes).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('schema version', () => {
    it('keeps a mismatched index usable, reports it, and records no diagnostic', () => {
      const { logger, lines } = createRecordingLogger();
      const declared = CODE_INDEX_SCHEMA_VERSION + 1;

      const graph = CodeGraph.fromIndex(
        index({
          schemaVersion: declared,
          nodes: SAMPLE_NODES,
          edges: SAMPLE_EDGES,
          files: SAMPLE_FILES,
        }),
        { logger },
      );

      expect(graph.schemaVersion).toBe(declared);
      expect(graph.size).toStrictEqual({ nodes: SAMPLE_NODES.length, edges: SAMPLE_EDGES.length });
      expect(graph.nodeById(LIST_COMPONENT.id)).toBe(LIST_COMPONENT);
      // The diagnostic vocabulary has no code for a version mismatch, and
      // borrowing another code's meaning would make the finding unattributable.
      expect(graph.diagnostics).toStrictEqual([]);

      const info = lines.filter((line) => line.level === 'info');

      expect(info).toHaveLength(1);
      expect(info[0]?.message).toContain('vocabulary version');
      expect(info[0]?.fields).toMatchObject({
        indexSchemaVersion: declared,
        expectedSchemaVersion: CODE_INDEX_SCHEMA_VERSION,
        indexerVersion: INDEXER_VERSION,
      });
      // `toIndex` must carry the declared version, not this build's: it is
      // `../cache.ts` that decides an entry is too old to reuse.
      expect(graph.toIndex().schemaVersion).toBe(declared);
    });

    it('reports nothing at info level for a matching version', () => {
      const { logger, lines } = createRecordingLogger();

      CodeGraph.fromIndex(sampleIndex(), { logger });

      expect(lines.filter((line) => line.level === 'info')).toHaveLength(0);
    });

    it('summarises what construction kept and dropped at debug level', () => {
      const { logger, lines } = createRecordingLogger();

      CodeGraph.fromIndex(
        index({
          nodes: [...SAMPLE_NODES, CORRUPT_NODE],
          edges: [...SAMPLE_EDGES, CORRUPT_EDGE],
          files: SAMPLE_FILES,
        }),
        { logger },
      );

      const debug = lines.filter((line) => line.level === 'debug');

      expect(debug).toHaveLength(1);
      expect(debug[0]?.fields).toMatchObject({
        nodes: SAMPLE_NODES.length,
        edges: SAMPLE_EDGES.length,
        droppedNodes: 1,
        droppedEdges: 1,
        diagnostics: 2,
      });
    });

    it('constructs without a logger', () => {
      expect(() => CodeGraph.fromIndex(sampleIndex())).not.toThrow();
      expect(() => CodeGraph.fromIndex(sampleIndex(), {})).not.toThrow();
    });
  });

  describe('diagnostics', () => {
    it("keeps the index's own findings first and construction's after them", () => {
      const own: readonly IndexDiagnostic[] = [
        {
          severity: 'info',
          code: 'file-skipped',
          message: 'src/skipped.ts was not indexed.',
          file: 'src/skipped.ts',
        },
        { severity: 'warning', code: 'limit-reached', message: 'Collection stopped early.' },
      ];

      const conflicting = node('component', {
        line: 8,
        column: 1,
        data: { isClient: false, isDefaultExport: false, displayName: 'Other' },
      });

      const graph = CodeGraph.fromIndex(
        index({ nodes: [LIST_COMPONENT, conflicting], diagnostics: own }),
      );

      expect(codesOf(graph.diagnostics)).toStrictEqual([
        'file-skipped',
        'limit-reached',
        'duplicate-node-id',
      ]);
      expect(graph.diagnostics[0]).toStrictEqual(own[0]);
    });

    it('de-duplicates by code, message and file, keeping the first occurrence', () => {
      const message = 'src/skipped.ts was not indexed.';
      const own: readonly IndexDiagnostic[] = [
        { severity: 'info', code: 'file-skipped', message, file: 'src/skipped.ts' },
        { severity: 'info', code: 'file-skipped', message, file: 'src/skipped.ts' },
        // Severity and detail are not part of a finding's identity, so this
        // collapses into the first entry rather than adding a second.
        {
          severity: 'error',
          code: 'file-skipped',
          message,
          file: 'src/skipped.ts',
          detail: 'permission denied',
        },
        // A different file is a different finding.
        { severity: 'info', code: 'file-skipped', message, file: 'src/other.ts' },
        // So is the same code with a different sentence.
        { severity: 'info', code: 'file-skipped', message: 'Another file was not indexed.' },
      ];

      const graph = CodeGraph.fromIndex(index({ diagnostics: own }));

      expect(graph.diagnostics).toHaveLength(3);
      expect(graph.diagnostics[0]?.severity).toBe('info');
      expect(graph.diagnostics[0]?.detail).toBeUndefined();
      expect(graph.diagnostics.map((diagnostic) => diagnostic.file)).toStrictEqual([
        'src/skipped.ts',
        'src/other.ts',
        undefined,
      ]);
    });

    it('is frozen, and shared as one empty list when there is nothing to report', () => {
      const clean = sampleGraph();

      expect(Object.isFrozen(clean.diagnostics)).toBe(true);
      expect(clean.diagnostics).toStrictEqual([]);
      expect(CodeGraph.fromIndex(index()).diagnostics).toBe(clean.diagnostics);
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * Adjacency
 * ---------------------------------------------------------------------------------------------- */

describe('CodeGraph.nodeById', () => {
  it('returns the exact node object for a known id', () => {
    const graph = sampleGraph();

    expect(graph.nodeById(LIST_COMPONENT.id)).toBe(LIST_COMPONENT);
    expect(graph.nodeById(DB_CALL_NODE.id)).toBe(DB_CALL_NODE);
  });

  it('returns undefined for an unknown id', () => {
    const graph = sampleGraph();

    expect(graph.nodeById('component:src/Absent.tsx#Absent@1:1')).toBeUndefined();
    expect(graph.nodeById('')).toBeUndefined();
    // Ids are opaque and compared whole: a prefix of one is not one.
    expect(graph.nodeById(LIST_COMPONENT.id.slice(0, -2))).toBeUndefined();
  });
});

describe('CodeGraph.nodesByKind', () => {
  it('returns every node of a kind in canonical id order', () => {
    const graph = sampleGraph();

    expect(idsOf(graph.nodesByKind('component'))).toStrictEqual([
      LIST_COMPONENT.id,
      ROW_COMPONENT.id,
    ]);
    expect(idsOf(graph.nodesByKind('db-call'))).toStrictEqual([DB_CALL_NODE.id]);
  });

  it('returns an empty array, never undefined, for a kind with no nodes', () => {
    const graph = sampleGraph();

    expect(graph.nodesByKind('symbol')).toStrictEqual([]);

    for (const kind of CODE_NODE_KINDS) {
      expect(Array.isArray(graph.nodesByKind(kind))).toBe(true);
    }
  });

  it('accounts for every node exactly once across the kinds', () => {
    const graph = sampleGraph();
    const perKind = CODE_NODE_KINDS.flatMap((kind) => idsOf(graph.nodesByKind(kind)));

    expect(perKind).toHaveLength(graph.size.nodes);
    expect(new Set(perKind)).toStrictEqual(new Set(idsOf(graph.nodes())));
  });

  it('narrows the element type to the kind that was asked for', () => {
    const graph = sampleGraph();

    // Every payload read below is reached without a cast and without optional
    // chaining on `data`, which is the compile-time half of this assertion: a
    // `nodesByKind` that returned `CodeNode[]` would not compile here.
    const [dbCall] = graph.nodesByKind('db-call');
    const [route] = graph.nodesByKind('api-route');
    const [component] = graph.nodesByKind('component');
    const [handler] = graph.nodesByKind('handler');
    const [call] = graph.nodesByKind('api-call');
    const [serverFunction] = graph.nodesByKind('server-function');

    expect(dbCall?.data.driver).toBe('prisma');
    expect(dbCall?.data.dynamic).toBe(false);
    expect(route?.data.methods).toStrictEqual(['GET']);
    expect(route?.data.routePath).toBe('/api/items');
    expect(component?.data.displayName).toBe('WidgetList');
    expect(handler?.data.event).toBe('click');
    expect(call?.data.url).toBe('/api/items');
    expect(serverFunction?.data.isAsync).toBe(true);
  });
});

describe('CodeGraph.nodesByFile', () => {
  it('returns every node declared in a project-relative path, in canonical order', () => {
    const graph = sampleGraph();

    expect(idsOf(graph.nodesByFile('src/WidgetList.tsx'))).toStrictEqual([
      API_CALL_NODE.id,
      LIST_COMPONENT.id,
      FILE_NODE.id,
      HANDLER_NODE.id,
    ]);
    expect(idsOf(graph.nodesByFile('src/server/items.ts'))).toStrictEqual([
      DB_CALL_NODE.id,
      SERVER_FUNCTION_NODE.id,
    ]);
  });

  it('returns an empty array for a path no node was declared in', () => {
    expect(sampleGraph().nodesByFile('src/Absent.tsx')).toStrictEqual([]);
  });

  it('performs no normalisation, so a differently spelled path simply misses', () => {
    const graph = sampleGraph();

    // Documented contract: the key is the path exactly as the nodes store it.
    // Normalising inside a hot lookup would hide the caller's bug and cost
    // every call, so the boundary that produced the path owns the spelling.
    expect(graph.nodesByFile('./src/WidgetList.tsx')).toStrictEqual([]);
    expect(graph.nodesByFile('/src/WidgetList.tsx')).toStrictEqual([]);
    expect(graph.nodesByFile(`${PROJECT_ROOT}/src/WidgetList.tsx`)).toStrictEqual([]);
    expect(graph.nodesByFile('src\\WidgetList.tsx')).toStrictEqual([]);
    expect(graph.nodesByFile('src/widgetlist.tsx')).toStrictEqual([]);
  });
});

describe('CodeGraph.nodesByName', () => {
  it('returns every node with exactly that name', () => {
    const graph = sampleGraph();

    expect(idsOf(graph.nodesByName('WidgetList'))).toStrictEqual([LIST_COMPONENT.id]);
    expect(idsOf(graph.nodesByName('WidgetList.tsx'))).toStrictEqual([FILE_NODE.id]);
  });

  it('is a multi-map: one name can name nodes in different files', () => {
    // A name is not unique — two files can declare the same symbol, and a
    // component and the file that declares it can share one.
    const declaration = node('symbol');
    const serverFunction = node('server-function');

    expect(declaration.name).toBe(serverFunction.name);
    expect(declaration.file).not.toBe(serverFunction.file);

    const graph = CodeGraph.fromIndex(index({ nodes: [declaration, serverFunction] }));

    expect(idsOf(graph.nodesByName('loadItems'))).toStrictEqual([
      serverFunction.id,
      declaration.id,
    ]);
  });

  it('is case-sensitive and returns an empty array for an unknown name', () => {
    const graph = sampleGraph();

    expect(graph.nodesByName('widgetlist')).toStrictEqual([]);
    expect(graph.nodesByName('Widget')).toStrictEqual([]);
    expect(graph.nodesByName('')).toStrictEqual([]);
  });
});

describe('CodeGraph.outgoing and CodeGraph.incoming', () => {
  it('return the edges at a node in canonical edge-id order', () => {
    const graph = sampleGraph();

    expect(idsOf(graph.outgoing(LIST_COMPONENT.id))).toStrictEqual([
      HANDLES_EDGE.id,
      RENDERS_EDGE.id,
    ]);
    expect(idsOf(graph.incoming(LIST_COMPONENT.id))).toStrictEqual([DECLARES_EDGE.id]);
    expect(idsOf(graph.incoming(DB_CALL_NODE.id))).toStrictEqual([QUERIES_EDGE.id]);
  });

  it('narrow to one edge kind when asked', () => {
    const graph = sampleGraph();

    expect(idsOf(graph.outgoing(LIST_COMPONENT.id, 'renders'))).toStrictEqual([RENDERS_EDGE.id]);
    expect(idsOf(graph.outgoing(LIST_COMPONENT.id, 'handles'))).toStrictEqual([HANDLES_EDGE.id]);
    expect(graph.outgoing(LIST_COMPONENT.id, 'queries')).toStrictEqual([]);
    expect(idsOf(graph.incoming(API_ROUTE_NODE.id, 'routes-to'))).toStrictEqual([
      ROUTES_TO_EDGE.id,
    ]);
    expect(graph.incoming(API_ROUTE_NODE.id, 'calls')).toStrictEqual([]);
  });

  it('partition a node’s edges across the kind vocabulary', () => {
    const graph = sampleGraph();

    for (const id of idsOf(graph.nodes())) {
      const outgoingByKind = CODE_EDGE_KINDS.reduce(
        (total, kind) => total + graph.outgoing(id, kind).length,
        0,
      );
      const incomingByKind = CODE_EDGE_KINDS.reduce(
        (total, kind) => total + graph.incoming(id, kind).length,
        0,
      );

      expect(outgoingByKind).toBe(graph.outgoing(id).length);
      expect(incomingByKind).toBe(graph.incoming(id).length);
    }
  });

  it('return the stored array itself when every edge matches the filter', () => {
    const graph = sampleGraph();

    // Allocation-free by contract: the filter returns its input unchanged when
    // nothing is removed, which is what keeps a traversal's common case free.
    expect(graph.outgoing(HANDLER_NODE.id, 'calls')).toBe(graph.outgoing(HANDLER_NODE.id));
    expect(graph.incoming(DB_CALL_NODE.id, 'queries')).toBe(graph.incoming(DB_CALL_NODE.id));
  });

  it('answer an unknown id with an empty array', () => {
    const graph = sampleGraph();

    expect(graph.outgoing('component:src/Absent.tsx#Absent@1:1')).toStrictEqual([]);
    expect(graph.incoming('component:src/Absent.tsx#Absent@1:1')).toStrictEqual([]);
    expect(graph.outgoing('component:src/Absent.tsx#Absent@1:1', 'calls')).toStrictEqual([]);
  });

  it('answer an isolated node with an empty array in both directions', () => {
    const isolated = node('symbol');
    const graph = CodeGraph.fromIndex(index({ nodes: [isolated] }));

    expect(graph.outgoing(isolated.id)).toStrictEqual([]);
    expect(graph.incoming(isolated.id)).toStrictEqual([]);
    expect(graph.neighbors(isolated.id, { direction: 'both' })).toStrictEqual([]);
  });

  it('answer the leaf and root of the sample chain in the one direction each has', () => {
    const graph = sampleGraph();

    expect(graph.incoming(FILE_NODE.id)).toStrictEqual([]);
    expect(graph.outgoing(DB_CALL_NODE.id)).toStrictEqual([]);
  });
});

describe('CodeGraph.neighbors', () => {
  it('follows edges forwards by default', () => {
    const graph = sampleGraph();

    expect(idsOf(graph.neighbors(LIST_COMPONENT.id))).toStrictEqual([
      ROW_COMPONENT.id,
      HANDLER_NODE.id,
    ]);
    expect(idsOf(graph.neighbors(LIST_COMPONENT.id, {}))).toStrictEqual([
      ROW_COMPONENT.id,
      HANDLER_NODE.id,
    ]);
    expect(idsOf(graph.neighbors(LIST_COMPONENT.id, { direction: 'out' }))).toStrictEqual([
      ROW_COMPONENT.id,
      HANDLER_NODE.id,
    ]);
  });

  it('follows edges backwards when asked', () => {
    const graph = sampleGraph();

    expect(idsOf(graph.neighbors(LIST_COMPONENT.id, { direction: 'in' }))).toStrictEqual([
      FILE_NODE.id,
    ]);
    expect(idsOf(graph.neighbors(API_ROUTE_NODE.id, { direction: 'in' }))).toStrictEqual([
      API_CALL_NODE.id,
    ]);
  });

  it('unions both directions in canonical node-id order', () => {
    const graph = sampleGraph();

    expect(idsOf(graph.neighbors(LIST_COMPONENT.id, { direction: 'both' }))).toStrictEqual([
      ROW_COMPONENT.id,
      FILE_NODE.id,
      HANDLER_NODE.id,
    ]);
  });

  it('narrows to one edge kind', () => {
    const graph = sampleGraph();

    expect(idsOf(graph.neighbors(LIST_COMPONENT.id, { kind: 'renders' }))).toStrictEqual([
      ROW_COMPONENT.id,
    ]);
    expect(idsOf(graph.neighbors(LIST_COMPONENT.id, { kind: 'handles' }))).toStrictEqual([
      HANDLER_NODE.id,
    ]);
    expect(
      idsOf(graph.neighbors(LIST_COMPONENT.id, { kind: 'declares', direction: 'in' })),
    ).toStrictEqual([FILE_NODE.id]);
    expect(graph.neighbors(LIST_COMPONENT.id, { kind: 'queries' })).toStrictEqual([]);
  });

  it('reports a neighbour reached by two edges of different kinds once', () => {
    // A file both declares and exports the component it declares: two edge
    // kinds the vocabulary sanctions between the same pair of nodes.
    const declares = edge({
      kind: 'declares',
      from: FILE_NODE.id,
      to: LIST_COMPONENT.id,
      file: 'src/WidgetList.tsx',
      line: 8,
      column: 1,
    });
    const exports = edge({
      kind: 'exports',
      from: FILE_NODE.id,
      to: LIST_COMPONENT.id,
      file: 'src/WidgetList.tsx',
      line: 8,
      column: 1,
    });

    const graph = CodeGraph.fromIndex(
      index({ nodes: [FILE_NODE, LIST_COMPONENT], edges: [declares, exports] }),
    );

    expect(graph.size.edges).toBe(2);
    expect(graph.outgoing(FILE_NODE.id)).toHaveLength(2);
    expect(graph.neighbors(FILE_NODE.id)).toStrictEqual([LIST_COMPONENT]);
  });

  it('reports a neighbour reached from both directions once', () => {
    const graph = CodeGraph.fromIndex(
      index({
        nodes: [LIST_COMPONENT, ROW_COMPONENT],
        edges: [
          RENDERS_EDGE,
          edge({
            kind: 'renders',
            from: ROW_COMPONENT.id,
            to: LIST_COMPONENT.id,
            file: 'src/WidgetRow.tsx',
            line: 9,
            column: 3,
          }),
        ],
      }),
    );

    expect(idsOf(graph.neighbors(LIST_COMPONENT.id, { direction: 'both' }))).toStrictEqual([
      ROW_COMPONENT.id,
    ]);
  });

  it('answers an unknown id with an empty array', () => {
    const graph = sampleGraph();

    expect(graph.neighbors('component:src/Absent.tsx#Absent@1:1')).toStrictEqual([]);
    expect(
      graph.neighbors('component:src/Absent.tsx#Absent@1:1', { direction: 'both' }),
    ).toStrictEqual([]);
  });

  it('visits the same neighbours in the same order however the index was ordered', () => {
    const forwards = CodeGraph.fromIndex(
      index({ nodes: SAMPLE_NODES, edges: SAMPLE_EDGES, files: SAMPLE_FILES }),
    );
    const backwards = CodeGraph.fromIndex(
      index({
        nodes: [...SAMPLE_NODES].reverse(),
        edges: [...SAMPLE_EDGES].reverse(),
        files: [...SAMPLE_FILES].reverse(),
      }),
    );

    for (const id of idsOf(forwards.nodes())) {
      expect(idsOf(backwards.neighbors(id, { direction: 'both' }))).toStrictEqual(
        idsOf(forwards.neighbors(id, { direction: 'both' })),
      );
    }
  });
});

describe('CodeGraph.size', () => {
  it('counts what the graph holds', () => {
    expect(sampleGraph().size).toStrictEqual({
      nodes: SAMPLE_NODES.length,
      edges: SAMPLE_EDGES.length,
    });
  });

  it('counts after de-duplication and dangling-edge removal, not before', () => {
    const restated = node('component', { line: 8, column: 1 });
    const conflicting = node('handler', {
      line: 12,
      column: 3,
      data: { event: 'submit', boundTo: 'form', inline: true },
    });
    const dangling = edge({
      kind: 'queries',
      from: SERVER_FUNCTION_NODE.id,
      to: 'db-call:src/server/gone.ts#findMany@1:1',
    });

    const graph = CodeGraph.fromIndex(
      index({
        nodes: [...SAMPLE_NODES, restated, conflicting, CORRUPT_NODE],
        edges: [...SAMPLE_EDGES, dangling, CORRUPT_EDGE],
        files: SAMPLE_FILES,
      }),
    );

    expect(graph.size).toStrictEqual({
      nodes: SAMPLE_NODES.length,
      edges: SAMPLE_EDGES.length,
    });
    expect(graph.nodes()).toHaveLength(graph.size.nodes);
    expect(graph.edges()).toHaveLength(graph.size.edges);
  });

  it('is pre-computed and frozen rather than assembled per call', () => {
    const graph = sampleGraph();

    expect(graph.size).toBe(graph.size);
    expect(Object.isFrozen(graph.size)).toBe(true);
  });
});

describe('CodeGraph immutability', () => {
  it('freezes every array it hands out', () => {
    const graph = sampleGraph();

    expect(Object.isFrozen(graph.nodes())).toBe(true);
    expect(Object.isFrozen(graph.edges())).toBe(true);
    expect(Object.isFrozen(graph.files)).toBe(true);
    expect(Object.isFrozen(graph.diagnostics)).toBe(true);
    expect(Object.isFrozen(graph.nodesByKind('component'))).toBe(true);
    expect(Object.isFrozen(graph.nodesByFile('src/WidgetList.tsx'))).toBe(true);
    expect(Object.isFrozen(graph.nodesByName('WidgetList'))).toBe(true);
    expect(Object.isFrozen(graph.outgoing(LIST_COMPONENT.id))).toBe(true);
    expect(Object.isFrozen(graph.outgoing(LIST_COMPONENT.id, 'renders'))).toBe(true);
    expect(Object.isFrozen(graph.incoming(LIST_COMPONENT.id))).toBe(true);
    expect(Object.isFrozen(graph.neighbors(LIST_COMPONENT.id, { direction: 'both' }))).toBe(true);
  });

  it('freezes the empty results too, since they are shared', () => {
    const graph = sampleGraph();

    expect(Object.isFrozen(graph.nodesByFile('src/Absent.tsx'))).toBe(true);
    expect(Object.isFrozen(graph.nodesByName('absent'))).toBe(true);
    expect(Object.isFrozen(graph.nodesByKind('symbol'))).toBe(true);
    expect(Object.isFrozen(graph.outgoing(DB_CALL_NODE.id))).toBe(true);
    expect(Object.isFrozen(graph.neighbors(DB_CALL_NODE.id))).toBe(true);
    // One shared instance per empty result, not a fresh allocation per miss.
    expect(graph.nodesByFile('src/Absent.tsx')).toBe(graph.nodesByName('absent'));
    expect(graph.outgoing(DB_CALL_NODE.id)).toBe(graph.incoming(FILE_NODE.id));
  });

  it('cannot be corrupted through a widened alias', () => {
    const graph = sampleGraph();
    const nodes = graph.nodes() as CodeNode[];
    const edges = graph.edges() as CodeEdge[];
    const bucket = graph.nodesByKind('component') as CodeNode[];
    const adjacency = graph.outgoing(LIST_COMPONENT.id) as CodeEdge[];

    expect(() => nodes.push(CORRUPT_NODE)).toThrow(TypeError);
    expect(() => nodes.pop()).toThrow(TypeError);
    expect(() => edges.push(CORRUPT_EDGE)).toThrow(TypeError);
    expect(() => bucket.splice(0, 1)).toThrow(TypeError);
    expect(() => adjacency.reverse()).toThrow(TypeError);

    expect(graph.size).toStrictEqual({
      nodes: SAMPLE_NODES.length,
      edges: SAMPLE_EDGES.length,
    });
    expect(idsOf(graph.nodesByKind('component'))).toStrictEqual([
      LIST_COMPONENT.id,
      ROW_COMPONENT.id,
    ]);
    expect(idsOf(graph.outgoing(LIST_COMPONENT.id))).toStrictEqual([
      HANDLES_EDGE.id,
      RENDERS_EDGE.id,
    ]);
  });
});

describe('CodeGraph lookup cost', () => {
  it('answers thousands of lookups from its pre-computed indices', () => {
    const generated: CodeNode[] = [];

    for (let position = 0; position < 2_000; position += 1) {
      generated.push(
        node('symbol', {
          file: `src/generated/module-${position}.ts`,
          name: `value${position}`,
        }),
      );
    }

    const edges: CodeEdge[] = [];

    for (let position = 1; position < generated.length; position += 1) {
      const previous = generated[position - 1];
      const current = generated[position];

      assertDefined(previous, 'generated predecessor');
      assertDefined(current, 'generated node');

      edges.push(
        edge({ kind: 'references', from: previous.id, to: current.id, line: 1, column: 1 }),
      );
    }

    const graph = CodeGraph.fromIndex(index({ nodes: generated, edges }));

    expect(graph.size).toStrictEqual({ nodes: generated.length, edges: edges.length });
    expect(graph.nodesByKind('symbol')).toHaveLength(generated.length);

    // A smoke check on the pre-computed indices, not a benchmark: the budget is
    // three orders of magnitude above what map reads cost, so it can only fail
    // if an accessor started scanning the graph.
    let resolved = 0;
    const started = Date.now();

    for (const target of generated) {
      if (graph.nodeById(target.id) !== undefined) {
        resolved += 1;
      }

      resolved += graph.outgoing(target.id).length;
      resolved += graph.nodesByFile(target.file).length;
    }

    const elapsed = Date.now() - started;

    expect(resolved).toBe(generated.length * 2 + edges.length);
    expect(elapsed).toBeLessThan(1_500);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The round trip
 * ---------------------------------------------------------------------------------------------- */

/** Two distinct findings, so the round trip has diagnostics to preserve. */
const CANONICAL_DIAGNOSTICS: readonly IndexDiagnostic[] = [
  {
    severity: 'info',
    code: 'file-skipped',
    message: 'src/skipped.ts was not indexed.',
    file: 'src/skipped.ts',
  },
  {
    severity: 'warning',
    code: 'unresolved-import',
    message: 'A specifier in src/WidgetList.tsx resolved to no project file.',
    file: 'src/WidgetList.tsx',
    extractorId: 'imports',
  },
];

/**
 * The sample as a **canonical** index: unique ids, every endpoint present,
 * known kinds, distinct diagnostics, and all three arrays already sorted the
 * way the graph sorts them.
 *
 * This is the exact input the losslessness contract is stated for, which is why
 * the sort here uses this file's own {@link byteCompare} rather than anything
 * the implementation supplies.
 *
 * @returns The canonical index.
 */
function canonicalIndex(): CodeIndex {
  return index({
    nodes: [...SAMPLE_NODES].sort((left, right) => byteCompare(left.id, right.id)),
    edges: [...SAMPLE_EDGES].sort((left, right) => byteCompare(left.id, right.id)),
    files: [...SAMPLE_FILES].sort((left, right) => byteCompare(left.file, right.file)),
    diagnostics: CANONICAL_DIAGNOSTICS,
  });
}

/** Whether a value is an array, keeping every element `unknown`. */
function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Whether a value is a non-null, non-array object. */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !isJsonArray(value);
}

/**
 * Every path in a value that `JSON.stringify` would change or drop.
 *
 * The round trip's contract is that an index is **plain JSON** — no `Map`,
 * `Set`, `Date`, class instance, function, present-but-undefined key or
 * non-finite number anywhere in it — and `JSON.parse(JSON.stringify(x))`
 * alone cannot prove that, because it is exactly the operation that silently
 * repairs every one of those. Walking the value and naming the offenders can.
 *
 * @param value The value to walk.
 * @param path Where in the value the walk is, for a readable failure.
 * @returns One description per offending position; empty when the value is
 * plain JSON.
 */
function nonJsonPaths(value: unknown, path = '$'): string[] {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return [];
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? [] : [`${path}: non-finite number`];
  }

  if (isJsonArray(value)) {
    return value.flatMap((entry, position) => nonJsonPaths(entry, `${path}[${position}]`));
  }

  if (!isObject(value)) {
    return [`${path}: ${typeof value}`];
  }

  const prototype = Reflect.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    return [`${path}: not a plain object`];
  }

  const record = value as Record<string, unknown>;

  return Object.keys(record).flatMap((key) => {
    const entry = record[key];

    if (entry === undefined) {
      return [`${path}.${key}: present but undefined`];
    }

    return nonJsonPaths(entry, `${path}.${key}`);
  });
}

describe('CodeGraph.toIndex', () => {
  it('round-trips a canonical index deep-equal and byte-identical', () => {
    const input = canonicalIndex();
    const output = CodeGraph.fromIndex(input).toIndex();

    expect(output).toStrictEqual(input);
    // `../cache.ts` byte-compares persisted entries, so field order is part of
    // the contract and deep equality alone would not establish it.
    expect(JSON.stringify(output)).toBe(JSON.stringify(input));
  });

  it('preserves the envelope metadata, the fingerprints and the diagnostics', () => {
    const output = CodeGraph.fromIndex(canonicalIndex()).toIndex();

    expect(output.schemaVersion).toBe(CODE_INDEX_SCHEMA_VERSION);
    expect(output.projectRoot).toBe(PROJECT_ROOT);
    expect(output.indexerVersion).toBe(INDEXER_VERSION);
    expect(output.generatedAt).toBe(GENERATED_AT);
    expect(output.files).toStrictEqual(
      [...SAMPLE_FILES].sort((left, right) => byteCompare(left.file, right.file)),
    );
    expect(output.diagnostics).toStrictEqual(CANONICAL_DIAGNOSTICS);
  });

  it('hands out the graph’s own arrays rather than copies of them', () => {
    const graph = CodeGraph.fromIndex(canonicalIndex());
    const output = graph.toIndex();

    expect(output.nodes).toBe(graph.nodes());
    expect(output.edges).toBe(graph.edges());
    expect(output.files).toBe(graph.files);
    expect(output.diagnostics).toBe(graph.diagnostics);
  });

  it('normalises an arbitrarily ordered index into canonical order', () => {
    const graph = sampleGraph();

    expect(idsOf(graph.nodes())).toStrictEqual([
      API_CALL_NODE.id,
      API_ROUTE_NODE.id,
      LIST_COMPONENT.id,
      ROW_COMPONENT.id,
      DB_CALL_NODE.id,
      FILE_NODE.id,
      HANDLER_NODE.id,
      SERVER_FUNCTION_NODE.id,
    ]);
    expect(idsOf(graph.edges())).toStrictEqual([
      CALLS_SERVER_EDGE.id,
      CALLS_API_EDGE.id,
      DECLARES_EDGE.id,
      HANDLES_EDGE.id,
      QUERIES_EDGE.id,
      RENDERS_EDGE.id,
      ROUTES_TO_EDGE.id,
    ]);

    const output = graph.toIndex();

    expect(idsOf(output.nodes)).toStrictEqual(idsOf(graph.nodes()));
    expect(idsOf(output.edges)).toStrictEqual(idsOf(graph.edges()));
  });

  it('orders strictly ascending, and byte-wise rather than by collation', () => {
    const graph = sampleGraph();
    const nodeIds = idsOf(graph.nodes());
    const edgeIds = idsOf(graph.edges());
    const files = graph.files.map((entry) => entry.file);

    for (const sequence of [nodeIds, edgeIds, files]) {
      for (let position = 1; position < sequence.length; position += 1) {
        const previous = sequence[position - 1];
        const current = sequence[position];

        assertDefined(previous, 'preceding entry');
        assertDefined(current, 'current entry');

        expect(byteCompare(previous, current)).toBeLessThan(0);
      }
    }
  });

  it('puts an uppercase path before a lowercase one, as bytes and not as words', () => {
    // Every locale's collation orders `alpha` before `Beta`; byte order does
    // not. An implementation that reached for `localeCompare` fails here rather
    // than on another machine, where a persisted index would stop matching.
    const beta = node('component', {
      file: 'src/Beta.tsx',
      name: 'Beta',
      data: { isClient: false, isDefaultExport: false, displayName: 'Beta' },
    });
    const alpha = node('component', {
      file: 'src/alpha.tsx',
      name: 'alpha',
      data: { isClient: false, isDefaultExport: false, displayName: 'alpha' },
    });

    const graph = CodeGraph.fromIndex(
      index({
        nodes: [alpha, beta],
        files: [fingerprint('src/alpha.tsx'), fingerprint('src/Beta.tsx')],
      }),
    );

    expect(idsOf(graph.nodes())).toStrictEqual([beta.id, alpha.id]);
    expect(graph.files.map((entry) => entry.file)).toStrictEqual(['src/Beta.tsx', 'src/alpha.tsx']);
  });

  it('returns plain JSON', () => {
    const output = CodeGraph.fromIndex(canonicalIndex()).toIndex();

    expect(nonJsonPaths(output)).toStrictEqual([]);
    expect(JSON.parse(JSON.stringify(output))).toStrictEqual(output);
  });

  it('detects the values a plain-JSON walk must reject', () => {
    // The control for the assertion above: "no violations found" must not be
    // able to mean "the walk looks at nothing".
    const findings = nonJsonPaths({
      when: new Date(0),
      seen: new Map([['a', 1]]),
      kinds: new Set(['file']),
      run: (): number => 1,
      missing: undefined,
      ratio: Number.NaN,
      nested: [{ deep: new Date(0) }],
    });

    expect(findings).toHaveLength(7);
    expect(findings.join(' ')).toContain('$.when');
    expect(findings.join(' ')).toContain('$.run: function');
    expect(findings.join(' ')).toContain('$.missing: present but undefined');
    expect(findings.join(' ')).toContain('$.ratio: non-finite number');
    expect(findings.join(' ')).toContain('$.nested[0].deep');
  });

  it('omits the diagnostics field entirely when there is nothing to report', () => {
    const output = CodeGraph.fromIndex(sampleIndex()).toIndex();

    expect(Object.hasOwn(output, 'diagnostics')).toBe(false);
    expect(output.diagnostics).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain('diagnostics');
  });

  it('omits the diagnostics field when the input carried an empty list', () => {
    // A clean index carries no empty-array noise, whichever way it arrived.
    const output = CodeGraph.fromIndex(index({ diagnostics: [] })).toIndex();

    expect(Object.hasOwn(output, 'diagnostics')).toBe(false);
    expect(JSON.stringify(output)).toBe(JSON.stringify(index()));
  });

  it('is stable under a second round trip', () => {
    const input = canonicalIndex();
    const once = CodeGraph.fromIndex(input).toIndex();
    const twice = CodeGraph.fromIndex(once).toIndex();

    expect(twice).toStrictEqual(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(input));
  });

  it('repairs a malformed index into a fixed point', () => {
    const conflicting = node('component', {
      line: 8,
      column: 1,
      data: { isClient: false, isDefaultExport: false, displayName: 'Other' },
    });
    const dangling = edge({
      kind: 'queries',
      from: SERVER_FUNCTION_NODE.id,
      to: 'db-call:src/server/gone.ts#findMany@1:1',
      file: 'src/server/items.ts',
      line: 40,
      column: 3,
    });

    const malformed = index({
      nodes: [...SAMPLE_NODES, conflicting, CORRUPT_NODE],
      edges: [...SAMPLE_EDGES, dangling, CORRUPT_EDGE],
      files: SAMPLE_FILES,
    });

    const once = CodeGraph.fromIndex(malformed).toIndex();

    // The repair — not the malformed envelope — is what `../indexer.ts`
    // persists, so the findings travel with it and are not rediscovered on
    // every load.
    expect(once.nodes).toHaveLength(SAMPLE_NODES.length);
    expect(once.edges).toHaveLength(SAMPLE_EDGES.length);
    expect(codesOf(once.diagnostics ?? [])).toStrictEqual([
      'duplicate-node-id',
      'unknown-node-kind',
      'dangling-edge',
      'unknown-edge-kind',
    ]);

    const twice = CodeGraph.fromIndex(once).toIndex();

    expect(twice).toStrictEqual(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    // Reloading the repaired index finds nothing new and repeats nothing.
    expect(codesOf(twice.diagnostics ?? [])).toStrictEqual(codesOf(once.diagnostics ?? []));
    expect(nonJsonPaths(twice)).toStrictEqual([]);
  });

  it('serialises two independently built, equal indices identically', () => {
    /**
     * A two-node index built from scratch, so that both sides of the comparison
     * run the real identity functions rather than sharing one result.
     *
     * @param order Which way round the arrays are handed in.
     * @returns The index.
     */
    const build = (order: 'forwards' | 'backwards'): CodeIndex => {
      const declaration = node('symbol', { file: 'src/server/items.ts', line: 18, column: 1 });
      const query = node('db-call');
      const link = edge({
        kind: 'queries',
        from: declaration.id,
        to: query.id,
        file: 'src/server/items.ts',
        line: 24,
        column: 5,
      });
      const nodes = order === 'forwards' ? [declaration, query] : [query, declaration];

      return index({ nodes, edges: [link], files: [fingerprint('src/server/items.ts', 2_048)] });
    };

    const left = CodeGraph.fromIndex(build('forwards')).toIndex();
    const right = CodeGraph.fromIndex(build('backwards')).toIndex();

    expect(left).toStrictEqual(right);
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });

  it('serialises the whole sample identically from two separate object graphs', () => {
    const cloned = (reversed: boolean): CodeIndex => {
      const nodes = structuredClone([...SAMPLE_NODES]);
      const edges = structuredClone([...SAMPLE_EDGES]);
      const files = structuredClone([...SAMPLE_FILES]);

      return index({
        nodes: reversed ? nodes.reverse() : nodes,
        edges: reversed ? edges.reverse() : edges,
        files: reversed ? files.reverse() : files,
      });
    };

    const left = CodeGraph.fromIndex(cloned(false)).toIndex();
    const right = CodeGraph.fromIndex(cloned(true)).toIndex();

    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });

  it('lets only generatedAt differ between two runs over unchanged input', () => {
    const at = (generatedAt: number): CodeIndex =>
      index({
        generatedAt,
        nodes: SAMPLE_NODES,
        edges: SAMPLE_EDGES,
        files: SAMPLE_FILES,
      });

    const first = CodeGraph.fromIndex(at(GENERATED_AT)).toIndex();
    const second = CodeGraph.fromIndex(at(1_776_000_000_001)).toIndex();

    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
    expect({ ...second, generatedAt: GENERATED_AT }).toStrictEqual(first);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The queries this container is read through
 *
 * `./query.ts` is the surface AAP 0.4.2 puts in front of a model, and three of
 * its properties are contracts between it and the extractors rather than
 * properties of either: whether a path can be read as a flow, whether a
 * relationship an extractor declines to record leaves a query unable to answer,
 * and whether an argument a model wrote can reach an implementation that
 * assumed a well-typed one.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A node id for a hand-authored node, so a case can name an endpoint without
 * holding the node.
 *
 * @param target The node.
 * @returns Its id.
 */
function idOf(target: CodeNode): string {
  return target.id;
}

/**
 * The `(from → to)` pairs of a path's hops, each marked when the walk took it
 * backwards.
 *
 * Reported as names rather than ids because an id is unreadable in a failure
 * message and the names in these fixtures are unique.
 *
 * @param path The path to describe.
 * @param graph The graph the path came from.
 * @returns One string per hop.
 */
function hopsOf(path: CodePath, graph: CodeGraph): string[] {
  return path.edges.map((hop) => {
    const from = graph.nodeById(hop.from);
    const to = graph.nodeById(hop.to);
    const mark = hop.traversedAgainstDirection ? ' (against)' : '';

    return `${hop.kind} ${from?.name ?? hop.from}→${to?.name ?? hop.to}${mark}`;
  });
}

/**
 * Whether every hop of a path joins the two nodes it sits between, in one
 * orientation or the other.
 *
 * This is the invariant a consumer can rely on for *any* path, directed or not
 * — the edge list is a walk of the node list — and it is what makes
 * `traversedAgainstDirection` enough to read a path correctly.
 *
 * @param path The path to check.
 * @returns `true` when the walk holds at every hop.
 */
function walksNodeList(path: CodePath): boolean {
  return path.edges.every((hop, position) => {
    const left = path.nodes[position];
    const right = path.nodes[position + 1];
    if (left === undefined || right === undefined) {
      return false;
    }

    return hop.traversedAgainstDirection
      ? hop.from === right.nodeId && hop.to === left.nodeId
      : hop.from === left.nodeId && hop.to === right.nodeId;
  });
}

describe('createCodeQueries.pathBetween — a path is only a flow when it is a directed one', () => {
  /*
   * Two routes that call one shared helper, and one of them also reaches a
   * query through a function of its own:
   *
   *   /api/left  --calls-->  shared  <--calls--  /api/right --calls--> readRight --queries--> SQL
   *
   * Nothing downstream connects `/api/left` to the query, so the only way for
   * an undirected search to get from one to the other is to walk the
   * `/api/right → shared` edge **backwards**. That is the shape that used to
   * come back looking exactly like a call chain: four hops, two of which did
   * not join head to tail, asserting a flow the source does not contain.
   */
  const leftRoute = node('api-route', {
    file: 'src/app/api/left/route.ts',
    name: 'GET',
    data: {
      routePath: '/api/left',
      router: 'app',
      kind: 'route-handler',
      methods: ['GET'],
    },
  });
  const rightRoute = node('api-route', {
    file: 'src/app/api/right/route.ts',
    name: 'POST',
    data: {
      routePath: '/api/right',
      router: 'app',
      kind: 'route-handler',
      methods: ['POST'],
    },
  });
  const shared = node('server-function', { file: 'src/server/shared.ts', name: 'shared' });
  const readRight = node('server-function', { file: 'src/server/right.ts', name: 'readRight' });
  const query = node('db-call', {
    file: 'src/server/right.ts',
    name: 'pool.query',
    line: 12,
    data: { driver: 'pg', operation: 'query', dynamic: false },
  });

  const edges: readonly CodeEdge[] = [
    edge({
      kind: 'calls',
      from: idOf(leftRoute),
      to: idOf(shared),
      file: 'src/app/api/left/route.ts',
      line: 4,
      column: 3,
    }),
    edge({
      kind: 'calls',
      from: idOf(rightRoute),
      to: idOf(shared),
      file: 'src/app/api/right/route.ts',
      line: 6,
      column: 3,
    }),
    edge({
      kind: 'calls',
      from: idOf(rightRoute),
      to: idOf(readRight),
      file: 'src/app/api/right/route.ts',
      line: 7,
      column: 3,
    }),
    edge({
      kind: 'queries',
      from: idOf(readRight),
      to: idOf(query),
      file: 'src/server/right.ts',
      line: 12,
      column: 9,
    }),
  ];

  const graph = CodeGraph.fromIndex(
    index({ nodes: [leftRoute, rightRoute, shared, readRight, query], edges }),
  );
  const queries = createCodeQueries(graph);

  it('marks the hop an undirected search walked backwards, and marks the path undirected', () => {
    const path = queries.pathBetween(idOf(leftRoute), idOf(query), { direction: 'both' });

    assertDefined(path, 'the undirected search must find the shared helper');
    expect(path.undirected).toBe(true);
    expect(hopsOf(path, graph)).toStrictEqual([
      'calls GET→shared',
      'calls POST→shared (against)',
      'calls POST→readRight',
      'queries readRight→pool.query',
    ]);
  });

  it('keeps every hop a walk of the node list, which the reversed hop alone would break', () => {
    const path = queries.pathBetween(idOf(leftRoute), idOf(query), { direction: 'both' });

    assertDefined(path, 'the undirected search must find the shared helper');
    expect(walksNodeList(path)).toBe(true);

    // The reading that used to be the only one available, kept as the control:
    // chaining the hops by their own endpoints genuinely does not hold here, so
    // a consumer needs the flag rather than the chain.
    const chains = path.edges.every((hop, position) => {
      const next = path.edges[position + 1];

      return next === undefined || hop.to === next.from;
    });
    expect(chains).toBe(false);
  });

  it('reports a downstream path as directed, with no hop against the direction', () => {
    const path = queries.pathBetween(idOf(rightRoute), idOf(query));

    assertDefined(path, 'the route reaches the query downstream');
    expect(path.undirected).toBe(false);
    expect(path.edges.map((hop) => hop.traversedAgainstDirection)).toStrictEqual([false, false]);
    expect(walksNodeList(path)).toBe(true);
    expect(hopsOf(path, graph)).toStrictEqual([
      'calls POST→readRight',
      'queries readRight→pool.query',
    ]);
  });

  it('answers a single-node path with no hops and the direction it was asked in', () => {
    const directed = queries.pathBetween(idOf(shared), idOf(shared));
    const undirected = queries.pathBetween(idOf(shared), idOf(shared), { direction: 'both' });

    assertDefined(directed, 'a node reaches itself');
    assertDefined(undirected, 'a node reaches itself');
    expect(directed).toMatchObject({ depth: 0, undirected: false, edges: [] });
    expect(undirected).toMatchObject({ depth: 0, undirected: true, edges: [] });
  });

  it('keeps the edge site on the edge’s own origin, whichever way the walk went', () => {
    const path = queries.pathBetween(idOf(leftRoute), idOf(query), { direction: 'both' });

    assertDefined(path, 'the undirected search must find the shared helper');
    const reversed = path.edges[1];
    assertDefined(reversed, 'the second hop is the reversed one');
    expect(reversed.traversedAgainstDirection).toBe(true);
    expect(reversed.location).toMatchObject({
      file: 'src/app/api/right/route.ts',
      line: 6,
      column: 3,
      resolvedBy: 'code-graph',
    });
  });
});

describe('createCodeQueries — arguments of unknown provenance', () => {
  /*
   * AAP 0.4.2 has a model propose these queries and
   * `apps/local-service/src/pipeline/tools/code-tools.ts` execute them, so
   * `{"name": null}` is an ordinary input and AAP 0.5.5 requires the stage to
   * degrade instead of failing. Every entry point must therefore be total over
   * *values*, not merely over the types it declares — which is what this suite
   * pins, argument by argument, with the same nine values TypeScript would have
   * rejected at a well-typed call site.
   */
  const hostile: readonly unknown[] = [undefined, null, '', 0, 123, {}, [], () => 1, Symbol('x')];

  /**
   * The queries under test, and the empty answer each one owes for an argument
   * it cannot use.
   *
   * @param queries The surface to call.
   * @returns One entry per probe.
   */
  function probes(queries: CodeQueries): readonly {
    readonly label: string;
    readonly run: (value: unknown) => unknown;
    readonly empty: unknown;
  }[] {
    return [
      {
        label: 'findByName(name)',
        run: (value) => queries.findByName(value as string),
        empty: [],
      },
      {
        label: 'findSymbol(file, symbol)',
        run: (value) => queries.findSymbol('src/server/items.ts', value as string),
        empty: undefined,
      },
      {
        label: 'findSymbol(file)',
        run: (value) => queries.findSymbol(value as string, 'loadItems'),
        empty: undefined,
      },
      {
        label: 'hasSymbol(file, symbol)',
        run: (value) => queries.hasSymbol('src/server/items.ts', value as string),
        empty: false,
      },
      {
        label: 'hasSymbol(file)',
        run: (value) => queries.hasSymbol(value as string, 'loadItems'),
        empty: false,
      },
      {
        label: 'whoCalls(target)',
        run: (value) => queries.whoCalls(value as string),
        empty: [],
      },
      {
        label: 'routeForUrl(url)',
        run: (value) => queries.routeForUrl(value as string),
        empty: undefined,
      },
      {
        label: 'handlersFor(url)',
        run: (value) => queries.handlersFor(value as string),
        empty: [],
      },
      {
        label: 'componentsRendering(component)',
        run: (value) => queries.componentsRendering(value as string),
        empty: [],
      },
      {
        label: 'pathBetween(from, to)',
        run: (value) => queries.pathBetween(value as string, value as string),
        empty: undefined,
      },
      {
        label: 'excerpt(target)',
        run: (value) => queries.excerpt(value as string),
        empty: undefined,
      },
    ];
  }

  it('answers every entry point with its empty result instead of throwing', () => {
    const queries = createCodeQueries(sampleGraph());
    const thrown: string[] = [];
    const wrong: string[] = [];

    for (const probe of probes(queries)) {
      for (const value of hostile) {
        try {
          expect(probe.run(value)).toStrictEqual(probe.empty);
        } catch (error) {
          // An assertion failure and a throw from the query are both failures,
          // and the message has to say which: a wrong answer is a contract
          // problem, a throw is the crash this suite exists to prevent.
          const cause = error instanceof Error ? error.message : String(error);
          (cause.startsWith('expected') ? wrong : thrown).push(
            `${probe.label} with ${typeof value === 'symbol' ? 'Symbol()' : String(JSON.stringify(value) ?? value)}: ${cause.split('\n')[0] ?? ''}`,
          );
        }
      }
    }

    expect({ thrown, wrong }).toStrictEqual({ thrown: [], wrong: [] });
  });

  it('records the refusal at debug level, naming the query and the argument by type only', () => {
    const recorder = createRecordingLogger();
    const queries = createCodeQueries(sampleGraph(), { logger: recorder.logger });

    queries.findByName(null as unknown as string);

    const refusal = recorder.lines.find(
      (line) =>
        line.message === 'refused a query argument that is not the shape the query declares',
    );
    assertDefined(refusal, 'a refused argument must be recorded');
    expect(refusal.level).toBe('debug');
    expect(refusal.fields).toStrictEqual({
      query: 'findByName',
      argument: 'name',
      received: 'null',
    });
  });

  it('reads one kind name where a list of kinds was declared', () => {
    const queries = createCodeQueries(sampleGraph());

    const repaired = queries.findByName('WidgetList', {
      kinds: 'component' as unknown as readonly CodeNodeKind[],
    });

    expect(repaired.map((match: CodeMatch) => match.kind)).toStrictEqual(['component']);
  });

  it('narrows to nothing rather than widening when a kind filter cannot be honoured', () => {
    const queries = createCodeQueries(sampleGraph());

    expect(
      queries.findByName('WidgetList', { kinds: 123 as unknown as readonly CodeNodeKind[] }),
    ).toStrictEqual([]);
    expect(
      queries.findByName('WidgetList', {
        kinds: ['nonsense'] as unknown as readonly CodeNodeKind[],
      }),
    ).toStrictEqual([]);
    // The control: the same call with the filter absent does find the component,
    // so the empty answers above are the filter's doing and not the name's.
    expect(queries.findByName('WidgetList').length).toBeGreaterThan(0);
  });

  it('ignores an edge-kind filter that names nothing, without crashing the search', () => {
    const queries = createCodeQueries(sampleGraph());

    // A filter naming no known edge kind is an unhonourable narrowing, which is
    // the documented "matches nothing" rather than an unfiltered search.
    expect(
      queries.pathBetween(API_ROUTE_NODE.id, SERVER_FUNCTION_NODE.id, {
        edgeKinds: 'nonsense' as unknown as readonly CodeEdgeKind[],
      }),
    ).toBeUndefined();
    // Spelled as a single valid kind, the same shape is repaired and answers.
    expect(
      queries.pathBetween(API_ROUTE_NODE.id, SERVER_FUNCTION_NODE.id, {
        edgeKinds: 'calls' as unknown as readonly CodeEdgeKind[],
      }),
    ).toMatchObject({ depth: 1, undirected: false });
  });

  it('keeps refusing a selector that describes no node at all', () => {
    const queries = createCodeQueries(sampleGraph());

    expect(queries.pathBetween({}, { kind: 'db-call' })).toBeUndefined();
    expect(
      queries.pathBetween({ name: 123 as unknown as string }, { kind: 'db-call' }),
    ).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------------------------------
 * A miniature project of this suite's own
 *
 * Two properties below belong to neither an extractor nor a query on its own:
 * an extractor records a relationship and a query answers with it, so a graph
 * hand-authored here could only restate whatever the query was given. Both are
 * therefore asserted against a project written to disk and indexed through the
 * real `openProject`/`indexProject` path.
 *
 * The project is deliberately tiny and entirely neutral — a trend chip, a
 * ledger, a settle step — with a hand-written pooled-driver stand-in beside it
 * so nothing is installed, built or executed. `react` is imported and never
 * resolves, which is immaterial: every extractor reads syntax.
 * ---------------------------------------------------------------------------------------------- */

/** The files of the miniature project, by project-relative POSIX path. */
const MINIATURE_PROJECT: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'tsconfig.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['dom', 'ES2022'],
          jsx: 'preserve',
          module: 'esnext',
          moduleResolution: 'bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          isolatedModules: true,
        },
        include: ['**/*.ts', '**/*.tsx'],
        exclude: ['node_modules'],
      },
      undefined,
      2,
    )}\n`,
  ],

  // ---- The memoised-component half ----------------------------------------
  //
  // The exported binding is the wrapper call and the function is declared under
  // another name, which is the shape a `memo(...)` export always has. A parent
  // renders the exported binding, so the `renders` edge and the component node
  // have to meet on it.
  [
    'src/widgets/TrendChip.tsx',
    [
      `'use client';`,
      ``,
      `import { memo } from 'react';`,
      ``,
      `interface TrendChipProps {`,
      `  readonly label: string;`,
      `}`,
      ``,
      `function TrendChipBody(props: TrendChipProps) {`,
      `  return <span className="chip">{props.label}</span>;`,
      `}`,
      ``,
      `export const TrendChip = memo(TrendChipBody);`,
      ``,
    ].join('\n'),
  ],
  [
    // The same shape with an explicit runtime display name, which is a third
    // name for one component and must not displace either of the other two.
    'src/widgets/StampBadge.tsx',
    [
      `'use client';`,
      ``,
      `import { memo } from 'react';`,
      ``,
      `function StampBadgeBody() {`,
      `  return <b>stamp</b>;`,
      `}`,
      ``,
      `export const StampBadge = memo(StampBadgeBody);`,
      ``,
      `StampBadge.displayName = 'StampBadgeChip';`,
      ``,
    ].join('\n'),
  ],
  [
    'src/widgets/TrendPanel.tsx',
    [
      `'use client';`,
      ``,
      `import { StampBadge } from './StampBadge';`,
      `import { TrendChip } from './TrendChip';`,
      ``,
      `export function TrendPanel() {`,
      `  return (`,
      `    <div>`,
      `      <TrendChip label="steady" />`,
      `      <StampBadge />`,
      `    </div>`,
      `  );`,
      `}`,
      ``,
    ].join('\n'),
  ],

  // ---- The module-private-callee half -------------------------------------
  [
    'src/lib/driver.ts',
    [
      `export interface QueryResult {`,
      `  rows: Record<string, unknown>[];`,
      `  rowCount: number;`,
      `}`,
      ``,
      `export class Pool {`,
      `  query(text: string, values?: unknown[]): Promise<QueryResult> {`,
      `    void text;`,
      `    void values;`,
      `    return Promise.resolve({ rows: [], rowCount: 0 });`,
      `  }`,
      `}`,
      ``,
    ].join('\n'),
  ],
  [
    'src/lib/store.ts',
    [`import { Pool } from './driver';`, ``, `export const pool = new Pool();`, ``].join('\n'),
  ],
  [
    'src/lib/ledger.ts',
    [
      `import { pool } from './store';`,
      ``,
      `export async function readLedger(key: string): Promise<number> {`,
      `  const result = await pool.query('SELECT total FROM ledger WHERE key = $1', [key]);`,
      `  return result.rowCount;`,
      `}`,
      ``,
    ].join('\n'),
  ],
  [
    // Three module-private bindings and one nested one, so that the edge this
    // module is here to prove is asserted beside the three shapes that must
    // *not* produce one.
    'src/lib/settle.ts',
    [
      `import { readLedger } from './ledger';`,
      ``,
      `async function attempt(key: string): Promise<number> {`,
      `  return readLedger(key);`,
      `}`,
      ``,
      `const retry = async (key: string): Promise<number> => attempt(key);`,
      ``,
      `function makeBudget(): (value: number) => number {`,
      `  return (value) => value + 1;`,
      `}`,
      ``,
      `const budget = makeBudget();`,
      ``,
      `export async function settle(key: string): Promise<number> {`,
      `  function normalise(value: string): string {`,
      `    return value.trim();`,
      `  }`,
      ``,
      `  const total = await retry(normalise(key));`,
      `  return budget(total);`,
      `}`,
      ``,
    ].join('\n'),
  ],
  [
    'app/api/settle/route.ts',
    [
      `import { settle } from '../../../src/lib/settle';`,
      ``,
      `export async function POST(request: Request): Promise<Response> {`,
      `  const key = new URL(request.url).searchParams.get('key') ?? 'none';`,
      `  const total = await settle(key);`,
      ``,
      `  return Response.json({ total });`,
      `}`,
      ``,
    ].join('\n'),
  ],
]);

describe('indexing a miniature project — what an extractor records and a query answers with', () => {
  /** The sandbox root, created in `beforeAll` and removed in `afterAll`. */
  let root = '';

  /** The graph of the miniature project. */
  let graph: CodeGraph;

  /** The queries over that graph. */
  let queries: CodeQueries;

  /** The diagnostics the index came back with. */
  let diagnostics: readonly IndexDiagnostic[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'debuggen-code-analysis-graph-'));

    for (const [relative, contents] of MINIATURE_PROJECT) {
      const absolute = join(root, relative);

      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents, 'utf8');
    }

    const indexed = await indexProject({ projectRoot: root });

    if (!isOk(indexed)) {
      throw new Error(`indexing the miniature project failed: ${indexed.error.message}`);
    }

    graph = indexed.value.graph;
    queries = createCodeQueries(graph);
    diagnostics = indexed.value.index.diagnostics ?? [];
  });

  afterAll(() => {
    if (root !== '') {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The names of the nodes of one kind, sorted, so a case can state what a
   * bucket holds without holding an id.
   *
   * @param kind The node kind to list.
   * @returns The names, ascending.
   */
  function namesOfKind(kind: CodeNodeKind): string[] {
    return graph
      .nodesByKind(kind)
      .map((entry) => entry.name)
      .sort(byteCompare);
  }

  /**
   * The one node of a kind with a given name.
   *
   * @param kind The kind to look in.
   * @param name The source-spelled name.
   * @returns The node.
   */
  function onlyNode(kind: CodeNodeKind, name: string): CodeNode {
    const matched = graph.nodesByKind(kind).filter((entry) => entry.name === name);

    expect(matched.map((entry) => entry.file)).toHaveLength(1);

    const first = matched[0];

    assertDefined(first, `expected one ${kind} named ${name}`);

    return first;
  }

  it('indexes the project without a diagnostic', () => {
    // Every assertion below reads the graph as authoritative, which it only is
    // if nothing was dropped on the way in — a dangling edge above all, since
    // the two fixes under test both add edge endpoints derived rather than
    // looked up.
    expect(codesOf(diagnostics)).toStrictEqual([]);
  });

  /**
   * The names of the components that render a given one, ascending.
   *
   * @param component The rendered component's name.
   * @returns The rendering components' names.
   */
  function parentsOf(component: string): string[] {
    return queries
      .componentsRendering(component)
      .map((reference) => reference.component.name)
      .sort(byteCompare);
  }

  describe('a component exported through memo()', () => {
    it('declares the exported binding as the component, naming the function it wraps', () => {
      // Five, not three: the function a wrapper is applied to is itself an
      // uppercase declaration that produces JSX, so it stays a component node
      // in its own right. The fix adds the *export* as a component; it does not
      // take the inner declaration away.
      expect(namesOfKind('component')).toStrictEqual([
        'StampBadge',
        'StampBadgeBody',
        'TrendChip',
        'TrendChipBody',
        'TrendPanel',
      ]);

      const chip = onlyNode('component', 'TrendChip');

      expect(chip.file).toBe('src/widgets/TrendChip.tsx');
      expect(chip.data).toMatchObject({
        isClient: true,
        isDefaultExport: false,
        // With no explicit override, the display name falls back to the name the
        // function was declared under, which is what React reports at runtime.
        displayName: 'TrendChipBody',
        implementation: 'TrendChipBody',
      });
    });

    it('lands the renders edge on the exported binding rather than nowhere', () => {
      const panel = onlyNode('component', 'TrendPanel');
      const chip = onlyNode('component', 'TrendChip');

      const rendered = graph
        .outgoing(panel.id, 'renders')
        .map((relationship) => graph.nodeById(relationship.to)?.name ?? relationship.to)
        .sort(byteCompare);

      expect(rendered).toStrictEqual(['StampBadge', 'TrendChip']);
      expect(graph.incoming(chip.id, 'renders')).toHaveLength(1);
    });

    it('answers componentsRendering for the exported name and for the wrapped one', () => {
      // The two names are one rendered component, and a caller holding either
      // of them — the export a developer reads, or the display name the runtime
      // reported — has to reach the same parent.
      const byExport = parentsOf('TrendChip');
      const byImplementation = parentsOf('TrendChipBody');

      expect(byExport).toStrictEqual(['TrendPanel']);
      expect(byImplementation).toStrictEqual(byExport);
    });

    it('reports the one parent once, though two nodes answer to the wrapped name', () => {
      // `TrendChipBody` names two component nodes: the inner declaration, which
      // is a component in its own right, and the exported binding, which claims
      // the name as its implementation. Only the export is rendered, and the
      // union of the two lookups has to stay a set.
      const named = graph
        .nodesByKind('component')
        .filter(
          (entry) =>
            entry.name === 'TrendChipBody' ||
            (entry.data as { implementation?: string }).implementation === 'TrendChipBody',
        )
        .map((entry) => entry.name)
        .sort(byteCompare);

      expect(named).toStrictEqual(['TrendChip', 'TrendChipBody']);
      expect(queries.componentsRendering('TrendChipBody')).toHaveLength(1);
    });

    it('answers for an explicit display name as well, alongside the other two', () => {
      // Three names for one component: the export, the function it wraps, and
      // the runtime name assigned at module level.
      expect(['StampBadge', 'StampBadgeBody', 'StampBadgeChip'].map(parentsOf)).toStrictEqual([
        ['TrendPanel'],
        ['TrendPanel'],
        ['TrendPanel'],
      ]);
      expect(onlyNode('component', 'StampBadge').data).toMatchObject({
        displayName: 'StampBadgeChip',
        implementation: 'StampBadgeBody',
      });
    });

    it('leaves findByName a name search, which is where the two names differ', () => {
      // `componentsRendering` resolves a component by any of its names because a
      // render edge has exactly one target. `findByName` ranks resemblance
      // instead, so it answers about the node that carries the name — stated
      // here so that the alias is not mistaken for a second identity.
      const byImplementation = queries.findByName('TrendChipBody', { kinds: ['component'] });

      expect(byImplementation.map((match: CodeMatch) => [match.name, match.score])).toStrictEqual([
        ['TrendChipBody', 1],
      ]);
      expect(byImplementation.map((match: CodeMatch) => match.nodeId)).toStrictEqual([
        onlyNode('component', 'TrendChipBody').id,
      ]);
    });
  });

  describe('a call into a module-private function', () => {
    it('declares the private callees as symbols, not as server functions', () => {
      // Only the exported functions of the two service modules are server
      // functions; the private hops between them are addressable as symbols and
      // nothing else, which is why the `calls` edge has to be able to point at
      // one. `normalise` is the nested declaration inside `settle`: the symbol
      // extractor records nested named function-valued declarations too, with
      // their enclosing chain, so the planner can name them (AAP 0.1.2's
      // canonical plan targets exactly such a nested handler).
      expect(namesOfKind('server-function')).toStrictEqual(['readLedger', 'settle']);
      expect(
        graph
          .nodesByFile('src/lib/settle.ts')
          .filter((entry) => entry.kind === 'symbol')
          .map((entry) => entry.name)
          .sort(byteCompare),
      ).toStrictEqual(['attempt', 'budget', 'makeBudget', 'normalise', 'retry', 'settle']);
      expect(onlyNode('symbol', 'attempt').data).toMatchObject({
        declaration: 'function',
        isDefaultExport: false,
      });
    });

    it('records the calls edge into the private callee the exported function reaches', () => {
      const settle = onlyNode('server-function', 'settle');
      const retry = onlyNode('symbol', 'retry');
      const attempt = onlyNode('symbol', 'attempt');

      expect(
        graph
          .outgoing(settle.id, 'calls')
          .map((relationship) => graph.nodeById(relationship.to)?.name),
      ).toStrictEqual(['retry']);
      expect(
        graph
          .outgoing(retry.id, 'calls')
          .map((relationship) => graph.nodeById(relationship.to)?.name),
      ).toStrictEqual(['attempt']);
      expect(
        graph
          .outgoing(attempt.id, 'calls')
          .map((relationship) => graph.nodeById(relationship.to)?.name),
      ).toStrictEqual(['readLedger']);
    });

    it('walks a route handler to its query through the private hops', () => {
      const route = onlyNode('api-route', '/api/settle');
      const query = onlyNode('db-call', 'pool.query');

      const path = queries.pathBetween(route.id, query.id);

      assertDefined(path, 'the route reaches the query through its private helpers');
      expect(path.undirected).toBe(false);
      expect(path.nodes.map((step) => step.name)).toStrictEqual([
        '/api/settle',
        'settle',
        'retry',
        'attempt',
        'readLedger',
        'pool.query',
      ]);
      expect(hopsOf(path, graph)).toStrictEqual([
        'calls /api/settle→settle',
        'calls settle→retry',
        'calls retry→attempt',
        'calls attempt→readLedger',
        'queries readLedger→pool.query',
      ]);
      expect(path.depth).toBe(5);
      expect(path.truncated).toBe(false);
      expect(walksNodeList(path)).toBe(true);
    });

    it('walks it from a name selector too, which is how a model asks', () => {
      const path = queries.pathBetween({ name: 'settle' }, { kind: 'db-call' });

      assertDefined(path, 'the exported entry point reaches the query');
      expect(path.nodes.map((step) => step.name)).toStrictEqual([
        'settle',
        'retry',
        'attempt',
        'readLedger',
        'pool.query',
      ]);
    });

    it('names the private callers of an exported function', () => {
      // The control for the case above, and the half that already worked: a
      // private function has always been recognised as the *scope* a call is
      // made from, so `whoCalls` on an exported callee named it. What was
      // missing was the same function as a call's *target*, which is what turns
      // these two edges into one chain.
      expect(
        queries
          .whoCalls('readLedger')
          .map((reference) => [reference.caller.kind, reference.caller.name]),
      ).toStrictEqual([['symbol', 'attempt']]);
    });

    it('records a nested declaration with its enclosing chain, and derives no call into it', () => {
      // `normalise` is declared inside `settle`. The symbol extractor records it
      // as a nested symbol whose `enclosing` chain names `settle`, so the node
      // exists and is addressable; the call-edge extractor still derives no
      // `calls` edge into a nested callee, and an edge pointing at a derived id
      // would be dropped on construction as dangling - which is why the
      // diagnostics case above is part of this one's meaning. The only edge that
      // reaches the node is the file's own `declares`.
      const nested = graph.nodesByName('normalise');

      expect(nested).toHaveLength(1);
      expect(nested[0]).toMatchObject({
        kind: 'symbol',
        file: 'src/lib/settle.ts',
        data: { declaration: 'function', enclosing: ['settle'] },
      });
      expect(
        graph
          .edges()
          .filter((relationship) => relationship.to.includes('normalise'))
          .map((relationship) => relationship.kind),
      ).toStrictEqual(['declares']);
      expect(graph.incoming(nested[0]!.id, 'calls')).toStrictEqual([]);
    });

    it('leaves a binding that is only function-valued at runtime out', () => {
      // `budget` holds a function, but its initialiser is a call rather than a
      // function, so nothing in the source says the call site reaches
      // `makeBudget`'s body. Recording an edge here would assert a flow the
      // syntax does not contain, so the conservative answer is no edge — and
      // the symbol node still exists, so a later pass can improve on it.
      const settle = onlyNode('server-function', 'settle');
      const budget = onlyNode('symbol', 'budget');

      expect(graph.incoming(budget.id, 'calls')).toStrictEqual([]);
      expect(
        graph
          .outgoing(settle.id, 'calls')
          .map((relationship) => graph.nodeById(relationship.to)?.name),
      ).not.toContain('budget');
    });
  });
});

describe('indexing the committed corpus — the memoised specimen it carries', () => {
  /*
   * The suite above proves the property against a project it wrote itself. This
   * one proves it against the corpus every other suite of the package reads, so
   * that the shape stays in the shared fixture rather than only in a sandbox: a
   * corpus edit that removed the wrapper would fail here, where the reason is
   * stated, instead of silently thinning the extractor's coverage.
   *
   * Read-only: nothing under `../../test/fixtures` is written, and the index is
   * built with the cache disabled so no state outlives the run.
   */
  const CORPUS_ROOT = fileURLToPath(
    new URL('../../test/fixtures/sample-next-app', import.meta.url),
  );

  /** The corpus graph, and the queries over it. */
  let corpus: { readonly graph: CodeGraph; readonly queries: CodeQueries } | undefined;

  beforeAll(async () => {
    const indexed = await indexProject({ projectRoot: CORPUS_ROOT, cache: false });

    if (!isOk(indexed)) {
      throw new Error(`indexing the corpus failed: ${indexed.error.message}`);
    }

    corpus = { graph: indexed.value.graph, queries: createCodeQueries(indexed.value.graph) };
  });

  /**
   * The corpus graph, or a failure naming the missing `beforeAll`.
   *
   * @returns The graph and its queries.
   */
  function loaded(): { readonly graph: CodeGraph; readonly queries: CodeQueries } {
    assertDefined(corpus, 'the corpus was not indexed: beforeAll did not run');

    return corpus;
  }

  it('declares the wrapped export as a component, naming what it wraps', () => {
    const { graph } = loaded();
    const wrapped = graph
      .nodesByKind('component')
      .filter((entry) => entry.name === 'GaugeTrend')
      .map((entry) => ({ file: entry.file, data: entry.data }));

    expect(wrapped).toStrictEqual([
      {
        file: 'src/widgets/GaugeReadout.tsx',
        data: {
          isClient: true,
          isDefaultExport: false,
          // No display-name assignment on the wrapper, so the implementation's
          // own name is what React would report.
          displayName: 'GaugeTrendBody',
          implementation: 'GaugeTrendBody',
        },
      },
    ]);
  });

  it('answers componentsRendering for the corpus specimen under either name', () => {
    const { queries } = loaded();
    const parents = (component: string): string[] =>
      queries
        .componentsRendering(component)
        .map((reference) => reference.component.name)
        .sort(byteCompare);

    expect(parents('GaugeTrend')).toStrictEqual(['GaugeTrendPanel']);
    expect(parents('GaugeTrendBody')).toStrictEqual(['GaugeTrendPanel']);
  });

  it('keeps the corpus free of the findings that would make the above vacuous', () => {
    // A dropped node or a dangling edge would make both cases above pass for
    // the wrong reason, so the corpus' own cleanliness is asserted beside them.
    const { graph } = loaded();

    expect(codesOf(graph.diagnostics)).toStrictEqual([]);
  });
});
