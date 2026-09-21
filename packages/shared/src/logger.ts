/**
 * The one logging interface every process in this product agrees on, plus a
 * dependency-free implementation of it.
 *
 * Four processes log, and only one of them may take a logging dependency:
 *
 * - the **local service**, which wraps pino behind {@link Logger} in
 *   `apps/local-service/src/logging.ts`;
 * - the **VS Code extension host and its webview**, which route records into an
 *   `OutputChannel` and the webview console;
 * - the **DevTools panel and the MV3 service worker**, which log to the
 *   extension's own consoles;
 * - the **MAIN-world browser agent**, whose IIFE bundle is inlined into the
 *   inspected page.
 *
 * Everything except the service binds {@link createConsoleLogger}. That is the
 * reason this module has no dependency of any kind beyond `./time.js`: a page
 * bundle cannot carry pino, and `@debuggen/shared` is the base layer of the
 * package graph, so it imports no workspace package and no third-party package
 * at all. It is also part of the browser-safe `"."` entry, so it uses no Node
 * builtin, no `require`, and no `process`: `console` is read from
 * `globalThis` — lazily and defensively, because a page is free to delete or
 * replace it, and because the agent's bundle may be evaluated before the host
 * has installed its globals.
 *
 * ## Argument order: message FIRST
 *
 * ⚠️ **Every method here is `(message, fields?)`.** pino's native API is the
 * opposite — `logger.info(obj, msg)` — so the adapter in
 * `apps/local-service/src/logging.ts` **must flip the arguments there**, never
 * here. Getting that wrong does not fail a build and does not throw: it
 * produces logs whose message is `"[object Object]"` and whose structured
 * fields are a bare string, for as long as nobody reads them. The flip belongs
 * in exactly one file, and this interface is what fixes its direction.
 *
 * ## Privacy: this module redacts nothing
 *
 * Never log a secret, a token, an `Authorization`/`Cookie` header value, a
 * request or response body, a SQL literal, or a React prop or state value.
 * Redaction is owned by `packages/telemetry/src/redaction/` (at telemetry
 * ingest) and by `packages/model-provider/src/redact-guard.ts` (on every
 * outbound prompt). Neither this interface nor {@link createConsoleLogger}
 * inspects, rewrites or filters a field, and no caller may rely on them to:
 * whatever is handed to a logger reaches the sink verbatim, and a sink may be a
 * file on disk or a console in a page the developer is screen-sharing.
 *
 * ## Timestamps
 *
 * {@link LogRecord.time} comes from `nowEpochMs()` — the product's canonical
 * time base — and never from a direct `Date.now()` call in this file, so a log
 * record's time is comparable with a session row's `createdAt` and with a
 * span's `startTime` without a second convention.
 *
 * @example Binding a logger in library code
 * ```ts
 * function ingest(events: readonly unknown[], logger: Logger = noopLogger): void {
 *   logger.debug('ingesting batch', { count: events.length });
 * }
 *
 * ingest([], createConsoleLogger({ name: 'telemetry', level: 'debug' }));
 * ```
 */

import { nowEpochMs } from './time.js';

/**
 * Every severity a record can carry, ordered from least to most severe.
 *
 * The names are pino's, so a configured value moves between the service's pino
 * instance and a {@link createConsoleLogger} in a page without translation, and
 * `DEBUGGEN_LOG_LEVEL` (documented in `.env.example`) is spelled the same way
 * wherever it is read. Declared `as const` because {@link LogLevel} is derived
 * from it: the array is the single source of the vocabulary, and a consumer
 * that needs to validate a string — `apps/local-service/src/config.ts` parsing
 * the environment variable — iterates this rather than repeating the list.
 */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/**
 * A severity a {@link LogRecord} can be emitted at.
 *
 * Deliberately excludes `'silent'`: nothing is ever *logged* at silent, which
 * is a threshold rather than a severity. That distinction is what
 * {@link LogLevelSetting} adds, and keeping the two types apart is what lets
 * {@link isLevelEnabled} take one of each and lets a sink switch exhaustively
 * on `record.level` with no unreachable case.
 */
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * A configured logging threshold: any {@link LogLevel}, or `'silent'` to
 * disable logging entirely.
 *
 * This is the type of {@link Logger.level} and of
 * {@link ConsoleLoggerOptions.level}, and the type `DEBUGGEN_LOG_LEVEL`
 * (AAP §0.3.4) is parsed against by `apps/local-service/src/config.ts` — which
 * is also the reason `'silent'` exists: a developer must be able to turn the
 * service quiet from the environment without the code paths that call a logger
 * having to know about it.
 */
export type LogLevelSetting = LogLevel | 'silent';

/**
 * Numeric severity for every {@link LogLevelSetting}, on **pino's scale**.
 *
 * `trace` 10, `debug` 20, `info` 30, `warn` 40, `error` 50, `fatal` 60 are the
 * exact numbers pino uses, so the service's adapter needs no mapping table in
 * either direction: it hands a configured {@link LogLevelSetting} straight to
 * pino and reports a pino level number straight back as a {@link LogLevel}.
 *
 * `silent` is `Number.POSITIVE_INFINITY` rather than a sentinel such as `0` or
 * `-1`, which makes {@link isLevelEnabled} a single comparison with no special
 * case: no finite severity is `>=` infinity, so a silent threshold disables
 * every level by arithmetic instead of by branch.
 *
 * Frozen because it is a shared module-level table: every logger in the process
 * reads it on every call, and a mutation would silently re-tune filtering
 * everywhere.
 */
export const LOG_LEVEL_VALUES: Readonly<Record<LogLevelSetting, number>> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
});

/**
 * Whether a record at `level` passes a logger configured at `setting`.
 *
 * The comparison is `LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[setting]`, so
 * a threshold of `'warn'` admits `warn`, `error` and `fatal` and drops the
 * three below it, and a threshold of `'silent'` admits nothing.
 *
 * Exported because it is the gate a custom sink or a transport re-implements
 * otherwise: the DevTools panel checks it before serialising a record onto a
 * port, and the browser agent checks it before doing any work to assemble
 * fields.
 *
 * No `undefined` guard is needed on either lookup and none is present:
 * {@link LOG_LEVEL_VALUES} is a total `Record` over a closed union of string
 * literals, so `noUncheckedIndexedAccess` does not widen these reads — a fact
 * the compiler confirms rather than one this comment assumes. The corollary is
 * that an *untyped* value must be validated before it reaches here: a string
 * straight out of the environment that is not a {@link LogLevelSetting} would
 * compare against `undefined` and silently disable logging, which is why
 * `apps/local-service/src/config.ts` parses `DEBUGGEN_LOG_LEVEL` against
 * {@link LOG_LEVELS} first.
 *
 * @param setting The configured threshold.
 * @param level The severity of the record in question.
 * @returns `true` when the record should be emitted.
 *
 * @example
 * ```ts
 * isLevelEnabled('warn', 'error'); // true
 * isLevelEnabled('warn', 'info'); // false
 * isLevelEnabled('silent', 'fatal'); // false
 * ```
 */
export function isLevelEnabled(setting: LogLevelSetting, level: LogLevel): boolean {
  return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[setting];
}

/**
 * Structured context attached to a log record.
 *
 * Values are `unknown` on purpose: a sink decides how to serialise them, and
 * this module never touches them. Keep them small, JSON-representable and
 * free of the data the privacy rule in this file's overview forbids — a field
 * travels as far as its sink, which for the service is a log file on disk.
 */
export type LogFields = Record<string, unknown>;

/**
 * One log record, as a {@link LogSink} receives it.
 *
 * The shape is what every sink in the product formats or forwards: the pino
 * adapter maps it onto a pino call, the VS Code host renders it into an
 * `OutputChannel` line, and the default console sink writes it to the console.
 * All members are `readonly`: a record is a value, and a sink that needs to
 * enrich one builds a new object.
 */
export interface LogRecord {
  /** Severity the record was emitted at. */
  readonly level: LogLevel;

  /** Human-readable message, always the first argument at the call site. */
  readonly message: string;

  /**
   * Merged structured context: the logger's bindings (parent, then child)
   * overlaid with the per-call fields, later winning.
   *
   * Always an object — `{}` when there is no context at all — so a sink never
   * has to branch on its presence.
   *
   * Not defensively copied when the logger carries no bindings: in that case
   * this *is* the object the caller passed, which keeps the common path free of
   * an allocation. A sink that retains a record beyond the synchronous call
   * (buffering it for a transport, for instance) must copy the fields it keeps.
   */
  readonly fields: LogFields;

  /**
   * Epoch milliseconds, from the product's canonical time base (`nowEpochMs()`
   * in `./time.js`), so a log line is comparable with a session row's
   * timestamps and with a span's `startTime`.
   */
  readonly time: number;

  /**
   * The emitting logger's name, when one was configured — the subsystem the
   * record came from (`'service'`, `'agent'`, `'panel'`), not a message
   * category.
   *
   * Absent as a key rather than present-and-`undefined` when unnamed, which
   * matters for a sink that serialises the record: a JSON round-trip turns an
   * explicit `undefined` into `null` and a schema then rejects it.
   */
  readonly name?: string;
}

/**
 * Destination for records that pass a logger's level threshold.
 *
 * This is the whole extension point of {@link createConsoleLogger}: the VS Code
 * extension host passes a sink that appends to an `OutputChannel`, a transport
 * passes one that batches onto a port, and a test passes one that pushes into
 * an array so nothing reaches the console.
 *
 * A sink is called synchronously and its errors are **not** caught — they
 * propagate to the logging call site, which is the honest behaviour for a
 * destination the caller chose. A sink that can fail (a socket, a file) must
 * handle its own failure rather than turning a log line into an exception in
 * unrelated product code.
 */
export type LogSink = (record: LogRecord) => void;

/**
 * The logging interface every workspace in this monorepo depends on.
 *
 * ⚠️ **Message first, fields second** — `logger.info('capture started', { captureId })`.
 * pino's native API is `(obj, msg)`; the service's adapter flips the arguments
 * in `apps/local-service/src/logging.ts` and nothing else ever should.
 *
 * Implementations in the product: {@link createConsoleLogger} (dependency-free,
 * used by both extensions, both webviews and the page agent),
 * {@link noopLogger} (the default for library code and for tests), and the
 * service's pino adapter. Library code that logs should take
 * `logger: Logger = noopLogger` rather than reaching for a global, so a
 * consumer decides where the output goes.
 *
 * This interface performs no redaction — see this file's overview.
 */
export interface Logger {
  /** The configured threshold; `'silent'` means nothing is emitted. */
  readonly level: LogLevelSetting;

  /** Very fine-grained detail: per-event, per-frame, per-fiber tracing. */
  trace(message: string, fields?: LogFields): void;

  /** Diagnostic detail useful while developing or investigating. */
  debug(message: string, fields?: LogFields): void;

  /** Normal, noteworthy progress: a session created, a capture stopped. */
  info(message: string, fields?: LogFields): void;

  /** A degraded but handled condition: a signal unavailable, a retry. */
  warn(message: string, fields?: LogFields): void;

  /** A failed operation the process recovered from. */
  error(message: string, fields?: LogFields): void;

  /** An unrecoverable condition: the process or session cannot continue. */
  fatal(message: string, fields?: LogFields): void;

  /**
   * A logger that adds `bindings` to every record it emits.
   *
   * Shares this logger's level, name and sink. Field precedence is
   * **per-call > child > parent**: the service binds `{ sessionId }` on a
   * session's logger and `{ captureId }` on a child of it, and a call site may
   * still override either for one record.
   *
   * @param bindings Context to merge into every record from the child.
   * @returns A new logger; this one is unaffected.
   */
  child(bindings: LogFields): Logger;
}

/**
 * The console method each severity is written to by the default sink.
 *
 * `trace` and `debug` both go to `console.debug` — Chrome files it under
 * "Verbose", which is where per-event agent output belongs — and `fatal` joins
 * `error`, because no console has a sixth channel. `console.trace` is
 * deliberately not used for the `trace` level: it prints a stack trace with
 * every line, which turns a per-event log into pages of noise.
 */
const CONSOLE_METHOD_BY_LEVEL: Readonly<Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'>> =
  Object.freeze({
    trace: 'debug',
    debug: 'debug',
    info: 'info',
    warn: 'warn',
    error: 'error',
    fatal: 'error',
  });

/**
 * The `fields` of a record that carries no context.
 *
 * One frozen instance shared by every such record, so the no-context path —
 * overwhelmingly the common one for a message-only log line — allocates nothing
 * beyond the record itself. Frozen because it is shared: a sink that tried to
 * enrich it in place would otherwise corrupt every later record.
 */
const EMPTY_FIELDS: LogFields = Object.freeze({});

/**
 * A loosely typed console method, for the defensive call in
 * {@link writeToConsole}.
 *
 * The ambient `Console` type cannot be used: this module assumes nothing about
 * what `globalThis.console` actually is at runtime, and the DOM/Node lib types
 * are not in scope for the browser-safe entry anyway.
 */
type ConsoleWriter = (...args: unknown[]) => void;

/**
 * Whether `fields` has at least one own enumerable key.
 *
 * `for…in` plus `Object.hasOwn` rather than `Object.keys(fields).length > 0`
 * because this runs on every emitted record in the page agent's hot path and
 * the array `Object.keys` builds would be immediately discarded. The own-key
 * guard keeps an inherited property on a caller-supplied object with an unusual
 * prototype from being mistaken for context.
 *
 * @param fields Candidate field bag.
 * @returns `true` when the bag carries context worth emitting.
 */
function hasFields(fields: LogFields): boolean {
  for (const key in fields) {
    if (Object.hasOwn(fields, key)) {
      return true;
    }
  }
  return false;
}

/**
 * Collapses an empty or absent field bag to `undefined`.
 *
 * Bindings are normalised once, when a logger or a child is created, so the
 * per-call merge can test a single `undefined` instead of re-inspecting an
 * empty object on every log line.
 *
 * @param fields Bindings as supplied by a caller.
 * @returns The bag when it carries context, otherwise `undefined`.
 */
function normalizeFields(fields: LogFields | undefined): LogFields | undefined {
  return fields !== undefined && hasFields(fields) ? fields : undefined;
}

/**
 * Merges two field bags, `extra` winning on a key collision.
 *
 * Returns one of its arguments unchanged when the other is absent, which is
 * what keeps an unbound logger's records free of a copy (see
 * {@link LogRecord.fields}); a genuine overlap produces a new object so neither
 * input is mutated and a parent's bindings can never be polluted by a child's.
 *
 * @param base Lower-precedence bag (a logger's bindings).
 * @param extra Higher-precedence bag (child bindings, or per-call fields).
 * @returns The merged bag, or `undefined` when both are absent.
 */
function mergeFields(
  base: LogFields | undefined,
  extra: LogFields | undefined,
): LogFields | undefined {
  if (base === undefined) {
    return extra;
  }
  if (extra === undefined) {
    return base;
  }
  return { ...base, ...extra };
}

/**
 * The default {@link LogSink}: writes a record to the ambient console.
 *
 * Everything about this function is defensive, because its worst case is the
 * MAIN world of a page the tool does not control, where `console` may have been
 * deleted, replaced with a non-object, or given throwing accessors — and where
 * a logging call that throws would break the product code that made it. So the
 * global is read on every call rather than captured at module load (the agent
 * bundle can be evaluated before the host installs its globals), the method is
 * duck-typed with a fallback to `log`, the call is made with the console as its
 * receiver (implementations may require one), and the whole body is wrapped:
 * a console that cannot be used means no output, never an exception.
 *
 * Fields are passed as a second argument **only when non-empty**, so an
 * ordinary message stays one readable line in the DevTools console instead of
 * an empty object beside it. The logger's name, when set, is prefixed as
 * `[name]` so records from the agent, the panel and the service stay
 * distinguishable in a shared console.
 *
 * @param record The record to write.
 */
function writeToConsole(record: LogRecord): void {
  try {
    const host: unknown = (globalThis as { readonly console?: unknown }).console;
    if (typeof host !== 'object' || host === null) {
      return;
    }

    const table = host as Record<string, unknown>;
    const preferred: unknown = table[CONSOLE_METHOD_BY_LEVEL[record.level]];
    const writer: unknown = typeof preferred === 'function' ? preferred : table['log'];
    if (typeof writer !== 'function') {
      return;
    }

    const line = record.name === undefined ? record.message : `[${record.name}] ${record.message}`;
    if (hasFields(record.fields)) {
      (writer as ConsoleWriter).call(host, line, record.fields);
    } else {
      (writer as ConsoleWriter).call(host, line);
    }
  } catch {
    // A hostile or half-initialised console is not a reason to fail the caller.
    // There is nowhere left to report this to, which is precisely the point.
  }
}

/**
 * Everything a {@link createConsoleLogger} instance carries, with the options
 * already resolved.
 *
 * Module-internal and immutable: `child()` builds a new state rather than
 * mutating one, so a logger handed to another component cannot be re-tuned
 * behind its back. `name` and `bindings` are required properties typed to
 * include `undefined` (not optional ones) because `exactOptionalPropertyTypes`
 * is on: that is what lets a state be built and spread without a conditional
 * for each absent member.
 */
interface LoggerState {
  /** Threshold every record is tested against. */
  readonly level: LogLevelSetting;

  /** Subsystem name, or `undefined` for an unnamed logger. */
  readonly name: string | undefined;

  /** Accumulated bindings, or `undefined` when there are none. */
  readonly bindings: LogFields | undefined;

  /** Where surviving records go. */
  readonly sink: LogSink;
}

/**
 * Builds a {@link Logger} over a resolved {@link LoggerState}.
 *
 * Shared by {@link createConsoleLogger} and by every `child()` it produces, so
 * the level gate, the merge order and the record shape are defined exactly
 * once. The six level methods close over a single `emit`, and the returned
 * object is allocated once per logger rather than once per call; a disabled
 * level costs one numeric comparison and allocates nothing at all.
 *
 * @param state Resolved configuration for this logger.
 * @returns The logger.
 */
function createLogger(state: LoggerState): Logger {
  const emit = (level: LogLevel, message: string, fields: LogFields | undefined): void => {
    if (!isLevelEnabled(state.level, level)) {
      return;
    }

    const merged = mergeFields(state.bindings, fields) ?? EMPTY_FIELDS;
    const time = nowEpochMs();
    const { name } = state;

    // `name` is omitted as a key rather than set to `undefined`: see
    // `LogRecord.name`, and `exactOptionalPropertyTypes` requires it.
    state.sink(
      name === undefined
        ? { level, message, fields: merged, time }
        : { level, message, fields: merged, time, name },
    );
  };

  return {
    level: state.level,
    trace: (message, fields) => emit('trace', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    fatal: (message, fields) => emit('fatal', message, fields),
    child: (bindings) =>
      createLogger({
        ...state,
        bindings: mergeFields(state.bindings, normalizeFields(bindings)),
      }),
  };
}

/**
 * Options for {@link createConsoleLogger}. Every member is optional.
 */
export interface ConsoleLoggerOptions {
  /**
   * Threshold below which records are dropped. Defaults to `'info'`; pass
   * `'silent'` to disable the logger entirely.
   */
  readonly level?: LogLevelSetting;

  /**
   * Subsystem name recorded on every record and prefixed as `[name]` by the
   * default console sink — `'service'`, `'agent'`, `'panel'`, `'extension'`.
   */
  readonly name?: string;

  /**
   * Initial bindings merged into every record, below child bindings and below
   * per-call fields.
   */
  readonly bindings?: LogFields;

  /**
   * Destination for records that pass the threshold. Defaults to the console
   * sink described on {@link createConsoleLogger}.
   */
  readonly sink?: LogSink;
}

/**
 * Creates a {@link Logger} with no dependencies, writing to the ambient console
 * unless a sink is supplied.
 *
 * This is the implementation every surface except the local service binds: the
 * DevTools panel, the MV3 service worker, both VS Code webviews and the
 * MAIN-world browser agent, whose bundle inlines this code into the inspected
 * page. Behaviour:
 *
 * - a record below `level` is dropped before it is built — a disabled call
 *   allocates nothing;
 * - a surviving record goes to `options.sink` when given, otherwise to the
 *   default console sink (`trace`/`debug` → `console.debug`, `info` →
 *   `console.info`, `warn` → `console.warn`, `error`/`fatal` →
 *   `console.error`), which passes fields as a second argument only when there
 *   are any and never throws;
 * - `child(bindings)` keeps the level, name and sink and merges bindings with
 *   **per-call > child > parent** precedence.
 *
 * The injectable sink is the extension point, not a testing convenience: the VS
 * Code extension host uses it to route records into an `OutputChannel`, a
 * transport uses it to batch them onto a port, and a test uses it to collect
 * them in an array.
 *
 * Remember the argument order and the privacy rule in this file's overview:
 * message first, fields second, and nothing secret in either.
 *
 * @param options Level, name, initial bindings and sink; all optional.
 * @returns A logger; the call itself performs no I/O.
 *
 * @example Console output, with a subsystem name
 * ```ts
 * const log = createConsoleLogger({ name: 'agent', level: 'debug' });
 * log.debug('hooks attached', { captureId });
 * // console.debug('[agent] hooks attached', { captureId })
 * ```
 *
 * @example Collecting records instead of printing them
 * ```ts
 * const records: LogRecord[] = [];
 * const log = createConsoleLogger({ level: 'trace', sink: (r) => records.push(r) });
 * log.child({ sessionId }).info('capture started', { captureId });
 * // records[0].fields → { sessionId, captureId }
 * ```
 */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  return createLogger({
    level: options.level ?? 'info',
    name: options.name,
    bindings: normalizeFields(options.bindings),
    sink: options.sink ?? writeToConsole,
  });
}

/**
 * The body of every {@link noopLogger} method.
 *
 * Declared with no parameters on purpose: a zero-argument function satisfies
 * every method of {@link Logger}, so no argument is even evaluated into a
 * binding, and `noUnusedParameters` has nothing to object to.
 */
function noop(): void {
  /* Intentionally empty: no level check, no record, no sink. */
}

/**
 * A {@link Logger} that discards everything.
 *
 * Two uses, both load-bearing:
 *
 * - **The default for library code.** A function that takes
 *   `logger: Logger = noopLogger` logs when its caller wants logs and stays
 *   silent otherwise, with no `if (logger)` at every call site and no global.
 * - **The default in tests.** Injected wherever a component under test would
 *   otherwise print, which keeps a suite's output to its own assertions.
 *
 * `level` is `'silent'`, so code that checks
 * `isLevelEnabled(logger.level, 'debug')` before assembling expensive fields
 * skips that work too. `child()` returns this same instance — the singleton is
 * frozen and stateless, so there is nothing for a child to own.
 */
export const noopLogger: Logger = Object.freeze({
  level: 'silent',
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child: (): Logger => noopLogger,
} satisfies Logger);
