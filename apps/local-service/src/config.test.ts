/**
 * Tests for `./config.ts`: the service's single environment reader, the
 * nine-key contract it enforces, the five `$DEBUGGEN_HOME` paths it derives and
 * the failure policy that keeps a credential out of every error it produces.
 *
 * Five different things are on trial here, and only the first is ordinary
 * parsing.
 *
 * The **three schemas** are the contract's enforcement, and each is exercised
 * on its own as well as through the loader: `serviceEnvSchema` over raw
 * variables, `serviceConfigOverridesSchema` over a host's own values, and
 * `resolvedServiceConfigSchema` over a whole configuration — the last of which
 * is what a caller reaching a configuration from somewhere other than the
 * environment validates against, so it is tested as the public surface it is.
 *
 * The **access boundary** is a rule about values, not about documentation. AAP
 * 0.5.6 makes reachability from this machine alone the assumption the
 * authentication, role and Origin rules rest on, so a host value that is not a
 * loopback interface is refused here rather than bound and regretted: the suite
 * pins both halves — every spelling of loopback that must work, and the
 * wildcard, private and public binds that must not.
 *
 * The **provider requirements** are the other cross-field rule. A provider that
 * reaches the network needs a model and a credential; a selection missing
 * either must fail at start-up naming the missing key, because the alternative
 * is a session that fails after the developer has asked a question and after
 * the project has been indexed and instrumented. The requirement table is
 * imported rather than restated, so the positive cases are built from the same
 * source the rule is.
 *
 * The **contract** — `SERVICE_ENV_KEYS` and `serviceConfigSchema` — is paired
 * documentation: the root `.env.example` documents exactly these nine
 * variables and `README.md`'s configuration section describes the same set, so
 * a key added to the loader without being documented (or documented without
 * being read) is only visible if something mechanical compares the two. The
 * expected list below is written out by hand for precisely that reason: it is a
 * second, independent copy of the contract, and a change to the module has to
 * be made here too, which is where a reviewer sees it.
 *
 * The **derived paths** are load-bearing for four subsystems that never compute
 * them again: `src/store/db.ts` opens `databasePath`, the patcher and
 * `src/cleanup/cleanup.ts` write and read `backups/<sessionId>/<originalHash>`
 * under `backupsDir`, `src/store/retention.ts` purges `indexCacheDir` (the same
 * directory `@debuggen/code-analysis`'s `resolveIndexCacheDir` computes by
 * joining `INDEX_CACHE_DIRECTORY_NAME` onto the same root), and
 * `src/server/auth.ts` reads and writes `authFilePath`. `$DEBUGGEN_HOME` is
 * resolved in that module and nowhere else in the product —
 * `@debuggen/shared/node`'s hardened filesystem helpers deliberately import
 * neither `node:os` nor `process.env` — so these assertions are the only place
 * the spelling of those five paths is checked at all.
 *
 * The **failure policy** is a privacy boundary. A configuration error is logged,
 * may be persisted with a session and is rendered in two user interfaces, so an
 * `ANTHROPIC_API_KEY` echoed into one — even truncated — has left this
 * machine's memory for its disk. The suite therefore plants a key-shaped value
 * alongside a deliberately invalid setting and asserts the planted string
 * appears in no textual surface of the resulting error: not the message, the
 * hint, the details, the wire payload, the stack or `JSON.stringify` of the
 * error itself.
 *
 * Six habits in here are deliberate.
 *
 * 1. **No environment mutation, no filesystem, no network.** `loadServiceConfig`
 *    takes an injected `env` record and an injected `homeDir`, so nothing here
 *    writes `process.env`, opens a directory or needs a temporary one. Every
 *    path fixture is a plausible absolute path that does not exist, which is
 *    itself the evidence that the module is pure: a reader that stat'ed,
 *    created or read anything would fail on them.
 * 2. **The vocabularies are imported, never restated.** `PROVIDER_IDS`,
 *    `DEFAULT_PROVIDER_ID`, `LOG_LEVELS`, `LOG_LEVEL_SETTINGS` and
 *    `DEBUGGEN_ERROR_CODES` come from the modules that own them, and the
 *    accepted-value tables are generated from them. A hand-written list of log
 *    levels or provider ids here would be a second definition, which is the
 *    defect the imports exist to prevent — and it would pass while the real
 *    vocabulary drifted.
 * 3. **Tables with labels, one case per test.** `it.each` over a labelled table
 *    names the offending value in the failure line, so a regression reads as
 *    "rejects a port above the maximum" rather than "rejects invalid input"
 *    with an index.
 * 4. **Every default is asserted twice**: once as the behaviour an empty
 *    environment produces, and once against the exported constant a reader and
 *    `README.md` trust. That is what stops the two from drifting.
 * 5. **Narrowing is exercised, not bypassed.** `isOk` and `isErr` are how these
 *    tests reach `value` and `error`, so a guard that stopped narrowing fails
 *    `pnpm typecheck` inside this file rather than somewhere downstream.
 * 6. **The credential fixture is assembled at run time.** This file is tracked,
 *    and `scripts/check-secrets.mjs` scans it with the same provider-prefix and
 *    entropy rules it applies to every other committed file. A key-shaped
 *    literal would be a finding, so the fixture is built from fragments and a
 *    generated body — the same technique, for the same reason, as
 *    `packages/model-provider/src/redact-guard.test.ts` and
 *    `scripts/check-secrets.test.mjs`.
 *
 * Every fixture value is generic (`/home/dev`, `/var/lib/debuggen-state`):
 * `scripts/check-no-hardcoding.mjs` keeps knowledge of the demo application out
 * of the product, and a test fixture is no place to start.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  LOG_LEVELS,
  isErr,
  isOk,
  joinPosix,
  normalizePosix,
  toPosix,
  type DebuggenErrorCode,
  type LogLevelSetting,
  type Result,
} from '@debuggen/shared';
import { DEFAULT_PROVIDER_ID, PROVIDER_IDS, type ProviderId } from '@debuggen/model-provider';

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTH_FILE_NAME,
  BACKUPS_DIRECTORY_NAME,
  DEFAULT_DEBUGGEN_HOME,
  DEFAULT_HOST,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PORT,
  DEFAULT_RETENTION_DAYS,
  EPHEMERAL_PORT,
  INDEX_CACHE_DIRECTORY_NAME,
  LOG_LEVEL_SETTINGS,
  MAX_PORT,
  PATH_UNRESOLVABLE_REASON,
  PROJECT_ROOT_UNRESOLVABLE_MESSAGE,
  PROJECT_ROOT_UNRESOLVABLE_REASON,
  PROMPTS_DIRECTORY_NAME,
  PROVIDER_REQUIREMENTS,
  SERVICE_ENV_KEYS,
  SESSIONS_DATABASE_FILE_NAME,
  STATE_HOME_OVERLAP_HINT,
  STATE_HOME_OVERLAP_MESSAGE,
  STATE_HOME_OVERLAP_REASON,
  canonicalizePath,
  describeServiceConfig,
  isServiceEnvKey,
  loadServiceConfig,
  pathsOverlap,
  requireProjectOutsideStateHome,
  stateHomeOverlap,
  resolvedServiceConfigSchema,
  serviceConfigOverridesSchema,
  serviceConfigSchema,
  serviceEnvSchema,
  toModelProviderOverrides,
  type ProviderRequirementKey,
  type ServiceConfig,
  type ServiceConfigOverrides,
  type ServiceEnvKey,
} from './config.js';

/*
 * ---------------------------------------------------------------------------
 * Fixture shapes
 * ---------------------------------------------------------------------------
 */

/** The environment record shape {@link loadServiceConfig} accepts. */
type ServiceEnv = Readonly<Record<string, string | undefined>>;

/** A single environment value the loader must reject, and the diagnosis it must record. */
interface RejectionCase {
  readonly label: string;
  readonly key: ServiceEnvKey;
  readonly value: string;
  readonly reason: string;
}

/** A host-supplied override the loader must reject just as firmly as a variable. */
interface OverrideRejectionCase {
  readonly label: string;
  readonly key: ServiceEnvKey;
  readonly overrides: ServiceConfigOverrides;
  readonly reason: string;
}

/** An accepted `DEBUGGEN_PORT` or `DEBUGGEN_RETENTION_DAYS` value and the number it resolves to. */
interface NumericCase {
  readonly label: string;
  readonly value: string;
  readonly expected: number;
}

/** An accepted `DEBUGGEN_HOME` value and the absolute POSIX root it resolves to. */
interface HomeCase {
  readonly label: string;
  readonly value: string;
  readonly expected: string;
}

/** The `{ key, reason }` pair shape a failure records in its details. */
interface ReportedIssue {
  readonly key: string;
  readonly reason: string;
}

/*
 * ---------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------
 */

/**
 * The home directory every `~` in this suite expands against.
 *
 * Injected rather than read from the account running the tests, which is the
 * whole point of the `homeDir` override: nothing here can reach — or write
 * anywhere near — a real home directory, and the expectations stay the same on
 * every machine and in CI.
 */
const HOME_DIR = '/home/dev';

/** What `DEFAULT_DEBUGGEN_HOME` expands to against {@link HOME_DIR}. */
const EXPECTED_DEFAULT_HOME = `${HOME_DIR}/.debuggen`;

/** An explicit state root, outside any checkout and outside the home directory. */
const EXPLICIT_HOME = '/var/lib/debuggen-state';

/** An explicit prompt directory, as the packaged editor extension would set it. */
const EXPLICIT_PROMPTS_DIR = '/opt/debug-generator/service/prompts';

/**
 * The prompt directory `loadServiceConfig` derives when nothing configures one.
 *
 * Computed here the way the module computes it — `new URL('../prompts',
 * import.meta.url)` — which is exact rather than approximate because this test
 * file sits in the same directory as the module it tests, so the single `..`
 * hop lands on the same workspace root for both. Normalised through the same
 * two helpers, so the comparison is against a value in the module's own
 * spelling (absolute, POSIX, no trailing separator) rather than the host's.
 */
const EXPECTED_DEFAULT_PROMPTS_DIR = normalizePosix(
  toPosix(fileURLToPath(new URL(`../${PROMPTS_DIRECTORY_NAME}`, import.meta.url))),
);

/**
 * The one code every failure from `./config.ts` carries.
 *
 * Typed as {@link DebuggenErrorCode} rather than left as a string literal, so a
 * code renamed in `@debuggen/shared` fails this file at `pnpm typecheck`
 * instead of at run time. Membership in `DEBUGGEN_ERROR_CODES` is asserted
 * separately, because the type is erased before the suite runs.
 */
const CONFIG_CODE: DebuggenErrorCode = 'CONFIG_INVALID';

/**
 * The nine keys the loader reads, in the order it resolves and reports them.
 *
 * Deliberately a hand-written second copy of `SERVICE_ENV_KEYS`: see this
 * file's overview. The two lists disagreeing is the signal, and a generated
 * expectation could not produce it. The comparison is between these two
 * TypeScript lists only — `.env.example` documents the same nine keys but
 * groups them for a reader, so its layout neither constrains nor is
 * constrained by this expectation.
 */
const EXPECTED_ENV_KEYS: readonly ServiceEnvKey[] = [
  'ANTHROPIC_API_KEY',
  'DEBUGGEN_PROVIDER',
  'DEBUGGEN_MODEL',
  'DEBUGGEN_HOST',
  'DEBUGGEN_PORT',
  'DEBUGGEN_HOME',
  'DEBUGGEN_LOG_LEVEL',
  'DEBUGGEN_RETENTION_DAYS',
  'DEBUGGEN_PROMPTS_DIR',
];

/**
 * Variables the dev-server launcher mints for the instrumented child process,
 * which are deliberately **not** service configuration.
 *
 * The Node preload inside the launched dev server reads these three; the
 * service never does, and listing one in the contract would suggest a hand-set
 * value could be valid when it never is — the credential is scoped to one
 * project root and expires when that process exits.
 */
const LAUNCHER_ONLY_ENV_KEYS: readonly string[] = [
  'DEBUGGEN_TOKEN',
  'DEBUGGEN_INGEST_URL',
  'DEBUGGEN_PROJECT_ROOT',
];

/** A model identifier as a host would configure one. Names no real model, by policy. */
const CONFIGURED_MODEL_ID = 'model-id-from-the-environment';

/** A second one, so a precedence test can tell the two channels apart. */
const OVERRIDE_MODEL_ID = 'model-id-from-the-override';

/**
 * The provider that is not the offline default.
 *
 * Derived from `PROVIDER_IDS` rather than named, so this suite carries no
 * second copy of the vocabulary: adding a provider to that tuple cannot leave
 * a stale identifier behind here.
 */
const NETWORK_PROVIDER_ID: ProviderId =
  PROVIDER_IDS.find((id) => id !== DEFAULT_PROVIDER_ID) ?? DEFAULT_PROVIDER_ID;

/** The `DEBUGGEN_PORT` value the privacy assertion plants beside a credential. */
const REJECTED_PORT_VALUE = 'not-a-port';

/** The reason recorded when a `~` value cannot be expanded because no home directory is known. */
const INDETERMINABLE_HOME_REASON =
  'the value starts with a home-directory prefix and no home directory could be determined';

/**
 * An absolute directory root in the module's own spelling: POSIX from the
 * filesystem root, or a drive-rooted Windows path once separators are
 * normalised. Written as a pattern so the derived-path assertions hold on
 * either platform without a second expectation.
 */
const ABSOLUTE_ROOT_PATTERN = /^(?:\/|[A-Za-z]:\/)/;

/** {@link SERVICE_ENV_KEYS} widened to plain strings, for membership checks against a string. */
const SERVICE_ENV_KEY_NAMES: readonly string[] = SERVICE_ENV_KEYS;

/** {@link DEBUGGEN_ERROR_CODES} widened to plain strings, for the same reason. */
const ERROR_CODE_NAMES: readonly string[] = DEBUGGEN_ERROR_CODES;

/*
 * ---------------------------------------------------------------------------
 * The credential fixture, assembled rather than written
 * ---------------------------------------------------------------------------
 */

/** Every character from `first` to `last` inclusive, so no dense literal is written down. */
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
 * Deterministic so a failure reproduces exactly, and cycled across the whole
 * alphabet so the result is as dense as real key material — which is what makes
 * the non-leakage assertion meaningful rather than a check against a word.
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
 * The one reason this exists: it keeps a credential prefix from appearing as a
 * contiguous literal in this tracked file, which `scripts/check-secrets.mjs`
 * would report as a finding. The split points carry no other meaning.
 */
function assemble(...fragments: readonly string[]): string {
  return fragments.join('');
}

/** Base64url: the alphabet of an opaque provider credential. */
const URLSAFE_CHARS =
  charRange('A', 'Z') + charRange('a', 'z') + charRange('0', '9') + assemble('-', '_');

/**
 * A credential-shaped `ANTHROPIC_API_KEY` value: the provider's prefix and a
 * long, dense body.
 *
 * Long enough that no accidental truncation of it could pass the containment
 * assertions by coincidence, and never written as one literal.
 */
const PLANTED_CREDENTIAL = assemble('s', 'k-ant-', 'api03-') + cycle(URLSAFE_CHARS, 48);

/*
 * ---------------------------------------------------------------------------
 * Provider requirements, built from the contract rather than restated
 * ---------------------------------------------------------------------------
 */

/**
 * A value that satisfies each setting a provider can require.
 *
 * Total over `ProviderRequirementKey`, which is derived from the module's own
 * requirement table: a provider that starts requiring a third setting fails
 * this file at `pnpm typecheck` until the suite knows what a satisfied one
 * looks like, rather than silently building an environment that no longer
 * satisfies the rule.
 */
const REQUIREMENT_VALUES: Readonly<Record<ProviderRequirementKey, string>> = {
  ANTHROPIC_API_KEY: PLANTED_CREDENTIAL,
  DEBUGGEN_MODEL: CONFIGURED_MODEL_ID,
};

/**
 * An environment that selects `id` and satisfies everything it requires.
 *
 * Derived from `PROVIDER_REQUIREMENTS`, so the positive cases and the rule come
 * from one source: the offline provider gets nothing beyond its selection, and
 * the network-backed one gets both a model and a credential without this file
 * deciding which those are.
 *
 * @param id The provider to select.
 * @param extra Further variables to set alongside it.
 */
function usableEnvFor(id: ProviderId, extra: ServiceEnv = {}): ServiceEnv {
  return {
    DEBUGGEN_PROVIDER: id,
    ...Object.fromEntries(
      PROVIDER_REQUIREMENTS[id].map((key) => [key, REQUIREMENT_VALUES[key]] as const),
    ),
    ...extra,
  };
}

/** The settings the network-backed provider requires, which is what the rule is about. */
const NETWORK_REQUIREMENTS: readonly ProviderRequirementKey[] =
  PROVIDER_REQUIREMENTS[NETWORK_PROVIDER_ID];

/*
 * ---------------------------------------------------------------------------
 * Helpers
 *
 * The two narrowing helpers go through the `isOk` / `isErr` guards rather than
 * reading `.ok` directly, so a guard that stopped narrowing fails
 * `pnpm typecheck` in this file. They throw rather than assert, because the
 * throw carries the other branch's content into the failure message — and the
 * failure message for an unexpected success is built by
 * `describeServiceConfig`, which is the one view of a configuration that holds
 * no credential.
 * ---------------------------------------------------------------------------
 */

/**
 * Loads a configuration from `env`, with the injected home directory applied.
 *
 * `homeDir` comes first so a case may replace it by naming it again in
 * `overrides` — which is how the "no home directory could be determined" case
 * is reached without touching the real one.
 */
function load(
  env: ServiceEnv,
  overrides?: ServiceConfigOverrides,
): Result<ServiceConfig, DebuggenError> {
  return loadServiceConfig(env, { homeDir: HOME_DIR, ...overrides });
}

/** The configuration of a successful load, or a failed test naming the error. */
function configOf(result: Result<ServiceConfig, DebuggenError>): ServiceConfig {
  if (isErr(result)) {
    throw new Error(`Expected Ok, received Err ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** The error of a failed load, or a failed test naming the configuration it produced. */
function errorOf(result: Result<ServiceConfig, DebuggenError>): DebuggenError {
  if (isOk(result)) {
    throw new Error(
      `Expected Err, received Ok ${JSON.stringify(describeServiceConfig(result.value))}`,
    );
  }
  return result.error;
}

/** Loads and unwraps in one step, for the many cases that expect success. */
function loadOk(env: ServiceEnv, overrides?: ServiceConfigOverrides): ServiceConfig {
  return configOf(load(env, overrides));
}

/** Loads and unwraps the failure in one step, for the rejection tables. */
function loadErr(env: ServiceEnv, overrides?: ServiceConfigOverrides): DebuggenError {
  return errorOf(load(env, overrides));
}

/**
 * Every textual surface of an error joined into one string.
 *
 * A containment assertion is only as good as its coverage of the ways an error
 * becomes text, so all five are included: the message a log line prints, the
 * hint both user interfaces render, the details a log line attaches, the wire
 * payload `@debuggen/protocol` carries, the JSON a session record would
 * persist, and the formatted form a bare `${error}` produces.
 *
 * The stack is deliberately **not** part of this string. A stack holds code
 * locations rather than values, so including it could only ever turn a fixture
 * that happens to look like a path into a false failure; the credential
 * assertion checks it separately, where a dense generated body cannot collide
 * with a file name.
 */
function serialiseError(error: DebuggenError): string {
  return [
    error.message,
    error.hint ?? '',
    JSON.stringify(error.details ?? {}),
    JSON.stringify(error.toPayload()),
    JSON.stringify(error),
    String(error),
  ].join('\n');
}

/** Whether an untyped details entry has the `{ key, reason }` shape a failure records. */
function isReportedIssue(value: unknown): value is ReportedIssue {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { key?: unknown; reason?: unknown };
  return typeof candidate.key === 'string' && typeof candidate.reason === 'string';
}

/**
 * The `{ key, reason }` pairs a failure recorded, read defensively because
 * `details` is a `Record<string, unknown>` by design — it is diagnostic context
 * for a log line, not a typed payload.
 */
function issuesOf(error: DebuggenError): readonly ReportedIssue[] {
  const raw = error.details?.issues;
  if (!Array.isArray(raw)) {
    throw new Error(`Expected details.issues to be an array, received ${JSON.stringify(raw)}`);
  }
  const issues = raw.filter(isReportedIssue);
  if (issues.length !== raw.length) {
    throw new Error(
      `Expected every details.issues entry to be { key, reason }: ${JSON.stringify(raw)}`,
    );
  }
  return issues;
}

/** The keys a failure reported, in the order it reported them. */
function keysOf(error: DebuggenError): readonly string[] {
  return issuesOf(error).map((entry) => entry.key);
}

/** The reason a failure recorded against one key, or `undefined` when it named none. */
function reasonFor(error: DebuggenError, key: ServiceEnvKey): string | undefined {
  return issuesOf(error).find((entry) => entry.key === key)?.reason;
}

/**
 * An unvalidated value in the position of a typed override.
 *
 * `ServiceConfigOverrides.logLevel` is typed `LogLevelSetting`, but the service
 * is also started from JavaScript — the bundle inside the editor extension —
 * where the type guarantees nothing, and the module validates the override for
 * exactly that reason. Reaching that branch from TypeScript needs one
 * deliberate widening, kept in this named helper so it reads as the scenario it
 * is rather than as a stray cast.
 */
function asLogLevelSetting(value: string): LogLevelSetting {
  return value as LogLevelSetting;
}

/**
 * An unvalidated value in the position of the environment record.
 *
 * The same deliberate widening as {@link asLogLevelSetting}, for the same
 * reason: `loadServiceConfig`'s parameter type makes a non-record unreachable
 * from TypeScript, while the bundled service inside the editor extension is
 * ultimately called from JavaScript — so the module answers with a typed
 * failure instead of throwing, and that branch is exercised rather than
 * assumed.
 */
function asServiceEnv(value: unknown): ServiceEnv {
  return value as ServiceEnv;
}

/*
 * ---------------------------------------------------------------------------
 * Tables: rejected environment values
 * ---------------------------------------------------------------------------
 */

/** The accepted port range, spelled from the module's own bounds. */
const PORT_RANGE_REASON = `the value is outside the accepted range ${EPHEMERAL_PORT} to ${MAX_PORT}`;

/** The accepted retention range: zero days upwards, bounded only by exact integer arithmetic. */
const RETENTION_RANGE_REASON = `the value is outside the accepted range 0 to ${Number.MAX_SAFE_INTEGER}`;

/** The clause every "that is not a whole number" rejection records. */
const NOT_AN_INTEGER_REASON = 'the value is not a whole number';

/**
 * `DEBUGGEN_PORT` values the loader must refuse.
 *
 * The four non-integer cases are the ones `Number.parseInt` would wave through:
 * it reads `'8080x'` as 8080, `'0x10'` as 0, `'80.5'` as 80 and stops at the
 * first space in `'43 117'`. A port silently truncated to whatever prefix
 * happened to parse is a service listening somewhere nobody configured.
 */
const PORT_REJECTIONS: readonly RejectionCase[] = [
  {
    label: 'a non-numeric port',
    key: 'DEBUGGEN_PORT',
    value: REJECTED_PORT_VALUE,
    reason: NOT_AN_INTEGER_REASON,
  },
  {
    label: 'a port with a trailing suffix',
    key: 'DEBUGGEN_PORT',
    value: '8080x',
    reason: NOT_AN_INTEGER_REASON,
  },
  {
    label: 'a decimal port',
    key: 'DEBUGGEN_PORT',
    value: '8080.5',
    reason: NOT_AN_INTEGER_REASON,
  },
  {
    label: 'a hexadecimal port',
    key: 'DEBUGGEN_PORT',
    value: '0x1f90',
    reason: NOT_AN_INTEGER_REASON,
  },
  {
    label: 'a port in exponential notation',
    key: 'DEBUGGEN_PORT',
    value: '8e3',
    reason: NOT_AN_INTEGER_REASON,
  },
  {
    label: 'a port with interior whitespace',
    key: 'DEBUGGEN_PORT',
    value: '43 117',
    reason: NOT_AN_INTEGER_REASON,
  },
  {
    label: 'a negative port',
    key: 'DEBUGGEN_PORT',
    value: '-8080',
    reason: PORT_RANGE_REASON,
  },
  {
    label: 'a port one above the maximum',
    key: 'DEBUGGEN_PORT',
    value: String(MAX_PORT + 1),
    reason: PORT_RANGE_REASON,
  },
];

/** `DEBUGGEN_RETENTION_DAYS` values the loader must refuse. */
const RETENTION_REJECTIONS: readonly RejectionCase[] = [
  {
    label: 'a fractional retention window',
    key: 'DEBUGGEN_RETENTION_DAYS',
    value: '1.5',
    reason: NOT_AN_INTEGER_REASON,
  },
  {
    label: 'a retention window in days and hours',
    key: 'DEBUGGEN_RETENTION_DAYS',
    value: '30d',
    reason: NOT_AN_INTEGER_REASON,
  },
  {
    label: 'a negative retention window',
    key: 'DEBUGGEN_RETENTION_DAYS',
    value: '-13',
    reason: RETENTION_RANGE_REASON,
  },
];

/** `DEBUGGEN_PROVIDER` and `DEBUGGEN_LOG_LEVEL` values the loader must refuse. */
const VOCABULARY_REJECTIONS: readonly RejectionCase[] = [
  {
    label: 'a provider this build does not offer',
    key: 'DEBUGGEN_PROVIDER',
    value: 'ghost-vendor',
    reason: 'the value names no provider this build offers',
  },
  {
    label: 'a log threshold outside the vocabulary',
    key: 'DEBUGGEN_LOG_LEVEL',
    value: 'extremely-loud',
    reason: 'the value names no known log level',
  },
];

/** The clause recorded against a host value that does not name this machine. */
const NOT_LOOPBACK_REASON = 'the value is not a loopback interface';

/**
 * `DEBUGGEN_HOST` values the loader must refuse.
 *
 * The two wildcard entries are the ones this table exists for: `0.0.0.0` and
 * the IPv6 any-address bind an authenticated local service to every interface
 * the machine has, which publishes a surface holding a developer's source
 * excerpts, telemetry and session history to anything that can route to it —
 * and neither looks alarming in a `.env` file. A private address, a public
 * address and a name that is not `localhost` follow the same rule: reachability
 * from this machine alone is the boundary the rest of the service assumes (AAP
 * 0.5.6), so this module refuses to widen it rather than trusting a listener to
 * fail later.
 *
 * Every value here is also checked against the privacy sweep below, which is
 * why none of them appears as a substring of the remedy the failure carries.
 */
const HOST_REJECTIONS: readonly RejectionCase[] = [
  {
    label: 'a host name containing whitespace',
    key: 'DEBUGGEN_HOST',
    value: 'left interface',
    reason: 'the value contains whitespace',
  },
  {
    label: 'the IPv4 wildcard bind',
    key: 'DEBUGGEN_HOST',
    value: '0.0.0.0',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'the IPv6 wildcard bind',
    key: 'DEBUGGEN_HOST',
    value: '::',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'a private network address',
    key: 'DEBUGGEN_HOST',
    value: '192.168.1.10',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'another private network address',
    key: 'DEBUGGEN_HOST',
    value: '10.1.2.3',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'a public address',
    key: 'DEBUGGEN_HOST',
    value: '203.0.113.7',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'a link-local IPv6 address',
    key: 'DEBUGGEN_HOST',
    value: 'fe80::1',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'an IPv4-mapped address that is not loopback',
    key: 'DEBUGGEN_HOST',
    value: '::ffff:192.168.1.10',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'a routable address embedded behind a different prefix',
    key: 'DEBUGGEN_HOST',
    value: '2001:db8::127.0.0.1',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'a host name that is not the loopback name',
    key: 'DEBUGGEN_HOST',
    value: 'service.example.test',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'a name that merely contains the loopback name',
    key: 'DEBUGGEN_HOST',
    value: 'localhost.example.test',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'a loopback address with a port suffix',
    key: 'DEBUGGEN_HOST',
    value: '127.0.0.1:8080',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'an unbalanced bracketed address',
    key: 'DEBUGGEN_HOST',
    value: '[::1',
    reason: NOT_LOOPBACK_REASON,
  },
  {
    label: 'an octet outside the accepted range',
    key: 'DEBUGGEN_HOST',
    value: '127.0.0.999',
    reason: NOT_LOOPBACK_REASON,
  },
];

/**
 * `DEBUGGEN_HOME` and `DEBUGGEN_PROMPTS_DIR` values the loader must refuse.
 *
 * The UNC case is the one worth naming: normalisation collapses the two leading
 * separators of `//server/share` to one, which would turn an off-volume path
 * into a local `/server/share` naming something else entirely — so the prefix
 * is refused before normalisation rather than silently rewritten.
 */
const PATH_REJECTIONS: readonly RejectionCase[] = [
  {
    label: 'a relative state root',
    key: 'DEBUGGEN_HOME',
    value: 'state/debuggen',
    reason: 'the value is not an absolute path',
  },
  {
    label: 'a state root relative to the home directory without a separator',
    key: 'DEBUGGEN_HOME',
    value: '~other-account/state',
    reason: 'a home-directory prefix naming another account is not supported',
  },
  {
    label: 'a UNC state root',
    key: 'DEBUGGEN_HOME',
    value: '//file-server/share/state',
    reason: 'a UNC path is not supported as a directory root',
  },
  {
    label: 'a drive-relative Windows state root',
    key: 'DEBUGGEN_HOME',
    value: 'C:state',
    reason: 'a drive-relative Windows path is not absolute',
  },
  {
    label: 'a state root containing a NUL character',
    key: 'DEBUGGEN_HOME',
    value: '/var/lib/deb\0uggen',
    reason: 'the value contains a NUL character',
  },
  {
    label: 'a relative prompt directory',
    key: 'DEBUGGEN_PROMPTS_DIR',
    value: 'service/prompts',
    reason: 'the value is not an absolute path',
  },
  {
    label: 'a UNC prompt directory',
    key: 'DEBUGGEN_PROMPTS_DIR',
    value: '//file-server/share/prompts',
    reason: 'a UNC path is not supported as a directory root',
  },
];

/** Every rejected environment value, for the sweeps that hold across all of them. */
const ALL_REJECTIONS: readonly RejectionCase[] = [
  ...PORT_REJECTIONS,
  ...RETENTION_REJECTIONS,
  ...VOCABULARY_REJECTIONS,
  ...HOST_REJECTIONS,
  ...PATH_REJECTIONS,
];

/**
 * `DEBUGGEN_HOST` values the loader must accept, and what each resolves to.
 *
 * Every spelling of "this machine" a developer might reasonably write, because
 * the boundary is only defensible if the legitimate forms work: the loopback
 * name in any letter case, any address in `127.0.0.0/8` rather than only the
 * first, the IPv6 loopback written compressed, expanded or zero-padded, the two
 * embedded-IPv4 mappings, and the bracketed form copied out of a URL — which
 * resolves without its brackets, because that is what a listener binds.
 */
const HOST_ACCEPTED: readonly HomeCase[] = [
  { label: 'the default loopback address', value: DEFAULT_HOST, expected: DEFAULT_HOST },
  { label: 'a padded loopback address', value: `  ${DEFAULT_HOST}  `, expected: DEFAULT_HOST },
  { label: 'another address in the loopback block', value: '127.0.0.53', expected: '127.0.0.53' },
  { label: 'the lowest address in the block', value: '127.0.0.0', expected: '127.0.0.0' },
  { label: 'the loopback name', value: 'localhost', expected: 'localhost' },
  { label: 'the loopback name in capitals', value: 'LOCALHOST', expected: 'LOCALHOST' },
  { label: 'the compressed IPv6 loopback address', value: '::1', expected: '::1' },
  {
    label: 'the bracketed IPv6 loopback address, without its brackets',
    value: '[::1]',
    expected: '::1',
  },
  {
    label: 'the written-out IPv6 loopback address',
    value: '0:0:0:0:0:0:0:1',
    expected: '0:0:0:0:0:0:0:1',
  },
  {
    label: 'the zero-padded IPv6 loopback address',
    value: '0000:0000:0000:0000:0000:0000:0000:0001',
    expected: '0000:0000:0000:0000:0000:0000:0000:0001',
  },
  {
    label: 'the IPv4-mapped loopback address',
    value: `::ffff:${DEFAULT_HOST}`,
    expected: `::ffff:${DEFAULT_HOST}`,
  },
  {
    label: 'the IPv4-compatible loopback address',
    value: `::${DEFAULT_HOST}`,
    expected: `::${DEFAULT_HOST}`,
  },
];

/**
 * Overrides the loader must refuse, despite their types.
 *
 * An override arrives from code rather than from a shell, but that code is a VS
 * Code setting, a command-line flag or a test helper — so an out-of-range value
 * is just as reachable, and a service that bound port `-1` because a caller was
 * trusted would fail far from its cause.
 */
const OVERRIDE_REJECTIONS: readonly OverrideRejectionCase[] = [
  {
    label: 'a negative injected port',
    key: 'DEBUGGEN_PORT',
    overrides: { port: -1 },
    reason: `the injected override is outside the accepted range ${EPHEMERAL_PORT} to ${MAX_PORT}`,
  },
  {
    label: 'an injected port above the maximum',
    key: 'DEBUGGEN_PORT',
    overrides: { port: MAX_PORT + 1 },
    reason: `the injected override is outside the accepted range ${EPHEMERAL_PORT} to ${MAX_PORT}`,
  },
  {
    label: 'a fractional injected port',
    key: 'DEBUGGEN_PORT',
    overrides: { port: 8080.5 },
    reason: 'the injected override is not a whole number',
  },
  {
    label: 'a negative injected retention window',
    key: 'DEBUGGEN_RETENTION_DAYS',
    overrides: { retentionDays: -1 },
    reason: `the injected override is outside the accepted range 0 to ${Number.MAX_SAFE_INTEGER}`,
  },
  {
    label: 'a fractional injected retention window',
    key: 'DEBUGGEN_RETENTION_DAYS',
    overrides: { retentionDays: 0.5 },
    reason: 'the injected override is not a whole number',
  },
  {
    label: 'an injected provider this build does not offer',
    key: 'DEBUGGEN_PROVIDER',
    overrides: { provider: 'ghost-vendor' },
    reason: 'the value names no provider this build offers',
  },
  {
    label: 'an injected log threshold outside the vocabulary',
    key: 'DEBUGGEN_LOG_LEVEL',
    overrides: { logLevel: asLogLevelSetting('extremely-loud') },
    reason: 'the value names no known log level',
  },
  {
    label: 'a relative injected state root',
    key: 'DEBUGGEN_HOME',
    overrides: { debuggenHome: 'state/debuggen' },
    reason: 'the value is not an absolute path',
  },
  {
    label: 'a relative injected prompt directory',
    key: 'DEBUGGEN_PROMPTS_DIR',
    overrides: { promptsDir: 'service/prompts' },
    reason: 'the value is not an absolute path',
  },
];

/*
 * ---------------------------------------------------------------------------
 * Tables: accepted environment values
 * ---------------------------------------------------------------------------
 */

/**
 * `DEBUGGEN_PORT` values the loader must accept.
 *
 * `0` is the load-bearing entry: it asks the operating system for an ephemeral
 * port, which is how the integration suites boot a real service per file
 * without sharing a fixed port. It is a documented setting rather than a
 * test-only allowance, so it is asserted as one.
 */
const PORT_ACCEPTED: readonly NumericCase[] = [
  { label: 'the ephemeral port', value: String(EPHEMERAL_PORT), expected: EPHEMERAL_PORT },
  { label: 'the lowest privileged port', value: '1', expected: 1 },
  { label: 'a padded value', value: '  8080  ', expected: 8080 },
  { label: 'an explicitly signed value', value: '+8080', expected: 8080 },
  { label: 'the highest port', value: String(MAX_PORT), expected: MAX_PORT },
];

/** `DEBUGGEN_RETENTION_DAYS` values the loader must accept. */
const RETENTION_ACCEPTED: readonly NumericCase[] = [
  { label: 'zero days, which purges everything eligible', value: '0', expected: 0 },
  { label: 'a single day', value: '1', expected: 1 },
  { label: 'a padded value', value: ' 90 ', expected: 90 },
  { label: 'a decade', value: '3650', expected: 3650 },
];

/**
 * `DEBUGGEN_HOME` values the loader must accept, and the root each resolves to.
 *
 * The `~` forms are the reason this expansion exists at all: the value
 * routinely arrives from a shell profile or a settings file, where a `~` is
 * ordinary and where nothing else will expand it — no filesystem call does, and
 * neither does `path.resolve`.
 */
const HOME_ACCEPTED: readonly HomeCase[] = [
  { label: 'the home directory itself', value: '~', expected: HOME_DIR },
  {
    label: 'a directory inside the home directory',
    value: '~/custom',
    expected: `${HOME_DIR}/custom`,
  },
  {
    label: 'a nested directory inside the home directory',
    value: '~/state/debuggen',
    expected: `${HOME_DIR}/state/debuggen`,
  },
  {
    label: 'a home-relative directory written with Windows separators',
    value: '~\\custom',
    expected: `${HOME_DIR}/custom`,
  },
  { label: 'an explicit absolute directory', value: EXPLICIT_HOME, expected: EXPLICIT_HOME },
  {
    label: 'an absolute directory with a trailing separator',
    value: `${EXPLICIT_HOME}/`,
    expected: EXPLICIT_HOME,
  },
  {
    label: 'an absolute directory needing normalisation',
    value: '/var/lib/./cache/../debuggen-state',
    expected: EXPLICIT_HOME,
  },
  {
    label: 'an absolute directory written with Windows separators',
    value: '\\var\\lib\\debuggen-state',
    expected: EXPLICIT_HOME,
  },
  {
    label: 'a drive-rooted Windows directory',
    value: 'C:\\ProgramData\\debuggen',
    expected: 'C:/ProgramData/debuggen',
  },
  { label: 'a padded value', value: `  ${EXPLICIT_HOME}  `, expected: EXPLICIT_HOME },
];

/*
 * ---------------------------------------------------------------------------
 * The environment contract
 * ---------------------------------------------------------------------------
 */

describe('SERVICE_ENV_KEYS', () => {
  it('is exactly the nine keys .env.example documents, in that order', () => {
    // The paired-documentation guard of this file's overview: if this fails,
    // either the loader gained a key that `.env.example` and README.md do not
    // document, or it lost one they still do.
    expect([...SERVICE_ENV_KEYS]).toStrictEqual([...EXPECTED_ENV_KEYS]);
  });

  it('names each key once', () => {
    expect(new Set(SERVICE_ENV_KEYS).size).toBe(SERVICE_ENV_KEYS.length);
  });

  it('excludes the variables the dev-server launcher mints for the child process', () => {
    for (const key of LAUNCHER_ONLY_ENV_KEYS) {
      expect(SERVICE_ENV_KEY_NAMES).not.toContain(key);
    }
  });

  it('ignores a launcher variable that happens to be in the environment', () => {
    // Not merely undocumented: reading one here would suggest a hand-set value
    // could be valid, when the credential is scoped to one project root and
    // expires with the process the launcher started.
    const withLauncherVariables: ServiceEnv = Object.fromEntries(
      LAUNCHER_ONLY_ENV_KEYS.map((key) => [key, `${key}-value`] as const),
    );

    expect(loadOk(withLauncherVariables)).toStrictEqual(loadOk({}));
  });
});

describe('serviceConfigSchema', () => {
  it('describes every key in the contract and nothing else', () => {
    expect(Object.keys(serviceConfigSchema.entries).sort()).toStrictEqual(
      [...EXPECTED_ENV_KEYS].sort(),
    );
    expect([...serviceConfigSchema.keys]).toStrictEqual([...SERVICE_ENV_KEYS]);
  });

  it('gives each descriptor the key it is filed under, and a description', () => {
    for (const key of SERVICE_ENV_KEYS) {
      const descriptor = serviceConfigSchema.entries[key];

      expect(descriptor.key).toBe(key);
      expect(descriptor.description.length).toBeGreaterThan(0);
    }
  });

  it('flags the credential, and only the credential, as secret', () => {
    for (const key of SERVICE_ENV_KEYS) {
      expect(serviceConfigSchema.entries[key].secret).toBe(key === 'ANTHROPIC_API_KEY');
    }
  });

  it('records the defaults the loader actually applies', () => {
    const { entries } = serviceConfigSchema;

    expect(entries.DEBUGGEN_HOST.defaultValue).toBe(DEFAULT_HOST);
    expect(entries.DEBUGGEN_PORT.defaultValue).toBe(DEFAULT_PORT);
    expect(entries.DEBUGGEN_HOME.defaultValue).toBe(DEFAULT_DEBUGGEN_HOME);
    expect(entries.DEBUGGEN_LOG_LEVEL.defaultValue).toBe(DEFAULT_LOG_LEVEL);
    expect(entries.DEBUGGEN_RETENTION_DAYS.defaultValue).toBe(DEFAULT_RETENTION_DAYS);
    expect(entries.DEBUGGEN_PROVIDER.defaultValue).toBe(DEFAULT_PROVIDER_ID);
  });

  it('records no default for the three keys that are never defaulted', () => {
    // The credential and the model id have none by policy; the prompt
    // directory's default is derived from the service module's own location at
    // call time rather than written down.
    expect(serviceConfigSchema.entries.ANTHROPIC_API_KEY.defaultValue).toBeUndefined();
    expect(serviceConfigSchema.entries.DEBUGGEN_MODEL.defaultValue).toBeUndefined();
    expect(serviceConfigSchema.entries.DEBUGGEN_PROMPTS_DIR.defaultValue).toBeUndefined();
  });

  it('publishes the closed vocabularies from the modules that own them', () => {
    expect(serviceConfigSchema.entries.DEBUGGEN_PROVIDER.allowedValues).toStrictEqual([
      ...PROVIDER_IDS,
    ]);
    expect(serviceConfigSchema.entries.DEBUGGEN_LOG_LEVEL.allowedValues).toStrictEqual([
      ...LOG_LEVEL_SETTINGS,
    ]);
    expect([...LOG_LEVEL_SETTINGS]).toStrictEqual([...LOG_LEVELS, 'silent']);
  });

  it('exposes the loader as safeParse', () => {
    expect(serviceConfigSchema.safeParse).toBe(loadServiceConfig);
    expect(serviceConfigSchema.safeParse({}, { homeDir: HOME_DIR })).toStrictEqual(
      loadServiceConfig({}, { homeDir: HOME_DIR }),
    );
  });

  it('is frozen, descriptors and all, because documentation checks share it', () => {
    expect(Object.isFrozen(serviceConfigSchema)).toBe(true);
    expect(Object.isFrozen(serviceConfigSchema.entries)).toBe(true);
    for (const key of SERVICE_ENV_KEYS) {
      expect(Object.isFrozen(serviceConfigSchema.entries[key])).toBe(true);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Defaults
 * ---------------------------------------------------------------------------
 */

describe('the configuration an empty environment produces', () => {
  it('binds the loopback interface on the documented port', () => {
    const config = loadOk({});

    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.port).toBeGreaterThan(EPHEMERAL_PORT);
    expect(config.port).toBeLessThanOrEqual(MAX_PORT);
  });

  it('logs at the documented threshold and keeps the documented retention window', () => {
    const config = loadOk({});

    expect(config.logLevel).toBe(DEFAULT_LOG_LEVEL);
    expect(config.logLevel).toBe('info');
    expect([...LOG_LEVEL_SETTINGS]).toContain(config.logLevel);
    expect(config.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(config.retentionDays).toBe(30);
  });

  it('defaults to the offline provider, which is a privacy posture and not a convenience', () => {
    // AAP 0.5.2: nothing leaves this machine while the deterministic provider
    // is selected, so the *default* is what makes the product private until a
    // developer deliberately opts out of it. The identifier is imported rather
    // than restated - `@debuggen/model-provider` owns the vocabulary - and the
    // second assertion is a deliberate cross-boundary pin: flipping either the
    // service default or the meaning of that constant has to fail here.
    const config = loadOk({});

    expect(config.provider).toBe(DEFAULT_PROVIDER_ID);
    expect(DEFAULT_PROVIDER_ID).toBe('deterministic');
    expect(toModelProviderOverrides(config).apiKey).toBeUndefined();
  });

  it('never defaults the model identifier', () => {
    // AAP 0.5.3: a session records the model it used, and a substituted default
    // would make that record untrue. Absent rather than `undefined`, which the
    // `in` check is what distinguishes under exactOptionalPropertyTypes.
    const config = loadOk({});

    expect(config.model).toBeUndefined();
    expect('model' in config).toBe(false);
    expect(describeServiceConfig(config).model).toBeNull();
  });

  it('leaves the credential absent', () => {
    const config = loadOk({});

    expect(config.anthropicApiKey).toBeUndefined();
    expect('anthropicApiKey' in config).toBe(false);
    expect(describeServiceConfig(config).anthropicApiKeyPresent).toBe(false);
  });

  it('resolves the state root from the documented ~ default against the injected home', () => {
    const config = loadOk({});

    expect(config.debuggenHome).toBe(EXPECTED_DEFAULT_HOME);
    // Proof that DEFAULT_DEBUGGEN_HOME is the literal the loader falls back to,
    // rather than a constant a reader trusts and a resolver that ignores it.
    expect(loadOk({ DEBUGGEN_HOME: DEFAULT_DEBUGGEN_HOME })).toStrictEqual(config);
  });

  it('falls back to the operating system home directory when none is injected', () => {
    // The one call in this suite that does not inject a home directory, because
    // it is the production path: `os.homedir()` is consulted through `tryCatch`,
    // so a system that cannot report one becomes a reported issue rather than a
    // throw out of a configuration read.
    const result = loadServiceConfig({});

    if (isErr(result)) {
      expect(reasonFor(result.error, 'DEBUGGEN_HOME')).toBe(INDETERMINABLE_HOME_REASON);
      return;
    }

    // `DEFAULT_DEBUGGEN_HOME.slice(1)` is the default without its `~`, so the
    // expectation reads the suffix from the constant instead of repeating it.
    expect(result.value.debuggenHome).toMatch(ABSOLUTE_ROOT_PATTERN);
    expect(result.value.debuggenHome.endsWith(DEFAULT_DEBUGGEN_HOME.slice(1))).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The $DEBUGGEN_HOME layout
 * ---------------------------------------------------------------------------
 */

describe('the state root', () => {
  it.each(HOME_ACCEPTED)('resolves $label', ({ value, expected }: HomeCase) => {
    expect(loadOk({ DEBUGGEN_HOME: value }).debuggenHome).toBe(expected);
  });

  it('prefers an injected state root over the variable', () => {
    const config = loadOk({ DEBUGGEN_HOME: EXPLICIT_HOME }, { debuggenHome: '~/injected' });

    expect(config.debuggenHome).toBe(`${HOME_DIR}/injected`);
  });

  it('refuses a ~ value when no home directory can be determined', () => {
    const error = loadErr({ DEBUGGEN_HOME: '~/state' }, { homeDir: 'not/absolute' });

    expect(error.code).toBe(CONFIG_CODE);
    expect(reasonFor(error, 'DEBUGGEN_HOME')).toBe(INDETERMINABLE_HOME_REASON);
  });

  it('reports the same refusal for the ~ default when no home directory can be determined', () => {
    // The default state root is itself `~`-prefixed, so an unusable home
    // directory is reported against DEBUGGEN_HOME even when nothing set it.
    const error = loadErr({}, { homeDir: 'not/absolute' });

    expect(reasonFor(error, 'DEBUGGEN_HOME')).toBe(INDETERMINABLE_HOME_REASON);
  });

  it('derives the four paths the other subsystems read, and derives them only here', () => {
    // src/store/db.ts opens the database, the patcher and src/cleanup/cleanup.ts
    // write and read backups/<sessionId>/<originalHash>, src/store/retention.ts
    // purges the index cache - which is the directory
    // @debuggen/code-analysis's `resolveIndexCacheDir` computes by joining the
    // same INDEX_CACHE_DIRECTORY_NAME onto the same root - and
    // src/server/auth.ts reads and writes the editor credential. None of them
    // joins these names again, so this is the only place the spelling is
    // checked.
    const config = loadOk({ DEBUGGEN_HOME: EXPLICIT_HOME });

    expect(config.databasePath).toBe(joinPosix(EXPLICIT_HOME, SESSIONS_DATABASE_FILE_NAME));
    expect(config.backupsDir).toBe(joinPosix(EXPLICIT_HOME, BACKUPS_DIRECTORY_NAME));
    expect(config.indexCacheDir).toBe(joinPosix(EXPLICIT_HOME, INDEX_CACHE_DIRECTORY_NAME));
    expect(config.authFilePath).toBe(joinPosix(EXPLICIT_HOME, AUTH_FILE_NAME));
  });

  it('derives them absolute, POSIX and inside the state root', () => {
    const config = loadOk({ DEBUGGEN_HOME: `${EXPLICIT_HOME}/` });
    const derived = [
      config.debuggenHome,
      config.databasePath,
      config.backupsDir,
      config.indexCacheDir,
      config.authFilePath,
    ];

    for (const path of derived) {
      expect(path).toMatch(ABSOLUTE_ROOT_PATTERN);
      expect(path).not.toContain('\\');
      expect(normalizePosix(path)).toBe(path);
      expect(toPosix(path)).toBe(path);
    }

    for (const path of derived.slice(1)) {
      expect(path.startsWith(`${config.debuggenHome}/`)).toBe(true);
    }
  });

  it('keeps the derived paths in step with a ~ root', () => {
    const config = loadOk({ DEBUGGEN_HOME: '~/state' });

    expect(config.debuggenHome).toBe(`${HOME_DIR}/state`);
    expect(config.databasePath).toBe(`${HOME_DIR}/state/${SESSIONS_DATABASE_FILE_NAME}`);
    expect(config.backupsDir).toBe(`${HOME_DIR}/state/${BACKUPS_DIRECTORY_NAME}`);
    expect(config.indexCacheDir).toBe(`${HOME_DIR}/state/${INDEX_CACHE_DIRECTORY_NAME}`);
    expect(config.authFilePath).toBe(`${HOME_DIR}/state/${AUTH_FILE_NAME}`);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The prompt directory
 * ---------------------------------------------------------------------------
 */

describe('the prompt directory', () => {
  it('derives the directory shipped beside the service when nothing configures one', () => {
    const { promptsDir } = loadOk({});

    expect(promptsDir).toBe(EXPECTED_DEFAULT_PROMPTS_DIR);
    expect(promptsDir.endsWith(`/${PROMPTS_DIRECTORY_NAME}`)).toBe(true);
    expect(promptsDir).toMatch(ABSOLUTE_ROOT_PATTERN);
    expect(promptsDir).not.toContain('\\');
  });

  it('prefers DEBUGGEN_PROMPTS_DIR over the derived default', () => {
    // The packaged editor extension copies the prompt files next to its own
    // bundle and sets this variable, which is why it exists at all.
    expect(loadOk({ DEBUGGEN_PROMPTS_DIR: EXPLICIT_PROMPTS_DIR }).promptsDir).toBe(
      EXPLICIT_PROMPTS_DIR,
    );
  });

  it('prefers an injected prompt directory over DEBUGGEN_PROMPTS_DIR', () => {
    const config = loadOk(
      { DEBUGGEN_PROMPTS_DIR: EXPLICIT_PROMPTS_DIR },
      { promptsDir: '~/prompts' },
    );

    expect(config.promptsDir).toBe(`${HOME_DIR}/prompts`);
  });

  it('normalises either channel the way it normalises the state root', () => {
    expect(loadOk({ DEBUGGEN_PROMPTS_DIR: `${EXPLICIT_PROMPTS_DIR}/` }).promptsDir).toBe(
      EXPLICIT_PROMPTS_DIR,
    );
    expect(loadOk({}, { promptsDir: '\\opt\\prompts\\' }).promptsDir).toBe('/opt/prompts');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Accepted values
 * ---------------------------------------------------------------------------
 */

describe('accepting a configured value', () => {
  it.each(PORT_ACCEPTED)('accepts $label as DEBUGGEN_PORT', ({ value, expected }: NumericCase) => {
    expect(loadOk({ DEBUGGEN_PORT: value }).port).toBe(expected);
  });

  it.each(RETENTION_ACCEPTED)(
    'accepts $label as DEBUGGEN_RETENTION_DAYS',
    ({ value, expected }: NumericCase) => {
      expect(loadOk({ DEBUGGEN_RETENTION_DAYS: value }).retentionDays).toBe(expected);
    },
  );

  it.each([...PROVIDER_IDS])('accepts the provider id %s', (id: ProviderId) => {
    // Each provider is selected alongside whatever it requires, taken from the
    // module's own requirement table: a usable selection is the positive case,
    // and an incomplete one belongs to the requirement suite below.
    expect(loadOk(usableEnvFor(id)).provider).toBe(id);
  });

  it.each([...PROVIDER_IDS])(
    'accepts %s whatever its padding and letter case',
    (id: ProviderId) => {
      // The normalisation `@debuggen/model-provider` applies to the same
      // variable, so a hand-edited `.env` selects the provider it obviously means.
      expect(
        loadOk(usableEnvFor(id, { DEBUGGEN_PROVIDER: `  ${id.toUpperCase()}  ` })).provider,
      ).toBe(id);
    },
  );

  it.each([...LOG_LEVEL_SETTINGS])('accepts the log threshold %s', (level: LogLevelSetting) => {
    expect(loadOk({ DEBUGGEN_LOG_LEVEL: level }).logLevel).toBe(level);
    expect(loadOk({ DEBUGGEN_LOG_LEVEL: ` ${level.toUpperCase()} ` }).logLevel).toBe(level);
  });

  it.each(HOST_ACCEPTED)('accepts $label as DEBUGGEN_HOST', ({ value, expected }: HomeCase) => {
    expect(loadOk({ DEBUGGEN_HOST: value }).host).toBe(expected);
  });

  it('accepts a model identifier from either channel, the override winning', () => {
    expect(loadOk({ DEBUGGEN_MODEL: `  ${CONFIGURED_MODEL_ID}  ` }).model).toBe(
      CONFIGURED_MODEL_ID,
    );
    expect(
      loadOk({ DEBUGGEN_MODEL: CONFIGURED_MODEL_ID }, { model: OVERRIDE_MODEL_ID }).model,
    ).toBe(OVERRIDE_MODEL_ID);
  });

  it('applies precedence per setting rather than per object', () => {
    // A host that overrides only the port still has every other variable read
    // for it, which is what lets the integration suites pin one setting.
    const config = loadOk(
      { DEBUGGEN_HOST: 'localhost', DEBUGGEN_PORT: '5000', DEBUGGEN_LOG_LEVEL: 'warn' },
      { port: EPHEMERAL_PORT },
    );

    expect(config.port).toBe(EPHEMERAL_PORT);
    expect(config.host).toBe('localhost');
    expect(config.logLevel).toBe('warn');
  });

  it('does not read a variable an override has already superseded', () => {
    // Precedence per setting means the losing value is not read at all, which
    // matters when it is unusable: an integration suite that pins an ephemeral
    // port must not be stopped by whatever DEBUGGEN_PORT a developer's shell
    // happens to export, and a stale value nobody uses is not a reason to
    // refuse to start.
    const config = loadOk(
      {
        DEBUGGEN_PORT: REJECTED_PORT_VALUE,
        DEBUGGEN_LOG_LEVEL: 'extremely-loud',
        DEBUGGEN_HOST: '0.0.0.0',
      },
      { port: EPHEMERAL_PORT, logLevel: 'warn', host: DEFAULT_HOST },
    );

    expect(config.port).toBe(EPHEMERAL_PORT);
    expect(config.logLevel).toBe('warn');
    expect(config.host).toBe(DEFAULT_HOST);
  });

  it('still reads DEBUGGEN_HOME when only the home directory is injected', () => {
    // `homeDir` is the context a `~` expands against, not a value for
    // DEBUGGEN_HOME, so injecting one must leave the variable in force - which
    // is what every suite in this file relies on.
    const config = loadOk({ DEBUGGEN_HOME: '~/state' }, { homeDir: HOME_DIR });

    expect(config.debuggenHome).toBe(`${HOME_DIR}/state`);
  });

  it('treats a blank value for every key as absent rather than as a configured empty', () => {
    // The real-world footgun this rule exists for: `.env.example` ships
    // `ANTHROPIC_API_KEY=` and `DEBUGGEN_MODEL=`, and the repository's Vitest
    // projects export `ANTHROPIC_API_KEY: ''`, so a reader that treated `''` as
    // a value would hand the provider a zero-length credential.
    const defaults = loadOk({});
    const blank: ServiceEnv = Object.fromEntries(SERVICE_ENV_KEYS.map((key) => [key, ''] as const));
    const whitespace: ServiceEnv = Object.fromEntries(
      SERVICE_ENV_KEYS.map((key) => [key, ' \t '] as const),
    );

    expect(loadOk(blank)).toStrictEqual(defaults);
    expect(loadOk(whitespace)).toStrictEqual(defaults);
  });

  it('treats a blank override as absent, exactly as a blank variable is', () => {
    const config = loadOk(
      {},
      {
        debuggenHome: '',
        promptsDir: '',
        host: '',
        provider: '',
        model: '',
        anthropicApiKey: '',
        port: undefined,
        retentionDays: undefined,
        logLevel: undefined,
      },
    );

    expect(config).toStrictEqual(loadOk({}));
  });
});

/*
 * ---------------------------------------------------------------------------
 * Rejections
 * ---------------------------------------------------------------------------
 */

describe('rejecting an unusable environment', () => {
  it.each(ALL_REJECTIONS)('rejects $label', ({ key, value, reason }: RejectionCase) => {
    const error = loadErr({ [key]: value });

    expect(DebuggenError.is(error)).toBe(true);
    // Membership in the closed vocabulary, asserted rather than compared with a
    // hand-typed string: the tuple is imported, so a code renamed there cannot
    // leave a stale literal passing here.
    expect(ERROR_CODE_NAMES).toContain(error.code);
    expect(error.code).toBe(CONFIG_CODE);
    expect(keysOf(error)).toStrictEqual([key]);
    expect(reasonFor(error, key)).toBe(reason);
    expect(error.details?.subsystem).toBe('config');
    expect(Object.keys(error.details ?? {}).sort()).toStrictEqual(['issues', 'keys', 'subsystem']);
  });

  it.each(ALL_REJECTIONS)(
    'names the key and never the value when rejecting $label',
    ({ key, value }: RejectionCase) => {
      // The rule the whole failure policy rests on: a reason and a hint are
      // assembled from the key name, the accepted vocabulary and the accepted
      // range, and from nothing else.
      const serialised = serialiseError(loadErr({ [key]: value }));

      expect(serialised).toContain(key);
      expect(serialised).not.toContain(value);
    },
  );

  it.each(ALL_REJECTIONS)(
    'answers with a next step for $label',
    ({ key, value }: RejectionCase) => {
      const hint = loadErr({ [key]: value }).hint ?? '';

      expect(hint).toContain(`Set ${key}`);
    },
  );

  it.each(OVERRIDE_REJECTIONS)(
    'rejects $label',
    ({ key, overrides, reason }: OverrideRejectionCase) => {
      const error = loadErr({}, overrides);

      expect(error.code).toBe(CONFIG_CODE);
      expect(keysOf(error)).toStrictEqual([key]);
      expect(reasonFor(error, key)).toBe(reason);
    },
  );

  it('lists every provider this build offers when the selection is unrecognised', () => {
    const hint = loadErr({ DEBUGGEN_PROVIDER: 'ghost-vendor' }).hint ?? '';

    for (const id of PROVIDER_IDS) {
      expect(hint).toContain(id);
    }
    expect(hint).toContain(DEFAULT_PROVIDER_ID);
  });

  it('lists every log threshold when the configured one is unknown', () => {
    const hint = loadErr({ DEBUGGEN_LOG_LEVEL: 'extremely-loud' }).hint ?? '';

    for (const level of LOG_LEVEL_SETTINGS) {
      expect(hint).toContain(level);
    }
    expect(hint).toContain(DEFAULT_LOG_LEVEL);
  });

  it('states the accepted range when a port is out of it', () => {
    const hint = loadErr({ DEBUGGEN_PORT: String(MAX_PORT + 1) }).hint ?? '';

    expect(hint).toContain(String(EPHEMERAL_PORT));
    expect(hint).toContain(String(MAX_PORT));
    expect(hint).toContain(String(DEFAULT_PORT));
  });

  it('reports every offending key in one failure, in the order the contract declares', () => {
    // One error rather than one per key: a developer editing a `.env` file
    // wants the whole list, because reporting the first problem and stopping
    // turns four mistakes into four start-up attempts.
    const error = loadErr({
      DEBUGGEN_PROVIDER: 'ghost-vendor',
      DEBUGGEN_HOST: 'left interface',
      DEBUGGEN_PORT: REJECTED_PORT_VALUE,
      DEBUGGEN_HOME: 'state/debuggen',
      DEBUGGEN_LOG_LEVEL: 'extremely-loud',
      DEBUGGEN_RETENTION_DAYS: '-13',
      DEBUGGEN_PROMPTS_DIR: 'service/prompts',
    });
    const reported = keysOf(error);

    expect(reported).toStrictEqual([
      'DEBUGGEN_PROVIDER',
      'DEBUGGEN_HOST',
      'DEBUGGEN_PORT',
      'DEBUGGEN_HOME',
      'DEBUGGEN_LOG_LEVEL',
      'DEBUGGEN_RETENTION_DAYS',
      'DEBUGGEN_PROMPTS_DIR',
    ]);
    // The same order the contract declares, derived rather than restated.
    expect(reported).toStrictEqual(SERVICE_ENV_KEY_NAMES.filter((key) => reported.includes(key)));
    expect(error.details?.keys).toStrictEqual(reported);

    for (const key of reported) {
      expect(error.message).toContain(key);
      expect(error.hint ?? '').toContain(`Set ${key}`);
    }
  });

  it('reports a variable and an override problem together', () => {
    const error = loadErr({ DEBUGGEN_LOG_LEVEL: 'extremely-loud' }, { port: -1 });

    expect(keysOf(error)).toStrictEqual(['DEBUGGEN_PORT', 'DEBUGGEN_LOG_LEVEL']);
  });

  it('throws nothing and exits nothing, whatever it is handed', () => {
    // `src/main.ts` owns the decision to report and exit; this module only ever
    // answers with a Result, which is what lets a suite drive every rejection.
    for (const { key, value } of ALL_REJECTIONS) {
      const result = load({ [key]: value });

      expect(isOk(result)).toBe(false);
      expect(isErr(result)).toBe(true);
    }
  });

  it('answers with a typed failure rather than a throw when the environment is not a record', () => {
    // Unreachable from TypeScript and reachable from JavaScript, which the
    // bundled service inside the editor extension ultimately is. It has no key
    // to name, so it is the one failure that names none - and it still carries
    // the details shape every log consumer expects.
    const error = errorOf(loadServiceConfig(asServiceEnv(null)));

    expect(error.code).toBe(CONFIG_CODE);
    expect(error.details?.subsystem).toBe('config');
    expect(error.details?.keys).toStrictEqual([]);
    expect(error.details?.issues).toStrictEqual([]);
    expect(error.hint ?? '').toContain('loadServiceConfig');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The access boundary
 * ---------------------------------------------------------------------------
 */

describe('the loopback bind', () => {
  it('states the accepted spellings when a value is not one of them', () => {
    const error = loadErr({ DEBUGGEN_HOST: '0.0.0.0' });
    const hint = error.hint ?? '';

    expect(reasonFor(error, 'DEBUGGEN_HOST')).toBe(NOT_LOOPBACK_REASON);
    expect(hint).toContain('Set DEBUGGEN_HOST');
    expect(hint).toContain('loopback');
    expect(hint).toContain(DEFAULT_HOST);
    expect(hint).toContain('localhost');
  });

  it('holds an injected interface to the same rule as the variable', () => {
    // A VS Code setting and a command-line flag reach this module as overrides,
    // so an override that widened the bind would be a hole in the boundary
    // rather than a convenience.
    const error = loadErr({}, { host: '0.0.0.0' });

    expect(keysOf(error)).toStrictEqual(['DEBUGGEN_HOST']);
    expect(reasonFor(error, 'DEBUGGEN_HOST')).toBe(NOT_LOOPBACK_REASON);
  });

  it('accepts an injected loopback interface, brackets and all', () => {
    expect(loadOk({}, { host: '[::1]' }).host).toBe('::1');
    expect(loadOk({ DEBUGGEN_HOST: '0.0.0.0' }, { host: DEFAULT_HOST }).host).toBe(DEFAULT_HOST);
  });

  it('refuses the wildcard binds by name, which is the whole point of the rule', () => {
    // The two values that widen the boundary by accident: they look like
    // configuration rather than like a decision to publish an authenticated
    // local service to every interface the machine has (AAP 0.5.6).
    for (const wildcard of ['0.0.0.0', '::']) {
      const result = load({ DEBUGGEN_HOST: wildcard });

      expect(isErr(result)).toBe(true);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The settings the selected provider requires
 * ---------------------------------------------------------------------------
 */

describe('the settings the selected provider requires', () => {
  /** The reason recorded when the selected provider has no credential. */
  const MISSING_CREDENTIAL_REASON =
    'the selected provider requires a credential and none is configured';

  /** The reason recorded when the selected provider has no model. */
  const MISSING_MODEL_REASON = 'the selected provider requires a model and none is configured';

  it('names both keys the network-backed provider needs', () => {
    // Derived from the module's own table rather than restated, so the suite
    // cannot keep asserting a rule the implementation has changed.
    expect([...NETWORK_REQUIREMENTS].sort()).toStrictEqual(['ANTHROPIC_API_KEY', 'DEBUGGEN_MODEL']);
    expect(PROVIDER_REQUIREMENTS[DEFAULT_PROVIDER_ID]).toStrictEqual([]);
    for (const key of NETWORK_REQUIREMENTS) {
      expect(isServiceEnvKey(key)).toBe(true);
    }
  });

  it('refuses the network-backed provider with no credential, naming the key', () => {
    const error = loadErr({
      DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID,
      DEBUGGEN_MODEL: CONFIGURED_MODEL_ID,
    });

    expect(error.code).toBe(CONFIG_CODE);
    expect(keysOf(error)).toStrictEqual(['ANTHROPIC_API_KEY']);
    expect(reasonFor(error, 'ANTHROPIC_API_KEY')).toBe(MISSING_CREDENTIAL_REASON);
    expect(error.hint ?? '').toContain('Set ANTHROPIC_API_KEY');
    // The remedy offers the offline alternative, which is the other way out of
    // this failure and the one that needs no credential at all.
    expect(error.hint ?? '').toContain(`DEBUGGEN_PROVIDER=${DEFAULT_PROVIDER_ID}`);
  });

  it('treats a blank credential as absent rather than as a configured empty', () => {
    // `.env.example` ships `ANTHROPIC_API_KEY=` and the repository's Vitest
    // projects export it as `''`, so a blank value must fail this rule exactly
    // as an unset one does - otherwise the provider receives a zero-length
    // credential and the failure moves to the first model call.
    for (const blank of ['', '   ']) {
      const error = loadErr({
        DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID,
        DEBUGGEN_MODEL: CONFIGURED_MODEL_ID,
        ANTHROPIC_API_KEY: blank,
      });

      expect(reasonFor(error, 'ANTHROPIC_API_KEY')).toBe(MISSING_CREDENTIAL_REASON);
    }
  });

  it('refuses the network-backed provider with no model, naming the key', () => {
    const error = loadErr({
      DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID,
      ANTHROPIC_API_KEY: PLANTED_CREDENTIAL,
    });

    expect(keysOf(error)).toStrictEqual(['DEBUGGEN_MODEL']);
    expect(reasonFor(error, 'DEBUGGEN_MODEL')).toBe(MISSING_MODEL_REASON);
    expect(error.hint ?? '').toContain('Set DEBUGGEN_MODEL');
    // AAP 0.5.3: never defaulted, because a session records the model it used.
    expect(error.hint ?? '').toContain('never defaulted');
  });

  it('reports both missing settings at once, in the order the contract declares', () => {
    const error = loadErr({ DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID });

    expect(keysOf(error)).toStrictEqual(['ANTHROPIC_API_KEY', 'DEBUGGEN_MODEL']);
    expect(error.details?.keys).toStrictEqual(['ANTHROPIC_API_KEY', 'DEBUGGEN_MODEL']);
    expect(error.message).toContain('ANTHROPIC_API_KEY');
    expect(error.message).toContain('DEBUGGEN_MODEL');
  });

  it('refuses a selection injected by a host just as firmly', () => {
    const error = loadErr({}, { provider: NETWORK_PROVIDER_ID });

    expect(keysOf(error)).toStrictEqual(['ANTHROPIC_API_KEY', 'DEBUGGEN_MODEL']);
  });

  it('reports a missing credential alongside an unrelated rejection', () => {
    // One failure carries the whole list: a developer filling in a `.env` file
    // should not discover the credential rule on the next attempt.
    const error = loadErr({
      DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID,
      DEBUGGEN_MODEL: CONFIGURED_MODEL_ID,
      DEBUGGEN_LOG_LEVEL: 'extremely-loud',
    });

    expect(keysOf(error)).toStrictEqual(['ANTHROPIC_API_KEY', 'DEBUGGEN_LOG_LEVEL']);
  });

  it('never carries the credential into a failure about the model', () => {
    // The planted value is present in the environment and missing from the
    // error: the rule that fails here is about the *model*, and the credential
    // beside it must not travel into a message, a hint, the details or the
    // wire payload.
    const serialised = serialiseError(
      loadErr({
        DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID,
        ANTHROPIC_API_KEY: PLANTED_CREDENTIAL,
      }),
    );

    expect(serialised).toContain('DEBUGGEN_MODEL');
    expect(serialised).not.toContain(PLANTED_CREDENTIAL);
    expect(serialised).not.toContain(PLANTED_CREDENTIAL.slice(0, 16));
  });

  it('names no provider id in a requirement failure, only the key and the remedy', () => {
    // The clause says "the selected provider" on purpose: a reason names the
    // key and the condition, and the configured value - even a vocabulary
    // member - is not part of the failure policy of this module.
    const error = loadErr({ DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID });

    expect(error.message).not.toContain(NETWORK_PROVIDER_ID);
    for (const entry of issuesOf(error)) {
      expect(entry.reason).not.toContain(NETWORK_PROVIDER_ID);
    }
  });

  it('accepts the network-backed provider once both settings are present', () => {
    const config = loadOk(usableEnvFor(NETWORK_PROVIDER_ID));

    expect(config.provider).toBe(NETWORK_PROVIDER_ID);
    expect(config.model).toBe(CONFIGURED_MODEL_ID);
    expect(config.anthropicApiKey).toBe(PLANTED_CREDENTIAL);
  });

  it('accepts them from the override channel too', () => {
    const config = loadOk(
      { DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID },
      { model: OVERRIDE_MODEL_ID, anthropicApiKey: PLANTED_CREDENTIAL },
    );

    expect(config.model).toBe(OVERRIDE_MODEL_ID);
    expect(config.anthropicApiKey).toBe(PLANTED_CREDENTIAL);
  });

  it('asks nothing of the offline provider, which is what keeps a checkout runnable', () => {
    // AAP 0.5.2: the default provider reaches no network, so an unconfigured
    // checkout must start and run the whole pipeline. A rule that demanded a
    // credential here would make the private path the inconvenient one.
    const config = loadOk({ DEBUGGEN_PROVIDER: DEFAULT_PROVIDER_ID });

    expect(config.provider).toBe(DEFAULT_PROVIDER_ID);
    expect('model' in config).toBe(false);
    expect('anthropicApiKey' in config).toBe(false);
    expect(isOk(load({}))).toBe(true);
  });

  it('accepts a credential the offline provider will not use', () => {
    // A developer who switches back to the offline provider leaves the key in
    // their `.env`; refusing it would be a rule about tidiness rather than
    // about whether the service can run.
    const config = loadOk({
      DEBUGGEN_PROVIDER: DEFAULT_PROVIDER_ID,
      ANTHROPIC_API_KEY: PLANTED_CREDENTIAL,
      DEBUGGEN_MODEL: CONFIGURED_MODEL_ID,
    });

    expect(config.provider).toBe(DEFAULT_PROVIDER_ID);
    expect(config.anthropicApiKey).toBe(PLANTED_CREDENTIAL);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The schemas themselves
 * ---------------------------------------------------------------------------
 */

describe('serviceEnvSchema', () => {
  it('normalises every raw variable into its resolved type', () => {
    const parsed = serviceEnvSchema.safeParse({
      DEBUGGEN_PORT: '  8080  ',
      DEBUGGEN_RETENTION_DAYS: '90',
      DEBUGGEN_PROVIDER: `  ${NETWORK_PROVIDER_ID.toUpperCase()}  `,
      DEBUGGEN_LOG_LEVEL: ' WARN ',
      DEBUGGEN_HOST: '[::1]',
      DEBUGGEN_MODEL: '',
    });

    if (!parsed.success) {
      throw new Error(`Expected the environment to parse: ${parsed.error.message}`);
    }
    expect(parsed.data.DEBUGGEN_PORT).toBe(8080);
    expect(parsed.data.DEBUGGEN_RETENTION_DAYS).toBe(90);
    expect(parsed.data.DEBUGGEN_PROVIDER).toBe(NETWORK_PROVIDER_ID);
    expect(parsed.data.DEBUGGEN_LOG_LEVEL).toBe('warn');
    expect(parsed.data.DEBUGGEN_HOST).toBe('::1');
    // Blank is absent, which is the rule the whole contract rests on.
    expect(parsed.data.DEBUGGEN_MODEL).toBeUndefined();
  });

  it('ignores every variable outside the contract', () => {
    // The input is an environment: it carries the operating system's variables
    // and the launcher's child-process ones, and rejecting them would make the
    // service unstartable on any real machine.
    const parsed = serviceEnvSchema.safeParse({
      PATH: '/usr/bin',
      DEBUGGEN_TOKEN: 'launcher-minted',
      DEBUGGEN_PORT: '5000',
    });

    if (!parsed.success) {
      throw new Error(`Expected unknown keys to be ignored: ${parsed.error.message}`);
    }
    // Only contract keys survive, and only the ones that had a value: an
    // absent setting is absent from the output rather than present as
    // `undefined`, which is the distinction the resolved contract rests on.
    expect(Object.keys(parsed.data).every((key) => isServiceEnvKey(key))).toBe(true);
    expect(Object.keys(parsed.data)).toStrictEqual(['DEBUGGEN_PORT']);
    expect(parsed.data.DEBUGGEN_PORT).toBe(5000);
  });

  it('rejects a value with this module’s own clause, never the library’s message', () => {
    const parsed = serviceEnvSchema.safeParse({ DEBUGGEN_PORT: REJECTED_PORT_VALUE });

    if (parsed.success) {
      throw new Error('Expected a non-numeric port to be rejected');
    }
    const messages = parsed.error.issues.map((entry) => entry.message);

    expect(messages).toStrictEqual([NOT_AN_INTEGER_REASON]);
    // The privacy rule at its source: the rejected value is absent from the
    // schema's own output, so nothing downstream has to strip it.
    expect(JSON.stringify(parsed.error.issues)).not.toContain(REJECTED_PORT_VALUE);
  });
});

describe('serviceConfigOverridesSchema', () => {
  it('accepts the values a host decides and normalises them the same way', () => {
    const parsed = serviceConfigOverridesSchema.safeParse({
      port: EPHEMERAL_PORT,
      host: `  ${DEFAULT_HOST}  `,
      provider: DEFAULT_PROVIDER_ID.toUpperCase(),
      promptsDir: '',
    });

    if (!parsed.success) {
      throw new Error(`Expected the overrides to parse: ${parsed.error.message}`);
    }
    expect(parsed.data.port).toBe(EPHEMERAL_PORT);
    expect(parsed.data.host).toBe(DEFAULT_HOST);
    expect(parsed.data.provider).toBe(DEFAULT_PROVIDER_ID);
    expect(parsed.data.promptsDir).toBeUndefined();
  });

  it('says "the injected override" when a host supplies the bad value', () => {
    const parsed = serviceConfigOverridesSchema.safeParse({ port: 8080.5 });

    if (parsed.success) {
      throw new Error('Expected a fractional injected port to be rejected');
    }
    expect(parsed.error.issues.map((entry) => entry.message)).toStrictEqual([
      'the injected override is not a whole number',
    ]);
  });
});

describe('resolvedServiceConfigSchema', () => {
  /** A configuration the loader produced, which the resolved schema must accept. */
  const resolvedConfig = loadOk(
    usableEnvFor(NETWORK_PROVIDER_ID, { DEBUGGEN_HOME: EXPLICIT_HOME }),
  );

  /** The reasons a rejected candidate recorded, from the issue messages the module authors. */
  const reasonsFor = (candidate: unknown): readonly string[] => {
    const parsed = resolvedServiceConfigSchema.safeParse(candidate);
    if (parsed.success) {
      throw new Error(`Expected the candidate to be rejected: ${JSON.stringify(candidate)}`);
    }
    return parsed.error.issues.map((entry) => entry.message);
  };

  it('accepts what the loader produced', () => {
    const parsed = resolvedServiceConfigSchema.safeParse(resolvedConfig);

    if (!parsed.success) {
      throw new Error(`Expected the loaded configuration to validate: ${parsed.error.message}`);
    }
    expect(parsed.data.debuggenHome).toBe(EXPLICIT_HOME);
    expect(parsed.data.provider).toBe(NETWORK_PROVIDER_ID);
  });

  it('refuses a configuration that binds something other than loopback', () => {
    // The reason the resolved contract exists rather than living only in the
    // loader: a configuration assembled elsewhere - a host object, a record
    // read back from disk - is held to exactly the same boundary.
    expect(reasonsFor({ ...resolvedConfig, host: '0.0.0.0' })).toContain(NOT_LOOPBACK_REASON);
  });

  it('refuses a configuration whose provider has nothing to authenticate with', () => {
    const withoutCredential: Record<string, unknown> = { ...resolvedConfig };
    delete withoutCredential['anthropicApiKey'];

    expect(reasonsFor(withoutCredential)).toContain(
      'the selected provider requires a credential and none is configured',
    );
  });

  it('refuses a derived path that does not sit under the state root', () => {
    // The invariant four subsystems trust without re-deriving it: the store,
    // the backup writer, the retention sweep and the credential writer read
    // these paths from the configuration and join nothing themselves.
    expect(
      reasonsFor({
        ...resolvedConfig,
        databasePath: joinPosix('/var/lib/elsewhere', SESSIONS_DATABASE_FILE_NAME),
      }),
    ).toContain('the derived state-root paths do not agree with the resolved root');
  });

  it('refuses a path that is relative or unnormalised', () => {
    const unnormalised = 'the resolved path is not an absolute, normalised path';

    expect(reasonsFor({ ...resolvedConfig, promptsDir: 'service/prompts' })).toContain(
      unnormalised,
    );
    expect(reasonsFor({ ...resolvedConfig, promptsDir: `${EXPLICIT_PROMPTS_DIR}/` })).toContain(
      unnormalised,
    );
  });

  it('refuses a port and a retention window outside their ranges', () => {
    expect(reasonsFor({ ...resolvedConfig, port: MAX_PORT + 1 })).toStrictEqual([
      PORT_RANGE_REASON,
    ]);
    expect(reasonsFor({ ...resolvedConfig, retentionDays: -1 })).toStrictEqual([
      RETENTION_RANGE_REASON,
    ]);
  });
});

describe('serviceConfigSchema as the whole contract', () => {
  it('carries the three schemas that do the validating', () => {
    expect(serviceConfigSchema.env).toBe(serviceEnvSchema);
    expect(serviceConfigSchema.overrides).toBe(serviceConfigOverridesSchema);
    expect(serviceConfigSchema.resolved).toBe(resolvedServiceConfigSchema);
  });

  it('agrees with the loader about what a valid configuration is', () => {
    // The two halves of the contract, checked against each other: anything the
    // loader returns must satisfy the resolved schema, and the loader is the
    // schema's only producer inside the service.
    const config = loadOk({ DEBUGGEN_HOME: EXPLICIT_HOME, DEBUGGEN_PORT: '5000' });

    expect(serviceConfigSchema.resolved.safeParse(config).success).toBe(true);
  });

  it('answers a valid environment identically through either entry point', () => {
    expect(serviceConfigSchema.safeParse({}, { homeDir: HOME_DIR })).toStrictEqual(
      loadServiceConfig({}, { homeDir: HOME_DIR }),
    );
  });
});

describe('isServiceEnvKey', () => {
  it('accepts every key in the contract and nothing else', () => {
    for (const key of SERVICE_ENV_KEYS) {
      expect(isServiceEnvKey(key)).toBe(true);
    }
    for (const other of [...LAUNCHER_ONLY_ENV_KEYS, 'PATH', '', 'debuggen_port']) {
      expect(isServiceEnvKey(other)).toBe(false);
    }
    for (const nonString of [undefined, null, 42, {}, ['DEBUGGEN_PORT']]) {
      expect(isServiceEnvKey(nonString)).toBe(false);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Privacy
 * ---------------------------------------------------------------------------
 */

describe('the credential', () => {
  /** An environment that configures a credential and one setting that cannot be parsed. */
  const failingEnvWithCredential: ServiceEnv = {
    ANTHROPIC_API_KEY: PLANTED_CREDENTIAL,
    DEBUGGEN_MODEL: CONFIGURED_MODEL_ID,
    DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID,
    DEBUGGEN_PORT: REJECTED_PORT_VALUE,
  };

  it('appears in no surface of the error a failed load returns', () => {
    const error = loadErr(failingEnvWithCredential);
    const serialised = serialiseError(error);

    expect(error.code).toBe(CONFIG_CODE);
    // The hard requirement. Not the value, not its prefix, not any fragment of
    // it long enough to identify the credential it came from.
    expect(serialised).not.toContain(PLANTED_CREDENTIAL);
    expect(serialised).not.toContain(PLANTED_CREDENTIAL.slice(0, 16));
    expect(serialised).not.toContain(PLANTED_CREDENTIAL.slice(-16));
    expect(error.stack ?? '').not.toContain(PLANTED_CREDENTIAL);
    expect(error.stack ?? '').not.toContain(PLANTED_CREDENTIAL.slice(0, 16));
  });

  it('is not echoed alongside the value that actually failed to parse', () => {
    // The policy is key names and reasons only, so the rejected port's value is
    // as absent as the credential.
    const serialised = serialiseError(loadErr(failingEnvWithCredential));

    expect(serialised).toContain('DEBUGGEN_PORT');
    expect(serialised).not.toContain(REJECTED_PORT_VALUE);
  });

  it('leaves only key names and enumerated reasons in the details a log line attaches', () => {
    const error = loadErr(failingEnvWithCredential);

    for (const entry of issuesOf(error)) {
      expect(SERVICE_ENV_KEY_NAMES).toContain(entry.key);
      expect(entry.reason).not.toContain(PLANTED_CREDENTIAL);
      expect(entry.reason).not.toContain(REJECTED_PORT_VALUE);
    }
  });

  it('is carried on the success path, because the provider needs it', () => {
    // Deliberately transported: the service reaches the network-backed provider
    // with it. What must never happen is a *failure* carrying it, which the
    // assertions above pin.
    const config = loadOk({
      ANTHROPIC_API_KEY: `  ${PLANTED_CREDENTIAL}  `,
      DEBUGGEN_MODEL: CONFIGURED_MODEL_ID,
      DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID,
    });

    expect(config.anthropicApiKey).toBe(PLANTED_CREDENTIAL);
    expect(toModelProviderOverrides(config).apiKey).toBe(PLANTED_CREDENTIAL);
  });

  it('is reported as presence, never as content, in the loggable view', () => {
    const config = loadOk({ ANTHROPIC_API_KEY: PLANTED_CREDENTIAL });
    const described = JSON.stringify(describeServiceConfig(config));

    expect(describeServiceConfig(config).anthropicApiKeyPresent).toBe(true);
    expect(described).not.toContain(PLANTED_CREDENTIAL);
    expect(described).not.toContain(PLANTED_CREDENTIAL.slice(0, 16));
  });

  it('is accepted from an injected override too, and still never logged', () => {
    const config = loadOk({}, { anthropicApiKey: PLANTED_CREDENTIAL });

    expect(config.anthropicApiKey).toBe(PLANTED_CREDENTIAL);
    expect(JSON.stringify(describeServiceConfig(config))).not.toContain(PLANTED_CREDENTIAL);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Purity
 * ---------------------------------------------------------------------------
 */

describe('loading is pure', () => {
  it('creates nothing and reads nothing: a root that does not exist resolves fine', () => {
    // The evidence, without a filesystem sandbox: every path fixture in this
    // suite names a directory that does not exist, so a reader that stat'ed,
    // created or opened one would fail here rather than answer.
    const config = loadOk({ DEBUGGEN_HOME: '/var/lib/debuggen-does-not-exist' });

    expect(config.debuggenHome).toBe('/var/lib/debuggen-does-not-exist');
    expect(config.databasePath).toBe(
      `/var/lib/debuggen-does-not-exist/${SESSIONS_DATABASE_FILE_NAME}`,
    );
  });

  it('answers from the record it was handed, not from the ambient environment', () => {
    // `process.env` is read nowhere in the module, which is what makes this
    // suite - and every integration suite - able to drive the whole surface
    // with a literal. Asserted by the answer tracking the argument exactly, in
    // both directions, while nothing here touches the process environment.
    expect(loadOk({}).provider).toBe(DEFAULT_PROVIDER_ID);
    expect(loadOk(usableEnvFor(NETWORK_PROVIDER_ID)).provider).toBe(NETWORK_PROVIDER_ID);
    expect(loadOk({ DEBUGGEN_PORT: String(EPHEMERAL_PORT) }).port).toBe(EPHEMERAL_PORT);
    expect(loadOk({}).port).toBe(DEFAULT_PORT);
  });

  it('is deterministic: two identical calls produce deeply equal configurations', () => {
    // No clock, no randomness, no cached state: a session records the
    // configuration it started under, and a value that varied between reads
    // would make that record meaningless.
    const env: ServiceEnv = usableEnvFor(NETWORK_PROVIDER_ID, {
      DEBUGGEN_HOME: EXPLICIT_HOME,
      DEBUGGEN_PORT: '5000',
    });

    expect(loadOk(env)).toStrictEqual(loadOk(env));
    expect(loadErr({ DEBUGGEN_PORT: REJECTED_PORT_VALUE }).message).toBe(
      loadErr({ DEBUGGEN_PORT: REJECTED_PORT_VALUE }).message,
    );
  });

  it('leaves the record it was handed untouched', () => {
    const env: Record<string, string | undefined> = {
      DEBUGGEN_PORT: '5000',
      DEBUGGEN_HOME: EXPLICIT_HOME,
    };
    const before = { ...env };

    loadOk(env);

    expect(env).toStrictEqual(before);
  });

  it('does not alias the record it was handed', () => {
    const env: Record<string, string | undefined> = { DEBUGGEN_PORT: '5000' };
    const config = loadOk(env);

    env.DEBUGGEN_PORT = '6000';
    env.DEBUGGEN_HOME = '/var/lib/elsewhere';

    expect(config.port).toBe(5000);
    expect(config.debuggenHome).toBe(EXPECTED_DEFAULT_HOME);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Handing the values on
 * ---------------------------------------------------------------------------
 */

describe('toModelProviderOverrides', () => {
  it('forwards the validated selection', () => {
    const config = loadOk(usableEnvFor(NETWORK_PROVIDER_ID));

    expect(toModelProviderOverrides(config).providerId).toBe(NETWORK_PROVIDER_ID);
  });

  it('forwards a selection that needs no credential without inventing one', () => {
    // The offline provider is the default and requires nothing, so the
    // overrides carry the selection alone - which is what makes
    // `@debuggen/model-provider` construct the rules-based implementation
    // rather than look for a key nobody configured.
    const overrides = toModelProviderOverrides(loadOk(usableEnvFor(DEFAULT_PROVIDER_ID)));

    expect(overrides.providerId).toBe(DEFAULT_PROVIDER_ID);
    expect('apiKey' in overrides).toBe(false);
    expect('model' in overrides).toBe(false);
  });

  it('omits an absent model and an absent credential rather than passing undefined', () => {
    // The receiving type distinguishes the two under exactOptionalPropertyTypes
    // and treats an omitted model as "nothing configured one", which is what
    // makes `@debuggen/model-provider` report an unusable configuration instead
    // of calling a model nobody chose.
    const overrides = toModelProviderOverrides(loadOk({}));

    expect('model' in overrides).toBe(false);
    expect('apiKey' in overrides).toBe(false);
    expect(Object.keys(overrides)).toStrictEqual(['providerId']);
  });

  it('forwards a configured model and credential', () => {
    const overrides = toModelProviderOverrides(
      loadOk({
        DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID,
        DEBUGGEN_MODEL: CONFIGURED_MODEL_ID,
        ANTHROPIC_API_KEY: PLANTED_CREDENTIAL,
      }),
    );

    expect(overrides).toStrictEqual({
      providerId: NETWORK_PROVIDER_ID,
      model: CONFIGURED_MODEL_ID,
      apiKey: PLANTED_CREDENTIAL,
    });
  });
});

describe('describeServiceConfig', () => {
  it('reports every value a developer diagnosing a start-up needs', () => {
    const config = loadOk(
      usableEnvFor(NETWORK_PROVIDER_ID, {
        DEBUGGEN_HOME: EXPLICIT_HOME,
        DEBUGGEN_PROMPTS_DIR: EXPLICIT_PROMPTS_DIR,
      }),
    );

    expect(describeServiceConfig(config)).toStrictEqual({
      subsystem: 'config',
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      logLevel: DEFAULT_LOG_LEVEL,
      retentionDays: DEFAULT_RETENTION_DAYS,
      provider: NETWORK_PROVIDER_ID,
      model: CONFIGURED_MODEL_ID,
      // Presence, never content: the network-backed selection carries a
      // credential by necessity, and this is the one view of a configuration
      // that may be logged.
      anthropicApiKeyPresent: true,
      debuggenHome: EXPLICIT_HOME,
      databasePath: joinPosix(EXPLICIT_HOME, SESSIONS_DATABASE_FILE_NAME),
      backupsDir: joinPosix(EXPLICIT_HOME, BACKUPS_DIRECTORY_NAME),
      indexCacheDir: joinPosix(EXPLICIT_HOME, INDEX_CACHE_DIRECTORY_NAME),
      authFilePath: joinPosix(EXPLICIT_HOME, AUTH_FILE_NAME),
      promptsDir: EXPLICIT_PROMPTS_DIR,
    });
  });

  it('holds no key of its own beyond the credential presence flag', () => {
    const described = describeServiceConfig(loadOk({}));

    expect(Object.keys(described)).not.toContain('anthropicApiKey');
    expect(described.anthropicApiKeyPresent).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The state root stays outside every project (CWE-200)
 * ---------------------------------------------------------------------------
 */

/** Sandboxes the overlap suite created, removed after each test. */
const overlapSandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of overlapSandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

/**
 * A fresh, canonical temporary directory: `realpath`ed, because the host's
 * temporary directory may itself be reached through a link.
 */
function overlapSandbox(): string {
  const sandbox = toPosix(realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-config-overlap-'))));
  overlapSandboxes.push(sandbox);
  return sandbox;
}

/** Creates `path` (and its parents) and returns it in POSIX spelling. */
function directory(path: string): string {
  mkdirSync(path, { recursive: true });
  return toPosix(path);
}

/** Fails the test unless `result` is an `Err`, and returns its error. */
function refusalOf(result: Result<string, DebuggenError>): DebuggenError {
  if (!isErr(result)) {
    return expect.unreachable(`expected a refusal, got ${result.value}`);
  }
  return result.error;
}

/** Every textual surface of an error, for the "names no path" assertions. */
function surfacesOf(error: DebuggenError): string {
  return [
    error.message,
    error.hint ?? '',
    JSON.stringify(error.details ?? {}),
    JSON.stringify(error),
  ].join('\n');
}

describe('pathsOverlap and stateHomeOverlap', () => {
  it('see the same directory and either one inside the other as overlapping', () => {
    expect(pathsOverlap('/work/shop', '/work/shop')).toBe(true);
    expect(pathsOverlap('/work/shop', '/work/shop/.debuggen')).toBe(true);
    expect(pathsOverlap('/home/dev/.debuggen/projects/shop', '/home/dev/.debuggen')).toBe(true);

    expect(stateHomeOverlap('/work/shop', '/work/shop')).toBe('same-directory');
    expect(stateHomeOverlap('/work/shop/.debuggen', '/work/shop')).toBe('home-inside-project');
    expect(stateHomeOverlap('/home/dev/.debuggen', '/home/dev/.debuggen/shop')).toBe(
      'project-inside-home',
    );
  });

  it('keep siblings that merely share a prefix apart, segment by segment', () => {
    expect(pathsOverlap('/work/shop', '/work/shop-state')).toBe(false);
    expect(pathsOverlap('/work/shop-state', '/work/shop')).toBe(false);
    expect(stateHomeOverlap('/work/shop-state', '/work/shop')).toBeUndefined();
    expect(stateHomeOverlap('/home/dev/.debuggen', '/work/shop')).toBeUndefined();
  });
});

describe('canonicalizePath', () => {
  it('resolves an existing directory through every link on the way', async () => {
    const sandbox = overlapSandbox();
    const real = directory(join(sandbox, 'real'));
    symlinkSync(real, join(sandbox, 'link'));

    expect(await canonicalizePath(`${sandbox}/link`)).toStrictEqual({ ok: true, value: real });
    expect(await canonicalizePath(`${sandbox}/link/./`)).toStrictEqual({ ok: true, value: real });
  });

  it('resolves a path that does not exist yet through its nearest existing ancestor', async () => {
    const sandbox = overlapSandbox();
    const real = directory(join(sandbox, 'real'));
    symlinkSync(real, join(sandbox, 'link'));

    const resolved = await canonicalizePath(`${sandbox}/link/not/there/yet`);

    expect(resolved).toStrictEqual({ ok: true, value: `${real}/not/there/yet` });
  });

  it('refuses a relative path and a resolution that fails for another reason than absence', async () => {
    expect(refusalOf(await canonicalizePath('relative/project')).details?.['reason']).toBe(
      PATH_UNRESOLVABLE_REASON,
    );

    const denied = Object.assign(new Error('EACCES: permission denied, realpath /x'), {
      code: 'EACCES',
    });
    const error = refusalOf(
      await canonicalizePath('/work/shop', { realpath: () => Promise.reject(denied) }),
    );
    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.details).toMatchObject({ reason: PATH_UNRESOLVABLE_REASON, errno: 'EACCES' });
    expect(surfacesOf(error)).not.toContain('/work/shop');
  });
});

describe('requireProjectOutsideStateHome', () => {
  it('refuses a project that contains the state root', async () => {
    const sandbox = overlapSandbox();
    const project = directory(join(sandbox, 'shop'));
    const home = directory(join(project, 'debuggen-state'));

    const error = refusalOf(await requireProjectOutsideStateHome(home, project));

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.message).toBe(STATE_HOME_OVERLAP_MESSAGE);
    expect(error.message).toContain('set DEBUGGEN_HOME to a directory outside the project');
    expect(error.hint).toBe(STATE_HOME_OVERLAP_HINT);
    expect(error.details).toMatchObject({
      reason: STATE_HOME_OVERLAP_REASON,
      relation: 'home-inside-project',
    });
    // Constant text: no surface of the refusal names either path.
    expect(surfacesOf(error)).not.toContain(sandbox);
  });

  it('refuses a project inside the state root, and the state root itself', async () => {
    const sandbox = overlapSandbox();
    const home = directory(join(sandbox, 'state'));
    const project = directory(join(home, 'shop'));

    expect(
      refusalOf(await requireProjectOutsideStateHome(home, project)).details?.['relation'],
    ).toBe('project-inside-home');
    expect(refusalOf(await requireProjectOutsideStateHome(home, home)).details?.['relation']).toBe(
      'same-directory',
    );
  });

  it('accepts a sibling that shares the project name as a prefix', async () => {
    const sandbox = overlapSandbox();
    const project = directory(join(sandbox, 'shop'));
    const home = directory(join(sandbox, 'shop-state'));

    expect(await requireProjectOutsideStateHome(home, project)).toStrictEqual({
      ok: true,
      value: project,
    });
  });

  it('refuses a project whose path resolves into the state root through a link', async () => {
    const sandbox = overlapSandbox();
    const home = directory(join(sandbox, 'state'));
    const inside = directory(join(home, 'checkouts', 'shop'));
    symlinkSync(inside, join(sandbox, 'shop'));

    const error = refusalOf(await requireProjectOutsideStateHome(home, `${sandbox}/shop`));

    expect(error.details).toMatchObject({
      reason: STATE_HOME_OVERLAP_REASON,
      relation: 'project-inside-home',
    });
  });

  it('refuses a linked project that contains the state root', async () => {
    const sandbox = overlapSandbox();
    const project = directory(join(sandbox, 'real-shop'));
    const home = directory(join(project, '.debuggen'));
    symlinkSync(project, join(sandbox, 'shop'));

    const error = refusalOf(await requireProjectOutsideStateHome(home, `${sandbox}/shop`));

    expect(error.details?.['relation']).toBe('home-inside-project');
  });

  it('judges a project root that does not exist by its nearest existing ancestor', async () => {
    const sandbox = overlapSandbox();
    const home = directory(join(sandbox, 'state'));

    // Apart: a folder about to be created beside the state root.
    expect(await requireProjectOutsideStateHome(home, `${sandbox}/new/shop`)).toStrictEqual({
      ok: true,
      value: `${sandbox}/new/shop`,
    });
    // Not apart: a folder that would be created inside it.
    expect(
      refusalOf(await requireProjectOutsideStateHome(home, `${home}/later/shop`)).details?.[
        'relation'
      ],
    ).toBe('project-inside-home');
  });

  it('fails closed on a project root it cannot resolve, naming no path', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied, realpath /work/shop'), {
      code: 'EACCES',
    });

    const error = refusalOf(
      await requireProjectOutsideStateHome('/home/dev/.debuggen', '/work/shop', {
        realpath: () => Promise.reject(denied),
      }),
    );

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.message).toBe(PROJECT_ROOT_UNRESOLVABLE_MESSAGE);
    expect(error.details).toMatchObject({
      reason: PROJECT_ROOT_UNRESOLVABLE_REASON,
      errno: 'EACCES',
    });
    expect(surfacesOf(error)).not.toContain('/work/shop');
  });

  it('never changes what loadServiceConfig resolves: the check is a separate, explicit read', () => {
    // The loader stays pure; overlap is judged only by the asynchronous check.
    const config = loadOk({ DEBUGGEN_HOME: '/work/shop/debuggen-state' });

    expect(config.debuggenHome).toBe('/work/shop/debuggen-state');
    expect(normalizePosix(config.databasePath)).toBe(
      `/work/shop/debuggen-state/${SESSIONS_DATABASE_FILE_NAME}`,
    );
  });
});
