/**
 * Colocated suite for the rules-based provider — the behavioural half of AAP
 * §0.5.4's "No Hardcoded Behavior" guarantee.
 *
 * `./deterministic.ts` is the provider every automated test in this repository
 * runs against (`DEBUGGEN_PROVIDER=deterministic`, AAP §0.7.1 Group 0), so what
 * this file pins is what the acceptance tests of AAP §0.8.4 are allowed to
 * assume. It is also the **only** coverage the rule set in `../deterministic/`
 * gets: neither `rules.ts` nor `templates.ts` carries a suite of its own, and
 * both are exercised here through the provider's public surface.
 *
 * Five properties, one `describe` each, named so a reviewer can find them:
 *
 * 1. **schema-valid** — every stage's construction satisfies a schema shaped
 *    like the authoring schema its real caller passes in, `raw` is populated on
 *    every success, and a construction that misses the caller's schema is a
 *    terminal `Err` rather than a trimmed answer.
 * 2. **input-derived** — one structured input field moves and the specific
 *    output field that depends on it moves with it; a field removed degrades to
 *    a smaller valid answer or a typed failure, never a throw and never an
 *    `undefined` inside the output tree.
 * 3. **wording-invariant** — two requests that differ *only* in prose produce
 *    byte-identical answers, and no sentinel planted in `prompt`, `system` or
 *    `messages` reaches an output. This is the load-bearing property of the
 *    file: it is what makes "its answers vary because its inputs vary, not
 *    because it recognised a question" an assertion rather than a claim.
 * 4. **panels genuinely differ** — the same node catalog over two materially
 *    different captures lays out two materially different panels, and the
 *    overlap is exactly the summary header, the metric cards and the source
 *    links that AAP §0.6.5 permits.
 * 5. **pure** — repeat calls are byte-identical, the clock and the randomness
 *    source are proven unused, the request is not mutated, a pre-aborted signal
 *    is refused before any work, and exactly one attempt happens per call.
 *
 * ## Harness constraints this file works under
 *
 * - The Vitest project is `model-provider` in the **root** `vitest.config.ts`:
 *   node environment, `globals: false`. Every API is imported explicitly and no
 *   per-package Vitest configuration exists or may be added.
 * - The compiler project is NodeNext, so every relative import carries `.js`,
 *   and this file is type-checked by `pnpm typecheck` because the package's
 *   tsconfig `include` covers `*.test.ts`. It is unreachable from
 *   `src/index.ts`, so tsup never bundles it, and no source module imports it.
 * - **The import boundary is the reason the schemas below are local.**
 *   `@debuggen/panel-schema` and `@debuggen/instrumentation` are not
 *   dependencies of this package (AAP §0.2.2) — that is precisely why
 *   `../provider.ts` has the caller pass its schema in — so the authoring
 *   shapes of AAP §0.2.3 are mirrored here with `zod`. The mirrors are
 *   deliberately **minimal and structural**: they assert the shape a real
 *   caller requires and not every refinement it adds. Drift between a mirror
 *   and the real authoring schema is the known cost of that boundary, and
 *   keeping the mirrors small is what bounds it.
 * - No network, no SDK, no fixture files, no recorded model responses (AAP
 *   §0.2.5). Every fixture is built in code beside the expectation it drives.
 * - Fixtures are invented and generic. No demo identifier, no `/api/…` path, no
 *   secret-shaped literal and no model identifier appears anywhere below: a
 *   suite proving that the product carries no knowledge of the demo must not
 *   carry any itself.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DEBUGGEN_ERROR_CODES, DebuggenError } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import {
  COMPUTED_METRIC_IDS,
  CONFIDENCE_LEVELS,
  INSTRUMENTATION_ACTION_TYPES,
} from '../deterministic/rules.js';
import { EMPTY_CAPTURE_NOTICE } from '../deterministic/templates.js';
import { isModelProvider, modelUnavailableMessage } from '../provider.js';
import type { ModelProvider } from '../provider.js';
import { PROMPT_STAGES } from '../types.js';
import type {
  JsonObject,
  JsonValue,
  ModelRequest,
  PromptStage,
  StructuredAttempt,
  ToolDefinition,
} from '../types.js';
import { DEFAULT_PROVIDER_ID, createModelProvider, resolveProviderConfig } from '../factory.js';
import { createDeterministicProvider } from './deterministic.js';
import type { DeterministicProviderOptions } from './deterministic.js';
import { PROVIDER_IDS } from './index.js';

/* -------------------------------------------------------------------------------------------------
 * harness helpers
 * ---------------------------------------------------------------------------------------------- */

/** The provider's own identifier, which doubles as its reported model. */
const PROVIDER_ID = 'deterministic';

/** The stop reason a completed construction reports. */
const COMPLETE_STOP_REASON = 'complete';

/** The stop reason a construction that selected tools reports. */
const TOOL_CALLS_STOP_REASON = 'tool-calls';

/**
 * Builds the unit under test, failing the test rather than the suite when
 * construction is refused.
 */
function makeProvider(options?: DeterministicProviderOptions): ModelProvider {
  const created = createDeterministicProvider(options);
  if (!created.ok) {
    throw new Error(
      `the deterministic provider refused construction: ${created.error.code} ${created.error.message}`,
    );
  }
  return created.value;
}

/** The provider every property below shares; it holds no state to leak. */
const provider = makeProvider();

/** Unwraps an `Ok`, reporting the failure's code when there is one instead. */
function okValue<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`expected Ok, received Err ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/**
 * Unwraps an `Err`, reporting the value's shape when the call unexpectedly
 * succeeded.
 *
 * Typed against `Result<unknown, …>` rather than a generic so one loop can
 * check the failures of all three methods together: their success types differ,
 * and a failure is the only thing being asserted.
 */
function errorOf(result: Result<unknown, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error(`expected Err, received Ok: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

/**
 * A canonical serialization with sorted keys at every level.
 *
 * "Byte-identical" is asserted against this rather than against `JSON.stringify`
 * alone, so a difference in key *order* cannot pass for equality and a
 * difference in key *content* cannot hide behind one.
 */
function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** Recursively rebuilds plain objects with their keys in sorted order. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((member: unknown) => sortDeep(member));
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Every path inside `value` that holds `undefined`.
 *
 * A rules engine that reaches for a field its input did not carry leaks an
 * `undefined` into the answer, where it survives an in-process assertion and
 * then vanishes when the answer is serialized for the store or a prompt. This
 * finds it at the point it is produced.
 */
function undefinedPaths(value: unknown, path = '(root)'): readonly string[] {
  if (value === undefined) {
    return [path];
  }
  if (Array.isArray(value)) {
    return value.flatMap((member: unknown, index) => undefinedPaths(member, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    return Object.keys(source).flatMap((key) => undefinedPaths(source[key], `${path}.${key}`));
  }
  return [];
}

/** Narrows an unknown output tree to a plain object, failing the test otherwise. */
function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/** Narrows an unknown output member to an array, failing the test otherwise. */
function asArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected an array, received ${JSON.stringify(value)}`);
  }
  return value;
}

/** Narrows an unknown output member to a string, failing the test otherwise. */
function asString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`expected a string, received ${JSON.stringify(value)}`);
  }
  return value;
}

/* -------------------------------------------------------------------------------------------------
 * request fixtures
 *
 * Every request carries prose in all three positions a provider could copy from
 * — `prompt`, `system` and `messages` — and every piece of that prose carries a
 * sentinel. The sentinels are the instrument behind the wording-invariance and
 * prose-leakage assertions of property 3: a variant label distinguishes two
 * requests that are otherwise identical, and the base tokens are what an output
 * is required never to contain.
 * ---------------------------------------------------------------------------------------------- */

/** Planted in `ModelRequest.prompt`. */
const PROMPT_SENTINEL = 'QLMZPROMPT7451';

/** Planted in `ModelRequest.system`. */
const SYSTEM_SENTINEL = 'QLMZSYSTEM8823';

/** Planted in every `ModelRequest.messages` turn. */
const MESSAGE_SENTINEL = 'QLMZMESSAGE3190';

/** The three tokens an output must never echo, in one list for the leakage check. */
const PROSE_SENTINELS: readonly string[] = [PROMPT_SENTINEL, SYSTEM_SENTINEL, MESSAGE_SENTINEL];

/** How a request may be varied without touching its structured context. */
interface RequestOptions {
  /** Distinguishes two prose variants of one structured context. */
  readonly variant?: string;

  /** Recorded on the metadata when a call belongs to a session. */
  readonly sessionId?: string;

  /** Cancellation, used to prove a pre-aborted call does no work. */
  readonly signal?: AbortSignal;
}

/**
 * One request for `stage` over `input`, with sentinel-bearing prose.
 *
 * The prose deliberately reads like a developer's question, including words a
 * question-matching shortcut would look for, because a provider that answered
 * from prose would pass a suite whose prose was neutral.
 */
function requestFor(
  stage: PromptStage,
  input: JsonObject,
  options: RequestOptions = {},
): ModelRequest {
  const variant = options.variant ?? 'first';
  return {
    prompt: `${PROMPT_SENTINEL}-${variant}: why is this ${stage} step slow, and why does it repeat?`,
    system: `${SYSTEM_SENTINEL}-${variant}: answer only in the requested shape and cite evidence.`,
    messages: [
      {
        role: 'user',
        content: `${MESSAGE_SENTINEL}-${variant}: the developer asked about this behaviour again.`,
      },
    ],
    input,
    metadata: {
      stage,
      promptVersion: 'v001',
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
}

/* -------------------------------------------------------------------------------------------------
 * structured-context fixtures
 *
 * Shaped the way `../deterministic/rules.ts` reads a stage's context: an
 * understanding bag with a classified category and a selected target, code-graph
 * candidates with their kinds and the signals they can supply, an adapter
 * capability catalog, capture aggregates with evidence references on the nodes
 * that carry the findings, and a node catalog. Every name is invented.
 * ---------------------------------------------------------------------------------------------- */

/** A well-formed 32-hex trace identifier, which the rules validate before using. */
const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const WIDGET_FILE = 'src/widgets/kestrel-submit.tsx';
const WIDGET_SYMBOL = 'KestrelSubmit';
const FORM_FILE = 'src/widgets/kestrel-form.tsx';
const FORM_SYMBOL = 'KestrelForm';
const TILE_FILE = 'src/widgets/tally-tile.tsx';
const TILE_SYMBOL = 'TallyTile';
const ROUTE_FILE = 'src/routes/tally/handler.ts';
const ROUTE_SYMBOL = 'handleTally';
const STORE_FILE = 'src/services/tally-store.ts';
const STORE_SYMBOL = 'loadTallyRows';
const PRESS_FILE = 'src/widgets/kestrel-press.ts';
const PRESS_SYMBOL = 'onKestrelPress';

/** Evidence identifiers; each appears on the aggregate node whose finding cites it. */
const SCAN_EVENT = 'ev-scan-01';
const HANDLER_EVENT = 'ev-handler-01';
const REQUEST_EVENTS: readonly string[] = ['ev-request-01', 'ev-request-02'];
const QUERY_EVENT = 'ev-query-01';
const RENDER_EVENT = 'ev-render-01';

/** A code-graph candidate as the investigation stage receives them. */
function codeCandidate(
  file: string,
  symbol: string,
  kind: string,
  signals: readonly string[],
): JsonObject {
  return { file, symbol, kind, signals: [...signals] };
}

const COMPONENT_CANDIDATE = codeCandidate(WIDGET_FILE, WIDGET_SYMBOL, 'component', [
  'render',
  'interaction',
]);
const ROUTE_CANDIDATE = codeCandidate(ROUTE_FILE, ROUTE_SYMBOL, 'api-route', ['http.server']);
const STORE_CANDIDATE = codeCandidate(STORE_FILE, STORE_SYMBOL, 'db-call', ['db.query']);
const PRESS_CANDIDATE = codeCandidate(PRESS_FILE, PRESS_SYMBOL, 'event-handler', ['interaction']);
const TILE_CANDIDATE = codeCandidate(TILE_FILE, TILE_SYMBOL, 'component', ['render']);

/** How the understanding context may be varied. */
interface UnderstandOptions {
  /** The classified category the upstream stage carried. */
  readonly category?: string;

  /** The selected element's owner chain, outermost last. */
  readonly componentChain?: readonly string[];

  /** Omits the selected target entirely, which is the missing-optional case. */
  readonly withoutTarget?: boolean;

  /** Omits the project summary's database flag. */
  readonly withoutDatabase?: boolean;
}

/** The structured context of the problem-understanding stage. */
function understandInput(options: UnderstandOptions = {}): JsonObject {
  const chain = options.componentChain ?? [WIDGET_SYMBOL, FORM_SYMBOL];
  return {
    understanding: { categoryHint: options.category ?? 'slow-interaction' },
    ...(options.withoutTarget === true
      ? {}
      : {
          target: {
            selector: 'main form button',
            tagName: 'button',
            text: 'Run report',
            componentChain: [...chain],
          },
        }),
    projectSummary: {
      entities: [WIDGET_SYMBOL, FORM_FILE],
      hasApiRoutes: true,
      ...(options.withoutDatabase === true ? {} : { hasDatabase: true }),
      apiCallCount: 3,
    },
    signalsNeeded: ['interaction'],
  };
}

/** How the investigation context may be varied. */
interface InvestigateOptions extends UnderstandOptions {
  /** The code-graph candidates the deterministic queries returned. */
  readonly candidates?: readonly JsonObject[];

  /** Drops the flow paths, leaving candidates as the only material. */
  readonly withoutFlows?: boolean;
}

/** The structured context of the code-investigation stage. */
function investigateInput(options: InvestigateOptions = {}): JsonObject {
  const candidates = options.candidates ?? [COMPONENT_CANDIDATE, ROUTE_CANDIDATE, STORE_CANDIDATE];
  return {
    ...understandInput(options),
    candidates: [...candidates],
    ...(options.withoutFlows === true
      ? {}
      : {
          flows: [[{ symbol: WIDGET_SYMBOL }, { symbol: ROUTE_SYMBOL }, { symbol: STORE_SYMBOL }]],
        }),
  };
}

/** How the planning context may be varied. */
interface PlanOptions extends InvestigateOptions {
  /** The action types the registered adapters claim they can handle. */
  readonly claimedActionTypes?: readonly string[];

  /** The capture signals the adapters report they can supply. */
  readonly availableSignals?: readonly string[];

  /** Hypotheses carried forward from an earlier stage. */
  readonly hypotheses?: readonly string[];
}

/** The structured context of the instrumentation-planning stage. */
function planInput(options: PlanOptions = {}): JsonObject {
  const claimed = options.claimedActionTypes ?? [
    'react-render-tracking',
    'interaction-tracking',
    'server-span',
    'db-query-tracking',
    'function-timing',
  ];
  const signals = options.availableSignals ?? [
    'interaction',
    'render',
    'fetch',
    'http.server',
    'route.handler',
    'db.query',
  ];
  return {
    ...investigateInput(options),
    adapterCatalog: [
      { id: 'runtime-adapter', actionTypes: [...claimed], mode: 'runtime', signals: [...signals] },
    ],
    ...(options.hypotheses !== undefined ? { hypotheses: [...options.hypotheses] } : {}),
  };
}

/** A source location as a resolver reports it on an aggregate node. */
function sourceLocation(
  file: string,
  line: number,
  column: number,
  resolvedBy: string,
): JsonObject {
  return { file, line, column, resolvedBy, confidence: 0.8 };
}

/** How the capture aggregates handed to the analysis stage may be varied. */
interface AnalyzeOptions {
  /** Duration of the database span, in milliseconds. */
  readonly scanDurationMs?: number;

  /** Duration of the server span, in milliseconds. */
  readonly handlerDurationMs?: number;

  /** Occurrences in the duplicate request group. */
  readonly duplicateCount?: number;

  /** Renders recorded for the component. */
  readonly renderCount?: number;

  /** Reports the metrics as the list carrier instead of the map carrier. */
  readonly metricsAsList?: boolean;
}

/** The structured context of the analysis stage: redacted capture aggregates. */
function analyzeInput(options: AnalyzeOptions = {}): JsonObject {
  const scan = options.scanDurationMs ?? 640;
  const handler = options.handlerDurationMs ?? 900;
  const duplicates = options.duplicateCount ?? 4;
  const renders = options.renderCount ?? 6;
  const total = 1175;
  const metricValues: readonly (readonly [string, number])[] = [
    ['total_duration', total],
    ['frontend_duration', 120],
    ['backend_duration', handler],
    ['database_duration', scan],
    ['render_count', renders],
    ['request_count', duplicates],
    ['query_count', 3],
  ];
  const metrics: JsonValue =
    options.metricsAsList === true
      ? metricValues.map(([id, value]) => ({ id, value }))
      : Object.fromEntries(metricValues);
  return {
    aggregates: {
      traceId: TRACE_ID,
      totalDurationMs: total,
      spans: [
        {
          name: 'inventory row scan',
          duration: scan,
          tier: 'db',
          evidence: [SCAN_EVENT],
          source: sourceLocation(STORE_FILE, 42, 7, 'code-graph'),
        },
        {
          name: 'tally request handler',
          duration: handler,
          tier: 'server',
          evidence: [HANDLER_EVENT],
        },
      ],
      requests: [
        {
          endpoint: '/tally/rows',
          count: duplicates,
          windowMs: 22,
          evidence: [...REQUEST_EVENTS],
          source: sourceLocation(FORM_FILE, 84, 5, 'source-map'),
        },
      ],
      queries: [
        {
          statement: 'SELECT id FROM tally_rows WHERE bucket = $1',
          count: 3,
          evidence: [QUERY_EVENT],
          source: sourceLocation(STORE_FILE, 51, 11, 'code-graph'),
        },
      ],
      renders: [
        {
          component: WIDGET_SYMBOL,
          renderCount: renders,
          unchangedRenderCount: 4,
          renderTriggerUnknownCount: 1,
          evidence: [RENDER_EVENT],
        },
      ],
      metrics,
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * panel fixtures
 *
 * One catalog, two captures. The catalog is the whole node vocabulary of AAP
 * §0.2.3, restated locally rather than imported — `@debuggen/panel-schema` is
 * not a dependency of this package — and the *same* catalog is handed to both
 * captures on purpose: a divergence in the resulting layouts can then only come
 * from the evidence, which is the property of AAP §0.6.5 worth asserting.
 * ---------------------------------------------------------------------------------------------- */

/** Every visualization node type the renderer registry covers (AAP §0.2.3). */
const CATALOGUED_NODE_TYPES: readonly string[] = [
  'timeline',
  'waterfall',
  'eventLog',
  'metricCards',
  'flame',
  'table',
  'renderTable',
  'componentTree',
  'requestTable',
  'queryTable',
  'stateTransitions',
  'dependencyGraph',
  'sourceLink',
];

/**
 * The node types AAP §0.6.5 permits two otherwise-disjoint panels to share.
 *
 * The summary header is deliberately absent: it is not a layout node, it is
 * rendered from the specification's `summary`, so its presence is asserted
 * through that field instead of through a node type.
 */
const SHAREABLE_NODE_TYPES: readonly string[] = ['metricCards', 'sourceLink'];

/** The node catalog as the panel-generation stage receives it. */
const NODE_CATALOG: readonly JsonObject[] = [
  { type: 'timeline', sources: ['trace', 'spans'], filters: ['traceId'], reads: ['startTime'] },
  { type: 'waterfall', sources: ['spans'], filters: ['traceId'], reads: ['duration'] },
  {
    type: 'eventLog',
    sources: ['events'],
    filters: ['kinds'],
    defaultKinds: ['render', 'state', 'fetch'],
    defaultLimit: 200,
    reads: ['seq'],
  },
  { type: 'metricCards', sources: ['metrics'], reads: ['metrics'] },
  { type: 'flame', sources: ['trace'], reads: ['parentSpanId'] },
  {
    type: 'table',
    sources: ['spans'],
    defaultSort: 'duration_desc',
    defaultLimit: 25,
    reads: ['name'],
  },
  { type: 'renderTable', sources: ['renders'], defaultSort: 'count_desc', reads: ['component'] },
  { type: 'componentTree', sources: ['componentTree'], reads: ['component'] },
  { type: 'requestTable', sources: ['requests'], defaultSort: 'count_desc', reads: ['url'] },
  { type: 'queryTable', sources: ['queries'], defaultSort: 'duration_desc', reads: ['statement'] },
  { type: 'stateTransitions', sources: ['stateTransitions'], reads: ['component'] },
  { type: 'dependencyGraph', sources: ['graph'], reads: ['nodes'] },
  { type: 'sourceLink', sources: [], reads: ['source'] },
];

/** How the cross-tier latency capture may be varied. */
interface LatencyPanelOptions {
  /** Replaces the reported metric bag. */
  readonly metrics?: JsonObject;

  /** Drops the query aggregate, which is what removes the query table. */
  readonly withoutQueries?: boolean;
}

/**
 * A capture dominated by cross-tier request and query latency: a trace, spans,
 * requests, queries and duration metrics, with no render material at all.
 */
function latencyPanelInput(options: LatencyPanelOptions = {}): JsonObject {
  return {
    understanding: { categoryHint: 'slow-interaction', target: { text: 'Run report' } },
    nodeCatalog: [...NODE_CATALOG],
    aggregates: {
      traceId: TRACE_ID,
      totalDurationMs: 1175,
      trace: [
        {
          name: 'pointer press',
          duration: 1175,
          children: [{ name: 'row fetch', duration: 1100, evidence: [...REQUEST_EVENTS] }],
        },
        { name: 'commit', duration: 47, evidence: [RENDER_EVENT] },
      ],
      spans: [
        {
          name: 'inventory row scan',
          duration: 640,
          tier: 'db',
          evidence: [SCAN_EVENT],
          source: sourceLocation(STORE_FILE, 42, 7, 'code-graph'),
        },
        { name: 'tally request handler', duration: 900, tier: 'server', evidence: [HANDLER_EVENT] },
      ],
      requests: [
        { endpoint: '/tally/rows', count: 4, windowMs: 22, evidence: [...REQUEST_EVENTS] },
      ],
      ...(options.withoutQueries === true
        ? {}
        : {
            queries: [
              {
                statement: 'SELECT id FROM tally_rows WHERE bucket = $1',
                count: 3,
                evidence: [QUERY_EVENT],
              },
            ],
          }),
      metrics:
        options.metrics ??
        ({
          total_duration: 1175,
          frontend_duration: 120,
          backend_duration: 415,
          database_duration: 640,
          request_count: 4,
          query_count: 3,
        } satisfies JsonObject),
    },
  };
}

/** How the repeated-render capture may be varied. */
interface RenderPanelOptions {
  /** Replaces the reported metric bag. */
  readonly metrics?: JsonObject;
}

/**
 * A capture dominated by repeated renders with unchanged inputs: an event log,
 * render statistics, a component tree, state transitions and render metrics,
 * with no trace, span, request or query material at all.
 */
function renderPanelInput(options: RenderPanelOptions = {}): JsonObject {
  return {
    understanding: { categoryHint: 'excessive-renders', target: { text: 'Tally tile' } },
    nodeCatalog: [...NODE_CATALOG],
    aggregates: {
      traceId: TRACE_ID,
      totalDurationMs: 610,
      kindCounts: { render: 128, state: 12 },
      events: [
        { seq: 1, kind: 'render', name: TILE_SYMBOL, evidence: [RENDER_EVENT] },
        { seq: 2, kind: 'state', name: TILE_SYMBOL, evidence: ['ev-state-01'] },
      ],
      renders: [
        {
          component: TILE_SYMBOL,
          renderCount: 128,
          unchangedRenderCount: 120,
          renderTriggerUnknownCount: 2,
          evidence: [RENDER_EVENT],
          source: sourceLocation(TILE_FILE, 18, 3, 'react-owner'),
        },
      ],
      componentTree: {
        component: 'TallyBoard',
        renderCount: 4,
        children: [{ component: TILE_SYMBOL, renderCount: 128 }],
      },
      stateTransitions: [
        { component: 'TallyBoard', hookLabel: 'tick', trigger: 'timer', evidence: ['ev-state-01'] },
      ],
      metrics:
        options.metrics ??
        ({
          render_count: 128,
          unchanged_render_count: 120,
          render_trigger_unknown_count: 2,
          blocking_time: 210,
          long_task_count: 3,
        } satisfies JsonObject),
    },
  };
}

/**
 * AAP §0.5.5's "capture yielded nothing": every aggregate present and every one
 * of them empty. Present-but-empty is the shape that distinguishes a capture
 * that recorded nothing from a context that never carried a capture.
 */
function emptyCaptureInput(): JsonObject {
  return {
    understanding: { categoryHint: 'slow-interaction' },
    nodeCatalog: [...NODE_CATALOG],
    aggregates: {
      spans: [],
      renders: [],
      requests: [],
      queries: [],
      events: [],
      stateTransitions: [],
      metrics: {},
    },
  };
}

/** How the follow-up context may be varied. */
interface FollowUpOptions {
  /** Signals the new question needs. */
  readonly wantedSignals?: readonly string[];

  /** Signals the stored capture already carries. */
  readonly capturedSignals?: readonly string[];

  /** Actions the installed plan already applied, which are never re-emitted. */
  readonly installedTargets?: readonly JsonObject[];

  /** Code-graph candidates a delta action could be attached to. */
  readonly candidates?: readonly JsonObject[];

  /** Action types the adapters claim. */
  readonly claimedActionTypes?: readonly string[];
}

/** The structured context of the follow-up stage. */
function followUpInput(options: FollowUpOptions = {}): JsonObject {
  const claimed = options.claimedActionTypes ?? [
    'interaction-tracking',
    'db-query-tracking',
    'react-render-tracking',
  ];
  const installed = options.installedTargets ?? [
    { file: PRESS_FILE, symbol: PRESS_SYMBOL, type: 'interaction-tracking' },
  ];
  return {
    signalsNeeded: [...(options.wantedSignals ?? ['interaction', 'db.query', 'render'])],
    candidates: [...(options.candidates ?? [PRESS_CANDIDATE, STORE_CANDIDATE, TILE_CANDIDATE])],
    adapterCatalog: [{ id: 'runtime-adapter', actionTypes: [...claimed], mode: 'runtime' }],
    captureSummary: { capturedSignals: [...(options.capturedSignals ?? ['render'])] },
    plan: { instrumentationTargets: [...installed] },
    aggregates: {
      renders: [
        { component: TILE_SYMBOL, renderCount: 8, evidence: [RENDER_EVENT] },
        { component: WIDGET_SYMBOL, renderCount: 2, evidence: ['ev-render-02'] },
      ],
      metrics: { render_count: 10 },
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * tool fixtures
 *
 * The investigation stage offers read-only code-graph queries as tools. The
 * provider's job is selection only: `apps/local-service/src/pipeline/tools/code-tools.ts`
 * owns execution, so nothing here is ever called and no schema here is ever
 * parsed — which is what the assertions in the `callTools` section check.
 * ---------------------------------------------------------------------------------------------- */

/** One offered tool, named after a read-only graph query. */
function codeTool(name: string): ToolDefinition {
  return { name, description: `read-only code graph query: ${name}`, inputSchema: z.unknown() };
}

/** The tools an investigation turn offers, in the order the registry lists them. */
const CODE_TOOLS: readonly ToolDefinition[] = [
  codeTool('findByName'),
  codeTool('whoCalls'),
  codeTool('routeForUrl'),
  codeTool('pathBetween'),
];

/** How the tool-selecting context may be varied. */
interface ToolCallOptions {
  /** Replaces the requested calls the context carries. */
  readonly toolCalls?: readonly JsonValue[];
}

/**
 * An investigation context that asks for specific graph queries.
 *
 * The default list deliberately contains a name no definition offers and one
 * exact duplicate, so selection, rejection and de-duplication are all covered
 * by one fixture.
 */
function toolCallInput(options: ToolCallOptions = {}): JsonObject {
  const requested: readonly JsonValue[] = options.toolCalls ?? [
    { tool: 'whoCalls', input: { symbol: STORE_SYMBOL } },
    { tool: 'findByName', arguments: { name: WIDGET_SYMBOL } },
    { tool: 'unofferedQuery', input: { symbol: ROUTE_SYMBOL } },
    'routeForUrl',
    { tool: 'whoCalls', input: { symbol: STORE_SYMBOL } },
  ];
  return { ...investigateInput(), toolCalls: [...requested] };
}

/* -------------------------------------------------------------------------------------------------
 * local mirrors of the authoring schemas
 *
 * These are **mirrors**, not the real thing. The real authoring schemas live in
 * `@debuggen/panel-schema` (`PanelSpecInput`) and `@debuggen/instrumentation`
 * (`InstrumentationPlanInput`), and this package may not import either (AAP
 * §0.2.2) — which is exactly why `../provider.ts` has the caller pass its schema
 * in, and exactly why they are restated here. They mirror AAP §0.2.3's
 * *authoring* shapes and are kept minimal and structural on purpose: they
 * assert the shape, not every refinement, so drift between a mirror and its
 * original stays bounded to fields a caller genuinely requires. The closed
 * vocabularies are imported from `../deterministic/rules.js` rather than
 * restated, so a change to either tuple reaches these schemas automatically.
 * ---------------------------------------------------------------------------------------------- */

/**
 * An evidence reference: `@debuggen/panel-schema`'s `EventRef`, whose only
 * spelling is the `{ eventId }` record — a bare id is rejected there, so it is
 * rejected here, whatever spelling the capture context used.
 */
const evidenceRefMirror = z.strictObject({ eventId: z.string().min(1) });

/** `SourceLocation` as a panel or a hypothesis carries it. */
const sourceLocationMirror = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  symbol: z.string().min(1).optional(),
  endLine: z.number().int().positive().optional(),
  resolvedBy: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

/** An observed fact: a statement with at least one evidence reference, and nothing else. */
const factMirror = z.strictObject({
  statement: z.string().min(1),
  evidence: z.array(evidenceRefMirror).min(1),
});

/**
 * A likely cause: a fact with a confidence **level** and, where one is known, a
 * location — `@debuggen/panel-schema`'s `Hypothesis`, whose confidence is the
 * closed word vocabulary rather than a number.
 */
const hypothesisMirror = z.strictObject({
  statement: z.string().min(1),
  evidence: z.array(evidenceRefMirror).min(1),
  confidence: z.enum(CONFIDENCE_LEVELS),
  suggestedLocation: sourceLocationMirror.optional(),
});

/** `ProblemUnderstanding`. */
const understandingMirror = z.object({
  category: z.string().min(1).optional(),
  signalsNeeded: z.array(z.string().min(1)),
  entities: z.array(
    z.strictObject({
      kind: z.string().min(1),
      name: z.string().min(1),
      file: z.string().min(1).optional(),
    }),
  ),
  searchHints: z.array(z.string().min(1)),
});

/** `CodeInvestigation`. */
const investigationMirror = z.object({
  relevantFiles: z.array(
    z.object({
      file: z.string().min(1),
      symbol: z.string().min(1),
      reason: z.string().min(1),
      score: z.number().min(0).max(1),
    }),
  ),
  flows: z.array(z.string().min(1)),
});

/** One authored instrumentation action: file, symbol, type, optional rationale. */
const instrumentationTargetMirror = z.object({
  file: z.string().min(1),
  symbol: z.string().min(1),
  type: z.enum(INSTRUMENTATION_ACTION_TYPES),
  rationale: z.string().min(1).optional(),
});

/** `InstrumentationPlanInput` — the shape AAP §0.2.3's authoring example is written in. */
const planInputMirror = z.object({
  objective: z.string().min(1),
  capture: z.array(z.string().min(1)),
  instrumentationTargets: z.array(instrumentationTargetMirror),
  hypotheses: z.array(z.string().min(1)).optional(),
});

/**
 * `AnalysisFindings` — protocol's `analysisFindingsSchema`, the exact artifact
 * the analyze stage validates: observed facts and likely causes kept
 * structurally apart, and nothing else.
 *
 * Strict, like the original: the metrics of an `AnalysisResult` are computed by
 * protocol's `createAnalysisResult`, never proposed by a provider, so an answer
 * that carries a `metrics` key fails the stage's gate and must fail here too.
 */
const analysisMirror = z.strictObject({
  observed: z.array(factMirror),
  likelyCauses: z.array(hypothesisMirror),
});

/** One authored panel node: a visualization with its query fields, or a leaf with a location. */
const panelNodeMirror = z.object({
  type: z.string().min(1),
  source: z.string().min(1).optional(),
  filter: z
    .object({
      traceId: z.string().min(1).optional(),
      kinds: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  sort: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
  metrics: z.array(z.enum(COMPUTED_METRIC_IDS)).optional(),
  location: sourceLocationMirror.optional(),
});

/** `PanelSpecInput` — a title, a summary in either accepted form, and a layout. */
const panelSpecInputMirror = z.object({
  title: z.string().min(1),
  summary: z.union([
    z.string().min(1),
    z.object({ observed: z.array(factMirror), likelyCauses: z.array(hypothesisMirror) }),
  ]),
  layout: z.array(panelNodeMirror),
});

/** `FollowUpDecision`. */
const followUpMirror = z.object({
  needsNewCapture: z.boolean(),
  additionalActions: z.array(instrumentationTargetMirror),
});

/**
 * A schema no construction can satisfy: the rules emit capture signals as
 * strings, so requiring numbers makes the caller's schema unmeetable without
 * making the construction wrong.
 */
const unsatisfiableMirror = z.object({ signalsNeeded: z.array(z.number()) });

/* -------------------------------------------------------------------------------------------------
 * the stage table
 *
 * One entry per stage of `PROMPT_STAGES`, pairing a realistic structured context
 * with the mirror its real caller would pass. The `call` closure exists so the
 * table can stay heterogeneous while every entry keeps its own schema's static
 * type: the properties below iterate it rather than repeating six near-identical
 * tests, and `it('covers every stage …')` fails if a stage is ever added to the
 * vocabulary without landing here.
 * ---------------------------------------------------------------------------------------------- */

interface StageCase {
  /** The stage this entry answers for. */
  readonly stage: PromptStage;

  /** Its structured context. */
  readonly input: JsonObject;

  /** Runs the stage's own mirror through the provider. */
  readonly call: (
    request: ModelRequest,
  ) => Promise<Result<StructuredAttempt<unknown>, DebuggenError>>;
}

const STAGE_CASES: readonly StageCase[] = [
  {
    stage: 'understand',
    input: understandInput(),
    call: (request) => provider.generateStructured(understandingMirror, request),
  },
  {
    stage: 'investigate',
    input: investigateInput(),
    call: (request) => provider.generateStructured(investigationMirror, request),
  },
  {
    stage: 'plan',
    input: planInput(),
    call: (request) => provider.generateStructured(planInputMirror, request),
  },
  {
    stage: 'analyze',
    input: analyzeInput(),
    call: (request) => provider.generateStructured(analysisMirror, request),
  },
  {
    stage: 'generate-panel',
    input: latencyPanelInput(),
    call: (request) => provider.generateStructured(panelSpecInputMirror, request),
  },
  {
    stage: 'followup',
    input: followUpInput(),
    call: (request) => provider.generateStructured(followUpMirror, request),
  },
];

/** Values a failure must never echo back: fixture material and request prose alike. */
const NON_ECHOED_VALUES: readonly string[] = [
  ...PROSE_SENTINELS,
  WIDGET_SYMBOL,
  FORM_SYMBOL,
  ROUTE_SYMBOL,
  STORE_SYMBOL,
  TRACE_ID,
  SCAN_EVENT,
  HANDLER_EVENT,
  QUERY_EVENT,
  RENDER_EVENT,
];

/** Everything a failure exposes to a caller, flattened for substring assertions. */
function errorSurface(error: DebuggenError): string {
  return [
    error.code,
    error.message,
    error.hint ?? '',
    JSON.stringify(error.details ?? {}),
    JSON.stringify(error.toPayload()),
  ].join(' | ');
}

/* -------------------------------------------------------------------------------------------------
 * property 1 — schema-valid
 * ---------------------------------------------------------------------------------------------- */

describe('property 1: schema-valid — every stage builds an answer its caller can accept', () => {
  it('covers every stage in PROMPT_STAGES', () => {
    expect(STAGE_CASES.map((stageCase) => stageCase.stage)).toEqual([...PROMPT_STAGES]);
  });

  for (const stageCase of STAGE_CASES) {
    it(`builds a ${stageCase.stage} answer the authoring mirror accepts`, async () => {
      const result = await stageCase.call(requestFor(stageCase.stage, stageCase.input));
      const attempt = okValue(result);

      // `raw` is the construction as the rules produced it, before the schema
      // saw it. `../structured.ts` re-parses it, so it must always be there.
      expect(attempt.raw).toBeDefined();
      expect(attempt.value).toBeDefined();

      // The parsed value must equal the construction key for key: anything the
      // mirror silently stripped would be a field a real caller's authoring
      // schema does not know about, which is the drift this comparison catches.
      expect(canonical(attempt.value)).toBe(canonical(attempt.raw));

      // Nothing the rules could not derive leaks in as `undefined`.
      expect(undefinedPaths(attempt.raw)).toEqual([]);

      expect(attempt.providerId).toBe(PROVIDER_ID);
      expect(attempt.model).toBe(PROVIDER_ID);
      expect(attempt.stopReason).toBe(COMPLETE_STOP_REASON);

      // A rules engine reaches no model, so it reports no token accounting and
      // no assistant text: an absent usage must stay absent rather than be
      // invented as zero.
      expect(attempt.usage).toBeUndefined();
      expect(attempt.text).toBeUndefined();
    });
  }

  it('answers an analysis in exactly the findings shape, proposing no metrics of its own', async () => {
    const result = await provider.generateStructured(
      analysisMirror,
      requestFor('analyze', analyzeInput()),
    );
    const parsed = asObject(okValue(result).value);
    expect(Object.keys(parsed).sort()).toEqual(['likelyCauses', 'observed']);
    expect(parsed.metrics).toBeUndefined();
    for (const cause of asArray(parsed.likelyCauses)) {
      expect(CONFIDENCE_LEVELS).toContain(asObject(cause).confidence);
    }
  });

  it('cites every reference as an { eventId } record even when the capture spelled it bare', async () => {
    // The fixture's aggregates carry bare-string evidence lists throughout.
    const analysis = await answerFor('analyze', analyzeInput());
    const cited = [...asArray(analysis.observed), ...asArray(analysis.likelyCauses)].flatMap(
      (item) => asArray(asObject(item).evidence),
    );
    expect(cited.length).toBeGreaterThan(0);
    for (const reference of cited) {
      expect(typeof reference).toBe('object');
      expect(Object.keys(asObject(reference))).toEqual(['eventId']);
    }
  });

  it("never cites an aggregate's own id as an event", async () => {
    // The service's analysis input identifies groups, tree nodes and graph
    // participants by ids of their own; only `eventId` and evidence lists name
    // persisted events.
    const base = analyzeInput();
    const aggregates = asObject(base.aggregates);
    const input: JsonObject = {
      aggregates: {
        ...aggregates,
        componentTree: [{ id: 'tree-node-1', name: WIDGET_SYMBOL, renderCount: 40 }],
        requests: [
          ...asArray(aggregates.requests).map((group) => ({ ...asObject(group), id: 'req:g:0' })),
          { id: 'req:g:1', endpoint: '/tally/other', count: 3, windowMs: 10 },
        ],
      },
    };

    const analysis = await answerFor('analyze', input);
    const cited = [...asArray(analysis.observed), ...asArray(analysis.likelyCauses)].flatMap(
      (item) => citedEvidence(item),
    );
    expect(cited.length).toBeGreaterThan(0);
    for (const own of ['tree-node-1', 'req:g:0', 'req:g:1']) {
      expect(cited).not.toContain(own);
    }
  });

  it("cites a group's occurrences when its row carries no evidence list of its own", async () => {
    // The service's analysis rows carry their executions as `occurrences[]`,
    // each naming its persisted event by `eventId`, and no evidence list.
    const base = analyzeInput();
    const aggregates = asObject(base.aggregates);
    const occurrenceEvents = ['ev-query-occ-01', 'ev-query-occ-02', 'ev-query-occ-03'];
    const input: JsonObject = {
      aggregates: {
        ...aggregates,
        queries: [
          {
            id: 'qry:g:0',
            statement: 'SELECT id FROM tally_rows WHERE bucket = $1',
            executionCount: occurrenceEvents.length,
            occurrences: occurrenceEvents.map((eventId, position) => ({
              eventId,
              spanId: `span-occ-${String(position)}`,
              traceId: TRACE_ID,
              startTime: position,
              durationMs: 1,
            })),
          },
        ],
      },
    };

    const analysis = await answerFor('analyze', input);
    const cause = asArray(analysis.likelyCauses).find((entry) =>
      citedEvidence(entry).some((reference) => occurrenceEvents.includes(reference)),
    );
    expect(cause).toBeDefined();
    const cited = citedEvidence(cause);
    expect(cited).not.toContain('qry:g:0');
    for (const reference of cited) {
      expect(occurrenceEvents).toContain(reference);
    }
  });

  it('reads metrics from the list carrier exactly as from the map carrier', async () => {
    const fromMap = await answerFor('analyze', analyzeInput());
    const fromList = await answerFor('analyze', analyzeInput({ metricsAsList: true }));
    expect(fromList).toEqual(fromMap);
  });

  it('never states a stronger pattern less confidently than a weaker one of its class', async () => {
    const levelOfDuplicates = async (duplicateCount: number): Promise<number> => {
      const analysis = await answerFor('analyze', analyzeInput({ duplicateCount }));
      const cause = asArray(analysis.likelyCauses).find((entry) =>
        citedEvidence(entry).some((reference) => REQUEST_EVENTS.includes(reference)),
      );
      expect(cause).toBeDefined();
      const levels: readonly string[] = CONFIDENCE_LEVELS;
      return levels.indexOf(asString(asObject(cause).confidence));
    };
    const weak = await levelOfDuplicates(2);
    const strong = await levelOfDuplicates(6);
    expect(weak).toBeGreaterThanOrEqual(0);
    expect(strong).toBeGreaterThan(weak);
  });

  it('plans only action types the instrumentation vocabulary declares', async () => {
    const result = await provider.generateStructured(
      planInputMirror,
      requestFor('plan', planInput()),
    );
    const parsed = asObject(okValue(result).value);
    const targets = asArray(parsed.instrumentationTargets);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(INSTRUMENTATION_ACTION_TYPES).toContain(asString(asObject(target).type));
    }
  });

  /**
   * The opposite of `./anthropic.ts` on purpose.
   *
   * The real provider answers a schema miss with `Ok` and an undefined `value`,
   * so `../structured.ts` can spend its repair budget re-prompting the model
   * with the failing field paths. Re-prompting a rules engine is pointless —
   * the same structured context produces the same bytes — so a miss here is
   * terminal: a construction that fails the caller's schema is a defect in the
   * builders, and it must surface as a typed failure rather than as a trimmed
   * or partially-populated answer that a caller would go on to store.
   */
  it('refuses the answer, rather than trimming it, when the construction misses the caller schema', async () => {
    const result = await provider.generateStructured(
      unsatisfiableMirror,
      requestFor('understand', understandInput()),
    );
    const error = errorOf(result);

    expect(DebuggenError.is(error)).toBe(true);
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.code).toBe('INTERNAL');

    // The failure names the schema paths that failed and nothing else: no value
    // from the construction, and no word of the request's prose.
    const details = error.details ?? {};
    expect(asArray(details.schemaIssuePaths)).toContain('signalsNeeded[0]');
    expect(details.schemaIssueCount).toBeGreaterThan(0);
    expect(details.providerId).toBe(PROVIDER_ID);
    expect(details.stage).toBe('understand');

    const surface = errorSurface(error);
    for (const value of NON_ECHOED_VALUES) {
      expect(surface).not.toContain(value);
    }
  });

  it('fails the stage, without inventing an answer, when the context carries nothing to reason from', async () => {
    const result = await provider.generateStructured(
      understandingMirror,
      requestFor('understand', {}),
    );
    const error = errorOf(result);
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.code).toBe('MODEL_UNAVAILABLE');
    expect(error.hint).toBeDefined();
  });

  it('parses the construction exactly once per call: the repair loop lives in the validator', async () => {
    const accepting = understandingMirror;
    const acceptingSpy = vi.spyOn(accepting, 'safeParse');
    const rejecting = z.object({ signalsNeeded: z.array(z.number()) });
    const rejectingSpy = vi.spyOn(rejecting, 'safeParse');

    try {
      const accepted = await provider.generateStructured(
        accepting,
        requestFor('understand', understandInput()),
      );
      const rejected = await provider.generateStructured(
        rejecting,
        requestFor('understand', understandInput()),
      );

      expect(accepted.ok).toBe(true);
      expect(rejected.ok).toBe(false);
      expect(acceptingSpy).toHaveBeenCalledTimes(1);
      expect(rejectingSpy).toHaveBeenCalledTimes(1);
    } finally {
      acceptingSpy.mockRestore();
      rejectingSpy.mockRestore();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * property 2 — input-derived
 * ---------------------------------------------------------------------------------------------- */

/** Runs one stage's mirror over `input` and returns the parsed answer as an object. */
async function answerFor(stage: PromptStage, input: JsonObject): Promise<Record<string, unknown>> {
  const stageCase = STAGE_CASES.find((entry) => entry.stage === stage);
  if (stageCase === undefined) {
    throw new Error(`no stage case is declared for ${stage}`);
  }
  return asObject(okValue(await stageCase.call(requestFor(stage, input))).value);
}

/** The `name` of every entity an understanding reported, in order. */
function entityNames(understanding: Record<string, unknown>): readonly string[] {
  return asArray(understanding.entities).map((entity) => asString(asObject(entity).name));
}

/** Answers an understand request against `schema`, unwrapped to a plain object. */
async function closedAnswer(
  schema: z.ZodType,
  input: JsonObject,
): Promise<Record<string, unknown>> {
  return asObject(
    okValue(await provider.generateStructured(schema, requestFor('understand', input))).value,
  );
}

/** The `file` of every relevant file an investigation reported, in order. */
function reportedFiles(answer: Record<string, unknown>): readonly string[] {
  return asArray(answer.relevantFiles).map((entry) => asString(asObject(entry).file));
}

/** The `type` of every instrumentation target a plan or a follow-up reported, in order. */
function reportedActionTypes(targets: readonly unknown[]): readonly string[] {
  return targets.map((entry) => asString(asObject(entry).type));
}

/** Every evidence reference a fact cites, normalised to bare identifiers. */
function citedEvidence(fact: unknown): readonly string[] {
  return asArray(asObject(fact).evidence).map((reference) =>
    typeof reference === 'string' ? reference : asString(asObject(reference).eventId),
  );
}

/** The layout nodes of a generated panel. */
function layoutNodes(answer: Record<string, unknown>): readonly Record<string, unknown>[] {
  return asArray(answer.layout).map((node) => asObject(node));
}

/** The `type` of every layout node, in the order the panel lays them out. */
function layoutTypes(answer: Record<string, unknown>): readonly string[] {
  return layoutNodes(answer).map((node) => asString(node.type));
}

/** The metric ids a panel's metric-cards node selected, or `[]` when it has none. */
function metricCardIds(answer: Record<string, unknown>): readonly string[] {
  const card = layoutNodes(answer).find((node) => node.type === 'metricCards');
  if (card === undefined) {
    return [];
  }
  return asArray(card.metrics).map((id) => asString(id));
}

describe('property 2: input-derived — one context field moves, the answer field that depends on it moves', () => {
  it('understand: a different selected target changes the entities and the search hints', async () => {
    const base = await answerFor('understand', understandInput());
    const moved = await answerFor('understand', understandInput({ componentChain: [TILE_SYMBOL] }));

    expect(entityNames(base)).toContain(FORM_SYMBOL);
    expect(entityNames(base)).not.toContain(TILE_SYMBOL);

    expect(entityNames(moved)).toContain(TILE_SYMBOL);
    expect(entityNames(moved)).not.toContain(FORM_SYMBOL);
    expect(asArray(moved.searchHints)).toContain(TILE_SYMBOL);
  });

  it('investigate: a different candidate set changes the relevant files it reports', async () => {
    const base = await answerFor('investigate', investigateInput());
    const moved = await answerFor(
      'investigate',
      investigateInput({ candidates: [TILE_CANDIDATE], withoutFlows: true }),
    );

    expect(reportedFiles(base)).toContain(WIDGET_FILE);
    expect(reportedFiles(base)).toContain(STORE_FILE);
    expect(reportedFiles(base)).not.toContain(TILE_FILE);

    expect(reportedFiles(moved)).toEqual([TILE_FILE]);
  });

  it('plan: a narrower adapter catalog changes the action types the plan asks for', async () => {
    const base = await answerFor('plan', planInput());
    const moved = await answerFor('plan', planInput({ claimedActionTypes: ['function-timing'] }));

    const baseTypes = reportedActionTypes(asArray(base.instrumentationTargets));
    const movedTypes = reportedActionTypes(asArray(moved.instrumentationTargets));

    expect(baseTypes).toContain('react-render-tracking');
    expect(baseTypes).toContain('db-query-tracking');
    expect(movedTypes.length).toBeGreaterThan(0);
    expect([...new Set(movedTypes)]).toEqual(['function-timing']);
  });

  it('analyze: a different slowest operation changes the evidence the leading fact cites', async () => {
    const base = await answerFor('analyze', analyzeInput());
    const moved = await answerFor(
      'analyze',
      analyzeInput({ scanDurationMs: 1100, handlerDurationMs: 300 }),
    );

    const baseLead = asArray(base.observed)[0];
    const movedLead = asArray(moved.observed)[0];
    expect(baseLead).toBeDefined();
    expect(movedLead).toBeDefined();

    expect(citedEvidence(baseLead)).toEqual([HANDLER_EVENT]);
    expect(citedEvidence(movedLead)).toEqual([SCAN_EVENT]);
  });

  it('generate-panel: a different metric bag changes the cards the panel selects', async () => {
    const base = await answerFor('generate-panel', latencyPanelInput());
    const moved = await answerFor(
      'generate-panel',
      latencyPanelInput({ metrics: { total_duration: 1175, request_count: 4 } }),
    );

    expect(metricCardIds(base)).toContain('query_count');
    expect(metricCardIds(base)).toContain('database_duration');
    expect(metricCardIds(moved)).toEqual(['total_duration', 'request_count']);
  });

  it('generate-panel: an aggregate the capture no longer carries removes the node that reads it', async () => {
    const base = await answerFor('generate-panel', latencyPanelInput());
    const moved = await answerFor('generate-panel', latencyPanelInput({ withoutQueries: true }));

    expect(layoutTypes(base)).toContain('queryTable');
    expect(layoutTypes(moved)).not.toContain('queryTable');
    // Every other node the capture still supports survives the removal.
    expect(layoutTypes(moved)).toContain('requestTable');
    expect(layoutTypes(moved)).toContain('timeline');
  });

  it('followup: signals the capture already carries remove the need for another capture', async () => {
    const base = await answerFor('followup', followUpInput());
    const moved = await answerFor(
      'followup',
      followUpInput({ capturedSignals: ['render', 'interaction', 'db.query'] }),
    );

    expect(base.needsNewCapture).toBe(true);
    const delta = asArray(base.additionalActions);
    expect(reportedActionTypes(delta)).toEqual(['db-query-tracking']);
    // The action the installed plan already applied is never proposed again.
    expect(delta.map((entry) => asString(asObject(entry).file))).not.toContain(PRESS_FILE);

    expect(moved.needsNewCapture).toBe(false);
    expect(asArray(moved.additionalActions)).toEqual([]);
  });

  describe('understanding vocabulary', () => {
    /**
     * The closed vocabularies `ProblemUnderstanding` is validated against in
     * `@debuggen/instrumentation` (`CAPTURE_SIGNALS`, `PROBLEM_CATEGORIES`),
     * restated because this package sits below that one. The loose
     * {@link understandingMirror} accepts any string; this one is what the
     * service's understand stage actually hands the provider.
     */
    const closedSignals = [
      'interactions',
      'react',
      'state',
      'fetch',
      'perf',
      'errors',
      'componentTree',
      'http',
      'routeHandlers',
      'prisma',
      'pg',
      'functions',
    ] as const;
    const closedCategories = [
      'performance',
      'rendering',
      'network',
      'data',
      'state',
      'error',
      'correctness',
      'other',
    ] as const;
    const closedEntityKinds = [
      'component',
      'function',
      'hook',
      'route',
      'file',
      'symbol',
      'selector',
      'url',
      'query',
      'other',
    ] as const;
    const closedUnderstanding = z.strictObject({
      category: z.enum(closedCategories),
      signalsNeeded: z.array(z.enum(closedSignals)).min(1),
      entities: z.array(
        z.strictObject({
          kind: z.enum(closedEntityKinds),
          name: z.string().min(1).max(200),
          file: z.string().min(1).optional(),
        }),
      ),
      searchHints: z.array(z.string().min(1)),
    });

    /** The understand stage's own context: lexical hints and a code-analysis project summary. */
    function serviceUnderstandInput(style: string): JsonObject {
      return {
        tokens: ['button', 'slow'],
        identifierCandidates: [],
        signalTerms: ['slow'],
        projectSummary: {
          projectName: 'sample',
          databaseAccess: { style, callSiteCount: 2 },
          routes: [{ routePath: '/api/items', file: 'app/api/items/route.ts' }],
          counts: { apiCalls: 1, apiRoutes: 1, dbCalls: 2, components: 3 },
        },
      };
    }

    it('answers the service context in the closed vocabularies, classifying nothing it was not given', async () => {
      const answer = await closedAnswer(closedUnderstanding, serviceUnderstandInput('prisma'));

      expect(answer.category).toBe('other');
      expect(answer.signalsNeeded).toEqual([
        'fetch',
        'http',
        'perf',
        'prisma',
        'react',
        'routeHandlers',
      ]);
      // The summary's routes are what a code investigation can be seeded from.
      expect(answer.entities).toEqual([{ kind: 'route', name: '/api/items' }]);
      expect(answer.searchHints).toEqual(['/api/items', 'items']);
    });

    it('observes a page through its performance entries whenever it observes the page at all', async () => {
      const page = await closedAnswer(closedUnderstanding, serviceUnderstandInput('prisma'));
      const serverOnly = await closedAnswer(closedUnderstanding, {
        ...serviceUnderstandInput('prisma'),
        projectSummary: {
          projectName: 'sample',
          databaseAccess: { style: 'prisma', callSiteCount: 2 },
          routes: [{ routePath: '/api/items', file: 'app/api/items/route.ts' }],
          counts: { apiRoutes: 1, dbCalls: 2 },
        },
      });

      // Reported components make the page worth observing, and with it its
      // long tasks, resource timing and navigation.
      expect(page.signalsNeeded).toEqual(expect.arrayContaining(['react', 'perf']));
      // A project with nothing observable in the page asks for no page hook.
      expect(serverOnly.signalsNeeded).not.toContain('react');
      expect(serverOnly.signalsNeeded).not.toContain('interactions');
      expect(serverOnly.signalsNeeded).not.toContain('perf');
    });

    it('plans one runtime action for a needed page-error signal', async () => {
      const plan = await answerFor('plan', {
        ...planInput({
          candidates: [],
          withoutFlows: true,
          claimedActionTypes: ['perf-tracking'],
          availableSignals: ['perf', 'errors'],
        }),
        signalsNeeded: ['errors'],
      });
      const targets = asArray(plan.instrumentationTargets).map(asObject);

      expect(targets.map((target) => target.type)).toEqual(['perf-tracking']);
    });

    it('asks for exactly the database drivers the summary reports', async () => {
      const pg = await closedAnswer(closedUnderstanding, serviceUnderstandInput('pg'));
      const both = await closedAnswer(closedUnderstanding, serviceUnderstandInput('both'));

      expect(pg.signalsNeeded).toContain('pg');
      expect(pg.signalsNeeded).not.toContain('prisma');
      expect(both.signalsNeeded).toEqual(expect.arrayContaining(['pg', 'prisma']));
    });

    it('collects a needed signal no candidate covers with a targetless runtime action', async () => {
      const plan = await answerFor('plan', {
        ...planInput({
          candidates: [],
          withoutFlows: true,
          claimedActionTypes: ['interaction-tracking', 'react-render-tracking', 'fetch-tracking'],
          availableSignals: ['interactions', 'react', 'componentTree', 'fetch'],
        }),
        signalsNeeded: ['interactions', 'react', 'fetch'],
      });
      const targets = asArray(plan.instrumentationTargets).map(asObject);

      expect(targets.map((target) => target.type).sort()).toEqual([
        'fetch-tracking',
        'interaction-tracking',
        'react-render-tracking',
      ]);
      for (const target of targets) {
        expect(target.file).toBe('.');
        expect(target.symbol).toBe('*');
      }
      expect(asArray(plan.capture)).toEqual(
        expect.arrayContaining(['interactions', 'react', 'componentTree']),
      );
    });

    it('reads a carried symptom category and kind-named signals into the closed vocabularies', async () => {
      const answer = await closedAnswer(
        closedUnderstanding,
        understandInput({ category: 'excessive-renders' }),
      );

      expect(answer.category).toBe('rendering');
      expect(answer.signalsNeeded).toEqual(expect.arrayContaining(['interactions', 'react']));
      // The selected target's chain leads, as components; a path-shaped name is a file.
      expect(entityNames(answer).slice(0, 2)).toEqual([WIDGET_SYMBOL, FORM_SYMBOL]);
      expect(asArray(answer.entities)).toContainEqual({ kind: 'file', name: FORM_FILE });
    });
  });

  describe('graceful degradation', () => {
    it('answers a smaller understanding when the optional selected target is absent', async () => {
      const base = await answerFor('understand', understandInput());
      const degraded = await answerFor('understand', understandInput({ withoutTarget: true }));

      expect(asArray(base.signalsNeeded)).toContain('react');
      // The target is what establishes that renders are worth capturing; the
      // signal the context asked for directly survives without it, read into
      // the capture-signal vocabulary.
      expect(asArray(degraded.signalsNeeded)).not.toContain('react');
      expect(asArray(degraded.signalsNeeded)).toContain('interactions');
      expect(entityNames(degraded)).not.toContain(FORM_SYMBOL);
      expect(undefinedPaths(degraded)).toEqual([]);
    });

    it('answers a smaller investigation when the candidate list is empty but a flow remains', async () => {
      const degraded = await answerFor('investigate', investigateInput({ candidates: [] }));

      expect(reportedFiles(degraded)).toEqual([]);
      expect(asArray(degraded.flows).length).toBeGreaterThan(0);
      expect(undefinedPaths(degraded)).toEqual([]);
    });

    it('fails typed, rather than throwing, when an empty candidate list leaves nothing at all', async () => {
      const result = await provider.generateStructured(
        investigationMirror,
        requestFor('investigate', investigateInput({ candidates: [], withoutFlows: true })),
      );
      const error = errorOf(result);
      expect(DebuggenError.is(error)).toBe(true);
      expect(error.code).toBe('MODEL_UNAVAILABLE');
      expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    });

    it('answers an empty capture with an empty analysis rather than an invented finding', async () => {
      const degraded = await answerFor('analyze', emptyCaptureInput());

      expect(asArray(degraded.observed)).toEqual([]);
      expect(asArray(degraded.likelyCauses)).toEqual([]);
      expect(degraded.metrics).toBeUndefined();
      expect(undefinedPaths(degraded)).toEqual([]);
    });

    it('answers an empty capture with the non-evidentiary notice and no layout', async () => {
      const degraded = await answerFor('generate-panel', emptyCaptureInput());

      // Asserted against the imported frame, never a pasted sentence:
      // `../deterministic/templates.ts` owns the wording.
      expect(degraded.summary).toBe(EMPTY_CAPTURE_NOTICE);
      expect(layoutTypes(degraded)).toEqual([]);
      expect(asString(degraded.title).length).toBeGreaterThan(0);
      expect(undefinedPaths(degraded)).toEqual([]);
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * property 3 — wording-invariant
 *
 * The mechanical proof of AAP §0.5.4. `buildDeterministicOutput` reads only
 * `metadata.stage` and `input`, and hands each per-stage builder the structured
 * context alone, so no builder can reach the prose — these tests are what turns
 * that structure into an assertion, end to end through the provider.
 * ---------------------------------------------------------------------------------------------- */

describe('property 3: wording-invariant — two differently-worded questions answer identically', () => {
  for (const stageCase of STAGE_CASES) {
    it(`answers a ${stageCase.stage} request identically whatever its wording`, async () => {
      const first = okValue(
        await stageCase.call(requestFor(stageCase.stage, stageCase.input, { variant: 'first' })),
      );
      const second = okValue(
        await stageCase.call(
          requestFor(stageCase.stage, stageCase.input, {
            variant: 'second-asked-with-completely-different-words',
          }),
        ),
      );

      expect(canonical(second.raw)).toBe(canonical(first.raw));
      expect(canonical(second.value)).toBe(canonical(first.value));

      const serialized = JSON.stringify(first.raw);
      for (const sentinel of PROSE_SENTINELS) {
        expect(serialized).not.toContain(sentinel);
      }
    });
  }

  it('returns identical free text for two differently-worded requests', async () => {
    const input = analyzeInput();
    const first = okValue(
      await provider.generateText(requestFor('analyze', input, { variant: 'first' })),
    );
    const second = okValue(
      await provider.generateText(requestFor('analyze', input, { variant: 'reworded' })),
    );

    expect(second.text).toBe(first.text);
    expect(first.providerId).toBe(PROVIDER_ID);
    expect(first.stopReason).toBe(COMPLETE_STOP_REASON);
    for (const sentinel of PROSE_SENTINELS) {
      expect(first.text).not.toContain(sentinel);
    }
  });

  it('selects identical tool calls for two differently-worded requests', async () => {
    const input = toolCallInput();
    const first = okValue(
      await provider.callTools(requestFor('investigate', input, { variant: 'first' }), CODE_TOOLS),
    );
    const second = okValue(
      await provider.callTools(
        requestFor('investigate', input, { variant: 'reworded' }),
        CODE_TOOLS,
      ),
    );

    expect(canonical(second.calls)).toBe(canonical(first.calls));
    const serialized = JSON.stringify(first.calls);
    for (const sentinel of PROSE_SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it('records nothing of the request provenance in the answer it builds', async () => {
    const sessionId = 'session-zqx-0042';
    const attempt = okValue(
      await provider.generateStructured(
        analysisMirror,
        requestFor('analyze', analyzeInput(), { sessionId }),
      ),
    );

    const serialized = JSON.stringify(attempt.raw);
    expect(serialized).not.toContain(sessionId);
    expect(serialized).not.toContain('v001');
  });
});

/* -------------------------------------------------------------------------------------------------
 * property 4 — panels genuinely differ
 *
 * AAP §0.8.4's second acceptance test requires the render panel to differ
 * materially from the latency panel, and AAP §0.6.5 fixes how far the two may
 * overlap: the summary header, the metric cards and the source chips, and
 * nothing else. Both captures below are handed the *same* node catalog, so a
 * divergence can only come from the evidence.
 * ---------------------------------------------------------------------------------------------- */

describe('property 4: generated panels genuinely differ between two captures', () => {
  it('lays out materially different node sets for a latency capture and a render capture', async () => {
    const latency = await answerFor('generate-panel', latencyPanelInput());
    const renders = await answerFor('generate-panel', renderPanelInput());

    const latencyTypes = new Set(layoutTypes(latency));
    const renderTypes = new Set(layoutTypes(renders));

    expect(latencyTypes.size).toBeGreaterThan(0);
    expect(renderTypes.size).toBeGreaterThan(0);

    // Every body a panel composes comes from the catalogued node vocabulary.
    for (const type of [...latencyTypes, ...renderTypes]) {
      expect(CATALOGUED_NODE_TYPES).toContain(type);
    }

    // The overlap is exactly what AAP §0.6.5 permits: metric cards and source
    // links. The summary header is not a layout node, so it is not expected
    // here — it is asserted through `summary` in the test below.
    const shared = [...latencyTypes].filter((type) => renderTypes.has(type)).sort();
    for (const type of shared) {
      expect(SHAREABLE_NODE_TYPES).toContain(type);
    }

    // Each panel's visualization body is disjoint from the other's.
    const latencyOnly = [...latencyTypes].filter((type) => !renderTypes.has(type));
    const renderOnly = [...renderTypes].filter((type) => !latencyTypes.has(type));
    expect(latencyOnly.length).toBeGreaterThan(1);
    expect(renderOnly.length).toBeGreaterThan(1);

    // The evidence each capture carries is what selected those bodies.
    expect(latencyOnly).toContain('queryTable');
    expect(latencyOnly).toContain('requestTable');
    expect(renderOnly).toContain('renderTable');
    expect(renderOnly).toContain('componentTree');
    expect(renderOnly).toContain('stateTransitions');
  });

  it('selects different metric cards and a different title for the two captures', async () => {
    const latency = await answerFor('generate-panel', latencyPanelInput());
    const renders = await answerFor('generate-panel', renderPanelInput());

    expect(metricCardIds(latency)).toContain('database_duration');
    expect(metricCardIds(renders)).toContain('unchanged_render_count');
    expect(metricCardIds(renders)).not.toContain('database_duration');

    // Both card sets are drawn from the computed vocabulary, in its order.
    for (const ids of [metricCardIds(latency), metricCardIds(renders)]) {
      const positions = ids.map((id) => COMPUTED_METRIC_IDS.findIndex((known) => known === id));
      expect(positions).not.toContain(-1);
      expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    }

    expect(asString(renders.title)).not.toBe(asString(latency.title));
  });

  it('points every source link at a location the capture actually resolved', async () => {
    const latency = await answerFor('generate-panel', latencyPanelInput());
    const renders = await answerFor('generate-panel', renderPanelInput());

    const latencyLink = layoutNodes(latency).find((node) => node.type === 'sourceLink');
    const renderLink = layoutNodes(renders).find((node) => node.type === 'sourceLink');
    expect(latencyLink).toBeDefined();
    expect(renderLink).toBeDefined();

    expect(asObject(asObject(latencyLink).location).file).toBe(STORE_FILE);
    expect(asObject(asObject(renderLink).location).file).toBe(TILE_FILE);

    // A leaf carries its location directly and never a data query.
    expect(asObject(latencyLink).source).toBeUndefined();
    expect(asObject(latencyLink).filter).toBeUndefined();
  });

  /**
   * AAP §0.8.4 keeps observed facts and inferred causes apart *structurally*.
   * The panel's own `summary` is the non-evidentiary headline of AAP §0.2.3 — a
   * string can never become a `Fact`, and the panel's facts are copied from the
   * validated analysis by the normaliser — so the separation is asserted where
   * it lives: on the analysis, plus the absence of fact-shaped fields on the
   * panel summary the rules build.
   */
  it('keeps observed facts and likely causes apart, and never states a fact without evidence', async () => {
    const analysis = await answerFor('analyze', analyzeInput());

    const observed = asArray(analysis.observed);
    const causes = asArray(analysis.likelyCauses);
    expect(observed.length).toBeGreaterThan(0);
    expect(causes.length).toBeGreaterThan(0);

    for (const fact of observed) {
      const entry = asObject(fact);
      expect(asString(entry.statement).length).toBeGreaterThan(0);
      expect(citedEvidence(fact).length).toBeGreaterThan(0);
      // An observed fact carries evidence and nothing that would make it a
      // hypothesis: no confidence, no suggested location.
      expect(entry.confidence).toBeUndefined();
      expect(entry.suggestedLocation).toBeUndefined();
    }

    for (const cause of causes) {
      const entry = asObject(cause);
      expect(citedEvidence(cause).length).toBeGreaterThan(0);
      expect(CONFIDENCE_LEVELS).toContain(entry.confidence);
    }

    // Every cited identifier exists in the capture that was handed in.
    const available = new Set([
      SCAN_EVENT,
      HANDLER_EVENT,
      QUERY_EVENT,
      RENDER_EVENT,
      ...REQUEST_EVENTS,
    ]);
    for (const item of [...observed, ...causes]) {
      for (const reference of citedEvidence(item)) {
        expect(available.has(reference)).toBe(true);
      }
    }
  });

  it('builds the panel summary as non-evidentiary prose, never as a fact', async () => {
    const latency = await answerFor('generate-panel', latencyPanelInput());

    // The authoring schema accepts either form; the rules always produce the
    // string headline, because facts may only be copied from a validated
    // analysis (AAP §0.2.3).
    const summary = asString(latency.summary);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).not.toContain(SCAN_EVENT);
    expect(summary).not.toContain(HANDLER_EVENT);
    for (const sentinel of PROSE_SENTINELS) {
      expect(summary).not.toContain(sentinel);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * service-shaped aggregates
 *
 * The fixtures above state a request group's evidence on the group itself. The
 * service's analysis input (`apps/local-service/src/analysis/summarize.ts`)
 * states it one level down instead: each group lists its `occurrences`, every
 * one naming its own event and, once located, its own call site, and the
 * product's duplicate rule reports `duplicateWindows` of identical requests.
 * A group of that shape must be read, cited and located exactly as a group
 * with a direct evidence list is.
 * ---------------------------------------------------------------------------------------------- */

/** The events of the service-shaped group's larger duplicate window, then of its smaller one. */
const WINDOW_EVENTS: readonly string[] = ['ev-window-01', 'ev-window-02', 'ev-window-03'];
const LATE_EVENTS: readonly string[] = ['ev-window-04', 'ev-window-05'];

/** How the service-shaped request group may be varied. */
interface ServiceShapedOptions {
  /** Gives the last occurrence a different call site than the others. */
  readonly disagreeingLocations?: boolean;
}

/**
 * One request group as the service hands it to the analysis and panel stages:
 * no evidence list and no window of its own, only its occurrences and the
 * duplicate windows over them.
 */
function serviceShapedRequestGroup(options: ServiceShapedOptions = {}): JsonObject {
  const shared = sourceLocation(FORM_FILE, 84, 5, 'source-map');
  const elsewhere = sourceLocation(STORE_FILE, 12, 3, 'source-map');
  const events = [...WINDOW_EVENTS, ...LATE_EVENTS];
  return {
    id: 'req:g:0',
    method: 'GET',
    url: '/tally/rows?bucket=?',
    count: events.length,
    duplicateCount: events.length - 2,
    firstStartTime: 1_000,
    lastStartTime: 2_010,
    duplicateWindows: [
      {
        startTime: 1_000,
        endTime: 1_022,
        count: WINDOW_EVENTS.length,
        eventIds: [...WINDOW_EVENTS],
      },
      { startTime: 2_000, endTime: 2_010, count: LATE_EVENTS.length, eventIds: [...LATE_EVENTS] },
    ],
    occurrences: events.map((eventId, index) => ({
      eventId,
      startTime: index < WINDOW_EVENTS.length ? 1_000 + index * 11 : 2_000 + index,
      source:
        options.disagreeingLocations === true && index === events.length - 1 ? elsewhere : shared,
    })),
  };
}

/** The analysis context with its request aggregate replaced by the service-shaped group. */
function serviceShapedAnalyzeInput(options: ServiceShapedOptions = {}): JsonObject {
  const base = analyzeInput();
  return {
    aggregates: { ...asObject(base.aggregates), requests: [serviceShapedRequestGroup(options)] },
  };
}

describe('service-shaped aggregates — evidence carried by occurrences and duplicate windows', () => {
  it('cites the events of the largest duplicate window for a group with no evidence list', async () => {
    const analysis = await answerFor('analyze', serviceShapedAnalyzeInput());

    const fact = asArray(analysis.observed).find((entry) =>
      citedEvidence(entry).some((reference) => WINDOW_EVENTS.includes(reference)),
    );
    expect(fact).toBeDefined();
    // The sentence and its evidence describe the same requests: the window's.
    expect(asString(asObject(fact).statement)).toContain(String(WINDOW_EVENTS.length));
    expect([...citedEvidence(fact)].sort()).toEqual([...WINDOW_EVENTS].sort());
  });

  it('locates the duplicate-request cause at the call site every occurrence shares', async () => {
    const analysis = await answerFor('analyze', serviceShapedAnalyzeInput());

    const cause = asArray(analysis.likelyCauses).find((entry) =>
      citedEvidence(entry).some((reference) => WINDOW_EVENTS.includes(reference)),
    );
    expect(cause).toBeDefined();
    const location = asObject(asObject(cause).suggestedLocation);
    expect(location.file).toBe(FORM_FILE);
    expect(location.line).toBe(84);
    expect(location.column).toBe(5);
  });

  it('suggests no call site when the occurrences disagree on where they came from', async () => {
    const analysis = await answerFor(
      'analyze',
      serviceShapedAnalyzeInput({ disagreeingLocations: true }),
    );

    const cause = asArray(analysis.likelyCauses).find((entry) =>
      citedEvidence(entry).some((reference) => WINDOW_EVENTS.includes(reference)),
    );
    expect(cause).toBeDefined();
    // Neither occurrence's site stands in for "a single call site", and the
    // statement names none of them either.
    expect(asObject(cause).suggestedLocation).toBeUndefined();
    const statement = asString(asObject(cause).statement);
    expect(statement).not.toContain(FORM_FILE);
    expect(statement).not.toContain(STORE_FILE);
  });

  it('keeps the request counts on the cards of a duplicate capture whatever the headline reports', async () => {
    // Every metric the computed tuple lists ahead of the request counts is
    // reported, so a capped headline row alone would crowd them out.
    const metrics: JsonObject = {
      total_duration: 1175,
      frontend_duration: 120,
      backend_duration: 415,
      database_duration: 640,
      render_count: 6,
      unchanged_render_count: 1,
      render_trigger_unknown_count: 0,
      request_count: 5,
      duplicate_request_count: 3,
      query_count: 3,
    };
    const base = latencyPanelInput({ metrics });
    const input: JsonObject = {
      ...base,
      aggregates: { ...asObject(base.aggregates), requests: [serviceShapedRequestGroup()] },
    };

    const ids = metricCardIds(await answerFor('generate-panel', input));
    expect(ids).toContain('request_count');
    expect(ids).toContain('duplicate_request_count');
    // Still drawn from the computed vocabulary, in its order.
    const positions = ids.map((id) => COMPUTED_METRIC_IDS.findIndex((known) => known === id));
    expect(positions).not.toContain(-1);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });
});

/* -------------------------------------------------------------------------------------------------
 * property 5 — purity and the provider contract
 * ---------------------------------------------------------------------------------------------- */

/** The modules whose text the purity scan reads. */
const PURE_MODULE_PATHS: readonly string[] = [
  './deterministic.ts',
  '../deterministic/rules.ts',
  '../deterministic/templates.ts',
];

/**
 * Tokens that would make an answer depend on something other than its request.
 *
 * A clock or a randomness source makes two identical calls differ; a filesystem,
 * network or environment read makes an answer depend on the machine it ran on.
 * The dynamic assertions below prove the first two for the paths they exercise;
 * this list is what proves all four for every path, including the ones no
 * fixture reaches.
 */
const IMPURE_TOKENS: readonly string[] = [
  'Math.random',
  'Date.now',
  'new Date',
  'performance.now',
  'process.env',
  'process.hrtime',
  'node:fs',
  'node:http',
  'node:https',
  'node:net',
  'node:child_process',
  'require(',
  'fetch(',
  'crypto.randomUUID',
];

describe('property 5: pure — the same request always yields the same bytes', () => {
  for (const stageCase of STAGE_CASES) {
    it(`answers a ${stageCase.stage} request byte-identically when it is repeated`, async () => {
      const request = requestFor(stageCase.stage, stageCase.input);
      const first = okValue(await stageCase.call(request));
      const second = okValue(await stageCase.call(request));

      expect(canonical(second.raw)).toBe(canonical(first.raw));
      expect(JSON.stringify(second.raw)).toBe(JSON.stringify(first.raw));
    });
  }

  it('repeats free text and tool selection byte-identically', async () => {
    const textRequest = requestFor('analyze', analyzeInput());
    const firstText = okValue(await provider.generateText(textRequest));
    const secondText = okValue(await provider.generateText(textRequest));
    expect(secondText.text).toBe(firstText.text);

    const toolRequest = requestFor('investigate', toolCallInput());
    const firstCalls = okValue(await provider.callTools(toolRequest, CODE_TOOLS));
    const secondCalls = okValue(await provider.callTools(toolRequest, CODE_TOOLS));
    expect(JSON.stringify(secondCalls.calls)).toBe(JSON.stringify(firstCalls.calls));
  });

  it('carries the same construction in its free text as in its structured answer', async () => {
    const input = analyzeInput();
    const text = okValue(await provider.generateText(requestFor('analyze', input)));
    const attempt = okValue(
      await provider.generateStructured(analysisMirror, requestFor('analyze', input)),
    );

    // The free-text path serialises the same construction the structured path
    // parses, which is why a caller can use either without a second rule set.
    expect(canonical(JSON.parse(text.text))).toBe(canonical(attempt.raw));
  });

  it('reads no clock and draws no randomness', async () => {
    const randomSpy = vi.spyOn(Math, 'random');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2021-03-04T05:06:07.008Z'));
      const early = okValue(
        await provider.generateStructured(analysisMirror, requestFor('analyze', analyzeInput())),
      );

      vi.setSystemTime(new Date('2033-11-12T13:14:15.016Z'));
      const late = okValue(
        await provider.generateStructured(analysisMirror, requestFor('analyze', analyzeInput())),
      );

      expect(canonical(late.raw)).toBe(canonical(early.raw));
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      randomSpy.mockRestore();
    }
  });

  it('reaches no clock, no randomness, no filesystem, no network and no environment in its source', () => {
    for (const path of PURE_MODULE_PATHS) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source.length).toBeGreaterThan(0);
      for (const token of IMPURE_TOKENS) {
        expect(
          source.includes(token),
          `${path} must not reach ${token}: an answer must depend on its request alone`,
        ).toBe(false);
      }
    }
  });

  it('does not mutate the request it was given', async () => {
    const input = planInput();
    const request = requestFor('plan', input, { sessionId: 'session-zqx-0043' });
    const before = JSON.stringify(sortDeep({ input: request.input, metadata: request.metadata }));

    okValue(await provider.generateStructured(planInputMirror, request));
    okValue(await provider.generateText(request));
    okValue(await provider.callTools(request, CODE_TOOLS));

    const after = JSON.stringify(sortDeep({ input: request.input, metadata: request.metadata }));
    expect(after).toBe(before);
  });
});

describe('property 5: the ModelProvider contract holds', () => {
  it('reports the provider id the configuration and the store agree on', () => {
    expect(provider.id).toBe(PROVIDER_ID);
    expect(isModelProvider(provider)).toBe(true);
  });

  it('records its own id as the model when no host configured one', async () => {
    const attempt = okValue(
      await provider.generateStructured(
        understandingMirror,
        requestFor('understand', understandInput()),
      ),
    );
    // No model identifier literal exists in this package, so a stored artifact
    // says honestly that no model produced it.
    expect(attempt.model).toBe(PROVIDER_ID);
  });

  it('reports the model a host configured', async () => {
    const configured = makeProvider({
      config: { providerId: PROVIDER_ID, model: 'host-configured-model-id' },
    });
    const attempt = okValue(
      await configured.generateStructured(
        understandingMirror,
        requestFor('understand', understandInput()),
      ),
    );
    expect(attempt.model).toBe('host-configured-model-id');
  });

  it('refuses a configuration addressed to another implementation', () => {
    const created = createDeterministicProvider({
      config: { providerId: 'some-other-implementation', model: 'host-configured-model-id' },
    });
    const error = errorOf(created);
    expect(error.code).toBe('CONFIG_INVALID');
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
  });

  it('refuses a configuration carrying a blank model identifier', () => {
    const created = createDeterministicProvider({ config: { providerId: '', model: '   ' } });
    expect(errorOf(created).code).toBe('CONFIG_INVALID');
  });

  it('refuses a stage the rules do not implement, without throwing', async () => {
    const request = requestFor('understand', understandInput());
    const unknownStage = {
      ...request,
      metadata: { ...request.metadata, stage: 'interpret' as unknown as PromptStage },
    };

    for (const result of [
      await provider.generateText(unknownStage),
      await provider.generateStructured(understandingMirror, unknownStage),
      await provider.callTools(unknownStage, CODE_TOOLS),
    ]) {
      const error = errorOf(result);
      expect(error.code).toBe('CONFIG_INVALID');
      expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    }
  });

  it('refuses a pre-aborted call before it builds anything', async () => {
    const signal = AbortSignal.abort();
    const request = requestFor('analyze', analyzeInput(), { signal });
    const schema = z.object({ observed: z.array(factMirror) });
    const parseSpy = vi.spyOn(schema, 'safeParse');

    try {
      for (const result of [
        await provider.generateText(request),
        await provider.generateStructured(schema, request),
        await provider.callTools(request, CODE_TOOLS),
      ]) {
        const error = errorOf(result);
        expect(error.code).toBe('MODEL_UNAVAILABLE');
        expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
        expect(error.hint).toBeDefined();
      }
      // Nothing was built, so nothing was parsed.
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * tool selection
 * ---------------------------------------------------------------------------------------------- */

describe('callTools selects by name from the structured context and never executes', () => {
  it('selects the offered tools the context asked for, in a stable order, with derived inputs', async () => {
    const response = okValue(
      await provider.callTools(requestFor('investigate', toolCallInput()), CODE_TOOLS),
    );

    expect(response.calls.map((call) => call.name)).toEqual([
      'whoCalls',
      'findByName',
      'routeForUrl',
    ]);
    expect(response.calls.map((call) => call.id)).toEqual([
      'investigate-1',
      'investigate-2',
      'investigate-3',
    ]);

    // Inputs come from the structured context, not from a template.
    expect(response.calls[0]?.input).toEqual({ symbol: STORE_SYMBOL });
    expect(response.calls[1]?.input).toEqual({ name: WIDGET_SYMBOL });
    expect(response.calls[2]?.input).toEqual({});

    expect(response.providerId).toBe(PROVIDER_ID);
    expect(response.stopReason).toBe(TOOL_CALLS_STOP_REASON);
  });

  it('answers with no calls, rather than an invented name, when nothing offered matches', async () => {
    const response = okValue(
      await provider.callTools(
        requestFor('investigate', toolCallInput({ toolCalls: [{ tool: 'unofferedQuery' }] })),
        CODE_TOOLS,
      ),
    );

    expect(response.calls).toEqual([]);
    expect(response.stopReason).toBe(COMPLETE_STOP_REASON);
  });

  it('answers with no calls when the caller offers no tools at all', async () => {
    const response = okValue(
      await provider.callTools(requestFor('investigate', toolCallInput()), []),
    );
    expect(response.calls).toEqual([]);
    expect(response.stopReason).toBe(COMPLETE_STOP_REASON);
  });

  it('never parses a tool schema and never invokes anything the caller supplied', async () => {
    const schema = z.object({ symbol: z.string() });
    const safeParseSpy = vi.spyOn(schema, 'safeParse');
    const parseSpy = vi.spyOn(schema, 'parse');
    let describedTimes = 0;

    const tools: readonly ToolDefinition[] = [
      {
        name: 'whoCalls',
        get description(): string {
          describedTimes += 1;
          return 'read-only code graph query: whoCalls';
        },
        inputSchema: schema,
      },
    ];

    try {
      const response = okValue(
        await provider.callTools(requestFor('investigate', toolCallInput()), tools),
      );

      expect(response.calls.map((call) => call.name)).toEqual(['whoCalls']);
      expect(safeParseSpy).not.toHaveBeenCalled();
      expect(parseSpy).not.toHaveBeenCalled();
      expect(describedTimes).toBe(0);
    } finally {
      safeParseSpy.mockRestore();
      parseSpy.mockRestore();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The selection boundary that reaches this provider
 *
 * `../factory.ts` is what decides which implementation a host runs behind, and
 * the answer this suite's provider gives is only reachable because that
 * decision defaults here: `DEBUGGEN_PROVIDER` unset selects the rules-based
 * provider, which is what every automated suite and the continuous-integration
 * end-to-end run depend on (AAP §0.5.2, §0.7.1). The behaviours below therefore
 * belong beside this provider rather than in a suite of their own — the
 * offline path must never come to need a credential, a model or a network, and
 * these assertions are what would notice if it did.
 *
 * Every case injects its own environment map, so nothing here mutates
 * `process.env` and no case can observe another's configuration.
 * ---------------------------------------------------------------------------------------------- */

describe('the factory selects this provider by default and never needs a credential', () => {
  /** A model identifier no vendor publishes: the value's content is irrelevant, its presence is not. */
  const CONFIGURED_MODEL = 'model-under-test';

  /** An obviously fake credential, kept short and low-entropy so no secret scanner has to guess. */
  const CONFIGURED_CREDENTIAL = 'unit-test-credential';

  /** The two names the factory reads on the network-backed path (AAP §0.3.4). */
  const ANTHROPIC_ENVIRONMENT: Readonly<Record<string, string>> = {
    DEBUGGEN_PROVIDER: 'anthropic',
    DEBUGGEN_MODEL: CONFIGURED_MODEL,
    ANTHROPIC_API_KEY: CONFIGURED_CREDENTIAL,
  };

  it('defaults to this provider when nothing is configured', () => {
    expect(DEFAULT_PROVIDER_ID).toBe(PROVIDER_ID);

    const provider = okValue(createModelProvider({ env: {} }));
    expect(provider.id).toBe(PROVIDER_ID);
    expect(isModelProvider(provider)).toBe(true);
  });

  it('constructs this provider with neither a credential nor a model', () => {
    const provider = okValue(createModelProvider({ env: { DEBUGGEN_PROVIDER: PROVIDER_ID } }));
    expect(provider.id).toBe(PROVIDER_ID);

    // The configuration the factory resolved on this path carries no model at
    // all, which is what this provider is handed nothing for: constructed
    // without a configuration it records its own id, so an artifact never
    // claims a model produced it.
    const config = okValue(resolveProviderConfig({ DEBUGGEN_PROVIDER: PROVIDER_ID }));
    expect(config.model).toBe('');
    expect(config.apiKey).toBeUndefined();
  });

  it('reads a padded, mixed-case selection and a blank variable the way a hand-edited .env means them', () => {
    const padded = okValue(createModelProvider({ env: { DEBUGGEN_PROVIDER: '  Deterministic ' } }));
    expect(padded.id).toBe(PROVIDER_ID);

    // `.env.example` ships both of these blank, so blank has to mean unset
    // rather than "a model called nothing" and "an empty credential".
    const blank = okValue(
      createModelProvider({
        env: { DEBUGGEN_PROVIDER: '   ', DEBUGGEN_MODEL: '', ANTHROPIC_API_KEY: '' },
      }),
    );
    expect(blank.id).toBe(PROVIDER_ID);
  });

  it('refuses the network-backed path without a credential, in AAP §0.5.5 wording', () => {
    const error = errorOf(
      createModelProvider({
        env: { DEBUGGEN_PROVIDER: 'anthropic', DEBUGGEN_MODEL: CONFIGURED_MODEL },
      }),
    );

    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.message).toBe(modelUnavailableMessage(error.code));
    expect(error.message).toBe(
      'Model provider unavailable (CONFIG_INVALID). Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.',
    );
    expect(error.hint).toContain('ANTHROPIC_API_KEY');
    expect(error.hint).toContain(`DEBUGGEN_PROVIDER=${PROVIDER_ID}`);
    expect(asObject(error.details ?? {}).setting).toBe('ANTHROPIC_API_KEY');
  });

  it('refuses the network-backed path without a model, naming DEBUGGEN_MODEL', () => {
    const error = errorOf(
      createModelProvider({
        env: { DEBUGGEN_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: CONFIGURED_CREDENTIAL },
      }),
    );

    expect(error.message).toBe(modelUnavailableMessage('CONFIG_INVALID'));
    expect(error.hint).toContain('DEBUGGEN_MODEL');
    expect(asObject(error.details ?? {}).setting).toBe('DEBUGGEN_MODEL');
  });

  it('never puts a credential in a message, a hint or a details field', () => {
    const failures: readonly DebuggenError[] = [
      errorOf(createModelProvider({ env: { DEBUGGEN_PROVIDER: 'anthropic' } })),
      errorOf(
        createModelProvider({
          env: { DEBUGGEN_PROVIDER: 'anthropic', DEBUGGEN_MODEL: CONFIGURED_MODEL },
        }),
      ),
      errorOf(createModelProvider({ env: { ...ANTHROPIC_ENVIRONMENT, DEBUGGEN_MODEL: ' ' } })),
      errorOf(
        createModelProvider({ env: { ...ANTHROPIC_ENVIRONMENT, DEBUGGEN_PROVIDER: 'oops' } }),
      ),
    ];

    for (const failure of failures) {
      const rendered = canonical({
        message: failure.message,
        hint: failure.hint,
        details: failure.details ?? {},
      });
      expect(rendered).not.toContain(CONFIGURED_CREDENTIAL);
      // Not even a prefix: presence is all a failure may report.
      expect(rendered).not.toContain(CONFIGURED_CREDENTIAL.slice(0, 4));
    }
  });

  it('lists exactly the known provider ids for an unrecognised selection', () => {
    const error = errorOf(createModelProvider({ env: { DEBUGGEN_PROVIDER: 'nonsense' } }));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain(PROVIDER_IDS.join(', '));
    for (const id of PROVIDER_IDS) {
      expect(error.message).toContain(id);
      expect(error.hint).toContain(id);
    }
    expect(asObject(error.details ?? {}).setting).toBe('DEBUGGEN_PROVIDER');
  });

  it('constructs the network-backed provider when both of its settings are present', () => {
    // Proof that the default is a decision rather than the only path the
    // factory can take: the same call with the environment filled in selects
    // the other implementation.
    const provider = okValue(createModelProvider({ env: ANTHROPIC_ENVIRONMENT }));
    expect(provider.id).toBe('anthropic');
    expect(provider.id).not.toBe(PROVIDER_ID);
  });

  it('prefers a host override over the environment, one setting at a time', () => {
    const config = okValue(
      resolveProviderConfig(ANTHROPIC_ENVIRONMENT, { providerId: PROVIDER_ID }),
    );

    expect(config.providerId).toBe(PROVIDER_ID);
    // The override replaced the selection only; the remaining settings were
    // still read for the host.
    expect(config.model).toBe(CONFIGURED_MODEL);
    expect(okValue(createModelProvider({ env: ANTHROPIC_ENVIRONMENT, overrides: config })).id).toBe(
      PROVIDER_ID,
    );
  });

  it('refuses a malformed budget instead of quietly defaulting it', () => {
    const malformed: readonly (readonly [string, number])[] = [
      ['maxTokens', 0],
      ['temperature', -1],
      // The selector refuses exactly what the network-backed provider would
      // refuse: the messages API deprecated the sampling temperature and
      // rejects every value but one, so a plausible-looking 0.7 is a
      // configuration failure here rather than a 400 on every later call.
      ['temperature', 0.7],
      ['timeoutMs', 1.5],
      ['maxRetries', Number.NaN],
    ];

    for (const [field, value] of malformed) {
      const error = errorOf(resolveProviderConfig({}, { [field]: value }));
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).toContain(field);
      expect(asObject(error.details ?? {}).setting).toBe(field);
    }

    // A host that read its configuration from a file hands over a string; that
    // is coerced, because it is a well-formed number, and kept as a number.
    const coerced = okValue(
      resolveProviderConfig({}, { maxTokens: '512' as unknown as number, maxRetries: 0 }),
    );
    expect(coerced.maxTokens).toBe(512);
    expect(coerced.maxRetries).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * investigate follow-ups: from the selected element to the route and the data layer
 *
 * Shaped the way the investigate stage builds its context
 * (`apps/local-service/src/pipeline/context-builder.ts`, `buildInvestigateRequest`):
 * the validated understanding — which carries the selected element's owner
 * chain as its leading `component` entities rather than the target itself —
 * the executed query log, the remaining budget, and the candidates projected
 * from the log's code nodes.
 * ---------------------------------------------------------------------------------------------- */

/** The route the widget's request reaches, as the code graph names an `api-route` node. */
const TRACED_ROUTE_NAME = '/tally/rows';

/** A code-graph match as a query payload lists it. */
function graphNode(kind: string, name: string, file: string): JsonObject {
  return { nodeId: `${kind}:${name}@${file}`, kind, name, file };
}

const WIDGET_NODE = graphNode('component', WIDGET_SYMBOL, WIDGET_FILE);
const TRACED_ROUTE_NODE = graphNode('api-route', TRACED_ROUTE_NAME, ROUTE_FILE);
const TRACED_STORE_NODE = graphNode('db-call', STORE_SYMBOL, STORE_FILE);

/** The component-to-route trace the provider proposes for the found widget. */
const COMPONENT_TRACE: JsonObject = {
  tool: 'pathBetween',
  from: { name: WIDGET_SYMBOL, kind: 'component' },
  to: { kind: 'api-route' },
  edgeKinds: ['calls', 'routes-to'],
};

/** The route-to-data-layer trace it proposes once the component trace reached a route. */
const ROUTE_TRACE: JsonObject = {
  tool: 'pathBetween',
  from: { file: ROUTE_FILE, kind: 'api-route' },
  to: { kind: 'db-call' },
};

/** One successful run of the query log, in the shape the investigate stage records it. */
function executedRun(index: number, request: JsonObject, payload: JsonValue): JsonObject {
  const found = Array.isArray(payload) ? payload.length > 0 : true;
  const returned = Array.isArray(payload) ? payload.length : 1;
  return {
    index,
    request,
    outcome: {
      ok: true,
      value: {
        tool: request.tool ?? null,
        request,
        found,
        total: returned,
        returned,
        truncated: false,
        clamped: [],
        payload,
      },
    },
  };
}

/** The seed turn: `findByName` resolving the widget, the only component of the chain the log found. */
const SEED_RUN = executedRun(0, { tool: 'findByName', name: WIDGET_SYMBOL }, [WIDGET_NODE]);

/** The component trace's run: the widget reaches the traced route. */
const COMPONENT_TRACE_RUN = executedRun(1, COMPONENT_TRACE, {
  nodes: [WIDGET_NODE, TRACED_ROUTE_NODE],
  edges: [],
  depth: 1,
});

/** The route trace's run: the traced route reaches its data-layer call. */
const ROUTE_TRACE_RUN = executedRun(2, ROUTE_TRACE, {
  nodes: [TRACED_ROUTE_NODE, TRACED_STORE_NODE],
  edges: [],
  depth: 1,
});

/**
 * Bare matches an unrelated seed turned up: components nobody named, on paths
 * that sort before every traced file, so a traced route without its bonus would
 * rank with them and fall off the twelve-entry shortlist.
 */
const DECOY_RUN = executedRun(
  3,
  { tool: 'findByName', name: 'Panel' },
  Array.from({ length: 14 }, (_, n) =>
    graphNode(
      'component',
      `DecoyPanel${String(n).padStart(2, '0')}`,
      `src/aa-decoys/panel-${String(n).padStart(2, '0')}.tsx`,
    ),
  ),
);

/** How an investigate-stage context may be varied. */
interface TraceContextOptions {
  /** The runs after the seed turn, in execution order. */
  readonly runs: readonly JsonObject[];
  /** Query turns still available. */
  readonly remainingQueries: number;
  /** The understanding's component entities; the owner chain, innermost first, by default. */
  readonly components?: readonly string[];
}

/** The candidates the context builder projects from a query log: every code node a payload named. */
function projectedCandidates(runs: readonly JsonObject[]): JsonObject[] {
  const candidates: JsonObject[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const node = value as Record<string, unknown>;
    if (
      typeof node.file === 'string' &&
      typeof node.name === 'string' &&
      typeof node.kind === 'string'
    ) {
      const identity = `${node.file}|${node.name}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        candidates.push({ file: node.file, symbol: node.name, kind: node.kind });
      }
    }
    for (const [key, entry] of Object.entries(node)) {
      if (key !== 'request') {
        visit(entry);
      }
    }
  };
  runs.forEach(visit);
  return candidates;
}

/** The structured context of one investigate turn. */
function traceContext(options: TraceContextOptions): JsonObject {
  const components = options.components ?? [WIDGET_SYMBOL, FORM_SYMBOL];
  const runs = [SEED_RUN, ...options.runs];
  return {
    understanding: {
      category: 'slow-interaction',
      signalsNeeded: ['interaction', 'fetch'],
      entities: components.map((name) => ({ kind: 'component', name })),
      searchHints: [],
    },
    toolCatalog: 'findByName, pathBetween',
    queryResults: runs,
    remainingQueries: options.remainingQueries,
    candidates: projectedCandidates(runs),
  };
}

/** A path-query batch, or the final investigation. */
const investigateReplyMirror = z.union([
  z.object({
    queries: z
      .array(
        z.object({
          tool: z.literal('pathBetween'),
          from: z.record(z.string(), z.string()),
          to: z.record(z.string(), z.string()),
          edgeKinds: z.array(z.string().min(1)).optional(),
        }),
      )
      .min(1),
  }),
  investigationMirror,
]);

/** Answers one investigate turn, unwrapped to a plain object. */
async function investigateReply(
  input: JsonObject,
  variant?: string,
): Promise<Record<string, unknown>> {
  const request = requestFor('investigate', input, variant === undefined ? {} : { variant });
  return asObject(
    okValue(await provider.generateStructured(investigateReplyMirror, request)).value,
  );
}

describe('investigate follow-ups: the selected element is followed to its route and data layer', () => {
  it('traces each component of the understanding the log found to an API route', async () => {
    const reply = await investigateReply(traceContext({ runs: [], remainingQueries: 8 }));

    // The form is in the chain but the log never found it, so it is not traced.
    expect(reply.queries).toEqual([COMPONENT_TRACE]);
  });

  it('reads the owner chain from a carried target as well', async () => {
    const reply = await investigateReply({
      ...understandInput(),
      queryResults: [SEED_RUN],
      remainingQueries: 8,
      candidates: projectedCandidates([SEED_RUN]),
    });

    expect(reply.queries).toEqual([COMPONENT_TRACE]);
  });

  it('traces the route a component trace reached on to its data-layer call', async () => {
    const reply = await investigateReply(
      traceContext({ runs: [COMPONENT_TRACE_RUN], remainingQueries: 7 }),
    );

    expect(reply.queries).toEqual([ROUTE_TRACE]);
  });

  it('answers once the walk is done, keeping the traced route and data layer on the shortlist', async () => {
    const reply = await investigateReply(
      traceContext({
        runs: [COMPONENT_TRACE_RUN, ROUTE_TRACE_RUN, DECOY_RUN],
        remainingQueries: 5,
      }),
    );

    expect(reply.queries).toBeUndefined();
    const relevant = asArray(reply.relevantFiles).map((entry) => asObject(entry));
    expect(relevant.length).toBeLessThanOrEqual(12);
    const files = relevant.map((entry) => asString(entry.file));
    expect(files).toContain(WIDGET_FILE);
    expect(files).toContain(ROUTE_FILE);
    expect(files).toContain(STORE_FILE);
    const route = relevant.find((entry) => entry.file === ROUTE_FILE);
    expect(asString(route?.reason)).toContain(WIDGET_SYMBOL);

    const flows = asArray(reply.flows).map((flow) => asString(flow));
    expect(
      flows.some((flow) => flow.includes(WIDGET_SYMBOL) && flow.includes(TRACED_ROUTE_NAME)),
    ).toBe(true);
    expect(
      flows.some((flow) => flow.includes(TRACED_ROUTE_NAME) && flow.includes(STORE_SYMBOL)),
    ).toBe(true);
  });

  it('proposes nothing when the understanding names no component, or no budget remains', async () => {
    const unnamed = await investigateReply(
      traceContext({ runs: [], remainingQueries: 8, components: [] }),
    );
    const exhausted = await investigateReply(traceContext({ runs: [], remainingQueries: 0 }));

    for (const reply of [unnamed, exhausted]) {
      expect(reply.queries).toBeUndefined();
      expect(asArray(reply.relevantFiles).length).toBeGreaterThan(0);
    }
  });

  it('proposes the same follow-ups however the question is worded', async () => {
    const input = traceContext({ runs: [], remainingQueries: 8 });

    const first = await investigateReply(input, 'first');
    const second = await investigateReply(input, 'second-asked-with-completely-different-words');

    expect(second).toEqual(first);
  });
});

/* -------------------------------------------------------------------------------------------------
 * planning from a shortlist: patches go where only a patch can measure
 *
 * Shaped the way the plan stage builds its context (`buildPlanRequest`): the
 * validated understanding, whose leading `component` entities are the selected
 * element's owner chain, and the investigation's relevant files — which carry a
 * file, a symbol and a score but no graph kind — ranked with the chain's
 * components first.
 * ---------------------------------------------------------------------------------------------- */

/** A shortlisted file, as the investigation reports it. */
function shortlisted(file: string, symbol: string, score: number): JsonObject {
  return {
    file,
    symbol,
    reason: 'The code graph associates this symbol with the question.',
    score,
  };
}

/** The plan context for a shortlist whose three best-ranked entries are the chain's components. */
function shortlistPlanInput(): JsonObject {
  return {
    understanding: {
      category: 'slow-interaction',
      signalsNeeded: ['interactions', 'react', 'fetch', 'http', 'routeHandlers', 'functions', 'pg'],
      entities: [
        { kind: 'component', name: FORM_SYMBOL, file: FORM_FILE },
        { kind: 'component', name: WIDGET_SYMBOL, file: WIDGET_FILE },
        { kind: 'component', name: TILE_SYMBOL, file: TILE_FILE },
      ],
      searchHints: [],
    },
    investigation: {
      relevantFiles: [
        shortlisted(FORM_FILE, FORM_SYMBOL, 1),
        shortlisted(WIDGET_FILE, WIDGET_SYMBOL, 1),
        shortlisted(TILE_FILE, TILE_SYMBOL, 1),
        shortlisted(ROUTE_FILE, ROUTE_SYMBOL, 0.5),
        shortlisted(STORE_FILE, STORE_SYMBOL, 0.4),
      ],
      flows: [],
    },
    adapterCatalog: [
      {
        id: 'runtime-adapter',
        actionTypes: [
          'interaction-tracking',
          'react-render-tracking',
          'fetch-tracking',
          'db-query-tracking',
        ],
        mode: 'runtime',
        signals: ['interactions', 'react', 'componentTree', 'fetch', 'pg'],
      },
      {
        id: 'patch-adapter',
        actionTypes: ['server-span', 'function-timing'],
        mode: 'patch',
        signals: ['http', 'routeHandlers', 'functions'],
      },
    ],
  };
}

describe('plan: a shortlist led by components still spends its patches where they measure', () => {
  it('never asks to time a component the understanding names, and times the functions behind it', async () => {
    const plan = await answerFor('plan', shortlistPlanInput());
    const targets = asArray(plan.instrumentationTargets).map(asObject);
    const patched = targets.filter((target) => target.type === 'function-timing');

    for (const symbol of [FORM_SYMBOL, WIDGET_SYMBOL, TILE_SYMBOL]) {
      expect(
        targets.some((target) => target.symbol === symbol && target.type === 'function-timing'),
        `${symbol} is a component; a timing wrapper cannot be applied to it`,
      ).toBe(false);
    }
    expect(patched.map((target) => target.symbol)).toEqual(
      expect.arrayContaining([ROUTE_SYMBOL, STORE_SYMBOL]),
    );
    // The components' renders are still observed, by the page-wide hook.
    expect(
      targets.some(
        (target) =>
          target.type === 'react-render-tracking' && target.file === '.' && target.symbol === '*',
      ),
    ).toBe(true);
  });

  it('spends no slot on a runtime action a page-wide hook already covers', async () => {
    // The same shortlist with the components' graph kind carried, as the
    // investigate stage's own candidates carry it: each would otherwise take a
    // slot for a render hook the page-wide one already installs.
    const input = shortlistPlanInput();
    const investigation = asObject(input.investigation);
    const plan = await answerFor('plan', {
      ...input,
      investigation: {
        ...investigation,
        relevantFiles: asArray(investigation.relevantFiles).map((entry) => {
          const file = asObject(entry);
          return file.score === 1 ? { ...file, kind: 'component' } : file;
        }),
      },
    } as JsonObject);
    const targets = asArray(plan.instrumentationTargets).map(asObject);
    const types = targets.map((target) => asString(target.type));

    for (const type of ['interaction-tracking', 'react-render-tracking', 'fetch-tracking']) {
      expect(types.filter((entry) => entry === type)).toHaveLength(1);
    }
    expect(
      targets.filter((target) => target.type === 'function-timing').map((target) => target.symbol),
    ).toEqual(expect.arrayContaining([ROUTE_SYMBOL, STORE_SYMBOL]));
  });
});
