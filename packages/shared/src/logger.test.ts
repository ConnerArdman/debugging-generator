/**
 * Tests for `./logger.ts`: the one logging interface every process in this
 * product agrees on, and the dependency-free implementation of it that four of
 * those processes bind.
 *
 * Three things are on trial here, and each of them fails somewhere other than
 * where it is raised.
 *
 * 1. **⚠️ The argument order is a cross-process contract, and this file is
 *    what fixes its direction.** Every method of `Logger` is
 *    `(message, fields?)` — *message first*. pino's native API is the exact
 *    opposite, `logger.info(obj, msg)`, so the adapter in
 *    `apps/local-service/src/logging.ts` **must flip the arguments there** and
 *    nowhere else. A regression in that adapter neither fails a build nor
 *    throws: it produces log lines whose message is `"[object Object]"` and
 *    whose structured fields are a bare string, for as long as nobody reads
 *    them. That is why every record-shape assertion below names **both**
 *    members explicitly — a distinctive message string in `record.message` and
 *    a distinctive object in `record.fields` — instead of checking one and
 *    trusting the other. A flipped implementation cannot satisfy both at once.
 * 2. **The level table is a vocabulary other workspaces enumerate.**
 *    `apps/local-service/src/config.ts` parses `DEBUGGEN_LOG_LEVEL` against
 *    `LOG_LEVELS`, and the numbers in `LOG_LEVEL_VALUES` are pino's own, which
 *    is what lets the service hand a configured value straight to pino in one
 *    direction and report a pino level number straight back in the other. A
 *    renamed level, a reordered tuple or a re-tuned number silently re-filters
 *    logging in four processes, so the first suites pin the exact tuple, the
 *    exact numbers and all forty-two `(setting, level)` answers.
 * 3. **`fields` must survive untouched, and the caller's object with it.** The
 *    merge is `per-call > child > parent`; a parent's bindings may never be
 *    polluted by a child's, and the bag a call site passes may never be
 *    mutated — it is frequently a frozen or shared object, and logging is not
 *    allowed to be the reason unrelated code breaks.
 *
 * ## Why an injected sink rather than a `console` spy
 *
 * `createConsoleLogger` takes a `sink` precisely so a test can assert on
 * structured records without touching global state, so every suite that is
 * about *records* uses one. `vi.spyOn(console, …)` appears only where the
 * subject genuinely is the default console sink, and those spies are restored
 * in `afterEach`. The rule has teeth in this file: a record that reaches the
 * real console shows up as stray output in the test log, which is itself a
 * failure signal for a module the MAIN-world page agent bundles.
 *
 * ## Privacy
 *
 * `logger.ts` redacts nothing, and these tests assert exactly that shape:
 * whatever is handed to a logger reaches the sink verbatim. No fixture here
 * carries a credential-shaped value, because the fields in a test are the
 * fields a reader copies into product code. Redaction lives in
 * `packages/telemetry/src/redaction/` and
 * `packages/model-provider/src/redact-guard.ts`.
 *
 * Runtime facts these tests encode, measured against Node 24 rather than
 * assumed: `nowEpochMs()` is `Date.now()`, so a record's `time` is a whole
 * number of epoch milliseconds and is pinned exactly with a faked system clock;
 * `Object.freeze` on a field bag makes any in-place write throw in a module
 * that is strict mode by construction, which is what turns "does not mutate the
 * caller's object" into an assertion rather than a claim; and an unnamed
 * record has no `name` key at all, which a JSON round-trip would otherwise turn
 * into `"name": null` and a schema would then reject.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LOG_LEVELS,
  LOG_LEVEL_VALUES,
  createConsoleLogger,
  isLevelEnabled,
  noopLogger,
  type LogFields,
  type LogLevel,
  type LogLevelSetting,
  type LogRecord,
  type LogSink,
  type Logger,
} from './logger.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures and helpers
 * ---------------------------------------------------------------------------
 */

/** A `LogSink` that keeps what it was given, with the records it collected. */
interface Recorder {
  /** Records in the order the sink received them. */
  readonly records: readonly LogRecord[];

  /** The sink to hand to {@link createConsoleLogger}. */
  readonly sink: LogSink;
}

/**
 * Creates a fresh {@link Recorder}.
 *
 * One per test, never shared: a module-level array would make the assertions
 * below order-dependent, and the whole point of the injected sink is that a
 * test observes only its own records.
 *
 * @returns A recorder whose `records` grow as its `sink` is called.
 */
function recorder(): Recorder {
  const records: LogRecord[] = [];
  return {
    records,
    sink: (record) => {
      records.push(record);
    },
  };
}

/**
 * The record at `index`, or a thrown error naming what was missing.
 *
 * `noUncheckedIndexedAccess` types an index read as possibly `undefined`, and
 * the honest way to resolve that in a test is to fail loudly rather than to
 * assert non-null: a missing record means the level gate dropped something it
 * should have emitted, and the message says so.
 *
 * @param source Recorder to read from.
 * @param index Zero-based position in the emission order.
 * @returns The record at that position.
 */
function recordAt(source: Recorder, index: number): LogRecord {
  const record = source.records[index];
  if (record === undefined) {
    throw new Error(
      `expected a record at index ${String(index)}, got ${String(source.records.length)} record(s)`,
    );
  }
  return record;
}

/**
 * The single record a test expected, asserting that it is the only one.
 *
 * @param source Recorder to read from.
 * @returns The one record it received.
 */
function onlyRecord(source: Recorder): LogRecord {
  expect(source.records).toHaveLength(1);
  return recordAt(source, 0);
}

/**
 * Calls the level method named by `level`.
 *
 * Exists so a table-driven test can exercise all six methods without six
 * copies of the same body. The dispatch is a typed index read on {@link Logger}
 * — no cast — so a renamed or removed method is a compile error here.
 *
 * @param logger Logger to emit through.
 * @param level Severity, which is also the method name.
 * @param message Message, always the first argument (see this file's overview).
 * @param fields Optional structured context.
 */
function emitAt(logger: Logger, level: LogLevel, message: string, fields?: LogFields): void {
  logger[level](message, fields);
}

/**
 * Replaces the four console methods the default sink can reach with silent
 * spies, and hands them back.
 *
 * Every spy carries a `mockImplementation` that writes nothing: a spy that
 * called through would put real output in the test log, and for a module the
 * MAIN-world page agent bundles, stray output in a suite is itself a failure
 * signal. All four are installed together even when a case is about one of
 * them, so "nothing else was written to" is assertable rather than assumed.
 *
 * `console` is read from `globalThis` by the sink on every call, so patching
 * the ambient object is enough — nothing was captured at module load. The
 * module-level `afterEach` below restores them.
 *
 * The return type is inferred on purpose: naming it would mean naming Vitest's
 * `MockInstance` generic over Node's `(message?: any, …optionalParams: any[])`
 * console signatures, which adds `any` to this file for no benefit.
 * {@link ConsoleSpies} is derived from the inference instead.
 *
 * @returns The four installed spies, keyed by console method name.
 */
function installConsoleSpies() {
  return {
    debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
}

/** The spies {@link installConsoleSpies} returns. */
type ConsoleSpies = ReturnType<typeof installConsoleSpies>;

/** A console method the default sink is allowed to write to. */
type ConsoleMethod = keyof ConsoleSpies;

/** Every console method the default sink may reach, for exclusion checks. */
const CONSOLE_METHODS: readonly ConsoleMethod[] = ['debug', 'info', 'warn', 'error'];

/**
 * The argument lists a spy recorded, as `unknown[][]`.
 *
 * A structural parameter rather than Vitest's `MockInstance`, for one reason:
 * Node types `console.debug` as `(message?: any, …optionalParams: any[])`, so
 * reading `spy.mock.calls` directly would spread `any` through every assertion
 * that touches it. Narrowing once, here, keeps the rest of the file typed.
 *
 * Comparing the whole `calls` array is also how **argument count** is asserted:
 * `[['a message']]` says one call with exactly one argument, which is the
 * "fields only when non-empty" rule stated as data.
 *
 * @param spy Any spy with a Vitest mock context.
 * @returns One entry per call, each the arguments of that call.
 */
function consoleCalls(spy: {
  readonly mock: { readonly calls: readonly unknown[][] };
}): readonly unknown[][] {
  return spy.mock.calls;
}

/**
 * Asserts that `method` was called exactly once with `args`, and that the other
 * three console methods were not called at all.
 *
 * The exclusion half is the load-bearing one: a mapping that sent `fatal` to
 * both `console.error` and `console.debug` would satisfy a bare
 * `toHaveBeenCalledWith` on either. The positive half compares the recorded
 * argument list as a whole, so an appended argument — an empty `fields` object
 * beside an otherwise clean log line — fails rather than passing unnoticed.
 *
 * @param spies Spies from {@link installConsoleSpies}.
 * @param method The console method that must have received the record.
 * @param args The exact arguments it must have received.
 */
function expectOnlyConsoleCall(
  spies: ConsoleSpies,
  method: ConsoleMethod,
  ...args: readonly unknown[]
): void {
  for (const candidate of CONSOLE_METHODS) {
    if (candidate === method) {
      expect(consoleCalls(spies[candidate])).toEqual([[...args]]);
    } else {
      expect(consoleCalls(spies[candidate])).toEqual([]);
    }
  }
}

/** Every configurable threshold: the six severities plus `'silent'`. */
const LEVEL_SETTINGS: readonly LogLevelSetting[] = [...LOG_LEVELS, 'silent'];

/** One `(setting, level)` pair and the answer `isLevelEnabled` owes for it. */
interface LevelCase {
  /** The configured threshold. */
  readonly setting: LogLevelSetting;

  /** The severity of the hypothetical record. */
  readonly level: LogLevel;

  /** Whether the record must be emitted. */
  readonly expected: boolean;
}

/**
 * The complete truth table for {@link isLevelEnabled}: seven settings × six
 * severities, forty-two cases with no gap.
 *
 * `expected` is derived from the **position** of each name in
 * {@link LOG_LEVELS} and not from {@link LOG_LEVEL_VALUES}, which matters: the
 * numeric table is itself under test two suites above, and computing the
 * expectation from it would let a re-tuned number satisfy both suites at once.
 * Ordering — a threshold admits itself and everything more severe — is the
 * property that actually has to hold, so ordering is what this table encodes.
 */
const LEVEL_CASES: readonly LevelCase[] = LEVEL_SETTINGS.flatMap((setting) =>
  LOG_LEVELS.map((level) => ({
    setting,
    level,
    expected: setting !== 'silent' && LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(setting),
  })),
);

/**
 * Restores whatever a case touched globally, after every case in this file.
 *
 * Declared once at module scope rather than per suite, and unconditional: it
 * runs after a failing case too, so a console spy or a stubbed global can never
 * leak into the next case — nor into another file sharing the worker, since a
 * console left spied would silently discard output the rest of the run needs.
 * The suites that also freeze the clock add their own `useRealTimers` hook; hook
 * registrations compose rather than replace one another.
 */
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/*
 * ---------------------------------------------------------------------------
 * The level vocabulary: LOG_LEVELS and LOG_LEVEL_VALUES
 * ---------------------------------------------------------------------------
 */

describe('LOG_LEVELS', () => {
  it('is the six pino severities in ascending order of severity', () => {
    // Stated as a literal rather than compared against anything derived: this
    // tuple IS the vocabulary `DEBUGGEN_LOG_LEVEL` is parsed against and the
    // one `@debuggen/protocol` and both user interfaces spell out, so a
    // rename has to be visible here as a failing assertion.
    expect(LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  });

  it('has exactly six entries and no duplicate', () => {
    expect(LOG_LEVELS).toHaveLength(6);
    expect(new Set(LOG_LEVELS).size).toBe(6);
  });

  it('excludes silent, which is a threshold and never a severity', () => {
    // The type-level distinction (`LogLevel` vs `LogLevelSetting`) is what lets
    // a sink switch exhaustively on `record.level` with no unreachable case;
    // this is its runtime half.
    expect([...LOG_LEVELS]).not.toContain('silent');
  });

  it('is ordered so that each entry is strictly less severe than the next', () => {
    const values = LOG_LEVELS.map((level) => LOG_LEVEL_VALUES[level]);
    const ascending = [...values].sort((left, right) => left - right);

    expect(values).toEqual(ascending);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('LOG_LEVEL_VALUES', () => {
  it("assigns pino's own numbers to the six severities", () => {
    // 10/20/30/40/50/60 are not arbitrary: they are what pino uses, which is
    // the reason the service's adapter needs no mapping table in either
    // direction. Asserted as a whole object so an added or dropped key fails.
    expect(LOG_LEVEL_VALUES).toEqual({
      trace: 10,
      debug: 20,
      info: 30,
      warn: 40,
      error: 50,
      fatal: 60,
      silent: Number.POSITIVE_INFINITY,
    });
  });

  it('has one entry for every level plus silent, and nothing else', () => {
    expect(Object.keys(LOG_LEVEL_VALUES).sort()).toEqual([...LEVEL_SETTINGS].sort());
    expect(Object.keys(LOG_LEVEL_VALUES)).toHaveLength(7);
  });

  it('gives every severity a finite number', () => {
    for (const level of LOG_LEVELS) {
      expect(Number.isFinite(LOG_LEVEL_VALUES[level])).toBe(true);
    }
  });

  it('makes silent unreachable by arithmetic rather than by a sentinel', () => {
    // A sentinel such as 0 or -1 would need a special case in every comparison;
    // positive infinity means no finite severity can pass a silent threshold,
    // which is the single comparison `isLevelEnabled` is built on.
    expect(LOG_LEVEL_VALUES.silent).toBe(Number.POSITIVE_INFINITY);

    for (const level of LOG_LEVELS) {
      expect(LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES.silent).toBe(false);
    }
  });

  it('is frozen, because every logger in the process reads this one table', () => {
    expect(Object.isFrozen(LOG_LEVEL_VALUES)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * isLevelEnabled
 * ---------------------------------------------------------------------------
 */

describe('isLevelEnabled', () => {
  it('is exercised over the complete seven-by-six truth table', () => {
    // Guards the table itself: a filter or a typo in LEVEL_CASES would quietly
    // shrink the coverage of the `it.each` below, and every case in it would
    // still pass. 21 enabled answers = 6 + 5 + 4 + 3 + 2 + 1 for the six
    // finite thresholds, and none at all for silent.
    expect(LEVEL_CASES).toHaveLength(42);
    expect(LEVEL_CASES.filter((entry) => entry.expected)).toHaveLength(21);
  });

  it.each(LEVEL_CASES)(
    'a logger set to $setting returns $expected for a $level record',
    ({ setting, level, expected }: LevelCase) => {
      expect(isLevelEnabled(setting, level)).toBe(expected);
    },
  );

  it('admits the level it is set to', () => {
    for (const level of LOG_LEVELS) {
      expect(isLevelEnabled(level, level)).toBe(true);
    }
  });

  it('answers the documented examples', () => {
    // The three cases spelled out in the function's own doc comment, so the
    // documentation and the behaviour cannot drift apart unnoticed.
    expect(isLevelEnabled('warn', 'error')).toBe(true);
    expect(isLevelEnabled('warn', 'info')).toBe(false);
    expect(isLevelEnabled('silent', 'fatal')).toBe(false);
  });

  it('disables all six severities when set to silent', () => {
    for (const level of LOG_LEVELS) {
      expect(isLevelEnabled('silent', level)).toBe(false);
    }
  });

  it('admits every severity when set to trace', () => {
    for (const level of LOG_LEVELS) {
      expect(isLevelEnabled('trace', level)).toBe(true);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * createConsoleLogger with an injected sink: the record shape
 * ---------------------------------------------------------------------------
 */

describe('createConsoleLogger record shape', () => {
  it('emits a record whose members are exactly level, message, fields and time', () => {
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    log.info('capture started', { captureId: 'cap_7' });

    const record = onlyRecord(source);

    expect(record.level).toBe('info');
    expect(record.message).toBe('capture started');
    expect(record.fields).toEqual({ captureId: 'cap_7' });
    expect(typeof record.time).toBe('number');
    // Sorted, so the assertion is about the key SET and not about the order the
    // implementation happens to build the object literal in.
    expect(Object.keys(record).sort()).toEqual(['fields', 'level', 'message', 'time']);
  });

  it('keeps the message in message and the fields in fields (the pino flip guard)', () => {
    // The regression this file exists to catch, asserted on both members at
    // once: an implementation that swapped them would satisfy neither. See the
    // overview — `apps/local-service/src/logging.ts` is the only file allowed
    // to flip these two arguments, because pino's own API is `(obj, msg)`.
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    // The route is a made-up path on purpose. AAP 0.5.4 forbids product code
    // from naming anything the demo application defines, and a fixture is the
    // easiest place for such a name to slip in: `scripts/check-no-hardcoding.mjs`
    // excludes tests from its scan today, so a demo route used here would pass
    // the gate while still coupling the base layer to the demo.
    log.warn('route handler exceeded its budget', { route: '/api/example' });

    const record = onlyRecord(source);

    expect(record.message).toBe('route handler exceeded its budget');
    expect(typeof record.message).toBe('string');
    expect(record.message).not.toBe('[object Object]');
    expect(record.fields).toEqual({ route: '/api/example' });
    expect(typeof record.fields).toBe('object');
  });

  it.each(LOG_LEVELS.map((level) => ({ level })))(
    'records $level as the level when the $level method is called',
    ({ level }: { readonly level: LogLevel }) => {
      const source = recorder();
      const log = createConsoleLogger({ level: 'trace', sink: source.sink });

      emitAt(log, level, 'message for one severity');

      expect(onlyRecord(source).level).toBe(level);
    },
  );

  it('carries an empty object as fields when the call site passes none', () => {
    // `fields` is always an object so a sink never has to branch on its
    // presence — that promise is what a formatter and the protocol's schemas
    // are written against.
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    log.error('provider unavailable');

    const record = onlyRecord(source);

    expect(record.fields).toEqual({});
    expect(Object.keys(record.fields)).toHaveLength(0);
  });

  it('omits the name key entirely when no name is configured', () => {
    // Present-and-`undefined` is not good enough: a JSON round-trip turns an
    // explicit `undefined` into `null`, and a schema then rejects the record.
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    log.info('unnamed subsystem');

    const record = onlyRecord(source);

    expect('name' in record).toBe(false);
    expect(Object.keys(record)).not.toContain('name');
  });

  it('records the configured name on every record', () => {
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', name: 'agent', sink: source.sink });

    log.trace('hooks attached');
    log.fatal('page went away');

    expect(source.records).toHaveLength(2);
    expect(recordAt(source, 0).name).toBe('agent');
    expect(recordAt(source, 1).name).toBe('agent');
    expect(Object.keys(recordAt(source, 0)).sort()).toEqual([
      'fields',
      'level',
      'message',
      'name',
      'time',
    ]);
  });

  it('passes an empty message through unchanged rather than substituting one', () => {
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    log.debug('');

    expect(onlyRecord(source).message).toBe('');
  });
});

/*
 * ---------------------------------------------------------------------------
 * createConsoleLogger: the timestamp
 * ---------------------------------------------------------------------------
 */

describe('createConsoleLogger timestamps', () => {
  afterEach(() => {
    // Real timers restored after every case in this suite, including a failing
    // one, so no other suite in this file or in the worker inherits a frozen
    // clock.
    vi.useRealTimers();
  });

  it('stamps the exact instant the canonical time base reports', () => {
    // Only `Date` is faked: `nowEpochMs()` is `Date.now()`, and faking timers
    // wholesale would replace scheduling primitives this test has no business
    // touching.
    const fixed = 1_700_000_000_123;
    vi.useFakeTimers({ now: fixed, toFake: ['Date'] });

    const source = recorder();
    createConsoleLogger({ level: 'trace', sink: source.sink }).info('at a known instant');

    expect(onlyRecord(source).time).toBe(fixed);
  });

  it('stamps whole epoch milliseconds from the real clock', () => {
    // The unit matters as much as the value: a log record's time has to be
    // comparable with a session row's `createdAt` and a span's `startTime`
    // without a second convention, so it is epoch milliseconds and not a
    // monotonic reading.
    const source = recorder();
    const before = Date.now();

    createConsoleLogger({ level: 'trace', sink: source.sink }).info('now');

    const after = Date.now();
    const { time } = onlyRecord(source);

    expect(Number.isInteger(time)).toBe(true);
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(after);
  });

  it('stamps each record independently rather than reusing one instant', () => {
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });

    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    log.info('first');
    vi.setSystemTime(1_700_000_000_050);
    log.info('second');

    expect(recordAt(source, 0).time).toBe(1_700_000_000_000);
    expect(recordAt(source, 1).time).toBe(1_700_000_000_050);
  });
});

/*
 * ---------------------------------------------------------------------------
 * createConsoleLogger: the level gate
 * ---------------------------------------------------------------------------
 */

describe('createConsoleLogger level filtering', () => {
  it('drops trace, debug and info at a warn threshold and keeps the rest', () => {
    const source = recorder();
    const log = createConsoleLogger({ level: 'warn', sink: source.sink });

    log.trace('dropped');
    log.debug('dropped');
    log.info('dropped');

    expect(source.records).toHaveLength(0);

    log.warn('kept');
    log.error('kept');
    log.fatal('kept');

    expect(source.records.map((record) => record.level)).toEqual(['warn', 'error', 'fatal']);
  });

  it('emits nothing at all at a silent threshold', () => {
    const source = recorder();
    const log = createConsoleLogger({ level: 'silent', name: 'service', sink: source.sink });

    for (const level of LOG_LEVELS) {
      emitAt(log, level, 'never emitted', { attempted: level });
    }

    expect(source.records).toHaveLength(0);
  });

  it.each(LEVEL_SETTINGS.map((setting) => ({ setting })))(
    'a logger at $setting emits exactly the severities at or above it',
    ({ setting }: { readonly setting: LogLevelSetting }) => {
      const source = recorder();
      const log = createConsoleLogger({ level: setting, sink: source.sink });

      for (const level of LOG_LEVELS) {
        emitAt(log, level, 'one line per severity');
      }

      // Expectation from tuple position, not from `isLevelEnabled`: the gate
      // and the predicate are pinned independently on purpose.
      const admitted = setting === 'silent' ? [] : LOG_LEVELS.slice(LOG_LEVELS.indexOf(setting));

      expect(source.records.map((record) => record.level)).toEqual(admitted);
    },
  );

  it('does not touch the sink for a record the gate drops', () => {
    // The gate runs before the record is built, which is why a disabled call
    // allocates nothing; a sink that throws proves it was never reached.
    const log = createConsoleLogger({
      level: 'error',
      sink: () => {
        throw new Error('the sink must not be called for a dropped record');
      },
    });

    expect(() => {
      log.info('dropped before anything is assembled');
    }).not.toThrow();
  });
});

/*
 * ---------------------------------------------------------------------------
 * createConsoleLogger: options and defaults
 * ---------------------------------------------------------------------------
 */

describe('createConsoleLogger options', () => {
  it('defaults the threshold to info', () => {
    const source = recorder();
    const log = createConsoleLogger({ sink: source.sink });

    expect(log.level).toBe('info');

    log.debug('below the default');
    log.info('at the default');

    expect(source.records.map((record) => record.level)).toEqual(['info']);
  });

  it('accepts no options at all', () => {
    // No sink is configured here, so nothing may be emitted: the call itself
    // performs no I/O, which is what keeps this test silent.
    expect(createConsoleLogger().level).toBe('info');
  });

  it.each(LEVEL_SETTINGS.map((setting) => ({ setting })))(
    'reports $setting on level when $setting was configured',
    ({ setting }: { readonly setting: LogLevelSetting }) => {
      const source = recorder();

      expect(createConsoleLogger({ level: setting, sink: source.sink }).level).toBe(setting);
    },
  );

  it('merges configured bindings into every record below per-call fields', () => {
    const source = recorder();
    const log = createConsoleLogger({
      level: 'trace',
      sink: source.sink,
      bindings: { tier: 'browser', producerId: 'prod_1' },
    });

    log.info('configured bindings only');
    log.info('with per-call fields', { tier: 'server' });

    expect(recordAt(source, 0).fields).toEqual({ tier: 'browser', producerId: 'prod_1' });
    expect(recordAt(source, 1).fields).toEqual({ tier: 'server', producerId: 'prod_1' });
  });

  it('treats an empty bindings object as no bindings', () => {
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink, bindings: {} });

    log.info('no context of any kind');

    expect(onlyRecord(source).fields).toEqual({});
  });
});

/*
 * ---------------------------------------------------------------------------
 * createConsoleLogger: per-call fields
 * ---------------------------------------------------------------------------
 */

describe('createConsoleLogger per-call fields', () => {
  it('passes nested values through by reference, without serialising them', () => {
    // A sink decides how to serialise; this module must not. The nested object
    // is asserted by identity, so a defensive deep copy — which would both cost
    // allocations on the agent's hot path and lose a class instance a sink
    // wanted to inspect — fails here.
    const nested = { attempted: 3, stages: ['plan', 'capture'] };
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    log.debug('retrying', { nested, count: 2 });

    const record = onlyRecord(source);

    expect(record.fields).toEqual({ nested, count: 2 });
    expect(record.fields['nested']).toBe(nested);
  });

  it('keeps a key whose value is undefined rather than dropping it', () => {
    // A key that is present with no value says "this was looked up and was
    // absent", which is a different statement from the key not being there at
    // all — and the sink, not this module, is what gets to decide how to print
    // either one.
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    log.warn('signal unavailable', { signal: 'db.query', reason: undefined });

    const record = onlyRecord(source);

    expect('reason' in record.fields).toBe(true);
    expect(record.fields['reason']).toBeUndefined();
    expect(record.fields['signal']).toBe('db.query');
  });

  it('does not copy the field bag of an unbound logger', () => {
    // The documented allocation-free path: with no bindings to merge, the
    // record's `fields` IS the caller's object. A sink that retains a record
    // beyond the synchronous call is the party responsible for copying.
    const fields: LogFields = { captureId: 'cap_7' };
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    log.info('no bindings', fields);

    expect(onlyRecord(source).fields).toBe(fields);
  });

  it('does not mutate a frozen field bag, and merges into a new object instead', () => {
    // Logging may never be the reason unrelated code breaks: a call site is
    // free to pass a frozen or shared object, and an in-place merge would throw
    // in a strict-mode module — or, worse, succeed and corrupt it.
    const fields: LogFields = Object.freeze({ captureId: 'cap_7' });
    const source = recorder();
    const log = createConsoleLogger({
      level: 'trace',
      sink: source.sink,
      bindings: { tier: 'browser' },
    });

    expect(() => {
      log.info('merged onto bindings', fields);
    }).not.toThrow();

    const record = onlyRecord(source);

    expect(record.fields).toEqual({ tier: 'browser', captureId: 'cap_7' });
    expect(record.fields).not.toBe(fields);
    expect(Object.keys(fields)).toEqual(['captureId']);
  });

  it('does not mutate the bindings object the caller configured', () => {
    const bindings: LogFields = { tier: 'browser' };
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink, bindings });

    log.info('overriding a binding', { tier: 'server', captureId: 'cap_7' });

    expect(bindings).toEqual({ tier: 'browser' });
    expect(onlyRecord(source).fields).toEqual({ tier: 'server', captureId: 'cap_7' });
  });

  it('accepts an explicitly empty field bag', () => {
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    log.info('nothing to add', {});

    expect(Object.keys(onlyRecord(source).fields)).toHaveLength(0);
  });

  it('shares one frozen empty bag across every context-free record', () => {
    // Two documented decisions in one assertion. The shared instance is what
    // keeps a message-only log line — overwhelmingly the common case, and the
    // page agent's hot path — from allocating a field bag it will never fill.
    // Freezing is what makes sharing safe: a sink that tried to enrich the bag
    // in place would otherwise corrupt every later record in the process.
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    log.info('first with no context');
    log.warn('second with no context');

    const first = recordAt(source, 0);
    const second = recordAt(source, 1);

    expect(first.fields).toBe(second.fields);
    expect(Object.isFrozen(first.fields)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The sink contract
 * ---------------------------------------------------------------------------
 */

describe('the injected sink', () => {
  it('receives records synchronously, in emission order', () => {
    const source = recorder();
    const log = createConsoleLogger({ level: 'trace', sink: source.sink });

    log.trace('first');
    expect(source.records).toHaveLength(1);

    log.info('second');
    log.fatal('third');

    expect(source.records.map((record) => record.message)).toEqual(['first', 'second', 'third']);
  });

  it('propagates its own failure to the logging call site', () => {
    // Deliberate: a destination the caller chose is the caller's problem. A
    // swallowed sink error would make a broken transport look like a quiet one.
    const log = createConsoleLogger({
      level: 'trace',
      sink: () => {
        throw new Error('sink is down');
      },
    });

    expect(() => {
      log.error('something to report');
    }).toThrow('sink is down');
  });

  it('is used instead of the console, which stays untouched', () => {
    const spies = installConsoleSpies();
    const source = recorder();

    createConsoleLogger({ level: 'trace', sink: source.sink }).info('to the sink only');

    expect(source.records).toHaveLength(1);
    for (const method of CONSOLE_METHODS) {
      expect(spies[method]).not.toHaveBeenCalled();
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * child bindings
 * ---------------------------------------------------------------------------
 */

describe('child', () => {
  it('returns a new logger rather than the one it was called on', () => {
    const source = recorder();
    const parent = createConsoleLogger({ level: 'trace', sink: source.sink });

    expect(parent.child({ sessionId: 'ses_1' })).not.toBe(parent);
  });

  it('adds its bindings to every record it emits', () => {
    const source = recorder();
    const child = createConsoleLogger({ level: 'trace', sink: source.sink }).child({
      sessionId: 'ses_1',
    });

    child.info('first from the child');
    child.warn('second from the child', { captureId: 'cap_7' });

    expect(recordAt(source, 0).fields).toEqual({ sessionId: 'ses_1' });
    expect(recordAt(source, 1).fields).toEqual({ sessionId: 'ses_1', captureId: 'cap_7' });
  });

  it('leaves the parent without the child bindings', () => {
    // No shared mutable state: the service binds `{ sessionId }` on a session's
    // logger and keeps using the process-wide parent for everything else, so a
    // child that wrote into its parent would attribute unrelated lines to a
    // session.
    const source = recorder();
    const parent = createConsoleLogger({ level: 'trace', sink: source.sink });
    const child = parent.child({ sessionId: 'ses_1' });

    child.info('from the child');
    parent.info('from the parent');

    expect(recordAt(source, 0).fields).toEqual({ sessionId: 'ses_1' });
    expect(recordAt(source, 1).fields).toEqual({});
  });

  it('does not mutate the bindings object handed to it', () => {
    const bindings: LogFields = { sessionId: 'ses_1' };
    const source = recorder();
    const child = createConsoleLogger({ level: 'trace', sink: source.sink }).child(bindings);

    child.info('overriding a child binding', { sessionId: 'ses_2' });

    expect(bindings).toEqual({ sessionId: 'ses_1' });
  });

  it('accepts frozen bindings', () => {
    const source = recorder();
    const child = createConsoleLogger({
      level: 'trace',
      sink: source.sink,
      bindings: { tier: 'server' },
    }).child(Object.freeze({ sessionId: 'ses_1' }));

    expect(() => {
      child.info('frozen bindings merged');
    }).not.toThrow();

    expect(onlyRecord(source).fields).toEqual({ tier: 'server', sessionId: 'ses_1' });
  });

  it('accumulates bindings across nested children', () => {
    const source = recorder();
    const root = createConsoleLogger({
      level: 'trace',
      sink: source.sink,
      bindings: { tier: 'server' },
    });
    const child = root.child({ sessionId: 'ses_1' });
    const grandchild = child.child({ captureId: 'cap_7' });

    grandchild.info('three generations of bindings');

    expect(onlyRecord(source).fields).toEqual({
      tier: 'server',
      sessionId: 'ses_1',
      captureId: 'cap_7',
    });
  });

  it('resolves per-call over child over parent, in one record', () => {
    // The documented precedence, asserted on a single record so the order is
    // unambiguous: `layer` is set by all three, and the per-call value is the
    // one that survives; every other key proves its own layer contributed.
    const source = recorder();
    const parent = createConsoleLogger({
      level: 'trace',
      name: 'service',
      sink: source.sink,
      bindings: { layer: 'parent', fromParent: true },
    });
    const child = parent.child({ layer: 'child', fromChild: true });

    child.info('all three layers at once', { layer: 'per-call', fromCall: true });

    const record = onlyRecord(source);

    expect(record.fields).toEqual({
      layer: 'per-call',
      fromParent: true,
      fromChild: true,
      fromCall: true,
    });
    expect(record.fields['layer']).toBe('per-call');
  });

  it('lets a deeper child override a shallower one', () => {
    const source = recorder();
    const grandchild = createConsoleLogger({
      level: 'trace',
      sink: source.sink,
      bindings: { layer: 'parent' },
    })
      .child({ layer: 'child' })
      .child({ layer: 'grandchild' });

    grandchild.info('deepest binding wins when no per-call field is given');

    expect(onlyRecord(source).fields).toEqual({ layer: 'grandchild' });
  });

  it('inherits the level, and filters with it', () => {
    const source = recorder();
    const child = createConsoleLogger({ level: 'warn', sink: source.sink }).child({
      sessionId: 'ses_1',
    });

    expect(child.level).toBe('warn');

    child.info('below the inherited threshold');
    expect(source.records).toHaveLength(0);

    child.error('above it');
    expect(onlyRecord(source).level).toBe('error');
  });

  it('inherits the name', () => {
    const source = recorder();
    const child = createConsoleLogger({ level: 'trace', name: 'service', sink: source.sink }).child(
      { sessionId: 'ses_1' },
    );

    child.info('named through inheritance');

    expect(onlyRecord(source).name).toBe('service');
  });

  it('inherits the sink, so a child cannot redirect its parent output', () => {
    const parentSink = recorder();
    const child = createConsoleLogger({ level: 'trace', sink: parentSink.sink }).child({
      sessionId: 'ses_1',
    });
    const spies = installConsoleSpies();

    child.info('through the inherited sink');

    expect(parentSink.records).toHaveLength(1);
    for (const method of CONSOLE_METHODS) {
      expect(consoleCalls(spies[method])).toEqual([]);
    }
  });

  it('stays silent when created from a silent logger', () => {
    const source = recorder();
    const child = createConsoleLogger({ level: 'silent', sink: source.sink }).child({
      sessionId: 'ses_1',
    });

    expect(child.level).toBe('silent');

    for (const level of LOG_LEVELS) {
      emitAt(child, level, 'never emitted', { sessionId: 'ses_1' });
    }

    expect(source.records).toHaveLength(0);
  });

  it('treats empty bindings as no change at all', () => {
    const source = recorder();
    const child = createConsoleLogger({
      level: 'trace',
      sink: source.sink,
      bindings: { tier: 'browser' },
    }).child({});

    child.info('unchanged context');

    expect(onlyRecord(source).fields).toEqual({ tier: 'browser' });
  });

  it('does not write into the bindings of a parent that already has some', () => {
    // The mutation this case exists for: a `child()` that merged with
    // `Object.assign(parentBindings, …)` instead of building a new bag. Every
    // other child test passes under it, because they use either a parent with
    // no bindings or a fresh per-call bag — so the parent has to carry bindings
    // AND log after the child was created for the corruption to surface.
    const bindings: LogFields = { tier: 'server' };
    const source = recorder();
    const parent = createConsoleLogger({ level: 'trace', sink: source.sink, bindings });

    const child = parent.child({ sessionId: 'ses_1' });
    child.info('from the child');
    parent.info('from the parent');

    expect(recordAt(source, 0).fields).toEqual({ tier: 'server', sessionId: 'ses_1' });
    expect(recordAt(source, 1).fields).toEqual({ tier: 'server' });
    expect(bindings).toEqual({ tier: 'server' });
  });

  it('can be created from a parent whose bindings are frozen', () => {
    // The same guarantee from the other side: an in-place merge into the
    // parent's bag throws outright here, and a call site is entitled to pass a
    // frozen or shared object to `createConsoleLogger`.
    const source = recorder();
    const parent = createConsoleLogger({
      level: 'trace',
      sink: source.sink,
      bindings: Object.freeze({ tier: 'server' }),
    });

    expect(() => {
      parent.child({ sessionId: 'ses_1' }).info('from the child');
    }).not.toThrow();

    expect(onlyRecord(source).fields).toEqual({ tier: 'server', sessionId: 'ses_1' });
  });

  it('keeps siblings independent of one another and of the parent', () => {
    // Both children are created before either logs, so a shared bindings bag
    // would show the second session's id on the first child's record.
    const source = recorder();
    const parent = createConsoleLogger({
      level: 'trace',
      sink: source.sink,
      bindings: { tier: 'server' },
    });
    const first = parent.child({ sessionId: 'ses_1' });
    const second = parent.child({ sessionId: 'ses_2' });

    first.info('from the first session');
    second.info('from the second session');
    parent.info('from the parent');

    expect(recordAt(source, 0).fields).toEqual({ tier: 'server', sessionId: 'ses_1' });
    expect(recordAt(source, 1).fields).toEqual({ tier: 'server', sessionId: 'ses_2' });
    expect(recordAt(source, 2).fields).toEqual({ tier: 'server' });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The default console sink
 * ---------------------------------------------------------------------------
 */

/** One severity and the console method the default sink must write it to. */
interface ConsoleCase {
  /** Severity emitted. */
  readonly level: LogLevel;

  /** Console method that must receive it. */
  readonly method: ConsoleMethod;
}

/**
 * The complete severity-to-console mapping, one case per severity.
 *
 * `trace` joins `debug` because Chrome files `console.debug` under "Verbose",
 * which is where per-event agent output belongs, and `fatal` joins `error`
 * because no console has a sixth channel.
 */
const CONSOLE_CASES: readonly ConsoleCase[] = [
  { level: 'trace', method: 'debug' },
  { level: 'debug', method: 'debug' },
  { level: 'info', method: 'info' },
  { level: 'warn', method: 'warn' },
  { level: 'error', method: 'error' },
  { level: 'fatal', method: 'error' },
];

describe('the default console sink', () => {
  it('covers every severity exactly once', () => {
    // Guards the table: a missing severity would silently drop a case from the
    // mapping suite below.
    expect(CONSOLE_CASES.map((entry) => entry.level)).toEqual([...LOG_LEVELS]);
  });

  it.each(CONSOLE_CASES)(
    'writes a $level record to console.$method and to nothing else',
    ({ level, method }: ConsoleCase) => {
      const spies = installConsoleSpies();

      emitAt(createConsoleLogger({ level: 'trace', name: 'agent' }), level, 'one record', {
        captureId: 'cap_7',
      });

      expectOnlyConsoleCall(spies, method, '[agent] one record', { captureId: 'cap_7' });
    },
  );

  it('never uses console.trace, whose stack trace would bury a per-event log', () => {
    const spies = installConsoleSpies();
    const traceSpy = vi.spyOn(console, 'trace').mockImplementation(() => undefined);

    createConsoleLogger({ level: 'trace' }).trace('per-event detail');

    expect(consoleCalls(traceSpy)).toEqual([]);
    expect(consoleCalls(spies.debug)).toEqual([['per-event detail']]);
  });

  it('prefixes the configured name so shared consoles stay readable', () => {
    const spies = installConsoleSpies();

    createConsoleLogger({ level: 'trace', name: 'panel' }).info('bound to a session');

    expectOnlyConsoleCall(spies, 'info', '[panel] bound to a session');
  });

  it('writes the bare message when no name is configured', () => {
    const spies = installConsoleSpies();

    createConsoleLogger({ level: 'trace' }).info('bound to a session');

    expectOnlyConsoleCall(spies, 'info', 'bound to a session');
  });

  it('passes fields as a second argument only when there are any', () => {
    // The whole reason for the rule: an empty object printed beside every
    // message turns a readable DevTools console into noise. One argument for a
    // fields-free line, two when there is context.
    const spies = installConsoleSpies();
    const log = createConsoleLogger({ level: 'trace' });

    log.info('no context at all');
    log.warn('with context', { signal: 'db.query' });

    expect(consoleCalls(spies.info)).toEqual([['no context at all']]);
    expect(consoleCalls(spies.warn)).toEqual([['with context', { signal: 'db.query' }]]);
  });

  it('omits the fields argument for an explicitly empty field bag', () => {
    const spies = installConsoleSpies();

    createConsoleLogger({ level: 'trace' }).info('nothing to add', {});

    expectOnlyConsoleCall(spies, 'info', 'nothing to add');
  });

  it('applies the level gate before it reaches the console', () => {
    const spies = installConsoleSpies();
    const log = createConsoleLogger({ level: 'error' });

    log.trace('dropped');
    log.debug('dropped');
    log.info('dropped');
    log.warn('dropped');

    for (const method of CONSOLE_METHODS) {
      expect(consoleCalls(spies[method])).toEqual([]);
    }

    log.fatal('kept');

    expect(consoleCalls(spies.error)).toEqual([['kept']]);
  });

  it('writes child bindings to the console as merged fields', () => {
    const spies = installConsoleSpies();

    createConsoleLogger({ level: 'trace', name: 'service' })
      .child({ sessionId: 'ses_1' })
      .error('capture failed', { stage: 'analyze' });

    expectOnlyConsoleCall(spies, 'error', '[service] capture failed', {
      sessionId: 'ses_1',
      stage: 'analyze',
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The default console sink in a hostile page
 * ---------------------------------------------------------------------------
 */

describe('the default console sink with an unusable console', () => {
  // The worst case this sink is written for is the MAIN world of a page the
  // tool does not control, where `console` may have been deleted, replaced or
  // given throwing accessors. A logging call that threw there would break the
  // product code that made it, so every case below asserts silence rather than
  // an exception. The module-level `afterEach` unstubs the global.

  it('does nothing when there is no console at all', () => {
    vi.stubGlobal('console', undefined);

    expect(() => {
      createConsoleLogger({ level: 'trace' }).error('nowhere left to report this');
    }).not.toThrow();
  });

  it('does nothing when console is not an object', () => {
    vi.stubGlobal('console', 'replaced by the page');

    expect(() => {
      createConsoleLogger({ level: 'trace' }).info('a record with nowhere to go');
    }).not.toThrow();
  });

  it('falls back to console.log when the preferred method is missing', () => {
    const calls: unknown[][] = [];
    vi.stubGlobal('console', {
      log: (...args: unknown[]) => {
        calls.push(args);
      },
    });

    createConsoleLogger({ level: 'trace', name: 'agent' }).warn('degraded', {
      signal: 'db.query',
    });

    expect(calls).toEqual([['[agent] degraded', { signal: 'db.query' }]]);
  });

  it('does nothing when neither the preferred method nor log is callable', () => {
    vi.stubGlobal('console', { error: 'not a function', log: 42 });

    expect(() => {
      createConsoleLogger({ level: 'trace' }).fatal('unrecoverable');
    }).not.toThrow();
  });

  it('swallows a console method that throws', () => {
    vi.stubGlobal('console', {
      error: () => {
        throw new Error('hostile console');
      },
    });

    expect(() => {
      createConsoleLogger({ level: 'trace' }).fatal('unrecoverable');
    }).not.toThrow();
  });

  it('calls the console method with the console as its receiver', () => {
    // Some console implementations require their own receiver; a detached
    // function reference would throw in those, which the `catch` would then
    // hide as missing output.
    const receivers: unknown[] = [];
    const host = {
      info(this: unknown): void {
        receivers.push(this);
      },
    };
    vi.stubGlobal('console', host);

    createConsoleLogger({ level: 'trace' }).info('who is this');

    expect(receivers).toEqual([host]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * noopLogger
 * ---------------------------------------------------------------------------
 */

describe('noopLogger', () => {
  it('reports silent as its level', () => {
    // Load-bearing: code that guards expensive field assembly with
    // `isLevelEnabled(logger.level, 'debug')` must skip that work entirely when
    // it was handed the noop logger.
    expect(noopLogger.level).toBe('silent');
    expect(isLevelEnabled(noopLogger.level, 'fatal')).toBe(false);
  });

  it('returns undefined from every method', () => {
    expect(noopLogger.trace('discarded')).toBeUndefined();
    expect(noopLogger.debug('discarded')).toBeUndefined();
    expect(noopLogger.info('discarded')).toBeUndefined();
    expect(noopLogger.warn('discarded')).toBeUndefined();
    expect(noopLogger.error('discarded')).toBeUndefined();
    expect(noopLogger.fatal('discarded')).toBeUndefined();
  });

  it('writes nothing anywhere, including through a child', () => {
    const spies = installConsoleSpies();
    const traceSpy = vi.spyOn(console, 'trace').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    for (const level of LOG_LEVELS) {
      emitAt(noopLogger, level, 'discarded', { captureId: 'cap_7' });
    }
    noopLogger.child({ sessionId: 'ses_1' }).info('discarded too');

    for (const method of CONSOLE_METHODS) {
      expect(consoleCalls(spies[method])).toEqual([]);
    }
    expect(consoleCalls(traceSpy)).toEqual([]);
    expect(consoleCalls(logSpy)).toEqual([]);
  });

  it('returns its own identity from child, at any depth', () => {
    // The singleton is stateless, so there is nothing for a child to own — and
    // identity is what makes a per-session child in library code free.
    expect(noopLogger.child({ sessionId: 'ses_1' })).toBe(noopLogger);
    expect(noopLogger.child({}).child({ captureId: 'cap_7' })).toBe(noopLogger);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(noopLogger)).toBe(true);
  });

  it('exposes exactly the same members as a console logger', () => {
    // `logger: Logger = noopLogger` only works while the two implementations
    // are interchangeable at runtime as well as at the type level.
    const source = recorder();
    const real = createConsoleLogger({ sink: source.sink });

    expect(Object.keys(noopLogger).sort()).toEqual(Object.keys(real).sort());
    expect(Object.keys(noopLogger).sort()).toEqual([
      'child',
      'debug',
      'error',
      'fatal',
      'info',
      'level',
      'trace',
      'warn',
    ]);
  });

  it('is a drop-in default for library code that logs', () => {
    // The pattern `logger.ts` documents and the whole product follows: a
    // function takes `logger: Logger = noopLogger`, so it logs when its caller
    // wants logs and stays silent otherwise, with no global and no `if`.
    function ingest(events: readonly unknown[], logger: Logger = noopLogger): number {
      logger.debug('ingesting batch', { count: events.length });
      return events.length;
    }

    const spies = installConsoleSpies();

    expect(ingest([1, 2])).toBe(2);
    for (const method of CONSOLE_METHODS) {
      expect(consoleCalls(spies[method])).toEqual([]);
    }

    const source = recorder();

    expect(ingest([1, 2], createConsoleLogger({ level: 'trace', sink: source.sink }))).toBe(2);
    expect(onlyRecord(source).message).toBe('ingesting batch');
    expect(onlyRecord(source).fields).toEqual({ count: 2 });
  });
});
