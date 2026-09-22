/**
 * The single configuration surface of `@debuggen/local-service`.
 *
 * Every other module in this workspace receives its configuration by
 * injection from here, and **no module under `src/**` reads `process.env`**.
 * That is not a style preference: the service is started three different ways
 * — `tsx watch src/main.ts` in development, `node dist/main.js` from the
 * Playwright `webServer` entry, and the bundle `apps/vscode-extension` ships
 * inside its VSIX — and each of those starts sees a different environment. One
 * reader, one validation pass and one resolved object is what makes the three
 * behave identically, and what lets every suite drive the whole surface with a
 * plain object instead of mutating the process it runs in.
 *
 * ## The environment contract
 *
 * Exactly nine variables, the set the root `.env.example` documents (AAP
 * 0.3.4), each optional because each either has a default or is only needed on
 * one path:
 *
 * | Key | Shape | Default |
 * | --- | --- | --- |
 * | `ANTHROPIC_API_KEY` | non-empty string | none — only the network provider needs one |
 * | `DEBUGGEN_PROVIDER` | one of `PROVIDER_IDS` | `DEFAULT_PROVIDER_ID` (reaches no network) |
 * | `DEBUGGEN_MODEL` | non-empty string | **none, never defaulted** |
 * | `DEBUGGEN_HOST` | non-empty string without whitespace | {@link DEFAULT_HOST} |
 * | `DEBUGGEN_PORT` | integer `0`–{@link MAX_PORT} | {@link DEFAULT_PORT} |
 * | `DEBUGGEN_HOME` | absolute path, `~` accepted | {@link DEFAULT_DEBUGGEN_HOME} |
 * | `DEBUGGEN_LOG_LEVEL` | one of {@link LOG_LEVEL_SETTINGS} | {@link DEFAULT_LOG_LEVEL} |
 * | `DEBUGGEN_RETENTION_DAYS` | integer of `0` or more | {@link DEFAULT_RETENTION_DAYS} |
 * | `DEBUGGEN_PROMPTS_DIR` | absolute path | derived from this module's own location |
 *
 * An **empty or whitespace-only value counts as absent** for every one of
 * them, so the default applies. That rule is load-bearing rather than
 * cosmetic: `.env.example` ships `ANTHROPIC_API_KEY=` and `DEBUGGEN_MODEL=`
 * with no value, and the repository's Vitest projects export
 * `ANTHROPIC_API_KEY: ''` so that no suite can inherit a real credential. A
 * reader that treated `''` as a configured value would turn both of those into
 * a provider holding a zero-length credential.
 *
 * `DEBUGGEN_TOKEN`, `DEBUGGEN_INGEST_URL` and `DEBUGGEN_PROJECT_ROOT` are
 * deliberately **not** part of this contract. The dev-server launcher mints
 * them for the instrumented child process and the Node preload reads them
 * there; the service never does, and reading them here would suggest a
 * hand-set value could be valid when it never is.
 *
 * ## Derived paths, resolved once
 *
 * `$DEBUGGEN_HOME` is resolved in this module and nowhere else.
 * `@debuggen/shared/node`'s hardened filesystem helpers touch neither
 * `node:os` nor `process.env`, and `@debuggen/code-analysis`'s
 * `resolveIndexCacheDir` treats its argument as the authority, precisely
 * because this decision belongs to one place. The five paths every subsystem
 * needs — the state root, the session database, the backup root, the index
 * cache and the editor credential — are therefore computed here and read from
 * {@link ServiceConfig}, never recomputed:
 *
 * ```text
 * <debuggenHome>/                 0700, created by src/main.ts
 *   sessions.sqlite               the node:sqlite store
 *   auth.json                     0600, the editor credential
 *   backups/<sessionId>/<hash>    pre-patch file backups
 *   index/                        the code-index cache
 * ```
 *
 * Every path this module produces is normalised POSIX, which is the one
 * spelling the rest of the product speaks; `@debuggen/shared`'s pure-string
 * path helpers do the work, so nothing here touches a filesystem.
 *
 * ## No validation library, on purpose
 *
 * The keys are parsed by hand rather than by a schema library because this
 * workspace declares no `zod` dependency (AAP 0.3.2) — every schema it uses
 * arrives through the `@debuggen/*` package that owns it, and configuration is
 * owned by nobody else. {@link serviceConfigSchema} is the machine-readable
 * description of the contract, with {@link ServiceConfigSchema.safeParse} as
 * its parse entry point; it is a descriptor object, not a library schema, and
 * its documentation says so where a reader would otherwise assume.
 *
 * ## Failure and privacy policy
 *
 * Nothing here throws and nothing here exits. A bad environment yields **one**
 * `Err` holding a `DebuggenError` coded `CONFIG_INVALID` that aggregates every
 * problem found, so a developer fixes their `.env` once instead of once per
 * run; `src/main.ts` owns the decision to report and exit.
 *
 * A failure names the offending **key** and the reason it was rejected, and
 * **never the value**. `ANTHROPIC_API_KEY` is the reason the rule is absolute:
 * an error message is logged, may be persisted with a session and is rendered
 * in two user interfaces, so a credential echoed into one — even truncated —
 * has left the machine's memory for its disk. {@link describeServiceConfig}
 * exists so that the loggable view of a configuration is built in one place
 * that cannot forget this.
 */

import {
  DebuggenError,
  LOG_LEVELS,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  joinPosix,
  normalizePosix,
  ok,
  toPosix,
  tryCatch,
  unwrapOr,
  type DebuggenErrorCode,
  type LogFields,
  type LogLevelSetting,
  type Result,
} from '@debuggen/shared';
import {
  DEFAULT_PROVIDER_ID,
  PROVIDER_IDS,
  isProviderId,
  type ModelProviderConfig,
  type ProviderId,
} from '@debuggen/model-provider';

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/* -------------------------------------------------------------------------------------------------
 * The environment surface
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every environment variable this service reads, in the order a failure
 * reports them.
 *
 * Exported so the contract is assertable rather than described: the colocated
 * suite checks this tuple against the keys `.env.example` documents, and the
 * README's configuration section is checkable against the same source. A key
 * added here without a resolver, or resolved without being listed here, is
 * therefore a visible change rather than a quiet one.
 *
 * The order is the order of `.env.example` and the order
 * {@link loadServiceConfig} resolves in, which makes an aggregated failure
 * list its keys predictably instead of in whatever order the resolvers happen
 * to run.
 */
export const SERVICE_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'DEBUGGEN_PROVIDER',
  'DEBUGGEN_MODEL',
  'DEBUGGEN_HOST',
  'DEBUGGEN_PORT',
  'DEBUGGEN_HOME',
  'DEBUGGEN_LOG_LEVEL',
  'DEBUGGEN_RETENTION_DAYS',
  'DEBUGGEN_PROMPTS_DIR',
] as const;

/** One of the keys in {@link SERVICE_ENV_KEYS}. */
export type ServiceEnvKey = (typeof SERVICE_ENV_KEYS)[number];

/* -------------------------------------------------------------------------------------------------
 * Defaults
 * ---------------------------------------------------------------------------------------------- */

/**
 * The interface the service binds to when nothing names one: loopback.
 *
 * Loopback is the product's access boundary (AAP 0.5.6). It keeps other
 * machines out — the authentication, role and Origin rules in
 * `src/server/auth.ts` keep other local processes and web pages out — so a
 * default of `0.0.0.0` would quietly widen a boundary the rest of the service
 * is built to hold.
 */
export const DEFAULT_HOST = '127.0.0.1';

/** The port serving both the HTTP routes and the WebSocket endpoint. */
export const DEFAULT_PORT = 43_117;

/**
 * The port value that asks the operating system for an ephemeral port.
 *
 * Accepted rather than rejected, because the integration suites of AAP 0.8.3
 * boot a real service per file and cannot share a fixed port: they pass `0`
 * and read the bound port back from the listener. A developer who sets it by
 * hand gets the same behaviour, which is why it is documented here instead of
 * being a test-only allowance.
 */
export const EPHEMERAL_PORT = 0;

/** The highest TCP port number, and the upper bound `DEBUGGEN_PORT` accepts. */
export const MAX_PORT = 65_535;

/**
 * Where session state lives when nothing names a directory.
 *
 * A `~`-prefixed value on purpose: it is what `.env.example` ships, it is what
 * a developer recognises, and {@link loadServiceConfig} expands it against an
 * injectable home directory so that no suite depends on the real one. The
 * directory is deliberately outside every checkout, so a session never shows
 * up in a developer's `git status`.
 */
export const DEFAULT_DEBUGGEN_HOME = '~/.debuggen';

/** The log threshold when `DEBUGGEN_LOG_LEVEL` names none. */
export const DEFAULT_LOG_LEVEL = 'info' satisfies LogLevelSetting;

/**
 * Every accepted `DEBUGGEN_LOG_LEVEL` value: the six severities plus
 * `'silent'`.
 *
 * Derived from `@debuggen/shared`'s `LOG_LEVELS` rather than restated, so the
 * vocabulary has exactly one definition; `'silent'` is the setting-only member
 * that turns the service quiet without any call site knowing about it, which
 * is why it exists in `LogLevelSetting` and not in `LogLevel`.
 */
export const LOG_LEVEL_SETTINGS: readonly LogLevelSetting[] = Object.freeze([
  ...LOG_LEVELS,
  'silent',
]);

/**
 * The retention window in days for sessions, telemetry, panels, analyses and
 * their backups.
 *
 * `0` is accepted and means *purge everything eligible on the next sweep*:
 * `src/store/retention.ts` deletes records older than this many days, so a
 * window of zero leaves nothing behind. It is a legitimate setting for a
 * developer who wants no history kept, which is why the lower bound is zero
 * rather than one.
 */
export const DEFAULT_RETENTION_DAYS = 30;

/* -------------------------------------------------------------------------------------------------
 * The layout of $DEBUGGEN_HOME
 * ---------------------------------------------------------------------------------------------- */

/** The `node:sqlite` session store, inside the state root. */
export const SESSIONS_DATABASE_FILE_NAME = 'sessions.sqlite';

/** The root of the pre-patch file backups, one directory per session. */
export const BACKUPS_DIRECTORY_NAME = 'backups';

/**
 * The code-index cache directory.
 *
 * Must agree with `@debuggen/code-analysis`'s `resolveIndexCacheDir`, which
 * joins the same name onto the state root: `src/store/retention.ts` purges
 * this directory, and a disagreement would leave the real cache growing while
 * an empty path was swept.
 */
export const INDEX_CACHE_DIRECTORY_NAME = 'index';

/** The editor credential file, written `0600` by the service on first start. */
export const AUTH_FILE_NAME = 'auth.json';

/** The versioned prompt directory, beside the service's own module tree. */
export const PROMPTS_DIRECTORY_NAME = 'prompts';

/* -------------------------------------------------------------------------------------------------
 * The resolved configuration
 * ---------------------------------------------------------------------------------------------- */

/**
 * The configuration every subsystem of the service is handed.
 *
 * Deeply readonly — every member is a primitive — so a subsystem cannot retune
 * shared configuration by assigning to it, and a value read at start-up is the
 * value in force at the end of the session.
 *
 * `model` and `anthropicApiKey` are **absent rather than `undefined`** when
 * nothing configured them: the repository compiles with
 * `exactOptionalPropertyTypes`, so the distinction survives into the type, and
 * a consumer may read it with `'model' in config` semantics.
 */
export interface ServiceConfig {
  /** The interface to bind, from `DEBUGGEN_HOST` or {@link DEFAULT_HOST}. */
  readonly host: string;

  /**
   * The port to bind, from `DEBUGGEN_PORT` or {@link DEFAULT_PORT}.
   * {@link EPHEMERAL_PORT} asks the operating system to choose.
   */
  readonly port: number;

  /** The log threshold, from `DEBUGGEN_LOG_LEVEL` or {@link DEFAULT_LOG_LEVEL}. */
  readonly logLevel: LogLevelSetting;

  /**
   * The retention window in days, from `DEBUGGEN_RETENTION_DAYS` or
   * {@link DEFAULT_RETENTION_DAYS}. Never negative; `0` purges everything
   * eligible.
   */
  readonly retentionDays: number;

  /**
   * The selected model provider, validated against `PROVIDER_IDS`.
   *
   * Whether that selection is *usable* is not decided here — a network
   * provider also needs a model and a credential, and
   * `@debuggen/model-provider` owns that rule. This field only records what
   * was asked for. See {@link toModelProviderOverrides}.
   */
  readonly provider: ProviderId;

  /**
   * The model id from `DEBUGGEN_MODEL`, absent when unset.
   *
   * Never defaulted, anywhere: a session records the model it used, and a
   * substituted default would make that record untrue. No literal naming a
   * model appears in this file.
   */
  readonly model?: string;

  /**
   * The credential from `ANTHROPIC_API_KEY`, absent when unset.
   *
   * Carried, never logged, never placed in an error, never written to a
   * session record. {@link describeServiceConfig} reports only whether one is
   * present.
   */
  readonly anthropicApiKey?: string;

  /**
   * The resolved state root: absolute, normalised POSIX, `~` already expanded.
   * `src/main.ts` creates it `0700`.
   */
  readonly debuggenHome: string;

  /** `<debuggenHome>/sessions.sqlite`, opened by `src/store/db.ts`. */
  readonly databasePath: string;

  /** `<debuggenHome>/backups`, the parent of every per-session backup directory. */
  readonly backupsDir: string;

  /** `<debuggenHome>/index`, the code-index cache the retention sweep purges. */
  readonly indexCacheDir: string;

  /** `<debuggenHome>/auth.json`, the editor credential written `0600`. */
  readonly authFilePath: string;

  /**
   * The versioned prompt directory the prompt loader reads, absolute and
   * normalised POSIX. Resolved from an override, then
   * `DEBUGGEN_PROMPTS_DIR`, then this module's own location.
   */
  readonly promptsDir: string;
}

/**
 * Values a host decides for itself, which win over the environment per
 * setting.
 *
 * This is how the integration suites pin a temporary state root and an
 * ephemeral port without touching the process environment, and how
 * `src/main.ts` passes a command-line flag through. Every member is optional
 * and accepts an explicit `undefined`, so a caller may spread a partially
 * filled record without first stripping its empty members. A blank string is
 * treated as absent, exactly as a blank variable is.
 */
export interface ServiceConfigOverrides {
  /**
   * The home directory a leading `~` expands against. Defaults to
   * `os.homedir()`.
   *
   * Injectable so that no test depends on — or writes anywhere near — the real
   * home directory of the account running it.
   */
  readonly homeDir?: string | undefined;

  /** The state root, winning over `DEBUGGEN_HOME`. `~` is expanded here too. */
  readonly debuggenHome?: string | undefined;

  /** The prompt directory, winning over `DEBUGGEN_PROMPTS_DIR`. */
  readonly promptsDir?: string | undefined;

  /** The interface to bind, winning over `DEBUGGEN_HOST`. */
  readonly host?: string | undefined;

  /**
   * The port to bind, winning over `DEBUGGEN_PORT`. Validated like the
   * variable: an integer from {@link EPHEMERAL_PORT} to {@link MAX_PORT}.
   */
  readonly port?: number | undefined;

  /** The log threshold, winning over `DEBUGGEN_LOG_LEVEL`. */
  readonly logLevel?: LogLevelSetting | undefined;

  /** The retention window in days, winning over `DEBUGGEN_RETENTION_DAYS`. */
  readonly retentionDays?: number | undefined;

  /**
   * The provider selection, winning over `DEBUGGEN_PROVIDER`.
   *
   * Typed as `string` rather than `ProviderId` because it routinely arrives
   * from outside the type system — a VS Code setting, a command-line flag —
   * and is validated here against `PROVIDER_IDS` after the same trimming and
   * lower-casing `@debuggen/model-provider` applies.
   */
  readonly provider?: string | undefined;

  /** The model id, winning over `DEBUGGEN_MODEL`. Never defaulted. */
  readonly model?: string | undefined;

  /** The credential, winning over `ANTHROPIC_API_KEY`. Never logged. */
  readonly anthropicApiKey?: string | undefined;
}

/**
 * One rejected setting: the key, why it was rejected and what to do about it.
 *
 * `reason` and `hint` are assembled from the key name, the accepted vocabulary
 * and the accepted range only. **Neither may contain the value**, which is the
 * rule that keeps a credential out of a log line; see this module's overview.
 */
export interface ServiceConfigIssue {
  /** The environment key whose value was rejected. */
  readonly key: ServiceEnvKey;

  /** Why it was rejected, as a lower-case clause naming no value. */
  readonly reason: string;

  /** The developer's next step, naming the key and the accepted values. */
  readonly hint: string;
}

/* -------------------------------------------------------------------------------------------------
 * The machine-readable contract
 * ---------------------------------------------------------------------------------------------- */

/** How a key's value is interpreted, for documentation and for tooling. */
export type ServiceEnvKeyKind = 'credential' | 'enum' | 'integer' | 'path' | 'string';

/** What {@link serviceConfigSchema} records about one environment key. */
export interface ServiceEnvKeyDescriptor {
  /** The variable name, as it appears in the environment. */
  readonly key: ServiceEnvKey;

  /** How the raw string is interpreted. */
  readonly kind: ServiceEnvKeyKind;

  /**
   * Whether the value is a credential.
   *
   * The one flag with teeth: {@link describeServiceConfig} reports presence
   * instead of content for a secret key, and no failure ever quotes one.
   */
  readonly secret: boolean;

  /**
   * The value applied when the key is absent or blank, when there is one.
   *
   * Absent for `ANTHROPIC_API_KEY` and `DEBUGGEN_MODEL`, which are never
   * defaulted, and for `DEBUGGEN_PROMPTS_DIR`, whose default is derived at
   * call time from this module's own location rather than written down.
   */
  readonly defaultValue?: string | number | undefined;

  /** The closed vocabulary, for an `'enum'` key. */
  readonly allowedValues?: readonly string[] | undefined;

  /** One sentence describing what the key controls. */
  readonly description: string;
}

/**
 * The description of the environment contract, plus its parse entry point.
 *
 * **Not a validation-library schema.** This workspace declares no `zod`
 * dependency (AAP 0.3.2), so the contract is described by data and enforced by
 * {@link loadServiceConfig}; {@link ServiceConfigSchema.safeParse} is the same
 * function under the name a reader expects to find on a schema, and it returns
 * a `Result` rather than throwing, like everything else here.
 */
export interface ServiceConfigSchema {
  /** The keys, in the order a failure reports them. */
  readonly keys: readonly ServiceEnvKey[];

  /** One descriptor per key. */
  readonly entries: Readonly<Record<ServiceEnvKey, ServiceEnvKeyDescriptor>>;

  /** {@link loadServiceConfig}, reachable through the schema object. */
  readonly safeParse: (
    env: Readonly<Record<string, string | undefined>>,
    overrides?: ServiceConfigOverrides,
  ) => Result<ServiceConfig, DebuggenError>;
}

/* -------------------------------------------------------------------------------------------------
 * Internal constants
 * ---------------------------------------------------------------------------------------------- */

/** The subsystem name every failure's `details` carries, so one filter finds them all. */
const SUBSYSTEM = 'config';

/**
 * The code every failure from this module carries.
 *
 * `CONFIG_INVALID` from the closed `DEBUGGEN_ERROR_CODES` tuple: a process
 * that cannot make sense of its own configuration has not started, which is a
 * different condition from every runtime failure the service reports later,
 * and it is the code `src/main.ts` branches on to exit rather than retry.
 */
const CONFIG_CODE = 'CONFIG_INVALID' satisfies DebuggenErrorCode;

/**
 * The code for the branch that cannot be taken.
 *
 * {@link loadServiceConfig} collects every rejected setting before it assembles
 * anything, so the assembly step runs only on validated values. The one
 * remaining way to reach a failure there is a defect in this module, and
 * `INTERNAL` is the honest code for that — see
 * {@link resolveDefaultPromptsDirectory}, the only place it is used.
 */
const INTERNAL_CODE = 'INTERNAL' satisfies DebuggenErrorCode;

/** A `DEBUGGEN_HOME` or prompts value of exactly `~`. */
const HOME_MARKER = '~';

/** The prefix that expands to the home directory. */
const HOME_PREFIX = '~/';

/** The two-separator prefix a UNC path carries once separators are normalised. */
const UNC_PREFIX = '//';

/** An optionally signed run of decimal digits, and nothing else. */
const INTEGER_PATTERN = /^[+-]?\d+$/;

/** Any whitespace character, which a host name may not contain. */
const WHITESPACE_PATTERN = /\s/;

/** A Windows path rooted at a drive, for instance `C:/Users/dev`. */
const WINDOWS_ROOTED_PATTERN = /^[A-Za-z]:\//;

/* -------------------------------------------------------------------------------------------------
 * Remediation text
 * ---------------------------------------------------------------------------------------------- */

/**
 * The next step for a provider selection this service does not recognise.
 *
 * The accepted values are joined from `PROVIDER_IDS` at call time, so a
 * provider added to that tuple updates this sentence with nothing to edit
 * here, and the offline default is named from `DEFAULT_PROVIDER_ID` rather
 * than written out — the two defaults are the same value by construction.
 */
function unrecognisedProviderHint(): string {
  return (
    `Set DEBUGGEN_PROVIDER to one of: ${PROVIDER_IDS.join(', ')}. ` +
    'Surrounding whitespace and letter case are accepted, so neither is ever the cause of this ' +
    `failure. Leave it unset to run behind '${DEFAULT_PROVIDER_ID}', which reaches no network.`
  );
}

/** The next step for a log threshold outside the accepted vocabulary. */
function unrecognisedLogLevelHint(): string {
  return (
    `Set DEBUGGEN_LOG_LEVEL to one of: ${LOG_LEVEL_SETTINGS.join(', ')}. ` +
    `Leave it unset for '${DEFAULT_LOG_LEVEL}'.`
  );
}

/** The next step for a host name the service cannot bind. */
const HOST_HINT =
  `Set DEBUGGEN_HOST to a single interface to bind, without whitespace. Leave it unset for ` +
  `'${DEFAULT_HOST}', which is the loopback interface the access boundary assumes.`;

/** The next step for a port value outside the accepted range. */
const PORT_HINT =
  `Set DEBUGGEN_PORT to a whole number from ${EPHEMERAL_PORT} to ${MAX_PORT}. Leave it unset for ` +
  `${DEFAULT_PORT}, or use ${EPHEMERAL_PORT} to let the operating system choose a free port.`;

/** The next step for a retention window that is not a whole number of days. */
const RETENTION_HINT =
  'Set DEBUGGEN_RETENTION_DAYS to a whole number of days, 0 or more. Leave it unset for ' +
  `${DEFAULT_RETENTION_DAYS}; 0 purges every record the next sweep finds eligible.`;

/** The next step for a state root that is not an absolute path. */
const HOME_HINT =
  `Set DEBUGGEN_HOME to an absolute directory path, or to a path starting with '${HOME_PREFIX}' ` +
  `to place it inside your home directory. Leave it unset for '${DEFAULT_DEBUGGEN_HOME}'. It must ` +
  'be outside every checkout, so that a session never appears in a working tree.';

/** The next step for a prompt directory that cannot be used. */
const PROMPTS_HINT =
  'Set DEBUGGEN_PROMPTS_DIR to the absolute path of the versioned prompt directory, or leave it ' +
  'unset to use the one shipped beside the service. The editor extension sets it for the service ' +
  'it bundles; it is not a value to set by hand otherwise.';

/* -------------------------------------------------------------------------------------------------
 * Failure construction
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds one issue.
 *
 * @param key The environment key that was rejected.
 * @param reason Why, as a clause naming no value.
 * @param hint The developer's next step.
 * @returns The issue, for collection by {@link loadServiceConfig}.
 */
function issue(key: ServiceEnvKey, reason: string, hint: string): ServiceConfigIssue {
  return { key, reason, hint };
}

/**
 * Aggregates every rejected setting into the one error a caller receives.
 *
 * One error rather than one per key, because a developer editing a `.env` file
 * wants the whole list: reporting the first problem and stopping turns four
 * mistakes into four start-up attempts. The message lists `key (reason)` pairs
 * in {@link SERVICE_ENV_KEYS} order, the hint concatenates the distinct next
 * steps, and `details` carries the keys and reasons in machine-readable form
 * for the log — never a value, per this module's overview.
 *
 * @param issues The rejected settings, in report order. Must not be empty.
 * @returns The `CONFIG_INVALID` error to return inside an `Err`.
 */
function configError(issues: readonly ServiceConfigIssue[]): DebuggenError {
  const summary = issues.map((entry) => `${entry.key} (${entry.reason})`).join('; ');
  const hints = [...new Set(issues.map((entry) => entry.hint))].join(' ');

  return new DebuggenError(CONFIG_CODE, `The local service configuration is invalid: ${summary}.`, {
    hint: hints,
    details: {
      subsystem: SUBSYSTEM,
      keys: issues.map((entry) => entry.key),
      issues: issues.map((entry) => ({ key: entry.key, reason: entry.reason })),
    },
  });
}

/* -------------------------------------------------------------------------------------------------
 * Reading raw settings
 * ---------------------------------------------------------------------------------------------- */

/**
 * Trims a setting and reports a blank one as absent.
 *
 * The single place the empty-is-absent rule of this module's overview is
 * implemented, applied identically to an environment variable and to an
 * override so that neither can behave differently from the other.
 *
 * @param value The raw value, or `undefined`.
 * @returns The trimmed value, or `undefined` when there was nothing in it.
 */
function normaliseSetting(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Reads one key from the injected environment.
 *
 * @param env The environment record `src/main.ts` passes in.
 * @param key The key to read.
 * @returns The trimmed value, or `undefined` when unset or blank.
 */
function readSetting(
  env: Readonly<Record<string, string | undefined>>,
  key: ServiceEnvKey,
): string | undefined {
  return normaliseSetting(env[key]);
}

/**
 * Parses a whole number, rejecting everything that is not exactly one.
 *
 * Deliberately stricter than `Number.parseInt`, which would read `'80abc'` as
 * `80` and `'0x10'` as `0`: a port or a retention window that was mistyped
 * must be reported, not silently truncated to whatever prefix happened to
 * parse. `'1e3'`, `'80.5'` and `' '` are rejected for the same reason, and a
 * magnitude beyond the safe-integer range is rejected rather than rounded.
 *
 * @param raw A trimmed, non-empty string.
 * @returns The integer, or `undefined` when the string is not one.
 */
function parseIntegerSetting(raw: string): number | undefined {
  if (!INTEGER_PATTERN.test(raw)) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Everything {@link resolveIntegerSetting} needs to validate and report one key. */
interface IntegerSettingSpec {
  /** The key being resolved. */
  readonly key: ServiceEnvKey;

  /** The lowest accepted value, inclusive. */
  readonly min: number;

  /** The highest accepted value, inclusive. */
  readonly max: number;

  /** The value applied when nothing configured the key. */
  readonly fallback: number;

  /** The developer's next step, shared by every failure of this key. */
  readonly hint: string;
}

/** `DEBUGGEN_PORT`: a bindable port, or {@link EPHEMERAL_PORT} to let the system choose. */
const PORT_SPEC: IntegerSettingSpec = {
  key: 'DEBUGGEN_PORT',
  min: EPHEMERAL_PORT,
  max: MAX_PORT,
  fallback: DEFAULT_PORT,
  hint: PORT_HINT,
};

/** `DEBUGGEN_RETENTION_DAYS`: a whole number of days, `0` meaning purge everything eligible. */
const RETENTION_SPEC: IntegerSettingSpec = {
  key: 'DEBUGGEN_RETENTION_DAYS',
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  fallback: DEFAULT_RETENTION_DAYS,
  hint: RETENTION_HINT,
};

/**
 * Resolves an integer setting from its override, then its variable, then its
 * default.
 *
 * An override is validated exactly as a variable is. It arrives from code
 * rather than from a shell, but that code is a VS Code setting, a command-line
 * flag or a test helper, so a non-integer or out-of-range value is just as
 * reachable — and a service that bound port `-1` because a caller was trusted
 * would fail far from its cause.
 *
 * @param raw The trimmed variable value, or `undefined`.
 * @param override The host-supplied value, or `undefined`.
 * @param spec The key's bounds, default and hint.
 * @returns The resolved integer, or the issue describing why neither value was
 * usable.
 */
function resolveIntegerSetting(
  raw: string | undefined,
  override: number | undefined,
  spec: IntegerSettingSpec,
): Result<number, ServiceConfigIssue> {
  const range = `outside the accepted range ${spec.min} to ${spec.max}`;

  if (override !== undefined) {
    if (!Number.isSafeInteger(override)) {
      return err(issue(spec.key, 'the injected override is not a whole number', spec.hint));
    }
    if (override < spec.min || override > spec.max) {
      return err(issue(spec.key, `the injected override is ${range}`, spec.hint));
    }
    return ok(override);
  }

  if (raw === undefined) {
    return ok(spec.fallback);
  }

  const parsed = parseIntegerSetting(raw);
  if (parsed === undefined) {
    return err(issue(spec.key, 'the value is not a whole number', spec.hint));
  }
  if (parsed < spec.min || parsed > spec.max) {
    return err(issue(spec.key, `the value is ${range}`, spec.hint));
  }
  return ok(parsed);
}

/* -------------------------------------------------------------------------------------------------
 * Resolving the non-path settings
 * ---------------------------------------------------------------------------------------------- */

/**
 * Resolves the provider selection.
 *
 * Trimmed and lower-cased before it is asked about, which is the normalisation
 * `@debuggen/model-provider` applies to the same variable: a hand-edited
 * `.env` carrying padding or a capital letter selects the provider it
 * obviously means, and a value that is still not a member is genuinely
 * unrecognised. The default is imported rather than restated, so the two
 * boundaries cannot drift.
 *
 * @param raw The trimmed `DEBUGGEN_PROVIDER` value, or `undefined`.
 * @param override The host-supplied selection, or `undefined`.
 * @returns The validated id, or the issue listing the accepted ids.
 */
function resolveProvider(
  raw: string | undefined,
  override: string | undefined,
): Result<ProviderId, ServiceConfigIssue> {
  const selected = normaliseSetting(override) ?? raw;
  if (selected === undefined) {
    return ok(DEFAULT_PROVIDER_ID);
  }

  const candidate = selected.toLowerCase();
  if (isProviderId(candidate)) {
    return ok(candidate);
  }
  return err(
    issue(
      'DEBUGGEN_PROVIDER',
      'the value names no provider this build offers',
      unrecognisedProviderHint(),
    ),
  );
}

/**
 * Whether a string is one of the accepted log thresholds.
 *
 * A guard rather than a comparison, because `LOG_LEVEL_VALUES` is a total
 * record over the closed union: an unvalidated string reaching it would
 * compare against `undefined` and silently disable logging, which is exactly
 * the failure `@debuggen/shared`'s logger documentation asks this module to
 * prevent.
 *
 * @param value Any string.
 * @returns `true` when `value` is a `LogLevelSetting`.
 */
function isLogLevelSetting(value: string): value is LogLevelSetting {
  return LOG_LEVEL_SETTINGS.some((candidate) => candidate === value);
}

/**
 * Resolves the log threshold, lower-casing the way the severities are spelled.
 *
 * The override is validated too, despite its type: the service is also started
 * from JavaScript — the bundle inside the editor extension — where the type
 * guarantees nothing.
 *
 * @param raw The trimmed `DEBUGGEN_LOG_LEVEL` value, or `undefined`.
 * @param override The host-supplied threshold, or `undefined`.
 * @returns The validated threshold, or the issue listing the accepted values.
 */
function resolveLogLevel(
  raw: string | undefined,
  override: LogLevelSetting | undefined,
): Result<LogLevelSetting, ServiceConfigIssue> {
  const selected = normaliseSetting(override) ?? raw;
  if (selected === undefined) {
    return ok(DEFAULT_LOG_LEVEL);
  }

  const candidate = selected.toLowerCase();
  if (isLogLevelSetting(candidate)) {
    return ok(candidate);
  }
  return err(
    issue('DEBUGGEN_LOG_LEVEL', 'the value names no known log level', unrecognisedLogLevelHint()),
  );
}

/**
 * Resolves the interface to bind.
 *
 * The only rejection is embedded whitespace, which is never a host name and
 * would otherwise surface as a listener failure several steps later. Anything
 * else — a loopback literal, a host name, an IPv6 address — is passed through
 * for the listener to accept or refuse, because this module does not own the
 * question of which interfaces exist on the machine.
 *
 * @param raw The trimmed `DEBUGGEN_HOST` value, or `undefined`.
 * @param override The host-supplied interface, or `undefined`.
 * @returns The interface, or the issue describing why the value cannot be one.
 */
function resolveHost(
  raw: string | undefined,
  override: string | undefined,
): Result<string, ServiceConfigIssue> {
  const selected = normaliseSetting(override) ?? raw;
  if (selected === undefined) {
    return ok(DEFAULT_HOST);
  }
  if (WHITESPACE_PATTERN.test(selected)) {
    return err(issue('DEBUGGEN_HOST', 'the value contains whitespace', HOST_HINT));
  }
  return ok(selected);
}

/* -------------------------------------------------------------------------------------------------
 * Resolving the path settings
 * ---------------------------------------------------------------------------------------------- */

/**
 * Why a path cannot be used as a directory root, or `undefined` when it can.
 *
 * Checked **before** normalisation, because normalisation is lossy in exactly
 * the case that matters: `normalizePosix` collapses the two leading separators
 * of a UNC path to one, turning `//server/share` into a local `/server/share`
 * that names something entirely different. `@debuggen/shared`'s own
 * `Result`-returning path gate refuses that prefix for the same reason, and
 * this module refuses it rather than silently rewriting a developer's setting.
 *
 * A drive-rooted Windows path (`C:/Users/dev`) is accepted and reported
 * separately from the drive-*relative* form (`C:dev`), which `isWindowsAbsolute`
 * also recognises but which is not absolute — it means "the current directory
 * on drive C", and there is no current directory here to resolve it against.
 *
 * @param value A path with forward slashes, before normalisation.
 * @returns The reason clause for an issue, or `undefined` when the path is a
 * usable absolute root.
 */
function describePathProblem(value: string): string | undefined {
  if (value.includes('\0')) {
    return 'the value contains a NUL character';
  }
  if (value.startsWith(UNC_PREFIX)) {
    return 'a UNC path is not supported as a directory root';
  }
  if (isAbsolutePosix(value) || WINDOWS_ROOTED_PATTERN.test(value)) {
    return undefined;
  }
  if (isWindowsAbsolute(value)) {
    return 'a drive-relative Windows path is not absolute';
  }
  return 'the value is not an absolute path';
}

/**
 * The home directory a leading `~` expands against, or `undefined` when this
 * process cannot determine one.
 *
 * Injectable first, `os.homedir()` second. The injection is what every suite
 * uses — a temporary directory — so nothing a test does can reach, or write
 * near, the real home directory of the account running it. `os.homedir()` is
 * called through `tryCatch` because it consults the password database on some
 * systems and can fail there; a failure becomes "indeterminable", which the
 * caller reports against the key that needed it rather than throwing out of a
 * configuration read.
 *
 * The result is normalised POSIX and validated as an absolute root, so an
 * environment with an empty or relative home directory cannot produce a state
 * root somewhere relative to the working directory.
 *
 * @param override The host-supplied home directory, or `undefined`.
 * @returns The absolute, normalised home directory, or `undefined`.
 */
function resolveHomeDirectory(override: string | undefined): string | undefined {
  const injected = normaliseSetting(override);
  const raw =
    injected ??
    unwrapOr(
      tryCatch(() => homedir(), CONFIG_CODE),
      '',
    );
  const candidate = normaliseSetting(toPosix(raw));
  if (candidate === undefined || describePathProblem(candidate) !== undefined) {
    return undefined;
  }
  return normalizePosix(candidate);
}

/**
 * Expands a leading `~` and validates the result as an absolute directory
 * root.
 *
 * Applied identically to `DEBUGGEN_HOME` and `DEBUGGEN_PROMPTS_DIR`: both
 * routinely arrive from a shell profile or a settings file, where a `~` is
 * ordinary and where nothing else will expand it — no filesystem call does,
 * and neither does `path.resolve`.
 *
 * Three forms are recognised, and the third is a refusal rather than a guess:
 *
 * | Value | Result |
 * | --- | --- |
 * | `~` | the home directory |
 * | `~/x`, and `~\x` once separators are normalised | `<home>/x` |
 * | `~other/x` | rejected — resolving another account's home is not this tool's business |
 *
 * @param key The key being resolved, for the issue.
 * @param selected The trimmed value, before separator conversion.
 * @param homeDir The home directory from {@link resolveHomeDirectory}, or
 * `undefined` when none could be determined.
 * @param hint The developer's next step for this key.
 * @returns The absolute, normalised POSIX path, or the issue.
 */
function resolveDirectorySetting(
  key: ServiceEnvKey,
  selected: string,
  homeDir: string | undefined,
  hint: string,
): Result<string, ServiceConfigIssue> {
  const posix = toPosix(selected);
  let candidate = posix;

  if (posix === HOME_MARKER || posix.startsWith(HOME_PREFIX)) {
    if (homeDir === undefined) {
      return err(
        issue(
          key,
          'the value starts with a home-directory prefix and no home directory could be determined',
          hint,
        ),
      );
    }
    candidate =
      posix === HOME_MARKER ? homeDir : joinPosix(homeDir, posix.slice(HOME_PREFIX.length));
  } else if (posix.startsWith(HOME_MARKER)) {
    return err(issue(key, 'a home-directory prefix naming another account is not supported', hint));
  }

  const problem = describePathProblem(candidate);
  if (problem !== undefined) {
    return err(issue(key, problem, hint));
  }
  return ok(normalizePosix(candidate));
}

/**
 * The prompt directory shipped beside the service, derived from this module's
 * own location.
 *
 * `new URL('../prompts', import.meta.url)` is correct in **both** run modes,
 * and the reason is worth stating so that a future reader does not "fix" the
 * single `..` hop: `src/` and `dist/` each sit exactly one level below this
 * workspace's root, and `prompts/` sits at that root.
 *
 * - `tsx watch src/main.ts` — this module's URL is `src/config.ts`, so one hop
 *   up lands on the workspace root and the directory is `prompts/`.
 * - `node dist/main.js` — tsup bundles this module **into** `dist/main.js`, so
 *   `import.meta.url` is that file's URL, one level below the root again.
 *
 * The packaged editor extension is the third layout, and it does not rely on
 * this at all: it copies the prompt files next to its own bundle and sets
 * `DEBUGGEN_PROMPTS_DIR`, which takes precedence. `__dirname` is unavailable
 * here (this is ESM) and `process.cwd()` would be wrong in every mode, since
 * the service is started from the repository root by the Playwright
 * `webServer` entry and from the editor's working directory by the extension.
 *
 * Wrapped in `tryCatch` because `import.meta.url` is not guaranteed to be a
 * `file:` URL in every bundler's output: rather than throwing out of a
 * configuration read, an unusable module URL becomes an issue whose hint names
 * the variable that overrides it.
 *
 * @returns The absolute, normalised POSIX directory, or the issue.
 */
function resolveDefaultPromptsDirectory(): Result<string, ServiceConfigIssue> {
  const derived = tryCatch(
    () => fileURLToPath(new URL(`../${PROMPTS_DIRECTORY_NAME}`, import.meta.url)),
    INTERNAL_CODE,
  );
  if (isErr(derived)) {
    return err(
      issue(
        'DEBUGGEN_PROMPTS_DIR',
        "the default directory could not be derived from the service module's own location",
        PROMPTS_HINT,
      ),
    );
  }

  const candidate = toPosix(derived.value);
  const problem = describePathProblem(candidate);
  if (problem !== undefined) {
    return err(
      issue(
        'DEBUGGEN_PROMPTS_DIR',
        `the derived default directory is invalid: ${problem}`,
        PROMPTS_HINT,
      ),
    );
  }
  return ok(normalizePosix(candidate));
}

/**
 * Resolves the prompt directory through the three-step precedence the prompt
 * loader documents: an explicit override, then `DEBUGGEN_PROMPTS_DIR`, then
 * the directory shipped beside the service.
 *
 * @param raw The trimmed `DEBUGGEN_PROMPTS_DIR` value, or `undefined`.
 * @param override The host-supplied directory, or `undefined`.
 * @param homeDir The home directory a leading `~` expands against.
 * @returns The absolute, normalised POSIX directory, or the issue.
 */
function resolvePromptsDirectory(
  raw: string | undefined,
  override: string | undefined,
  homeDir: string | undefined,
): Result<string, ServiceConfigIssue> {
  const selected = normaliseSetting(override) ?? raw;
  if (selected === undefined) {
    return resolveDefaultPromptsDirectory();
  }
  return resolveDirectorySetting('DEBUGGEN_PROMPTS_DIR', selected, homeDir, PROMPTS_HINT);
}

/* -------------------------------------------------------------------------------------------------
 * Loading
 * ---------------------------------------------------------------------------------------------- */

/**
 * Records a failure and keeps the type concrete for the assembly step.
 *
 * {@link loadServiceConfig} validates every setting before it assembles
 * anything, so it needs each resolver's value *and* each resolver's failure —
 * the failures to report together, the values to build from. This helper gives
 * it both without a cast and without an unreachable branch: a failure is
 * pushed onto the list and the key's own default stands in, and because a
 * non-empty list returns before assembly, **a substituted default is never
 * observed**.
 *
 * @typeParam T The setting's resolved type.
 * @param result The resolver's answer.
 * @param fallback The stand-in for a failed resolution; never observed.
 * @param issues The collector, in {@link SERVICE_ENV_KEYS} order.
 * @returns The resolved value, or `fallback` when the resolver failed.
 */
function settle<T>(
  result: Result<T, ServiceConfigIssue>,
  fallback: T,
  issues: ServiceConfigIssue[],
): T {
  if (isErr(result)) {
    issues.push(result.error);
    return fallback;
  }
  return result.value;
}

/**
 * Reads, validates and resolves the whole configuration surface.
 *
 * The one entry point of this module. `env` is **required and injected**:
 * nothing here reads `process.env`, so `src/main.ts` passes it in after
 * `dotenv` has populated it, a suite passes a literal, and the two paths are
 * the same code. Precedence is per setting, not per object — a host that
 * overrides only the port still has every other variable read for it.
 *
 * Every setting is resolved before anything is reported, so the returned
 * failure carries **all** of the problems rather than the first one. On
 * success the five `$DEBUGGEN_HOME` paths are derived from the validated root,
 * which is why no other module joins them: `sessions.sqlite`, `backups/`,
 * `index/` and `auth.json` have one spelling, and the retention sweep, the
 * store, the backup writer and the credential writer all read it from here.
 *
 * Pure: it creates no directory, opens no file and starts nothing.
 * `src/main.ts` creates the state root `0700` from
 * {@link ServiceConfig.debuggenHome} after this returns.
 *
 * @param env The environment to read. Only the nine keys of
 * {@link SERVICE_ENV_KEYS} are consulted.
 * @param overrides Values the host already decided, which win over the
 * environment. A blank string counts as absent, exactly as a blank variable
 * does.
 * @returns The resolved configuration, or one `CONFIG_INVALID` error naming
 * every rejected key — never its value.
 *
 * @example
 * ```ts
 * const loaded = loadServiceConfig(process.env);
 * if (isErr(loaded)) {
 *   logger.fatal(loaded.error.message, { hint: loaded.error.hint });
 *   process.exitCode = 1;
 *   return;
 * }
 * await startService(loaded.value);
 * ```
 */
export function loadServiceConfig(
  env: Readonly<Record<string, string | undefined>>,
  overrides?: ServiceConfigOverrides,
): Result<ServiceConfig, DebuggenError> {
  const issues: ServiceConfigIssue[] = [];
  const homeDir = resolveHomeDirectory(overrides?.homeDir);

  // Resolved in SERVICE_ENV_KEYS order, so an aggregated failure lists its
  // keys in the order `.env.example` declares them.
  const anthropicApiKey =
    normaliseSetting(overrides?.anthropicApiKey) ?? readSetting(env, 'ANTHROPIC_API_KEY');

  const provider = settle(
    resolveProvider(readSetting(env, 'DEBUGGEN_PROVIDER'), overrides?.provider),
    DEFAULT_PROVIDER_ID,
    issues,
  );

  const model = normaliseSetting(overrides?.model) ?? readSetting(env, 'DEBUGGEN_MODEL');

  const host = settle(
    resolveHost(readSetting(env, 'DEBUGGEN_HOST'), overrides?.host),
    DEFAULT_HOST,
    issues,
  );

  const port = settle(
    resolveIntegerSetting(readSetting(env, 'DEBUGGEN_PORT'), overrides?.port, PORT_SPEC),
    DEFAULT_PORT,
    issues,
  );

  const debuggenHome = settle(
    resolveDirectorySetting(
      'DEBUGGEN_HOME',
      normaliseSetting(overrides?.debuggenHome) ??
        readSetting(env, 'DEBUGGEN_HOME') ??
        DEFAULT_DEBUGGEN_HOME,
      homeDir,
      HOME_HINT,
    ),
    '',
    issues,
  );

  const logLevel = settle(
    resolveLogLevel(readSetting(env, 'DEBUGGEN_LOG_LEVEL'), overrides?.logLevel),
    DEFAULT_LOG_LEVEL,
    issues,
  );

  const retentionDays = settle(
    resolveIntegerSetting(
      readSetting(env, 'DEBUGGEN_RETENTION_DAYS'),
      overrides?.retentionDays,
      RETENTION_SPEC,
    ),
    DEFAULT_RETENTION_DAYS,
    issues,
  );

  const promptsDir = settle(
    resolvePromptsDirectory(
      readSetting(env, 'DEBUGGEN_PROMPTS_DIR'),
      overrides?.promptsDir,
      homeDir,
    ),
    '',
    issues,
  );

  if (issues.length > 0) {
    return err(configError(issues));
  }

  // Derived only once every setting has been validated, so the paths below are
  // always built from a real absolute root.
  return ok({
    host,
    port,
    logLevel,
    retentionDays,
    provider,
    ...(model === undefined ? {} : { model }),
    ...(anthropicApiKey === undefined ? {} : { anthropicApiKey }),
    debuggenHome,
    databasePath: joinPosix(debuggenHome, SESSIONS_DATABASE_FILE_NAME),
    backupsDir: joinPosix(debuggenHome, BACKUPS_DIRECTORY_NAME),
    indexCacheDir: joinPosix(debuggenHome, INDEX_CACHE_DIRECTORY_NAME),
    authFilePath: joinPosix(debuggenHome, AUTH_FILE_NAME),
    promptsDir,
  });
}

/* -------------------------------------------------------------------------------------------------
 * The contract, as data
 * ---------------------------------------------------------------------------------------------- */

/**
 * The environment contract in machine-readable form, with
 * {@link loadServiceConfig} as its `safeParse`.
 *
 * Frozen, and every descriptor with it: this object is shared by the
 * documentation checks and by anything that enumerates the surface, and a
 * mutation would make one reader disagree with the loader.
 *
 * It is a descriptor object rather than a validation-library schema, for the
 * reason given in this module's overview — this workspace declares no schema
 * library, and configuration is the one contract no `@debuggen/*` package
 * owns.
 */
export const serviceConfigSchema: ServiceConfigSchema = Object.freeze({
  keys: SERVICE_ENV_KEYS,
  entries: Object.freeze({
    ANTHROPIC_API_KEY: Object.freeze({
      key: 'ANTHROPIC_API_KEY',
      kind: 'credential',
      secret: true,
      description:
        'Credential for the network-backed model provider. Needed only when that provider is selected; the requirement itself is enforced by @debuggen/model-provider.',
    }),
    DEBUGGEN_PROVIDER: Object.freeze({
      key: 'DEBUGGEN_PROVIDER',
      kind: 'enum',
      secret: false,
      defaultValue: DEFAULT_PROVIDER_ID,
      allowedValues: PROVIDER_IDS,
      description:
        'Which model provider the six-stage pipeline calls. The default reaches no network, which is the privacy posture the product assumes until a developer opts out of it.',
    }),
    DEBUGGEN_MODEL: Object.freeze({
      key: 'DEBUGGEN_MODEL',
      kind: 'string',
      secret: false,
      description:
        'The model id a session calls. Never defaulted anywhere in the product: a session records the model it used, and a substituted default would make that record untrue.',
    }),
    DEBUGGEN_HOST: Object.freeze({
      key: 'DEBUGGEN_HOST',
      kind: 'string',
      secret: false,
      defaultValue: DEFAULT_HOST,
      description:
        'The interface the HTTP and WebSocket surfaces bind. Loopback by default, which is the access boundary the authentication rules assume.',
    }),
    DEBUGGEN_PORT: Object.freeze({
      key: 'DEBUGGEN_PORT',
      kind: 'integer',
      secret: false,
      defaultValue: DEFAULT_PORT,
      description:
        'The port serving both surfaces. Zero asks the operating system for an ephemeral port, which is how the integration suites run several services at once.',
    }),
    DEBUGGEN_HOME: Object.freeze({
      key: 'DEBUGGEN_HOME',
      kind: 'path',
      secret: false,
      defaultValue: DEFAULT_DEBUGGEN_HOME,
      description:
        'The state root holding the session database, the editor credential, the pre-patch file backups and the code-index cache. Outside every checkout, so a session never appears in a working tree.',
    }),
    DEBUGGEN_LOG_LEVEL: Object.freeze({
      key: 'DEBUGGEN_LOG_LEVEL',
      kind: 'enum',
      secret: false,
      defaultValue: DEFAULT_LOG_LEVEL,
      allowedValues: LOG_LEVEL_SETTINGS,
      description:
        'The service log threshold, on the same scale the logger uses. The additional value silent turns the service quiet without any call site knowing about it.',
    }),
    DEBUGGEN_RETENTION_DAYS: Object.freeze({
      key: 'DEBUGGEN_RETENTION_DAYS',
      kind: 'integer',
      secret: false,
      defaultValue: DEFAULT_RETENTION_DAYS,
      description:
        'How many days of sessions, telemetry, panels, analyses and backups the retention sweep keeps. Zero purges everything eligible.',
    }),
    DEBUGGEN_PROMPTS_DIR: Object.freeze({
      key: 'DEBUGGEN_PROMPTS_DIR',
      kind: 'path',
      secret: false,
      description:
        'The versioned prompt directory. Set by the editor extension for the service it bundles; otherwise derived from the service module location.',
    }),
  }),
  safeParse: loadServiceConfig,
});

/* -------------------------------------------------------------------------------------------------
 * Handing the values on
 * ---------------------------------------------------------------------------------------------- */

/**
 * The provider settings, shaped for `@debuggen/model-provider`.
 *
 * Transport, not decision. Whether the selected provider is *usable* — a
 * network provider needs both a model and a credential — belongs to that
 * package's `resolveProviderConfig` / `createModelProvider`, which own the
 * developer-facing sentence for an unusable one. This function exists so that
 * `src/main.ts` can hand them the values this module already validated instead
 * of letting them read the environment a second time, which is what would let
 * the two readings disagree.
 *
 * Absent members are omitted rather than passed as `undefined`, because the
 * receiving type distinguishes the two under `exactOptionalPropertyTypes` and
 * treats an omitted model as "nothing configured one".
 *
 * @param config A configuration from {@link loadServiceConfig}.
 * @returns The overrides to pass alongside the environment record.
 *
 * @example
 * ```ts
 * const provider = createModelProvider({ env, overrides: toModelProviderOverrides(config) });
 * ```
 */
export function toModelProviderOverrides(config: ServiceConfig): Partial<ModelProviderConfig> {
  return {
    providerId: config.provider,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.anthropicApiKey === undefined ? {} : { apiKey: config.anthropicApiKey }),
  };
}

/**
 * The loggable view of a configuration.
 *
 * The credential is reported as `anthropicApiKeyPresent`, a boolean, and its
 * content appears nowhere — not truncated, not hashed, not fingerprinted. That
 * is the whole reason this function exists rather than each call site
 * assembling its own fields: a log line is written once and read for the
 * lifetime of the file it lands in, and "log the resolved configuration for
 * debugging" is exactly how a credential reaches disk.
 *
 * Everything else is included, because every one of those values is something
 * a developer diagnosing a start-up needs to see: which interface and port
 * were bound, which provider and model were selected, where state is being
 * written and which prompt directory is in force.
 *
 * @param config A configuration from {@link loadServiceConfig}.
 * @returns Fields for the logger, holding no credential.
 */
export function describeServiceConfig(config: ServiceConfig): LogFields {
  return {
    subsystem: SUBSYSTEM,
    host: config.host,
    port: config.port,
    logLevel: config.logLevel,
    retentionDays: config.retentionDays,
    provider: config.provider,
    model: config.model ?? null,
    anthropicApiKeyPresent: config.anthropicApiKey !== undefined,
    debuggenHome: config.debuggenHome,
    databasePath: config.databasePath,
    backupsDir: config.backupsDir,
    indexCacheDir: config.indexCacheDir,
    authFilePath: config.authFilePath,
    promptsDir: config.promptsDir,
  };
}
