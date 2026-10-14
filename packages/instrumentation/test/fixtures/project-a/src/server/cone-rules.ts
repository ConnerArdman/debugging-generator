/**
 * The studio's cone tables.
 *
 * Pyrometric cones are the scale a firing is planned against: a cone number stands for the heat
 * work a cycle has to deliver, and the table here turns that number into the peak temperature, the
 * fastest climb the kilns are trusted to hold, and the soak the studio keeps at the top of a cycle.
 *
 * Cone numbers are written on two runs. The cool cones carry a leading zero and count downwards -
 * cone 022 is the coolest of that run and cone 01 the hottest - while the hot cones count upwards
 * from cone 1. Both runs are held here as one whole number: a cool cone is its negative (cone 022
 * is -22, cone 04 is -4) and a hot cone is its plain positive (cone 6 is 6). A single number line,
 * ordered coolest to hottest, is what lets a comparison between two cones mean what it reads like.
 */

/** One row of the cone table: the peak a cone marks, and how a cycle should approach it. */
interface ConeProfile {
  /** The cone number, on the single number line described above. */
  readonly coneValue: number;
  /** Peak temperature in degrees Celsius, as measured at the studio's standard climb. */
  readonly peakTemperatureC: number;
  /** Fastest climb the kilns are trusted to hold for this cone, in degrees Celsius per hour. */
  readonly rampCeilingCPerHour: number;
  /** How long the studio holds the peak once it is reached, in minutes. */
  readonly soakMinutes: number;
}

/** The coolest cone the studio's kilns are rated for: cone 022. */
const LOWEST_CONE_VALUE = -22;

/** The hottest cone the studio's kilns are rated for: cone 14. */
const HIGHEST_CONE_VALUE = 14;

/**
 * The cones this studio actually fires, coolest first.
 *
 * The two cool rows are the bisque cones and the rest are glaze cones. A cone the studio does not
 * fire is simply absent rather than given invented numbers, so a lookup for it misses and the
 * caller is the one that decides what to do about the gap.
 */
const CONE_PROFILES: readonly ConeProfile[] = [
  { coneValue: -6, peakTemperatureC: 999, rampCeilingCPerHour: 150, soakMinutes: 15 },
  { coneValue: -4, peakTemperatureC: 1060, rampCeilingCPerHour: 150, soakMinutes: 20 },
  { coneValue: 1, peakTemperatureC: 1154, rampCeilingCPerHour: 120, soakMinutes: 15 },
  { coneValue: 5, peakTemperatureC: 1186, rampCeilingCPerHour: 110, soakMinutes: 20 },
  { coneValue: 6, peakTemperatureC: 1222, rampCeilingCPerHour: 108, soakMinutes: 20 },
  { coneValue: 10, peakTemperatureC: 1285, rampCeilingCPerHour: 90, soakMinutes: 30 },
];

/**
 * Checks that a cone number is one the studio's kilns are rated for, and hands it back.
 *
 * Cones are a discrete scale, so a fraction is as wrong as a number off the end of the scale, and
 * both are refused rather than rounded or clamped towards something plausible. A cone the kilns
 * are rated for is returned unchanged, which lets a caller check and assign in one step.
 *
 * @param value The cone number to check, on the single number line this module uses.
 * @returns The same cone number.
 * @throws RangeError If the value is not a whole number, or lies outside cone 022 to cone 14.
 */
export function assertConeValue(value: number): number {
  if (!Number.isInteger(value)) {
    throw new RangeError(`A cone number must be a whole number; got ${value}.`);
  }
  if (value < LOWEST_CONE_VALUE || value > HIGHEST_CONE_VALUE) {
    throw new RangeError(
      `Cone ${value} is outside the rated band of ${LOWEST_CONE_VALUE} to ${HIGHEST_CONE_VALUE}.`,
    );
  }
  return value;
}

/**
 * Looks a cone number up in the studio's cone table.
 *
 * A hit hands back a fresh row rather than the stored one, so the table cannot be reached - and
 * therefore cannot be altered - through the returned value.
 *
 * @param coneValue The cone number to look up.
 * @returns A copy of the matching row, or `null` when this studio does not fire that cone.
 */
export function findConeProfile(coneValue: number): ConeProfile | null {
  for (const profile of CONE_PROFILES) {
    if (profile.coneValue === coneValue) {
      return {
        coneValue: profile.coneValue,
        peakTemperatureC: profile.peakTemperatureC,
        rampCeilingCPerHour: profile.rampCeilingCPerHour,
        soakMinutes: profile.soakMinutes,
      };
    }
  }
  return null;
}

/**
 * Reads the fastest climb the kilns are trusted to hold for a cone.
 *
 * The table is walked here directly rather than through {@link findConeProfile}, so a caller that
 * wants the one number does not pay for a copy of the whole row to read a single field off it.
 *
 * @param coneValue The cone number to look up.
 * @returns The ceiling in degrees Celsius per hour, or `undefined` when this studio does not fire
 * that cone.
 */
export function findRampCeiling(coneValue: number): number | undefined {
  for (const profile of CONE_PROFILES) {
    if (profile.coneValue === coneValue) {
      return profile.rampCeilingCPerHour;
    }
  }
  return undefined;
}
