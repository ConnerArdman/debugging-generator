/**
 * Tests for `./types.ts`: the one vocabulary the code graph speaks — its kind
 * tuples, its three membership predicates, its discriminated node union, its
 * persisted envelope and its extractor contract.
 *
 * Almost everything in that module is a type, and a type needs no test. Three
 * things in it are not, and each one fails somewhere other than where it is
 * declared:
 *
 * 1. **The frozen tuples are a contract, not a list.** `../indexer.ts` emits
 *    against them, `./graph.ts` validates against them, `../route-map.ts`
 *    derives routes from them, `../summary.ts` reports counts in their order
 *    and `../cache.ts` persists values drawn from them. A reordering, a
 *    silently renamed member or a duplicate therefore does not fail here — it
 *    changes what a cached index means, after every module of this package has
 *    already imported it. The tuple suites below are the cheap place to catch
 *    that, and they assert exact membership against literal arrays so that
 *    adding a member is a deliberate edit in two places rather than a drift in
 *    one.
 * 2. **The guards are load-bearing at a trust boundary.** `../cache.ts` reads
 *    JSON back from `$DEBUGGEN_HOME/index` — possibly written by an older
 *    version of this package, possibly hand-edited — and `./graph.ts` drops an
 *    entry whose kind fails {@link isCodeNodeKind} or {@link isCodeEdgeKind}
 *    with an `unknown-node-kind`/`unknown-edge-kind` diagnostic instead of
 *    crashing a traversal. "Rejects a non-string without throwing" is that
 *    requirement, not a tidiness rule, so the negative tables below carry
 *    `undefined`, `null`, numbers, a symbol, a function and two objects whose
 *    coercion hooks throw: a guard that reached for `String(value)` would
 *    replace a degraded cache with an exception raised inside the cache reader.
 * 3. **The vocabulary's compile-time properties are what consumers rely on.**
 *    `./graph.ts`'s `nodesByKind<K>` returns `readonly CodeNodeOf<K>[]`,
 *    `../summary.ts` reads per-kind payload fields after a `switch`, and
 *    `../cache.ts` round-trips a {@link CodeIndex} through JSON. Those are
 *    properties of the declarations rather than of any runtime value, so they
 *    are asserted the only way that works: by writing code that only compiles
 *    while they hold — a `Record<CodeNodeKind, true>` that must be exhaustive,
 *    a `switch` whose `default` calls `assertNever`, an annotated
 *    `CodeNodeOf<'db-call'>['data']` literal. Those assertions cost nothing at
 *    run time and are validated by `pnpm typecheck`; the suite keeps them so a
 *    vocabulary regression cannot reach CI green.
 *
 * Two habits in here are deliberate.
 *
 * - **Every compile-time assertion is also used at run time.** An unused
 *   coverage record would be deleted by the next reader (and flagged by
 *   `noUnusedLocals`), so each one is read by an assertion — the exhaustive
 *   records are compared against their tuples, the narrowed values index those
 *   records, and the per-kind sample nodes are fed through a `switch` that
 *   reads a field only that kind's payload declares.
 * - **A detector is never trusted without a control.** The plain-JSON walk
 *   that proves a {@link CodeIndex} carries nothing a `JSON` round trip would
 *   change is itself checked against values it must reject (a `Date`, a `Map`,
 *   a present-but-`undefined` key, a function, `NaN`), so "no violations
 *   found" cannot mean "the walk looks at nothing".
 *
 * Purity: no filesystem, no network, no timers, no ts-morph project. Building
 * one would need `ts-morph` and `../project.js`, and this suite imports only
 * `vitest`, its subject and `assertNever` from `@debuggen/shared`.
 *
 * Identifiers in the fixtures are neutral placeholders (`Widget`,
 * `handleSubmit`, `/api/items`) — the vocabulary is the subject, and a name
 * borrowed from an application under test would say otherwise.
 */

import { assertNever } from '@debuggen/shared';
import { describe, expect, it } from 'vitest';

import {
  API_ROUTE_KINDS,
  CODE_EDGE_KINDS,
  CODE_INDEX_SCHEMA_VERSION,
  CODE_NODE_KINDS,
  DATABASE_ACCESS_STYLES,
  DB_DRIVERS,
  FRAMEWORK_NAMES,
  HTTP_METHOD_NAMES,
  INDEX_DIAGNOSTIC_CODES,
  INDEX_DIAGNOSTIC_SEVERITIES,
  isCodeEdgeKind,
  isCodeNodeKind,
  isIndexDiagnosticCode,
  PACKAGE_MANAGERS,
  ROUTER_KINDS,
  ROUTER_STYLES,
  SYMBOL_DECLARATION_KINDS,
  type CodeEdge,
  type CodeEdgeKind,
  type CodeIndex,
  type CodeNode,
  type CodeNodeKind,
  type CodeNodeOf,
  type Extractor,
  type ExtractorContext,
  type ExtractorResult,
  type FileFingerprint,
  type IndexDiagnostic,
  type IndexDiagnosticCode,
  type ReferenceQuery,
  type ReferenceResolver,
} from './types.js';

/*
 * ---------------------------------------------------------------------------
 * Spelling conventions
 * ---------------------------------------------------------------------------
 */

/**
 * Lowercase single words and kebab-case compounds: a lowercase letter, then
 * lowercase letters and digits in hyphen-separated groups, with no leading,
 * trailing or doubled hyphen and no uppercase or underscore anywhere.
 *
 * The convention every vocabulary in `./types.ts` follows except
 * {@link HTTP_METHOD_NAMES}. It matters because these strings are compared
 * literally across a process and a file boundary — a member that acquired an
 * underscore or a capital would still be a valid string and would silently
 * stop matching what a persisted index holds.
 */
const LOWER_KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Upper-case single words, the convention {@link HTTP_METHOD_NAMES} follows
 * because HTTP method tokens are case-sensitive and canonically upper case.
 */
const UPPER_WORD = /^[A-Z][A-Z0-9]*$/;

/*
 * ---------------------------------------------------------------------------
 * The vocabulary table
 * ---------------------------------------------------------------------------
 */

/** One exported vocabulary tuple and everything asserted about it. */
interface Vocabulary {
  /** The exported constant's name, used to label a failure. */
  readonly label: string;

  /**
   * The tuple itself, widened to `readonly string[]`.
   *
   * Widened deliberately: the helpers below test membership and immutability of
   * arbitrary strings, and a parameter typed as the literal tuple would make
   * both the malformed-member filter and the readonly-to-mutable cast in
   * {@link expectFrozenTuple} impossible to write.
   */
  readonly tuple: readonly string[];

  /**
   * The exact members, in the exact order, as a plain literal array.
   *
   * Restated here rather than derived from the tuple — a comparison of a value
   * with itself asserts nothing. This is the half of the contract that fails
   * when a member is added, removed, renamed or reordered.
   */
  readonly members: readonly string[];

  /** The spelling convention this vocabulary's members follow. */
  readonly spelling: RegExp;
}

/**
 * Every frozen vocabulary `./types.ts` exports.
 *
 * All thirteen of them, and the count is asserted below: a new exported tuple
 * that is not added here would ship with none of the integrity checks the
 * other thirteen get, which is exactly the kind of omission nobody notices.
 */
const VOCABULARIES: readonly Vocabulary[] = [
  {
    label: 'CODE_NODE_KINDS',
    tuple: CODE_NODE_KINDS,
    members: [
      'file',
      'symbol',
      'component',
      'handler',
      'api-call',
      'api-route',
      'server-function',
      'db-call',
    ],
    spelling: LOWER_KEBAB,
  },
  {
    label: 'CODE_EDGE_KINDS',
    tuple: CODE_EDGE_KINDS,
    members: [
      'imports',
      'exports',
      'declares',
      'references',
      'renders',
      'handles',
      'calls',
      'routes-to',
      'queries',
    ],
    spelling: LOWER_KEBAB,
  },
  {
    label: 'ROUTER_KINDS',
    tuple: ROUTER_KINDS,
    members: ['app', 'pages'],
    spelling: LOWER_KEBAB,
  },
  {
    label: 'API_ROUTE_KINDS',
    tuple: API_ROUTE_KINDS,
    members: ['route-handler', 'page'],
    spelling: LOWER_KEBAB,
  },
  {
    label: 'HTTP_METHOD_NAMES',
    tuple: HTTP_METHOD_NAMES,
    members: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'],
    spelling: UPPER_WORD,
  },
  {
    label: 'DB_DRIVERS',
    tuple: DB_DRIVERS,
    members: ['prisma', 'pg'],
    spelling: LOWER_KEBAB,
  },
  {
    label: 'SYMBOL_DECLARATION_KINDS',
    tuple: SYMBOL_DECLARATION_KINDS,
    members: [
      'function',
      'class',
      'variable',
      'type',
      'interface',
      'enum',
      'method',
      'property',
      'unknown',
    ],
    spelling: LOWER_KEBAB,
  },
  {
    label: 'ROUTER_STYLES',
    tuple: ROUTER_STYLES,
    members: ['app', 'pages', 'hybrid', 'none'],
    spelling: LOWER_KEBAB,
  },
  {
    label: 'FRAMEWORK_NAMES',
    tuple: FRAMEWORK_NAMES,
    members: ['next', 'react', 'unknown'],
    spelling: LOWER_KEBAB,
  },
  {
    label: 'PACKAGE_MANAGERS',
    tuple: PACKAGE_MANAGERS,
    members: ['pnpm', 'npm', 'yarn', 'bun', 'unknown'],
    spelling: LOWER_KEBAB,
  },
  {
    label: 'DATABASE_ACCESS_STYLES',
    tuple: DATABASE_ACCESS_STYLES,
    members: ['prisma', 'pg', 'both', 'none'],
    spelling: LOWER_KEBAB,
  },
  {
    label: 'INDEX_DIAGNOSTIC_SEVERITIES',
    tuple: INDEX_DIAGNOSTIC_SEVERITIES,
    members: ['info', 'warning', 'error'],
    spelling: LOWER_KEBAB,
  },
  {
    label: 'INDEX_DIAGNOSTIC_CODES',
    tuple: INDEX_DIAGNOSTIC_CODES,
    members: [
      'extractor-failed',
      'duplicate-node-id',
      'duplicate-edge-id',
      'dangling-edge',
      'unknown-node-kind',
      'unknown-edge-kind',
      'unresolved-import',
      'file-skipped',
      'limit-reached',
    ],
    spelling: LOWER_KEBAB,
  },
];

/**
 * Assert that a vocabulary cannot be changed by a consumer.
 *
 * `./types.ts` builds every vocabulary with `Object.freeze([… ] as const)`, so
 * two guarantees hold and both are asserted: the tuple reports itself frozen,
 * and — because this module is an ES module and therefore strict mode — an
 * assignment, an append and a removal all throw a `TypeError` rather than
 * failing silently. The value is re-read afterwards, so a future
 * implementation that merely made mutation *throw* without preventing it would
 * still fail here.
 *
 * @param label The constant's name, for the failure message.
 * @param tuple The vocabulary under test.
 */
function expectFrozenTuple(label: string, tuple: readonly string[]): void {
  expect(Object.isFrozen(tuple), `${label} must be frozen`).toBe(true);

  const before = [...tuple];
  // The cast is the test: a consumer that wants to mutate the vocabulary has
  // to shed its `readonly`, and this is what happens when it does.
  const mutable = tuple as string[];

  expect(() => {
    mutable[0] = 'mutated';
  }, `${label} must refuse an element assignment`).toThrow(TypeError);
  expect(() => {
    mutable.push('appended');
  }, `${label} must refuse to grow`).toThrow(TypeError);
  expect(() => {
    mutable.pop();
  }, `${label} must refuse to shrink`).toThrow(TypeError);

  expect([...tuple], `${label} must be unchanged after every attempt`).toEqual(before);
}

/*
 * ---------------------------------------------------------------------------
 * Guard fixtures
 * ---------------------------------------------------------------------------
 */

/** A labelled value for the table-driven guard suites. */
type LabelledValue = readonly [label: string, value: unknown];

/**
 * Values that are not strings at all, which is what a corrupt or
 * foreign-version cache entry puts in a `kind` field.
 *
 * The last three rows are the ones that matter most: a guard implemented with
 * `String(value)`, a template literal or `value.toString()` would throw from
 * inside `../cache.ts` while it was *recovering* from a bad entry, turning a
 * degraded index into a failed one. A membership test over a string array
 * coerces nothing, and these rows are what proves it.
 *
 * `10n` and the symbol are here for the same reason they are in
 * `packages/shared/src/errors.test.ts`: both punish any implementation that
 * reaches for stringification, because a template literal throws on a symbol
 * and `JSON.stringify` throws on a bigint.
 */
const NON_STRING_VALUES: readonly LabelledValue[] = [
  ['undefined', undefined],
  ['null', null],
  ['the number 0', 0],
  ['the number 1', 1],
  ['a bigint', 10n],
  ['true', true],
  ['false', false],
  ['an empty object', {}],
  ['an empty array', []],
  ['an array holding a member', ['file']],
  ['a symbol', Symbol('file')],
  ['a function returning a member', () => 'file'],
  ['a null-prototype object', Object.create(null) as object],
  ['an object that stringifies to a member', { toString: () => 'file' }],
  [
    'an object whose toString throws',
    {
      toString: (): string => {
        throw new Error('This value refuses to be stringified.');
      },
    },
  ],
  [
    'an object whose valueOf throws',
    {
      valueOf: (): string => {
        throw new Error('This value refuses to be coerced.');
      },
    },
  ],
];

/**
 * Strings that name no node kind, each one a mistake a producer could
 * plausibly make.
 *
 * The cross-vocabulary rows (`imports`, `app`, `extractor-failed`) are the
 * interesting ones: the three predicates are membership tests over three
 * different tables, and a shared implementation that tested the wrong one
 * would pass every same-vocabulary row and fail only these.
 */
const NON_NODE_KIND_STRINGS: readonly string[] = [
  '',
  ' ',
  'module',
  'external-module',
  'api_call',
  'API-CALL',
  'File',
  ' file',
  'file ',
  'files',
  'imports',
  'app',
  'extractor-failed',
];

/** Strings that name no edge kind, on the same pattern. */
const NON_EDGE_KIND_STRINGS: readonly string[] = [
  '',
  ' ',
  'import',
  'routes_to',
  'ROUTES-TO',
  'route-to',
  'Renders',
  'query',
  'file',
  'db-call',
  'limit-reached',
];

/** Strings that name no diagnostic code, on the same pattern. */
const NON_DIAGNOSTIC_CODE_STRINGS: readonly string[] = [
  '',
  ' ',
  'extractor_failed',
  'EXTRACTOR-FAILED',
  'ExtractorFailed',
  'unknown-kind',
  'duplicate-id',
  'warning',
  'file',
  'imports',
];

/**
 * Codes `./graph.ts` and `../indexer.ts` are specified to emit, spot-checked so
 * that a rename in the vocabulary cannot land without a failing test here.
 *
 * Typed `readonly string[]` and not `readonly IndexDiagnosticCode[]` on
 * purpose: as the closed type a removed code would fail to *compile* this file,
 * which reports the loss as a type error rather than as the assertion below
 * naming the missing code.
 */
const REQUIRED_DIAGNOSTIC_CODES: readonly string[] = [
  'extractor-failed',
  'duplicate-node-id',
  'duplicate-edge-id',
  'dangling-edge',
  'unknown-node-kind',
  'unknown-edge-kind',
];

/**
 * The HTTP verbs a route module may export a handler for, spot-checked beside
 * the wildcard the same way.
 */
const REQUIRED_HTTP_VERBS: readonly string[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

/*
 * ---------------------------------------------------------------------------
 * Narrowing helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Assert that `value` satisfies {@link isCodeNodeKind}, and hand it back
 * narrowed.
 *
 * The narrowing is half the assertion: the returned value is typed
 * {@link CodeNodeKind}, so a predicate whose `value is CodeNodeKind` signature
 * were weakened to `boolean` would fail `pnpm typecheck` here rather than
 * silently stop narrowing at every call site in `./graph.ts`.
 *
 * @param value The value under test.
 * @param label What the value is, for the failure message.
 * @returns `value`, typed as a {@link CodeNodeKind}.
 */
function narrowedNodeKind(value: unknown, label: string): CodeNodeKind {
  expect(isCodeNodeKind(value), `${label} must satisfy isCodeNodeKind`).toBe(true);

  if (!isCodeNodeKind(value)) {
    // Unreachable: the expectation above has already failed the test. Present
    // so this function's return type is `CodeNodeKind` rather than `unknown`.
    throw new Error(`Expected ${label} to be a CodeNodeKind.`);
  }

  return value;
}

/** The edge counterpart of {@link narrowedNodeKind}. */
function narrowedEdgeKind(value: unknown, label: string): CodeEdgeKind {
  expect(isCodeEdgeKind(value), `${label} must satisfy isCodeEdgeKind`).toBe(true);

  if (!isCodeEdgeKind(value)) {
    throw new Error(`Expected ${label} to be a CodeEdgeKind.`);
  }

  return value;
}

/** The diagnostic-code counterpart of {@link narrowedNodeKind}. */
function narrowedDiagnosticCode(value: unknown, label: string): IndexDiagnosticCode {
  expect(isIndexDiagnosticCode(value), `${label} must satisfy isIndexDiagnosticCode`).toBe(true);

  if (!isIndexDiagnosticCode(value)) {
    throw new Error(`Expected ${label} to be an IndexDiagnosticCode.`);
  }

  return value;
}

/*
 * ---------------------------------------------------------------------------
 * Derived-union coverage
 * ---------------------------------------------------------------------------
 */

/**
 * Every {@link CodeNodeKind}, listed explicitly.
 *
 * A compile-time exhaustiveness pin: `Record<CodeNodeKind, true>` demands one
 * key per member of the derived union, so adding a member to
 * {@link CODE_NODE_KINDS} without updating this object is a type error — which
 * is the point, because the type and the tuple are the same contract seen from
 * two sides and a suite that only checked the tuple would not notice the union
 * drifting. Also used at run time, as the lookup a narrowed kind indexes.
 */
const NODE_KIND_COVERAGE: Record<CodeNodeKind, true> = {
  file: true,
  symbol: true,
  component: true,
  handler: true,
  'api-call': true,
  'api-route': true,
  'server-function': true,
  'db-call': true,
};

/** Every {@link CodeEdgeKind}, listed explicitly, for the same reason. */
const EDGE_KIND_COVERAGE: Record<CodeEdgeKind, true> = {
  imports: true,
  exports: true,
  declares: true,
  references: true,
  renders: true,
  handles: true,
  calls: true,
  'routes-to': true,
  queries: true,
};

/*
 * ---------------------------------------------------------------------------
 * Node, edge and index fixtures
 * ---------------------------------------------------------------------------
 */

/** A neutral client-component module, project-relative POSIX as a node's `file` must be. */
const WIDGET_FILE = 'src/components/Widget.tsx';

/** A neutral server-side module holding the service layer and its query. */
const SERVICE_FILE = 'src/server/items.ts';

/** A neutral App Router handler module. */
const ROUTE_FILE = 'src/app/api/items/route.ts';

/** A neutral request path, used as both a call target and a route path. */
const ITEMS_PATH = '/api/items';

/**
 * One node per kind, typed so that each entry is that kind's member of the
 * union rather than the union itself.
 *
 * The mapped type is a second compile-time pin, and a stronger one than the
 * coverage records: `CodeNodeOf<K>` has to resolve to a distinct member for
 * every `K`, and each literal below has to satisfy exactly that member's
 * payload requirement — `data` omitted-or-present for the two structural kinds,
 * required and kind-specific for the other six. If {@link CodeNode} stopped
 * being discriminated on `kind`, or if `CodeNodeOf` stopped extracting, this
 * object would not compile.
 *
 * Every `line` and `column` is 1-based and every `file` is project-relative
 * POSIX, as {@link CodeNode} requires, so these fixtures also stand as worked
 * examples of the conventions the interface documents.
 */
const SAMPLE_NODES: { readonly [K in CodeNodeKind]: CodeNodeOf<K> } = {
  file: {
    id: 'node:file:1',
    kind: 'file',
    name: WIDGET_FILE,
    file: WIDGET_FILE,
    line: 1,
    column: 1,
    data: {
      extension: '.tsx',
      isClientModule: true,
      externalImports: [{ specifier: 'react', typeOnly: false, names: ['default'] }],
    },
  },
  symbol: {
    id: 'node:symbol:1',
    kind: 'symbol',
    name: 'handleSubmit',
    file: WIDGET_FILE,
    line: 12,
    column: 3,
    exported: false,
    data: { declaration: 'function', isDefaultExport: false },
  },
  component: {
    id: 'node:component:1',
    kind: 'component',
    name: 'Widget',
    file: WIDGET_FILE,
    line: 20,
    column: 1,
    exported: true,
    data: { isClient: true, isDefaultExport: true, displayName: 'Widget' },
  },
  handler: {
    id: 'node:handler:1',
    kind: 'handler',
    name: 'onSubmit',
    file: WIDGET_FILE,
    line: 26,
    column: 9,
    symbol: 'handleSubmit',
    data: { event: 'submit', boundTo: 'form', inline: false },
  },
  'api-call': {
    id: 'node:api-call:1',
    kind: 'api-call',
    name: ITEMS_PATH,
    file: WIDGET_FILE,
    line: 14,
    column: 11,
    symbol: 'handleSubmit',
    data: { url: ITEMS_PATH, dynamic: false, method: 'POST' },
  },
  'api-route': {
    id: 'node:api-route:1',
    kind: 'api-route',
    name: ITEMS_PATH,
    file: ROUTE_FILE,
    line: 1,
    column: 1,
    exported: true,
    data: { routePath: ITEMS_PATH, router: 'app', kind: 'route-handler', methods: ['GET', 'POST'] },
  },
  'server-function': {
    id: 'node:server-function:1',
    kind: 'server-function',
    name: 'loadItems',
    file: SERVICE_FILE,
    line: 8,
    column: 1,
    endLine: 19,
    exported: true,
    data: { isAsync: true, exported: true },
  },
  'db-call': {
    id: 'node:db-call:1',
    kind: 'db-call',
    name: 'pool.query',
    file: SERVICE_FILE,
    line: 11,
    column: 5,
    symbol: 'loadItems',
    // Parameter placeholders preserved, no inline literal, no credential: the
    // constraint `DbCallNodeData.statementShape` documents.
    data: { driver: 'pg', statementShape: 'SELECT id FROM items WHERE id = $1', dynamic: false },
  },
};

/**
 * Describe a node by reading a field that **only its own kind's payload
 * declares**.
 *
 * This function is the discriminated-union assertion, and it is written the way
 * `../summary.ts` and `./query.ts` consume the union: a `switch` on `kind`,
 * then a direct read of `data`, with no cast, no optional chaining onto the
 * wrong payload type and no `as`. `node.data.driver` compiles in the `db-call`
 * branch and nowhere else; `node.data.routePath` compiles in the `api-route`
 * branch and nowhere else. If {@link CodeNode} stopped being discriminated on
 * `kind`, every one of those reads would be an error and this file would not
 * compile — which is precisely the regression the suite is here to prevent.
 *
 * `data` is read through `?.` for `file` and `symbol` only, because those are
 * the two kinds whose payload is optional.
 *
 * The `default` branch is the exhaustiveness half: `assertNever` takes `never`,
 * so it only compiles while every declared kind is handled above it. Adding a
 * member to {@link CODE_NODE_KINDS} therefore fails here too.
 *
 * @param node Any graph node.
 * @returns A short description carrying the kind-specific field's value.
 */
function describeNode(node: CodeNode): string {
  switch (node.kind) {
    case 'file':
      return `file ${node.data?.extension ?? 'of an unrecorded extension'}`;
    case 'symbol':
      return `symbol declared as ${node.data?.declaration ?? 'unclassified'}`;
    case 'component':
      return `${node.data.isClient ? 'client' : 'server'} component ${node.data.displayName}`;
    case 'handler':
      return `handler for ${node.data.event} on ${node.data.boundTo}`;
    case 'api-call':
      return node.data.dynamic
        ? 'dynamic request'
        : `request to ${node.data.url ?? 'an unrecorded path'}`;
    case 'api-route':
      return `${node.data.methods.join(',')} ${node.data.routePath}`;
    case 'server-function':
      return `${node.data.isAsync ? 'async' : 'sync'} server function`;
    case 'db-call':
      return `query via ${node.data.driver}`;
    default:
      return assertNever(node, 'Unhandled code node kind');
  }
}

/**
 * What {@link describeNode} must read back out of each sample node.
 *
 * One witness per kind, each one a value that appears in **only** that kind's
 * payload, so a `switch` branch that read the wrong field — or a union that
 * narrowed to the wrong member — produces a description missing its witness
 * rather than a passing test.
 */
const NODE_KIND_WITNESS: Record<CodeNodeKind, string> = {
  file: '.tsx',
  symbol: 'declared as function',
  component: 'client component Widget',
  handler: 'for submit on form',
  'api-call': `request to ${ITEMS_PATH}`,
  'api-route': `GET,POST ${ITEMS_PATH}`,
  'server-function': 'async server function',
  'db-call': 'via pg',
};

/**
 * A `declares` edge from the sample file node to the sample symbol node: the
 * shape `./graph.ts` reconstructs "what is in this file" from, and the one
 * endpoint pairing {@link CODE_EDGE_KINDS} documents for that kind.
 *
 * `file`, `line` and `column` carry the **edge site** — the declaration itself
 * — rather than either endpoint's own position, which is what
 * {@link CodeEdge.file} specifies.
 */
const DECLARES_EDGE: CodeEdge = {
  id: 'edge:declares:1',
  kind: 'declares',
  from: SAMPLE_NODES.file.id,
  to: SAMPLE_NODES.symbol.id,
  file: WIDGET_FILE,
  line: 12,
  column: 3,
};

/**
 * One diagnostic, naming a file and quoting no source — the privacy constraint
 * {@link INDEX_DIAGNOSTIC_CODES} places on both text fields.
 */
const SAMPLE_DIAGNOSTIC: IndexDiagnostic = {
  severity: 'warning',
  code: 'unknown-node-kind',
  message: 'Dropped a cached entry naming a node kind this version does not know.',
  file: WIDGET_FILE,
};

/**
 * A fingerprint of the sample file: the cache's unit of invalidation, with the
 * optional `hash` omitted rather than set to `undefined`.
 *
 * Omitted rather than `undefined` for two independent reasons — the envelope's
 * plain-JSON contract, which forbids a present-but-`undefined` property, and
 * `exactOptionalPropertyTypes`, under which writing `hash: undefined` would not
 * even compile.
 */
const SAMPLE_FINGERPRINT: FileFingerprint = {
  file: WIDGET_FILE,
  mtimeMs: 1_700_000_000_123,
  size: 482,
};

/**
 * The smallest index that still exercises every part of the envelope: two
 * nodes, the edge that joins them, one fingerprint, the stamped schema version
 * and a fixed `generatedAt`.
 *
 * `generatedAt` is `0` deliberately. It is the one field the envelope's
 * determinism contract allows to vary between runs, so a fixture that read the
 * clock would make an equality assertion about the whole object depend on the
 * moment it ran.
 *
 * Built fresh per call, so a test that mutates or serialises the result cannot
 * affect another.
 */
function minimalIndex(): CodeIndex {
  return {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot: '/tmp/target-project',
    indexerVersion: '0.1.0-test',
    generatedAt: 0,
    nodes: [SAMPLE_NODES.file, SAMPLE_NODES.symbol],
    edges: [DECLARES_EDGE],
    files: [SAMPLE_FINGERPRINT],
  };
}

/*
 * ---------------------------------------------------------------------------
 * The plain-JSON walk
 * ---------------------------------------------------------------------------
 */

/** Whether a value is an array, without widening anything to `any`. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Whether an object's prototype is `Object.prototype` or `null`. */
function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * The constructor name of a value whose prototype is neither plain nor null —
 * `'Date'`, `'Map'`, `'Set'` — for a failure message that names what was
 * found.
 */
function constructorNameOf(value: object): string {
  const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  return prototype?.constructor?.name ?? 'an exotic prototype';
}

/**
 * Collect every path in `value` that a `JSON` round trip would not carry
 * unchanged.
 *
 * The envelope's contract is that `JSON.parse(JSON.stringify(index))` is
 * indistinguishable from `index`, which a round-trip equality assertion alone
 * does not prove: `JSON.stringify` silently drops a key whose value is
 * `undefined` or a function, turns a `Date` into a string, a `Map` into `{}`
 * and `NaN` into `null`, and several of those survive a loose comparison. So
 * the walk looks for the constructs themselves and reports where they are,
 * and {@link minimalIndex} is checked with it in both directions — no
 * violations in the real envelope, and a violation found for each control.
 *
 * @param value The value to walk.
 * @param path Where `value` sits, for the report.
 * @param found The accumulator every violation is pushed onto, as
 * `path: detail`.
 */
function collectJsonViolations(value: unknown, path: string, found: string[]): void {
  // Every `typeof` test is written directly against `value` rather than against
  // a stored result, because only the direct form narrows it for the compiler.
  if (typeof value === 'object') {
    if (value === null) {
      // `null` is a legal JSON value and survives a round trip untouched.
      return;
    }

    if (isUnknownArray(value)) {
      value.forEach((entry, position) => {
        collectJsonViolations(entry, `${path}[${position}]`, found);
      });
      return;
    }

    if (!isPlainObject(value)) {
      // A `Date`, a `Map`, a `Set` or any class instance: serialised into
      // something else, or into nothing.
      found.push(`${path}: ${constructorNameOf(value)}`);
      return;
    }

    for (const [key, entry] of Object.entries(value)) {
      collectJsonViolations(entry, `${path}.${key}`, found);
    }
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      // `NaN` and the infinities serialise as `null`.
      found.push(`${path}: ${String(value)}`);
    }
    return;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return;
  }

  // `undefined`, `bigint`, `symbol` and `function`: each one either vanishes
  // from the serialised form or makes `JSON.stringify` throw.
  found.push(`${path}: ${typeof value}`);
}

/** A control for the walk: a value it must reject, and the report it must produce. */
interface JsonControl {
  /** What the control holds, for the test name. */
  readonly label: string;

  /** The value to walk. */
  readonly value: Record<string, unknown>;

  /** The exact violation list the walk must return. */
  readonly expected: readonly string[];
}

/**
 * Values the walk must reject, one per construct that breaks the plain-JSON
 * contract.
 *
 * Without these, "no violations found" in the envelope test would also be the
 * outcome of a walk that inspected nothing.
 */
const JSON_CONTROLS: readonly JsonControl[] = [
  { label: 'a Date', value: { generatedAt: new Date(0) }, expected: ['control.generatedAt: Date'] },
  { label: 'a Map', value: { nodes: new Map<string, number>() }, expected: ['control.nodes: Map'] },
  { label: 'a Set', value: { files: new Set<string>() }, expected: ['control.files: Set'] },
  {
    label: 'a present-but-undefined key',
    value: { hash: undefined },
    expected: ['control.hash: undefined'],
  },
  { label: 'a function', value: { resolve: () => 1 }, expected: ['control.resolve: function'] },
  { label: 'a bigint', value: { size: 1n }, expected: ['control.size: bigint'] },
  {
    label: 'a non-finite number',
    value: { mtimeMs: Number.NaN },
    expected: ['control.mtimeMs: NaN'],
  },
  {
    label: 'a Date nested inside an array of objects',
    value: { files: [{ file: WIDGET_FILE, mtimeMs: new Date(0) }] },
    expected: ['control.files[0].mtimeMs: Date'],
  },
];

/*
 * ---------------------------------------------------------------------------
 * Extractor-contract stubs
 * ---------------------------------------------------------------------------
 */

/** The empty result an extractor returns when it found nothing. */
const STUB_EXTRACTOR_RESULT: ExtractorResult = { nodes: [], edges: [] };

/**
 * The smallest thing that satisfies {@link Extractor}.
 *
 * Two properties of the interface are asserted by this literal compiling at
 * all: `extract` is **synchronous** — an `async` implementation would be
 * required if the contract returned a promise, and a real extractor has nothing
 * to await because ts-morph's API is synchronous — and `diagnostics` is
 * **optional**, since the returned result omits it entirely rather than
 * carrying an empty array.
 *
 * The context is deliberately unread: proving the interface is implementable is
 * the assertion here, and constructing a real {@link ExtractorContext} would
 * need `ts-morph` and `../project.js`, neither of which this suite may import.
 */
const STUB_EXTRACTOR: Extractor = {
  id: 'stub',
  extract: () => STUB_EXTRACTOR_RESULT,
};

/**
 * A stand-in for the context a real call carries.
 *
 * The double assertion is honest because {@link STUB_EXTRACTOR} reads no
 * property of it — a partial literal would be a lie about the interface, and a
 * real one would drag a ts-morph project into a suite that must stay pure.
 */
const STUB_EXTRACTOR_CONTEXT = {} as unknown as ExtractorContext;

/** A lookup for a symbol that a resolver is free to know nothing about. */
const STUB_REFERENCE_QUERY: ReferenceQuery = { file: WIDGET_FILE, symbol: 'handleSubmit' };

/**
 * The smallest thing that satisfies {@link ReferenceResolver}: the substituted
 * implementation the interface exists to make possible, answering "nothing"
 * rather than throwing.
 */
const STUB_REFERENCE_RESOLVER: ReferenceResolver = {
  referencesTo: () => [],
};

/*
 * ---------------------------------------------------------------------------
 * The frozen vocabularies
 * ---------------------------------------------------------------------------
 */

describe('the frozen vocabularies', () => {
  it('covers every vocabulary this module exports', () => {
    // Thirteen tuples, and the count is the reminder: a fourteenth exported
    // vocabulary that is not added to VOCABULARIES would receive none of the
    // integrity checks below.
    expect(VOCABULARIES).toHaveLength(13);
  });

  it.each(VOCABULARIES)(
    '$label declares exactly the members specified for it',
    ({ tuple, members }) => {
      // Deep equality against a literal array, so a reordering, an addition, a
      // removal and a rename all fail here. The order is part of the contract:
      // `../summary.ts` reports node counts in it and a reader of a serialised
      // index sees it.
      expect(tuple).toEqual(members);
    },
  );

  it.each(VOCABULARIES)('$label lists every member exactly once', ({ label, tuple }) => {
    const seen = new Set<string>();
    const duplicates = tuple.filter((member) => {
      const repeated = seen.has(member);
      seen.add(member);
      return repeated;
    });

    // Reported as the offending list rather than as a size comparison, so a
    // failure names the member that was added twice.
    expect(duplicates, `${label} must list each member once`).toEqual([]);
    expect(seen.size, `${label} must hold as many distinct members as entries`).toBe(tuple.length);
  });

  it.each(VOCABULARIES)(
    '$label spells every member in its own convention',
    ({ label, tuple, spelling }) => {
      const malformed = tuple.filter((member) => member.length === 0 || !spelling.test(member));

      expect(malformed, `${label} must spell every member as ${String(spelling)}`).toEqual([]);
    },
  );

  it.each(VOCABULARIES)(
    '$label is frozen and unchanged by a mutation attempt',
    ({ label, tuple }) => {
      expectFrozenTuple(label, tuple);
    },
  );

  it('keeps the node, edge and diagnostic vocabularies disjoint', () => {
    // The three predicates are membership tests over three different tables, so
    // an overlap would make "which vocabulary is this string from?" unanswerable
    // and would let a shared implementation pass every same-vocabulary test.
    const nodeKinds = new Set<string>(CODE_NODE_KINDS);
    const edgeKinds = new Set<string>(CODE_EDGE_KINDS);

    expect(CODE_EDGE_KINDS.filter((kind) => nodeKinds.has(kind))).toEqual([]);
    expect(INDEX_DIAGNOSTIC_CODES.filter((code) => nodeKinds.has(code))).toEqual([]);
    expect(INDEX_DIAGNOSTIC_CODES.filter((code) => edgeKinds.has(code))).toEqual([]);
  });
});

describe('CODE_NODE_KINDS', () => {
  it('holds the eight kinds the graph is closed over', () => {
    expect(CODE_NODE_KINDS).toHaveLength(8);
  });

  it('agrees exactly with the derived CodeNodeKind union', () => {
    // NODE_KIND_COVERAGE is a `Record<CodeNodeKind, true>`, so it cannot compile
    // with a missing or an invented key; comparing its keys with the tuple
    // closes the loop in the other direction.
    expect(Object.keys(NODE_KIND_COVERAGE).sort()).toEqual([...CODE_NODE_KINDS].sort());
  });
});

describe('CODE_EDGE_KINDS', () => {
  it('holds the nine relationships the graph is closed over', () => {
    expect(CODE_EDGE_KINDS).toHaveLength(9);
  });

  it('agrees exactly with the derived CodeEdgeKind union', () => {
    expect(Object.keys(EDGE_KIND_COVERAGE).sort()).toEqual([...CODE_EDGE_KINDS].sort());
  });

  it.each(CODE_EDGE_KINDS)('lets the single CodeEdge interface express a %s edge', (kind) => {
    // One interface serves all nine kinds, and `file`/`line`/`column`/`specifier`
    // are optional because a derived edge — `routes-to` — has no site in source.
    const edge: CodeEdge = {
      id: `edge:${kind}:1`,
      kind,
      from: SAMPLE_NODES.file.id,
      to: SAMPLE_NODES.symbol.id,
    };

    expect(edge.kind).toBe(kind);
    expect(EDGE_KIND_COVERAGE[narrowedEdgeKind(edge.kind, `the edge kind ${kind}`)]).toBe(true);
  });
});

describe('HTTP_METHOD_NAMES', () => {
  it('carries the wildcard ANY beside the standard verbs', () => {
    // `ANY` is not an HTTP method: it is what a legacy Pages-Router API module
    // reports, being one default-exported function that serves every method with
    // no per-method export to enumerate. `../route-map.ts` derives `['ANY']` for
    // exactly that shape, so removing this member would break the legacy
    // handler contract rather than merely shrink a list.
    expect(HTTP_METHOD_NAMES).toContain('ANY');

    const present = new Set<string>(HTTP_METHOD_NAMES);
    const missing = REQUIRED_HTTP_VERBS.filter((verb) => !present.has(verb));

    expect(missing).toEqual([]);
  });

  it('lets a legacy route declare exactly ["ANY"] and nothing else', () => {
    const legacyRoute: CodeNodeOf<'api-route'> = {
      id: 'node:api-route:2',
      kind: 'api-route',
      name: ITEMS_PATH,
      file: 'src/pages/api/items.ts',
      line: 1,
      column: 1,
      exported: true,
      data: { routePath: ITEMS_PATH, router: 'pages', kind: 'route-handler', methods: ['ANY'] },
    };

    expect(legacyRoute.data.methods).toEqual(['ANY']);
    expect(describeNode(legacyRoute)).toBe(`ANY ${ITEMS_PATH}`);
  });
});

describe('INDEX_DIAGNOSTIC_CODES', () => {
  it('includes every code ./graph.ts and ../indexer.ts are specified to emit', () => {
    const present = new Set<string>(INDEX_DIAGNOSTIC_CODES);
    const missing = REQUIRED_DIAGNOSTIC_CODES.filter((code) => !present.has(code));

    expect(missing).toEqual([]);
  });
});

describe('the honest-ignorance members', () => {
  it('lets a classification report that it could not be established', () => {
    // Each of these members exists so a producer can be honest instead of
    // guessing: an unclassifiable declaration is still a name `./query.ts` can
    // find, and a wrongly guessed framework or package manager is worse for the
    // problem-understanding stage than an admitted `unknown`.
    expect(SYMBOL_DECLARATION_KINDS).toContain('unknown');
    expect(FRAMEWORK_NAMES).toContain('unknown');
    expect(PACKAGE_MANAGERS).toContain('unknown');
    expect(ROUTER_STYLES).toContain('none');
    expect(DATABASE_ACCESS_STYLES).toContain('none');
  });

  it('keeps the project-wide hybrid and both members the per-item vocabularies lack', () => {
    // `ROUTER_STYLES` describes a whole project and `ROUTER_KINDS` one route, so
    // only the first can say "both trees are present"; the same split holds for
    // `DATABASE_ACCESS_STYLES` against `DB_DRIVERS`.
    expect(ROUTER_STYLES).toContain('hybrid');
    expect(ROUTER_KINDS).not.toContain('hybrid');
    expect(DATABASE_ACCESS_STYLES).toContain('both');
    expect(DB_DRIVERS).not.toContain('both');
  });
});

describe('CODE_INDEX_SCHEMA_VERSION', () => {
  it('is a positive integer', () => {
    // Deliberately NOT the same constant as `../cache.ts`'s
    // `INDEX_CACHE_SCHEMA_VERSION`: this one versions an index's *contents* (the
    // vocabularies and payloads), that one versions the on-disk cache *entry*
    // that wraps it. Either must be able to move without the other, so a future
    // reader must not "unify" them.
    expect(Number.isInteger(CODE_INDEX_SCHEMA_VERSION)).toBe(true);
    expect(CODE_INDEX_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('is what a produced index stamps into schemaVersion', () => {
    expect(minimalIndex().schemaVersion).toBe(CODE_INDEX_SCHEMA_VERSION);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The membership predicates
 * ---------------------------------------------------------------------------
 */

describe('isCodeNodeKind', () => {
  it.each(CODE_NODE_KINDS)('accepts %s', (kind) => {
    expect(isCodeNodeKind(kind)).toBe(true);
    // Table-driven over the tuple itself, so a kind added to the vocabulary
    // without a guard that knows it fails here rather than at a cache read.
    expect(NODE_KIND_COVERAGE[narrowedNodeKind(kind, `the kind ${kind}`)]).toBe(true);
  });

  it.each(NON_NODE_KIND_STRINGS)('rejects the string %j', (value) => {
    expect(isCodeNodeKind(value)).toBe(false);
  });

  it.each(NON_STRING_VALUES)('rejects %s without throwing', (label, value) => {
    expect(() => isCodeNodeKind(value), `isCodeNodeKind must not throw for ${label}`).not.toThrow();
    expect(isCodeNodeKind(value)).toBe(false);
  });

  it('narrows an unknown value to CodeNodeKind for the compiler', () => {
    // `candidate` stands for a field of freshly parsed JSON. The annotation on
    // `narrowed` is the assertion: a predicate whose signature stopped being
    // `value is CodeNodeKind` would fail `pnpm typecheck` here, and the indexed
    // read below would fail with it.
    const candidate: unknown = 'component';
    const narrowed: CodeNodeKind = narrowedNodeKind(candidate, 'a parsed "component" string');

    expect(narrowed).toBe('component');
    expect(NODE_KIND_COVERAGE[narrowed]).toBe(true);
  });
});

describe('isCodeEdgeKind', () => {
  it.each(CODE_EDGE_KINDS)('accepts %s', (kind) => {
    expect(isCodeEdgeKind(kind)).toBe(true);
    expect(EDGE_KIND_COVERAGE[narrowedEdgeKind(kind, `the kind ${kind}`)]).toBe(true);
  });

  it.each(NON_EDGE_KIND_STRINGS)('rejects the string %j', (value) => {
    expect(isCodeEdgeKind(value)).toBe(false);
  });

  it.each(NON_STRING_VALUES)('rejects %s without throwing', (label, value) => {
    expect(() => isCodeEdgeKind(value), `isCodeEdgeKind must not throw for ${label}`).not.toThrow();
    expect(isCodeEdgeKind(value)).toBe(false);
  });

  it('narrows an unknown value to CodeEdgeKind for the compiler', () => {
    const candidate: unknown = 'routes-to';
    const narrowed: CodeEdgeKind = narrowedEdgeKind(candidate, 'a parsed "routes-to" string');

    expect(narrowed).toBe('routes-to');
    expect(EDGE_KIND_COVERAGE[narrowed]).toBe(true);
  });
});

describe('isIndexDiagnosticCode', () => {
  it.each(INDEX_DIAGNOSTIC_CODES)('accepts %s', (code) => {
    expect(isIndexDiagnosticCode(code)).toBe(true);
  });

  it.each(NON_DIAGNOSTIC_CODE_STRINGS)('rejects the string %j', (value) => {
    expect(isIndexDiagnosticCode(value)).toBe(false);
  });

  it.each(NON_STRING_VALUES)('rejects %s without throwing', (label, value) => {
    expect(
      () => isIndexDiagnosticCode(value),
      `isIndexDiagnosticCode must not throw for ${label}`,
    ).not.toThrow();
    expect(isIndexDiagnosticCode(value)).toBe(false);
  });

  it('narrows an unknown value to a code a diagnostic can carry', () => {
    const candidate: unknown = 'extractor-failed';
    const narrowed: IndexDiagnosticCode = narrowedDiagnosticCode(
      candidate,
      'a parsed "extractor-failed" string',
    );

    // Used where the closed type is required, which is what the narrowing is
    // for: `../cache.ts` checks a code read back from disk and then keeps the
    // diagnostic it belongs to.
    const diagnostic: IndexDiagnostic = {
      severity: 'error',
      code: narrowed,
      message: 'An extractor threw; its contribution for this file is absent.',
      file: WIDGET_FILE,
      extractorId: 'stub',
    };

    expect(diagnostic.code).toBe('extractor-failed');
    expect(INDEX_DIAGNOSTIC_SEVERITIES).toContain(diagnostic.severity);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The node union
 * ---------------------------------------------------------------------------
 */

describe('the CodeNode union', () => {
  it.each(CODE_NODE_KINDS)('narrows a %s node to its own payload', (kind) => {
    // `describeNode` reads, per branch, a field only that kind's payload
    // declares; the witness is a value that appears in no other payload, so a
    // branch reading the wrong field cannot pass.
    expect(describeNode(SAMPLE_NODES[kind])).toContain(NODE_KIND_WITNESS[kind]);
  });

  it('reads a db-call payload back at run time, not only at compile time', () => {
    const node: CodeNodeOf<'db-call'> = {
      id: 'node:db-call:2',
      kind: 'db-call',
      name: 'prisma.item.findMany',
      file: SERVICE_FILE,
      line: 24,
      column: 7,
      symbol: 'loadItems',
      data: { driver: 'prisma', model: 'item', operation: 'findMany', dynamic: false },
    };

    expect(node.data.driver).toBe('prisma');
    expect(describeNode(node)).toBe('query via prisma');
  });

  it('treats the payload of the two structural kinds as optional', () => {
    // A file is worth a node as the anchor of its edges and a symbol as a name
    // at a position, whether or not an extractor had more to add — so both
    // literals below compile without `data`, and `describeNode` handles them.
    const bareFile: CodeNodeOf<'file'> = {
      id: 'node:file:2',
      kind: 'file',
      name: SERVICE_FILE,
      file: SERVICE_FILE,
      line: 1,
      column: 1,
    };
    const bareSymbol: CodeNodeOf<'symbol'> = {
      id: 'node:symbol:2',
      kind: 'symbol',
      name: 'loadItems',
      file: SERVICE_FILE,
      line: 8,
      column: 1,
    };

    expect(describeNode(bareFile)).toBe('file of an unrecorded extension');
    expect(describeNode(bareSymbol)).toBe('symbol declared as unclassified');
  });

  it('holds only kinds the guard recognises', () => {
    const nodes: readonly CodeNode[] = CODE_NODE_KINDS.map((kind) => SAMPLE_NODES[kind]);

    expect(nodes).toHaveLength(CODE_NODE_KINDS.length);
    expect(nodes.filter((node) => !isCodeNodeKind(node.kind))).toEqual([]);
  });
});

describe('CodeNodeOf', () => {
  it('extracts one kind at a time, which nodesByKind and ../summary.ts depend on', () => {
    // The annotations are the assertions: each literal is checked against the
    // payload interface `CodeNodeOf<K>['data']` resolves to, so an extraction
    // that collapsed back to the whole union would reject `driver` here and
    // `routePath` below.
    const dbCallPayload: CodeNodeOf<'db-call'>['data'] = { driver: 'pg', dynamic: true };
    const routePayload: CodeNodeOf<'api-route'>['data'] = {
      routePath: ITEMS_PATH,
      router: 'app',
      kind: 'route-handler',
      methods: ['GET'],
    };
    // Optional for `file`, hence the `| undefined` in the resolved type and the
    // `?.` read below.
    const filePayload: CodeNodeOf<'file'>['data'] = {
      extension: '.ts',
      isClientModule: false,
      externalImports: [],
    };

    expect(dbCallPayload.driver).toBe('pg');
    expect(routePayload.methods).toEqual(['GET']);
    expect(filePayload?.externalImports).toEqual([]);
  });

  it('yields the whole union when passed the kind union', () => {
    const anyNode: CodeNodeOf<CodeNodeKind> = SAMPLE_NODES['db-call'];

    expect(anyNode.kind).toBe('db-call');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The persisted envelope
 * ---------------------------------------------------------------------------
 */

describe('CodeIndex', () => {
  it('survives a JSON round trip indistinguishably', () => {
    const index = minimalIndex();
    const revived = JSON.parse(JSON.stringify(index)) as CodeIndex;

    // `toStrictEqual` rather than `toEqual`: it distinguishes a present
    // `undefined` key from an absent one, which is the difference the envelope's
    // plain-JSON contract turns on. The string comparison adds key order, so a
    // future field that serialised non-deterministically would fail too.
    expect(revived).toStrictEqual(index);
    expect(JSON.stringify(revived)).toBe(JSON.stringify(index));
  });

  it('carries optional diagnostics through the same round trip', () => {
    const index: CodeIndex = { ...minimalIndex(), diagnostics: [SAMPLE_DIAGNOSTIC] };
    const revived = JSON.parse(JSON.stringify(index)) as CodeIndex;

    expect(revived).toStrictEqual(index);
    expect(revived.diagnostics).toHaveLength(1);
    expect(isIndexDiagnosticCode(revived.diagnostics?.[0]?.code)).toBe(true);
  });

  it('omits diagnostics entirely for a clean run', () => {
    // Absent rather than an empty array, which is what keeps a serialised clean
    // index minimal and why consumers read it as `diagnostics ?? []`.
    expect('diagnostics' in minimalIndex()).toBe(false);
  });

  it('holds no value a JSON round trip would change', () => {
    const found: string[] = [];
    collectJsonViolations(minimalIndex(), 'index', found);

    expect(found).toEqual([]);
  });

  it.each(JSON_CONTROLS)('the walk finds $label, so it is not vacuous', ({ value, expected }) => {
    const found: string[] = [];
    collectJsonViolations(value, 'control', found);

    expect(found).toEqual(expected);
  });

  it('names every path project-relative except the project root', () => {
    const index: CodeIndex = { ...minimalIndex(), diagnostics: [SAMPLE_DIAGNOSTIC] };
    const relativePaths: readonly (string | undefined)[] = [
      ...index.nodes.map((node) => node.file),
      ...index.edges.map((edge) => edge.file),
      ...index.files.map((fingerprint) => fingerprint.file),
      ...(index.diagnostics ?? []).map((diagnostic) => diagnostic.file),
    ];
    const offending = relativePaths.filter(
      (path) =>
        path !== undefined &&
        (path.length === 0 ||
          path.startsWith('/') ||
          path.includes('\\') ||
          path.split('/').includes('..')),
    );

    // Portability and safety both rest on this: node ids are derived from these
    // paths, and a relative POSIX path is what makes a `SourceLocation` openable
    // without a second sanitisation.
    expect(offending).toEqual([]);
    expect(index.projectRoot.startsWith('/')).toBe(true);
  });

  it('joins its edge to nodes it actually holds', () => {
    const index = minimalIndex();
    const ids = new Set(index.nodes.map((node) => node.id));
    const dangling = index.edges.filter((edge) => !ids.has(edge.from) || !ids.has(edge.to));

    // A producer that filters nodes must filter their edges too: `./graph.ts`
    // drops an edge whose endpoint is missing and reports `dangling-edge`.
    expect(dangling).toEqual([]);
    expect(index.edges.filter((edge) => !isCodeEdgeKind(edge.kind))).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The extractor contract
 * ---------------------------------------------------------------------------
 */

describe('the extractor contract', () => {
  it('is implementable with a synchronous extract and no diagnostics', () => {
    const result = STUB_EXTRACTOR.extract(STUB_EXTRACTOR_CONTEXT);

    expect(STUB_EXTRACTOR.id).toBe('stub');
    // Synchronous by contract: the declared return type is `ExtractorResult`, so
    // a promise here would not have compiled, and the run-time check states the
    // same thing for a reader.
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toStrictEqual({ nodes: [], edges: [] });
    expect('diagnostics' in result).toBe(false);
  });

  it('lets a result carry nodes, edges and diagnostics when there are findings', () => {
    const result: ExtractorResult = {
      nodes: [SAMPLE_NODES.component, SAMPLE_NODES.handler],
      edges: [{ ...DECLARES_EDGE, id: 'edge:handles:1', kind: 'handles' }],
      diagnostics: [SAMPLE_DIAGNOSTIC],
    };

    expect(result.nodes).toHaveLength(2);
    expect(result.edges.map((edge) => edge.kind)).toEqual(['handles']);
    expect(isIndexDiagnosticCode(result.diagnostics?.[0]?.code)).toBe(true);
  });

  it('answers a reference lookup with an empty list rather than throwing', () => {
    // An unanswerable lookup must not fail an investigation, which is why the
    // interface returns locations and never rejects.
    expect(() => STUB_REFERENCE_RESOLVER.referencesTo(STUB_REFERENCE_QUERY)).not.toThrow();
    expect(STUB_REFERENCE_RESOLVER.referencesTo(STUB_REFERENCE_QUERY)).toStrictEqual([]);
    expect(STUB_REFERENCE_QUERY.symbol).toBe('handleSubmit');
  });
});
