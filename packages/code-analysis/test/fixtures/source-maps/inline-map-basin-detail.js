// Hand-authored fixture: a webpack dev chunk whose source map travels inline, in a data URI.
// Never executed, imported or bundled; the decoded payload is documented in README.md.
'use strict';
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  ['app/(observatory)/basins/[id]/page'],
  {
    './app/(observatory)/basins/[id]/page.tsx': function (module, exports, __webpack_require__) {
      __webpack_require__.r(exports);

      const stationService = __webpack_require__('./src/lib/station-service.ts');

      async function BasinDetailPage(props) {
        const routeParams = await props.params;

        const gauges = await stationService.summarizeBasin(routeParams.id);
        const leadGauge = gauges[0];

        return {
          basinId: routeParams.id,
          gaugeCount: gauges.length,
          leadGaugeId: leadGauge ? leadGauge.id : null,
          meanLevelCm: leadGauge ? leadGauge.mean_level_cm : null,
        };
      }

      exports.default = BasinDetailPage;
    },
  },
]);
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5saW5lLW1hcC1iYXNpbi1kZXRhaWwuanMiLCJzb3VyY2VzIjpbIndlYnBhY2s6Ly9fTl9FLy4vYXBwLyhvYnNlcnZhdG9yeSkvYmFzaW5zL1tpZF0vcGFnZS50c3giXSwibmFtZXMiOlsiQmFzaW5EZXRhaWxQYWdlIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7OztxQkF5RDhCQTtRQUM1Qjs7UUFHQSJ9
