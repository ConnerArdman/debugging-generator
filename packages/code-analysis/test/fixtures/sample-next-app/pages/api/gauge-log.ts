/*
 * Pages Router remnant of the `sample-next-app` indexing fixture: read-only ts-morph input for
 * the @debuggen/code-analysis extractors, never installed, never built and never executed.
 *
 * It is the only module of the fixture's `pages/` tree, and it carries two signals no other file
 * in the corpus can supply:
 *
 *   1. The legacy API-route shape. Route extraction has to recognise a `pages/api/**` module
 *      whose default export *is* the route, beside the App Router modules that export one
 *      function per HTTP method from `app/api/**\/route.ts`. Without this file that half of the
 *      extractor has no input at all.
 *   2. A hybrid framework reading. Because the root `app/layout.tsx` and this module coexist,
 *      project summarisation has to report an App Router primary with a Pages Router remnant
 *      rather than one exclusive flavour. The tree is a remnant on purpose, not a second
 *      application: one legacy route is the whole of it.
 *
 * Four properties are load-bearing and must survive any edit:
 *
 *   - The file name. Route mapping resolves the URL `/api/gauge-log` to exactly this path, and
 *     the name is invented for this fixture alone, so it clashes with no App Router route here.
 *   - The default export named `handler`, which is the symbol a handler query returns for that
 *     route. It stays the only export of the module.
 *   - The single hop into `summarizeBasin` through the `@/` alias, called exactly once from
 *     inside `handler`. That call is one of exactly three call sites of that function across the
 *     corpus, and the graph assertions count them, so neither a second call here nor a helper
 *     wrapping this one may be added.
 *   - The reply through the `res` object. Returning a `Response` instead is the App Router idiom
 *     and would make this module indistinguishable from one, erasing the first signal above.
 *
 * The `next` specifier stays unresolved: nothing is installed for this tree, so the two
 * annotations below resolve to nothing and the types here are imperfect by design, which is what
 * proves the extractors read this corpus AST-first. It is imported for its types alone - a value
 * import would be unresolvable - and no suppression comment hides the state.
 *
 * Data access stays in `@/lib/station-service`, which owns every statement the corpus holds: no
 * driver handle, no SQL text and no table name appears in this file.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { summarizeBasin } from '@/lib/station-service';

/**
 * Serves the gauge rollup of one basin. A legacy handler receives no route-segment argument, so
 * the basin identifier arrives as a query parameter and is narrowed to a string before it travels
 * into the server layer; a repeated parameter reaches `req.query` as an array and is treated as
 * absent rather than guessed at.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const basinId = typeof req.query.basinId === 'string' ? req.query.basinId : '';
  const gauges = await summarizeBasin(basinId);

  res.status(200).json({ basinId, gauges });
}
