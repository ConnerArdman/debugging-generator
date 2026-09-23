/**
 * Programming a firing cycle for one kiln.
 *
 * A studio writes a cycle down as a short list of steps - a climb to a temperature, and a hold once
 * it arrives - and pins the sheet to the kiln door before the door is closed. Two readings are
 * taken off that sheet here: the header the whole cycle prints above its steps, and the hold a
 * given wall thickness asks for while the steps are still being drafted.
 *
 * Every cycle is described against a cone, because a cone is the heat work a firing is judged by
 * rather than a temperature alone. A cone the studio's kilns are not rated for is refused before
 * any of the rest is worked out, so a sheet that prints at all prints a firing the kilns can
 * actually deliver.
 */

import { assertConeValue } from './cone-rules';

/** The shortest hold the studio will print on a schedule sheet, in minutes. */
const MINIMUM_SOAK_MINUTES = 10;

/** The hold a thin-walled load asks for at the baseline cone, in minutes. */
const BASE_SOAK_MINUTES = 12;

/** Minutes of extra hold each millimetre of wall thickness asks for. */
const SOAK_MINUTES_PER_MM = 2.5;

/** The cone the baseline hold above was measured at: the studio's everyday glaze cone. */
const BASELINE_CONE_VALUE = 6;

/** Minutes of hold that one further cone of heat work saves. */
const SOAK_MINUTES_PER_CONE = 1.5;

/** One drafted step of a cycle, as the studio writes it on the schedule sheet. */
interface SegmentDraft {
  /** How the step is labelled on the sheet, such as `candle` or `climb to peak`. */
  readonly label: string;
  /** The temperature the step climbs to, in degrees Celsius. */
  readonly targetTemperatureC: number;
  /** How fast the step may climb, in degrees Celsius per hour. */
  readonly rampRateCPerHour: number;
  /** How long the step holds once it arrives, in minutes; a plain climb holds for none. */
  readonly holdMinutes?: number;
}

/** What the studio knows about a cycle when it asks for the sheet's header. */
interface PlanCycleSegmentsInput {
  /** The kiln the cycle is programmed into, as the studio numbers its kilns. */
  readonly kilnId: string;
  /** The cone the firing is taken to; the everyday glaze cone when the studio names none. */
  readonly targetConeValue?: number;
  /** The drafted steps, in firing order; an empty sheet when the studio has drafted none. */
  readonly segments?: readonly SegmentDraft[];
}

/** The header a schedule sheet prints above its steps. */
interface CyclePlan {
  /** The kiln the cycle belongs to. */
  readonly kilnId: string;
  /** The cone the cycle is taken to, once checked against the rated band. */
  readonly coneValue: number;
  /** How many steps the sheet carries. */
  readonly segmentCount: number;
  /** The highest temperature any step climbs to, in degrees Celsius. */
  readonly peakTemperatureC: number;
  /** The total hold across every step, in minutes. */
  readonly totalHoldMinutes: number;
  /** The slowest climb the sheet asks for, in degrees Celsius per hour; zero for an empty sheet. */
  readonly slowestRampCPerHour: number;
  /** The step labels, in firing order. */
  readonly stepLabels: readonly string[];
}

/**
 * Reads a drafted cycle back as the header its schedule sheet prints.
 *
 * The cone is checked first, because a cone outside the rated band makes everything below it
 * meaningless, and the checked number is carried into the header so that the sheet and the firing
 * log afterwards agree on one cone. The steps are then walked once, in the order the studio drafted
 * them, for the readings the header carries: how many there are, how hot the cycle gets, how much
 * holding it asks for in total, and the slowest climb in it, which is what decides how long the
 * kiln will be busy.
 *
 * A cycle nobody has drafted steps for is still a cycle - the kiln and the cone are known - so an
 * empty sheet is reported as one rather than refused; the steps are usually written in afterwards,
 * against the header that is already pinned up.
 *
 * @param input The kiln the cycle is programmed into, the cone it is taken to, and the steps as
 * the studio drafted them.
 * @returns The sheet's header.
 * @throws RangeError If the cone is not one the studio's kilns are rated for.
 */
export function planCycleSegments({
  kilnId,
  targetConeValue = 6,
  segments = [],
}: PlanCycleSegmentsInput): CyclePlan {
  const coneValue = assertConeValue(targetConeValue);
  const stepLabels: string[] = [];

  let peakTemperatureC = 0;
  let totalHoldMinutes = 0;
  let slowestRampCPerHour = Number.POSITIVE_INFINITY;

  for (const segment of segments) {
    stepLabels.push(segment.label);
    peakTemperatureC = Math.max(peakTemperatureC, segment.targetTemperatureC);
    totalHoldMinutes += Math.max(0, segment.holdMinutes ?? 0);
    slowestRampCPerHour = Math.min(slowestRampCPerHour, segment.rampRateCPerHour);
  }

  return {
    kilnId,
    coneValue,
    segmentCount: segments.length,
    peakTemperatureC,
    totalHoldMinutes,
    slowestRampCPerHour: segments.length === 0 ? 0 : slowestRampCPerHour,
    stepLabels,
  };
}

/**
 * Estimates how long the top of a cycle has to be held for a given wall thickness.
 *
 * Heat reaches the middle of a thick wall slowly, so the hold grows with thickness; a hotter cone
 * has already delivered more heat work by the time the peak is reached, so it needs less of the
 * hold to finish the job. The two pull in opposite directions and are simply added up here, which
 * is how the studio has always done it on paper.
 *
 * The result is rounded to whole minutes, because the controller keypad accepts nothing finer, and
 * never drops below the shortest hold the studio prints. A thickness nobody measured, or a cone
 * written down as something that is not a number at all, falls back to that shortest hold rather
 * than to a number nobody can read.
 *
 * @param targetConeValue The cone the firing is taken to, on the studio's single number line.
 * @param wallThicknessMm The thickest wall in the load, in millimetres.
 * @returns The hold to keep at the top of the cycle, in whole minutes.
 */
export function estimateSoakMinutes(targetConeValue: number, wallThicknessMm: number): number {
  if (!Number.isFinite(targetConeValue) || !Number.isFinite(wallThicknessMm)) {
    return MINIMUM_SOAK_MINUTES;
  }

  const thicknessMm = Math.max(0, wallThicknessMm);
  const perThickness = thicknessMm * SOAK_MINUTES_PER_MM;
  const coneRelief = (targetConeValue - BASELINE_CONE_VALUE) * SOAK_MINUTES_PER_CONE;
  const minutes = Math.round(BASE_SOAK_MINUTES + perThickness - coneRelief);

  return Math.max(MINIMUM_SOAK_MINUTES, minutes);
}
