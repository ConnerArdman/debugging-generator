/*
 * Data-access module of the `fixture-trailhead-guide` corpus: read-only ts-morph input for the
 * apps/local-service integration suites, never installed, never built and never executed. `pg` is
 * declared in the fixture's package.json but nothing is installed beside this tree, so the module
 * symbol stays unresolved — the intended state, because the suites read the shapes below out of
 * the abstract syntax tree rather than type-checking or running them.
 *
 * Where the two sibling corpora declare their driver handle in one module and write their
 * statements in another, this one keeps both here: a single `new Pool(…)` at module level, and
 * every statement issued straight against it as `pool.query(…)`. That plain member access on a
 * plain identifier is load-bearing twice over — it is what the data-access extractor matches when
 * it discovers the handle from its construction, and it is the call site a captured `db.query`
 * event's source location resolves back to — so the handle is never aliased, never re-exported
 * under another name, never wrapped in a helper and never borrowed with a connection of its own.
 *
 * Two statements and no more: the conditions read, whose `IN` list grows with the number of trails
 * asked about, and the single-trail gate lookup. Both are parameterised with `$n` placeholders
 * whose values travel in the second argument, so no value — and no table or column name — is ever
 * interpolated into statement text, and neither statement carries an inline literal of any kind.
 * The only thing interpolated anywhere in the file is the placeholder list itself.
 *
 * Nothing here holds a credential: the connection string is read from the environment with no
 * fallback, since a fixture that never opens a socket has no use for a default, and no host, user,
 * password or database name appears anywhere in it.
 */

import { Pool } from 'pg';

/**
 * The corpus's one pooled-driver handle, constructed at module level so both statements below run
 * on the same pool. Its connection string is whatever the environment supplies, and `undefined`
 * when it supplies nothing — the normal state for a tree that is only ever read.
 */
export const pool = new Pool({ connectionString: process.env.TRAILHEAD_GUIDE_DATABASE_URL });

/**
 * One row of `trail_condition_reports` as a gate volunteer filed it. The field names are the
 * database's own, so the service layer above maps them into the shape a browser reads instead of
 * either tier guessing at the other's spelling. `snow_line_meters` is null when nobody measured
 * the snow line that morning, which is a report with a gap in it rather than no report at all.
 */
export interface TrailConditionReportRow {
  trail_id: string;
  region: string;
  surface: string;
  snow_depth_cm: number;
  snow_line_meters: number | null;
  observed_at: Date;
}

/**
 * One row of `trailhead_gate_status`: what state the gate at the head of a trail was in, and when
 * a ranger last checked it. The table holds one row per trail, which is why the lookup below
 * resolves to a single row or to nothing.
 */
export interface TrailheadGateRow {
  trail_id: string;
  gate_state: string;
  checked_at: Date;
}

/**
 * Reads the condition reports filed for a set of trails, newest observation first.
 *
 * The placeholder list is derived from the argument's length, so one statement text serves a single
 * trail (`IN ($1)`) and a handful of them (`IN ($1, $2, $3)`) while every slug still travels as a
 * bound value; the slugs are copied into the values array so the caller's array is left alone. An
 * empty request has no statement to issue at all — `IN ()` is not valid SQL — so it resolves to an
 * empty list without reaching the pool.
 */
export async function queryTrailConditionReports(
  trailIds: readonly string[],
): Promise<TrailConditionReportRow[]> {
  if (trailIds.length === 0) {
    return [];
  }

  const placeholders = trailIds.map((_, index) => `$${index + 1}`).join(', ');

  const result = await pool.query<TrailConditionReportRow>(
    `SELECT trail_id, region, surface, snow_depth_cm, snow_line_meters, observed_at FROM trail_condition_reports WHERE trail_id IN (${placeholders}) ORDER BY observed_at DESC`,
    [...trailIds],
  );

  return result.rows;
}

/**
 * Reads the gate status of one trailhead, or `null` when no ranger has reported on it.
 *
 * Nothing about a single-trail lookup has to be assembled, so this statement stays a plain string
 * literal with one placeholder — the clearest shape the code graph can read, and a deliberate
 * contrast with the list query above.
 */
export async function queryTrailheadGateStatus(trailId: string): Promise<TrailheadGateRow | null> {
  const result = await pool.query<TrailheadGateRow>(
    'SELECT trail_id, gate_state, checked_at FROM trailhead_gate_status WHERE trail_id = $1',
    [trailId],
  );

  return result.rows[0] ?? null;
}
