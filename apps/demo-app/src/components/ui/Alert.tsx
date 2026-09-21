/**
 * Lumen Supply - Alert: the storefront's inline message box.
 *
 * This is the primitive every surface of the application reaches for when it has something to say
 * about the state of the page itself: an order that could not be placed above the checkout form, a
 * cart that failed to synchronise, a low-stock notice on the inventory dashboard, a free-freight
 * threshold on the cart summary. It renders where it is placed, in the document flow, and it stays
 * there: nothing here dismisses itself, fixes itself to the viewport or claims a stacking tier.
 * Notices that fly in, stack and time out are the toast provider's business, and that separation is
 * what lets this component stay a plain function with no state, no effects and no timers.
 *
 * Three decisions make up its whole contract, and each is deliberate:
 *
 *   1. `tone` drives the announcement, not just the colour. The element's ARIA role and live-region
 *      politeness are derived from the tone rather than exposed as props, so a storefront that
 *      renders polite notices on mount cannot accidentally interrupt a screen-reader user with a
 *      stock note, and a failed order cannot be announced so quietly that it is missed. See the
 *      note on `role` in the component below for why this is not configurable.
 *   2. `actions` is a slot, not a dependency. Callers pass their own buttons ("Try again", "View
 *      order") as children of that slot, which keeps this module free of any import beyond `clsx`,
 *      the stylesheet and a React type. That matters because most of these notices are rendered
 *      from server components, where pulling in an interactive primitive would be pure cost.
 *   3. Meaning lives in words. There is no icon, glyph or emoji anywhere in this component or its
 *      stylesheet: the tone is carried visually by the accent edge and the title colour, and
 *      carried semantically by the caller's own copy. The box therefore reads correctly with colour
 *      perception simulated off, and it needs no image asset.
 *
 * Presentation belongs entirely to `Alert.module.css`, which selects each tone through the
 * `data-tone` attribute set below. That is why this component performs no class lookup and never
 * indexes into the imported `styles` object dynamically - every class it uses is named literally,
 * so a renamed class is a compile-time concern rather than a silently unstyled box.
 *
 * Usage:
 *
 * ```tsx
 * <Alert>Orders over 500 units ship free this week.</Alert>
 *
 * <Alert tone="danger" title="Order failed" actions={<Button onClick={retry}>Try again</Button>}>
 *   The payment service did not respond. No charge was made and your cart is unchanged.
 * </Alert>
 * ```
 */

import clsx from 'clsx';
import type { ReactNode } from 'react';

import styles from './Alert.module.css';

/**
 * The component's props.
 *
 * Local and deliberately not exported. Callers write `<Alert …>` and let the compiler check the
 * attributes against this shape; nothing in the application needs to name the type, and an exported
 * alias would add a public identifier to this workspace for no benefit.
 */
interface Props {
  /**
   * The message. Plain sentences are the norm, but any node is accepted so a caller can emphasise a
   * product code or link to an order without this component laying out its children.
   */
  children: ReactNode;

  /**
   * Which of the four shared status tones this notice carries. The vocabulary is the one fixed by
   * the folder's other status primitives, so a warning looks the same wherever it appears.
   *
   * Defaults to `info`, which is also the tone the stylesheet falls back to, so an alert written
   * without this prop is styled and announced consistently from both sides.
   */
  tone?: 'info' | 'success' | 'warning' | 'danger';

  /**
   * An optional one-line heading, rendered as a paragraph rather than a heading element so that an
   * alert dropped into any page never disturbs the document outline. Omit it for a single-sentence
   * notice; supply it when the message needs a summary a reader can take in at a glance.
   */
  title?: ReactNode;

  /**
   * An optional trailing row of controls - retry, reload, "view order". A slot: the caller supplies
   * the elements, this component only positions them.
   */
  actions?: ReactNode;

  /**
   * An optional class from the surrounding layout, composed after the module's own root class so a
   * caller can adjust margins in its own stylesheet without this component exposing a `style` prop.
   */
  className?: string;
}

/**
 * Renders an inline notice.
 *
 * The `danger` tone is the only interruption: it renders `role="alert"` with
 * `aria-live="assertive"`, because a failed order or a lost cart is something the reader has to
 * hear about now. Every other tone renders `role="status"` with `aria-live="polite"`, which queues
 * the announcement behind whatever the reader is doing. Both are stated explicitly rather than left
 * to the role's implicit live value, so the pairing is visible in the markup and in the DOM.
 *
 * The pairing is not configurable, and that is the point: a `role` prop is exactly how a storefront
 * ends up shouting a shipping-threshold notice at every reader who opens the cart. A caller that
 * genuinely needs different semantics renders its own container instead.
 *
 * `title` and `actions` are compared against `undefined` rather than tested for truthiness, so a
 * caller may legitimately render the digit `0` or an empty string as a title without the element
 * disappearing; passing nothing at all renders no element, leaving no empty row in the box's
 * vertical rhythm.
 */
export function Alert({ children, tone = 'info', title, actions, className }: Props) {
  return (
    <div
      className={clsx(styles.root, className)}
      data-tone={tone}
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-live={tone === 'danger' ? 'assertive' : 'polite'}
    >
      {title === undefined ? null : <p className={styles.title}>{title}</p>}
      <div className={styles.body}>{children}</div>
      {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
