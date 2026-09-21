/*
 * App Router API module of the `sample-next-app` indexing corpus: read-only ts-morph input for
 * the @debuggen/code-analysis extractors, never installed, never built and never executed.
 *
 * Four shapes are load-bearing here and counted elsewhere as fixed numbers:
 *
 *   - The directory, which is the URL: route mapping derives the served path from this module's
 *     location alone, so no path literal appears below. The literals belong to the browser call
 *     sites that read the route, and renaming either folder above would strand them.
 *   - Two HTTP methods in one module, which no other file of the corpus supplies. Both stay named
 *     exported function declarations and stay this module's only exports: a default export, or an
 *     arrow assigned to an exported constant, reads as a different shape and deletes the case.
 *   - One hop into the server layer per handler, on the success path rather than in a rejection
 *     branch: `listBasinGauges` from `GET`, and `recordGaugeReading` from `POST`, whose only
 *     caller in the corpus this is. Neither a second call nor a local wrapper around the first may
 *     be added, and the third export of that server module, called from the sibling trees, stays
 *     absent here.
 *   - No network call and no client-component prologue, whose per-file counts belong to the
 *     browser widget of the corpus.
 *
 * Replies are Web-standard `Response` values typed from this tree's DOM libs, because nothing is
 * installed for the fixture and a framework specifier would resolve to nothing while adding no
 * signal; no shim, ambient declaration or suppression comment hides that. Data access stays behind
 * the server layer - no handle, no statement text and no table name appears here - and that
 * indirection is what makes the chain from a browser interaction to the datastore multi-hop.
 */

import { listBasinGauges, recordGaugeReading } from '@/lib/station-service';

/**
 * Body `POST` accepts for one gauge reading. Declared locally and left unexported: a browser
 * reaches this route over HTTP alone, so no type crosses that boundary. `capturedAt` is an ISO
 * string because JSON carries no dates, and optional because a station that samples continuously
 * sends none.
 */
interface GaugeReadingPayload {
  gaugeId: string;
  levelCm: number;
  capturedAt?: string;
}

/**
 * Serves the gauges installed in one basin. The basin identifier is required and arrives as a
 * query parameter; `take` sizes the page when a caller asks for a window of its own, and a value
 * that is missing, non-numeric or out of range leaves the bound the server layer applies itself.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const basinId = params.get('basinId');
  if (basinId === null || basinId.length === 0) {
    return Response.json({ error: 'basinId is required' }, { status: 400 });
  }

  const requestedTake = Number.parseInt(params.get('take') ?? '', 10);
  const take = requestedTake > 0 && requestedTake <= 200 ? requestedTake : undefined;

  const gauges = await listBasinGauges(basinId, take);

  return Response.json({ basinId, count: gauges.length, gauges }, { status: 200 });
}

/**
 * Stores one reading of one gauge. The body is validated in plain TypeScript, because nothing is
 * installed for this tree and no schema library is reachable from it: a body that is not JSON,
 * that misses either required field or that carries an unreadable timestamp is answered with 400
 * and never reaches the server layer.
 */
export async function POST(request: Request): Promise<Response> {
  let body: Partial<GaugeReadingPayload> | null;
  try {
    body = (await request.json()) as Partial<GaugeReadingPayload> | null;
  } catch {
    return Response.json({ error: 'body must be JSON' }, { status: 400 });
  }

  if (
    body === null ||
    typeof body.gaugeId !== 'string' ||
    body.gaugeId.length === 0 ||
    typeof body.levelCm !== 'number' ||
    !Number.isFinite(body.levelCm)
  ) {
    return Response.json({ error: 'gaugeId and a finite levelCm are required' }, { status: 400 });
  }

  const capturedAt = typeof body.capturedAt === 'string' ? new Date(body.capturedAt) : undefined;
  if (capturedAt !== undefined && Number.isNaN(capturedAt.getTime())) {
    return Response.json({ error: 'capturedAt must be an ISO timestamp' }, { status: 400 });
  }

  const reading = await recordGaugeReading({
    gaugeId: body.gaugeId,
    levelCm: body.levelCm,
    capturedAt,
  });

  return Response.json({ reading }, { status: 201 });
}
