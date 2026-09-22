/**
 * Provider selection for `@debuggen/model-provider` (AAP 0.5.3) — the one
 * decision that settles which model boundary a host process runs behind.
 *
 * `DEBUGGEN_PROVIDER` picks the implementation, `DEBUGGEN_MODEL` names the
 * model the network-backed one calls, and `ANTHROPIC_API_KEY` carries its
 * credential. Those three names are the whole of this module's environment
 * surface (AAP 0.3.4): no fourth variable is read here, because a variable a
 * developer cannot find in `.env.example` is a configuration surface nobody
 * knows about. Budgets and a base URL are therefore accepted only through
 * {@link CreateModelProviderOptions.overrides}, where the host that already
 * validated its own configuration passes them in.
 *
 * ## What this module guarantees
 *
 * - **Nothing leaves the machine unless a developer asked for it.**
 *   {@link DEFAULT_PROVIDER_ID} is the rules-based provider, so an
 *   unconfigured process reaches no network (AAP 0.5.2).
 * - **No model identifier is written down anywhere in this package.** There is
 *   no default model, no fallback and no example: an absent `DEBUGGEN_MODEL`
 *   on the network-backed path is a configuration error a developer can act
 *   on, never a substitution that makes a session record untrue.
 * - **A credential is reported by presence only.** No message, hint, `details`
 *   field or log record produced here carries a credential's value, prefix or
 *   length.
 * - **Construction is synchronous and unmemoised.** `apps/local-service`'s
 *   startup stays straight-line, and no module-scope cache can leak one
 *   process's configuration into the next test or survive a credential
 *   rotation.
 *
 * ## Two boundaries, one sentence
 *
 * `modelUnavailableMessage` is declared once, in `./provider.js`, and imported
 * both here and by `./providers/anthropic.js`, so a configuration this module
 * refused and a runtime refusal inside the provider show the developer the
 * identical sentence (AAP 0.5.5) and both suites can assert the same string.
 *
 * It used to be declared *here*, which forced the implementation to import
 * upward and closed the runtime cycle
 * `factory → providers/index → providers/anthropic → factory`. That cycle is
 * gone: the one import edge between this module and the provider folder now
 * runs in a single direction, from here down to `./providers/index.js`, and
 * `./provider.js` — a leaf that imports only types — holds the shared sentence
 * both ends need. No module under `./providers/` imports this one.
 *
 * One habit from that arrangement is kept because it is worth keeping on its
 * own merits rather than for load order: **no imported binding is read at
 * module scope.** The list of valid provider ids a failure quotes is joined
 * inside the error builder at call time rather than cached in a constant, so a
 * provider added to `PROVIDER_IDS` updates the developer-facing wording with
 * nothing to edit here.
 */

import { DebuggenError, assertNever, andThen, err, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result } from '@debuggen/shared';
import { z } from 'zod';

import { modelUnavailableMessage } from './provider.js';
import type { ModelProvider } from './provider.js';
import {
  ANTHROPIC_SUPPORTED_TEMPERATURE,
  PROVIDER_IDS,
  createAnthropicProvider,
  createDeterministicProvider,
  isProviderId,
  resolveAnthropicTransportBudgets,
} from './providers/index.js';
import type { ProviderId } from './providers/index.js';
import type { ModelProviderConfig } from './types.js';

/* -------------------------------------------------------------------------------------------------
 * The environment surface
 * ---------------------------------------------------------------------------------------------- */

/** The variable that selects the implementation (AAP 0.3.4). */
const PROVIDER_VARIABLE = 'DEBUGGEN_PROVIDER';

/** The variable that names the model the network-backed provider calls. */
const MODEL_VARIABLE = 'DEBUGGEN_MODEL';

/**
 * The variable that carries the network-backed provider's credential.
 *
 * Only its *name* is written here, and only its name ever reaches a message, a
 * hint, an error's `details` or a log record.
 */
const CREDENTIAL_VARIABLE = 'ANTHROPIC_API_KEY';

/**
 * The implementation a process runs behind when it configured none.
 *
 * **The rules-based provider, deliberately.** This default is a safety
 * property rather than a convenience: nothing leaves the machine while it is
 * selected (AAP 0.5.2), so a process that was started without configuration —
 * a fresh clone, a forgotten `.env`, a continuous-integration job, a test that
 * constructed a provider without saying which — reaches no network and sends
 * no excerpt of the developer's code anywhere. `DEBUGGEN_PROVIDER` is listed
 * in `.env.example` (AAP 0.3.4), which is where a developer opts in to the
 * network-backed provider explicitly.
 *
 * Defaulting the other way would invert that: an unconfigured process would
 * quietly attempt calls with whatever the investigation stage had gathered,
 * and would fail only for the absence of a credential — reporting a
 * configuration problem where the real surprise was the attempt itself.
 *
 * Declared here, next to the code that applies it, rather than in
 * `./providers/index.js`, which declares the vocabulary and no policy.
 */
export const DEFAULT_PROVIDER_ID = 'deterministic' satisfies ProviderId;

/* -------------------------------------------------------------------------------------------------
 * Remediation text
 * ---------------------------------------------------------------------------------------------- */

/**
 * The next step for a selection this module does not recognise.
 *
 * The list of accepted values is joined from `PROVIDER_IDS` at call time — see
 * {@link unrecognisedProviderError} — so a provider added to that tuple
 * updates this sentence with nothing to edit here.
 */
function unrecognisedProviderHint(settingName: string): string {
  return (
    `Set ${settingName} to one of: ${PROVIDER_IDS.join(', ')}. ` +
    'The value is compared after surrounding whitespace is removed and letters are lower-cased, ' +
    'so a difference of letter case or padding alone is accepted and is never the cause of this ' +
    `failure. Leave it unset to run behind '${DEFAULT_PROVIDER_ID}', which reaches no network.`
  );
}

/** The next step for a network-backed provider selected without a model. */
const MISSING_MODEL_HINT =
  `Set ${MODEL_VARIABLE} to the model this session should call. It is never defaulted: a session ` +
  'records the model it used, and a substituted default would make that record untrue. Or set ' +
  `${PROVIDER_VARIABLE}=${DEFAULT_PROVIDER_ID} to run the pipeline offline, where no model is needed.`;

/** The next step for a network-backed provider selected without a credential. */
const MISSING_CREDENTIAL_HINT =
  `Set ${CREDENTIAL_VARIABLE} in the environment the local service was started from, or set ` +
  `${PROVIDER_VARIABLE}=${DEFAULT_PROVIDER_ID} to run the pipeline offline, where no credential is needed.`;

/* -------------------------------------------------------------------------------------------------
 * Failure construction
 * ---------------------------------------------------------------------------------------------- */

/**
 * Where a setting came from, for a failure's `details` and hint.
 *
 * Carries the setting's **name** and nothing else. A value never travels in a
 * failure: `details` may be logged, persisted with a session and rendered in a
 * user interface, and this module resolves a credential.
 */
interface SettingSource {
  /** `'environment'` for a process variable, `'override'` for a host-supplied field. */
  readonly kind: 'environment' | 'override';

  /** The variable or field name, for instance `DEBUGGEN_PROVIDER`. Never a value. */
  readonly name: string;
}

/**
 * The code every failure this module raises carries.
 *
 * `CONFIG_INVALID` from the closed `DEBUGGEN_ERROR_CODES` tuple: each of these
 * failures is the host's configuration being unusable, discovered at the
 * boundary that reads it, before any call is attempted. It is also the code
 * `./providers/anthropic.js` raises for the same two conditions when a host
 * bypasses this module and constructs that provider directly, so one condition
 * cannot arrive at a user interface under two codes.
 */
const CONFIGURATION_FAILURE_CODE: DebuggenErrorCode = 'CONFIG_INVALID';

/**
 * A `DebuggenError` for a configuration this module refused.
 *
 * @param message The developer-facing sentence.
 * @param hint The developer's next step, forwarded to a user interface by
 * `toPayload()`.
 * @param condition This module's label for the failure, for `details`.
 * @param source The offending setting's name and origin.
 * @returns The error, with a frozen `details` object carrying names only.
 */
function configurationError(
  message: string,
  hint: string,
  condition: string,
  source: SettingSource,
): DebuggenError {
  return new DebuggenError(CONFIGURATION_FAILURE_CODE, message, {
    hint,
    details: Object.freeze({ condition, source: source.kind, setting: source.name }),
  });
}

/**
 * The failure for a provider selection outside `PROVIDER_IDS`.
 *
 * Both the message and the hint enumerate the accepted values, joined from the
 * tuple at call time so the wording can never go stale, and neither echoes the
 * configured value: a selection is not a secret, but a failure built on this
 * module's rule — names, never values — has no exception to reason about.
 *
 * @param source The setting that carried the unrecognised selection.
 * @returns A `CONFIG_INVALID` error naming the setting and listing the ids.
 */
function unrecognisedProviderError(source: SettingSource): DebuggenError {
  return configurationError(
    `Unrecognised model provider selection in ${source.name}. Valid values are: ${PROVIDER_IDS.join(', ')}.`,
    unrecognisedProviderHint(source.name),
    'provider-not-recognised',
    source,
  );
}

/**
 * The failure for a required setting the network-backed path did not receive.
 *
 * Its message is `modelUnavailableMessage` — AAP 0.5.5's sentence, in the
 * single definition in `./provider.js` that both this module and
 * `./providers/anthropic.js` import — and the specific setting is named by the
 * hint and by `details.setting`, so a developer reads which of the two is
 * missing without the message having to vary.
 *
 * @param variable The name of the absent environment variable.
 * @param condition This module's label for the failure.
 * @param hint The developer's next step.
 * @returns A `CONFIG_INVALID` error whose message is the shared sentence.
 */
function missingSettingError(variable: string, condition: string, hint: string): DebuggenError {
  return configurationError(modelUnavailableMessage(CONFIGURATION_FAILURE_CODE), hint, condition, {
    kind: 'environment',
    name: variable,
  });
}

/* -------------------------------------------------------------------------------------------------
 * Reading settings
 * ---------------------------------------------------------------------------------------------- */

/**
 * Trims a configured value and treats a blank one as absent.
 *
 * Blank means unset, throughout this module and deliberately: `.env.example`
 * ships `ANTHROPIC_API_KEY=` and `DEBUGGEN_MODEL=` with no value, and dotenv
 * turns both into the empty string. Reading those as "a credential that is
 * empty" and "a model called nothing" would send an unusable request instead
 * of reporting an unfinished configuration, and `DEBUGGEN_PROVIDER=` would
 * become an unrecognised selection rather than "not chosen".
 *
 * @param value A configured value, or `undefined` when the setting is absent.
 * @returns The trimmed value, or `undefined` when it was absent or blank.
 */
function normaliseSetting(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Reads one variable out of an environment map through {@link normaliseSetting}.
 *
 * @param env The environment to read, injected so nothing has to mutate
 * `process.env`.
 * @param name The variable's name.
 * @returns The trimmed value, or `undefined` when absent or blank.
 */
function readSetting(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return normaliseSetting(env[name]);
}

/* -------------------------------------------------------------------------------------------------
 * Budgets, validated rather than coerced
 * ---------------------------------------------------------------------------------------------- */

/**
 * What each budget must be, validated with Zod.
 *
 * This object is also the declaration of *which* members are budgets:
 * {@link NumericField} is its key set, and `satisfies` ties every key to
 * `ModelProviderConfig`'s own declaration, so a renamed or removed field is a
 * compile error here rather than a silently skipped check.
 *
 * The bounds mirror `./providers/anthropic.js`'s own predicates exactly — a
 * positive integer response bound, a sampling temperature of exactly
 * {@link ANTHROPIC_SUPPORTED_TEMPERATURE}, a positive integer timeout in
 * milliseconds, a non-negative integer retry count — so this module never
 * refuses a value the provider would accept, nor passes one it would refuse.
 * Other than the temperature, whose accepted value the messages API itself
 * fixes, no upper ceiling is invented: an arbitrary maximum here would reject a
 * legitimate configuration the transport is perfectly able to send.
 *
 * `z.coerce.number()` is what makes this a real boundary rather than a
 * formality. The declared type of an override is already `number`, but a host
 * that read its configuration from a file or an environment of its own hands
 * over `'512'`, and Zod 4 coerces that while still refusing `NaN`, `Infinity`
 * and a fractional value where an integer is required — which is precisely the
 * malformed-number case that must surface as a typed error instead of being
 * silently replaced by a default.
 */
const NUMERIC_SCHEMAS = {
  maxTokens: z.coerce.number().int().positive(),
  temperature: z.coerce.number().refine((value) => value === ANTHROPIC_SUPPORTED_TEMPERATURE),
  timeoutMs: z.coerce.number().int().positive(),
  maxRetries: z.coerce.number().int().nonnegative(),
} as const satisfies Readonly<Partial<Record<keyof ModelProviderConfig, z.ZodType<number>>>>;

/** One of the budget fields {@link NUMERIC_SCHEMAS} validates. */
type NumericField = keyof typeof NUMERIC_SCHEMAS;

/** How each budget's requirement is worded to a developer. */
const NUMERIC_EXPECTATIONS = {
  maxTokens: 'a positive integer number of tokens',
  temperature: `exactly ${String(ANTHROPIC_SUPPORTED_TEMPERATURE)}: the field is deprecated and current models reject every other value`,
  timeoutMs: 'a positive integer number of milliseconds',
  maxRetries: 'a non-negative integer',
} as const satisfies Readonly<Record<NumericField, string>>;

/**
 * The failure for a budget that is not a number of the required shape.
 *
 * Names the field and states what was expected; the offending value is not
 * echoed, which keeps this module's one rule — names, never values — without
 * an exception, and loses nothing a developer needs, since the value is in the
 * configuration they are looking at.
 *
 * @param field Which budget was malformed.
 * @returns A `CONFIG_INVALID` error naming the field.
 */
function invalidBudgetError(field: NumericField): DebuggenError {
  return configurationError(
    `The model provider budget '${field}' is not ${NUMERIC_EXPECTATIONS[field]}.`,
    `Correct ${field} where the model provider configuration is assembled. It must be ${NUMERIC_EXPECTATIONS[field]}; it is never defaulted when malformed, because a substituted budget would hide the mistake.`,
    'budget-invalid',
    { kind: 'override', name: field },
  );
}

/**
 * Validates one optional budget.
 *
 * @param value The configured value, or `undefined` when the host gave none.
 * @param field Which budget is being validated.
 * @returns `ok(undefined)` when unset, the parsed number when valid, and a
 * typed failure naming the field when not.
 */
function validateBudget(
  value: unknown,
  field: NumericField,
): Result<number | undefined, DebuggenError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const parsed = NUMERIC_SCHEMAS[field].safeParse(value);
  if (!parsed.success) {
    return err(invalidBudgetError(field));
  }
  return ok(parsed.data);
}

/* -------------------------------------------------------------------------------------------------
 * Resolving the configuration
 * ---------------------------------------------------------------------------------------------- */

/**
 * What `ModelProviderConfig.model` carries when no model was configured.
 *
 * The empty string, documented rather than invented: `./types.js` declares
 * `model` as a **required** `string` — deliberately, so no module can leave it
 * optional and quietly default it — and this module consumes that declaration
 * instead of redefining it, so "no model configured" needs a representation
 * inside `string`. The empty string is the only value that cannot be mistaken
 * for a model identifier, and it is the value
 * `./providers/anthropic.js` already refuses, so the two boundaries agree.
 *
 * The alternative considered was a discriminated union of two configuration
 * shapes, one per provider. It was not adopted because the shared
 * `ModelProviderConfig` is the contract both implementations and every host
 * already speak, and splitting it would push a discriminant into
 * `apps/local-service`'s configuration, the session record and both
 * providers' options for the sake of one field.
 *
 * This is why no literal naming a model appears anywhere in this package: the
 * absence of a model is representable, so nothing has to stand in for it.
 */
const UNCONFIGURED_MODEL = '';

/**
 * Resolves the selected provider id from the overrides, then the environment,
 * then {@link DEFAULT_PROVIDER_ID}.
 *
 * `isProviderId` matches exactly — no trimming, no case folding — and
 * normalising is this module's decision, made here: the value is trimmed and
 * lower-cased before being asked about, so `' Deterministic '` in a hand-edited
 * `.env` file selects the provider it obviously means instead of failing for
 * its padding. A value that is still not a member after that is genuinely
 * unrecognised, and its failure says so explicitly, so a developer is never
 * left wondering whether letter case was the cause.
 *
 * @param env The environment to read.
 * @param overrides The host's already-decided configuration, if any.
 * @returns The validated id, or a failure naming the setting that carried it.
 */
function resolveProviderId(
  env: Readonly<Record<string, string | undefined>>,
  overrides: Partial<ModelProviderConfig> | undefined,
): Result<ProviderId, DebuggenError> {
  const override = normaliseSetting(overrides?.providerId);
  if (override !== undefined) {
    return narrowProviderId(override, { kind: 'override', name: 'providerId' });
  }

  const configured = readSetting(env, PROVIDER_VARIABLE);
  if (configured !== undefined) {
    return narrowProviderId(configured, { kind: 'environment', name: PROVIDER_VARIABLE });
  }

  return ok(DEFAULT_PROVIDER_ID);
}

/**
 * Lower-cases an already-trimmed selection and validates it.
 *
 * @param value A trimmed, non-empty selection.
 * @param source The setting it came from, for the failure.
 * @returns The validated id, or a failure listing the accepted values.
 */
function narrowProviderId(value: string, source: SettingSource): Result<ProviderId, DebuggenError> {
  const normalised = value.toLowerCase();
  if (isProviderId(normalised)) {
    return ok(normalised);
  }
  return err(unrecognisedProviderError(source));
}

/**
 * Resolves the configuration a provider is constructed from, without
 * constructing one.
 *
 * Separate from {@link createModelProvider} so the configuration boundary can
 * be exercised — and so a host such as `apps/local-service`'s configuration
 * module can resolve, record and report the selection before anything is
 * built.
 *
 * Precedence is `overrides` first, then the environment, then this module's
 * default, per setting rather than per object: a host that overrides only the
 * provider id still has `DEBUGGEN_MODEL` read for it.
 *
 * What it validates, and what it deliberately does not:
 *
 * - The provider id is validated against `PROVIDER_IDS` and an unrecognised
 *   value fails here (see {@link resolveProviderId}).
 * - Every budget is validated (see {@link validateBudget}); a malformed one
 *   fails rather than falling back.
 * - `model` and `apiKey` are trimmed, and a blank one is treated as absent.
 *   Whether their absence is a failure is **not** decided here: it depends on
 *   the selected provider, and that is {@link createModelProvider}'s decision.
 *   A resolved configuration is therefore not automatically a usable one, and
 *   the rules-based path legitimately carries {@link UNCONFIGURED_MODEL}.
 * - No budget, base URL or credential other than `ANTHROPIC_API_KEY` is read
 *   from the environment. The environment surface is exactly the three names
 *   `.env.example` documents (AAP 0.3.4).
 *
 * @param env The environment to read. Defaults to `process.env`; injected in
 * tests so nothing has to mutate the real environment.
 * @param overrides Values the host already decided, which win over the
 * environment. A blank string is treated as absent, like a blank variable.
 * @returns The resolved configuration, or the first configuration failure.
 */
export function resolveProviderConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides?: Partial<ModelProviderConfig>,
): Result<ModelProviderConfig, DebuggenError> {
  const providerId = resolveProviderId(env, overrides);
  if (!providerId.ok) {
    return providerId;
  }

  const maxTokens = validateBudget(overrides?.maxTokens, 'maxTokens');
  if (!maxTokens.ok) {
    return maxTokens;
  }
  const temperature = validateBudget(overrides?.temperature, 'temperature');
  if (!temperature.ok) {
    return temperature;
  }
  const timeoutMs = validateBudget(overrides?.timeoutMs, 'timeoutMs');
  if (!timeoutMs.ok) {
    return timeoutMs;
  }
  const maxRetries = validateBudget(overrides?.maxRetries, 'maxRetries');
  if (!maxRetries.ok) {
    return maxRetries;
  }

  const model = normaliseSetting(overrides?.model) ?? readSetting(env, MODEL_VARIABLE);
  const apiKey = normaliseSetting(overrides?.apiKey) ?? readSetting(env, CREDENTIAL_VARIABLE);
  const baseUrl = normaliseSetting(overrides?.baseUrl);
  const logger = overrides?.logger;

  // Each optional member is spread in only when it has a value:
  // `exactOptionalPropertyTypes` distinguishes an absent property from one
  // present and `undefined`, and a provider reads `'field' in config`
  // semantics from that distinction.
  return ok({
    providerId: providerId.value,
    model: model ?? UNCONFIGURED_MODEL,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(maxTokens.value === undefined ? {} : { maxTokens: maxTokens.value }),
    ...(temperature.value === undefined ? {} : { temperature: temperature.value }),
    ...(timeoutMs.value === undefined ? {} : { timeoutMs: timeoutMs.value }),
    ...(maxRetries.value === undefined ? {} : { maxRetries: maxRetries.value }),
    ...(logger === undefined ? {} : { logger }),
  });
}

/* -------------------------------------------------------------------------------------------------
 * Constructing the selected provider
 * ---------------------------------------------------------------------------------------------- */

/**
 * Everything {@link createModelProvider} accepts. Every member is optional:
 * called with no argument at all, it reads `process.env` and constructs the
 * provider that environment selected.
 */
export interface CreateModelProviderOptions {
  /**
   * The environment to read the selection from. Defaults to `process.env`.
   *
   * Injectable on purpose: a suite hands in a plain object and observes every
   * branch of the selection without mutating the process it runs in, which is
   * what keeps tests independent of each other and of the machine.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /**
   * Values the host already decided, which win over the environment per
   * setting.
   *
   * This is how `apps/local-service`'s configuration module passes an
   * already-validated selection through without this module re-reading the
   * environment behind its back, and how a caller supplies a budget or a base
   * URL, neither of which has an environment form here.
   */
  readonly overrides?: Partial<ModelProviderConfig>;

  /**
   * Where the constructed provider logs.
   *
   * Takes precedence over `overrides.logger`, being the more specific of the
   * two, and is forwarded explicitly to whichever implementation is built —
   * `./providers/anthropic.js` reads its logger from its options rather than
   * from the configuration, so a logger that travelled only inside the
   * configuration would be dropped.
   *
   * A provider defaults to the no-op logger when none is given, so library use
   * and every test are silent unless a host asks for output. Nothing logged
   * here or by a provider carries a credential.
   */
  readonly logger?: Logger;
}

/**
 * Selects and constructs the model provider this process runs behind.
 *
 * The single entry point for the decision AAP 0.5.3 describes: resolve the
 * configuration (see {@link resolveProviderConfig}), then build the
 * implementation it names.
 *
 * - `deterministic` — the rules-based provider. Needs no credential, no model
 *   and no network, which is what makes it the default and what puts it on the
 *   critical path of every automated suite and the continuous-integration
 *   end-to-end run (AAP 0.5.2, 0.7.1).
 * - `anthropic` — the network-backed provider. Both `DEBUGGEN_MODEL` and
 *   `ANTHROPIC_API_KEY` must be present; either one missing is a configuration
 *   failure reported before any call is attempted, carrying AAP 0.5.5's
 *   sentence. Its per-request timeout and transport retry budget are always
 *   explicit: a host that configured neither is given the product defaults
 *   `./providers/anthropic.js` declares, never whichever bound the vendor's
 *   software development kit happens to apply.
 *
 * Synchronous, so a host's startup stays straight-line, and **unmemoised**: no
 * module-scope cache holds a provider, so a rotated credential takes effect on
 * the next call and no test inherits the previous test's configuration. The
 * caller owns the returned provider's lifetime.
 *
 * @param options The environment, overrides and logger to use. All optional.
 * @returns The constructed provider, or the configuration failure that
 * prevented it. Never throws for an expected configuration problem — that is
 * what the `Result` is for.
 *
 * @example Selecting from the process environment
 * ```ts
 * const created = createModelProvider({ logger });
 * if (!created.ok) {
 *   logger.error(created.error.message, created.error.toPayload());
 *   return created;
 * }
 * const provider = created.value;
 * ```
 */
export function createModelProvider(
  options?: CreateModelProviderOptions,
): Result<ModelProvider, DebuggenError> {
  const resolved = resolveProviderConfig(options?.env ?? process.env, options?.overrides);
  return andThen(resolved, (config) => constructProvider(config, options?.logger ?? config.logger));
}

/**
 * Builds the implementation a resolved configuration names.
 *
 * The `switch` is exhaustive over `ProviderId` and its unreachable branch calls
 * `assertNever`, which is the mechanism that keeps this module and
 * `./providers/index.js` in step: a provider added to `PROVIDER_IDS` widens the
 * union and this function stops compiling until it is handled. The branch must
 * therefore never be softened into a general `default` that returns something.
 *
 * @param config A configuration from {@link resolveProviderConfig}.
 * @param logger The effective logger, or `undefined` to leave a provider on
 * its own no-op default.
 * @returns The constructed provider, or the failure that prevented it.
 */
function constructProvider(
  config: ModelProviderConfig,
  logger: Logger | undefined,
): Result<ModelProvider, DebuggenError> {
  // `ModelProviderConfig.providerId` is declared as `string` in `./types.js`,
  // so that the configuration vocabulary does not depend on the `providers/`
  // subfolder that consumes it. Re-narrowing here is what that costs, and it
  // is also a real boundary: a configuration assembled by a host and handed in
  // through `overrides` reaches this point with its own idea of the field.
  const providerId = config.providerId;
  if (!isProviderId(providerId)) {
    return err(unrecognisedProviderError({ kind: 'override', name: 'providerId' }));
  }

  switch (providerId) {
    case 'deterministic':
      // Only the logger travels. The configuration is deliberately not
      // forwarded: on this path `model` is `UNCONFIGURED_MODEL`, which that
      // provider refuses by design, and a model identifier a host configured
      // while selecting this provider must not be stamped on an answer no
      // model produced. Constructed without one, it records its own id, so a
      // stored artifact stays truthful. Nothing else in the configuration is
      // meaningful to an implementation with no transport.
      return createDeterministicProvider(logger === undefined ? {} : { logger });

    case 'anthropic': {
      if (config.model.length === 0) {
        return err(missingSettingError(MODEL_VARIABLE, 'model-not-configured', MISSING_MODEL_HINT));
      }
      // Presence only, and nothing more: no value, no prefix and no length of
      // the credential reaches the message, the hint, the `details` or a log
      // record. `resolveProviderConfig` has already treated a blank variable
      // as absent, so an unfilled `.env.example` placeholder arrives here as
      // `undefined` rather than as an empty credential.
      if (config.apiKey === undefined) {
        return err(
          missingSettingError(
            CREDENTIAL_VARIABLE,
            'api-key-not-configured',
            MISSING_CREDENTIAL_HINT,
          ),
        );
      }
      // The transport budgets are made explicit here rather than left to the
      // software development kit's own defaults. No environment variable
      // carries them and `apps/local-service`'s configuration module supplies
      // neither, so without this the kit's blanket per-request timeout and
      // retry count would govern how long a stage can hang — a decision this
      // product would never have taken, applied silently. The values come from
      // `./providers/anthropic.js`, which owns the transport and re-applies the
      // same resolver to a configuration handed to it directly, so the two
      // boundaries cannot disagree; a host that configured either budget keeps
      // its own value.
      const budgets = resolveAnthropicTransportBudgets(config);
      return createAnthropicProvider({
        config: { ...config, timeoutMs: budgets.timeoutMs, maxRetries: budgets.maxRetries },
        ...(logger === undefined ? {} : { logger }),
      });
    }

    default:
      return assertNever(providerId, 'Unhandled model provider id');
  }
}
