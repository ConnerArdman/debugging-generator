/**
 * Colocated unit suite for `./context-builder.ts`, the one place the reasoning
 * pipeline assembles a model request (AAP §0.4.2, §0.5.2, §0.5.3, §0.7.1).
 *
 * The module is the pipeline's privacy checkpoint and the owner of every
 * placeholder contract, and both fail only at runtime inside a real session
 * when they are wrong. So this suite pins, in order:
 *
 * 1. **Placeholder drift.** Every committed `prompts/<stage>/vNNN.md` names
 *    exactly the `{{token}}` set `STAGE_PLACEHOLDERS[stage]` records, every
 *    stage builder supplies exactly that set, a rendered prompt carries no
 *    residual token, and `generate-panel` is recorded but never built here.
 * 2. **One capped context, two payloads.** The rendered `prompt` and the
 *    structured `input` are derived from the same capped object; every cap of
 *    `CONTEXT_LIMITS` is enforced; the byte budget gives sections up in its
 *    documented order and never gives up the understanding, the analysis or an
 *    evidence id; `truncated` names sections only; output is deterministic and
 *    no argument is ever mutated; the prompt version resolves through
 *    `loadVersion` exactly when one is supplied or recorded.
 * 3. **The outbound guard.** A denied pattern that survived ingest refuses the
 *    build with a typed `Err`, returns no request and leaks nothing into the
 *    error or the log; the compliant output of the first checkpoint builds.
 * 4. **The `{{outputSchema}}` documents.** Each is rendered from (or delegates
 *    to) its upstream owner, accepts what the upstream schema accepts, rejects
 *    what it rejects, is byte-stable and names no application.
 *
 * Everything is in-process: a scripted `PromptLoader` double, tripwire code
 * handles that record any read, hand-built fixtures and a capturing logger. No
 * store, no provider, no network and no environment mutation; the only files
 * read are the committed prompt files and the committed no-hardcoding policy,
 * and nothing is ever written.
 *
 * **Secret-shaped fixtures are assembled at runtime.** This file is tracked and
 * `scripts/check-secrets.mjs` scans it with the same rule classes the outbound
 * guard implements, so no credential prefix, token body or credentialed URI
 * appears as a contiguous literal: {@link assemble} joins short fragments and
 * {@link cycle} builds bodies from an alphabet, as
 * `packages/model-provider/src/redact-guard.test.ts` does. Fixture vocabulary
 * is invented and generic; no name from any real application appears here.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { types as utilTypes } from 'node:util';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  CAPTURE_SIGNALS,
  INSTRUMENTATION_ACTION_TYPES,
  PROBLEM_CATEGORIES,
  PROBLEM_ENTITY_KINDS,
  instrumentationPlanInputSchema,
  instrumentationPlanSchema,
  problemUnderstandingSchema,
  type InstrumentationPlan,
  type ProblemUnderstanding,
  type SelectedTarget,
} from '@debuggen/instrumentation';
import {
  PROMPT_STAGES,
  REDACTION_MARKER,
  REDACTION_RULE_IDS,
  URL_QUERY_MASK,
  type JsonObject,
  type PromptFile,
  type PromptLoader,
  type PromptStage,
  type RedactionRuleId,
} from '@debuggen/model-provider';
import { CONFIDENCE_LEVELS, panelSpecInputJsonSchemaText } from '@debuggen/panel-schema';
import {
  analysisFindingsSchema,
  parseSessionRecord,
  sessionRecordSchema,
  type RelevantFile,
  type SessionRecord,
} from '@debuggen/protocol';
import {
  DebuggenError,
  createConsoleLogger,
  err,
  ok,
  type LogRecord,
  type Logger,
  type Result,
} from '@debuggen/shared';

import { ANALYSIS_INPUT_LIMITS, type AnalysisStageInput } from '../analysis/summarize.js';
import {
  ABSENT_VALUE,
  CONTEXT_BUILDER_STAGES,
  CONTEXT_LIMITS,
  INVESTIGATE_QUERY_BATCH_FIELD,
  PAYLOAD_BUDGET_STEPS,
  PROTECTED_PAYLOAD_SECTIONS,
  STAGE_OUTPUT_SCHEMA_SOURCES,
  STAGE_PLACEHOLDERS,
  TRUNCATION_MARKER,
  applyPayloadBudget,
  capExcerpt,
  capList,
  capText,
  createContextBuilder,
  createPipelineStageContext,
  estimatePayloadBytes,
  outputSchemaFor,
  resolveContextLimits,
  toBoundedJson,
  toPromptJson,
  type ContextBuilder,
  type ContextBuilderDeps,
  type ContextBuilderStage,
  type PipelineCodeHandles,
  type PipelineStageContext,
  type StageRequestBuild,
} from './context-builder.js';

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

/** The inclusive character range from `first` to `last`, by code unit. */
function charRange(first: string, last: string): string {
  let result = '';
  for (let code = first.charCodeAt(0); code <= last.charCodeAt(0); code += 1) {
    result += String.fromCharCode(code);
  }
  return result;
}

/** A deterministic body of `length` characters cycled from `alphabet`. */
function cycle(alphabet: string, length: number): string {
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += alphabet.charAt(index % alphabet.length);
  }
  return result;
}

/**
 * Joins fixture fragments. Every call keeps a credential prefix, token body or
 * URI authority from appearing as one contiguous literal in this tracked file.
 */
function assemble(...fragments: readonly string[]): string {
  return fragments.join('');
}

/** Letters and digits, rotated so no run spells a word. */
const ALNUM = charRange('A', 'Z') + charRange('a', 'z') + charRange('0', '9');

/** Base64url: the alphabet of an opaque provider credential. */
const URLSAFE = ALNUM + '-_';

/**
 * Deeply freezes plain data — objects with the default or a null prototype,
 * and arrays — so any write to an argument throws in this strict-mode module.
 * Proxies (the tripwire handles), functions and class instances such as an
 * `AbortSignal` or a logger are left alone: freezing them would either trip
 * a tripwire or freeze state that is not the builder's to touch.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
    return value;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * A structural, key-sorted snapshot of plain data, for before/after
 * comparisons. Written by hand rather than with `JSON.stringify`, which looks
 * up `toJSON` on every object and would trip the tripwire handles: a proxy is
 * recorded as a marker without being touched, a function or class instance
 * by its tag, and a repeated reference as a marker.
 */
function snapshot(value: unknown): string {
  const seen = new Set<object>();
  const plain = (entry: unknown): unknown => {
    if (typeof entry === 'function') {
      return '[function]';
    }
    if (typeof entry === 'bigint') {
      return `${entry.toString()}n`;
    }
    if (typeof entry !== 'object' || entry === null) {
      return entry;
    }
    if (utilTypes.isProxy(entry)) {
      return '[proxy]';
    }
    if (seen.has(entry)) {
      return '[seen]';
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      const list: readonly unknown[] = entry;
      return list.map(plain);
    }
    const prototype: unknown = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) {
      return Object.prototype.toString.call(entry);
    }
    const record = entry as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, plain(record[key])]),
    );
  };
  return JSON.stringify(plain(value));
}

/** The value of an `Ok`, or a thrown assertion naming the error. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`Expected Ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** The error of an `Err`, or a thrown assertion. */
function expectErr<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error('Expected Err, got Ok.');
  }
  expect(result.error).toBeInstanceOf(DebuggenError);
  expect(Object.hasOwn(result, 'value')).toBe(false);
  return result.error;
}

/** Everything an error exposes to a caller, as one string. */
function errorText(error: DebuggenError): string {
  return [error.code, error.message, error.hint ?? '', JSON.stringify(error.details ?? {})].join(
    '\n',
  );
}

/** A logger that records every record at every level. */
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

/** A clock that advances on every read; no builder may let it reach a payload. */
function steppingClock(start: number): () => number {
  let reads = 0;
  return () => {
    reads += 1;
    return start + reads * 37;
  };
}

/** The placeholder grammar of `renderPrompt`, reproduced for the drift test. */
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Every `{{token}}` key a template names, as a sorted set. */
function placeholderTokens(text: string): string[] {
  return [
    ...new Set([...text.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? '')),
  ].sort();
}

// ---------------------------------------------------------------------------
// Committed repository files (read-only)
// ---------------------------------------------------------------------------

/** `apps/local-service/prompts/`, resolved from this file. */
const PROMPTS_DIR = new URL('../../prompts/', import.meta.url);

/** The committed no-hardcoding policy: identifiers and route paths of the demo corpus. */
const POLICY_FILE = new URL('../../../../scripts/no-hardcoding.policy.json', import.meta.url);

/** The committed prompt version files of one stage, sorted by version. */
function committedVersions(stage: PromptStage): string[] {
  return readdirSync(new URL(`${stage}/`, PROMPTS_DIR))
    .filter((name) => /^v\d{3}\.md$/.test(name))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
}

/** The text of one committed prompt file. */
function committedPrompt(stage: PromptStage, version: string): string {
  return readFileSync(new URL(`${stage}/${version}.md`, PROMPTS_DIR), 'utf8');
}

/** The `current` version the committed manifest names for each stage. */
function manifestCurrentVersions(): Readonly<Record<string, string>> {
  const manifest: unknown = JSON.parse(readFileSync(new URL('manifest.json', PROMPTS_DIR), 'utf8'));
  const stages =
    typeof manifest === 'object' && manifest !== null
      ? (manifest as { readonly stages?: unknown }).stages
      : undefined;
  if (typeof stages !== 'object' || stages === null) {
    throw new Error('prompts/manifest.json has no stages object.');
  }
  const current: Record<string, string> = {};
  for (const [stage, entry] of Object.entries(stages as Record<string, unknown>)) {
    const version =
      typeof entry === 'object' && entry !== null
        ? (entry as { readonly current?: unknown }).current
        : undefined;
    if (typeof version !== 'string') {
      throw new Error(`prompts/manifest.json names no current version for ${stage}.`);
    }
    current[stage] = version;
  }
  return current;
}

/** The demo corpus' identifiers and route paths, which no prompt-bound text may name. */
function forbiddenVocabulary(): { readonly identifiers: string[]; readonly routePaths: string[] } {
  const policy: unknown = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
  const read = (key: string): string[] => {
    const list =
      typeof policy === 'object' && policy !== null
        ? (policy as Record<string, unknown>)[key]
        : undefined;
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) {
      throw new Error(`scripts/no-hardcoding.policy.json has no string list "${key}".`);
    }
    return list;
  };
  return { identifiers: read('identifiers'), routePaths: read('routePaths') };
}

/** Every stage's current committed prompt, read once. */
const COMMITTED_PROMPTS: Readonly<Record<PromptStage, string>> = Object.freeze(
  Object.fromEntries(
    PROMPT_STAGES.map((stage) => [stage, committedPrompt(stage, 'v001')] as const),
  ) as Record<PromptStage, string>,
);

/** A superseded version: the committed text under a different first line, same placeholders. */
const SUPERSEDED_VERSION = 'v000';
const SUPERSEDED_HEADER = '# Superseded fixture prompt v000';

function supersededText(text: string): string {
  const firstBreak = text.indexOf('\n');
  return `${SUPERSEDED_HEADER}${firstBreak >= 0 ? text.slice(firstBreak) : '\n'}`;
}

// ---------------------------------------------------------------------------
// The prompt loader double
// ---------------------------------------------------------------------------

/** Prompt texts by stage and version. */
type PromptLibrary = Readonly<Partial<Record<PromptStage, Readonly<Record<string, string>>>>>;

/** A scripted `PromptLoader` and its call recorders. */
interface LoaderDouble {
  readonly loader: PromptLoader;
  readonly load: Mock<(stage: PromptStage) => Result<PromptFile, DebuggenError>>;
  readonly loadVersion: Mock<
    (stage: PromptStage, version: string) => Result<PromptFile, DebuggenError>
  >;
  readonly versions: Mock<() => Result<Readonly<Record<PromptStage, string>>, DebuggenError>>;
  readonly clearCache: Mock<() => void>;
}

/** The version the double's manifest calls current. */
const CURRENT_VERSION = 'v001';

/**
 * A `PromptLoader` over an in-memory library: `load` serves the current
 * version, `loadVersion` serves any version the library holds (superseded
 * ones included, as the real loader does) and both answer an unknown stage or
 * version with a typed `Err`. Every method is a recorder.
 */
function promptLoaderDouble(library: PromptLibrary): LoaderDouble {
  const fileFor = (stage: PromptStage, version: string): Result<PromptFile, DebuggenError> => {
    const text = library[stage]?.[version];
    if (text === undefined) {
      return err(
        new DebuggenError('CONFIG_INVALID', `The double holds no ${stage} prompt ${version}.`, {
          details: { stage, version },
        }),
      );
    }
    return ok({ stage, version, text, path: `/virtual/prompts/${stage}/${version}.md` });
  };
  const load = vi.fn((stage: PromptStage) => fileFor(stage, CURRENT_VERSION));
  const loadVersion = vi.fn((stage: PromptStage, version: string) => fileFor(stage, version));
  const versions = vi.fn((): Result<Readonly<Record<PromptStage, string>>, DebuggenError> =>
    ok(
      Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, CURRENT_VERSION])) as Record<
        PromptStage,
        string
      >,
    ),
  );
  const clearCache = vi.fn(() => undefined);
  const loader: PromptLoader = {
    promptsDir: '/virtual/prompts',
    manifestPath: '/virtual/prompts/manifest.json',
    load,
    loadVersion,
    versions,
    clearCache,
  };
  return { loader, load, loadVersion, versions, clearCache };
}

/** The committed prompts, plus a superseded `v000` of each. */
function committedLibrary(): PromptLibrary {
  return Object.fromEntries(
    PROMPT_STAGES.map((stage) => {
      const text = COMMITTED_PROMPTS[stage];
      return [stage, { [CURRENT_VERSION]: text, [SUPERSEDED_VERSION]: supersededText(text) }];
    }),
  );
}

/** Delimiters of a probe template; no builder value can contain them. */
const PROBE_OPEN = '\u27e6';
const PROBE_CLOSE = '\u27e7';

/**
 * A template that names exactly the stage's placeholder set, each wrapped in
 * delimiters, so a rendered probe prompt gives back the `values` object the
 * builder supplied, key for key.
 */
function probeTemplate(stage: PromptStage): string {
  return STAGE_PLACEHOLDERS[stage]
    .map((key) => `${PROBE_OPEN}${key}${PROBE_CLOSE}{{${key}}}${PROBE_OPEN}/${key}${PROBE_CLOSE}`)
    .join('\n');
}

function probeLibrary(): PromptLibrary {
  return Object.fromEntries(
    PROMPT_STAGES.map((stage) => [stage, { [CURRENT_VERSION]: probeTemplate(stage) }]),
  );
}

/** The `values` a builder supplied, recovered from a rendered probe prompt. */
function probeValues(prompt: string): Record<string, string> {
  const pattern = new RegExp(
    `${PROBE_OPEN}([A-Za-z0-9_.]+)${PROBE_CLOSE}([\\s\\S]*?)${PROBE_OPEN}/\\1${PROBE_CLOSE}`,
    'g',
  );
  const values: Record<string, string> = {};
  for (const match of prompt.matchAll(pattern)) {
    const key = match[1];
    if (key !== undefined) {
      values[key] = match[2] ?? '';
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Fixture constants — invented, generic vocabulary
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-context-suite';
const CAPTURE_ID = 'capture-context-suite';
const PROJECT_ROOT = '/workspace/atlas-console';
const PROJECT_NAME = 'atlas-console';
const DEV_SERVER_URL = 'http://127.0.0.1:4310';
const CURRENT_URL = `${DEV_SERVER_URL}/reports?view=${URL_QUERY_MASK}`;
const FIXED_EPOCH_MS = 1_767_225_600_000;

/** A token planted in every question; it may reach a prompt and never a structured input. */
const QUESTION_SENTINEL = 'zephyrquokkasentinel';
const BASE_QUESTION = `Why does the ${QUESTION_SENTINEL} toolbar feel sluggish after I press export?`;
const FOLLOW_UP_QUESTION = `Why did the ${QUESTION_SENTINEL} report request run twice?`;

const TARGET: SelectedTarget = deepFreeze({
  selector: 'main > section.toolbar > button.export',
  tagName: 'BUTTON',
  text: 'Export report',
  componentChain: ['ExportControl', 'ToolbarRow', 'WorkspaceShell'],
  url: CURRENT_URL,
});

const UNDERSTANDING: ProblemUnderstanding = deepFreeze({
  category: 'performance',
  signalsNeeded: ['interactions', 'fetch', 'http'],
  entities: [{ kind: 'component', name: 'ExportControl' }],
  searchHints: ['export', 'toolbar'],
});

/** The project summary shape, taken from the handle type rather than from code-analysis. */
type ProjectSummaryFixture = PipelineCodeHandles['projectSummary'];

const PROJECT_SUMMARY: ProjectSummaryFixture = deepFreeze({
  projectRoot: PROJECT_ROOT,
  projectName: PROJECT_NAME,
  framework: { name: 'next', version: '16.3.5' },
  routerStyle: 'app',
  typescript: { enabled: true, strict: true, tsConfigFile: 'tsconfig.json' },
  packageManager: 'pnpm',
  databaseAccess: { style: 'pg', pgPoolModule: 'src/server/pool.ts', callSiteCount: 3 },
  entryPoints: ['app/layout.tsx', 'app/page.tsx'],
  routes: [],
  notableDirectories: ['app', 'src/components', 'src/server'],
  dependencies: [
    { name: 'next', versionRange: '16.3.5', dev: false },
    { name: 'pg', versionRange: '8.23.0', dev: false },
  ],
  counts: {
    files: 42,
    symbols: 310,
    components: 18,
    handlers: 9,
    apiCalls: 4,
    apiRoutes: 0,
    serverFunctions: 6,
    dbCalls: 3,
  },
  truncated: false,
  generatedAt: FIXED_EPOCH_MS,
});

/**
 * A stand-in for a code-analysis handle that records every read. The builder
 * reads only the project summary, so a recorded read is a boundary violation
 * (a builder querying the graph would be a repository dump, AAP §0.4.2). The
 * cast is what lets a proxy stand in for a type this suite does not import;
 * the empty read log each test checks is what keeps it honest.
 */
function tripwire(label: string, reads: string[]): object {
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        reads.push(`${label}.get ${String(key)}`);
        return undefined;
      },
      has: (_target, key) => {
        reads.push(`${label}.has ${String(key)}`);
        return false;
      },
      ownKeys: () => {
        reads.push(`${label}.ownKeys`);
        return [];
      },
    },
  );
}

/** Code handles whose summary is real data and whose graph, queries and route map are tripwires. */
function codeHandles(
  reads: string[],
  projectSummary: ProjectSummaryFixture = PROJECT_SUMMARY,
): PipelineCodeHandles {
  return {
    graph: tripwire('graph', reads) as unknown as PipelineCodeHandles['graph'],
    queries: tripwire('queries', reads) as unknown as PipelineCodeHandles['queries'],
    routeMap: tripwire('routeMap', reads) as unknown as PipelineCodeHandles['routeMap'],
    projectSummary,
  };
}

/** A stored session record in the status the understand stage runs under. */
function sessionRecord(options: {
  readonly question: string;
  readonly target: SelectedTarget | undefined;
  readonly promptVersions: SessionRecord['promptVersions'];
  readonly projectRoot?: string | undefined;
}): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: options.projectRoot ?? PROJECT_ROOT,
    projectName: PROJECT_NAME,
    devServerUrl: DEV_SERVER_URL,
    boundTab: { tabId: 7, url: CURRENT_URL },
    createdAt: FIXED_EPOCH_MS,
    updatedAt: FIXED_EPOCH_MS,
    status: 'understanding',
    question: options.question,
    followUps: [],
    ...(options.target !== undefined ? { target: options.target } : {}),
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: options.promptVersions,
    provider: { id: 'deterministic' },
  };
}

/** What a test may vary about a stage context. */
interface ContextOptions {
  readonly question?: string | undefined;
  readonly withoutTarget?: boolean | undefined;
  readonly target?: SelectedTarget | undefined;
  readonly promptVersions?: SessionRecord['promptVersions'] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly followUpQuestion?: string | undefined;
  readonly currentUrl?: string | undefined;
  readonly projectSummary?: ProjectSummaryFixture | undefined;
}

/** A stage context and the probes planted in it. */
interface ContextFixture {
  readonly context: PipelineStageContext;
  readonly session: SessionRecord;
  readonly codeReads: string[];
  readonly log: CapturedLogger;
}

/**
 * A stage context built through the module's own `createPipelineStageContext`
 * from a deeply frozen session record, tripwire code handles, a capturing
 * logger and a stepping clock.
 */
function stageContext(options: ContextOptions = {}): ContextFixture {
  const target = options.withoutTarget === true ? undefined : (options.target ?? TARGET);
  const session = deepFreeze(
    sessionRecord({
      question: options.question ?? BASE_QUESTION,
      target,
      promptVersions: options.promptVersions ?? {},
    }),
  );
  const codeReads: string[] = [];
  const log = capturedLogger();
  const context = expectOk(
    createPipelineStageContext({
      session,
      code: codeHandles(codeReads, options.projectSummary),
      logger: log.logger,
      captureId: CAPTURE_ID,
      now: steppingClock(FIXED_EPOCH_MS),
      ...(options.followUpQuestion !== undefined
        ? { followUpQuestion: options.followUpQuestion }
        : {}),
      ...(options.currentUrl !== undefined ? { currentUrl: options.currentUrl } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }),
  );
  return { context, session, codeReads, log };
}

/** A builder over a loader double, with a capturing logger and optional tightened caps. */
interface BuilderFixture {
  readonly builder: ContextBuilder;
  readonly double: LoaderDouble;
  readonly log: CapturedLogger;
}

function builderFixture(
  library: PromptLibrary,
  overrides: Omit<ContextBuilderDeps, 'promptLoader' | 'logger'> = {},
): BuilderFixture {
  const double = promptLoaderDouble(library);
  const log = capturedLogger();
  const builder = createContextBuilder({
    promptLoader: double.loader,
    logger: log.logger,
    config: { provider: 'deterministic' },
    now: steppingClock(FIXED_EPOCH_MS),
    ...overrides,
  });
  return { builder, double, log };
}

// ---------------------------------------------------------------------------
// Stage inputs
// ---------------------------------------------------------------------------

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const EVIDENCE_EVENT_IDS = Object.freeze([
  'evt-interaction-0001',
  'evt-fetch-0002',
  'evt-server-0003',
  'evt-db-0004',
]);

const TOOL_NAMES = Object.freeze(['findByName', 'whoCalls', 'routeForUrl']);
const TOOL_CATALOG =
  'findByName(name): code nodes whose name matches. whoCalls(symbol): callers of a symbol. routeForUrl(url): the route module serving an address.';

/** Executed query runs in the shape the code tools record: a request and its findings. */
function queryRun(index: number): JsonObject {
  return {
    request: { tool: 'findByName', name: `MissingSymbol${String(index)}` },
    result: {
      matches: [
        {
          file: `src/components/Panel${String(index)}.tsx`,
          name: `Panel${String(index)}`,
          kind: 'component',
          score: 0.5,
        },
      ],
    },
  };
}

const RELEVANT_FILES: readonly RelevantFile[] = deepFreeze([
  {
    file: 'src/components/ExportControl.tsx',
    symbol: 'ExportControl',
    reason: 'Owns the selected element.',
    score: 0.9,
  },
  { file: 'src/server/report.ts', symbol: 'buildReport', reason: 'Serves the export.', score: 0.7 },
]);

const ADAPTER_CATALOG = deepFreeze({
  adapters: [
    { id: 'react', claims: ['react-render-tracking', 'state-tracking'], mode: 'runtime' },
    { id: 'nextjs', claims: ['server-span', 'function-timing'], mode: 'patch' },
  ],
});

/** An excerpt row of the analysis stage input. */
type ExcerptFixture = AnalysisStageInput['excerpts'][number];

function excerpt(index: number, lines: number, lineWidth = 24): ExcerptFixture {
  const body = Array.from(
    { length: lines },
    (_unused, line) => `const row${String(line)} = ${cycle('abcdefghij', lineWidth)};`,
  );
  return {
    file: `src/server/module${String(index)}.ts`,
    symbol: `loadRows${String(index)}`,
    startLine: 10,
    endLine: 10 + lines - 1,
    text: body.join('\n'),
    truncated: false,
  };
}

/** Zero for every telemetry kind: the facet's record is keyed by the closed kind vocabulary. */
const KIND_COUNTS: AnalysisStageInput['capture']['kindCounts'] = {
  interaction: 1,
  render: 0,
  commit: 0,
  fetch: 1,
  xhr: 0,
  navigation: 0,
  'perf.longtask': 0,
  'perf.entry': 0,
  error: 0,
  state: 0,
  'http.server': 1,
  'route.handler': 0,
  function: 0,
  'db.query': 1,
  'http.client': 0,
  'server.error': 0,
  log: 0,
};

/** A bounded, redacted analysis input citing {@link EVIDENCE_EVENT_IDS}. */
function analysisStageInput(
  excerpts: readonly ExcerptFixture[] = [excerpt(1, 3)],
): AnalysisStageInput {
  return {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    question: BASE_QUESTION,
    capture: {
      captureId: CAPTURE_ID,
      planVersion: 1,
      startedAt: FIXED_EPOCH_MS,
      stoppedAt: FIXED_EPOCH_MS + 5_000,
      startTime: FIXED_EPOCH_MS + 10,
      endTime: FIXED_EPOCH_MS + 1_185,
      durationMs: 1_175,
      eventCount: 4,
      eventsConsidered: 4,
      eventsExcluded: 0,
      eventsTruncated: false,
      traceCount: 1,
      primaryTraceId: TRACE_ID,
      producerCount: 2,
      tierCounts: { browser: 2, server: 1, db: 1 },
      kindCounts: KIND_COUNTS,
      unavailableMetrics: [],
    },
    metrics: [],
    traces: [],
    topSpans: [
      {
        eventId: 'evt-db-0004',
        spanId: 'b7ad6b7169203331',
        traceId: TRACE_ID,
        kind: 'db.query',
        tier: 'db',
        name: 'SELECT ledger rows',
        startTime: FIXED_EPOCH_MS + 28,
        durationMs: 640,
        status: 'ok',
      },
    ],
    renders: [],
    requests: [],
    queries: [],
    stateTransitions: [],
    errors: [],
    relevantFiles: [],
    excerpts: [...excerpts],
    factCandidates: [
      {
        id: 'fc-slowest-span',
        kind: 'slowest-span',
        statement: 'The slowest span took 640 ms in the database tier.',
        evidence: [
          { eventId: 'evt-db-0004', traceId: TRACE_ID, kind: 'db.query' },
          { eventId: 'evt-server-0003', traceId: TRACE_ID, kind: 'http.server' },
        ],
      },
      {
        id: 'fc-interaction',
        kind: 'interaction-total',
        statement: 'The interaction took 1175 ms end to end.',
        evidence: [
          { eventId: 'evt-interaction-0001', traceId: TRACE_ID, kind: 'interaction' },
          { eventId: 'evt-fetch-0002', traceId: TRACE_ID, kind: 'fetch' },
        ],
      },
    ],
    truncated: { sections: [] },
  };
}

/** The installed plan a follow-up is decided against. */
const INSTALLED_PLAN: InstrumentationPlan = deepFreeze({
  version: 1,
  planVersion: 1,
  sessionId: SESSION_ID,
  objective: 'Measure where the export interaction spends its time.',
  hypotheses: ['The report query dominates the interaction.'],
  capture: ['click event timing', 'fetch calls', 'server request spans'],
  instrumentationTargets: [
    {
      id: 'act_0123456789abcdef',
      file: 'src/server/report.ts',
      symbol: 'buildReport',
      type: 'function-timing',
      adapter: 'nextjs',
      mode: 'patch',
      rationale: 'Time the report builder.',
    },
    {
      id: 'act_fedcba9876543210',
      file: '.',
      symbol: '*',
      type: 'fetch-tracking',
      adapter: 'fetch',
      mode: 'runtime',
      rationale: 'Observe the requests the interaction starts.',
    },
  ],
});

/** Question hints in the shape the understand stage's generic tokenizer produces. */
const QUESTION_HINTS = Object.freeze({
  tokens: Object.freeze(['export', 'toolbar']),
  signalTerms: Object.freeze(['sluggish']),
});

/** Per-call options every stage builder accepts. */
interface StageCallOptions {
  readonly promptVersion?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Calls the builder for `stage` with the suite's canonical inputs for that stage. */
function buildStage(
  builder: ContextBuilder,
  stage: ContextBuilderStage,
  fixture: ContextFixture,
  options: StageCallOptions = {},
): Result<StageRequestBuild, DebuggenError> {
  // Every argument is deeply frozen, so a write anywhere in a build throws in every test.
  const { context } = fixture;
  switch (stage) {
    case 'understand':
      return builder.buildUnderstandRequest(
        deepFreeze({ context, ...options, questionHints: QUESTION_HINTS }),
      );
    case 'investigate':
      return builder.buildInvestigateRequest(
        deepFreeze({
          context,
          ...options,
          understanding: UNDERSTANDING,
          toolCatalog: TOOL_CATALOG,
          queryResults: [queryRun(1), queryRun(2)],
          remainingQueries: 5,
          toolNames: TOOL_NAMES,
        }),
      );
    case 'plan':
      return builder.buildPlanRequest(
        deepFreeze({
          context,
          ...options,
          understanding: UNDERSTANDING,
          investigation: { relevantFiles: RELEVANT_FILES, flows: ['ExportControl -> buildReport'] },
          adapterCatalog: ADAPTER_CATALOG,
        }),
      );
    case 'analyze':
      return builder.buildAnalyzeRequest(
        deepFreeze({
          context,
          ...options,
          understanding: UNDERSTANDING,
          stageInput: analysisStageInput(),
        }),
      );
    case 'followup':
      return builder.buildFollowUpRequest(
        deepFreeze({
          context,
          ...options,
          followUpQuestion: FOLLOW_UP_QUESTION,
          understanding: UNDERSTANDING,
          plan: INSTALLED_PLAN,
        }),
      );
  }
}

/** The `{{outputSchema}}` options each stage builder passes. */
function schemaOptionsFor(stage: PromptStage): { readonly toolNames?: readonly string[] } {
  return stage === 'investigate' ? { toolNames: TOOL_NAMES } : {};
}

/** A serialised section: canonical JSON, or `null` when absent. */
function sectionText(input: JsonObject, key: string): string {
  const value = input[key];
  return value === undefined ? 'null' : toPromptJson(value);
}

/** A section that may be text: the text, the absent marker, or canonical JSON. */
function textSectionText(input: JsonObject, key: string): string {
  const value = input[key];
  if (value === undefined) {
    return ABSENT_VALUE;
  }
  return typeof value === 'string' ? value : toPromptJson(value);
}

/**
 * How each placeholder derived from the structured input must be rendered
 * from it. Keys absent here are prompt-only (`question`, `followUpQuestion`)
 * or the injected schema document (`outputSchema`).
 */
const DERIVATIONS: Readonly<
  Record<ContextBuilderStage, Readonly<Record<string, (input: JsonObject) => string>>>
> = {
  understand: {
    target: (input) =>
      input['target'] === undefined ? ABSENT_VALUE : toPromptJson(input['target']),
    currentUrl: (input) => textSectionText(input, 'currentUrl'),
    projectSummary: (input) => sectionText(input, 'projectSummary'),
  },
  investigate: {
    understanding: (input) => sectionText(input, 'understanding'),
    toolCatalog: (input) => textSectionText(input, 'toolCatalog'),
    queryResults: (input) => sectionText(input, 'queryResults'),
    remainingQueries: (input) => toPromptJson(input['remainingQueries']),
  },
  plan: {
    understanding: (input) => sectionText(input, 'understanding'),
    investigation: (input) => sectionText(input, 'investigation'),
    adapterCatalog: (input) => textSectionText(input, 'adapterCatalog'),
  },
  analyze: {
    understanding: (input) => sectionText(input, 'understanding'),
    captureSummary: (input) => sectionText(input, 'captureSummary'),
    codeExcerpts: (input) => sectionText(input, 'codeExcerpts'),
  },
  followup: {
    understanding: (input) => sectionText(input, 'understanding'),
    plan: (input) => sectionText(input, 'plan'),
    captureSummary: (input) => sectionText(input, 'captureSummary'),
    analysis: (input) => sectionText(input, 'analysis'),
    panel: (input) => sectionText(input, 'panel'),
  },
};

/** The prompt-only placeholder of each stage builder that has one, and the text it carries. */
const PROMPT_ONLY: Readonly<
  Partial<Record<ContextBuilderStage, readonly [key: string, text: string]>>
> = {
  understand: ['question', BASE_QUESTION],
  investigate: ['question', BASE_QUESTION],
  analyze: ['question', BASE_QUESTION],
  followup: ['followUpQuestion', FOLLOW_UP_QUESTION],
};

// ---------------------------------------------------------------------------
// A minimal JSON Schema checker for the keywords the stage documents use
// ---------------------------------------------------------------------------

/**
 * The keywords {@link schemaErrors} evaluates. A document using any other
 * keyword is reported rather than silently accepted, so this checker can only
 * ever be stricter than a full validator, never looser.
 */
const CHECKED_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'oneOf',
  'anyOf',
  'format',
  'description',
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/**
 * Every way `value` fails `schema`, by JSON path. Supports exactly
 * {@link CHECKED_KEYWORDS}; string lengths count code points, as JSON Schema
 * specifies.
 */
function schemaErrors(schema: unknown, value: unknown, path = '$'): string[] {
  if (!isRecord(schema)) {
    return [`${path}: not a schema object`];
  }
  const errors: string[] = [];
  for (const keyword of Object.keys(schema)) {
    if (!CHECKED_KEYWORDS.has(keyword)) {
      errors.push(`${path}: unsupported keyword ${keyword}`);
    }
  }
  const type = schema['type'];
  if (type !== undefined) {
    const types: readonly unknown[] = Array.isArray(type) ? type : [type];
    if (!types.some((entry) => matchesType(entry, value))) {
      return [...errors, `${path}: expected type ${JSON.stringify(type)}`];
    }
  }
  const allowed = schema['enum'];
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    errors.push(`${path}: not in enum`);
  }
  if (Object.hasOwn(schema, 'const') && schema['const'] !== value) {
    errors.push(`${path}: not the const`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    const minLength = schema['minLength'];
    const maxLength = schema['maxLength'];
    const pattern = schema['pattern'];
    if (typeof minLength === 'number' && length < minLength) {
      errors.push(`${path}: shorter than ${String(minLength)}`);
    }
    if (typeof maxLength === 'number' && length > maxLength) {
      errors.push(`${path}: longer than ${String(maxLength)}`);
    }
    if (typeof pattern === 'string' && !new RegExp(pattern, 'u').test(value)) {
      errors.push(`${path}: does not match ${pattern}`);
    }
  }
  if (typeof value === 'number') {
    const minimum = schema['minimum'];
    const maximum = schema['maximum'];
    if (typeof minimum === 'number' && value < minimum) {
      errors.push(`${path}: below ${String(minimum)}`);
    }
    if (typeof maximum === 'number' && value > maximum) {
      errors.push(`${path}: above ${String(maximum)}`);
    }
  }
  if (Array.isArray(value)) {
    const list: readonly unknown[] = value;
    const minItems = schema['minItems'];
    const maxItems = schema['maxItems'];
    if (typeof minItems === 'number' && list.length < minItems) {
      errors.push(`${path}: fewer than ${String(minItems)} items`);
    }
    if (typeof maxItems === 'number' && list.length > maxItems) {
      errors.push(`${path}: more than ${String(maxItems)} items`);
    }
    const items = schema['items'];
    if (items !== undefined) {
      list.forEach((item, index) => {
        errors.push(...schemaErrors(items, item, `${path}[${String(index)}]`));
      });
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema['properties']) ? schema['properties'] : {};
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) {
          errors.push(`${path}: missing required ${key}`);
        }
      }
    }
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) {
        errors.push(...schemaErrors(properties[key], value[key], `${path}.${key}`));
      } else if (schema['additionalProperties'] === false) {
        errors.push(`${path}: unexpected property ${key}`);
      } else if (isRecord(schema['additionalProperties'])) {
        errors.push(...schemaErrors(schema['additionalProperties'], value[key], `${path}.${key}`));
      }
    }
  }
  const oneOf = schema['oneOf'];
  if (Array.isArray(oneOf)) {
    const passing = oneOf.filter((branch) => schemaErrors(branch, value, path).length === 0);
    if (passing.length !== 1) {
      errors.push(`${path}: matches ${String(passing.length)} oneOf branches`);
    }
  }
  const anyOf = schema['anyOf'];
  if (
    Array.isArray(anyOf) &&
    !anyOf.some((branch) => schemaErrors(branch, value, path).length === 0)
  ) {
    errors.push(`${path}: matches no anyOf branch`);
  }
  return errors;
}

/** The parsed `{{outputSchema}}` document of a stage. */
function outputDocument(stage: PromptStage, options?: { readonly toolNames?: readonly string[] }) {
  const parsed: unknown = JSON.parse(outputSchemaFor(stage, options));
  if (!isRecord(parsed)) {
    throw new Error(`The ${stage} output schema is not a JSON object.`);
  }
  return parsed;
}

/** Reads `document.properties[key]`, failing loudly when the path is absent. */
function property(
  document: unknown,
  ...keys: readonly string[]
): Readonly<Record<string, unknown>> {
  let node: unknown = document;
  for (const key of keys) {
    if (!isRecord(node)) {
      throw new Error(`No object at ${keys.join('.')}.`);
    }
    node =
      key === 'items'
        ? node['items']
        : isRecord(node['properties'])
          ? node['properties'][key]
          : undefined;
  }
  if (!isRecord(node)) {
    throw new Error(`No schema at ${keys.join('.')}.`);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Phase 1 — fixtures are what they claim to be
// ---------------------------------------------------------------------------

describe('suite fixtures', () => {
  it('are valid against the upstream schemas they stand in for', () => {
    expect(
      parseSessionRecord(
        sessionRecord({ question: BASE_QUESTION, target: TARGET, promptVersions: {} }),
      ).ok,
    ).toBe(true);
    expect(problemUnderstandingSchema.safeParse(UNDERSTANDING).success).toBe(true);
    expect(instrumentationPlanSchema.safeParse(INSTALLED_PLAN).success).toBe(true);
    expect(sessionRecordSchema.shape.relevantFiles.safeParse(RELEVANT_FILES).success).toBe(true);
    expect(estimatePayloadBytes(analysisStageInput())).toBeLessThan(
      ANALYSIS_INPUT_LIMITS.maxTotalBytes,
    );
  });

  it('builds a stage context from the stored record without reading the code handles', () => {
    const fixture = stageContext();
    const { context } = fixture;
    expect(context.sessionId).toBe(SESSION_ID);
    expect(context.projectRoot).toBe(PROJECT_ROOT);
    expect(context.question).toBe(BASE_QUESTION);
    expect(context.target).toEqual(TARGET);
    expect(context.currentUrl).toBe(CURRENT_URL);
    expect(context.captureId).toBe(CAPTURE_ID);
    expect(context.promptVersions).toEqual({});
    expect(context.promptVersions).not.toBe(fixture.session.promptVersions);
    expect(fixture.codeReads).toEqual([]);
  });

  it('prefers an explicit current URL and carries the follow-up question', () => {
    const url = `${DEV_SERVER_URL}/ledger?tab=${URL_QUERY_MASK}`;
    const { context } = stageContext({ currentUrl: url, followUpQuestion: FOLLOW_UP_QUESTION });
    expect(context.currentUrl).toBe(url);
    expect(context.followUpQuestion).toBe(FOLLOW_UP_QUESTION);
  });

  it('refuses a session whose project root is not absolute, naming the field only', () => {
    const session = sessionRecord({
      question: BASE_QUESTION,
      target: TARGET,
      promptVersions: {},
      projectRoot: 'workspace/relative-root',
    });
    const error = expectErr(
      createPipelineStageContext({
        session,
        code: codeHandles([]),
        logger: capturedLogger().logger,
      }),
    );
    expect(error.code).toBe('PROJECT_NOT_FOUND');
    expect(error.details).toEqual({ sessionId: SESSION_ID, field: 'projectRoot' });
    expect(errorText(error)).not.toContain(QUESTION_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — placeholder drift
// ---------------------------------------------------------------------------

/** The authoritative placeholder sets, restated independently of the module under test. */
const EXPECTED_PLACEHOLDERS: Readonly<Record<PromptStage, readonly string[]>> = {
  understand: ['question', 'target', 'currentUrl', 'projectSummary', 'outputSchema'],
  investigate: [
    'question',
    'understanding',
    'toolCatalog',
    'queryResults',
    'remainingQueries',
    'outputSchema',
  ],
  plan: ['understanding', 'investigation', 'adapterCatalog', 'outputSchema'],
  analyze: ['question', 'understanding', 'captureSummary', 'codeExcerpts', 'outputSchema'],
  followup: [
    'followUpQuestion',
    'understanding',
    'plan',
    'captureSummary',
    'analysis',
    'panel',
    'outputSchema',
  ],
  'generate-panel': ['question', 'analysis', 'nodeCatalog', 'captureOverview', 'outputSchema'],
};

describe('placeholder drift', () => {
  it('records a placeholder set for exactly the six prompt stages, as specified', () => {
    expect(Object.keys(STAGE_PLACEHOLDERS).sort()).toEqual([...PROMPT_STAGES].sort());
    for (const stage of PROMPT_STAGES) {
      expect([...STAGE_PLACEHOLDERS[stage]].sort()).toEqual(
        [...EXPECTED_PLACEHOLDERS[stage]].sort(),
      );
      expect(new Set(STAGE_PLACEHOLDERS[stage]).size).toBe(STAGE_PLACEHOLDERS[stage].length);
    }
  });

  it('reads a committed v001 prompt, and the version the manifest calls current, for every stage', () => {
    const current = manifestCurrentVersions();
    expect(Object.keys(current).sort()).toEqual([...PROMPT_STAGES].sort());
    for (const stage of PROMPT_STAGES) {
      const versions = committedVersions(stage);
      expect(versions).toContain('v001');
      expect(versions).toContain(current[stage]);
    }
  });

  it.each(PROMPT_STAGES)(
    'every committed %s prompt names exactly the recorded {{token}} set',
    (stage) => {
      const recorded = [...STAGE_PLACEHOLDERS[stage]].sort();
      for (const version of committedVersions(stage)) {
        const tokens = placeholderTokens(committedPrompt(stage, version));
        expect({ stage, version, tokens }).toEqual({ stage, version, tokens: recorded });
      }
    },
  );

  it('records generate-panel for the drift check but builds nothing for it', () => {
    expect(STAGE_PLACEHOLDERS['generate-panel']).toBeDefined();
    expect([...CONTEXT_BUILDER_STAGES]).toEqual([
      'understand',
      'investigate',
      'plan',
      'analyze',
      'followup',
    ]);
    expect(CONTEXT_BUILDER_STAGES).not.toContain('generate-panel');
    expect(
      PROMPT_STAGES.filter(
        (stage) => !(CONTEXT_BUILDER_STAGES as readonly string[]).includes(stage),
      ),
    ).toEqual(['generate-panel']);

    const { builder } = builderFixture(committedLibrary());
    expect(Object.keys(builder).sort()).toEqual([
      'buildAnalyzeRequest',
      'buildFollowUpRequest',
      'buildInvestigateRequest',
      'buildPlanRequest',
      'buildStageRequest',
      'buildUnderstandRequest',
      'limits',
    ]);
    expect(Object.keys(builder).filter((key) => /panel/i.test(key))).toEqual([]);
    expect(Object.isFrozen(builder)).toBe(true);
  });

  it.each(CONTEXT_BUILDER_STAGES)(
    'the %s builder supplies exactly the recorded placeholder keys',
    (stage) => {
      const { builder } = builderFixture(probeLibrary());
      const build = expectOk(buildStage(builder, stage, stageContext()));
      expect(Object.keys(probeValues(build.request.prompt)).sort()).toEqual(
        [...STAGE_PLACEHOLDERS[stage]].sort(),
      );
    },
  );

  it.each(CONTEXT_BUILDER_STAGES)(
    'a %s build over the committed prompt leaves no residual {{ token',
    (stage) => {
      const fixture = stageContext();
      const { builder } = builderFixture(committedLibrary());
      const build = expectOk(buildStage(builder, stage, fixture));
      expect(build.request.prompt).not.toContain('{{');
      expect(placeholderTokens(build.request.prompt)).toEqual([]);
      expect(build.request.prompt).toContain(outputSchemaFor(stage, schemaOptionsFor(stage)));
      expect(build.request.prompt.startsWith(COMMITTED_PROMPTS[stage].split('\n')[0] ?? '')).toBe(
        true,
      );
      expect(build.promptVersion).toBe(CURRENT_VERSION);
      expect(fixture.codeReads).toEqual([]);
    },
  );

  describe('buildStageRequest key check', () => {
    const planted = `planted-value-${QUESTION_SENTINEL}`;

    function analyzeValues(): Record<string, string> {
      return {
        question: planted,
        understanding: toPromptJson(UNDERSTANDING),
        captureSummary: toPromptJson({ note: planted }),
        codeExcerpts: '[]',
        outputSchema: outputSchemaFor('analyze'),
      };
    }

    it('names every missing key and carries no payload value', () => {
      const { builder } = builderFixture(committedLibrary());
      const values = Object.fromEntries(
        Object.entries(analyzeValues()).filter(
          ([key]) => key !== 'codeExcerpts' && key !== 'captureSummary',
        ),
      );
      const error = expectErr(
        builder.buildStageRequest({
          stage: 'analyze',
          values,
          input: { captureSummary: { note: planted } },
          sessionId: SESSION_ID,
        }),
      );
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.details).toEqual({
        stage: 'analyze',
        missingPlaceholders: ['captureSummary', 'codeExcerpts'],
        unexpectedPlaceholders: [],
      });
      expect(error.message).toContain('captureSummary');
      expect(errorText(error)).not.toContain(planted);
      expect(errorText(error)).not.toContain(QUESTION_SENTINEL);
    });

    it('names every unexpected key and carries no payload value', () => {
      const { builder } = builderFixture(committedLibrary());
      const error = expectErr(
        builder.buildStageRequest({
          stage: 'analyze',
          values: { ...analyzeValues(), panel: planted },
          input: {},
        }),
      );
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.details?.['missingPlaceholders']).toEqual([]);
      expect(error.details?.['unexpectedPlaceholders']).toEqual(['panel']);
      expect(errorText(error)).not.toContain(planted);
    });

    it('builds when exactly the recorded keys are supplied', () => {
      const { builder } = builderFixture(committedLibrary());
      const build = expectOk(
        builder.buildStageRequest({
          stage: 'analyze',
          values: analyzeValues(),
          input: { captureSummary: { note: planted } },
          sessionId: SESSION_ID,
        }),
      );
      expect(build.request.prompt).toContain(planted);
      expect(build.request.prompt).not.toContain('{{');
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — one capped context, two payloads
// ---------------------------------------------------------------------------

describe('dual payload', () => {
  it.each(CONTEXT_BUILDER_STAGES)(
    'a %s request carries the rendered prompt, the structured input and exact metadata',
    (stage) => {
      const controller = new AbortController();
      const { builder } = builderFixture(committedLibrary());
      const build = expectOk(
        buildStage(builder, stage, stageContext(), { signal: controller.signal }),
      );
      const { request } = build;
      expect(request.prompt.length).toBeGreaterThan(0);
      expect(isRecord(request.input)).toBe(true);
      expect(Object.keys(request.input).length).toBeGreaterThan(0);
      expect(request.metadata).toEqual({
        stage,
        sessionId: SESSION_ID,
        promptVersion: CURRENT_VERSION,
      });
      expect(request.signal).toBe(controller.signal);
      expect(request.system).toBeUndefined();
      expect(build.stage).toBe(stage);
      expect(build.bytes).toBe(
        Buffer.byteLength(request.prompt, 'utf8') + estimatePayloadBytes(request.input),
      );
    },
  );

  it.each(CONTEXT_BUILDER_STAGES)(
    'every %s placeholder is derived from the same capped structured input',
    (stage) => {
      const { builder } = builderFixture(probeLibrary());
      const build = expectOk(buildStage(builder, stage, stageContext()));
      const values = probeValues(build.request.prompt);
      const { input } = build.request;

      for (const [key, derive] of Object.entries(DERIVATIONS[stage])) {
        expect({ key, value: values[key] }).toEqual({ key, value: derive(input) });
      }
      const promptOnly = PROMPT_ONLY[stage];
      if (promptOnly !== undefined) {
        expect(values[promptOnly[0]]).toBe(promptOnly[1]);
      }
      expect(values['outputSchema']).toBe(outputSchemaFor(stage, schemaOptionsFor(stage)));

      const covered = [
        ...Object.keys(DERIVATIONS[stage]),
        ...(promptOnly !== undefined ? [promptOnly[0]] : []),
        'outputSchema',
      ].sort();
      expect(covered).toEqual([...STAGE_PLACEHOLDERS[stage]].sort());
    },
  );

  it.each(CONTEXT_BUILDER_STAGES)(
    'the %s question travels in the prompt only, never in the structured input',
    (stage) => {
      const { builder } = builderFixture(committedLibrary());
      const build = expectOk(buildStage(builder, stage, stageContext()));
      expect(JSON.stringify(build.request.input)).not.toContain(QUESTION_SENTINEL);
      expect(build.request.input['question']).toBeUndefined();
      expect(build.request.input['followUpQuestion']).toBeUndefined();
      if (stage !== 'plan') {
        expect(build.request.prompt).toContain(QUESTION_SENTINEL);
      }
    },
  );

  it('the analyze prompt answers the follow-up question when the run carries one', () => {
    const { builder } = builderFixture(probeLibrary());
    const fixture = stageContext({ followUpQuestion: FOLLOW_UP_QUESTION });
    const build = expectOk(buildStage(builder, 'analyze', fixture));
    expect(probeValues(build.request.prompt)['question']).toBe(FOLLOW_UP_QUESTION);
    expect(JSON.stringify(build.request.input)).not.toContain(QUESTION_SENTINEL);
  });

  it('the understand input carries the wording-invariant hints beside the context sections', () => {
    const { builder } = builderFixture(committedLibrary());
    const build = expectOk(buildStage(builder, 'understand', stageContext()));
    expect(Object.keys(build.request.input).sort()).toEqual(
      ['currentUrl', 'projectSummary', 'signalTerms', 'target', 'tokens'].sort(),
    );
    expect(build.request.input['tokens']).toEqual(['export', 'toolbar']);
    expect(build.request.input['currentUrl']).toBe(CURRENT_URL);
  });

  it('renders the absent marker for a missing element and page, and null for a missing section', () => {
    const { builder } = builderFixture(probeLibrary());
    const context: PipelineStageContext = {
      ...stageContext({ withoutTarget: true }).context,
      currentUrl: undefined,
    };
    const understand = expectOk(builder.buildUnderstandRequest({ context }));
    const values = probeValues(understand.request.prompt);
    expect(values['target']).toBe(ABSENT_VALUE);
    expect(values['currentUrl']).toBe(ABSENT_VALUE);
    expect(understand.request.input['target']).toBeUndefined();

    const followup = expectOk(
      builder.buildFollowUpRequest({ context, followUpQuestion: FOLLOW_UP_QUESTION }),
    );
    const followupValues = probeValues(followup.request.prompt);
    for (const key of ['understanding', 'plan', 'captureSummary', 'analysis', 'panel']) {
      expect({ key, value: followupValues[key] }).toEqual({ key, value: 'null' });
    }
    expect(followup.request.input).toEqual({});
  });

  it('a value capped in the input appears capped in the prompt, and its original nowhere', () => {
    const target: SelectedTarget = { ...TARGET, text: cycle('quarterly ledger ', 200) };
    const { builder } = builderFixture(probeLibrary());
    const build = expectOk(
      builder.buildUnderstandRequest({ context: stageContext({ target }).context }),
    );
    const capped = capText(target.text ?? '', CONTEXT_LIMITS.maxTargetTextChars).text;
    const inputTarget = build.request.input['target'];
    expect(isRecord(inputTarget) ? inputTarget['text'] : undefined).toBe(capped);
    expect(capped.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(capped).toHaveLength(CONTEXT_LIMITS.maxTargetTextChars);
    expect(probeValues(build.request.prompt)['target']).toBe(toPromptJson(inputTarget));
    expect(build.request.prompt).toContain(capped);
    expect(build.request.prompt).not.toContain(target.text);
    expect(JSON.stringify(build.request.input)).not.toContain(target.text);
    expect(build.truncated).toEqual(['target']);
  });
});

describe('caps: the limits themselves', () => {
  it('declares every cap as a frozen positive integer, aligned with the upstream budgets', () => {
    expect(Object.isFrozen(CONTEXT_LIMITS)).toBe(true);
    expect(Object.keys(CONTEXT_LIMITS).sort()).toEqual(
      [
        'maxCatalogChars',
        'maxDepth',
        'maxExcerptChars',
        'maxExcerptLines',
        'maxExcerpts',
        'maxListItems',
        'maxPayloadBytes',
        'maxQueryResults',
        'maxQuestionChars',
        'maxRelevantFiles',
        'maxSectionNodes',
        'maxStringChars',
        'maxTargetTextChars',
        'maxUrlChars',
      ].sort(),
    );
    for (const [name, value] of Object.entries(CONTEXT_LIMITS)) {
      expect({ name, valid: Number.isInteger(value) && value >= 1 }).toEqual({ name, valid: true });
    }
    expect(CONTEXT_LIMITS.maxTargetTextChars).toBe(120);
    expect(CONTEXT_LIMITS.maxExcerpts).toBe(ANALYSIS_INPUT_LIMITS.maxExcerpts);
    expect(CONTEXT_LIMITS.maxRelevantFiles).toBe(ANALYSIS_INPUT_LIMITS.maxRelevantFiles);
    expect(CONTEXT_LIMITS.maxPayloadBytes).toBeGreaterThan(ANALYSIS_INPUT_LIMITS.maxTotalBytes);
  });

  it('resolveContextLimits tightens, never widens, and ignores unusable overrides', () => {
    const resolved = resolveContextLimits({
      maxQuestionChars: 10.9,
      maxPayloadBytes: CONTEXT_LIMITS.maxPayloadBytes * 4,
      maxDepth: 0,
      maxListItems: Number.NaN,
      maxStringChars: Number.POSITIVE_INFINITY,
    });
    expect(resolved.maxQuestionChars).toBe(10);
    expect(resolved.maxPayloadBytes).toBe(CONTEXT_LIMITS.maxPayloadBytes);
    expect(resolved.maxDepth).toBe(CONTEXT_LIMITS.maxDepth);
    expect(resolved.maxListItems).toBe(CONTEXT_LIMITS.maxListItems);
    expect(resolved.maxStringChars).toBe(CONTEXT_LIMITS.maxStringChars);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolveContextLimits()).toEqual(CONTEXT_LIMITS);
    expect(
      builderFixture(committedLibrary(), { limits: { maxQuestionChars: 10 } }).builder.limits,
    ).toEqual({ ...CONTEXT_LIMITS, maxQuestionChars: 10 });
  });
});

describe('caps: pure helpers', () => {
  it('capText keeps short text, cuts long text to the cap including the marker', () => {
    expect(capText('short', 10)).toEqual({ text: 'short', truncated: false });
    expect(capText('exactly-10', 10)).toEqual({ text: 'exactly-10', truncated: false });
    const cut = capText('abcdefghijklmnop', 6);
    expect(cut).toEqual({ text: `abcde${TRUNCATION_MARKER}`, truncated: true });
    expect(cut.text).toHaveLength(6);
  });

  it('capText never splits a surrogate pair and handles degenerate caps', () => {
    const cut = capText('ab\u{1F600}cdef', 4);
    expect(cut).toEqual({ text: `ab${TRUNCATION_MARKER}`, truncated: true });
    expect(capText('anything', 0)).toEqual({ text: '', truncated: true });
    expect(capText('anything', Number.POSITIVE_INFINITY)).toEqual({
      text: 'anything',
      truncated: false,
    });
  });

  it('capList keeps the head in a new array and reports the original total', () => {
    const items = deepFreeze([1, 2, 3, 4, 5]);
    const capped = capList(items, 3);
    expect(capped).toEqual({ items: [1, 2, 3], truncated: true, total: 5 });
    expect(capped.items).not.toBe(items);
    expect(capList(items, 5)).toEqual({ items: [1, 2, 3, 4, 5], truncated: false, total: 5 });
    expect(capList(items, Number.POSITIVE_INFINITY).truncated).toBe(false);
    expect(capList([], 2)).toEqual({ items: [], truncated: false, total: 0 });
  });

  it('capExcerpt caps lines and recomputes the end line, keeping the source location', () => {
    const source = deepFreeze(excerpt(1, 10));
    const capped = capExcerpt(source, { maxExcerptLines: 4, maxExcerptChars: 10_000 });
    expect(capped.truncated).toBe(true);
    expect(capped.excerpt.file).toBe(source.file);
    expect(capped.excerpt.symbol).toBe(source.symbol);
    expect(capped.excerpt.startLine).toBe(source.startLine);
    expect(capped.excerpt.endLine).toBe(source.startLine + 3);
    expect(capped.excerpt.text).toBe(source.text.split('\n').slice(0, 4).join('\n'));
    expect(capped.excerpt.truncated).toBe(true);
  });

  it('capExcerpt caps characters on a whole line where one fits', () => {
    const source = deepFreeze(excerpt(2, 5));
    const lineLength = (source.text.split('\n')[0] ?? '').length;
    const capped = capExcerpt(source, {
      maxExcerptLines: 100,
      maxExcerptChars: lineLength * 2 + 5,
    });
    expect(capped.truncated).toBe(true);
    expect(capped.excerpt.text).toBe(source.text.split('\n').slice(0, 2).join('\n'));
    expect(capped.excerpt.endLine).toBe(source.startLine + 1);
    expect(capped.excerpt.file).toBe(source.file);
    expect(capped.excerpt.startLine).toBe(source.startLine);
  });

  it('capExcerpt returns an untouched copy when nothing needs cutting, keeping an upstream clip', () => {
    const source = deepFreeze({ ...excerpt(3, 2), truncated: true });
    const capped = capExcerpt(source, { maxExcerptLines: 100, maxExcerptChars: 10_000 });
    expect(capped.truncated).toBe(false);
    expect(capped.excerpt).toEqual(source);
    expect(capped.excerpt).not.toBe(source);
    expect(capped.excerpt.truncated).toBe(true);
  });

  it('toBoundedJson cuts depth, node count, lists, strings and cycles without mutating', () => {
    const deep = deepFreeze({ a: { b: { c: { d: 1 } } } });
    expect(toBoundedJson(deep, { maxDepth: 2, maxNodes: 100 })).toEqual({
      value: { a: {} },
      truncated: true,
    });

    const wide = deepFreeze(Array.from({ length: 10 }, (_unused, index) => index));
    const byNodes = toBoundedJson(wide, { maxDepth: 4, maxNodes: 5 });
    expect(byNodes.truncated).toBe(true);
    expect(byNodes.value).toEqual([0, 1, 2, 3]);

    const listed = toBoundedJson(deepFreeze({ list: ['alpha', 'bravo', 'charlie'] }), {
      maxDepth: 4,
      maxNodes: 100,
      maxListItems: 2,
      maxStringChars: 4,
    });
    expect(listed).toEqual({
      value: { list: [`alp${TRUNCATION_MARKER}`, `bra${TRUNCATION_MARKER}`] },
      truncated: true,
    });

    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(toBoundedJson(cyclic, { maxDepth: 8, maxNodes: 100 })).toEqual({
      value: { name: 'loop' },
      truncated: true,
    });

    const untouched = deepFreeze({ keep: ['one', 'two'], nested: { flag: true } });
    const copy = toBoundedJson(untouched, { maxDepth: 8, maxNodes: 100 });
    expect(copy).toEqual({ value: untouched, truncated: false });
    expect(copy.value).not.toBe(untouched);
  });

  it('toBoundedJson caps an excerpt-shaped object as an excerpt, not as a string', () => {
    const source = deepFreeze(excerpt(4, 10));
    const bounded = toBoundedJson(
      { excerpt: source },
      {
        maxDepth: 8,
        maxNodes: 1_000,
        maxStringChars: 10_000,
        excerptLimits: { maxExcerptLines: 3, maxExcerptChars: 10_000 },
      },
    );
    expect(bounded.truncated).toBe(true);
    expect(bounded.value).toEqual({
      excerpt: capExcerpt(source, { maxExcerptLines: 3, maxExcerptChars: 10_000 }).excerpt,
    });
  });
});

describe('caps: enforced by every stage builder', () => {
  it.each(['understand', 'investigate', 'analyze'] as const)(
    'maxQuestionChars caps the %s question and reports the section',
    (stage) => {
      const { builder } = builderFixture(probeLibrary(), { limits: { maxQuestionChars: 24 } });
      const build = expectOk(buildStage(builder, stage, stageContext()));
      const capped = capText(BASE_QUESTION, 24).text;
      expect(probeValues(build.request.prompt)['question']).toBe(capped);
      expect(build.request.prompt).not.toContain(BASE_QUESTION);
      expect(build.truncated).toContain('question');
    },
  );

  it('maxQuestionChars caps the follow-up question and reports the section', () => {
    const { builder } = builderFixture(probeLibrary(), { limits: { maxQuestionChars: 24 } });
    const build = expectOk(buildStage(builder, 'followup', stageContext()));
    expect(probeValues(build.request.prompt)['followUpQuestion']).toBe(
      capText(FOLLOW_UP_QUESTION, 24).text,
    );
    expect(build.request.prompt).not.toContain(FOLLOW_UP_QUESTION);
    expect(build.truncated).toEqual(['followUpQuestion']);
  });

  it('maxTargetTextChars, maxStringChars and maxListItems bound the selected element', () => {
    const { builder } = builderFixture(probeLibrary(), {
      limits: { maxTargetTextChars: 6, maxStringChars: 8, maxListItems: 2 },
    });
    const build = expectOk(builder.buildUnderstandRequest({ context: stageContext().context }));
    expect(build.request.input['target']).toEqual({
      tagName: 'BUTTON',
      selector: capText(TARGET.selector, 8).text,
      text: capText(TARGET.text ?? '', 6).text,
      componentChain: [capText('ExportControl', 8).text, capText('ToolbarRow', 8).text],
    });
    expect(build.truncated).toEqual(['target']);
  });

  it('maxUrlChars bounds the current page address', () => {
    const { builder } = builderFixture(probeLibrary(), { limits: { maxUrlChars: 20 } });
    const build = expectOk(builder.buildUnderstandRequest({ context: stageContext().context }));
    expect(build.request.input['currentUrl']).toBe(capText(CURRENT_URL, 20).text);
    expect(probeValues(build.request.prompt)['currentUrl']).toBe(capText(CURRENT_URL, 20).text);
    expect(build.truncated).toEqual(['currentUrl']);
  });

  it('maxListItems and maxStringChars bound the question hints', () => {
    const { builder } = builderFixture(probeLibrary(), {
      limits: { maxListItems: 2, maxStringChars: 10 },
    });
    const build = expectOk(
      builder.buildUnderstandRequest({
        context: stageContext({ withoutTarget: true }).context,
        questionHints: { tokens: ['alpha', 'bravo', 'charlie'], names: ['x'.repeat(30)] },
      }),
    );
    expect(build.request.input['tokens']).toEqual(['alpha', 'bravo']);
    expect(build.request.input['names']).toEqual([capText('x'.repeat(30), 10).text]);
    expect(build.truncated).toContain('questionHints');
  });

  it.each([
    ['a reserved section name', { target: ['planted'] }, 'reservedKeys', ['target']],
    ['a value that is not a list', { count: 3 }, 'invalidKeys', ['count']],
    ['a list that is not all strings', { mixed: ['planted', 1] }, 'invalidKeys', ['mixed']],
  ] as const)(
    'refuses question hints with %s before loading any prompt',
    (_label, hints, key, keys) => {
      const { builder, double } = builderFixture(committedLibrary());
      const error = expectErr(
        builder.buildUnderstandRequest({ context: stageContext().context, questionHints: hints }),
      );
      expect(error.code).toBe('INTERNAL');
      expect(error.details?.[key]).toEqual(keys);
      expect(errorText(error)).not.toContain('planted');
      expect(double.load).not.toHaveBeenCalled();
      expect(double.loadVersion).not.toHaveBeenCalled();
    },
  );

  it('maxCatalogChars bounds a text catalog in the investigate and plan requests', () => {
    const { builder } = builderFixture(probeLibrary(), { limits: { maxCatalogChars: 40 } });
    const { context } = stageContext();
    const investigate = expectOk(buildStage(builder, 'investigate', stageContext()));
    expect(investigate.request.input['toolCatalog']).toBe(capText(TOOL_CATALOG, 40).text);
    expect(probeValues(investigate.request.prompt)['toolCatalog']).toBe(
      capText(TOOL_CATALOG, 40).text,
    );
    expect(investigate.truncated).toEqual(['toolCatalog']);

    const catalogText = cycle('adapter capability line. ', 90);
    const plan = expectOk(
      builder.buildPlanRequest({
        context,
        understanding: UNDERSTANDING,
        investigation: { relevantFiles: RELEVANT_FILES, flows: [] },
        adapterCatalog: catalogText,
      }),
    );
    expect(plan.request.input['adapterCatalog']).toBe(capText(catalogText, 40).text);
    expect(plan.truncated).toEqual(['adapterCatalog']);
  });

  it('maxQueryResults keeps the most recent runs and derives candidates from their findings only', () => {
    const { builder } = builderFixture(probeLibrary(), { limits: { maxQueryResults: 3 } });
    const runs = [1, 2, 3, 4, 5, 6].map(queryRun);
    const build = expectOk(
      builder.buildInvestigateRequest({
        context: stageContext().context,
        understanding: UNDERSTANDING,
        toolCatalog: TOOL_CATALOG,
        queryResults: runs,
        remainingQueries: 2,
      }),
    );
    expect(build.request.input['queryResults']).toEqual(runs.slice(3));
    expect(build.request.input['remainingQueries']).toBe(2);
    expect(build.request.input['candidates']).toEqual(
      [4, 5, 6].map((index) => ({
        file: `src/components/Panel${String(index)}.tsx`,
        symbol: `Panel${String(index)}`,
        kind: 'component',
        score: 0.5,
      })),
    );
    expect(JSON.stringify(build.request.input['candidates'])).not.toContain('MissingSymbol');
    expect(build.truncated).toEqual(['queryResults']);
    expect(probeValues(build.request.prompt)['remainingQueries']).toBe('2');
  });

  it('a non-finite or negative query budget renders as zero', () => {
    const { builder } = builderFixture(probeLibrary());
    for (const remainingQueries of [-3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const build = expectOk(
        builder.buildInvestigateRequest({
          context: stageContext().context,
          understanding: UNDERSTANDING,
          toolCatalog: TOOL_CATALOG,
          queryResults: [],
          remainingQueries,
        }),
      );
      expect(build.request.input['remainingQueries']).toBe(0);
      expect(probeValues(build.request.prompt)['remainingQueries']).toBe('0');
    }
  });

  it('maxRelevantFiles and maxListItems bound the investigation a plan is built on', () => {
    const { builder } = builderFixture(probeLibrary(), {
      limits: { maxRelevantFiles: 2, maxListItems: 3 },
    });
    const files: RelevantFile[] = [1, 2, 3, 4, 5].map((index) => ({
      file: `src/server/step${String(index)}.ts`,
      reason: `Step ${String(index)} of the export.`,
      score: 0.5,
    }));
    const flows = ['one', 'two', 'three', 'four', 'five', 'six'];
    const build = expectOk(
      builder.buildPlanRequest({
        context: stageContext().context,
        understanding: UNDERSTANDING,
        investigation: { relevantFiles: files, flows },
        adapterCatalog: ADAPTER_CATALOG,
      }),
    );
    expect(build.request.input['investigation']).toEqual({
      relevantFiles: files.slice(0, 2),
      flows: flows.slice(0, 3),
    });
    expect(build.truncated).toEqual(['investigation']);
  });

  it('maxExcerpts and maxExcerptLines bound the analysis excerpts, keeping their locations', () => {
    const { builder } = builderFixture(probeLibrary(), {
      limits: { maxExcerpts: 2, maxExcerptLines: 3 },
    });
    const excerpts = [excerpt(1, 8), excerpt(2, 2), excerpt(3, 8)];
    const build = expectOk(
      builder.buildAnalyzeRequest({
        context: stageContext().context,
        understanding: UNDERSTANDING,
        stageInput: analysisStageInput([]),
        excerpts,
      }),
    );
    const kept = build.request.input['codeExcerpts'];
    const list: readonly unknown[] = Array.isArray(kept) ? kept : [];
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      ...excerpts[0],
      text: excerpts[0]!.text.split('\n').slice(0, 3).join('\n'),
      endLine: 12,
      truncated: true,
    });
    expect(list[1]).toEqual(excerpts[1]);
    expect(JSON.stringify(list)).not.toContain('module3');
    expect(build.truncated).toEqual(['codeExcerpts']);
  });

  it('maxExcerptChars cuts an analysis excerpt on a whole line, keeping its location', () => {
    const maxExcerptChars = 60;
    const { builder } = builderFixture(probeLibrary(), { limits: { maxExcerptChars } });
    const source = excerpt(1, 3);
    const build = expectOk(
      builder.buildAnalyzeRequest({
        context: stageContext().context,
        understanding: UNDERSTANDING,
        stageInput: analysisStageInput([]),
        excerpts: [source],
      }),
    );
    const kept = build.request.input['codeExcerpts'];
    const first: unknown = Array.isArray(kept) ? (kept as readonly unknown[])[0] : undefined;
    const record = isRecord(first) ? first : {};
    const text = typeof record['text'] === 'string' ? record['text'] : '';
    const sourceLines = source.text.split('\n');
    const keptLines = text.split('\n');
    expect(source.text.length).toBeGreaterThan(maxExcerptChars);
    expect(text.length).toBeLessThanOrEqual(maxExcerptChars);
    expect(keptLines).toEqual(sourceLines.slice(0, keptLines.length));
    expect(record['file']).toBe(source.file);
    expect(record['symbol']).toBe(source.symbol);
    expect(record['startLine']).toBe(source.startLine);
    expect(record['endLine']).toBe(source.startLine + keptLines.length - 1);
    expect(record['truncated']).toBe(true);
    expect(build.truncated).toEqual(['codeExcerpts']);
  });

  it('serialises the analysis input excerpts as they arrive when no replacement is given', () => {
    const { builder } = builderFixture(probeLibrary(), { limits: { maxExcerptLines: 2 } });
    const stageInput = analysisStageInput([excerpt(1, 6)]);
    const build = expectOk(
      builder.buildAnalyzeRequest({
        context: stageContext().context,
        understanding: UNDERSTANDING,
        stageInput,
      }),
    );
    expect(build.request.input['codeExcerpts']).toEqual(stageInput.excerpts);
    expect(build.truncated).toEqual([]);
  });

  it('maxSectionNodes bounds one serialised section', () => {
    const { builder } = builderFixture(probeLibrary(), { limits: { maxSectionNodes: 12 } });
    const build = expectOk(builder.buildUnderstandRequest({ context: stageContext().context }));
    const summary = build.request.input['projectSummary'];
    expect(isRecord(summary)).toBe(true);
    expect(Object.keys(isRecord(summary) ? summary : {}).length).toBeLessThan(
      Object.keys(PROJECT_SUMMARY).length,
    );
    expect(build.truncated).toEqual(['projectSummary']);
  });

  it('maxDepth bounds the nesting of one serialised section', () => {
    const { builder } = builderFixture(probeLibrary(), { limits: { maxDepth: 3 } });
    const catalog = { level1: { level2: { level3: { level4: 'deep' } } }, shallow: 'kept' };
    const build = expectOk(
      builder.buildPlanRequest({
        context: stageContext().context,
        understanding: UNDERSTANDING,
        investigation: { relevantFiles: [], flows: [] },
        adapterCatalog: catalog,
      }),
    );
    expect(build.request.input['adapterCatalog']).toEqual({
      level1: { level2: {} },
      shallow: 'kept',
    });
    expect(JSON.stringify(build.request.input)).not.toContain('deep');
    expect(build.truncated).toEqual(['adapterCatalog']);
  });

  it('maxPayloadBytes: a stage input that cannot be fitted is refused before any prompt loads', () => {
    const { builder, double } = builderFixture(committedLibrary(), {
      limits: { maxPayloadBytes: 200 },
    });
    const error = expectErr(
      builder.buildAnalyzeRequest({
        context: stageContext().context,
        understanding: UNDERSTANDING,
        stageInput: analysisStageInput([excerpt(1, 20)]),
      }),
    );
    expect(error.code).toBe('INTERNAL');
    expect(error.details?.['reason']).toBe('payload-budget');
    expect(error.details?.['maxPayloadBytes']).toBe(200);
    expect(error.details?.['dropped']).toEqual(['codeExcerpts']);
    expect(errorText(error)).not.toContain(QUESTION_SENTINEL);
    expect(errorText(error)).not.toContain('evt-db-0004');
    expect(double.load).not.toHaveBeenCalled();
  });

  it('maxPayloadBytes: buildStageRequest refuses an over-budget input without rendering it', () => {
    const { builder } = builderFixture(probeLibrary(), { limits: { maxPayloadBytes: 64 } });
    const values = Object.fromEntries(STAGE_PLACEHOLDERS.plan.map((key) => [key, key]));
    const error = expectErr(
      builder.buildStageRequest({
        stage: 'plan',
        values,
        input: { investigation: { flows: [cycle('flow step ', 200)] } },
      }),
    );
    expect(error.details?.['reason']).toBe('payload-budget');
    expect(error.details?.['dropped']).toEqual([]);
    expect(errorText(error)).not.toContain('flow step');
  });
});

/** `count` distinct, moderately long strings labelled `label`. */
function bulkList(label: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `${label}-${String(index)}-${cycle('abcdefghij', 40)}`,
  );
}

/** The sections the budget protects, plus a question key it has no step for. */
const PROTECTED_PART: JsonObject = deepFreeze({
  question: 'kept-question-marker',
  understanding: UNDERSTANDING,
  analysis: {
    observed: [
      {
        statement: 'The slowest span took 640 ms.',
        evidence: EVIDENCE_EVENT_IDS.map((eventId) => ({ eventId })),
      },
    ],
    likelyCauses: [],
  },
  plan: INSTALLED_PLAN,
});

/** One large section for every budget step. */
const TRIMMABLE_PART: JsonObject = deepFreeze({
  codeExcerpts: bulkList('excerpt', 40),
  candidates: bulkList('candidate', 40),
  panel: { layout: bulkList('node', 40) },
  projectSummary: { entryPoints: bulkList('entry', 40) },
  queryResults: bulkList('run', 40),
  captureSummary: { rows: bulkList('row', 40) },
  investigation: { relevantFiles: bulkList('file', 40) },
});

const BUDGET_PAYLOAD: JsonObject = deepFreeze({ ...PROTECTED_PART, ...TRIMMABLE_PART });

describe('payload budget', () => {
  it('documents the lowest-value-first order and the protected sections', () => {
    expect(PAYLOAD_BUDGET_STEPS.map((step) => step.section)).toEqual([
      'codeExcerpts',
      'candidates',
      'panel',
      'projectSummary',
      'queryResults',
      'captureSummary',
      'investigation',
    ]);
    expect(PAYLOAD_BUDGET_STEPS.map((step) => step.keep)).toEqual([
      'head',
      'head',
      'head',
      'head',
      'tail',
      'head',
      'head',
    ]);
    expect([...PROTECTED_PAYLOAD_SECTIONS]).toEqual(['understanding', 'analysis', 'plan']);
    const stepSections: readonly string[] = PAYLOAD_BUDGET_STEPS.map((step) => step.section);
    for (const kept of ['question', ...PROTECTED_PAYLOAD_SECTIONS]) {
      expect(stepSections).not.toContain(kept);
    }
    expect(Object.isFrozen(PAYLOAD_BUDGET_STEPS)).toBe(true);
    expect(Object.isFrozen(PROTECTED_PAYLOAD_SECTIONS)).toBe(true);
  });

  it('leaves a payload that already fits untouched', () => {
    const budget = applyPayloadBudget(BUDGET_PAYLOAD, CONTEXT_LIMITS);
    expect(budget).toEqual({
      payload: BUDGET_PAYLOAD,
      dropped: [],
      trimmed: [],
      bytes: estimatePayloadBytes(BUDGET_PAYLOAD),
      fits: true,
    });
    expect(budget.payload).not.toBe(BUDGET_PAYLOAD);
  });

  it('gives sections up strictly in step order and never the question, understanding, analysis or plan', () => {
    const before = snapshot(BUDGET_PAYLOAD);
    const maxPayloadBytes = estimatePayloadBytes(PROTECTED_PART);
    const budget = applyPayloadBudget(BUDGET_PAYLOAD, { maxPayloadBytes });
    const order = PAYLOAD_BUDGET_STEPS.map((step) => step.section);
    expect(budget.dropped).toEqual(order);
    expect(budget.trimmed).toEqual(order);
    expect(budget.fits).toBe(true);
    expect(budget.bytes).toBe(estimatePayloadBytes(budget.payload));
    expect(budget.bytes).toBeLessThanOrEqual(maxPayloadBytes);
    expect(budget.payload).toEqual(PROTECTED_PART);
    expect(JSON.stringify(budget.payload)).toContain('kept-question-marker');
    for (const id of EVIDENCE_EVENT_IDS) {
      expect(JSON.stringify(budget.payload['analysis'])).toContain(id);
    }
    expect(snapshot(BUDGET_PAYLOAD)).toBe(before);
  });

  it('stops at the first step that makes the payload fit, leaving later sections whole', () => {
    const withoutExcerpts = Object.fromEntries(
      Object.entries(BUDGET_PAYLOAD).filter(([key]) => key !== 'codeExcerpts'),
    );
    const budget = applyPayloadBudget(BUDGET_PAYLOAD, {
      maxPayloadBytes: estimatePayloadBytes(withoutExcerpts),
    });
    expect(budget.dropped).toEqual(['codeExcerpts']);
    expect(budget.trimmed).toEqual(['codeExcerpts']);
    expect(budget.fits).toBe(true);
    expect(budget.payload).toEqual(withoutExcerpts);
  });

  it('halves a list before dropping its section, keeping the tail of the query log and the head elsewhere', () => {
    const runs = bulkList('run', 8);
    const excerpts = bulkList('excerpt', 8);
    const tailPayload: JsonObject = deepFreeze({
      understanding: UNDERSTANDING,
      queryResults: runs,
    });
    const tail = applyPayloadBudget(tailPayload, {
      maxPayloadBytes: estimatePayloadBytes({ ...tailPayload, queryResults: runs.slice(4) }),
    });
    expect(tail.trimmed).toEqual(['queryResults']);
    expect(tail.dropped).toEqual([]);
    expect(tail.payload['queryResults']).toEqual(runs.slice(4));

    const headPayload: JsonObject = deepFreeze({
      understanding: UNDERSTANDING,
      codeExcerpts: excerpts,
    });
    const head = applyPayloadBudget(headPayload, {
      maxPayloadBytes: estimatePayloadBytes({ ...headPayload, codeExcerpts: excerpts.slice(0, 4) }),
    });
    expect(head.trimmed).toEqual(['codeExcerpts']);
    expect(head.dropped).toEqual([]);
    expect(head.payload['codeExcerpts']).toEqual(excerpts.slice(0, 4));
  });

  it('honours additional protected sections and reports an unfittable payload instead of sending it', () => {
    const budget = applyPayloadBudget(
      BUDGET_PAYLOAD,
      { maxPayloadBytes: 10 },
      { protectedSections: ['captureSummary'] },
    );
    expect(budget.fits).toBe(false);
    expect(budget.dropped).not.toContain('captureSummary');
    expect(budget.trimmed).not.toContain('captureSummary');
    expect(budget.payload['captureSummary']).toEqual(BUDGET_PAYLOAD['captureSummary']);
    expect(budget.payload['understanding']).toEqual(UNDERSTANDING);
    expect(budget.bytes).toBe(estimatePayloadBytes(budget.payload));
  });
});

describe('truncation report', () => {
  it('names sections only — sorted, unique and free of any value text', () => {
    const question = `${BASE_QUESTION} ${cycle('elaborate detail ', 300)}`;
    const target: SelectedTarget = { ...TARGET, text: cycle('visible label text ', 12) };
    const { builder } = builderFixture(committedLibrary(), {
      limits: {
        maxQuestionChars: 40,
        maxUrlChars: 24,
        maxStringChars: 12,
        maxListItems: 2,
        maxSectionNodes: 10,
      },
    });
    const build = expectOk(
      builder.buildUnderstandRequest({
        context: stageContext({ question, target }).context,
        questionHints: { tokens: ['one', 'two', 'three'] },
      }),
    );
    expect(build.truncated).toEqual([
      'currentUrl',
      'projectSummary',
      'question',
      'questionHints',
      'target',
    ]);
    const report = JSON.stringify(build.truncated);
    for (const fragment of [
      QUESTION_SENTINEL,
      'elaborate',
      'visible',
      'three',
      'WorkspaceShell',
      '127.0.0.1',
      TRUNCATION_MARKER,
    ]) {
      expect(report).not.toContain(fragment);
    }
    for (const name of build.truncated) {
      expect(name).toMatch(/^[A-Za-z]+$/);
    }
  });

  it('merges the caller-supplied names of buildStageRequest, sorted and de-duplicated', () => {
    const { builder } = builderFixture(probeLibrary());
    const values = Object.fromEntries(STAGE_PLACEHOLDERS.plan.map((key) => [key, key]));
    const build = expectOk(
      builder.buildStageRequest({
        stage: 'plan',
        values,
        input: {},
        truncated: ['investigation', 'adapterCatalog', 'investigation'],
      }),
    );
    expect(build.truncated).toEqual(['adapterCatalog', 'investigation']);
  });
});

describe('evidence survival', () => {
  it('an analyze build keeps every cited evidence id when the budget sheds the excerpts', () => {
    const stageInput = deepFreeze(
      analysisStageInput(Array.from({ length: 8 }, (_unused, index) => excerpt(index + 1, 40, 60))),
    );
    const request = deepFreeze({
      context: stageContext().context,
      understanding: UNDERSTANDING,
      stageInput,
    });
    const full = expectOk(builderFixture(committedLibrary()).builder.buildAnalyzeRequest(request));
    const maxPayloadBytes = estimatePayloadBytes({ ...full.request.input, codeExcerpts: [] }) + 400;
    expect(estimatePayloadBytes(full.request.input)).toBeGreaterThan(maxPayloadBytes);

    const { builder } = builderFixture(committedLibrary(), { limits: { maxPayloadBytes } });
    const build = expectOk(builder.buildAnalyzeRequest(request));
    expect(build.truncated).toContain('codeExcerpts');
    expect(build.truncated).not.toContain('captureSummary');
    expect(build.request.input['captureSummary']).toEqual(full.request.input['captureSummary']);
    expect(estimatePayloadBytes(build.request.input)).toBeLessThanOrEqual(maxPayloadBytes);

    const evidence = JSON.stringify(build.request.input['captureSummary']);
    for (const id of EVIDENCE_EVENT_IDS) {
      expect(evidence).toContain(id);
      expect(build.request.prompt).toContain(id);
    }
  });

  it('the capture summary carries the analysis input minus the prompt-only and separately rendered fields', () => {
    const stageInput = analysisStageInput();
    const { builder } = builderFixture(committedLibrary());
    const build = expectOk(
      builder.buildAnalyzeRequest({
        context: stageContext().context,
        understanding: UNDERSTANDING,
        stageInput,
      }),
    );
    const summary = build.request.input['captureSummary'];
    const expectedKeys = Object.keys(stageInput)
      .filter((key) => key !== 'question' && key !== 'excerpts')
      .sort();
    expect(Object.keys(isRecord(summary) ? summary : {}).sort()).toEqual(expectedKeys);
    expect(build.request.input['codeExcerpts']).toEqual(stageInput.excerpts);
  });
});

describe('determinism', () => {
  it('toPromptJson is compact, key-sorted at every level and insertion-order independent', () => {
    const first = { zeta: 1, alpha: { delta: [3, { y: 1, x: 2 }], beta: 'b' } };
    const second = { alpha: { beta: 'b', delta: [3, { x: 2, y: 1 }] }, zeta: 1 };
    expect(toPromptJson(first)).toBe(toPromptJson(second));
    expect(toPromptJson(first)).toBe('{"alpha":{"beta":"b","delta":[3,{"x":2,"y":1}]},"zeta":1}');
  });

  it('toPromptJson follows JSON.stringify for what survives, and is total', () => {
    expect(
      toPromptJson({
        dropped: undefined,
        fn: () => 1,
        keep: [undefined, Number.NaN, Number.POSITIVE_INFINITY],
        when: new Date(0),
      }),
    ).toBe('{"keep":[null,null,null],"when":"1970-01-01T00:00:00.000Z"}');
    expect(toPromptJson(undefined)).toBe('null');
    expect(toPromptJson(10n)).toBe('"10"');
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(toPromptJson(cyclic)).toBe('{"name":"loop"}');
  });

  it.each(CONTEXT_BUILDER_STAGES)(
    'two identical %s builds are byte-identical whatever the clocks read',
    (stage) => {
      const early = builderFixture(committedLibrary(), { now: steppingClock(1) });
      const late = builderFixture(committedLibrary(), { now: steppingClock(9_000_000_000_000) });
      const first = expectOk(buildStage(early.builder, stage, stageContext()));
      const second = expectOk(buildStage(late.builder, stage, stageContext()));
      const again = expectOk(buildStage(early.builder, stage, stageContext()));
      for (const build of [second, again]) {
        expect(build.request.prompt).toBe(first.request.prompt);
        expect(toPromptJson(build.request.input)).toBe(toPromptJson(first.request.input));
        expect(JSON.stringify(build.request)).toBe(JSON.stringify(first.request));
        expect(build.bytes).toBe(first.bytes);
        expect(build.truncated).toEqual(first.truncated);
      }
      expect(JSON.stringify(first.request)).not.toContain(String(FIXED_EPOCH_MS + 37));
    },
  );
});

describe('input non-mutation', () => {
  it.each(CONTEXT_BUILDER_STAGES)('a %s build leaves every argument unchanged', (stage) => {
    const fixture = stageContext();
    deepFreeze(fixture.context);
    const before = snapshot(fixture.context);
    const constants = snapshot([
      TARGET,
      UNDERSTANDING,
      PROJECT_SUMMARY,
      RELEVANT_FILES,
      ADAPTER_CATALOG,
      INSTALLED_PLAN,
      QUESTION_HINTS,
    ]);
    const { builder } = builderFixture(committedLibrary());
    expectOk(buildStage(builder, stage, fixture));
    expect(snapshot(fixture.context)).toBe(before);
    expect(
      snapshot([
        TARGET,
        UNDERSTANDING,
        PROJECT_SUMMARY,
        RELEVANT_FILES,
        ADAPTER_CATALOG,
        INSTALLED_PLAN,
        QUESTION_HINTS,
      ]),
    ).toBe(constants);
    expect(fixture.codeReads).toEqual([]);
  });

  it('buildStageRequest leaves its spec unchanged and returns the same input object it was given', () => {
    const { builder } = builderFixture(probeLibrary());
    const input: JsonObject = deepFreeze({ investigation: { relevantFiles: [], flows: ['a'] } });
    const truncated = deepFreeze(['investigation']);
    const spec = deepFreeze({
      stage: 'plan' as const,
      values: Object.fromEntries(STAGE_PLACEHOLDERS.plan.map((key) => [key, key])),
      input,
      sessionId: SESSION_ID,
      truncated,
    });
    const before = snapshot(spec);
    const build = expectOk(builder.buildStageRequest(spec));
    expect(snapshot(spec)).toBe(before);
    expect(build.request.input).toBe(input);
  });
});

/** `promptVersions` recording one version for one stage. */
function recordedVersion(stage: PromptStage, version: string): SessionRecord['promptVersions'] {
  const versions: Partial<Record<PromptStage, string>> = {};
  versions[stage] = version;
  return versions;
}

describe('prompt version resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(CONTEXT_BUILDER_STAGES)(
    '%s with no supplied or recorded version loads the current prompt',
    (stage) => {
      const { builder, double } = builderFixture(committedLibrary());
      const build = expectOk(buildStage(builder, stage, stageContext()));
      expect(double.load).toHaveBeenCalledTimes(1);
      expect(double.load).toHaveBeenCalledWith(stage);
      expect(double.loadVersion).not.toHaveBeenCalled();
      expect(double.versions).not.toHaveBeenCalled();
      expect(double.clearCache).not.toHaveBeenCalled();
      expect(build.promptVersion).toBe(CURRENT_VERSION);
      expect(build.request.metadata.promptVersion).toBe(CURRENT_VERSION);
    },
  );

  it.each(CONTEXT_BUILDER_STAGES)(
    '%s reuses a recorded superseded version through loadVersion and reports it',
    (stage) => {
      const { builder, double } = builderFixture(committedLibrary());
      const fixture = stageContext({ promptVersions: recordedVersion(stage, SUPERSEDED_VERSION) });
      const build = expectOk(buildStage(builder, stage, fixture));
      expect(double.loadVersion).toHaveBeenCalledTimes(1);
      expect(double.loadVersion).toHaveBeenCalledWith(stage, SUPERSEDED_VERSION);
      expect(double.load).not.toHaveBeenCalled();
      expect(build.promptVersion).toBe(SUPERSEDED_VERSION);
      expect(build.request.metadata.promptVersion).toBe(SUPERSEDED_VERSION);
      expect(build.request.prompt.startsWith(SUPERSEDED_HEADER)).toBe(true);
    },
  );

  it('an explicitly supplied version wins over the recorded one', () => {
    const { builder, double } = builderFixture(committedLibrary());
    const fixture = stageContext({ promptVersions: recordedVersion('plan', SUPERSEDED_VERSION) });
    const build = expectOk(
      buildStage(builder, 'plan', fixture, { promptVersion: CURRENT_VERSION }),
    );
    expect(double.loadVersion).toHaveBeenCalledWith('plan', CURRENT_VERSION);
    expect(double.load).not.toHaveBeenCalled();
    expect(build.promptVersion).toBe(CURRENT_VERSION);
  });

  it('a version recorded for another stage does not change this stage', () => {
    const { builder, double } = builderFixture(committedLibrary());
    const fixture = stageContext({
      promptVersions: recordedVersion('analyze', SUPERSEDED_VERSION),
    });
    const build = expectOk(buildStage(builder, 'understand', fixture));
    expect(double.load).toHaveBeenCalledWith('understand');
    expect(double.loadVersion).not.toHaveBeenCalled();
    expect(build.promptVersion).toBe(CURRENT_VERSION);
  });

  it('buildStageRequest uses loadVersion with a version and load without one', () => {
    const { builder, double } = builderFixture(probeLibrary());
    const values = Object.fromEntries(STAGE_PLACEHOLDERS.plan.map((key) => [key, key]));
    const current = expectOk(builder.buildStageRequest({ stage: 'plan', values, input: {} }));
    expect(double.load).toHaveBeenCalledWith('plan');
    expect(current.promptVersion).toBe(CURRENT_VERSION);
    expect(current.request.metadata).toEqual({ stage: 'plan', promptVersion: CURRENT_VERSION });

    const pinned = expectOk(
      builder.buildStageRequest({ stage: 'plan', values, input: {}, promptVersion: 'v001' }),
    );
    expect(double.loadVersion).toHaveBeenCalledWith('plan', 'v001');
    expect(pinned.promptVersion).toBe('v001');
  });

  it('an unknown version is the loader error, returned unchanged, with no request built', () => {
    const { builder, double } = builderFixture(committedLibrary());
    const fixture = stageContext({ promptVersions: recordedVersion('investigate', 'v999') });
    const error = expectErr(buildStage(builder, 'investigate', fixture));
    expect(double.loadVersion).toHaveBeenCalledWith('investigate', 'v999');
    expect(double.load).not.toHaveBeenCalled();
    const settled = double.loadVersion.mock.results[0];
    const loaderResult = settled?.type === 'return' ? settled.value : undefined;
    expect(loaderResult?.ok).toBe(false);
    expect(error).toBe(loaderResult !== undefined && !loaderResult.ok ? loaderResult.error : null);
    expect(error.details).toEqual({ stage: 'investigate', version: 'v999' });
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — the outbound guard (AAP §0.5.2, second checkpoint)
// ---------------------------------------------------------------------------

/** One denied pattern, planted in a structured section, and what must never surface. */
interface DeniedCase {
  readonly label: string;
  readonly ruleId: RedactionRuleId;
  readonly section: JsonObject;
  /** The planted value and every ten-character window of its opaque body. */
  readonly probes: readonly string[];
}

/** `value` plus every ten-character window of `body`, the part that identifies the secret. */
function leakProbes(value: string, body: string): string[] {
  const probes = [value];
  for (let start = 0; start + 10 <= body.length; start += 1) {
    probes.push(body.slice(start, start + 10));
  }
  return probes;
}

/** One case per representative deny-list class, every value assembled at runtime. */
function deniedCases(): DeniedCase[] {
  const headerBody = cycle(ALNUM, 24);
  const headerValue = assemble('Opaque ', headerBody);
  const keyBody = cycle(URLSAFE, 32);
  const providerKey = assemble('s', 'k-', keyBody);
  const jwtBody = assemble(cycle(ALNUM, 20), '.', cycle(URLSAFE, 16), '.', cycle(ALNUM, 24));
  const jwt = assemble('ey', 'J', jwtBody);
  const password = cycle(ALNUM, 14);
  const connection = assemble(
    'postgres',
    'ql',
    '://',
    'svc_reader',
    ':',
    password,
    '@',
    'db.internal.example',
    ':5432/ledger',
  );
  const cursor = cycle(ALNUM, 12);
  const url = assemble('/reports/export', '?', 'cursor', '=', cursor);
  return [
    {
      label: 'a sensitive header value',
      ruleId: 'sensitive-header',
      section: { requests: [{ method: 'GET', headers: { authorization: headerValue } }] },
      probes: leakProbes(headerValue, headerBody),
    },
    {
      label: 'a provider-key-prefixed string',
      ruleId: 'provider-key',
      section: { note: providerKey },
      probes: leakProbes(providerKey, keyBody),
    },
    {
      label: 'a JWT-shaped string',
      ruleId: 'jwt',
      section: { attributes: { detail: jwt } },
      probes: leakProbes(jwt, jwtBody),
    },
    {
      label: 'a credentialed connection string',
      ruleId: 'connection-string',
      section: { spans: [{ name: 'connect', target: connection }] },
      probes: leakProbes(connection, password),
    },
    {
      label: 'an unmasked URL query value',
      ruleId: 'url-query-value',
      section: { page: url },
      probes: leakProbes(url, cursor),
    },
  ];
}

/** Compliant first-checkpoint output the guard must let through. */
function compliantCases(): { readonly label: string; readonly section: JsonObject }[] {
  const preview = `${cycle('quarterly summary ', 119)}${TRUNCATION_MARKER}`;
  return [
    {
      label: 'a denied header carrying the redaction marker',
      section: {
        requests: [
          {
            method: 'GET',
            url: `/reports?page=${URL_QUERY_MASK}`,
            status: 200,
            headers: {
              authorization: REDACTION_MARKER,
              cookie: REDACTION_MARKER,
              'content-type': 'application/json',
            },
          },
        ],
      },
    },
    {
      label: 'a ?-masked URL',
      section: { page: `/reports/export?format=${URL_QUERY_MASK}&cursor=${URL_QUERY_MASK}` },
    },
    {
      label: 'parameterized SQL with $1 placeholders',
      section: {
        queries: [
          {
            statement:
              'SELECT id, total_cents FROM ledger_entries WHERE account_id = $1 AND posted_at > $2 LIMIT $3',
            rowCount: 12,
          },
        ],
      },
    },
    {
      label: 'a 120-character truncated preview',
      section: { props: { label: { type: 'string', preview } } },
    },
    {
      label: 'ordinary prose',
      section: { note: 'The export control re-renders twice before the report request settles.' },
    },
  ];
}

/** Placeholder values for an analyze request whose capture summary is `captureSummary`. */
function analyzeValuesFor(captureSummary: string): Record<string, string> {
  return {
    question: 'Why is the export slow?',
    understanding: toPromptJson(UNDERSTANDING),
    captureSummary,
    codeExcerpts: '[]',
    outputSchema: outputSchemaFor('analyze'),
  };
}

describe('outbound guard', () => {
  it.each(deniedCases())(
    'refuses $label planted in a structured input section, leaking nothing',
    (denied) => {
      const { builder, log } = builderFixture(committedLibrary());
      const result = builder.buildStageRequest({
        stage: 'analyze',
        values: analyzeValuesFor('{}'),
        input: { understanding: UNDERSTANDING, captureSummary: denied.section },
        sessionId: SESSION_ID,
      });
      const error = expectErr(result);
      expect(error.code).toBe('INTERNAL');
      expect(error.details?.['ruleIds']).toContain(denied.ruleId);
      const paths = error.details?.['paths'];
      expect(Array.isArray(paths)).toBe(true);
      for (const path of Array.isArray(paths) ? (paths as unknown[]) : []) {
        expect(String(path).startsWith('input.captureSummary')).toBe(true);
      }

      const exposed = errorText(error);
      const logged = JSON.stringify(log.records);
      for (const probe of denied.probes) {
        expect(exposed).not.toContain(probe);
        expect(logged).not.toContain(probe);
      }

      const warnings = log.records.filter((record) => record.level === 'warn');
      expect(warnings).toHaveLength(1);
      const fields = warnings[0]!.fields;
      expect(fields['ruleIds']).toContain(denied.ruleId);
      for (const ruleId of fields['ruleIds'] as readonly string[]) {
        expect(REDACTION_RULE_IDS).toContain(ruleId);
      }
      expect(fields['paths']).toEqual(paths);
      // Beyond the rule ids and paths, the record carries provenance only: the stage, the
      // version, the error code and the subsystem binding.
      const provenance: readonly unknown[] = [
        'analyze',
        CURRENT_VERSION,
        'INTERNAL',
        'pipeline.context',
      ];
      for (const [key, value] of Object.entries(fields)) {
        if (key !== 'ruleIds' && key !== 'paths') {
          expect({ key, provenance: provenance.includes(value) }).toEqual({
            key,
            provenance: true,
          });
        }
      }
      expect(log.records.filter((record) => record.level === 'debug')).toEqual([]);
    },
  );

  it('a stage builder runs the same guard over its structured sections', () => {
    const fixture = stageContext();
    const { builder } = builderFixture(committedLibrary());
    const headerBody = cycle(ALNUM, 20);
    const error = expectErr(
      builder.buildPlanRequest({
        context: fixture.context,
        understanding: UNDERSTANDING,
        investigation: { relevantFiles: RELEVANT_FILES, flows: [] },
        adapterCatalog: {
          adapters: [{ id: 'fetch', sampleHeaders: { cookie: assemble('session=', headerBody) } }],
        },
      }),
    );
    expect(error.details?.['ruleIds']).toEqual(['sensitive-header']);
    expect(error.details?.['sessionId']).toBe(SESSION_ID);
    for (const probe of leakProbes(headerBody, headerBody)) {
      expect(errorText(error)).not.toContain(probe);
      expect(JSON.stringify(fixture.log.records)).not.toContain(probe);
    }
    const warnings = fixture.log.records.filter((record) => record.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields['stage']).toBe('plan');
  });

  it.each(compliantCases())('builds $label, in the prompt and the input alike', (compliant) => {
    const { builder } = builderFixture(committedLibrary());
    const build = expectOk(
      builder.buildStageRequest({
        stage: 'analyze',
        values: analyzeValuesFor(toPromptJson(compliant.section)),
        input: { understanding: UNDERSTANDING, captureSummary: compliant.section },
        sessionId: SESSION_ID,
      }),
    );
    expect(build.request.prompt).toContain(toPromptJson(compliant.section));
    expect(build.request.input['captureSummary']).toBe(compliant.section);
  });

  it('the truncated preview fixture is exactly the 120-character first-checkpoint shape', () => {
    const preview = compliantCases()
      .map((entry) => JSON.stringify(entry.section))
      .find((text) => text.includes('preview'));
    expect(preview).toBeDefined();
    const match = /"preview":"([^"]*)"/.exec(preview ?? '');
    expect(match?.[1]).toHaveLength(CONTEXT_LIMITS.maxTargetTextChars);
    expect(match?.[1]?.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('the committed prompts and the stage builders pass the guard with realistic data', () => {
    for (const stage of CONTEXT_BUILDER_STAGES) {
      const { builder } = builderFixture(committedLibrary());
      expect({ stage, ok: buildStage(builder, stage, stageContext()).ok }).toEqual({
        stage,
        ok: true,
      });
    }
  });

  it('an already-aborted signal refuses buildStageRequest before any prompt is loaded', () => {
    const controller = new AbortController();
    controller.abort();
    const { builder, double } = builderFixture(committedLibrary());
    const error = expectErr(
      builder.buildStageRequest({
        stage: 'plan',
        values: Object.fromEntries(STAGE_PLACEHOLDERS.plan.map((key) => [key, key])),
        input: {},
        signal: controller.signal,
        promptVersion: CURRENT_VERSION,
      }),
    );
    expect(error.code).toBe('INTERNAL');
    expect(error.details).toEqual({ stage: 'plan', reason: 'aborted' });
    expect(double.load).not.toHaveBeenCalled();
    expect(double.loadVersion).not.toHaveBeenCalled();
  });

  it.each(CONTEXT_BUILDER_STAGES)(
    '%s refuses an aborted run or request signal before any prompt is loaded',
    (stage) => {
      for (const where of ['context', 'request'] as const) {
        const controller = new AbortController();
        controller.abort();
        const { builder, double } = builderFixture(committedLibrary());
        const fixture =
          where === 'context' ? stageContext({ signal: controller.signal }) : stageContext();
        const options: StageCallOptions = where === 'request' ? { signal: controller.signal } : {};
        const error = expectErr(buildStage(builder, stage, fixture, options));
        expect({ where, details: error.details }).toEqual({
          where,
          details: { stage, reason: 'aborted' },
        });
        expect(double.load).not.toHaveBeenCalled();
        expect(double.loadVersion).not.toHaveBeenCalled();
        expect(fixture.codeReads).toEqual([]);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Phase 5 — the {{outputSchema}} documents
// ---------------------------------------------------------------------------

/** The draft the documents declare, the dialect `@debuggen/panel-schema` emits. */
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/** The property names a document declares at the level `node` describes. */
function propertyNames(node: Readonly<Record<string, unknown>>): string[] {
  const properties = node['properties'];
  return isRecord(properties) ? Object.keys(properties).sort() : [];
}

/** Asserts `example` satisfies the document and the upstream schema alike. */
function expectAccepted(
  document: unknown,
  example: unknown,
  upstream?: { safeParse(value: unknown): { readonly success: boolean } },
): void {
  expect(schemaErrors(document, example)).toEqual([]);
  if (upstream !== undefined) {
    expect(upstream.safeParse(example).success).toBe(true);
  }
}

/** Asserts `example` fails the document and the upstream schema alike. */
function expectRejected(
  document: unknown,
  example: unknown,
  upstream?: { safeParse(value: unknown): { readonly success: boolean } },
): void {
  expect(schemaErrors(document, example).length).toBeGreaterThan(0);
  if (upstream !== undefined) {
    expect(upstream.safeParse(example).success).toBe(false);
  }
}

/** A copy of `value` without `key`: the fixture with one required field left out. */
function without(value: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key));
}

/** The `index`-th `oneOf` branch of a document, or `undefined`. */
function oneOfBranch(document: Readonly<Record<string, unknown>>, index: number): unknown {
  const branches = document['oneOf'];
  const list: readonly unknown[] = Array.isArray(branches) ? branches : [];
  return list[index];
}

/** Every keyword, anywhere in a document's schema positions, that {@link schemaErrors} cannot evaluate. */
function unsupportedKeywords(node: unknown): string[] {
  if (!isRecord(node)) {
    return [];
  }
  const children: unknown[] = [];
  const properties = node['properties'];
  if (isRecord(properties)) {
    children.push(...Object.values(properties));
  }
  if (node['items'] !== undefined) {
    children.push(node['items']);
  }
  if (isRecord(node['additionalProperties'])) {
    children.push(node['additionalProperties']);
  }
  for (const keyword of ['oneOf', 'anyOf']) {
    const list = node[keyword];
    if (Array.isArray(list)) {
      const branches: readonly unknown[] = list;
      children.push(...branches);
    }
  }
  return [
    ...Object.keys(node).filter((keyword) => !CHECKED_KEYWORDS.has(keyword)),
    ...children.flatMap(unsupportedKeywords),
  ];
}

/** Regular-expression source matching `text` literally. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('{{outputSchema}} documents', () => {
  it('generate-panel delegates to the panel-schema emitter, byte for byte', () => {
    expect(outputSchemaFor('generate-panel')).toBe(panelSpecInputJsonSchemaText());
    expect(STAGE_OUTPUT_SCHEMA_SOURCES['generate-panel']).toMatchObject({
      kind: 'upstream-emitter',
      sources: ['@debuggen/panel-schema#panelSpecInputJsonSchemaText'],
    });
  });

  it('records where every stage document comes from', () => {
    expect(Object.keys(STAGE_OUTPUT_SCHEMA_SOURCES).sort()).toEqual([...PROMPT_STAGES].sort());
    expect(STAGE_OUTPUT_SCHEMA_SOURCES.understand.kind).toBe('upstream-schema');
    expect(STAGE_OUTPUT_SCHEMA_SOURCES.plan.kind).toBe('upstream-schema');
    expect(STAGE_OUTPUT_SCHEMA_SOURCES.analyze.kind).toBe('upstream-schema');
    expect(STAGE_OUTPUT_SCHEMA_SOURCES.investigate.kind).toBe('assembled');
    expect(STAGE_OUTPUT_SCHEMA_SOURCES.followup.kind).toBe('assembled');
    for (const stage of PROMPT_STAGES) {
      const { sources } = STAGE_OUTPUT_SCHEMA_SOURCES[stage];
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) {
        expect(source).toMatch(/^@debuggen\/[a-z-]+#[A-Za-z.]+$/);
      }
    }
  });

  it.each(PROMPT_STAGES)(
    'the %s document is byte-stable, canonical JSON and declares draft 2020-12',
    (stage) => {
      const options = schemaOptionsFor(stage);
      const first = outputSchemaFor(stage, options);
      expect(outputSchemaFor(stage, options)).toBe(first);
      const parsed: unknown = JSON.parse(first);
      expect(isRecord(parsed) ? parsed['$schema'] : undefined).toBe(DRAFT_2020_12);
      if (stage !== 'generate-panel') {
        expect(toPromptJson(parsed)).toBe(first);
        expect(unsupportedKeywords(parsed)).toEqual([]);
      }
    },
  );

  it.each(PROMPT_STAGES)(
    'the %s document names no route path and no application identifier',
    (stage) => {
      const text = outputSchemaFor(stage, schemaOptionsFor(stage));
      const { identifiers, routePaths } = forbiddenVocabulary();
      expect(identifiers.length).toBeGreaterThan(0);
      expect(text).not.toContain('/api/');
      expect(routePaths.filter((route) => text.includes(route))).toEqual([]);
      expect(
        identifiers.filter((identifier) =>
          new RegExp(`(?<![A-Za-z0-9_$])${literal(identifier)}(?![A-Za-z0-9_$])`).test(text),
        ),
      ).toEqual([]);
    },
  );

  it('every stage builder injects the same document the stage exposes', () => {
    for (const stage of CONTEXT_BUILDER_STAGES) {
      const { builder } = builderFixture(probeLibrary());
      const build = expectOk(buildStage(builder, stage, stageContext()));
      expect({ stage, schema: probeValues(build.request.prompt)['outputSchema'] }).toEqual({
        stage,
        schema: outputSchemaFor(stage, schemaOptionsFor(stage)),
      });
    }
  });

  describe('understand', () => {
    const document = outputDocument('understand');
    const positive = {
      category: 'performance',
      signalsNeeded: ['interactions', 'fetch'],
      entities: [
        { kind: 'component', name: 'ExportControl', file: 'src/components/ExportControl.tsx' },
      ],
      searchHints: ['export', 'toolbar'],
    };

    it('is rendered from ProblemUnderstanding and enumerates its vocabularies exactly', () => {
      expect(propertyNames(document)).toEqual(Object.keys(problemUnderstandingSchema.shape).sort());
      expect(property(document, 'category')['enum']).toEqual([...PROBLEM_CATEGORIES]);
      expect(property(document, 'signalsNeeded', 'items')['enum']).toEqual([...CAPTURE_SIGNALS]);
      expect(property(document, 'entities', 'items', 'kind')['enum']).toEqual([
        ...PROBLEM_ENTITY_KINDS,
      ]);
    });

    it('accepts what the schema accepts and rejects what it rejects', () => {
      expectAccepted(document, positive, problemUnderstandingSchema);
      expectAccepted(
        document,
        { category: 'other', signalsNeeded: ['errors'], entities: [], searchHints: [] },
        problemUnderstandingSchema,
      );
      expectRejected(document, { ...positive, category: 'slowness' }, problemUnderstandingSchema);
      expectRejected(document, { ...positive, signalsNeeded: [] }, problemUnderstandingSchema);
      expectRejected(document, { ...positive, answer: 'none' }, problemUnderstandingSchema);
      expectRejected(
        document,
        { ...positive, entities: [{ kind: 'component' }] },
        problemUnderstandingSchema,
      );
      expectRejected(document, without(positive, 'searchHints'), problemUnderstandingSchema);
    });
  });

  describe('plan', () => {
    const document = outputDocument('plan');
    const positive = {
      objective: 'Measure where the export interaction spends its time.',
      capture: ['click event timing', 'fetch calls'],
      instrumentationTargets: [
        { file: 'src/server/report.ts', symbol: 'buildReport', type: 'function-timing' },
        { file: '.', symbol: '*', type: 'fetch-tracking', rationale: 'Observe the requests.' },
      ],
      hypotheses: ['The report query dominates the interaction.'],
    };

    it('is rendered from InstrumentationPlanInput and enumerates the action types exactly', () => {
      expect(propertyNames(document)).toEqual(
        Object.keys(instrumentationPlanInputSchema.shape).sort(),
      );
      expect(property(document, 'instrumentationTargets', 'items', 'type')['enum']).toEqual([
        ...INSTRUMENTATION_ACTION_TYPES,
      ]);
      expect(document['required']).toEqual(['objective', 'capture', 'instrumentationTargets']);
    });

    it('accepts what the schema accepts and rejects what it rejects', () => {
      expectAccepted(document, positive, instrumentationPlanInputSchema);
      const [firstTarget] = positive.instrumentationTargets;
      expectRejected(
        document,
        { ...positive, instrumentationTargets: [{ ...firstTarget, type: 'magic-tracking' }] },
        instrumentationPlanInputSchema,
      );
      expectRejected(
        document,
        { ...positive, instrumentationTargets: [{ ...firstTarget, adapter: 'nextjs' }] },
        instrumentationPlanInputSchema,
      );
      expectRejected(document, without(positive, 'objective'), instrumentationPlanInputSchema);
      expectRejected(
        document,
        { ...positive, sessionId: SESSION_ID },
        instrumentationPlanInputSchema,
      );
    });
  });

  describe('analyze', () => {
    const document = outputDocument('analyze');
    const positive = {
      observed: [
        { statement: 'The report query took 640 ms.', evidence: [{ eventId: 'evt-db-0004' }] },
      ],
      likelyCauses: [
        {
          statement: 'The query scans its table without a supporting index.',
          evidence: [{ eventId: 'evt-db-0004', traceId: TRACE_ID }],
          confidence: 'medium',
        },
      ],
    };

    it('is rendered from AnalysisFindings and enumerates the confidence levels exactly', () => {
      expect(propertyNames(document)).toEqual(Object.keys(analysisFindingsSchema.shape).sort());
      expect(property(document, 'likelyCauses', 'items', 'confidence')['enum']).toEqual([
        ...CONFIDENCE_LEVELS,
      ]);
      expect(property(document, 'observed', 'items', 'evidence')['minItems']).toBe(1);
    });

    it('accepts what the schema accepts and rejects what it rejects', () => {
      expectAccepted(document, positive, analysisFindingsSchema);
      expectAccepted(document, { observed: [], likelyCauses: [] }, analysisFindingsSchema);
      expectRejected(
        document,
        { ...positive, observed: [{ statement: 'Unevidenced.', evidence: [] }] },
        analysisFindingsSchema,
      );
      expectRejected(
        document,
        {
          ...positive,
          likelyCauses: [
            { statement: 'A guess.', evidence: [{ eventId: 'e' }], confidence: 'certain' },
          ],
        },
        analysisFindingsSchema,
      );
      expectRejected(document, { observed: positive.observed }, analysisFindingsSchema);
    });
  });

  describe('investigate', () => {
    const document = outputDocument('investigate', { toolNames: TOOL_NAMES });
    const batchBranch = oneOfBranch(document, 0);
    const finalBranch = oneOfBranch(document, 1);

    it('offers exactly a query batch or the final investigation', () => {
      expect(oneOfBranch(document, 2)).toBeUndefined();
      expect(isRecord(batchBranch) ? propertyNames(batchBranch) : []).toEqual([
        INVESTIGATE_QUERY_BATCH_FIELD,
      ]);
      expect(isRecord(finalBranch) ? propertyNames(finalBranch) : []).toEqual([
        'flows',
        'relevantFiles',
      ]);
    });

    it('constrains tool names to the caller-supplied set, de-duplicated and without blanks', () => {
      expect(property(batchBranch, INVESTIGATE_QUERY_BATCH_FIELD, 'items', 'tool')['enum']).toEqual(
        [...TOOL_NAMES],
      );
      const deduplicated = outputDocument('investigate', {
        toolNames: ['whoCalls', 'whoCalls', '  ', 'findByName'],
      });
      expect(
        property(oneOfBranch(deduplicated, 0), INVESTIGATE_QUERY_BATCH_FIELD, 'items', 'tool'),
      ).toEqual({
        type: 'string',
        enum: ['whoCalls', 'findByName'],
      });
      expect(
        property(
          oneOfBranch(outputDocument('investigate'), 0),
          INVESTIGATE_QUERY_BATCH_FIELD,
          'items',
          'tool',
        ),
      ).toEqual({
        type: 'string',
        minLength: 1,
      });
    });

    it('embeds the session record shortlist schema and bounds the flows by the caps', () => {
      const relevantFiles = property(finalBranch, 'relevantFiles');
      expect(propertyNames(property(relevantFiles, 'items'))).toEqual(
        Object.keys(sessionRecordSchema.shape.relevantFiles.element.shape).sort(),
      );
      expect(property(finalBranch, 'flows')['maxItems']).toBe(CONTEXT_LIMITS.maxListItems);
      expect(property(finalBranch, 'flows', 'items')['maxLength']).toBe(
        CONTEXT_LIMITS.maxStringChars,
      );
    });

    it('accepts a batch and a final investigation, and rejects everything else', () => {
      expectAccepted(document, { queries: [{ tool: 'findByName', name: 'ExportControl' }] });
      const final = { relevantFiles: [...RELEVANT_FILES], flows: ['ExportControl -> buildReport'] };
      expectAccepted(document, final);
      expect(sessionRecordSchema.shape.relevantFiles.safeParse(final.relevantFiles).success).toBe(
        true,
      );

      expectRejected(document, { queries: [] });
      expectRejected(document, { queries: [{ tool: 'dropEverything' }] });
      expectRejected(document, { ...final, queries: [{ tool: 'findByName' }] });
      expectRejected(document, {});
      const outOfRange = {
        relevantFiles: [{ file: 'src/a.ts', reason: 'Out of range.', score: 1.5 }],
        flows: [],
      };
      expectRejected(document, outOfRange);
      expect(
        sessionRecordSchema.shape.relevantFiles.safeParse(outOfRange.relevantFiles).success,
      ).toBe(false);
    });
  });

  describe('followup', () => {
    const document = outputDocument('followup');
    const targets = instrumentationPlanInputSchema.shape.instrumentationTargets;
    const positive = {
      needsNewCapture: true,
      additionalActions: [
        {
          file: 'src/server/report.ts',
          symbol: 'loadRows',
          type: 'function-timing',
          rationale: 'Time the row loader.',
        },
        { file: '.', symbol: '*', type: 'db-query-tracking' },
      ],
    };

    it('is the decision plus authoring plan targets, with the action types enumerated exactly', () => {
      expect(propertyNames(document)).toEqual(['additionalActions', 'needsNewCapture']);
      expect(document['required']).toEqual(['needsNewCapture', 'additionalActions']);
      expect(property(document, 'needsNewCapture')).toEqual({ type: 'boolean' });
      expect(propertyNames(property(document, 'additionalActions', 'items'))).toEqual(
        Object.keys(targets.element.shape).sort(),
      );
      expect(property(document, 'additionalActions', 'items', 'type')['enum']).toEqual([
        ...INSTRUMENTATION_ACTION_TYPES,
      ]);
    });

    it('accepts what the target schema accepts and rejects what it rejects', () => {
      expectAccepted(document, positive);
      expect(targets.safeParse(positive.additionalActions).success).toBe(true);
      expectAccepted(document, { needsNewCapture: false, additionalActions: [] });

      expectRejected(document, { additionalActions: [] });
      const [firstAction] = positive.additionalActions;
      const withId = [{ ...firstAction, id: 'act_0123456789abcdef' }];
      expectRejected(document, { ...positive, additionalActions: withId });
      expect(targets.safeParse(withId).success).toBe(false);
      const badType = [{ ...firstAction, type: 'magic-tracking' }];
      expectRejected(document, { ...positive, additionalActions: badType });
      expect(targets.safeParse(badType).success).toBe(false);
    });
  });
});
