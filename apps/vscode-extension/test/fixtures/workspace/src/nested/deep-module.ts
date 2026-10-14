/**
 * Nested fixture module, one directory below the workspace's top-level module, so the
 * suites can open a multi-segment POSIX path. They find their targets by scanning this
 * text for three fixed anchor names; the rest is ordinary, import-free TypeScript.
 */

/** A stepped dial: a label prefix, inclusive lower and upper bounds, and an increment. */
export interface DialSettings {
  readonly prefix: string;
  readonly lower: number;
  readonly upper: number;
  readonly increment: number;
}

/** The dial every helper below is written against. */
export const DEEP_ANCHOR_PRIMARY: DialSettings = Object.freeze({
  prefix: 'dial',
  lower: -40,
  upper: 120,
  increment: 4,
});

/** Bounds `amount` to the dial's inclusive range; `NaN` maps to the lower bound. */
export function boundToDial(amount: number, dial: DialSettings): number {
  if (Number.isNaN(amount)) {
    return dial.lower;
  }
  return Math.min(dial.upper, Math.max(dial.lower, amount));
}

/** Joins a prefix and the non-empty parts with dashes, for example `dial-a-b`. */
export function composeDialLabel(prefix: string, parts: readonly string[]): string {
  return [prefix, ...parts].filter((part) => part.length > 0).join('-');
}

/** Labels a bounded amount on the dial, for example `dial-12`. */
export function deepAnchorMarker(amount: number, dial: DialSettings): string {
  return composeDialLabel(dial.prefix, [String(boundToDial(amount, dial))]);
}

/** Rounds `amount` to the nearest increment counted from the lower bound, within range. */
export function quantizeToIncrement(amount: number, dial: DialSettings): number {
  const bounded = boundToDial(amount, dial);
  if (!Number.isFinite(dial.increment) || dial.increment <= 0) {
    return bounded;
  }
  const steps = Math.round((bounded - dial.lower) / dial.increment);
  return boundToDial(dial.lower + steps * dial.increment, dial);
}

/**
 * Names a nesting level: level zero (or anything that is not a positive number) is
 * `outer`, levels below `depthLimit` are `middle`, and every level at or past
 * `depthLimit` shares one fixed, inert name.
 */
export function nestingLevelName(level: number, depthLimit: number): string {
  if (Number.isFinite(level) && level > 0) {
    if (level >= depthLimit) {
      return 'deep-anchor-inner';
    }
    return 'middle';
  }
  return 'outer';
}
