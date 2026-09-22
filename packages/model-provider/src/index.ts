/**
 * `@debuggen/model-provider` — the model boundary of the Debug Generator.
 *
 * This is the only package in the monorepo that talks to a language model, and
 * the only place that decides whether a model's output may affect the
 * developer's project (an instrumentation plan) or the screen (a panel
 * specification) — AAP 0.5.3. It is also the package's only door: the manifest
 * declares exactly one export condition, `"."`, and `tsup.config.ts` bundles
 * exactly this file into `dist/index.js` and `dist/index.d.ts`. **A symbol not
 * re-exported below does not exist for `apps/local-service`**, which is the one
 * consumer of this surface (`apps/vscode-extension` re-bundles the service, and
 * this package with it, into the packaged extension).
 *
 * ## The ignorance principle
 *
 * Nothing here knows what it is validating. A caller passes its own Zod
 * authoring schema and its own deterministic normaliser *in*, and gets a parsed
 * value of its own type back out. That is why this package imports
 * `@debuggen/shared` and `zod` and nothing else: never
 * `@debuggen/panel-schema`, `@debuggen/instrumentation`, `@debuggen/telemetry`
 * or `@debuggen/protocol`. The root `eslint.config.js` fails the build on any of
 * those imports, so the property is enforced rather than merely intended, and
 * the consequence is worth stating: a new artifact type is a new schema and
 * normaliser in the package that owns it, and no change in this one.
 *
 * ## The validation order that makes model output safe
 *
 * `./structured.js` owns it, and the *order* of the steps — not merely their
 * presence — is the safety property (AAP 0.5.3): one provider attempt; a
 * provider failure short-circuits without spending a repair; the authoritative
 * parse of the raw output against the caller's authoring schema, performed even
 * when the provider already parsed it; a schema failure earns at most
 * {@link DEFAULT_MAX_REPAIRS} repairs, which carry the validation paths and the
 * schema's own messages and never the rejected values; an exhausted budget is a
 * typed rejection, never a fabricated substitute; and normalisation runs once,
 * guarded, because a normaliser throw is a product bug — the authoring schema
 * had already accepted its input, so a second identical answer would fail
 * identically. Validating the normalised value against the artifact's
 * *internal* schema, and choosing a fallback when this module reports a
 * rejection, both belong to the caller: this package has no internal schema and
 * no fallback of its own.
 *
 * ## Two safety properties the surface guarantees
 *
 * - **No prompt string lives in a module.** Prompts are versioned repository
 *   files — `prompts/<stage>/vNNN.md` under the local service — immutable once
 *   committed, loaded only through {@link createPromptLoader}, and the versions
 *   it answered with are recorded on the session so a stored analysis or panel
 *   can be read back against the instructions that produced it. A missing
 *   prompt is a typed error, never a substitute.
 * - **Every outbound payload is inspected before a transport sees it.**
 *   {@link assertOutboundSafe} refuses a request whose prompt or context still
 *   carries a denied pattern, rather than silently rewriting it — the second of
 *   the two redaction points in the pipeline, after the one that runs at
 *   telemetry ingest (AAP 0.5.2).
 *
 * ## The deterministic mode
 *
 * `DEBUGGEN_PROVIDER=deterministic` selects {@link createDeterministicProvider}
 * — and {@link DEFAULT_PROVIDER_ID} names it, so an unconfigured process
 * reaches no network. It is rules-based: it builds schema-valid answers from
 * the structured inputs it is given, ships no recorded model responses, and is
 * what every automated test and the CI end-to-end suite runs behind. In that
 * mode nothing leaves the machine.
 *
 * ## What lives behind this entry
 *
 * The modules are re-exported below in dependency order, which is also the
 * package's internal layering:
 *
 * - `types` — the request, response and attempt vocabulary
 *   ({@link ModelRequest}, {@link ModelTextResponse},
 *   {@link StructuredAttempt}, {@link ToolCallsResponse},
 *   {@link ModelProviderConfig}, {@link StructuredOptions}), the closed prompt
 *   stage set and its version pattern, the repair budget and the `Json*`
 *   aliases. It imports no sibling.
 * - `provider` — the {@link ModelProvider} interface every implementation
 *   satisfies (`id`, `generateText`, `generateStructured`, `callTools`), its
 *   disposable extension and the two guards.
 * - `structured` — the validation order above, as
 *   {@link generateStructuredWithRepair}, plus the issue formatter and the
 *   repair-turn builder the suites assert against.
 * - `prompt-loader` — the versioned prompt files, their manifest schema and
 *   {@link renderPrompt}.
 * - `redact-guard` — the outbound guard, the rule and header vocabularies it
 *   reports against, and the pure predicates behind them.
 * - `providers` — the provider id vocabulary and the two construction
 *   functions, the network-backed {@link createAnthropicProvider} and the
 *   rules-based {@link createDeterministicProvider}.
 * - `factory` — {@link createModelProvider} and
 *   {@link resolveProviderConfig}, the single decision that settles which
 *   boundary a host process runs behind, and the shared unavailable-message
 *   builder both it and the network-backed provider use.
 *
 * `factory` and `providers` import each other, deliberately and safely: neither
 * reads an imported binding at module scope, so the order of the two
 * re-exports below is a reading convenience and not a load-order requirement.
 *
 * ## What is deliberately absent
 *
 * `src/deterministic/rules.ts` and `src/deterministic/templates.ts` are
 * internals of the rules-based provider and are not re-exported: a caller that
 * could reach them would be reaching past the {@link ModelProvider} interface,
 * and the offline answers would stop being a function of the provider's
 * arguments alone. The colocated `*.test.ts` files are likewise unreachable
 * from here, which is what keeps `tsup` — whose graph starts at this file —
 * from ever emitting test code into `dist/`.
 *
 * One name is published by two of the groups below: `StructuredRejectionReason`
 * is declared once, in `types`, and re-exported by `structured` beside the
 * function that returns it. Both paths resolve to that single declaration, so
 * the name is not ambiguous and needs no alias here.
 *
 * Importing this module has no side effect: every export is a declaration, the
 * manifest declares `"sideEffects": false`, and nothing here reads an
 * environment variable, constructs a provider, touches the filesystem or holds
 * module-level mutable state. There is no default export.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// types — the vocabulary every other module in the package is written in
// ---------------------------------------------------------------------------
export * from './types.js';

// ---------------------------------------------------------------------------
// provider — the interface an implementation satisfies, and its guards
// ---------------------------------------------------------------------------
export * from './provider.js';

// ---------------------------------------------------------------------------
// structured — parse, bounded repair, guarded normalisation, typed rejection
// ---------------------------------------------------------------------------
export * from './structured.js';

// ---------------------------------------------------------------------------
// prompt-loader — versioned repository prompts, never a string in a module
// ---------------------------------------------------------------------------
export * from './prompt-loader.js';

// ---------------------------------------------------------------------------
// redact-guard — the last check before an outbound payload reaches a transport
// ---------------------------------------------------------------------------
export * from './redact-guard.js';

// ---------------------------------------------------------------------------
// providers — the id vocabulary and the two implementations
// ---------------------------------------------------------------------------
export * from './providers/index.js';

// ---------------------------------------------------------------------------
// factory — which boundary this process runs behind
// ---------------------------------------------------------------------------
export * from './factory.js';
