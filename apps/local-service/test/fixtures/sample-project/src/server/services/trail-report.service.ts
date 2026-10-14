/**
 * Reading a trailhead's posted trail conditions.
 *
 * Gate volunteers file their observations one at a time, so what a hiker reads is a fold rather
 * than a row: this module loads every report on file for one trail and reduces them, together with
 * the state of the trailhead's gate, to the handful of values a summary line carries.
 *
 * Statements live in the data-access module beside this one, so nothing here assembles or issues a
 * query of its own.
 */

import {
  queryTrailConditionReports,
  queryTrailheadGateStatus,
  type TrailConditionReportRow,
} from '@/server/db/pool';

/** The surfaces a volunteer can report, ordered from the easiest to walk to the most limiting. */
const SURFACES_BY_SEVERITY: readonly string[] = ['dry', 'muddy', 'snow-packed', 'icy'];

/**
 * How limiting a reported surface is, as a rank within {@link SURFACES_BY_SEVERITY}.
 *
 * A surface with no rank of its own counts as more limiting than every known one: a guide that
 * cannot read what a volunteer wrote should not quietly call the walking easy.
 *
 * @param surface The surface as a report spells it.
 * @returns The rank, higher being more limiting.
 */
function surfaceSeverity(surface: string): number {
  const rank = SURFACES_BY_SEVERITY.indexOf(surface);

  return rank === -1 ? SURFACES_BY_SEVERITY.length : rank;
}

/**
 * Every condition report on file for one trail.
 *
 * The rows keep the database's own spelling rather than being renamed on the way through: the
 * summary below folds them and the route above maps whatever a browser needs, so no tier in
 * between has to invent a third naming.
 */
export interface TrailReport {
  /** The trail's slug, as the request asked for it. */
  trailId: string;
  /** The reports filed for that trail, newest observation first. */
  conditionReports: TrailConditionReportRow[];
}

/**
 * What a trail's reports and its gate add up to for someone setting out.
 *
 * Counts and extremes rather than the reports themselves, because a board shows one line per
 * trail. A field is `null` wherever nothing on file settles it.
 */
export interface TrailConditionsSummary {
  /** The trail the summary describes. */
  trailId: string;
  /** How many reports the summary folded. */
  reportCount: number;
  /** How many reports named each surface, keyed by the surface as they spell it. */
  reportsBySurface: Record<string, number>;
  /** The most limiting surface anyone reported, or `null` when no report names one. */
  limitingSurface: string | null;
  /** The deepest snow any report measured, in centimetres; `0` when none found snow. */
  deepestSnowDepthCm: number;
  /** The lowest snow line any report measured, in metres, or `null` when none measured it. */
  lowestSnowLineMeters: number | null;
  /** The freshest observation on file, or `null` when there are no reports. */
  latestObservedAt: Date | null;
  /** The gate state a ranger last reported, or `null` when none has. */
  gateState: string | null;
  /** When that gate check happened, or `null` when there has been none. */
  gateCheckedAt: Date | null;
  /** The verdict a hiker reads first. */
  passability: 'clear' | 'caution' | 'blocked';
}

/**
 * Loads the condition reports on file for one trail.
 *
 * A trail nobody has reported on reads the same as a trail this trailhead does not post, and both
 * answer `null` so the caller can say so instead of showing an empty board.
 *
 * @param trailId The trail's slug.
 * @returns The trail's reports, or `null` when none are on file.
 */
export async function loadTrailReport(trailId: string): Promise<TrailReport | null> {
  const conditionReports = await queryTrailConditionReports([trailId]);

  if (conditionReports.length === 0) {
    return null;
  }

  return { trailId, conditionReports };
}

/**
 * Folds a trail's reports, and the state of its gate, into the summary a board prints.
 *
 * The reports are reduced in one pass — how many named each surface, the most limiting surface
 * among them, the deepest snow and the lowest snow line anyone measured, and the freshest
 * observation. Extremes are taken rather than trusted from the order the reports arrive in, so the
 * summary keeps its meaning if that order ever changes.
 *
 * The gate is read afterwards because the verdict needs both halves: a gate a ranger reports as
 * shut settles the question whatever the walking is like, a gate nobody has checked leaves the way
 * unconfirmed, and an open gate comes down to how limiting the surfaces underfoot are.
 *
 * @param report The trail's reports, as loaded above.
 * @returns The folded summary.
 */
export async function summarizeConditions(report: TrailReport): Promise<TrailConditionsSummary> {
  const reportsBySurface: Record<string, number> = {};
  let limitingSurface: string | null = null;
  let limitingSeverity = -1;
  let deepestSnowDepthCm = 0;
  let lowestSnowLineMeters: number | null = null;
  let latestObservedAt: Date | null = null;

  for (const row of report.conditionReports) {
    reportsBySurface[row.surface] = (reportsBySurface[row.surface] ?? 0) + 1;

    const severity = surfaceSeverity(row.surface);

    if (severity > limitingSeverity) {
      limitingSeverity = severity;
      limitingSurface = row.surface;
    }

    if (row.snow_depth_cm > deepestSnowDepthCm) {
      deepestSnowDepthCm = row.snow_depth_cm;
    }

    // A missing measurement is a gap in a report rather than a snow line of zero, so it is passed
    // over instead of being folded in as the lowest one anybody saw.
    if (row.snow_line_meters !== null) {
      if (lowestSnowLineMeters === null || row.snow_line_meters < lowestSnowLineMeters) {
        lowestSnowLineMeters = row.snow_line_meters;
      }
    }

    if (latestObservedAt === null || row.observed_at.getTime() > latestObservedAt.getTime()) {
      latestObservedAt = row.observed_at;
    }
  }

  const gate = await queryTrailheadGateStatus(report.trailId);
  const gateState = gate === null ? null : gate.gate_state;

  let passability: TrailConditionsSummary['passability'] = 'clear';

  if (gateState !== null && gateState !== 'open') {
    // Whatever the gate is if it is not open — shut for the season, shut for a washout — a hiker
    // cannot get past it.
    passability = 'blocked';
  } else if (gateState === null || limitingSurface === null) {
    // An unchecked gate, or a trail whose reports name no surface, leaves the way unconfirmed.
    passability = 'caution';
  } else if (limitingSeverity > surfaceSeverity('muddy')) {
    // Mud is ordinary footwear's business; anything more limiting wants traction underfoot.
    passability = 'caution';
  }

  return {
    trailId: report.trailId,
    reportCount: report.conditionReports.length,
    reportsBySurface,
    limitingSurface,
    deepestSnowDepthCm,
    lowestSnowLineMeters,
    latestObservedAt,
    gateState,
    gateCheckedAt: gate === null ? null : gate.checked_at,
    passability,
  };
}
