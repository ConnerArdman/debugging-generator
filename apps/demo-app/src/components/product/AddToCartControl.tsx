'use client';

/*
 * AddToCartControl - the product page's purchase control: how many, the action that puts them in
 * the cart, when they leave the warehouse, and the notice when the cart could not take them.
 *
 * WHAT IT OWNS, AND WHAT IT DOES NOT
 * It owns one piece of buyer intent - the quantity - and the press that sends it. Everything else
 * is read from the application's own providers: the cart itself, the dispatch countdown and the
 * notification queue. Nothing here composes a URL, holds a cart of its own or keeps a second copy
 * of what the server said. `addLine` from `@/hooks/useCart` is the only way out of this file, and
 * it writes through the provider, which owns the request; two paths to the cart would let the
 * button and the header badge disagree about what a buyer has bought.
 *
 * HOW THE OUTCOME IS ANNOUNCED
 * A press is answered from how its call to the cart settled, because that is the only thing that
 * knows what became of the units. Units are added to whatever the line already holds, so an
 * addition whose request came back a failure may still have been carried out; the cart therefore
 * reads itself back from the server before it answers, resolves where those units did go in, and
 * otherwise rejects with a `CartAdditionError` saying whether the read found them absent or
 * established nothing about them. The notice is written from that outcome and never from anything
 * this file infers: an addition is stated as having failed only where the cart found the units
 * absent, and every other ending - an outcome the cart could not settle, or a throw it never
 * described at all - is announced as the open question it is, with the buyer asked to look at their
 * cart. Nothing here tells a buyer their cart was left as it was unless that was read back and
 * confirmed, and nothing invites a second press that could double a line.
 *
 * ONE EVENT, ONE ANNOUNCEMENT
 * A failure is stated twice, deliberately in two places: the notice answers what the buyer just
 * did and then retires itself, and the line under the control keeps the cart's own wording on
 * screen for as long as the cart holds it. Only one of them announces, though. The notification
 * queue speaks through a single polite region of its own, and `Alert` at tone `'warning'` takes
 * that primitive's polite branch, so the line does not add a second, assertive announcement of a
 * failure that has just been announced. One press settles once and raises one notice, so a cart
 * written to by another part of the page never puts words in this control's mouth; the sentence the
 * two show may be the same one, because the cart authors that wording and both places state what it
 * said rather than inventing a second account of it.
 *
 * THE CLOCK IS NOT READ HERE
 * The dispatch line is built from what `useShippingEta` published - the arrival wording and the
 * milliseconds left until the next collection - and never from `Date.now()` or a `new Date()`. One
 * clock for the whole application is what keeps this line, the header and the cart totals quoting
 * the same collection, and a reading taken while rendering would put a different value in the
 * markup the server sent and the markup the browser first produced. The figure printed is coarse
 * for the same reason the line uses tabular figures: the countdown is republished continuously,
 * and a number that changed every second would redraw a line the reader is trying to read.
 *
 * RENDER BEHAVIOUR
 * A plain function component: no `memo` and no memoised props. It reads the cart and the dispatch
 * countdown, so it renders again whenever either of them is republished, which is the ordinary
 * behaviour of a control that quotes live values. Nothing is read from the browser, the clock or a
 * source of randomness while rendering, which is what keeps the markup the server sends and the
 * markup the browser first produces in agreement, and there is no timer, no interval, no polling
 * and no request of this control's own.
 *
 * Class contract with `AddToCartControl.module.css`: `root`, `row`, `field`, `actions`, `eta` and
 * `error`. The stylesheet reaches the button through `.actions > *`, so the control applies no
 * class of its own to it.
 */

import clsx from 'clsx';
import { useId, useState, type ChangeEvent, type ReactElement } from 'react';

import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Select } from '@/components/ui/Select';
import { useCart } from '@/hooks/useCart';
import { useShippingEta } from '@/hooks/useShippingEta';
import { formatQuantityLabel } from '@/lib/format';
import type { CartItemDraft, StockState } from '@/lib/types';
import { CartAdditionError } from '@/providers/CartProvider';
import { useToastCenter } from '@/providers/ToastProvider';

import styles from './AddToCartControl.module.css';

/**
 * Most units the quantity list offers when the page knows no narrower figure.
 *
 * A short list rather than a free-text box: a product detail page sells ones and twos, and the
 * buyers who order by the pallet do it from a quote. A list also makes every value it offers a
 * value the cart will accept, so there is no entry to validate and nothing to reject.
 */
const QUANTITY_CHOICE_LIMIT = 10;

/** Smallest order this control can place: a product is added, or it is not added at all. */
const MIN_ORDER_QUANTITY = 1;

/** A minute, for reducing the published countdown to the coarse figure the dispatch line prints. */
const MS_PER_MINUTE = 60_000;

/**
 * Which stock states a buyer may order from.
 *
 * A `Record` over the whole union rather than a comparison against one state: adding a state to
 * `StockState` becomes a compile error right here, where a decision about it has to be made,
 * instead of falling through to a control that quietly stays available.
 */
const ORDERABLE_STOCK_STATES: Record<StockState, boolean> = {
  IN_STOCK: true,
  LOW_STOCK: true,
  OUT_OF_STOCK: false,
};

/**
 * Wording for an addition that failed without the cart describing the failure itself.
 *
 * A failure the cart did not author is also a failure nobody established the outcome of, and units
 * are added to whatever the line already holds: the request may have been carried out before it
 * failed. So this says neither that the cart is unchanged nor that pressing again is safe - it
 * sends the buyer to look at what their cart holds, which is the one thing that is true here.
 */
const UNSETTLED_ADDITION_BODY = 'Check your cart before adding this product again.';

/**
 * A message that could be a sentence somebody wrote for a buyer: one line, of a length a person
 * would read, ending the way a sentence ends.
 */
const CUSTOMER_SENTENCE = /^[^\n\r{}[\]<>]{1,140}[.!?]$/;

/**
 * Wording a buyer may read for `cause`.
 *
 * A failure the cart rejected with carries the sentence it published for a customer, and that
 * sentence is what the notice should show, so it is passed straight through. Anything else that
 * reaches here threw on its own terms, and its message is as likely to carry a request URL, a query
 * or a stack frame as it is to carry a sentence: the guard is what tells the two apart, and
 * everything that does not read as a sentence - including a thrown value that is not an `Error` at
 * all - becomes the store's own wording instead.
 */
function customerFailureBody(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return UNSETTLED_ADDITION_BODY;
  }

  const message = cause.message.trim();

  return CUSTOMER_SENTENCE.test(message) && !message.includes('://')
    ? message
    : UNSETTLED_ADDITION_BODY;
}

/**
 * The quantity list's ceiling for a page that knows `available` units can be promised.
 *
 * A figure the page does not have, or one that is not a usable number, leaves the standing limit
 * in place; a figure below it shortens the list. The result is never less than one, so a product
 * whose availability has fallen to zero still offers a list rather than an empty one - the control
 * itself is unavailable in that case, which is a clearer statement than a field with no options.
 */
function quantityCeiling(available: number | undefined): number {
  if (available === undefined || !Number.isFinite(available)) {
    return QUANTITY_CHOICE_LIMIT;
  }

  return Math.max(MIN_ORDER_QUANTITY, Math.min(QUANTITY_CHOICE_LIMIT, Math.trunc(available)));
}

/** `value` as a whole number of units inside the list this control offers. */
function clampQuantity(value: number, ceiling: number): number {
  if (!Number.isFinite(value)) {
    return MIN_ORDER_QUANTITY;
  }

  return Math.min(Math.max(MIN_ORDER_QUANTITY, Math.trunc(value)), ceiling);
}

/**
 * What the dispatch line adds while today's collection can still be made.
 *
 * Derived from the published countdown alone and rounded down to whole minutes, so the clause
 * changes at most once a minute however often the countdown itself is republished. The last minute
 * before a collection is stated without a figure, because "within 0 min" is not a promise.
 */
function dispatchClause(msUntilCutoff: number | null): string {
  if (msUntilCutoff === null || !Number.isFinite(msUntilCutoff)) {
    return 'ships with the next collection today';
  }

  const minutesToCutoff = Math.floor(msUntilCutoff / MS_PER_MINUTE);

  return minutesToCutoff > 0
    ? `ships today if ordered within ${formatQuantityLabel(minutesToCutoff)} min`
    : 'ordered now, ships with the collection leaving shortly';
}

/**
 * The control's inputs.
 *
 * Local and deliberately unexported, like every other props shape in this component group: a
 * consumer that needs the type reads it back with `React.ComponentProps<typeof AddToCartControl>`
 * and stays correct whatever is added here.
 */
interface Props {
  /** The product to add, as the cart identifies it. */
  productId: string;

  /**
   * The product's name, used to say which product a notice is about. Text rather than `ReactNode`:
   * it is announced by the notification queue, and a screen reader expects a phrase there.
   */
  productName: string;

  /** How freely the product can be sold, which is what makes this control available or not. */
  stockState: StockState;

  /**
   * Units the page knows can be promised. Omit it when the page has no figure - the standing list
   * is offered then, and the cart remains the authority on what it will accept.
   */
  maxQuantity?: number;

  /** Additional classes for the block, merged after `.root`. */
  className?: string;
}

/**
 * Render the purchase control: the quantity field and the action side by side, the dispatch line
 * under them, and the cart's own notice under that when there is one.
 *
 * @example The ordinary case on a product detail page, with the availability the page already read
 * for its stock badge.
 * ```tsx
 * <AddToCartControl
 *   productId={product.id}
 *   productName={product.name}
 *   stockState={product.stockState}
 *   maxQuantity={product.availability[0]?.available}
 * />
 * ```
 */
export function AddToCartControl({
  productId,
  productName,
  stockState,
  maxQuantity,
  className,
}: Props): ReactElement {
  const { addLine, syncStatus, cartError } = useCart();
  const { showToast } = useToastCenter();
  const { etaLabel, msUntilCutoff, beforeCutoff } = useShippingEta();

  // Derived from the render pass rather than written by hand, so the label, the control and the
  // two message ids agree with each other in the markup the server sends and the markup the
  // browser produces from it.
  const quantityFieldId = useId();

  const [quantity, setQuantity] = useState<number>(MIN_ORDER_QUANTITY);

  const quantityLimit = quantityCeiling(maxQuantity);
  const orderedQuantity = clampQuantity(quantity, quantityLimit);
  const quantityChoices = Array.from(
    { length: quantityLimit },
    (_value, index) => index + MIN_ORDER_QUANTITY,
  );

  const isOrderable = ORDERABLE_STOCK_STATES[stockState];
  const cartIsSaving = syncStatus === 'saving';
  const canAddToCart = isOrderable && !cartIsSaving && syncStatus !== 'loading';

  /**
   * Ask the cart for the quantity on screen, and tell the buyer how it went.
   *
   * The guard is the same condition the action is disabled by, so a press that arrives anyway -
   * from a keyboard repeat, or from a click already in flight when the cart began saving - cannot
   * start a second addition.
   */
  async function addToCart(): Promise<void> {
    if (!canAddToCart) {
      return;
    }

    const draft: CartItemDraft = { productId, quantity: orderedQuantity };

    try {
      await addLine(draft);

      // The cart resolves only for units it has established are in it, including units a failed
      // request turned out to have added anyway, so this states a fact rather than an expectation.
      showToast({ tone: 'success', title: `${productName} added to your cart` });
    } catch (cause: unknown) {
      // What the notice may assert is exactly what the cart established. An addition it read back
      // and found had added nothing is stated as a failure; an outcome it could not settle, and a
      // throw it never described at all, are equally unknown here and are announced without
      // claiming the units stayed out of the cart.
      const unitsFoundAbsent =
        cause instanceof CartAdditionError && cause.outcome === 'not-applied';

      showToast({
        tone: 'danger',
        title: unitsFoundAbsent
          ? `${productName} could not be added to your cart`
          : `${productName} may not have been added to your cart`,
        body: customerFailureBody(cause),
      });
    }
  }

  return (
    <div className={clsx(styles.root, className)}>
      <div className={styles.row}>
        <FormField
          id={quantityFieldId}
          label="Quantity"
          // `clsx` rather than the class directly: a CSS-module lookup is `string | undefined`
          // under this repository's `noUncheckedIndexedAccess`, and `FormField` declares
          // `className?: string`, which `exactOptionalPropertyTypes` holds it to.
          className={clsx(styles.field)}
        >
          {(field) => (
            <Select
              id={field.id}
              aria-describedby={field.describedBy}
              autoComplete="off"
              value={String(orderedQuantity)}
              disabled={!isOrderable}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                setQuantity(clampQuantity(Number.parseInt(event.target.value, 10), quantityLimit));
              }}
            >
              {quantityChoices.map((value) => (
                <option key={value} value={value}>
                  {formatQuantityLabel(value)}
                </option>
              ))}
            </Select>
          )}
        </FormField>

        <div className={styles.actions}>
          <Button
            type="button"
            variant="primary"
            size="lg"
            busy={cartIsSaving}
            disabled={!canAddToCart}
            onClick={() => {
              void addToCart();
            }}
          >
            {isOrderable ? 'Add to cart' : 'Out of stock'}
          </Button>
        </div>
      </div>

      <p className={styles.eta}>
        {beforeCutoff ? `${etaLabel} — ${dispatchClause(msUntilCutoff)}` : etaLabel}
      </p>

      {cartError === null ? null : (
        <Alert tone="warning" className={clsx(styles.error)}>
          {cartError}
        </Alert>
      )}
    </div>
  );
}
