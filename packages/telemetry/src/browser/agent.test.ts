/**
 * The page agent's terminal points against `./react.js`'s deferred commit
 * analysis, proven on the wire.
 *
 * `./react.js` no longer turns a commit into events inside React's commit: it
 * captures what the analysis needs there and hands the rest to an idle slice
 * (PERF-F07). A document that stops, hides, unloads or changes capture may
 * never give it that slice, so `./agent.js` drains the queue at every terminal
 * point — capture stop, `pagehide`, `visibilitychange` to hidden, a capture
 * change, and a configuration that drops the React family mid-capture. Each
 * case here observes a commit that is still queued, drives one of those
 * points through the page channel exactly as the bridge would, and reads what
 * reached the fake bridge: the commit, its coalesced render events (PERF-F08)
 * and, where authorised, the component-tree snapshot, all stamped with the
 * capture they belong to.
 *
 * **Why the idle API is held.** Each test installs a `requestIdleCallback`
 * that records its callbacks and never runs them. Without it, happy-dom's
 * absence of the API sends `./react.js` to its timer fallback, which could run
 * between two statements of a test and hide a missing drain behind a slice
 * that merely happened to fire. With it, the only way a queued commit reaches
 * the wire is a drain.
 *
 * **Why React is loaded here, after the agent.** `./agent.js` installs the
 * DevTools hook when it evaluates, and only `react-dom` registers a renderer
 * with that hook — and so determines which fiber tags are composite. Loading
 * it dynamically below the static imports is what puts the renderer on the
 * agent's hook, exactly as the extension's `document_start` injection does in
 * a real page.
 *
 * @module packages/telemetry/src/browser/agent.test
 */
import type { ComponentType, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COMPONENT_TREE_ATTRIBUTE_KEYS, COMPONENT_TREE_EVENT_NAME } from '../schema/attributes.js';
import { connectFakeBridge } from './__tests__/page-channel.js';
import type { FakeBridge } from './__tests__/page-channel.js';
import { getAgentState } from './agent.js';
import { hasPendingReactWork } from './react.js';
import { flush, subscribe } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * The page channel and React, in the order a real page has them
 * ---------------------------------------------------------------------------
 */

/**
 * The fake bridge on the agent's channel node. `./agent.js` subscribed when it
 * was imported above, and the document answers one handshake, so it is
 * connected once for the whole file.
 */
const bridge: FakeBridge = connectFakeBridge({ subscribe });

/** The modules the rendered cases need, loaded after the hook exists. */
const { act, createElement, memo } = await import('react');
const { createRoot } = await import('react-dom/client');

/**
 * Every `agent.ready` the fake bridge received up to the moment `react-dom`
 * finished evaluating — which is when it registered its renderer with the
 * agent's hook — plus one microtask, and nothing later: no timer has fired and
 * no inbound frame has been sent. Taken here, before the first `beforeEach`
 * clears the bridge, for the announcement case at the end of this file.
 */
await Promise.resolve();
const readyAtReactRegistration: readonly Readonly<Record<string, unknown>>[] = bridge
  .framesOfType('agent.ready')
  .map((frame) => frame.payload);

/** Tell React it is running inside `act`, so it emits no warning. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * ---------------------------------------------------------------------------
 * The rendered application: a shelf of memoized cards
 * ---------------------------------------------------------------------------
 */

/** Display names the assertions look for. Explicit, never inferred. */
const CARD = 'AgentCard';
const SHELF = 'AgentShelf';

/** How many cards the shelf renders. More than one, so a group coalesces. */
const CARD_COUNT = 12;

/** The cards' labels, which are also their keys. */
const CARD_LABELS: readonly string[] = Array.from(
  { length: CARD_COUNT },
  (_, index) => `card-${String(index)}`,
);

/** A card's props: a label and a callback the shelf re-creates every render. */
interface CardProps {
  readonly label: string;
  readonly onSelect: () => string;
}

/** One card: a button showing its label. */
function AgentCard(props: CardProps): ReactElement {
  return createElement('button', { type: 'button', onClick: props.onSelect }, props.label);
}
AgentCard.displayName = CARD;

/**
 * The memoized card. Memoization does not help it: the shelf hands every card
 * a fresh `onSelect` on each render — the demo's defect 2 in miniature — so
 * every card re-renders with `trigger: props` and `changedProps: ['onSelect']`,
 * which is exactly the group `./react.js` must coalesce into one event.
 */
const MemoCard: ComponentType<CardProps> = memo(AgentCard);

/** The shelf: a tick number it prints and one card per label. */
function AgentShelf(props: { readonly tick: number }): ReactElement {
  return createElement(
    'section',
    { 'data-tick': String(props.tick) },
    CARD_LABELS.map((label) =>
      createElement(MemoCard, {
        key: label,
        label,
        onSelect: () => `${label}@${String(props.tick)}`,
      }),
    ),
  );
}
AgentShelf.displayName = SHELF;

/** A mounted shelf and the handle that re-renders it. */
interface MountedShelf {
  /** Render the shelf again with a new tick, inside `act`. Never drains. */
  readonly tick: (value: number) => Promise<void>;
}

/** Every root the current test mounted, unmounted by `afterEach` once dormant. */
const mountedRoots: { readonly unmount: () => void; readonly container: HTMLElement }[] = [];

/**
 * Mount the shelf at tick 0 inside `act` and return its re-render handle.
 *
 * Deliberately **no** drain here — unlike `./react.test.tsx`'s harness — so the
 * commits React produces stay queued until the terminal point under test.
 */
async function mountShelf(containerId: string): Promise<MountedShelf> {
  const container = document.createElement('div');
  container.id = containerId;
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ unmount: () => root.unmount(), container });

  const renderTick = async (value: number): Promise<void> => {
    await act(async () => {
      root.render(createElement(AgentShelf, { tick: value }));
      await Promise.resolve();
    });
  };
  await renderTick(0);
  return { tick: renderTick };
}

/*
 * ---------------------------------------------------------------------------
 * The idle API, held
 * ---------------------------------------------------------------------------
 */

/** Idle callbacks requested during the current test; never run. */
const heldIdleCallbacks: IdleRequestCallback[] = [];

/** The host's own idle API descriptors, restored by `afterEach`. */
let savedIdleApi:
  | {
      readonly request: PropertyDescriptor | undefined;
      readonly cancel: PropertyDescriptor | undefined;
    }
  | undefined;

/** Install an idle API that records callbacks and never calls them. */
function holdIdleWork(): void {
  savedIdleApi = {
    request: Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback'),
    cancel: Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback'),
  };
  heldIdleCallbacks.length = 0;
  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    writable: true,
    value: (callback: IdleRequestCallback): number => {
      heldIdleCallbacks.push(callback);
      return heldIdleCallbacks.length;
    },
  });
  Object.defineProperty(globalThis, 'cancelIdleCallback', {
    configurable: true,
    writable: true,
    value: (handle: number): void => {
      // Held callbacks never run, so cancelling one only has to be accepted.
      expect(typeof handle).toBe('number');
    },
  });
}

/** Hand the host's idle API back exactly as it was found. */
function releaseIdleWork(): void {
  const saved = savedIdleApi;
  savedIdleApi = undefined;
  heldIdleCallbacks.length = 0;
  if (saved === undefined) {
    return;
  }
  for (const [key, descriptor] of [
    ['requestIdleCallback', saved.request],
    ['cancelIdleCallback', saved.cancel],
  ] as const) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * Configurations and the wire
 * ---------------------------------------------------------------------------
 */

/** The session every capture here belongs to. */
const SESSION_ID = 'sess-agent-drain';

/** An `agent.config` payload arming `hooks` for `captureId`. */
function captureConfig(
  captureId: string,
  hooks: Readonly<Record<string, boolean>>,
): Record<string, unknown> {
  return { sessionId: SESSION_ID, captureId, hooks: { ...hooks } };
}

/** Deliver an `agent.config` through the channel, as the bridge does. */
function configure(payload: Record<string, unknown>): void {
  expect(bridge.send('agent.config', payload)).toBe(true);
}

/** Return the agent to dormant through the channel, as the bridge does. */
function toDormant(): void {
  configure({});
  expect(getAgentState().armed).toBe(false);
}

/** One event as it reached the wire, narrowed to what these cases read. */
interface WireEvent {
  readonly kind: unknown;
  readonly name: unknown;
  readonly spanId: unknown;
  readonly parentSpanId?: unknown;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** Whether a value has the fields {@link WireEvent} names. */
function isWireEvent(value: unknown): value is WireEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'attributes' in value &&
    typeof value.attributes === 'object' &&
    value.attributes !== null
  );
}

/** Every event the fake bridge received for `captureId`, in wire order. */
function wireEventsOf(captureId: string): WireEvent[] {
  const events: WireEvent[] = [];
  for (const frame of bridge.framesOfType('telemetry.batch')) {
    if (frame.payload['captureId'] !== captureId) {
      continue;
    }
    const batch = frame.payload['events'];
    if (!Array.isArray(batch)) {
      continue;
    }
    for (const event of batch) {
      if (isWireEvent(event)) {
        events.push(event);
      }
    }
  }
  return events;
}

/** The `render` events of one component, in wire order. */
function rendersOf(events: readonly WireEvent[], component: string): WireEvent[] {
  return events.filter(
    (event) => event.kind === 'render' && event.attributes['component'] === component,
  );
}

/** The `commit` events, in wire order. */
function commitsOf(events: readonly WireEvent[]): WireEvent[] {
  return events.filter((event) => event.kind === 'commit');
}

/** How many fibers a render event stands for: `instanceCount`, or 1 when absent. */
function weightOf(event: WireEvent): number {
  const instances = event.attributes['instanceCount'];
  return typeof instances === 'number' ? instances : 1;
}

/**
 * Assert the shelf's mount and `ticks` re-renders all reached the wire,
 * coalesced: per commit one `AgentShelf` event and one `AgentCard` event
 * standing for all {@link CARD_COUNT} cards, with running per-capture counts.
 */
function expectShelfCommits(events: readonly WireEvent[], ticks: number): void {
  const commits = commitsOf(events);
  expect(commits).toHaveLength(ticks + 1);

  const cards = rendersOf(events, CARD);
  expect(cards).toHaveLength(ticks + 1);
  cards.forEach((card, index) => {
    expect(card.attributes['instanceCount']).toBe(CARD_COUNT);
    expect(card.attributes['renderCount']).toBe(CARD_COUNT * (index + 1));
    expect(card.attributes['phase']).toBe(index === 0 ? 'mount' : 'update');
    if (index === 0) {
      expect(card.attributes).not.toHaveProperty('trigger');
    } else {
      expect(card.attributes['trigger']).toBe('props');
      expect(card.attributes['changedProps']).toEqual(['onSelect']);
    }
  });
  expect(rendersOf(events, SHELF)).toHaveLength(ticks + 1);

  // Each commit's renderCount is the fibers its render events stand for.
  for (const commit of commits) {
    const own = events.filter(
      (event) => event.kind === 'render' && event.parentSpanId === commit.spanId,
    );
    expect(own.length).toBeGreaterThan(0);
    expect(commit.attributes['renderCount']).toBe(own.reduce((sum, e) => sum + weightOf(e), 0));
  }
}

/** A node of the component-tree snapshot, as its JSON text carries it. */
interface TreeNode {
  readonly name?: unknown;
  readonly renderCount?: unknown;
  readonly children?: unknown;
}

/**
 * The first node named `name` in a parsed snapshot, depth first.
 *
 * The snapshot's text is one root {@link TreeNode} (the synthetic root the
 * agent serialises), whose `children` are arrays of the same shape.
 */
function findTreeNode(node: unknown, name: string): TreeNode | undefined {
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }
  const candidate = node as TreeNode;
  if (candidate.name === name) {
    return candidate;
  }
  if (!Array.isArray(candidate.children)) {
    return undefined;
  }
  for (const child of candidate.children as readonly unknown[]) {
    const inner = findTreeNode(child, name);
    if (inner !== undefined) {
      return inner;
    }
  }
  return undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------
 */

beforeEach(() => {
  toDormant();
  bridge.clear();
  holdIdleWork();
});

afterEach(async () => {
  toDormant();
  // Dormant first: the React family is detached, so these unmount commits are
  // observed by nothing and nothing is queued.
  for (const mountedRoot of mountedRoots.splice(0)) {
    await act(async () => {
      mountedRoot.unmount();
      await Promise.resolve();
    });
    mountedRoot.container.remove();
  }
  expect(hasPendingReactWork()).toBe(false);
  releaseIdleWork();
  bridge.clear();
});

/*
 * ---------------------------------------------------------------------------
 * The cases
 * ---------------------------------------------------------------------------
 */

describe('the agent drains deferred React commits at every terminal point', () => {
  it('leaves commits queued, not emitted, until a terminal point — and a dormant agent queues nothing', async () => {
    const shelf = await mountShelf('agent-dormant');
    await shelf.tick(1);
    expect(hasPendingReactWork()).toBe(false);
    expect(heldIdleCallbacks).toHaveLength(0);

    configure(captureConfig('cap-agent-queued', { react: true }));
    expect(getAgentState().hooks['react']).toBe(true);
    await shelf.tick(2);

    expect(hasPendingReactWork()).toBe(true);
    expect(heldIdleCallbacks).toHaveLength(1);
    flush();
    expect(rendersOf(wireEventsOf('cap-agent-queued'), CARD)).toHaveLength(0);
  });

  it('drains at capture stop, before the flush that ends the capture', async () => {
    configure(captureConfig('cap-agent-stop', { react: true }));
    const shelf = await mountShelf('agent-stop');
    await shelf.tick(1);
    await shelf.tick(2);
    expect(hasPendingReactWork()).toBe(true);

    // Two drains stand behind this outcome: `disarm()`'s own opening drain,
    // and the React family's detach binding, whose events the transport's
    // disable-time flush still carries. Either alone delivers the capture's
    // last commits; the opening drain is what puts them ahead of the snapshot
    // and the explicit flush rather than relying on the reset to send them.
    toDormant();

    expect(hasPendingReactWork()).toBe(false);
    expectShelfCommits(wireEventsOf('cap-agent-stop'), 2);
  });

  it('drains before the component-tree snapshot, so the tree counts every coalesced render', async () => {
    configure(captureConfig('cap-agent-tree', { react: true, componentTree: true }));
    const shelf = await mountShelf('agent-tree');
    await shelf.tick(1);
    expect(hasPendingReactWork()).toBe(true);

    toDormant();

    const events = wireEventsOf('cap-agent-tree');
    expectShelfCommits(events, 1);
    const treeIndex = events.findIndex(
      (event) => event.kind === 'log' && event.name === COMPONENT_TREE_EVENT_NAME,
    );
    expect(treeIndex).toBeGreaterThan(-1);
    const lastCardIndex = events.lastIndexOf(rendersOf(events, CARD).at(-1) as WireEvent);
    expect(lastCardIndex).toBeLessThan(treeIndex);

    const [treeKey] = COMPONENT_TREE_ATTRIBUTE_KEYS;
    const treeText = events[treeIndex]?.attributes[treeKey];
    expect(typeof treeText).toBe('string');
    const card = findTreeNode(JSON.parse(treeText as string) as unknown, CARD);
    expect(card?.renderCount).toBe(CARD_COUNT * 2);
  });

  it('drains on pagehide, so an unloading document still hands its last commits to the bridge', async () => {
    configure(captureConfig('cap-agent-pagehide', { react: true }));
    const shelf = await mountShelf('agent-pagehide');
    await shelf.tick(1);
    expect(hasPendingReactWork()).toBe(true);

    try {
      window.dispatchEvent(new Event('pagehide'));
      expect(hasPendingReactWork()).toBe(false);
      expectShelfCommits(wireEventsOf('cap-agent-pagehide'), 1);
    } finally {
      // Re-arm the document-scoped families pagehide released, as a document
      // restored from the back/forward cache does.
      window.dispatchEvent(new Event('pageshow'));
    }
  });

  it('drains when the document is hidden, and not while it is visible', async () => {
    configure(captureConfig('cap-agent-hidden', { react: true }));
    const shelf = await mountShelf('agent-hidden');
    await shelf.tick(1);
    expect(hasPendingReactWork()).toBe(true);

    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.visibilityState).not.toBe('hidden');
    expect(hasPendingReactWork()).toBe(true);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: (): DocumentVisibilityState => 'hidden',
    });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }

    expect(hasPendingReactWork()).toBe(false);
    expectShelfCommits(wireEventsOf('cap-agent-hidden'), 1);
  });

  it('drains into the ending capture on a capture change, and restarts the counts for the next', async () => {
    configure(captureConfig('cap-agent-first', { react: true }));
    const shelf = await mountShelf('agent-change');
    await shelf.tick(1);
    expect(hasPendingReactWork()).toBe(true);

    configure(captureConfig('cap-agent-second', { react: true }));

    expect(hasPendingReactWork()).toBe(false);
    expectShelfCommits(wireEventsOf('cap-agent-first'), 1);
    expect(wireEventsOf('cap-agent-second')).toHaveLength(0);

    await shelf.tick(2);
    toDormant();

    const next = rendersOf(wireEventsOf('cap-agent-second'), CARD);
    expect(next).toHaveLength(1);
    expect(next[0]?.attributes['instanceCount']).toBe(CARD_COUNT);
    expect(next[0]?.attributes['renderCount']).toBe(CARD_COUNT);
  });

  it('drains before a configuration that drops React mid-capture detaches it', async () => {
    configure(captureConfig('cap-agent-drop', { react: true, interactions: true }));
    const shelf = await mountShelf('agent-drop');
    await shelf.tick(1);
    expect(hasPendingReactWork()).toBe(true);

    configure(captureConfig('cap-agent-drop', { react: false, interactions: true }));

    expect(getAgentState().armed).toBe(true);
    expect(getAgentState().hooks['react']).toBe(false);
    expect(hasPendingReactWork()).toBe(false);
    flush();
    expectShelfCommits(wireEventsOf('cap-agent-drop'), 1);

    // Detached means disabled: a later commit is observed by nothing.
    await shelf.tick(2);
    expect(hasPendingReactWork()).toBe(false);
  });
});

describe('the agent announces React when it registers', () => {
  it('re-announces agent.ready with reactDetected the moment react-dom registers, before any timer or inbound frame', () => {
    // The announcement made at install preceded the bridge's handshake and was
    // not dispatched, so the one frame here is the one the registration
    // prompted — a second after install is when the backstop timer would fire.
    expect(readyAtReactRegistration).toHaveLength(1);
    const [announced] = readyAtReactRegistration;
    expect(announced?.['reactDetected']).toBe(true);
    expect(announced?.['installedBeforeReact']).toBe(getAgentState().installedBeforeReact);
    expect(typeof announced?.['documentId']).toBe('string');
    expect(typeof announced?.['producerId']).toBe('string');
  });

  it('announces React once: later inbound frames re-announce nothing', () => {
    configure(captureConfig('cap-agent-announce', { react: true }));
    toDormant();

    expect(bridge.framesOfType('agent.ready')).toEqual([]);
  });
});
