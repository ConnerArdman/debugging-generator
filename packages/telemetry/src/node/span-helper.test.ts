// @vitest-environment node
/**
 * Tests for `./span-helper.ts` — `globalThis.__DEBUGGEN__.span` in the
 * developer's dev-server process, the runtime half of the reversible AST patch
 * contract (`docs/ARCHITECTURE.md` §7.2).
 *
 * ## What is on trial
 *
 * The patch template rewrites an application function so that its body becomes
 * `return __dbg.span(name, meta, () => __orig.apply(this, arguments))`. Whatever
 * this helper does is therefore what the developer's function does, and the
 * module states three guarantees that make the patch invisible to the
 * application. They are the assertions of this file; everything else is
 * support for them:
 *
 * 1. **`fn` runs exactly once on every path** — no provider, a provider that
 *    throws, a context manager that throws before or after the callback, and
 *    every error path. Every case counts invocations rather than trusting the
 *    return value, because the template's "a `null`/`undefined` result never
 *    re-invokes the body" is only true if the helper never calls `fn` twice.
 * 2. **The value comes back by reference, unchanged** — not awaited, not
 *    wrapped, falsy values included. Asserted with `toBe`, never `toEqual`.
 * 3. **A returned promise or thenable ends the span when it settles**, the
 *    caller receives the *same* object and its own `catch` still runs, and no
 *    unhandled rejection is manufactured. A synchronous throw rethrows the
 *    *same* error instance. `end()` is called exactly once per span — counted
 *    on a scripted span, because the SDK's own double-end guard would hide a
 *    second call from an exporter.
 *
 * Real spans come from a real `NodeTracerProvider` whose `register()` installs
 * the `AsyncLocalStorage` context manager, so the nesting assertions prove
 * `context.with` rather than a stack this file maintains.
 *
 * ## Habits
 *
 * - **Every global is handed back.** The OpenTelemetry API globals, the
 *   `__DEBUGGEN__` property and every spy are torn down in `afterEach`, so a
 *   provider or helper leaked by one case cannot let another pass for the wrong
 *   reason.
 * - **The two refusal shapes a host can impose on the global are simulated at
 *   the `Reflect` boundary**, and only for this module's property. A genuinely
 *   non-configurable property can never be removed from this realm's global
 *   again, so defining one would break every later case; the descriptor the
 *   host would report is what the module actually reads, so reporting it is
 *   the faithful reproduction.
 * - **Vocabulary and bounds are imported, never re-typed** — `TRACER_NAME`,
 *   `MAX_PREVIEW_LENGTH`, `MAX_TRACKED_KEYS`, `REDACTION_MARKER` and the
 *   marker constants — so a change to any of them reaches this suite.
 * - **No literal here resembles a credential.** The one bearer value is
 *   assembled from fragments, as `./control.test.ts` does, because
 *   `scripts/check-secrets.mjs` reads tracked test files too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  context,
  INVALID_SPAN_CONTEXT,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type {
  AttributeValue,
  Attributes,
  Exception,
  Link,
  Span,
  SpanContext,
  SpanStatus,
  TimeInput,
  Tracer,
  TracerProvider,
} from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import type { LogFields, Logger, LogLevel, LogLevelSetting } from '@debuggen/shared';

import { REDACTION_MARKER, truncate } from '../redaction/rules.js';
import { MAX_PREVIEW_LENGTH, MAX_TRACKED_KEYS } from '../schema/attributes.js';
import { TRACER_NAME, TRACER_VERSION } from './config.js';
import {
  DEBUGGEN_GLOBAL_KEY,
  FUNCTION_SPAN_MARKER_KEY,
  FUNCTION_SPAN_MARKER_VALUE,
  installSpanHelper,
  span,
  uninstallSpanHelper,
} from './span-helper.js';
import type { DebuggenSpanHelper } from './span-helper.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/** The span name every case that does not vary it uses. */
const SPAN_NAME = 'sampleOperation';

/** The patch metadata a real wrapper passes, in neutral vocabulary. */
const PATCH_META: Readonly<Record<string, unknown>> = Object.freeze({
  symbol: 'sampleOperation',
  module: 'src/server/services/sample.service.ts',
  actionId: 'act_sample',
});

/** The attribute this module writes to say how the span ended. */
const ASYNC_ATTRIBUTE = 'async';

/** Span name used when the caller supplied nothing usable. */
const FALLBACK_SPAN_NAME = 'debuggen.function';

/** The name of the event `recordException` adds to a span. */
const EXCEPTION_EVENT = 'exception';

/** The exception-message attribute on that event. */
const EXCEPTION_MESSAGE = 'exception.message';

/**
 * A bearer credential, assembled at runtime so no tracked literal resembles
 * one; long and dense enough for the content scrub to recognise.
 */
const BEARER_FRAGMENT = ['q7', 'Zr', 'x2', 'Lm', 'W9', 'pK'].join('').repeat(4);

/*
 * ---------------------------------------------------------------------------
 * Doubles
 * ---------------------------------------------------------------------------
 */

/** One line a diagnostic produced. */
interface LogEntry {
  /** The severity the call site chose. */
  readonly level: LogLevel;
  /** The message as written. */
  readonly message: string;
  /** The structured fields, where the call site passed any. */
  readonly fields?: LogFields | undefined;
}

/** A logger that keeps every record, so the warn paths can be asserted. */
class RecordingLogger implements Logger {
  /** Records everything; the threshold is not what this suite tests. */
  readonly level: LogLevelSetting = 'trace';

  /** Every record written through this logger or a child of it. */
  readonly entries: LogEntry[];

  /**
   * @param entries The store to append to; a child receives its parent's.
   */
  constructor(entries: LogEntry[] = []) {
    this.entries = entries;
  }

  trace(message: string, fields?: LogFields): void {
    this.#record('trace', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.#record('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#record('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#record('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#record('error', message, fields);
  }

  fatal(message: string, fields?: LogFields): void {
    this.#record('fatal', message, fields);
  }

  child(bindings: LogFields): Logger {
    void bindings;
    return new RecordingLogger(this.entries);
  }

  /** @returns The records written at `level`. */
  at(level: LogLevel): LogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }

  /**
   * Append one record.
   *
   * @param level The severity.
   * @param message The message.
   * @param fields The structured detail, where there was any.
   */
  #record(level: LogLevel, message: string, fields?: LogFields): void {
    this.entries.push(fields === undefined ? { level, message } : { level, message, fields });
  }
}

/**
 * A span that counts what the helper does to it, and optionally refuses all of
 * it.
 *
 * The exporter of a real provider cannot see a second `end()` — the SDK drops
 * it with a diagnostic — so "exactly once" is asserted here instead. The
 * hostile variant throws from every mutator, which is the "broken provider"
 * of guarantee 4: nothing it does may reach the application.
 */
class ScriptedSpan implements Span {
  /** How many times `end()` was called. */
  endCalls = 0;

  /** Every status set, in order. */
  readonly statuses: SpanStatus[] = [];

  /** Every exception recorded, in order. */
  readonly exceptions: Exception[] = [];

  /** The attributes set after the span started. */
  readonly attributes: Record<string, AttributeValue> = {};

  /** Whether every mutator throws. */
  readonly #hostile: boolean;

  /**
   * @param hostile Whether every mutator throws.
   */
  constructor(hostile: boolean) {
    this.#hostile = hostile;
  }

  spanContext(): SpanContext {
    return INVALID_SPAN_CONTEXT;
  }

  setAttribute(key: string, value: AttributeValue): this {
    this.#refuse();
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Attributes): this {
    this.#refuse();
    void attributes;
    return this;
  }

  addEvent(name: string): this {
    this.#refuse();
    void name;
    return this;
  }

  addLink(link: Link): this {
    this.#refuse();
    void link;
    return this;
  }

  addLinks(links: Link[]): this {
    this.#refuse();
    void links;
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.#refuse();
    this.statuses.push(status);
    return this;
  }

  updateName(name: string): this {
    this.#refuse();
    void name;
    return this;
  }

  end(endTime?: TimeInput): void {
    void endTime;
    this.endCalls += 1;
    this.#refuse();
  }

  isRecording(): boolean {
    return true;
  }

  recordException(exception: Exception, time?: TimeInput): void {
    void time;
    this.#refuse();
    this.exceptions.push(exception);
  }

  /** Throw when hostile. */
  #refuse(): void {
    if (this.#hostile) {
      throw new Error('scripted span refused the call');
    }
  }
}

/**
 * A provider whose tracer hands out {@link ScriptedSpan}s, or throws from
 * `startSpan` when told to.
 */
class ScriptedTracerProvider implements TracerProvider {
  /** Every span handed out, in order. */
  readonly spans: ScriptedSpan[] = [];

  /** How `startSpan` behaves. */
  readonly #mode: 'counting' | 'hostile' | 'throwing';

  /**
   * @param mode `counting` spans, `hostile` spans, or a `startSpan` that throws.
   */
  constructor(mode: 'counting' | 'hostile' | 'throwing') {
    this.#mode = mode;
  }

  getTracer(): Tracer {
    return {
      startSpan: (): Span => {
        if (this.#mode === 'throwing') {
          throw new Error('startSpan refused');
        }
        const created = new ScriptedSpan(this.#mode === 'hostile');
        this.spans.push(created);
        return created;
      },
      startActiveSpan: (): never => {
        throw new Error('startActiveSpan is not used by the helper');
      },
    };
  }

  /** @returns The only span handed out; fails the test otherwise. */
  soleSpan(): ScriptedSpan {
    expect(this.spans).toHaveLength(1);
    const [first] = this.spans;
    if (first === undefined) {
      throw new Error('no span was started');
    }
    return first;
  }
}

/** A promise with its settlement handles, for timing assertions. */
class Deferred<T> {
  /** The promise the handles settle. */
  readonly promise: Promise<T>;

  /** Resolve handle, captured from the executor. */
  #resolve: ((value: T) => void) | undefined;

  /** Reject handle, captured from the executor. */
  #reject: ((reason: unknown) => void) | undefined;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  /** @param value The fulfilment value. */
  resolve(value: T): void {
    this.#resolve?.(value);
  }

  /** @param reason The rejection reason. */
  reject(reason: unknown): void {
    this.#reject?.(reason);
  }
}

/** The handler pair a userland `then` receives. */
type Handlers = readonly [
  ((value: unknown) => unknown) | undefined,
  ((reason: unknown) => unknown) | undefined,
];

/**
 * A userland thenable whose `then` is scripted by the test.
 *
 * @param script What `then` does with the handlers it receives.
 * @returns The thenable and a counter of `then` calls.
 */
function scriptedThenable(script: (handlers: Handlers) => unknown): {
  readonly thenable: PromiseLike<unknown>;
  readonly calls: () => number;
} {
  let calls = 0;
  const thenable = {
    then(
      onFulfilled?: ((value: unknown) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ): PromiseLike<never> {
      calls += 1;
      return script([onFulfilled ?? undefined, onRejected ?? undefined]) as PromiseLike<never>;
    },
  };
  return { thenable, calls: () => calls };
}

/*
 * ---------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------
 */

/** The provider the current case registered, if any. */
let registered: NodeTracerProvider | undefined;

/** The exporter behind {@link registered}. */
let memory: InMemorySpanExporter | undefined;

/** Register a real provider with an in-memory exporter, globally. */
function registerRealProvider(): void {
  memory = new InMemorySpanExporter();
  registered = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
  registered.register();
}

/** @returns Every span the real provider exported. */
function finished(): ReadableSpan[] {
  return memory?.getFinishedSpans() ?? [];
}

/** @returns The only exported span; fails the test otherwise. */
function onlyFinished(): ReadableSpan {
  const spans = finished();
  expect(spans).toHaveLength(1);
  const [first] = spans;
  if (first === undefined) {
    throw new Error('no span was exported');
  }
  return first;
}

/**
 * @param name The span name.
 * @returns The exported span of that name; fails the test otherwise.
 */
function finishedNamed(name: string): ReadableSpan {
  const found = finished().find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no exported span is named ${name}`);
  }
  return found;
}

/**
 * Throw a value exactly as given, whatever its type.
 *
 * Patched application code can throw anything — a string, a number, a plain
 * record — and the helper must rethrow it unchanged. The parameter is typed
 * `unknown` because that is precisely what the module under test receives.
 *
 * @param value The value to throw.
 */
function throwValue(value: unknown): never {
  throw value;
}

/** Wait one macrotask, so every microtask the helper queued has run. */
async function macrotask(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Run `work` and report every unhandled rejection the process saw meanwhile.
 *
 * @param work The asynchronous case body.
 * @returns The reasons of the unhandled rejections, in order.
 */
async function unhandledRejectionsDuring(work: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    await work();
    await macrotask();
    await macrotask();
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

/** @returns Whatever occupies `globalThis.__DEBUGGEN__`. */
function readSlot(): unknown {
  return Reflect.get(globalThis, DEBUGGEN_GLOBAL_KEY);
}

/**
 * Put a value on the global the way a foreign actor would.
 *
 * @param value The value to park.
 */
function writeSlot(value: unknown): void {
  Reflect.defineProperty(globalThis, DEBUGGEN_GLOBAL_KEY, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * The `span` member of a value, read as data so no method is detached.
 *
 * @param value A candidate helper.
 * @returns Its `span` member, or `undefined`.
 */
function spanMemberOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as { readonly span?: unknown }).span;
}

/** The original `Reflect` operations, captured before any case spies on them. */
const originalReflect = {
  getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor.bind(Reflect),
  defineProperty: Reflect.defineProperty.bind(Reflect),
  deleteProperty: Reflect.deleteProperty.bind(Reflect),
  set: Reflect.set.bind(Reflect),
};

/**
 * @param target The object a `Reflect` call targets.
 * @param key The property it targets.
 * @returns Whether the call is about this module's global property.
 */
function isHelperSlot(target: object, key: PropertyKey): boolean {
  return target === globalThis && key === DEBUGGEN_GLOBAL_KEY;
}

beforeEach(() => {
  // Every case starts from a process with no helper: the precondition the
  // install assertions are written against.
  expect(originalReflect.getOwnPropertyDescriptor(globalThis, DEBUGGEN_GLOBAL_KEY)).toBeUndefined();
});

afterEach(async () => {
  vi.restoreAllMocks();
  uninstallSpanHelper();
  originalReflect.deleteProperty(globalThis, DEBUGGEN_GLOBAL_KEY);

  if (registered !== undefined) {
    await registered.shutdown();
  }
  registered = undefined;
  memory = undefined;

  trace.disable();
  propagation.disable();
  context.disable();
});

/*
 * ---------------------------------------------------------------------------
 * Guarantee 1 and 2: one invocation, the value unchanged
 * ---------------------------------------------------------------------------
 */

describe('span() on a synchronous callback', () => {
  it('returns the value by reference and ends one function span with async false', () => {
    registerRealProvider();
    const value = { rows: [1, 2, 3] };
    const fn = vi.fn(() => value);

    const result = span(SPAN_NAME, { ...PATCH_META }, fn);

    expect(result).toBe(value);
    expect(fn).toHaveBeenCalledTimes(1);
    const exported = onlyFinished();
    expect(exported.name).toBe(SPAN_NAME);
    expect(exported.ended).toBe(true);
    expect(exported.kind).toBe(SpanKind.INTERNAL);
    expect(exported.status.code).toBe(SpanStatusCode.UNSET);
    expect(exported.attributes[ASYNC_ATTRIBUTE]).toBe(false);
    expect(exported.attributes[FUNCTION_SPAN_MARKER_KEY]).toBe(FUNCTION_SPAN_MARKER_VALUE);
    expect(exported.attributes.symbol).toBe(PATCH_META.symbol);
    expect(exported.attributes.module).toBe(PATCH_META.module);
    expect(exported.attributes.actionId).toBe(PATCH_META.actionId);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['an empty string', ''],
    ['false', false],
    ['NaN', Number.NaN],
  ])('returns %s as-is and never re-invokes the body', (_label, falsy) => {
    registerRealProvider();
    const fn = vi.fn(() => falsy);

    const result = span(SPAN_NAME, {}, fn);

    expect(Object.is(result, falsy)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onlyFinished().attributes[ASYNC_ATTRIBUTE]).toBe(false);
  });

  it('returns a function value by reference without calling it', () => {
    registerRealProvider();
    const produced = vi.fn();

    const result = span(SPAN_NAME, {}, () => produced);

    expect(result).toBe(produced);
    expect(produced).not.toHaveBeenCalled();
  });

  it('uses the span kind a non-template caller passes and INTERNAL otherwise', () => {
    registerRealProvider();

    span('serverOperation', {}, () => 1, SpanKind.SERVER);
    span('internalOperation', {}, () => 2);

    expect(finishedNamed('serverOperation').kind).toBe(SpanKind.SERVER);
    expect(finishedNamed('internalOperation').kind).toBe(SpanKind.INTERNAL);
  });

  it('reports the instrumentation scope convert.ts classifies function spans by', () => {
    registerRealProvider();

    span(SPAN_NAME, {}, () => undefined);

    const scope = onlyFinished().instrumentationScope;
    expect(scope.name).toBe(TRACER_NAME);
    expect(scope.version).toBe(TRACER_VERSION);
  });

  it('ends the span exactly once on a plain return', () => {
    const provider = new ScriptedTracerProvider('counting');
    trace.setGlobalTracerProvider(provider);

    span(SPAN_NAME, {}, () => 'done');

    const started = provider.soleSpan();
    expect(started.endCalls).toBe(1);
    expect(started.attributes[ASYNC_ATTRIBUTE]).toBe(false);
    expect(started.statuses).toEqual([]);
  });
});

describe('span() on a synchronous throw', () => {
  it('rethrows the same error instance and records it as an error span, ended once', () => {
    registerRealProvider();
    const failure = new RangeError('quantity out of range');
    const fn = vi.fn((): never => {
      throw failure;
    });

    let caught: unknown;
    try {
      span(SPAN_NAME, {}, fn);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
    const exported = onlyFinished();
    expect(exported.ended).toBe(true);
    expect(exported.status.code).toBe(SpanStatusCode.ERROR);
    const exception = exported.events.find((event) => event.name === EXCEPTION_EVENT);
    expect(exception?.attributes?.[EXCEPTION_MESSAGE]).toBe(failure.message);
  });

  it('preserves the stack of the thrown error', () => {
    registerRealProvider();
    const failure = new Error('original failure');
    const stack = failure.stack;

    expect(() =>
      span(SPAN_NAME, {}, (): never => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(failure.stack).toBe(stack);
  });

  it('rethrows a non-Error value unchanged and records a value-free exception', () => {
    registerRealProvider();
    const thrown = { code: 'E_SAMPLE', detail: 'customer ada@example.test' };

    let caught: unknown;
    try {
      span(SPAN_NAME, {}, () => throwValue(thrown));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(thrown);
    const exported = onlyFinished();
    expect(exported.status.code).toBe(SpanStatusCode.ERROR);
    const message = exported.events.find((event) => event.name === EXCEPTION_EVENT)?.attributes?.[
      EXCEPTION_MESSAGE
    ];
    expect(typeof message).toBe('string');
    expect(JSON.stringify(exported.events)).not.toContain(thrown.detail);
  });

  it.each([
    ['a string', 'plain failure', 'plain failure'],
    ['a number', 42, '42'],
    ['an object with a message', { message: 'object failure' }, 'object failure'],
  ])('records %s thrown as its message', (_label, thrown, expected) => {
    registerRealProvider();

    expect(() => span(SPAN_NAME, {}, () => throwValue(thrown))).toThrow();

    const exception = onlyFinished().events.find((event) => event.name === EXCEPTION_EVENT);
    expect(exception?.attributes?.[EXCEPTION_MESSAGE]).toBe(expected);
  });

  it('survives a thrown object whose message getter throws', () => {
    registerRealProvider();
    const thrown = {
      get message(): string {
        throw new Error('message getter refused');
      },
    };

    let caught: unknown;
    try {
      span(SPAN_NAME, {}, () => throwValue(thrown));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(thrown);
    expect(onlyFinished().status.code).toBe(SpanStatusCode.ERROR);
  });

  it('calls end() exactly once when the callback throws', () => {
    const provider = new ScriptedTracerProvider('counting');
    trace.setGlobalTracerProvider(provider);
    const failure = new Error('fails once');

    expect(() =>
      span(SPAN_NAME, {}, (): never => {
        throw failure;
      }),
    ).toThrow(failure);

    const started = provider.soleSpan();
    expect(started.endCalls).toBe(1);
    expect(started.exceptions).toEqual([failure]);
    expect(started.statuses).toEqual([{ code: SpanStatusCode.ERROR }]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Guarantee 3: promises and thenables
 * ---------------------------------------------------------------------------
 */

describe('span() on a returned promise', () => {
  it('returns the same promise and ends the span only once it resolves', async () => {
    registerRealProvider();
    const pending = new Deferred<string>();
    const fn = vi.fn(() => pending.promise);

    const result = span(SPAN_NAME, {}, fn);

    expect(result).toBe(pending.promise);
    expect(fn).toHaveBeenCalledTimes(1);
    await macrotask();
    expect(finished()).toHaveLength(0);

    pending.resolve('settled');
    await expect(result).resolves.toBe('settled');
    await macrotask();

    const exported = onlyFinished();
    expect(exported.attributes[ASYNC_ATTRIBUTE]).toBe(true);
    expect(exported.status.code).toBe(SpanStatusCode.UNSET);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('marks the span as an error when the promise rejects and hands the caller the same reason', async () => {
    registerRealProvider();
    const pending = new Deferred<never>();
    const failure = new TypeError('stock lookup failed');

    const result = span(SPAN_NAME, {}, () => pending.promise);
    const callerCatch = vi.fn();
    const observed = result.catch(callerCatch);

    pending.reject(failure);
    await observed;
    await macrotask();

    expect(callerCatch).toHaveBeenCalledTimes(1);
    expect(callerCatch).toHaveBeenCalledWith(failure);
    const exported = onlyFinished();
    expect(exported.status.code).toBe(SpanStatusCode.ERROR);
    expect(exported.attributes[ASYNC_ATTRIBUTE]).toBe(true);
    const exception = exported.events.find((event) => event.name === EXCEPTION_EVENT);
    expect(exception?.attributes?.[EXCEPTION_MESSAGE]).toBe(failure.message);
  });

  it('keeps async function semantics: the awaited value and the rejection reach the caller', async () => {
    registerRealProvider();
    const failure = new Error('async failure');

    await expect(
      span('resolves', {}, async () => {
        await Promise.resolve();
        return 7;
      }),
    ).resolves.toBe(7);
    await expect(
      span('rejects', {}, async () => {
        await Promise.resolve();
        throw failure;
      }),
    ).rejects.toBe(failure);
    await macrotask();

    expect(finishedNamed('resolves').status.code).toBe(SpanStatusCode.UNSET);
    expect(finishedNamed('rejects').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('manufactures no unhandled rejection when the caller handles the rejection', async () => {
    registerRealProvider();
    const failure = new Error('handled by the caller');

    const unhandled = await unhandledRejectionsDuring(async () => {
      const result = span(SPAN_NAME, {}, () => Promise.reject(failure));
      await expect(result).rejects.toBe(failure);
    });

    expect(unhandled).toEqual([]);
    expect(onlyFinished().status.code).toBe(SpanStatusCode.ERROR);
  });

  it('calls end() exactly once when the promise settles', async () => {
    const provider = new ScriptedTracerProvider('counting');
    trace.setGlobalTracerProvider(provider);

    await span(SPAN_NAME, {}, () => Promise.resolve('value'));
    await macrotask();

    const started = provider.soleSpan();
    expect(started.endCalls).toBe(1);
    expect(started.attributes[ASYNC_ATTRIBUTE]).toBe(true);
  });
});

describe('span() on a userland thenable', () => {
  it('returns the same thenable and ends the span when it calls its fulfilment handler', () => {
    registerRealProvider();
    let fulfil: ((value: unknown) => unknown) | undefined;
    const { thenable, calls } = scriptedThenable(([onFulfilled]) => {
      fulfil = onFulfilled;
      return undefined;
    });

    const result = span(SPAN_NAME, {}, () => thenable);

    expect(result).toBe(thenable);
    expect(calls()).toBe(1);
    expect(finished()).toHaveLength(0);

    fulfil?.('value');

    const exported = onlyFinished();
    expect(exported.attributes[ASYNC_ATTRIBUTE]).toBe(true);
    expect(exported.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('ends exactly one span when the thenable calls both handlers', () => {
    const provider = new ScriptedTracerProvider('counting');
    trace.setGlobalTracerProvider(provider);
    const { thenable } = scriptedThenable(([onFulfilled, onRejected]) => {
      onFulfilled?.('first');
      onRejected?.(new Error('second'));
      onFulfilled?.('third');
      return undefined;
    });

    span(SPAN_NAME, {}, () => thenable);

    const started = provider.soleSpan();
    expect(started.endCalls).toBe(1);
    // The first handler to run decides the outcome.
    expect(started.statuses).toEqual([]);
    expect(started.exceptions).toEqual([]);
  });

  it('records the first outcome when a thenable rejects before it fulfils', () => {
    registerRealProvider();
    const failure = new Error('rejected first');
    const { thenable } = scriptedThenable(([onFulfilled, onRejected]) => {
      onRejected?.(failure);
      onFulfilled?.('late');
      return undefined;
    });

    span(SPAN_NAME, {}, () => thenable);

    const exported = onlyFinished();
    expect(exported.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('ends the span and still returns the value when then throws synchronously', () => {
    const provider = new ScriptedTracerProvider('counting');
    trace.setGlobalTracerProvider(provider);
    const { thenable, calls } = scriptedThenable(() => {
      throw new Error('then refused');
    });

    const result = span(SPAN_NAME, {}, () => thenable);

    expect(result).toBe(thenable);
    expect(calls()).toBe(1);
    const started = provider.soleSpan();
    expect(started.endCalls).toBe(1);
    expect(started.attributes[ASYNC_ATTRIBUTE]).toBe(true);
  });

  it('does not end the span twice when then calls a handler and then throws', () => {
    const provider = new ScriptedTracerProvider('counting');
    trace.setGlobalTracerProvider(provider);
    const { thenable } = scriptedThenable(([onFulfilled]) => {
      onFulfilled?.('value');
      throw new Error('then threw after settling');
    });

    span(SPAN_NAME, {}, () => thenable);

    expect(provider.soleSpan().endCalls).toBe(1);
  });

  it('treats a value whose then getter throws as a plain value', () => {
    registerRealProvider();
    const value = {
      get then(): unknown {
        throw new Error('then getter refused');
      },
    };

    const result = span(SPAN_NAME, {}, () => value);

    expect(result).toBe(value);
    expect(onlyFinished().attributes[ASYNC_ATTRIBUTE]).toBe(false);
  });

  it('observes a then that hands back a rejecting promise without an unhandled rejection', async () => {
    registerRealProvider();
    const { thenable } = scriptedThenable(([onFulfilled]) => {
      onFulfilled?.('value');
      return Promise.reject(new Error('derived rejection of the userland then'));
    });

    const unhandled = await unhandledRejectionsDuring(() => {
      span(SPAN_NAME, {}, () => thenable);
      return Promise.resolve();
    });

    expect(unhandled).toEqual([]);
    expect(onlyFinished().attributes[ASYNC_ATTRIBUTE]).toBe(true);
  });

  it('observes a then that hands back a rejecting foreign thenable without an unhandled rejection', async () => {
    registerRealProvider();
    const { thenable: derived } = scriptedThenable(([, onRejected]) => {
      onRejected?.(new Error('derived foreign rejection'));
      return undefined;
    });
    const { thenable } = scriptedThenable(([onFulfilled]) => {
      onFulfilled?.('value');
      return derived;
    });

    const unhandled = await unhandledRejectionsDuring(() => {
      span(SPAN_NAME, {}, () => thenable);
      return Promise.resolve();
    });

    expect(unhandled).toEqual([]);
    expect(finished()).toHaveLength(1);
  });

  it('observes a native promise whose then was replaced without an unhandled rejection', async () => {
    registerRealProvider();
    const settled = Promise.resolve('value');
    // The shape a promise-instrumentation library leaves behind: the intrinsic
    // `then` still runs, but the derived promise handed back rejects.
    function instrumentedThen(
      this: Promise<string>,
      onFulfilled?: (value: string) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ): Promise<never> {
      void Promise.prototype.then.call(this, onFulfilled, onRejected);
      return Promise.reject(new Error('instrumented then rejects its derived promise'));
    }
    expect(
      Reflect.defineProperty(settled, 'then', { configurable: true, value: instrumentedThen }),
    ).toBe(true);

    const unhandled = await unhandledRejectionsDuring(async () => {
      await span(SPAN_NAME, {}, () => settled);
    });

    expect(unhandled).toEqual([]);
    expect(finished()).toHaveLength(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Correlation: the helper span is the active context for what the body does
 * ---------------------------------------------------------------------------
 */

describe('span() nesting', () => {
  it('makes a span the callback starts a child of the helper span', () => {
    registerRealProvider();

    span('outer', {}, () => {
      trace.getTracer('sample-scope').startSpan('child').end();
    });

    const outer = finishedNamed('outer');
    const child = finishedNamed('child');
    expect(child.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(outer.spanContext().traceId);
  });

  it('nests a helper span under the span active at the call site', () => {
    registerRealProvider();

    trace.getTracer('sample-scope').startActiveSpan('request', (request) => {
      span(SPAN_NAME, {}, () => undefined);
      request.end();
    });

    const request = finishedNamed('request');
    const helper = finishedNamed(SPAN_NAME);
    expect(helper.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
  });

  it('parents a nested helper span on the outer one', () => {
    registerRealProvider();

    span('outer', {}, () => span('inner', {}, () => 1));

    const outer = finishedNamed('outer');
    const inner = finishedNamed('inner');
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
  });

  it('carries the helper span across an await inside the callback', async () => {
    registerRealProvider();

    await span('outer', {}, async () => {
      await macrotask();
      span('after-await', {}, () => undefined);
    });
    await macrotask();

    const outer = finishedNamed('outer');
    const later = finishedNamed('after-await');
    expect(later.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
  });

  it('restores the caller context once the callback returns', () => {
    registerRealProvider();
    const before = trace.getActiveSpan();

    span(SPAN_NAME, {}, () => {
      expect(trace.getActiveSpan()).toBeDefined();
    });

    expect(trace.getActiveSpan()).toBe(before);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Names and metadata (the telemetry privacy bounds in `docs/SECURITY.md`)
 * ---------------------------------------------------------------------------
 */

describe('span() name and metadata hygiene', () => {
  it.each([
    ['empty', ''],
    ['whitespace-only', '   \t '],
  ])('falls back to debuggen.function when the name is %s', (_label, name) => {
    registerRealProvider();

    span(name, {}, () => undefined);

    expect(onlyFinished().name).toBe(FALLBACK_SPAN_NAME);
  });

  it('names a span from an untyped non-string name debuggen.function', () => {
    registerRealProvider();

    span(42 as unknown as string, {}, () => undefined);

    expect(onlyFinished().name).toBe(FALLBACK_SPAN_NAME);
  });

  it('trims a name and truncates it to MAX_PREVIEW_LENGTH', () => {
    registerRealProvider();
    const long = 'n'.repeat(MAX_PREVIEW_LENGTH * 3);

    span('  padded  ', {}, () => undefined);
    span(long, {}, () => undefined);

    const names = finished().map((exported) => exported.name);
    expect(names).toEqual(['padded', truncate(long, MAX_PREVIEW_LENGTH)]);
  });

  it('copies only string, number and boolean values out of meta', () => {
    registerRealProvider();

    span(
      SPAN_NAME,
      {
        label: 'kept',
        count: 3,
        flag: true,
        callback: () => 'skipped',
        nested: { inner: 'skipped' },
        list: ['skipped'],
        marker: Symbol('skipped'),
        big: 10n,
        missing: undefined,
        empty: null,
      },
      () => undefined,
    );

    const { attributes } = onlyFinished();
    expect(attributes.label).toBe('kept');
    expect(attributes.count).toBe(3);
    expect(attributes.flag).toBe(true);
    for (const skipped of ['callback', 'nested', 'list', 'marker', 'big', 'missing', 'empty']) {
      expect(attributes).not.toHaveProperty(skipped);
    }
  });

  it('drops non-finite numbers', () => {
    registerRealProvider();

    span(
      SPAN_NAME,
      { nan: Number.NaN, up: Number.POSITIVE_INFINITY, down: Number.NEGATIVE_INFINITY, ok: 1.5 },
      () => undefined,
    );

    const { attributes } = onlyFinished();
    expect(attributes).not.toHaveProperty('nan');
    expect(attributes).not.toHaveProperty('up');
    expect(attributes).not.toHaveProperty('down');
    expect(attributes.ok).toBe(1.5);
  });

  it('never lets meta overwrite the marker or the async flag', () => {
    registerRealProvider();

    span(SPAN_NAME, { [FUNCTION_SPAN_MARKER_KEY]: 'http.server', async: true }, () => undefined);

    const { attributes } = onlyFinished();
    expect(attributes[FUNCTION_SPAN_MARKER_KEY]).toBe(FUNCTION_SPAN_MARKER_VALUE);
    expect(attributes[ASYNC_ATTRIBUTE]).toBe(false);
  });

  it('redacts values under credential-like names whatever their type', () => {
    registerRealProvider();

    span(
      SPAN_NAME,
      { apiKey: 'plain-value', password: 1234, authToken: true, sessionId: 'ses_kept' },
      () => undefined,
    );

    const { attributes } = onlyFinished();
    expect(attributes.apiKey).toBe(REDACTION_MARKER);
    expect(attributes.password).toBe(REDACTION_MARKER);
    expect(attributes.authToken).toBe(REDACTION_MARKER);
    expect(attributes.sessionId).toBe('ses_kept');
  });

  it('scrubs a credential by content before truncating a string value', () => {
    registerRealProvider();
    const long = 'v'.repeat(MAX_PREVIEW_LENGTH * 2);

    span(SPAN_NAME, { note: `Bearer ${BEARER_FRAGMENT}`, long }, () => undefined);

    const { attributes } = onlyFinished();
    expect(String(attributes.note)).not.toContain(BEARER_FRAGMENT);
    expect(attributes.long).toBe(truncate(long, MAX_PREVIEW_LENGTH));
  });

  it('truncates keys and skips an empty key', () => {
    registerRealProvider();
    const longKey = 'k'.repeat(MAX_PREVIEW_LENGTH * 2);

    span(SPAN_NAME, { [longKey]: 1, '': 2 }, () => undefined);

    const { attributes } = onlyFinished();
    expect(attributes[truncate(longKey, MAX_PREVIEW_LENGTH)]).toBe(1);
    expect(Object.keys(attributes)).not.toContain('');
  });

  it('copies at most MAX_TRACKED_KEYS entries, counting only the ones it kept', () => {
    registerRealProvider();
    const meta: Record<string, unknown> = {};
    for (let index = 0; index < 5; index += 1) {
      meta[`skipped${String(index)}`] = (): number => index;
    }
    for (let index = 0; index < MAX_TRACKED_KEYS * 2; index += 1) {
      meta[`field${String(index)}`] = index;
    }

    span(SPAN_NAME, meta, () => undefined);

    const copied = Object.keys(onlyFinished().attributes).filter((key) => key.startsWith('field'));
    expect(copied).toHaveLength(MAX_TRACKED_KEYS);
    expect(copied[0]).toBe('field0');
  });

  it('keeps what a hostile meta yielded before its getter threw, and still runs the body once', () => {
    registerRealProvider();
    const meta: Record<string, unknown> = { first: 'kept' };
    Object.defineProperty(meta, 'second', {
      enumerable: true,
      get(): never {
        throw new Error('meta getter refused');
      },
    });
    meta.third = 'unreached';
    const fn = vi.fn(() => 'value');

    expect(span(SPAN_NAME, meta, fn)).toBe('value');

    expect(fn).toHaveBeenCalledTimes(1);
    const { attributes } = onlyFinished();
    expect(attributes.first).toBe('kept');
    expect(attributes).not.toHaveProperty('third');
  });

  it('accepts a meta proxy whose ownKeys trap throws', () => {
    registerRealProvider();
    const meta = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys(): never {
          throw new Error('ownKeys refused');
        },
      },
    );
    const fn = vi.fn(() => 'value');

    expect(span(SPAN_NAME, meta, fn)).toBe('value');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onlyFinished().attributes[FUNCTION_SPAN_MARKER_KEY]).toBe(FUNCTION_SPAN_MARKER_VALUE);
  });

  it('accepts a non-object meta from an untyped caller', () => {
    registerRealProvider();

    span(SPAN_NAME, null as unknown as Record<string, unknown>, () => undefined);

    expect(Object.keys(onlyFinished().attributes).sort()).toEqual(
      [ASYNC_ATTRIBUTE, FUNCTION_SPAN_MARKER_KEY].sort(),
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * Guarantee 4: no failure of the instrumentation reaches the application
 * ---------------------------------------------------------------------------
 */

describe('span() when the instrumentation around it fails', () => {
  it('runs the body once and returns its value when no provider is registered', async () => {
    trace.disable();
    const fn = vi.fn(() => 'value');
    const pending = Promise.resolve('async value');

    expect(span(SPAN_NAME, {}, fn)).toBe('value');
    expect(span(SPAN_NAME, {}, () => pending)).toBe(pending);
    await expect(pending).resolves.toBe('async value');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs the body once, uninstrumented, when startSpan throws, and reports it once', () => {
    const logger = new RecordingLogger();
    installSpanHelper({ logger });
    trace.setGlobalTracerProvider(new ScriptedTracerProvider('throwing'));
    const fn = vi.fn(() => 'value');

    expect(span(SPAN_NAME, {}, fn)).toBe('value');
    expect(span(SPAN_NAME, {}, fn)).toBe('value');

    expect(fn).toHaveBeenCalledTimes(2);
    const reports = logger
      .at('debug')
      .filter((entry) => entry.message.includes('could not create a function span'));
    expect(reports).toHaveLength(1);
  });

  it('still rethrows the application error when startSpan throws', () => {
    trace.setGlobalTracerProvider(new ScriptedTracerProvider('throwing'));
    const failure = new Error('application failure');

    let caught: unknown;
    try {
      span(SPAN_NAME, {}, (): never => {
        throw failure;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
  });

  it('returns the value when every span mutator throws', async () => {
    const provider = new ScriptedTracerProvider('hostile');
    trace.setGlobalTracerProvider(provider);
    const pending = Promise.resolve('async value');
    const failure = new Error('application failure');

    expect(span('sync', {}, () => 'value')).toBe('value');
    expect(span('async', {}, () => pending)).toBe(pending);
    expect(() =>
      span('throws', {}, (): never => {
        throw failure;
      }),
    ).toThrow(failure);
    await pending;
    await macrotask();

    expect(provider.spans.map((started) => started.endCalls)).toEqual([1, 1, 1]);
  });

  it('ends the orphan span and runs the body once when the context API cannot hold it', () => {
    const provider = new ScriptedTracerProvider('counting');
    trace.setGlobalTracerProvider(provider);
    vi.spyOn(trace, 'setSpan').mockImplementation((): never => {
      throw new Error('context API refused the span');
    });
    const fn = vi.fn(() => 'value');

    expect(span(SPAN_NAME, {}, fn)).toBe('value');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(provider.soleSpan().endCalls).toBe(1);
  });

  it('runs the body once, uninstrumented, when the context manager throws before it runs', () => {
    const provider = new ScriptedTracerProvider('counting');
    trace.setGlobalTracerProvider(provider);
    vi.spyOn(context, 'with').mockImplementation((): never => {
      throw new Error('context manager refused');
    });
    const fn = vi.fn(() => 'value');

    expect(span(SPAN_NAME, {}, fn)).toBe('value');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(provider.soleSpan().endCalls).toBe(1);
  });

  it('returns the value, once, when the context manager fails after the body returned', () => {
    const provider = new ScriptedTracerProvider('counting');
    trace.setGlobalTracerProvider(provider);
    vi.spyOn(context, 'with').mockImplementation((_scope, callback): never => {
      (callback as () => unknown)();
      throw new Error('context restore failed');
    });
    const value = { produced: true };
    const fn = vi.fn(() => value);

    expect(span(SPAN_NAME, {}, fn)).toBe(value);

    expect(fn).toHaveBeenCalledTimes(1);
    const started = provider.soleSpan();
    expect(started.endCalls).toBe(1);
    expect(started.attributes[ASYNC_ATTRIBUTE]).toBe(false);
  });

  it('rethrows the application error when the context manager substitutes its own', () => {
    const provider = new ScriptedTracerProvider('counting');
    trace.setGlobalTracerProvider(provider);
    vi.spyOn(context, 'with').mockImplementation((_scope, callback): never => {
      try {
        (callback as () => unknown)();
      } catch {
        throw new Error('substituted by the context manager');
      }
      throw new Error('the callback was expected to throw');
    });
    const failure = new Error('application failure');
    const fn = vi.fn((): never => {
      throw failure;
    });

    let caught: unknown;
    try {
      span(SPAN_NAME, {}, fn);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
    const started = provider.soleSpan();
    expect(started.endCalls).toBe(1);
    expect(started.exceptions).toEqual([failure]);
  });

  it('never throws from a logger that throws', () => {
    const throwing: Logger = {
      level: 'trace',
      trace: () => {
        throw new Error('sink refused');
      },
      debug: () => {
        throw new Error('sink refused');
      },
      info: () => {
        throw new Error('sink refused');
      },
      warn: () => {
        throw new Error('sink refused');
      },
      error: () => {
        throw new Error('sink refused');
      },
      fatal: () => {
        throw new Error('sink refused');
      },
      child: () => throwing,
    };

    expect(() => {
      installSpanHelper({ logger: throwing });
    }).not.toThrow();
    trace.setGlobalTracerProvider(new ScriptedTracerProvider('throwing'));
    expect(span(SPAN_NAME, {}, () => 'value')).toBe('value');
    expect(() => {
      uninstallSpanHelper();
    }).not.toThrow();
  });
});

/*
 * ---------------------------------------------------------------------------
 * installSpanHelper / uninstallSpanHelper
 * ---------------------------------------------------------------------------
 */

describe('installSpanHelper()', () => {
  it('installs a helper whose span is the exported span, as the template expects', () => {
    installSpanHelper({ logger: new RecordingLogger() });

    const installed = readSlot();
    expect(typeof spanMemberOf(installed)).toBe('function');
    expect(spanMemberOf(installed)).toBe(span);
    const descriptor = originalReflect.getOwnPropertyDescriptor(globalThis, DEBUGGEN_GLOBAL_KEY);
    expect(descriptor).toMatchObject({ writable: true, enumerable: true, configurable: true });
  });

  it('routes a patched call through the installed helper exactly as the template does', () => {
    registerRealProvider();
    installSpanHelper({ logger: new RecordingLogger() });
    const original = vi.fn((left: number, right: number) => left + right);

    // The template's call site, verbatim in shape: availability, then one call.
    const patched = (left: number, right: number): number => {
      const dbg = (globalThis as { __DEBUGGEN__?: DebuggenSpanHelper }).__DEBUGGEN__;
      if (dbg && typeof dbg.span === 'function') {
        return dbg.span(SPAN_NAME, { ...PATCH_META }, () => original(left, right));
      }
      return original(left, right);
    };

    expect(patched(2, 3)).toBe(5);
    expect(original).toHaveBeenCalledTimes(1);
    expect(onlyFinished().name).toBe(SPAN_NAME);
  });

  it('is a no-op the second time: the same object stays installed', () => {
    const logger = new RecordingLogger();
    installSpanHelper({ logger });
    const first = readSlot();

    installSpanHelper({ logger });

    expect(readSlot()).toBe(first);
    expect(logger.at('debug').some((entry) => entry.message.includes('already installed'))).toBe(
      true,
    );
  });

  it('leaves a foreign helper with a callable span untouched, and uninstall keeps it', () => {
    const foreign: DebuggenSpanHelper = {
      span: <T>(_name: string, _meta: Record<string, unknown>, fn: () => T): T => fn(),
    };
    writeSlot(foreign);

    installSpanHelper({ logger: new RecordingLogger() });
    expect(readSlot()).toBe(foreign);

    uninstallSpanHelper();
    expect(readSlot()).toBe(foreign);
  });

  it("carries a foreign non-helper object's own members over", () => {
    const foreignState = { config: { mode: 'sample' }, flag: true, span: 'not callable' };
    writeSlot(foreignState);

    installSpanHelper({ logger: new RecordingLogger() });

    const installed = readSlot() as Record<string, unknown>;
    expect(installed).not.toBe(foreignState);
    expect(installed.config).toBe(foreignState.config);
    expect(installed.flag).toBe(true);
    expect(spanMemberOf(installed)).toBe(span);
  });

  it('installs over a configurable accessor whose getter throws', () => {
    Reflect.defineProperty(globalThis, DEBUGGEN_GLOBAL_KEY, {
      configurable: true,
      get(): never {
        throw new Error('getter refused');
      },
    });

    expect(() => {
      installSpanHelper({ logger: new RecordingLogger() });
    }).not.toThrow();

    expect(spanMemberOf(readSlot())).toBe(span);
  });

  it.each([
    [
      'a non-writable, non-configurable data property',
      { value: undefined, writable: false, enumerable: false, configurable: false },
    ],
    [
      'a non-configurable accessor with no setter',
      { get: (): undefined => undefined, enumerable: false, configurable: false },
    ],
  ])('refuses %s with one warn and throws nothing', (_label, reported: PropertyDescriptor) => {
    const logger = new RecordingLogger();
    vi.spyOn(Reflect, 'getOwnPropertyDescriptor').mockImplementation((target, key) =>
      isHelperSlot(target, key) ? reported : originalReflect.getOwnPropertyDescriptor(target, key),
    );
    const define = vi.spyOn(Reflect, 'defineProperty');

    expect(() => {
      installSpanHelper({ logger });
    }).not.toThrow();

    expect(define.mock.calls.some(([target, key]) => isHelperSlot(target, key))).toBe(false);
    expect(readSlot()).toBeUndefined();
    const warnings = logger.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('not writable');
    expect(warnings[0]?.fields).toEqual({ property: DEBUGGEN_GLOBAL_KEY });

    // Nothing was owned, so uninstall must not touch the property either.
    vi.restoreAllMocks();
    const remove = vi.spyOn(Reflect, 'deleteProperty');
    uninstallSpanHelper();
    expect(remove.mock.calls.some(([target, key]) => isHelperSlot(target, key))).toBe(false);
  });

  it('refuses a global whose descriptor cannot even be read, with one warn', () => {
    const logger = new RecordingLogger();
    vi.spyOn(Reflect, 'getOwnPropertyDescriptor').mockImplementation((target, key) => {
      if (isHelperSlot(target, key)) {
        throw new Error('descriptor read refused');
      }
      return originalReflect.getOwnPropertyDescriptor(target, key);
    });

    expect(() => {
      installSpanHelper({ logger });
    }).not.toThrow();

    expect(readSlot()).toBeUndefined();
    expect(logger.at('warn')).toHaveLength(1);
  });

  it('attempts a non-configurable accessor that has a setter, and installs through it', () => {
    const logger = new RecordingLogger();
    vi.spyOn(Reflect, 'getOwnPropertyDescriptor').mockImplementation((target, key) =>
      isHelperSlot(target, key)
        ? {
            get: (): undefined => undefined,
            set: (value: unknown): void => {
              void value;
            },
            enumerable: true,
            configurable: false,
          }
        : originalReflect.getOwnPropertyDescriptor(target, key),
    );

    installSpanHelper({ logger });

    expect(spanMemberOf(readSlot())).toBe(span);
    expect(logger.at('warn')).toEqual([]);
  });

  it('installs over a value whose span getter throws, treating it as a non-helper', () => {
    const foreignState: Record<string, unknown> = { flag: true };
    Object.defineProperty(foreignState, 'span', {
      enumerable: false,
      get(): never {
        throw new Error('span getter refused');
      },
    });
    writeSlot(foreignState);

    installSpanHelper({ logger: new RecordingLogger() });

    const installed = readSlot() as Record<string, unknown>;
    expect(spanMemberOf(installed)).toBe(span);
    expect(installed.flag).toBe(true);
  });

  it('refuses a global whose setter keeps something else, with one warn', () => {
    const logger = new RecordingLogger();
    const kept = { kept: 'by the setter' };
    Reflect.defineProperty(globalThis, DEBUGGEN_GLOBAL_KEY, {
      configurable: true,
      get: () => kept,
      set: (value: unknown) => {
        void value;
      },
    });
    vi.spyOn(Reflect, 'defineProperty').mockImplementation((target, key, attributes) =>
      isHelperSlot(target, key) ? false : originalReflect.defineProperty(target, key, attributes),
    );

    expect(() => {
      installSpanHelper({ logger });
    }).not.toThrow();

    expect(readSlot()).toBe(kept);
    const warnings = logger.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('could not be installed');
  });
});

describe('uninstallSpanHelper()', () => {
  it('removes the helper it installed', () => {
    const logger = new RecordingLogger();
    installSpanHelper({ logger });

    uninstallSpanHelper();

    expect(
      originalReflect.getOwnPropertyDescriptor(globalThis, DEBUGGEN_GLOBAL_KEY),
    ).toBeUndefined();
    expect(logger.at('debug').some((entry) => entry.message === 'span helper removed')).toBe(true);
  });

  it('is idempotent, and a no-op without a preceding install', () => {
    expect(() => {
      uninstallSpanHelper();
    }).not.toThrow();

    installSpanHelper({ logger: new RecordingLogger() });
    uninstallSpanHelper();
    uninstallSpanHelper();
    expect(readSlot()).toBeUndefined();

    const foreign = { unrelated: true };
    writeSlot(foreign);
    uninstallSpanHelper();
    expect(readSlot()).toBe(foreign);
  });

  it('leaves a global that was replaced after the install', () => {
    installSpanHelper({ logger: new RecordingLogger() });
    const replacement = { replaced: true };
    writeSlot(replacement);

    uninstallSpanHelper();

    expect(readSlot()).toBe(replacement);
  });

  it('allows a fresh install after an uninstall', () => {
    installSpanHelper({ logger: new RecordingLogger() });
    const first = readSlot();
    uninstallSpanHelper();

    installSpanHelper({ logger: new RecordingLogger() });

    expect(readSlot()).not.toBe(first);
    expect(spanMemberOf(readSlot())).toBe(span);
  });

  it('leaves an unreadable global in place with one warn', () => {
    const logger = new RecordingLogger();
    installSpanHelper({ logger });
    Reflect.defineProperty(globalThis, DEBUGGEN_GLOBAL_KEY, {
      configurable: true,
      get(): never {
        throw new Error('getter refused');
      },
    });

    expect(() => {
      uninstallSpanHelper();
    }).not.toThrow();

    const descriptor = originalReflect.getOwnPropertyDescriptor(globalThis, DEBUGGEN_GLOBAL_KEY);
    expect(typeof descriptor?.get).toBe('function');
    const warnings = logger.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('could not be read');
  });

  it('clears the slot through a verified write when the deletion is refused', () => {
    const logger = new RecordingLogger();
    installSpanHelper({ logger });
    vi.spyOn(Reflect, 'deleteProperty').mockImplementation((target, key) =>
      isHelperSlot(target, key) ? false : originalReflect.deleteProperty(target, key),
    );

    uninstallSpanHelper();

    expect(readSlot()).toBeUndefined();
    expect(logger.at('warn')).toEqual([]);
    expect(logger.at('debug').some((entry) => entry.message === 'span helper removed')).toBe(true);
  });

  it('reports a helper it could neither delete nor overwrite with one warn', () => {
    const logger = new RecordingLogger();
    installSpanHelper({ logger });
    const installed = readSlot();
    vi.spyOn(Reflect, 'deleteProperty').mockImplementation((target, key) =>
      isHelperSlot(target, key) ? false : originalReflect.deleteProperty(target, key),
    );
    vi.spyOn(Reflect, 'defineProperty').mockImplementation((target, key, attributes) =>
      isHelperSlot(target, key) ? false : originalReflect.defineProperty(target, key, attributes),
    );
    vi.spyOn(Reflect, 'set').mockImplementation((target, key, value, receiver) =>
      isHelperSlot(target, key) ? false : originalReflect.set(target, key, value, receiver),
    );

    expect(() => {
      uninstallSpanHelper();
    }).not.toThrow();

    expect(readSlot()).toBe(installed);
    const warnings = logger.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('could not be removed');
  });
});
