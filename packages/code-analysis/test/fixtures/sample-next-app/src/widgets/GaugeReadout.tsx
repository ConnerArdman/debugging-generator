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

import { useState, useCallback } from 'react';

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
