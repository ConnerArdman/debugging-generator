/**
 * `queries` — the database-query aggregate a capture is answered with.
 *
 * This module turns the flat event list a capture recorded into the
 * `queries → QueryGroup[]` data result of AAP 0.4.2: one group per distinct
 * statement, each carrying how often it ran, how long it took, which traces it
 * ran in, which application function called it and where in the developer's
 * project that call site is. `QueryTable` in `@debuggen/panel-renderer` renders
 * it, `apps/local-service/src/panels/data.ts` serves it, and the analysis stage
 * cites it when a slow multi-tier interaction turns out to be database-bound.
 *
 * ## Grouping
 *
 * Statements group by the **exact string** `normalizeSqlStatement`
 * (`../redaction/sql.ts`) returns, and this module normalises nothing itself.
 * That function already unifies `$n` placeholders, collapses whitespace, strips
 * a trailing terminator and folds a masked value list, and it deliberately does
 * **not** fold case, because a quoted identifier's case is part of a column's
 * name. Re-implementing or extending any of that here would split one group in
 * two the moment the two copies drifted — which is why the key lives in one
 * place and its behaviour is pinned by `../redaction/sql.test.ts` rather than
 * restated by a test of this module.
 *
 * So `select col_a from t1 where id = $1` and `SELECT col_a FROM t1 WHERE id =
 * $2` are one group (placeholders unify, case is identical), while
 * `select col_a from t1` and `SELECT col_a FROM t1` are two.
 *
 * ## Privacy (AAP 0.5.2)
 *
 * Nothing in the shapes below can hold captured data, and that is structural
 * rather than a matter of care at the call site:
 *
 * - The only statement text carried is the already-redacted `db.statement` the
 *   producer sent — parameterized, with every surviving literal masked — plus
 *   its normalised form. Neither is re-processed here.
 * - **Row contents are never captured, and no field could hold one.** The only
 *   thing recorded about a result is `db.rowCount`: a count, per occurrence and
 *   summed per group.
 * - No bound parameter, no column value and no result set appears anywhere. A
 *   reviewer confirms that by reading the three exported interfaces: every
 *   member is a number, an identifier, a span name, a redacted statement or a
 *   source location.
 *
 * ## Evidence, not inference
 *
 * This module counts and totals; it concludes nothing. It does not decide that
 * a group is an N+1, a fan-out or a missing index, and it carries no field in
 * which such a verdict could travel. `executionCount` is the evidence; the
 * hypothesis belongs to the analysis stage, which keeps observed facts and
 * inferred causes structurally apart (AAP 0.4.2, 0.8.4).
 *
 * ## Purity and environment
 *
 * Pure and environment-neutral: no platform builtin, no DOM global, no clock,
 * no I/O, and no mutation of the input array or of any event in it. The same
 * function runs inside the local service, inside a unit test and — because this
 * package's library entry is built for esbuild's neutral platform — inside a
 * page bundle, so every dependency here is either a type or a pure function.
 * It never throws: a malformed event yields a duller group, never an exception
 * in the service's panel-data path (AAP 0.5.5).
 */

import { clampNonNegative, roundMs } from '@debuggen/shared';
import type { EventId, SourceLocation, SpanId, TraceId } from '@debuggen/shared';

import { normalizeSqlStatement } from '../redaction/sql.js';
// Type-only: the attribute catalogue is consulted by the *compiler* to check the
// three keys bound below against the declared `db.query` key set, and there is
// nothing to consult at runtime. A value import would pull the catalogue into
// this neutral library entry's bundle to no purpose.
import type { DB_QUERY_ATTRIBUTE_KEYS } from '../schema/attributes.js';
import type { TelemetryEvent } from '../schema/event.js';
import { QUERY_KINDS } from '../schema/kinds.js';
import type { TelemetryKind } from '../schema/kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Vocabulary bindings
 *
 * Every kind and every attribute key this module reads comes from the upstream
 * vocabularies, never from a literal this file invented. The two mechanisms
 * below are both compile-time checks, and each is chosen over the obvious
 * alternative for a reason worth recording.
 * ---------------------------------------------------------------------------
 */

/** One member of the declared `db.query` attribute key set. */
type DbQueryAttributeKey = (typeof DB_QUERY_ATTRIBUTE_KEYS)[number];

/*
 * The three keys this module reads, each annotated with the member type above
 * so the compiler rejects a key the catalogue does not declare. Annotation
 * rather than positional indexing (`DB_QUERY_ATTRIBUTE_KEYS[1]`): an index
 * still compiles after the tuple is reordered and would silently start reading
 * a different attribute, whereas a renamed or removed key fails here.
 */

/** Which database engine produced the span, when the producer said. */
const DB_SYSTEM_KEY: DbQueryAttributeKey = 'db.system';

/** The parameterized, already-redacted statement text. */
const DB_STATEMENT_KEY: DbQueryAttributeKey = 'db.statement';

/** How many rows the result held — the only thing recorded about a result. */
const DB_ROW_COUNT_KEY: DbQueryAttributeKey = 'db.rowCount';

/**
 * The kinds this aggregate is computed from: the database kind group of
 * `../schema/kinds.ts`, whose documentation names this module as its consumer.
 *
 * A set rather than the array's `includes`, because the membership test runs
 * once per event of a capture.
 */
const QUERY_KIND_SET: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>(QUERY_KINDS);

/**
 * The ancestor kinds a query's caller is preferred to be: a named application
 * function timed by a reversible patch, and a route handler.
 *
 * There is no exported group for this pair in `../schema/kinds.ts` — the groups
 * there serve the metrics and the visualizations — so the pair is declared here
 * with the upstream member type as the `Set`'s type argument, which is what
 * makes the compiler check both literals against the closed kind vocabulary.
 * A kind renamed upstream fails this line rather than silently matching
 * nothing.
 */
const CALLER_KIND_SET: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>([
  'function',
  'route.handler',
]);

/*
 * ---------------------------------------------------------------------------
 * Exported labels and bounds
 * ---------------------------------------------------------------------------
 */

/**
 * The group key and representative statement used when a span's `db.statement`
 * cannot be read as text, or normalises to nothing.
 *
 * Such a span is **grouped and surfaced, never dropped**: its duration is part
 * of the capture's database cost whether or not the producer labelled it, and
 * an aggregate that silently discarded it would understate exactly the thing a
 * developer is asking about.
 *
 * One consequence is worth knowing: a statement whose normalised text happens
 * to be this exact label lands in the same group. That keeps one group per
 * `normalizedStatement` — and therefore one {@link QueryGroup.id} and a total
 * ordering — at the cost of a merge no real statement provokes.
 */
export const UNKNOWN_STATEMENT_KEY = '(unknown statement)';

/**
 * The label a consumer displays for a group whose {@link QueryGroup.system} is
 * absent because no occurrence reported a readable `db.system`.
 *
 * Exported rather than substituted into the field: an absent `system` says
 * "never observed", which a consumer can tell apart from an engine that
 * happens to be named something. The distinction matters to the panel — a
 * blank column and an unlabelled one read differently — and it is the reason
 * the label lives with the contract instead of inside each renderer.
 */
export const UNKNOWN_DB_SYSTEM_LABEL = '(unknown system)';

/**
 * How many ancestors the caller walk inspects before it gives up.
 *
 * The walk exists because the span directly above a database span is often the
 * driver's own wrapper rather than application code, so the nearest *useful*
 * ancestor can be a few hops up. Eight is generous for a request → handler →
 * service → driver chain and small enough that a pathological trace costs
 * nothing; the walk also stops at a self-parent, at a cycle and at a parent
 * that never arrived, so the bound is a budget rather than the only guard.
 */
export const MAX_CALLER_LOOKUP_HOPS = 8;

/**
 * How many occurrences a group carries by default.
 *
 * Bounded because a group's occurrence list can ride inside `CaptureSummary`
 * over a WebSocket, and a loop that ran ten thousand statements must not turn
 * one panel message into ten thousand rows. The counts and totals stay exact
 * when the list is cut — {@link QueryGroup.occurrencesTruncated} says it was.
 */
export const DEFAULT_MAX_OCCURRENCES_PER_GROUP = 200;

/** How many distinct callers a group carries by default, for the same reason. */
export const DEFAULT_MAX_CALLERS_PER_GROUP = 20;

/**
 * How many distinct trace ids a group carries.
 *
 * Fixed rather than an option: the field exists so a reader can pivot from a
 * statement to the interactions that ran it, and a few dozen is already more
 * than a panel can offer. {@link QueryGroup.executionCount} remains exact.
 */
export const MAX_QUERY_TRACE_IDS_PER_GROUP = 50;

/*
 * ---------------------------------------------------------------------------
 * Exported shapes
 * ---------------------------------------------------------------------------
 */

/**
 * One execution of a grouped statement.
 *
 * Carries what a timeline row and a details drawer need, and nothing a result
 * set could hide in: the identifiers that tie the row back to the stored event
 * and its trace, the timing, the row count when one was reported, the outcome,
 * and the code location a click resolves to.
 */
export interface QueryOccurrence {
  /**
   * Stable identity of this row, equal to {@link QueryOccurrence.eventId}.
   *
   * Present under both names on purpose: `id` is what a list renderer keys on
   * and what the canonical order breaks ties with, while `eventId` is what a
   * generated panel's fact cites as evidence. One value, two contracts, so
   * neither consumer has to know about the other's.
   */
  readonly id: EventId;

  /** The stored telemetry event this occurrence was computed from. */
  readonly eventId: EventId;

  /** The database span's own id, for correlation against the trace tree. */
  readonly spanId: SpanId;

  /** The trace this execution belongs to: one interaction, across all tiers. */
  readonly traceId: TraceId;

  /** The span that caused it, when the event named one. Absent at a trace root. */
  readonly parentSpanId?: SpanId;

  /** When it started: Unix epoch milliseconds, the product's one time base. */
  readonly startTime: number;

  /** How long it took, in milliseconds. */
  readonly durationMs: number;

  /**
   * When it ended: `startTime + durationMs`, precomputed.
   *
   * Carried rather than left to each consumer so a waterfall, a timeline and a
   * table cannot disagree about the right-hand edge of the same row through
   * their own rounding.
   */
  readonly endTime: number;

  /**
   * How many rows the result held, when the producer reported it.
   *
   * The only thing recorded about a result. Absent when no count was reported,
   * which is different from a count of zero and is kept different.
   */
  readonly rowCount?: number;

  /** Whether the statement succeeded, as the producer reported it. */
  readonly status: TelemetryEvent['status'];

  /** The span id of the resolved caller, when one was found. */
  readonly callerSpanId?: SpanId;

  /** The resolved caller's span name, when one was found. */
  readonly callerName?: string;

  /**
   * Where in the developer's project this execution came from.
   *
   * The database span's own location when a resolver could supply one — the
   * query call site, which is what the acceptance flow's click on a statement
   * row has to open — and otherwise the resolved caller's location, so the row
   * stays clickable. Absent when neither could be resolved.
   */
  readonly source?: SourceLocation;
}

/**
 * One code location that ran a grouped statement, with its share of the group.
 *
 * A caller is a *place in the code*, not a span: two executions from the same
 * line collapse into one row whose `executionCount` says how often it ran.
 * That is what makes the caller column answer "who runs this, and how often"
 * in a table a developer can read at a glance.
 */
export interface QueryCaller {
  /**
   * Stable identity, derived from the caller's name and location.
   *
   * Deterministic for a given caller across runs and processes, which is what
   * lets a renderer key a row on it and the order below break ties with it.
   */
  readonly id: string;

  /**
   * The span id of the first execution attributed to this caller.
   *
   * One of possibly many: the row identifies a location, so this is a way into
   * the trace rather than the identity of the row.
   */
  readonly spanId?: SpanId;

  /** The caller's span name, as a developer would recognise it. */
  readonly name: string;

  /** The caller span's kind, when it was resolved from one. */
  readonly kind?: TelemetryKind;

  /** How many of the group's executions came from here. */
  readonly executionCount: number;

  /** Their total duration in milliseconds. */
  readonly totalDurationMs: number;

  /**
   * Where the caller is, when a resolver could say.
   *
   * This is the field the query table's caller column opens in the editor
   * (AAP 0.6.2, "caller → `onOpenSource`"), so it is a functional requirement
   * rather than decoration.
   */
  readonly source?: SourceLocation;
}

/**
 * Every execution of one distinct statement in a capture.
 *
 * The unit of the `queries` data result: totals and counts that are exact
 * whatever the bounds cut, the traces the statement ran in, the callers that
 * ran it, and a bounded sample of the executions themselves.
 */
export interface QueryGroup {
  /**
   * Stable identity, derived deterministically from
   * {@link QueryGroup.normalizedStatement}.
   *
   * The same statement yields the same id in every process and every run,
   * which is what makes it usable as the service's stable secondary sort key
   * when it pages a `DataQuery` result (AAP 0.4.2). It is a derived key, not a
   * minted store identifier: nothing looks a group up by it.
   */
  readonly id: string;

  /**
   * The grouping key: exactly what `normalizeSqlStatement` returned, or
   * {@link UNKNOWN_STATEMENT_KEY}.
   *
   * The authoritative identity of the group. Two groups never share it.
   */
  readonly normalizedStatement: string;

  /**
   * A representative statement as stored: the first occurrence's redacted,
   * parameterized `db.statement`.
   *
   * Shown to the developer, because the placeholders and layout the producer
   * sent read better than the normalised key. Already redacted on arrival and
   * deliberately not re-processed here. {@link UNKNOWN_STATEMENT_KEY} when no
   * occurrence carried readable text.
   */
  readonly statement: string;

  /**
   * The database engine, from the first occurrence that reported one.
   *
   * Absent when none did; consumers display {@link UNKNOWN_DB_SYSTEM_LABEL}.
   */
  readonly system?: string;

  /** How many times the statement ran. Exact, whatever the bounds cut. */
  readonly executionCount: number;

  /** Total duration of those executions, in milliseconds. */
  readonly totalDurationMs: number;

  /** Mean duration, in milliseconds. */
  readonly averageDurationMs: number;

  /** Fastest execution, in milliseconds. */
  readonly minDurationMs: number;

  /** Slowest execution, in milliseconds. */
  readonly maxDurationMs: number;

  /** When the first execution started: Unix epoch milliseconds. */
  readonly firstStartTime: number;

  /** When the last execution started: Unix epoch milliseconds. */
  readonly lastStartTime: number;

  /**
   * Rows returned across every execution that reported a count.
   *
   * Absent unless at least one occurrence reported `db.rowCount`, so a group
   * from a producer that reports no counts says nothing rather than claiming
   * zero rows.
   */
  readonly totalRowCount?: number;

  /** How many executions reported a failure. */
  readonly errorCount: number;

  /**
   * The distinct traces this statement ran in, ascending, bounded by
   * {@link MAX_QUERY_TRACE_IDS_PER_GROUP}.
   */
  readonly traceIds: readonly TraceId[];

  /**
   * The code locations that ran it, busiest first.
   *
   * Their execution counts sum to at most {@link QueryGroup.executionCount}:
   * an execution whose caller could not be resolved is counted in the group
   * and attributed to nobody, which is more honest than inventing a row.
   */
  readonly callers: readonly QueryCaller[];

  /**
   * A bounded sample of the executions, in canonical order — `startTime`, then
   * {@link QueryOccurrence.id}.
   */
  readonly occurrences: readonly QueryOccurrence[];

  /** Whether the group ran more executions than `occurrences` carries. */
  readonly occurrencesTruncated: boolean;
}

/**
 * How large one group may grow on the wire.
 *
 * Both bounds are per group, and both keep every count and total exact — they
 * cut sample lists, never arithmetic. Omit either to accept its default; a
 * value that is not a non-negative integer is ignored in favour of the default
 * rather than rejected, because this function does not throw.
 */
export interface QueryAggregateOptions {
  /** Occurrences per group; defaults to {@link DEFAULT_MAX_OCCURRENCES_PER_GROUP}. */
  readonly maxOccurrencesPerGroup?: number;

  /** Callers per group; defaults to {@link DEFAULT_MAX_CALLERS_PER_GROUP}. */
  readonly maxCallersPerGroup?: number;
}

/*
 * ---------------------------------------------------------------------------
 * Derived identity
 *
 * Group and caller ids are computed from the thing they identify, so two
 * processes that aggregate the same capture agree without exchanging anything.
 * A minted identifier could not do that, and a cryptographic digest is not
 * available: this module is bundled for a neutral platform, where there is no
 * hashing builtin, and `@debuggen/shared`'s `stableHash` lives behind that
 * package's Node-only entry. The mixer below is therefore local, tiny and
 * non-cryptographic — it keys map entries and breaks sort ties, and nothing is
 * authenticated with it.
 * ---------------------------------------------------------------------------
 */

/**
 * Prefix of a {@link QueryGroup.id}.
 *
 * Two letters, so the result cannot be mistaken for one of
 * `@debuggen/shared`'s three-letter minted identifiers.
 */
const QUERY_GROUP_ID_PREFIX = 'qg_';

/** Prefix of a {@link QueryCaller.id}, for the same reason. */
const QUERY_CALLER_ID_PREFIX = 'qc_';

/**
 * Separator inside a caller's identity string.
 *
 * `NUL` cannot occur in either part: the source-location schema refuses a
 * `file` containing a control character, and a span name is a framework,
 * component or route label. So no pair of distinct (name, location) inputs can
 * produce the same identity string by moving the boundary between them.
 */
const CALLER_IDENTITY_SEPARATOR = '\u0000';

/** FNV-1a's 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a's 32-bit prime. */
const FNV_PRIME = 0x01000193;

/** djb2's offset basis. */
const DJB2_OFFSET_BASIS = 5381;

/** djb2's multiplier. */
const DJB2_MULTIPLIER = 33;

/** Renders an unsigned 32-bit lane as eight lowercase hex digits. */
function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * Mixes a string into 64 deterministic bits, rendered as sixteen hex digits.
 *
 * Two structurally different 32-bit mixers — FNV-1a and djb2 — are run over the
 * same byte stream and concatenated, because two lanes of the same mixer with
 * different constants stay correlated. Both consume each UTF-16 code unit as
 * its low and high byte, so the result depends on the whole string including
 * astral characters, and `Math.imul` keeps every product in 32-bit integer
 * arithmetic instead of drifting into a double.
 *
 * Deterministic across processes and runs, which is the only property asked of
 * it. A collision would give two groups one id; the ordering below stays total
 * anyway because it falls through to `normalizedStatement`, and
 * `normalizedStatement` — not the id — is a group's identity.
 */
function hash64Hex(text: string): string {
  let fnv = FNV_OFFSET_BASIS;
  let djb = DJB2_OFFSET_BASIS;

  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    const low = unit & 0xff;
    const high = unit >>> 8;

    fnv = Math.imul(fnv ^ low, FNV_PRIME) >>> 0;
    fnv = Math.imul(fnv ^ high, FNV_PRIME) >>> 0;
    djb = ((Math.imul(djb, DJB2_MULTIPLIER) >>> 0) ^ low) >>> 0;
    djb = ((Math.imul(djb, DJB2_MULTIPLIER) >>> 0) ^ high) >>> 0;
  }

  return toHex32(fnv) + toHex32(djb);
}

/** The identity of a caller row: its name and its location, or just its name. */
function callerIdentity(name: string, source: SourceLocation | undefined): string {
  if (source === undefined) {
    return name + CALLER_IDENTITY_SEPARATOR;
  }

  const location = [
    source.file,
    String(source.line),
    String(source.column),
    source.symbol ?? '',
  ].join(':');

  return name + CALLER_IDENTITY_SEPARATOR + location;
}

/*
 * ---------------------------------------------------------------------------
 * Internal accumulators
 *
 * Mutable while one call folds a capture, and never exposed: the published
 * shapes above are read-only, and `aggregateQueries` builds them at the end so
 * no consumer can hold a reference to something still being summed.
 * ---------------------------------------------------------------------------
 */

/** A caller row under construction. */
interface CallerAccumulator {
  readonly id: string;
  readonly spanId: SpanId;
  readonly name: string;
  readonly kind: TelemetryKind;
  readonly source: SourceLocation | undefined;
  executionCount: number;
  totalDuration: number;
}

/** A group under construction. */
interface GroupAccumulator {
  readonly normalizedStatement: string;
  readonly statement: string;
  system: string | undefined;
  executionCount: number;
  totalDuration: number;
  minDuration: number;
  maxDuration: number;
  firstStartTime: number;
  lastStartTime: number;
  rowCountTotal: number;
  rowCountObserved: boolean;
  errorCount: number;
  readonly traceIds: Set<TraceId>;
  readonly callers: Map<string, CallerAccumulator>;
  readonly occurrences: QueryOccurrence[];
}

/** The ancestor a database span is attributed to, once the walk has chosen it. */
interface ResolvedCaller {
  readonly spanId: SpanId;
  readonly name: string;
  readonly kind: TelemetryKind;
  readonly source: SourceLocation | undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Defensive readers
 *
 * A span attribute is untyped at runtime and an event may arrive from a store
 * row rather than from a validated ingest, so every read states what it will
 * accept and yields `undefined` for anything else. None of them throws, and
 * none of them repairs: an unreadable attribute is absent, not guessed at.
 * ---------------------------------------------------------------------------
 */

/** Stand-in bag for an event whose `attributes` is missing entirely. */
const EMPTY_ATTRIBUTES: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * The event's attribute bag, or an empty one.
 *
 * Guarded because indexing `undefined` is the one read here that would throw,
 * and one malformed event must never end the service's panel-data call.
 */
function readAttributeBag(event: TelemetryEvent): Readonly<Record<string, unknown>> {
  const { attributes } = event;
  return typeof attributes === 'object' && attributes !== null ? attributes : EMPTY_ATTRIBUTES;
}

/** A non-empty string attribute, or `undefined`. */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A row count, or `undefined`.
 *
 * Accepts only a non-negative integer. `Number.isInteger` already refuses
 * `NaN` and both infinities, and a fractional count is not a count — recording
 * it would put "2.5 rows" in a panel, so it is treated as unreported instead.
 */
function readRowCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A finite measurement, or zero.
 *
 * The event schema already refuses a non-finite `startTime` or `duration`, so
 * this only matters for an event that reached this function another way. Zero
 * rather than propagation: one `NaN` added to a total makes every number in
 * the group `NaN`, and a silently empty panel is worse than one row of an
 * unlabelled zero.
 */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * A per-group bound, or its default when the caller supplied nothing usable.
 *
 * Ignoring a nonsensical bound rather than rejecting it is deliberate: this
 * function does not throw, and a panel that renders with default bounds is a
 * better answer to a caller's mistake than no panel at all. Zero is a usable
 * bound, not a mistake — a caller that wants counts without sample rows asks
 * for it.
 */
function resolveBound(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** The grouping key for a span's statement. Normalisation is not done here. */
function statementKeyFor(rawStatement: string | undefined): string {
  if (rawStatement === undefined) {
    return UNKNOWN_STATEMENT_KEY;
  }

  const normalized = normalizeSqlStatement(rawStatement);
  return normalized.length > 0 ? normalized : UNKNOWN_STATEMENT_KEY;
}

/*
 * ---------------------------------------------------------------------------
 * Caller resolution
 * ---------------------------------------------------------------------------
 */

/**
 * Indexes every event by its span id, so the caller walk is a lookup rather
 * than a scan.
 *
 * Built from the whole input, not from the database spans: the ancestors being
 * looked up are of other kinds. Events may arrive in any order, and no trace
 * tree is required — the service may pass an already-filtered slice, in which
 * case a walk simply ends where the slice does.
 *
 * On a duplicate span id the first event wins, which keeps the result a
 * function of the input order the store already fixes.
 */
function indexSpans(events: readonly TelemetryEvent[]): ReadonlyMap<SpanId, TelemetryEvent> {
  const index = new Map<SpanId, TelemetryEvent>();

  for (const event of events) {
    if (!index.has(event.spanId)) {
      index.set(event.spanId, event);
    }
  }

  return index;
}

/**
 * Chooses the ancestor a database span is attributed to.
 *
 * Walks up from `parentSpanId` at most {@link MAX_CALLER_LOOKUP_HOPS} hops and
 * returns the first ancestor that is a patched application function or a route
 * handler, because those are the spans that name code a developer wrote. When
 * none of them appears within the budget the nearest reachable ancestor is
 * returned instead: a driver wrapper is still a better answer than none, and
 * it is the span a reader sees directly above the query in the timeline.
 *
 * Three malformations end the walk instead of trapping it — a span that is its
 * own parent, a cycle among ancestors, and a parent that never arrived (the
 * orphan case the correlator flags rather than drops). The visited set is what
 * makes the first two terminate regardless of the hop budget.
 */
function resolveCaller(
  event: TelemetryEvent,
  spansBySpanId: ReadonlyMap<SpanId, TelemetryEvent>,
): ResolvedCaller | undefined {
  const visited = new Set<SpanId>([event.spanId]);
  let nearest: TelemetryEvent | undefined;
  let nextSpanId = event.parentSpanId;

  for (let hop = 0; hop < MAX_CALLER_LOOKUP_HOPS; hop += 1) {
    if (nextSpanId === undefined || visited.has(nextSpanId)) {
      break;
    }
    visited.add(nextSpanId);

    const parent = spansBySpanId.get(nextSpanId);
    if (parent === undefined) {
      break;
    }

    nearest ??= parent;
    if (CALLER_KIND_SET.has(parent.kind)) {
      return toResolvedCaller(parent);
    }

    nextSpanId = parent.parentSpanId;
  }

  return nearest === undefined ? undefined : toResolvedCaller(nearest);
}

/** Narrows a chosen ancestor to the four fields a caller row is built from. */
function toResolvedCaller(span: TelemetryEvent): ResolvedCaller {
  return {
    spanId: span.spanId,
    name: span.name,
    kind: span.kind,
    source: span.source,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Ordering
 *
 * Every comparator is total and locale-independent: string order is by UTF-16
 * code unit, never `localeCompare`, so the same capture orders identically on
 * every host regardless of its ICU data. That is what lets the service page a
 * result without re-reading the pages it has already served.
 * ---------------------------------------------------------------------------
 */

/** Ascending code-unit order. */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Canonical occurrence order: `startTime`, then id. */
function compareOccurrences(left: QueryOccurrence, right: QueryOccurrence): number {
  if (left.startTime !== right.startTime) {
    return left.startTime - right.startTime;
  }
  return compareStrings(left.id, right.id);
}

/** Busiest caller first, then name, then id. */
function compareCallers(left: QueryCaller, right: QueryCaller): number {
  if (left.executionCount !== right.executionCount) {
    return right.executionCount - left.executionCount;
  }

  const byName = compareStrings(left.name, right.name);
  return byName === 0 ? compareStrings(left.id, right.id) : byName;
}

/**
 * The base order of the result: costliest group first, then most executions,
 * then id, then normalised statement.
 *
 * The service re-sorts this array per `DataQuery.sort` — `duration_desc`,
 * `count_desc` or `start_asc` — and pages it. That is exactly why the base
 * order has to be total and reproducible: a sort with ties left unresolved
 * would let two pages of one result repeat or skip a group. The final fall
 * through to `normalizedStatement` keeps the order total even in the
 * astronomically unlikely event that two groups' derived ids collide.
 */
function compareGroups(left: QueryGroup, right: QueryGroup): number {
  if (left.totalDurationMs !== right.totalDurationMs) {
    return right.totalDurationMs - left.totalDurationMs;
  }
  if (left.executionCount !== right.executionCount) {
    return right.executionCount - left.executionCount;
  }

  const byId = compareStrings(left.id, right.id);
  return byId === 0 ? compareStrings(left.normalizedStatement, right.normalizedStatement) : byId;
}

/*
 * ---------------------------------------------------------------------------
 * Folding and publishing
 * ---------------------------------------------------------------------------
 */

/** A fresh accumulator for a statement seen for the first time. */
function createGroup(
  normalizedStatement: string,
  rawStatement: string | undefined,
): GroupAccumulator {
  return {
    normalizedStatement,
    // The representative statement is the first occurrence's text exactly as
    // the producer sent it — already redacted and parameterized. A group keyed
    // on the unknown label has no readable text to represent it.
    statement:
      normalizedStatement === UNKNOWN_STATEMENT_KEY
        ? UNKNOWN_STATEMENT_KEY
        : (rawStatement ?? UNKNOWN_STATEMENT_KEY),
    system: undefined,
    executionCount: 0,
    totalDuration: 0,
    minDuration: Number.POSITIVE_INFINITY,
    maxDuration: 0,
    firstStartTime: Number.POSITIVE_INFINITY,
    lastStartTime: Number.NEGATIVE_INFINITY,
    rowCountTotal: 0,
    rowCountObserved: false,
    errorCount: 0,
    traceIds: new Set<TraceId>(),
    callers: new Map<string, CallerAccumulator>(),
    occurrences: [],
  };
}

/** Adds one execution to a caller row, creating the row on first sight. */
function recordCaller(
  callers: Map<string, CallerAccumulator>,
  caller: ResolvedCaller,
  source: SourceLocation | undefined,
  durationMs: number,
): void {
  const identity = callerIdentity(caller.name, source);
  const existing = callers.get(identity);

  if (existing === undefined) {
    callers.set(identity, {
      id: QUERY_CALLER_ID_PREFIX + hash64Hex(identity),
      spanId: caller.spanId,
      name: caller.name,
      kind: caller.kind,
      source,
      executionCount: 1,
      totalDuration: durationMs,
    });
    return;
  }

  existing.executionCount += 1;
  existing.totalDuration += durationMs;
}

/** Builds one published occurrence. */
function buildOccurrence(
  event: TelemetryEvent,
  startTime: number,
  durationMs: number,
  rowCount: number | undefined,
  caller: ResolvedCaller | undefined,
): QueryOccurrence {
  // The query span's own location is the statement's call site, which is what a
  // click on this row must open; the caller's location is the fallback that
  // keeps the row clickable when no resolver could place the span itself.
  const source = event.source ?? caller?.source;

  return {
    id: event.id,
    eventId: event.id,
    spanId: event.spanId,
    traceId: event.traceId,
    ...(event.parentSpanId === undefined ? {} : { parentSpanId: event.parentSpanId }),
    startTime,
    durationMs,
    endTime: roundMs(startTime + durationMs),
    ...(rowCount === undefined ? {} : { rowCount }),
    status: event.status,
    ...(caller === undefined ? {} : { callerSpanId: caller.spanId, callerName: caller.name }),
    ...(source === undefined ? {} : { source }),
  };
}

/** Publishes one caller row. */
function publishCaller(accumulated: CallerAccumulator): QueryCaller {
  return {
    id: accumulated.id,
    spanId: accumulated.spanId,
    name: accumulated.name,
    kind: accumulated.kind,
    executionCount: accumulated.executionCount,
    totalDurationMs: roundMs(accumulated.totalDuration),
    ...(accumulated.source === undefined ? {} : { source: accumulated.source }),
  };
}

/** Publishes one group, applying both bounds. */
function publishGroup(
  accumulated: GroupAccumulator,
  maxOccurrences: number,
  maxCallers: number,
): QueryGroup {
  const ordered = [...accumulated.occurrences].sort(compareOccurrences);
  const occurrences = ordered.slice(0, maxOccurrences);

  const callers = [...accumulated.callers.values()]
    .map(publishCaller)
    .sort(compareCallers)
    .slice(0, maxCallers);

  const traceIds = [...accumulated.traceIds]
    .sort(compareStrings)
    .slice(0, MAX_QUERY_TRACE_IDS_PER_GROUP);

  // A group exists only because an execution created it, so the divisor is at
  // least one; the guards below keep the published numbers finite even if that
  // ever stopped being true.
  const executionCount = accumulated.executionCount;
  const totalDuration = accumulated.totalDuration;

  return {
    id: QUERY_GROUP_ID_PREFIX + hash64Hex(accumulated.normalizedStatement),
    normalizedStatement: accumulated.normalizedStatement,
    statement: accumulated.statement,
    ...(accumulated.system === undefined ? {} : { system: accumulated.system }),
    executionCount,
    totalDurationMs: roundMs(totalDuration),
    averageDurationMs: executionCount > 0 ? roundMs(totalDuration / executionCount) : 0,
    minDurationMs: Number.isFinite(accumulated.minDuration) ? roundMs(accumulated.minDuration) : 0,
    maxDurationMs: roundMs(accumulated.maxDuration),
    firstStartTime: Number.isFinite(accumulated.firstStartTime) ? accumulated.firstStartTime : 0,
    lastStartTime: Number.isFinite(accumulated.lastStartTime) ? accumulated.lastStartTime : 0,
    ...(accumulated.rowCountObserved ? { totalRowCount: accumulated.rowCountTotal } : {}),
    errorCount: accumulated.errorCount,
    traceIds,
    callers,
    occurrences,
    occurrencesTruncated: ordered.length > occurrences.length,
  };
}

/*
 * ---------------------------------------------------------------------------
 * The aggregate
 * ---------------------------------------------------------------------------
 */

/**
 * Groups a capture's database spans by normalised statement.
 *
 * Folds the events in one pass over the input (after one pass to index spans
 * for the caller walk), so the cost is linear in the capture and independent
 * of how the events are ordered. Nothing is inferred: the result says how
 * often each statement ran, how long it took and who ran it, and leaves every
 * conclusion to the analysis stage.
 *
 * Bounds apply per group and cut sample lists only —
 * {@link QueryGroup.executionCount}, the durations, the error count and the row
 * total stay exact — and {@link QueryGroup.occurrencesTruncated} reports the
 * one cut a reader could otherwise mistake for the whole story.
 *
 * @param events Any slice of a capture's events, in any order. Non-database
 * kinds are ignored for grouping and still indexed, because they are the
 * ancestors the caller walk resolves against.
 * @param options Per-group bounds; see {@link QueryAggregateOptions}.
 * @returns A new array in the base order documented on {@link compareGroups}.
 * Empty when the slice holds no database span. Never throws, and never mutates
 * the input.
 *
 * @example
 * ```ts
 * const groups = aggregateQueries(events);
 * const worst = groups[0];
 * if (worst !== undefined) {
 *   // `12 × select col_a from t1 where id = ? (840.25 ms)`
 *   report(worst.executionCount, worst.normalizedStatement, worst.totalDurationMs);
 * }
 * ```
 */
export function aggregateQueries(
  events: readonly TelemetryEvent[],
  options: QueryAggregateOptions = {},
): QueryGroup[] {
  const maxOccurrences = resolveBound(
    options.maxOccurrencesPerGroup,
    DEFAULT_MAX_OCCURRENCES_PER_GROUP,
  );
  const maxCallers = resolveBound(options.maxCallersPerGroup, DEFAULT_MAX_CALLERS_PER_GROUP);

  const spansBySpanId = indexSpans(events);
  const groups = new Map<string, GroupAccumulator>();

  for (const event of events) {
    if (!QUERY_KIND_SET.has(event.kind)) {
      continue;
    }

    const attributes = readAttributeBag(event);
    const rawStatement = readNonEmptyString(attributes[DB_STATEMENT_KEY]);
    const normalizedStatement = statementKeyFor(rawStatement);

    let group = groups.get(normalizedStatement);
    if (group === undefined) {
      group = createGroup(normalizedStatement, rawStatement);
      groups.set(normalizedStatement, group);
    }

    const startTime = roundMs(finiteOrZero(event.startTime));
    const durationMs = roundMs(clampNonNegative(finiteOrZero(event.duration)));
    const rowCount = readRowCount(attributes[DB_ROW_COUNT_KEY]);
    const caller = resolveCaller(event, spansBySpanId);

    group.executionCount += 1;
    group.totalDuration += durationMs;
    group.minDuration = Math.min(group.minDuration, durationMs);
    group.maxDuration = Math.max(group.maxDuration, durationMs);
    group.firstStartTime = Math.min(group.firstStartTime, startTime);
    group.lastStartTime = Math.max(group.lastStartTime, startTime);
    group.system ??= readNonEmptyString(attributes[DB_SYSTEM_KEY]);
    group.traceIds.add(event.traceId);

    if (event.status === 'error') {
      group.errorCount += 1;
    }

    if (rowCount !== undefined) {
      group.rowCountTotal += rowCount;
      group.rowCountObserved = true;
    }

    if (caller !== undefined) {
      // The caller row prefers the ancestor's own location and falls back to
      // the query span's, so the caller column links somewhere whenever either
      // tier could be resolved.
      recordCaller(group.callers, caller, caller.source ?? event.source, durationMs);
    }

    group.occurrences.push(buildOccurrence(event, startTime, durationMs, rowCount, caller));
  }

  return [...groups.values()]
    .map((accumulated) => publishGroup(accumulated, maxOccurrences, maxCallers))
    .sort(compareGroups);
}
