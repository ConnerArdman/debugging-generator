'use client';

/**
 * Lumen Supply - ToastViewport: the corner region that shows the notification queue.
 *
 * `@/providers/ToastProvider` owns the queue and its whole lifecycle, so there is no timer, clock
 * read or queue logic here - a second lifecycle would race the first. This component reads the
 * queue from context and paints it in the order received, oldest first.
 *
 * The region renders even when the queue is empty: a live region has to be in the accessibility
 * tree before its first message, or that message is announced late or not at all. `role="status"`
 * with `aria-live="polite"` waits for the reader rather than interrupting, and
 * `aria-relevant="additions"` keeps an expiry or a dismissal from being announced. `aria-atomic`
 * is stated as `"false"` because `role="status"` implies `"true"`, which would re-read every
 * visible notice each time one is added. Focus is never moved: a notice can arrive while the buyer
 * is typing into the checkout form.
 *
 * `data-ls-live-region="true"` is a contract with `@/components/cart/CartDrawer`, whose modal
 * `inert` sweep skips any body child that is or contains it. Removing it makes this region inert
 * while the drawer is open and silences every notice raised from inside the drawer.
 *
 * `.title`, `.body` and `.dismiss` must stay direct children of `.toast`: the stylesheet places
 * them on a two-column grid, and a wrapper would break the placement and the row gap. The region
 * ignores the pointer while each notice takes it back; that pair lives in the stylesheet, so this
 * file adds no `style` prop and no portal.
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
      // Read by `@/components/cart/CartDrawer` and by nothing else: the one body subtree its
      // modal `inert` sweep must leave interactive and announceable. See the header.
      data-ls-live-region="true"
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
