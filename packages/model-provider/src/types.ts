/**
 * The declaration-only vocabulary of `@debuggen/model-provider` — the model
 * boundary of this product.
 *
 * Every other module in this package types itself against this file: the
 * `ModelProvider` interface in `./provider.js`, the structured-output validator
 * and its repair loop in `./structured.js`, the versioned prompt loader in
 * `./prompt-loader.js`, the outbound redaction guard in `./redact-guard.js`,
 * the environment-driven selector in `./factory.js`, and both implementations
 * under `./providers/`. Nothing here imports any of them, which is what keeps
 * the package's internal module graph a tree rather than a cycle.
 *
 * ## No behaviour lives here
 *
 * This module contains **types, three module-level constants and one pure type
 * guard** — and nothing else. It performs no I/O, reads no environment
 * variable, touches no filesystem, constructs no client, mutates no global and
 * throws nothing. Importing it has no observable effect beyond the declarations
 * it brings into scope, which is what the package manifest's
 * `"sideEffects": false` promises to every bundler that inlines this package
 * (the local service bundles it into its own output, and the editor extension
 * bundles that service into the packaged extension).
 *
 * The three values are {@link promptStageSchema} (the one validator for a stage
 * string), {@link PROMPT_VERSION_PATTERN} (the shape of a prompt file's version
 * stem) and {@link DEFAULT_MAX_REPAIRS} (the repair budget the structured-output
 * loop reads instead of restating a number). The guard is
 * {@link isPromptStage}.
 *
 * ## What the file is organised around
 *
 * 1. **Prompt stages and versions.** The six stage names are the directory
 *    names of the versioned prompt files, and a version string is the file stem
 *    inside one of those directories. Both are recorded on a session, so both
 *    are part of this package's public vocabulary rather than an internal
 *    detail of the loader.
 * 2. **The JSON constraint.** {@link JsonObject} and its companions bound what
 *    a request may carry as structured context: plain, walkable, serialisable
 *    data and nothing else.
 * 3. **The request vocabulary.** {@link ModelRequest} and its parts, including
 *    the dual payload — rendered prose *and* the structured data it was
 *    rendered from — documented at length on that interface because it is the
 *    design decision the rest of the package rests on.
 * 4. **The response vocabulary.** {@link ModelTextResponse},
 *    {@link StructuredAttempt}, the tool *declaration* types and
 *    {@link TokenUsage}.
 * 5. **Configuration and structured-output options.**
 *    {@link ModelProviderConfig} and {@link StructuredOptions}, whose two type
 *    parameters are what keep this package ignorant of the artifacts it
 *    validates.
 *
 * ## What deliberately does not live here
 *
 * - **Any artifact schema.** This package never learns what a plan or a panel
 *   specification is. A caller owns its authoring schema and its deterministic
 *   normaliser and passes both in through {@link StructuredOptions}; the
 *   packages that define those artifacts are not dependencies of this one, and
 *   the repository's lint configuration fails the build on an import of them.
 * - **Any model identifier.** No literal naming a model appears anywhere in
 *   this package. {@link ModelProviderConfig.model} is required and is never
 *   defaulted, so a missing configuration value is a configuration error rather
 *   than a silent fallback to somebody's guess.
 * - **Any prompt text.** Prompts are versioned files in the repository, loaded
 *   by `./prompt-loader.js`; this module names their stages and the shape of
 *   their version strings, never their contents.
 * - **Error construction.** Errors are `DebuggenError` values carrying a code
 *   from the closed vocabulary in `@debuggen/shared` — `CONFIG_INVALID`,
 *   `MODEL_UNAVAILABLE`, `MODEL_OUTPUT_INVALID` and the artifact-specific
 *   codes — raised by the modules that detect the failure, not by a declaration
 *   file.
 *
 * ## Conventions
 *
 * `SCREAMING_SNAKE_CASE` for module-level constants, `PascalCase` for types and
 * interfaces, `camelCaseSchema` for a Zod schema — the convention the base
 * package established. Every union that a consumer might need to validate or
 * iterate is declared as an `as const` tuple with its type *derived* from it
 * (`(typeof TUPLE)[number]`), so the values and the type cannot drift apart.
 * Every field is `readonly`: a request, a response and a configuration object
 * are passed across module and process boundaries and are never edited in
 * place. Optional fields are **absent rather than present-and-`undefined`** —
 * the repository compiles with `exactOptionalPropertyTypes`, and a JSON round
 * trip turns an explicit `undefined` into `null`, which a schema then rejects.
 */

import { z } from 'zod';

import type { Logger } from '@debuggen/shared';

// ---------------------------------------------------------------------------
// Prompt stages and versions
// ---------------------------------------------------------------------------

/**
 * The six reasoning stages a session passes through, in pipeline order.
 *
 * These strings are **directory names**: the versioned prompt files live at
 * `prompts/<stage>/vNNN.md` under the local service, and the loader joins a
 * stage name to that path directly. The hyphen in `'generate-panel'` is part of
 * a directory name and not a typo to be tidied into an identifier-shaped
 * spelling; renaming, reordering, pluralising or adding a member here means
 * moving prompt files and migrating the stage names recorded on every stored
 * session, so it is a product change rather than a local edit.
 *
 * The order is the order the pipeline runs them: a question is understood,
 * the codebase is investigated, instrumentation is planned, the capture happens
 * (deterministically, with no model involved — which is why there is no
 * `'capture'` stage here), the evidence is analysed, a panel is generated, and
 * a follow-up question is decided on. Declared `as const` so {@link PromptStage}
 * can be derived from it and {@link promptStageSchema} can validate against it
 * without repeating the six strings.
 */
export const PROMPT_STAGES = [
  'understand',
  'investigate',
  'plan',
  'analyze',
  'generate-panel',
  'followup',
] as const;

/**
 * One of the stages in {@link PROMPT_STAGES}.
 *
 * Derived from the tuple rather than declared beside it, so a stage added to
 * the tuple widens this union in the same edit and every exhaustive `switch`
 * over it — the prompt loader's manifest lookup, the service's progress
 * reporting, the deterministic provider's rule selection — stops compiling
 * until it says something about the new case.
 */
export type PromptStage = (typeof PROMPT_STAGES)[number];

/**
 * The one validator for a stage string that arrives from outside the type
 * system.
 *
 * Two callers need it, and both handle data a compiler never saw: the prompt
 * loader validating the prompt manifest it read from disk, and configuration
 * parsing a value from the environment. Built from {@link PROMPT_STAGES} rather
 * than from a repeated list of literals, so the schema and the type are the
 * same vocabulary by construction.
 *
 * Use {@link isPromptStage} instead where the answer is a plain yes or no: this
 * schema is for the boundary where the *reason* a value was rejected has to
 * reach a developer.
 *
 * @example
 * ```ts
 * const parsed = promptStageSchema.safeParse(entry.stage);
 * if (!parsed.success) {
 *   // `parsed.error.issues` names the offending value and the allowed set.
 * }
 * ```
 */
export const promptStageSchema = z.enum(PROMPT_STAGES);

/**
 * Narrows an arbitrary value to a {@link PromptStage}.
 *
 * Deliberately not a wrapper around {@link promptStageSchema}: this allocates
 * no result object and builds no issue array, so it is the right check on a hot
 * path or inside a `filter` where a failure needs no explanation. Where a
 * developer-facing rejection message matters, parse with the schema instead.
 *
 * @param value Any value, including `undefined` and a non-string.
 * @returns `true` when `value` is one of the six stage names.
 */
export function isPromptStage(value: unknown): value is PromptStage {
  return typeof value === 'string' && (PROMPT_STAGES as readonly string[]).includes(value);
}

/**
 * The shape of a prompt file's version stem: `v` followed by exactly three
 * decimal digits.
 *
 * A prompt file is `prompts/<stage>/vNNN.md`, and this pattern matches the
 * `vNNN` part — `'v001'`, `'v042'`, never `'v1'`, `'1.0.0'` or `'latest'`. The
 * fixed width is what makes the files sort lexicographically in the order they
 * were written, in a directory listing and in a manifest alike.
 *
 * **A prompt file is immutable once committed.** A change to a prompt is a new
 * `vNNN+1.md` file plus a manifest update, never an edit to an existing file.
 * That is what makes a version string a permanent identifier: the versions a
 * session used are recorded on the session record, so a stored analysis or
 * panel can always be read back against the exact instructions that produced
 * it. Rewriting a committed prompt would silently invalidate every session that
 * cites it.
 *
 * Deliberately **without the `g` flag**. A global regular expression carries a
 * mutable `lastIndex` across calls, so a shared module-level instance with `g`
 * would answer `true`, then `false`, then `true` for the same input — a bug
 * class that survives every test that checks one value once.
 *
 * @example
 * ```ts
 * PROMPT_VERSION_PATTERN.test('v001'); // true
 * PROMPT_VERSION_PATTERN.test('v1'); //   false
 * ```
 */
export const PROMPT_VERSION_PATTERN = /^v\d{3}$/;

/**
 * A prompt file's version stem, as returned by the loader — a string matching
 * {@link PROMPT_VERSION_PATTERN}.
 *
 * A transparent alias for `string`, not a branded type, and that is a choice
 * rather than an omission: the base package leaves its identifier types
 * unbranded so a Zod schema can validate one without a cast at every boundary,
 * and a version string crosses several of those (a manifest on disk, a session
 * record in the store, a message to two user interfaces). The alias exists only
 * so a signature reads as what it carries; validation is
 * {@link PROMPT_VERSION_PATTERN}'s job, and the compiler does not enforce it.
 */
export type PromptVersion = string;

// ---------------------------------------------------------------------------
// The JSON constraint on structured context
// ---------------------------------------------------------------------------

/**
 * A JSON scalar: a string, a finite-or-not number, a boolean, or `null`.
 *
 * `undefined` is absent on purpose — it is not a JSON value. An optional member
 * of a {@link JsonObject} is expressed by omitting the key, which is also what
 * `exactOptionalPropertyTypes` asks of every optional field in this file.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * A JSON array: an immutable sequence of {@link JsonValue}s.
 *
 * Declared as a `readonly` array alias rather than as an interface extending
 * `ReadonlyArray`. The recursion resolves either way — TypeScript defers a
 * self-reference that passes through an array type — and the alias is the form
 * the repository's lint configuration accepts, since an interface whose body is
 * empty is reported as equivalent to its supertype.
 *
 * `readonly` because a request's structured context is shared with the
 * redaction guard and with the deterministic provider: neither may rewrite what
 * the caller assembled, and a compiler-enforced promise costs nothing.
 */
export type JsonArray = readonly JsonValue[];

/**
 * A JSON object: string keys, {@link JsonValue} members, immutable.
 *
 * An `interface` rather than an alias so the self-reference through
 * {@link JsonValue} resolves without an explicit deferral, and the type name a
 * consumer sees in an editor tooltip and in an error message stays
 * `JsonObject` rather than expanding into the whole recursive union.
 *
 * The index signature admits `| undefined` for a reason that
 * `noUncheckedIndexedAccess` makes unavoidable: reading an absent key from a
 * record type yields `undefined`, so the declared member type has to include it
 * or every read would need a non-null assertion. A caller building one of these
 * should still **omit** a key it has no value for rather than set it to
 * `undefined`, so the object survives a JSON round trip unchanged.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/**
 * Any value that can appear in a request's structured context: a
 * {@link JsonPrimitive}, a {@link JsonArray} or a {@link JsonObject}.
 *
 * ## Why the constraint is this narrow, and why it is load-bearing
 *
 * `ModelRequest.input` could have been typed `unknown` and everything would
 * still compile. It is typed as plain JSON because two separate guarantees
 * depend on the payload being exhaustively walkable and faithfully
 * serialisable:
 *
 * 1. **The outbound redaction guard.** `./redact-guard.js` walks every field of
 *    every outbound payload looking for a value that must never leave the
 *    developer's machine — a credential, a bearer token, a connection string
 *    with credentials, an `Authorization` or `Cookie` header value. A walk is
 *    only exhaustive if the shape is knowable: a function body cannot be
 *    inspected, a class instance can hide state behind a getter or a private
 *    field, a `Symbol` key is invisible to an ordinary key enumeration, and a
 *    `Map`, a `Set`, a `Date` or a typed array serialises to something that
 *    does not resemble what it holds. Forbidding all of them in the *type* is
 *    what makes the guard's coverage a property of the code rather than a hope.
 * 2. **The deterministic provider.** `./providers/deterministic.js` answers
 *    without a network and without a model, building a schema-valid result from
 *    the structured context alone — that is what lets the whole automated test
 *    suite exercise the real pipeline offline. It reads the context
 *    *generically*, by key and by kind, so the context has to be data it can
 *    read that way. Nothing about the shape of any particular project is known
 *    to it, which is precisely why its answers cannot smuggle in knowledge of
 *    the application being debugged.
 *
 * A caller with a richer object converts it first — spread the fields it means
 * to send, format a timestamp as a number or an ISO string, turn a `Map` into
 * an object or an array of pairs. That conversion is a deliberate decision
 * about what leaves the machine, taken at the call site, which is exactly where
 * it belongs.
 */
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

// ---------------------------------------------------------------------------
// Request vocabulary
// ---------------------------------------------------------------------------

/**
 * One prior turn of a conversation.
 *
 * Only two roles exist, and that is the whole design: a system instruction is
 * {@link ModelRequest.system}, never a message with a third role. That mirrors
 * the message API the real provider targets, where the system instruction is a
 * top-level parameter rather than a turn, and it removes the question of what a
 * provider should do with a system message that arrives in the middle of a
 * conversation.
 *
 * Content is plain text. A request carries its structured data in
 * {@link ModelRequest.input}, not encoded into a message string, so the
 * deterministic provider and the redaction guard can both read it as data.
 */
export interface ModelMessage {
  /** Who produced the turn: the caller (`'user'`) or the model. */
  readonly role: 'user' | 'assistant';

  /** The turn's text, already redacted by the caller. */
  readonly content: string;
}

/**
 * Provenance every request carries: which stage asked, with which prompt
 * version, on behalf of which session.
 *
 * This is not telemetry decoration. The stage selects the deterministic
 * provider's rule set and labels a log record; the prompt version is what makes
 * a stored artifact reproducible, because it is recorded on the session record
 * alongside the artifact it produced; the session id ties a provider call to
 * the session whose progress the two user interfaces are rendering.
 */
export interface ModelRequestMetadata {
  /** The pipeline stage making the call. */
  readonly stage: PromptStage;

  /**
   * The `vNNN` stem of the prompt file the text was rendered from, exactly as
   * the loader reported it.
   */
  readonly promptVersion: PromptVersion;

  /**
   * The session the call belongs to, when there is one.
   *
   * Optional because a call can legitimately happen outside a session — a
   * provider health probe at startup, or a unit test exercising one stage in
   * isolation. Absent rather than empty in that case: an empty string would
   * look like a session id in a log line and match nothing in the store.
   */
  readonly sessionId?: string;
}

/**
 * Everything a provider needs for one call.
 *
 * ## The dual payload, and why both halves are required
 *
 * A request carries the **rendered prompt** and the **structured context that
 * prompt was rendered from**. Both, always, and this is the single most
 * consequential decision in this file:
 *
 * - {@link ModelRequest.prompt} is prose: the versioned prompt file with its
 *   placeholders substituted. It is what a real provider sends over the
 *   network, and it is the only half of the payload that a language model ever
 *   sees.
 * - {@link ModelRequest.input} is data: the same information as a
 *   {@link JsonObject}. It is what `./providers/deterministic.js` reads to
 *   build a schema-valid answer with no network and no model at all, and what
 *   `./redact-guard.js` inspects field by field before anything is allowed to
 *   leave the machine.
 *
 * The consequence is worth stating plainly, because it is the property that
 * makes the product's automated tests meaningful. A rules-based provider can
 * answer *any* stage — propose a plan, describe what the evidence shows, lay
 * out a panel — using nothing but this structured context, and therefore
 * without carrying a single fact about the application under test. Its answers
 * vary because its inputs vary, not because it recognised a question. A
 * provider that had only the rendered prose would have to parse prose to do the
 * same job, and the most convenient way to pass a test suite that way is to
 * match on the wording of a question and return something prepared — which is
 * the one thing this product must never do.
 *
 * So a caller that fills in `prompt` and leaves `input` empty has not made a
 * harmless simplification. It has silently disabled the deterministic provider
 * (which now has nothing to reason from) and half the redaction guard (which
 * now has nothing to inspect, while the prose it cannot parse goes out
 * regardless). Both halves are required fields for that reason, and neither
 * accepts a placeholder.
 *
 * ## Redaction responsibility
 *
 * **Everything in a request must already be redacted when it is constructed.**
 * The first checkpoint is far upstream — the service redacts telemetry at
 * ingest, before an event is persisted or broadcast — and the caller assembling
 * a request works from that redacted material plus bounded source excerpts it
 * chose. `./redact-guard.js` is a *last line of defence*: it inspects the
 * payload and **rejects** a call whose payload still matches a denied pattern.
 * It is not a redactor, it does not rewrite a field, and a caller that treats
 * it as one will see calls fail rather than data get cleaned.
 *
 * ## Cancellation
 *
 * {@link ModelRequest.signal} is the only cancellation channel. A session that
 * ends, a capture that is discarded or a follow-up that supersedes an
 * in-flight stage aborts through it, and a provider is expected to propagate it
 * to its transport rather than let a call outlive the work that wanted it.
 */
export interface ModelRequest {
  /**
   * The system instruction, when the stage has one.
   *
   * A role and a set of standing constraints — cite evidence, answer only in
   * the requested shape — rather than the task itself. Stable across the calls
   * of a stage, which is what distinguishes it from {@link ModelRequest.prompt}.
   */
  readonly system?: string;

  /**
   * The rendered prompt text: the loader's output with its placeholders
   * substituted. Required.
   *
   * Never assembled from string fragments scattered through the codebase — the
   * text originates in a versioned prompt file, and
   * {@link ModelRequestMetadata.promptVersion} records which one.
   */
  readonly prompt: string;

  /**
   * Prior turns, oldest first, when the call continues a conversation.
   *
   * Two stages use it: a follow-up question, which carries the earlier exchange
   * so the model is not asked to re-derive what was already established, and a
   * repair attempt, which carries the rejected output and the validation errors
   * that rejected it. Absent for a first, single-shot call.
   */
  readonly messages?: readonly ModelMessage[];

  /**
   * The structured context the prompt was rendered from. Required — see the
   * dual-payload note on this interface.
   *
   * Already redacted by the caller. Plain JSON, so the guard can walk it and
   * the deterministic provider can read it.
   */
  readonly input: JsonObject;

  /**
   * Upper bound on the response length, in the provider's token units.
   *
   * Overrides {@link ModelProviderConfig.maxTokens} for this call. A stage that
   * produces a large artifact raises it here rather than raising the default
   * for every stage.
   */
  readonly maxTokens?: number;

  /**
   * Sampling temperature, in the provider's own range.
   *
   * Overrides {@link ModelProviderConfig.temperature} for this call. Stages
   * that must produce a schema-shaped artifact want the lowest useful value;
   * this package sets no default, because a sensible one is a property of the
   * provider and the model, neither of which this file knows anything about.
   */
  readonly temperature?: number;

  /** Provenance: stage, prompt version and session. Required. */
  readonly metadata: ModelRequestMetadata;

  /**
   * Cancellation for this call.
   *
   * A provider that starts work must observe it and must stop when it aborts;
   * a provider that cannot cancel its transport should still stop delivering a
   * result, so a caller never has to reason about a response arriving after the
   * work was abandoned.
   */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Response vocabulary
// ---------------------------------------------------------------------------

/**
 * What one call consumed, as the provider reported it.
 *
 * Optional on every response type, because a provider is free not to report it
 * and the rules-based one has nothing to report: a consumer must treat an
 * absent usage as "unknown", never as zero. Used for logging and for the
 * session's provider record, never for a decision inside this package.
 */
export interface TokenUsage {
  /** Tokens the request consumed, as counted by the provider. */
  readonly inputTokens: number;

  /** Tokens the response consumed, as counted by the provider. */
  readonly outputTokens: number;

  /**
   * The provider's own total, when it reports one.
   *
   * Carried rather than computed: a provider may count cached or reasoning
   * tokens that are in neither of the two fields above, and silently
   * substituting a sum would misreport its accounting. A consumer that needs a
   * total when this is absent adds the two fields itself and knows that it did.
   */
  readonly totalTokens?: number;
}

/**
 * The result of a free-text call.
 *
 * Deliberately thin. Free text has exactly one consumer inside the product —
 * the follow-up decision's prose and diagnostic paths — because every output
 * that can affect the developer's project or the screen goes through
 * {@link StructuredAttempt} and a schema instead. Nothing that reaches an
 * instrumentation plan or a panel specification is ever taken from a text
 * response.
 */
export interface ModelTextResponse {
  /** The model's text, exactly as the provider decoded it. */
  readonly text: string;

  /**
   * The model that answered, as the provider reports it — which may be more
   * specific than what was requested (a pinned build of a requested alias, for
   * instance). Recorded on the session, never compared against a literal in
   * this package.
   */
  readonly model: string;

  /** The provider implementation that answered, by its own id. */
  readonly providerId: string;

  /** Token accounting, when the provider reports it. */
  readonly usage?: TokenUsage;

  /**
   * Why generation stopped, in the provider's own vocabulary.
   *
   * Not normalised here: a provider's reasons are its own, and the value is
   * carried so a log line or a rejection message can quote it. The one reason a
   * caller usually cares about is a length cut-off, which explains a truncated
   * artifact far better than the schema error it causes downstream.
   */
  readonly stopReason?: string;
}

/**
 * One attempt at a structured answer, as the provider produced it and **before
 * anything has validated it**.
 *
 * The name says "attempt" rather than "response" because that is the honest
 * description: `./structured.js` asks a provider for one of these, validates
 * it against the caller's schema, and — when validation fails — asks for
 * another with the errors fed back, up to {@link DEFAULT_MAX_REPAIRS} times.
 * The type parameter `T` is the caller's *authoring* type; this package never
 * learns what it is.
 *
 * ## Field semantics, which the validator depends on
 *
 * - {@link StructuredAttempt.raw} — the provider's decoded JSON output,
 *   **unvalidated**, and the single input to validation. `./structured.js`
 *   parses this against the caller's schema, every time, no exceptions.
 * - {@link StructuredAttempt.value} — present only when the provider itself
 *   already parsed with the caller's schema, which the real provider's
 *   schema-constrained output path does. It is a **hint, never a source of
 *   truth**, and the validator re-parses `raw` regardless. The reason is
 *   specific rather than defensive: the provider's own structured-output helper
 *   strips JSON-Schema keywords the service-side format does not support, so a
 *   numeric bound, a string format or a refinement can survive that parse
 *   unchecked. An artifact that reached a plan or a panel on the strength of
 *   this field would have skipped exactly the constraints that a model is most
 *   likely to get wrong.
 * - {@link StructuredAttempt.text} — the undecoded text, populated when JSON
 *   decoding failed. It exists so a repair attempt can quote what came back
 *   rather than say "invalid JSON" and hope, and so a rejection that survives
 *   the repair budget can be logged with the evidence attached.
 *
 * An attempt where `raw` is `undefined` and `text` is present is a decode
 * failure; an attempt where both are absent is an empty response, which is a
 * provider fault and not a schema fault — the distinction
 * {@link StructuredRejectionReason} exists to record.
 */
export interface StructuredAttempt<T> {
  /**
   * The provider's decoded JSON output, unvalidated. `unknown` because it is
   * exactly that: whatever came back, with no claim about its shape.
   */
  readonly raw: unknown;

  /**
   * The provider's own parse of {@link StructuredAttempt.raw} against the
   * caller's schema, when it performed one. A hint; never trusted in place of
   * validation.
   */
  readonly value?: T;

  /** The undecoded response text, when JSON decoding failed. */
  readonly text?: string;

  /** The model that answered, as the provider reports it. */
  readonly model: string;

  /** The provider implementation that answered, by its own id. */
  readonly providerId: string;

  /** Token accounting, when the provider reports it. */
  readonly usage?: TokenUsage;

  /** Why generation stopped, in the provider's own vocabulary. */
  readonly stopReason?: string;
}

/**
 * A tool a model may ask for, **as a declaration and nothing more**.
 *
 * This type describes a name, a purpose and an argument schema. It carries no
 * implementation, and this package holds none: it never reads a file, never
 * walks a developer's project and never runs anything on a model's behalf. A
 * tool call comes back as data ({@link ToolCall}), and the caller decides what
 * to do with it.
 *
 * In this product the tools are read-only queries over an already-built code
 * graph, executed by the service's own tool module — the model proposes a
 * query, deterministic code runs it, and the answer goes back as text. The
 * boundary is the point: the only code paths that write to the developer's
 * project are the instrumentation patcher and its cleanup, both driven by a
 * validated plan, and neither is reachable from here.
 */
export interface ToolDefinition {
  /**
   * The tool's name, as the model will name it in a call. Stable, because it
   * appears in stored conversation turns.
   */
  readonly name: string;

  /**
   * What the tool answers and when to reach for it, written for the model.
   *
   * This is prompt material, so it is subject to the same rule as a prompt
   * file: it describes a capability generically and never encodes knowledge of
   * a particular application.
   */
  readonly description: string;

  /**
   * The schema of the tool's arguments.
   *
   * Typed `z.ZodType<unknown>` so any caller schema is accepted without this
   * package learning its output type — the caller parses the matching
   * {@link ToolCall.input} with this schema and gets its own type back. A
   * provider also renders it as a JSON Schema for the model, which is why it is
   * a schema here rather than a hand-written description of the arguments.
   */
  readonly inputSchema: z.ZodType<unknown>;
}

/**
 * A model's request to invoke a tool, exactly as it arrived.
 *
 * The caller matches {@link ToolCall.name} to a {@link ToolDefinition}, parses
 * {@link ToolCall.input} with that definition's schema, and executes its own
 * code — or refuses. Nothing is executed on the strength of this object alone.
 */
export interface ToolCall {
  /**
   * The provider's identifier for this call, quoted back when the result is
   * returned so a multi-call turn stays unambiguous.
   */
  readonly id: string;

  /** The tool the model named. May not match any known definition. */
  readonly name: string;

  /**
   * The model's argument object, **unvalidated** — hence `unknown`.
   *
   * A model can produce a shape its own schema forbade, and an argument object
   * is the input to code that runs on the developer's machine, so it is parsed
   * with the matching {@link ToolDefinition.inputSchema} before it is used,
   * never read field by field off this value.
   */
  readonly input: unknown;
}

/**
 * The result of a tool-enabled call: the calls the model asked for, plus any
 * text it produced alongside them.
 *
 * An empty {@link ToolCallsResponse.calls} array is a normal outcome and means
 * the model answered without reaching for a tool — a caller loops while there
 * are calls to run and stops when there are none, rather than treating the
 * empty case as an error.
 */
export interface ToolCallsResponse {
  /** The calls the model asked for, in the order it asked for them. */
  readonly calls: readonly ToolCall[];

  /** Text produced alongside the calls, when there was any. */
  readonly text?: string;

  /** The model that answered, as the provider reports it. */
  readonly model: string;

  /** The provider implementation that answered, by its own id. */
  readonly providerId: string;

  /** Token accounting, when the provider reports it. */
  readonly usage?: TokenUsage;

  /** Why generation stopped, in the provider's own vocabulary. */
  readonly stopReason?: string;
}

// ---------------------------------------------------------------------------
// Configuration and structured-output options
// ---------------------------------------------------------------------------

/**
 * How a provider is constructed.
 *
 * Assembled by `./factory.js` from the process environment and handed to a
 * provider's constructor. Every field is data the *host process* decided: no
 * module in this package reads an environment variable to fill one in, and no
 * field has a value baked into this file.
 */
export interface ModelProviderConfig {
  /**
   * Which implementation to construct.
   *
   * One of the ids published by `./providers/index.js`, but typed as `string`
   * here rather than as that union: importing the identifier set from the
   * `providers/` subfolder would make this declaration file depend on the
   * modules that depend on it. The factory validates the value against the
   * published set and reports an unknown one as a configuration error.
   */
  readonly providerId: string;

  /**
   * The model to call. **Required, and never defaulted anywhere in this
   * package.**
   *
   * The value comes from the host's configuration and nowhere else. No literal
   * naming a model appears in this package — not as a default here, not as a
   * fallback in a provider, not in a prompt file, not in a test fixture — so a
   * missing configuration value surfaces as a configuration error the developer
   * can act on, instead of a call that quietly went to whichever model somebody
   * hardcoded when the file was written. That is also why this field is not
   * optional: an optional field invites exactly that default.
   *
   * A provider may report a more specific model on its response; the value here
   * is what was asked for.
   */
  readonly model: string;

  /**
   * Credential for a provider that needs one.
   *
   * Optional because the rules-based provider needs none, and it is the only
   * provider the automated tests construct — the offline path must never
   * require a credential to exist. A provider that needs one and does not
   * receive it fails at construction with a configuration error rather than at
   * the first call.
   *
   * Never logged, never placed in a request, never written to the session
   * record.
   */
  readonly apiKey?: string;

  /**
   * Alternative API base URL, for a proxy or a compatible endpoint. Absent
   * means the provider's own default.
   */
  readonly baseUrl?: string;

  /**
   * Default response-length bound for every call, overridable per call by
   * {@link ModelRequest.maxTokens}.
   */
  readonly maxTokens?: number;

  /**
   * Default sampling temperature for every call, overridable per call by
   * {@link ModelRequest.temperature}.
   */
  readonly temperature?: number;

  /** Per-call transport timeout in milliseconds. */
  readonly timeoutMs?: number;

  /**
   * How many times a provider may retry its **transport** — a rate-limit
   * response, a server error, a dropped connection.
   *
   * This is categorically different from {@link StructuredOptions.maxRepairs},
   * and conflating the two is a real failure mode rather than a stylistic
   * concern. A retry re-sends a request that never got an answer; a repair
   * sends a *new* request carrying the validation errors of an answer that did
   * arrive. If a transport failure consumed the repair budget, a rate-limited
   * connection would leave a well-formed model with no attempts left to correct
   * an artifact it could easily have fixed, and the session would end in a
   * fallback for a reason that has nothing to do with the model's output. The
   * two budgets are counted in different places and never share a counter.
   */
  readonly maxRetries?: number;

  /**
   * Where a provider logs. Defaults to the base package's no-op logger, so
   * library code logs nothing until a host asks for it.
   *
   * The interface is message-first — `logger.info('message', { field })`. A
   * logger redacts nothing, so a provider must not log a prompt, a response
   * body or a credential through it.
   */
  readonly logger?: Logger;
}

/**
 * The repair budget: how many additional attempts a structured call gets after
 * its first output failed the caller's schema.
 *
 * Two, and this constant is the single place that number is written.
 * `./structured.js` reads it rather than restating a literal, so the budget can
 * be reasoned about — and changed — in one place, and so a test can assert the
 * number of attempts against the same source the implementation uses.
 *
 * Bounded on purpose. A model that has failed the same schema three times is
 * not converging, and the product has a better answer than a fourth attempt: a
 * deterministic artifact assembled from the captured evidence, presented as
 * what it is. Spending more attempts would trade a developer's waiting time for
 * a diminishing chance of a model-authored result.
 */
export const DEFAULT_MAX_REPAIRS = 2;

/**
 * Why a structured call was rejected.
 *
 * One shared vocabulary for `./structured.js`, its tests and the callers that
 * decide what to do next, so a rejection is classified once rather than
 * re-derived from an error message:
 *
 * - `'provider'` — the call itself failed: unavailable, unauthorised, timed
 *   out, aborted. Nothing was validated.
 * - `'empty'` — the call succeeded and produced nothing usable: no decoded
 *   output and no text to quote back.
 * - `'schema'` — output arrived and failed the caller's authoring schema. **The
 *   model's fault, and the one reason that earns a repair attempt.**
 * - `'normalize'` — output passed the schema and the caller's deterministic
 *   normaliser then threw. **A product bug, never the model's fault**: the
 *   normaliser's input was valid by construction, so re-prompting cannot help.
 *   It is logged once, with closed fields only (provenance, counts, the thrown
 *   error's code and failure class) — never the parsed input or the thrown
 *   message — and rejected without a retry.
 */
export type StructuredRejectionReason = 'provider' | 'schema' | 'normalize' | 'empty';

/**
 * How one structured call is validated, normalised and — when necessary —
 * repaired.
 *
 * ## The two type parameters are the boundary
 *
 * `TInput` is the caller's **authoring** type: the shape a model is asked to
 * produce and the shape a human would write by hand. `TOutput` is the
 * **internal** type the product actually runs on, produced from the authoring
 * shape by a deterministic normaliser. They default to the same type for the
 * stages whose output needs no normalisation.
 *
 * Both are supplied by the caller, along with the schema and the normaliser
 * itself, and that is what keeps this package ignorant of what it is
 * validating. The authoring schemas and their normalisers belong to the
 * packages that own the artifacts — the one that owns instrumentation plans,
 * and the one that owns panel specifications — and **neither is imported
 * here**. This package can therefore validate an artifact it has no definition
 * of, which is also why a new artifact type needs no change in this file.
 *
 * ## The asymmetry between a schema failure and a normaliser failure
 *
 * `./structured.js` treats the two differently, and the difference is a
 * deliberate policy rather than an implementation detail:
 *
 * - A **schema** failure is the model's fault. The validation issues are fed
 *   back as a new turn and the call is retried, up to
 *   {@link StructuredOptions.maxRepairs} times. This is the loop the budget
 *   exists for.
 * - A **normaliser** throw is a product bug. The normaliser received input that
 *   the authoring schema had already accepted, so its failure says something is
 *   wrong in the normaliser or in the schema — not in the model's answer.
 *   Re-prompting would hide a defect behind an identical second failure, so the
 *   call is rejected immediately. The failure is logged with closed fields only
 *   — never the parsed input, which is model-authored prose — and the thrown
 *   value travels on as the rejection's `cause` for whoever has to fix it.
 *
 * Either way the caller gets a typed rejection and falls back to a
 * deterministic artifact assembled from the captured evidence, which the user
 * interface presents as a fallback rather than as a model's conclusion. A
 * failure is never dressed up as a successful result.
 */
export interface StructuredOptions<TInput, TOutput = TInput> {
  /**
   * How many repair attempts this call may make after the first schema failure.
   * Defaults to {@link DEFAULT_MAX_REPAIRS}.
   *
   * `0` disables repair entirely — the honest setting for the rules-based
   * provider, whose output either matches the schema or reveals a defect that a
   * second attempt would only hide.
   */
  readonly maxRepairs?: number;

  /**
   * The deterministic transformation from the authoring shape to the internal
   * one, when the caller has one.
   *
   * Pure and total for every input the schema accepts: it fills in the fields
   * that are derived rather than authored and rejects nothing that validated.
   * It must not perform I/O and must not consult a model — it is the step that
   * makes a model's answer *product* data, and it runs identically whether the
   * answer came from a real provider or from the rules-based one.
   *
   * Absent means the authoring shape is the internal shape.
   */
  readonly normalize?: (input: TInput) => TOutput;

  /**
   * A short name for the artifact under validation, used in rejection messages
   * and in the feedback a repair attempt carries.
   *
   * This is how a rejection can say *which* artifact failed without this
   * package knowing what that artifact is: the caller names it, and the
   * validator quotes the name. Absent means messages describe the failure
   * without naming the shape.
   */
  readonly schemaName?: string;

  /**
   * Where the validation loop logs each attempt and each rejection. Defaults
   * to the base package's no-op logger.
   *
   * A rejected payload is diagnostic material, so whatever is logged about one
   * is subject to the same rule as anything else that leaves this process: a
   * logger redacts nothing.
   */
  readonly logger?: Logger;
}
