/**
 * Colocated suite for the structured-output validator — the witness for this
 * product's central safety claim.
 *
 * `./structured.ts` is the only path by which a model's answer becomes product
 * data, and the **order** of its steps is what the product guarantees rather
 * than merely their presence (AAP §0.5.3). This suite pins that order, and one
 * sentence states why it exists at all:
 *
 * > input-schema failure → repair, bounded at two; normaliser failure →
 * > rejection **without** repair.
 *
 * Everything below supports those two clauses:
 *
 * 1. **The budget is counted, not described.** A scripted provider records
 *    every request it receives, so "at most two repairs" is asserted as a call
 *    count against {@link DEFAULT_MAX_REPAIRS} — never against the literal
 *    three — and the script throws if the loop asks for an attempt it was not
 *    scripted for, which is how "never a fourth call" is enforced without a
 *    fragile spy.
 * 2. **The asymmetry is asserted from both sides.** A schema failure earns a
 *    repair whose turn carries the failing field paths; a normaliser throw
 *    earns an immediate rejection, one error-level log record carrying the
 *    input, and *no second call*. A provider failure earns neither — it
 *    short-circuits without spending a repair, because a call that produced no
 *    output has nothing to correct.
 * 3. **The re-parse of the raw output is load-bearing.** One case scripts an
 *    attempt whose *pre-parsed* value violates a numeric bound and requires it
 *    to be rejected, because the real provider's schema helpers strip the
 *    JSON-Schema keywords the service-side format does not support (AAP
 *    §0.2.4). That case is what stops the re-parse from being "optimised away".
 * 4. **Nothing rejected is ever echoed.** A distinctive sentinel is planted in
 *    every position a rejected payload could travel from — a failing value, an
 *    undecoded response — and required to be absent from the repair turn, the
 *    rejection's message and details, and the log fields. This text is sent
 *    back to a provider and persisted with a session, so the property matters.
 *
 * ## Harness constraints this file works under
 *
 * - The Vitest project is `model-provider` in the **root** `vitest.config.ts`,
 *   node environment, `globals: false`. Every API is imported explicitly and no
 *   per-package Vitest configuration exists.
 * - The compiler project is NodeNext, so the units under test are imported as
 *   `./structured.js`, `./types.js` and `./provider.js`, and this file is
 *   type-checked by `pnpm typecheck` because the package's tsconfig `include`
 *   covers `*.test.ts`. It is unreachable from `src/index.ts`, so tsup never
 *   bundles it, and no source module may import it.
 * - **No network, no SDK, no fixture files.** `@anthropic-ai/sdk` is not
 *   imported and no recorded model response is shipped (AAP §0.2.5): every
 *   attempt is built in code, beside the expectation it drives.
 * - Schemas are tiny and generic. No demo identifier and no route path appears
 *   in a schema, a fixture or an assertion string — `scripts/check-no-hardcoding.mjs`
 *   scans this tree, and a suite that leaked one would make the validator look
 *   like it knew what it was validating.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodType } from 'zod';

import { DebuggenError, createConsoleLogger, err, ok } from '@debuggen/shared';
import type { LogRecord, LogSink, Logger, Ok, Result } from '@debuggen/shared';

import type { ModelProvider } from './provider.js';
import {
  DEFAULT_ARTIFACT_LABEL,
  DEFAULT_MAX_ISSUES,
  EMPTY_ISSUE_MESSAGE,
  ISSUE_LINE_SEPARATOR,
  ISSUE_ROOT_MARKER,
  MAX_ISSUE_LINE_LENGTH,
  NON_JSON_ISSUE_MESSAGE,
  REPAIR_ASSISTANT_NOTICE,
  buildRepairRequest,
  formatZodIssues,
  generateStructuredWithRepair,
} from './structured.js';
import { DEFAULT_MAX_REPAIRS } from './types.js';
import type {
  JsonObject,
  ModelMessage,
  ModelRequest,
  ModelRequestMetadata,
  ModelTextResponse,
  PromptStage,
  StructuredAttempt,
  TokenUsage,
  ToolCallsResponse,
} from './types.js';

/*
 * ---------------------------------------------------------------------------
 * The artifact under validation
 *
 * Deliberately a shape with nothing to do with this product: a count and a
 * label. What matters about it is that it carries one constraint the JSON
 * Schema a provider is given can legally drop — the integer lower bound — which
 * is what the pre-parsed-value case turns on.
 * ---------------------------------------------------------------------------
 */

/** The authoring schema every case validates against. */
const reportSchema = z.object({
  count: z.number().int().min(1),
  label: z.string(),
});

/** The authoring type, inferred so the schema stays the single declaration. */
type ReportInput = z.infer<typeof reportSchema>;

/** An internal shape a normaliser can produce, distinct from the authoring one. */
interface NormalizedReport {
  readonly total: number;
  readonly slug: string;
}

/** The deterministic normaliser the transforming cases use. */
function normalizeReport(input: ReportInput): NormalizedReport {
  return { total: input.count * 2, slug: input.label.toUpperCase() };
}

/** An authoring value that satisfies {@link reportSchema}. */
const VALID_OUTPUT = { count: 3, label: 'first' } as const;

/** An authoring value that satisfies the *types* but breaks the lower bound. */
const BOUND_VIOLATING_OUTPUT = { count: 0, label: 'second' } as const;

/**
 * A distinctive marker planted where a rejected payload could travel from.
 *
 * Assembled from fragments rather than written as one literal, and kept short,
 * lower-case and hyphenated so it cannot read as credential material to
 * `scripts/check-secrets.mjs` — which scans this tracked file — while staying
 * unique enough that finding it anywhere in a message, a detail or a log field
 * is unambiguous evidence of a leak.
 */
const SENTINEL = ['zzq', 'unechoed', 'payload', 'marker'].join('-');

/*
 * ---------------------------------------------------------------------------
 * Log capture
 *
 * `createConsoleLogger` takes an injectable sink precisely so a test can read
 * structured fields; spying on the console would assert on formatting instead
 * of on what the loop actually recorded. The array is module-level and cleared
 * in `beforeEach`, which is what keeps one case's records out of the next one.
 * ---------------------------------------------------------------------------
 */

/** Records emitted during the case currently running. */
const logRecords: LogRecord[] = [];

/**
 * The sink behind {@link captureLogger}.
 *
 * Copies `fields` because it retains the record beyond the synchronous logging
 * call, which `LogRecord` requires of any sink that does.
 */
const captureSink: LogSink = (record) => {
  logRecords.push({ ...record, fields: { ...record.fields } });
};

/** A logger at the lowest threshold, so no record is dropped before assertion. */
const captureLogger: Logger = createConsoleLogger({
  level: 'trace',
  name: 'structured-test',
  sink: captureSink,
});

/** Records of one level, in emission order. */
function recordsAt(level: LogRecord['level']): readonly LogRecord[] {
  return logRecords.filter((record) => record.level === level);
}

/** The single record at `level`, or a failure naming what was found instead. */
function onlyRecordAt(level: LogRecord['level']): LogRecord {
  const matching = recordsAt(level);
  if (matching.length !== 1) {
    throw new Error(
      `expected exactly one ${level} record, found ${String(matching.length)}: ${matching
        .map((record) => record.message)
        .join(' | ')}`,
    );
  }
  const [record] = matching;
  if (record === undefined) {
    throw new Error(`expected one ${level} record, found none`);
  }
  return record;
}

beforeEach(() => {
  // Every case builds its own scripted provider, so the only state that could
  // survive a case is the captured log. Cleared rather than reassigned, so the
  // sink closed over above keeps writing to the array the assertions read.
  logRecords.length = 0;
});

/*
 * ---------------------------------------------------------------------------
 * The scripted provider
 *
 * It stands in for a real `ModelProvider` and must not be cleverer than one:
 * one attempt per call, no looping, no normalisation, no validation of its own.
 * It satisfies the interface structurally — there is no cast to `ModelProvider`
 * anywhere in this file, because a fake that needed one would prove nothing
 * about the interface a real provider implements.
 * ---------------------------------------------------------------------------
 */

/** The provider id every scripted attempt reports. */
const FAKE_PROVIDER_ID = 'scripted';

/** The model id every scripted attempt reports. */
const FAKE_MODEL = 'model-under-test';

/** The optional halves of a scripted attempt. */
interface AttemptParts {
  /**
   * The provider's own pre-parse of the answer, when it performed one.
   *
   * A hint on the interface, and the validator is required to ignore it.
   */
  readonly value?: unknown;

  /** The undecoded response text, for an answer that never became JSON. */
  readonly text?: string;

  /** Token accounting, when the provider reports it. */
  readonly usage?: TokenUsage;

  /** Why generation stopped, in the provider's own vocabulary. */
  readonly stopReason?: string;

  /**
   * A side effect applied when this step is served, before it answers.
   *
   * Models the world changing while a call was in flight — the one case being a
   * session that ends between two attempts. Not a way to make the fake decide
   * anything: it cannot change which step is served or what the step returns.
   */
  readonly whileInFlight?: () => void;
}

/** One scripted outcome: an attempt the provider produced, or a failed call. */
type FakeStep =
  | ({ readonly kind: 'attempt'; readonly raw: unknown } & AttemptParts)
  | {
      readonly kind: 'failure';
      readonly error: DebuggenError;
      readonly whileInFlight?: () => void;
    };

/** A step whose JSON output decoded to `raw`. */
function decoded(raw: unknown, parts: AttemptParts = {}): FakeStep {
  return { kind: 'attempt', raw, ...parts };
}

/** A step whose response never decoded as JSON: text, and no `raw`. */
function undecoded(text: string): FakeStep {
  return { kind: 'attempt', raw: undefined, text };
}

/** A step that answered with nothing at all: no `raw`, no text. */
function silent(): FakeStep {
  return { kind: 'attempt', raw: undefined };
}

/** A step where the call itself failed. */
function failure(error: DebuggenError, whileInFlight?: () => void): FakeStep {
  return whileInFlight === undefined
    ? { kind: 'failure', error }
    : { kind: 'failure', error, whileInFlight };
}

/** A {@link ModelProvider} that answers from a script and records its calls. */
interface FakeProvider extends ModelProvider {
  /** Every request received, in order. */
  readonly calls: readonly ModelRequest[];

  /** Every schema received, in order, so a repair can be shown to reuse it. */
  readonly schemas: readonly unknown[];
}

/**
 * Builds a provider that serves `script` in order.
 *
 * Asked for an attempt beyond the script, it throws rather than inventing one:
 * the loop is under a bound, and an unscripted call is the bound being
 * exceeded. The throw surfaces at the `await` inside the validator, which has
 * no `catch`, so the case fails loudly and names the attempt it was asked for.
 */
function createFakeProvider(script: readonly FakeStep[]): FakeProvider {
  const calls: ModelRequest[] = [];
  const schemas: unknown[] = [];

  const refuse = (member: string): never => {
    throw new Error(
      `${member} must not be called: the structured loop asks a provider for schema-shaped answers only.`,
    );
  };

  const generateStructured = <T>(
    schema: ZodType<T>,
    request: ModelRequest,
  ): Promise<Result<StructuredAttempt<T>, DebuggenError>> => {
    calls.push(request);
    schemas.push(schema);

    const step = script[calls.length - 1];
    if (step === undefined) {
      throw new Error(
        `the scripted provider was asked for attempt ${String(calls.length)} but the script holds ${String(
          script.length,
        )}: the repair budget was exceeded`,
      );
    }

    step.whileInFlight?.();

    if (step.kind === 'failure') {
      return Promise.resolve(err(step.error));
    }

    const attempt: StructuredAttempt<T> = {
      raw: step.raw,
      model: FAKE_MODEL,
      providerId: FAKE_PROVIDER_ID,
      // The one assertion in this file, and it is the substitution a real
      // provider's transport performs implicitly: `value` is typed as the
      // caller's authoring type, and a script cannot know that type. It is a
      // hint the validator must ignore, so its static type is irrelevant to
      // every assertion made about it.
      ...(step.value !== undefined ? { value: step.value as T } : {}),
      ...(step.text !== undefined ? { text: step.text } : {}),
      ...(step.usage !== undefined ? { usage: step.usage } : {}),
      ...(step.stopReason !== undefined ? { stopReason: step.stopReason } : {}),
    };

    return Promise.resolve(ok(attempt));
  };

  return {
    id: FAKE_PROVIDER_ID,
    generateText: (): Promise<Result<ModelTextResponse, DebuggenError>> => refuse('generateText'),
    generateStructured,
    callTools: (): Promise<Result<ToolCallsResponse, DebuggenError>> => refuse('callTools'),
    calls,
    schemas,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Requests
 * ---------------------------------------------------------------------------
 */

/** The stage every request belongs to unless a case varies it. */
const DEFAULT_STAGE: PromptStage = 'analyze';

/** The prompt version every request cites unless a case varies it. */
const DEFAULT_PROMPT_VERSION = 'v001';

/** The session every request belongs to unless a case drops it. */
const DEFAULT_SESSION_ID = 'ses_0000000001';

/** Rendered prose: English, generic, and about nothing in particular. */
const DEFAULT_PROMPT =
  'Summarise the captured evidence and reply with a single value that satisfies the schema.';

/** The structured half of the payload a request carries. */
const DEFAULT_INPUT: JsonObject = { itemCount: 2, window: 'recent' };

/** A prior exchange, so an appended repair turn can be shown not to erase one. */
const PRIOR_TURNS: readonly ModelMessage[] = [
  { role: 'user', content: 'Here is the evidence to summarise.' },
  { role: 'assistant', content: 'Understood.' },
];

/** The halves of a request a case may want to vary. */
interface RequestParts {
  readonly system?: string;
  readonly prompt?: string;
  readonly messages?: readonly ModelMessage[];
  readonly input?: JsonObject;
  readonly signal?: AbortSignal;
  readonly stage?: PromptStage;
  readonly sessionId?: string | null;
}

/** {@link ModelRequest} with its `readonly` modifiers removed, for assembly. */
type MutableRequest = { -readonly [K in keyof ModelRequest]: ModelRequest[K] };

/**
 * A request with the required fields filled in plausibly.
 *
 * Assembled field by field rather than by spreading a `Partial`, because this
 * package compiles with `exactOptionalPropertyTypes`: an omitted optional field
 * must be *absent* rather than present and `undefined`, which is also what the
 * validator is entitled to assume when it reads one. `sessionId: null` is how a
 * case asks for a request with no session at all.
 */
function makeRequest(parts: RequestParts = {}): ModelRequest {
  const metadata: MutableRequest['metadata'] = ((): ModelRequestMetadata => {
    const base: ModelRequestMetadata = {
      stage: parts.stage ?? DEFAULT_STAGE,
      promptVersion: DEFAULT_PROMPT_VERSION,
    };
    if (parts.sessionId === null) {
      return base;
    }
    return { ...base, sessionId: parts.sessionId ?? DEFAULT_SESSION_ID };
  })();

  const request: MutableRequest = {
    prompt: parts.prompt ?? DEFAULT_PROMPT,
    input: parts.input ?? DEFAULT_INPUT,
    metadata,
  };

  if (parts.system !== undefined) {
    request.system = parts.system;
  }
  if (parts.messages !== undefined) {
    request.messages = parts.messages;
  }
  if (parts.signal !== undefined) {
    request.signal = parts.signal;
  }

  return request;
}

/**
 * Everything about a request that a repair must carry across untouched,
 * serialised so a single comparison covers the whole payload.
 *
 * `signal` is excluded because an `AbortSignal` does not serialise; the cases
 * that care about it compare it by identity instead.
 */
function payloadSnapshot(request: ModelRequest): string {
  return JSON.stringify({
    system: request.system ?? null,
    prompt: request.prompt,
    messages: request.messages ?? null,
    input: request.input,
    metadata: request.metadata,
    maxTokens: request.maxTokens ?? null,
    temperature: request.temperature ?? null,
  });
}

/*
 * ---------------------------------------------------------------------------
 * Assertion helpers
 *
 * Narrowing helpers rather than `expect(result.ok).toBe(true)` followed by a
 * non-null assertion: `pnpm typecheck` covers this file, so a helper that
 * narrows is also a compile-time check that the case is reading the branch it
 * thinks it is.
 * ---------------------------------------------------------------------------
 */

/** Narrows a result to its `Ok` branch, failing with the error otherwise. */
function expectOk<T>(result: Result<T, DebuggenError>): asserts result is Ok<T> {
  if (!result.ok) {
    throw new Error(
      `expected a validated value, received a rejection: ${result.error.code} ${result.error.message}`,
    );
  }
}

/** Returns the rejection of a result, failing if it succeeded. */
function expectErr<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error(`expected a rejection, received a validated value: ${JSON.stringify(result)}`);
  }
  return result.error;
}

/** The diagnostic details of a rejection, as a plain record. */
function detailsOf(error: DebuggenError): Record<string, unknown> {
  const { details } = error;
  if (details === undefined) {
    throw new Error(`the rejection carried no details: ${error.code} ${error.message}`);
  }
  return { ...details };
}

/** The request the provider received for attempt `index` (zero-based). */
function callAt(provider: FakeProvider, index: number): ModelRequest {
  const request = provider.calls[index];
  if (request === undefined) {
    throw new Error(
      `the scripted provider received ${String(provider.calls.length)} calls, so there is none at index ${String(index)}`,
    );
  }
  return request;
}

/** The turns a request carries, as an array a case can index safely. */
function turnsOf(request: ModelRequest): readonly ModelMessage[] {
  return request.messages ?? [];
}

/** The message at `index` of a request's turns. */
function turnAt(request: ModelRequest, index: number): ModelMessage {
  const turn = turnsOf(request)[index];
  if (turn === undefined) {
    throw new Error(
      `the request carries ${String(turnsOf(request).length)} turns, so there is none at index ${String(index)}`,
    );
  }
  return turn;
}

/** The content of the last turn of a request. */
function lastTurnContent(request: ModelRequest): string {
  return turnAt(request, turnsOf(request).length - 1).content;
}

/** The formatted issues a value produces against {@link reportSchema}. */
function issuesFor(raw: unknown): string {
  const parsed = reportSchema.safeParse(raw);
  if (parsed.success) {
    throw new Error(`the fixture was expected to fail validation: ${JSON.stringify(raw)}`);
  }
  return formatZodIssues(parsed.error);
}

/** Everything a rejection could carry, serialised for a leak check. */
function rejectionText(error: DebuggenError): string {
  return `${error.message} ${error.hint ?? ''} ${JSON.stringify(detailsOf(error))}`;
}

/** Every captured log record, serialised for a leak check. */
function logText(): string {
  return logRecords
    .map((record) => `${record.message} ${JSON.stringify(record.fields)}`)
    .join(ISSUE_LINE_SEPARATOR);
}

/*
 * ---------------------------------------------------------------------------
 * Step 1 and 3: one attempt, then the authoritative parse
 * ---------------------------------------------------------------------------
 */

describe('an answer that validates on the first attempt', () => {
  it('returns the parsed value after exactly one provider call', async () => {
    const provider = createFakeProvider([decoded(VALID_OUTPUT)]);
    const request = makeRequest();

    const result = await generateStructuredWithRepair(provider, reportSchema, request);

    expectOk(result);
    expect(provider.calls).toHaveLength(1);
    expect(result.value.attempts).toBe(1);
    expect(result.value.repairs).toBe(0);
    expect(result.value.value).toEqual(VALID_OUTPUT);
    expect(result.value.parsed).toEqual(VALID_OUTPUT);
    // Without a normaliser the authoring shape *is* the internal shape, so the
    // two are one value rather than two copies of one.
    expect(result.value.value).toBe(result.value.parsed);
    expect(logRecords).toHaveLength(0);
  });

  it('hands the provider the caller’s own request and schema, unaltered', async () => {
    const provider = createFakeProvider([decoded(VALID_OUTPUT)]);
    const request = makeRequest({ system: 'Answer with one JSON value.', messages: PRIOR_TURNS });
    const before = payloadSnapshot(request);

    const result = await generateStructuredWithRepair(provider, reportSchema, request);

    expectOk(result);
    expect(callAt(provider, 0)).toBe(request);
    expect(provider.schemas[0]).toBe(reportSchema);
    expect(payloadSnapshot(request)).toBe(before);
  });

  it('reports the answering provider, model and token accounting', async () => {
    const usage: TokenUsage = { inputTokens: 120, outputTokens: 40, totalTokens: 160 };
    const provider = createFakeProvider([decoded(VALID_OUTPUT, { usage, stopReason: 'end_turn' })]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest());

    expectOk(result);
    expect(result.value.providerId).toBe(FAKE_PROVIDER_ID);
    expect(result.value.model).toBe(FAKE_MODEL);
    expect(result.value.usage).toEqual(usage);
  });

  it('leaves usage absent — not present and undefined — when none was reported', async () => {
    const provider = createFakeProvider([decoded(VALID_OUTPUT)]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest());

    expectOk(result);
    // `exactOptionalPropertyTypes` makes the distinction observable, and a
    // consumer must be able to tell "nothing was reported" from "zero".
    expect('usage' in result.value).toBe(false);
  });

  it('re-parses the raw output and ignores the provider’s pre-parsed hint', async () => {
    // `StructuredAttempt.value` is a hint the provider may set when its own
    // transport parsed the answer. A hint that disagreed with the raw output
    // must not reach the caller: the raw output is what was actually said.
    const provider = createFakeProvider([
      decoded(VALID_OUTPUT, { value: { count: 999, label: 'from-the-hint' } }),
    ]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest());

    expectOk(result);
    expect(result.value.parsed).toEqual(VALID_OUTPUT);
    expect(result.value.value).toEqual(VALID_OUTPUT);
  });

  it('rejects a pre-parsed hint that violates a numeric bound', async () => {
    // The reason this case exists, and why the re-parse in `classifyAttempt`
    // must never be "optimised away": the real provider's structured-output
    // helpers strip the JSON-Schema keywords the service-side format does not
    // support (AAP §0.2.4), so `min(1)` can survive the provider's own parse
    // unchecked. Here the hint and the raw output agree and both break the
    // bound; only the re-parse of `raw` can catch it.
    const provider = createFakeProvider([
      decoded(BOUND_VIOLATING_OUTPUT, { value: BOUND_VIOLATING_OUTPUT }),
    ]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      maxRepairs: 0,
    });

    const error = expectErr(result);
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(detailsOf(error).reason).toBe('schema');
    expect(detailsOf(error).issueSummary).toBe(issuesFor(BOUND_VIOLATING_OUTPUT));
  });
});

/*
 * ---------------------------------------------------------------------------
 * Steps 4 and 5: a schema failure earns a bounded repair
 * ---------------------------------------------------------------------------
 */

describe('a schema failure earns a bounded repair', () => {
  it('repairs once and succeeds, spending exactly one repair', async () => {
    const provider = createFakeProvider([decoded(BOUND_VIOLATING_OUTPUT), decoded(VALID_OUTPUT)]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest());

    expectOk(result);
    expect(provider.calls).toHaveLength(2);
    expect(result.value.attempts).toBe(2);
    expect(result.value.repairs).toBe(1);
    expect(result.value.parsed).toEqual(VALID_OUTPUT);
  });

  it('feeds the failing field paths back as a user turn', async () => {
    const provider = createFakeProvider([decoded(BOUND_VIOLATING_OUTPUT), decoded(VALID_OUTPUT)]);
    const controller = new AbortController();
    const request = makeRequest({
      system: 'Answer with one JSON value.',
      messages: PRIOR_TURNS,
      signal: controller.signal,
    });

    const result = await generateStructuredWithRepair(provider, reportSchema, request);

    expectOk(result);
    const repair = callAt(provider, 1);

    // Everything except `messages` arrives exactly as the caller wrote it,
    // including the two values a repair could plausibly lose: the structured
    // half of the payload, which the rules-based provider answers from, and the
    // signal that cancels the work.
    expect(repair.system).toBe(request.system);
    expect(repair.prompt).toBe(request.prompt);
    expect(repair.input).toBe(request.input);
    expect(repair.metadata).toBe(request.metadata);
    expect(repair.signal).toBe(controller.signal);

    // The prior exchange survives, and the correction arrives as an
    // assistant/user pair so the conversation still alternates.
    expect(turnsOf(repair)).toHaveLength(PRIOR_TURNS.length + 2);
    expect(turnsOf(repair).slice(0, PRIOR_TURNS.length)).toEqual(PRIOR_TURNS);
    expect(turnAt(repair, PRIOR_TURNS.length)).toEqual({
      role: 'assistant',
      content: REPAIR_ASSISTANT_NOTICE,
    });
    expect(turnAt(repair, PRIOR_TURNS.length + 1).role).toBe('user');
    expect(lastTurnContent(repair)).toContain(issuesFor(BOUND_VIOLATING_OUTPUT));
    expect(lastTurnContent(repair)).toContain('count');
    expect(lastTurnContent(repair)).toContain('Attempt 1');
    expect(provider.schemas[1]).toBe(reportSchema);
  });

  it('leaves the caller’s request unmutated', async () => {
    const provider = createFakeProvider([decoded(BOUND_VIOLATING_OUTPUT), decoded(VALID_OUTPUT)]);
    const request = makeRequest({ system: 'Answer with one JSON value.', messages: PRIOR_TURNS });
    const before = payloadSnapshot(request);
    const turnsBefore = turnsOf(request);

    const result = await generateStructuredWithRepair(provider, reportSchema, request);

    expectOk(result);
    // The caller may still hold, log or reuse the request it passed in.
    expect(payloadSnapshot(request)).toBe(before);
    expect(request.messages).toBe(turnsBefore);
    expect(turnsOf(request)).toHaveLength(PRIOR_TURNS.length);
  });

  it('derives every repair from the caller’s request, so the payload never grows', async () => {
    const provider = createFakeProvider([
      decoded(BOUND_VIOLATING_OUTPUT),
      decoded({ count: 2 }),
      decoded(VALID_OUTPUT),
    ]);
    const request = makeRequest({ messages: PRIOR_TURNS });

    const result = await generateStructuredWithRepair(provider, reportSchema, request);

    expectOk(result);
    expect(result.value.repairs).toBe(2);
    // Each repair is one correction pair on top of the original turns — never a
    // correction on top of the previous correction — so a third attempt carries
    // no more than a second, and the model is never shown a stale issue list.
    expect(turnsOf(callAt(provider, 1))).toHaveLength(PRIOR_TURNS.length + 2);
    expect(turnsOf(callAt(provider, 2))).toHaveLength(PRIOR_TURNS.length + 2);
    expect(lastTurnContent(callAt(provider, 1))).toContain('Attempt 1');
    expect(lastTurnContent(callAt(provider, 2))).toContain('Attempt 2');
    // The second attempt failed differently from the first, and the feedback
    // followed the failure rather than repeating the first one.
    expect(lastTurnContent(callAt(provider, 2))).toContain(issuesFor({ count: 2 }));
  });

  it('stops after one attempt plus DEFAULT_MAX_REPAIRS repairs', async () => {
    const attempts = DEFAULT_MAX_REPAIRS + 1;
    const provider = createFakeProvider(
      Array.from({ length: attempts }, () => decoded(BOUND_VIOLATING_OUTPUT)),
    );

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      schemaName: 'report',
      logger: captureLogger,
    });

    const error = expectErr(result);
    // The script holds exactly `attempts` steps and throws if asked for one
    // more, so this count *is* the "never a fourth call" assertion.
    expect(provider.calls).toHaveLength(attempts);
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');

    const details = detailsOf(error);
    expect(details.reason).toBe('schema');
    expect(details.attempts).toBe(attempts);
    expect(details.repairs).toBe(DEFAULT_MAX_REPAIRS);
    // One issue, so the array form and the joined form say the same thing —
    // both are kept because a JSON round-trip keeps an array a list, which is
    // what a user interface iterates.
    expect(details.issues).toEqual([issuesFor(BOUND_VIOLATING_OUTPUT)]);
    expect(details.issueCount).toBe(1);
    expect(details.issueSummary).toBe(issuesFor(BOUND_VIOLATING_OUTPUT));
    expect(details.schemaName).toBe('report');
    expect(error.message).toContain('report');
    expect(error.message).toContain('count');
    expect(error.hint).toBeTypeOf('string');

    // A spent budget is reported once, at warn, and the record carries the
    // failing paths without the schema's messages — a message can quote a key.
    const warned = onlyRecordAt('warn');
    expect(warned.fields.reason).toBe('schema');
    expect(warned.fields.issuePaths).toEqual(['count']);
    expect(warned.fields.attempts).toBe(attempts);
    expect(recordsAt('debug')).toHaveLength(DEFAULT_MAX_REPAIRS);
  });

  it('honours maxRepairs: 0 by rejecting after a single attempt', async () => {
    const provider = createFakeProvider([decoded(BOUND_VIOLATING_OUTPUT)]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      maxRepairs: 0,
    });

    const error = expectErr(result);
    expect(provider.calls).toHaveLength(1);
    expect(detailsOf(error).reason).toBe('schema');
    expect(detailsOf(error).attempts).toBe(1);
    expect(detailsOf(error).repairs).toBe(0);
  });

  it('reports at most DEFAULT_MAX_ISSUES issues, and says how many there were', async () => {
    const listSchema = z.array(z.string());
    const total = DEFAULT_MAX_ISSUES + 3;
    const provider = createFakeProvider([
      decoded(Array.from({ length: total }, (_unused, index) => index)),
    ]);

    const result = await generateStructuredWithRepair(provider, listSchema, makeRequest(), {
      maxRepairs: 0,
    });

    const details = detailsOf(expectErr(result));
    expect(details.issues).toHaveLength(DEFAULT_MAX_ISSUES);
    expect(details.issueCount).toBe(total);
    expect(String(details.issueSummary)).toContain(
      `and ${String(total - DEFAULT_MAX_ISSUES)} more`,
    );
  });

  it('names the artifact generically when the caller did not name it', async () => {
    const provider = createFakeProvider([decoded(BOUND_VIOLATING_OUTPUT)]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      maxRepairs: 0,
    });

    const error = expectErr(result);
    expect(error.message).toContain(DEFAULT_ARTIFACT_LABEL);
    expect('schemaName' in detailsOf(error)).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN])(
    'refuses the budget %p before asking the provider for anything',
    async (maxRepairs) => {
      const provider = createFakeProvider([decoded(VALID_OUTPUT)]);

      // A negative or fractional budget is a programmer error: it cannot be
      // recovered from and must not be silently rounded into a different
      // guarantee, so it throws rather than returning a rejection.
      await expect(
        generateStructuredWithRepair(provider, reportSchema, makeRequest(), { maxRepairs }),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
      expect(provider.calls).toHaveLength(0);
    },
  );

  // DEFAULT_MAX_REPAIRS is a CEILING, not merely the figure an unset budget
  // gets: AAP §0.5.3 allows "at most two repairs", which bounds how much of a
  // developer's project leaves their machine and what a stage costs. An
  // over-ceiling budget must therefore fail the way a malformed one does —
  // loudly, and with nothing sent — rather than being clamped, which would let
  // a caller believe a bound the product does not enforce. Both values are
  // derived from the constant so the cases track it instead of a literal: the
  // first is the smallest budget that crosses the ceiling, the second is far
  // past it.
  it.each([DEFAULT_MAX_REPAIRS + 1, DEFAULT_MAX_REPAIRS * 50])(
    'refuses the over-ceiling budget %p before asking the provider for anything',
    async (maxRepairs) => {
      const provider = createFakeProvider([decoded(VALID_OUTPUT)]);
      const call = generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
        maxRepairs,
      });

      await expect(call).rejects.toMatchObject({ code: 'INTERNAL' });
      // Asserted on the same settled rejection: the diagnostic has to quote the
      // budget that was asked for, because `INTERNAL` alone does not tell
      // whoever wrote the call which number to change.
      await expect(call).rejects.toThrowError(String(maxRepairs));
      expect(provider.calls).toHaveLength(0);
    },
  );

  it('accepts an explicit budget at the ceiling, spending exactly the default', async () => {
    const attempts = DEFAULT_MAX_REPAIRS + 1;
    const provider = createFakeProvider(
      Array.from({ length: attempts }, () => decoded(BOUND_VIOLATING_OUTPUT)),
    );

    // The ceiling is inclusive: a caller that states the bound it would have
    // been given anyway must not be refused for saying so out loud, and must
    // get the identical behaviour — one attempt plus DEFAULT_MAX_REPAIRS
    // repairs, and not one call more. The script holds exactly `attempts`
    // steps and throws if asked for another, so this is also where an
    // off-by-one in the cap would surface.
    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      maxRepairs: DEFAULT_MAX_REPAIRS,
    });

    const error = expectErr(result);
    expect(provider.calls).toHaveLength(attempts);
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(detailsOf(error).reason).toBe('schema');
    expect(detailsOf(error).attempts).toBe(attempts);
    expect(detailsOf(error).repairs).toBe(DEFAULT_MAX_REPAIRS);
  });

  it('spends the whole ceiling budget on an answer that repairs successfully', async () => {
    const provider = createFakeProvider([
      ...Array.from({ length: DEFAULT_MAX_REPAIRS }, () => decoded(BOUND_VIOLATING_OUTPUT)),
      decoded(VALID_OUTPUT),
    ]);

    // The companion to the case above: an explicit ceiling budget also reaches
    // a validated answer on its last permitted attempt, so the inclusive bound
    // is a usable repair allowance rather than one the loop refuses to spend.
    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      maxRepairs: DEFAULT_MAX_REPAIRS,
    });

    expectOk(result);
    expect(provider.calls).toHaveLength(DEFAULT_MAX_REPAIRS + 1);
    expect(result.value.attempts).toBe(DEFAULT_MAX_REPAIRS + 1);
    expect(result.value.repairs).toBe(DEFAULT_MAX_REPAIRS);
    expect(result.value.parsed).toEqual(VALID_OUTPUT);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Step 6: normalisation runs once, guarded
 *
 * The clause this whole suite exists for is in here.
 * ---------------------------------------------------------------------------
 */

describe('normalisation', () => {
  it('returns the normalised value beside the pre-normalisation authoring value', async () => {
    const provider = createFakeProvider([decoded(VALID_OUTPUT)]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      normalize: normalizeReport,
    });

    expectOk(result);
    // `value` is what the product runs on; `parsed` is the answer the model
    // actually gave, which is what a later reader needs to judge whether a
    // normaliser or a prompt is at fault.
    const normalized: NormalizedReport = result.value.value;
    expect(normalized).toEqual({ total: VALID_OUTPUT.count * 2, slug: 'FIRST' });
    expect(result.value.parsed).toEqual(VALID_OUTPUT);
    expect(result.value.value).not.toBe(result.value.parsed);
    expect(result.value.repairs).toBe(0);
  });

  it('normalises the repaired answer rather than the rejected one', async () => {
    const provider = createFakeProvider([
      decoded(BOUND_VIOLATING_OUTPUT),
      decoded({ count: 5, label: 'second' }),
    ]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      normalize: normalizeReport,
    });

    expectOk(result);
    expect(result.value.value).toEqual({ total: 10, slug: 'SECOND' });
    expect(result.value.repairs).toBe(1);
  });

  // A normaliser throw is a PRODUCT BUG, not a model failure. Its input had
  // already been accepted by the authoring schema, so an identical second
  // answer would fail identically: re-prompting would spend a developer's time
  // to hide a deterministic defect, and would make the repair budget mean
  // something different depending on where the defect happened to be. Hence the
  // assertion below, which is the one this suite exists for — the provider is
  // asked ONCE and never again.
  it('rejects a normaliser throw WITHOUT asking the provider again', async () => {
    const provider = createFakeProvider([decoded(VALID_OUTPUT)]);
    let normalizerCalls = 0;

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      normalize: (): NormalizedReport => {
        normalizerCalls += 1;
        throw new Error('the normaliser could not derive the internal shape');
      },
      schemaName: 'report',
    });

    const error = expectErr(result);
    // One provider call, one normaliser call, no repair: the script holds a
    // single step, so a second call would have thrown from the fake instead.
    expect(provider.calls).toHaveLength(1);
    expect(normalizerCalls).toBe(1);

    const details = detailsOf(error);
    expect(details.reason).toBe('normalize');
    expect(details.attempts).toBe(1);
    expect(details.repairs).toBe(0);
    // Not a schema failure, so there are no validation issues to report — and
    // reporting the model's output as invalid would send the caller down the
    // wrong recovery path.
    expect('issues' in details).toBe(false);
    expect(error.code).toBe('INTERNAL');
    expect(String(error.hint)).toContain('Re-prompting cannot help.');
  });

  it('preserves the thrown failure as the rejection’s cause', async () => {
    const thrown = new Error('the normaliser could not derive the internal shape');
    const provider = createFakeProvider([decoded(VALID_OUTPUT)]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      normalize: (): NormalizedReport => {
        throw thrown;
      },
    });

    const error = expectErr(result);
    // Normalised by `tryCatch` into a `DebuggenError` that keeps the thrown
    // message, and attached as the cause so the stack survives the rejection.
    expect(error.cause).toBeInstanceOf(DebuggenError);
    expect(String(error.cause)).toContain(thrown.message);
  });

  it('logs the normaliser failure once, at error level, with the input that provoked it', async () => {
    const provider = createFakeProvider([decoded(VALID_OUTPUT)]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      normalize: (): NormalizedReport => {
        throw new Error('the normaliser could not derive the internal shape');
      },
      schemaName: 'report',
      logger: captureLogger,
    });

    expectErr(result);
    // Exactly one record, because nothing else on this path logs: the answer
    // validated, so there was no schema failure to report, and the call itself
    // succeeded.
    expect(logRecords).toHaveLength(1);
    const record = onlyRecordAt('error');
    expect(record.message).toContain('normaliser threw');
    // The one value this loop ever logs: whoever fixes the defect needs the
    // input that provoked it.
    expect(record.fields.input).toEqual(VALID_OUTPUT);
    expect(record.fields.reason).toBe('normalize');
    expect(record.fields.attempts).toBe(1);
    expect(record.fields.repairs).toBe(0);
    expect(record.fields.stage).toBe(DEFAULT_STAGE);
    expect(record.fields.promptVersion).toBe(DEFAULT_PROMPT_VERSION);
    expect(record.fields.sessionId).toBe(DEFAULT_SESSION_ID);
    expect(record.fields.schemaName).toBe('report');
    expect(String(record.fields.error)).toContain('could not derive');
  });

  it('accepts a normaliser that returns a falsy value', async () => {
    // `tryCatch` classifies by *throwing*, never by the value returned, so a
    // normaliser whose internal shape is legitimately `0`, `''` or `null` must
    // not be mistaken for a failure.
    const provider = createFakeProvider([decoded(VALID_OUTPUT)]);

    const result = await generateStructuredWithRepair<ReportInput, number>(
      provider,
      reportSchema,
      makeRequest(),
      { normalize: () => 0 },
    );

    expectOk(result);
    expect(result.value.value).toBe(0);
    expect(result.value.parsed).toEqual(VALID_OUTPUT);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Step 2: a provider failure short-circuits, spending no repair
 * ---------------------------------------------------------------------------
 */

describe('a provider failure', () => {
  it('returns after one call, preserving the provider’s code, message, hint and identity', async () => {
    const transportFailure = new DebuggenError(
      'TRANSPORT_DISCONNECTED',
      'The provider could not be reached.',
      { hint: 'Check the network and try the stage again.' },
    );
    const provider = createFakeProvider([failure(transportFailure)]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      logger: captureLogger,
    });

    const error = expectErr(result);
    // A call that produced no output has nothing for a repair to correct, so
    // the budget is untouched — which is what keeps "at most two repairs"
    // meaningful for the badly shaped answer that may follow.
    expect(provider.calls).toHaveLength(1);
    expect(detailsOf(error).reason).toBe('provider');
    expect(detailsOf(error).repairs).toBe(0);
    expect(detailsOf(error).attempts).toBe(1);
    // The code and hint are what AAP §0.5.5's developer-facing message is
    // rendered from, so re-coding a transport failure as an output failure
    // would send the caller down the wrong recovery path.
    expect(error.code).toBe(transportFailure.code);
    expect(error.message).toBe(transportFailure.message);
    expect(error.hint).toBe(transportFailure.hint);
    expect(error.cause).toBe(transportFailure);
    expect(onlyRecordAt('debug').fields.reason).toBe('provider');
  });

  it('keeps the provider’s own details but wins a collision on the classification', async () => {
    const transportFailure = new DebuggenError('MODEL_UNAVAILABLE', 'The provider refused.', {
      details: { retryAfterMs: 1_000, reason: 'the transport’s own view' },
    });
    const provider = createFakeProvider([failure(transportFailure)]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest());

    const details = detailsOf(expectErr(result));
    expect(details.retryAfterMs).toBe(1_000);
    // This module's fields describe *this* call, so they overwrite the
    // transport's view of the same key.
    expect(details.reason).toBe('provider');
  });

  it('never carries a hint the provider did not give', async () => {
    const provider = createFakeProvider([
      failure(new DebuggenError('MODEL_UNAVAILABLE', 'The provider refused.')),
    ]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest());

    expect('hint' in expectErr(result)).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Output that was never JSON, and output that was never there
 * ---------------------------------------------------------------------------
 */

describe('an answer that never decoded as JSON', () => {
  it('is treated as a schema failure and repaired rather than thrown', async () => {
    const provider = createFakeProvider([
      undecoded(`Here is my reasoning about ${SENTINEL} and then some prose.`),
      decoded(VALID_OUTPUT),
    ]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest());

    expectOk(result);
    expect(provider.calls).toHaveLength(2);
    expect(result.value.repairs).toBe(1);
    const repair = lastTurnContent(callAt(provider, 1));
    expect(repair).toContain(NON_JSON_ISSUE_MESSAGE);
    expect(repair).toContain(ISSUE_ROOT_MARKER);
  });

  it('never echoes the undecoded text into the repair, the rejection or the log', async () => {
    const provider = createFakeProvider([
      undecoded(`Here is my reasoning about ${SENTINEL} and then some prose.`),
    ]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      maxRepairs: 0,
      logger: captureLogger,
    });

    const error = expectErr(result);
    expect(detailsOf(error).reason).toBe('schema');
    expect(detailsOf(error).issues).toEqual([`${ISSUE_ROOT_MARKER}: ${NON_JSON_ISSUE_MESSAGE}`]);
    // Undecoded model output is unbounded and has passed no redaction
    // checkpoint, so quoting it would put it in an outbound prompt, a log
    // record and a persisted rejection at once.
    expect(rejectionText(error)).not.toContain(SENTINEL);
    expect(logText()).not.toContain(SENTINEL);
  });

  it('never echoes a rejected value into the repair turn', async () => {
    const provider = createFakeProvider([
      decoded({ count: 0, label: SENTINEL }),
      decoded(VALID_OUTPUT),
    ]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      logger: captureLogger,
    });

    expectOk(result);
    expect(lastTurnContent(callAt(provider, 1))).not.toContain(SENTINEL);
    expect(logText()).not.toContain(SENTINEL);
  });
});

describe('an answer that was not there at all', () => {
  it('rejects with reason "empty" without spending a repair', async () => {
    const provider = createFakeProvider([silent()]);

    const result = await generateStructuredWithRepair(provider, reportSchema, makeRequest(), {
      logger: captureLogger,
    });

    const error = expectErr(result);
    // There is no output to correct and the shape was not what was wrong, so
    // this is its own classification rather than a schema failure — and the
    // script's single step proves no repair was attempted.
    expect(provider.calls).toHaveLength(1);
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(detailsOf(error).reason).toBe('empty');
    expect(detailsOf(error).repairs).toBe(0);
    expect('issues' in detailsOf(error)).toBe(false);
    expect(onlyRecordAt('warn').fields.reason).toBe('empty');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Step 7: cancellation, checked before every call
 * ---------------------------------------------------------------------------
 */

describe('cancellation', () => {
  it('rejects an already-aborted request without calling the provider', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createFakeProvider([decoded(VALID_OUTPUT)]);

    const result = await generateStructuredWithRepair(
      provider,
      reportSchema,
      makeRequest({ signal: controller.signal }),
      { logger: captureLogger },
    );

    const error = expectErr(result);
    // A request spent on abandoned work is a request a developer waits for.
    expect(provider.calls).toHaveLength(0);
    expect(error.code).toBe('MODEL_UNAVAILABLE');
    expect(detailsOf(error).reason).toBe('provider');
    expect(detailsOf(error).attempts).toBe(0);
    expect(detailsOf(error).repairs).toBe(0);
    expect(onlyRecordAt('debug').fields.attempts).toBe(0);
  });

  it('checks the signal again before a repair', async () => {
    const controller = new AbortController();
    // The answer failed validation and the work was abandoned while the call
    // was in flight: the repair must not be sent.
    const provider = createFakeProvider([
      decoded(BOUND_VIOLATING_OUTPUT, {
        whileInFlight: () => {
          controller.abort();
        },
      }),
    ]);

    const result = await generateStructuredWithRepair(
      provider,
      reportSchema,
      makeRequest({ signal: controller.signal }),
    );

    const error = expectErr(result);
    expect(provider.calls).toHaveLength(1);
    expect(error.code).toBe('MODEL_UNAVAILABLE');
    expect(detailsOf(error).attempts).toBe(1);
    expect(detailsOf(error).repairs).toBe(1);
  });

  it('proceeds while a signal is present and unaborted', async () => {
    const controller = new AbortController();
    const provider = createFakeProvider([decoded(VALID_OUTPUT)]);

    const result = await generateStructuredWithRepair(
      provider,
      reportSchema,
      makeRequest({ signal: controller.signal }),
    );

    expectOk(result);
    expect(provider.calls).toHaveLength(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * What every rejection says about the call it belonged to
 * ---------------------------------------------------------------------------
 */

describe('rejection provenance', () => {
  it('names the stage, the prompt version and the session', async () => {
    const provider = createFakeProvider([silent()]);

    const result = await generateStructuredWithRepair(
      provider,
      reportSchema,
      makeRequest({ stage: 'generate-panel', sessionId: 'ses_0000000002' }),
    );

    const details = detailsOf(expectErr(result));
    expect(details.stage).toBe('generate-panel');
    expect(details.promptVersion).toBe(DEFAULT_PROMPT_VERSION);
    expect(details.sessionId).toBe('ses_0000000002');
  });

  it('omits the session when the request carried none', async () => {
    const provider = createFakeProvider([silent()]);

    const result = await generateStructuredWithRepair(
      provider,
      reportSchema,
      makeRequest({ sessionId: null }),
    );

    expect('sessionId' in detailsOf(expectErr(result))).toBe(false);
  });

  it('never carries the prompt or the structured input', async () => {
    const provider = createFakeProvider([decoded(BOUND_VIOLATING_OUTPUT)]);
    const request = makeRequest({
      prompt: `Summarise ${SENTINEL} for the developer.`,
      input: { note: SENTINEL },
      system: `Never repeat ${SENTINEL}.`,
    });

    const result = await generateStructuredWithRepair(provider, reportSchema, request, {
      maxRepairs: 0,
      logger: captureLogger,
    });

    // `details` is logged, persisted with a session and rendered in two user
    // interfaces, and it passes through no redaction checkpoint of its own.
    expect(rejectionText(expectErr(result))).not.toContain(SENTINEL);
    expect(logText()).not.toContain(SENTINEL);
  });
});

/*
 * ---------------------------------------------------------------------------
 * formatZodIssues
 *
 * The text this produces is appended to an outbound prompt, attached to a
 * rejection, written to a log and persisted with a session, so its four
 * properties — one line per issue, deterministic order, bounded length, and no
 * rejected value anywhere in it — are each asserted separately.
 * ---------------------------------------------------------------------------
 */

/** The rejection of `raw` against `schema`, for a case that needs the error. */
function rejectionOf<T>(schema: ZodType<T>, raw: unknown): z.ZodError {
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    throw new Error(`the fixture was expected to fail validation: ${JSON.stringify(raw)}`);
  }
  return parsed.error;
}

describe('formatZodIssues', () => {
  it('renders one path-and-message line per issue', () => {
    const schema = z.object({
      count: z.number().int().min(1),
      label: z.string(),
      tags: z.array(z.string()),
    });
    const error = rejectionOf(schema, { count: 0, label: 7, tags: ['fine', 5] });

    const lines = formatZodIssues(error).split(ISSUE_LINE_SEPARATOR);

    expect(lines).toHaveLength(3);
    // Sorted by path, so the order is the schema-independent one below rather
    // than whichever order Zod happened to report.
    expect(lines[0]?.startsWith('count: ')).toBe(true);
    expect(lines[1]?.startsWith('label: ')).toBe(true);
    // A numeric segment is a subscript, which is what makes an array path
    // readable at a glance.
    expect(lines[2]?.startsWith('tags[1]: ')).toBe(true);
  });

  it('is byte-identical for the same issues supplied in a different order', () => {
    // Zod reports object issues in the order the schema declares its keys, so
    // two schemas over the same keys produce the same issues in different
    // orders. A repair attempt is a prompt: feedback that varied between
    // identical runs would make the flow irreproducible.
    const bad = { alpha: 1, beta: 2, gamma: 3 };
    const ascending = z.object({
      alpha: z.string(),
      beta: z.string(),
      gamma: z.string(),
    });
    const descending = z.object({
      gamma: z.string(),
      beta: z.string(),
      alpha: z.string(),
    });

    const first = formatZodIssues(rejectionOf(ascending, bad));
    const second = formatZodIssues(rejectionOf(descending, bad));

    expect(second).toBe(first);
    expect(first.split(ISSUE_LINE_SEPARATOR).map((line) => line.split(':')[0])).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('addresses an issue on the value itself with a stable root marker', () => {
    const error = rejectionOf(reportSchema, 'not an object at all');

    const formatted = formatZodIssues(error);

    expect(formatted.startsWith(`${ISSUE_ROOT_MARKER}: `)).toBe(true);
  });

  it('truncates at DEFAULT_MAX_ISSUES with a count of what was hidden', () => {
    const total = DEFAULT_MAX_ISSUES + 4;
    const error = rejectionOf(
      z.array(z.string()),
      Array.from({ length: total }, (_unused, index) => index),
    );

    const lines = formatZodIssues(error).split(ISSUE_LINE_SEPARATOR);

    expect(lines).toHaveLength(DEFAULT_MAX_ISSUES + 1);
    // The tail is what keeps a truncated list from reading as a complete one.
    expect(lines[DEFAULT_MAX_ISSUES]).toBe(`\u2026and ${String(total - DEFAULT_MAX_ISSUES)} more`);
  });

  it('honours an explicit maxIssues', () => {
    const error = rejectionOf(
      z.array(z.string()),
      Array.from({ length: 5 }, (_unused, index) => index),
    );

    const lines = formatZodIssues(error, { maxIssues: 2 }).split(ISSUE_LINE_SEPARATOR);

    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('\u2026and 3 more');
  });

  it('adds no tail when nothing was hidden', () => {
    const error = rejectionOf(reportSchema, BOUND_VIOLATING_OUTPUT);

    expect(formatZodIssues(error, { maxIssues: DEFAULT_MAX_ISSUES })).not.toContain('more');
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses maxIssues %p as a programmer error', (maxIssues) => {
    const error = rejectionOf(reportSchema, BOUND_VIOLATING_OUTPUT);

    expect(() => formatZodIssues(error, { maxIssues })).toThrowError(DebuggenError);
  });

  it('never echoes the value that failed', () => {
    // The sentinel sits in a *value* position, which is exactly where a
    // rejected payload would leak from: a Zod issue carries the input that
    // failed, and this function must never read it.
    const error = rejectionOf(reportSchema, { count: SENTINEL, label: 5 });

    const formatted = formatZodIssues(error);

    expect(formatted).not.toContain(SENTINEL);
    // It still says what was wrong and where.
    expect(formatted).toContain('count');
    expect(formatted).toContain('label');
  });

  it('bounds a single line, however long the schema’s message is', () => {
    const error = rejectionOf(
      z.string().refine(() => false, { message: 'x'.repeat(MAX_ISSUE_LINE_LENGTH * 3) }),
      'anything',
    );

    const formatted = formatZodIssues(error);

    // Truncated to the cap plus the one-character ellipsis that says so.
    expect(formatted).toHaveLength(MAX_ISSUE_LINE_LENGTH + 1);
    expect(formatted.endsWith('\u2026')).toBe(true);
  });

  it('replaces control characters instead of passing them through', () => {
    // A custom refinement message is authored text, and this text reaches a
    // terminal, a log and two user interfaces. A message that could inject
    // newlines could also forge an issue line that no schema reported.
    const error = rejectionOf(
      z.string().refine(() => false, { message: 'first\nsecond\u0007third\u0000fourth' }),
      'anything',
    );

    const formatted = formatZodIssues(error);

    expect(formatted.split(ISSUE_LINE_SEPARATOR)).toHaveLength(1);
    expect(formatted).not.toContain('\u0007');
    expect(formatted).not.toContain('\u0000');
    expect(formatted).toContain('\uFFFD');
  });

  it('stays legible for a rejection that carries no issues at all', () => {
    // Should not occur, and a silently empty report would be the difference
    // between a puzzling failure and an actionable one.
    expect(formatZodIssues(new z.ZodError([]))).toBe(
      `${ISSUE_ROOT_MARKER}: ${EMPTY_ISSUE_MESSAGE}`,
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * buildRepairRequest
 * ---------------------------------------------------------------------------
 */

describe('buildRepairRequest', () => {
  it('returns a new request and leaves the original untouched', () => {
    const original = makeRequest({ system: 'Answer with one JSON value.', messages: PRIOR_TURNS });
    const before = payloadSnapshot(original);

    const repaired = buildRepairRequest(original, 'count: out of range', 1);

    expect(repaired).not.toBe(original);
    expect(payloadSnapshot(original)).toBe(before);
    expect(original.messages).toBe(PRIOR_TURNS);
    expect(PRIOR_TURNS).toHaveLength(2);
  });

  it('carries system, prompt, input, metadata and signal across by value', () => {
    const controller = new AbortController();
    const original = makeRequest({
      system: 'Answer with one JSON value.',
      input: { itemCount: 7 },
      signal: controller.signal,
    });

    const repaired = buildRepairRequest(original, 'count: out of range', 2);

    expect(repaired.system).toBe(original.system);
    expect(repaired.prompt).toBe(original.prompt);
    // `input` is the structured half of the payload and the rules-based
    // provider answers from it alone, so a repair that dropped it would fail
    // for a reason that has nothing to do with the model.
    expect(repaired.input).toBe(original.input);
    expect(repaired.metadata).toBe(original.metadata);
    expect(repaired.metadata.promptVersion).toBe(original.metadata.promptVersion);
    expect(repaired.signal).toBe(controller.signal);
  });

  it('appends the correction pair without dropping a prior turn', () => {
    const original = makeRequest({ messages: PRIOR_TURNS });

    const repaired = buildRepairRequest(original, 'count: out of range', 3);

    expect(turnsOf(repaired)).toHaveLength(PRIOR_TURNS.length + 2);
    expect(turnsOf(repaired).slice(0, PRIOR_TURNS.length)).toEqual(PRIOR_TURNS);
    expect(turnAt(repaired, PRIOR_TURNS.length)).toEqual({
      role: 'assistant',
      content: REPAIR_ASSISTANT_NOTICE,
    });
    const correction = turnAt(repaired, PRIOR_TURNS.length + 1);
    expect(correction.role).toBe('user');
    expect(correction.content).toContain('Attempt 3');
    expect(correction.content).toContain('count: out of range');
  });

  it('starts a conversation when the original carried no turns', () => {
    const original = makeRequest();

    const repaired = buildRepairRequest(original, 'count: out of range', 1);

    expect(original.messages).toBeUndefined();
    expect(turnsOf(repaired)).toHaveLength(2);
    expect(turnAt(repaired, 0).role).toBe('assistant');
    expect(turnAt(repaired, 1).role).toBe('user');
  });

  it('does not reproduce the rejected answer', () => {
    const original = makeRequest();

    const repaired = buildRepairRequest(original, `count: rejected near ${SENTINEL}`, 1);

    // The issue text is the caller's to assemble — `formatZodIssues` is what
    // keeps a value out of it — but the notice this function adds must not
    // invite the model to reconcile a summary with an answer it can no longer
    // see, so it states that the answer is omitted.
    expect(turnAt(repaired, 0).content).toBe(REPAIR_ASSISTANT_NOTICE);
    expect(REPAIR_ASSISTANT_NOTICE).toContain('omitted');
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses the attempt number %p', (attempt) => {
    const original = makeRequest();

    expect(() => buildRepairRequest(original, 'count: out of range', attempt)).toThrowError(
      DebuggenError,
    );
  });
});
