/**
 * The kiln status badge the wall-mounted tablet renders, still in plain JSX.
 *
 * Part of the same untouched corner of the studio app as the firing log beside it: the tablet
 * loads this bundle directly, so the badge and its label helper were never converted.
 */

/** Above this many minutes a firing is shown as a long one on the tablet. */
const LONG_FIRING_MINUTES = 480;

/**
 * Renders the label that goes inside a kiln's badge.
 *
 * @param {{ id: string, minutes: number }} kiln The kiln and its firing so far.
 * @returns {string} The badge label.
 */
export function formatKilnBadgeLabel(kiln) {
  if (kiln.minutes >= LONG_FIRING_MINUTES) {
    return `${kiln.id} · long firing`;
  }

  return `${kiln.id} · ${kiln.minutes}m`;
}

/**
 * The badge itself.
 *
 * @param {{ kiln: { id: string, minutes: number } }} props The kiln to show.
 * @returns {JSX.Element} The badge element.
 */
export function KilnBadge({ kiln }) {
  return <span className="kiln-badge">{formatKilnBadgeLabel(kiln)}</span>;
}
