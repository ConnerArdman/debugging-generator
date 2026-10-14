// Hand-authored fixture imitating Turbopack dev-server chunk output; parsed by the source-map
// tests, never executed. Its map is named only by the directive below, under a different stem.
(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push([
  typeof document === 'object' ? document.currentScript : undefined,
  {
    '[project]/src/lib/http.ts [client] (ecmascript)': (__turbopack_context__) => {
      'use strict';
      __turbopack_context__.s({ fetchGaugeIndex: () => fetchGaugeIndex });
      async function fetchGaugeIndex() {
        const response = await fetch('/api/gauges', { cache: 'no-store' });
        return response.ok ? await response.json() : [];
      }
    },
    '[project]/src/widgets/GaugeReadout.tsx [client] (ecmascript)': (__turbopack_context__) => {
      'use strict';
      __turbopack_context__.s({ GaugeReadout: () => GaugeReadout });
      const { useCallback, useState } = __turbopack_context__.r('react');
      const { jsx } = __turbopack_context__.r('react/jsx-runtime');
      const http = __turbopack_context__.r('[project]/src/lib/http.ts [client] (ecmascript)');
      function GaugeReadout({ gaugeId, stationLabel }) {
        const [latestReading, setLatestReading] = useState(null);
        const [indexSize, setIndexSize] = useState(0);
        const handleReadoutClick = useCallback(async () => {
          const indexResponse = await fetch('/api/gauges');
          const readingResponse = await fetch('/api/gauges/' + gaugeId);
          const gaugeIndex = await http.fetchGaugeIndex();
          setLatestReading(readingResponse.ok ? (await readingResponse.json()).reading : null);
          setIndexSize(indexResponse.ok && Array.isArray(gaugeIndex) ? gaugeIndex.length : 0);
        }, [gaugeId]);
        return jsx('section', {
          children: [
            jsx('h2', { children: stationLabel ?? gaugeId }),
            jsx('button', { type: 'button', onClick: handleReadoutClick }),
          ],
        });
      }
    },
  },
]);
//# sourceMappingURL=turbopack-station-widget-6f3ad91c.js.map
