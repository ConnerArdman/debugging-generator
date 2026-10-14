/**
 * The studio's original firing log, kept in plain JavaScript.
 *
 * It predates the scheduling screens and is still what the wall-mounted tablet loads, so it has
 * never been converted: the numbers it totals are the ones the studio bills against, and nobody
 * wants a conversion in the middle of a firing season.
 */

/** Entries shorter than this are a kiln that tripped rather than a firing that ran. */
const SHORTEST_BILLED_MINUTES = 15;

/**
 * Totals the billed minutes across a set of log entries.
 *
 * @param {{ kilnId: string, minutes: number }[]} entries One row per firing.
 * @returns {number} The total billed minutes.
 */
export function tallyFiringMinutes(entries) {
  let total = 0;

  for (const entry of entries) {
    if (entry.minutes >= SHORTEST_BILLED_MINUTES) {
      total += entry.minutes;
    }
  }

  return total;
}

/**
 * Renders one log row the way the tablet prints it.
 *
 * @param {{ kilnId: string, minutes: number }} entry The row to render.
 * @returns {string} The printed line.
 */
export const describeFiringEntry = (entry) => {
  const hours = Math.floor(entry.minutes / 60);
  const minutes = entry.minutes % 60;

  return `${entry.kilnId}: ${hours}h ${minutes}m`;
};
