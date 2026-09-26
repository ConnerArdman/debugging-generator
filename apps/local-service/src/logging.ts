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
 *    and by the colocated suite in `./logging.test.ts`, which asserts the
 *    emitted record for every level, binding and redaction class here.
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
 *      string appearing *anywhere* in a value — including inside a
 *      `DebuggenError`'s details, or inside a rejected model payload that
 *      `@debuggen/model-provider`'s `structured.ts` logs through this very
 *      logger. Layer 2 also owns the one name rule the telemetry vocabulary
 *      has no reason to carry: a database connection URL
 *      ({@link SERVICE_DATABASE_URL_KEY_NAMES}), which AAP §0.5.2 forbids
 *      capturing at all and which no content rule recognises once it carries
 *      no credentials.
 *    The message string is scrubbed too: it is cheap and it catches a
 *    credential interpolated into text by a library.
 *
 *    **Exceptions** get a treatment of their own, because neither layer can
 *    make their free text safe: `scrub` recognises credential *shapes*, and
 *    an exception's `message`, `stack` and even its `name` carry whatever the
 *    failing code was handed — a URL whose query holds an e-mail address, an
 *    inline SQL literal, a compiler's source excerpt — and so do a
 *    `DebuggenError`'s `hint` and `details`, which a caller fills from the
 *    same values. So an error is emitted in a **closed shape** (see
 *    {@link serializeError}): at `info`, `warn`, `error` and `fatal` it is
 *    `{ type, code?, details?, detailsOmitted?, cause? }` — its
 *    {@link EXCEPTION_CLASSES} label, its closed-vocabulary code, for a
 *    `DebuggenError` only the flat, closed-token entries of its `details`
 *    ({@link CLOSED_DETAIL_KEY_PATTERN}, {@link CLOSED_DETAIL_TOKEN_PATTERN})
 *    with a count of what was left out, and its `cause` chain in the same
 *    shape — never a message, a stack or a hint. Only at `debug` and `trace`
 *    ({@link DIAGNOSTIC_LOG_LEVELS}), which a developer opts into, are the
 *    message, the stack, the hint and the full details added, and then only
 *    after {@link redactDiagnosticText} has masked URL query values,
 *    parameterised SQL literals and removed source codeframes from every
 *    string of them. A thrown non-`Error` under {@link LOG_ERROR_FIELD_KEY} is
 *    `{ "type": "NonError" }`, never its own text.
 * 3. **Standardise the bindings.** {@link LOG_BINDING_KEYS} fixes the names
 *    the eleven subsystems bind (`subsystem`, `sessionId`, `captureId`,
 *    `client`) so the output of a whole session is greppable.
 * 4. **Never throw.** A log call runs where a caller is already handling a
 *    failure, so a logger that throws there skips whatever the caller does
 *    next. {@link guardLogger} wraps every logger this module builds — and is
 *    exported for any subsystem handed a logger it did not build — so a failed
 *    write or `child()` is counted and announced through a rate-limited, fixed
 *    fallback notice instead of propagating. {@link describeException} is the
 *    closed taxonomy a thrown value is named by in a record — by the error
 *    serializer here and by any call site that names a failure in its own
 *    fields — so no record copies an exception's own `name` or `message`.
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
  LOG_LEVEL_VALUES,
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
  asScannableText,
  cutAtCredentialBoundary,
  isSensitiveKeyName,
  normalizeSqlStatement,
  redactSqlStatement,
  redactStackUrls,
  redactUrl,
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
 *
 * Whatever sits under this key — at the top of a record or nested at any
 * depth — is emitted in the closed error shape of {@link serializeError},
 * including a value that is not an `Error` at all: a thrown string, number or
 * plain object becomes `{ "type": "NonError" }` rather than its own text,
 * because `catch` binds whatever was thrown and a thrown string is as free as
 * an error message.
 *
 * The shape, by level:
 *
 * - `info`, `warn`, `error`, `fatal`:
 *   `{ type, code?, details?, detailsOmitted?, cause? }`, where `details`
 *   (a `DebuggenError` only) holds closed-token entries alone and
 *   {@link DETAILS_OMITTED_KEY} counts the entries withheld.
 * - `debug`, `trace` ({@link DIAGNOSTIC_LOG_LEVELS}): additionally `message`
 *   and `stack`, and for a `DebuggenError` `hint` and the full `details`,
 *   every string redacted by {@link redactDiagnosticText}.
 */
export const LOG_ERROR_FIELD_KEY = 'err';

/**
 * The levels at which an error's redacted `message` and `stack` — and a
 * `DebuggenError`'s redacted `hint` and full `details` — are emitted.
 *
 * Every other level — `info`, `warn`, `error`, `fatal` — is the default
 * operating range of the service and receives the closed error shape only
 * (see {@link serializeError}). `debug` and `trace` are opt-in
 * (`DEBUGGEN_LOG_LEVEL`), read by a developer diagnosing the service itself,
 * and are where the detail a closed label cannot carry is worth its cost; even
 * there the text first passes {@link redactDiagnosticText}.
 */
export const DIAGNOSTIC_LOG_LEVELS: readonly LogLevel[] = Object.freeze([
  'trace',
  'debug',
] as const);

/**
 * The longest redacted diagnostic text — one error `message` or `stack` —
 * a record carries, in UTF-16 code units, the truncation marker included.
 *
 * A stack is a few kilobytes at most; anything beyond this is a message that
 * embeds a payload, and the payload is exactly what a record must not carry.
 */
export const DIAGNOSTIC_TEXT_MAX_LENGTH = 4_096;

/**
 * The longest key, and the longest string value, of a `DebuggenError`
 * `details` entry emitted at `info`, `warn`, `error` or `fatal`, in UTF-16
 * code units.
 *
 * The bound is part of what makes such an entry content-free: an identifier,
 * a state name or a code fits in it, while a sentence, a statement or a
 * serialised payload does not. It is also checked before either grammar below
 * is run, so an adversarially long string costs one length comparison.
 */
export const CLOSED_DETAIL_MAX_LENGTH = 64;

/**
 * The grammar a `DebuggenError` `details` **key** must match to be emitted at
 * a non-diagnostic level: an ASCII letter followed by at most 63 letters,
 * digits or underscores (`reason`, `planVersion`, `activePlan_version`).
 *
 * A key is emitted verbatim, so it is held to the same standard as a value:
 * a key that is a URL, a path or a sentence (`{ '/api/items?email=…': 1 }`)
 * fails the grammar and its entry is omitted. Frozen, and without the `g` or
 * `y` flag, so `test` never writes `lastIndex` and the shared instance is
 * safe to reuse.
 */
export const CLOSED_DETAIL_KEY_PATTERN: Readonly<RegExp> = Object.freeze(
  /^[A-Za-z][A-Za-z0-9_]{0,63}$/u,
);

/**
 * The grammar a `DebuggenError` `details` **string value** must match to be
 * emitted at a non-diagnostic level — a closed token, one of:
 *
 * - a **lower-case identifier**: a letter, then letters and digits, in
 *   segments joined by a single `-`, `_` or `.` — `probe-failed`,
 *   `state-tree`, `generate-panel`, `ses_4k2p9dq7m1zx0c3v`;
 * - an **upper-case code**: `UPPER_SNAKE` — `ENOENT`, `STORE_ERROR`,
 *   `ERR_INVALID_URL`, `DEBUGGEN_PORT`.
 *
 * Neither admits whitespace, `/`, `?`, `=`, a quote or a `|`, so no URL, query,
 * SQL statement, file path, codeframe line or prose sentence can match; a
 * leading letter keeps a bare number (a phone number, an account number)
 * out as well. A token that matches is still passed through `scrub` and
 * emitted only if `scrub` leaves it unchanged, so a credential with a
 * recognised shape — an `AKIA…` access key id is valid `UPPER_SNAKE` — never
 * travels on the grammar alone. Every segment begins after exactly one
 * separator, so matching is linear in the (already bounded) length.
 */
export const CLOSED_DETAIL_TOKEN_PATTERN: Readonly<RegExp> = Object.freeze(
  /^(?:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)$/u,
);

/**
 * The key, beside `details` in a serialised `DebuggenError`, counting the
 * `details` entries a non-diagnostic record left out.
 *
 * A sibling of `details` rather than an entry inside it, so it can never
 * collide with a genuine detail of the same name, and present only when at
 * least one entry was omitted, so a reader can tell "no further context" from
 * "context withheld" without the withheld text.
 */
export const DETAILS_OMITTED_KEY = 'detailsOmitted';

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
  /**
   * How a failing destination is announced; see {@link guardLogger}. The
   * returned logger never throws whatever this says — the policy only decides
   * where the notice goes and how often.
   */
  readonly failurePolicy?: LogFailurePolicy;
}

/**
 * How one {@link scrubLogFields} call treats the exceptions it finds.
 *
 * The default is the safe one, so a caller that passes nothing — a child
 * binding, a root binding, any direct use — can only ever produce the closed
 * error shape.
 */
export interface ScrubLogFieldsOptions {
  /**
   * Whether an error additionally carries its `message` and `stack`, a
   * `DebuggenError` its `hint` and its full `details`, and a thrown string its
   * text — every string of them redacted by {@link redactDiagnosticText}.
   * Without it a `DebuggenError` carries no `hint` and only the closed-token
   * entries of its `details` (see {@link serializeError}). The adapter sets it
   * only for a record at one of the {@link DIAGNOSTIC_LOG_LEVELS}. Defaults to
   * `false`.
   */
  readonly diagnostics?: boolean;
}

/**
 * Mutable accounting, and the one policy decision, shared across one
 * {@link scrubLogFields} walk.
 *
 * The policy travels with the budget rather than as another parameter of
 * every walk function because both are properties of the *walk*, not of any
 * one value in it: every record, container and error it reaches is treated
 * under the level the record is being written at.
 */
interface ScrubBudget {
  /** Remaining nodes the walk may emit. */
  nodes: number;
  /** Whether any bound was reached, which surfaces as the truncated flag. */
  bounded: boolean;
  /** {@link ScrubLogFieldsOptions.diagnostics}, resolved to a boolean. */
  readonly diagnostics: boolean;
  /**
   * Whether the subtree being walked is exception text, whose strings are
   * redacted by {@link redactDiagnosticText} — URL query values, SQL literals
   * and codeframes as well as credentials — rather than by `scrub` alone.
   *
   * Set only while {@link serializeError} walks a `DebuggenError`'s `details`
   * at a diagnostic level, and restored to its previous value when that walk
   * ends, so a nested error's details nest correctly and no ordinary field of
   * the record is ever walked under it. Mutable, and carried by the budget,
   * because it is a property of the current position in the walk rather than
   * of any one value.
   */
  diagnosticText: boolean;
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
 * Every `Error` in the bag, and every value under {@link LOG_ERROR_FIELD_KEY},
 * is emitted in the closed shape of {@link serializeError}; `options` decides
 * only whether the redacted diagnostic text — an error's `message` and
 * `stack`, a `DebuggenError`'s `hint` and full `details` — is added to it.
 *
 * @param fields The caller's bag, left untouched.
 * @param options The exception policy; when omitted, errors carry the closed
 *   shape only.
 * @returns A new bag with denied values masked and every string scanned.
 *
 * @example
 * ```ts
 * scrubLogFields({ [LOG_ERROR_FIELD_KEY]: Object.assign(new Error('…'), { code: 'EADDRINUSE' }) });
 * // { err: { type: 'SystemError', code: 'EADDRINUSE' } }
 * scrubLogFields({ [LOG_ERROR_FIELD_KEY]: 'thrown text' }, { diagnostics: true });
 * // { err: { type: 'NonError', message: 'thrown text' } }
 * ```
 */
export function scrubLogFields(fields: LogFields, options: ScrubLogFieldsOptions = {}): LogFields {
  const budget: ScrubBudget = {
    nodes: MAX_ATTRIBUTE_NODES,
    bounded: false,
    diagnostics: options.diagnostics === true,
    diagnosticText: false,
  };
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
 * Inside exception text ({@link ScrubBudget.diagnosticText}) a key is data as
 * much as a value is, so it is emitted under {@link diagnosticKeyOf}; the name
 * rules of {@link scrubValue} still judge the key as the source wrote it.
 *
 * @param source The record being copied.
 * @param depth The record's own depth; the root bag is 0.
 * @param budget Shared node accounting.
 * @param seen Containers on the path from the root, for cycle detection.
 * @param top Whether this is the record pino merges, where its own keys
 *   (`level`, `time`, `msg`) and the prototype-derived names must not be
 *   collided with.
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
    const name = budget.diagnosticText ? diagnosticKeyOf(key) : key;
    if (value === READ_FAILED) {
      keys += 1;
      result[reserveKey(name, result, top)] = LOG_MARKERS.unserializable;
      continue;
    }
    if (value === undefined) {
      // Omit the key rather than emit `undefined`, matching the shared
      // logger, which omits an absent binding instead of naming it.
      continue;
    }
    keys += 1;
    result[reserveKey(name, result, top)] = scrubValue(key, value, depth + 1, budget, seen);
  }

  return result;
}

/**
 * The name a key of exception text is emitted under: the key itself when it
 * is a {@link CLOSED_DETAIL_KEY_PATTERN} identifier, which no redaction pass
 * would change, and its {@link redactDiagnosticText} form otherwise, so a
 * `details` bag keyed by URL or by statement cannot carry the query value or
 * the literal in its key. Two keys that redact to one name keep the later
 * value — over-masking, never disclosure.
 */
function diagnosticKeyOf(key: string): string {
  return isClosedDetailKey(key) ? key : redactDiagnosticText(key);
}

/** Whether a key matches {@link CLOSED_DETAIL_KEY_PATTERN} within {@link CLOSED_DETAIL_MAX_LENGTH}. */
function isClosedDetailKey(key: string): boolean {
  return key.length <= CLOSED_DETAIL_MAX_LENGTH && CLOSED_DETAIL_KEY_PATTERN.test(key);
}

/**
 * Whether a string is a closed token a non-diagnostic record may carry: within
 * {@link CLOSED_DETAIL_MAX_LENGTH}, matching {@link CLOSED_DETAIL_TOKEN_PATTERN},
 * and left unchanged by `scrub`, so a credential shape the grammar admits is
 * still refused.
 */
function isClosedDetailToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= CLOSED_DETAIL_MAX_LENGTH &&
    CLOSED_DETAIL_TOKEN_PATTERN.test(value) &&
    scrub(value) === value
  );
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
 * Whether a field under this name is the error field, {@link LOG_ERROR_FIELD_KEY}.
 *
 * Matched on the whole key or its last dotted segment, like every other name
 * rule here, so `upstream.err` is an error field too.
 */
function isErrorFieldKey(key: string): boolean {
  return key === LOG_ERROR_FIELD_KEY || lastSegmentOf(key) === LOG_ERROR_FIELD_KEY;
}

/**
 * Scrubs one value, dispatching on its name first and its type second.
 *
 * Name beats type: a denied name masks the value whatever shape it has, which
 * is the only ordering that cannot be defeated by wrapping a credential in an
 * object. The error field is a name rule of the same kind: whatever sits
 * there is a thrown value and takes the closed error shape, so a thrown
 * string cannot travel as ordinary text.
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
    if (isErrorFieldKey(key)) {
      return scrubThrown(value, depth, budget, seen);
    }
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
 *
 * A string inside exception text ({@link ScrubBudget.diagnosticText}) is
 * redacted by {@link redactDiagnosticText} instead: `scrub` recognises only
 * credential shapes, and a `DebuggenError`'s details are as likely as its
 * message to hold a URL query value, a SQL literal or a codeframe line.
 */
function scrubUnnamedValue(
  value: unknown,
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
): unknown {
  switch (typeof value) {
    case 'string':
      return budget.diagnosticText ? redactDiagnosticText(value) : scrub(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value}`;
    case 'symbol':
      return budget.diagnosticText
        ? redactDiagnosticText(value.toString())
        : scrub(value.toString());
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

/** The escape code that opens every terminal control sequence. */
const ESCAPE_CODE = 0x1b;

/** The bell that may terminate an OSC (`ESC ]`) sequence. */
const BELL_CODE = 0x07;

/** The horizontal tab: the one C0 control a diagnostic line keeps. */
const TAB_CODE = 0x09;

/** The first code unit that is not a C0 control. */
const FIRST_PRINTABLE_CODE = 0x20;

/** `DEL`, which no diagnostic line keeps either. */
const DELETE_CODE = 0x7f;

/**
 * The select-graphic-rendition sequence TypeScript's `--pretty` diagnostics
 * open a codeframe's line-number gutter with (inverse video). Recognised on
 * the raw line, before control sequences are stripped, because once the
 * colour is gone that gutter is an ordinary number at the start of a line.
 */
const INVERSE_VIDEO_GUTTER = '\u001b[7m';

/** Every line end a tool may write: `\r\n`, a lone `\r`, and `\n`. */
const DIAGNOSTIC_LINE_BREAK = /\r\n|\r|\n/u;

/**
 * A codeframe **source line**: an optional pointer (`>` for Babel and
 * Next.js, `→` and `❯` for Prisma- and Vite-style frames), a line number,
 * and a gutter bar (`|` for Babel, Next.js and Vite; `│` and its variants for
 * esbuild). Everything right of the bar is the developer's source.
 */
const CODEFRAME_SOURCE_LINE = /^\s*(?:[>→❯]\s*)?\d{1,7}\s*[|│┃┆╎]/u;

/**
 * A codeframe **gutter line** with no line number: the `   | ^^^` pointer
 * row of a Babel frame, and esbuild's `│ ^` and `╵ ;` rows. It carries no
 * source of its own, but it is part of the excerpt and meaningless without
 * it.
 */
const CODEFRAME_GUTTER_LINE = /^\s*(?:[>→❯]\s*)?[|│┃┆╎╵╷](?:\s|$)/u;

/** A line of nothing but carets or tildes: a pointer row or TypeScript's squiggle. */
const CODEFRAME_POINTER_LINE = /^\s*[\^~]+\s*$/u;

/**
 * A V8 stack frame line, `    at fn (file:line:column)`. A frame is structure
 * the runtime wrote, never a SQL statement, and its `:line:column` digits are
 * exactly what the SQL scanner would mask as numeric literals.
 */
const STACK_FRAME_LINE = /^\s*at\s/u;

/**
 * An upper-case SQL keyword. Upper case is how an ORM, a driver and a
 * developer all write a statement and how prose almost never does, so any one
 * of these marks the start of a statement on its own.
 */
const SQL_UPPER_CASE_KEYWORD =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE|UPSERT|WITH|VALUES|FROM|WHERE|SET|JOIN|AND|OR|HAVING|RETURNING|LIMIT|OFFSET|ORDER\s+BY|GROUP\s+BY|ON\s+CONFLICT)\b/u;

/**
 * A statement opener in any case. Lower-case `select` and `update` are also
 * English, so an opener starts a statement only when one of
 * {@link SQL_CLAUSE_KEYWORD} follows it on the same line.
 */
const SQL_STATEMENT_OPENER = /\b(?:select|insert|update|delete|merge|with)\b/iu;

/** The clause keywords that confirm {@link SQL_STATEMENT_OPENER}. */
const SQL_CLAUSE_KEYWORD = /\b(?:from|into|where|set|values|returning|join)\b/iu;

/**
 * A maximal run of characters a URL may consist of. A URL a runtime prints
 * never spans whitespace, a quote, an angle bracket or a backtick, so every
 * URL lies inside one such token, and matching tokens rather than URLs keeps
 * the pass linear: a greedy run cannot overlap the next one.
 */
const URL_TOKEN = /[^\s"'<>`]+/gu;

/**
 * The start of an absolute URL of a scheme other than `http`/`https` —
 * `ws://127.0.0.1:43117/ws?…`, a driver's DSN parameters. `http`/`https` are
 * excluded because `redactStackUrls` owns them and keeps a stack frame's
 * `:line:column` where this pass could not. The scheme is bounded, so each
 * position costs a constant number of steps.
 */
const OTHER_SCHEME_URL_START = /\b(?!https?:)[a-z][a-z0-9+.-]{0,31}:\/\//iu;

/**
 * The start of an origin-relative URL, as a router or a fetch failure prints
 * one (`/api/items?email=…`): a `/` at the start of a token or directly after
 * a bracket, `=` or `,`. The path of an absolute URL — already masked — is
 * never preceded by one of those, so it is not matched a second time.
 */
const RELATIVE_URL_START = /(?:^|[([=,])\//u;

/** A query or fragment delimiter. */
const QUERY_OR_FRAGMENT = /[?#]/u;

/**
 * Punctuation that ends a sentence or a bracket rather than a URL. `?` is not
 * in the set: it is the query delimiter this pass exists to find.
 */
const URL_TRAILING_PUNCTUATION = /[)\]}>,;.]+$/u;

/**
 * Returns the index of the last code unit of the terminal escape sequence
 * starting at `start`: a CSI (`ESC [ … final`), an OSC (`ESC ] … BEL` or
 * `ESC ] … ESC \`) or a two-character escape. An unterminated sequence runs to
 * the end of the text, which is dropped with it.
 */
function endOfEscapeSequence(text: string, start: number): number {
  const introducer = text[start + 1];
  if (introducer === '[') {
    let end = start + 2;
    while (end < text.length) {
      const final = text.charCodeAt(end);
      if (final >= 0x40 && final <= 0x7e) {
        return end;
      }
      end += 1;
    }
    return end;
  }
  if (introducer === ']') {
    let end = start + 2;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (code === BELL_CODE) {
        return end;
      }
      if (code === ESCAPE_CODE && text[end + 1] === '\\') {
        return end + 1;
      }
      end += 1;
    }
    return end;
  }
  return start + 1;
}

/**
 * Removes terminal control sequences and C0 controls (tab excepted) from one
 * line. Codeframes and compiler output are usually coloured; the gutter
 * patterns, the SQL scanner and a reader all want the text.
 */
function stripTerminalControls(line: string): string {
  let result = '';
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code === ESCAPE_CODE) {
      index = endOfEscapeSequence(line, index);
      continue;
    }
    if ((code < FIRST_PRINTABLE_CODE && code !== TAB_CODE) || code === DELETE_CODE) {
      continue;
    }
    result += line.charAt(index);
  }
  return result;
}

/** Whether a line belongs to a source codeframe; `raw` still carries its colour. */
function isCodeframeLine(raw: string, visible: string): boolean {
  return (
    raw.trimStart().startsWith(INVERSE_VIDEO_GUTTER) ||
    CODEFRAME_SOURCE_LINE.test(visible) ||
    CODEFRAME_GUTTER_LINE.test(visible) ||
    CODEFRAME_POINTER_LINE.test(visible)
  );
}

/**
 * Strips control sequences from every line and replaces each run of codeframe
 * lines with one {@link LOG_MARKERS.redacted} line, so a reader still sees
 * where an excerpt was and never what it said.
 */
function removeSourceExcerpts(lines: readonly string[]): string[] {
  const result: string[] = [];
  let inExcerpt = false;
  for (const raw of lines) {
    const visible = stripTerminalControls(raw);
    if (isCodeframeLine(raw, visible)) {
      if (!inExcerpt) {
        result.push(LOG_MARKERS.redacted);
        inExcerpt = true;
      }
      continue;
    }
    inExcerpt = false;
    result.push(visible);
  }
  return result;
}

/** Peels trailing sentence punctuation off a URL run and masks the URL. */
function maskUrlRun(run: string): string {
  const trailing = URL_TRAILING_PUNCTUATION.exec(run)?.[0] ?? '';
  const url = trailing.length === 0 ? run : run.slice(0, run.length - trailing.length);
  return redactUrl(url) + trailing;
}

/**
 * Where the URL a token carries starts, or `undefined` when it carries none
 * that has a value to mask: an other-scheme URL with a query or fragment, or
 * an origin-relative URL with a query. The earlier of the two wins, and the
 * URL runs to the end of the token.
 */
function urlStartIn(token: string): number | undefined {
  let start: number | undefined;
  const absolute = OTHER_SCHEME_URL_START.exec(token);
  if (absolute !== null && QUERY_OR_FRAGMENT.test(token.slice(absolute.index))) {
    start = absolute.index;
  }
  const relative = RELATIVE_URL_START.exec(token);
  if (relative !== null) {
    const slash = relative.index + relative[0].length - 1;
    if ((start === undefined || slash < start) && token.includes('?', slash)) {
      start = slash;
    }
  }
  return start;
}

/** Masks the URL inside one {@link URL_TOKEN}, leaving the text before it as it was. */
function maskUrlToken(token: string): string {
  if (!QUERY_OR_FRAGMENT.test(token)) {
    return token;
  }
  const start = urlStartIn(token);
  return start === undefined ? token : token.slice(0, start) + maskUrlRun(token.slice(start));
}

/**
 * Masks every URL query value in the text by `@debuggen/telemetry`'s own URL
 * rules (AAP §0.5.2: values become `?`, keys and paths stay): absolute
 * `http`/`https` URLs through `redactStackUrls`, which keeps a stack frame's
 * position, then any other scheme and origin-relative URLs through
 * `redactUrl`.
 */
function maskUrlQueries(text: string): string {
  return redactStackUrls(text).replace(URL_TOKEN, maskUrlToken);
}

/** Whether a line ends a SQL statement block: a blank line or a stack frame. */
function isStatementBoundary(line: string): boolean {
  return line.trim().length === 0 || STACK_FRAME_LINE.test(line);
}

/** Where a SQL statement starts on a line, or `undefined` when none does. */
function sqlStatementStart(line: string): number | undefined {
  let start = SQL_UPPER_CASE_KEYWORD.exec(line)?.index;
  const opener = SQL_STATEMENT_OPENER.exec(line);
  if (
    opener !== null &&
    (start === undefined || opener.index < start) &&
    SQL_CLAUSE_KEYWORD.test(line.slice(opener.index + opener[0].length))
  ) {
    start = opener.index;
  }
  return start;
}

/**
 * Parameterises every SQL statement in the text by `@debuggen/telemetry`'s
 * statement scanner (AAP §0.5.2: inline literals become `?`).
 *
 * A statement runs from its first keyword to the next blank line or stack
 * frame, and the whole block is scanned as one statement, so a string literal
 * spanning lines is masked whole rather than line by line. Text before the
 * keyword on the first line is left as it was; the stack frames after the
 * block keep their positions.
 */
function parameteriseSqlStatements(lines: readonly string[]): string[] {
  const result: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const start = isStatementBoundary(line) ? undefined : sqlStatementStart(line);
    if (start === undefined) {
      result.push(line);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !isStatementBoundary(lines[end] ?? '')) {
      end += 1;
    }
    const statement = [line.slice(start), ...lines.slice(index + 1, end)].join('\n');
    result.push(line.slice(0, start) + redactSqlStatement(statement));
    index = end;
  }
  return result;
}

/** Holds redacted text to {@link DIAGNOSTIC_TEXT_MAX_LENGTH}, marking the cut on its own line. */
function boundDiagnosticText(text: string): string {
  if (text.length <= DIAGNOSTIC_TEXT_MAX_LENGTH) {
    return text;
  }
  const room = DIAGNOSTIC_TEXT_MAX_LENGTH - LOG_MARKERS.truncated.length - 1;
  return `${cutAtCredentialBoundary(text, room)}\n${LOG_MARKERS.truncated}`;
}

/**
 * Redacts an exception's free text — a `message` or a `stack` — for a
 * `debug`/`trace` record, by context rather than by credential shape alone.
 *
 * `scrub` removes what *looks like* a credential; an exception's text is
 * dangerous for what it *contains*: a request URL whose query carries an
 * e-mail address, a statement with an inline literal, a compiler's excerpt of
 * the developer's source. Each is recognised by its context and removed with
 * the product's own redaction rules, in this order:
 *
 * 1. **Credentials**, by `scrub`, first — cutting or splitting text before
 *    scrubbing can separate a credential from the pattern that recognises
 *    it. This also bounds the input to the redaction layer's scan length.
 * 2. **Source codeframes** (Babel, Next.js, Vite, esbuild and TypeScript
 *    `--pretty` gutters: `> 12 | …`, `   | ^`, `  13 | …`, `│ …`) are removed,
 *    each run of them replaced by one {@link LOG_MARKERS.redacted} line, and
 *    terminal colour and control characters are stripped.
 * 3. **URL query values** are masked to `?` by `redactStackUrls` and
 *    `redactUrl`; paths, hosts and a frame's `:line:column` stay.
 * 4. **SQL literals** in any SQL-looking statement are parameterised to `?` by
 *    `redactSqlStatement`; stack frames are never read as SQL.
 * 5. `scrub` again, because a pass may have re-joined text, and the result is
 *    bounded to {@link DIAGNOSTIC_TEXT_MAX_LENGTH}.
 *
 * What survives is what a stack is for — the error's wording where it
 * carries no data, function names, files and positions. Over-masking is the
 * accepted failure mode: an apostrophe in prose after a SQL keyword masks the
 * rest of that line, which costs readability, never data.
 *
 * Total: any value is accepted (a non-string through `asScannableText`, so an
 * object or `null` becomes the redaction marker without a property of it being
 * read) and nothing throws.
 *
 * @param text An exception's `message` or `stack`, or a thrown string.
 * @returns The redacted, bounded text.
 *
 * @example
 * ```ts
 * redactDiagnosticText("GET /api/items?email=ada@example.com failed: SELECT id FROM account WHERE email = 'ada@example.com'");
 * // "GET /api/items?email=? failed: SELECT id FROM account WHERE email = ?"
 * ```
 */
export function redactDiagnosticText(text: unknown): string {
  try {
    const scrubbed = scrub(asScannableText(text));
    if (scrubbed.length === 0) {
      return scrubbed;
    }
    const withoutExcerpts = removeSourceExcerpts(scrubbed.split(DIAGNOSTIC_LINE_BREAK));
    const withoutQueries = maskUrlQueries(withoutExcerpts.join('\n'));
    const parameterised = parameteriseSqlStatements(withoutQueries.split('\n')).join('\n');
    return boundDiagnosticText(scrub(parameterised));
  } catch {
    // Every primitive above is total; this is the backstop that keeps a log
    // call alive should that ever stop being true.
    return LOG_MARKERS.unserializable;
  }
}

/**
 * The closed shape of a thrown value that is not an `Error`: its class, and at
 * a diagnostic level the redacted text of a thrown string. A number, `null` or
 * plain object thrown carries nothing else, at any level — a plain object's
 * `message` is exactly as free as an error's.
 */
function serializeNonError(value: unknown, budget: ScrubBudget): LogFields {
  const result: LogFields = { type: NON_ERROR_EXCEPTION.errorClass };
  if (budget.diagnostics && typeof value === 'string' && value.length > 0) {
    result.message = redactDiagnosticText(value);
  }
  return result;
}

/**
 * Serialises a thrown value — the value under {@link LOG_ERROR_FIELD_KEY}, or
 * an error's `cause` — in the closed shape, whatever it is.
 *
 * An `Error` goes through {@link scrubContainer}, so the depth bound and the
 * cycle cut apply to it like to any container; anything else takes
 * {@link serializeNonError}. A value whose prototype cannot even be inspected
 * is reported as {@link LOG_MARKERS.unserializable} in its own place.
 */
function scrubThrown(
  value: unknown,
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
): unknown {
  let error: Error | undefined;
  try {
    error = value instanceof Error ? value : undefined;
  } catch {
    // `instanceof` consults a `Proxy`'s `getPrototypeOf` trap, which may throw.
    return LOG_MARKERS.unserializable;
  }
  return error === undefined
    ? serializeNonError(value, budget)
    : scrubContainer(error, depth, budget, seen);
}

/**
 * Serialises an error into the one error shape this log emits: a **closed**
 * shape, so what an exception says about itself never reaches a record at
 * the service's operating levels.
 *
 * At `info`, `warn`, `error` and `fatal` the shape is
 * `{ type, code?, details?, detailsOmitted?, cause? }`:
 *
 * - `type` — the error's {@link EXCEPTION_CLASSES} label from
 *   {@link describeException}, never its own `name`, which is a writable
 *   property an error this service did not author can fill with anything.
 * - `code` — present when the error carries a closed-vocabulary code: a
 *   `DebuggenError` code, or a Node errno / `ERR_*` code (`EADDRINUSE`).
 * - `details` — a `DebuggenError` only, and only its **closed-token** entries
 *   ({@link closeDetails}): a flat object of the entries whose key matches
 *   {@link CLOSED_DETAIL_KEY_PATTERN}, whose name no redaction rule denies,
 *   and whose value is a finite number, a boolean or a
 *   {@link CLOSED_DETAIL_TOKEN_PATTERN} string — `{ reason: 'probe-failed',
 *   count: 3 }`. Nested objects, arrays and every other string are omitted,
 *   `details` itself is absent when nothing qualifies, and
 *   {@link DETAILS_OMITTED_KEY} counts what was left out. The
 *   `DebuggenErrorOptions.details` contract asks callers for privacy-safe
 *   context, but a URL, a statement or a codeframe line that reaches it
 *   anyway is ordinary text to `scrub`, so the operating levels do not rely
 *   on the contract.
 * - `cause` — the cause in this same shape (a non-`Error` cause as
 *   `{ type: 'NonError' }`), one level deeper, so a chain is cut by the depth
 *   bound and each link costs a node of the budget. A `DebuggenError` cause
 *   is closed by these same rules, since it is serialised by this function.
 *
 * A `DebuggenError`'s `hint` is **never** emitted at those levels: it is free
 * text, and the product's recovery copy reaches the developer through the
 * protocol's `error` payload, not through the log.
 *
 * At {@link DIAGNOSTIC_LOG_LEVELS} only, the free text is added, all of it
 * redacted by {@link redactDiagnosticText} (URL query values, SQL literals,
 * codeframes and credentials): the error's `message` and `stack`, and for a
 * `DebuggenError` its `hint` and its full `details`, walked by the ordinary
 * bounded value walk — depth, node and key bounds, cycle cut and name rules
 * unchanged — with every string leaf, and every key outside
 * {@link CLOSED_DETAIL_KEY_PATTERN}, redacted the same way
 * ({@link ScrubBudget.diagnosticText}).
 *
 * Every property is read under a guard — the record walk's `readProperty`
 * here, `describeException`'s own for the label — and no method of the error
 * is invoked (not even a `DebuggenError`'s `toPayload`), so one hostile getter
 * costs one field, never the record; a `details` that refuses to be read is
 * {@link LOG_MARKERS.unserializable} at every level.
 *
 * @example
 * ```ts
 * // log.error('bind failed', { err: Object.assign(new Error('listen …'), { code: 'EADDRINUSE' }) })
 * // "err":{"type":"SystemError","code":"EADDRINUSE"}
 * // log.warn('probe failed', { err: new DebuggenError('AGENT_NOT_READY', '…', {
 * //   hint: 'Reload /app?user=…', details: { reason: 'probe-failed', url: '/app?user=…' } }) })
 * // "err":{"type":"DebuggenError","code":"AGENT_NOT_READY",
 * //        "details":{"reason":"probe-failed"},"detailsOmitted":1}
 * // log.debug(…) additionally carries the redacted "hint", "message" and
 * // "stack", and "details" with "url":"/app?user=?".
 * ```
 */
function serializeError(
  error: Error,
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
): LogFields {
  const described = describeException(error);
  const result: LogFields = { type: described.errorClass };
  if (described.errorCode !== undefined) {
    result.code = described.errorCode;
  }

  if (described.errorClass === 'DebuggenError') {
    if (budget.diagnostics) {
      addDiagnosticContext(error, result, depth, budget, seen);
    } else {
      addClosedDetails(error, result, budget);
    }
  }

  if (budget.diagnostics) {
    const message = readProperty(error, 'message');
    result.message =
      message === READ_FAILED ? LOG_MARKERS.unserializable : redactDiagnosticText(message);
    const stack = readProperty(error, 'stack');
    if (stack === READ_FAILED) {
      result.stack = LOG_MARKERS.unserializable;
    } else if (typeof stack === 'string' && stack.length > 0) {
      result.stack = redactDiagnosticText(stack);
    }
  }

  const cause = readProperty(error, 'cause');
  if (cause === READ_FAILED) {
    result.cause = LOG_MARKERS.unserializable;
  } else if (cause !== undefined) {
    result.cause = scrubCause(cause, depth, budget, seen);
  }

  return result;
}

/**
 * What {@link closeDetails} keeps of a `DebuggenError`'s `details`.
 *
 * `entries` is `undefined` rather than an empty object when nothing
 * qualified, so the caller omits `details` altogether instead of emitting a
 * `{}` that reads as "the error had no context".
 */
interface ClosedDetails {
  /** The approved entries, in source order; `undefined` when none qualified. */
  readonly entries: LogFields | undefined;
  /** How many entries were left out, those beyond the key or node bound included. */
  readonly omitted: number;
}

/**
 * Adds a `DebuggenError`'s closed-token `details`, and the count of what was
 * left out, to its serialised shape at a non-diagnostic level. The `hint` is
 * deliberately not read: it is never emitted at these levels.
 */
function addClosedDetails(error: Error, result: LogFields, budget: ScrubBudget): void {
  const details = readProperty(error, 'details');
  if (details === undefined) {
    return;
  }
  const closed = details === READ_FAILED ? READ_FAILED : closeDetails(details, budget);
  if (closed === READ_FAILED) {
    result.details = LOG_MARKERS.unserializable;
    return;
  }
  if (closed.entries !== undefined) {
    result.details = closed.entries;
  }
  if (closed.omitted > 0) {
    result[DETAILS_OMITTED_KEY] = closed.omitted;
  }
}

/**
 * Reduces a `DebuggenError`'s `details` to the content-free entries a record
 * at `info`, `warn`, `error` or `fatal` may carry.
 *
 * One flat pass, never a walk: an entry is kept only when its key matches
 * {@link CLOSED_DETAIL_KEY_PATTERN}, the key is not one the record walk would
 * mask, drop or normalise (a sensitive, database-URL, body, SQL-statement or
 * error-field name), and its value is a finite number, a boolean or a
 * {@link isClosedDetailToken closed token}. A nested object or array is never
 * descended into, so nothing it holds — however deep — can surface; it is
 * counted as one omitted entry. A non-object `details` (which
 * `DebuggenError.is` refuses, but a getter can still return) is one omitted
 * entry too.
 *
 * Bounded like the walk it replaces: at most `MAX_TRACKED_KEYS` keys are read
 * and each read costs one node of the shared budget; the first bound reached
 * stops the pass, flags the record as truncated and counts every unread key as
 * omitted. Total: enumeration and every read are guarded, and anything else
 * that throws — `Array.isArray` on a revoked `Proxy` — returns `READ_FAILED`,
 * which costs the `details` field only.
 */
function closeDetails(details: unknown, budget: ScrubBudget): ClosedDetails | typeof READ_FAILED {
  try {
    if (!isWalkableObject(details) || isUnknownArray(details)) {
      return { entries: undefined, omitted: 1 };
    }
    const keys = ownKeysOf(details as Readonly<Record<string, unknown>>);
    if (keys === undefined) {
      return READ_FAILED;
    }

    const entries = Object.create(null) as LogFields;
    let kept = 0;
    let omitted = 0;
    let examined = 0;
    for (const key of keys) {
      if (examined >= MAX_TRACKED_KEYS || budget.nodes <= 0) {
        budget.bounded = true;
        omitted += keys.length - examined;
        break;
      }
      examined += 1;
      const value = readProperty(details, key);
      if (value === undefined) {
        // An absent value is no entry at all, exactly as the record walk
        // omits it; there is nothing to count as withheld.
        continue;
      }
      budget.nodes -= 1;
      const approved = value === READ_FAILED ? undefined : closedDetailValue(key, value);
      if (approved === undefined) {
        omitted += 1;
        continue;
      }
      entries[key] = approved;
      kept += 1;
    }
    return { entries: kept === 0 ? undefined : entries, omitted };
  } catch {
    return READ_FAILED;
  }
}

/**
 * The value a closed `details` entry is emitted with, or `undefined` when the
 * entry must be omitted. The key is judged first — by grammar, then by every
 * name rule the record walk applies — so a closed token under `token`,
 * `password`, `databaseUrl`, `body` or `sql` is withheld like any other value
 * under that name.
 */
function closedDetailValue(key: string, value: unknown): string | number | boolean | undefined {
  if (
    !isClosedDetailKey(key) ||
    isErrorFieldKey(key) ||
    isMaskedBodyKey(key) ||
    isSensitiveLogKey(key) ||
    isSqlStatementKey(key)
  ) {
    return undefined;
  }
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return value;
    case 'string':
      return isClosedDetailToken(value) ? value : undefined;
    default:
      return undefined;
  }
}

/**
 * Adds a `DebuggenError`'s `hint` and full `details` to its serialised shape
 * at a diagnostic level, both redacted by {@link redactDiagnosticText}.
 *
 * `details` is walked by the ordinary record walk — its depth, node and key
 * bounds, cycle cut and name rules unchanged — under
 * {@link ScrubBudget.diagnosticText}, which routes every string leaf and every
 * non-identifier key through the context-aware redactor. The flag is restored
 * to its previous value in `finally`, so a `DebuggenError` nested in another's
 * details leaves the outer walk as it found it, and a throw (`Array.isArray` on
 * a revoked `Proxy`) costs the `details` field only.
 */
function addDiagnosticContext(
  error: Error,
  result: LogFields,
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
): void {
  const hint = readProperty(error, 'hint');
  if (hint === READ_FAILED) {
    result.hint = LOG_MARKERS.unserializable;
  } else if (typeof hint === 'string') {
    result.hint = redactDiagnosticText(hint);
  }

  const details = readProperty(error, 'details');
  if (details === READ_FAILED) {
    result.details = LOG_MARKERS.unserializable;
    return;
  }
  const previous = budget.diagnosticText;
  try {
    if (isWalkableObject(details) && !isUnknownArray(details)) {
      budget.diagnosticText = true;
      result.details = scrubRecord(
        details as Readonly<Record<string, unknown>>,
        depth,
        budget,
        seen,
        false,
      );
    }
  } catch {
    result.details = LOG_MARKERS.unserializable;
  } finally {
    budget.diagnosticText = previous;
  }
}

/**
 * Serialises an error's `cause` one level below the error, charging one node
 * of the budget like any other value, so neither a long chain nor a wide one
 * escapes the bounds.
 */
function scrubCause(
  cause: unknown,
  depth: number,
  budget: ScrubBudget,
  seen: WeakSet<object>,
): unknown {
  if (budget.nodes <= 0) {
    budget.bounded = true;
    return LOG_MARKERS.truncated;
  }
  budget.nodes -= 1;
  return scrubThrown(cause, depth + 1, budget, seen);
}

/**
 * The closed taxonomy a thrown value is named by, wherever the service names
 * one: a log field, a collaborator report, a diagnostic summary.
 *
 * An exception's own `name` is **not** safe to emit. It is an ordinary,
 * writable property, so an error this service did not author — a driver
 * error, a compiler diagnostic, an object a dependency threw — can carry any
 * text there, including a path, a statement or a value it was handed.
 * {@link describeException} therefore *maps* a thrown value onto one of these
 * labels and never copies what it read: whatever the value claims, the output
 * is one of the thirteen strings below.
 *
 * - `DebuggenError` — the product's own error, by `DebuggenError.is`.
 * - The nine built-in names — `AbortError` and `TimeoutError` are the
 *   `DOMException` names Node and fetch raise for a cancelled or timed-out
 *   operation; the rest are ECMAScript's own constructors.
 * - `SystemError` — any other `Error` carrying a Node errno-style or internal
 *   `ERR_*` code (`ENOENT`, `EADDRINUSE`, `ERR_INVALID_URL`), which is how
 *   Node reports a failed system call.
 * - `Error` — any other `Error` instance, whatever it named itself.
 * - `NonError` — a thrown string, number, `null` or plain object.
 */
export const EXCEPTION_CLASSES = Object.freeze([
  'DebuggenError',
  'AbortError',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError',
  'SystemError',
  'Error',
  'NonError',
] as const);

/** One label of {@link EXCEPTION_CLASSES}. */
export type ExceptionClass = (typeof EXCEPTION_CLASSES)[number];

/**
 * The built-in names that map one-to-one onto a label of their own. Compared
 * by exact string membership, so a name that merely contains one of these
 * (`TypeError: /home/…`) maps to `Error`, not to `TypeError`.
 */
const NAMED_EXCEPTION_CLASSES: ReadonlySet<string> = new Set<ExceptionClass>([
  'AbortError',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError',
]);

/**
 * The shape of a code a system error may contribute: Node's errno codes
 * (`ENOENT`, `ECONNREFUSED`) and its internal `ERR_*` codes. Upper-case ASCII,
 * digits and underscores only, and bounded, so a code read off a foreign
 * object can carry no path, value or sentence into a record.
 */
const SYSTEM_ERROR_CODE_PATTERN = /^(?:E[A-Z0-9]{1,23}|ERR_[A-Z0-9_]{1,60})$/u;

/**
 * What {@link describeException} reports about a thrown value: fields safe to
 * emit at every level, a progress row and a collaborator report included.
 */
export interface ExceptionDescription {
  /** The value's label in the closed {@link EXCEPTION_CLASSES} taxonomy. */
  readonly errorClass: ExceptionClass;
  /**
   * A closed-vocabulary code, when the value carries one: a `DebuggenError`'s
   * code from `DEBUGGEN_ERROR_CODES`, or a system error's errno / `ERR_*` code
   * matching {@link SYSTEM_ERROR_CODE_PATTERN}. Absent otherwise — an
   * arbitrary `code` property is never copied.
   */
  readonly errorCode?: string;
}

/** The description of a value that could not be classified at all. */
const UNCLASSIFIABLE_EXCEPTION: ExceptionDescription = Object.freeze({ errorClass: 'Error' });

/** The description of a thrown non-`Error` value. */
const NON_ERROR_EXCEPTION: ExceptionDescription = Object.freeze({ errorClass: 'NonError' });

/**
 * Classifies a thrown value into fields a record may carry at any level.
 *
 * Total and side-effect free: it never throws, never invokes a method of the
 * value, and reads at most its `name` and `code` through the same guarded
 * property read the value walk uses, so a hostile getter or a `Proxy` yields
 * the generic `Error` label rather than an exception. The message, the stack
 * and the `cause` are never read — they are exactly the free text the closed
 * taxonomy exists to keep out of a record (AAP §0.5.2).
 *
 * @param thrown Any caught or rejected value.
 * @returns Its class and, when it carries a closed-vocabulary code, that code.
 *
 * @example
 * ```ts
 * try {
 *   await server.listen(port);
 * } catch (caught) {
 *   log.error('the listener could not bind', { ...describeException(caught) });
 *   // {"errorClass":"SystemError","errorCode":"EADDRINUSE", …}
 * }
 * ```
 */
export function describeException(thrown: unknown): ExceptionDescription {
  try {
    if (DebuggenError.is(thrown)) {
      return { errorClass: 'DebuggenError', errorCode: thrown.code };
    }
    if (!(thrown instanceof Error)) {
      return NON_ERROR_EXCEPTION;
    }

    const code = readProperty(thrown, 'code');
    const systemCode =
      typeof code === 'string' && SYSTEM_ERROR_CODE_PATTERN.test(code) ? code : undefined;
    const name = readProperty(thrown, 'name');
    const named =
      typeof name === 'string' && NAMED_EXCEPTION_CLASSES.has(name)
        ? EXCEPTION_CLASSES.find((label) => label === name)
        : undefined;
    const errorClass: ExceptionClass =
      named ?? (systemCode === undefined ? 'Error' : 'SystemError');

    return systemCode === undefined ? { errorClass } : { errorClass, errorCode: systemCode };
  } catch {
    // `instanceof` consults a `Proxy`'s `getPrototypeOf` trap, which may throw;
    // a value that cannot even be classified is reported by the generic label.
    return UNCLASSIFIABLE_EXCEPTION;
  }
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
 * reaches pino, {@link serializeError} has already produced the closed shape
 * this service documents — `type` (an {@link EXCEPTION_CLASSES} label),
 * `code`, a `DebuggenError`'s closed-token `details` and
 * {@link DETAILS_OMITTED_KEY}, and `cause`; plus the redacted `message`,
 * `stack`, `hint` and full `details` at {@link DIAGNOSTIC_LOG_LEVELS} only —
 * as a plain object. The standard serializer would report `type: "Object"`, and it
 * would re-read `message` and `stack` off whatever it was handed, which is
 * exactly the free text the closed shape keeps out of the record. An identity
 * serializer keeps the closed shape intact; it is also the conservative
 * choice, since the standard one reads properties off a value that may have
 * come from a rejected model payload.
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
 * - **The level decides the error shape.** A record's fields are scrubbed
 *   with `diagnostics` on only when the record is written at one of the
 *   {@link DIAGNOSTIC_LOG_LEVELS}, so an error's redacted message and stack,
 *   and a `DebuggenError`'s redacted hint and full details, appear in a
 *   `debug`/`trace` record and never in an `info`, `warn`, `error` or
 *   `fatal` one. Child bindings are scrubbed without it: a binding
 *   is stamped on records of every level, so it can only take the shape safe
 *   at all of them.
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
    const safeFields = scrubLogFields(fields, {
      diagnostics: DIAGNOSTIC_LOG_LEVELS.includes(target),
    });
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
 * The shortest interval between two fallback notices of one guarded logger
 * tree, in milliseconds.
 *
 * A destination that fails usually fails for every record — a closed pipe, a
 * full disk — so the notice is rate-limited rather than repeated per record:
 * the first failure is announced at once, and later ones are folded into the
 * next notice's counts.
 */
export const LOG_FAILURE_NOTICE_INTERVAL_MS = 60_000;

/** The `msg` of the fallback notice: a constant, so it can never carry what failed. */
export const LOG_FAILURE_NOTICE_MESSAGE = 'log records could not be written and were dropped';

/** The `subsystem` the fallback notice names. */
const LOG_FAILURE_NOTICE_SUBSYSTEM = 'logging';

/**
 * How a guarded logger reports that its own writes are failing.
 *
 * Every member is a seam: a suite captures the notice with `fallback`, drives
 * the interval with `now`, and shortens it with `noticeIntervalMs`.
 */
export interface LogFailurePolicy {
  /**
   * Receives one JSON line per notice, without a trailing newline. Defaults to
   * a write to the process's standard error, resolved at call time so
   * importing this module still opens nothing.
   */
  readonly fallback?: (line: string) => void;
  /** The clock the interval is measured with; defaults to `nowEpochMs`. */
  readonly now?: () => number;
  /** Overrides {@link LOG_FAILURE_NOTICE_INTERVAL_MS}; a non-positive value announces every failure. */
  readonly noticeIntervalMs?: number;
}

/** The accounting one guarded logger tree shares: a root and every child of it. */
interface LogFailureState {
  readonly fallback: (line: string) => void;
  readonly now: () => number;
  readonly intervalMs: number;
  /** Records dropped since the guard was created. */
  dropped: number;
  /** Records dropped since the last notice was written. */
  droppedSinceNotice: number;
  /** When the last notice was written, or `undefined` before the first. */
  lastNoticeAt: number | undefined;
  /** Notices the fallback sink itself refused. */
  failedNotices: number;
}

/** The operation of a guarded logger that failed: a level method or `child`. */
type GuardedOperation = LogLevel | 'child';

/** Loggers this module produced as guards, so guarding one again is the identity. */
const GUARDED_LOGGERS = new WeakSet<Logger>();

/** The default notice sink: one write to standard error, resolved when it is used. */
function writeToStandardError(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Accounts for one failed logger operation and, when the interval allows,
 * writes the fixed notice.
 *
 * The notice is built only from this module's constants, the counts and the
 * failure's closed {@link ExceptionClass} — never from the record that could
 * not be written or from the exception's text — so the fallback path cannot
 * become the leak the primary path was built to prevent. A notice the sink
 * refuses is counted in `failedNotices` and carried by the next notice: that
 * is the terminal decision, because nothing below the process's own standard
 * error remains to report to.
 */
function recordLogFailure(
  state: LogFailureState,
  operation: GuardedOperation,
  thrown: unknown,
): void {
  state.dropped += 1;
  state.droppedSinceNotice += 1;

  let at: number;
  try {
    at = state.now();
  } catch {
    at = nowEpochMs();
  }
  if (!Number.isFinite(at)) {
    at = nowEpochMs();
  }
  if (state.lastNoticeAt !== undefined && at - state.lastNoticeAt < state.intervalMs) {
    return;
  }

  const notice = {
    level: LOG_LEVEL_VALUES.error,
    time: at,
    [LOG_BINDING_KEYS.subsystem]: LOG_FAILURE_NOTICE_SUBSYSTEM,
    operation,
    ...describeException(thrown),
    droppedRecords: state.dropped,
    droppedSinceLastNotice: state.droppedSinceNotice,
    failedNotices: state.failedNotices,
    msg: LOG_FAILURE_NOTICE_MESSAGE,
  };
  state.lastNoticeAt = at;
  state.droppedSinceNotice = 0;
  try {
    state.fallback(JSON.stringify(notice));
  } catch {
    state.failedNotices += 1;
  }
}

/**
 * A logger that adds `bindings` to every record by merging them into the
 * call's fields — the stand-in for a `child()` the wrapped logger refused.
 *
 * Precedence is the shared contract's, per-call over child: the call's fields
 * are spread after the bindings. A merge that throws (a hostile bag) throws
 * inside the guard around this logger, which accounts for it like any other
 * failed write.
 */
function mergingLogger(parent: Logger, level: LogLevelSetting, bindings: LogFields): Logger {
  const withBindings = (fields: LogFields | undefined): LogFields =>
    fields === undefined ? { ...bindings } : { ...bindings, ...fields };

  return Object.freeze({
    level,
    trace: (message: string, fields?: LogFields) => {
      parent.trace(message, withBindings(fields));
    },
    debug: (message: string, fields?: LogFields) => {
      parent.debug(message, withBindings(fields));
    },
    info: (message: string, fields?: LogFields) => {
      parent.info(message, withBindings(fields));
    },
    warn: (message: string, fields?: LogFields) => {
      parent.warn(message, withBindings(fields));
    },
    error: (message: string, fields?: LogFields) => {
      parent.error(message, withBindings(fields));
    },
    fatal: (message: string, fields?: LogFields) => {
      parent.fatal(message, withBindings(fields));
    },
    child: (next: LogFields) => mergingLogger(parent, level, { ...bindings, ...next }),
  } satisfies Logger);
}

/** Wraps `target` in the guard, sharing `state` with every logger of the same tree. */
function guardWith(target: Logger, state: LogFailureState): Logger {
  let level: LogLevelSetting;
  try {
    level = resolveLevel(target.level);
  } catch {
    level = DEFAULT_LOG_LEVEL;
  }

  const write = (operation: LogLevel, message: string, fields: LogFields | undefined): void => {
    try {
      if (fields === undefined) {
        target[operation](message);
      } else {
        target[operation](message, fields);
      }
    } catch (thrown) {
      recordLogFailure(state, operation, thrown);
    }
  };

  const guarded: Logger = Object.freeze({
    level,
    trace: (message: string, fields?: LogFields) => {
      write('trace', message, fields);
    },
    debug: (message: string, fields?: LogFields) => {
      write('debug', message, fields);
    },
    info: (message: string, fields?: LogFields) => {
      write('info', message, fields);
    },
    warn: (message: string, fields?: LogFields) => {
      write('warn', message, fields);
    },
    error: (message: string, fields?: LogFields) => {
      write('error', message, fields);
    },
    fatal: (message: string, fields?: LogFields) => {
      write('fatal', message, fields);
    },
    child: (bindings: LogFields) => {
      try {
        return guardWith(target.child(bindings), state);
      } catch (thrown) {
        // The child could not be built: keep its records by merging the
        // bindings into each call on this logger, and announce the failure.
        recordLogFailure(state, 'child', thrown);
        return guardWith(mergingLogger(target, level, bindings), state);
      }
    },
  } satisfies Logger);

  GUARDED_LOGGERS.add(guarded);
  return guarded;
}

/**
 * Makes any `Logger` safe to call on a failure path: none of its methods, and
 * none of its children's, can throw.
 *
 * A log call is best-effort diagnostics, and it most often runs where a caller
 * is already handling a failure — a `catch` block, a degraded branch, a
 * shutdown step. A logger that throws there replaces the failure being handled
 * with its own, and skips whatever the caller does next: a broadcast, a
 * rollback, a reply. So every call is wrapped, and a failed write is **counted
 * and announced, never propagated**:
 *
 * - A level method that throws drops that one record. The first drop, and then
 *   at most one per {@link LOG_FAILURE_NOTICE_INTERVAL_MS}, writes a fixed
 *   notice to the policy's fallback sink (standard error by default) carrying
 *   the drop counts and the failure's closed class only.
 * - A `child()` that throws is replaced by a logger merging the bindings into
 *   every call on the parent, so the subsystem's records keep their context.
 * - The accounting is shared by the whole tree the guard produces, so one
 *   failing destination yields one notice, not one per subsystem.
 *
 * `noopLogger` is returned as itself (it cannot throw), and a logger this
 * function already produced is returned unchanged, keeping its original
 * policy; guarding is therefore idempotent and cheap to apply at every
 * injection boundary.
 *
 * @param logger Any `Logger`, typically one injected into a subsystem.
 * @param policy Where and how often the failure notice is written.
 * @returns A frozen `Logger` whose methods never throw.
 *
 * @example
 * ```ts
 * const log = guardLogger(deps.logger ?? noopLogger);
 * log.warn('a progress row could not be persisted', { code }); // never throws
 * ```
 */
export function guardLogger(logger: Logger, policy: LogFailurePolicy = {}): Logger {
  if (logger === noopLogger || GUARDED_LOGGERS.has(logger)) {
    return logger;
  }
  const intervalMs = policy.noticeIntervalMs ?? LOG_FAILURE_NOTICE_INTERVAL_MS;
  const state: LogFailureState = {
    fallback: policy.fallback ?? writeToStandardError,
    now: policy.now ?? nowEpochMs,
    intervalMs: Number.isFinite(intervalMs) ? intervalMs : LOG_FAILURE_NOTICE_INTERVAL_MS,
    dropped: 0,
    droppedSinceNotice: 0,
    lastNoticeAt: undefined,
    failedNotices: 0,
  };
  return guardWith(logger, state);
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
 * @param config The validated service configuration; its `logLevel` is the
 *   threshold unless `options.level` overrides it.
 * @param options Test and embedding seams; see {@link ServiceLoggerOptions}.
 * @returns A frozen `Logger`, guarded by {@link guardLogger}: neither it nor
 *   any child of it throws from a level method or from `child()`; never `null`.
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

  return guardLogger(createAdapter(bound, level), options.failurePolicy);
}

/**
 * Derives the child logger a subsystem uses.
 *
 * Deliberately thin — one binding under the standardised name — so a
 * subsystem receives a `Logger` and nothing pino-specific, and so `store`,
 * `pipeline` and `telemetry` cannot spell the same field three ways.
 *
 * @param parent Usually the root from {@link createServiceLogger}.
 * @param subsystem Conventionally the module's source folder name.
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
