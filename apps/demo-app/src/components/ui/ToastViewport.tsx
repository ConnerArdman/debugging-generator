'use client';

/**
 * Lumen Supply - ToastViewport: the visible corner region the notification queue is shown in.
 *
 * `@/providers/ToastProvider` owns the queue and renders `children` and nothing else - no DOM, no
 * stylesheet, no stacking tier - so without this component every notice the storefront raises
 * ("Added to cart", "Order placed", "That line is out of stock") exists in state and is never seen.
 * This file is the other half of that split: the root layout mounts it exactly once inside the
 * provider, it reads the queue from context, and it paints it. That is the whole of its job.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * Lifecycle belongs to the provider, all of it. A notice retires on the provider's own schedule,
 * through a single timer armed for the earliest `expiresAt` in the queue, so there is no timer, no
 * `Date.now()` reading, no remaining-time calculation, no queueing, no pause-on-hover and no
 * maximum-count truncation anywhere in here - a second lifecycle would race the first and produce
 * notices that vanish early or linger, for reasons no reader of either file could explain. The
 * component holds no state, runs no effect, keeps no ref and touches no browser global while
 * rendering, which is also what makes it hydration-safe: the server renders the region with an
 * empty list, the browser's first render produces the same markup, and the queue only ever grows
 * afterwards from an interaction. `toasts` is `readonly` and is rendered in the order it arrives -
 * oldest first, as the provider documents - never copied, sorted or sliced.
 *
 * THE REGION IS RENDERED EVEN WHEN THE QUEUE IS EMPTY, AND THAT IS THE POINT
 * A live region has to be in the accessibility tree *before* the text it should announce is put
 * into it; a container inserted into the document in the same frame as its first message is
 * frequently announced late or not at all. So the region is unconditional and only the list items
 * come and go. `role="status"` with `aria-live="polite"` queues each new notice behind whatever the
 * reader is doing rather than interrupting them, and `aria-relevant="additions"` keeps a removal -
 * an expiry, or a dismissal the reader performed themselves - from being announced as news.
 *
 * `aria-atomic="false"` is stated explicitly because `role="status"` implies `aria-atomic="true"`:
 * left implicit, adding a third notice would re-announce the two already on screen, so a buyer who
 * adds three lines to a cart hears the first line's confirmation three times. Only the addition is
 * announced, and the title is the first text in each item, so that announcement leads with the
 * headline rather than with a dismiss control.
 *
 * Focus is never moved here. A notice appears while the buyer is typing into the checkout form,
 * and stealing focus would empty the field they were in the middle of. The dismiss control is
 * reachable in document order like any other button, which is the correct trade for a message that
 * retires by itself anyway.
 *
 * STRUCTURE, AND WHY IT IS FLAT
 * `ToastViewport.module.css` lays a notice out as a two-column grid - the message, then the
 * dismiss control - with `.title` and `.body` placed in column 1 and `.dismiss` in column 2 of row
 * 1, and the rows created by whichever children are actually present. Those three classes are
 * therefore rendered as DIRECT children of `.toast`: grouping the two paragraphs inside a wrapper
 * element would make the stylesheet's column placement inert and, more visibly, would drop the
 * `row-gap` between the headline and the detail line, because a wrapper declares no gap of its
 * own. A notice with no detail line simply contributes no second row.
 *
 * The region is transparent to the pointer (`.root { pointer-events: none }`) while each notice
 * takes interaction back (`.toast { pointer-events: auto }`), which is what stops a 360px
 * rectangle parked over the checkout summary's action column from swallowing presses meant for the
 * storefront. That pair lives in the stylesheet and nothing here may undo it: no `style` prop, no
 * inline CSS and no portal - the region is `position: fixed` and is already mounted at the layout
 * root, so a portal would only add a node the server tree has to reconcile.
 *
 * `data-tone` carries the notice's tone to the stylesheet, which selects the accent and title
 * colour from the attribute. The four values are exactly the `ToastTone` union the provider
 * exports, passed through untouched, so the two files cannot drift into a tone that renders
 * unstyled; an unknown value would fall back to the neutral accent rather than break the layout.
 *
 * No props, and no exported props type: the component is mounted once, at a known place, with
 * nothing to configure. Its only hook is the context read that hands it the queue.
 */

import { useToastCenter } from '@/providers/ToastProvider';

import { Button } from './Button';
import styles from './ToastViewport.module.css';
import { VisuallyHidden } from './VisuallyHidden';

/**
 * Renders the notification region and the notices currently queued in it.
 *
 * `toast.body` is compared against `undefined` rather than tested for truthiness: the provider
 * omits the key entirely when a caller passed no detail line, so this both matches that contract
 * and lets a legitimate `'0'` of a body render.
 *
 * Each dismiss control names the notice it closes - "Dismiss: Added to cart" - because a reader
 * moving through several stacked notices hears one identical "Dismiss notification" per button
 * otherwise, with nothing to tell them apart. The `×` glyph beside it is `aria-hidden`, so the
 * hidden text is the control's entire accessible name. `StoreToast.title` is typed `string`, which
 * is what makes it safe to interpolate: no cast, and no node smuggled into an accessible name.
 *
 * The handler is a block-bodied arrow that calls `dismissToast` and returns nothing, so the
 * `void`-returning mutator is never handed back to React's `onClick` as a value.
 */
export function ToastViewport() {
  const { toasts, dismissToast } = useToastCenter();

  return (
    <div
      className={styles.root}
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions"
    >
      <ul className={styles.list}>
        {toasts.map((toast) => (
          <li key={toast.id} className={styles.toast} data-tone={toast.tone}>
            <p className={styles.title}>{toast.title}</p>
            {toast.body === undefined ? null : <p className={styles.body}>{toast.body}</p>}
            <span className={styles.dismiss}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  dismissToast(toast.id);
                }}
              >
                <span aria-hidden="true">×</span>
                <VisuallyHidden>{`Dismiss: ${toast.title}`}</VisuallyHidden>
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
