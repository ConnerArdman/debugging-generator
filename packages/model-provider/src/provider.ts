/**
 * The `ModelProvider` interface — this product's entire model boundary.
 *
 * Nothing above this file talks to a model SDK. The local service holds one
 * `ModelProvider` value, hands it a {@link ModelRequest} and reads a
 * {@link Result} back; *which* implementation it holds is a configuration
 * decision taken once, in `./factory.js`, from the host process's environment.
 * Two implementations satisfy this interface — a network-backed one under
 * `./providers/` and a rules-based one beside it that runs entirely offline and
 * is what every automated test constructs — and a caller cannot tell them apart
 * from the types alone. That indistinguishability is the point: it is what makes
 * the offline mode a genuine execution path through the real pipeline rather
 * than a mock bolted to the side of one.
 *
 * ## Declarations only
 *
 * This module contains **one interface, one optional extension of it and two
 * type guards** — and nothing else. It performs no I/O, constructs no client,
 * reads no environment variable, touches no filesystem, mutates no global and
 * throws nothing. Importing it has no observable effect beyond the declarations
 * it brings into scope, which is what the package manifest's
 * `"sideEffects": false` promises to every bundler that inlines this package
 * (the local service bundles it into its own output, and the editor extension
 * bundles that service into the packaged extension).
 *
 * ### Why no model SDK is imported here
 *
 * A static import of a provider's SDK in *this* file would be loaded by every
 * consumer of the interface, including a host configured for the offline
 * rules-based provider — a process that must construct no network client at all.
 * An SDK is therefore imported by exactly one module, the implementation that
 * needs it, and never by the declaration every other module depends on. The
 * repository's lint configuration guards the same boundary from the other side:
 * this package may import `@debuggen/shared` and nothing else from the
 * workspace, so the model boundary stays ignorant of telemetry events,
 * instrumentation plans and panel specifications, and nothing about the
 * developer's application can reach a model implicitly.
 *
 * ### Why no identifier vocabulary is declared here
 *
 * {@link ModelProvider.id} is a `string`, not a union of the known provider
 * ids. The set of ids lives in `./providers/index.js`, next to the factory that
 * validates a configured value against it; importing it here would make this
 * declaration depend on the modules that depend on it, and re-declaring it here
 * would be a second copy of one vocabulary. An implementation narrows the field
 * to its own literal, which is the strongest typing available without that
 * cycle.
 *
 * ## Relationship to the modules around it
 *
 * - `./types.js` declares the request and response vocabulary this file's
 *   signatures are written in. It imports nothing from here, which is what keeps
 *   this package's internal module graph a tree.
 * - `./structured.js` is the *only* module that validates a structured answer,
 *   and the only one that repairs a rejected one. A provider hands it an
 *   unvalidated {@link StructuredAttempt}; the repair budget and the rejection
 *   vocabulary belong to it alone.
 * - `./redact-guard.js` inspects an outbound payload before it leaves the
 *   process. An implementation with a transport must run it; an implementation
 *   without one has nothing to guard.
 * - `./factory.js` selects and constructs an implementation from the host's
 *   configuration and is the only module that names one.
 */

import type { DebuggenError, Result } from '@debuggen/shared';
import type { ZodType } from 'zod';

import type {
  ModelRequest,
  ModelTextResponse,
  StructuredAttempt,
  ToolCallsResponse,
  ToolDefinition,
} from './types.js';

// ---------------------------------------------------------------------------
// The provider interface
// ---------------------------------------------------------------------------

/**
 * One model implementation, behind the only surface the product calls a model
 * through.
 *
 * Three capabilities, each corresponding to one way a pipeline stage needs to
 * use a model: free text, a schema-shaped artifact, and a turn in which the
 * model may ask for a read-only query to be run on its behalf. Plus an id, so a
 * response can record which implementation answered.
 *
 * Everything below the signatures is the **contract**: the part of this
 * interface a compiler cannot express, that both implementations obey and both
 * implementations' tests assert. It is written out here rather than left to each
 * implementation because a caller reasons about a `ModelProvider`, not about the
 * one it happens to hold, and because a divergence between the two would surface
 * as a pipeline that behaves differently in the offline suite than in front of a
 * developer.
 *
 * ## 1. Failures are values, not exceptions
 *
 * Every method returns a {@link Result}. An implementation returns `Err` for
 * every **expected** failure, which here means every failure that is a property
 * of the world rather than of the code: an absent or rejected credential, an
 * error status, a timeout, a cancellation, a response whose envelope could not
 * be decoded at all, an exhausted quota, a refused request. None of those is
 * exceptional — each has a defined recovery path and a defined thing to show the
 * developer — so each is returned rather than raised.
 *
 * A thrown exception is reserved for a **programmer error**: an invariant that
 * cannot hold, which the base package's `assert`, `assertDefined`, `assertNever`
 * and `fail` raise as a coded error. The distinction is not stylistic. Two
 * things downstream depend on it:
 *
 * - The failure has to reach the developer as a message with a next step —
 *   "Model provider unavailable (‹code›). Check ANTHROPIC_API_KEY or switch
 *   DEBUGGEN_PROVIDER." — and a value carrying a code and a hint is what a user
 *   interface can render that from. An exception unwinding through a stage
 *   arrives as a stack trace, which is not that.
 * - The service's session state machine has to move the session to its failed
 *   status *at a named stage*, so both surfaces can say which step failed. A
 *   returned failure keeps the stage in the frame that observed it.
 *
 * ### The error a failure carries
 *
 * Every `Err` carries a `DebuggenError` whose `code` is drawn from the **closed**
 * code vocabulary in `@debuggen/shared`. No implementation invents a code and no
 * implementation adds one; the set is closed precisely so a boundary can decide
 * what to do from the code instead of parsing a message. For this boundary:
 *
 * - `CONFIG_INVALID` — the implementation cannot make sense of its own
 *   configuration: a required credential is absent, or the model to call was not
 *   configured. Raised at construction where possible, so a misconfigured host
 *   fails before a stage starts rather than at the first call.
 * - `MODEL_UNAVAILABLE` — the provider could not be reached or refused the call.
 *   This is the code for the whole transport-and-refusal family: an error
 *   status, a rejected credential, an exhausted quota, a timeout, a cancelled
 *   call, a connection that dropped, a response body that was not a message at
 *   all.
 * - `INTERNAL` — last resort, for a failure the implementation genuinely cannot
 *   classify. Reaching for it where `MODEL_UNAVAILABLE` or `CONFIG_INVALID` fits
 *   removes the only signal a user interface has, so it is the exception rather
 *   than the default.
 *
 * `MODEL_OUTPUT_INVALID` is deliberately **not** in that list: output that
 * arrived and then failed its schema is not a provider failure, and the code for
 * it belongs to `./structured.js`, which is what rejects an artifact after the
 * permitted repair attempts. A provider that returned `Err` for a badly shaped
 * answer would deny that module the chance to repair it.
 *
 * The developer's next step goes in the error's `hint`, not appended to the
 * message: `hint` is the field the error's payload form forwards verbatim, and
 * therefore the field that survives the hop to both user interfaces.
 *
 * ## 2. One attempt per call
 *
 * A method performs **exactly one model interaction**. It does not loop, does
 * not re-prompt, and does not retry because an answer failed a schema. One call
 * in, at most one model answer out.
 *
 * The bounded repair policy — a first attempt plus at most two repairs — exists
 * in exactly one place, `./structured.js`, which re-prompts by making a *new*
 * call carrying the validation errors of the previous answer. Duplicating that
 * loop inside a provider would multiply rather than add: three attempts in the
 * validator over three attempts in the provider is up to nine model calls for
 * one stage, at nine times the latency and the cost, and it would make the "at
 * most two repairs" guarantee unverifiable, because neither layer could tell how
 * many attempts the other had spent. A test can count attempts only while one
 * layer owns the counter.
 *
 * ### A transport retry is not an attempt
 *
 * The two ideas are kept verbally distinct because conflating them is a real
 * failure mode. A **transport retry** re-sends a request that produced *no model
 * output* — a rate-limit response, a server error, a dropped connection — and is
 * bounded by the retry setting on the provider's configuration, which an SDK
 * normally applies internally. It yields no new model answer, so it is not an
 * attempt in the sense above and it is permitted. An **attempt** is a request
 * that produces an answer. A provider may therefore retry its transport as
 * configured while still performing exactly one attempt per call, and the two
 * budgets are counted in different places and never share a counter.
 *
 * ## 3. No normalisation
 *
 * A provider returns what the model produced. It does not reshape a field, does
 * not fill in a default, does not repair a near-miss, and never applies the
 * caller's deterministic normaliser — that transformation is a separate step
 * that runs after validation, on data that has already been proven to satisfy
 * the caller's authoring schema.
 *
 * {@link ModelProvider.generateStructured} may populate the optional parsed
 * value on its {@link StructuredAttempt} when its transport already parsed the
 * answer with the caller's schema, but the raw decoded output **must always be
 * carried**, because that is the field `./structured.js` validates. The reason is
 * specific rather than defensive: a provider's own structured-output helper
 * strips the JSON-Schema keywords its service-side format does not support, so a
 * numeric bound, a string format or a refinement can survive that parse
 * unchecked. An artifact admitted on the strength of the pre-parsed value would
 * have skipped exactly the constraints a model is most likely to get wrong.
 *
 * ## 4. No filesystem, no project writes, no execution
 *
 * A provider never reads or writes the developer's project, never touches the
 * product's own state directory, and never executes a {@link ToolDefinition}. A
 * tool definition is a declaration — a name, a purpose and an argument schema —
 * and {@link ModelProvider.callTools} returns the calls the model *requested*,
 * as data, for the caller to decide about. Nothing runs on a model's say-so:
 * the investigation tools are read-only queries over an already-built code
 * graph, executed by the service's own tool module, and the only code paths in
 * this product that write to a developer's project are the instrumentation
 * patcher and its cleanup, both driven by an already-validated plan and neither
 * reachable from here.
 *
 * ## 5. Redaction happens before transport
 *
 * Everything in a {@link ModelRequest} is already redacted when the caller
 * constructs it. An implementation with a network transport must nonetheless run
 * the outbound guard on the payload **before the request leaves the process**,
 * and must return `Err` when the guard reports a finding rather than sending the
 * call and reporting afterwards: a secret that has left the machine cannot be
 * recalled, so the check is worth nothing if it runs anywhere else. The guard
 * rejects; it does not rewrite a field, so a caller that treats it as a redactor
 * sees calls fail instead of data get cleaned. An implementation without a
 * transport has nothing to guard, which is why the offline mode sends nothing
 * anywhere at all.
 *
 * ## 6. Cancellation is honoured
 *
 * The optional signal on a request is the one cancellation channel, and an
 * implementation observes it in three parts:
 *
 * - A signal that is **already aborted** short-circuits to `Err` without a
 *   transport call. Spending a request on work the caller has abandoned is
 *   avoidable, so it is avoided.
 * - An abort **mid-flight** resolves the returned promise to `Err`. It never
 *   rejects, because the whole surface reports failure as a value, and a
 *   cancellation is a failure like any other.
 * - Whatever listener the implementation attached to the caller's signal is
 *   **removed before the promise settles**, on every path. The caller owns that
 *   signal and may reuse it for the rest of a session; a listener left behind on
 *   it is a leak that grows with every stage.
 *
 * @example Holding a provider and reading its result
 * ```ts
 * const provider: ModelProvider = createProvider(config);
 * const answer = await provider.generateText(request);
 * if (isOk(answer)) {
 *   logger.info('stage answered', { provider: answer.value.providerId });
 * } else {
 *   // `code` selects the recovery path; `hint` is the developer's next step.
 *   logger.error(answer.error.message, { code: answer.error.code });
 * }
 * ```
 */
export interface ModelProvider {
  /**
   * Which implementation this is, as it reports itself.
   *
   * The value is one of the ids published by `./providers/index.js`, against
   * which `./factory.js` validates a configured value; the field is typed
   * `string` here to keep this declaration from depending on that module, and an
   * implementation narrows it to its own literal. It is copied onto every
   * response so a stored artifact records what produced it, and it is recorded
   * on the session alongside the prompt versions used — which is what makes an
   * offline run distinguishable from a network-backed one after the fact.
   *
   * Stable for the lifetime of the value, hence `readonly`.
   */
  readonly id: string;

  /**
   * Asks the model for free text.
   *
   * The narrowest of the three capabilities and the least used: every output
   * that can affect the developer's project or the screen goes through
   * {@link ModelProvider.generateStructured} and a schema instead, so nothing
   * that reaches an instrumentation plan or a panel specification is ever taken
   * from a text answer.
   *
   * @param request The prompt, its structured context and its provenance.
   * @returns `Ok` with the text and the accounting the provider reported, or
   * `Err` with a coded failure. Never throws for an expected failure; see the
   * contract on this interface.
   */
  generateText(request: ModelRequest): Promise<Result<ModelTextResponse, DebuggenError>>;

  /**
   * Asks the model for an answer shaped by the caller's schema.
   *
   * The schema comes first because it is what the call is *about*: it is
   * rendered for the model as the shape to produce, and — where the transport
   * supports it — constrains the answer as it is generated. The type parameter is
   * the caller's authoring type, inferred from the schema argument, and this
   * package never learns what it is: the schemas and their deterministic
   * normalisers belong to the packages that own the artifacts, and none of them
   * is a dependency of this one.
   *
   * What comes back is an **attempt**, not a validated artifact. It is
   * unvalidated by construction — a decode failure and an empty answer are both
   * representable in it — and `./structured.js` is what parses it against the
   * schema, classifies a rejection and decides whether a repair is warranted.
   * An implementation that validated here would be duplicating that module and
   * hiding the classification it produces.
   *
   * @typeParam T The caller's authoring type, inferred from `schema`.
   * @param schema The caller's authoring schema for the answer.
   * @param request The prompt, its structured context and its provenance.
   * @returns `Ok` with one unvalidated attempt, or `Err` with a coded failure of
   * the call itself.
   */
  generateStructured<T>(
    schema: ZodType<T>,
    request: ModelRequest,
  ): Promise<Result<StructuredAttempt<T>, DebuggenError>>;

  /**
   * Asks the model for an answer, offering it a set of tools it may request.
   *
   * The tools are **declarations**: the provider renders each one's name,
   * description and argument schema for the model, and returns whichever calls
   * the model asked for. It executes none of them — see the contract above — so
   * an empty set of requested calls is an ordinary outcome and means the model
   * answered without reaching for one.
   *
   * @param request The prompt, its structured context and its provenance.
   * @param tools The tools on offer. `readonly`, because a provider reads this
   * list and never edits the caller's array.
   * @returns `Ok` with the requested calls and any accompanying text, or `Err`
   * with a coded failure of the call itself.
   */
  callTools(
    request: ModelRequest,
    tools: readonly ToolDefinition[],
  ): Promise<Result<ToolCallsResponse, DebuggenError>>;
}

// ---------------------------------------------------------------------------
// Optional disposal
// ---------------------------------------------------------------------------

/**
 * A {@link ModelProvider} that holds a resource worth releasing.
 *
 * An implementation with a network transport keeps something open behind it — a
 * connection pool, keep-alive sockets, a scheduler for its own transport
 * retries. The local service runs for as long as an editor window does and
 * rebuilds its provider whenever the host's configuration changes, so an
 * abandoned client is not a process-exit detail: it is a handle that outlives
 * the value that owned it, in a process that keeps running.
 *
 * ## Why disposal is not a required member
 *
 * The rules-based implementation has nothing to close. Requiring `close()` of
 * every provider would put a no-op method in it whose only readers are future
 * maintainers wondering what it releases, and would make every test double
 * implement a member it does not need. Optionality is therefore the honest
 * shape: a provider that owns a resource declares it, a provider that owns
 * none says nothing, and a caller asks with {@link hasClose} rather than
 * assuming either way.
 *
 * ## What an implementation promises
 *
 * - **Idempotent.** A second call resolves without doing anything again, so a
 *   caller that disposes on both a configuration change and a shutdown path
 *   does not have to track which ran first.
 * - **Does not reject.** Disposal runs on teardown paths, frequently while
 *   another failure is being reported; a rejection there would replace the
 *   original failure with a teardown error. A release that could not complete is
 *   logged by the implementation and the promise still resolves.
 * - **Terminal.** A method called after disposal returns `Err` rather than
 *   quietly reopening the transport, so a use-after-release surfaces as a coded
 *   failure at the call site that made it.
 *
 * @example Disposing whatever needs it, once a provider is replaced
 * ```ts
 * if (hasClose(previous)) {
 *   await previous.close();
 * }
 * ```
 */
export interface DisposableModelProvider extends ModelProvider {
  /**
   * Releases whatever this provider holds open.
   *
   * @returns A promise that resolves once the resources are released — or
   * immediately, when they already were. Does not reject; see the contract on
   * this interface.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Whether `value` is a non-null object whose members can be read as `unknown`.
 *
 * The first step of {@link isModelProvider}, kept separate for the same reason
 * the base package keeps its equivalent separate: it is the step that turns an
 * `unknown` into something indexable, and naming it keeps the guard below a flat
 * list of member checks rather than a nest of type assertions.
 *
 * A function passes this check — `typeof (() => {}) === 'function'`, not
 * `'object'` — and that is correct here: a bare function is not a provider,
 * because a provider is an object with four members.
 *
 * @param value Any value, including `undefined` and `null`.
 * @returns `true` when `value` is an object and not `null`.
 */
function isIndexableObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/**
 * Narrows an arbitrary value to a {@link ModelProvider}.
 *
 * A **structural** check, not an `instanceof` one, and that is deliberate.
 * Nothing in this product requires a provider to be an instance of a particular
 * class: the interface is the contract, a host may supply its own object, and a
 * value that crossed a bundle boundary has a different constructor identity even
 * when it is exactly the right shape. Two callers need it — the factory's test,
 * asserting that each constructed implementation satisfies the interface it
 * claims, and a defensive assertion at the service boundary, where a provider
 * arrives from configuration-driven construction — and both ask a question about
 * shape rather than about lineage.
 *
 * ## What it checks, and what it cannot
 *
 * The four declared members, each for the type it is declared with: a string id
 * and three callable methods. That is the whole of what is checkable at runtime.
 * An arity check is deliberately absent — a method may legally be written with
 * fewer parameters than the interface declares, or as a rest-parameter wrapper,
 * so counting them would reject valid implementations. Optional disposal is not
 * checked either; that is {@link hasClose}'s question.
 *
 * Everything the contract on {@link ModelProvider} states — one attempt per
 * call, no normalisation, no execution, redaction before transport, cancellation
 * honoured — is **unobservable from a shape**. This guard establishes that a
 * value can be called as a provider, never that it behaves as one. That is what
 * the implementations' tests are for, and it is why this returns a predicate
 * rather than throwing: a caller that needs the stronger statement asserts it,
 * with a coded failure, at its own boundary.
 *
 * Allocation-free by construction: no object is built, no array is walked, no
 * regular expression runs, and the member checks short-circuit on the first
 * failure. It is safe on a hot path and safe inside a `filter`.
 *
 * @param value Any value, including `undefined`, a function and a plain object.
 * @returns `true` when `value` has a string `id` and callable `generateText`,
 * `generateStructured` and `callTools` members.
 *
 * @example
 * ```ts
 * if (!isModelProvider(constructed)) {
 *   // A coded configuration failure, raised where the value entered the system.
 * }
 * ```
 */
export function isModelProvider(value: unknown): value is ModelProvider {
  if (!isIndexableObject(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.generateText === 'function' &&
    typeof value.generateStructured === 'function' &&
    typeof value.callTools === 'function'
  );
}

/**
 * Whether `provider` implements {@link DisposableModelProvider.close}.
 *
 * The supported way to ask, because the answer differs between implementations:
 * one owns a transport and one owns nothing. Reading `close` off a provider by
 * hand would either need a type assertion at every teardown site or force
 * `close()` to be a required member of every provider, which
 * {@link DisposableModelProvider} explains is the wrong shape.
 *
 * The parameter is a {@link ModelProvider} rather than `unknown`: this narrows a
 * value already known to be a provider, so a caller holding something less than
 * that establishes it with {@link isModelProvider} first. Written with `in`
 * rather than a type assertion, so a method inherited from a class prototype —
 * where an implementation's `close` actually lives — is found just as a
 * per-instance one is.
 *
 * @param provider A provider of either kind.
 * @returns `true` when `provider` has a callable `close` member.
 */
export function hasClose(provider: ModelProvider): provider is DisposableModelProvider {
  return 'close' in provider && typeof provider.close === 'function';
}
