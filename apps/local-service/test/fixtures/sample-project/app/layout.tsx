import type { Metadata } from 'next';
import type { ReactElement, ReactNode } from 'react';

import { TrailFilterProvider } from '@/providers/TrailFilterProvider';

/**
 * Document metadata for every route in this App Router app.
 *
 * One field is all a trail-conditions viewer needs: the tab title names the
 * app, and nothing else about the document is worth stating twice.
 */
export const metadata: Metadata = {
  title: 'Trailhead Guide',
};

interface TrailheadGuideLayoutProps {
  children: ReactNode;
}

/**
 * Root layout of the Trailhead Guide.
 *
 * It is a server component — it declares no client directive of its own — that
 * mounts the one client provider the app needs. `TrailFilterProvider` owns
 * the difficulty, surface, region and open-gate filters, and it sits here rather
 * than in a page so a filter choice survives navigation between trailheads
 * instead of resetting whenever a route unmounts.
 *
 * Everything else a trail page renders is that page's concern, so the layout
 * adds no chrome around `children`.
 */
export default function TrailheadGuideLayout({
  children,
}: TrailheadGuideLayoutProps): ReactElement {
  return (
    <html lang="en">
      <body>
        <TrailFilterProvider>{children}</TrailFilterProvider>
      </body>
    </html>
  );
}
