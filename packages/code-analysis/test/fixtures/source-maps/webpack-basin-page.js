/*
 * Hand-authored fixture that imitates the chunk a Next.js (webpack) dev server serves for the
 * `sample-next-app` corpus. It is read as bytes over a throwaway loopback server and is never
 * executed, imported or bundled. Its line and column positions are load-bearing: the segments in
 * `webpack-basin-page.js.map`, and the expectation table in this folder's README, address them.
 */

'use strict';

(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  ['app/(observatory)/basins/[id]/page'],
  {
    './src/widgets/GaugeReadout.tsx': (module, exports, __webpack_require__) => {
      'use strict';
      __webpack_require__.r(exports);
      const react = __webpack_require__('./node_modules/react/cjs/react.development.js');
      const http = __webpack_require__('./src/lib/http.ts');

      function handleReadoutClick(gaugeId) {
        const indexRequest = fetch('/api/gauges');
        const readingRequest = fetch('/api/gauges/' + gaugeId);
        return Promise.all([indexRequest, readingRequest, http.fetchGaugeIndex()]);
      }

      function GaugeReadout(props) {
        const [latestReading, setLatestReading] = react.useState(null);
        const onReadout = () => handleReadoutClick(props.gaugeId).then(setLatestReading);
        return react.createElement('button', { onClick: onReadout }, latestReading);
      }

      exports.GaugeReadout = GaugeReadout;
    },
    './src/lib/http.ts': (module, exports, __webpack_require__) => {
      'use strict';
      __webpack_require__.r(exports);

      async function fetchGaugeIndex(request) {
        const forwardedBasin = request ? request.headers.get('x-fixture-basin') : null;
        const init = { cache: 'no-store' };
        if (typeof forwardedBasin === 'string' && forwardedBasin.length > 0) {
          init.headers = { 'x-fixture-basin': forwardedBasin };
        }

        const response = await fetch('/api/gauges', init);
        return response.ok ? await response.json() : [];
      }

      exports.fetchGaugeIndex = fetchGaugeIndex;
    },
  },
]);
//# sourceMappingURL=webpack-basin-page.js.map
