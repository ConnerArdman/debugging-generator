/**
 * Colocated suite for the network-backed provider — the one module in this
 * repository that can send a developer's data off their machine — and, because
 * the plan gives it no suite of its own, for the selection boundary in
 * `../factory.ts` that decides whether it is reached at all.
 *
 * **Mocked transport only. No network, on any path, ever.** Two mechanisms
 * together make that a property of the file rather than a habit of its author:
 *
 * 1. Every provider under test is constructed through
 *    `AnthropicProviderOptions.client`, the seam `./anthropic.ts` declares for
 *    exactly this purpose, so a fake object serves every route.
 * 2. The software development kit's default export is replaced module-wide
 *    (see {@link transportConstruction}), so even the two paths that construct
 *    a transport for themselves — `createAnthropicProvider` without a client
 *    and `createModelProvider` with the network-backed selection — build an
 *    object that records its options and refuses to be called. The *actual*
 *    module is spread back in underneath, so `APIUserAbortError` keeps its real
 *    identity, which is what the cancellation classification is recognised by.
 *
 * ## What this file pins, in the order the blocks appear
 *
 * - **Construction.** The reported id, the structural provider guard, the two
 *   configuration refusals that carry AAP §0.5.5's sentence, the injected-client
 *   exemption from needing a credential, and the transport retry budget being
 *   handed to the transport and never conflated with the schema repair budget.
 * - **The schema-constrained route.** `zodOutputFormat`'s rendered schema is
 *   what is actually sent, `raw` carries the decoded output, and one call is one
 *   attempt.
 * - **The forced `tool_use` fallback.** Driven only through its three
 *   legitimate triggers, and proven *not* to fire for a transport failure or
 *   for a schema mismatch.
 * - **Post-parse re-validation (AAP §0.2.4).** The rendered format demonstrably
 *   drops a numeric bound, so an answer that violates it arrives as
 *   `ok(attempt)` with `raw` intact and `value` absent — an `Err` there would
 *   spend `../structured.ts`'s repair budget on an ordinary bad answer.
 * - **Text, tools, signals and the failure vocabulary.** Every failure is a
 *   `DebuggenError` whose code is a member of the closed tuple in
 *   `@debuggen/shared`, and nothing throws.
 * - **The outbound redaction gate.** The load-bearing block: a payload carrying
 *   a denied pattern produces an `Err` and **zero** recorded transport calls,
 *   in three placements, through all three methods, and on a repair turn.
 * - **The factory.** Folded in here, driven through its injectable environment
 *   record; `process.env` is never mutated.
 *
 * ## Conventions this file works under
 *
 * - The Vitest project is `model-provider` in the **root** `vitest.config.ts`:
 *   node environment, `globals: false`. Every API is imported explicitly, and
 *   no per-package Vitest configuration exists or may be added.
 * - The compiler project is NodeNext, so every relative import carries `.js`,
 *   and the package's tsconfig `include` covers `*.test.ts`, so `pnpm typecheck`
 *   checks this file under `strict`, `noUncheckedIndexedAccess` and
 *   `exactOptionalPropertyTypes`. The fake client genuinely satisfies
 *   `AnthropicClientLike`; nothing here is cast into shape.
 * - Only `@debuggen/shared`, `zod`, `@anthropic-ai/sdk`, `node:` builtins,
 *   `vitest` and in-package relative modules are imported — the layering
 *   `eslint.config.js` enforces for this package.
 * - `tsup` bundles `src/index.ts` alone, so no test file is reachable from
 *   `dist/`; no source module imports this one, and nothing here is exported.
 *
 * ## Two literals that are deliberately absent
 *
 * - **No model identifier.** `config.model` is the only source of one in the
 *   product (AAP §0.5.3), so the fixtures below use an obviously synthetic
 *   placeholder whose *presence* is the point and whose content is irrelevant.
 * - **No copy of AAP §0.5.5's sentence.** It is asserted by comparison against
 *   `modelUnavailableMessage` — declared in `../provider.ts`, the leaf both the
 *   selector and this implementation import it from. Pasting the sentence here
 *   would let the two drift apart silently, which is the one thing sharing the
 *   builder exists to prevent.
 *
 * ## Credential-shaped fixtures are assembled at runtime
 *
 * This file is tracked content and `scripts/check-secrets.mjs` scans tracked
 * content under the same rule classes the guard implements, including this path
 * — which no allowlist entry names, and none may be added for it. So no
 * credential prefix, token body, key-file delimiter or credentialed URI appears
 * below as a contiguous literal: {@link assemble} joins fragments and
 * {@link cycle} builds bodies from an alphabet, exactly as
 * `../redact-guard.ts`, `./deterministic.test.ts` and
 * `scripts/check-secrets.test.mjs` do. Nothing here may be "simplified" into a
 * literal.
 */

import { readFileSync } from 'node:fs';

import { APIUserAbortError } from '@anthropic-ai/sdk';
import type AnthropicClient from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DEBUGGEN_ERROR_CODES, DebuggenError, createConsoleLogger } from '@debuggen/shared';
import type { LogRecord, Result } from '@debuggen/shared';

import { DEFAULT_PROVIDER_ID, createModelProvider, resolveProviderConfig } from '../factory.js';
import { hasClose, isModelProvider, modelUnavailableMessage } from '../provider.js';
import type { ModelProvider } from '../provider.js';
import { assertOutboundSafe } from '../redact-guard.js';
import { REPAIR_ASSISTANT_NOTICE, buildRepairRequest } from '../structured.js';
import { DEFAULT_MAX_REPAIRS } from '../types.js';
import type {
  JsonObject,
  ModelMessage,
  ModelProviderConfig,
  ModelRequest,
  PromptStage,
  ToolDefinition,
} from '../types.js';
import {
  ANTHROPIC_DEFAULT_MAX_RETRIES,
  ANTHROPIC_DEFAULT_TIMEOUT_MS,
  ANTHROPIC_SUPPORTED_TEMPERATURE,
  createAnthropicProvider,
  resolveAnthropicTransportBudgets,
} from './anthropic.js';
import type {
  AnthropicClientLike,
  AnthropicMessageLike,
  AnthropicMessageParamsLike,
  AnthropicMessagesLike,
  AnthropicRequestOptionsLike,
  AnthropicStructuredOutputMode,
} from './anthropic.js';
import { PROVIDER_IDS } from './index.js';

/* -------------------------------------------------------------------------------------------------
 * The transport that is never real
 *
 * `vi.mock` is the second half of the no-network guarantee, and it is used here
 * for the one case the injection seam cannot express: what the *constructed*
 * client receives. The factory returns a `Result` rather than a handle to the
 * client it built, so the only observation point is the constructor itself.
 *
 * The actual module is spread back in, so every other export — notably
 * `APIUserAbortError`, which `./anthropic.ts` recognises a cancellation by with
 * `instanceof` — keeps its real identity. A hand-written stand-in for that
 * class would make the cancellation case pass for the wrong reason.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The options every constructed transport was built with, newest last.
 *
 * Hoisted, because `vi.mock`'s factory is evaluated before the module body and
 * a plain `const` would still be uninitialised when it runs.
 */
const transportConstruction = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');

  /**
   * A transport that records how it was configured and refuses to be used.
   *
   * Refusing rather than answering is deliberate: every behavioural case in
   * this file injects its own client, so a call arriving here means a provider
   * reached a transport it built for itself, and that must fail loudly instead
   * of quietly succeeding.
   */
  class UnreachableTransport {
    readonly messages = {
      create: (): Promise<never> =>
        Promise.reject(
          new Error(
            'a constructed transport was called: every case in this suite injects its own client',
          ),
        ),
    };

    constructor(options?: unknown) {
      transportConstruction.options.push(options);
    }
  }

  return { ...actual, default: UnreachableTransport };
});

/* -------------------------------------------------------------------------------------------------
 * Fixture construction
 * ---------------------------------------------------------------------------------------------- */

/** The inclusive character range from `first` to `last`, by code unit. */
function charRange(first: string, last: string): string {
  let result = '';
  for (let code = first.charCodeAt(0); code <= last.charCodeAt(0); code += 1) {
    result += String.fromCharCode(code);
  }
  return result;
}

/**
 * A deterministic body of `length` characters cycled from `alphabet`.
 *
 * Deterministic so a failure reproduces, and cycled over the whole alphabet so
 * the result is as dense as real key material.
 */
function cycle(alphabet: string, length: number): string {
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += alphabet.charAt(index % alphabet.length);
  }
  return result;
}

/**
 * Joins fixture fragments.
 *
 * Every call exists to keep a credential prefix or an authentication scheme
 * word from appearing as one contiguous literal in this tracked file. The split
 * points carry no other meaning.
 */
function assemble(...fragments: readonly string[]): string {
  return fragments.join('');
}

const DIGITS = charRange('0', '9');
const LOWER_LETTERS = charRange('a', 'z');
const UPPER_LETTERS = charRange('A', 'Z');

/** Base64url: 64 symbols, the alphabet of an opaque provider credential. */
const URLSAFE_CHARS = UPPER_LETTERS + LOWER_LETTERS + DIGITS + '-_';

/** Lower-case hexadecimal, for fixtures that only need to be distinctive. */
const HEX_CHARS = DIGITS + charRange('a', 'f');

/**
 * A synthetic model placeholder.
 *
 * No vendor publishes it, and that is the requirement: the product carries no
 * model identifier anywhere (AAP §0.5.3), so what matters about this value is
 * that it is *present* in the configuration, never what it says.
 */
const MODEL_PLACEHOLDER = 'model-under-test';

/** A second placeholder, for the case where the answer reports its own model. */
const REPORTED_MODEL_PLACEHOLDER = assemble(MODEL_PLACEHOLDER, '-as-answered');

/**
 * An obviously fake credential, assembled so no key-shaped literal is tracked.
 *
 * Its body is a plain alphabetical run rather than a word, and that is
 * load-bearing: {@link expectNoValueLeak} slides an eight-character window over
 * this value across every failure and log record the product produces, so a
 * fixture built from English words would collide with the product's own
 * remediation prose ("…where no credential is needed…") and report a leak that
 * had not happened. The alphabet is also disjoint from
 * {@link PROVIDER_REQUEST_ID}'s, which the product legitimately *does* report,
 * so the two cannot be confused for one another either.
 */
const CREDENTIAL_FIXTURE = assemble('ut-', cycle(LOWER_LETTERS, 24));

/** A credential shape the outbound guard's `provider-key` rule recognises. */
const DENIED_PROVIDER_KEY = assemble('s', 'k-', 'ant-') + cycle(URLSAFE_CHARS, 28);

/** A header value the guard's `sensitive-header` and `bearer-token` rules both catch. */
const DENIED_HEADER_VALUE = assemble('Bea', 'rer ') + cycle(URLSAFE_CHARS, 36);

/**
 * Planted in the message of every rejection a scripted transport throws.
 *
 * A provider's own report is its own: it may quote anything it likes from the
 * request it refused, which is why `./anthropic.ts` keeps it as the error's
 * `cause` and never copies it into a message, a hint or a `details` field. This
 * token is how that is checked.
 */
const PROVIDER_REPORT_SENTINEL = 'QZREPORT7741';

/** The opaque request identifier a provider's support would ask for. */
const PROVIDER_REQUEST_ID = assemble('req_', cycle(HEX_CHARS, 12));

/** The rendered prose of a clean request: English, and nothing else. */
const CLEAN_PROMPT =
  'Summarise the captured evidence for this interaction and cite the event ids that support each observed statement.';

/** The standing constraints half of a clean request. */
const CLEAN_SYSTEM =
  'Answer only in the requested shape, and state nothing that the evidence does not support.';

/** The prompt file version every request below records. */
const PROMPT_VERSION = 'v001';

/**
 * The structured half of a clean request.
 *
 * Generic by construction: no identifier here belongs to any application under
 * test, and no field name is credential-like, so the guard's entropy rule has
 * nothing to bind to and `pnpm check:no-hardcoding` has nothing to find.
 */
const CLEAN_INPUT: JsonObject = {
  slowestOperations: [
    { label: 'outer-call', durationMs: 640 },
    { label: 'inner-call', durationMs: 120 },
  ],
  totals: { spans: 18, tiers: 3 },
};

/* -------------------------------------------------------------------------------------------------
 * The authoring schemas the structured routes are driven with
 *
 * Local and minimal. `@debuggen/panel-schema` and `@debuggen/instrumentation`
 * are deliberately not dependencies of this package (AAP §0.2.2) — which is
 * precisely why `../provider.ts` has the caller pass its schema in — so the
 * shapes here stand for a stage's authoring schema without importing one.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The bounded answer schema, and the reason this file has one at all.
 *
 * `count` carries a lower bound. AAP §0.2.4 records that the platform's
 * structured-output helper **strips the JSON-Schema keywords its format does
 * not support**, so that bound does not survive into what constrains
 * generation — a fact asserted directly below rather than assumed — and the
 * provider's own re-validation is the only thing standing between a violating
 * answer and a `value` a caller would trust.
 */
const answerSchema = z.object({
  label: z.string(),
  count: z.number().int().min(2),
});

/** One answer that satisfies {@link answerSchema}. */
const VALID_ANSWER = { label: 'inner-call', count: 4 } as const;

/**
 * An answer that decodes cleanly and violates the bound.
 *
 * `label` carries a sentinel so the log records a schema miss produces can be
 * checked for the one thing they must never contain: the answer's own content.
 */
const BOUND_VIOLATING_ANSWER = { label: 'QZANSWER5512', count: 1 } as const;

/**
 * A schema the output-format renderer refuses outright.
 *
 * A transform cannot be represented as JSON Schema, so `zodOutputFormat`
 * throws for this one. That is one of the three documented conditions the
 * schema-constrained route cannot serve, and the tool route can: it renders
 * its `input_schema` with unrepresentable constructs widened, so the *input*
 * side of this pipe renders perfectly well.
 */
const transformedAnswerSchema = answerSchema.transform((answer) => ({
  ...answer,
  doubled: answer.count * 2,
}));

/**
 * A schema whose root is not an object.
 *
 * The messages API's tool arguments are an object by definition, so the tool
 * route refuses this rather than wrapping it — wrapping would change the shape
 * of the value reported as `raw`.
 */
const scalarAnswerSchema = z.string();

/* -------------------------------------------------------------------------------------------------
 * The fake transport: a call recorder with programmable outcomes
 * ---------------------------------------------------------------------------------------------- */

/** One recorded transport call: exactly what the provider passed, unaltered. */
interface RecordedCall {
  /** The request parameters, as the provider built them. */
  readonly params: AnthropicMessageParamsLike;

  /** The per-call transport options, which carry the abort signal and timeout. */
  readonly options: AnthropicRequestOptionsLike | undefined;
}

/** What a scripted transport method does when it is called. */
type TransportOutcome =
  | { readonly kind: 'answer'; readonly message: AnthropicMessageLike }
  | { readonly kind: 'reject'; readonly error: unknown };

/** An answer outcome. */
function answers(message: AnthropicMessageLike): TransportOutcome {
  return { kind: 'answer', message };
}

/** A rejection outcome, for a transport that fails rather than answers. */
function rejects(error: unknown): TransportOutcome {
  return { kind: 'reject', error };
}

/**
 * What a fake transport will do, per method.
 *
 * Omitting `parse` is not the same as scripting a failure for it: a client
 * without a `parse` capability is one of the documented reasons a structured
 * call takes its tool route, so omission drives that branch.
 */
interface TransportScript {
  /** The schema-constrained route's outcome; omit to remove the capability. */
  readonly parse?: TransportOutcome;

  /** The plain route's outcome; omit to make an unexpected call fail loudly. */
  readonly create?: TransportOutcome;
}

/**
 * A fake {@link AnthropicClientLike} that records every call it receives.
 *
 * The counts are what several assertions in this file actually turn on — "zero
 * transport calls" and "exactly one attempt" are statements about numbers, not
 * about a result's shape — so both per-method lists and the total are exposed.
 */
interface FakeTransport {
  /** The client to inject through `AnthropicProviderOptions.client`. */
  readonly client: AnthropicClientLike;

  /** Every schema-constrained call, oldest first. */
  readonly parseCalls: readonly RecordedCall[];

  /** Every plain or tool-bearing call, oldest first. */
  readonly createCalls: readonly RecordedCall[];

  /** How many calls reached the transport in total, by either route. */
  readonly callCount: number;

  /** Forgets every recorded call, for a case that drives several calls. */
  reset(): void;
}

/**
 * Builds a fake transport from a script.
 *
 * @param script What each method does. An unscripted method records its call
 * and then rejects, so a provider that took an unexpected route fails the test
 * with the route named rather than silently.
 * @returns The transport and its recordings.
 */
function createTransport(script: TransportScript = {}): FakeTransport {
  const parseCalls: RecordedCall[] = [];
  const createCalls: RecordedCall[] = [];

  const respond = (
    calls: RecordedCall[],
    route: string,
    outcome: TransportOutcome | undefined,
    params: AnthropicMessageParamsLike,
    options: AnthropicRequestOptionsLike | undefined,
  ): Promise<AnthropicMessageLike> => {
    calls.push({ params, options });
    if (outcome === undefined) {
      return Promise.reject(
        new Error(
          `this case scripted no "${route}" outcome, so the provider took an unexpected route`,
        ),
      );
    }
    if (outcome.kind === 'answer') {
      return Promise.resolve(outcome.message);
    }
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a real transport can reject with anything at all (a string, `null`, a plain object), and "never throws for any thrown value" is one of the properties this suite asserts, so the rejection reason is deliberately `unknown` here.
    return Promise.reject(outcome.error);
  };

  const create = (
    params: AnthropicMessageParamsLike,
    options?: AnthropicRequestOptionsLike,
  ): Promise<AnthropicMessageLike> =>
    respond(createCalls, 'create', script.create, params, options);

  const messages: AnthropicMessagesLike =
    script.parse === undefined
      ? { create }
      : {
          create,
          parse: (
            params: AnthropicMessageParamsLike,
            options?: AnthropicRequestOptionsLike,
          ): Promise<AnthropicMessageLike> =>
            respond(parseCalls, 'parse', script.parse, params, options),
        };

  return {
    client: { messages },
    parseCalls,
    createCalls,
    get callCount(): number {
      return parseCalls.length + createCalls.length;
    },
    reset(): void {
      parseCalls.length = 0;
      createCalls.length = 0;
    },
  };
}

/**
 * A transport rejection shaped the way the software development kit surfaces
 * one: an `Error` carrying the HTTP status and the provider's opaque request
 * identifier.
 *
 * `./anthropic.ts` classifies a failure from exactly those two properties plus
 * the report text, so a fake that carries them drives the real classification
 * rather than a simplification of it.
 */
class ScriptedTransportError extends Error {
  /** The HTTP status the provider answered with, when it answered. */
  readonly status: number | undefined;

  /** The provider's own request identifier, read into `details`. */
  readonly requestID = PROVIDER_REQUEST_ID;

  constructor(status: number | undefined, report: string) {
    super(`${report} [${PROVIDER_REPORT_SENTINEL}] ${CREDENTIAL_FIXTURE}`);
    this.name = 'ScriptedTransportError';
    this.status = status;
  }
}

/** A rejection with no status at all: nothing reached the provider. */
function unreachableError(): ScriptedTransportError {
  return new ScriptedTransportError(undefined, 'socket hang up');
}

/** A rejection whose name is what an aborted `fetch` produces. */
function namedAbortError(name: 'AbortError' | 'TimeoutError'): Error {
  const error = new Error(`the call was ${name === 'AbortError' ? 'aborted' : 'timed out'}`);
  error.name = name;
  return error;
}

/* -------------------------------------------------------------------------------------------------
 * Answer builders
 * ---------------------------------------------------------------------------------------------- */

/** An answer whose content is one text block, with accounting and a stop reason. */
function textAnswer(text: string): AnthropicMessageLike {
  return {
    model: REPORTED_MODEL_PLACEHOLDER,
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 128, output_tokens: 64 },
  };
}

/** An answer carrying a decoded structured artifact as its only text block. */
function structuredAnswer(value: unknown): AnthropicMessageLike {
  return textAnswer(JSON.stringify(value));
}

/** An answer whose output arrives as a forced tool call's arguments. */
function toolUseAnswer(name: string, input: unknown): AnthropicMessageLike {
  return {
    model: REPORTED_MODEL_PLACEHOLDER,
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: assemble('call_', cycle(HEX_CHARS, 8)), name, input }],
    usage: { input_tokens: 96, output_tokens: 32 },
  };
}

/** An answer with nothing in it at all: no text, no tool call, no output. */
const EMPTY_ANSWER: AnthropicMessageLike = { content: [] };

/* -------------------------------------------------------------------------------------------------
 * Request construction
 * ---------------------------------------------------------------------------------------------- */

/** The halves of a request a case may want to fill in. */
interface RequestParts {
  readonly stage?: PromptStage;
  readonly prompt?: string;
  readonly system?: string;
  readonly messages?: readonly ModelMessage[];
  readonly input?: JsonObject;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

/**
 * A request with the required fields filled in plausibly and nothing the
 * outbound guard objects to.
 *
 * Each optional member is spread in only when it has a value: this package
 * compiles with `exactOptionalPropertyTypes`, so an omitted field must be
 * *absent* rather than present and `undefined`, which is also what
 * `./anthropic.ts` is entitled to assume when it reads one.
 */
function makeRequest(parts: RequestParts = {}): ModelRequest {
  return {
    prompt: parts.prompt ?? CLEAN_PROMPT,
    input: parts.input ?? CLEAN_INPUT,
    metadata: { stage: parts.stage ?? 'analyze', promptVersion: PROMPT_VERSION },
    ...(parts.system === undefined ? {} : { system: parts.system }),
    ...(parts.messages === undefined ? {} : { messages: parts.messages }),
    ...(parts.maxTokens === undefined ? {} : { maxTokens: parts.maxTokens }),
    ...(parts.temperature === undefined ? {} : { temperature: parts.temperature }),
    ...(parts.signal === undefined ? {} : { signal: parts.signal }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The unit under test, assembled
 * ---------------------------------------------------------------------------------------------- */

/** The configuration every behavioural case starts from: a model, nothing else. */
const BASE_CONFIG: ModelProviderConfig = {
  providerId: 'anthropic',
  model: MODEL_PLACEHOLDER,
};

/** What {@link harness} accepts. */
interface HarnessOptions {
  /** What the transport does. Defaults to a transport nothing is scripted on. */
  readonly script?: TransportScript;

  /** The resolved configuration. Defaults to {@link BASE_CONFIG}. */
  readonly config?: ModelProviderConfig;

  /** Which structured route to take. Defaults to the product's `'auto'`. */
  readonly structuredOutputMode?: AnthropicStructuredOutputMode;
}

/** A provider, its transport recordings and everything it logged. */
interface Harness {
  readonly provider: ModelProvider;
  readonly transport: FakeTransport;
  readonly logs: readonly LogRecord[];
}

/**
 * Builds a provider over a fake transport, failing the case rather than the
 * suite when construction is refused.
 *
 * The logger is a real {@link createConsoleLogger} with an injected sink, which
 * is the extension point the product itself uses — so what is captured here is
 * exactly what a host would receive, and the "nothing about a credential is
 * logged" assertions are statements about real records.
 */
function harness(options: HarnessOptions = {}): Harness {
  const transport = createTransport(options.script ?? {});
  const logs: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record: LogRecord): void => {
      logs.push(record);
    },
  });

  const created = createAnthropicProvider({
    config: options.config ?? BASE_CONFIG,
    client: transport.client,
    logger,
    ...(options.structuredOutputMode === undefined
      ? {}
      : { structuredOutputMode: options.structuredOutputMode }),
  });
  if (!created.ok) {
    throw new Error(
      `the provider refused construction: ${created.error.code} ${created.error.message}`,
    );
  }
  return { provider: created.value, transport, logs };
}

/* -------------------------------------------------------------------------------------------------
 * Assertions and narrowing
 * ---------------------------------------------------------------------------------------------- */

/** Unwraps an `Ok`, reporting the failure's code and message instead. */
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
 * Typed against `Result<unknown, …>` so one loop can check the failures of all
 * three methods together: their success types differ and only the failure is
 * being asserted.
 */
function errorOf(result: Result<unknown, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error(`expected Err, received Ok: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

/**
 * Asserts the failure vocabulary on one error, whatever produced it.
 *
 * Membership is checked against the imported tuple rather than a list written
 * here, which is what makes it mechanical: an invented code fails this even if
 * every other assertion about the failure passes.
 */
function expectCodedFailure(error: DebuggenError): void {
  expect(DebuggenError.is(error)).toBe(true);
  expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
  expect(error.message.length).toBeGreaterThan(0);
  expect(error.hint).toBeTypeOf('string');
}

/** Narrows an unknown value to a plain object, failing the case otherwise. */
function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/** Narrows an unknown value to an array, failing the case otherwise. */
function asArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected an array, received ${JSON.stringify(value)}`);
  }
  return value as readonly unknown[];
}

/** The one call a route was expected to make, failing the case when it was not one. */
function onlyCall(calls: readonly RecordedCall[], route: string): RecordedCall {
  expect(calls, `expected exactly one "${route}" call`).toHaveLength(1);
  const call = calls[0];
  if (call === undefined) {
    throw new Error(`no "${route}" call was recorded`);
  }
  return call;
}

/** The structured-output format of a recorded schema-constrained call. */
function outputFormatOf(call: RecordedCall): Record<string, unknown> {
  return asObject(asObject(call.params.output_config).format);
}

/** The tool declarations of a recorded call. */
function toolsOf(call: RecordedCall): readonly unknown[] {
  return asArray(call.params.tools);
}

/**
 * Everything a failure exposes, in one searchable string.
 *
 * `toPayload()` is included beside `message`, `hint` and `details` because that
 * is the object a user interface actually renders, and a leak that reached only
 * that would be the one that mattered most.
 */
function serialiseFailure(error: DebuggenError): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    hint: error.hint,
    details: error.details ?? {},
    payload: error.toPayload(),
  });
}

/** Everything a set of log records carries, in one searchable string. */
function serialiseLogs(records: readonly LogRecord[]): string {
  return JSON.stringify(records.map((record) => ({ message: record.message, ...record.fields })));
}

/**
 * Width of the sliding window {@link expectNoValueLeak} compares.
 *
 * A `toContain` on the whole value proves very little: a plausible disclosure
 * is a prefix, a suffix or a fragment. Eight code units is short enough to
 * catch a fragment anywhere inside a fixture and long enough not to collide
 * with ordinary prose.
 */
const LEAK_WINDOW = 8;

/**
 * Asserts that `text` carries no part of `secret` — not the whole value, not a
 * prefix, not any eight-character fragment.
 */
function expectNoValueLeak(text: string, secret: string): void {
  expect(text).not.toContain(secret);
  for (let index = 0; index + LEAK_WINDOW <= secret.length; index += 1) {
    expect(text).not.toContain(secret.slice(index, index + LEAK_WINDOW));
  }
}

/* -------------------------------------------------------------------------------------------------
 * Construction, configuration and the provider contract
 * ---------------------------------------------------------------------------------------------- */

describe('construction reports what it can and cannot do before any call is attempted', () => {
  it('reports its own id and satisfies the structural provider guard', () => {
    const { provider } = harness();

    expect(provider.id).toBe('anthropic');
    expect(PROVIDER_IDS).toContain(provider.id);
    expect(isModelProvider(provider)).toBe(true);
  });

  it('accepts an injected transport without a credential, and constructs none', () => {
    const constructedBefore = transportConstruction.options.length;
    const transport = createTransport();

    // No `apiKey` anywhere in the configuration: the credential belongs to
    // whoever supplied the client, which is what lets an offline suite exercise
    // every branch without inventing one.
    const created = createAnthropicProvider({ config: BASE_CONFIG, client: transport.client });

    expect(okValue(created).id).toBe('anthropic');
    expect(transportConstruction.options.length).toBe(constructedBefore);
  });

  it('refuses a configuration with no model, in the one shared sentence', () => {
    const error = errorOf(
      createAnthropicProvider({
        config: { providerId: 'anthropic', model: '   ' },
        client: createTransport().client,
      }),
    );

    expectCodedFailure(error);
    expect(error.code).toBe('CONFIG_INVALID');
    // Compared against the shared builder, never against a pasted sentence:
    // `../provider.ts` owns the wording and both boundaries must show the same
    // string for the same code.
    expect(error.message).toBe(modelUnavailableMessage(error.code));
    expect(error.hint).toContain('DEBUGGEN_MODEL');
    expect(asObject(error.details ?? {}).condition).toBe('model-not-configured');
  });

  it('refuses to build a transport without a credential, and builds none', () => {
    const constructedBefore = transportConstruction.options.length;

    const error = errorOf(createAnthropicProvider({ config: BASE_CONFIG }));

    expectCodedFailure(error);
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toBe(modelUnavailableMessage(error.code));
    expect(error.hint).toContain('ANTHROPIC_API_KEY');
    expect(asObject(error.details ?? {}).condition).toBe('api-key-not-configured');
    // The point of the count: a client is not built and then discarded, it is
    // never built at all.
    expect(transportConstruction.options.length).toBe(constructedBefore);
  });

  it('refuses a budget the messages API cannot accept, rather than substituting one', () => {
    const malformed: readonly ModelProviderConfig[] = [
      { ...BASE_CONFIG, maxTokens: 0 },
      { ...BASE_CONFIG, temperature: -1 },
      // A plausible sampling temperature, refused for the deprecation rather
      // than for its sign: the messages API accepts one value and rejects
      // every other with a 400, so a configuration carrying this would fail
      // every call of every stage in the session.
      { ...BASE_CONFIG, temperature: 0.7 },
      { ...BASE_CONFIG, timeoutMs: 1.5 },
      { ...BASE_CONFIG, maxRetries: -2 },
    ];

    for (const config of malformed) {
      const error = errorOf(createAnthropicProvider({ config, client: createTransport().client }));
      expectCodedFailure(error);
      expect(error.code).toBe('CONFIG_INVALID');
      expect(asObject(error.details ?? {}).condition).toBe('configuration-budget-invalid');
      // A budget failure is about the host's configuration, not about the
      // provider being unavailable, so it must not borrow that sentence.
      expect(error.message).not.toBe(modelUnavailableMessage(error.code));
    }
  });

  it('hands the transport retry budget to the transport it constructs, and never a repair budget', () => {
    // Deliberately different from the schema repair budget so the assertion
    // below distinguishes them: `maxRetries` governs re-sending a request that
    // never got an answer, while `DEFAULT_MAX_REPAIRS` governs re-asking after
    // an answer arrived and failed validation. They are counted in different
    // places and must never share a counter.
    const transportRetries = DEFAULT_MAX_REPAIRS + 3;
    const created = createAnthropicProvider({
      config: {
        ...BASE_CONFIG,
        apiKey: CREDENTIAL_FIXTURE,
        baseUrl: 'http://127.0.0.1:1/',
        maxRetries: transportRetries,
        timeoutMs: 4_321,
      },
    });

    expect(okValue(created).id).toBe('anthropic');

    const options = asObject(transportConstruction.options.at(-1));
    expect(options.apiKey).toBe(CREDENTIAL_FIXTURE);
    expect(options.baseURL).toBe('http://127.0.0.1:1/');
    expect(options.maxRetries).toBe(transportRetries);
    expect(options.maxRetries).not.toBe(DEFAULT_MAX_REPAIRS);
    expect(options.timeout).toBe(4_321);
  });

  it('builds the transport with explicit budgets when the configuration names none', () => {
    // The production wiring: `apps/local-service`'s configuration module
    // supplies a provider id, a model and a credential and nothing else, and
    // neither budget has an environment form. Left absent, the vendor client's
    // own defaults would decide how long one request may take and how often it
    // is re-sent — a product decision taken by a dependency and changed by a
    // version bump.
    const created = createAnthropicProvider({
      config: { ...BASE_CONFIG, apiKey: CREDENTIAL_FIXTURE },
    });

    expect(okValue(created).id).toBe('anthropic');

    const options = asObject(transportConstruction.options.at(-1));
    expect(options.timeout).toBe(ANTHROPIC_DEFAULT_TIMEOUT_MS);
    expect(options.maxRetries).toBe(ANTHROPIC_DEFAULT_MAX_RETRIES);
    // Present, not merely resolvable: a client constructed without the fields
    // is the state this case exists to rule out.
    expect(Object.keys(options)).toContain('timeout');
    expect(Object.keys(options)).toContain('maxRetries');
  });

  it('closes terminally: every later call is a coded failure and reaches no transport', async () => {
    const { provider, transport } = harness({ script: { create: answers(textAnswer('ignored')) } });
    if (!hasClose(provider)) {
      throw new Error('the network-backed provider must be disposable');
    }

    await provider.close();
    // Idempotent: closing twice is a state change that already happened.
    await provider.close();

    const request = makeRequest();
    const failures: readonly DebuggenError[] = [
      errorOf(await provider.generateText(request)),
      errorOf(await provider.generateStructured(answerSchema, request)),
      errorOf(await provider.callTools(request, [])),
    ];

    for (const failure of failures) {
      expectCodedFailure(failure);
      expect(failure.code).toBe('MODEL_UNAVAILABLE');
      expect(failure.message).toBe(modelUnavailableMessage(failure.code));
      expect(asObject(failure.details ?? {}).condition).toBe('provider-closed');
    }
    expect(transport.callCount).toBe(0);
  });

  it('declares a transport seam the real client satisfies by assignment', () => {
    // A compile-time proof with no instance: if the seam narrowed to something
    // the vendor's client no longer satisfies, this stops compiling under
    // `pnpm typecheck` — which is where that regression should be caught, since
    // constructing a real client in a suite is exactly what this file forbids.
    const seamCheck = (client: AnthropicClient): AnthropicClientLike => client;
    const fake: AnthropicClientLike = createTransport().client;

    expect(seamCheck).toBeTypeOf('function');
    // Asked as a capability rather than by reading the method off the object:
    // presence is what the seam is about, and an unbound method reference is
    // what `./anthropic.ts` binds deliberately before it calls one.
    expect('create' in fake.messages).toBe(true);
    // The schema-constrained capability is optional on the seam, which is what
    // lets a fake omit it to drive the tool route.
    expect('parse' in fake.messages).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The schema-constrained route
 * ---------------------------------------------------------------------------------------------- */

describe('the schema-constrained route asks with the rendered format and reports what came back', () => {
  it('sends the format the platform helper rendered and reports the decoded output as raw', async () => {
    const { provider, transport } = harness({
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    const attempt = okValue(await provider.generateStructured(answerSchema, makeRequest()));

    // `raw` is the single input to the authoritative validation in
    // `../structured.ts`, so an attempt without it breaks the repair mechanism
    // outright — this is the assertion that keeps it populated.
    expect(attempt.raw).toEqual(VALID_ANSWER);
    expect(attempt.value).toEqual(VALID_ANSWER);
    expect(attempt.providerId).toBe('anthropic');
    expect(attempt.model).toBe(REPORTED_MODEL_PLACEHOLDER);
    expect(attempt.text).toBe(JSON.stringify(VALID_ANSWER));
    expect(attempt.usage).toEqual({ inputTokens: 128, outputTokens: 64 });
    expect(attempt.stopReason).toBe('end_turn');

    const call = onlyCall(transport.parseCalls, 'parse');
    const format = outputFormatOf(call);
    expect(format.type).toBe('json_schema');
    // Proof that `zodOutputFormat` was actually used: the schema sent is the
    // helper's own rendering of the caller's schema, keyword stripping and all.
    expect(format.schema).toEqual(zodOutputFormat(answerSchema).schema);
    expect(transport.createCalls).toHaveLength(0);
  });

  it('replaces the helper\u2019s throwing decoder with a total one', async () => {
    const { provider, transport } = harness({
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    okValue(await provider.generateStructured(answerSchema, makeRequest()));

    const decoder = outputFormatOf(onlyCall(transport.parseCalls, 'parse')).parse;
    expect(decoder).toBeTypeOf('function');
    // The helper's own callback runs the caller's schema and throws on a miss,
    // and the software development kit invokes it on every text block. A throw
    // there would destroy the decoded output the repair loop needs, so the
    // format this provider sends carries a decoder that answers `null` instead.
    expect((decoder as (content: string) => unknown)('not json at all')).toBeNull();
  });

  it('reads the helper\u2019s decoded output when the answer carried no text', async () => {
    const { provider, transport } = harness({
      script: { parse: answers({ content: [], parsed_output: VALID_ANSWER }) },
    });

    const attempt = okValue(await provider.generateStructured(answerSchema, makeRequest()));

    expect(attempt.raw).toEqual(VALID_ANSWER);
    expect(attempt.value).toEqual(VALID_ANSWER);
    expect(attempt.text).toBeUndefined();
    // Output arrived, so there is nothing for the fallback to do.
    expect(transport.createCalls).toHaveLength(0);
  });

  it('reports a decode failure as an ordinary answer with the text and no raw', async () => {
    const { provider, transport } = harness({
      script: { parse: answers(textAnswer('I could not produce that shape.')) },
    });

    const attempt = okValue(await provider.generateStructured(answerSchema, makeRequest()));

    // `raw` absent while `text` is present is exactly how `../types.ts` marks a
    // decode failure, and `../structured.ts` classifies it from that pair.
    expect(attempt.raw).toBeUndefined();
    expect(attempt.text).toBe('I could not produce that shape.');
    expect(transport.parseCalls).toHaveLength(1);
    expect(transport.createCalls).toHaveLength(0);
  });

  it('builds the request the messages API requires, letting the call override the configuration', async () => {
    const { provider, transport } = harness({
      config: { ...BASE_CONFIG, maxTokens: 4_096 },
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    okValue(
      await provider.generateStructured(
        answerSchema,
        makeRequest({ system: CLEAN_SYSTEM, maxTokens: 512 }),
      ),
    );

    const { params } = onlyCall(transport.parseCalls, 'parse');
    // The configured model is the only source of one: there is no literal to
    // fall back to anywhere in the product.
    expect(params.model).toBe(MODEL_PLACEHOLDER);
    expect(params.max_tokens).toBe(512);
    expect(params.system).toBe(CLEAN_SYSTEM);
    expect(params.messages.map((turn) => turn.role)).toEqual(['user']);
    expect(params.messages.at(0)?.content).toBe(CLEAN_PROMPT);
  });

  it('never sends the deprecated sampling temperature, even when one is asked for', async () => {
    const { provider, transport } = harness({
      // The one value the messages API still tolerates, from both sources at
      // once. It is also the API's own default, so accepting it and sending
      // nothing is behaviourally identical to sending it.
      config: { ...BASE_CONFIG, temperature: ANTHROPIC_SUPPORTED_TEMPERATURE },
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    okValue(
      await provider.generateStructured(
        answerSchema,
        makeRequest({ temperature: ANTHROPIC_SUPPORTED_TEMPERATURE }),
      ),
    );

    const { params } = onlyCall(transport.parseCalls, 'parse');
    expect(params.temperature).toBeUndefined();
    expect('temperature' in params).toBe(false);
  });

  it('sends a response-length bound even when neither the call nor the configuration names one', async () => {
    const { provider, transport } = harness({
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    okValue(await provider.generateStructured(answerSchema, makeRequest()));

    const { params } = onlyCall(transport.parseCalls, 'parse');
    // The messages API requires the field while both sources of it are
    // optional, so a bound has to come from somewhere; its value is a request
    // budget rather than a property of any model, so only its shape is pinned.
    expect(Number.isInteger(params.max_tokens)).toBe(true);
    expect(params.max_tokens).toBeGreaterThan(0);
    expect(params.temperature).toBeUndefined();
    expect(params.system).toBeUndefined();
  });

  it('orders one prompt against the prior turns it belongs with', async () => {
    const { provider, transport } = harness({
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    // A repair request, as `../structured.ts` builds one: the prompt is the task
    // those correction turns correct, so it belongs first.
    const repair = buildRepairRequest(makeRequest(), 'count: expected at least 2', 1);
    okValue(await provider.generateStructured(answerSchema, repair));
    const repairTurns = onlyCall(transport.parseCalls, 'parse').params.messages;
    expect(repairTurns.at(0)?.content).toBe(CLEAN_PROMPT);
    expect(repairTurns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);

    transport.reset();

    // A follow-up carries the earlier exchange, oldest first, and its prompt is
    // the new instruction, so the prompt belongs last.
    const exchange: readonly ModelMessage[] = [
      { role: 'user', content: 'What did the earlier capture show?' },
      { role: 'assistant', content: 'The outer call dominated the interaction.' },
    ];
    okValue(await provider.generateStructured(answerSchema, makeRequest({ messages: exchange })));
    const followUpTurns = onlyCall(transport.parseCalls, 'parse').params.messages;
    expect(followUpTurns.at(-1)?.content).toBe(CLEAN_PROMPT);
    expect(followUpTurns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('keeps a correction after the prompt when the call already carried an exchange', async () => {
    const { provider, transport } = harness({
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    // The combination the product actually reaches: a follow-up stage carries
    // the earlier exchange, its answer fails the schema, and `../structured.ts`
    // appends the correction to those same prior turns. The prompt is the task
    // the correction corrects, so it must come *before* the correction and
    // *after* the exchange — a rule keyed on the first prior turn's role puts
    // it last, telling the model to fix an answer to a task it has not been
    // given yet.
    const exchange: readonly ModelMessage[] = [
      { role: 'user', content: 'What did the earlier capture show?' },
      { role: 'assistant', content: 'The outer call dominated the interaction.' },
    ];
    const repairedFollowUp = buildRepairRequest(
      makeRequest({ messages: exchange }),
      'count: expected at least 2',
      1,
    );

    okValue(await provider.generateStructured(answerSchema, repairedFollowUp));

    const turns = onlyCall(transport.parseCalls, 'parse').params.messages;
    const contents = turns.map((turn) => turn.content);
    expect(turns.map((turn) => turn.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(contents.at(0)).toBe(exchange.at(0)?.content);
    expect(contents.at(1)).toBe(exchange.at(1)?.content);
    expect(contents.at(2)).toBe(CLEAN_PROMPT);
    expect(contents.at(3)).toBe(REPAIR_ASSISTANT_NOTICE);
    // The correcting instruction quotes the validation errors, so it is the
    // last turn and the prompt precedes it rather than following it.
    expect(contents.at(4)).toContain('count');
    expect(contents.indexOf(CLEAN_PROMPT)).toBeLessThan(contents.indexOf(REPAIR_ASSISTANT_NOTICE));
  });

  it('opens the conversation with a user turn when a prior exchange cannot', async () => {
    const { provider, transport } = harness({
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    // Neither documented shape, so it is a caller defect — but the messages API
    // expects the first turn to be a user turn, so the prompt leads rather than
    // the request being sent in a form the provider would refuse.
    const assistantFirst: readonly ModelMessage[] = [
      { role: 'assistant', content: 'The outer call dominated the interaction.' },
      { role: 'user', content: 'And the database?' },
    ];

    okValue(
      await provider.generateStructured(answerSchema, makeRequest({ messages: assistantFirst })),
    );

    const turns = onlyCall(transport.parseCalls, 'parse').params.messages;
    expect(turns.at(0)?.role).toBe('user');
    expect(turns.at(0)?.content).toBe(CLEAN_PROMPT);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('reports a failure, not a fallback, when the route is pinned and cannot serve the call', async () => {
    const { provider, transport } = harness({
      structuredOutputMode: 'parse-only',
      script: { create: answers(toolUseAnswer('structured_output_analyze', VALID_ANSWER)) },
    });

    const error = errorOf(await provider.generateStructured(answerSchema, makeRequest()));

    expectCodedFailure(error);
    expect(error.code).toBe('INTERNAL');
    expect(asObject(error.details ?? {}).condition).toBe('parse-route-unavailable');
    // Pinned means pinned: the other route is not tried behind the caller's back.
    expect(transport.callCount).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The forced tool fallback
 * ---------------------------------------------------------------------------------------------- */

describe('the forced tool route serves the calls the schema-constrained route cannot', () => {
  /** The tool name the fallback derives from the calling stage. */
  const TOOL_NAME = 'structured_output_analyze';

  /**
   * Asserts one forced-tool request: a single tool carrying the schema as its
   * argument schema, and a choice that forces it.
   */
  function expectForcedToolCall(transport: FakeTransport): void {
    const call = onlyCall(transport.createCalls, 'create');
    const tools = toolsOf(call);
    expect(tools).toHaveLength(1);
    const tool = asObject(tools.at(0));
    expect(tool.name).toBe(TOOL_NAME);
    expect(asObject(tool.input_schema).type).toBe('object');
    expect(call.params.tool_choice).toEqual({
      type: 'tool',
      name: TOOL_NAME,
      disable_parallel_tool_use: true,
    });
    expect(call.params.output_config).toBeUndefined();
  }

  it('falls back when the client offers no schema-constrained capability', async () => {
    const { provider, transport } = harness({
      script: { create: answers(toolUseAnswer(TOOL_NAME, VALID_ANSWER)) },
    });

    const attempt = okValue(await provider.generateStructured(answerSchema, makeRequest()));

    expect(attempt.raw).toEqual(VALID_ANSWER);
    expect(attempt.value).toEqual(VALID_ANSWER);
    expect(transport.parseCalls).toHaveLength(0);
    expectForcedToolCall(transport);
  });

  it('falls back when the platform refuses the output format', async () => {
    const { provider, transport } = harness({
      script: {
        parse: rejects(
          new ScriptedTransportError(400, 'output_config.format is not supported for this model'),
        ),
        create: answers(toolUseAnswer(TOOL_NAME, VALID_ANSWER)),
      },
    });

    const attempt = okValue(await provider.generateStructured(answerSchema, makeRequest()));

    expect(attempt.raw).toEqual(VALID_ANSWER);
    expect(transport.parseCalls).toHaveLength(1);
    expectForcedToolCall(transport);
  });

  it.each([
    'The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.',
    'Schemas contains too many optional parameters (28), which would make grammar compilation inefficient. Reduce the number of optional parameters in your tool schemas (limit: 24).',
    'Schema is too complex for compilation.',
  ])(
    'falls back when the platform refuses to compile the schema into a grammar: %s',
    async (report) => {
      const { provider, transport } = harness({
        script: {
          parse: rejects(new ScriptedTransportError(400, report)),
          create: answers(toolUseAnswer(TOOL_NAME, VALID_ANSWER)),
        },
      });

      const attempt = okValue(await provider.generateStructured(answerSchema, makeRequest()));

      // The strict route compiles a grammar and the forced tool route does not,
      // so the refusal is a reason to ask once more, through the tool.
      expect(attempt.raw).toEqual(VALID_ANSWER);
      expect(attempt.value).toEqual(VALID_ANSWER);
      expect(transport.parseCalls).toHaveLength(1);
      expectForcedToolCall(transport);
    },
  );

  it('does not fall back on a 400 that says nothing about the output format', async () => {
    const { provider, transport } = harness({
      script: {
        parse: rejects(new ScriptedTransportError(400, 'max_tokens: must be a positive integer')),
        create: answers(toolUseAnswer(TOOL_NAME, VALID_ANSWER)),
      },
    });

    const error = errorOf(await provider.generateStructured(answerSchema, makeRequest()));

    expectCodedFailure(error);
    expect(error.code).toBe('MODEL_UNAVAILABLE');
    expect(asObject(error.details ?? {}).condition).toBe('refused');
    expect(transport.parseCalls).toHaveLength(1);
    expect(transport.createCalls).toHaveLength(0);
  });

  it('falls back when the schema cannot be rendered as an output format', async () => {
    const { provider, transport } = harness({
      script: {
        parse: answers(structuredAnswer(VALID_ANSWER)),
        create: answers(toolUseAnswer(TOOL_NAME, VALID_ANSWER)),
      },
    });

    const attempt = okValue(
      await provider.generateStructured(transformedAnswerSchema, makeRequest()),
    );

    // The format renderer refuses a transform, so the request is never sent on
    // that route; the tool route renders the schema's *input* side with
    // unrepresentable constructs widened, and serves the call.
    expect(transport.parseCalls).toHaveLength(0);
    expect(attempt.raw).toEqual(VALID_ANSWER);
    expect(attempt.value).toEqual({ ...VALID_ANSWER, doubled: VALID_ANSWER.count * 2 });
    expectForcedToolCall(transport);
  });

  it('falls back when the schema-constrained answer carried nothing at all', async () => {
    const { provider, transport } = harness({
      script: {
        parse: answers(EMPTY_ANSWER),
        create: answers(toolUseAnswer(TOOL_NAME, VALID_ANSWER)),
      },
    });

    const attempt = okValue(await provider.generateStructured(answerSchema, makeRequest()));

    expect(transport.parseCalls).toHaveLength(1);
    expect(attempt.raw).toEqual(VALID_ANSWER);
    expectForcedToolCall(transport);
  });

  it('does not fall back on a transport failure', async () => {
    const { provider, transport } = harness({
      script: {
        parse: rejects(new ScriptedTransportError(429, 'rate limit exceeded')),
        create: answers(toolUseAnswer(TOOL_NAME, VALID_ANSWER)),
      },
    });

    const error = errorOf(await provider.generateStructured(answerSchema, makeRequest()));

    expectCodedFailure(error);
    expect(error.code).toBe('MODEL_UNAVAILABLE');
    // A quota failure has nothing to do with the output format, so spending a
    // second request on the other route would spend it for nothing.
    expect(transport.parseCalls).toHaveLength(1);
    expect(transport.createCalls).toHaveLength(0);
  });

  it('does not fall back on a schema mismatch: that belongs to the validation loop', async () => {
    const { provider, transport } = harness({
      script: {
        parse: answers(structuredAnswer(BOUND_VIOLATING_ANSWER)),
        create: answers(toolUseAnswer(TOOL_NAME, VALID_ANSWER)),
      },
    });

    const attempt = okValue(await provider.generateStructured(answerSchema, makeRequest()));

    expect(attempt.raw).toEqual(BOUND_VIOLATING_ANSWER);
    expect(attempt.value).toBeUndefined();
    expect(transport.createCalls).toHaveLength(0);
    expect(transport.callCount).toBe(1);
  });

  it('reads a tool call the model named differently, and reports none when it called none', async () => {
    const renamed = harness({
      script: { create: answers(toolUseAnswer('some_other_tool', VALID_ANSWER)) },
    });
    const fromRenamed = okValue(
      await renamed.provider.generateStructured(answerSchema, makeRequest()),
    );
    // The arguments are what was asked for; refusing them over a name would
    // waste an answer. The mismatch is logged instead.
    expect(fromRenamed.raw).toEqual(VALID_ANSWER);
    expect(renamed.logs.some((record) => record.fields.calledTool === 'some_other_tool')).toBe(
      true,
    );

    const textOnly = harness({ script: { create: answers(textAnswer('no tool for me')) } });
    const fromTextOnly = okValue(
      await textOnly.provider.generateStructured(answerSchema, makeRequest()),
    );
    expect(fromTextOnly.raw).toBeUndefined();
    expect(fromTextOnly.text).toBe('no tool for me');
  });

  it('refuses a schema whose root is not an object', async () => {
    const { provider, transport } = harness({ structuredOutputMode: 'tool-only' });

    const error = errorOf(await provider.generateStructured(scalarAnswerSchema, makeRequest()));

    expectCodedFailure(error);
    expect(error.code).toBe('INTERNAL');
    expect(asObject(error.details ?? {}).condition).toBe('schema-not-an-object');
    expect(transport.callCount).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Post-parse re-validation, and the boundary it protects
 *
 * AAP §0.2.4 records the mechanism that makes this block necessary: the
 * platform's structured-output helper strips the JSON-Schema keywords its
 * format does not support, so a numeric bound or a refinement can survive
 * generation unchecked. `./anthropic.ts` therefore runs the caller's schema
 * itself — and the *only* effect of a miss on the returned value is that
 * `value` is absent, because `../structured.ts` is the authoritative gate and
 * an attempt without `raw` would leave it nothing to validate or repair.
 * ---------------------------------------------------------------------------------------------- */

describe('post-parse re-validation keeps a reported value honest', () => {
  it('the rendered format drops the numeric bound, which is why the answer is re-validated here', () => {
    const rendered = asObject(zodOutputFormat(answerSchema).schema);
    const bounded = asObject(asObject(rendered.properties).count);

    // Not a defect to work around: the bound the caller declared simply does
    // not reach what constrains generation, which is the whole reason the
    // provider parses the answer again on this side of the transport.
    expect(bounded.minimum).toBeUndefined();
    expect(answerSchema.safeParse(BOUND_VIOLATING_ANSWER).success).toBe(false);
  });

  it('answers Ok with raw intact and value absent when the answer violates the bound', async () => {
    const { provider, transport } = harness({
      script: { parse: answers(structuredAnswer(BOUND_VIOLATING_ANSWER)) },
    });

    const result = await provider.generateStructured(answerSchema, makeRequest());

    // Ok, deliberately, and this assertion must not be "corrected" to Err:
    // `../structured.test.ts` pins that a provider-level Err short-circuits the
    // repair loop WITHOUT consuming repair budget, so answering an ordinary bad
    // artifact with an Err would deny the stage the two repair attempts
    // (DEFAULT_MAX_REPAIRS) that exist precisely for it.
    expect(result.ok).toBe(true);
    expect(DEFAULT_MAX_REPAIRS).toBeGreaterThan(0);

    const attempt = okValue(result);
    expect(attempt.raw).toEqual(BOUND_VIOLATING_ANSWER);
    expect(attempt.value).toBeUndefined();
    expect(attempt.text).toBe(JSON.stringify(BOUND_VIOLATING_ANSWER));
    // One call, one attempt: no internal repair loop lives here.
    expect(transport.callCount).toBe(1);
  });

  it('takes exactly one attempt for a retryable-shaped rejection', async () => {
    const { provider, transport } = harness({
      script: { parse: rejects(new ScriptedTransportError(503, 'upstream unavailable')) },
    });

    const error = errorOf(await provider.generateStructured(answerSchema, makeRequest()));

    expectCodedFailure(error);
    // Re-sending a request that never got an answer is the software development
    // kit's business, governed by `ModelProviderConfig.maxRetries` on the client
    // it was handed. This provider re-sends nothing itself, and that budget is
    // never the schema repair budget.
    expect(transport.callCount).toBe(1);
  });

  it('logs the failing field paths and never the answer it rejected', async () => {
    const { provider, logs } = harness({
      script: { parse: answers(structuredAnswer(BOUND_VIOLATING_ANSWER)) },
    });

    okValue(await provider.generateStructured(answerSchema, makeRequest()));

    const miss = logs.find((record) => record.fields.issuePaths !== undefined);
    expect(miss?.level).toBe('warn');
    expect(asArray(miss?.fields.issuePaths)).toEqual(['count']);
    expect(miss?.fields.issueCount).toBe(1);
    expect(miss?.fields.stage).toBe('analyze');
    expect(miss?.fields.promptVersion).toBe(PROMPT_VERSION);
    // Paths and counts only: a log record carries no value from the answer,
    // because a rejected answer is exactly the case where an upstream
    // assumption about the payload did not hold.
    expect(serialiseLogs(logs)).not.toContain(BOUND_VIOLATING_ANSWER.label);
  });

  it('logs a schema that throws with its closed code only, never the thrown message', async () => {
    const quoted = 'zzq-refinement-quoted-marker';
    const throwingSchema = answerSchema.superRefine(() => {
      throw new Error(`the refinement read ${quoted} from the answer`);
    });
    const { provider, logs } = harness({
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    const attempt = okValue(await provider.generateStructured(throwingSchema, makeRequest()));

    // The answer is still reported for the authoritative loop to judge.
    expect(attempt.raw).toEqual(VALID_ANSWER);
    expect(attempt.value).toBeUndefined();
    const threw = logs.find((record) => record.message.includes('schema threw'));
    expect(threw?.level).toBe('error');
    expect(threw?.fields.code).toBe('INTERNAL');
    expect(threw?.fields.error).toBeUndefined();
    expect(serialiseLogs(logs)).not.toContain(quoted);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Free text
 * ---------------------------------------------------------------------------------------------- */

describe('generateText answers with prose or says it received none', () => {
  it('concatenates every text block and maps the accounting the provider reported', async () => {
    const { provider, transport } = harness({
      script: {
        create: answers({
          model: REPORTED_MODEL_PLACEHOLDER,
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'The outer call dominated ' },
            {
              type: 'tool_use',
              id: assemble('call_', cycle(HEX_CHARS, 6)),
              name: 'ignored',
              input: {},
            },
            { type: 'text', text: 'the interaction.' },
          ],
          usage: { input_tokens: 40, output_tokens: 12 },
        }),
      },
    });

    const response = okValue(await provider.generateText(makeRequest()));

    expect(response.text).toBe('The outer call dominated the interaction.');
    expect(response.model).toBe(REPORTED_MODEL_PLACEHOLDER);
    expect(response.providerId).toBe('anthropic');
    expect(response.stopReason).toBe('end_turn');
    expect(response.usage).toEqual({ inputTokens: 40, outputTokens: 12 });
    // No computed sum: an accounting that may include tokens in neither field
    // would be misreported by one.
    expect(response.usage?.totalTokens).toBeUndefined();

    const { params } = onlyCall(transport.createCalls, 'create');
    expect(params.tools).toBeUndefined();
    expect(params.output_config).toBeUndefined();
  });

  it('reports the configured model when the answer names none', async () => {
    const { provider } = harness({
      script: { create: answers({ content: [{ type: 'text', text: 'a plain answer' }] }) },
    });

    const response = okValue(await provider.generateText(makeRequest()));

    expect(response.model).toBe(MODEL_PLACEHOLDER);
    expect(response.usage).toBeUndefined();
    expect(response.stopReason).toBeUndefined();
  });

  it('reports unknown accounting as absent rather than as zero', async () => {
    const { provider } = harness({
      script: {
        create: answers({
          content: [{ type: 'text', text: 'a plain answer' }],
          usage: { input_tokens: 5 },
        }),
      },
    });

    expect(okValue(await provider.generateText(makeRequest())).usage).toBeUndefined();
  });

  it('treats an answer with no text as a malformed response rather than an empty success', async () => {
    const withoutText: readonly AnthropicMessageLike[] = [
      EMPTY_ANSWER,
      { content: [{ type: 'text' }] },
      { content: [{ type: 'tool_use', id: 'call_1', name: 'ignored', input: {} }] },
    ];

    for (const message of withoutText) {
      const { provider } = harness({ script: { create: answers(message) } });
      const error = errorOf(await provider.generateText(makeRequest()));

      expectCodedFailure(error);
      expect(error.code).toBe('MODEL_OUTPUT_INVALID');
      expect(asObject(error.details ?? {}).condition).toBe('no-text-content');
      // A stage that asked for prose and received none has nothing to work
      // with, and `''` would travel on as if it did.
      expect(error.message).not.toBe(modelUnavailableMessage(error.code));
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Tool calls, which are requests and never actions
 * ---------------------------------------------------------------------------------------------- */

describe('callTools returns the calls the model asked for and executes nothing', () => {
  it('reports every usable tool-use block, in order, with its arguments unaltered', async () => {
    const lookupSchema = z.object({ symbol: z.string() });
    const traceSchema = z.object({ from: z.string(), to: z.string() });
    // Standing in for the execution `apps/local-service` owns: if the provider
    // ran anything at all, this would be the thing it ran.
    const execute = vi.fn();
    const safeParseSpy = vi.spyOn(lookupSchema, 'safeParse');
    const parseSpy = vi.spyOn(lookupSchema, 'parse');

    const tools: readonly ToolDefinition[] = [
      {
        name: 'lookupSymbol',
        description: 'read-only lookup over an existing index',
        inputSchema: lookupSchema,
      },
      {
        name: 'tracePath',
        description: 'read-only path search over an existing index',
        inputSchema: traceSchema,
      },
    ];

    const { provider, transport, logs } = harness({
      script: {
        create: answers({
          model: REPORTED_MODEL_PLACEHOLDER,
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Two lookups, please.' },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'lookupSymbol',
              input: { symbol: 'outerCall' },
            },
            { type: 'tool_use', id: 'call_2', name: 'tracePath', input: { from: 'a', to: 'b' } },
            { type: 'tool_use', name: 'lookupSymbol', input: { symbol: 'noIdentity' } },
            { type: 'tool_use', id: 'call_4', name: 'neverDeclared', input: {} },
          ],
          usage: { input_tokens: 21, output_tokens: 9 },
        }),
      },
    });

    try {
      const response = okValue(
        await provider.callTools(makeRequest({ stage: 'investigate' }), tools),
      );

      // The block with no id is skipped rather than reported with an invented
      // one; the undeclared name is reported as it arrived, because only the
      // caller knows what it declared.
      expect(response.calls.map((call) => call.name)).toEqual([
        'lookupSymbol',
        'tracePath',
        'neverDeclared',
      ]);
      expect(response.calls.map((call) => call.id)).toEqual(['call_1', 'call_2', 'call_4']);
      expect(response.calls.at(0)?.input).toEqual({ symbol: 'outerCall' });
      expect(response.calls.at(1)?.input).toEqual({ from: 'a', to: 'b' });
      expect(response.text).toBe('Two lookups, please.');
      expect(response.usage).toEqual({ inputTokens: 21, outputTokens: 9 });
      expect(response.providerId).toBe('anthropic');

      // Nothing was executed and nothing was validated: a tool is a
      // declaration here, and execution belongs to the service's read-only
      // code-graph queries.
      expect(execute).not.toHaveBeenCalled();
      expect(safeParseSpy).not.toHaveBeenCalled();
      expect(parseSpy).not.toHaveBeenCalled();

      const call = onlyCall(transport.createCalls, 'create');
      expect(toolsOf(call).map((tool) => asObject(tool).name)).toEqual([
        'lookupSymbol',
        'tracePath',
      ]);
      expect(call.params.tool_choice).toEqual({ type: 'auto' });
      expect(logs.some((record) => record.fields.calledTool === 'neverDeclared')).toBe(true);
    } finally {
      safeParseSpy.mockRestore();
      parseSpy.mockRestore();
    }
  });

  it('sends no tool list when the caller declared none', async () => {
    const { provider, transport, logs } = harness({
      script: { create: answers(textAnswer('nothing to call')) },
    });

    const response = okValue(await provider.callTools(makeRequest(), []));

    expect(response.calls).toEqual([]);
    const { params } = onlyCall(transport.createCalls, 'create');
    expect(params.tools).toBeUndefined();
    expect(params.tool_choice).toBeUndefined();
    expect(logs.some((record) => record.level === 'debug')).toBe(true);
  });

  it('refuses a declared tool whose argument schema cannot be rendered for a model', async () => {
    const { provider, transport } = harness({
      script: { create: answers(textAnswer('never reached')) },
    });

    const error = errorOf(
      await provider.callTools(makeRequest(), [
        { name: 'lookupSymbol', description: 'read-only lookup', inputSchema: scalarAnswerSchema },
      ]),
    );

    expectCodedFailure(error);
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('lookupSymbol');
    expect(asObject(error.details ?? {}).condition).toBe('tool-schema-unrenderable');
    expect(transport.callCount).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Cancellation and the one channel it travels on
 * ---------------------------------------------------------------------------------------------- */

describe('an abandoned call is refused rather than spent', () => {
  it('refuses a pre-aborted call before any transport call', async () => {
    const { provider, transport } = harness({
      script: {
        parse: answers(structuredAnswer(VALID_ANSWER)),
        create: answers(textAnswer('never reached')),
      },
    });
    const request = makeRequest({ signal: AbortSignal.abort() });

    const failures: readonly DebuggenError[] = [
      errorOf(await provider.generateText(request)),
      errorOf(await provider.generateStructured(answerSchema, request)),
      errorOf(await provider.callTools(request, [])),
    ];

    for (const failure of failures) {
      expectCodedFailure(failure);
      expect(failure.code).toBe('MODEL_UNAVAILABLE');
      expect(failure.message).toBe(modelUnavailableMessage(failure.code));
      expect(asObject(failure.details ?? {}).condition).toBe('cancelled');
    }
    // A request spent on abandoned work is a request a developer waits for.
    expect(transport.callCount).toBe(0);
  });

  it('forwards a live signal and the configured timeout in the request options', async () => {
    const controller = new AbortController();
    const { provider, transport } = harness({
      config: { ...BASE_CONFIG, timeoutMs: 7_777 },
      script: { create: answers(textAnswer('an answer')) },
    });

    okValue(await provider.generateText(makeRequest({ signal: controller.signal })));

    const { options } = onlyCall(transport.createCalls, 'create');
    // The same signal object, not a copy: an in-flight call has to be
    // cancellable rather than merely abandoned.
    expect(options?.signal).toBe(controller.signal);
    expect(options?.timeout).toBe(7_777);
    expect(controller.signal.aborted).toBe(false);
  });

  it('classifies a transport cancellation as cancelled rather than as a provider fault', async () => {
    const cancellations: readonly unknown[] = [
      // Recognised by identity, which is why the actual class is kept by the
      // module mock at the top of this file.
      new APIUserAbortError(),
      namedAbortError('AbortError'),
      namedAbortError('TimeoutError'),
    ];

    for (const thrown of cancellations) {
      const { provider } = harness({ script: { create: rejects(thrown) } });
      const error = errorOf(await provider.generateText(makeRequest()));

      expectCodedFailure(error);
      expect(error.code).toBe('MODEL_UNAVAILABLE');
      expect(asObject(error.details ?? {}).condition).toBe('cancelled');
      expect(error.cause).toBe(thrown);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The failure vocabulary
 * ---------------------------------------------------------------------------------------------- */

describe('every failure is a coded DebuggenError, and nothing throws', () => {
  /** One transport failure and the condition label it must be reported under. */
  interface TransportFailureCase {
    readonly label: string;
    readonly thrown: ScriptedTransportError;
    readonly condition: string;
    readonly status: number | undefined;
  }

  const TRANSPORT_FAILURES: readonly TransportFailureCase[] = [
    {
      label: 'a rejected credential',
      thrown: new ScriptedTransportError(401, 'authentication failed'),
      condition: 'unauthorized',
      status: 401,
    },
    {
      label: 'a credential without access to this model',
      thrown: new ScriptedTransportError(403, 'not permitted'),
      condition: 'unauthorized',
      status: 403,
    },
    {
      label: 'an exhausted quota',
      thrown: new ScriptedTransportError(429, 'rate limit exceeded'),
      condition: 'quota-exhausted',
      status: 429,
    },
    {
      label: 'a provider-side failure',
      thrown: new ScriptedTransportError(502, 'bad gateway'),
      condition: 'provider-error',
      status: 502,
    },
    {
      label: 'a refused request',
      thrown: new ScriptedTransportError(400, 'max_tokens is too large for this model'),
      condition: 'refused',
      status: 400,
    },
    {
      label: 'a call that never reached the provider',
      thrown: unreachableError(),
      condition: 'unreachable',
      status: undefined,
    },
  ];

  for (const failureCase of TRANSPORT_FAILURES) {
    it(`reports ${failureCase.label} as an unavailable provider, with the condition in its details`, async () => {
      const { provider, transport } = harness({ script: { create: rejects(failureCase.thrown) } });

      const settled = await provider.generateText(makeRequest());
      // Resolved, not rejected: a provider never throws for an expected
      // outcome, whatever the transport did.
      expect(settled.ok).toBe(false);

      const error = errorOf(settled);
      expectCodedFailure(error);
      expect(error.code).toBe('MODEL_UNAVAILABLE');
      expect(error.message).toBe(modelUnavailableMessage(error.code));
      const details = asObject(error.details ?? {});
      expect(details.condition).toBe(failureCase.condition);
      expect(details.status).toBe(failureCase.status);
      // The identifier a provider's support would ask for, and the only thing
      // from the provider's own report that travels.
      expect(details.providerRequestId).toBe(PROVIDER_REQUEST_ID);
      expect(error.cause).toBe(failureCase.thrown);
      expect(transport.callCount).toBe(1);

      // The provider's report may quote anything it likes from the request it
      // refused, so it stays in `cause` — which `toPayload` excludes — and
      // reaches no message, hint or details field.
      const rendered = serialiseFailure(error);
      expect(rendered).not.toContain(PROVIDER_REPORT_SENTINEL);
      expectNoValueLeak(rendered, CREDENTIAL_FIXTURE);
      expect(Object.keys(error.toPayload()).sort()).toEqual(['code', 'hint', 'message']);
    });
  }

  it('never rejects, whatever a transport throws', async () => {
    const hostile: readonly unknown[] = [
      'a rejected string',
      0,
      null,
      undefined,
      { status: 'nope' },
    ];

    for (const thrown of hostile) {
      const { provider } = harness({ script: { create: rejects(thrown) } });
      const settled = await provider.generateText(makeRequest());
      expect(settled.ok).toBe(false);
      expectCodedFailure(errorOf(settled));
    }
  });

  it('refuses a per-call budget the messages API cannot accept', async () => {
    const { provider, transport } = harness({ script: { create: answers(textAnswer('unused')) } });

    const tooSmall = errorOf(await provider.generateText(makeRequest({ maxTokens: 0 })));
    expect(tooSmall.code).toBe('CONFIG_INVALID');
    expect(asObject(tooSmall.details ?? {}).condition).toBe('max-tokens-invalid');

    const negative = errorOf(await provider.generateText(makeRequest({ temperature: -0.5 })));
    expect(negative.code).toBe('CONFIG_INVALID');
    expect(asObject(negative.details ?? {}).condition).toBe('temperature-invalid');

    // A sampling temperature a caller would plausibly ask for. The provider
    // would answer 400 to it — to *every* call, not one — so it is refused
    // here, and the hint names the deprecation rather than sending the
    // developer to check a credential.
    const unsupported = errorOf(await provider.generateText(makeRequest({ temperature: 0.2 })));
    expect(unsupported.code).toBe('CONFIG_INVALID');
    expect(asObject(unsupported.details ?? {}).condition).toBe('temperature-invalid');
    expect(unsupported.hint).toContain('deprecated');
    expect(unsupported.message).not.toBe(modelUnavailableMessage(unsupported.code));

    expect(transport.callCount).toBe(0);
  });

  it('bounds every request with both budgets, configured or defaulted', async () => {
    const defaulted = harness({ script: { create: answers(textAnswer('bounded')) } });
    okValue(await defaulted.provider.generateText(makeRequest()));

    // The configuration named neither budget, and the call carries both: with
    // the fields omitted, how long a stage may hang and how often one request
    // is re-sent would be decided by the client's own defaults rather than by
    // this product — and for an injected client, which this file never
    // constructed, the per-call options are the only place a budget can reach.
    const defaultedOptions = onlyCall(defaulted.transport.createCalls, 'create').options;
    expect(defaultedOptions?.timeout).toBe(ANTHROPIC_DEFAULT_TIMEOUT_MS);
    expect(defaultedOptions?.maxRetries).toBe(ANTHROPIC_DEFAULT_MAX_RETRIES);

    const configured = harness({
      // Zero is the value that proves the point: the vendor's per-request
      // default is two, so a host that asked for no re-sending at all is
      // overruled unless the budget travels with the call.
      config: { ...BASE_CONFIG, timeoutMs: 9_876, maxRetries: 0 },
      script: { create: answers(textAnswer('bounded')) },
    });
    okValue(await configured.provider.generateText(makeRequest()));

    const configuredOptions = onlyCall(configured.transport.createCalls, 'create').options;
    expect(configuredOptions?.timeout).toBe(9_876);
    expect(configuredOptions?.maxRetries).toBe(0);
    expect(configuredOptions?.maxRetries).not.toBe(ANTHROPIC_DEFAULT_MAX_RETRIES);
  });

  it('carries both budgets on a schema-constrained call as well as a text one', async () => {
    const { provider, transport } = harness({
      config: { ...BASE_CONFIG, maxRetries: 1 },
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    okValue(await provider.generateStructured(answerSchema, makeRequest()));

    // Both transport routes go through one options builder, and this is what
    // keeps that true: the structured route is the one a stage spends most of
    // its time in.
    const options = onlyCall(transport.parseCalls, 'parse').options;
    expect(options?.timeout).toBe(ANTHROPIC_DEFAULT_TIMEOUT_MS);
    expect(options?.maxRetries).toBe(1);
  });

  it('resolves both transport budgets from the configuration, then from the product default', () => {
    // The single definition of the fallback, applied by this file and by
    // `../factory.ts` to the configuration it hands over. Idempotence is what
    // makes applying it at both boundaries safe.
    const defaults = resolveAnthropicTransportBudgets(BASE_CONFIG);
    expect(defaults).toEqual({
      timeoutMs: ANTHROPIC_DEFAULT_TIMEOUT_MS,
      maxRetries: ANTHROPIC_DEFAULT_MAX_RETRIES,
    });
    expect(resolveAnthropicTransportBudgets({ ...BASE_CONFIG, ...defaults })).toEqual(defaults);

    // Per setting, not per object: a host that set one budget keeps it and is
    // given the default for the other.
    expect(resolveAnthropicTransportBudgets({ ...BASE_CONFIG, timeoutMs: 1_234 })).toEqual({
      timeoutMs: 1_234,
      maxRetries: ANTHROPIC_DEFAULT_MAX_RETRIES,
    });
    expect(resolveAnthropicTransportBudgets({ ...BASE_CONFIG, maxRetries: 0 })).toEqual({
      timeoutMs: ANTHROPIC_DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });

    // Both are bounds a developer waits behind, so each has to be a usable
    // number rather than merely present.
    expect(Number.isInteger(ANTHROPIC_DEFAULT_TIMEOUT_MS)).toBe(true);
    expect(ANTHROPIC_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isInteger(ANTHROPIC_DEFAULT_MAX_RETRIES)).toBe(true);
    expect(ANTHROPIC_DEFAULT_MAX_RETRIES).toBeGreaterThanOrEqual(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The outbound redaction gate
 *
 * The load-bearing block of this file. `../redact-guard.ts` is the product's
 * second redaction checkpoint (AAP §0.5.2) and the last code that runs before
 * data can leave the machine, so what matters is not only that a refused call
 * answers with an `Err` — it is that **nothing reached the transport**. Every
 * case below therefore asserts a call *count*.
 * ---------------------------------------------------------------------------------------------- */

describe('a payload carrying a denied pattern never reaches the transport', () => {
  /** One placement of one denied pattern inside a request. */
  interface DeniedPlacement {
    readonly label: string;
    readonly request: ModelRequest;
    readonly secret: string;
  }

  const PLACEMENTS: readonly DeniedPlacement[] = [
    {
      label: 'a header-like field of the structured context',
      request: makeRequest({
        input: {
          requestHeaders: { authorization: DENIED_HEADER_VALUE },
          totals: { spans: 4 },
        },
      }),
      secret: DENIED_HEADER_VALUE,
    },
    {
      label: 'a source excerpt in the structured context',
      request: makeRequest({
        input: { excerpt: `const transport = build({ credential: '${DENIED_PROVIDER_KEY}' });` },
      }),
      secret: DENIED_PROVIDER_KEY,
    },
    {
      label: 'the content of a prior message turn',
      request: makeRequest({
        messages: [{ role: 'user', content: `The earlier turn quoted ${DENIED_PROVIDER_KEY}.` }],
      }),
      secret: DENIED_PROVIDER_KEY,
    },
    {
      label: 'the rendered prompt',
      request: makeRequest({ prompt: `${CLEAN_PROMPT} Context: ${DENIED_PROVIDER_KEY}` }),
      secret: DENIED_PROVIDER_KEY,
    },
    {
      label: 'the system instruction',
      request: makeRequest({ system: `${CLEAN_SYSTEM} Use ${DENIED_PROVIDER_KEY} if asked.` }),
      secret: DENIED_PROVIDER_KEY,
    },
  ];

  for (const placement of PLACEMENTS) {
    it(`refuses all three methods, with zero transport calls, for ${placement.label}`, async () => {
      const { provider, transport, logs } = harness({
        script: {
          parse: answers(structuredAnswer(VALID_ANSWER)),
          create: answers(textAnswer('this answer must never be requested')),
        },
      });

      const failures: readonly DebuggenError[] = [
        errorOf(await provider.generateStructured(answerSchema, placement.request)),
        errorOf(await provider.generateText(placement.request)),
        errorOf(await provider.callTools(placement.request, [])),
      ];

      // The assertion this whole block exists for: a count, not a shape.
      expect(transport.callCount).toBe(0);
      expect(transport.parseCalls).toHaveLength(0);
      expect(transport.createCalls).toHaveLength(0);

      // The guard's own error, returned unchanged: its rule ids, field paths and
      // remediation are what both user interfaces expect, and re-coding it here
      // would replace a precise refusal with a vaguer one.
      const fromGuard = errorOf(assertOutboundSafe(placement.request));
      for (const failure of failures) {
        expectCodedFailure(failure);
        expect(failure.code).toBe(fromGuard.code);
        expect(failure.message).toBe(fromGuard.message);
        expect(failure.hint).toBe(fromGuard.hint);
        expect(failure.details).toEqual(fromGuard.details);
        // Never rewritten and never partially sent: refusal is the contract.
        expectNoValueLeak(serialiseFailure(failure), placement.secret);
      }
      expectNoValueLeak(serialiseLogs(logs), placement.secret);
    });
  }

  it('refuses a repair turn whose feedback carries a denied pattern, with zero transport calls', async () => {
    const { provider, transport } = harness({
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    // `../structured.ts` builds every repair attempt from the caller's original
    // request and sends it back through these same methods, which is what puts
    // a repair turn through the guard as well. A pattern that appears only on
    // the second turn must be refused exactly like one on the first.
    const repair = buildRepairRequest(
      makeRequest(),
      `count: the value ${DENIED_PROVIDER_KEY} is not an integer of at least 2`,
      1,
    );

    const error = errorOf(await provider.generateStructured(answerSchema, repair));

    expectCodedFailure(error);
    expect(error.message).toBe(errorOf(assertOutboundSafe(repair)).message);
    expect(transport.callCount).toBe(0);
    expectNoValueLeak(serialiseFailure(error), DENIED_PROVIDER_KEY);
  });

  it('lets a clean payload through, so the gate is a gate and not a wall', async () => {
    const { provider, transport } = harness({
      script: { parse: answers(structuredAnswer(VALID_ANSWER)) },
    });

    okValue(
      await provider.generateStructured(
        answerSchema,
        makeRequest({
          system: CLEAN_SYSTEM,
          messages: [{ role: 'user', content: 'What did the earlier capture show?' }],
        }),
      ),
    );

    expect(transport.callCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The selection boundary
 *
 * `../factory.ts` has no suite of its own in the plan, so its behaviours are
 * covered here, beside the provider it selects. Every case injects its own
 * environment record — `process.env` is never read for a decision and never
 * mutated — which is what keeps these cases independent of each other and of
 * the machine they run on.
 * ---------------------------------------------------------------------------------------------- */

describe('the factory decides which boundary a host runs behind', () => {
  /** The three names the factory reads on the network-backed path (AAP §0.3.4). */
  const NETWORK_ENVIRONMENT: Readonly<Record<string, string>> = {
    DEBUGGEN_PROVIDER: 'anthropic',
    DEBUGGEN_MODEL: MODEL_PLACEHOLDER,
    ANTHROPIC_API_KEY: CREDENTIAL_FIXTURE,
  };

  it('defaults to the offline provider when nothing is configured', () => {
    const constructedBefore = transportConstruction.options.length;

    // Nothing leaves the machine unless a developer asked for it: an
    // unconfigured process reaches no network at all.
    expect(DEFAULT_PROVIDER_ID).toBe('deterministic');
    expect(okValue(resolveProviderConfig({})).providerId).toBe('deterministic');
    expect(okValue(createModelProvider({ env: {} })).id).toBe('deterministic');
    expect(transportConstruction.options.length).toBe(constructedBefore);
  });

  it('refuses the network-backed selection without a credential, in the shared sentence', () => {
    const error = errorOf(
      createModelProvider({
        env: { DEBUGGEN_PROVIDER: 'anthropic', DEBUGGEN_MODEL: MODEL_PLACEHOLDER },
      }),
    );

    expectCodedFailure(error);
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toBe(modelUnavailableMessage(error.code));
    expect(error.hint).toContain('ANTHROPIC_API_KEY');
    expect(asObject(error.details ?? {}).setting).toBe('ANTHROPIC_API_KEY');
  });

  it('refuses the network-backed selection without a model, and never defaults one', () => {
    const error = errorOf(
      createModelProvider({
        env: { DEBUGGEN_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: CREDENTIAL_FIXTURE },
      }),
    );

    expectCodedFailure(error);
    expect(error.message).toBe(modelUnavailableMessage(error.code));
    expect(error.hint).toContain('DEBUGGEN_MODEL');
    expect(asObject(error.details ?? {}).setting).toBe('DEBUGGEN_MODEL');
    // A session records the model it used, so an absent one is representable
    // rather than substituted.
    expect(okValue(resolveProviderConfig({ ANTHROPIC_API_KEY: CREDENTIAL_FIXTURE })).model).toBe(
      '',
    );
  });

  it('lists every known provider id for an unrecognised selection', () => {
    const error = errorOf(createModelProvider({ env: { DEBUGGEN_PROVIDER: 'nonsense' } }));

    expectCodedFailure(error);
    expect(error.code).toBe('CONFIG_INVALID');
    // Asserted against the imported tuple rather than a written-out string, so
    // this tracks a provider added to the vocabulary with nothing to edit.
    for (const id of PROVIDER_IDS) {
      expect(error.hint).toContain(id);
    }
    expect(error.hint).toContain(PROVIDER_IDS.join(', '));
    expect(asObject(error.details ?? {}).setting).toBe('DEBUGGEN_PROVIDER');
  });

  it('reads the environment it was handed, and constructs the network-backed provider from it', () => {
    const logs: LogRecord[] = [];
    const logger = createConsoleLogger({
      level: 'trace',
      sink: (record: LogRecord): void => {
        logs.push(record);
      },
    });

    const provider = okValue(createModelProvider({ env: NETWORK_ENVIRONMENT, logger }));

    // The injected record wins over the ambient one the suite runs under, which
    // selects the offline provider — proof the decision is the argument's.
    expect(provider.id).toBe('anthropic');
    const constructedWith = asObject(transportConstruction.options.at(-1));
    expect(constructedWith.apiKey).toBe(CREDENTIAL_FIXTURE);
    // The environment carries no budget — this package reads three variables
    // and none of them is one — so the transport the selector built is bounded
    // by the product's defaults rather than by the vendor client's.
    expect(constructedWith.timeout).toBe(ANTHROPIC_DEFAULT_TIMEOUT_MS);
    expect(constructedWith.maxRetries).toBe(ANTHROPIC_DEFAULT_MAX_RETRIES);
    // A logger performs no redaction, so a credential must never be given to
    // one in the first place.
    expectNoValueLeak(serialiseLogs(logs), CREDENTIAL_FIXTURE);
  });

  it('prefers a host override over the environment, one setting at a time', () => {
    const config = okValue(
      resolveProviderConfig(NETWORK_ENVIRONMENT, { providerId: 'deterministic' }),
    );

    expect(config.providerId).toBe('deterministic');
    expect(config.model).toBe(MODEL_PLACEHOLDER);
    expect(okValue(createModelProvider({ overrides: config, env: {} })).id).toBe('deterministic');
  });

  it('refuses a malformed budget instead of quietly defaulting it', () => {
    const malformed: readonly (readonly [string, number])[] = [
      ['maxTokens', 0],
      ['temperature', -1],
      ['timeoutMs', 1.5],
      ['maxRetries', Number.NaN],
    ];

    for (const [field, value] of malformed) {
      const error = errorOf(resolveProviderConfig({}, { [field]: value }));
      expectCodedFailure(error);
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).toContain(field);
      expect(asObject(error.details ?? {}).setting).toBe(field);
    }
  });

  it('carries nothing about a credential on any failing path', () => {
    const logs: LogRecord[] = [];
    const logger = createConsoleLogger({
      level: 'trace',
      sink: (record: LogRecord): void => {
        logs.push(record);
      },
    });

    const failures: readonly DebuggenError[] = [
      errorOf(createModelProvider({ env: { DEBUGGEN_PROVIDER: 'anthropic' }, logger })),
      errorOf(createModelProvider({ env: { ...NETWORK_ENVIRONMENT, DEBUGGEN_MODEL: '' }, logger })),
      errorOf(
        createModelProvider({
          env: { DEBUGGEN_PROVIDER: 'anthropic', DEBUGGEN_MODEL: MODEL_PLACEHOLDER },
        }),
      ),
      errorOf(createModelProvider({ env: { ...NETWORK_ENVIRONMENT, DEBUGGEN_MODEL: '  ' } })),
      errorOf(createModelProvider({ env: { ...NETWORK_ENVIRONMENT, DEBUGGEN_PROVIDER: 'oops' } })),
      errorOf(createAnthropicProvider({ config: { providerId: 'anthropic', model: '' } })),
      errorOf(
        createAnthropicProvider({
          config: { ...BASE_CONFIG, apiKey: CREDENTIAL_FIXTURE, maxTokens: -1 },
        }),
      ),
    ];

    for (const failure of failures) {
      // Presence is all a failure may report: not the value and not a prefix
      // of it either, which the sliding window alone would not catch for the
      // first few characters.
      expectNoValueLeak(serialiseFailure(failure), CREDENTIAL_FIXTURE);
      expect(serialiseFailure(failure)).not.toContain(CREDENTIAL_FIXTURE.slice(0, 6));
    }
    // A logger performs no redaction of its own, so the rule has to hold at the
    // call site: nothing about a credential may be handed to one, on a failing
    // path any more than on a successful one.
    expectNoValueLeak(serialiseLogs(logs), CREDENTIAL_FIXTURE);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The module graph, made mechanical
 *
 * One sentence has one definition, and it is reached without an implementation
 * importing its own selector. Nothing in this repository checks an import cycle
 * — `eslint-plugin-import` is not a dependency — so the edge is asserted from
 * the unit's own source, where its return would be visible.
 * ---------------------------------------------------------------------------------------------- */

describe('the unit under test imports nothing that imports it', () => {
  it('takes the shared sentence from the leaf that declares it, not from the factory', () => {
    const source = readFileSync(new URL('./anthropic.ts', import.meta.url), 'utf8');

    // `../factory.ts` reaches this module through `./index.ts`, so an import of
    // it here closes the runtime cycle
    // `factory -> providers/index -> providers/anthropic -> factory`. That was
    // safe only while no imported binding was read during module evaluation,
    // which is why the edge is gone rather than merely documented.
    expect(source).not.toContain("from '../factory.js'");
    expect(source).not.toContain("from './index.js'");
    expect(source).toContain("from '../provider.js'");
  });

  it('shows the same sentence the selector shows, from the one builder', () => {
    // Both boundaries refuse a network-backed selection with no credential:
    // this one when a host constructs it directly, the selector when it reads
    // the environment. A developer must not be able to tell which refused.
    const fromProvider = errorOf(createAnthropicProvider({ config: BASE_CONFIG }));
    const fromFactory = errorOf(
      createModelProvider({
        env: { DEBUGGEN_PROVIDER: 'anthropic', DEBUGGEN_MODEL: MODEL_PLACEHOLDER },
      }),
    );

    expect(fromProvider.message).toBe(fromFactory.message);
    expect(fromProvider.message).toBe(modelUnavailableMessage(fromProvider.code));
  });
});

/* -------------------------------------------------------------------------------------------------
 * The no-network property, made mechanical
 * ---------------------------------------------------------------------------------------------- */

describe('the unit under test owns no transport of its own', () => {
  /**
   * Tokens whose absence is what makes "the only way out is the injected
   * client" checkable rather than merely believed.
   */
  const FORBIDDEN_TOKENS: readonly string[] = [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:child_process',
    'XMLHttpRequest',
    'fetch(',
    'require(',
  ];

  it('reaches no socket, no filesystem and no loader of its own', () => {
    // This is also the other half of "callTools executes nothing": a tool in
    // this product is a read-only query over an already-built code graph that
    // `apps/local-service/src/pipeline/tools/code-tools.ts` executes, and a
    // module with no filesystem and no loader reach cannot execute one here
    // however a model names it.
    const source = readFileSync(new URL('./anthropic.ts', import.meta.url), 'utf8');

    expect(source.length).toBeGreaterThan(0);
    for (const token of FORBIDDEN_TOKENS) {
      expect(
        source.includes(token),
        `./anthropic.ts must not reach ${token}: its only transport is the client it was given`,
      ).toBe(false);
    }
  });
});
