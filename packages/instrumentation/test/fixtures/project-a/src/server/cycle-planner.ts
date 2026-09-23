/**
 * Planning a firing cycle from a studio preset.
 *
 * A preset names a cone and a ware type; the planner turns it into the ordered ramp-and-hold
 * steps the controller works through, and reports the total the schedule sheet prints at the
 * bottom of the page.
 */

import { findRampCeiling } from './cone-rules';
import type { RampSegment } from './segment-stream';

/** How long a candle step holds, in minutes, to drive damp out of greenware. */
const CANDLE_HOLD_MINUTES = 45;

/** The temperature a candle step holds at, in degrees Celsius. */
const CANDLE_TEMPERATURE_C = 95;

/** The shortest hold the schedule sheet will print for a soak. */
const MINIMUM_SOAK_MINUTES = 10;

/** A studio preset: what is being fired, and how hot. */
export interface CyclePreset {
  /** The preset's name on the studio's shelf card, such as "cone 6 glaze". */
  name: string;
  /** The cone the firing is taken to. */
  coneValue: number;
  /** Whether the load is greenware, which needs a candle step first. */
  greenware: boolean;
  /** How long the top temperature is held. */
  soakMinutes: number;
}

/**
 * Brings a requested soak into the range the schedule sheet prints, rounded to whole minutes
 * because the controller keypad accepts nothing finer.
 *
 * @param minutes The soak the preset asked for.
 * @returns The soak the schedule will carry.
 */
export function normaliseSoakMinutes(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return MINIMUM_SOAK_MINUTES;
  }

  return Math.max(MINIMUM_SOAK_MINUTES, Math.round(minutes));
}

/**
 * Turns a preset into the ordered steps of a firing cycle.
 *
 * Greenware gets a candle step before the climb, every cycle gets a climb to the cone's
 * temperature, and the top temperature is held for the normalised soak.
 *
 * @param preset The studio preset being fired.
 * @returns The cycle's steps, in firing order.
 */
export function planFiringCycle(preset: CyclePreset): RampSegment[] {
  const ceiling = findRampCeiling(preset.coneValue) ?? 0;
  const segments: RampSegment[] = [];

  if (preset.greenware) {
    segments.push({
      label: `${preset.name} candle`,
      targetTemperatureC: CANDLE_TEMPERATURE_C,
      holdMinutes: CANDLE_HOLD_MINUTES,
    });
  }

  segments.push({
    label: `${preset.name} climb`,
    targetTemperatureC: ceiling,
    holdMinutes: 0,
  });

  segments.push({
    label: `${preset.name} soak`,
    targetTemperatureC: ceiling,
    holdMinutes: normaliseSoakMinutes(preset.soakMinutes),
  });

  return segments;
}

/**
 * Reads a preset back from the studio's shelf cards.
 *
 * @param name The preset's name on the card.
 * @param load Reads one card by name, answering `null` when the studio has no such card.
 * @returns The preset, or `null` when the card is missing.
 */
export async function loadCyclePreset(
  name: string,
  load: (name: string) => Promise<CyclePreset | null>,
): Promise<CyclePreset | null> {
  const card = await load(name);

  if (card === null) {
    return null;
  }

  return { ...card, soakMinutes: normaliseSoakMinutes(card.soakMinutes) };
}

/**
 * Totals a cycle for the line the schedule sheet prints at the bottom of the page.
 *
 * @param segments The cycle's steps.
 * @returns The total hold across every step, in minutes.
 */
export const summariseCycleHold = (segments: RampSegment[]): number => {
  let total = 0;

  for (const segment of segments) {
    total += Math.max(0, segment.holdMinutes);
  }

  return total;
};
