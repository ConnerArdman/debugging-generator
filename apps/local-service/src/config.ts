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
 * | `ANTHROPIC_API_KEY` | non-empty string | none — **required** when a provider that needs one is selected |
 * | `DEBUGGEN_PROVIDER` | one of `PROVIDER_IDS` | `DEFAULT_PROVIDER_ID` (reaches no network) |
 * | `DEBUGGEN_MODEL` | non-empty string | **none, never defaulted** — required alongside the credential |
 * | `DEBUGGEN_HOST` | a loopback interface, without whitespace | {@link DEFAULT_HOST} |
 * | `DEBUGGEN_PORT` | integer `0`–{@link MAX_PORT} | {@link DEFAULT_PORT} |
 * | `DEBUGGEN_HOME` | absolute path, `~` accepted; outside every project worked on | {@link DEFAULT_DEBUGGEN_HOME} |
 * | `DEBUGGEN_LOG_LEVEL` | one of {@link LOG_LEVEL_SETTINGS} | {@link DEFAULT_LOG_LEVEL} |
 * | `DEBUGGEN_RETENTION_DAYS` | integer of `0` or more | {@link DEFAULT_RETENTION_DAYS} |
 * | `DEBUGGEN_PROMPTS_DIR` | absolute path; at start-up, an existing directory holding {@link PROMPTS_MANIFEST_FILE_NAME} ({@link verifyPromptsDirectory}) | derived from this module's own location |
 *
 * Every rule in that table except one is a rule about the value, and
 * {@link loadServiceConfig} settles it without touching the disk. The
 * exception is whether the prompt directory is there at all, a fact about the
 * machine rather than the value. {@link verifyPromptsDirectory} checks it, and
 * `src/main.ts` calls it immediately after {@link loadServiceConfig}, before
 * the logger, the state root or anything else writes a byte. A missing prompt
 * tree therefore fails the start the way a malformed variable does: one
 * `CONFIG_INVALID` naming `DEBUGGEN_PROMPTS_DIR`, with nothing left behind.
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
 * path helpers do the work, so {@link loadServiceConfig} touches no
 * filesystem. This module reads the filesystem in two places, each an explicit
 * call of its own and neither one writing: {@link verifyPromptsDirectory},
 * which runs two `stat`s on the prompt directory, and the asynchronous
 * {@link canonicalizePath} described next.
 *
 * ## The state root stays outside every project
 *
 * Session data and file backups live outside every target project (under
 * `~/.debuggen` by default), so a session never pollutes the developer's git
 * status. A configured `DEBUGGEN_HOME` is an arbitrary absolute path, so that
 * promise is enforced rather than assumed: a project root that **is** the state
 * root, **contains** it (`DEBUGGEN_HOME=/work/shop/.state` with the project
 * `/work/shop`) or **lies inside** it is refused, because the store, the editor
 * credential and every pre-patch backup would otherwise land in — or be the
 * parent of — a developer's working tree (CWE-200).
 *
 * The comparison is made between **canonical** paths: {@link canonicalizePath}
 * resolves every symbolic link with `realpath`, so a project reached through a
 * link into the state root is refused, and a sibling that merely shares a
 * prefix (`/work/shop` and `/work/shop-state`) is not, because
 * {@link pathsOverlap} compares whole segments through `@debuggen/shared`'s
 * `isWithin`. A root that does not exist yet is resolved through its nearest
 * existing ancestor. {@link requireProjectOutsideStateHome} is the check the
 * service applies before a session is created or questioned and before a dev
 * server is launched or credentialed, and that `src/instrumentation/service.ts`
 * repeats before every install writes a backup or a patch; `src/main.ts`
 * applies it at start-up to the project of every stored session, and refuses
 * the start when one of them cannot be resolved at all. Its refusals are
 * `FS_UNSAFE_PATH` errors whose message and hint are constant sentences that
 * name no path.
 *
 * No start-up heuristic stands in for that check: a state root inside a
 * repository is not refused for being there (the Playwright suites keep theirs
 * in the gitignored `test-results/debuggen-home`), only one that overlaps the
 * project actually worked on.
 *
 * ## Three schemas, one loader
 *
 * Validation is declared, not hand-rolled: the contract is three Zod schemas
 * and the loader is the deterministic step between them, which is the same
 * shape every model-facing artifact in this product takes — parse the authored
 * input, normalise deterministically, then validate the normalised result
 * against the internal schema.
 *
 * | Schema | Validates | Produces |
 * | --- | --- | --- |
 * | {@link serviceEnvSchema} | the nine raw environment strings: trimmed, blank treated as absent, each key's vocabulary, range and path shape | optional, already-typed settings |
 * | {@link serviceConfigOverridesSchema} | the same settings as a host already decided them, under their own "the injected override …" wording | optional, already-typed settings |
 * | {@link resolvedServiceConfigSchema} | a whole {@link ServiceConfig}: the loopback bind, the port range, the closed vocabularies, absolute normalised paths, the derived-path agreement, and the credentials the selected provider requires | the configuration every subsystem is handed |
 *
 * Between the raw schemas and the resolved one sits {@link loadServiceConfig}'s
 * deterministic normalisation: per-setting precedence (an override wins over a
 * variable), `~` expansion against an injectable home directory, the defaults,
 * and the five `$DEBUGGEN_HOME` paths. Nothing in that step decides whether a
 * value is acceptable — the schemas do — which is why the same object can be
 * validated again by {@link resolvedServiceConfigSchema} anywhere else it is
 * read back from, for instance a configuration a host assembled itself.
 *
 * The one thing the schemas deliberately do **not** do is speak for
 * themselves. A rejected setting is reported through this module's own reason
 * clauses, attached to each issue as structured metadata; no message the
 * validation library generated is ever read, because several of its default
 * messages quote the value they rejected and this module's whole failure policy
 * is that a value never appears. {@link serviceConfigSchema} remains the
 * machine-readable description of the contract for documentation and tooling —
 * key, kind, default, vocabulary — and carries references to all three schemas
 * so a caller reaches them through either name.
 *
 * ## Provider credentials are settled here, not at first use
 *
 * A provider that reaches the network needs both a model id and a credential.
 * {@link PROVIDER_REQUIREMENTS} states that per provider and
 * {@link resolvedServiceConfigSchema} enforces it, so `DEBUGGEN_PROVIDER=…`
 * with nothing to authenticate with fails at start-up, naming the missing key,
 * instead of failing when the first pipeline stage tries to call a model —
 * which is after a developer has asked a question, after the code index has
 * been built, and after instrumentation has been planned.
 * `@debuggen/model-provider` keeps the same rule at construction time for
 * hosts that do not come through this module; the two agree by naming the same
 * keys and offering the same remedy.
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
 *
 * That rule governs every value {@link loadServiceConfig} rejects. The one
 * failure that quotes something is {@link verifyPromptsDirectory}'s, and what
 * it quotes is not a rejected value. It is the resolved prompt directory, a
 * path that already passed validation and that {@link describeServiceConfig}
 * logs verbatim on every start. It is quoted because it is often the derived
 * default, a path the developer never typed and could not otherwise find.
 * Control characters are replaced and the length is bounded before it
 * appears, and a credential can never reach it, since it is only ever the
 * prompt directory.
 */

import {
  DebuggenError,
  LOG_LEVELS,
  basenamePosix,
  dirnamePosix,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  isWithin,
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
import { z } from 'zod';

import { statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
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
 * The tuple documents the same nine keys `.env.example` documents, but its
 * order is this module's own: it is the order {@link loadServiceConfig}
 * resolves in and the order an aggregated failure lists its keys in, which
 * makes a rejection predictable instead of dependent on whichever resolver
 * happened to run first. `.env.example` groups the same keys for a reader
 * instead — it carries `DEBUGGEN_PROMPTS_DIR` with the other service
 * settings, where this tuple resolves it last — so the two agree on the set
 * of keys, not on their positions.
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

/**
 * Whether `value` is one of the keys in {@link SERVICE_ENV_KEYS}.
 *
 * Used where a key arrives without a type: the issue metadata a schema check
 * attached, which the validation library carries as `Record<string, unknown>`.
 * Narrowing it here rather than trusting it is what keeps {@link toConfigIssue}
 * from reporting a key this service does not read.
 *
 * @param value Any value.
 * @returns `true` when `value` is a {@link ServiceEnvKey}.
 */
export function isServiceEnvKey(value: unknown): value is ServiceEnvKey {
  return typeof value === 'string' && SERVICE_ENV_KEYS.some((candidate) => candidate === value);
}

/**
 * Which settings the selected provider must have before a session can call it,
 * per provider id.
 *
 * Total over `ProviderId` on purpose: a provider added to `PROVIDER_IDS` stops
 * this file compiling until its requirements are stated, which is the same
 * mechanism `@debuggen/model-provider`'s exhaustive `switch` uses to keep its
 * construction paths honest. The offline default requires nothing, which is
 * what lets an unconfigured checkout start and run the whole pipeline.
 *
 * Each named key must have an entry in the internal requirement table, so a
 * requirement cannot be declared without a way to tell whether it is satisfied
 * and something to say when it is not.
 */
export const PROVIDER_REQUIREMENTS: Readonly<
  Record<ProviderId, readonly ProviderRequirementKey[]>
> = Object.freeze({
  anthropic: Object.freeze<ProviderRequirementKey[]>(['ANTHROPIC_API_KEY', 'DEBUGGEN_MODEL']),
  deterministic: Object.freeze<ProviderRequirementKey[]>([]),
});

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
   * The selected model provider, validated against `PROVIDER_IDS` — and
   * validated as *usable*, not merely as recognised.
   *
   * A provider needing a model and a credential has them by the time this
   * field exists: {@link PROVIDER_REQUIREMENTS} states what each one needs and
   * {@link resolvedServiceConfigSchema} enforces it, so a configuration that
   * reached a caller can be handed to `@debuggen/model-provider` — which keeps
   * the same rule at construction time for hosts that do not come through this
   * module. See {@link toModelProviderOverrides}.
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
 * The one reason that names a path is {@link verifyPromptsDirectory}'s, which
 * quotes the validated prompt directory it looked in, never a rejected value.
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
 * The description of the environment contract, its parse entry point and the
 * three schemas that do the validating.
 *
 * The descriptor half — {@link ServiceConfigSchema.keys} and
 * {@link ServiceConfigSchema.entries} — is what documentation checks and
 * anything enumerating the surface read: key, kind, default, vocabulary, and
 * whether a value is a credential. The schema half —
 * {@link ServiceConfigSchema.env}, {@link ServiceConfigSchema.overrides} and
 * {@link ServiceConfigSchema.resolved} — is the validation itself, reachable
 * through this object as well as under its own exported name.
 * {@link ServiceConfigSchema.safeParse} is {@link loadServiceConfig}: the whole
 * read, returning a `Result` rather than throwing, like everything else here.
 */
export interface ServiceConfigSchema {
  /** The keys, in the order a failure reports them. */
  readonly keys: readonly ServiceEnvKey[];

  /** One descriptor per key. */
  readonly entries: Readonly<Record<ServiceEnvKey, ServiceEnvKeyDescriptor>>;

  /** {@link serviceEnvSchema}: the nine raw environment strings. */
  readonly env: ServiceEnvSchema;

  /** {@link serviceConfigOverridesSchema}: the same settings from a host. */
  readonly overrides: ServiceConfigOverridesSchema;

  /** {@link resolvedServiceConfigSchema}: a whole resolved configuration. */
  readonly resolved: ResolvedServiceConfigSchema;

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

/**
 * The name that resolves to the loopback interface on every supported
 * platform, and one of the three spellings {@link isLoopbackHost} accepts.
 */
const LOOPBACK_HOST_NAME = 'localhost';

/** A dotted-quad IPv4 literal, one capture group per octet. */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The highest value one octet of an IPv4 literal may carry. */
const MAX_IPV4_OCTET = 255;

/** The first octet of every address in `127.0.0.0/8`, the IPv4 loopback block. */
const IPV4_LOOPBACK_FIRST_OCTET = 127;

/** How many groups a fully written IPv6 address carries. */
const IPV6_GROUP_COUNT = 8;

/** The zero-run compression marker of an IPv6 address. */
const IPV6_COMPRESSION = '::';

/** One group of an IPv6 address: one to four hexadecimal digits. */
const IPV6_GROUP_PATTERN = /^[0-9A-Fa-f]{1,4}$/;

/**
 * The two prefixes that may precede an embedded IPv4 address for the result to
 * still name the same interface as that address: the IPv4-compatible form
 * (`::a.b.c.d`) and the IPv4-mapped form (`::ffff:a.b.c.d`). Anything else in
 * front of an embedded address names a different host.
 */
const IPV4_EMBEDDED_PREFIXES: ReadonlySet<string> = new Set([
  IPV6_COMPRESSION,
  `${IPV6_COMPRESSION}ffff:`,
]);

/** The bracket a host value carries when it was copied out of a URL authority. */
const IPV6_BRACKETS = Object.freeze({ open: '[', close: ']' });

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

/**
 * The next step for a host value the service will not bind.
 *
 * Deliberately free of any address literal other than {@link DEFAULT_HOST} and
 * the block it belongs to. The privacy rule this module lives by is asserted by
 * a suite that checks a rejected value appears in no surface of the failure, so
 * a hint naming `0.0.0.0` or the IPv6 loopback literal would report the very
 * value it had just refused — as a substring of its own remedy.
 */
const HOST_HINT =
  `Set DEBUGGEN_HOST to a loopback interface: '${DEFAULT_HOST}', another address in the ` +
  `127.0.0.0/8 block, the name '${LOOPBACK_HOST_NAME}', or the IPv6 loopback address. Leave it ` +
  `unset for '${DEFAULT_HOST}'. The service authenticates every client and refuses web origins ` +
  'on the understanding that it is reachable only from this machine, so a wildcard bind and any ' +
  'routable interface are refused here rather than quietly widening that boundary.';

/**
 * The next step when the selected provider needs a credential and none is
 * configured.
 *
 * Names the key and the offline alternative, and nothing about the credential
 * itself — there is none to describe, which is the point.
 */
const CREDENTIAL_HINT =
  'Set ANTHROPIC_API_KEY in the environment the local service was started from, or set ' +
  `DEBUGGEN_PROVIDER=${DEFAULT_PROVIDER_ID} to run the pipeline offline, where no credential is ` +
  'needed. Its value is never logged, never placed in an error and never written to a session ' +
  'record.';

/** The next step when the selected provider needs a model and none is configured. */
const MODEL_HINT =
  'Set DEBUGGEN_MODEL to the model this session should call. It is never defaulted: a session ' +
  'records the model it used, and a substituted default would make that record untrue. Set ' +
  `DEBUGGEN_PROVIDER=${DEFAULT_PROVIDER_ID} to run the pipeline offline, where no model is needed.`;

/** The next step for a port value outside the accepted range. */
const PORT_HINT =
  `Set DEBUGGEN_PORT to a whole number from ${EPHEMERAL_PORT} to ${MAX_PORT}. Leave it unset for ` +
  `${DEFAULT_PORT}, or use ${EPHEMERAL_PORT} to let the operating system choose a free port.`;

/** The next step for a retention window that is not a whole number of days. */
const RETENTION_HINT =
  'Set DEBUGGEN_RETENTION_DAYS to a whole number of days, 0 or more. Leave it unset for ' +
  `${DEFAULT_RETENTION_DAYS}; 0 purges every record the next sweep finds eligible.`;

/**
 * The next step for a state root that is not an absolute path.
 *
 * It also states the placement rule the service enforces later, when a
 * project is named (see "The state root stays outside every project" above):
 * the rule is about projects, not repositories, because a state root inside
 * some other repository — the Playwright suites' gitignored
 * `test-results/debuggen-home` — is apart from the project it debugs.
 */
const HOME_HINT =
  `Set DEBUGGEN_HOME to an absolute directory path, or to a path starting with '${HOME_PREFIX}' ` +
  `to place it inside your home directory. Leave it unset for '${DEFAULT_DEBUGGEN_HOME}'. It must ` +
  'lie outside every project Debug Generator works on, so that session data, file backups and ' +
  'the editor credential never appear in a working tree: a project that contains it, or lies ' +
  'inside it, is refused.';

/** The next step for a prompt directory that cannot be used. */
const PROMPTS_HINT =
  'Set DEBUGGEN_PROMPTS_DIR to the absolute path of the versioned prompt directory, or leave it ' +
  'unset to use the one shipped beside the service. The editor extension sets it for the service ' +
  'it bundles, so there is normally nothing to set by hand.';

/**
 * The next step for each key, as one table.
 *
 * Every rejection of a key answers with that key's remedy, whatever the reason:
 * a port that is not a number and a port outside the range have the same fix,
 * and a developer reading a failure wants the fix rather than a variant of it.
 * Holding them here — total over {@link SERVICE_ENV_KEYS}, so a key cannot be
 * validated without a remedy — is what lets every check in the schemas below
 * report a reason alone and still produce a complete issue.
 *
 * The two vocabulary entries are functions because their text is joined from
 * the tuple that owns the vocabulary at call time, so a provider or a log level
 * added there appears in the remedy with nothing to edit here.
 */
const KEY_HINTS: Readonly<Record<ServiceEnvKey, () => string>> = Object.freeze({
  ANTHROPIC_API_KEY: () => CREDENTIAL_HINT,
  DEBUGGEN_PROVIDER: unrecognisedProviderHint,
  DEBUGGEN_MODEL: () => MODEL_HINT,
  DEBUGGEN_HOST: () => HOST_HINT,
  DEBUGGEN_PORT: () => PORT_HINT,
  DEBUGGEN_HOME: () => HOME_HINT,
  DEBUGGEN_LOG_LEVEL: unrecognisedLogLevelHint,
  DEBUGGEN_RETENTION_DAYS: () => RETENTION_HINT,
  DEBUGGEN_PROMPTS_DIR: () => PROMPTS_HINT,
});

/* -------------------------------------------------------------------------------------------------
 * Reason clauses
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every reason clause this module records, in one place.
 *
 * A reason is a lower-case clause assembled from the key's kind, its accepted
 * vocabulary and its accepted range — and from nothing else. The schemas below
 * attach one of these strings to each issue as structured metadata rather than
 * leaving the validation library's own message to be interpreted, which is what
 * makes the privacy rule mechanical instead of remembered: {@link toConfigIssue}
 * reads only metadata this module authored, so a default message that quotes
 * the value it rejected cannot reach a log line, a session record or a user
 * interface even by accident.
 */
const REASONS = Object.freeze({
  /** A value that should have been a whole number and was not. */
  notAnInteger: 'the value is not a whole number',

  /** The same, for a value a host injected rather than a variable carried. */
  overrideNotAnInteger: 'the injected override is not a whole number',

  /** A provider selection outside `PROVIDER_IDS`. */
  unknownProvider: 'the value names no provider this build offers',

  /** A log threshold outside {@link LOG_LEVEL_SETTINGS}. */
  unknownLogLevel: 'the value names no known log level',

  /** A host value with embedded whitespace, which is never one interface. */
  hostWhitespace: 'the value contains whitespace',

  /** A host value that names something other than this machine's loopback interface. */
  hostNotLoopback: 'the value is not a loopback interface',

  /** A path carrying a character no filesystem path may contain. */
  nulCharacter: 'the value contains a NUL character',

  /** A path naming a share on another host, which normalisation would silently rewrite. */
  uncPath: 'a UNC path is not supported as a directory root',

  /** `C:state` — rooted at a drive, but relative to that drive's current directory. */
  driveRelativePath: 'a drive-relative Windows path is not absolute',

  /** A path that is neither absolute nor home-relative. */
  notAbsolutePath: 'the value is not an absolute path',

  /** `~other/x` — resolving another account's home directory is not this tool's business. */
  otherAccountHome: 'a home-directory prefix naming another account is not supported',

  /** A `~` value on a system whose home directory could not be determined. */
  indeterminableHome:
    'the value starts with a home-directory prefix and no home directory could be determined',

  /** The prompt directory shipped beside the service could not be located. */
  underivablePromptsDir:
    "the default directory could not be derived from the service module's own location",

  /** A value that was not a string at all, which only an untyped caller can produce. */
  unexpectedType: 'the value is not a string',

  /** The same, for a host-supplied override whose type the compiler could not vouch for. */
  unexpectedOverrideType: 'the injected override is not of the expected type',

  /** A resolved path that is not the absolute, normalised POSIX form every consumer expects. */
  unnormalisedPath: 'the resolved path is not an absolute, normalised path',

  /** A resolved value that is blank or still carries the padding a reader would have trimmed. */
  unnormalisedValue: 'the resolved value is blank or carries surrounding whitespace',

  /** A resolved configuration whose derived paths do not sit under its own state root. */
  derivedPathsDisagree: 'the derived state-root paths do not agree with the resolved root',
});

/**
 * The reason for a value outside an integer setting's accepted range.
 *
 * Built from the setting's own bounds so the clause and the remedy cannot
 * disagree about what is accepted.
 *
 * @param spec The setting's bounds.
 * @param source Whether the value came from the environment or from a host.
 * @returns The reason clause, naming the range and no value.
 */
function rangeReason(spec: IntegerSettingSpec, source: 'environment' | 'override'): string {
  const range = `outside the accepted range ${spec.min} to ${spec.max}`;
  return source === 'environment' ? `the value is ${range}` : `the injected override is ${range}`;
}

/* -------------------------------------------------------------------------------------------------
 * Provider requirements
 * ---------------------------------------------------------------------------------------------- */

/** What the resolved configuration must carry for a requirement to be satisfied. */
interface ProviderRequirementSubject {
  /** The model id from `DEBUGGEN_MODEL`, absent when nothing configured one. */
  readonly model?: string | undefined;

  /** The credential from `ANTHROPIC_API_KEY`, absent when nothing configured one. */
  readonly anthropicApiKey?: string | undefined;
}

/** How to tell whether one required setting is configured, and what to say when it is not. */
interface ProviderRequirementRule {
  /** Whether the resolved configuration carries the setting. */
  readonly isConfigured: (subject: ProviderRequirementSubject) => boolean;

  /** The reason clause recorded against the key when it does not. */
  readonly reason: string;
}

/**
 * The settings a provider may require, each with its test and its reason.
 *
 * Keyed by the environment key the failure is reported against, so the
 * developer is told which variable to set rather than which provider complained
 * — and keyed exhaustively, because {@link ProviderRequirementKey} is derived
 * from this table: a requirement named in {@link PROVIDER_REQUIREMENTS} without
 * an entry here does not compile.
 *
 * Neither reason names the provider, and neither names a value. The provider id
 * is a validated vocabulary member rather than a secret, but the rule this
 * module holds is that a failure describes the *key* and the condition, so the
 * clauses say "the selected provider" and the remedy names the offline
 * alternative.
 */
const PROVIDER_REQUIREMENT_RULES = Object.freeze({
  ANTHROPIC_API_KEY: Object.freeze({
    isConfigured: (subject: ProviderRequirementSubject) => subject.anthropicApiKey !== undefined,
    reason: 'the selected provider requires a credential and none is configured',
  }),
  DEBUGGEN_MODEL: Object.freeze({
    isConfigured: (subject: ProviderRequirementSubject) => subject.model !== undefined,
    reason: 'the selected provider requires a model and none is configured',
  }),
} satisfies Readonly<Partial<Record<ServiceEnvKey, ProviderRequirementRule>>>);

/** One of the settings a provider can require: a key of {@link PROVIDER_REQUIREMENT_RULES}. */
export type ProviderRequirementKey = keyof typeof PROVIDER_REQUIREMENT_RULES;

/* -------------------------------------------------------------------------------------------------
 * Failure construction
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds one issue, taking the remedy from {@link KEY_HINTS}.
 *
 * A caller supplies the key and the reason only: the next step belongs to the
 * key rather than to the reason, so passing it in would let two rejections of
 * the same variable answer with different remedies.
 *
 * @param key The environment key that was rejected.
 * @param reason Why, as a clause naming no value.
 * @returns The issue, for collection by {@link loadServiceConfig}.
 */
function issue(key: ServiceEnvKey, reason: string): ServiceConfigIssue {
  return { key, reason, hint: KEY_HINTS[key]() };
}

/**
 * Orders issues the way {@link SERVICE_ENV_KEYS} declares their keys.
 *
 * Issues are raised by three schemas and one normalisation step, so the order
 * they arrive in is the order the checks happen to run. A developer editing a
 * `.env` file reads the list against that file, which is why the report order
 * is the contract's order and not the discovery order — and why a cross-field
 * rejection, raised last, still appears beside the keys it names.
 *
 * Stable within a key, though no two issues can share one: each key is
 * validated once per load.
 *
 * @param issues The issues collected during one load.
 * @returns The same issues, in contract order.
 */
function inContractOrder(issues: readonly ServiceConfigIssue[]): ServiceConfigIssue[] {
  const position = (key: ServiceEnvKey): number => SERVICE_ENV_KEYS.indexOf(key);
  return [...issues].sort((left, right) => position(left.key) - position(right.key));
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
  const ordered = inContractOrder(issues);
  const summary = ordered.map((entry) => `${entry.key} (${entry.reason})`).join('; ');
  const hints = [...new Set(ordered.map((entry) => entry.hint))].join(' ');

  return new DebuggenError(CONFIG_CODE, `The local service configuration is invalid: ${summary}.`, {
    hint: hints,
    details: {
      subsystem: SUBSYSTEM,
      keys: ordered.map((entry) => entry.key),
      issues: ordered.map((entry) => ({ key: entry.key, reason: entry.reason })),
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

/** The bounds, default and identity of one integer setting. */
interface IntegerSettingSpec {
  /** The key being validated, which is also the key a rejection is reported against. */
  readonly key: ServiceEnvKey;

  /** The lowest accepted value, inclusive. */
  readonly min: number;

  /** The highest accepted value, inclusive. */
  readonly max: number;

  /** The value applied when nothing configured the key. */
  readonly fallback: number;
}

/** `DEBUGGEN_PORT`: a bindable port, or {@link EPHEMERAL_PORT} to let the system choose. */
const PORT_SPEC: IntegerSettingSpec = Object.freeze({
  key: 'DEBUGGEN_PORT',
  min: EPHEMERAL_PORT,
  max: MAX_PORT,
  fallback: DEFAULT_PORT,
});

/** `DEBUGGEN_RETENTION_DAYS`: a whole number of days, `0` meaning purge everything eligible. */
const RETENTION_SPEC: IntegerSettingSpec = Object.freeze({
  key: 'DEBUGGEN_RETENTION_DAYS',
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  fallback: DEFAULT_RETENTION_DAYS,
});

/* -------------------------------------------------------------------------------------------------
 * The loopback vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * Strips the brackets a host value carries when it was copied out of a URL.
 *
 * `[::1]` is how an IPv6 address is written inside a URL authority, and it is
 * what a developer copies out of a browser address bar — but it is not what a
 * listener binds, so the brackets are removed here rather than passed on to
 * fail several steps later. A value with only one of the two brackets is left
 * exactly as it is, so it reaches {@link isLoopbackHost} and is refused.
 *
 * @param value A trimmed host value.
 * @returns The value without its surrounding brackets.
 */
function stripIpv6Brackets(value: string): string {
  const bracketed =
    value.startsWith(IPV6_BRACKETS.open) &&
    value.endsWith(IPV6_BRACKETS.close) &&
    value.length > IPV6_BRACKETS.open.length + IPV6_BRACKETS.close.length;

  return bracketed
    ? value.slice(IPV6_BRACKETS.open.length, value.length - IPV6_BRACKETS.close.length)
    : value;
}

/**
 * Whether a dotted-quad literal names an address in `127.0.0.0/8`.
 *
 * The whole block rather than the single address, because every address in it
 * is loopback: a developer who binds `127.0.0.2` to keep two tools apart has
 * not widened anything.
 *
 * @param value A string already matched by {@link IPV4_PATTERN}.
 * @returns `true` when every octet is in range and the first is `127`.
 */
function isIpv4Loopback(value: string): boolean {
  const octets = value.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > MAX_IPV4_OCTET)) {
    return false;
  }
  return octets.at(0) === IPV4_LOOPBACK_FIRST_OCTET;
}

/**
 * Expands an IPv6 literal to its eight groups, or `undefined` when it is not
 * one.
 *
 * Only what the loopback question needs: one optional `::` run, no embedded
 * IPv4 address (which {@link isIpv6Loopback} handles before calling this), and
 * exactly eight groups once the run is expanded. A zone identifier, a port or a
 * second `::` leaves a group that fails {@link IPV6_GROUP_PATTERN}, so the
 * address is refused rather than partially understood.
 *
 * @param value A trimmed, bracket-free value containing at least one colon.
 * @returns The eight groups, or `undefined` when the value is not an IPv6
 * literal.
 */
function expandIpv6Groups(value: string): readonly string[] | undefined {
  const runs = value.split(IPV6_COMPRESSION);
  if (runs.length > 2) {
    return undefined;
  }

  if (runs.length === 1) {
    const groups = value.split(':');
    return groups.length === IPV6_GROUP_COUNT ? groups : undefined;
  }

  const head = runs.at(0) ?? '';
  const tail = runs.at(1) ?? '';
  const headGroups = head.length === 0 ? [] : head.split(':');
  const tailGroups = tail.length === 0 ? [] : tail.split(':');
  const elided = IPV6_GROUP_COUNT - headGroups.length - tailGroups.length;
  if (elided < 1) {
    return undefined;
  }

  return [...headGroups, ...Array.from({ length: elided }, () => '0'), ...tailGroups];
}

/**
 * Whether an IPv6 literal names the loopback interface.
 *
 * Two forms count. The plain one is `::1` and every way of writing it out —
 * seven zero groups and a final `1`, in any mixture of compression and leading
 * zeros. The other is an embedded IPv4 address, `::127.0.0.1` or
 * `::ffff:127.0.0.1`, which names the same interface as the address it embeds
 * and only when its prefix is one of the two mapping prefixes; anything else in
 * front of an embedded address names a different host and is refused.
 *
 * @param value A trimmed, bracket-free value containing at least one colon.
 * @returns `true` when the value is an IPv6 loopback literal.
 */
function isIpv6Loopback(value: string): boolean {
  const lastColon = value.lastIndexOf(':');
  const trailing = value.slice(lastColon + 1);

  if (trailing.includes('.')) {
    return (
      IPV4_PATTERN.test(trailing) &&
      isIpv4Loopback(trailing) &&
      IPV4_EMBEDDED_PREFIXES.has(value.slice(0, lastColon + 1).toLowerCase())
    );
  }

  const groups = expandIpv6Groups(value);
  if (groups === undefined || !groups.every((group) => IPV6_GROUP_PATTERN.test(group))) {
    return false;
  }

  return groups.every((group, index) => {
    const expected = index === IPV6_GROUP_COUNT - 1 ? 1 : 0;
    return Number.parseInt(group, 16) === expected;
  });
}

/**
 * Whether a host value names this machine's loopback interface.
 *
 * The access boundary of the product is that the service is reachable from this
 * machine only (AAP 0.5.6): the authentication, role and Origin rules in
 * `src/server/auth.ts` keep other local processes and web pages out, and the
 * bind is what keeps other machines out. Those rules assume the bind, so a
 * routable interface would not narrow them — it would publish an authenticated
 * surface holding a developer's source excerpts, telemetry and session history
 * to every host that can route to this one. `0.0.0.0` and `::` are the two
 * values that do it by accident, which is why this check exists at the
 * configuration boundary rather than as advice in a comment.
 *
 * Three spellings are accepted: the name `localhost` in any letter case, any
 * IPv4 address in `127.0.0.0/8`, and the IPv6 loopback address in any of its
 * written forms, with URL brackets tolerated. Everything else is refused,
 * including a name that happens to resolve to a loopback address — resolution
 * depends on a hosts file this module does not read, and a name whose meaning
 * can change under the service is not a boundary.
 *
 * @param value A trimmed host value.
 * @returns `true` when the value names the loopback interface.
 */
function isLoopbackHost(value: string): boolean {
  const bare = stripIpv6Brackets(value);

  if (bare.toLowerCase() === LOOPBACK_HOST_NAME) {
    return true;
  }
  if (IPV4_PATTERN.test(bare)) {
    return isIpv4Loopback(bare);
  }
  if (bare.includes(':')) {
    return isIpv6Loopback(bare);
  }
  return false;
}

/**
 * The reason a host value cannot be bound, or `undefined` when it can.
 *
 * Shared by the environment schema and the override schema so that neither
 * channel can accept an interface the other refuses; the reasons are
 * source-agnostic because the rule is a property of the value, not of where it
 * came from.
 *
 * @param value A trimmed host value.
 * @returns The reason clause, or `undefined` when the value is bindable.
 */
function describeHostProblem(value: string): string | undefined {
  if (WHITESPACE_PATTERN.test(value)) {
    return REASONS.hostWhitespace;
  }
  if (!isLoopbackHost(value)) {
    return REASONS.hostNotLoopback;
  }
  return undefined;
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
    return REASONS.nulCharacter;
  }
  if (value.startsWith(UNC_PREFIX)) {
    return REASONS.uncPath;
  }
  if (isAbsolutePosix(value) || WINDOWS_ROOTED_PATTERN.test(value)) {
    return undefined;
  }
  if (isWindowsAbsolute(value)) {
    return REASONS.driveRelativePath;
  }
  return REASONS.notAbsolutePath;
}

/**
 * The reason a directory setting cannot be used, judged **before** its `~` is
 * expanded, or `undefined` when it can.
 *
 * This is the half of the path contract that needs no context, which is what
 * lets it live inside a schema: whether a value is absolute, home-relative or
 * neither is decidable from the value alone, and only the expansion itself
 * needs a home directory. A `~`-prefixed value is therefore accepted here and
 * settled during normalisation, where the home directory is known.
 *
 * @param value A trimmed value, before separator conversion.
 * @returns The reason clause, or `undefined` when the value is usable.
 */
function describeDirectorySettingProblem(value: string): string | undefined {
  const posix = toPosix(value);

  if (posix === HOME_MARKER || posix.startsWith(HOME_PREFIX)) {
    return posix.includes('\0') ? REASONS.nulCharacter : undefined;
  }
  if (posix.startsWith(HOME_MARKER)) {
    return REASONS.otherAccountHome;
  }
  return describePathProblem(posix);
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
 * Expands a leading `~` against the home directory and normalises the result.
 *
 * The deterministic half of the path contract: the value has already been
 * accepted by {@link describeDirectorySettingProblem}, so the only thing that
 * can still fail is the expansion itself, on a system whose home directory
 * could not be determined. Applied identically to `DEBUGGEN_HOME` and
 * `DEBUGGEN_PROMPTS_DIR`, both of which routinely arrive from a shell profile
 * or a settings file where a `~` is ordinary and where nothing else will expand
 * it — no filesystem call does, and neither does `path.resolve`.
 *
 * | Value | Result |
 * | --- | --- |
 * | `~` | the home directory |
 * | `~/x`, and `~\x` once separators are normalised | `<home>/x` |
 * | an absolute path | itself, normalised POSIX |
 *
 * @param key The key being resolved, for the issue.
 * @param selected The trimmed, already-validated value.
 * @param homeDir The home directory from {@link resolveHomeDirectory}, or
 * `undefined` when none could be determined.
 * @returns The absolute, normalised POSIX path, or the issue naming the key
 * that needed a home directory.
 */
function expandDirectorySetting(
  key: ServiceEnvKey,
  selected: string,
  homeDir: string | undefined,
): Result<string, ServiceConfigIssue> {
  const posix = toPosix(selected);

  if (posix === HOME_MARKER || posix.startsWith(HOME_PREFIX)) {
    if (homeDir === undefined) {
      return err(issue(key, REASONS.indeterminableHome));
    }
    return ok(
      normalizePosix(
        posix === HOME_MARKER ? homeDir : joinPosix(homeDir, posix.slice(HOME_PREFIX.length)),
      ),
    );
  }

  return ok(normalizePosix(posix));
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
    return err(issue('DEBUGGEN_PROMPTS_DIR', REASONS.underivablePromptsDir));
  }

  const candidate = toPosix(derived.value);
  const problem = describePathProblem(candidate);
  if (problem !== undefined) {
    return err(
      issue('DEBUGGEN_PROMPTS_DIR', `the derived default directory is invalid: ${problem}`),
    );
  }
  return ok(normalizePosix(candidate));
}

/* -------------------------------------------------------------------------------------------------
 * Issue plumbing shared by the three schemas
 * ---------------------------------------------------------------------------------------------- */

/**
 * The metadata every issue this module's schemas raise carries.
 *
 * A type alias rather than an interface, deliberately: the validation library
 * types an issue's `params` as `Record<string, unknown>`, and only an alias of
 * an object type carries the implicit index signature that makes it assignable
 * there.
 */
type ConfigIssueParams = {
  /** The environment key the rejection is reported against. */
  readonly key: ServiceEnvKey;

  /** A clause from {@link REASONS}, or one built by {@link rangeReason}. */
  readonly reason: string;
};

/** A `custom` issue carrying nothing but this module's own metadata. */
type ConfigIssuePayload = {
  /** Always `'custom'`: the library's own codes carry the library's own messages. */
  readonly code: 'custom';

  /** The reason again, so a raw `ZodError` a developer prints is still readable. */
  readonly message: string;

  /** What {@link toServiceConfigIssues} reads. */
  readonly params: ConfigIssueParams;
};

/**
 * Builds the issue a check inside a schema raises.
 *
 * The reason travels as structured metadata *and* as the message: the metadata
 * is what this module reads back, and the message is a courtesy for anyone
 * printing a raw `ZodError` while debugging. Both are authored here, so neither
 * can carry a value.
 *
 * @param key The environment key to report against.
 * @param reason The clause describing what was wrong.
 * @returns The issue payload to hand to the validation library.
 */
function configIssuePayload(key: ServiceEnvKey, reason: string): ConfigIssuePayload {
  return { code: 'custom', message: reason, params: { key, reason } };
}

/**
 * Reads the metadata this module attached to an issue.
 *
 * Narrowed rather than trusted: `params` is `Record<string, unknown>` by the
 * library's own typing, and an issue raised by something other than a check in
 * this module carries none. That is exactly the case the generic reason exists
 * for.
 *
 * @param params The `params` of a `custom` issue, if it had any.
 * @returns The key and reason this module attached, or `undefined`.
 */
function readIssueParams(
  params: Readonly<Record<string, unknown>> | undefined,
): ConfigIssueParams | undefined {
  const key = params?.['key'];
  const reason = params?.['reason'];

  if (!isServiceEnvKey(key) || typeof reason !== 'string' || reason.length === 0) {
    return undefined;
  }
  return { key, reason };
}

/**
 * Turns the issues one schema reported into this module's own issues.
 *
 * **This is the privacy boundary of the module.** Nothing here reads a message
 * the validation library generated: several of its default messages quote the
 * value they rejected, and a configuration failure is logged, may be persisted
 * with a session and is rendered in two user interfaces. An issue therefore
 * contributes its authored metadata, and an issue without any — one the library
 * raised itself, for an input whose type no compiler could vouch for —
 * contributes the key from its path and a generic reason this module wrote.
 *
 * An issue whose key cannot be determined at all contributes nothing, which
 * only a root-level rejection can produce; {@link loadServiceConfig} handles
 * that case explicitly rather than guessing a key for it.
 *
 * @param zodIssues The issues from a failed parse.
 * @param keyFor Which environment key an issue's leading path segment names.
 * @param genericReason The reason for an issue this module did not author.
 * @returns The issues, unordered; {@link configError} puts them in contract
 * order.
 */
function toServiceConfigIssues(
  zodIssues: readonly z.core.$ZodIssue[],
  keyFor: (segment: unknown) => ServiceEnvKey | undefined,
  genericReason: string,
): ServiceConfigIssue[] {
  const collected: ServiceConfigIssue[] = [];

  for (const zodIssue of zodIssues) {
    const authored = zodIssue.code === 'custom' ? readIssueParams(zodIssue.params) : undefined;
    if (authored !== undefined) {
      collected.push(issue(authored.key, authored.reason));
      continue;
    }

    const key = keyFor(zodIssue.path.at(0));
    if (key !== undefined) {
      collected.push(issue(key, genericReason));
    }
  }

  return collected;
}

/* -------------------------------------------------------------------------------------------------
 * The per-setting schemas
 * ---------------------------------------------------------------------------------------------- */

/**
 * One configured value: trimmed, with a blank treated as absent.
 *
 * The empty-is-absent rule of this module's overview, expressed once and reused
 * by both raw layers so a blank variable and a blank override cannot behave
 * differently.
 */
const settingSchema = z
  .string()
  .optional()
  .transform((value) => normaliseSetting(value));

/**
 * `DEBUGGEN_PROVIDER`, from either channel.
 *
 * Lower-cased before it is asked about, which is the normalisation
 * `@debuggen/model-provider` applies to the same variable: a hand-edited `.env`
 * carrying padding or a capital letter selects the provider it obviously means,
 * and a value that is still not a member is genuinely unrecognised.
 */
const providerSettingSchema = settingSchema.transform((value, ctx) => {
  if (value === undefined) {
    return undefined;
  }

  const candidate = value.toLowerCase();
  if (!isProviderId(candidate)) {
    ctx.addIssue(configIssuePayload('DEBUGGEN_PROVIDER', REASONS.unknownProvider));
    return z.NEVER;
  }
  return candidate;
});

/**
 * `DEBUGGEN_LOG_LEVEL`, from either channel.
 *
 * The override is validated too, despite its type: the service is also started
 * from JavaScript — the bundle inside the editor extension — where the type
 * guarantees nothing.
 */
const logLevelSettingSchema = settingSchema.transform((value, ctx) => {
  if (value === undefined) {
    return undefined;
  }

  const candidate = value.toLowerCase();
  if (!isLogLevelSetting(candidate)) {
    ctx.addIssue(configIssuePayload('DEBUGGEN_LOG_LEVEL', REASONS.unknownLogLevel));
    return z.NEVER;
  }
  return candidate;
});

/**
 * `DEBUGGEN_HOST`, from either channel: one loopback interface.
 *
 * URL brackets are removed rather than refused, because `[::1]` is what a
 * developer copies out of an address bar and is not what a listener binds; the
 * bracket-free form is what reaches {@link ServiceConfig.host}.
 */
const hostSettingSchema = settingSchema.transform((value, ctx) => {
  if (value === undefined) {
    return undefined;
  }

  const problem = describeHostProblem(value);
  if (problem !== undefined) {
    ctx.addIssue(configIssuePayload('DEBUGGEN_HOST', problem));
    return z.NEVER;
  }
  return stripIpv6Brackets(value);
});

/**
 * A directory setting from either channel, validated as far as a value alone
 * allows.
 *
 * The `~` is left in place: expanding it needs a home directory, which is the
 * one part of this contract that depends on something outside the value, so it
 * belongs to the normalisation step rather than to a schema.
 *
 * @param key The key being validated, and the key a rejection names.
 * @returns The schema for that key.
 */
function directorySettingSchema(key: ServiceEnvKey) {
  return settingSchema.transform((value, ctx) => {
    if (value === undefined) {
      return undefined;
    }

    const problem = describeDirectorySettingProblem(value);
    if (problem !== undefined) {
      ctx.addIssue(configIssuePayload(key, problem));
      return z.NEVER;
    }
    return value;
  });
}

/**
 * An integer setting as an environment variable carries it: a string of digits
 * within the setting's range.
 *
 * @param spec The setting's key and bounds.
 * @returns The schema for that setting.
 */
function environmentIntegerSchema(spec: IntegerSettingSpec) {
  return settingSchema.transform((value, ctx) => {
    if (value === undefined) {
      return undefined;
    }

    const parsed = parseIntegerSetting(value);
    if (parsed === undefined) {
      ctx.addIssue(configIssuePayload(spec.key, REASONS.notAnInteger));
      return z.NEVER;
    }
    if (parsed < spec.min || parsed > spec.max) {
      ctx.addIssue(configIssuePayload(spec.key, rangeReason(spec, 'environment')));
      return z.NEVER;
    }
    return parsed;
  });
}

/**
 * An integer setting as a host injects it: a number, validated exactly as
 * firmly as the variable.
 *
 * An override arrives from code rather than from a shell, but that code is a VS
 * Code setting, a command-line flag or a test helper — so a non-integer or
 * out-of-range value is just as reachable, and a service that bound port `-1`
 * because a caller was trusted would fail far from its cause. Its wording says
 * "the injected override" so a developer knows which of the two channels to
 * look at.
 *
 * @param spec The setting's key and bounds.
 * @returns The schema for that setting.
 */
function overrideIntegerSchema(spec: IntegerSettingSpec) {
  return z
    .number()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) {
        return undefined;
      }

      if (!Number.isSafeInteger(value)) {
        ctx.addIssue(configIssuePayload(spec.key, REASONS.overrideNotAnInteger));
        return z.NEVER;
      }
      if (value < spec.min || value > spec.max) {
        ctx.addIssue(configIssuePayload(spec.key, rangeReason(spec, 'override')));
        return z.NEVER;
      }
      return value;
    });
}

/* -------------------------------------------------------------------------------------------------
 * The raw schemas
 * ---------------------------------------------------------------------------------------------- */

/**
 * The nine environment variables, as strings, validated one key at a time.
 *
 * Every key is optional because every key either has a default or is needed
 * only on one path, and a blank value counts as absent — which is load-bearing
 * rather than cosmetic: `.env.example` ships `ANTHROPIC_API_KEY=` and
 * `DEBUGGEN_MODEL=` with no value, and the repository's Vitest projects export
 * `ANTHROPIC_API_KEY: ''`, so a reader that treated `''` as a value would hand
 * the provider a zero-length credential.
 *
 * Unknown keys are ignored rather than rejected: the input is an environment,
 * which carries the whole operating system's variables and the launcher's three
 * child-process ones. What this schema does **not** do is decide anything that
 * needs a second value — the `~` expansion needs a home directory and the
 * credential rule needs the selected provider, so both belong further down.
 *
 * @example
 * ```ts
 * const parsed = serviceEnvSchema.safeParse(process.env);
 * if (parsed.success) {
 *   // parsed.data.DEBUGGEN_PORT is a number or undefined, never a string
 * }
 * ```
 */
export const serviceEnvSchema = z.object({
  ANTHROPIC_API_KEY: settingSchema,
  DEBUGGEN_PROVIDER: providerSettingSchema,
  DEBUGGEN_MODEL: settingSchema,
  DEBUGGEN_HOST: hostSettingSchema,
  DEBUGGEN_PORT: environmentIntegerSchema(PORT_SPEC),
  DEBUGGEN_HOME: directorySettingSchema('DEBUGGEN_HOME'),
  DEBUGGEN_LOG_LEVEL: logLevelSettingSchema,
  DEBUGGEN_RETENTION_DAYS: environmentIntegerSchema(RETENTION_SPEC),
  DEBUGGEN_PROMPTS_DIR: directorySettingSchema('DEBUGGEN_PROMPTS_DIR'),
});

/** The type of {@link serviceEnvSchema}. */
export type ServiceEnvSchema = typeof serviceEnvSchema;

/** What {@link serviceEnvSchema} produces: every setting typed, and optional. */
export type ServiceEnvSettings = z.infer<typeof serviceEnvSchema>;

/**
 * The same settings as a host already decided them.
 *
 * Shape-compatible with {@link ServiceConfigOverrides}, and validated by the
 * same per-setting schemas, so the two channels cannot disagree about what is
 * acceptable. Only the integer settings differ, because they arrive as numbers
 * rather than as strings and their rejections say so.
 *
 * `homeDir` is carried but not validated as a setting: it is the context a `~`
 * expands against rather than a configuration value, and a home directory that
 * cannot be used is reported against the key that needed it —
 * `DEBUGGEN_HOME` or `DEBUGGEN_PROMPTS_DIR` — rather than on its own.
 */
export const serviceConfigOverridesSchema = z.object({
  homeDir: settingSchema,
  debuggenHome: directorySettingSchema('DEBUGGEN_HOME'),
  promptsDir: directorySettingSchema('DEBUGGEN_PROMPTS_DIR'),
  host: hostSettingSchema,
  port: overrideIntegerSchema(PORT_SPEC),
  logLevel: logLevelSettingSchema,
  retentionDays: overrideIntegerSchema(RETENTION_SPEC),
  provider: providerSettingSchema,
  model: settingSchema,
  anthropicApiKey: settingSchema,
});

/** The type of {@link serviceConfigOverridesSchema}. */
export type ServiceConfigOverridesSchema = typeof serviceConfigOverridesSchema;

/** What {@link serviceConfigOverridesSchema} produces. */
export type ServiceOverrideSettings = z.infer<typeof serviceConfigOverridesSchema>;

/** What one override field is to the environment contract. */
interface OverrideFieldDescriptor {
  /** The environment key a rejection of this field is reported against. */
  readonly key: ServiceEnvKey;

  /**
   * Whether a value in this field means the variable is not read at all.
   *
   * True for every setting, and false for `homeDir`: that field is the context
   * a `~` expands against rather than a value for `DEBUGGEN_HOME`, so injecting
   * one must not stop the variable from being read.
   */
  readonly supersedes: boolean;
}

/**
 * What each override field is: the key it reports against, and whether it
 * supersedes that key's variable.
 *
 * Total over {@link ServiceConfigOverrides}, so a field added to that interface
 * stops this file compiling until both questions are answered for it.
 */
const OVERRIDE_FIELDS: Readonly<Record<keyof ServiceConfigOverrides, OverrideFieldDescriptor>> =
  Object.freeze({
    homeDir: Object.freeze({ key: 'DEBUGGEN_HOME', supersedes: false }),
    debuggenHome: Object.freeze({ key: 'DEBUGGEN_HOME', supersedes: true }),
    promptsDir: Object.freeze({ key: 'DEBUGGEN_PROMPTS_DIR', supersedes: true }),
    host: Object.freeze({ key: 'DEBUGGEN_HOST', supersedes: true }),
    port: Object.freeze({ key: 'DEBUGGEN_PORT', supersedes: true }),
    logLevel: Object.freeze({ key: 'DEBUGGEN_LOG_LEVEL', supersedes: true }),
    retentionDays: Object.freeze({ key: 'DEBUGGEN_RETENTION_DAYS', supersedes: true }),
    provider: Object.freeze({ key: 'DEBUGGEN_PROVIDER', supersedes: true }),
    model: Object.freeze({ key: 'DEBUGGEN_MODEL', supersedes: true }),
    anthropicApiKey: Object.freeze({ key: 'ANTHROPIC_API_KEY', supersedes: true }),
  });

/** The override field names, for the supersession pass and for issue mapping. */
const OVERRIDE_FIELD_NAMES = Object.keys(
  OVERRIDE_FIELDS,
) as readonly (keyof ServiceConfigOverrides)[];

/**
 * Whether a string is one of the override field names.
 *
 * @param value Any string.
 * @returns `true` when `value` is a field of {@link ServiceConfigOverrides}.
 */
function isOverrideField(value: string): value is keyof ServiceConfigOverrides {
  return Object.hasOwn(OVERRIDE_FIELDS, value);
}

/**
 * The environment key an override field name names, or `undefined` when the
 * segment is not one of the fields.
 *
 * Only consulted for an issue this module did not author — an override whose
 * type no compiler could vouch for, a `port` that arrived as a string from
 * JavaScript — so that such a rejection still names the variable a developer
 * would set rather than the field name of an internal type.
 *
 * @param segment The leading path segment of an issue.
 * @returns The key to report against, or `undefined`.
 */
function overrideFieldKey(segment: unknown): ServiceEnvKey | undefined {
  if (typeof segment !== 'string' || !isOverrideField(segment)) {
    return undefined;
  }
  return OVERRIDE_FIELDS[segment].key;
}

/**
 * The environment key an environment-schema path segment names.
 *
 * The identity, narrowed: the raw schema is keyed by the variable names
 * themselves, so an issue's path already carries the key to report.
 *
 * @param segment The leading path segment of an issue.
 * @returns The key to report against, or `undefined`.
 */
function environmentFieldKey(segment: unknown): ServiceEnvKey | undefined {
  return isServiceEnvKey(segment) ? segment : undefined;
}

/* -------------------------------------------------------------------------------------------------
 * The resolved schema
 * ---------------------------------------------------------------------------------------------- */

/**
 * A resolved path: absolute, normalised POSIX, in the one spelling every
 * consumer of {@link ServiceConfig} expects.
 *
 * The invariant four subsystems depend on without re-deriving it — the store
 * opens `databasePath`, the patcher and cleanup write under `backupsDir`, the
 * retention sweep purges `indexCacheDir`, and the credential writer owns
 * `authFilePath` — so it is stated here as a schema rather than left implicit
 * in whichever function happened to build the value.
 *
 * @param key The key a rejection is reported against.
 * @returns The schema for one resolved path.
 */
function resolvedPathSchema(key: ServiceEnvKey) {
  return z.string().transform((value, ctx) => {
    if (describePathProblem(value) !== undefined || normalizePosix(value) !== value) {
      ctx.addIssue(configIssuePayload(key, REASONS.unnormalisedPath));
      return z.NEVER;
    }
    return value;
  });
}

/**
 * A value carried only when something configured it: present and non-blank, or
 * absent.
 *
 * Absent rather than `undefined`, which the repository's
 * `exactOptionalPropertyTypes` distinguishes and which
 * {@link toModelProviderOverrides} relies on: an omitted model means "nothing
 * configured one", while a present `undefined` would be a model that was
 * configured as nothing.
 *
 * @param key The key a rejection is reported against.
 * @returns The schema for one optional resolved value.
 */
function resolvedOptionalValueSchema(key: ServiceEnvKey) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) {
        return undefined;
      }
      if (normaliseSetting(value) !== value) {
        ctx.addIssue(configIssuePayload(key, REASONS.unnormalisedValue));
        return z.NEVER;
      }
      return value;
    });
}

/**
 * A whole resolved configuration, and the last word on whether the service can
 * start.
 *
 * Everything a subsystem is entitled to assume about {@link ServiceConfig},
 * stated once and checked once:
 *
 * - the bind is a loopback interface, which is the product's access boundary
 *   (AAP 0.5.6) and the assumption the authentication and Origin rules rest on;
 * - the port is in range, with {@link EPHEMERAL_PORT} meaning "let the system
 *   choose";
 * - the log threshold and the provider are members of their closed
 *   vocabularies;
 * - the retention window is a whole number of days, `0` meaning "purge
 *   everything eligible";
 * - every path is absolute and normalised, and the four derived paths sit
 *   directly under the state root with the names the rest of the product
 *   expects;
 * - the selected provider has the settings {@link PROVIDER_REQUIREMENTS} says
 *   it needs, so a network-backed selection without a model or a credential
 *   fails at start-up naming the missing key instead of failing mid-session.
 *
 * Reachable on its own, not only through {@link loadServiceConfig}: a
 * configuration assembled by a host, read back from a record or handed across a
 * boundary can be validated against exactly the same contract.
 */
export const resolvedServiceConfigSchema = z
  .object({
    host: z.string().transform((value, ctx) => {
      const problem = describeHostProblem(value);
      if (problem !== undefined) {
        ctx.addIssue(configIssuePayload('DEBUGGEN_HOST', problem));
        return z.NEVER;
      }
      return value;
    }),
    port: z.number().transform((value, ctx) => {
      if (!Number.isSafeInteger(value) || value < PORT_SPEC.min || value > PORT_SPEC.max) {
        ctx.addIssue(configIssuePayload(PORT_SPEC.key, rangeReason(PORT_SPEC, 'environment')));
        return z.NEVER;
      }
      return value;
    }),
    logLevel: z.string().transform((value, ctx): LogLevelSetting => {
      if (!isLogLevelSetting(value)) {
        ctx.addIssue(configIssuePayload('DEBUGGEN_LOG_LEVEL', REASONS.unknownLogLevel));
        return z.NEVER;
      }
      return value;
    }),
    retentionDays: z.number().transform((value, ctx) => {
      if (
        !Number.isSafeInteger(value) ||
        value < RETENTION_SPEC.min ||
        value > RETENTION_SPEC.max
      ) {
        ctx.addIssue(
          configIssuePayload(RETENTION_SPEC.key, rangeReason(RETENTION_SPEC, 'environment')),
        );
        return z.NEVER;
      }
      return value;
    }),
    provider: z.string().transform((value, ctx): ProviderId => {
      if (!isProviderId(value)) {
        ctx.addIssue(configIssuePayload('DEBUGGEN_PROVIDER', REASONS.unknownProvider));
        return z.NEVER;
      }
      return value;
    }),
    model: resolvedOptionalValueSchema('DEBUGGEN_MODEL'),
    anthropicApiKey: resolvedOptionalValueSchema('ANTHROPIC_API_KEY'),
    debuggenHome: resolvedPathSchema('DEBUGGEN_HOME'),
    databasePath: resolvedPathSchema('DEBUGGEN_HOME'),
    backupsDir: resolvedPathSchema('DEBUGGEN_HOME'),
    indexCacheDir: resolvedPathSchema('DEBUGGEN_HOME'),
    authFilePath: resolvedPathSchema('DEBUGGEN_HOME'),
    promptsDir: resolvedPathSchema('DEBUGGEN_PROMPTS_DIR'),
  })
  .superRefine((config, ctx) => {
    // Runs only once every field above validated, which is the library's
    // default and the right one here: a field-level rejection means the
    // candidate was assembled wrongly, and a cross-field clause about values
    // that are not there yet would not help anyone. Both checks are still
    // written defensively, because this schema is reachable from callers whose
    // input no compiler vouched for.
    const derived: readonly [string, string][] = [
      [config.databasePath, SESSIONS_DATABASE_FILE_NAME],
      [config.backupsDir, BACKUPS_DIRECTORY_NAME],
      [config.indexCacheDir, INDEX_CACHE_DIRECTORY_NAME],
      [config.authFilePath, AUTH_FILE_NAME],
    ];

    if (derived.some(([path, name]) => path !== joinPosix(config.debuggenHome, name))) {
      ctx.addIssue({
        ...configIssuePayload('DEBUGGEN_HOME', REASONS.derivedPathsDisagree),
        path: ['DEBUGGEN_HOME'],
      });
    }

    // The credential rule, and the reason this validation happens at start-up:
    // a provider that reaches the network needs both a model and a credential,
    // and the alternative to naming the missing key here is a session that
    // fails after the question, after the code index and after the
    // instrumentation plan.
    const requirements = isProviderId(config.provider)
      ? PROVIDER_REQUIREMENTS[config.provider]
      : [];

    for (const key of requirements) {
      const rule = PROVIDER_REQUIREMENT_RULES[key];
      if (!rule.isConfigured(config)) {
        ctx.addIssue({ ...configIssuePayload(key, rule.reason), path: [key] });
      }
    }
  });

/** The type of {@link resolvedServiceConfigSchema}. */
export type ResolvedServiceConfigSchema = typeof resolvedServiceConfigSchema;

/* -------------------------------------------------------------------------------------------------
 * Loading
 * ---------------------------------------------------------------------------------------------- */

/**
 * The failure for an environment that was not a record of values at all.
 *
 * Unreachable from TypeScript — the parameter type says otherwise — and
 * reachable from JavaScript, which is what the bundled service inside the
 * editor extension ultimately is. It has no key to report against, so it is the
 * one failure this module builds without one, and it still carries the same
 * `details` shape every other failure does so a log consumer needs no special
 * case.
 */

/**
 * A record with the named keys treated as unset.
 *
 * Used for the two things per-setting precedence needs. The first is
 * supersession: a variable an override replaces is **not read**, so a stale
 * `DEBUGGEN_PORT` in a shell cannot make a service unstartable when the host
 * has already decided the port — which is what "precedence per setting" means,
 * and what it meant before the contract became three schemas. The second is
 * recovery: a rejected setting is blanked and the channel parsed again, so
 * every *other* setting still resolves and the rules that need more than one
 * value can report alongside the rejection instead of after it. The rejected
 * setting has already been recorded by then, and a substituted default is never
 * returned to a caller — a non-empty issue list is.
 *
 * @param source The record to copy.
 * @param keys The keys to blank.
 * @returns A copy with those keys `undefined`.
 */
function withoutKeys(
  source: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  for (const key of keys) {
    copy[key] = undefined;
  }
  return copy;
}

/**
 * The leading path segments of a failed parse, which name the fields to blank.
 *
 * @param zodIssues The issues from a failed parse.
 * @returns The distinct string segments, in the order they were reported.
 */
function rejectedFields(zodIssues: readonly z.core.$ZodIssue[]): readonly string[] {
  const names = zodIssues
    .map((zodIssue) => zodIssue.path.at(0))
    .filter((segment): segment is string => typeof segment === 'string');

  return [...new Set(names)];
}

/**
 * The failure for an environment that was not a record of values at all.
 *
 * @returns The `CONFIG_INVALID` error to return inside an `Err`.
 */
function environmentShapeError(): DebuggenError {
  return new DebuggenError(
    CONFIG_CODE,
    'The local service configuration is invalid: the environment was not a record of values.',
    {
      hint:
        'Pass the environment to loadServiceConfig as a record of string values, for instance ' +
        'process.env after dotenv has populated it.',
      details: { subsystem: SUBSYSTEM, keys: [], issues: [] },
    },
  );
}

/**
 * Merges the two validated channels, expands `~` and derives the five
 * `$DEBUGGEN_HOME` paths.
 *
 * The deterministic step between {@link serviceEnvSchema} and
 * {@link resolvedServiceConfigSchema}: precedence per setting rather than per
 * object — a host that overrides only the port still has every other variable
 * read for it — the defaults, and the paths every subsystem reads instead of
 * joining for itself.
 *
 * It decides nothing about acceptability. The only failure it can report is one
 * that needs the expansion context rather than the value: a `~`-prefixed
 * directory on a system whose home directory could not be determined.
 *
 * @param env The settings {@link serviceEnvSchema} produced.
 * @param overrides The settings {@link serviceConfigOverridesSchema} produced.
 * @returns The candidate configuration and any issue the expansion raised. The
 * candidate is still unvalidated; {@link resolvedServiceConfigSchema} has the
 * last word.
 */
function normaliseServiceSettings(
  env: ServiceEnvSettings,
  overrides: ServiceOverrideSettings,
): {
  readonly candidate: Readonly<Record<string, unknown>>;
  readonly issues: ServiceConfigIssue[];
} {
  const issues: ServiceConfigIssue[] = [];
  const homeDir = resolveHomeDirectory(overrides.homeDir);

  const model = overrides.model ?? env.DEBUGGEN_MODEL;
  const anthropicApiKey = overrides.anthropicApiKey ?? env.ANTHROPIC_API_KEY;

  const homeResult = expandDirectorySetting(
    'DEBUGGEN_HOME',
    overrides.debuggenHome ?? env.DEBUGGEN_HOME ?? DEFAULT_DEBUGGEN_HOME,
    homeDir,
  );
  const debuggenHome = isErr(homeResult) ? '' : homeResult.value;
  if (isErr(homeResult)) {
    issues.push(homeResult.error);
  }

  const configuredPrompts = overrides.promptsDir ?? env.DEBUGGEN_PROMPTS_DIR;
  const promptsResult =
    configuredPrompts === undefined
      ? resolveDefaultPromptsDirectory()
      : expandDirectorySetting('DEBUGGEN_PROMPTS_DIR', configuredPrompts, homeDir);
  const promptsDir = isErr(promptsResult) ? '' : promptsResult.value;
  if (isErr(promptsResult)) {
    issues.push(promptsResult.error);
  }

  return {
    candidate: {
      host: overrides.host ?? env.DEBUGGEN_HOST ?? DEFAULT_HOST,
      port: overrides.port ?? env.DEBUGGEN_PORT ?? DEFAULT_PORT,
      logLevel: overrides.logLevel ?? env.DEBUGGEN_LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
      retentionDays:
        overrides.retentionDays ?? env.DEBUGGEN_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS,
      provider: overrides.provider ?? env.DEBUGGEN_PROVIDER ?? DEFAULT_PROVIDER_ID,
      // Spread rather than assigned, so an unconfigured model or credential is
      // absent from the resolved configuration instead of present as
      // `undefined` — the distinction `exactOptionalPropertyTypes` keeps and
      // `toModelProviderOverrides` reads.
      ...(model === undefined ? {} : { model }),
      ...(anthropicApiKey === undefined ? {} : { anthropicApiKey }),
      debuggenHome,
      databasePath: joinPosix(debuggenHome, SESSIONS_DATABASE_FILE_NAME),
      backupsDir: joinPosix(debuggenHome, BACKUPS_DIRECTORY_NAME),
      indexCacheDir: joinPosix(debuggenHome, INDEX_CACHE_DIRECTORY_NAME),
      authFilePath: joinPosix(debuggenHome, AUTH_FILE_NAME),
      promptsDir,
    },
    issues,
  };
}

/**
 * Reads, validates and resolves the whole configuration surface.
 *
 * The one entry point of this module, and the composition of the three schemas
 * with the normalisation between them:
 *
 * 1. {@link serviceEnvSchema} validates the nine variables,
 *    {@link serviceConfigOverridesSchema} the host's own values, and **both are
 *    parsed before anything is reported**, so the returned failure carries
 *    every problem rather than the first one — a developer editing a `.env`
 *    file fixes it once instead of once per start-up attempt.
 * 2. {@link normaliseServiceSettings} merges them per setting, expands `~`
 *    against the injectable home directory, applies the defaults and derives
 *    the five `$DEBUGGEN_HOME` paths. This is why no other module joins them:
 *    `sessions.sqlite`, `backups/`, `index/` and `auth.json` have one spelling,
 *    and the store, the patcher, the retention sweep and the credential writer
 *    all read it from here.
 * 3. {@link resolvedServiceConfigSchema} has the last word on the result,
 *    including the two rules that need more than one value: the loopback bind
 *    and the settings the selected provider requires.
 *
 * `env` is **required and injected**: nothing here reads `process.env`, so
 * `src/main.ts` passes it in after `dotenv` has populated it, a suite passes a
 * literal, and the two paths are the same code.
 *
 * Pure: it creates no directory, opens no file and starts nothing.
 * `src/main.ts` creates the state root `0700` from
 * {@link ServiceConfig.debuggenHome} after this returns. The result is frozen,
 * so a subsystem cannot retune shared configuration by assigning to it.
 * Whether {@link ServiceConfig.promptsDir} exists is deliberately not asked
 * here: {@link verifyPromptsDirectory} is that separate, read-only question,
 * and `src/main.ts` asks it next, before anything touches disk.
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
  if (typeof env !== 'object' || env === null) {
    return err(environmentShapeError());
  }

  // The host's own values are parsed first, because they decide which
  // variables are read at all. A rejected field is recorded and then blanked
  // for a second parse, so one bad override does not stop every other setting
  // from resolving — and the copy means nothing here reaches the caller's own
  // object.
  const overridesInput: Readonly<Record<string, unknown>> = { ...overrides };
  const firstOverridePass = serviceConfigOverridesSchema.safeParse(overridesInput);
  const overrideIssues = firstOverridePass.success
    ? []
    : toServiceConfigIssues(
        firstOverridePass.error.issues,
        overrideFieldKey,
        REASONS.unexpectedOverrideType,
      );
  const overridePass = firstOverridePass.success
    ? firstOverridePass
    : serviceConfigOverridesSchema.safeParse(
        withoutKeys(overridesInput, rejectedFields(firstOverridePass.error.issues)),
      );

  // Per-setting precedence: a variable an override supersedes is not read, so
  // a stale one cannot make the service unstartable — and cannot be rejected.
  const superseded = overridePass.success
    ? OVERRIDE_FIELD_NAMES.filter(
        (field) => OVERRIDE_FIELDS[field].supersedes && overridePass.data[field] !== undefined,
      ).map((field) => OVERRIDE_FIELDS[field].key)
    : [];
  const effectiveEnv = withoutKeys(env, superseded);

  const firstEnvPass = serviceEnvSchema.safeParse(effectiveEnv);
  const envIssues = firstEnvPass.success
    ? []
    : toServiceConfigIssues(firstEnvPass.error.issues, environmentFieldKey, REASONS.unexpectedType);
  const envPass = firstEnvPass.success
    ? firstEnvPass
    : serviceEnvSchema.safeParse(
        withoutKeys(effectiveEnv, rejectedFields(firstEnvPass.error.issues)),
      );

  if (!envPass.success || !overridePass.success) {
    // Every rejected setting has been blanked by now, so a parse that still
    // fails did so for a reason with no key to name.
    const rawIssues = [...envIssues, ...overrideIssues];
    return err(rawIssues.length > 0 ? configError(rawIssues) : environmentShapeError());
  }

  const normalised = normaliseServiceSettings(envPass.data, overridePass.data);
  const resolved = resolvedServiceConfigSchema.safeParse(normalised.candidate);

  // A key already reported is not reported twice: a rejected setting stood
  // down to its default for this pass, and an unexpandable `~` left its
  // setting empty, either of which the resolved schema would object to a
  // second time — and a developer reading two clauses about one variable
  // learns nothing from the second.
  const alreadyReported = new Set(
    [...envIssues, ...overrideIssues, ...normalised.issues].map((entry) => entry.key),
  );
  const resolvedIssues = resolved.success
    ? []
    : toServiceConfigIssues(
        resolved.error.issues,
        environmentFieldKey,
        REASONS.unnormalisedPath,
      ).filter((entry) => !alreadyReported.has(entry.key));

  const issues = [...envIssues, ...overrideIssues, ...normalised.issues, ...resolvedIssues];
  if (issues.length > 0) {
    return err(configError(issues));
  }
  if (!resolved.success) {
    return err(environmentShapeError());
  }

  // Reassembled with the two optional members spread in only when they have a
  // value: the validated object already omits an unconfigured one at run time,
  // and the spread is what carries that fact into the type, which
  // `exactOptionalPropertyTypes` distinguishes and `toModelProviderOverrides`
  // reads. Frozen because every subsystem shares this object: a value read at
  // start-up is the value in force at the end of the session.
  const { model, anthropicApiKey, ...rest } = resolved.data;

  return ok(
    Object.freeze({
      ...rest,
      ...(model === undefined ? {} : { model }),
      ...(anthropicApiKey === undefined ? {} : { anthropicApiKey }),
    }),
  );
}

/* -------------------------------------------------------------------------------------------------
 * The contract, as data
 * ---------------------------------------------------------------------------------------------- */

/**
 * The environment contract in machine-readable form, with the three schemas
 * that enforce it and {@link loadServiceConfig} as its `safeParse`.
 *
 * Frozen, and every descriptor with it: this object is shared by the
 * documentation checks and by anything that enumerates the surface, and a
 * mutation would make one reader disagree with the loader.
 *
 * The descriptors describe; they do not validate. Validation lives in
 * {@link serviceEnvSchema}, {@link serviceConfigOverridesSchema} and
 * {@link resolvedServiceConfigSchema}, which are reachable here as `env`,
 * `overrides` and `resolved` as well as under their own exported names — one
 * object for a reader who wants the whole contract, and direct exports for a
 * caller who wants one schema.
 */
export const serviceConfigSchema: ServiceConfigSchema = Object.freeze({
  keys: SERVICE_ENV_KEYS,
  env: serviceEnvSchema,
  overrides: serviceConfigOverridesSchema,
  resolved: resolvedServiceConfigSchema,
  entries: Object.freeze({
    ANTHROPIC_API_KEY: Object.freeze({
      key: 'ANTHROPIC_API_KEY',
      kind: 'credential',
      secret: true,
      description:
        'Credential for the network-backed model provider. Required when that provider is selected, and validated here at start-up so a missing one is named before a session begins; @debuggen/model-provider enforces the same rule when it constructs the provider.',
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
        'The model id a session calls. Never defaulted anywhere in the product: a session records the model it used, and a substituted default would make that record untrue. Required alongside the credential when a network-backed provider is selected.',
    }),
    DEBUGGEN_HOST: Object.freeze({
      key: 'DEBUGGEN_HOST',
      kind: 'string',
      secret: false,
      defaultValue: DEFAULT_HOST,
      description:
        'The interface the HTTP and WebSocket surfaces bind. A loopback interface only - the name localhost, any address in 127.0.0.0/8, or the IPv6 loopback address - because reachability from this machine alone is the access boundary the authentication and Origin rules rest on.',
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
        'The state root holding the session database, the editor credential, the pre-patch file backups and the code-index cache. It must lie outside every project Debug Generator works on, so a session never appears in a working tree: a project that contains it, or lies inside it, is refused, and so is one whose location on disk cannot be resolved.',
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
        'The versioned prompt directory. Set by the editor extension for the service it bundles; otherwise derived from the service module location. It must exist and hold manifest.json when the service starts, which is checked before anything is written to disk.',
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
 * Transport, not decision — but transport of values already known to be
 * usable. Whether a selection is usable is settled twice, on purpose: by
 * {@link resolvedServiceConfigSchema} at start-up, against
 * {@link PROVIDER_REQUIREMENTS}, so a missing model or credential is named
 * before a session begins; and again by that package's
 * `resolveProviderConfig` / `createModelProvider`, which own the same rule for
 * hosts that assemble a configuration without this module. This function
 * exists so that `src/main.ts` can hand them the values this module already
 * validated instead of letting them read the environment a second time, which
 * is what would let the two readings disagree.
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

/* -------------------------------------------------------------------------------------------------
 * The state root stays outside every project
 * ---------------------------------------------------------------------------------------------- */

/**
 * How a project root and the state root overlap, recorded in a refusal's
 * `details.relation`. The paths themselves are never recorded.
 *
 * - `same-directory` — the project root is the state root.
 * - `home-inside-project` — the state root lies beneath the project root, so
 *   the store, the editor credential and every backup are in its working tree.
 * - `project-inside-home` — the project lies beneath the state root, so the
 *   project's files and the service's private state share one tree.
 */
export type StateHomeOverlap = 'same-directory' | 'home-inside-project' | 'project-inside-home';

/** The `details.reason` of the refusal of a project root that overlaps the state root. */
export const STATE_HOME_OVERLAP_REASON = 'state-home-overlaps-project';

/**
 * The `details.reason` of the refusal of a project root whose canonical
 * location could not be established, so no overlap check could be made.
 */
export const PROJECT_ROOT_UNRESOLVABLE_REASON = 'project-root-unresolvable';

/** The `details.reason` of a path {@link canonicalizePath} could not resolve. */
export const PATH_UNRESOLVABLE_REASON = 'path-unresolvable';

/**
 * The message of an overlap refusal: a constant, self-contained instruction,
 * because an HTTP error body carries a message and no hint.
 */
export const STATE_HOME_OVERLAP_MESSAGE =
  'Debug Generator will not work on a project that contains its state directory or lies inside it: set DEBUGGEN_HOME to a directory outside the project and restart the service.';

/** The recovery instruction of an overlap refusal, for surfaces that show a hint. */
export const STATE_HOME_OVERLAP_HINT =
  'Session data, file backups and the editor credential live in DEBUGGEN_HOME (default ~/.debuggen) and must stay outside every project so they never reach its working tree. Set DEBUGGEN_HOME outside the project, or open a project that is not inside DEBUGGEN_HOME, then restart the service.';

/** The message of the refusal of a project root whose canonical location is unknown. */
export const PROJECT_ROOT_UNRESOLVABLE_MESSAGE =
  'Debug Generator could not resolve the project folder on disk, so it cannot confirm that the folder and its state directory (DEBUGGEN_HOME) are kept apart.';

/** The recovery instruction of that refusal. */
export const PROJECT_ROOT_UNRESOLVABLE_HINT =
  'Check that the project folder and every folder above it are readable by this account and that no symbolic link on the way loops, then try again.';

/** The message of a path {@link canonicalizePath} could not resolve. */
const PATH_UNRESOLVABLE_MESSAGE = 'A path could not be resolved to its location on disk.';

/** The recovery instruction of that failure. */
const PATH_UNRESOLVABLE_HINT =
  'Check that the path and every directory above it are readable by this account and that no symbolic link on the way loops.';

/**
 * The `errno` codes that mean "this component does not exist (as a
 * directory)", after which the next ancestor is resolved instead.
 */
const MISSING_PATH_ERRNO_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/** The shape of an `errno` code: kept in `details` only when it matches. */
const ERRNO_CODE_PATTERN = /^E[A-Z0-9]{1,31}$/;

/**
 * Resolves a path to its canonical absolute location, as `fs.realpath` would.
 * Injectable so the resolution is testable without the host's filesystem.
 */
export type RealpathResolver = (path: string) => Promise<string>;

/** Options of {@link canonicalizePath} and {@link requireProjectOutsideStateHome}. */
export interface CanonicalPathOptions {
  /** The resolver; defaults to `fs.promises.realpath`. */
  readonly realpath?: RealpathResolver | undefined;
}

/** The `errno` code of a thrown filesystem error, when it has the expected shape. */
function errnoCodeOf(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
    return undefined;
  }
  const { code } = cause;
  return typeof code === 'string' && ERRNO_CODE_PATTERN.test(code) ? code : undefined;
}

/** Whether a path is absolute in either spelling the product accepts. */
function isAbsolutePath(path: string): boolean {
  return isAbsolutePosix(path) || isWindowsAbsolute(path);
}

/**
 * Whether two **canonical** absolute paths overlap: they name the same
 * directory, or one lies beneath the other.
 *
 * Pure string logic over whole path segments (`@debuggen/shared`'s
 * `isWithin`), so `/work/shop` and `/work/shop-state` do not overlap while
 * `/work/shop` and `/work/shop/.state` do. It sees no symbolic link: callers
 * compare the results of {@link canonicalizePath}. A relative argument never
 * overlaps an absolute one.
 *
 * @param left A canonical absolute path.
 * @param right Another canonical absolute path.
 * @returns `true` when either path is, or lies beneath, the other.
 *
 * @example
 * ```ts
 * pathsOverlap('/work/shop', '/work/shop/.debuggen'); // true
 * pathsOverlap('/work/shop', '/work/shop-state'); // false
 * ```
 */
export function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

/**
 * How a canonical project root overlaps the canonical state root, if it does.
 * Pure; the same segment-wise comparison as {@link pathsOverlap}.
 *
 * @param stateHome The canonical state root.
 * @param projectRoot The canonical project root.
 * @returns The relation, or `undefined` when the two are apart.
 */
export function stateHomeOverlap(
  stateHome: string,
  projectRoot: string,
): StateHomeOverlap | undefined {
  const homeInsideProject = isWithin(projectRoot, stateHome);
  const projectInsideHome = isWithin(stateHome, projectRoot);
  if (homeInsideProject && projectInsideHome) {
    return 'same-directory';
  }
  if (homeInsideProject) {
    return 'home-inside-project';
  }
  return projectInsideHome ? 'project-inside-home' : undefined;
}

/**
 * The refusal of a project root that overlaps the state root: code
 * `FS_UNSAFE_PATH` (answered `400`), the constant
 * {@link STATE_HOME_OVERLAP_MESSAGE} and {@link STATE_HOME_OVERLAP_HINT}, and
 * `details` naming the reason and the relation — never a path.
 *
 * @param relation How the two overlap.
 * @returns The error.
 */
export function stateHomeOverlapError(relation: StateHomeOverlap): DebuggenError {
  return new DebuggenError('FS_UNSAFE_PATH', STATE_HOME_OVERLAP_MESSAGE, {
    hint: STATE_HOME_OVERLAP_HINT,
    details: { subsystem: SUBSYSTEM, reason: STATE_HOME_OVERLAP_REASON, relation },
  });
}

/**
 * Resolves `path` to its canonical absolute location: every symbolic link
 * resolved, `.` and repeated separators removed, normalised POSIX.
 *
 * A path that does not exist yet — a project folder about to be created, a
 * stored session's project that was deleted — is resolved through its
 * **nearest existing ancestor**: that ancestor is `realpath`ed and the
 * missing components are re-appended unchanged, so a link anywhere in the
 * existing part is still seen. Only "does not exist" (`ENOENT`) and "is not a
 * directory" (`ENOTDIR`) move to the parent; any other failure — permission
 * denied, a link loop — is returned, because an unresolved path cannot be
 * compared safely.
 *
 * This and {@link verifyPromptsDirectory} are the only filesystem access in
 * this module, and both only read: `realpath` follows links and stats
 * components, it creates and opens nothing.
 *
 * @param path An absolute path, POSIX or Windows spelling.
 * @param options The resolver to use instead of `fs.promises.realpath`.
 * @returns The canonical path, or an `FS_UNSAFE_PATH` error
 *   ({@link PATH_UNRESOLVABLE_REASON}) whose message and details name no path.
 *
 * @example
 * ```ts
 * // /work/app is a link to /data/app, and /data/app/new does not exist yet
 * await canonicalizePath('/work/app/new'); // ok('/data/app/new')
 * ```
 */
export async function canonicalizePath(
  path: string,
  options: CanonicalPathOptions = {},
): Promise<Result<string, DebuggenError>> {
  const resolve = options.realpath ?? realpath;
  const normalized = typeof path === 'string' ? normalizePosix(toPosix(path)) : '';
  if (!isAbsolutePath(normalized)) {
    return err(pathUnresolvable('not-absolute', undefined));
  }

  // The components below `current` that did not exist, innermost last.
  const missing: string[] = [];
  let current = normalized;
  for (;;) {
    let resolved: string;
    try {
      resolved = await resolve(current);
    } catch (cause) {
      const errno = errnoCodeOf(cause);
      const parent = dirnamePosix(current);
      if (
        errno === undefined ||
        !MISSING_PATH_ERRNO_CODES.has(errno) ||
        parent === current ||
        !isAbsolutePath(parent)
      ) {
        return err(pathUnresolvable('realpath-failed', errno));
      }
      missing.unshift(basenamePosix(current));
      current = parent;
      continue;
    }
    const canonical = normalizePosix(toPosix(resolved));
    if (!isAbsolutePath(canonical)) {
      return err(pathUnresolvable('resolved-not-absolute', undefined));
    }
    return ok(missing.length === 0 ? canonical : joinPosix(canonical, ...missing));
  }
}

/**
 * The failure of {@link canonicalizePath}. Constant text; `details` carry the
 * stage and the `errno` code only, never the path or the thrown message.
 */
function pathUnresolvable(stage: string, errno: string | undefined): DebuggenError {
  return new DebuggenError('FS_UNSAFE_PATH', PATH_UNRESOLVABLE_MESSAGE, {
    hint: PATH_UNRESOLVABLE_HINT,
    details: {
      subsystem: SUBSYSTEM,
      reason: PATH_UNRESOLVABLE_REASON,
      stage,
      ...(errno === undefined ? {} : { errno }),
    },
  });
}

/**
 * Refuses a project root that overlaps the state root, because session data
 * and backups live outside every target project.
 *
 * The project root is canonicalised with {@link canonicalizePath} — so a
 * project reached through a symbolic link into the state root is refused, and
 * one that does not exist yet is judged by its nearest existing ancestor — and
 * compared with `canonicalStateHome` by {@link stateHomeOverlap}.
 * Fails closed: a root whose canonical location cannot be established is
 * refused as well, because it could not be shown to be apart.
 *
 * @param canonicalStateHome The state root as {@link canonicalizePath}
 *   resolved it — `src/main.ts` resolves it once, after creating it.
 * @param projectRoot The absolute project root a request or a stored session
 *   names.
 * @param options The resolver to use instead of `fs.promises.realpath`.
 * @returns The canonical project root; or an `FS_UNSAFE_PATH` error with
 *   `details.reason` {@link STATE_HOME_OVERLAP_REASON} (and the
 *   {@link StateHomeOverlap} relation) or
 *   {@link PROJECT_ROOT_UNRESOLVABLE_REASON}. Every message and hint is a
 *   constant sentence naming no path.
 *
 * @example
 * ```ts
 * const home = unwrap(await canonicalizePath(config.debuggenHome));
 * await requireProjectOutsideStateHome(home, '/work/shop'); // ok('/work/shop')
 * await requireProjectOutsideStateHome('/work/shop/.state', '/work/shop'); // err: home-inside-project
 * ```
 */
export async function requireProjectOutsideStateHome(
  canonicalStateHome: string,
  projectRoot: string,
  options: CanonicalPathOptions = {},
): Promise<Result<string, DebuggenError>> {
  const canonical = await canonicalizePath(projectRoot, options);
  if (isErr(canonical)) {
    const errno = canonical.error.details?.['errno'];
    return err(
      new DebuggenError('FS_UNSAFE_PATH', PROJECT_ROOT_UNRESOLVABLE_MESSAGE, {
        hint: PROJECT_ROOT_UNRESOLVABLE_HINT,
        details: {
          subsystem: SUBSYSTEM,
          reason: PROJECT_ROOT_UNRESOLVABLE_REASON,
          ...(typeof errno === 'string' ? { errno } : {}),
        },
      }),
    );
  }
  const relation = stateHomeOverlap(normalizePosix(canonicalStateHome), canonical.value);
  return relation === undefined ? ok(canonical.value) : err(stateHomeOverlapError(relation));
}

/* -------------------------------------------------------------------------------------------------
 * The prompt directory is present before anything touches disk
 * ---------------------------------------------------------------------------------------------- */

/**
 * The prompt manifest's file name, directly inside
 * {@link ServiceConfig.promptsDir}.
 *
 * This is the name `@debuggen/model-provider`'s prompt loader reads and
 * documents. That package keeps its own constant module-private, so the name
 * is restated here, and the colocated suite checks that the loader's
 * `manifestPath` ends in it.
 */
export const PROMPTS_MANIFEST_FILE_NAME = 'manifest.json';

/** What {@link verifyPromptsDirectory} needs to know about one entry on disk. */
export interface PromptsEntryStats {
  /** Whether the entry, symbolic links followed, is a directory. */
  isDirectory(): boolean;

  /** Whether the entry, symbolic links followed, is a regular file. */
  isFile(): boolean;
}

/**
 * Stats a path, following symbolic links, the way
 * `fs.statSync(path, { throwIfNoEntry: false })` does. It returns `undefined`
 * when nothing is there, and throws for every other failure. Injectable so the
 * failure branches can be tested on a host that runs as root, where a
 * permission denial cannot be staged.
 */
export type PromptsEntryStat = (path: string) => PromptsEntryStats | undefined;

/** Options of {@link verifyPromptsDirectory}. */
export interface PromptsDirectoryCheckOptions {
  /** The stat function; defaults to `fs.statSync` with `throwIfNoEntry: false`. */
  readonly stat?: PromptsEntryStat | undefined;
}

/**
 * The most characters of a path a {@link verifyPromptsDirectory} failure
 * quotes. A longer path keeps its head and its tail, where the root and the
 * directory's own name are, with an ellipsis in between.
 */
const MAX_REPORTED_PATH_LENGTH = 160;

/** What stands in for the elided middle of a path longer than {@link MAX_REPORTED_PATH_LENGTH}. */
const REPORTED_PATH_ELISION = '\u2026';

/** What a control character becomes in a quoted path. */
const REPORTED_PATH_REPLACEMENT = '\uFFFD';

/** The default {@link PromptsEntryStat}: `stat`, not `lstat`, so a linked prompt tree is accepted. */
function statPromptsEntry(path: string): PromptsEntryStats | undefined {
  return statSync(path, { throwIfNoEntry: false });
}

/**
 * Whether one code point is a C0 control, DELETE or a C1 control.
 *
 * A NUL truncates a path in the C APIs behind a filesystem call, and an ESC
 * starts a terminal escape sequence in whatever renders the log line, so no
 * such character may survive into a message.
 */
function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Renders a path for a failure message: every control character replaced and
 * the length bounded, measured in code points so a character outside the
 * Basic Multilingual Plane is never split in half.
 *
 * `@debuggen/model-provider`'s prompt loader applies the same
 * control-character rule to the paths its own failures quote. This differs in
 * one respect: a long path loses its middle rather than its end, because the
 * end holds the directory's own name.
 *
 * @param path The path to quote.
 * @returns The quotable form, at most {@link MAX_REPORTED_PATH_LENGTH} code points.
 */
function reportablePath(path: string): string {
  const characters = Array.from(path, (character) =>
    isControlCharacter(character) ? REPORTED_PATH_REPLACEMENT : character,
  );
  if (characters.length <= MAX_REPORTED_PATH_LENGTH) {
    return characters.join('');
  }
  const kept = MAX_REPORTED_PATH_LENGTH - REPORTED_PATH_ELISION.length;
  const head = Math.ceil(kept / 2);
  const tail = kept - head;
  return (
    characters.slice(0, head).join('') +
    REPORTED_PATH_ELISION +
    characters.slice(characters.length - tail).join('')
  );
}

/** ` (EACCES)`, or nothing when the thrown value carried no well-formed `errno` code. */
function errnoSuffix(cause: unknown): string {
  const errno = errnoCodeOf(cause);
  return errno === undefined ? '' : ` (${errno})`;
}

/**
 * The reason clauses {@link verifyPromptsDirectory} records, each naming the
 * directory it looked in, quoted by {@link reportablePath}.
 *
 * Each condition has its own clause because each has a different fix: point
 * the variable somewhere that exists, point it at a directory rather than a
 * file, or add the manifest to a directory that is otherwise right.
 */
const PROMPTS_DIRECTORY_REASONS = Object.freeze({
  missing: (dir: string) => `the directory '${dir}' does not exist`,
  notADirectory: (dir: string) => `the path '${dir}' is not a directory`,
  uninspectable: (dir: string, cause: unknown) =>
    `the directory '${dir}' could not be inspected${errnoSuffix(cause)}`,
  noManifest: (dir: string) => `the directory '${dir}' has no ${PROMPTS_MANIFEST_FILE_NAME}`,
  manifestNotAFile: (dir: string) =>
    `the ${PROMPTS_MANIFEST_FILE_NAME} in '${dir}' is not a regular file`,
  manifestUninspectable: (dir: string, cause: unknown) =>
    `the ${PROMPTS_MANIFEST_FILE_NAME} in '${dir}' could not be inspected${errnoSuffix(cause)}`,
});

/**
 * What one `stat` found: an entry of a known kind, nothing at all, or a
 * failure other than absence.
 */
type StatOutcome =
  | { readonly kind: 'entry'; readonly directory: boolean; readonly file: boolean }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly cause: unknown };

/**
 * Stats one path and classifies the answer.
 *
 * A thrown `ENOENT` or `ENOTDIR` counts as absence even though the default
 * stat reports both as `undefined`, because an injected stat, or a Node
 * release that throws where this one returns, must not turn "not there" into
 * "could not be inspected". The entry's kind is read inside the same `try`, so
 * nothing an injected stat returns can throw out of
 * {@link verifyPromptsDirectory}.
 */
function statOutcome(stat: PromptsEntryStat, path: string): StatOutcome {
  try {
    const stats = stat(path);
    return stats === undefined
      ? { kind: 'missing' }
      : { kind: 'entry', directory: stats.isDirectory(), file: stats.isFile() };
  } catch (cause) {
    const errno = errnoCodeOf(cause);
    return errno !== undefined && MISSING_PATH_ERRNO_CODES.has(errno)
      ? { kind: 'missing' }
      : { kind: 'failed', cause };
  }
}

/**
 * Checks that the prompt directory is there before the service touches disk:
 * {@link ServiceConfig.promptsDir} exists, is a directory (symbolic links
 * followed), and holds {@link PROMPTS_MANIFEST_FILE_NAME} as a regular file.
 *
 * ## Why this is not part of {@link loadServiceConfig}
 *
 * {@link loadServiceConfig} is pure, and it has to stay pure. The dev-server
 * launcher resolves configurations with it, and so do the suites, with prompt
 * paths that do not exist on the machine running them. A loader that stat'ed
 * the prompt directory would fail every one of those callers, or make each of
 * them depend on the host's disk. Presence is a fact about this machine at
 * this moment, not about the value, so it is asked as a separate question of
 * its own, and only by the one caller that is about to serve.
 *
 * ## Why it runs first
 *
 * `src/main.ts` calls this immediately after {@link loadServiceConfig}. That
 * is before the logger is built, before `$DEBUGGEN_HOME` is created, before
 * `auth.json` mints an editor credential, before `sessions.sqlite` is opened
 * and migrated, and before the reconciliation and retention sweeps. A service
 * pointed at a missing prompt tree, such as a packaged extension whose copy
 * is absent or a mistyped `DEBUGGEN_PROMPTS_DIR`, therefore leaves nothing
 * behind. It fails exactly like any other bad key: one `CONFIG_INVALID` in
 * {@link loadServiceConfig}'s own format, naming `DEBUGGEN_PROMPTS_DIR` and
 * carrying that key's remedy.
 *
 * ## What it does not do
 *
 * It is a presence check, not a validation of the tree. The prompt loader
 * still parses the manifest and loads every stage's current version when the
 * service starts, with its containment and bounded-read guarantees, and
 * reports anything wrong inside the tree with its own hint. This function
 * only moves the most common failure ahead of every side effect: the
 * directory or its manifest is simply not there. It is read-only. It makes at
 * most two `stat` calls and creates, opens and writes nothing. A tree removed
 * between this check and the loader's read is still refused by the loader.
 *
 * ## What the failure says
 *
 * The reason quotes the directory that was looked in, with control
 * characters replaced and the length bounded. This is the one quoted path in
 * this module's failures; see the overview for why that stays inside the
 * privacy rule. The hint is `DEBUGGEN_PROMPTS_DIR`'s own remedy, the same one
 * {@link loadServiceConfig} gives for that key, and it names no internal
 * function.
 *
 * @param config The resolved configuration, or any object carrying its
 * `promptsDir`: an absolute, normalised POSIX path.
 * @param options The stat function to use instead of `fs.statSync`.
 * @returns `ok` when the directory and its manifest are present, or one
 * `CONFIG_INVALID` error whose message reads
 * `The local service configuration is invalid: DEBUGGEN_PROMPTS_DIR (<reason>).`
 * and whose `details` carry `{ subsystem: 'config', keys, issues }` exactly as
 * {@link loadServiceConfig}'s do.
 *
 * @example
 * ```ts
 * const loaded = loadServiceConfig(env, overrides);
 * if (isErr(loaded)) {
 *   return loaded;
 * }
 * const prompts = verifyPromptsDirectory(loaded.value);
 * if (isErr(prompts)) {
 *   // "… DEBUGGEN_PROMPTS_DIR (the directory '/opt/prompts' does not exist)."
 *   return prompts;
 * }
 * ```
 */
export function verifyPromptsDirectory(
  config: Pick<ServiceConfig, 'promptsDir'>,
  options: PromptsDirectoryCheckOptions = {},
): Result<void, DebuggenError> {
  const promptsDir: unknown =
    typeof config === 'object' && config !== null ? config.promptsDir : undefined;
  if (typeof promptsDir !== 'string') {
    return err(configError([issue('DEBUGGEN_PROMPTS_DIR', REASONS.unexpectedType)]));
  }
  // The shape rule of {@link resolvedServiceConfigSchema}: a caller that did
  // not come through {@link loadServiceConfig} gets the same verdict it would
  // have got there, before any path reaches a filesystem call.
  if (describePathProblem(promptsDir) !== undefined || normalizePosix(promptsDir) !== promptsDir) {
    return err(configError([issue('DEBUGGEN_PROMPTS_DIR', REASONS.unnormalisedPath)]));
  }

  const stat = options.stat ?? statPromptsEntry;
  const quoted = reportablePath(promptsDir);
  const refuse = (reason: string): Result<void, DebuggenError> =>
    err(configError([issue('DEBUGGEN_PROMPTS_DIR', reason)]));

  const directory = statOutcome(stat, promptsDir);
  if (directory.kind === 'missing') {
    return refuse(PROMPTS_DIRECTORY_REASONS.missing(quoted));
  }
  if (directory.kind === 'failed') {
    return refuse(PROMPTS_DIRECTORY_REASONS.uninspectable(quoted, directory.cause));
  }
  if (!directory.directory) {
    return refuse(PROMPTS_DIRECTORY_REASONS.notADirectory(quoted));
  }

  const manifest = statOutcome(stat, joinPosix(promptsDir, PROMPTS_MANIFEST_FILE_NAME));
  if (manifest.kind === 'missing') {
    return refuse(PROMPTS_DIRECTORY_REASONS.noManifest(quoted));
  }
  if (manifest.kind === 'failed') {
    return refuse(PROMPTS_DIRECTORY_REASONS.manifestUninspectable(quoted, manifest.cause));
  }
  if (!manifest.file) {
    return refuse(PROMPTS_DIRECTORY_REASONS.manifestNotAFile(quoted));
  }

  return ok(undefined);
}
