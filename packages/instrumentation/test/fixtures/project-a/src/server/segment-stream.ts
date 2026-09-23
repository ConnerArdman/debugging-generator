/**
 * Streaming views over a firing cycle's segments.
 *
 * The schedule screens read a whole cycle at once, but the kiln log tails it: the log walks the
 * segments one at a time as the firing progresses, and the chamber probe is read a sample at a
 * time while a segment holds. Both are written as generators so a caller can stop part-way
 * through a long firing without the module having to know it did.
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
 * Yields chamber readings for one kiln, a sample at a time, as the probe reports them.
 *
 * The probe is polled rather than pushed, so each sample is awaited before the next one is asked
 * for; a caller that stops reading stops the polling with it.
 *
 * @param kilnId The kiln whose probe is being read.
 * @param sampleCount How many samples to take before the stream ends.
 * @param readProbe Reads the probe once, in degrees Celsius.
 */
export async function* streamKilnSamples(
  kilnId: string,
  sampleCount: number,
  readProbe: (kilnId: string) => Promise<number>,
): AsyncGenerator<number, void, undefined> {
  for (let taken = 0; taken < sampleCount; taken += 1) {
    const reading = await readProbe(kilnId);

    if (!Number.isFinite(reading)) {
      return;
    }

    yield reading;
  }
}
