'use client';

/*
 * Client-component specimen of the `sample-next-app` indexing corpus: read-only ts-morph input
 * for the @debuggen/code-analysis extractors, never installed, never built, never executed.
 *
 * Node shape this file guarantees — the JSX `onClick` attribute names the identifier
 * `handleReadoutClick`, whose `VariableDeclaration` initializer is a `useCallback` call whose
 * arrow body holds both `fetch` calls (one bare string-literal route, one template literal with
 * an interpolation) and the single hop into `fetchGaugeIndex` through the `@/lib/http` alias. Real
 * handlers are memoized exactly this way, so the extractors have to unwrap the hook call to
 * attribute those calls to `handleReadoutClick`.
 *
 * The `react` specifier stays unresolved and the JSX below untyped on purpose: nothing is
 * installed on disk for this tree, which is what proves the extractors read it AST-first.
 */

import { useState, useCallback, memo } from 'react';

import { fetchGaugeIndex } from '@/lib/http';

/**
 * Props of {@link GaugeReadout}. `gaugeId` identifies the gauge whose reading is fetched and is
 * the value the per-gauge route interpolates; `stationLabel` is the friendlier heading text a
 * basin page passes when it knows which station the gauge sits at.
 */
export interface GaugeReadoutProps {
  gaugeId: string;
  stationLabel?: string;
}

/**
 * Single gauge readout. A click reads the gauge index route, then this gauge's own reading, then
 * the shared index helper, and reports both results back into local state.
 */
export function GaugeReadout({ gaugeId, stationLabel }: GaugeReadoutProps) {
  const [latestReading, setLatestReading] = useState<number | null>(null);
  const [indexSize, setIndexSize] = useState(0);

  const handleReadoutClick = useCallback(async () => {
    const indexResponse = await fetch('/api/gauges');
    const readingResponse = await fetch(`/api/gauges/${gaugeId}`);
    const gaugeIndex = await fetchGaugeIndex();

    const readingPayload: unknown = readingResponse.ok ? await readingResponse.json() : null;
    const reading =
      typeof readingPayload === 'object' &&
      readingPayload !== null &&
      'reading' in readingPayload &&
      typeof readingPayload.reading === 'number'
        ? readingPayload.reading
        : null;

    setLatestReading(reading);
    setIndexSize(indexResponse.ok && Array.isArray(gaugeIndex) ? gaugeIndex.length : 0);
  }, [gaugeId]);

  return (
    <section>
      <h2>{stationLabel ?? gaugeId}</h2>
      <button type="button" onClick={handleReadoutClick}>
        Read this gauge
      </button>
      <p>Latest reading: {latestReading ?? 'none yet'}</p>
      <p>Gauges indexed: {indexSize}</p>
    </section>
  );
}

/*
 * The memoised specimen of the corpus, appended below everything above it: every line of this
 * file up to here is referenced by generated-to-original coordinates in `test/fixtures/source-maps`
 * and asserted by `src/source-map/resolver.test.ts`, so new shapes are added at the end and never
 * inserted.
 *
 * Node shapes this pair guarantees, which no other file of the corpus supplies:
 *   - a component declared through the *referenced* wrapper form, `memo(<identifier>)`, whose
 *     implementation is a separate declaration of this same module. It is the one of the two
 *     memoisation shapes that cannot be read off the initialiser alone, so the component node for
 *     the exported binding exists only if the wrapper is resolved through the identifier;
 *   - the render edge into that exported binding, written by the parent below rather than by
 *     another module, so the pair stands on its own;
 *   - no display-name assignment on the wrapper, which leaves the implementation's own name as the
 *     display name React would report — the case where the declared name and the runtime name of
 *     one component differ.
 *
 * `memo` stays unresolved like every other `react` specifier here: nothing is installed for this
 * tree, which is what proves the wrapper is recognised by the name written at the call site.
 */

/**
 * Props of {@link GaugeTrend} and of the panel that frames it. `readings` is the recent level
 * series of one gauge, oldest first, and is read for display only.
 */
interface GaugeTrendProps {
  readings: readonly number[];
}

/**
 * The implementation behind {@link GaugeTrend}: the readings as an ordered list. Declared
 * separately from the exported binding, which is what makes the wrapper below a reference rather
 * than an inline function.
 */
function GaugeTrendBody({ readings }: GaugeTrendProps) {
  return (
    <ol>
      {readings.map((reading, position) => (
        <li key={position}>{reading}</li>
      ))}
    </ol>
  );
}

/** The gauge trend list, memoised: re-rendered only when its readings change. */
export const GaugeTrend = memo(GaugeTrendBody);

/**
 * Frames the memoised trend list with a heading. The corpus' only parent of a wrapped component,
 * and a single element rather than a mapped list so the render edge counts unambiguously.
 */
export function GaugeTrendPanel({ readings }: GaugeTrendProps) {
  return (
    <section>
      <h3>Recent levels</h3>
      <GaugeTrend readings={readings} />
    </section>
  );
}
