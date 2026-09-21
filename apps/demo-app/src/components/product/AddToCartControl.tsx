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
 * The cart does not reject a failed change: it publishes wording for it. `addLine` resolves either
 * way, sets `syncStatus` to `'error'` and puts a customer-facing sentence on `cartError`, so the
 * outcome of a press is a fact about the cart's published state rather than a value the call
 * returns. That is why the notice is raised from the settled state and not from the call's own
 * resolution: announcing success where the promise resolved would tell a buyer their product was
 * added whenever the cart had just said the opposite. The `catch` remains for the other kind of
 * failure, the unexpected throw, which the cart never describes and therefore never publishes
 * wording for. Each press is numbered and the number of the press last spoken about is kept, so
 * whichever path speaks for a press is the only one that speaks for it - and a cart written to by
 * another part of the page is never mistaken for an answer to a press made here.
 *
 * ONE EVENT, ONE ANNOUNCEMENT
 * A failure is stated twice, deliberately in two places: the notice answers what the buyer just
 * did and then retires itself, and the line under the control keeps the cart's own wording on
 * screen for as long as the cart holds it. Only one of them announces, though. The notification
 * queue speaks through a single polite region of its own, and `Alert` at tone `'warning'` takes
 * that primitive's polite branch, so the line does not add a second, assertive announcement of a
 * failure that has just been announced. The two also use different words - the notice carries the
 * store's own short sentence and the line carries the cart's - so nothing is read out twice.
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
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactElement } from 'react';

import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Select } from '@/components/ui/Select';
import { useCart } from '@/hooks/useCart';
import { useShippingEta } from '@/hooks/useShippingEta';
import { formatQuantityLabel } from '@/lib/format';
import type { CartItemDraft, StockState } from '@/lib/types';
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

/** Wording for an addition that failed before the cart could describe the failure itself. */
const ADDITION_FAILED_BODY = 'Your cart was left as it was. Try again in a moment.';

/**
 * A message that could be a sentence somebody wrote for a buyer: one line, of a length a person
 * would read, ending the way a sentence ends.
 */
const CUSTOMER_SENTENCE = /^[^\n\r{}[\]<>]{1,140}[.!?]$/;

/**
 * Wording a buyer may read for `cause`.
 *
 * The cart publishes customer wording for every failure it understands, and that wording is what
 * the notice under the control shows. A value that reaches this function threw instead, so its
 * message is as likely to carry a request URL, a query or a stack frame as it is to carry a
 * sentence: only a plain sentence is passed through, and everything else - including a thrown
 * value that is not an `Error` at all - becomes the store's own wording.
 */
function customerFailureBody(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return ADDITION_FAILED_BODY;
  }

  const message = cause.message.trim();

  return CUSTOMER_SENTENCE.test(message) && !message.includes('://')
    ? message
    : ADDITION_FAILED_BODY;
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

  // Presses this control has sent to the cart. It moves forward once per press, in the handler
  // below, so the announcement effect has something that changes for every press even when two
  // presses end the same way.
  const [pressCount, setPressCount] = useState<number>(0);

  // The press the buyer has already been told about. Held in a ref rather than in state because
  // the announcement effect writes it, and because it is a record of what has been said rather
  // than anything the markup depends on. It is what makes the two announcement paths exclusive:
  // whichever of them speaks first for a press marks it here, and neither speaks for it again.
  const announcedPress = useRef<number>(0);

  const quantityLimit = quantityCeiling(maxQuantity);
  const orderedQuantity = clampQuantity(quantity, quantityLimit);
  const quantityChoices = Array.from(
    { length: quantityLimit },
    (_value, index) => index + MIN_ORDER_QUANTITY,
  );

  const isOrderable = ORDERABLE_STOCK_STATES[stockState];
  const cartIsSaving = syncStatus === 'saving';
  const canAddToCart = isOrderable && !cartIsSaving && syncStatus !== 'loading';

  // The cart's answer to a press, announced once the cart has finished working on it.
  //
  // Three things keep this to one notice for one press. Nothing is said before the first press, so
  // the queue stays quiet on a page nobody has acted on. Nothing is said while the cart is still
  // working, so a press cannot be answered before the cart has answered it. And nothing is said
  // for a press already answered, which is what the ledger above records - so the cart being
  // written to by another part of the page, or the countdown republishing, never puts words in
  // this control's mouth.
  useEffect(() => {
    if (pressCount === 0 || pressCount === announcedPress.current) {
      return;
    }

    if (syncStatus === 'saving' || syncStatus === 'loading') {
      return;
    }

    announcedPress.current = pressCount;

    if (cartError === null) {
      showToast({ tone: 'success', title: `${productName} added to your cart` });
      return;
    }

    showToast({
      tone: 'danger',
      title: `${productName} could not be added to your cart`,
      body: ADDITION_FAILED_BODY,
    });
  }, [pressCount, syncStatus, cartError, showToast, productName]);

  /**
   * Ask the cart for the quantity on screen.
   *
   * The guard is the same condition the action is disabled by, so a press that arrives anyway -
   * from a keyboard repeat, or from a click already in flight when the cart began saving - cannot
   * start a second addition.
   */
  async function addToCart(): Promise<void> {
    if (!canAddToCart) {
      return;
    }

    // The press being made. Presses are serialized by the guard above, so the next number is the
    // one this press gets, and it is the name both announcement paths refer to it by.
    const press = pressCount + 1;
    const draft: CartItemDraft = { productId, quantity: orderedQuantity };

    setPressCount(press);

    try {
      await addLine(draft);
    } catch (cause: unknown) {
      // Only an unexpected throw arrives here: a failure the cart understands is published on
      // `cartError` and announced by the effect above. Marking the press answered before speaking
      // is what stops that effect saying anything further about it, whatever the cart publishes
      // afterwards, and the buyer gets wording that has been checked for readability rather than
      // whatever the failure carried.
      announcedPress.current = press;

      showToast({
        tone: 'danger',
        title: `${productName} could not be added to your cart`,
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
