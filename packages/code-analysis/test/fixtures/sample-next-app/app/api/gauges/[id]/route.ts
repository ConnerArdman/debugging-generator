/*
 * Dynamic App Router route handler of the `sample-next-app` indexing corpus: read-only ts-morph
 * input for the @debuggen/code-analysis extractors, never installed, never built and never
 * executed.
 *
 * The directory this file sits in is the reason it exists. `[id]` is a dynamic segment and no
 * route group sits above it, so route mapping reads the served path off this location alone and
 * reads the bracketed folder as one parameter: a request naming any single identifier - `42` as
 * readily as an opaque key - resolves to the handler below. No path literal appears in this
 * module; the literals belong to the corpus' browser widget, which interpolates a gauge
 * identifier into exactly these folder names, so renaming or pluralising either of them would
 * strand that call site without touching a byte of this file.
 *
 * Four further shapes are load-bearing and counted elsewhere as fixed numbers:
 *
 *   - One method, `GET`, as a named exported function declaration and this module's only export.
 *     A default export, or an arrow assigned to an exported constant, reads as a different shape
 *     and deletes the case; the two-methods-in-one-module case belongs to the static module in
 *     the directory above, whose write handler stays there.
 *   - Exactly one import declaration, `{ listBasinGauges }` through the path alias, and exactly
 *     one call of it, on the success path rather than in a rejection branch. That call is one of
 *     exactly two across the whole corpus, so neither a second call from this body nor a local
 *     wrapper around the first may be added, and the two remaining exports of that server module
 *     stay absent here.
 *   - No network call and no client-component prologue, whose per-file counts belong to the
 *     browser widget of the corpus, and none of the text marker whose corpus-wide tally the text
 *     search asserts: both of its occurrences live in other files.
 *   - No data access. Every driver handle, statement text and table name of the corpus belongs to
 *     the server layer this handler calls, and that indirection is what keeps the chain from a
 *     browser interaction to the datastore multi-hop.
 *
 * Replies are Web-standard `Response` values typed from this tree's DOM libs, and the route
 * parameters arrive as a promise that is awaited, which is the current App Router shape. Nothing
 * is installed for this tree, so a framework specifier would resolve to nothing while adding no
 * signal, and the annotations here stay imperfect by design - precisely what proves the
 * extractors read this corpus AST-first. No shim, ambient declaration or suppression comment
 * hides that state.
 */

import { listBasinGauges } from '@/lib/station-service';

/**
 * Reply body of this route. Declared locally and left unexported: a browser reaches the route
 * over HTTP alone, so no type crosses that boundary. `basinGaugeCount` reports the page the
 * server layer resolved rather than a basin's true total, because that page carries the bound the
 * server layer applies itself.
 */
interface GaugeDetailPayload {
  gaugeId: string;
  stationLabel: string;
  basinId: string;
  basinGaugeCount: number;
}

/**
 * Serves the detail of one gauge. A dynamic segment is always populated when this module is
 * reached - an empty one matches no route at all - so the awaited identifier needs no guard
 * before it travels into the server layer, and it travels there exactly once: the only read that
 * layer exposes is basin-scoped, so this handler asks for the page filed under the captured
 * identifier and answers with the first gauge of it. An empty page is a 404 rather than an empty
 * body, because the identifier then named nothing the datastore holds. A per-gauge read would be
 * the friendlier shape and is deliberately absent: adding one would add a call site to a fan-out
 * the graph assertions count.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const gauges = await listBasinGauges(id);
  const gauge = gauges.at(0);

  if (gauge === undefined) {
    return new Response(JSON.stringify({ id, error: 'unknown gauge' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const payload: GaugeDetailPayload = {
    gaugeId: gauge.id,
    stationLabel: gauge.label,
    basinId: gauge.basinId,
    basinGaugeCount: gauges.length,
  };

  return Response.json(payload, { status: 200 });
}
