// @vitest-environment happy-dom
/**
 * Colocated tests for `./errors.ts` — the producer that turns a page's
 * exceptions, unhandled rejections and failed resource loads into `error`
 * events.
 *
 * **What this suite owns.** Three properties nothing downstream can observe
 * for itself, because everything downstream sees only the events this module
 * chose to emit:
 *
 * 1. **Only a branded error has its fields read** (AAP §0.5.2). The one
 *    security-relevant decision in the module is `isBrandedError`: a value the
 *    language vouches for as an error contributes `name`, `message` and
 *    `stack`, and every other value contributes a category tag and nothing
 *    else. A duck-typed predicate — "a string `name` and a string `message`"
 *    — accepts an ordinary rejected application record, and that record is
 *    then persisted, tailed into DevTools and aggregated into model input. The
 *    cases below therefore assert the *absence* of the application's own
 *    strings in the emitted draft, not merely the presence of a tag: a
 *    regression that re-admits duck typing keeps the tag and adds the fields.
 *    Both directions are covered — the forgeries that must be refused (a
 *    plain record, a `Symbol.toStringTag` spoof, an array, a class instance, a
 *    function, a DOM node) and the errors that must be accepted (a real
 *    `Error`, a subclass, a `DOMException`, a value declared an error by its
 *    prototype, and a genuinely cross-realm error out of an iframe).
 * 2. **Absolute non-interference.** The page's own error reporting must be
 *    byte-for-byte what it was: the application's listener still fires exactly
 *    once, `defaultPrevented` stays false, the dispatch is not cancelled, and
 *    `event.promise` is never so much as read — asserted with a throwing
 *    accessor that counts its own reads rather than by inspection of the
 *    source.
 * 3. **Bounded, counted, reversible.** The two text bounds cut at exactly
 *    their documented lengths without splitting a surrogate pair, the
 *    per-capture cap stops emission and reports the remainder as drops, a
 *    throwing transport is counted as a failure rather than re-thrown or
 *    recursed into, and after `detachErrors()` a further failure produces
 *    nothing at all (AAP §0.5.1, "disabled, not merely idled").
 *
 * **Harness.** The root `vitest.config.ts` collects this file into the
 * `telemetry` project, which runs under happy-dom; line 1 states the
 * requirement locally anyway, as every browser suite in this folder does,
 * because these cases dispatch real events at a real `window`. Emissions are
 * observed by spying on `./transport.ts`'s `emit` — the single-draft entry
 * point this module hands every event to — which is synchronous and sidesteps
 * the 250 ms batch timer entirely. The transport is still configured with a
 * capture in `beforeEach`, so the module runs against production-shaped
 * state, and one case deliberately removes the spy to prove the real capture
 * gate is in the path.
 *
 * **Why the branding cases dispatch events instead of calling the predicate.**
 * `isBrandedError` is module-private, and the property being tested is not
 * "the predicate answers false" but "the event carries none of the value's
 * data". Only the emitted draft can show that, so every case goes in through
 * `window.dispatchEvent` — which is also the path the cap, the re-entrancy
 * guard and the listener contract live on.
 *
 * No credential literal appears in this file: the tracked-content scanner
 * (`scripts/check-secrets.mjs`) reads it like any other file, so the one
 * key-shaped fixture is assembled from fragments at runtime, exactly as
 * `../redaction/rules.test.ts` and `./dom-target.test.ts` do it. Nothing here
 * imports a Node built-in either — `eslint.config.js` forbids one anywhere
 * under `src/browser/**`, tests included, because this directory is bundled
 * into the page-injected agent (AAP §0.2.2, §0.7.1 Group 1).
 *
 * @see ./errors.ts for the module under test.
 * @see ./react.test.tsx for the recorder shape this suite follows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_ERRORS_PER_CAPTURE,
  MAX_MESSAGE_CHARS,
  MAX_STACK_CHARS,
  attachErrors,
  detachErrors,
  getErrorStats,
  isErrorsAttached,
} from './errors.js';
import {
  attachInteractions,
  detachInteractions,
  getActiveInteraction,
  isInteractionWindowOpen,
} from './interaction.js';
import * as transport from './transport.js';
import type { EventDraft } from './transport.js';
import { redactEventWithFindings } from '../redaction/redactor.js';
import type { TelemetryEventIngress } from '../schema/event.js';

/*
 * ---------------------------------------------------------------------------
 * Constants the assertions are written against
 * ---------------------------------------------------------------------------
 */

/** The capture every test configures the transport with. */
const CAPTURE_ID = 'cap_errors_test';

/** The session every test configures the transport with. */
const SESSION_ID = 'ses_errors_test';

/** The event type carrying script errors and resource-load failures. */
const ERROR_EVENT_TYPE = 'error';

/** The event type carrying unhandled promise rejections. */
const REJECTION_EVENT_TYPE = 'unhandledrejection';

/**
 * The W3C trace-context id shapes, restated locally on purpose.
 *
 * `./ids.ts` owns the same two patterns and is not a dependency of this file;
 * a test that imported the producer's own regex could not catch the producer
 * changing it. These are wire constants — 32 and 16 lowercase hex characters.
 */
const TRACE_ID_SHAPE = /^[0-9a-f]{32}$/;
const SPAN_ID_SHAPE = /^[0-9a-f]{16}$/;

/**
 * How far an event's `startTime` may sit from `Date.now()`: ten minutes.
 *
 * Deliberately loose, for the same reason `./react.test.tsx` states: the
 * assertion being made is "this is an epoch-millisecond reading of this
 * machine's clock", which is what the correlator and the service's ingress
 * schema require. Nothing narrower is true on a shared host.
 */
const CLOCK_WINDOW_MS = 10 * 60 * 1000;

/** The script URL the script-error cases report. */
const SCRIPT_URL = 'https://app.test/_next/static/chunks/page-4f21c9.js';

/** The image URL the resource cases report. */
const IMAGE_URL = 'https://cdn.app.test/media/hero-banner.png';

/** The stylesheet URL the resource cases report. */
const STYLE_URL = 'https://cdn.app.test/styles/theme-7e12.css';

/*
 * ---------------------------------------------------------------------------
 * Application data that must never enter a capture
 *
 * One record's worth of strings, reused by every forgery case, so each case
 * asserts against the same four values: an application's own class name, a
 * sentence naming a customer and an invoice, a frame naming project source,
 * and a credential the application had attached to the record. Every one of
 * them is the kind of value AAP 0.5.2 keeps out of the capture, and each case
 * stringifies the whole emitted draft to prove none of them is anywhere
 * inside it — attribute value, event name, or otherwise.
 * ---------------------------------------------------------------------------
 */

/** The `name` an application record carries. */
const APP_NAME = 'PaymentDeclinedError';

/** The `message` an application record carries. */
const APP_MESSAGE = 'invoice INV-7781 for ada@example.test was declined at checkout';

/** The `stack` an application record carries. */
const APP_STACK = 'at chargeCard (src/server/services/payment.service.ts:118:9)';

/**
 * A provider-key-shaped string, assembled from fragments at runtime.
 *
 * The scanner of `scripts/check-secrets.mjs` reads this file's committed
 * bytes, so no credential prefix appears here as a contiguous literal. What
 * the assembled value proves is worth the assembly: this module does **not**
 * redact (scrubbing happens at ingest and again on the outbound model path),
 * so the only thing keeping a credential that an application attached to a
 * rejected record out of the capture is the branding decision under test.
 */
const APP_CREDENTIAL = ['s', 'k-', 'live-', 'a1b2c3d4e5f6a7b8c9d0e1f2'].join('');

/** Every application string a forgery case asserts the absence of. */
const APP_STRINGS: readonly string[] = [APP_NAME, APP_MESSAGE, APP_STACK, APP_CREDENTIAL];

/*
 * ---------------------------------------------------------------------------
 * Recording
 *
 * `emit` is the target because it is the single function this producer hands
 * a draft to; `emitMany` is React's path and is not in play here.
 * ---------------------------------------------------------------------------
 */

/** Every draft emitted during the current test, in emission order. */
const captured: EventDraft[] = [];

/** Replace `emit` with a synchronous recorder for the current test. */
function startRecording(): void {
  vi.spyOn(transport, 'emit').mockImplementation((draft) => {
    captured.push(draft);
  });
}

/** Forget every recorded draft. */
function clearCaptured(): void {
  captured.length = 0;
}

/**
 * The recorded `error`-kind drafts.
 *
 * Filtered by kind rather than taken wholesale because one case attaches the
 * interaction producer, which emits an `interaction` event of its own through
 * the same `emit`.
 */
function errorDrafts(): EventDraft[] {
  return captured.filter((draft) => draft.kind === ERROR_EVENT_TYPE);
}

/**
 * The single recorded `error` draft, or a failure naming what was found.
 *
 * `noUncheckedIndexedAccess` makes every index read `T | undefined`; this
 * keeps the narrowing in one place instead of scattering assertions that would
 * report "undefined" without saying what was expected.
 */
function onlyErrorDraft(): EventDraft {
  const drafts = errorDrafts();
  expect(drafts).toHaveLength(1);
  const draft = drafts[0];
  if (draft === undefined) {
    throw new Error('expected exactly one error draft, found none');
  }
  return draft;
}

/** One attribute read as a string, or a failure naming the key and its type. */
function stringAttribute(draft: EventDraft, key: string): string {
  const value = draft.attributes[key];
  if (typeof value !== 'string') {
    throw new Error(`expected attribute ${key} to be a string, found ${typeof value}`);
  }
  return value;
}

/**
 * Assert an attribute is absent rather than present-and-empty.
 *
 * Both halves matter: absence is how this product says "not observed", and a
 * key written with an `undefined` value would survive a `toBeUndefined()`
 * check while still reaching the wire.
 */
function expectAbsentAttribute(draft: EventDraft, key: string): void {
  expect(Object.keys(draft.attributes)).not.toContain(key);
  expect(draft.attributes[key]).toBeUndefined();
}

/** The whole draft as one string, for "this value is nowhere in it" checks. */
function draftText(draft: EventDraft): string {
  return JSON.stringify(draft);
}

/**
 * Complete a recorded draft into the ingress event the service receives.
 *
 * `./transport.ts` adds `id`, `producerId`, `seq` and `tier` on its way out —
 * a document has exactly one producer id, one sequence and one tier, and all
 * four are its to assign — so a draft is not yet an event and the redactor
 * takes an event. The four values are supplied here with the shapes the
 * ingress schema requires, which keeps the scrubbing case honest: what is
 * handed to the boundary is the shape the boundary really sees.
 */
function asIngressEvent(draft: EventDraft): TelemetryEventIngress {
  return {
    ...draft,
    id: draft.id ?? 'evt_errors_test',
    producerId: 'prd_errors_test',
    seq: 0,
    tier: 'browser',
  };
}

/**
 * Every structural guarantee an emitted error event carries, whatever produced
 * it: the fixed kind, status and duration, a well-formed trace context, an
 * epoch-millisecond instant and a payload that survives the journey to the
 * service.
 */
function expectWellFormedErrorEvent(draft: EventDraft): void {
  expect(draft.kind).toBe('error');
  expect(draft.status).toBe('error');
  // An exception is an instant: a nominal duration would draw a bar on the
  // timeline and enter the per-tier duration metrics as time never spent.
  expect(draft.duration).toBe(0);
  expect(draft.traceId).toMatch(TRACE_ID_SHAPE);
  expect(draft.spanId).toMatch(SPAN_ID_SHAPE);
  expect(draft.name.length).toBeGreaterThan(0);
  expect(Number.isFinite(draft.startTime)).toBe(true);
  expect(draft.startTime).toBeGreaterThan(Date.now() - CLOCK_WINDOW_MS);
  expect(draft.startTime).toBeLessThan(Date.now() + CLOCK_WINDOW_MS);
  expect(draft.attributes['errorType']).toBeTypeOf('string');
  // Every event crosses the page channel as JSON text and is then validated by
  // the service's strict ingress schema, which admits no function and no symbol.
  const roundTripped: unknown = JSON.parse(draftText(draft));
  expect(roundTripped).toStrictEqual(draft);
}

/**
 * Assert a value was summarised by its tag alone: the category tag is the
 * `error.type`, there is no message and no stack, and not one of the
 * application's strings is anywhere in the draft.
 *
 * The assertion the branding fix exists to make, so it is written once and
 * used by every forgery case.
 */
function expectSummarisedByTagOnly(draft: EventDraft, tag: string): void {
  expectWellFormedErrorEvent(draft);
  expect(stringAttribute(draft, 'error.type')).toBe(tag);
  expectAbsentAttribute(draft, 'error.message');
  expectAbsentAttribute(draft, 'error.stack');

  const text = draftText(draft);
  for (const secret of APP_STRINGS) {
    expect(text).not.toContain(secret);
  }
}

/*
 * ---------------------------------------------------------------------------
 * Dispatch helpers
 *
 * Every case goes in through the host, at `window`, exactly as a page's own
 * failure would: the listener registration, the capture phase and the
 * re-entrancy guard are part of what is under test.
 * ---------------------------------------------------------------------------
 */

/**
 * Dispatch an `unhandledrejection` event carrying `reason`.
 *
 * A plain `Event` with the reason defined on the instance, because happy-dom
 * has no `PromiseRejectionEvent` constructor and because the module reads
 * `reason` structurally — it never asks what class the event is. No promise is
 * created at all, which is also the honest shape: this producer must work on
 * an event whose `promise` it refuses to touch.
 *
 * @returns Whether the dispatch completed uncancelled.
 */
function dispatchRejection(reason: unknown): boolean {
  const event = new Event(REJECTION_EVENT_TYPE);
  Object.defineProperty(event, 'reason', { value: reason, configurable: true });
  return window.dispatchEvent(event);
}

/** Dispatch an `unhandledrejection` event with no `reason` property at all. */
function dispatchRejectionWithoutReason(): boolean {
  return window.dispatchEvent(new Event(REJECTION_EVENT_TYPE));
}

/** Dispatch an `ErrorEvent` at `window`, as a host reports a script error. */
function dispatchScriptError(init: ErrorEventInit): boolean {
  return window.dispatchEvent(new ErrorEvent(ERROR_EVENT_TYPE, init));
}

/**
 * Attach an element to the document and dispatch the `error` event a failed
 * resource load produces at it.
 *
 * Dispatched at the element, not at `window`: a resource-load error does not
 * bubble, so this is the case the module's capture-phase registration exists
 * for, and a bubble-phase listener would see nothing.
 */
function dispatchResourceError(element: Element): boolean {
  document.body.appendChild(element);
  return element.dispatchEvent(new Event(ERROR_EVENT_TYPE));
}

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/** An ordinary rejected application record: three strings and a credential. */
function applicationRecord(): Record<string, unknown> {
  return {
    name: APP_NAME,
    message: APP_MESSAGE,
    stack: APP_STACK,
    requestHeaders: { authorization: `Bearer ${APP_CREDENTIAL}` },
  };
}

/**
 * The spoof: an application record that brands itself `[object Error]` with a
 * tag of its own.
 *
 * `Object.prototype.toString` returns a value's `Symbol.toStringTag` in
 * preference to inspecting its internal slots, so this object is
 * indistinguishable from a real error by brand alone.
 */
function toStringTagSpoof(): Record<string, unknown> {
  return {
    [Symbol.toStringTag]: 'Error',
    name: APP_NAME,
    message: APP_MESSAGE,
    stack: APP_STACK,
  };
}

/**
 * The same spoof one indirection out: the tag is **inherited**, so the record
 * owns no property at all and still brands itself `[object Error]`.
 *
 * The case that makes "no own tag" an insufficient condition and the whole
 * prototype chain the right one: a forgery needs one `Object.create` to move
 * its claim off the object, while a real `Error` carries no tag at any level
 * because `Error.prototype` defines none.
 */
function inheritedToStringTagSpoof(): object {
  const tagged = { [Symbol.toStringTag]: 'Error' };
  const record: object = Object.create(tagged) as object;
  Object.assign(record, { name: APP_NAME, message: APP_MESSAGE, stack: APP_STACK });
  return record;
}

/**
 * An application record rooted at `Error.prototype`, so `instanceof Error`
 * answers `true` for it.
 *
 * It has no `[[ErrorData]]` slot — `Object.create` allocates an ordinary
 * object — so its `name`, `message` and `stack` are exactly as much the
 * application's own data as any other record's, and a prototype declaration is
 * not the language vouching for anything. Accepting it is the third shape of
 * the same duck-typing failure, and the reason `instanceof` is consulted
 * nowhere in the producer.
 */
function errorPrototypeRecord(): object {
  const record: object = Object.create(Error.prototype) as object;
  Object.assign(record, { name: APP_NAME, message: APP_MESSAGE, stack: APP_STACK });
  return record;
}

/**
 * A record whose every well-known property is a throwing accessor that logs
 * its own read.
 *
 * Proof by construction that a non-branded value's properties are not read:
 * the log stays empty, and a regression that reaches for `name` both throws
 * (which the producer would count as a failure) and appears in the log.
 */
function readLoggingRecord(log: string[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of ['name', 'message', 'stack', 'toString', 'toJSON', 'valueOf']) {
    Object.defineProperty(record, key, {
      enumerable: true,
      configurable: true,
      get(): never {
        log.push(key);
        throw new Error(`property ${key} was read`);
      },
    });
  }
  return record;
}

/**
 * A real cross-realm `Error`, out of an iframe in this same document.
 *
 * The case no duck-typed predicate was needed for and every branding route
 * has to keep working on: the object's prototype chain belongs to the frame's
 * global, so `instanceof Error` is false in this one while the value is
 * exactly the error whose three fields a developer wants to read. The test
 * asserts that `instanceof` really does fail, so the case cannot quietly
 * degrade into "another ordinary error".
 */
async function createCrossRealmError(message: string): Promise<Error> {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  // One turn of the loop for the frame to get its own global.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10);
  });

  const frameWindow: unknown = iframe.contentWindow;
  if (frameWindow === null || frameWindow === undefined) {
    throw new Error('happy-dom gave the iframe no contentWindow to build a foreign Error in');
  }
  const foreign = frameWindow as { Error: ErrorConstructor };
  return new foreign.Error(message);
}

/*
 * ---------------------------------------------------------------------------
 * Lifecycle
 *
 * The producer is attached for every case and detached before the next one:
 * a leaked listener would double every later assertion. The counters are
 * per capture and reset at attach, so each case starts from three zeroes.
 * ---------------------------------------------------------------------------
 */

beforeEach(() => {
  clearCaptured();
  transport.resetTransport();
  transport.configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_ID, enabled: true });
  startRecording();
  attachErrors();
});

afterEach(() => {
  detachErrors();
  detachInteractions();
  vi.restoreAllMocks();
  transport.resetTransport();
  clearCaptured();
  document.body.replaceChildren();
});

/*
 * ---------------------------------------------------------------------------
 * Branding: what may have its fields read (AAP 0.5.2)
 * ---------------------------------------------------------------------------
 */

describe('error branding — values that are not errors', () => {
  it('summarises a rejected application record as [object] and copies nothing out of it', () => {
    dispatchRejection(applicationRecord());

    const draft = onlyErrorDraft();
    expectSummarisedByTagOnly(draft, '[object]');
    // The event still exists and is still attributable: the failure is
    // reported, only the application's data is not.
    expect(draft.attributes['errorType']).toBe(REJECTION_EVENT_TYPE);
    expect(draft.name).toBe(REJECTION_EVENT_TYPE);
    expect(getErrorStats()).toStrictEqual({ emitted: 1, dropped: 0, failures: 0 });
  });

  it('refuses a record that brands itself [object Error] with its own toStringTag', () => {
    dispatchRejection(toStringTagSpoof());

    expectSummarisedByTagOnly(onlyErrorDraft(), '[object]');
  });

  it('refuses a record whose [object Error] brand is inherited rather than own', () => {
    const spoof = inheritedToStringTagSpoof();
    // The premise: nothing on the object itself makes the claim, and the brand
    // is a real `[object Error]` — the combination an own-property check misses.
    expect(Object.getOwnPropertySymbols(spoof)).toHaveLength(0);
    expect(Object.prototype.toString.call(spoof)).toBe('[object Error]');

    dispatchRejection(spoof);

    expectSummarisedByTagOnly(onlyErrorDraft(), '[object]');
  });

  it('refuses a record rooted at Error.prototype, which instanceof accepts', () => {
    const record = errorPrototypeRecord();
    // The premise: `instanceof` says yes and the language says nothing, since
    // `Object.create` allocates an ordinary object with no error slot.
    expect(record instanceof Error).toBe(true);

    dispatchRejection(record);

    expectSummarisedByTagOnly(onlyErrorDraft(), '[object]');
  });

  it('refuses a record while the page claims every value is an Error', () => {
    // `Symbol.hasInstance` is the page's to define, so an `instanceof` route
    // would accept the whole heap here. Defined as an own property on the
    // intrinsic constructor and removed again, which is precisely what a page
    // script can do to the producer's realm.
    Object.defineProperty(Error, Symbol.hasInstance, {
      value: () => true,
      configurable: true,
    });

    try {
      const record = applicationRecord();
      expect(record instanceof Error).toBe(true);

      dispatchRejection(record);

      expectSummarisedByTagOnly(onlyErrorDraft(), '[object]');
    } finally {
      Reflect.deleteProperty(Error, Symbol.hasInstance);
    }

    // The realm is as it was: the forgery was contained to this case.
    expect(applicationRecord() instanceof Error).toBe(false);
  });

  it('refuses a proxy around a real Error rather than reading through its traps', () => {
    const reads: PropertyKey[] = [];
    const proxied = new Proxy(new Error(APP_MESSAGE), {
      get(target, key, receiver): unknown {
        reads.push(key);
        if (key === 'stack') {
          return APP_STACK;
        }
        return Reflect.get(target, key, receiver);
      },
    });

    dispatchRejection(proxied);

    // A proxy has no `[[ErrorData]]` slot of its own, so the language does not
    // vouch for it — and reading an error's fields through page-written traps
    // is the last thing a producer on the page's own error path should do.
    expectSummarisedByTagOnly(onlyErrorDraft(), '[object]');
    expect(reads).toStrictEqual([]);
  });

  it('summarises an array carrying error-shaped fields as [array]', () => {
    const list: unknown[] = ['first', 'second'];
    Object.assign(list, { name: APP_NAME, message: APP_MESSAGE, stack: APP_STACK });

    dispatchRejection(list);

    const draft = onlyErrorDraft();
    expectSummarisedByTagOnly(draft, '[array]');
    expect(draftText(draft)).not.toContain('second');
  });

  it('summarises a class instance with a name field as [object]', () => {
    class ApiFailure {
      readonly name = APP_NAME;
      readonly message = APP_MESSAGE;
      readonly stack = APP_STACK;
    }

    dispatchRejection(new ApiFailure());

    expectSummarisedByTagOnly(onlyErrorDraft(), '[object]');
  });

  it('summarises a rejected function as [function] without reading its source', () => {
    const handler = function chargeCard(): string {
      return APP_MESSAGE;
    };

    dispatchRejection(handler);

    const draft = onlyErrorDraft();
    expectSummarisedByTagOnly(draft, '[function]');
    expect(draftText(draft)).not.toContain('chargeCard');
  });

  it('summarises a rejected DOM node as [dom] without describing the page', () => {
    const node = document.createElement('section');
    node.setAttribute('data-customer', APP_MESSAGE);
    node.textContent = APP_MESSAGE;

    dispatchRejection(node);

    expectSummarisedByTagOnly(onlyErrorDraft(), '[dom]');
  });

  it('reads no property at all of a non-branded value', () => {
    const reads: string[] = [];

    dispatchRejection(readLoggingRecord(reads));

    // Not one accessor ran, so the "each read is guarded" machinery was not
    // even reached: a non-branded value is described structurally.
    expect(reads).toStrictEqual([]);
    expectSummarisedByTagOnly(onlyErrorDraft(), '[object]');
    expect(getErrorStats().failures).toBe(0);
  });
});

describe('error branding — values that are errors', () => {
  it('keeps the class, message and stack of a real Error', () => {
    dispatchRejection(new Error('the checkout total did not settle'));

    const draft = onlyErrorDraft();
    expectWellFormedErrorEvent(draft);
    expect(draft.name).toBe('Error');
    expect(stringAttribute(draft, 'error.type')).toBe('Error');
    expect(stringAttribute(draft, 'error.message')).toBe('the checkout total did not settle');
    expect(stringAttribute(draft, 'error.stack')).toContain(
      'Error: the checkout total did not settle',
    );
    expectAbsentAttribute(draft, 'error.truncated');
  });

  it('keeps the subclass name of a TypeError', () => {
    dispatchRejection(new TypeError('cart.items is not iterable'));

    const draft = onlyErrorDraft();
    expect(draft.name).toBe('TypeError');
    expect(stringAttribute(draft, 'error.type')).toBe('TypeError');
    expect(stringAttribute(draft, 'error.message')).toBe('cart.items is not iterable');
  });

  it('keeps the name of an application error subclass', () => {
    class CheckoutError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CheckoutError';
      }
    }

    dispatchRejection(new CheckoutError('shipping quote expired'));

    const draft = onlyErrorDraft();
    expect(draft.name).toBe('CheckoutError');
    expect(stringAttribute(draft, 'error.type')).toBe('CheckoutError');
    expect(stringAttribute(draft, 'error.message')).toBe('shipping quote expired');
  });

  it('keeps a DOMException, which a page produces by aborting a request', () => {
    dispatchRejection(new DOMException('The operation was aborted.', 'AbortError'));

    const draft = onlyErrorDraft();
    expect(stringAttribute(draft, 'error.type')).toBe('AbortError');
    expect(stringAttribute(draft, 'error.message')).toBe('The operation was aborted.');
  });

  it('accepts a cross-realm Error that fails instanceof in this realm', async () => {
    const crossRealm = await createCrossRealmError('the frame threw');
    // The case is only meaningful while this holds: an iframe's Error has the
    // frame's prototype chain, not this document's.
    expect(crossRealm instanceof Error).toBe(false);
    clearCaptured();

    dispatchRejection(crossRealm);

    const draft = onlyErrorDraft();
    expectWellFormedErrorEvent(draft);
    expect(stringAttribute(draft, 'error.type')).toBe('Error');
    expect(stringAttribute(draft, 'error.message')).toBe('the frame threw');
    expect(stringAttribute(draft, 'error.stack').length).toBeGreaterThan(0);
  });
});

describe('error branding — a host without Error.isError', () => {
  it('still accepts a cross-realm error and still refuses the toStringTag spoof', async () => {
    const crossRealm = await createCrossRealmError('the frame threw without a brand check');
    const errorConstructor = Error as unknown as { isError?: unknown };
    const originalIsError: unknown = errorConstructor.isError;

    // The module captures its intrinsics at evaluation, so the only way to
    // exercise the brand fallback — the sole route on a host predating
    // `Error.isError` — is to evaluate the module again without one. The
    // transport is imported first so the fresh producer resolves to the
    // instance this case can record from.
    delete errorConstructor.isError;
    detachErrors();
    vi.resetModules();
    const freshTransport = await import('./transport.js');
    const freshErrors = await import('./errors.js');
    const freshDrafts: EventDraft[] = [];

    try {
      expect((Error as unknown as { isError?: unknown }).isError).toBeUndefined();
      // The case is vacuous unless the producer really was re-evaluated: a
      // registry that handed back the module this file imported statically
      // would still have captured `Error.isError` and would prove nothing
      // about the fallback.
      expect(freshErrors.attachErrors).not.toBe(attachErrors);
      vi.spyOn(freshTransport, 'emit').mockImplementation((draft) => {
        freshDrafts.push(draft);
      });
      freshTransport.resetTransport();
      freshTransport.configureTransport({
        sessionId: SESSION_ID,
        captureId: CAPTURE_ID,
        enabled: true,
      });
      freshErrors.attachErrors();

      dispatchRejection(crossRealm);
      dispatchRejection(toStringTagSpoof());
      dispatchRejection(inheritedToStringTagSpoof());
      dispatchRejection(errorPrototypeRecord());
      dispatchRejection(applicationRecord());
    } finally {
      freshErrors.detachErrors();
      freshTransport.resetTransport();
      Object.defineProperty(errorConstructor, 'isError', {
        value: originalIsError,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }

    expect((Error as unknown as { isError?: unknown }).isError).toBe(originalIsError);
    expect(freshDrafts).toHaveLength(5);
    const [crossRealmDraft, ...forgedDrafts] = freshDrafts;
    if (crossRealmDraft === undefined || forgedDrafts.length !== 4) {
      throw new Error('expected five drafts from the re-evaluated producer');
    }

    // The brand route carries the real error through: a cross-realm `Error`
    // carries `[[ErrorData]]` and no `@@toStringTag` at any level, which is
    // exactly the shape the fallback trusts.
    expect(stringAttribute(crossRealmDraft, 'error.type')).toBe('Error');
    expect(stringAttribute(crossRealmDraft, 'error.message')).toBe(
      'the frame threw without a brand check',
    );

    // …and refuses every forgery, because a brand the value can supply for
    // itself — own tag, inherited tag, or a prototype declaration — is not a
    // brand. The own-tag and inherited-tag records are rejected by the tag
    // condition, and the `Error.prototype` record has no slot for
    // `Object.prototype.toString` to report.
    for (const forged of forgedDrafts) {
      expectSummarisedByTagOnly(forged, '[object]');
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The scrubbing boundary this producer relies on
 *
 * This module records a branded error's message and stack **verbatim** — AAP
 * 0.5.2 puts scrubbing at ingest (`apps/local-service/src/telemetry/ingest.ts`,
 * through `../redaction/redactor.ts`) and again on the outbound model path
 * (`packages/model-provider/src/redact-guard.ts`), and in-page redaction is
 * reserved for React prop and state previews. That division is only safe if
 * the next boundary actually scrubs the shape this producer emits, so the case
 * below composes the two: a real failure carrying a credential in the one
 * field a developer legitimately reads, put through the redactor exactly as the
 * service puts it, with the raw value asserted absent from the result.
 *
 * A producer test proving "the message survives here" (which the cases above
 * do) is not evidence of that; only the composition is.
 * ---------------------------------------------------------------------------
 */

describe('secret scrubbing at the boundary this producer defers to', () => {
  it('scrubs a credential out of a captured message and stack at ingest', () => {
    const leaked = `POST /api/checkout failed with Authorization: Bearer ${APP_CREDENTIAL}`;
    const failure = new Error(leaked);
    failure.stack = `Error: ${leaked}\n    at chargeCard (app.js:1:1)`;

    dispatchRejection(failure);

    // The producer's own output is raw, deliberately: the developer's console
    // sentence is the evidence a panel renders, and cutting it twice at two
    // fidelities would leave them reading a worse version of it.
    const draft = onlyErrorDraft();
    expect(stringAttribute(draft, 'error.message')).toContain(APP_CREDENTIAL);

    const { event, report } = redactEventWithFindings(asIngressEvent(draft));

    // …and the boundary it defers to removes the credential from every field
    // it travels in, marks the paths it touched, and leaves the sentence
    // around it readable.
    const redactedText = JSON.stringify(event);
    expect(redactedText).not.toContain(APP_CREDENTIAL);
    expect(report.rules.length).toBeGreaterThan(0);
    expect(event.attributes['error.message']).toContain('/api/checkout');
    expect(event.redacted ?? []).not.toHaveLength(0);
  });

  it('leaves an ordinary failure message untouched, so the guarantee is not blanket masking', () => {
    dispatchRejection(new Error('the shipping quote expired before the order was placed'));

    const { event, report } = redactEventWithFindings(asIngressEvent(onlyErrorDraft()));

    expect(event.attributes['error.message']).toBe(
      'the shipping quote expired before the order was placed',
    );
    expect(report.rules).toStrictEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Non-error reasons
 * ---------------------------------------------------------------------------
 */

describe('rejection reasons that are not objects', () => {
  it('keeps a thrown string as the message under the [string] tag', () => {
    dispatchRejection('the session expired');

    const draft = onlyErrorDraft();
    expectWellFormedErrorEvent(draft);
    expect(stringAttribute(draft, 'error.type')).toBe('[string]');
    expect(stringAttribute(draft, 'error.message')).toBe('the session expired');
    // A string has no stack, and inventing one would point the source-map
    // resolver at a frame that does not exist.
    expectAbsentAttribute(draft, 'error.stack');
    expect(draft.name).toBe(REJECTION_EVENT_TYPE);
  });

  it('keeps a number, a bigint, a boolean and a symbol description', () => {
    dispatchRejection(418);
    dispatchRejection(9_007_199_254_740_993n);
    dispatchRejection(false);
    dispatchRejection(Symbol('cart-reconciliation'));

    const drafts = errorDrafts();
    expect(drafts).toHaveLength(4);
    const [numberDraft, bigintDraft, booleanDraft, symbolDraft] = drafts;
    if (
      numberDraft === undefined ||
      bigintDraft === undefined ||
      booleanDraft === undefined ||
      symbolDraft === undefined
    ) {
      throw new Error('expected four error drafts, one per primitive reason');
    }

    expect(stringAttribute(numberDraft, 'error.type')).toBe('[number]');
    expect(stringAttribute(numberDraft, 'error.message')).toBe('418');
    // The language's own conversion, not a method the page could replace, and
    // the full precision a bigint carries.
    expect(stringAttribute(bigintDraft, 'error.type')).toBe('[bigint]');
    expect(stringAttribute(bigintDraft, 'error.message')).toBe('9007199254740993');
    expect(stringAttribute(booleanDraft, 'error.type')).toBe('[boolean]');
    expect(stringAttribute(booleanDraft, 'error.message')).toBe('false');
    // A symbol contributes its `description` — a string the program wrote —
    // rather than a `Symbol.prototype.toString` call.
    expect(stringAttribute(symbolDraft, 'error.type')).toBe('[symbol]');
    expect(stringAttribute(symbolDraft, 'error.message')).toBe('cart-reconciliation');
  });

  it('describes a null reason as [null] and an absent one not at all', () => {
    dispatchRejection(null);
    dispatchRejectionWithoutReason();

    const drafts = errorDrafts();
    expect(drafts).toHaveLength(2);
    const [nullDraft, absentDraft] = drafts;
    if (nullDraft === undefined || absentDraft === undefined) {
      throw new Error('expected one draft for null and one for an absent reason');
    }

    // `null` is a value the program chose, so it is described…
    expect(stringAttribute(nullDraft, 'error.type')).toBe('[null]');
    expectAbsentAttribute(nullDraft, 'error.message');
    // …while nothing reported at all invents nothing: the event records that a
    // rejection happened and says no more.
    expectAbsentAttribute(absentDraft, 'error.type');
    expectAbsentAttribute(absentDraft, 'error.message');
    expectAbsentAttribute(absentDraft, 'error.stack');
    expect(absentDraft.name).toBe(REJECTION_EVENT_TYPE);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Script errors
 * ---------------------------------------------------------------------------
 */

describe('script errors', () => {
  it('records one error event with the host message and the reported location', () => {
    const dispatched = dispatchScriptError({
      message: 'Uncaught TypeError: cart.items is not iterable',
      filename: SCRIPT_URL,
      lineno: 41,
      colno: 17,
      error: new TypeError('cart.items is not iterable'),
    });

    // Nothing is cancelled: the developer's console report is not the agent's
    // to withhold.
    expect(dispatched).toBe(true);
    const draft = onlyErrorDraft();
    expectWellFormedErrorEvent(draft);
    expect(draft.attributes['errorType']).toBe('error');
    // The host's prefixed sentence wins over the thrown value's message,
    // because that is the line sitting in the developer's console.
    expect(stringAttribute(draft, 'error.message')).toBe(
      'Uncaught TypeError: cart.items is not iterable',
    );
    // The class, the stack and the location still come from the two places
    // that have them.
    expect(draft.name).toBe('TypeError');
    expect(stringAttribute(draft, 'error.type')).toBe('TypeError');
    expect(stringAttribute(draft, 'error.stack')).toContain(
      'TypeError: cart.items is not iterable',
    );
    expect(stringAttribute(draft, 'error.source')).toBe(SCRIPT_URL);
    expect(draft.attributes['error.lineno']).toBe(41);
    expect(draft.attributes['error.colno']).toBe(17);
    expectAbsentAttribute(draft, 'target.tagName');
  });

  it('omits a reported line and column of zero rather than recording them', () => {
    // What a cross-origin script error delivers: a censored message, no
    // location, and `error` at its specified default of `null`.
    dispatchScriptError({
      message: 'Script error.',
      filename: '',
      lineno: 0,
      colno: 0,
      error: null,
    });

    const draft = onlyErrorDraft();
    expectWellFormedErrorEvent(draft);
    expect(stringAttribute(draft, 'error.message')).toBe('Script error.');
    // A zero line would send the developer's editor to the top of a file and
    // present that as the failure site.
    expectAbsentAttribute(draft, 'error.lineno');
    expectAbsentAttribute(draft, 'error.colno');
    expectAbsentAttribute(draft, 'error.source');
    // `null` is the default of `ErrorEvent.error`, not a thrown `null`, so it
    // is not described as `[null]`.
    expectAbsentAttribute(draft, 'error.type');
    expectAbsentAttribute(draft, 'error.stack');
    expect(draft.name).toBe('error');
  });

  it('floors a fractional line and keeps a message a host reports without a thrown value', () => {
    dispatchScriptError({
      message: 'Uncaught (in promise) undefined',
      filename: SCRIPT_URL,
      lineno: 12.9,
      colno: 3.2,
    });

    const draft = onlyErrorDraft();
    expect(draft.attributes['error.lineno']).toBe(12);
    expect(draft.attributes['error.colno']).toBe(3);
    expect(stringAttribute(draft, 'error.message')).toBe('Uncaught (in promise) undefined');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Resource-load failures
 * ---------------------------------------------------------------------------
 */

describe('resource-load failures', () => {
  it('records a failed image as a resource failure with its tag and URL only', () => {
    const image = document.createElement('img');
    image.setAttribute('src', IMAGE_URL);
    image.setAttribute('alt', APP_MESSAGE);

    const dispatched = dispatchResourceError(image);

    expect(dispatched).toBe(true);
    const draft = onlyErrorDraft();
    expectWellFormedErrorEvent(draft);
    expect(draft.attributes['errorType']).toBe('resource');
    // Low cardinality on purpose: every broken image of a capture groups into
    // one row of a table keyed on `name`.
    expect(draft.name).toBe('resource img');
    expect(stringAttribute(draft, 'target.tagName')).toBe('img');
    expect(stringAttribute(draft, 'error.source')).toBe(image.src);
    // Two fields is the whole of it: an element's text and its other
    // attributes explain no failed load and would be application data.
    expect(Object.keys(draft.attributes).sort()).toStrictEqual([
      'error.source',
      'errorType',
      'target.tagName',
    ]);
    expect(draftText(draft)).not.toContain(APP_MESSAGE);
  });

  it('reads href when the element that failed is a stylesheet link', () => {
    const link = document.createElement('link');
    // Deliberately no `rel="stylesheet"`: happy-dom would then really fetch
    // the URL when the element is appended, which this case has no use for —
    // the producer reads the tag name and `href` and nothing else — and which
    // would put a DNS lookup in the middle of a unit test.
    link.setAttribute('href', STYLE_URL);

    dispatchResourceError(link);

    const draft = onlyErrorDraft();
    expect(draft.attributes['errorType']).toBe('resource');
    expect(stringAttribute(draft, 'target.tagName')).toBe('link');
    expect(stringAttribute(draft, 'error.source')).toBe(link.href);
  });

  it('records the failure of an element with no URL to report', () => {
    const script = document.createElement('script');

    dispatchResourceError(script);

    const draft = onlyErrorDraft();
    expect(draft.attributes['errorType']).toBe('resource');
    expect(stringAttribute(draft, 'target.tagName')).toBe('script');
    expectAbsentAttribute(draft, 'error.source');
    expect(draft.name).toBe('resource script');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Bounds, caps and failures
 * ---------------------------------------------------------------------------
 */

describe('bounds', () => {
  it('cuts a message at MAX_MESSAGE_CHARS and says that it cut it', () => {
    dispatchRejection(new Error('m'.repeat(MAX_MESSAGE_CHARS + 64)));

    const draft = onlyErrorDraft();
    expect(stringAttribute(draft, 'error.message')).toHaveLength(MAX_MESSAGE_CHARS);
    // A resolver reading the last frame of a cut stack — or a developer
    // reading a cut sentence — has to know it is cut.
    expect(draft.attributes['error.truncated']).toBe(true);
  });

  it('drops a whole surrogate pair rather than splitting one at the boundary', () => {
    // The pair straddles the bound: its high half is the last code unit the
    // bound would keep.
    const message = `${'m'.repeat(MAX_MESSAGE_CHARS - 1)}\u{1f600}tail`;

    dispatchRejection(new Error(message));

    const bounded = stringAttribute(onlyErrorDraft(), 'error.message');
    expect(bounded).toHaveLength(MAX_MESSAGE_CHARS - 1);
    expect(bounded.endsWith('m')).toBe(true);
    // A lone half is a well-formed JavaScript string and an ill-formed one to
    // send: it survives the page channel's JSON text and becomes a replacement
    // character somewhere downstream.
    const lastUnit = bounded.charCodeAt(bounded.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
    expect(bounded).not.toContain('\ud83d');
  });

  it('cuts a stack at MAX_STACK_CHARS', () => {
    const error = new Error('a recursion overflowed the stack');
    error.stack = `Error: a recursion overflowed the stack\n${'    at loop (page.js:1:1)\n'.repeat(400)}`;
    expect(error.stack.length).toBeGreaterThan(MAX_STACK_CHARS);

    dispatchRejection(error);

    const draft = onlyErrorDraft();
    expect(stringAttribute(draft, 'error.stack')).toHaveLength(MAX_STACK_CHARS);
    expect(draft.attributes['error.truncated']).toBe(true);
    // Nothing is appended: an ellipsis would exceed the bound a caller asked
    // for and corrupt the last frame the resolver reads.
    expect(stringAttribute(draft, 'error.stack').endsWith('…')).toBe(false);
  });

  it('bounds the URL a script error reports', () => {
    const longUrl = `https://app.test/${'q'.repeat(MAX_MESSAGE_CHARS)}.js`;

    dispatchScriptError({ message: 'boom', filename: longUrl, lineno: 2, colno: 2 });

    const draft = onlyErrorDraft();
    expect(stringAttribute(draft, 'error.source')).toHaveLength(MAX_MESSAGE_CHARS);
    expect(draft.attributes['error.truncated']).toBe(true);
  });
});

describe('caps and failures', () => {
  it('stops emitting past MAX_ERRORS_PER_CAPTURE and counts the remainder as drops', () => {
    const excess = 5;
    for (let attempt = 0; attempt < MAX_ERRORS_PER_CAPTURE + excess; attempt += 1) {
      dispatchRejection(new Error(`render loop ${attempt}`));
    }

    // A cap that hid its own effect would understate `error_count`.
    expect(errorDrafts()).toHaveLength(MAX_ERRORS_PER_CAPTURE);
    expect(getErrorStats()).toStrictEqual({
      emitted: MAX_ERRORS_PER_CAPTURE,
      dropped: excess,
      failures: 0,
    });
  });

  it('counts a throwing transport as a failure, without re-throwing or recursing', () => {
    vi.restoreAllMocks();
    const failing = vi.spyOn(transport, 'emit').mockImplementation(() => {
      throw new Error('the transport is broken');
    });

    // Nothing escapes into the page: an exception from here would become
    // another `error` event reaching this same listener.
    expect(() => {
      dispatchRejection(new Error('the page failed and so did the report'));
    }).not.toThrow();

    // Exactly one attempt. A second call would be the first frame of the
    // recursion the re-entrancy guard exists to make impossible.
    expect(failing).toHaveBeenCalledTimes(1);
    expect(getErrorStats()).toStrictEqual({ emitted: 0, dropped: 0, failures: 1 });
  });

  it('counts attempts rather than successes, so a broken transport is capped too', () => {
    vi.restoreAllMocks();
    const failing = vi.spyOn(transport, 'emit').mockImplementation(() => {
      throw new Error('the transport is broken');
    });

    for (let attempt = 0; attempt < MAX_ERRORS_PER_CAPTURE + 3; attempt += 1) {
      dispatchRejection(new Error(`render loop ${attempt}`));
    }

    expect(failing).toHaveBeenCalledTimes(MAX_ERRORS_PER_CAPTURE);
    expect(getErrorStats()).toStrictEqual({
      emitted: 0,
      dropped: 3,
      failures: MAX_ERRORS_PER_CAPTURE,
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Non-interference
 * ---------------------------------------------------------------------------
 */

describe('non-interference with the page', () => {
  it("leaves an application listener registered before the agent's exactly as it was", () => {
    detachErrors();
    let applicationCalls = 0;
    let observedDefaultPrevented: boolean | undefined;
    const applicationListener = (event: Event): void => {
      applicationCalls += 1;
      observedDefaultPrevented = event.defaultPrevented;
    };
    window.addEventListener(ERROR_EVENT_TYPE, applicationListener);
    attachErrors();

    try {
      const dispatched = dispatchScriptError({
        message: 'Uncaught Error: the page reported this itself',
        filename: SCRIPT_URL,
        lineno: 8,
        colno: 1,
        error: new Error('the page reported this itself'),
      });
      expect(dispatched).toBe(true);
    } finally {
      window.removeEventListener(ERROR_EVENT_TYPE, applicationListener);
    }

    // Once, not twice, and not cancelled: the page's own reporting pipeline
    // sees what it always saw.
    expect(applicationCalls).toBe(1);
    expect(observedDefaultPrevented).toBe(false);
    expect(errorDrafts()).toHaveLength(1);
  });

  it('never reads the rejected promise', () => {
    let promiseReads = 0;
    const event = new Event(REJECTION_EVENT_TYPE);
    Object.defineProperty(event, 'reason', { value: new Error('nobody handled this') });
    Object.defineProperty(event, 'promise', {
      get(): never {
        promiseReads += 1;
        throw new Error('event.promise was read');
      },
    });

    window.dispatchEvent(event);

    // Reading it is harmless; the only thing a caller would then do with it —
    // attach a handler — marks the rejection handled and silences the report
    // the developer is waiting for. So it is never read at all.
    expect(promiseReads).toBe(0);
    expect(stringAttribute(onlyErrorDraft(), 'error.message')).toBe('nobody handled this');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Attribution
 * ---------------------------------------------------------------------------
 */

describe('attribution', () => {
  it('emits a synthetic root when no interaction is in flight', () => {
    dispatchRejection(new Error('first'));
    dispatchRejection(new Error('second'));

    const drafts = errorDrafts();
    expect(drafts).toHaveLength(2);
    const [first, second] = drafts;
    if (first === undefined || second === undefined) {
      throw new Error('expected two error drafts');
    }

    // An unattributed failure says only "something broke", which is honest:
    // inventing a parent would put the exception in a trace it did not cause.
    expect(first.parentSpanId).toBeUndefined();
    expect(second.parentSpanId).toBeUndefined();
    expect(first.traceId).not.toBe(second.traceId);
  });

  it('parents the failure on the interaction that was in flight', () => {
    attachInteractions();
    const button = document.createElement('button');
    button.textContent = 'Place order';
    document.body.appendChild(button);

    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    // The capture-phase listener opens the window before the page's own
    // handler runs, which is what makes a failure inside it attributable.
    expect(isInteractionWindowOpen()).toBe(true);
    const active = getActiveInteraction();
    if (active === undefined) {
      throw new Error('expected an open interaction after the click');
    }

    dispatchRejection(new Error('the click handler rejected'));

    const draft = onlyErrorDraft();
    // The assertion that carries the whole value of this signal: the failure
    // appears in the same trace as the click, parented on its span.
    expect(draft.traceId).toBe(active.traceId);
    expect(draft.parentSpanId).toBe(active.spanId);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Lifecycle (AAP 0.5.1)
 * ---------------------------------------------------------------------------
 */

describe('lifecycle', () => {
  it('registers one pair of listeners however often it is attached', () => {
    attachErrors();
    attachErrors();
    expect(isErrorsAttached()).toBe(true);

    dispatchRejection(new Error('boom'));

    // Two registrations would emit two events per failure and double
    // `error_count`.
    expect(errorDrafts()).toHaveLength(1);
  });

  it('does not reset the counters of a capture already in progress', () => {
    dispatchRejection(new Error('first'));
    expect(getErrorStats().emitted).toBe(1);

    // What a re-configuration after a bridge reconnect looks like. A fresh
    // budget here would hand the second half of one capture a second cap.
    attachErrors();
    dispatchRejection(new Error('second'));

    expect(getErrorStats().emitted).toBe(2);
    expect(errorDrafts()).toHaveLength(2);
  });

  it('emits nothing after detach and keeps the capture counters readable', () => {
    dispatchRejection(new Error('before detach'));
    expect(getErrorStats().emitted).toBe(1);

    detachErrors();
    expect(isErrorsAttached()).toBe(false);

    dispatchRejection(new Error('after detach'));
    dispatchScriptError({ message: 'after detach', filename: SCRIPT_URL, lineno: 1, colno: 1 });
    const image = document.createElement('img');
    image.setAttribute('src', IMAGE_URL);
    dispatchResourceError(image);

    // Disabled, not merely idled — and "how many failures did that capture
    // have" is a question asked after the capture stopped.
    expect(errorDrafts()).toHaveLength(1);
    expect(getErrorStats()).toStrictEqual({ emitted: 1, dropped: 0, failures: 0 });
  });

  it('is safe to detach twice and reports itself detached', () => {
    detachErrors();
    expect(() => {
      detachErrors();
    }).not.toThrow();
    expect(isErrorsAttached()).toBe(false);
    expect(errorDrafts()).toHaveLength(0);
  });

  it('gives the next capture a fresh budget at attach', () => {
    dispatchRejection(new Error('first capture'));
    detachErrors();

    attachErrors();
    expect(getErrorStats()).toStrictEqual({ emitted: 0, dropped: 0, failures: 0 });

    dispatchRejection(new Error('second capture'));
    expect(getErrorStats().emitted).toBe(1);
  });

  it('hands the transport a failure only while a capture is armed', () => {
    // The recorder is removed on purpose: the point of this case is that the
    // real `emit` is in the path and that its capture gate decides.
    vi.restoreAllMocks();
    transport.resetTransport();
    transport.configureTransport({ enabled: false });

    dispatchRejection(new Error('the developer is merely browsing'));

    // A dormant agent keeps nothing: no buffer growth and no sequence
    // consumed (AAP 0.5.1).
    expect(transport.getTransportStats().buffered).toBe(0);
    expect(transport.getTransportStats().seq).toBe(0);
    expect(transport.getTransportStats().dropped).toBe(0);
    // The producer still did its work and still says so, which is what makes
    // "the cap was reached" and "there was no capture" different readings.
    expect(getErrorStats()).toStrictEqual({ emitted: 1, dropped: 0, failures: 0 });

    transport.configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_ID, enabled: true });
    dispatchRejection(new Error('the capture is armed'));
    expect(transport.getTransportStats().buffered).toBe(1);
    expect(transport.getTransportStats().seq).toBe(1);
  });
});
