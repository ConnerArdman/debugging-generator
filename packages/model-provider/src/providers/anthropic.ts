/**
 * The one provider in this repository that can send a developer's data off
 * their machine.
 *
 * AAP §0.5.3 names two implementations behind `./index.js`: this one, which
 * calls a real model over the network, and the rules-based one, which never
 * leaves the process. Everything in this file is written from that asymmetry:
 * it validates its own configuration before it constructs a transport, it runs
 * the outbound redaction guard before it can reach a socket, and it
 * re-validates whatever the transport hands back.
 *
 * ## The order of every call
 *
 * `assertOutboundSafe` → cancellation check → build parameters → transport.
 * That order is the file's safety property, not a style: a payload is inspected
 * before it is shaped into a request, so no code path can send something the
 * guard has not cleared. Each of the three public methods opens with the guard
 * as its first statement, and the private tool-route method — the only other
 * place a transport call appears — opens with it too, so the invariant holds
 * locally for every function that touches the network rather than only for the
 * file read top to bottom. `./structured.js` builds its repair requests from
 * the caller's original request and sends them back through these same
 * methods, which is what puts every repair turn through the guard as well;
 * moving the guard to a "first call only" path would silently exempt them.
 *
 * ## What is an `Err` and what is an ordinary answer
 *
 * `./provider.ts` forbids an implementation from looping and from normalising,
 * and `./structured.js` owns the bounded repair budget. Two consequences are
 * easy to get wrong, so they are stated here:
 *
 * - **A schema miss is not an `Err`.** `generateStructured` returns
 *   `ok(attempt)` with `raw` populated and `value` absent when the model's
 *   output fails the caller's schema. A provider-level `Err` short-circuits
 *   `generateStructuredWithRepair` *without consuming repair budget*, so
 *   answering a badly shaped artifact with an `Err` would deny the stage the
 *   two repair attempts that exist precisely for it. Only configuration,
 *   credential, quota, transport, cancellation and malformed-response outcomes
 *   are `Err`.
 * - **Transport retry and schema repair are different budgets.**
 *   `ModelProviderConfig.maxRetries` is handed to the SDK client constructor
 *   and governs re-sending a request that never got an answer;
 *   `StructuredOptions.maxRepairs` governs re-asking after an answer arrived
 *   and failed validation. They are counted in different places and never
 *   share a counter — `./types.ts` on `maxRetries` explains what conflating
 *   them would cost.
 *
 * ## Both transport budgets are always explicit
 *
 * Every request carries both a timeout and a retry count, and so does the
 * client this file constructs, whether or not the host configured either:
 * {@link resolveAnthropicTransportBudgets} fills them from
 * {@link ANTHROPIC_DEFAULT_TIMEOUT_MS} and
 * {@link ANTHROPIC_DEFAULT_MAX_RETRIES}. Neither budget has an environment
 * form (AAP §0.3.4 fixes this package's environment surface at three names) and
 * the local service's configuration module passes neither, so leaving them
 * absent would hand the question "how long may one stage hang, and how many
 * times is one request re-sent" to whatever the vendor's software development
 * kit defaults to — a product decision taken by a dependency, changeable by a
 * version bump, and invisible in the session record. The defaults below are
 * this product's answer, and a host that sets `timeoutMs` or `maxRetries`
 * overrides them per setting.
 *
 * ## The transport's destination and diagnostics are never taken from the environment
 *
 * The vendor's client reads two process-environment variables this product
 * never documents, and each would be a control nobody set if the service
 * inherited it:
 *
 * - `ANTHROPIC_BASE_URL` is the client's default `baseURL`. Inherited, it
 *   routes the credential and every prompt to whatever host it names
 *   (CWE-200, CWE-918), contrary to the documented egress path — the
 *   Anthropic API over HTTPS.
 * - `ANTHROPIC_LOG` is the client's default log level, printed through
 *   `console` unless a logger is supplied. At `info` or `debug` its records
 *   describe each request and response, and they would reach the service's
 *   standard output — which the VS Code extension streams into its "Debug
 *   Generator Service" output channel — outside the service's own pino
 *   redaction (CWE-532).
 *
 * So the client this file constructs is always given all three of `baseURL`
 * (the validated host override, else {@link ANTHROPIC_API_BASE_URL}),
 * `logLevel: 'off'` and a silent logger, and neither variable is ever
 * consulted. The product's own records, through the injected logger and
 * limited to provenance and outcome labels, are the diagnostics. A base URL is
 * accepted only as an explicit host override — `config.baseUrl`, which
 * `../factory.ts` never reads from the environment — and only under the policy
 * {@link validateBaseUrl} states: `https`, or `http` to a loopback address, with
 * no user information, query or fragment. A refused override names no part of
 * itself anywhere, since a pasted URL can carry a credential.
 *
 * ## Sampling temperature is validated and never sent
 *
 * The messages API deprecated `temperature`: models released after the
 * generation this SDK documents accept `1` for backwards compatibility and
 * **reject every other value with a 400**, which would fail every call a
 * session makes rather than one. This file has no model identifier to gate the
 * field on (see below), so it takes the only safe route available to it — the
 * field is never transmitted, a configured or requested
 * {@link ANTHROPIC_SUPPORTED_TEMPERATURE} is accepted as the no-op it is, since
 * that is also the API's own default, and any other value is refused locally as
 * a configuration failure that names the deprecation. `../factory.ts` validates
 * the same rule at the configuration boundary, so the two agree.
 *
 * ## Structured output, and why the helper's own parse step is replaced
 *
 * AAP §0.2.4 records the mechanism: `client.messages.parse` with
 * `output_config.format = zodOutputFormat(schema)`, and — the reason this file
 * re-validates — that the helper **strips the JSON-Schema keywords the
 * service-side format does not support**, so a numeric bound or a refinement
 * can survive the platform's own constraint unchecked.
 *
 * The helper's returned object also carries a `parse` callback that runs the
 * caller's schema and **throws** when it fails, and the SDK's `parse` method
 * invokes that callback on every text block. Handing it through unchanged
 * would turn an ordinary schema miss into an exception, destroying the decoded
 * output that the repair loop needs and violating the rule above. So the
 * format is assembled from the helper's *schema* — the keyword-stripped,
 * platform-shaped JSON Schema, which is the part that constrains generation —
 * with a total decoder in place of its `parse`. Decoding and validation then
 * happen here, where a miss is data rather than a throw.
 *
 * A single fallback exists for the cases that path cannot serve — a client with
 * no `parse` capability, a schema the format renderer refuses, a platform that
 * rejects the output format, or a response with nothing in it at all — and it
 * asks for the same artifact as a forced `tool_use` with the schema as the
 * tool's `input_schema`. It is one extra attempt, never a loop, and it is never
 * reached for a transport failure (that is an `Err`) or for a schema mismatch
 * (that belongs to `./structured.js`).
 *
 * ## The failure vocabulary
 *
 * Every failure is a `DebuggenError` whose `code` comes from the closed set in
 * `@debuggen/shared`, whose `message` is AAP §0.5.5's one sentence built by
 * `modelUnavailableMessage` in `../provider.js`, and whose `hint` is the
 * concrete next step:
 *
 * | Outcome                                            | Code                   |
 * | -------------------------------------------------- | ---------------------- |
 * | no credential, no model, unusable request budget   | `CONFIG_INVALID`       |
 * | a base URL override outside the endpoint policy    | `CONFIG_INVALID`       |
 * | credential rejected, quota exhausted, server error | `MODEL_UNAVAILABLE`    |
 * | unreachable, timed out, cancelled, closed provider | `MODEL_UNAVAILABLE`    |
 * | a text answer with no text in it                   | `MODEL_OUTPUT_INVALID` |
 * | a caller schema that cannot be rendered            | `INTERNAL`             |
 *
 * `TRANSPORT_DISCONNECTED` is deliberately absent: `errors.ts` scopes it to a
 * peer of this product's own inter-process transports, whose caller reconnects
 * and retries, while a provider that cannot be reached is exactly what
 * `MODEL_UNAVAILABLE` is defined as ("could not be reached or refused the
 * call"). `RATE_LIMITED` is likewise scoped there to the local service's access
 * boundary, so a provider quota failure carries `MODEL_UNAVAILABLE` with the
 * condition in its `details` and the back-off advice in its `hint`.
 *
 * Nothing about a credential ever reaches a message, a hint, a `details` field
 * or a log record — not its value, not a prefix of it, not its length. A
 * failure says that a credential is missing or that it was rejected, and the
 * provider's own error object travels only as the `DebuggenError`'s `cause`,
 * which `toPayload` excludes.
 *
 * ## The model identifier
 *
 * There is no model identifier anywhere in this file. `config.model` is the
 * only source, `../factory.ts` reads it from the host's configuration and never
 * defaults it (AAP §0.5.3), and a response's reported model is carried through
 * as the provider gave it. A missing model is a typed configuration failure,
 * never a substituted default.
 *
 * ## Every import edge runs downward
 *
 * This module imports `../provider.js`, `../redact-guard.js`, `../structured.js`
 * and `../types.js`, and **nothing that imports it**. In particular it does not
 * import `../factory.js`, which reaches this file through `./index.js`: the
 * shared `modelUnavailableMessage` it needs is declared in `../provider.js`, a
 * leaf of the package's module graph, precisely so that one sentence can have
 * one definition without an implementation importing its own selector. That
 * cycle existed once. It was safe only while no imported binding was read
 * during module evaluation — a property no lint rule in this repository checks
 * and every later edit could have broken — so it was removed rather than
 * documented, and `./anthropic.test.ts` asserts from this file's own source
 * that the edge has not come back.
 */

import Anthropic, { APIUserAbortError } from '@anthropic-ai/sdk';
import type { ClientOptions } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type {
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import type { ZodError, ZodType } from 'zod';

import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  err,
  noopLogger,
  ok,
  tryCatch,
} from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';

import { modelUnavailableMessage } from '../provider.js';
import type { DisposableModelProvider, ModelProvider } from '../provider.js';
import { assertOutboundSafe } from '../redact-guard.js';
import { REPAIR_ASSISTANT_NOTICE } from '../structured.js';
import type {
  ModelMessage,
  ModelProviderConfig,
  ModelRequest,
  ModelTextResponse,
  PromptStage,
  StructuredAttempt,
  TokenUsage,
  ToolCall,
  ToolCallsResponse,
  ToolDefinition,
} from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How this implementation reports itself in {@link ModelProvider.id} and on
 * every response it returns.
 *
 * A literal rather than an import: `./index.js` owns the set of provider ids
 * and re-exports this module, so importing that set here would close a cycle
 * for a single string. `./provider.ts` types `id` as `string` for exactly this
 * reason and expects an implementation to narrow it to its own literal.
 */
const PROVIDER_ID = 'anthropic';

/**
 * Response-length bound applied when neither the call nor the configuration
 * names one.
 *
 * A **request budget**, not a property of any model: the messages API requires
 * `max_tokens` on every request, while `ModelRequest.maxTokens` and
 * `ModelProviderConfig.maxTokens` are both optional, so a final value has to
 * come from somewhere. It is generous enough for the largest artifact a stage
 * asks for — a panel specification with its layout and its evidence — and a
 * host that wants a different bound sets one in either of those two places
 * rather than editing this file.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

/**
 * The only sampling temperature the messages API still accepts.
 *
 * `temperature` is deprecated: this SDK's own declaration of the field records
 * that models released after the generation it documents do not support setting
 * it, that `1` is accepted for backwards compatibility, and that **every other
 * value is rejected with a 400**. One is also the API's own default, so
 * accepting this value and sending nothing is behaviourally identical to
 * sending it — which is why this provider omits the field entirely and treats
 * any other configured or requested value as a configuration failure it reports
 * locally, instead of letting every call in a session fail at the provider.
 *
 * Exported because `../factory.ts` validates the same rule one boundary earlier
 * and must not refuse a value this file would accept, nor pass one it would
 * refuse; a single constant is what keeps the two in step. Gating the field on
 * the model instead is not available here: a capability table would put model
 * identifiers in this package, which AAP §0.5.3 forbids.
 */
export const ANTHROPIC_SUPPORTED_TEMPERATURE = 1;

/**
 * How long one request may take before the transport abandons it, when the host
 * configured no timeout.
 *
 * Five minutes, and the number is derived rather than picked. The vendor's
 * client computes the duration a non-streaming answer may need as
 * `60 minutes × max_tokens ÷ 128000`, which for {@link DEFAULT_MAX_OUTPUT_TOKENS}
 * — the largest artifact a stage asks for — is a little under four minutes, so a
 * tighter bound would abandon a legitimate full-length answer. It is
 * deliberately *half* the client's own blanket default, because that default is
 * a vendor decision about the general case, and an interactive debugging
 * session that has been "analysing" for ten minutes has failed whatever the
 * transport eventually returns.
 *
 * A host that wants a different bound sets `ModelProviderConfig.timeoutMs`;
 * this value applies only in its absence, and the failure a timeout produces
 * carries the hint that says so.
 */
export const ANTHROPIC_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * How many times the transport re-sends a request that produced no answer, when
 * the host configured no retry bound.
 *
 * Two, which bounds one stage at three sends. Retries here cover the conditions
 * that resolve quickly and retry usefully — a rate-limit response, a server
 * error, a connection that dropped — so the practical cost is short, while the
 * pathological case of three consecutive timeouts is bounded by
 * {@link ANTHROPIC_DEFAULT_TIMEOUT_MS} times this count plus the client's own
 * backoff.
 *
 * It is a **transport** budget and shares no counter with the schema repair
 * budget in `../structured.js`: see this module's overview for what conflating
 * the two would cost. A host that wants a different bound sets
 * `ModelProviderConfig.maxRetries`, including `0` to disable re-sending
 * altogether.
 */
export const ANTHROPIC_DEFAULT_MAX_RETRIES = 2;

/**
 * The approved endpoint: the Anthropic API, over HTTPS.
 *
 * `docs/SECURITY.md` documents the egress path as this API over HTTPS, and this
 * constant is what makes that true for every client this file constructs. It is
 * passed as `baseURL` whenever the host configured no override, rather than
 * leaving the field absent: an absent `baseURL` makes the vendor's client read
 * `ANTHROPIC_BASE_URL` from the process environment, so an inherited variable
 * nobody set would decide where the credential and every prompt are sent.
 *
 * An explicit, validated `ModelProviderConfig.baseUrl` is the one way to route
 * elsewhere (see {@link validateBaseUrl}).
 */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';

/**
 * The vendor client's log level: nothing at all.
 *
 * Passed explicitly because the client's own default is read from
 * `ANTHROPIC_LOG`, and at `info` or `debug` its records describe each request
 * and response. Typed from the client's own options so a vocabulary change in
 * the dependency fails `pnpm typecheck` rather than this setting.
 */
const TRANSPORT_LOG_LEVEL: NonNullable<ClientOptions['logLevel']> = 'off';

/** The body of every {@link SILENT_TRANSPORT_LOGGER} method. */
function discardTransportRecord(): void {
  /* Intentionally empty: the vendor client's records never reach an output. */
}

/**
 * The logger handed to the vendor client: every level discards its record.
 *
 * The level alone would already silence the client; the logger is passed as
 * well because a client given none falls back to `console`, whose output is the
 * service's standard output and, when the VS Code extension started the
 * service, its "Debug Generator Service" output channel — a sink the service's
 * pino redaction never sees. Frozen and stateless, so one instance serves every
 * client. Diagnostics come from this file's own records through the injected
 * {@link AnthropicProviderOptions.logger}, which carry provenance and outcome
 * labels and never a payload.
 */
const SILENT_TRANSPORT_LOGGER: NonNullable<ClientOptions['logger']> = Object.freeze({
  error: discardTransportRecord,
  warn: discardTransportRecord,
  info: discardTransportRecord,
  debug: discardTransportRecord,
});

/**
 * The host names a plain-`http` base URL override may use: this machine's
 * loopback interface, by name or as the IPv6 loopback address.
 *
 * The WHATWG parser lower-cases a host name and brackets an IPv6 address, so
 * `[::1]` is the form a parsed URL reports; the bare `::1` is listed so the set
 * states the whole of the rule. IPv4 loopback (`127.0.0.0/8`) is matched by
 * {@link IPV4_LOOPBACK_PATTERN}, because the parser canonicalises every numeric
 * spelling of an IPv4 address (`127.1`, `0x7f.0.0.1`) to dotted-quad first.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '[::1]', '::1']);

/** A canonical dotted-quad address inside `127.0.0.0/8`. */
const IPV4_LOOPBACK_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

/**
 * Prefix of the tool the fallback route declares.
 *
 * The full name is this prefix plus the calling stage, which is where the name
 * comes from: a tool name is sent to the model, so it must describe the *shape
 * of the request* and never the application under test. Deriving it from
 * `ModelRequestMetadata.stage` keeps it generic by construction — there is no
 * vocabulary here that could carry knowledge of a particular project.
 */
const STRUCTURED_TOOL_NAME_PREFIX = 'structured_output_';

/**
 * What the fallback route tells the model the tool is for.
 *
 * Schema-agnostic, like every other instruction this package produces: it talks
 * about "the answer" and "the schema" because this file has no idea what
 * artifact is being asked for, and the schema itself travels as the tool's
 * `input_schema`.
 */
const STRUCTURED_TOOL_DESCRIPTION =
  'Return the answer as this tool\u2019s arguments. The arguments must satisfy the schema exactly; nothing outside this tool call is read.';

/** How many failing field paths a validation-miss log record names. */
const MAX_LOGGED_ISSUE_PATHS = 10;

/** What a finding's path calls the root of a value with no path at all. */
const ROOT_ISSUE_PATH = '(root)';

/** Remediation for a provider constructed without a credential. */
const MISSING_API_KEY_HINT =
  'Set ANTHROPIC_API_KEY in the environment the local service was started from, or set DEBUGGEN_PROVIDER=deterministic to run the pipeline offline.';

/** Remediation for a provider constructed without a model. */
const MISSING_MODEL_HINT =
  'Set DEBUGGEN_MODEL to the model this session should call. It is never defaulted: a session records the model it used, and a substituted default would make that record untrue.';

/** Remediation for a request budget that the messages API cannot accept. */
const INVALID_BUDGET_HINT =
  'Correct the value where the request is assembled, or in the service configuration it came from. A response-length bound must be a positive integer, a request timeout a positive integer number of milliseconds and a transport retry bound a non-negative integer.';

/**
 * Remediation for a base URL override outside the endpoint policy.
 *
 * Names the approved endpoint — a repository constant — and never the refused
 * value, which can carry a credential in its user information or its query.
 */
const INVALID_BASE_URL_HINT = `Supply the model API base URL override as an https endpoint, or as an http proxy on this machine's loopback interface (localhost, 127.0.0.0/8 or [::1]), with no user name, password, query or fragment; or omit the override to use the approved endpoint, ${ANTHROPIC_API_BASE_URL}.`;

/**
 * Remediation for a sampling temperature the messages API no longer accepts.
 *
 * States the value the API still tolerates so a developer who wants to keep the
 * setting can, and recommends removing it, which is what this provider does
 * with it in every case: the field is never transmitted.
 */
const UNSUPPORTED_TEMPERATURE_HINT = `Remove the sampling temperature from the request and from the service configuration, or set it to ${String(ANTHROPIC_SUPPORTED_TEMPERATURE)}. The messages API deprecated the field: current models accept only that value, which is also the API default, so this provider never sends it and no answer changes when it is dropped.`;

/** Remediation for a credential the provider rejected. */
const UNAUTHORIZED_HINT =
  'The provider rejected the credential. Check that ANTHROPIC_API_KEY is current and authorised for this model, or set DEBUGGEN_PROVIDER=deterministic to continue offline.';

/** Remediation for an exhausted quota or rate limit. */
const RATE_LIMIT_HINT =
  'The provider is refusing further calls for now. Wait and retry the stage, lower the configured concurrency, or set DEBUGGEN_PROVIDER=deterministic to continue offline.';

/** Remediation for a provider-side failure. */
const SERVER_ERROR_HINT =
  'The provider failed to answer. Retry the stage; if it repeats, check the provider status page or set DEBUGGEN_PROVIDER=deterministic to continue offline.';

/** Remediation for a call that never reached the provider. */
const UNREACHABLE_HINT =
  'The provider could not be reached. Check network access from this machine and DEBUGGEN_MODEL, raise the configured timeout, or set DEBUGGEN_PROVIDER=deterministic to continue offline.';

/** Remediation for a request the provider refused to accept. */
const REFUSED_HINT =
  "The provider refused the request. Check DEBUGGEN_MODEL and the stage's request budget; the provider's own report travels as this error's cause and is in the service log.";

/** Remediation for a call abandoned before or during its transport. */
const ABORTED_HINT =
  'The work that asked for this answer was abandoned. Start the stage again if the answer is still wanted.';

/** Remediation for a method called after the provider was disposed. */
const CLOSED_HINT =
  'This provider was closed, and a closed provider never reopens its transport. Construct a new one from the current configuration.';

/** Remediation for a text answer that carried no text. */
const NO_TEXT_HINT =
  'The model answered without any text. Retry the stage; if it repeats, check DEBUGGEN_MODEL and the stage prompt.';

/** Remediation for a caller schema that cannot be rendered as JSON Schema. */
const SCHEMA_RENDER_HINT =
  "Simplify the stage's authoring schema so it can be rendered as JSON Schema — a transform, a custom check or a non-object root cannot be sent to a model — or run this stage against the deterministic provider.";

/** Remediation for a client pinned to a route it cannot serve. */
const PARSE_ROUTE_HINT =
  'This provider is pinned to the schema-constrained route and the client it was given offers none. Leave the structured-output mode at its default so the tool route can serve the call, or supply a client with a parse capability.';

/**
 * Every remediation above, in declaration order: the complete set of hints a
 * failure of this provider can carry, since each one is attached by name and
 * none is ever composed from a runtime value. Read only by
 * {@link providerFailureTexts}.
 */
const PROVIDER_FAILURE_HINTS: readonly string[] = Object.freeze([
  MISSING_API_KEY_HINT,
  MISSING_MODEL_HINT,
  INVALID_BUDGET_HINT,
  INVALID_BASE_URL_HINT,
  UNSUPPORTED_TEMPERATURE_HINT,
  UNAUTHORIZED_HINT,
  RATE_LIMIT_HINT,
  SERVER_ERROR_HINT,
  UNREACHABLE_HINT,
  REFUSED_HINT,
  ABORTED_HINT,
  CLOSED_HINT,
  NO_TEXT_HINT,
  SCHEMA_RENDER_HINT,
  PARSE_ROUTE_HINT,
]);

/** The memoised answer of {@link providerFailureTexts}; built on first use. */
let knownFailureTexts: ReadonlySet<string> | undefined;

/**
 * The fixed texts {@link isProviderFailureText} recognises: every
 * {@link PROVIDER_FAILURE_HINTS} entry, and AAP §0.5.5's sentence as
 * `modelUnavailableMessage` builds it for each code of the closed
 * `DEBUGGEN_ERROR_CODES` vocabulary — every message {@link unavailableFailure}
 * can raise, and the one `../factory.ts` raises for an unusable configuration.
 *
 * Built on the first call rather than at module evaluation, so no imported
 * binding is read while the package's module graph is still loading: the
 * discipline this file keeps for `modelUnavailableMessage` (see
 * {@link unavailableFailure}), and why this set stays correct whatever import
 * edge a later edit adds. Module-private, so no caller can add to it.
 */
function providerFailureTexts(): ReadonlySet<string> {
  knownFailureTexts ??= new Set<string>([
    ...PROVIDER_FAILURE_HINTS,
    ...DEBUGGEN_ERROR_CODES.map((code) => modelUnavailableMessage(code)),
  ]);
  return knownFailureTexts;
}

/**
 * Whether `text` is, character for character, one of this package's own fixed
 * failure texts: a remediation hint the network-backed provider attaches to a
 * failure, or AAP §0.5.5's "Model provider unavailable (‹code›)…" sentence for
 * a code of the closed vocabulary.
 *
 * The proof a host needs before it writes a failure's own words where free
 * text may not go — the local service's default-level log, whose records must
 * never quote a path, a statement or a credential. Each of these texts is a
 * repository constant or is built from one and a closed code, so none can
 * carry a runtime value, and nothing about a credential appears in any of
 * them. A message or hint that came from anywhere else — a scripted provider,
 * a dependency's exception, text a caller composed — answers `false` however
 * closely it resembles one of them.
 *
 * The comparison is exact: no trimming, no case folding, no prefix or
 * substring match. Total and non-throwing: a non-string, an empty string and
 * every other value answer `false`.
 *
 * @param text A failure's message or hint, of any type.
 * @returns `true` only for a string equal to one of the fixed texts.
 *
 * @example Gating a failure's words before a default-level log record
 * ```ts
 * log.error('Pipeline stage failed.', {
 *   code: error.code,
 *   ...(isProviderFailureText(error.hint) ? { errorHint: error.hint } : {}),
 * });
 * ```
 */
export function isProviderFailureText(text: unknown): text is string {
  return typeof text === 'string' && text.length > 0 && providerFailureTexts().has(text);
}

// ---------------------------------------------------------------------------
// The transport seam
//
// The five types below are the *minimum* surface this file uses, declared
// structurally rather than imported from the SDK, and that choice has one
// purpose: a test can hand `createAnthropicProvider` a three-line object and
// drive every branch of this file without a network, a credential or a module
// mock. The real client satisfies them by assignment — the shapes are
// deliberately wide enough for that, and narrow enough that a fake does not
// have to fill in a container, a citation list or a cache-creation breakdown
// it has nothing to say about.
//
// Request *parameters* are still built as the SDK's own
// `MessageCreateParamsNonStreaming` inside this file, so the compiler still
// checks every field this provider sends against the real API; only the seam
// they pass through is loose.
// ---------------------------------------------------------------------------

/**
 * The per-call transport options this provider sets.
 *
 * `signal` is the cancellation channel `ModelRequest.signal` is forwarded to —
 * `./types.ts` makes it the only one — and **both** transport budgets are
 * carried per call as well as on the client, so that an **injected** client,
 * which this file never configured, is bounded by the same policy rather than
 * by its own defaults. The vendor's per-request options accept both.
 */
export interface AnthropicRequestOptionsLike {
  /** Cancellation for this call, forwarded from the request. */
  readonly signal?: AbortSignal | null | undefined;

  /**
   * Per-call transport timeout in milliseconds.
   *
   * Optional in the shape because the vendor's own options type declares it so;
   * this provider always sets it, from the effective budget it was constructed
   * with.
   */
  readonly timeout?: number | undefined;

  /**
   * How many times this call may be re-sent when it produced no answer.
   *
   * Optional in the shape for the same reason as `timeout`, and set on every
   * call for the same purpose: a client this file did not construct — a test's
   * fake, or a host's own configured client — would otherwise apply its own
   * retry count, so a configured `maxRetries` of `0` could be silently
   * overruled by the vendor's default of two.
   */
  readonly maxRetries?: number | undefined;
}

/**
 * One content block of an answer, as this file reads it.
 *
 * Every member except `type` is optional because the block types are a union: a
 * text block has `text`, a tool-use block has `id`, `name` and `input`, and the
 * rest have neither. Reading them as optional is what lets one loop walk the
 * whole array without a cast — and `noUncheckedIndexedAccess` means an index
 * into that array is checked for `undefined` at every use.
 */
export interface AnthropicContentBlockLike {
  /** The block's discriminant: `'text'` and `'tool_use'` are the two read. */
  readonly type: string;

  /** A text block's text. */
  readonly text?: string;

  /** A tool-use block's provider-assigned call id. */
  readonly id?: string;

  /** A tool-use block's tool name, as the model named it. */
  readonly name?: string;

  /** A tool-use block's argument object, unvalidated. */
  readonly input?: unknown;
}

/**
 * Token accounting as the provider reports it, mapped to {@link TokenUsage}
 * only when both counts are present.
 *
 * Both fields are optional here even though the provider always sends them: an
 * absent usage must read as "unknown" rather than as zero (`./types.ts` on
 * `TokenUsage`), and a fake that has nothing to report should be able to omit
 * it entirely.
 */
export interface AnthropicUsageLike {
  /** Tokens the request consumed. */
  readonly input_tokens?: number;

  /** Tokens the answer consumed. */
  readonly output_tokens?: number;
}

/**
 * One answer, as this file reads it.
 *
 * `parsed_output` is the SDK's structured-output slot. This file prefers to
 * decode the answer's text itself — so the same code path serves `create` and
 * `parse`, a real client and a fake — and consults this field only when there
 * was no text to decode.
 */
export interface AnthropicMessageLike {
  /** The model that answered, as the provider reports it. */
  readonly model?: string;

  /** Why generation stopped, in the provider's own vocabulary. */
  readonly stop_reason?: string | null;

  /** The answer's content blocks, in the order the provider returned them. */
  readonly content: readonly AnthropicContentBlockLike[];

  /** Token accounting, when the provider reports it. */
  readonly usage?: AnthropicUsageLike | null;

  /** The SDK's decoded structured output, when its parse path produced one. */
  readonly parsed_output?: unknown;
}

/**
 * The request parameters this seam carries.
 *
 * Intentionally wide: the two required fields are typed loosely enough that the
 * SDK's own parameter type is assignable to this one, which is what makes the
 * real client satisfy {@link AnthropicClientLike} by assignment. Everything
 * optional is `unknown` for the same reason — the SDK's `system` accepts text
 * blocks as well as a string, its `messages` admit a third role, and this seam
 * has no reason to restate any of that.
 */
export interface AnthropicMessageParamsLike {
  /** The model to call. Comes from `ModelProviderConfig.model` and nowhere else. */
  readonly model: string;

  /** The response-length bound the messages API requires on every request. */
  readonly max_tokens: number;

  /** The conversation, oldest turn first. */
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];

  /** The system instruction, when the stage has one. */
  readonly system?: unknown;

  /**
   * Sampling temperature — deprecated at the messages API, and a field this
   * provider never sets.
   *
   * Declared because the parameter shape still carries it, so a test can assert
   * its absence on a recorded call rather than trusting that it was dropped.
   */
  readonly temperature?: unknown;

  /** Tool declarations, on the tool routes only. */
  readonly tools?: unknown;

  /** How the model may use the declared tools. */
  readonly tool_choice?: unknown;

  /** The structured-output format, on the parse route only. */
  readonly output_config?: unknown;
}

/**
 * The messages API this provider calls.
 *
 * `parse` is **optional**, and that is a functional statement rather than a
 * convenience: a client that does not offer it is one of the documented reasons
 * the structured call takes its tool route, so a fake omits `parse` to drive
 * that branch and provides it to drive the other.
 */
export interface AnthropicMessagesLike {
  /**
   * Sends one request and returns the answer.
   *
   * @param params The request parameters.
   * @param options Per-call transport options, carrying the abort signal.
   * @returns The provider's answer.
   */
  create(
    params: AnthropicMessageParamsLike,
    options?: AnthropicRequestOptionsLike,
  ): Promise<AnthropicMessageLike>;

  /**
   * Sends one request whose `output_config.format` constrains the answer, and
   * returns it with the format's decoded output attached.
   *
   * @param params The request parameters, including the output format.
   * @param options Per-call transport options, carrying the abort signal.
   * @returns The provider's answer.
   */
  parse?(
    params: AnthropicMessageParamsLike,
    options?: AnthropicRequestOptionsLike,
  ): Promise<AnthropicMessageLike>;
}

/**
 * The client this provider drives.
 *
 * One member, because one is all this file uses. The real SDK client satisfies
 * it by assignment, and so does `{ messages: { create: () => … } }`.
 *
 * @example A fake that answers one structured call
 * ```ts
 * const client: AnthropicClientLike = {
 *   messages: {
 *     create: () =>
 *       Promise.resolve({ content: [{ type: 'text', text: '{"ok":true}' }] }),
 *   },
 * };
 * ```
 */
export interface AnthropicClientLike {
  /** The messages API. */
  readonly messages: AnthropicMessagesLike;
}

// ---------------------------------------------------------------------------
// Construction options
// ---------------------------------------------------------------------------

/**
 * How a structured call asks for its answer.
 *
 * `'auto'` is the product's behaviour: the schema-constrained parse route,
 * falling back once to a forced tool call for the cases that route cannot serve
 * (no `parse` capability, a schema the format renderer refuses, a platform that
 * rejects the format, an answer with nothing in it). The other two exist so a
 * test — and a host debugging a provider-side change — can pin one route and
 * observe it in isolation, which an `'auto'` run cannot guarantee.
 */
export const ANTHROPIC_STRUCTURED_OUTPUT_MODES = ['auto', 'parse-only', 'tool-only'] as const;

/** One of the modes in {@link ANTHROPIC_STRUCTURED_OUTPUT_MODES}. */
export type AnthropicStructuredOutputMode = (typeof ANTHROPIC_STRUCTURED_OUTPUT_MODES)[number];

/**
 * Everything {@link createAnthropicProvider} needs.
 *
 * `config` is the only required member: it is what `../factory.ts` resolved
 * from the host's configuration, and this file reads it rather than reading an
 * environment variable of its own.
 */
export interface AnthropicProviderOptions {
  /**
   * The resolved configuration: model, credential, base URL, budgets and the
   * transport retry bound.
   *
   * Re-validated here even though the factory validated it, because this is the
   * boundary that owns the transport: a provider that cannot possibly succeed
   * should fail at construction, where the host can report it, rather than at
   * the first stage of a session.
   */
  readonly config: ModelProviderConfig;

  /**
   * A client to use instead of constructing one.
   *
   * The test seam. When it is present no SDK client is built and no credential
   * is required — the credential belongs to whoever supplied the client — so a
   * suite can exercise every branch of this file offline.
   */
  readonly client?: AnthropicClientLike;

  /**
   * Where this provider logs. Defaults to `noopLogger`, so library code is
   * silent until a host asks for output.
   *
   * A logger performs no redaction, so what is logged here is limited to
   * provenance (stage, prompt version, session id), route and outcome labels,
   * failing field *paths* and counts. No prompt, no answer, no payload value
   * and nothing about a credential.
   */
  readonly logger?: Logger;

  /**
   * Which structured-output route to take. Defaults to `'auto'`.
   *
   * Also readable from `config` is not an option: `ModelProviderConfig` is the
   * shared configuration shape and this knob is specific to this
   * implementation, so it lives here rather than widening a type every
   * provider shares.
   */
  readonly structuredOutputMode?: AnthropicStructuredOutputMode;
}

// ---------------------------------------------------------------------------
// Transport budgets
// ---------------------------------------------------------------------------

/**
 * The two bounds every call this provider makes is subject to.
 *
 * Both are resolved to a concrete number rather than left optional, which is
 * the whole point of the type: an optional budget is one a dependency's default
 * silently answers for the product.
 */
export interface AnthropicTransportBudgets {
  /** How long one request may take, in milliseconds. */
  readonly timeoutMs: number;

  /** How many times a request that produced no answer is re-sent. */
  readonly maxRetries: number;
}

/**
 * Resolves the effective transport budgets for one configuration.
 *
 * Precedence is the host's configuration, then this module's documented
 * defaults, per budget rather than per object: a host that set only a timeout
 * keeps its timeout and is given the default retry count.
 *
 * Exported and called from two places, deliberately. `../factory.ts` applies it
 * to the configuration it hands over, so the configuration a provider is
 * *constructed from* already states both bounds; this file applies it again to
 * whatever configuration it receives, so a host that bypasses the factory and
 * constructs a provider directly gets the same bounds rather than the vendor
 * client's. Applying it twice is idempotent — the second application sees the
 * values the first resolved — and having one definition of the fallback is what
 * makes the two boundaries incapable of disagreeing.
 *
 * Validation is **not** its job: a malformed budget is refused by
 * {@link createAnthropicProvider} (and one boundary earlier by the factory)
 * rather than replaced here, because substituting a default for a value the
 * host got wrong hides the mistake. A value present and unusable therefore
 * travels through this function untouched and fails validation immediately
 * afterwards.
 *
 * @param config The configuration a provider is being built from.
 * @returns Both budgets, each a concrete number.
 */
export function resolveAnthropicTransportBudgets(
  config: ModelProviderConfig,
): AnthropicTransportBudgets {
  return {
    timeoutMs: config.timeoutMs ?? ANTHROPIC_DEFAULT_TIMEOUT_MS,
    maxRetries: config.maxRetries ?? ANTHROPIC_DEFAULT_MAX_RETRIES,
  };
}

// ---------------------------------------------------------------------------
// Reading values defensively
// ---------------------------------------------------------------------------

/**
 * Reads one property off a value that may not be an object at all.
 *
 * Used for two kinds of value this file cannot make claims about: a thrown
 * error, which may be an SDK error, a `DOMException`, a rejected string or
 * anything else a transport produced, and a request's provenance inside a
 * failure builder. The last thing between a payload and a failure report must
 * not itself throw, and a single narrow reader is what keeps that true without
 * an assertion at every access.
 *
 * @param value Any value, including `undefined` and `null`.
 * @param key The property to read.
 * @returns The property's value, or `undefined` when `value` is not an object.
 */
function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as Readonly<Record<string, unknown>>)[key];
}

/** The property's value when it is a non-empty string, otherwise `undefined`. */
function readNonEmptyString(value: unknown, key: string): string | undefined {
  const read = readProperty(value, key);
  return typeof read === 'string' && read.length > 0 ? read : undefined;
}

/**
 * The provenance a log record and a failure's `details` carry: which stage
 * asked, with which prompt version, for which session.
 *
 * None of it is payload — a stage name and a prompt version are repository
 * constants and a session id is an opaque product identifier — and all of it is
 * read defensively for the reason given on {@link readProperty}.
 *
 * @param request The request the call belongs to.
 * @returns Log fields naming the stage, the prompt version and the session.
 */
function requestProvenance(request: ModelRequest): LogFields {
  const metadata: unknown = readProperty(request, 'metadata');
  const fields: LogFields = { providerId: PROVIDER_ID };
  const stage = readNonEmptyString(metadata, 'stage');
  if (stage !== undefined) {
    fields.stage = stage;
  }
  const promptVersion = readNonEmptyString(metadata, 'promptVersion');
  if (promptVersion !== undefined) {
    fields.promptVersion = promptVersion;
  }
  const sessionId = readNonEmptyString(metadata, 'sessionId');
  if (sessionId !== undefined) {
    fields.sessionId = sessionId;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Typed failures
// ---------------------------------------------------------------------------

/**
 * Everything a failure carries beyond its code and its message.
 *
 * `condition` is this file's own short label for *which* failure it was —
 * `'unauthorized'`, `'quota-exhausted'`, `'unreachable'` — and it travels in
 * `details` rather than in the code, because AAP §0.5.5 fixes one sentence for
 * an unavailable provider while a user interface still needs to tell a rejected
 * credential from an exhausted quota.
 */
interface FailureContext {
  /** This file's label for the failure, for `details.condition`. */
  readonly condition: string;

  /** The developer's next step, forwarded to the user interfaces by `toPayload`. */
  readonly hint: string;

  /** The request the call belonged to, when there was one. */
  readonly request?: ModelRequest;

  /** The value that was thrown or rejected, kept as the error's `cause`. */
  readonly cause?: unknown;

  /** The HTTP status the provider answered with, when it answered at all. */
  readonly status?: number;
}

/**
 * Assembles the `details` of one failure.
 *
 * **Nothing about a credential goes in here, ever** — not a value, not a
 * prefix, not a length — and neither does any part of the payload. What does:
 * the provenance, this file's condition label, the HTTP status and the
 * provider's own opaque request id, which is the identifier a provider's
 * support would ask for. `details` is logged, persisted with a session and
 * rendered, so everything in it must be safe to read aloud.
 */
function failureDetails(context: FailureContext): Readonly<Record<string, unknown>> {
  const details: Record<string, unknown> =
    context.request === undefined
      ? { providerId: PROVIDER_ID }
      : { ...requestProvenance(context.request) };
  details.condition = context.condition;
  if (context.status !== undefined) {
    details.status = context.status;
  }
  const providerRequestId = readNonEmptyString(context.cause, 'requestID');
  if (providerRequestId !== undefined) {
    details.providerRequestId = providerRequestId;
  }
  return Object.freeze(details);
}

/**
 * Builds a failure whose message is AAP §0.5.5's sentence.
 *
 * > `Model provider unavailable (‹code›). Check ANTHROPIC_API_KEY or switch
 * > DEBUGGEN_PROVIDER.`
 *
 * The sentence has **one** definition, `modelUnavailableMessage` in
 * `../factory.ts`, and this is the only place this file produces it — the
 * factory raises the same sentence for a configuration it could not resolve, so
 * a developer sees identical wording whichever boundary refused. The argument
 * is always the `DebuggenErrorCode` this failure carries, so the code a user
 * interface branches on and the code the sentence quotes cannot drift apart.
 *
 * Called from function bodies only. See this module's overview for why: the
 * import edge to `../factory.js` closes a cycle that is safe at call time and
 * would throw during module evaluation.
 *
 * @param code The closed-vocabulary code this failure carries.
 * @param context The condition, the hint and the diagnostic context.
 * @returns The failure, with the thrown value preserved as its `cause`.
 */
function unavailableFailure(code: DebuggenErrorCode, context: FailureContext): DebuggenError {
  return new DebuggenError(code, modelUnavailableMessage(code), {
    hint: context.hint,
    details: failureDetails(context),
    cause: context.cause,
  });
}

/**
 * Builds a failure that is not about the provider being unavailable.
 *
 * Three outcomes need their own words rather than §0.5.5's sentence, because
 * the provider answered and the problem is elsewhere: a request budget the
 * messages API cannot accept, an answer with no text in it, and an authoring
 * schema that cannot be rendered for a model. Telling a developer to check a
 * credential in those cases would send them to the wrong place.
 *
 * @param code The closed-vocabulary code this failure carries.
 * @param message What happened, in the developer's language.
 * @param context The condition, the hint and the diagnostic context.
 * @returns The failure, with the thrown value preserved as its `cause`.
 */
function codedFailure(
  code: DebuggenErrorCode,
  message: string,
  context: FailureContext,
): DebuggenError {
  return new DebuggenError(code, message, {
    hint: context.hint,
    details: failureDetails(context),
    cause: context.cause,
  });
}

/** The HTTP status a thrown transport error reports, when it reports one. */
function httpStatusOf(cause: unknown): number | undefined {
  const status = readProperty(cause, 'status');
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/**
 * Whether a thrown value represents a cancellation rather than a failure.
 *
 * Three shapes reach here: the SDK's own user-abort error, which is recognised
 * by identity; a `DOMException` named `AbortError`, which is what an aborted
 * `fetch` rejects with; and `TimeoutError`, which is what a signal from
 * `AbortSignal.timeout` produces. A call's own signal is checked *before* this,
 * so an injected client that simply rejects on abort is classified correctly
 * too.
 */
function isCancellation(cause: unknown): boolean {
  if (cause instanceof APIUserAbortError) {
    return true;
  }
  const name = readProperty(cause, 'name');
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * The fragments of a `400` report that mean the platform refused the output
 * format rather than the request, lower-cased.
 *
 * Two families, both the provider's own wording and nothing about the
 * application under test:
 *
 * - **The format parameter by name** — `output_config`, `output format`,
 *   `json_schema`, `structured output` — for a platform or model that does not
 *   accept the parameter or the schema placed in it.
 * - **Grammar compilation** — `compiled grammar`, `grammar compilation`,
 *   `too complex for compilation`, `schema is too complex`, `too many optional
 *   parameters` — for a schema the platform accepts in principle but refuses to
 *   compile into its constrained-decoding grammar. Observed wording: "The
 *   compiled grammar is too large, which would cause performance issues.
 *   Simplify your tool schemas or reduce the number of strict tools.";
 *   "Schemas contains too many optional parameters (28), which would make
 *   grammar compilation inefficient. Reduce the number of optional parameters
 *   in your tool schemas (limit: 24)."; and the documented "Schema is too
 *   complex for compilation.". The forced tool route is not strict and
 *   compiles no grammar, so it can still serve the call.
 */
const OUTPUT_FORMAT_REFUSAL_FRAGMENTS: readonly string[] = Object.freeze([
  'output_config',
  'output format',
  'json_schema',
  'structured output',
  'compiled grammar',
  'grammar compilation',
  'too complex for compilation',
  'schema is too complex',
  'too many optional parameters',
]);

/**
 * Whether a refused request was refused *because of the output format*.
 *
 * This is the one string-matching heuristic in the file, and it is deliberately
 * narrow: a `400` whose report names the output-format parameter, or states
 * that the schema could not be compiled into a constrained-decoding grammar
 * ({@link OUTPUT_FORMAT_REFUSAL_FRAGMENTS}), is the signal that the
 * schema-constrained route cannot serve this schema, which is exactly the case
 * the forced-`tool_use` fallback exists for. Anything else — a
 * credential, a quota, a server failure, any other malformed request — is a
 * failure rather than a reason to try the other route.
 *
 * A false negative costs one honest `Err` instead of one fallback attempt, and
 * a false positive costs one extra attempt that either succeeds or reports the
 * same class of failure again. Neither can turn a failure into a result.
 */
function isOutputFormatRefusal(cause: unknown): boolean {
  if (httpStatusOf(cause) !== 400) {
    return false;
  }
  const report = readNonEmptyString(cause, 'message')?.toLowerCase();
  if (report === undefined) {
    return false;
  }
  return OUTPUT_FORMAT_REFUSAL_FRAGMENTS.some((fragment) => report.includes(fragment));
}

/**
 * Classifies a thrown transport failure into one coded, actionable error.
 *
 * Cancellation is tested first — an abandoned call is not a provider fault —
 * and the rest is driven by the HTTP status, because that is what the provider
 * actually told us: a credential was rejected, a quota is exhausted, the
 * provider itself failed, the request was refused, or nothing arrived at all.
 *
 * The thrown value is attached as `cause` and **never copied into the message,
 * the hint or the details**: a provider's report is its own and can quote
 * whatever it likes from a request, while `cause` is excluded from
 * `DebuggenError.toPayload` and stays in this process's log.
 *
 * @param cause The value the transport threw or rejected with.
 * @param request The request the call belonged to.
 * @returns The coded failure to return as an `Err`.
 */
function classifyTransportFailure(cause: unknown, request: ModelRequest): DebuggenError {
  if (request.signal?.aborted === true || isCancellation(cause)) {
    return unavailableFailure('MODEL_UNAVAILABLE', {
      condition: 'cancelled',
      hint: ABORTED_HINT,
      request,
      cause,
    });
  }

  const status = httpStatusOf(cause);
  if (status === 401 || status === 403) {
    return unavailableFailure('MODEL_UNAVAILABLE', {
      condition: 'unauthorized',
      hint: UNAUTHORIZED_HINT,
      request,
      cause,
      status,
    });
  }
  if (status === 429) {
    return unavailableFailure('MODEL_UNAVAILABLE', {
      condition: 'quota-exhausted',
      hint: RATE_LIMIT_HINT,
      request,
      cause,
      status,
    });
  }
  if (status !== undefined && status >= 500) {
    return unavailableFailure('MODEL_UNAVAILABLE', {
      condition: 'provider-error',
      hint: SERVER_ERROR_HINT,
      request,
      cause,
      status,
    });
  }
  if (status !== undefined) {
    return unavailableFailure('MODEL_UNAVAILABLE', {
      condition: 'refused',
      hint: REFUSED_HINT,
      request,
      cause,
      status,
    });
  }
  return unavailableFailure('MODEL_UNAVAILABLE', {
    condition: 'unreachable',
    hint: UNREACHABLE_HINT,
    request,
    cause,
  });
}

// ---------------------------------------------------------------------------
// Building a request
// ---------------------------------------------------------------------------

/**
 * Maps a request's prose onto the messages API's turn list.
 *
 * ## The conversation is assembled, not inferred
 *
 * `./types.ts` gives a request one rendered `prompt` and an optional list of
 * **prior turns**, and that list can hold two kinds of turn at once, wanting
 * opposite sides of the prompt:
 *
 * - A **follow-up** stage carries the earlier exchange, oldest first. It
 *   *precedes* the prompt, which is the new instruction; placing the prompt
 *   before it would leave the model continuing an earlier answer instead of
 *   answering the new question.
 * - A **repair** attempt (`buildRepairRequest` in `./structured.ts`) appends an
 *   assistant turn stating that the previous answer failed, followed by the
 *   correction. Those *follow* the prompt, which is the task they correct.
 *
 * The turn list is therefore built in one fixed order — **prior exchange,
 * prompt, failure notice, correction** — and the boundary between the two kinds
 * is read from the repair turns themselves rather than guessed at. The notice
 * is `REPAIR_ASSISTANT_NOTICE`, imported from the module that appends it, so
 * there is one definition of that marker and no sentence repeated here; the
 * first turn carrying it begins the correcting suffix, and everything before it
 * is prior exchange.
 *
 * Deciding from the *first* prior turn's role instead — the shape this function
 * had — got the two ordinary cases right and the combination wrong: a follow-up
 * whose answer then failed its schema arrives with a user-first exchange *and* a
 * repair suffix, and a rule keyed on the first turn puts the prompt last, after
 * the correction, so the model is told to fix an answer to a task it has not
 * been given yet. That is the one arrangement in which a repair cannot work,
 * and it is reachable from the product's own follow-up stage.
 *
 * ## The one invariant the API imposes
 *
 * The messages API expects the conversation to open with a user turn. Prior
 * exchange that opens with an assistant turn cannot legally lead, so in that
 * case — a caller defect rather than either documented shape — the prompt is
 * emitted first, ahead of it. This is a validity guard and nothing more: it
 * never decides where a *correction* goes, which is what the marker above
 * settles. Consecutive turns of the same role are the provider's to merge.
 *
 * @param request The request to send.
 * @returns The turn list, oldest first, always beginning with a user turn.
 */
function toProviderMessages(request: ModelRequest): MessageParam[] {
  const promptTurn: MessageParam = { role: 'user', content: request.prompt };
  const priorTurns: readonly ModelMessage[] = request.messages ?? [];
  if (priorTurns.length === 0) {
    return [promptTurn];
  }

  const correctionStart = priorTurns.findIndex(
    (turn) => turn.role === 'assistant' && turn.content === REPAIR_ASSISTANT_NOTICE,
  );
  const exchange = (correctionStart === -1 ? priorTurns : priorTurns.slice(0, correctionStart)).map(
    toProviderTurn,
  );
  const correction = (correctionStart === -1 ? [] : priorTurns.slice(correctionStart)).map(
    toProviderTurn,
  );

  // A prior exchange that cannot open the conversation is placed after the
  // prompt; see the note on the API's invariant above.
  return exchange[0]?.role === 'assistant'
    ? [promptTurn, ...exchange, ...correction]
    : [...exchange, promptTurn, ...correction];
}

/** One prior turn, in the shape the messages API takes. */
function toProviderTurn(turn: ModelMessage): MessageParam {
  return { role: turn.role, content: turn.content };
}

/**
 * Resolves the response-length bound for one call.
 *
 * Precedence is the call, then the configuration, then
 * {@link DEFAULT_MAX_OUTPUT_TOKENS} — `./types.ts` defines the first two, and
 * the third exists only because the messages API requires the field while both
 * of those are optional.
 *
 * A value that is present but unusable is a **caller** defect and is reported
 * as one rather than replaced: silently substituting a default would hide a
 * mistake in the configuration a session records.
 */
function resolveMaxTokens(
  request: ModelRequest,
  configured: number | undefined,
): Result<number, DebuggenError> {
  const requested = request.maxTokens ?? configured;
  if (requested === undefined) {
    return ok(DEFAULT_MAX_OUTPUT_TOKENS);
  }
  if (!Number.isInteger(requested) || requested <= 0) {
    return err(
      codedFailure(
        'CONFIG_INVALID',
        `A response-length bound must be a positive integer; this call asked for ${String(requested)}.`,
        { condition: 'max-tokens-invalid', hint: INVALID_BUDGET_HINT, request },
      ),
    );
  }
  return ok(requested);
}

/**
 * Checks the sampling temperature one call asks for, and never produces one to
 * send.
 *
 * The field is deprecated at the messages API:
 * {@link ANTHROPIC_SUPPORTED_TEMPERATURE} is accepted for backwards
 * compatibility and every other value is rejected with a 400. Three
 * consequences, in the order they matter:
 *
 * - **Nothing is transmitted.** The accepted value is the API's own default, so
 *   omitting the field is behaviourally identical to sending it while being
 *   immune to the deprecation being completed.
 * - **An unsupported value fails here, not at the provider.** A configuration
 *   carrying one would otherwise turn every call of every stage in the session
 *   into a refusal, reported as an unavailable provider — a developer sent to
 *   check a credential for a sampling setting. Refusing it locally names the
 *   real cause once, in the same shape as every other unusable budget: a
 *   caller defect reported rather than silently replaced.
 * - **No model is consulted.** Gating the field on a model's capabilities would
 *   require model identifiers in this package, which AAP §0.5.3 forbids; the
 *   API's own rule is the only rule available, and it is the conservative one.
 *
 * @param request The request being built, for the failure's provenance.
 * @param configured The configuration's temperature, when it set one.
 * @returns `Ok` when nothing needs sending, or the coded refusal.
 */
function checkTemperature(
  request: ModelRequest,
  configured: number | undefined,
): Result<void, DebuggenError> {
  const requested = request.temperature ?? configured;
  if (requested === undefined || requested === ANTHROPIC_SUPPORTED_TEMPERATURE) {
    return ok(undefined);
  }
  return err(
    codedFailure(
      'CONFIG_INVALID',
      `A sampling temperature other than ${String(ANTHROPIC_SUPPORTED_TEMPERATURE)} is no longer accepted by the messages API; this call asked for ${String(requested)}.`,
      { condition: 'temperature-invalid', hint: UNSUPPORTED_TEMPERATURE_HINT, request },
    ),
  );
}

// ---------------------------------------------------------------------------
// Reading an answer
// ---------------------------------------------------------------------------

/** Every text block of an answer, concatenated in the order they arrived. */
function collectText(message: AnthropicMessageLike): string {
  let text = '';
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

/**
 * The provider's token accounting, when it reported a usable pair.
 *
 * Both counts are required for a {@link TokenUsage}, and an absent usage must
 * read as "unknown" rather than as zero, so a partial report is dropped rather
 * than completed with a guess. `totalTokens` is left absent because this
 * provider does not report one: `./types.ts` explains that carrying a computed
 * sum would misreport an accounting that may include tokens in neither field.
 */
function readUsage(message: AnthropicMessageLike): TokenUsage | undefined {
  const usage = message.usage;
  if (usage === undefined || usage === null) {
    return undefined;
  }
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

/** Why generation stopped, in the provider's own vocabulary, when it said. */
function readStopReason(message: AnthropicMessageLike): string | undefined {
  const reason = message.stop_reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
}

/**
 * The model that answered.
 *
 * The provider's own report wins, because it may be more specific than what was
 * asked for — a pinned build of a requested alias. The fallback is the
 * *configured* model and never a literal: there is no model identifier in this
 * file.
 */
function readModel(message: AnthropicMessageLike, configured: string): string {
  const reported = message.model;
  return typeof reported === 'string' && reported.length > 0 ? reported : configured;
}

/** What a decode attempt produced: a value, or nothing usable. */
type DecodedOutput =
  { readonly decoded: true; readonly value: unknown } | { readonly decoded: false };

/**
 * Decodes one JSON answer without throwing.
 *
 * Total by construction, and that is the point: a model that answered with
 * something other than JSON is an ordinary outcome the repair loop exists to
 * correct (`./structured.js` classifies it from `raw` being absent while `text`
 * is present), so it must arrive as data rather than as an exception.
 */
function decodeJson(text: string): DecodedOutput {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { decoded: false };
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return { decoded: true, value };
  } catch {
    return { decoded: false };
  }
}

/**
 * The field paths a validation miss failed at, for one log record.
 *
 * Paths and counts only — never a value, and never the schema's own message
 * either, since a message can quote the value it rejected. Bounded, deduplicated
 * and ordered as the validator reported them, so a repeated failure reads the
 * same way twice.
 */
function issuePathsOf(error: ZodError): string[] {
  const paths: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map((segment) => String(segment)).join('.');
    const label = path.length > 0 ? path : ROOT_ISSUE_PATH;
    if (!paths.includes(label)) {
      paths.push(label);
    }
    if (paths.length >= MAX_LOGGED_ISSUE_PATHS) {
      break;
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Structured-output plumbing
// ---------------------------------------------------------------------------

/**
 * The output format this provider sends, and the reason it is assembled rather
 * than used as the helper returns it.
 *
 * `schema` is `zodOutputFormat`'s output: the caller's schema rendered and then
 * stripped of the JSON-Schema keywords the platform's structured-output format
 * does not support (AAP §0.2.4). That is the half that constrains generation,
 * and it is used unchanged.
 *
 * `parse` replaces the helper's own callback, which runs the caller's schema
 * and **throws** on a miss. The SDK invokes that callback on every text block,
 * so handing it through would convert an ordinary schema miss into an
 * exception — losing the decoded output the repair loop needs and breaking the
 * rule that only a call-level failure is an `Err`. This one never throws, and
 * validation happens in {@link AnthropicProvider} where a miss is data.
 */
interface StructuredOutputFormat {
  /** The platform's discriminant for a JSON-Schema-constrained answer. */
  readonly type: 'json_schema';

  /** The keyword-stripped JSON Schema the platform constrains generation with. */
  readonly schema: Readonly<Record<string, unknown>>;

  /** A total decoder: the decoded value, or `null` when the answer was not JSON. */
  parse(content: string): unknown;
}

/**
 * Renders one authoring schema into the structured-output format.
 *
 * @typeParam T The caller's authoring type.
 * @param schema The caller's authoring schema.
 * @returns The format to send, or an `Err` when the schema cannot be rendered
 * for a model at all — which is a product defect in the stage's schema rather
 * than a provider failure, hence `INTERNAL`.
 */
function buildOutputFormat<T>(schema: ZodType<T>): Result<StructuredOutputFormat, DebuggenError> {
  const rendered = tryCatch<Readonly<Record<string, unknown>>>(
    () => zodOutputFormat(schema).schema,
    'INTERNAL',
  );
  if (!rendered.ok) {
    return err(
      codedFailure(
        'INTERNAL',
        "The stage's authoring schema could not be rendered as a structured-output format.",
        { condition: 'schema-unrenderable', hint: SCHEMA_RENDER_HINT, cause: rendered.error },
      ),
    );
  }

  return ok({
    type: 'json_schema',
    schema: rendered.value,
    parse: (content: string): unknown => {
      const decoded = decodeJson(content);
      return decoded.decoded ? decoded.value : null;
    },
  });
}

/**
 * Renders one authoring schema as a tool's `input_schema` for the fallback
 * route.
 *
 * Rendered with `io: 'input'`, because a tool's arguments are an *input* to the
 * caller's schema, and with unrepresentable constructs widened rather than
 * refused: the fallback exists to serve a schema the strict renderer would not,
 * and local re-validation is what actually admits the answer, so a looser
 * model-side constraint costs nothing but a repair attempt.
 *
 * A non-object schema is refused. The messages API's tool arguments are an
 * object by definition, and quietly wrapping a non-object schema in one would
 * change the shape of the answer this provider reports as `raw`.
 */
function buildToolInputSchema<T>(
  schema: ZodType<T>,
  request: ModelRequest,
): Result<Tool.InputSchema, DebuggenError> {
  const rendered = tryCatch<Readonly<Record<string, unknown>>>(
    () =>
      z.toJSONSchema(schema, {
        target: 'draft-2020-12',
        io: 'input',
        unrepresentable: 'any',
        cycles: 'ref',
        reused: 'ref',
      }),
    'INTERNAL',
  );
  if (!rendered.ok) {
    return err(
      codedFailure(
        'INTERNAL',
        "The stage's authoring schema could not be rendered as a tool input schema.",
        {
          condition: 'schema-unrenderable',
          hint: SCHEMA_RENDER_HINT,
          request,
          cause: rendered.error,
        },
      ),
    );
  }
  if (rendered.value.type !== 'object') {
    return err(
      codedFailure(
        'INTERNAL',
        'The tool route needs an authoring schema whose root is an object, and this one is not.',
        { condition: 'schema-not-an-object', hint: SCHEMA_RENDER_HINT, request },
      ),
    );
  }

  return ok({ ...rendered.value, type: 'object' });
}

/**
 * The tool name the fallback route declares, derived from the calling stage.
 *
 * Sanitised and bounded to what the messages API accepts for a tool name, so
 * the property holds by construction rather than by the stage vocabulary
 * happening to be safe today.
 */
function structuredToolName(stage: PromptStage): string {
  const suffix = stage.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${STRUCTURED_TOOL_NAME_PREFIX}${suffix}`.slice(0, 64);
}

/**
 * Renders the caller's tool declarations for the model.
 *
 * Declarations only: a name, a purpose and an argument schema. Nothing here
 * executes anything — see {@link AnthropicProvider.callTools} — and a schema
 * that cannot be rendered names the tool it belongs to, because that is what a
 * caller needs to fix it.
 */
function declareTools(
  tools: readonly ToolDefinition[],
  request: ModelRequest,
): Result<Tool[], DebuggenError> {
  const declared: Tool[] = [];
  for (const tool of tools) {
    const inputSchema = buildToolInputSchema(tool.inputSchema, request);
    if (!inputSchema.ok) {
      return err(
        codedFailure(
          'INTERNAL',
          `The declared tool "${tool.name}" has an argument schema that cannot be rendered for a model.`,
          {
            condition: 'tool-schema-unrenderable',
            hint: SCHEMA_RENDER_HINT,
            request,
            cause: inputSchema.error,
          },
        ),
      );
    }
    declared.push({
      name: tool.name,
      description: tool.description,
      input_schema: inputSchema.value,
    });
  }
  return ok(declared);
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/** What the schema-constrained route produced, from the caller's point of view. */
type ParseRouteOutcome =
  | { readonly kind: 'answered'; readonly message: AnthropicMessageLike }
  | { readonly kind: 'unsupported'; readonly error: DebuggenError }
  | { readonly kind: 'failed'; readonly error: DebuggenError };

/** Which route produced an attempt, for a log record. */
type StructuredRoute = 'schema-constrained' | 'tool';

/**
 * The provider itself.
 *
 * Not exported: {@link createAnthropicProvider} is the only way to obtain one,
 * because construction can fail and a constructor cannot return a `Result`
 * without throwing — and `./provider.ts` requires an expected failure to be a
 * value rather than an exception. A caller holds the
 * {@link DisposableModelProvider} interface, never this class, which is also
 * what makes the structural guard in `./provider.ts` the right way to check a
 * provider that arrived from configuration-driven construction.
 */
class AnthropicProvider implements DisposableModelProvider {
  /** This implementation's id, on every response it returns. */
  readonly id = PROVIDER_ID;

  /** The transport: the SDK's client, or whatever a host injected in its place. */
  readonly #client: AnthropicClientLike;

  /** The resolved configuration this provider was built from. */
  readonly #config: ModelProviderConfig;

  /**
   * The transport bounds every call is subject to, each a concrete number.
   *
   * Resolved once here rather than read from the configuration per call, so the
   * per-call options cannot be left without a timeout by a configuration that
   * named none — which is the state in which a dependency's default silently
   * decides how long a stage may hang.
   */
  readonly #budgets: AnthropicTransportBudgets;

  /** Where this provider logs. Never a payload, never a credential. */
  readonly #logger: Logger;

  /** Which structured-output route to take. */
  readonly #structuredOutputMode: AnthropicStructuredOutputMode;

  /** Whether {@link close} has run. Terminal: a closed provider never reopens. */
  #closed = false;

  constructor(
    client: AnthropicClientLike,
    config: ModelProviderConfig,
    logger: Logger,
    structuredOutputMode: AnthropicStructuredOutputMode,
  ) {
    this.#client = client;
    this.#config = config;
    this.#budgets = resolveAnthropicTransportBudgets(config);
    this.#logger = logger;
    this.#structuredOutputMode = structuredOutputMode;
  }

  /**
   * Asks the model for free text.
   *
   * The guard runs first, then cancellation, then the request is built and
   * sent — the order this module's overview fixes for every call.
   *
   * An answer with no text is reported as a malformed response rather than as
   * an empty success: a stage that asked for prose and received none has
   * nothing to work with, and `''` would travel on as if it did.
   *
   * @param request The prompt, its structured context and its provenance.
   * @returns `Ok` with the text, the model and the accounting the provider
   * reported, or `Err` with a coded failure. Never throws.
   */
  async generateText(request: ModelRequest): Promise<Result<ModelTextResponse, DebuggenError>> {
    const cleared = assertOutboundSafe(request, { logger: this.#logger });
    if (!cleared.ok) {
      // Returned exactly as the guard built it: its rule ids, field paths and
      // remediation are what the guard's own suite and both user interfaces
      // expect, and re-coding it here would replace a precise refusal with a
      // vaguer one.
      return cleared;
    }
    const ready = this.#preflight(request);
    if (!ready.ok) {
      return ready;
    }
    const params = this.#baseParams(request);
    if (!params.ok) {
      return params;
    }

    const answered = await this.#create(params.value, request, 'text');
    if (!answered.ok) {
      return answered;
    }

    const message = answered.value;
    const text = collectText(message);
    if (text.length === 0) {
      return err(
        codedFailure('MODEL_OUTPUT_INVALID', 'The provider answered with no text content.', {
          condition: 'no-text-content',
          hint: NO_TEXT_HINT,
          request,
        }),
      );
    }

    const usage = readUsage(message);
    const stopReason = readStopReason(message);
    return ok({
      text,
      model: readModel(message, this.#config.model),
      providerId: this.id,
      ...(usage === undefined ? {} : { usage }),
      ...(stopReason === undefined ? {} : { stopReason }),
    });
  }

  /**
   * Asks the model for an answer shaped by the caller's schema, and returns it
   * **unvalidated by the contract's definition of validation**.
   *
   * ## Why a schema miss is `ok` and not `err`
   *
   * `./structured.js` treats a provider `Err` as a call that produced nothing
   * and short-circuits *without spending repair budget*; a schema failure is
   * the one outcome that earns a repair. If this method answered a badly shaped
   * artifact with an `Err`, the stage would lose both of its legitimate repair
   * attempts and fall back to a deterministic artifact for a reason that had
   * nothing to do with the transport. So an answer that arrived is always
   * `ok(attempt)`:
   *
   * - `raw` carries the decoded output whenever there was one. It is the single
   *   input to the authoritative validation in `./structured.js`, so an attempt
   *   without it breaks the repair mechanism.
   * - `value` is set **only** when this provider's own re-validation succeeded.
   *   It is a hint; `./structured.js` re-parses `raw` regardless, because AAP
   *   §0.2.4 records that the platform's structured-output format silently
   *   drops the JSON-Schema keywords it does not support, so a numeric bound or
   *   a refinement can survive generation unchecked. That re-validation is what
   *   makes this method able to say "the shape is right" honestly, and why it
   *   never claims so on the strength of the transport alone.
   * - `text` carries the answer's text when there was any, which is what lets a
   *   repair turn quote what came back. `raw` being absent *while* `text` is
   *   present is what marks a decode failure (`./types.js`).
   *
   * Only a call that never produced an answer is an `Err`: configuration,
   * credential, quota, transport, cancellation, or a schema this provider
   * cannot render at all.
   *
   * @typeParam T The caller's authoring type, inferred from `schema`.
   * @param schema The caller's authoring schema for the answer.
   * @param request The prompt, its structured context and its provenance.
   * @returns `Ok` with one unvalidated attempt, or `Err` with a coded failure
   * of the call itself. Never throws.
   */
  async generateStructured<T>(
    schema: ZodType<T>,
    request: ModelRequest,
  ): Promise<Result<StructuredAttempt<T>, DebuggenError>> {
    const cleared = assertOutboundSafe(request, { logger: this.#logger });
    if (!cleared.ok) {
      return cleared;
    }
    const ready = this.#preflight(request);
    if (!ready.ok) {
      return ready;
    }
    const params = this.#baseParams(request);
    if (!params.ok) {
      return params;
    }

    if (this.#structuredOutputMode !== 'tool-only') {
      const route = await this.#structuredViaSchema(schema, request, params.value);

      if (route.kind === 'failed') {
        // A transport, credential or quota failure is a failure. Trying the
        // other route would spend a second request on a condition that has
        // nothing to do with the output format.
        return err(route.error);
      }

      if (route.kind === 'answered') {
        const attempt = this.#buildAttemptFromText(
          schema,
          route.message,
          request,
          'schema-constrained',
        );
        if (attempt.raw !== undefined || attempt.text !== undefined) {
          // Output arrived — well shaped or not, decodable or not. Either way
          // the answer belongs to the validation loop, not to a second attempt
          // from here: one attempt per call, and a schema miss is its business.
          return ok(attempt);
        }
        if (this.#structuredOutputMode === 'parse-only') {
          return ok(attempt);
        }
        this.#logger.warn(
          'The schema-constrained route returned nothing at all; asking once more through the tool route',
          { ...requestProvenance(request), route: 'schema-constrained' },
        );
      } else if (this.#structuredOutputMode === 'parse-only') {
        return err(route.error);
      } else {
        this.#logger.warn(
          'The schema-constrained route cannot serve this call; asking through the tool route',
          {
            ...requestProvenance(request),
            route: 'schema-constrained',
            condition: route.error.details?.condition,
          },
        );
      }
    }

    return this.#structuredViaTool(schema, request, params.value);
  }

  /**
   * Asks the model for an answer, offering it a set of tools it may request.
   *
   * **The model's requested calls are returned and nothing more.** This
   * provider executes no tool, reads no file and touches no project: a tool is
   * a declaration here (`./types.js` on `ToolDefinition`), and in this product
   * the tools are read-only queries over an already-built code graph that
   * `apps/local-service/src/pipeline/tools/code-tools.ts` executes. That
   * separation is why a model can propose an investigation without being able
   * to perform one.
   *
   * An empty `calls` array is an ordinary outcome and means the model answered
   * without reaching for a tool. A call naming a tool that was never declared
   * is returned as it arrived — rejecting it is the caller's job, since only the
   * caller knows what it declared — but it is logged, because a model reaching
   * for something that does not exist is worth seeing.
   *
   * @param request The prompt, its structured context and its provenance.
   * @param tools The tools on offer. Read, never edited.
   * @returns `Ok` with the requested calls and any accompanying text, or `Err`
   * with a coded failure of the call itself. Never throws.
   */
  async callTools(
    request: ModelRequest,
    tools: readonly ToolDefinition[],
  ): Promise<Result<ToolCallsResponse, DebuggenError>> {
    const cleared = assertOutboundSafe(request, { logger: this.#logger });
    if (!cleared.ok) {
      return cleared;
    }
    const ready = this.#preflight(request);
    if (!ready.ok) {
      return ready;
    }
    const params = this.#baseParams(request);
    if (!params.ok) {
      return params;
    }
    const declared = declareTools(tools, request);
    if (!declared.ok) {
      return declared;
    }

    // An empty tool list is sent as no tool list at all: the messages API has
    // no use for an empty array, and a caller that offered nothing is asking a
    // plain question. It is logged because it is almost always a caller defect.
    if (declared.value.length === 0) {
      this.#logger.debug('A tool-enabled call was made with no tools declared', {
        ...requestProvenance(request),
      });
    }

    const toolParams: MessageCreateParamsNonStreaming =
      declared.value.length === 0
        ? params.value
        : { ...params.value, tools: declared.value, tool_choice: { type: 'auto' } };

    const answered = await this.#create(toolParams, request, 'tools');
    if (!answered.ok) {
      return answered;
    }

    const message = answered.value;
    const calls = this.#collectToolCalls(message, tools, request);
    const text = collectText(message);
    const usage = readUsage(message);
    const stopReason = readStopReason(message);
    return ok({
      calls,
      model: readModel(message, this.#config.model),
      providerId: this.id,
      ...(text.length === 0 ? {} : { text }),
      ...(usage === undefined ? {} : { usage }),
      ...(stopReason === undefined ? {} : { stopReason }),
    });
  }

  /**
   * Releases this provider.
   *
   * The SDK client holds no handle this file opened and offers nothing to
   * close, so disposal is a state change: the provider is marked closed and
   * every later call returns a coded failure instead of quietly using a
   * transport its owner believed it had released
   * (`./provider.ts` on `DisposableModelProvider`).
   *
   * Idempotent, terminal, and it never rejects — disposal runs on teardown
   * paths, frequently while another failure is being reported, and a rejection
   * there would replace the original failure with a teardown error. Deliberately
   * not `async`: there is nothing to await, and an `async` body with no `await`
   * is the shape that invites one to be added later.
   *
   * @returns A promise that resolves once the provider is closed.
   */
  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#logger.debug('The model provider was closed', { providerId: PROVIDER_ID });
    }
    return Promise.resolve();
  }

  /**
   * The two checks every call makes after the guard has cleared its payload:
   * that this provider is still usable, and that the work asking for the answer
   * has not been abandoned.
   *
   * Cancellation is checked **before** the transport rather than after it,
   * because a session that ended, a capture that was discarded or a follow-up
   * that superseded this stage has no use for the answer, and a request spent
   * on abandoned work is a request a developer waits for.
   */
  #preflight(request: ModelRequest): Result<void, DebuggenError> {
    if (this.#closed) {
      return err(
        unavailableFailure('MODEL_UNAVAILABLE', {
          condition: 'provider-closed',
          hint: CLOSED_HINT,
          request,
        }),
      );
    }
    if (request.signal?.aborted === true) {
      return err(
        unavailableFailure('MODEL_UNAVAILABLE', {
          condition: 'cancelled',
          hint: ABORTED_HINT,
          request,
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * The parameters every route starts from: the model, the response-length
   * bound, the conversation and the system instruction.
   *
   * Built as the SDK's own parameter type, so every field this provider sends
   * is checked against the real messages API even though the transport seam it
   * passes through is structural.
   *
   * No sampling temperature is among them, whatever the call or the
   * configuration asked for: {@link checkTemperature} either clears the call or
   * refuses it, and the field is never transmitted — see this module's overview
   * for the deprecation that settles it.
   */
  #baseParams(request: ModelRequest): Result<MessageCreateParamsNonStreaming, DebuggenError> {
    const maxTokens = resolveMaxTokens(request, this.#config.maxTokens);
    if (!maxTokens.ok) {
      return maxTokens;
    }
    const temperature = checkTemperature(request, this.#config.temperature);
    if (!temperature.ok) {
      return temperature;
    }

    const system = request.system;
    return ok({
      model: this.#config.model,
      max_tokens: maxTokens.value,
      messages: toProviderMessages(request),
      ...(system === undefined ? {} : { system }),
    });
  }

  /**
   * The per-call transport options.
   *
   * The abort signal is forwarded so an in-flight call is actually cancellable
   * rather than merely abandoned, and **both** effective budgets are carried on
   * every call — not only when a host configured them — for two reasons: an
   * injected client was never configured by this file and would otherwise apply
   * its own bounds, and a request whose duration and re-send count no product
   * decision bounds is a stage that can hang for as long as a dependency's
   * defaults allow. The vendor's client reads a per-request `maxRetries` in
   * preference to the one it was constructed with, so the two agree by
   * construction here rather than by luck.
   */
  #requestOptions(request: ModelRequest): AnthropicRequestOptionsLike {
    const signal = request.signal;
    return {
      ...(signal === undefined ? {} : { signal }),
      timeout: this.#budgets.timeoutMs,
      maxRetries: this.#budgets.maxRetries,
    };
  }

  /**
   * Sends one request and turns any thrown value into a coded failure.
   *
   * The single place this file calls `messages.create`, which is what makes the
   * "nothing reaches the transport without the guard" property checkable: this
   * method is private, and the three public methods plus the private tool route
   * — each of which opens with the guard — are its only callers.
   */
  async #create(
    params: MessageCreateParamsNonStreaming,
    request: ModelRequest,
    route: string,
  ): Promise<Result<AnthropicMessageLike, DebuggenError>> {
    this.#logger.debug('Calling the model provider', { ...requestProvenance(request), route });
    try {
      const message = await this.#client.messages.create(params, this.#requestOptions(request));
      return ok(message);
    } catch (cause) {
      return err(classifyTransportFailure(cause, request));
    }
  }

  /**
   * The schema-constrained route: one call whose `output_config.format` carries
   * the caller's schema, rendered by the SDK's own helper.
   *
   * Three outcomes, because the caller has three different things to do with
   * them: an answer to read, a condition the *other* route may be able to serve
   * (no parse capability, an unrenderable schema, a platform that refused the
   * format), and a failure that no route can fix.
   *
   * Private, and reached from {@link generateStructured} alone — immediately
   * after that method's own guard and cancellation check, with no branch in
   * between. Together with {@link #create}, whose callers are the three public
   * methods and the tool route, that accounts for every transport call in this
   * file and for the guard that precedes each of them.
   */
  async #structuredViaSchema<T>(
    schema: ZodType<T>,
    request: ModelRequest,
    base: MessageCreateParamsNonStreaming,
  ): Promise<ParseRouteOutcome> {
    const parse = this.#client.messages.parse?.bind(this.#client.messages);
    if (parse === undefined) {
      return {
        kind: 'unsupported',
        error: codedFailure('INTERNAL', 'This client offers no schema-constrained output route.', {
          condition: 'parse-route-unavailable',
          hint: PARSE_ROUTE_HINT,
          request,
        }),
      };
    }

    const format = buildOutputFormat(schema);
    if (!format.ok) {
      return { kind: 'unsupported', error: format.error };
    }

    const params: MessageCreateParamsNonStreaming = {
      ...base,
      output_config: { format: format.value },
    };
    this.#logger.debug('Calling the model provider', {
      ...requestProvenance(request),
      route: 'schema-constrained',
    });
    try {
      const message = await parse(params, this.#requestOptions(request));
      return { kind: 'answered', message };
    } catch (cause) {
      const failure = classifyTransportFailure(cause, request);
      const cancelled = request.signal?.aborted === true || isCancellation(cause);
      return !cancelled && isOutputFormatRefusal(cause)
        ? { kind: 'unsupported', error: failure }
        : { kind: 'failed', error: failure };
    }
  }

  /**
   * The fallback route: one call declaring a single tool whose `input_schema`
   * is the caller's schema, with `tool_choice` forcing it.
   *
   * Reached only from {@link generateStructured}, and only for a condition the
   * schema-constrained route cannot serve — never for a transport failure and
   * never for a schema mismatch. One attempt, not a loop.
   *
   * The outbound guard runs here as well. That is a second inspection of a
   * payload the caller already cleared, and it is deliberate: this method
   * performs a transport call, so the property "no transport call is reachable
   * without a cleared payload" holds for it on its own terms rather than by
   * trusting its caller. The guard is pure, bounded and allocates no payload
   * copy, so the cost is a walk of a payload that is already in memory.
   */
  async #structuredViaTool<T>(
    schema: ZodType<T>,
    request: ModelRequest,
    base: MessageCreateParamsNonStreaming,
  ): Promise<Result<StructuredAttempt<T>, DebuggenError>> {
    const cleared = assertOutboundSafe(request, { logger: this.#logger });
    if (!cleared.ok) {
      return cleared;
    }
    const ready = this.#preflight(request);
    if (!ready.ok) {
      return ready;
    }

    const inputSchema = buildToolInputSchema(schema, request);
    if (!inputSchema.ok) {
      return inputSchema;
    }

    const name = structuredToolName(request.metadata.stage);
    const params: MessageCreateParamsNonStreaming = {
      ...base,
      tools: [{ name, description: STRUCTURED_TOOL_DESCRIPTION, input_schema: inputSchema.value }],
      tool_choice: { type: 'tool', name, disable_parallel_tool_use: true },
    };

    const answered = await this.#create(params, request, 'tool');
    if (!answered.ok) {
      return answered;
    }
    return ok(this.#buildAttemptFromToolUse(schema, answered.value, name, request));
  }

  /**
   * Builds an attempt from an answer whose output is text.
   *
   * The answer's own text is decoded first, so one code path serves the
   * schema-constrained route, a plain call and any injected client. The SDK's
   * `parsed_output` is consulted only when there was no text to decode — it
   * holds what this provider's own total decoder produced, so it can add
   * nothing when the text decoded, and it is the last chance to find output
   * when the text was empty.
   */
  #buildAttemptFromText<T>(
    schema: ZodType<T>,
    message: AnthropicMessageLike,
    request: ModelRequest,
    route: StructuredRoute,
  ): StructuredAttempt<T> {
    const text = collectText(message);
    const decoded = decodeJson(text);
    if (decoded.decoded) {
      return this.#finishAttempt(schema, message, request, decoded, text, route);
    }

    const fromFormat = message.parsed_output;
    if (fromFormat !== undefined && fromFormat !== null) {
      return this.#finishAttempt(
        schema,
        message,
        request,
        { decoded: true, value: fromFormat },
        text,
        route,
      );
    }
    return this.#finishAttempt(schema, message, request, { decoded: false }, text, route);
  }

  /**
   * Builds an attempt from an answer whose output is a tool call's arguments.
   *
   * The forced tool choice means the model should have called exactly the tool
   * that was declared. A call under a different name is still read — the
   * arguments are what was asked for, and refusing them would waste an answer
   * over a name — but it is logged, because it means the forced choice did not
   * hold.
   */
  #buildAttemptFromToolUse<T>(
    schema: ZodType<T>,
    message: AnthropicMessageLike,
    declaredName: string,
    request: ModelRequest,
  ): StructuredAttempt<T> {
    const text = collectText(message);
    let selected: AnthropicContentBlockLike | undefined;
    for (const block of message.content) {
      if (block.type !== 'tool_use') {
        continue;
      }
      if (block.name === declaredName) {
        selected = block;
        break;
      }
      selected ??= block;
    }

    if (selected === undefined) {
      return this.#finishAttempt(schema, message, request, { decoded: false }, text, 'tool');
    }
    if (selected.name !== declaredName) {
      this.#logger.warn('The model called a tool other than the one the call forced', {
        ...requestProvenance(request),
        route: 'tool',
        declaredTool: declaredName,
        calledTool: selected.name,
      });
    }

    const input = selected.input;
    return this.#finishAttempt(
      schema,
      message,
      request,
      input === undefined ? { decoded: false } : { decoded: true, value: input },
      text,
      'tool',
    );
  }

  /**
   * Assembles one attempt and performs this provider's own re-validation.
   *
   * The re-validation is AAP §0.2.4's belt-and-braces step, and its *only*
   * effect on the returned value is whether `value` is present: `raw` is
   * carried either way, because `./structured.js` is the authoritative gate and
   * an attempt without `raw` would leave it nothing to validate or repair. A
   * miss is logged with the failing field paths and the issue count — never a
   * value, never the payload — and returned as an ordinary answer.
   *
   * A schema that *throws* while validating is treated the same way: it is a
   * defect in the stage's schema rather than a property of the answer, so the
   * answer is still reported and the throw is logged for whoever fixes it —
   * with the request's provenance, the route and the thrown error's closed code
   * only. The thrown message is never logged: a schema's refinement or a
   * value's own accessor can quote the answer it was reading, and the answer
   * is model output (CWE-532).
   */
  #finishAttempt<T>(
    schema: ZodType<T>,
    message: AnthropicMessageLike,
    request: ModelRequest,
    decoded: DecodedOutput,
    text: string,
    route: StructuredRoute,
  ): StructuredAttempt<T> {
    const usage = readUsage(message);
    const stopReason = readStopReason(message);
    const reported = {
      model: readModel(message, this.#config.model),
      providerId: this.id,
      ...(text.length === 0 ? {} : { text }),
      ...(usage === undefined ? {} : { usage }),
      ...(stopReason === undefined ? {} : { stopReason }),
    };

    if (!decoded.decoded) {
      this.#logger.warn('The provider produced no decodable structured output', {
        ...requestProvenance(request),
        route,
        hasText: text.length > 0,
      });
      return { raw: undefined, ...reported };
    }

    const raw = decoded.value;
    const validated = tryCatch(() => schema.safeParse(raw));
    if (!validated.ok) {
      this.#logger.error("The stage's authoring schema threw while validating an answer", {
        ...requestProvenance(request),
        route,
        code: validated.error.code,
      });
      return { raw, ...reported };
    }
    if (!validated.value.success) {
      this.#logger.warn(
        'The answer did not satisfy its authoring schema; the validation loop decides what happens next',
        {
          ...requestProvenance(request),
          route,
          issueCount: validated.value.error.issues.length,
          issuePaths: issuePathsOf(validated.value.error),
        },
      );
      return { raw, ...reported };
    }

    return { raw, value: validated.value.data, ...reported };
  }

  /**
   * Collects the tool calls the model asked for, in the order it asked.
   *
   * A block missing the identity a call needs is skipped and logged rather than
   * reported as a call with an invented id or name; a call naming an undeclared
   * tool is reported as it arrived, because the caller owns that decision.
   */
  #collectToolCalls(
    message: AnthropicMessageLike,
    tools: readonly ToolDefinition[],
    request: ModelRequest,
  ): ToolCall[] {
    const declaredNames = new Set(tools.map((tool) => tool.name));
    const calls: ToolCall[] = [];
    for (const block of message.content) {
      if (block.type !== 'tool_use') {
        continue;
      }
      const id = block.id;
      const name = block.name;
      if (typeof id !== 'string' || typeof name !== 'string') {
        this.#logger.warn('A tool-use block arrived without an id or a name and was skipped', {
          ...requestProvenance(request),
        });
        continue;
      }
      if (!declaredNames.has(name)) {
        this.#logger.warn('The model asked for a tool that was never declared', {
          ...requestProvenance(request),
          calledTool: name,
          declaredTools: [...declaredNames],
        });
      }
      calls.push({ id, name, input: block.input });
    }
    return calls;
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Whether a configured budget is a positive integer. */
function isPositiveInteger(candidate: number): boolean {
  return Number.isInteger(candidate) && candidate > 0;
}

/** Whether a configured bound is a non-negative integer. */
function isNonNegativeInteger(candidate: number): boolean {
  return Number.isInteger(candidate) && candidate >= 0;
}

/**
 * Whether a configured sampling temperature is one the messages API still
 * accepts.
 *
 * Exactly {@link ANTHROPIC_SUPPORTED_TEMPERATURE}, for the deprecation
 * {@link checkTemperature} documents. The same rule is applied per call there;
 * this predicate is the construction-time half, so a configuration carrying an
 * unusable value is refused where a host can print it rather than at the first
 * stage of a session.
 */
function isSupportedTemperature(candidate: number): boolean {
  return candidate === ANTHROPIC_SUPPORTED_TEMPERATURE;
}

/**
 * Checks one optional numeric setting at construction time.
 *
 * Absent is always acceptable — every one of these has a defined meaning when
 * it is not set. A value that *is* set and cannot work is reported here rather
 * than at the first call of a session, because a configuration failure a host
 * can print at startup is worth far more than a stage that fails an hour later.
 *
 * The offending value is named: it is a budget the host configured, not payload
 * and not a credential.
 *
 * @param value The configured value, or `undefined` when the host set none.
 * @param label How the budget is named to a developer.
 * @param accept Whether a value that is set can be used.
 * @param requirement What the value must be, completing the message.
 * @param hint The developer's next step. Defaults to the shared budget
 * remediation; a budget whose next step is specific — the deprecated sampling
 * temperature — passes its own.
 * @returns `Ok` when the value is absent or usable, or the coded refusal.
 */
function validateBudget(
  value: number | undefined,
  label: string,
  accept: (candidate: number) => boolean,
  requirement: string,
  hint: string = INVALID_BUDGET_HINT,
): Result<void, DebuggenError> {
  if (value === undefined || accept(value)) {
    return ok(undefined);
  }
  return err(
    codedFailure(
      'CONFIG_INVALID',
      `${label} must be ${requirement}; the configuration supplies ${String(value)}.`,
      { condition: 'configuration-budget-invalid', hint },
    ),
  );
}

/**
 * Whether a parsed URL's host is this machine's loopback interface.
 *
 * @param hostname A WHATWG-parsed `URL.hostname`: lower-cased, with an IPv4
 * address in canonical dotted-quad form and an IPv6 address bracketed.
 * @returns `true` for `localhost`, `127.0.0.0/8` and `[::1]`.
 */
function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname) || IPV4_LOOPBACK_PATTERN.test(hostname);
}

/**
 * Checks an explicit base URL override against the endpoint policy.
 *
 * The override is the only way this provider sends anything anywhere but
 * {@link ANTHROPIC_API_BASE_URL}, so it is held to a rule rather than trusted:
 *
 * - **It parses as an absolute URL**, once surrounding whitespace is trimmed.
 * - **Its scheme is `https:`** for any host, **or `http:` only to a loopback
 *   host** (see {@link isLoopbackHostname}) — a local proxy or a test double on
 *   this machine. Plain `http` to any other host would put the credential and
 *   every prompt on the network in clear text.
 * - **It carries no user name or password.** A credential in the URL would
 *   travel with every request and reach whatever logs the URL; the client
 *   authenticates with the configured key.
 * - **It carries no query and no fragment.** The client appends each API path
 *   to the base URL as text, so a `?` or `#` in it would move that path out of
 *   the path and send the request somewhere other than the route it names.
 *   A raw `?` or `#` is refused even when the parser reports it as empty.
 * - **A path prefix is allowed**, which is how a gateway mounts the API under
 *   a route of its own.
 *
 * A refusal says which rule failed, in a fixed phrase, and never names the
 * value, its host or any other part of it: the message, hint and `details`
 * are logged, persisted and rendered, and a pasted URL can carry a credential.
 *
 * @param value The configured override, or `undefined` when the host set none.
 * @returns `Ok(undefined)` when there is no override; `Ok` with the parsed,
 * normalised URL otherwise — handed to the client as it is, so the value
 * checked is the value used; or the coded `CONFIG_INVALID` refusal.
 *
 * @example
 * ```ts
 * validateBaseUrl('https://gateway.example.test/anthropic'); // Ok('https://gateway.example.test/anthropic')
 * validateBaseUrl('http://127.0.0.1:8080');                  // Ok('http://127.0.0.1:8080/')
 * validateBaseUrl('http://gateway.example.test');            // Err: http to a host that is not loopback
 * ```
 */
function validateBaseUrl(value: string | undefined): Result<string | undefined, DebuggenError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const refuse = (reason: string): Result<string | undefined, DebuggenError> =>
    err(
      codedFailure('CONFIG_INVALID', `The model API base URL override cannot be used: ${reason}.`, {
        condition: 'base-url-invalid',
        hint: INVALID_BASE_URL_HINT,
      }),
    );

  const trimmed = value.trim();
  const parsed = tryCatch<URL>(() => new URL(trimmed), 'CONFIG_INVALID');
  if (!parsed.ok) {
    return refuse('it does not parse as an absolute URL');
  }
  const url = parsed.value;
  const secure = url.protocol === 'https:';
  const loopbackHttp = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (!secure && !loopbackHttp) {
    return refuse('it must use https, or http only to a loopback address on this machine');
  }
  if (url.username !== '' || url.password !== '') {
    return refuse('it carries a user name or a password');
  }
  if (url.search !== '' || url.hash !== '' || /[?#]/u.test(trimmed)) {
    return refuse('it carries a query or a fragment');
  }
  return ok(url.href);
}

/**
 * Builds the one provider in this repository that talks to a real model.
 *
 * `../factory.ts` is its caller and has already resolved the configuration from
 * the host's environment; everything below is re-checked anyway, because this
 * is the boundary that owns a transport and a provider that cannot possibly
 * succeed should say so at construction.
 *
 * ## What is required, and what is not
 *
 * - **A model, always.** `config.model` is the only source of a model
 *   identifier in this package, `../factory.ts` reads it from `DEBUGGEN_MODEL`
 *   and never defaults it (AAP §0.5.3), and there is no literal here to fall
 *   back to. An absent one is a configuration failure carrying AAP §0.5.5's
 *   sentence.
 * - **A credential, unless a client was supplied.** `options.client` is the
 *   test seam: when it is present this function constructs no SDK client, so
 *   the credential belongs to whoever supplied the client and requiring one
 *   here would force every offline suite to invent a fake key. When it is
 *   absent, a missing credential is a configuration failure — never a client
 *   built without one, which would fail later and less clearly.
 * - **Usable budgets.** `maxTokens`, `temperature`, `timeoutMs` and
 *   `maxRetries` are each optional and each checked when present. An
 *   unsupported sampling temperature is refused here for the deprecation
 *   {@link checkTemperature} documents.
 * - **A usable base URL, when one is set.** `config.baseUrl` is checked
 *   against {@link validateBaseUrl}'s policy before the injected-client branch
 *   — an unusable endpoint makes the configuration invalid whoever supplies the
 *   client — and a refusal constructs no transport and names no part of the
 *   value.
 *
 * ## The transport's destination and diagnostics are never taken from the environment
 *
 * The client is always constructed with an explicit `baseURL` — the validated
 * override, else {@link ANTHROPIC_API_BASE_URL} — with `logLevel: 'off'` and
 * with a silent logger. Left absent, the vendor's client would read
 * `ANTHROPIC_BASE_URL` and `ANTHROPIC_LOG` from the process environment and
 * fall back to `console`, so an inherited variable could redirect the
 * credential and every prompt to another host, or print request and response
 * records into the service's standard output — the VS Code extension's "Debug
 * Generator Service" output channel — outside the service's pino redaction.
 * This file's own records, through `options.logger`, are the diagnostics.
 *
 * ## Both transport budgets are set, never defaulted by the dependency
 *
 * `timeoutMs` and `maxRetries` are resolved through
 * {@link resolveAnthropicTransportBudgets} and passed to the client
 * unconditionally, so a host that configured neither still gets this product's
 * documented bounds rather than the vendor client's. The resolved values are
 * kept on the configuration the provider holds, which is what lets every call
 * carry the same timeout it was constructed with — including a call through an
 * injected client this file never configured.
 *
 * ## The retry bound is a transport budget
 *
 * `config.maxRetries` goes to the SDK client constructor, where it governs
 * **re-sending a request that never got an answer** — a rate-limited response,
 * a server error, a dropped connection. It is entirely separate from the
 * bounded two-repair budget in `./structured.js`, which governs **re-asking
 * after an answer arrived and failed validation**. The two are counted in
 * different places and must never share a counter: if a transport retry
 * consumed repair budget, a rate-limited connection would leave a
 * well-behaved model with no attempts left to correct an artifact it could
 * easily have fixed, and the session would end in a fallback for a reason that
 * had nothing to do with its output.
 *
 * @param options The resolved configuration, an optional client to use instead
 * of constructing one, an optional logger and the structured-output mode.
 * @returns `Ok` with the provider, or `Err` with a coded configuration failure.
 * Never throws: a failure a host can act on is a value, not an exception.
 *
 * @example Constructing from a resolved configuration
 * ```ts
 * const created = createAnthropicProvider({ config, logger });
 * if (!created.ok) {
 *   // `code` selects the recovery path; `hint` is the developer's next step.
 *   logger.error(created.error.message, { code: created.error.code });
 * }
 * ```
 */
export function createAnthropicProvider(
  options: AnthropicProviderOptions,
): Result<ModelProvider, DebuggenError> {
  const config = options.config;
  const logger = options.logger ?? noopLogger;
  const structuredOutputMode = options.structuredOutputMode ?? 'auto';

  const model = config.model.trim();
  if (model.length === 0) {
    return err(
      unavailableFailure('CONFIG_INVALID', {
        condition: 'model-not-configured',
        hint: MISSING_MODEL_HINT,
      }),
    );
  }

  const budgets: readonly Result<void, DebuggenError>[] = [
    validateBudget(
      config.maxTokens,
      'A response-length bound',
      isPositiveInteger,
      'a positive integer',
    ),
    validateBudget(
      config.temperature,
      'A sampling temperature',
      isSupportedTemperature,
      `exactly ${String(ANTHROPIC_SUPPORTED_TEMPERATURE)}, the only value the messages API still accepts`,
      UNSUPPORTED_TEMPERATURE_HINT,
    ),
    validateBudget(
      config.timeoutMs,
      'A request timeout',
      isPositiveInteger,
      'a positive integer number of milliseconds',
    ),
    validateBudget(
      config.maxRetries,
      'A transport retry bound',
      isNonNegativeInteger,
      'a non-negative integer',
    ),
  ];
  for (const budget of budgets) {
    if (!budget.ok) {
      return budget;
    }
  }

  // Checked before the injected-client branch, like the budgets: an endpoint
  // outside the policy makes the configuration invalid whoever supplies the
  // client, so the verdict must not depend on how the provider is built.
  const endpoint = validateBaseUrl(config.baseUrl);
  if (!endpoint.ok) {
    return endpoint;
  }

  // The model is the one field normalised on its way in: a configured value
  // with surrounding whitespace is a typo rather than a different model, and
  // sending it unchanged would produce an opaque refusal from the provider.
  //
  // The two transport budgets are resolved at the same time, so the
  // configuration the provider holds states both bounds explicitly — whether
  // the host named them or this module's defaults answered — and no later read
  // of it can find a budget absent.
  const transport = resolveAnthropicTransportBudgets(config);
  const resolved: ModelProviderConfig = {
    ...config,
    model,
    timeoutMs: transport.timeoutMs,
    maxRetries: transport.maxRetries,
  };

  const injected = options.client;
  if (injected !== undefined) {
    logger.debug('Using an injected model transport', { providerId: PROVIDER_ID });
    return ok(new AnthropicProvider(injected, resolved, logger, structuredOutputMode));
  }

  const apiKey = config.apiKey?.trim() ?? '';
  if (apiKey.length === 0) {
    // Presence only. Nothing about a credential — not a value, not a prefix,
    // not a length — reaches a message, a hint, a details field or a log record.
    return err(
      unavailableFailure('CONFIG_INVALID', {
        condition: 'api-key-not-configured',
        hint: MISSING_API_KEY_HINT,
      }),
    );
  }

  const constructed = tryCatch<AnthropicClientLike>(
    () =>
      new Anthropic({
        apiKey,
        // The destination, always. A client built without one reads
        // `ANTHROPIC_BASE_URL` from the process environment, so an inherited
        // variable would decide where the credential and every prompt go.
        baseURL: endpoint.value ?? ANTHROPIC_API_BASE_URL,
        // The client's diagnostics, always off and never on `console`. Its
        // default level comes from `ANTHROPIC_LOG`, and its `info` and `debug`
        // records describe requests and responses on standard output, outside
        // the service's redaction.
        logLevel: TRANSPORT_LOG_LEVEL,
        logger: SILENT_TRANSPORT_LOGGER,
        // Both budgets, always. A client built without them applies the
        // vendor's own bounds instead, which are not this product's decision
        // and change with a version bump.
        maxRetries: transport.maxRetries,
        timeout: transport.timeoutMs,
      }),
    'MODEL_UNAVAILABLE',
  );
  if (!constructed.ok) {
    return err(
      unavailableFailure('MODEL_UNAVAILABLE', {
        condition: 'transport-construction-failed',
        hint: UNREACHABLE_HINT,
        cause: constructed.error,
      }),
    );
  }

  // Whether an override is in effect, as a closed label: the endpoint itself is
  // never logged, since a configured URL is the host's and not this file's.
  logger.debug('Constructed the model transport', {
    providerId: PROVIDER_ID,
    endpoint: endpoint.value === undefined ? 'approved' : 'override',
  });
  return ok(new AnthropicProvider(constructed.value, resolved, logger, structuredOutputMode));
}
