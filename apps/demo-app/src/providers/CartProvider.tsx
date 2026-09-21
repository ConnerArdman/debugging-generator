'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import {
  addCartItem,
  clearCartContents,
  loadCartContents,
  removeCartItem,
  setCartItemQuantity,
  StorefrontApiError,
} from '@/lib/api-client';
import { formatPriceLabel } from '@/lib/format';
import type { CartItemDraft, CartLine, CartView } from '@/lib/types';

import { DispatchEtaContext } from './ShippingEtaProvider';

/**
 * Lumen Supply - the cart every surface of the storefront reads.
 *
 * One cart belongs to one browser and the server resolves it from the storefront's own cookie, so
 * nothing here names or holds a cart identifier of its own. The provider mounts once in the root
 * layout, reads that cart when the application starts, and publishes its lines, its totals and the
 * operations that change them to the header badge, the cart drawer, the cart page and the checkout
 * summary.
 *
 * Totals are derived rather than stored: `itemCount` is the quantity summed across the published
 * lines and `subtotalCents` the sum of their line totals. No consumer multiplies money of its own,
 * and a quantity a buyer has just changed reads the same in every one of those places at once.
 *
 * The cart carries the dispatch promise as well, because every place that prints a subtotal prints
 * the collection it is quoted against: the value below reads the countdown from
 * `<ShippingEtaProvider>`, which the root layout mounts outside this one.
 *
 * The provider contributes no markup of its own: it publishes the value and returns the tree it
 * was given, unchanged.
 */

/** Printed for the delivery estimate while the dispatch countdown has no reading yet. */
const NO_DISPATCH_ETA_LABEL = '—';

/** Wording for a cart failure the server did not describe in terms a buyer can act on. */
const CART_FAILURE_LABEL = 'The cart could not be updated. Try again in a moment.';

/**
 * Added to a failed addition the cart read back and found had put nothing in: the buyer is told
 * what went wrong and, on the strength of that read, that their cart is as it was.
 */
const CART_ADDITION_NOT_APPLIED_LABEL = 'No units were added.';

/**
 * Wording for a failed addition whose outcome the cart could not establish.
 *
 * Units are added to whatever a line already holds, so a request that was answered with a failure
 * may still have been carried out. Where the read that would have settled it did not answer either,
 * the buyer is pointed at their cart rather than told what it holds or invited to press again -
 * pressing again on top of an addition that did apply is what leaves a line of two.
 */
const CART_ADDITION_UNKNOWN_LABEL =
  'The cart could not confirm those units went in. Check your cart before adding them again.';

/**
 * How far along the cart is with the server.
 *
 * `'loading'` covers both the first read and a later refresh, `'saving'` a change being written,
 * and `'error'` a read or write that came back unhappy - which leaves the previously published
 * cart in place so the buyer keeps seeing what they had, except where the failure was read back
 * from the server, in which case what that read found is published and the wording stays with it.
 */
export type CartSyncStatus = 'loading' | 'idle' | 'saving' | 'error';

/**
 * What became of the units a failed addition asked for, as far as the cart could establish.
 *
 * `'not-applied'` is a read of the cart that found the units absent, so the cart is as it was and
 * asking again is safe. `'unknown'` is everything the cart could not settle - the read failed
 * itself, there was no cart published to compare against, or the cart moved by some other amount
 * because another tab was shopping too - and a buyer given that outcome is asked to look at their
 * cart rather than told what it holds.
 */
export type CartAdditionOutcome = 'not-applied' | 'unknown';

/**
 * The failure {@link CartContextValue.addLine} rejects with, once the cart has been read back.
 *
 * `message` is the same sentence the cart published on {@link CartContextValue.cartError}, so a
 * control that catches this may show it to a buyer as it stands, and `outcome` says how much the
 * cart established about the units - which is what decides whether a control may state that
 * nothing was added. `cause` carries the original failure for a caller that wants it.
 */
export class CartAdditionError extends Error {
  /** How much the cart established about the units; see {@link CartAdditionOutcome}. */
  readonly outcome: CartAdditionOutcome;

  constructor(message: string, options: { outcome: CartAdditionOutcome; cause: unknown }) {
    super(message, { cause: options.cause });
    this.name = 'CartAdditionError';
    this.outcome = options.outcome;
  }
}

/** The cart and its operations, as published on the context. */
export interface CartContextValue {
  /** The lines of the cart, in the order the server returned them. */
  readonly lines: readonly CartLine[];
  /** Number of lines, which is what the cart drawer lists. */
  readonly lineCount: number;
  /** Quantity summed across the lines, which is what the header badge counts. */
  readonly itemCount: number;
  /** The lines' totals summed, in cents. */
  readonly subtotalCents: number;
  /** Wording for {@link CartContextValue.subtotalCents}, for example `'$1,299.00'`. */
  readonly subtotalLabel: string;
  /** The transit estimate quoted with the totals, or `'—'` before the first countdown reading. */
  readonly estimatedDeliveryLabel: string;
  /** Milliseconds left until the next dispatch cut-off, or `null` before the first reading. */
  readonly dispatchCountdownMs: number | null;
  /** Where the cart stands with the server; see {@link CartSyncStatus}. */
  readonly syncStatus: CartSyncStatus;
  /** Wording for the last failure, or `null` when the cart is in step with the server. */
  readonly cartError: string | null;
  /**
   * Puts a quantity of one product into the cart, then publishes the cart the server answers.
   *
   * The units are added to whatever the line already holds, so a request that came back a failure
   * may still have been carried out - which is why a failed addition is not reported until the cart
   * has been read from the server again. That read decides the outcome: units that did go in are
   * published and the addition resolves as the success it turned out to be, and otherwise the
   * contents it found are published with wording on `cartError` and the promise rejects with a
   * {@link CartAdditionError} whose `outcome` says whether the units were found absent or whether
   * nothing could be established about them.
   */
  readonly addLine: (draft: CartItemDraft) => Promise<void>;
  /**
   * Sets one line's quantity on the server, then publishes the cart it answers. A quantity of zero
   * or less takes the line out of the cart, which is the write `removeLine` performs. The promise
   * rejects when the server refused the change, once the failure has been published on `cartError`.
   */
  readonly setLineQuantity: (lineId: string, quantity: number) => Promise<void>;
  /**
   * Takes one line out of the cart on the server, then publishes the cart it answers. A line this
   * cart no longer holds is a change the server refuses, so the promise rejects - once the failure
   * has been published on `cartError` - rather than reporting a removal that removed nothing.
   */
  readonly removeLine: (lineId: string) => Promise<void>;
  /**
   * Takes every line out of the cart on the server, then publishes the cart it answers, for a
   * buyer starting their order again. A cart that is already empty is emptied successfully; the
   * promise rejects when the server refused the change, once the failure has been published on
   * `cartError`.
   */
  readonly emptyCart: () => Promise<void>;
  /** Reads the cart from the server again, replacing what is published. */
  readonly refreshCart: () => Promise<void>;
}

export interface CartProviderProps {
  readonly children: ReactNode;
}

/** The whole number of units `quantity` asks for: a fraction rounds down, anything unusable 0. */
function requestedQuantity(quantity: number): number {
  return Number.isFinite(quantity) ? Math.max(0, Math.trunc(quantity)) : 0;
}

/**
 * How many units of `productId` the given lines hold, `0` for a product that is not among them.
 *
 * Summed rather than read from the first match: a cart holds one line per product today, and a
 * total is the answer whether that stays true or not. It is what tells a failed addition, compared
 * against the same figure taken before the request, whether the units went in.
 */
function unitsOfProductHeld(lines: readonly CartLine[], productId: string): number {
  return lines.reduce(
    (units, line) => (line.productId === productId ? units + line.quantity : units),
    0,
  );
}

/**
 * Wording for `cause` that a buyer may read as it stands.
 *
 * A failure the server described - a rejected quantity, a product that went out of stock while the
 * page was open - carries wording written for a customer, and that wording is published. Anything
 * else is reported generically, with the status where there is one, so neither an internal message
 * nor a stack reaches the page.
 */
function cartFailureText(cause: unknown): string {
  if (!(cause instanceof StorefrontApiError)) {
    return CART_FAILURE_LABEL;
  }

  switch (cause.code) {
    case 'NETWORK_FAILURE':
      return 'The cart could not be reached. Check your connection and try again.';
    case 'CART_CONFLICT':
      return 'This cart changed in another tab. Refresh it to see what it holds now.';
    case 'MALFORMED_RESPONSE':
      return 'Lumen Supply sent a cart this page could not read. Refresh it to try again.';
    case 'INTERNAL_ERROR':
      return `${CART_FAILURE_LABEL} (HTTP ${String(cause.status)})`;
    default:
      return cause.message;
  }
}

/**
 * The published cart, or `null` outside a `<CartProvider>` - which is the case
 * {@link useCartContext} turns into an error.
 *
 * The context object is exported because a surface that works with or without a cart reads it
 * directly with `useContext` instead of through the accessor.
 */
export const CartContext = createContext<CartContextValue | null>(null);

/**
 * Reads the cart.
 *
 * Throws when called outside `<CartProvider>`. An empty stand-in cart would let a page tell a
 * buyer their cart is empty when it was merely mounted in the wrong place, which is worse than a
 * loud failure the first time that happens.
 */
export function useCartContext(): CartContextValue {
  const cart = useContext(CartContext);

  if (cart === null) {
    throw new Error(
      'useCartContext must be called from a component inside <CartProvider>. ' +
        'The root layout mounts the provider around the whole application.',
    );
  }

  return cart;
}

/**
 * Mounts the cart for the application. The root layout wraps the site chrome in it once, inside
 * `<ShippingEtaProvider>`, so the cart totals quote the dispatch promise the header quotes.
 */
export function CartProvider({ children }: CartProviderProps): ReactElement {
  const [cart, setCart] = useState<CartView | null>(null);
  const [syncStatus, setSyncStatus] = useState<CartSyncStatus>('loading');
  const [cartError, setCartError] = useState<string | null>(null);

  // `null` when the layout mounted the cart outside the dispatch countdown: the totals then quote
  // no estimate, rather than taking the storefront down over a missing delivery line.
  const dispatchEta = useContext(DispatchEtaContext);

  function publishServerCart(next: CartView): void {
    setCart(next);
    setSyncStatus('idle');
    setCartError(null);
  }

  function reportCartFailure(cause: unknown): void {
    setSyncStatus('error');
    setCartError(cartFailureText(cause));
  }

  /**
   * Publishes `contents` while leaving the cart reporting `message` as its failure.
   *
   * For the one case that is both at once: a change the server refused, and a read of the cart
   * taken afterwards to find out what it actually holds. `publishServerCart` would clear the
   * failure the buyer still needs to see, so the contents are published and the wording kept.
   * `null` is a read that did not answer either, which leaves the previously published contents
   * on screen - the same thing every other failure here does.
   */
  function publishCartUnderFailure(contents: CartView | null, message: string): void {
    if (contents !== null) {
      setCart(contents);
    }

    setSyncStatus('error');
    setCartError(message);
  }

  /**
   * Publishes `cause` as the cart's failure and then hands it back to the caller that asked for the
   * change.
   *
   * A refused change is reported in both directions on purpose. The cart publishes it, so every
   * surface reading `cartError` shows wording a buyer can act on; and the promise the caller is
   * holding rejects, so the control that asked - a quantity stepper, a remove button - learns that
   * the line in front of it was not changed and can say so where the buyer is looking instead of
   * confirming a change the server refused.
   *
   * `addLine` does not go through here, because a refused addition is not the same statement as a
   * refused change: its units are added to whatever the line already held, so the request may have
   * been carried out before it failed. It takes `settleAdditionFailure` instead, which reads the
   * cart back first and publishes and rejects with what that read established.
   */
  function raiseCartFailure(cause: unknown): never {
    reportCartFailure(cause);

    throw cause;
  }

  /**
   * Works out what became of a failed addition and reports it, having established it first.
   *
   * The cart is read from the server and the units it now holds of `draft.productId` compared with
   * `unitsBefore`, the figure taken when the press was made. Units that went in despite the failure
   * make this a success: the contents that carry them are published and nothing is said about a
   * failure the buyer has no reason to hear about. A cart found holding what it held is a refusal,
   * reported as one. Anything else - the read failing, no cart to compare against, or a difference
   * that is neither, which another tab shopping at the same time would produce - is an outcome
   * nobody established, and is reported as exactly that rather than guessed at.
   *
   * @param cause The failure the addition came back with.
   * @param draft The addition that was asked for.
   * @param unitsBefore Units of the product the published cart held when the press was made, or
   *   `null` when no cart had been published yet and there is therefore nothing to compare against.
   * @throws CartAdditionError when the units were found absent, or their fate could not be
   *   established, once the cart has published the same wording on `cartError`.
   */
  async function settleAdditionFailure(
    cause: unknown,
    draft: CartItemDraft,
    unitsBefore: number | null,
  ): Promise<void> {
    let reconciled: CartView | null;

    try {
      reconciled = await loadCartContents();
    } catch {
      // The read is how the outcome would have been established, so its own failure is not a
      // second thing to tell the buyer about: it is what makes the outcome unknown below.
      reconciled = null;
    }

    if (reconciled !== null && unitsBefore !== null) {
      const wanted = requestedQuantity(draft.quantity);
      const delta = unitsOfProductHeld(reconciled.lines, draft.productId) - unitsBefore;

      if (wanted > 0 && delta === wanted) {
        publishServerCart(reconciled);

        return;
      }

      if (delta === 0) {
        const message = `${cartFailureText(cause)} ${CART_ADDITION_NOT_APPLIED_LABEL}`;

        publishCartUnderFailure(reconciled, message);

        throw new CartAdditionError(message, { outcome: 'not-applied', cause });
      }
    }

    publishCartUnderFailure(reconciled, CART_ADDITION_UNKNOWN_LABEL);

    throw new CartAdditionError(CART_ADDITION_UNKNOWN_LABEL, { outcome: 'unknown', cause });
  }

  // The cart lives on the server, so the browser reads it once, when the application starts. There
  // is no polling and no reading of it on a schedule: every operation below writes through to the
  // server and publishes the cart it answered with, which is the cart checkout will price the order
  // from, and the only other read is the one a failed addition takes to find out what it did.
  //
  // The read belongs to this mount, so it is carried out under a signal this effect owns. A cart
  // that unmounts while its first read is in flight aborts it rather than holding a connection open
  // for an answer nobody is left to show - and the abort is the provider letting go, so neither the
  // answer nor the rejection it produces is published.
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const stored = await loadCartContents({ signal: controller.signal });

        if (!controller.signal.aborted) {
          publishServerCart(stored);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          reportCartFailure(cause);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  async function addLine(draft: CartItemDraft): Promise<void> {
    // The units this cart holds of the product as the press is made, which is the figure a failed
    // addition is settled against. `null` while no cart has been published: there is no baseline
    // then, and an outcome measured against a figure that was never read would be invented.
    const unitsBefore = cart === null ? null : unitsOfProductHeld(cart.lines, draft.productId);

    setSyncStatus('saving');
    setCartError(null);

    try {
      const saved = await addCartItem(draft);

      publishServerCart(saved);
    } catch (cause) {
      await settleAdditionFailure(cause, draft, unitsBefore);
    }
  }

  async function refreshCart(): Promise<void> {
    setSyncStatus('loading');
    setCartError(null);

    try {
      const stored = await loadCartContents();

      publishServerCart(stored);
    } catch (cause) {
      reportCartFailure(cause);
    }
  }

  async function setLineQuantity(lineId: string, quantity: number): Promise<void> {
    const wanted = requestedQuantity(quantity);

    setSyncStatus('saving');
    setCartError(null);

    try {
      // Asking for none of a product is the same as taking its line out of the cart, and the
      // endpoint's set operation holds a line at one unit or more, so a normalised 0 is a removal.
      const saved =
        wanted === 0
          ? await removeCartItem(lineId)
          : await setCartItemQuantity({ lineId, quantity: wanted });

      publishServerCart(saved);
    } catch (cause) {
      raiseCartFailure(cause);
    }
  }

  async function removeLine(lineId: string): Promise<void> {
    setSyncStatus('saving');
    setCartError(null);

    try {
      const saved = await removeCartItem(lineId);

      publishServerCart(saved);
    } catch (cause) {
      raiseCartFailure(cause);
    }
  }

  async function emptyCart(): Promise<void> {
    setSyncStatus('saving');
    setCartError(null);

    try {
      const saved = await clearCartContents();

      publishServerCart(saved);
    } catch (cause) {
      raiseCartFailure(cause);
    }
  }

  const lines = cart?.lines ?? [];
  const subtotalCents = lines.reduce((total, line) => total + line.lineTotalCents, 0);

  const value: CartContextValue = {
    lines,
    lineCount: lines.length,
    itemCount: lines.reduce((total, line) => total + line.quantity, 0),
    subtotalCents,
    subtotalLabel: formatPriceLabel(subtotalCents),
    estimatedDeliveryLabel: dispatchEta?.etaLabel ?? NO_DISPATCH_ETA_LABEL,
    dispatchCountdownMs: dispatchEta?.msUntilCutoff ?? null,
    syncStatus,
    cartError,
    addLine,
    setLineQuantity,
    removeLine,
    emptyCart,
    refreshCart,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
