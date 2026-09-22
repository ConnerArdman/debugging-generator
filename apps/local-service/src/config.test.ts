/**
 * Tests for `./config.ts`: the service's single environment reader, the
 * nine-key contract it enforces, the five `$DEBUGGEN_HOME` paths it derives and
 * the failure policy that keeps a credential out of every error it produces.
 *
 * Three different things are on trial here, and only the first is ordinary
 * parsing.
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

import { describe, expect, it } from 'vitest';

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
  PROMPTS_DIRECTORY_NAME,
  SERVICE_ENV_KEYS,
  SESSIONS_DATABASE_FILE_NAME,
  describeServiceConfig,
  loadServiceConfig,
  serviceConfigSchema,
  toModelProviderOverrides,
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
 * The nine keys the loader reads, in the order `.env.example` declares them.
 *
 * Deliberately a hand-written second copy of `SERVICE_ENV_KEYS`: see this
 * file's overview. The two lists disagreeing is the signal, and a generated
 * expectation could not produce it.
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

/** `DEBUGGEN_PROVIDER`, `DEBUGGEN_LOG_LEVEL` and `DEBUGGEN_HOST` values the loader must refuse. */
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
  {
    label: 'a host name containing whitespace',
    key: 'DEBUGGEN_HOST',
    value: 'left interface',
    reason: 'the value contains whitespace',
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
  ...PATH_REJECTIONS,
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
    expect(loadOk({ DEBUGGEN_PROVIDER: id }).provider).toBe(id);
  });

  it.each([...PROVIDER_IDS])(
    'accepts %s whatever its padding and letter case',
    (id: ProviderId) => {
      // The normalisation `@debuggen/model-provider` applies to the same
      // variable, so a hand-edited `.env` selects the provider it obviously means.
      expect(loadOk({ DEBUGGEN_PROVIDER: `  ${id.toUpperCase()}  ` }).provider).toBe(id);
    },
  );

  it.each([...LOG_LEVEL_SETTINGS])('accepts the log threshold %s', (level: LogLevelSetting) => {
    expect(loadOk({ DEBUGGEN_LOG_LEVEL: level }).logLevel).toBe(level);
    expect(loadOk({ DEBUGGEN_LOG_LEVEL: ` ${level.toUpperCase()} ` }).logLevel).toBe(level);
  });

  it('accepts a host name, an address literal and an interface it cannot vouch for', () => {
    // The module owns only the question "could this be a host name" - which
    // interfaces exist on the machine is the listener's to answer, and a
    // rejection here would refuse a legitimate address it had never heard of.
    expect(loadOk({ DEBUGGEN_HOST: 'localhost' }).host).toBe('localhost');
    expect(loadOk({ DEBUGGEN_HOST: '::1' }).host).toBe('::1');
    expect(loadOk({ DEBUGGEN_HOST: `  ${DEFAULT_HOST}  ` }).host).toBe(DEFAULT_HOST);
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
    expect(loadOk({ DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID }).provider).toBe(NETWORK_PROVIDER_ID);
    expect(loadOk({ DEBUGGEN_PORT: String(EPHEMERAL_PORT) }).port).toBe(EPHEMERAL_PORT);
    expect(loadOk({}).port).toBe(DEFAULT_PORT);
  });

  it('is deterministic: two identical calls produce deeply equal configurations', () => {
    // No clock, no randomness, no cached state: a session records the
    // configuration it started under, and a value that varied between reads
    // would make that record meaningless.
    const env: ServiceEnv = {
      DEBUGGEN_HOME: EXPLICIT_HOME,
      DEBUGGEN_PORT: '5000',
      DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID,
      DEBUGGEN_MODEL: CONFIGURED_MODEL_ID,
    };

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
    const config = loadOk({ DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID });

    expect(toModelProviderOverrides(config).providerId).toBe(NETWORK_PROVIDER_ID);
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
    const config = loadOk({
      DEBUGGEN_HOME: EXPLICIT_HOME,
      DEBUGGEN_PROMPTS_DIR: EXPLICIT_PROMPTS_DIR,
      DEBUGGEN_MODEL: CONFIGURED_MODEL_ID,
      DEBUGGEN_PROVIDER: NETWORK_PROVIDER_ID,
    });

    expect(describeServiceConfig(config)).toStrictEqual({
      subsystem: 'config',
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      logLevel: DEFAULT_LOG_LEVEL,
      retentionDays: DEFAULT_RETENTION_DAYS,
      provider: NETWORK_PROVIDER_ID,
      model: CONFIGURED_MODEL_ID,
      anthropicApiKeyPresent: false,
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
