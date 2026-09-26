/**
 * The state producer's two contracts with the evidence layer: the attribute
 * vocabulary it writes, and the disclosure it owes when a bound cuts a
 * transition list.
 *
 * This suite is deliberately narrow. `./react.test.tsx` drives this module the
 * way the product does — through a real commit, with `./fiber-diff.ts`
 * supplying the changes — and covers the ordinary path. What it cannot reach is
 * the far end of {@link MAX_TRANSITIONS_PER_CAPTURE}: five thousand
 * transitions is not a React test, it is a loop, and it is exactly where the
 * interesting behaviour lives. A capture that has spent its whole transition
 * budget has nothing left to mark, and a producer that says nothing then hands
 * the panel a list that looks complete and is not (AAP 0.5.5's posture:
 * evidence is never silently discarded).
 *
 * So the cases below are the bounds and the vocabulary, asserted against the
 * drafts this module hands to `./transport.ts`:
 *
 * - the per-commit bound cuts a run and marks its **last** draft;
 * - the per-capture bound, once spent, produces exactly one sentinel event per
 *   capture that discloses the loss, carries the dropped total as a floor and
 *   is attributable to the call that overflowed;
 *   a further overflow adds no second sentinel, and a new capture re-arms it;
 * - every key written is the catalogued spelling `../aggregate/timeline.ts`
 *   reads back (`../schema/attributes.ts`'s `STATE_ATTRIBUTE_KEYS`).
 *
 * `emitMany` is spied on rather than the page channel, for the same reason
 * `./react.test.tsx` does it: the assertions are about the drafts this module
 * builds, and the transport's own queueing, batching and bridge handshake are
 * that module's contract and its own tests' business.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STATE_ATTRIBUTE_KEYS, TRANSITION_SOURCES } from '../schema/attributes.js';
import {
  MAX_TRANSITIONS_PER_CAPTURE,
  MAX_TRANSITIONS_PER_COMMIT,
  attachState,
  detachState,
  getStateStats,
  recordStateTransitions,
  resetStateCounters,
} from './state.js';
import * as transport from './transport.js';
import type { EventDraft } from './transport.js';

/** The trace every draft in this suite joins. */
const TRACE_ID = 'a'.repeat(32);

/** The render span the transitions are observed inside. */
const RENDER_SPAN_ID = '1'.repeat(16);

/** The interaction span the commit is attributed to. */
const TRIGGER_SPAN_ID = '2'.repeat(16);

/** The component every call reports; generic, like every other fixture name. */
const COMPONENT = 'ListRow';

/** The fiber instance the calls report. */
const FIBER_ID = 5;

/**
 * The sentinel's event name, as a consumer would recognise it.
 *
 * Spelled here rather than imported because it is not exported: the sentinel
 * is identified downstream by its `truncated` attribute, and pinning the name
 * in a test is what would notice it changing silently.
 */
const SENTINEL_NAME = 'state transitions dropped';

/** Drafts handed to the transport since the last reset, in emission order. */
const captured: EventDraft[] = [];

/** One call's worth of changed hooks, each with a readable value summary. */
function hookChanges(count: number): {
  index: number;
  label: string;
  from: { type: 'number'; preview: string; truncated: boolean };
  to: { type: 'number'; preview: string; truncated: boolean };
}[] {
  return Array.from({ length: count }, (_unused, at) => ({
    index: at,
    label: `hook[${String(at)}]`,
    from: { type: 'number' as const, preview: String(at), truncated: false },
    to: { type: 'number' as const, preview: String(at + 1), truncated: false },
  }));
}

/** Reports `count` changed hooks for one commit of one fiber. */
function call(count: number): void {
  recordStateTransitions({
    component: COMPONENT,
    traceId: TRACE_ID,
    parentSpanId: RENDER_SPAN_ID,
    triggerSpanId: TRIGGER_SPAN_ID,
    fiberId: FIBER_ID,
    startTime: 1_700_000_000_000,
    hookChanges: hookChanges(count),
  });
}

/** Fills the per-capture budget in full runs, returning how many calls it took. */
function fillCaptureBudget(): number {
  let calls = 0;
  while (getStateStats().emitted < MAX_TRANSITIONS_PER_CAPTURE) {
    call(MAX_TRANSITIONS_PER_COMMIT);
    calls += 1;
  }
  return calls;
}

/** The recorded sentinel drafts. */
function sentinels(): EventDraft[] {
  return captured.filter((draft) => draft.name === SENTINEL_NAME);
}

/** The recorded drafts that describe an actual transition. */
function transitions(): EventDraft[] {
  return captured.filter((draft) => draft.name !== SENTINEL_NAME);
}

beforeEach(() => {
  captured.length = 0;
  transport.resetTransport();
  transport.configureTransport({ sessionId: 'ses_1', captureId: 'cap_1', enabled: true });
  vi.spyOn(transport, 'emitMany').mockImplementation((drafts) => {
    captured.push(...drafts);
  });
  attachState();
});

afterEach(() => {
  detachState();
  vi.restoreAllMocks();
  transport.resetTransport();
});

describe('the attribute vocabulary', () => {
  it('writes only keys the catalog declares for the state kind', () => {
    call(1);

    const draft = transitions()[0];
    expect(draft).toBeDefined();
    const declared: readonly string[] = STATE_ATTRIBUTE_KEYS;
    for (const key of Object.keys(draft?.attributes ?? {})) {
      expect(declared).toContain(key);
    }
  });

  it('describes the transition with the catalogued spellings the aggregate reads', () => {
    call(1);

    const attributes = transitions()[0]?.attributes ?? {};
    expect(attributes['component']).toBe(COMPONENT);
    expect(attributes['hookIndex']).toBe(0);
    expect(attributes['transitionSource']).toBe(TRANSITION_SOURCES[0]);
    // The producer holds a span id, not an event id, so the direct trigger
    // travels under `triggerSpanId` — the key the aggregate resolves through
    // its span index before it falls back to the parent chain.
    expect(attributes['triggerSpanId']).toBe(TRIGGER_SPAN_ID);
    expect(attributes['triggerEventId']).toBeUndefined();
    expect(attributes['renderSpanId']).toBe(RENDER_SPAN_ID);
    expect(attributes['fiberId']).toBe(FIBER_ID);
  });

  it('reports a consumed context change as the context dimension', () => {
    recordStateTransitions({
      component: COMPONENT,
      traceId: TRACE_ID,
      parentSpanId: RENDER_SPAN_ID,
      startTime: 1_700_000_000_000,
      hookChanges: [],
      contextChanges: [
        {
          index: 0,
          label: 'ThemeContext',
          from: { type: 'string' as const, preview: 'light', truncated: false },
          to: { type: 'string' as const, preview: 'dark', truncated: false },
        },
      ],
    });

    expect(transitions()[0]?.attributes['transitionSource']).toBe(TRANSITION_SOURCES[1]);
  });
});

describe('the per-commit bound', () => {
  it('cuts the run at the bound and marks its last draft', () => {
    call(MAX_TRANSITIONS_PER_COMMIT + 8);

    const emitted = transitions();
    expect(emitted).toHaveLength(MAX_TRANSITIONS_PER_COMMIT);
    expect(sentinels()).toHaveLength(0);
    expect(emitted[MAX_TRANSITIONS_PER_COMMIT - 1]?.attributes['truncated']).toBe(true);
    expect(emitted[MAX_TRANSITIONS_PER_COMMIT - 2]?.attributes['truncated']).toBeUndefined();
    expect(getStateStats().truncated).toBe(8);
  });
});

describe('the per-capture bound', () => {
  it('discloses the loss with one sentinel when no draft is left to mark', () => {
    fillCaptureBudget();
    expect(getStateStats().emitted).toBe(MAX_TRANSITIONS_PER_CAPTURE);
    // The run that reached the bound was itself cut, so it marked its own last
    // draft and needed no sentinel.
    const droppedBeforeOverflow = getStateStats().truncated;
    expect(sentinels()).toHaveLength(0);

    call(7);

    const found = sentinels();
    expect(found).toHaveLength(1);
    const sentinel = found[0];
    expect(sentinel?.kind).toBe('state');
    expect(sentinel?.traceId).toBe(TRACE_ID);
    // A disclosure is an instant, like every other transition, and an
    // observation rather than a failed operation.
    expect(sentinel?.duration).toBe(0);
    expect(sentinel?.status).toBe('ok');
    expect(sentinel?.parentSpanId).toBe(RENDER_SPAN_ID);
    expect(sentinel?.attributes['truncated']).toBe(true);
    // The floor the contract promises: the capture's dropped total at the
    // instant the disclosure was emitted, not one call's loss.
    expect(sentinel?.attributes['droppedTransitions']).toBe(droppedBeforeOverflow + 7);
    expect(sentinel?.attributes['droppedTransitions']).toBe(getStateStats().truncated);
    // Attributable, and describing no value: it is not a transition.
    expect(sentinel?.attributes['component']).toBe(COMPONENT);
    expect(sentinel?.attributes['triggerSpanId']).toBe(TRIGGER_SPAN_ID);
    expect(sentinel?.attributes['renderSpanId']).toBe(RENDER_SPAN_ID);
    expect(sentinel?.attributes['fiberId']).toBe(FIBER_ID);
    expect(sentinel?.attributes['transitionSource']).toBeUndefined();
    expect(sentinel?.attributes['previousValue']).toBeUndefined();
    expect(sentinel?.attributes['nextValue']).toBeUndefined();
  });

  it('emits one sentinel per capture and keeps counting the rest', () => {
    fillCaptureBudget();
    call(7);
    const afterFirst = getStateStats().truncated;

    call(9);
    call(11);

    expect(sentinels()).toHaveLength(1);
    expect(getStateStats().truncated).toBe(afterFirst + 20);
  });

  it('re-arms the disclosure for the next capture', () => {
    fillCaptureBudget();
    call(7);
    expect(sentinels()).toHaveLength(1);

    resetStateCounters();
    expect(getStateStats()).toEqual({ emitted: 0, truncated: 0, failures: 0 });
    fillCaptureBudget();
    call(3);

    expect(sentinels()).toHaveLength(2);
  });

  it('emits nothing at all once the hook is detached', () => {
    fillCaptureBudget();
    detachState();
    captured.length = 0;

    call(7);

    expect(captured).toHaveLength(0);
  });
});
