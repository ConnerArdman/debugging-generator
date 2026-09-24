/**
 * `LoadingState` — the busy placeholder of `@debuggen/panel-renderer`.
 *
 * ## Why this primitive is structural, not decorative
 *
 * Every catalogued visualization component in this package has exactly three
 * structural states, and AAP 0.6.2 names the renderer of each one: empty
 * (`EmptyState`), loading (`LoadingState` — "skeleton while `DataProvider`
 * resolves") and error (`ErrorState`). The loading state is not an edge case
 * here: a node reaches its data by resolving its `DataQuery` through
 * `host/useQuery` against a `DataProvider` that crosses a process boundary, so
 * every panel node is unresolved for a moment on the normal path and something
 * has to occupy its box while it is.
 *
 * The failure mode this component exists to prevent is layout thrash. A
 * generated panel is a layout of independent nodes, each with its own query; if
 * an unresolved node collapsed to nothing, every later arrival would shove the
 * nodes below it down the surface, and a developer reading the first result
 * would lose their place several times before the panel settled. A skeleton
 * sized to its container keeps each node's box the size the resolved content
 * will need, so arrivals paint in place instead of reflowing the panel.
 *
 * ## Tier 3 composite
 *
 * It composes exactly one thing from this package — the `Text` primitive, for
 * the label below — and imports nothing else from it: no layout primitive, no
 * visualization component, no host module, no panel schema and no transport.
 * It is presentational to the point of ignorance: it knows how many bars to
 * draw and which variant to draw them as, and nothing at all about what is
 * loading, which query is in flight, or how long it has been running.
 *
 * ## The three variants
 *
 * A placeholder that looks nothing like its content is its own kind of jarring,
 * so the variant chooses the silhouette while the stylesheet supplies the
 * geometry:
 *
 * | Variant   | Silhouette                  | Component families that use it              |
 * | --------- | --------------------------- | ------------------------------------------- |
 * | `'rows'`  | a stack of horizontal bars  | the row-shaped views: data tables, the span, |
 * |           | (the default)               | render, request and query tables, the event  |
 * |           |                             | log, the state-transition rows, trees        |
 * | `'block'` | one solid filled area       | metric card groups and any other single      |
 * |           |                             | uninterrupted surface                        |
 * | `'chart'` | one wide plotting area      | the SVG views: timeline, waterfall,          |
 * |           |                             | flame-style hierarchy, dependency graph      |
 *
 * ## Live regions: the division of labour across the three states
 *
 * This component owns the busy announcement — `role="status"`,
 * `aria-live="polite"`, `aria-busy="true"` — so a screen-reader user is told
 * that a region is working rather than being left with a silent gap. The other
 * two are deliberately different and must stay that way: `EmptyState` is the
 * settled polite `role="status"` without `aria-busy`, which tells the reader
 * what the load resolved to ("nothing was captured") without ever interrupting
 * them, and `ErrorState` announces a failure — assertively with `role="alert"`
 * for the first failure of a burst and politely with `role="status"` for the
 * rest, as the query layer decides. Only the busy flag tells a working region
 * from a settled one, and only the one alert interrupts, which is what keeps a
 * surface resolving eight queries from talking over itself.
 *
 * The announcement is text-only: the skeleton bars are `aria-hidden` decoration
 * with no accessible name, and the label is rendered into the accessibility
 * tree through the shared `dg-visually-hidden` utility so nothing about it is
 * painted. Its spelling is normalised here — trimmed, and ending in a single
 * `…` — so every busy region announces itself the same way whoever wrote its
 * label (see {@link LoadingStateProps.label}).
 *
 * ## Motion, and why none of it is here
 *
 * The shimmer is a CSS animation and stays one. Its timing comes from the
 * motion design tokens — `--dg-shimmer-duration` for one sweep of a skeleton,
 * `--dg-motion-duration` and `--dg-motion-easing` for state feedback — which
 * `../tokens/tokens.ts` declares and `../styles/components.css` consumes, while
 * `../styles/base.css` carries the single `@media (prefers-reduced-motion:
 * reduce)` block in the package, which suppresses animation everywhere with the
 * one sanctioned `!important`. So this module declares no duration, starts no
 * animation, reads no media query and branches on no motion preference:
 * honouring the preference is a cascade fact, and a JavaScript gate here would
 * be a second, weaker copy of a rule that already holds (AAP 0.6.3, 0.6.4).
 *
 * ## Two things this component deliberately does not do
 *
 * 1. **No delay.** There is no "appear only after N milliseconds" timer, and no
 *    state, effect, interval or hook of any kind — the component is pure output
 *    of its props. A consumer that wants to suppress a flash of skeleton for a
 *    query that resolves in a few milliseconds implements that where the query
 *    lifecycle is actually known, in `host/useQuery`, by not asking for a
 *    loading state yet. Putting it here would hide the timing decision inside a
 *    primitive that cannot see the query, and would make the busy announcement
 *    fire on a schedule no caller could observe.
 * 2. **No geometry.** No width, height, minimum height, aspect ratio or inline
 *    style is written in this file. "Sized to its container" is achieved by the
 *    component layer filling the available box with relational values, never by
 *    measuring anything at render time (AAP 0.6.4).
 *
 * ## Class-name contract declared by this file (AAP 0.6.3, 0.6.4)
 *
 * The rules behind these names are implemented in `../styles/components.css`;
 * this file contributes class names and nothing else.
 *
 * | Class                       | Role                                        |
 * | --------------------------- | ------------------------------------------- |
 * | `dg-loading-state`          | block: the placeholder region                |
 * | `dg-loading-state--rows`    | variant: the stacked-bar silhouette          |
 * | `dg-loading-state--block`   | variant: the solid-area silhouette           |
 * | `dg-loading-state--chart`   | variant: the plotting-area silhouette        |
 * | `dg-loading-state__row`     | element: one skeleton bar                    |
 * | `dg-skeleton`               | the shared shimmer treatment, reusable by    |
 * |                             | any other component that needs one           |
 *
 * `dg-skeleton` is intentionally a free-standing class rather than part of the
 * block: a virtualized table that wants shimmering cells while it pages, or a
 * chip awaiting a resolved source location, reuses the treatment without
 * pulling in this component's layout.
 *
 * `dg-visually-hidden` is reused from `../styles/base.css` and is never
 * redefined here, like every other global utility of that layer.
 *
 * Tokens those rules resolve to, and the only values this placeholder may take:
 * `--dg-surface-elevated` and `--dg-surface-overlay` for the bar fill and the
 * sweep that crosses it, `--dg-border-subtle` for any hairline the silhouette
 * needs, `--dg-space-*` for the gap between bars and the padding around them,
 * and `--dg-radius-sm` for their corners. Every one of the three themes
 * defines all five, so the placeholder follows `data-theme` with no rule of its
 * own.
 */

import clsx from 'clsx';
import type { HTMLAttributes, ReactElement } from 'react';

import { Text } from './Text';

/**
 * The silhouette of the placeholder.
 *
 * `'rows'` is the default because the row-shaped views outnumber the rest;
 * `'block'` is a single solid surface; `'chart'` is the plotting area the SVG
 * views occupy. There is deliberately no fourth value: a silhouette with no
 * rule in the component layer would render as an unstyled box, so a new shape
 * is added to both this union and the stylesheet together.
 */
export type LoadingStateVariant = 'rows' | 'block' | 'chart';

/**
 * The variant classes, as a total lookup rather than an interpolated string.
 *
 * A `Record` keyed by the finite union is what makes the mapping checkable: a
 * new variant fails to compile until its class exists, and indexing with a
 * `LoadingStateVariant` is total, so `noUncheckedIndexedAccess` does not widen
 * the result to `string | undefined`. Interpolation
 * (`` `dg-loading-state--${variant}` ``) would type-check while producing a
 * class no stylesheet defines.
 */
const VARIANT_CLASS: Readonly<Record<LoadingStateVariant, string>> = {
  rows: 'dg-loading-state--rows',
  block: 'dg-loading-state--block',
  chart: 'dg-loading-state--chart',
};

/** The silhouette an unqualified `<LoadingState>` renders. */
const DEFAULT_VARIANT: LoadingStateVariant = 'rows';

/**
 * Bars drawn by the `'rows'` variant when the caller names no count.
 *
 * Three reads as a list without pretending to predict its length, and it is
 * short enough that a dense panel of several unresolved nodes stays calm.
 */
const DEFAULT_ROW_COUNT = 3;

/** Fewer than one bar is an empty box, which is the collapse this component exists to prevent. */
const MIN_ROW_COUNT = 1;

/**
 * The ceiling on the bar count.
 *
 * A placeholder is a silhouette, not a rendering of the result: past about a
 * dozen bars it communicates nothing further, and the count arrives from a
 * caller that may have computed it from data (a page size, a row estimate, a
 * value that came back as `NaN`). Clamping here keeps an arithmetic slip from
 * mounting thousands of nodes on a surface that is, by definition, still
 * waiting.
 */
const MAX_ROW_COUNT = 12;

/** The `'block'` and `'chart'` variants are one skeleton element, shaped entirely by CSS. */
const SINGLE_SKELETON_COUNT = 1;

/**
 * The announcement an unqualified `<LoadingState>` makes.
 *
 * Generic on purpose: this component cannot see which query is in flight, so a
 * more specific default would be wrong in most of its uses. A caller that does
 * know passes its own through {@link LoadingStateProps.label}.
 */
const DEFAULT_LABEL = 'Loading…';

/**
 * The one character every announced label ends with: U+2026, the horizontal
 * ellipsis, which a screen reader voices as a single pause rather than as
 * "dot dot dot".
 */
const ELLIPSIS = '…';

/** A run of full stops at the end of a label — `"."`, `"..."` or any other count. */
const TRAILING_FULL_STOPS = /\.+$/u;

/**
 * The label as it is announced: trimmed, and ending in exactly one `…`.
 *
 * Every busy region in a panel says it is busy the same way, whoever wrote its
 * label (B2-F14): before this, some components wrote "Loading requests…" and
 * others "Loading captured database queries", so two regions in the same
 * state announced themselves as if they were in two different ones. The
 * convention is applied here rather than asked of each caller, because a
 * convention every caller has to remember is one that some caller forgets.
 *
 * A label already ending in `…` is kept as written; a trailing run of full
 * stops — the ASCII `"..."` or a lone `"."` — is replaced by the one ellipsis;
 * any other label has the ellipsis appended. An absent or blank label, or one
 * that is nothing but full stops or an ellipsis, falls back to
 * {@link DEFAULT_LABEL}, since a live region announcing a lone ellipsis tells
 * the reader nothing.
 *
 * @param label The caller's label, if any.
 * @returns The text the region announces.
 */
function announcedLabel(label: string | undefined): string {
  const trimmed = label?.trim() ?? '';

  if (trimmed.endsWith(ELLIPSIS)) {
    return trimmed.slice(0, -ELLIPSIS.length).trim() === '' ? DEFAULT_LABEL : trimmed;
  }

  const stem = trimmed.replace(TRAILING_FULL_STOPS, '').trimEnd();
  return stem === '' ? DEFAULT_LABEL : `${stem}${ELLIPSIS}`;
}

/**
 * The classes every skeleton element carries: the block's element class for its
 * place in the silhouette, and the shared shimmer treatment. Both are constant,
 * so the value is hoisted rather than rebuilt per bar.
 */
const SKELETON_CLASS = 'dg-loading-state__row dg-skeleton';

/**
 * How many skeleton elements to render.
 *
 * `'block'` and `'chart'` are always exactly one element; only `'rows'` reads
 * the caller's count, and it reads it defensively. An absent count, and any
 * value that is not a finite number, fall back to {@link DEFAULT_ROW_COUNT}; a
 * fractional count is truncated; the result is clamped to
 * [{@link MIN_ROW_COUNT}, {@link MAX_ROW_COUNT}]. The function therefore always
 * answers with a small positive integer, which is what lets the caller below
 * render without a guard of its own.
 *
 * @param variant The silhouette being rendered.
 * @param rows The caller's requested bar count, if any.
 * @returns The number of skeleton elements to render.
 */
function resolveSkeletonCount(variant: LoadingStateVariant, rows: number | undefined): number {
  if (variant !== 'rows') {
    return SINGLE_SKELETON_COUNT;
  }

  if (rows === undefined || Number.isFinite(rows) === false) {
    return DEFAULT_ROW_COUNT;
  }

  return Math.min(MAX_ROW_COUNT, Math.max(MIN_ROW_COUNT, Math.trunc(rows)));
}

/**
 * The props of {@link LoadingState}.
 *
 * Extending `HTMLAttributes<HTMLDivElement>` is deliberate and is what keeps
 * this interface short: `id`, `title`, `aria-label`, `aria-labelledby`, every
 * other `aria-*` attribute and every `data-*` attribute pass straight through
 * to the region without being enumerated here. `children` is removed from that
 * inherited set and never re-declared: the content of this region is the
 * skeleton it draws, and a caller with something to show is no longer loading.
 *
 * Every added prop spells `| undefined`: `exactOptionalPropertyTypes` is in
 * force repository-wide (tsconfig.base.json), and a caller that forwards an
 * optional value it may not have — `rows={query.pageSize}` — must remain legal.
 * React's own attribute types are written the same way.
 */
export interface LoadingStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /**
   * The silhouette to draw. Defaults to `"rows"`.
   *
   * Pick the one that matches the shape of the content being waited on — see
   * the table in this file's header for which component families use which.
   */
  variant?: LoadingStateVariant | undefined;

  /**
   * How many skeleton bars the `"rows"` variant draws. Defaults to `3`.
   *
   * This is a **count, not a size**: it controls how many elements are
   * rendered and never how tall any of them is, which is the stylesheet's
   * decision. The value is clamped to between 1 and 12 inclusive, and a
   * fractional value is truncated toward zero, so an absent, negative,
   * fractional, enormous or `NaN` count still produces a sane silhouette
   * instead of an empty box or thousands of nodes.
   *
   * Ignored by the `"block"` and `"chart"` variants, which are one element by
   * construction.
   */
  rows?: number | undefined;

  /**
   * The text announced while the region is busy. Defaults to a generic
   * `"Loading…"`.
   *
   * It is announced but never painted, so it is free to be more specific than
   * the default where the caller knows what is resolving. Keep it short: a
   * polite live region reads it in full, and it is spoken again each time the
   * region re-announces.
   *
   * **Convention: the announced text always ends with a single `…`.** Write
   * the label with or without it — `"Loading captured calls"`,
   * `"Loading captured calls..."` and `"Loading captured calls…"` all announce
   * `"Loading captured calls…"` — so every busy region in a panel reads the
   * same way. The label is trimmed, a trailing `"."` or `"..."` becomes the
   * ellipsis, and a blank label falls back to the default.
   */
  label?: string | undefined;

  /**
   * Extra classes for the region, composed after the block and variant classes
   * so a caller can place the placeholder inside a layout primitive without
   * reaching for an inline style.
   *
   * Re-declared from the inherited attribute set only to document it; the type
   * is React's own.
   */
  className?: string | undefined;
}

/**
 * Renders a busy placeholder for a region whose content has not resolved yet.
 *
 * Presentational and pure: no state, no effects, no hooks, no timers, no
 * memoization and nothing read from the document while rendering. The output is
 * a function of the props alone — one region element, one visually hidden
 * label, and between one and twelve decorative skeleton elements.
 *
 * The composed class name cannot be displaced by a caller, because `className`
 * is destructured out of the passthrough and merged deliberately. The ARIA
 * defaults are set *before* the spread, which leaves them overridable on
 * purpose: a caller nesting several placeholders inside one region that already
 * announces itself can quiet the inner ones with `aria-live="off"`, and one
 * whose surrounding markup already names the region can re-point it. Neither is
 * the normal case, and an unqualified placeholder announces itself.
 *
 * @param props The design props above, plus any HTML attribute of a `div`.
 * @returns The placeholder region, with no wrapper and no inline style.
 *
 * @example
 * // A table awaiting its first page: five bars, and a label worth announcing.
 * <LoadingState rows={5} label="Loading captured spans…" />
 *
 * @example
 * // An SVG view and a metric group, each with the silhouette of its content.
 * <LoadingState variant="chart" />
 * <LoadingState variant="block" />
 */
export function LoadingState(props: LoadingStateProps): ReactElement {
  const { variant = DEFAULT_VARIANT, rows, label, className, ...rest } = props;

  const skeletonCount = resolveSkeletonCount(variant, rows);
  const announced = announcedLabel(label);

  return (
    <div
      className={clsx('dg-loading-state', VARIANT_CLASS[variant], className)}
      role="status"
      aria-live="polite"
      aria-busy="true"
      {...rest}
    >
      <Text className="dg-visually-hidden">{announced}</Text>
      {Array.from({ length: skeletonCount }, (_unused, index) => (
        // The bars are interchangeable and their count changes only with the
        // props, so the index is a stable identity; nothing here holds state
        // that a remount could lose.
        <div key={index} className={SKELETON_CLASS} aria-hidden="true" />
      ))}
    </div>
  );
}
