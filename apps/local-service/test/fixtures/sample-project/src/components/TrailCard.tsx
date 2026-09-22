'use client';

import { useState } from 'react';
import type { ReactElement } from 'react';

import { ConditionsPanel, type TrailConditionsReport } from './ConditionsPanel';

/**
 * One trail as the list above already knows it. Every field is a short scalar
 * passed straight through: `trailId` is the slug the conditions request asks
 * about, and the other three are the summary line a hiker reads first.
 */
export interface TrailCardProps {
  trailId: string;
  trailName: string;
  difficulty: string;
  distanceKm: number;
}

/**
 * Summary card for one trail, with its conditions report loaded on demand.
 *
 * Nothing is requested while the card sits on screen: a report is worth a round
 * trip only once a hiker asks for it, so the request starts in the click handler
 * and the panel appears underneath once the response has settled. The two state
 * values below are the card's whole memory — the report, and how loading went.
 */
export function TrailCard({
  trailId,
  trailName,
  difficulty,
  distanceKm,
}: TrailCardProps): ReactElement {
  const [report, setReport] = useState<TrailConditionsReport | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');

  /**
   * Loads this trail's conditions report and publishes it to the card.
   *
   * The slug is encoded rather than interpolated raw, so a slug carrying a
   * reserved character still reaches the right gate. A refused response and a
   * rejected request mean the same thing to a hiker — no report to read — so
   * both end in the error state, leaving any report already on screen alone.
   */
  async function handleShowReport(): Promise<void> {
    setStatus('loading');

    try {
      const response = await fetch(`/api/trail-report?trailId=${encodeURIComponent(trailId)}`);

      if (!response.ok) {
        setStatus('error');
        return;
      }

      const next = (await response.json()) as TrailConditionsReport;

      setReport(next);
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }

  return (
    <article>
      <h2>{trailName}</h2>
      <p>
        {difficulty}, {distanceKm} km
      </p>
      <button type="button" onClick={handleShowReport}>
        Show conditions report
      </button>
      {status === 'loading' ? <p>Reading the latest report.</p> : null}
      {status === 'error' ? <p>That report could not be loaded.</p> : null}
      {report !== null ? <ConditionsPanel report={report} /> : null}
    </article>
  );
}
