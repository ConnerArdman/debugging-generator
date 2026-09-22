/**
 * Provider selection for `@debuggen/model-provider` (AAP 0.5.3).
 *
 * This module is the home of the environment-driven selector that decides
 * which `ModelProvider` a host process runs behind: `DEBUGGEN_PROVIDER` picks
 * `anthropic` or `deterministic`, `DEBUGGEN_MODEL` supplies the model
 * identifier for the real provider, and `ANTHROPIC_API_KEY` its credential.
 * The selector itself (`createModelProvider` and `resolveProviderConfig`)
 * lands together with the providers barrel (`./providers/index.js`), which
 * declares the closed set of provider ids it validates against.
 *
 * What lives here already is the one piece that both the selector and the
 * real provider need in common: the developer-facing sentence for a provider
 * that cannot be used. AAP 0.5.5 fixes its wording, and both boundaries —
 * configuration that could not be resolved here, and a runtime refusal inside
 * `./providers/anthropic.js` — must show the developer the identical sentence.
 * Defining it once, in this module, is what lets the factory's and the
 * provider's tests assert the same string.
 *
 * `./providers/anthropic.js` imports this builder while the eventual selector
 * imports the providers barrel, which in turn imports the Anthropic provider.
 * That cycle is intended and is safe because every call site invokes the
 * builder inside a function body at call time, never in a module-scope
 * initializer.
 */

/**
 * Builds the developer-facing sentence for a model provider that cannot be
 * used, in AAP 0.5.5's exact wording:
 *
 * > `Model provider unavailable (‹code›). Check ANTHROPIC_API_KEY or switch
 * > DEBUGGEN_PROVIDER.`
 *
 * The `code` argument is the condition being reported — by convention the
 * closed-vocabulary `DebuggenErrorCode` the failure carries, so the code a
 * user interface branches on and the code the sentence quotes cannot drift
 * apart. The sentence names only the *presence* of a credential and the
 * switch that avoids needing one; no credential value may ever be passed in.
 *
 * @param code The condition code to quote inside the sentence.
 * @returns The complete sentence, ready to be used as a `DebuggenError` message.
 */
export function modelUnavailableMessage(code: string): string {
  return `Model provider unavailable (${code}). Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.`;
}
