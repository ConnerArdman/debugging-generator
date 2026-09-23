/**
 * The studio's bisque schedule, kept in plain JavaScript beside the firing log.
 *
 * A bisque firing is drafted on paper before anything is keyed into a controller: the potter writes
 * down the kiln, the cone the greenware is taken to, and the climb steps in the order the chamber
 * is meant to walk them. This module is how the wall-mounted tablet reads that draft back. It turns
 * the drafted steps into the ramp a keypad is programmed from, settles how long the top of the
 * firing is held, and checks the cone before any other number is worked out from it.
 *
 * Like the firing log beside it, this file was written before the scheduling screens and has never
 * been converted. Every reading is taken off the draft as it stands: no step is reordered, nothing
 * is kept between firings, and the draft the potter handed in is never written back to.
 */

/** The climb a step is programmed at when the draft leaves the field blank, in degrees per hour. */
const DEFAULT_CLIMB_PER_HOUR = 108;

/** The fastest climb the studio's keypads accept, in degrees Celsius per hour. */
const FASTEST_CLIMB_PER_HOUR = 300;

/** The shortest hold the studio prints on a schedule sheet, in minutes. */
const SHORTEST_HOLD_MINUTES = 10;

/** The coolest cone the studio's kilns are rated for: cone 022. */
const COOLEST_RATED_CONE = -22;

/** The hottest cone the studio's kilns are rated for: cone 14. */
const HOTTEST_RATED_CONE = 14;

/**
 * Drafts the ramp for a bisque firing from the steps as the potter wrote them down.
 *
 * The cone is checked first, because a cone the kilns are not rated for makes every number below it
 * meaningless, and the checked cone is what the sheet carries afterwards, so the schedule and the
 * firing log agree on one number. The steps are then walked once, in the order they were drafted:
 * each one keeps the climb and the hold it was given, and picks up the position it is programmed
 * into, which is the first thing a keypad asks for.
 *
 * A draft with no steps on it is still a draft - the kiln and the cone are known - so it comes back
 * with an empty ramp rather than being refused. The steps are usually written in afterwards,
 * against a sheet that is already pinned up.
 *
 * @param {{ kilnId: string, targetConeValue?: number, segments?: { label: string,
 * degreesPerHour?: number, holdMinutes?: number }[] }} draft The kiln the firing runs in, the cone
 * it is taken to, and the steps as drafted.
 * @returns {{ kilnId: string, targetConeValue: number, ramp: { order: number, label: string,
 * degreesPerHour: number, holdMinutes: number }[] }} The kiln, the checked cone, and the ramp a
 * keypad is programmed from.
 * @throws {RangeError} If the cone is not one the studio's kilns are rated for.
 */
export function planBisqueRamp({ kilnId, targetConeValue = 6, segments = [] }) {
  const coneValue = assertBisqueCone(targetConeValue);
  const ramp = [];

  let order = 0;

  for (const segment of segments) {
    const climb = Number.isFinite(segment.degreesPerHour)
      ? segment.degreesPerHour
      : DEFAULT_CLIMB_PER_HOUR;
    const hold = Number.isFinite(segment.holdMinutes) ? segment.holdMinutes : 0;

    ramp.push({
      order,
      label: segment.label,
      degreesPerHour: Math.min(FASTEST_CLIMB_PER_HOUR, Math.max(1, Math.round(climb))),
      holdMinutes: Math.max(0, Math.round(hold)),
    });

    order += 1;
  }

  return { kilnId, targetConeValue: coneValue, ramp };
}

/**
 * Settles how long the top of a bisque firing is held.
 *
 * The figure is handed back through a promise rather than returned outright, because every reader
 * on the tablet waits on this one: the studio means to read the hold off the controller itself one
 * day, and keeping the shape it has now means no reader has to change when that happens.
 *
 * A hold nobody wrote down, or one written down as something that is not a number, falls back to
 * the shortest hold the studio prints, and a shorter hold is raised to it - ware let go at the peak
 * is the ware that comes out underfired.
 *
 * @param {string} kilnId The kiln the firing runs in.
 * @param {number} holdMinutes The hold as drafted, in minutes.
 * @returns {Promise<{ kilnId: string, soakMinutes: number }>} The kiln and the hold to keep at the
 * top of the firing, in whole minutes.
 */
export async function resolveBisqueSoak(kilnId, holdMinutes) {
  const drafted = await Promise.resolve(holdMinutes);
  const minutes = Number.isFinite(drafted) ? Math.round(drafted) : SHORTEST_HOLD_MINUTES;

  return { kilnId, soakMinutes: Math.max(SHORTEST_HOLD_MINUTES, minutes) };
}

/**
 * Checks that a cone is one the studio's kilns are rated for, and hands it back.
 *
 * Cones are a discrete scale, so a fraction is as wrong as a number off the end of the scale, and
 * both are refused rather than rounded towards something plausible. A bisque draft is checked
 * against the whole rated band rather than the two cool cones alone, because the same chamber takes
 * the glaze load afterwards and the studio keys one band into its keypads.
 *
 * A cone the kilns are rated for is handed back unchanged, which lets a caller check a cone and
 * assign it in one step.
 *
 * @param {number} coneValue The cone to check, on the studio's single cone number line.
 * @returns {number} The same cone.
 * @throws {RangeError} If the cone is not a whole number, or lies outside the rated band.
 */
export function assertBisqueCone(coneValue) {
  if (
    !Number.isInteger(coneValue) ||
    coneValue < COOLEST_RATED_CONE ||
    coneValue > HOTTEST_RATED_CONE
  ) {
    throw new RangeError(
      `Cone ${coneValue} is outside the band of ${COOLEST_RATED_CONE} to ${HOTTEST_RATED_CONE}.`,
    );
  }

  return coneValue;
}
