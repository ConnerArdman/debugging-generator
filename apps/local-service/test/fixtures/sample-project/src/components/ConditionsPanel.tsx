import type { ReactElement } from 'react';

/**
 * Client-tier view of the JSON body returned by `GET /api/trail-report`.
 *
 * The browser reaches the server tier only over HTTP, so this shape is declared
 * next to the component that renders it instead of being imported across the
 * boundary. It stays flat and serialisable: one short scalar per field, with
 * `snowLineMeters` nullable because a gate volunteer files a report whether or
 * not anyone measured the snow line that morning.
 */
export interface TrailConditionsReport {
  trailId: string;
  trailName: string;
  surface: string;
  gateStatus: 'open' | 'closed' | 'seasonal';
  snowLineMeters: number | null;
  /** ISO-8601 timestamp of the observation. */
  observedAt: string;
  /** One short sentence describing what the volunteer saw. */
  summary: string;
}

export interface ConditionsPanelProps {
  report: TrailConditionsReport;
}

/**
 * Presentational panel for a single trail-conditions observation.
 *
 * It owns no state, runs no effect and issues no request of its own: the card
 * above it loads the report and hands it down, so the panel re-renders only
 * when that prop changes.
 */
export function ConditionsPanel({ report }: ConditionsPanelProps): ReactElement {
  const snowLine = report.snowLineMeters === null ? 'not reported' : `${report.snowLineMeters} m`;

  return (
    <section>
      <h3>Conditions for {report.trailName}</h3>
      <dl>
        <dt>Surface</dt>
        <dd>{report.surface}</dd>
        <dt>Gate</dt>
        <dd>{report.gateStatus}</dd>
        <dt>Snow line</dt>
        <dd>{snowLine}</dd>
        <dt>Observed</dt>
        <dd>
          <time dateTime={report.observedAt}>{report.observedAt}</time>
        </dd>
      </dl>
      <p>{report.summary}</p>
    </section>
  );
}
