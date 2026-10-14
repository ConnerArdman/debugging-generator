'use client';

import type { ReactElement } from 'react';

import { useTrailFilter } from '@/providers/TrailFilterProvider';
import { TrailCard } from './TrailCard';

/** One board entry. `region` answers the filter here and never reaches a card. */
interface TrailSummary {
  trailId: string;
  trailName: string;
  difficulty: string;
  region: string;
  distanceKm: number;
}

/** The trails this trailhead posts. Seasonal, so a visit never changes them. */
const TRAILS: readonly TrailSummary[] = [
  {
    trailId: 'cascade-ridge',
    trailName: 'Cascade Ridge Loop',
    difficulty: 'strenuous',
    region: 'alpine',
    distanceKm: 11.8,
  },
  {
    trailId: 'larch-meadow',
    trailName: 'Larch Meadow Walk',
    difficulty: 'easy',
    region: 'high-desert',
    distanceKm: 3.1,
  },
  {
    trailId: 'juniper-saddle',
    trailName: 'Juniper Saddle Traverse',
    difficulty: 'moderate',
    region: 'river-gorge',
    distanceKm: 7.4,
  },
];

/** The board, narrowed by the filter context. `'any'` is unset and narrows nothing. */
export function TrailList(): ReactElement {
  const { difficulty, region } = useTrailFilter();

  const visibleTrails = TRAILS.filter(
    (trail) =>
      (difficulty === 'any' || trail.difficulty === difficulty) &&
      (region === 'any' || trail.region === region),
  );

  return (
    <section>
      <h1>Trails from this trailhead</h1>
      {visibleTrails.length === 0 ? <p>No trails match the current filter.</p> : null}
      {visibleTrails.map((trail) => (
        <TrailCard
          key={trail.trailId}
          trailId={trail.trailId}
          trailName={trail.trailName}
          difficulty={trail.difficulty}
          distanceKm={trail.distanceKm}
        />
      ))}
    </section>
  );
}
