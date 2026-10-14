/**
 * Colocated unit suite for `./investigate.ts`, Stage 2 of the reasoning
 * pipeline (code investigation, AAP §0.4.2).
 *
 * ## Why this file exists
 *
 * The `CodeInvestigation` artifact has no upstream schema, so the stage module
 * owns a total type guard (`isCodeInvestigation`) and the opaque schema built
 * on it (`codeInvestigationSchema`). The stage module imports no validation
 * library (the static self-scan below pins it), which makes pinning that
 * guard with accept **and** reject cases this suite's first mandate: one
 * test per checked condition, so a regression names the exact field that
 * stopped being validated, plus conformance against the imported
 * `relevantFileSchema` — the orchestrator persists the list verbatim as
 * `SessionRecord.relevantFiles`, so a divergence would surface far away, at
 * `parseSessionRecord` in the store.
 *
 * Its second mandate is the propose→execute loop: the query budget, validation
 * before execution, rejections that cost budget, the generated tool catalog,
 * guaranteed termination, no fallback on exhaustion and no repository dump.
 * Then the gate discipline (the upstream repair bound, no second loop, abort,
 * the outbound guard), the progress rows the stage emits and the ones it does
 * not author, the exact placeholder inputs it supplies, and the privacy of its
 * log records and errors.
 *
 * ## What is and is not under test
 *
 * Everything is in-process and hand-written: a scripted `ModelProvider`, a
 * scripted `CodeTools` supplied through the stage's `createTools` seam, a stub
 * `ContextBuilder` that mirrors the real builder's documented contract, a
 * recording `SessionProgress`, a capturing logger and an injected clock. No
 * code graph, no query engine, no project fixture, no store, no network. The
 * one filesystem access is the read-only static self-scan of `investigate.ts`.
 *
 * Deliberately not repeated here: `../tools/code-tools.test.ts` pins the
 * executor (clamping, rejection codes, excerpt refusals, catalog stability),
 * `packages/model-provider/src/structured.test.ts` pins the repair loop's
 * internals (only its observed call counts are asserted below),
 * `./reply-schemas.test.ts` pins how the reply schema renders for a real
 * provider and where it draws the structure/value line, and
 * `test/integration/pipeline-deterministic.test.ts` owns the end-to-end
 * assertion over a real fixture graph.
 *
 * Fixtures use invented, generic vocabulary only (an "observatory" with star
 * charts and orbit maths); no name from any real application appears here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  CAPTURE_SIGNALS,
  PROBLEM_CATEGORIES,
  problemUnderstandingSchema,
  type ProblemUnderstanding,
} from '@debuggen/instrumentation';
import {
  DEFAULT_MAX_REPAIRS,
  assertOutboundSafe,
  modelUnavailableMessage,
  type JsonObject,
  type JsonValue,
  type ModelProvider,
  type ModelRequest,
  type ModelTextResponse,
  type StructuredAttempt,
  type ToolCallsResponse,
  type ToolDefinition,
} from '@debuggen/model-provider';
import {
  PROGRESS_STAGES,
  parseSessionRecord,
  relevantFileSchema,
  sessionRecordSchema,
  type ProgressStage,
  type ProgressStatus,
  type RelevantFile,
  type SessionProgressPayload,
  type SessionRecord,
} from '@debuggen/protocol';
import {
  DebuggenError,
  createConsoleLogger,
  err,
  isSafeRelativePath,
  ok,
  type LogRecord,
  type Logger,
  type Result,
} from '@debuggen/shared';

import type {
  InvestigationFindings,
  ProgressRow,
  SessionProgress,
} from '../../sessions/progress.js';
import {
  CONTEXT_LIMITS,
  INVESTIGATE_QUERY_BATCH_FIELD,
  STAGE_PLACEHOLDERS,
  redactEmbeddedUrlsDeep,
  redactQuestionText,
  toBoundedJson,
  type ContextBuilder,
  type InvestigateRequestInput,
  type PipelineCodeHandles,
  type PipelineStageContext,
  type StageRequestBuild,
} from '../context-builder.js';
import {
  CODE_TOOL_LIMITS,
  CODE_TOOL_NAMES,
  describeCodeTools,
  isCodeToolName,
  parseCodeToolRequest,
  resolveCodeToolLimits,
  type CodeToolBudgetSnapshot,
  type CodeToolLimits,
  type CodeToolName,
  type CodeToolOutcome,
  type CodeToolRejection,
  type CodeToolRequest,
  type CodeToolResult,
  type CodeToolRun,
  type CodeTools,
  type CodeToolsOptions,
} from '../tools/code-tools.js';
import {
  codeInvestigationSchema,
  createInvestigateStage,
  isCodeInvestigation,
  type CodeFlow,
  type CodeInvestigation,
  type InvestigateStageDeps,
  type InvestigateStageInput,
  type InvestigateStageResult,
} from './investigate.js';

// ---------------------------------------------------------------------------
// Imported vocabulary — never restated as string literals
// ---------------------------------------------------------------------------

/**
 * The stage's member of protocol's `PROGRESS_STAGES`, read from the imported
 * tuple (the harness suite pins that it is the `investigate` member). Its
 * literal type is also a prompt stage, so the stub builder's metadata uses it.
 */
const INVESTIGATE = PROGRESS_STAGES[1];

/** The failure record `SessionProgress.stageFailed` receives, named through the interface itself. */
type SessionFailure = Parameters<SessionProgress['stageFailed']>[1];

/** The schema argument of `ModelProvider.generateStructured`, named without importing zod. */
type StructuredSchema = Parameters<ModelProvider['generateStructured']>[0];

/** The progress statuses the recording double answers with. */
const RUNNING: ProgressStatus = 'running';
const DONE: ProgressStatus = 'done';
const FAILED: ProgressStatus = 'failed';

/**
 * The six placeholder keys `prompts/investigate/v001.md` declares, written out
 * once so the suite can prove both that the builder's table says the same and
 * that the stage supplies a source for each of them.
 */
const INVESTIGATE_PLACEHOLDER_KEYS: readonly string[] = [
  'question',
  'understanding',
  'toolCatalog',
  'queryResults',
  'remainingQueries',
  'outputSchema',
];

/**
 * The fields of `InvestigateRequestInput` the stage passes on every turn:
 * the context (the question's carrier), the five structured sources and the
 * prompt version. Nothing else may travel to the builder.
 */
const INVESTIGATE_REQUEST_KEYS: readonly string[] = [
  'context',
  'promptVersion',
  'queryResults',
  'remainingQueries',
  'toolCatalog',
  'toolNames',
  'understanding',
];

// ---------------------------------------------------------------------------
// Fixture vocabulary — invented, generic, never from a real application
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-investigate-suite';
const PROJECT_ROOT = '/workspace/observatory-console';
const PROJECT_NAME = 'observatory-console';
const DEV_SERVER_URL = 'http://127.0.0.1:4173/';
const FIXED_EPOCH_MS = 1_767_225_600_000;

/** How far the injected clock advances on every read. */
const CLOCK_STEP_MS = 7;

/** The prompt version the stub builder loads when nothing names another one. */
const BUILDER_DEFAULT_VERSION = 'v004';

/** A marker only the stub builder's rendered prompt contains. */
const PROMPT_MARKER = 'stub-rendered-investigate-prompt';

/** A distinctive word planted in inputs and model output; it must never reach a log or an error. */
const SENTINEL = 'quasarwhistlemarker';

/** The question most runs ask. */
const BASE_QUESTION = 'Why does the star chart freeze after I press Plot orbit?';

/** The question planted with {@link SENTINEL}. */
const SENTINEL_QUESTION = `Why does the ${SENTINEL} chart freeze after I press Plot orbit?`;

const CHART_FILE = 'src/panels/StarChartPanel.tsx';
const CHART_COMPONENT = 'StarChartPanel';
const SERVICE_FILE = 'src/server/plot-service.ts';
const MATH_FILE = 'src/lib/orbit-math.ts';
const MATH_SYMBOL = 'projectOrbit';
const UNRELATED_FILE = 'src/panels/TelescopeStatusBadge.tsx';
const UNRELATED_COMPONENT = 'TelescopeStatusBadge';
const ROUTE_PATH = '/observatory/readings';

/** A Stage 1 artifact that seeds no query, so every run's accounting is the model's alone. */
const UNSEEDED_UNDERSTANDING: ProblemUnderstanding = {
  category: PROBLEM_CATEGORIES[0],
  signalsNeeded: [CAPTURE_SIGNALS[0]],
  entities: [],
  searchHints: [],
};

/** A Stage 1 artifact whose entities and hints seed three queries (the selector seeds none). */
const SEEDED_UNDERSTANDING: ProblemUnderstanding = {
  category: PROBLEM_CATEGORIES[0],
  signalsNeeded: [CAPTURE_SIGNALS[0]],
  entities: [
    { kind: 'component', name: CHART_COMPONENT },
    { kind: 'selector', name: 'section.chart > canvas' },
    { kind: 'route', name: ROUTE_PATH },
  ],
  searchHints: ['orbit'],
};

/**
 * The investigation most successful runs end with. Every file, symbol and
 * flow step in it is one a {@link resolvingScript} result names, and its flow
 * is the path that script's `pathBetween` answer returns, so a run that finds
 * the chart and traces the flow ({@link TRACE_FLOW}) returns it unchanged by
 * grounding; a run that only finds the steps by name keeps its shortlist and
 * loses the flow, whose steps no executed relationship joined; a run whose
 * queries find nothing returns it grounded down to nothing.
 */
const VALID_INVESTIGATION: CodeInvestigation = {
  relevantFiles: [
    {
      file: CHART_FILE,
      symbol: CHART_COMPONENT,
      reason: 'Renders the chart the question names and starts the plot request.',
      score: 0.9,
    },
    { file: SERVICE_FILE, reason: 'Serves the plot request.', score: 0 },
    { file: MATH_FILE, symbol: MATH_SYMBOL, reason: 'Computes every plotted point.', score: 1 },
  ],
  flows: [`${CHART_COMPONENT} → onPlotPress → GET ${ROUTE_PATH} → ${MATH_SYMBOL}`],
};

/** One valid proposal per catalogued tool, in catalog order. */
const VALID_PROPOSALS: Readonly<Record<CodeToolName, unknown>> = {
  findByName: { tool: 'findByName', name: CHART_COMPONENT },
  findSymbol: { tool: 'findSymbol', file: MATH_FILE, symbol: MATH_SYMBOL },
  whoCalls: { tool: 'whoCalls', symbol: MATH_SYMBOL },
  routeForUrl: { tool: 'routeForUrl', url: ROUTE_PATH },
  handlersFor: { tool: 'handlersFor', url: ROUTE_PATH },
  componentsRendering: { tool: 'componentsRendering', component: CHART_COMPONENT },
  pathBetween: { tool: 'pathBetween', from: { name: CHART_COMPONENT }, to: { name: MATH_SYMBOL } },
  excerpt: { tool: 'excerpt', file: CHART_FILE, line: 10 },
};

/** The proposal most loop tests repeat. */
const FIND_CHART: unknown = VALID_PROPOSALS.findByName;

/** Every character in the inclusive code-point range, in order. */
function charRange(first: string, last: string): string {
  const start = first.codePointAt(0) ?? 0;
  const end = last.codePointAt(0) ?? 0;
  let text = '';
  for (let codePoint = start; codePoint <= end; codePoint += 1) {
    text += String.fromCodePoint(codePoint);
  }
  return text;
}

/** `length` characters drawn from `alphabet` with a fixed stride; deterministic, never random. */
function strideOf(alphabet: string, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += alphabet.charAt((index * 7 + 3) % alphabet.length);
  }
  return text;
}

/**
 * An HTTP bearer credential the outbound guard's deny list matches, assembled
 * from fragments at run time so this tracked file never holds one contiguous
 * credential-shaped literal (the precedent of `scripts/check-secrets.test.mjs`).
 */
const ASSEMBLED_BEARER =
  ['Bea', 'rer '].join('') +
  strideOf(charRange('A', 'Z') + charRange('a', 'z') + charRange('0', '9') + '-_', 36);

// ---------------------------------------------------------------------------
// Small, pure helpers
// ---------------------------------------------------------------------------

/** Orders strings by UTF-16 code unit. */
function byCodeUnit(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** A value with every object's keys sorted at every depth; arrays keep their order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const list: readonly unknown[] = value;
    return list.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(byCodeUnit)) {
      sorted[key] = canonical(Reflect.get(value, key));
    }
    return sorted;
  }
  return value;
}

/** Sorted-key JSON, so neither a hidden difference nor a faked equality passes unnoticed. */
function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** The success value of a result, or a test failure naming the error. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`Expected ok, received ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** The error of a result, or a test failure. */
function expectErr<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error('Expected an Err, received ok.');
  }
  return result.error;
}

/** Element `index` of a recorded list, or a test failure: recorded arrays are indexed defensively. */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(
      `Expected a recorded entry at index ${String(index)}; ${String(list.length)} recorded.`,
    );
  }
  return value;
}

/** The last element of a recorded list, or a test failure. */
function last<T>(list: readonly T[]): T {
  return at(list, list.length - 1);
}

/** Freezes a value and everything reachable from it, so an attempted write throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze<unknown>(Reflect.get(value, key));
    }
    Object.freeze(value);
  }
  return value;
}

/** Everything an error can carry to a user interface, a log or the store, as one string. */
function serializeError(error: DebuggenError): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    hint: error.hint ?? null,
    details: error.details ?? null,
    payload: error.toPayload(),
  });
}

/** A log record as one searchable string: its message and every field. */
function serializeRecord(record: LogRecord): string {
  return JSON.stringify({ message: record.message, fields: record.fields });
}

/** A reply that proposes the given queries, under the field name the output schema declares. */
function batch(...queries: readonly unknown[]): Readonly<Record<string, readonly unknown[]>> {
  return { [INVESTIGATE_QUERY_BATCH_FIELD]: [...queries] };
}

/** A copy of {@link VALID_INVESTIGATION} whose first shortlist entry carries `patch`. */
function withFirstEntry(patch: Readonly<Record<string, unknown>>): unknown {
  const [first, ...rest] = VALID_INVESTIGATION.relevantFiles;
  return {
    relevantFiles: [{ ...first, ...patch }, ...rest],
    flows: [...VALID_INVESTIGATION.flows],
  };
}

/** A copy of {@link VALID_INVESTIGATION} whose first shortlist entry lacks `key`. */
function withoutFirstEntryKey(key: string): unknown {
  const [first, ...rest] = VALID_INVESTIGATION.relevantFiles;
  const entry: Record<string, unknown> = { ...first };
  Reflect.deleteProperty(entry, key);
  return { relevantFiles: [entry, ...rest], flows: [...VALID_INVESTIGATION.flows] };
}

/** A copy of {@link VALID_INVESTIGATION} whose first shortlist entry is replaced by `entry`. */
function withFirstEntryReplaced(entry: unknown): unknown {
  const [, ...rest] = VALID_INVESTIGATION.relevantFiles;
  return { relevantFiles: [entry, ...rest], flows: [...VALID_INVESTIGATION.flows] };
}

/** A copy of {@link VALID_INVESTIGATION} with its top level changed by `patch`. */
function withTopLevel(patch: Readonly<Record<string, unknown>>): unknown {
  return {
    relevantFiles: VALID_INVESTIGATION.relevantFiles.map((entry) => ({ ...entry })),
    flows: [...VALID_INVESTIGATION.flows],
    ...patch,
  };
}

/** A copy of {@link VALID_INVESTIGATION} without the top-level `key`. */
function withoutTopLevelKey(key: string): unknown {
  const copy: Record<string, unknown> = {
    relevantFiles: VALID_INVESTIGATION.relevantFiles.map((entry) => ({ ...entry })),
    flows: [...VALID_INVESTIGATION.flows],
  };
  Reflect.deleteProperty(copy, key);
  return copy;
}

/** `count` distinct, valid shortlist entries. */
function shortlistOf(count: number): RelevantFile[] {
  return Array.from({ length: count }, (_unused, index) => ({
    file: `src/generated/module-${String(index)}.ts`,
    reason: `Candidate module ${String(index)} for the plotted series.`,
    score: 0.5,
  }));
}

/**
 * The `maxItems` the session record's `relevantFiles` schema states in its own
 * JSON Schema rendering — the bound the stage reads — so this suite derives the
 * shortlist ceiling from the one definition instead of restating it.
 */
function sessionShortlistBound(): number {
  const rendered: unknown = sessionRecordSchema.shape.relevantFiles.toJSONSchema();
  const maxItems: unknown =
    rendered !== null && typeof rendered === 'object'
      ? Reflect.get(rendered, 'maxItems')
      : undefined;
  if (typeof maxItems !== 'number') {
    throw new Error('The session record schema no longer states a shortlist bound.');
  }
  return maxItems;
}

// ---------------------------------------------------------------------------
// Doubles: logger, code handles, clock
// ---------------------------------------------------------------------------

/** A logger whose records are collected in memory instead of printed. */
interface CapturedLogger {
  readonly logger: Logger;
  readonly records: LogRecord[];
}

function capturedLogger(): CapturedLogger {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });
  return { logger, records };
}

/**
 * Code-analysis handles that record every read and hold nothing.
 *
 * The stage hands `context.code` to `createTools` unread — the scripted
 * executor below never touches it — so any recorded read is a boundary
 * violation (the stage indexing, walking or querying the project itself).
 * `PipelineCodeHandles` is built from `@debuggen/code-analysis` types this
 * suite deliberately does not construct; the single type assertion below is
 * what lets a proxy stand in for them, and the empty read log every loop test
 * checks is what keeps that assertion honest.
 */
function tripwireCodeHandles(reads: string[]): PipelineCodeHandles {
  const handler: ProxyHandler<object> = {
    get: (_target, key) => {
      reads.push(`get ${String(key)}`);
      return undefined;
    },
    has: (_target, key) => {
      reads.push(`has ${String(key)}`);
      return false;
    },
    ownKeys: () => {
      reads.push('ownKeys');
      return [];
    },
    getOwnPropertyDescriptor: (_target, key) => {
      reads.push(`descriptor ${String(key)}`);
      return undefined;
    },
  };
  return new Proxy({}, handler) as unknown as PipelineCodeHandles;
}

/** A clock that advances {@link CLOCK_STEP_MS} on every read; the stage's only time source. */
function steppingClock(): Mock<() => number> {
  let reads = 0;
  return vi.fn(() => {
    const value = FIXED_EPOCH_MS + reads * CLOCK_STEP_MS;
    reads += 1;
    return value;
  });
}

// ---------------------------------------------------------------------------
// Double: the scripted model provider
// ---------------------------------------------------------------------------

/** One scripted outcome of one `generateStructured` call. */
type ScriptedOutcome =
  | { readonly kind: 'attempt'; readonly raw: unknown }
  | { readonly kind: 'error'; readonly error: DebuggenError }
  | { readonly kind: 'throw'; readonly thrown: Error };

/** An attempt whose decoded output is `raw`. */
function answer(raw: unknown): ScriptedOutcome {
  return { kind: 'attempt', raw };
}

/** A provider-level failure: no output was produced. */
function providerFailure(error: DebuggenError): ScriptedOutcome {
  return { kind: 'error', error };
}

/** Decides the outcome of the `call`-th structured call (0-based); may act on the world first. */
type Responder = (call: number, request: ModelRequest) => ScriptedOutcome;

/** A responder that plays `outcomes` in order and then reports that nothing is queued. */
function queued(...outcomes: readonly ScriptedOutcome[]): Responder {
  return (call) =>
    outcomes[call] ??
    providerFailure(new DebuggenError('INTERNAL', 'The scripted provider has no outcome queued.'));
}

/** A responder that answers every call the same way. */
function always(outcome: ScriptedOutcome): Responder {
  return () => outcome;
}

/** One recorded provider call. */
interface ProviderCall {
  readonly method: 'generateText' | 'generateStructured' | 'callTools';
  readonly request: ModelRequest;
  readonly schema?: StructuredSchema;
  readonly toolCount?: number;
}

const SCRIPTED_MODEL = 'scripted-model';

/** The provider-unavailable failure a transport would report, worded as a transport would. */
function unavailableError(): DebuggenError {
  return new DebuggenError('MODEL_UNAVAILABLE', 'The scripted transport refused the call.', {
    hint: 'Check the provider configuration, then retry the stage.',
    details: { transport: 'scripted' },
  });
}

/**
 * A {@link ModelProvider} that makes **exactly one attempt per call**, as the
 * interface requires, answering each `generateStructured` call through its
 * responder and recording every request. It never validates, repairs or
 * retries: those belong to the upstream loop whose call counts are observed.
 * Text and tool calls are not part of this stage's contract; they are
 * recorded and refused.
 */
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted-test-provider';
  readonly calls: ProviderCall[] = [];
  readonly #respond: Responder;

  constructor(respond: Responder) {
    this.#respond = respond;
  }

  /** The `generateStructured` calls, in order. */
  get structuredCalls(): readonly ProviderCall[] {
    return this.calls.filter((call) => call.method === 'generateStructured');
  }

  generateText(request: ModelRequest): Promise<Result<ModelTextResponse, DebuggenError>> {
    this.calls.push({ method: 'generateText', request });
    return Promise.resolve(err(this.#unexpected('generateText')));
  }

  generateStructured<T>(
    schema: StructuredSchema,
    request: ModelRequest,
  ): Promise<Result<StructuredAttempt<T>, DebuggenError>> {
    const index = this.structuredCalls.length;
    this.calls.push({ method: 'generateStructured', request, schema });
    const next = this.#respond(index, request);
    switch (next.kind) {
      case 'attempt': {
        const attempt: StructuredAttempt<T> = {
          raw: next.raw,
          model: SCRIPTED_MODEL,
          providerId: this.id,
        };
        return Promise.resolve(ok(attempt));
      }
      case 'error':
        return Promise.resolve(err(next.error));
      case 'throw':
        return Promise.reject(next.thrown);
    }
  }

  callTools(
    request: ModelRequest,
    tools: readonly ToolDefinition[],
  ): Promise<Result<ToolCallsResponse, DebuggenError>> {
    this.calls.push({ method: 'callTools', request, toolCount: tools.length });
    return Promise.resolve(err(this.#unexpected('callTools')));
  }

  #unexpected(method: string): DebuggenError {
    return new DebuggenError('INTERNAL', `The investigate stage must not call ${method}.`);
  }
}

// ---------------------------------------------------------------------------
// Double: the scripted code-query executor (the `createTools` seam)
// ---------------------------------------------------------------------------

/** Decides the outcome of the `call`-th executed request (0-based); may act on the world first. */
type ToolScript = (request: CodeToolRequest, call: number) => CodeToolOutcome;

/** An empty, well-formed result for any request: found nothing, cut nothing. */
function emptyResult(request: CodeToolRequest): CodeToolResult {
  const base = { found: false, total: 0, returned: 0, truncated: false, clamped: [] };
  switch (request.tool) {
    case 'findByName':
      return { ...base, tool: request.tool, request, payload: [] };
    case 'findSymbol':
      return { ...base, tool: request.tool, request };
    case 'whoCalls':
      return { ...base, tool: request.tool, request, payload: [] };
    case 'routeForUrl':
      return { ...base, tool: request.tool, request };
    case 'handlersFor':
      return { ...base, tool: request.tool, request, payload: [] };
    case 'componentsRendering':
      return { ...base, tool: request.tool, request, payload: [] };
    case 'pathBetween':
      return { ...base, tool: request.tool, request };
    case 'excerpt':
      return { ...base, tool: request.tool, request };
  }
}

/** The default script: every executed request finds nothing. */
const findNothing: ToolScript = (request) => ok(emptyResult(request));

/** One graph node a scripted `findByName` result names. */
interface ScriptedNode {
  readonly kind: 'component' | 'handler' | 'api-route' | 'db-call' | 'symbol';
  readonly name: string;
  readonly file: string;
}

/** The `nodeId` the scripted results give `node`. */
function scriptedNodeId(node: ScriptedNode): string {
  return `${node.kind}:${node.file}#${node.name}`;
}

/** The code match a scripted result reports for `node`, located at the top of its file. */
function scriptedMatch(node: ScriptedNode) {
  return {
    nodeId: scriptedNodeId(node),
    kind: node.kind,
    name: node.name,
    file: node.file,
    location: {
      file: node.file,
      line: 1,
      column: 1,
      resolvedBy: 'code-graph' as const,
      confidence: 1,
    },
  };
}

/** A `findByName` result naming `nodes`; any other request finds nothing. */
function matchesOutcome(request: CodeToolRequest, nodes: readonly ScriptedNode[]): CodeToolOutcome {
  if (request.tool !== 'findByName') {
    return ok(emptyResult(request));
  }
  const result: CodeToolResult = {
    tool: request.tool,
    request,
    found: nodes.length > 0,
    total: nodes.length,
    returned: nodes.length,
    truncated: false,
    clamped: [],
    payload: nodes.map((node) => ({ ...scriptedMatch(node), score: 1 })),
  };
  return ok(result);
}

/**
 * A `pathBetween` result whose path visits `nodes` in order — the shape the
 * real engine returns for a downstream search: `edges[i]` joins `nodes[i]` to
 * `nodes[i + 1]` in its own direction, and `depth` is the hop count. Any other
 * request finds nothing.
 */
function pathOutcome(request: CodeToolRequest, nodes: readonly ScriptedNode[]): CodeToolOutcome {
  if (request.tool !== 'pathBetween') {
    return ok(emptyResult(request));
  }
  const edges = nodes.slice(1).map((node, index) => ({
    kind: 'calls' as const,
    from: scriptedNodeId(at(nodes, index)),
    to: scriptedNodeId(node),
    traversedAgainstDirection: false,
  }));
  const result: CodeToolResult = {
    tool: request.tool,
    request,
    found: true,
    total: 1,
    returned: 1,
    truncated: false,
    clamped: [],
    payload: {
      nodes: nodes.map(scriptedMatch),
      edges,
      depth: edges.length,
      undirected: false,
      truncated: false,
    },
  };
  return ok(result);
}

/** An `excerpt` result carrying `text`; any other request finds nothing. */
function excerptOutcome(request: CodeToolRequest, text: string): CodeToolOutcome {
  if (request.tool !== 'excerpt') {
    return ok(emptyResult(request));
  }
  const result: CodeToolResult = {
    tool: request.tool,
    request,
    found: true,
    total: 1,
    returned: 1,
    truncated: false,
    clamped: [],
    payload: { file: request.file ?? CHART_FILE, startLine: 1, endLine: 3, text, truncated: false },
  };
  return ok(result);
}

/** A refusal the executor itself reports, as the real one does for an unreadable path. */
const PATH_REJECTION: CodeToolRejection = {
  tool: 'excerpt',
  code: 'PATH_OUTSIDE_PROJECT',
  message: 'The file argument is not a readable project-relative path.',
  hint: 'Pass a project-relative POSIX path taken from an earlier result.',
};

/** What a test may vary about the scripted executor. */
interface ScriptedToolsOptions {
  /** Answers each executed request; {@link findNothing} when absent. */
  readonly script?: ToolScript | undefined;
  /** Overrides the live allowance the budget snapshot reports. */
  readonly callsRemaining?: number | undefined;
  /** Makes the factory itself throw. */
  readonly failCreate?: boolean | undefined;
  /** Makes `budget()` throw. */
  readonly failBudget?: boolean | undefined;
}

/**
 * The `createTools` seam: creates one scripted {@link CodeTools} per run and
 * records everything the stage does with it.
 *
 * `runCodeTool` is the one entry point the stage may use. Every argument it
 * receives is re-parsed here with the imported `parseCodeToolRequest`; a
 * request that does not parse, or that the parser would still change, is
 * recorded in {@link unparsed}, so "validated before execution" is observed
 * rather than assumed. Every other member except `budget` records its own name
 * in {@link otherCalls} and refuses.
 */
class ScriptedToolsFactory {
  /** The options of every `createTools` call, in order. */
  readonly created: CodeToolsOptions[] = [];
  /** Every argument `runCodeTool` received, in order. */
  readonly executed: unknown[] = [];
  /** Arguments that reached the executor without being a parser-normalised request. */
  readonly unparsed: unknown[] = [];
  /** Names of executor members other than `runCodeTool` and `budget` that were called. */
  readonly otherCalls: string[] = [];
  /** How many times the budget snapshot was read. */
  budgetReads = 0;
  readonly #options: ScriptedToolsOptions;

  constructor(options: ScriptedToolsOptions = {}) {
    this.#options = options;
  }

  /** The tool names of every executed request, in order. */
  get executedTools(): readonly string[] {
    return this.executed.map((request) => {
      const tool: unknown =
        request !== null && typeof request === 'object' ? Reflect.get(request, 'tool') : undefined;
      return typeof tool === 'string' ? tool : '<no tool>';
    });
  }

  readonly create = (options: CodeToolsOptions): CodeTools => {
    this.created.push(options);
    if (this.#options.failCreate === true) {
      throw new Error('The scripted executor factory was told to throw.');
    }
    const limits = resolveCodeToolLimits(options.limits);
    const script = this.#options.script ?? findNothing;
    const refuse = (name: string) => (): Promise<Result<never, CodeToolRejection>> => {
      this.otherCalls.push(name);
      return Promise.resolve(
        err({ code: 'INTERNAL', message: `The investigate stage must not call ${name}.` }),
      );
    };
    const snapshot = (): CodeToolBudgetSnapshot => {
      this.budgetReads += 1;
      if (this.#options.failBudget === true) {
        throw new Error('The scripted budget was told to throw.');
      }
      const used = this.executed.length;
      return Object.freeze({
        limits,
        callsUsed: used,
        callsRemaining: this.#options.callsRemaining ?? Math.max(0, limits.maxCallsPerStage - used),
        callsRejected: 0,
        excerptsUsed: 0,
        excerptsRemaining: limits.maxExcerptsPerStage,
        perTool: Object.freeze({
          findByName: 0,
          findSymbol: 0,
          whoCalls: 0,
          routeForUrl: 0,
          handlersFor: 0,
          componentsRendering: 0,
          pathBetween: 0,
          excerpt: 0,
        }),
      });
    };
    const runCodeTool = (request: unknown): Promise<CodeToolOutcome> => {
      this.executed.push(request);
      const call = this.executed.length - 1;
      const parsed = parseCodeToolRequest(request, limits);
      if (!parsed.ok || stableStringify(parsed.value) !== stableStringify(request)) {
        this.unparsed.push(request);
        return Promise.resolve(err({ code: 'INTERNAL', message: 'An unparsed request was run.' }));
      }
      return Promise.resolve(script(parsed.value, call));
    };
    return {
      findByName: refuse('findByName'),
      findSymbol: refuse('findSymbol'),
      whoCalls: refuse('whoCalls'),
      routeForUrl: refuse('routeForUrl'),
      handlersFor: refuse('handlersFor'),
      componentsRendering: refuse('componentsRendering'),
      pathBetween: refuse('pathBetween'),
      excerpt: refuse('excerpt'),
      hasSymbol: refuse('hasSymbol'),
      runCodeTool,
      runCodeTools: () => {
        this.otherCalls.push('runCodeTools');
        return Promise.resolve([]);
      },
      budget: snapshot,
      describe: () => {
        this.otherCalls.push('describe');
        return describeCodeTools({ limits });
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Double: the stub context builder
// ---------------------------------------------------------------------------

/**
 * How the stub answers `buildInvestigateRequest`.
 *
 * - `mirror` reproduces the real builder's documented contract: it derives the
 *   six placeholder values from the structured input (the question from the
 *   context, the catalog verbatim, the results, the budget and the output
 *   schema's tool names), renders them into the prompt, reuses the explicit or
 *   recorded prompt version, threads the context's signal and runs the real
 *   `assertOutboundSafe` before returning the request.
 * - `fail` answers with `error` from turn `fromTurn` (1-based, default 1) on,
 *   as a refused or unbuildable request; earlier turns mirror.
 * - `throw` throws, as a builder defect.
 */
type InvestigateBuildMode =
  | { readonly kind: 'mirror' }
  | { readonly kind: 'fail'; readonly error: DebuggenError; readonly fromTurn?: number }
  | { readonly kind: 'throw'; readonly thrown: Error };

/**
 * A structured section as the real builder serialises it: plain JSON, with
 * every URL embedded in its strings masked by the builder's own
 * `redactEmbeddedUrlsDeep`.
 */
function maskedSection(value: unknown): JsonValue {
  const plain = toBoundedJson(value, {
    maxDepth: CONTEXT_LIMITS.maxDepth,
    maxNodes: CONTEXT_LIMITS.maxSectionNodes,
  });
  return redactEmbeddedUrlsDeep(plain.value ?? null);
}

/**
 * The value of each `{{placeholder}}` of `prompts/investigate/v001.md`, derived
 * from the stage's structured input the way the real builder derives it: one
 * source per key, nothing else — the question through the builder's
 * `redactQuestionText`, every serialised section through {@link maskedSection}.
 */
function placeholderValues(request: InvestigateRequestInput): Readonly<Record<string, string>> {
  const toolCatalog = maskedSection(request.toolCatalog);
  return {
    question: redactQuestionText(request.context.question, CONTEXT_LIMITS.maxQuestionChars).text,
    understanding: stableStringify(maskedSection(request.understanding)),
    toolCatalog: typeof toolCatalog === 'string' ? toolCatalog : stableStringify(toolCatalog),
    queryResults: stableStringify(maskedSection(request.queryResults)),
    remainingQueries: String(request.remainingQueries),
    outputSchema: stableStringify(request.toolNames ?? []),
  };
}

/** A {@link ContextBuilder} whose investigate request the test controls; every other stage is refused. */
class StubContextBuilder implements ContextBuilder {
  readonly limits = CONTEXT_LIMITS;
  /** Every `buildInvestigateRequest` input, in order. */
  readonly investigateCalls: InvestigateRequestInput[] = [];
  /** The placeholder values derived for every mirrored turn, in order. */
  readonly placeholders: Readonly<Record<string, string>>[] = [];
  /** Every build the stub returned. */
  readonly built: StageRequestBuild[] = [];
  /** Names of the other builder methods that were called — always expected to stay empty. */
  readonly otherCalls: string[] = [];
  readonly #mode: InvestigateBuildMode;

  constructor(mode: InvestigateBuildMode = { kind: 'mirror' }) {
    this.#mode = mode;
  }

  buildInvestigateRequest(
    request: InvestigateRequestInput,
  ): Result<StageRequestBuild, DebuggenError> {
    this.investigateCalls.push(request);
    const turn = this.investigateCalls.length;
    const mode = this.#mode;
    switch (mode.kind) {
      case 'fail':
        return turn >= (mode.fromTurn ?? 1) ? err(mode.error) : this.#mirror(request);
      case 'throw':
        throw mode.thrown;
      case 'mirror':
        return this.#mirror(request);
    }
  }

  buildStageRequest(): Result<StageRequestBuild, DebuggenError> {
    return this.#unexpected('buildStageRequest');
  }

  buildUnderstandRequest(): Result<StageRequestBuild, DebuggenError> {
    return this.#unexpected('buildUnderstandRequest');
  }

  buildPlanRequest(): Result<StageRequestBuild, DebuggenError> {
    return this.#unexpected('buildPlanRequest');
  }

  buildAnalyzeRequest(): Result<StageRequestBuild, DebuggenError> {
    return this.#unexpected('buildAnalyzeRequest');
  }

  buildFollowUpRequest(): Result<StageRequestBuild, DebuggenError> {
    return this.#unexpected('buildFollowUpRequest');
  }

  #mirror(request: InvestigateRequestInput): Result<StageRequestBuild, DebuggenError> {
    const { context } = request;
    // The real builder's version rule: an explicit version, else the one
    // recorded on the session, else the manifest's current one.
    const promptVersion =
      request.promptVersion ?? context.promptVersions[INVESTIGATE] ?? BUILDER_DEFAULT_VERSION;
    const values = placeholderValues(request);
    this.placeholders.push(values);
    const input: JsonObject = {
      remainingQueries: request.remainingQueries,
      queryResultCount: request.queryResults.length,
    };
    const prompt = [
      PROMPT_MARKER,
      `prompt version: ${promptVersion}`,
      ...Object.entries(values).map(([key, value]) => `{{${key}}} = ${value}`),
    ].join('\n');
    const signal = request.signal ?? context.signal;
    const modelRequest: ModelRequest = {
      prompt,
      input,
      metadata: { stage: INVESTIGATE, promptVersion, sessionId: context.sessionId },
      ...(signal !== undefined ? { signal } : {}),
    };
    const guard = assertOutboundSafe(modelRequest);
    if (!guard.ok) {
      return guard;
    }
    const build: StageRequestBuild = {
      request: modelRequest,
      stage: INVESTIGATE,
      promptVersion,
      truncated: [],
      bytes: Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(JSON.stringify(input), 'utf8'),
    };
    this.built.push(build);
    return ok(build);
  }

  #unexpected(method: string): Result<StageRequestBuild, DebuggenError> {
    this.otherCalls.push(method);
    return err(new DebuggenError('INTERNAL', `The investigate stage must not call ${method}.`));
  }
}

// ---------------------------------------------------------------------------
// Double: the recording progress emitter
// ---------------------------------------------------------------------------

/** One recorded progress call. `message` is present only when the caller passed one. */
interface ProgressCall {
  readonly method: keyof SessionProgress;
  readonly sessionId: string;
  readonly stage?: ProgressStage;
  readonly message?: string;
  readonly failure?: SessionFailure;
  readonly findings?: InvestigationFindings;
}

/** Whether every progress method succeeds, answers `Err`, or throws. */
type ProgressBehaviour = 'ok' | 'err' | 'throw';

/** The code of the progress double's own failures. */
const PROGRESS_FAILURE_CODE = 'STORE_ERROR';

/**
 * A {@link SessionProgress} that records every call and answers per its
 * behaviour. It has no method that changes a session's status, because the
 * real emitter has none either; what the stage can call is exactly this set.
 */
class RecordingProgress implements SessionProgress {
  readonly calls: ProgressCall[] = [];
  readonly #behaviour: ProgressBehaviour;

  constructor(behaviour: ProgressBehaviour = 'ok') {
    this.#behaviour = behaviour;
  }

  /** The recorded method names, in call order. */
  get methods(): readonly string[] {
    return this.calls.map((call) => call.method);
  }

  emit(sessionId: string, row: ProgressRow): Result<SessionProgressPayload, DebuggenError> {
    this.calls.push({ method: 'emit', sessionId, stage: row.stage, message: row.message });
    return this.#answer(sessionId, row.stage, row.status);
  }

  stageStarted(
    sessionId: string,
    stage: ProgressStage,
    message?: string,
  ): Result<SessionProgressPayload, DebuggenError> {
    this.calls.push({
      method: 'stageStarted',
      sessionId,
      stage,
      ...(message !== undefined ? { message } : {}),
    });
    return this.#answer(sessionId, stage, RUNNING);
  }

  stageCompleted(
    sessionId: string,
    stage: ProgressStage,
    message?: string,
  ): Result<SessionProgressPayload, DebuggenError> {
    this.calls.push({
      method: 'stageCompleted',
      sessionId,
      stage,
      ...(message !== undefined ? { message } : {}),
    });
    return this.#answer(sessionId, stage, DONE);
  }

  stageFailed(
    sessionId: string,
    failure: SessionFailure,
  ): Result<SessionProgressPayload, DebuggenError> {
    this.calls.push({ method: 'stageFailed', sessionId, stage: failure.stage, failure });
    return this.#answer(sessionId, failure.stage, FAILED);
  }

  finding(
    sessionId: string,
    stage: ProgressStage,
    message: string,
  ): Result<SessionProgressPayload, DebuggenError> {
    this.calls.push({ method: 'finding', sessionId, stage, message });
    return this.#answer(sessionId, stage, DONE);
  }

  reportInvestigation(
    sessionId: string,
    findings: InvestigationFindings,
  ): Result<readonly SessionProgressPayload[], DebuggenError> {
    this.calls.push({ method: 'reportInvestigation', sessionId, stage: INVESTIGATE, findings });
    return this.#answerMany();
  }

  reportInstrumentation(
    sessionId: string,
  ): Result<readonly SessionProgressPayload[], DebuggenError> {
    this.calls.push({ method: 'reportInstrumentation', sessionId });
    return this.#answerMany();
  }

  readyToCapture(sessionId: string): Result<SessionProgressPayload, DebuggenError> {
    this.calls.push({ method: 'readyToCapture', sessionId });
    return this.#answer(sessionId, INVESTIGATE, DONE);
  }

  #failure(): DebuggenError {
    if (this.#behaviour === 'throw') {
      throw new Error('The progress double was told to throw.');
    }
    return new DebuggenError(PROGRESS_FAILURE_CODE, 'The progress double was told to fail.');
  }

  #answer(
    sessionId: string,
    stage: ProgressStage,
    status: ProgressStatus,
  ): Result<SessionProgressPayload, DebuggenError> {
    if (this.#behaviour !== 'ok') {
      return err(this.#failure());
    }
    return ok({ sessionId, stage, status, message: 'row recorded by the progress double' });
  }

  #answerMany(): Result<readonly SessionProgressPayload[], DebuggenError> {
    return this.#behaviour === 'ok' ? ok([]) : err(this.#failure());
  }
}

// ---------------------------------------------------------------------------
// Fixture builders: the session record, the stage context, the harness
// ---------------------------------------------------------------------------

/** A stored session record for one question, in the status the investigate stage runs under. */
function sessionRecord(
  question: string,
  promptVersions: SessionRecord['promptVersions'],
): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    projectName: PROJECT_NAME,
    devServerUrl: DEV_SERVER_URL,
    createdAt: FIXED_EPOCH_MS,
    updatedAt: FIXED_EPOCH_MS,
    status: 'investigating',
    question,
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions,
    provider: { id: 'deterministic' },
  };
}

/** What a test may vary about a stage context. */
interface ContextOptions {
  readonly question?: string | undefined;
  readonly promptVersions?: SessionRecord['promptVersions'] | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** A stage context and the probes planted in it. */
interface ContextFixture {
  readonly context: PipelineStageContext;
  /** The stored record the context was built from, deeply frozen. */
  readonly session: SessionRecord;
  /** A snapshot of the record taken before any run. */
  readonly sessionSnapshot: string;
  /** Every read of the code handles; the stage must leave it empty. */
  readonly codeReads: readonly string[];
  /** The context's own session-bound logger. */
  readonly contextLog: CapturedLogger;
  /** The injected clock. */
  readonly now: Mock<() => number>;
}

/**
 * A minimal valid {@link PipelineStageContext}: an absolute POSIX project
 * root, the question copied from a deeply frozen stored record, tripwire code
 * handles, the recorded prompt versions, a capturing logger, a stepping clock
 * and an optional signal.
 */
function stageContext(options: ContextOptions = {}): ContextFixture {
  const question = options.question ?? BASE_QUESTION;
  const session = deepFreeze(sessionRecord(question, options.promptVersions ?? {}));
  const codeReads: string[] = [];
  const contextLog = capturedLogger();
  const now = steppingClock();
  const context: PipelineStageContext = Object.freeze({
    sessionId: session.id,
    session,
    projectRoot: session.projectRoot,
    question: session.question,
    code: tripwireCodeHandles(codeReads),
    promptVersions: session.promptVersions,
    logger: contextLog.logger,
    now,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  return {
    context,
    session,
    sessionSnapshot: stableStringify(session),
    codeReads,
    contextLog,
    now,
  };
}

/** What a test may vary about the stage's collaborators. */
interface HarnessOptions {
  readonly respond?: Responder | undefined;
  readonly tools?: ScriptedToolsOptions | undefined;
  readonly mode?: InvestigateBuildMode | undefined;
  readonly progress?: ProgressBehaviour | undefined;
  readonly maxRepairs?: number | undefined;
  readonly limits?: Partial<CodeToolLimits> | undefined;
}

/** The stage under test with its doubles. Built fresh for every test; nothing is shared. */
interface Harness {
  readonly provider: ScriptedProvider;
  readonly tools: ScriptedToolsFactory;
  readonly builder: StubContextBuilder;
  readonly progress: RecordingProgress;
  /** The logger injected as `deps.logger`. */
  readonly log: CapturedLogger;
  run(
    context: PipelineStageContext,
    input?: InvestigateStageInput,
  ): Promise<Result<InvestigateStageResult, DebuggenError>>;
}

function harness(options: HarnessOptions = {}): Harness {
  const provider = new ScriptedProvider(options.respond ?? queued());
  const tools = new ScriptedToolsFactory(options.tools);
  const builder = new StubContextBuilder(options.mode);
  const progress = new RecordingProgress(options.progress);
  const log = capturedLogger();
  const deps: InvestigateStageDeps = {
    contextBuilder: builder,
    provider,
    progress,
    logger: log.logger,
    createTools: tools.create,
    ...(options.maxRepairs !== undefined ? { maxRepairs: options.maxRepairs } : {}),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
  };
  const stage = createInvestigateStage(deps);
  return {
    provider,
    tools,
    builder,
    progress,
    log,
    run: (context, input = { understanding: UNSEEDED_UNDERSTANDING }) => stage.run(context, input),
  };
}

/** The builder input of turn `turn` (1-based). */
function turnInput(fixture: Harness, turn: number): InvestigateRequestInput {
  return at(fixture.builder.investigateCalls, turn - 1);
}

/** The placeholder values the stub derived on turn `turn` (1-based). */
function turnPlaceholders(fixture: Harness, turn: number): Readonly<Record<string, string>> {
  return at(fixture.builder.placeholders, turn - 1);
}

/** Every log record either logger of a run captured. */
function allRecords(fixture: Harness, context: ContextFixture): readonly LogRecord[] {
  return [...fixture.log.records, ...context.contextLog.records];
}

/** The `remainingQueries` the builder received, turn by turn. */
function remainingByTurn(fixture: Harness): readonly number[] {
  return fixture.builder.investigateCalls.map((call) => call.remainingQueries);
}

/** The `details.reason` of an error, when it is a string. */
function reasonOf(error: DebuggenError): unknown {
  return error.details?.['reason'];
}

// ---------------------------------------------------------------------------
// Guard fixtures: bounds read from their single definitions
// ---------------------------------------------------------------------------

/** One own property of an unknown value, or `undefined`; never invokes anything but a plain read. */
function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

/** The `maxLength` the imported `relevantFileSchema` states for one of its string fields. */
function relevantFileMaxLength(field: 'file' | 'symbol' | 'reason'): number {
  const rendered: unknown = relevantFileSchema.toJSONSchema();
  const maxLength = fieldOf(fieldOf(fieldOf(rendered, 'properties'), field), 'maxLength');
  if (typeof maxLength !== 'number') {
    throw new Error(`relevantFileSchema no longer states a length bound for ${field}.`);
  }
  return maxLength;
}

/** The shortlist ceiling, from the session record's schema. */
const MAX_SHORTLIST = sessionShortlistBound();

/** The flow-list ceiling and the longest flow line, as the `{{outputSchema}}` document states them. */
const MAX_FLOWS = CONTEXT_LIMITS.maxListItems;
const MAX_FLOW_CHARS = CONTEXT_LIMITS.maxStringChars;

const MAX_FILE_CHARS = relevantFileMaxLength('file');
const MAX_SYMBOL_CHARS = relevantFileMaxLength('symbol');
const MAX_REASON_CHARS = relevantFileMaxLength('reason');

/** A labelled guard input. */
type GuardCase = readonly [label: string, value: unknown];

/** A null-prototype copy of `source`: same own data, no `Object.prototype`. */
function nullPrototypeCopy(source: object): object {
  const copy: object = { ...source };
  Reflect.setPrototypeOf(copy, null);
  return copy;
}

/** A class instance holding valid-looking fields. */
class InvestigationHolder {
  readonly relevantFiles: readonly RelevantFile[] = [];
  readonly flows: readonly CodeFlow[] = [];
}

/** Values the guard must accept. */
const ACCEPTED: readonly GuardCase[] = [
  ['the reference investigation', VALID_INVESTIGATION],
  ['an entry without the optional symbol', withoutFirstEntryKey('symbol')],
  ['empty shortlist and flow lists', { relevantFiles: [], flows: [] }],
  ['the lowest relevance score (0)', withFirstEntry({ score: 0 })],
  ['the highest relevance score (1)', withFirstEntry({ score: 1 })],
  ['a reason at the schema bound', withFirstEntry({ reason: 'r'.repeat(MAX_REASON_CHARS) })],
  ['a symbol at the schema bound', withFirstEntry({ symbol: 's'.repeat(MAX_SYMBOL_CHARS) })],
  ['a shortlist at the session bound', { relevantFiles: shortlistOf(MAX_SHORTLIST), flows: [] }],
  [
    'a flow list at the output-schema bound',
    {
      relevantFiles: [],
      flows: Array.from({ length: MAX_FLOWS }, (_unused, index) => `flow ${String(index)}`),
    },
  ],
  ['a flow at the longest line', { relevantFiles: [], flows: ['f'.repeat(MAX_FLOW_CHARS)] }],
  ['a deeply frozen investigation', deepFreeze(withTopLevel({}))],
];

/** Not a plain JSON object at all. */
const NOT_PLAIN_OBJECTS: readonly GuardCase[] = [
  ['null', null],
  ['undefined', undefined],
  ['an array', [VALID_INVESTIGATION]],
  ['a string', JSON.stringify(VALID_INVESTIGATION)],
  ['a number', 42],
  ['a boolean', true],
  ['a Date', new Date(FIXED_EPOCH_MS)],
  ['a Map', new Map([['relevantFiles', []]])],
  ['a null-prototype object', nullPrototypeCopy({ relevantFiles: [], flows: [] })],
  ['a class instance', new InvestigationHolder()],
];

/** The shortlist is missing, of the wrong type, or too long. */
const BAD_SHORTLISTS: readonly GuardCase[] = [
  ['relevantFiles missing', withoutTopLevelKey('relevantFiles')],
  ['relevantFiles null', withTopLevel({ relevantFiles: null })],
  ['relevantFiles an object', withTopLevel({ relevantFiles: {} })],
  ['relevantFiles a string', withTopLevel({ relevantFiles: CHART_FILE })],
  [
    'relevantFiles past the session bound',
    withTopLevel({ relevantFiles: shortlistOf(MAX_SHORTLIST + 1) }),
  ],
];

/** A shortlist element that is not an entry, or lacks a required field. */
const BAD_ENTRIES: readonly GuardCase[] = [
  ['an element that is null', withFirstEntryReplaced(null)],
  ['an element that is a string', withFirstEntryReplaced(CHART_FILE)],
  ['an element that is a number', withFirstEntryReplaced(1)],
  ['an element that is an array', withFirstEntryReplaced([CHART_FILE, 'reason', 1])],
  [
    'an element with a null prototype',
    withFirstEntryReplaced(nullPrototypeCopy({ file: CHART_FILE, reason: 'r', score: 1 })),
  ],
  ['an element without file', withoutFirstEntryKey('file')],
  ['an element without reason', withoutFirstEntryKey('reason')],
  ['an element without score', withoutFirstEntryKey('score')],
];

/** File values the imported path predicate refuses. */
const UNSAFE_PATHS: readonly GuardCase[] = [
  ['an absolute POSIX path', `/srv/observatory/${CHART_FILE}`],
  ['a leading traversal', '../outside/plot.ts'],
  ['a traversal that escapes after normalisation', 'src/../../outside/plot.ts'],
  ['backslash separators', CHART_FILE.replaceAll('/', '\\')],
  ['a drive-letter path', `C:/observatory/${CHART_FILE}`],
  ['a UNC path', '//fileserver/share/plot.ts'],
  ['an empty string', ''],
  ['whitespace only', '   '],
  ['a control character', `src/panels/Star${String.fromCharCode(0)}Chart.tsx`],
];

/** File values that fail for a reason other than the path predicate. */
const BAD_FILE_VALUES: readonly GuardCase[] = [
  ['a number', 42],
  ['null', null],
  ['a path past the schema length bound', `src/${'d'.repeat(MAX_FILE_CHARS)}.ts`],
];

/** Scores outside the permitted range or of the wrong type. */
const BAD_SCORES: readonly GuardCase[] = [
  ['a numeric string', '0.9'],
  ['null', null],
  ['a boolean', true],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['just below 0', -0.001],
  ['just above 1', 1.001],
  ['a very large number', Number.MAX_VALUE],
];

/** Reasons that are blank, too long or not text. */
const BAD_REASONS: readonly GuardCase[] = [
  ['an empty string', ''],
  ['whitespace only', ' \n\t '],
  ['one character past the schema bound', 'r'.repeat(MAX_REASON_CHARS + 1)],
  ['a number', 42],
  ['null', null],
];

/** Symbols that are present but not a valid name. */
const BAD_SYMBOLS: readonly GuardCase[] = [
  ['a number', 42],
  ['null', null],
  ['a boolean', false],
  ['an array', [CHART_COMPONENT]],
  ['an empty string', ''],
  ['a multi-line value', `${CHART_COMPONENT}\n${MATH_SYMBOL}`],
  ['one character past the schema bound', 's'.repeat(MAX_SYMBOL_CHARS + 1)],
];

/** Flow lists that are missing, of the wrong type, or hold a bad line. */
const BAD_FLOWS: readonly GuardCase[] = [
  ['flows missing', withoutTopLevelKey('flows')],
  ['flows null', withTopLevel({ flows: null })],
  ['flows a string', withTopLevel({ flows: 'press → request' })],
  ['flows an object', withTopLevel({ flows: {} })],
  [
    'a structured flow object',
    withTopLevel({ flows: [{ from: CHART_COMPONENT, to: MATH_SYMBOL }] }),
  ],
  ['a flow that is a number', withTopLevel({ flows: [7] })],
  ['a flow that is null', withTopLevel({ flows: [null] })],
  ['a flow that is a nested list', withTopLevel({ flows: [['press', 'request']] })],
  ['an empty flow line', withTopLevel({ flows: [''] })],
  ['a whitespace-only flow line', withTopLevel({ flows: ['  \t '] })],
  ['a flow line past the bound', withTopLevel({ flows: ['f'.repeat(MAX_FLOW_CHARS + 1)] })],
  [
    'a flow list past the bound',
    withTopLevel({
      flows: Array.from({ length: MAX_FLOWS + 1 }, (_unused, index) => `flow ${String(index)}`),
    }),
  ],
];

/** Keys the artifact does not declare, at either level. */
const UNKNOWN_KEYS: readonly GuardCase[] = [
  ['an unknown top-level key', withTopLevel({ notes: 'extra commentary' })],
  [
    'a query batch field beside the artifact',
    withTopLevel({ [INVESTIGATE_QUERY_BATCH_FIELD]: [FIND_CHART] }),
  ],
  ['an unknown key in a shortlist entry', withFirstEntry({ confidence: 0.5 })],
  ['a location key in a shortlist entry', withFirstEntry({ line: 12 })],
];

/** A shortlist with a hole where an entry should be. */
function sparseShortlist(): unknown {
  const relevantFiles: unknown[] = [...VALID_INVESTIGATION.relevantFiles];
  relevantFiles.length = relevantFiles.length + 1;
  return { relevantFiles, flows: [] };
}

/** An investigation whose own key is not enumerable. */
function nonEnumerableFlows(): unknown {
  const value: Record<string, unknown> = { relevantFiles: [] };
  Object.defineProperty(value, 'flows', { value: [], enumerable: false });
  return value;
}

/** An investigation carrying a symbol-keyed property. */
function symbolKeyed(): unknown {
  return { relevantFiles: [], flows: [], [Symbol('hidden')]: true };
}

/** Structural oddities JSON never produces. */
const STRUCTURAL_ODDITIES: readonly GuardCase[] = [
  ['a shortlist with a hole', sparseShortlist()],
  ['a non-enumerable own key', nonEnumerableFlows()],
  ['a symbol-keyed property', symbolKeyed()],
];

/** Every rejection table, for the guard/schema agreement check. */
const ALL_REJECTED: readonly GuardCase[] = [
  ...NOT_PLAIN_OBJECTS,
  ...BAD_SHORTLISTS,
  ...BAD_ENTRIES,
  ...UNSAFE_PATHS.map(([label, file]): GuardCase => [label, withFirstEntry({ file })]),
  ...BAD_FILE_VALUES.map(([label, file]): GuardCase => [label, withFirstEntry({ file })]),
  ...BAD_SCORES.map(([label, score]): GuardCase => [label, withFirstEntry({ score })]),
  ...BAD_REASONS.map(([label, reason]): GuardCase => [label, withFirstEntry({ reason })]),
  ...BAD_SYMBOLS.map(([label, symbol]): GuardCase => [label, withFirstEntry({ symbol })]),
  ...BAD_FLOWS,
  ...UNKNOWN_KEYS,
  ...STRUCTURAL_ODDITIES,
];

/** The guard and the schema both refuse `value`. */
function expectRejected(value: unknown): void {
  expect(isCodeInvestigation(value)).toBe(false);
  expect(codeInvestigationSchema.safeParse(value).success).toBe(false);
}

/** The accepted value, narrowed; a test failure when the guard refuses it. */
function narrowed(value: unknown): CodeInvestigation {
  if (!isCodeInvestigation(value)) {
    throw new Error('Expected the guard to accept the fixture.');
  }
  return value;
}

/** A value nested `depth` levels deep under `key`. */
function nestedObject(depth: number, key: string): unknown {
  let value: unknown = { leaf: true };
  for (let level = 0; level < depth; level += 1) {
    value = { [key]: value };
  }
  return value;
}

/** A list nested `depth` levels deep. */
function nestedList(depth: number): unknown {
  let value: unknown = [];
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

// ===========================================================================
// The suites
// ===========================================================================

describe('the harness', () => {
  it('uses fixtures the real schemas accept, and the investigate member of the imported stage vocabulary', () => {
    expect(PROGRESS_STAGES.indexOf(INVESTIGATE)).toBe(1);
    expect(INVESTIGATE).toBe('investigate');
    expect(problemUnderstandingSchema.safeParse(UNSEEDED_UNDERSTANDING).success).toBe(true);
    expect(problemUnderstandingSchema.safeParse(SEEDED_UNDERSTANDING).success).toBe(true);
    expect(parseSessionRecord(sessionRecord(BASE_QUESTION, {})).ok).toBe(true);
    expect(isCodeInvestigation(VALID_INVESTIGATION)).toBe(true);
    for (const name of CODE_TOOL_NAMES) {
      expect(parseCodeToolRequest(VALID_PROPOSALS[name]).ok, name).toBe(true);
    }
  });

  it('has a stub builder that runs the real outbound guard', () => {
    const accepted = new StubContextBuilder().buildInvestigateRequest({
      context: stageContext().context,
      understanding: UNSEEDED_UNDERSTANDING,
      toolCatalog: describeCodeTools(),
      queryResults: [],
      remainingQueries: CODE_TOOL_LIMITS.maxCallsPerStage,
    });
    expect(accepted.ok).toBe(true);

    // A credential in the question is redacted before rendering, as the real builder does, so
    // it builds; a credential in a source excerpt is never scrubbed, so the guard refuses it.
    const question = `Why does ${ASSEMBLED_BEARER} fail?`;
    const redacted = new StubContextBuilder().buildInvestigateRequest({
      context: stageContext({ question }).context,
      understanding: UNSEEDED_UNDERSTANDING,
      toolCatalog: describeCodeTools(),
      queryResults: [],
      remainingQueries: CODE_TOOL_LIMITS.maxCallsPerStage,
    });
    expect(redacted.ok).toBe(true);
    expect(redacted.ok ? redacted.value.request.prompt : '').not.toContain(
      ASSEMBLED_BEARER.slice(ASSEMBLED_BEARER.indexOf(' ') + 1),
    );

    const refused = new StubContextBuilder().buildInvestigateRequest({
      context: stageContext().context,
      understanding: UNSEEDED_UNDERSTANDING,
      toolCatalog: describeCodeTools(),
      queryResults: [{ result: { text: `const key = "${ASSEMBLED_BEARER}";` } }],
      remainingQueries: CODE_TOOL_LIMITS.maxCallsPerStage,
    });
    expect(refused.ok).toBe(false);
  });

  it('has a scripted executor that flags a request the parser did not produce', async () => {
    const tools = new ScriptedToolsFactory();
    const executor = tools.create({ handles: stageContext().context.code });
    await executor.runCodeTool({ tool: 'findByName', name: `  ${CHART_COMPONENT}  ` });
    await executor.runCodeTool({ tool: 'notATool' });
    const normalised = parseCodeToolRequest(FIND_CHART);
    expect(normalised.ok).toBe(true);
    if (normalised.ok) {
      await executor.runCodeTool(normalised.value);
    }
    expect(tools.unparsed).toHaveLength(2);
    expect(tools.executed).toHaveLength(3);
  });
});

describe('the CodeInvestigation guard (no validation library in the stage: pinned with accept and reject cases)', () => {
  describe('accepts a valid artifact', () => {
    it.each(ACCEPTED)('%s', (_label, value) => {
      expect(isCodeInvestigation(value)).toBe(true);
      expect(codeInvestigationSchema.safeParse(value).success).toBe(true);
    });
  });

  describe('conforms to the imported relevantFileSchema (the SessionRecord.relevantFiles contract)', () => {
    it.each(ACCEPTED)(
      '%s: every entry, the list and a whole session record parse',
      (_label, value) => {
        const investigation = narrowed(value);
        for (const entry of investigation.relevantFiles) {
          expect(relevantFileSchema.safeParse(entry).success).toBe(true);
        }
        expect(
          sessionRecordSchema.shape.relevantFiles.safeParse(investigation.relevantFiles).success,
        ).toBe(true);
        const stored: SessionRecord = {
          ...sessionRecord(BASE_QUESTION, {}),
          relevantFiles: investigation.relevantFiles.map((entry) => ({ ...entry })),
        };
        expect(parseSessionRecord(stored).ok).toBe(true);
      },
    );

    it('decides a file exactly as the imported path predicate and schema together do', () => {
      const candidates: readonly string[] = [
        CHART_FILE,
        `./${CHART_FILE}`,
        'src//panels/StarChartPanel.tsx',
        'src/panels/../lib/orbit-math.ts',
        ...UNSAFE_PATHS.map(([, file]) => (typeof file === 'string' ? file : '')),
        `src/${'d'.repeat(MAX_FILE_CHARS)}.ts`,
      ];
      for (const file of candidates) {
        const entry = { file, reason: 'A candidate module.', score: 0.5 };
        const expected = isSafeRelativePath(file) && relevantFileSchema.safeParse(entry).success;
        expect(isCodeInvestigation({ relevantFiles: [entry], flows: [] }), file).toBe(expected);
      }
    });
  });

  describe('rejects a value that is not a plain JSON object', () => {
    it.each(NOT_PLAIN_OBJECTS)('%s', (_label, value) => {
      expectRejected(value);
    });
  });

  describe('rejects a missing, mistyped or over-long shortlist', () => {
    it.each(BAD_SHORTLISTS)('%s', (_label, value) => {
      expectRejected(value);
    });
  });

  describe('rejects a shortlist element that is not an entry or lacks a required field', () => {
    it.each(BAD_ENTRIES)('%s', (_label, value) => {
      expectRejected(value);
    });
  });

  describe('rejects a file the imported path predicate refuses', () => {
    it.each(UNSAFE_PATHS)('%s', (_label, file) => {
      expect(typeof file === 'string' && isSafeRelativePath(file)).toBe(false);
      expectRejected(withFirstEntry({ file }));
    });
  });

  describe('rejects a file value of the wrong type or length', () => {
    it.each(BAD_FILE_VALUES)('%s', (_label, file) => {
      expectRejected(withFirstEntry({ file }));
    });
  });

  describe('rejects a score that is not a finite number in 0..1', () => {
    it.each(BAD_SCORES)('%s', (_label, score) => {
      expectRejected(withFirstEntry({ score }));
    });
  });

  describe('rejects a blank, over-long or non-text reason', () => {
    it.each(BAD_REASONS)('%s', (_label, reason) => {
      expectRejected(withFirstEntry({ reason }));
    });
  });

  describe('rejects a symbol that is present but not a valid name', () => {
    it.each(BAD_SYMBOLS)('%s', (_label, symbol) => {
      expectRejected(withFirstEntry({ symbol }));
    });
  });

  describe('rejects a missing, mistyped or malformed flow list', () => {
    it.each(BAD_FLOWS)('%s', (_label, value) => {
      expectRejected(value);
    });
  });

  describe('rejects a key the artifact does not declare, at either level', () => {
    it.each(UNKNOWN_KEYS)('%s', (_label, value) => {
      expectRejected(value);
    });
  });

  describe('rejects structural oddities JSON never produces', () => {
    it.each(STRUCTURAL_ODDITIES)('%s', (_label, value) => {
      expectRejected(value);
    });
  });

  describe('is total: adversarial input answers false and never throws', () => {
    it('a cyclic investigation, a cyclic list and a cyclic entry', () => {
      const cyclicTop: Record<string, unknown> = { relevantFiles: [], flows: [] };
      cyclicTop['self'] = cyclicTop;
      const cyclicList: unknown[] = [];
      cyclicList.push(cyclicList);
      const cyclicEntry: Record<string, unknown> = { file: CHART_FILE, reason: 'r', score: 1 };
      cyclicEntry['self'] = cyclicEntry;
      for (const value of [
        cyclicTop,
        { relevantFiles: cyclicList, flows: [] },
        { relevantFiles: [], flows: cyclicList },
        { relevantFiles: [cyclicEntry], flows: [] },
      ]) {
        expect(() => isCodeInvestigation(value)).not.toThrow();
        expectRejected(value);
      }
    });

    it('a throwing getter, which is never invoked', () => {
      const getter = vi.fn((): unknown => {
        throw new Error('The getter must not run.');
      });
      const topLevel: Record<string, unknown> = { flows: [] };
      Object.defineProperty(topLevel, 'relevantFiles', { get: getter, enumerable: true });
      const entry: Record<string, unknown> = { reason: 'r', score: 1 };
      Object.defineProperty(entry, 'file', { get: getter, enumerable: true });
      for (const value of [topLevel, { relevantFiles: [entry], flows: [] }]) {
        expect(() => isCodeInvestigation(value)).not.toThrow();
        expect(isCodeInvestigation(value)).toBe(false);
      }
      expect(getter).not.toHaveBeenCalled();
    });

    it('a proxy whose every trap throws, and a revoked proxy', () => {
      const hostile = new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('getPrototypeOf trap');
          },
          ownKeys: () => {
            throw new Error('ownKeys trap');
          },
          getOwnPropertyDescriptor: () => {
            throw new Error('getOwnPropertyDescriptor trap');
          },
          get: () => {
            throw new Error('get trap');
          },
          has: () => {
            throw new Error('has trap');
          },
        },
      );
      const revocable = Proxy.revocable({ relevantFiles: [], flows: [] }, {});
      revocable.revoke();
      for (const value of [hostile, revocable.proxy, { relevantFiles: [hostile], flows: [] }]) {
        expect(() => isCodeInvestigation(value)).not.toThrow();
        expect(isCodeInvestigation(value)).toBe(false);
      }
    });

    it('very deep nesting', () => {
      const deepEntry = nestedObject(10_000, 'file');
      const deepList = nestedList(10_000);
      for (const value of [
        deepEntry,
        { relevantFiles: [deepEntry], flows: [] },
        { relevantFiles: deepList, flows: [] },
        { relevantFiles: [], flows: [deepList] },
      ]) {
        expect(() => isCodeInvestigation(value)).not.toThrow();
        expectRejected(value);
      }
    });

    it('very long strings', () => {
      const huge = 'x'.repeat(1_000_000);
      for (const value of [
        withFirstEntry({ reason: huge }),
        withFirstEntry({ file: `src/${huge}.ts` }),
        withFirstEntry({ symbol: huge }),
        withTopLevel({ flows: [huge] }),
        withTopLevel({ [huge]: true }),
      ]) {
        expect(() => isCodeInvestigation(value)).not.toThrow();
        expectRejected(value);
      }
    });
  });

  describe('narrows only what it has checked (no `as` escape)', () => {
    it('refuses values that satisfy the static type but violate a runtime bound', () => {
      const outOfRangeScore: CodeInvestigation = {
        relevantFiles: [{ file: CHART_FILE, reason: 'Starts the plot request.', score: 7 }],
        flows: [],
      };
      const absoluteFile: CodeInvestigation = {
        relevantFiles: [
          { file: `/srv/${CHART_FILE}`, reason: 'Starts the plot request.', score: 0.5 },
        ],
        flows: [],
      };
      const blankFlow: CodeInvestigation = { relevantFiles: [], flows: ['   '] };
      const blankReason: CodeInvestigation = {
        relevantFiles: [{ file: CHART_FILE, reason: '  ', score: 0.5 }],
        flows: [],
      };
      for (const value of [outOfRangeScore, absoluteFile, blankFlow, blankReason]) {
        expectRejected(value);
      }
    });

    it('narrows decoded input to the artifact type', () => {
      const decoded: unknown = JSON.parse(JSON.stringify(VALID_INVESTIGATION));
      expect(isCodeInvestigation(decoded)).toBe(true);
      const investigation = narrowed(decoded);
      const files: readonly RelevantFile[] = investigation.relevantFiles;
      const flows: readonly CodeFlow[] = investigation.flows;
      expect(files).toStrictEqual(VALID_INVESTIGATION.relevantFiles);
      expect(flows).toStrictEqual(VALID_INVESTIGATION.flows);
    });
  });

  describe('is wired to codeInvestigationSchema', () => {
    it('the schema accepts exactly what the guard accepts, across every fixture', () => {
      for (const [label, value] of [...ACCEPTED, ...ALL_REJECTED]) {
        expect(codeInvestigationSchema.safeParse(value).success, label).toBe(
          isCodeInvestigation(value),
        );
      }
    });

    it('a schema rejection names the artifact and quotes no rejected value', () => {
      const parsed = codeInvestigationSchema.safeParse(
        withFirstEntry({ reason: SENTINEL, score: 3 }),
      );
      expect(parsed.success).toBe(false);
      const issues = JSON.stringify(parsed.error?.issues ?? []);
      expect(issues).toContain('CodeInvestigation');
      expect(issues).not.toContain(SENTINEL);
    });

    it('the schema passes an accepted value through unchanged', () => {
      const parsed = codeInvestigationSchema.safeParse(VALID_INVESTIGATION);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toStrictEqual(VALID_INVESTIGATION);
    });
  });
});

// ---------------------------------------------------------------------------
// Loop fixtures
// ---------------------------------------------------------------------------

/** The graph nodes the scripted `findByName` results name in the evidence tests. */
const RESOLVED_NODES: readonly ScriptedNode[] = [
  { kind: 'component', name: CHART_COMPONENT, file: CHART_FILE },
  { kind: 'component', name: UNRELATED_COMPONENT, file: UNRELATED_FILE },
  { kind: 'handler', name: 'onPlotPress', file: CHART_FILE },
  { kind: 'api-route', name: ROUTE_PATH, file: SERVICE_FILE },
  { kind: 'db-call', name: 'readingStore.query', file: SERVICE_FILE },
  { kind: 'symbol', name: MATH_SYMBOL, file: MATH_FILE },
];

/**
 * The path a scripted `pathBetween` result returns: the steps of
 * {@link VALID_INVESTIGATION}'s flow, in its order, each one of
 * {@link RESOLVED_NODES}. Executing {@link TRACE_FLOW} is what links the flow's
 * consecutive steps; finding each step by name alone does not.
 */
const VALID_FLOW_PATH: readonly ScriptedNode[] = [
  { kind: 'component', name: CHART_COMPONENT, file: CHART_FILE },
  { kind: 'handler', name: 'onPlotPress', file: CHART_FILE },
  { kind: 'api-route', name: ROUTE_PATH, file: SERVICE_FILE },
  { kind: 'symbol', name: MATH_SYMBOL, file: MATH_FILE },
];

/** The proposal that traces {@link VALID_FLOW_PATH}: the chart component to the math symbol. */
const TRACE_FLOW: unknown = VALID_PROPOSALS.pathBetween;

/**
 * A script that answers `findByName` with {@link RESOLVED_NODES}, `pathBetween`
 * with {@link VALID_FLOW_PATH} and an excerpt with `text`.
 */
function resolvingScript(text: string): ToolScript {
  return (request) => {
    switch (request.tool) {
      case 'excerpt':
        return excerptOutcome(request, text);
      case 'pathBetween':
        return pathOutcome(request, VALID_FLOW_PATH);
      default:
        return matchesOutcome(request, RESOLVED_NODES);
    }
  };
}

/** The parser-normalised form of a valid proposal, or a test failure. */
function expectRequest(proposal: unknown): CodeToolRequest {
  const parsed = parseCodeToolRequest(proposal, resolveCodeToolLimits());
  if (!parsed.ok) {
    throw new Error(`Expected a valid proposal: ${parsed.error.message}`);
  }
  return parsed.value;
}

/** `count` copies of `outcome`. */
function repeated(outcome: ScriptedOutcome, count: number): readonly ScriptedOutcome[] {
  return Array.from({ length: count }, () => outcome);
}

/** A reply the reply schema refuses: neither a batch nor an investigation. */
const SHAPELESS_REPLY = answer({ notes: 'I would rather describe the code in prose.' });

/**
 * A proposal the reply schema admits — a well-typed call of a catalogued tool —
 * whose value the parser refuses: the name is blank once trimmed. Structural
 * defects are the reply schema's and are repaired; value defects like this one
 * are the parser's, and become evidence charged to the query budget.
 */
const BLANK_NAME_PROPOSAL = { tool: 'findByName', name: '   ' };

describe('the propose→execute loop', () => {
  describe('the happy path', () => {
    it('turns a scripted sequence of proposals into a validated investigation', async () => {
      const excerptText = `export function ${CHART_COMPONENT}() { return null; }`;
      const fixture = harness({
        respond: queued(
          answer(batch(FIND_CHART, TRACE_FLOW)),
          answer(batch(VALID_PROPOSALS.excerpt)),
          answer(VALID_INVESTIGATION),
        ),
        tools: { script: resolvingScript(excerptText) },
      });
      const probe = stageContext();
      const result = expectOk(await fixture.run(probe.context));

      expect(result.investigation).toStrictEqual(VALID_INVESTIGATION);
      expect(Object.isFrozen(result.investigation)).toBe(true);
      expect(Object.isFrozen(result.investigation.relevantFiles)).toBe(true);
      expect(result.promptVersion).toBe(BUILDER_DEFAULT_VERSION);
      expect(result.repairs).toBe(0);

      expect(result.toolRuns.map((run) => run.request?.tool)).toStrictEqual([
        'findByName',
        'pathBetween',
        'excerpt',
      ]);
      expect(at(result.toolRuns, 0).outcome).toStrictEqual(
        matchesOutcome(expectRequest(FIND_CHART), RESOLVED_NODES),
      );
      expect(at(result.toolRuns, 1).outcome).toStrictEqual(
        pathOutcome(expectRequest(TRACE_FLOW), VALID_FLOW_PATH),
      );
      expect(at(result.toolRuns, 2).outcome).toStrictEqual(
        excerptOutcome(expectRequest(VALID_PROPOSALS.excerpt), excerptText),
      );

      expect(fixture.provider.structuredCalls).toHaveLength(3);
      expect(fixture.provider.calls.every((call) => call.method === 'generateStructured')).toBe(
        true,
      );
      expect(fixture.builder.investigateCalls).toHaveLength(3);
      expect(fixture.tools.executedTools).toStrictEqual(['findByName', 'pathBetween', 'excerpt']);
      expect(fixture.tools.unparsed).toStrictEqual([]);
      expect(probe.codeReads).toStrictEqual([]);
    });

    it('sends each turn the build the builder returned for it', async () => {
      const fixture = harness({
        respond: queued(answer(batch(FIND_CHART)), answer(VALID_INVESTIGATION)),
      });
      expectOk(await fixture.run(stageContext().context));
      expect(fixture.provider.structuredCalls.map((call) => call.request)).toStrictEqual(
        fixture.builder.built.map((build) => build.request),
      );
    });

    it('reuses the prompt version the first turn loaded on every later turn', async () => {
      const fixture = harness({
        respond: queued(
          answer(batch(FIND_CHART)),
          answer(batch(FIND_CHART)),
          answer(VALID_INVESTIGATION),
        ),
      });
      const result = expectOk(await fixture.run(stageContext().context));
      expect(fixture.builder.investigateCalls.map((call) => call.promptVersion)).toStrictEqual([
        undefined,
        BUILDER_DEFAULT_VERSION,
        BUILDER_DEFAULT_VERSION,
      ]);
      expect(result.promptVersion).toBe(BUILDER_DEFAULT_VERSION);
      for (const call of fixture.provider.structuredCalls) {
        expect(call.request.metadata.promptVersion).toBe(result.promptVersion);
      }
    });

    it('passes an explicit prompt version to the first turn and reports it', async () => {
      const fixture = harness({
        respond: queued(answer(batch(FIND_CHART)), answer(VALID_INVESTIGATION)),
      });
      const result = expectOk(
        await fixture.run(stageContext().context, {
          understanding: UNSEEDED_UNDERSTANDING,
          promptVersion: 'v007',
        }),
      );
      expect(fixture.builder.investigateCalls.map((call) => call.promptVersion)).toStrictEqual([
        'v007',
        'v007',
      ]);
      expect(result.promptVersion).toBe('v007');
    });
  });

  describe('the query budget', () => {
    it('never executes more queries than the resolved limit allows', async () => {
      const limits = { maxCallsPerStage: 3 };
      const allowance = resolveCodeToolLimits(limits).maxCallsPerStage;
      const fixture = harness({ limits, respond: always(answer(batch(FIND_CHART, FIND_CHART))) });
      const error = expectErr(await fixture.run(stageContext().context));

      expect(fixture.tools.executed).toHaveLength(allowance);
      expect(fixture.provider.structuredCalls.length).toBeLessThanOrEqual(allowance + 1);
      expect(error.code).toBe('MODEL_OUTPUT_INVALID');
      expect(reasonOf(error)).toBe('query-budget-exhausted');

      const remaining = remainingByTurn(fixture);
      expect(at(remaining, 0)).toBe(allowance);
      expect(last(remaining)).toBe(0);
      for (let index = 1; index < remaining.length; index += 1) {
        expect(at(remaining, index)).toBeLessThan(at(remaining, index - 1));
      }
    });

    it('cuts a batch longer than the remaining budget to what remains', async () => {
      const limits = { maxCallsPerStage: 3 };
      const allowance = resolveCodeToolLimits(limits).maxCallsPerStage;
      const oversized = Array.from({ length: allowance + 2 }, () => FIND_CHART);
      const fixture = harness({
        limits,
        respond: queued(answer(batch(...oversized)), answer(VALID_INVESTIGATION)),
      });
      const result = expectOk(await fixture.run(stageContext().context));
      expect(fixture.tools.executed).toHaveLength(allowance);
      expect(result.toolRuns).toHaveLength(allowance);
      expect(turnInput(fixture, 2).remainingQueries).toBe(0);
    });

    it('cannot be raised above CODE_TOOL_LIMITS by an injected limit', async () => {
      const limits = { maxCallsPerStage: CODE_TOOL_LIMITS.maxCallsPerStage * 10 };
      const fixture = harness({ limits, respond: queued(answer(VALID_INVESTIGATION)) });
      expectOk(await fixture.run(stageContext().context));
      expect(turnInput(fixture, 1).remainingQueries).toBe(
        resolveCodeToolLimits(limits).maxCallsPerStage,
      );
      expect(turnInput(fixture, 1).remainingQueries).toBe(CODE_TOOL_LIMITS.maxCallsPerStage);
    });

    it('is tightened by the executor’s live allowance', async () => {
      const callsRemaining = 2;
      const fixture = harness({
        tools: { callsRemaining },
        respond: always(answer(batch(FIND_CHART))),
      });
      const error = expectErr(await fixture.run(stageContext().context));
      expect(reasonOf(error)).toBe('query-budget-exhausted');
      expect(turnInput(fixture, 1).remainingQueries).toBe(callsRemaining);
      expect(fixture.tools.executed).toHaveLength(callsRemaining);
      expect(fixture.tools.budgetReads).toBe(1);
    });
  });

  describe('validation before execution', () => {
    it('parses every proposal first and executes none whose values the parser refuses', async () => {
      // Each is a well-typed call of a catalogued tool, so the reply schema admits it;
      // what is wrong is a value, which only the parser judges.
      const blankName = { tool: 'findByName', name: '   ' };
      const unsafePath = { tool: 'findSymbol', file: `../${MATH_FILE}`, symbol: MATH_SYMBOL };
      const emptySelector = { tool: 'pathBetween', from: {}, to: { name: MATH_SYMBOL } };
      const untidy = { tool: 'findByName', name: `  ${CHART_COMPONENT}  `, verbose: true };
      const fixture = harness({
        respond: queued(
          answer(batch(blankName, unsafePath, emptySelector, untidy)),
          answer(VALID_INVESTIGATION),
        ),
      });
      const result = expectOk(await fixture.run(stageContext().context));
      const limits = resolveCodeToolLimits();

      expect(result.repairs).toBe(0);
      expect(fixture.tools.executed).toStrictEqual([expectRequest(untidy)]);
      expect(fixture.tools.unparsed).toStrictEqual([]);
      expect(result.toolRuns).toHaveLength(4);
      for (const [index, proposal] of [blankName, unsafePath, emptySelector].entries()) {
        const run = at(result.toolRuns, index);
        expect(run.index).toBe(index);
        expect(run.request).toBeUndefined();
        expect(run.outcome.ok).toBe(false);
        expect(run.outcome).toStrictEqual(parseCodeToolRequest(proposal, limits));
      }
      // The undeclared key is dropped and the name trimmed: the parser's normalised request.
      expect(at(result.toolRuns, 3).request).toStrictEqual(expectRequest(untidy));
    });

    it('refuses a structurally malformed proposal at the reply schema: the repair turn names each path, and nothing runs or is charged', async () => {
      const missingArgument = { tool: 'findByName' };
      const unknownTool = { tool: 'listRepository', path: '.' };
      const notAnObject = `findByName ${CHART_COMPONENT}`;
      const wrongType = { tool: 'findSymbol', file: MATH_FILE, symbol: 7 };
      const fixture = harness({
        respond: queued(
          answer(batch(missingArgument, unknownTool, notAnObject, wrongType)),
          answer(batch(FIND_CHART)),
          answer(VALID_INVESTIGATION),
        ),
      });
      const result = expectOk(await fixture.run(stageContext().context));
      const allowance = resolveCodeToolLimits().maxCallsPerStage;

      // One repair inside the first turn, then the build of the second turn.
      expect(result.repairs).toBe(1);
      expect(fixture.provider.structuredCalls).toHaveLength(3);
      expect(fixture.builder.investigateCalls).toHaveLength(2);
      const correction = last(at(fixture.provider.structuredCalls, 1).request.messages ?? []);
      for (const path of ['[0].name', '[1].tool', '[2]', '[3].symbol']) {
        expect(correction.content).toContain(`${INVESTIGATE_QUERY_BATCH_FIELD}${path}`);
      }

      // The refused batch never reached the parser or the executor, and cost no query.
      expect(fixture.tools.executed).toStrictEqual([expectRequest(FIND_CHART)]);
      expect(result.toolRuns.map((run) => run.request)).toStrictEqual([expectRequest(FIND_CHART)]);
      expect(turnInput(fixture, 2).remainingQueries).toBe(allowance - 1);
    });

    it('executes only parser-normalised requests whose tool is catalogued', async () => {
      const fixture = harness({
        respond: queued(
          answer(batch(...CODE_TOOL_NAMES.map((name) => VALID_PROPOSALS[name]))),
          answer(VALID_INVESTIGATION),
        ),
      });
      expectOk(await fixture.run(stageContext().context));
      expect(fixture.tools.unparsed).toStrictEqual([]);
      expect(fixture.tools.executedTools).toStrictEqual([...CODE_TOOL_NAMES]);
      expect(fixture.tools.executed).toStrictEqual(
        CODE_TOOL_NAMES.map((name) => expectRequest(VALID_PROPOSALS[name])),
      );
    });
  });

  describe('a rejection is evidence and costs budget', () => {
    it('feeds executor and parser rejections back in {{queryResults}} and charges each to {{remainingQueries}}', async () => {
      const limits = { maxCallsPerStage: 4 };
      const allowance = resolveCodeToolLimits(limits).maxCallsPerStage;
      const fixture = harness({
        limits,
        tools: {
          script: (request, call) =>
            request.tool === 'excerpt' ? err(PATH_REJECTION) : findNothing(request, call),
        },
        respond: queued(
          answer(batch(VALID_PROPOSALS.excerpt)),
          answer(batch(BLANK_NAME_PROPOSAL)),
          answer(VALID_INVESTIGATION),
        ),
      });
      const result = expectOk(await fixture.run(stageContext().context));

      const second = turnInput(fixture, 2);
      expect(second.queryResults).toHaveLength(1);
      const rejectedRun: CodeToolRun = {
        index: 0,
        request: expectRequest(VALID_PROPOSALS.excerpt),
        outcome: err(PATH_REJECTION),
      };
      expect(at(second.queryResults, 0)).toStrictEqual(rejectedRun);
      expect(second.remainingQueries).toBe(allowance - 1);
      expect(turnPlaceholders(fixture, 2)['queryResults']).toContain(
        stableStringify(PATH_REJECTION),
      );
      expect(turnPlaceholders(fixture, 2)['remainingQueries']).toBe(String(allowance - 1));

      const third = turnInput(fixture, 3);
      expect(third.queryResults).toHaveLength(2);
      expect(third.remainingQueries).toBe(allowance - 2);
      const parserRejection = parseCodeToolRequest(BLANK_NAME_PROPOSAL);
      expect(parserRejection.ok).toBe(false);
      if (!parserRejection.ok) {
        expect(turnPlaceholders(fixture, 3)['queryResults']).toContain(
          stableStringify(parserRejection.error),
        );
      }
      expect(turnPlaceholders(fixture, 3)['remainingQueries']).toBe(String(allowance - 2));

      expect(fixture.tools.executed).toHaveLength(1);
      expect(result.toolRuns.map((run) => run.outcome.ok)).toStrictEqual([false, false]);
    });

    it(
      'stops a model that only proposes malformed queries, executing none of them',
      { timeout: 10_000 },
      async () => {
        const allowance = resolveCodeToolLimits().maxCallsPerStage;
        const fixture = harness({ respond: always(answer(batch(BLANK_NAME_PROPOSAL))) });
        const error = expectErr(await fixture.run(stageContext().context));
        expect(reasonOf(error)).toBe('query-budget-exhausted');
        expect(fixture.tools.executed).toHaveLength(0);
        expect(fixture.provider.structuredCalls).toHaveLength(allowance + 1);
        expect(error.details?.['queriesRejected']).toBe(allowance);
      },
    );
  });

  describe('catalog provenance', () => {
    it('hands the builder exactly describeCodeTools() and CODE_TOOL_NAMES on every turn', async () => {
      const fixture = harness({
        respond: queued(answer(batch(FIND_CHART)), answer(VALID_INVESTIGATION)),
      });
      expectOk(await fixture.run(stageContext().context));
      const catalog = describeCodeTools();
      for (const [index, call] of fixture.builder.investigateCalls.entries()) {
        expect(call.toolCatalog).toBe(catalog);
        expect(call.toolNames).toStrictEqual(CODE_TOOL_NAMES);
        expect(turnPlaceholders(fixture, index + 1)['toolCatalog']).toBe(catalog);
      }
      for (const name of CODE_TOOL_NAMES) {
        expect(catalog).toContain(name);
      }
      expect(fixture.tools.otherCalls).toStrictEqual([]);
    });

    it('states the effective limits of a tightened run', async () => {
      const limits = { maxCallsPerStage: 5, maxExcerptsPerStage: 2 };
      const fixture = harness({ limits, respond: queued(answer(VALID_INVESTIGATION)) });
      expectOk(await fixture.run(stageContext().context));
      const catalog = turnInput(fixture, 1).toolCatalog;
      expect(catalog).toBe(describeCodeTools({ limits: resolveCodeToolLimits(limits) }));
      expect(catalog).not.toBe(describeCodeTools());
    });
  });

  describe('termination', () => {
    it(
      'settles with an Err after a bounded number of provider calls when no investigation ever comes',
      { timeout: 10_000 },
      async () => {
        const allowance = resolveCodeToolLimits().maxCallsPerStage;
        const fixture = harness({ respond: always(answer(batch(FIND_CHART))) });
        const error = expectErr(await fixture.run(stageContext().context));
        expect(error.code).toBe('MODEL_OUTPUT_INVALID');
        expect(fixture.provider.structuredCalls.length).toBeLessThanOrEqual(allowance + 1);
        expect(fixture.tools.executed.length).toBeLessThanOrEqual(allowance);
      },
    );

    it('never synthesises an investigation from the accumulated results', async () => {
      const limits = { maxCallsPerStage: 2 };
      const allowance = resolveCodeToolLimits(limits).maxCallsPerStage;
      const fixture = harness({
        limits,
        tools: { script: resolvingScript('export const unused = 1;') },
        respond: always(answer(batch(FIND_CHART))),
      });
      const error = expectErr(await fixture.run(stageContext().context));
      expect(error.code).toBe('MODEL_OUTPUT_INVALID');
      expect(reasonOf(error)).toBe('query-budget-exhausted');
      expect(Object.keys(error.details ?? {}).sort(byCodeUnit)).toStrictEqual([
        'queriesRejected',
        'queriesRun',
        'reason',
        'stage',
        'turns',
      ]);
      expect(error.details?.['queriesRun']).toBe(allowance);
      expect(serializeError(error)).not.toContain(CHART_FILE);
      expect(serializeError(error)).not.toContain(CHART_COMPONENT);
      expect(fixture.progress.methods).toStrictEqual(['stageStarted', 'stageFailed']);
    });
  });

  describe('no repository dump', () => {
    it('executes only catalogued tool names, through runCodeTool alone, and reads no code handle', async () => {
      const bogus = [
        { tool: 'listFiles', dir: 'src' },
        { tool: 'readFile', file: CHART_FILE },
        { tool: 'glob', pattern: '**/*.ts' },
        { tool: 'walkDirectory', path: '.' },
      ];
      const fixture = harness({
        respond: queued(
          answer(batch(...CODE_TOOL_NAMES.map((name) => VALID_PROPOSALS[name]))),
          answer(batch(...bogus)),
          answer(VALID_INVESTIGATION),
        ),
      });
      const probe = stageContext();
      expectOk(await fixture.run(probe.context));

      expect(fixture.tools.executedTools).toStrictEqual([...CODE_TOOL_NAMES]);
      for (const name of fixture.tools.executedTools) {
        expect(isCodeToolName(name)).toBe(true);
      }
      expect(fixture.tools.otherCalls).toStrictEqual([]);
      expect(fixture.tools.created).toHaveLength(1);
      expect(at(fixture.tools.created, 0).handles).toBe(probe.context.code);
      expect(at(fixture.tools.created, 0).limits).toStrictEqual(resolveCodeToolLimits());
      expect(probe.codeReads).toStrictEqual([]);
      expect(fixture.builder.otherCalls).toStrictEqual([]);
    });

    describe('static self-scan of investigate.ts', () => {
      const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), 'investigate.ts'),
        'utf8',
      );
      const lines = source.split('\n');

      const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
        ['a node:fs import', /node:fs/u],
        ['a child_process import', /child_process/u],
        ['a require call', /\brequire\(/u],
        ['a dynamic import', /\bimport\(/u],
        ['an eval call', /\beval\(/u],
        ['a Function constructor', /\bnew Function\b/u],
        ['any mention of zod', /\bzod\b/u],
        ['a renderer import', /@debuggen\/panel-renderer/u],
        ['a demo-app reference', /apps\/demo-app/u],
        ['an application route path', /\/api\//u],
      ];

      it.each(FORBIDDEN)('contains no %s', (label, pattern) => {
        const offending = lines
          .map((line, index) => ({ line, number: index + 1 }))
          .filter(({ line }) => pattern.test(line))
          .map(({ line, number }) => `investigate.ts:${String(number)}: ${line.trim()}`);
        expect(offending, `investigate.ts must contain no ${label}`).toStrictEqual([]);
      });

      it('spells every relative module specifier with a .js extension', () => {
        const specifiers = [
          ...source.matchAll(/(?:from|import)\s+['"](\.{1,2}\/[^'"]*)['"]/gu),
        ].map((match) => match[1] ?? '');
        expect(specifiers.length).toBeGreaterThan(0);
        const offending = specifiers.filter((specifier) => !specifier.endsWith('.js'));
        expect(offending, 'relative specifiers need an explicit .js extension').toStrictEqual([]);
      });

      it('imports no code-analysis package and no Node built-in: the executor is its only code source', () => {
        const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map(
          (match) => match[1] ?? '',
        );
        expect(specifiers.length).toBeGreaterThan(0);
        expect(specifiers.filter((specifier) => specifier.startsWith('node:'))).toStrictEqual([]);
        expect(specifiers).not.toContain('@debuggen/code-analysis');
        expect(specifiers).toContain('../tools/code-tools.js');
      });
    });
  });

  describe('seeding from the understanding', () => {
    it('runs the understanding’s seeds before the first turn and charges them to the budget', async () => {
      const allowance = resolveCodeToolLimits().maxCallsPerStage;
      const fixture = harness({ respond: queued(answer(VALID_INVESTIGATION)) });
      const result = expectOk(
        await fixture.run(stageContext().context, { understanding: SEEDED_UNDERSTANDING }),
      );
      const seeds = [
        { tool: 'findByName', name: CHART_COMPONENT },
        { tool: 'findByName', name: 'orbit' },
        { tool: 'routeForUrl', url: ROUTE_PATH },
      ];
      expect(fixture.tools.executed).toStrictEqual(seeds);
      const first = turnInput(fixture, 1);
      expect(first.queryResults).toHaveLength(seeds.length);
      expect(first.remainingQueries).toBe(allowance - seeds.length);
      expect(result.toolRuns).toHaveLength(seeds.length);
    });

    it('seeds what the understanding names specifically before the route inventory crowds it out', async () => {
      const inventory = Array.from({ length: 6 }, (_, n) => `/observatory/wing-${String(n)}`);
      const understanding: ProblemUnderstanding = {
        category: PROBLEM_CATEGORIES[0],
        signalsNeeded: [CAPTURE_SIGNALS[0]],
        // The route inventory leads, as an understanding without a selected element lists it.
        entities: [
          ...inventory.map((name) => ({ kind: 'route' as const, name })),
          { kind: 'component', name: CHART_COMPONENT },
        ],
        // Hints the inventory accounts for (its routes and their segments), and two it does not:
        // a route outside the inventory and a plain word.
        searchHints: [ROUTE_PATH, 'wing-0', 'observatory', 'orbit', ...inventory],
      };
      const fixture = harness({ respond: queued(answer(VALID_INVESTIGATION)) });
      expectOk(await fixture.run(stageContext().context, { understanding }));

      expect(fixture.tools.executed).toStrictEqual([
        { tool: 'findByName', name: CHART_COMPONENT },
        { tool: 'findByName', name: ROUTE_PATH },
        { tool: 'findByName', name: 'orbit' },
        { tool: 'routeForUrl', url: inventory[0] },
      ]);
    });

    it('derives the same seeds whatever the question’s wording', async () => {
      const wordings = [
        BASE_QUESTION,
        'star chart frozen?? after Plot orbit — why',
        '  WHY does it FREEZE  ',
      ];
      const executed: string[] = [];
      for (const question of wordings) {
        const fixture = harness({ respond: queued(answer(VALID_INVESTIGATION)) });
        expectOk(
          await fixture.run(stageContext({ question }).context, {
            understanding: SEEDED_UNDERSTANDING,
          }),
        );
        executed.push(stableStringify(fixture.tools.executed));
      }
      expect(new Set(executed).size).toBe(1);
    });

    it('spends at most half the allowance on seeds', async () => {
      const limits = { maxCallsPerStage: 2 };
      const allowance = resolveCodeToolLimits(limits).maxCallsPerStage;
      const fixture = harness({ limits, respond: queued(answer(VALID_INVESTIGATION)) });
      expectOk(await fixture.run(stageContext().context, { understanding: SEEDED_UNDERSTANDING }));
      expect(fixture.tools.executed).toHaveLength(Math.floor(allowance / 2));
      expect(turnInput(fixture, 1).remainingQueries).toBe(allowance - Math.floor(allowance / 2));
    });
  });

  describe('executor failures', () => {
    it('reports a factory that throws as an executor failure before any provider call', async () => {
      const fixture = harness({
        tools: { failCreate: true },
        respond: always(answer(VALID_INVESTIGATION)),
      });
      const error = expectErr(await fixture.run(stageContext().context));
      expect(error.code).toBe('INTERNAL');
      expect(reasonOf(error)).toBe('tool-executor-failed');
      expect(fixture.provider.calls).toHaveLength(0);
      expect(fixture.builder.investigateCalls).toHaveLength(0);
    });

    it('reports a budget that cannot be read as an executor failure', async () => {
      const fixture = harness({
        tools: { failBudget: true },
        respond: always(answer(VALID_INVESTIGATION)),
      });
      const error = expectErr(await fixture.run(stageContext().context));
      expect(reasonOf(error)).toBe('tool-executor-failed');
      expect(fixture.provider.calls).toHaveLength(0);
    });

    it('stops at an executor that throws and takes no further turn', async () => {
      const fixture = harness({
        tools: {
          script: () => {
            throw new Error('The scripted executor failed.');
          },
        },
        respond: always(answer(batch(FIND_CHART))),
      });
      const error = expectErr(await fixture.run(stageContext().context));
      expect(error.code).toBe('INTERNAL');
      expect(reasonOf(error)).toBe('tool-executor-failed');
      expect(fixture.provider.structuredCalls).toHaveLength(1);
      expect(fixture.tools.executed).toHaveLength(1);
    });
  });
});

describe('the validation gate (AAP §0.5.3)', () => {
  it('calls the provider at most DEFAULT_MAX_REPAIRS + 1 times for a turn whose reply never validates', async () => {
    const fixture = harness({ respond: always(SHAPELESS_REPLY) });
    const error = expectErr(await fixture.run(stageContext().context));
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(reasonOf(error)).toBe('schema');
    expect(error.details?.['repairs']).toBe(DEFAULT_MAX_REPAIRS);
    expect(fixture.provider.structuredCalls).toHaveLength(DEFAULT_MAX_REPAIRS + 1);
    expect(fixture.builder.investigateCalls).toHaveLength(1);
    expect(fixture.tools.executed).toHaveLength(0);
    // The stage has no fallback, so the recovery it states is a new question, not a substitute.
    expect(error.hint).toContain('no fallback');
  });

  it('spends the repair budget per turn, not per run', async () => {
    const fixture = harness({
      respond: queued(
        ...repeated(SHAPELESS_REPLY, DEFAULT_MAX_REPAIRS),
        answer(batch(FIND_CHART)),
        ...repeated(SHAPELESS_REPLY, DEFAULT_MAX_REPAIRS),
        answer(VALID_INVESTIGATION),
      ),
    });
    const result = expectOk(await fixture.run(stageContext().context));
    expect(result.repairs).toBe(2 * DEFAULT_MAX_REPAIRS);
    expect(fixture.provider.structuredCalls).toHaveLength(2 * (DEFAULT_MAX_REPAIRS + 1));
    expect(fixture.builder.investigateCalls).toHaveLength(2);
  });

  it('honours a smaller repair budget', async () => {
    const fixture = harness({ maxRepairs: 0, respond: always(SHAPELESS_REPLY) });
    const error = expectErr(await fixture.run(stageContext().context));
    expect(reasonOf(error)).toBe('schema');
    expect(fixture.provider.structuredCalls).toHaveLength(1);
  });

  it.each([DEFAULT_MAX_REPAIRS + 1, -1, 0.5, Number.NaN])(
    'refuses a repair budget of %s before anything is sent',
    async (maxRepairs) => {
      const fixture = harness({ maxRepairs, respond: always(answer(VALID_INVESTIGATION)) });
      const error = expectErr(await fixture.run(stageContext().context));
      expect(error.code).toBe('CONFIG_INVALID');
      expect(fixture.provider.calls).toHaveLength(0);
      expect(fixture.builder.investigateCalls).toHaveLength(0);
      expect(fixture.tools.created).toHaveLength(0);
      expect(fixture.progress.calls).toHaveLength(0);
    },
  );

  it('short-circuits a provider failure with exactly one call and no local retry', async () => {
    const fixture = harness({ respond: always(providerFailure(unavailableError())) });
    const error = expectErr(await fixture.run(stageContext().context));
    expect(error.code).toBe('MODEL_UNAVAILABLE');
    expect(error.message).toBe(modelUnavailableMessage(error.code));
    expect(fixture.provider.structuredCalls).toHaveLength(1);
    expect(fixture.builder.investigateCalls).toHaveLength(1);
  });

  it('short-circuits a provider failure on a later turn with exactly one call for that turn', async () => {
    const fixture = harness({
      respond: queued(answer(batch(FIND_CHART)), providerFailure(unavailableError())),
    });
    const error = expectErr(await fixture.run(stageContext().context));
    expect(error.code).toBe('MODEL_UNAVAILABLE');
    expect(fixture.provider.structuredCalls).toHaveLength(2);
    expect(fixture.builder.investigateCalls).toHaveLength(2);
  });

  it('turns a provider that throws into an Err without retrying', async () => {
    const fixture = harness({
      respond: always({ kind: 'throw', thrown: new Error('The scripted transport crashed.') }),
    });
    const error = expectErr(await fixture.run(stageContext().context));
    expect(error.code).toBe('INTERNAL');
    expect(fixture.provider.structuredCalls).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('returns Err with zero provider calls and zero executions when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = harness({ respond: always(answer(VALID_INVESTIGATION)) });
    const error = expectErr(await fixture.run(stageContext({ signal: controller.signal }).context));
    expect(error.code).toBe('INTERNAL');
    expect(reasonOf(error)).toBe('aborted');
    expect(fixture.provider.calls).toHaveLength(0);
    expect(fixture.builder.investigateCalls).toHaveLength(0);
    expect(fixture.tools.created).toHaveLength(0);
    expect(fixture.tools.executed).toHaveLength(0);
    expect(fixture.progress.calls).toHaveLength(0);
  });

  it('stops at the next proposal when the signal fires during execution', async () => {
    const controller = new AbortController();
    const fixture = harness({
      tools: {
        script: (request, call) => {
          controller.abort();
          return findNothing(request, call);
        },
      },
      respond: always(answer(batch(FIND_CHART, VALID_PROPOSALS.whoCalls))),
    });
    const error = expectErr(await fixture.run(stageContext({ signal: controller.signal }).context));
    expect(reasonOf(error)).toBe('aborted');
    expect(fixture.tools.executed).toHaveLength(1);
    expect(fixture.provider.structuredCalls).toHaveLength(1);
  });

  it('takes no further turn when the signal fires between turns', async () => {
    const controller = new AbortController();
    const fixture = harness({
      tools: {
        script: (request, call) => {
          controller.abort();
          return findNothing(request, call);
        },
      },
      respond: always(answer(batch(FIND_CHART))),
    });
    const error = expectErr(await fixture.run(stageContext({ signal: controller.signal }).context));
    expect(reasonOf(error)).toBe('aborted');
    expect(fixture.provider.structuredCalls).toHaveLength(1);
    expect(fixture.builder.investigateCalls).toHaveLength(1);
    expect(fixture.progress.methods).toStrictEqual(['stageStarted', 'stageFailed']);
  });

  it('executes nothing when the signal fires while the provider is answering', async () => {
    const controller = new AbortController();
    const fixture = harness({
      respond: () => {
        controller.abort();
        return answer(batch(FIND_CHART));
      },
    });
    const error = expectErr(await fixture.run(stageContext({ signal: controller.signal }).context));
    expect(reasonOf(error)).toBe('aborted');
    expect(fixture.provider.structuredCalls).toHaveLength(1);
    expect(fixture.tools.executed).toHaveLength(0);
  });

  it('threads the context signal into every request it sends', async () => {
    const controller = new AbortController();
    const fixture = harness({
      respond: queued(answer(batch(FIND_CHART)), answer(VALID_INVESTIGATION)),
    });
    expectOk(await fixture.run(stageContext({ signal: controller.signal }).context));
    expect(at(fixture.tools.created, 0).signal).toBe(controller.signal);
    for (const call of fixture.provider.structuredCalls) {
      expect(call.request.signal).toBe(controller.signal);
    }
  });
});

describe('the outbound guard', () => {
  it('returns the builder’s refusal unchanged and never calls the provider', async () => {
    const refusal = new DebuggenError(
      'INTERNAL',
      'The outbound guard refused the investigate request.',
      {
        details: { stage: INVESTIGATE, reason: 'outbound-guard' },
      },
    );
    const fixture = harness({
      mode: { kind: 'fail', error: refusal },
      respond: always(answer(VALID_INVESTIGATION)),
    });
    const error = expectErr(await fixture.run(stageContext().context));
    expect(error).toBe(refusal);
    expect(fixture.provider.calls).toHaveLength(0);
    expect(fixture.tools.executed).toHaveLength(0);
    const failed = last(fixture.progress.calls);
    expect(failed.method).toBe('stageFailed');
    expect(failed.failure?.code).toBe(refusal.code);
  });

  it('stops before the provider when a later turn’s payload is refused, leaking the token nowhere', async () => {
    const fixture = harness({
      tools: { script: (request) => excerptOutcome(request, `const key = "${ASSEMBLED_BEARER}";`) },
      respond: queued(answer(batch(VALID_PROPOSALS.excerpt)), answer(VALID_INVESTIGATION)),
    });
    const probe = stageContext();
    const error = expectErr(await fixture.run(probe.context));
    expect(fixture.builder.investigateCalls).toHaveLength(2);
    expect(fixture.builder.built).toHaveLength(1);
    expect(fixture.provider.structuredCalls).toHaveLength(1);
    const bearerBody = ASSEMBLED_BEARER.slice(7);
    expect(serializeError(error)).not.toContain(bearerBody);
    for (const record of allRecords(fixture, probe)) {
      expect(serializeRecord(record)).not.toContain(bearerBody);
    }
  });

  it('turns a builder that throws into an Err without calling the provider', async () => {
    const fixture = harness({
      mode: { kind: 'throw', thrown: new Error('The builder crashed.') },
      respond: always(answer(VALID_INVESTIGATION)),
    });
    const error = expectErr(await fixture.run(stageContext().context));
    expect(error.code).toBe('INTERNAL');
    expect(fixture.provider.calls).toHaveLength(0);
  });
});

describe('grounding: the investigation keeps only what executed queries returned (AAP §0.4.2)', () => {
  /** A file, symbol and flow step no scripted result ever names. */
  const INVENTED_FILE = 'src/lib/invented-orbit-cache.ts';
  const INVENTED_SYMBOL = 'InventedOrbitCache';
  const INVENTED_STEP = 'inventedOrbitCache.warm';

  /** The completion record of a run, or a test failure. */
  function completionOf(fixture: Harness): LogRecord {
    const records = fixture.log.records.filter(
      (record) => record.message === 'Investigate stage produced a validated code investigation.',
    );
    expect(records).toHaveLength(1);
    return at(records, 0);
  }

  /**
   * Runs one batch of `queries` — by default, finding the chart by name and
   * tracing {@link VALID_FLOW_PATH} — against `script`, then answers with `reply`.
   */
  async function groundedRun(
    reply: unknown,
    script: ToolScript = resolvingScript(''),
    queries: readonly unknown[] = [FIND_CHART, TRACE_FLOW],
  ): Promise<{ readonly fixture: Harness; readonly result: InvestigateStageResult }> {
    const fixture = harness({
      respond: queued(answer(batch(...queries)), answer(reply)),
      tools: { script },
    });
    const result = expectOk(await fixture.run(stageContext().context));
    return { fixture, result };
  }

  it('removes a syntactically valid file that no executed query returned', async () => {
    const invented = {
      file: INVENTED_FILE,
      symbol: INVENTED_SYMBOL,
      reason: 'Caches every projected orbit.',
      score: 0.95,
    };
    const reply = {
      ...VALID_INVESTIGATION,
      relevantFiles: [invented, ...VALID_INVESTIGATION.relevantFiles],
    };
    // Well-formed: the guard and every relevant-file rule accept it.
    expect(isCodeInvestigation(reply)).toBe(true);
    expect(relevantFileSchema.safeParse(invented).success).toBe(true);

    const { fixture, result } = await groundedRun(reply);

    expect(result.investigation).toStrictEqual(VALID_INVESTIGATION);
    expect(completionOf(fixture).fields).toMatchObject({
      relevantFileCount: VALID_INVESTIGATION.relevantFiles.length,
      removedFileCount: 1,
      strippedSymbolCount: 0,
      removedFlowCount: 0,
    });
    // The findings the progress rows are built from list the grounded shortlist only.
    expect(at(fixture.progress.calls, 1).findings?.relevantFiles).toStrictEqual(
      VALID_INVESTIGATION.relevantFiles,
    );
  });

  it('strips a symbol no result placed in a grounded file, keeping the file, its reason and its score', async () => {
    const reply = withFirstEntry({ symbol: INVENTED_SYMBOL });
    const { fixture, result } = await groundedRun(reply);

    const [first, ...rest] = VALID_INVESTIGATION.relevantFiles;
    expect(result.investigation.relevantFiles).toStrictEqual([
      { file: CHART_FILE, reason: first?.reason, score: first?.score },
      ...rest,
    ]);
    expect(Object.keys(at(result.investigation.relevantFiles, 0))).not.toContain('symbol');
    expect(completionOf(fixture).fields).toMatchObject({
      removedFileCount: 0,
      strippedSymbolCount: 1,
    });
  });

  it('removes a prose, invented or unconnected flow and keeps every flow whose steps were returned and linked', async () => {
    const grounded = [
      // The traced path itself, with its route step method-qualified.
      ...VALID_INVESTIGATION.flows,
      // A file and a declaration the path placed in it, in the ASCII arrow spelling.
      `${CHART_FILE} -> ${CHART_COMPONENT}`,
      // A method-qualified route step is linked as its route path.
      `GET ${ROUTE_PATH} -> ${MATH_SYMBOL}`,
      // A link has no direction: one hop of the path, written against it.
      `${MATH_SYMBOL} → ${ROUTE_PATH}`,
      // A single step asserts no connection; being returned is enough.
      CHART_COMPONENT,
      SERVICE_FILE,
    ];
    const ungrounded = [
      `${CHART_COMPONENT} press → plot request → plot-service → ${MATH_SYMBOL}`,
      `${CHART_COMPONENT} → ${INVENTED_STEP}`,
      `POST /observatory/invented → ${MATH_SYMBOL}`,
      `FETCH ${ROUTE_PATH} → ${MATH_SYMBOL}`,
      `${CHART_COMPONENT} → → ${MATH_SYMBOL}`,
      `${CHART_COMPONENT} →`,
      // Every step below was returned, but no executed relationship joins the pair.
      `${CHART_FILE} -> ${SERVICE_FILE}`,
      `${ROUTE_PATH} → readingStore.query`,
      `${UNRELATED_COMPONENT} → ${MATH_SYMBOL}`,
      // Both ends are on the path, but not adjacent: the step between them is skipped.
      `${CHART_COMPONENT} → ${MATH_SYMBOL}`,
    ];
    const reply = { ...VALID_INVESTIGATION, flows: [...ungrounded, ...grounded] };
    expect(isCodeInvestigation(reply)).toBe(true);

    const { fixture, result } = await groundedRun(reply);

    expect(result.investigation.flows).toStrictEqual(grounded);
    expect(result.investigation.relevantFiles).toStrictEqual(VALID_INVESTIGATION.relevantFiles);
    expect(completionOf(fixture).fields).toMatchObject({
      flowCount: grounded.length,
      removedFlowCount: ungrounded.length,
    });
  });

  /** The route handler the handler-centred scripts report, declared in the service file. */
  const HANDLER_SYMBOL = 'readReadings';

  /** A source location in `file`, as the code graph reports one. */
  const locationIn = (file: string) =>
    ({ file, line: 3, column: 1, resolvedBy: 'code-graph', confidence: 1 }) as const;

  /** The counts of a found, uncut result carrying one item. */
  const FOUND_ONE = { found: true, total: 1, returned: 1, truncated: false, clamped: [] } as const;

  /**
   * Answers `findSymbol` with the math symbol's declaration, `handlersFor` with
   * a `GET` handler {@link HANDLER_SYMBOL} located in the service file, and
   * `whoCalls` with {@link HANDLER_SYMBOL} calling the requested symbol; any
   * other request finds nothing.
   */
  const handlerScript: ToolScript = (request) => {
    switch (request.tool) {
      case 'findSymbol': {
        const result: CodeToolResult = {
          ...FOUND_ONE,
          tool: request.tool,
          request,
          payload: {
            nodeId: `symbol:${MATH_FILE}#${MATH_SYMBOL}`,
            kind: 'symbol',
            name: MATH_SYMBOL,
            file: MATH_FILE,
            location: locationIn(MATH_FILE),
            symbol: MATH_SYMBOL,
            exported: true,
          },
        };
        return ok(result);
      }
      case 'handlersFor': {
        const result: CodeToolResult = {
          ...FOUND_ONE,
          tool: request.tool,
          request,
          payload: [{ method: 'GET', symbol: HANDLER_SYMBOL, location: locationIn(SERVICE_FILE) }],
        };
        return ok(result);
      }
      case 'whoCalls': {
        const result: CodeToolResult = {
          ...FOUND_ONE,
          tool: request.tool,
          request,
          payload: [
            {
              caller: {
                nodeId: `symbol:${SERVICE_FILE}#${HANDLER_SYMBOL}`,
                kind: 'symbol',
                name: HANDLER_SYMBOL,
                file: SERVICE_FILE,
                location: locationIn(SERVICE_FILE),
              },
              via: 'edge',
              location: locationIn(SERVICE_FILE),
            },
          ],
        };
        return ok(result);
      }
      default:
        return ok(emptyResult(request));
    }
  };

  /** A shortlist of the math symbol and the route handler, both of which {@link handlerScript} places. */
  const HANDLER_SHORTLIST: readonly RelevantFile[] = [
    { file: MATH_FILE, symbol: MATH_SYMBOL, reason: 'Computes the points.', score: 1 },
    { file: SERVICE_FILE, symbol: HANDLER_SYMBOL, reason: 'Serves the readings.', score: 0.5 },
  ];

  it('grounds a symbol a findSymbol match or a route handler reports for its file', async () => {
    const reply: CodeInvestigation = {
      relevantFiles: [...HANDLER_SHORTLIST],
      flows: [HANDLER_SYMBOL, MATH_SYMBOL],
    };
    const { fixture, result } = await groundedRun(reply, handlerScript, [
      VALID_PROPOSALS.findSymbol,
      VALID_PROPOSALS.handlersFor,
    ]);
    expect(result.investigation).toStrictEqual(reply);
    expect(completionOf(fixture).fields).toMatchObject({
      removedFileCount: 0,
      strippedSymbolCount: 0,
      removedFlowCount: 0,
    });
  });

  it('removes a flow between two names that separate lookups found but no executed query related', async () => {
    // Both components and the symbol are findByName hits; nothing relates them.
    const reply: CodeInvestigation = {
      relevantFiles: [...VALID_INVESTIGATION.relevantFiles],
      flows: [`${UNRELATED_COMPONENT} → ${MATH_SYMBOL}`, UNRELATED_COMPONENT, MATH_SYMBOL],
    };
    const { fixture, result } = await groundedRun(reply, resolvingScript(''), [FIND_CHART]);
    expect(result.investigation.flows).toStrictEqual([UNRELATED_COMPONENT, MATH_SYMBOL]);
    expect(result.investigation.relevantFiles).toStrictEqual(VALID_INVESTIGATION.relevantFiles);
    expect(completionOf(fixture).fields).toMatchObject({ flowCount: 2, removedFlowCount: 1 });
  });

  it('keeps the same flow once an executed pathBetween result joins the two names', async () => {
    const joined: readonly ScriptedNode[] = [
      { kind: 'component', name: UNRELATED_COMPONENT, file: UNRELATED_FILE },
      { kind: 'symbol', name: MATH_SYMBOL, file: MATH_FILE },
    ];
    const script: ToolScript = (request) =>
      request.tool === 'pathBetween'
        ? pathOutcome(request, joined)
        : matchesOutcome(request, RESOLVED_NODES);
    const traceUnrelated = {
      tool: 'pathBetween',
      from: { name: UNRELATED_COMPONENT },
      to: { name: MATH_SYMBOL },
    };
    const reply: CodeInvestigation = {
      relevantFiles: [...VALID_INVESTIGATION.relevantFiles],
      flows: [`${UNRELATED_COMPONENT} → ${MATH_SYMBOL}`],
    };
    const { fixture, result } = await groundedRun(reply, script, [FIND_CHART, traceUnrelated]);
    expect(result.investigation).toStrictEqual(reply);
    expect(completionOf(fixture).fields).toMatchObject({ flowCount: 1, removedFlowCount: 0 });
  });

  it('links a caller to the symbol an executed whoCalls request named, and a route handler to nothing', async () => {
    const reply: CodeInvestigation = {
      relevantFiles: [...HANDLER_SHORTLIST],
      flows: [`${HANDLER_SYMBOL} → ${MATH_SYMBOL}`],
    };

    // A handler's symbol and a separately resolved declaration: each is evidenced,
    // but handlersFor names no relationship between them, so the flow goes.
    const unlinked = await groundedRun(reply, handlerScript, [
      VALID_PROPOSALS.findSymbol,
      VALID_PROPOSALS.handlersFor,
    ]);
    expect(unlinked.result.investigation).toStrictEqual({ ...reply, flows: [] });
    expect(completionOf(unlinked.fixture).fields).toMatchObject({
      removedFileCount: 0,
      strippedSymbolCount: 0,
      removedFlowCount: 1,
    });

    // The executed whoCalls request named the math symbol, and its result names
    // the handler as a caller: that relationship keeps the flow.
    const linked = await groundedRun(reply, handlerScript, [
      VALID_PROPOSALS.findSymbol,
      VALID_PROPOSALS.whoCalls,
    ]);
    expect(linked.result.investigation).toStrictEqual(reply);
    expect(completionOf(linked.fixture).fields).toMatchObject({ removedFlowCount: 0 });
  });

  it('links a rendering parent to the component an executed componentsRendering request named', async () => {
    const script: ToolScript = (request) => {
      if (request.tool !== 'componentsRendering') {
        return matchesOutcome(request, RESOLVED_NODES);
      }
      const parent: ScriptedNode = {
        kind: 'component',
        name: UNRELATED_COMPONENT,
        file: UNRELATED_FILE,
      };
      const result: CodeToolResult = {
        ...FOUND_ONE,
        tool: request.tool,
        request,
        payload: [{ component: scriptedMatch(parent), location: locationIn(UNRELATED_FILE) }],
      };
      return ok(result);
    };
    const reply: CodeInvestigation = {
      relevantFiles: [...VALID_INVESTIGATION.relevantFiles],
      flows: [
        `${UNRELATED_COMPONENT} → ${CHART_COMPONENT}`,
        `${UNRELATED_COMPONENT} → onPlotPress`,
      ],
    };
    const { fixture, result } = await groundedRun(reply, script, [
      FIND_CHART,
      VALID_PROPOSALS.componentsRendering,
    ]);
    // The parent renders the chart component the request named — not its handler.
    expect(result.investigation.flows).toStrictEqual([
      `${UNRELATED_COMPONENT} → ${CHART_COMPONENT}`,
    ]);
    expect(completionOf(fixture).fields).toMatchObject({ removedFlowCount: 1 });
  });

  it('links a resolved route path to its route node and to its module file', async () => {
    const routeNode: ScriptedNode = { kind: 'api-route', name: ROUTE_PATH, file: SERVICE_FILE };
    const routeLocation = { ...locationIn(SERVICE_FILE), resolvedBy: 'route-map' } as const;
    const script: ToolScript = (request) => {
      if (request.tool !== 'routeForUrl') {
        return matchesOutcome(request, RESOLVED_NODES);
      }
      const result: CodeToolResult = {
        ...FOUND_ONE,
        tool: request.tool,
        request,
        payload: {
          match: {
            entry: {
              routePath: ROUTE_PATH,
              router: 'app',
              kind: 'route-handler',
              file: SERVICE_FILE,
              segments: [],
              dynamicParams: [],
              isCatchAll: false,
              isOptionalCatchAll: false,
              methods: ['GET'],
              location: routeLocation,
            },
            params: {},
            pathname: ROUTE_PATH,
          },
          routePath: ROUTE_PATH,
          router: 'app',
          kind: 'route-handler',
          methods: ['GET'],
          params: {},
          file: SERVICE_FILE,
          location: routeLocation,
          node: scriptedMatch(routeNode),
        },
      };
      return ok(result);
    };
    const reply: CodeInvestigation = {
      relevantFiles: [...VALID_INVESTIGATION.relevantFiles],
      flows: [`GET ${ROUTE_PATH} → ${SERVICE_FILE}`, `${ROUTE_PATH} → ${MATH_FILE}`],
    };
    const { fixture, result } = await groundedRun(reply, script, [
      FIND_CHART,
      VALID_PROPOSALS.routeForUrl,
    ]);
    expect(result.investigation.flows).toStrictEqual([`GET ${ROUTE_PATH} → ${SERVICE_FILE}`]);
    expect(completionOf(fixture).fields).toMatchObject({ removedFlowCount: 1 });
  });

  it('removes a flow whose middle pair is unlinked although both outer pairs are linked', async () => {
    // File → component and symbol → file are containments the path showed; the
    // component and the math symbol are two hops apart on it, so not linked.
    const reply: CodeInvestigation = {
      relevantFiles: [...VALID_INVESTIGATION.relevantFiles],
      flows: [
        `${CHART_FILE} → ${CHART_COMPONENT} → ${MATH_SYMBOL} → ${MATH_FILE}`,
        `${CHART_FILE} → ${CHART_COMPONENT} → onPlotPress → GET ${ROUTE_PATH} → ${MATH_SYMBOL} → ${MATH_FILE}`,
      ],
    };
    const { fixture, result } = await groundedRun(reply);
    expect(result.investigation.flows).toStrictEqual([at(reply.flows, 1)]);
    expect(completionOf(fixture).fields).toMatchObject({ flowCount: 1, removedFlowCount: 1 });
  });

  it('does not join the neighbours of a missing or malformed path node', async () => {
    // Index 1 is a hole and index 3 a node without a file: neither is evidence,
    // and neither may be skipped over to join the nodes either side of it.
    const nodes = [scriptedMatch(at(VALID_FLOW_PATH, 0))];
    nodes[2] = scriptedMatch(at(VALID_FLOW_PATH, 2));
    nodes[3] = { ...scriptedMatch(at(VALID_FLOW_PATH, 1)), file: '' };
    nodes[4] = scriptedMatch(at(VALID_FLOW_PATH, 3));
    nodes[5] = scriptedMatch({
      kind: 'component',
      name: UNRELATED_COMPONENT,
      file: UNRELATED_FILE,
    });
    expect(1 in nodes).toBe(false);
    const script: ToolScript = (request) => {
      if (request.tool !== 'pathBetween') {
        return matchesOutcome(request, RESOLVED_NODES);
      }
      const result: CodeToolResult = {
        ...FOUND_ONE,
        tool: request.tool,
        request,
        payload: { nodes, edges: [], depth: 5, undirected: false, truncated: false },
      };
      return ok(result);
    };
    const reply: CodeInvestigation = {
      relevantFiles: [...VALID_INVESTIGATION.relevantFiles],
      flows: [
        // Across the hole.
        `${CHART_COMPONENT} → ${ROUTE_PATH}`,
        // Across the malformed node.
        `${ROUTE_PATH} → ${MATH_SYMBOL}`,
        // Two well-formed neighbours: the path is still read.
        `${MATH_SYMBOL} → ${UNRELATED_COMPONENT}`,
      ],
    };
    const { fixture, result } = await groundedRun(reply, script);
    expect(result.investigation.flows).toStrictEqual([`${MATH_SYMBOL} → ${UNRELATED_COMPONENT}`]);
    expect(completionOf(fixture).fields).toMatchObject({ removedFlowCount: 2 });
  });

  it('grounds a declaration a result locates, and a flow of a path’s node names joined by arrows', async () => {
    // The shape the real code graph returns: a route node whose location names the exported
    // handler declaration (`GET`) that serves it, and the rules provider's flow label for the path.
    const node = (
      kind: 'component' | 'api-route' | 'symbol',
      name: string,
      file: string,
      symbol: string,
    ) => ({
      nodeId: `${kind}:${file}#${name}`,
      kind,
      name,
      file,
      location: {
        file,
        line: 2,
        column: 1,
        symbol,
        resolvedBy: 'code-graph' as const,
        confidence: 0.85,
      },
    });
    const nodes = [
      node('component', CHART_COMPONENT, CHART_FILE, CHART_COMPONENT),
      node('api-route', ROUTE_PATH, SERVICE_FILE, 'GET'),
      node('symbol', MATH_SYMBOL, MATH_FILE, MATH_SYMBOL),
    ] as const;
    const script: ToolScript = (request) => {
      if (request.tool !== 'pathBetween') {
        return ok(emptyResult(request));
      }
      const result: CodeToolResult = {
        tool: request.tool,
        request,
        found: true,
        total: 1,
        returned: 1,
        truncated: false,
        clamped: [],
        payload: { nodes, edges: [], depth: 2, undirected: false, truncated: false },
      };
      return ok(result);
    };
    const reply: CodeInvestigation = {
      relevantFiles: [
        { file: SERVICE_FILE, symbol: 'GET', reason: 'Serves the readings.', score: 0.7 },
        { file: MATH_FILE, symbol: MATH_SYMBOL, reason: 'Computes the points.', score: 0.6 },
      ],
      flows: [nodes.map((entry) => entry.name).join(' → ')],
    };
    const fixture = harness({
      respond: queued(answer(batch(VALID_PROPOSALS.pathBetween)), answer(reply)),
      tools: { script },
    });
    const result = expectOk(await fixture.run(stageContext().context));
    expect(result.investigation).toStrictEqual(reply);
    expect(completionOf(fixture).fields).toMatchObject({
      removedFileCount: 0,
      strippedSymbolCount: 0,
      removedFlowCount: 0,
    });
  });

  it('keeps an evidenced file written in a cosmetic spelling, under its normal spelling', async () => {
    const reply = withFirstEntry({ file: `./${CHART_FILE}` });
    expect(isCodeInvestigation(reply)).toBe(true);
    const { result } = await groundedRun(reply);
    expect(result.investigation).toStrictEqual(VALID_INVESTIGATION);
  });

  it('grounds nothing from a rejection or an empty result: an unevidenced investigation is an empty, valid result', async () => {
    const fixture = harness({
      respond: queued(
        answer(batch(VALID_PROPOSALS.excerpt, FIND_CHART)),
        answer(VALID_INVESTIGATION),
      ),
      tools: {
        script: (request, call) =>
          request.tool === 'excerpt' ? err(PATH_REJECTION) : findNothing(request, call),
      },
    });
    const result = expectOk(await fixture.run(stageContext().context));

    expect(result.investigation).toStrictEqual({ relevantFiles: [], flows: [] });
    expect(Object.isFrozen(result.investigation)).toBe(true);
    // No second loop, no retry, no substitute: the model was asked exactly twice.
    expect(fixture.provider.structuredCalls).toHaveLength(2);
    expect(result.repairs).toBe(0);
    expect(completionOf(fixture).fields).toMatchObject({
      relevantFileCount: 0,
      flowCount: 0,
      removedFileCount: VALID_INVESTIGATION.relevantFiles.length,
      removedFlowCount: VALID_INVESTIGATION.flows.length,
    });
    expect(at(fixture.progress.calls, 1).findings?.relevantFiles).toStrictEqual([]);
  });

  it('logs what grounding removed as counts, never as a path, a symbol or a flow', async () => {
    const reply = {
      relevantFiles: [
        { file: INVENTED_FILE, reason: 'Invented.', score: 0.4 },
        { file: CHART_FILE, symbol: INVENTED_SYMBOL, reason: 'Renders the chart.', score: 0.9 },
      ],
      flows: [`${CHART_COMPONENT} → ${INVENTED_STEP}`],
    };
    const { fixture } = await groundedRun(reply);
    const fields = completionOf(fixture).fields;
    expect(fields).toMatchObject({
      removedFileCount: 1,
      strippedSymbolCount: 1,
      removedFlowCount: 1,
    });
    for (const value of Object.values(fields)) {
      expect(['number', 'string']).toContain(typeof value);
    }
    const logged = fixture.log.records.map(serializeRecord).join('\n');
    for (const fragment of [INVENTED_FILE, INVENTED_SYMBOL, INVENTED_STEP, CHART_FILE]) {
      expect(logged).not.toContain(fragment);
    }
  });
});

describe('progress rows', () => {
  it('emits the investigate header, the findings and the closing row, authoring none of their text', async () => {
    const fixture = harness({
      respond: queued(answer(batch(FIND_CHART)), answer(VALID_INVESTIGATION)),
      tools: { script: resolvingScript('') },
    });
    expectOk(await fixture.run(stageContext().context));
    expect(fixture.progress.methods).toStrictEqual([
      'stageStarted',
      'reportInvestigation',
      'stageCompleted',
    ]);
    for (const call of fixture.progress.calls) {
      expect(call.stage).toBe(INVESTIGATE);
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.message).toBeUndefined();
    }
  });

  it('reports only what executed queries resolved on the shortlist, never a name the question merely mentions', async () => {
    const fixture = harness({
      respond: queued(answer(batch(FIND_CHART)), answer(VALID_INVESTIGATION)),
      tools: { script: resolvingScript('') },
    });
    expectOk(await fixture.run(stageContext().context));
    const findings = at(fixture.progress.calls, 1).findings;
    expect(findings).toStrictEqual({
      components: [CHART_COMPONENT],
      eventHandlers: [],
      routes: [ROUTE_PATH],
      databaseDependencies: ['readingStore.query'],
      relevantFiles: VALID_INVESTIGATION.relevantFiles,
      // Each finding located where the query result placed it — the call site too, which is no
      // symbol of the shortlist.
      origins: new Map([
        [CHART_COMPONENT, CHART_FILE],
        [ROUTE_PATH, SERVICE_FILE],
        ['readingStore.query', SERVICE_FILE],
      ]),
    });
    expect(findings?.entities).toBeUndefined();
  });

  it('reports no finding for an understanding entity that no executed query resolved', async () => {
    const fixture = harness({ respond: queued(answer(VALID_INVESTIGATION)) });
    expectOk(await fixture.run(stageContext().context, { understanding: SEEDED_UNDERSTANDING }));
    const findings = at(fixture.progress.calls, 1).findings;
    expect(findings?.components).toStrictEqual([]);
    expect(findings?.routes).toStrictEqual([]);
  });

  it('closes a failed run with a failed row copied from the error', async () => {
    const fixture = harness({ respond: always(providerFailure(unavailableError())) });
    const error = expectErr(await fixture.run(stageContext().context));
    expect(fixture.progress.methods).toStrictEqual(['stageStarted', 'stageFailed']);
    expect(last(fixture.progress.calls).failure).toStrictEqual({
      stage: INVESTIGATE,
      code: error.code,
      message: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
    });
  });

  it.each<ProgressBehaviour>(['err', 'throw'])(
    'a progress emitter that answers %s does not fail the stage',
    async (behaviour) => {
      const fixture = harness({
        progress: behaviour,
        respond: queued(answer(batch(FIND_CHART, TRACE_FLOW)), answer(VALID_INVESTIGATION)),
        tools: { script: resolvingScript('') },
      });
      const result = expectOk(await fixture.run(stageContext().context));
      expect(result.investigation).toStrictEqual(VALID_INVESTIGATION);
      const warnings = fixture.log.records.filter((record) => record.level === 'warn');
      expect(warnings.map((record) => record.fields['row'])).toStrictEqual([
        'started',
        'findings',
        'completed',
      ]);
      if (behaviour === 'err') {
        for (const record of warnings) {
          expect(record.fields['code']).toBe(PROGRESS_FAILURE_CODE);
        }
      }
    },
  );
});

describe('the placeholder inputs the stage supplies', () => {
  it('matches the six keys the builder table records for prompts/investigate/v001.md', () => {
    expect([...STAGE_PLACEHOLDERS.investigate]).toStrictEqual(INVESTIGATE_PLACEHOLDER_KEYS);
  });

  it('supplies exactly one source per placeholder on every turn, and nothing else', async () => {
    const fixture = harness({
      respond: queued(answer(batch(FIND_CHART)), answer(VALID_INVESTIGATION)),
    });
    const probe = stageContext();
    expectOk(await fixture.run(probe.context));
    expect(fixture.builder.investigateCalls).toHaveLength(2);
    for (const [index, call] of fixture.builder.investigateCalls.entries()) {
      expect(Object.keys(call).sort(byCodeUnit)).toStrictEqual(INVESTIGATE_REQUEST_KEYS);
      expect(call.context).toBe(probe.context);
      expect(call.understanding).toStrictEqual(UNSEEDED_UNDERSTANDING);
      const values = turnPlaceholders(fixture, index + 1);
      expect(Object.keys(values).sort(byCodeUnit)).toStrictEqual(
        [...INVESTIGATE_PLACEHOLDER_KEYS].sort(byCodeUnit),
      );
      for (const key of INVESTIGATE_PLACEHOLDER_KEYS) {
        expect(values[key], key).not.toBe('');
      }
    }
    expect(turnPlaceholders(fixture, 1)['question']).toBe(BASE_QUESTION);
    expect(turnPlaceholders(fixture, 1)['queryResults']).toBe('[]');
    expect(turnPlaceholders(fixture, 1)['outputSchema']).toBe(stableStringify(CODE_TOOL_NAMES));
  });

  it('carries the question in the context alone, never copied into another input', async () => {
    const fixture = harness({
      respond: queued(answer(batch(FIND_CHART)), answer(VALID_INVESTIGATION)),
    });
    expectOk(await fixture.run(stageContext({ question: SENTINEL_QUESTION }).context));
    for (const values of fixture.builder.placeholders) {
      for (const [key, value] of Object.entries(values)) {
        expect(value.includes(SENTINEL), key).toBe(key === 'question');
      }
    }
  });
});

describe('side effects and determinism', () => {
  it('writes no session status and returns only the artifact, its version, its repairs and its runs', async () => {
    const fixture = harness({
      respond: queued(answer(batch(FIND_CHART)), answer(VALID_INVESTIGATION)),
    });
    const probe = stageContext();
    const result = expectOk(await fixture.run(probe.context));
    expect(stableStringify(probe.session)).toBe(probe.sessionSnapshot);
    expect(Object.keys(result).sort(byCodeUnit)).toStrictEqual([
      'investigation',
      'promptVersion',
      'repairs',
      'toolRuns',
    ]);
    expect(fixture.builder.otherCalls).toStrictEqual([]);
    expect(fixture.provider.calls.every((call) => call.method === 'generateStructured')).toBe(true);
  });

  it('reads the injected clock only to time the run', async () => {
    const fixture = harness({ respond: queued(answer(VALID_INVESTIGATION)) });
    const probe = stageContext();
    expectOk(await fixture.run(probe.context));
    expect(probe.now).toHaveBeenCalledTimes(2);
    const completed = fixture.log.records.filter((record) => record.level === 'info');
    expect(completed).toHaveLength(1);
    expect(at(completed, 0).fields['durationMs']).toBe(CLOCK_STEP_MS);
  });

  it('gives the same answer to the same inputs, run after run', async () => {
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fixture = harness({
        respond: queued(answer(batch(FIND_CHART)), answer(VALID_INVESTIGATION)),
        tools: { script: resolvingScript('') },
      });
      const result = expectOk(await fixture.run(stageContext().context));
      outcomes.push(stableStringify({ result, calls: fixture.builder.placeholders }));
    }
    expect(new Set(outcomes).size).toBe(1);
  });
});

describe('privacy of log records and errors (AAP §0.5.2)', () => {
  const excerptText = `const rows = await readingStore.query('SELECT * FROM readings WHERE sensor = $1'); // ${SENTINEL}`;
  const sentinelUrl = `http://127.0.0.1:4173${ROUTE_PATH}?sensor=${SENTINEL}`;

  /** Content that must never appear in a log record or an error. */
  const FORBIDDEN_CONTENT: readonly string[] = [
    SENTINEL,
    'SELECT',
    'http://',
    excerptText,
    PROMPT_MARKER,
    CHART_FILE,
    SERVICE_FILE,
    MATH_FILE,
  ];

  /** Asserts the forbidden content is absent from every record of both loggers. */
  function expectCleanLogs(fixture: Harness, probe: ContextFixture): void {
    const records = allRecords(fixture, probe);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      const text = serializeRecord(record);
      for (const content of FORBIDDEN_CONTENT) {
        expect(text.includes(content), `a log record carried "${content}"`).toBe(false);
      }
    }
  }

  it('a successful run logs no question, excerpt, path, URL, statement or model output', async () => {
    const investigation: CodeInvestigation = {
      relevantFiles: [
        {
          file: CHART_FILE,
          symbol: CHART_COMPONENT,
          reason: `Plots the ${SENTINEL} series.`,
          score: 0.8,
        },
        { file: SERVICE_FILE, reason: `Runs the ${SENTINEL} statement.`, score: 0.6 },
      ],
      flows: [`${SENTINEL} press → ${MATH_FILE}`],
    };
    const fixture = harness({
      tools: { script: resolvingScript(excerptText) },
      respond: queued(
        answer(batch(VALID_PROPOSALS.excerpt, { tool: 'routeForUrl', url: sentinelUrl })),
        answer(investigation),
      ),
    });
    const probe = stageContext({ question: SENTINEL_QUESTION });
    const result = expectOk(await fixture.run(probe.context));
    // The second turn carries the executed `routeForUrl` request, whose address quotes a query
    // value: it builds, and what it sends carries the parameter with its value masked.
    expect(fixture.builder.built).toHaveLength(2);
    const followUp = at(fixture.builder.built, 1).request;
    expect(turnPlaceholders(fixture, 2)['queryResults']).toContain(`${ROUTE_PATH}?sensor=?`);
    expect(followUp.prompt).toContain(`${ROUTE_PATH}?sensor=?`);
    for (const sent of [followUp.prompt, JSON.stringify(followUp.input)]) {
      expect(sent).not.toContain(`sensor=${SENTINEL}`);
    }
    expect(at(fixture.provider.structuredCalls, 1).request).toBe(followUp);
    // Only the excerpt returned anything: its file is kept without the symbol no result placed
    // there, the unreturned service file is removed, and the prose flow is removed.
    expect(result.investigation).toStrictEqual({
      relevantFiles: [{ file: CHART_FILE, reason: `Plots the ${SENTINEL} series.`, score: 0.8 }],
      flows: [],
    });
    const completed = fixture.log.records.filter(
      (record) => record.message === 'Investigate stage produced a validated code investigation.',
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.fields).toMatchObject({
      removedFileCount: 1,
      strippedSymbolCount: 1,
      removedFlowCount: 1,
    });
    expectCleanLogs(fixture, probe);
  });

  it('a reply that never validates leaks the model output into neither the error nor the logs', async () => {
    const fixture = harness({
      respond: always(answer({ [SENTINEL]: SENTINEL, notes: `${SENTINEL} ${excerptText}` })),
    });
    const probe = stageContext({ question: SENTINEL_QUESTION });
    const error = expectErr(await fixture.run(probe.context));
    for (const content of FORBIDDEN_CONTENT) {
      expect(serializeError(error).includes(content), content).toBe(false);
    }
    expectCleanLogs(fixture, probe);
  });

  it('a proposal the reply schema refuses leaks nothing of it into the error or the logs', async () => {
    const fixture = harness({
      respond: always(
        answer(batch({ tool: SENTINEL, name: SENTINEL }, { tool: 'findSymbol', symbol: SENTINEL })),
      ),
    });
    const probe = stageContext({ question: SENTINEL_QUESTION });
    const error = expectErr(await fixture.run(probe.context));
    expect(reasonOf(error)).toBe('schema');
    expect(fixture.tools.executed).toHaveLength(0);
    for (const content of FORBIDDEN_CONTENT) {
      expect(serializeError(error).includes(content), content).toBe(false);
    }
    // The repair turns name paths and rules, never the refused values.
    for (const call of fixture.provider.structuredCalls.slice(1)) {
      expect(last(call.request.messages ?? []).content).not.toContain(SENTINEL);
    }
    expectCleanLogs(fixture, probe);
  });

  it('an exhausted budget leaks no proposal into the error or the logs', async () => {
    const fixture = harness({
      limits: { maxCallsPerStage: 2 },
      respond: always(
        answer(
          batch(
            { tool: 'findSymbol', file: `../${SENTINEL}.ts`, symbol: SENTINEL },
            { tool: 'excerpt', file: CHART_FILE },
          ),
        ),
      ),
      tools: { script: (request) => excerptOutcome(request, excerptText) },
    });
    const probe = stageContext({ question: SENTINEL_QUESTION });
    const error = expectErr(await fixture.run(probe.context));
    expect(reasonOf(error)).toBe('query-budget-exhausted');
    for (const content of FORBIDDEN_CONTENT) {
      expect(serializeError(error).includes(content), content).toBe(false);
    }
    expectCleanLogs(fixture, probe);
  });

  it('an executor failure carries no payload value into the error or the logs', async () => {
    const fixture = harness({
      tools: {
        script: () => {
          throw new Error(`executor failed on ${SENTINEL} at ${CHART_FILE}`);
        },
      },
      respond: always(answer(batch(FIND_CHART))),
    });
    const probe = stageContext({ question: SENTINEL_QUESTION });
    const error = expectErr(await fixture.run(probe.context));
    for (const content of FORBIDDEN_CONTENT) {
      expect(serializeError(error).includes(content), content).toBe(false);
    }
    expectCleanLogs(fixture, probe);
  });

  it('a provider failure is re-worded to the shared sentence, dropping the transport’s text', async () => {
    const fixture = harness({
      respond: always(
        providerFailure(
          new DebuggenError('MODEL_UNAVAILABLE', `The transport choked on ${SENTINEL}.`),
        ),
      ),
    });
    const probe = stageContext({ question: SENTINEL_QUESTION });
    const error = expectErr(await fixture.run(probe.context));
    expect(error.message).toBe(modelUnavailableMessage(error.code));
    for (const content of FORBIDDEN_CONTENT) {
      expect(serializeError(error).includes(content), content).toBe(false);
    }
    expectCleanLogs(fixture, probe);
  });
});
