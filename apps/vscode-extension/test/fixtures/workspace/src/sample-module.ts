/**
 * Sample module of the extension-host fixture workspace. The open-location and
 * URI-handler suites open it at positions they compute by scanning its text for
 * three fixed anchor names, so it only has to be ordinary, import-free
 * TypeScript: a frozen ruler description and a few pure helpers over it.
 */

/** A numeric ruler: unit label, distance between marks and inclusive bounds. */
export interface SampleRulerSpec {
  unitLabel: string;
  stepSize: number;
  minimum: number;
  maximum: number;
}

/** The ruler the helpers below are written against. */
export const SAMPLE_ANCHOR_PRIMARY: Readonly<SampleRulerSpec> = Object.freeze({
  unitLabel: 'mm',
  stepSize: 5,
  minimum: 0,
  maximum: 250,
});

/** Clamps `value` into the ruler's inclusive bounds; `NaN` maps to the minimum. */
export function clampToRuler(value: number, ruler: Readonly<SampleRulerSpec>): number {
  if (Number.isNaN(value)) {
    return ruler.minimum;
  }
  return Math.min(ruler.maximum, Math.max(ruler.minimum, value));
}

/** Formats `value` as a labelled reading within bounds, for example `15 mm`. */
export function sampleAnchorMarker(value: number, ruler: Readonly<SampleRulerSpec>): string {
  return `${clampToRuler(value, ruler)} ${ruler.unitLabel}`;
}

/** Rounds `value` to the nearest mark counted from the minimum, within bounds. */
export function snapToStep(value: number, ruler: Readonly<SampleRulerSpec>): number {
  const clamped = clampToRuler(value, ruler);
  if (!Number.isFinite(ruler.stepSize) || ruler.stepSize <= 0) {
    return clamped;
  }
  const marks = Math.round((clamped - ruler.minimum) / ruler.stepSize);
  return clampToRuler(ruler.minimum + marks * ruler.stepSize, ruler);
}

/** The label of the ruler's innermost mark group: a fixed, inert string. */
export function innerMarkLabel(): string {
  return 'sample-anchor-inner';
}

/**
 * Lists up to `count` readings from the minimum upwards as one comma-separated
 * line. A ruler without a usable step yields its minimum alone; a count that is
 * not a finite number yields an empty line.
 */
export function describeRuler(ruler: Readonly<SampleRulerSpec>, count: number): string {
  const limit = Number.isFinite(count) ? Math.floor(count) : 0;
  const hasStep = Number.isFinite(ruler.stepSize) && ruler.stepSize > 0;
  const readings: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    const value = ruler.minimum + index * (hasStep ? ruler.stepSize : 0);
    if (value > ruler.maximum || (index > 0 && !hasStep)) {
      break;
    }
    readings.push(`${value} ${ruler.unitLabel}`);
  }
  return readings.join(', ');
}
