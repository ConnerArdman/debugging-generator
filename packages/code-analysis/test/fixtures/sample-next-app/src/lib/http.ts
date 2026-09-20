import type { NextRequest } from 'next/server';

/**
 * One row of the gauge index served by `GET /api/gauges`. The browser reaches
 * the server over HTTP alone, so the shape is declared here rather than
 * imported across that boundary.
 */
export interface GaugeIndexEntry {
  id: string;
  label: string;
  basinId: string;
}

/**
 * Reads the gauge index from the fixture route. `request` is optional because
 * the gauge widget calls this with no argument from the browser, while a server
 * caller may pass its own request so the fixture basin hint travels along. It
 * only ever contributes request options: the route stays a bare literal inside
 * the `fetch` call.
 */
export async function fetchGaugeIndex(request?: NextRequest): Promise<GaugeIndexEntry[]> {
  const forwardedBasin = request?.headers.get('x-fixture-basin');
  const init: RequestInit = { cache: 'no-store' };
  if (typeof forwardedBasin === 'string' && forwardedBasin.length > 0) {
    init.headers = { 'x-fixture-basin': forwardedBasin };
  }

  const response = await fetch('/api/gauges', init);
  if (!response.ok) {
    return [];
  }

  return (await response.json()) as GaugeIndexEntry[];
}
