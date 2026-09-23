'use client';

/*
 * Scroller - a named, focusable horizontal scroll region that says when it has something to show.
 *
 * The dashboard's stock table carries seven columns and the page gives it a measure that stops
 * growing at 726px, so at a narrow viewport the table has to scroll *inside its card* rather than
 * widen the page. A plain `overflow-x: auto` box does that much, and nothing else: where the
 * platform draws overlay scrollbars the box measures zero pixels of scrollbar at rest (measured in
 * Chrome at 375, 768, 1280, 1440 and 1920: `offsetHeight - clientHeight` is 0 at every one), so a
 * reader is given no indication at all that a column continues past the edge, and pressing Home or
 * End with the region focused scrolls the *document* to its ends - throwing the table out of view -
 * because a region with no vertical overflow has nothing of its own for those keys to move.
 *
 * This component is those two gaps closed, and only those two:
 *
 *   1. It measures its own overflow and publishes it as `data-overflow` on its root element, which
 *      `./Scroller.module.css` reads to fade the edge the content continues past and to show a
 *      one-line instruction under the box. Both are absent when there is nothing to scroll.
 *   2. It handles Home and End on the region, moving the region's own horizontal scroll to its
 *      extremes instead of letting the document jump, and only while the region genuinely has
 *      somewhere to scroll - a reader pressing Home on a table that fits still expects the top of
 *      the page. The arrow keys are left exactly as the browser implements them: one press already
 *      covers a column, and re-implementing them would only change the step.
 *
 * WHY IT IS A CLIENT COMPONENT
 * For the measurement and the two keys, and for nothing else. Its caller - `InventoryLevelsTable`
 * and any other wide table - stays a server component: the rows are passed in as `children`, so
 * they are still rendered on the server and this component never sees what it is scrolling.
 *
 * WHY THE OVERFLOW STATE IS NOT REACT STATE
 * The measurement is written straight onto the root element's `data-overflow`. It is a fact about
 * the box's geometry, it is consumed only by CSS, and it changes on every scroll frame - so
 * holding it in state would re-render the whole table (fifty rows and a hundred cells) while a
 * reader drags the scrollbar, to produce markup identical but for one attribute. Writing the
 * attribute is also what keeps a scroll handler honest about reading layout: the read and the write
 * happen together, once, outside React's render.
 *
 * The attribute is rendered as `none` on the server, so the first paint shows no fade and no hint,
 * and the first measurement after mount corrects it. That order is deliberate: a hint promising
 * more columns on a box that turns out to fit would be worse than one that appears a frame late.
 *
 * MARKUP CONTRACT WITH `./Scroller.module.css`
 * A root `.frame` carrying `data-overflow`; inside it a positioned `.viewport` holding the
 * scrolling `.region` and the two `.fade` spans (selected by `data-edge`); and after it the `.hint`
 * paragraph, which the region points at with `aria-describedby` so the instruction is announced to
 * whoever focuses the box - and, being `display: none` while there is nothing to scroll, announced
 * only when it is true.
 */

import clsx from 'clsx';
import { useCallback, useEffect, useId, useRef } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';

import styles from './Scroller.module.css';

/**
 * How many pixels of remaining scroll count as none at all.
 *
 * Scroll metrics are fractional - a table that measures 726.75px inside a 726px box reports
 * `scrollWidth - clientWidth` as 1 after rounding - so a bare `> 0` test would fade an edge and
 * promise more columns over three quarters of a pixel of rounding. One pixel is the smallest
 * amount a reader could see and the largest that is certainly not content.
 */
const EDGE_SLACK = 1;

/**
 * Props of {@link Scroller}.
 *
 * Local and deliberately not exported: the tables that use it pass their own values through, and
 * this repository's guard script treats an exported demo identifier as vocabulary no product file
 * may then mention, so a second exported name would buy a constraint and nothing else.
 *
 * Every optional member spells `| undefined` out, because this workspace compiles with
 * `exactOptionalPropertyTypes`: under it a bare `className?: string` rejects a present-but-
 * undefined value, and a CSS Module lookup is `string | undefined`.
 */
interface Props {
  /** What scrolls: a table, or anything else wider than the space it is given. */
  children: ReactNode;

  /**
   * The `id` of the element that names this region - a table's `<caption>`, typically.
   *
   * Required, and required to be an element that exists: a `role="region"` with no accessible name
   * is not exposed as a landmark at all, which would leave a focusable box a screen reader
   * announces as nothing.
   */
  labelledBy: string;

  /**
   * The sentence shown under the box, and announced as the region's description, while there is
   * somewhere to scroll.
   *
   * The caller supplies it because only the caller knows what is scrolling: "columns" is right for
   * a table and wrong for everything else. It is never shown when the content fits.
   */
  hint: string;

  /**
   * The placing module's class for the scrollport, composed alongside `.region` - a radius, or
   * whatever else the surface it sits on needs. The scrolling behaviour itself is not the caller's
   * to restate.
   */
  className?: string | undefined;
}

/**
 * Render `children` in a horizontal scroll region that fades the edge its content continues past,
 * explains itself in one line, and answers Home and End with its own scroll rather than the
 * document's.
 *
 * @example
 * ```tsx
 * <Scroller
 *   labelledBy={CAPTION_ID}
 *   hint="This table is wider than the space available: scroll it sideways for the rest."
 *   className={styles.scroller}
 * >
 *   <table>…</table>
 * </Scroller>
 * ```
 */
export function Scroller({ children, labelledBy, hint, className }: Props): ReactElement {
  const frame = useRef<HTMLDivElement | null>(null);
  const region = useRef<HTMLDivElement | null>(null);

  /*
   * The hint's `id`, which the region's `aria-describedby` points at. `useId` rather than a
   * constant, because two scroll regions can share a page - the dashboard's table and its
   * placeholder are one such pair - and a duplicated `id` would point both descriptions at the
   * first one. It is stable across the server render and the browser's, so hydration agrees.
   */
  const name = useId();

  /**
   * Read the box's geometry once and publish what it says.
   *
   * Four outcomes, and every one of them is a fact about this frame at this width: nothing to
   * scroll, content continuing past the end edge, content continuing before the start edge, or
   * both. `scrollLeft` is compared against the remaining room rather than against `scrollWidth`,
   * so the end state clears exactly when the last pixel of content is on screen.
   */
  const measure = useCallback(() => {
    const box = region.current;
    const root = frame.current;

    if (box === null || root === null) {
      return;
    }

    const room = box.scrollWidth - box.clientWidth;

    if (room <= EDGE_SLACK) {
      root.dataset.overflow = 'none';

      return;
    }

    const before = box.scrollLeft > EDGE_SLACK;
    const after = box.scrollLeft < room - EDGE_SLACK;

    root.dataset.overflow = before ? (after ? 'both' : 'start') : 'end';
  }, []);

  /*
   * Measure on mount, and again whenever either box changes size: the region's own box changes
   * with the viewport, and the content's changes when a web font lands or the data behind it does.
   * A `ResizeObserver` covers both without a window listener, and it fires once on observation,
   * which is what performs the first measurement.
   */
  useEffect(() => {
    const box = region.current;

    if (box === null) {
      return undefined;
    }

    const watch = new ResizeObserver(() => {
      measure();
    });

    watch.observe(box);

    const inner = box.firstElementChild;

    if (inner !== null) {
      watch.observe(inner);
    }

    return () => {
      watch.disconnect();
    };
  }, [measure]);

  /**
   * Home and End, handled on the region.
   *
   * Four conditions have to hold before the keys are claimed, and each one is a case where the
   * browser's own behaviour is the right one: the key must have been pressed on the region itself
   * rather than on something focusable inside it; it must be Home or End; it must carry no
   * modifier, so Ctrl+Home still reaches the top of the document; and the region must actually have
   * somewhere to scroll, so a table that fits leaves the page keys alone. Only then is the default
   * prevented - otherwise the event travels on untouched.
   */
  const keydown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) {
      return;
    }

    if (event.key !== 'Home' && event.key !== 'End') {
      return;
    }

    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }

    const box = event.currentTarget;

    if (box.scrollWidth - box.clientWidth <= EDGE_SLACK) {
      return;
    }

    event.preventDefault();

    /*
     * `scrollWidth` for End is past the end on purpose: the browser clamps a horizontal scroll
     * offset to the scrollable range, so this lands exactly on the last pixel of content without
     * this component having to recompute the maximum. The scroll then fires the handler below,
     * which republishes the edge state.
     */
    box.scrollTo({ left: event.key === 'Home' ? 0 : box.scrollWidth });
  }, []);

  return (
    <div ref={frame} className={styles.frame} data-overflow="none">
      <div className={styles.viewport}>
        <div
          ref={region}
          className={clsx(styles.region, className)}
          role="region"
          aria-labelledby={labelledBy}
          aria-describedby={name}
          tabIndex={0}
          onScroll={measure}
          onKeyDown={keydown}
        >
          {children}
        </div>

        {/*
          Decoration, and announced as none: the hint below says in words what these two say in
          ink, so a screen reader hears the instruction once. They are rendered whether or not
          they are visible, because opacity is what changes as the reader scrolls - inserting and
          removing them would move the content they sit over.
        */}
        <span className={styles.fade} data-edge="start" aria-hidden="true" />
        <span className={styles.fade} data-edge="end" aria-hidden="true" />
      </div>

      <p className={styles.hint} id={name}>
        {hint}
      </p>
    </div>
  );
}
