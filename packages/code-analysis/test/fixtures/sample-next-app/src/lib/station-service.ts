/*
 * Server-function layer of the `sample-next-app` indexing fixture: read-only ts-morph input for
 * the @debuggen/code-analysis extractors, never installed, never built and never executed.
 *
 * It is the only module in the corpus holding data-access call sites, and it deliberately holds
 * both driver shapes the extractors have to recognise: the generated-client delegates
 * (`prisma.gauge.findMany`, `prisma.reading.create`) and raw node-postgres statements in both the
 * borrowed-connection form (`pool.connect()`, `client.query(...)`, `client.release()` in a
 * `finally`) and the direct `pool.query(...)`. Both handles come from `./datastore`, and every
 * call stays a plain member access on them, because the data-access extractor resolves the
 * receiver identifier statically: an alias, a wrapper or a computed property name would hide it.
 *
 * Each statement is one string literal parameterised with `$n` placeholders passed as the second
 * argument, so no value is ever interpolated into SQL text. The tables (`station_gauges`,
 * `gauge_readings`) and their columns are invented for this fixture alone, and no credential, host
 * or database name appears anywhere in it.
 *
 * Nothing here calls anything else here: every caller of these three exports lives in the sibling
 * `app/` and `pages/` trees, and the graph assertions count those callers exactly.
 */

import { prisma, pool } from './datastore';

import type { QueryResult } from './stubs/pg';
import type { GaugeRow, ReadingRow } from './stubs/prisma-client';

/**
 * What a write route parses out of its request body before one reading is stored. Local on
 * purpose: this module exports functions and nothing else, so both row types stay unexported.
 */
interface GaugeReadingInput {
  gaugeId: string;
  levelCm: number;
  capturedAt?: Date;
}

/**
 * One row of the basin rollup: a gauge, how many samples it holds and the mean level across them.
 * Counts and averages arrive as strings from the driver, and the mean is null for a gauge with no
 * samples yet — which is why the outer join stays an outer join.
 */
interface BasinDriftRow {
  id: string;
  sample_count: string;
  mean_level_cm: string | null;
}

/**
 * Reads the gauges installed in one basin through the generated client alone. `take` bounds the
 * page, so a densely instrumented basin cannot resolve an unbounded row set.
 */
export async function listBasinGauges(basinId: string, take = 50): Promise<GaugeRow[]> {
  const gauges = await prisma.gauge.findMany({ where: { basinId }, take });
  return gauges;
}

/**
 * Stores one reading and refreshes the rollup columns of the gauge it belongs to. The insert goes
 * through the generated client; the rollup update goes through a connection borrowed from the
 * pool and handed back in a `finally`, so the connection is released whether or not the statement
 * resolves. Both driver shapes therefore sit in this one body on purpose.
 */
export async function recordGaugeReading(input: GaugeReadingInput): Promise<ReadingRow> {
  const capturedAt = input.capturedAt ?? new Date();

  const reading = await prisma.reading.create({
    data: { gaugeId: input.gaugeId, levelCm: input.levelCm, capturedAt },
  });

  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE station_gauges SET last_level_cm = $1, last_captured_at = $2 WHERE id = $3',
      [input.levelCm, capturedAt, input.gaugeId],
    );
  } finally {
    client.release();
  }

  return reading;
}

/**
 * Aggregates the sample count and mean level of every gauge in a basin with a single statement
 * issued straight against the pool — one statement borrows no connection. Grouping and `LIMIT`
 * carry the whole shape, so the rollup needs no sorting clause at all.
 */
export async function summarizeBasin(basinId: string, maxGauges = 25): Promise<BasinDriftRow[]> {
  // fixture-marker: basin-drift
  const result: QueryResult<BasinDriftRow> = await pool.query(
    'SELECT g.id, COUNT(r.id) AS sample_count, AVG(r.level_cm) AS mean_level_cm FROM station_gauges g LEFT JOIN gauge_readings r ON r.gauge_id = g.id WHERE g.basin_id = $1 GROUP BY g.id LIMIT $2',
    [basinId, maxGauges],
  );

  if (result.rowCount === 0) {
    return [];
  }

  return result.rows;
}
