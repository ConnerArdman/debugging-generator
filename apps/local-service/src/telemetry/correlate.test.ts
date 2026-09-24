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
 *    are split across calls. For every `(sessionId, traceId)` pair a batch
 *    mentions this module loads that trace's **complete** persisted row set and
 *    correlates it from scratch. The first test of the rebuild block is the one
 *    that proves it, and it is marked as such.
 * 2. **Pass-through fidelity.** Orphans keep their flags, lineage attributes
 *    keep their values, `startTime` doubles keep their decimals and the
 *    cross-tier ancestry resolves end to end. This module must add nothing and
 *    remove nothing.
 * 3. **The cache tells the truth.** A rebuilt trace replaces the cached one, a
 *    purged trace stops being served, the bound is respected, and invalidation
 *    is scoped to the session (and optionally the trace) it names. A read that
 *    names a capture is built from that capture's events alone and cached
 *    under that capture, so a trace id recurring in another capture never
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
 * sub-millisecond offsets from one fixed epoch base, the only permutation
 * source is a seeded linear-congruential shuffle, and no wall clock,
 * `Math.random` or real timer is read anywhere in this file. Span names are
 * invented and generic (`'handleAction'`, `'POST /api/one'`, `'SELECT rows'`):
 * nothing built here names a symbol or a route of any real project, which is
 * the same rule the product source lives under (AAP §0.5.4).
 *
 * Expectations are derived from the imported vocabularies (`ORPHAN_REASONS`,
 * `LINEAGE_ATTRIBUTE_KEYS`, `LINEAGE_VALUES`, `DEBUGGEN_ERROR_CODES`,
 * `TRACE_CACHE_LIMIT`) rather than restated as literals, so a vocabulary change
 * surfaces here as a failure instead of as a stale copy that still passes.
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
  LINEAGE_ATTRIBUTE_KEYS,
  LINEAGE_VALUES,
  ORPHAN_REASONS,
  allowedTiersFor,
  ancestorsOfSpanId,
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
import { TRACE_CACHE_LIMIT, createTraceCorrelator } from './correlate.js';
import type { CorrelateUpdate, TelemetryRepoLike, TraceCorrelator } from './correlate.js';

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

/**
 * A correlator over `repo`, with a recording logger and the module's own
 * defaults for depth and cache size.
 */
function correlatorOver(
  repo: TelemetryRepoLike,
  logger: Logger,
  overrides: { readonly cacheLimit?: number } = {},
): TraceCorrelator {
  return createTraceCorrelator({
    telemetry: repo,
    logger,
    ...(overrides.cacheLimit !== undefined ? { cacheLimit: overrides.cacheLimit } : {}),
  });
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
 * Rebuilding the traces a persisted batch touched
 * ---------------------------------------------------------------------------------------------- */

describe('rebuilding the traces a persisted batch touched', () => {
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
   * their events. Here the store holds all six rows and only the last two are
   * handed over; the resulting tree must still be the whole interaction.
   */
  it('loads a touched trace in full and never builds a tree from the batch alone', async () => {
    const chain = canonicalChain();
    const repo = fakeTelemetryRepo(chain);
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const update = valueOf(
      await correlator.onEventsPersisted(chain.slice(-2)),
      'onEventsPersisted with the tail of a trace',
    );

    expect(update.tracesTouched).toEqual([DEFAULT_TRACE_ID]);
    expect(update.rebuilt).toBe(1);
    expect(update.orphanCount).toBe(0);

    const tree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace after a tail batch',
    );

    expect(tree.nodeCount).toBe(chain.length);
    expect(spanIdsOfTree(tree)).toEqual(spanIdsOfEvents(chain));
    expect(tree.roots).toHaveLength(1);
    expect(tree.primaryRootSpanId).toBe(eventAt(chain, 0).spanId);
    // One load for the rebuild; the read after it came from the cache.
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(1);
  });

  it('loads each distinct session-and-trace pair exactly once per batch', async () => {
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

    const repo = fakeTelemetryRepo([...firstRows, ...secondRows, otherSessionRow]);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    // Interleaved on purpose: several events of one trace must not produce
    // several loads, and the reported order is first-seen order.
    const batch = [
      eventAt(firstRows, 3),
      eventAt(secondRows, 0),
      eventAt(firstRows, 0),
      otherSessionRow,
      eventAt(secondRows, 1),
      eventAt(firstRows, 5),
    ];

    const update = valueOf(await correlator.onEventsPersisted(batch), 'onEventsPersisted');

    expect(update.tracesTouched).toEqual([firstTrace, secondTrace, firstTrace]);
    expect(update.rebuilt).toBe(3);
    expect(repo.traceLoads).toHaveLength(3);
    expect(repo.traceLoads.map((load) => [load.sessionId, load.traceId])).toEqual([
      [SESSION_A, firstTrace],
      [SESSION_A, secondTrace],
      [SESSION_B, firstTrace],
    ]);
    expect(correlator.stats().cachedTraces).toBe(3);
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

    const firstPass = valueOf(
      await correlator.onEventsPersisted([child]),
      'onEventsPersisted with an orphaned child',
    );

    expect(firstPass.orphanCount).toBe(1);

    const orphanedTree = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace before the parent arrived',
    );
    const orphan = nodeFor(orphanedTree, child.spanId);

    expect(orphanedTree.nodeCount).toBe(1);
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

    expect(secondPass.rebuilt).toBe(1);
    expect(secondPass.orphanCount).toBe(0);

    const converged = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'getTrace after the parent arrived',
    );

    expect(converged.nodeCount).toBe(2);
    expect(converged.orphanCount).toBe(0);
    expect(spanIdsOfNodes(ancestorsOfSpanId(converged, child.spanId))).toEqual([parent.spanId]);
    expect(nodeFor(converged, child.spanId).orphaned).toBe(false);
  });

  it('reports the traces it touched, the trees it rebuilt and the parentage it repaired', async () => {
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
    expect(update.rebuilt).toBe(2);
    expect(update.orphanCount).toBe(3);
    expect(correlator.stats().cachedTraces).toBe(2);
    expect(correlator.stats().rebuilds).toBe(2);
  });

  it('treats an empty batch as a no-op that touches neither the store nor the cache', async () => {
    const repo = fakeTelemetryRepo(canonicalChain());
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const update = valueOf(
      await correlator.onEventsPersisted([]),
      'onEventsPersisted with nothing',
    );

    expect(update.tracesTouched).toEqual([]);
    expect(update.rebuilt).toBe(0);
    expect(update.orphanCount).toBe(0);
    expect(repo.traceLoads).toHaveLength(0);
    expect(correlator.stats()).toEqual({ cachedTraces: 0, hits: 0, misses: 0, rebuilds: 0 });
  });

  it('skips an event whose session or trace id is unusable rather than keying the cache on it', async () => {
    const chain = canonicalChain();
    const usable = eventAt(chain, 0);
    // Deliberately malformed: the persisted schema rejects an empty identifier,
    // so these two rows can only come from a store written by another build.
    // The guard exists so one such row cannot key a cache entry on an empty
    // string, and so a batch carrying one still reports rather than throws.
    const withoutTrace: TelemetryEvent = { ...eventAt(chain, 1), traceId: '' };
    const withoutSession: TelemetryEvent = { ...eventAt(chain, 2), sessionId: '' };

    const repo = fakeTelemetryRepo(chain);
    const logs = recordingLogger();
    const correlator = correlatorOver(repo, logs.logger);

    const update = valueOf(
      await correlator.onEventsPersisted([usable, withoutTrace, withoutSession]),
      'onEventsPersisted with two unusable rows',
    );

    expect(update.tracesTouched).toEqual([DEFAULT_TRACE_ID]);
    expect(update.rebuilt).toBe(1);
    expect(repo.traceLoads).toHaveLength(1);
    expect(correlator.stats().cachedTraces).toBe(1);

    const warned = logs.at('warn');
    expect(warned).toHaveLength(1);
    expect(warned.map((record) => record.fields['ignored'])).toEqual([2]);
    expect(warned.map((record) => record.fields['batchSize'])).toEqual([3]);
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
    expect(update.rebuilt).toBe(1);

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
    expect(correlator.stats()).toEqual({ cachedTraces: 1, hits: 0, misses: 1, rebuilds: 1 });

    const second = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the second read',
    );

    expect(correlator.stats()).toEqual({ cachedTraces: 1, hits: 1, misses: 1, rebuilds: 1 });
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(1);
    // The same tree, not an equal one: the panel's repeated reads of one
    // interaction cost nothing after the capture that produced it.
    expect(second).toBe(first);
  });

  it('serves the rebuilt tree after a batch rather than a stale one', async () => {
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

    const fresh = treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the read after the remainder landed',
    );

    expect(fresh).not.toBe(stale);
    expect(fresh.nodeCount).toBe(chain.length);
    expect(spanIdsOfTree(fresh)).toEqual(spanIdsOfEvents(chain));
    expect(correlator.stats().rebuilds).toBe(2);
  });

  it('drops a cached tree whose trace the store no longer holds', async () => {
    const purgedTrace = newTraceId();
    const row = makeEvent({ traceId: purgedTrace, kind: 'interaction', name: 'click control' });
    const repo = fakeTelemetryRepo([row]);
    const correlator = correlatorOver(repo, recordingLogger().logger);

    expect(
      treeOf(await correlator.getTrace(SESSION_A, purgedTrace), 'the read before the purge'),
    ).toHaveProperty('nodeCount', 1);
    expect(correlator.stats().cachedTraces).toBe(1);

    repo.purge(SESSION_A, purgedTrace);
    const update = valueOf(
      await correlator.onEventsPersisted([row]),
      'onEventsPersisted for a purged trace',
    );

    expect(update.tracesTouched).toEqual([purgedTrace]);
    expect(update.rebuilt).toBe(0);
    expect(correlator.stats().cachedTraces).toBe(0);
    expect(
      valueOf(await correlator.getTrace(SESSION_A, purgedTrace), 'the read after the purge'),
    ).toBeUndefined();
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
    expect(correlator.stats().misses).toBe(TRACE_CACHE_LIMIT + 1);

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
    expect(correlator.stats()).toEqual({ cachedTraces: 3, hits: 0, misses: 3, rebuilds: 3 });

    // A second capture-scoped read is a hit on its own entry.
    const again = treeOf(
      await correlator.getTrace(SESSION_A, shared, CAPTURE_A1),
      'the second read of the first capture',
    );

    expect(again).toBe(firstTrees[0]);
    expect(correlator.stats()).toEqual({ cachedTraces: 3, hits: 1, misses: 3, rebuilds: 3 });
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

  it('drops the capture-scoped tree of a capture a batch touched and keeps the other capture\u2019s', async () => {
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
    expect(update.rebuilt).toBe(1);
    // The rebuild on ingest is the session-wide tree.
    expect(repo.traceLoads.at(-1)?.captureId).toBeUndefined();

    // The session-wide tree was cached, the first capture's stale tree was
    // dropped, and the second capture's tree was left alone.
    expect(correlator.stats().cachedTraces).toBe(2);

    const loadsAfterBatch = repo.loadsOf(shared);
    const freshFirst = treeOf(
      await correlator.getTrace(SESSION_A, shared, CAPTURE_A1),
      'the first capture after the batch',
    );

    expect(freshFirst).not.toBe(staleFirst);
    expect(freshFirst.nodeCount).toBe(firstWindow.length + 1);
    expect(nodeFor(freshFirst, late.spanId).event.captureId).toBe(CAPTURE_A1);
    expect(repo.loadsOf(shared)).toBe(loadsAfterBatch + 1);

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
    // Both reads above were served from the cache.
    expect(repo.loadsOf(shared)).toBe(loadsAfterBatch + 1);
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

    expect(correlator.stats()).toEqual({ cachedTraces: 7, hits: 0, misses: 7, rebuilds: 7 });

    // One trace goes under all three of its scopes, and nothing else does.
    correlator.invalidate(SESSION_A, shared);
    expect(correlator.stats().cachedTraces).toBe(4);

    treeOf(await correlator.getTrace(SESSION_A, other), 'the untouched trace, session-wide');
    treeOf(await correlator.getTrace(SESSION_A, other, CAPTURE_A1), 'the untouched trace, scoped');
    treeOf(
      await correlator.getTrace(SESSION_B, shared, otherSessionCapture),
      'the same trace id in the other session',
    );
    expect(correlator.stats()).toEqual({ cachedTraces: 4, hits: 3, misses: 7, rebuilds: 7 });

    treeOf(
      await correlator.getTrace(SESSION_A, shared, CAPTURE_A2),
      'a scope of the invalidated trace',
    );
    expect(correlator.stats()).toEqual({ cachedTraces: 5, hits: 3, misses: 8, rebuilds: 8 });

    // The whole session goes under every scope; the other session stays.
    correlator.invalidate(SESSION_A);
    expect(correlator.stats().cachedTraces).toBe(2);

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
    expect(correlator.stats()).toEqual({ cachedTraces: 0, hits: 0, misses: 1, rebuilds: 1 });

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

    expect(correlator.stats()).toEqual({ cachedTraces: 0, hits: 0, misses: 2, rebuilds: 2 });
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(2);
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

  it('keeps the traces it rebuilt before a mid-batch failure and converges on a retry', async () => {
    const healthyTrace = newTraceId();
    const failingTrace = newTraceId();

    const healthyRows = canonicalChain({ traceId: healthyTrace });
    const failingRows = canonicalChain({ traceId: failingTrace });

    const repo = fakeTelemetryRepo([...healthyRows, ...failingRows]);
    repo.behaveFor(failingTrace, { kind: 'throws', thrown: new Error('transient store failure') });
    const correlator = correlatorOver(repo, recordingLogger().logger);

    const batch = [eventAt(healthyRows, 0), eventAt(failingRows, 0)];
    const failed = failureOf(await correlator.onEventsPersisted(batch), 'onEventsPersisted');
    expect(failed.code).toBe('STORE_ERROR');

    // The trace rebuilt before the failure keeps its fresh tree, so the partial
    // batch left no half-built state behind.
    expect(correlator.stats().cachedTraces).toBe(1);
    const healthyTree = treeOf(
      await correlator.getTrace(SESSION_A, healthyTrace),
      'the read of the trace rebuilt before the failure',
    );
    expect(healthyTree.nodeCount).toBe(healthyRows.length);
    expect(correlator.stats().hits).toBe(1);

    // A rebuild reloads the whole trace, so retrying the same batch converges.
    repo.behaveFor(failingTrace, { kind: 'rows' });
    const retried = valueOf(await correlator.onEventsPersisted(batch), 'the retried batch');

    expect(retried.tracesTouched).toEqual([healthyTrace, failingTrace]);
    expect(retried.rebuilt).toBe(2);
    expect(
      treeOf(await correlator.getTrace(SESSION_A, failingTrace), 'the read after the retry')
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
    expect(correlator.stats()).toEqual({ cachedTraces: 0, hits: 0, misses: 1, rebuilds: 0 });

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
    expect(correlator.stats()).toEqual({ cachedTraces: 0, hits: 0, misses: 1, rebuilds: 0 });

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

  it('drops the trees a failed rebuild leaves stale and keeps a capture the batch did not touch', async () => {
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
    treeOf(await correlator.getTrace(SESSION_A, laterTrace), 'the later trace before the batch');
    expect(correlator.stats().cachedTraces).toBe(4);

    // The rest of the first capture's trace lands with a span of the later
    // trace, and the store's paging then stalls for the first trace.
    const arriving = chain.slice(4);
    const laterArrival = makeEvent({
      traceId: laterTrace,
      parentSpanId: laterRow.spanId,
      startTime: at(2.5),
    });
    repo.put([...arriving, laterArrival]);
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'stalls' });

    const error = failureOf(
      await correlator.onEventsPersisted([...arriving, laterArrival]),
      'onEventsPersisted over a stalling store',
    );

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details?.['reason']).toBe('trace-page-stalled');
    // The batch failed fast: the later trace was never reloaded.
    expect(repo.loadsOf(laterTrace)).toBe(1);

    // No pre-batch tree the batch made stale survives to be served as current —
    // neither the failing trace's session-wide and first-capture trees nor the
    // later trace's. The second capture's tree, whose events the batch did not
    // change, is still cached and still served.
    expect(correlator.stats().cachedTraces).toBe(1);
    const hitsBefore = correlator.stats().hits;
    treeOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID, CAPTURE_A2),
      'the untouched capture after the failure',
    );
    expect(correlator.stats().hits).toBe(hitsBefore + 1);

    // Once the store pages again, every dropped tree rebuilds whole.
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'rows' });
    expect(
      treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'session-wide after recovery')
        .nodeCount,
    ).toBe(chain.length + 1);
    expect(
      treeOf(
        await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID, CAPTURE_A1),
        'the first capture after recovery',
      ).nodeCount,
    ).toBe(chain.length);
    expect(
      treeOf(await correlator.getTrace(SESSION_A, laterTrace), 'the later trace after recovery')
        .nodeCount,
    ).toBe(2);
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
    expect(correlator.stats()).toEqual({ cachedTraces: 0, hits: 0, misses: 1, rebuilds: 0 });

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

  it('drops the cached trees of a trace whose ingest reload reports unreadable rows', async () => {
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
    expect(correlator.stats()).toEqual({ cachedTraces: 2, hits: 0, misses: 2, rebuilds: 2 });

    // The rest of the chain lands, and the reload the batch triggers now finds
    // a stored row of the trace it cannot reconstruct.
    const arriving = chain.slice(4);
    repo.put(arriving);
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'skips', skipped: 1 });

    const error = failureOf(
      await correlator.onEventsPersisted(arriving),
      'onEventsPersisted over a reload reporting unreadable rows',
    );

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details?.['reason']).toBe('trace-rows-unreadable');
    expect(error.details?.['unreadable']).toBe(1);
    expect(error.details?.['rows']).toBe(chain.length);
    expect(logs.at('warn').map((record) => record.fields['unreadable'])).toEqual([1]);

    // Neither pre-batch tree survives to be served as the current interaction,
    // and the failed reload was not counted as a build.
    expect(correlator.stats()).toEqual({ cachedTraces: 0, hits: 0, misses: 2, rebuilds: 2 });
    const loads = repo.loadsOf(DEFAULT_TRACE_ID);
    failureOf(
      await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID),
      'the session-wide read after the failed batch',
    );
    expect(repo.loadsOf(DEFAULT_TRACE_ID)).toBe(loads + 1);
    expect(correlator.stats().hits).toBe(0);

    // Once every row reads back again, the trace rebuilds whole.
    repo.behaveFor(DEFAULT_TRACE_ID, { kind: 'rows' });
    expect(
      treeOf(await correlator.getTrace(SESSION_A, DEFAULT_TRACE_ID), 'the read after recovery')
        .nodeCount,
    ).toBe(chain.length);

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
    expect(correlator.stats()).toEqual({ cachedTraces: 0, hits: 0, misses: 1, rebuilds: 0 });

    const warned = logs.at('warn');
    expect(warned.map((record) => record.fields['nodeCount'])).toEqual([chain.length]);
    expect(warned.map((record) => record.fields['rows'])).toEqual([chain.length + 1]);

    // The ingest path refuses the same tree and caches nothing either.
    const ingest = failureOf(
      await correlator.onEventsPersisted([eventAt(chain, 0)]),
      'onEventsPersisted over a page carrying a row of another trace',
    );
    expect(ingest.details?.['reason']).toBe('trace-nodes-dropped');
    expect(correlator.stats()).toEqual({ cachedTraces: 0, hits: 0, misses: 1, rebuilds: 0 });

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
    expect(correlator.stats()).toEqual({ cachedTraces: 0, hits: 0, misses: 2, rebuilds: 0 });

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
    expect(correlator.stats()).toEqual({ cachedTraces: 1, hits: 0, misses: 3, rebuilds: 1 });

    for (const segment of SENTINEL_SEGMENTS) {
      expect(logs.text()).not.toContain(segment);
      expect(errorText(error)).not.toContain(segment);
      expect(errorText(ingest)).not.toContain(segment);
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
