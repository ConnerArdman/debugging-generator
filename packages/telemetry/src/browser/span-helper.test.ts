// @vitest-environment happy-dom
/**
 * Colocated tests for `./span-helper.ts` — `globalThis.__DEBUGGEN__` in the
 * page, the browser twin of `../node/span-helper.ts` and the runtime half of
 * the reversible AST patch contract on the front end (AAP §0.5.1).
 *
 * ## What is on trial
 *
 * A patched function's body becomes `return __dbg.span(name, meta, () =>
 * __orig.apply(this, arguments))`, so the helper's behaviour *is* the
 * application's behaviour. The module's four guarantees are the assertions:
 *
 * 1. **`fn` runs exactly once on every path** — dormant, armed, degraded
 *    (stack exhausted, id generator failing) and every error path. Counted with
 *    a spy on every case rather than inferred from the value.
 * 2. **The value comes back by reference, unchanged** — primitives, falsy
 *    values, objects, promises and thenables alike, asserted with `toBe`.
 * 3. **A returned promise ends the span when it settles**, the caller receives
 *    the same promise and its own `catch` runs, a thenable that calls both
 *    handlers produces one event, and a synchronous throw rethrows the same
 *    instance. The error's `name` is reported and its message never is
 *    (AAP §0.5.2). Vitest fails a run on an unhandled rejection, so every
 *    rejection case that lets the caller handle the rejection doubles as the
 *    "no manufactured rejection" check; each such case waits a macrotask so a
 *    stray rejection would surface inside it.
 * 4. **Nothing the instrumentation does can throw into the page.** A hostile
 *    `meta`, a failing id generator and a throwing transport all degrade to
 *    lost telemetry, never to an exception.
 *
 * Beyond those, the suite pins the two properties no downstream consumer can
 * observe for itself: the explicit nesting stack (a child names its parent, two
 * concurrent async spans never adopt each other's frames) and the capture
 * generation gate (a span opened in one capture never reports into another).
 *
 * ## Harness
 *
 * Emissions are observed by spying on `./transport.ts`'s `emit`, the single
 * entry point this module hands a draft to, exactly as `./errors.test.ts`
 * does; the transport is still configured with a capture so the module runs
 * against production-shaped state. `span` is module-private and is reached the
 * way patched code reaches it — through the helper `installSpanHelper()`
 * returns. Every case ends with the helper uninstalled, the stack reset and
 * the global property removed.
 *
 * Nothing here imports a Node built-in: `eslint.config.js` forbids one anywhere
 * under `src/browser/**`, tests included, because this directory is bundled
 * into the page-injected agent (AAP §0.2.2). Symbols and paths are neutral
 * vocabulary that names no particular project (AAP §0.5.4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RESOLUTION_CONFIDENCE, isSourceLocation } from '@debuggen/shared';

import { REDACTION_MARKER, truncate } from '../redaction/rules.js';
import { MAX_PREVIEW_LENGTH, MAX_TRACKED_KEYS } from '../schema/attributes.js';
import { isTelemetryEventIngress } from '../schema/event.js';
import {
  registerPendingContinuation,
  resetContinuations,
  settleContinuation,
} from './continuation.js';
import * as ids from './ids.js';
import {
  getSpanHelper,
  installSpanHelper,
  MAX_SPAN_NAME_LENGTH,
  MAX_SPAN_STACK_DEPTH,
  resetSpanStack,
  setSpanHelperConfig,
  setSpanHelperEnabled,
  SPAN_HELPER_VERSION,
  uninstallSpanHelper,
} from './span-helper.js';
import type { BrowserSpanHelper } from './span-helper.js';
import * as transport from './transport.js';
import type { EventDraft } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------
 */

/** The capture every armed case runs in. */
const CAPTURE_ID = 'cap_span_helper_test';

/** A second capture, for the generation-gate cases. */
const OTHER_CAPTURE_ID = 'cap_span_helper_other';

/** The session the transport is configured with. */
const SESSION_ID = 'ses_span_helper_test';

/** The property this module installs on `globalThis`. */
const GLOBAL_KEY = '__DEBUGGEN__';

/** The span name every case that does not vary it uses. */
const SPAN_NAME = 'sampleOperation';

/** Span name used when the caller supplied nothing usable. */
const FALLBACK_SPAN_NAME = 'debuggen.function';

/** W3C trace-context id shapes, restated so a producer change is caught. */
const TRACE_ID_SHAPE = /^[0-9a-f]{32}$/;
const SPAN_ID_SHAPE = /^[0-9a-f]{16}$/;

/** A project-relative location, as the patcher records one. */
const PATCH_LOCATION = Object.freeze({
  file: 'src/server/services/sample.service.ts',
  line: 42,
  column: 3,
  symbol: 'sampleOperation',
});

/*
 * ---------------------------------------------------------------------------
 * Recording and helpers
 * ---------------------------------------------------------------------------
 */

/** Every draft emitted during the current case, in emission order. */
const captured: EventDraft[] = [];

/** Replace `emit` with a synchronous recorder for the current case. */
function startRecording(): void {
  vi.spyOn(transport, 'emit').mockImplementation((draft) => {
    captured.push(draft);
  });
}

/** @returns The only draft emitted; fails the case otherwise. */
function onlyDraft(): EventDraft {
  expect(captured).toHaveLength(1);
  const [first] = captured;
  if (first === undefined) {
    throw new Error('no draft was emitted');
  }
  return first;
}

/**
 * @param name A span name.
 * @returns The draft of that name; fails the case otherwise.
 */
function draftNamed(name: string): EventDraft {
  const found = captured.find((draft) => draft.name === name);
  if (found === undefined) {
    throw new Error(`no draft is named ${name}`);
  }
  return found;
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
 * A userland thenable whose `then` is scripted by the case.
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

/**
 * Throw a value exactly as given, whatever its type: patched code may throw
 * anything, and the helper must rethrow it unchanged.
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

/** @returns Whatever occupies `globalThis.__DEBUGGEN__`. */
function readSlot(): unknown {
  return Reflect.get(globalThis, GLOBAL_KEY);
}

/**
 * Put a value on the global the way a foreign actor would.
 *
 * @param value The value to park.
 */
function writeSlot(value: unknown): void {
  Reflect.defineProperty(globalThis, GLOBAL_KEY, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Read a member as data, so no method reference is detached from its object.
 *
 * @param value The object to read.
 * @param key The member.
 * @returns The member's value.
 */
function memberOf(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

/** Install the helper and arm it for {@link CAPTURE_ID}. */
function armedHelper(): BrowserSpanHelper {
  const helper = installSpanHelper();
  setSpanHelperEnabled(true, CAPTURE_ID);
  return helper;
}

beforeEach(() => {
  captured.length = 0;
  transport.resetTransport();
  transport.configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_ID, enabled: true });
  startRecording();
  // Every case starts from a page with no helper.
  expect(Reflect.getOwnPropertyDescriptor(globalThis, GLOBAL_KEY)).toBeUndefined();
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallSpanHelper();
  resetSpanStack();
  resetContinuations();
  Reflect.deleteProperty(globalThis, GLOBAL_KEY);
  transport.resetTransport();
  captured.length = 0;
});

/*
 * ---------------------------------------------------------------------------
 * Dormant: exactly `return fn()`
 * ---------------------------------------------------------------------------
 */

describe('span() while dormant', () => {
  it('runs the body once, returns its value and emits nothing before any capture arms it', () => {
    const helper = installSpanHelper();
    const value = { rows: 1 };
    const fn = vi.fn(() => value);

    expect(helper.span(SPAN_NAME, {}, fn)).toBe(value);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(captured).toEqual([]);
  });

  it('returns to dormant when the capture is disarmed', () => {
    const helper = armedHelper();
    setSpanHelperEnabled(false);
    const fn = vi.fn(() => 'value');

    expect(helper.span(SPAN_NAME, {}, fn)).toBe('value');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(captured).toEqual([]);
  });

  it('treats a truthy non-boolean enabled flag as disarmed', () => {
    const helper = installSpanHelper();
    setSpanHelperEnabled('true' as unknown as boolean, CAPTURE_ID);

    helper.span(SPAN_NAME, {}, () => undefined);

    expect(captured).toEqual([]);
  });

  it('rethrows the same error without emitting', () => {
    const helper = installSpanHelper();
    const failure = new Error('dormant failure');

    expect(() =>
      helper.span(SPAN_NAME, {}, (): never => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(captured).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Armed: one `function` event per call
 * ---------------------------------------------------------------------------
 */

describe('span() on a synchronous callback while armed', () => {
  it('emits one function draft with an ok status, async false and well-formed ids', () => {
    const helper = armedHelper();
    const fn = vi.fn(() => 'value');

    expect(helper.span(SPAN_NAME, { symbol: SPAN_NAME, module: 'src/sample.ts' }, fn)).toBe(
      'value',
    );

    expect(fn).toHaveBeenCalledTimes(1);
    const draft = onlyDraft();
    expect(draft.kind).toBe('function');
    expect(draft.name).toBe(SPAN_NAME);
    expect(draft.status).toBe('ok');
    expect(draft.attributes.async).toBe(false);
    expect(draft.attributes.symbol).toBe(SPAN_NAME);
    expect(draft.attributes.module).toBe('src/sample.ts');
    expect(draft).not.toHaveProperty('parentSpanId');
    expect(draft.traceId).toMatch(TRACE_ID_SHAPE);
    expect(draft.spanId).toMatch(SPAN_ID_SHAPE);
    expect(draft.duration).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(draft.startTime)).toBe(true);
  });

  it('emits a draft the ingress schema accepts once the transport stamps it', () => {
    const helper = armedHelper();

    helper.span(SPAN_NAME, { ...PATCH_LOCATION, actionId: 'act_sample' }, () => undefined);

    const draft = onlyDraft();
    expect(
      isTelemetryEventIngress({
        ...draft,
        id: ids.newEventId(),
        producerId: ids.newProducerId(),
        seq: 0,
        tier: 'browser',
      }),
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['an empty string', ''],
    ['false', false],
  ])('returns %s as-is and never re-invokes the body', (_label, falsy) => {
    const helper = armedHelper();
    const fn = vi.fn(() => falsy);

    expect(Object.is(helper.span(SPAN_NAME, {}, fn), falsy)).toBe(true);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onlyDraft().status).toBe('ok');
  });

  it('returns an object and a function value by reference', () => {
    const helper = armedHelper();
    const value = { nested: { deep: true } };
    const produced = vi.fn();

    expect(helper.span('object', {}, () => value)).toBe(value);
    expect(helper.span('function', {}, () => produced)).toBe(produced);

    expect(produced).not.toHaveBeenCalled();
    expect(captured).toHaveLength(2);
  });

  it('truncates a long name to MAX_SPAN_NAME_LENGTH and trims padding', () => {
    const helper = armedHelper();
    const long = 'n'.repeat(MAX_SPAN_NAME_LENGTH * 2);

    helper.span(long, {}, () => undefined);
    helper.span('  padded  ', {}, () => undefined);

    expect(captured.map((draft) => draft.name)).toEqual([
      truncate(long, MAX_SPAN_NAME_LENGTH),
      'padded',
    ]);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', ' \t '],
    ['not a string', 7 as unknown as string],
  ])('falls back to debuggen.function when the name is %s', (_label, name) => {
    const helper = armedHelper();

    helper.span(name, {}, () => undefined);

    expect(onlyDraft().name).toBe(FALLBACK_SPAN_NAME);
  });
});

describe('span() on a synchronous throw while armed', () => {
  it('rethrows the same instance and reports only the error name', () => {
    const helper = armedHelper();
    const failure = new TypeError('customer ada@example.test could not be charged');
    const fn = vi.fn((): never => {
      throw failure;
    });

    let caught: unknown;
    try {
      helper.span(SPAN_NAME, {}, fn);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
    const draft = onlyDraft();
    expect(draft.status).toBe('error');
    expect(draft.attributes.async).toBe(false);
    expect(draft.attributes['error.type']).toBe('TypeError');
    expect(JSON.stringify(draft)).not.toContain(failure.message);
  });

  it('reports no error type for a thrown value that is not an object with a name', () => {
    const helper = armedHelper();

    expect(() => helper.span('string', {}, () => throwValue('plain failure'))).toThrow();
    expect(() => helper.span('record', {}, () => throwValue({ code: 'E_SAMPLE' }))).toThrow();
    const blankName = new Error('blank');
    blankName.name = '   ';
    expect(() => helper.span('blank', {}, () => throwValue(blankName))).toThrow(blankName);

    for (const draft of captured) {
      expect(draft.status).toBe('error');
      expect(draft.attributes).not.toHaveProperty(['error.type']);
    }
    expect(captured).toHaveLength(3);
  });

  it('truncates a long error name and survives a throwing name getter', () => {
    const helper = armedHelper();
    const longName = new Error('long');
    longName.name = 'E'.repeat(MAX_PREVIEW_LENGTH * 2);
    const hostileName = {
      get name(): string {
        throw new Error('name getter refused');
      },
    };

    expect(() => helper.span('long', {}, () => throwValue(longName))).toThrow(longName);
    let caught: unknown;
    try {
      helper.span('hostile', {}, () => throwValue(hostileName));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(hostileName);
    expect(draftNamed('long').attributes['error.type']).toBe(
      truncate(longName.name, MAX_PREVIEW_LENGTH),
    );
    expect(draftNamed('hostile').attributes).not.toHaveProperty(['error.type']);
  });
});

describe('span() on a returned promise while armed', () => {
  it('returns the same promise and emits only when it resolves, with async true', async () => {
    const helper = armedHelper();
    const pending = new Deferred<string>();
    const fn = vi.fn(() => pending.promise);

    const result = helper.span(SPAN_NAME, {}, fn);

    expect(result).toBe(pending.promise);
    await macrotask();
    expect(captured).toEqual([]);

    pending.resolve('settled');
    await expect(result).resolves.toBe('settled');
    await macrotask();

    const draft = onlyDraft();
    expect(draft.status).toBe('ok');
    expect(draft.attributes.async).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("emits an error draft on rejection while the caller's own catch receives the same reason", async () => {
    const helper = armedHelper();
    const pending = new Deferred<never>();
    const failure = new RangeError('quantity 9001 exceeds stock');

    const result = helper.span(SPAN_NAME, {}, () => pending.promise);
    const callerCatch = vi.fn();
    const observed = result.catch(callerCatch);
    pending.reject(failure);
    await observed;
    await macrotask();

    expect(callerCatch).toHaveBeenCalledTimes(1);
    expect(callerCatch).toHaveBeenCalledWith(failure);
    const draft = onlyDraft();
    expect(draft.status).toBe('error');
    expect(draft.attributes.async).toBe(true);
    expect(draft.attributes['error.type']).toBe('RangeError');
    expect(JSON.stringify(draft)).not.toContain(failure.message);
  });

  it('keeps async function semantics for resolve and reject', async () => {
    const helper = armedHelper();
    const failure = new Error('async failure');

    await expect(
      helper.span('resolves', {}, async () => {
        await Promise.resolve();
        return 7;
      }),
    ).resolves.toBe(7);
    await expect(
      helper.span('rejects', {}, async () => {
        await Promise.resolve();
        throw failure;
      }),
    ).rejects.toBe(failure);
    await macrotask();

    expect(draftNamed('resolves').status).toBe('ok');
    expect(draftNamed('rejects').status).toBe('error');
  });

  it('observes a native promise whose then was replaced without an unhandled rejection', async () => {
    const helper = armedHelper();
    const settled = Promise.resolve('value');
    // A promise-instrumentation library's shape: the intrinsic `then` still
    // runs, but the derived promise it hands back rejects.
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

    await helper.span(SPAN_NAME, {}, () => settled);
    await macrotask();
    await macrotask();

    expect(onlyDraft().status).toBe('ok');
  });

  it('terminates the side branch of a promise subclass and hands back the same instance', async () => {
    const helper = armedHelper();
    class SubclassedPromise<T> extends Promise<T> {}
    const settled = SubclassedPromise.resolve('value');

    const result = helper.span(SPAN_NAME, {}, () => settled);

    expect(result).toBe(settled);
    await expect(result).resolves.toBe('value');
    await macrotask();
    expect(Reflect.getOwnPropertyDescriptor(settled, 'constructor')).toBeUndefined();
    expect(onlyDraft().status).toBe('ok');
  });
});

describe('span() on a userland thenable while armed', () => {
  it('returns the same thenable and emits exactly one draft when both handlers are called', () => {
    const helper = armedHelper();
    const { thenable, calls } = scriptedThenable(([onFulfilled, onRejected]) => {
      onFulfilled?.('first');
      onRejected?.(new Error('second'));
      onFulfilled?.('third');
      return undefined;
    });

    expect(helper.span(SPAN_NAME, {}, () => thenable)).toBe(thenable);

    expect(calls()).toBe(1);
    const draft = onlyDraft();
    expect(draft.status).toBe('ok');
    expect(draft.attributes.async).toBe(true);
  });

  it('records the first outcome when a thenable rejects before it fulfils', () => {
    const helper = armedHelper();
    const { thenable } = scriptedThenable(([onFulfilled, onRejected]) => {
      onRejected?.(new SyntaxError('rejected first'));
      onFulfilled?.('late');
      return undefined;
    });

    helper.span(SPAN_NAME, {}, () => thenable);

    const draft = onlyDraft();
    expect(draft.status).toBe('error');
    expect(draft.attributes['error.type']).toBe('SyntaxError');
  });

  it('closes the span with an unset status when then throws synchronously', () => {
    const helper = armedHelper();
    const { thenable } = scriptedThenable(() => {
      throw new Error('then refused');
    });

    expect(helper.span(SPAN_NAME, {}, () => thenable)).toBe(thenable);

    const draft = onlyDraft();
    expect(draft.status).toBe('unset');
    expect(draft.attributes.async).toBe(true);
  });

  it('keeps the first outcome when then calls a handler and then throws', () => {
    const helper = armedHelper();
    const { thenable } = scriptedThenable(([onFulfilled]) => {
      onFulfilled?.('value');
      throw new Error('then threw after settling');
    });

    helper.span(SPAN_NAME, {}, () => thenable);

    expect(onlyDraft().status).toBe('ok');
  });

  it('treats a value whose then getter throws as a plain value', () => {
    const helper = armedHelper();
    const value = {
      get then(): unknown {
        throw new Error('then getter refused');
      },
    };

    expect(helper.span(SPAN_NAME, {}, () => value)).toBe(value);

    const draft = onlyDraft();
    expect(draft.status).toBe('ok');
    expect(draft.attributes.async).toBe(false);
  });

  it('terminates a then that hands back a rejecting promise without an unhandled rejection', async () => {
    const helper = armedHelper();
    const { thenable } = scriptedThenable(([onFulfilled]) => {
      onFulfilled?.('value');
      return Promise.reject(new Error('derived rejection of the userland then'));
    });

    helper.span(SPAN_NAME, {}, () => thenable);
    await macrotask();
    await macrotask();

    expect(onlyDraft().status).toBe('ok');
  });

  it('terminates a then that hands back a thenable whose own then throws', async () => {
    const helper = armedHelper();
    const { thenable: derived, calls: derivedCalls } = scriptedThenable(() => {
      throw new Error('derived then refused');
    });
    const { thenable } = scriptedThenable(([onFulfilled]) => {
      onFulfilled?.('value');
      return derived;
    });

    expect(helper.span(SPAN_NAME, {}, () => thenable)).toBe(thenable);
    await macrotask();

    expect(derivedCalls()).toBe(1);
    expect(onlyDraft().status).toBe('ok');
  });

  it('stops following foreign thenables that each hand back a new one', async () => {
    const helper = armedHelper();
    let chained = 0;
    const endless = (): PromiseLike<unknown> =>
      scriptedThenable(([, onRejected]) => {
        chained += 1;
        onRejected?.(new Error('foreign rejection'));
        return endless();
      }).thenable;
    const { thenable } = scriptedThenable(([onFulfilled]) => {
      onFulfilled?.('value');
      return endless();
    });

    helper.span(SPAN_NAME, {}, () => thenable);
    await macrotask();

    expect(onlyDraft().status).toBe('ok');
    // Bounded: a loop whose exit the page controls is never followed to its end.
    expect(chained).toBeGreaterThan(0);
    expect(chained).toBeLessThan(10);
  });

  it('terminates a native rejecting promise the last foreign then in a chain produced', async () => {
    const helper = armedHelper();
    let chained = 0;
    const chain = (): PromiseLike<unknown> =>
      scriptedThenable(() => {
        chained += 1;
        return chained < 3 ? chain() : Promise.reject(new Error('native promise at the end'));
      }).thenable;
    const { thenable } = scriptedThenable(([onFulfilled]) => {
      onFulfilled?.('value');
      return chain();
    });

    helper.span(SPAN_NAME, {}, () => thenable);
    await macrotask();
    await macrotask();

    expect(chained).toBe(3);
    expect(onlyDraft().status).toBe('ok');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The nesting stack
 * ---------------------------------------------------------------------------
 */

describe('span() nesting', () => {
  it("parents an inner span on the outer one, in the outer span's trace", () => {
    const helper = armedHelper();

    helper.span('outer', {}, () => helper.span('inner', {}, () => 1));

    const outer = draftNamed('outer');
    const inner = draftNamed('inner');
    expect(inner.parentSpanId).toBe(outer.spanId);
    expect(inner.traceId).toBe(outer.traceId);
    expect(captured.map((draft) => draft.name)).toEqual(['inner', 'outer']);
  });

  it("never lets two concurrent async spans adopt each other's frames", async () => {
    const helper = armedHelper();
    const first = new Deferred<string>();
    const second = new Deferred<string>();

    const a = helper.span('first', {}, () => first.promise);
    const b = helper.span('second', {}, () => second.promise);
    second.resolve('b');
    first.resolve('a');
    await Promise.all([a, b]);
    await macrotask();

    const firstDraft = draftNamed('first');
    const secondDraft = draftNamed('second');
    expect(secondDraft.parentSpanId).not.toBe(firstDraft.spanId);
    expect(firstDraft.parentSpanId).not.toBe(secondDraft.spanId);
    expect(secondDraft).not.toHaveProperty('parentSpanId');
  });

  it('does not carry the stack across an await inside the body', async () => {
    const helper = armedHelper();

    await helper.span('outer', {}, async () => {
      await Promise.resolve();
      return helper.span('after-await', {}, () => 1);
    });
    await macrotask();

    expect(draftNamed('after-await').parentSpanId).not.toBe(draftNamed('outer').spanId);
  });

  it('pops its frame when the body throws, so the next span is a root again', () => {
    const helper = armedHelper();

    expect(() =>
      helper.span('outer', {}, () =>
        helper.span('inner', {}, (): never => {
          throw new Error('inner failure');
        }),
      ),
    ).toThrow('inner failure');
    helper.span('next', {}, () => undefined);

    expect(draftNamed('inner').parentSpanId).toBe(draftNamed('outer').spanId);
    expect(draftNamed('next')).not.toHaveProperty('parentSpanId');
  });

  it('degrades to a pass-through beyond MAX_SPAN_STACK_DEPTH, still running every body once', () => {
    const helper = armedHelper();
    const invocations = vi.fn();
    const nest = (remaining: number): number => {
      invocations();
      if (remaining === 0) {
        return 0;
      }
      return helper.span('nested', {}, () => nest(remaining - 1)) + 1;
    };
    const total = MAX_SPAN_STACK_DEPTH + 8;

    expect(nest(total)).toBe(total);

    expect(invocations).toHaveBeenCalledTimes(total + 1);
    expect(captured).toHaveLength(MAX_SPAN_STACK_DEPTH);

    // The stack unwound completely: the next span is a root again.
    helper.span('after', {}, () => undefined);
    expect(draftNamed('after')).not.toHaveProperty('parentSpanId');
  });

  it('joins an open continuation window as a root, keeping lineage meta cannot overwrite', () => {
    const helper = armedHelper();
    const requestTraceId = ids.newTraceId();
    const requestSpanId = ids.newSpanId();
    registerPendingContinuation({ traceId: requestTraceId, spanId: requestSpanId });
    settleContinuation(requestSpanId);

    helper.span(SPAN_NAME, { lineage: 'forged' }, () => undefined);

    const draft = onlyDraft();
    expect(draft.traceId).toBe(requestTraceId);
    expect(draft.parentSpanId).toBe(requestSpanId);
    expect(typeof draft.attributes.lineage).toBe('string');
    expect(draft.attributes.lineage).not.toBe('forged');
  });

  it('starts from a fresh root after resetSpanStack() or a new arm', () => {
    const helper = armedHelper();

    helper.span('outer', {}, () => {
      resetSpanStack();
      helper.span('after-reset', {}, () => undefined);
      setSpanHelperEnabled(true, CAPTURE_ID);
      helper.span('after-rearm', {}, () => undefined);
    });

    expect(draftNamed('after-reset')).not.toHaveProperty('parentSpanId');
    expect(draftNamed('after-rearm')).not.toHaveProperty('parentSpanId');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The patch-recorded source location
 * ---------------------------------------------------------------------------
 */

describe('span() source location from meta', () => {
  it('reports a patch-resolved location and does not duplicate it into the attributes', () => {
    const helper = armedHelper();

    helper.span(SPAN_NAME, { ...PATCH_LOCATION }, () => undefined);

    const draft = onlyDraft();
    expect(draft.source).toEqual({
      file: PATCH_LOCATION.file,
      line: PATCH_LOCATION.line,
      column: PATCH_LOCATION.column,
      symbol: PATCH_LOCATION.symbol,
      resolvedBy: 'patch',
      confidence: DEFAULT_RESOLUTION_CONFIDENCE.patch,
    });
    expect(isSourceLocation(draft.source)).toBe(true);
    expect(draft.attributes).not.toHaveProperty('file');
    expect(draft.attributes).not.toHaveProperty('line');
    expect(draft.attributes).not.toHaveProperty('column');
    expect(draft.attributes.symbol).toBe(PATCH_LOCATION.symbol);
  });

  it('omits an empty symbol from the location and accepts an interior .. that resolves inside', () => {
    const helper = armedHelper();

    helper.span(
      SPAN_NAME,
      { file: 'src/lib/../server/sample.ts', line: 1, column: 1, symbol: '  ' },
      () => undefined,
    );

    const source = onlyDraft().source;
    expect(source?.file).toBe('src/lib/../server/sample.ts');
    expect(source).not.toHaveProperty('symbol');
    expect(isSourceLocation(source)).toBe(true);
  });

  it.each([
    ['a leading ./ segment', './src/server/sample.ts'],
    ['a doubled separator', 'src//server/sample.ts'],
  ])('accepts a path with %s, reporting it exactly as recorded', (_label, file) => {
    const helper = armedHelper();

    helper.span(SPAN_NAME, { ...PATCH_LOCATION, file }, () => undefined);

    const source = onlyDraft().source;
    expect(source?.file).toBe(file);
    expect(isSourceLocation(source)).toBe(true);
  });

  it.each([
    ['an absolute path', { file: '/srv/project/src/sample.ts' }],
    ['a UNC path', { file: '//server/share/sample.ts' }],
    ['a leading parent segment', { file: '../outside/sample.ts' }],
    ['an escaping interior parent segment', { file: 'src/../../outside.ts' }],
    ['a backslash', { file: 'src\\server\\sample.ts' }],
    ['a drive prefix', { file: 'C:/project/sample.ts' }],
    ['a drive-relative path', { file: 'C:sample.ts' }],
    ['a NUL character', { file: 'src/sample\u0000.ts' }],
    ['an escape character', { file: 'src/\u001bsample.ts' }],
    ['a C1 control character', { file: 'src/sample\u0085.ts' }],
    ['the project root itself', { file: 'src/..' }],
    ['a whitespace-only path', { file: '   ' }],
    ['an over-long path', { file: `src/${'a'.repeat(600)}.ts` }],
    ['a non-string file', { file: 42 }],
    ['a non-integer line', { line: 1.5 }],
    ['a zero line', { line: 0 }],
    ['a string line', { line: '42' }],
    ['a negative column', { column: -1 }],
    ['a missing column', { column: undefined }],
  ])('omits the location for %s but keeps the span', (_label, override) => {
    const helper = armedHelper();

    helper.span(SPAN_NAME, { ...PATCH_LOCATION, ...override }, () => undefined);

    const draft = onlyDraft();
    expect(draft).not.toHaveProperty('source');
    expect(draft.status).toBe('ok');
  });

  it('keeps a rejected location visible in the attributes', () => {
    const helper = armedHelper();

    helper.span(SPAN_NAME, { ...PATCH_LOCATION, line: 2.5 }, () => undefined);

    const draft = onlyDraft();
    expect(draft).not.toHaveProperty('source');
    expect(draft.attributes.file).toBe(PATCH_LOCATION.file);
    expect(draft.attributes.line).toBe(2.5);
    expect(draft.attributes.column).toBe(PATCH_LOCATION.column);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Metadata hygiene (AAP §0.5.2)
 * ---------------------------------------------------------------------------
 */

describe('span() metadata hygiene', () => {
  it('copies only string, number and boolean values', () => {
    const helper = armedHelper();

    helper.span(
      SPAN_NAME,
      {
        label: 'kept',
        count: 3,
        flag: false,
        callback: () => 'skipped',
        nested: { inner: 'skipped' },
        list: ['skipped'],
        marker: Symbol('skipped'),
        big: 10n,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        empty: null,
      },
      () => undefined,
    );

    const { attributes } = onlyDraft();
    expect(attributes.label).toBe('kept');
    expect(attributes.count).toBe(3);
    expect(attributes.flag).toBe(false);
    for (const skipped of ['callback', 'nested', 'list', 'marker', 'big', 'nan', 'inf', 'empty']) {
      expect(attributes).not.toHaveProperty(skipped);
    }
  });

  it('redacts values under credential-like names and truncates strings and keys', () => {
    const helper = armedHelper();
    const longValue = 'v'.repeat(MAX_PREVIEW_LENGTH * 2);
    const longKey = 'k'.repeat(MAX_PREVIEW_LENGTH * 2);

    helper.span(
      SPAN_NAME,
      { apiKey: 'plain-value', password: 1234, authToken: true, long: longValue, [longKey]: 1 },
      () => undefined,
    );

    const { attributes } = onlyDraft();
    expect(attributes.apiKey).toBe(REDACTION_MARKER);
    expect(attributes.password).toBe(REDACTION_MARKER);
    expect(attributes.authToken).toBe(REDACTION_MARKER);
    expect(attributes.long).toBe(truncate(longValue, MAX_PREVIEW_LENGTH));
    expect(attributes[truncate(longKey, MAX_PREVIEW_LENGTH)]).toBe(1);
  });

  it('never lets meta set the keys this module and the service own', () => {
    const helper = armedHelper();

    helper.span(
      SPAN_NAME,
      {
        async: true,
        'error.type': 'ForgedError',
        lineage: 'forged',
        orphaned: true,
        request_key: 'forged',
        '': 'empty key',
      },
      () => undefined,
    );

    const { attributes } = onlyDraft();
    expect(attributes.async).toBe(false);
    expect(attributes).not.toHaveProperty(['error.type']);
    expect(attributes).not.toHaveProperty('lineage');
    expect(attributes).not.toHaveProperty('orphaned');
    expect(attributes).not.toHaveProperty('request_key');
    expect(Object.keys(attributes)).not.toContain('');
  });

  it('copies at most MAX_TRACKED_KEYS entries', () => {
    const helper = armedHelper();
    const meta: Record<string, unknown> = {};
    for (let index = 0; index < MAX_TRACKED_KEYS * 2; index += 1) {
      meta[`field${String(index)}`] = index;
    }

    helper.span(SPAN_NAME, meta, () => undefined);

    const copied = Object.keys(onlyDraft().attributes).filter((key) => key.startsWith('field'));
    expect(copied).toHaveLength(MAX_TRACKED_KEYS);
  });

  it('survives a hostile meta proxy and still runs the body once', () => {
    const helper = armedHelper();
    const meta = new Proxy<Record<string, unknown>>(
      {},
      {
        get(): never {
          throw new Error('get refused');
        },
        ownKeys(): never {
          throw new Error('ownKeys refused');
        },
      },
    );
    const fn = vi.fn(() => 'value');

    expect(helper.span(SPAN_NAME, meta, fn)).toBe('value');

    expect(fn).toHaveBeenCalledTimes(1);
    const draft = onlyDraft();
    expect(draft).not.toHaveProperty('source');
    expect(Object.keys(draft.attributes)).toEqual(['async']);
  });

  it('accepts a non-object meta from an untyped caller', () => {
    const helper = armedHelper();

    helper.span(SPAN_NAME, 'not an object' as unknown as Record<string, unknown>, () => undefined);

    expect(Object.keys(onlyDraft().attributes)).toEqual(['async']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Degradation: the instrumentation fails, the application does not
 * ---------------------------------------------------------------------------
 */

describe('span() when the instrumentation fails', () => {
  it('runs the body once, uninstrumented, when the id generator throws', () => {
    const helper = armedHelper();
    vi.spyOn(ids, 'newSpanId').mockImplementation(() => {
      throw new Error('no randomness available');
    });
    const fn = vi.fn(() => 'value');

    expect(helper.span(SPAN_NAME, {}, fn)).toBe('value');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(captured).toEqual([]);
  });

  it('returns the value when the transport throws', async () => {
    const helper = armedHelper();
    vi.spyOn(transport, 'emit').mockImplementation(() => {
      throw new Error('transport refused');
    });
    const pending = Promise.resolve('async value');

    expect(helper.span('sync', {}, () => 'value')).toBe('value');
    expect(helper.span('async', {}, () => pending)).toBe(pending);
    await expect(pending).resolves.toBe('async value');
    await macrotask();
  });
});

/*
 * ---------------------------------------------------------------------------
 * The capture generation gate
 * ---------------------------------------------------------------------------
 */

describe('span() across a capture boundary', () => {
  it('emits nothing for a span that settles after the capture was disarmed', async () => {
    const helper = armedHelper();
    const pending = new Deferred<string>();

    const result = helper.span(SPAN_NAME, {}, () => pending.promise);
    setSpanHelperEnabled(false);
    pending.resolve('late');
    await result;
    await macrotask();

    expect(captured).toEqual([]);
  });

  it('emits nothing for a span that settles after a different capture was armed', async () => {
    const helper = armedHelper();
    const pending = new Deferred<string>();

    const result = helper.span(SPAN_NAME, {}, () => pending.promise);
    setSpanHelperEnabled(true, OTHER_CAPTURE_ID);
    pending.resolve('late');
    await result;
    await macrotask();

    expect(captured).toEqual([]);
  });

  it('keeps reporting an in-flight span when the same capture is re-armed', async () => {
    const helper = armedHelper();
    const pending = new Deferred<string>();

    const result = helper.span(SPAN_NAME, {}, () => pending.promise);
    setSpanHelperEnabled(true, CAPTURE_ID);
    pending.resolve('continued');
    await result;
    await macrotask();

    expect(onlyDraft().status).toBe('ok');
  });

  it('treats an empty capture id as the same absence as none', async () => {
    const helper = installSpanHelper();
    setSpanHelperEnabled(true);
    const pending = new Deferred<string>();

    const result = helper.span(SPAN_NAME, {}, () => pending.promise);
    setSpanHelperEnabled(true, '');
    pending.resolve('continued');
    await result;
    await macrotask();

    expect(onlyDraft().status).toBe('ok');
  });

  it('emits nothing for a span that settles after an uninstall and a fresh arm', async () => {
    const helper = armedHelper();
    const pending = new Deferred<string>();

    const result = helper.span(SPAN_NAME, {}, () => pending.promise);
    uninstallSpanHelper();
    armedHelper();
    pending.resolve('late');
    await result;
    await macrotask();

    expect(captured).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * installSpanHelper / uninstallSpanHelper / getSpanHelper / config
 * ---------------------------------------------------------------------------
 */

describe('installSpanHelper()', () => {
  it('installs a helper with a callable span and the published version', () => {
    const helper = installSpanHelper();

    expect(readSlot()).toBe(helper);
    expect(typeof helper.span).toBe('function');
    expect(helper.version).toBe(SPAN_HELPER_VERSION);
    expect(getSpanHelper()).toBe(helper);
  });

  it('returns the same object the second time and merges describeTarget into it', () => {
    const first = installSpanHelper();
    const describeTarget = vi.fn((el: unknown) => ({ described: el !== undefined }));

    const second = installSpanHelper({ describeTarget });

    expect(second).toBe(first);
    expect(readSlot()).toBe(first);
    expect(memberOf(first, 'describeTarget')).toBe(describeTarget);
  });

  it('only ever raises the published version', () => {
    const helper = installSpanHelper({ version: 5 });
    expect(helper.version).toBe(5);

    installSpanHelper({ version: 3 });
    expect(helper.version).toBe(5);

    installSpanHelper({ version: Number.NaN });
    expect(helper.version).toBe(5);

    installSpanHelper({ version: 8 });
    expect(helper.version).toBe(8);
  });

  it('keeps a foreign helper with a callable span, stamping a version only where it has none', () => {
    const foreignSpan = <T>(_name: string, _meta: Record<string, unknown>, fn: () => T): T => fn();
    const foreign = { span: foreignSpan };
    const versioned = { span: foreignSpan, version: 9 };
    writeSlot(foreign);

    expect(installSpanHelper()).toBe(foreign);
    expect(memberOf(foreign, 'span')).toBe(foreignSpan);
    expect(memberOf(foreign, 'version')).toBe(SPAN_HELPER_VERSION);

    writeSlot(versioned);
    expect(installSpanHelper()).toBe(versioned);
    expect(versioned.version).toBe(9);

    uninstallSpanHelper();
    expect(readSlot()).toBe(versioned);
  });

  it("carries a foreign non-helper object's own members, but not its span or version", () => {
    const foreignState = {
      flag: true,
      settings: { mode: 'sample' },
      span: 'not callable',
      version: 99,
    };
    writeSlot(foreignState);

    const helper = installSpanHelper();

    expect(helper).not.toBe(foreignState);
    expect(readSlot()).toBe(helper);
    expect(memberOf(helper, 'flag')).toBe(true);
    expect(memberOf(helper, 'settings')).toBe(foreignState.settings);
    expect(typeof helper.span).toBe('function');
    expect(helper.version).toBe(SPAN_HELPER_VERSION);
  });

  it('installs over a value whose span getter throws, treating it as a non-helper', () => {
    const foreignState: Record<string, unknown> = { flag: true };
    Object.defineProperty(foreignState, 'span', {
      enumerable: true,
      get(): never {
        throw new Error('span getter refused');
      },
    });
    writeSlot(foreignState);

    const helper = installSpanHelper();

    expect(readSlot()).toBe(helper);
    expect(typeof helper.span).toBe('function');
    expect(memberOf(helper, 'flag')).toBe(true);
  });

  it('returns a usable helper when the global is an accessor whose getter throws', () => {
    Reflect.defineProperty(globalThis, GLOBAL_KEY, {
      configurable: true,
      get(): never {
        throw new Error('getter refused');
      },
    });

    const helper = installSpanHelper();
    setSpanHelperEnabled(true, CAPTURE_ID);

    expect(helper.span(SPAN_NAME, {}, () => 'direct')).toBe('direct');
    expect(onlyDraft().name).toBe(SPAN_NAME);
    expect(getSpanHelper()).toBeUndefined();
    expect(() => {
      uninstallSpanHelper();
    }).not.toThrow();
  });

  it('returns a usable helper without owning a global that refused the write', () => {
    const refusing = { frozen: true };
    Reflect.defineProperty(globalThis, GLOBAL_KEY, {
      value: refusing,
      writable: false,
      enumerable: true,
      configurable: true,
    });

    const helper = installSpanHelper();
    setSpanHelperEnabled(true, CAPTURE_ID);

    expect(readSlot()).toBe(refusing);
    expect(helper.span(SPAN_NAME, {}, () => 'direct')).toBe('direct');
    expect(onlyDraft().name).toBe(SPAN_NAME);

    uninstallSpanHelper();
    expect(readSlot()).toBe(refusing);
  });
});

describe('uninstallSpanHelper()', () => {
  it('removes the helper it installed and disarms', () => {
    const helper = armedHelper();

    uninstallSpanHelper();

    expect(Reflect.getOwnPropertyDescriptor(globalThis, GLOBAL_KEY)).toBeUndefined();
    expect(getSpanHelper()).toBeUndefined();
    helper.span(SPAN_NAME, {}, () => undefined);
    expect(captured).toEqual([]);
  });

  it('is idempotent and a no-op without a preceding install', () => {
    expect(() => {
      uninstallSpanHelper();
    }).not.toThrow();

    installSpanHelper();
    uninstallSpanHelper();
    uninstallSpanHelper();
    expect(readSlot()).toBeUndefined();

    const foreign = { unrelated: true };
    writeSlot(foreign);
    uninstallSpanHelper();
    expect(readSlot()).toBe(foreign);
  });

  it('leaves a global that was replaced after the install', () => {
    installSpanHelper();
    const replacement = { replaced: true };
    writeSlot(replacement);

    uninstallSpanHelper();

    expect(readSlot()).toBe(replacement);
  });

  it('falls back to clearing the slot when the deletion is refused', () => {
    installSpanHelper();
    const originalDelete = Reflect.deleteProperty.bind(Reflect);
    vi.spyOn(Reflect, 'deleteProperty').mockImplementation((target, key) =>
      target === globalThis && key === GLOBAL_KEY ? false : originalDelete(target, key),
    );

    uninstallSpanHelper();

    expect(readSlot()).toBeUndefined();
  });
});

describe('getSpanHelper()', () => {
  it('answers what patched code would call, and nothing for a non-helper value', () => {
    expect(getSpanHelper()).toBeUndefined();

    writeSlot({ span: 'not callable' });
    expect(getSpanHelper()).toBeUndefined();

    const foreign = {
      span: <T>(_name: string, _meta: Record<string, unknown>, fn: () => T): T => fn(),
    };
    writeSlot(foreign);
    expect(getSpanHelper()).toBe(foreign);
  });
});

describe('setSpanHelperConfig()', () => {
  it('publishes a configuration recorded before the install', () => {
    const published = { signals: ['functions'], captureId: CAPTURE_ID };

    setSpanHelperConfig(published);
    const helper = installSpanHelper();

    expect(helper.config).toBe(published);
  });

  it('updates the installed helper, including to an explicit undefined', () => {
    const helper = installSpanHelper();
    const next = { signals: [] };

    setSpanHelperConfig(next);
    expect(helper.config).toBe(next);

    setSpanHelperConfig(undefined);
    expect(Object.hasOwn(helper, 'config')).toBe(true);
    expect(helper.config).toBeUndefined();
  });

  it('tolerates a frozen helper and a missing one', () => {
    expect(() => {
      setSpanHelperConfig({ before: 'install' });
    }).not.toThrow();

    const frozen = Object.freeze({
      span: <T>(_name: string, _meta: Record<string, unknown>, fn: () => T): T => fn(),
    });
    writeSlot(frozen);
    expect(() => {
      setSpanHelperConfig({ after: 'freeze' });
    }).not.toThrow();
    expect(frozen).not.toHaveProperty('config');
  });
});
