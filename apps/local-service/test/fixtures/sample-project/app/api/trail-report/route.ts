/*
 * The `/api/trail-report` request handler of the `fixture-trailhead-guide` corpus: read-only
 * ts-morph input for the apps/local-service integration suites, never installed, never built and
 * never executed. Nothing is installed beside this tree, so `next` is not imported at all — the
 * handler is written against the web-standard `Request` and `Response` the corpus tsconfig's DOM
 * library already declares, which is both the idiomatic App Router shape and the shape whose whole
 * signature still resolves with an empty `node_modules`.
 *
 * Its path is the load-bearing part. Sitting at `app/api/trail-report/route.ts` is what gives the
 * route map its `/api/trail-report` entry, and that is the exact string the browser tier asks for
 * in `src/components/TrailCard.tsx` and the exact route this corpus's captured telemetry samples
 * name — so the directory is never renamed, pluralised or re-cased, and `GET` stays the module's
 * one export.
 *
 * Three shapes inside the handler are deliberate. The `trailId` parameter is read and checked
 * rather than assumed, because the request samples turn on its value: four byte-identical
 * `?trailId=cascade-ridge` calls make up one duplicate group, while a call naming a different
 * trail is a different request. The wait is what gives a captured trace a server span long enough
 * to measure. And the reports are loaded through one plain call on an imported binding — no
 * wrapper, no indirection, no dynamic import — so a graph walk gets from the card a hiker clicked
 * through this route into the service layer and on to the statement it issues.
 *
 * Only the loading half of the service module beside it is called, and the summarising half is
 * deliberately left without a caller here. That second export exists to give a follow-up plan its
 * own patchable symbol in that file; reaching it from this route would add a second service call
 * and a second query to a trace the correlation samples fix at one of each.
 */

import { loadTrailReport, type TrailReport } from '@/server/services/trail-report.service';

/**
 * How long the handler waits before reading a trail's reports, in milliseconds.
 *
 * A trailhead's conditions feed is a slow upstream, and a trace worth reading needs a server span
 * with a duration in it, so the wait is stated once here rather than left as a bare number in the
 * handler below.
 */
const SIMULATED_REPORT_LATENCY_MS = 300;

/**
 * Answers `GET /api/trail-report?trailId=<slug>` with the condition reports on file for one trail.
 *
 * The slug is required, because a report is only ever about one trail: a request that omits it, or
 * that sends it empty, is malformed rather than a request for nothing, and is refused with `400`.
 * A trail this trailhead posts no reports for resolves to `null` in the service layer and is
 * answered with `404`, so a hiker reads that there is no report instead of reading an empty board.
 *
 * @param request The incoming request, read only for its URL.
 * @returns The trail's reports as JSON, or a JSON error body.
 */
export async function GET(request: Request): Promise<Response> {
  const trailId = new URL(request.url).searchParams.get('trailId');

  if (trailId === null || trailId.length === 0) {
    return Response.json(
      { error: 'A trailId query parameter naming one trail is required.' },
      { status: 400 },
    );
  }

  // Stands in for the latency of the upstream conditions feed this handler would really read.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, SIMULATED_REPORT_LATENCY_MS);
  });

  const report: TrailReport | null = await loadTrailReport(trailId);

  if (report === null) {
    return Response.json(
      { error: 'No conditions report is on file for that trail.' },
      { status: 404 },
    );
  }

  return Response.json(report);
}
