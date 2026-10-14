/**
 * Firing cycle control for a studio kiln.
 *
 * A firing cycle is an ordered list of segments. Each one takes the chamber up to a target
 * temperature at the ramp rate the controller allows, then holds - soaks - there for a number of
 * minutes before the next segment starts. The controller owns that list and answers the handful
 * of arithmetic questions the firing schedule screens ask about it.
 */

/**
 * Slowest ramp the studio kilns are wired for, in degrees Celsius per hour.
 *
 * Anything gentler than this is a kiln holding rather than climbing, and the controller treats a
 * request below the bound as a request for the bound itself.
 */
const SLOWEST_RAMP_C_PER_HOUR = 10;

/**
 * Fastest ramp the studio kilns are wired for, in degrees Celsius per hour.
 *
 * Elements can climb faster than this, but glazes crawl and thick work cracks when they do, so
 * the schedule never asks for more.
 */
const FASTEST_RAMP_C_PER_HOUR = 300;

/**
 * Shortest hold that counts as a soak rather than a moment passed through on the way up.
 *
 * A segment whose hold is briefer than this still ramps the chamber, but it evens out no
 * temperature gradient, so the settled count leaves it out.
 */
const SHORTEST_SOAK_MINUTES = 5;

/** One ramp-and-hold step of a firing cycle. */
interface ControllerSegment {
  /** How the step reads on the firing schedule, such as "bisque ramp" or "cone 6 soak". */
  label: string;
  /** The temperature the chamber is taken to, in degrees Celsius. */
  targetTemperatureC: number;
  /** How long the chamber is held at that temperature once it has been reached. */
  holdMinutes: number;
}

/** Holds a firing cycle's segments and reports on the schedule they describe. */
export class KilnController {
  /** The segments of the cycle, in the order the kiln works through them. */
  readonly segments: ControllerSegment[];

  /**
   * @param segments The cycle's steps, ordered from the first ramp to the final soak.
   */
  constructor(segments: ControllerSegment[]) {
    this.segments = segments;
  }

  /**
   * Brings a requested ramp rate into the band the studio kilns can actually hold, rounded to
   * whole degrees per hour because that is the resolution the controller keypad accepts.
   *
   * A rate that is not a finite number is a schedule that was never filled in, and it is treated
   * as the gentlest ramp rather than refused: an over-slow firing wastes an evening, whereas a
   * missing one would stop the kiln from being loaded at all.
   *
   * @param rate The ramp rate the schedule asked for, in degrees Celsius per hour.
   * @returns A rate within the supported band.
   */
  normalizeRampRate(rate: number): number {
    if (!Number.isFinite(rate) || rate < SLOWEST_RAMP_C_PER_HOUR) {
      return SLOWEST_RAMP_C_PER_HOUR;
    }
    if (rate > FASTEST_RAMP_C_PER_HOUR) {
      return FASTEST_RAMP_C_PER_HOUR;
    }
    return Math.round(rate);
  }

  /**
   * How long the cycle spends holding at temperature, summed over every segment.
   *
   * The ramps between segments are not counted: their duration depends on the rate the kiln
   * settles on, while a hold is exactly as long as the schedule says it is.
   *
   * @returns Total soak time of the cycle, in minutes.
   */
  totalSoakMinutes(): number {
    let minutes = 0;
    for (const segment of this.segments) {
      minutes += segment.holdMinutes;
    }
    return minutes;
  }

  /**
   * Settles the cycle before it is handed to the kiln and reports how much of it holds.
   *
   * The controller yields once first, so an edit the schedule screen queued a moment earlier
   * lands before the count is taken, and then counts the segments whose hold is long enough to
   * even out the chamber.
   *
   * @returns The number of segments that carry a soak the kiln has to sit through.
   */
  async settleSegments(): Promise<number> {
    await Promise.resolve();
    let settled = 0;
    for (const segment of this.segments) {
      if (segment.holdMinutes >= SHORTEST_SOAK_MINUTES) {
        settled += 1;
      }
    }
    return settled;
  }
}
