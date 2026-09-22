/**
 * The in-memory code graph — the container every consumer of an index reads
 * through, and the two identity constructors every producer of a node or an
 * edge calls.
 *
 * ## What this module is
 *
 * `./types.ts` declares the vocabulary; this module holds an instance of it.
 * {@link CodeGraph} takes a {@link CodeIndex} — the plain-JSON envelope
 * `../indexer.ts` assembles and `../cache.ts` persists — validates it, sorts it
 * into a canonical order and pre-computes the adjacency indices every lookup is
 * answered from, so that `./query.ts`, which runs many lookups per
 * model-facing query, never scans. {@link makeNodeId} and {@link makeEdgeId}
 * are the other half: the deterministic identity functions that make two
 * indexing runs over unchanged source produce byte-identical ids, which is what
 * makes an index cacheable and portable at all.
 *
 * It is pure data-structure work. No filesystem access, no abstract-syntax-tree
 * walk, no network, no clock, no randomness — and nothing a caller passed in is
 * ever mutated.
 *
 * ## Position in the module graph
 *
 * Imports `./types.js` and `@debuggen/shared`, and nothing else. `zod` is not a
 * dependency of this package, and no other `@debuggen/*` package may be
 * imported: `packages/instrumentation` and `apps/local-service` depend on
 * *this* package, so an upward import would close a cycle, which
 * `eslint.config.js` independently forbids with `no-restricted-imports`
 * (AAP 0.2.2).
 *
 * Imported by `../indexer.ts`, `../summary.ts`, `./query.ts` and the package
 * barrel `../index.ts` — none of which this module knows about. It must never
 * import `./query.js`, `../route-map.js`, `../indexer.js` or `../cache.js`: all
 * four sit above it.
 *
 * ## The flow this module sits in the middle of
 *
 * ```text
 * extractors  →  ../indexer.ts assembles a CodeIndex envelope
 *             →  CodeGraph.fromIndex(index)   ← validation happens here
 *             →  graph.toIndex()              ← what ../cache.ts persists
 * ```
 *
 * The indexer persists `graph.toIndex()` rather than the envelope it assembled,
 * and that is deliberate: construction is where a duplicate id, a dangling edge
 * or an unknown kind is found, and taking the graph's own view back out is how
 * those findings — and the removals they describe — reach the cached index
 * instead of being rediscovered on every load.
 *
 * ## Degrade, never throw
 *
 * A cache entry read back from `$DEBUGGEN_HOME/index` is untrusted input: it
 * may have been written by an older vocabulary, truncated, or hand-edited.
 * {@link CodeGraph.fromIndex} therefore drops what it cannot use and records an
 * {@link IndexDiagnostic} for each removal instead of throwing, so a stale
 * cache costs a caller some evidence rather than a crashed investigation
 * (AAP 0.5.5's graceful-failure rule applied to indexing).
 *
 * ## Immutability
 *
 * Every array this module hands out is frozen, and every lookup that can miss
 * answers with a shared frozen empty array rather than `undefined` —
 * {@link CodeGraph.nodeById} is the single exception, because "no node with
 * that id" has no sensible empty value. Node and edge **objects** are shared by
 * reference with the index they came from and with every caller: they are
 * records of what the source said at index time and must be treated as
 * immutable.
 *
 * @packageDocumentation
 */

import { assertNever, noopLogger } from '@debuggen/shared';

import {
  CODE_INDEX_SCHEMA_VERSION,
  CODE_NODE_KINDS,
  isCodeEdgeKind,
  isCodeNodeKind,
} from './types.js';

import type { Logger } from '@debuggen/shared';

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
 * Shared empties and bounds
 * ---------------------------------------------------------------------------------------------- */

/**
 * The answer to every node lookup that matched nothing.
 *
 * One frozen instance, shared: a miss is the common case in a traversal, and an
 * accessor that returned a fresh `[]` each time would allocate on every one of
 * them. Frozen because it is shared — a caller that mutated it would corrupt
 * every later miss in the process.
 */
const EMPTY_NODES: readonly CodeNode[] = Object.freeze([]);

/**
 * The answer to every edge lookup that matched nothing, for the reasons given
 * on {@link EMPTY_NODES}.
 */
const EMPTY_EDGES: readonly CodeEdge[] = Object.freeze([]);

/**
 * The diagnostics list of a graph built from a clean index.
 *
 * Shared and frozen so that a clean construction — the overwhelmingly common
 * one — allocates nothing, and so that {@link CodeGraph.toIndex} can compare
 * against a length of zero to decide whether to emit the optional
 * `diagnostics` field at all.
 */
const EMPTY_DIAGNOSTICS: readonly IndexDiagnostic[] = Object.freeze([]);

/**
 * How deep {@link structurallyEqual} will descend before it gives up and
 * reports "not equal".
 *
 * A {@link CodeIndex} is plain JSON by contract and its deepest payload is a
 * handful of levels, so this bound is never reached by well-formed input. It
 * exists because the comparison runs on *untrusted* input: a cache entry
 * assembled by something other than this code could hold a cyclic object
 * graph, and an unbounded recursion over one would hang the indexer rather than
 * report a problem. Exceeding the bound is deliberately conservative — the two
 * values are treated as differing, which costs one `duplicate-node-id`
 * diagnostic and never a wrong result.
 */
const MAX_STRUCTURAL_COMPARISON_DEPTH = 32;

/* -------------------------------------------------------------------------------------------------
 * Canonical ordering
 * ---------------------------------------------------------------------------------------------- */

/**
 * Byte-wise lexicographic comparison of two strings.
 *
 * **Never `localeCompare`.** A locale-aware comparison depends on the machine's
 * collation settings, which would make the order of a serialised index — and
 * therefore the index itself — differ between two developers running the same
 * indexer over the same source. That would break `../indexer.ts`'s
 * reproducibility assertion and invalidate a shared cache entry for no reason.
 *
 * @param left The first string.
 * @param right The second string.
 * @returns A negative number, zero, or a positive number, as
 * `Array.prototype.sort` expects.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

/**
 * Canonical comparator for nodes and edges alike: ascending by `id`.
 *
 * Typed structurally rather than over {@link CodeNode} or {@link CodeEdge}, so
 * one comparator serves both and the canonical order is defined exactly once.
 * Ids are unique within an index after construction, so the order is total and
 * the sort's stability is not load-bearing for the result — it *is* load-bearing
 * while duplicates are still present, which is why de-duplication runs before
 * sorting and keeps the first claimant.
 *
 * @param left The first entry.
 * @param right The second entry.
 * @returns The comparison of the two `id` values.
 */
function compareById(left: { readonly id: string }, right: { readonly id: string }): number {
  return compareStrings(left.id, right.id);
}

/**
 * Canonical comparator for file fingerprints: ascending by project-relative
 * path.
 *
 * The order {@link CodeIndex.files} documents, and the reason `../cache.ts` can
 * fold the list into a cache key without sorting it again.
 *
 * @param left The first fingerprint.
 * @param right The second fingerprint.
 * @returns The comparison of the two `file` values.
 */
function compareByFile(left: FileFingerprint, right: FileFingerprint): number {
  return compareStrings(left.file, right.file);
}

/* -------------------------------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------------------------------- */

/**
 * Percent-escapes every character this module's id grammar uses as a
 * delimiter.
 *
 * The escape set is exactly `%`, `:`, `#`, `@` and `>`, and `%` is escaped
 * first so the transformation is injective: a value containing `%3A` is
 * encoded as `%253A` and can never be confused with a value containing a
 * literal `:`. That is what makes {@link makeNodeId} and {@link makeEdgeId}
 * injective as a whole — a file path carrying a colon cannot forge the id of a
 * different declaration by shifting the boundary between two components.
 *
 * Deliberately not `encodeURIComponent`: it escapes far more than the grammar
 * needs (every non-ASCII character, among others), which would make an id of a
 * path with accented characters unreadable in a diagnostic for no gain.
 *
 * @param value One interpolated id component.
 * @returns The component with every delimiter character percent-escaped.
 */
function escapeIdPart(value: string): string {
  return value
    .replaceAll('%', '%25')
    .replaceAll(':', '%3A')
    .replaceAll('#', '%23')
    .replaceAll('@', '%40')
    .replaceAll('>', '%3E');
}

/**
 * Everything {@link makeNodeId} derives a node's identity from.
 *
 * Exactly the fields of {@link CodeNode} that identify *which declaration this
 * is*: its kind, where it was written, and what it is called. Nothing that can
 * change while the declaration stays the same — no payload, no export flag, no
 * end line — participates, so an extractor that learns more about a node later
 * does not thereby rename it.
 */
export interface NodeIdInput {
  /** The node's kind, the first component of the id. */
  readonly kind: CodeNodeKind;

  /**
   * The node's file: **project-relative, POSIX separators**, exactly as
   * {@link CodeNode.file} requires.
   *
   * An absolute path here is a caller bug. It produces a perfectly valid id
   * that is *not stable across checkouts*, which silently defeats the cache and
   * the reproducibility assertion built on it — see the note on
   * {@link makeNodeId}.
   */
  readonly file: string;

  /** The node's source-spelled name. */
  readonly name: string;

  /** The **1-based** line the declaration starts on. */
  readonly line: number;

  /** The **1-based** column the declaration starts at. */
  readonly column: number;
}

/**
 * Builds the identity of a code-graph node.
 *
 * Every extractor calls this rather than composing an id itself, because the
 * two properties the graph depends on are properties of *this function* and not
 * of any particular call site:
 *
 * - **Deterministic.** The same input yields the same id on every call, in
 *   every process, on every machine. No counter, no randomness, no clock, no
 *   hashing. This is what lets `../indexer.ts` promise that two runs over
 *   unchanged source produce an identical index, and it is why
 *   {@link CodeIndex.generatedAt} is the only field that legitimately differs
 *   between two such runs.
 * - **Injective.** Inputs differing in any component produce different ids,
 *   including when a component contains a delimiter character — see
 *   {@link escapeIdPart}.
 *
 * The result is human-readable on purpose: ids appear verbatim in
 * {@link IndexDiagnostic} messages and in the query results the investigation
 * stage puts in front of a model, and an opaque digest there would cost a
 * reader the one clue that makes a diagnostic actionable.
 *
 * **No consumer may parse an id.** The `kind:file#name@line:column` shape is an
 * implementation detail of this module and is free to change; to learn
 * something about a node, read its fields, and to find a node, ask
 * {@link CodeGraph}.
 *
 * `file` must be project-relative POSIX. An absolute path is **not** normalised
 * here — silently rewriting it would hide the bug at the one place it is still
 * cheap to notice — and it is not rejected either, because this function must
 * stay total for a caller assembling a node from partially resolved
 * information. It simply produces an id tied to one machine's directory
 * layout, which will not match the cached index of the same commit checked out
 * elsewhere.
 *
 * @param input The identifying fields of the node.
 * @returns The node's id.
 *
 * @example
 * ```ts
 * const id = makeNodeId({
 *   kind: 'component',
 *   file: 'src/components/Widget.tsx',
 *   name: 'Widget',
 *   line: 12,
 *   column: 1,
 * });
 * // 'component:src/components/Widget.tsx#Widget@12:1'
 * ```
 */
export function makeNodeId(input: NodeIdInput): string {
  return `${input.kind}:${escapeIdPart(input.file)}#${escapeIdPart(input.name)}@${input.line}:${input.column}`;
}

/**
 * Everything {@link makeEdgeId} derives an edge's identity from.
 *
 * An edge is identified by its relationship and its *site*: the same caller may
 * call the same callee twice in one file, and those are two edges, so the line
 * and column of the call expression are part of the identity. A derived edge
 * has no site — a `routes-to` edge is computed from two nodes rather than read
 * off a line of source — which is why both position fields are optional.
 */
export interface EdgeIdInput {
  /** The edge's kind, the first component of the id. */
  readonly kind: CodeEdgeKind;

  /** The {@link CodeNode.id} the relationship starts at. */
  readonly from: string;

  /** The {@link CodeNode.id} the relationship points at. */
  readonly to: string;

  /**
   * The **1-based** line of the edge site, when the edge has one.
   *
   * Absent and `0` produce different ids, so an extractor that does not know
   * the position must omit it rather than pass a placeholder.
   */
  readonly line?: number;

  /** The **1-based** column of the edge site, when the edge has one. */
  readonly column?: number;
}

/**
 * Builds the identity of a code-graph edge.
 *
 * Deterministic and injective on the same terms as {@link makeNodeId}, whose
 * documentation carries the full contract — including the rule that **no
 * consumer may parse an id**. Both endpoints are escaped, so the node ids they
 * carry (which contain this grammar's delimiters themselves) cannot shift the
 * boundaries of the edge id.
 *
 * An absent `line` or `column` is rendered as an empty component, which keeps
 * the grammar fixed-arity: `calls:…>…@:` is the id of a sited-nowhere edge, and
 * it differs from `calls:…>…@0:0`.
 *
 * @param input The identifying fields of the edge.
 * @returns The edge's id.
 *
 * @example
 * ```ts
 * const id = makeEdgeId({
 *   kind: 'calls',
 *   from: 'handler:src/components/Widget.tsx#handleSubmit@20:3',
 *   to: 'api-call:src/components/Widget.tsx#load@24:11',
 *   line: 24,
 *   column: 11,
 * });
 * ```
 */
export function makeEdgeId(input: EdgeIdInput): string {
  const line = input.line ?? '';
  const column = input.column ?? '';

  return `${input.kind}:${escapeIdPart(input.from)}>${escapeIdPart(input.to)}@${line}:${column}`;
}

/* -------------------------------------------------------------------------------------------------
 * Construction diagnostics
 * ---------------------------------------------------------------------------------------------- */

/**
 * The five {@link IndexDiagnostic} codes this module is the declared emitter
 * of.
 *
 * `./types.ts` assigns every code in its closed vocabulary to exactly one
 * emitter, and these are the ones assigned here. Stating them as a local union
 * rather than reaching for the whole `IndexDiagnosticCode` type keeps that
 * assignment checkable in both directions: this module cannot emit a code that
 * belongs to the indexer or to an extractor, and a code renamed in the
 * vocabulary fails to compile here.
 *
 * Notably absent is any code for a **schema-version mismatch**. The vocabulary
 * has none, and inventing one by borrowing another code's meaning would make
 * the mismatch unattributable; see {@link CodeGraph.fromIndex} for what happens
 * instead.
 */
type ConstructionDiagnosticCode =
  | 'unknown-node-kind'
  | 'unknown-edge-kind'
  | 'duplicate-node-id'
  | 'duplicate-edge-id'
  | 'dangling-edge';

/**
 * Builds one construction diagnostic.
 *
 * Every finding from construction is a `warning`: the graph is usable but
 * incomplete in a way that can change a result, which is precisely that
 * severity's definition in `./types.ts`. Nothing here is an `error` — no part
 * of the index failed to be *produced* — and nothing is `info`, because an
 * entry was dropped.
 *
 * The `file` field is set only when there is a file to name, because
 * `exactOptionalPropertyTypes` is on and a `{ file: undefined }` property would
 * not survive the JSON round trip the envelope contract requires.
 *
 * Messages name ids, endpoints and files and quote **no source text**, per the
 * privacy constraint on the diagnostic vocabulary in `./types.ts`: a diagnostic
 * is persisted with a session and can reach model prompt context.
 *
 * @param code Which finding this is.
 * @param message The developer-facing sentence.
 * @param file The file the finding concerns, when it concerns one.
 * @returns The diagnostic.
 */
function constructionDiagnostic(
  code: ConstructionDiagnosticCode,
  message: string,
  file?: string,
): IndexDiagnostic {
  if (file === undefined) {
    return { severity: 'warning', code, message };
  }

  return { severity: 'warning', code, message, file };
}

/**
 * De-duplicates a diagnostics list by `(code, message, file)`, keeping the
 * first occurrence of each.
 *
 * Construction can find the same pathology more than once — two nodes claiming
 * one id in three places, an edge dropped twice because its first occurrence
 * was itself dropped — and repeating the identical sentence tells a reader
 * nothing new. The triple is the identity of a *finding*; `severity` and
 * `detail` deliberately do not participate, so two entries that differ only in
 * those collapse, which is why the round-trip contract on
 * {@link CodeGraph.toIndex} is stated for an index whose diagnostics are
 * themselves distinct.
 *
 * @param list The diagnostics to de-duplicate, in the order they should keep.
 * @returns A frozen list in first-occurrence order, or the shared empty list.
 */
function dedupeDiagnostics(list: readonly IndexDiagnostic[]): readonly IndexDiagnostic[] {
  if (list.length === 0) {
    return EMPTY_DIAGNOSTICS;
  }

  const seen = new Set<string>();
  const kept: IndexDiagnostic[] = [];

  for (const diagnostic of list) {
    // A NUL separator cannot occur in any of the three components: a message is
    // authored text and a project-relative path is rejected by the shared path
    // guard if it carries a control character, so the composite key is
    // unambiguous.
    const key = `${diagnostic.code}\u0000${diagnostic.message}\u0000${diagnostic.file ?? ''}`;

    if (!seen.has(key)) {
      seen.add(key);
      kept.push(diagnostic);
    }
  }

  return Object.freeze(kept);
}

/* -------------------------------------------------------------------------------------------------
 * Structural comparison of plain JSON
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a value is an array, without widening it to `any[]`.
 *
 * `Array.isArray` narrows an `unknown` to `any[]`, and every element read from
 * that would be an `any` flowing through the comparison below — which the
 * type-aware lint rules reject, correctly: an `any` in a validator defeats the
 * validator. Returning the plain boolean and declaring the narrowing as
 * `readonly unknown[]` keeps every element `unknown` and every recursion
 * honest.
 *
 * @param value Any value.
 * @returns `true` when `value` is an array.
 */
function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Whether a value is a non-null, non-array object — the JSON "object" case.
 *
 * @param value Any value.
 * @returns `true` when `value` can be read as a record of `unknown`s.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isJsonArray(value);
}

/**
 * The own keys of a record whose value is not `undefined`.
 *
 * `undefined` is not a JSON value, and the envelope contract states that an
 * optional field means "absent or a value" and never "present and undefined".
 * Ignoring such keys therefore makes the comparison agree with what
 * `JSON.stringify` would produce, so a node assembled with an explicitly
 * undefined optional field compares equal to the same node read back from the
 * cache.
 *
 * @param record The record to read.
 * @returns Its keys with a defined value, in `Object.keys` order.
 */
function presentKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((key) => record[key] !== undefined);
}

/**
 * Deep structural equality over plain JSON values.
 *
 * Used for exactly one decision: when two entries claim one id, whether the
 * later one is an identical restatement (dropped silently) or a genuine
 * conflict (dropped **and** reported). That decision has to be made on the
 * whole entry, because an extractor can legitimately produce the same node
 * twice from two passes over one declaration, while two *different* nodes
 * sharing an id mean an id derivation is wrong and a reader needs to know.
 *
 * Written here rather than taken from a dependency because the values are plain
 * JSON by contract — no `Map`, `Set`, `Date`, class instance or function
 * anywhere in an index — which makes the comparison a dozen lines and keeps
 * this package's dependency list at the three entries its manifest declares.
 *
 * Bounded by {@link MAX_STRUCTURAL_COMPARISON_DEPTH}; see that constant for
 * why, and for why exceeding it reports "not equal".
 *
 * @param left The first value.
 * @param right The second value.
 * @param depth Current recursion depth; callers omit it.
 * @returns `true` when the two values are indistinguishable as JSON.
 */
function structurallyEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (left === right) {
    return true;
  }

  if (depth >= MAX_STRUCTURAL_COMPARISON_DEPTH) {
    return false;
  }

  if (isJsonArray(left) || isJsonArray(right)) {
    if (!isJsonArray(left) || !isJsonArray(right) || left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!structurallyEqual(left[index], right[index], depth + 1)) {
        return false;
      }
    }

    return true;
  }

  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    // Two primitives that are not `===` (including `NaN`, and `0` versus
    // `'0'`), or one object against one primitive.
    return false;
  }

  const leftKeys = presentKeys(left);
  const rightKeys = presentKeys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) {
      return false;
    }

    if (!structurallyEqual(left[key], right[key], depth + 1)) {
      return false;
    }
  }

  return true;
}

/* -------------------------------------------------------------------------------------------------
 * Index construction helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Selects the nodes a graph will hold, in input order, recording a diagnostic
 * for each rejection.
 *
 * Two rejections, in this order, which is the order the construction contract
 * specifies:
 *
 * 1. **Unknown kind.** The static type says a node's `kind` is a
 *    {@link CodeNodeKind}; a cache entry read back from disk is only *typed*
 *    that way, so the kind is re-tested against the live vocabulary. The value
 *    is read into an `unknown` first, deliberately: narrowing the property
 *    itself would narrow the discriminated union around it and make the
 *    defensive branch unreachable to the compiler, which is exactly the branch
 *    that has to survive.
 * 2. **Duplicate id.** The first claimant of an id wins, because extractor
 *    order is meaningful. A later claimant that is structurally identical is
 *    dropped silently — the same declaration seen twice is not a problem — and
 *    one that differs is dropped and reported.
 *
 * @param input The index's nodes, in the order the indexer emitted them.
 * @param diagnostics Collector appended to in place; owned by the caller.
 * @returns The surviving nodes keyed by id, in input order.
 */
function selectNodes(
  input: readonly CodeNode[],
  diagnostics: IndexDiagnostic[],
): Map<string, CodeNode> {
  const selected = new Map<string, CodeNode>();

  for (const node of input) {
    const kind: unknown = node.kind;

    if (!isCodeNodeKind(kind)) {
      diagnostics.push(
        constructionDiagnostic(
          'unknown-node-kind',
          `Node ${node.id} was dropped: its kind is not part of this version's node vocabulary.`,
          node.file,
        ),
      );
      continue;
    }

    const first = selected.get(node.id);

    if (first === undefined) {
      selected.set(node.id, node);
      continue;
    }

    if (!structurallyEqual(first, node)) {
      diagnostics.push(
        constructionDiagnostic(
          'duplicate-node-id',
          `Node id ${node.id} was claimed by two differing nodes; the first was kept.`,
          node.file,
        ),
      );
    }
  }

  return selected;
}

/**
 * Selects the edges a graph will hold, in input order, recording a diagnostic
 * for each rejection.
 *
 * Three rejections, in the order the construction contract specifies — unknown
 * kind, duplicate id, then dangling endpoint:
 *
 * 1. **Unknown kind**, re-tested against the live vocabulary for the same
 *    reason {@link selectNodes} re-tests a node's kind.
 * 2. **Duplicate id**, judged against every id *claimed* so far rather than
 *    against the surviving set, so an edge whose first occurrence was dropped
 *    as dangling is reported once as dangling rather than twice under two
 *    codes.
 * 3. **Dangling endpoint.** An edge whose `from` or `to` names no node in the
 *    index is dropped — never kept silently, and never kept at all. A
 *    half-connected relation would make `./query.ts`'s traversals reach an id
 *    that resolves to nothing, and this is precisely why an import that
 *    resolves outside the project is recorded in
 *    `FileNodeData.externalImports` instead of as an edge: there is no node for
 *    it to point at.
 *
 * @param input The index's edges, in the order the indexer emitted them.
 * @param nodesById The already-selected nodes, which define what "dangling"
 * means — an edge pointing at a node that was itself dropped is dangling too.
 * @param diagnostics Collector appended to in place; owned by the caller.
 * @returns The surviving edges keyed by id, in input order.
 */
function selectEdges(
  input: readonly CodeEdge[],
  nodesById: ReadonlyMap<string, CodeNode>,
  diagnostics: IndexDiagnostic[],
): Map<string, CodeEdge> {
  const claimed = new Map<string, CodeEdge>();
  const selected = new Map<string, CodeEdge>();

  for (const edge of input) {
    const kind: unknown = edge.kind;

    if (!isCodeEdgeKind(kind)) {
      diagnostics.push(
        constructionDiagnostic(
          'unknown-edge-kind',
          `Edge ${edge.id} was dropped: its kind is not part of this version's edge vocabulary.`,
          edge.file,
        ),
      );
      continue;
    }

    const first = claimed.get(edge.id);

    if (first !== undefined) {
      if (!structurallyEqual(first, edge)) {
        diagnostics.push(
          constructionDiagnostic(
            'duplicate-edge-id',
            `Edge id ${edge.id} was claimed by two differing edges; the first was kept.`,
            edge.file,
          ),
        );
      }
      continue;
    }

    claimed.set(edge.id, edge);

    const missing: string[] = [];

    if (!nodesById.has(edge.from)) {
      missing.push('from');
    }

    if (!nodesById.has(edge.to)) {
      missing.push('to');
    }

    if (missing.length > 0) {
      diagnostics.push(
        constructionDiagnostic(
          'dangling-edge',
          `Edge ${edge.id} was dropped: its ${missing.join(' and ')} endpoint names no node in this index.`,
          edge.file,
        ),
      );
      continue;
    }

    selected.set(edge.id, edge);
  }

  return selected;
}

/**
 * Groups items into frozen buckets under a caller-chosen string key.
 *
 * Shared by the file, name, outgoing and incoming indices, because all four are
 * the same operation over a different key — building them once during
 * construction is what turns every one of those lookups into a map read
 * instead of a scan of the whole graph.
 *
 * Each bucket preserves the order of `items`, so a bucket built from a
 * canonically sorted array is canonically sorted itself. That is the whole
 * mechanism behind the adjacency arrays' determinism: they inherit edge-id
 * order from {@link CodeGraph.edges}, which is what makes a breadth-first
 * traversal in `./query.ts` visit neighbours in the same order on every run.
 *
 * @typeParam T The item type.
 * @param items The items to group, in the order the buckets should keep.
 * @param key Extracts the bucket key from an item.
 * @returns A map of frozen buckets. Keys with no items are simply absent.
 */
function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const buckets = new Map<string, T[]>();

  for (const item of items) {
    const bucketKey = key(item);
    const bucket = buckets.get(bucketKey);

    if (bucket === undefined) {
      buckets.set(bucketKey, [item]);
    } else {
      bucket.push(item);
    }
  }

  const frozen = new Map<string, readonly T[]>();

  for (const [bucketKey, bucket] of buckets) {
    frozen.set(bucketKey, Object.freeze(bucket));
  }

  return frozen;
}

/**
 * The per-kind node index while it is being filled.
 *
 * A mapped type over the closed kind vocabulary rather than a
 * `Map<CodeNodeKind, CodeNode[]>`, and that is the point: each bucket's element
 * type is the {@link CodeNodeOf} member for *its* kind, so
 * {@link CodeGraph.nodesByKind} can return a per-kind array without a cast, and
 * `../summary.ts` can read a `db-call` node's driver straight off it.
 */
type MutableNodesByKind = { [K in CodeNodeKind]: CodeNodeOf<K>[] };

/**
 * The frozen, per-kind node index a {@link CodeGraph} holds.
 *
 * The read-only view of {@link MutableNodesByKind}. Every kind is present with
 * an array, so a kind with no nodes reads as an empty one rather than as a
 * missing key — which is what lets the accessor answer a miss without a
 * fallback.
 */
type NodesByKind = { readonly [K in CodeNodeKind]: readonly CodeNodeOf<K>[] };

/**
 * Groups nodes by kind into the per-kind index.
 *
 * The `switch` is exhaustive over the closed vocabulary and its `default`
 * branch calls `assertNever`, so adding a kind to `./types.ts` fails to compile
 * here until it has a bucket — which is the compiler enforcing a promise this
 * module could not otherwise keep. It also removes every cast: in each `case`
 * the node is narrowed to that kind's union member, which is exactly what its
 * bucket accepts.
 *
 * @param nodes The graph's nodes, in canonical order.
 * @returns The frozen per-kind index, each bucket in canonical order.
 */
function groupNodesByKind(nodes: readonly CodeNode[]): NodesByKind {
  const buckets: MutableNodesByKind = {
    file: [],
    symbol: [],
    component: [],
    handler: [],
    'api-call': [],
    'api-route': [],
    'server-function': [],
    'db-call': [],
  };

  for (const node of nodes) {
    switch (node.kind) {
      case 'file':
        buckets.file.push(node);
        break;
      case 'symbol':
        buckets.symbol.push(node);
        break;
      case 'component':
        buckets.component.push(node);
        break;
      case 'handler':
        buckets.handler.push(node);
        break;
      case 'api-call':
        buckets['api-call'].push(node);
        break;
      case 'api-route':
        buckets['api-route'].push(node);
        break;
      case 'server-function':
        buckets['server-function'].push(node);
        break;
      case 'db-call':
        buckets['db-call'].push(node);
        break;
      default:
        return assertNever(node, 'Unhandled code node kind');
    }
  }

  for (const kind of CODE_NODE_KINDS) {
    Object.freeze(buckets[kind]);
  }

  return buckets;
}

/**
 * Narrows an adjacency list to one edge kind.
 *
 * The list itself is reached in constant time; this filter is linear in the
 * node's degree, which is what {@link CodeGraph.outgoing} documents. Returns
 * the input array unchanged when every edge matches, and the shared empty array
 * when none does, so the common cases allocate nothing.
 *
 * @param edges One node's adjacency list, already frozen.
 * @param kind The kind to keep, or `undefined` to keep everything.
 * @returns A frozen list of the matching edges, in the input's order.
 */
function filterEdgesByKind(
  edges: readonly CodeEdge[],
  kind: CodeEdgeKind | undefined,
): readonly CodeEdge[] {
  if (kind === undefined) {
    return edges;
  }

  const matched = edges.filter((edge) => edge.kind === kind);

  if (matched.length === edges.length) {
    return edges;
  }

  if (matched.length === 0) {
    return EMPTY_EDGES;
  }

  return Object.freeze(matched);
}

/* -------------------------------------------------------------------------------------------------
 * Public option and result shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * Which way {@link CodeGraph.neighbors} follows edges.
 *
 * - `out` — along the edges, from this node to the nodes it points at. The
 *   default, because most questions about a graph are forward ones: what this
 *   component renders, what this function calls, what this route queries.
 * - `in` — against the edges, which is how a "who reaches this?" question is
 *   answered.
 * - `both` — the union of the two, de-duplicated.
 */
export type NeighborDirection = 'out' | 'in' | 'both';

/**
 * How to narrow a neighbour traversal.
 *
 * Both fields are optional; the default is every edge kind, followed forwards.
 */
export interface NeighborOptions {
  /**
   * Follow only edges of this kind.
   *
   * Omit it to follow every kind — which is what a path search wants, since the
   * hop from a route to a service function is legitimately expressible as more
   * than one kind (see the reachability invariant on `CODE_EDGE_KINDS`).
   */
  readonly kind?: CodeEdgeKind;

  /** Which way to follow edges. Defaults to `'out'`. */
  readonly direction?: NeighborDirection;
}

/**
 * How much a {@link CodeGraph} holds, **after** construction removed anything
 * it could not use.
 *
 * Counted from the graph's own arrays rather than from the index it was built
 * from, so a caller reporting these numbers is reporting what is actually
 * queryable. The difference between these counts and the input's array lengths
 * is described by {@link CodeGraph.diagnostics}.
 */
export interface CodeGraphSize {
  /** How many nodes the graph holds. */
  readonly nodes: number;

  /** How many edges the graph holds. */
  readonly edges: number;
}

/**
 * Options for {@link CodeGraph.fromIndex}.
 */
export interface CodeGraphOptions {
  /**
   * Where construction reports what it did.
   *
   * Used **during construction only** — one debug line with the resulting
   * counts, and one info line when the index was built against a different
   * vocabulary version. The graph holds no logger afterwards: every accessor is
   * a pure lookup with nothing to report, and a container that logged on read
   * would flood a traversal.
   *
   * Defaults to `noopLogger`, the convention for library code in this
   * repository: a caller decides where output goes, and silence costs nothing.
   */
  readonly logger?: Logger;
}

/* -------------------------------------------------------------------------------------------------
 * CodeGraph
 * ---------------------------------------------------------------------------------------------- */

/**
 * A validated, canonically ordered, pre-indexed view of one {@link CodeIndex}.
 *
 * ## How an instance comes to exist
 *
 * {@link CodeGraph.fromIndex} is the only way — the constructor is private —
 * and it is the point in the pipeline where an index is validated:
 *
 * ```text
 * ../indexer.ts assembles a CodeIndex from extractor output
 *   → CodeGraph.fromIndex(index)
 *       drops nodes with an unknown kind        → unknown-node-kind
 *       drops duplicate ids, first claimant wins → duplicate-node-id / duplicate-edge-id
 *       drops edges with an unknown kind        → unknown-edge-kind
 *       drops edges with a missing endpoint     → dangling-edge
 *       sorts nodes and edges by id, files by path
 *       builds every adjacency index
 *   → ../indexer.ts persists graph.toIndex() through ../cache.ts
 * ```
 *
 * That last step is why construction records diagnostics instead of throwing:
 * the indexer writes the graph's *own* view back out, so the removals and the
 * findings that describe them land in the cached index and are not rediscovered
 * on every load. A caller that loaded a corrupt entry gets a smaller graph and
 * a list of warnings, never an exception.
 *
 * ## What is guaranteed of the contents
 *
 * - Node ids are unique; edge ids are unique.
 * - Every edge's `from` and `to` resolve to a node in this graph, so a
 *   traversal cannot reach a dead id.
 * - Every node's `kind` and every edge's `kind` is a member of the live
 *   vocabulary.
 * - {@link CodeGraph.nodes} is sorted ascending by node id,
 *   {@link CodeGraph.edges} by edge id, {@link CodeGraph.files} by
 *   project-relative path, all byte-wise. Every per-node and per-kind bucket
 *   inherits that order, which is what makes a traversal in `./query.ts`
 *   deterministic.
 *
 * ## Immutability
 *
 * Every array returned is frozen, and every accessor that can miss answers
 * with an empty array — {@link CodeGraph.nodeById} alone may return
 * `undefined`. The node and edge **objects** are the very objects the index
 * carried: they are shared with the caller, with the index and with any other
 * graph built from it, and must be treated as immutable. Nothing in the input
 * index — not the envelope, not its arrays, not its entries — is mutated.
 *
 * @example
 * ```ts
 * const graph = CodeGraph.fromIndex(index);
 *
 * for (const component of graph.nodesByKind('component')) {
 *   const handlers = graph.neighbors(component.id, { kind: 'handles' });
 *   // `component.data` is a ComponentNodeData here, with no cast.
 * }
 * ```
 */
export class CodeGraph {
  /**
   * The vocabulary version the source index declared.
   *
   * Carried through unchanged, even when it differs from
   * `CODE_INDEX_SCHEMA_VERSION`: this class reports a mismatch and keeps
   * working, and `../cache.ts` is what decides an entry is too old to reuse.
   */
  readonly schemaVersion: number;

  /** The indexed project's root: absolute POSIX, the one absolute path here. */
  readonly projectRoot: string;

  /** The version of the indexer that produced the source index. */
  readonly indexerVersion: string;

  /** When the source index was built, in epoch milliseconds. */
  readonly generatedAt: number;

  /**
   * The fingerprint of every indexed file, frozen and sorted ascending by
   * project-relative path.
   */
  readonly files: readonly FileFingerprint[];

  /**
   * Every finding about this graph: the source index's own diagnostics first,
   * then construction's, de-duplicated by `(code, message, file)` with the
   * first occurrence kept.
   *
   * Frozen. Empty for a clean index built from a clean envelope, which is what
   * lets {@link CodeGraph.toIndex} omit the field entirely.
   */
  readonly diagnostics: readonly IndexDiagnostic[];

  /** Canonically ordered nodes; the backing array of {@link CodeGraph.nodes}. */
  readonly #nodes: readonly CodeNode[];

  /** Canonically ordered edges; the backing array of {@link CodeGraph.edges}. */
  readonly #edges: readonly CodeEdge[];

  /** Node by id, for the constant-time identity lookup every traversal needs. */
  readonly #byId: ReadonlyMap<string, CodeNode>;

  /** Nodes by kind, typed per kind so no accessor needs a cast. */
  readonly #byKind: NodesByKind;

  /** Nodes by project-relative file path, exactly as stored. */
  readonly #byFile: ReadonlyMap<string, readonly CodeNode[]>;

  /** Nodes by exact source-spelled name. */
  readonly #byName: ReadonlyMap<string, readonly CodeNode[]>;

  /** Edges by their `from` endpoint: the forward adjacency list. */
  readonly #outgoing: ReadonlyMap<string, readonly CodeEdge[]>;

  /** Edges by their `to` endpoint: the reverse adjacency list. */
  readonly #incoming: ReadonlyMap<string, readonly CodeEdge[]>;

  /** Pre-computed and frozen, so {@link CodeGraph.size} allocates nothing. */
  readonly #size: CodeGraphSize;

  /**
   * Validates an index and builds every adjacency structure from it.
   *
   * Private: {@link CodeGraph.fromIndex} is the single construction path, so
   * there is exactly one place where validation can be skipped — and there
   * isn't one. All the work happens here, once, because every accessor is then
   * a map read.
   *
   * @param index The index to hold. Never mutated: the arrays are copied before
   * they are sorted and the entries are only read.
   * @param logger Where the two construction log lines go.
   */
  private constructor(index: CodeIndex, logger: Logger) {
    const collected: IndexDiagnostic[] = [...(index.diagnostics ?? [])];

    // Nodes first: what survives here is what defines a dangling edge below.
    const selectedNodes = selectNodes(index.nodes, collected);
    const selectedEdges = selectEdges(index.edges, selectedNodes, collected);

    const nodes = Object.freeze([...selectedNodes.values()].sort(compareById));
    const edges = Object.freeze([...selectedEdges.values()].sort(compareById));

    const byId = new Map<string, CodeNode>();

    // Rebuilt from the sorted array rather than reusing the selection map, so
    // that this map's iteration order is canonical too and nothing depends on
    // the order the extractors happened to emit in.
    for (const node of nodes) {
      byId.set(node.id, node);
    }

    this.schemaVersion = index.schemaVersion;
    this.projectRoot = index.projectRoot;
    this.indexerVersion = index.indexerVersion;
    this.generatedAt = index.generatedAt;
    this.files = Object.freeze([...index.files].sort(compareByFile));
    this.diagnostics = dedupeDiagnostics(collected);

    this.#nodes = nodes;
    this.#edges = edges;
    this.#byId = byId;
    this.#byKind = groupNodesByKind(nodes);
    this.#byFile = groupBy(nodes, (node) => node.file);
    this.#byName = groupBy(nodes, (node) => node.name);
    this.#outgoing = groupBy(edges, (edge) => edge.from);
    this.#incoming = groupBy(edges, (edge) => edge.to);
    this.#size = Object.freeze({ nodes: nodes.length, edges: edges.length });

    if (index.schemaVersion !== CODE_INDEX_SCHEMA_VERSION) {
      // Reported, never rejected, and deliberately **not** a diagnostic: the
      // closed diagnostic vocabulary in `./types.ts` has no code for a schema
      // mismatch, and borrowing another code's meaning would make the finding
      // unattributable. `../cache.ts` is the module that acts on a version
      // difference, by treating the entry as a miss and rebuilding.
      logger.info('code index declares a different vocabulary version', {
        indexSchemaVersion: index.schemaVersion,
        expectedSchemaVersion: CODE_INDEX_SCHEMA_VERSION,
        indexerVersion: index.indexerVersion,
      });
    }

    logger.debug('code graph constructed', {
      nodes: nodes.length,
      edges: edges.length,
      droppedNodes: index.nodes.length - nodes.length,
      droppedEdges: index.edges.length - edges.length,
      diagnostics: this.diagnostics.length,
    });
  }

  /**
   * Builds a graph from an index.
   *
   * The single construction path, and the only place an index is validated —
   * see the class documentation for the full list of what construction drops
   * and what it guarantees afterwards. It throws for no *content* it is given:
   * a stale vocabulary, a duplicate id, a dangling edge or an unknown kind
   * degrades into a smaller graph plus warnings in
   * {@link CodeGraph.diagnostics}. What it does assume is that the envelope
   * itself holds its declared shape, with the three arrays present; the
   * structural guard that establishes that for a *deserialised* entry belongs
   * to `../cache.ts`, which runs before an entry reaches here.
   *
   * Accepts the arrays in **any order** and normalises them, so an index
   * assembled by hand in a test, or read back from a file written by an earlier
   * version that sorted differently, is as usable as one the current indexer
   * produced.
   *
   * O(n log n) in the number of nodes and edges (the canonical sort dominates);
   * everything the accessors need is computed here so that they never scan.
   *
   * @param index The index to hold. Not mutated.
   * @param options Construction options; see {@link CodeGraphOptions}.
   * @returns The graph.
   */
  static fromIndex(index: CodeIndex, options?: CodeGraphOptions): CodeGraph {
    return new CodeGraph(index, options?.logger ?? noopLogger);
  }

  /**
   * How much this graph holds, after construction's removals.
   *
   * O(1) — pre-computed and frozen at construction.
   */
  get size(): CodeGraphSize {
    return this.#size;
  }

  /**
   * Every node, frozen and sorted ascending by id.
   *
   * O(1): the stored array itself, not a copy. Needed by `./query.ts` for the
   * searches that genuinely have to scan — a substring match over names — and
   * by `../summary.ts` for its counts. A lookup that *can* be answered from an
   * index must use that index instead.
   *
   * @returns The graph's nodes.
   */
  nodes(): readonly CodeNode[] {
    return this.#nodes;
  }

  /**
   * Every edge, frozen and sorted ascending by id.
   *
   * O(1): the stored array itself, not a copy.
   *
   * @returns The graph's edges.
   */
  edges(): readonly CodeEdge[] {
    return this.#edges;
  }

  /**
   * The node with this id.
   *
   * O(1). **The only accessor that may return `undefined`**, because "no node
   * with that id" has no meaningful empty value — every other lookup answers a
   * miss with an empty array.
   *
   * @param id A node id, as produced by {@link makeNodeId}. Never parsed.
   * @returns The node, or `undefined` when this graph holds no node with that
   * id.
   */
  nodeById(id: string): CodeNode | undefined {
    return this.#byId.get(id);
  }

  /**
   * Every node of one kind, frozen and in canonical order.
   *
   * O(1): a pre-built bucket per kind, never a filter over
   * {@link CodeGraph.nodes}. Typed per kind through `CodeNodeOf`, so the
   * returned nodes' `data` is that kind's payload without a cast — which is how
   * `../summary.ts` reads a `db-call` node's driver and how `./query.ts`
   * returns kind-specific results.
   *
   * @typeParam K The kind, or a union of kinds, to select.
   * @param kind The kind to select.
   * @returns The nodes of that kind; empty when the graph holds none.
   */
  nodesByKind<K extends CodeNodeKind>(kind: K): readonly CodeNodeOf<K>[] {
    return this.#byKind[kind];
  }

  /**
   * Every node declared in one file, frozen and in canonical order.
   *
   * O(1). The key is the **project-relative POSIX** path exactly as the nodes
   * store it, and **no normalisation is applied here**: an absolute path, a
   * backslash path or a path with a `./` prefix simply misses. Normalising
   * inside a hot lookup would hide the caller's bug and cost every call; use
   * `@debuggen/shared`'s path helpers (or `LoadedProject.projectRelative`) to
   * produce the key once, at the boundary where the path enters.
   *
   * @param file The project-relative POSIX path.
   * @returns The nodes in that file; empty when the file is not indexed.
   */
  nodesByFile(file: string): readonly CodeNode[] {
    return this.#byFile.get(file) ?? EMPTY_NODES;
  }

  /**
   * Every node whose `name` is exactly this string, frozen and in canonical
   * order.
   *
   * O(1), and case-sensitive: names are stored as the source spells them, so a
   * lookup has to spell them the same way. This is the exact-match index behind
   * `./query.ts`'s name lookups; a fuzzy or substring search is that module's
   * job and scans {@link CodeGraph.nodes} deliberately.
   *
   * A name is not unique — a component and the file that declares it can share
   * one, and two files can declare the same symbol — so the result is a list.
   *
   * @param name The exact name to look up.
   * @returns The nodes with that name; empty when none has it.
   */
  nodesByName(name: string): readonly CodeNode[] {
    return this.#byName.get(name) ?? EMPTY_NODES;
  }

  /**
   * The edges leaving a node, frozen and in canonical (edge id) order.
   *
   * O(1) for the adjacency-list lookup itself. Passing `kind` adds a filter
   * that is O(degree) — linear in this node's own edge count, never in the size
   * of the graph.
   *
   * @param id The node id to look up. A node that does not exist has no edges.
   * @param kind Keep only edges of this kind; omit for every kind.
   * @returns The outgoing edges; empty when there are none.
   */
  outgoing(id: string, kind?: CodeEdgeKind): readonly CodeEdge[] {
    return filterEdgesByKind(this.#outgoing.get(id) ?? EMPTY_EDGES, kind);
  }

  /**
   * The edges arriving at a node, frozen and in canonical (edge id) order.
   *
   * The reverse adjacency list, with the same complexity as
   * {@link CodeGraph.outgoing}. It is what makes a backwards question — who
   * calls this function, which component renders this one — a lookup rather
   * than a scan of every edge in the graph.
   *
   * @param id The node id to look up.
   * @param kind Keep only edges of this kind; omit for every kind.
   * @returns The incoming edges; empty when there are none.
   */
  incoming(id: string, kind?: CodeEdgeKind): readonly CodeEdge[] {
    return filterEdgesByKind(this.#incoming.get(id) ?? EMPTY_EDGES, kind);
  }

  /**
   * The nodes one hop from a node, de-duplicated and frozen.
   *
   * O(degree): the adjacency lookup is constant-time and every edge of this
   * node is then resolved to its far endpoint. Two nodes joined by more than
   * one edge — a component that both renders and calls another — appear once.
   *
   * The result is in **canonical node-id order**, which is what makes the
   * `'both'` direction well defined (the concatenation of two adjacency lists
   * would otherwise have no canonical order of its own) and what makes a
   * breadth-first traversal in `./query.ts` visit the same nodes in the same
   * sequence on every run.
   *
   * An endpoint that resolves to no node is skipped silently. Construction
   * guarantees that cannot happen — a dangling edge is dropped, not kept — and
   * this code still does not assume it, because a container that threw while
   * answering a traversal would turn a corrupt cache entry into a failed
   * investigation.
   *
   * @param id The node id to start from.
   * @param options Which edge kind to follow and which way; see
   * {@link NeighborOptions}. Defaults to every kind, forwards.
   * @returns The neighbouring nodes; empty when there are none.
   */
  neighbors(id: string, options?: NeighborOptions): readonly CodeNode[] {
    const direction: NeighborDirection = options?.direction ?? 'out';
    const kind = options?.kind;
    const collected = new Map<string, CodeNode>();

    if (direction === 'out' || direction === 'both') {
      for (const edge of this.outgoing(id, kind)) {
        const node = this.#byId.get(edge.to);

        if (node !== undefined) {
          collected.set(node.id, node);
        }
      }
    }

    if (direction === 'in' || direction === 'both') {
      for (const edge of this.incoming(id, kind)) {
        const node = this.#byId.get(edge.from);

        if (node !== undefined) {
          collected.set(node.id, node);
        }
      }
    }

    if (collected.size === 0) {
      return EMPTY_NODES;
    }

    return Object.freeze([...collected.values()].sort(compareById));
  }

  /**
   * The serialisable envelope of this graph.
   *
   * What `../indexer.ts` returns and `../cache.ts` writes to
   * `$DEBUGGEN_HOME/index` with `JSON.stringify`. The result is **plain JSON** —
   * no `Map`, `Set`, `Date`, class instance or function anywhere in it — and
   * the optional `diagnostics` field is **omitted entirely** when there are
   * none, so a clean index carries no empty-array noise.
   *
   * ## Round trip
   *
   * For a **well-formed, canonically ordered** index `i` —  unique ids, every
   * edge endpoint present, known kinds, distinct diagnostics, sorted arrays —
   * `CodeGraph.fromIndex(i).toIndex()` deep-equals `i`, and `JSON.stringify` of
   * the two is identical: the envelope metadata, the file fingerprints and the
   * pre-existing diagnostics all survive, and the nodes and edges are the very
   * objects `i` carried.
   *
   * Two documented departures from that:
   *
   * - **Order is normalised.** `fromIndex` accepts the arrays in any order, so
   *   the round trip of a non-canonically-ordered index is the same contents in
   *   canonical order. That is intentional: it is what makes a canonical index
   *   a fixed point of this operation whoever produced it.
   * - **A malformed index is repaired, not reproduced.** Duplicates, dangling
   *   edges and unknown kinds are absent from the result and the diagnostics
   *   describing them are present. This is the one exception to losslessness,
   *   and it is the whole reason the indexer persists this value rather than
   *   the envelope it assembled.
   *
   * O(1): the arrays are the graph's own frozen arrays, not copies.
   *
   * @returns The index this graph represents.
   */
  toIndex(): CodeIndex {
    // Key order matches the declaration order of `CodeIndex`, so that
    // `JSON.stringify` of a round-tripped index is byte-identical to the
    // original rather than merely deep-equal to it.
    const envelope = {
      schemaVersion: this.schemaVersion,
      projectRoot: this.projectRoot,
      indexerVersion: this.indexerVersion,
      generatedAt: this.generatedAt,
      nodes: this.#nodes,
      edges: this.#edges,
      files: this.files,
    };

    if (this.diagnostics.length === 0) {
      return envelope;
    }

    return { ...envelope, diagnostics: this.diagnostics };
  }
}
