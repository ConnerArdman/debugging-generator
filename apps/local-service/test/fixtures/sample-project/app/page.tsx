/*
 * The `/` route of the `fixture-trailhead-guide` corpus: read-only ts-morph input for the
 * apps/local-service integration suites, never installed, never built, never executed.
 *
 * Its value here is structural. Sitting at `app/page.tsx` beside `app/layout.tsx` is what makes
 * this tree App-Router-shaped, which is what framework classification and the Next.js adapter's
 * readiness check look for, and it is what gives the route map its `/` entry — so neither the
 * path nor the default export below may move.
 *
 * Two further shapes are deliberate. There is no client-component directive, so this module
 * classifies as a server component that renders a client one: the canonical App Router
 * composition, and the counterpart to `src/components/TrailList.tsx`, which does declare the
 * directive. And the body is synchronous and data-free — no hook, no event handler, no request
 * and no reach into a server module. The filter a hiker sets lives in the provider the layout
 * mounts, the trail board belongs to `TrailList`, and a conditions report is fetched by the card
 * that shows it, so this page keeps no state and hands down no props.
 */

import type { ReactElement } from 'react';

import { TrailList } from '@/components/TrailList';

/** The `/` route: this trailhead's conditions board, rendered once. */
export default function TrailConditionsPage(): ReactElement {
  return (
    <main>
      <h1>Trail conditions</h1>
      <TrailList />
    </main>
  );
}
