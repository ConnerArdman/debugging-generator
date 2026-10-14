/**
 * Continuation windows: which trace an event joins **after** the synchronous
 * interaction window has closed.
 *
 * A click is over in a few milliseconds. The work it caused is not: the fetch
 * it started settles hundreds of milliseconds later, React renders the
 * response after that, and a state transition may follow the render. All of
 * that is the click's consequence, and the product's central promise — "one
 * click resolves to one ordered tree" (AAP 0.4.2) — holds only if those late
 * events carry the click's `traceId` rather than starting traces of their own.
 * This module is the one place that decision is made.
 *
 * ## Why lineage is explicit rather than ambient
 *
 * The obvious implementation is an ambient "current trace" variable: set it on
 * the interaction, read it from every later producer, clear it eventually.
 * AAP 0.4.2 rejects that — "lineage after the synchronous window is explicit
 * rather than ambient" — and the reason is what an ambient variable does when
 * it is *wrong*. A stale current trace silently adopts unrelated later work: a
 * polling timer's fetch, an intersection observer's render, a second
 * component's state tick all join an interaction they had nothing to do with,
 * and nothing in the capture says so. The resulting tree is not incomplete, it
 * is false, and a generated panel states it as an observed fact.
 *
 * What this module keeps instead is a record per *settled request*: the
 * request's trace, the request's span, when it settled, and when its window
 * ends. An event asks {@link getLineage} whether any such record is still
 * open. When one is, the event joins that request's trace as a child of that
 * request's span — a claim with a stated basis. When none is, the answer is
 * `undefined` and the caller starts a fresh synthetic root. A missing parent
 * is visibly flagged downstream (the service's correlator attaches an orphan
 * to the trace root rather than dropping it); a *wrong* parent is invisible.
 * That asymmetry is why this module prefers `undefined` over a guess.
 *
 * ## The 2 000 ms bound
 *
 * A window is open from the moment a request settles until
 * {@link CONTINUATION_WINDOW_MS} milliseconds later, and the bound is the
 * point of the design. Rendering a response is prompt — the microtask that
 * resolves the promise, a `setState`, React's commit — so two seconds is
 * generous for the work that genuinely belongs to the response, while still
 * being short enough that the *next* unrelated render lands outside it. An
 * unbounded window is the ambient variable again, wearing a different name.
 *
 * Two things close a window early, and only one of them is a clock:
 *
 * - **Expiry.** `expiresAt <= now` closes it. The boundary is inclusive: at
 *   exactly `settledAt + CONTINUATION_WINDOW_MS` the window is already gone.
 * - **A new interaction.** {@link notifyInteraction} closes *every* open
 *   window, because once the developer clicks again, later work belongs to the
 *   new click and not to the old response.
 *
 * ## Per-request-span candidates, not per-trace
 *
 * Records are kept per request span, never collapsed per trace. AAP 0.4.2 is
 * explicit: "candidates are tracked per request span, not per trace: if more
 * than one settled request — in the same trace (parallel requests from one
 * interaction) or across traces — has an open continuation when a commit
 * lands, the commit is attributed to the most recently settled request span".
 * One interaction that fires three parallel fetches therefore produces three
 * independent records that share a `traceId` and compete with each other, and
 * records belonging to different traces compete in the same arbitration. The
 * winner's `traceId` is the one the caller adopts.
 *
 * Collapsing per trace would lose the parent: the commit would know which
 * interaction it belonged to but not which response produced it, which is
 * precisely the edge a waterfall is read for.
 *
 * ## Arbitration and the ambiguity flags
 *
 * The winner is the record with the greatest `settledAt`; ties go to the
 * record inserted last, so a producer that settles two requests on the same
 * timestamp still gets a deterministic answer. When more than one record is
 * open, the attribution is a best candidate rather than a certainty, so
 * {@link LineageAttribution} carries `ambiguous: true` and `candidates`: the
 * other open span ids, most recently settled first, bounded by
 * {@link MAX_LINEAGE_CANDIDATES}. {@link applyLineageAttributes} writes both
 * onto the event, and the `timeline` and `flame` renderers draw an ambiguous
 * edge **dashed** — the alternatives are inspectable instead of discarded, and
 * a guess is never presented as a fact.
 *
 * ## Expiry is prune-on-read; this module owns no timer
 *
 * There is no `setTimeout` here, and adding one "for cleanup" would be a
 * regression. Expiry is computed when the maps are touched — in
 * {@link getLineage}, {@link registerPendingContinuation} and
 * {@link settleContinuation} — so the module's answer is a pure function of
 * the timestamps it was handed. Three consequences, all load-bearing:
 *
 * 1. `continuation.test.ts` asserts expiry by passing timestamps, with no fake
 *    timers and no real clock.
 * 2. A page throttled in a background tab cannot leave a window open past its
 *    deadline, because nothing waits on a callback that a throttled page may
 *    never schedule.
 * 3. The agent holds no pending work, so going dormant is
 *    {@link resetContinuations} and nothing else.
 *
 * Every timestamp parameter defaults to `nowEpochMs()`, and the module only
 * ever compares two timestamps that came from the same caller — it never mixes
 * a supplied value with a read of the clock inside one decision — so a test may
 * inject any consistent time base.
 *
 * ## Consumers
 *
 * - `./fetch.ts` — {@link registerPendingContinuation} when a request starts
 *   inside an interaction (or inside an open continuation window, so chains of
 *   request → render → request keep one trace), and
 *   {@link settleContinuation} when it settles. A network **error** settles
 *   too: a rejection still triggers the React work that renders the failure,
 *   so both the fulfilment and the rejection path call it.
 *   {@link cancelPendingContinuation} withdraws a request that will never
 *   produce a response worth attributing to.
 * - `./interaction.ts` — {@link notifyInteraction} at the start of every new
 *   interaction, and `resolveEventContext()`, which falls back to
 *   {@link getLineage} once its own synchronous window has closed. That
 *   function is the **only** place the precedence between the two windows is
 *   decided (open interaction window first, then continuation lineage, then a
 *   fresh synthetic trace), which is why this module does not import it — and
 *   could not: the dependency runs one way, `./interaction.ts` → here, and the
 *   reverse would close a cycle.
 * - `./react.ts` and `./state.ts` — commits and state transitions inherit
 *   lineage through {@link getLineage} and stamp it with
 *   {@link applyLineageAttributes}.
 * - `./agent.ts` — {@link resetContinuations} on full detach, so a dormant
 *   agent holds nothing (AAP 0.5.1).
 *
 * This module mints no ids, emits no events and reads no DOM. Callers take the
 * returned `traceId`, set `parentSpanId` from the returned `parentSpanId`, and
 * own everything else.
 *
 * ## Imports: exactly two modules
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this file into the IIFE
 * injected into the developer's page at `document_start` and hard-fails on any
 * input resolving to a Node builtin, `@debuggen/protocol`,
 * `@debuggen/shared/node` or `zod`. `./transport.js` (for `nowEpochMs`) and
 * `../schema/attributes.js` (dependency-free by contract, and the owner of the
 * lineage attribute vocabulary) are the only two imports, and that is a
 * constraint rather than a coincidence.
 *
 * ## Nothing here throws
 *
 * These functions run on the page's own stack, inside the developer's click
 * handler and inside React's commit callback. An exception escaping into one
 * of those would break the application being debugged, so every export guards
 * its inputs and wraps its body: a malformed span id is ignored, a non-finite
 * timestamp degrades to the clock, a frozen attribute bag costs one
 * annotation, and no caller ever needs a `try` of its own.
 */

import { LINEAGE_ATTRIBUTE_KEYS, LINEAGE_VALUES } from '../schema/attributes.js';
import { nowEpochMs } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * Bounds
 *
 * Exported because they are contract, not tuning: `./fetch.ts` reasons about
 * the window when it decides whether a request is a continuation of an earlier
 * one, `continuation.test.ts` asserts the boundaries against these constants
 * rather than against copies of the numbers, and a panel explaining an
 * ambiguous edge can name the window it came from.
 * ---------------------------------------------------------------------------
 */

/**
 * How long a settled request keeps attracting later events, in milliseconds
 * (AAP 0.4.2: "a continuation window opens for at most 2 000 ms").
 *
 * Long enough for a promise continuation, a `setState` and React's commit;
 * short enough that the next unrelated render falls outside it.
 */
export const CONTINUATION_WINDOW_MS = 2000;

/**
 * How many in-flight requests may await a response at once.
 *
 * A page can have a great many requests in flight, and only the recent ones
 * can still win an arbitration, so the map is bounded and the oldest entry is
 * dropped to make room. The bound is what stops a page that starts requests
 * faster than it finishes them from growing this module's memory without end.
 */
export const MAX_PENDING_CONTINUATIONS = 64;

/**
 * How many settled requests may hold an open window at once.
 *
 * Smaller than {@link MAX_PENDING_CONTINUATIONS} by an order of magnitude: a
 * window lives at most {@link CONTINUATION_WINDOW_MS}, so sixteen of them open
 * simultaneously already describes a page making parallel requests in a burst,
 * and the least recently settled is the least plausible parent of whatever
 * lands next.
 */
export const MAX_OPEN_CONTINUATIONS = 16;

/**
 * How many rejected candidates an ambiguous attribution carries.
 *
 * The candidate list exists so an ambiguous edge can be inspected, not so the
 * whole open set can be serialised onto every event: eight ids is enough to
 * show what else was in flight while keeping the attribute bag small on the
 * commit path, where an ambiguous attribution repeats once per rendered
 * component.
 */
export const MAX_LINEAGE_CANDIDATES = 8;

/**
 * How long a request may stay pending before it is assumed lost, in
 * milliseconds.
 *
 * A request that never settles — the page navigated, the socket hung, the
 * agent was armed while the request was already in flight and its settle
 * arrived before its registration — would otherwise occupy a slot for the
 * lifetime of the document. Thirty seconds is far beyond any request a
 * developer is debugging interactively and far short of a leak.
 *
 * The deadline is inclusive, exactly as {@link CONTINUATION_WINDOW_MS} is: at
 * `startedAt + PENDING_MAX_AGE_MS` the entry is already gone — and gone means
 * gone on every path, so a settle arriving at or after that instant discards
 * the entry instead of promoting it (see {@link settleContinuation}).
 */
export const PENDING_MAX_AGE_MS = 30_000;

/*
 * ---------------------------------------------------------------------------
 * Attribute keys
 *
 * `../schema/attributes.ts` is the only place the lineage key strings may be
 * enumerated, and it publishes them as a `readonly string[]` group rather than
 * as a literal tuple. Positional indexing into that group would silently write
 * the wrong attribute if its declaration order ever changed (an alphabetical
 * tidy-up is enough), so each key is resolved by the suffix that identifies
 * its *role* — which is how that module documents them, and, more to the
 * point, how `../correlation/tree.ts` resolves the same three keys when it
 * reads them back. Writer and reader therefore cannot disagree under a
 * reshuffle.
 *
 * The two helpers below are deliberately duplicated from that reader rather
 * than shared: `../correlation/tree.ts` is the service-side correlator and is
 * not part of the page bundle, and a module under `../correlation/` must never
 * become an input to `esbuild.agent.mjs` for the sake of two one-line `find`
 * calls.
 * ---------------------------------------------------------------------------
 */

/** Suffix identifying the ambiguity flag within `LINEAGE_ATTRIBUTE_KEYS`. */
const AMBIGUOUS_KEY_SUFFIX = 'Ambiguous';

/** Suffix identifying the candidate-span list within `LINEAGE_ATTRIBUTE_KEYS`. */
const CANDIDATES_KEY_SUFFIX = 'Candidates';

/**
 * The first key in `keys` ending with `suffix`, or `undefined` when the group
 * carries no such key.
 *
 * `undefined` is a real answer rather than an impossibility: this module must
 * keep working — writing one attribute less — if the key group is ever
 * reshaped, because the alternative is a schema change that makes the page
 * agent throw inside a commit.
 */
function keyEndingWith(keys: readonly string[], suffix: string): string | undefined {
  return keys.find((key) => key.endsWith(suffix));
}

/**
 * The first key in `keys` ending with none of `suffixes`: the group's base
 * key, the one the qualifying flags qualify (`lineage` beside
 * `lineageAmbiguous`).
 */
function keyEndingWithNone(
  keys: readonly string[],
  suffixes: readonly string[],
): string | undefined {
  return keys.find((key) => !suffixes.some((suffix) => key.endsWith(suffix)));
}

/** The key naming the mechanism an event was attributed by. */
const LINEAGE_VALUE_KEY = keyEndingWithNone(LINEAGE_ATTRIBUTE_KEYS, [
  AMBIGUOUS_KEY_SUFFIX,
  CANDIDATES_KEY_SUFFIX,
]);

/** The key holding the ambiguity flag. */
const LINEAGE_AMBIGUOUS_KEY = keyEndingWith(LINEAGE_ATTRIBUTE_KEYS, AMBIGUOUS_KEY_SUFFIX);

/** The key holding the rejected candidate span ids. */
const LINEAGE_CANDIDATES_KEY = keyEndingWith(LINEAGE_ATTRIBUTE_KEYS, CANDIDATES_KEY_SUFFIX);

/**
 * The `LineageValue` this module writes: attribution across an asynchronous
 * boundary through a continuation window.
 *
 * Taken from the vocabulary rather than spelled out, because
 * `../correlation/tree.ts` and the panel renderers compare against that same
 * vocabulary. It is the group's first member, which is also its only member
 * today; a second attribution mechanism would add a value there and name it
 * here, never overload this one.
 */
const CONTINUATION_LINEAGE_VALUE = LINEAGE_VALUES[0];

/*
 * ---------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------
 */

/**
 * A request that has started and not yet settled.
 *
 * `spanId` is the request's own span, not the interaction's: the whole point of
 * the per-request-span model is that the response's parent is the request that
 * produced it. `traceId` is the trace the request was started in, which is the
 * trace a later event adopts if this request wins the arbitration.
 *
 * `name` is diagnostic only — a redacted request label such as a method and
 * path, kept so a debug view of this module's state reads as something other
 * than a list of hex ids. It is never emitted: nothing in this module produces
 * an event, and {@link applyLineageAttributes} writes ids and flags only.
 */
export interface PendingContinuation {
  /** Trace the request belongs to; adopted by events this request attracts. */
  traceId: string;
  /** The request's own span id; becomes the `parentSpanId` of those events. */
  spanId: string;
  /** Redacted request label, for diagnostics only. */
  name?: string;
  /** When the request started, in the caller's time base (epoch ms). */
  startedAt: number;
}

/**
 * A settled request whose continuation window has not closed yet.
 *
 * `settledAt` is the arbitration key — the most recently settled request is
 * the most plausible parent of whatever lands next — and `expiresAt` is
 * `settledAt + ` {@link CONTINUATION_WINDOW_MS}, precomputed so the read path
 * compares two numbers and does no arithmetic per candidate.
 */
export interface OpenContinuation {
  /** Trace the request belonged to. */
  traceId: string;
  /** The request's own span id. */
  spanId: string;
  /** Redacted request label, for diagnostics only. */
  name?: string;
  /** When the request started, in the caller's time base (epoch ms). */
  startedAt: number;
  /** When the request settled — fulfilled *or* rejected (epoch ms). */
  settledAt: number;
  /** The instant the window closes, inclusive: `expiresAt <= now` is closed. */
  expiresAt: number;
}

/**
 * The answer {@link getLineage} gives an event that landed after its
 * interaction's synchronous window closed.
 *
 * `ambiguous` and `candidates` are not diagnostics, they are the honesty of
 * the attribution: with two settled requests in flight, the most recently
 * settled one is a best guess, and an event that says so can be rendered as a
 * dashed edge rather than as a fact.
 */
export interface LineageAttribution {
  /** The trace the event should join — the winning request's trace. */
  traceId: string;
  /** The span the event should hang from — the winning request's span. */
  parentSpanId: string;
  /** Whether another settled request also had an open window. */
  ambiguous: boolean;
  /**
   * The other open span ids, most recently settled first, bounded by
   * {@link MAX_LINEAGE_CANDIDATES}. Empty when the attribution is
   * unambiguous; never contains `parentSpanId`.
   */
  candidates: string[];
}

/**
 * A snapshot of this module's state and counters.
 *
 * `pending` and `open` are live sizes; `settled`, `expired` and `dropped` are
 * cumulative since the last {@link resetContinuations}. The three cumulative
 * counters answer three different questions on purpose, and conflating any two
 * of them would make all three useless:
 *
 * - `settled` — requests that opened a window. The supply of lineage.
 * - `expired` — windows that ran out the {@link CONTINUATION_WINDOW_MS} clock
 *   without being closed earlier. Expected and healthy: most responses are
 *   followed by no further work.
 * - `dropped` — entries discarded *without* settling, because a bound was
 *   reached or a pending request aged out. A rising `dropped` means events are
 *   losing lineage they should have had, and is the number to look at when a
 *   trace comes out shorter than the interaction that produced it.
 *
 * Windows closed early by {@link notifyInteraction} are counted in none of the
 * three: they are neither a loss nor an expiry but the normal end of
 * continuation attribution, and counting them as expiries would hide the
 * bound-pressure signal `dropped` and `expired` exist to give.
 */
export interface ContinuationStats {
  /** In-flight requests tracked right now. */
  pending: number;
  /** Settled requests whose window is still open right now. */
  open: number;
  /** Requests that opened a window, cumulative. */
  settled: number;
  /** Windows closed by reaching their deadline, cumulative. */
  expired: number;
  /** Entries discarded without settling (bound reached, or aged out). */
  dropped: number;
}

/*
 * ---------------------------------------------------------------------------
 * State
 *
 * Two insertion-ordered `Map`s and three counters. `Map` is chosen for its
 * iteration order, which is part of the contract: the arbitration breaks a
 * `settledAt` tie by taking the entry inserted last, and both bounds evict
 * with reference to insertion order, so neither behaviour is left to an
 * object's key ordering.
 *
 * Module scope rather than a class instance: there is exactly one page
 * document per agent, the producer id is per document, and every consumer
 * (`./fetch.ts`, `./react.ts`, `./state.ts`, `./interaction.ts`) has to be
 * talking about the same windows for the model to mean anything. A second
 * instance would be a second, silently divergent answer.
 * ---------------------------------------------------------------------------
 */

/** In-flight requests, keyed by span id, in registration order. */
const pendingContinuations = new Map<string, PendingContinuation>();

/** Settled requests with an open window, keyed by span id, in settle order. */
const openContinuations = new Map<string, OpenContinuation>();

/** Requests that opened a window, cumulative. */
let settledTotal = 0;

/** Windows closed by reaching their deadline, cumulative. */
let expiredTotal = 0;

/** Entries discarded without settling, cumulative. */
let droppedTotal = 0;

/*
 * ---------------------------------------------------------------------------
 * Input guards
 *
 * Callers are siblings in the same bundle, so these guards are not defending
 * against a hostile caller — they are defending the developer's page against
 * an exception thrown inside their own click handler. A bad input costs the
 * lineage of one event; a thrown error costs the application.
 * ---------------------------------------------------------------------------
 */

/**
 * A correlation id as this module stores it: a non-empty string, trimmed.
 *
 * Deliberately **not** validated against the hex shapes in `./ids.ts`. That
 * module owns the id format and is the only place it may be defined; a second
 * copy of the pattern here would be a second definition to keep in step, and
 * it would buy nothing — an id of the right shape but the wrong value is
 * equally undetectable. Ids are opaque keys to this module.
 *
 * Trimming happens on both the write and the read path, through this one
 * helper, so a caller that passes a padded id registers and settles the same
 * entry.
 */
function correlationId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * A usable instant: the supplied timestamp when it is a finite number, and the
 * current one otherwise.
 *
 * Any finite value is accepted, including zero and negatives. The module only
 * ever compares timestamps that came from the same caller, so a test may drive
 * it on a small synthetic scale; rejecting anything but a plausible epoch
 * value would buy no correctness and cost that.
 */
function instant(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return nowEpochMs();
  }
  return value;
}

/** A diagnostic label: a non-empty string, or nothing at all. */
function optionalName(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length === 0 ? undefined : value;
}

/*
 * ---------------------------------------------------------------------------
 * Pruning and bounds
 *
 * Every expiry in this module happens here, on a mutation or a read, and never
 * on a timer. See the module doc for why that is a design constraint rather
 * than an omission.
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a pending request has reached its {@link PENDING_MAX_AGE_MS}
 * deadline by `now`.
 *
 * The single expression of that deadline, read by every phase that has to
 * apply it — the prune pass below and the settle phase — so the two can never
 * drift apart: an entry {@link pruneAgedPending} would discard is exactly an
 * entry {@link settleContinuation} refuses to promote. The comparison is
 * inclusive, matching the window's.
 */
function hasAgedOut(entry: PendingContinuation, now: number): boolean {
  return now - entry.startedAt >= PENDING_MAX_AGE_MS;
}

/**
 * Discard pending requests whose deadline has arrived, counting each in
 * `dropped`.
 *
 * A pending request that ages out never settles, so the events it would have
 * parented lose their lineage — which is exactly what `dropped` reports.
 *
 * Deleting from a `Map` while iterating it is well defined: an entry removed
 * before it is reached is simply not visited.
 */
function pruneAgedPending(now: number): void {
  if (pendingContinuations.size === 0) {
    return;
  }
  for (const [spanId, entry] of pendingContinuations) {
    if (hasAgedOut(entry, now)) {
      pendingContinuations.delete(spanId);
      droppedTotal += 1;
    }
  }
}

/**
 * Close every window whose deadline has arrived, counting each in `expired`.
 *
 * The comparison is `expiresAt <= now`, so a window is gone at exactly
 * `settledAt + ` {@link CONTINUATION_WINDOW_MS} — the boundary
 * `continuation.test.ts` pins from both sides.
 */
function pruneExpiredOpen(now: number): void {
  if (openContinuations.size === 0) {
    return;
  }
  for (const [spanId, entry] of openContinuations) {
    if (entry.expiresAt <= now) {
      openContinuations.delete(spanId);
      expiredTotal += 1;
    }
  }
}

/**
 * Drop the oldest pending request to make room, counting it in `dropped`.
 *
 * Oldest means first registered, which is the `Map`'s first key. A request
 * that has been in flight longest is the one whose response is least likely to
 * still be the parent of what lands next.
 *
 * @returns Whether an entry was dropped, which is `false` only for an empty
 * map — the condition that makes the caller's loop terminate.
 */
function dropOldestPending(): boolean {
  const [oldestSpanId] = pendingContinuations.keys();
  if (oldestSpanId === undefined) {
    return false;
  }
  pendingContinuations.delete(oldestSpanId);
  droppedTotal += 1;
  return true;
}

/**
 * Drop the least recently settled open window to make room, counting it in
 * `dropped`.
 *
 * Selected by the smallest `settledAt` rather than by insertion order, and the
 * distinction matters: a producer that settles two requests out of order would
 * otherwise have its *most* recently settled window evicted — the one the
 * arbitration would have chosen. Ties keep the earliest inserted entry as the
 * victim, which is the same choice insertion order would have made.
 *
 * @returns Whether an entry was dropped; `false` only for an empty map.
 */
function dropLeastRecentlySettled(): boolean {
  let victimSpanId: string | undefined;
  let victimSettledAt = Number.POSITIVE_INFINITY;

  for (const [spanId, entry] of openContinuations) {
    if (entry.settledAt < victimSettledAt) {
      victimSpanId = spanId;
      victimSettledAt = entry.settledAt;
    }
  }

  if (victimSpanId === undefined) {
    return false;
  }
  openContinuations.delete(victimSpanId);
  droppedTotal += 1;
  return true;
}

/*
 * ---------------------------------------------------------------------------
 * The pending phase
 * ---------------------------------------------------------------------------
 */

/**
 * Record a request that may parent later work.
 *
 * Called by `./fetch.ts` when a request starts inside an interaction, or
 * inside an open continuation window — the second case is what makes a chain
 * (click → request → render → request → render) stay one trace instead of
 * becoming two.
 *
 * Registering does **not** open a window: an in-flight request has produced
 * nothing to attribute to yet. {@link settleContinuation} is what promotes it.
 *
 * Both bounds are applied here, since this is the only call that grows the
 * pending map: aged entries are pruned first, then the oldest is dropped while
 * the map is full, then the entry is inserted. A span id is minted once per
 * request, so an id seen twice means a caller re-registered; the earlier entry
 * is replaced and the new one takes the newest position, because the later
 * registration is the one that describes the live request.
 *
 * Silently ignores an input without a usable `traceId` and `spanId`: this runs
 * inside the developer's click handler, where losing one event's lineage is a
 * far better outcome than throwing.
 *
 * @param input The request's trace, its own span id, an optional redacted
 * label, and when it started (defaults to now).
 */
export function registerPendingContinuation(input: {
  traceId: string;
  spanId: string;
  name?: string;
  startedAt?: number;
}): void {
  try {
    if (input === null || typeof input !== 'object') {
      return;
    }

    const traceId = correlationId(input.traceId);
    const spanId = correlationId(input.spanId);
    if (traceId === undefined || spanId === undefined) {
      return;
    }

    const startedAt = instant(input.startedAt);
    pruneAgedPending(startedAt);
    pruneExpiredOpen(startedAt);

    // Delete first so a re-registered id moves to the newest position rather
    // than keeping the position `Map.set` would preserve for it.
    pendingContinuations.delete(spanId);
    while (pendingContinuations.size >= MAX_PENDING_CONTINUATIONS) {
      if (!dropOldestPending()) {
        break;
      }
    }

    const entry: PendingContinuation = { traceId, spanId, startedAt };
    const name = optionalName(input.name);
    if (name !== undefined) {
      entry.name = name;
    }
    pendingContinuations.set(spanId, entry);
  } catch {
    // Unreachable in practice — every read above is of a plain value — but a
    // getter on the caller's object literal is still the page's code, and this
    // module never lets the page's code break the page through this path.
  }
}

/**
 * Withdraw a pending request without opening a window.
 *
 * For a request that will never produce a response worth attributing to: one
 * aborted before it was sent, or one whose span `./fetch.ts` decided not to
 * emit after all. The entry simply leaves, counted in neither `settled` (it
 * never settled) nor `dropped` (nothing was lost — the caller withdrew it).
 *
 * An unknown or malformed span id is ignored.
 *
 * @param spanId The span id passed to {@link registerPendingContinuation}.
 */
export function cancelPendingContinuation(spanId: string): void {
  try {
    const id = correlationId(spanId);
    if (id === undefined) {
      return;
    }
    pendingContinuations.delete(id);
  } catch {
    // See registerPendingContinuation.
  }
}

/*
 * ---------------------------------------------------------------------------
 * The settle phase
 * ---------------------------------------------------------------------------
 */

/**
 * Promote a pending request to an open continuation window.
 *
 * Called by `./fetch.ts` on **both** the fulfilment and the rejection path: a
 * network error is still a response arriving, and the React work that renders
 * the failure belongs to the request that failed just as much as a successful
 * render belongs to the request that succeeded.
 *
 * A span id that is not pending is ignored in silence, and the silence is
 * deliberate — it is the normal outcome of three unremarkable situations: the
 * pending entry was dropped by a bound, the agent was armed while the request
 * was already in flight, or the request settled twice (a `fetch` that rejects
 * after its stream began, a caller with both a `then` and a `catch`). None of
 * them is an error, and a second settle must never extend an existing window,
 * which is why the promotion consumes the pending entry.
 *
 * A pending entry that has reached its {@link PENDING_MAX_AGE_MS} deadline by
 * `settledAt` is discarded rather than promoted, and is counted in `dropped`.
 * See the comment in the body for why a stale entry must not open a window.
 *
 * The window runs from `settledAt` to `settledAt + `
 * {@link CONTINUATION_WINDOW_MS}. If the open map is full, the least recently
 * settled window makes room.
 *
 * @param spanId The settled request's span id.
 * @param settledAt When it settled (defaults to now).
 */
export function settleContinuation(spanId: string, settledAt?: number): void {
  try {
    const id = correlationId(spanId);
    if (id === undefined) {
      return;
    }

    const at = instant(settledAt);

    // Take the entry out before pruning: once it has been removed here the
    // prune pass below cannot see it, so exactly one of the two outcomes that
    // follow — promoted, or discarded as stale — accounts for it, and the two
    // counters can never both claim the same entry.
    const entry = pendingContinuations.get(id);
    if (entry !== undefined) {
      pendingContinuations.delete(id);
    }

    pruneAgedPending(at);
    pruneExpiredOpen(at);

    if (entry === undefined) {
      return;
    }

    if (hasAgedOut(entry, at)) {
      // The settle arrived at or after the pending deadline, so the entry is
      // discarded on the same inclusive rule `pruneAgedPending` applies, and
      // no window opens. Promoting it would take a request registered thirty
      // seconds or more ago — a navigation left it behind, the socket hung, or
      // its registration and its settle arrived out of order — and give it a
      // fresh CONTINUATION_WINDOW_MS in which whatever React commit, state
      // transition or request lands next inherits its trace. That is the
      // ambient-current-trace failure this module exists to prevent, and the
      // asymmetry in the module doc is why it is the worse outcome: a missing
      // parent is flagged downstream, a wrong one is invisible and a generated
      // panel then states it as an observed fact.
      //
      // Counted in `dropped` and never in `settled`, which is the accounting
      // ContinuationStats already publishes — `dropped` is "entries discarded
      // without settling (bound reached, or aged out)" and `settled` is
      // "requests that opened a window". One loss, reported exactly once, by
      // the counter a developer reads when a trace comes out short.
      droppedTotal += 1;
      return;
    }

    const open: OpenContinuation = {
      traceId: entry.traceId,
      spanId: entry.spanId,
      startedAt: entry.startedAt,
      settledAt: at,
      expiresAt: at + CONTINUATION_WINDOW_MS,
    };
    if (entry.name !== undefined) {
      open.name = entry.name;
    }

    // Same reasoning as the pending map: a re-settled id takes the newest
    // position, which is what the tie-break in getLineage reads.
    openContinuations.delete(id);
    while (openContinuations.size >= MAX_OPEN_CONTINUATIONS) {
      if (!dropLeastRecentlySettled()) {
        break;
      }
    }
    openContinuations.set(id, open);
    settledTotal += 1;
  } catch {
    // See registerPendingContinuation.
  }
}

/*
 * ---------------------------------------------------------------------------
 * The read phase
 * ---------------------------------------------------------------------------
 */

/** One open window with its insertion position, for ranking. */
interface RankedContinuation {
  /** The window. */
  entry: OpenContinuation;
  /** Its position in settle order; higher is later. */
  index: number;
}

/**
 * Order open windows most recently settled first, breaking a tie by taking the
 * entry settled last.
 *
 * The tie-break is what makes the arbitration total: two requests settling on
 * the same timestamp is ordinary (a coarsened clock, or two promises resolved
 * in one microtask checkpoint), and without a second key the winner would
 * depend on iteration order alone, which is deterministic but arbitrary.
 * Ranking by insertion instead says "the one we heard about last", which is
 * the same rule the primary key expresses.
 */
function byRecencyThenInsertion(a: RankedContinuation, b: RankedContinuation): number {
  if (a.entry.settledAt !== b.entry.settledAt) {
    return b.entry.settledAt - a.entry.settledAt;
  }
  return b.index - a.index;
}

/**
 * The trace and parent an event landing now should adopt, or `undefined` when
 * no settled request still has an open window.
 *
 * Called by `./interaction.ts`'s `resolveEventContext()` once its own
 * synchronous interaction window has closed, and through it by `./react.ts`
 * and `./state.ts` for the commits and state transitions that follow a
 * response. `undefined` means the caller starts a fresh synthetic root — the
 * right answer for work that has no evidenced cause, and a better one than a
 * guess, because a wrongly attributed event is silently wrong while a missing
 * parent is flagged by the service's correlator.
 *
 * Pruning is applied first — expired windows close and aged-out pending
 * requests are discarded — so the answer reflects `now` and not the last time
 * anything was written, and a read is enough to keep both maps from growing in
 * a phase that only reads. Bounded work either way: at most
 * {@link MAX_OPEN_CONTINUATIONS} plus {@link MAX_PENDING_CONTINUATIONS}
 * comparisons, which is what makes this safe to call once per rendered
 * component. When more than one window is open the result is
 * marked `ambiguous` and carries the other span ids as `candidates`, most
 * recently settled first and bounded by {@link MAX_LINEAGE_CANDIDATES};
 * `candidates` never contains the winner. Windows from different traces
 * compete in this one arbitration, and the winner's `traceId` is the one the
 * caller adopts (AAP 0.4.2).
 *
 * Allocates a fresh array on every call, so a caller may keep, mutate or
 * store the result without affecting the next reader.
 *
 * @param now The instant the event landed (defaults to now).
 * @returns The attribution, or `undefined` when there is no open window.
 */
export function getLineage(now?: number): LineageAttribution | undefined {
  try {
    const at = instant(now);
    pruneAgedPending(at);
    pruneExpiredOpen(at);

    if (openContinuations.size === 0) {
      return undefined;
    }

    const ranked: RankedContinuation[] = [];
    let index = 0;
    for (const entry of openContinuations.values()) {
      ranked.push({ entry, index });
      index += 1;
    }
    ranked.sort(byRecencyThenInsertion);

    const winner = ranked[0];
    if (winner === undefined) {
      return undefined;
    }

    const candidates: string[] = [];
    for (let position = 1; position < ranked.length; position += 1) {
      if (candidates.length >= MAX_LINEAGE_CANDIDATES) {
        break;
      }
      const other = ranked[position];
      if (other === undefined) {
        continue;
      }
      candidates.push(other.entry.spanId);
    }

    return {
      traceId: winner.entry.traceId,
      parentSpanId: winner.entry.spanId,
      ambiguous: ranked.length > 1,
      candidates,
    };
  } catch {
    // A read that fails yields no lineage, which the caller already handles as
    // "start a synthetic root".
    return undefined;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------
 */

/**
 * End continuation attribution because a new interaction has begun.
 *
 * Called by `./interaction.ts` at the start of every interaction. Once the
 * developer clicks again, later work belongs to the new click: leaving the old
 * windows open would let the previous response's trace adopt the new
 * interaction's renders, which is the ambient-variable failure this module
 * exists to prevent.
 *
 * The asymmetry is deliberate and is the subtle part of the lifecycle: **all
 * open windows close, and every pending request survives.** A request started
 * under the previous interaction is still in flight, its response will still
 * arrive, and the React work that renders it still needs a parent — so it is
 * allowed to settle and open a fresh window, which will then compete with
 * whatever the new interaction starts. Clearing the pending map instead would
 * silently orphan every response in flight at the moment of a second click,
 * which is precisely the moment a developer is most likely to be reproducing
 * something.
 *
 * Closing a window this way is not an expiry and is counted as neither an
 * expiry nor a drop (see {@link ContinuationStats}).
 *
 * @param now The instant the interaction began (defaults to now). Used to age
 * out pending requests, which is the one map this call does not clear.
 */
export function notifyInteraction(now?: number): void {
  try {
    const at = instant(now);
    openContinuations.clear();
    pruneAgedPending(at);
  } catch {
    // See registerPendingContinuation.
  }
}

/**
 * Forget everything: both maps and all three counters.
 *
 * Called by `./agent.ts` on full detach — an `agent.config` with every hook
 * false — so a dormant agent holds no reference to any request the page made
 * (AAP 0.5.1). Also the reset a test calls between cases, which is why it
 * zeroes the counters rather than only the maps: a cumulative counter carried
 * across cases would make every assertion about `dropped` depend on the case
 * before it.
 *
 * Because expiry never depended on a timer, there is nothing else to cancel.
 */
export function resetContinuations(): void {
  try {
    pendingContinuations.clear();
    openContinuations.clear();
    settledTotal = 0;
    expiredTotal = 0;
    droppedTotal = 0;
  } catch {
    // Best effort by construction: each step above is independent, so a
    // failure in one leaves the others done.
  }
}

/**
 * A snapshot of the maps' sizes and the cumulative counters.
 *
 * Cheap enough to call from a diagnostics view on every render: it reads two
 * `size` properties and three numbers, and traverses nothing. The sizes are
 * reported as they stand — this is the one entry point that does **not**
 * prune, because a snapshot that mutated the thing it describes would make the
 * counters depend on how often they were read.
 *
 * @returns The current counts.
 */
export function getContinuationStats(): ContinuationStats {
  return {
    pending: pendingContinuations.size,
    open: openContinuations.size,
    settled: settledTotal,
    expired: expiredTotal,
    dropped: droppedTotal,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Lifecycle adapter
 *
 * `./agent.ts` drives every producer in this folder through one registry of
 * `{ attach, detach, isAttached }` triples, so that arming and disarming a
 * capture is a single ordered walk over every family rather than a hand-kept
 * list of calls — an omission from which is a family that keeps observing
 * after a capture ends, which is exactly what AAP 0.5.1's "disabled, not
 * merely idled" forbids. This module is a *support* family: it holds no
 * listener, no observer, no patch, no timer and no subscription, only the two
 * maps and three counters above, so its adapter is an explicit no-resource one
 * — attach establishes the empty state the arbitration starts from, and detach
 * releases every reference the page's requests left behind.
 *
 * **The predicate does not gate the registry's entry points**, and that is
 * deliberate rather than an omission. `registerPendingContinuation`,
 * `settleContinuation` and `getLineage` are called from `./fetch.ts`,
 * `./interaction.ts`, `./react.ts` and `./state.ts` — families the agent arms
 * and disarms on their own flags — so *they* are the gate: nothing registers a
 * continuation unless the request producer is armed, and a detached registry
 * therefore stays empty because nothing feeds it. Gating here as well would
 * add a second, redundant check on the developer's click path and would make
 * this module's behaviour depend on an attach call its own callers have no way
 * to make.
 * ---------------------------------------------------------------------------
 */

/** Whether the agent currently holds this family attached. */
let attached = false;

/**
 * Arm the continuation registry: start from the empty state.
 *
 * Idempotent — a second call while attached changes nothing, which matters
 * because `apps/chrome-extension/src/background/agent-control.ts` re-sends the
 * live `agent.config` after every reconnect and every same-origin navigation,
 * and a re-send must not discard the windows of a capture that is still
 * running. The reset therefore happens on the transition into the attached
 * state only; `./agent.ts` calls {@link resetContinuations} separately when the
 * capture id itself changes.
 *
 * Cannot throw: the only work is clearing two maps that this module owns.
 */
export function attachContinuations(): void {
  if (attached) {
    return;
  }
  resetContinuations();
  attached = true;
}

/**
 * Disarm the continuation registry and forget every window and pending request.
 *
 * Called by `./agent.ts` on disarm — an `agent.config` with every hook false —
 * so a dormant agent holds no reference to any request the page made
 * (AAP 0.5.1). Delegates to {@link resetContinuations}, which is the same reset
 * the capture-change path uses, so there is one implementation of "forget
 * everything" rather than two.
 *
 * Safe to call when already detached, and cannot throw.
 */
export function detachContinuations(): void {
  attached = false;
  resetContinuations();
}

/**
 * Whether the continuation registry is armed right now.
 *
 * "Attached" is this folder's uniform vocabulary for an armed family, and
 * `./agent.ts` reports this predicate — not a record of what was requested —
 * in its state and diagnostics frames. For this module it is exactly the flag:
 * there is nothing else to be attached to, and {@link getContinuationStats}
 * answers what the armed family currently holds.
 */
export function isContinuationsAttached(): boolean {
  return attached;
}

/*
 * ---------------------------------------------------------------------------
 * Attribute writing
 * ---------------------------------------------------------------------------
 */

/**
 * Stamp an event's attribute bag with the lineage it was attributed by.
 *
 * This module is the **single writer** of the lineage attribute group
 * (`../schema/attributes.ts` says so in the group's own documentation), which
 * is why the function exists at all: a sibling that set those keys itself
 * would have to know their names, and two writers of one vocabulary drift.
 * `./react.ts`, `./state.ts` and `./fetch.ts` therefore pass their bag here
 * rather than assigning to it.
 *
 * What is written, and what deliberately is not:
 *
 * - The mechanism key always carries `CONTINUATION_LINEAGE_VALUE`. The reader
 *   in `../correlation/tree.ts` treats a missing or non-string value here as
 *   "no lineage at all" and then ignores the other two keys, so this one is
 *   not optional.
 * - The ambiguity key is written **only** when the attribution is ambiguous.
 *   `false` is never written: absence means unambiguous, the reader compares
 *   against `true`, and every unambiguous event — the overwhelming majority —
 *   stays one attribute smaller on a path that runs once per rendered
 *   component.
 * - The candidate key is written **only** when there is at least one
 *   candidate, for the same reason, and as a copy of the list. The copy
 *   matters: a caller may hold one {@link LineageAttribution} across a whole
 *   commit and stamp many events from it, and sharing one array would let a
 *   later mutation of one event's bag rewrite the history of the others.
 *
 * Mutates `attributes` in place and returns nothing. A frozen or otherwise
 * unwritable bag costs the annotation and nothing more — the event itself is
 * still emitted.
 *
 * @param attributes The event's attribute record, mutated in place.
 * @param lineage The attribution returned by {@link getLineage}.
 */
export function applyLineageAttributes(
  attributes: Record<string, unknown>,
  lineage: LineageAttribution,
): void {
  try {
    if (attributes === null || typeof attributes !== 'object') {
      return;
    }
    if (lineage === null || typeof lineage !== 'object') {
      return;
    }

    if (LINEAGE_VALUE_KEY !== undefined) {
      attributes[LINEAGE_VALUE_KEY] = CONTINUATION_LINEAGE_VALUE;
    }

    if (lineage.ambiguous === true && LINEAGE_AMBIGUOUS_KEY !== undefined) {
      attributes[LINEAGE_AMBIGUOUS_KEY] = true;
    }

    const candidates = lineage.candidates;
    if (
      Array.isArray(candidates) &&
      candidates.length > 0 &&
      LINEAGE_CANDIDATES_KEY !== undefined
    ) {
      attributes[LINEAGE_CANDIDATES_KEY] = [...candidates];
    }
  } catch {
    // A frozen bag, or a setter the page installed on `Object.prototype`: the
    // annotation is lost, the event is not.
  }
}
