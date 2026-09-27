/**
 * The duration primitive: one measured millisecond value, formatted once and
 * coloured by how slow it is (AAP 0.6.2, 0.6.3).
 *
 * THE SINGLE VISUAL HOME OF DURATION SEVERITY
 * A debugging tool earns its keep by answering "where did the time go", so the
 * one thing a reader must be able to trust across a whole panel is that a
 * number shown in the alarming colour is slower than a number shown in the
 * muted one — in every table, every tooltip and every card of the same capture.
 * That guarantee exists only if exactly one component decides it, which is this
 * one. No other component in this package may colour a duration itself: the
 * text primitive deliberately carries no duration tone, and a visualization
 * that wants an emphasised span asks `../utils/color` for a token rather than
 * inventing a scale of its own. Every duration the product renders — span
 * durations in the span table, the timeline and the flame and waterfall
 * tooltips, per-component render time, query time, request time and the tier
 * totals behind the metric cards — comes through here.
 *
 * SEVERITY IS IMPORTED, NEVER RE-DERIVED
 * The four steps (`fast`, `normal`, `slow`, `critical`) and the boundaries
 * between them belong to `../utils/color`: `durationSeverity` is the rule, and
 * `DURATION_NORMAL_THRESHOLD_MS`, `DURATION_SLOW_THRESHOLD_MS` and
 * `DURATION_CRITICAL_THRESHOLD_MS` are the exact boundaries that open the
 * `normal`, `slow` and `critical` steps respectively (AAP 0.6.3 fixes all
 * three; each interval is half-open, so a value exactly on a boundary belongs
 * to the slower step). Those numbers are deliberately NOT restated in this file
 * — not in code and not in this comment. A second copy is precisely how a
 * design system starts lying: one table would call a value "slow" while another
 * called the same value "critical", and nothing would fail. Importing the rule
 * instead means a step added or re-bounded upstream is a compile error in the
 * variant map below rather than a silently uncoloured column.
 *
 * FORMATTING IS IMPORTED TOO
 * The text comes from `formatDuration` in `../utils/format`, which owns unit
 * selection (microseconds, milliseconds, seconds) and the fixed decimal places
 * that keep a column of numbers aligned. This file performs no rounding, no
 * unit choice and no suffix concatenation of its own, so a value cannot read
 * differently in a cell than in the tooltip describing the same span.
 *
 * AN UNMEASURED VALUE SAYS SO (AAP 0.6.6)
 * Some quantities are genuinely unobservable — the gaps inventory names
 * transferred bytes for a server span as one — and a debugging tool that
 * printed `0` for "not measured" would be asserting something false about the
 * capture. An absent value therefore renders `NOT_AVAILABLE_LABEL` from
 * `../utils/format`, the package's single spelling of that claim, carries the
 * `dg-is-unavailable` state class and carries NO severity variant: nothing was
 * measured, so nothing can be fast or critical. It is never an empty cell
 * (which reads as a rendering bug), never `0`, and never a thrown error — this
 * component renders inside thousands of rows and an exception in one cell must
 * not take a panel down.
 *
 * EXACTLY ONE ELEMENT, AND WHY IT IS NOT BUILT ON `Text`
 * The output is a single `<span>`. Composing the text primitive around the
 * value would double the element count of every duration column, and a
 * virtualized table renders these by the thousand: the extra node buys no
 * semantics (the severity classes already carry the type role and the colour)
 * and costs layout on exactly the surfaces where scrolling has to stay smooth.
 * This is a considered density decision, not an oversight — see the class
 * contract below for how the same tokens are reached without the wrapper.
 *
 * NO AUTOMATIC `title`
 * This component never invents a tooltip. A precise value on hover is a
 * caller's decision, because only the caller knows whether the cell is already
 * showing full precision: pass `title` through the rest props, or wrap the cell
 * in the tooltip primitive when the hint needs to be styled and announced.
 *
 * APPEARANCE IS A CLASS CONTRACT, NEVER AN INLINE STYLE (AAP 0.6.4)
 * This file declares the class names; `../styles/components.css` implements
 * them against the tokens. Nothing here sets a colour, a length, a font or an
 * inline style, and there is no literal CSS value in this file at all:
 *
 *   `dg-duration-cell`             the base: inline-block, aligned to the
 *                                  inline end, `--dg-font-mono` with
 *                                  `font-variant-numeric: tabular-nums`
 *   `dg-duration-cell--md`         the `--dg-mono-md` type role
 *   `dg-duration-cell--sm`         the `--dg-mono-sm` type role
 *   `dg-duration-cell--fast`       colour `--dg-duration-fast`
 *   `dg-duration-cell--normal`     colour `--dg-duration-normal`
 *   `dg-duration-cell--slow`       colour `--dg-duration-slow`
 *   `dg-duration-cell--critical`   colour `--dg-duration-critical`
 *   `dg-is-unavailable`            the unmeasured state
 *
 * The four duration tokens are theme-level aliases (muted text, primary text,
 * warning, danger), so a theme re-points a step without this file changing.
 *
 * ACCESSIBILITY
 * Colour is emphasis here and never the only carrier of meaning: the number
 * itself states the magnitude, in tabular figures so that two rows can be
 * compared by eye, and the unmeasured case is spelled out in words. No `role`
 * and no `aria-label` is invented — the element's own text is the best name it
 * could have — and a caller that needs one passes it through the rest props.
 *
 * LAYERING
 * Tier 4 of this folder: it imports `react` types, `clsx` and the two `utils`
 * modules, and nothing else. No workspace package, no `../layout`,
 * `../components` or `../host`, and no notion of a panel, a query, a transport
 * or a session — the duration arrives as a plain number.
 *
 * RENDER BEHAVIOUR
 * A plain function component: no `memo`, no `forwardRef`, no state, no effects,
 * no context and nothing read from the document while rendering. Its output is
 * a pure function of its props, which is what makes it safe at the row counts
 * described above.
 */

import { roundMs } from '@debuggen/shared';
import clsx from 'clsx';
import type { HTMLAttributes, ReactElement, Ref } from 'react';

import { durationSeverity, type DurationSeverity } from '../utils/color';
import { formatDuration, NOT_AVAILABLE_LABEL } from '../utils/format';

/**
 * The two monospace type roles a duration may be set in, and deliberately the
 * only two: `md` resolves to `--dg-mono-md` and `sm` to `--dg-mono-sm`
 * (AAP 0.6.3). There is no third monospace role in the token table, so a caller
 * asking for something denser is asking for a token that does not exist.
 */
export type DurationCellSize = 'md' | 'sm';

/**
 * What the cell's colour is driven by.
 *
 * The four measured steps come from `../utils/color`, so this union widens
 * automatically if the scale ever gains a step — and the variant map below then
 * fails to compile until the new step has a class. The two extra members are
 * modes rather than steps:
 *
 * - `'auto'` — derive the step from the value itself (the default, and what
 *   every data cell wants);
 * - `'none'` — render the value with no severity colour at all, for a total or
 *   subtotal row where colouring an aggregate would invite a comparison the
 *   number does not support.
 */
export type DurationCellSeverity = DurationSeverity | 'auto' | 'none';

/**
 * Severity step to variant class.
 *
 * A total `Record` over the imported union rather than a name built by
 * interpolation: interpolation would accept any string at the type level, would
 * hide a typo until the column rendered uncoloured in a browser, and would make
 * these class names invisible to a grep of the stylesheet. Being total also
 * means the lookup below yields `string` under `noUncheckedIndexedAccess`, so
 * it needs no fallback and no non-null assertion — and a step added to
 * `DurationSeverity` upstream is a compile error here, which is the whole
 * reason this file imports the scale instead of describing it.
 */
const SEVERITY_CLASS: Readonly<Record<DurationSeverity, string>> = {
  fast: 'dg-duration-cell--fast',
  normal: 'dg-duration-cell--normal',
  slow: 'dg-duration-cell--slow',
  critical: 'dg-duration-cell--critical',
};

/** Type role to variant class; total over {@link DurationCellSize}. */
const SIZE_CLASS: Readonly<Record<DurationCellSize, string>> = {
  md: 'dg-duration-cell--md',
  sm: 'dg-duration-cell--sm',
};

/**
 * Whether a duration was actually measured and may therefore be rendered as a
 * number.
 *
 * Four kinds of input fail this test, each for a stated reason:
 *
 * - `null` and `undefined` — the field was absent from the aggregate, which is
 *   the ordinary shape of an unobservable quantity (AAP 0.6.6);
 * - `NaN` — an arithmetic result with no meaning, typically a subtraction
 *   against a timestamp that never arrived;
 * - `Infinity` and `-Infinity` — no finite measurement exists;
 * - a negative value — a duration cannot be negative, so a negative number is
 *   a corrupt measurement rather than a fast one, and reporting it as the
 *   fastest possible one would be the single most misleading thing this
 *   component could do. The test is the one `formatDuration` applies —
 *   negative at the stored resolution, `roundMs(ms) < 0` — so a cell and every
 *   other surface that formats the same value agree on which values are
 *   measured.
 *
 * Zero passes, and so does a negative residue that rounds to zero at the stored
 * resolution (`-0.0004`, the difference of two readings of one instant): a real
 * operation that completed inside the stored resolution is measured, and the
 * formatter renders it in the canonical unit.
 */
function isMeasuredDuration(ms: number | null | undefined): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && roundMs(ms) >= 0;
}

/**
 * The severity step a measured value is drawn in, or `undefined` for no
 * severity variant at all.
 *
 * A function rather than an expression inside the component so that the
 * three-way choice reads as one: derive the step from the measurement, take the
 * caller's step, or decline to colour. It is only ever called with a measured
 * value — the unmeasured case never reaches a step, because nothing was
 * measured to be fast or critical.
 *
 * @param ms A measured duration in milliseconds; see {@link isMeasuredDuration}.
 * @param severity The mode or explicit step from the props.
 */
function resolveSeverityStep(
  ms: number,
  severity: DurationCellSeverity,
): DurationSeverity | undefined {
  if (severity === 'none') {
    return undefined;
  }
  return severity === 'auto' ? durationSeverity(ms) : severity;
}

/**
 * Props of {@link DurationCell}.
 *
 * Every remaining attribute of a `<span>` is accepted and forwarded — `title`
 * (the precise value behind a rounded one), `id`, `aria-label`, `data-*` hooks
 * for tests, `onClick` when the cell sits inside a row that selects its event.
 * `children` is removed from that inherited set: the content of this element is
 * the formatted duration and nothing else, so a caller cannot half-replace it.
 *
 * Every optional property states `| undefined` explicitly, because
 * `exactOptionalPropertyTypes` is in force repository-wide and these values are
 * routinely computed from the data being rendered.
 */
export interface DurationCellProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /**
   * The duration, in milliseconds — the canonical unit of every telemetry
   * event (AAP 0.2.3), so no other unit is accepted and no conversion happens
   * at the call site.
   *
   * Required, and required as a nullable type on purpose: an aggregate that
   * could not measure a quantity reports it as absent, and making the caller
   * pass that absence through (rather than substituting a zero before it gets
   * here) is what lets this component render the not-available label instead of
   * a false number. See {@link isMeasuredDuration} for the exact set of values
   * treated as unmeasured.
   */
  ms: number | null | undefined;

  /**
   * What drives the colour.
   *
   * `'auto'` (the default) resolves the step from `ms` through the severity
   * rule of `../utils/color`; `'none'` renders the value with no severity
   * variant; an explicit step overrides both, for the rare caller that is
   * colouring by a judgement the value alone cannot express — a share of a
   * total, say, rather than an absolute duration.
   *
   * The four steps resolve to the theme's duration aliases: `fast` to
   * `--dg-duration-fast` (muted text), `normal` to `--dg-duration-normal`
   * (primary text), `slow` to `--dg-duration-slow` (warning) and `critical` to
   * `--dg-duration-critical` (danger).
   *
   * Ignored when the duration was not measured: an unmeasured value carries the
   * unavailable state and no severity variant, whatever is passed here.
   *
   * @default 'auto'
   */
  severity?: DurationCellSeverity | undefined;

  /**
   * Which monospace type role to set the value in: `md` (`--dg-mono-md`) for a
   * value read on its own or beside body copy, `sm` (`--dg-mono-sm`) for a
   * dense row where the surrounding text is already at its smallest.
   *
   * @default 'md'
   */
  size?: DurationCellSize | undefined;

  /**
   * Extra classes, appended after the base, size and severity variants so a
   * consumer can position the cell inside its own grid or table layout without
   * touching this component's appearance.
   */
  className?: string | undefined;

  /**
   * Ref to the rendered `<span>` — the component's only element. A plain prop,
   * as React 19 passes it: this component is not wrapped in `forwardRef`.
   */
  ref?: Ref<HTMLSpanElement> | undefined;
}

/**
 * Renders a duration.
 *
 * @param props See {@link DurationCellProps}.
 * @returns One `<span>` carrying the formatted value, or the not-available
 * label when the duration was not measured.
 *
 * @example
 * // A data cell: the value colours itself.
 * <DurationCell ms={span.duration} />
 *
 * @example
 * // A dense row that shows full precision on hover, with the caller's own
 * // tooltip text rather than an invented one.
 * <DurationCell ms={stat.totalMs} size="sm" title={`${stat.count} renders`} />
 *
 * @example
 * // A total row: the number is the sum of coloured rows above it, so colouring
 * // it again would invite a comparison it does not support.
 * <DurationCell ms={summary.totalMs} severity="none" />
 *
 * @example
 * // An unobservable quantity renders the not-available label (AAP 0.6.6).
 * <DurationCell ms={null} />
 */
export function DurationCell(props: DurationCellProps): ReactElement {
  const { ms, severity = 'auto', size = 'md', className, ref, ...rest } = props;

  // One narrowing, used by both the classes and the text: `undefined` means the
  // duration was not measured. Zero survives it, because zero is a measurement.
  const measuredMs = isMeasuredDuration(ms) ? ms : undefined;

  // An unmeasured value takes no severity variant at all, and `'none'` is the
  // caller asking for the same thing, so both arrive here as `undefined` and
  // the single `clsx` call below needs no second branch.
  const step = measuredMs === undefined ? undefined : resolveSeverityStep(measuredMs, severity);

  return (
    <span
      className={clsx(
        'dg-duration-cell',
        SIZE_CLASS[size],
        step === undefined ? undefined : SEVERITY_CLASS[step],
        measuredMs === undefined && 'dg-is-unavailable',
        className,
      )}
      ref={ref}
      {...rest}
    >
      {measuredMs === undefined ? NOT_AVAILABLE_LABEL : formatDuration(measuredMs)}
    </span>
  );
}
