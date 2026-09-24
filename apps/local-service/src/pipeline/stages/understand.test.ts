/**
 * Colocated unit suite for `./understand.ts`, Stage 1 of the reasoning
 * pipeline (problem understanding, AAP §0.4.2).
 *
 * The headline job of this suite is AAP §0.5.4: the question tokenizer is
 * generic, and **wording alone cannot change what the pipeline sends to the
 * model**. The rules-based deterministic provider builds every answer from
 * `ModelRequest.input` and nothing else, so any phrasing-dependent content in
 * that structured input would make the product's behaviour depend on how a
 * developer happened to type a question — which is the shortcut the product
 * must never take. `./understand.ts` is also the only product file that
 * `scripts/check-no-hardcoding.mjs` allows to compare question-derived text, so
 * the tokenizer is pinned here with many small, attributable assertions rather
 * than one broad one.
 *
 * Beyond the tokenizer, the suite pins what the stage itself owns: the single
 * validation gate (at most `DEFAULT_MAX_REPAIRS` repairs, no second loop, no
 * fallback), cancellation and outbound-guard refusals that stop before any
 * provider call, the reported prompt version, the progress rows it emits (and
 * the display text it does not author), the session status it does not write,
 * and the privacy of its log records and errors.
 *
 * Everything is in-process and hand-written: a scripted `ModelProvider`, a
 * stub `ContextBuilder` that mirrors the real builder's documented contract, a
 * recording `SessionProgress`, a capturing logger and an injected clock. No
 * store, no `node:sqlite`, no prompt file, no provider transport, no network
 * and no filesystem. Fixtures use invented, generic vocabulary only; no name
 * from any real application appears here. End-to-end behaviour belongs to
 * `test/integration/pipeline-deterministic.test.ts` and
 * `session-lifecycle.test.ts`, and the repair loop's internals to
 * `packages/model-provider/src/structured.test.ts`; this suite observes only
 * the call counts that loop produces through its fakes.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  CAPTURE_SIGNALS,
  PROBLEM_CATEGORIES,
  PROBLEM_ENTITY_KINDS,
  parseSelectedTarget,
  problemUnderstandingSchema,
  type ProblemUnderstanding,
  type SelectedTarget,
} from '@debuggen/instrumentation';
import {
  DEFAULT_MAX_REPAIRS,
  PROMPT_STAGES,
  PROMPT_VERSION_PATTERN,
  assertOutboundSafe,
  type JsonObject,
  type ModelProvider,
  type ModelRequest,
  type ModelTextResponse,
  type StructuredAttempt,
  type ToolCallsResponse,
  type ToolDefinition,
} from '@debuggen/model-provider';
import {
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  parseSessionRecord,
  type ProgressStage,
  type ProgressStatus,
  type SessionProgressPayload,
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

import type { ProgressRow, SessionProgress } from '../../sessions/progress.js';
import {
  CONTEXT_LIMITS,
  type ContextBuilder,
  type PipelineCodeHandles,
  type PipelineStageContext,
  type StageRequestBuild,
  type UnderstandRequestInput,
} from '../context-builder.js';
import {
  GENERIC_SIGNAL_TERMS,
  QUESTION_STOP_WORDS,
  createUnderstandStage,
  splitCamelCase,
  tokenizeQuestion,
  type QuestionTokens,
  type UnderstandStageInput,
  type UnderstandStageResult,
} from './understand.js';

// ---------------------------------------------------------------------------
// Imported vocabulary — never restated as string literals
// ---------------------------------------------------------------------------

/**
 * The pipeline's first stage in protocol's progress vocabulary: `understand`.
 * `PROGRESS_STAGES` is declared in pipeline order, so its first member is this
 * stage; the harness test below checks the prompt vocabulary agrees.
 */
const UNDERSTAND = PROGRESS_STAGES[0];

/** The three progress statuses, in protocol's order. */
const [RUNNING, DONE, FAILED] = PROGRESS_STATUSES;

/** The session failure the `failed` progress row is built from. */
type SessionFailure = Parameters<SessionProgress['stageFailed']>[1];

/** The schema argument a provider's `generateStructured` receives. */
type StructuredSchema = Parameters<ModelProvider['generateStructured']>[0];

// ---------------------------------------------------------------------------
// Generic, invented fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-understand-suite';
const PROJECT_ROOT = '/workspace/timesheet-app';
const PROJECT_NAME = 'timesheet-app';
const DEV_SERVER_URL = 'http://127.0.0.1:4173/';
const CURRENT_URL = 'http://127.0.0.1:4173/timesheets/weekly';
const FIXED_EPOCH_MS = 1_767_225_600_000;

/** How far the injected clock advances on every read. */
const CLOCK_STEP_MS = 7;

/** The prompt version the stub builder loads when nothing names another one. */
const BUILDER_DEFAULT_VERSION = 'v004';

/** A marker only the stub builder's rendered prompt contains, so a leak of the prompt is findable. */
const PROMPT_MARKER = 'stub-rendered-understand-prompt';

/** A distinctive word planted in questions and model output; it must never reach a log or an error. */
const SENTINEL = 'quokkazephyrmarker';

/** The element the developer selected in the inspected page. */
const TARGET: SelectedTarget = {
  selector: 'main > section.timesheet-summary > button.apply-filters',
  tagName: 'button',
  text: 'Apply filters',
  componentChain: ['TimesheetSummaryCard', 'FilterDrawer'],
  url: CURRENT_URL,
};

/** The question most runs ask. */
const BASE_QUESTION = 'Why is the TimesheetSummaryCard so slow after I click Apply filters?';

/**
 * Four phrasings of {@link BASE_QUESTION} that differ only in word order,
 * filler words, capitalisation, punctuation and spacing — the same meaning.
 */
const WORDING_VARIANTS: readonly string[] = [
  BASE_QUESTION,
  'After I click apply FILTERS — why is the TimesheetSummaryCard SO slow?!',
  'Hey, so basically... why is the TimesheetSummaryCard really slow after I click apply filters? Thanks!',
  '   why   is the TimesheetSummaryCard slow,   after i click Apply   Filters ???   ',
];

/** A question that means something else: different vocabulary about the same component. */
const DIFFERENT_QUESTION = 'Why does the TimesheetSummaryCard render so many times?';

/** A schema-valid Stage 1 artifact, built from the imported vocabularies. */
const VALID_UNDERSTANDING: ProblemUnderstanding = {
  category: PROBLEM_CATEGORIES[0],
  signalsNeeded: [CAPTURE_SIGNALS[0], CAPTURE_SIGNALS[3]],
  entities: [{ kind: PROBLEM_ENTITY_KINDS[0], name: 'TimesheetSummaryCard' }],
  searchHints: ['timesheet summary', 'apply filters'],
};

/** A model answer the authoring schema rejects: an unknown category and an empty signal list. */
const INVALID_UNDERSTANDING = {
  category: 'not-a-category',
  signalsNeeded: [],
  entities: [],
  searchHints: [],
};

/** A schema-valid answer carrying {@link SENTINEL} as a search hint. */
const VALID_UNDERSTANDING_WITH_SENTINEL: ProblemUnderstanding = {
  ...VALID_UNDERSTANDING,
  searchHints: [SENTINEL],
};

/** A rejected answer carrying {@link SENTINEL} in every field. */
const INVALID_UNDERSTANDING_WITH_SENTINEL = {
  category: SENTINEL,
  signalsNeeded: [SENTINEL],
  entities: [{ kind: SENTINEL, name: SENTINEL }],
  searchHints: [`${SENTINEL}\n${SENTINEL}`],
};

/** The question planted with {@link SENTINEL}. */
const SENTINEL_QUESTION = `Why is the ${SENTINEL} widget so slow after I click Apply filters?`;

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
 * credential-shaped literal (the precedent of `scripts/check-secrets.test.mjs`
 * and `packages/model-provider/src/redact-guard.test.ts`).
 */
const ASSEMBLED_BEARER =
  ['Bea', 'rer '].join('') +
  strideOf(charRange('A', 'Z') + charRange('a', 'z') + charRange('0', '9') + '-_', 36);

// ---------------------------------------------------------------------------
// Small, pure helpers
// ---------------------------------------------------------------------------

/** Orders strings by UTF-16 code unit — the order the tokenizer promises. */
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

/**
 * Sorted-key JSON. Comparing this form means neither a difference hidden by
 * key order nor an equality faked by it can pass unnoticed.
 */
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

/** Every string the tokenizer reported, across its three lists. */
function lexicalStrings(tokens: QuestionTokens): readonly string[] {
  return [...tokens.tokens, ...tokens.identifierCandidates, ...tokens.signalTerms];
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
 * The stage never reads the code bundle — the context builder does, and the
 * builder here is a stub — so any recorded read is a boundary violation the
 * tests report. `PipelineCodeHandles` is built from `@debuggen/code-analysis`
 * types this suite deliberately does not import; the single type assertion
 * below is what lets a proxy stand in for them, and the empty read log each
 * test checks is what keeps that assertion honest.
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

/** One recorded provider call. */
interface ProviderCall {
  readonly method: 'generateText' | 'generateStructured' | 'callTools';
  readonly request: ModelRequest;
  readonly schema?: StructuredSchema;
  readonly toolCount?: number;
}

const SCRIPTED_MODEL = 'scripted-model';

/** The provider-unavailable failure a transport would report. */
function unavailableError(): DebuggenError {
  return new DebuggenError('MODEL_UNAVAILABLE', 'Model provider unavailable (test-transport).', {
    hint: 'Check the provider configuration, then retry the stage.',
    details: { transport: 'scripted' },
  });
}

/**
 * A {@link ModelProvider} that makes **exactly one attempt per call**, as the
 * interface requires, answering each `generateStructured` call with the next
 * queued outcome and recording every request it receives. It never validates,
 * never repairs and never retries: those belong to the upstream loop whose
 * call counts the tests observe. Text and tool calls are not part of this
 * stage's contract; they are recorded and refused.
 */
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted-test-provider';
  readonly calls: ProviderCall[] = [];
  readonly #queue: ScriptedOutcome[];

  constructor(outcomes: readonly ScriptedOutcome[] = []) {
    this.#queue = [...outcomes];
  }

  /** Outcomes not yet consumed. */
  get remaining(): number {
    return this.#queue.length;
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
    this.calls.push({ method: 'generateStructured', request, schema });
    const next = this.#queue.shift();
    if (next === undefined) {
      return Promise.resolve(
        err(new DebuggenError('INTERNAL', 'The scripted provider has no outcome queued.')),
      );
    }
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
    return new DebuggenError('INTERNAL', `The understand stage must not call ${method}.`);
  }
}

// ---------------------------------------------------------------------------
// Double: the stub context builder
// ---------------------------------------------------------------------------

/**
 * How the stub answers `buildUnderstandRequest`.
 *
 * - `mirror` reproduces the real builder's documented contract: every hint
 *   list at the top level of the structured input (sorted keys) beside
 *   `target` and `currentUrl`, the raw question rendered into the prompt
 *   **only**, the stage's prompt version in the metadata, the context's signal
 *   on the request, and the real `assertOutboundSafe` run before the request is
 *   returned. `onBuild` runs just before the guard, for tests that must change
 *   the world between building and sending.
 * - `fail` answers with the given error, as a refused or unbuildable request.
 * - `throw` throws, as a builder defect.
 */
type UnderstandBuildMode =
  | { readonly kind: 'mirror'; readonly onBuild?: (() => void) | undefined }
  | { readonly kind: 'fail'; readonly error: DebuggenError }
  | { readonly kind: 'throw'; readonly thrown: Error };

/** The hint lists of a `questionHints` object, keys sorted; anything that is not a string list is skipped. */
function hintSections(hints: object | undefined): Record<string, readonly string[]> {
  const sections: Record<string, readonly string[]> = {};
  if (hints === undefined) {
    return sections;
  }
  for (const key of Object.keys(hints).sort(byCodeUnit)) {
    const value: unknown = Reflect.get(hints, key);
    if (Array.isArray(value)) {
      const list: readonly unknown[] = value;
      sections[key] = list.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return sections;
}

/** The target section of the real builder: the element descriptor without its page address. */
function targetSection(target: SelectedTarget): JsonObject {
  return {
    tagName: target.tagName,
    selector: target.selector,
    ...(target.text !== undefined ? { text: target.text } : {}),
    componentChain: [...target.componentChain],
  };
}

/** A {@link ContextBuilder} whose understand request the test controls; every other stage is refused. */
class StubContextBuilder implements ContextBuilder {
  readonly limits = CONTEXT_LIMITS;
  /** Every `buildUnderstandRequest` input, in order. */
  readonly understandCalls: UnderstandRequestInput[] = [];
  /** Every build the stub returned. */
  readonly built: StageRequestBuild[] = [];
  /** Names of the other builder methods that were called — always expected to stay empty. */
  readonly otherCalls: string[] = [];
  readonly #mode: UnderstandBuildMode;

  constructor(mode: UnderstandBuildMode = { kind: 'mirror' }) {
    this.#mode = mode;
  }

  buildUnderstandRequest(
    request: UnderstandRequestInput,
  ): Result<StageRequestBuild, DebuggenError> {
    this.understandCalls.push(request);
    const mode = this.#mode;
    switch (mode.kind) {
      case 'fail':
        return err(mode.error);
      case 'throw':
        throw mode.thrown;
      case 'mirror':
        return this.#mirror(request, mode.onBuild);
    }
  }

  buildStageRequest(): Result<StageRequestBuild, DebuggenError> {
    return this.#unexpected('buildStageRequest');
  }

  buildInvestigateRequest(): Result<StageRequestBuild, DebuggenError> {
    return this.#unexpected('buildInvestigateRequest');
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

  #mirror(
    request: UnderstandRequestInput,
    onBuild: (() => void) | undefined,
  ): Result<StageRequestBuild, DebuggenError> {
    const { context } = request;
    // The real builder's version rule: an explicit version, else the one
    // recorded on the session, else the manifest's current one.
    const promptVersion =
      request.promptVersion ?? context.promptVersions[UNDERSTAND] ?? BUILDER_DEFAULT_VERSION;
    const input: JsonObject = {
      ...hintSections(request.questionHints),
      ...(context.target !== undefined ? { target: targetSection(context.target) } : {}),
      ...(context.currentUrl !== undefined ? { currentUrl: context.currentUrl } : {}),
    };
    const prompt = [
      PROMPT_MARKER,
      `prompt version: ${promptVersion}`,
      `question: ${context.question}`,
      `context: ${stableStringify(input)}`,
    ].join('\n');
    const signal = request.signal ?? context.signal;
    const modelRequest: ModelRequest = {
      prompt,
      input,
      metadata: { stage: UNDERSTAND, promptVersion, sessionId: context.sessionId },
      ...(signal !== undefined ? { signal } : {}),
    };
    onBuild?.();
    const guard = assertOutboundSafe(modelRequest);
    if (!guard.ok) {
      return guard;
    }
    const build: StageRequestBuild = {
      request: modelRequest,
      stage: UNDERSTAND,
      promptVersion,
      truncated: [],
      bytes: Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(JSON.stringify(input), 'utf8'),
    };
    this.built.push(build);
    return ok(build);
  }

  #unexpected(method: string): Result<StageRequestBuild, DebuggenError> {
    this.otherCalls.push(method);
    return err(new DebuggenError('INTERNAL', `The understand stage must not call ${method}.`));
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

  reportInvestigation(sessionId: string): Result<readonly SessionProgressPayload[], DebuggenError> {
    this.calls.push({ method: 'reportInvestigation', sessionId });
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
    return this.#answer(sessionId, UNDERSTAND, DONE);
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

/** A stored session record for one question, in the status the understand stage runs under. */
function sessionRecord(
  question: string,
  target: SelectedTarget | undefined,
  promptVersions: SessionRecord['promptVersions'],
): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    projectName: PROJECT_NAME,
    devServerUrl: DEV_SERVER_URL,
    createdAt: FIXED_EPOCH_MS,
    updatedAt: FIXED_EPOCH_MS,
    status: 'understanding',
    question,
    followUps: [],
    ...(target !== undefined ? { target } : {}),
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
  /** Omit the selected element entirely. */
  readonly withoutTarget?: boolean | undefined;
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
 * root, the question copied from a stored session record, an optional
 * selected element, the bound tab's URL, tripwire code handles, the recorded
 * prompt versions, a capturing logger, a stepping clock and an optional
 * signal. The record is deeply frozen, so a write to it would throw.
 */
function stageContext(options: ContextOptions = {}): ContextFixture {
  const question = options.question ?? BASE_QUESTION;
  const target = options.withoutTarget === true ? undefined : TARGET;
  const session = deepFreeze(sessionRecord(question, target, options.promptVersions ?? {}));
  const codeReads: string[] = [];
  const contextLog = capturedLogger();
  const now = steppingClock();
  const context: PipelineStageContext = Object.freeze({
    sessionId: session.id,
    session,
    projectRoot: session.projectRoot,
    question: session.question,
    ...(session.target !== undefined ? { target: session.target } : {}),
    currentUrl: CURRENT_URL,
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
  readonly outcomes?: readonly ScriptedOutcome[] | undefined;
  readonly mode?: UnderstandBuildMode | undefined;
  readonly progress?: ProgressBehaviour | undefined;
  readonly maxRepairs?: number | undefined;
  /** Leave `deps.logger` unset, so the stage logs through the context's logger. */
  readonly withoutLogger?: boolean | undefined;
}

/** The stage under test with its doubles. Built fresh for every test; nothing is shared. */
interface Harness {
  readonly provider: ScriptedProvider;
  readonly builder: StubContextBuilder;
  readonly progress: RecordingProgress;
  /** The logger injected as `deps.logger`. */
  readonly log: CapturedLogger;
  run(
    context: PipelineStageContext,
    input?: UnderstandStageInput,
  ): Promise<Result<UnderstandStageResult, DebuggenError>>;
}

function harness(options: HarnessOptions = {}): Harness {
  const provider = new ScriptedProvider(options.outcomes);
  const builder = new StubContextBuilder(options.mode);
  const progress = new RecordingProgress(options.progress);
  const log = capturedLogger();
  const stage = createUnderstandStage({
    contextBuilder: builder,
    provider,
    progress,
    ...(options.withoutLogger === true ? {} : { logger: log.logger }),
    ...(options.maxRepairs !== undefined ? { maxRepairs: options.maxRepairs } : {}),
  });
  return {
    provider,
    builder,
    progress,
    log,
    run: (context, input = {}) => stage.run(context, input),
  };
}

/** The structured input the provider received on its first call of a harness. */
function firstInput(fixture: Harness): JsonObject {
  const call = fixture.provider.structuredCalls[0];
  if (call === undefined) {
    throw new Error('The provider was never called.');
  }
  return call.request.input;
}

/** Every log record either logger of a run captured. */
function allRecords(fixture: Harness, context: ContextFixture): readonly LogRecord[] {
  return [...fixture.log.records, ...context.contextLog.records];
}

// ===========================================================================
// The suites
// ===========================================================================

describe('the harness', () => {
  it('uses fixtures the real schemas accept, and one stage name both vocabularies share', () => {
    expect(problemUnderstandingSchema.safeParse(VALID_UNDERSTANDING).success).toBe(true);
    expect(problemUnderstandingSchema.safeParse(VALID_UNDERSTANDING_WITH_SENTINEL).success).toBe(
      true,
    );
    expect(problemUnderstandingSchema.safeParse(INVALID_UNDERSTANDING).success).toBe(false);
    expect(problemUnderstandingSchema.safeParse(INVALID_UNDERSTANDING_WITH_SENTINEL).success).toBe(
      false,
    );
    expect(parseSelectedTarget(TARGET).ok).toBe(true);
    expect(parseSessionRecord(sessionRecord(BASE_QUESTION, TARGET, {})).ok).toBe(true);
    expect(PROMPT_STAGES[0]).toBe(UNDERSTAND);
    expect(PROMPT_VERSION_PATTERN.test(BUILDER_DEFAULT_VERSION)).toBe(true);
  });

  it('builds a request the outbound guard accepts for an ordinary question, and refuses a credential', () => {
    const accepted = new StubContextBuilder().buildUnderstandRequest({
      context: stageContext().context,
      questionHints: tokenizeQuestion(BASE_QUESTION),
    });
    expect(accepted.ok).toBe(true);

    const refused = new StubContextBuilder().buildUnderstandRequest({
      context: stageContext({ question: `Why does ${ASSEMBLED_BEARER} fail?` }).context,
    });
    expect(refused.ok).toBe(false);
  });
});

describe('the generic question tokenizer (AAP §0.5.4)', () => {
  describe('its two vocabularies', () => {
    it('QUESTION_STOP_WORDS is a frozen, sorted, duplicate-free list of lower-case words', () => {
      expect(Object.isFrozen(QUESTION_STOP_WORDS)).toBe(true);
      expect(QUESTION_STOP_WORDS.length).toBeGreaterThan(0);
      expect([...QUESTION_STOP_WORDS].sort(byCodeUnit)).toEqual(QUESTION_STOP_WORDS);
      expect(new Set(QUESTION_STOP_WORDS).size).toBe(QUESTION_STOP_WORDS.length);
      for (const word of QUESTION_STOP_WORDS) {
        expect(word).toMatch(/^[a-z]+$/u);
      }
      expect(QUESTION_STOP_WORDS).toEqual(expect.arrayContaining(['the', 'why', 'is', 'please']));
    });

    it('GENERIC_SIGNAL_TERMS holds only single lower-case words: no separator, path character or case boundary', () => {
      expect(Object.isFrozen(GENERIC_SIGNAL_TERMS)).toBe(true);
      expect(GENERIC_SIGNAL_TERMS.length).toBeGreaterThan(0);
      expect([...GENERIC_SIGNAL_TERMS].sort(byCodeUnit)).toEqual(GENERIC_SIGNAL_TERMS);
      expect(new Set(GENERIC_SIGNAL_TERMS).size).toBe(GENERIC_SIGNAL_TERMS.length);
      for (const term of GENERIC_SIGNAL_TERMS) {
        // One ASCII lower-case word: no space, hyphen, underscore, dot, slash,
        // digit or capital — so no identifier, route, file or product name.
        expect(term).toMatch(/^[a-z]+$/u);
        expect(splitCamelCase(term)).toEqual([term]);
      }
    });

    it('GENERIC_SIGNAL_TERMS is drawn from generic debugging vocabulary', () => {
      expect(GENERIC_SIGNAL_TERMS).toEqual(
        expect.arrayContaining([
          'slow',
          'render',
          'renders',
          'request',
          'requests',
          'query',
          'error',
          'duplicate',
          'latency',
          'fetch',
        ]),
      );
    });

    it('keeps the two vocabularies disjoint', () => {
      const stopWords = new Set(QUESTION_STOP_WORDS);
      expect(GENERIC_SIGNAL_TERMS.filter((term) => stopWords.has(term))).toEqual([]);
    });
  });

  describe('splitCamelCase', () => {
    it.each([
      ['camelCase', 'fooBarBaz', ['foo', 'Bar', 'Baz']],
      ['PascalCase', 'TimesheetSummaryCard', ['Timesheet', 'Summary', 'Card']],
      ['a leading acronym', 'XMLHttpThing', ['XML', 'Http', 'Thing']],
      ['an inner acronym', 'getHTTPResponse', ['get', 'HTTP', 'Response']],
      ['a lone acronym', 'HTTP', ['HTTP']],
      ['digits', 'thing2Go', ['thing', '2', 'Go']],
      ['a trailing digit run', 'retryAfter30', ['retry', 'After', '30']],
      ['snake_case', 'timesheet_entry_id', ['timesheet', 'entry', 'id']],
      ['already-split input', 'foo bar', ['foo', 'bar']],
      ['a single lower-case word', 'slow', ['slow']],
      ['full-width compatibility letters', '\uFF46\uFF4F\uFF4F\uFF22\uFF41\uFF52', ['foo', 'Bar']],
    ])('splits %s', (_label, input, expected) => {
      expect(splitCamelCase(input)).toEqual(expected);
    });

    it.each([
      ['an empty string', ''],
      ['whitespace', ' \t\n '],
      ['punctuation', '?!.,;:()[]{}/\\-'],
      ['a lone surrogate', '\uD800'],
    ])('returns an empty, frozen list for %s', (_label, input) => {
      const parts = splitCamelCase(input);
      expect(parts).toEqual([]);
      expect(Object.isFrozen(parts)).toBe(true);
    });

    it('is total, frozen and repeatable over unusual input', () => {
      for (const input of [
        'caf\u00E9Menu',
        'cafe\u0301Menu',
        '\u30DC\u30BF\u30F3',
        '🐢slowThing',
      ]) {
        const parts = splitCamelCase(input);
        expect(Object.isFrozen(parts)).toBe(true);
        expect(splitCamelCase(input)).toEqual(parts);
      }
      expect(splitCamelCase('🐢slowThing')).toEqual(['slow', 'Thing']);
    });

    it('is idempotent over its own output', () => {
      const parts = splitCamelCase('getHTTPResponseForTimesheetRow2');
      expect(splitCamelCase(parts.join(' '))).toEqual(parts);
    });
  });

  describe('tokenizeQuestion', () => {
    /** The structural promises every result keeps, whatever the question. */
    function expectWellFormed(result: QuestionTokens): void {
      expect(Object.keys(result).sort(byCodeUnit)).toEqual([
        'identifierCandidates',
        'signalTerms',
        'tokens',
      ]);
      expect(Object.isFrozen(result)).toBe(true);
      const stopWords = new Set(QUESTION_STOP_WORDS);
      const signalTerms = new Set(GENERIC_SIGNAL_TERMS);
      for (const list of [result.tokens, result.identifierCandidates, result.signalTerms]) {
        expect(Object.isFrozen(list)).toBe(true);
        expect([...new Set(list)].sort(byCodeUnit)).toEqual(list);
        for (const entry of list) {
          expect(typeof entry).toBe('string');
          expect(entry).not.toMatch(/[\s/\\.]/u);
        }
      }
      for (const token of result.tokens) {
        expect(token).toBe(token.toLowerCase());
        expect(token.length).toBeGreaterThanOrEqual(2);
        expect(token.length).toBeLessThanOrEqual(64);
        expect(stopWords.has(token)).toBe(false);
      }
      for (const term of result.signalTerms) {
        expect(signalTerms.has(term)).toBe(true);
      }
    }

    it('lower-cases every token', () => {
      expect(tokenizeQuestion('SLOW Render QUERY').tokens).toEqual(['query', 'render', 'slow']);
    });

    it('strips punctuation and splits on any whitespace', () => {
      expect(tokenizeQuestion('slow!!!\trender???\n(query), "slow".').tokens).toEqual([
        'query',
        'render',
        'slow',
      ]);
    });

    it('splits camel- and Pascal-case words into lower-cased parts and keeps each whole word as an identifier candidate', () => {
      const hook = tokenizeQuestion('Why does useTimesheetFeed refetch?');
      expect(hook.tokens).toEqual(['feed', 'refetch', 'timesheet', 'use']);
      expect(hook.identifierCandidates).toEqual(['useTimesheetFeed']);

      const component = tokenizeQuestion('Is TimesheetSummaryCard stale?');
      expect(component.tokens).toEqual(['card', 'stale', 'summary', 'timesheet']);
      expect(component.identifierCandidates).toEqual(['TimesheetSummaryCard']);
      expect(component.tokens).toEqual(
        expect.arrayContaining(
          splitCamelCase('TimesheetSummaryCard').map((part) => part.toLowerCase()),
        ),
      );
    });

    it('reports snake_case words as lower-cased identifier candidates split into their parts', () => {
      const lower = tokenizeQuestion('timesheet_entry_id is stale');
      expect(lower.identifierCandidates).toEqual(['timesheet_entry_id']);
      expect(lower.tokens).toEqual(['entry', 'id', 'stale', 'timesheet']);
      expect(tokenizeQuestion('TIMESHEET_ENTRY_ID is stale')).toEqual(lower);
    });

    it('never turns sentence case or shouting into an identifier candidate', () => {
      expect(tokenizeQuestion('Slow Timesheet SLOW TIMESHEET').identifierCandidates).toEqual([]);
    });

    it('drops stop words and one-character fragments', () => {
      expect(tokenizeQuestion('Why is it that a x slow?').tokens).toEqual(['slow']);
      expect(tokenizeQuestion('why is it that this is so, please?')).toEqual({
        tokens: [],
        identifierCandidates: [],
        signalTerms: [],
      });
    });

    it('joins contractions and drops possessives, with straight or curly apostrophes', () => {
      const plain = tokenizeQuestion('Why does not the TimesheetSummaryCard button load');
      expect(plain.tokens).toEqual(['button', 'card', 'load', 'summary', 'timesheet']);
      expect(tokenizeQuestion("Why doesn't the TimesheetSummaryCard's button load?")).toEqual(
        plain,
      );
      expect(
        tokenizeQuestion('Why doesn\u2019t the TimesheetSummaryCard\u2019s button load?'),
      ).toEqual(plain);
    });

    it('de-duplicates and sorts every list by UTF-16 code unit', () => {
      const result = tokenizeQuestion(
        'slow Slow SLOW render render query useTimesheetFeed useTimesheetFeed',
      );
      expect(result.tokens).toEqual(['feed', 'query', 'render', 'slow', 'timesheet', 'use']);
      expect(result.identifierCandidates).toEqual(['useTimesheetFeed']);
      expect(result.signalTerms).toEqual(['query', 'render', 'slow']);
    });

    it('reports exactly the tokens that are generic signal terms, verbatim', () => {
      const result = tokenizeQuestion(BASE_QUESTION);
      expect(result.tokens).toEqual([
        'apply',
        'card',
        'click',
        'filters',
        'slow',
        'summary',
        'timesheet',
      ]);
      expect(result.signalTerms).toEqual(['click', 'slow']);
      const terms = new Set(GENERIC_SIGNAL_TERMS);
      expect(result.signalTerms).toEqual(result.tokens.filter((token) => terms.has(token)));
    });

    it('performs no synonym mapping: a word outside the vocabulary yields no signal term', () => {
      const result = tokenizeQuestion('Why is the TimesheetSummaryCard sluggish?');
      expect(result.signalTerms).toEqual([]);
      expect(result.tokens).toEqual(['card', 'sluggish', 'summary', 'timesheet']);
    });

    it('caps the token list at a sorted prefix, and selects signal terms before the cap', () => {
      const filler = Array.from(
        { length: 40 },
        (_, index) =>
          `b${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
      );
      const result = tokenizeQuestion([...filler, 'slow'].join(' '));
      expect(result.tokens.length).toBeGreaterThan(0);
      expect(result.tokens.length).toBeLessThan(filler.length + 1);
      expect(result.tokens).toEqual(filler.slice(0, result.tokens.length));
      expect(result.tokens).not.toContain('slow');
      expect(result.signalTerms).toEqual(['slow']);
    });

    it('caps the identifier-candidate list at a sorted prefix', () => {
      const identifiers = Array.from(
        { length: 30 },
        (_, index) =>
          `useTimesheet${String.fromCharCode(65 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}`,
      );
      const result = tokenizeQuestion(identifiers.join(' '));
      expect(result.identifierCandidates.length).toBeGreaterThan(0);
      expect(result.identifierCandidates.length).toBeLessThan(identifiers.length);
      expect(result.identifierCandidates).toEqual(
        [...identifiers].sort(byCodeUnit).slice(0, result.identifierCandidates.length),
      );
    });

    it("reads no further than the context builder's question budget and keeps a word that ends on it", () => {
      const limit = CONTEXT_LIMITS.maxQuestionChars;
      const lead = 'why '.repeat(Math.floor((limit - 7) / 4)).padEnd(limit - 7, ' ');
      const question = `${lead}kestrel zebrafish slow`;
      expect(question.length).toBeGreaterThan(limit);
      expect(tokenizeQuestion(question)).toEqual({
        tokens: ['kestrel'],
        identifierCandidates: [],
        signalTerms: [],
      });
    });

    it('drops a word the budget cuts rather than keeping a fragment nobody wrote', () => {
      const limit = CONTEXT_LIMITS.maxQuestionChars;
      const lead = 'why '.repeat(Math.floor((limit - 3) / 4)).padEnd(limit - 3, ' ');
      const result = tokenizeQuestion(`${lead}kestrel slow`);
      expect(result.tokens).toEqual([]);
      expect(lexicalStrings(result).some((entry) => 'kestrel'.startsWith(entry))).toBe(false);
    });

    it('returns lexical data only: every reported string is spelled in the question itself', () => {
      const corpus = [
        BASE_QUESTION,
        DIFFERENT_QUESTION,
        'Why is src/timesheet/SummaryCard.tsx slow when useTimesheetFeed fetches twice?',
        'timesheet_entry_id queries fail with an error',
      ];
      for (const question of corpus) {
        const result = tokenizeQuestion(question);
        expectWellFormed(result);
        const spelled = question.normalize('NFKC').toLowerCase();
        for (const entry of lexicalStrings(result)) {
          expect(spelled).toContain(entry.toLowerCase());
        }
      }
      const path = tokenizeQuestion(corpus[2] ?? '');
      expect(path.identifierCandidates).toEqual(['SummaryCard', 'useTimesheetFeed']);
      expect(path.tokens).toEqual(
        expect.arrayContaining(['src', 'timesheet', 'summary', 'card', 'tsx', 'slow']),
      );
    });

    it('is deterministic, pure and frozen, and survives a JSON round trip', () => {
      for (const question of [...WORDING_VARIANTS, DIFFERENT_QUESTION]) {
        const original = question.slice();
        const first = tokenizeQuestion(question);
        tokenizeQuestion(SENTINEL_QUESTION);
        const second = tokenizeQuestion(question);
        expect(second).toEqual(first);
        expect(stableStringify(second)).toBe(stableStringify(first));
        expect(question).toBe(original);
        expectWellFormed(first);
        const roundTripped: unknown = JSON.parse(JSON.stringify(first));
        expect(roundTripped).toEqual(first);
      }
    });

    it.each([
      ['an empty string', ''],
      ['whitespace only', ' \t\r\n  '],
      ['punctuation only', '?!…,;:—()[]{}"\'/\\'],
      ['only stop words', 'Why is it that this is so, could you please?'],
      ['a single pasted run longer than any word', 'x'.repeat(10_000)],
    ])('returns three empty lists for %s', (_label, question) => {
      const result = tokenizeQuestion(question);
      expectWellFormed(result);
      expect(result).toEqual({ tokens: [], identifierCandidates: [], signalTerms: [] });
    });

    it.each([
      ['accented Latin', '¿Por qué está lento el botón Guardar?'],
      ['a caseless script', 'ボタンが遅いのはなぜ'],
      ['emoji between words', '🐢🐢 slow 🐢 render'],
      [
        'a surrogate pair on the budget boundary',
        `${'a'.repeat(CONTEXT_LIMITS.maxQuestionChars - 1)}🐢 slow`,
      ],
      ['a very long question', `${BASE_QUESTION} `.repeat(400)],
    ])('returns a well-formed result for %s', (_label, question) => {
      expectWellFormed(tokenizeQuestion(question));
    });

    it('NFKC-normalises compatibility forms before reading them', () => {
      expect(
        tokenizeQuestion('\uFF33\uFF2C\uFF2F\uFF37 \uFF32\uFF25\uFF2E\uFF24\uFF25\uFF32'),
      ).toEqual({
        tokens: ['render', 'slow'],
        identifierCandidates: [],
        signalTerms: ['render', 'slow'],
      });
    });
  });
});

// Why wording invariance is load-bearing: the deterministic provider is
// rules-based and builds its answer from `ModelRequest.input` alone, and the
// outbound guard inspects that same object field by field. The raw question
// may be rendered into the prompt, but anything phrasing-dependent in the
// structured input would make the product's behaviour depend on how a question
// was typed rather than on what it asked — the forbidden shortcut of AAP §0.5.4.
describe('wording invariance (AAP §0.5.4)', () => {
  it('the tokenizer projects wording-only variants onto one value', () => {
    const expected = stableStringify(tokenizeQuestion(BASE_QUESTION));
    for (const variant of WORDING_VARIANTS) {
      expect(stableStringify(tokenizeQuestion(variant))).toBe(expected);
    }
  });

  it('the tokenizer tells meaningfully different questions apart', () => {
    expect(stableStringify(tokenizeQuestion(DIFFERENT_QUESTION))).not.toBe(
      stableStringify(tokenizeQuestion(BASE_QUESTION)),
    );
  });

  it('sends byte-identical structured input to the provider for wording-only variants', async () => {
    const fixture = harness({ outcomes: WORDING_VARIANTS.map(() => answer(VALID_UNDERSTANDING)) });
    for (const question of WORDING_VARIANTS) {
      expectOk(await fixture.run(stageContext({ question }).context));
    }

    const calls = fixture.provider.structuredCalls;
    expect(calls).toHaveLength(WORDING_VARIANTS.length);
    const canonicalForms = calls.map((call) => stableStringify(call.request.input));
    const asSent = calls.map((call) => Buffer.from(JSON.stringify(call.request.input), 'utf8'));
    const [firstCanonical] = canonicalForms;
    const [firstSent] = asSent;
    for (const form of canonicalForms) {
      expect(form).toBe(firstCanonical);
    }
    for (const bytes of asSent) {
      expect(firstSent !== undefined && bytes.equals(firstSent)).toBe(true);
    }

    // Not vacuous: the builder saw four different questions, and the input
    // carries the question's content words rather than ignoring them.
    expect(new Set(fixture.builder.understandCalls.map((call) => call.context.question)).size).toBe(
      WORDING_VARIANTS.length,
    );
    expect(firstInput(fixture)['tokens']).toEqual(tokenizeQuestion(BASE_QUESTION).tokens);
    expect(firstInput(fixture)['identifierCandidates']).toEqual(['TimesheetSummaryCard']);
  });

  it('sends different structured input for questions that differ in meaning', async () => {
    const fixture = harness({
      outcomes: [answer(VALID_UNDERSTANDING), answer(VALID_UNDERSTANDING)],
    });
    expectOk(await fixture.run(stageContext({ question: BASE_QUESTION }).context));
    expectOk(await fixture.run(stageContext({ question: DIFFERENT_QUESTION }).context));

    const [base, different] = fixture.provider.structuredCalls;
    expect(stableStringify(base?.request.input)).not.toBe(
      stableStringify(different?.request.input),
    );
    expect(different?.request.input['signalTerms']).toEqual(
      tokenizeQuestion(DIFFERENT_QUESTION).signalTerms,
    );
  });

  it('hands the builder the tokenizer projection, never the question, and sends the built request unchanged', async () => {
    const fixture = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    const { context } = stageContext();
    expectOk(await fixture.run(context));

    const [call] = fixture.builder.understandCalls;
    expect(fixture.builder.understandCalls).toHaveLength(1);
    expect(call?.context).toBe(context);
    expect(call?.questionHints).toEqual(tokenizeQuestion(context.question));
    expect(JSON.stringify(call?.questionHints)).not.toContain(context.question);
    expect(call?.projectSummary).toBeUndefined();
    expect(call?.signal).toBeUndefined();
    expect(fixture.provider.structuredCalls[0]?.request).toBe(fixture.builder.built[0]?.request);
  });
});

describe('the model-output gate (AAP §0.5.3)', () => {
  it('accepts a schema-valid understanding after exactly one provider call', async () => {
    const fixture = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    const value = expectOk(await fixture.run(stageContext().context));

    expect(value.understanding).toEqual(VALID_UNDERSTANDING);
    expect(value.repairs).toBe(0);
    expect(Object.isFrozen(value)).toBe(true);
    expect(fixture.provider.calls).toHaveLength(1);
    expect(fixture.provider.structuredCalls[0]?.schema).toBe(problemUnderstandingSchema);
  });

  it('reports the repair an accepted answer needed', async () => {
    const fixture = harness({
      outcomes: [answer(INVALID_UNDERSTANDING), answer(VALID_UNDERSTANDING)],
    });
    const value = expectOk(await fixture.run(stageContext().context));

    expect(value.understanding).toEqual(VALID_UNDERSTANDING);
    expect(value.repairs).toBe(1);
    expect(fixture.provider.structuredCalls).toHaveLength(2);
  });

  it('stops after DEFAULT_MAX_REPAIRS repairs, never makes a further call, and returns no artifact', async () => {
    const fixture = harness({
      outcomes: Array.from({ length: DEFAULT_MAX_REPAIRS + 2 }, () =>
        answer(INVALID_UNDERSTANDING),
      ),
    });
    const result = await fixture.run(stageContext().context);

    expect('value' in result).toBe(false);
    const error = expectErr(result);
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(error.details?.['reason']).toBe('schema');
    expect(fixture.provider.structuredCalls).toHaveLength(DEFAULT_MAX_REPAIRS + 1);
    expect(fixture.provider.remaining).toBe(1);
  });

  it('applies no fallback: a valid answer queued behind the spent budget is never requested', async () => {
    const fixture = harness({
      outcomes: [
        ...Array.from({ length: DEFAULT_MAX_REPAIRS + 1 }, () => answer(INVALID_UNDERSTANDING)),
        answer(VALID_UNDERSTANDING),
      ],
    });
    const result = await fixture.run(stageContext().context);

    expect(result.ok).toBe(false);
    expect('value' in result).toBe(false);
    expect(fixture.provider.remaining).toBe(1);
    expect(fixture.builder.understandCalls).toHaveLength(1);
    expect(fixture.progress.methods).not.toContain('stageCompleted');
  });

  it.each(Array.from({ length: DEFAULT_MAX_REPAIRS + 1 }, (_, budget) => budget))(
    'honours a repair budget of %i',
    async (budget) => {
      const fixture = harness({
        maxRepairs: budget,
        outcomes: Array.from({ length: DEFAULT_MAX_REPAIRS + 2 }, () =>
          answer(INVALID_UNDERSTANDING),
        ),
      });
      expectErr(await fixture.run(stageContext().context));
      expect(fixture.provider.structuredCalls).toHaveLength(budget + 1);
    },
  );

  it.each([-1, DEFAULT_MAX_REPAIRS + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a repair budget of %s before building, calling or reporting anything',
    async (budget) => {
      const fixture = harness({ maxRepairs: budget, outcomes: [answer(VALID_UNDERSTANDING)] });
      const error = expectErr(await fixture.run(stageContext().context));

      expect(error.code).toBe('CONFIG_INVALID');
      expect(fixture.builder.understandCalls).toHaveLength(0);
      expect(fixture.provider.calls).toHaveLength(0);
      expect(fixture.progress.calls).toHaveLength(0);
      expect(
        fixture.log.records.some(
          (record) => record.level === 'error' && record.fields['reason'] === 'repair-budget',
        ),
      ).toBe(true);
    },
  );

  it('short-circuits a provider failure after one call, relaying its code, message and hint', async () => {
    const failure = unavailableError();
    const fixture = harness({
      outcomes: [providerFailure(failure), answer(VALID_UNDERSTANDING)],
    });
    const error = expectErr(await fixture.run(stageContext().context));

    expect(error.code).toBe(failure.code);
    expect(error.message).toBe(failure.message);
    expect(error.hint).toBe(failure.hint);
    expect(fixture.provider.structuredCalls).toHaveLength(1);
    expect(fixture.provider.remaining).toBe(1);
  });

  it('rejects an empty answer after one call', async () => {
    const fixture = harness({ outcomes: [answer(undefined), answer(VALID_UNDERSTANDING)] });
    const error = expectErr(await fixture.run(stageContext().context));

    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(error.details?.['reason']).toBe('empty');
    expect(fixture.provider.structuredCalls).toHaveLength(1);
  });

  it('resolves to an Err, never a rejection, when the provider throws', async () => {
    const fixture = harness({
      outcomes: [{ kind: 'throw', thrown: new Error('scripted transport crash') }],
    });
    const error = expectErr(await fixture.run(stageContext().context));

    expect(error.code).toBe('INTERNAL');
    expect(fixture.provider.structuredCalls).toHaveLength(1);
  });

  it('returns an Err with zero provider calls when the signal is aborted before the run', async () => {
    const fixture = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    const probe = stageContext({ signal: AbortSignal.abort() });
    const error = expectErr(await fixture.run(probe.context));

    expect(error.code).toBe('INTERNAL');
    expect(error.details?.['reason']).toBe('aborted');
    expect(error.details?.['stage']).toBe(UNDERSTAND);
    expect(fixture.provider.calls).toHaveLength(0);
    expect(fixture.builder.understandCalls).toHaveLength(0);
    expect(fixture.progress.calls).toHaveLength(0);
    expect(probe.now).not.toHaveBeenCalled();
  });

  it('stops before the provider when the signal aborts after the request is built', async () => {
    const controller = new AbortController();
    const fixture = harness({
      mode: { kind: 'mirror', onBuild: () => controller.abort() },
      outcomes: [answer(VALID_UNDERSTANDING)],
    });
    const result = await fixture.run(stageContext({ signal: controller.signal }).context);

    expectErr(result);
    expect(fixture.provider.calls).toHaveLength(0);
    expect(fixture.progress.methods).toEqual(['stageStarted', 'stageFailed']);
  });

  it('returns a builder refusal unchanged and never calls the provider', async () => {
    const refusal = new DebuggenError('INTERNAL', 'The test builder refused the request.', {
      hint: 'Redact the offending field, then rebuild the request.',
      details: { stage: UNDERSTAND, reason: 'outbound-guard' },
    });
    const fixture = harness({
      mode: { kind: 'fail', error: refusal },
      outcomes: [answer(VALID_UNDERSTANDING)],
    });
    const error = expectErr(await fixture.run(stageContext().context));

    expect(error).toBe(refusal);
    expect(fixture.provider.calls).toHaveLength(0);
  });

  it('stops at the outbound guard when the question still carries a credential', async () => {
    const fixture = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    const question = `Why does ${ASSEMBLED_BEARER} make the TimesheetSummaryCard slow?`;
    expectErr(await fixture.run(stageContext({ question }).context));

    expect(fixture.builder.understandCalls).toHaveLength(1);
    expect(fixture.builder.built).toHaveLength(0);
    expect(fixture.provider.calls).toHaveLength(0);
  });

  it('resolves to an Err and never calls the provider when the builder throws', async () => {
    const fixture = harness({
      mode: { kind: 'throw', thrown: new Error('scripted builder defect') },
      outcomes: [answer(VALID_UNDERSTANDING)],
    });
    const error = expectErr(await fixture.run(stageContext().context));

    expect(error.code).toBe('INTERNAL');
    expect(fixture.provider.calls).toHaveLength(0);
  });

  it('understands a question asked with no selected element, from the page address alone', async () => {
    const fixture = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    const probe = stageContext({ withoutTarget: true });
    expect(probe.context.target).toBeUndefined();

    const value = expectOk(await fixture.run(probe.context));
    expect(value.understanding).toEqual(VALID_UNDERSTANDING);
    expect(firstInput(fixture)['target']).toBeUndefined();
    expect(firstInput(fixture)['currentUrl']).toBe(CURRENT_URL);
    expect(fixture.builder.understandCalls[0]?.questionHints).toEqual(
      tokenizeQuestion(BASE_QUESTION),
    );
  });

  it('reports the prompt version the builder loaded', async () => {
    const byDefault = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    const loaded = expectOk(await byDefault.run(stageContext().context));
    expect(loaded.promptVersion).toBe(BUILDER_DEFAULT_VERSION);
    expect(byDefault.builder.understandCalls[0]?.promptVersion).toBeUndefined();

    const explicit = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    const pinned = expectOk(await explicit.run(stageContext().context, { promptVersion: 'v002' }));
    expect(explicit.builder.understandCalls[0]?.promptVersion).toBe('v002');
    expect(pinned.promptVersion).toBe('v002');

    const recorded = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    const reused = expectOk(
      await recorded.run(stageContext({ promptVersions: { [UNDERSTAND]: 'v003' } }).context),
    );
    expect(recorded.builder.understandCalls[0]?.promptVersion).toBeUndefined();
    expect(reused.promptVersion).toBe('v003');

    for (const version of [loaded, pinned, reused].map((value) => value.promptVersion)) {
      expect(PROMPT_VERSION_PATTERN.test(version)).toBe(true);
    }
  });

  it('asks only for structured output: no free text, no tool calls, no other stage request', async () => {
    const fixture = harness({
      outcomes: [answer(VALID_UNDERSTANDING), providerFailure(unavailableError())],
    });
    expectOk(await fixture.run(stageContext().context));
    expectErr(await fixture.run(stageContext().context));

    expect(fixture.provider.calls.map((call) => call.method)).toEqual([
      'generateStructured',
      'generateStructured',
    ]);
    expect(fixture.builder.otherCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Failure paths, shared by the progress and privacy suites
// ---------------------------------------------------------------------------

/** One way a run can fail, with fresh collaborators built for every test that walks it. */
interface FailureScenario {
  readonly label: string;
  /** Whether the stage gets as far as opening its progress group. */
  readonly opensProgress: boolean;
  readonly setup: () => {
    readonly options: HarnessOptions;
    readonly context?: ContextOptions | undefined;
  };
}

const FAILURE_SCENARIOS: readonly FailureScenario[] = [
  {
    label: 'a schema rejection after the spent repair budget',
    opensProgress: true,
    setup: () => ({
      options: {
        outcomes: Array.from({ length: DEFAULT_MAX_REPAIRS + 1 }, () =>
          answer(INVALID_UNDERSTANDING_WITH_SENTINEL),
        ),
      },
    }),
  },
  {
    label: 'an empty answer',
    opensProgress: true,
    setup: () => ({ options: { outcomes: [answer(undefined)] } }),
  },
  {
    label: 'a provider failure',
    opensProgress: true,
    setup: () => ({ options: { outcomes: [providerFailure(unavailableError())] } }),
  },
  {
    label: 'a provider that throws',
    opensProgress: true,
    setup: () => ({
      options: { outcomes: [{ kind: 'throw', thrown: new Error('scripted transport crash') }] },
    }),
  },
  {
    label: 'a builder refusal',
    opensProgress: true,
    setup: () => ({
      options: {
        mode: {
          kind: 'fail',
          error: new DebuggenError('INTERNAL', 'The test builder refused the request.'),
        },
      },
    }),
  },
  {
    label: 'a builder that throws',
    opensProgress: true,
    setup: () => ({
      options: { mode: { kind: 'throw', thrown: new Error('scripted builder defect') } },
    }),
  },
  {
    label: 'an outbound-guard refusal',
    opensProgress: true,
    setup: () => ({
      options: { outcomes: [answer(VALID_UNDERSTANDING)] },
      context: { question: `${SENTINEL_QUESTION} ${ASSEMBLED_BEARER}` },
    }),
  },
  {
    label: 'a signal aborted after the build',
    opensProgress: true,
    setup: () => {
      const controller = new AbortController();
      return {
        options: {
          mode: { kind: 'mirror', onBuild: () => controller.abort() },
          outcomes: [answer(VALID_UNDERSTANDING)],
        },
        context: { signal: controller.signal },
      };
    },
  },
  {
    label: 'a signal aborted before the run',
    opensProgress: false,
    setup: () => ({
      options: { outcomes: [answer(VALID_UNDERSTANDING)] },
      context: { signal: AbortSignal.abort() },
    }),
  },
  {
    label: 'an invalid repair budget',
    opensProgress: false,
    setup: () => ({
      options: { maxRepairs: DEFAULT_MAX_REPAIRS + 1, outcomes: [answer(VALID_UNDERSTANDING)] },
    }),
  },
];

/** Runs one failure path against the question planted with {@link SENTINEL}. */
async function runScenario(scenario: FailureScenario): Promise<{
  readonly fixture: Harness;
  readonly probe: ContextFixture;
  readonly error: DebuggenError;
}> {
  const { options, context } = scenario.setup();
  const fixture = harness(options);
  const probe = stageContext({ question: SENTINEL_QUESTION, ...context });
  const error = expectErr(await fixture.run(probe.context));
  return { fixture, probe, error };
}

/** The only progress methods a stage may call: its group header and one closing row. */
const STAGE_ROW_METHODS: ReadonlySet<string> = new Set([
  'stageStarted',
  'stageCompleted',
  'stageFailed',
]);

describe('progress and boundaries', () => {
  it('opens and closes its group under the understand stage on success, passing no display text', async () => {
    const fixture = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    expectOk(await fixture.run(stageContext().context));

    // No `message` key on either call: the titles come from `sessions/progress.ts`.
    expect(fixture.progress.calls).toStrictEqual([
      { method: 'stageStarted', sessionId: SESSION_ID, stage: UNDERSTAND },
      { method: 'stageCompleted', sessionId: SESSION_ID, stage: UNDERSTAND },
    ]);
  });

  it("relays the failing subsystem's own error into the failed row rather than composing one", async () => {
    const withHint = new DebuggenError('INTERNAL', 'The test builder refused the request.', {
      hint: 'Redact the offending field, then rebuild the request.',
    });
    const hinted = harness({ mode: { kind: 'fail', error: withHint } });
    expectErr(await hinted.run(stageContext().context));
    expect(hinted.progress.calls).toStrictEqual([
      { method: 'stageStarted', sessionId: SESSION_ID, stage: UNDERSTAND },
      {
        method: 'stageFailed',
        sessionId: SESSION_ID,
        stage: UNDERSTAND,
        failure: {
          stage: UNDERSTAND,
          code: withHint.code,
          message: withHint.message,
          hint: 'Redact the offending field, then rebuild the request.',
        },
      },
    ]);

    const withoutHint = new DebuggenError('INTERNAL', 'The test builder could not build.');
    const bare = harness({ mode: { kind: 'fail', error: withoutHint } });
    expectErr(await bare.run(stageContext().context));
    expect(bare.progress.calls[1]?.failure).toStrictEqual({
      stage: UNDERSTAND,
      code: withoutHint.code,
      message: withoutHint.message,
    });
  });

  it.each(FAILURE_SCENARIOS.filter((scenario) => scenario.opensProgress))(
    'pairs stageStarted with exactly one stageFailed on $label',
    async (scenario) => {
      const { fixture, error } = await runScenario(scenario);

      expect(fixture.progress.methods).toEqual(['stageStarted', 'stageFailed']);
      const failure = fixture.progress.calls[1]?.failure;
      expect(failure?.stage).toBe(UNDERSTAND);
      expect(failure?.code).toBe(error.code);
      expect(failure?.message).toBe(error.message);
    },
  );

  it.each(FAILURE_SCENARIOS.filter((scenario) => !scenario.opensProgress))(
    'reports no progress for $label, a run it refuses to start',
    async (scenario) => {
      const { fixture } = await runScenario(scenario);
      expect(fixture.progress.calls).toEqual([]);
      expect(fixture.builder.understandCalls).toEqual([]);
      expect(fixture.provider.calls).toEqual([]);
    },
  );

  it('emits no finding rows and no row for any other stage', async () => {
    const success = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    expectOk(await success.run(stageContext().context));
    const failures = await Promise.all(FAILURE_SCENARIOS.map(runScenario));

    for (const progress of [success.progress, ...failures.map(({ fixture }) => fixture.progress)]) {
      for (const call of progress.calls) {
        expect(STAGE_ROW_METHODS.has(call.method)).toBe(true);
        expect(call.stage).toBe(UNDERSTAND);
        expect(call.sessionId).toBe(SESSION_ID);
      }
    }
  });

  it.each<ProgressBehaviour>(['err', 'throw'])(
    'still succeeds when every progress row fails to emit (%s)',
    async (behaviour) => {
      const fixture = harness({ progress: behaviour, outcomes: [answer(VALID_UNDERSTANDING)] });
      const value = expectOk(await fixture.run(stageContext().context));

      expect(value.understanding).toEqual(VALID_UNDERSTANDING);
      const warnings = fixture.log.records.filter(
        (record) => record.level === 'warn' && record.fields['row'] !== undefined,
      );
      expect(warnings.map((record) => record.fields['row'])).toEqual(['started', 'completed']);
      for (const warning of warnings) {
        expect(warning.fields['code']).toBe(
          behaviour === 'err' ? PROGRESS_FAILURE_CODE : 'INTERNAL',
        );
      }
    },
  );

  it('returns the original failure when its failed row cannot be emitted either', async () => {
    const refusal = new DebuggenError('INTERNAL', 'The test builder refused the request.');
    const fixture = harness({ progress: 'err', mode: { kind: 'fail', error: refusal } });
    const error = expectErr(await fixture.run(stageContext().context));

    expect(error).toBe(refusal);
    expect(
      fixture.log.records
        .filter((record) => record.fields['row'] !== undefined)
        .map((record) => record.fields['row']),
    ).toEqual(['started', 'failed']);
  });

  it('exposes run alone, writes no session status and never reads the code handles', async () => {
    const stage = createUnderstandStage({
      contextBuilder: new StubContextBuilder(),
      provider: new ScriptedProvider(),
      progress: new RecordingProgress(),
    });
    expect(Object.keys(stage)).toEqual(['run']);
    expect(Object.isFrozen(stage)).toBe(true);

    const success = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    const succeeded = stageContext();
    expectOk(await success.run(succeeded.context));
    const opening = FAILURE_SCENARIOS.find((scenario) => scenario.opensProgress);
    if (opening === undefined) {
      throw new Error('No failure scenario opens the progress group.');
    }
    const failed = await runScenario(opening);

    for (const probe of [succeeded, failed.probe]) {
      expect(Object.isFrozen(probe.session)).toBe(true);
      expect(probe.context.session).toBe(probe.session);
      expect(stableStringify(probe.context.session)).toBe(probe.sessionSnapshot);
      expect(probe.codeReads).toEqual([]);
    }
    // The doubles offer no status-writing method, and nothing but progress rows was reported.
    for (const progress of [success.progress, failed.fixture.progress]) {
      expect(progress.methods.every((method) => STAGE_ROW_METHODS.has(method))).toBe(true);
    }
  });

  it('times the run with the injected clock alone', async () => {
    const fixture = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    const probe = stageContext();
    expectOk(await fixture.run(probe.context));

    const completed = fixture.log.records.find(
      (record) => typeof record.fields['durationMs'] === 'number',
    );
    expect(completed?.fields['durationMs']).toBe(CLOCK_STEP_MS);
    expect(probe.now).toHaveBeenCalled();
  });

  it('logs through the injected logger, bound to the session, the pipeline subsystem and this stage', async () => {
    const fixture = harness({
      outcomes: [answer(INVALID_UNDERSTANDING), answer(VALID_UNDERSTANDING)],
    });
    const probe = stageContext();
    expectOk(await fixture.run(probe.context));

    expect(fixture.log.records.length).toBeGreaterThan(0);
    for (const record of fixture.log.records) {
      expect(record.fields['sessionId']).toBe(SESSION_ID);
      expect(record.fields['subsystem']).toBe('pipeline');
      expect(record.fields['stage']).toBe(UNDERSTAND);
    }
    expect(probe.contextLog.records).toEqual([]);
  });

  it("logs through the context's own logger when none is injected", async () => {
    const fixture = harness({ withoutLogger: true, outcomes: [answer(VALID_UNDERSTANDING)] });
    const probe = stageContext();
    expectOk(await fixture.run(probe.context));

    expect(fixture.log.records).toEqual([]);
    expect(probe.contextLog.records.length).toBeGreaterThan(0);
    for (const record of probe.contextLog.records) {
      expect(record.fields['subsystem']).toBe('pipeline');
      expect(record.fields['stage']).toBe(UNDERSTAND);
    }
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

/** Content planted in a run that must never reach a log record or an error. */
const PLANTED: readonly string[] = [
  SENTINEL,
  SENTINEL_QUESTION,
  PROMPT_MARKER,
  CURRENT_URL,
  TARGET.selector,
];

/** The field names a log record of this stage (or of the gate it calls) may carry. */
const ALLOWED_LOG_FIELDS: ReadonlySet<string> = new Set([
  // Bindings.
  'subsystem',
  'sessionId',
  'captureId',
  'stage',
  // Counts, sizes and timing.
  'tokenCount',
  'identifierCandidateCount',
  'signalTermCount',
  'attempts',
  'repairs',
  'bytes',
  'truncatedSections',
  'signalCount',
  'entityCount',
  'searchHintCount',
  'issueCount',
  'durationMs',
  // Versions, statuses, codes and closed-vocabulary reasons.
  'promptVersion',
  'code',
  'reason',
  'row',
  'schemaName',
  'issuePaths',
]);

function expectNothingPlanted(text: string, planted: readonly string[] = PLANTED): void {
  for (const value of planted) {
    expect(text).not.toContain(value);
  }
}

describe('privacy (AAP §0.5.2)', () => {
  it('keeps the question, prompt, model output, URL and selector out of every log record on success', async () => {
    const fixture = harness({
      outcomes: [
        answer(INVALID_UNDERSTANDING_WITH_SENTINEL),
        answer(VALID_UNDERSTANDING_WITH_SENTINEL),
      ],
    });
    const probe = stageContext({ question: SENTINEL_QUESTION });
    const value = expectOk(await fixture.run(probe.context));
    expect(value.understanding.searchHints).toEqual([SENTINEL]);

    const records = allRecords(fixture, probe);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expectNothingPlanted(serializeRecord(record));
    }
  });

  it.each(FAILURE_SCENARIOS)(
    'keeps planted content out of the logs and the error on $label',
    async (scenario) => {
      const { fixture, probe, error } = await runScenario(scenario);

      expectNothingPlanted(serializeError(error));
      for (const record of allRecords(fixture, probe)) {
        expectNothingPlanted(serializeRecord(record));
      }
    },
  );

  it('keeps an assembled credential out of the logs and out of the refusal', async () => {
    const fixture = harness({ outcomes: [answer(VALID_UNDERSTANDING)] });
    const probe = stageContext({
      question: `Why does ${ASSEMBLED_BEARER} make the TimesheetSummaryCard slow?`,
    });
    const error = expectErr(await fixture.run(probe.context));
    const credential = [
      ASSEMBLED_BEARER,
      ASSEMBLED_BEARER.slice(ASSEMBLED_BEARER.indexOf(' ') + 1),
    ];

    expectNothingPlanted(serializeError(error), credential);
    for (const record of allRecords(fixture, probe)) {
      expectNothingPlanted(serializeRecord(record), credential);
    }
  });

  it('limits log fields to stages, statuses, counts, versions and error codes', async () => {
    const success = harness({
      outcomes: [answer(INVALID_UNDERSTANDING), answer(VALID_UNDERSTANDING)],
    });
    const succeeded = stageContext();
    expectOk(await success.run(succeeded.context));
    const records = [...allRecords(success, succeeded)];
    for (const scenario of FAILURE_SCENARIOS) {
      const { fixture, probe } = await runScenario(scenario);
      records.push(...allRecords(fixture, probe));
    }

    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      for (const [key, value] of Object.entries(record.fields)) {
        expect(ALLOWED_LOG_FIELDS.has(key)).toBe(true);
        const isScalar = typeof value === 'string' || typeof value === 'number';
        let isStringList = false;
        if (Array.isArray(value)) {
          const list: readonly unknown[] = value;
          isStringList = list.every((entry) => typeof entry === 'string');
        }
        expect(isScalar || isStringList).toBe(true);
      }
    }
  });
});
