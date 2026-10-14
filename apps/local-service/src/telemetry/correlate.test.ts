/**
 * Colocated tests for `./correlate.ts`: the **service-side** half of trace
 * correlation.
 *
 * The tree building itself is not on trial here.
 * `packages/telemetry/src/correlation/correlator.test.ts` already pins the
 * canonical order, structural nesting, orphan attachment, self-parent and cycle
 * repair, duplicate span ids, the depth guard and root affinity, and
 * duplicating any of that would only make two suites fail for one defect. What
 * is on trial is the contract this module adds on top of it, and each block
 * below exists because breaking one of these turns a capture's evidence into a
 * plausible fiction:
 *
 * 1. **A tree is never built from a batch alone.** A capture arrives as
 *    independent batches from two producers — the page agent over the bridge
 *    and the dev-server preload over HTTP — so the events of one interaction
 *    are split across calls. A batch never reads the store: it extends each
 *    cached tree of the `(sessionId, traceId)` pairs it mentions to exactly the
 *    tree a from-scratch correlation of the **complete** persisted row set
 *    would produce, or drops that tree when it cannot, and leaves an uncached
 *    pair alone. The next read of a dropped or uncached trace loads its
 *    complete row set and correlates it from scratch, once, however many
 *    batches landed in between. The first test of the ingest block is the one
 *    that proves it, and it is marked as such; the extension block pins the
 *    incremental path against a full correlation step by step — orphans, the
 *    late parents that adopt them and a demo-shaped stream of server spans
 *    landing ahead of their fetch included — and pins the one lazy rebuild a
 *    batch that moves the anchor costs.
 * 2. **Pass-through fidelity.** Orphans keep their flags, lineage attributes
 *    keep their values, `startTime` doubles keep their decimals and the
 *    cross-tier ancestry resolves end to end. This module must add nothing and
 *    remove nothing.
 * 3. **The cache tells the truth.** A batch reaches exactly the trees it
 *    changed — each extended to the full correlation of its stored rows or
 *    dropped — a read that raced a batch answers its caller and caches
 *    nothing, a purged trace stops being served, the entry bound, the weight
 *    budget and the per-entry cap are respected with and without extension
 *    indexes, and invalidation is scoped to the session (and optionally the
 *    trace) it names. A read that names a capture is built from that capture's
 *    events alone and cached under that capture, and extended with that
 *    capture's events alone, so a trace id recurring in another capture never
 *    mixes the two windows.
 * 4. **Nothing throws, and nothing leaks.** Every method answers with a
 *    `Result` whose error carries a code from the closed vocabulary, a store
 *    that throws or rejects is reported rather than propagated, a trace whose
 *    rows cannot all be read or correlated — cut off by paging, reported
 *    unreadable by the store, or not every one a node of the tree — is an
 *    error rather than a partial tree and is never cached, and no log record
 *    or error payload carries a captured span name or attribute value
 *    (AAP §0.5.2).
 *
 * ## Fixture conventions
 *
 * The repository is supplied as an in-file fake implementing only the two reads
 * the module's port declares, so nothing here opens a database, a socket or a
 * server: the `local-service` Vitest project is hermetic by contract. Every
 * fixture is synthetic and deterministic — identifiers come from
 * `@debuggen/shared`'s minting functions, timings are explicit
 * sub-millisecond offsets from one fixed epoch base, the only sources of
 * permutation and choice are a seeded linear-congruential shuffle and the
 * generator built on the same step (`seededRandom`), and no wall clock,
 * `Math.random` or real timer is read anywhere in this file. Span names are
 * invented and generic (`'handleAction'`, `'POST /api/one'`, `'SELECT rows'`):
 * nothing built here names a symbol or a route of any real project, which is
 * the same rule the product source lives under (AAP §0.5.4).
 *
 * Expectations are derived from the imported vocabularies (`ORPHAN_REASONS`,
 * `LINEAGE_ATTRIBUTE_KEYS`, `LINEAGE_VALUES`, `DEBUGGEN_ERROR_CODES`,
 * `TRACE_CACHE_LIMIT`, `TRACE_CACHE_NODE_BUDGET`, `TRACE_CACHE_MAX_TREE_NODES`,
 * `TRACE_INDEX_WEIGHT_DIVISOR`, `EXTENSION_REFUSAL_REASONS`) rather than
 * restated as literals, so a vocabulary change surfaces here as a
 * failure instead of as a stale copy that still passes.
 */

import { describe, expect, it } from 'vitest';

import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  createConsoleLogger,
  err,
  isErr,
  newCaptureId,
  newEventId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
  ok,
} from '@debuggen/shared';
import type {
  CaptureId,
  LogRecord,
  Logger,
  ProducerId,
  Result,
  SessionId,
  SpanId,
  TraceId,
} from '@debuggen/shared';
import {
  EXTENSION_REFUSAL_REASONS,
  LINEAGE_ATTRIBUTE_KEYS,
  LINEAGE_VALUES,
  ORPHAN_REASONS,
  allowedTiersFor,
  ancestorsOfSpanId,
  correlateTrace,
  findNodeBySpanId,
  flattenTrace,
  isTelemetryEvent,
} from '@debuggen/telemetry';
import type {
  TelemetryEvent,
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';

import type { TelemetryPage } from '../store/telemetry-repo.js';
import {
  CORRELATOR_MAX_DEPTH,
  TRACE_CACHE_LIMIT,
  TRACE_CACHE_MAX_TREE_NODES,
  TRACE_CACHE_NODE_BUDGET,
  TRACE_INDEX_WEIGHT_DIVISOR,
  createTraceCorrelator,
} from './correlate.js';
import type {
  CorrelateUpdate,
  CorrelatorStats,
  TelemetryRepoLike,
  TraceCorrelator,
} from './correlate.js';

/* -------------------------------------------------------------------------------------------------
 * Fixture constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The epoch millisecond every offset in this file is measured from.
 *
 * Inside the window `packages/telemetry/src/schema/event.ts` accepts, and fixed
 * rather than read from a clock: every assertion about ordering, nesting and
 * duration is then the same on every run and on every host.
 */
const BASE_TIME = 1_768_000_000_000;

/** The kind a fixture reports unless the case is about a particular signal. */
const DEFAULT_KIND: TelemetryKind = 'function';

/** The name a fixture reports unless the case states one. */
const DEFAULT_NAME = 'operation';

/**
 * The duration a fixture reports unless the case is about timing — fractional,
 * because durations are milliseconds as doubles and a suite that only ever used
 * integers would not notice a rounding conversion.
 */
const DEFAULT_DURATION_MS = 1.25;

/** The session most cases work in. */
const SESSION_A: SessionId = newSessionId();

/** A second session, for the cache-scoping and key-composition assertions. */
const SESSION_B: SessionId = newSessionId();

/** The capture most fixtures belong to. */
const CAPTURE_A1: CaptureId = newCaptureId();

/** A second capture of {@link SESSION_A}, for the enumeration narrowing. */
const CAPTURE_A2: CaptureId = newCaptureId();

/** The trace a fixture belongs to unless the case is about several traces. */
const DEFAULT_TRACE_ID: TraceId = newTraceId();

/**
 * Two producer ids in ascending order.
 *
 * `compareEventsCanonical` breaks a `startTime` tie on `producerId` before it
 * looks at `seq`, so the equal-timestamp case has to know which of the two
 * producers sorts first. Minting both and ordering them keeps that knowledge
 * explicit without hardcoding an identifier the schema would then have to
 * accept.
 *
 * @returns The smaller id first.
 */
function orderedProducerPair(): readonly [ProducerId, ProducerId] {
  const first = newProducerId();
  const second = newProducerId();
  return first < second ? [first, second] : [second, first];
}

const [PRODUCER_BROWSER, PRODUCER_SERVER] = orderedProducerPair();

/**
 * The segments of the privacy sentinel, joined at run time.
 *
 * Assembled rather than written as one literal so the privacy assertions can
 * look for **each part** of it: a log line that truncated the value, or quoted
 * a fragment of it, would still be a leak, and a single-string search would
 * miss it.
 */
const SENTINEL_SEGMENTS: readonly string[] = ['zephyrine', 'quixotry', 'vellichor'];

/** The value that must never reach a log record or an error payload. */
const SENTINEL = `${SENTINEL_SEGMENTS.join('-')}-never-log-me`;

/* -------------------------------------------------------------------------------------------------
 * Event fixtures
 * ---------------------------------------------------------------------------------------------- */

/**
 * The store's arrival counter.
 *
 * Module-level and never reset, exactly as `telemetry_events.ingest_seq` is
 * never reset: it is the final, always-distinct tie-break of the canonical
 * order, so two fixtures built anywhere in this file carry different numbers.
 */
let ingestOrdinal = 0;

/** The next arrival number; one-based, as the persisted schema requires. */
function nextIngestSeq(): number {
  ingestOrdinal += 1;
  return ingestOrdinal;
}

/** Per-producer emission counters, so every fixture of one producer differs. */
const sequences = new Map<ProducerId, number>();

/** The next zero-based `seq` for one producer. */
function nextSeq(producerId: ProducerId): number {
  const next = sequences.get(producerId) ?? 0;
  sequences.set(producerId, next + 1);
  return next;
}

/** `offsetMs` milliseconds after {@link BASE_TIME}; fractions are deliberate. */
function at(offsetMs: number): number {
  return BASE_TIME + offsetMs;
}

/**
 * The first tier the kind/tier table permits for `kind`.
 *
 * Fixtures take their tier from the table rather than stating one, so every
 * event built here satisfies the persisted schema's cross-field check by
 * construction instead of by coincidence.
 */
function firstAllowedTier(kind: TelemetryKind): TelemetryTier {
  const [tier] = allowedTiersFor(kind);
  if (tier === undefined) {
    throw new Error(`the kind/tier table lists no tier for kind "${kind}"`);
  }
  return tier;
}

/** What a case may vary about one persisted event. */
interface EventOverrides {
  readonly id?: string;
  readonly sessionId?: SessionId;
  readonly captureId?: CaptureId;
  readonly traceId?: TraceId;
  readonly spanId?: SpanId;
  readonly parentSpanId?: SpanId;
  readonly kind?: TelemetryKind;
  readonly tier?: TelemetryTier;
  readonly name?: string;
  readonly startTime?: number;
  readonly duration?: number;
  readonly attributes?: Record<string, unknown>;
  readonly status?: TelemetryStatus;
  readonly producerId?: ProducerId;
  readonly seq?: number;
  readonly ingestSeq?: number;
}

/**
 * One persisted telemetry event: every field the store holds, populated.
 *
 * @param overrides Any field the case varies.
 * @returns A fresh event `isTelemetryEvent` accepts — asserted by the harness
 * self-check below rather than assumed.
 */
function makeEvent(overrides: EventOverrides = {}): TelemetryEvent {
  const kind = overrides.kind ?? DEFAULT_KIND;
  const producerId = overrides.producerId ?? PRODUCER_BROWSER;

  return {
    id: overrides.id ?? newEventId(),
    traceId: overrides.traceId ?? DEFAULT_TRACE_ID,
    spanId: overrides.spanId ?? newSpanId(),
    ...(overrides.parentSpanId !== undefined ? { parentSpanId: overrides.parentSpanId } : {}),
    kind,
    name: overrides.name ?? DEFAULT_NAME,
    startTime: overrides.startTime ?? at(0.5),
    duration: overrides.duration ?? DEFAULT_DURATION_MS,
    tier: overrides.tier ?? firstAllowedTier(kind),
    attributes: overrides.attributes ?? {},
    status: overrides.status ?? 'ok',
    producerId,
    seq: overrides.seq ?? nextSeq(producerId),
    sessionId: overrides.sessionId ?? SESSION_A,
    captureId: overrides.captureId ?? CAPTURE_A1,
    ingestSeq: overrides.ingestSeq ?? nextIngestSeq(),
  };
}

/** Which session, capture and trace a group of fixtures belongs to. */
interface FixtureScope {
  readonly sessionId?: SessionId;
  readonly captureId?: CaptureId;
  readonly traceId?: TraceId;
}

/** One level of a nested chain: what it is, when it ran, and who emitted it. */
interface ChainStep {
  /** The kind this level reports. */
  readonly kind: TelemetryKind;
  /** Its span name; invented and generic, never a real symbol or route. */
  readonly name: string;
  /** Start offset in milliseconds from {@link BASE_TIME}, fractions included. */
  readonly offsetMs: number;
  /** Wall duration in milliseconds. */
  readonly durationMs: number;
  /** The producer that emitted it. */
  readonly producerId: ProducerId;
}

/**
 * A strictly nested chain: each step becomes the child of the step before it.
 *
 * @param steps The levels, outermost first.
 * @param scope The session, capture and trace the chain belongs to.
 * @returns One event per step, in that same (outermost-first) order — which is
 * also the order `flattenTrace` returns once the chain is correlated.
 */
function chainOf(steps: readonly ChainStep[], scope: FixtureScope = {}): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  let parentSpanId: SpanId | undefined;

  for (const step of steps) {
    const spanId = newSpanId();
    events.push(
      makeEvent({
        ...scope,
        spanId,
        ...(parentSpanId !== undefined ? { parentSpanId } : {}),
        kind: step.kind,
        name: step.name,
        startTime: at(step.offsetMs),
        duration: step.durationMs,
        producerId: step.producerId,
      }),
    );
    parentSpanId = spanId;
  }

  return events;
}

/**
 * The canonical cross-tier interaction: a click, its request, the server's
 * handling of that request, the route handler, one timed application function
 * and the query it ran.
 *
 * Six levels, three tiers and two producers — the shape AAP §0.8.4 requires one
 * click to resolve to, and the shape the timeline, the flame view and the
 * waterfall all read. The offsets carry fractions because the two producers
 * compute their `startTime` from different sources (the page's
 * `performance.timeOrigin` and the preload's `hrTime` conversion) and neither
 * lands on a whole millisecond.
 */
const CANONICAL_CHAIN_STEPS: readonly ChainStep[] = [
  {
    kind: 'interaction',
    name: 'click control',
    offsetMs: 0,
    durationMs: 1175.5,
    producerId: PRODUCER_BROWSER,
  },
  {
    kind: 'fetch',
    name: 'POST /api/one',
    offsetMs: 8.25,
    durationMs: 1112.25,
    producerId: PRODUCER_BROWSER,
  },
  {
    kind: 'http.server',
    name: 'POST /api/one',
    offsetMs: 12.125,
    durationMs: 1100.5,
    producerId: PRODUCER_SERVER,
  },
  {
    kind: 'route.handler',
    name: 'executing route handler',
    offsetMs: 12.875,
    durationMs: 1098.75,
    producerId: PRODUCER_SERVER,
  },
  {
    kind: 'function',
    name: 'handleAction',
    offsetMs: 15.5,
    durationMs: 1090.25,
    producerId: PRODUCER_SERVER,
  },
  {
    kind: 'db.query',
    name: 'SELECT rows',
    offsetMs: 18.75,
    durationMs: 640.125,
    producerId: PRODUCER_SERVER,
  },
];

/** The canonical chain as six persisted events, outermost first. */
function canonicalChain(scope: FixtureScope = {}): TelemetryEvent[] {
  return chainOf(CANONICAL_CHAIN_STEPS, scope);
}

/**
 * A chain of `length` levels: an `interaction` root and `function`
 * descendants, each one millisecond after the last.
 *
 * Used where the *shape* is incidental and the row count is the subject — the
 * paging walk and the page bound.
 */
function linearChain(length: number, scope: FixtureScope = {}): TelemetryEvent[] {
  const steps: ChainStep[] = [];

  for (let index = 0; index < length; index += 1) {
    steps.push({
      kind: index === 0 ? 'interaction' : DEFAULT_KIND,
      name: index === 0 ? 'click control' : `step ${index}`,
      offsetMs: index + 0.25,
      durationMs: length - index,
      producerId: PRODUCER_BROWSER,
    });
  }

  return chainOf(steps, scope);
}

/**
 * A seeded permutation of `items`: a Fisher–Yates shuffle driven by a linear
 * congruential generator, so "any repository order" is a *reproducible* order.
 *
 * `Math.random` is never used here. A permutation case that failed only on some
 * runs would be worse than no case at all, because the property under test —
 * that arrival and load order are unobservable in the tree — is exactly the one
 * a flaky test teaches a reader to ignore.
 *
 * @param items The array to permute; never modified.
 * @param seed Any non-zero 32-bit seed.
 * @returns A new array holding the same elements in a shuffled order.
 */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const permuted = [...items];
  let state = seed >>> 0 || 1;

  for (let index = permuted.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    const high = permuted[index];
    const low = permuted[target];
    if (high === undefined || low === undefined) {
      // Unreachable for a dense array; the check is what lets both elements be
      // used without a non-null assertion.
      continue;
    }
    permuted[index] = low;
    permuted[target] = high;
  }

  return permuted;
}

/* -------------------------------------------------------------------------------------------------
 * The injected repository
 * ---------------------------------------------------------------------------------------------- */

/** What one `listByTrace` call asked the store for. */
interface RecordedTraceLoad {
  /** The session the load was scoped to. */
  readonly sessionId: SessionId;
  /** The trace whose events were asked for. */
  readonly traceId: string;
  /** The offset the pager asked from. */
  readonly offset: number;
  /** The page size it asked for. */
  readonly limit: number | undefined;
  /** The order it asked for; correlation always reads canonically. */
  readonly sort: string | undefined;
  /**
   * The capture narrowing: present exactly when the read was capture-scoped,
   * absent for the session-wide join.
   */
  readonly captureId: CaptureId | undefined;
}

/** What one `listTraceIds` call asked the store for. */
interface RecordedIdListing {
  /** The session enumerated. */
  readonly sessionId: SessionId;
  /** The capture the enumeration was narrowed to, when it was. */
  readonly captureId: CaptureId | undefined;
}

/**
 * How one trace's load behaves.
 *
 * `throws` and `rejects` are the two shapes the module's own documentation says
 * its `try`/`catch` exists for — a double that throws, and a future
 * asynchronous store whose promise rejects — and `stalls` is the repository that
 * does not honour its own paging contract.
 *
 * The last two answer with rows and still cannot yield the whole trace:
 * `skips` is the store reporting, on every page, rows it could not reconstruct
 * (the real store's `TelemetryPage.skipped`), and `strays` is a store whose
 * trace predicate let rows of another trace into the first page — rows the
 * correlator legitimately does not consider, so the tree holds fewer nodes than
 * the rows loaded.
 */
type LoadOutcome =
  | { readonly kind: 'rows' }
  | { readonly kind: 'throws'; readonly thrown: Error }
  | { readonly kind: 'rejects'; readonly thrown: Error }
  | { readonly kind: 'refuses'; readonly error: DebuggenError }
  | { readonly kind: 'stalls' }
  | { readonly kind: 'skips'; readonly skipped: number }
  | { readonly kind: 'strays'; readonly strays: readonly TelemetryEvent[] };

/** How the fake repository answers. */
interface FakeRepoOptions {
  /**
   * How many rows one page returns. Absent means every row of the trace in a
   * single page, which is what the real store does for a trace of ordinary
   * size against its 5 000-row ceiling.
   */
  readonly pageSize?: number;
  /**
   * How many unreadable rows each page reports. Absent means none, the normal
   * case.
   */
  readonly skippedPerPage?: number;
  /**
   * Answer with promises rather than values, exercising the port's
   * `MaybePromise` return type.
   */
  readonly async?: boolean;
}

/**
 * The two reads correlation performs, plus the recordings and controls a case
 * needs.
 *
 * Deliberately not a stub of the whole repository: the module declares a
 * two-method consumer-side port, so the double implements exactly that and a
 * method added to the real repository cannot silently become a dependency of
 * correlation.
 */
interface FakeTelemetryRepo extends TelemetryRepoLike {
  /** Every `listByTrace` call, in order. */
  readonly traceLoads: readonly RecordedTraceLoad[];
  /** Every `listTraceIds` call, in order. */
  readonly idListings: readonly RecordedIdListing[];
  /** Adds rows, as a later batch's persistence would. */
  put(events: readonly TelemetryEvent[]): void;
  /**
   * Every row stored for one session and trace, in insertion order — what a
   * full correlation of the trace is computed from. Reading it records no
   * load: it is the case's view of the store, not the correlator's.
   */
  rowsOf(sessionId: SessionId, traceId: TraceId): readonly TelemetryEvent[];
  /** Drops a trace's rows, as a retention purge would. */
  purge(sessionId: SessionId, traceId: TraceId): void;
  /** How many times one trace was loaded. */
  loadsOf(traceId: TraceId): number;
  /** Makes one trace's load behave differently from here on. */
  behaveFor(traceId: TraceId, outcome: LoadOutcome): void;
  /** Makes the id enumeration fail from here on. */
  failIdListing(outcome: LoadOutcome): void;
}

/** The composite key the fake stores rows under — session **and** trace. */
function rowKey(sessionId: string, traceId: string): string {
  return `${sessionId}::${traceId}`;
}

/**
 * A repository double holding `seed` and recording every call.
 *
 * Rows are returned in the order they were put in, not in canonical order: the
 * real store orders its pages, but correlation is permutation invariant, so
 * answering in insertion order is what lets the permutation cases vary the load
 * order at all.
 *
 * @param seed The rows the store starts out holding.
 * @param options Paging, unreadable-row reporting and synchrony.
 * @returns The double, with its recordings and controls.
 */
function fakeTelemetryRepo(
  seed: readonly TelemetryEvent[] = [],
  options: FakeRepoOptions = {},
): FakeTelemetryRepo {
  const rows = new Map<string, TelemetryEvent[]>();
  const traceLoads: RecordedTraceLoad[] = [];
  const idListings: RecordedIdListing[] = [];
  const outcomes = new Map<string, LoadOutcome>();
  let idOutcome: LoadOutcome = { kind: 'rows' };

  function put(events: readonly TelemetryEvent[]): void {
    for (const event of events) {
      const key = rowKey(event.sessionId, event.traceId);
      const bucket = rows.get(key);
      if (bucket === undefined) {
        rows.set(key, [event]);
        continue;
      }
      bucket.push(event);
    }
  }

  put(seed);

  /**
   * One page of a trace, with the paging fields the walk reads.
   *
   * A capture narrowing filters the trace's rows before the page is cut, so
   * `total` and `nextOffset` describe the narrowed rows alone — what the real
   * store's `capture_id = ?` predicate does.
   *
   * A `skips` outcome for the trace overrides {@link FakeRepoOptions.skippedPerPage},
   * and a `strays` outcome appends its rows to the page read at offset zero
   * without counting them in `total` or `nextOffset`.
   */
  function pageOf(
    sessionId: string,
    traceId: string,
    offset: number,
    captureId: CaptureId | undefined,
  ): TelemetryPage {
    const bucket = rows.get(rowKey(sessionId, traceId)) ?? [];
    const all =
      captureId === undefined ? bucket : bucket.filter((event) => event.captureId === captureId);
    const size = options.pageSize ?? Math.max(all.length, 1);
    const page = all.slice(offset, offset + size);
    const readTo = offset + page.length;
    const outcome = outcomes.get(traceId);

    let nextOffset: number | undefined;
    if (outcome?.kind === 'stalls') {
      // A repository that does not advance its own offset: following it would
      // re-read the same rows forever.
      nextOffset = offset;
    } else if (readTo < all.length) {
      nextOffset = readTo;
    }

    const skipped = outcome?.kind === 'skips' ? outcome.skipped : options.skippedPerPage;
    const strays = outcome?.kind === 'strays' && offset === 0 ? outcome.strays : [];

    return {
      rows: [...page, ...strays],
      total: all.length,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      ...(skipped !== undefined ? { skipped } : {}),
    };
  }

  /** Wraps an answer in a promise when the case asked for an async store. */
  function answer<T>(
    value: Result<T, DebuggenError>,
  ): Result<T, DebuggenError> | Promise<Result<T, DebuggenError>> {
    return options.async === true ? Promise.resolve(value) : value;
  }

  return {
    traceLoads,
    idListings,
    put,

    rowsOf(sessionId, traceId) {
      return [...(rows.get(rowKey(sessionId, traceId)) ?? [])];
    },

    purge(sessionId, traceId) {
      rows.delete(rowKey(sessionId, traceId));
    },

    loadsOf(traceId) {
      return traceLoads.filter((load) => load.traceId === traceId).length;
    },

    behaveFor(traceId, outcome) {
      outcomes.set(traceId, outcome);
    },

    failIdListing(outcome) {
      idOutcome = outcome;
    },

    listByTrace(sessionId, traceId, readOptions) {
      traceLoads.push({
        sessionId,
        traceId,
        offset: readOptions?.offset ?? 0,
        limit: readOptions?.limit,
        sort: readOptions?.sort,
        captureId: readOptions?.captureId,
      });

      const outcome = outcomes.get(traceId) ?? { kind: 'rows' };
      if (outcome.kind === 'throws') {
        throw outcome.thrown;
      }
      if (outcome.kind === 'rejects') {
        return Promise.reject(outcome.thrown);
      }
      if (outcome.kind === 'refuses') {
        return answer(err(outcome.error));
      }

      return answer(
        ok(pageOf(sessionId, traceId, readOptions?.offset ?? 0, readOptions?.captureId)),
      );
    },

    listTraceIds(sessionId, captureId) {
      idListings.push({ sessionId, captureId });

      if (idOutcome.kind === 'throws') {
        throw idOutcome.thrown;
      }
      if (idOutcome.kind === 'rejects') {
        return Promise.reject(idOutcome.thrown);
      }
      if (idOutcome.kind === 'refuses') {
        return answer(err(idOutcome.error));
      }

      // Ordered by each trace's earliest event, which is the order the real
      // store's enumeration returns and the order `getTraces` must preserve.
      const earliest = new Map<string, number>();
      for (const [key, bucket] of rows) {
        if (!key.startsWith(`${sessionId}::`)) {
          continue;
        }
        for (const event of bucket) {
          if (captureId !== undefined && event.captureId !== captureId) {
            continue;
          }
          const known = earliest.get(event.traceId);
          if (known === undefined || event.startTime < known) {
            earliest.set(event.traceId, event.startTime);
          }
        }
      }

      const ids = [...earliest.entries()]
        .sort((left, right) => left[1] - right[1])
        .map(([traceId]) => traceId);

      return answer(ok(ids));
    },
  };
}

/** A repository whose trace pages are held back until the case releases them. */
interface GatedTelemetryRepo {
  /** The port to inject: every `listByTrace` answer waits for {@link release}. */
  readonly repo: TelemetryRepoLike;
  /** How many trace pages are read and waiting to be delivered. */
  held(): number;
  /** Delivers every held page, and every later one immediately. */
  release(): void;
}

/**
 * Wraps `inner` so that each trace page is **read at call time** and
 * **delivered later**, when the case calls `release`.
 *
 * That is the shape of the race the correlator guards against: a read has
 * already loaded what the store held, and before its answer is used a batch
 * lands for the same trace. Reading at call time rather than at release time
 * is the point — the held page is the pre-batch snapshot, as it would be for a
 * real read whose rows were fetched before the insert committed.
 *
 * @param inner The repository that holds the rows.
 * @returns The gated port and its controls.
 */
function gatedTelemetryRepo(inner: TelemetryRepoLike): GatedTelemetryRepo {
  const waiting: (() => void)[] = [];
  let holding = true;

  return {
    repo: {
      listByTrace(sessionId, traceId, options) {
        const page = inner.listByTrace(sessionId, traceId, options);

        if (!holding) {
          return page;
        }

        return new Promise<Result<TelemetryPage, DebuggenError>>((resolve) => {
          waiting.push(() => {
            resolve(page);
          });
        });
      },

      listTraceIds(sessionId, captureId) {
        return inner.listTraceIds(sessionId, captureId);
      },
    },

    held: () => waiting.length,

    release() {
      holding = false;
      for (const deliver of waiting.splice(0)) {
        deliver();
      }
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Log capture and assertion helpers
 * ---------------------------------------------------------------------------------------------- */

/** A logger that collects its records instead of printing them. */
interface LogCapture {
  /** The logger to inject. */
  readonly logger: Logger;
  /** Everything it was told, in order. */
  readonly records: readonly LogRecord[];
  /** All of it as one searchable string. */
  text(): string;
  /** The records emitted at one level. */
  at(level: LogRecord['level']): readonly LogRecord[];
}

/**
 * A recording logger at the lowest level, so nothing the module says is
 * filtered out before the privacy assertions can look at it.
 */
function recordingLogger(): LogCapture {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });

  return {
    logger,
    records,
    text: () => JSON.stringify(records),
    at: (level) => records.filter((record) => record.level === level),
  };
}

/**
 * Everything an error carries to a user interface or a log line, as one
 * searchable string.
 *
 * `cause` is deliberately **not** serialised: the module attaches the caught
 * value there precisely because `toPayload` does not forward it, so it is
 * reachable in a local stack trace and cannot reach a log record, a user
 * interface or the wire. Including it here would assert the opposite of the
 * documented contract.
 */
function errorText(error: DebuggenError): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    hint: error.hint,
    details: error.details,
    payload: error.toPayload(),
  });
}

/**
 * The value of a successful result, or a failure naming what came back.
 *
 * @param result The result to read.
 * @param what The call it came from, for the failure message.
 * @returns The value.
 */
function valueOf<T>(result: Result<T, DebuggenError>, what: string): T {
  if (isErr(result)) {
    throw new Error(
      `expected ${what} to succeed, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

/**
 * The error of a failed result, or a failure saying it succeeded.
 *
 * @param result The result to read.
 * @param what The call it came from, for the failure message.
 * @returns The error.
 */
function failureOf<T>(result: Result<T, DebuggenError>, what: string): DebuggenError {
  if (isErr(result)) {
    return result.error;
  }
  throw new Error(`expected ${what} to fail, but it succeeded`);
}

/**
 * The correlated tree of a successful read, or a failure saying the trace was
 * absent.
 */
function treeOf(result: Result<TraceTree | undefined, DebuggenError>, what: string): TraceTree {
  const tree = valueOf(result, what);
  if (tree === undefined) {
    throw new Error(`expected ${what} to answer with a correlated trace, not an absence`);
  }
  return tree;
}

/** The node carrying `spanId`, or a failure naming the span that went missing. */
function nodeFor(tree: TraceTree, spanId: SpanId): TraceNode {
  const node = findNodeBySpanId(tree, spanId);
  if (node === undefined) {
    throw new Error(`expected span ${spanId} to be present in trace ${tree.traceId}`);
  }
  return node;
}

/** The fixture event at `index`, or a failure naming the gap. */
function eventAt(events: readonly TelemetryEvent[], index: number): TelemetryEvent {
  const event = events[index];
  if (event === undefined) {
    throw new Error(`expected a fixture event at index ${index}`);
  }
  return event;
}

/** The span ids of `events`, in the order given. */
function spanIdsOfEvents(events: readonly TelemetryEvent[]): SpanId[] {
  return events.map((event) => event.spanId);
}

/** The span ids of `nodes`, in the order given. */
function spanIdsOfNodes(nodes: readonly TraceNode[]): SpanId[] {
  return nodes.map((node) => node.event.spanId);
}

/** The span ids of a whole tree, parent before child. */
function spanIdsOfTree(tree: TraceTree): SpanId[] {
  return spanIdsOfNodes(flattenTrace(tree));
}

/**
 * One lineage attribute key, selected from the imported vocabulary by its
 * suffix.
 *
 * The keys are read from `LINEAGE_ATTRIBUTE_KEYS` rather than written out, so a
 * rename in that vocabulary fails this file instead of leaving a fixture that
 * quietly stops carrying lineage at all. The selection mirrors how
 * `packages/telemetry`'s `lineageOf` finds the same three keys: the qualifying
 * flags end in `Ambiguous` and `Candidates`, and the mechanism is the one that
 * ends in neither.
 *
 * @param suffix The qualifier to match, or `undefined` for the mechanism key.
 * @returns That key.
 */
function lineageKey(suffix?: 'Ambiguous' | 'Candidates'): string {
  const key = LINEAGE_ATTRIBUTE_KEYS.find((candidate) =>
    suffix === undefined
      ? !candidate.endsWith('Ambiguous') && !candidate.endsWith('Candidates')
      : candidate.endsWith(suffix),
  );

  if (key === undefined) {
    throw new Error(`the lineage attribute vocabulary carries no ${suffix ?? 'mechanism'} key`);
  }
  return key;
}

/** The first member of the lineage value vocabulary: the continuation marker. */
function lineageMarker(): string {
  const [marker] = LINEAGE_VALUES;
  if (marker === undefined) {
    throw new Error('the lineage value vocabulary is empty');
  }
  return marker;
}

/** The cache bounds a case may override; each absent one takes the module default. */
interface CacheOverrides {
  readonly cacheLimit?: number;
  readonly cacheNodeBudget?: number;
  readonly maxCachedTreeNodes?: number;
}

/**
 * A correlator over `repo`, with a recording logger and the module's own
 * defaults for depth and for every cache bound the case does not override.
 */
function correlatorOver(
  repo: TelemetryRepoLike,
  logger: Logger,
  overrides: CacheOverrides = {},
): TraceCorrelator {
  return createTraceCorrelator({
    telemetry: repo,
    logger,
    cacheLimit: overrides.cacheLimit,
    cacheNodeBudget: overrides.cacheNodeBudget,
    maxCachedTreeNodes: overrides.maxCachedTreeNodes,
  });
}

/**
 * A complete counter snapshot, zero wherever the case states nothing.
 *
 * Every `toEqual` against it compares all of the correlator's counters, so a
 * counter that moves unexpectedly — or one added to {@link CorrelatorStats}
 * without a case accounting for it — fails the comparison instead of passing
 * unnoticed.
 *
 * @param values The counters the case expects to be non-zero.
 * @returns The full snapshot.
 */
function statsWith(values: Partial<CorrelatorStats>): CorrelatorStats {
  const cachedNodes = values.cachedNodes ?? 0;
  return {
    cachedTraces: 0,
    cachedNodes,
    // An entry no batch has reached carries no extension index, so its weight
    // is its node count; a case with indexed entries states the weight itself.
    cachedWeight: values.cachedWeight ?? cachedNodes,
    hits: 0,
    misses: 0,
    rebuilds: 0,
    invalidations: 0,
    extensions: 0,
    extensionNodesBuilt: 0,
    ...values,
  };
}

/**
 * The cache weight of an entry of `nodes` nodes that carries an extension
 * index: its nodes plus the index's share, rounded up.
 *
 * Derived from {@link TRACE_INDEX_WEIGHT_DIVISOR} rather than restated, so the
 * weight assertions follow the constant the module documents.
 *
 * @param nodes The tree's node count.
 * @returns The weight `remember` records for it.
 */
function indexedWeight(nodes: number): number {
  return nodes + Math.ceil(nodes / TRACE_INDEX_WEIGHT_DIVISOR);
}

/* -------------------------------------------------------------------------------------------------
 * The harness's own guarantees
 *
 * Every case below rests on these, so they are asserted rather than assumed: a
 * fixture the persisted schema would reject, a chain whose parentage was not
 * wired, or a "shuffle" that returned its input would make a passing suite
 * meaningless.
 * ---------------------------------------------------------------------------------------------- */

describe('the fixture harness', () => {
  it('builds persisted events the telemetry schema accepts', () => {
    const chain = canonicalChain();

    for (const event of chain) {
      expect(isTelemetryEvent(event)).toBe(true);
      expect(event.ingestSeq).toBeGreaterThan(0);
      expect(event.startTime).toBeGreaterThan(BASE_TIME - 1);
    }

    // Epoch-millisecond doubles with sub-millisecond fractions, and fractional
    // durations: a suite built only from whole milliseconds would not notice a
    // conversion that rounded either.
    expect(chain.some((event) => event.startTime % 1 !== 0)).toBe(true);
    expect(chain.some((event) => event.duration % 1 !== 0)).toBe(true);
  });

  it('wires the cross-tier chain across three tiers and two producers', () => {
    const chain = canonicalChain();

    expect(chain).toHaveLength(CANONICAL_CHAIN_STEPS.length);
    expect(chain.map((event) => event.kind)).toEqual(
      CANONICAL_CHAIN_STEPS.map((step) => step.kind),
    );
    expect(eventAt(chain, 0).parentSpanId).toBeUndefined();

    for (let index = 1; index < chain.length; index += 1) {
      expect(eventAt(chain, index).parentSpanId).toBe(eventAt(chain, index - 1).spanId);
    }

    expect(new Set(chain.map((event) => event.tier))).toEqual(new Set(['browser', 'server', 'db']));
    expect(new Set(chain.map((event) => event.producerId))).toEqual(
      new Set([PRODUCER_BROWSER, PRODUCER_SERVER]),
    );
    expect(new Set(chain.map((event) => event.traceId)).size).toBe(1);
  });

  it('permutes deterministically and leaves the caller array alone', () => {
    const chain = canonicalChain();
    const original = [...chain];

    const once = shuffle(chain, 20_260_919);
    const again = shuffle(chain, 20_260_919);
    const other = shuffle(chain, 7);

    expect(once).toEqual(again);
    expect(once).not.toEqual(original);
    expect(other).not.toEqual(once);
    // Same members, reordered: sorted by span id, because sorting objects
    // themselves would compare their string conversions and settle nothing.
    expect(spanIdsOfEvents(once).sort()).toEqual(spanIdsOfEvents(original).sort());
    expect(chain).toEqual(original);
  });

  it('answers with the two lineage keys and the continuation marker of the vocabulary', () => {
    expect(LINEAGE_ATTRIBUTE_KEYS).toContain(lineageKey());
    expect(LINEAGE_ATTRIBUTE_KEYS).toContain(lineageKey('Ambiguous'));
    expect(LINEAGE_ATTRIBUTE_KEYS).toContain(lineageKey('Candidates'));
    expect(new Set([lineageKey(), lineageKey('Ambiguous'), lineageKey('Candidates')]).size).toBe(3);
    expect(LINEAGE_VALUES).toContain(lineageMarker());
  });
});

/* -------------------------------------------------------------------------------------------------
 * Ingest: marking the traces a persisted batch touched stale
 * ---------------------------------------------------------------------------------------------- */

describe('bringing the traces a persisted batch touched up to date', () => {
  /*
   * THE MOST IMPORTANT TEST IN THIS FILE.
   *
   * A capture does not arrive as one batch. The page agent posts its events
   * over the bridge while the dev-server preload posts its spans over HTTP, so
   * the six events of one interaction reach the store in several calls and in
   * no particular order. If this module correlated the batch it was handed, the
   * tree for that interaction would be whatever the last batch happened to
   * contain — a click with no query under it, or a query with no click above
   * it — and every duration derived from it would be wrong in a way no reader
   * could detect.
   *
   * The contract is therefore: a batch NAMES traces, and the store SUPPLIES
   * their events when a reader asks. A batch may extend a tree that is already
   * cached, but only to the tree the complete stored set produces (the
   * extension block below proves that step by step); it never builds one.
   * Here the store holds all six rows, nothing is cached, and only the last
   * two are handed over; ingest reads nothing, and the tree the next read
   * builds must still be the whole interaction.
   */
  it('builds a touched trace from its complete stored set on the next read, never from the batch alone', async () => {
    const chain = canonicalChain();
    const repo = fakeTelemetryRepo(chain);
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const update: CorrelateUpdate = valueOf(
      await correlator.onEventsPersisted(chain.slice(-2)),
      'onEventsPersisted with the tail of a trace',
    );

    expect(update).toEqual({ tracesTouched: [DEFAULT_TRACE_ID] });
    // Ingest is proportional to the batch: no store read and no correlation.
    expect(repo.traceLoads).toHaveLength(0);
    expect(correlator.stats()).toEqual(statsWith({}));

    const tree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace after a tail batch',
    );

    expect(tree.nodeCount).toBe(chain.length);
    expect(spanIdsOfTree(tree)).toEqual(spanIdsOfEvents(chain));
    expect(tree.roots).toHaveLength(1);
    expect(tree.primaryRootSpanId).toBe(eventAt(chain, 0).spanId);
    // One load, by the read; the read after it comes from the cache.
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(1);
    expect(treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the second read')).toBe(
      tree,
    );
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(1);
  });

  it('coalesces many batches of an uncached trace into one load walk on the next read', async () => {
    const rows = linearChain(40);
    const repo = fakeTelemetryRepo([], { pageSize: 16 });
    const correlator = correlatorOver(repo, recordingLogger().logger);

    // Ten batches of four rows, each persisted and then announced, as ingest
    // does, while nobody has read the trace yet.
    for (let start = 0; start < rows.length; start += 4) {
      const batch = rows.slice(start, start + 4);
      repo.put(batch);
      valueOf(await correlator.onEventsPersisted(batch), 'onEventsPersisted for one batch');
    }

    // Ten batches of ingest, and not one store read or correlation among them:
    // an uncached trace is left for its first read.
    expect(repo.traceLoads).toHaveLength(0);
    expect(correlator.stats()).toEqual(statsWith({}));

    const tree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read after every batch',
    );

    // Exactly one walk over the trace — three pages of sixteen for forty rows —
    // however many batches landed.
    expect(repo.traceLoads.map((load) => load.offset)).toEqual([0, 16, 32]);
    // And the tree a from-scratch correlation of every stored row produces.
    expect(tree).toStrictEqual(
      correlateTrace(shuffle(rows, 9), DEFAULT_TRACE_ID, { maxDepth: CORRELATOR_MAX_DEPTH }),
    );
    expect(tree.nodeCount).toBe(rows.length);
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 1, cachedNodes: rows.length, misses: 1, rebuilds: 1 }),
    );

    // The read after it is a hit on that tree.
    expect(treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'a cache hit')).toBe(
      tree,
    );
    expect(repo.traceLoads).toHaveLength(3);
    expect(correlator.stats().hits).toBe(1);
  });

  it('extends a cached trace through many batches without one store read', async () => {
    const rows = linearChain(40);
    const repo = fakeTelemetryRepo(rows.slice(0, 4), { pageSize: 16 });
    const correlator = correlatorOver(repo, recordingLogger().logger);

    // Cached before the capture streams in, so every batch has a tree to extend.
    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the read before the batches');
    expect(repo.traceLoads).toHaveLength(1);

    // Nine more batches of four rows, each persisted and then announced.
    let expectedNodesBuilt = 0;
    for (let start = 4; start < rows.length; start += 4) {
      const batch = rows.slice(start, start + 4);
      repo.put(batch);
      valueOf(await correlator.onEventsPersisted(batch), 'onEventsPersisted for one batch');
      // A chain: the four new nodes, plus a copy of every node above them —
      // which, in a chain, is every node already cached.
      expectedNodesBuilt += batch.length + start;
    }

    // Nine batches of ingest, not one store read among them, and the tree was
    // extended by each.
    expect(repo.traceLoads).toHaveLength(1);
    expect(correlator.stats()).toEqual(
      statsWith({
        cachedTraces: 1,
        cachedNodes: rows.length,
        cachedWeight: indexedWeight(rows.length),
        misses: 1,
        rebuilds: 1,
        extensions: 9,
        extensionNodesBuilt: expectedNodesBuilt,
      }),
    );

    const tree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read after every batch',
    );

    // A hit, and the tree a from-scratch correlation of every stored row
    // produces — deeply and in serialised key order.
    const reference = correlateTrace(shuffle(rows, 9), DEFAULT_TRACE_ID, {
      maxDepth: CORRELATOR_MAX_DEPTH,
    });
    expect(tree).toStrictEqual(reference);
    expect(JSON.stringify(tree)).toBe(JSON.stringify(reference));
    expect(repo.traceLoads).toHaveLength(1);
    expect(correlator.stats().hits).toBe(1);
  });

  it('names each distinct session-and-trace pair once per batch and brings exactly their trees up to date', async () => {
    const firstTrace = newTraceId();
    const secondTrace = newTraceId();

    const firstRows = canonicalChain({ traceId: firstTrace });
    const secondRows = chainOf(CANONICAL_CHAIN_STEPS.slice(0, 2), { traceId: secondTrace });
    // The same trace id under a different session: a distinct pair, because the
    // cache key and the store read are both scoped by session.
    const otherSessionRow = makeEvent({
      sessionId: SESSION_B,
      traceId: firstTrace,
      kind: 'interaction',
      name: 'click control',
      startTime: at(0),
      duration: 12.5,
    });

    // A trace the batch never mentions, whose tree must survive it.
    const untouchedTrace = newTraceId();
    const untouchedRow = makeEvent({
      traceId: untouchedTrace,
      kind: 'interaction',
      name: 'click control',
    });

    // Cached before the batch: the first three levels of the first trace, the
    // root of the second, the other session's row and the untouched trace.
    const repo = fakeTelemetryRepo([
      ...firstRows.slice(0, 3),
      eventAt(secondRows, 0),
      otherSessionRow,
      untouchedRow,
    ]);
    const correlator = correlatorOver(repo, recordingLogger().logger);
    const pairs: readonly (readonly [SessionId, TraceId])[] = [
      [SESSION_A, firstTrace],
      [SESSION_A, secondTrace],
      [SESSION_B, firstTrace],
    ];

    const before = new Map<string, TraceTree>();
    for (const [sessionId, traceId] of [...pairs, [SESSION_A, untouchedTrace] as const]) {
      before.set(
        `${sessionId}::${traceId}`,
        treeOf(await correlator.getTrace(sessionId, traceId), 'a read before the batch'),
      );
    }
    expect(correlator.stats().cachedTraces).toBe(4);
    const loadsBefore = repo.traceLoads.length;

    // The rest of both SESSION_A traces is persisted, and announced in one
    // batch interleaved on purpose: several events of one trace name one pair,
    // the reported order is first-seen order, and the other session's pair is
    // named by a replay of its stored row alone.
    repo.put([...firstRows.slice(3), eventAt(secondRows, 1)]);
    const batch = [
      eventAt(firstRows, 3),
      eventAt(secondRows, 0),
      eventAt(firstRows, 5),
      otherSessionRow,
      eventAt(secondRows, 1),
      eventAt(firstRows, 4),
    ];

    const update = valueOf(await correlator.onEventsPersisted(batch), 'onEventsPersisted');

    expect(update.tracesTouched).toEqual([firstTrace, secondTrace, firstTrace]);
    expect(repo.traceLoads).toHaveLength(loadsBefore);
    // The two SESSION_A pairs were extended — three new levels under a copied
    // three-level path, and one new level under a copied root — and the replay
    // changed nothing. Every entry is still cached, the three a batch reached
    // now indexed.
    expect(correlator.stats()).toEqual(
      statsWith({
        cachedTraces: 4,
        cachedNodes: firstRows.length + secondRows.length + 1 + 1,
        cachedWeight:
          indexedWeight(firstRows.length) + indexedWeight(secondRows.length) + indexedWeight(1) + 1,
        misses: 4,
        rebuilds: 4,
        extensions: 2,
        extensionNodesBuilt: 3 + 3 + (1 + 1),
      }),
    );

    // Every read after the batch is a hit on a tree equal to a from-scratch
    // correlation of what the store holds for that pair.
    const expected: readonly (readonly [SessionId, TraceId, readonly TelemetryEvent[]])[] = [
      [SESSION_A, firstTrace, firstRows],
      [SESSION_A, secondTrace, secondRows],
      [SESSION_B, firstTrace, [otherSessionRow]],
    ];
    for (const [sessionId, traceId, stored] of expected) {
      const tree = treeOf(await correlator.getTrace(sessionId, traceId), 'a read after the batch');
      expect(tree).toStrictEqual(
        correlateTrace(stored, traceId, { maxDepth: CORRELATOR_MAX_DEPTH }),
      );
    }
    // The replay-only pair kept its very tree; the untouched trace kept its.
    expect(treeOf(await correlator.getTrace(SESSION_B, firstTrace), 'the replayed pair')).toBe(
      before.get(`${SESSION_B}::${firstTrace}`),
    );
    expect(
      treeOf(await correlator.getTrace(SESSION_A, untouchedTrace), 'the untouched trace'),
    ).toBe(before.get(`${SESSION_A}::${untouchedTrace}`));

    // Not one load after the batch: every pair was served from the cache.
    expect(repo.traceLoads).toHaveLength(loadsBefore);
    expect(correlator.stats().hits).toBe(5);
  });

  it('walks a trace across pages and correlates every row it read', async () => {
    const chain = linearChain(7);
    const repo = fakeTelemetryRepo(chain, { pageSize: 3 });
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const tree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace over a paged store',
    );

    expect(tree.nodeCount).toBe(chain.length);
    expect(spanIdsOfTree(tree)).toEqual(spanIdsOfEvents(chain));
    expect(repo.traceLoads.map((load) => load.offset)).toEqual([0, 3, 6]);

    for (const load of repo.traceLoads) {
      // Canonical order on the way in is what makes a paged walk safe: the
      // order is total, so no row is read twice or missed at a boundary.
      expect(load.sort).toBe('start_asc');
      expect(load.limit).toBeGreaterThan(0);
      // A read that named no capture is the session-wide join, so its trace
      // loads carry no capture narrowing.
      expect(load.captureId).toBeUndefined();
    }
  });

  it('reaches the same tree from any repository row order', async () => {
    const chain = canonicalChain();
    const orders: readonly TelemetryEvent[][] = [
      [...chain],
      [...chain].reverse(),
      shuffle(chain, 3),
      shuffle(chain, 20_260_919),
    ];

    const trees: TraceTree[] = [];
    for (const rows of orders) {
      const correlator = correlatorOver(fakeTelemetryRepo(rows), recordingLogger().logger);
      trees.push(
        treeOf(
          await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
          'getTrace over one row order',
        ),
      );
    }

    const [reference] = trees;
    if (reference === undefined) {
      throw new Error('expected one tree per row order');
    }

    for (const tree of trees) {
      expect(tree).toEqual(reference);
      expect(spanIdsOfTree(tree)).toEqual(spanIdsOfEvents(chain));
    }
  });

  it('converges when a parent arrives in a later batch', async () => {
    const neverArrivedYet = newSpanId();
    const child = makeEvent({
      parentSpanId: neverArrivedYet,
      kind: 'http.server',
      name: 'POST /api/one',
      startTime: at(12.125),
      duration: 640.5,
      producerId: PRODUCER_SERVER,
    });

    const repo = fakeTelemetryRepo([child]);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    valueOf(
      await correlator.onEventsPersisted([child]),
      'onEventsPersisted with an orphaned child',
    );

    const orphanedTree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace before the parent arrived',
    );
    const orphan = nodeFor(orphanedTree, child.spanId);

    expect(orphanedTree.nodeCount).toBe(1);
    expect(orphanedTree.orphanCount).toBe(1);
    expect(orphan.orphaned).toBe(true);
    expect(orphan.missingParentSpanId).toBe(neverArrivedYet);

    // The browser batch that carried the parent lands afterwards.
    const parent = makeEvent({
      spanId: neverArrivedYet,
      kind: 'interaction',
      name: 'click control',
      startTime: at(0),
      duration: 1175.5,
    });
    repo.put([parent]);

    const secondPass = valueOf(
      await correlator.onEventsPersisted([parent]),
      'onEventsPersisted with the late parent',
    );

    // The orphan was the trace's anchor, and its parent — the trace's first
    // genuine root — takes the anchor over: a primary change no extension
    // reproduces. The orphaned tree is gone rather than served; nothing was
    // reloaded yet.
    expect(secondPass.tracesTouched).toEqual([DEFAULT_TRACE_ID]);
    expect(correlator.stats().cachedTraces).toBe(0);
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(1);

    const converged = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace after the parent arrived',
    );

    expect(converged.nodeCount).toBe(2);
    expect(converged.orphanCount).toBe(0);
    expect(spanIdsOfNodes(ancestorsOfSpanId(converged, child.spanId))).toEqual([parent.spanId]);
    expect(nodeFor(converged, child.spanId).orphaned).toBe(false);
  });

  it('reports every trace it touched, even one the store no longer holds, and builds none of them', async () => {
    const withOrphan = newTraceId();
    const withTwoOrphans = newTraceId();
    const purgedTrace = newTraceId();

    const firstRows = canonicalChain({ traceId: withOrphan });
    const firstOrphan = makeEvent({
      traceId: withOrphan,
      parentSpanId: newSpanId(),
      kind: 'db.query',
      name: 'SELECT rows',
      startTime: at(700.75),
      duration: 12.5,
      producerId: PRODUCER_SERVER,
    });

    const secondRoot = makeEvent({
      traceId: withTwoOrphans,
      kind: 'interaction',
      name: 'click control',
      startTime: at(0),
      duration: 30,
    });
    const secondOrphans = [
      makeEvent({
        traceId: withTwoOrphans,
        parentSpanId: newSpanId(),
        kind: 'render',
        name: 'render list',
        startTime: at(4.5),
      }),
      makeEvent({
        traceId: withTwoOrphans,
        parentSpanId: newSpanId(),
        kind: 'state',
        name: 'state transition',
        startTime: at(6.25),
      }),
    ];

    // Named by the batch but absent from the store, as a trace purged by
    // retention between the insert and this call would be.
    const purgedEvent = makeEvent({ traceId: purgedTrace, kind: 'commit', name: 'commit work' });

    const repo = fakeTelemetryRepo([...firstRows, firstOrphan, secondRoot, ...secondOrphans]);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const update: CorrelateUpdate = valueOf(
      await correlator.onEventsPersisted([firstOrphan, ...secondOrphans, purgedEvent]),
      'onEventsPersisted across three traces',
    );

    expect(update.tracesTouched).toEqual([withOrphan, withTwoOrphans, purgedTrace]);
    expect(repo.traceLoads).toHaveLength(0);
    expect(correlator.stats()).toEqual(statsWith({}));

    // The parentage each trace needed repaired is the reads' to report, from
    // the complete stored set; the purged trace is an absence, not an error.
    expect(
      treeOf(await correlator.getTrace(SESSION_A, withOrphan), 'the one-orphan trace').orphanCount,
    ).toBe(1);
    expect(
      treeOf(await correlator.getTrace(SESSION_A, withTwoOrphans), 'the two-orphan trace')
        .orphanCount,
    ).toBe(2);
    expect(
      valueOf(await correlator.getTrace(SESSION_A, purgedTrace), 'the purged trace'),
    ).toBeUndefined();
    expect(correlator.stats()).toEqual(
      statsWith({
        cachedTraces: 2,
        cachedNodes: firstRows.length + 1 + 1 + secondOrphans.length,
        misses: 3,
        rebuilds: 2,
      }),
    );
  });

  it('treats an empty batch as a no-op that touches neither the store nor the cache', async () => {
    const repo = fakeTelemetryRepo(canonicalChain());
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const update = valueOf(
      await correlator.onEventsPersisted([]),
      'onEventsPersisted with nothing',
    );

    expect(update).toEqual({ tracesTouched: [] });
    expect(repo.traceLoads).toHaveLength(0);
    expect(correlator.stats()).toEqual(statsWith({}));
  });

  it('skips an event whose session or trace id is unusable rather than keying the cache on it', async () => {
    const chain = canonicalChain();
    const usable = eventAt(chain, chain.length - 1);
    // Deliberately malformed: the persisted schema rejects an empty identifier,
    // so these two rows can only come from a store written by another build.
    // The guard exists so one such row cannot key a cache entry on an empty
    // string, and so a batch carrying one still reports rather than throws.
    const withoutTrace: TelemetryEvent = { ...eventAt(chain, 1), traceId: '' };
    const withoutSession: TelemetryEvent = { ...eventAt(chain, 2), sessionId: '' };

    const repo = fakeTelemetryRepo(chain.slice(0, -1));
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the read before the batch');

    repo.put([usable]);
    const update = valueOf(
      await correlator.onEventsPersisted([usable, withoutTrace, withoutSession]),
      'onEventsPersisted with two unusable rows',
    );

    // The usable event still extends its trace's tree — one new leaf under a
    // copy of the five levels above it; the other two key nothing.
    expect(update.tracesTouched).toEqual([DEFAULT_TRACE_ID]);
    expect(repo.traceLoads).toHaveLength(1);
    expect(correlator.stats()).toEqual(
      statsWith({
        cachedTraces: 1,
        cachedNodes: chain.length,
        cachedWeight: indexedWeight(chain.length),
        misses: 1,
        rebuilds: 1,
        extensions: 1,
        extensionNodesBuilt: chain.length,
      }),
    );
    expect(
      treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the read after the batch'),
    ).toStrictEqual(correlateTrace(chain, DEFAULT_TRACE_ID, { maxDepth: CORRELATOR_MAX_DEPTH }));

    const warned = logs.at('warn');
    expect(warned).toHaveLength(1);
    expect(warned.map((record) => record.fields['ignored'])).toEqual([2]);
    expect(warned.map((record) => record.fields['batchSize'])).toEqual([3]);
  });

  it('drops every cached tree when a batch cannot be scanned, and answers with an error instead of throwing', async () => {
    const chain = canonicalChain();
    const other = newTraceId();
    const repo = fakeTelemetryRepo([
      ...chain,
      makeEvent({ traceId: other, kind: 'interaction', name: 'click control' }),
    ]);
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the first trace');
    treeOf(await correlator.getTrace(SESSION_A, other, CAPTURE_A1), 'the second trace, scoped');
    expect(correlator.stats().cachedTraces).toBe(2);

    // A hole where an event should be — no store row can produce one, so it can
    // only come from a defective caller. Which traces the batch changed is then
    // unknowable, so nothing cached may be trusted.
    const malformed = [eventAt(chain, 0), null] as unknown as readonly TelemetryEvent[];

    const outcome = await correlator.onEventsPersisted(malformed);
    const error = failureOf(outcome, 'onEventsPersisted over a malformed batch');

    expect(error.code).toBe('INTERNAL');
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.hint).toBeDefined();
    expect(correlator.stats()).toEqual(statsWith({ misses: 2, rebuilds: 2, invalidations: 2 }));
    expect(logs.at('warn').map((record) => record.fields['invalidated'])).toEqual([2]);

    // Every scope rebuilds from the store on its next read.
    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the first trace again');
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(2);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Pass-through fidelity
 *
 * What the correlator produces is what a caller gets. This module adds no node,
 * removes none, clears no flag and re-parents nothing.
 * ---------------------------------------------------------------------------------------------- */

describe('pass-through fidelity', () => {
  it('attaches an event whose parent never arrived instead of dropping it', async () => {
    const chain = canonicalChain();
    const neverArrives = newSpanId();
    const orphan = makeEvent({
      parentSpanId: neverArrives,
      kind: 'http.client',
      name: 'GET /api/two',
      startTime: at(700.375),
      duration: 430.25,
      producerId: PRODUCER_SERVER,
    });
    const rows = [...chain, orphan];

    const repo = fakeTelemetryRepo(rows);
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const tree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace over a trace with an orphan',
    );

    // The mechanical proof that nothing was dropped: every loaded row is a node
    // at some depth. A missing span would remove all the work underneath it
    // from every duration in the capture.
    expect(tree.nodeCount).toBe(rows.length);
    expect(tree.orphanCount).toBe(1);

    const attached = nodeFor(tree, orphan.spanId);
    expect(attached.orphaned).toBe(true);
    expect(attached.orphanReason).toBe(ORPHAN_REASONS[0]);
    expect(attached.missingParentSpanId).toBe(neverArrives);
    expect(attached.depth).toBe(1);
    // Under the trace root, and the span it named is genuinely absent: this is
    // a repair, not a misplacement.
    expect(spanIdsOfNodes(ancestorsOfSpanId(tree, orphan.spanId))).toEqual([
      eventAt(chain, 0).spanId,
    ]);
    expect(findNodeBySpanId(tree, neverArrives)).toBeUndefined();
    // Reported with counts, never with the span's name or attributes.
    expect(logs.text()).not.toContain(orphan.name);
  });

  it('carries the lineage attributes and the node lineage through untouched', async () => {
    const chain = canonicalChain();
    const request = eventAt(chain, 1);
    const rejectedCandidates = [newSpanId(), newSpanId()];
    // Written by the browser agent's continuation tracker when more than one
    // settled request had an open window: the attribution is the most recently
    // settled candidate rather than a certainty, and `Timeline` draws the edge
    // DASHED from `lineageAmbiguous` instead of presenting a guess as a fact.
    const lineageAttributes: Record<string, unknown> = {
      [lineageKey()]: lineageMarker(),
      [lineageKey('Ambiguous')]: true,
      [lineageKey('Candidates')]: rejectedCandidates,
      component: 'ActivityList',
      phase: 'update',
    };
    const commit = makeEvent({
      parentSpanId: request.spanId,
      kind: 'commit',
      name: 'commit work',
      startTime: at(1128.125),
      duration: 47.5,
      attributes: lineageAttributes,
    });

    const repo = fakeTelemetryRepo([...chain, commit]);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const update = valueOf(
      await correlator.onEventsPersisted([commit]),
      'onEventsPersisted with a continuation commit',
    );
    expect(update.tracesTouched).toEqual([DEFAULT_TRACE_ID]);

    const tree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace over a trace with lineage',
    );
    const node = nodeFor(tree, commit.spanId);

    expect(node.event.attributes).toEqual(lineageAttributes);
    expect(node.lineage).toEqual({
      value: lineageMarker(),
      ambiguous: true,
      candidateSpanIds: rejectedCandidates,
    });
    expect(spanIdsOfNodes(ancestorsOfSpanId(tree, commit.spanId))).toEqual([
      eventAt(chain, 0).spanId,
      request.spanId,
    ]);
  });

  it('orders two producers that share a millisecond the same way on every rebuild', async () => {
    const root = makeEvent({
      kind: 'interaction',
      name: 'click control',
      startTime: at(0),
      duration: 40.5,
    });
    // The identical double, not two values a millisecond apart: the browser
    // agent and the dev-server preload read different clocks and land in the
    // same millisecond as a matter of routine.
    const tied = at(5.125);
    const sameSeqFirst = makeEvent({
      parentSpanId: root.spanId,
      name: 'handleAction',
      startTime: tied,
      producerId: PRODUCER_BROWSER,
      seq: 1,
      ingestSeq: 41,
    });
    const sameSeqSecond = makeEvent({
      parentSpanId: root.spanId,
      name: 'handleAction',
      startTime: tied,
      producerId: PRODUCER_BROWSER,
      seq: 1,
      ingestSeq: 42,
    });
    const laterSeq = makeEvent({
      parentSpanId: root.spanId,
      name: 'handleAction',
      startTime: tied,
      producerId: PRODUCER_BROWSER,
      seq: 4,
      ingestSeq: 43,
    });
    const otherProducer = makeEvent({
      parentSpanId: root.spanId,
      name: 'handleAction',
      tier: 'server',
      startTime: tied,
      producerId: PRODUCER_SERVER,
      seq: 0,
      ingestSeq: 44,
    });

    const rows = [root, sameSeqFirst, sameSeqSecond, laterSeq, otherProducer];
    // `PRODUCER_SERVER` is the greater identifier by construction, so the two
    // events with the same `seq` separate on `ingestSeq`, the later `seq`
    // follows them, and the other producer's event sorts last.
    const expected = spanIdsOfEvents([root, sameSeqFirst, sameSeqSecond, laterSeq, otherProducer]);

    for (const seed of [11, 20_260_919]) {
      const correlator = correlatorOver(
        fakeTelemetryRepo(shuffle(rows, seed)),
        recordingLogger().logger,
      );
      const tree = treeOf(
        await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
        'getTrace over tied timestamps',
      );

      expect(spanIdsOfTree(tree)).toEqual(expected);
      expect(nodeFor(tree, sameSeqFirst.spanId).event.startTime).toBe(tied);
      expect(nodeFor(tree, otherProducer.spanId).event.startTime).toBe(tied);
    }
  });

  it('resolves the cross-tier chain to one ancestry from the query span to the interaction', async () => {
    const chain = canonicalChain();
    const repo = fakeTelemetryRepo(shuffle(chain, 5));
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const tree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace over the canonical chain',
    );

    const query = eventAt(chain, CANONICAL_CHAIN_STEPS.length - 1);
    expect(spanIdsOfNodes(ancestorsOfSpanId(tree, query.spanId))).toEqual(
      spanIdsOfEvents(chain.slice(0, -1)),
    );
    expect(nodeFor(tree, query.spanId).depth).toBe(CANONICAL_CHAIN_STEPS.length - 1);
    expect(tree.maxDepth).toBe(CANONICAL_CHAIN_STEPS.length - 1);
    expect(tree.tiers).toEqual(['browser', 'server', 'db']);
  });

  it('preserves sub-millisecond startTime doubles exactly', async () => {
    const chain = canonicalChain();
    const repo = fakeTelemetryRepo(chain);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const tree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace over fractional timings',
    );

    for (const [index, step] of CANONICAL_CHAIN_STEPS.entries()) {
      const node = nodeFor(tree, eventAt(chain, index).spanId);
      // Exact equality, never a tolerance: a stray unit conversion anywhere on
      // this path would move every relative offset in the capture.
      expect(node.event.startTime).toBe(at(step.offsetMs));
      expect(node.event.duration).toBe(step.durationMs);
    }

    expect(tree.startTime).toBe(at(0));
    expect(tree.endTime).toBe(at(1175.5));
  });
});

/* -------------------------------------------------------------------------------------------------
 * The trace cache
 *
 * A cache that can serve a tree the store no longer agrees with is worse than
 * no cache: two clients would then disagree about one interaction.
 * ---------------------------------------------------------------------------------------------- */

describe('the trace cache', () => {
  it('misses once, then serves the same tree without consulting the store', async () => {
    const chain = canonicalChain();
    const repo = fakeTelemetryRepo(chain);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const first = treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the first read');
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 1, cachedNodes: chain.length, misses: 1, rebuilds: 1 }),
    );

    const second = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the second read',
    );

    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 1, cachedNodes: chain.length, hits: 1, misses: 1, rebuilds: 1 }),
    );
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(1);
    // The same tree, not an equal one: the panel's repeated reads of one
    // interaction cost nothing after the capture that produced it.
    expect(second).toBe(first);
  });

  it('serves the extended tree after a batch rather than a stale one', async () => {
    const chain = canonicalChain();
    const repo = fakeTelemetryRepo(chain.slice(0, 3));
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const stale = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read before the rest of the trace landed',
    );
    expect(stale.nodeCount).toBe(3);

    const arriving = chain.slice(3);
    repo.put(arriving);
    valueOf(await correlator.onEventsPersisted(arriving), 'onEventsPersisted with the remainder');

    // Extended by the batch — three new levels under a copy of the three above
    // them — without a store read.
    expect(correlator.stats()).toEqual(
      statsWith({
        cachedTraces: 1,
        cachedNodes: chain.length,
        cachedWeight: indexedWeight(chain.length),
        misses: 1,
        rebuilds: 1,
        extensions: 1,
        extensionNodesBuilt: arriving.length + 3,
      }),
    );
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(1);

    const fresh = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read after the remainder landed',
    );

    expect(fresh).not.toBe(stale);
    expect(fresh.nodeCount).toBe(chain.length);
    expect(spanIdsOfTree(fresh)).toEqual(spanIdsOfEvents(chain));
    expect(fresh).toStrictEqual(
      correlateTrace(chain, DEFAULT_TRACE_ID, { maxDepth: CORRELATOR_MAX_DEPTH }),
    );
    // The stale tree a caller may still hold was not altered underneath it.
    expect(stale.nodeCount).toBe(3);
    expect(spanIdsOfTree(stale)).toEqual(spanIdsOfEvents(chain.slice(0, 3)));
    // A hit: the batch, not the read, brought the tree up to date.
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(1);
    expect(correlator.stats()).toMatchObject({ hits: 1, misses: 1, rebuilds: 1 });
  });

  it('drops a cached tree when a purged row is persisted again, and answers an absence once the purge is announced', async () => {
    const purgedTrace = newTraceId();
    const row = makeEvent({ traceId: purgedTrace, kind: 'interaction', name: 'click control' });
    const repo = fakeTelemetryRepo([row]);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    expect(
      treeOf(await correlator.getTrace(SESSION_A, purgedTrace), 'the read before the purge'),
    ).toHaveProperty('nodeCount', 1);
    expect(correlator.stats().cachedTraces).toBe(1);

    // The row is purged and then offered again: its id is free, so the store
    // writes it anew under a fresh arrival number. The cached tree holds the
    // row as it was, which the store no longer does, so the batch cannot be
    // absorbed and the tree is dropped.
    repo.purge(SESSION_A, purgedTrace);
    const rewritten: TelemetryEvent = { ...row, ingestSeq: nextIngestSeq() };
    repo.put([rewritten]);
    const update = valueOf(
      await correlator.onEventsPersisted([rewritten]),
      'onEventsPersisted for a purged row written again',
    );

    expect(update.tracesTouched).toEqual([purgedTrace]);
    expect(correlator.stats()).toMatchObject({ cachedTraces: 0, cachedNodes: 0, invalidations: 1 });
    const reread = treeOf(
      await correlator.getTrace(SESSION_A, purgedTrace),
      'the read after the row was written again',
    );
    expect(reread.roots[0]?.event).toStrictEqual(rewritten);

    // A purge the batch path never sees is announced through `invalidate`, and
    // the next read answers the absence the store now holds.
    repo.purge(SESSION_A, purgedTrace);
    correlator.invalidate(SESSION_A, purgedTrace);
    expect(correlator.stats()).toMatchObject({ cachedTraces: 0, cachedNodes: 0, invalidations: 2 });
    expect(
      valueOf(await correlator.getTrace(SESSION_A, purgedTrace), 'the read after the purge'),
    ).toBeUndefined();
    // The absence is not cached either.
    expect(correlator.stats().cachedTraces).toBe(0);
  });

  it('never holds more than the cache bound and re-fetches the oldest', async () => {
    const traces: TraceId[] = [];
    const rows: TelemetryEvent[] = [];

    for (let index = 0; index <= TRACE_CACHE_LIMIT; index += 1) {
      const traceId = newTraceId();
      traces.push(traceId);
      rows.push(
        makeEvent({
          traceId,
          kind: 'interaction',
          name: 'click control',
          startTime: at(index + 0.5),
          duration: 2.5,
        }),
      );
    }

    const repo = fakeTelemetryRepo(rows);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    let peak = 0;
    for (const traceId of traces) {
      treeOf(await correlator.getTrace(SESSION_A, traceId), 'a read while filling the cache');
      peak = Math.max(peak, correlator.stats().cachedTraces);
    }

    expect(traces).toHaveLength(TRACE_CACHE_LIMIT + 1);
    expect(peak).toBe(TRACE_CACHE_LIMIT);
    expect(correlator.stats().cachedTraces).toBe(TRACE_CACHE_LIMIT);
    // One node per trace: the count bound, not the node budget, did the evicting.
    expect(correlator.stats().cachedNodes).toBe(TRACE_CACHE_LIMIT);
    expect(TRACE_CACHE_LIMIT).toBeLessThan(TRACE_CACHE_NODE_BUDGET);
    expect(correlator.stats().misses).toBe(TRACE_CACHE_LIMIT + 1);
    // Eviction is not invalidation: nothing the store holds changed.
    expect(correlator.stats().invalidations).toBe(0);

    const oldest = eventAt(rows, 0).traceId;
    const newest = eventAt(rows, rows.length - 1).traceId;

    // Eviction is oldest-write-first, so the trace read first is the one that
    // has to be loaded again, while the most recent one is still cached.
    treeOf(await correlator.getTrace(SESSION_A, oldest), 'the read of the evicted trace');
    expect(repo.loadsOf(oldest)).toBe(2);
    expect(correlator.stats().misses).toBe(TRACE_CACHE_LIMIT + 2);

    treeOf(await correlator.getTrace(SESSION_A, newest), 'the read of the newest trace');
    expect(repo.loadsOf(newest)).toBe(1);
    expect(correlator.stats().hits).toBe(1);
  });

  it('invalidates one trace, or every trace of one session, and leaves another session alone', async () => {
    const firstTrace = newTraceId();
    const secondTrace = newTraceId();
    const otherSessionTrace = newTraceId();

    const repo = fakeTelemetryRepo([
      makeEvent({ traceId: firstTrace, kind: 'interaction', name: 'click control' }),
      makeEvent({ traceId: secondTrace, kind: 'interaction', name: 'click control' }),
      makeEvent({
        sessionId: SESSION_B,
        traceId: otherSessionTrace,
        kind: 'interaction',
        name: 'click control',
      }),
    ]);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    treeOf(await correlator.getTrace(SESSION_A, firstTrace), 'the first read');
    treeOf(await correlator.getTrace(SESSION_A, secondTrace), 'the second read');
    treeOf(await correlator.getTrace(SESSION_B, otherSessionTrace), 'the other session read');
    expect(correlator.stats().cachedTraces).toBe(3);

    correlator.invalidate(SESSION_A, firstTrace);
    expect(correlator.stats().cachedTraces).toBe(2);
    treeOf(await correlator.getTrace(SESSION_A, firstTrace), 'the read after one invalidation');
    expect(repo.loadsOf(firstTrace)).toBe(2);
    expect(repo.loadsOf(secondTrace)).toBe(1);

    correlator.invalidate(SESSION_A);
    expect(correlator.stats().cachedTraces).toBe(1);
    treeOf(await correlator.getTrace(SESSION_B, otherSessionTrace), 'the other session again');
    expect(repo.loadsOf(otherSessionTrace)).toBe(1);

    // Invalidating a session that holds nothing is a no-op, not a failure.
    correlator.invalidate(newSessionId());
    expect(correlator.stats().cachedTraces).toBe(1);
  });

  it('answers an unknown trace with an absence rather than an error, and caches nothing', async () => {
    const repo = fakeTelemetryRepo(canonicalChain());
    const correlator = correlatorOver(repo, recordingLogger().logger);
    const unknown = newTraceId();

    const first = await correlator.getTrace(SESSION_A, unknown);
    expect(first.ok).toBe(true);
    expect(valueOf(first, 'the read of an unknown trace')).toBeUndefined();

    // Not cached: a trace whose events have not arrived yet is the ordinary
    // state of a capture in flight, so the next read must see them.
    expect(correlator.stats().cachedTraces).toBe(0);
    expect(
      valueOf(await correlator.getTrace(SESSION_A, unknown), 'the second read'),
    ).toBeUndefined();
    expect(correlator.stats().misses).toBe(2);
    expect(repo.loadsOf(unknown)).toBe(2);
  });

  it('delegates the trace enumeration and returns every tree in the store order', async () => {
    const latest = newTraceId();
    const earliest = newTraceId();
    const middle = newTraceId();

    // Put in deliberately non-chronological order, so "the store's trace order"
    // cannot be confused with insertion order.
    const repo = fakeTelemetryRepo([
      makeEvent({
        traceId: latest,
        kind: 'interaction',
        name: 'click control',
        startTime: at(90.5),
      }),
      makeEvent({
        traceId: earliest,
        kind: 'interaction',
        name: 'click control',
        startTime: at(10.25),
      }),
      makeEvent({
        traceId: middle,
        kind: 'interaction',
        name: 'click control',
        startTime: at(50.125),
      }),
      makeEvent({
        captureId: CAPTURE_A2,
        traceId: newTraceId(),
        kind: 'interaction',
        name: 'click control',
        startTime: at(70.75),
      }),
    ]);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const ids = valueOf(await correlator.listTraceIds(SESSION_A, CAPTURE_A1), 'listTraceIds');
    expect(ids).toEqual([earliest, middle, latest]);
    expect(repo.idListings).toEqual([{ sessionId: SESSION_A, captureId: CAPTURE_A1 }]);
    // A pass-through read: it consults neither the cache nor the correlator.
    expect(repo.traceLoads).toHaveLength(0);
    expect(correlator.stats().cachedTraces).toBe(0);

    const trees = valueOf(await correlator.getTraces(SESSION_A, CAPTURE_A1), 'getTraces');

    expect(trees.map((tree) => tree.traceId)).toEqual([earliest, middle, latest]);
    expect(trees.map((tree) => tree.startTime)).toEqual([at(10.25), at(50.125), at(90.5)]);
    expect(repo.idListings).toHaveLength(2);
    // The capture narrows the enumeration and each enumerated trace's events
    // alike: every trace load carries it.
    expect(repo.traceLoads.map((load) => load.captureId)).toEqual([
      CAPTURE_A1,
      CAPTURE_A1,
      CAPTURE_A1,
    ]);
    expect(correlator.stats().cachedTraces).toBe(3);

    const unnarrowed = valueOf(
      await correlator.getTraces(SESSION_A),
      'getTraces over every capture',
    );
    expect(unnarrowed).toHaveLength(4);
    expect(repo.idListings.at(-1)).toEqual({ sessionId: SESSION_A, captureId: undefined });
  });

  it('builds a trace id shared by two captures from the events of the capture a read names', async () => {
    // One trace id under two captures of one session — a producer mints trace
    // ids, so nothing keys one to a single capture. Each window is a whole
    // cross-tier interaction of its own.
    const shared = newTraceId();
    const firstWindow = canonicalChain({ captureId: CAPTURE_A1, traceId: shared });
    const secondWindow = chainOf(CANONICAL_CHAIN_STEPS.slice(0, 3), {
      captureId: CAPTURE_A2,
      traceId: shared,
    });
    const repo = fakeTelemetryRepo([...firstWindow, ...secondWindow]);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const firstTrees = valueOf(
      await correlator.getTraces(SESSION_A, CAPTURE_A1),
      'getTraces narrowed to the first capture',
    );

    expect(firstTrees.map((tree) => tree.nodeCount)).toEqual([firstWindow.length]);
    expect(firstTrees.map((tree) => spanIdsOfTree(tree))).toEqual([spanIdsOfEvents(firstWindow)]);

    const secondTrees = valueOf(
      await correlator.getTraces(SESSION_A, CAPTURE_A2),
      'getTraces narrowed to the second capture',
    );

    expect(secondTrees.map((tree) => tree.nodeCount)).toEqual([secondWindow.length]);
    expect(secondTrees.map((tree) => spanIdsOfTree(tree))).toEqual([spanIdsOfEvents(secondWindow)]);

    // Naming no capture is the session-wide join over both windows.
    const joined = treeOf(await correlator.getTrace(SESSION_A, shared), 'the session-wide read');

    expect(joined.nodeCount).toBe(firstWindow.length + secondWindow.length);
    expect(spanIdsOfTree(joined).sort()).toEqual(
      spanIdsOfEvents([...firstWindow, ...secondWindow]).sort(),
    );
    expect(repo.traceLoads.map((load) => load.captureId)).toEqual([
      CAPTURE_A1,
      CAPTURE_A2,
      undefined,
    ]);

    // Three scopes, three entries, none standing in for another.
    const heldNodes = firstWindow.length + secondWindow.length + joined.nodeCount;
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 3, cachedNodes: heldNodes, misses: 3, rebuilds: 3 }),
    );

    // A second capture-scoped read is a hit on its own entry.
    const again = treeOf(
      await correlator.getTrace(SESSION_A, shared, CAPTURE_A1),
      'the second read of the first capture',
    );

    expect(again).toBe(firstTrees[0]);
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 3, cachedNodes: heldNodes, hits: 1, misses: 3, rebuilds: 3 }),
    );
    expect(repo.loadsOf(shared)).toBe(3);

    // A capture that holds none of the trace answers with an absence, never
    // with the session-wide tree, and caches nothing.
    expect(
      valueOf(
        await correlator.getTrace(SESSION_A, shared, newCaptureId()),
        'the read of a capture holding none of the trace',
      ),
    ).toBeUndefined();
    expect(correlator.stats().cachedTraces).toBe(3);
  });

  it('extends the capture-scoped tree of a capture a batch touched with that capture\u2019s events and keeps the other capture\u2019s', async () => {
    const shared = newTraceId();
    const firstWindow = canonicalChain({ captureId: CAPTURE_A1, traceId: shared });
    const secondWindow = chainOf(CANONICAL_CHAIN_STEPS.slice(0, 3), {
      captureId: CAPTURE_A2,
      traceId: shared,
    });
    const repo = fakeTelemetryRepo([...firstWindow, ...secondWindow]);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const staleFirst = treeOf(
      await correlator.getTrace(SESSION_A, shared, CAPTURE_A1),
      'the first capture before the batch',
    );
    const cachedSecond = treeOf(
      await correlator.getTrace(SESSION_A, shared, CAPTURE_A2),
      'the second capture before the batch',
    );

    expect(correlator.stats().cachedTraces).toBe(2);

    // A late span of the first capture lands for the same trace.
    const late = makeEvent({
      captureId: CAPTURE_A1,
      traceId: shared,
      parentSpanId: eventAt(firstWindow, 4).spanId,
      kind: 'db.query',
      name: 'query rows',
      startTime: at(700.5),
      duration: 3.25,
      producerId: PRODUCER_SERVER,
    });

    repo.put([late]);

    const update = valueOf(
      await correlator.onEventsPersisted([late]),
      'onEventsPersisted with a late span of the first capture',
    );

    expect(update.tracesTouched).toEqual([shared]);
    // Nothing was loaded on ingest.
    expect(repo.loadsOf(shared)).toBe(2);

    // The first capture's tree was extended — the new query under a copy of
    // the five levels above it — and the second capture's tree was left alone;
    // no session-wide tree was built for nobody to read.
    expect(correlator.stats()).toEqual(
      statsWith({
        cachedTraces: 2,
        cachedNodes: firstWindow.length + 1 + secondWindow.length,
        cachedWeight: indexedWeight(firstWindow.length + 1) + secondWindow.length,
        misses: 2,
        rebuilds: 2,
        extensions: 1,
        extensionNodesBuilt: 1 + 5,
      }),
    );

    const loadsAfterBatch = repo.loadsOf(shared);
    const freshFirst = treeOf(
      await correlator.getTrace(SESSION_A, shared, CAPTURE_A1),
      'the first capture after the batch',
    );

    expect(freshFirst).not.toBe(staleFirst);
    expect(freshFirst.nodeCount).toBe(firstWindow.length + 1);
    expect(nodeFor(freshFirst, late.spanId).event.captureId).toBe(CAPTURE_A1);
    expect(freshFirst).toStrictEqual(
      correlateTrace([...firstWindow, late], shared, { maxDepth: CORRELATOR_MAX_DEPTH }),
    );
    // A hit: the batch brought it up to date.
    expect(repo.loadsOf(shared)).toBe(loadsAfterBatch);

    const stillSecond = treeOf(
      await correlator.getTrace(SESSION_A, shared, CAPTURE_A2),
      'the second capture after the batch',
    );

    expect(stillSecond).toBe(cachedSecond);

    const joined = treeOf(
      await correlator.getTrace(SESSION_A, shared),
      'the session-wide read after the batch',
    );

    expect(joined.nodeCount).toBe(firstWindow.length + secondWindow.length + 1);
    // Both capture reads were hits; the session-wide read is the first anyone
    // made, so it is the one load that built that tree.
    expect(repo.loadsOf(shared)).toBe(loadsAfterBatch + 1);
    expect(repo.traceLoads.at(-1)?.captureId).toBeUndefined();
  });

  it('invalidates a trace, or a whole session, under every scope and leaves another session alone', async () => {
    const shared = newTraceId();
    const other = newTraceId();
    const otherSessionCapture = newCaptureId();
    const click = { kind: 'interaction', name: 'click control' } as const;

    const repo = fakeTelemetryRepo([
      makeEvent({ ...click, captureId: CAPTURE_A1, traceId: shared }),
      makeEvent({ ...click, captureId: CAPTURE_A2, traceId: shared }),
      makeEvent({ ...click, captureId: CAPTURE_A1, traceId: other }),
      makeEvent({
        ...click,
        sessionId: SESSION_B,
        captureId: otherSessionCapture,
        traceId: shared,
      }),
    ]);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const reads: readonly (readonly [SessionId, TraceId, CaptureId | undefined])[] = [
      [SESSION_A, shared, undefined],
      [SESSION_A, shared, CAPTURE_A1],
      [SESSION_A, shared, CAPTURE_A2],
      [SESSION_A, other, undefined],
      [SESSION_A, other, CAPTURE_A1],
      [SESSION_B, shared, undefined],
      [SESSION_B, shared, otherSessionCapture],
    ];

    for (const [sessionId, traceId, captureId] of reads) {
      treeOf(await correlator.getTrace(sessionId, traceId, captureId), 'a read filling the cache');
    }

    // One node per tree, except the session-wide join of `shared` in the first
    // session, which holds both of its captures' rows.
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 7, cachedNodes: 8, misses: 7, rebuilds: 7 }),
    );

    // One trace goes under all three of its scopes, and nothing else does.
    correlator.invalidate(SESSION_A, shared);
    expect(correlator.stats()).toMatchObject({ cachedTraces: 4, cachedNodes: 4, invalidations: 3 });

    treeOf(await correlator.getTrace(SESSION_A, other), 'the untouched trace, session-wide');
    treeOf(await correlator.getTrace(SESSION_A, other, CAPTURE_A1), 'the untouched trace, scoped');
    treeOf(
      await correlator.getTrace(SESSION_B, shared, otherSessionCapture),
      'the same trace id in the other session',
    );
    expect(correlator.stats()).toEqual(
      statsWith({
        cachedTraces: 4,
        cachedNodes: 4,
        hits: 3,
        misses: 7,
        rebuilds: 7,
        invalidations: 3,
      }),
    );

    treeOf(
      await correlator.getTrace(SESSION_A, shared, CAPTURE_A2),
      'a scope of the invalidated trace',
    );
    expect(correlator.stats()).toEqual(
      statsWith({
        cachedTraces: 5,
        cachedNodes: 5,
        hits: 3,
        misses: 8,
        rebuilds: 8,
        invalidations: 3,
      }),
    );

    // The whole session goes under every scope; the other session stays.
    correlator.invalidate(SESSION_A);
    expect(correlator.stats()).toMatchObject({ cachedTraces: 2, cachedNodes: 2, invalidations: 6 });

    treeOf(await correlator.getTrace(SESSION_B, shared), 'the other session, session-wide');
    expect(correlator.stats().hits).toBe(4);

    treeOf(
      await correlator.getTrace(SESSION_A, other, CAPTURE_A1),
      'a scope of the invalidated session',
    );
    expect(correlator.stats().misses).toBe(9);
  });

  it('releases the cache on close and stays usable afterwards', async () => {
    const repo = fakeTelemetryRepo(canonicalChain());
    const correlator = correlatorOver(repo, recordingLogger().logger);

    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the read before close');
    expect(correlator.stats().cachedTraces).toBe(1);

    correlator.close();
    expect(correlator.stats().cachedTraces).toBe(0);
    // Idempotent, and the counters describe what the correlator has done rather
    // than what it currently holds, so close leaves them alone.
    correlator.close();
    expect(correlator.stats()).toEqual(statsWith({ misses: 1, rebuilds: 1 }));

    const afterClose = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read after close',
    );
    expect(afterClose.nodeCount).toBe(CANONICAL_CHAIN_STEPS.length);
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(2);
  });

  it('caches nothing when the cache bound is zero', async () => {
    const repo = fakeTelemetryRepo(canonicalChain());
    const correlator = correlatorOver(repo, recordingLogger().logger, { cacheLimit: 0 });

    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the first uncached read');
    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the second uncached read');

    expect(correlator.stats()).toEqual(statsWith({ misses: 2, rebuilds: 2 }));
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(2);
  });

  it('caches nothing when the node budget is zero', async () => {
    const repo = fakeTelemetryRepo(canonicalChain());
    const correlator = correlatorOver(repo, recordingLogger().logger, { cacheNodeBudget: 0 });

    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the first uncached read');
    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the second uncached read');

    expect(correlator.stats()).toEqual(statsWith({ misses: 2, rebuilds: 2 }));
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(2);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The weight bound
 *
 * One entry may hold anything from a single node to a hundred thousand, so an
 * entry count alone does not bound what the cache keeps alive. The node budget
 * and the per-entry cap do, and the node total they are checked against has to
 * stay exact through every way an entry leaves.
 * ---------------------------------------------------------------------------------------------- */

describe('the weight bound', () => {
  it('ships defaults that let one entry take at most a fifth of the node budget', () => {
    expect(TRACE_CACHE_MAX_TREE_NODES).toBeGreaterThan(0);
    expect(TRACE_CACHE_MAX_TREE_NODES * 5).toBeLessThanOrEqual(TRACE_CACHE_NODE_BUDGET);
  });

  it('evicts oldest-write-first once the nodes exceed the budget, though the entries are well under the count bound', async () => {
    const [first, second, third] = [newTraceId(), newTraceId(), newTraceId()];
    const repo = fakeTelemetryRepo([
      ...linearChain(4, { traceId: first }),
      ...linearChain(4, { traceId: second }),
      ...linearChain(4, { traceId: third }),
    ]);
    const correlator = correlatorOver(repo, recordingLogger().logger, { cacheNodeBudget: 10 });

    treeOf(await correlator.getTrace(SESSION_A, first), 'the first trace');
    treeOf(await correlator.getTrace(SESSION_A, second), 'the second trace');
    expect(correlator.stats()).toMatchObject({ cachedTraces: 2, cachedNodes: 8 });

    // Twelve nodes would exceed the budget of ten: the oldest write goes, even
    // though three entries are nowhere near the count bound.
    treeOf(await correlator.getTrace(SESSION_A, third), 'the third trace');
    expect(correlator.stats()).toMatchObject({ cachedTraces: 2, cachedNodes: 8 });
    expect(TRACE_CACHE_LIMIT).toBeGreaterThan(3);

    treeOf(await correlator.getTrace(SESSION_A, first), 'the evicted trace again');
    expect(repo.loadsOf(first)).toBe(2);
    treeOf(await correlator.getTrace(SESSION_A, third), 'the newest trace');
    expect(repo.loadsOf(third)).toBe(1);

    // Re-reading the first evicted the second, the oldest write left.
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 2, cachedNodes: 8, hits: 1, misses: 4, rebuilds: 4 }),
    );
    treeOf(await correlator.getTrace(SESSION_A, second), 'the second trace again');
    expect(repo.loadsOf(second)).toBe(2);
  });

  it('answers with a tree above the per-entry cap and does not cache it', async () => {
    const logs = recordingLogger();
    const large = newTraceId();
    const fitting = newTraceId();
    const largeRows = linearChain(6, { traceId: large });
    const repo = fakeTelemetryRepo([...largeRows, ...linearChain(5, { traceId: fitting })]);
    const correlator = correlatorOver(repo, logs.logger, { maxCachedTreeNodes: 5 });

    const first = treeOf(await correlator.getTrace(SESSION_A, large), 'the large trace');
    expect(first.nodeCount).toBe(largeRows.length);
    expect(correlator.stats()).toEqual(statsWith({ misses: 1, rebuilds: 1 }));

    // Not cached, so the second read is a miss that rebuilds it whole.
    const second = treeOf(await correlator.getTrace(SESSION_A, large), 'the large trace again');
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(repo.loadsOf(large)).toBe(2);
    expect(correlator.stats()).toEqual(statsWith({ misses: 2, rebuilds: 2 }));

    // Exactly at the cap is within it.
    treeOf(await correlator.getTrace(SESSION_A, fitting), 'the trace at the cap');
    expect(correlator.stats()).toMatchObject({ cachedTraces: 1, cachedNodes: 5 });

    // Reported by its count, never by its content.
    const refused = logs
      .at('debug')
      .filter((record) => record.fields['maxTreeNodes'] !== undefined);
    expect(refused.map((record) => record.fields['nodeCount'])).toEqual([6, 6]);
    for (const row of largeRows) {
      expect(logs.text()).not.toContain(row.name);
    }
  });

  it('never lets the per-entry cap exceed the node budget', async () => {
    const small = newTraceId();
    const repo = fakeTelemetryRepo([...linearChain(2, { traceId: small }), ...linearChain(5)]);
    const correlator = correlatorOver(repo, recordingLogger().logger, {
      cacheNodeBudget: 4,
      maxCachedTreeNodes: 100,
    });

    treeOf(await correlator.getTrace(SESSION_A, small), 'a tree within the budget');

    // Five nodes against a budget of four: refused as an entry, so it can
    // neither evict the small tree to make room nor evict itself afterwards.
    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'a tree above the budget');
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 1, cachedNodes: 2, misses: 2, rebuilds: 2 }),
    );
  });

  it('keeps the node total exact through replacement, batches, invalidation and close', async () => {
    const shared = newTraceId();
    const other = newTraceId();
    const store = fakeTelemetryRepo([
      ...linearChain(3, { captureId: CAPTURE_A1, traceId: shared }),
      ...linearChain(2, { captureId: CAPTURE_A2, traceId: shared }),
      ...linearChain(4, { traceId: other }),
    ]);
    const gate = gatedTelemetryRepo(store);
    const correlator = correlatorOver(gate.repo, recordingLogger().logger);

    // Replacement: two reads of one scope in flight at once, both current. The
    // later write replaces the earlier one rather than adding to it.
    const racingReads = [
      correlator.getTrace(SESSION_A, other),
      correlator.getTrace(SESSION_A, other),
    ];
    expect(gate.held()).toBe(2);
    gate.release();
    for (const outcome of await Promise.all(racingReads)) {
      expect(treeOf(outcome, 'one of two concurrent reads').nodeCount).toBe(4);
    }
    expect(correlator.stats()).toMatchObject({ cachedTraces: 1, cachedNodes: 4 });

    // Three scopes of the shared trace: 5 session-wide, 3 and 2 per capture.
    treeOf(await correlator.getTrace(SESSION_A, shared), 'the session-wide join');
    treeOf(await correlator.getTrace(SESSION_A, shared, CAPTURE_A1), 'the first capture');
    treeOf(await correlator.getTrace(SESSION_A, shared, CAPTURE_A2), 'the second capture');
    expect(correlator.stats()).toMatchObject({ cachedTraces: 4, cachedNodes: 4 + 5 + 3 + 2 });

    // A batch naming the first capture with a click timestamped ahead of the
    // anchor — the same affinity, canonically first, so it moves the anchor,
    // which neither tree can absorb exactly — drops the join (5) and that
    // capture (3).
    const late = makeEvent({
      captureId: CAPTURE_A1,
      traceId: shared,
      kind: 'interaction',
      startTime: at(0.125),
    });
    store.put([late]);
    valueOf(await correlator.onEventsPersisted([late]), 'a batch for the first capture');
    expect(correlator.stats()).toMatchObject({ cachedTraces: 2, cachedNodes: 4 + 2 });

    // Invalidating one trace drops its remaining scope (2).
    correlator.invalidate(SESSION_A, shared);
    expect(correlator.stats()).toMatchObject({ cachedTraces: 1, cachedNodes: 4 });

    // Close drops the rest, to exactly zero.
    treeOf(await correlator.getTrace(SESSION_A, shared, CAPTURE_A1), 'the first capture again');
    expect(correlator.stats()).toMatchObject({ cachedTraces: 2, cachedNodes: 4 + 4 });
    correlator.close();
    expect(correlator.stats()).toMatchObject({ cachedTraces: 0, cachedNodes: 0 });
  });

  it('counts invalidations by batches and invalidate, and not extension, eviction or close', async () => {
    const [first, second, third] = [newTraceId(), newTraceId(), newTraceId()];
    const click = { kind: 'interaction', name: 'click control' } as const;
    const firstRow = makeEvent({ ...click, traceId: first });
    const repo = fakeTelemetryRepo([
      firstRow,
      makeEvent({ ...click, traceId: second }),
      makeEvent({ ...click, traceId: third }),
    ]);
    const correlator = correlatorOver(repo, recordingLogger().logger, { cacheLimit: 2 });

    // Two scopes of the first trace, then a batch naming its capture that both
    // can absorb — a child of the root — and one they cannot: a second click
    // timestamped ahead of the first, which displaces the primary root.
    treeOf(await correlator.getTrace(SESSION_A, first), 'the first trace');
    treeOf(await correlator.getTrace(SESSION_A, first, CAPTURE_A1), 'the first trace, scoped');
    const child = makeEvent({ traceId: first, parentSpanId: firstRow.spanId, startTime: at(2.5) });
    repo.put([child]);
    valueOf(await correlator.onEventsPersisted([child]), 'a batch both scopes absorb');
    expect(correlator.stats()).toMatchObject({ extensions: 2, invalidations: 0 });

    const secondRoot = makeEvent({ ...click, traceId: first, startTime: at(0.25) });
    repo.put([secondRoot]);
    valueOf(await correlator.onEventsPersisted([secondRoot]), 'a batch no scope absorbs');
    expect(correlator.stats()).toMatchObject({ extensions: 2, invalidations: 2 });

    // A batch that finds nothing to drop counts nothing.
    valueOf(await correlator.onEventsPersisted([secondRoot]), 'the same batch again');
    expect(correlator.stats()).toMatchObject({ extensions: 2, invalidations: 2 });

    // Three reads into a cache of two: one eviction, which is not invalidation.
    for (const traceId of [first, second, third]) {
      treeOf(await correlator.getTrace(SESSION_A, traceId), 'a read filling the cache');
    }
    expect(correlator.stats()).toMatchObject({ cachedTraces: 2, invalidations: 2 });

    // `invalidate` counts what it drops.
    correlator.invalidate(SESSION_A, third);
    expect(correlator.stats()).toMatchObject({ cachedTraces: 1, invalidations: 3 });

    // Close releases without counting.
    correlator.close();
    expect(correlator.stats()).toMatchObject({ cachedTraces: 0, invalidations: 3 });
  });
});

/* -------------------------------------------------------------------------------------------------
 * Extending cached trees at ingest
 *
 * The volume regression for the ingest path. A capture streams in as many
 * small batches while the panel keeps reading the trace, so the shape that
 * matters is the alternation: persist a batch, announce it, read. Rebuilding
 * the trace from the store on every such read costs `O(n)` per step and
 * `O(n²/b)` over the capture; extending the cached tree costs the batch and
 * the paths it hangs from, and must still be **exactly** the tree a
 * from-scratch correlation of every stored row produces. These cases pin both
 * halves: the work per step, and the equality at every step.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A seeded generator of numbers in `[0, 1)`, from the same linear congruential
 * step {@link shuffle} uses; never `Math.random`, so every workload below is
 * the same on every run.
 *
 * @param seed Any non-zero 32-bit seed.
 * @returns The generator.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** One element of `items`, chosen by `random`, or a failure naming the gap. */
function pickFrom<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) {
    throw new Error('expected a non-empty list to pick from');
  }
  return item;
}

/** A fetch whose server half has been persisted, with that half's start. */
interface AnsweredFetch {
  readonly fetch: TelemetryEvent;
  readonly serverStart: number;
}

/**
 * The test's own model of one capture's trace as it streams in: what has been
 * persisted, how it nests, and which fetches still await their server half.
 */
interface StreamingTrace {
  /** The scope every event of the capture carries. */
  readonly scope: FixtureScope;
  /** The capture's interaction root. */
  readonly root: TelemetryEvent;
  /** Every row persisted so far, in arrival order. */
  readonly rows: TelemetryEvent[];
  /** Each persisted span's parent span, `undefined` for the root. */
  readonly parentOf: Map<SpanId, SpanId | undefined>;
  /** Browser fetches whose server half has not been persisted yet. */
  readonly pending: TelemetryEvent[];
  /** Browser fetches whose server half has been persisted. */
  readonly answered: AnsweredFetch[];
  /** Start offsets already used by children of the root, for exact ties. */
  readonly rootChildStarts: number[];
}

/** The deepest level a {@link streamingBatch} ever creates: the query. */
const STREAMING_TREE_DEPTH = 5;

/** The most new events one {@link streamingBatch} ever carries. */
const STREAMING_BATCH_MAX = 5;

/**
 * A capture's model, seeded with its root row.
 *
 * @param root The interaction root, already part of the capture's scope.
 * @param scope The scope every later event carries.
 * @returns The model, holding the root as its one persisted row.
 */
function streamingTrace(root: TelemetryEvent, scope: FixtureScope = {}): StreamingTrace {
  return {
    scope,
    root,
    rows: [root],
    parentOf: new Map([[root.spanId, undefined]]),
    pending: [],
    answered: [],
    rootChildStarts: [],
  };
}

/**
 * The server half of one request: the request span, its route handler, one
 * application function and its query, nested four deep under `parent`.
 */
function serverHalf(
  trace: StreamingTrace,
  parent: TelemetryEvent,
  offset: number,
): TelemetryEvent[] {
  const request = makeEvent({
    ...trace.scope,
    parentSpanId: parent.spanId,
    kind: 'http.server',
    name: 'POST /api/one',
    startTime: at(offset),
    duration: 9.5,
    producerId: PRODUCER_SERVER,
  });
  const handler = makeEvent({
    ...trace.scope,
    parentSpanId: request.spanId,
    kind: 'route.handler',
    name: 'executing route handler',
    startTime: at(offset + 0.375),
    duration: 8.75,
    producerId: PRODUCER_SERVER,
  });
  const action = makeEvent({
    ...trace.scope,
    parentSpanId: handler.spanId,
    kind: 'function',
    name: 'handleAction',
    startTime: at(offset + 1.25),
    duration: 6.125,
    producerId: PRODUCER_SERVER,
  });
  const query = makeEvent({
    ...trace.scope,
    parentSpanId: action.spanId,
    kind: 'db.query',
    name: 'SELECT rows',
    startTime: at(offset + 2.5),
    duration: 3.25,
    producerId: PRODUCER_SERVER,
  });
  return [request, handler, action, query];
}

/**
 * The next batch of new events of one streaming capture — never a replay.
 *
 * Drawn to look like a real capture's arrival rather than a tidy one: whole
 * requests, browser halves whose server halves land in a later batch, render
 * work, and browser logs that tie the server request under the same fetch on
 * `startTime` across producers. A quarter of the batches are back-dated so
 * their spans sort among older siblings rather than after them, and some
 * fetches reuse an older sibling's start exactly. Every event names a parent
 * that is persisted or in the same batch, so a full correlation never orphans
 * one — the tree the cache extends and the tree it is compared with have the
 * same shape by construction, not by coincidence.
 *
 * Updates the model's pending and answered fetches; the caller records the
 * rows once it has persisted them.
 *
 * @param random The seeded generator.
 * @param trace The capture's model.
 * @param step The step number, which advances the clock.
 * @returns The new events, parents before children.
 */
function streamingBatch(
  random: () => number,
  trace: StreamingTrace,
  step: number,
): TelemetryEvent[] {
  const backdated = random() < 0.25;
  const base = step * 12.5 + 3.125 - (backdated ? random() * 200 : 0);
  const choice = random();

  const fetchAt = (offset: number): TelemetryEvent => {
    const reused = trace.rootChildStarts.length > 0 && random() < 0.2;
    const start = reused ? pickFrom(random, trace.rootChildStarts) : offset;
    trace.rootChildStarts.push(start);
    return makeEvent({
      ...trace.scope,
      parentSpanId: trace.root.spanId,
      kind: 'fetch',
      name: 'POST /api/one',
      startTime: at(start),
      duration: 11.75,
      producerId: PRODUCER_BROWSER,
    });
  };

  if (choice < 0.2 && trace.pending.length > 0) {
    // The server half of a request whose browser half landed earlier.
    const position = Math.floor(random() * trace.pending.length);
    const [fetch] = trace.pending.splice(position, 1);
    if (fetch !== undefined) {
      const serverStart = fetch.startTime - BASE_TIME + (random() < 0.3 ? 0 : 0.875);
      trace.answered.push({ fetch, serverStart });
      return serverHalf(trace, fetch, serverStart);
    }
  }

  if (choice < 0.35) {
    // A browser half alone; its server half is still in flight.
    const fetch = fetchAt(base);
    trace.pending.push(fetch);
    return [fetch];
  }

  if (choice < 0.5 && trace.answered.length > 0) {
    // A browser log under an answered fetch, tying the server request that is
    // already its sibling on `startTime` across producers.
    const { fetch, serverStart } = pickFrom(random, trace.answered);
    return [
      makeEvent({
        ...trace.scope,
        parentSpanId: fetch.spanId,
        kind: 'log',
        name: 'console message',
        startTime: at(serverStart),
        duration: 0,
        producerId: PRODUCER_BROWSER,
      }),
    ];
  }

  if (choice < 0.65) {
    // Render work: a render with a state transition under it, and a commit.
    const render = makeEvent({
      ...trace.scope,
      parentSpanId: trace.root.spanId,
      kind: 'render',
      name: 'render list',
      startTime: at(base + 0.625),
      duration: 4.5,
      producerId: PRODUCER_BROWSER,
    });
    trace.rootChildStarts.push(base + 0.625);
    return [
      render,
      makeEvent({
        ...trace.scope,
        parentSpanId: render.spanId,
        kind: 'state',
        name: 'state transition',
        startTime: at(base + 1.5),
        duration: 0.25,
        producerId: PRODUCER_BROWSER,
      }),
      makeEvent({
        ...trace.scope,
        parentSpanId: trace.root.spanId,
        kind: 'commit',
        name: 'commit work',
        startTime: at(base + 5.25),
        duration: 0.75,
        producerId: PRODUCER_BROWSER,
      }),
    ];
  }

  // A whole request, browser and server halves in one batch.
  const fetch = fetchAt(base);
  const serverStart = fetch.startTime - BASE_TIME + 0.875;
  trace.answered.push({ fetch, serverStart });
  return [fetch, ...serverHalf(trace, fetch, serverStart)];
}

/**
 * Records persisted rows in the model.
 *
 * @param trace The capture's model.
 * @param rows The rows just persisted.
 */
function recordPersisted(trace: StreamingTrace, rows: readonly TelemetryEvent[]): void {
  for (const row of rows) {
    trace.rows.push(row);
    trace.parentOf.set(row.spanId, row.parentSpanId);
  }
}

/**
 * The node objects an exact extension must build for `fresh`: one per new
 * event, plus one copy of every already-persisted node on the path from an
 * attachment point up to its root, each counted once however many new events
 * hang below it.
 *
 * @param trace The capture's model, **before** `fresh` is recorded in it.
 * @param fresh The batch's new events.
 * @returns The expected `nodesBuilt`.
 */
function expectedNodesBuilt(trace: StreamingTrace, fresh: readonly TelemetryEvent[]): number {
  const copied = new Set<SpanId>();

  for (const event of fresh) {
    let cursor = event.parentSpanId;
    while (cursor !== undefined && trace.parentOf.has(cursor) && !copied.has(cursor)) {
      copied.add(cursor);
      cursor = trace.parentOf.get(cursor);
    }
  }

  return fresh.length + copied.size;
}

/**
 * The batch ingest hands the correlator: the new rows and any replays, in an
 * arrival order that does not follow parentage.
 */
function arrivalOrder(
  fresh: readonly TelemetryEvent[],
  replays: readonly TelemetryEvent[],
  seed: number,
): TelemetryEvent[] {
  return shuffle([...fresh, ...replays], seed);
}

/** The full correlation every served tree is held to. */
function fullCorrelation(
  rows: readonly TelemetryEvent[],
  traceId: TraceId,
  seed: number,
): TraceTree {
  const tree = correlateTrace(shuffle(rows, seed), traceId, { maxDepth: CORRELATOR_MAX_DEPTH });
  if (tree === undefined) {
    throw new Error('expected the stored rows to correlate into a trace');
  }
  return tree;
}

/** The debug records `onEventsPersisted` writes, one per batch that named a trace. */
function batchSummaries(logs: LogCapture): readonly LogRecord[] {
  return logs.at('debug').filter((record) => record.fields['extended'] !== undefined);
}

describe('extending cached trees at ingest', () => {
  it.each([20_260_101, 7_919])(
    'serves every read of an alternating batch-and-read stream from the cache, equal to a full correlation, with per-step work independent of the trace size (seed %i)',
    async (seed) => {
      const random = seededRandom(seed);
      const root = makeEvent({
        kind: 'interaction',
        name: 'click control',
        startTime: at(0),
        duration: 5_000,
      });
      const trace = streamingTrace(root);
      const repo = fakeTelemetryRepo([root]);
      const logs = recordingLogger();
      const correlator = correlatorOver(repo, logs.logger);
      const steps = 240;

      // One read seeds the cache; it is the only store read of the whole run.
      treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the seeding read');
      expect(repo.traceLoads).toHaveLength(1);

      let totalBuilt = 0;
      let replaysOffered = 0;
      const builtPerStep: number[] = [];

      for (let step = 1; step <= steps; step += 1) {
        const fresh = streamingBatch(random, trace, step);
        // Now and then ingest also hands back rows it had already stored — a
        // producer's retry — which the store returns as the stored rows.
        const replays =
          random() < 0.2 ? [pickFrom(random, trace.rows), pickFrom(random, trace.rows)] : [];
        replaysOffered += replays.length;
        const expectedBuilt = expectedNodesBuilt(trace, fresh);

        repo.put(fresh);
        recordPersisted(trace, fresh);
        valueOf(
          await correlator.onEventsPersisted(arrivalOrder(fresh, replays, seed + step)),
          'onEventsPersisted for one streaming batch',
        );

        const built = correlator.stats().extensionNodesBuilt - totalBuilt;
        totalBuilt += built;
        builtPerStep.push(built);

        // The work of the step: exactly the new nodes and one copy of each
        // path they hang from — bounded by the batch and the depth, never by
        // how many nodes the tree already holds.
        expect(built).toBe(expectedBuilt);
        expect(built).toBeLessThanOrEqual(STREAMING_BATCH_MAX * (STREAMING_TREE_DEPTH + 1));

        const served = treeOf(
          await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
          'the read after one streaming batch',
        );
        const reference = fullCorrelation(
          repo.rowsOf(SESSION_A, DEFAULT_TRACE_ID),
          DEFAULT_TRACE_ID,
          step,
        );

        expect(served).toStrictEqual(reference);
        if (step % 20 === 0 || step === steps) {
          expect(JSON.stringify(served)).toBe(JSON.stringify(reference));
        }
        expect(correlator.stats()).toEqual(
          statsWith({
            cachedTraces: 1,
            cachedNodes: trace.rows.length,
            cachedWeight: indexedWeight(trace.rows.length),
            hits: step,
            misses: 1,
            rebuilds: 1,
            extensions: step,
            extensionNodesBuilt: totalBuilt,
          }),
        );
      }

      // Not one store read after the seeding read, however far the trace grew.
      expect(repo.traceLoads).toHaveLength(1);
      expect(replaysOffered).toBeGreaterThan(0);
      expect(trace.rows.length).toBeGreaterThan(
        20 * STREAMING_BATCH_MAX * (STREAMING_TREE_DEPTH + 1),
      );

      // The last steps, over the largest tree, cost no more per step than the
      // bound the first steps were held to.
      const firstQuarter = builtPerStep.slice(0, steps / 4);
      const lastQuarter = builtPerStep.slice(-steps / 4);
      expect(Math.max(...lastQuarter)).toBeLessThanOrEqual(
        STREAMING_BATCH_MAX * (STREAMING_TREE_DEPTH + 1),
      );
      expect(Math.max(...firstQuarter)).toBeLessThanOrEqual(
        STREAMING_BATCH_MAX * (STREAMING_TREE_DEPTH + 1),
      );

      // Every batch was absorbed, and reported by its counts alone.
      const summaries = batchSummaries(logs);
      expect(summaries).toHaveLength(steps);
      for (const summary of summaries) {
        expect(summary.fields['extended']).toBe(1);
        expect(summary.fields['invalidated']).toBe(0);
        expect(summary.fields['dropReasons']).toBeUndefined();
      }
    },
  );

  it('extends a late parent: the orphan it names moves under it, and no store read follows', async () => {
    const random = seededRandom(424_243);
    const root = makeEvent({
      kind: 'interaction',
      name: 'click control',
      startTime: at(0),
      duration: 5_000,
    });
    const absentFetch = newSpanId();
    // The server's span of a request whose browser fetch has not landed: a
    // `missing-parent` orphan, repaired onto the primary root after its real
    // children.
    const orphan = makeEvent({
      parentSpanId: absentFetch,
      kind: 'http.server',
      name: 'POST /api/one',
      startTime: at(4.5),
      duration: 30.25,
      producerId: PRODUCER_SERVER,
    });
    const trace = streamingTrace(root);
    recordPersisted(trace, [orphan]);
    const repo = fakeTelemetryRepo([root, orphan]);
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const seeded = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the seeding read',
    );
    expect(seeded.orphanCount).toBe(1);

    /** Runs `count` alternating steps and holds every read to a full correlation. */
    async function stream(count: number, firstStep: number): Promise<void> {
      for (let step = firstStep; step < firstStep + count; step += 1) {
        const fresh = streamingBatch(random, trace, step);
        repo.put(fresh);
        recordPersisted(trace, fresh);
        valueOf(
          await correlator.onEventsPersisted(arrivalOrder(fresh, [], step)),
          'onEventsPersisted for one streaming batch',
        );
        const served = treeOf(
          await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
          'the read after one streaming batch',
        );
        expect(served).toStrictEqual(
          fullCorrelation(repo.rowsOf(SESSION_A, DEFAULT_TRACE_ID), DEFAULT_TRACE_ID, step),
        );
      }
    }

    // Children of the primary root merge into its real children, ahead of the
    // repaired orphan, which stays the last child — the suffix
    // `correlateGroup` appends.
    await stream(30, 1);
    const withOrphan = treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'a hit');
    const primary = withOrphan.roots[0];
    expect(primary?.event.spanId).toBe(root.spanId);
    expect(primary?.children.length).toBeGreaterThan(1);
    expect(primary?.children.at(-1)?.event.spanId).toBe(orphan.spanId);
    expect(primary?.children.at(-1)?.orphaned).toBe(true);
    expect(repo.traceLoads).toHaveLength(1);
    expect(correlator.stats()).toMatchObject({ extensions: 30, invalidations: 0 });

    // The fetch the orphan names lands. The orphan moves under it and loses
    // its flags — in the cached tree, by extension, with no store read.
    const lateParent = makeEvent({
      spanId: absentFetch,
      parentSpanId: root.spanId,
      kind: 'fetch',
      name: 'POST /api/one',
      startTime: at(3.25),
      duration: 32.5,
      producerId: PRODUCER_BROWSER,
    });
    repo.put([lateParent]);
    recordPersisted(trace, [lateParent]);
    valueOf(await correlator.onEventsPersisted([lateParent]), 'onEventsPersisted with the parent');

    expect(correlator.stats()).toMatchObject({
      cachedTraces: 1,
      cachedNodes: trace.rows.length,
      cachedWeight: indexedWeight(trace.rows.length),
      extensions: 31,
      invalidations: 0,
    });
    expect(batchSummaries(logs).at(-1)?.fields).toMatchObject({ extended: 1, invalidated: 0 });
    expect(batchSummaries(logs).at(-1)?.fields['dropReasons']).toBeUndefined();

    const adopted = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read after the late parent',
    );
    expect(repo.traceLoads).toHaveLength(1);
    expect(adopted.orphanCount).toBe(0);
    expect(nodeFor(adopted, orphan.spanId)).toMatchObject({ depth: 2, orphaned: false });
    expect(spanIdsOfNodes(ancestorsOfSpanId(adopted, orphan.spanId))).toEqual([
      root.spanId,
      lateParent.spanId,
    ]);
    const reference = fullCorrelation(
      repo.rowsOf(SESSION_A, DEFAULT_TRACE_ID),
      DEFAULT_TRACE_ID,
      1,
    );
    expect(adopted).toStrictEqual(reference);
    expect(JSON.stringify(adopted)).toBe(JSON.stringify(reference));

    // And extension simply continues: thirty more steps, not one load.
    await stream(30, 31);
    expect(repo.traceLoads).toHaveLength(1);
    expect(correlator.stats()).toMatchObject({ extensions: 61, invalidations: 0, rebuilds: 1 });
  });

  it('serves a demo-shaped stream — server spans ahead of their fetch, read after every batch — from extensions alone', async () => {
    const interaction = makeEvent({
      kind: 'interaction',
      name: 'click control',
      startTime: at(0),
      duration: 60_000,
    });
    const trace = streamingTrace(interaction);
    const repo = fakeTelemetryRepo([interaction]);
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);
    const requests = 120;

    // The interaction is read once; it is the only store read of the run.
    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the seeding read');
    expect(repo.traceLoads).toHaveLength(1);

    let totalBuilt = 0;
    let reads = 0;

    /** Persists and announces one batch, then reads and checks the trace. */
    async function persistAndRead(
      batch: readonly TelemetryEvent[],
      step: number,
      expectedBuilt: number,
      expectedOrphans: number,
    ): Promise<void> {
      repo.put(batch);
      recordPersisted(trace, batch);
      valueOf(
        await correlator.onEventsPersisted(arrivalOrder(batch, [], step)),
        'onEventsPersisted for one half of a request',
      );

      const built = correlator.stats().extensionNodesBuilt - totalBuilt;
      totalBuilt += built;
      expect(built).toBe(expectedBuilt);

      const served = treeOf(
        await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
        'the read after one half of a request',
      );
      reads += 1;
      const reference = fullCorrelation(
        repo.rowsOf(SESSION_A, DEFAULT_TRACE_ID),
        DEFAULT_TRACE_ID,
        step,
      );
      expect(served).toStrictEqual(reference);
      if (step % 40 === 0) {
        expect(JSON.stringify(served)).toBe(JSON.stringify(reference));
      }
      expect(served.orphanCount).toBe(expectedOrphans);
      expect(correlator.stats()).toEqual(
        statsWith({
          cachedTraces: 1,
          cachedNodes: trace.rows.length,
          cachedWeight: indexedWeight(trace.rows.length),
          hits: reads,
          misses: 1,
          rebuilds: 1,
          extensions: reads,
          extensionNodesBuilt: totalBuilt,
        }),
      );
    }

    for (let request = 0; request < requests; request += 1) {
      const offset = 1 + request * 25;
      const fetch = makeEvent({
        parentSpanId: interaction.spanId,
        kind: 'fetch',
        name: 'POST /api/one',
        startTime: at(offset),
        duration: 11.75,
        producerId: PRODUCER_BROWSER,
      });
      // The preload's four spans land first, naming a fetch the store does not
      // hold yet: one orphan subtree on the interaction. The step builds the
      // four spans and copies the interaction that holds the orphan.
      const server = serverHalf(trace, fetch, offset + 0.875);
      await persistAndRead(server, 2 * request + 1, server.length + 1, 1);

      // Then the fetch: the late parent adopts the orphan, whose subtree moves
      // one level down. The fetch, the four moved spans and the interaction.
      await persistAndRead([fetch], 2 * request + 2, 1 + server.length + 1, 0);
    }

    // Not one store read after the seeding read, and every batch extended.
    expect(repo.traceLoads).toHaveLength(1);
    expect(trace.rows.length).toBe(1 + requests * 5);
    const summaries = batchSummaries(logs);
    expect(summaries).toHaveLength(2 * requests);
    for (const summary of summaries) {
      expect(summary.fields['extended']).toBe(1);
      expect(summary.fields['invalidated']).toBe(0);
      expect(summary.fields['dropReasons']).toBeUndefined();
    }
  });

  it('falls back to exactly one lazy rebuild when a batch moves the anchor, then resumes extending', async () => {
    const random = seededRandom(515_151);
    // The server spans of the first request land before anything from the
    // browser: no genuine root, so the trace is anchored on the orphan.
    const interaction = makeEvent({
      kind: 'interaction',
      name: 'click control',
      startTime: at(0),
      duration: 5_000,
    });
    const firstFetch = makeEvent({
      parentSpanId: interaction.spanId,
      kind: 'fetch',
      name: 'POST /api/one',
      startTime: at(1),
      duration: 11.75,
      producerId: PRODUCER_BROWSER,
    });
    // The model counts the interaction from the start; the store receives it
    // only once the server spans are in.
    const trace = streamingTrace(interaction);
    const server = serverHalf(trace, firstFetch, 1.875);
    recordPersisted(trace, server);
    const repo = fakeTelemetryRepo(server);
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const anchoredOnRepair = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read before the browser batch',
    );
    expect(anchoredOnRepair.primaryRootSpanId).toBe(eventAt(server, 0).spanId);
    expect(anchoredOnRepair.roots[0]?.orphaned).toBe(true);
    expect(repo.traceLoads).toHaveLength(1);

    // The interaction lands: the trace's first genuine root takes the anchor
    // over, which no extension can do exactly. The tree is dropped, and ingest
    // still reads nothing.
    repo.put([interaction]);
    valueOf(
      await correlator.onEventsPersisted([interaction]),
      'onEventsPersisted with the interaction',
    );
    expect(correlator.stats()).toMatchObject({
      cachedTraces: 0,
      cachedNodes: 0,
      cachedWeight: 0,
      extensions: 0,
      invalidations: 1,
    });
    expect(batchSummaries(logs).at(-1)?.fields['dropReasons']).toEqual({ 'primary-change': 1 });
    expect(repo.traceLoads).toHaveLength(1);

    // Exactly one rebuild, by the next read, which converges on the click.
    const reanchored = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read after the interaction',
    );
    expect(repo.traceLoads).toHaveLength(2);
    expect(reanchored.primaryRootSpanId).toBe(interaction.spanId);
    expect(reanchored.orphanCount).toBe(1);
    expect(reanchored).toStrictEqual(
      fullCorrelation(repo.rowsOf(SESSION_A, DEFAULT_TRACE_ID), DEFAULT_TRACE_ID, 2),
    );

    // Extension resumes: the fetch adopts the server spans, and thirty more
    // alternating steps follow — not one more load.
    repo.put([firstFetch]);
    recordPersisted(trace, [firstFetch]);
    valueOf(await correlator.onEventsPersisted([firstFetch]), 'onEventsPersisted with the fetch');
    const adopted = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read after the fetch',
    );
    expect(adopted.orphanCount).toBe(0);
    expect(adopted).toStrictEqual(
      fullCorrelation(repo.rowsOf(SESSION_A, DEFAULT_TRACE_ID), DEFAULT_TRACE_ID, 3),
    );

    for (let step = 1; step <= 30; step += 1) {
      const fresh = streamingBatch(random, trace, step);
      repo.put(fresh);
      recordPersisted(trace, fresh);
      valueOf(
        await correlator.onEventsPersisted(arrivalOrder(fresh, [], step)),
        'onEventsPersisted for one streaming batch',
      );
      expect(
        treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'a read while streaming'),
      ).toStrictEqual(
        fullCorrelation(repo.rowsOf(SESSION_A, DEFAULT_TRACE_ID), DEFAULT_TRACE_ID, step),
      );
    }
    expect(repo.traceLoads).toHaveLength(2);
    expect(correlator.stats()).toMatchObject({
      extensions: 31,
      invalidations: 1,
      rebuilds: 2,
      cachedNodes: trace.rows.length,
      cachedWeight: indexedWeight(trace.rows.length),
    });
  });

  it('extends each capture-scoped tree with its own capture\u2019s events alone, and the session-wide tree with both', async () => {
    const random = seededRandom(90_001);
    const shared = newTraceId();
    const firstRoot = makeEvent({
      captureId: CAPTURE_A1,
      traceId: shared,
      kind: 'interaction',
      name: 'click control',
      startTime: at(0),
      duration: 5_000,
    });
    const secondRoot = makeEvent({
      captureId: CAPTURE_A2,
      traceId: shared,
      kind: 'interaction',
      name: 'click control',
      startTime: at(0.5),
      duration: 5_000,
    });
    const captures = [
      streamingTrace(firstRoot, { captureId: CAPTURE_A1, traceId: shared }),
      streamingTrace(secondRoot, { captureId: CAPTURE_A2, traceId: shared }),
    ] as const;
    const repo = fakeTelemetryRepo([firstRoot, secondRoot]);
    const correlator = correlatorOver(repo, recordingLogger().logger);
    const scopes = [undefined, CAPTURE_A1, CAPTURE_A2] as const;

    const served = new Map<CaptureId | undefined, TraceTree>();
    for (const captureId of scopes) {
      served.set(
        captureId,
        treeOf(await correlator.getTrace(SESSION_A, shared, captureId), 'a seeding read'),
      );
    }
    expect(repo.traceLoads).toHaveLength(3);

    let extensions = 0;
    for (let step = 1; step <= 80; step += 1) {
      const draw = random();
      const reached = captures.filter((_, position) =>
        draw < 0.4 ? position === 0 : draw < 0.8 ? position === 1 : true,
      );
      const fresh: TelemetryEvent[] = [];
      for (const capture of reached) {
        const events = streamingBatch(random, capture, step);
        recordPersisted(capture, events);
        fresh.push(...events);
      }
      repo.put(fresh);
      valueOf(
        await correlator.onEventsPersisted(arrivalOrder(fresh, [], step)),
        'onEventsPersisted for one batch of one or both captures',
      );

      // The session-wide tree and the tree of every capture the batch named.
      extensions += 1 + reached.length;
      expect(correlator.stats()).toMatchObject({ extensions, invalidations: 0, cachedTraces: 3 });

      for (const captureId of scopes) {
        const tree = treeOf(
          await correlator.getTrace(SESSION_A, shared, captureId),
          'a read after the batch',
        );
        const stored =
          captureId === undefined
            ? repo.rowsOf(SESSION_A, shared)
            : repo.rowsOf(SESSION_A, shared).filter((row) => row.captureId === captureId);
        expect(tree).toStrictEqual(fullCorrelation(stored, shared, step));

        const named =
          captureId === undefined ||
          reached.some((capture) => capture.scope.captureId === captureId);
        if (!named) {
          // A capture the batch did not name keeps the very tree it had.
          expect(tree).toBe(served.get(captureId));
        }
        served.set(captureId, tree);
      }
    }
    expect(repo.traceLoads).toHaveLength(3);

    // A span of the second capture hung under the first capture's root: the
    // join places it there, while the second capture's own rows do not hold
    // its parent, so that tree repairs it onto its anchor as an orphan — both
    // extended exactly, and neither with a store read.
    const [firstCapture] = captures;
    const crossParent = makeEvent({
      captureId: CAPTURE_A2,
      traceId: shared,
      parentSpanId: firstRoot.spanId,
      kind: 'fetch',
      name: 'POST /api/one',
      startTime: at(17.375),
      duration: 2.5,
      producerId: PRODUCER_BROWSER,
    });
    repo.put([crossParent]);
    valueOf(await correlator.onEventsPersisted([crossParent]), 'a span parented across captures');
    expect(correlator.stats()).toMatchObject({
      extensions: extensions + 2,
      invalidations: 0,
      cachedTraces: 3,
    });

    const secondAfter = treeOf(
      await correlator.getTrace(SESSION_A, shared, CAPTURE_A2),
      'the second capture after the cross-capture span',
    );
    expect(nodeFor(secondAfter, crossParent.spanId)).toMatchObject({
      orphaned: true,
      orphanReason: 'missing-parent',
      missingParentSpanId: firstRoot.spanId,
    });
    expect(secondAfter).toStrictEqual(
      fullCorrelation(
        repo.rowsOf(SESSION_A, shared).filter((row) => row.captureId === CAPTURE_A2),
        shared,
        5,
      ),
    );
    const joinAfter = treeOf(
      await correlator.getTrace(SESSION_A, shared),
      'the join after the cross-capture span',
    );
    expect(joinAfter).toStrictEqual(fullCorrelation(repo.rowsOf(SESSION_A, shared), shared, 3));
    expect(nodeFor(joinAfter, crossParent.spanId).orphaned).toBe(false);
    expect(
      treeOf(await correlator.getTrace(SESSION_A, shared, CAPTURE_A1), 'the first capture')
        .nodeCount,
    ).toBe(firstCapture.rows.length);
    expect(repo.traceLoads).toHaveLength(3);
  });

  it('treats a batch of replays as a no-op that keeps the served tree, and counts only new rows in a mixed batch', async () => {
    const chain = canonicalChain();
    const repo = fakeTelemetryRepo(chain);
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const tree = treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the first read');
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 1, cachedNodes: chain.length, misses: 1, rebuilds: 1 }),
    );

    // Replays alone: the stored rows are the ones the tree was built from. The
    // extension index the batch built is kept, and the entry weighed with it.
    const replays = [eventAt(chain, 2), eventAt(chain, 0)];
    valueOf(await correlator.onEventsPersisted(replays), 'a batch of replays');
    const afterReplay = statsWith({
      cachedTraces: 1,
      cachedNodes: chain.length,
      cachedWeight: indexedWeight(chain.length),
      misses: 1,
      rebuilds: 1,
    });
    expect(correlator.stats()).toEqual(afterReplay);
    expect(batchSummaries(logs).at(-1)?.fields).toMatchObject({
      extended: 0,
      unchanged: 1,
      invalidated: 0,
    });

    // The same batch again changes nothing at all, and the tree served is the
    // very one served before.
    valueOf(await correlator.onEventsPersisted(replays), 'the same replays again');
    expect(correlator.stats()).toEqual(afterReplay);
    expect(treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'a hit')).toBe(tree);

    // A batch mixing a new leaf with a replay builds the leaf and its path.
    const leaf = makeEvent({
      parentSpanId: eventAt(chain, chain.length - 1).spanId,
      kind: 'function',
      name: 'operation',
      startTime: at(19.5),
      producerId: PRODUCER_SERVER,
    });
    repo.put([leaf]);
    valueOf(
      await correlator.onEventsPersisted([eventAt(chain, 1), leaf]),
      'a batch of one replay and one new row',
    );
    expect(correlator.stats()).toEqual(
      statsWith({
        cachedTraces: 1,
        cachedNodes: chain.length + 1,
        cachedWeight: indexedWeight(chain.length + 1),
        hits: 1,
        misses: 1,
        rebuilds: 1,
        extensions: 1,
        extensionNodesBuilt: 1 + chain.length,
      }),
    );
    expect(
      treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the read after the leaf'),
    ).toStrictEqual(fullCorrelation([...chain, leaf], DEFAULT_TRACE_ID, 5));
    expect(repo.traceLoads).toHaveLength(1);
  });

  it('keeps the weight total exact through extension, eviction, invalidation and close', async () => {
    const [first, second, third, fourth] = [newTraceId(), newTraceId(), newTraceId(), newTraceId()];
    const rows = new Map<TraceId, TelemetryEvent[]>(
      [first, second, third, fourth].map((traceId) => [traceId, linearChain(10, { traceId })]),
    );
    const repo = fakeTelemetryRepo([...rows.values()].flat());
    const correlator = correlatorOver(repo, recordingLogger().logger, {
      cacheNodeBudget: 40,
      maxCachedTreeNodes: 20,
    });

    /** A new leaf under the deepest row of one trace, persisted. */
    const grow = (traceId: TraceId): TelemetryEvent => {
      const chainRows = rows.get(traceId) ?? [];
      const deepest = eventAt(chainRows, chainRows.length - 1);
      const leaf = makeEvent({
        traceId,
        parentSpanId: deepest.spanId,
        startTime: at(chainRows.length + 0.25),
      });
      chainRows.push(leaf);
      repo.put([leaf]);
      return leaf;
    };

    treeOf(await correlator.getTrace(SESSION_A, first), 'the first trace');
    treeOf(await correlator.getTrace(SESSION_A, second), 'the second trace');
    expect(correlator.stats()).toMatchObject({ cachedNodes: 20, cachedWeight: 20 });

    // Extending the first: eleven nodes plus the index's share, and the entry
    // becomes the newest write.
    valueOf(await correlator.onEventsPersisted([grow(first)]), 'a batch for the first trace');
    expect(correlator.stats()).toMatchObject({
      cachedTraces: 2,
      cachedNodes: 11 + 10,
      cachedWeight: indexedWeight(11) + 10,
    });

    treeOf(await correlator.getTrace(SESSION_A, third), 'the third trace');
    valueOf(
      await correlator.onEventsPersisted([grow(second), grow(second)]),
      'a batch of two chained leaves for the second trace',
    );
    expect(correlator.stats()).toMatchObject({
      cachedTraces: 3,
      cachedNodes: 11 + 10 + 12,
      cachedWeight: indexedWeight(11) + 10 + indexedWeight(12),
      extensions: 2,
    });

    // A fourth tree takes the weight past the budget of forty: the oldest write
    // goes — the first trace, extended before the third was read — and the
    // totals stay exact. Eviction is not invalidation.
    treeOf(await correlator.getTrace(SESSION_A, fourth), 'the fourth trace');
    expect(correlator.stats()).toMatchObject({
      cachedTraces: 3,
      cachedNodes: 10 + 12 + 10,
      cachedWeight: 10 + indexedWeight(12) + 10,
      invalidations: 0,
    });

    // Invalidation subtracts an indexed entry's exact weight.
    correlator.invalidate(SESSION_A, second);
    expect(correlator.stats()).toMatchObject({
      cachedTraces: 2,
      cachedNodes: 20,
      cachedWeight: 20,
      invalidations: 1,
    });

    // The evicted trace is a miss that reloads it whole.
    treeOf(await correlator.getTrace(SESSION_A, first), 'the evicted trace again');
    expect(repo.loadsOf(first)).toBe(2);
    expect(correlator.stats()).toMatchObject({
      cachedTraces: 3,
      cachedNodes: 31,
      cachedWeight: 31,
    });

    // Close releases every entry, to exactly zero.
    correlator.close();
    expect(correlator.stats()).toMatchObject({ cachedTraces: 0, cachedNodes: 0, cachedWeight: 0 });
  });

  it('holds the indexed weight to the per-entry cap, before indexing and after extending', async () => {
    const logs = recordingLogger();
    const nearCap = newTraceId();
    const growing = newTraceId();
    const nearCapRows = linearChain(19, { traceId: nearCap });
    const growingRows = linearChain(17, { traceId: growing });
    const repo = fakeTelemetryRepo([...nearCapRows, ...growingRows]);
    const correlator = correlatorOver(repo, logs.logger, { maxCachedTreeNodes: 20 });

    /** A new leaf under the deepest row of `chain`, persisted. */
    const grow = (chain: TelemetryEvent[], traceId: TraceId): TelemetryEvent => {
      const deepest = eventAt(chain, chain.length - 1);
      const leaf = makeEvent({
        traceId,
        parentSpanId: deepest.spanId,
        startTime: at(chain.length + 0.25),
      });
      chain.push(leaf);
      repo.put([leaf]);
      return leaf;
    };

    // Nineteen nodes fit the cap unindexed, and weigh twenty-one indexed: a
    // batch reaching the entry drops it without building the index.
    expect(indexedWeight(19)).toBeGreaterThan(20);
    treeOf(await correlator.getTrace(SESSION_A, nearCap), 'a tree just under the cap');
    expect(correlator.stats()).toMatchObject({ cachedTraces: 1, cachedWeight: 19 });
    valueOf(
      await correlator.onEventsPersisted([grow(nearCapRows, nearCap)]),
      'a batch for the tree just under the cap',
    );
    expect(correlator.stats()).toMatchObject({
      cachedTraces: 0,
      cachedNodes: 0,
      cachedWeight: 0,
      extensions: 0,
      invalidations: 1,
    });
    expect(batchSummaries(logs).at(-1)?.fields['dropReasons']).toEqual({ 'over-cap': 1 });

    // Seventeen nodes weigh nineteen indexed and eighteen weigh twenty, both
    // within the cap; nineteen do not, so the extension that reaches them
    // leaves the tree uncached.
    treeOf(await correlator.getTrace(SESSION_A, growing), 'a tree of seventeen');
    valueOf(
      await correlator.onEventsPersisted([grow(growingRows, growing)]),
      'growing it to eighteen',
    );
    expect(indexedWeight(18)).toBe(20);
    expect(correlator.stats()).toMatchObject({
      cachedTraces: 1,
      cachedNodes: 18,
      cachedWeight: indexedWeight(18),
      extensions: 1,
      invalidations: 1,
    });

    valueOf(
      await correlator.onEventsPersisted([grow(growingRows, growing)]),
      'growing it to nineteen',
    );
    expect(correlator.stats()).toMatchObject({
      cachedTraces: 0,
      cachedNodes: 0,
      cachedWeight: 0,
      extensions: 1,
      invalidations: 2,
    });
    expect(batchSummaries(logs).at(-1)?.fields['dropReasons']).toEqual({ 'over-cap': 1 });

    // Reported by its counts, weight included.
    const refused = logs
      .at('debug')
      .filter((record) => record.fields['maxTreeNodes'] !== undefined)
      .at(-1);
    expect(refused?.fields).toMatchObject({
      nodeCount: 19,
      weight: indexedWeight(19),
      maxTreeNodes: 20,
    });

    // The next read rebuilds the whole tree, which fits unindexed.
    expect(treeOf(await correlator.getTrace(SESSION_A, growing), 'the rebuilt tree')).toStrictEqual(
      fullCorrelation(growingRows, growing, 4),
    );
    expect(correlator.stats()).toMatchObject({ cachedTraces: 1, cachedWeight: 19 });
  });

  it('drops a cached tree it cannot index, and one a malformed row makes the extension throw on, and rebuilds each once', async () => {
    const chain = canonicalChain();
    const repeated = makeEvent({
      spanId: eventAt(chain, 1).spanId,
      parentSpanId: eventAt(chain, 0).spanId,
      kind: 'fetch',
      name: 'POST /api/one',
      startTime: at(9.5),
    });
    const repo = fakeTelemetryRepo([...chain, repeated]);
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    // A tree with a duplicated span id: which occurrence owns the children a
    // new row names depends on the canonical order of the duplicates, so the
    // tree is not extendable and a batch drops it.
    const duplicated = treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'a read');
    expect(duplicated.duplicateSpanIds).toEqual([eventAt(chain, 1).spanId]);
    const leaf = makeEvent({
      parentSpanId: eventAt(chain, chain.length - 1).spanId,
      startTime: at(19.25),
      producerId: PRODUCER_SERVER,
    });
    repo.put([leaf]);
    valueOf(await correlator.onEventsPersisted([leaf]), 'a batch for an unindexable tree');
    expect(correlator.stats()).toMatchObject({ cachedTraces: 0, invalidations: 1, extensions: 0 });
    expect(batchSummaries(logs).at(-1)?.fields['dropReasons']).toEqual({ 'not-extendable': 1 });
    expect(
      treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the rebuild'),
    ).toStrictEqual(fullCorrelation([...chain, repeated, leaf], DEFAULT_TRACE_ID, 2));
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(2);

    // A defective caller hands over a row whose span id cannot be read. The
    // store holds the real row; the cached tree is dropped rather than the
    // throw escaping ingest, and the next read rebuilds from the store.
    const other = newTraceId();
    const otherRoot = makeEvent({ traceId: other, kind: 'interaction', name: 'click control' });
    const otherChild = makeEvent({
      traceId: other,
      parentSpanId: otherRoot.spanId,
      startTime: at(1.75),
    });
    repo.put([otherRoot]);
    treeOf(await correlator.getTrace(SESSION_A, other), 'a read of the second trace');
    repo.put([otherChild]);
    const hostile: TelemetryEvent = { ...otherChild };
    Object.defineProperty(hostile, 'spanId', {
      enumerable: true,
      get: () => {
        throw new Error(`unreadable span id near ${SENTINEL}`);
      },
    });
    const outcome = await correlator.onEventsPersisted([hostile]);
    expect(valueOf(outcome, 'onEventsPersisted with a hostile row').tracesTouched).toEqual([other]);
    expect(correlator.stats()).toMatchObject({ invalidations: 2, extensions: 0 });
    expect(batchSummaries(logs).at(-1)?.fields['dropReasons']).toEqual({ 'extension-failed': 1 });
    expect(
      treeOf(await correlator.getTrace(SESSION_A, other), 'the second trace rebuilt'),
    ).toStrictEqual(fullCorrelation([otherRoot, otherChild], other, 3));
    expect(repo.loadsOf(other)).toBe(2);

    // Every refusal reason the log may carry comes from the closed vocabulary,
    // and no captured value reached a record.
    for (const summary of batchSummaries(logs)) {
      const reasons = summary.fields['dropReasons'];
      if (reasons !== undefined && typeof reasons === 'object' && reasons !== null) {
        for (const reason of Object.keys(reasons)) {
          expect([
            ...EXTENSION_REFUSAL_REASONS,
            'not-extendable',
            'over-cap',
            'extension-failed',
          ]).toContain(reason);
        }
      }
    }
    for (const segment of SENTINEL_SEGMENTS) {
      expect(logs.text()).not.toContain(segment);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Reads that race a batch
 *
 * A read loads what the store holds when it starts. A batch persisted before
 * the read finishes makes that tree stale the moment it lands, so the read may
 * answer with it but must not cache it: the next read would be served a tree
 * that predates rows the store now holds.
 * ---------------------------------------------------------------------------------------------- */

describe('reads that race a batch', () => {
  it('answers a read that raced a batch with what it loaded, and caches nothing from it', async () => {
    const chain = canonicalChain();
    const store = fakeTelemetryRepo(chain.slice(0, 3));
    const gate = gatedTelemetryRepo(store);
    const logs = recordingLogger();
    const correlator = correlatorOver(gate.repo, logs.logger);

    // The read has loaded the first three rows and is waiting on its answer.
    const racing = correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID);
    expect(gate.held()).toBe(1);

    // The rest of the interaction is persisted and announced meanwhile.
    const arriving = chain.slice(3);
    store.put(arriving);
    valueOf(await correlator.onEventsPersisted(arriving), 'the batch that lands mid-read');

    gate.release();
    const raced = treeOf(await racing, 'the read that raced the batch');

    // The caller gets the tree it loaded; the cache gets nothing.
    expect(raced.nodeCount).toBe(3);
    expect(correlator.stats()).toEqual(statsWith({ misses: 1, rebuilds: 1 }));
    expect(
      logs
        .at('debug')
        .filter(
          (record) =>
            record.fields['nodeCount'] === 3 && record.fields['traceId'] === DEFAULT_TRACE_ID,
        ),
    ).toHaveLength(1);

    // The next read misses, sees the new rows, and caches them.
    const next = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read after the race',
    );
    expect(next.nodeCount).toBe(chain.length);
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 1, cachedNodes: chain.length, misses: 2, rebuilds: 2 }),
    );
    expect(treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the hit after it')).toBe(
      next,
    );
  });

  it('marks stale exactly the racing reads of the scopes a batch changed', async () => {
    const shared = newTraceId();
    const store = fakeTelemetryRepo([
      ...linearChain(3, { captureId: CAPTURE_A1, traceId: shared }),
      ...linearChain(2, { captureId: CAPTURE_A2, traceId: shared }),
    ]);
    const gate = gatedTelemetryRepo(store);
    const correlator = correlatorOver(gate.repo, recordingLogger().logger);

    // Three scopes of one trace in flight together.
    const sessionWide = correlator.getTrace(SESSION_A, shared);
    const firstCapture = correlator.getTrace(SESSION_A, shared, CAPTURE_A1);
    const secondCapture = correlator.getTrace(SESSION_A, shared, CAPTURE_A2);
    expect(gate.held()).toBe(3);

    // A batch that names only the first capture.
    const late = makeEvent({ captureId: CAPTURE_A1, traceId: shared, startTime: at(9.5) });
    store.put([late]);
    valueOf(await correlator.onEventsPersisted([late]), 'a batch for the first capture');

    gate.release();
    expect(treeOf(await sessionWide, 'the session-wide read').nodeCount).toBe(5);
    expect(treeOf(await firstCapture, 'the first capture read').nodeCount).toBe(3);
    const second = treeOf(await secondCapture, 'the second capture read');

    // The join and the first capture changed, so neither racing read cached;
    // the second capture did not, so its read cached as usual.
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 1, cachedNodes: 2, misses: 3, rebuilds: 3 }),
    );
    expect(
      treeOf(await correlator.getTrace(SESSION_A, shared, CAPTURE_A2), 'the second capture again'),
    ).toBe(second);
    expect(
      treeOf(await correlator.getTrace(SESSION_A, shared, CAPTURE_A1), 'the first capture again')
        .nodeCount,
    ).toBe(4);
  });

  it('marks racing reads stale on invalidate and close, by the same scope rule as the cache', async () => {
    const traceA = newTraceId();
    const traceB = newTraceId();
    const click = { kind: 'interaction', name: 'click control' } as const;
    const store = fakeTelemetryRepo([
      makeEvent({ ...click, traceId: traceA }),
      makeEvent({ ...click, traceId: traceB }),
      makeEvent({ ...click, sessionId: SESSION_B, traceId: traceA }),
    ]);
    const gate = gatedTelemetryRepo(store);
    const correlator = correlatorOver(gate.repo, recordingLogger().logger);

    const invalidatedRead = correlator.getTrace(SESSION_A, traceA, CAPTURE_A1);
    const otherTraceRead = correlator.getTrace(SESSION_A, traceB);
    const otherSessionRead = correlator.getTrace(SESSION_B, traceA);

    // One trace of one session, under every scope: the capture-scoped read of
    // it is reached; another trace and another session are not.
    correlator.invalidate(SESSION_A, traceA);
    gate.release();
    await Promise.all([invalidatedRead, otherTraceRead, otherSessionRead]);
    expect(correlator.stats()).toMatchObject({ cachedTraces: 2, cachedNodes: 2 });
    expect(
      valueOf(await correlator.getTrace(SESSION_A, traceA, CAPTURE_A1), 'the invalidated scope'),
    ).toBeDefined();
    expect(correlator.stats()).toMatchObject({ cachedTraces: 3, misses: 4, hits: 0 });

    // Close reaches every read in flight.
    const closed = gatedTelemetryRepo(store);
    const afterClose = correlatorOver(closed.repo, recordingLogger().logger);
    const inFlight = afterClose.getTrace(SESSION_A, traceB);
    afterClose.close();
    closed.release();
    expect(treeOf(await inFlight, 'the read in flight across close').nodeCount).toBe(1);
    expect(afterClose.stats()).toEqual(statsWith({ misses: 1, rebuilds: 1 }));
  });
});

/* -------------------------------------------------------------------------------------------------
 * Failure discipline and privacy
 *
 * Every method answers with a `Result` and nothing throws; a failure is never
 * dressed up as evidence, and captured data never reaches a log record or an
 * error payload (AAP §0.5.2, §0.5.5).
 * ---------------------------------------------------------------------------------------------- */

describe('failure discipline and privacy', () => {
  it('returns the store refusal unchanged and leaves the cache consistent', async () => {
    const chain = canonicalChain();
    const refusedTrace = newTraceId();
    const refusal = new DebuggenError('STORE_ERROR', 'The telemetry store refused the read.', {
      hint: 'Check the service log and retry.',
      details: { operation: 'listByTrace' },
    });

    const repo = fakeTelemetryRepo([...chain, ...canonicalChain({ traceId: refusedTrace })]);
    repo.behaveFor(refusedTrace, { kind: 'refuses', error: refusal });
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const failed = await correlator.getTrace(SESSION_A, refusedTrace);
    const error = failureOf(failed, 'getTrace over a refusing store');

    // The store's own refusal, with its own code and curated message: this
    // module re-codes nothing it did not raise itself.
    expect(error).toBe(refusal);
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);

    // Nothing cached for the failed read, and an unaffected trace still works.
    expect(correlator.stats().cachedTraces).toBe(0);
    const healthy = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read of an unaffected trace',
    );
    expect(healthy.nodeCount).toBe(chain.length);
    expect(correlator.stats().cachedTraces).toBe(1);
    expect(logs.at('warn').map((record) => record.fields['code'])).toEqual(['STORE_ERROR']);
  });

  it('turns a throw from the store into a reportable error without throwing itself', async () => {
    const repo = fakeTelemetryRepo(canonicalChain());
    repo.behaveFor(DEFAULT_TRACE_ID, {
      kind: 'throws',
      thrown: new Error(`the store exploded while reading ${SENTINEL}`),
    });
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    // The module's headline guarantee, stated directly: a store that throws is
    // reported, never propagated, so no caller of this module needs a `catch`.
    await expect(correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID)).resolves.toHaveProperty(
      'ok',
      false,
    );

    const outcome = await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID);
    const error = failureOf(outcome, 'getTrace over a throwing store');

    expect(error.code).toBe('STORE_ERROR');
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.hint).toBeDefined();
    // The caught value is reachable as `cause` for a local stack trace and is
    // never forwarded into the payload that crosses a boundary.
    expect(error.cause).toBeInstanceOf(Error);
    for (const segment of SENTINEL_SEGMENTS) {
      expect(errorText(error)).not.toContain(segment);
      expect(logs.text()).not.toContain(segment);
    }
    expect(correlator.stats().cachedTraces).toBe(0);
  });

  it('turns a rejected asynchronous read into a reportable error', async () => {
    const repo = fakeTelemetryRepo(canonicalChain(), { async: true });
    repo.behaveFor(DEFAULT_TRACE_ID, {
      kind: 'rejects',
      thrown: new Error('the asynchronous store rejected'),
    });
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const error = failureOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace over a rejecting store',
    );
    expect(error.code).toBe('STORE_ERROR');

    // The same port, answering with promises throughout, still correlates.
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'rows' });
    const tree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace over an asynchronous store',
    );
    expect(tree.nodeCount).toBe(CANONICAL_CHAIN_STEPS.length);
  });

  it('reports a failed enumeration and propagates it through getTraces', async () => {
    const repo = fakeTelemetryRepo(canonicalChain());
    repo.failIdListing({ kind: 'throws', thrown: new Error(`enumeration failed for ${SENTINEL}`) });
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const listing = failureOf(await correlator.listTraceIds(SESSION_A), 'listTraceIds');
    expect(listing.code).toBe('STORE_ERROR');

    const traces = failureOf(await correlator.getTraces(SESSION_A, CAPTURE_A1), 'getTraces');
    expect(traces.code).toBe('STORE_ERROR');
    expect(repo.traceLoads).toHaveLength(0);

    for (const segment of SENTINEL_SEGMENTS) {
      expect(errorText(listing)).not.toContain(segment);
      expect(errorText(traces)).not.toContain(segment);
      expect(logs.text()).not.toContain(segment);
    }
  });

  it('never fails a batch over a failing store, and each read then fails or succeeds on its own', async () => {
    const healthyTrace = newTraceId();
    const failingTrace = newTraceId();

    const healthyRows = canonicalChain({ traceId: healthyTrace });
    const failingRows = canonicalChain({ traceId: failingTrace });

    const repo = fakeTelemetryRepo([...healthyRows, ...failingRows]);
    repo.behaveFor(failingTrace, { kind: 'throws', thrown: new Error('transient store failure') });
    const correlator = correlatorOver(repo, recordingLogger().logger);

    // Ingest reads nothing, so a store that would fail a read cannot fail it.
    const batch = [eventAt(healthyRows, 0), eventAt(failingRows, 0)];
    const update = valueOf(await correlator.onEventsPersisted(batch), 'onEventsPersisted');
    expect(update.tracesTouched).toEqual([healthyTrace, failingTrace]);
    expect(repo.traceLoads).toHaveLength(0);

    // The failure surfaces on the read of its own trace, and caches nothing.
    const failed = failureOf(
      await correlator.getTrace(SESSION_A, failingTrace),
      'the read of the failing trace',
    );
    expect(failed.code).toBe('STORE_ERROR');
    const healthyTree = treeOf(
      await correlator.getTrace(SESSION_A, healthyTrace),
      'the read of the healthy trace',
    );
    expect(healthyTree.nodeCount).toBe(healthyRows.length);
    expect(correlator.stats()).toMatchObject({ cachedTraces: 1, misses: 2, rebuilds: 1 });

    // Once the store answers again, the next read builds the whole trace.
    repo.behaveFor(failingTrace, { kind: 'rows' });
    expect(
      treeOf(await correlator.getTrace(SESSION_A, failingTrace), 'the read after recovery')
        .nodeCount,
    ).toBe(failingRows.length);
  });

  it('refuses a trace whose store does not advance its offset, and caches nothing', async () => {
    const chain = linearChain(6);
    const repo = fakeTelemetryRepo(chain, { pageSize: 2 });
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'stalls' });
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const error = failureOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace over a stalling store',
    );

    // One page, then a stop: following an offset that does not advance would
    // re-read the same rows forever. The two rows read are not the trace, so
    // no tree is built from them and none is cached to be served later.
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(1);
    expect(error.code).toBe('STORE_ERROR');
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.hint).toBeDefined();
    expect(error.details?.['reason']).toBe('trace-page-stalled');
    expect(error.details?.['traceId']).toBe(DEFAULT_TRACE_ID);
    expect(error.details?.['pages']).toBe(1);
    expect(error.details?.['rows']).toBe(2);
    expect(error.details?.['maxPages']).toBeUndefined();
    expect(correlator.stats()).toEqual(statsWith({ misses: 1 }));

    // Reported, and identified by its fields rather than by its prose: one page
    // read, two rows held, and no page bound involved.
    const warned = logs.at('warn');
    expect(warned.map((record) => record.fields['pages'])).toEqual([1]);
    expect(warned.map((record) => record.fields['rows'])).toEqual([2]);
    expect(warned.map((record) => record.fields['maxPages'])).toEqual([undefined]);
    for (const name of [eventAt(chain, 0).name, eventAt(chain, 1).name]) {
      expect(logs.text()).not.toContain(name);
      expect(errorText(error)).not.toContain(name);
    }

    // Nothing was cached, so the next read asks the store again.
    failureOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the retried read');
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(2);
  });

  it('refuses a trace with pages left at the page bound instead of correlating a prefix of it', async () => {
    const rows = 500;
    const chain = linearChain(rows);
    const repo = fakeTelemetryRepo(chain, { pageSize: 1 });
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const error = failureOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace over a store that pages one row at a time',
    );

    const loads = repo.loadsOf(DEFAULT_TRACE_ID);
    // The bound is an internal constant, so what is asserted is the property it
    // exists for: the walk is finite, it stopped well short of the trace, and
    // it produced no tree at all rather than one built from the rows it read.
    expect(loads).toBeGreaterThan(0);
    expect(loads).toBeLessThan(rows);
    expect(error.code).toBe('STORE_ERROR');
    expect(error.details?.['reason']).toBe('trace-too-large');
    expect(error.details?.['pages']).toBe(loads);
    expect(error.details?.['rows']).toBe(loads);
    expect(error.details?.['maxPages']).toBe(loads);
    expect(correlator.stats()).toEqual(statsWith({ misses: 1 }));

    // The one warning is the page bound itself: it is the only record that
    // carries the bound it stopped at, and it stopped where the walk did.
    const warned = logs.at('warn');
    expect(warned.map((record) => record.fields['pages'])).toEqual([loads]);
    expect(warned.map((record) => record.fields['maxPages'])).toEqual([loads]);
    expect(logs.text()).not.toContain(eventAt(chain, 1).name);

    // Exactly at the bound is not over it: a trace the walk reads to its end in
    // that many pages is correlated whole.
    const bounded = newTraceId();
    const fits = linearChain(loads, { traceId: bounded });
    const fitting = fakeTelemetryRepo(fits, { pageSize: 1 });
    const whole = treeOf(
      await correlatorOver(fitting, recordingLogger().logger).getTrace(SESSION_A, bounded),
      'getTrace over a trace exactly at the page bound',
    );

    expect(whole.nodeCount).toBe(loads);
    expect(fitting.loadsOf(bounded)).toBe(loads);
  });

  it('drops exactly the trees a batch cannot absorb over a failing store, extends the ones it can, and keeps a capture it did not touch', async () => {
    const laterTrace = newTraceId();
    const chain = linearChain(6);
    const otherWindow = makeEvent({
      captureId: CAPTURE_A2,
      kind: 'interaction',
      name: 'click control',
      startTime: at(40.5),
    });
    const laterRow = makeEvent({ traceId: laterTrace, kind: 'interaction', name: 'click control' });
    const repo = fakeTelemetryRepo([...chain.slice(0, 4), otherWindow, laterRow], { pageSize: 2 });
    const correlator = correlatorOver(repo, recordingLogger().logger);

    // Cached before the batch: the failing trace under all three scopes, and a
    // second trace the batch will also touch.
    for (const captureId of [undefined, CAPTURE_A1, CAPTURE_A2]) {
      treeOf(
        await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID, captureId),
        'a read before the batch',
      );
    }
    const laterBefore = treeOf(
      await correlator.getTrace(SESSION_A, laterTrace),
      'the later trace before the batch',
    );
    expect(correlator.stats().cachedTraces).toBe(4);

    // The rest of the first capture's chain lands with a second click of that
    // trace timestamped ahead of the first — it displaces the primary root, so
    // no cached tree of it can absorb the batch exactly — and with a child span
    // of the later trace, which its tree can. The store's paging then stalls
    // for the first trace.
    const arriving = chain.slice(4);
    const secondRoot = makeEvent({
      kind: 'interaction',
      name: 'click control',
      startTime: at(0.125),
    });
    const laterArrival = makeEvent({
      traceId: laterTrace,
      parentSpanId: laterRow.spanId,
      startTime: at(2.5),
    });
    const batch = [...arriving, secondRoot, laterArrival];
    repo.put(batch);
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'stalls' });
    const loadsBefore = repo.traceLoads.length;

    const update = valueOf(
      await correlator.onEventsPersisted(batch),
      'onEventsPersisted over a stalling store',
    );

    // The batch reads nothing, so the stalling store cannot fail it.
    expect(update.tracesTouched).toEqual([DEFAULT_TRACE_ID, laterTrace]);
    expect(repo.traceLoads).toHaveLength(loadsBefore);

    // No pre-batch tree the batch made stale survives to be served as current:
    // the first trace's session-wide and first-capture trees are dropped, the
    // later trace's is extended in place of the old one. The second capture's
    // tree, whose events the batch did not change, is still cached.
    expect(correlator.stats()).toMatchObject({
      cachedTraces: 2,
      invalidations: 2,
      extensions: 1,
    });
    const hitsBefore = correlator.stats().hits;
    treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID, CAPTURE_A2),
      'the untouched capture after the batch',
    );
    const laterAfter = treeOf(
      await correlator.getTrace(SESSION_A, laterTrace),
      'the extended later trace after the batch',
    );
    expect(correlator.stats().hits).toBe(hitsBefore + 2);
    expect(laterAfter).not.toBe(laterBefore);
    expect(laterAfter).toStrictEqual(
      correlateTrace([laterRow, laterArrival], laterTrace, { maxDepth: CORRELATOR_MAX_DEPTH }),
    );

    // The stall surfaces on the read that rebuilds a dropped tree, and that
    // read caches nothing.
    const error = failureOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the session-wide read over a stalling store',
    );
    expect(error.code).toBe('STORE_ERROR');
    expect(error.details?.['reason']).toBe('trace-page-stalled');
    expect(correlator.stats().cachedTraces).toBe(2);

    // Once the store pages again, every dropped tree rebuilds whole.
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'rows' });
    expect(
      treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'session-wide after recovery')
        .nodeCount,
    ).toBe(chain.length + 2);
    expect(
      treeOf(
        await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID, CAPTURE_A1),
        'the first capture after recovery',
      ).nodeCount,
    ).toBe(chain.length + 1);
  });

  it('refuses a trace whose store reports rows it could not reconstruct, and caches nothing', async () => {
    const chain = canonicalChain();
    const repo = fakeTelemetryRepo(chain, { skippedPerPage: 2 });
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const error = failureOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace over a store reporting unreadable rows',
    );

    // Every readable row came back, and still no tree: the two the store could
    // not reconstruct may be any parent in the chain, and a tree without them
    // would reparent their children as orphans and shorten every duration.
    expect(error.code).toBe('STORE_ERROR');
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.hint).toBeDefined();
    expect(error.details?.['reason']).toBe('trace-rows-unreadable');
    expect(error.details?.['traceId']).toBe(DEFAULT_TRACE_ID);
    expect(error.details?.['unreadable']).toBe(2);
    expect(error.details?.['rows']).toBe(chain.length);
    expect(error.details?.['pages']).toBe(1);
    expect(correlator.stats()).toEqual(statsWith({ misses: 1 }));

    // Reported by its counts: the one warning names the unreadable rows, the
    // rows that were readable and the pages walked.
    const warned = logs.at('warn');
    expect(warned.map((record) => record.fields['unreadable'])).toEqual([2]);
    expect(warned.map((record) => record.fields['rows'])).toEqual([chain.length]);
    expect(warned.map((record) => record.fields['pages'])).toEqual([1]);

    // No partial tree was cached, so the next read goes back to the store and
    // is refused again rather than served the remainder.
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(1);
    const retried = failureOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the retried read over unreadable rows',
    );
    expect(retried.details?.['reason']).toBe('trace-rows-unreadable');
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(2);
    expect(correlator.stats().cachedTraces).toBe(0);

    for (const event of chain) {
      expect(logs.text()).not.toContain(event.name);
      expect(errorText(error)).not.toContain(event.name);
    }
  });

  it('leaves no pre-batch tree to serve when the rebuild after a batch finds unreadable rows', async () => {
    const chain = canonicalChain();
    const repo = fakeTelemetryRepo(chain.slice(0, 4));
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    // Cached before the batch, session-wide and for the capture the batch will
    // name, while every stored row still read back cleanly.
    treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the session-wide read');
    treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID, CAPTURE_A1),
      'the capture-scoped read',
    );
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 2, cachedNodes: 8, misses: 2, rebuilds: 2 }),
    );

    // The rest of the chain lands with a second click of the trace timestamped
    // ahead of the first — a batch neither cached tree can absorb exactly,
    // because the new span displaces the primary root — and the store now
    // holds a row of the trace it cannot reconstruct.
    const arriving = [
      ...chain.slice(4),
      makeEvent({ kind: 'interaction', name: 'click control', startTime: at(-0.5) }),
    ];
    repo.put(arriving);
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'skips', skipped: 1 });
    const loads = repo.loadsOf(DEFAULT_TRACE_ID);

    valueOf(await correlator.onEventsPersisted(arriving), 'onEventsPersisted with the remainder');

    // Neither pre-batch tree survives to be served as the current interaction.
    expect(correlator.stats()).toEqual(statsWith({ misses: 2, rebuilds: 2, invalidations: 2 }));
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(loads);

    // The read that rebuilds is refused, and the refusal is not counted as a
    // build.
    const error = failureOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the session-wide read after the batch',
    );

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details?.['reason']).toBe('trace-rows-unreadable');
    expect(error.details?.['unreadable']).toBe(1);
    expect(error.details?.['rows']).toBe(chain.length + 1);
    expect(logs.at('warn').map((record) => record.fields['unreadable'])).toEqual([1]);
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(loads + 1);
    expect(correlator.stats()).toEqual(statsWith({ misses: 3, rebuilds: 2, invalidations: 2 }));

    // Once every row reads back again, the trace rebuilds whole.
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'rows' });
    expect(
      treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the read after recovery')
        .nodeCount,
    ).toBe(chain.length + 1);

    for (const event of chain) {
      expect(logs.text()).not.toContain(event.name);
      expect(errorText(error)).not.toContain(event.name);
    }
  });

  it('refuses a tree that does not hold every loaded row, and neither caches nor counts it', async () => {
    const chain = canonicalChain();
    const hollowTrace = newTraceId();
    const stray = makeEvent({
      traceId: newTraceId(),
      kind: 'interaction',
      name: `stray ${SENTINEL}`,
      startTime: at(3.5),
    });
    const repo = fakeTelemetryRepo(chain);
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'strays', strays: [stray] });
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    // The store answered with one row of another trace. The correlator
    // considers only the rows carrying the requested id, so the tree holds one
    // node fewer than the rows loaded, and that tree is not the interaction.
    const error = failureOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace over a page carrying a row of another trace',
    );

    expect(error.code).toBe('INTERNAL');
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.hint).toBeDefined();
    expect(error.details?.['reason']).toBe('trace-nodes-dropped');
    expect(error.details?.['traceId']).toBe(DEFAULT_TRACE_ID);
    expect(error.details?.['nodeCount']).toBe(chain.length);
    expect(error.details?.['rows']).toBe(chain.length + 1);
    expect(correlator.stats()).toEqual(statsWith({ misses: 1 }));

    const warned = logs.at('warn');
    expect(warned.map((record) => record.fields['nodeCount'])).toEqual([chain.length]);
    expect(warned.map((record) => record.fields['rows'])).toEqual([chain.length + 1]);

    // A batch for the trace reads nothing, and the read after it refuses the
    // same tree again rather than serving one that is missing a row.
    const loadsBeforeBatch = repo.loadsOf(DEFAULT_TRACE_ID);
    valueOf(
      await correlator.onEventsPersisted([eventAt(chain, 0)]),
      'onEventsPersisted for the trace',
    );
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(loadsBeforeBatch);
    const again = failureOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read after a batch for the trace',
    );
    expect(again.details?.['reason']).toBe('trace-nodes-dropped');
    expect(correlator.stats()).toEqual(statsWith({ misses: 2 }));

    // Rows loaded with none of them this trace's is a shortfall of every row,
    // not an absent trace: an absence would let `getTraces` leave the trace out
    // of a successful answer.
    repo.behaveFor(hollowTrace, { kind: 'strays', strays: [stray] });
    const hollow = failureOf(
      await correlator.getTrace(SESSION_A, hollowTrace),
      'getTrace over a page holding only a row of another trace',
    );
    expect(hollow.code).toBe('INTERNAL');
    expect(hollow.details?.['reason']).toBe('trace-nodes-dropped');
    expect(hollow.details?.['nodeCount']).toBe(0);
    expect(hollow.details?.['rows']).toBe(1);
    expect(correlator.stats()).toEqual(statsWith({ misses: 3 }));

    // Nothing was cached, so a read after the store answers correctly again
    // reloads and builds the whole trace — the first build counted.
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'rows' });
    const loads = repo.loadsOf(DEFAULT_TRACE_ID);
    const whole = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read after the store recovers',
    );
    expect(whole.nodeCount).toBe(chain.length);
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(loads + 1);
    expect(correlator.stats()).toEqual(
      statsWith({ cachedTraces: 1, cachedNodes: chain.length, misses: 4, rebuilds: 1 }),
    );

    for (const segment of SENTINEL_SEGMENTS) {
      expect(logs.text()).not.toContain(segment);
      expect(errorText(error)).not.toContain(segment);
      expect(errorText(again)).not.toContain(segment);
      expect(errorText(hollow)).not.toContain(segment);
    }
  });

  it('logs counts and identifiers only, never a captured name or attribute value', async () => {
    const chain = canonicalChain();
    const planted = makeEvent({
      parentSpanId: eventAt(chain, 4).spanId,
      kind: 'db.query',
      name: `SELECT ${SENTINEL}`,
      startTime: at(19.5),
      duration: 640.25,
      producerId: PRODUCER_SERVER,
      attributes: {
        'db.statement': `SELECT * FROM records WHERE token = '${SENTINEL}'`,
        note: SENTINEL,
      },
    });

    const repo = fakeTelemetryRepo([...chain, planted]);
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    valueOf(
      await correlator.onEventsPersisted([planted]),
      'onEventsPersisted with a planted token',
    );
    const tree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace with a planted token',
    );
    valueOf(await correlator.getTraces(SESSION_A), 'getTraces with a planted token');
    correlator.invalidate(SESSION_A);
    correlator.close();

    // The value is carried to the caller intact - it is evidence - and appears
    // in nothing this module says about it.
    expect(nodeFor(tree, planted.spanId).event.attributes['note']).toBe(SENTINEL);
    expect(logs.records.length).toBeGreaterThan(0);
    for (const segment of SENTINEL_SEGMENTS) {
      expect(logs.text()).not.toContain(segment);
    }
    expect(logs.text()).not.toContain('SELECT');
    expect(logs.text()).not.toContain('POST');
  });
});
