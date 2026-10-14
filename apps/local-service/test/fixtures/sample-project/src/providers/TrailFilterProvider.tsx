'use client';

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

export type TrailDifficulty = 'any' | 'easy' | 'moderate' | 'strenuous';

export type TrailSurface = 'any' | 'dry' | 'muddy' | 'snow-packed' | 'icy';

export type TrailRegion = 'any' | 'coast-range' | 'river-gorge' | 'high-desert' | 'alpine';

export interface TrailFilterValue {
  difficulty: TrailDifficulty;
  surface: TrailSurface;
  region: TrailRegion;
  openTrailsOnly: boolean;
  setDifficulty: (difficulty: TrailDifficulty) => void;
  setSurface: (surface: TrailSurface) => void;
  setRegion: (region: TrailRegion) => void;
  setOpenTrailsOnly: (openTrailsOnly: boolean) => void;
}

export interface TrailFilterProviderProps {
  children: ReactNode;
}

// `undefined` means "no provider above me", which `useTrailFilter` reports as an error.
const TrailFilterContext = createContext<TrailFilterValue | undefined>(undefined);

export function TrailFilterProvider({ children }: TrailFilterProviderProps): ReactElement {
  const [difficulty, setDifficulty] = useState<TrailDifficulty>('any');
  const [surface, setSurface] = useState<TrailSurface>('any');
  const [region, setRegion] = useState<TrailRegion>('any');
  const [openTrailsOnly, setOpenTrailsOnly] = useState(true);

  const value = useMemo<TrailFilterValue>(
    () => ({
      difficulty,
      surface,
      region,
      openTrailsOnly,
      setDifficulty,
      setSurface,
      setRegion,
      setOpenTrailsOnly,
    }),
    [difficulty, surface, region, openTrailsOnly],
  );

  return <TrailFilterContext.Provider value={value}>{children}</TrailFilterContext.Provider>;
}

export function useTrailFilter(): TrailFilterValue {
  const value = useContext(TrailFilterContext);

  if (value === undefined) {
    throw new Error('useTrailFilter must be used inside a TrailFilterProvider.');
  }

  return value;
}
