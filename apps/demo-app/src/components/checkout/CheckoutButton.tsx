'use client';

/*
 * CheckoutButton - the checkout column's committing action: "Place order".
 *
 * One control and one caption, and nothing else. `CheckoutForm` owns the checkout itself: it holds
 * the contact and address fields, assembles the order it is going to send, sends it, and decides
 * what the buyer sees afterwards. This module is handed the two facts a button needs out of all
 * that - whether a submission is in flight, and whether the order can be placed at all - and turns
 * them into the strongest control on the page. It takes props and returns markup: no state, no
 * effect, no ref, no timer, nothing requested and no cart read.
 *
 * WHY THE SPLIT IS WORTH A FILE
 * The committing action of a checkout is the one control whose presentation is a subject of its
 * own: it is wider than its neighbours, it carries the brand accent rather than the neutral fill
 * every other control in the form uses, and it owns a line underneath for what is happening.
 * Keeping that here leaves `CheckoutForm` to read as what it is - fields, validation, assembly and
 * submission - and lets a second surface place the same control by passing `formId`, without
 * either module learning anything about the other.
 *
 * `type="submit"` IS STATED, AND MUST BE
 * `Button` always emits `type` and defaults it to `'button'`, so that the quantity steppers and
 * secondary controls living inside a checkout form cannot post it by being pressed. The one
 * control that is meant to post the form therefore has to say so, which is the `type="submit"`
 * below - without it this would look like the primary action and do nothing at all. `formId` rides
 * alongside as the native `form` attribute, so the control works whether it sits inside the
 * `<form>` element or beside it in the order summary.
 *
 * ONE SOURCE FOR "IN FLIGHT"
 * `pending` arrives as a prop and is never derived here, so what the control shows and what the
 * form is actually doing cannot drift apart. It reaches the primitive as `busy`, which is what
 * holds the native `disabled` attribute for the duration, sets `aria-busy="true"` and places the
 * indicator before the label - so this module restates neither of those and renders no indicator
 * of its own, and a second press cannot start a second submission. `disabled` is the separate,
 * independent reason a caller may have for the action being unavailable - an empty cart, a
 * shipping option still to be chosen - and the two are combined into the attribute here rather
 * than left to the primitive, so the lock is legible where the control is composed.
 *
 * THE CAPTION IS A LIVE REGION, AND IT IS ALWAYS IN THE DOCUMENT
 * The indicator inside the primitive is decorative by contract, so on its own it tells assistive
 * technology nothing about what is going on. The line under the control is this module's answer: a
 * polite live region, empty at rest, holding the in-flight phrase while the submission runs. It is
 * rendered at all times rather than mounted when it fills, because a live region has to be in the
 * document before its content changes for the change to be announced - and because
 * `CheckoutButton.module.css` reserves its single line, so the summary beside it and the page
 * below it stay exactly where they were when the phrase arrives and when it leaves.
 *
 * RENDER BEHAVIOUR
 * A plain function component: no `memo` and no memoised props, so it re-renders whenever its
 * parent does. Nothing is read from the browser, the clock or a source of randomness while
 * rendering, which is what keeps the markup the server sends and the markup the browser first
 * produces in agreement, and it is why the caption's content is a function of `pending` alone.
 */

import clsx from 'clsx';
import type { MouseEventHandler } from 'react';

import { Button } from '@/components/ui/Button';

import styles from './CheckoutButton.module.css';

/**
 * The control's inputs.
 *
 * Local and deliberately unexported, like every other props shape in this component group: a
 * consumer that needs the type reads it back from the component with
 * `React.ComponentProps<typeof CheckoutButton>` and stays correct whatever is added here.
 *
 * Both label props are text rather than `ReactNode`, on purpose. The label is also the control's
 * accessible name and the caption's announced text, and a string is the only shape that can serve
 * all three without a caller accidentally putting markup where a screen reader expects a phrase.
 */
interface Props {
  /**
   * The `id` of the `<form>` this control submits, forwarded as the native `form` attribute.
   *
   * Omit it and the control submits the form it is nested inside, which is the ordinary case. Pass
   * it when the layout puts the action outside that element - in the order summary beside the
   * fields, say - because the native attribute is what keeps one form and its committing action
   * together across a page break.
   */
  formId?: string;

  /**
   * A submission is in flight.
   *
   * Required rather than defaulted: the state belongs to whoever sent the order, and a control
   * that quietly assumed `false` would show an idle button over a request that is still running.
   * It drives all three of the busy treatments - the held `disabled` attribute, `aria-busy` and
   * the indicator - plus the caption underneath.
   */
  pending: boolean;

  /**
   * The action is unavailable for a reason of the caller's, independent of any submission: an
   * empty cart, an incomplete address, a shipping option not yet chosen.
   *
   * Kept apart from `pending` because the two are different states and the stylesheet paints them
   * differently - a not-allowed cursor against a progress one.
   *
   * @default false
   */
  disabled?: boolean;

  /**
   * The resting label, which is also the control's accessible name.
   *
   * @default 'Place order'
   */
  label?: string;

  /**
   * The label and the caption text while a submission is in flight.
   *
   * @default 'Placing your order…'
   */
  pendingLabel?: string;

  /**
   * Passed straight to the control's `onClick`, for a caller that wants the press itself - closing
   * a drawer, scrolling the summary into view - alongside the form's own submission.
   *
   * Submission is not this handler's job: the form's `onSubmit` runs whether the order was placed
   * with the pointer, with the keyboard or by pressing Enter in a field, and this fires only for
   * the first of those.
   */
  onPlaceOrderClick?: MouseEventHandler<HTMLButtonElement>;

  /** Additional classes for the block, merged after the module's own. */
  className?: string;
}

/**
 * Render the place-order control with its caption underneath.
 *
 * The wrapper is what `CheckoutForm.module.css` positions as a single item of the form's footer
 * row, and it is a `<div>` rather than a fragment for exactly that reason: the control and the
 * line that describes it move together.
 *
 * `styles.root`, `styles.action`, `styles.pending` and `styles.status` are each typed
 * `string | undefined` under this repository's `noUncheckedIndexedAccess`, which is why the class
 * lists go through `clsx` - it drops an absent class where a template string would interpolate the
 * word "undefined" into the attribute - and why no non-null assertion appears anywhere here.
 *
 * @example The ordinary case: the control inside the form it submits, held while the order is
 * being placed and unavailable until there is something to order.
 * ```tsx
 * <CheckoutButton pending={submitting} disabled={cartLines.length === 0} />
 * ```
 *
 * @example The same control placed in the summary panel beside the fields, reaching its form by
 * `id`.
 * ```tsx
 * <form id="checkout" onSubmit={onSubmit}>…</form>
 * <CheckoutButton formId="checkout" pending={submitting} />
 * ```
 */
export function CheckoutButton({
  formId,
  pending,
  disabled,
  label = 'Place order',
  pendingLabel = 'Placing your order…',
  onPlaceOrderClick,
  className,
}: Props) {
  return (
    <div className={clsx(styles.root, className)}>
      <Button
        type="submit"
        form={formId}
        variant="primary"
        size="lg"
        busy={pending}
        disabled={disabled === true || pending}
        onClick={onPlaceOrderClick}
        className={clsx(styles.action, pending && styles.pending)}
      >
        {pending ? pendingLabel : label}
      </Button>

      <p className={styles.status} role="status" aria-live="polite">
        {pending ? pendingLabel : null}
      </p>
    </div>
  );
}
