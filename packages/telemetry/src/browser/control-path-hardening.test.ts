/**
 * The page agent against a page script that runs after `document_start`.
 *
 * The agent shares the page's realm, so every script the page ships runs after
 * the agent evaluated and can replace any built-in — `Array.from`, a `Set`
 * method, an iterator, `Function.prototype.call`, `JSON.stringify` — or put an
 * accessor or a `toJSON` on `Object.prototype`. Whatever the agent later hands
 * such a built-in, the page receives. Two consequences are proven absent here:
 *
 * 1. **Forged control.** A page that obtained the handler which applies an
 *    `agent.config` could call it with an all-false configuration and disarm
 *    a capture the service still believes is running. A page whose
 *    replacement answered the parser's questions wrongly (`some` → `false`)
 *    could make every genuine configuration read as "no hooks".
 * 2. **Substituted frames.** A page whose `toJSON`, setter or getter the agent
 *    reached while building or rendering a frame could read the frame or
 *    choose the text the agent itself dispatches on its private node.
 *
 * **How a replacement tells who called it.** happy-dom implements the DOM in
 * JavaScript, so its event dispatch calls `listener.call(…)` and its
 * collections call `Map.prototype.get`: calls Chrome makes natively, which no
 * page can observe. Every replacement here therefore reads its caller from
 * the stack. A call whose nearest source frame is `agent.ts` or `transport.ts`
 * is the **control** path. One from another agent module, or from a
 * dependency the bundle inlines, is a **producer**: the residual this unit
 * states and does not claim to close. Anything else — happy-dom, the fake
 * bridge, vitest, this suite — is passed through untouched. Accessors are
 * the exception: a native dictionary read in Chrome reaches
 * `Object.prototype` exactly as happy-dom's JavaScript read does, so an
 * accessor looks *through* happy-dom frames to the code that called into it.
 *
 * Every replaced built-in is restored in a `finally`, and again in
 * `afterEach`, and nothing is replaced outside the one synchronous window each
 * case opens.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { truncate } from '../redaction/rules.js';
import { bridgeFrameDetail, connectFakeBridge } from './__tests__/page-channel.js';
import type { FakeBridge, RecordedAgentFrame } from './__tests__/page-channel.js';
import { getAgentState } from './agent.js';
import {
  AGENT_SOURCE_TAG,
  BRIDGE_FRAME_EVENT,
  BRIDGE_SOURCE_TAG,
  CHANNEL_VERSION,
  MAX_CONTROL_TEXT_LENGTH,
  boundControlText,
  configureTransport,
  emit,
  emitMany,
  flush,
  reportProducerFailure,
  serializeFrameJson,
  subscribe,
} from './transport.js';
import type { EventDraft } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * The test realm's own built-ins, taken before any case replaces one
 * ---------------------------------------------------------------------------
 */

/** Any function, called with an explicit receiver. */
type Callable = (this: unknown, ...args: unknown[]) => unknown;

/** What a lying replacement answers instead of calling the original. */
type Lie = (receiver: unknown, args: readonly unknown[]) => unknown;

const REAL_APPLY = Reflect.apply as (
  target: Callable,
  receiver: unknown,
  args: readonly unknown[],
) => unknown;
const REAL_DEFINE = Reflect.defineProperty;
const REAL_DELETE = Reflect.deleteProperty;
const REAL_DESCRIPTOR = Reflect.getOwnPropertyDescriptor;
const REAL_PROTOTYPE_OF = Reflect.getPrototypeOf;
const REAL_IS_ARRAY = Reflect.get(Array, 'isArray') as (value: unknown) => boolean;
const RealError = Error;
const RealArray = Array;

/** `%ArrayIteratorPrototype%`, whose `next` every array `for…of` calls. */
const ARRAY_ITERATOR_PROTOTYPE = REAL_PROTOTYPE_OF([][Symbol.iterator]()) as object;

/** `%SetIteratorPrototype%`. */
const SET_ITERATOR_PROTOTYPE = REAL_PROTOTYPE_OF(new Set<unknown>()[Symbol.iterator]()) as object;

/*
 * ---------------------------------------------------------------------------
 * Who called: the stack, read from inside a replacement
 * ---------------------------------------------------------------------------
 */

/** Which code a replaced built-in was called from. */
type Caller = 'control' | 'producer' | 'other';

/** This suite's own frames: the probe, the replacements, the cases. */
const THIS_SUITE = /control-path-hardening\.test\.ts/;

/** A frame with a source location; native frames read `(<anonymous>)`. */
const SOURCE_FRAME = /\.[cm]?[jt]sx?:\d+:\d+\)?$/;

/** The fake bridge and any other suite. */
const TEST_CODE = /\.test\.tsx?:|[/\\]__tests__[/\\]/;

/** happy-dom: the platform, JavaScript here and native in Chrome. */
const PLATFORM_CODE = /[/\\]node_modules[/\\].*happy-dom[/\\]/;

/** Node's own internals (its timers, for one): native in Chrome, and never the page's. */
const NODE_INTERNAL = /\(node:|\bat node:/;

/** A dependency the agent bundle inlines, which runs as producer code. */
const BUNDLED_DEPENDENCY = /[/\\]node_modules[/\\].*[/\\]bippy[/\\]/;

/** The control path: frame receipt, delivery, parsing, arm and disarm. */
const CONTROL_CODE = /[/\\]src[/\\]browser[/\\](?:agent|transport)\.ts:/;

/** Every other module of the agent bundle. */
const PRODUCER_CODE =
  /[/\\]packages[/\\]telemetry[/\\]src[/\\](?:browser|redaction|schema|aggregate|correlation)[/\\][\w-]+\.tsx?:/;

/**
 * Classify the caller of the replacement this is called from.
 *
 * @param throughPlatform Whether happy-dom frames are looked through rather
 * than decisive. Through, for a WebIDL dictionary member such as an event
 * init's `composed`: Chrome's native constructor reads that from the object
 * it was given exactly as happy-dom's JavaScript does, so the page's accessor
 * runs in both. Decisive for everything else: happy-dom's own arrays, maps
 * and `listener.call(…)` are native, and invisible, in Chrome.
 */
function callerOf(throughPlatform: boolean): Caller {
  const limit = RealError.stackTraceLimit;
  RealError.stackTraceLimit = 80;
  let stack: string;
  try {
    stack = new RealError('caller probe').stack ?? '';
  } finally {
    RealError.stackTraceLimit = limit;
  }

  const frames = stack.split('\n');
  for (let index = 1; index < frames.length; index += 1) {
    const frame = frames[index] ?? '';
    if (NODE_INTERNAL.test(frame)) {
      return 'other';
    }
    if (THIS_SUITE.test(frame) || !SOURCE_FRAME.test(frame)) {
      continue;
    }
    if (TEST_CODE.test(frame)) {
      return 'other';
    }
    if (PLATFORM_CODE.test(frame)) {
      if (throughPlatform) {
        continue;
      }
      return 'other';
    }
    if (CONTROL_CODE.test(frame)) {
      return 'control';
    }
    if (PRODUCER_CODE.test(frame) || BUNDLED_DEPENDENCY.test(frame)) {
      return 'producer';
    }
    return 'other';
  }
  return 'other';
}

/*
 * ---------------------------------------------------------------------------
 * The late page script
 * ---------------------------------------------------------------------------
 */

/** One call a replaced built-in received from agent code. */
interface Sighting {
  /** Who made it. */
  readonly caller: Exclude<Caller, 'other'>;
  /** Which built-in. */
  readonly label: string;
  /** Every function it was handed: the receiver, an argument, an array element. */
  readonly functions: readonly Callable[];
  /** Every object it was handed. */
  readonly objects: readonly object[];
}

/** One replaced slot and what it held before. */
interface Slot {
  readonly owner: object;
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor | undefined;
}

const sightings: Sighting[] = [];
const replaced: Slot[] = [];

/** Set while a replacement is doing its own bookkeeping: everything passes through. */
let probing = false;
/** Whether lying replacements lie to the control path in the open window. */
let lying = false;
/** How many lies the control path was told. */
let liesTold = 0;
/** How many calls the replacements received from anyone, for the self-check. */
let replacedCalls = 0;

/**
 * Record what one call handed its built-in.
 *
 * @param owner The namespace a static built-in hangs off (`Math`, `JSON`,
 * `Object`), which is its receiver on every call and not something the caller
 * handed over; `undefined` for a prototype method or an accessor.
 */
function sight(
  caller: Exclude<Caller, 'other'>,
  label: string,
  receiver: unknown,
  args: readonly unknown[],
  owner?: object,
): void {
  const functions: Callable[] = [];
  const objects: object[] = [];
  const consider = (value: unknown): void => {
    if (owner !== undefined && value === owner) {
      return;
    }
    if (typeof value === 'function') {
      functions.push(value as Callable);
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    objects.push(value);
    if (!REAL_IS_ARRAY(value)) {
      return;
    }
    const length: unknown = REAL_DESCRIPTOR(value, 'length')?.value;
    const count = typeof length === 'number' && length < 256 ? length : 256;
    for (let index = 0; index < count; index += 1) {
      const element: unknown = REAL_DESCRIPTOR(value, index)?.value;
      if (typeof element === 'function') {
        functions.push(element as Callable);
      }
    }
  };
  consider(receiver);
  for (let index = 0; index < args.length; index += 1) {
    consider(args[index]);
  }
  sightings.push({ caller, label, functions, objects });
}

/**
 * Classify the current caller and record the call if it is agent code, with
 * every replacement passing through while the bookkeeping runs.
 *
 * @returns The caller.
 */
function sightAgentCaller(
  throughPlatform: boolean,
  label: string,
  receiver: unknown,
  args: readonly unknown[],
): Caller {
  probing = true;
  try {
    const caller = callerOf(throughPlatform);
    if (caller !== 'other') {
      sight(caller, label, receiver, args);
    }
    return caller;
  } finally {
    probing = false;
  }
}

/** A replacement that records agent callers and, while lying, answers the control path wrongly. */
function spy(label: string, owner: object, original: Callable, lie: Lie | undefined): Callable {
  return function replacement(this: unknown, ...args: unknown[]): unknown {
    replacedCalls += 1;
    if (probing) {
      return REAL_APPLY(original, this, args);
    }
    let lied = false;
    let answer: unknown;
    probing = true;
    try {
      const caller = callerOf(false);
      if (caller !== 'other') {
        sight(caller, label, this, args, owner);
        if (lying && caller === 'control' && lie !== undefined) {
          lied = true;
          liesTold += 1;
          answer = lie(this, args);
        }
      }
    } finally {
      probing = false;
    }
    return lied ? answer : REAL_APPLY(original, this, args);
  };
}

/** Replace one method with a {@link spy}. */
function replaceMethod(owner: object, key: PropertyKey, label: string, lie?: Lie): void {
  const descriptor = REAL_DESCRIPTOR(owner, key);
  const original: unknown = descriptor?.value;
  if (descriptor === undefined || typeof original !== 'function') {
    throw new RealError(`${label} is not a method this suite can replace`);
  }
  replaced.push({ owner, key, descriptor });
  REAL_DEFINE(owner, key, {
    configurable: true,
    enumerable: descriptor.enumerable ?? false,
    writable: true,
    value: spy(label, owner, original as Callable, lie),
  });
}

/**
 * Put an accessor on a prototype that the agent's code would reach by reading
 * or writing a key an object lacks.
 *
 * To agent code it answers `forged()` and swallows writes, which is what a
 * hostile page does. Everyone else sees an absent key: reads answer
 * `undefined` and writes create the own property they would have created.
 *
 * @param dictionaryMember Whether the key is a WebIDL dictionary member the
 * platform reads from an object the agent hands it (see {@link callerOf}).
 */
function pollutePrototype(
  owner: object,
  key: string,
  label: string,
  forged: (caller: Exclude<Caller, 'other'>) => unknown,
  dictionaryMember = false,
): void {
  replaced.push({ owner, key, descriptor: REAL_DESCRIPTOR(owner, key) });
  REAL_DEFINE(owner, key, {
    configurable: true,
    enumerable: false,
    get(this: unknown): unknown {
      if (probing) {
        return undefined;
      }
      const caller = sightAgentCaller(dictionaryMember, `${label} (read)`, this, []);
      return caller === 'other' ? undefined : forged(caller);
    },
    set(this: unknown, value: unknown): void {
      const caller: Caller = probing
        ? 'other'
        : sightAgentCaller(dictionaryMember, `${label} (write)`, this, [value]);
      if (caller === 'other' && typeof this === 'object' && this !== null) {
        REAL_DEFINE(this, key, { configurable: true, enumerable: true, writable: true, value });
      }
    },
  });
}

/** Put back everything a case replaced, newest first. */
function restoreBuiltIns(): void {
  probing = true;
  try {
    for (let index = replaced.length - 1; index >= 0; index -= 1) {
      const slot = replaced[index];
      if (slot === undefined) {
        continue;
      }
      if (slot.descriptor === undefined) {
        REAL_DELETE(slot.owner, slot.key);
      } else {
        REAL_DEFINE(slot.owner, slot.key, slot.descriptor);
      }
    }
    replaced.length = 0;
  } finally {
    probing = false;
  }
}

const NOTHING: Lie = () => undefined;
const NONE: Lie = () => [];
const NO: Lie = () => false;
const YES: Lie = () => true;
const SELF: Lie = (receiver) => receiver;
const DONE: Lie = () => ({ value: undefined, done: true });
const EMPTY_ITERATOR: Lie = () => ({ next: () => ({ value: undefined, done: true }) });
const LENGTH_UNCHANGED: Lie = (receiver) =>
  typeof receiver === 'object' && receiver !== null ? Reflect.get(receiver, 'length') : 0;

/**
 * Replace, as a page script evaluated after the agent would, the built-ins a
 * control path could consult: `Array.from` and `Array.isArray`; the query,
 * iteration and mutation methods of `Array.prototype`, `Set.prototype` and
 * `Map.prototype`, and the array and set iterators' `next`;
 * `Function.prototype.call`, `apply` and `bind`; the `Number` integer and
 * finiteness predicates; the `Object` enumeration and reflection statics;
 * `JSON.parse` and `JSON.stringify`; and `Math.min`, `max`, `ceil` and
 * `floor`. `Math.round` is replaced without a stub (see below).
 *
 * Every replacement records the agent code that calls it and, in a window
 * that lies, answers a control-path caller with its stub instead of the
 * built-in's result. Each stub is the wrong answer that would mislead an
 * implementation that consulted it: `Array.prototype.some` → false would read
 * every hook as off, an empty iterator would arm nothing, `Set.prototype.has`
 * → false would retry a failed family, and `Function.prototype.call` → a
 * no-op would drop a subscriber's delivery.
 *
 * The agent's control path — frame receipt, subscriber delivery,
 * configuration parsing and the arm/disarm decisions — runs only on
 * intrinsics captured at evaluation, so none of these replacements changes
 * what it decides.
 */
function installLatePageScript(): void {
  probing = true;
  try {
    replaceMethod(Array, 'from', 'Array.from', NONE);
    replaceMethod(Array, 'isArray', 'Array.isArray', YES);

    const arrayPrototype: object = RealArray.prototype;
    replaceMethod(arrayPrototype, 'some', 'Array.prototype.some', NO);
    replaceMethod(arrayPrototype, 'every', 'Array.prototype.every', NO);
    replaceMethod(arrayPrototype, 'filter', 'Array.prototype.filter', NONE);
    replaceMethod(arrayPrototype, 'map', 'Array.prototype.map', NONE);
    replaceMethod(arrayPrototype, 'forEach', 'Array.prototype.forEach', NOTHING);
    replaceMethod(arrayPrototype, 'push', 'Array.prototype.push', LENGTH_UNCHANGED);
    replaceMethod(arrayPrototype, 'reverse', 'Array.prototype.reverse', SELF);
    replaceMethod(arrayPrototype, 'slice', 'Array.prototype.slice', NONE);
    replaceMethod(arrayPrototype, 'concat', 'Array.prototype.concat', NONE);
    replaceMethod(arrayPrototype, 'join', 'Array.prototype.join', () => 'forged');
    replaceMethod(arrayPrototype, 'includes', 'Array.prototype.includes', NO);
    replaceMethod(arrayPrototype, 'indexOf', 'Array.prototype.indexOf', () => -1);
    replaceMethod(
      arrayPrototype,
      Symbol.iterator,
      'Array.prototype[Symbol.iterator]',
      EMPTY_ITERATOR,
    );
    replaceMethod(arrayPrototype, 'values', 'Array.prototype.values', EMPTY_ITERATOR);
    replaceMethod(arrayPrototype, 'keys', 'Array.prototype.keys', EMPTY_ITERATOR);
    replaceMethod(arrayPrototype, 'entries', 'Array.prototype.entries', EMPTY_ITERATOR);
    replaceMethod(ARRAY_ITERATOR_PROTOTYPE, 'next', '%ArrayIteratorPrototype%.next', DONE);

    const setPrototype: object = Set.prototype;
    replaceMethod(setPrototype, 'add', 'Set.prototype.add', SELF);
    replaceMethod(setPrototype, 'delete', 'Set.prototype.delete', NO);
    replaceMethod(setPrototype, 'clear', 'Set.prototype.clear', NOTHING);
    replaceMethod(setPrototype, 'has', 'Set.prototype.has', NO);
    replaceMethod(setPrototype, 'forEach', 'Set.prototype.forEach', NOTHING);
    replaceMethod(setPrototype, Symbol.iterator, 'Set.prototype[Symbol.iterator]', EMPTY_ITERATOR);
    replaceMethod(setPrototype, 'values', 'Set.prototype.values', EMPTY_ITERATOR);
    replaceMethod(setPrototype, 'keys', 'Set.prototype.keys', EMPTY_ITERATOR);
    replaceMethod(setPrototype, 'entries', 'Set.prototype.entries', EMPTY_ITERATOR);
    replaceMethod(SET_ITERATOR_PROTOTYPE, 'next', '%SetIteratorPrototype%.next', DONE);

    const mapPrototype: object = Map.prototype;
    replaceMethod(mapPrototype, 'get', 'Map.prototype.get', NOTHING);
    replaceMethod(mapPrototype, 'set', 'Map.prototype.set', SELF);
    replaceMethod(mapPrototype, 'has', 'Map.prototype.has', NO);
    replaceMethod(mapPrototype, 'delete', 'Map.prototype.delete', NO);
    replaceMethod(mapPrototype, 'clear', 'Map.prototype.clear', NOTHING);

    const functionPrototype: object = Function.prototype;
    replaceMethod(functionPrototype, 'call', 'Function.prototype.call', NOTHING);
    replaceMethod(functionPrototype, 'apply', 'Function.prototype.apply', NOTHING);
    replaceMethod(functionPrototype, 'bind', 'Function.prototype.bind', () => NOTHING);

    replaceMethod(Number, 'isSafeInteger', 'Number.isSafeInteger', NO);
    replaceMethod(Number, 'isFinite', 'Number.isFinite', NO);
    replaceMethod(Number, 'isInteger', 'Number.isInteger', NO);

    replaceMethod(Object, 'keys', 'Object.keys', NONE);
    replaceMethod(Object, 'values', 'Object.values', NONE);
    replaceMethod(Object, 'entries', 'Object.entries', NONE);
    replaceMethod(Object, 'getOwnPropertyDescriptor', 'Object.getOwnPropertyDescriptor', NOTHING);
    replaceMethod(Object, 'getPrototypeOf', 'Object.getPrototypeOf', () => null);
    replaceMethod(Object, 'hasOwn', 'Object.hasOwn', NO);

    replaceMethod(JSON, 'parse', 'JSON.parse', () => ({}));
    replaceMethod(JSON, 'stringify', 'JSON.stringify', () => '{"forged":true}');

    replaceMethod(Math, 'min', 'Math.min', () => 0);
    replaceMethod(Math, 'max', 'Math.max', () => 0);
    replaceMethod(Math, 'ceil', 'Math.ceil', () => 0);
    replaceMethod(Math, 'floor', 'Math.floor', () => 0);
    // Observed, never lied about: the transport rounds timestamps with it,
    // which is the self-check that a control-path caller is recognised at all.
    replaceMethod(Math, 'round', 'Math.round');
  } finally {
    probing = false;
  }
}

/** Every wire flag alias, which a parser reading inherited keys would pick up. */
const CONFIG_ALIASES: readonly string[] = [
  'interactions',
  'interaction',
  'react',
  'reactRenders',
  'renders',
  'state',
  'stateTransitions',
  'fetch',
  'network',
  'fetchTracking',
  'perf',
  'performance',
  'perfTracking',
  'errors',
  'error',
  'componentTree',
  'componentTreeSnapshot',
  'componentTreeTracking',
];

/**
 * Answer every configuration key the payload does not carry, on
 * `Object.prototype`, with a forged value — to agent code only.
 *
 * A parser that read the payload as an ordinary object would see these
 * wherever the bridge sent nothing: every flag on, a different capture, other
 * tree bounds.
 */
function polluteConfigKeys(): void {
  probing = true;
  try {
    const objectPrototype: object = Object.prototype;
    const forgedFor = (value: unknown) => (caller: Exclude<Caller, 'other'>) =>
      caller === 'control' ? value : undefined;
    pollutePrototype(
      objectPrototype,
      'captureId',
      'Object.prototype.captureId',
      forgedFor('cap-forged'),
    );
    pollutePrototype(
      objectPrototype,
      'sessionId',
      'Object.prototype.sessionId',
      forgedFor('sess-forged'),
    );
    pollutePrototype(objectPrototype, 'debug', 'Object.prototype.debug', forgedFor(true));
    pollutePrototype(objectPrototype, 'maxNodes', 'Object.prototype.maxNodes', forgedFor(7));
    pollutePrototype(objectPrototype, 'maxDepth', 'Object.prototype.maxDepth', forgedFor(3));
    pollutePrototype(
      objectPrototype,
      'maxTreeNodes',
      'Object.prototype.maxTreeNodes',
      forgedFor(7),
    );
    for (let index = 0; index < CONFIG_ALIASES.length; index += 1) {
      const alias = CONFIG_ALIASES[index];
      if (alias !== undefined) {
        pollutePrototype(objectPrototype, alias, `Object.prototype.${alias}`, forgedFor(true));
      }
    }
  } finally {
    probing = false;
  }
}

/**
 * Open one window with the late page script's built-ins in place, run the
 * action inside it, and close it whatever happens.
 */
function withLatePageScript(
  options: { lie: boolean; configKeys: boolean },
  action: () => void,
): void {
  sightings.length = 0;
  liesTold = 0;
  replacedCalls = 0;
  lying = options.lie;
  if (options.configKeys) {
    polluteConfigKeys();
  }
  installLatePageScript();
  try {
    action();
  } finally {
    restoreBuiltIns();
    lying = false;
  }
}

/*
 * ---------------------------------------------------------------------------
 * The agent, the bridge and the configurations
 * ---------------------------------------------------------------------------
 */

/**
 * The fake bridge on the agent's channel node. `./agent.js` subscribed when it
 * was imported above, so the handshake here is the document's one.
 */
const bridge: FakeBridge = connectFakeBridge({ subscribe });

/** A genuine configuration that exercises aliases, nested and flat bounds. */
const GENUINE = {
  sessionId: 'sess-hardening',
  captureId: 'cap-hardening',
  hooks: {
    interaction: true,
    network: true,
    error: true,
    stateTransitions: true,
    componentTree: true,
    react: false,
    perf: false,
  },
  maxTreeDepth: 12,
  tree: { maxNodes: 200 },
};

/** What the agent must publish for {@link GENUINE}. */
const GENUINE_PUBLISHED = {
  sessionId: 'sess-hardening',
  captureId: 'cap-hardening',
  hooks: {
    interactions: true,
    react: false,
    state: true,
    fetch: true,
    perf: false,
    errors: true,
    componentTree: true,
  },
  enabled: ['interactions', 'state', 'fetch', 'errors', 'componentTree'],
  debug: false,
  tree: { maxNodes: 200, maxDepth: 12 },
};

/** The configuration that disarms {@link GENUINE}: every flag off. */
const ALL_FALSE = {
  sessionId: GENUINE.sessionId,
  captureId: GENUINE.captureId,
  hooks: {
    interactions: false,
    react: false,
    state: false,
    fetch: false,
    perf: false,
    errors: false,
    componentTree: false,
  },
};

/** The genuine frame's `detail`, rendered before any window opens. */
const GENUINE_DETAIL = bridgeFrameDetail('agent.config', GENUINE);

/** A 32-hex trace id. */
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

/** Return the agent to dormant through the channel, as the bridge does. */
function toDormant(): void {
  expect(bridge.send('agent.config', {})).toBe(true);
  expect(getAgentState().armed).toBe(false);
  bridge.clear();
}

/** `window.__DEBUGGEN__.config`, as JSON text. */
function publishedConfigText(): string | undefined {
  const helper: unknown = Reflect.get(globalThis, '__DEBUGGEN__');
  const config: unknown =
    typeof helper === 'object' && helper !== null ? Reflect.get(helper, 'config') : undefined;
  return JSON.stringify(config);
}

/** The payloads of the `telemetry.batch` frames received so far. */
function batchFrames(): RecordedAgentFrame[] {
  return bridge.framesOfType('telemetry.batch');
}

/** A draft whose every field is fixed, so its batch text is reproducible. */
function fixedDraft(index: number, extra: Partial<EventDraft> = {}): EventDraft {
  return {
    id: `evt_hardening${String(index)}`,
    traceId: TRACE_ID,
    spanId: `00f067aa0ba902b${String(index)}`,
    kind: 'render',
    name: `render "quoted" \\ ${String(index)}`,
    startTime: 1_700_000_000_000.25 + index,
    duration: 1.23456,
    status: 'ok',
    attributes: {
      nested: { list: [1, 'two', null, { deep: true }] },
      text: 'line\nbreak \u2028 end',
      count: index,
    },
    ...extra,
  };
}

afterEach(() => {
  restoreBuiltIns();
  lying = false;
  configureTransport({ enabled: false });
  bridge.claim = true;
  toDormant();
});

/*
 * ---------------------------------------------------------------------------
 * 1. Forged control
 * ---------------------------------------------------------------------------
 */

describe('a late page script and the control path', () => {
  it('never receives an agent function or the configuration during a genuine agent.config delivery', () => {
    toDormant();

    withLatePageScript({ lie: false, configKeys: false }, () => {
      expect(bridge.sendDetail(GENUINE_DETAIL)).toBe(true);
      // Every stamped timestamp is rounded, through the observed
      // `Math.round`: the self-check below.
      emit({ ...fixedDraft(0), id: 'evt_roundprobe', startTime: 1_700_000_000_000.0625 });
    });

    // Self-checks: the replacements were live, and a call from the control
    // path is recognised as one.
    expect(replacedCalls).toBeGreaterThan(0);
    expect(
      sightings.some((entry) => entry.caller === 'control' && entry.label === 'Math.round'),
    ).toBe(true);

    const control = sightings.filter((entry) => entry.caller === 'control');
    // The only built-in the control path calls takes and returns numbers.
    expect(control.map((entry) => entry.label).filter((label) => label !== 'Math.round')).toEqual(
      [],
    );
    expect(control.flatMap((entry) => entry.functions)).toEqual([]);
    expect(control.flatMap((entry) => entry.objects)).toEqual([]);

    const genuineState = getAgentState();
    const genuineConfig = publishedConfigText();
    expect(genuineState.armed).toBe(true);
    expect(JSON.parse(genuineConfig ?? 'null')).toEqual(GENUINE_PUBLISHED);

    // Every function any replacement saw — the producers' included — called
    // with every forged all-false shape a page could build.
    const forgedShapes: readonly unknown[] = [
      {},
      ALL_FALSE,
      { type: 'agent.config', payload: {} },
      { type: 'agent.config', payload: ALL_FALSE },
      {
        source: BRIDGE_SOURCE_TAG,
        version: CHANNEL_VERSION,
        type: 'agent.config',
        payload: ALL_FALSE,
      },
      bridgeFrameDetail('agent.config', ALL_FALSE),
      new CustomEvent(BRIDGE_FRAME_EVENT, {
        detail: bridgeFrameDetail('agent.config', ALL_FALSE),
        cancelable: true,
      }),
    ];
    const seen = new Set<Callable>(sightings.flatMap((entry) => entry.functions));
    for (const handed of seen) {
      for (const shape of forgedShapes) {
        try {
          const result = REAL_APPLY(handed, undefined, [shape]);
          if (result instanceof Promise) {
            result.catch(() => undefined);
          }
        } catch {
          // A function that refuses the shape has done nothing with it.
        }
      }
    }

    expect(getAgentState().armed).toBe(true);
    expect(publishedConfigText()).toBe(genuineConfig);

    // And the transport still stamps the genuine capture.
    bridge.clear();
    emit(fixedDraft(1));
    flush();
    const batches = batchFrames();
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.at(-1)?.payload['captureId']).toBe(GENUINE.captureId);
    expect(batches.at(-1)?.payload['sessionId']).toBe(GENUINE.sessionId);
  });

  it('parses and arms a genuine configuration identically when those built-ins answer wrongly', () => {
    toDormant();
    expect(bridge.sendDetail(GENUINE_DETAIL)).toBe(true);
    const reference = { state: getAgentState(), config: publishedConfigText() };
    expect(JSON.parse(reference.config ?? 'null')).toEqual(GENUINE_PUBLISHED);
    toDormant();

    withLatePageScript({ lie: true, configKeys: true }, () => {
      expect(bridge.sendDetail(GENUINE_DETAIL)).toBe(true);
    });

    // The lying built-ins were live — the fake bridge and happy-dom went
    // through them — and nothing on the control path asked them anything.
    expect(replacedCalls).toBeGreaterThan(0);
    expect(liesTold).toBe(0);
    expect(sightings.filter((entry) => entry.caller === 'control')).toEqual([]);
    expect(getAgentState()).toEqual(reference.state);
    expect(publishedConfigText()).toBe(reference.config);

    // The same built-ins answering wrongly cannot stop the disarm either.
    withLatePageScript({ lie: true, configKeys: true }, () => {
      expect(bridge.sendDetail(bridgeFrameDetail('agent.config', ALL_FALSE))).toBe(true);
    });
    expect(liesTold).toBe(0);
    expect(getAgentState().armed).toBe(false);
    expect(JSON.parse(publishedConfigText() ?? 'null')).toMatchObject({
      captureId: GENUINE.captureId,
      enabled: [],
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * 2. Substituted frames
 * ---------------------------------------------------------------------------
 */

/** A batch a page would rather the agent sent. */
const FORGED_BATCH_FRAME = {
  forged: true,
  source: AGENT_SOURCE_TAG,
  version: CHANNEL_VERSION,
  type: 'telemetry.batch',
  payload: { events: [], producerId: 'prd_forged', documentId: 'doc_forged', batchSeq: 0 },
};

/** Whether a value is the root of a `telemetry.batch` frame the agent built. */
function isAgentBatchFrame(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const type: unknown = REAL_DESCRIPTOR(value, 'type')?.value;
  const source: unknown = REAL_DESCRIPTOR(value, 'source')?.value;
  return (
    type === 'telemetry.batch' &&
    source === AGENT_SOURCE_TAG &&
    REAL_DESCRIPTOR(value, 'forged') === undefined
  );
}

/** Install a `toJSON` that substitutes the batch for agent code and is inert otherwise. */
function polluteToJSON(owner: object, label: string): void {
  replaced.push({ owner, key: 'toJSON', descriptor: REAL_DESCRIPTOR(owner, 'toJSON') });
  REAL_DEFINE(owner, 'toJSON', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function toJSON(this: unknown): unknown {
      if (probing) {
        return this;
      }
      const caller = sightAgentCaller(false, label, this, []);
      return caller !== 'other' && isAgentBatchFrame(this) ? FORGED_BATCH_FRAME : this;
    },
  });
}

/**
 * Replace the global `Array` with a constructor that records agent callers,
 * as `window.Array = …` in a page script would.
 */
function replaceArrayConstructor(): void {
  const descriptor = REAL_DESCRIPTOR(globalThis, 'Array');
  replaced.push({ owner: globalThis, key: 'Array', descriptor });
  const record = (args: readonly unknown[]): void => {
    if (!probing) {
      sightAgentCaller(false, 'Array (global)', undefined, args);
    }
  };
  const substitute = new Proxy(RealArray, {
    construct(target, args: unknown[], newTarget: new (...a: unknown[]) => unknown): object {
      record(args);
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, receiver: unknown, args: unknown[]): unknown {
      record(args);
      return REAL_APPLY(target, receiver, args);
    },
  });
  REAL_DEFINE(globalThis, 'Array', {
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    writable: true,
    value: substitute,
  });
}

/**
 * The page's pollution of the outbound path: `toJSON` on both prototypes,
 * hostile accessors on the keys a frame is extended with, an index accessor
 * on `Array.prototype`, and a replaced `Array`.
 */
function polluteOutboundPath(): void {
  probing = true;
  try {
    const objectPrototype: object = Object.prototype;
    polluteToJSON(objectPrototype, 'Object.prototype.toJSON');
    polluteToJSON(RealArray.prototype, 'Array.prototype.toJSON');
    const forged = (value: unknown) => (): unknown => value;
    pollutePrototype(
      objectPrototype,
      'captureId',
      'Object.prototype.captureId',
      forged('cap-forged'),
    );
    pollutePrototype(
      objectPrototype,
      'sessionId',
      'Object.prototype.sessionId',
      forged('sess-forged'),
    );
    pollutePrototype(objectPrototype, 'id', 'Object.prototype.id', forged('evt_forged'));
    pollutePrototype(
      objectPrototype,
      'parentSpanId',
      'Object.prototype.parentSpanId',
      forged('ffffffffffffffff'),
    );
    pollutePrototype(
      objectPrototype,
      'source',
      'Object.prototype.source',
      forged({ file: 'forged.ts', line: 1 }),
    );
    // The event constructor reads `composed` from the init dictionary: a
    // getter here is where the frame's text would be read from.
    pollutePrototype(
      objectPrototype,
      'composed',
      'Object.prototype.composed',
      forged(undefined),
      true,
    );
    pollutePrototype(RealArray.prototype, '0', 'Array.prototype[0]', forged(undefined));
    replaceArrayConstructor();
  } finally {
    probing = false;
  }
}

/** The capture the byte-identity cases arm, one hook, so nothing else emits. */
const QUIET_CAPTURE = {
  sessionId: 'sess-frames',
  captureId: 'cap-frames',
  hooks: { interactions: true },
};
const QUIET_CAPTURE_DETAIL = bridgeFrameDetail('agent.config', QUIET_CAPTURE);

/** Drafts covering both optional members present and absent. */
function outboundDrafts(): EventDraft[] {
  return [
    fixedDraft(1),
    fixedDraft(2, {
      parentSpanId: '00f067aa0ba90201',
      source: {
        file: 'src/app/page.tsx',
        line: 12,
        column: 3,
        resolvedBy: 'source-map',
        confidence: 1,
      },
    }),
    fixedDraft(3),
  ];
}

/** Arm the quiet capture, emit the drafts one by one and in a run, flush. */
function captureOutbound(drafts: readonly EventDraft[]): void {
  expect(bridge.sendDetail(QUIET_CAPTURE_DETAIL)).toBe(true);
  const [first, ...rest] = drafts;
  if (first !== undefined) {
    emit(first);
  }
  emitMany(rest);
  flush();
}

describe('a late page script and the outbound frames', () => {
  it('never has its toJSON, setters or getters called, and the batch text is byte-identical', () => {
    toDormant();
    const drafts = outboundDrafts();
    const extraDrafts = outboundDrafts();

    captureOutbound(drafts);
    const reference = batchFrames().map((frame) => frame.detail);
    expect(reference.length).toBeGreaterThan(0);
    toDormant();

    sightings.length = 0;
    polluteOutboundPath();
    try {
      captureOutbound(extraDrafts);
    } finally {
      restoreBuiltIns();
    }

    expect(sightings.filter((entry) => entry.caller === 'control')).toEqual([]);
    expect(batchFrames().map((frame) => frame.detail)).toEqual(reference);
    for (const frame of bridge.frames) {
      expect(frame.detail).not.toContain('forged');
    }
  });

  it('mints an id for a draft without one, whatever Object.prototype.id answers', () => {
    toDormant();
    expect(bridge.sendDetail(QUIET_CAPTURE_DETAIL)).toBe(true);
    const { id: omitted, ...withoutId } = fixedDraft(4);
    expect(omitted).toBeDefined();

    sightings.length = 0;
    polluteOutboundPath();
    try {
      emit(withoutId);
      flush();
    } finally {
      restoreBuiltIns();
    }

    expect(sightings.filter((entry) => entry.caller === 'control')).toEqual([]);
    const events = batchFrames().at(-1)?.payload['events'];
    expect(Array.isArray(events)).toBe(true);
    const [event] = events as readonly Record<string, unknown>[];
    expect(event?.['id']).toMatch(/^evt_[A-Za-z0-9_-]+$/);
    expect(event?.['id']).not.toBe('evt_forged');
  });

  it('carries a page-supplied toJSON as data and never calls it', () => {
    toDormant();
    expect(bridge.sendDetail(QUIET_CAPTURE_DETAIL)).toBe(true);

    let toJsonCalls = 0;
    let getterReads = 0;
    class WithToJSON {
      readonly field = 2;
      toJSON(): string {
        toJsonCalls += 1;
        return 'from the page';
      }
    }
    const ownToJson = {
      value: 1,
      toJSON(): string {
        toJsonCalls += 1;
        return 'from the page';
      },
    };
    const withGetter = { plain: 1 };
    Object.defineProperty(withGetter, 'computed', {
      enumerable: true,
      get(): string {
        getterReads += 1;
        return 'read once';
      },
    });

    emit(fixedDraft(5, { attributes: { ownToJson, instance: new WithToJSON(), withGetter } }));
    flush();

    expect(toJsonCalls).toBe(0);
    // The sanitizer copies a page-supplied own getter's value, once; the
    // serializer never runs it.
    expect(getterReads).toBe(1);
    const events = batchFrames().at(-1)?.payload['events'] as readonly Record<string, unknown>[];
    expect(events[0]?.['attributes']).toEqual({
      ownToJson: { value: 1, toJSON: '[function]' },
      instance: '[object]',
      withGetter: { plain: 1, computed: 'read once' },
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * 3. The serializer and the text bounds
 * ---------------------------------------------------------------------------
 */

/** A null-prototype record with the given members. */
function nullRecord(members: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, members);
}

/** Arrays nested `levels` deep: `[[…[]…]]`. */
function nestedArrays(levels: number): unknown[] {
  let value: unknown[] = [];
  for (let level = 1; level < levels; level += 1) {
    value = [value];
  }
  return value;
}

/** An array with a hole at index 1. */
function sparseArray(): unknown[] {
  const sparse: unknown[] = [1];
  sparse[2] = 3;
  return sparse;
}

/** A representative `telemetry.batch` frame, built the way the transport builds one. */
const BATCH_FRAME_SAMPLE = {
  source: AGENT_SOURCE_TAG,
  version: CHANNEL_VERSION,
  type: 'telemetry.batch',
  payload: {
    events: [
      {
        id: 'evt_sample',
        traceId: TRACE_ID,
        spanId: '00f067aa0ba902b7',
        parentSpanId: '00f067aa0ba902b6',
        kind: 'interaction',
        name: 'click "Add to cart" \\ \u2028',
        startTime: 1_700_000_000_000.125,
        duration: 12.5,
        tier: 'browser',
        attributes: {
          selector: 'button[data-id="42"]',
          changedProps: [
            { name: 'count', previous: { type: 'number', preview: '1', truncated: false } },
          ],
          empty: [],
          lone: '\uD800\uDFFF\uDFFF',
        },
        status: 'ok',
        producerId: 'prd_sample',
        seq: 0,
        source: { file: 'src/app/page.tsx', line: 12, column: 3 },
      },
    ],
    producerId: 'prd_sample',
    documentId: 'doc_sample',
    batchSeq: 3,
    droppedCount: 0,
    captureId: 'cap_sample',
    sessionId: 'sess_sample',
  },
};

/** A representative `agent.error` frame. */
const ERROR_FRAME_SAMPLE = {
  source: AGENT_SOURCE_TAG,
  version: CHANNEL_VERSION,
  type: 'agent.error',
  payload: {
    code: 'agent-family-unavailable',
    message: 'the page agent could not arm: react, perf',
    sessionId: null,
    captureId: 'cap_sample',
    families: [{ family: 'react', reason: 'attach-failed', hint: 'reload the page' }],
    enabled: [],
  },
};

/** JSON-shaped values whose rendering must equal `JSON.stringify`'s, byte for byte. */
const SERIALIZER_CORPUS: readonly unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  1,
  -1.5,
  0.1 + 0.2,
  1e21,
  1e-7,
  5e-324,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '',
  'plain',
  'say "hi"',
  'back\\slash',
  'controls \u0000\u0001\u0008\u0009\u000a\u000b\u000c\u000d\u001f\u007f',
  'separators \u2028\u2029',
  'lone high \uD800 surrogate',
  'lone low \uDFFF surrogate',
  'pair \uD83D\uDE00 and reversed \uDE00\uD83D',
  '</script><!--',
  'ümlaut ☃ 中文',
  [],
  [1, 'two', null, true],
  [undefined, () => 1, Symbol('in an array')],
  sparseArray(),
  nestedArrays(8),
  {},
  { a: undefined, b: () => 1, c: Symbol('in an object'), d: 'kept' },
  { nested: { list: [1, { x: 'y' }, [[]]] } },
  { b: 1, 2: 'two', a: 3, 1: 'one' },
  { '"quoted"': 1, 'line\nbreak': 2, '\u2028': 3, '': 4, '\uD800': 5 },
  nullRecord({ a: 1, nested: nullRecord({ b: [2] }) }),
  BATCH_FRAME_SAMPLE,
  ERROR_FRAME_SAMPLE,
  nestedArrays(64),
];

/**
 * The reference bound for a failure-report field, run on the platform's own
 * built-ins: iterate code points, replace C0 controls and DEL with a space,
 * stop at 64 code units, trim. The agent's page-proof implementation must
 * produce the same text for every input.
 */
function referenceBoundFailureField(value: string): string {
  let cleaned = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f ? ' ' : character;
    if (cleaned.length >= 64) {
      break;
    }
  }
  return cleaned.trim();
}

describe('serializeFrameJson', () => {
  it('renders every JSON-shaped value exactly as JSON.stringify does', () => {
    for (const value of SERIALIZER_CORPUS) {
      expect(serializeFrameJson(value)).toBe(JSON.stringify(value));
    }
  });

  it('refuses what JSON cannot spell, as JSON.stringify does, and bounds the nesting', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(() => JSON.stringify(cyclic)).toThrow(TypeError);
    expect(() => serializeFrameJson(cyclic)).toThrow(TypeError);

    expect(() => JSON.stringify({ n: 1n })).toThrow(TypeError);
    expect(() => serializeFrameJson({ n: 1n })).toThrow(TypeError);

    // No rendering at the top level: `JSON.stringify` answers `undefined`.
    for (const bare of [undefined, () => 1, Symbol('bare')]) {
      expect(JSON.stringify(bare)).toBeUndefined();
      expect(() => serializeFrameJson(bare)).toThrow(TypeError);
    }

    // Sixty-four levels render; the sixty-fifth is a refused frame rather than
    // a stack the page chose the depth of.
    expect(serializeFrameJson(nestedArrays(64))).toBe(JSON.stringify(nestedArrays(64)));
    expect(() => serializeFrameJson(nestedArrays(65))).toThrow(RangeError);
  });

  it('never runs a getter or a toJSON, own or inherited', () => {
    let calls = 0;
    const withGetter = { plain: 1 };
    Object.defineProperty(withGetter, 'secret', {
      enumerable: true,
      get(): string {
        calls += 1;
        return 'leaked';
      },
    });
    const listWithGetter: unknown[] = [1];
    Object.defineProperty(listWithGetter, 1, {
      enumerable: true,
      get(): string {
        calls += 1;
        return 'leaked';
      },
    });
    const ownToJson = {
      value: 1,
      toJSON(): string {
        calls += 1;
        return 'substituted';
      },
    };
    class InheritedToJSON {
      readonly field = 2;
      toJSON(): string {
        calls += 1;
        return 'substituted';
      }
    }

    expect(serializeFrameJson(withGetter)).toBe('{"plain":1}');
    expect(serializeFrameJson(listWithGetter)).toBe('[1,null]');
    expect(serializeFrameJson(ownToJson)).toBe('{"value":1}');
    expect(serializeFrameJson(new InheritedToJSON())).toBe('{"field":2}');
    expect(calls).toBe(0);

    // And a `toJSON` a page installs on both prototypes mid-session.
    const expected = JSON.stringify(BATCH_FRAME_SAMPLE);
    const substitute = function toJSON(): string {
      calls += 1;
      return 'substituted';
    };
    const objectPrototype: object = Object.prototype;
    Object.defineProperty(objectPrototype, 'toJSON', {
      configurable: true,
      writable: true,
      value: substitute,
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      writable: true,
      value: substitute,
    });
    let rendered: string;
    try {
      rendered = serializeFrameJson(BATCH_FRAME_SAMPLE);
    } finally {
      Reflect.deleteProperty(objectPrototype, 'toJSON');
      Reflect.deleteProperty(Array.prototype, 'toJSON');
    }
    expect(rendered).toBe(expected);
    expect(calls).toBe(0);
  });
});

describe('the control-text bounds', () => {
  const limit = MAX_CONTROL_TEXT_LENGTH;
  const pair = '\uD83D\uDE00';

  it('bounds control text exactly as truncate() does, surrogate pairs included', () => {
    const corpus: readonly string[] = [
      '',
      'short',
      'a'.repeat(limit),
      'a'.repeat(limit + 1),
      'a'.repeat(limit * 3),
      pair.repeat(limit),
      pair.repeat(limit + 1),
      `${'a'.repeat(limit - 2)}${pair}bb`,
      `${'a'.repeat(limit - 1)}${pair}b`,
      `${'a'.repeat(limit - 1)}${pair}`,
      '\uD800'.repeat(limit + 1),
      `${'\uDC00\uD800'.repeat(limit)}x`,
      `${'a'.repeat(limit - 1)}\uD800\uDC00\uD800`,
    ];
    for (const text of corpus) {
      expect(boundControlText(text)).toBe(truncate(text, limit));
    }
  });

  it('bounds a failure report field exactly as the iterator-and-trim reference does', () => {
    const corpus: readonly string[] = [
      'detach',
      '  padded  ',
      '\ttab\nline\u0000nul\u007fdel\u001f',
      '\u00a0\u1680\u2000\u2005\u200a\u2028\u2029\u202f\u205f\u3000\ufeff core \u3000\u00a0',
      '\u180e mongolian \u180e',
      '\u0085 next line \u0085',
      '\u200b zero width \u200b',
      'x'.repeat(100),
      pair.repeat(40),
      `a${pair.repeat(40)}`,
      '\uD800 lone \uDFFF',
      ' '.repeat(80),
      '',
    ];
    try {
      for (let index = 0; index < corpus.length; index += 1) {
        const stage = corpus[index] ?? '';
        // A new capture each time: failure reports are bounded per capture.
        configureTransport({ captureId: `cap-stage-${String(index)}`, enabled: false });
        bridge.clear();
        reportProducerFailure('transport', stage);
        const reports = bridge
          .framesOfType('agent.error')
          .filter((frame) => frame.payload['code'] === 'producer-failure');
        expect(reports.at(-1)?.payload['stage']).toBe(referenceBoundFailureField(stage));
      }
    } finally {
      configureTransport({ enabled: false });
    }
  });
});
