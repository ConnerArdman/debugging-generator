/*
 * Dynamic-segment leaf of the `sample-next-app` indexing corpus: read-only ts-morph input for
 * the @debuggen/code-analysis extractors, never installed, never built and never executed.
 *
 * The directory this file sits in is the reason it exists. `(observatory)` is an App Router route
 * group, so route mapping has to drop that one segment from the URL while still reading the
 * `[id]` folder as a dynamic parameter: the page below resolves to `/basins/:id`, matching
 * `/basins/7` and never `/(observatory)/basins/7`. It is the corpus' only grouped route and its
 * only dynamic App Router page, so renaming either folder, flattening the group or moving the
 * default export elsewhere deletes both cases at once.
 *
 * Four further shapes are load-bearing and counted by assertions elsewhere:
 *
 *   - No client-component directive. The absence of that prologue is what classifies this module
 *     as a server component, the same signal the root `app/page.tsx` carries. Its spelling is
 *     deliberately absent from these bytes, so a text scan of the corpus cannot find it here.
 *   - Exactly one import declaration, `{ summarizeBasin }` from the path alias. It is the corpus'
 *     only hop out of the `app/` tree through that alias into a library module - the
 *     alias-plus-barrel chain belongs to `app/page.tsx` and is not duplicated here - so a
 *     relative specifier, a deep import or a second import of any kind erases the case.
 *   - Exactly one call of that function, one of exactly three call sites across the whole corpus
 *     (this page, the grouped API handler beside it and the legacy handler under `pages/`). That
 *     caller fan-out is asserted as a fixed number, so neither a second call from this body nor a
 *     local wrapper around the first may be added.
 *   - Exactly one occurrence of the `basin-drift` fixture marker, written as a standalone comment
 *     line so formatting leaves it byte-intact. The corpus holds two in total: this one and the
 *     one inside the server function it calls, which is the tally the text search asserts.
 *
 * The signature is the current App Router shape - route parameters arrive as a promise and are
 * awaited - and its props type is declared here rather than imported because nothing is installed
 * for this tree and no framework or React types resolve. For the same reason the JSX below is
 * untyped, which is precisely what proves the extractors read the corpus AST-first; no shim, no
 * ambient declaration and no suppression comment hides that state.
 *
 * Everything else stays out by design: no driver handle, no statement text and no table name -
 * data access belongs to the server layer this page calls, and that indirection is what makes the
 * chain from this page to the datastore multi-hop - and no hook, no event handler and no network
 * call, whose per-file counts belong to the client widget of the corpus.
 */

import { summarizeBasin } from '@/lib/station-service';

/**
 * Props of {@link BasinDetailPage}. Route parameters of an App Router page arrive as a promise,
 * and `id` is the basin identifier the `[id]` folder captures. Declared locally and left
 * unexported: no framework types resolve in this fixture, and the page is this module's only
 * export.
 */
interface BasinDetailPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Detail page of one basin: how many of its gauges reported samples and the drift rollup of the
 * first gauge among them. The awaited identifier is the only value handed to the server layer,
 * and the rollup is read exactly once per request.
 */
export default async function BasinDetailPage({ params }: BasinDetailPageProps) {
  const { id } = await params;

  // fixture-marker: basin-drift
  const gauges = await summarizeBasin(id);

  const leadGauge = gauges[0];

  return (
    <section>
      <h1>Basin {id}</h1>
      <p>{gauges.length} gauges reporting drift samples.</p>
      <dl>
        <dt>Lead gauge</dt>
        <dd>{leadGauge ? leadGauge.id : 'none installed'}</dd>
        <dt>Samples</dt>
        <dd>{leadGauge ? leadGauge.sample_count : '0'}</dd>
        <dt>Mean level (cm)</dt>
        <dd>{leadGauge?.mean_level_cm ?? 'no samples yet'}</dd>
      </dl>
    </section>
  );
}
