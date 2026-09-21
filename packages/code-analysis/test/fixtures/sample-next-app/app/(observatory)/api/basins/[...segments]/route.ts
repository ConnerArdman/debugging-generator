/*
 * Catch-all API module of the `sample-next-app` indexing corpus, and the only file of its subtree:
 * read-only ts-morph input for the @debuggen/code-analysis extractors, never installed, never
 * built and never executed.
 *
 * The directory this file sits in is the whole reason it exists, because it is the one place in
 * the corpus where two App Router path features meet:
 *
 *   - `(observatory)` is a route group, so route mapping has to drop that one segment from the
 *     served URL while still reading every folder below it.
 *   - `[...segments]` is a catch-all parameter, so the same mapping has to keep matching however
 *     many path segments follow the prefix and hand all of them to the handler at once.
 *
 * Together they fix this module at `/api/basins/...`: a request for `/api/basins/north/deep`
 * reaches the handler below with two captured segments, and no grouped folder ever appears in that
 * path. The grouped page beside it holds the single-dynamic-segment case and sits under no `api`
 * folder, so renaming a folder above, flattening the group or narrowing the catch-all to a single
 * parameter deletes the corpus' only instance of this pairing. No path literal appears below: the
 * location alone is the URL.
 *
 * Four further shapes are load-bearing and counted elsewhere as fixed numbers:
 *
 *   - One named exported async function declaration, `GET`, which stays this module's only export.
 *     A default export, or an arrow assigned to an exported constant, reads as a different shape
 *     to route extraction and deletes the case - the same rule the ungrouped handlers of the
 *     corpus follow.
 *   - The current App Router signature: route parameters arrive as a promise and are awaited
 *     before the captured segments spell the basin key. The request parameter stays declared and
 *     unused, because a rollup addressed entirely by its path reads nothing from the message
 *     itself, and no suppression comment, shim or ambient declaration hides that.
 *   - Exactly one hop into the server layer - `summarizeBasin`, through the path alias, on the
 *     success path - which is one of exactly three call sites of that function across the whole
 *     corpus: this handler, the grouped page beside it and the legacy handler under `pages/`. That
 *     fan-in is asserted as a fixed number, so neither a second call from this body nor a local
 *     wrapper around the first may be added, and the two sibling exports of that server module,
 *     whose callers are the ungrouped gauge handlers, stay absent here.
 *   - No network call, no client-component prologue and no drift marker: those per-file counts
 *     belong to other files of the corpus, and this one holds none of them.
 *
 * Replies are Web-standard `Response` values typed from this tree's DOM libs, because nothing is
 * installed for the fixture and a framework specifier would resolve to nothing while adding no
 * signal. Data access stays behind the server layer - no driver handle, no statement text and no
 * table name appears here - and that indirection is what makes the chain from this route to the
 * datastore multi-hop.
 */

import { summarizeBasin } from '@/lib/station-service';

/**
 * Body this route replies with: the basin key the captured segments spell, those segments as they
 * arrived so a caller can tell which basin it addressed, and how many of that basin's gauges
 * reported drift samples together with which ones they are. Declared locally and left unexported -
 * a browser reaches this route over HTTP alone, so no type crosses that boundary, and `GET` stays
 * this module's only export.
 */
interface BasinDriftReport {
  basin: string;
  segments: string[];
  gaugeCount: number;
  gaugeIds: string[];
}

/**
 * Serves the drift rollup of one basin addressed by however many segments follow the prefix:
 * `north` alone names a basin and `north/deep` narrows it to a sub-basin, so the captured segments
 * are joined back into the single key the server layer reads. A capture holding no segment at all
 * addresses no basin and is answered with 400 rather than travelling into that layer.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ segments: string[] }> },
): Promise<Response> {
  const { segments } = await context.params;

  if (segments.length === 0) {
    return Response.json({ error: 'at least one basin segment is required' }, { status: 400 });
  }

  const basinKey = segments.join('/');
  const gauges = await summarizeBasin(basinKey);

  const report: BasinDriftReport = {
    basin: basinKey,
    segments,
    gaugeCount: gauges.length,
    gaugeIds: gauges.map((gauge) => gauge.id),
  };

  return Response.json(report, { status: 200 });
}
