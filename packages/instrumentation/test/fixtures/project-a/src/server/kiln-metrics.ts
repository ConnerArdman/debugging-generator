/**
 * Hand-written statements over the studio's firing records.
 *
 * Two questions about a kiln log are asked often enough that the studio keeps a statement of its
 * own for each of them, rather than reading whole cycles back and totalling them on the schedule
 * screens: how much firing a kiln has done, and how its chamber actually behaved during one
 * cycle.
 *
 * The totals are a single aggregate, so that statement goes straight to the pool - one statement
 * needs no connection of its own. The chamber readings are a longer walk through one cycle, read
 * while a potter waits at the kiln, so that statement borrows a connection from the pool and hands
 * it back in a finally block: the connection returns whether the read resolves or fails.
 *
 * Both statements are parameterised. The kiln or cycle identifier travels in the values array and
 * is referred to as $1 in the statement text, so no identifier is ever written into the text
 * itself.
 */

import { pool } from './db-handles';

/**
 * One row of a kiln's firing totals: how many cycles it has on record, the average soak those
 * cycles held, and when the most recent one came off.
 *
 * The count and the average arrive from the driver as strings, because a count and an average over
 * a fixed-point column are both wider than a whole number. A kiln whose cycles are all still
 * running has no finished cycle to average or to date, so both of those read as absent.
 */
interface CycleTotalsRow {
  kiln_id: string;
  cycle_count: string;
  avg_soak_minutes: string | null;
  last_finished_at: Date | null;
}

/**
 * One chamber reading taken while a firing cycle ran: the cycle it belongs to, when the probe was
 * read, the temperature it found, and the climb the controller was holding at that moment.
 *
 * The temperature and the ramp rate are fixed-point columns, so the driver hands them over as
 * strings. The ramp rate is absent for a reading taken while the kiln was soaking rather than
 * climbing, which is most of the readings of a long hold.
 */
interface CycleSampleRow {
  cycle_id: string;
  recorded_at: Date;
  temperature_c: string;
  ramp_rate_c_per_hour: string | null;
}

/**
 * Totals the firing one kiln has done.
 *
 * A kiln with cycles on record answers with a single grouped row; a kiln that has not been fired
 * yet answers with nothing at all, which is what the studio's kiln list shows as a dash rather
 * than as a zero.
 *
 * @param kilnId The kiln whose firing log is being totalled.
 * @returns The kiln's totals row, or an empty list when the kiln has no cycles on record.
 */
export async function readCycleTotals(kilnId: string): Promise<CycleTotalsRow[]> {
  const result = await pool.query(
    'select kiln_id, count(*) as cycle_count, avg(soak_minutes) as avg_soak_minutes, max(finished_at) as last_finished_at from firing_cycles where kiln_id = $1 group by kiln_id',
    [kilnId],
  );

  return result.rows;
}

/**
 * Reads back the chamber readings of one firing cycle, oldest first.
 *
 * The readings come out in the order the probe was read, so the schedule sheet can draw the climb
 * without ordering them again. The connection is borrowed for the read alone and handed back in a
 * finally block, so a cycle with a long hold behind it cannot keep a connection out of the pool.
 *
 * @param cycleId The firing cycle whose chamber readings are wanted.
 * @returns The cycle's readings, in the order they were taken.
 */
export async function collectCycleSamples(cycleId: string): Promise<CycleSampleRow[]> {
  const client = await pool.connect();

  try {
    const result = await client.query(
      'select cycle_id, recorded_at, temperature_c, ramp_rate_c_per_hour from kiln_cycle_samples where cycle_id = $1 order by recorded_at asc',
      [cycleId],
    );

    return result.rows;
  } finally {
    client.release();
  }
}
