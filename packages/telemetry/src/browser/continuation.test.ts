// @vitest-environment happy-dom
/**
 * Colocated tests for `./continuation.ts` — the rule that decides which trace a
 * late event joins once the synchronous interaction window has closed.
 *
 * **What this suite owns.** The product's most subtle correctness claim: that a
 * React commit rendering a response six hundred milliseconds after a click
 * still belongs to that click's trace (AAP §0.4.2, "one click resolves to one
 * ordered tree"), and that when the attribution is genuinely uncertain the
 * event *says so* — `ambiguous` with the rejected candidate span ids — instead
 * of presenting a guess as an observed fact. Nothing else in the repository
 * tests that rule in isolation: `tests/e2e/demo-slow-interaction.spec.ts`
 * asserts the whole click → request → response → commit tree end to end, and
 * this file is what makes that outcome explainable when it breaks.
 *
 * Every clause of the AAP's lineage paragraph is one or more cases below:
 *
 * - a continuation window opens on a **settled** request and lasts at most
 *   {@link CONTINUATION_WINDOW_MS}, closed early by the next interaction;
 * - candidates are tracked **per request span, not per trace**, so parallel
 *   requests from one interaction compete with each other and requests from
 *   *different* traces compete in the same arbitration;
 * - the winner is the **most recently settled** request span, and the caller
 *   adopts the winner's `traceId`;
 * - an attribution with more than one candidate carries `lineageAmbiguous`
 *   and `lineageCandidates` — the attributes `../correlation/tree.ts` reads
 *   back into `TraceNodeLineage` and the `timeline` renderer draws dashed.
 *
 * **No fake timers, no `await`, and one explicitly pinned clock.** Expiry in
 * the module under test is prune-on-read: it owns no timer, and its own
 * documentation makes that a contract rather than an implementation detail. So
 * every case here drives the module purely through injected `startedAt` /
 * `settledAt` / `now` values on a small synthetic epoch-millisecond base
 * ({@link T0}), which makes the suite a pure function of its call sequence —
 * deterministic, instant, and unable to pass for the wrong reason if somebody
 * later adds the timer the module forbids. A fake-timer test would pass today
 * and rot tomorrow.
 *
 * The single exception is the nested `describe` covering what a *non-finite*
 * timestamp degrades to, because that one path genuinely reads a clock
 * (`nowEpochMs()` in `./transport.js`). Those cases pin it — an own
 * `performance.timeOrigin` shadowing the prototype accessor, plus
 * `performance.now` and `Date.now` — so they assert the exact instant the
 * fallback resolves to and both sides of the window boundary around it,
 * instead of proving only that a window happens to still be open on this host
 * at this moment. The pin is installed and removed per case inside that block
 * and nowhere else; no other case in the suite reads a clock at all.
 *
 * **Attribute keys are never spelled out.** The three lineage keys and the one
 * lineage value are resolved from the imported `LINEAGE_ATTRIBUTE_KEYS` and
 * `LINEAGE_VALUES` vocabularies by the same *role* suffixes the writer
 * (`./continuation.ts`) and the reader (`../correlation/tree.ts`) use, so a
 * reshuffle of that group cannot leave this suite asserting against stale
 * names while both sides of the product keep agreeing with each other.
 * `../schema/event.test.ts` pins the literal contents of the vocabulary; that
 * is deliberately not repeated here.
 *
 * **Harness.** The root `vitest.config.ts` collects this file into the
 * `telemetry` project, which runs under happy-dom; the docblock on line 1
 * states the same environment per file, so the suite keeps its browser-ish
 * globals whatever a command line or a future project split says. The module
 * needs no DOM of its own — but `./transport.js`'s `nowEpochMs`, the fallback
 * a non-finite timestamp degrades to, reads `performance`, and this folder's
 * suites run browser-side by convention. Nothing here imports a Node built-in:
 * `eslint.config.js` forbids one anywhere under `src/browser/**`, tests
 * included, because this directory is bundled into the page-injected agent
 * (AAP §0.2.2, §0.7.1 Group 1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LINEAGE_ATTRIBUTE_KEYS, LINEAGE_VALUES } from '../schema/attributes.js';
import {
  applyLineageAttributes,
  attachContinuations,
  cancelPendingContinuation,
  CONTINUATION_WINDOW_MS,
  detachContinuations,
  getContinuationStats,
  getLineage,
  isContinuationsAttached,
  MAX_LINEAGE_CANDIDATES,
  MAX_OPEN_CONTINUATIONS,
  MAX_PENDING_CONTINUATIONS,
  notifyInteraction,
  PENDING_MAX_AGE_MS,
  registerPendingContinuation,
  resetContinuations,
  settleContinuation,
} from './continuation.js';
import type { LineageAttribution } from './continuation.js';

// ---------------------------------------------------------------------------
// Time base
// ---------------------------------------------------------------------------

/**
 * The synthetic instant every case measures from, in epoch milliseconds.
 *
 * A small round number rather than a plausible epoch value, because the module
 * only ever compares two timestamps that came from the same caller and
 * documents that a test may drive it on any consistent base. Reading
 * `T0 + 150` in an assertion is worth more than reading a thirteen-digit
 * timestamp, and a failure message says which offset lost the arbitration.
 */
const T0 = 1_000_000;

// ---------------------------------------------------------------------------
// Correlation ids
//
// Opaque keys to the module under test — it stores them trimmed and never
// validates their shape — but written here in the real wire shapes (32 and 16
// lowercase hex characters, AAP §0.2.3) so a case that is ever lifted into an
// event fixture stays valid, and so a failure diff shows ids that differ in
// their last digits rather than in their length.
// ---------------------------------------------------------------------------

/** Characters in a trace id. */
const TRACE_ID_WIDTH = 32;

/** Characters in a span id. */
const SPAN_ID_WIDTH = 16;

/**
 * A zero-padded lowercase-hex id of `width` characters carrying `seed` in its
 * low digits.
 *
 * Deterministic and collision-free for the small seeds these cases use, which
 * is the whole requirement: two ids are the same entry exactly when their
 * seeds match.
 */
function hexId(width: number, seed: number): string {
  const digits = Math.trunc(Math.abs(seed)).toString(16);
  if (digits.length >= width) {
    return digits.slice(digits.length - width);
  }
  return `${'0'.repeat(width - digits.length)}${digits}`;
}

/** The trace id for `seed`: 32 lowercase hex characters. */
function traceId(seed: number): string {
  return hexId(TRACE_ID_WIDTH, seed);
}

/** The span id for `seed`: 16 lowercase hex characters. */
function spanId(seed: number): string {
  return hexId(SPAN_ID_WIDTH, seed);
}

// ---------------------------------------------------------------------------
// The lineage vocabulary, resolved by role
//
// Mirrors how `./continuation.ts` writes these keys and how
// `../correlation/tree.ts` reads them: the group is published as a
// `readonly string[]`, so each key is found by the suffix naming its role and
// never by its position, which an alphabetical tidy-up would change.
// ---------------------------------------------------------------------------

/** Suffix identifying the ambiguity flag within the lineage key group. */
const AMBIGUOUS_KEY_SUFFIX = 'Ambiguous';

/** Suffix identifying the candidate-span list within the lineage key group. */
const CANDIDATES_KEY_SUFFIX = 'Candidates';

/**
 * The lineage key matching `predicate`.
 *
 * Throws rather than returning `undefined`: the module under test degrades
 * gracefully when the vocabulary is reshaped (it writes one attribute less),
 * but a *test* that silently stopped asserting on a key would be worse than a
 * failing one, so an unresolvable role fails collection with a message naming
 * the role it wanted.
 */
function lineageKey(predicate: (key: string) => boolean, role: string): string {
  const key = LINEAGE_ATTRIBUTE_KEYS.find(predicate);
  if (key === undefined) {
    throw new Error(`the attribute key group carries no ${role} key`);
  }
  return key;
}

/** The key naming the mechanism an event was attributed by. */
const MECHANISM_KEY = lineageKey(
  (key) => !key.endsWith(AMBIGUOUS_KEY_SUFFIX) && !key.endsWith(CANDIDATES_KEY_SUFFIX),
  'mechanism',
);

/** The key holding the ambiguity flag. */
const AMBIGUOUS_KEY = lineageKey((key) => key.endsWith(AMBIGUOUS_KEY_SUFFIX), 'ambiguity');

/** The key holding the rejected candidate span ids. */
const CANDIDATES_KEY = lineageKey((key) => key.endsWith(CANDIDATES_KEY_SUFFIX), 'candidate');

/** The value the module writes for an attribution across an async boundary. */
const CONTINUATION_VALUE: string = LINEAGE_VALUES[0];

// ---------------------------------------------------------------------------
// Assertions and fixtures
// ---------------------------------------------------------------------------

/** The counters a freshly reset module reports. */
const EMPTY_STATS = { pending: 0, open: 0, settled: 0, expired: 0, dropped: 0 };

/**
 * The attribution for an event landing at `now`, or a failure naming the
 * instant that found no window.
 *
 * Every case that expects *no* attribution calls {@link getLineage} directly
 * and asserts `toBeUndefined()`; this helper exists for the cases that expect
 * one, so the narrowing happens once instead of in forty assertions.
 */
function lineageAt(now: number): LineageAttribution {
  const lineage = getLineage(now);
  if (lineage === undefined) {
    throw new Error(`expected an open continuation window at ${now}`);
  }
  return lineage;
}

/**
 * Register a request and settle it, the two-call sequence `./fetch.ts` makes
 * around one request.
 *
 * Takes seeds rather than ids so a case reads as "trace 1, request 2" and the
 * ids stay out of the way.
 */
function openWindow(options: {
  trace: number;
  request: number;
  startedAt: number;
  settledAt: number;
}): void {
  registerPendingContinuation({
    traceId: traceId(options.trace),
    spanId: spanId(options.request),
    startedAt: options.startedAt,
  });
  settleContinuation(spanId(options.request), options.settledAt);
}

beforeEach(() => {
  // The module holds process-level maps and cumulative counters, so a case
  // that did not start from zero would be asserting on its predecessor.
  resetContinuations();
});

describe('the harness', () => {
  it('mints ids in the wire shapes the event contract defines', () => {
    expect(traceId(1)).toMatch(/^[0-9a-f]{32}$/);
    expect(spanId(1)).toMatch(/^[0-9a-f]{16}$/);
    expect(traceId(1)).not.toBe(traceId(2));
    expect(spanId(1)).not.toBe(spanId(2));
  });

  it('starts each case with both registries empty and every counter at zero', () => {
    expect(getContinuationStats()).toEqual(EMPTY_STATS);
    expect(getLineage(T0)).toBeUndefined();
  });

  it('resolves three distinct lineage keys, the flags qualifying the mechanism', () => {
    expect(new Set([MECHANISM_KEY, AMBIGUOUS_KEY, CANDIDATES_KEY]).size).toBe(3);
    // The flags are the mechanism key plus a role suffix — the relationship
    // `../correlation/tree.ts` relies on when it resolves the same three keys.
    expect(AMBIGUOUS_KEY.startsWith(MECHANISM_KEY)).toBe(true);
    expect(CANDIDATES_KEY.startsWith(MECHANISM_KEY)).toBe(true);
    expect(CONTINUATION_VALUE.length).toBeGreaterThan(0);
  });

  it('orders the module bounds so the cases below can reach each of them', () => {
    // Asserted as relationships rather than as numbers: the truncation case
    // needs more open windows than the candidate list may carry, the eviction
    // case needs fewer open slots than pending ones, and the age-out case
    // needs a pending deadline beyond one window.
    expect(MAX_LINEAGE_CANDIDATES).toBeLessThan(MAX_OPEN_CONTINUATIONS);
    expect(MAX_OPEN_CONTINUATIONS).toBeLessThan(MAX_PENDING_CONTINUATIONS);
    expect(PENDING_MAX_AGE_MS).toBeGreaterThan(CONTINUATION_WINDOW_MS);
  });
});

describe('two parallel requests in one interaction followed by a commit', () => {
  // The scenario AAP §0.4.2 names for this file. One click starts two fetches
  // on one trace; they settle fifty milliseconds apart; then React commits.
  // The commit belongs to the response it rendered, and the product cannot
  // know *which* response that was — so it takes the most recently settled
  // one and says the attribution is ambiguous.

  /** The interaction's trace. */
  const trace = traceId(1);

  /** The request that settled first, and therefore loses the arbitration. */
  const firstSettled = spanId(1);

  /** The request that settled last, and therefore parents the commit. */
  const lastSettled = spanId(2);

  /** Register both requests and settle them 100 ms and 150 ms after the click. */
  function reproduce(): void {
    registerPendingContinuation({ traceId: trace, spanId: firstSettled, startedAt: T0 });
    registerPendingContinuation({ traceId: trace, spanId: lastSettled, startedAt: T0 });
    settleContinuation(firstSettled, T0 + 100);
    settleContinuation(lastSettled, T0 + 150);
  }

  it('attributes the commit to the most recently settled request span', () => {
    reproduce();

    expect(lineageAt(T0 + 160)).toEqual({
      traceId: trace,
      parentSpanId: lastSettled,
      ambiguous: true,
      candidates: [firstSettled],
    });
  });

  it('lists the other candidate and never the winner', () => {
    reproduce();

    const lineage = lineageAt(T0 + 160);
    expect(lineage.candidates).toContain(firstSettled);
    expect(lineage.candidates).not.toContain(lastSettled);
    expect(lineage.candidates).not.toContain(lineage.parentSpanId);
  });

  it('keeps both requests as independent open windows', () => {
    reproduce();

    expect(getContinuationStats()).toEqual({
      pending: 0,
      open: 2,
      settled: 2,
      expired: 0,
      dropped: 0,
    });
  });

  it('stamps the commit with the mechanism, the ambiguity flag and the candidates', () => {
    reproduce();
    const attributes: Record<string, unknown> = {};

    applyLineageAttributes(attributes, lineageAt(T0 + 160));

    expect(attributes[MECHANISM_KEY]).toBe(CONTINUATION_VALUE);
    expect(attributes[AMBIGUOUS_KEY]).toBe(true);
    expect(attributes[CANDIDATES_KEY]).toEqual([firstSettled]);
  });

  it('writes nothing outside the lineage vocabulary', () => {
    reproduce();
    const attributes: Record<string, unknown> = {};

    applyLineageAttributes(attributes, lineageAt(T0 + 160));

    for (const key of Object.keys(attributes)) {
      expect(LINEAGE_ATTRIBUTE_KEYS).toContain(key);
    }
    expect(Object.keys(attributes)).toHaveLength(3);
  });
});

describe('one settled request', () => {
  it('attributes a later event to that request without flagging ambiguity', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 100 });

    expect(lineageAt(T0 + 600)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(1),
      ambiguous: false,
      candidates: [],
    });
  });

  it('writes the mechanism key alone, so an unambiguous event stays small', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 100 });
    const attributes: Record<string, unknown> = {};

    applyLineageAttributes(attributes, lineageAt(T0 + 600));

    // Absence is the encoding of "unambiguous": the reader compares against
    // `true` and treats a missing candidate list as none, and the commit path
    // runs once per rendered component.
    expect(Object.keys(attributes)).toEqual([MECHANISM_KEY]);
    expect(Object.hasOwn(attributes, AMBIGUOUS_KEY)).toBe(false);
    expect(Object.hasOwn(attributes, CANDIDATES_KEY)).toBe(false);
    expect(attributes[AMBIGUOUS_KEY]).toBeUndefined();
    expect(attributes[CANDIDATES_KEY]).toBeUndefined();
  });

  it('opens no window while the request is still in flight', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });

    // An in-flight request has produced nothing to attribute to yet.
    expect(getLineage(T0 + 10)).toBeUndefined();
    expect(getContinuationStats()).toEqual({
      pending: 1,
      open: 0,
      settled: 0,
      expired: 0,
      dropped: 0,
    });
  });

  it('attributes the work that renders a failed request too', () => {
    // `./fetch.ts` settles on both the fulfilment and the rejection path: the
    // React work that renders an error belongs to the request that failed.
    openWindow({ trace: 7, request: 7, startedAt: T0, settledAt: T0 + 40 });

    expect(lineageAt(T0 + 41).parentSpanId).toBe(spanId(7));
  });
});

describe('the continuation window', () => {
  it('is the 2 000 ms bound the plan states', () => {
    // The one place this number is written in the suite; every other case
    // does its arithmetic against the constant, so widening the window in the
    // module changes this assertion and nothing else.
    expect(CONTINUATION_WINDOW_MS).toBe(2000);
  });

  it('still attributes an event one millisecond before the deadline', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 100 });

    expect(lineageAt(T0 + 100 + CONTINUATION_WINDOW_MS - 1).parentSpanId).toBe(spanId(1));
  });

  it('is already closed at exactly settledAt plus the window', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 100 });

    // The deadline is inclusive: `expiresAt <= now` closes the window, so the
    // boundary instant itself finds nothing.
    expect(getLineage(T0 + 100 + CONTINUATION_WINDOW_MS)).toBeUndefined();
  });

  it('stays closed after the deadline has passed', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 100 });

    expect(getLineage(T0 + 100 + CONTINUATION_WINDOW_MS * 2)).toBeUndefined();
  });

  it('expires on the read rather than on a timer', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 100 });

    // Nothing has been read yet, and `getContinuationStats` is the one entry
    // point that does not prune — so the window is still counted as open no
    // matter how much wall-clock time has passed since the synthetic settle.
    expect(getContinuationStats()).toEqual({
      pending: 0,
      open: 1,
      settled: 1,
      expired: 0,
      dropped: 0,
    });

    expect(getLineage(T0 + 100 + CONTINUATION_WINDOW_MS)).toBeUndefined();

    // The read is what closed it, and the closure is counted as an expiry.
    expect(getContinuationStats()).toEqual({
      pending: 0,
      open: 0,
      settled: 1,
      expired: 1,
      dropped: 0,
    });
  });

  it('counts each expired window once, however often the stats are read', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 });

    expect(getLineage(T0 + CONTINUATION_WINDOW_MS)).toBeUndefined();
    expect(getLineage(T0 + CONTINUATION_WINDOW_MS)).toBeUndefined();

    expect(getContinuationStats().expired).toBe(2);
    expect(getContinuationStats().open).toBe(0);
  });

  it('is not extended by a second settle of the same request', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });
    settleContinuation(spanId(1), T0);

    // A `fetch` that rejects after its stream began, or a caller with both a
    // `then` and a `catch`, settles twice. The promotion consumed the pending
    // entry, so the second call cannot move the deadline.
    settleContinuation(spanId(1), T0 + 500);

    expect(lineageAt(T0 + CONTINUATION_WINDOW_MS - 1).parentSpanId).toBe(spanId(1));
    expect(getLineage(T0 + CONTINUATION_WINDOW_MS)).toBeUndefined();
    expect(getContinuationStats().settled).toBe(1);
  });

  it('measures each window from its own settle', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 500 });

    // The earlier window has closed and the later one has not, so the reader
    // gets an unambiguous attribution to the survivor.
    expect(lineageAt(T0 + CONTINUATION_WINDOW_MS)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(2),
      ambiguous: false,
      candidates: [],
    });
    expect(getContinuationStats().expired).toBe(1);
  });
});

describe('a new interaction', () => {
  it('closes every open window', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 20 });

    notifyInteraction(T0 + 30);

    // Once the developer clicks again, later work belongs to the new click —
    // leaving the windows open is the ambient-variable failure the module
    // exists to prevent.
    expect(getLineage(T0 + 30)).toBeUndefined();
    expect(getContinuationStats().open).toBe(0);
  });

  it('counts an early close as neither an expiry nor a drop', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 20 });

    notifyInteraction(T0 + 30);

    // Not a loss and not a deadline: the normal end of continuation
    // attribution. Counting it as either would hide the bound-pressure signal
    // `expired` and `dropped` exist to give.
    expect(getContinuationStats()).toEqual({
      pending: 0,
      open: 0,
      settled: 2,
      expired: 0,
      dropped: 0,
    });
  });

  it('leaves a request still in flight able to settle and parent its render', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(3), startedAt: T0 });

    notifyInteraction(T0 + 10);

    // The asymmetry is deliberate: all open windows close, every pending
    // request survives. Its response will still arrive, and the React work
    // that renders it still needs a parent.
    expect(getContinuationStats().pending).toBe(1);

    settleContinuation(spanId(3), T0 + 20);

    expect(lineageAt(T0 + 30)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(3),
      ambiguous: false,
      candidates: [],
    });
  });

  it('still ages out a pending request it declines to clear', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });

    notifyInteraction(T0 + PENDING_MAX_AGE_MS);

    expect(getContinuationStats()).toEqual({
      pending: 0,
      open: 0,
      settled: 0,
      expired: 0,
      dropped: 1,
    });
  });

  it('lets the new interaction start from no lineage at all', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });

    notifyInteraction(T0 + 20);
    openWindow({ trace: 2, request: 2, startedAt: T0 + 20, settledAt: T0 + 120 });

    // Only the new interaction's request competes, so the second click's
    // commit is attributed to it unambiguously.
    expect(lineageAt(T0 + 130)).toEqual({
      traceId: traceId(2),
      parentSpanId: spanId(2),
      ambiguous: false,
      candidates: [],
    });
  });
});

describe('candidates are tracked per request span, not per trace', () => {
  it('keeps one open window per settled request on the same trace', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 100 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 150 });

    // Collapsing per trace would lose the parent: the commit would know which
    // interaction it belonged to but not which response produced it.
    expect(getContinuationStats().open).toBe(2);
  });

  it("arbitrates across traces and adopts the winner's trace", () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 });
    openWindow({ trace: 2, request: 2, startedAt: T0, settledAt: T0 + 10 });

    // The clause a per-trace implementation gets wrong: windows from
    // different traces compete in one arbitration, and the event joins the
    // winner's trace.
    expect(lineageAt(T0 + 20)).toEqual({
      traceId: traceId(2),
      parentSpanId: spanId(2),
      ambiguous: true,
      candidates: [spanId(1)],
    });
  });

  it('ranks by settle recency and not by how many requests a trace settled', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 5 });
    openWindow({ trace: 2, request: 3, startedAt: T0, settledAt: T0 + 10 });

    // Trace 1 holds two of the three windows and still loses: recency decides.
    expect(lineageAt(T0 + 20)).toEqual({
      traceId: traceId(2),
      parentSpanId: spanId(3),
      ambiguous: true,
      candidates: [spanId(2), spanId(1)],
    });
  });
});

describe('arbitration order', () => {
  it('orders candidates most recently settled first and excludes the winner', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 20 });
    openWindow({ trace: 1, request: 3, startedAt: T0, settledAt: T0 + 30 });

    expect(lineageAt(T0 + 40)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(3),
      ambiguous: true,
      candidates: [spanId(2), spanId(1)],
    });
  });

  it('keeps that order when the requests settle out of registration order', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(2), startedAt: T0 });
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(3), startedAt: T0 });

    settleContinuation(spanId(2), T0 + 10);
    settleContinuation(spanId(3), T0 + 20);
    settleContinuation(spanId(1), T0 + 30);

    // Settle order, not registration order, is what recency means.
    expect(lineageAt(T0 + 40)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(1),
      ambiguous: true,
      candidates: [spanId(3), spanId(2)],
    });
  });

  it('breaks a settle-time tie in favour of the request settled last', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 10 });

    // Two promises resolved in one microtask checkpoint, or a coarsened clock:
    // ordinary, and still deterministic — "the one we heard about last".
    expect(lineageAt(T0 + 20)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(2),
      ambiguous: true,
      candidates: [spanId(1)],
    });
  });

  it('returns the same winner for every read of a tie', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 10 });
    openWindow({ trace: 1, request: 3, startedAt: T0, settledAt: T0 + 10 });

    const first = lineageAt(T0 + 20);
    const second = lineageAt(T0 + 20);
    const third = lineageAt(T0 + 21);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.parentSpanId).toBe(spanId(3));
  });

  it('treats a re-settled request as the newest entry in a tie', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 10 });
    expect(lineageAt(T0 + 20).parentSpanId).toBe(spanId(2));

    // A request whose span id is registered again — the second attempt of a
    // retried request — takes the newest position when it settles, which is
    // what the tie-break reads.
    openWindow({ trace: 1, request: 1, startedAt: T0 + 10, settledAt: T0 + 10 });

    expect(lineageAt(T0 + 20).parentSpanId).toBe(spanId(1));
    expect(getContinuationStats().open).toBe(2);
  });
});

describe('registry hygiene', () => {
  it('ignores a settle for a span id that was never registered', () => {
    expect(() => {
      settleContinuation(spanId(99), T0);
    }).not.toThrow();

    // Normal, not exceptional: the pending entry may have been dropped by a
    // bound, or the agent may have been armed mid-request. No phantom window.
    expect(getLineage(T0)).toBeUndefined();
    expect(getContinuationStats()).toEqual(EMPTY_STATS);
  });

  it('cancels a pending request so a later settle cannot open a window', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });

    cancelPendingContinuation(spanId(1));
    settleContinuation(spanId(1), T0 + 100);

    expect(getLineage(T0 + 110)).toBeUndefined();
    // Withdrawn, so counted in neither `settled` nor `dropped`: nothing was
    // lost, the caller took it back.
    expect(getContinuationStats()).toEqual(EMPTY_STATS);
  });

  it('cancels only the request it names', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(2), startedAt: T0 });

    cancelPendingContinuation(spanId(1));
    settleContinuation(spanId(2), T0 + 100);

    expect(lineageAt(T0 + 110).parentSpanId).toBe(spanId(2));
    expect(getContinuationStats().pending).toBe(0);
  });

  it('ignores a cancel for an unknown span id', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });

    expect(() => {
      cancelPendingContinuation(spanId(99));
    }).not.toThrow();

    expect(getContinuationStats().pending).toBe(1);
  });

  it('matches a padded id to the entry it registered', () => {
    // Trimming happens on both the write and the read path, through one
    // helper, so a caller that pads an id registers and settles one entry.
    registerPendingContinuation({
      traceId: `  ${traceId(1)}  `,
      spanId: `\t${spanId(1)}\n`,
      startedAt: T0,
    });
    settleContinuation(` ${spanId(1)} `, T0 + 100);

    expect(lineageAt(T0 + 110)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(1),
      ambiguous: false,
      candidates: [],
    });
  });

  it('forgets both registries and zeroes the counters on reset', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 });
    openWindow({ trace: 1, request: 3, startedAt: T0, settledAt: T0 });
    expect(getLineage(T0 + CONTINUATION_WINDOW_MS)).toBeUndefined();
    expect(getContinuationStats()).not.toEqual(EMPTY_STATS);

    resetContinuations();

    // What `./agent.ts` calls on full detach: a dormant agent holds no
    // reference to any request the page made (AAP §0.5.1).
    expect(getContinuationStats()).toEqual(EMPTY_STATS);
    expect(getLineage(T0)).toBeUndefined();
  });

  it('accepts a diagnostic request label without emitting it', () => {
    registerPendingContinuation({
      traceId: traceId(1),
      spanId: spanId(1),
      name: 'GET /api/example',
      startedAt: T0,
    });
    settleContinuation(spanId(1), T0 + 100);

    // The label is diagnostic only: the attribution carries ids and flags.
    expect(lineageAt(T0 + 110)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(1),
      ambiguous: false,
      candidates: [],
    });
  });
});

describe('bounds', () => {
  it('drops the oldest in-flight request once the pending map is full', () => {
    for (let seed = 1; seed <= MAX_PENDING_CONTINUATIONS; seed += 1) {
      registerPendingContinuation({
        traceId: traceId(1),
        spanId: spanId(seed),
        startedAt: T0 + seed,
      });
    }
    expect(getContinuationStats()).toEqual({
      pending: MAX_PENDING_CONTINUATIONS,
      open: 0,
      settled: 0,
      expired: 0,
      dropped: 0,
    });

    registerPendingContinuation({
      traceId: traceId(1),
      spanId: spanId(MAX_PENDING_CONTINUATIONS + 1),
      startedAt: T0 + MAX_PENDING_CONTINUATIONS + 1,
    });

    // The map stays bounded, and the discard is reported: a rising `dropped`
    // is how a trace that came out shorter than its interaction is explained.
    expect(getContinuationStats()).toEqual({
      pending: MAX_PENDING_CONTINUATIONS,
      open: 0,
      settled: 0,
      expired: 0,
      dropped: 1,
    });
  });

  it('drops the request that had been in flight longest, keeping the newest', () => {
    for (let seed = 1; seed <= MAX_PENDING_CONTINUATIONS + 1; seed += 1) {
      registerPendingContinuation({
        traceId: traceId(1),
        spanId: spanId(seed),
        startedAt: T0 + seed,
      });
    }

    settleContinuation(spanId(1), T0 + 1000);
    settleContinuation(spanId(MAX_PENDING_CONTINUATIONS + 1), T0 + 1001);

    // The first registration is gone, so its settle opens nothing; the newest
    // one still parents its render.
    expect(lineageAt(T0 + 1002)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(MAX_PENDING_CONTINUATIONS + 1),
      ambiguous: false,
      candidates: [],
    });
    expect(getContinuationStats().settled).toBe(1);
  });

  it('keeps at most the open-window bound, evicting the least recently settled', () => {
    for (let seed = 1; seed <= MAX_OPEN_CONTINUATIONS + 1; seed += 1) {
      openWindow({ trace: 1, request: seed, startedAt: T0, settledAt: T0 + 1000 + seed });
    }

    expect(getContinuationStats()).toEqual({
      pending: 0,
      open: MAX_OPEN_CONTINUATIONS,
      settled: MAX_OPEN_CONTINUATIONS + 1,
      expired: 0,
      dropped: 1,
    });

    const lineage = lineageAt(T0 + 1002 + MAX_OPEN_CONTINUATIONS);
    // The victim is the smallest `settledAt`, never the newest window — the
    // one the arbitration would have chosen.
    expect(lineage.parentSpanId).toBe(spanId(MAX_OPEN_CONTINUATIONS + 1));
    expect(lineage.candidates).not.toContain(spanId(1));
  });

  it('truncates the candidate list to the candidate bound', () => {
    for (let seed = 1; seed <= MAX_OPEN_CONTINUATIONS; seed += 1) {
      openWindow({ trace: 1, request: seed, startedAt: T0, settledAt: T0 + 1000 + seed });
    }

    const expected: string[] = [];
    for (
      let seed = MAX_OPEN_CONTINUATIONS - 1;
      seed > MAX_OPEN_CONTINUATIONS - 1 - MAX_LINEAGE_CANDIDATES;
      seed -= 1
    ) {
      expected.push(spanId(seed));
    }

    const lineage = lineageAt(T0 + 1001 + MAX_OPEN_CONTINUATIONS);
    // More losers are open than the list may carry, so the truncation is the
    // behaviour under test rather than an accident of the fixture size.
    expect(getContinuationStats().open - 1).toBeGreaterThan(MAX_LINEAGE_CANDIDATES);
    expect(lineage.parentSpanId).toBe(spanId(MAX_OPEN_CONTINUATIONS));
    expect(lineage.candidates).toHaveLength(MAX_LINEAGE_CANDIDATES);
    expect(lineage.candidates).toEqual(expected);
  });

  it('prunes a request that outlived the pending deadline on the next mutation', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });

    registerPendingContinuation({
      traceId: traceId(1),
      spanId: spanId(2),
      startedAt: T0 + PENDING_MAX_AGE_MS,
    });

    // A request that never settles — the page navigated, the socket hung —
    // must not hold a slot for the lifetime of the document.
    expect(getContinuationStats()).toEqual({
      pending: 1,
      open: 0,
      settled: 0,
      expired: 0,
      dropped: 1,
    });

    settleContinuation(spanId(1), T0 + PENDING_MAX_AGE_MS);

    // The settle names an entry the registration above already pruned, so it
    // finds nothing: no window, and one lost request still counted once.
    expect(getLineage(T0 + PENDING_MAX_AGE_MS)).toBeUndefined();
    expect(getContinuationStats()).toEqual({
      pending: 1,
      open: 0,
      settled: 0,
      expired: 0,
      dropped: 1,
    });
  });

  it('prunes an aged pending request on a read as well', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });

    expect(getLineage(T0 + PENDING_MAX_AGE_MS)).toBeUndefined();

    expect(getContinuationStats()).toEqual({
      pending: 0,
      open: 0,
      settled: 0,
      expired: 0,
      dropped: 1,
    });
  });

  it('still promotes a settle that arrives one millisecond before the pending deadline', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });

    // A slow response is still a response: inside the deadline the entry is
    // live, so it opens a window and parents the work it caused.
    settleContinuation(spanId(1), T0 + PENDING_MAX_AGE_MS - 1);

    expect(lineageAt(T0 + PENDING_MAX_AGE_MS - 1)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(1),
      ambiguous: false,
      candidates: [],
    });
    expect(getContinuationStats()).toEqual({
      pending: 0,
      open: 1,
      settled: 1,
      expired: 0,
      dropped: 0,
    });
  });

  it('discards a settle that arrives at exactly the pending deadline', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });

    // The pending deadline is inclusive, exactly as the window's is: at
    // `startedAt + PENDING_MAX_AGE_MS` the entry is already gone, and it is
    // gone on the settle path too. Reaching the settle first must not let a
    // stale request escape the deadline and open a fresh window.
    settleContinuation(spanId(1), T0 + PENDING_MAX_AGE_MS);

    expect(getLineage(T0 + PENDING_MAX_AGE_MS)).toBeUndefined();
    // Counted as the loss it is — `dropped`, once — and never as a settle:
    // nothing opened a window, so `settled` would be a false claim.
    expect(getContinuationStats()).toEqual({
      pending: 0,
      open: 0,
      settled: 0,
      expired: 0,
      dropped: 1,
    });
  });

  it('attributes nothing to a request whose settle arrives long past the deadline', () => {
    registerPendingContinuation({ traceId: traceId(1), spanId: spanId(1), startedAt: T0 });

    // The misattribution the deadline exists to prevent: a request left
    // behind by a navigation, or one whose registration and settle arrived out
    // of order, settling minutes later. Promoting it would give it a fresh
    // CONTINUATION_WINDOW_MS in which the next unrelated commit, state
    // transition or request would inherit its trace — the ambient
    // current-trace failure, wearing a different name.
    settleContinuation(spanId(1), T0 + PENDING_MAX_AGE_MS * 2);

    expect(getLineage(T0 + PENDING_MAX_AGE_MS * 2)).toBeUndefined();
    expect(getLineage(T0 + PENDING_MAX_AGE_MS * 2 + 1)).toBeUndefined();
    expect(getLineage(T0 + PENDING_MAX_AGE_MS * 2 + CONTINUATION_WINDOW_MS - 1)).toBeUndefined();
    expect(getContinuationStats()).toEqual({
      pending: 0,
      open: 0,
      settled: 0,
      expired: 0,
      dropped: 1,
    });
  });
});

describe('malformed input', () => {
  it('ignores a registration without a usable trace id', () => {
    expect(() => {
      registerPendingContinuation({ traceId: '', spanId: spanId(1), startedAt: T0 });
    }).not.toThrow();

    expect(getContinuationStats()).toEqual(EMPTY_STATS);
  });

  it('ignores a registration whose span id is only whitespace', () => {
    expect(() => {
      registerPendingContinuation({ traceId: traceId(1), spanId: '   ', startedAt: T0 });
    }).not.toThrow();

    expect(getContinuationStats()).toEqual(EMPTY_STATS);
  });

  it('ignores a registration that is not an object at all', () => {
    expect(() => {
      registerPendingContinuation(undefined as never);
    }).not.toThrow();
    expect(() => {
      registerPendingContinuation(null as never);
    }).not.toThrow();

    expect(getContinuationStats()).toEqual(EMPTY_STATS);
  });

  it('ignores a settle and a cancel whose span id is unusable', () => {
    expect(() => {
      settleContinuation('');
      settleContinuation(undefined as never);
      cancelPendingContinuation('   ');
      cancelPendingContinuation(undefined as never);
    }).not.toThrow();

    expect(getContinuationStats()).toEqual(EMPTY_STATS);
  });

  it('writes no attributes when the bag is not an object', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 });
    const lineage = lineageAt(T0 + 1);

    expect(() => {
      applyLineageAttributes(undefined as never, lineage);
      applyLineageAttributes(null as never, lineage);
    }).not.toThrow();
  });

  it('writes no attributes when there is no attribution to write', () => {
    const attributes: Record<string, unknown> = {};

    expect(() => {
      applyLineageAttributes(attributes, undefined as never);
      applyLineageAttributes(attributes, null as never);
    }).not.toThrow();

    expect(Object.keys(attributes)).toHaveLength(0);
  });

  it('costs one annotation and no exception on a frozen attribute bag', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 });
    const frozen: Record<string, unknown> = Object.freeze({});

    // The annotation is lost, the event is not: this runs inside React's
    // commit callback, where an exception would break the page being debugged.
    expect(() => {
      applyLineageAttributes(frozen, lineageAt(T0 + 1));
    }).not.toThrow();

    expect(Object.keys(frozen)).toHaveLength(0);
  });

  describe('a non-finite timestamp, on a pinned clock', () => {
    // The one path in the module that consults a clock: `instant()` degrades a
    // non-finite (or absent) timestamp to `nowEpochMs()` from `./transport.js`,
    // which is `performance.timeOrigin + performance.now()` when both are
    // finite and `Date.now()` otherwise. Reading the *live* clock here would
    // make these cases prove only that a two-second window happens to still be
    // open on this host at this moment, so the clock is pinned and the exact
    // instant the fallback resolves to is what the assertions name — both
    // sides of the window boundary included. This is the only block in the
    // suite that touches a clock at all; the rest run on injected timestamps
    // (see the module docblock).

    /** The document time origin these cases pin `performance` to. */
    const PINNED_TIME_ORIGIN = 1_700_000_000_000;

    /**
     * The `performance.now()` reading each case starts from.
     *
     * Fractional on purpose: `nowEpochMs()` keeps microsecond resolution
     * (`round3`), so a pinned instant with a fraction proves the fallback is
     * the high-resolution pair and not a whole-millisecond `Date.now()`.
     */
    const PINNED_RELATIVE_MS = 250.5;

    /** The exact epoch instant `instant()`'s fallback resolves to. */
    const PINNED_NOW = PINNED_TIME_ORIGIN + PINNED_RELATIVE_MS;

    /** The pinned `performance.now()` reading, movable within a case. */
    let relativeMs = PINNED_RELATIVE_MS;

    /** The host's own `timeOrigin` descriptor, when it has one to restore. */
    let hostTimeOrigin: PropertyDescriptor | undefined;

    /** Move the pinned clock so the fallback resolves to `at`. */
    function pinClockTo(at: number): void {
      relativeMs = at - PINNED_TIME_ORIGIN;
    }

    beforeEach(() => {
      relativeMs = PINNED_RELATIVE_MS;
      hostTimeOrigin = Object.getOwnPropertyDescriptor(performance, 'timeOrigin');
      // `timeOrigin` is an accessor on `Performance.prototype` rather than an
      // own value, so it is shadowed by an own property instead of assigned
      // to — which works whatever the accessor does with a write. The
      // descriptor captured above is what restores a host that publishes
      // `timeOrigin` as an own property, rather than stripping it.
      Object.defineProperty(performance, 'timeOrigin', {
        value: PINNED_TIME_ORIGIN,
        configurable: true,
      });
      vi.spyOn(performance, 'now').mockImplementation(() => relativeMs);
      // `nowEpochMs()` falls back to `Date.now()` when it cannot read the pair
      // above, so both readings are pinned to the same instant: whichever
      // branch the transport takes, the answer is `PINNED_NOW`.
      vi.spyOn(Date, 'now').mockImplementation(() => PINNED_TIME_ORIGIN + relativeMs);
    });

    afterEach(() => {
      // Vitest 5 clears mocks between cases but does not restore them
      // (`restoreMocks` is false), so the spies and the shadowing property are
      // removed here — the rest of the suite must see the host's own clock.
      vi.restoreAllMocks();
      if (hostTimeOrigin === undefined) {
        Reflect.deleteProperty(performance, 'timeOrigin');
      } else {
        Object.defineProperty(performance, 'timeOrigin', hostTimeOrigin);
      }
    });

    it('pins the clock the fallback reads, at microsecond resolution', () => {
      // The harness case for this block: were the shadowing to stop working,
      // every assertion below would quietly go back to reading the live clock
      // and would stop proving anything about the instant.
      expect(performance.timeOrigin).toBe(PINNED_TIME_ORIGIN);
      expect(performance.now()).toBe(PINNED_RELATIVE_MS);
      expect(Date.now()).toBe(PINNED_NOW);
      expect(Number.isInteger(PINNED_NOW)).toBe(false);
    });

    it('attributes an event when the registration, the settle and the read are all unusable', () => {
      registerPendingContinuation({
        traceId: traceId(1),
        spanId: spanId(1),
        startedAt: Number.NaN,
      });
      settleContinuation(spanId(1), Number.POSITIVE_INFINITY);

      // `NaN`, `Infinity` and `-Infinity` all resolve to the same pinned
      // instant, and the module only ever compares timestamps from one
      // caller — so the read still finds the window the settle opened. Which
      // instant that window is anchored to is what the next case pins.
      expect(getLineage(Number.NEGATIVE_INFINITY)).toEqual({
        traceId: traceId(1),
        parentSpanId: spanId(1),
        ambiguous: false,
        candidates: [],
      });
      // `startedAt` fell back to the same instant as `settledAt`, so the entry
      // was live at its settle and was promoted rather than aged out — which
      // it would not have been had the two fallbacks resolved differently.
      expect(getContinuationStats()).toEqual({
        pending: 0,
        open: 1,
        settled: 1,
        expired: 0,
        dropped: 0,
      });
    });

    it('closes that window on the inclusive boundary measured from the pinned instant', () => {
      registerPendingContinuation({
        traceId: traceId(1),
        spanId: spanId(1),
        startedAt: Number.NaN,
      });
      settleContinuation(spanId(1), Number.POSITIVE_INFINITY);

      // The boundary the live clock made unassertable: open one millisecond
      // before `PINNED_NOW + CONTINUATION_WINDOW_MS`, gone at exactly it.
      expect(lineageAt(PINNED_NOW + CONTINUATION_WINDOW_MS - 1).parentSpanId).toBe(spanId(1));
      expect(getLineage(PINNED_NOW + CONTINUATION_WINDOW_MS)).toBeUndefined();
      expect(getContinuationStats().expired).toBe(1);
    });

    it('resolves a non-finite read to the pinned instant, both sides of the deadline', () => {
      openWindow({ trace: 1, request: 1, startedAt: PINNED_NOW, settledAt: PINNED_NOW });

      pinClockTo(PINNED_NOW + CONTINUATION_WINDOW_MS - 1);
      expect(lineageAt(Number.NaN).parentSpanId).toBe(spanId(1));

      // Moving the pinned clock onto the deadline is what closes the window,
      // and a read with no usable `now` sees exactly that instant.
      pinClockTo(PINNED_NOW + CONTINUATION_WINDOW_MS);
      expect(getLineage(Number.NaN)).toBeUndefined();
      expect(getContinuationStats()).toEqual({
        pending: 0,
        open: 0,
        settled: 1,
        expired: 1,
        dropped: 0,
      });
    });

    it('ages pending requests from the pinned instant on a non-finite interaction', () => {
      openWindow({ trace: 1, request: 1, startedAt: PINNED_NOW, settledAt: PINNED_NOW });
      registerPendingContinuation({
        traceId: traceId(1),
        spanId: spanId(2),
        startedAt: PINNED_NOW - PENDING_MAX_AGE_MS,
      });
      registerPendingContinuation({
        traceId: traceId(1),
        spanId: spanId(3),
        startedAt: PINNED_NOW - PENDING_MAX_AGE_MS + 1,
      });

      expect(() => {
        notifyInteraction(Number.NaN);
      }).not.toThrow();

      // The fallback resolved to exactly `PINNED_NOW`: the open window closed
      // as neither an expiry nor a drop, the request at the inclusive pending
      // deadline aged out, and the one a millisecond inside it survived.
      expect(getContinuationStats()).toEqual({
        pending: 1,
        open: 0,
        settled: 1,
        expired: 0,
        dropped: 1,
      });

      settleContinuation(spanId(3), PINNED_NOW);

      expect(lineageAt(PINNED_NOW).parentSpanId).toBe(spanId(3));
    });
  });
});

describe('purity', () => {
  it('reads a window twice with the same answer and without consuming it', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 100 });

    const first = lineageAt(T0 + 200);
    const second = lineageAt(T0 + 200);

    // A commit stamps one attribution onto many component events, so a read
    // must be repeatable: `getLineage` answers, it does not take.
    expect(second).toEqual(first);
    expect(getContinuationStats()).toEqual({
      pending: 0,
      open: 1,
      settled: 1,
      expired: 0,
      dropped: 0,
    });
  });

  it('allocates a fresh candidate array for every read', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 20 });

    const first = lineageAt(T0 + 30);
    const second = lineageAt(T0 + 30);

    expect(first.candidates).toEqual(second.candidates);
    // A caller may keep, sort or mutate what it was handed without changing
    // what the next reader sees.
    expect(first.candidates).not.toBe(second.candidates);

    first.candidates.push(spanId(9));
    expect(lineageAt(T0 + 30).candidates).toEqual([spanId(1)]);
  });

  it('writes a copy of the candidate list, so one event cannot rewrite another', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 20 });
    const lineage = lineageAt(T0 + 30);

    const firstEvent: Record<string, unknown> = {};
    const secondEvent: Record<string, unknown> = {};
    applyLineageAttributes(firstEvent, lineage);
    applyLineageAttributes(secondEvent, lineage);

    const written = firstEvent[CANDIDATES_KEY];
    expect(Array.isArray(written)).toBe(true);
    (written as string[]).push(spanId(9));

    // One attribution stamps a whole commit's worth of events; a shared array
    // would let a later mutation rewrite the history of the earlier ones.
    expect(secondEvent[CANDIDATES_KEY]).toEqual([spanId(1)]);
    expect(lineage.candidates).toEqual([spanId(1)]);
  });

  it('mutates only the record it is handed', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 });
    const stamped: Record<string, unknown> = {};
    const untouched: Record<string, unknown> = {};

    applyLineageAttributes(stamped, lineageAt(T0 + 1));

    expect(Object.keys(stamped)).toEqual([MECHANISM_KEY]);
    expect(Object.keys(untouched)).toHaveLength(0);
  });

  it('leaves the attributes the event already carried alone', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 20 });
    const attributes: Record<string, unknown> = { 'harness.marker': 'kept' };

    applyLineageAttributes(attributes, lineageAt(T0 + 30));

    expect(attributes['harness.marker']).toBe('kept');
    for (const key of Object.keys(attributes)) {
      if (key === 'harness.marker') {
        continue;
      }
      expect(LINEAGE_ATTRIBUTE_KEYS).toContain(key);
    }
  });

  it('is idempotent: stamping twice leaves the same attributes', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });
    openWindow({ trace: 1, request: 2, startedAt: T0, settledAt: T0 + 20 });
    const lineage = lineageAt(T0 + 30);
    const once: Record<string, unknown> = {};
    const twice: Record<string, unknown> = {};

    applyLineageAttributes(once, lineage);
    applyLineageAttributes(twice, lineage);
    applyLineageAttributes(twice, lineage);

    expect(twice).toEqual(once);
  });

  it('answers the same for one call sequence however the timestamps are spelled', () => {
    // The module is a pure function of its call sequence and the instants it
    // was handed: no clock is consulted for a finite value, so the same
    // sequence replayed on a different base gives the same shape of answer.
    const base = T0 * 7;
    openWindow({ trace: 1, request: 1, startedAt: base, settledAt: base + 100 });
    openWindow({ trace: 1, request: 2, startedAt: base, settledAt: base + 150 });

    expect(lineageAt(base + 160)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(2),
      ambiguous: true,
      candidates: [spanId(1)],
    });
  });
});

describe('the lifecycle adapter', () => {
  // `./agent.ts` drives every producer in this folder through one registry of
  // attach/detach/isAttached triples, so that disarming a capture is one
  // ordered walk over every family and not a hand-kept list of calls — which
  // is what this module's reset used to depend on. These cases pin the
  // adapter's own semantics; they hand the module back detached, which is its
  // state at import.
  afterEach(() => {
    detachContinuations();
  });

  it('starts detached and arms on request, idempotently', () => {
    expect(isContinuationsAttached()).toBe(false);

    attachContinuations();
    expect(isContinuationsAttached()).toBe(true);

    attachContinuations();
    expect(isContinuationsAttached()).toBe(true);
  });

  it('arms from the empty state the arbitration starts from', () => {
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });

    attachContinuations();

    expect(getContinuationStats()).toEqual(EMPTY_STATS);
    expect(getLineage(T0 + 20)).toBeUndefined();
  });

  it('keeps a running capture intact when the configuration is re-sent', () => {
    // The service worker re-sends the live `agent.config` after every
    // reconnect and after every same-origin navigation, so a second attach
    // must not discard the windows of the interaction the developer is
    // reproducing right now.
    attachContinuations();
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });

    attachContinuations();

    expect(getContinuationStats().open).toBe(1);
    expect(lineageAt(T0 + 20).parentSpanId).toBe(spanId(1));
  });

  it('releases every window, every pending request and every counter', () => {
    attachContinuations();
    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });
    registerPendingContinuation({
      traceId: traceId(1),
      spanId: spanId(2),
      startedAt: T0 + 5,
    });

    detachContinuations();

    // AAP §0.5.1's "disabled, not merely idled": a dormant agent holds no
    // reference to any request the page made.
    expect(isContinuationsAttached()).toBe(false);
    expect(getContinuationStats()).toEqual(EMPTY_STATS);
    expect(getLineage(T0 + 20)).toBeUndefined();
  });

  it('is safe to release before it was ever armed, and to re-arm afterwards', () => {
    detachContinuations();
    expect(isContinuationsAttached()).toBe(false);

    attachContinuations();
    expect(isContinuationsAttached()).toBe(true);
  });

  it('never gates the registry, because its producers are the gate', () => {
    // `./fetch.ts`, `./interaction.ts`, `./react.ts` and `./state.ts` are the
    // families the agent arms and disarms on their own flags, so nothing feeds
    // this registry while they are detached. Checking the flag here as well
    // would add a redundant comparison to the developer's click path and would
    // make a pure registry's answer depend on an attach its callers cannot
    // make.
    expect(isContinuationsAttached()).toBe(false);

    openWindow({ trace: 1, request: 1, startedAt: T0, settledAt: T0 + 10 });

    expect(lineageAt(T0 + 20)).toEqual({
      traceId: traceId(1),
      parentSpanId: spanId(1),
      ambiguous: false,
      candidates: [],
    });
  });
});
