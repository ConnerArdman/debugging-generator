/**
 * Streaming views over a firing cycle and the readings a firing leaves behind.
 *
 * The schedule sheet reads a whole cycle at once, but the kiln log tails it: the log walks the
 * segments one at a time as the firing progresses, and it reads the stored chamber readings a page
 * at a time so a week of firings never has to sit in memory all at once. Both are written as
 * generators so a caller can stop part-way through a long firing without the module having to know
 * it did.
 */

/** One ramp-and-hold step of a firing cycle, as the studio schedule records it. */
export interface RampSegment {
  /** How the step reads on the firing schedule, such as "bisque ramp" or "cone 6 soak". */
  label: string;
  /** The temperature the chamber is taken to, in degrees Celsius. */
  targetTemperatureC: number;
  /** How long the chamber is held at that temperature once it has been reached. */
  holdMinutes: number;
}

/** One chamber reading of a firing, as the kiln log stores it. */
export interface KilnSampleRow {
  /** The firing the reading belongs to. */
  cycleId: string;
  /** When the reading was taken, as an ISO 8601 instant. */
  recordedAt: string;
  /** What the chamber probe read, in degrees Celsius. */
  temperatureC: number;
}

/**
 * Walks a cycle's segments in firing order, skipping the ones a studio marks as a placeholder.
 *
 * A placeholder segment is one the potter left at ambient with no hold: it keeps a slot on the
 * schedule sheet for a step they have not decided on, and the kiln log should not show it as a
 * step that ran.
 *
 * @param segments The cycle's steps, ordered from the first ramp to the final soak.
 */
export function* walkRampSegments(
  segments: RampSegment[],
): Generator<RampSegment, void, undefined> {
  for (const segment of segments) {
    if (segment.targetTemperatureC <= 0 && segment.holdMinutes <= 0) {
      continue;
    }

    yield segment;
  }
}

/**
 * Yields one firing's stored chamber readings a page at a time, in the order the log kept them.
 *
 * Each page is handed on in its own turn, so tailing a long firing leaves room for the studio's
 * other work between pages, and a caller that stops reading stops the walk with it. The controller
 * keypad cannot enter a page shorter than a single reading, so anything shorter is read as one
 * reading per page.
 *
 * @param rows The readings of one firing, oldest first.
 * @param pageSize How many readings a page carries.
 */
export async function* streamKilnSamples(
  rows: KilnSampleRow[],
  pageSize = 25,
): AsyncGenerator<KilnSampleRow[], void, undefined> {
  const perPage = Number.isFinite(pageSize) && pageSize >= 1 ? Math.trunc(pageSize) : 1;

  for (let start = 0; start < rows.length; start += perPage) {
    await Promise.resolve();

    yield rows.slice(start, start + perPage);
  }
}
