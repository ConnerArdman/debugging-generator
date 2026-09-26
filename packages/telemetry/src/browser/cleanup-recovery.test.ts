/**
 * Cleanup recovery: what the page agent does when the page refuses to give a
 * registration back.
 *
 * Every producer in this folder contains its own failures, because it runs
 * inside the developer's event handlers and React commits and a throw there
 * would surface in their application. Containment alone is not cleanup,
 * though, and AAP 0.5.1 asks for more than an agent that *tries* to detach:
 * "agent.config with all hooks false returns the browser agent to dormant —
 * listeners detached, the fetch/XHR patch restored to the original functions,
 * bippy handlers unsubscribed". AAP 0.5.5 adds that what could not be done is
 * stated rather than assumed.
 *
 * So this file exercises the paths a normal capture never reaches: a page that
 * throws from `removeEventListener`, a prototype slot sealed against
 * reassignment, a `PerformanceObserver` that will not disconnect, an
 * `addEventListener` wrapper that registers and then throws, a timer that
 * outlived the capture that armed it, and a replaced `XMLHttpRequest`
 * constructor. In each case three things are asserted: the steps that *could*
 * complete did, what could not is retained and retried rather than forgotten,
 * and the developer is told — once per capture, in a frame that carries no
 * data from their application.
 *
 * The assertions are behavioural on purpose. They read the page (how many
 * listeners are registered, which function is on the prototype, how many
 * observers are live) and the `agent.error` frames the agent dispatches, never
 * this folder's internals, so a different implementation of the same
 * guarantee still passes.
 *
 * The frames are read where the real bridge reads them: on the private channel
 * node, through the fake bridge in `./__tests__/page-channel.ts`, which this
 * file connects once at module scope. The same bridge is what the last
 * `describe` uses to show *who* can trigger the teardown at all — the bridge,
 * through the node, and not a page script posting an all-false `agent.config`
 * to its own window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bridgeFrameDetail, connectFakeBridge } from './__tests__/page-channel.js';
import type { FakeBridge } from './__tests__/page-channel.js';
import { applyConfig, getAgentState } from './agent.js';
import { attachErrors, detachErrors, hasErrorsResidue, isErrorsAttached } from './errors.js';
import {
  attachFetch,
  detachFetch,
  hasFetchResidue,
  isFetchAttached,
  getFetchStats,
} from './fetch.js';
import {
  INTERACTION_EVENT_TYPES,
  attachInteractions,
  detachInteractions,
  hasInteractionsResidue,
  isInteractionsAttached,
} from './interaction.js';
import { OBSERVED_ENTRY_TYPES, attachPerf, detachPerf, hasPerfResidue } from './perf.js';
import {
  AGENT_SOURCE_TAG,
  BRIDGE_FRAME_EVENT,
  BRIDGE_SOURCE_TAG,
  CHANNEL_VERSION,
  MAX_PRODUCER_FAILURE_REPORTS,
  configureTransport,
  getProducerFailureStats,
  getTransportStats,
  reportProducerFailure,
  resetTransport,
  subscribe,
} from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------
 */

/** A frame the agent dispatched to the isolated-world bridge. */
interface AgentFrame {
  type: string;
  payload: Readonly<Record<string, unknown>>;
}

/** One entry of the listener ledger: what the page believes is registered. */
type ListenerLedger = Map<string, number>;

/**
 * The fake bridge, holding the agent's channel node.
 *
 * Everything the agent sends — telemetry batches and the `agent.error`
 * control frames these tests read — is dispatched on that node and nowhere
 * else, so this is the one place to read it from. Connected here, at module
 * scope, because the agent's transport answers exactly one handshake request
 * in the life of the document: `./agent.js` subscribed at import, this asks,
 * and the node then survives every `resetTransport()` the cases below run. A
 * control frame needs only the handshake, not a subscription, which is why the
 * `agent.error` frames still arrive after `beforeEach` has reset the
 * transport.
 */
const bridge: FakeBridge = connectFakeBridge({ subscribe });

/** Every frame the agent has dispatched in this test, in order. */
function agentFrames(): AgentFrame[] {
  return bridge.frames
    .filter((frame) => frame.source === AGENT_SOURCE_TAG)
    .map((frame) => ({ type: frame.type, payload: frame.payload }));
}

/** The `producer-failure` frames among them. */
function producerFailures(): AgentFrame[] {
  return agentFrames().filter(
    (frame) => frame.type === 'agent.error' && frame.payload['code'] === 'producer-failure',
  );
}

/** The `hooks-not-released` frames among them. */
function unreleasedFrames(): AgentFrame[] {
  return agentFrames().filter(
    (frame) => frame.type === 'agent.error' && frame.payload['code'] === 'hooks-not-released',
  );
}

/**
 * One page, whose event-listener behaviour this test controls.
 *
 * happy-dom offers no way to enumerate listeners, so registrations are tallied
 * from the calls themselves: adds increment, removals decrement, and a removal
 * the page refuses is never subtracted — which is exactly the leak these tests
 * are about. There is deliberately ONE spy per method, switched through the
 * returned handles: a second `vi.spyOn` over an active spy would capture the
 * mock as its own delegate and recurse.
 */
interface PageHarness {
  /** Live registrations per event type, as the page sees them. */
  ledger: ListenerLedger;
  /** Make removals of one type throw, or pass `undefined` to stop refusing. */
  refuseRemovalOf: (type: string | undefined) => void;
  /** Make the next add of one type register natively and then throw. */
  throwOnNextAddOf: (type: string) => void;
}

function installPageHarness(): PageHarness {
  const ledger: ListenerLedger = new Map();
  const realAdd = window.addEventListener.bind(window);
  const realRemove = window.removeEventListener.bind(window);
  let refusedRemoval: string | undefined;
  let throwOnNextAdd: string | undefined;

  vi.spyOn(window, 'addEventListener').mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      realAdd(type, listener, options);
      ledger.set(type, (ledger.get(type) ?? 0) + 1);
      if (throwOnNextAdd === type) {
        // The wrapper registered the listener and then failed: the registration
        // is live, and a module that recorded it only on a clean return would
        // never try to remove it.
        throwOnNextAdd = undefined;
        throw new TypeError('the page wrapper throws after registering');
      }
    },
  );

  vi.spyOn(window, 'removeEventListener').mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (refusedRemoval === type) {
        throw new TypeError('the page will not remove this listener');
      }
      realRemove(type, listener, options);
      ledger.set(type, Math.max(0, (ledger.get(type) ?? 0) - 1));
    },
  );

  return {
    ledger,
    refuseRemovalOf: (type: string | undefined): void => {
      refusedRemoval = type;
    },
    throwOnNextAddOf: (type: string): void => {
      throwOnNextAdd = type;
    },
  };
}

beforeEach(() => {
  resetTransport();
  bridge.clear();
  configureTransport({ sessionId: 'sess-cleanup', captureId: 'cap-cleanup', enabled: true });
});

afterEach(() => {
  // Restore the page before the producers are released through it, so a test
  // that broke an API cannot leave the next one detaching through the stub.
  vi.restoreAllMocks();
  detachInteractions();
  detachErrors();
  detachFetch();
  detachPerf();
  applyConfig({});
  resetTransport();
});

/*
 * ---------------------------------------------------------------------------
 * Event listeners: interaction and errors
 * ---------------------------------------------------------------------------
 */

describe('listener teardown the page refuses', () => {
  it('removes every other interaction listener and retries the refused one', () => {
    const { ledger, refuseRemovalOf } = installPageHarness();
    attachInteractions();
    expect(ledger.get('click')).toBe(1);

    refuseRemovalOf('click');
    detachInteractions();

    // The refused removal did not cost its neighbours: every other gesture
    // came off, which the pre-fix single-`try` teardown did not manage.
    for (const type of INTERACTION_EVENT_TYPES) {
      if (type !== 'click') {
        expect(ledger.get(type) ?? 0).toBe(0);
      }
    }
    // The click listener is still on the page, and the module says so.
    expect(ledger.get('click')).toBe(1);
    expect(isInteractionsAttached()).toBe(false);
    expect(hasInteractionsResidue()).toBe(true);

    // It is retained rather than forgotten, so the next detach puts it right.
    refuseRemovalOf(undefined);
    detachInteractions();
    expect(ledger.get('click')).toBe(0);
    expect(hasInteractionsResidue()).toBe(false);
  });

  it('observes nothing through a listener it could not remove', () => {
    const { refuseRemovalOf } = installPageHarness();
    attachInteractions();
    refuseRemovalOf('click');
    detachInteractions();

    const before = getTransportStats().seq;
    window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(getTransportStats().seq).toBe(before);
  });

  it('rolls back an add that registered and then threw', () => {
    const { ledger, throwOnNextAddOf } = installPageHarness();

    throwOnNextAddOf('click');
    attachInteractions();

    // A throwing wrapper may well have registered the listener, so the module
    // removes it there and then rather than trusting the throw. Nothing is
    // left that it could neither use nor remove.
    expect(ledger.get('click') ?? 0).toBe(0);
    expect(hasInteractionsResidue()).toBe(false);
    // The gestures whose registration did land are still observed.
    expect(ledger.get('keydown')).toBe(1);

    detachInteractions();
    expect(ledger.get('click') ?? 0).toBe(0);
    expect(ledger.get('keydown') ?? 0).toBe(0);

    // The type was not recorded as registered, so the next attach registers
    // it — exactly once.
    attachInteractions();
    expect(ledger.get('click')).toBe(1);
    detachInteractions();
    expect(ledger.get('click') ?? 0).toBe(0);
  });

  it('retains a rolled-back add the page would not remove either, and adds no second listener', () => {
    const { ledger, refuseRemovalOf, throwOnNextAddOf } = installPageHarness();

    // The worst case: the add registers and throws, and the rollback removal
    // is refused as well, so a live registration exists that this module
    // cannot take back yet.
    throwOnNextAddOf('click');
    refuseRemovalOf('click');
    attachInteractions();
    expect(ledger.get('click')).toBe(1);
    // Not residue while the module is armed: the registration is live and the
    // module has adopted it, so the gesture is observed rather than orphaned.
    // Residue is what a *detach* could not take back, which is the question
    // the announcement asks and the two assertions below answer.
    expect(isInteractionsAttached()).toBe(true);
    expect(hasInteractionsResidue()).toBe(false);

    // A re-attach must adopt it rather than stack a second listener beside it.
    attachInteractions();
    expect(ledger.get('click')).toBe(1);

    detachInteractions();
    expect(ledger.get('click')).toBe(1);
    expect(isInteractionsAttached()).toBe(false);
    expect(hasInteractionsResidue()).toBe(true);

    // Once the page cooperates, the retained registration comes off.
    refuseRemovalOf(undefined);
    detachInteractions();
    expect(ledger.get('click') ?? 0).toBe(0);
    expect(hasInteractionsResidue()).toBe(false);
  });

  it('removes the rejection listener when the error listener will not come off', () => {
    const { ledger, refuseRemovalOf } = installPageHarness();
    attachErrors();
    expect(ledger.get('error')).toBe(1);
    expect(ledger.get('unhandledrejection')).toBe(1);

    refuseRemovalOf('error');
    detachErrors();

    expect(ledger.get('unhandledrejection')).toBe(0);
    expect(ledger.get('error')).toBe(1);
    expect(isErrorsAttached()).toBe(false);
    expect(hasErrorsResidue()).toBe(true);
  });

  it('reports a refused removal as a producer failure carrying no page data', () => {
    const { refuseRemovalOf } = installPageHarness();
    attachErrors();
    refuseRemovalOf('error');
    detachErrors();

    const failures = producerFailures().filter((frame) => frame.payload['source'] === 'errors');
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0]?.payload['captureId']).toBe('cap-cleanup');
    expect(failures[0]?.payload['error']).toBe('TypeError');
    expect(JSON.stringify(agentFrames())).not.toContain('will not remove this listener');
  });

  it('keeps residue false for a hook that detached cleanly', () => {
    attachErrors();
    attachInteractions();
    expect(hasErrorsResidue()).toBe(false);
    expect(hasInteractionsResidue()).toBe(false);

    detachErrors();
    detachInteractions();
    expect(hasErrorsResidue()).toBe(false);
    expect(hasInteractionsResidue()).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Capture isolation: work scheduled by a capture that has ended
 * ---------------------------------------------------------------------------
 */

describe('deferred work that outlived its capture', () => {
  it('never emits an interaction from a previous capture into the next one', () => {
    vi.useFakeTimers();
    try {
      installPageHarness();
      attachInteractions();

      // Capture A observes a gesture, which opens a window and arms the
      // dispatch probe. Letting the probe run is what arms the *close* timer —
      // the deferred work that outlives the capture in the case this test is
      // about — so the advance is part of the setup, not an assertion.
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      vi.advanceTimersByTime(2);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      // A page that has broken `clearTimeout` cannot have its timers cleared,
      // so the close timer survives the end of capture A.
      const realClearTimeout = globalThis.clearTimeout;
      globalThis.clearTimeout = (): void => {
        throw new TypeError('the page will not clear this timer');
      };
      try {
        detachInteractions();
      } finally {
        globalThis.clearTimeout = realClearTimeout;
      }

      // Capture B starts. Its sequence is its own, and nothing from A may
      // enter it: an event stamped with B's capture id but describing A's
      // interaction would be evidence of something that never happened in B.
      resetTransport();
      bridge.clear();
      configureTransport({ sessionId: 'sess-cleanup', captureId: 'cap-b', enabled: true });
      attachInteractions();
      expect(getTransportStats().seq).toBe(0);

      vi.advanceTimersByTime(5_000);
      expect(getTransportStats().seq).toBe(0);
      expect(getTransportStats().buffered).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Patched APIs: fetch and XMLHttpRequest
 * ---------------------------------------------------------------------------
 */

/**
 * Read a method slot as a value, for an identity comparison.
 *
 * The cases below assert that a detach put back exactly the function it
 * replaced, so they compare slots with `toBe`; binding a method first would
 * compare freshly created wrappers and assert nothing. The value read here is
 * never called, so the lost receiver binding that
 * `@typescript-eslint/unbound-method` guards against cannot arise.
 * `Reflect.get` reads the slot exactly as `owner[key]` does, prototype chain
 * and accessors included, so the comparison sees the same function object.
 *
 * @example
 * ```ts
 * const original = slot(XMLHttpRequest.prototype, 'open');
 * attachFetch();
 * detachFetch();
 * expect(slot(XMLHttpRequest.prototype, 'open')).toBe(original);
 * ```
 *
 * @param owner The object holding the slot: `window` or a prototype.
 * @param key The slot's property name.
 * @returns The slot's current value, typed `unknown` so it can only be compared.
 */
function slot<T extends object>(owner: T, key: keyof T & string): unknown {
  return Reflect.get(owner, key);
}

describe('patch restoration the page refuses', () => {
  it('restores all four patched properties in a clean cycle', () => {
    const originals = {
      fetch: slot(window, 'fetch'),
      open: slot(XMLHttpRequest.prototype, 'open'),
      send: slot(XMLHttpRequest.prototype, 'send'),
      setRequestHeader: slot(XMLHttpRequest.prototype, 'setRequestHeader'),
    };

    attachFetch();
    expect(isFetchAttached()).toBe(true);
    expect(slot(window, 'fetch')).not.toBe(originals.fetch);

    detachFetch();
    expect(slot(window, 'fetch')).toBe(originals.fetch);
    expect(slot(XMLHttpRequest.prototype, 'open')).toBe(originals.open);
    expect(slot(XMLHttpRequest.prototype, 'send')).toBe(originals.send);
    expect(slot(XMLHttpRequest.prototype, 'setRequestHeader')).toBe(originals.setRequestHeader);
    expect(hasFetchResidue()).toBe(false);
  });

  it('restores the slots it can and retries the slot it cannot', () => {
    const prototype = XMLHttpRequest.prototype;
    const originalSend = slot(prototype, 'send');
    const originalHeader = slot(prototype, 'setRequestHeader');
    const originalOpen = slot(prototype, 'open');

    attachFetch();
    const patchedOpen = slot(prototype, 'open');
    expect(patchedOpen).not.toBe(originalOpen);

    // Sealed against reassignment: the restoring write throws.
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'open');
    Object.defineProperty(prototype, 'open', {
      value: patchedOpen,
      writable: false,
      configurable: true,
    });

    try {
      detachFetch();

      // The other two slots came back even though the first would not.
      expect(slot(prototype, 'send')).toBe(originalSend);
      expect(slot(prototype, 'setRequestHeader')).toBe(originalHeader);
      expect(slot(prototype, 'open')).toBe(patchedOpen);
      expect(isFetchAttached()).toBe(false);
      expect(hasFetchResidue()).toBe(true);

      const failures = producerFailures().filter((frame) => frame.payload['source'] === 'fetch');
      expect(failures.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(prototype, 'open', descriptor);
      }
    }

    // The saved original was retained, so a later detach completes the job —
    // the module never loses the only reference that can undo its own patch.
    detachFetch();
    expect(slot(prototype, 'open')).toBe(originalOpen);
    expect(hasFetchResidue()).toBe(false);
  });

  it('never strands a patch when the XMLHttpRequest constructor is replaced', () => {
    const prototypeA = XMLHttpRequest.prototype;
    const originalOpenA = slot(prototypeA, 'open');
    const originalSendA = slot(prototypeA, 'send');
    const constructorA = globalThis.XMLHttpRequest;

    attachFetch();
    const patchedOpenA = slot(prototypeA, 'open');

    const descriptor = Object.getOwnPropertyDescriptor(prototypeA, 'open');
    Object.defineProperty(prototypeA, 'open', {
      value: patchedOpenA,
      writable: false,
      configurable: true,
    });
    try {
      detachFetch();
      expect(slot(prototypeA, 'open')).toBe(patchedOpenA);
      expect(slot(prototypeA, 'send')).toBe(originalSendA);

      // The page swaps the constructor — a polyfill, a mocking library, a
      // test double. A new install must not overwrite the reference that is
      // the only way back for prototype A.
      class ReplacementXhr {
        open(): void {
          /* a stand-in whose prototype is a different object */
        }
        send(): void {
          /* no transport in the stand-in */
        }
        setRequestHeader(): void {
          /* no headers in the stand-in */
        }
      }
      globalThis.XMLHttpRequest = ReplacementXhr as unknown as typeof XMLHttpRequest;
      const prototypeB = ReplacementXhr.prototype;
      const originalOpenB = slot(prototypeB, 'open');

      attachFetch();
      detachFetch();
      expect(slot(prototypeB, 'open')).toBe(originalOpenB);

      globalThis.XMLHttpRequest = constructorA;
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(prototypeA, 'open', descriptor);
      }
      globalThis.XMLHttpRequest = constructorA;
    }

    // Prototype A's residue was never forgotten across the replacement.
    detachFetch();
    expect(slot(prototypeA, 'open')).toBe(originalOpenA);
    expect(hasFetchResidue()).toBe(false);
    expect(getFetchStats().inFlight).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Observers
 * ---------------------------------------------------------------------------
 */

describe('observer teardown the host refuses', () => {
  /** A `PerformanceObserver` stand-in whose `disconnect()` this test controls. */
  class StubObserver {
    static live: StubObserver[] = [];
    static refuseDisconnect = false;
    readonly types: string[] = [];
    connected = false;

    constructor(readonly callback: (list: { getEntries: () => unknown[] }) => void) {
      StubObserver.live.push(this);
    }

    observe(options: { type?: string; entryTypes?: string[] }): void {
      if (typeof options.type === 'string') {
        this.types.push(options.type);
      }
      this.connected = true;
    }

    disconnect(): void {
      if (StubObserver.refuseDisconnect) {
        throw new TypeError('the host will not disconnect this observer');
      }
      this.connected = false;
    }

    takeRecords(): unknown[] {
      return [];
    }
  }

  let realObserver: typeof PerformanceObserver | undefined;

  beforeEach(() => {
    realObserver = globalThis.PerformanceObserver;
    StubObserver.live = [];
    StubObserver.refuseDisconnect = false;
    globalThis.PerformanceObserver = StubObserver as unknown as typeof PerformanceObserver;
  });

  afterEach(() => {
    StubObserver.refuseDisconnect = false;
    detachPerf();
    if (realObserver !== undefined) {
      globalThis.PerformanceObserver = realObserver;
    }
  });

  it('keeps one observer per entry type across a refused disconnect and a re-arm', () => {
    attachPerf();
    const firstRound = StubObserver.live.filter((observer) => observer.connected);
    expect(firstRound).toHaveLength(OBSERVED_ENTRY_TYPES.length);

    StubObserver.refuseDisconnect = true;
    detachPerf();
    expect(hasPerfResidue()).toBe(true);

    attachPerf();
    // One per type, not two: an adopted observer is already watching its
    // type, so constructing a second would make the capture count every
    // entry twice.
    const connected = StubObserver.live.filter((observer) => observer.connected);
    expect(connected).toHaveLength(OBSERVED_ENTRY_TYPES.length);
    for (const type of OBSERVED_ENTRY_TYPES) {
      expect(connected.filter((observer) => observer.types.includes(type))).toHaveLength(1);
    }

    StubObserver.refuseDisconnect = false;
    detachPerf();
    expect(hasPerfResidue()).toBe(false);
    expect(StubObserver.live.filter((observer) => observer.connected)).toHaveLength(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The report itself
 * ---------------------------------------------------------------------------
 */

describe('producer failure reporting', () => {
  it('states a failure once per source per capture and counts the rest', () => {
    const before = getProducerFailureStats();
    for (let index = 0; index < 5; index += 1) {
      reportProducerFailure('react', 'commit-traversal', new TypeError('internal'));
    }

    const frames = producerFailures().filter((frame) => frame.payload['source'] === 'react');
    expect(frames).toHaveLength(MAX_PRODUCER_FAILURE_REPORTS);
    expect(MAX_PRODUCER_FAILURE_REPORTS).toBe(1);
    expect(frames[0]?.payload['final']).toBe(true);
    expect(getProducerFailureStats().reported - before.reported).toBe(1);
    expect(getProducerFailureStats().suppressed - before.suppressed).toBe(4);
  });

  it('gives every source its own allowance, and a new capture a fresh one', () => {
    reportProducerFailure('react', 'commit', new TypeError('internal'));
    reportProducerFailure('perf', 'observer-start', new TypeError('internal'));
    expect(producerFailures()).toHaveLength(2);

    configureTransport({ sessionId: 'sess-cleanup', captureId: 'cap-next', enabled: true });
    reportProducerFailure('react', 'commit', new TypeError('internal'));
    expect(producerFailures().filter((frame) => frame.payload['source'] === 'react')).toHaveLength(
      2,
    );
  });

  it('names only error types from its own vocabulary, never the page’s strings', () => {
    const sentinel = new Error('a message that must not travel');
    sentinel.name = 'SENSITIVE_SENTINEL';
    reportProducerFailure('state', 'transition-record', sentinel);

    const hostile = { constructor: { name: 'SENSITIVE_SENTINEL' } };
    reportProducerFailure('interaction', 'interaction-event', hostile);

    const frames = producerFailures();
    expect(frames.map((frame) => frame.payload['error'])).toStrictEqual(['Error', 'object']);
    expect(JSON.stringify(frames)).not.toContain('SENSITIVE_SENTINEL');
    expect(JSON.stringify(frames)).not.toContain('must not travel');
  });

  it('keeps a standard DOMException name, which is diagnostic and not page data', () => {
    reportProducerFailure('fetch', 'settle', new DOMException('x', 'DataCloneError'));
    expect(producerFailures()[0]?.payload['error']).toBe('DataCloneError');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The announcement the agent makes about it
 * ---------------------------------------------------------------------------
 */

describe('unreleased hooks, as the agent announces them', () => {
  it('names a hook that stopped observing but left a registration behind', () => {
    const { refuseRemovalOf } = installPageHarness();
    applyConfig({
      sessionId: 'sess-agent',
      captureId: 'cap-agent',
      hooks: { interactions: true, errors: true },
    });
    expect(isInteractionsAttached()).toBe(true);

    refuseRemovalOf('click');
    applyConfig({});

    // The hook is no longer observing, so `isInteractionsAttached()` is false
    // and the old announcement — which asked only that question — saw nothing.
    expect(isInteractionsAttached()).toBe(false);
    expect(hasInteractionsResidue()).toBe(true);

    const announced = unreleasedFrames();
    expect(announced).toHaveLength(1);
    const unreleased = announced[0]?.payload['unreleased'] as
      { signal?: unknown; reason?: unknown; hint?: unknown }[] | undefined;
    expect(unreleased?.map((entry) => entry.signal)).toContain('interactions');
    const entry = unreleased?.find((candidate) => candidate.signal === 'interactions');
    expect(String(entry?.reason)).toContain('registration');
    expect(String(entry?.hint).length).toBeGreaterThan(0);
    expect(announced[0]?.payload['captureId']).toBe('cap-agent');

    // Once per capture: a second disarm retries the release and says nothing
    // new, so a refused hook cannot fill the channel.
    applyConfig({});
    expect(unreleasedFrames()).toHaveLength(1);
  });

  it('announces nothing when every hook released', () => {
    installPageHarness();
    applyConfig({
      sessionId: 'sess-agent',
      captureId: 'cap-agent-clean',
      hooks: { interactions: true, errors: true },
    });
    applyConfig({});

    expect(unreleasedFrames()).toHaveLength(0);
    expect(hasInteractionsResidue()).toBe(false);
    expect(hasErrorsResidue()).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Who can trigger the teardown
 *
 * An `agent.config` with every hook false returns the browser agent to
 * dormant. That is a capability, and the cases above show what the agent does
 * once it is exercised. These show who can exercise it: the bridge, through the
 * channel node it was handed — and not a page script, whatever it posts to its
 * own window or dispatches on the page, because the agent listens for bridge
 * frames on that node and nowhere else.
 * ---------------------------------------------------------------------------
 */

describe('who can return the agent to dormant', () => {
  /** A capture with one hook, so "armed" is observable on the page. */
  const ARMING = {
    sessionId: 'sess-channel',
    captureId: 'cap-channel',
    hooks: { interactions: true },
  };

  /** The configuration that disarms: every hook false. */
  const ALL_FALSE = {
    sessionId: 'sess-channel',
    captureId: 'cap-channel',
    hooks: { interactions: false },
  };

  /** Macrotask yields a posted message is given to arrive before a case fails. */
  const MAX_WAITED_TURNS = 20;

  /** Yield one macrotask, the turn `window.postMessage` delivers on. */
  async function nextTurn(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  /**
   * Arm a capture the way a second capture on this document is armed.
   *
   * The disarm first is what re-subscribes the agent to the channel after
   * `beforeEach` reset the transport, exactly as `./agent.ts` does at the end
   * of every capture; the node the bridge holds is the same one throughout.
   */
  function armCapture(): void {
    applyConfig({});
    applyConfig(ARMING);
    expect(getAgentState().armed).toBe(true);
    expect(isInteractionsAttached()).toBe(true);
  }

  it('stays armed through every all-false agent.config a page script can send', async () => {
    armCapture();

    const posted: readonly unknown[] = [
      // The version-2 frame, with a token of the length version 2 used — the
      // replay the old window channel allowed.
      {
        source: BRIDGE_SOURCE_TAG,
        version: CHANNEL_VERSION - 1,
        type: 'agent.config',
        token: 'f'.repeat(64),
        payload: ALL_FALSE,
      },
      // Version 3's fields, and version 3's detail string, posted instead of
      // dispatched on the node.
      {
        source: BRIDGE_SOURCE_TAG,
        version: CHANNEL_VERSION,
        type: 'agent.config',
        payload: ALL_FALSE,
      },
      bridgeFrameDetail('agent.config', ALL_FALSE),
    ];

    let arrived = 0;
    const onMessage = (): void => {
      arrived += 1;
    };
    window.addEventListener('message', onMessage);

    try {
      for (const forgery of posted) {
        window.postMessage(forgery, '*');
      }
      // A well-formed bridge frame, dispatched everywhere a page script can
      // reach: nobody acknowledges it.
      for (const target of [window, document, document.documentElement]) {
        const unclaimed = target.dispatchEvent(
          new CustomEvent(BRIDGE_FRAME_EVENT, {
            detail: bridgeFrameDetail('agent.config', ALL_FALSE),
            cancelable: true,
          }),
        );
        expect(unclaimed).toBe(true);
      }

      for (let turn = 0; turn < MAX_WAITED_TURNS && arrived < posted.length; turn += 1) {
        await nextTurn();
      }
      // Self-check: every posted forgery reached the page's window.
      expect(arrived).toBe(posted.length);

      expect(getAgentState().armed).toBe(true);
      expect(isInteractionsAttached()).toBe(true);
    } finally {
      window.removeEventListener('message', onMessage);
    }

    // The same configuration from the bridge, on the node, does disarm: the
    // forgeries were refused for where they came from, not for what they said.
    expect(bridge.send('agent.config', ALL_FALSE)).toBe(true);
    expect(getAgentState().armed).toBe(false);
    expect(isInteractionsAttached()).toBe(false);
  });

  it('publishes nothing on __DEBUGGEN__ that leads to the channel node', () => {
    armCapture();

    // Every data value reachable from the helper, three levels deep, read from
    // property descriptors so no getter runs.
    const reachable: unknown[] = [];
    let frontier: unknown[] = [Reflect.get(globalThis, '__DEBUGGEN__')];
    for (let level = 0; level < 3; level += 1) {
      const next: unknown[] = [];
      for (const holder of frontier) {
        if ((typeof holder !== 'object' && typeof holder !== 'function') || holder === null) {
          continue;
        }
        for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(holder))) {
          if ('value' in descriptor) {
            const held: unknown = descriptor.value;
            reachable.push(held);
            next.push(held);
          }
        }
      }
      frontier = next;
    }

    // Self-check: the helper is published and has members to walk.
    expect(reachable.length).toBeGreaterThan(0);
    expect(reachable).not.toContain(bridge.node);
  });
});
