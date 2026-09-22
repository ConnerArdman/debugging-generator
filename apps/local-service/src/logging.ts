/**
 * The service's logger factory — the one place in `@debuggen/local-service`
 * that knows pino exists.
 *
 * `@debuggen/shared` defines the `Logger` contract all four processes of this
 * product share: a **message-first** interface, `info(message, fields?)`. pino
 * is **object-first**, `logger.info(mergeObject, message)`. This module is the
 * single adapter between the two, so the argument flip lives in exactly one
 * file and every subsystem receives a plain `Logger` it can satisfy with
 * `noopLogger` in a test.
 *
 * Three responsibilities, in the order they matter:
 *
 * 1. **Flip the arguments.** {@link createServiceLogger} returns a `Logger`
 *    whose six level methods call `pinoLogger[level](fields, message)` — and
 *    `pinoLogger[level](message)` when there are no fields, so pino never
 *    emits an empty merge object. Inverting the pair produces records whose
 *    `msg` is `[object Object]`; the compiler cannot catch it, so it is
 *    asserted against emitted JSON rather than against the call signature —
 *    by the integration suites, which run every session through this logger,
 *    and by the colocated suite when it lands at its assigned checkpoint.
 * 2. **Redact.** A log record is the third and last checkpoint between the
 *    developer's runtime data and a file on disk (the first two are
 *    `packages/telemetry/src/redaction/` at ingest and
 *    `packages/model-provider/src/redact-guard.ts` on the outbound prompt).
 *    `packages/shared/src/logger.ts` deliberately performs no redaction, so
 *    the duty lands here. Two layers, because either alone leaks:
 *    - **Layer 1**, {@link SERVICE_LOG_REDACT_PATHS}, is pino's own `redact`
 *      option: a declared deny-list of paths, censored with
 *      `REDACTION_MARKER`. Fast, but path-scoped — pino's wildcard matches a
 *      single level, so `*.token` provably does not reach
 *      `outer.inner.token`.
 *    - **Layer 2**, {@link scrubLogFields}, walks every field value through
 *      `@debuggen/telemetry`'s `scrub` / `scrubNamedValue` /
 *      `isSensitiveKeyName` primitives. Those catch a provider-key prefix, a
 *      bearer credential, a JWT, a PEM block or a credentialed connection
 *      string appearing *anywhere* in a value — including inside an error
 *      message this service did not author, or inside a rejected model
 *      payload that `@debuggen/model-provider`'s `structured.ts` logs through
 *      this very logger. Layer 2 also owns the one name rule the telemetry
 *      vocabulary has no reason to carry: a database connection URL
 *      ({@link SERVICE_DATABASE_URL_KEY_NAMES}), which AAP §0.5.2 forbids
 *      capturing at all and which no content rule recognises once it carries
 *      no credentials.
 *    The message string is scrubbed too: it is cheap and it catches a
 *    credential interpolated into text by a library.
 * 3. **Standardise the bindings.** {@link LOG_BINDING_KEYS} fixes the names
 *    the eleven subsystems bind (`subsystem`, `sessionId`, `captureId`,
 *    `client`) so the output of a whole session is greppable.
 *
 * Deliberate non-features:
 * - **No `pino-pretty`.** It is not a dependency of
 *   `apps/local-service/package.json`; adding one would break
 *   `pnpm install --frozen-lockfile`. Output is structured JSON, always.
 * - **No module-load side effects.** Importing this file opens no stream,
 *   touches no filesystem and reads no environment variable; configuration
 *   arrives as a {@link ServiceConfig} parameter.
 * - **No pino anywhere else.** `eslint.config.js` enforces the dependency
 *   boundary, and that boundary is what keeps the logging layer swappable.
 *
 * @example
 * ```ts
 * const root = createServiceLogger(config);
 * const log = subsystemLogger(root, 'store');
 * log.info('store opened', { schemaVersion: 3, applied: 1 });
 * // {"level":30,"time":1790071063756,"subsystem":"store",
 * //  "schemaVersion":3,"applied":1,"msg":"store opened"}
 * ```
 */

import pino from 'pino';
import type {
  DestinationStream,
  Logger as PinoLogger,
  LoggerOptions as PinoLoggerOptions,
  SerializerFn,
} from 'pino';

import {
  DebuggenError,
  isLevelEnabled,
  noopLogger,
  nowEpochMs,
  type LogFields,
  type Logger,
  type LogLevel,
  type LogLevelSetting,
} from '@debuggen/shared';
import {
  DB_QUERY_ATTRIBUTE_KEYS,
  DROPPED_ATTRIBUTE_KEYS,
  MAX_ATTRIBUTE_DEPTH,
  MAX_ATTRIBUTE_NODES,
  MAX_TRACKED_KEYS,
  REDACTION_MARKER,
  isSensitiveKeyName,
  normalizeSqlStatement,
  scrub,
  scrubNamedValue,
} from '@debuggen/telemetry';

import { DEFAULT_LOG_LEVEL, LOG_LEVEL_SETTINGS, type ServiceConfig } from './config.js';

/**
 * The child-binding names every subsystem uses, so one spelling wins.
 *
 * A binding is how a record says *where it came from*: `subsystem` names the
 * module (conventionally its folder name — `store`, `pipeline`, `telemetry`),
 * `sessionId` and `captureId` tie a record to a session's work, and `client`
 * names the connected client kind a record is about. None of the four is
 * sensitive — `isSensitiveKeyName` exempts `sessionId` by name because the
 * product's own identifiers are not credentials — so all four survive
 * redaction intact and remain greppable.
 */
export const LOG_BINDING_KEYS = Object.freeze({
  /** The module a record came from; conventionally the source folder name. */
  subsystem: 'subsystem',
  /** The session a record belongs to. */
  sessionId: 'sessionId',
  /** The capture a record belongs to, when one is active. */
  captureId: 'captureId',
  /** The connected client kind a record is about. */
  client: 'client',
} as const);

/** One of the four standardised binding names. */
export type LogBindingKey = (typeof LOG_BINDING_KEYS)[keyof typeof LOG_BINDING_KEYS];

/**
 * The field key an error belongs under.
 *
 * Fixed here rather than left to each call site so a consumer can filter on
 * one key, and so the shape below is the only error shape in the log.
 */
export const LOG_ERROR_FIELD_KEY = 'err';

/**
 * Markers this layer substitutes for a value it will not emit verbatim.
 *
 * `redacted` is the privacy marker and is imported, never retyped, so this
 * checkpoint agrees with the other two (`packages/telemetry` censors with it
 * and `packages/model-provider`'s redact guard requires it). The rest are
 * *serialisation* artefacts, not privacy removals, and are deliberately
 * distinct from it: reading `[circular]` in a record should not suggest a
 * credential was found there.
 */
export const LOG_MARKERS = Object.freeze({
  /** A denied value. Identical to `@debuggen/telemetry`'s marker. */
  redacted: REDACTION_MARKER,
  /** A value already seen on the path from the root — a reference cycle. */
  circular: '[circular]',
  /** A value omitted because the depth, node or key bound was reached. */
  truncated: '[truncated]',
  /** A function value, which is never diagnostic data. */
  function: '[function]',
  /** A value that threw while being read or converted. */
  unserializable: '[unserializable]',
} as const);

/**
 * The flag added to a record whose fields were bounded.
 *
 * Presence of this key means at least one value was replaced with
 * `LOG_MARKERS.truncated`, so a reader is never left guessing whether a
 * missing branch was absent or merely bounded.
 */
export const FIELDS_TRUNCATED_KEY = 'fieldsTruncated';

/**
 * The flag added to a record whose keys could not be enumerated at all.
 *
 * Distinct from {@link FIELDS_TRUNCATED_KEY}: truncation means the walk chose
 * to stop, while this means the object refused to be read — a `Proxy` whose
 * `ownKeys` trap throws, for instance. The record is emitted with this key
 * rather than dropped, so a reader sees that fields were present and
 * unreadable instead of seeing nothing at all.
 */
export const FIELDS_UNREADABLE_KEY = 'fieldsUnreadable';

/**
 * Keys pino owns in the emitted record, which a field must not collide with.
 *
 * pino does **not** guard these in the merge object: a field named `msg`
 * produces a second `msg` key in the JSON, and a consumer reading last-wins
 * would take the field's value as the message. Each is therefore renamed with
 * {@link RESERVED_FIELD_PREFIX} before it reaches pino.
 */
export const RESERVED_LOG_KEYS = Object.freeze(['level', 'time', 'msg'] as const);

/**
 * Key names that break pino when they reach it as top-level field names.
 *
 * pino resolves a field's serializer as `serializers[key]` on a plain object,
 * so a field named after an `Object.prototype` property finds that property
 * through the prototype chain instead of finding nothing. Measured against
 * pino 10.3.1, with one merge object per name:
 *
 * - **Throws** for `__proto__`, `valueOf`, `hasOwnProperty`, `toLocaleString`,
 *   `propertyIsEnumerable`, `__defineGetter__` and `__defineSetter__` — the
 *   inherited value is either not a function or a function that rejects
 *   pino's arguments. A throw here escapes `logger.error(...)` itself, which
 *   is the never-throw boundary this module promises.
 * - **Emits invalid JSON** for `constructor` and `toString`: the inherited
 *   function is *called* as the serializer and its result is interpolated
 *   unquoted, producing a line no consumer can parse (`"constructor":V`).
 * - **Silently loses the field** for `__lookupGetter__`, `__lookupSetter__`
 *   and `isPrototypeOf`.
 *
 * Derived from the runtime rather than transcribed, so a future engine
 * addition to `Object.prototype` is covered without an edit here. Each name is
 * renamed with {@link RESERVED_FIELD_PREFIX} at the top record, exactly like
 * pino's own keys; a *nested* occurrence is ordinary data and travels
 * unchanged, which is safe because nested objects are serialised without a
 * serializer lookup.
 */
export const PROTOTYPE_LOG_KEYS: readonly string[] = Object.freeze([
  ...Object.getOwnPropertyNames(Object.prototype),
]);

/** The prefix applied to a field whose name collides with a reserved key. */
export const RESERVED_FIELD_PREFIX = 'field_';

/**
 * Field names carrying a SQL statement.
 *
 * Derived from the telemetry attribute catalog's `db.statement` plus the
 * shorter names a service call site naturally reaches for, rather than
 * retyped: a log record must never carry an un-parameterised statement, and
 * which key it arrived under is not something this layer can assume.
 */
export const SQL_STATEMENT_FIELD_KEYS = Object.freeze([
  ...DB_QUERY_ATTRIBUTE_KEYS.filter((key) => key.endsWith('.statement')),
  'statement',
  'sql',
  'query',
  'queryText',
] as const);

/**
 * Sensitive names `isSensitiveKeyName` does not match, checked in addition to
 * it.
 *
 * The telemetry predicate is built for span attributes; these three are
 * log-layer realities it has no reason to know. `cookie` and `set-cookie`
 * carry session credentials, and a pairing code *is* the capability that mints
 * a DevTools credential (AAP §0.5.6), so none may ever be logged. The
 * product's own `code` field — a `DebuggenError` code — is deliberately absent
 * from this list: it is a diagnostic identifier and must stay readable.
 */
export const SERVICE_SENSITIVE_KEY_NAMES = Object.freeze([
  'cookie',
  'set-cookie',
  'pairing-code',
] as const);

/**
 * Field names carrying a database connection URL, which is never logged.
 *
 * AAP §0.5.2 lists `DATABASE_URL` alongside `.env*` files and passwords as
 * data the product must *never capture*, and neither heuristic this layer
 * composes reaches it on its own:
 *
 * - **By name**: `@debuggen/telemetry`'s `isSensitiveKeyName` matches the
 *   terms `key`, `token`, `secret`, `password`, `passwd`, `pwd`, `credential`
 *   and `auth`. `DATABASE_URL` normalises to `databaseurl` and contains none
 *   of them, so the predicate answers `false`.
 * - **By content**: the `connection-string` rule redacts the *userinfo* of an
 *   absolute URL, so it removes the password from a `postgresql://` URL whose
 *   authority carries a `user:password@` prefix but leaves a credential-free
 *   internal DSN such as `postgresql://localhost:5432/lumen_supply` intact — and a bare
 *   host, port and database name is exactly the internal topology this
 *   product has no reason to write to a log file.
 *
 * So the log layer owns the name rule for these, and this list is the single
 * source of it: {@link SERVICE_LOG_REDACT_PATHS} spreads each spelling into
 * pino's path list (Layer 1) and {@link isDatabaseUrlKey} matches the same
 * names at any depth (Layer 2), so the two layers cannot drift apart.
 *
 * Both case conventions are listed because a pino `redact` path is matched
 * **case-sensitively** against the literal property name: `DATABASE_URL` is
 * the environment variable (AAP §0.3.4, and what the dev-server launcher
 * passes to the target project), `databaseUrl`/`database_url` are what the
 * same value is called once it travels inside a configuration object or a
 * JSON body, `connectionString` is `pg`'s own `Pool` option, `datasourceUrl`
 * is Prisma's client option, and `DIRECT_URL`/`DB_URL`/`POSTGRES_URL` are the
 * conventional siblings of `DATABASE_URL` in this stack. Layer 2 needs only
 * one spelling of each, and folds the rest onto it.
 */
export const SERVICE_DATABASE_URL_KEY_NAMES = Object.freeze([
  'DATABASE_URL',
  'database_url',
  'databaseUrl',
  'DIRECT_URL',
  'direct_url',
  'directUrl',
  'DB_URL',
  'db_url',
  'dbUrl',
  'POSTGRES_URL',
  'connectionString',
  'connection_string',
  'datasourceUrl',
] as const);

/**
 * Layer 1 — the structural deny-list handed to pino's `redact` option.
 *
 * Path-scoped and therefore incomplete on its own: pino's `*` matches exactly
 * one level, so a credential nested two levels down is caught by
 * {@link scrubLogFields}, not here. What this layer adds is a net that closes
 * even if a record reaches pino by some path that skipped the value walk —
 * an injected pino instance shared with a test, say — and a cheap declaration
 * of intent a reviewer can read at a glance.
 *
 * The database URL entries are generated from
 * {@link SERVICE_DATABASE_URL_KEY_NAMES} rather than written out, so adding a
 * spelling there covers both the exact and the one-level-nested path here and
 * the whole-value mask in Layer 2 at the same time.
 *
 * Exported so a test can assert the set rather than re-derive it.
 */
export const SERVICE_LOG_REDACT_PATHS: readonly string[] = Object.freeze([
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'anthropicApiKey',
  '*.anthropicApiKey',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'proxy-authorization',
  'cookie',
  '*.cookie',
  'headers.cookie',
  '["set-cookie"]',
  '*["set-cookie"]',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'credential',
  '*.credential',
  'privateKey',
  '*.privateKey',
  'sessionKey',
  '*.sessionKey',
  'pairingCode',
  '*.pairingCode',
  'body',
  '*.body',
  'requestBody',
  '*.requestBody',
  'responseBody',
  '*.responseBody',
  ...SERVICE_DATABASE_URL_KEY_NAMES.flatMap((name) => [name, `*.${name}`]),
]);

/**
 * How a caller may steer logger construction.
 *
 * Every member is a seam for a test: `destination` captures records without
 * writing to stdout and without touching the filesystem, `pinoLogger` hands
 * over a fully pre-built instance, `level` overrides the configured threshold
 * and `bindings` seeds the root with fields every record should carry.
 */
export interface ServiceLoggerOptions {
  /**
   * Where records are written. Defaults to pino's own stdout destination,
   * created at call time so importing this module opens nothing.
   */
  readonly destination?: DestinationStream;
  /**
   * A pre-built pino instance to adapt instead of constructing one. When
   * supplied, `destination` is ignored — the instance already has one — and
   * the caller owns its options, including redaction.
   */
  readonly pinoLogger?: PinoLogger;
  /** Overrides {@link ServiceConfig.logLevel}. */
  readonly level?: LogLevelSetting;
  /** Bindings every record carries, scrubbed like any other fields. */
  readonly bindings?: LogFields;
}

/** Mutable accounting shared across one {@link scrubLogFields} walk. */
interface ScrubBudget {
  /** Remaining nodes the walk may emit. */
  nodes: number;
  /** Whether any bound was reached, which surfaces as the truncated flag. */
  bounded: boolean;
}

/**
 * Normalises a key for name comparison: lower-cased, separators removed.
 *
 * Mirrors the folding `isSensitiveKeyName` applies, so
 * {@link SERVICE_SENSITIVE_KEY_NAMES} matches `set-cookie`, `setCookie` and
 * `Set_Cookie` as one name.
 */
function foldKeyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SERVICE_SENSITIVE_FOLDED: readonly string[] = Object.freeze(
  SERVICE_SENSITIVE_KEY_NAMES.map(foldKeyName),
);

const SQL_STATEMENT_FOLDED: readonly string[] = Object.freeze(
  SQL_STATEMENT_FIELD_KEYS.map((key) => foldKeyName(lastSegmentOf(key))),
);

const DROPPED_FOLDED: readonly string[] = Object.freeze(DROPPED_ATTRIBUTE_KEYS.map(foldKeyName));

/**
 * The final dot-delimited segment of a key.
 *
 * Attribute-style keys arrive dotted (`http.request.header.cookie`), and the
 * meaningful name is the tail. Comparing the tail as well as the whole key is
 * what lets one short list cover both spellings.
 */
function lastSegmentOf(key: string): string {
  const index = key.lastIndexOf('.');
  return index === -1 ? key : key.slice(index + 1);
}

/** Whether either the whole key or its last segment folds onto a candidate. */
function matchesFolded(key: string, candidates: readonly string[]): boolean {
  const whole = foldKeyName(key);
  if (candidates.includes(whole)) {
    return true;
  }
  const tail = foldKeyName(lastSegmentOf(key));
  return tail !== whole && candidates.includes(tail);
}

/**
 * Splits a key into lower-cased words at camelCase, acronym and separator
 * boundaries: `DATABASE_URL`, `databaseUrl`, `database.url` and `DatabaseURL`
 * all become `['database', 'url']`.
 *
 * Words rather than a folded string, because {@link isDatabaseUrlKey} matches
 * a *run of words* and folding loses the boundaries that keep the match
 * precise. Folded containment would mask `redirectUrl`, whose folded form
 * `redirecturl` contains `directurl`; as words, `['redirect', 'url']` does not
 * begin with `direct`, so a redirect URL stays readable while `DIRECT_URL`
 * does not.
 */
function keyWords(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * The word runs a database URL name is recognised by, derived once from
 * {@link SERVICE_DATABASE_URL_KEY_NAMES} so the two layers share one
 * vocabulary. Duplicates collapse: the three spellings of `DATABASE_URL`
 * yield the same run.
 */
const DATABASE_URL_WORD_RUNS: readonly (readonly string[])[] = Object.freeze(
  [...new Set(SERVICE_DATABASE_URL_KEY_NAMES.map((name) => keyWords(name).join(' ')))].map((run) =>
    Object.freeze(run.split(' ')),
  ),
);

/** The same names folded, so a separator-free spelling (`DATABASEURL`) matches too. */
const DATABASE_URL_FOLDED: readonly string[] = Object.freeze([
  ...new Set(SERVICE_DATABASE_URL_KEY_NAMES.map(foldKeyName)),
]);

/**
 * Whether `words` contains `run` as a consecutive sub-run.
 *
 * The run's last word also matches its plural, so `connectionStrings` and
 * `databaseUrls` — a pool configuration holding several DSNs — are masked
 * like the singular. Nothing else is inflected: a match must otherwise be
 * word-for-word.
 */
function containsWordRun(words: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0 || run.length > words.length) {
    return false;
  }
  const last = run.length - 1;
  for (let start = 0; start + run.length <= words.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < run.length; offset += 1) {
      const word = words[start + offset];
      const expected = run[offset];
      if (word === undefined || expected === undefined) {
        matched = false;
        break;
      }
      if (word === expected || (offset === last && word === `${expected}s`)) {
        continue;
      }
      matched = false;
      break;
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a field under this name carries a database connection URL.
 *
 * Word-run matching means the name is recognised wherever it appears in a
 * compound: `DATABASE_URL`, `shadowDatabaseUrl`, `DATABASE_URL_UNPOOLED` and
 * `pool.connectionString` all match, while `redirectUrl` and `databasePath`
 * — the session store's own SQLite path, which is a diagnostic — do not. A
 * bare `url` key is deliberately *not* matched: request URLs are the core of
 * the network diagnostics this product exists to show, and AAP §0.5.2 keeps
 * their path while redacting their query values rather than masking them
 * whole.
 */
function isDatabaseUrlKey(key: string): boolean {
  if (matchesFolded(key, DATABASE_URL_FOLDED)) {
    return true;
  }
  const words = keyWords(key);
  return DATABASE_URL_WORD_RUNS.some((run) => containsWordRun(words, run));
}

/**
 * Whether a field under this name must be masked whole rather than scanned.
 *
 * Two sources: `@debuggen/telemetry`'s `isSensitiveKeyName`, which owns the
 * product-wide vocabulary (and exempts the product's own identifiers), plus
 * {@link SERVICE_SENSITIVE_KEY_NAMES} for the log-layer names it does not
 * cover.
 *
 * The telemetry predicate matches a sensitive *term* anywhere in the folded
 * name, so `key`, `envKey` and `cacheKey` are all masked. That is deliberate
 * and is not loosened here: this checkpoint must never be more permissive
 * than the ingest one, and over-masking a diagnostic costs a reader one
 * indirection while under-masking costs a credential. A subsystem that needs
 * a *name-like* value to stay readable should choose a field name that does
 * not fold onto a sensitive term — `setting` or `variable` rather than
 * `envKey` — and the product's own identifiers (`sessionId`, `traceId`,
 * `spanId`, `request_key`) are already exempt by name upstream.
 *
 * {@link isDatabaseUrlKey} is the third source and the reason this predicate
 * is not simply the telemetry one: a database URL is sensitive by name but
 * matches neither the telemetry vocabulary nor a content rule when it carries
 * no credentials (see {@link SERVICE_DATABASE_URL_KEY_NAMES}).
 */
function isSensitiveLogKey(key: string): boolean {
  return (
    isSensitiveKeyName(key) ||
    isSensitiveKeyName(lastSegmentOf(key)) ||
    matchesFolded(key, SERVICE_SENSITIVE_FOLDED) ||
    isDatabaseUrlKey(key)
  );
}

/** Whether a field under this name carries a SQL statement. */
function isSqlStatementKey(key: string): boolean {
  return matchesFolded(key, SQL_STATEMENT_FOLDED);
}

/**
 * Whether a field under this name is a body, a row set or a parameter bag.
 *
 * AAP §0.5.2 forbids capturing request or response bodies, database row
 * contents and query parameter values at all, so the names the telemetry
 * redactor drops outright are masked here. The divergence is deliberate:
 * telemetry drops the key because the product never captured it, while a log
 * reader benefits from seeing that a field *was* present and suppressed.
 */
function isMaskedBodyKey(key: string): boolean {
  return matchesFolded(key, DROPPED_FOLDED);
}

/** Narrowing helper that keeps element types `unknown` rather than `any`. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Whether a value is a container this walk descends into. */
function isWalkableObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * Masks a value whose *name* denies it, whatever the value is.
 *
 * Keeps `scrubNamedValue`'s semantics — a denied name masks the value whole,
 * and an empty value stays empty so a reader can tell "absent" from
 * "suppressed" — and extends them to the supplementary names
 * `isSensitiveKeyName` does not recognise.
 */
function maskSensitiveValue(key: string, value: unknown): unknown {
  if (value === undefined || value === null) {
    return LOG_MARKERS.redacted;
  }
  if (typeof value === 'string' && value.length === 0) {
    return value;
  }
  if (isSensitiveKeyName(key)) {
    return scrubNamedValue(key, value);
  }
  return LOG_MARKERS.redacted;
}

/**
 * Scrubs a log message.
 *
 * `scrub` is total (it never throws, whatever it is handed), idempotent, and
 * bounds its output to the redaction layer's scan length, so a pathological
 * message cannot stall the process or fill a disk.
 */
export function scrubLogMessage(message: string): string {
  return scrub(message);
}

/**
 * Scrubs a field bag into a new bag safe to emit.
 *
 * Never mutates its argument — the shared `Logger` contract promises a caller
 * gets its object back unchanged — and never throws: a value that resists
 * reading becomes `LOG_MARKERS.unserializable` under its own key rather than
 * an exception escaping a log call, and a bag that refuses enumeration
 * altogether comes back carrying {@link FIELDS_UNREADABLE_KEY}. The result is
 * also safe for pino to receive: prototype-derived names are renamed and the
 * top-level object keeps a prototype, which pino's `child()` requires.
 *
 * Bounded three ways, using the redaction layer's own constants so this
 * checkpoint cannot be looser than the ingest one: at most
 * `MAX_ATTRIBUTE_NODES` values in total, at most `MAX_TRACKED_KEYS` keys per
 * object, and containers below `MAX_ATTRIBUTE_DEPTH` omitted (a scalar at that
 * depth still travels). Reaching any bound adds {@link FIELDS_TRUNCATED_KEY}
 * to the result.
 *
 * @param fields - the caller's bag; left untouched
 * @returns a new bag with denied values masked and every string scanned
 */
export function scrubLogFields(fields: LogFields): LogFields {
  const budget: ScrubBudget = { nodes: MAX_ATTRIBUTE_NODES, bounded: false };
  const result = scrubRecord(fields, 0, budget, new WeakSet<object>(), true);
  if (budget.bounded && !Object.hasOwn(result, FIELDS_TRUNCATED_KEY)) {
    result[FIELDS_TRUNCATED_KEY] = true;
  }
  return result;
}

/**
 * Lists a record's own enumerable string keys, or `undefined` if it refuses.
 *
 * `Object.keys` is not inert on an arbitrary value: a `Proxy` can throw from
 * its `ownKeys` or `getOwnPropertyDescriptor` trap, and the values that reach
 * this layer include rejected model payloads and objects this service did not
 * author. Enumeration is therefore a guarded step of its own rather than part
 * of the loop header.
 */
function ownKeysOf(source: Readonly<Record<string, unknown>>): readonly string[] | undefined {
  try {
    return Object.keys(source);
  } catch {
    return undefined;
  }
}

/**
 * What {@link readProperty} returns when a property could not be read.
 *
 * A module-private symbol rather than `undefined`, because `undefined` is a
 * legitimate value with its own meaning here — the key is omitted — and must
 * stay distinguishable from a failed read. Never emitted: every branch that
 * receives it substitutes {@link LOG_MARKERS.unserializable}.
 */
const READ_FAILED = Symbol('debuggen.readFailed');

/**
 * Reads one property, or reports that it could not be read.
 *
 * A property may be an accessor that throws — a lazily computed `stack`, a
 * getter on a rejected payload, a `Proxy` `get` trap. `Object.entries` would
 * invoke every such getter while building its array, outside any guard, so
 * one hostile field would take down the whole log call. Reading each property
 * inside its own `try` costs nothing and confines the damage to that field.
 */
function readProperty(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return READ_FAILED;
  }
}

/**
 * Walks one record.
 *
 * Neither enumerating the source nor reading one of its properties can throw
 * out of this function: both are guarded, and a value that resists reading
 * becomes {@link LOG_MARKERS.unserializable} under its own key while every
 * other field still travels. That is what makes `logger.error(...)` safe on
 * the error path, where the object being logged is least likely to be
 * well-behaved.
 *
 * The destination's prototype depends on `top`. A nested record is created
 * with `Object.create(null)` so that a source key named `__proto__` becomes an
 * ordinary own property instead of reaching `Object.prototype`'s setter, which
 * would change the destination's prototype and drop the field. The **top**
 * record cannot use a null prototype: pino's `child()` calls
 * `bindings.hasOwnProperty(...)` on the object it is handed and throws
 * ("bindings.hasOwnProperty is not a function") when the prototype is absent.
 * It is a plain object instead, and {@link reserveKey} renames the
 * prototype-derived names there, which removes the hazard at its source.
 *
 * @param source - the record being copied
 * @param depth - the record's own depth; the root bag is 0
 * @param budget - shared node accounting
 * @param seen - containers on the path from the root, for cycle detection
 * @param top - whether this is the record pino merges, where its own keys
 *   (`level`, `time`, `msg`) and the prototype-derived names must not be
 *   collided with
 */
function scrubRecord(
  source: Readonly<Record<string, unknown>>,
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
  top: boolean,
): LogFields {
  const result: LogFields = top ? {} : (Object.create(null) as LogFields);
  const sourceKeys = ownKeysOf(source);
  if (sourceKeys === undefined) {
    result[reserveKey(FIELDS_UNREADABLE_KEY, result, top)] = LOG_MARKERS.unserializable;
    return result;
  }

  let keys = 0;
  for (const key of sourceKeys) {
    if (keys >= MAX_TRACKED_KEYS) {
      budget.bounded = true;
      break;
    }
    const value = readProperty(source, key);
    if (value === READ_FAILED) {
      keys += 1;
      result[reserveKey(key, result, top)] = LOG_MARKERS.unserializable;
      continue;
    }
    if (value === undefined) {
      // Omit the key rather than emit `undefined`, matching the shared
      // logger, which omits an absent binding instead of naming it.
      continue;
    }
    keys += 1;
    result[reserveKey(key, result, top)] = scrubValue(key, value, depth + 1, budget, seen);
  }

  return result;
}

/**
 * Resolves the name a field is emitted under.
 *
 * Two families are renamed, and only in the record pino merges: pino's own
 * keys ({@link RESERVED_LOG_KEYS}), because a duplicate `msg` would be read
 * last-wins as the message, and the prototype-derived names
 * ({@link PROTOTYPE_LOG_KEYS}), because pino's serializer lookup finds them on
 * `Object.prototype` and then throws, emits unquoted JSON, or drops the field.
 * A nested `msg` or `__proto__` is ordinary data and keeps its name.
 *
 * A collision with the prefixed name is resolved by prefixing again, bounded
 * by the key cap so the loop always terminates. `Object.hasOwn` rather than
 * `in`, so an inherited property of a plain destination cannot masquerade as
 * a collision.
 */
function reserveKey(key: string, result: Readonly<LogFields>, top: boolean): string {
  if (
    !top ||
    !((RESERVED_LOG_KEYS as readonly string[]).includes(key) || PROTOTYPE_LOG_KEYS.includes(key))
  ) {
    return key;
  }
  let candidate = `${RESERVED_FIELD_PREFIX}${key}`;
  for (
    let attempt = 0;
    attempt < MAX_TRACKED_KEYS && Object.hasOwn(result, candidate);
    attempt += 1
  ) {
    candidate = `${RESERVED_FIELD_PREFIX}${candidate}`;
  }
  return candidate;
}

/**
 * Scrubs one value, dispatching on its name first and its type second.
 *
 * Name beats type: a denied name masks the value whatever shape it has, which
 * is the only ordering that cannot be defeated by wrapping a credential in an
 * object.
 */
function scrubValue(
  key: string,
  value: unknown,
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
): unknown {
  if (budget.nodes <= 0) {
    budget.bounded = true;
    return LOG_MARKERS.truncated;
  }
  budget.nodes -= 1;

  try {
    if (isMaskedBodyKey(key)) {
      return LOG_MARKERS.redacted;
    }
    if (isSensitiveLogKey(key)) {
      return maskSensitiveValue(key, value);
    }
    if (isSqlStatementKey(key)) {
      // Normalised rather than dropped: a parameterised statement is the
      // diagnostic — it identifies the query — and carries no literal, so
      // every inline value is replaced before the text can reach a record.
      return normalizeSqlStatement(value);
    }
    return scrubUnnamedValue(value, depth, budget, seen);
  } catch {
    return LOG_MARKERS.unserializable;
  }
}

/**
 * Scrubs a value whose name carries no meaning — an array element, or a value
 * whose key has already been cleared.
 *
 * Scalars keep their JSON type so structured queries over the log still work
 * on numbers and booleans; only strings are scanned, because only a string can
 * hide a credential. A `bigint` becomes a decimal string, since pino would
 * otherwise coerce it to a `number` and silently lose precision.
 */
function scrubUnnamedValue(
  value: unknown,
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
): unknown {
  switch (typeof value) {
    case 'string':
      return scrub(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value}`;
    case 'symbol':
      return scrub(value.toString());
    case 'function':
      return LOG_MARKERS.function;
    case 'undefined':
      // Reachable only for an array hole or a `Map` value; a record's
      // `undefined` field is dropped before it gets here. `null` is the
      // JSON-representable equivalent.
      return null;
    default:
      break;
  }

  if (value === null) {
    return null;
  }
  if (!isWalkableObject(value)) {
    return LOG_MARKERS.unserializable;
  }
  return scrubContainer(value, depth, budget, seen);
}

/**
 * Scrubs a container: an error, a date, an array, a map, a set or a record.
 *
 * Cycle detection adds the container to `seen` for the duration of its own
 * subtree and removes it afterwards, so two sibling fields referencing one
 * object are both emitted while a genuine cycle is cut.
 *
 * No untrusted `toJSON` or `toString` is ever invoked. A value reaching this
 * layer may be a rejected model payload, and calling a method it defines is
 * exactly the kind of trust this product does not extend.
 */
function scrubContainer(
  value: object,
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
): unknown {
  if (seen.has(value)) {
    return LOG_MARKERS.circular;
  }
  if (depth >= MAX_ATTRIBUTE_DEPTH) {
    budget.bounded = true;
    return LOG_MARKERS.truncated;
  }

  seen.add(value);
  try {
    if (value instanceof Error) {
      return serializeError(value, depth, budget, seen);
    }
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isNaN(time) ? LOG_MARKERS.unserializable : value.toISOString();
    }
    if (isUnknownArray(value)) {
      return scrubArray(value, depth, budget, seen);
    }
    if (value instanceof Map) {
      return scrubMap(value as ReadonlyMap<unknown, unknown>, depth, budget, seen);
    }
    if (value instanceof Set) {
      return scrubArray([...(value as ReadonlySet<unknown>)], depth, budget, seen);
    }
    return scrubRecord(value as Readonly<Record<string, unknown>>, depth, budget, seen, false);
  } finally {
    seen.delete(value);
  }
}

/** Scrubs an array, bounded by the key cap so a huge list cannot flood a record. */
function scrubArray(
  value: readonly unknown[],
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
): unknown[] {
  const limit = Math.min(value.length, MAX_TRACKED_KEYS);
  if (limit < value.length) {
    budget.bounded = true;
  }
  const result: unknown[] = [];
  for (let index = 0; index < limit; index += 1) {
    if (budget.nodes <= 0) {
      budget.bounded = true;
      result.push(LOG_MARKERS.truncated);
      break;
    }
    budget.nodes -= 1;
    try {
      result.push(scrubUnnamedValue(value[index], depth + 1, budget, seen));
    } catch {
      result.push(LOG_MARKERS.unserializable);
    }
  }
  if (limit < value.length) {
    result.push(LOG_MARKERS.truncated);
  }
  return result;
}

/**
 * Scrubs a `Map` into a record.
 *
 * A non-string map key is stringified only when it is a primitive; an object
 * key becomes the redacted marker rather than risk its `toString`.
 */
function scrubMap(
  value: ReadonlyMap<unknown, unknown>,
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
): LogFields {
  // Null prototype, for the same reason a nested record has one: a map key of
  // `__proto__` must become an own property here rather than reach
  // `Object.prototype`'s setter and silently replace this object's prototype.
  const entries = Object.create(null) as Record<string, unknown>;
  let keys = 0;
  for (const [mapKey, mapValue] of value) {
    if (keys >= MAX_TRACKED_KEYS) {
      budget.bounded = true;
      break;
    }
    keys += 1;
    entries[mapKeyToName(mapKey)] = mapValue;
  }
  return scrubRecord(entries, depth, budget, seen, false);
}

/** Renders a map key as a field name without invoking an untrusted method. */
function mapKeyToName(key: unknown): string {
  switch (typeof key) {
    case 'string':
      return key;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(key);
    case 'symbol':
      return key.toString();
    default:
      return LOG_MARKERS.redacted;
  }
}

/**
 * Serialises an error into the one error shape this log emits.
 *
 * A `DebuggenError` contributes its `toPayload()` triple — `code`, `message`
 * and `hint` — which is the shape the protocol already validates, so a log
 * record and a wire error read alike. Its `details` bag is *not* part of that
 * payload and may carry arbitrary caller data, so it travels only through the
 * full value walk. `cause` is included for the same reason a stack is: it is
 * usually where the real failure is, and it is scrubbed like everything else.
 */
function serializeError(
  error: Error,
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
): LogFields {
  // `name`, `message`, `stack` and `cause` are read through the same guard the
  // record walk uses: they are ordinary properties on an ordinary error, but
  // any of them may be an accessor on an object this service did not author,
  // and losing the whole error record to one hostile getter is the outcome
  // this file exists to prevent.
  const name = readProperty(error, 'name');
  const result: LogFields = {
    type: typeof name === 'string' ? name : LOG_MARKERS.unserializable,
  };

  if (DebuggenError.is(error)) {
    const payload = error.toPayload();
    result.code = payload.code;
    result.message = scrub(payload.message);
    if (payload.hint !== undefined) {
      result.hint = scrub(payload.hint);
    }
    const details = error.details;
    if (details !== undefined) {
      result.details = scrubRecord(details, depth, budget, seen, false);
    }
  } else {
    const message = readProperty(error, 'message');
    result.message = message === READ_FAILED ? LOG_MARKERS.unserializable : scrub(message);
  }

  const stack = readProperty(error, 'stack');
  if (typeof stack === 'string' && stack.length > 0) {
    result.stack = scrub(stack);
  }
  const cause = readProperty(error, 'cause');
  if (cause === READ_FAILED) {
    result.cause = LOG_MARKERS.unserializable;
  } else if (cause !== undefined) {
    result.cause = scrubUnnamedValue(cause, depth, budget, seen);
  }

  return result;
}

/**
 * pino's time field, in the product's canonical time base.
 *
 * `LogRecord.time` in `@debuggen/shared` and every telemetry timestamp are
 * Unix epoch milliseconds (AAP §0.2.3); pino's default is the same base, but
 * the fragment is written explicitly so a future pino default cannot move the
 * service's clock out of step with the events it correlates.
 */
const epochMillisTimestamp = (): string => `,"time":${nowEpochMs()}`;

/** Whether a value is one of the six levels or `silent`. */
function isLogLevelSetting(value: unknown): value is LogLevelSetting {
  return LOG_LEVEL_SETTINGS.some((candidate) => candidate === value);
}

/**
 * Resolves the threshold to use, clamping anything unrecognised.
 *
 * pino **throws** when constructed with a level string it does not know, and
 * a logger is not something a service can fail to build: the failure would
 * arrive before there is any way to report it. An unrecognised setting is
 * therefore replaced with the configured default. The parameter is `unknown`
 * deliberately — a `ServiceConfig` is typed, but this function is also the
 * guard for a value that crossed a boundary untyped.
 */
function resolveLevel(candidate: unknown): LogLevelSetting {
  return isLogLevelSetting(candidate) ? candidate : DEFAULT_LOG_LEVEL;
}

/**
 * Replaces pino's standard serializer for {@link LOG_ERROR_FIELD_KEY}.
 *
 * pino serializes whatever sits under its error key with
 * `pino.stdSerializers.err`, which re-derives the record from the value's
 * constructor and folds a `cause` chain into the message. By the time a value
 * reaches pino, {@link serializeError} has already produced the shape this
 * service documents — `type`, `code`, `message`, `hint`, `details`, `stack`,
 * `cause`, all scrubbed — from a plain object, so the standard serializer
 * would report `type: "Object"` and rewrite a message that was deliberately
 * assembled. An identity serializer keeps the scrubbed shape intact; it is
 * also the conservative choice, since the standard one reads properties off a
 * value that may have come from a rejected model payload.
 */
const passThroughSerializer: SerializerFn = (value: unknown): unknown => value;

/**
 * The pino options this service always uses.
 *
 * `base: null` drops pino's `pid` and `hostname` bindings: the service is a
 * single local process, the fields are noise in a developer-facing log, and a
 * hostname is machine-identifying data this product has no reason to record.
 */
function buildPinoOptions(level: LogLevelSetting): PinoLoggerOptions {
  return {
    level,
    base: null,
    timestamp: epochMillisTimestamp,
    redact: { paths: [...SERVICE_LOG_REDACT_PATHS], censor: REDACTION_MARKER },
    serializers: { [LOG_ERROR_FIELD_KEY]: passThroughSerializer },
  };
}

/** Constructs the root pino instance, writing to `destination` when given. */
function createPinoLogger(
  level: LogLevelSetting,
  destination: DestinationStream | undefined,
): PinoLogger {
  const options = buildPinoOptions(level);
  return destination === undefined ? pino(options) : pino(options, destination);
}

/**
 * Wraps a pino instance as a shared `Logger`.
 *
 * This is the argument flip, and the only place it happens. Three properties
 * of the wrapper matter:
 *
 * - **Gate before work.** A call below the threshold returns before scrubbing,
 *   so a `trace` call in a hot ingest loop costs one integer comparison rather
 *   than a walk of its fields.
 * - **No empty merge object.** With no fields, pino is called with the message
 *   alone, so the record has no vestigial `{}`.
 * - **Children stay `Logger`s.** `child` wraps pino's child in this same
 *   adapter, so nothing pino-shaped escapes this module. Binding precedence
 *   is pino's: a per-call field and a child binding of the same name both
 *   appear, with the per-call value last, which is last-wins for any JSON
 *   reader and matches the shared contract's *per-call > child > parent*.
 */
function createAdapter(pinoLogger: PinoLogger, level: LogLevelSetting): Logger {
  const emit = (target: LogLevel, message: string, fields?: LogFields): void => {
    if (!isLevelEnabled(level, target)) {
      return;
    }
    const safeMessage = scrubLogMessage(message);
    if (fields === undefined) {
      pinoLogger[target](safeMessage);
      return;
    }
    const safeFields = scrubLogFields(fields);
    if (Object.keys(safeFields).length === 0) {
      pinoLogger[target](safeMessage);
      return;
    }
    pinoLogger[target](safeFields, safeMessage);
  };

  const logger: Logger = {
    level,
    trace: (message, fields) => {
      emit('trace', message, fields);
    },
    debug: (message, fields) => {
      emit('debug', message, fields);
    },
    info: (message, fields) => {
      emit('info', message, fields);
    },
    warn: (message, fields) => {
      emit('warn', message, fields);
    },
    error: (message, fields) => {
      emit('error', message, fields);
    },
    fatal: (message, fields) => {
      emit('fatal', message, fields);
    },
    child: (bindings) => createAdapter(pinoLogger.child(scrubLogFields(bindings)), level),
  };

  return Object.freeze(logger);
}

/**
 * Builds the service's root logger.
 *
 * The only logger constructor in the service: `apps/local-service/src/main.ts`
 * calls it once at start-up and hands children down, so no subsystem builds
 * its own and every record shares one threshold, one redaction policy and one
 * time base.
 *
 * A configured level of `silent` returns `noopLogger` from `@debuggen/shared`
 * rather than a pino instance muted to silence: nothing is constructed,
 * nothing is scrubbed, no destination is opened, and `logger.level` still
 * reports `'silent'`, which is what a caller inspecting the threshold expects
 * either way.
 *
 * @param config - the validated service configuration; its `logLevel` is the
 *   threshold unless `options.level` overrides it
 * @param options - test and embedding seams; see {@link ServiceLoggerOptions}
 * @returns a frozen `Logger`; never throws, and never `null`
 */
export function createServiceLogger(
  config: ServiceConfig,
  options: ServiceLoggerOptions = {},
): Logger {
  const level = resolveLevel(options.level ?? config.logLevel);
  if (level === 'silent') {
    return noopLogger;
  }

  const root = options.pinoLogger ?? createPinoLogger(level, options.destination);
  const bindings = options.bindings;
  const bound = bindings === undefined ? root : root.child(scrubLogFields(bindings));

  return createAdapter(bound, level);
}

/**
 * Derives the child logger a subsystem uses.
 *
 * Deliberately thin — one binding under the standardised name — so a
 * subsystem receives a `Logger` and nothing pino-specific, and so `store`,
 * `pipeline` and `telemetry` cannot spell the same field three ways.
 *
 * @param parent - usually the root from {@link createServiceLogger}
 * @param subsystem - conventionally the module's source folder name
 */
export function subsystemLogger(parent: Logger, subsystem: string): Logger {
  return parent.child({ [LOG_BINDING_KEYS.subsystem]: subsystem });
}

/**
 * Derives the child logger a session's work uses.
 *
 * `captureId` is bound only when a capture is active, so a record never
 * claims to belong to one that does not exist.
 */
export function sessionLogger(parent: Logger, sessionId: string, captureId?: string): Logger {
  const bindings: LogFields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
  if (captureId !== undefined) {
    bindings[LOG_BINDING_KEYS.captureId] = captureId;
  }
  return parent.child(bindings);
}
