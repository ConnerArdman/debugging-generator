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
 * observers are live) and the `agent.error` frames the agent posts, never this
 * folder's internals, so a different implementation of the same guarantee
 * still passes.
 */
/* eslint-disable @typescript-eslint/unbound-method -- this suite compares the
   *identity* of methods rather than calling them: `window.fetch` and the three
   `XMLHttpRequest.prototype` members are read as values so that "the detach
   restored exactly what it replaced" can be asserted with `toBe`. Binding them
   would compare freshly created wrappers and assert nothing. The same applies
   to the stub observer's own methods. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyConfig } from './agent.js';
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
  MAX_PRODUCER_FAILURE_REPORTS,
  configureTransport,
  getProducerFailureStats,
  getTransportStats,
  reportProducerFailure,
  resetTransport,
} from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------
 */

/** A frame the agent posted to the isolated-world bridge. */
interface AgentFrame {
  type: string;
  payload: Record<string, unknown>;
}

/** One entry of the listener ledger: what the page believes is registered. */
type ListenerLedger = Map<string, number>;

/**
 * Every frame the agent posted in the current test, oldest first.
 *
 * `postFrame` hands everything it sends — telemetry batches and the
 * `agent.error` control frames these tests read — to `window.postMessage`, so
 * recording that one call site captures all of it and no bridge handshake is
 * needed. The frames are collected into an array rather than read back off a
 * spy, because `postMessage` is overloaded and its recorded arguments are
 * typed `any`.
 */
let postedFrames: unknown[] = [];

/** Every frame the agent has posted in this test, in order. */
function agentFrames(): AgentFrame[] {
  const frames: AgentFrame[] = [];
  for (const message of postedFrames) {
    if (typeof message !== 'object' || message === null) {
      continue;
    }
    const frame = message as { source?: unknown; type?: unknown; payload?: unknown };
    if (frame.source !== 'debuggen-agent' || typeof frame.type !== 'string') {
      continue;
    }
    const payload = frame.payload;
    frames.push({
      type: frame.type,
      payload:
        typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {},
    });
  }
  return frames;
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
  postedFrames = [];
  vi.spyOn(window, 'postMessage').mockImplementation((message: unknown): void => {
    postedFrames.push(message);
  });
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
      postedFrames = [];
      vi.spyOn(window, 'postMessage').mockImplementation((message: unknown): void => {
        postedFrames.push(message);
      });
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

describe('patch restoration the page refuses', () => {
  it('restores all four patched properties in a clean cycle', () => {
    const originals = {
      fetch: window.fetch,
      open: XMLHttpRequest.prototype.open,
      send: XMLHttpRequest.prototype.send,
      setRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
    };

    attachFetch();
    expect(isFetchAttached()).toBe(true);
    expect(window.fetch).not.toBe(originals.fetch);

    detachFetch();
    expect(window.fetch).toBe(originals.fetch);
    expect(XMLHttpRequest.prototype.open).toBe(originals.open);
    expect(XMLHttpRequest.prototype.send).toBe(originals.send);
    expect(XMLHttpRequest.prototype.setRequestHeader).toBe(originals.setRequestHeader);
    expect(hasFetchResidue()).toBe(false);
  });

  it('restores the slots it can and retries the slot it cannot', () => {
    const prototype = XMLHttpRequest.prototype;
    const originalSend = prototype.send;
    const originalHeader = prototype.setRequestHeader;
    const originalOpen = prototype.open;

    attachFetch();
    const patchedOpen = prototype.open;
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
      expect(prototype.send).toBe(originalSend);
      expect(prototype.setRequestHeader).toBe(originalHeader);
      expect(prototype.open).toBe(patchedOpen);
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
    expect(prototype.open).toBe(originalOpen);
    expect(hasFetchResidue()).toBe(false);
  });

  it('never strands a patch when the XMLHttpRequest constructor is replaced', () => {
    const prototypeA = XMLHttpRequest.prototype;
    const originalOpenA = prototypeA.open;
    const originalSendA = prototypeA.send;
    const constructorA = globalThis.XMLHttpRequest;

    attachFetch();
    const patchedOpenA = prototypeA.open;

    const descriptor = Object.getOwnPropertyDescriptor(prototypeA, 'open');
    Object.defineProperty(prototypeA, 'open', {
      value: patchedOpenA,
      writable: false,
      configurable: true,
    });
    try {
      detachFetch();
      expect(prototypeA.open).toBe(patchedOpenA);
      expect(prototypeA.send).toBe(originalSendA);

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
      const originalOpenB = prototypeB.open;

      attachFetch();
      detachFetch();
      expect(prototypeB.open).toBe(originalOpenB);

      globalThis.XMLHttpRequest = constructorA;
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(prototypeA, 'open', descriptor);
      }
      globalThis.XMLHttpRequest = constructorA;
    }

    // Prototype A's residue was never forgotten across the replacement.
    detachFetch();
    expect(prototypeA.open).toBe(originalOpenA);
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
