/**
 * The code-investigation tools of the local service's pipeline: the closed,
 * named, budgeted and read-only dispatch layer between the code queries a model
 * proposes and the query engine of `@debuggen/code-analysis`.
 *
 * ## What this module enforces
 *
 * - **AAP §0.4.2, Stage 2.** "Model proposes queries, deterministic code
 *   executes them; no repository dump." The model names one of the eight tools
 *   in {@link CODE_TOOL_NAMES} with structured arguments; this module executes
 *   it against the injected {@link CodeQueries} and returns a capped, typed,
 *   JSON-serialisable answer. There is no listing, no directory walk and no
 *   whole-file read to ask for.
 * - **AAP §0.5.3.** The model never applies instrumentation or executes code:
 *   every tool here is a read-only graph query. This module performs no I/O of
 *   its own — no filesystem, no process, no network, no environment, no clock,
 *   no randomness — and source text reaches it only through
 *   {@link CodeQueries.excerpt}, which owns the excerpt window and the
 *   environment-file refusal.
 * - **AAP §0.5.2.** A rejection and a log record describe what was wrong with a
 *   request structurally — which argument, which rule — and never repeat the
 *   value that arrived: no argument text, no URL, no path, no excerpt content.
 * - **AAP §0.5.4.** {@link CodeToolsOptions} has no place for the developer's
 *   question, a follow-up or a target descriptor, so nothing here can branch on
 *   question text; the catalog text {@link describeCodeTools} renders is written
 *   in abstract placeholders and names no application identifier or route.
 *
 * ## The pipeline every request passes through
 *
 * 1. **Parse** — {@link parseCodeToolRequest}, a total, hand-written guard and
 *    normaliser. Unknown or absent tools, missing or mistyped arguments, empty
 *    strings, non-integer or negative numbers, over-long strings and unsafe file
 *    paths become a {@link CodeToolRejection}; integer bounds are clamped into
 *    the effective {@link CodeToolLimits}; unknown extra keys are dropped.
 * 2. **Abort** — a cancelled stage delegates nothing.
 * 3. **Budget** — per stage, per tool, and per stage for excerpts.
 * 4. **Delegate** — exactly one {@link CodeQueries} method, chosen by a total
 *    `switch` whose default branch is `assertNever`.
 * 5. **Shape** — list payloads are capped to `maxResultsPerCall` in the engine's
 *    own order, excerpts to `maxExcerptLines` and `maxExcerptChars`, and the
 *    whole result to `maxSerializedResultBytes`; every cut sets `truncated`.
 * 6. **Account** — the call slot is consumed.
 *
 * ## Consumers
 *
 * `stages/investigate.ts` is the single consumer: it renders
 * {@link describeCodeTools} into the prompt's `toolCatalog`, validates each
 * model-proposed request, runs it here, appends the {@link CodeToolRun} to the
 * query results and reports {@link CodeTools.budget} as the remaining queries.
 * `orchestrator.ts` wires the {@link PipelineCodeHandles} this module receives;
 * this module indexes nothing itself.
 *
 * @module
 */

import {
  CODE_EDGE_KINDS,
  CODE_NODE_KINDS,
  CODE_QUERY_LIMITS,
  HTTP_METHOD_NAMES,
  isCodeEdgeKind,
  isCodeNodeKind,
  isEnvFilePath,
} from '@debuggen/code-analysis';
import type {
  CallerRef,
  CodeEdgeKind,
  CodeExcerpt,
  CodeExcerptTarget,
  CodeMatch,
  CodeNodeKind,
  CodeNodeSelector,
  CodePath,
  CodePathDirection,
  CodePathEndpoint,
  CodeQueries,
  CodeQueryLimits,
  CodeSymbolMatch,
  ComponentRef,
  HandlerRef,
  HttpMethodName,
  RouteQueryResult,
  WhoCallsTarget,
} from '@debuggen/code-analysis';
import { assertNever, err, isSafeRelativePath, noopLogger, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';

import type { PipelineCodeHandles } from '../context-builder.js';

/**
 * The query engine's result shapes, re-exported unchanged so a consumer of this
 * module can name a tool's payload without a second import. They are the
 * upstream declarations themselves, never a redefinition.
 */
export type {
  CallerRef,
  CodeExcerpt,
  CodeMatch,
  CodePath,
  CodeSymbolMatch,
  ComponentRef,
  HandlerRef,
  RouteQueryResult,
} from '@debuggen/code-analysis';

/**
 * The upstream HTTP method vocabulary, re-exported unchanged. The investigate
 * stage reaches the code graph only through this module, and it grounds a flow
 * step written as `<method> <route path>` against this list rather than against
 * a restated one.
 */
export { HTTP_METHOD_NAMES } from '@debuggen/code-analysis';

/* -------------------------------------------------------------------------------------------------
 * Compile-time helpers
 * ---------------------------------------------------------------------------------------------- */

/** Compiles only when `T` is exactly `true`; the repository's type-assertion idiom. */
type AssertTrue<T extends true> = T;

/** `true` when each of `A` and `B` is assignable to the other, without distributing over unions. */
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/* -------------------------------------------------------------------------------------------------
 * Tool vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The eight tools a model may request, in the order the catalog lists them:
 * name lookups first, then relationships, routes, flows and finally the one tool
 * that returns source text. Frozen; the order is part of the catalog contract.
 */
export const CODE_TOOL_NAMES = Object.freeze([
  'findByName',
  'findSymbol',
  'whoCalls',
  'routeForUrl',
  'handlersFor',
  'componentsRendering',
  'pathBetween',
  'excerpt',
] as const);

/** One member of {@link CODE_TOOL_NAMES}. */
export type CodeToolName = (typeof CODE_TOOL_NAMES)[number];

/** Widened view of {@link CODE_TOOL_NAMES} so an arbitrary string can be tested without a cast. */
const CODE_TOOL_NAME_VALUES: readonly string[] = CODE_TOOL_NAMES;

/**
 * Whether a value names a tool in {@link CODE_TOOL_NAMES}: a case-sensitive,
 * exact membership test that is total and never throws.
 *
 * @param value Any value, typically the `tool` key of a model-proposed request.
 * @returns `true` only for a string that is exactly one of the eight names.
 */
export function isCodeToolName(value: unknown): value is CodeToolName {
  return typeof value === 'string' && CODE_TOOL_NAME_VALUES.includes(value);
}

/**
 * The traversal directions `pathBetween` accepts, as a runtime list of the
 * upstream `CodePathDirection` union (which has no runtime tuple of its own);
 * {@link CodeToolsContractChecks} proves the two agree.
 */
const PATH_DIRECTIONS = Object.freeze([
  'out',
  'both',
] as const satisfies readonly CodePathDirection[]);

/* -------------------------------------------------------------------------------------------------
 * Requests
 * ---------------------------------------------------------------------------------------------- */

/**
 * Finds graph nodes by name, best match first. Delegates to
 * {@link CodeQueries.findByName}.
 */
export interface FindByNameRequest {
  readonly tool: 'findByName';
  /** The name to look for. */
  readonly name: string;
  /** Keep only nodes of these kinds, from the upstream `CODE_NODE_KINDS` vocabulary. */
  readonly kinds?: readonly CodeNodeKind[] | undefined;
  /** Require an exact, case-sensitive match. */
  readonly exact?: boolean | undefined;
  /** At most this many matches, clamped to `maxResultsPerCall`. */
  readonly limit?: number | undefined;
}

/**
 * Resolves a `(file, symbol)` pair to the declaration the graph holds for it.
 * Delegates to {@link CodeQueries.findSymbol}.
 */
export interface FindSymbolRequest {
  readonly tool: 'findSymbol';
  /** The declaring file: project-relative, POSIX separators. */
  readonly file: string;
  /** The declared symbol name. */
  readonly symbol: string;
}

/**
 * Lists the call sites of a symbol. Delegates to {@link CodeQueries.whoCalls}
 * with a bare symbol or a `{ file, symbol }` target.
 */
export interface WhoCallsRequest {
  readonly tool: 'whoCalls';
  /** The called symbol name. */
  readonly symbol: string;
  /** The declaring file, to disambiguate a name several modules declare. */
  readonly file?: string | undefined;
  /** At most this many call sites, clamped to `maxResultsPerCall`. */
  readonly limit?: number | undefined;
  /** Also consult the engine's type-checked reference resolver. */
  readonly useReferences?: boolean | undefined;
}

/**
 * Resolves a URL or bare pathname to the route module that answers it.
 * Delegates to {@link CodeQueries.routeForUrl}; matching is the route map's.
 */
export interface RouteForUrlRequest {
  readonly tool: 'routeForUrl';
  /** An absolute URL or a bare pathname. */
  readonly url: string;
}

/**
 * Lists the per-method handlers of the route that answers a URL. Delegates to
 * {@link CodeQueries.handlersFor}.
 */
export interface HandlersForRequest {
  readonly tool: 'handlersFor';
  /** An absolute URL or a bare pathname. */
  readonly url: string;
  /** Keep only this method, from the upstream `HTTP_METHOD_NAMES` vocabulary. */
  readonly method?: HttpMethodName | undefined;
}

/**
 * Lists the components that render a named component — its parents. Delegates
 * to {@link CodeQueries.componentsRendering}.
 */
export interface ComponentsRenderingRequest {
  readonly tool: 'componentsRendering';
  /** The rendered component's name. */
  readonly component: string;
  /** At most this many rendering sites, clamped to `maxResultsPerCall`. */
  readonly limit?: number | undefined;
}

/**
 * Finds the shortest chain of relationships between two nodes. Delegates to
 * {@link CodeQueries.pathBetween}; each endpoint is a `nodeId` from an earlier
 * result or a `CodeNodeSelector`.
 */
export interface PathBetweenRequest {
  readonly tool: 'pathBetween';
  /** The endpoint to start at. */
  readonly from: CodePathEndpoint;
  /** The endpoint to reach. */
  readonly to: CodePathEndpoint;
  /** Follow only these edge kinds, from the upstream `CODE_EDGE_KINDS` vocabulary. */
  readonly edgeKinds?: readonly CodeEdgeKind[] | undefined;
  /** `'out'` (downstream, the default) or `'both'` (undirected). */
  readonly direction?: CodePathDirection | undefined;
  /** At most this many hops, clamped to `maxPathDepth`. */
  readonly maxDepth?: number | undefined;
}

/**
 * Reads a bounded window of source text around a node or a line. Delegates to
 * {@link CodeQueries.excerpt}; exactly one of `nodeId` and `file` is present,
 * and `line`/`endLine` accompany `file` only.
 */
export interface ExcerptRequest {
  readonly tool: 'excerpt';
  /** A `nodeId` from an earlier result. */
  readonly nodeId?: string | undefined;
  /** A project-relative POSIX path. */
  readonly file?: string | undefined;
  /** The 1-based line to centre the window on when `file` is given; the engine is handed `1` when absent. */
  readonly line?: number | undefined;
  /** The 1-based last line of interest, clamped so the window fits `maxExcerptLines`. */
  readonly endLine?: number | undefined;
  /** Lines of context around the anchor, clamped so the window fits `maxExcerptLines`. */
  readonly contextLines?: number | undefined;
}

/** Every request this module executes, discriminated on `tool`. */
export type CodeToolRequest =
  | FindByNameRequest
  | FindSymbolRequest
  | WhoCallsRequest
  | RouteForUrlRequest
  | HandlersForRequest
  | ComponentsRenderingRequest
  | PathBetweenRequest
  | ExcerptRequest;

/** The request shape of one tool. */
export type CodeToolRequestFor<N extends CodeToolName> = Extract<
  CodeToolRequest,
  { readonly tool: N }
>;

/** One tool's arguments: its request without the `tool` discriminant. */
export type CodeToolArguments<N extends CodeToolName> = Omit<CodeToolRequestFor<N>, 'tool'>;

/** The argument names of one tool, as its request interface declares them. */
export type CodeToolArgumentName<N extends CodeToolName> = Exclude<
  keyof CodeToolRequestFor<N>,
  'tool'
> &
  string;

/* -------------------------------------------------------------------------------------------------
 * Results
 * ---------------------------------------------------------------------------------------------- */

/**
 * The fields every tool result carries besides its payload. `request` is the
 * normalised request that produced the result — trimmed, clamped, extra keys
 * dropped — so the model reads back exactly what was executed.
 */
export interface CodeToolResultBase<Q extends CodeToolRequest> {
  /** The tool that ran. */
  readonly tool: Q['tool'];
  /** The normalised request that was executed. */
  readonly request: Q;
  /** Whether the engine answered with at least one match (list) or a value (single). */
  readonly found: boolean;
  /** How many items the engine returned before this module capped them (`0` or `1` for a single value). */
  readonly total: number;
  /** How many items this result carries. */
  readonly returned: number;
  /** Whether any cut was applied: result count, excerpt lines or characters, or serialized size. */
  readonly truncated: boolean;
  /** The argument names the normaliser lowered or raised into range, in reading order. */
  readonly clamped: readonly string[];
}

/** A result whose payload is a list, in the query engine's own deterministic order. */
export interface CodeToolListResult<Q extends CodeToolRequest, T> extends CodeToolResultBase<Q> {
  /** The items, capped; never absent, possibly empty. */
  readonly payload: readonly T[];
}

/**
 * A result whose payload is one value. `payload` is omitted when the engine found
 * nothing (`found: false`) and when the value exceeds `maxSerializedResultBytes`
 * (`found: true`, `returned: 0`, `truncated: true`).
 */
export interface CodeToolItemResult<Q extends CodeToolRequest, T> extends CodeToolResultBase<Q> {
  /** The engine's value, passed through unchanged (an excerpt may be cut to its caps). */
  readonly payload?: T;
}

/** The result of `findByName`: ranked `CodeMatch` entries. */
export type FindByNameResult = CodeToolListResult<FindByNameRequest, CodeMatch>;
/** The result of `findSymbol`: the declaration, when the file declares the symbol. */
export type FindSymbolResult = CodeToolItemResult<FindSymbolRequest, CodeSymbolMatch>;
/** The result of `whoCalls`: ordered call sites. */
export type WhoCallsResult = CodeToolListResult<WhoCallsRequest, CallerRef>;
/** The result of `routeForUrl`: the route module, with its `route-map` location preserved. */
export type RouteForUrlResult = CodeToolItemResult<RouteForUrlRequest, RouteQueryResult>;
/** The result of `handlersFor`: one handler per method. */
export type HandlersForResult = CodeToolListResult<HandlersForRequest, HandlerRef>;
/** The result of `componentsRendering`: the rendering parents and their element sites. */
export type ComponentsRenderingResult = CodeToolListResult<
  ComponentsRenderingRequest,
  ComponentRef
>;
/** The result of `pathBetween`: the shortest path, when one exists within the bounds. */
export type PathBetweenResult = CodeToolItemResult<PathBetweenRequest, CodePath>;
/** The result of `excerpt`: the bounded source window, when it can be read. */
export type ExcerptResult = CodeToolItemResult<ExcerptRequest, CodeExcerpt>;

/** Every tool result, discriminated on `tool`. */
export type CodeToolResult =
  | FindByNameResult
  | FindSymbolResult
  | WhoCallsResult
  | RouteForUrlResult
  | HandlersForResult
  | ComponentsRenderingResult
  | PathBetweenResult
  | ExcerptResult;

/** The result shape of one tool. */
export type CodeToolResultFor<N extends CodeToolName> = Extract<
  CodeToolResult,
  { readonly tool: N }
>;

/* -------------------------------------------------------------------------------------------------
 * Rejections
 * ---------------------------------------------------------------------------------------------- */

/**
 * The failure classes of this module and the existing {@link DebuggenErrorCode}
 * each is reported with. No code is invented here; the `satisfies` clause makes
 * a code outside `DEBUGGEN_ERROR_CODES` a compile error.
 *
 * | Class                | Code                   | When                                                     |
 * | -------------------- | ---------------------- | -------------------------------------------------------- |
 * | `malformed`          | `MODEL_OUTPUT_INVALID` | not an object, unknown/absent tool, bad argument         |
 * | `budget`             | `RATE_LIMITED`         | stage, per-tool or excerpt budget spent                  |
 * | `path`               | `PATH_OUTSIDE_PROJECT` | a file argument is not a readable project-relative path |
 * | `excerptUnavailable` | `CODE_INDEX_FAILED`    | no loaded project, so source text cannot be excerpted    |
 * | `aborted`            | `SESSION_INVALID_STATE`| the stage was cancelled through its `AbortSignal`        |
 * | `internal`           | `INTERNAL`             | the query engine failed unexpectedly                     |
 */
export const CODE_TOOL_REJECTION_CODES = Object.freeze({
  malformed: 'MODEL_OUTPUT_INVALID',
  budget: 'RATE_LIMITED',
  path: 'PATH_OUTSIDE_PROJECT',
  excerptUnavailable: 'CODE_INDEX_FAILED',
  aborted: 'SESSION_INVALID_STATE',
  internal: 'INTERNAL',
} as const satisfies Readonly<Record<string, DebuggenErrorCode>>);

/** One failure class of {@link CODE_TOOL_REJECTION_CODES}. */
export type CodeToolRejectionClass = keyof typeof CODE_TOOL_REJECTION_CODES;

/**
 * A refused request, as plain JSON data. The field names match
 * `DebuggenError.toPayload()` (`code`, `message`, `hint`) so the existing
 * surfaces can show it unchanged. `message` and `hint` are structural and
 * instructive and never contain a value from the request.
 */
export interface CodeToolRejection {
  /** The tool the request named, when it named a known one. */
  readonly tool?: CodeToolName;
  /** The failure code, from {@link CODE_TOOL_REJECTION_CODES}. */
  readonly code: DebuggenErrorCode;
  /** What was wrong, stated structurally. */
  readonly message: string;
  /** What to do instead. */
  readonly hint?: string;
  /** The budget at the moment of a budget refusal. */
  readonly budget?: CodeToolBudgetSnapshot;
}

/** The outcome of one tool call. */
export type CodeToolOutcome = Result<CodeToolResult, CodeToolRejection>;

/** One entry of a {@link CodeTools.runCodeTools} batch, in input order. */
export interface CodeToolRun {
  /** The position of the request in the batch. */
  readonly index: number;
  /** The normalised request; omitted when the input could not be parsed. */
  readonly request?: CodeToolRequest | undefined;
  /** The result or the rejection. */
  readonly outcome: CodeToolOutcome;
}

/* -------------------------------------------------------------------------------------------------
 * Limits and budget
 * ---------------------------------------------------------------------------------------------- */

/**
 * The stage budget of the code tools, layered on top of the query engine's own
 * `CODE_QUERY_LIMITS`: every key that has an engine counterpart can only be
 * tightened relative to it (see {@link resolveCodeToolLimits}).
 */
export interface CodeToolLimits {
  /** Delegated calls per stage run, across all tools. */
  readonly maxCallsPerStage: number;
  /** Delegated calls per tool per stage run. */
  readonly maxCallsPerTool: number;
  /** Items in one list result; bounded by `CODE_QUERY_LIMITS.maxResults` and `.maxCallers`. */
  readonly maxResultsPerCall: number;
  /** Delegated `excerpt` calls per stage run. */
  readonly maxExcerptsPerStage: number;
  /** Lines in one excerpt; bounded by `CODE_QUERY_LIMITS.maxExcerptLines`. */
  readonly maxExcerptLines: number;
  /** Characters in one excerpt; bounded by `CODE_QUERY_LIMITS.maxExcerptChars`. */
  readonly maxExcerptChars: number;
  /** Hops in one path; bounded by `CODE_QUERY_LIMITS.maxPathDepth`. */
  readonly maxPathDepth: number;
  /** Characters in a name, symbol or file argument; bounded by `CODE_QUERY_LIMITS.maxNameLength`. */
  readonly maxArgumentLength: number;
  /** Characters in a URL argument; bounded by `CODE_QUERY_LIMITS.maxUrlLength`. */
  readonly maxUrlLength: number;
  /** Characters in a `nodeId` argument (node ids embed a path, so they outgrow names). */
  readonly maxNodeIdLength: number;
  /** UTF-8 bytes of one serialized result (compact `JSON.stringify`). */
  readonly maxSerializedResultBytes: number;
}

/**
 * The default stage budget, sized for a prompt: a dozen queries, a handful per
 * tool and four excerpts per investigation, twenty results per list, excerpts
 * of thirty lines and three thousand characters, six-hop paths and results of
 * at most sixteen kilobytes. Frozen: it is read on every call.
 */
export const CODE_TOOL_LIMITS: CodeToolLimits = Object.freeze({
  maxCallsPerStage: 12,
  maxCallsPerTool: 6,
  maxResultsPerCall: 20,
  maxExcerptsPerStage: 4,
  maxExcerptLines: 30,
  maxExcerptChars: 3_000,
  maxPathDepth: 6,
  maxArgumentLength: 160,
  maxUrlLength: 1_024,
  maxNodeIdLength: 512,
  maxSerializedResultBytes: 16_000,
});

/**
 * Which query-engine ceilings bound which stage key. A stage key is clamped to
 * the minimum of its own default and every engine key listed for it, so this
 * layer can never ask the engine for more than it permits:
 *
 * - `maxResultsPerCall` ← `maxResults` and `maxCallers` (lists and call sites)
 * - `maxExcerptLines` ← `maxExcerptLines`; `maxExcerptChars` ← `maxExcerptChars`
 * - `maxPathDepth` ← `maxPathDepth`
 * - `maxArgumentLength` ← `maxNameLength`; `maxUrlLength` ← `maxUrlLength`
 * - the call, excerpt-count, node-id and byte budgets are stage-only.
 */
const QUERY_CEILINGS: Readonly<Record<keyof CodeToolLimits, readonly (keyof CodeQueryLimits)[]>> =
  Object.freeze({
    maxCallsPerStage: Object.freeze([]),
    maxCallsPerTool: Object.freeze([]),
    maxResultsPerCall: Object.freeze(['maxResults', 'maxCallers'] as const),
    maxExcerptsPerStage: Object.freeze([]),
    maxExcerptLines: Object.freeze(['maxExcerptLines'] as const),
    maxExcerptChars: Object.freeze(['maxExcerptChars'] as const),
    maxPathDepth: Object.freeze(['maxPathDepth'] as const),
    maxArgumentLength: Object.freeze(['maxNameLength'] as const),
    maxUrlLength: Object.freeze(['maxUrlLength'] as const),
    maxNodeIdLength: Object.freeze([]),
    maxSerializedResultBytes: Object.freeze([]),
  });

/**
 * Resolves a partial override into a complete, frozen stage budget.
 *
 * Every key is clamped to `[1, min(CODE_TOOL_LIMITS[key], engine ceiling)]`,
 * where the engine ceiling is `CODE_QUERY_LIMITS` (and, when given, the lower
 * limits a particular `CodeQueries` instance reports). An absent or non-numeric
 * override takes the ceiling; `0`, a negative value and `NaN` become `1`; a
 * fraction is floored; unknown keys are ignored and the input is never mutated.
 *
 * @param overrides The keys to tighten.
 * @param engineLimits The limits of the engine the tools will delegate to;
 * defaults to `CODE_QUERY_LIMITS` and can only lower the result further.
 * @returns The effective limits, frozen.
 */
export function resolveCodeToolLimits(
  overrides?: Partial<CodeToolLimits>,
  engineLimits: CodeQueryLimits = CODE_QUERY_LIMITS,
): CodeToolLimits {
  const resolve = (key: keyof CodeToolLimits): number => {
    let ceiling = CODE_TOOL_LIMITS[key];
    for (const engineKey of QUERY_CEILINGS[key]) {
      ceiling = Math.min(
        ceiling,
        CODE_QUERY_LIMITS[engineKey],
        positiveOr(readOwnData(engineLimits, engineKey), CODE_QUERY_LIMITS[engineKey]),
      );
    }
    return clampLimit(readOwnData(overrides, key), ceiling);
  };

  return Object.freeze({
    maxCallsPerStage: resolve('maxCallsPerStage'),
    maxCallsPerTool: resolve('maxCallsPerTool'),
    maxResultsPerCall: resolve('maxResultsPerCall'),
    maxExcerptsPerStage: resolve('maxExcerptsPerStage'),
    maxExcerptLines: resolve('maxExcerptLines'),
    maxExcerptChars: resolve('maxExcerptChars'),
    maxPathDepth: resolve('maxPathDepth'),
    maxArgumentLength: resolve('maxArgumentLength'),
    maxUrlLength: resolve('maxUrlLength'),
    maxNodeIdLength: resolve('maxNodeIdLength'),
    maxSerializedResultBytes: resolve('maxSerializedResultBytes'),
  });
}

/**
 * One override clamped into `[1, ceiling]`.
 *
 * @param value The override as read, of unknown type.
 * @param ceiling The highest value permitted.
 * @returns The clamped integer.
 */
function clampLimit(value: unknown, ceiling: number): number {
  if (typeof value !== 'number') {
    return ceiling;
  }
  if (Number.isNaN(value)) {
    return 1;
  }
  const floored = Math.floor(value);
  if (floored < 1) {
    return 1;
  }
  return floored > ceiling ? ceiling : floored;
}

/**
 * A finite, positive number, or a fallback.
 *
 * @param value The candidate, of unknown type.
 * @param fallback The value to use instead.
 * @returns `value` when it is a finite number of at least `1`, otherwise `fallback`.
 */
function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : fallback;
}

/**
 * The live budget of one {@link CodeTools} instance, as a fresh frozen snapshot.
 * Counters are independent: a call can run only while `callsRemaining`, its
 * tool's `perTool` allowance and — for `excerpt` — `excerptsRemaining` all allow
 * it.
 */
export interface CodeToolBudgetSnapshot {
  /** The effective limits. */
  readonly limits: CodeToolLimits;
  /** Delegated calls so far. */
  readonly callsUsed: number;
  /** `maxCallsPerStage - callsUsed`, never negative. */
  readonly callsRemaining: number;
  /** Requests answered with a rejection before delegation; these consume no slot. */
  readonly callsRejected: number;
  /** Delegated `excerpt` calls so far. */
  readonly excerptsUsed: number;
  /** `maxExcerptsPerStage - excerptsUsed`, never negative. */
  readonly excerptsRemaining: number;
  /** Delegated calls so far, per tool. */
  readonly perTool: Readonly<Record<CodeToolName, number>>;
}

/* -------------------------------------------------------------------------------------------------
 * Descriptors and the catalog text
 * ---------------------------------------------------------------------------------------------- */

/** The type words the catalog uses for arguments. */
export type CodeToolArgumentType = 'string' | 'integer' | 'boolean' | 'string[]' | 'endpoint';

/** The name of a {@link CodeQueries} method (every member except `limits`). */
export type CodeQueryMethodName = Exclude<keyof CodeQueries, 'limits'>;

/** One argument of one tool, as the catalog describes it. */
export interface CodeToolArgumentDescriptor {
  /** The argument's key in the request. */
  readonly name: string;
  /** Its JSON type, as a catalog word. */
  readonly type: CodeToolArgumentType;
  /** Whether a request must carry it. */
  readonly required: boolean;
  /** One line on what it means. */
  readonly description: string;
  /** The closed set of accepted values, when there is one. */
  readonly allowed?: readonly string[];
}

/** An argument descriptor whose name is checked against the tool's request interface. */
export interface CodeToolArgumentDescriptorFor<
  N extends CodeToolName,
> extends CodeToolArgumentDescriptor {
  readonly name: CodeToolArgumentName<N>;
}

/** The catalog entry of one tool. */
export interface CodeToolDescriptorFor<N extends CodeToolName> {
  /** The tool name. */
  readonly name: N;
  /** One sentence on what the tool answers. */
  readonly purpose: string;
  /** The {@link CodeQueries} method the tool delegates to. */
  readonly delegatesTo: CodeQueryMethodName;
  /** The arguments, in catalog order. */
  readonly args: readonly CodeToolArgumentDescriptorFor<N>[];
  /** One line on what the result carries. */
  readonly returns: string;
  /** The limits that apply to this tool besides the call budget and the result size. */
  readonly budgetKeys: readonly (keyof CodeToolLimits)[];
}

/** The catalog entry of any tool. */
export type CodeToolDescriptor = {
  readonly [N in CodeToolName]: CodeToolDescriptorFor<N>;
}[CodeToolName];

/**
 * Deep-freezes one descriptor.
 *
 * @param descriptor The descriptor as written.
 * @returns A frozen copy with frozen argument entries and key lists.
 */
function freezeDescriptor<N extends CodeToolName>(
  descriptor: CodeToolDescriptorFor<N>,
): CodeToolDescriptorFor<N> {
  const args = descriptor.args.map((arg): CodeToolArgumentDescriptorFor<N> =>
    Object.freeze({
      ...arg,
      ...(arg.allowed !== undefined ? { allowed: Object.freeze([...arg.allowed]) } : {}),
    }),
  );
  return Object.freeze({
    ...descriptor,
    args: Object.freeze(args),
    budgetKeys: Object.freeze([...descriptor.budgetKeys]),
  });
}

/**
 * The catalog entry of every tool, keyed by name. The mapped type makes a tool
 * name without a descriptor, or a descriptor argument that is not a key of the
 * tool's request interface, a compile error. Deep-frozen.
 */
export const CODE_TOOL_DESCRIPTORS: { readonly [N in CodeToolName]: CodeToolDescriptorFor<N> } =
  Object.freeze({
    findByName: freezeDescriptor({
      name: 'findByName',
      purpose: 'Find graph nodes whose name matches a name, best match first.',
      delegatesTo: 'findByName',
      args: [
        { name: 'name', type: 'string', required: true, description: 'The name to look for.' },
        {
          name: 'kinds',
          type: 'string[]',
          required: false,
          description: 'Keep only nodes of these kinds.',
          allowed: CODE_NODE_KINDS,
        },
        {
          name: 'exact',
          type: 'boolean',
          required: false,
          description: 'Require an exact, case-sensitive match.',
        },
        {
          name: 'limit',
          type: 'integer',
          required: false,
          description: 'Return at most this many matches.',
        },
      ],
      returns: 'A ranked list of matches, each with nodeId, kind, name, file, location and score.',
      budgetKeys: ['maxResultsPerCall', 'maxArgumentLength'],
    }),
    findSymbol: freezeDescriptor({
      name: 'findSymbol',
      purpose: 'Check whether a file declares a named symbol, and return that declaration.',
      delegatesTo: 'findSymbol',
      args: [
        {
          name: 'file',
          type: 'string',
          required: true,
          description: 'The declaring file, for example <project-relative/file/path.ts>.',
        },
        { name: 'symbol', type: 'string', required: true, description: 'The declared name.' },
      ],
      returns:
        'found, and when true the declaration with its nodeId, kind, location and whether it is exported.',
      budgetKeys: ['maxArgumentLength'],
    }),
    whoCalls: freezeDescriptor({
      name: 'whoCalls',
      purpose: 'List the places a symbol is called from, ordered by file and position.',
      delegatesTo: 'whoCalls',
      args: [
        { name: 'symbol', type: 'string', required: true, description: 'The called name.' },
        {
          name: 'file',
          type: 'string',
          required: false,
          description: 'The declaring file, to tell apart two declarations of one name.',
        },
        {
          name: 'limit',
          type: 'integer',
          required: false,
          description: 'Return at most this many call sites.',
        },
        {
          name: 'useReferences',
          type: 'boolean',
          required: false,
          description: 'Also run the slower type-checked reference search.',
        },
      ],
      returns:
        'A list of call sites, each with the calling node, how it was found and its location.',
      budgetKeys: ['maxResultsPerCall', 'maxArgumentLength'],
    }),
    routeForUrl: freezeDescriptor({
      name: 'routeForUrl',
      purpose: 'Resolve a request URL or pathname to the route module that answers it.',
      delegatesTo: 'routeForUrl',
      args: [
        {
          name: 'url',
          type: 'string',
          required: true,
          description: 'An absolute URL or a bare pathname such as <pathname>.',
        },
      ],
      returns:
        'found, and when true the route path, router, methods, parameters, file and location.',
      budgetKeys: ['maxUrlLength'],
    }),
    handlersFor: freezeDescriptor({
      name: 'handlersFor',
      purpose: 'List the handler of each HTTP method of the route that answers a URL.',
      delegatesTo: 'handlersFor',
      args: [
        {
          name: 'url',
          type: 'string',
          required: true,
          description: 'An absolute URL or a bare pathname.',
        },
        {
          name: 'method',
          type: 'string',
          required: false,
          description: 'Keep only this method.',
          allowed: HTTP_METHOD_NAMES,
        },
      ],
      returns: 'A list of handlers, each with its method, symbol and location.',
      budgetKeys: ['maxResultsPerCall', 'maxUrlLength'],
    }),
    componentsRendering: freezeDescriptor({
      name: 'componentsRendering',
      purpose: 'List the components whose markup renders a named component: its parents.',
      delegatesTo: 'componentsRendering',
      args: [
        {
          name: 'component',
          type: 'string',
          required: true,
          description: 'The rendered component name.',
        },
        {
          name: 'limit',
          type: 'integer',
          required: false,
          description: 'Return at most this many rendering sites.',
        },
      ],
      returns: 'A list of parents, each with its node and the location of the rendered element.',
      budgetKeys: ['maxResultsPerCall', 'maxArgumentLength'],
    }),
    pathBetween: freezeDescriptor({
      name: 'pathBetween',
      purpose: 'Find the shortest chain of code relationships from one node to another.',
      delegatesTo: 'pathBetween',
      args: [
        {
          name: 'from',
          type: 'endpoint',
          required: true,
          description:
            'A nodeId string from an earlier result, or a selector object with any of file, symbol, name and kind.',
        },
        {
          name: 'to',
          type: 'endpoint',
          required: true,
          description: 'The endpoint to reach, in the same form.',
        },
        {
          name: 'edgeKinds',
          type: 'string[]',
          required: false,
          description: 'Follow only these relationship kinds.',
          allowed: CODE_EDGE_KINDS,
        },
        {
          name: 'direction',
          type: 'string',
          required: false,
          description: 'out follows relationships downstream; both also follows them backwards.',
          allowed: PATH_DIRECTIONS,
        },
        {
          name: 'maxDepth',
          type: 'integer',
          required: false,
          description: 'Allow at most this many hops.',
        },
      ],
      returns: 'found, and when true the nodes, the edges between them and the depth of the path.',
      budgetKeys: ['maxPathDepth', 'maxArgumentLength', 'maxNodeIdLength'],
    }),
    excerpt: freezeDescriptor({
      name: 'excerpt',
      purpose: 'Read a bounded window of source text around a node or a line.',
      delegatesTo: 'excerpt',
      args: [
        {
          name: 'nodeId',
          type: 'string',
          required: false,
          description: 'A nodeId from an earlier result; give either this or file.',
        },
        {
          name: 'file',
          type: 'string',
          required: false,
          description: 'A project-relative path; give either this or nodeId.',
        },
        {
          name: 'line',
          type: 'integer',
          required: false,
          description: 'With file: the 1-based line to centre on, 1 when omitted.',
        },
        {
          name: 'endLine',
          type: 'integer',
          required: false,
          description: 'With file: the 1-based last line of interest.',
        },
        {
          name: 'contextLines',
          type: 'integer',
          required: false,
          description: 'Lines of context around the anchor.',
        },
      ],
      returns: 'found, and when true the file, the start and end line, the text and truncated.',
      budgetKeys: [
        'maxExcerptsPerStage',
        'maxExcerptLines',
        'maxExcerptChars',
        'maxArgumentLength',
        'maxNodeIdLength',
      ],
    }),
  });

/** How the catalog states each limit, given its effective value. */
const BUDGET_PHRASES: Readonly<Record<keyof CodeToolLimits, (value: number) => string>> =
  Object.freeze({
    maxCallsPerStage: (value) => `${String(value)} calls per stage`,
    maxCallsPerTool: (value) => `${String(value)} calls of one tool`,
    maxResultsPerCall: (value) => `${String(value)} results per call`,
    maxExcerptsPerStage: (value) => `${String(value)} excerpts per stage`,
    maxExcerptLines: (value) => `${String(value)} lines per excerpt`,
    maxExcerptChars: (value) => `${String(value)} characters per excerpt`,
    maxPathDepth: (value) => `${String(value)} hops per path`,
    maxArgumentLength: (value) => `${String(value)} characters per name or file argument`,
    maxUrlLength: (value) => `${String(value)} characters per URL argument`,
    maxNodeIdLength: (value) => `${String(value)} characters per node id`,
    maxSerializedResultBytes: (value) => `${String(value)} bytes per serialized result`,
  });

/**
 * The argument-length limits, stated once in the catalog's rules rather than
 * under every tool they apply to; the descriptors still list them per tool.
 */
const ARGUMENT_LENGTH_KEYS: readonly (keyof CodeToolLimits)[] = Object.freeze([
  'maxArgumentLength',
  'maxUrlLength',
  'maxNodeIdLength',
]);

/** Options of {@link describeCodeTools}. */
export interface DescribeCodeToolsOptions {
  /** The limits to state; resolved with {@link resolveCodeToolLimits}, defaults when absent. */
  readonly limits?: CodeToolLimits | undefined;
}

/**
 * Renders the tool catalog the investigate prompt receives as its
 * `toolCatalog`: the rules the model must respect, then every tool of
 * {@link CODE_TOOL_DESCRIPTORS} with its arguments, result and caps.
 *
 * Generated from the descriptors and the effective limits, so the text can
 * never drift from the implemented tools or their real bounds. Byte-stable:
 * no clock, no environment, no locale formatting, `\n` line endings. Written
 * in abstract placeholders only; it names no application identifier and no
 * route.
 *
 * @param options The limits to state.
 * @returns The catalog text.
 */
export function describeCodeTools(options?: DescribeCodeToolsOptions): string {
  const limits = resolveCodeToolLimits(options?.limits);
  const phrase = (key: keyof CodeToolLimits): string => BUDGET_PHRASES[key](limits[key]);

  const lines: string[] = [
    'Read-only code queries over the code graph of the project, executed by deterministic code between turns. Nothing is modified and no code is run.',
    '',
    'Rules:',
    '- Send each query as one JSON object whose "tool" key names a tool below; its other keys are the arguments.',
    '- Only these tools exist. An unknown tool, a missing or mistyped argument, an empty string, or a negative or fractional number is refused. Keys a tool does not list are ignored.',
    '- An integer above its cap is lowered to the cap, and the result names it under clamped.',
    '- There is no repository listing, no directory walk and no whole-file read. Source text is only available as a bounded excerpt.',
    '- Every result reports found, total, returned and truncated. When truncated is true the answer was cut to fit the caps: ask a narrower query.',
    '- A refused query comes back as a rejection with a code, a message and a hint, and uses none of the budget.',
    `- The budget is finite: ${phrase('maxCallsPerStage')}, ${phrase('maxCallsPerTool')} and ${phrase('maxExcerptsPerStage')}; ${phrase('maxSerializedResultBytes')}. The remaining queries are reported every turn.`,
    `- String arguments are capped at ${ARGUMENT_LENGTH_KEYS.map(phrase).join(', ')}.`,
    '- A nodeId from any result can be passed back as the nodeId of excerpt or as an endpoint of pathBetween.',
    '',
    'Tools:',
  ];

  for (const name of CODE_TOOL_NAMES) {
    const descriptor: CodeToolDescriptor = CODE_TOOL_DESCRIPTORS[name];
    lines.push('', `${descriptor.name}: ${descriptor.purpose}`);
    for (const arg of descriptor.args) {
      const presence = arg.required ? 'required' : 'optional';
      const allowed = arg.allowed !== undefined ? ` One of: ${arg.allowed.join(', ')}.` : '';
      lines.push(`  ${arg.name} (${arg.type}, ${presence}): ${arg.description}${allowed}`);
    }
    lines.push(`  Returns: ${descriptor.returns}`);
    const caps = descriptor.budgetKeys.filter((key) => !ARGUMENT_LENGTH_KEYS.includes(key));
    if (caps.length > 0) {
      lines.push(`  Caps: ${caps.map(phrase).join('; ')}.`);
    }
  }

  return lines.join('\n');
}

/**
 * The argument list of one tool, for a rejection hint.
 *
 * @param tool The tool.
 * @returns For example `findSymbol takes: file (string, required), symbol (string, required).`
 */
function argumentHint(tool: CodeToolName): string {
  const descriptor: CodeToolDescriptor = CODE_TOOL_DESCRIPTORS[tool];
  const args = descriptor.args.map(
    (arg) => `${arg.name} (${arg.type}, ${arg.required ? 'required' : 'optional'})`,
  );
  return `${tool} takes: ${args.join(', ')}.`;
}

/* -------------------------------------------------------------------------------------------------
 * Reading untrusted values
 * ---------------------------------------------------------------------------------------------- */

/** A plain object whose members are read as `unknown`: the only request shape this module reads. */
type UnknownRecord = Readonly<Record<string, unknown>>;

/** The shared empty list a malformed engine answer is replaced with. */
const EMPTY_LIST: readonly never[] = Object.freeze([]);

/** The longest list argument accepted; every vocabulary a list draws from is far shorter. */
const MAX_LIST_ARGUMENT_ITEMS = 32;

/** The highest line number an excerpt request may name; a larger value is clamped to it. */
const MAX_LINE_NUMBER = 10_000_000;

/**
 * The context lines this layer asks for when a request names none: the engine's
 * documented default of three, lowered when `maxExcerptLines` is too small to
 * hold it on both sides of the anchor.
 */
const DEFAULT_EXCERPT_CONTEXT_LINES = 3;

/**
 * Whether a value is a plain object: not `null`, not an array, not a function
 * and not a class instance. JSON-decoded model output always passes.
 *
 * @param value Any value.
 * @returns `true` for an object whose prototype is `Object.prototype` or `null`.
 */
function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reads one **own data** property without invoking a getter and without
 * consulting the prototype chain, so neither an accessor nor a polluted
 * prototype can inject a value.
 *
 * @param container Any value.
 * @param key The property name, always from this module's own vocabulary.
 * @returns The property's value, or `undefined`.
 */
function readOwnData(container: unknown, key: string): unknown {
  if ((typeof container !== 'object' && typeof container !== 'function') || container === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    return undefined;
  }
  const value: unknown = descriptor.value;
  return value;
}

/**
 * Whether a value is an array, as a plain boolean so a typed list keeps its type.
 *
 * @param value Any value.
 * @returns `Array.isArray(value)`.
 */
function isListValue(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * An engine list answer, or the empty list when the engine answered with
 * something that is not a list.
 *
 * @param value The engine's answer.
 * @returns A list safe to slice.
 */
function asList<T>(value: readonly T[]): readonly T[] {
  return isListValue(value) ? value : EMPTY_LIST;
}

/* -------------------------------------------------------------------------------------------------
 * Rejection construction
 * ---------------------------------------------------------------------------------------------- */

/** Optional fields of {@link rejection}. */
interface RejectionOptions {
  readonly tool?: CodeToolName | undefined;
  readonly hint?: string | undefined;
  readonly budget?: CodeToolBudgetSnapshot | undefined;
}

/**
 * Builds a frozen rejection with its keys in a fixed order and its optional
 * keys omitted rather than `undefined`.
 *
 * @param kind The failure class.
 * @param message The structural statement of what was wrong.
 * @param options The tool, hint and budget, each optional.
 * @returns The rejection.
 */
function rejection(
  kind: CodeToolRejectionClass,
  message: string,
  options: RejectionOptions = {},
): CodeToolRejection {
  const built: CodeToolRejection = {
    ...(options.tool !== undefined ? { tool: options.tool } : {}),
    code: CODE_TOOL_REJECTION_CODES[kind],
    message,
    ...(options.hint !== undefined ? { hint: options.hint } : {}),
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
  };
  return Object.freeze(built);
}

/** The hint for a request that is not a readable object at all. */
const REQUEST_SHAPE_HINT =
  'Send one JSON object whose "tool" key names a catalog tool and whose other keys are its arguments.';

/** The hint for a request whose file argument was refused. */
const PATH_HINT =
  'Use a project-relative POSIX path taken from an earlier result. Absolute paths, parent-directory segments, backslashes, control characters and environment files are refused.';

/**
 * The hint for a request naming no tool or an unknown one.
 *
 * @returns The list of tool names.
 */
function toolListHint(): string {
  return `Use one of: ${CODE_TOOL_NAMES.join(', ')}.`;
}

/* -------------------------------------------------------------------------------------------------
 * Parsing
 * ---------------------------------------------------------------------------------------------- */

/** The mutable state of parsing one request: the first failure wins. */
interface ParseState {
  readonly tool: CodeToolName;
  readonly record: UnknownRecord;
  readonly limits: CodeToolLimits;
  readonly clamped: string[];
  failure: CodeToolRejection | undefined;
}

/** Where one argument is read from, and the name it is reported under. */
interface FieldAt {
  readonly source: UnknownRecord;
  readonly key: string;
  readonly label: string;
}

/** How a string argument is bounded and normalised. */
type TextRole = 'name' | 'file' | 'url' | 'nodeId';

/** A parsed request and the arguments its normalisation clamped. */
interface ParsedRequest {
  readonly request: CodeToolRequest;
  readonly clamped: readonly string[];
}

/**
 * A top-level argument of the request being parsed.
 *
 * @param state The parse state.
 * @param key The argument key.
 * @returns Its location.
 */
function field(state: ParseState, key: string): FieldAt {
  return { source: state.record, key, label: key };
}

/**
 * Reads an argument; JSON `null` is treated as absent, which is how models
 * commonly spell an omitted optional argument.
 *
 * @param at Where to read.
 * @returns The value, or `undefined` when absent.
 */
function readRaw(at: FieldAt): unknown {
  const value = readOwnData(at.source, at.key);
  return value === null ? undefined : value;
}

/**
 * Records the first failure of a parse.
 *
 * @param state The parse state.
 * @param message What was wrong, naming the argument and never its value.
 * @param kind The failure class.
 * @param hint What to do instead; defaults to the tool's argument list.
 * @returns `undefined`, so a reader can `return` it.
 */
function refuseArgument(
  state: ParseState,
  message: string,
  kind: 'malformed' | 'path' = 'malformed',
  hint?: string,
): undefined {
  state.failure ??= rejection(kind, message, {
    tool: state.tool,
    hint: hint ?? argumentHint(state.tool),
  });
  return undefined;
}

/**
 * The length bound of a string argument.
 *
 * @param role The argument's role.
 * @param limits The effective limits.
 * @returns The maximum length in characters.
 */
function maxTextLength(role: TextRole, limits: CodeToolLimits): number {
  switch (role) {
    case 'name':
    case 'file':
      return limits.maxArgumentLength;
    case 'url':
      return limits.maxUrlLength;
    case 'nodeId':
      return limits.maxNodeIdLength;
    default:
      return assertNever(role, 'Unhandled code-tool text role');
  }
}

/**
 * Reads a string argument. Names and URLs are trimmed; node ids and file paths
 * are opaque and kept byte for byte. A file argument must be a safe
 * project-relative path (`isSafeRelativePath`) that is not an environment file
 * (`isEnvFilePath`, the engine's own predicate): the cheap pre-check that keeps
 * a hostile path away from the engine, which applies both guards again itself.
 *
 * @param state The parse state.
 * @param at Where to read.
 * @param role How the string is bounded and normalised.
 * @param required Whether absence is a failure.
 * @returns The string, or `undefined` when absent or refused.
 */
function readText(
  state: ParseState,
  at: FieldAt,
  role: TextRole,
  required: boolean,
): string | undefined {
  const raw = readRaw(at);
  if (raw === undefined) {
    return required
      ? refuseArgument(state, `${state.tool} requires the argument "${at.label}".`)
      : undefined;
  }
  if (typeof raw !== 'string') {
    return refuseArgument(state, `The argument "${at.label}" must be a string.`);
  }

  const text = role === 'name' || role === 'url' ? raw.trim() : raw;
  if (text.trim().length === 0) {
    return refuseArgument(
      state,
      `The argument "${at.label}" must not be empty or only whitespace.`,
    );
  }

  const max = maxTextLength(role, state.limits);
  if (text.length > max) {
    return refuseArgument(
      state,
      `The argument "${at.label}" is longer than ${String(max)} characters.`,
    );
  }

  if (role === 'file' && (!isSafeRelativePath(text) || isEnvFilePath(text))) {
    return refuseArgument(
      state,
      `The argument "${at.label}" is not a readable project-relative path.`,
      'path',
      PATH_HINT,
    );
  }

  return text;
}

/** The range of an integer argument, and what happens below its floor. */
interface IntegerBounds {
  readonly floor: number;
  readonly ceiling: number;
  readonly belowFloor: 'clamp' | 'refuse';
}

/**
 * Reads an integer argument: a safe, non-negative whole number, clamped into
 * `[floor, ceiling]` (or refused below the floor), with every clamp recorded.
 *
 * @param state The parse state.
 * @param at Where to read.
 * @param bounds The accepted range.
 * @returns The integer, or `undefined` when absent or refused.
 */
function readInteger(state: ParseState, at: FieldAt, bounds: IntegerBounds): number | undefined {
  const raw = readRaw(at);
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    return refuseArgument(state, `The argument "${at.label}" must be a whole number.`);
  }
  if (raw < 0) {
    return refuseArgument(state, `The argument "${at.label}" must not be negative.`);
  }

  // `-0` passes both tests above; it is normalised so the request serialises as it reads.
  const value = raw === 0 ? 0 : raw;
  if (value < bounds.floor) {
    if (bounds.belowFloor === 'refuse') {
      return refuseArgument(
        state,
        `The argument "${at.label}" must be at least ${String(bounds.floor)}.`,
      );
    }
    state.clamped.push(at.label);
    return bounds.floor;
  }
  if (value > bounds.ceiling) {
    state.clamped.push(at.label);
    return bounds.ceiling;
  }
  return value;
}

/**
 * Reads a result-count argument, clamped into `[1, ceiling]`.
 *
 * @param state The parse state.
 * @param at Where to read.
 * @param ceiling The highest count permitted.
 * @returns The count, or `undefined` when absent or refused.
 */
function readCount(state: ParseState, at: FieldAt, ceiling: number): number | undefined {
  return readInteger(state, at, { floor: 1, ceiling, belowFloor: 'clamp' });
}

/**
 * Reads a boolean argument.
 *
 * @param state The parse state.
 * @param at Where to read.
 * @returns The boolean, or `undefined` when absent or refused.
 */
function readBoolean(state: ParseState, at: FieldAt): boolean | undefined {
  const raw = readRaw(at);
  if (raw === undefined) {
    return undefined;
  }
  return typeof raw === 'boolean'
    ? raw
    : refuseArgument(state, `The argument "${at.label}" must be true or false.`);
}

/**
 * Reads one member of a closed vocabulary.
 *
 * @param state The parse state.
 * @param at Where to read.
 * @param vocabulary The accepted values.
 * @param normalize Case normalisation applied before matching.
 * @returns The member, or `undefined` when absent or refused.
 */
function readMember<T extends string>(
  state: ParseState,
  at: FieldAt,
  vocabulary: readonly T[],
  normalize: (text: string) => string,
): T | undefined {
  const raw = readRaw(at);
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    return refuseArgument(state, `The argument "${at.label}" must be a string.`);
  }
  const wanted = normalize(raw.trim());
  const member = vocabulary.find((candidate) => candidate === wanted);
  return (
    member ??
    refuseArgument(state, `The argument "${at.label}" must be one of: ${vocabulary.join(', ')}.`)
  );
}

/**
 * Reads a list drawn from a closed vocabulary. One bare member where a list was
 * declared is accepted as a one-item list — the one repair the engine makes
 * too — and the result is de-duplicated into the vocabulary's canonical order.
 *
 * @param state The parse state.
 * @param at Where to read.
 * @param vocabulary The accepted values, in canonical order.
 * @param isMember The vocabulary's own membership predicate.
 * @returns The list, or `undefined` when absent or refused.
 */
function readVocabularyList<T extends string>(
  state: ParseState,
  at: FieldAt,
  vocabulary: readonly T[],
  isMember: (value: unknown) => value is T,
): readonly T[] | undefined {
  const raw = readRaw(at);
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' && !Array.isArray(raw)) {
    return refuseArgument(state, `The argument "${at.label}" must be a list of strings.`);
  }

  const items: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
  if (items.length === 0) {
    return refuseArgument(
      state,
      `The argument "${at.label}" must list at least one value; omit it to accept every value.`,
    );
  }
  if (items.length > MAX_LIST_ARGUMENT_ITEMS) {
    return refuseArgument(
      state,
      `The argument "${at.label}" lists more than ${String(MAX_LIST_ARGUMENT_ITEMS)} values.`,
    );
  }
  if (!items.every((item) => isMember(item))) {
    return refuseArgument(
      state,
      `The argument "${at.label}" may only contain: ${vocabulary.join(', ')}.`,
    );
  }

  const wanted = new Set<unknown>(items);
  return Object.freeze(vocabulary.filter((member) => wanted.has(member)));
}

/**
 * The identity normalisation, for vocabularies that are matched exactly.
 *
 * @param text The trimmed input.
 * @returns `text`.
 */
function exactly(text: string): string {
  return text;
}

/**
 * Reads a `pathBetween` endpoint: a `nodeId` string, or a selector object naming
 * at least one of `file`, `symbol`, `name` and `kind`.
 *
 * @param state The parse state.
 * @param at Where to read.
 * @returns The endpoint, or `undefined` when refused.
 */
function readEndpoint(state: ParseState, at: FieldAt): CodePathEndpoint | undefined {
  const raw = readRaw(at);
  if (raw === undefined) {
    return refuseArgument(state, `${state.tool} requires the argument "${at.label}".`);
  }
  if (typeof raw === 'string') {
    return readText(state, at, 'nodeId', true);
  }
  if (!isPlainRecord(raw)) {
    return refuseArgument(
      state,
      `The argument "${at.label}" must be a nodeId string or a selector object.`,
    );
  }

  const nested = (key: string): FieldAt => ({ source: raw, key, label: `${at.label}.${key}` });
  const file = readText(state, nested('file'), 'file', false);
  const symbol = readText(state, nested('symbol'), 'name', false);
  const name = readText(state, nested('name'), 'name', false);
  const kind = readMember(state, nested('kind'), CODE_NODE_KINDS, exactly);
  if (state.failure !== undefined) {
    return undefined;
  }
  if (file === undefined && symbol === undefined && name === undefined && kind === undefined) {
    return refuseArgument(
      state,
      `The selector "${at.label}" must name at least one of file, symbol, name or kind.`,
    );
  }

  const selector: CodeNodeSelector = {
    ...(file !== undefined ? { file } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
  return Object.freeze(selector);
}

/**
 * The most context lines an excerpt may ask for: small enough that the anchor
 * line and the same context on both sides fit in `maxExcerptLines`.
 *
 * @param limits The effective limits.
 * @returns The context-line ceiling.
 */
function maxContextLines(limits: CodeToolLimits): number {
  return Math.floor((limits.maxExcerptLines - 1) / 2);
}

/**
 * The context lines used when a request names none.
 *
 * @param limits The effective limits.
 * @returns The default, never above {@link maxContextLines}.
 */
function defaultContextLines(limits: CodeToolLimits): number {
  return Math.min(DEFAULT_EXCERPT_CONTEXT_LINES, maxContextLines(limits));
}

/** Parses `findByName`. */
function parseFindByName(state: ParseState): FindByNameRequest | undefined {
  const name = readText(state, field(state, 'name'), 'name', true);
  const kinds = readVocabularyList(state, field(state, 'kinds'), CODE_NODE_KINDS, isCodeNodeKind);
  const exact = readBoolean(state, field(state, 'exact'));
  const limit = readCount(state, field(state, 'limit'), state.limits.maxResultsPerCall);
  if (state.failure !== undefined || name === undefined) {
    return undefined;
  }
  const request: FindByNameRequest = {
    tool: 'findByName',
    name,
    ...(kinds !== undefined ? { kinds } : {}),
    ...(exact !== undefined ? { exact } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
  return Object.freeze(request);
}

/** Parses `findSymbol`. */
function parseFindSymbol(state: ParseState): FindSymbolRequest | undefined {
  const file = readText(state, field(state, 'file'), 'file', true);
  const symbol = readText(state, field(state, 'symbol'), 'name', true);
  if (state.failure !== undefined || file === undefined || symbol === undefined) {
    return undefined;
  }
  const request: FindSymbolRequest = { tool: 'findSymbol', file, symbol };
  return Object.freeze(request);
}

/** Parses `whoCalls`. */
function parseWhoCalls(state: ParseState): WhoCallsRequest | undefined {
  const symbol = readText(state, field(state, 'symbol'), 'name', true);
  const file = readText(state, field(state, 'file'), 'file', false);
  const limit = readCount(state, field(state, 'limit'), state.limits.maxResultsPerCall);
  const useReferences = readBoolean(state, field(state, 'useReferences'));
  if (state.failure !== undefined || symbol === undefined) {
    return undefined;
  }
  const request: WhoCallsRequest = {
    tool: 'whoCalls',
    symbol,
    ...(file !== undefined ? { file } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(useReferences !== undefined ? { useReferences } : {}),
  };
  return Object.freeze(request);
}

/** Parses `routeForUrl`. */
function parseRouteForUrl(state: ParseState): RouteForUrlRequest | undefined {
  const url = readText(state, field(state, 'url'), 'url', true);
  if (state.failure !== undefined || url === undefined) {
    return undefined;
  }
  const request: RouteForUrlRequest = { tool: 'routeForUrl', url };
  return Object.freeze(request);
}

/** Parses `handlersFor`. */
function parseHandlersFor(state: ParseState): HandlersForRequest | undefined {
  const url = readText(state, field(state, 'url'), 'url', true);
  const method = readMember(state, field(state, 'method'), HTTP_METHOD_NAMES, (text) =>
    text.toUpperCase(),
  );
  if (state.failure !== undefined || url === undefined) {
    return undefined;
  }
  const request: HandlersForRequest = {
    tool: 'handlersFor',
    url,
    ...(method !== undefined ? { method } : {}),
  };
  return Object.freeze(request);
}

/** Parses `componentsRendering`. */
function parseComponentsRendering(state: ParseState): ComponentsRenderingRequest | undefined {
  const component = readText(state, field(state, 'component'), 'name', true);
  const limit = readCount(state, field(state, 'limit'), state.limits.maxResultsPerCall);
  if (state.failure !== undefined || component === undefined) {
    return undefined;
  }
  const request: ComponentsRenderingRequest = {
    tool: 'componentsRendering',
    component,
    ...(limit !== undefined ? { limit } : {}),
  };
  return Object.freeze(request);
}

/** Parses `pathBetween`. */
function parsePathBetween(state: ParseState): PathBetweenRequest | undefined {
  const from = readEndpoint(state, field(state, 'from'));
  const to = readEndpoint(state, field(state, 'to'));
  const edgeKinds = readVocabularyList(
    state,
    field(state, 'edgeKinds'),
    CODE_EDGE_KINDS,
    isCodeEdgeKind,
  );
  const direction = readMember(state, field(state, 'direction'), PATH_DIRECTIONS, (text) =>
    text.toLowerCase(),
  );
  const maxDepth = readCount(state, field(state, 'maxDepth'), state.limits.maxPathDepth);
  if (state.failure !== undefined || from === undefined || to === undefined) {
    return undefined;
  }
  const request: PathBetweenRequest = {
    tool: 'pathBetween',
    from,
    to,
    ...(edgeKinds !== undefined ? { edgeKinds } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  };
  return Object.freeze(request);
}

/**
 * Parses `excerpt`: a `nodeId`, or a `file` with an optional `line` (the engine
 * is handed `1` when it is absent) and `endLine`. `endLine` is clamped into
 * `[line, last line that keeps the window within maxExcerptLines]` and
 * `contextLines` into `[0, floor((maxExcerptLines - 1) / 2)]`, so the anchor
 * line always survives the line cap.
 */
function parseExcerpt(state: ParseState): ExcerptRequest | undefined {
  const lineBounds: IntegerBounds = { floor: 1, ceiling: MAX_LINE_NUMBER, belowFloor: 'refuse' };
  const nodeId = readText(state, field(state, 'nodeId'), 'nodeId', false);
  const file = readText(state, field(state, 'file'), 'file', false);
  const line = readInteger(state, field(state, 'line'), lineBounds);
  const endLine = readInteger(state, field(state, 'endLine'), lineBounds);
  const contextLines = readInteger(state, field(state, 'contextLines'), {
    floor: 0,
    ceiling: maxContextLines(state.limits),
    belowFloor: 'clamp',
  });
  if (state.failure !== undefined) {
    return undefined;
  }

  const context = contextLines !== undefined ? { contextLines } : {};

  if (nodeId !== undefined) {
    if (file !== undefined || line !== undefined || endLine !== undefined) {
      return refuseArgument(
        state,
        'excerpt takes either "nodeId", or "file" with optional "line" and "endLine", never both.',
      );
    }
    const request: ExcerptRequest = { tool: 'excerpt', nodeId, ...context };
    return Object.freeze(request);
  }

  if (file === undefined) {
    return refuseArgument(state, 'excerpt requires either the argument "nodeId" or "file".');
  }

  let boundedEnd = endLine;
  if (endLine !== undefined) {
    const anchor = line ?? 1;
    const start = Math.max(anchor - (contextLines ?? defaultContextLines(state.limits)), 1);
    const lastInWindow = start + state.limits.maxExcerptLines - 1;
    if (endLine < anchor || endLine > lastInWindow) {
      boundedEnd = endLine < anchor ? anchor : lastInWindow;
      state.clamped.push('endLine');
    }
  }

  const request: ExcerptRequest = {
    tool: 'excerpt',
    file,
    ...(line !== undefined ? { line } : {}),
    ...(boundedEnd !== undefined ? { endLine: boundedEnd } : {}),
    ...context,
  };
  return Object.freeze(request);
}

/**
 * Parses the arguments of the tool the state names.
 *
 * @param state The parse state.
 * @returns The request, or `undefined` with `state.failure` set.
 */
function parseArguments(state: ParseState): CodeToolRequest | undefined {
  switch (state.tool) {
    case 'findByName':
      return parseFindByName(state);
    case 'findSymbol':
      return parseFindSymbol(state);
    case 'whoCalls':
      return parseWhoCalls(state);
    case 'routeForUrl':
      return parseRouteForUrl(state);
    case 'handlersFor':
      return parseHandlersFor(state);
    case 'componentsRendering':
      return parseComponentsRendering(state);
    case 'pathBetween':
      return parsePathBetween(state);
    case 'excerpt':
      return parseExcerpt(state);
    default:
      return assertNever(state.tool, 'Unhandled code tool');
  }
}

/**
 * The parser behind {@link parseCodeToolRequest} and every instance call: the
 * normalised request plus the argument names it clamped. Total: a value that
 * cannot even be inspected (a throwing proxy) is a malformed request.
 *
 * @param value The untrusted request.
 * @param limits The effective limits.
 * @returns The parsed request, or the first rejection.
 */
function parseRequest(
  value: unknown,
  limits: CodeToolLimits,
): Result<ParsedRequest, CodeToolRejection> {
  try {
    if (!isPlainRecord(value)) {
      return err(
        rejection('malformed', 'A tool request must be a JSON object.', {
          hint: REQUEST_SHAPE_HINT,
        }),
      );
    }

    const tool = readOwnData(value, 'tool');
    if (tool === undefined || tool === null) {
      return err(
        rejection('malformed', 'A tool request must name its tool in the "tool" key.', {
          hint: toolListHint(),
        }),
      );
    }
    if (!isCodeToolName(tool)) {
      return err(
        rejection('malformed', 'The requested tool is not in the catalog.', {
          hint: toolListHint(),
        }),
      );
    }

    const state: ParseState = { tool, record: value, limits, clamped: [], failure: undefined };
    const request = parseArguments(state);
    if (state.failure !== undefined) {
      return err(state.failure);
    }
    if (request === undefined) {
      return err(
        rejection('malformed', 'The tool request could not be read.', {
          tool,
          hint: argumentHint(tool),
        }),
      );
    }

    const parsed: ParsedRequest = { request, clamped: Object.freeze([...state.clamped]) };
    return ok(Object.freeze(parsed));
  } catch {
    return err(
      rejection('malformed', 'The tool request could not be read.', { hint: REQUEST_SHAPE_HINT }),
    );
  }
}

/**
 * Validates and normalises one untrusted, model-proposed request without
 * executing it. Total and hand-written: it never throws, rejects anything that
 * is not a plain object with a catalog `tool` and well-typed arguments, trims
 * names and URLs, clamps `limit`, `maxDepth`, `contextLines` and `endLine` into
 * range, refuses unsafe file paths, and drops keys the tool does not declare.
 * Only own data properties are read, so neither a getter nor a polluted
 * prototype can contribute a value.
 *
 * @param value The request as decoded from model output.
 * @param limits The limits to clamp against; resolved with
 * {@link resolveCodeToolLimits}, {@link CODE_TOOL_LIMITS} when absent.
 * @returns The normalised request, or a rejection naming what was wrong.
 */
export function parseCodeToolRequest(
  value: unknown,
  limits?: CodeToolLimits,
): Result<CodeToolRequest, CodeToolRejection> {
  const effective = limits === undefined ? CODE_TOOL_LIMITS : resolveCodeToolLimits(limits);
  const parsed = parseRequest(value, effective);
  return parsed.ok ? ok(parsed.value.request) : parsed;
}

/* -------------------------------------------------------------------------------------------------
 * Shaping results
 * ---------------------------------------------------------------------------------------------- */

/** A shaped result and its serialized size. */
interface Shaped<R> {
  readonly result: R;
  readonly bytes: number;
}

/**
 * The UTF-8 length of a string, counted without allocation. A surrogate pair is
 * one four-byte code point; `JSON.stringify` never emits a lone surrogate.
 *
 * @param text The string.
 * @returns Its UTF-8 byte length.
 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1))) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Whether a UTF-16 code unit opens a surrogate pair.
 *
 * @param code The code unit.
 * @returns `true` for U+D800–U+DBFF.
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Whether a UTF-16 code unit closes a surrogate pair.
 *
 * @param code The code unit (`NaN` past the end of a string).
 * @returns `true` for U+DC00–U+DFFF.
 */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The serialized size of a result: the UTF-8 length of its compact
 * `JSON.stringify` form — the same rule the pipeline's payload budget uses, and
 * never smaller than the string length a caller may measure instead.
 *
 * @param value The result.
 * @returns Its size in bytes.
 */
function serializedBytes(value: unknown): number {
  const json: string | undefined = JSON.stringify(value);
  return json === undefined ? 0 : utf8Length(json);
}

/**
 * Shapes a list answer: capped to `cap` items in the engine's own order, then
 * trimmed from the end, one item at a time, until the serialized result fits
 * `maxBytes`. `total` is the engine's count before either cut.
 *
 * @param request The normalised request.
 * @param clamped The arguments its normalisation clamped.
 * @param answer The engine's list.
 * @param cap The most items the result may carry.
 * @param maxBytes The serialized-size budget.
 * @returns The frozen result and its size.
 */
function shapeList<Q extends CodeToolRequest, T>(
  request: Q,
  clamped: readonly string[],
  answer: readonly T[],
  cap: number,
  maxBytes: number,
): Shaped<CodeToolListResult<Q, T>> {
  const items = asList(answer);
  const kept = items.slice(0, cap);
  let truncated = kept.length < items.length;

  const build = (): CodeToolListResult<Q, T> => {
    const result: CodeToolListResult<Q, T> = {
      tool: request.tool,
      request,
      found: items.length > 0,
      total: items.length,
      returned: kept.length,
      truncated,
      clamped,
      payload: Object.freeze([...kept]),
    };
    return Object.freeze(result);
  };

  let result = build();
  let bytes = serializedBytes(result);
  while (bytes > maxBytes && kept.length > 0) {
    kept.pop();
    truncated = true;
    result = build();
    bytes = serializedBytes(result);
  }
  return { result, bytes };
}

/**
 * Shapes a single-value answer, passing the engine's value through unchanged.
 * A value whose result would exceed `maxBytes` is withheld: `found` stays
 * `true`, `returned` is `0` and `truncated` is `true`.
 *
 * @param request The normalised request.
 * @param clamped The arguments its normalisation clamped.
 * @param value The engine's value, or `undefined` for "nothing found".
 * @param maxBytes The serialized-size budget.
 * @returns The frozen result and its size.
 */
function shapeItem<Q extends CodeToolRequest, T>(
  request: Q,
  clamped: readonly string[],
  value: T | undefined,
  maxBytes: number,
): Shaped<CodeToolItemResult<Q, T>> {
  const build = (
    found: boolean,
    returned: number,
    truncated: boolean,
    payload: T | undefined,
  ): Shaped<CodeToolItemResult<Q, T>> => {
    const result: CodeToolItemResult<Q, T> = {
      tool: request.tool,
      request,
      found,
      total: found ? 1 : 0,
      returned,
      truncated,
      clamped,
      ...(payload !== undefined ? { payload } : {}),
    };
    const frozen = Object.freeze(result);
    return { result: frozen, bytes: serializedBytes(frozen) };
  };

  if (value === undefined || value === null) {
    return build(false, 0, false, undefined);
  }
  const full = build(true, 1, false, value);
  return full.bytes <= maxBytes ? full : build(true, 0, true, undefined);
}

/**
 * Cuts text to at most `maxChars` characters: at the last line break that fits
 * when there is one, otherwise at a character boundary that never splits a
 * surrogate pair.
 *
 * @param text The text.
 * @param maxChars The most characters to keep.
 * @returns The text, cut.
 */
function cutText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const lineBreak = text.lastIndexOf('\n', maxChars);
  if (lineBreak > 0) {
    return text.slice(0, lineBreak);
  }
  const end =
    maxChars > 0 && isHighSurrogate(text.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  return text.slice(0, end);
}

/**
 * An excerpt carrying different text, with `endLine` recomputed from the text
 * and `truncated` set.
 *
 * @param excerpt The engine's excerpt.
 * @param text The cut text.
 * @returns A new, frozen excerpt.
 */
function excerptWithText(excerpt: CodeExcerpt, text: string): CodeExcerpt {
  const lineCount = Math.max(text.split('\n').length, 1);
  const window: CodeExcerpt = {
    file: excerpt.file,
    startLine: excerpt.startLine,
    endLine: excerpt.startLine + lineCount - 1,
    text,
    truncated: true,
  };
  return Object.freeze(window);
}

/**
 * Applies the stage's excerpt caps on top of the engine's own: at most
 * `maxLines` lines, then at most `maxChars` characters. An excerpt already
 * within both caps is returned as the same object.
 *
 * @param excerpt The engine's excerpt.
 * @param maxLines The line cap.
 * @param maxChars The character cap.
 * @returns The excerpt, capped.
 */
function capExcerptWindow(excerpt: CodeExcerpt, maxLines: number, maxChars: number): CodeExcerpt {
  const lines = excerpt.text.split('\n');
  const withinLines = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : excerpt.text;
  const text = cutText(withinLines, maxChars);
  return text === excerpt.text ? excerpt : excerptWithText(excerpt, text);
}

/**
 * Shapes an excerpt answer: the stage's line and character caps first, then
 * the text is shortened until the serialized result fits the size budget; if
 * no non-empty window fits, the payload is withheld as {@link shapeItem} does.
 *
 * @param request The normalised request.
 * @param clamped The arguments its normalisation clamped.
 * @param excerpt The engine's excerpt, or `undefined` when it produced none.
 * @param limits The effective limits.
 * @returns The frozen result and its size.
 */
function shapeExcerpt(
  request: ExcerptRequest,
  clamped: readonly string[],
  excerpt: CodeExcerpt | undefined,
  limits: CodeToolLimits,
): Shaped<ExcerptResult> {
  const maxBytes = limits.maxSerializedResultBytes;
  if (excerpt === undefined || excerpt === null) {
    return shapeItem<ExcerptRequest, CodeExcerpt>(request, clamped, undefined, maxBytes);
  }

  const measure = (window: CodeExcerpt): Shaped<ExcerptResult> => {
    const result: ExcerptResult = {
      tool: 'excerpt',
      request,
      found: true,
      total: 1,
      returned: 1,
      truncated: window.truncated,
      clamped,
      payload: window,
    };
    const frozen = Object.freeze(result);
    return { result: frozen, bytes: serializedBytes(frozen) };
  };

  let window = capExcerptWindow(excerpt, limits.maxExcerptLines, limits.maxExcerptChars);
  let shaped = measure(window);
  if (shaped.bytes > maxBytes && window.text.length > 0) {
    // The text is shortened in proportion to the room left once the rest of the
    // result is paid for, because escaping makes a character cost one to six
    // bytes. Each pass keeps strictly fewer characters, so the loop terminates;
    // when the rest of the result alone is over budget there is no room at all
    // and the payload is withheld below.
    const overhead = measure(excerptWithText(window, '')).bytes;
    const room = maxBytes - overhead;
    while (shaped.bytes > maxBytes && window.text.length > 0 && room > 0) {
      const textBytes = Math.max(shaped.bytes - overhead, 1);
      const target = Math.min(
        window.text.length - 1,
        Math.floor((window.text.length * room) / textBytes),
      );
      window = excerptWithText(window, cutText(window.text, Math.max(target, 0)));
      shaped = measure(window);
    }
  }

  const fits = shaped.bytes <= maxBytes && (window.text.length > 0 || excerpt.text.length === 0);
  if (fits) {
    return shaped;
  }

  const withheld: ExcerptResult = {
    tool: 'excerpt',
    request,
    found: true,
    total: 1,
    returned: 0,
    truncated: true,
    clamped,
  };
  const frozen = Object.freeze(withheld);
  return { result: frozen, bytes: serializedBytes(frozen) };
}

/**
 * The target {@link CodeQueries.excerpt} is handed for a request: its `nodeId`,
 * or its file region with `line` defaulting to `1`.
 *
 * @param request The normalised excerpt request.
 * @returns The target, or `undefined` for a request naming neither (which the parser never produces).
 */
function excerptTarget(request: ExcerptRequest): CodeExcerptTarget | undefined {
  if (request.nodeId !== undefined) {
    return request.nodeId;
  }
  if (request.file === undefined) {
    return undefined;
  }
  return {
    file: request.file,
    line: request.line ?? 1,
    ...(request.endLine !== undefined ? { endLine: request.endLine } : {}),
  };
}

/**
 * The structural size of a request for a log record: how many arguments it
 * carries and how many characters its string arguments hold — counts only,
 * never the text.
 *
 * @param request The normalised request.
 * @returns The argument count and the total string length.
 */
function measureArguments(request: CodeToolRequest): {
  readonly count: number;
  readonly chars: number;
} {
  let count = 0;
  let chars = 0;
  for (const key of Object.keys(request)) {
    if (key !== 'tool') {
      count += 1;
      chars += textLength(readOwnData(request, key));
    }
  }
  return { count, chars };
}

/**
 * The total length of the strings in an argument value, one level deep.
 *
 * @param value An argument value.
 * @returns The number of characters its strings hold.
 */
function textLength(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.reduce<number>(
      (sum, item) => sum + (typeof item === 'string' ? item.length : 0),
      0,
    );
  }
  if (isPlainRecord(value)) {
    return Object.keys(value).reduce<number>((sum, key) => {
      const member = readOwnData(value, key);
      return sum + (typeof member === 'string' ? member.length : 0);
    }, 0);
  }
  return 0;
}

/**
 * Whether a result belongs to a given tool, narrowing it to that tool's shape.
 *
 * @param result Any tool result.
 * @param tool The tool to test for.
 * @returns `true` when `result.tool` is `tool`.
 */
function isResultFor<N extends CodeToolName>(
  result: CodeToolResult,
  tool: N,
): result is CodeToolResultFor<N> {
  return result.tool === tool;
}

/**
 * A request object for one tool built from its arguments, for the per-tool
 * methods. The arguments are copied, never mutated, and `tool` always wins over
 * a stray `tool` key among them.
 *
 * @param tool The tool.
 * @param args The caller's arguments, of unknown shape at runtime.
 * @returns The request to parse.
 */
function composeRequest(tool: CodeToolName, args: unknown): unknown {
  try {
    return isPlainRecord(args) ? { ...args, tool } : { tool };
  } catch {
    return { tool };
  }
}

/* -------------------------------------------------------------------------------------------------
 * The instance
 * ---------------------------------------------------------------------------------------------- */

/**
 * What {@link createCodeTools} is given — and nothing else. There is
 * deliberately no field for the developer's question, a follow-up or a target
 * descriptor: keeping them out of this module's surface is what makes it
 * structurally unable to branch on question text (AAP §0.5.4).
 */
export interface CodeToolsOptions {
  /** The code-analysis bundle the orchestrator loaded for this pipeline run. */
  readonly handles: PipelineCodeHandles;
  /** Tighter stage limits; resolved with {@link resolveCodeToolLimits} against the engine's own. */
  readonly limits?: Partial<CodeToolLimits> | undefined;
  /** Receives one structural `debug` record per call; `noopLogger` when absent. */
  readonly logger?: Logger | undefined;
  /** Cancels the stage: once aborted, every call is refused without delegation. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * One method per tool, taking that tool's arguments without the `tool`
 * discriminant. Each delegates to the {@link CodeQueries} method of the same
 * name, through the same parse, abort, budget and shaping pipeline as
 * {@link CodeTools.runCodeTool}. The mapped type makes a tool without a method
 * a compile error.
 */
export type CodeToolMethods = {
  readonly [N in CodeToolName]: (
    args: CodeToolArguments<N>,
  ) => Promise<Result<CodeToolResultFor<N>, CodeToolRejection>>;
};

/** The code tools of one investigation stage run. Every member resolves; none throws. */
export interface CodeTools extends CodeToolMethods {
  /**
   * The boolean form of `findSymbol`: whether the file declares the symbol. Runs
   * `findSymbol` through the pipeline, so it consumes that tool's budget.
   */
  readonly hasSymbol: (
    args: CodeToolArguments<'findSymbol'>,
  ) => Promise<Result<boolean, CodeToolRejection>>;
  /** The boundary entry point for model output: parse, abort check, budget, dispatch, shape. */
  readonly runCodeTool: (request: unknown) => Promise<CodeToolOutcome>;
  /**
   * Runs a batch sequentially and deterministically, one {@link CodeToolRun} per
   * input in order. Once the budget is spent the remaining entries are budget
   * rejections rather than a shorter array.
   */
  readonly runCodeTools: (requests: readonly unknown[]) => Promise<readonly CodeToolRun[]>;
  /** A fresh, frozen snapshot of the live budget. */
  readonly budget: () => CodeToolBudgetSnapshot;
  /** {@link describeCodeTools} rendered with this instance's effective limits. */
  readonly describe: () => string;
}

/** A parsed-or-not request and its outcome, before a batch index is attached. */
interface RunOutcome {
  readonly request?: CodeToolRequest | undefined;
  readonly outcome: CodeToolOutcome;
}

/**
 * Creates the code tools of one investigation stage run over injected handles.
 *
 * The instance holds the only state in this module — its budget counters — and
 * is meant to be discarded with the stage run. Its effective limits are
 * {@link resolveCodeToolLimits} of `options.limits`, further bounded by the
 * limits `handles.queries` reports.
 *
 * **Budget accounting.** A call slot (and, for `excerpt`, an excerpt slot) is
 * consumed exactly when a request is delegated to the query engine — whether
 * the engine then answers, finds nothing or fails. A request refused before
 * delegation — malformed, cancelled, over budget, or an excerpt with no loaded
 * project — consumes nothing and is counted in `callsRejected` instead.
 *
 * @param options The handles, and optionally tighter limits, a logger and a signal.
 * @returns The frozen tools.
 */
export function createCodeTools(options: CodeToolsOptions): CodeTools {
  const { handles } = options;
  const queries = handles.queries;
  const limits = resolveCodeToolLimits(options.limits, queries.limits);
  const logger = options.logger ?? noopLogger;
  const signal = options.signal;

  let callsUsed = 0;
  let callsRejected = 0;
  let excerptsUsed = 0;
  const perTool: Record<CodeToolName, number> = {
    findByName: 0,
    findSymbol: 0,
    whoCalls: 0,
    routeForUrl: 0,
    handlersFor: 0,
    componentsRendering: 0,
    pathBetween: 0,
    excerpt: 0,
  };

  const budget = (): CodeToolBudgetSnapshot => {
    const snapshot: CodeToolBudgetSnapshot = {
      limits,
      callsUsed,
      callsRemaining: Math.max(limits.maxCallsPerStage - callsUsed, 0),
      callsRejected,
      excerptsUsed,
      excerptsRemaining: Math.max(limits.maxExcerptsPerStage - excerptsUsed, 0),
      perTool: Object.freeze({ ...perTool }),
    };
    return Object.freeze(snapshot);
  };

  /**
   * Call records the logger refused since the last one it accepted.
   *
   * The service hands this module loggers that `../../logging.ts`'s
   * `guardLogger` has already made no-throw, but this module may import
   * nothing beyond its two packages and the context builder (its self-scan
   * suite pins that set), so it cannot apply the guard to a logger it is given.
   * An injected logger that throws anyway meets the same best-effort policy the
   * guard applies: the record is dropped, the query's result stands, and the
   * drop is counted — then announced as `droppedRecords` on the next record the
   * logger accepts, because the logger that failed is the only sink this
   * module has.
   */
  let droppedRecords = 0;

  const log = (fields: LogFields): void => {
    try {
      logger.debug('code tool call', droppedRecords === 0 ? fields : { ...fields, droppedRecords });
      droppedRecords = 0;
    } catch {
      droppedRecords += 1;
    }
  };

  const refuse = (tool: CodeToolName | undefined, failure: CodeToolRejection): CodeToolOutcome => {
    callsRejected += 1;
    log({ ...(tool !== undefined ? { tool } : {}), ok: false, code: failure.code, callsUsed });
    return Object.freeze(err(failure));
  };

  const account = (tool: CodeToolName): void => {
    callsUsed += 1;
    perTool[tool] += 1;
    if (tool === 'excerpt') {
      excerptsUsed += 1;
    }
  };

  const checkBudget = (tool: CodeToolName): CodeToolRejection | undefined => {
    if (callsUsed >= limits.maxCallsPerStage) {
      return rejection('budget', 'The query budget of this stage is spent.', {
        tool,
        hint: 'No further query can run in this stage; emit the investigation from the results already returned.',
        budget: budget(),
      });
    }
    if (perTool[tool] >= limits.maxCallsPerTool) {
      return rejection('budget', `The query budget of ${tool} is spent for this stage.`, {
        tool,
        hint: 'Use a different tool, or emit the investigation from the results already returned.',
        budget: budget(),
      });
    }
    if (tool === 'excerpt' && excerptsUsed >= limits.maxExcerptsPerStage) {
      return rejection('budget', 'The excerpt budget of this stage is spent.', {
        tool,
        hint: 'Graph queries can still run; rely on the excerpts already returned.',
        budget: budget(),
      });
    }
    return undefined;
  };

  /** Delegates one request to its {@link CodeQueries} method and shapes the answer. */
  const dispatch = (
    request: CodeToolRequest,
    clamped: readonly string[],
  ): Shaped<CodeToolResult> => {
    const maxBytes = limits.maxSerializedResultBytes;
    switch (request.tool) {
      case 'findByName': {
        const limit = request.limit ?? limits.maxResultsPerCall;
        const answer = queries.findByName(request.name, {
          ...(request.kinds !== undefined ? { kinds: request.kinds } : {}),
          ...(request.exact !== undefined ? { exact: request.exact } : {}),
          limit,
        });
        return shapeList(request, clamped, answer, limit, maxBytes);
      }
      case 'findSymbol':
        return shapeItem(
          request,
          clamped,
          queries.findSymbol(request.file, request.symbol),
          maxBytes,
        );
      case 'whoCalls': {
        const limit = request.limit ?? limits.maxResultsPerCall;
        const target: string | WhoCallsTarget =
          request.file !== undefined
            ? { file: request.file, symbol: request.symbol }
            : request.symbol;
        const answer = queries.whoCalls(target, {
          limit,
          ...(request.useReferences !== undefined ? { useReferences: request.useReferences } : {}),
        });
        return shapeList(request, clamped, answer, limit, maxBytes);
      }
      case 'routeForUrl':
        return shapeItem(request, clamped, queries.routeForUrl(request.url), maxBytes);
      case 'handlersFor': {
        const answer =
          request.method !== undefined
            ? queries.handlersFor(request.url, { method: request.method })
            : queries.handlersFor(request.url);
        return shapeList(request, clamped, answer, limits.maxResultsPerCall, maxBytes);
      }
      case 'componentsRendering': {
        const limit = request.limit ?? limits.maxResultsPerCall;
        const answer = queries.componentsRendering(request.component, { limit });
        return shapeList(request, clamped, answer, limit, maxBytes);
      }
      case 'pathBetween': {
        const answer = queries.pathBetween(request.from, request.to, {
          ...(request.edgeKinds !== undefined ? { edgeKinds: request.edgeKinds } : {}),
          ...(request.direction !== undefined ? { direction: request.direction } : {}),
          maxDepth: request.maxDepth ?? limits.maxPathDepth,
        });
        return shapeItem(request, clamped, answer, maxBytes);
      }
      case 'excerpt': {
        const target = excerptTarget(request);
        const answer =
          target === undefined
            ? undefined
            : queries.excerpt(target, {
                contextLines: request.contextLines ?? defaultContextLines(limits),
                maxChars: limits.maxExcerptChars,
              });
        return shapeExcerpt(request, clamped, answer, limits);
      }
      default:
        return assertNever(request, 'Unhandled code tool');
    }
  };

  /** Runs one parsed request: abort check, budget, delegation, shaping, accounting. */
  const execute = async (parsed: ParsedRequest): Promise<CodeToolOutcome> => {
    const { request, clamped } = parsed;
    const tool = request.tool;

    if (signal?.aborted === true) {
      return refuse(
        tool,
        rejection('aborted', 'The investigation stage was cancelled, so no query ran.', {
          tool,
          hint: 'No further query can run in this stage.',
        }),
      );
    }

    const exhausted = checkBudget(tool);
    if (exhausted !== undefined) {
      return refuse(tool, exhausted);
    }

    if (tool === 'excerpt' && handles.loaded === undefined) {
      return refuse(
        tool,
        rejection('excerptUnavailable', 'Source excerpts are unavailable for this session.', {
          tool,
          hint: 'The project source is not loaded, so no source text can be read. Graph queries such as findSymbol, whoCalls and pathBetween still run.',
        }),
      );
    }

    let shaped: Shaped<CodeToolResult>;
    try {
      // One asynchronous boundary for every tool. The engine's queries are
      // synchronous; resolving through a promise keeps a single signature for
      // all eight should one of them (a deeper whoCalls) become asynchronous.
      shaped = await Promise.resolve(dispatch(request, clamped));
    } catch {
      account(tool);
      log({ tool, ok: false, code: CODE_TOOL_REJECTION_CODES.internal, callsUsed });
      return Object.freeze(
        err(
          rejection('internal', 'The query engine failed while executing this tool.', {
            tool,
            hint: 'Try a different query; this one cannot be answered.',
          }),
        ),
      );
    }

    account(tool);
    const size = measureArguments(request);
    log({
      tool,
      ok: true,
      returned: shaped.result.returned,
      total: shaped.result.total,
      truncated: shaped.result.truncated,
      bytes: shaped.bytes,
      argumentCount: size.count,
      argumentChars: size.chars,
      callsUsed,
    });
    return Object.freeze(ok(shaped.result));
  };

  /** Parses and executes one untrusted request; never throws. */
  const runOne = async (value: unknown): Promise<RunOutcome> => {
    try {
      const parsed = parseRequest(value, limits);
      if (!parsed.ok) {
        return { outcome: refuse(parsed.error.tool, parsed.error) };
      }
      return { request: parsed.value.request, outcome: await execute(parsed.value) };
    } catch {
      return {
        outcome: refuse(
          undefined,
          rejection('internal', 'The tool request could not be executed.', {
            hint: 'Try a different query.',
          }),
        ),
      };
    }
  };

  const runTyped = async <N extends CodeToolName>(
    tool: N,
    args: CodeToolArguments<N>,
  ): Promise<Result<CodeToolResultFor<N>, CodeToolRejection>> => {
    const { outcome } = await runOne(composeRequest(tool, args));
    if (!outcome.ok) {
      return outcome;
    }
    const value = outcome.value;
    return isResultFor(value, tool)
      ? Object.freeze(ok(value))
      : Object.freeze(
          err(
            rejection('internal', 'The tool answered with the result of a different tool.', {
              tool,
            }),
          ),
        );
  };

  const runCodeTools = async (requests: readonly unknown[]): Promise<readonly CodeToolRun[]> => {
    const batch: readonly unknown[] = isListValue(requests) ? requests : EMPTY_LIST;
    const runs: CodeToolRun[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const { request, outcome } = await runOne(batch[index]);
      const run: CodeToolRun = { index, ...(request !== undefined ? { request } : {}), outcome };
      runs.push(Object.freeze(run));
    }
    return Object.freeze(runs);
  };

  const tools: CodeTools = {
    findByName: (args) => runTyped('findByName', args),
    findSymbol: (args) => runTyped('findSymbol', args),
    whoCalls: (args) => runTyped('whoCalls', args),
    routeForUrl: (args) => runTyped('routeForUrl', args),
    handlersFor: (args) => runTyped('handlersFor', args),
    componentsRendering: (args) => runTyped('componentsRendering', args),
    pathBetween: (args) => runTyped('pathBetween', args),
    excerpt: (args) => runTyped('excerpt', args),
    hasSymbol: async (args) => {
      const outcome = await runTyped('findSymbol', args);
      return outcome.ok ? Object.freeze(ok(outcome.value.found)) : outcome;
    },
    runCodeTool: async (request) => (await runOne(request)).outcome,
    runCodeTools,
    budget,
    describe: () => describeCodeTools({ limits }),
  };
  return Object.freeze(tools);
}

/* -------------------------------------------------------------------------------------------------
 * Contract checks
 * ---------------------------------------------------------------------------------------------- */

/**
 * Compile-time proofs that the vocabulary, the request and result unions, the
 * engine's method names and the path-direction list agree. Exported so
 * `noUnusedLocals` treats the assertions as used; it has no runtime existence.
 */
export type CodeToolsContractChecks = [
  AssertTrue<SameSet<CodeToolRequest['tool'], CodeToolName>>,
  AssertTrue<SameSet<CodeToolResult['tool'], CodeToolName>>,
  AssertTrue<[CodeToolName] extends [CodeQueryMethodName] ? true : false>,
  AssertTrue<SameSet<(typeof PATH_DIRECTIONS)[number], CodePathDirection>>,
];
