/**
 * The provider folder's barrel — and the one place the product's provider
 * vocabulary is written down.
 *
 * Two things live here, and the second is why a file this short matters out of
 * proportion to its size:
 *
 * 1. **The barrel.** `./anthropic.js` and `./deterministic.js` are reached
 *    through this module and through no other path. `../factory.js` imports
 *    `createAnthropicProvider` and `createDeterministicProvider` from here
 *    rather than from the implementations, and `../index.ts` — the package's
 *    single build entry — forwards what this module publishes onward as
 *    `@debuggen/model-provider`'s public surface. That package's manifest
 *    declares exactly one export condition (`"."`) and its tsup configuration
 *    bundles exactly `src/index.ts`, so no consumer outside this package
 *    imports this path: a symbol that does not come through here does not
 *    exist for `apps/local-service`, which is why this barrel forwards every
 *    public symbol of both implementations rather than the two construction
 *    functions alone.
 * 2. **The provider id vocabulary** — {@link PROVIDER_IDS},
 *    {@link ProviderId} and {@link isProviderId} — declared here once for the
 *    whole monorepo. `../factory.js` validates the host's `DEBUGGEN_PROVIDER`
 *    against it and derives its "valid values are …" wording from it, so the
 *    tuple's contents *and its order* are user-visible. A second copy of any
 *    of the three, anywhere, would eventually disagree with this one and
 *    produce a wrong message somewhere; there is no copy, and there must not
 *    be one.
 *
 * ## The edge runs one way
 *
 * This module sits at the top of the folder's little module graph: it imports
 * the two implementations, the two implementations import neither it nor each
 * other, and nothing here imports `../factory.js` (the factory imports *this*
 * module). Neither implementation imports the factory either — the one sentence
 * both it and the network-backed provider report is declared in
 * `../provider.js`, a leaf — so the edge from the selector down through this
 * barrel to the implementations is the only one there is, and it runs one way
 * in fact rather than merely by intent. Keeping that direction is what makes
 * the vocabulary safe to centralise. It is also why `../provider.ts` types
 * `ModelProvider.id` as `string` rather than as {@link ProviderId}: each
 * implementation narrows `id` to its own private literal, so neither has to
 * import this file to say what it is, and the closed set stays in one place
 * without closing a cycle for a single string. Narrowing that declaration would be a regression, not
 * an improvement.
 *
 * Because the two literals therefore exist twice — once in this tuple as
 * vocabulary, once inside each implementation as that implementation's own
 * answer to `ModelProvider.id` — the pairing is asserted where the reported
 * value is observable, in each provider's own suite, rather than by a type.
 *
 * ## Adding a third provider
 *
 * Add its id to {@link PROVIDER_IDS} and re-export its construction function
 * below; then `../factory.js` stops compiling until it handles the new member,
 * because it selects with an exhaustive `switch` whose unreachable branch calls
 * `assertNever` from `@debuggen/shared`. That compile error is the mechanism
 * that keeps the factory and this vocabulary in step, so it must not be
 * softened with a `default` branch — and the configuration error's wording
 * needs no edit at all, since it is joined from this tuple.
 *
 * The default selection is deliberately *not* here: `DEFAULT_PROVIDER_ID` is
 * declared and exported by `../factory.js`, which is what applies it, and
 * `../index.ts` re-exports this module and that one side by side — so a second
 * declaration of that name here would be both a duplicated fact and a name
 * collision in the package's public surface.
 *
 * ## Shape of this module
 *
 * Declarations and re-exports, and nothing else: no default export (the
 * precedent `packages/shared/src/index.ts` sets and its guard test asserts), no
 * wildcard `export *` — the symbols are enumerated so the public surface is
 * reviewable and `../index.ts`'s forwarding list can be checked against it by
 * eye — no symbol renamed on the way through, and no work at load time.
 * Importing this module reads no environment variable, touches no global,
 * allocates no lookup table and constructs no provider. Values and types are
 * re-exported in separate statements because `verbatimModuleSyntax` and
 * `isolatedModules` require a type to travel through `export type { … }`, and
 * every relative specifier carries an explicit `.js` extension, as this
 * package's NodeNext resolution demands.
 */

/* -------------------------------------------------------------------------------------------------
 * The provider vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The closed set of provider ids this product recognises, in the order a
 * developer sees them.
 *
 * The single declaration of this vocabulary. `../factory.js` reads it twice —
 * once through {@link isProviderId} to decide whether a configured
 * `DEBUGGEN_PROVIDER` value is one of these, and once by joining it into the
 * hint that tells the developer which values are valid — so this array's
 * membership and order reach a user-visible message directly, and adding a
 * member updates that message with no second place to edit.
 *
 * `as const` is load-bearing rather than stylistic: it is what makes the value
 * a readonly tuple of string literals, which is what lets {@link ProviderId} be
 * *derived* from it instead of hand-written, and what makes the factory's
 * `switch` over that union exhaustively checkable.
 *
 * - `'anthropic'` — the network-backed provider of AAP §0.5.3, which needs a
 *   credential and a configured model identifier.
 * - `'deterministic'` — the rules-based provider every automated test and the
 *   continuous-integration end-to-end suite runs behind, which reaches no
 *   service, so nothing leaves the machine while it is selected (AAP §0.5.2).
 *
 * @example Validating a configured value and reporting the alternatives
 * ```ts
 * if (!isProviderId(configured)) {
 *   // One list, one order, one message — all derived from this tuple.
 *   return err(new DebuggenError('CONFIG_INVALID', 'Unrecognised provider.', {
 *     hint: `Set DEBUGGEN_PROVIDER to one of: ${PROVIDER_IDS.join(', ')}.`,
 *   }));
 * }
 * ```
 */
export const PROVIDER_IDS = ['anthropic', 'deterministic'] as const;

/**
 * One of the ids in {@link PROVIDER_IDS}.
 *
 * Derived from the tuple rather than written out, so the type and the runtime
 * list cannot drift apart: a member added to the array widens this union in the
 * same edit, and `../factory.js` — which selects with an exhaustive `switch`
 * over this union — stops compiling until it handles the addition.
 *
 * This is the type of a *validated* configuration value, never of a value just
 * read from the environment: use {@link isProviderId} to cross that boundary.
 */
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Whether `value` is one of the ids in {@link PROVIDER_IDS}.
 *
 * The boundary between an unvalidated configuration value and
 * {@link ProviderId}. Total and non-throwing by construction: `undefined` (an
 * unset `DEBUGGEN_PROVIDER`), `null`, a number, an object, an array and an
 * unrelated string all answer `false`, so a caller never needs a `try` around
 * it and never needs to pre-check the shape of what it read.
 *
 * Matching is exact — no trimming, no case folding, no aliasing. Normalising a
 * value is the caller's decision and `../factory.js` makes it deliberately,
 * trimming and lower-casing before asking, so that it can report a case-only
 * mismatch as such rather than accepting it silently. A guard that normalised
 * for its caller would make that distinction unobservable.
 *
 * @param value Any value, from any source: an environment variable, a stored
 * session record, a message payload or a host's override.
 * @returns `true` when `value` is a string present in {@link PROVIDER_IDS},
 * narrowing it to {@link ProviderId}; `false` for everything else.
 *
 * @example Reading the environment at the configuration boundary
 * ```ts
 * const configured = env.DEBUGGEN_PROVIDER?.trim().toLowerCase();
 * const providerId: ProviderId = isProviderId(configured) ? configured : DEFAULT_PROVIDER_ID;
 * ```
 */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_IDS.some((candidate) => candidate === value);
}

/* -------------------------------------------------------------------------------------------------
 * The implementations
 * ---------------------------------------------------------------------------------------------- */

/**
 * Constructs the network-backed provider: see `./anthropic.js`.
 *
 * Takes the configuration `../factory.js` resolved (and, for a test, a client
 * to use instead of one it would build), and answers with a `Result` — a
 * configuration that cannot possibly succeed fails at construction, where the
 * host can report it, rather than at the first stage of a session.
 */
export { createAnthropicProvider } from './anthropic.js';

/**
 * The network-backed provider's transport policy: see `./anthropic.js`.
 *
 * Forwarded as values because two boundaries apply them. `../factory.js` calls
 * {@link resolveAnthropicTransportBudgets} on the configuration it hands over,
 * so the configuration a provider is constructed from states both bounds
 * explicitly instead of leaving them to the vendor client's own defaults; the
 * provider applies the same resolver to whatever configuration it receives, so
 * a host constructing one directly is bounded identically.
 * `ANTHROPIC_SUPPORTED_TEMPERATURE` is the single definition of the one
 * sampling temperature the messages API still accepts, which the factory
 * validates against one boundary earlier than the provider does, and the two
 * defaults are what a suite asserts a call was actually bounded by rather than
 * restating a number of its own.
 */
export {
  ANTHROPIC_DEFAULT_MAX_RETRIES,
  ANTHROPIC_DEFAULT_TIMEOUT_MS,
  ANTHROPIC_SUPPORTED_TEMPERATURE,
  resolveAnthropicTransportBudgets,
} from './anthropic.js';

/**
 * The structured-output routes the network-backed provider can take, as a
 * readonly tuple: see `./anthropic.js`.
 *
 * Forwarded as a value, not only as a type, because it is the list a caller
 * iterates or validates against when it pins a route — which a suite does to
 * observe one route in isolation, since the product's `'auto'` behaviour cannot
 * guarantee which of the two answered.
 */
export { ANTHROPIC_STRUCTURED_OUTPUT_MODES } from './anthropic.js';

/**
 * Constructs the rules-based provider: see `./deterministic.js`.
 *
 * Needs no credential, no model identifier and no network — every argument is
 * optional — which is what makes selecting it a complete answer to "does
 * anything leave this machine", and why it is the provider behind every
 * automated test in this repository.
 */
export { createDeterministicProvider } from './deterministic.js';

/* -------------------------------------------------------------------------------------------------
 * The implementations' public types
 *
 * Forwarded through `export type { … }`, which `verbatimModuleSyntax` and
 * `isolatedModules` require: a type carried by a value `export { … }` is a
 * compile error here, and would be an import of nothing at runtime in the
 * bundles this package is folded into.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The network-backed provider's public types: see `./anthropic.js`.
 *
 * - `AnthropicProviderOptions` — everything `createAnthropicProvider` accepts:
 *   the resolved configuration, an optional client, a logger and the route.
 * - `AnthropicStructuredOutputMode` — one of
 *   {@link ANTHROPIC_STRUCTURED_OUTPUT_MODES}.
 * - `AnthropicTransportBudgets` — the resolved per-request timeout and retry
 *   count {@link resolveAnthropicTransportBudgets} answers with, both concrete
 *   numbers.
 * - `AnthropicClientLike`, `AnthropicMessagesLike`,
 *   `AnthropicMessageParamsLike`, `AnthropicMessageLike`,
 *   `AnthropicContentBlockLike`, `AnthropicUsageLike` and
 *   `AnthropicRequestOptionsLike` — the transport seam, declared structurally
 *   rather than imported from the vendor's software development kit. They are
 *   part of this barrel's surface for one reason: a suite that injects a
 *   three-line fake client, driving every branch of the provider without a
 *   network, a credential or a module mock, has to be able to *name* the shape
 *   it is satisfying. The real client satisfies them by assignment.
 */
export type {
  AnthropicClientLike,
  AnthropicContentBlockLike,
  AnthropicMessageLike,
  AnthropicMessageParamsLike,
  AnthropicMessagesLike,
  AnthropicProviderOptions,
  AnthropicRequestOptionsLike,
  AnthropicStructuredOutputMode,
  AnthropicTransportBudgets,
  AnthropicUsageLike,
} from './anthropic.js';

/**
 * Everything `createDeterministicProvider` accepts — the host's provider
 * configuration and its logger, both optional: see `./deterministic.js`.
 *
 * The provider reads no environment variable of its own, so this is the whole
 * of its input, which is what keeps its answers a function of its arguments
 * alone.
 */
export type { DeterministicProviderOptions } from './deterministic.js';
