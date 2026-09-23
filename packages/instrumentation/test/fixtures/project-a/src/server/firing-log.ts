/**
 * The studio's firing log.
 *
 * Every firing a kiln runs is written down here: the cone it was taken to, how long the peak was
 * held, and the glaze the rack went in on. An entry is opened when the firing starts, and the log
 * screens read a kiln's most recent entries back so the potter can see what that chamber has been
 * doing lately.
 *
 * Reads and writes alike go through the generated client declared in `./db-handles`, so this
 * module holds no database handle of its own. Totalling a kiln's billed minutes is somebody
 * else's job: the log opens entries and reads them back, and counts nothing.
 */

import { prisma } from './db-handles';

/**
 * How many of a kiln's entries the log screens read back.
 *
 * Five is what fits the kiln card on the wall-mounted tablet without scrolling, and it is enough
 * history to tell a cooling kiln from one that has been idle all week.
 */
const RECENT_CYCLE_COUNT = 5;

/** What the log needs to open an entry for a firing that is about to start. */
export interface FiringCycleDraft {
  /** The kiln the firing runs in. */
  kilnId: string;
  /** The cone the firing is taken to, on the studio's single cone number line. */
  coneValue: number;
  /** How long the peak is held once the cone is down, in minutes. */
  soakMinutes: number;
  /** The glaze code off the bucket, left out for a bisque firing. */
  glazeCode?: string;
}

/** One entry of a kiln's firing log, as the log screens read it back. */
export interface FiringCycleEntry {
  /** The log's own identifier for the entry. */
  id: string;
  /** The kiln the firing ran in. */
  kilnId: string;
  /** The cone the firing was taken to. */
  coneValue: number;
  /** How long the peak was held, in minutes. */
  soakMinutes: number;
  /** The glaze the rack was fired on, or `null` when the firing was a bisque. */
  glazeCode: string | null;
  /** When the firing started. */
  startedAt: Date;
}

/**
 * Opens a log entry for a firing, and reads the kiln's recent entries back with it.
 *
 * The log screen shows the firing that has just been started at the top of the kiln's own short
 * history, so the write and the read that follows it both belong to this one step. The entry is
 * stamped as it is opened rather than by the caller: the log is the thing that knows when a firing
 * was written down.
 *
 * @param draft What the potter set the firing up to do.
 * @returns The entry that was opened, with the kiln's most recent entries, newest first.
 */
export async function logFiringCycle(
  draft: FiringCycleDraft,
): Promise<{ entry: FiringCycleEntry; recent: FiringCycleEntry[] }> {
  const entry: FiringCycleEntry = await prisma.firingCycle.create({
    data: {
      kilnId: draft.kilnId,
      coneValue: draft.coneValue,
      soakMinutes: draft.soakMinutes,
      glazeCode: draft.glazeCode ?? null,
      startedAt: new Date(),
    },
  });

  const recent: FiringCycleEntry[] = await prisma.firingCycle.findMany({
    where: { kilnId: draft.kilnId },
    orderBy: { startedAt: 'desc' },
    take: RECENT_CYCLE_COUNT,
  });

  return { entry, recent };
}

/**
 * Reads a kiln's most recent log entries, newest first.
 *
 * The client's own promise is handed straight back rather than waited on here, because there is
 * nothing this module would add to the rows once they arrive.
 *
 * @param kilnId The kiln whose log to read.
 * @returns The kiln's most recent entries, newest first.
 */
export function loadRecentFiringCycles(kilnId: string): Promise<FiringCycleEntry[]> {
  return prisma.firingCycle.findMany({
    where: { kilnId },
    orderBy: { startedAt: 'desc' },
    take: RECENT_CYCLE_COUNT,
  });
}
