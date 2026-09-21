/*
 * Root index page of the `sample-next-app` indexing corpus: read-only ts-morph input for the
 * @debuggen/code-analysis extractors, never installed, never built, never executed.
 *
 * The single import below is the reason this file exists. It is the corpus' only specifier that
 * combines the path alias with a barrel, so it is the one place where the whole resolution chain
 * is exercised end to end:
 *
 *   '@/widgets'  ->  paths "@/*": ["./src/*"] in this tree's tsconfig.json
 *                ->  src/widgets/index.ts
 *                ->  export { default as BasinSummary } from './BasinSummary'
 *                ->  the default export of src/widgets/BasinSummary.tsx
 *
 * Weakening that specifier - a relative path, a trailing `/index`, or a deep import of the widget
 * module itself - still compiles and still renders, and silently deletes the coverage. It stays
 * exactly as written, named rather than namespaced or default, and stays the only import here.
 *
 * Sitting at `app/page.tsx` with `app/layout.tsx` beside it is also what gives `route-map.ts` the
 * `/` case, so neither the path nor the default export may move.
 *
 * Three further shapes are fixed and asserted elsewhere: no client-component directive, which is
 * what classifies this module as a server component (the pair to `src/widgets/GaugeReadout.tsx`);
 * a synchronous, data-free body - no hook, no event handler, no network call, no hop into a
 * helper or a server function, all of which belong to other files whose call counts are asserted
 * as fixed numbers; and exactly one component element in the returned JSX, so the render edge out
 * of this page counts unambiguously. The JSX is untyped because nothing is installed for this
 * tree, which is precisely what proves the extractors read the corpus AST-first.
 */

import { BasinSummary } from '@/widgets';

/** The `/` route of the corpus: a heading and the summary of one basin, rendered once. */
export default function BasinIndexPage() {
  return (
    <main>
      <h1>Basin observatory</h1>
      <BasinSummary basinId="upper-basin" primaryGaugeId="gauge-north" gaugeCount={4} />
    </main>
  );
}
