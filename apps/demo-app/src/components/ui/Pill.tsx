/*
 * Pill - the chip of the Lumen Supply storefront.
 *
 * Two kinds of chip appear in this application and this component renders both, never a third:
 *
 *   - a chip the reader can toggle - the catalog's category filter row, the dashboard's grouping
 *     chips - which renders as a `<button type="button" aria-pressed>`, and
 *   - a chip that only labels something, which renders as a `<span>`.
 *
 * `pressed` is the discriminant, and making it one is the whole point of the props type below: a
 * chip that reacts to a click must declare the state it is in, so `<Pill onClick={…}>` does not
 * compile without `pressed` and cannot become a `<span onClick>` that no keyboard reader can
 * reach. `aria-pressed` on a real button is the accessible pattern for a filter that stays on
 * screen after it is applied, and the button also brings Enter, Space, focus and `disabled` with
 * it rather than asking this file to re-implement them.
 *
 * Presentation lives entirely in `Pill.module.css`, which selects variants by attribute:
 * `data-tone` and `data-size` on both paths, and `data-selected` on the toggle path while it is
 * on. The stylesheet also fixes the box - one border width, one padding pair, one height floor for
 * every state - so a row of a dozen chips does not reflow when one of them is clicked; this file
 * sets no geometry of its own.
 *
 * `data-selected` is set to `"true"` or left off altogether rather than being set to `"false"`.
 * React omits an attribute whose value is `undefined`, which is what lets the stylesheet describe
 * the unselected chip once, in its base rule, instead of twice.
 *
 * One deliberate omission: no `"use client"`. The component holds no state, runs no effect and
 * reads no DOM, and nothing in its output varies between a server and a client render, so it
 * renders in either environment; the parent that owns the selection state is the one that needs
 * the directive.
 */

import clsx from 'clsx';
import type { ReactNode } from 'react';

import styles from './Pill.module.css';

/*
 * The props of this component, kept local to it: nothing else in the application needs to name
 * them, and an exported alias would put a second name for one shape into the folder.
 *
 * The union is what pairs `pressed` with its handler. Its first member is the labelling chip -
 * every interactive prop must be absent (or explicitly `undefined`, which an optional prop spread
 * from a caller's object may still be) - and its second is the toggle, where `pressed` and
 * `onClick` are both required. `disabled` is meaningful only for the toggle, because only a
 * `<button>` can be disabled, so it appears in that member alone.
 */
type Props = {
  children: ReactNode;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md';
  count?: number;
  className?: string;
} & (
  | { pressed?: undefined; onClick?: undefined; disabled?: undefined }
  | { pressed: boolean; onClick: () => void; disabled?: boolean }
);

/**
 * A chip: a label, an optional trailing count, and optionally the ability to be toggled.
 *
 * Pass `pressed` together with `onClick` for a filter chip; pass neither for a chip that only
 * labels something. Children are usually a category glyph followed by a word, and the glyph
 * inherits the chip's `color`, so it inverts with the label when the chip is selected.
 *
 * @example
 * ```tsx
 * <Pill count={42}>Fasteners</Pill>
 * <Pill pressed={selected} onClick={onToggle} tone="info" size="sm">Fasteners</Pill>
 * ```
 */
export function Pill(props: Props) {
  // Read only the shared props here, resolving the two variant defaults in the pattern so that
  // each attribute below is computed once. `pressed`, `onClick` and `disabled` are read through
  // `props` after the check further down, so that the union narrows and neither a cast nor a
  // non-null assertion is needed to reach the handler.
  const { children, tone = 'neutral', size = 'md', count, className } = props;

  const classes = clsx(styles.root, className);

  // Identical in both paths: the label, then the count when there is one. `0` is a real count and
  // is rendered, which is why the test is against `undefined` and not falsiness.
  const content = (
    <>
      {children}
      {count === undefined ? null : <span className={styles.count}>{count}</span>}
    </>
  );

  if (props.pressed === undefined) {
    // The labelling chip. No handler, no tab stop, no role: it is text with a box around it, and
    // announcing it as a control would be a promise the element cannot keep.
    return (
      <span className={classes} data-tone={tone} data-size={size}>
        {content}
      </span>
    );
  }

  // The toggle. `type="button"` is not optional: the dashboard and checkout views place chips
  // inside forms, and a button without it submits the form it happens to sit in.
  return (
    <button
      type="button"
      className={classes}
      data-tone={tone}
      data-size={size}
      data-selected={props.pressed ? 'true' : undefined}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {content}
    </button>
  );
}
