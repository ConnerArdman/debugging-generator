/**
 * What `./queries.ts` counts as one statement execution, and what it refuses to
 * count as one.
 *
 * `./summary.test.ts` drives this module through the committed capture and
 * pins the numbers a whole capture comes to; this suite covers the decision
 * underneath those numbers, which is invisible in a total and wrong in a way a
 * developer would act on. A `db.query` event is a database *span*, and two
 * kinds of database span are not an execution:
 *
 * - **A lifecycle span**, which reports no `db.statement`: the ORM's
 *   `prisma:client:serialize`, `prisma:client:operation` and transaction spans
 *   and the driver's `pg.connect` / `pg-pool.connect`. A real capture holds
 *   more of these than of statements, and grouping them put every one in a
 *   single `(unknown statement)` bucket that then read as the busiest
 *   "statement" in the capture — the top row of `QueryTable` and a cited
 *   Observed fact (AAP 0.6.2, 0.8.4).
 * - **The inner of two observations of one execution**: with the ORM and the
 *   driver both armed, one statement is spanned by the ORM and again by the
 *   driver underneath it, with the same text. One execution, two spans, and
 *   `query_count` counted both.
 *
 * Neither exclusion may become a *loss*, and that is the other half of what is
 * asserted here: the arithmetic of the surviving groups, the caller attribution
 * that still resolves across a lifecycle span, and — decisively — the cases
 * where two spans must **not** collapse: two genuine executions of one
 * statement, a nested pair whose statements differ, and any ancestry too
 * malformed to read (a self-parent, a cycle, a parent that never arrived),
 * where the module counts twice rather than risk deleting the only observation
 * of a statement.
 *
 * Events are built by hand rather than loaded from a fixture: every case turns
 * on one attribute or one parent link, and a literal event is what makes the
 * case readable. Expected group keys are asked of `normalizeSqlStatement`
 * rather than restated, because that function owns normalisation and
 * `../redaction/sql.test.ts` pins its behaviour — restating a normalised form
 * here would be a second, drifting copy of it.
 */

import { describe, expect, it } from 'vitest';

import { normalizeSqlStatement } from '../redaction/sql.js';
import type { TelemetryEvent } from '../schema/event.js';
import type { TelemetryKind } from '../schema/kinds.js';
import {
  MAX_CALLER_LOOKUP_HOPS,
  UNKNOWN_STATEMENT_KEY,
  aggregateQueries,
  isDatabaseStatementEvent,
} from './queries.js';
import type { QueryGroup } from './queries.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 *
 * One trace, one capture: every case here is about the shape of a trace, so a
 * second trace would only add noise. The vocabulary (`items`, `item_groups`,
 * `loadItems`) is invented, as every fixture in this package is, so that
 * nothing in this file could serve as knowledge the product is supposed to
 * discover by analysing a project.
 * ---------------------------------------------------------------------------
 */

/** The trace every event in this suite belongs to. */
const TRACE_ID = 'a'.repeat(32);

/** The capture window the events belong to. */
const CAPTURE_ID = 'cap_0000000000000001';

/** The session that owns it. */
const SESSION_ID = 'ses_0000000000000001';

/** The dev-server preload's producer id: every event here is server-side. */
const PRODUCER_ID = 'prd_0000000000000001';

/** Where the capture starts, in Unix epoch milliseconds. */
const BASE_TIME = 1_789_812_900_000;

/** A statement two callers run, with one parameter. */
const SELECT_ITEMS = 'select id, name from items where id = $1';

/** A second statement, so a case can tell one group from another. */
const SELECT_ITEM_GROUPS = 'select group_id, label from item_groups where group_id = $1';

/** Monotonic counter behind the generated ids, span ids and sequences. */
let counter = 0;

/**
 * A persisted event with the fields these cases need and defaults for the rest.
 *
 * `seq` and `ingestSeq` follow construction order, which is what makes the
 * canonical order total and the assertions independent of the order events are
 * handed over in. `startTime` follows it too, so an event constructed later
 * starts later unless a case says otherwise.
 */
function event(over: Partial<TelemetryEvent>): TelemetryEvent {
  counter += 1;
  const base: TelemetryEvent = {
    id: `evt_${String(counter).padStart(16, '0')}`,
    traceId: TRACE_ID,
    spanId: String(counter).padStart(16, '0'),
    kind: 'db.query',
    name: 'select items',
    startTime: BASE_TIME + counter,
    duration: 1,
    tier: 'db',
    attributes: {},
    status: 'ok',
    producerId: PRODUCER_ID,
    seq: counter,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: counter,
  };
  return { ...base, ...over };
}

/** What a database span fixture may state. */
interface DatabaseSpanOptions {
  /** The parent span, when the case nests one span inside another. */
  readonly parentSpanId?: string;
  /** Offset from {@link BASE_TIME}, in milliseconds. */
  readonly at?: number;
  /** Inclusive duration, in milliseconds. */
  readonly duration?: number;
  /** Rows the execution returned, when the case reports a count. */
  readonly rowCount?: number;
  /** Which library observed it: `prisma` for the ORM, `pg` for the driver. */
  readonly client?: string;
  /** The span name, as the instrumentation reported it. */
  readonly name?: string;
  /** The reported outcome. */
  readonly status?: TelemetryEvent['status'];
}

/**
 * One statement execution, as a producer reports it.
 *
 * The statement is parameterized text with `$n` placeholders, the only form the
 * store ever holds: `../redaction/sql.ts` masks inline literals before an event
 * is persisted (AAP 0.5.2), so a fixture carrying a literal would describe a
 * row the product never produces.
 */
function statementSpan(statement: string, options: DatabaseSpanOptions = {}): TelemetryEvent {
  return event({
    kind: 'db.query',
    tier: 'db',
    name: options.name ?? 'select items',
    startTime: BASE_TIME + (options.at ?? 0),
    duration: options.duration ?? 1,
    status: options.status ?? 'ok',
    ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
    attributes: {
      'db.system': 'postgresql',
      'db.statement': statement,
      'db.client': options.client ?? 'pg',
      ...(options.rowCount !== undefined ? { 'db.rowCount': options.rowCount } : {}),
    },
  });
}

/**
 * One database-tier lifecycle span: real database time that ran no statement.
 *
 * Carries the attributes `../node/convert.ts` derives for such a span — the
 * producing client and the operation it was — and no `db.statement`, because
 * there is no statement to report. That absence is the whole signal.
 */
function lifecycleSpan(
  name: string,
  operation: string,
  options: DatabaseSpanOptions = {},
): TelemetryEvent {
  return event({
    kind: 'db.query',
    tier: 'db',
    name,
    startTime: BASE_TIME + (options.at ?? 0),
    duration: options.duration ?? 1,
    ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
    attributes: {
      'db.system': 'postgresql',
      'db.client': options.client ?? 'prisma',
      'db.operation': operation,
    },
  });
}

/** A named application function, timed by the patch: the caller of a query. */
function functionSpan(
  name: string,
  options: { readonly parentSpanId?: string } = {},
): TelemetryEvent {
  return event({
    kind: 'function',
    tier: 'server',
    name,
    duration: 100,
    ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
    source: {
      file: 'src/server/services/items.service.ts',
      line: 41,
      column: 22,
      symbol: name,
      resolvedBy: 'code-graph',
      confidence: 0.85,
    },
  });
}

/** The group carrying `key`, or a failure naming every key that was published. */
function groupByKey(groups: readonly QueryGroup[], key: string): QueryGroup {
  const found = groups.find((group) => group.normalizedStatement === key);
  if (found === undefined) {
    throw new Error(
      `no group for ${JSON.stringify(key)}; published ${JSON.stringify(
        groups.map((group) => group.normalizedStatement),
      )}`,
    );
  }
  return found;
}

/**
 * The group a statement belongs to.
 *
 * The key is asked of `normalizeSqlStatement`, so a case states the statement
 * it ran and never a normalised form this file would have to keep in step with
 * `../redaction/sql.ts`.
 */
function groupOf(groups: readonly QueryGroup[], statement: string): QueryGroup {
  return groupByKey(groups, normalizeSqlStatement(statement));
}

/** The unknown-statement bucket, looked up by the exported label itself. */
function unknownGroupOf(groups: readonly QueryGroup[]): QueryGroup {
  return groupByKey(groups, UNKNOWN_STATEMENT_KEY);
}

/** Whether any published group is the unknown-statement bucket. */
function hasUnknownGroup(groups: readonly QueryGroup[]): boolean {
  return groups.some((group) => group.normalizedStatement === UNKNOWN_STATEMENT_KEY);
}

/*
 * ---------------------------------------------------------------------------
 * The selector
 * ---------------------------------------------------------------------------
 */

describe('isDatabaseStatementEvent', () => {
  it('accepts a database event that reports the statement it ran', () => {
    expect(isDatabaseStatementEvent(statementSpan(SELECT_ITEMS))).toBe(true);
  });

  it.each([
    {
      label: "the ORM's argument serialization",
      name: 'prisma:client:serialize',
      operation: 'serialize',
    },
    {
      label: "the ORM's operation wrapper",
      name: 'prisma:client:operation',
      operation: 'operation',
    },
    {
      label: "the driver's pooled connection acquisition",
      name: 'pg-pool.connect',
      operation: 'connect',
    },
  ])(
    'rejects $label, which reports no statement',
    ({ name, operation }: { name: string; operation: string }) => {
      // The distinction this predicate exists for: a connection acquisition and
      // a serialization step are database-tier work, and neither is a statement
      // a `queryTable` row could describe (AAP 0.6.2). Each one names its
      // operation, which is what `../node/convert.ts` derives for every
      // lifecycle span, and reports no statement, because there is none.
      expect(isDatabaseStatementEvent(lifecycleSpan(name, operation))).toBe(false);
    },
  );

  it.each<TelemetryKind>(['function', 'http.server', 'route.handler'])(
    'rejects a %s event even when it carries a statement',
    (kind: TelemetryKind) => {
      // The patch's runtime helper copies a function's `meta` onto its span, so
      // a `function` span can legitimately carry `db.statement`. The kind is
      // checked first, and it is the kind that decides: counting such a span
      // would report the caller and the query it issued as two executions.
      const span = event({
        kind,
        tier: 'server',
        attributes: { 'db.statement': SELECT_ITEMS },
      });

      expect(isDatabaseStatementEvent(span)).toBe(false);
    },
  );

  it.each([
    { label: 'an absent statement', attributes: { 'db.system': 'postgresql' } },
    { label: 'an empty statement', attributes: { 'db.statement': '' } },
    { label: 'a statement that is not text', attributes: { 'db.statement': 42 } },
    { label: 'a null statement', attributes: { 'db.statement': null } },
  ])('rejects $label', ({ attributes }: { attributes: Record<string, unknown> }) => {
    // An attribute bag is untyped at runtime: it has crossed a process
    // boundary and the store before an aggregate reads it, so every one of
    // these is a value a producer bug can really deliver.
    expect(isDatabaseStatementEvent(event({ attributes }))).toBe(false);
  });

  it('reads an event whose attribute bag is missing entirely', () => {
    // An event can reach an aggregate from a store row rather than from a
    // validated ingest, and one malformed event must never end the service's
    // panel-data call (AAP 0.5.5).
    const malformed = { ...statementSpan(SELECT_ITEMS), attributes: undefined };

    expect(isDatabaseStatementEvent(malformed as unknown as TelemetryEvent)).toBe(false);
  });

  it('accepts a reported statement that normalises to nothing', () => {
    // Reported text is reported text: the producer said a statement ran, so it
    // is an execution. What normalisation makes of the text decides its group,
    // not whether it counts.
    expect(isDatabaseStatementEvent(statementSpan('   '))).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Lifecycle spans are not executions
 * ---------------------------------------------------------------------------
 */

describe('aggregateQueries: database work that ran no statement', () => {
  it('groups the executions and leaves the lifecycle spans out of the table', () => {
    const caller = functionSpan('loadItems');
    const groups = aggregateQueries([
      caller,
      lifecycleSpan('prisma:client:operation', 'operation', {
        parentSpanId: caller.spanId,
        at: 1,
        duration: 40,
      }),
      lifecycleSpan('prisma:client:serialize', 'serialize', {
        parentSpanId: caller.spanId,
        at: 2,
        duration: 3,
      }),
      lifecycleSpan('pg-pool.connect', 'connect', {
        parentSpanId: caller.spanId,
        at: 5,
        duration: 12,
        client: 'pg',
      }),
      statementSpan(SELECT_ITEMS, { parentSpanId: caller.spanId, at: 20, duration: 9 }),
    ]);

    // One statement ran, so there is one row, and it is not competing with a
    // bucket of overhead spans for the top of the table.
    expect(groups).toHaveLength(1);
    expect(hasUnknownGroup(groups)).toBe(false);

    const group = groupOf(groups, SELECT_ITEMS);
    expect(group.executionCount).toBe(1);
    expect(group.totalDurationMs).toBe(9);
    expect(group.occurrences.map((occurrence) => occurrence.durationMs)).toEqual([9]);
  });

  it('publishes nothing at all for a capture of pure database overhead', () => {
    // The shape a capture of an idle-but-connected app has: the pool warms up,
    // the ORM compiles, and not one statement runs. An empty table is the
    // honest answer; a single `(unknown statement) x 3` row is not.
    const groups = aggregateQueries([
      lifecycleSpan('prisma:client:connect', 'connect'),
      lifecycleSpan('prisma:client:compile', 'compile'),
      lifecycleSpan('pg.connect', 'connect', { client: 'pg' }),
    ]);

    expect(groups).toEqual([]);
  });

  it('keeps an execution whose reported statement normalises to nothing', () => {
    // The one case that still reaches the unknown-statement bucket, and the
    // reason the label and its group survive: the producer reported text, so a
    // statement ran and its duration is part of the capture's database cost.
    const groups = aggregateQueries([
      statementSpan(';', { duration: 4 }),
      statementSpan('   ', { duration: 6 }),
      statementSpan(SELECT_ITEMS, { duration: 1 }),
    ]);

    expect(groups).toHaveLength(2);
    const unknown = unknownGroupOf(groups);
    expect(unknown.normalizedStatement).toBe(UNKNOWN_STATEMENT_KEY);
    // No legible text represents it: both reports normalised away.
    expect(unknown.statement).toBe(UNKNOWN_STATEMENT_KEY);
    expect(unknown.executionCount).toBe(2);
    expect(unknown.totalDurationMs).toBe(10);
  });

  it('answers an empty capture with an empty table', () => {
    expect(aggregateQueries([])).toEqual([]);
    expect(aggregateQueries([functionSpan('loadItems')])).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * One execution, two instrumentations
 * ---------------------------------------------------------------------------
 */

describe('aggregateQueries: one execution two libraries both observed', () => {
  it('counts the outermost observation once and keeps its interval', () => {
    const caller = functionSpan('loadItems');
    const orm = statementSpan(SELECT_ITEMS, {
      parentSpanId: caller.spanId,
      name: 'prisma:client:db_query',
      client: 'prisma',
      at: 10,
      duration: 24,
      rowCount: 3,
    });
    const driver = statementSpan(SELECT_ITEMS, {
      parentSpanId: orm.spanId,
      name: 'pg.query:SELECT items_db',
      client: 'pg',
      at: 12,
      duration: 10,
      rowCount: 3,
    });

    const groups = aggregateQueries([caller, orm, driver]);
    const group = groupOf(groups, SELECT_ITEMS);

    // One execution: the ORM span and the driver span underneath it are two
    // observations of the same work.
    expect(group.executionCount).toBe(1);
    // The outermost observation is the one kept, because its interval contains
    // the whole execution including the ORM's own overhead. Keeping the inner
    // one would under-report the cost the caller paid by 14 ms.
    expect(group.totalDurationMs).toBe(24);
    expect(group.maxDurationMs).toBe(24);
    expect(group.occurrences.map((occurrence) => occurrence.eventId)).toEqual([orm.id]);
    expect(group.occurrences[0]?.spanId).toBe(orm.spanId);
    // And the row count is the execution's, not twice the execution's.
    expect(group.totalRowCount).toBe(3);
    expect(group.callers.map((entry) => entry.name)).toEqual(['loadItems']);
    expect(group.callers[0]?.executionCount).toBe(1);
  });

  it('collapses a pair the same library observed twice', () => {
    // The ORM's client span and its engine span are both `db.client: prisma`,
    // so requiring the two observations to disagree about the library would
    // count this pair twice. Nesting plus an equal statement is the whole
    // condition.
    const outer = statementSpan(SELECT_ITEMS, {
      name: 'prisma:client:db_query',
      client: 'prisma',
      duration: 12,
    });
    const inner = statementSpan(SELECT_ITEMS, {
      parentSpanId: outer.spanId,
      name: 'prisma:engine:db_query',
      client: 'prisma',
      duration: 7,
    });

    const group = groupOf(aggregateQueries([outer, inner]), SELECT_ITEMS);

    expect(group.executionCount).toBe(1);
    expect(group.totalDurationMs).toBe(12);
  });

  it('compares the normalised key, not the reported text', () => {
    // Two libraries reporting one statement need not report it byte for byte —
    // a trailing terminator or collapsed whitespace differs. The comparison is
    // the group's own identity, so two observations that would land in one
    // group are one execution.
    const outer = statementSpan(`${SELECT_ITEMS};`, { client: 'prisma', duration: 9 });
    const inner = statementSpan(`  ${SELECT_ITEMS}  `, {
      parentSpanId: outer.spanId,
      client: 'pg',
      duration: 4,
    });

    const groups = aggregateQueries([outer, inner]);

    expect(groups).toHaveLength(1);
    expect(groupOf(groups, SELECT_ITEMS).executionCount).toBe(1);
  });

  it('counts a nested pair of different statements twice', () => {
    // Nesting alone proves nothing: an ORM operation wrapper legitimately runs
    // a different statement from the one nested inside it, and a rule that
    // dropped any nested database span would delete real executions.
    const outer = statementSpan(SELECT_ITEM_GROUPS, { client: 'prisma', duration: 15 });
    const inner = statementSpan(SELECT_ITEMS, {
      parentSpanId: outer.spanId,
      client: 'pg',
      duration: 5,
    });

    const groups = aggregateQueries([outer, inner]);

    expect(groups).toHaveLength(2);
    expect(groupOf(groups, SELECT_ITEM_GROUPS).executionCount).toBe(1);
    expect(groupOf(groups, SELECT_ITEMS).executionCount).toBe(1);
  });

  it('counts two genuine executions of one statement twice', () => {
    // The N+1 shape the query table exists to surface: the same statement run
    // twice from the same function. The two spans are siblings, not nested, so
    // nothing collapses — this is the case a de-duplication rule must not
    // break.
    const caller = functionSpan('loadItems');
    const first = statementSpan(SELECT_ITEMS, {
      parentSpanId: caller.spanId,
      at: 1,
      duration: 6,
    });
    const second = statementSpan(SELECT_ITEMS, {
      parentSpanId: caller.spanId,
      at: 20,
      duration: 4,
    });

    const group = groupOf(aggregateQueries([caller, first, second]), SELECT_ITEMS);

    expect(group.executionCount).toBe(2);
    expect(group.totalDurationMs).toBe(10);
    expect(group.occurrences.map((occurrence) => occurrence.eventId)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it('counts a three-deep chain of observations once', () => {
    // The ORM's client span, its engine span and the driver's span: three
    // observations, one execution, and the outermost interval is the one that
    // contains the other two.
    const client = statementSpan(SELECT_ITEMS, { client: 'prisma', duration: 30 });
    const engine = statementSpan(SELECT_ITEMS, {
      parentSpanId: client.spanId,
      client: 'prisma',
      duration: 20,
    });
    const driver = statementSpan(SELECT_ITEMS, {
      parentSpanId: engine.spanId,
      client: 'pg',
      duration: 10,
    });

    const group = groupOf(aggregateQueries([client, engine, driver]), SELECT_ITEMS);

    expect(group.executionCount).toBe(1);
    expect(group.totalDurationMs).toBe(30);
  });

  it('sees through a lifecycle span between the two observations', () => {
    // The real nesting is not always adjacent: the driver acquires a pooled
    // connection inside the ORM's statement span and runs the statement inside
    // that. The walk is over ancestors, not over the immediate parent.
    const orm = statementSpan(SELECT_ITEMS, { client: 'prisma', duration: 18 });
    const connect = lifecycleSpan('pg-pool.connect', 'connect', {
      parentSpanId: orm.spanId,
      client: 'pg',
      duration: 12,
    });
    const driver = statementSpan(SELECT_ITEMS, {
      parentSpanId: connect.spanId,
      client: 'pg',
      duration: 6,
    });

    const group = groupOf(aggregateQueries([orm, connect, driver]), SELECT_ITEMS);

    expect(group.executionCount).toBe(1);
    expect(group.totalDurationMs).toBe(18);
  });

  it.each([
    { label: 'within the hop budget', hops: MAX_CALLER_LOOKUP_HOPS - 1, executions: 1 },
    { label: 'beyond the hop budget', hops: MAX_CALLER_LOOKUP_HOPS, executions: 2 },
  ])(
    'reads an ancestor $label ($executions executions)',
    ({ hops, executions }: { hops: number; executions: number }) => {
      // The budget is a budget: a pathological trace costs nothing, and the
      // failure mode past it is an execution counted twice — visible in the
      // panel — rather than one deleted from it.
      const outer = statementSpan(SELECT_ITEMS, { client: 'prisma', duration: 50 });
      let parentSpanId = outer.spanId;
      const between: TelemetryEvent[] = [];
      for (let hop = 0; hop < hops; hop += 1) {
        const intermediate = functionSpan(`step${String(hop)}`, { parentSpanId });
        between.push(intermediate);
        parentSpanId = intermediate.spanId;
      }
      const inner = statementSpan(SELECT_ITEMS, { parentSpanId, client: 'pg', duration: 5 });

      const group = groupOf(aggregateQueries([outer, ...between, inner]), SELECT_ITEMS);

      expect(group.executionCount).toBe(executions);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * Malformed ancestry
 *
 * Each case below terminates, which is half the assertion: a walk that looped
 * would hang the service's panel-data call rather than fail it. The other half
 * is that the statement survives — an unreadable parent link must not be able
 * to delete the only observation of a statement.
 * ---------------------------------------------------------------------------
 */

describe('aggregateQueries: ancestry a trace cannot really have', () => {
  it('keeps a statement span that is its own parent', () => {
    const span = statementSpan(SELECT_ITEMS, { duration: 7 });
    const selfParented: TelemetryEvent = { ...span, parentSpanId: span.spanId };

    const group = groupOf(aggregateQueries([selfParented]), SELECT_ITEMS);

    expect(group.executionCount).toBe(1);
    expect(group.totalDurationMs).toBe(7);
  });

  it('keeps both members of a two-span cycle', () => {
    // Every member of a cycle has an equal-keyed "ancestor", so a rule that
    // dropped on that alone would drop both and delete the statement from the
    // result. Counting twice is the safe direction.
    const first = statementSpan(SELECT_ITEMS, { duration: 9 });
    const second = statementSpan(SELECT_ITEMS, { parentSpanId: first.spanId, duration: 4 });
    const cycled: TelemetryEvent = { ...first, parentSpanId: second.spanId };

    const group = groupOf(aggregateQueries([cycled, second]), SELECT_ITEMS);

    expect(group.executionCount).toBe(2);
    expect(group.totalDurationMs).toBe(13);
  });

  it('keeps a statement span whose parent never arrived', () => {
    // The orphan case: the correlator flags it rather than dropping it, and a
    // filtered slice of a capture produces it routinely — the service may pass
    // the database spans of one trace without the function that called them.
    const orphan = statementSpan(SELECT_ITEMS, {
      parentSpanId: 'f'.repeat(16),
      duration: 5,
    });

    const group = groupOf(aggregateQueries([orphan]), SELECT_ITEMS);

    expect(group.executionCount).toBe(1);
    expect(group.callers).toEqual([]);
  });

  it('is unmoved by the order the events arrive in', () => {
    // A store row order, a WebSocket batch and a filtered slice all arrive
    // differently, and the inner observation may well be folded before its
    // outer one. The result is a function of the trace, not of the array.
    const outer = statementSpan(SELECT_ITEMS, { client: 'prisma', duration: 22 });
    const inner = statementSpan(SELECT_ITEMS, {
      parentSpanId: outer.spanId,
      client: 'pg',
      duration: 8,
    });

    expect(aggregateQueries([inner, outer])).toEqual(aggregateQueries([outer, inner]));
    expect(groupOf(aggregateQueries([inner, outer]), SELECT_ITEMS).totalDurationMs).toBe(22);
  });
});

/*
 * ---------------------------------------------------------------------------
 * What the exclusions must not disturb
 * ---------------------------------------------------------------------------
 */

describe('aggregateQueries: callers, bounds and order', () => {
  it('attributes an execution to the function above the lifecycle spans', () => {
    // The span directly above a statement is often the driver's own wrapper or
    // the ORM's operation span, so the caller walk looks for the nearest span
    // that names code a developer wrote. A lifecycle span between the two must
    // not become the answer to "who runs this".
    const caller = functionSpan('loadItems');
    const wrapper = lifecycleSpan('prisma:client:operation', 'operation', {
      parentSpanId: caller.spanId,
      duration: 30,
    });
    const statement = statementSpan(SELECT_ITEMS, {
      parentSpanId: wrapper.spanId,
      duration: 12,
    });

    const group = groupOf(aggregateQueries([caller, wrapper, statement]), SELECT_ITEMS);

    expect(group.callers.map((entry) => entry.name)).toEqual(['loadItems']);
    expect(group.callers[0]?.kind).toBe('function');
    expect(group.callers[0]?.source?.symbol).toBe('loadItems');
    expect(group.occurrences[0]?.callerName).toBe('loadItems');
  });

  it('keeps the counts exact when the occurrence bound cuts the sample', () => {
    const caller = functionSpan('loadItems');
    const executions = Array.from({ length: 5 }, (_unused, index) =>
      statementSpan(SELECT_ITEMS, {
        parentSpanId: caller.spanId,
        at: index * 10,
        duration: 2,
      }),
    );

    const [group] = aggregateQueries([caller, ...executions], { maxOccurrencesPerGroup: 2 });

    expect(group?.executionCount).toBe(5);
    expect(group?.totalDurationMs).toBe(10);
    expect(group?.occurrences).toHaveLength(2);
    expect(group?.occurrencesTruncated).toBe(true);
    // Canonical occurrence order: `startTime`, then id — so the sample kept is
    // the start of the group's history rather than an arbitrary two rows.
    expect(group?.occurrences.map((occurrence) => occurrence.eventId)).toEqual([
      executions[0]?.id,
      executions[1]?.id,
    ]);
  });

  it('keeps the counts exact when the caller bound cuts the rows', () => {
    const statements = ['first', 'second', 'third'].map((name) => {
      const caller = functionSpan(name);
      return [caller, statementSpan(SELECT_ITEMS, { parentSpanId: caller.spanId, duration: 3 })];
    });

    const [group] = aggregateQueries(statements.flat(), { maxCallersPerGroup: 1 });

    expect(group?.executionCount).toBe(3);
    expect(group?.callers).toHaveLength(1);
  });

  it('publishes the costliest group first', () => {
    const cheap = statementSpan(SELECT_ITEMS, { duration: 3 });
    const costly = statementSpan(SELECT_ITEM_GROUPS, { duration: 42 });
    const alsoCheap = statementSpan(SELECT_ITEMS, { duration: 1 });

    const groups = aggregateQueries([cheap, costly, alsoCheap]);

    expect(groups.map((group) => group.totalDurationMs)).toEqual([42, 4]);
    expect(groups[0]?.normalizedStatement).toBe(normalizeSqlStatement(SELECT_ITEM_GROUPS));
  });

  it('does not mutate the events it is given', () => {
    const outer = statementSpan(SELECT_ITEMS, { client: 'prisma', duration: 11 });
    const inner = statementSpan(SELECT_ITEMS, {
      parentSpanId: outer.spanId,
      client: 'pg',
      duration: 5,
    });
    const events = [outer, inner, lifecycleSpan('pg-pool.connect', 'connect', { client: 'pg' })];
    const before = structuredClone(events);

    aggregateQueries(events);

    expect(structuredClone(events)).toEqual(before);
  });
});
