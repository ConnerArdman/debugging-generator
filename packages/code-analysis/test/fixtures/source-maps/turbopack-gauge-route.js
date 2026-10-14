// Hand-authored fixture imitating Turbopack dev-server chunk output, never executed or imported.
// The three region boundaries below are the `offset` values of turbopack-gauge-route.js.map.
(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push([
  typeof document === 'object' ? document.currentScript : undefined,
  {
    // region 1 of 3: the dynamic gauge route handler, [app-route] server code
    '[project]/app/api/gauges/[id]/route.ts [app-route] (ecmascript)': (__turbopack_context__) => {
      'use strict';
      __turbopack_context__.s({ GET: () => GET });
      const stationService = __turbopack_context__.r(
        '[project]/src/lib/station-service.ts [app-rsc] (ecmascript)',
      );
      async function GET(_request, { params }) {
        const { id } = await params;
        const gauges = await stationService.listBasinGauges(id);
        const gauge = gauges.at(0);
        if (gauge === undefined) {
          return Response.json({ id, error: 'unknown gauge' }, { status: 404 });
        }
        return Response.json(
          { gaugeId: gauge.id, stationLabel: gauge.label, basinGaugeCount: gauges.length },
          { status: 200 },
        );
      }
    },

    // region 2 of 3: the basin and station server layer the regions around it read
    '[project]/src/lib/station-service.ts [app-rsc] (ecmascript)': (__turbopack_context__) => {
      'use strict';
      __turbopack_context__.s({
        listBasinGauges: () => listBasinGauges,
        summarizeBasin: () => summarizeBasin,
      });
      const datastore = __turbopack_context__.r(
        '[project]/src/lib/datastore.ts [app-rsc] (ecmascript)',
      );
      async function listBasinGauges(basinId, take = 50) {
        return await datastore.prisma.gauge.findMany({ where: { basinId }, take });
      }
      async function summarizeBasin(basinId, maxGauges = 25) {
        const rollup = await datastore.pool.query(
          'SELECT g.id, COUNT(r.id) AS sample_count, AVG(r.level_cm) AS mean_level_cm FROM station_gauges g LEFT JOIN gauge_readings r ON r.gauge_id = g.id WHERE g.basin_id = $1 GROUP BY g.id LIMIT $2',
          [basinId, maxGauges],
        );
        return rollup.rowCount === 0 ? [] : rollup.rows;
      }
    },

    // region 3 of 3: the basin detail page, whose default export awaits the rollup above
    '[project]/app/(observatory)/basins/[id]/page.tsx [app-rsc] (ecmascript)': (
      __turbopack_context__,
    ) => {
      'use strict';
      __turbopack_context__.s({ default: () => BasinDetailPage });
      const { jsx } = __turbopack_context__.r('react/jsx-runtime');
      const stationService = __turbopack_context__.r(
        '[project]/src/lib/station-service.ts [app-rsc] (ecmascript)',
      );
      async function BasinDetailPage({ params }) {
        const { id } = await params;
        const gauges = await stationService.summarizeBasin(id);
        const leadGauge = gauges[0];
        return jsx('section', {
          children: [
            jsx('h1', { children: 'Basin ' + id }),
            jsx('p', { children: gauges.length + ' gauges reporting drift samples.' }),
            jsx('dd', { children: leadGauge ? leadGauge.id : 'none installed' }),
          ],
        });
      }
    },
  },
]);
//# sourceMappingURL=turbopack-gauge-route.js.map
